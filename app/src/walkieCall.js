// Walkie calling: the parent app calls a Dot Dash walkie and talks push-to-talk.
// One call at a time, so this is a singleton (`walkieCall`) that the MQTT
// handler in main.jsx can reach without prop-drilling. The UI subscribes to it.
//
// Flow (see README / phase 2): POST /call-token -> open wss audio leg with the
// pass as the FIRST text message -> publish VOICE_REQ over MQTT -> the device
// answers VOICE_ACC / VOICE_BUSY / VOICE_END on the parent's own message topic.
import voiceWorkletSource from './voiceWorklet.js?raw';
import {
  WIRE_RATE, FRAME_BYTES, markerTxOn, markerTxOff, detectMarker, isAudioFrame,
  int16LEToFloat, makeHighPass, LinearResampler, MicEncoder, makeTone, makeNoise, ringbackCycle,
  voiceReq, voiceEnd, parseVoiceSignal,
} from './walkieAudio.js';

const CALL_TOKEN_URL = 'https://app.dotdashdevice.com/call-token';
const PREBUFFER_FRAMES = 5;     // ~120 ms before each transmission starts playing
const PLAY_GAIN = 4;            // device mic audio peaks around -20 dBFS
const RING_TIMEOUT_MS = 35000;  // the device rings 30 s, then sends VOICE_END itself
const PTT_HANG_MS = 250;
const PTT_DROP_MS = 60;         // skip the talker's own beep at the start of a burst

const IDLE = { phase: 'idle', talking: false, rxTalking: false, notice: '', deviceHash: null, label: '' };

const FRIENDLY = {
  400: "Couldn't start the call.",
  401: 'Please sign in again to place a call.',
  403: "Calling isn't available for this device.",
  429: 'Too many calls just now. Try again in a minute.',
  503: "Calling isn't switched on yet.",
};

// Plays the other side: jitter buffer + squelch noise.
class Player {
  constructor(ctx) {
    this.ctx = ctx;
    this.rs = new LinearResampler(WIRE_RATE, ctx.sampleRate);
    this.pending = [];
    this.hp = makeHighPass();   // incoming low cut, one state per call
    this.playing = false;
    this.nextTime = 0;
    this.sources = [];
  }
  _schedule(samples) {
    if (!samples.length) return;
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buf.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const at = Math.max(this.nextTime, ctx.currentTime + 0.02);
    src.start(at);
    this.nextTime = at + buf.duration;
    this.sources.push(src);
    src.onended = () => { const i = this.sources.indexOf(src); if (i >= 0) this.sources.splice(i, 1); };
  }
  beep() { this._schedule(makeTone(this.ctx.sampleRate, 700, 40)); }
  txOn() {
    this.pending = []; this.playing = false;
    this.rs = new LinearResampler(WIRE_RATE, this.ctx.sampleRate);
    this._schedule(makeNoise(this.ctx.sampleRate, 80));
  }
  txOff() {
    this._flushPending();
    this._schedule(makeNoise(this.ctx.sampleRate, 150, { decay: true }));
    this.playing = false;
  }
  _flushPending() {
    for (const f of this.pending) this._schedule(this.rs.process(int16LEToFloat(f, PLAY_GAIN, this.hp)));
    this.pending = [];
  }
  frame(bytes) {
    if (this.playing && this.nextTime < this.ctx.currentTime) {
      // Ran dry: rebuild the cushion, like the devices do.
      this.playing = false; this.pending = [];
    }
    if (this.playing) {
      this._schedule(this.rs.process(int16LEToFloat(bytes, PLAY_GAIN, this.hp)));
      return;
    }
    this.pending.push(bytes);
    if (this.pending.length >= PREBUFFER_FRAMES) { this.playing = true; this._flushPending(); }
  }
  // Drop everything queued (used when we start talking: half duplex).
  stop() {
    this.pending = []; this.playing = false;
    for (const s of this.sources.slice()) { try { s.stop(); } catch (e) {} }
    this.sources = []; this.nextTime = 0;
  }
}

class WalkieCall {
  constructor() {
    this.state = { ...IDLE };
    this.listeners = new Set();
    this.gen = 0;
    this._onVis = () => { if (document.visibilityState === 'hidden') this.hangup(); };
  }
  getState() { return this.state; }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _set(patch) { this.state = { ...this.state, ...patch }; this.listeners.forEach((l) => l(this.state)); }

  // Must be called straight from the user's tap (iOS wants the AudioContext and
  // the mic prompt inside the gesture).
  async start({ mqttClient, user, deviceHash, label, parentId }) {
    if (this.state.phase !== 'idle' && this.state.phase !== 'busy') return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !navigator.mediaDevices?.getUserMedia) {
      this._set({ ...IDLE, notice: "This browser can't make calls." });
      return;
    }
    clearTimeout(this._noticeTimer);
    const gen = ++this.gen;
    this.mqtt = mqttClient; this.deviceHash = deviceHash; this.parentId = parentId;
    this.ws = null; this.reqSent = false; this.talking = false;
    this._set({ ...IDLE, phase: 'starting', deviceHash, label });

    const ctx = new AC();
    this.ctx = ctx;
    try { ctx.resume(); } catch (e) {}
    const micPromise = navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const dead = () => gen !== this.gen;
    try {
      try { this.stream = await micPromise; }
      catch (e) { throw { friendly: 'Microphone access is needed to make a call. Allow it in your settings and try again.' }; }
      if (dead()) { this._release(); return; }

      let pass;
      try {
        const idToken = await user.getIdToken();
        const res = await fetch(CALL_TOKEN_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ device: deviceHash }),
        });
        if (!res.ok) throw { friendly: FRIENDLY[res.status] || "Couldn't place the call." };
        pass = await res.json();
        if (!pass || !pass.token || !pass.url || !pass.tag) throw { friendly: "Couldn't place the call." };
      } catch (e) {
        throw e && e.friendly ? e : { friendly: "Couldn't reach the call service." };
      }
      if (dead()) { this._release(); return; }

      await this._openAudioLeg(pass, gen);
      if (dead()) return;
      await this._startCapture(gen);
      if (dead()) return;

      this.player = new Player(ctx);
      this.tag = pass.tag;
      this.mqtt.publish(`doorbell/msg/${deviceHash}/v${Date.now()}`, voiceReq(parentId, pass.tag), { qos: 1, retain: false });
      this.reqSent = true;
      this._set({ phase: 'calling' });
      this._startRingback();
      this.ringTimer = setTimeout(() => this._end({ send: true, notice: 'No answer.' }), RING_TIMEOUT_MS);
      document.addEventListener('visibilitychange', this._onVis);
    } catch (e) {
      if (dead()) return;
      this._end({ send: false, notice: (e && e.friendly) || "Couldn't place the call." });
    }
  }

  _openAudioLeg(pass, gen) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (friendly) => { if (!settled) { settled = true; clearTimeout(t); reject({ friendly }); } };
      let ws;
      try { ws = new WebSocket(pass.url); } catch (e) { return reject({ friendly: "Couldn't reach the call service." }); }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const t = setTimeout(() => fail("Couldn't reach the call service."), 8000);
      ws.onopen = () => ws.send(JSON.stringify({ token: pass.token }));
      ws.onerror = () => fail("Couldn't reach the call service.");
      ws.onclose = (ev) => {
        if (!settled) return fail(ev.code === 4401 ? 'The call was refused. Try again.' : ev.code === 1013 ? 'Busy' : "Couldn't reach the call service.");
        if (gen === this.gen) this._end({ send: this.reqSent, notice: ev.code === 1013 ? 'Busy' : '' });
      };
      ws.onmessage = (ev) => {
        if (gen !== this.gen) return;
        if (!settled) {
          if (typeof ev.data !== 'string') return;
          let ok = false;
          try { const j = JSON.parse(ev.data); ok = j.status === 'ok' && j.tag === pass.tag; } catch (e) {}
          if (!ok) return fail("Couldn't place the call.");
          settled = true; clearTimeout(t); resolve();
          return;
        }
        if (typeof ev.data === 'string') return;
        this._onWireData(ev.data);
      };
    });
  }

  _onWireData(data) {
    const p = this.player;
    if (!p) return;
    const m = detectMarker(data);
    if (m) {
      if (this.talking) return;                 // half duplex
      if (m === 'TXON') { p.txOn(); this._set({ rxTalking: true }); }
      else { p.txOff(); this._set({ rxTalking: false }); }
      return;
    }
    if (isAudioFrame(data) && !this.talking) p.frame(data);
  }

  async _startCapture(gen) {
    const ctx = this.ctx;
    this.encoder = new MicEncoder(ctx.sampleRate);
    const src = ctx.createMediaStreamSource(this.stream);
    const sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);
    const onChunk = (chunk) => this._onMic(chunk);
    let node = null;
    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        const url = URL.createObjectURL(new Blob([voiceWorkletSource], { type: 'text/javascript' }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        node = new AudioWorkletNode(ctx, 'dotdash-capture');
        node.port.onmessage = (e) => onChunk(e.data);
      } catch (e) { node = null; }
    }
    if (!node) {
      node = ctx.createScriptProcessor(1024, 1, 1);
      node.onaudioprocess = (e) => onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
    }
    if (gen !== this.gen) return;
    src.connect(node); node.connect(sink);
    this.capNodes = [src, node, sink];
  }

  _onMic(chunk) {
    if (!this.talking || !this.ws || this.ws.readyState !== 1) return;
    const frames = this.encoder.push(chunk);
    if (performance.now() < this.dropUntil) return;
    for (const f of frames) if (f.byteLength === FRAME_BYTES) this.ws.send(f);
  }

  _startRingback() {
    const ctx = this.ctx;
    const cyc = ringbackCycle(ctx.sampleRate);
    const buf = ctx.createBuffer(1, cyc.length, ctx.sampleRate);
    buf.getChannelData(0).set(cyc);
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    src.connect(ctx.destination); src.start();
    this.ringSrc = src;
  }
  _stopRingback() { try { this.ringSrc && this.ringSrc.stop(); } catch (e) {} this.ringSrc = null; }

  // Signalling from the device, arriving on the parent's message topic.
  // Returns nothing; main.jsx has already decided this is a VOICE_ payload.
  handleSignal(payload) {
    const { phase, label } = this.state;
    if (phase !== 'calling' && phase !== 'active') return;
    const sig = parseVoiceSignal(payload);
    if (!sig || sig.kind === 'REQ') return;
    if (sig.from.toLowerCase() !== String(label).toLowerCase()) return;   // not from this device (or our own echo)
    if (sig.kind === 'ACC') {
      if (phase !== 'calling') return;
      clearTimeout(this.ringTimer); this._stopRingback();
      this._set({ phase: 'active' });
    } else if (sig.kind === 'BUSY') {
      this._end({ send: false, busy: true });
    } else if (sig.kind === 'END') {
      this._end({ send: false, notice: phase === 'calling' ? 'No answer.' : 'Call ended.' });
    }
  }

  pttDown() {
    if (this.state.phase !== 'active') return;
    if (this.hangTimer) { clearTimeout(this.hangTimer); this.hangTimer = null; return; }   // let-up forgiven
    if (this.talking) return;
    this.player && this.player.stop();
    this.talking = true;
    this.encoder.reset();
    this.dropUntil = performance.now() + PTT_DROP_MS;
    this._sendMarker(markerTxOn()); this._sendMarker(markerTxOn());   // UDP may drop one
    this.player.beep();
    this._set({ talking: true, rxTalking: false });
  }
  pttUp() {
    if (!this.talking || this.hangTimer) return;
    this.hangTimer = setTimeout(() => {
      this.hangTimer = null;
      this.talking = false;
      this._sendMarker(markerTxOff()); this._sendMarker(markerTxOff());
      this.player && this.player.beep();
      this._set({ talking: false });
    }, PTT_HANG_MS);
  }
  _sendMarker(m) { if (this.ws && this.ws.readyState === 1) this.ws.send(m); }

  hangup() { if (this.state.phase !== 'idle' && this.state.phase !== 'busy') this._end({ send: true }); }

  _release() {
    clearTimeout(this.ringTimer); clearTimeout(this.hangTimer); this.hangTimer = null;
    this._stopRingback();
    document.removeEventListener('visibilitychange', this._onVis);
    if (this.ws) { this.ws.onclose = null; this.ws.onmessage = null; this.ws.onerror = null; try { this.ws.close(); } catch (e) {} this.ws = null; }
    if (this.capNodes) { for (const n of this.capNodes) { try { n.disconnect(); } catch (e) {} } this.capNodes = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    if (this.player) { this.player.stop(); this.player = null; }
    if (this.ctx) { try { this.ctx.close(); } catch (e) {} this.ctx = null; }
    this.talking = false;
  }

  _end({ send = false, notice = '', busy = false } = {}) {
    if (this.state.phase === 'idle' || this.state.phase === 'busy') return;
    this.gen++;
    if (send && this.reqSent && this.mqtt) {
      try { this.mqtt.publish(`doorbell/msg/${this.deviceHash}/v${Date.now()}`, voiceEnd(this.parentId), { qos: 1, retain: false }); } catch (e) {}
    }
    this.reqSent = false;
    this._release();
    clearTimeout(this._noticeTimer);
    if (busy) {
      this._set({ ...IDLE, phase: 'busy', deviceHash: this.deviceHash, label: this.state.label });
      this._noticeTimer = setTimeout(() => this._set({ ...IDLE }), 2000);
    } else {
      this._set({ ...IDLE, notice });
      if (notice) this._noticeTimer = setTimeout(() => this._set({ notice: '' }), 4000);
    }
  }
}

export const walkieCall = new WalkieCall();
