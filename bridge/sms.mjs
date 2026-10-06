#!/usr/bin/env node
/**
 * Dot Dash SMS bridge.
 *
 *     device <-MQTT-> mosquitto <-> THIS <-REST/webhook-> Twilio <-SMS-> phone
 *
 * A parent-approved phone contact becomes a VIRTUAL FRIEND of one child's
 * device: an ordinary friend ID such as GRANDMA4821, added to the device's
 * friend list exactly like the parent's own ID. The device needs no new
 * firmware -- it sends to that friend by publishing "TEXT,<text>,<me>" on
 * doorbell/msg/<sha256(id)>/<stamp>, which this process is subscribed to, and
 * it receives from that friend when this process publishes "TEXT,<text>,<id>"
 * on the child's own topic. The parent's Monitor sees both directions the way
 * it sees any friend.
 *
 * Contacts are routed by (their number, the pool number they text), so a small
 * pool of Twilio numbers serves every family. See sms/README.md for the model,
 * the rules it keeps, and the COPPA notes.
 *
 * HTTP, on 127.0.0.1 behind nginx:
 *
 *   POST   /sms/inbound                 Twilio's webhook (signature checked)
 *   POST   /sms/contacts                add a contact, by phone or by link  (Firebase ID token)
 *   GET    /sms/contacts                parent lists their contacts
 *   DELETE /sms/contacts/<id>           remove one -- a hard delete
 *   POST   /sms/contacts/<id>/link      a new link for a web contact (the old one dies)
 *   /chat/api/...                        the web contact's chat page -- see sms/service.mjs, chatApi
 *   GET    /internal/pool               pool utilisation   (droplet only)
 *   POST   /internal/sweep              run the sweep now  (droplet only)
 *
 * Consent is the contact's own: a new contact is PENDING and is sent nothing.
 * The parent asks them to send START to the pool number; only then does
 * anything flow, either way. Beyond carrier rules, that is what protects a
 * child from a parent's typo -- a wrong number never hears from us at all.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import mqtt from 'mqtt';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { makeKeys } from './sms/lib.mjs';
import { makeTwilio } from './sms/twilio.mjs';
import { makeVerifier } from './sms/idtoken.mjs';
import { createService } from './sms/service.mjs';

const env = process.env;
const LISTEN_PORT = parseInt(env.SMS_PORT || '8791', 10);
const MQTT_HOST = env.MQTT_HOST || 'mqtt.dotdashdevice.com';   // hostname, not localhost: the cert is for the name
const MQTT_PORT = parseInt(env.MQTT_PORT || '8883', 10);
const MQTT_USER = env.MQTT_USER || 'dotdash-sms';
const SERVICE_ACCOUNT = env.SERVICE_ACCOUNT || '/root/dotdash_bridge/service-account.json';
const DRY_RUN = env.DRY_RUN === '1';
const SWEEP_EVERY_MS = 6 * 3600e3;

const log = (level, ...a) => console.log(new Date().toISOString(), level.padEnd(5), ...a);

for (const name of ['SMS_DATA_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'MQTT_PASS']) {
  if (!env[name]) { log('ERROR', `${name} missing -- refusing to start`); process.exit(1); }
}

const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT, 'utf8'));
initializeApp({ credential: cert(serviceAccount) });

// Browser push for web-link contacts. Optional: without VAPID keys the chat
// page still works, it just cannot notify. Keys: `npx web-push generate-vapid-keys`.
let webPush = null;
if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
  const wp = (await import('web-push')).default;
  wp.setVapidDetails(env.VAPID_SUBJECT || 'mailto:support@dotdashdevice.com', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  webPush = { send: (sub, payload) => wp.sendNotification(sub, payload, { TTL: 24 * 3600, urgency: 'high' }) };
} else {
  log('WARN', 'VAPID keys missing -- web contacts will get no push notifications');
}

const client = mqtt.connect(`mqtts://${MQTT_HOST}:${MQTT_PORT}`, {
  username: MQTT_USER, password: env.MQTT_PASS,
  clientId: `dotdash-sms-${crypto.randomBytes(3).toString('hex')}`,
  reconnectPeriod: 5000,
});

const { server, sweep } = createService({
  db: getFirestore(),
  FieldValue,
  client,
  webPush,
  // Contacts using the iOS app: the same Firebase project and APNs keys the
  // push bridge uses for account holders.
  fcm: {
    send: ({ token, title, body, data }) => getMessaging().send({
      token,
      notification: { title, body },
      data,
      apns: { payload: { aps: { sound: 'default' } } },
    }),
  },
  twilio: makeTwilio({
    accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN,
    apiKey: env.TWILIO_API_KEY, apiSecret: env.TWILIO_API_SECRET,
    dryRun: DRY_RUN, log: (m) => log('INFO', m),
  }),
  verifyIdToken: makeVerifier(serviceAccount.project_id),
  keys: makeKeys(env.SMS_DATA_KEY),
  config: {
    APP_ID: env.APP_ID || 'dotdash',
    // The origin Twilio and the app reach us on. Twilio signs the URL IT
    // called, so this must match the webhook set on each pool number exactly.
    PUBLIC_BASE: (env.SMS_PUBLIC_BASE || 'https://app.dotdashdevice.com').replace(/\/$/, ''),
    STATE_PATH: env.SMS_STATE_PATH || '/root/dotdash_bridge/sms-state.json',
    APP_ORIGINS: new Set((env.APP_ORIGINS || 'https://app.dotdashdevice.com,capacitor://localhost,http://localhost:5173').split(',')),
    TWILIO_AUTH_TOKEN: env.TWILIO_AUTH_TOKEN,
    // Where web contacts' links point, and the key their browsers subscribe with.
    CHAT_BASE: env.CHAT_BASE || 'https://dotdashdevice.com',
    VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY || null,
  },
  log,
});

setTimeout(() => sweep().catch((e) => log('WARN', 'sweep failed:', e.message)), 60e3);
setInterval(() => sweep().catch((e) => log('WARN', 'sweep failed:', e.message)), SWEEP_EVERY_MS);

server.listen(LISTEN_PORT, '127.0.0.1', () =>
  log('INFO', `sms bridge listening on 127.0.0.1:${LISTEN_PORT}${DRY_RUN ? ' (DRY_RUN: no texts are sent)' : ''}`));
