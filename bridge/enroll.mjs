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
 * On anything but 200/201 the device keeps using the shared login and tries
 * again later. Nothing here can take a device offline.
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

const log = (level, ...a) => console.log(new Date().toISOString(), level.padEnd(5), ...a);
const short = (h) => String(h).slice(0, 12);

if (!ADMIN_USER || !ADMIN_PASS) {
  log('ERROR', 'DYNSEC_ADMIN_USER / DYNSEC_ADMIN_PASS missing -- refusing to start');
  process.exit(1);
}

initializeApp({ credential: cert(JSON.parse(fs.readFileSync(SERVICE_ACCOUNT, 'utf8'))) });
const db = getFirestore();

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

async function createKey(hash, secret) {
  const rolename = `device-${hash}`;
  // Role first, client last: a client's existence is the lock, so it must not
  // appear until everything it needs is in place.
  await dynsec({ command: 'deleteRole', rolename });   // leftover from a half-finished attempt
  await mustSucceed({ command: 'createRole', rolename });
  try {
    for (const [acltype, topic] of ownAcls(hash)) {
      await mustSucceed({ command: 'addRoleACL', rolename, acltype, topic, allow: true, priority: 0 });
    }
    await mustSucceed({
      command: 'createClient', username: hash, password: secret,
      roles: [{ rolename }], groups: [{ groupname: 'devices' }],
    });
  } catch (e) {
    await dynsec({ command: 'deleteRole', rolename }).catch(() => {});
    throw e;
  }
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

async function pairedDevice(hash, mac) {
  const snap = await db.collectionGroup('devices').where('hashedId', '==', hash).get();
  return snap.docs.find((d) => d.id.replace(/:/g, '').toUpperCase() === mac) || null;
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

  await createKey(hash, secret);
  await device.ref.update({
    'mqttKey.enrolledAt': FieldValue.serverTimestamp(),
    'mqttKey.port': KEY_PORT,
  }).catch((e) => log('WARN', 'recording enrollment failed:', e.message));
  log('INFO', `ENROLLED ${short(hash)} mac=${mac} from ${ip}`);
  return [201, { status: 'enrolled', port: KEY_PORT }];
}

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
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress);
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
