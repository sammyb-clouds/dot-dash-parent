#!/usr/bin/env node
/**
 * Pretend to be Twilio: POST a correctly signed inbound-SMS webhook straight
 * at the bridge on the droplet, and print the TwiML it answers with. For
 * testing the inbound path (pairing lookup, YES/STOP, delivery to a device)
 * without a phone, or before a Twilio number exists.
 *
 *   node smsfake.mjs --from +14155552671 --to +18005550100 --body "YES"
 *
 * Signs with TWILIO_AUTH_TOKEN over SMS_PUBLIC_BASE, exactly as Twilio would.
 */
import crypto from 'node:crypto';
import { twilioSignature } from './sms/lib.mjs';

const env = process.env;
const args = process.argv.slice(2);
const get = (n) => { const i = args.indexOf(`--${n}`); return i < 0 ? undefined : args[i + 1]; };
const base = (env.SMS_PUBLIC_BASE || 'https://app.dotdashdevice.com').replace(/\/$/, '');
const target = get('url') || `http://127.0.0.1:${env.SMS_PORT || 8791}/sms/inbound`;

const params = {
  MessageSid: `SMfake${crypto.randomBytes(8).toString('hex')}`,
  AccountSid: env.TWILIO_ACCOUNT_SID || 'ACfake',
  From: get('from'), To: get('to'), Body: get('body') ?? '', NumMedia: get('media') || '0',
};
if (!params.From || !params.To) { console.log('usage: smsfake.mjs --from <+E164> --to <pool +E164> --body <text> [--media N]'); process.exit(1); }

const res = await fetch(target, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilioSignature(env.TWILIO_AUTH_TOKEN, `${base}/sms/inbound`, params) },
  body: new URLSearchParams(params).toString(),
});
console.log(res.status, await res.text());
