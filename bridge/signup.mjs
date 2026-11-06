// Mailing-list signup for the public home page.
//
// A form on dotdashdevice.com posts here; this adds the address to the
// "Website" audience in Resend and sends one welcome email. nginx proxies
// /signup/api/ to 127.0.0.1:8794 (see ops/nginx-dotdashdevice-site.conf).
//
// WHY ITS OWN PROCESS, not a route inside sms.mjs: that service also serves
// the /c/ chat page for link contacts, and restarting it to ship a copy
// change on a signup form would cut those conversations off. This one can be
// restarted freely.
//
// WHAT IS STORED HERE: a SHA-256 of the lowercased, trimmed address, and a
// timestamp. Not the address. Resend holds the list -- it is the system of
// record -- and the only two questions this service has to answer locally are
// "how many" and "have we already welcomed this one", both of which a hash
// answers. Same hashing discipline as the MQTT topic keys: lowercase and trim
// FIRST, or the same person hashes two different ways.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT       = Number(process.env.SIGNUP_PORT || 8794);
const STORE_DIR  = process.env.SIGNUP_DIR || '/var/lib/dotdash-signup';
const STORE      = path.join(STORE_DIR, 'signups.jsonl');
const API_KEY    = process.env.RESEND_API_KEY;
const AUDIENCE   = process.env.RESEND_AUDIENCE_ID;
const FROM       = process.env.EMAIL_FROM || 'Dot Dash <hello@dotdashdevice.com>';
const REPLY_TO   = process.env.EMAIL_REPLY_TO || 'support@dotdashdevice.com';
const SITE       = process.env.SITE_URL || 'https://dotdashdevice.com';
const DRY        = process.env.SIGNUP_DRY === '1';   // local testing: no Resend calls

// The count is public, so it is also an argument. "2 people" argues against
// you; past the threshold it argues for you. One number to change, and the
// front end simply hides the line when the server says show:false.
const SHOW_COUNT_FROM = Number(process.env.SIGNUP_SHOW_FROM || 25);

// Per-IP, deliberately loose -- the same reasoning as raffle/src/lib/rate-limit.ts:
// mobile carriers put thousands of subscribers behind one egress IP, so a tight
// number turns away real people and looks like a broken site. The control that
// actually matters is below it: an address is welcomed ONCE, ever, so the worst
// a scripted abuser can do to any given victim is one email.
const IP_MAX = 60, IP_WINDOW_MS = 60 * 60 * 1000;

if (!DRY && (!API_KEY || !AUDIENCE)) {
  console.error('RESEND_API_KEY and RESEND_AUDIENCE_ID must be set'); process.exit(1);
}

// ---------------------------------------------------------------- the store
fs.mkdirSync(STORE_DIR, { recursive: true });
const seen = new Set();
if (fs.existsSync(STORE)) {
  for (const line of fs.readFileSync(STORE, 'utf8').split('\n')) {
    if (!line) continue;
    try { seen.add(JSON.parse(line).e); } catch { /* skip a torn line */ }
  }
}
console.log(`signup: ${seen.size} on file, port ${PORT}${DRY ? ' (DRY)' : ''}`);

// Unsubscribe links have to carry the address, because this service stores
// only hashes and so cannot look one up. They are therefore SIGNED: the link
// is address + HMAC, and an unsigned or edited one is refused. The key is
// generated once and kept beside the list; wiping the state directory
// invalidates every link already in the wild, which is the trade for not
// having to put another secret in signup.env.
const SECRET_FILE = path.join(STORE_DIR, 'secret');
const SECRET = process.env.SIGNUP_SECRET || (() => {
  if (!fs.existsSync(SECRET_FILE)) {
    fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(SECRET_FILE, 'utf8').trim();
})();

const norm = (e) => e.toLowerCase().trim();
const sign = (email) => crypto.createHmac('sha256', SECRET).update(norm(email)).digest('base64url').slice(0, 27);
const unsubUrl = (email) =>
  `${SITE}/signup/api/unsubscribe?e=${Buffer.from(norm(email)).toString('base64url')}&s=${sign(email)}`;
function checkToken(e64, sig) {
  let email;
  try { email = Buffer.from(String(e64 || ''), 'base64url').toString('utf8'); } catch { return null; }
  if (!validEmail(email)) return null;
  const want = Buffer.from(sign(email)), got = Buffer.from(String(sig || ''));
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  return norm(email);
}

const hash = (email) => crypto.createHash('sha256')
  .update(email.toLowerCase().trim()).digest('hex');

function record(h) {
  fs.appendFileSync(STORE, JSON.stringify({ e: h, t: Date.now() }) + '\n');
  seen.add(h);
}

// ------------------------------------------------------------- the address
// Deliberately conservative rather than RFC-complete: this is a signup box on
// a product page, and anything exotic enough to fail here can write to
// support@ instead. Resend rejects the rest.
const EMAIL_RE = /^[^\s@,<>"']{1,64}@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
const validEmail = (s) => typeof s === 'string' && s.length <= 254 && EMAIL_RE.test(s.trim());

// ---------------------------------------------------------------- limiting
const hits = new Map();   // ip -> number[] of timestamps
function allow(ip) {
  const now = Date.now();
  const a = (hits.get(ip) || []).filter(t => now - t < IP_WINDOW_MS);
  if (a.length >= IP_MAX) { hits.set(ip, a); return false; }
  a.push(now); hits.set(ip, a);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < IP_WINDOW_MS)) hits.delete(k);
  return true;
}

// ------------------------------------------------------------------ Resend
async function addContact(email) {
  if (DRY) return;
  const r = await fetch(`https://api.resend.com/audiences/${AUDIENCE}/contacts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, unsubscribed: false }),
  });
  if (!r.ok) throw new Error(`resend contacts ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

// Resend keeps the contact and flips a flag, which is what you want: the
// address stays known, so re-adding it later does not resurrect someone who
// asked to be left alone unless they ask for it themselves.
async function setUnsubscribed(email, value) {
  if (DRY) { console.log(`[dry] unsubscribed=${value} <- ${email}`); return; }
  const r = await fetch(`https://api.resend.com/audiences/${AUDIENCE}/contacts/${encodeURIComponent(email)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ unsubscribed: value }),
  });
  if (!r.ok) throw new Error(`resend patch ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

const WELCOME_SUBJECT = "You're on the Dot Dash list";
const WELCOME_TEXT = `Thanks — you're on the list.

Dot Dash is a pocket messaging device that works in Morse code. Two buttons,
one small screen, and only the people you have approved.

We'll email you when there are devices to be had, and now and then with what
has changed — new features, what the device has learned to do. Not often.

If this wasn't you, ignore this message and we'll leave you alone.

dotdashdevice.com

--
Don't want these? Unsubscribe:
%UNSUB%
`;
const WELCOME_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f6f5f3;-webkit-text-size-adjust:100%">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f5f3">
<tr><td align="center" style="padding:28px 12px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="520" style="width:100%;max-width:520px;background:#ffffff;border:1px solid #d8d3cb;border-radius:18px">
<tr><td style="padding:26px 24px 22px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1b1a18">
<p style="margin:0 0 16px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:20px;line-height:1.2;letter-spacing:.04em">DOT DASH</p>
<p style="margin:0 0 12px"><strong>Thanks &mdash; you&rsquo;re on the list.</strong></p>
<p style="margin:0 0 12px">Dot Dash is a pocket messaging device that works in Morse code. Two buttons, one small screen, and only the people you have approved.</p>
<p style="margin:0 0 12px">We&rsquo;ll email you when there are devices to be had, and now and then with what has changed &mdash; new features, what the device has learned to do. Not often.</p>
<p style="margin:0 0 14px;color:#55514b;font-size:15px">If this wasn&rsquo;t you, ignore it and we&rsquo;ll leave you alone.</p>
<p style="margin:0"><a href="https://dotdashdevice.com" style="color:#2563eb">dotdashdevice.com</a></p>
</td></tr>
<tr><td style="padding:0 24px 20px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#55514b;border-top:1px solid #ece8e1">
<p style="margin:14px 0 0">Don&rsquo;t want these? <a href="%UNSUB%" style="color:#2563eb">Unsubscribe</a>.</p>
</td></tr></table>
</td></tr></table>
</body></html>`;

async function sendWelcome(email) {
  const url = unsubUrl(email);
  if (DRY) { console.log(`[dry] welcome -> ${email}\n[dry]   ${url}`); return; }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    // List-Unsubscribe puts the native "Unsubscribe" button in Gmail and Apple
    // Mail next to the sender's name, which is where people actually look --
    // and the -Post header (RFC 8058) makes that button a single POST rather
    // than a trip through the browser. Both point at the same signed URL as
    // the footer link.
    body: JSON.stringify({
      from: FROM, reply_to: REPLY_TO, to: email, subject: WELCOME_SUBJECT,
      text: WELCOME_TEXT.replace('%UNSUB%', url),
      html: WELCOME_HTML.replace('%UNSUB%', url.replace(/&/g, '&amp;')),
      headers: {
        'List-Unsubscribe': `<${url}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }),
  });
  if (!r.ok) throw new Error(`resend emails ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

// -------------------------------------------------------------------- HTTP
const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
                        'Content-Length': Buffer.byteLength(s) });
  res.end(s);
};
// Without JavaScript the form does a normal POST and lands here, so the page
// still works with scripting off -- which is true of every other part of it.
const page = (res, code, head, body, extra = '') => {
  const h = `<!doctype html><meta charset=utf-8><title>${head}</title>
<meta name=viewport content="width=device-width,initial-scale=1">
<body style="margin:0;background:#f6f5f3;color:#1b1a18;font:400 17px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<main style="max-width:560px;margin:0 auto;padding:60px 16px;text-align:center">
<h1 style="font:400 22px/1.3 ui-monospace,Menlo,monospace;text-transform:uppercase">${head}</h1>
<p>${body}</p>${extra}<p><a href="https://dotdashdevice.com" style="color:#2563eb">Back to Dot Dash</a></p>
</main>`;
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(h);
};

const wantsJsonHdr = (req) => String(req.headers['accept'] || '').includes('application/json');

const countBody = () => ({ count: seen.size, show: seen.size >= SHOW_COUNT_FROM });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || req.socket.remoteAddress || 'unknown';

  if (req.method === 'GET' && url.pathname === '/signup/api/count') return json(res, 200, countBody());

  // ---- unsubscribe ------------------------------------------------------
  // GET only ASKS. Mail clients and security scanners routinely fetch every
  // link in a message to check it; if GET did the unsubscribing, those
  // prefetches would quietly remove people who never clicked anything. The
  // deed is done by POST -- either this page's button, or the one-click POST
  // that Gmail's own Unsubscribe button sends (RFC 8058).
  if (url.pathname === '/signup/api/unsubscribe') {
    const email = checkToken(url.searchParams.get('e'), url.searchParams.get('s'));
    if (req.method === 'GET') {
      if (!email) return page(res, 400, 'That link has expired',
        'We could not read that unsubscribe link. Email support@dotdashdevice.com and we will take you off.');
      const q = `e=${encodeURIComponent(url.searchParams.get('e'))}&amp;s=${encodeURIComponent(url.searchParams.get('s'))}`;
      return page(res, 200, 'Leave the list?',
        `Remove <b>${email.replace(/[<>&]/g, '')}</b> from the Dot Dash mailing list?`,
        `<form method="post" action="/signup/api/unsubscribe?${q}" style="margin:18px 0 22px">
           <button type="submit" style="font:400 15px ui-monospace,Menlo,monospace;text-transform:uppercase;
             cursor:pointer;background:#2563eb;color:#fff;border:1px solid #2563eb;border-radius:12px;
             padding:13px 18px 11px">Unsubscribe</button></form>`);
    }
    if (req.method === 'POST') {
      for await (const c of req) { if (c.length > 1024) break; }   // drain the one-click body
      if (!email) return json(res, 400, { ok: false, error: 'token' });
      try { await setUnsubscribed(email, true); }
      catch (e) {
        console.error('signup: unsubscribe failed:', e.message);
        return wantsJsonHdr(req) ? json(res, 502, { ok: false })
          : page(res, 502, 'Something went wrong', 'Please email support@dotdashdevice.com and we will take you off.');
      }
      console.log('signup: unsubscribed one contact');
      return wantsJsonHdr(req) ? json(res, 200, { ok: true })
        : page(res, 200, 'Done', 'You are off the list. We will not email you again.');
    }
  }

  if (req.method !== 'POST' || url.pathname !== '/signup/api/subscribe') return json(res, 404, { ok: false });

  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 2048) { req.destroy(); return; } }

  let email = '', hp = '';
  const ctype = String(req.headers['content-type'] || '');
  const wantsJson = String(req.headers['accept'] || '').includes('application/json');
  try {
    if (ctype.includes('application/json')) { const b = JSON.parse(raw || '{}'); email = b.email || ''; hp = b.company || ''; }
    else { const p = new URLSearchParams(raw); email = p.get('email') || ''; hp = p.get('company') || ''; }
  } catch { /* falls through to the invalid-address answer */ }

  const reply = (code, body, headTxt, bodyTxt) =>
    wantsJson ? json(res, code, body) : page(res, code === 200 ? 200 : code, headTxt, bodyTxt);

  // The honeypot is answered exactly like success. Telling a bot it was caught
  // only teaches it which field to leave alone.
  if (hp) return reply(200, { ok: true, ...countBody() }, 'Thanks', "You're on the list.");

  if (!validEmail(email)) return reply(400, { ok: false, error: 'invalid' },
    'That address looks wrong', 'Check it and try again, or email support@dotdashdevice.com.');
  email = email.trim();

  if (!allow(ip)) return reply(429, { ok: false, error: 'rate' },
    'Too many tries', 'Too many sign-ups from your network. Try again in an hour.');

  // Already welcomed: idempotent, and NO second email. This is what keeps a
  // public single-opt-in form from being usable as a way to mail a stranger
  // repeatedly -- any address can be welcomed once and only once.
  const h = hash(email);
  if (seen.has(h)) {
    // Known address: still clear the unsubscribed flag, because this may be
    // somebody who left and has chosen to come back. Without this they would
    // be told "you're already on the list" while Resend went on skipping them.
    try { await setUnsubscribed(email, false); } catch (e) { console.error('signup: resubscribe failed:', e.message); }
    return reply(200, { ok: true, already: true, ...countBody() },
      'Already on the list', "You're already signed up — nothing more to do.");
  }

  try {
    await addContact(email);
  } catch (e) {
    console.error('signup: contact failed:', e.message);
    return reply(502, { ok: false, error: 'upstream' },
      'Something went wrong', 'We could not save that just now. Please try again shortly.');
  }
  record(h);                       // recorded the moment they are on the list

  // The welcome mail is best-effort: they ARE subscribed, so a Resend hiccup
  // here must not show them a failure or invite a retry that double-adds.
  try { await sendWelcome(email); }
  catch (e) { console.error('signup: welcome failed:', e.message); }

  return reply(200, { ok: true, ...countBody() }, 'Thanks', "You're on the list. Check your email.");
}).listen(PORT, '127.0.0.1', () => console.log(`signup: listening on 127.0.0.1:${PORT}`));
