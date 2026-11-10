// Send one email to the whole mailing list, slowly, over hours rather than in a burst.
//
// The list lives in Resend (the "Website" audience; see signup.mjs). A Resend
// Broadcast would send to all of it at once, and a young sending domain that
// suddenly emails a few hundred people is exactly what spam filters punish.
// This sends the same email one person at a time, spread evenly (with jitter)
// over a window, so the domain's volume ramps up the way a real sender's does.
//
// It runs ON THE DROPLET, beside signup.mjs, because that is where the key and
// the unsubscribe secret live. Nothing here needs a secret in git or on a laptop.
//
//   node broadcast.mjs                        dry run: list, order, schedule, sample
//   node broadcast.mjs --test you@example.com one copy to one address
//   node broadcast.mjs --live [--hours 12]    the real send (run it under
//                                             systemd-run so it survives logout)
//
// SAFE TO RESTART. Every successful send is appended (as a hash, never the
// address) to /var/lib/dotdash-signup/broadcasts/<CAMPAIGN>.jsonl, and a re-run
// skips anyone already in it. Stop it, fix something, start it again.
//
// UNSUBSCRIBE uses the very same signed link as the welcome email, so the
// existing endpoint in signup.mjs handles it: same secret file, same format.
// The audience is re-read every so often during a run, so someone who
// unsubscribes partway through the day is not mailed later in the same run.
//
// ORDER. People who signed up on the website go first; the contacts imported
// in bulk (the giveaway opt-ins, the Instagram survey) go last, because they
// never used the form and are the likeliest to ignore or flag a message.
// Resend does not record a contact's source, so an import is recognised by
// what an import looks like: many contacts created in the same minute.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ------------------------------------------------------------- the message
const CAMPAIGN = 'warmup-2026-11';
const SUBJECT = 'Another way to get a Dot Dash is coming';
const POSTAL = 'Dot Dash · 467 Van Buren St, Brooklyn, NY 11221';

const TEXT = `Hi,

Thanks for being on the Dot Dash list.

A quick heads-up: there will be another way to get a Dot Dash soon. You'll hear about it here first.

So this doesn't get lost, could you do two quick things?

1. Add hello@dotdashdevice.com to your contacts.
2. If you found this in spam or the Promotions tab, move it to your inbox and mark it "Not spam."

That's what tells your inbox to let the next one through.

Talk soon,
Sam
Dot Dash

--
You're getting this because you joined the Dot Dash list.
Unsubscribe: %UNSUB%
${POSTAL}
`;

// Same shell as the welcome email in signup.mjs, so the list sees one sender.
const HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f6f5f3;-webkit-text-size-adjust:100%">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f5f3">
<tr><td align="center" style="padding:28px 12px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="520" style="width:100%;max-width:520px;background:#ffffff;border:1px solid #d8d3cb;border-radius:18px">
<tr><td style="padding:26px 24px 22px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1b1a18">
<p style="margin:0 0 16px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:20px;line-height:1.2;letter-spacing:.04em">DOT DASH</p>
<p style="margin:0 0 12px">Hi,</p>
<p style="margin:0 0 12px">Thanks for being on the Dot Dash list.</p>
<p style="margin:0 0 12px">A quick heads-up: there will be another way to get a Dot Dash soon. You&rsquo;ll hear about it here first.</p>
<p style="margin:0 0 8px">So this doesn&rsquo;t get lost, could you do two quick things?</p>
<ol style="margin:0 0 12px;padding-left:22px">
<li style="margin:0 0 6px">Add <strong>hello@dotdashdevice.com</strong> to your contacts.</li>
<li style="margin:0">If you found this in spam or the Promotions tab, move it to your inbox and mark it &ldquo;Not spam.&rdquo;</li>
</ol>
<p style="margin:0 0 12px">That&rsquo;s what tells your inbox to let the next one through.</p>
<p style="margin:0">Talk soon,<br>Sam<br>Dot Dash</p>
</td></tr>
<tr><td style="padding:0 24px 20px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#55514b;border-top:1px solid #ece8e1">
<p style="margin:14px 0 0">You&rsquo;re getting this because you joined the Dot Dash list. <a href="%UNSUB%" style="color:#2563eb">Unsubscribe</a>.</p>
<p style="margin:6px 0 0">Dot Dash &middot; 467 Van Buren St, Brooklyn, NY 11221</p>
</td></tr></table>
</td></tr></table>
</body></html>`;

// ------------------------------------------------------------------ config
const ENV_FILE = process.env.SIGNUP_ENV || '/root/dotdash_bridge/signup.env';
const STORE_DIR = process.env.SIGNUP_DIR || '/var/lib/dotdash-signup';
const SENT_DIR = path.join(STORE_DIR, 'broadcasts');
const SENT_FILE = path.join(SENT_DIR, `${CAMPAIGN}.jsonl`);
const MAX_SEND_RETRIES = 3;
const REFRESH_EVERY = Number(process.env.BCAST_REFRESH || 20);       // re-read the audience after this many sends
const BATCH_MINUTE_MIN = 5;     // this many contacts created in one minute = an import

// systemd parses signup.env itself for the signup unit; a shell would choke on
// EMAIL_FROM's angle brackets. So read it here the same way, never via `. file`.
function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
const env = { ...loadEnv(ENV_FILE), ...process.env };
const API_KEY = env.RESEND_API_KEY;
const AUDIENCE = env.RESEND_AUDIENCE_ID;
const FROM = env.EMAIL_FROM || 'Dot Dash <hello@dotdashdevice.com>';
// The email asks people to save hello@ and reply; replies must go there too.
const REPLY_TO = env.BROADCAST_REPLY_TO || 'hello@dotdashdevice.com';
const SITE = env.SITE_URL || 'https://dotdashdevice.com';

// ------------------------------------------------- unsubscribe (as signup.mjs)
const SECRET = env.SIGNUP_SECRET || (() => {
  const f = path.join(STORE_DIR, 'secret');
  // Never CREATE the secret here: a new one would not match the signup
  // service's, and every link in this email would be refused.
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, 'utf8').trim();
})();
const norm = (e) => e.toLowerCase().trim();
const hash = (e) => crypto.createHash('sha256').update(norm(e)).digest('hex');
const sign = (e) => crypto.createHmac('sha256', SECRET).update(norm(e)).digest('base64url').slice(0, 27);
const unsubUrl = (e) =>
  `${SITE}/signup/api/unsubscribe?e=${Buffer.from(norm(e)).toString('base64url')}&s=${sign(e)}`;

// ----------------------------------------------------------------- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(stamp(), ...a);
const mask = (e) => { const [u, d] = e.split('@'); return `${u.slice(0, 2)}…@${d}`; };

async function resend(method, url, body) {
  const r = await fetch(`https://api.resend.com${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'dotdash-broadcast/1.0',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { ok: r.ok, status: r.status, json, text, headers: r.headers };
}

// Every contact in the audience, following pagination if Resend offers it.
async function audience() {
  const all = []; let after = null;
  for (let page = 0; page < 100; page++) {
    const q = after ? `?limit=100&after=${encodeURIComponent(after)}` : '?limit=100';
    const r = await resend('GET', `/audiences/${AUDIENCE}/contacts${q}`);
    if (!r.ok) throw new Error(`list contacts ${r.status}: ${r.text.slice(0, 200)}`);
    const rows = r.json?.data || [];
    all.push(...rows);
    if (!r.json?.has_more || !rows.length) break;
    after = rows[rows.length - 1].id;
  }
  return all;
}

function readSent() {
  const s = new Set();
  if (!fs.existsSync(SENT_FILE)) return s;
  for (const l of fs.readFileSync(SENT_FILE, 'utf8').split('\n')) {
    if (!l) continue;
    try { s.add(JSON.parse(l).h); } catch { /* torn line */ }
  }
  return s;
}

// Website signups first (oldest first: they have waited longest), then imports.
function order(contacts) {
  const perMinute = new Map();
  for (const c of contacts) {
    const m = String(c.created_at || '').slice(0, 16);
    perMinute.set(m, (perMinute.get(m) || 0) + 1);
  }
  const isImport = (c) => (perMinute.get(String(c.created_at || '').slice(0, 16)) || 0) >= BATCH_MINUTE_MIN;
  const byAge = (a, b) => String(a.created_at).localeCompare(String(b.created_at));
  const direct = contacts.filter((c) => !isImport(c)).sort(byAge);
  const imported = contacts.filter(isImport).sort(byAge);
  return { direct, imported, all: [...direct, ...imported] };
}

async function sendOne(email) {
  const url = unsubUrl(email);
  const payload = {
    from: FROM, reply_to: REPLY_TO, to: email, subject: SUBJECT,
    text: TEXT.replace('%UNSUB%', url),
    html: HTML.replace('%UNSUB%', url.replace(/&/g, '&amp;')),
    headers: {
      'List-Unsubscribe': `<${url}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
  for (let attempt = 0; ; attempt++) {
    const r = await resend('POST', '/emails', payload);
    if (r.ok) return r.json?.id || '(no id)';
    // 429 and 5xx are worth another go; a 4xx (bad address) never is.
    const retry = r.status === 429 || r.status >= 500;
    if (!retry || attempt >= MAX_SEND_RETRIES) throw new Error(`${r.status}: ${r.text.slice(0, 200)}`);
    await sleep(5000 * 2 ** attempt);
  }
}

// --------------------------------------------------------------------- main
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const LIVE = flag('--live');
const TEST = val('--test', null);
const HOURS = Number(val('--hours', '12'));

if (!API_KEY || !AUDIENCE) { console.error(`RESEND_API_KEY and RESEND_AUDIENCE_ID must be set (read from ${ENV_FILE})`); process.exit(2); }
if (!SECRET) { console.error(`No unsubscribe secret at ${STORE_DIR}/secret. Refusing: links would not work.`); process.exit(2); }
if (!(HOURS > 0 && HOURS <= 72)) { console.error('--hours must be between 0 and 72'); process.exit(2); }

if (TEST) {
  const id = await sendOne(TEST);
  log(`TEST sent to ${TEST}: ${id}`);
  log(`from: ${FROM} | reply-to: ${REPLY_TO} | subject: ${SUBJECT}`);
  process.exit(0);
}

let contacts = await audience();
const active = (list) => list.filter((c) => c.email && !c.unsubscribed);
const sent = readSent();
let { direct, imported, all } = order(active(contacts));
let todo = all.filter((c) => !sent.has(hash(c.email)));

const gapMs = todo.length ? (HOURS * 3600_000) / todo.length : 0;
log(`audience: ${contacts.length} contacts, ${contacts.length - active(contacts).length} unsubscribed`);
log(`order: ${direct.length} website signups first, then ${imported.length} imported`);
log(`already sent in ${CAMPAIGN}: ${sent.size} | to send now: ${todo.length}`);
log(`pace: one every ~${(gapMs / 60000).toFixed(1)} min (±30%), over ~${HOURS} h`);
log(`from: ${FROM} | reply-to: ${REPLY_TO}`);

if (!LIVE) {
  log('DRY RUN: nothing sent. First five in order:');
  for (const c of todo.slice(0, 5)) log(`   ${mask(c.email)}  created ${String(c.created_at).slice(0, 16)}`);
  console.log('\n--- subject ---\n' + SUBJECT + '\n--- text part (first recipient) ---\n' +
    (todo[0] ? TEXT.replace('%UNSUB%', unsubUrl(todo[0].email)) : '(nobody left to send to)'));
  process.exit(0);
}

fs.mkdirSync(SENT_DIR, { recursive: true, mode: 0o700 });
let ok = 0, failed = 0, sinceRefresh = 0;
// The latest copy of the audience, checked before EVERY send, and re-read every
// REFRESH_EVERY sends -- so someone who unsubscribes during the day is skipped
// from the next refresh on, not only if they happen to be next in line.
let current = new Map(contacts.map((x) => [norm(x.email), x]));
for (let i = 0; i < todo.length; i++) {
  const c = todo[i];

  if (sinceRefresh >= REFRESH_EVERY) {
    sinceRefresh = 0;
    try {
      current = new Map((await audience()).map((x) => [norm(x.email), x]));
    } catch (e) { log(`audience refresh failed (${e.message}); carrying on with the last copy`); }
  }
  const fresh = current.get(norm(c.email));
  if (!fresh || fresh.unsubscribed) { log(`skip ${mask(c.email)}: unsubscribed or removed`); continue; }

  try {
    const id = await sendOne(c.email);
    fs.appendFileSync(SENT_FILE, JSON.stringify({ h: hash(c.email), t: Date.now(), id }) + '\n', { mode: 0o600 });
    ok++; sinceRefresh++;
    log(`${ok + failed}/${todo.length} OK   ${mask(c.email)}  ${id}`);
  } catch (e) {
    failed++;
    log(`${ok + failed}/${todo.length} FAIL ${mask(c.email)}  ${e.message}`);
  }

  if (i < todo.length - 1) await sleep(gapMs * (0.7 + Math.random() * 0.6));
}
log(`done: ${ok} sent, ${failed} failed. A re-run sends only to those not yet sent.`);
process.exit(failed ? 1 : 0);
