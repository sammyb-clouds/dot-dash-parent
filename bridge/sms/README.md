# Dot Dash SMS bridge

    device <-MQTT/TLS-> mosquitto <-> sms.mjs <-REST / webhook-> Twilio <-SMS-> phone

Lets a parent-approved phone number text one child's Dot Dash, and the child
text back, through a small shared pool of Twilio numbers.

**Status (2026-09-25): running on the droplet in DRY_RUN** (texts are logged,
never sent), with placeholder Twilio credentials and a stand-in pool number
(800) 555-0100. The app's phone-contact screen is on test.html only. Tested end
to end on SAM0515 in both directions. Waiting on the Twilio account; see
"Twilio setup".

## The one idea: a phone contact is a virtual friend

The firmware already knows how to talk to a friend who is not a device: the
parent's own ID sits in every device's friend list. A phone contact works the
same way. Adding Grandma to Maya's device creates a friend ID like
`GRANDMA4821`, which goes into Maya's friend list like any other friend.

- **Child -> phone.** The device sends to `GRANDMA4821` as it sends to anyone,
  publishing `TEXT,<text>,MAYA0515` on `doorbell/msg/<sha256("grandma4821")>/<stamp>`.
  The bridge is subscribed to that topic. It texts the words to Grandma's phone
  from the pool number and clears the retained copy.
- **Phone -> child.** The bridge publishes `TEXT,<text>,GRANDMA4821` on
  `doorbell/msg/<Maya's hash>/<stamp>`. The device sees a message from a friend.

**No firmware change is needed**, which means it works on every device already
in the field, including C6. The parent's Monitor shows both directions,
because it already shows everything to and from a friend. The device displays
the sender with its last four characters removed (they are normally a child's
birthday PIN), so Maya sees `GRANDMA`.

The bridge also publishes retained presence for each virtual friend, and it is
always `OFFLINE` (active, pending and stopped alike). `ONLINE` made the
device's online dot flash permanently for every phone or web-link contact,
which is disruptive. It is published as a retained `OFFLINE` rather than
cleared, because the firmware ignores zero-length payloads: an empty publish
would leave a device that already saw `ONLINE` showing it until it reconnects.
Removing a contact still clears the retained topic.

**Accepted consequence:** sending to a contact reads `SENT! (Offline)` on the
device, and the device can no longer tell an active contact from a pending one
by presence.

## Pool model

Routing is by **(contact's number, pool number they text)**, never by the
contact's number alone.

- One pool number serves any number of contacts, each paired to one device.
- A contact can have **only one device per pool number**. Grandma texting two
  grandchildren needs two pool numbers, one saved thread per child.
- **A (contact, pool number) pair is never given to a different device**, even
  after deletion. Grandma's phone has that number saved as "Maya". The route is
  kept as a tombstone (see Retention), and re-adding Grandma to *Maya* reuses the
  same number and the same friend ID, so her old thread continues.
- A new pairing goes on the least-used active number the contact has never had.
- **When no number is free for a contact**, the add is refused with
  `503 pool-exhausted` and the bridge logs `OPS: no pool number free ...`.
  Buying and registering a number costs money and needs carrier review, so this
  stays a manual step (`tools/smspool.mjs add`). *Decision for the brief's open
  question: manual, not auto-provisioned.*

`node smspool.mjs list` shows contacts per number, so you can see when to add
another. A 10DLC or toll-free number sends about 1 msg/sec. Twilio queues sends
beyond that on its own side. The limit that actually binds is the daily volume
cap on the campaign.

## Consent: the contact opts in themselves

**The bridge never messages anyone first.** A new contact is added `pending`
and is sent nothing. The app tells the parent: *"Now ask Grandma to send START
to (800) 555-0100 from that phone."* When a message arrives from that number
on that pool number:

- **START** (or YES or UNSTOP, Twilio's opt-in keywords) sets the contact to
  `active`. They get the confirmation, which is the first message we ever send
  them:

  > Dot Dash: you're connected to Maya's Dot Dash. Messages from them will come
  > from this number, so save it. Message frequency varies. Msg & data rates
  > may apply. Reply HELP for help, STOP to opt out.

- Anything else gets one reminder per hour: "Dot Dash: to connect with Maya's
  Dot Dash, reply START. Reply STOP to opt out." Nothing reaches the child.

**The invite comes from the parent's own phone.** After adding someone, the
app offers "Send Grandma the invite". This opens the share sheet, or Messages
with the invite written, and the parent picks the recipient:

> Hi Grandma! I added you as a friend on Maya's Dot Dash. To start messaging,
> send START to (866) 786-1245, or tap here:
> https://app.dotdashdevice.com/start.html?n=18667861245

This is one person messaging another, so it is not Twilio traffic and changes
nothing in the verification. `start.html` (source in `sms/web/`, copied by hand
to the docroot) opens the contact's Messages with START typed to that pool
number, and they still press send. Pending contacts have a "Send invite" link
for sending it again.

Why this way:
- Carriers want consent from the recipient themselves (first-party opt-in). A
  parent can't give it on someone else's behalf.
- **A mistyped number never hears from us at all.**

Unanswered pairings are deleted after 14 days. This flow is what the toll-free
verification form describes as opt-in "via text" with the keyword START.

## STOP / START / HELP

Twilio's default opt-out handling for registered numbers auto-replies to these
and blocks further sends at its end. The bridge mirrors the state: STOP sets
`stopped`, START or YES sets `active`. It never sends its own reply to a
keyword, so the contact doesn't get two. A keyword only counts as the entire
message, which is how Twilio matches it ("stop by later" is an ordinary
message). If a send fails with Twilio error 21610 (recipient unsubscribed), the
bridge also marks the pairing `stopped`.

## Unknown senders

A text to a pool number from a number with no live pairing on it **never
reaches a device**. The sender gets one "this number isn't connected"
auto-reply per day, and nothing more. The bridge can't raise a parent-facing
stranger alert, because pool numbers are shared by every family and an unknown
sender can't be tied to one of them.

## Message rules

**Phone -> device** (`lib.toDeviceText`):
- Converted to the characters the device can show and tap back in Morse:
  A-Z, 0-9, space, and `. : ? ' - / ( ) " = + @ ! ; _ $ &`.
- Accented letters are folded to plain ones and curly quotes to straight ones.
- Commas become spaces. The wire format is `TYPE,TEXT,SENDER`, so a comma in
  the text would move part of the message into the sender field and the device
  would file it as a stranger's.
- Emoji are dropped. A text that was only emoji becomes `(EMOJI)`, and a photo
  becomes `(PHOTO)`.
- **One SMS becomes one device message, capped at 160 characters** and cut at a
  word boundary with `...`. *Decision for the brief's open question:* no
  chunking. Each arrival interrupts the screen, and the inbox lists newest
  first, so a split text would be read backwards with each part cutting off the
  one before. 160 is also comfortably inside the firmware's 512-byte MQTT
  buffer.

**Device -> phone**: TEXT and MORSE messages are sent as the decoded words. A
PULSE is sent as `(buzz!)`.

**Rate caps** (in memory, per pairing): out 6/min, 40/h, 150/day. In 5/min,
30/h, 200/day. Invitations per contact number: 5/day, 10/30 days. New contacts
per parent: 10/day.

## Data model (Firestore, server-only)

None of these paths match a rule in `firestore.rules`, so the default deny
keeps every client out. The app reaches them only through the HTTPS API below.

`artifacts/<app>/smsPool/<digits>`

| field | notes |
|---|---|
| number | E.164 |
| twilioSid | the number's `PN…` SID |
| campaignId | 10DLC campaign, or null |
| kind | `tollfree` / `10dlc` |
| active | false = offered to no NEW pairings; existing ones keep working |
| used | live pairings on it (maintained transactionally; `list` recounts) |

`artifacts/<app>/smsPairings/<id>`

| field | notes |
|---|---|
| ownerUid, deviceDocId, deviceHash | the parent, their device record, the child's hash |
| virtualId, virtualHash | the friend ID and its topic hash |
| contactName, displayName | "Grandma", "Maya's Dot Dash" |
| contactKey | HMAC-SHA256 of the number (blind index) |
| contactEnc | AES-256-GCM ciphertext of the number |
| contactHint | `•••• 2671`, for the parent's list |
| poolNumber | the Twilio number this pairing uses |
| status | `pending` / `active` / `stopped` |
| createdAt, activatedAt, stoppedAt | |

`artifacts/<app>/smsRoutes/<contactKey>_<pool digits>`: the uniqueness claim
on (contact, pool number), and the inbound lookup (one document read per text).
It holds `pairingId`, or null once the pairing is deleted.

`artifacts/<app>/public/data/identities/<virtualHash>` is written with
`type: 'sms'`. That reserves the friend ID, so no child can ever be given the
same ID and receive the contact's texts.

## Parent API

All take `Authorization: Bearer <Firebase ID token>`, like `/app-login`.

| call | body / result |
|---|---|
| `POST /sms/contacts` | `{deviceId, phone, contactName, displayName?}` -> `201 {contact, keyword: 'START'}`. Nothing is sent. |
| `GET /sms/contacts` | `{contacts: [...]}`: every contact on every device of this parent |
| `DELETE /sms/contacts/<id>` | `{status: 'deleted', virtualId}` |

`contact` is `{id, deviceId, virtualId, contactName, displayName, hint,
poolNumber, status}`. The number itself is never returned.

Refusals: `invalid-number`, `invalid-name`, `no-device`, `not-owner` (the child
ID's identity record is not this parent's), `friends-full` (10 is the firmware's
limit), `already-added`, `pool-exhausted` (503), `slow-down` (429).

**The app's side** (still to build): after a `201`, put `virtualId` into the
device's friend list and publish `CMD,SYNC_FRIENDS` exactly as it does for an
approved friend. After a delete, take it out the same way. Show `status` so the
parent can see "waiting for them to send START".

## Retention and privacy (COPPA review)

This is a child-directed product, so it is almost certainly in COPPA scope.
**Have counsel review these points.**

- **Phone numbers** are stored only as ciphertext (AES-256-GCM) plus an HMAC
  blind index. The master key `SMS_DATA_KEY` exists only in
  `/root/dotdash_sms/sms.env` on the droplet. A Firestore export or a leaked
  service account alone reveals no number. Someone holding **both** the database
  and that key could confirm a guessed number through the HMAC.
- **Message bodies are never stored by the bridge**, and never logged. Logs
  record pairing-id prefixes, lengths, and at most the **last two digits** of a
  number. The only copies of message text are the ones that already exist for
  any Dot Dash message: retained on the broker until the device clears it, in
  the device's inbox, and in the parent's Monitor.
- **Deleting a contact is a hard delete** of the pairing: the encrypted number,
  both names and the status. **What remains is the route tombstone**: the HMAC,
  the pool number, the child's hash and the friend ID. That record is what
  stops the (contact, number) pair ever reaching a different child. Counsel
  should confirm that keeping a keyed hash of a removed number for this purpose
  is acceptable, and whether it needs an expiry. The identity record for the
  friend ID is also kept, holding the ID and the owner uid, so that the ID
  can't be reused.
- **Automatic deletion**: pairings whose contact never sends START within 14 days are deleted.
  Pairings whose device is no longer paired to that parent are deleted by a
  sweep every 6 hours.
- **Access**: Firestore paths are server-only, and the API only returns a parent
  their own contacts, with a masked number.
- **Who consents**: the parent approves the contact, and the contact consents
  to receiving texts by replying YES. The child initiates nothing.
- **Twilio** holds message logs, including bodies, on its side. Set a message
  retention or redaction policy in the Twilio console, and list Twilio as a
  processor in the privacy policy.

## Known gaps

- **Sender forgery via the shared device password.** The bridge only texts a
  contact when the message's sender field hashes to the paired child. But
  anyone holding the shared device password (readable from the public firmware)
  can publish a forged sender, and so could text a paired contact as that
  child. The per-device keys don't close this either (`dynsec-device-role.sh`:
  a keyed device can still put any name in the payload). The rate caps bound
  it. Closing it needs the sender in the topic, the change already noted for
  device messaging in general.
- **Broker ACL is broader than needed.** `dotdash-sms` needs read/write on
  `doorbell/msg/+/#` to reach any child. That is the same exposure the push
  bridge already has. The code only subscribes to virtual-friend topics.
- **Rate limits are in memory**, so a restart resets them. That is fine for a
  cost cap, but they are not a quota.
- **Memory.** This is another Node process of roughly 60-70 MB on a droplet with
  about 200 MB free (2026-09-23). Its `OOMScoreAdjust` puts it ahead of the
  broker and the push bridge in the OOM killer's order.

## Web link contacts (no SMS, no carrier approval)

Added 2026-10-02, after Twilio rejected the toll-free verification as "personal
use" (30532). This is a second delivery channel on the same bridge: same
pairings, same virtual contact IDs, same device side.

- **Adding someone:** `POST /sms/contacts {deviceId, contactName, channel: 'web'}`
  returns `{contact, link}`. No phone number. The link is
  `https://dotdashdevice.com/c/<token>`. Only `sha256(token)` is stored, so the
  link is shown once; "Send a new link" (`POST /sms/contacts/<id>/link`) replaces
  it, and the old one dies.
- **One device per link:** the first device to tap Connect claims it
  (`/chat/api/claim`, done in a transaction) and gets a claim secret. Every
  later call sends `Authorization: Chat <token>.<claim>`. Any other device sees
  "already connected on another device".
- **The page** is `site/c/` (index.html, sw.js, manifest), served for every
  `/c/` path with access logging off, so tokens never reach a log. After
  claiming, the address becomes `/c/<token>.<claim>`. That is deliberate: an
  iPhone Home Screen web app has its own storage, separate from Safari's, so
  the saved address is what carries the claim across.
- **API** (`/chat/api/`, `chatApi` in service.mjs): `config`, `open`, `claim`,
  `history`, `wait` (a long poll of about 25s), `send`, `push` (POST/DELETE),
  `release`, `leave`.
- **iPhone gotcha (found in Sam's first test, 2026-10-03):** carrying the claim
  in the address did NOT carry it into the Home Screen app. iOS saved the
  address from page load, before the claim was added. So:
  - iPhone Safari's landing asks for Add to Home Screen *before* Connect.
  - "Move this chat to my Home Screen" (`release`) frees the link from Safari.
  - A page holding a stale claim falls back to Connect if the link is free.
  Don't rely on the claimed address again.
- **Push:** standard web push through the `web-push` package, with the VAPID
  keys in sms.env. On iPhone it only works from a Home Screen web app (iOS
  16.4+), so the page asks iPhone users to add it there. Dead subscriptions
  (404/410) are dropped.
- **History:** `smsPairings/<id>/chat/*`, at most 50 messages and none older
  than 30 days. Pruned on every write and by the sweep. This is the one place
  message content is stored; the privacy policy says so in section 5A.
- **Leave:** the contact disconnects themselves. The link, the claim, the push
  subscription and the history are erased, and the pairing shows "Left the
  chat". The sweep deletes it 30 days later unless a new link is sent. A link
  never opened is deleted after 14 days.
- **Several chats, one page (2026-10-03):** the page keeps every chat it has
  connected in localStorage (`dotdash_chats`) and shows an inbox when there is
  more than one, with the latest message and an unread dot per chat. Every
  connected chat long-polls in the background. **Add a chat** takes a pasted
  link. That is the only way a second link reaches an iPhone Home Screen app,
  because links always open in Safari, so Safari's landing offers **Copy link**.
  Notifications carry `chat` (the pairing id). The service worker opens
  `/c/#chat=<id>`, or tells an open page which chat to show. One browser push
  subscription is registered with every chat on the device.
- **iOS contact mode (build 15, 2026-10-03):** `app/src/ContactApp.jsx` is the
  native twin of the chat page, chosen by `Root` in main.jsx. Contact mode
  opens when:
  - the app is opened by a `/c/` Universal Link, or
  - a notification with data `kind: 'contact'` is tapped, or
  - someone with saved chats isn't signed in, or
  - they tap "Got a link to message a Dot Dash?" on the landing screen.

  The pieces:
  - **Universal Links:** `site/.well-known/apple-app-site-association` (appID
    4K33CJ9FWS.com.dotdashdevice.parent, path `/c/*`), plus the
    `applinks:dotdashdevice.com` entitlement and `@capacitor/app`. SceneDelegate
    already forwards links to Capacitor.
  - **Push:** the app sends `POST /chat/api/push {fcmToken}`, and the bridge
    sends through firebase-admin messaging with data `{kind: 'contact', chat}`.
  - **CORS:** the chat API allows `capacitor://localhost`.
  - **Preview:** `VITE_CONTACT_PREVIEW=1` builds (local only, never shipped) let
    a desktop browser enter contact mode with `?contact&link=<token>`. Serve
    them on localhost:5173, since that is already in APP_ORIGINS.
- **App:** "Add someone by link" in Contacts, behind `VITE_LINK_CONTACTS`.
  `build:phones` (test.html) has both kinds of contact; `build:links` has links
  only, for the pilot; plain `build` has neither.

## Twilio setup (outside this code)

1. Twilio account. Dot Dash is not yet a legal entity, so register as a **sole
   proprietor**. Toll-free verification exempts sole proprietors from the
   business registration number requirement.
2. **Use toll-free for the pool.** 10DLC as a sole proprietor allows ONE number
   per campaign, which breaks the pool. The opt-in type is "via text", keyword
   START. The proof-of-consent image is at
   `https://app.dotdashdevice.com/sms-opt-in.png`.
3. Later, once there is an EIN (free for a sole proprietor) or an LLC: a
   standard 10DLC brand and campaign, if more numbers are needed.
4. Create an **API key** (Console -> API keys) for `TWILIO_API_KEY` and
   `TWILIO_API_SECRET`. The auth token is still needed to verify webhook
   signatures.
5. `smspool.mjs add` sets each number's inbound webhook to
   `https://app.dotdashdevice.com/sms/inbound` (POST).

## Deploying (done 2026-09-25 in DRY_RUN; kept as the runbook)

1. `scp` `sms.mjs`, the `sms/` folder (minus the tests) and `tools/smspool.mjs`,
   `tools/smsfake.mjs` into `/root/dotdash_bridge/`. It shares the bridge's
   `node_modules` (mqtt, firebase-admin); no new dependencies.
2. `/root/dotdash_sms/sms.env` (dir 0700, file 0600):

       SMS_DATA_KEY=<openssl rand -base64 32>   # back this up offline: lose it and every number is unreadable
       TWILIO_ACCOUNT_SID=AC...
       TWILIO_AUTH_TOKEN=...
       TWILIO_API_KEY=SK...
       TWILIO_API_SECRET=...
       MQTT_PASS=<new password for dotdash-sms>
       # DRY_RUN=1   # log texts instead of sending, for the first run

3. Broker login. Follow `ops/README.md`: back up, run authtest before and
   after. Then `mosquitto_passwd /etc/mosquitto/passwd dotdash-sms`, and add to
   `/etc/mosquitto/aclfile`:

       user dotdash-sms
       topic readwrite doorbell/msg/+/#
       topic write     doorbell/presence/+

4. nginx: the `smscontacts` zone from `ops/nginx-dotdash-enroll-zone.conf`, the
   two `/sms/` locations from `ops/nginx-dotdash.conf`. Then `nginx -t && systemctl reload nginx`.
5. `cp dotdash-sms.service /etc/systemd/system/ && systemctl enable --now dotdash-sms`,
   then `journalctl -u dotdash-sms -f`.
6. `node smspool.mjs add +1XXXXXXXXXX --kind tollfree`.
7. Test with `DRY_RUN=1` first. Add a contact through the API, then run
   `smsfake.mjs --from <that number> --to <pool> --body YES` and a message, and
   watch the text arrive on a test device.

## Tests

    cd bridge && npm test

`lib.test.mjs` covers the pure helpers. The Twilio signature is checked against
Twilio's published example. `service.test.mjs` drives the whole service
(HTTP, webhook, MQTT, Firestore transactions) against in-memory fakes. It
covers the full lifecycle, the pool rules, refusals, opt-out, bad numbers and
the sweep. Both pass on Node 24 locally and on the droplet's Node 18.

## Still to do

- Parent app UI: an "Add a phone contact" option in Approved Friends, calling the
  API and syncing the virtual ID into the friend list, with a status badge.
- Deploy (above), then a hardware test on INSTA0515 / SC621111.
- Optional: send the parent a push notification when a contact accepts or opts
  out. The pairing's `status` field is already there for the app to watch.
