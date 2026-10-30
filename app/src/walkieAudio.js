// Pure helpers for walkie calling: no DOM, no WebAudio, so they run under node.
// Wire format (both directions, after the bridge strips/adds its 8-byte tag):
//   512 bytes = 256 samples of signed 16-bit LITTLE-ENDIAN mono PCM at 11025 Hz
//   16 bytes  = squelch marker "TXON" | "TXOF" + "DOTDASH-SQL1"

export const WIRE_RATE = 11025;
export const FRAME_SAMPLES = 256;
export const FRAME_BYTES = FRAME_SAMPLES * 2;
export const MARKER_BYTES = 16;
const MARKER_SUFFIX = 'DOTDASH-SQL1';

function makeMarker(kind) {
  const s = kind + MARKER_SUFFIX;
  const out = new Uint8Array(MARKER_BYTES);
  for (let i = 0; i < MARKER_BYTES; i++) out[i] = s.charCodeAt(i);
  return out;
}
export const markerTxOn = () => makeMarker('TXON');
export const markerTxOff = () => makeMarker('TXOF');

// -> 'TXON' | 'TXOF' | null. Accepts ArrayBuffer or any typed array.
export function detectMarker(data) {
  const b = data instanceof ArrayBuffer ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (b.length !== MARKER_BYTES) return null;
  let s = '';
  for (let i = 0; i < MARKER_BYTES; i++) s += String.fromCharCode(b[i]);
  if (s.slice(4) !== MARKER_SUFFIX) return null;
  const k = s.slice(0, 4);
  return k === 'TXON' || k === 'TXOF' ? k : null;
}

// A 512-byte audio frame (as opposed to a marker or junk).
export const isAudioFrame = (data) => data && data.byteLength === FRAME_BYTES;

// Float [-1,1] -> int16 LE bytes, clamped.
export function floatToInt16LE(f32) {
  const buf = new ArrayBuffer(f32.length * 2);
  const dv = new DataView(buf);
  for (let i = 0; i < f32.length; i++) {
    let v = f32[i];
    if (v > 1) v = 1; else if (v < -1) v = -1;
    dv.setInt16(i * 2, v < 0 ? Math.round(v * 32768) : Math.round(v * 32767), true);
  }
  return buf;
}

// ~100 Hz "low cut": two cascaded one-pole high-passes, identical to the walkie
// firmware (a = 30900/32768, fc ~100 Hz at 11025 Hz). Removes the sub-20 Hz
// pressure wave from a squeezed sealed case. State persists across frames.
export const HP_A = 30900 / 32768;
export const makeHighPass = () => ({ x1a: 0, y1a: 0, x1b: 0, y1b: 0 });
// Filters one sample; mutates st.
export function highPassSample(st, x) {
  const y = x - st.x1a + HP_A * st.y1a; st.x1a = x; st.y1a = y;
  const z = y - st.x1b + HP_A * st.y1b; st.x1b = y; st.y1b = z;
  return z;
}
// Filters an array in place-safe fashion (returns a new Float32Array). Scale-free.
export function highPassProcess(st, input) {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = highPassSample(st, input[i]);
  return out;
}

// int16 LE bytes -> Float32 [-1,1), optional high-pass state (applied BEFORE
// the gain) and gain with a hard clamp.
export function int16LEToFloat(data, gain = 1, hp = null) {
  const dv = data instanceof ArrayBuffer ? new DataView(data) : new DataView(data.buffer, data.byteOffset, data.byteLength);
  const n = dv.byteLength >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let x = dv.getInt16(i * 2, true) / 32768;
    if (hp) x = highPassSample(hp, x);
    let v = x * gain;
    out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  return out;
}

// Streaming linear-interpolation resampler. State carries across process()
// calls so chunk boundaries are seamless. For downsampling, an optional
// two-pole low-pass (cutoffHz) runs first to tame aliasing.
export class LinearResampler {
  constructor(fromRate, toRate, { cutoffHz = 0 } = {}) {
    this.step = fromRate / toRate;
    this.pos = 0;       // read position; index -1 is `prev`
    this.prev = 0;
    this.lp = 0; this.lp2 = 0;
    this.alpha = cutoffHz > 0 ? 1 - Math.exp(-2 * Math.PI * cutoffHz / fromRate) : 1;
  }
  process(input) {
    let x = input;
    if (this.alpha < 1) {
      x = new Float32Array(input.length);
      for (let i = 0; i < input.length; i++) {
        this.lp += this.alpha * (input[i] - this.lp);
        this.lp2 += this.alpha * (this.lp - this.lp2);
        x[i] = this.lp2;
      }
    }
    const n = x.length;
    if (n === 0) return new Float32Array(0);
    const out = [];
    while (this.pos < n - 1) {
      const i0 = Math.floor(this.pos);
      const frac = this.pos - i0;
      const a = i0 < 0 ? this.prev : x[i0];
      const b = x[i0 + 1];
      out.push(a + (b - a) * frac);
      this.pos += this.step;
    }
    this.pos -= n;
    this.prev = x[n - 1];
    return Float32Array.from(out);
  }
}

// Collects 11025 Hz float samples and emits exact 512-byte int16 LE frames.
export class FrameBuilder {
  constructor() { this.acc = new Float32Array(0); }
  push(samples) {
    const merged = new Float32Array(this.acc.length + samples.length);
    merged.set(this.acc, 0);
    merged.set(samples, this.acc.length);
    const frames = [];
    let off = 0;
    while (merged.length - off >= FRAME_SAMPLES) {
      frames.push(floatToInt16LE(merged.subarray(off, off + FRAME_SAMPLES)));
      off += FRAME_SAMPLES;
    }
    this.acc = merged.slice(off);
    return frames;
  }
  reset() { this.acc = new Float32Array(0); }
}

// Mic chain: context-rate float chunks in -> wire frames out.
export class MicEncoder {
  constructor(ctxRate) {
    this.rs = new LinearResampler(ctxRate, WIRE_RATE, { cutoffHz: 4500 });
    this.fb = new FrameBuilder();
    this.hp = makeHighPass();
  }
  // High-pass runs on the 11025 Hz samples, before framing (floatToInt16LE clamps).
  push(chunk) { return this.fb.push(highPassProcess(this.hp, this.rs.process(chunk))); }
  reset() { this.fb.reset(); }   // filter state lives for the whole call
}

// Short sine beep (default 40 ms, 700 Hz) with 4 ms edges to avoid clicks.
export function makeTone(rate, freq, ms, level = 0.25) {
  const n = Math.round(rate * ms / 1000);
  const edge = Math.max(1, Math.round(rate * 0.004));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / edge, (n - 1 - i) / edge);
    out[i] = Math.sin(2 * Math.PI * freq * i / rate) * level * Math.max(0, env);
  }
  return out;
}

// White-noise burst; decay=true fades linearly to silence (TXOF tail).
export function makeNoise(rate, ms, { level = 0.12, decay = false } = {}) {
  const n = Math.round(rate * ms / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (Math.random() * 2 - 1) * level * (decay ? 1 - i / n : 1);
  return out;
}

// One ring of the ringback: 400 on / 200 off / 400 on / 2000 off, ~1 kHz.
export const RINGBACK_PATTERN_MS = [400, 200, 400, 2000];
export function ringbackCycle(rate, level = 0.08) {
  const [a, b, c, d] = RINGBACK_PATTERN_MS;
  const tone = (ms) => makeTone(rate, 1000, ms, level);
  const parts = [tone(a), new Float32Array(Math.round(rate * b / 1000)), tone(c), new Float32Array(Math.round(rate * d / 1000))];
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Signalling payloads (device side parses these; keep byte-exact).
export const voiceReq = (parentId, tag) => `VOICE_REQ,${parentId},${tag}`;
export const voiceEnd = (parentId) => `VOICE_END,${parentId}`;

// "VOICE_ACC,ARTHUR1234" -> { kind: 'ACC', from: 'ARTHUR1234' } | null
export function parseVoiceSignal(payload) {
  const s = String(payload || '');
  if (!s.startsWith('VOICE_')) return null;
  const i = s.indexOf(',');
  const kind = s.slice(6, i < 0 ? undefined : i);
  if (!['ACC', 'BUSY', 'END', 'REQ'].includes(kind)) return null;
  return { kind, from: i < 0 ? '' : s.slice(i + 1).split(',')[0].trim() };
}
export const isVoicePayload = (payload) => String(payload).startsWith('VOICE_');
