/**
 * Per-device key check: what a device logged in with its OWN key may and may
 * not do, and that it still talks to everything on the shared-login ports.
 *
 *   node keytest.mjs <host> <sharedTlsPort> <wsPort> <keyPort> [--insecure]
 *
 * Environment: KEY_USER / KEY_PASS (a device key -- its username is a device
 * hash), plus DEVICE_PASS and APP_PASS for the shared logins it is tested
 * against.
 *
 * "Someone else" is a random hash that belongs to nobody. Every message is
 * non-retained with the payload KEYTEST, so nothing real can receive it.
 */
import mqtt from 'mqtt';
import crypto from 'node:crypto';

const [host, sharedPort, wsPort, keyPort] = process.argv.slice(2);
const insecure = process.argv.includes('--insecure');
if (!host || !sharedPort || !wsPort || !keyPort) {
  console.error('usage: node keytest.mjs <host> <sharedTlsPort> <wsPort> <keyPort> [--insecure]');
  process.exit(2);
}

const ME = process.env.KEY_USER;
const OTHER = crypto.randomBytes(32).toString('hex');
const PAYLOAD = 'KEYTEST';
const WAIT = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOGINS = {
  key: { username: ME, password: process.env.KEY_PASS, url: `mqtts://${host}:${keyPort}` },
  device: { username: 'DigitalDoorbell', password: process.env.DEVICE_PASS, url: `mqtts://${host}:${sharedPort}` },
  app: { username: 'dotdash-app', password: process.env.APP_PASS, url: `wss://${host}:${wsPort}/mqtt` },
};

function open(login, overrides = {}) {
  const l = { ...LOGINS[login], ...overrides };
  const opts = {
    clientId: `keytest-${login}-${crypto.randomBytes(3).toString('hex')}`,
    reconnectPeriod: 0, connectTimeout: 8000, rejectUnauthorized: !insecure,
    username: l.username, password: l.password,
  };
  return new Promise((resolve) => {
    const c = mqtt.connect(l.url, opts);
    c.once('connect', () => resolve({ ok: true, c }));
    c.once('error', (e) => { c.end(true); resolve({ ok: false, err: e.message }); });
    setTimeout(() => { c.end(true); resolve({ ok: false, err: 'timeout' }); }, 9000);
  });
}

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

const connects = async (login, o) => { const r = await open(login, o); r.c?.end(true); return r.ok; };

const results = [];
async function check(name, expect, fn) {
  let actual;
  try { actual = await fn(); } catch (e) { actual = `error: ${e.message}`; }
  const pass = actual === expect;
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `   (expected ${expect}, got ${actual})`}`);
}

console.log(`broker ${host}  shared:${sharedPort}  ws:${wsPort}  keys:${keyPort}  key ${ME.slice(0, 12)}...\n`);

console.log('-- logging in');
await check('own key accepted on the key port', true, () => connects('key'));
await check('own key with wrong password refused', false, () => connects('key', { password: 'wrong-' + Date.now() }));
await check('shared device password refused on the key port', false, () => connects('key', { username: 'DigitalDoorbell', password: process.env.DEVICE_PASS }));
await check('a key cannot log in as another device', false, () => connects('key', { username: OTHER }));

console.log('-- its own mailboxes');
await check('receives its own mail (from app)', true, () => delivers('app', 'key', `doorbell/msg/${ME}/1`, `doorbell/msg/${ME}/#`));
await check('receives its own commands (from app)', true, () => delivers('app', 'key', `doorbell/cmd/${ME}`, `doorbell/cmd/${ME}`));
await check('publishes its own presence (to app)', true, () => delivers('key', 'app', `doorbell/presence/${ME}`, `doorbell/presence/${ME}`));
await check('publishes its own Monitor copy (to app)', true, () => delivers('key', 'app', `doorbell/monitor/${ME}/1`, `doorbell/monitor/${ME}/#`));
await check('publishes its own score (to shared device)', true, () => delivers('key', 'device', `doorbell/score/train/${ME}`, `doorbell/score/+/${ME}`));

console.log('-- talking to everyone else');
await check('sends mail to another device (shared login)', true, () => delivers('key', 'device', `doorbell/msg/${OTHER}/1`, `doorbell/msg/${OTHER}/#`));
await check('receives mail from a shared-login device', true, () => delivers('device', 'key', `doorbell/msg/${ME}/2`, `doorbell/msg/${ME}/#`));
await check('sees a friend\'s presence', true, () => delivers('device', 'key', `doorbell/presence/${OTHER}`, `doorbell/presence/${OTHER}`));
await check('sees a friend\'s score', true, () => delivers('device', 'key', `doorbell/score/train/${OTHER}`, `doorbell/score/+/${OTHER}`));

console.log('-- what it must NOT do');
await check('cannot read another device\'s mail', false, () => delivers('app', 'key', `doorbell/msg/${OTHER}/1`, `doorbell/msg/${OTHER}/#`));
await check('cannot read all mail with a wildcard', false, () => delivers('app', 'key', `doorbell/msg/${OTHER}/2`, 'doorbell/msg/#'));
await check('cannot read another device\'s commands', false, () => delivers('app', 'key', `doorbell/cmd/${OTHER}`, `doorbell/cmd/${OTHER}`));
await check('cannot send another device commands', false, () => delivers('key', 'device', `doorbell/cmd/${OTHER}`, `doorbell/cmd/${OTHER}`));
await check('cannot fake another device\'s presence', false, () => delivers('key', 'app', `doorbell/presence/${OTHER}`, `doorbell/presence/${OTHER}`));
await check('cannot fake another device\'s Monitor feed', false, () => delivers('key', 'app', `doorbell/monitor/${OTHER}/1`, `doorbell/monitor/${OTHER}/#`));
await check('cannot fake another device\'s score', false, () => delivers('key', 'device', `doorbell/score/train/${OTHER}`, `doorbell/score/+/${OTHER}`));
await check('cannot read Monitor, even its own', false, () => delivers('app', 'key', `doorbell/monitor/${ME}/2`, `doorbell/monitor/${ME}/#`));
await check('cannot write a pairing claim', false, () => delivers('key', 'device', `doorbell/pairing/${OTHER}`, `doorbell/pairing/${OTHER}`));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
