// End-to-end behaviour of the SMS bridge against in-memory fakes:
//   node --test bridge/sms/
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import * as L from './lib.mjs';
import { createService } from './service.mjs';
import { FakeDB, FakeMqtt, FakeTwilio, FieldValue } from './testfakes.mjs';
import { TwilioError } from './twilio.mjs';

const BASE = 'https://app.example.test';
const AUTH = 'twilio-auth-token';
const POOL1 = '+18005550100', POOL2 = '+18005550200';
const GRANDMA = '+14155552671', STRANGER = '+14155559999';
const MAYA = 'MAYA0515', LEO = 'LEO0101';
const tick = () => new Promise((r) => setTimeout(r, 5));

async function setup() {
  const db = new FakeDB();
  const client = new FakeMqtt();
  const twilio = new FakeTwilio();
  const fcm = { sent: [], failNext: null, async send(m) {
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    this.sent.push(m);
  } };
  const webPush = { sent: [], failNext: null, async send(sub, payload) {
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    this.sent.push({ sub, payload: JSON.parse(payload) });
  } };
  const keys = L.makeKeys(crypto.randomBytes(32).toString('base64'));
  const logs = [];
  const svc = createService({
    db, FieldValue, client, twilio, webPush, fcm, keys,
    verifyIdToken: async (t) => ({ 'tok-u1': 'u1', 'tok-u2': 'u2' }[t] || null),
    config: {
      APP_ID: 'dd', PUBLIC_BASE: BASE, TWILIO_AUTH_TOKEN: AUTH, RETRY_MS: 1, WAIT_MS: 300,
      CHAT_BASE: 'https://dd.example.test', VAPID_PUBLIC_KEY: 'BPUBKEY',
      STATE_PATH: path.join(os.tmpdir(), `sms-state-${crypto.randomBytes(4).toString('hex')}.json`),
      APP_ORIGINS: new Set(['https://app.example.test', 'capacitor://localhost']),
    },
    log: (...a) => logs.push(a.join(' ')),
  });
  await new Promise((r) => svc.server.listen(0, '127.0.0.1', r));
  const port = svc.server.address().port;

  const addDevice = async (uid, mac, childId, friends = ['DAD1234']) => {
    const h = L.hashId(childId);
    await db.doc(`artifacts/dd/users/${uid}/devices/${mac}`).set({ hashedId: h, identity: { name: childId.slice(0, -4), pin: childId.slice(-4) }, friends });
    await db.doc(`artifacts/dd/public/data/identities/${h}`).set({ owner: uid, idString: childId, type: 'child' });
    return h;
  };
  const addPool = (n) => db.doc(`artifacts/dd/smsPool/${L.poolKey(n)}`).set({ number: n, active: true, used: 0, kind: 'tollfree' });

  const api = async (method, p, { tok = 'tok-u1', body } = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', 'X-Forwarded-For': '1.2.3.4' },
      body: body && JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  let sid = 0;
  const sms = async (from, to, text, extra = {}) => {
    const params = { MessageSid: `SMin${++sid}`, From: from, To: to, Body: text, NumMedia: '0', ...extra };
    const sig = extra.badSig ? 'nope' : L.twilioSignature(AUTH, `${BASE}/sms/inbound`, params);
    delete params.badSig;
    const r = await fetch(`http://127.0.0.1:${port}/sms/inbound`, {
      method: 'POST', body: new URLSearchParams(params).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig, 'X-Forwarded-For': '5.6.7.8' },
    });
    return { status: r.status, text: await r.text(), params };
  };
  const toDevice = (h) => client.published.filter((m) => m.topic.startsWith(`doorbell/msg/${h}/`) && m.payload);
  const pairingDocs = () => [...db.data].filter(([p]) => /\/smsPairings\/[^/]+$/.test(p));
  // The web contact's side: the chat page's calls, as the browser makes them.
  const chat = async (method, route, { auth, body, query = '' } = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}/chat/api/${route}${query}`, {
      method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '9.9.9.9', ...(auth ? { Authorization: `Chat ${auth}` } : {}) },
      body: body && JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };

  return { db, client, twilio, webPush, fcm, svc, port, logs, addDevice, addPool, api, sms, chat, toDevice, pairingDocs, close: () => { svc.server.closeAllConnections?.(); svc.server.close(); } };
}

test('full lifecycle: add, contact opts in, both directions, stop, delete, re-add', async () => {
  const t = await setup();
  try {
    await t.addPool(POOL1);
    const maya = await t.addDevice('u1', 'MAC1', MAYA);

    // --- parent adds Grandma
    const add = await t.api('POST', '/sms/contacts', { body: { deviceId: 'MAC1', phone: '(415) 555-2671', contactName: 'Grandma' } });
    assert.equal(add.status, 201, JSON.stringify(add.body));
    const c = add.body.contact;
    assert.match(c.virtualId, /^GRANDMA\d{4}$/);
    assert.equal(c.status, 'pending');
    assert.equal(c.poolNumber, POOL1);
    assert.equal(c.hint, '•••• 2671');
    assert.equal(c.displayName, "Maya's Dot Dash");
    assert.equal(add.body.keyword, 'START');
    // Nothing is ever sent first: the contact opts in themselves.
    assert.equal(t.twilio.sent.length, 0);

    // No phone number in the database except as ciphertext, anywhere.
    const everything = JSON.stringify([...t.db.data]);
    assert.ok(!everything.includes('4155552671'), 'plaintext number stored');
    // The virtual ID is claimed so no child can be given it.
    const vh = L.hashId(c.virtualId);
    assert.equal(t.db.data.get(`artifacts/dd/public/data/identities/${vh}`).type, 'sms');

    await tick();
    assert.ok(t.client.subs.has(`doorbell/msg/${vh}/#`));
    const pres = () => t.client.published.filter((m) => m.topic === `doorbell/presence/${vh}`).at(-1)?.payload;
    assert.equal(pres(), 'OFFLINE');

    // --- bad signature is refused before anything is looked up
    assert.equal((await t.sms(GRANDMA, POOL1, 'hi', { badSig: '1' })).status, 403);

    // --- before START: nudged, nothing reaches the child
    let r = await t.sms(GRANDMA, POOL1, 'hello?');
    assert.match(r.text, /to connect with Maya&apos;s Dot Dash\, reply START/);
    assert.equal(t.toDevice(maya).length, 0);

    // --- START: active, confirmation (program, frequency, rates, HELP, STOP), presence stays OFFLINE
    r = await t.sms(GRANDMA, POOL1, 'Start');
    assert.match(r.text, /Dot Dash: you&apos;re connected to Maya&apos;s Dot Dash\..*save it\. Message frequency varies\. Msg &amp; data rates may apply\. Reply HELP for help, STOP to opt out\./);
    await tick();
    assert.equal(pres(), 'OFFLINE');   // virtual contacts never read as online

    // --- phone -> child
    r = await t.sms(GRANDMA, POOL1, 'Hi, Maya! ❤️ see you Sunday');
    assert.equal(r.text, '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    const got = t.toDevice(maya);
    assert.equal(got.length, 1);
    assert.equal(got[0].payload, `MORSE,HI MAYA! SEE YOU SUNDAY,${c.virtualId}`);
    assert.equal(got[0].retain, true);
    assert.match(got[0].topic, /\/\d{14,19}$/);   // numeric id the firmware's replay guard keys on

    // Twilio retrying the same webhook does not deliver twice.
    await fetch(`http://127.0.0.1:${t.svc.server.address().port}/sms/inbound`, {
      method: 'POST', body: new URLSearchParams(r.params).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': L.twilioSignature(AUTH, `${BASE}/sms/inbound`, r.params) },
    });
    assert.equal(t.toDevice(maya).length, 1);

    // --- child -> phone
    const topic = `doorbell/msg/${vh}/17000000000001`;
    t.client.deliver(topic, `MORSE,LOVE YOU,${MAYA}`);
    await tick();
    assert.equal(t.twilio.sent.length, 1);
    assert.deepEqual(t.twilio.sent[0], { from: POOL1, to: GRANDMA, body: 'Maya via Dot Dash: LOVE YOU' });
    assert.ok(t.client.published.some((m) => m.topic === topic && m.payload === '' && m.retain), 'retained copy cleared');

    // Game traffic from the device is cleared but never relayed.
    const gameTopic = `doorbell/msg/${vh}/17000000000009`;
    t.client.deliver(gameTopic, `GAME,T|4821|3|MOV|4,${MAYA}`);
    await tick();
    assert.equal(t.twilio.sent.length, 1, 'GAME not sent to the phone');
    assert.ok(t.client.published.some((m) => m.topic === gameTopic && m.payload === '' && m.retain), 'GAME retained copy cleared');

    // redelivered after a reconnect: not sent again
    t.client.deliver(topic, `MORSE,LOVE YOU,${MAYA}`);
    await tick();
    assert.equal(t.twilio.sent.length, 1);

    // another device claiming to be someone else is refused
    t.client.deliver(`doorbell/msg/${vh}/17000000000002`, `TEXT,HI,${LEO}`);
    await tick();
    assert.equal(t.twilio.sent.length, 1);

    // --- STOP
    await t.sms(GRANDMA, POOL1, 'STOP');
    await tick();
    assert.equal(pres(), 'OFFLINE');
    t.client.deliver(`doorbell/msg/${vh}/17000000000003`, `TEXT,HELLO,${MAYA}`);
    await tick();
    assert.equal(t.twilio.sent.length, 1, 'sent to an opted-out contact');
    await t.sms(GRANDMA, POOL1, 'are you there');
    assert.equal(t.toDevice(maya).length, 1, 'stopped contact reached the child');

    // START brings it back
    await t.sms(GRANDMA, POOL1, 'START');
    await tick();
    assert.equal(pres(), 'OFFLINE');   // virtual contacts never read as online

    // --- list: only your own
    assert.equal((await t.api('GET', '/sms/contacts')).body.contacts.length, 1);
    assert.equal((await t.api('GET', '/sms/contacts', { tok: 'tok-u2' })).body.contacts.length, 0);
    assert.equal((await t.api('DELETE', `/sms/contacts/${c.id}`, { tok: 'tok-u2' })).status, 404);
    assert.equal((await t.api('GET', '/sms/contacts', { tok: 'bogus' })).status, 401);

    // --- delete: pairing and its number gone, route kept as a tombstone
    const del = await t.api('DELETE', `/sms/contacts/${c.id}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.virtualId, c.virtualId);
    assert.equal(t.pairingDocs().length, 0);
    const routes = [...t.db.data].filter(([p]) => p.includes('/smsRoutes/'));
    assert.equal(routes.length, 1);
    assert.equal(routes[0][1].pairingId, null);
    assert.equal(t.db.data.get(`artifacts/dd/smsPool/${L.poolKey(POOL1)}`).used, 0);
    await tick();
    assert.ok(!t.client.subs.has(`doorbell/msg/${vh}/#`));
    assert.equal(pres(), '');
    assert.ok(t.client.published.filter((m) => m.topic === `doorbell/presence/${vh}`).every((m) => m.payload !== 'ONLINE'), 'ONLINE was ever published');

    r = await t.sms(GRANDMA, POOL1, 'hello?');
    assert.match(r.text, /no longer connected/);
    assert.equal(t.toDevice(maya).length, 1);

    // --- re-adding Grandma to Maya reuses the number and the ID
    const again = await t.api('POST', '/sms/contacts', { body: { deviceId: 'MAC1', phone: GRANDMA, contactName: 'Grandma' } });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(again.body.contact.poolNumber, POOL1);
    assert.equal(again.body.contact.virtualId, c.virtualId);
    // and adding her twice is refused
    assert.equal((await t.api('POST', '/sms/contacts', { body: { deviceId: 'MAC1', phone: GRANDMA, contactName: 'Grandma' } })).body.status, 'already-added');
  } finally { t.close(); }
});

test('pool rules: one device per (contact, number); never reassigned', async () => {
  const t = await setup();
  try {
    await t.addPool(POOL1);
    await t.addDevice('u1', 'MAC1', MAYA);
    await t.addDevice('u1', 'MAC2', LEO);

    assert.equal((await t.api('POST', '/sms/contacts', { body: { deviceId: 'MAC1', phone: GRANDMA, contactName: 'Grandma' } })).status, 201);
    // Grandma to a second grandchild needs a second number; there is none.
    const full = await t.api('POST', '/sms/contacts', { body: { deviceId: 'MAC2', phone: GRANDMA, contactName: 'Grandma' } });
    assert.deepEqual([full.status, full.body.status], [503, 'pool-exhausted']);
    assert.ok(t.logs.some((l) => l.includes('OPS: no pool number free')));

    await t.addPool(POOL2);
    const leo = await t.api('POST', '/sms/contacts', { body: { deviceId: 'MAC2', phone: GRANDMA, contactName: 'Grandma' } });
    assert.equal(leo.status, 201);
    assert.equal(leo.body.contact.poolNumber, POOL2);

    // Each thread reaches its own child.
    await t.sms(GRANDMA, POOL1, 'YES');
    await t.sms(GRANDMA, POOL2, 'YES');
    await t.sms(GRANDMA, POOL1, 'for maya');
    await t.sms(GRANDMA, POOL2, 'for leo');
    assert.deepEqual(t.toDevice(L.hashId(MAYA)).map((m) => m.payload.split(',')[1]), ['FOR MAYA']);
    assert.deepEqual(t.toDevice(L.hashId(LEO)).map((m) => m.payload.split(',')[1]), ['FOR LEO']);

    // Remove Grandma from Maya: POOL1 must NOT be offered for Grandma -> Leo's
    // sibling later, because her phone has POOL1 saved as Maya.
    const list = (await t.api('GET', '/sms/contacts')).body.contacts;
    await t.api('DELETE', `/sms/contacts/${list.find((x) => x.poolNumber === POOL1).id}`);
    await t.addDevice('u1', 'MAC3', 'ZOE0303');
    const zoe = await t.api('POST', '/sms/contacts', { body: { deviceId: 'MAC3', phone: GRANDMA, contactName: 'Grandma' } });
    assert.equal(zoe.body.status, 'pool-exhausted');

    // A stranger to a pool number: told once a day, nothing delivered.
    let r = await t.sms(STRANGER, POOL1, 'hey kid');
    assert.match(r.text, /isn&apos;t connected/);
    r = await t.sms(STRANGER, POOL1, 'hey kid');
    assert.doesNotMatch(r.text, /Message/);
    assert.equal(t.toDevice(L.hashId(MAYA)).length, 1);
  } finally { t.close(); }
});

test('parent API refusals, opted-out and bad numbers, sweep', async () => {
  const t = await setup();
  try {
    await t.addPool(POOL1);
    await t.addDevice('u1', 'MAC1', MAYA);
    await t.addDevice('u2', 'MACX', 'KAI0707', Array.from({ length: 10 }, (_, i) => `F${i}0000`));

    const post = (body, tok) => t.api('POST', '/sms/contacts', { body, tok });
    assert.equal((await post({ deviceId: 'MAC1', phone: '555-1234', contactName: 'Nana' })).body.status, 'invalid-number');
    assert.equal((await post({ deviceId: 'MAC1', phone: POOL1, contactName: 'Nana' })).body.status, 'invalid-number');
    assert.equal((await post({ deviceId: 'MAC1', phone: GRANDMA, contactName: '!!' })).body.status, 'invalid-name');
    assert.equal((await post({ deviceId: 'NOPE', phone: GRANDMA, contactName: 'Nana' })).body.status, 'no-device');
    assert.equal((await post({ deviceId: 'MACX', phone: GRANDMA, contactName: 'Nana' }, 'tok-u2')).body.status, 'friends-full');

    // A device record the parent wrote, for a child ID someone ELSE holds.
    await t.db.doc('artifacts/dd/users/u2/devices/STEAL').set({ hashedId: L.hashId(MAYA), identity: { name: 'MAYA', pin: '0515' }, friends: [] });
    assert.equal((await post({ deviceId: 'STEAL', phone: GRANDMA, contactName: 'Nana' }, 'tok-u2')).body.status, 'not-owner');

    // Adding sends nothing, whatever happens next.
    const pop = await post({ deviceId: 'MAC1', phone: '+14155550001', contactName: 'Pop' });
    assert.equal(pop.status, 201);
    assert.equal(t.twilio.sent.length, 0);
    await t.sms('+14155550001', POOL1, 'START');
    await tick();

    // Twilio says the contact has since opted out (21610): marked stopped.
    const popVh = L.hashId(pop.body.contact.virtualId);
    t.twilio.failNext = new TwilioError(400, { code: 21610, message: 'unsubscribed' });
    t.client.deliver(`doorbell/msg/${popVh}/17000000000009`, `TEXT,HI POP,${MAYA}`);
    await tick(); await tick();
    assert.equal(t.db.data.get(`artifacts/dd/smsPairings/${pop.body.contact.id}`).status, 'stopped');

    // A transient Twilio failure is retried.
    await t.sms('+14155550001', POOL1, 'START');
    await tick();
    t.twilio.failNext = new TwilioError(503, { message: 'busy' });
    t.client.deliver(`doorbell/msg/${popVh}/17000000000010`, `TEXT,HI AGAIN,${MAYA}`);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(t.twilio.sent.at(-1), { from: POOL1, to: '+14155550001', body: 'Maya via Dot Dash: HI AGAIN' });

    const bea = await post({ deviceId: 'MAC1', phone: '+14155550002', contactName: 'Aunt Bea' });
    assert.equal(bea.body.contact.virtualId.slice(0, -4), 'AUNTBEA');

    // Parent-typed names cannot smuggle a link into someone else's messages.
    const linky = await post({ deviceId: 'MAC1', phone: '+14155550003', contactName: 'Nana http://evil.example/x', displayName: "Zoë's <b>bit.ly/x</b>" });
    assert.equal(linky.body.contact.contactName, 'Nana httpevilexamplex');
    assert.equal(linky.body.contact.displayName, "Zoë's bbitlyxb");
    const welcome = await t.sms('+14155550003', POOL1, 'START');
    assert.ok(!/https?:|evil\.example|bit\.ly|&lt;/.test(welcome.text));

    // Sweep: a contact taken off the device's friend list behind the bridge's
    // back is deleted -- but not one created in the last hour, whose friend ID
    // the app may still be about to add.
    await t.addDevice('u1', 'MAC9', 'ROSA0909');
    const rosa = await post({ deviceId: 'MAC9', phone: '+14155550009', contactName: 'Tia' });
    assert.equal((await t.svc.sweep()).removed, 0);
    t.db.data.get(`artifacts/dd/smsPairings/${rosa.body.contact.id}`).createdAt = { toMillis: () => Date.now() - 2 * 3600e3 };
    assert.equal((await t.svc.sweep()).removed, 1);

    // Sweep: unpairing Maya's device deletes her contacts.
    assert.equal(t.pairingDocs().length, 3);
    await t.db.doc('artifacts/dd/users/u1/devices/MAC1').delete();
    const s = await t.svc.sweep();
    assert.deepEqual(s, { checked: 3, removed: 3 });
    assert.equal(t.pairingDocs().length, 0);
  } finally { t.close(); }
});

test('web link contact: add, claim, lock, both directions, push, leave, new link', async () => {
  const t = await setup();
  try {
    const maya = await t.addDevice('u1', 'MAC1', MAYA);

    // --- the account holder adds Grandma by link: no phone number, no pool needed
    const add = await t.api('POST', '/sms/contacts', { body: { deviceId: 'MAC1', contactName: 'Grandma', channel: 'web' } });
    assert.equal(add.status, 201, JSON.stringify(add.body));
    const c = add.body.contact;
    assert.equal(c.channel, 'web');
    assert.equal(c.status, 'pending');
    assert.equal(c.poolNumber, null);
    assert.match(add.body.link, /^https:\/\/dd\.example\.test\/c\/[A-Za-z0-9_-]{32}$/);
    const token = add.body.link.split('/c/')[1];
    assert.equal(t.twilio.sent.length, 0);
    // only the token's hash is stored
    assert.ok(!JSON.stringify([...t.db.data]).includes(token), 'plaintext token stored');
    const vh = L.hashId(c.virtualId);
    await tick();
    assert.ok(t.client.subs.has(`doorbell/msg/${vh}/#`));

    // --- the link, before anyone connects
    assert.equal((await t.chat('POST', 'open', { body: { token: 'x'.repeat(32) } })).status, 410);
    let r = await t.chat('POST', 'open', { body: { token } });
    assert.deepEqual(r.body, { id: c.id, contactName: 'Grandma', displayName: "Maya's Dot Dash", state: 'open' });

    // --- first device claims it; the link is then locked to that device
    r = await t.chat('POST', 'claim', { body: { token } });
    assert.equal(r.status, 200);
    let auth = `${token}.${r.body.claim}`;
    assert.equal((await t.chat('POST', 'claim', { body: { token } })).body.status, 'claimed-elsewhere');
    assert.equal((await t.chat('POST', 'open', { body: { token } })).body.state, 'claimed');
    assert.equal((await t.chat('GET', 'history', { auth: `${token}.${'y'.repeat(32)}` })).body.status, 'claimed-elsewhere');
    assert.equal((await t.chat('GET', 'history')).status, 401);
    await tick();
    const pres = () => t.client.published.filter((m) => m.topic === `doorbell/presence/${vh}`).at(-1)?.payload;
    assert.equal(pres(), 'OFFLINE');   // virtual contacts never read as online

    // --- contact -> Dot Dash, cleaned for the device
    r = await t.chat('POST', 'send', { auth, body: { text: 'Hi, Maya! ❤️ see you Sunday' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.message.text, 'HI MAYA! SEE YOU SUNDAY');
    assert.equal(t.toDevice(maya).at(-1).payload, `MORSE,HI MAYA! SEE YOU SUNDAY,${c.virtualId}`);
    assert.equal((await t.chat('POST', 'send', { auth, body: { text: '😀' } })).body.message.text, '(EMOJI)');
    assert.equal((await t.chat('POST', 'send', { auth, body: { text: '   ' } })).status, 400);

    // --- push subscription
    assert.equal((await t.chat('POST', 'push', { auth, body: { subscription: { endpoint: 'http://insecure' } } })).status, 400);
    const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: 'P', auth: 'A' } };
    assert.equal((await t.chat('POST', 'push', { auth, body: { subscription: sub } })).status, 200);

    // --- Dot Dash -> contact: a waiting page is woken, and a push goes out
    const before = Date.now();
    const waiting = t.chat('GET', 'wait', { auth, query: `?after=${before}` });
    await tick();
    t.client.deliver(`doorbell/msg/${vh}/17000000000001`, `MORSE,LOVE YOU,${MAYA}`);
    r = await waiting;
    assert.deepEqual(r.body.messages.map((m) => [m.from, m.text]), [['dotdash', 'LOVE YOU']]);
    assert.equal(t.twilio.sent.length, 0, 'web contact went over SMS');
    assert.equal(t.webPush.sent.length, 1);
    assert.deepEqual(t.webPush.sent[0].payload.body, 'LOVE YOU');
    assert.deepEqual(t.webPush.sent[0].payload.title, "Maya's Dot Dash");
    assert.equal(t.webPush.sent[0].payload.chat, c.id);
    // only the paired Dot Dash can reach this contact
    t.client.deliver(`doorbell/msg/${vh}/17000000000002`, `TEXT,HI,${LEO}`);
    await tick();
    // a wait with nothing new returns empty after its timeout
    r = await t.chat('GET', 'wait', { auth, query: `?after=${Date.now()}` });
    assert.deepEqual(r.body.messages, []);

    // history holds both directions, in order
    r = await t.chat('GET', 'history', { auth });
    assert.deepEqual(r.body.messages.map((m) => m.from), ['contact', 'contact', 'dotdash']);

    // a dead push subscription is forgotten
    t.webPush.failNext = Object.assign(new Error('gone'), { statusCode: 410 });
    t.client.deliver(`doorbell/msg/${vh}/17000000000003`, `TEXT,STILL THERE?,${MAYA}`);
    await tick(); await tick();
    assert.equal(t.db.data.get(`artifacts/dd/smsPairings/${c.id}`).pushSub, null);

    // --- release: the holding device hands the link over (iPhone Safari -> Home
    // Screen app); the old claim stops working and a new device can claim it,
    // with the history still there
    assert.equal((await t.chat('POST', 'release', { auth })).body.status, 'released');
    assert.equal((await t.chat('GET', 'history', { auth })).body.status, 'claimed-elsewhere');
    assert.equal((await t.chat('POST', 'open', { body: { token } })).body.state, 'open');
    r = await t.chat('POST', 'claim', { body: { token } });
    assert.equal(r.status, 200);
    const oldAuth = auth;
    auth = `${token}.${r.body.claim}`;
    assert.notEqual(auth, oldAuth);
    assert.equal((await t.chat('GET', 'history', { auth })).body.messages.length, 4);   // 2 sent, LOVE YOU, STILL THERE?
    assert.equal((await t.chat('POST', 'release', { auth: `${token}.${'z'.repeat(32)}` })).status, 403);

    // --- the account holder sees it connected, and only they can issue a new link
    let list = (await t.api('GET', '/sms/contacts')).body.contacts;
    assert.equal(list[0].status, 'active');
    assert.equal((await t.api('POST', `/sms/contacts/${c.id}/link`, { tok: 'tok-u2' })).status, 404);

    // --- the contact leaves: link dead, history erased, shown as left
    assert.equal((await t.chat('POST', 'leave', { auth })).body.status, 'left');
    assert.equal((await t.chat('GET', 'history', { auth })).status, 410);
    assert.equal((await t.chat('POST', 'open', { body: { token } })).status, 410);
    assert.equal([...t.db.data.keys()].filter((k) => k.includes('/chat/')).length, 0);
    await tick();
    assert.equal(pres(), 'OFFLINE');
    list = (await t.api('GET', '/sms/contacts')).body.contacts;
    assert.equal(list[0].status, 'stopped');

    // --- a new link works, the old one never again; same contact ID on the Dot Dash
    r = await t.api('POST', `/sms/contacts/${c.id}/link`);
    assert.equal(r.status, 200);
    const token2 = r.body.link.split('/c/')[1];
    assert.notEqual(token2, token);
    assert.equal(r.body.contact.status, 'pending');
    assert.equal(r.body.contact.virtualId, c.virtualId);
    assert.equal((await t.chat('POST', 'claim', { body: { token } })).status, 410);
    assert.equal((await t.chat('POST', 'claim', { body: { token: token2 } })).status, 200);

    // --- deleting the contact removes everything
    assert.equal((await t.api('DELETE', `/sms/contacts/${c.id}`)).status, 200);
    assert.equal(t.pairingDocs().length, 0);
    assert.equal((await t.chat('POST', 'open', { body: { token: token2 } })).status, 410);
  } finally { t.close(); }
});

test('web link: a never-opened link and an old departure are swept; history is bounded', async () => {
  const t = await setup();
  try {
    await t.addDevice('u1', 'MAC1', MAYA, ['DAD1234']);
    const a = (await t.api('POST', '/sms/contacts', { body: { deviceId: 'MAC1', contactName: 'Nana', channel: 'web' } })).body;
    const b = (await t.api('POST', '/sms/contacts', { body: { deviceId: 'MAC1', contactName: 'Pop', channel: 'web' } })).body;
    // both are on the device's contact list, so only age matters below
    await t.db.doc('artifacts/dd/users/u1/devices/MAC1').update({ friends: ['DAD1234', a.contact.virtualId, b.contact.virtualId] });

    const tokB = b.link.split('/c/')[1];
    const auth = `${tokB}.${(await t.chat('POST', 'claim', { body: { token: tokB } })).body.claim}`;
    for (let i = 0; i < 55; i++) await t.svc.store.addChat(b.contact.id, { at: Date.now() + i, from: 'contact', text: `M${i}` });
    const h = (await t.chat('GET', 'history', { auth })).body.messages;
    assert.equal(h.length, 50);
    assert.equal(h.at(-1).text, 'M54');

    assert.equal((await t.svc.sweep()).removed, 0);
    // Nana's link was never opened, 15 days on
    t.db.data.get(`artifacts/dd/smsPairings/${a.contact.id}`).createdAt = { toMillis: () => Date.now() - 15 * 24 * 3600e3 };
    assert.equal((await t.svc.sweep()).removed, 1);
    assert.equal(t.pairingDocs().length, 1);
  } finally { t.close(); }
});

test('app contact mode: Firebase push, CORS for the app, dead tokens dropped', async () => {
  const t = await setup();
  try {
    await t.addDevice('u1', 'MAC1', MAYA);
    const add = (await t.api('POST', '/sms/contacts', { body: { deviceId: 'MAC1', contactName: 'Grandma', channel: 'web' } })).body;
    const token = add.link.split('/c/')[1];
    const vh = L.hashId(add.contact.virtualId);

    // The app calls from capacitor://localhost: preflight and the response both allow it.
    const pre = await fetch(`http://127.0.0.1:${t.port}/chat/api/claim`, { method: 'OPTIONS', headers: { Origin: 'capacitor://localhost', 'X-Forwarded-For': '9.9.9.9' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'capacitor://localhost');
    assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
    const evil = await fetch(`http://127.0.0.1:${t.port}/chat/api/config`, { headers: { Origin: 'https://evil.example', 'X-Forwarded-For': '9.9.9.9' } });
    assert.equal(evil.headers.get('access-control-allow-origin'), null);

    const claim = (await t.chat('POST', 'claim', { body: { token } })).body;
    assert.equal(claim.id, add.contact.id);
    const auth = `${token}.${claim.claim}`;
    assert.equal((await t.chat('POST', 'push', { auth, body: { fcmToken: 'short' } })).status, 400);
    assert.equal((await t.chat('POST', 'push', { auth, body: { fcmToken: 'f'.repeat(160) } })).status, 200);

    await tick();
    t.client.deliver(`doorbell/msg/${vh}/17000000000001`, `MORSE,HELLO,${MAYA}`);
    await tick(); await tick();
    assert.equal(t.fcm.sent.length, 1);
    assert.deepEqual(t.fcm.sent[0], { token: 'f'.repeat(160), title: "Maya's Dot Dash", body: 'HELLO', data: { kind: 'contact', chat: add.contact.id } });
    assert.equal(t.webPush.sent.length, 0);

    // A token the app no longer holds is forgotten.
    t.fcm.failNext = Object.assign(new Error('gone'), { code: 'messaging/registration-token-not-registered' });
    t.client.deliver(`doorbell/msg/${vh}/17000000000002`, `MORSE,STILL THERE,${MAYA}`);
    await tick(); await tick();
    assert.equal(t.db.data.get(`artifacts/dd/smsPairings/${add.contact.id}`).pushFcm, null);
  } finally { t.close(); }
});
