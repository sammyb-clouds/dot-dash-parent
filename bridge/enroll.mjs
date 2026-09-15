/**
 * Dot Dash key enrollment.
 *
 * Gives a paired device its OWN broker login, so it can stop using the shared
 * password baked into every firmware image. Runs on the droplet behind nginx:
 *
 *   POST https://app.dotdashdevice.com/enroll
 *   hash=<device hash>&mac=<12 hex>&secret=<password the device generated>
 *
 * The device invents its own password and sends it exactly once, over HTTPS.
 * The broker stores only a salted hash of it.
 *
 * WHO IS ALLOWED. Enrollment is automatic, but only for a device a parent has
 * already paired: some account must hold a device record whose id is this MAC
 * and whose hashedId is this hash. Pairing is what writes that record, so an
 * unpaired device -- or someone who knows a hash but not the MAC it was paired
 * from -- is refused.
 *
 * FIRST ENROLLMENT LOCKS. Once a device has a key, a request with a different
 * secret is refused (409) and recorded on the device record as a conflict: the
 * real device being turned away is the signal that someone got there first.
 * A request repeating the SAME secret succeeds, so a device that enrolled but
 * lost the reply (it rebooted, the connection dropped) is not locked out of its
 * own key. That check is a real login attempt with the offered secret, so this
 * service never needs to store or compare passwords itself.
 *
 * Responses (JSON):
 *   201 enrolled          200 already-enrolled     -- both carry { port }
 *   400 bad-request       403 not-paired / disabled  409 locked
 *   405 method            429 slow-down            503 unavailable (try later)
 *
 * DISABLED. `mqttKey.disabled: true` on a device record refuses enrollment
 * (403 disabled). With its key also removed, that is the per-device revert: the
 * device falls back to the shared login and stays there. bridge/tools/devicekey.mjs
 * does both.
 *
 * RESET. A parent resets a device's key from the app by writing
 * users/<uid>/keyResets/<deviceId> -- under their own account, so the database
 * rules already prove it is the device's owner. This service deletes the key,
 * clears the device record's conflicts, and deletes the request; the app sees the
 * request disappear and tells the device to enroll again. That is the way out of
 * a lock (409) for a device whose storage was wiped, or a child re-paired onto
 * new hardware.
 *
 * SWEEP. Every few hours, keys whose device record no longer exists -- or no
 * longer carries that hash -- are deleted, after being missing on two sweeps in
 * a row. A key's `textname` holds its device record's path. Clients whose
 * textname starts "keep:" (the hand-made test key) are never swept.
 *
 * ONE WRITE PER CHANGE. Every dynamic-security command makes mosquitto rewrite
 * the whole key store; one control message with several commands rewrites it
 * once. Measured on the live broker 2026-09-15: 9 separate messages = 9 saves,
 * 1 batched message = 1. So every change here is a single batched message.
 *
 * On anything but 200/201 the device keeps using the shared login and tries
 * again later. Nothing here can take a device offline.
 *
 * OWNERSHIP. A device record is written by the app under the parent's own
 * account, so on its own it proves nothing: anyone signed in can write a record
 * naming any hash. The hash's identity record (public/data/identities/<hash>)
 * is what the database rules protect -- only one account can hold it -- so
 * enrollment also requires that record to name the account holding the device.
 *
 * ---------------------------------------------------------------------------
 * APP LOGINS
 *
 *   POST https://app.dotdashdevice.com/app-login
 *   Authorization: Bearer <Firebase ID token>
 *
 * Gives a signed-in parent a broker login of their own, replacing the shared
 * `dotdash-app` password that ships inside every copy of the app. The token is
 * verified here against Google's signing keys; the login it buys reaches only
 * that parent's topics:
 *
 *   their parent inbox       doorbell/msg/<parent hash>[/#]
 *   each device they own     presence, msg/#, monitor/# (read and clear), cmd (write)
 *   pairing, for everyone    doorbell/pairing/+ (write), doorbell/pairing/reply/+ (read)
 *
 * "Own" means the identity record for that hash names this account -- never
 * just a device record, which the parent writes themselves.
 *
 * Username `app-<uid>`, role `app-<uid>` (topics naming each hash literally,
 * since the plugin does not substitute %u), group `apps` for pairing. The
 * password is an HMAC of the uid under APP_LOGIN_SECRET: the same every time,
 * so a phone's automatic reconnects keep working, and nothing needs storing.
 * Rotating the secret and deleting the app-* clients revokes them all.
 *
 * Every call recomputes the role and applies only the difference. When it
 * changes, that parent's sessions are disconnected (the login is disabled and
 * re-enabled in the same message -- a rule change alone disconnects nobody) and
 * reconnect under the new rules, which is how a removed device stops reaching a
 * phone that is already subscribed. A hash granted here is also taken away from any
 * other parent's role still holding it (a child re-paired to a new family).
 *
 *   200 { username, password, url, granted: [hashes] }
 *   401 unauthenticated    429 slow-down    503 unavailable
 *
 * These logins live in the same key store as device keys, on listener 8886
 * (websockets). Both listeners load the plugin with the same file; in 2.0.18
 * that is one shared store (tested 2026-09-15: a login made through either
 * listener works on both, and deletes and password changes apply to both).
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import mqtt from 'mqtt';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const env = process.env;
const LISTEN_PORT = parseInt(env.ENROLL_PORT || '8790', 10);
const BROKER_HOST = env.BROKER_HOST || 'mqtt.dotdashdevice.com';
const KEY_PORT = parseInt(env.KEY_PORT || '8885', 10);
const ADMIN_USER = env.DYNSEC_ADMIN_USER;
const ADMIN_PASS = env.DYNSEC_ADMIN_PASS;
const SERVICE_ACCOUNT = env.SERVICE_ACCOUNT || '/root/dotdash_bridge/service-account.json';
const APP_ID = env.APP_ID || 'dotdash';
const APP_PORT = parseInt(env.APP_PORT || '8886', 10);
const APP_URL = env.APP_URL || `wss://${BROKER_HOST}:${APP_PORT}/mqtt`;
const APP_LOGIN_SECRET = env.APP_LOGIN_SECRET;
// Pages allowed to call /app-login from a browser: the web app, the iOS app's
// web view, and a local dev server.
const APP_ORIGINS = new Set((env.APP_ORIGINS || 'https://app.dotdashdevice.com,capacitor://localhost,http://localhost:5173').split(','));

const log = (level, ...a) => console.log(new Date().toISOString(), level.padEnd(5), ...a);
const short = (h) => String(h).slice(0, 12);

if (!ADMIN_USER || !ADMIN_PASS) {
  log('ERROR', 'DYNSEC_ADMIN_USER / DYNSEC_ADMIN_PASS missing -- refusing to start');
  process.exit(1);
}

if (!APP_LOGIN_SECRET || APP_LOGIN_SECRET.length < 32) {
  log('ERROR', 'APP_LOGIN_SECRET missing or short -- refusing to start');
  process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT, 'utf8'));
const PROJECT_ID = serviceAccount.project_id;
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const HASH_RE = /^[0-9a-f]{64}$/;
// Same as the app and firmware: sha256 of the trimmed, lowercased id.
const hashId = (id) => crypto.createHash('sha256').update(String(id).trim().toLowerCase()).digest('hex');
const identityRef = (appId, hash) => db.doc(`artifacts/${appId}/public/data/identities/${hash}`);

// ------------------------------------------------------------ dynsec admin --
// Key management goes through the plugin's control topic on the key listener.
// One long-lived admin connection; each command waits for its own response.

const CONTROL = '$CONTROL/dynamic-security/v1';
const pending = new Map();

const admin = mqtt.connect(`mqtts://${BROKER_HOST}:${KEY_PORT}`, {
  username: ADMIN_USER, password: ADMIN_PASS,
  clientId: `dotdash-enroll-${crypto.randomBytes(3).toString('hex')}`,
  reconnectPeriod: 5000,
});
admin.on('connect', () => { log('INFO', `admin connected to ${BROKER_HOST}:${KEY_PORT}`); admin.subscribe(`${CONTROL}/response`); });
admin.on('error', (e) => log('WARN', 'admin connection:', e.message));
admin.on('message', (topic, payload) => {
  let body; try { body = JSON.parse(payload.toString()); } catch { return; }
  for (const r of body.responses || []) {
    const waiter = pending.get(r.correlationData);
    if (waiter) { pending.delete(r.correlationData); waiter(r); }
  }
});

function dynsec(command) {
  return new Promise((resolve, reject) => {
    if (!admin.connected) return reject(new Error('broker admin connection is down'));
    const correlationData = crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => { pending.delete(correlationData); reject(new Error(`${command.command} timed out`)); }, 8000);
    pending.set(correlationData, (r) => { clearTimeout(timer); resolve(r); });
    admin.publish(CONTROL, JSON.stringify({ commands: [{ ...command, correlationData }] }));
  });
}

// Several commands in ONE control message -- one rewrite of the key store.
// Resolves with the responses in command order.
function dynsecBatch(commands) {
  return new Promise((resolve, reject) => {
    if (!admin.connected) return reject(new Error('broker admin connection is down'));
    const ids = commands.map(() => crypto.randomBytes(8).toString('hex'));
    const got = new Map();
    const timer = setTimeout(() => { ids.forEach((id) => pending.delete(id)); reject(new Error('batch timed out')); }, 8000);
    ids.forEach((id) => pending.set(id, (r) => {
      got.set(id, r);
      if (got.size === ids.length) { clearTimeout(timer); resolve(ids.map((i) => got.get(i))); }
    }));
    admin.publish(CONTROL, JSON.stringify({ commands: commands.map((c, i) => ({ ...c, correlationData: ids[i] })) }));
  });
}

async function mustSucceed(command) {
  const r = await dynsec(command);
  if (r.error) throw new Error(`${command.command}: ${r.error}`);
  return r;
}

async function clientExists(username) {
  const r = await dynsec({ command: 'getClient', username });
  if (!r.error) return true;
  if (/not found/i.test(r.error)) return false;
  throw new Error(`getClient: ${r.error}`);
}

// A device's own rules name its hash literally: mosquitto 2.0.18's plugin does
// not substitute %u, so a shared rule cannot express "its own mailboxes". The
// shared part lives in the `devices` group (bridge/ops/dynsec-device-role.sh).
// Mirrors bridge/ops/dynsec-add-device.sh -- change both together.
const ownAcls = (h) => [
  ['publishClientSend', `doorbell/presence/${h}`],
  ['publishClientSend', `doorbell/score/+/${h}`],
  ['publishClientSend', `doorbell/monitor/${h}/#`],
  ['publishClientSend', `doorbell/cmd/${h}`],
  ['subscribePattern', `doorbell/msg/${h}`],
  ['subscribePattern', `doorbell/msg/${h}/#`],
  ['subscribePattern', `doorbell/cmd/${h}`],
];

async function createKey(hash, secret, devicePath) {
  const rolename = `device-${hash}`;
  // One message, one rewrite. Commands run in order, so the role (with its rules
  // inline) exists before the client -- whose existence is the lock -- appears.
  // The leading deleteRole clears a leftover from a half-finished attempt; it
  // failing because there is nothing to delete is expected.
  const [, role, client] = await dynsecBatch([
    { command: 'deleteRole', rolename },
    { command: 'createRole', rolename,
      acls: ownAcls(hash).map(([acltype, topic]) => ({ acltype, topic, allow: true, priority: 0 })) },
    { command: 'createClient', username: hash, password: secret, textname: devicePath,
      roles: [{ rolename }], groups: [{ groupname: 'devices' }] },
  ]);
  if (role.error || client.error) {
    await dynsecBatch([{ command: 'deleteClient', username: hash }, { command: 'deleteRole', rolename }]).catch(() => {});
    throw new Error(`createKey: ${role.error || client.error}`);
  }
}

// Delete a key and its role: one message, one rewrite. Deleting a client also
// disconnects any session using it.
async function removeKey(hash) {
  await dynsecBatch([
    { command: 'deleteClient', username: hash },
    { command: 'deleteRole', rolename: `device-${hash}` },
  ]);
}

// Does this secret actually log in as this device? A real login, so passwords
// are only ever checked by the broker.
function secretWorks(hash, secret) {
  return new Promise((resolve) => {
    const c = mqtt.connect(`mqtts://${BROKER_HOST}:${KEY_PORT}`, {
      username: hash, password: secret, reconnectPeriod: 0, connectTimeout: 6000,
      clientId: `enroll-check-${crypto.randomBytes(3).toString('hex')}`,
    });
    const done = (ok) => { c.end(true); resolve(ok); };
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
    setTimeout(() => done(false), 7000);
  });
}

// ----------------------------------------------------------------- pairing --

// The device record for this hash and MAC whose account also owns the hash's
// identity. Another account's look-alike record (same MAC, same hash, written
// by hand) is passed over rather than allowed to shadow the real one.
async function pairedDevice(hash, mac) {
  const snap = await db.collectionGroup('devices').where('hashedId', '==', hash).get();
  const candidates = snap.docs.filter((d) => d.id.replace(/:/g, '').toUpperCase() === mac);
  if (!candidates.length) return null;
  const [, appId] = candidates[0].ref.path.split('/');
  const ident = await identityRef(appId, hash).get();
  const owner = ident.exists ? ident.data().owner : null;
  const device = candidates.find((d) => d.ref.path.split('/')[3] === owner) || null;
  if (!device) log('WARN', `${short(hash)} mac=${mac}: ${candidates.length} device record(s), none under the identity's owner`);
  return device;
}

// -------------------------------------------------------------- the request --

const inFlight = new Map();          // one enrollment per hash at a time
const recent = new Map();            // hash -> attempt timestamps
const PER_HASH_PER_HOUR = 20;

function tooMany(hash) {
  const now = Date.now();
  const list = (recent.get(hash) || []).filter((t) => now - t < 3600_000);
  list.push(now); recent.set(hash, list);
  return list.length > PER_HASH_PER_HOUR;
}

async function enroll({ hash, mac, secret }, ip) {
  if (!/^[0-9a-f]{64}$/.test(hash || '')) return [400, { status: 'bad-request', detail: 'hash' }];
  if (!/^[0-9A-F]{12}$/.test(mac || '')) return [400, { status: 'bad-request', detail: 'mac' }];
  if (!/^[A-Za-z0-9]{32,128}$/.test(secret || '')) return [400, { status: 'bad-request', detail: 'secret' }];
  if (tooMany(hash)) return [429, { status: 'slow-down' }];

  const device = await pairedDevice(hash, mac);
  if (!device) {
    log('INFO', `refused ${short(hash)} mac=${mac} from ${ip}: not paired`);
    return [403, { status: 'not-paired' }];
  }
  if (device.data()?.mqttKey?.disabled === true) {
    log('INFO', `refused ${short(hash)} mac=${mac} from ${ip}: keys disabled for this device`);
    return [403, { status: 'disabled' }];
  }

  if (await clientExists(hash)) {
    if (await secretWorks(hash, secret)) {
      log('INFO', `repeat enrollment ${short(hash)} from ${ip}: same key`);
      return [200, { status: 'already-enrolled', port: KEY_PORT }];
    }
    log('WARN', `CONFLICT ${short(hash)} mac=${mac} from ${ip}: already enrolled with a different key`);
    await device.ref.update({
      'mqttKey.conflictAt': FieldValue.serverTimestamp(),
      'mqttKey.conflicts': FieldValue.increment(1),
    }).catch((e) => log('WARN', 'recording conflict failed:', e.message));
    return [409, { status: 'locked' }];
  }

  await createKey(hash, secret, device.ref.path);
  await device.ref.update({
    'mqttKey.enrolledAt': FieldValue.serverTimestamp(),
    'mqttKey.port': KEY_PORT,
  }).catch((e) => log('WARN', 'recording enrollment failed:', e.message));
  log('INFO', `ENROLLED ${short(hash)} mac=${mac} from ${ip}`);
  return [201, { status: 'enrolled', port: KEY_PORT }];
}

// ------------------------------------------------------------------- reset --

const RESETS = 'keyResets';

async function processReset(snap) {
  const uid = snap.ref.path.split('/')[3];          // artifacts/<appId>/users/<uid>/keyResets/<deviceId>
  const deviceRef = db.doc(`artifacts/${snap.ref.path.split('/')[1]}/users/${uid}/devices/${snap.id}`);
  const device = await deviceRef.get();
  const hash = device.exists ? device.data().hashedId : String(snap.data()?.hashedId || '');
  if (!/^[0-9a-f]{64}$/.test(hash || '')) {
    log('WARN', `reset ${snap.ref.path}: no usable hash -- dropped`);
    return snap.ref.delete();
  }
  // Neither a device record nor the hash in the request proves ownership: any
  // signed-in user can write a record naming another family's device under
  // their own account. So the requester must hold the hash's identity record,
  // or the key must have been enrolled for exactly this device path under this
  // account -- the case when the app unlinks right after asking and the
  // identity record is already gone.
  const [, appId] = snap.ref.path.split('/');
  const [ident, [info]] = await Promise.all([
    identityRef(appId, hash).get(),
    dynsecBatch([{ command: 'getClient', username: hash }]),
  ]);
  if (info.error && !device.exists) return snap.ref.delete();   // no key, no record: nothing to do
  const ownsIdentity = ident.exists && ident.data().owner === uid;
  const keyIsTheirs = !info.error && info.data?.client?.textname === deviceRef.path;
  if (!ownsIdentity && !keyIsTheirs) {
    log('WARN', `REFUSED reset of ${short(hash)} by ${uid.slice(0, 8)}..: neither the identity nor the key is theirs`);
    return snap.ref.delete();
  }
  await removeKey(hash);
  if (device.exists) {
    await deviceRef.update({
      'mqttKey.resetAt': FieldValue.serverTimestamp(),
      'mqttKey.enrolledAt': FieldValue.delete(),
      'mqttKey.conflictAt': FieldValue.delete(),
      'mqttKey.conflicts': FieldValue.delete(),
    }).catch((e) => log('WARN', 'recording reset failed:', e.message));
  }
  await snap.ref.delete();
  log('INFO', `RESET ${short(hash)} by ${uid.slice(0, 8)}..${device.exists ? '' : ' (device record already gone)'}`);
}

const resetting = new Set();
async function handleResets(docs) {
  for (const d of docs) {
    if (resetting.has(d.ref.path)) continue;
    resetting.add(d.ref.path);
    try { await processReset(d); }
    catch (e) { log('WARN', `reset ${d.ref.path} failed, will retry: ${e.message}`); }
    finally { resetting.delete(d.ref.path); }
  }
}

// Reads only pending requests, which are normally none.
db.collectionGroup(RESETS).onSnapshot(
  (qs) => handleResets(qs.docs),
  (e) => log('ERROR', 'reset listener:', e.message),
);
// A request that failed (broker admin connection down, say) is retried.
setInterval(async () => {
  try { handleResets((await db.collectionGroup(RESETS).get()).docs); } catch {}
}, 60_000);

// ------------------------------------------------------------------- sweep --

const SWEEP_EVERY_MS = parseInt(env.SWEEP_EVERY_MS || String(6 * 3600_000), 10);
const missing = new Map();          // hash -> consecutive sweeps its device record was missing

async function deviceStillHolds(hash, textname) {
  if (textname && textname.startsWith('artifacts/')) {
    const d = await db.doc(textname).get();
    return d.exists && d.data().hashedId === hash;
  }
  // Keys made before textname carried the path.
  return !(await db.collectionGroup('devices').where('hashedId', '==', hash).limit(1).get()).empty;
}

async function sweep() {
  const [list] = await dynsecBatch([{ command: 'listClients', verbose: true, count: -1, offset: 0 }]);
  if (list.error) throw new Error(`listClients: ${list.error}`);
  const clients = (list.data?.clients || []).filter((c) => /^[0-9a-f]{64}$/.test(c.username));
  let removed = 0;
  for (const c of clients) {
    if ((c.textname || '').startsWith('keep:')) continue;
    if (await deviceStillHolds(c.username, c.textname)) { missing.delete(c.username); continue; }
    const n = (missing.get(c.username) || 0) + 1;
    if (n < 2) { missing.set(c.username, n); continue; }
    await removeKey(c.username);
    missing.delete(c.username);
    removed++;
    log('INFO', `SWEPT orphaned key ${short(c.username)}`);
  }
  log('INFO', `sweep: ${clients.length} device keys checked, ${removed} removed, ${missing.size} pending a second miss`);
  return { checked: clients.length, removed, pending: missing.size };
}

setTimeout(() => sweep().catch((e) => log('WARN', 'sweep failed:', e.message)), 60_000);
setInterval(() => sweep().catch((e) => log('WARN', 'sweep failed:', e.message)), SWEEP_EVERY_MS);

// -------------------------------------------------------------- app logins --

// Firebase ID tokens are RS256 JWTs signed with keys Google publishes here.
const GOOGLE_CERTS = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let certs = { keys: {}, until: 0, fetchedAt: 0 };

async function signingKeys(force = false) {
  const now = Date.now();
  if (!force && now < certs.until) return certs.keys;
  if (force && now - certs.fetchedAt < 60_000) return certs.keys;   // an unknown kid cannot make us hammer Google
  const res = await fetch(GOOGLE_CERTS);
  if (!res.ok) throw new Error(`signing keys: HTTP ${res.status}`);
  const maxAge = parseInt(/max-age=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1] || '3600', 10);
  const pems = await res.json();
  const keys = Object.fromEntries(Object.entries(pems).map(([kid, pem]) => [kid, new crypto.X509Certificate(pem).publicKey]));
  certs = { keys, until: now + Math.min(maxAge, 6 * 3600) * 1000, fetchedAt: now };
  return keys;
}

// The uid a valid token belongs to, or null. Checks what Firebase's own
// verifier checks: signature, algorithm, audience, issuer, expiry, subject.
async function verifyIdToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch { return null; }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
  let key = (await signingKeys())[header.kid];
  if (!key) key = (await signingKeys(true))[header.kid];
  if (!key) return null;
  const signed = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!signed) return null;
  const now = Math.floor(Date.now() / 1000);
  const SKEW = 300;
  if (claims.aud !== PROJECT_ID || claims.iss !== `https://securetoken.google.com/${PROJECT_ID}`) return null;
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128) return null;
  if (!(claims.exp > now) || !(claims.iat <= now + SKEW) || !(claims.auth_time <= now + SKEW)) return null;
  return claims.sub;
}

const APP_GROUP = 'apps';
const appUser = (uid) => `app-${uid}`;
const appPassword = (uid) => crypto.createHmac('sha256', APP_LOGIN_SECRET).update(`app-login:${uid}`).digest('base64url');

// What pairing needs, for every signed-in parent: send a claim or ping to a
// code, hear the device's reply.
const APP_SHARED_ACLS = [
  ['publishClientSend', 'doorbell/pairing/+'],
  ['subscribePattern', 'doorbell/pairing/reply/+'],
];
const parentHashAcls = (h) => [
  ['subscribePattern', `doorbell/msg/${h}`],
  ['subscribePattern', `doorbell/msg/${h}/#`],
  ['publishClientSend', `doorbell/msg/${h}`],          // clearing a retained message once saved
  ['publishClientSend', `doorbell/msg/${h}/#`],
];
const deviceHashAcls = (h) => [
  ['subscribePattern', `doorbell/presence/${h}`],
  ['subscribePattern', `doorbell/msg/${h}/#`],
  ['subscribePattern', `doorbell/monitor/${h}/#`],
  ['publishClientSend', `doorbell/msg/${h}/#`],        // chatting with the child
  ['publishClientSend', `doorbell/monitor/${h}/#`],    // clearing Monitor alerts
  ['publishClientSend', `doorbell/cmd/${h}`],
];
const aclKey = ([acltype, topic]) => `${acltype} ${topic}`;
const aclObj = ([acltype, topic]) => ({ acltype, topic, allow: true, priority: 0 });
// Every rule that could name this hash, in either form.
const aclsNaming = (h) => [...parentHashAcls(h), ...deviceHashAcls(h)];
const hashInTopic = (topic) => topic.split('/').find((s) => HASH_RE.test(s)) || null;

// The hashes this account may reach: its parent ID and its devices, each only
// if the identity record names this account.
async function grantsFor(uid) {
  const base = `artifacts/${APP_ID}/users/${uid}`;
  const [profile, devices] = await Promise.all([
    db.doc(`${base}/profile/parent`).get(),
    db.collection(`${base}/devices`).get(),
  ]);
  const virtualId = profile.exists ? profile.data().virtualId : null;
  const parentHash = virtualId && virtualId !== 'PENDING' ? hashId(virtualId) : null;
  const deviceHashes = [...new Set(devices.docs.map((d) => d.data().hashedId).filter((h) => HASH_RE.test(h || '')))];
  const wanted = [...new Set([parentHash, ...deviceHashes].filter(Boolean))];
  const idents = wanted.length ? await db.getAll(...wanted.map((h) => identityRef(APP_ID, h))) : [];
  const owned = new Set(idents.filter((s) => s.exists && s.data().owner === uid).map((s) => s.id));
  return {
    parent: owned.has(parentHash) ? parentHash : null,
    devices: deviceHashes.filter((h) => owned.has(h)),
    refused: wanted.filter((h) => !owned.has(h)),
    hasAccount: profile.exists || !devices.empty,
  };
}

const wantedAcls = (g) => [
  ...(g.parent ? parentHashAcls(g.parent) : []),
  ...g.devices.flatMap(deviceHashAcls),
];

// hash -> Set of app role names whose rules name it. Built from the broker at
// start, kept current by every change made here.
const holders = new Map();
let holdersReady = null;

function indexRole(rolename, acls) {
  for (const set of holders.values()) set.delete(rolename);
  for (const a of acls) {
    const h = hashInTopic(a.topic);
    if (!h) continue;
    if (!holders.has(h)) holders.set(h, new Set());
    holders.get(h).add(rolename);
  }
}

async function loadHolders() {
  const [list] = await dynsecBatch([{ command: 'listRoles', verbose: true, count: -1, offset: 0 }]);
  if (list.error) throw new Error(`listRoles: ${list.error}`);
  holders.clear();
  const roles = (list.data?.roles || []).filter((r) => r.rolename.startsWith('app-'));
  for (const r of roles) indexRole(r.rolename, r.acls || []);
  return roles;
}

// The shared pairing role and group. Adds only what is missing: changing a
// role disconnects everyone holding it.
async function ensureAppGroup() {
  const [role, group] = await dynsecBatch([
    { command: 'getRole', rolename: APP_GROUP },
    { command: 'getGroup', groupname: APP_GROUP },
  ]);
  const cmds = [];
  if (role.error) cmds.push({ command: 'createRole', rolename: APP_GROUP, acls: APP_SHARED_ACLS.map(aclObj) });
  else {
    const have = new Set((role.data.role.acls || []).map((a) => `${a.acltype} ${a.topic}`));
    for (const a of APP_SHARED_ACLS) if (!have.has(aclKey(a))) cmds.push({ command: 'addRoleACL', rolename: APP_GROUP, ...aclObj(a) });
  }
  if (group.error) cmds.push({ command: 'createGroup', groupname: APP_GROUP, roles: [{ rolename: APP_GROUP }] });
  if (!cmds.length) return;
  const out = await dynsecBatch(cmds);
  const bad = out.find((r) => r.error);
  if (bad) throw new Error(`app group: ${bad.command}: ${bad.error}`);
  log('INFO', `app group set up (${cmds.map((c) => c.command).join(', ')})`);
}

// One change at a time: two logins racing would each diff against a stale role.
let appQueue = Promise.resolve();
const serially = (fn) => { const run = appQueue.then(fn, fn); appQueue = run.catch(() => {}); return run; };

// Bring one account's login and role in line with its grants. Returns whether
// anything changed.
function applyGrants(uid, g) {
  return serially(async () => {
    await (holdersReady ||= Promise.all([ensureAppGroup(), loadHolders()]).catch((e) => { holdersReady = null; throw e; }));
    const username = appUser(uid);
    const rolename = username;
    const want = wantedAcls(g);
    const [roleInfo, clientInfo] = await dynsecBatch([
      { command: 'getRole', rolename },
      { command: 'getClient', username },
    ]);
    const cmds = [];
    // Sessions to disconnect so they reconnect under the changed rules. Changing a
    // role's rules does NOT disconnect anyone using it (2.0.18, logins created
    // while the broker runs -- tested 2026-09-15): an existing subscription would
    // go on delivering a removed child's messages. Disabling and re-enabling the
    // login in the same message does disconnect, and the phone's automatic
    // reconnect -- same password -- resubscribes under the new rules.
    const kick = new Set();
    if (roleInfo.error) {
      cmds.push({ command: 'createRole', rolename, acls: want.map(aclObj) });
    } else {
      const have = roleInfo.data.role.acls || [];
      const wantKeys = new Set(want.map(aclKey));
      const haveKeys = new Set(have.map((a) => `${a.acltype} ${a.topic}`));
      for (const a of have) if (!wantKeys.has(`${a.acltype} ${a.topic}`)) cmds.push({ command: 'removeRoleACL', rolename, acltype: a.acltype, topic: a.topic });
      for (const a of want) if (!haveKeys.has(aclKey(a))) cmds.push({ command: 'addRoleACL', rolename, ...aclObj(a) });
      // Additions too: a subscription the phone attempted before this change was
      // refused, and only a reconnect makes it try again.
      if (cmds.length && !clientInfo.error) kick.add(username);
    }
    if (clientInfo.error) {
      cmds.push({ command: 'createClient', username, password: appPassword(uid), textname: `app:${uid}`,
        roles: [{ rolename }], groups: [{ groupname: APP_GROUP }] });
    }
    // A hash this account now owns comes off every other parent's role.
    const stripped = [];
    for (const h of [g.parent, ...g.devices].filter(Boolean)) {
      for (const other of holders.get(h) || []) {
        if (other === rolename) continue;
        for (const [acltype, topic] of aclsNaming(h)) cmds.push({ command: 'removeRoleACL', rolename: other, acltype, topic });
        kick.add(other);                                     // role name == its login's username
        stripped.push(`${short(h)} from ${other.slice(0, 12)}..`);
      }
    }
    for (const u of kick) cmds.push({ command: 'disableClient', username: u }, { command: 'enableClient', username: u });
    if (!cmds.length) return false;
    const out = await dynsecBatch(cmds);
    const bad = out.find((r) => r.error && !(r.command === 'removeRoleACL' && /not found/i.test(r.error)));
    if (bad) throw new Error(`${bad.command}: ${bad.error}`);
    indexRole(rolename, want.map(aclObj));
    for (const h of [g.parent, ...g.devices].filter(Boolean)) {
      for (const other of [...(holders.get(h) || [])]) if (other !== rolename) holders.get(h).delete(other);
    }
    log('INFO', `APP ROLE ${uid.slice(0, 8)}.. parent=${g.parent ? short(g.parent) : '-'} devices=${g.devices.length}` +
      `${g.refused.length ? ` refused=${g.refused.map(short).join(',')}` : ''}${stripped.length ? ` stripped ${stripped.join('; ')}` : ''}` +
      ` (${cmds.length} change${cmds.length === 1 ? '' : 's'})`);
    return true;
  });
}

async function removeAppLogin(uid) {
  return serially(async () => {
    await dynsecBatch([
      { command: 'deleteClient', username: appUser(uid) },
      { command: 'deleteRole', rolename: appUser(uid) },
    ]);
    indexRole(appUser(uid), []);
  });
}

const appRecent = new Map();          // uid -> call timestamps
const APP_CALLS_PER_10_MIN = 40;

async function appLogin(token, ip) {
  const uid = await verifyIdToken(token);
  if (!uid) {
    log('INFO', `app-login refused from ${ip}: bad token`);
    return [401, { status: 'unauthenticated' }];
  }
  const now = Date.now();
  const calls = (appRecent.get(uid) || []).filter((t) => now - t < 600_000);
  calls.push(now); appRecent.set(uid, calls);
  if (calls.length > APP_CALLS_PER_10_MIN) return [429, { status: 'slow-down' }];

  const g = await grantsFor(uid);
  await applyGrants(uid, g);
  return [200, {
    status: 'ok',
    username: appUser(uid),
    password: appPassword(uid),
    url: APP_URL,
    granted: [g.parent, ...g.devices].filter(Boolean),
  }];
}

// Daily: every app role re-derived from the database, so a grant can never
// outlive the identity behind it for long -- whatever the phone does. An account
// with no profile and no devices left (deleted, or never set up) loses its login;
// the app asks for a new one if it ever comes back.
const APP_RECONCILE_EVERY_MS = parseInt(env.APP_RECONCILE_EVERY_MS || String(24 * 3600_000), 10);

async function reconcileApps() {
  const roles = await serially(loadHolders);
  let changed = 0, removed = 0;
  for (const r of roles) {
    const uid = r.rolename.slice('app-'.length);
    const g = await grantsFor(uid);
    if (!g.hasAccount) { await removeAppLogin(uid); removed++; log('INFO', `APP LOGIN REMOVED ${uid.slice(0, 8)}..: no account data`); continue; }
    if (await applyGrants(uid, g)) changed++;
  }
  log('INFO', `app reconcile: ${roles.length} app logins checked, ${changed} updated, ${removed} removed`);
  return { checked: roles.length, changed, removed };
}

setTimeout(() => reconcileApps().catch((e) => log('WARN', 'app reconcile failed:', e.message)), 90_000);
setInterval(() => reconcileApps().catch((e) => log('WARN', 'app reconcile failed:', e.message)), APP_RECONCILE_EVERY_MS);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 2048) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parse(body, type) {
  if (/json/i.test(type || '')) { try { return JSON.parse(body); } catch { return {}; } }
  return Object.fromEntries(new URLSearchParams(body));
}

const server = http.createServer(async (req, res) => {
  const extra = {};
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', ...extra }); res.end(JSON.stringify(obj)); };
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress);
  // Run a sweep now. Only reachable on the droplet itself: nginx proxies nothing
  // but /enroll and /app-login, and anything that did come through nginx carries
  // this header.
  const internal = req.method === 'POST' && !req.headers['x-forwarded-for'];
  if (req.url === '/internal/sweep' && internal) {
    try { return send(200, await sweep()); } catch (e) { return send(503, { status: 'unavailable', detail: e.message }); }
  }
  if (req.url === '/internal/app-reconcile' && internal) {
    try { return send(200, await reconcileApps()); } catch (e) { return send(503, { status: 'unavailable', detail: e.message }); }
  }

  if (req.url === '/app-login') {
    const origin = req.headers.origin;
    if (origin && APP_ORIGINS.has(origin)) Object.assign(extra, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
    extra['Cache-Control'] = 'no-store';
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...extra, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' });
      return res.end();
    }
    if (req.method !== 'POST') return send(405, { status: 'method' });
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1];
    try {
      const [code, body] = await appLogin(token, ip);
      return send(code, body);
    } catch (e) {
      log('ERROR', `app-login failed: ${e.message}`);
      return send(503, { status: 'unavailable' });
    }
  }

  if (req.url !== '/enroll') return send(404, { status: 'not-found' });
  if (req.method !== 'POST') return send(405, { status: 'method' });

  let fields;
  try { fields = parse(await readBody(req), req.headers['content-type']); }
  catch { return send(400, { status: 'bad-request' }); }
  const input = {
    hash: String(fields.hash || '').trim().toLowerCase(),
    mac: String(fields.mac || '').replace(/:/g, '').trim().toUpperCase(),
    secret: String(fields.secret || ''),
  };

  if (inFlight.has(input.hash)) return send(429, { status: 'slow-down' });
  inFlight.set(input.hash, true);
  try {
    const [code, body] = await enroll(input, ip);
    send(code, body);
  } catch (e) {
    log('ERROR', `enroll ${short(input.hash)} failed: ${e.message}`);
    send(503, { status: 'unavailable' });
  } finally {
    inFlight.delete(input.hash);
  }
});

server.listen(LISTEN_PORT, '127.0.0.1', () => log('INFO', `enrollment listening on 127.0.0.1:${LISTEN_PORT}`));
