#!/bin/sh
# Install or update the mailing-list signup service on the droplet.
#
#   ./deploy-signup.sh
#
# Safe to re-run: it replaces the script and the unit, never signup.env (the
# secrets) and never /var/lib/dotdash-signup (the list). Restarting this
# service is harmless -- it is deliberately NOT part of sms.mjs, which also
# serves the /c/ chat pages and must not be bounced to ship a copy change.
set -eu
HOST=${HOST:-root@45.55.47.32}
DIR=/root/dotdash_bridge

echo "-> signup.mjs and the unit"
scp -q signup.mjs "$HOST:$DIR/signup.mjs"
scp -q dotdash-signup.service "$HOST:/etc/systemd/system/dotdash-signup.service"

ssh "$HOST" "set -eu
  if [ ! -f $DIR/signup.env ]; then
    echo '!! $DIR/signup.env is missing. Create it 0600 with:'
    echo '   RESEND_API_KEY=...'
    echo '   RESEND_AUDIENCE_ID=...'
    echo '   EMAIL_FROM=Dot Dash <hello@dotdashdevice.com>'
    echo '   SIGNUP_SHOW_FROM=25'
    exit 1
  fi
  chmod 600 $DIR/signup.env
  systemctl daemon-reload
  systemctl enable --now dotdash-signup
  systemctl restart dotdash-signup
  sleep 1
  systemctl --no-pager -l status dotdash-signup | head -12"

echo "-> nginx (the /signup/api/ location must already be in the site config)"
ssh "$HOST" "nginx -t && systemctl reload nginx"

echo "-> live check"
curl -fsS https://dotdashdevice.com/signup/api/count && echo
