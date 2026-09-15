# Broker operations

`mosquitto-dotdash.conf` is the reference copy of
`/etc/mosquitto/conf.d/dotdash.conf` on the droplet. Change the live file and
this copy together.

## Before and after ANY auth or ACL change

    scp bridge/tools/authtest.mjs root@45.55.47.32:/root/dotdash_demo/
    ssh root@45.55.47.32 'cd /root/dotdash_demo && set -a && . ./authtest.env && set +a \
      && node authtest.mjs mqtt.dotdashdevice.com 8883 8884'

`authtest.env` (0600, on the droplet only) holds the three shared passwords the
test logs in with. It never goes in git.

The test checks what each login must and must not be able to do. Run it against
the current broker first -- a test that fails before the change proves nothing
about the change. To try a config without touching production, start it on
local-only ports (see the Stage 0 notes) and point the test at `127.0.0.1` with
`--insecure`.

## Rolling back

Every change starts with a full backup under `/root/mosquitto-backup-<timestamp>`
(config directory plus `mosquitto.db`). `/root/mosquitto-backup-LATEST` names the
newest. To restore the config:

    B=$(cat /root/mosquitto-backup-LATEST)
    cp -a $B/etc-mosquitto/conf.d/dotdash.conf /etc/mosquitto/conf.d/dotdash.conf
    systemctl restart mosquitto

A restart drops every client for about five seconds; devices, the bridge and the
app reconnect on their own, and retained messages survive because persistence
is on.

`OpenSSL Error ... unexpected eof while reading` in mosquitto.log is normal
background noise -- clients (sleeping devices) dropping without a TLS close. It
runs at roughly the same rate before and after any change.

## Per-device keys (port 8885)

Port 8885 runs mosquitto's dynamic security plugin. A device logs in there with
its OWN key -- username is its hash -- and can reach only its own mailboxes.
8883 and 8884 are untouched and keep the shared logins.

On the droplet, in `/root/dotdash_dynsec/` (0700):

- `admin.env` -- the admin login that manages keys. Its role can manage keys and
  read `$SYS`, and deliberately NOT read `#`: the default admin role mosquitto
  creates can read every message on the broker, which would make this one
  credential a copy of every child's messages.
- `dynsec-device-role.sh <host> <port>` -- the rules every device shares.
- `dynsec-add-device.sh <host> <port> <hash> <password>` -- gives one device its
  key and a role naming its own hash. Also rotates a password.
- `dynsec-remove-device.sh <host> <port> <hash>` -- the per-device revert.
- `testkey.env` -- a hand-made key for a hash that belongs to nobody, used by
  the test.

Keys live in `/var/lib/mosquitto/dynamic-security.json`, written by the plugin
and preserved across restarts. The plugin is not reloaded on SIGHUP.

**mosquitto 2.0.18's plugin does not substitute `%u` or `%c` in ACL topics.**
That is why each device gets its own role instead of one shared rule on
`doorbell/msg/%u/#` -- which would match only a topic literally named `%u`.

Check keys with `bridge/tools/keytest.mjs` (22 checks), alongside `authtest.mjs`:

    ssh root@45.55.47.32 'cd /root/dotdash_demo && set -a && . ./authtest.env \
      && . /root/dotdash_dynsec/testkey.env && set +a \
      && node keytest.mjs mqtt.dotdashdevice.com 8883 8884 8885'

8885 is NOT open in the firewall yet. The tests run from the droplet itself.
Open it (`ufw allow 8885`) when the first real device needs it.

## Enrollment (`/enroll`)

`bridge/enroll.mjs`, running as `dotdash-enroll.service` from
`/root/dotdash_bridge` (it shares the bridge's `node_modules` and service
account) on `127.0.0.1:8790`, reached through nginx at
`https://app.dotdashdevice.com/enroll`. The file header documents the protocol.

- Issues a key only to a device some parent has already paired: a device record
  whose id is the MAC and whose `hashedId` is the hash.
- First enrollment locks. The same secret again succeeds (a device that lost the
  reply); a different one is refused with 409 and recorded as
  `mqttKey.conflictAt` / `mqttKey.conflicts` on the device record.
- Writes `mqttKey.enrolledAt` on success. Never logs or stores a secret; the
  repeat check is a real broker login with the offered secret.
- nginx rate limit: 10 requests/minute per address, burst 10
  (`nginx-dotdash-enroll-zone.conf`, `location = /enroll` in
  `nginx-dotdash.conf`). After `systemctl reload nginx`, allow a second before
  testing -- a request that races the reload hits the old workers and 404s.

Check it end to end with `bridge/tools/enrolltest.mjs`. It creates a
throwaway device record under the demo account, enrolls it through the public
URL, and removes both record and key afterwards:

    ssh root@45.55.47.32 'cd /root/dotdash_bridge && set -a \
      && . /root/dotdash_demo/authtest.env && . /root/dotdash_dynsec/admin.env && set +a \
      && node enrolltest.mjs https://app.dotdashdevice.com/enroll mqtt.dotdashdevice.com 8885 8884'

### Batched changes, reset, sweep (2026-09-15)

- **One key-store write per change.** Every dynamic-security command rewrites
  the whole key store; one control message with several commands rewrites it
  once (measured live: 9 separate messages = 9 saves, 1 batched = 1). Enrollment,
  key removal and resets are each a single batched message. `dynsec-add-device.sh`
  still issues commands one at a time -- fine for hand use, not for bulk.
- **Parent reset.** The app writes `users/<uid>/keyResets/<deviceId>`
  (`{ hashedId, requestedAt }`); only the account owner can, per the database
  rules. The service deletes the key, clears `mqttKey.conflicts/conflictAt/
  enrolledAt`, sets `mqttKey.resetAt`, and deletes the request. The app then
  publishes `CMD,REENROLL` and the device enrolls at once. Without a device
  record (unlink), a reset is honoured only if the key's `textname` is exactly
  that device path under the requester's account -- otherwise anyone could name
  another family's hash.
- **Unlink** resets the key before deleting the device record.
- **Orphan sweep** every 6 hours (`SWEEP_EVERY_MS`) and a minute after start:
  a key whose device record is gone, or no longer carries its hash, is removed
  after two consecutive misses. Clients with `textname` starting `keep:` are
  skipped -- the hand-made test key is `keep:keytest`. Run one now on the droplet:
  `curl -X POST http://127.0.0.1:8790/internal/sweep` (not reachable through nginx).
- **Conflicts** show in the app's Settings as a red "Connection security" card
  with the reset button.

`enrolltest.mjs` covers all of it (27 checks) and needs `testkey.env` loaded too.

## Stage 3 test firmware and per-device revert

C3 firmware that uses per-device keys lives on the `mqtt-keys` branch of the C3
repo, checked out as a separate worktree at
`~/Documents/Arduino/Dot Dash/worktrees/mqtt-keys/dot_dash_7_3`, and is published
as **`dot-dash-code-m.bin`** -- never through the `-t` slots, so ordinary test
builds cannot pick it up. Build it by hand:

    arduino-cli compile --warnings none --output-dir /tmp/dd-m-build \
      "~/Documents/Arduino/Dot Dash/worktrees/mqtt-keys/dot_dash_7_3"
    cp /tmp/dd-m-build/dot_dash_7_3.ino.bin ~/Documents/GitHub/dot-dash-code/dot-dash-code-m.bin

A device on it can be reverted without reflashing:

    ssh root@45.55.47.32 'cd /root/dotdash_bridge && set -a && . /root/dotdash_dynsec/admin.env \
      && set +a && node devicekey.mjs revoke INSTA0515'

`revoke` removes the key and sets `mqttKey.disabled` so enrollment is refused:
the device falls back to the shared login and stays there. `allow` lifts it;
`status` shows the key, enrollment state and conflicts. Flashing the `-t` bin is
the full revert.

The certificate renewal hook `/etc/letsencrypt/renewal-hooks/deploy/restart-mosquitto.sh`
restarts mosquitto after renewal. Without it the broker keeps serving the old
certificate, and keyed devices -- which verify it -- would fall back to the
shared login once it expired.

## Droplet hardening (2026-09-15)

The droplet is 512 MB (458 usable) with ONE vCPU. The OOM killer fired twice on
2026-09-15, both times taking `fwupd`; each event stalled the box long enough to
drop every broker connection.

- `fwupd`, `fwupd-refresh.service` and `fwupd-refresh.timer` are **masked**.
  Firmware updates mean nothing on a cloud VM and fwupd ballooned to 150 MB.
- 1 GB swap at `/swapfile` (in `/etc/fstab`), `vm.swappiness=10`
  (`/etc/sysctl.d/60-dotdash-swap.conf`) -- overflow for bursts, not working
  memory.
- OOM priority via drop-ins `/etc/systemd/system/<svc>.service.d/oom.conf`:
  mosquitto -900, dotdash-bridge -600, dotdash-enroll -300. Lower is killed
  later.

## The doorbell dashboard (`doorbell.service`)

`/root/doorbell_app/mqtt_web_server.py` -- a Flask page showing the last 100
messages on every topic the shared device login can read: children's messages
with names and PINs, device commands including Wi-Fi sync payloads, presence,
scores. Not in any repo.

It was bound to 0.0.0.0:5000 with port 5000 open and no login, and outside
addresses were connected to it. Since 2026-09-15 it listens on **127.0.0.1**
only and 5000 is removed from ufw. Backup of the original beside the script.
View it with:

    ssh -L 5000:localhost:5000 root@45.55.47.32     # then http://localhost:5000

It logs in with the SHARED device password, so it stops working at MQTT Stage 6
unless it is given a read-only login of its own first.
