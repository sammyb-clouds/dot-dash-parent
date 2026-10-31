// Storage for the activity logger.
//
// Deliberately dependency-free: an append-only NDJSON event log plus rollup
// tables held in memory and flushed to JSON. At this fleet's size that is a few
// hundred KB a year, it survives a crash, and -- the part that matters for an
// ops tool -- every file can be read with `jq` at three in the morning without
// this process running. Swapping in SQLite later touches this file only.
//
// WHAT THIS FILE CANNOT DO IS STORE A MESSAGE BODY. There is no field for one.
// The daemon hands it a byte count, never the bytes, and that is enforced by
// shape rather than by anyone remembering.

import { readFile, writeFile, rename, mkdir, appendFile, stat } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

const HOUR = 3600e3, DAY = 86400e3;

export const hourKey = (ms) => new Date(ms).toISOString().slice(0, 13);  // 2026-10-31T14
export const dayKey  = (ms) => new Date(ms).toISOString().slice(0, 10);  // 2026-10-31

export class Store {
    constructor(dir, { rawDays = 7, hourlyDays = 90 } = {}) {
        this.dir = dir;
        this.rawDays = rawDays;
        this.hourlyDays = hourlyDays;
        this.rawPath   = join(dir, "events.ndjson");
        this.rollPath  = join(dir, "rollups.json");
        // key "hour|kind|dev" -> {n, v}
        this.hourly = new Map();
        // key "day|kind|dev"  -> {n, v}
        this.daily  = new Map();
        // dev -> {state, since, lastSeen, firstSeen}
        this.presence = new Map();
        // key "day|dev" -> online milliseconds
        this.uptime = new Map();
        this.dirty = false;
    }

    async open() {
        await mkdir(this.dir, { recursive: true });
        if (existsSync(this.rollPath)) {
            try {
                const j = JSON.parse(await readFile(this.rollPath, "utf8"));
                this.hourly   = new Map(j.hourly || []);
                this.daily    = new Map(j.daily || []);
                this.uptime   = new Map(j.uptime || []);
                this.presence = new Map((j.presence || []).map(([k, v]) => [k, v]));
            } catch (e) {
                // A truncated rollup file is recoverable: the raw log still holds
                // the retention window, and replay below rebuilds from it. Losing
                // older rollups is the cost, and it beats refusing to start.
                console.warn("[stats] rollups unreadable, rebuilding from raw:", e.message);
                this.hourly.clear(); this.daily.clear(); this.uptime.clear();
                await this.#replayRaw();
            }
        } else if (existsSync(this.rawPath)) {
            await this.#replayRaw();
        }
    }

    async #replayRaw() {
        const rl = createInterface({ input: createReadStream(this.rawPath), crlfDelay: Infinity });
        for await (const line of rl) {
            if (!line.trim()) continue;
            try { this.#roll(JSON.parse(line)); } catch { /* a half-written tail line */ }
        }
        this.dirty = true;
    }

    // One event in. `ev` is {ts, kind, dev, v} and nothing else is persisted.
    async add(ev) {
        this.#roll(ev);
        this.dirty = true;
        await appendFile(this.rawPath, JSON.stringify(ev) + "\n");
    }

    #roll({ ts, kind, dev, v = 0 }) {
        const bump = (map, key) => {
            const cur = map.get(key) || { n: 0, v: 0 };
            cur.n += 1; cur.v += v;
            map.set(key, cur);
        };
        bump(this.hourly, `${hourKey(ts)}|${kind}|${dev}`);
        bump(this.daily,  `${dayKey(ts)}|${kind}|${dev}`);
    }

    // Presence is a state machine rather than a counter: the interesting number
    // is how long a device was up, which only exists as the gap between two
    // transitions. `firstSeen` is kept so a device that has never been offline
    // still has a denominator.
    markPresence(dev, online, ts) {
        const cur = this.presence.get(dev);
        if (cur && cur.state === (online ? "on" : "off")) { cur.lastSeen = ts; this.dirty = true; return false; }
        if (cur && cur.state === "on") this.#creditUptime(dev, cur.since, ts);
        this.presence.set(dev, {
            state: online ? "on" : "off",
            since: ts,
            lastSeen: ts,
            firstSeen: cur?.firstSeen ?? ts,
        });
        this.dirty = true;
        return true;   // a real transition, worth an event row
    }

    // Split an online stretch across the days it spans, so a device left on
    // overnight does not credit twelve hours to the day it happened to start in.
    #creditUptime(dev, from, to) {
        let cursor = from;
        while (cursor < to) {
            const dayEnd = Date.parse(dayKey(cursor) + "T23:59:59.999Z") + 1;
            const slice = Math.min(to, dayEnd) - cursor;
            const key = `${dayKey(cursor)}|${dev}`;
            this.uptime.set(key, (this.uptime.get(key) || 0) + slice);
            cursor += slice;
        }
    }

    // Uptime for a device that is still online has to include the open stretch,
    // or every currently-up device reads as idle since its last reboot.
    uptimeFor(dev, day, now = Date.now()) {
        let ms = this.uptime.get(`${day}|${dev}`) || 0;
        const p = this.presence.get(dev);
        if (p?.state === "on") {
            const dayStart = Date.parse(day + "T00:00:00.000Z");
            const dayEnd = dayStart + DAY;
            const from = Math.max(p.since, dayStart);
            const to = Math.min(now, dayEnd);
            if (to > from) ms += to - from;
        }
        return ms;
    }

    prune(now = Date.now()) {
        const hourCut = dayKey(now - this.hourlyDays * DAY);
        for (const k of this.hourly.keys()) if (k.slice(0, 10) < hourCut) this.hourly.delete(k);
        this.dirty = true;
    }

    async flush() {
        if (!this.dirty) return;
        const body = JSON.stringify({
            v: 1,
            written: new Date().toISOString(),
            hourly: [...this.hourly],
            daily: [...this.daily],
            uptime: [...this.uptime],
            presence: [...this.presence],
        });
        // Temp-and-rename: a power cut mid-write leaves the old file intact
        // rather than a half-parsed one, which is the whole reason the raw log
        // is kept as well.
        const tmp = this.rollPath + ".tmp";
        await writeFile(tmp, body);
        await rename(tmp, this.rollPath);
        this.dirty = false;
    }

    // The raw log is a debugging aid, not the record, so it is trimmed by
    // rewriting rather than rotated -- the rollups already hold the history.
    async trimRaw(now = Date.now()) {
        if (!existsSync(this.rawPath)) return;
        const cut = now - this.rawDays * DAY;
        const s = await stat(this.rawPath);
        if (s.size < 512 * 1024) return;   // not worth the rewrite yet
        const keep = [];
        const rl = createInterface({ input: createReadStream(this.rawPath), crlfDelay: Infinity });
        for await (const line of rl) {
            if (!line.trim()) continue;
            try { if (JSON.parse(line).ts >= cut) keep.push(line); } catch { /* drop */ }
        }
        const tmp = this.rawPath + ".tmp";
        await writeFile(tmp, keep.join("\n") + (keep.length ? "\n" : ""));
        await rename(tmp, this.rawPath);
    }
}

export { HOUR, DAY };
