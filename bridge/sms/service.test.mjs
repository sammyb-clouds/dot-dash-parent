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
import { makeSandbox } from './sandbox.mjs';

const BASE = 'https://app.example.test';
const AUTH = 'twilio-auth-token';
const POOL1 = '+18005550100', POOL2 = '+18005550200';
const GRANDMA = '+14155552671', STRANGER = '+14155559999';
const MAYA = 'MAYA0515', LEO = 'LEO0101';
const tick = () => new Promise((r) => setTimeout(r, 5));

async function setup({ sandboxed = false } = {}) {
  const db = new FakeDB();
  const client = new FakeMqtt();
  const sandbox = sandboxed ? makeSandbox({ file: path.join(os.tmpdir(), `sms-sandbox-${crypto.randomBytes(4).toString('hex')}.json`) }) : null;
  const twilio = sandbox ? sandbox.twilio : new FakeTwilio();
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
    db, FieldValue, client, twilio, webPush, fcm, keys, sandbox,
    verifyIdToken: async (t) => ({ 'tok-u1': 'u1', 'tok-u2': 'u2' }[t] || null),
    config: {
      APP_ID: 'dd', PUBLIC_BASE: BASE, TWILIO_AUTH_TOKEN: AUTH, RETRY_MS: 1, WAIT_MS: 300,
      CHAT_BASE: 'https://dd.example.test', VAPID_PUBLIC_KEY: 'BPUBKEY',
      STATE_PATH: path.join(os.tmpdir(), `sms-state-${crypto.randomBytes(4).toString('hex')}.json`),
      APP_ORIGINS: new Set(['https://app.example.test', 'capacitor://localhost']),
      SANDBOX_KEY: sandboxed ? 'k'.repeat(32) : null,
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

  const sb = async (method, route, { key = 'k'.repeat(32), body, query = '' } = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}/chat/api/sandbox/${route}${query}`, {
      method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '9.9.9.9', 'X-Sandbox-Key': key },
      body: body && JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };

  return { sb, db, client, twilio, webPush, fcm, svc, port, logs, addDevice, addPool, api, sms, chat, toDevice, pairingDocs, close: () => { svc.server.closeAllConnections?.(); svc.server.close(); } };
}

test('phone (SMS relay) contacts are retired', async () => {
  const t = await setup();
  try {
    await t.addPool(POOL1);
    await t.addDevice('u1', 'MAC1', MAYA);
    // Twilio does not allow relaying what people write over toll-free SMS.
    const r = await t.api('POST', '/sms/contacts', { body: { deviceId: 'MAC1', phone: GRANDMA, contactName: 'Grandma' } });
    assert.deepEqual([r.status, r.body.status], [410, 'retired']);
    assert.equal(t.pairingDocs().length, 0);
    // A stranger texting the pool number reaches no Dot Dash and gets no reply.
    const s = await t.sms(STRANGER, POOL1, 'hey kid');
    assert.doesNotMatch(s.text, /Message/);
    assert.equal(t.client.published.filter((m) => m.topic.startsWith('doorbell/msg/') && m.payload).length, 0);
    assert.equal((await t.sms(STRANGER, POOL1, 'hi', { badSig: '1' })).status, 403);
  } finally { t.close(); }
});

test('SMS notifications: consent on the chat page, setup message, one per unread stretch, no content, STOP/START, off', async () => {
  const t = await setup();
  try {
    await t.addPool(POOL1);
    await t.addDevice('u1', 'MAC1', MAYA);
    const add = await t.api('POST', '/sms/contacts', { body: { deviceId: 'MAC1', contactName: 'Grandma', channel: 'web' } });
    const c = add.body.contact, token = add.body.link.split('/c/')[1], vh = L.hashId(c.virtualId);
    const auth = `${token}.${(await t.chat('POST', 'claim', { body: { token } })).body.claim}`;
    const doc = () => t.db.data.get(`artifacts/dd/smsPairings/${c.id}`);
    await tick();

    // Not asked yet: the page shows the opt-in screen.
    let r = await t.chat('GET', 'history', { auth });
    assert.deepEqual(r.body.notify, { asked: false, status: null, hint: null });
    // `open` (no claim needed) says nothing about notifications.
    assert.equal((await t.chat('POST', 'open', { body: { token } })).body.notify, undefined);

    // Consent is required, and must be the contact's own explicit tick.
    assert.equal((await t.chat('POST', 'notify', { auth, body: { phone: GRANDMA } })).body.status, 'consent-required');
    assert.equal((await t.chat('POST', 'notify', { auth, body: { phone: '555-1234', consent: true } })).body.status, 'invalid-number');
    assert.equal((await t.chat('POST', 'notify', { auth, body: { phone: POOL1, consent: true } })).body.status, 'invalid-number');
    assert.equal(t.twilio.sent.length, 0);

    // On: one setup message, the first thing this number ever gets from us.
    r = await t.chat('POST', 'notify', { auth, body: { phone: '(415) 555-2671', consent: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.notify, { asked: true, status: 'active', hint: '•••• 2671' });
    assert.equal(t.twilio.sent.length, 1);
    assert.deepEqual([t.twilio.sent[0].from, t.twilio.sent[0].to], [POOL1, GRANDMA]);
    assert.match(t.twilio.sent[0].body, /^Dot Dash: SMS notifications are on\. .*Maya's Dot Dash: https:\/\/dd\.example\.test\/c\/ Msg frequency varies\. Msg & data rates may apply\. Reply HELP for help, STOP to cancel\.$/);
    assert.ok(!JSON.stringify([...t.db.data]).includes('4155552671'), 'plaintext number stored');

    // A message from the Dot Dash: one notification, with NO message content.
    t.client.deliver(`doorbell/msg/${vh}/17000000000001`, `MORSE,SEE YOU SUNDAY,${MAYA}`);
    await tick(); await tick();
    assert.equal(t.twilio.sent.length, 2);
    assert.equal(t.twilio.sent[1].body, `Dot Dash: you have a new message from Maya's Dot Dash. Open it here: https://dd.example.test/c/#chat=${c.id} Reply STOP to cancel.`);
    assert.doesNotMatch(t.twilio.sent[1].body, /SUNDAY/);

    // More messages before they come back: no more notifications.
    t.client.deliver(`doorbell/msg/${vh}/17000000000002`, `MORSE,AND MONDAY,${MAYA}`);
    await tick(); await tick();
    assert.equal(t.twilio.sent.length, 2);

    // They come back (history re-arms it), but within the 1-minute gap: still none.
    await t.chat('GET', 'history', { auth });
    t.client.deliver(`doorbell/msg/${vh}/17000000000003`, `MORSE,HELLO,${MAYA}`);
    await tick(); await tick();
    assert.equal(t.twilio.sent.length, 2);
    // ...and after the gap: the next message notifies again.
    doc().notifySentAt = Date.now() - 2 * 60e3;
    await t.chat('GET', 'history', { auth });
    t.client.deliver(`doorbell/msg/${vh}/17000000000004`, `MORSE,HELLO AGAIN,${MAYA}`);
    await tick(); await tick();
    assert.equal(t.twilio.sent.length, 3);

    // Replying by SMS reaches no Dot Dash; they're told once a day where to go.
    const before = t.client.published.length;
    r = await t.sms(GRANDMA, POOL1, 'Love you!');
    assert.match(r.text, /only sends notifications.*https:\/\/dd\.example\.test\/c\//);
    assert.doesNotMatch((await t.sms(GRANDMA, POOL1, 'hello?')).text, /Message/);
    assert.equal(t.client.published.slice(before).filter((m) => m.topic.startsWith('doorbell/msg/') && m.payload).length, 0);

    // STOP: no more notifications. START: back on (only because they opted in before).
    await t.sms(GRANDMA, POOL1, 'STOP');
    assert.equal(doc().notifyStatus, 'stopped');
    doc().notifySentAt = 0;
    t.client.deliver(`doorbell/msg/${vh}/17000000000005`, `MORSE,ARE YOU THERE,${MAYA}`);
    await tick(); await tick();
    assert.equal(t.twilio.sent.length, 3);
    assert.equal((await t.chat('GET', 'history', { auth })).body.notify.status, 'stopped');
    await t.sms(GRANDMA, POOL1, 'START');
    assert.equal(doc().notifyStatus, 'active');
    // START from a number that never opted in signs it up to nothing.
    await t.sms(STRANGER, POOL1, 'START');
    assert.equal([...t.db.data.values()].filter((v) => v && v.notifyStatus === 'active').length, 1);

    // Setup is capped per chat, so a link can't be used to message strangers.
    for (let i = 0; i < 2; i++) await t.chat('POST', 'notify', { auth, body: { phone: GRANDMA, consent: true } });
    assert.equal((await t.chat('POST', 'notify', { auth, body: { phone: GRANDMA, consent: true } })).status, 429);

    // The chat open in front of them (a page waiting): no SMS for it.
    doc().notifySentAt = 0;
    const open = t.chat('GET', 'wait', { auth, query: `?after=${Date.now()}&v=1` });
    await tick();
    const n = t.twilio.sent.length;
    t.client.deliver(`doorbell/msg/${vh}/17000000000010`, `MORSE,WATCHING,${MAYA}`);
    await open; await tick();
    assert.equal(t.twilio.sent.length, n);


    // Off: the number is deleted.
    r = await t.chat('DELETE', 'notify', { auth });
    assert.deepEqual(r.body.notify, { asked: true, status: null, hint: null });
    assert.equal(doc().notifyEnc, null);
    const sentNow = t.twilio.sent.length;
    t.client.deliver(`doorbell/msg/${vh}/17000000000006`, `MORSE,BYE,${MAYA}`);
    await tick(); await tick();
    assert.equal(t.twilio.sent.length, sentNow);
  } finally { t.close(); }
});

test('SMS notifications: "not now", a number that STOPped us before, a bad number, and leaving', async () => {
  const t = await setup();
  try {
    await t.addPool(POOL1);
    await t.addDevice('u1', 'MAC1', MAYA);
    const join = async (name) => {
      const add = await t.api('POST', '/sms/contacts', { body: { deviceId: 'MAC1', contactName: name, channel: 'web' } });
      const token = add.body.link.split('/c/')[1];
      return { c: add.body.contact, auth: `${token}.${(await t.chat('POST', 'claim', { body: { token } })).body.claim}` };
    };

    // "Not now" is remembered, so the opt-in screen isn't shown again.
    const a = await join('Pop');
    assert.deepEqual((await t.chat('POST', 'notify', { auth: a.auth, body: { skip: true } })).body.notify, { asked: true, status: null, hint: null });
    assert.equal((await t.chat('GET', 'history', { auth: a.auth })).body.notify.asked, true);
    assert.equal(t.twilio.sent.length, 0);

    // This phone sent STOP to us before: kept, but stopped until it sends START.
    t.twilio.failNext = new TwilioError(400, { code: 21610, message: 'unsubscribed' });
    let r = await t.chat('POST', 'notify', { auth: a.auth, body: { phone: '+14155550001', consent: true } });
    assert.equal(r.body.notify.status, 'stopped');
    assert.equal(r.body.from, POOL1);

    // Twilio says the number can't receive SMS: nothing kept.
    const b = await join('Nana');
    t.twilio.failNext = new TwilioError(400, { code: 21211, message: 'invalid To' });
    r = await t.chat('POST', 'notify', { auth: b.auth, body: { phone: '+14155550002', consent: true } });
    assert.equal(r.body.status, 'invalid-number');
    assert.equal(t.db.data.get(`artifacts/dd/smsPairings/${b.c.id}`).notifyEnc, null);

    // A page that was waiting and went away (closed, or its wait timed out)
    // must not leave the chat looking watched: the next message notifies.
    const d = await join('Aunt');
    await t.chat('POST', 'notify', { auth: d.auth, body: { phone: '+14155550004', consent: true } });
    const vhD = L.hashId(d.c.virtualId);
    await tick();
    const before = t.twilio.sent.length;
    const open = t.chat('GET', 'wait', { auth: d.auth, query: `?after=${Date.now()}&v=1` });
    await tick();
    t.client.deliver(`doorbell/msg/${vhD}/17000000000020`, `MORSE,WATCHING,${MAYA}`);
    await open; await tick();
    assert.equal(t.twilio.sent.length, before, 'notified while the chat was open');
    await t.chat('GET', 'wait', { auth: d.auth, query: `?after=${Date.now() + 60e3}` });   // times out, then nobody waits
    t.db.data.get(`artifacts/dd/smsPairings/${d.c.id}`).notifySentAt = 0;
    t.client.deliver(`doorbell/msg/${vhD}/17000000000021`, `MORSE,NOBODY LOOKING,${MAYA}`);
    await tick(); await tick();
    assert.equal(t.twilio.sent.length, before + 1, 'a closed page left the chat looking watched');

    // A background tab (still polling, but not on screen: v=0) doesn't count as
    // looking at the chat, and doesn't re-arm the next notification either.
    const bg = t.chat('GET', 'wait', { auth: d.auth, query: `?after=${Date.now() + 60e3}&v=0` });
    await tick();
    t.db.data.get(`artifacts/dd/smsPairings/${d.c.id}`).notifySentAt = 0;
    t.client.deliver(`doorbell/msg/${vhD}/17000000000022`, `MORSE,IN THE BACKGROUND,${MAYA}`);
    await tick(); await tick();
    assert.equal(t.twilio.sent.length, before + 2, 'a background tab held back the notification');
    await bg;
    const sentAt = t.db.data.get(`artifacts/dd/smsPairings/${d.c.id}`).notifySentAt;
    await t.chat('GET', 'wait', { auth: d.auth, query: `?after=${Date.now() + 60e3}&v=0` });
    assert.ok(!(t.db.data.get(`artifacts/dd/smsPairings/${d.c.id}`).notifySeenAt >= sentAt), 'a background tab re-armed notifications');

    // Leaving the chat deletes the notification number too.
    await t.chat('POST', 'notify', { auth: b.auth, body: { phone: '+14155550003', consent: true } });
    assert.ok(t.db.data.get(`artifacts/dd/smsPairings/${b.c.id}`).notifyEnc);
    await t.chat('POST', 'leave', { auth: b.auth });
    assert.equal(t.db.data.get(`artifacts/dd/smsPairings/${b.c.id}`).notifyEnc, null);
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

test('SMS sandbox: captured instead of sent, replies simulated like Twilio, key-protected', async () => {
  const t = await setup({ sandboxed: true });
  try {
    await t.addPool(POOL1);
    await t.addDevice('u1', 'MAC1', MAYA);
    const add = await t.api('POST', '/sms/contacts', { body: { deviceId: 'MAC1', contactName: 'Grandma', channel: 'web' } });
    const c = add.body.contact, token = add.body.link.split('/c/')[1], vh = L.hashId(c.virtualId);
    const auth = `${token}.${(await t.chat('POST', 'claim', { body: { token } })).body.claim}`;
    await tick();

    // The page still isn't offered SMS (sandbox is not live) -- testers use ?sms=1.
    assert.equal((await t.chat('GET', 'config')).body.sms, false);
    // The sandbox API needs its key.
    assert.equal((await t.sb('GET', 'numbers', { key: 'wrong' })).status, 403);
    assert.equal((await t.sb('GET', 'numbers', { key: '' })).status, 403);

    // Sign-up: the setup message lands in the sandbox thread, nothing is sent.
    await t.chat('POST', 'notify', { auth, body: { phone: GRANDMA, consent: true } });
    let th = (await t.sb('GET', 'thread', { query: `?number=${encodeURIComponent(GRANDMA)}` })).body;
    assert.equal(th.from, POOL1);
    assert.deepEqual(th.messages.map((m) => m.dir), ['out']);
    assert.match(th.messages[0].body, /SMS notifications are on/);
    assert.deepEqual((await t.sb('GET', 'numbers')).body.numbers.map((n) => n.number), [GRANDMA]);

    // A message from the Dot Dash: a notification, captured.
    t.client.deliver(`doorbell/msg/${vh}/17000000000001`, `MORSE,HI GRANDMA,${MAYA}`);
    await tick(); await tick();
    th = (await t.sb('GET', 'thread', { query: `?number=${encodeURIComponent(GRANDMA)}` })).body;
    assert.match(th.messages.at(-1).body, /you have a new message from Maya's Dot Dash/);

    // Replying: the bridge's "notifications only" answer comes back, and nothing reaches the Dot Dash.
    th = (await t.sb('POST', 'reply', { body: { number: GRANDMA, body: 'Love you!' } })).body;
    assert.deepEqual(th.messages.slice(-2).map((m) => [m.dir, m.body.slice(0, 40)]), [['in', 'Love you!'], ['out', "Dot Dash: this number only sends notific"]]);
    assert.equal(t.toDevice(L.hashId(MAYA)).length, 0);

    // HELP: the Messaging Service's HELP reply.
    th = (await t.sb('POST', 'reply', { body: { number: GRANDMA, body: 'help' } })).body;
    assert.match(th.messages.at(-1).body, /^Dot Dash: SMS notifications that a new message is waiting/);

    // STOP: Twilio's confirmation, the chat is marked stopped, and sending fails like Twilio's 21610.
    th = (await t.sb('POST', 'reply', { body: { number: GRANDMA, body: 'STOP' } })).body;
    assert.equal(th.stopped, true);
    assert.match(th.messages.at(-1).body, /successfully been unsubscribed/);
    assert.equal(t.db.data.get(`artifacts/dd/smsPairings/${c.id}`).notifyStatus, 'stopped');
    await assert.rejects(t.twilio.send({ from: POOL1, to: GRANDMA, body: 'x' }), (e) => e.code === 21610);

    // START: resubscribed, and the chat is active again.
    th = (await t.sb('POST', 'reply', { body: { number: GRANDMA, body: 'START' } })).body;
    assert.equal(th.stopped, false);
    assert.match(th.messages.at(-1).body, /re-subscribed/);
    assert.equal(t.db.data.get(`artifacts/dd/smsPairings/${c.id}`).notifyStatus, 'active');

    // The account holder sees how the contact is notified, never the number.
    const list = (await t.api('GET', '/sms/contacts')).body.contacts;
    assert.equal(list[0].notifyBy, 'sms');
    assert.ok(!JSON.stringify(list).includes('2671'));

    // Reset clears a number's sandbox thread and opt-out, to test a first sign-up again.
    th = (await t.sb('POST', 'reset', { query: `?number=${encodeURIComponent(GRANDMA)}` })).body;
    assert.deepEqual([th.messages.length, th.stopped], [0, false]);
  } finally { t.close(); }
});

test('without the sandbox, its API does not exist', async () => {
  const t = await setup();
  try { assert.equal((await t.sb('GET', 'numbers')).status, 404); } finally { t.close(); }
});
