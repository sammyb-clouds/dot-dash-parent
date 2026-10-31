# Dot Dash activity logger

    mosquitto -> stats.mjs -> rollups on disk -> a private page at app.dotdashdevice.com/ops/

Counts what happens on the network. Never records what anyone said.

## What it records, and what it refuses to

| Recorded | Not recorded |
|---|---|
| that a message was sent, its **byte count**, and its format tag (`text`/`morse`/`pulse`) | the message itself — no body is ever decoded, let alone stored |
| device **check-ins**, and when each was last seen | the client id, which in the broker log is child-name-like |
| **personal bests** per game, and points awarded | anything tying a hash to a child or a parent |
| the first 8 characters of the topic hash, as the device's name on the page | the id itself, and no reverse lookup exists in this code |

The promise is kept by **shape, not by discipline**. `store.mjs` has no field that
could hold text. `stats.mjs` decodes a payload to a string only for presence,
points and score topics — the three whose payload *is* a control value. A message
payload is never passed to `toString()` at all.

That matters because the broker cannot enforce it. `doorbell/monitor/<hash>/<stamp>`
carries `TYPE,TEXT,SENDER`, so any ACL that lets this process read message
metadata also hands it the bodies. The restraint is in this code, and nowhere else.

## Four things that are easy to get wrong

**Retained is not news.** Every topic in this system is retained, so the broker
replays all of them on each reconnect. Counting those would invent a traffic
spike on every restart — the push bridge hit exactly this and carries a replay
guard for it. Here `packet.retain` separates them: the broker sets it only when
delivering because of a *new subscription*, so retained arrivals seed baselines
and count for nothing.

**Devices are not "online".** They hold a session for one to three seconds and
drop it. An instantaneous online count measures when you looked, not the fleet,
and logging every presence flap would be tens of thousands of rows a day of the
least interesting fact in the system. So only the ONLINE edge is an event, at
most one a minute per device, counted as a **check-in**; the headline figure is
*seen in the last 15 minutes*.

**`doorbell/score/<x>/` is not all games.** `2p` is a retained capability marker
published on connect and cleared on disconnect — counting it would show a
two-player session every time a device woke up. `points` and `voice` are mirrors
of other state. Hence `GAMES` is an allowlist (`dotty`, `dasher`, `train`,
`defender`, `jumper`), never a denylist.

**A numeric leaf is not always an epoch.** `monitor/<hash>/<stamp>` leaves come in
13 digits (epoch ms) *and* 5–8 digits (a `millis()` fallback from a device whose
clock was never set). The leaf is used only to recognise the topic; the timestamp
is always server receive time, which is the one clock that means the same thing
for every device.

## Storage

Dependency-free on purpose: Node 18 on the droplet has no built-in `node:sqlite`,
and there is no `sqlite3` CLI on the box. An append-only `events.ndjson` (7 days,
a debugging aid) plus `rollups.json` (hourly 90 days, daily indefinitely, written
temp-and-rename so a power cut cannot truncate it). At this fleet size that is a
few hundred KB a year and `jq` can read all of it without this process running.
Swapping in SQLite later touches `store.mjs` only.

## It must never disturb the bridge

`bridge.js` holds the push subscription *and* serves the `/c/` chats. The unit
here has no `Requires=`/`BindsTo=` on it, runs `Nice=10` with `MemoryMax=100M`
and `OOMScoreAdjust=500` — the box has 961 MB, one CPU, and already runs the
bridge, enroll, sms, voice, giveaway, postgres and mosquitto. This is the least
important process on the machine and is configured to be the first one killed.
A dashboard must never be why a message fails to deliver.

**There is no `publish()` call in this codebase.** The broker sees a subscriber
and nothing else.

## Deploying

It needs **a broker account that does not exist yet**. No current account can read
all three of presence, monitor and score: `dotdash-app` has no score read,
`dotdash-bridge` reads only monitor and msg, and `DigitalDoorbell` only *writes*
monitor — deliberately, so it cannot read that stream back. Do not reuse any of
them, and never the firmware-recoverable one.

Two routes, both needing Sam's say-so:

- **dynsec (8885)** — create a client and a role via the `$CONTROL` API with the
  scripts in `/root/dotdash_dynsec/`. No mosquitto restart. Preferred.
- **legacy (8883)** — add a user to `/etc/mosquitto/passwd` and a block to
  `/etc/mosquitto/aclfile` with `topic read` on `doorbell/presence/+`,
  `doorbell/monitor/+/#` and `doorbell/score/+/+`. Needs a reload.

Then:

```
rsync the folder to /root/dotdash_stats/      # stats.mjs, store.mjs, public/, package.json
cd /root/dotdash_stats && npm install --omit=dev
install -m 600 stats.env /root/dotdash_stats/stats.env
cp dotdash-stats.service /etc/systemd/system/ && systemctl daemon-reload
systemctl enable --now dotdash-stats
openssl passwd -apr1 > /etc/nginx/dotdash-ops.htpasswd   # htpasswd is NOT installed
# prefix the line with "sam:" -- the file is user:hash
# paste nginx-ops.conf INSIDE the 443 server block in sites-available/dotdash
nginx -t && systemctl reload nginx
```

`stats.env` holds `STATS_MQTT_URL`, `STATS_MQTT_USER`, `STATS_MQTT_PASS`,
`STATS_DIR=/root/dotdash_stats/data`, `STATS_PORT=8787`. Connect to the
**hostname** (`mqtts://mqtt.dotdashdevice.com:8883`), never `localhost`: the
listener presents a Let's Encrypt cert for `app./mqtt.dotdashdevice.com` and
`localhost` fails hostname verification even from the box itself. Verify against
the **system CA store**, not the deploy's `chain.pem`, which is the intermediate
alone with no root to anchor it.

The nginx edit lands in the **production** `app.` vhost, which has no staging
twin, and a reload applies to real families immediately. The `^~` on the location
is not optional: that vhost has regex locations (`~* \.html$` and the
service-worker rules) which would otherwise win and serve the dashboard's own
`index.html` as a static file instead of proxying it.

## Known gap: Train is nearly invisible

The firmware does not publish stage-level Train data. Finishing LETTERS, WORDS or
TEST only moves `monitor/<hash>/points` by +3, on the same topic arcade wins use,
so **Train practice cannot be separated from arcade play**, and TEST results —
the one genuinely interesting learning signal — never leave the device. All this
dashboard can show is `score/train` personal bests.

Closing it is a small firmware change: one publish of
`doorbell/monitor/<hash>/train` carrying stage and result. It would need mirroring
to C62 and merging to the walkie like any other change, and it is **not** done.
