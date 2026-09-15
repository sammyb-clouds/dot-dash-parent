/**
 * Throwaway Firebase users for tests, made with the service account -- no
 * passwords, no real account touched.
 *
 *   const u = await testUser('rulestest-a');   // { uid, idToken }
 *   await deleteTestUsers([u.uid]);
 *
 * A custom token is signed with the service account's key and exchanged for an
 * ordinary ID token, exactly what a signed-in app holds. The exchange creates
 * the user, so every test must delete its users when it finishes.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { cert } from 'firebase-admin/app';

const sa = JSON.parse(fs.readFileSync(process.env.SERVICE_ACCOUNT || '/root/dotdash_bridge/service-account.json', 'utf8'));
export const PROJECT = sa.project_id;
// The app's public web API key (it is in every copy of the app).
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyBbVZw3R8YbWgAPaj3LCqM4qajdTRdN3LU';
const REFERER = 'https://app.dotdashdevice.com/';

const b64 = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');

export function customToken(uid) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const body = b64({
    iss: sa.client_email, sub: sa.client_email, uid, iat: now, exp: now + 3600,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
  });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), sa.private_key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

export async function testUser(prefix) {
  const uid = `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Referer: REFERER },
    body: JSON.stringify({ token: customToken(uid), returnSecureToken: true }),
  });
  const j = await res.json();
  if (!j.idToken) throw new Error(`signInWithCustomToken: ${JSON.stringify(j.error || j)}`);
  return { uid, idToken: j.idToken, refreshToken: j.refreshToken, expiresIn: j.expiresIn };
}

export async function deleteTestUsers(uids) {
  const { access_token } = await cert(sa).getAccessToken();
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:batchDelete`, {
    method: 'POST', headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ localIds: uids, force: true }),
  });
  if (!res.ok) throw new Error(`batchDelete: ${res.status} ${await res.text()}`);
}
