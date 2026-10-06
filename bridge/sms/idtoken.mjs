/**
 * Firebase ID token verification without firebase-admin's auth module. The same
 * checks as enroll.mjs's verifyIdToken (signature, algorithm, audience, issuer,
 * expiry, subject) -- kept as its own copy so the SMS service can ship without
 * touching the live enrollment service. Fold the two together when next editing
 * enroll.mjs.
 */
import crypto from 'node:crypto';

const GOOGLE_CERTS = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

export function makeVerifier(projectId) {
  let certs = { keys: {}, until: 0, fetchedAt: 0 };

  async function signingKeys(force = false) {
    const now = Date.now();
    if (!force && now < certs.until) return certs.keys;
    if (force && now - certs.fetchedAt < 60_000) return certs.keys;   // an unknown kid cannot make us hammer Google
    const res = await fetch(GOOGLE_CERTS);
    if (!res.ok) throw new Error(`signing keys: HTTP ${res.status}`);
    const maxAge = parseInt(/max-age=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1] || '3600', 10);
    const pems = await res.json();
    const keys = Object.fromEntries(Object.entries(pems).map(([kid, pem]) => [kid, new crypto.X509Certificate(pem).publicKey]));
    certs = { keys, until: now + Math.min(maxAge, 6 * 3600) * 1000, fetchedAt: now };
    return keys;
  }

  // The uid a valid token belongs to, or null.
  return async function verifyIdToken(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    let header, claims;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    } catch { return null; }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
    let key = (await signingKeys())[header.kid];
    if (!key) key = (await signingKeys(true))[header.kid];
    if (!key) return null;
    const signed = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
    if (!signed) return null;
    const now = Math.floor(Date.now() / 1000);
    const SKEW = 300;
    if (claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}`) return null;
    if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128) return null;
    if (!(claims.exp > now) || !(claims.iat <= now + SKEW) || !(claims.auth_time <= now + SKEW)) return null;
    return claims.sub;
  };
}
