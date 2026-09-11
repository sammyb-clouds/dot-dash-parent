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
| A | subscribe, parse, de-duplicate, log | nothing |
| **B** | resolve child → parent → device tokens | service account JSON — **running now** |
| C | actually send | APNs `.p8` + app token registration |

## Deployed layout

    /root/dotdash_bridge/bridge.js      the daemon (Node 18)
    /root/dotdash_bridge/node_modules/  mqtt, firebase-admin
    /root/dotdash_bridge/service-account.json   0600, admin key
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

## Routing

    doorbell/monitor/<childHash>/...
      -> artifacts/dotdash/users/<uid>/devices/*   where hashedId == childHash
      -> artifacts/dotdash/users/<uid>/pushTokens/*

The device lookup needs no schema change — the app already writes `hashedId` on
every device doc. It **does** need a `COLLECTION_GROUP_ASC` index on
`devices.hashedId`, which took about two minutes to build. Without it the query
fails with `FAILED_PRECONDITION`, not an empty result, so it is loud.

Both lookups are cached: an hour for device → parent, five minutes for tokens,
and five minutes for *misses* too. An unlinked device keeps publishing to the
Monitor stream forever, and without negative caching it would be re-queried
forever.

## Stage C still needs

- an APNs `.p8` uploaded to Firebase (blocked on Apple Developer enrolment)
- the app to register a push token into `pushTokens` — until then routing
  resolves correctly and reports `tokens=0`, which is the expected end state
  for stage B

## Priming

Message topics are retained and go back months, so the very first subscribe
hands over every message ever sent. Without a guard that is one notification
each. It happens exactly once — afterwards the digest guard recognises them —
so the first run records the backlog silently, then writes a `__primed:msg`
marker. On the real run that absorbed 28 topics and sent nothing.

## Parent lookup

A parent's topic is `sha256(virtualId.toLowerCase().trim())`, matching the app's
`hashId()`. Firestore stores the `virtualId` but not its hash, so the reverse map
is built by hashing every parent profile and cached for ten minutes. With a
handful of families that is cheaper and simpler than adding a field to every
profile and backfilling it.
