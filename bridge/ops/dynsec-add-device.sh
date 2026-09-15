#!/bin/sh
# Gives one device its own key on the dynamic security listener.
#
#   dynsec-add-device.sh <host> <port> <deviceHash> <password> [--insecure]
#
# The key's username is the device hash. It joins the shared `devices` group
# (set up by dynsec-device-role.sh) and gets a role of its own, `device-<hash>`,
# naming its hash literally -- the plugin cannot substitute %u, so this is the
# only way to express "its own mailboxes".
#
# Re-running with a new password replaces the password, which is also how a
# key is rotated.
set -eu
HOST=$1; PORT=$2; HASH=$3; PASS=$4; INSECURE=${5:-}
. /root/dotdash_dynsec/admin.env

case "$HASH" in
  *[!0-9a-f]*|"") echo "device hash must be lowercase hex" >&2; exit 2 ;;
esac
[ ${#HASH} -eq 64 ] || { echo "device hash must be 64 characters" >&2; exit 2; }

ctrl() {
  mosquitto_ctrl -h "$HOST" -p "$PORT" -u "$DYNSEC_ADMIN_USER" -P "$DYNSEC_ADMIN_PASS" \
    --cafile /etc/ssl/certs/ca-certificates.crt $INSECURE dynsec "$@" 2>&1 || true
}

ROLE="device-$HASH"
ctrl createRole "$ROLE"
for acl in \
  "publishClientSend doorbell/presence/$HASH" \
  "publishClientSend doorbell/score/+/$HASH" \
  "publishClientSend doorbell/monitor/$HASH/#" \
  "publishClientSend doorbell/cmd/$HASH" \
  "subscribePattern doorbell/msg/$HASH" \
  "subscribePattern doorbell/msg/$HASH/#" \
  "subscribePattern doorbell/cmd/$HASH"
do
  # shellcheck disable=SC2086
  ctrl addRoleACL "$ROLE" $acl allow
done

ctrl createClient "$HASH" -p "$PASS"
ctrl setClientPassword "$HASH" "$PASS"
ctrl addClientRole "$HASH" "$ROLE"
ctrl addGroupClient devices "$HASH"
