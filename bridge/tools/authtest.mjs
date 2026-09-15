/**
 * Broker behaviour check -- run before and after any change to mosquitto's
 * authentication or ACLs, so a config change can be held to a fixed list of
 * what each login must and must not be able to do.
 *
 *   node authtest.mjs <host> <tlsPort> <wsPort> [--insecure]
 *
 * Credentials come from the environment: DEVICE_PASS, APP_PASS, BRIDGE_PASS.
 *
 * Every message goes to a throwaway hash that belongs to no device or parent,
 * is published non-retained, and carries the payload AUTHTEST -- nothing real
 * can receive it, and the push bridge ignores it.
 */
import mqtt from 'mqtt';
import crypto from 'node:crypto';

const [host, tlsPort, wsPort] = process.argv.slice(2);
const insecure = process.argv.includes('--insecure');
if (!host || !tlsPort || !wsPort) {
  console.error('usage: node authtest.mjs <host> <tlsPort> <wsPort> [--insecure]');
  process.exit(2);
}

const H = 'authtest' + crypto.randomBytes(6).toString('hex');
const PAYLOAD = 'AUTHTEST';
const WAIT = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOGINS = {
  device: { username: 'DigitalDoorbell', password: process.env.DEVICE_PASS, port: tlsPort, ws: false },
  bridge: { username: 'dotdash-bridge', password: process.env.BRIDGE_PASS, port: tlsPort, ws: false },
  app: { username: 'dotdash-app', password: process.env.APP_PASS, port: wsPort, ws: true },
};

function open(login, overrides = {}) {
  const l = { ...LOGINS[login], ...overrides };
  const url = l.ws ? `wss://${host}:${l.port}/mqtt` : `mqtts://${host}:${l.port}`;
  const opts = {
    clientId: `authtest-${login}-${crypto.randomBytes(3).toString('hex')}`,
    reconnectPeriod: 0, connectTimeout: 8000, rejectUnauthorized: !insecure,
  };
  if (l.username !== undefined) opts.username = l.username;
  if (l.password !== undefined) opts.password = l.password;
  return new Promise((resolve) => {
    const c = mqtt.connect(url, opts);
    c.once('connect', () => resolve({ ok: true, c }));
    c.once('error', (e) => { c.end(true); resolve({ ok: false, err: e.message }); });
    setTimeout(() => { c.end(true); resolve({ ok: false, err: 'timeout' }); }, 9000);
  });
}

// Does a message published by `pub` on `topic` reach `sub` subscribed to `filter`?
async function delivers(pub, sub, topic, filter) {
  const a = await open(sub); const b = await open(pub);
  if (!a.ok || !b.ok) { a.c?.end(true); b.c?.end(true); return `connect failed (${a.err || b.err})`; }
  let got = false;
  a.c.on('message', (t, m) => { if (t === topic && m.toString() === PAYLOAD) got = true; });
  await new Promise((r) => a.c.subscribe(filter, { qos: 1 }, r));
  await sleep(300);
  b.c.publish(topic, PAYLOAD, { qos: 1, retain: false });
  await sleep(WAIT);
  a.c.end(true); b.c.end(true);
  return got;
}

const results = [];
async function check(name, expect, fn) {
  let actual;
  try { actual = await fn(); } catch (e) { actual = `error: ${e.message}`; }
  const pass = actual === expect;
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `   (expected ${expect}, got ${actual})`}`);
}

const connects = async (login, o) => { const r = await open(login, o); r.c?.end(true); return r.ok; };

console.log(`broker ${host}  tls:${tlsPort}  ws:${wsPort}  test hash ${H}\n`);

await check('device login accepted', true, () => connects('device'));
await check('device wrong password refused', false, () => connects('device', { password: 'wrong-' + Date.now() }));
await check('anonymous refused', false, () => connects('device', { username: undefined, password: undefined }));
await check('bridge login accepted', true, () => connects('bridge'));
await check('app login accepted (websockets)', true, () => connects('app'));
await check('app wrong password refused', false, () => connects('app', { password: 'wrong-' + Date.now() }));

await check('device -> msg reaches app', true, () => delivers('device', 'app', `doorbell/msg/${H}/1`, `doorbell/msg/${H}/#`));
await check('app -> cmd reaches device', true, () => delivers('app', 'device', `doorbell/cmd/${H}`, `doorbell/cmd/${H}`));
await check('device -> monitor reaches app', true, () => delivers('device', 'app', `doorbell/monitor/${H}/1`, `doorbell/monitor/${H}/#`));
await check('device -> monitor reaches bridge', true, () => delivers('device', 'bridge', `doorbell/monitor/${H}/1`, `doorbell/monitor/${H}/#`));
await check('device CANNOT read monitor', false, () => delivers('app', 'device', `doorbell/monitor/${H}/2`, `doorbell/monitor/${H}/#`));
await check('bridge CANNOT publish', false, () => delivers('bridge', 'app', `doorbell/msg/${H}/2`, `doorbell/msg/${H}/#`));
await check('device CANNOT write a pairing claim', false, () => delivers('device', 'device', `doorbell/pairing/${H}`, `doorbell/pairing/${H}`));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
