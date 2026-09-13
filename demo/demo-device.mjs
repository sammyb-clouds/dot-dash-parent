/**
 * A virtual Dot Dash device, for the review demo account.
 *
 * Apple's reviewers have no hardware, and an account whose only child shows as
 * offline with an empty Monitor reads as a broken app. This stands in for the
 * physical device: it holds presence open and taps out a message now and then,
 * so Chat, Monitor and the online dot all behave the way they would beside a
 * real one.
 *
 * It speaks the same MQTT the firmware does, on the same shared device
 * credential, so it needs no broker changes and no ACL of its own.
 *
 * Deliberately NOT a simulation of the whole product: it sends, it is present,
 * and it answers. It does not fake battery alerts, friend requests or timer
 * approvals -- those reach the reviewer only if they actually happen.
 */

import mqtt from 'mqtt';
import crypto from 'node:crypto';

const HOST = process.env.MQTT_HOST || 'mqtt.dotdashdevice.com';
const PORT = parseInt(process.env.MQTT_PORT || '8883', 10);
const USER = process.env.MQTT_USER || 'DigitalDoorbell';
const PASS = process.env.MQTT_PASS || '';

const PARENT_ID = process.env.DEMO_PARENT_ID || 'DEMO0101';
const CHILD_ID = process.env.DEMO_CHILD_ID || 'ROBIN0614';

// How often the demo child sends something unprompted. Long enough that a
// reviewer sees the app at rest rather than a device chattering at them, short
// enough that a few minutes of poking produces visible life.
const IDLE_SEND_MS = parseInt(process.env.DEMO_IDLE_MS || '600000', 10);

const PHRASES = ['HELLO!', 'HOW ARE YOU?', 'GREAT!', 'OK', 'COME OVER?', 'MEET AT PARK?', ':)'];

// Ids are hashed LOWERCASED and trimmed, matching hashId() in main.jsx, the
// firmware, and the bridge's parent map. Anything else talks to nobody.
const sha256 = (s) => crypto.createHash('sha256').update(String(s).toLowerCase().trim(), 'utf8').digest('hex');
const childHash = sha256(CHILD_ID);
const parentHash = sha256(PARENT_ID);
const presenceTopic = `doorbell/presence/${childHash}`;

const log = (...a) => console.log(new Date().toISOString(), ...a);

if (!PASS) {
  console.error('MQTT_PASS is empty -- refusing to start.');
  process.exit(1);
}

const client = mqtt.connect({
  protocol: 'mqtts',
  host: HOST,
  port: PORT,
  username: USER,
  password: PASS,
  clientId: `demo-${childHash.slice(0, 12)}`,
  reconnectPeriod: 5000,
  // Same last will the firmware registers, so an outage here looks like a
  // device losing Wi-Fi rather than a child who is mysteriously always on.
  will: { topic: presenceTopic, payload: 'OFFLINE', qos: 0, retain: true },
});

function sendToParent(text) {
  const id = Date.now();
  const payload = `TEXT,${text},${CHILD_ID}`;
  // Retained, at the timestamped topic, exactly as the firmware publishes it:
  // this is the path the push bridge watches, so a demo message also exercises
  // the notification the reviewer would get.
  client.publish(`doorbell/msg/${parentHash}/${id}`, payload, { qos: 1, retain: true });
  client.publish(`doorbell/monitor/${childHash}/${id}`, payload, { qos: 1, retain: false });
  log('sent', JSON.stringify(text));
}

client.on('connect', () => {
  log(`connected to ${HOST}:${PORT} as ${USER}`);
  client.publish(presenceTopic, 'ONLINE', { qos: 0, retain: true });
  client.subscribe(`doorbell/msg/${childHash}/#`, { qos: 1 });
  client.subscribe(`doorbell/cmd/${childHash}`, { qos: 1 });
  log(`demo child ${CHILD_ID} online`);
});

client.on('message', (topic, buf) => {
  const payload = buf.toString();
  if (!payload) return;

  if (topic.startsWith(`doorbell/cmd/`)) {
    log('command', payload);
    // Clear the retained command, as the firmware does, so it is not replayed
    // on every reconnect.
    client.publish(topic, '', { qos: 1, retain: true });
    return;
  }

  // A message from the parent. Clear the retained copy the way a real device
  // does once it has displayed it, then answer after a beat -- a reviewer who
  // sends "HELLO!" should see the child reply, which is the whole product.
  const parts = payload.split(',');
  if (parts.length < 3) return;
  client.publish(topic, '', { qos: 1, retain: true });
  log('received', JSON.stringify(parts[1]), 'from', parts[2]);

  const reply = parts[1] === 'HOW ARE YOU?' ? 'GREAT!' : 'OK';
  setTimeout(() => sendToParent(reply), 4000);
});

client.on('error', (e) => log('mqtt error:', e.message));
client.on('close', () => log('disconnected'));

setInterval(() => sendToParent(PHRASES[Math.floor(Math.random() * PHRASES.length)]), IDLE_SEND_MS);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('shutting down, marking offline');
    client.publish(presenceTopic, 'OFFLINE', { qos: 0, retain: true }, () => {
      client.end(true, () => process.exit(0));
    });
    setTimeout(() => process.exit(0), 3000);
  });
}
