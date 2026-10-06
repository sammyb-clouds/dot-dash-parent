/**
 * Firestore access for the SMS bridge. Server-only: none of these paths match
 * a rule in firestore.rules, so the default deny keeps every client out, and
 * the app reaches them only through sms.mjs's HTTPS endpoints.
 *
 *   artifacts/<app>/smsPool/<digits>       a Twilio number in the pool
 *   artifacts/<app>/smsPairings/<id>       one contact <-> one child device
 *   artifacts/<app>/smsRoutes/<ck>_<digits> the (contact, pool number) claim
 *
 * <ck> is the contact's HMAC blind index (lib.contactKey), so no document
 * holds a phone number except as ciphertext -- and routes not even that.
 *
 * A ROUTE OUTLIVES ITS PAIRING. Deleting a contact deletes the pairing (with
 * the encrypted number and both names), but leaves the route behind as a
 * tombstone holding only the blind index, the pool number and the child's
 * hash. That is what stops the same (contact, number) pair ever reaching a
 * DIFFERENT child: the contact's phone still has that number saved as a thread
 * with the first one. See README.md, "Retention", for the COPPA side of this.
 */
import crypto from 'node:crypto';
import * as L from './lib.mjs';

export class StoreError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

// FieldValue is passed in (firebase-admin's, or the test fake's) so this file
// loads without firebase-admin installed.
export function makeStore(db, appId, keys, { FieldValue }) {
  const base = `artifacts/${appId}`;
  const pools = db.collection(`${base}/smsPool`);
  const pairings = db.collection(`${base}/smsPairings`);
  const routes = db.collection(`${base}/smsRoutes`);
  const identity = (hash) => db.doc(`${base}/public/data/identities/${hash}`);
  const routeId = (ck, poolE164) => `${ck}_${L.poolKey(poolE164)}`;

  const number = (p) => L.decrypt(keys, p.contactEnc, p.contactKey);
  // A web contact's message history: artifacts/<app>/smsPairings/<id>/chat/<msgId>.
  // The bridge relays SMS without keeping it, but a web contact's chat page is
  // not always open, so the last few messages have to wait somewhere.
  const chat = (id) => db.collection(`${base}/smsPairings/${id}/chat`);
  const CHAT_KEEP = 50;
  const CHAT_MAX_AGE_MS = 30 * 24 * 3600e3;

  // Four random digits whose identity record is free. The identity record is
  // also what stops any Dot Dash ever being given this ID.
  async function freeVirtualId(tx, vname) {
    const cands = Array.from({ length: 8 }, () => L.virtualId(vname, crypto.randomInt(0, 10000)));
    const snaps = await tx.getAll(...cands.map((c) => identity(L.hashId(c))));
    const vid = cands.find((c, i) => !snaps[i].exists) || null;
    if (!vid) throw new StoreError('no-id');
    return vid;
  }

  return {
    pairings,

    async listPools() {
      const s = await pools.get();
      return s.docs.map((d) => ({ key: d.id, ...d.data() }));
    },

    async addPool({ number: e164, twilioSid, campaignId, kind }) {
      await pools.doc(L.poolKey(e164)).create({
        number: e164, twilioSid, campaignId: campaignId || null, kind: kind || '10dlc',
        active: true, used: 0, addedAt: FieldValue.serverTimestamp(),
      });
    },

    async setPoolActive(e164, active) {
      await pools.doc(L.poolKey(e164)).update({ active });
    },

    // Recount `used` from the live pairings, in case a crash ever left it off.
    async recountPools() {
      const out = {};
      for (const p of await this.listPools()) {
        const n = (await pairings.where('poolNumber', '==', p.number).count().get()).data().count;
        if (n !== p.used) await pools.doc(p.key).update({ used: n });
        out[p.number] = { used: n, active: p.active, kind: p.kind };
      }
      return out;
    },

    /**
     * Create a PENDING pairing: picks the pool number, claims the route and a
     * virtual friend ID, all in one transaction. Returns the pairing.
     *
     * Throws StoreError: already-added | pool-exhausted | no-id
     */
    async createPairing({ uid, deviceDocId, deviceHash, e164, contactName, displayName, vname }) {
      const ck = L.contactKey(keys, e164);
      return db.runTransaction(async (tx) => {
        const [poolSnap, routeSnap] = await Promise.all([
          tx.get(pools),
          tx.get(routes.where('contactKey', '==', ck)),
        ]);
        const poolList = poolSnap.docs.map((d) => ({ key: d.id, ...d.data() }));
        const routeList = routeSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

        const live = routeList.find((r) => r.deviceHash === deviceHash && r.pairingId);
        if (live) throw new StoreError('already-added');

        const key = L.choosePool(poolList, routeList, deviceHash);
        if (!key) throw new StoreError('pool-exhausted');
        const pool = poolList.find((p) => p.key === key);
        const prior = routeList.find((r) => r.pool === key);   // a tombstone for this same child, if any

        // The virtual friend ID. Re-adding someone reuses their old one, so the
        // child's inbox history still lines up with the name. Otherwise pick
        // four random digits whose identity record is free -- an identity
        // record is also what stops a child ever being given this ID, which
        // would let them read the contact's texts.
        const vid = prior?.virtualId || await freeVirtualId(tx, vname);
        const vhash = L.hashId(vid);

        const ref = pairings.doc();
        const pairing = {
          ownerUid: uid,
          deviceDocId,
          deviceHash,
          virtualId: vid,
          virtualHash: vhash,
          contactName,
          displayName,
          contactKey: ck,
          contactEnc: L.encrypt(keys, e164, ck),
          contactHint: L.numberHint(e164),
          poolNumber: pool.number,
          channel: 'sms',
          status: 'pending',
          createdAt: FieldValue.serverTimestamp(),
        };
        tx.create(ref, pairing);
        tx.set(routes.doc(routeId(ck, pool.number)), {
          contactKey: ck, pool: key, deviceHash, virtualId: vid, pairingId: ref.id,
          createdAt: prior?.createdAt || FieldValue.serverTimestamp(), retiredAt: null,
        });
        tx.set(identity(vhash), { owner: uid, idString: vid, type: 'sms' });
        tx.update(pools.doc(key), { used: FieldValue.increment(1) });
        return { id: ref.id, ...pairing, e164 };
      });
    },

    /**
     * A contact reached by a private link instead of SMS. No phone number at
     * all: the link's token is their credential, and only its SHA-256 is
     * stored, so a database copy cannot be used to impersonate them. The
     * plaintext token is returned once, for the account holder to share.
     *
     * PENDING until the first device opens the link and connects (claims it);
     * after that the link only works on that device.
     */
    async createWebPairing({ uid, deviceDocId, deviceHash, contactName, displayName, vname }) {
      const token = L.newSecret();
      const p = await db.runTransaction(async (tx) => {
        const vid = await freeVirtualId(tx, vname);
        const vhash = L.hashId(vid);
        const ref = pairings.doc();
        const pairing = {
          ownerUid: uid, deviceDocId, deviceHash,
          virtualId: vid, virtualHash: vhash,
          contactName, displayName,
          channel: 'web',
          tokenHash: L.secretHash(token),
          claimHash: null,
          pushSub: null,
          pushFcm: null,
          status: 'pending',
          createdAt: FieldValue.serverTimestamp(),
        };
        tx.create(ref, pairing);
        tx.set(identity(vhash), { owner: uid, idString: vid, type: 'sms' });
        return { id: ref.id, ...pairing };
      });
      return { pairing: p, token };
    },

    async findByToken(token) {
      if (!token) return null;
      const s = await pairings.where('tokenHash', '==', L.secretHash(token)).limit(1).get();
      return s.empty ? null : { id: s.docs[0].id, ...s.docs[0].data() };
    },

    /**
     * The first device to connect claims the link. A transaction, so two
     * devices opening it at the same moment cannot both win. Throws
     * StoreError 'claimed-elsewhere' if someone already has.
     */
    async claimLink(id) {
      const claim = L.newSecret();
      await db.runTransaction(async (tx) => {
        const ref = pairings.doc(id);
        const snap = await tx.get(ref);
        if (!snap.exists || !snap.data().tokenHash) throw new StoreError('gone');
        if (snap.data().claimHash) throw new StoreError('claimed-elsewhere');
        tx.update(ref, { claimHash: L.secretHash(claim), status: 'active', activatedAt: FieldValue.serverTimestamp() });
      });
      return claim;
    },

    async updatePairing(id, fields) {
      await pairings.doc(id).update(fields);
    },

    /**
     * A new link for a web contact: the old one stops working at once, any
     * device that had claimed it is cut off, and its history goes with it --
     * a new link may well be for a different phone, or a different person.
     */
    async resetLink(id) {
      const token = L.newSecret();
      await pairings.doc(id).update({ tokenHash: L.secretHash(token), claimHash: null, pushSub: null, pushFcm: null, status: 'pending' });
      await this.clearChat(id);
      return token;
    },

    async addChat(id, entry) {
      await chat(id).doc(`${entry.at}-${crypto.randomBytes(3).toString('hex')}`).set(entry);
      await this.pruneChat(id);
    },

    // Bounded by CHAT_KEEP, so reading the whole collection is cheap and needs
    // no index.
    async listChat(id) {
      const s = await chat(id).get();
      return s.docs.map((d) => d.data()).sort((a, b) => a.at - b.at);
    },

    async pruneChat(id) {
      const s = await chat(id).get();
      const docs = s.docs.map((d) => ({ ref: d.ref, at: d.data().at })).sort((a, b) => b.at - a.at);
      const cutoff = Date.now() - CHAT_MAX_AGE_MS;
      const doomed = docs.filter((d, i) => i >= CHAT_KEEP || d.at < cutoff);
      for (const d of doomed) await d.ref.delete();
      return doomed.length;
    },

    async clearChat(id) {
      const s = await chat(id).get();
      for (const d of s.docs) await d.ref.delete();
    },

    async getPairing(id) {
      const s = await pairings.doc(id).get();
      return s.exists ? { id: s.id, ...s.data() } : null;
    },

    /** The pairing an inbound text belongs to: { pairing } or { retired } or null. */
    async findByRoute(fromE164, toE164) {
      const ck = L.contactKey(keys, fromE164);
      const r = await routes.doc(routeId(ck, toE164)).get();
      if (!r.exists) return { contactKey: ck, pairing: null, retired: false };
      const { pairingId } = r.data();
      const pairing = pairingId ? await this.getPairing(pairingId) : null;
      return { contactKey: ck, pairing, retired: !pairing };
    },

    async listForOwner(uid) {
      const s = await pairings.where('ownerUid', '==', uid).get();
      return s.docs.map((d) => ({ id: d.id, ...d.data() }));
    },

    async setStatus(id, status) {
      const at = status === 'active' ? { activatedAt: FieldValue.serverTimestamp() }
        : status === 'stopped' ? { stoppedAt: FieldValue.serverTimestamp() } : {};
      await pairings.doc(id).update({ status, ...at });
    },

    /** Hard delete: the pairing goes; for SMS the route stays as a tombstone. */
    async deletePairing(id) {
      await this.clearChat(id);
      return db.runTransaction(async (tx) => {
        const ref = pairings.doc(id);
        const s = await tx.get(ref);
        if (!s.exists) return null;
        const p = s.data();
        if (p.channel === 'web') {
          tx.delete(ref);
          return { id, ...p };
        }
        const poolRef = pools.doc(L.poolKey(p.poolNumber));
        const poolSnap = await tx.get(poolRef);
        tx.delete(ref);
        tx.set(routes.doc(routeId(p.contactKey, p.poolNumber)), { pairingId: null, retiredAt: FieldValue.serverTimestamp() }, { merge: true });
        if (poolSnap.exists) tx.update(poolRef, { used: FieldValue.increment(-1) });
        // The identity record is kept on purpose: it holds only the virtual ID
        // and the owner, and releasing it would let a child claim an ID that
        // other devices may still list as a friend.
        return { id, ...p };
      });
    },

    number,
  };
}
