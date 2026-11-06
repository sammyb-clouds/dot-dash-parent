// Import an opted-in CSV into the Website audience, without emailing anyone.
//
// The giveaway app exports "Mailing list CSV" (admin -> exports): one row per
// person who ticked "Do you want to receive messages about future Dot Dash
// news?", which is unchecked by default. That is the same promise the home-page
// box makes, which is why those addresses may be merged into one list.
//
// Two halves, because the two systems live in different places:
//   1. Resend  -- POST each address to the audience. Creating a contact sends
//                 NOTHING; this script never calls /emails. People who signed
//                 up elsewhere must not get the home page's welcome message.
//   2. the hash store -- append sha256(lowercased address) to signups.jsonl on
//                 the droplet, so the public count includes them AND the
//                 welcome-once rule already knows them: an imported person who
//                 later uses the form is told "you are already on the list"
//                 and is not written to.
//
// Half 2 is why this is not just a Resend CSV upload. Skipping it leaves the
// count wrong and arms a welcome email for 250 people who never asked for one.
//
//   node import-list.mjs list.csv            # dry run: parse, validate, report
//   node import-list.mjs list.csv --live     # do it
//
// Needs RESEND_API_KEY and RESEND_AUDIENCE_ID in the environment. The droplet
// half runs over ssh as root@45.55.47.32 and restarts dotdash-signup.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [, , file, ...flags] = process.argv;
const LIVE = flags.includes('--live');
const HOST = process.env.SIGNUP_HOST || 'root@45.55.47.32';
const KEY = process.env.RESEND_API_KEY, AUD = process.env.RESEND_AUDIENCE_ID;
if (!file) { console.error('usage: node import-list.mjs <csv> [--live]'); process.exit(2); }
if (LIVE && (!KEY || !AUD)) { console.error('RESEND_API_KEY and RESEND_AUDIENCE_ID must be set'); process.exit(2); }

// --------------------------------------------------------------- parse
// Minimal CSV: the export has no embedded commas in the columns we read, but
// quoted fields are handled anyway because a name like "Smith, J" would
// otherwise shift every column after it.
const parse = (text) => {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
};

const rows = parse(fs.readFileSync(file, 'utf8'));
const head = rows.shift().map(h => h.trim().toLowerCase());
const iEmail = head.indexOf('email'), iAt = head.indexOf('opted_in_at');
if (iEmail < 0) { console.error('no "email" column'); process.exit(2); }

// Same normalisation as the service and the MQTT topic keys: lowercase and
// trim FIRST, or one person hashes two different ways.
const norm = (e) => e.trim().toLowerCase();
const ok = /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/;
const seen = new Set(), list = [], bad = [], dup = [];
for (const r of rows) {
  const e = norm(r[iEmail] || '');
  if (!ok.test(e) || e.length > 254) { bad.push(r[iEmail]); continue; }
  if (seen.has(e)) { dup.push(e); continue; }
  seen.add(e);
  const t = iAt >= 0 ? Date.parse(r[iAt]) : NaN;
  list.push({ email: e, t: Number.isFinite(t) ? t : Date.now() });
}
console.log(`${list.length} valid, ${dup.length} duplicate, ${bad.length} malformed`);
for (const b of bad) console.log('  malformed:', b);
if (!LIVE) { console.log('\ndry run -- pass --live to import'); process.exit(0); }

// ------------------------------------------------------------ 1. Resend
// Paced: the API limits requests per second, and a 429 here would look like a
// partial import. Retries with backoff rather than dropping anyone.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let made = 0; const failed = [];
for (const [i, p] of list.entries()) {
  let r, body, tries = 0;
  while (tries++ < 4) {
    r = await fetch(`https://api.resend.com/audiences/${AUD}/contacts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: p.email, unsubscribed: false }),
    });
    body = await r.text();
    if (r.status !== 429) break;
    await sleep(1500 * tries);
  }
  if (r.ok) made++; else failed.push(`${p.email} ${r.status} ${body.slice(0, 120)}`);
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${list.length}`);
  await sleep(600);
}
console.log(`Resend: ${made}/${list.length} added`);
for (const f of failed) console.log('  FAIL', f);

// -------------------------------------------------- 2. the hash store
// Written through a temp file and a python merge rather than a plain append:
// re-running the same CSV must not double the count, and the backup is taken
// before anything is touched.
const seedPath = `${process.env.TMPDIR || '/tmp'}/dd-seed-${Date.now()}.jsonl`;
fs.writeFileSync(seedPath, list.map(p =>
  JSON.stringify({ e: crypto.createHash('sha256').update(p.email).digest('hex'), t: p.t })).join('\n') + '\n');
execFileSync('scp', ['-q', seedPath, `${HOST}:/tmp/dd-seed.jsonl`], { stdio: 'inherit' });
fs.unlinkSync(seedPath);
const remote = `set -e
S=/var/lib/dotdash-signup/signups.jsonl
cp "$S" "$S.bak-$(date +%Y%m%d%H%M%S)"
python3 - <<'PY'
import json
S='/var/lib/dotdash-signup/signups.jsonl'
have=set()
for l in open(S):
    l=l.strip()
    if l:
        try: have.add(json.loads(l)['e'])
        except Exception: pass
new=[]
for l in open('/tmp/dd-seed.jsonl'):
    l=l.strip()
    if not l: continue
    r=json.loads(l)
    if r['e'] in have: continue
    have.add(r['e']); new.append(l)
with open(S,'a') as f:
    for l in new: f.write(l+'\\n')
print('store: appended', len(new))
PY
rm -f /tmp/dd-seed.jsonl
chmod 644 "$S"
systemctl restart dotdash-signup`;
execFileSync('ssh', [HOST, 'bash', '-s'], { input: remote, stdio: ['pipe', 'inherit', 'inherit'] });
await sleep(1200);
const c = await (await fetch('https://dotdashdevice.com/signup/api/count')).json();
console.log(`live count: ${c.count} (shown: ${c.show})`);
