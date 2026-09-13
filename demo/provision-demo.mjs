/**
 * Provisions the App Store / TestFlight review demo account.
 *
 * Reviewers cannot pair hardware they do not have, and an app that opens onto a
 * sign-in wall with an empty shell behind it is the standard rejection for a
 * hardware companion. So this writes, directly, everything the normal pairing
 * flow would have written:
 *
 *   - a Firebase Auth user the reviewer signs in as
 *   - profile/parent, so the app does not bounce to the ID setup screen
 *   - one device, so Chat and Monitor have a child to talk to
 *   - the two public identity records that pairing claims
 *   - a short chat history, so the first screen is not empty
 *
 * Presence and live traffic come from demo-device.mjs, which runs beside the
 * bridge and keeps this child looking online.
 *
 * Re-runnable: every write is idempotent, and the password is reset each time.
 *
 *   node provision-demo.mjs [--password <pw>]
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { GoogleAuth } from 'google-auth-library';
import crypto from 'node:crypto';
import fs from 'node:fs';

const SERVICE_ACCOUNT = process.env.SERVICE_ACCOUNT || '/root/dotdash_bridge/service-account.json';
const APP_ID = 'dotdash';

// The demo family. Deliberately not a real name: this identity is public in the
// identities collection and anyone can send a friend request to it.
const PARENT_ID = 'DEMO0101';
const CHILD_NAME = 'ROBIN';
const CHILD_PIN = '0614';
const DEVICE_MAC = 'A0:B1:C2:D3:E4:F5';
const EMAIL = process.env.DEMO_EMAIL || 'appreview@dotdashdevice.com';

const DEFAULT_PHRASES = ['HELLO!', 'HOW ARE YOU?', 'COME OVER?', 'MEET AT PARK?', 'GREAT!', 'OK',
  'MAYBE LATER', 'BUSY', ':)', ':(', 'ASKING PARENT', 'CALL MY PARENT', 'BYE!'];

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function password() {
  const i = process.argv.indexOf('--password');
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  // Apple's reviewers type this by hand, so keep it unambiguous: no characters
  // that read as each other in a proportional font.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(16)).map((b) => alphabet[b % alphabet.length]).join('');
}

const sa = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT, 'utf8'));
const app = initializeApp({ credential: cert(sa) });
const db = getFirestore(app);

// The Auth user is created over the Identity Toolkit REST API rather than
// firebase-admin/auth: that module pulls in jwks-rsa -> jose, which is ESM and
// cannot be require()d on the droplet's Node 18. The bridge never noticed
// because it only ever touches app, firestore and messaging.
const googleAuth = new GoogleAuth({ credentials: sa, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const accessToken = (await (await googleAuth.getClient()).getAccessToken()).token;
const IDT = `https://identitytoolkit.googleapis.com/v1/projects/${sa.project_id}`;

async function idt(path, body) {
  const res = await fetch(`${IDT}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const pw = password();

const found = await idt('/accounts:lookup', { email: [EMAIL] });
let uid;
if (found.users && found.users.length) {
  uid = found.users[0].localId;
  await idt('/accounts:update', { localId: uid, password: pw, emailVerified: true, disableUser: false });
  console.log('reusing existing auth user', uid);
} else {
  const created = await idt('/accounts', { email: EMAIL, password: pw, emailVerified: true });
  uid = created.localId;
  console.log('created auth user', uid);
}
const childId = CHILD_NAME + CHILD_PIN;
const childHash = sha256(childId);
const parentHash = sha256(PARENT_ID);
const base = ['artifacts', APP_ID];

await db.doc([...base, 'users', uid, 'profile', 'parent'].join('/')).set({
  email: EMAIL, virtualId: PARENT_ID,
});

await db.doc([...base, 'users', uid, 'devices', DEVICE_MAC].join('/')).set({
  pairingCode: 'DEMO01',
  hashedId: childHash,
  identity: { name: CHILD_NAME, pin: CHILD_PIN },
  friends: [PARENT_ID],
  phrases: DEFAULT_PHRASES,
});

await db.doc([...base, 'public', 'data', 'identities', parentHash].join('/'))
  .set({ owner: uid, idString: PARENT_ID, type: 'parent' });
await db.doc([...base, 'public', 'data', 'identities', childHash].join('/'))
  .set({ owner: uid, idString: childId, type: 'child' });

// A little history, so Chat opens onto a conversation rather than a blank page.
// Ids are epoch millis, which is what the app sorts and de-duplicates on.
const now = Date.now();
const history = [
  { back: 52, text: 'HELLO!' },
  { back: 47, text: 'HOW ARE YOU?' },
  { back: 41, text: 'GREAT!' },
  { back: 12, text: 'MEET AT PARK?' },
];
const batch = db.batch();
for (const h of history) {
  const id = now - h.back * 60000;
  batch.set(db.doc([...base, 'users', uid, 'messages', String(id)].join('/')), {
    id, type: 'TEXT', text: h.text, sender: childId,
  });
}
await batch.commit();

console.log(`
  demo account provisioned
  ------------------------
  email     ${EMAIL}
  password  ${pw}

  parent id ${PARENT_ID}
  child     ${childId}   (hash ${childHash.slice(0, 16)}...)
  device    ${DEVICE_MAC}
  uid       ${uid}

  Put the email and password in App Store Connect under App Review Information
  (and TestFlight -> Test Information for external testing). Start the virtual
  device with demo-device.mjs so the child shows as online.
`);
process.exit(0);
