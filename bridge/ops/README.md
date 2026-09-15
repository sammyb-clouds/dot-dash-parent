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
