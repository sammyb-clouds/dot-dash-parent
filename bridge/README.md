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

## The Monitor feed is written down too (2026-09-24)

`users/<uid>/monitor/<stamp>` holds every message a child sends or receives --
`{ id, type, text, direction: 'in'|'out', childMac, otherParty, receivedAt }` --
pruned to the most recent 200 per parent by the same counter as `messages`.

Why: a Monitor copy used to exist ONLY as a retained MQTT message, and the app
deleted it as soon as it had stored it in that phone's local storage. So it
lived in exactly one place -- whichever client saw it first. A parent's second
phone never saw it, and reinstalling the app (every TestFlight build is a fresh
container) lost the history outright. The bridge is always connected, so it
writes each copy here; the app still takes the live MQTT copy for immediacy and
merges by id.

`otherParty` on an outgoing entry is the recipient's HASH when the firmware
appends one -- that is what travels on the wire, and the app resolves it against
the family's own friend lists. Incoming entries carry the sender's id as sent.

Cost: roughly one extra small write per child message, the same shape as the
message writes already sized in the scaling note.

## signup.mjs — the home page mailing list

The box under "Want one?" on dotdashdevice.com. Adds the address to the
**Website** audience in Resend and sends one welcome email.

    /root/dotdash_bridge/signup.mjs
    /root/dotdash_bridge/signup.env          0600, never in git
    /var/lib/dotdash-signup/signups.jsonl    created by systemd (StateDirectory)
    /etc/systemd/system/dotdash-signup.service

    ./deploy-signup.sh          # idempotent; never touches signup.env or the list
    journalctl -u dotdash-signup -f

`signup.env` needs `RESEND_API_KEY`, `RESEND_AUDIENCE_ID`, `EMAIL_FROM` and
optionally `SIGNUP_SHOW_FROM`. nginx proxies `^~ /signup/api/` to
127.0.0.1:8794 (`ops/nginx-dotdashdevice-site.conf`).

**Its own process, not a route in sms.mjs.** That service also serves the `/c/`
chat pages for link contacts; restarting it to ship a copy change on a signup
form would cut live conversations off. This one restarts freely.

**It stores a hash, not the address.** `signups.jsonl` holds
`sha256(lowercased, trimmed address)` and a timestamp. Resend is the system of
record; the only two local questions are "how many" and "have we welcomed this
one", and a hash answers both. Lowercase and trim BEFORE hashing or the same
person hashes two ways — the same discipline as the MQTT topic keys.

**One welcome per address, ever.** This is the control that makes a public
single-opt-in form safe: a repeat signup is idempotent and silent, so the worst
a scripted abuser can do to any given victim is one email. The per-IP limit
(60/hour) is deliberately loose for the reason `raffle/src/lib/rate-limit.ts`
spells out — carrier-grade NAT puts thousands of real people behind one IP.

**`SIGNUP_SHOW_FROM` (default 25)** is the count below which the page shows no
number at all. A public "3 people waiting" argues against the product. The
server decides, not the page.

**It works without JavaScript.** The form has a real `action`/`method`, and a
request that doesn't ask for JSON gets a plain HTML page back.

**The welcome email's HTML part is pure ASCII**, entities and all, with its own
`<meta charset>`. An HTML part that travels without a charset of its own and
contains raw UTF-8 renders as mojibake in some clients — which is exactly what
the first draft did. `reply_to` is support@, because the email tells people
they can reply to get off the list and hello@ is only a sending address.

### Unsubscribe

Every welcome email carries a link, and the message also sets
`List-Unsubscribe` and `List-Unsubscribe-Post` so Gmail's and Apple Mail's own
Unsubscribe buttons work (RFC 8058 one-click).

The link has to carry the address, because this service stores only hashes
and cannot look one up -- so it is **signed**: address plus a truncated HMAC,
and an edited link is refused with a 400. The key is generated once into
`/var/lib/dotdash-signup/secret` (0600), or set `SIGNUP_SECRET` to pin it.
Wiping the state directory invalidates every link already sent; that is the
price of not putting another secret in `signup.env`.

**GET only asks; POST does it.** Mail clients and security scanners fetch
every link in a message to check it, so a GET that unsubscribed would quietly
remove people who never clicked. GET renders a confirm page with a button;
the button and the mail client's one-click POST both hit the same route.

**Subscribing an address we already know clears the unsubscribed flag.**
Without that, somebody who left and came back would be told "you're already
on the list" while Resend went on skipping them.

Verified against the live API: subscribe -> `unsubscribed=false`, GET the link
-> unchanged, one-click POST -> `unsubscribed=true`, subscribe again ->
`unsubscribed=false`.

### Importing a list collected elsewhere — `import-list.mjs`

The giveaway app's admin page exports **Mailing list CSV**: everyone who ticked
*"Do you want to receive messages about future Dot Dash news?"*, which is
unchecked by default. That is the same promise the home-page box makes, so
those addresses belong on the same list.

```
node import-list.mjs list.csv            # parse and validate, change nothing
node import-list.mjs list.csv --live     # import
```

It does **two** things, and the second is the one that is easy to forget:

1. **Resend** — one `POST /audiences/{id}/contacts` per address. Creating a
   contact sends no mail; the script never calls `/emails`. People who signed
   up somewhere else must not receive the home page's welcome message, which
   thanks them for something they did not just do.
2. **The hash store** — appends `sha256(lowercased address)` to
   `signups.jsonl` and restarts the service. This is what makes the public
   count true, and it also arms the welcome-once rule: an imported person who
   later types their address into the form is told *"you are already on the
   list"* and nothing is sent.

Skip step 2 and you get both failures at once — a count that reads 2 while the
list holds 250, and a welcome email waiting to fire at every one of them.

Both halves are safe to re-run: Resend upserts by address (a repeat POST
returns 201 and the audience does not grow), and the store merge skips hashes
already on file. A timestamped backup of `signups.jsonl` is taken first.

The `opted_in_at` column is carried into the store's `t` field, so the record
says when each person actually opted in rather than when the import ran.

### One list, not a sum of lists

When addresses already live in another Resend audience, **move them into the
Website audience** rather than making the counter add two audiences together.
Summing looks cheaper and hides a trap: a known address that uses the form
takes the `already` branch, which clears the unsubscribed flag with a PATCH
*against the Website audience*. Verified against the live API — that PATCH on a
non-member returns `404 Contact not found` and does **not** upsert. So anyone
counted but not actually in the audience would be told "you're already signed
up" and would never join the list they just asked for. Silent, and it only
shows up months later as a list smaller than the number on the page.

Two smaller things learned doing it:

- A Resend contact's `created_at` is the **email identity's** first appearance
  across the account, not when it joined this audience — so a freshly imported
  contact can show a date from weeks before the audience existed. Don't read
  it as "joined this list on".
- Re-POSTing an existing address returns 201 and the audience does not grow.
  Resend upserts by address, so overlaps between audiences need no special
  handling.

**Done 2026-11-06,** list 2 → 225 in two passes:

- **+48** from the giveaway's "Mailing list CSV" export (the opt-in checkbox).
- **+175** merged in from the **IG SURVEY** audience (187 contacts, 11 already
  present, 1 dropped: `...@gmail.comw`, a typo that would only ever bounce).
  Sam confirmed everyone on that list signed up to be told when Dot Dash would
  be available — the same promise the box makes, which is what allows the two
  to become one list.

Addresses only; both sources carry names and nothing needs them. Privacy
policy section 5B was widened to say the list holds these sign-ups too.
