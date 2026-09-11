# dot-dash-parent
## Building

The app is built with Vite. `app/src/main.jsx` is the source; the old
single-file `dotdashindex.html` is gone — it is now this build's output.

    npm install
    npm run dev            # local dev server, hot reload
    npm run build          # -> dist/index.html, one self-contained file
    npm run deploy:test    # build, then scp dist/index.html to test.html

The build emits ONE inlined HTML file on purpose. It serves both targets: the
web deploy is still a single `scp`, and Capacitor's `webDir` points at `dist/`
where its entry point must be named `index.html`.

It also removes the five CDNs the old build needed before it could render
anything, and the in-browser Babel transpile that ran on every launch.

Tailwind is v3, not v4, deliberately: v4 renamed parts of the shadow scale and
changed the default border colour, which would mean small regressions across a
settled UI for no gain here.

## iOS app (Capacitor)

The iOS app and the web app are the same code and the same build.

    npm run ios:sync     # build, then copy into the iOS project
    npm run ios:open     # open in Xcode

Bundle identifier: `com.dotdashdevice.parent`. It is set in
`capacitor.config.json` and is read only when `npx cap add ios` first scaffolds
the Xcode project — changing it later means editing `PRODUCT_BUNDLE_IDENTIFIER`
in the Xcode project by hand.

Notifications are runtime-branched in `notify()`: Web Notifications in a
browser, Capacitor local notifications in the app (foreground), and APNs via the
push bridge when the app is backgrounded.

Firebase Auth is branched too. Its default storage never settles under
`capacitor://localhost` — `onAuthStateChanged` simply never fires — so native
uses `initializeAuth` with indexedDB persistence. The browser keeps `getAuth()`,
whose default is localStorage, so existing web sessions are not relocated.
