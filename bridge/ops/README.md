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
