# Dot Dash push bridge

    device -> mosquitto -> bridge -> FCM -> APNs -> parent's phone

iOS suspends the parent app in the background and its MQTT connection with it,
so the app cannot know anything happened while the phone is in a pocket. This
process stays subscribed around the clock and forwards the three events a parent
can actually act on: `friendreq`, `timerreq`, `battery`.

It cannot be a Cloud Function — those are request-scoped and cannot hold a
persistent MQTT subscription — so it runs on the droplet beside mosquitto.

## Stages

Built in layers so each is proven before the next is wired. A missing credential
downgrades the stage; it never crashes the process, because a bridge that dies
quietly is worse than no bridge — the alerts still look like they work.

| stage | does | needs |
|---|---|---|
| **A** | subscribe, parse, de-duplicate, log | nothing — **running now** |
| B | resolve child → parent → device tokens | Firebase service account JSON |
| C | actually send | APNs `.p8` uploaded to Firebase |

## Deployed layout

    /root/dotdash_bridge/bridge.py      the daemon
    /root/dotdash_bridge/venv/          paho-mqtt
    /root/dotdash_bridge/bridge.env     secrets, 0600 root only
    /root/dotdash_bridge/state.json     replay guard
    /etc/systemd/system/dotdash-bridge.service

    systemctl status dotdash-bridge
    journalctl -u dotdash-bridge -f

## Two things that are easy to get wrong

**Not every Monitor topic is an alert.** The same prefix carries a copy of every
outgoing message on `doorbell/monitor/<hash>/<timestamp>` for the Monitor feed.
Pushing those would notify a parent about each message their child sends — that
is surveillance, not an alert. Only the three named kinds are forwarded.

**Every topic here is retained**, so the broker redelivers all outstanding ones
on each reconnect. Without the replay guard, every restart would re-notify every
parent about events they dismissed days ago. State is keyed topic → payload
digest: a redelivery matches and is skipped, a value that changed while the
bridge was down does not match and is delivered.

## Connecting

Use the **hostname**, not `localhost` — the listener presents a Let's Encrypt
cert for `app./mqtt.dotdashdevice.com`, so `localhost` fails TLS hostname
verification even from the box itself. And verify against the **system CA
store**, not the deploy's `chain.pem`, which is the intermediate alone with no
root to anchor it.
