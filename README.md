# dot-dash-parent
## iOS app (Capacitor)

The iOS app and the web app are the same code. `dotdashindex.html` is the single
source: it is deployed to the web server as-is, and Capacitor wraps a copy of it.

    npm install          # once
    npm run ios:sync     # stage www/ and copy it into the iOS project
    npm run ios:open     # open in Xcode

`www/` is generated and git-ignored. Capacitor requires its entry point to be
named `index.html`, and this repo's root `index.html` is the deployed production
web app — hence the copy rather than a rename.

Bundle identifier: `com.dotdashdevice.parent`. It is set in
`capacitor.config.json` and is read only when `npx cap add ios` first scaffolds
the Xcode project — changing it later means editing `PRODUCT_BUNDLE_IDENTIFIER`
in the Xcode project by hand.

Notifications are runtime-branched in `notify()`: Web Notifications in a browser,
Capacitor local notifications in the app (foreground), and APNs via the push
bridge when the app is backgrounded.
