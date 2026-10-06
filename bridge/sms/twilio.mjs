/**
 * The three Twilio REST calls the bridge needs, over plain fetch. No SDK: the
 * droplet has ~200 MB free and the official one is a large dependency for
 * three form POSTs. Webhook signatures are checked in lib.mjs.
 *
 * Auth is an API key (TWILIO_API_KEY/TWILIO_API_SECRET) when set -- revocable
 * on its own -- else the account SID and auth token.
 */

const API = 'https://api.twilio.com/2010-04-01';

export class TwilioError extends Error {
  constructor(status, body) {
    super(`twilio ${status} ${body?.code || ''} ${body?.message || ''}`.trim());
    this.status = status;
    this.code = body?.code || null;   // e.g. 21610 unsubscribed, 21211 invalid To
  }
}

// Codes that mean "this recipient can't be messaged", as opposed to "try later".
export const OPTED_OUT = 21610;
export const BAD_NUMBER = new Set([21211, 21614, 21612, 21408]);

export function makeTwilio({ accountSid, authToken, apiKey, apiSecret, dryRun = false, log = console.log }) {
  const user = apiKey || accountSid;
  const pass = apiKey ? apiSecret : authToken;
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  async function call(method, path, form) {
    const res = await fetch(`${API}/Accounts/${accountSid}${path}`, {
      method,
      headers: { Authorization: auth, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(15000),
    });
    let body = null;
    try { body = await res.json(); } catch { /* empty or not JSON */ }
    if (!res.ok) throw new TwilioError(res.status, body);
    return body;
  }

  return {
    // Twilio queues sends past a number's rate limit on its own side, so the
    // bridge does not pace them -- it only caps volume (see sms.mjs).
    async send({ from, to, body }) {
      if (dryRun) { log(`DRY_RUN: would send ${body.length} chars`); return { sid: 'SMdryrun' }; }
      const r = await call('POST', '/Messages.json', { From: from, To: to, Body: body });
      return { sid: r.sid };
    },
    async findNumber(e164) {
      const r = await call('GET', `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(e164)}`);
      return r.incoming_phone_numbers?.[0] || null;
    },
    async setSmsWebhook(numberSid, url) {
      return call('POST', `/IncomingPhoneNumbers/${numberSid}.json`, { SmsUrl: url, SmsMethod: 'POST' });
    },
  };
}
