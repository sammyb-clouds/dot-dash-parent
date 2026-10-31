// Dot Dash activity logger.
//
//     mosquitto -> this daemon -> rollups on disk -> a private page on the droplet
//
// It records THAT something happened, never WHAT. Message bodies cross this
// process in memory -- MQTT has no way to deliver a topic without its payload --
// and are reduced to a byte count on the line they arrive on. Nothing downstream
// of `event()` has a field that could hold text even by accident.
//
// Three rules it must keep:
//
//   1. Never touch the bridge. That process holds the push subscription AND
//      serves the /c/ chats; this one is separate, and a crash here is invisible
//      to devices because nothing depends on it.
//   2. Never publish. The broker sees a subscriber and nothing else. There is no
//      publish call in this file, and that is deliberate.
//   3. Retained is not news. Every topic in this system is retained, so the
//      broker replays all of them on every reconnect. Counting those would
//      invent a traffic spike on each restart -- the same trap the push bridge
//      hit, which is why it carries a replay guard. Here `packet.retain` tells
//      them apart: the broker only sets it when delivering because of a new
//      subscription, so retained arrivals seed baselines and count for nothing.

import mqtt from "mqtt";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, dayKey, hourKey, DAY } from "./store.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = join(HERE, "public");

const CFG = {
    // The hostname, never localhost: the listener presents a Let's Encrypt cert
    // for app./mqtt.dotdashdevice.com, so localhost fails hostname verification
    // even from the box itself. Verify against the system CA store, not the
    // deploy's chain.pem (that is the intermediate alone, with no root).
    url:  process.env.STATS_MQTT_URL  || "mqtts://mqtt.dotdashdevice.com:8883",
    user: process.env.STATS_MQTT_USER || "",
    pass: process.env.STATS_MQTT_PASS || "",
    dir:  process.env.STATS_DIR       || "/root/dotdash_stats/data",
    port: Number(process.env.STATS_PORT || 8787),
    host: process.env.STATS_HOST || "127.0.0.1",
};

const store = new Store(CFG.dir);
await store.open();

// Baselines for the running totals. A retained value seeds these; only a live
// update produces a delta, and only a positive one counts (a device that was
// factory reset would otherwise log a large negative "activity").
const pointsBase = new Map();   // dev -> last total seen
const scoreBase  = new Map();   // dev|game -> last score seen
const lastConn   = new Map();   // dev -> when its last connection was counted

let startedAt = Date.now();
let seenRetained = 0, counted = 0, ignored = 0;

async function event(kind, dev, v = 0, ts = Date.now()) {
    counted++;
    await store.add({ ts, kind, dev, v });
}

// ---------------------------------------------------------------- topic rules
//
// Subscribed deliberately narrowly. `doorbell/msg/#` is NOT subscribed: it is
// the delivery channel and carries bodies, and every send already shows up on
// the sender's own monitor feed, so there is nothing to learn there that is
// worth having the traffic in this process at all.
const SUBS = [
    "doorbell/presence/+",     // doorbell/presence/<hash>            ONLINE / OFFLINE
    "doorbell/monitor/+/+",    // doorbell/monitor/<hash>/<leaf>
    "doorbell/score/+/+",      // doorbell/score/<game>/<hash>
];

// monitor leaves worth counting. Everything else on that prefix is fleet health
// or settings (fw, battery, wifi, find, arcade, arcaderules, typewriter), which
// this dashboard deliberately does not track.
const MONITOR_COUNTED = new Set(["seen", "points"]);

// An ALLOWLIST, not a denylist, because `doorbell/score/<x>/` carries things
// that are not games at all: `2p` is a retained capability marker ("this device
// can play two-player", published on connect and cleared on disconnect), and
// `points` and `voice` are mirrors of other state. A denylist would have counted
// every reconnect as a two-player session.
const GAMES = new Set(["dotty", "dasher", "train", "defender", "jumper"]);

// Message kind, from the payload's leading tag. Strictly an allowlist matched
// against the first few bytes before the first comma -- the rest of that payload
// is `TYPE,TEXT,SENDER` and the TEXT part is the message itself, which must
// never be read, stored, or logged. Anything unrecognised is "other".
const MSG_TAGS = new Set(["TEXT", "MORSE", "PULSE", "GAME"]);
function msgTag(payload) {
    const head = payload.subarray(0, 6).toString("latin1").toUpperCase();
    const tag = head.split(",")[0];
    return MSG_TAGS.has(tag) ? tag.toLowerCase() : "other";
}

function classify(topic) {
    const p = topic.split("/");
    if (p[0] !== "doorbell") return null;
    if (p[1] === "presence" && p.length === 3) return { t: "presence", dev: p[2] };
    if (p[1] === "monitor" && p.length === 4) {
        const leaf = p[3];
        // A numeric leaf is an epoch: doorbell/monitor/<hash>/<timestamp> is the
        // copy of one outgoing message that feeds the Monitor view.
        if (/^\d+$/.test(leaf)) return { t: "msg", dev: p[2] };
        if (MONITOR_COUNTED.has(leaf)) return { t: leaf, dev: p[2] };
        return null;
    }
    if (p[1] === "score" && p.length === 4) {
        if (!GAMES.has(p[2])) return null;
        return { t: "game", dev: p[3], game: p[2] };
    }
    return null;
}

// ------------------------------------------------------------------ the broker
const client = mqtt.connect(CFG.url, {
    clientId: "dotdash-stats-" + Math.random().toString(16).slice(2, 8),
    username: CFG.user || undefined,
    password: CFG.pass || undefined,
    clean: true,
    reconnectPeriod: 5000,
    // System CA store. No `ca:` override, no rejectUnauthorized:false -- an ops
    // tool that disables verification to get itself running is how a broker ends
    // up with a client nobody can vouch for.
});

client.on("connect", () => {
    console.log("[stats] connected to", CFG.url);
    startedAt = Date.now();
    for (const s of SUBS) client.subscribe(s, { qos: 0 }, (err) => {
        if (err) console.error("[stats] subscribe failed", s, err.message);
    });
});
client.on("error", (e) => console.error("[stats] mqtt error:", e.message));
client.on("close", () => console.warn("[stats] mqtt connection closed"));

client.on("message", async (topic, payload, packet) => {
    const len = payload.length;
    const retained = !!packet?.retain;

    const c = classify(topic);
    if (!c) { ignored++; return; }
    if (!c.dev) { ignored++; return; }   // there is a stray doorbell/presence/ with no hash
    if (retained) seenRetained++;

    // Decoded ONLY for the kinds whose payload is a control value -- a presence
    // word, a running total, a score. A message payload is never stringified:
    // `monitor/<hash>/<stamp>` carries `TYPE,TEXT,SENDER`, so decoding it at all
    // would put the message body in a variable, and a variable is one careless
    // log line away from disk.
    const control = (c.t === "presence" || c.t === "points" || c.t === "game")
        ? payload.subarray(0, 24).toString("latin1")
        : "";

    try {
        if (c.t === "presence") {
            const online = control.startsWith("ONLINE");
            const now = Date.now();
            const changed = store.markPresence(c.dev, online, now);
            // A retained presence value is the broker telling us the state, not a
            // device changing it. Seed silently.
            if (!changed || retained) return;

            // Only the ONLINE edge is an event, and at most one a minute per
            // device. These boards hold a session for one to three seconds and
            // then drop it, so a row per transition would be tens of thousands a
            // day of the least interesting fact in the system -- and it would
            // bury the message counts it sits next to. What is worth keeping is
            // "this device checked in", which is what a connection is.
            if (!online) return;
            const last = lastConn.get(c.dev) || 0;
            if (now - last < 60e3) return;
            lastConn.set(c.dev, now);
            await event("conn", c.dev);
            return;
        }

        if (c.t === "msg") {
            if (retained) return;             // redelivery of an old message copy
            // The byte count and a type tag; never the bytes. The leaf is NOT
            // used as the timestamp: a device with no clock stamps these with
            // millis(), so 5- and 8-digit leaves exist alongside 13-digit epochs.
            // Server receive time is the only one that means the same thing for
            // every device.
            await event("msg", c.dev, len);
            await event("msgkind:" + msgTag(payload), c.dev);
            return;
        }

        if (c.t === "seen") {
            if (retained) return;
            await event("seen", c.dev);
            return;
        }

        if (c.t === "points") {
            // Payload leads with the running total. Only the delta is activity.
            const total = parseInt(control, 10);
            if (!Number.isFinite(total)) return;
            const prev = pointsBase.get(c.dev);
            pointsBase.set(c.dev, total);
            if (retained || prev === undefined) return;   // seeded, not earned
            const delta = total - prev;
            if (delta > 0) await event("points", c.dev, delta);
            return;
        }

        if (c.t === "game") {
            const score = parseInt(control, 10);
            const key = `${c.dev}|${c.game}`;
            const prev = scoreBase.get(key);
            if (Number.isFinite(score)) scoreBase.set(key, score);
            if (retained || prev === undefined) return;
            // A score topic only moves when a personal best is beaten, so this
            // undercounts plays -- it is "good sessions", not "sessions". Said
            // plainly on the page rather than quietly treated as play count.
            await event("game:" + c.game, c.dev, Number.isFinite(score) ? score : 0);
            return;
        }
    } catch (e) {
        console.error("[stats] handler:", e.message);
    }
});

// --------------------------------------------------------------- housekeeping
setInterval(() => { store.flush().catch((e) => console.error("[stats] flush:", e.message)); }, 30e3);
setInterval(() => {
    store.prune();
    store.trimRaw().catch((e) => console.error("[stats] trim:", e.message));
}, 6 * 3600e3);

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => {
    console.log("[stats] shutting down");
    try { await store.flush(); } catch {}
    client.end(true, () => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
});

// ---------------------------------------------------------------- the read API
const DEV8 = (d) => d.slice(0, 8);

function sumRange(map, fromKey, toKey, pick) {
    const out = new Map();
    for (const [k, val] of map) {
        const [bucket, kind, dev] = k.split("|");
        if (bucket < fromKey || bucket > toKey) continue;
        const name = pick(kind, dev, bucket);
        if (name == null) continue;
        const cur = out.get(name) || { n: 0, v: 0 };
        cur.n += val.n; cur.v += val.v;
        out.set(name, cur);
    }
    return out;
}

const isGame = (kind) => kind.startsWith("game:");
const isMsgKind = (kind) => kind.startsWith("msgkind:");

function overview() {
    const now = Date.now();
    const last24 = sumRange(store.hourly, hourKey(now - DAY), hourKey(now), (k) =>
        k === "msg" ? "msg" : isGame(k) ? "game" : k === "points" ? "points" : null);
    const prev24 = sumRange(store.hourly, hourKey(now - 2 * DAY), hourKey(now - DAY), (k) =>
        k === "msg" ? "msg" : isGame(k) ? "game" : k === "points" ? "points" : null);

    const active = new Set();
    for (const [k] of store.hourly) {
        const [bucket, kind, dev] = k.split("|");
        if (bucket >= hourKey(now - DAY) && (kind === "msg" || isGame(kind))) active.add(dev);
    }

    // Not "state === on": these devices are online for seconds at a time, so an
    // instantaneous count is mostly a measure of when you happened to look.
    // Seen-in-the-last-fifteen-minutes is the question that was actually meant.
    const FRESH = 15 * 60e3;
    let online = 0;
    for (const [, p] of store.presence) if (now - p.lastSeen < FRESH) online++;

    return {
        now: new Date(now).toISOString(),
        uptimeSec: Math.round((now - startedAt) / 1000),
        devicesKnown: store.presence.size,
        devicesOnline: online,
        devicesActive24h: active.size,
        last24h: {
            msgs: last24.get("msg")?.n || 0,
            games: last24.get("game")?.n || 0,
            points: last24.get("points")?.v || 0,
        },
        prev24h: {
            msgs: prev24.get("msg")?.n || 0,
            games: prev24.get("game")?.n || 0,
            points: prev24.get("points")?.v || 0,
        },
        ingest: { counted, ignored, retainedSeen: seenRetained },
    };
}

function series(range) {
    const now = Date.now();
    const hourly = range === "48h";
    const span = hourly ? 48 : range === "30d" ? 30 : 90;
    const out = [];
    for (let i = span - 1; i >= 0; i--) {
        const t = hourly ? now - i * 3600e3 : now - i * DAY;
        const key = hourly ? hourKey(t) : dayKey(t);
        out.push({ t: key, msg: 0, game: 0, points: 0 });
    }
    const idx = new Map(out.map((r, i) => [r.t, i]));
    const src = hourly ? store.hourly : store.daily;
    for (const [k, val] of src) {
        const [bucket, kind] = k.split("|");
        const at = idx.get(bucket);
        if (at === undefined) continue;
        if (kind === "msg") out[at].msg += val.n;
        else if (isGame(kind)) out[at].game += val.n;
        else if (kind === "points") out[at].points += val.v;
    }
    return { range, bucket: hourly ? "hour" : "day", rows: out };
}

function devices() {
    const now = Date.now();
    const days = [...Array(7)].map((_, i) => dayKey(now - (6 - i) * DAY));
    const rows = [];
    for (const [dev, p] of store.presence) {
        const spark = days.map((d) => {
            let n = 0;
            for (const kind of ["msg"]) n += store.daily.get(`${d}|${kind}|${dev}`)?.n || 0;
            return n;
        });
        let msgs = 0, games = 0, up = 0, conns = 0;
        for (const d of days) {
            msgs += store.daily.get(`${d}|msg|${dev}`)?.n || 0;
            conns += store.daily.get(`${d}|conn|${dev}`)?.n || 0;
            for (const [k, v] of store.daily) {
                if (k.startsWith(`${d}|game:`) && k.endsWith(`|${dev}`)) games += v.n;
            }
            up += store.uptimeFor(dev, d, now);
        }
        // Against the window the device has actually been known for, not a flat
        // seven days. A board first seen yesterday that has been up the whole
        // time is at 100%, not 14% -- otherwise every new device looks dead.
        const observed = Math.max(3600e3, Math.min(7 * DAY, now - (p.firstSeen ?? p.since)));
        rows.push({
            dev: DEV8(dev),
            state: p.state,
            since: p.since,
            lastSeen: p.lastSeen,
            knownForMs: observed,
            msgs7d: msgs,
            games7d: games,
            conns7d: conns,
            uptimePct: Math.min(100, Math.round((up / observed) * 100)),
            spark,
        });
    }
    rows.sort((a, b) => b.msgs7d - a.msgs7d || b.lastSeen - a.lastSeen);
    return { days, rows };
}

// How messages break down by kind -- typed, keyed morse, or a pulse. The tag is
// a format marker the firmware puts in front of the payload, not content.
function msgKinds(days = 30) {
    const now = Date.now();
    const got = sumRange(store.daily, dayKey(now - days * DAY), dayKey(now),
                         (k) => (isMsgKind(k) ? k.slice(8) : null));
    const rows = [...got].map(([kind, v]) => ({ kind, n: v.n })).sort((a, b) => b.n - a.n);
    return { days, rows };
}

function games(days = 30) {
    const now = Date.now();
    const from = dayKey(now - days * DAY), to = dayKey(now);
    const got = sumRange(store.daily, from, to, (k) => (isGame(k) ? k.slice(5) : null));
    const rows = [...got].map(([game, v]) => ({ game, n: v.n })).sort((a, b) => b.n - a.n);
    return { days, rows };
}

// ------------------------------------------------------------------ the server
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };

const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://local");
    const send = (code, body, type = "application/json") => {
        res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
        res.end(body);
    };
    try {
        if (url.pathname === "/api/overview.json") return send(200, JSON.stringify(overview()));
        if (url.pathname === "/api/series.json")   return send(200, JSON.stringify(series(url.searchParams.get("range") || "48h")));
        if (url.pathname === "/api/devices.json")  return send(200, JSON.stringify(devices()));
        if (url.pathname === "/api/games.json")    return send(200, JSON.stringify(games(Number(url.searchParams.get("days") || 30))));
        if (url.pathname === "/api/msgkinds.json") return send(200, JSON.stringify(msgKinds(Number(url.searchParams.get("days") || 30))));
        if (url.pathname === "/healthz")           return send(200, "ok\n", "text/plain");

        // Static, and only from public/. normalize() before joining so a
        // ../../ in the path cannot climb out of it.
        const rel = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
        const file = join(PUBLIC, rel);
        if (!file.startsWith(PUBLIC)) return send(403, "no\n", "text/plain");
        const body = await readFile(file);
        return send(200, body, MIME[extname(file)] || "application/octet-stream");
    } catch {
        return send(404, "not found\n", "text/plain");
    }
});

// Loopback only. Nothing reaches this except through nginx, which is where the
// password lives -- so there is no second auth path to keep in step.
server.listen(CFG.port, CFG.host, () => console.log(`[stats] http on ${CFG.host}:${CFG.port}`));
