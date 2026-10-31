// EXPERIMENTAL Bluetooth Wi-Fi setup (protocol v1, walkie firmware).
//
// Only ever loaded by a dynamic import() in main.jsx, and only in a native iOS
// build made with VITE_BLE_SETUP=1 (npm run ios:sync:ble). Everything above the
// "transport" line is pure and unit-tested (app/bleSetup.test.mjs); the part
// below it needs the Capacitor plugin and is imported lazily so the tests run
// under plain node.
//
// The device advertises only while it is in its setup portal, as
// "Dot Dash <PAIRINGCODE>". Messages are UTF-8 text, fields split by 0x1F, one
// message per notification.

export const SERVICE_UUID = 'd07da500-5e7c-4c3a-9b2e-6f1d0a5e7c01';
export const CMD_UUID = 'd07da500-5e7c-4c3a-9b2e-6f1d0a5e7c02';
export const EVT_UUID = 'd07da500-5e7c-4c3a-9b2e-6f1d0a5e7c03';
export const SEP = '\x1f';
export const PROTO = '1';

// ---------------------------------------------------------------------------
// pure protocol helpers
// ---------------------------------------------------------------------------

// Build one command message from its fields.
export const encodeMessage = (...fields) => fields.map((f) => String(f ?? '')).join(SEP);

// Split one received message. Returns { cmd, args }. Never throws.
export const parseMessage = (text) => {
  const parts = String(text ?? '').replace(/[\r\n]+$/, '').split(SEP);
  return { cmd: parts[0] || '', args: parts.slice(1) };
};

// "Dot Dash 1A2B3C" -> "1A2B3C"; anything else -> ''. Case-insensitive, the
// code is returned UPPERCASE (its stored form; hashing lowercases it elsewhere).
export const pairingCodeFromName = (name) => {
  const m = /^\s*Dot Dash ([0-9A-Fa-f]{6})\s*$/.exec(String(name ?? ''));
  return m ? m[1].toUpperCase() : '';
};

// HELLO reply -> { proto, code, needsConfirm } or null if it is not one.
export const parseHello = (msg) => {
  if (!msg || msg.cmd !== 'HELLO') return null;
  const [proto = '', code = '', confirm = '0'] = msg.args;
  return { proto, code: code.trim().toUpperCase(), needsConfirm: confirm === '1' };
};

// NET reply -> { rssi, secured, ssid } or null. The ssid is the LAST field and
// is re-joined, so an ssid is never truncated if it somehow contained 0x1F.
export const parseNet = (msg) => {
  if (!msg || msg.cmd !== 'NET' || msg.args.length < 3) return null;
  const rssi = parseInt(msg.args[0], 10);
  const ssid = msg.args.slice(2).join(SEP);
  if (!ssid) return null;
  return { rssi: Number.isFinite(rssi) ? rssi : -100, secured: msg.args[1] === '1', ssid };
};

// One entry per SSID (the strongest), strongest first. Hidden/empty names drop.
export const dedupeNetworks = (nets) => {
  const best = new Map();
  for (const n of nets) {
    if (!n || !n.ssid) continue;
    const cur = best.get(n.ssid);
    if (!cur || n.rssi > cur.rssi) best.set(n.ssid, n);
  }
  return [...best.values()].sort((a, b) => b.rssi - a.rssi || a.ssid.localeCompare(b.ssid));
};

// STATUS reply -> { state: 'CONNECTED'|'FAILED'|other, ssid?, reason? } or null.
export const parseStatus = (msg) => {
  if (!msg || msg.cmd !== 'STATUS') return null;
  const state = msg.args[0] || '';
  if (state === 'CONNECTED') return { state, ssid: msg.args.slice(1).join(SEP) };
  if (state === 'FAILED') return { state, reason: (msg.args[1] || 'TIMEOUT').toUpperCase() };
  return { state };
};

// Of several advertisements, which should be used? In reconnect mode the one
// whose code is expectedCode (null if it is not among them -- a different
// device must never be set up by mistake). In new mode, all of them, strongest
// first, and the caller lets the user choose if there is more than one.
export const chooseDevices = (found, expectedCode) => {
  const sorted = [...found].sort((a, b) => (b.rssi ?? -127) - (a.rssi ?? -127));
  if (!expectedCode) return sorted;
  const want = String(expectedCode).trim().toUpperCase();
  return sorted.filter((d) => d.code === want);
};

// ---------------------------------------------------------------------------
// transport (needs the Capacitor plugin; not covered by the node tests)
// ---------------------------------------------------------------------------

// The plugin's BleClient is an ordinary object, but it is still held at module
// level and never returned from an async function: a Capacitor plugin Proxy
// resolved from a promise hangs on `.then`.
let BleClient = null;
const loadClient = async () => {
  if (!BleClient) {
    const mod = await import('@capacitor-community/bluetooth-le');
    BleClient = mod.BleClient;
  }
};

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');
const toView = (s) => { const b = enc.encode(s); return new DataView(b.buffer, b.byteOffset, b.byteLength); };
const fromView = (v) => dec.decode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
const bleError = (code, message) => Object.assign(new Error(message || code), { code });

// Scan for Dot Dash devices in setup mode. Resolves with
// [{ deviceId, code, rssi }] (deduped by code). Rejects with code
// BLE_UNAVAILABLE if Bluetooth is off or the permission was refused -- the
// caller then falls back to the Wi-Fi flow.
// stopEarlyFor: a pairing code; the scan ends as soon as that one is seen.
export async function scanForDevices({ ms = 8000, stopEarlyFor = '' } = {}) {
  try {
    await loadClient();
    await BleClient.initialize({ androidNeverForLocation: true });
  } catch (e) {
    throw bleError('BLE_UNAVAILABLE', e?.message);
  }
  const seen = new Map();
  let finish = () => {};
  const done = new Promise((resolve) => { finish = resolve; });
  try {
    await BleClient.requestLEScan({ services: [SERVICE_UUID], allowDuplicates: false }, (r) => {
      const code = pairingCodeFromName(r.localName || r.device?.name);
      if (!code) return;
      const prev = seen.get(code);
      if (!prev || (r.rssi ?? -127) > prev.rssi) seen.set(code, { deviceId: r.device.deviceId, code, rssi: r.rssi ?? -127 });
      if (stopEarlyFor && code === stopEarlyFor.toUpperCase()) finish();
    });
  } catch (e) {
    throw bleError('BLE_UNAVAILABLE', e?.message);
  }
  setTimeout(finish, ms);
  await done;
  try { await BleClient.stopLEScan(); } catch (e) {}
  return [...seen.values()];
}

// One conversation with one device. Incoming messages are buffered so none is
// missed between a send and the wait for its reply.
export class BleSession {
  constructor(deviceId) {
    this.deviceId = deviceId;
    this.inbox = [];
    this.waiters = [];
    this.closed = false;
    this.code = '';
  }

  async open() {
    await loadClient();
    await BleClient.connect(this.deviceId, () => this._dropped(), { timeout: 10000 });
    await BleClient.startNotifications(this.deviceId, SERVICE_UUID, EVT_UUID, (v) => this._push(parseMessage(fromView(v))));
  }

  _dropped() {
    this.closed = true;
    const ws = this.waiters.splice(0);
    ws.forEach((w) => { clearTimeout(w.timer); w.reject(bleError('DISCONNECTED', 'Bluetooth connection lost')); });
  }

  _push(msg) {
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      if (w.pred(msg)) {
        this.waiters.splice(i, 1);
        clearTimeout(w.timer);
        return w.resolve(msg);
      }
    }
    this.inbox.push(msg);
  }

  // Resolve with the next message satisfying pred (buffered ones first).
  waitFor(pred, ms) {
    const i = this.inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    if (this.closed) return Promise.reject(bleError('DISCONNECTED', 'Bluetooth connection lost'));
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, reject };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(bleError('TIMEOUT', 'no reply from the device'));
      }, ms);
      this.waiters.push(w);
    });
  }

  async send(...fields) {
    await BleClient.write(this.deviceId, SERVICE_UUID, CMD_UUID, toView(encodeMessage(...fields)), { timeout: 8000 });
  }

  // HELLO, and the on-device confirmation if it asks for one. Throws an error
  // with code DECLINED, PROTOCOL, DISCONNECTED or TIMEOUT.
  async hello(onNeedsConfirm) {
    await this.send('HELLO');
    const msg = await this.waitFor((m) => m.cmd === 'HELLO' || m.cmd === 'ERR', 8000);
    const h = parseHello(msg);
    if (!h || h.proto !== PROTO) throw bleError('PROTOCOL', msg.cmd === 'ERR' ? msg.args[0] : `protocol ${msg?.args?.[0]}`);
    this.code = h.code;
    if (h.needsConfirm) {
      if (onNeedsConfirm) onNeedsConfirm();
      const r = await this.waitFor((m) => (m.cmd === 'OK' && m.args[0] === 'CONFIRMED') || m.cmd === 'ERR', 60000);
      if (r.cmd === 'ERR') throw bleError(r.args[0] === 'DECLINED' ? 'DECLINED' : 'PROTOCOL', r.args[0]);
    }
    return h;
  }

  async scanNetworks() {
    await this.send('SCAN');
    const nets = [];
    const end = (m) => m.cmd === 'SCAN_END' || m.cmd === 'ERR';
    // NET lines arrive before SCAN_END on the same ordered channel, so drain
    // them as they come and stop at the end marker.
    for (;;) {
      const m = await this.waitFor((x) => x.cmd === 'NET' || end(x), 25000);
      if (m.cmd === 'ERR') throw bleError('PROTOCOL', m.args[0]);
      if (m.cmd === 'SCAN_END') break;
      const n = parseNet(m);
      if (n) nets.push(n);
    }
    return dedupeNetworks(nets);
  }

  // Resolves { ok: true } or { ok: false, reason: NOT_FOUND|REJECTED|TIMEOUT }.
  async join(ssid, pass) {
    await this.send('JOIN', ssid, pass);
    const isResult = (m) => m.cmd === 'ERR' || (m.cmd === 'STATUS' && (m.args[0] === 'CONNECTED' || m.args[0] === 'FAILED'));
    let m;
    try { m = await this.waitFor(isResult, 35000); }
    catch (e) {
      if (e.code !== 'TIMEOUT') throw e;
      // The unsolicited status may have been lost: ask once.
      await this.send('STATUS');
      m = await this.waitFor(isResult, 6000);
    }
    if (m.cmd === 'ERR') return { ok: false, reason: m.args[0] || 'TIMEOUT' };
    const s = parseStatus(m);
    return s.state === 'CONNECTED' ? { ok: true } : { ok: false, reason: s.reason };
  }

  // SAVED, or the link dropping (the device reboots as it saves). Throws
  // NOT_CONNECTED if the device says it is not on the network.
  async save(ssid, pass, tz) {
    await this.send('SAVE', ssid, pass, tz);
    try {
      const m = await this.waitFor((x) => x.cmd === 'SAVED' || x.cmd === 'ERR', 10000);
      if (m.cmd === 'ERR') throw bleError(m.args[0] === 'NOT_CONNECTED' ? 'NOT_CONNECTED' : 'PROTOCOL', m.args[0]);
    } catch (e) {
      if (e.code !== 'DISCONNECTED') throw e;
    }
  }

  async close() {
    this.closed = true;
    try { await BleClient.disconnect(this.deviceId); } catch (e) {}
  }
}
