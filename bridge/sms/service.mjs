/**
 * The SMS bridge's behaviour, with every outside dependency passed in: the
 * Firestore handle, the MQTT client, Twilio and the token verifier. sms.mjs
 * wires the real ones; service.test.mjs drives this with in-memory fakes.
 * See ../sms.mjs for what the bridge is and sms/README.md for the design.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';
import { makeStore, StoreError } from './store.mjs';
import { OPTED_OUT, BAD_NUMBER } from './twilio.mjs';

const HOUR = 3600e3, DAY = 24 * HOUR;
const MAX_FRIENDS = 10;                     // the firmware's friendList[10]; main.jsx MAX_FRIENDS
const PENDING_TTL_MS = 14 * DAY;            // a link nobody ever opens is deleted
const NOTIFY_GAP_MS = 10 * 60e3;            // never two SMS notifications for one chat closer than this
const short = (s) => String(s).slice(0, 8);

// webPush.send(subscription, payloadString) delivers a browser push to a web
// contact; it rejects with err.statusCode 404/410 when the subscription is dead.
// fcm.send({ token, title, body, data }) notifies a contact using the iOS app's
// contact mode; it rejects with err.code 'messaging/registration-token-not-registered'
// (or invalid-registration-token) when the token is dead.
// sandbox: a makeSandbox() (sandbox.mjs) when SMS_SANDBOX=1 -- `twilio` is then
// its stand-in, and /chat/api/sandbox/ serves the sandbox phone page.
export function createService({ db, FieldValue, client, twilio, webPush, fcm, verifyIdToken, keys, config, log, sandbox = null }) {
  const { APP_ID, PUBLIC_BASE, STATE_PATH, APP_ORIGINS, TWILIO_AUTH_TOKEN } = config;
  // Where a web contact's link points: <CHAT_BASE>/c/<token>.
  const CHAT_BASE = (config.CHAT_BASE || 'https://dotdashdevice.com').replace(/\/$/, '');
  const linkFor = (token) => `${CHAT_BASE}/c/${token}`;
  const store = makeStore(db, APP_ID, keys, { FieldValue });

  // ------------------------------------------------------------------- texts --
  // SMS is NOTIFICATION ONLY (2026-10-09, after Twilio support): it tells a web
  // contact that a message is waiting and links to the chat page. It never
  // carries what anyone wrote -- that would be person-to-person traffic, which
  // toll-free does not allow -- and nothing is ever sent to a number before its
  // owner typed it into the chat page's opt-in form and ticked the consent box
  // (chatApi, route 'notify'). The setup confirmation is the first thing a
  // number ever receives from us, so it carries what carriers require: the
  // program name, frequency, rates, HELP and STOP.
  const chatHome = () => `${CHAT_BASE}/c/`;
  const T = {
    setup: (p) => `Dot Dash: SMS notifications are on. We'll send one here when you have a new message from ${p.displayName}: ${chatHome()} Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to cancel.`,
    notify: (p) => `Dot Dash: you have a new message from ${p.displayName}. Open it here: ${chatHome()}#chat=${p.id} Reply STOP to cancel.`,
    replyInfo: `Dot Dash: this number only sends notifications, so replies here aren't delivered. Open your chats at ${chatHome()} Reply STOP to cancel.`,
  };

  // ------------------------------------------------------------- rate limits --
  // Cost and abuse caps, not pacing -- Twilio queues past a number's throughput
  // by itself. In memory; a restart forgives.
  const limits = {
    out: new L.Limiter([{ ms: 60e3, max: 6 }, { ms: HOUR, max: 40 }, { ms: DAY, max: 150 }]),     // per pairing, child -> phone
    in: new L.Limiter([{ ms: 60e3, max: 5 }, { ms: HOUR, max: 30 }, { ms: DAY, max: 200 }]),      // per pairing, phone -> child
    replyInfo: new L.Limiter([{ ms: DAY, max: 1 }]),                                             // "replies aren't delivered", per number
    // SMS notifications. Setup sends one message to a number someone typed in,
    // so it is capped per chat and per number: a link holder cannot use it to
    // message a stranger more than a couple of times.
    notifySetup: new L.Limiter([{ ms: DAY, max: 3 }]),                                           // per chat
    notifyNumber: new L.Limiter([{ ms: DAY, max: 3 }, { ms: 30 * DAY, max: 10 }]),               // per number
    notifyOut: new L.Limiter([{ ms: DAY, max: 24 }]),                                            // per chat, on top of NOTIFY_GAP_MS
    addByParent: new L.Limiter([{ ms: DAY, max: 10 }]),
    // Opening and claiming links, per address: a token cannot be guessed, but
    // nothing should be able to try many quickly either.
    linkOpen: new L.Limiter([{ ms: 60e3, max: 20 }, { ms: HOUR, max: 120 }]),
  };

  // ------------------------------------------------------------ replay guard --
  // Device messages are retained. This process clears each one after handling
  // it, but a clear can fail, and the broker redelivers everything retained on
  // every reconnect -- which would text grandma the same message again. The
  // firmware's stamps make each topic unique, so the topic itself is the key.
  const seen = (() => {
    let data = {};
    try { data = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { /* first run */ }
    const save = () => {
      try {
        const cutoff = Date.now() - 30 * DAY;
        for (const [k, t] of Object.entries(data)) if (t < cutoff) delete data[k];
        fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
        fs.writeFileSync(`${STATE_PATH}.tmp`, JSON.stringify(data));
        fs.renameSync(`${STATE_PATH}.tmp`, STATE_PATH);   // atomic
      } catch (e) { log('ERROR', `replay guard: could not persist (${e.message})`); }
    };
    return {
      has: (k) => k in data,
      add: (k) => { data[k] = Date.now(); save(); },
    };
  })();

  // ------------------------------------------------------------------- mqtt --
  const byVhash = new Map();      // virtual friend hash -> pairing
  const presence = new Map();     // virtual friend hash -> last presence published

  // A virtual friend is ALWAYS reported OFFLINE (active, pending or stopped
  // alike). ONLINE makes the device flash its online dot permanently for every
  // phone or web-link contact, which is disruptive; the cost is that sending
  // reads "SENT! (Offline)". OFFLINE is published retained rather than clearing
  // the topic because the firmware ignores zero-length payloads: an empty
  // publish would leave a device that already saw ONLINE showing it until it
  // reconnects, whereas OFFLINE is delivered and applied immediately.
  const VIRTUAL_PRESENCE = 'OFFLINE';
  function publishPresence(vh, value) {
    if (presence.get(vh) === value) return;
    presence.set(vh, value);
    client.publish(`doorbell/presence/${vh}`, value, { qos: 1, retain: true });
  }

  function applyPairings(docs) {
    const next = new Map(docs.map((d) => [d.virtualHash, d]));
    for (const vh of byVhash.keys()) {
      if (!next.has(vh)) {
        client.unsubscribe(`doorbell/msg/${vh}/#`);
        publishPresence(vh, '');   // removed: clear the retained presence
        presence.delete(vh);
      }
    }
    for (const [vh, p] of next) {
      if (!byVhash.has(vh)) client.subscribe(`doorbell/msg/${vh}/#`, { qos: 1 });
      publishPresence(vh, VIRTUAL_PRESENCE);
    }
    byVhash.clear();
    for (const [k, v] of next) byVhash.set(k, v);
  }

  client.on('connect', () => {
    log('INFO', 'mqtt connected');
    presence.clear();   // retained presence may have been lost with the broker; publish it all again
    applyPairings([...byVhash.values()]);
  });
  client.on('error', (e) => log('WARN', 'mqtt:', e.message));

  client.on('message', (topic, buf) => onMessage(topic, buf).catch((e) => log('ERROR', `device message failed: ${e.message}`)));

  async function onMessage(topic, buf) {
    const vh = topic.split('/')[2];
    const pairing = byVhash.get(vh);
    const payload = buf.toString();
    if (!pairing || !payload) return;   // empty = a clear, ours or someone's

    // Take it off the broker whatever happens next: it has been received.
    client.publish(topic, '', { qos: 1, retain: true });
    if (seen.has(topic)) return;
    seen.add(topic);

    // Game traffic is released above and goes no further. Checked before parsing
    // so it is dropped silently rather than logged as an unparseable message.
    if (L.isGameTraffic(payload.slice(0, payload.indexOf(',')))) return;

    const msg = L.parseDeviceMessage(payload);
    const tag = `pairing ${short(pairing.id)}`;
    if (!msg) return log('WARN', `${tag}: unparseable device message dropped`);

    // Only the paired child may text this contact. Another device that has this
    // virtual ID in its friend list (a parent could add it) is refused. NOTE:
    // until the shared device password is retired, anyone holding it can forge
    // the sender field -- see README.md, "Known gaps".
    if (L.hashId(msg.sender) !== pairing.deviceHash) return log('WARN', `${tag}: sender is not the paired device -- dropped`);
    if (pairing.status !== 'active') return log('INFO', `${tag}: ${pairing.status}, not sending`);
    if (!limits.out.take(pairing.id)) return log('WARN', `${tag}: outbound rate limit -- dropped`);

    if (pairing.channel === 'web') return deliverToWeb(pairing, msg);
    // An SMS-relay contact (retired 2026-10-09): relaying what people write over
    // SMS is person-to-person traffic, which toll-free does not allow.
    log('INFO', `${tag}: SMS relay is retired -- message not sent`);
  }

  // ------------------------------------------------------------ web contacts --
  // Dot Dash -> web contact: kept in the short history (the page may be shut),
  // handed to any page waiting on it, and pushed to their device.
  const waiters = new Map();   // pairing id -> Set of wake functions

  function wake(id) {
    const set = waiters.get(id);
    if (!set) return;
    waiters.delete(id);
    for (const fn of set) fn();
  }

  async function deliverToWeb(pairing, msg) {
    const text = msg.type === 'PULSE' ? '(buzz!)' : String(msg.text || '').trim().slice(0, 320);
    if (!text) return;
    const entry = { at: Date.now(), from: 'dotdash', text };
    await store.addChat(pairing.id, entry);
    // A page waiting right now AND on screen means they're looking at the chat:
    // no SMS. A background tab (still polling) doesn't count.
    const watching = [...(waiters.get(pairing.id) || [])].some((fn) => fn.visible);
    wake(pairing.id);
    log('INFO', `pairing ${short(pairing.id)}: message to web contact (${text.length} chars)`);
    await pushTo(pairing, text);
    if (watching) log('INFO', `pairing ${short(pairing.id)}: chat is open on screen -- no SMS notification`);
    else await maybeNotify(pairing.id);
  }

  // One SMS per unread stretch: sent when a message arrives and the contact has
  // been back to the chat since the last notification (or there was none), and
  // never closer than NOTIFY_GAP_MS. Says THAT a message is waiting, never what
  // it says.
  async function maybeNotify(id) {
    const p = await store.getPairing(id);
    if (!p || p.notifyStatus !== 'active' || !p.notifyEnc) return;
    const now = Date.now();
    const sent = p.notifySentAt || 0;
    const tag = `pairing ${short(id)}`;
    if (sent && (p.notifySeenAt || 0) < sent) return log('INFO', `${tag}: no SMS notification -- the last one hasn't been looked at yet`);
    if (now - sent < NOTIFY_GAP_MS) return log('INFO', `${tag}: no SMS notification -- one went out under 10 minutes ago`);
    if (!limits.notifyOut.take(id)) return log('WARN', `pairing ${short(id)}: SMS notification cap reached`);
    await store.updatePairing(id, { notifySentAt: now });
    await sendSms({ id, to: notifyNumber(p), from: p.notifyFrom, body: T.notify(p), what: 'notification',
      onOptOut: () => store.updatePairing(id, { notifyStatus: 'stopped' }) });
  }

  const notifyNumber = (p) => L.decrypt(keys, p.notifyEnc, p.notifyKey);

  // The number SMS notifications come from: NOTIFY_FROM if set, else the
  // oldest active pool number.
  async function notifyFrom() {
    if (config.NOTIFY_FROM) return config.NOTIFY_FROM;
    const pools = (await store.listPools()).filter((x) => x.active);
    pools.sort((a, b) => (a.addedAt?.toMillis?.() || 0) - (b.addedAt?.toMillis?.() || 0));
    return pools[0]?.number || null;
  }

  async function pushTo(pairing, text) {
    const fresh = await store.getPairing(pairing.id);
    if (fresh?.pushFcm && fcm) {
      try {
        await fcm.send({ token: fresh.pushFcm, title: pairing.displayName, body: text, data: { kind: 'contact', chat: pairing.id } });
      } catch (e) {
        if (/registration-token-not-registered|invalid-registration-token/.test(e.code || '')) {
          await store.updatePairing(pairing.id, { pushFcm: null }).catch(() => {});
          log('INFO', `pairing ${short(pairing.id)}: app push token gone -- removed`);
        } else {
          log('WARN', `pairing ${short(pairing.id)}: app push failed (${e.code || e.message})`);
        }
      }
      return;
    }
    const sub = fresh?.pushSub;
    if (!sub || !webPush) return;
    try {
      // `chat` lets the page open THIS conversation when the notification is
      // tapped, when one device holds several.
      await webPush.send(sub, JSON.stringify({ title: pairing.displayName, body: text, tag: pairing.id, chat: pairing.id }));
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        // The browser threw the subscription away (site data cleared, app
        // removed from the Home Screen). Forget it rather than keep failing.
        await store.updatePairing(pairing.id, { pushSub: null }).catch(() => {});
        log('INFO', `pairing ${short(pairing.id)}: push subscription gone -- removed`);
      } else {
        log('WARN', `pairing ${short(pairing.id)}: push failed (${e.statusCode || e.message})`);
      }
    }
  }

  async function sendSms({ id, to, from, body, what, onOptOut }) {
    const tag = `pairing ${short(id)}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await twilio.send({ from, to, body });
        log('INFO', `${tag}: ${what} sent to ${L.maskNumber(to)} (${body.length} chars, ${r.sid})`);
        return { ok: true };
      } catch (e) {
        if (e.code === OPTED_OUT) {
          log('INFO', `${tag}: recipient has opted out -- marking stopped`);
          await Promise.resolve(onOptOut?.()).catch(() => {});
          return { ok: false, reason: 'opted-out' };
        }
        if (BAD_NUMBER.has(e.code)) {
          log('WARN', `${tag}: ${what} refused, bad number (${e.code})`);
          return { ok: false, reason: 'bad-number' };
        }
        const transient = !e.status || e.status === 429 || e.status >= 500;
        log('WARN', `${tag}: ${what} failed (${e.message})${transient && attempt < 2 ? ', retrying' : ''}`);
        if (!transient) return { ok: false, reason: 'error' };
        await new Promise((r) => setTimeout(r, (config.RETRY_MS ?? 2000) * 2 ** attempt));
      }
    }
    return { ok: false, reason: 'error' };
  }

  // Contact -> Dot Dash. One SMS, or one message from the chat page, is one
  // device message; see lib.toDeviceText.
  //
  // Sent as MORSE, exactly as the app sends a message to a Dot Dash
  // (ChatView.handleSend in main.jsx): the device then plays it in Morse when
  // Dot Dash Mode is on, and shows it whole when it is off. TEXT is what a
  // device sends for a quick-message phrase, and is only ever shown.
  function deliverToDevice(pairing, text) {
    const topic = `doorbell/msg/${pairing.deviceHash}/${L.msgStamp()}`;
    // Retained and QoS 1, like every device-to-device message: a Dot Dash that
    // is off gets it when it next connects, and the device clears it.
    client.publish(topic, `MORSE,${text},${pairing.virtualId}`, { qos: 1, retain: true });
  }

  // ------------------------------------------------------------ Firestore watch --
  // Bounded by the number of pairings in the whole product, which is small; and
  // it keeps the MQTT subscriptions exactly in step with what exists.
  store.pairings.onSnapshot(
    (snap) => applyPairings(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (e) => log('ERROR', `pairings watch failed: ${e.message}`),
  );

  // ----------------------------------------------------------------- inbound --
  const recentSids = new Map();   // Twilio retries a webhook that times out; do not deliver twice

  async function inbound(params) {
    const from = L.toE164(params.From), to = L.toE164(params.To);
    if (!from || !to) return L.twiml();

    if (params.MessageSid) {
      const now = Date.now();
      for (const [k, t] of recentSids) if (now - t > HOUR) recentSids.delete(k);
      if (recentSids.has(params.MessageSid)) return L.twiml();
      recentSids.set(params.MessageSid, now);
    }

    // Everyone who texts us is (or was) a notification subscriber: one number
    // may hold several chats. Keywords apply to all of that number's chats on
    // this pool number. Nothing anyone texts reaches a Dot Dash.
    const kw = L.keywordOf(params.Body, params.OptOutType);
    const ck = L.contactKey(keys, from);
    const subs = (await store.pairings.where('notifyKey', '==', ck).get()).docs
      .map((d) => ({ id: d.id, ...d.data() })).filter((p) => p.notifyFrom === to);

    if (kw === 'stop') {
      for (const p of subs) if (p.notifyStatus === 'active') await store.updatePairing(p.id, { notifyStatus: 'stopped' });
      log('INFO', `inbound STOP from ${L.maskNumber(from)}: ${subs.length} chat(s) stopped`);
      return L.twiml();   // Twilio confirms the opt-out itself
    }
    if (kw === 'start') {
      // Only numbers that opted in on a chat page before. START cannot sign a
      // number up to anything new.
      for (const p of subs) if (p.notifyStatus === 'stopped') await store.updatePairing(p.id, { notifyStatus: 'active' });
      log('INFO', `inbound START from ${L.maskNumber(from)}: ${subs.length} chat(s) resumed`);
      return L.twiml();
    }
    if (kw === 'help') return L.twiml();   // Twilio's HELP reply (set per Messaging Service)

    log('INFO', `inbound message from ${L.maskNumber(from)} -- notifications only, not delivered`);
    return subs.length && limits.replyInfo.take(ck) ? L.twiml(T.replyInfo) : L.twiml();
  }

  // ------------------------------------------------------------ parent API --
  const HTTP = (code, body) => Object.assign(new Error(body.status), { http: [code, body] });

  const view = (p) => ({
    id: p.id, deviceId: p.deviceDocId, virtualId: p.virtualId, contactName: p.contactName,
    displayName: p.displayName, channel: p.channel || 'sms',
    // How a link contact hears about new messages, for the account holder's
    // list. Never the number itself.
    notifyBy: p.notifyStatus === 'active' ? 'sms' : p.pushFcm ? 'app' : p.pushSub ? 'browser' : null,
    hint: p.contactHint || null, poolNumber: p.poolNumber || null, status: p.status,
  });

  // Names go into a text sent to someone else's phone, so nothing that could
  // make a link: letters, digits, spaces, apostrophes, hyphens and & only.
  const cleanLabel = (s, max) => String(s || '').normalize('NFC').replace(/[^\p{L}\p{N} '\u2019&-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, max);
  const titleCase = (s) => String(s || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

  async function addContact(uid, body) {
    // Phone (SMS relay) contacts are retired: Twilio's toll-free rules do not
    // allow relaying what people write. Phones are reached by web link, with
    // optional SMS notifications that the contact turns on themselves.
    if (body.channel !== 'web') throw HTTP(410, { status: 'retired' });
    const channel = 'web';
    const deviceId = String(body.deviceId || '');
    const e164 = channel === 'sms' ? L.toE164(body.phone) : null;
    const contactName = cleanLabel(body.contactName, 30);
    const vname = L.virtualName(contactName);
    if (!deviceId || deviceId.includes('/')) throw HTTP(400, { status: 'bad-request' });
    if (channel === 'sms' && !e164) throw HTTP(400, { status: 'invalid-number' });
    if (!vname) throw HTTP(400, { status: 'invalid-name' });

    const [dev, pools] = await Promise.all([
      db.doc(`artifacts/${APP_ID}/users/${uid}/devices/${deviceId}`).get(),
      channel === 'sms' ? store.listPools() : [],
    ]);
    if (pools.some((p) => p.number === e164)) throw HTTP(400, { status: 'invalid-number' });
    const d = dev.exists ? dev.data() : null;
    if (!d || !L.HASH_RE.test(d.hashedId || '')) throw HTTP(404, { status: 'no-device' });
    // A device record proves nothing on its own -- the parent writes it. The
    // identity record is the protected claim on the child's hash.
    const ident = await db.doc(`artifacts/${APP_ID}/public/data/identities/${d.hashedId}`).get();
    if (!ident.exists || ident.data().owner !== uid) throw HTTP(403, { status: 'not-owner' });
    if ((d.friends || []).length >= MAX_FRIENDS) throw HTTP(409, { status: 'friends-full' });

    // Checked now, charged only once the pairing really exists.
    if (!limits.addByParent.allows(uid)) throw HTTP(429, { status: 'slow-down' });

    const displayName = cleanLabel(body.displayName, 40) || `${titleCase(d.identity?.name) || 'Your'}'s Dot Dash`;

    if (channel === 'web') {
      const { pairing: p, token } = await store.createWebPairing({ uid, deviceDocId: deviceId, deviceHash: d.hashedId, contactName, displayName, vname });
      limits.addByParent.take(uid);
      log('INFO', `pairing ${short(p.id)} created by ${short(uid)} (web link)`);
      // The only time this link exists in plaintext anywhere but the contact's
      // device: the server keeps its hash.
      return [201, { contact: view(p), link: linkFor(token) }];
    }

    let p;
    try {
      p = await store.createPairing({ uid, deviceDocId: deviceId, deviceHash: d.hashedId, e164, contactName, displayName, vname });
    } catch (e) {
      if (e instanceof StoreError) {
        if (e.code === 'pool-exhausted') log('ERROR', `OPS: no pool number free for a contact of ${short(uid)} -- add a number (tools/smspool.mjs)`);
        throw HTTP(e.code === 'pool-exhausted' ? 503 : 409, { status: e.code });
      }
      throw e;
    }
    log('INFO', `pairing ${short(p.id)} created by ${short(uid)} on ${L.maskNumber(p.poolNumber)} for ${L.maskNumber(e164)}`);

    limits.addByParent.take(uid);
    // Nothing is sent. The parent is told to have the contact send START to
    // p.poolNumber; the pairing stays pending until they do.
    return [201, { contact: view(p), keyword: 'START' }];
  }

  // A new link for a web contact (lost, never opened, or the contact left).
  async function newLink(uid, id) {
    const p = await store.getPairing(id);
    if (!p || p.ownerUid !== uid) throw HTTP(404, { status: 'not-found' });
    if (p.channel !== 'web') throw HTTP(409, { status: 'not-a-link' });
    const token = await store.resetLink(id);
    log('INFO', `pairing ${short(id)}: new link issued by its account holder`);
    return [200, { contact: view(await store.getPairing(id)), link: linkFor(token) }];
  }

  // ------------------------------------------------------ web contact API --
  // No Firebase account: the link is the credential. "Authorization: Chat
  // <token>.<claim>", where the claim secret was handed to the one device that
  // connected first.
  async function chatAuth(req) {
    const m = /^Chat\s+([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{32})$/.exec(req.headers.authorization || '');
    if (!m) throw HTTP(401, { status: 'unauthenticated' });
    const p = await store.findByToken(m[1]);
    if (!p || p.channel !== 'web') throw HTTP(410, { status: 'gone' });
    if (p.claimHash !== L.secretHash(m[2])) throw HTTP(403, { status: 'claimed-elsewhere' });
    if (p.status !== 'active') throw HTTP(410, { status: 'gone' });
    return p;
  }

  // `id` names the chat to the page (inbox, notification routing). It is the
  // pairing's document id: not a credential, and useless without the link.
  const chatInfo = (p) => ({
    id: p.id, contactName: p.contactName, displayName: p.displayName,
    // SMS notifications: whether to show the opt-in screen, and their state.
    notify: { asked: !!p.notifyAsked, status: p.notifyStatus || null, hint: p.notifyHint || null },
  });

  async function chatApi(req, res, url, ip) {
    const route = url.pathname.slice('/chat/api/'.length);
    const json = async () => { try { return JSON.parse(await readBody(req, 4096)); } catch (e) { if (e.http) throw e; return {}; } };

    // sms: whether the chat page should offer SMS notifications. Off while the
    // bridge is in DRY_RUN, so nobody is promised a message that never comes.
    if (route === 'config' && req.method === 'GET') return [200, { vapidPublicKey: config.VAPID_PUBLIC_KEY || null, sms: !!config.SMS_LIVE, sandbox: !!sandbox }];

    if ((route === 'open' || route === 'claim') && req.method === 'POST') {
      if (!limits.linkOpen.take(ip)) throw HTTP(429, { status: 'slow-down' });
      const { token } = await json();
      if (!L.SECRET_RE.test(token || '')) throw HTTP(410, { status: 'gone' });
      const p = await store.findByToken(token);
      if (!p || p.channel !== 'web') throw HTTP(410, { status: 'gone' });
      // `open` needs no claim, so it says nothing about notifications (the
      // number's last digits are for the claimed device only).
      if (route === 'open') return [200, { id: p.id, contactName: p.contactName, displayName: p.displayName, state: p.claimHash ? 'claimed' : 'open' }];
      try {
        const claim = await store.claimLink(p.id);
        log('INFO', `pairing ${short(p.id)}: link claimed by its first device`);
        return [200, { ...chatInfo(p), claim }];
      } catch (e) {
        if (e instanceof StoreError) throw HTTP(e.code === 'gone' ? 410 : 409, { status: e.code });
        throw e;
      }
    }

    const p = await chatAuth(req);

    // Being back in the chat re-arms the next SMS notification (maybeNotify).
    // A wait counts only from a page on screen (v=1), not a background tab.
    // Written only when a notification is outstanding, not on every poll.
    const lookedAt = route === 'history' || route === 'send' || (route === 'wait' && url.searchParams.get('v') === '1');
    if (lookedAt && p.notifySentAt && (p.notifySeenAt || 0) < p.notifySentAt) {
      await store.updatePairing(p.id, { notifySeenAt: Date.now() });
    }

    if (route === 'history' && req.method === 'GET') return [200, { ...chatInfo(p), messages: await store.listChat(p.id) }];

    // SMS notifications, set up by the contact on the chat page. The number is
    // typed by its owner, with an explicit, unticked-by-default consent box;
    // the server refuses without it. {skip: true} records "not now" so the
    // opt-in screen is not shown again.
    if (route === 'notify' && req.method === 'POST') {
      const body = await json();
      if (body.skip) {
        await store.updatePairing(p.id, { notifyAsked: true });
        return [200, { notify: { asked: true, status: p.notifyStatus || null, hint: p.notifyHint || null } }];
      }
      if (body.consent !== true) throw HTTP(400, { status: 'consent-required' });
      const e164 = L.toE164(body.phone);
      if (!e164) throw HTTP(400, { status: 'invalid-number' });
      const from = await notifyFrom();
      if (!from || e164 === from) throw HTTP(e164 === from ? 400 : 503, { status: e164 === from ? 'invalid-number' : 'unavailable' });
      const ck = L.contactKey(keys, e164);
      if (!limits.notifySetup.allows(p.id) || !limits.notifyNumber.allows(ck)) throw HTTP(429, { status: 'slow-down' });
      limits.notifySetup.take(p.id); limits.notifyNumber.take(ck);
      await store.updatePairing(p.id, {
        notifyAsked: true, notifyStatus: 'active', notifyKey: ck, notifyEnc: L.encrypt(keys, e164, ck),
        notifyHint: L.numberHint(e164), notifyFrom: from, notifySentAt: null, notifySeenAt: null,
        notifyConsentAt: FieldValue.serverTimestamp(),
      });
      log('INFO', `pairing ${short(p.id)}: SMS notifications turned on by the contact for ${L.maskNumber(e164)}`);
      const r = await sendSms({ id: p.id, to: e164, from, body: T.setup(p), what: 'notification setup',
        onOptOut: () => store.updatePairing(p.id, { notifyStatus: 'stopped' }) });
      if (r.reason === 'bad-number') {
        await store.updatePairing(p.id, { notifyStatus: null, notifyKey: null, notifyEnc: null, notifyHint: null, notifyFrom: null });
        throw HTTP(400, { status: 'invalid-number' });
      }
      // 'stopped' here means this phone sent STOP to us before: it has to send
      // START (the page says so) before Twilio will deliver anything to it.
      return [200, { notify: { asked: true, status: r.reason === 'opted-out' ? 'stopped' : 'active', hint: L.numberHint(e164) }, from, sent: r.ok }];
    }
    if (route === 'notify' && req.method === 'DELETE') {
      await store.updatePairing(p.id, { notifyAsked: true, notifyStatus: null, notifyKey: null, notifyEnc: null, notifyHint: null, notifyFrom: null, notifySentAt: null, notifySeenAt: null });
      log('INFO', `pairing ${short(p.id)}: SMS notifications turned off by the contact (number deleted)`);
      return [200, { notify: { asked: true, status: null, hint: null } }];
    }

    // Long poll: answers at once if anything newer than ?after= exists, else
    // waits up to 25 seconds for a message to arrive. Simpler to run through
    // nginx than a stream, and a missed wake just costs one round trip.
    if (route === 'wait' && req.method === 'GET') {
      const after = Number(url.searchParams.get('after')) || 0;
      const newer = async () => (await store.listChat(p.id)).filter((m) => m.at > after);
      let msgs = await newer();
      if (!msgs.length) {
        await new Promise((resolve) => {
          // An emptied set is removed, or the chat would look watched forever.
          const done = () => {
            clearTimeout(t);
            const set = waiters.get(p.id);
            if (set) { set.delete(done); if (!set.size) waiters.delete(p.id); }
            resolve();
          };
          done.visible = url.searchParams.get('v') === '1';   // the page is on screen
          const t = setTimeout(done, config.WAIT_MS ?? 25000);
          if (!waiters.has(p.id)) waiters.set(p.id, new Set());
          waiters.get(p.id).add(done);
          res.on('close', done);   // the page went away (req's 'close' fires once the request is read)
        });
        msgs = await newer();
      }
      return [200, { messages: msgs }];
    }

    if (route === 'send' && req.method === 'POST') {
      const { text: raw } = await json();
      const { text, cut } = L.toDeviceText(raw);
      if (!text) throw HTTP(400, { status: 'empty' });
      if (!limits.in.take(p.id)) throw HTTP(429, { status: 'slow-down' });
      deliverToDevice(p, text);
      const entry = { at: Date.now(), from: 'contact', text };
      await store.addChat(p.id, entry);
      wake(p.id);
      log('INFO', `pairing ${short(p.id)}: web contact message delivered to device (${text.length} chars${cut ? ', shortened' : ''})`);
      return [200, { message: entry, cut }];
    }

    if (route === 'push' && req.method === 'POST') {
      const { subscription: sub, fcmToken } = await json();
      // The iOS app's contact mode: a Firebase token instead of a browser
      // subscription. A chat is held by one device, so it has one or the other.
      if (fcmToken !== undefined) {
        if (typeof fcmToken !== 'string' || fcmToken.length < 20 || fcmToken.length > 4096) throw HTTP(400, { status: 'bad-request' });
        await store.updatePairing(p.id, { pushFcm: fcmToken, pushSub: null });
        return [200, { status: 'ok' }];
      }
      const ok = sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.endpoint.length < 1024
        && typeof sub.keys?.p256dh === 'string' && typeof sub.keys?.auth === 'string';
      if (!ok) throw HTTP(400, { status: 'bad-request' });
      await store.updatePairing(p.id, { pushSub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } } });
      return [200, { status: 'ok' }];
    }
    if (route === 'push' && req.method === 'DELETE') {
      await store.updatePairing(p.id, { pushSub: null, pushFcm: null });
      return [200, { status: 'ok' }];
    }

    // Release: the device holding the link gives it up so another can connect
    // -- on iPhone, Safari handing over to the Home Screen web app, which has
    // its own separate storage and so counts as a different device. History is
    // kept (same person); the push subscription belonged to the old device.
    if (route === 'release' && req.method === 'POST') {
      await store.updatePairing(p.id, { claimHash: null, pushSub: null, pushFcm: null });
      log('INFO', `pairing ${short(p.id)}: link released by its device, for another to claim`);
      return [200, { status: 'released' }];
    }

    // Leave: the contact disconnects themselves. The link dies, their device's
    // claim and push subscription and the history are erased, and the account
    // holder sees that they left (and can send a new link).
    if (route === 'leave' && req.method === 'POST') {
      await store.updatePairing(p.id, { status: 'stopped', tokenHash: null, claimHash: null, pushSub: null, pushFcm: null, stoppedAt: FieldValue.serverTimestamp(),
        notifyStatus: null, notifyKey: null, notifyEnc: null, notifyHint: null, notifyFrom: null });
      await store.clearChat(p.id);
      wake(p.id);
      log('INFO', `pairing ${short(p.id)}: web contact left`);
      return [200, { status: 'left' }];
    }

    throw HTTP(404, { status: 'not-found' });
  }

  // ------------------------------------------------------- SMS sandbox API --
  // For the sandbox phone page only (site/sms-sandbox.html), and only when the
  // bridge runs with SMS_SANDBOX=1. Every call needs X-Sandbox-Key.
  async function sandboxApi(req, url) {
    if (!sandbox || !config.SANDBOX_KEY) throw HTTP(404, { status: 'not-found' });
    const given = Buffer.from(String(req.headers['x-sandbox-key'] || ''));
    const want = Buffer.from(config.SANDBOX_KEY);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) throw HTTP(403, { status: 'forbidden' });
    const route = url.pathname.slice('/chat/api/sandbox/'.length);
    const from = await notifyFrom();
    if (route === 'numbers' && req.method === 'GET') return [200, { from, numbers: sandbox.numbers() }];
    const number = L.toE164(url.searchParams.get('number'));
    if (route === 'thread' && req.method === 'GET') {
      if (!number) throw HTTP(400, { status: 'invalid-number' });
      return [200, { from, number, ...sandbox.thread(number) }];
    }
    if (route === 'reply' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse(await readBody(req, 4096)); } catch (e) { if (e.http) throw e; }
      const n = L.toE164(body.number);
      const text = String(body.body || '').slice(0, 640);
      if (!n || !text.trim() || !from) throw HTTP(400, { status: 'bad-request' });
      await sandbox.reply({ from: n, to: from, body: text }, inbound);
      return [200, { from, number: n, ...sandbox.thread(n) }];
    }
    if (route === 'reset' && req.method === 'POST') {
      if (!number) throw HTTP(400, { status: 'invalid-number' });
      sandbox.reset(number);
      return [200, { from, number, ...sandbox.thread(number) }];
    }
    throw HTTP(404, { status: 'not-found' });
  }

  async function removeContact(uid, id) {
    const p = await store.getPairing(id);
    if (!p || p.ownerUid !== uid) throw HTTP(404, { status: 'not-found' });
    await store.deletePairing(id);
    log('INFO', `pairing ${short(id)} deleted by its parent`);
    // The app takes the virtual ID out of the device's friend list itself, the
    // same way it removes any friend.
    return [200, { status: 'deleted', virtualId: p.virtualId }];
  }

  // ------------------------------------------------------------------ sweep --
  // Pairings whose Dot Dash is no longer paired to that account, and links
  // nobody ever opened, are deleted -- any notification number goes with them.
  async function sweep() {
    const snap = await store.pairings.get();
    const devCache = new Map();
    let removed = 0;
    for (const doc of snap.docs) {
      const p = { id: doc.id, ...doc.data() };
      const devPath = `artifacts/${APP_ID}/users/${p.ownerUid}/devices/${p.deviceDocId}`;
      if (!devCache.has(devPath)) devCache.set(devPath, await db.doc(devPath).get());
      const dev = devCache.get(devPath);
      const gone = !dev.exists || dev.data().hashedId !== p.deviceHash;
      const created = p.createdAt?.toMillis?.() || Date.now();
      const stale = p.status === 'pending' && Date.now() - created > PENDING_TTL_MS;
      // Taken off the device's friend list without the bridge being told (the
      // app could not reach it, or the list was edited elsewhere). The hour's
      // grace covers the moment between creating a pairing and the app adding
      // its friend ID.
      const dropped = !gone && Date.now() - created > HOUR && !(dev.data().friends || []).includes(p.virtualId);
      // A web contact who left 30 days ago and was never sent a new link.
      const left = p.channel === 'web' && p.status === 'stopped' && Date.now() - (p.stoppedAt?.toMillis?.() || Date.now()) > 30 * DAY;
      if (gone || stale || dropped || left) {
        await store.deletePairing(p.id);
        removed++;
        log('INFO', `sweep: pairing ${short(p.id)} deleted (${gone ? 'device unpaired' : stale ? 'never connected' : dropped ? 'no longer a friend on the device' : 'left 30 days ago'})`);
      } else if (p.channel === 'web') {
        await store.pruneChat(p.id);   // the 30-day limit, for chats nobody has written to lately
      }
    }
    return { checked: snap.size, removed };
  }

  // ------------------------------------------------------------------- http --
  function readBody(req, max) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => { data += c; if (data.length > max) { reject(HTTP(413, { status: 'too-large' })); req.destroy(); } });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const extra = { 'Cache-Control': 'no-store' };
    const send = (code, obj, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type, ...extra });
      res.end(type === 'application/json' ? JSON.stringify(obj) : obj);
    };
    const url = new URL(req.url, 'http://x');
    // Anything that came through nginx carries X-Forwarded-For; the internal
    // routes are for the droplet itself.
    const internal = !req.headers['x-forwarded-for'];

    try {
      if (url.pathname === '/sms/inbound') {
        if (req.method !== 'POST') return send(405, { status: 'method' });
        const raw = await readBody(req, 16384);
        const params = Object.fromEntries(new URLSearchParams(raw));
        if (!L.validTwilioSignature(TWILIO_AUTH_TOKEN, `${PUBLIC_BASE}${req.url}`, params, req.headers['x-twilio-signature'])) {
          log('WARN', `inbound: bad signature from ${req.headers['x-forwarded-for'] || 'local'} -- refused`);
          return send(403, { status: 'forbidden' });
        }
        return send(200, await inbound(params), 'text/xml');
      }

      if (url.pathname.startsWith('/chat/api/sandbox/')) {
        extra['X-Robots-Tag'] = 'noindex';
        return send(...(await sandboxApi(req, url)));
      }

      if (url.pathname.startsWith('/chat/api/')) {
        // The chat page is same-origin; the iOS app's contact mode is not
        // (capacitor://localhost), so it needs CORS like /sms/contacts.
        const origin = req.headers.origin;
        if (origin && APP_ORIGINS.has(origin)) Object.assign(extra, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { ...extra, 'Access-Control-Allow-Methods': 'GET, POST, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' });
          return res.end();
        }
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress);
        return send(...(await chatApi(req, res, url, ip)));
      }

      if (url.pathname === '/internal/pool' && internal && req.method === 'GET') return send(200, await store.recountPools());
      if (url.pathname === '/internal/sweep' && internal && req.method === 'POST') return send(200, await sweep());

      const m = /^\/sms\/contacts(?:\/([A-Za-z0-9]{1,40})(\/link)?)?$/.exec(url.pathname);
      if (!m) return send(404, { status: 'not-found' });

      const origin = req.headers.origin;
      if (origin && APP_ORIGINS.has(origin)) Object.assign(extra, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...extra, 'Access-Control-Allow-Methods': 'GET, POST, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' });
        return res.end();
      }
      const uid = await verifyIdToken(/^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1]);
      if (!uid) return send(401, { status: 'unauthenticated' });

      const [, id, link] = m;
      let out;
      if (!id && req.method === 'GET') out = [200, { contacts: (await store.listForOwner(uid)).map(view) }];
      else if (!id && req.method === 'POST') {
        let body = {};
        try { body = JSON.parse(await readBody(req, 4096)); } catch (e) { if (e.http) throw e; }
        out = await addContact(uid, body);
      } else if (id && link && req.method === 'POST') out = await newLink(uid, id);
      else if (id && !link && req.method === 'DELETE') out = await removeContact(uid, id);
      else return send(405, { status: 'method' });
      return send(...out);
    } catch (e) {
      if (e.http) return send(...e.http);
      log('ERROR', `${req.method} ${url.pathname} failed: ${e.message}`);
      return send(503, { status: 'unavailable' });
    }
  });


  return { server, store, sweep, inbound, applyPairings, onMessage, waiters };
}
