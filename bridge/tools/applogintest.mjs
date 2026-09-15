/**
 * App login check, end to end: Firebase token -> /app-login -> broker.
 *
 *   node applogintest.mjs <appLoginUrl> <brokerHost> <tlsPort> <appPort>
 *
 * Run from /root/dotdash_bridge with testusers.mjs beside it. Needs DEVICE_PASS
 * (the shared device login plays every device here), DYNSEC_ADMIN_USER/PASS.
 *
 * Two throwaway parents, A and B, each with a throwaway child ID, parent ID and
 * device record -- random ids nobody holds. Messages go only to those hashes,
 * non-retained. Everything (users, records, identities, broker logins) is
 * removed at the end, whatever happens.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import mqtt from 'mqtt';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { testUser, deleteTestUsers, customToken } from './testusers.mjs';

const [url, host, tlsPort, appPort] = process.argv.slice(2);
if (!url || !host || !tlsPort || !appPort) {
  console.error('usage: node applogintest.mjs <appLoginUrl> <brokerHost> <tlsPort> <appPort>');
  process.exit(2);
}
initializeApp({ credential: cert(JSON.parse(fs.readFileSync('/root/dotdash_bridge/service-account.json', 'utf8'))) });
const db = getFirestore();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = (s) => crypto.createHash('sha256').update(s.trim().toLowerCase()).digest('hex');
const rid = (p) => p + crypto.randomBytes(3).toString('hex').replace(/[0-9]/g, 'Q').toUpperCase() + String(1000 + crypto.randomInt(8999));
const mac = () => 'DDA0' + crypto.randomBytes(4).toString('hex').toUpperCase();
const PAYLOAD = 'APPLOGINTEST';

const results = [];
async function check(name, expect, fn) {
  let actual; try { actual = await fn(); } catch (e) { actual = `error: ${e.message}`; }
  const pass = JSON.stringify(actual) === JSON.stringify(expect);
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `   (expected ${JSON.stringify(expect)}, got ${JSON.stringify(actual)})`}`);
  return actual;
}

async function login(idToken, origin) {
  const headers = { 'Content-Type': 'application/json' };
  if (idToken !== undefined) headers.Authorization = `Bearer ${idToken}`;
  if (origin) headers.Origin = origin;
  const res = await fetch(url, { method: 'POST', headers, body: '{}' });
  let body = {}; try { body = await res.json(); } catch {}
  return { code: res.status, body, cors: res.headers.get('access-control-allow-origin') };
}

const DEVICE = { url: `mqtts://${host}:${tlsPort}`, username: 'DigitalDoorbell', password: process.env.DEVICE_PASS };
const appConn = (creds) => ({ url: `wss://${host}:${appPort}/mqtt`, username: creds.username, password: creds.password });

function open(o) {
  return new Promise((resolve) => {
    const c = mqtt.connect(o.url, { username: o.username, password: o.password, reconnectPeriod: 0, connectTimeout: 8000,
      clientId: `applogintest-${crypto.randomBytes(3).toString('hex')}` });
    c.once('connect', () => resolve(c));
    c.once('error', () => { c.end(true); resolve(null); });
    setTimeout(() => resolve(null), 9000);
  });
}

// Does a message published by `pub` on `topic` reach `sub` subscribed to `filter`?
async function delivers(pub, sub, topic, filter = topic) {
  const a = await open(sub); const b = await open(pub);
  if (!a || !b) { a?.end(true); b?.end(true); return 'connect failed'; }
  let got = false;
  a.on('message', (t, m) => { if (t === topic && m.toString() === PAYLOAD) got = true; });
  await new Promise((r) => a.subscribe(filter, { qos: 1 }, r)); await sleep(300);
  b.publish(topic, PAYLOAD, { qos: 1, retain: false }); await sleep(1500);
  a.end(true); b.end(true);
  return got;
}

// Key store admin, on the key listener (the store is shared with the app port).
async function adminBatch(commands) {
  const a = await open({ url: `mqtts://${host}:${process.env.KEY_PORT || '8885'}`, username: process.env.DYNSEC_ADMIN_USER, password: process.env.DYNSEC_ADMIN_PASS });
  if (!a) return;
  a.publish('$CONTROL/dynamic-security/v1', JSON.stringify({ commands })); await sleep(1000); a.end(true);
}

// ------------------------------------------------------------------ setup --
const A = await testUser('applogintest-a');
const B = await testUser('applogintest-b');
const fam = (u) => {
  const kid = rid('ALTK'), dad = rid('ALTD'), m = mac();
  return { uid: u.uid, token: u.idToken, kid, dad, kidH: H(kid), dadH: H(dad), mac: m,
    devicePath: `artifacts/dotdash/users/${u.uid}/devices/${m}`, profilePath: `artifacts/dotdash/users/${u.uid}/profile/parent` };
};
const a = fam(A), b = fam(B);
const forgedPath = `artifacts/dotdash/users/${a.uid}/devices/${mac()}`;
const ident = (h) => db.doc(`artifacts/dotdash/public/data/identities/${h}`);
const written = [a.devicePath, a.profilePath, b.devicePath, b.profilePath, forgedPath];
const identities = [a.kidH, a.dadH, b.kidH, b.dadH];

async function seedFamily(f) {
  await db.doc(f.profilePath).set({ virtualId: f.dad, email: 'applogintest' });
  await db.doc(f.devicePath).set({ hashedId: f.kidH, identity: { name: f.kid.slice(0, -4), pin: f.kid.slice(-4) }, friends: [f.dad], phrases: [] });
  await ident(f.dadH).set({ owner: f.uid, idString: f.dad, type: 'parent' });
  await ident(f.kidH).set({ owner: f.uid, idString: f.kid, type: 'child' });
}

console.log(`app-login ${url}  broker ${host}:${appPort}  parents ${a.uid} / ${b.uid}\n`);

try {
  await seedFamily(a); await seedFamily(b);
  // A also writes a device record naming B's child -- which it can, it is A's own tree.
  await db.doc(forgedPath).set({ hashedId: b.kidH, identity: { name: 'FORGED', pin: '0000' }, friends: [], phrases: [] });

  // ---- tokens
  await check('no token refused', 401, async () => (await login(undefined)).code);
  await check('garbage token refused', 401, async () => (await login('abc.def.ghi')).code);
  await check('a custom token (signed by the service account, not an ID token) refused', 401, async () => (await login(customToken(a.uid))).code);
  await check('an ID token with a forged signature refused', 401, async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const [h, p] = A.idToken.split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url'));
    claims.sub = claims.user_id = b.uid;                       // try to be B
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${body}`), privateKey).toString('base64url');
    return (await login(`${h}.${body}.${sig}`)).code;
  });
  await check('a real ID token with its payload altered refused', 401, async () => {
    const [h, p, s] = A.idToken.split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url')); claims.sub = b.uid;
    return (await login(`${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${s}`)).code;
  });

  await check('preflight from the iOS app is allowed', [204, 'capacitor://localhost'], async () => {
    const res = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'capacitor://localhost', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    return [res.status, res.headers.get('access-control-allow-origin')];
  });

  const la = await login(A.idToken, 'https://app.dotdashdevice.com');
  await check('parent A signs in', 200, () => la.code);
  await check('web app origin gets CORS', 'https://app.dotdashdevice.com', () => la.cors);
  await check('another site gets no CORS', null, async () => (await login(A.idToken, 'https://evil.example')).cors);
  await check('A is granted its parent ID and its child -- not the forged record naming B\'s child',
    [a.dadH, a.kidH].sort(), () => (la.body.granted || []).sort());
  const credsA = la.body;
  const lb = await login(B.idToken);
  const credsB = lb.body;
  await check('same login again changes nothing and returns the same password', credsA.password, async () => (await login(A.idToken)).body.password);

  await check('A\'s login connects to the app port', true, async () => { const c = await open(appConn(credsA)); c?.end(true); return !!c; });
  await check('a wrong password does not', false, async () => { const c = await open(appConn({ ...credsA, password: credsB.password })); c?.end(true); return !!c; });
  await check('A\'s login does not work on the shared device port', false, async () => { const c = await open({ url: `mqtts://${host}:${tlsPort}`, username: credsA.username, password: credsA.password }); c?.end(true); return !!c; });

  // ---- what A reaches
  const t = () => Date.now() + crypto.randomInt(1000);
  const A_ = appConn(credsA);
  await check('A receives its child\'s messages', true, () => delivers(DEVICE, A_, `doorbell/msg/${a.kidH}/${t()}`, `doorbell/msg/${a.kidH}/#`));
  await check('A receives its child\'s Monitor feed', true, () => delivers(DEVICE, A_, `doorbell/monitor/${a.kidH}/${t()}`, `doorbell/monitor/${a.kidH}/#`));
  await check('A receives its child\'s presence', true, () => delivers(DEVICE, A_, `doorbell/presence/${a.kidH}`));
  await check('A receives its own parent inbox', true, () => delivers(DEVICE, A_, `doorbell/msg/${a.dadH}/${t()}`, `doorbell/msg/${a.dadH}/#`));
  await check('A\'s commands reach its child', true, () => delivers(A_, DEVICE, `doorbell/cmd/${a.kidH}`));
  await check('A can message its child', true, () => delivers(A_, DEVICE, `doorbell/msg/${a.kidH}/${t()}`, `doorbell/msg/${a.kidH}/#`));
  await check('A can send a pairing claim', true, () => delivers(A_, DEVICE, 'doorbell/pairing/ALT123'));
  await check('A hears a pairing reply', true, () => delivers(DEVICE, A_, 'doorbell/pairing/reply/ALT123'));

  await check('A cannot read B\'s child\'s messages', false, () => delivers(DEVICE, A_, `doorbell/msg/${b.kidH}/${t()}`, `doorbell/msg/${b.kidH}/#`));
  await check('A cannot read B\'s child\'s Monitor feed', false, () => delivers(DEVICE, A_, `doorbell/monitor/${b.kidH}/${t()}`, `doorbell/monitor/${b.kidH}/#`));
  await check('A cannot read B\'s parent inbox', false, () => delivers(DEVICE, A_, `doorbell/msg/${b.dadH}/${t()}`, `doorbell/msg/${b.dadH}/#`));
  await check('A cannot see B\'s child\'s presence', false, () => delivers(DEVICE, A_, `doorbell/presence/${b.kidH}`));
  await check('A cannot read everything with a wildcard', false, () => delivers(DEVICE, A_, `doorbell/msg/${b.kidH}/${t()}`, 'doorbell/#'));
  await check('A cannot command B\'s child', false, () => delivers(A_, DEVICE, `doorbell/cmd/${b.kidH}`));
  await check('A cannot inject a message into B\'s child\'s inbox', false, () => delivers(A_, DEVICE, `doorbell/msg/${b.kidH}/${t()}`, `doorbell/msg/${b.kidH}/#`));
  await check('A cannot read other parents\' pairing claims', false, () => delivers(DEVICE, A_, 'doorbell/pairing/ALT123', 'doorbell/pairing/+'));
  await check('B receives its own child\'s messages', true, () => delivers(DEVICE, appConn(credsB), `doorbell/msg/${b.kidH}/${t()}`, `doorbell/msg/${b.kidH}/#`));

  // ---- revocation reaches a phone that is already connected
  const live = await open(A_);
  let dropped = false; live.on('close', () => { dropped = true; });
  await new Promise((r) => live.subscribe(`doorbell/msg/${a.kidH}/#`, { qos: 1 }, r));
  await db.doc(a.devicePath).delete(); await ident(a.kidH).delete();
  await check('after unlinking, A\'s next login no longer grants the child', [a.dadH], async () => (await login(A.idToken)).body.granted);
  await sleep(800);
  await check('and A\'s already-connected session was dropped', true, () => dropped);
  live.end(true);
  await check('and a fresh A session cannot read that child', false, () => delivers(DEVICE, A_, `doorbell/msg/${a.kidH}/${t()}`, `doorbell/msg/${a.kidH}/#`));

  // ---- a child re-paired to another family comes off the old family's role
  await seedFamily(a);
  await check('child re-linked to A is granted again', [a.dadH, a.kidH].sort(), async () => (await login(A.idToken)).body.granted.sort());
  const stale = await open(A_);
  let staleDropped = false; stale.on('close', () => { staleDropped = true; });
  // A never refreshes. The identity moves to B and B pairs the child.
  await db.doc(a.devicePath).delete();
  await ident(a.kidH).set({ owner: b.uid, idString: a.kid, type: 'child' });
  const movedPath = `artifacts/dotdash/users/${b.uid}/devices/${mac()}`; written.push(movedPath);
  await db.doc(movedPath).set({ hashedId: a.kidH, identity: { name: 'MOVED', pin: '0000' }, friends: [], phrases: [] });
  await check('B signs in and is granted the moved child', true, async () => (await login(B.idToken)).body.granted.includes(a.kidH));
  await sleep(800);
  await check('A -- who never refreshed -- was disconnected', true, () => staleDropped);
  stale.end(true);
  await check('and can no longer read the moved child', false, () => delivers(DEVICE, A_, `doorbell/msg/${a.kidH}/${t()}`, `doorbell/msg/${a.kidH}/#`));
  await check('B can', true, () => delivers(DEVICE, appConn(credsB), `doorbell/msg/${a.kidH}/${t()}`, `doorbell/msg/${a.kidH}/#`));

  // ---- daily reconcile removes an account's login once its data is gone
  for (const p of [b.devicePath, b.profilePath, movedPath]) await db.doc(p).delete();
  await check('reconcile ran', true, async () => (await (await fetch('http://127.0.0.1:8790/internal/app-reconcile', { method: 'POST' })).json()).checked >= 2);
  await check('an account with no data left loses its broker login', false, async () => { const c = await open(appConn(credsB)); c?.end(true); return !!c; });

  const burst = await Promise.all(Array.from({ length: 60 }, () => login('x.y.z')));
  await check('a burst of requests is rate-limited', true, () => burst.some((r) => r.code === 429));
} finally {
  for (const p of written) await db.doc(p).delete().catch(() => {});
  for (const h of identities) await ident(h).delete().catch(() => {});
  await adminBatch([A.uid, B.uid].flatMap((u) => [{ command: 'deleteClient', username: `app-${u}` }, { command: 'deleteRole', rolename: `app-${u}` }]));
  await deleteTestUsers([A.uid, B.uid]).catch((e) => console.log('cleanup users:', e.message));
  console.log('\ncleanup done');
}

const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
