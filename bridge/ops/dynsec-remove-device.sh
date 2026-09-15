#!/bin/sh
# Removes a device's own key. This is the per-device REVERT: with its key gone,
# firmware that has a fallback logs in with the shared password again.
#
#   dynsec-remove-device.sh <host> <port> <deviceHash> [--insecure]
set -eu
HOST=$1; PORT=$2; HASH=$3; INSECURE=${4:-}
. /root/dotdash_dynsec/admin.env
ctrl() {
  mosquitto_ctrl -h "$HOST" -p "$PORT" -u "$DYNSEC_ADMIN_USER" -P "$DYNSEC_ADMIN_PASS" \
    --cafile /etc/ssl/certs/ca-certificates.crt $INSECURE dynsec "$@" 2>&1 || true
}
ctrl deleteClient "$HASH"
ctrl deleteRole "device-$HASH"
