/**
 * Inspect or revert ONE device's own broker key. Run on the droplet from
 * /root/dotdash_bridge with DYNSEC_ADMIN_USER / DYNSEC_ADMIN_PASS set.
 *
 *   node devicekey.mjs status <NAME+PIN | hash>
 *   node devicekey.mjs revoke <NAME+PIN | hash>   key removed, enrollment refused:
 *                                                 the device falls back to the
 *                                                 shared login and STAYS there
 *   node devicekey.mjs allow  <NAME+PIN | hash>   lift the refusal; the device
 *                                                 enrolls again on its next try
 *
 * A device is named by its child ID (e.g. INSTA0515) or its 64-hex hash.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import mqtt from 'mqtt';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const [action, who] = process.argv.slice(2);
if (!['status', 'revoke', 'allow'].includes(action) || !who) {
  console.error('usage: node devicekey.mjs status|revoke|allow <NAME+PIN | hash>');
  process.exit(2);
}
// Every id is hashed LOWERCASED and trimmed, like the app and firmware.
const hash = /^[0-9a-f]{64}$/i.test(who) ? who.toLowerCase()
  : crypto.createHash('sha256').update(who.trim().toLowerCase()).digest('hex');

initializeApp({ credential: cert(JSON.parse(fs.readFileSync('/root/dotdash_bridge/service-account.json', 'utf8'))) });
const db = getFirestore();
const snap = await db.collectionGroup('devices').where('hashedId', '==', hash).get();
if (snap.empty) { console.error(`no paired device has hash ${hash.slice(0, 12)}...`); process.exit(1); }

const admin = mqtt.connect('mqtts://mqtt.dotdashdevice.com:8885', {
  username: process.env.DYNSEC_ADMIN_USER, password: process.env.DYNSEC_ADMIN_PASS, reconnectPeriod: 0,
});
await new Promise((resolve, reject) => { admin.once('connect', resolve); admin.once('error', reject); });
admin.subscribe('$CONTROL/dynamic-security/v1/response');
function dynsec(command) {
  return new Promise((resolve) => {
    const correlationData = crypto.randomBytes(6).toString('hex');
    const onMsg = (t, p) => {
      const r = (JSON.parse(p.toString()).responses || []).find((x) => x.correlationData === correlationData);
      if (r) { admin.removeListener('message', onMsg); resolve(r); }
    };
    admin.on('message', onMsg);
    admin.publish('$CONTROL/dynamic-security/v1', JSON.stringify({ commands: [{ ...command, correlationData }] }));
    setTimeout(() => resolve({ error: 'timeout' }), 6000);
  });
}

for (const d of snap.docs) {
  const v = d.data();
  if (action === 'revoke') {
    await d.ref.update({ 'mqttKey.disabled': true, 'mqttKey.revokedAt': FieldValue.serverTimestamp() });
    await dynsec({ command: 'deleteClient', username: hash });
    await dynsec({ command: 'deleteRole', rolename: `device-${hash}` });
  } else if (action === 'allow') {
    await d.ref.update({ 'mqttKey.disabled': false });
  }
  const key = await dynsec({ command: 'getClient', username: hash });
  const fresh = (await d.ref.get()).data()?.mqttKey || {};
  const when = (t) => (t && t.toDate ? t.toDate().toISOString() : '-');
  console.log(`${v.identity?.name}${v.identity?.pin}  device ${d.id}  hash ${hash.slice(0, 12)}...`);
  console.log(`  key on broker:       ${key.error ? 'none' : 'yes'}`);
  console.log(`  enrollment:          ${fresh.disabled ? 'DISABLED (revoked)' : 'allowed'}`);
  console.log(`  enrolled at:         ${when(fresh.enrolledAt)}`);
  console.log(`  revoked at:          ${when(fresh.revokedAt)}`);
  console.log(`  conflicts:           ${fresh.conflicts || 0}  (last ${when(fresh.conflictAt)})`);
}
admin.end(true);
process.exit(0);
