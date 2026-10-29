// Asserts signCallToken (extracted from enroll.mjs, which cannot be imported
// without starting the service) reproduces the voice-bridge test vector.
// Run: node bridge/test-call-token.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./enroll.mjs', import.meta.url), 'utf8');
const start = src.indexOf('const b64url =');
const end = src.indexOf('// Missing or malformed secret', start);
if (start < 0 || end < 0) { console.error('FAIL: could not locate signCallToken in enroll.mjs'); process.exit(2); }
const signCallToken = new Function('crypto', `${src.slice(start, end)}; return signCallToken;`)(crypto);

const secret = Buffer.from('0f'.repeat(32), 'hex');
const payload = { tag: 'Ab3dE6gH', dev: 'a'.repeat(64), uid: 'testuid', jti: '0123456789abcdef', exp: 1900000000 };
const expected = 'v1.eyJ0YWciOiJBYjNkRTZnSCIsImRldiI6ImFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWEiLCJ1aWQiOiJ0ZXN0dWlkIiwianRpIjoiMDEyMzQ1Njc4OWFiY2RlZiIsImV4cCI6MTkwMDAwMDAwMH0.BxcVls4Ne1qEaRecQfIdGKjt87GSzMgXvs1Y-AeTiLU';
const got = signCallToken(payload, secret);
if (got !== expected) { console.error('FAIL\n got:      ' + got + '\n expected: ' + expected); process.exit(1); }
console.log('PASS: call-token vector matches');
