#!/bin/sh
# Defines what a device logged in with its OWN key may do, on a listener that
# runs mosquitto's dynamic security plugin.
#
#   dynsec-device-role.sh <host> <port> [--insecure]
#
# Reads DYNSEC_ADMIN_USER / DYNSEC_ADMIN_PASS from /root/dotdash_dynsec/admin.env.
# Safe to re-run: create* on something that exists just reports it exists.
#
# The username of a keyed device IS its hash (sha256 of the lowercased NAME+PIN),
# so "own topics" means topics carrying the device's own hash. Derived from every
# publish and subscribe in the firmware:
#
#   reads    its own mail and commands; friends' presence and scores; its
#            pairing topic
#   writes   mail to anyone (that is what messaging is); its own presence,
#            scores, Monitor copies and command clears; pairing replies
#
# This script sets up the part every device shares -- the `devices` group and its
# `device` role. The part that names a device's own hash is a role PER DEVICE,
# made by dynsec-add-device.sh when a device is given its key.
#
# Why per device: mosquitto 2.0.18's dynamic security plugin does not substitute
# %u or %c in ACL topics. A shared rule on doorbell/msg/%u/# silently matches a
# topic literally named "%u" and nothing else -- a device could not receive its
# own mail. keytest.mjs caught it (2026-09-15).
#
# What this takes away from a leaked device credential, compared with the shared
# login: reading any other device's mail or commands, injecting or clearing
# another device's commands, and faking another device's presence, scores or
# Monitor feed. It does NOT stop a device putting a false sender name inside a
# message payload -- that needs the sender in the topic, a later change.
set -eu

HOST=$1; PORT=$2; INSECURE=${3:-}
. /root/dotdash_dynsec/admin.env

ctrl() {
  mosquitto_ctrl -h "$HOST" -p "$PORT" -u "$DYNSEC_ADMIN_USER" -P "$DYNSEC_ADMIN_PASS" \
    --cafile /etc/ssl/certs/ca-certificates.crt $INSECURE dynsec "$@" 2>&1 || true
}

ctrl setDefaultACLAccess publishClientSend deny
ctrl setDefaultACLAccess publishClientReceive allow
ctrl setDefaultACLAccess subscribe deny
ctrl setDefaultACLAccess unsubscribe allow

ctrl createRole device
for acl in \
  "publishClientSend doorbell/msg/+" \
  "publishClientSend doorbell/msg/+/#" \
  "publishClientSend doorbell/pairing/reply/+" \
  "subscribePattern doorbell/presence/+" \
  "subscribePattern doorbell/score/+/+" \
  "subscribePattern doorbell/pairing/+"
do
  # shellcheck disable=SC2086
  ctrl addRoleACL device $acl allow
done

ctrl createGroup devices
ctrl addGroupRole devices device
ctrl getRole device
