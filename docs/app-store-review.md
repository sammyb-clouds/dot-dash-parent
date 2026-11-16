# App Store / TestFlight review prep

Companion to `demo/README.md`, which holds the demo account and the review
notes copy.

## 1. Privacy nutrition labels

App Store Connect -> App Privacy. Every answer below is "used for **App
Functionality**", "**linked** to the user", and "**not** used for tracking".

Declare **Data Used to Track You: none** and **Third-Party Advertising: none** —
both are true, and both are checked.

| Apple category | Apple type | What it is here |
|---|---|---|
| Contact Info | Email Address | The parent's sign-in email |
| Contact Info | Name | The display names a parent picks for themselves and each child. Nicknames, not legal names — but Apple's "Name" covers them, so declare it |
| Identifiers | User ID | The account id, and the `NAME+PIN` virtual ids messages are addressed to |
| Identifiers | Device ID | The paired hardware's identifier, and the push notification token |
| User Content | Other User Content | Message text, and the approved phrase lists |
| User Content | Audio Data | Voice notes: up to 10 seconds of recorded audio, kept on the server for 7 days so the recipient can play it. Declare it from the first build that carries the microphone permission. Live walkie calls are relayed and never stored, so they are not "collected" in Apple's sense |
| Other Data | Other Data Types | Wi-Fi **network names** saved for a device. Passwords are no longer stored — see below |

Nothing under Usage Data, Diagnostics, Location, Contacts, Health, Financial,
Browsing or Search History — the app collects none of it. No device has a
camera or GPS; only the walkie model has a microphone.

**Under-declaring is the common rejection**, and on a children's product it is
the bad kind. The Wi-Fi row in particular is easy to forget.

### Wi-Fi passwords — resolved

Passwords are no longer stored in the account. They go straight to the device
and live only there; the app sends a KEEP marker for every row it has no
password for, and the firmware substitutes what it already holds — the same
mechanism that has always protected a network joined through the captive portal.

One password does persist briefly: from the moment a parent types it until the
device reports back that it holds that network. Dropping it sooner would strand
an offline device with a blank password. So the label stays at network names,
and a password is transient rather than stored.

Consequence for the UI: a saved password can no longer be revealed in the app,
because the app does not have it. To change one, remove the network and add it
back.

## 2. Age rating and the Kids Category

Answer the questionnaire honestly for **4+** — no violence, no mature themes, no
gambling, no unrestricted web access.

It will ask about messaging and user-generated content. That is a real question
for this app, and guideline 1.2 wants four things from any app carrying UGC:
filtering, reporting, blocking, and a published contact. Dot Dash's answer is
strong, and should be stated in the review notes rather than left to be
discovered:

- a child can only exchange messages with contacts a **parent has approved**
- new contact requests go to the parent and are not acted on until approved
- a parent removes a contact at any time, which is the block
- phrases a device can send are a list the parent controls
- `support@dotdashdevice.com` is published in the privacy policy

**Recommendation: stay OUT of the Kids Category.** This app is the parent's
tool, not the child's — the child uses the hardware. The category adds strict
review requirements for no benefit here.

## 3. Screenshots

Required: **6.7"** (1290x2796) and **6.5"** (1242x2688). Take them on the demo
account so the frames are populated and no real family data is in them — the
virtual device keeps the child online and the history in place.

Worth capturing: Chat mid-conversation, Monitor with activity, Settings showing
approved contacts, and the phrase list.

## 4. Listing metadata

Needed before submission: subtitle, description, keywords, support URL,
marketing URL, primary category. The privacy policy URL is live at
https://app.dotdashdevice.com/privacy.html.

## 5. Before uploading the build

- the push token fixes must be IN the build. Without them a reviewer's fresh
  install inherits a stale FCM token and notifications silently do nothing.
  See [[push-notifications]] in the notes, or `git log` around `d3db2a6`
- `ios-port` still needs merging to `main`
- keep `dotdash-demo.service` running through review and after — reviewers come
  back to a build weeks later

## 6. Microphone (voice notes and walkie calls)

Added 2026-11-16. The first build with `NSMicrophoneUsageDescription` needs all
of these, in this order:

1. **App Privacy**: add *User Content -> Audio Data* (row in section 1).
2. **Privacy policy**: the voice-note row in section 3 and the 7-day line in
   section 7 of `legal/privacy.html` must be LIVE at the policy URL before the
   build is submitted.
3. **Demo account**: restart `dotdash-demo` with `DEMO_WALKIE=1` in `demo.env`,
   so the reviewer sees the Voice note | Walkie buttons and can trigger the
   microphone prompt. Do this only once the build in review has the permission.
4. **Review notes**: paste the microphone paragraph from `demo/README.md`.
5. A short screen recording of a voice note and a call with a real walkie,
   attached to the review notes, because the demo device does not answer calls.

The prompt appears only when someone holds the record button or starts a call,
and those buttons exist only in a chat with a walkie. An account with no walkie
is never asked.
