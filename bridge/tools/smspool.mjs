#!/usr/bin/env node
/**
 * Manage the SMS bridge's pool of Twilio numbers.
 *
 *   node smspool.mjs list                      utilisation: contacts per number
 *   node smspool.mjs add <+E164> [--kind tollfree|10dlc] [--campaign <id>] [--no-webhook]
 *   node smspool.mjs add <+E164> --no-twilio  record it without asking Twilio (DRY_RUN testing only)
 *   node smspool.mjs disable <+E164>           stop offering it to NEW pairings
 *   node smspool.mjs enable <+E164>
 *
 * `add` records a number that is ALREADY in the Twilio account (buy it, and
 * attach it to the campaign or toll-free verification, in the console -- that
 * spends money and goes through carrier review, so it stays a human step),
 * then points its inbound-SMS webhook at this bridge.
 *
 * Disabling never moves existing pairings: a contact's phone has that number
 * saved as a thread with one particular child. It only stops new ones.
 *
 * Run on the droplet with the bridge's environment:
 *   cd /root/dotdash_bridge && set -a && . /root/dotdash_sms/sms.env && set +a && node smspool.mjs list
 */
import fs from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { makeKeys, toE164 } from './sms/lib.mjs';
import { makeStore } from './sms/store.mjs';
import { makeTwilio } from './sms/twilio.mjs';

const env = process.env;
const [cmd, arg, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(`--${name}`); return i < 0 ? undefined : (rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : true); };

initializeApp({ credential: cert(JSON.parse(fs.readFileSync(env.SERVICE_ACCOUNT || '/root/dotdash_bridge/service-account.json', 'utf8'))) });
const store = makeStore(getFirestore(), env.APP_ID || 'dotdash', makeKeys(env.SMS_DATA_KEY), { FieldValue });

// A pairing per contact per number; a number sends ~1 msg/s, and a 10DLC
// campaign caps daily volume. Past this many, plan the next number.
const WARN_AT = 200;

if (cmd === 'list') {
  const pools = await store.recountPools();
  const rows = Object.entries(pools);
  if (!rows.length) console.log('pool is empty -- add a number first');
  for (const [n, p] of rows) console.log(`${n}  ${p.kind.padEnd(8)} ${p.active ? 'active  ' : 'disabled'} ${String(p.used).padStart(5)} pairings${p.used >= WARN_AT ? '  <- consider adding a number' : ''}`);
} else if (cmd === 'add') {
  const number = toE164(arg);
  if (!number) throw new Error('usage: add <+E164>');
  const twilio = makeTwilio({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, apiKey: env.TWILIO_API_KEY, apiSecret: env.TWILIO_API_SECRET });
  // --no-twilio: a stand-in number for a bridge running with DRY_RUN=1, before
  // any Twilio account exists. Disable it before going live.
  const found = flag('no-twilio') ? { sid: 'PNplaceholder' } : await twilio.findNumber(number);
  if (!found) throw new Error(`${number} is not in this Twilio account`);
  if (!flag('no-webhook') && !flag('no-twilio')) {
    const url = `${(env.SMS_PUBLIC_BASE || 'https://app.dotdashdevice.com').replace(/\/$/, '')}/sms/inbound`;
    await twilio.setSmsWebhook(found.sid, url);
    console.log(`webhook for ${number} -> ${url}`);
  }
  const kind = flag('kind') || (/^\+18(00|33|44|55|66|77|88)/.test(number) ? 'tollfree' : '10dlc');
  await store.addPool({ number, twilioSid: found.sid, campaignId: flag('campaign') || null, kind });
  console.log(`added ${number} (${kind}, ${found.sid})`);
} else if (cmd === 'disable' || cmd === 'enable') {
  const number = toE164(arg);
  if (!number) throw new Error(`usage: ${cmd} <+E164>`);
  await store.setPoolActive(number, cmd === 'enable');
  console.log(`${number} ${cmd}d`);
} else {
  console.log('usage: smspool.mjs list | add <+E164> [--kind tollfree|10dlc] [--campaign <id>] [--no-webhook] | disable <+E164> | enable <+E164>');
  process.exitCode = 1;
}
process.exit();
