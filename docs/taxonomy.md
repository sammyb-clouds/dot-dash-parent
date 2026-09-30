# Taxonomy: parent/child is out of the product language

Dot Dash used to describe itself as a parent/child product. It no longer does.
The device is for anyone, the Morse theme carries the naming, and "parent" and
"child" have been taken out of everything a person reads.

**This is a copy change only.** Nothing on the wire, in the database, or in the
code's own names moved. Read the hard rule below before renaming anything.

## The words

| Don't say | Say | Notes |
|---|---|---|
| child, kid | **Dot Dash** | the device and its user, e.g. "your Dot Dash", "Active Dot Dash" |
| parent | **base**, or just "you" | the account holder |
| child's ID / call sign | **Dot Dash call sign** | |
| parent's ID / call sign | **base call sign** | |
| friend, approved friend | **contact** | the section is "Contacts" |
| Monitor (the message feed) | **Log** | |
| text (as a verb or noun) | **message** | see [Say "message", not "text"](#related-copy-rules) |

On the device itself, "base" is the word for the account holder — the shipped
default quick message is `CALL MY BASE`.

### Always say *which* call sign

There are two, and an unqualified "call sign" is ambiguous in exactly the places
it matters most — confirmations and destructive warnings. Never write "this will
delete the call sign"; write "this will delete the **base call sign**".

## Hard rule: do not rename identifiers or anything on the wire

Every one of these still says parent/child, deliberately. Renaming any of them
breaks live devices, live accounts, or both.

- **Code identifiers**: `parentProfile`, `childHash`, `childMac`, `childId`,
  `childLabel`, `parentId`, `childOnlineStatus`, and the rest. They are internal
  names; nobody reads them. Leave them.
- **The Firestore identity `type` field**, written as `'child'` or `'parent'`
  (`app/src/main.jsx`). `firestore.rules:41` validates
  `d.type in ['child', 'parent']` against **every identity record that already
  exists**. Changing the string rejects writes for the whole fleet.
- **Firestore paths**, including `users/{uid}/profile/parent`.
- **MQTT topics**: `doorbell/msg/…`, `doorbell/cmd/…`, `doorbell/monitor/…`,
  `doorbell/presence/…`, and the broker ACLs and mosquitto config that name them.
  Topics are keyed on `sha256(lowercased trimmed id)` — IDs must never change
  shape either.
- **Firmware payload tags**: `TEXT`, `MORSE`, `FRIENDREQ`, `TIMERREQ`, `CMD,SYNC_FRIENDS`.
  `FRIENDREQ` in particular is still called that on the wire while the UI says
  "contact request". That is fine and intended.

Rule of thumb: **if a person can read it, change it. If a machine parses it,
don't.**

## Deliberately still parent/child

Not oversights. Don't "fix" these.

- **`privacy.html` (live) and `legal/terms.html`.** "Child" there is a legal
  category, not a product noun: the COPPA section, the under-13 disclosures, and
  the parental-rights language. Genericising them removes the disclosure rather
  than rewording it, and COPPA applicability turns on what the product is and who
  uses it, not on the vocabulary. Any change here needs a lawyer, not an edit.
- **`docs/app-store-review.md`.** The parent/child framing *is* the argument for
  the age rating and for staying out of the Kids Category.
- **Code comments and READMEs.** Harmless, and rewriting them churns diffs for
  nothing. Fine to leave as you find them.
- **Serial/debug log lines**, e.g. the firmware's
  `[key] reset by parent: reconnecting to enroll a new key`. Never on the OLED.

## Related copy rules

- **Say "message", never "text"** — in app UI, and in the SMS templates the
  bridge sends. Comments and logs may still say SMS or text.
- **"Phone contact"** is the term for an SMS participant, not "SMS user".
- Push notification copy counts as UI. It lived out of step for months because
  nobody re-reads it (`bridge/bridge.js`, `parseEvent`).

## Checking your work

A grep of the source is not enough — two visible strings survived the first pass
because they sat past where a `head`-truncated grep stopped, and the app's own
`{children}` React props create noise that hides real hits. What actually caught
them was reading the **deployed** page:

```bash
curl -s https://app.dotdashdevice.com/test.html \
  | grep -oiE "your child[a-z' ]{0,25}|child's [a-z]+|child ID|parent ID|Parent Portal"
```

Both builds should return nothing for: `your child`, `this child`, `parent ID`,
`Parent Portal`, `child's`. Note there are two builds — `npm run build` (iOS and
production, phone contacts off) and `npm run build:phones` (test.html, on) — and
copy can differ between them, so check both.

## History

| Commit | What |
|---|---|
| `1536803` | Retire parent/child wording for the Morse taxonomy (the main pass) |
| `60a1c14` | The copy the first pass missed: app title, PWA manifest, push notifications, SMS opt-in preview |
| `be16c53` | Two visible strings found by reading the deployed page |
