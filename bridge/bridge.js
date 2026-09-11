#!/usr/bin/env node
/**
 * Dot Dash push bridge.
 *
 *     device -> mosquitto -> THIS -> FCM -> APNs -> parent's phone
 *
 * Why it exists: iOS suspends the parent app in the background, taking its MQTT
 * connection with it, so the app cannot know anything happened while the phone
 * is in a pocket. This process stays subscribed around the clock and forwards
 * the three events a parent can actually act on.
 *
 * It cannot be a Cloud Function -- those are request-scoped and cannot hold a
 * persistent MQTT subscription -- so it runs on the droplet beside mosquitto.
 *
 * Layered, so each stage is provable before the next is wired:
 *
 *     stage A  subscribe, parse, de-duplicate, log        (no credentials)
 *     stage B  + resolve child -> parent -> device tokens (service account)
 *     stage C  + actually send                            (APNs key)
 *
 * A missing credential downgrades the stage; it never crashes the process. A
 * bridge that dies quietly is worse than no bridge, because the alerts still
 * look like they work.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import mqtt from 'mqtt';

// ------------------------------------------------------------------ config --
const env = process.env;

// Connect by HOSTNAME, not localhost: the listener presents a Let's Encrypt
// cert for app./mqtt.dotdashdevice.com, so "localhost" fails TLS hostname
// verification even from the box itself.
const MQTT_HOST = env.MQTT_HOST || 'mqtt.dotdashdevice.com';
const MQTT_PORT = parseInt(env.MQTT_PORT || '8883', 10);
const MQTT_USER = env.MQTT_USER || 'dotdash-bridge';
const MQTT_PASS = env.MQTT_PASS || '';
// Unset means the system CA store, which is right for a publicly trusted cert.
// Pointing at the deploy's chain.pem does NOT work -- that is the intermediate
// alone, with no root to anchor it.
const MQTT_CA = env.MQTT_CA || '';

const SERVICE_ACCOUNT = env.SERVICE_ACCOUNT || '';   // stage B
// Matches the app: `typeof __app_id !== 'undefined' ? __app_id : 'dotdash'`.
const APP_ID = env.APP_ID || 'dotdash';
const DRY_RUN = env.DRY_RUN === '1';
// Where a tapped notification should land. Staging for now; becomes "/" when
// the build is promoted to the production index.html.
const LINK_PATH = env.LINK_PATH || '/test.html';
const STATE_PATH = env.STATE_PATH || '/root/dotdash_bridge/state.json';

const TOPICS = [
  'doorbell/monitor/+/#',   // friendreq / timerreq / battery alerts
  'doorbell/msg/+/#',       // messages -- notified only when addressed to a PARENT
];

// One-time priming marker. See primeWindow below.
const PRIME_KEY = '__primed:msg';
const PRIME_MS = 20000;

const log = (level, msg, ...rest) =>
  console.log(`${new Date().toISOString()} ${level.padEnd(7)} ${msg}`, ...rest);
const info = (m, ...r) => log('INFO', m, ...r);
const warn = (m, ...r) => log('WARN', m, ...r);
const error = (m, ...r) => log('ERROR', m, ...r);

// ------------------------------------------------------------ replay guard --
// Every topic this bridge listens to is RETAINED, so the broker redelivers each
// outstanding one on every reconnect. Without this, a restart would re-notify
// every parent about events they dismissed days ago -- and restarts are exactly
// what you do while developing.
//
// Keyed topic -> digest of payload, persisted. A redelivery of something already
// sent matches and is skipped; a value that CHANGED while the bridge was down
// does not match, and is delivered. Both are what you want.
class SeenStore {
  constructor(file) {
    this.file = file;
    this.data = {};
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
      info(`replay guard: loaded ${Object.keys(this.data).length} entries from ${file}`);
    } catch (e) {
      if (e.code === 'ENOENT') info(`replay guard: no state yet at ${file}, starting empty`);
      else warn(`replay guard: could not read ${file} (${e.message}), starting empty`);
    }
  }

  isNew(topic, payload) {
    const digest = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
    if (this.data[topic] === digest) return false;
    this.data[topic] = digest;
    this.save();
    return true;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);   // atomic, so a crash cannot truncate it
    } catch (e) {
      error(`replay guard: could not persist state (${e.message})`);
    }
  }
}

// ------------------------------------------------------------------ events --
/**
 * Return {kind, title, body, level} for a topic worth notifying about, else null.
 *
 * Topic shape: doorbell/monitor/<childHash>/<kind>[/<id>]
 *
 * Only the three NAMED kinds are alerts. The same prefix also carries a copy of
 * every outgoing message on doorbell/monitor/<hash>/<timestamp> for the Monitor
 * feed -- pushing those would notify a parent about each message their child
 * sends, which is surveillance, not an alert.
 *
 * `level` is the APNs interruption-level, and encodes urgency rather than
 * importance. A friend request and a finished timer both have a child waiting
 * on a parent to tap something, so they arrive normally. A flat battery is true
 * for hours and needs no decision -- it goes out passive: no sound, no
 * vibration, no lit screen, just waiting in Notification Center.
 */
export function parseEvent(topic, payload) {
  const parts = topic.split('/');
  if (parts[1] === 'msg') return parseMessage(parts, payload);
  if (parts[1] !== 'monitor') return null;
  if (parts.length < 4) return null;
  const kind = parts[3];

  const fields = payload.split(',');
  const tag = fields[0] || '';

  if (kind === 'friendreq' && tag === 'FRIENDREQ' && fields.length >= 2) {
    return {
      kind: 'friendreq',
      title: 'New friend request',
      body: `${fields[1]} sent your child a message. Add them as a friend?`,
      level: 'active',
      route: 'child',
    };
  }

  if (kind === 'timerreq' && tag === 'TIMERREQ' && fields.length >= 3) {
    return {
      kind: 'timerreq',
      title: 'Timer completed',
      body: `Your child finished a ${fields[1]}-minute timer. Approve ${fields[2]} points?`,
      level: 'active',
      route: 'child',
    };
  }

  if (kind === 'battery') {
    if (tag === 'LOWBATT') {
      return {
        kind: 'battery',
        title: 'Low battery',
        body: "Your child's Dot Dash needs charging.",
        level: 'passive',
        route: 'child',
      };
    }
    // An empty payload is the device withdrawing the alert because it is on
    // charge again. Nothing to push -- but it still passes through the replay
    // guard, so the NEXT genuine low reading counts as new.
    return null;
  }

  return null;
}

/**
 * A message addressed to someone. Payload is "TYPE,TEXT,SENDER".
 *
 * The same wildcard also carries messages to CHILDREN's devices -- the hash in
 * the topic says who it is for. This returns an event either way; deliver()
 * only notifies when that hash belongs to a parent, so a message between two
 * children reaches nobody's phone.
 */
function parseMessage(parts, payload) {
  if (parts.length < 3) return null;
  // An empty payload is the parent app clearing the retained copy after reading
  // it. Nothing to announce, but it still passes through the replay guard.
  if (!payload) return null;

  const f = payload.split(',');
  if (f.length < 3) return null;
  const [type, text, sender] = [f[0], f[1], f[2]];
  if (!['TEXT', 'MORSE', 'PULSE'].includes(type)) return null;

  let body;
  if (type === 'TEXT') body = text;
  else if (type === 'MORSE') body = 'Sent you a message in morse.';
  else body = 'Buzzed you.';

  return {
    kind: 'message',
    title: sender || 'New message',
    body,
    level: 'active',
    route: 'parent',
  };
}

// ------------------------------------------------------------- stage B ----
// Routing: which parent owns the device this event came from, and what devices
// should be notified.
//
//   doorbell/monitor/<childHash>/...
//     -> artifacts/<appId>/users/<uid>/devices/*  where hashedId == childHash
//     -> artifacts/<appId>/users/<uid>/pushTokens/*
//
// The device lookup needs no schema change: the app already stores hashedId on
// every device doc, and a collection-group query finds it without an index.
//
// Both lookups are cached, because a chatty device would otherwise mean a
// Firestore round trip per MQTT message. Failures are cached too, briefly: an
// unpaired or unlinked device stays in the Monitor stream, and without negative
// caching it would be re-queried forever.
let db = null;
let messaging = null;

async function initFirestore() {
  if (!SERVICE_ACCOUNT) return null;
  try {
    const [{ initializeApp, cert }, { getFirestore }, { getMessaging }] = await Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/firestore'),
      import('firebase-admin/messaging'),
    ]);
    const sa = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT, 'utf8'));
    initializeApp({ credential: cert(sa) });
    messaging = getMessaging();
    info(`firestore ready (project ${sa.project_id})`);
    return getFirestore();
  } catch (e) {
    // Deliberately non-fatal: drop back to stage A rather than exit. A bridge
    // that dies on a bad credential looks identical to one that is working.
    error(`firestore init failed (${e.message}) -- staying at stage A`);
    return null;
  }
}

const CACHE_OK_MS = 60 * 60 * 1000;   // device -> parent almost never changes
const CACHE_MISS_MS = 5 * 60 * 1000;  // but re-check unknowns occasionally
const CACHE_TOKENS_MS = 5 * 60 * 1000;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) { cache.delete(key); return undefined; }
  return hit.value;
}
function cacheSet(key, value, ttl) {
  cache.set(key, { value, expires: Date.now() + ttl });
}

async function resolveParent(childHash) {
  const key = `uid:${childHash}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;

  let uid = null;
  try {
    const snap = await db.collectionGroup('devices')
      .where('hashedId', '==', childHash).limit(1).get();
    if (!snap.empty) {
      // artifacts/<appId>/users/<uid>/devices/<deviceId>
      const segs = snap.docs[0].ref.path.split('/');
      uid = segs[3] || null;
    }
  } catch (e) {
    error(`resolveParent(${childHash.slice(0, 12)}) failed: ${e.message}`);
    return null;   // not cached: a transient Firestore error should be retried
  }
  cacheSet(key, uid, uid ? CACHE_OK_MS : CACHE_MISS_MS);
  return uid;
}

// A parent's topic is sha256(virtualId.toLowerCase().trim()) -- the same
// hashId() the app uses. Firestore stores the virtualId but not its hash, so
// the reverse map is built by hashing every parent profile. There are a handful
// of families, so enumerating is cheaper and simpler than adding a field to
// every profile and backfilling it.
let parentHashes = new Map();
let parentHashesAt = 0;
const PARENT_MAP_TTL = 10 * 60 * 1000;

async function refreshParentHashes() {
  try {
    const snap = await db.collectionGroup('profile').get();
    const next = new Map();
    for (const d of snap.docs) {
      const vid = d.data().virtualId;
      if (!vid) continue;
      const uid = d.ref.path.split('/')[3];
      const h = crypto.createHash('sha256')
        .update(String(vid).toLowerCase().trim()).digest('hex');
      next.set(h, uid);
    }
    parentHashes = next;
    parentHashesAt = Date.now();
    info(`parent map refreshed: ${next.size} parents`);
  } catch (e) {
    error(`refreshParentHashes failed: ${e.message}`);
  }
}

async function resolveParentByHash(hash) {
  if (Date.now() - parentHashesAt > PARENT_MAP_TTL) await refreshParentHashes();
  let uid = parentHashes.get(hash);
  if (uid) return uid;
  // A miss is usually a CHILD's inbox, which is the common case and must stay
  // cheap. Only re-read if the map is stale enough that a newly registered
  // parent could plausibly be missing from it.
  if (Date.now() - parentHashesAt > 60 * 1000) {
    await refreshParentHashes();
    uid = parentHashes.get(hash);
  }
  return uid || null;
}

async function getTokens(uid) {
  const key = `tok:${uid}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;

  let tokens = [];
  try {
    const snap = await db.collection(`artifacts/${APP_ID}/users/${uid}/pushTokens`).get();
    tokens = snap.docs.map((d) => d.data().token).filter(Boolean);
  } catch (e) {
    error(`getTokens(${uid.slice(0, 8)}) failed: ${e.message}`);
    return [];
  }
  cacheSet(key, tokens, CACHE_TOKENS_MS);
  return tokens;
}

// ---------------------------------------------------------------- delivery --
/**
 * Stage B/C. Until a service account is installed this only reports.
 *
 * When stage C lands, `level` goes into the APNs payload as
 * aps.interruption-level. It has no Web Push equivalent: a browser or installed
 * PWA has no notion of a passive notification, so the battery alert will be as
 * loud as the others there until the platform offers a way to say otherwise.
 */
async function deliver(hash, ev) {
  const short = hash.slice(0, 12);
  if (!db) {
    info(`  [stage A] no firestore -- would notify hash=${short} ` +
         `kind=${ev.kind} level=${ev.level} title=${JSON.stringify(ev.title)}`);
    return;
  }

  // Two different questions, depending on what the topic is.
  //   child  -- "who owns this device?"        (monitor alerts)
  //   parent -- "is this hash a parent's id?"  (messages)
  const uid = ev.route === 'parent'
    ? await resolveParentByHash(hash)
    : await resolveParent(hash);

  if (!uid) {
    // Not an error, and usually not even interesting: for messages this is the
    // common case, because the same wildcard carries every child's inbox.
    if (ev.route !== 'parent') info(`  no parent owns child=${short} -- nothing to notify`);
    return;
  }

  const tokens = await getTokens(uid);
  if (tokens.length === 0) {
    info(`  routed ${ev.route}=${short} -> parent=${uid.slice(0, 8)}.. but no push ` +
         `tokens registered yet (the app registers these at stage C)`);
    return;
  }

  if (DRY_RUN) {
    info(`  [dry run] child=${short} -> parent=${uid.slice(0, 8)}.. ` +
         `tokens=${tokens.length} kind=${ev.kind} level=${ev.level} ` +
         `title=${JSON.stringify(ev.title)}`);
    return;
  }

  await send(uid, tokens, hash, ev);
}

// ----------------------------------------------------------------- stage C --
// One message shape covers both targets. `apns.interruption-level` is what
// makes the battery alert passive on an iPhone app; Web Push has no equivalent,
// so on an installed PWA the battery alert is as loud as the others.
//
// Every data value must be a string -- FCM rejects the message otherwise, and
// the error does not say which field.
async function send(uid, tokens, childHash, ev) {
  const link = LINK_PATH;
  const messages = tokens.map((token) => ({
    token,
    notification: { title: ev.title, body: ev.body },
    apns: { payload: { aps: { 'interruption-level': ev.level } } },
    webpush: {
      notification: { title: ev.title, body: ev.body, icon: '/icon.jpg' },
      fcmOptions: { link },
    },
    data: { kind: ev.kind, child: childHash.slice(0, 16), link },
  }));

  let res;
  try {
    res = await messaging.sendEach(messages);
  } catch (e) {
    error(`  send failed outright for parent=${uid.slice(0, 8)}..: ${e.message}`);
    return;
  }

  info(`  sent kind=${ev.kind} parent=${uid.slice(0, 8)}.. ` +
       `ok=${res.successCount} failed=${res.failureCount}`);

  // Prune tokens the far end has thrown away. Without this a parent who
  // reinstalls leaves a dead token behind forever, and every future alert
  // reports a failure that means nothing.
  for (let i = 0; i < res.responses.length; i++) {
    const r = res.responses[i];
    if (r.success) continue;
    const code = r.error?.errorInfo?.code || r.error?.code || 'unknown';
    if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
      const id = crypto.createHash('sha256').update(tokens[i]).digest('hex').slice(0, 32);
      try {
        await db.doc(`artifacts/${APP_ID}/users/${uid}/pushTokens/${id}`).delete();
        info(`  pruned dead token for parent=${uid.slice(0, 8)}.. (${code})`);
        cache.delete(`tok:${uid}`);
      } catch (e) {
        warn(`  could not prune dead token: ${e.message}`);
      }
    } else {
      warn(`  token ${i} failed: ${code}`);
    }
  }
}

// -------------------------------------------------------------------- mqtt --
async function main() {
  if (!MQTT_PASS) {
    error('MQTT_PASS is empty -- refusing to start. Set it in the systemd EnvironmentFile.');
    process.exit(2);
  }

  const seen = new SeenStore(STATE_PATH);
  db = await initFirestore();
  const stage = !db ? 'A (log only)' : (DRY_RUN ? 'B (routing, dry run)' : 'C (sending)');
  info(`dot dash push bridge starting -- stage ${stage}`);

  const client = mqtt.connect({
    protocol: 'mqtts',
    host: MQTT_HOST,
    port: MQTT_PORT,
    username: MQTT_USER,
    password: MQTT_PASS,
    clientId: `dotdash-bridge-${Date.now()}`,
    reconnectPeriod: 5000,
    ...(MQTT_CA ? { ca: fs.readFileSync(MQTT_CA) } : {}),
  });

  client.on('connect', () => {
    info(`connected to ${MQTT_HOST}:${MQTT_PORT} as ${MQTT_USER}`);
    client.subscribe(TOPICS, { qos: 1 }, (err) => {
      if (err) error(`subscribe failed: ${err.message}`);
      else info(`subscribed to ${TOPICS.join('  ')}`);
    });
  });

  client.on('reconnect', () => warn('reconnecting...'));
  client.on('error', (err) => error(`mqtt error: ${err.message}`));
  client.on('close', () => warn('connection closed -- mqtt.js will retry'));

  // PRIMING. The message topics are retained and go back months, so the very
  // first subscribe would hand us every message ever sent and notify for each
  // one. That happens exactly once -- afterwards the digest guard recognises
  // them -- so the first run records the backlog silently and then marks itself
  // primed. The window is time-based because MQTT gives no "backlog finished"
  // signal; 20s is far longer than a retained burst takes.
  let priming = !seen.data[PRIME_KEY];
  if (priming) {
    warn(`first run with message topics -- priming the replay guard for ${PRIME_MS / 1000}s ` +
         `(existing messages will NOT be notified)`);
    setTimeout(() => {
      priming = false;
      seen.data[PRIME_KEY] = new Date().toISOString();
      seen.save();
      info('priming complete -- new messages will notify from here');
    }, PRIME_MS);
  }

  client.on('message', (topic, buf, packet) => {
    const payload = buf.toString('utf8');
    const ev = parseEvent(topic, payload);

    // Record EVERY topic, alert or not, so a cleared battery flag updates the
    // guard and the next genuine low reading counts as new.
    const isNew = seen.isNew(topic, payload);

    if (!ev || !isNew) return;

    if (priming && packet?.retain) return;   // backlog, not news

    const hash = topic.split('/')[2];
    info(`EVENT ${ev.kind.padEnd(10)} ${ev.route}=${hash.slice(0, 12)} ` +
         `level=${ev.level.padEnd(7)} payload=${JSON.stringify(payload.slice(0, 60))}`);
    deliver(hash, ev).catch((e) => error(`deliver failed: ${e.message}`));
  });

  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      info(`${sig} -- shutting down`);
      client.end(false, () => process.exit(0));
    });
  }
}

// Only run when executed directly, so the parser can be imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) main();
