/**
 * Pure helpers for the SMS bridge: no network, no Firestore, no MQTT. Everything
 * here is covered by lib.test.mjs, which runs with plain `node --test` and no
 * credentials.
 */

import crypto from 'node:crypto';

// ------------------------------------------------------------------ ids ----
// Same as the app, firmware and the other bridge services: sha256 of the
// trimmed, LOWERCASED id. Hashing the stored uppercase form builds a topic that
// nobody listens on.
export const hashId = (id) =>
  crypto.createHash('sha256').update(String(id).trim().toLowerCase()).digest('hex');

export const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * The name half of a phone contact's virtual friend ID, e.g. "Grandma Jo" ->
 * "GRANDMAJO". The device shows a sender with the last four characters
 * stripped (they are a child's birthday PIN), and cuts the "SEND TO" header at
 * 11, so the name is capped to fit that. A-Z/0-9 only: the ID travels inside a
 * comma-separated payload and a |-separated friend list.
 */
export function virtualName(contactName) {
  const n = String(contactName || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  return n.length >= 2 ? n : null;
}

export const virtualId = (name, digits) => `${name}${String(digits).padStart(4, '0')}`;

// ------------------------------------------------------------ phone numbers --
/**
 * Normalise user input to E.164, or null. A bare 10-digit number (or 11 digits
 * starting 1) is taken as North American, since that is where the pool numbers
 * are; anything else must come with its + and country code.
 */
export function toE164(input) {
  const raw = String(input || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) return digits.length >= 8 && digits.length <= 15 && digits[0] !== '0' ? `+${digits}` : null;
  if (digits.length === 10 && /^[2-9]\d{2}[2-9]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1' && /^[2-9]\d{2}[2-9]/.test(digits.slice(1))) return `+${digits}`;
  return null;
}

// What a log line or the parent app may show: the last two digits. Never log a
// full number -- see the COPPA notes in README.md.
export const maskNumber = (e164) => (e164 ? `…${String(e164).slice(-2)}` : '?');
// What the parent sees in the app to recognise the contact they added.
export const numberHint = (e164) => (e164 ? `•••• ${String(e164).slice(-4)}` : '');
// Firestore document ids cannot contain '/', and '+' reads badly; digits only.
export const poolKey = (e164) => String(e164).replace(/\D/g, '');

// ------------------------------------------------------------ at-rest crypto --
/**
 * Phone numbers are stored encrypted (AES-256-GCM) and looked up through a
 * keyed HMAC ("blind index"), so the database alone -- a leaked service
 * account, a console screenshot, a backup -- holds no usable number. Both keys
 * are derived from one master secret that lives only on the droplet.
 *
 * The HMAC is deterministic by design (it is how an inbound From is matched),
 * so anyone holding BOTH the database and the master key could confirm a
 * guessed number. That is the limit of this scheme; the key never leaves the
 * box.
 */
export function makeKeys(masterB64) {
  const master = Buffer.from(String(masterB64 || ''), 'base64');
  if (master.length !== 32) throw new Error('SMS_DATA_KEY must be 32 bytes, base64');
  const derive = (label) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), `dotdash-sms:${label}`, 32));
  return { enc: derive('enc:v1'), mac: derive('mac:v1') };
}

export const contactKey = (keys, e164) =>
  crypto.createHmac('sha256', keys.mac).update(e164).digest('hex');

export function encrypt(keys, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keys.enc, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64url')}`;
}

export function decrypt(keys, blob, aad) {
  const [ver, body] = String(blob).split(':');
  if (ver !== 'v1' || !body) throw new Error('unknown ciphertext version');
  const buf = Buffer.from(body, 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', keys.enc, buf.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString('utf8');
}

// --------------------------------------------------------------- web links --
// A web contact's link token, and the claim secret the first device to open
// it is given. 24 random bytes each; only their SHA-256 is ever stored.
export const newSecret = () => crypto.randomBytes(24).toString('base64url');
export const secretHash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const SECRET_RE = /^[A-Za-z0-9_-]{32}$/;

// ------------------------------------------------------------------ twilio --
/**
 * Twilio's webhook signature: HMAC-SHA1 over the full public URL followed by
 * every POST parameter, sorted by name, as name+value with no separators;
 * base64. The URL must be exactly the one configured on the number -- behind
 * nginx that is the PUBLIC https URL, never the 127.0.0.1 one this process
 * actually sees.
 */
export function twilioSignature(authToken, url, params) {
  let data = url;
  for (const k of Object.keys(params).sort()) {
    const v = params[k];
    for (const one of Array.isArray(v) ? [...v].sort() : [v]) data += k + one;
  }
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function validTwilioSignature(authToken, url, params, header) {
  if (!authToken || !header) return false;
  const want = Buffer.from(twilioSignature(authToken, url, params));
  const got = Buffer.from(String(header));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
export const twiml = (reply) =>
  `<?xml version="1.0" encoding="UTF-8"?><Response>${reply ? `<Message>${xmlEscape(reply)}</Message>` : ''}</Response>`;

/**
 * Carrier keywords. Twilio's default opt-out handling already answers these
 * and blocks further sends on its own; the bridge only has to mirror the state
 * so it stops trying (and so the parent app can show it). A keyword is the
 * WHOLE message, as Twilio matches it -- "stop by later" is a message, not an
 * opt-out.
 *
 * YES is a Twilio opt-in keyword, which is exactly what the intro asks for.
 */
const KEYWORDS = {
  stop: ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT'],
  start: ['START', 'YES', 'UNSTOP'],
  help: ['HELP', 'INFO'],
};
export function keywordOf(body, optOutType) {
  const t = String(optOutType || '').toUpperCase();
  if (t === 'STOP') return 'stop';
  if (t === 'START') return 'start';
  if (t === 'HELP') return 'help';
  const word = String(body || '').trim().toUpperCase().replace(/[.!\s]+$/, '');
  for (const [kind, list] of Object.entries(KEYWORDS)) if (list.includes(word)) return kind;
  return null;
}

// ---------------------------------------------------------- device messages --
/**
 * Characters the device can show AND tap back in Morse: letters, digits, space
 * and the firmware's MORSE_PUNCT table. The comma is deliberately absent -- the
 * wire format is "TYPE,TEXT,SENDER" split on the first two commas, so a comma in
 * the text would shift the rest into the sender field and the device would file
 * the message as a stranger's.
 */
const DEVICE_OK = /[A-Z0-9 .:?'\-/()"=+@!;_$&]/;
const FOLD = {
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'", '\u2032': "'",
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u2033': '"',
  '\u2013': '-', '\u2014': '-', '\u2212': '-', '\u2026': '...',
  ',': ' ', '\n': ' ', '\r': ' ', '\t': ' ', '|': '/',
  '<': '(', '>': ')', '[': '(', ']': ')', '{': '(', '}': ')', '%': ' PERCENT', '*': ' ',
};

// One incoming SMS becomes ONE device message, never a series. The device
// shows each arrival full-screen and interrupts whatever it is showing, and its
// inbox lists newest first, so a text split in parts would be read backwards,
// each part cutting off the one before. 160 is one classic SMS, fits the
// device's 512-byte MQTT buffer with room to spare, and is already a long read
// on a 128x32 screen. Longer texts are cut at a word and marked.
export const DEVICE_MAX = 160;

export function toDeviceText(body, { numMedia = 0, max = DEVICE_MAX } = {}) {
  let out = '';
  for (const ch of String(body || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')) {
    const up = ch.toUpperCase();
    if (FOLD[ch] !== undefined) out += FOLD[ch];
    else if (up.length === 1 && DEVICE_OK.test(up)) out += up;
    // Anything else -- emoji, other scripts -- is dropped.
  }
  out = out.replace(/\s+/g, ' ').trim();

  const hadText = String(body || '').trim().length > 0;
  if (!out && hadText) out = '(EMOJI)';
  if (numMedia > 0) out = out ? `(PHOTO) ${out}` : '(PHOTO)';
  if (!out) return { text: '', cut: false };

  if (out.length <= max) return { text: out, cut: false };
  const room = max - 3;
  let cutAt = out.lastIndexOf(' ', room);
  if (cutAt < room * 0.6) cutAt = room;   // one enormous word: cut it mid-word rather than lose most of the text
  return { text: `${out.slice(0, cutAt).trimEnd()}...`, cut: true };
}

/**
 * Two-player game traffic between devices. It rides the same retained
 * doorbell/msg/<hash>/<stamp> channel as messages (per-device MQTT ACLs only
 * allow publishing there) as "GAME,<pipe-separated data>,<sender>". A device's
 * friend list can include a virtual contact's ID, so one can land on a virtual
 * friend's topic. It is machine data, never something a person should read:
 * it must not be relayed to a phone or web chat.
 */
export const isGameTraffic = (action) => action === 'GAME';

/**
 * A device's outgoing message: "TYPE,TEXT,SENDER". Split on the first and LAST
 * comma, as the push bridge does, so a sender field can never absorb text.
 */
export function parseDeviceMessage(payload) {
  const s = String(payload || '');
  const first = s.indexOf(',');
  const last = s.lastIndexOf(',');
  if (first < 1 || last <= first) return null;
  const type = s.slice(0, first);
  if (!['TEXT', 'MORSE', 'PULSE'].includes(type)) return null;
  const sender = s.slice(last + 1).trim();
  if (!sender) return null;
  return { type, text: s.slice(first + 1, last), sender };
}

// Strip the 4-digit PIN for display, as the device and app do.
export const displayName = (id) => String(id || '').replace(/\d{4}$/, '') || String(id || '');

/** What the contact's phone receives for one device message. */
// Every message names who sent it AND the brand -- "Maya via Dot Dash: ..." --
// because carriers reject toll-free traffic whose messages don't identify the
// business (Twilio error 30499), and a bare "LOVE YOU" from a toll-free number
// reads as anonymous. The sender is the child's ID with its PIN removed.
export function toSmsBody({ type, text, sender }) {
  const who = String(displayName(sender) || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const prefix = `${who ? `${who} via ` : ''}Dot Dash: `;
  if (type === 'PULSE') return `${prefix}(buzz!)`;
  const t = String(text || '').trim();
  return t ? prefix + t.slice(0, 320) : null;
}

// The numeric id the firmware's replay guard keys on: digits only, under 20.
// Milliseconds plus one spare digit, so two texts in the same millisecond differ.
let lastStamp = 0;
export function msgStamp(now = Date.now()) {
  let s = now * 10;
  if (s <= lastStamp) s = lastStamp + 1;
  lastStamp = s;
  return String(s);
}

// ------------------------------------------------------------- pool choice --
/**
 * Which pool number a new pairing should use, or null when none is free.
 *
 *   pools   [{ key, active, used }]   used = pairings on that number
 *   routes  [{ pool, deviceHash }]    every route this contact already has,
 *                                     live or retired
 *
 * A contact may hold only one device per pool number, and a (contact, number)
 * pair is never handed to a different device -- their phone has that number
 * saved as a conversation with a particular child. So:
 *   1. a route to THIS device already exists (re-adding someone the parent
 *      removed) -> reuse it, and the old thread picks up where it left off;
 *   2. otherwise the least-used active number the contact has never had.
 * Least-used spreads send volume, which is what a number's rate limit caps.
 */
export function choosePool(pools, routes, deviceHash) {
  const mine = routes.find((r) => r.deviceHash === deviceHash);
  if (mine) {
    const p = pools.find((x) => x.key === mine.pool);
    return p && p.active ? p.key : null;   // that number was retired: an ops decision, not ours
  }
  const taken = new Set(routes.map((r) => r.pool));
  const free = pools.filter((p) => p.active && !taken.has(p.key));
  free.sort((a, b) => a.used - b.used || String(a.key).localeCompare(String(b.key)));
  return free[0]?.key ?? null;
}

// ------------------------------------------------------------ rate limits --
/** Fixed-window counters, in memory. A restart forgives -- acceptable for a cost cap. */
export class Limiter {
  constructor(rules) { this.rules = rules; this.hits = new Map(); }
  // true if allowed (and counted), false if any window is full
  take(key, now = Date.now()) {
    if (!this.allows(key, now)) return false;
    this.hits.get(key).push(now);
    return true;
  }
  // The same test without counting, for a caller that may yet fail for
  // another reason and should not be charged for it.
  allows(key, now = Date.now()) {
    const hits = (this.hits.get(key) || []).filter((t) => now - t < this.longest());
    this.hits.set(key, hits);
    return this.rules.every(({ ms, max }) => hits.filter((t) => now - t < ms).length < max);
  }
  longest() { return Math.max(...this.rules.map((r) => r.ms)); }
}
