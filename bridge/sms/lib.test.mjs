// node --test bridge/sms/   -- no credentials, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as L from './lib.mjs';

test('hashId lowercases and trims, like the firmware', () => {
  assert.equal(L.hashId(' GRANDMA1234 '), crypto.createHash('sha256').update('grandma1234').digest('hex'));
});

test('virtualName fits the device header and the wire format', () => {
  assert.equal(L.virtualName('Grandma Jo'), 'GRANDMAJO');
  assert.equal(L.virtualName('Abuelíta, Rosa!'), 'ABUELITARO');
  assert.equal(L.virtualName('😀'), null);
  assert.equal(L.virtualId('NANA', 7), 'NANA0007');
});

test('toE164', () => {
  assert.equal(L.toE164('(415) 555-2671'), '+14155552671');
  assert.equal(L.toE164('1-415-555-2671'), '+14155552671');
  assert.equal(L.toE164('+44 20 7946 0958'), '+442079460958');
  assert.equal(L.toE164('555-2671'), null);
  assert.equal(L.toE164('0155552671'), null);
  assert.equal(L.toE164('+0123456789'), null);
  assert.equal(L.maskNumber('+14155552671'), '…71');
});

test('encryption round-trips and is bound to its AAD', () => {
  const keys = L.makeKeys(crypto.randomBytes(32).toString('base64'));
  const blob = L.encrypt(keys, '+14155552671', 'k1');
  assert.notEqual(L.encrypt(keys, '+14155552671', 'k1'), blob);   // random IV
  assert.equal(L.decrypt(keys, blob, 'k1'), '+14155552671');
  assert.throws(() => L.decrypt(keys, blob, 'k2'));
  assert.equal(L.contactKey(keys, '+1415'), L.contactKey(keys, '+1415'));
  assert.throws(() => L.makeKeys('short'));
});

test('Twilio signature matches the published example', () => {
  // From Twilio's "Webhooks security" documentation.
  const params = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  assert.equal(L.twilioSignature('12345', url, params), '0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
  assert.ok(L.validTwilioSignature('12345', url, params, '0/KCTR6DLpKmkAf8muzZqo1nDgQ='));
  assert.ok(!L.validTwilioSignature('12345', url, { ...params, Digits: '1235' }, '0/KCTR6DLpKmkAf8muzZqo1nDgQ='));
  assert.ok(!L.validTwilioSignature('12345', url, params, undefined));
});

test('twiml escapes', () => {
  assert.equal(L.twiml(), '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  assert.match(L.twiml('a<b & "c"'), /<Message>a&lt;b &amp; &quot;c&quot;<\/Message>/);
});

test('keywords are whole messages', () => {
  assert.equal(L.keywordOf('stop'), 'stop');
  assert.equal(L.keywordOf(' Yes! '), 'start');
  assert.equal(L.keywordOf('help'), 'help');
  assert.equal(L.keywordOf('stop by later'), null);
  assert.equal(L.keywordOf('anything', 'STOP'), 'stop');
});

test('toDeviceText: charset, commas, emoji, photos, length', () => {
  assert.deepEqual(L.toDeviceText('Hi, Maya! Love you ❤️'), { text: 'HI MAYA! LOVE YOU', cut: false });
  assert.equal(L.toDeviceText('It’s “great” — café…').text, `IT'S "GREAT" - CAFE...`);
  assert.equal(L.toDeviceText('line1\nline2|x').text, 'LINE1 LINE2/X');
  assert.equal(L.toDeviceText('😀😀').text, '(EMOJI)');
  assert.equal(L.toDeviceText('', { numMedia: 1 }).text, '(PHOTO)');
  assert.equal(L.toDeviceText('look', { numMedia: 2 }).text, '(PHOTO) LOOK');
  assert.equal(L.toDeviceText('   ').text, '');
  const long = L.toDeviceText('word '.repeat(60));
  assert.ok(long.cut && long.text.length <= L.DEVICE_MAX && long.text.endsWith('WORD...'));
  const blob = L.toDeviceText('x'.repeat(400));
  assert.equal(blob.text.length, L.DEVICE_MAX);
  // Nothing that could break "TYPE,TEXT,SENDER" or a |-separated list.
  assert.ok(!/[,|]/.test(L.toDeviceText('a,b|c,,,').text));
});

test('parseDeviceMessage / toSmsBody', () => {
  assert.deepEqual(L.parseDeviceMessage('TEXT,HI GRANDMA,MAYA0515'), { type: 'TEXT', text: 'HI GRANDMA', sender: 'MAYA0515' });
  assert.equal(L.parseDeviceMessage('CMD,X,Y'), null);
  assert.equal(L.parseDeviceMessage('TEXT,HI'), null);
  assert.equal(L.parseDeviceMessage(''), null);
  assert.ok(L.isGameTraffic('GAME') && !L.isGameTraffic('TEXT'));
  assert.equal(L.toSmsBody({ type: 'PULSE', text: '500', sender: 'MAYA0515' }), 'Maya via Dot Dash: (buzz!)');
  assert.equal(L.toSmsBody({ type: 'MORSE', text: ' SOS ', sender: 'MAYA0515' }), 'Maya via Dot Dash: SOS');
  assert.equal(L.toSmsBody({ type: 'TEXT', text: 'HI', sender: 'MARY JO0101' }), 'Mary Jo via Dot Dash: HI');
  assert.equal(L.toSmsBody({ type: 'TEXT', text: '', sender: 'MAYA0515' }), null);
  assert.equal(L.displayName('MAYA0515'), 'MAYA');
});

test('msgStamp is numeric, under 20 digits, strictly increasing', () => {
  const a = L.msgStamp(1_700_000_000_000), b = L.msgStamp(1_700_000_000_000);
  assert.match(a, /^\d{1,19}$/);
  assert.ok(BigInt(b) > BigInt(a));
});

test('choosePool', () => {
  const pools = [
    { key: 'A', active: true, used: 5 },
    { key: 'B', active: true, used: 1 },
    { key: 'C', active: false, used: 0 },
  ];
  // new contact: least used active
  assert.equal(L.choosePool(pools, [], 'dev1'), 'B');
  // contact already on B with another child: A
  assert.equal(L.choosePool(pools, [{ pool: 'B', deviceHash: 'dev2' }], 'dev1'), 'A');
  // on both: nothing free
  assert.equal(L.choosePool(pools, [{ pool: 'A', deviceHash: 'd2' }, { pool: 'B', deviceHash: 'd3' }], 'dev1'), null);
  // re-adding the same child reuses its old number even if another is emptier
  assert.equal(L.choosePool(pools, [{ pool: 'A', deviceHash: 'dev1' }], 'dev1'), 'A');
  // ...but never a retired one, and never falls through to a different number
  assert.equal(L.choosePool(pools, [{ pool: 'C', deviceHash: 'dev1' }], 'dev1'), null);
});

test('Limiter', () => {
  const lim = new L.Limiter([{ ms: 1000, max: 2 }, { ms: 10_000, max: 3 }]);
  assert.ok(lim.take('k', 0));
  assert.ok(lim.take('k', 1));
  assert.ok(!lim.take('k', 2));        // short window full
  assert.ok(lim.take('k', 1500));      // short window rolled
  assert.ok(!lim.take('k', 3000));     // long window full
  assert.ok(lim.take('other', 3000));
  assert.ok(lim.allows('other', 3001) && lim.allows('other', 3002));   // allows() never counts
  assert.ok(lim.take('other', 3003) && !lim.allows('other', 3004));
});
