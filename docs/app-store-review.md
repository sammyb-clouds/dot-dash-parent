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
| Other Data | Other Data Types | Wi-Fi network names and passwords saved for a device |

Nothing under Usage Data, Diagnostics, Location, Contacts, Health, Financial,
Browsing or Search History — the app collects none of it, and the device has no
microphone, camera or GPS.

**Under-declaring is the common rejection**, and on a children's product it is
the bad kind. The Wi-Fi row in particular is easy to forget.

### Decide first: Wi-Fi passwords at rest

`saveWifiNets` in `main.jsx` stores network names and passwords in Firestore in
plaintext (obscured in transit to the device, not at rest). This is the most
sensitive field in the database and the only one with no protection.

Options: encrypt at rest under a key the device already shares, stop persisting
the password and pass it straight through to the device, or accept it and
declare it. **Any of the three is defensible — but decide before submitting**,
because the answer changes the label above and undoing a declaration later is
worse than making it now.

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
