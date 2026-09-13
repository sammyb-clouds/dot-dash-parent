# Review demo account

Apple's reviewers have no Dot Dash hardware. Without this, the app opens onto a
sign-in wall and, behind it, a pairing flow for a device they do not have —
which is the standard rejection for a hardware companion app.

Two pieces:

- **`provision-demo.mjs`** writes everything the pairing flow would have written:
  an Auth user, `profile/parent`, one device, the two public identity records,
  and a little chat history. Idempotent; it resets the password each run.
- **`demo-device.mjs`** is a virtual device. It holds presence open so the child
  shows as online, replies when the reviewer sends a message, and taps out
  something unprompted every ten minutes. It speaks the same MQTT the firmware
  does, on the same shared device credential, so the broker needs no changes.

## Deployed

    /root/dotdash_demo/{demo-device.mjs, demo.env, node_modules}
    /etc/systemd/system/dotdash-demo.service

    systemctl status dotdash-demo
    journalctl -u dotdash-demo -f

`demo.env` holds the device MQTT password (0600). Keep this service running
through any review round, and leave it running afterwards — a reviewer can come
back to a build weeks later.

## Re-provisioning

`provision-demo.mjs` needs `firebase-admin`, which lives in the bridge's
`node_modules`, so run it from there:

    scp demo/provision-demo.mjs root@45.55.47.32:/root/dotdash_bridge/
    ssh root@45.55.47.32 'cd /root/dotdash_bridge && node provision-demo.mjs'
    ssh root@45.55.47.32 'rm /root/dotdash_bridge/provision-demo.mjs'

It prints a fresh password. Put it in App Store Connect before anything else —
the old one stops working the moment this runs.

Note it creates the Auth user over the Identity Toolkit REST API rather than
`firebase-admin/auth`: that module pulls in `jwks-rsa` -> `jose`, which is ESM
and cannot be `require()`d on the droplet's Node 18.

## The demo identity

    parent    DEMO0101
    child     ROBIN0614
    device    A0:B1:C2:D3:E4:F5
    email     appreview@dotdashdevice.com

Deliberately not a real family. This identity is public in the `identities`
collection and anyone can send a friend request to it.

## App Store Connect copy

**Beta App Description**

> Dot Dash is a companion app for the Dot Dash messenger, a small screen-free
> device that lets children send and receive messages in Morse code. Parents use
> this app to set a device up, choose who it can talk to, approve the phrases it
> can send, and exchange messages with their child.

**App Review / Beta App Review notes**

> Dot Dash is a companion to a physical Morse-code messenger for children, so
> full functionality normally requires the hardware.
>
> The demo account below is already paired to a device so the app can be
> reviewed end to end. The paired child is a demo device we run, not a physical
> one, and it is online continuously — it will reply if you send it a message
> from the Chat tab.
>
> To see the main features: Chat sends a message to the child and shows their
> replies. Monitor shows the child's recent activity and any requests needing a
> parent's approval. Settings covers the child's approved contacts, their
> allowed phrases, the device's Wi-Fi networks, notifications, and account
> deletion.
>
> Notifications are off until enabled in Settings.

**Sign-in required:** yes. Credentials from `provision-demo.mjs`.

**Privacy policy:** https://app.dotdashdevice.com/privacy.html
(source at `app/public/privacy.html`)
