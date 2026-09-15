/**
 * Database rules: check, deploy, roll back. Runs on the droplet from
 * /root/dotdash_bridge, where the service account lives -- no Firebase CLI.
 *
 *   node rules.mjs show                  print the live rules
 *   node rules.mjs livetest              run the cases below against the LIVE rules
 *   node rules.mjs deploy <rules file>   compile, release, live-test, and roll back
 *                                        on its own if the cases do not pass
 *   node rules.mjs rollback <ruleset>    re-release an earlier ruleset
 *
 * The service account may create and release rulesets but not use the Rules
 * API's offline tester, so the cases run for real: two throwaway users (see
 * testusers.mjs) reading and writing throwaway identity records over the
 * Firestore REST API, the same way the app does. Each case seeds exactly the
 * records it needs first, and everything is removed at the end.
 *
 * New rules take up to a minute to reach every server, so deploy retries the
 * cases for two minutes before deciding they failed.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { testUser, deleteTestUsers, PROJECT as P } from './testusers.mjs';

const [cmd, arg] = process.argv.slice(2);
const SA_PATH = process.env.SERVICE_ACCOUNT || '/root/dotdash_bridge/service-account.json';
const sa = JSON.parse(fs.readFileSync(SA_PATH, 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- rules API --
const API = 'https://firebaserules.googleapis.com/v1';
async function rulesApi(method, path, body) {
  const { access_token } = await cert(sa).getAccessToken();
  const res = await fetch(`${API}/${path}`, {
    method, headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${JSON.stringify(json.error || json)}`);
  return json;
}
const RELEASE = `projects/${P}/releases/cloud.firestore`;
const currentRelease = () => rulesApi('GET', RELEASE);
const release = (rulesetName) => rulesApi('PATCH', RELEASE, { release: { name: RELEASE, rulesetName } });

// ------------------------------------------------------------ live cases --
const H = (s) => crypto.createHash('sha256').update(s.trim().toLowerCase()).digest('hex');
const rid = (p) => p + crypto.randomBytes(3).toString('hex').replace(/[0-9]/g, 'X').toUpperCase() + String(1000 + crypto.randomInt(8999));
const DOCS = `projects/${P}/databases/(default)/documents`;
const IDS = 'artifacts/dotdash/public/data/identities';

const fields = (o) => ({ fields: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'boolean' ? { booleanValue: v } : { stringValue: String(v) }])) });

// What the rules did: ALLOW (2xx, or 404 for a permitted read of nothing) / DENY (403).
async function rest(token, method, path, body) {
  const res = await fetch(`https://firestore.googleapis.com/v1/${DOCS}/${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.ok || (res.status === 404 && method === 'GET')) return 'ALLOW';
  if (res.status === 403) return 'DENY';
  return `HTTP ${res.status} ${(await res.text()).slice(0, 120)}`;
}

async function liveTest() {
  const A = await testUser('rulestest-a');
  const B = await testUser('rulestest-b');
  const KID = rid('RTKID'), KIDH = H(KID);
  const DAD = rid('RTDAD'), DADH = H(DAD);
  const OTHER = rid('RTOTHER'), OTHERH = H(OTHER);
  const rec = (owner, idString, type = 'child') => ({ owner, idString, type });
  const seeded = new Set();
  const seed = async (docs) => {
    for (const [h, data] of Object.entries(docs)) {
      seeded.add(h);
      if (data) await db.doc(`${IDS}/${h}`).set(data); else await db.doc(`${IDS}/${h}`).delete();
    }
  };
  const create = (u, h, data) => rest(u?.idToken, 'POST', `${IDS}?documentId=${h}`, fields(data));
  const update = (u, h, data) => rest(u?.idToken, 'PATCH', `${IDS}/${h}?currentDocument.exists=true`, fields(data));

  // [expect, name, seed, action]
  const cases = [
    ['DENY', 'signed out: read an identity', { [KIDH]: rec(A.uid, KID) }, () => rest(null, 'GET', `${IDS}/${KIDH}`)],
    ['ALLOW', 'signed in: read one identity (the "taken?" check)', { [KIDH]: rec(A.uid, KID) }, () => rest(B.idToken, 'GET', `${IDS}/${KIDH}`)],
    ['ALLOW', 'signed in: read an identity that does not exist', { [KIDH]: null }, () => rest(B.idToken, 'GET', `${IDS}/${KIDH}`)],
    ['DENY', 'signed in: LIST every identity', {}, () => rest(B.idToken, 'GET', `${IDS}?pageSize=1`)],
    ['ALLOW', 'create own child identity', { [KIDH]: null }, () => create(A, KIDH, rec(A.uid, KID))],
    ['ALLOW', 'create own parent identity', { [DADH]: null }, () => create(A, DADH, rec(A.uid, DAD, 'parent'))],
    ['DENY', 'create naming someone else as owner', { [OTHERH]: null }, () => create(B, OTHERH, rec(A.uid, OTHER))],
    ['DENY', 'create on a hash that is not that ID', { [OTHERH]: null }, () => create(B, OTHERH, rec(B.uid, KID))],
    ['DENY', 'create with an extra field', { [OTHERH]: null }, () => create(B, OTHERH, { ...rec(B.uid, OTHER), admin: true })],
    ['DENY', 'create with a made-up type', { [OTHERH]: null }, () => create(B, OTHERH, rec(B.uid, OTHER, 'root'))],
    ['ALLOW', 'owner rewrites own identity (re-pairing)', { [KIDH]: rec(A.uid, KID) }, () => update(A, KIDH, rec(A.uid, KID))],
    ['DENY', 'OVERWRITE another family\'s identity', { [KIDH]: rec(A.uid, KID) }, () => update(B, KIDH, rec(B.uid, KID))],
    ['DENY', 'owner hands an identity to someone else', { [KIDH]: rec(A.uid, KID) }, () => update(A, KIDH, rec(B.uid, KID))],
    ['DENY', 'DELETE another family\'s identity', { [KIDH]: rec(A.uid, KID) }, () => rest(B.idToken, 'DELETE', `${IDS}/${KIDH}`)],
    ['ALLOW', 'owner deletes own identity (unlink)', { [KIDH]: rec(A.uid, KID) }, () => rest(A.idToken, 'DELETE', `${IDS}/${KIDH}`)],
    ['DENY', 'write elsewhere under public/data', {}, () => rest(B.idToken, 'POST', `artifacts/dotdash/public/data/rulestest?documentId=x`, fields({ a: 'b' }))],
    ['ALLOW', 'read own device list', {}, () => rest(A.idToken, 'GET', `artifacts/dotdash/users/${A.uid}/devices`)],
    ['DENY', 'read another family\'s device list', {}, () => rest(B.idToken, 'GET', `artifacts/dotdash/users/${A.uid}/devices`)],
  ];

  let failed = 0;
  const lines = [];
  try {
    for (const [expect, name, docs, action] of cases) {
      await seed(docs);
      const got = await action();
      const ok = got === expect;
      if (!ok) failed++;
      lines.push(`${ok ? 'PASS' : 'FAIL'}  ${expect.padEnd(5)} ${name}${ok ? '' : `   (got ${got})`}`);
    }
  } finally {
    for (const h of seeded) await db.doc(`${IDS}/${h}`).delete().catch(() => {});
    await db.doc('artifacts/dotdash/public/data/rulestest/x').delete().catch(() => {});
    await deleteTestUsers([A.uid, B.uid]).catch((e) => lines.push(`cleanup: ${e.message}`));
  }
  return { ok: failed === 0, lines, summary: `${cases.length - failed}/${cases.length} passed` };
}

// ----------------------------------------------------------------- main --
if (cmd === 'show') {
  const rel = await currentRelease();
  const rs = await rulesApi('GET', rel.rulesetName);
  console.log(`// ${rel.rulesetName} (released ${rel.updateTime})\n${rs.source.files[0].content}`);
} else if (cmd === 'livetest') {
  const r = await liveTest();
  console.log(r.lines.join('\n')); console.log(r.summary);
  process.exit(r.ok ? 0 : 1);
} else if (cmd === 'deploy' && arg) {
  const before = await currentRelease();
  // Creating a ruleset compiles it; a syntax error is refused here, before any release.
  const rs = await rulesApi('POST', `projects/${P}/rulesets`, { source: { files: [{ name: 'firestore.rules', content: fs.readFileSync(arg, 'utf8') }] } });
  console.log(`compiled ${rs.name}`);
  await release(rs.name);
  console.log(`RELEASED -- previous was ${before.rulesetName}\ntesting live (rules can take a minute to spread)...`);
  const deadline = Date.now() + 120_000;
  let r;
  for (;;) {
    r = await liveTest();
    if (r.ok || Date.now() > deadline) break;
    console.log(`  not yet (${r.summary}), retrying`);
    await sleep(15_000);
  }
  console.log(r.lines.join('\n')); console.log(r.summary);
  if (!r.ok) {
    await release(before.rulesetName);
    console.log(`\nROLLED BACK to ${before.rulesetName}`);
    process.exit(1);
  }
  console.log(`\nroll back if ever needed: node rules.mjs rollback ${before.rulesetName}`);
} else if (cmd === 'rollback' && arg) {
  await release(arg);
  console.log(`released ${arg}`);
} else {
  console.error('usage: node rules.mjs show | livetest | deploy <file> | rollback <ruleset>');
  process.exit(2);
}
