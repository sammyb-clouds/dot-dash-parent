// Run: node app/walkieAudio.test.mjs
import assert from 'node:assert/strict';
import {
  FRAME_BYTES, FRAME_SAMPLES, markerTxOn, markerTxOff, detectMarker, floatToInt16LE, int16LEToFloat,
  LinearResampler, FrameBuilder, MicEncoder, makeTone, makeNoise, ringbackCycle, voiceReq, voiceEnd,
  parseVoiceSignal, isVoicePayload, makeHighPass, highPassProcess,
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

const sine = (hz, len) => Float32Array.from({ length: len }, (_, i) => 0.5 * Math.sin(2 * Math.PI * hz * i / 11025));

t('high-pass: DC step decays to ~0 within 50 ms', () => {
  const out = highPassProcess(makeHighPass(), new Float32Array(1100).fill(0.6));
  const from = Math.round(0.05 * 11025);
  for (let i = from; i < out.length; i++) assert.ok(Math.abs(out[i]) < 0.01, `i=${i} ${out[i]}`);
});

t('high-pass: 1 kHz passes at >= 0.95 amplitude', () => {
  const out = highPassProcess(makeHighPass(), sine(1000, 4000));
  let peak = 0;
  for (let i = 2000; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  assert.ok(peak / 0.5 >= 0.95, `ratio ${peak / 0.5}`);
});

t('high-pass: state carries across frames like one long frame', () => {
  const x = sine(300, 512);
  const whole = highPassProcess(makeHighPass(), x);
  const st = makeHighPass();
  const split = [...highPassProcess(st, x.subarray(0, 256)), ...highPassProcess(st, x.subarray(256))];
  assert.deepEqual(split, [...whole]);
});

t('incoming: sub-20 Hz wave no longer drives voice into the clamp', () => {
  const N = 2048, b = new DataView(new ArrayBuffer(N * 2));
  for (let i = 0; i < N; i++) {
    const v = 20000 * Math.sin(2 * Math.PI * 10 * i / 11025) + 3000 * Math.sin(2 * Math.PI * 1000 * i / 11025);
    b.setInt16(i * 2, Math.round(v), true);
  }
  const hp = makeHighPass();
  const f = int16LEToFloat(b.buffer, 4, hp);
  let clamped = 0;
  for (let i = 1024; i < N; i++) if (Math.abs(f[i]) >= 1) clamped++;
  assert.ok(clamped < 10, `clamped ${clamped}`);
});

console.log(`${n} passed`);
