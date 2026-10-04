# dot-dash-parent — the parent app, iOS project and push bridge

**`README.md` is the authority** on the build, the iOS project, the `notify()`
branching and the Firebase Auth branching. Read it before changing those.
`bridge/README.md` is the authority on the push bridge.

## Branch

Live work is on **`ios-port`**. `main` is the pre-Vite single-file era —
anything read from it is stale, including `dotdashindex.html`, which exists only
there and must never be edited or deployed again. **Check the branch first.**

## Source and build

- Source: `app/src/main.jsx` (one React file), plus `app/index.html`,
  `app/src/index.css`.
- Output: `dist/index.html` — one self-contained ~935KB file, everything inlined.
  Gitignored; regenerate, never edit.
- `index.html` at the repo root is a **dead mirror** from July. It is not what is
  live. Ask the server.

```
npm run build          # -> dist/index.html
npm run build:links    # the shipping config (VITE_LINK_CONTACTS=1, no phone)
npm run deploy:test    # build + scp to test.html   (staging)
npm run deploy:prod    # build + scp to index.html  (production)
npm run ios:sync       # build + copy into the iOS project
```

## Rules

- **Deploying is always an explicit request.** Never run `deploy:test` or
  `deploy:prod` on your own initiative.
- **Do not archive or bump `CURRENT_PROJECT_VERSION` after a change.** Verify
  with `npm run build:links` and stop. Last archived build is **18**; when Sam
  asks, bump from there and archive into
  `~/Library/Developer/Xcode/Archives/<date>/`.
- **Every MQTT topic key is `sha256(id.toLowerCase().trim())`.** Three places
  implement it independently — `hashId()` here, the firmware, and
  `refreshParentHashes()` in `bridge/bridge.js` — and all three lowercase. Ids
  are stored UPPERCASE, so hashing the stored form yields a topic nobody
  subscribes to. A message vanishing in one direction only is this bug.
- In anything a parent or contact reads, say **"message"**, never "text" —
  including the SMS templates the bridge sends.
- Three things hardcode the deploy path and move together: the manifest
  `start_url`, the service worker's fallback target, and the bridge's
  `LINK_PATH`. All are `/`.

## iOS

The Capacitor project is inside this repo at `ios/` (SPM, not CocoaPods) —
there is no separate iOS repo. `GoogleService-Info.plist` and all signing
material are gitignored and not present locally, so a clean checkout cannot
produce a signed build without Sam supplying them.
