/**
 * A stand-in for Twilio while the toll-free verification is pending
 * (SMS_SANDBOX=1). Nothing leaves the droplet: every SMS the bridge would send
 * is kept in a small outbox, and the sandbox phone page
 * (site/sms-sandbox.html, through /chat/api/sandbox/) shows each number's
 * thread and can reply from it.
 *
 * It behaves like Twilio where the bridge's behaviour depends on it:
 *   - once a number has sent STOP, sending to it fails with 21610, exactly as
 *     Twilio's own opt-out handling does;
 *   - STOP, START and HELP get Twilio's automatic replies (HELP's is the one
 *     to be set on the Messaging Service, SMS_HELP_TEXT);
 *   - a reply is then handed to the bridge's inbound handler, as the webhook
 *     would be, and any TwiML <Message> it answers with goes in the outbox.
 *
 * Bounded: the newest 500 entries, none older than 14 days, in one JSON file.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as L from './lib.mjs';
import { TwilioError } from './twilio.mjs';

const KEEP = 500;
const KEEP_MS = 14 * 24 * 3600e3;

// Twilio's default replies for its opt-out keywords (toll-free, default opt-out handling).
const AUTO = {
  stop: 'You have successfully been unsubscribed. You will not receive any more messages from this number. Reply START to resubscribe.',
  start: 'You have successfully been re-subscribed to messages from this number. Reply HELP for help. Reply STOP to unsubscribe. Msg&Data Rates May Apply.',
};
export const DEFAULT_HELP = 'Dot Dash: SMS notifications that a new message is waiting in your Dot Dash chat. Help: support@dotdashdevice.com. Reply STOP to cancel. Msg & data rates may apply.';

export function makeSandbox({ file, helpText = DEFAULT_HELP, log = () => {} }) {
  let state = { entries: [], stopped: [] };
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  const stopped = new Set(state.stopped || []);

  function save() {
    const cutoff = Date.now() - KEEP_MS;
    state.entries = state.entries.filter((e) => e.at > cutoff).slice(-KEEP);
    state.stopped = [...stopped];
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) { log('ERROR', `sandbox: could not persist (${e.message})`); }
  }
  function record(dir, from, to, body) {
    const e = { id: crypto.randomBytes(6).toString('hex'), dir, from, to, body, at: Date.now() };
    state.entries.push(e);
    save();
    return e;
  }

  // Drop-in for makeTwilio(): only send() is used by the bridge.
  const twilio = {
    async send({ from, to, body }) {
      if (stopped.has(to)) throw new TwilioError(400, { code: 21610, message: 'Attempt to send to unsubscribed recipient (sandbox)' });
      const e = record('out', from, to, body);
      log('INFO', `SANDBOX: SMS to ${L.maskNumber(to)} captured (${body.length} chars)`);
      return { sid: `SMsandbox${e.id}` };
    },
  };

  return {
    twilio,

    /** Everything to and from one number, oldest first. */
    thread(number) {
      return {
        stopped: stopped.has(number),
        messages: state.entries.filter((e) => (e.dir === 'out' ? e.to : e.from) === number),
      };
    },

    /** Numbers with sandbox traffic, newest first. */
    numbers() {
      const last = new Map();
      for (const e of state.entries) last.set(e.dir === 'out' ? e.to : e.from, e.at);
      return [...last].sort((a, b) => b[1] - a[1]).map(([number, at]) => ({ number, at, stopped: stopped.has(number) }));
    },

    /**
     * A message from `from` to the pool number `to`: Twilio's keyword handling
     * first, then the bridge's own inbound handler (`inbound(params)` returns
     * TwiML), whose reply, if any, is captured too.
     */
    async reply({ from, to, body }, inbound) {
      record('in', from, to, body);
      const kw = L.keywordOf(body);
      if (kw === 'stop') { stopped.add(from); record('out', to, from, AUTO.stop); }
      else if (kw === 'start') { stopped.delete(from); record('out', to, from, AUTO.start); }
      else if (kw === 'help') record('out', to, from, helpText);
      save();
      const xml = await inbound({ From: from, To: to, Body: body, MessageSid: `SMsandboxin${crypto.randomBytes(6).toString('hex')}`, NumMedia: '0' });
      const m = /<Message>([\s\S]*?)<\/Message>/.exec(xml || '');
      if (m) {
        const text = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
        // Twilio does not deliver a reply to an opted-out number either.
        if (!stopped.has(from)) record('out', to, from, text);
      }
    },

    /** Forget a number's thread and opt-out (to test a first sign-up again). */
    reset(number) {
      state.entries = state.entries.filter((e) => (e.dir === 'out' ? e.to : e.from) !== number);
      stopped.delete(number);
      save();
    },
  };
}
