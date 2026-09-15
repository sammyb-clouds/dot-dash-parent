/**
 * Enrollment check, end to end through nginx and TLS, pretending to be a device.
 *
 *   node enrolltest.mjs <enrollUrl> <brokerHost> <keyPort> <wsPort>
 *
 * Run from /root/dotdash_bridge (firebase-admin lives there). Needs APP_PASS,
 * DYNSEC_ADMIN_USER and DYNSEC_ADMIN_PASS in the environment.
 *
 * It creates a THROWAWAY device record under the demo account -- a random hash
 * and a MAC no real device has -- enrolls it, and removes both the record and
 * the key at the end, whatever happens. No real device is ever enrolled.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import mqtt from 'mqtt';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const [url, host, keyPort, wsPort] = process.argv.slice(2);
if (!url || !host || !keyPort || !wsPort) {
  console.error('usage: node enrolltest.mjs <enrollUrl> <brokerHost> <keyPort> <wsPort>');
  process.exit(2);
}

initializeApp({ credential: cert(JSON.parse(fs.readFileSync('/root/dotdash_bridge/service-account.json', 'utf8'))) });
const db = getFirestore();

const DEMO_UID = 'PfKvCyeaV2dMjWTotbiKxprrexH3';
const HASH = crypto.randomBytes(32).toString('hex');
const MAC = 'DDEE' + crypto.randomBytes(4).toString('hex').toUpperCase();
const SECRET = crypto.randomBytes(24).toString('hex');
const OTHER_SECRET = crypto.randomBytes(24).toString('hex');
const docRef = db.doc(`artifacts/dotdash/users/${DEMO_UID}/devices/${MAC}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(fields, { method = 'POST', json = false } = {}) {
  const init = { method };
  if (method === 'POST') {
    init.headers = { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' };
    init.body = json ? JSON.stringify(fields) : new URLSearchParams(fields).toString();
  }
  const res = await fetch(url, init);
  let body = {}; try { body = await res.json(); } catch {}
  return { code: res.status, status: body.status };
}

function login(username, password) {
  return new Promise((resolve) => {
    const c = mqtt.connect(`mqtts://${host}:${keyPort}`, { username, password, reconnectPeriod: 0, connectTimeout: 6000 });
    const done = (ok) => { c.end(true); resolve(ok); };
    c.once('connect', () => done(true)); c.once('error', () => done(false)); setTimeout(() => done(false), 7000);
  });
}

async function delivers(pubOpts, subOpts, topic, filter) {
  const open = (o) => new Promise((resolve) => {
    const c = mqtt.connect(o.url, { username: o.username, password: o.password, reconnectPeriod: 0 });
    c.once('connect', () => resolve(c)); c.once('error', () => resolve(null));
  });
  const a = await open(subOpts); const b = await open(pubOpts);
  if (!a || !b) { a?.end(true); b?.end(true); return 'connect failed'; }
  let got = false;
  a.on('message', (t, m) => { if (t === topic && m.toString() === 'ENROLLTEST') got = true; });
  await new Promise((r) => a.subscribe(filter, { qos: 1 }, r)); await sleep(300);
  b.publish(topic, 'ENROLLTEST', { qos: 1 }); await sleep(1500);
  a.end(true); b.end(true);
  return got;
}

const results = [];
async function check(name, expect, fn) {
  let actual; try { actual = await fn(); } catch (e) { actual = `error: ${e.message}`; }
  const pass = JSON.stringify(actual) === JSON.stringify(expect);
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `   (expected ${JSON.stringify(expect)}, got ${JSON.stringify(actual)})`}`);
}

async function cleanup() {
  await docRef.delete().catch(() => {});
  const admin = mqtt.connect(`mqtts://${host}:${keyPort}`, { username: process.env.DYNSEC_ADMIN_USER, password: process.env.DYNSEC_ADMIN_PASS, reconnectPeriod: 0 });
  await new Promise((r) => { admin.once('connect', r); admin.once('error', r); });
  admin.publish('$CONTROL/dynamic-security/v1', JSON.stringify({ commands: [
    { command: 'deleteClient', username: HASH },
    { command: 'deleteRole', rolename: `device-${HASH}` },
  ] }));
  await sleep(1000); admin.end(true);
}

console.log(`enroll ${url}  broker ${host}:${keyPort}  test device ${HASH.slice(0, 12)}... mac ${MAC}\n`);

try {
  await check('GET is refused', { code: 405, status: 'method' }, () => post({}, { method: 'GET' }));
  await check('malformed request refused', { code: 400, status: 'bad-request' }, () => post({ hash: 'nope', mac: MAC, secret: SECRET }));
  await check('unpaired device refused', { code: 403, status: 'not-paired' }, () => post({ hash: HASH, mac: MAC, secret: SECRET }));

  await docRef.set({ hashedId: HASH, identity: { name: 'ENROLLTEST', pin: '0000' }, friends: [], phrases: [], pairingCode: MAC.slice(-6) });

  await check('paired hash with the wrong MAC refused', { code: 403, status: 'not-paired' }, () => post({ hash: HASH, mac: 'DDEE00000000', secret: SECRET }));
  await check('paired device enrolls', { code: 201, status: 'enrolled' }, () => post({ hash: HASH, mac: MAC, secret: SECRET }));
  await check('its new key logs in', true, () => login(HASH, SECRET));
  await check('same device, same secret again: accepted', { code: 200, status: 'already-enrolled' }, () => post({ hash: HASH, mac: MAC, secret: SECRET }, { json: true }));
  await check('same device, DIFFERENT secret: locked', { code: 409, status: 'locked' }, () => post({ hash: HASH, mac: MAC, secret: OTHER_SECRET }));
  await check('the rejected secret does not log in', false, () => login(HASH, OTHER_SECRET));
  await check('the original key still logs in', true, () => login(HASH, SECRET));

  const key = { url: `mqtts://${host}:${keyPort}`, username: HASH, password: SECRET };
  const app = { url: `wss://${host}:${wsPort}/mqtt`, username: 'dotdash-app', password: process.env.APP_PASS };
  const other = crypto.randomBytes(32).toString('hex');
  await check('enrolled key receives its own mail', true, () => delivers(app, key, `doorbell/msg/${HASH}/1`, `doorbell/msg/${HASH}/#`));
  await check('enrolled key cannot read another device\'s mail', false, () => delivers(app, key, `doorbell/msg/${other}/1`, `doorbell/msg/${other}/#`));

  const rec = (await docRef.get()).data()?.mqttKey || {};
  await check('device record shows enrollment and the conflict', { enrolled: true, conflicts: 1 }, () => ({ enrolled: !!rec.enrolledAt, conflicts: rec.conflicts || 0 }));

  const burst = await Promise.all(Array.from({ length: 30 }, () => post({ hash: 'x', mac: 'x', secret: 'x' })));
  await check('a burst of requests is rate-limited', true, () => burst.some((r) => r.code === 429));
} finally {
  await cleanup();
  const gone = !(await docRef.get()).exists && !(await login(HASH, SECRET));
  console.log(`\ncleanup: test record and key ${gone ? 'removed' : 'NOT FULLY REMOVED -- check by hand'}`);
}

const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
