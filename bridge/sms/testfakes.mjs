/**
 * Just enough of firebase-admin's Firestore, an MQTT client and Twilio for
 * service.test.mjs. Single-threaded, so a "transaction" is: read live, buffer
 * the writes, apply them together at the end.
 */
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

const TS = Symbol('ts'), INC = Symbol('inc');
export const FieldValue = {
  serverTimestamp: () => ({ [TS]: true }),
  increment: (n) => ({ [INC]: n }),
};
const stamp = () => { const t = Date.now(); return { toMillis: () => t }; };

export class FakeDB {
  constructor() { this.data = new Map(); this.watchers = []; }

  doc(path) { return new DocRef(this, path); }
  collection(path) { return new Query(this, path, []); }

  _resolve(prev, d) {
    const out = { ...d };
    for (const [k, v] of Object.entries(d)) {
      if (v && v[TS]) out[k] = stamp();
      else if (v && v[INC] !== undefined) out[k] = (prev?.[k] || 0) + v[INC];
    }
    return out;
  }
  _write(path, fn) {
    const prev = this.data.get(path);
    const next = fn(prev);
    if (next === undefined) this.data.delete(path); else this.data.set(path, next);
    const coll = path.slice(0, path.lastIndexOf('/'));
    for (const w of this.watchers) if (w.path === coll) queueMicrotask(() => w.cb(w.query._snap()));
  }
  async runTransaction(fn) {
    const writes = [];
    const tx = {
      get: async (r) => (r instanceof DocRef ? r.get() : r.get()),
      getAll: async (...refs) => Promise.all(refs.map((r) => r.get())),
      create: (r, d) => writes.push(() => { if (this.data.has(r.path)) throw new Error('ALREADY_EXISTS'); r._put(d); }),
      set: (r, d, o) => writes.push(() => r._put(d, o)),
      update: (r, d) => writes.push(() => r._patch(d)),
      delete: (r) => writes.push(() => this._write(r.path, () => undefined)),
    };
    const out = await fn(tx);
    for (const w of writes) w();
    return out;
  }
}

class Snap {
  constructor(ref, d) { this.ref = ref; this.id = ref.id; this._d = d; this.exists = d !== undefined; }
  data() { return this._d && { ...this._d }; }
}

class DocRef {
  constructor(db, path) { this.db = db; this.path = path; this.id = path.split('/').pop(); }
  async get() { return new Snap(this, this.db.data.get(this.path)); }
  _put(d, o) { this.db._write(this.path, (prev) => this.db._resolve(prev, o?.merge ? { ...prev, ...d } : d)); }
  _patch(d) {
    if (!this.db.data.has(this.path)) throw new Error('NOT_FOUND');
    this.db._write(this.path, (prev) => ({ ...prev, ...this.db._resolve(prev, d) }));
  }
  async create(d) { if (this.db.data.has(this.path)) throw new Error('ALREADY_EXISTS'); this._put(d); }
  async set(d, o) { this._put(d, o); }
  async update(d) { this._patch(d); }
  async delete() { this.db._write(this.path, () => undefined); }
}

class Query {
  constructor(db, path, filters) { this.db = db; this.path = path; this.filters = filters; }
  doc(id = crypto.randomBytes(10).toString('hex')) { return new DocRef(this.db, `${this.path}/${id}`); }
  where(f, op, v) { if (op !== '==') throw new Error('fake: == only'); const q = new Query(this.db, this.path, [...this.filters, [f, v]]); q.max = this.max; return q; }
  limit(n) { const q = new Query(this.db, this.path, this.filters); q.max = n; return q; }
  _snap() {
    const docs = [];
    for (const [p, d] of this.db.data) {
      if (p.slice(0, p.lastIndexOf('/')) !== this.path) continue;
      if (this.filters.every(([f, v]) => d[f] === v)) docs.push(new Snap(new DocRef(this.db, p), d));
    }
    if (this.max !== undefined) docs.splice(this.max);
    return { docs, size: docs.length, empty: !docs.length };
  }
  async get() { return this._snap(); }
  count() { return { get: async () => ({ data: () => ({ count: this._snap().size }) }) }; }
  onSnapshot(cb) { this.db.watchers.push({ path: this.path, query: this, cb }); queueMicrotask(() => cb(this._snap())); return () => {}; }
}

export class FakeMqtt extends EventEmitter {
  constructor() { super(); this.published = []; this.subs = new Set(); }
  publish(topic, payload, opts) { this.published.push({ topic, payload: String(payload), ...opts }); }
  subscribe(t) { this.subs.add(t); }
  unsubscribe(t) { this.subs.delete(t); }
  // A device publishing to a topic this client is subscribed to.
  deliver(topic, payload) { this.emit('message', topic, Buffer.from(payload)); }
}

export class FakeTwilio {
  constructor() { this.sent = []; this.failNext = null; }
  async send(m) {
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    this.sent.push(m);
    return { sid: `SM${this.sent.length}` };
  }
}
