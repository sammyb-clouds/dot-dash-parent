// Run: node app/walkieAudio.test.mjs
import assert from 'node:assert/strict';
import {
  FRAME_BYTES, FRAME_SAMPLES, markerTxOn, markerTxOff, detectMarker, floatToInt16LE, int16LEToFloat,
  LinearResampler, FrameBuilder, MicEncoder, makeTone, makeNoise, ringbackCycle, voiceReq, voiceEnd,
  parseVoiceSignal, isVoicePayload,
} from './src/walkieAudio.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('markers are 16 bytes and round-trip', () => {
  const on = markerTxOn(), off = markerTxOff();
  assert.equal(on.length, 16);
  assert.equal(Buffer.from(on).toString('ascii'), 'TXONDOTDASH-SQL1');
  assert.equal(Buffer.from(off).toString('ascii'), 'TXOFDOTDASH-SQL1');
  assert.equal(detectMarker(on), 'TXON');
  assert.equal(detectMarker(off.buffer), 'TXOF');
  assert.equal(detectMarker(new Uint8Array(16)), null);
  assert.equal(detectMarker(new Uint8Array(512)), null);
  assert.equal(detectMarker(Buffer.from('TXONDOTDASH-SQL2')), null);
});

t('int16 LE encoding and clamping', () => {
  const b = new Uint8Array(floatToInt16LE(Float32Array.from([0, 1, -1, 2, -2, 0.5])));
  const dv = new DataView(b.buffer);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => dv.getInt16(i * 2, true)), [0, 32767, -32768, 32767, -32768, 16384]);
  assert.equal(b[2], 0xff); assert.equal(b[3], 0x7f);     // little-endian
});

t('int16 -> float with gain clamps', () => {
  const buf = floatToInt16LE(Float32Array.from([0.1, -0.1, 0.5, -0.5]));
  const f = int16LEToFloat(buf, 4);
  assert.ok(Math.abs(f[0] - 0.4) < 1e-3); assert.ok(Math.abs(f[1] + 0.4) < 1e-3);
  assert.equal(f[2], 1); assert.equal(f[3], -1);
});

t('FrameBuilder emits exact 512-byte frames and keeps the remainder', () => {
  const fb = new FrameBuilder();
  assert.equal(fb.push(new Float32Array(100)).length, 0);
  const fr = fb.push(new Float32Array(700));    // 800 total -> 3 frames, 32 left
  assert.equal(fr.length, 3);
  assert.ok(fr.every((f) => f.byteLength === FRAME_BYTES));
  assert.equal(fb.push(new Float32Array(224)).length, 1);   // 32+224 = 256
});

t('resampler: length and chunk-independence', () => {
  const input = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(2 * Math.PI * 440 * i / 48000));
  const whole = new LinearResampler(48000, 11025).process(input);
  assert.ok(Math.abs(whole.length - 11025) <= 2, `len ${whole.length}`);
  const rs = new LinearResampler(48000, 11025);
  const parts = [];
  for (let o = 0; o < input.length; o += 1024) parts.push(...rs.process(input.subarray(o, o + 1024)));
  assert.equal(parts.length, whole.length);
  for (let i = 0; i < whole.length; i++) assert.ok(Math.abs(parts[i] - whole[i]) < 1e-6);
  // tone stays a tone: peak amplitude preserved
  const peak = Math.max(...whole.map(Math.abs));
  assert.ok(peak > 0.95 && peak <= 1.0001, `peak ${peak}`);
});

t('resampler: upsample 11025 -> 48000', () => {
  const input = Float32Array.from({ length: 2560 }, (_, i) => Math.sin(2 * Math.PI * 300 * i / 11025));
  const out = new LinearResampler(11025, 48000).process(input);
  assert.ok(Math.abs(out.length - 2560 * 48000 / 11025) <= 5);
});

t('MicEncoder: 1 s of 48 kHz audio -> whole 512-byte frames (~43)', () => {
  const enc = new MicEncoder(48000);
  let frames = [];
  for (let o = 0; o < 48; o++) frames.push(...enc.push(new Float32Array(1000).fill(0.1)));
  assert.ok(frames.length >= 42 && frames.length <= 44, `frames ${frames.length}`);
  assert.ok(frames.every((f) => f.byteLength === 512));
});

t('tone / noise / ringback shapes', () => {
  assert.equal(makeTone(11025, 700, 40).length, Math.round(11025 * 0.04));
  assert.equal(makeNoise(48000, 80).length, 3840);
  const d = makeNoise(48000, 150, { decay: true });
  assert.ok(Math.abs(d[d.length - 1]) < 0.001);
  assert.equal(ringbackCycle(1000).length, 3000);
});

t('signalling payloads', () => {
  assert.equal(voiceReq('PARENT1234', 'Ab3dE6gH'), 'VOICE_REQ,PARENT1234,Ab3dE6gH');
  assert.equal(voiceEnd('PARENT1234'), 'VOICE_END,PARENT1234');
  assert.deepEqual(parseVoiceSignal('VOICE_ACC,ARTHUR1234'), { kind: 'ACC', from: 'ARTHUR1234' });
  assert.deepEqual(parseVoiceSignal('VOICE_BUSY,ARTHUR1234'), { kind: 'BUSY', from: 'ARTHUR1234' });
  assert.equal(parseVoiceSignal('MORSE,hi,X'), null);
  assert.equal(parseVoiceSignal('VOICE_NOPE,X'), null);
  assert.ok(isVoicePayload('VOICE_END,X') && !isVoicePayload('TEXT,VOICE_,X'));
  assert.equal(FRAME_SAMPLES, 256);
});

console.log(`${n} passed`);
