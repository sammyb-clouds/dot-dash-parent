    import React, { useState, useEffect, useRef } from 'react';
    import mqtt from 'mqtt';
    import { sha256 } from 'js-sha256';
    import './index.css';
    import { createRoot } from 'react-dom/client';
    import { initializeApp } from 'firebase/app';
    import { getAuth, initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut, sendPasswordResetEmail, signInAnonymously, signInWithCustomToken, deleteUser, reauthenticateWithCredential, EmailAuthProvider } from 'firebase/auth';
    import { getFirestore, collection, doc, setDoc, getDoc, getDocs, onSnapshot, deleteDoc, updateDoc, query, orderBy, limit, writeBatch } from 'firebase/firestore';
    import { getMessaging, getToken, deleteToken, isSupported as messagingSupported } from 'firebase/messaging';

    // =========================================================================
    // ✅ YOUR FIREBASE CONFIGURATION ✅
    // =========================================================================
    let firebaseConfig = {
      apiKey: "AIzaSyBbVZw3R8YbWgAPaj3LCqM4qajdTRdN3LU",
      authDomain: "dotdash-6833f.firebaseapp.com",
      projectId: "dotdash-6833f",
      storageBucket: "dotdash-6833f.firebasestorage.app",
      messagingSenderId: "1059232518724",
      appId: "1:1059232518724:web:64129bc5d02521d64c2211"
    };
    
    const isCanvas = typeof __firebase_config !== 'undefined';
    if (isCanvas) { firebaseConfig = JSON.parse(__firebase_config); }
    // =========================================================================

    // True inside the Capacitor iOS app, false in any browser. Declared here
    // rather than beside notify() below because auth creation depends on it.
    const isNativeApp = () => {
      const cap = window.Capacitor;
      return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
    };

    const app = initializeApp(firebaseConfig);

    // Firebase Auth's default storage NEVER SETTLES under capacitor://localhost:
    // onAuthStateChanged simply never fires, and no error callback runs either,
    // so the app sits on its loading spinner forever with nothing in the console
    // to explain it. Verified on the simulator -- getAuth() never fired, and
    // indexedDB persistence fired immediately.
    //
    // The browser deliberately keeps getAuth(). Its default is localStorage, and
    // moving the web app to indexedDB would relocate where sessions live and
    // sign every existing user out once, to fix a problem browsers do not have.
    const auth = isNativeApp()
      ? initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] })
      : getAuth(app);

    const db = getFirestore(app);
    const appId = typeof __app_id !== 'undefined' ? __app_id : 'dotdash';

    // ---------- NOTIFICATIONS ----------
    // One entry point, because the same three events have to reach a parent
    // through whichever shell they happen to be running in.
    //
    //   iOS app (Capacitor) -> a NATIVE local notification, and only while the
    //       app is in the foreground. Backgrounded alerts are the push bridge's
    //       job: iOS suspends this app, so its MQTT connection is gone and it
    //       cannot know anything happened. The bridge stays subscribed around
    //       the clock and goes out through APNs instead.
    //       These cannot double up -- iOS suppresses remote banners while an app
    //       is active, which is exactly the window this branch covers.
    //
    //   Web with the Notification API -> what the app has always done.
    //
    //   Anything else -> nothing, silently. WKWebView has no window.Notification
    //       at all, and neither does iOS Safari in a plain tab, so this has to
    //       fail quietly rather than throw inside the MQTT handler.
    const notify = (title, body) => {
      try {
        if (isNativeApp()) {
          const ln = window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
          // id must fit a 32-bit int; the clock is unique enough for a banner.
          if (ln) ln.schedule({ notifications: [{ title, body, id: Date.now() % 2147483647 }] });
          return;
        }
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(title, { body });
        }
      } catch (e) {}
    };

    // ---------- WEB PUSH REGISTRATION ----------
    // Public VAPID key. Safe in client code by design -- it is the public half
    // of the pair, and the private half never leaves Firebase.
    // Strip the 4-digit PIN off a NAME+PIN id for display, so a parent sees the
    // same name their child sees on the device -- the firmware does the same
    // thing to a sender before showing it.
    //
    // DISPLAY ONLY. Matching, filtering and every topic hash keep the full id;
    // two children can share a first name and only the PIN tells them apart.
    // Settings still shows the full id for when a parent needs to look one up.
    const displayName = (id) => {
      if (typeof id !== 'string') return id;
      const short = id.replace(/\d{4}$/, '');
      return short || id;
    };

    // ---------- WI-FI LIST SYNC ----------
    // Must mirror wifiKeystreamXor() in Network.ino byte for byte; a mismatch
    // would write garbage credentials to a device rather than fail loudly.
    //
    // OBFUSCATION, not encryption, and the difference is worth stating: every
    // device shares one MQTT credential with readwrite on doorbell/cmd/+, so a
    // leaked credential can read any device's command topic. Keying on that
    // device's own name+PIN means a reader needs that too. It does NOT survive
    // brute-forcing name+PIN from the topic hash -- per-device broker
    // credentials are the real fix.
    const WIFI_US = String.fromCharCode(0x1f);   // field separator; '|' is legal in a password

    const wifiObfuscate = (plain, myID) => {
      const bytes = new TextEncoder().encode(plain);
      let out = '', block = -1, key = null;
      for (let i = 0; i < bytes.length; i++) {
        const b = Math.floor(i / 32);
        if (b !== block) { key = sha256.array(`${myID}|wifi|${b}`); block = b; }
        out += (bytes[i] ^ key[i % 32]).toString(16).padStart(2, '0');
      }
      return out;
    };

    // How many recent messages the app pulls from Firestore. Local history in
    // localStorage is not capped by this -- older messages a device has already
    // seen stay visible; this only bounds what is re-read from the server.
    const MESSAGE_PAGE = 100;

    const PUSH_ID_KEY = 'dotdash_push_token_id';
    const VAPID_PUBLIC_KEY =
      'BFuCduXya7RRSfwlQoZWbKoOcJhkWtzr6mz9OsHJNGWUNA7j4LJB21kpVP__Vo8BayRxwh7MKy_IeGLorIvK2jU';

    // Turns on background notifications and hands the resulting token to the
    // push bridge by writing it where the bridge looks.
    //
    // MUST be called from a tap. iOS only grants notification permission from
    // inside a user-gesture handler -- asking on page load fails silently, with
    // no prompt and no error, which is exactly how this looks broken.
    //
    // On iOS it also requires the app to have been added to the Home Screen.
    // Safari in a plain tab has no Push API at all, so this reports that rather
    // than leaving someone tapping a button that cannot work.
    async function enableWebPush(uid) {
      if (!uid) return { ok: false, reason: 'Sign in first.' };

      const standalone = window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;
      const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

      // NATIVE. Uses the Firebase messaging plugin rather than Capacitor's own
      // push plugin, because that one yields a raw APNs device token and FCM's
      // send API takes an FCM registration token -- the bridge would have had to
      // speak APNs directly, certificates and all. This way the token drops into
      // the same pushTokens collection the bridge already reads, and the bridge
      // needs no changes whatsoever.
      //
      // Imported dynamically so the browser build never pulls the native path in.
      if (isNativeApp()) {
        try {
          const { FirebaseMessaging } = await import('@capacitor-firebase/messaging');
          const perm = await FirebaseMessaging.requestPermissions();
          if (perm.receive !== 'granted') {
            return { ok: false, reason: 'Notifications are blocked. You can turn them back on in iOS Settings.' };
          }
          const { token } = await FirebaseMessaging.getToken();
          if (!token) return { ok: false, reason: 'Could not get a notification token.' };

          const id = sha256(token).slice(0, 32);
          const ua = navigator.userAgent.slice(0, 200);
          await setDoc(doc(db, 'artifacts', appId, 'users', uid, 'pushTokens', id), {
            token, platform: 'ios-app', userAgent: ua, updatedAt: Date.now(),
          });
          try {
            const existing = await getDocs(collection(db, 'artifacts', appId, 'users', uid, 'pushTokens'));
            await Promise.all(existing.docs
              .filter((d) => d.id !== id && d.data().userAgent === ua)
              .map((d) => deleteDoc(d.ref)));
          } catch (e) {}
          try { localStorage.setItem(PUSH_ID_KEY, id); } catch (e) {}
          return { ok: true, reason: 'Notifications are on for this device.' };
        } catch (e) {
          return { ok: false, reason: `Could not turn on notifications: ${e.message}` };
        }
      }

      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        return {
          ok: false,
          reason: iOS && !standalone
            ? 'On iPhone, notifications only work once this page is added to your Home Screen. Tap Share, then "Add to Home Screen", and open it from there.'
            : 'This browser does not support push notifications.',
        };
      }
      if (!(await messagingSupported())) {
        return { ok: false, reason: 'Push messaging is not available in this browser.' };
      }

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        return { ok: false, reason: 'Notifications are blocked. You can turn them back on in Settings.' };
      }

      const reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;

      const token = await getToken(getMessaging(app), {
        vapidKey: VAPID_PUBLIC_KEY,
        serviceWorkerRegistration: reg,
      });
      if (!token) return { ok: false, reason: 'Could not get a notification token.' };

      // A push token is far longer than the 1500-byte cap on a Firestore
      // document id, so the id is a digest and the token lives in a field.
      const id = sha256(token).slice(0, 32);
      const ua = navigator.userAgent.slice(0, 200);
      await setDoc(doc(db, 'artifacts', appId, 'users', uid, 'pushTokens', id), {
        token,
        platform: isNativeApp() ? 'ios-app' : (iOS ? 'ios-web' : 'web'),
        userAgent: ua,
        updatedAt: Date.now(),
      });

      // Drop this device's PREVIOUS tokens. Deleting a Home Screen app throws
      // away its push subscription but leaves the token in Firestore, and FCM
      // keeps reporting those as delivered -- so they pile up and silently
      // absorb notifications that never arrive anywhere. Matched on user agent,
      // which is the same phone re-registering.
      try {
        const existing = await getDocs(collection(db, 'artifacts', appId, 'users', uid, 'pushTokens'));
        await Promise.all(existing.docs
          .filter((d) => d.id !== id && d.data().userAgent === ua)
          .map((d) => deleteDoc(d.ref)));
      } catch (e) {}

      try { localStorage.setItem(PUSH_ID_KEY, id); } catch (e) {}
      return { ok: true, reason: 'Notifications are on for this device.' };
    }

    // Turning them OFF deletes the token the bridge sends to. Browser permission
    // itself cannot be revoked from script -- only the user can, in Settings --
    // so removing the token is what actually stops the notifications, and it
    // stops them for THIS device without touching the parent's other phones.
    async function disableWebPush(uid) {
      let id = null;
      try { id = localStorage.getItem(PUSH_ID_KEY); } catch (e) {}

      if (uid && id) {
        try { await deleteDoc(doc(db, 'artifacts', appId, 'users', uid, 'pushTokens', id)); } catch (e) {}
      }
      try { await deleteToken(getMessaging(app)); } catch (e) {}
      try { localStorage.removeItem(PUSH_ID_KEY); } catch (e) {}
      return { ok: true, reason: 'Notifications are off for this device.' };
    }

    // Is this browser currently registered? Checked against Firestore rather
    // than trusting localStorage alone: a token pruned as dead at the other end
    // would otherwise still show as on.
    async function webPushState(uid) {
      if (!uid) return false;
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
      let id = null;
      try { id = localStorage.getItem(PUSH_ID_KEY); } catch (e) {}
      if (!id) return false;
      try {
        const snap = await getDoc(doc(db, 'artifacts', appId, 'users', uid, 'pushTokens', id));
        return snap.exists();
      } catch (e) {
        return false;
      }
    }

    // --- Inline SVG Icons ---
    const Shield = ({className}) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>;
    // Deliberately mirrors the device's own gauge: same body-and-nub outline, one
    // bar left. A parent glancing at the app sees the shape their child is
    // looking at on the hardware.
    const Bell = ({className}) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>;
    const UserPlus = ({className}) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>;
    const BatteryLow = ({className}) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><rect x="2" y="7" width="16" height="10" rx="2"/><line x1="22" y1="11" x2="22" y2="13"/><rect x="4" y="9" width="3" height="6" fill="currentColor" stroke="none"/></svg>;
    const Activity = ({className}) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>;
    const LogOut = ({className}) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>;
    const Plus = ({className}) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>;
    const SettingsIcon = ({className}) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>;
    const MessageCircle = ({className}) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="m3 21 1.9-5.7a8.5 8.5 0 1 1 3.8 3.8z"/></svg>;
    const BookOpen = ({className}) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>;
    const Volume2 = ({className}) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>;
    const Send = ({className}) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>;
    const Trash2 = ({className}) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>;
    const ArrowRight = ({className}) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>;
    const ArrowLeft = ({className}) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>;
    const Cpu = ({className}) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>;
    const Wifi = ({className}) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>;
    const CheckCircle2 = ({className}) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>;
    const Share = ({className}) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>;
    const Info = ({className}) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>;
    const Clock = ({className}) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
    const X = ({className}) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>;
    const Users = ({className}) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>;

    // --- Safe Hashing Utility ---
    async function hashId(message) {
      if (window.crypto && window.crypto.subtle) {
        const msgBuffer = new TextEncoder().encode(message.toLowerCase().trim()); 
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      } else {
        return sha256(message.toLowerCase().trim());
      }
    }

    // --- Default Phrases ---
    const defaultPhrases = ["HELLO!", "HOW ARE YOU?", "COME OVER?", "MEET AT PARK?", "GREAT!", "OK", "MAYBE LATER", "BUSY", ":)", ":(", "ASKING PARENT", "CALL MY PARENT", "BYE!"];

    function App() {
      const [user, setUser] = useState(null);
      const [parentProfile, setParentProfile] = useState(null);
      const [devices, setDevices] = useState([]);
      const [loading, setLoading] = useState(true);
      const [devicesLoaded, setDevicesLoaded] = useState(false);
      const [mqttClient, setMqttClient] = useState(null);
      
      const [isWizardActive, setIsWizardActive] = useState(false);
      // A notification tap names the tab that ANSWERS it. Two routes in, because
      // the app may be cold or already running:
      //   cold   -- the service worker opens /test.html#monitor, read here
      //   warm   -- the service worker focuses the window and postMessages the
      //             tab, because an open page never re-reads its own URL
      // Hash carries "<tab>" or "<tab>:<who>", where who is the sender's NAME+PIN
      // for a chat and the device hash for a monitor alert.
      const parseHash = () => {
        const raw = (window.location.hash || '').replace('#', '');
        const [tab, who] = raw.split(':');
        return {
          tab: ['chat', 'monitor', 'tutorials', 'settings'].includes(tab) ? tab : 'chat',
          who: who || null,
        };
      };
      const [activeTab, setActiveTab] = useState(() => parseHash().tab);
      const [childOnlineStatus, setChildOnlineStatus] = useState({});
      const [activeChildId, setActiveChildId] = useState(null); 
      
      const [messages, setMessages] = useState(() => {
        try { const saved = localStorage.getItem('dotdash_messages'); return saved ? JSON.parse(saved) : []; } catch (e) { return []; }
      });
      const [monitorMessages, setMonitorMessages] = useState(() => {
        try { const saved = localStorage.getItem('dotdash_monitor'); return saved ? JSON.parse(saved) : []; } catch (e) { return []; }
      });
      // Pending timer-points approval requests from children's devices
      const [pendingApprovals, setPendingApprovals] = useState([]);

      // Strangers who have messaged a child and are waiting on a parent's answer.
      // Not persisted: like the battery flag these mirror retained broker topics
      // the device owns, and the broker replays them on every subscribe.
      const [pendingFriendReqs, setPendingFriendReqs] = useState([]);

      // Which messages a parent has actually SEEN, as childLabel -> highest
      // message id read. Kept in Firestore rather than only locally so the
      // bridge can put a correct number on the app icon when the app is shut --
      // a badge that only updates while the app is open is wrong exactly when
      // someone looks at it.
      //
      // One small document per parent, written only when the value changes.
      const [readState, setReadState] = useState(() => {
        try { return JSON.parse(localStorage.getItem('dotdash_read') || '{}'); } catch (e) { return {}; }
      });

      // Devices reporting a flat battery, keyed by device id.
      // Deliberately NOT persisted to localStorage, unlike messages above: this
      // mirrors a RETAINED broker topic that the device owns and clears itself,
      // and the broker replays it on every subscribe. Caching it locally would
      // only create a window where the app shows a warning for a device that was
      // plugged in hours ago. Let it come from the device, every time.
      const [lowBattery, setLowBattery] = useState({});

      // What each device says it ACTUALLY has stored, keyed by device id. The
      // device reports SSIDs only; passwords never leave it. Without this the
      // network joined through the captive portal at setup -- usually the
      // family's own home wifi -- would never appear in the app's list, which
      // is precisely where someone would go looking for it.
      const [deviceWifi, setDeviceWifi] = useState({});
      
      const isAppActiveRef = useRef(true); 
      
      const parentProfileRef = useRef(parentProfile);
      useEffect(() => { parentProfileRef.current = parentProfile; }, [parentProfile]);
      const devicesRef = useRef(devices);
      useEffect(() => { devicesRef.current = devices; }, [devices]);
      // Read inside the MQTT handler to decide whether an alert is NEW, so the
      // notification fires once per flat battery rather than on every redelivery
      // of the retained message (each reconnect replays it).
      const lowBatteryRef = useRef(lowBattery);
      useEffect(() => { lowBatteryRef.current = lowBattery; }, [lowBattery]);

      // 1. Firebase Auth Listener
      useEffect(() => {
        const initAuth = async () => {
          if (isCanvas && !auth.currentUser) {
            try {
              if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
                await signInWithCustomToken(auth, __initial_auth_token);
              } else {
                await signInAnonymously(auth);
              }
            } catch (e) { console.error("Canvas Auth Error:", e); }
          }
        };
        initAuth();

        const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
          if (currentUser) {
            setUser(currentUser);
            try {
              const profileRef = doc(db, 'artifacts', appId, 'users', currentUser.uid, 'profile', 'parent');
              const profileSnap = await getDoc(profileRef);
              if (profileSnap.exists()) {
                setParentProfile(profileSnap.data());
              } else {
                setParentProfile({ virtualId: null }); 
              }
            } catch (err) {
              console.error("Profile Fetch Error:", err);
              setParentProfile({ virtualId: null });
            }
          } else {
            setUser(null);
            setParentProfile(null);
            setDevices([]);
          }
          setLoading(false);
        });
        return () => unsubscribe();
      }, []);

      // 2. Firestore Devices Listener
      useEffect(() => {
        if (!user) {
            setDevicesLoaded(false);
            return;
        }
        
        const devicesRef = collection(db, 'artifacts', appId, 'users', user.uid, 'devices');
        const unsubscribe = onSnapshot(devicesRef, (snapshot) => {
          const loadedDevices = [];
          snapshot.forEach((doc) => {
            loadedDevices.push({ id: doc.id, ...doc.data() });
          });
          setDevices(loadedDevices);
          
          setActiveChildId(currentId => {
             if (loadedDevices.length > 0 && !loadedDevices.find(d => d.id === currentId)) {
                return loadedDevices[0].id;
             }
             return currentId;
          });
          
          setDevicesLoaded(true);
        }, (error) => {
          console.error("Firestore Listen Error:", error);
          setDevicesLoaded(true);
        });
        
        return () => unsubscribe();
      }, [user]); 

      // State Persistence
      useEffect(() => { localStorage.setItem('dotdash_messages', JSON.stringify(messages)); }, [messages]);
      useEffect(() => { localStorage.setItem('dotdash_monitor', JSON.stringify(monitorMessages)); }, [monitorMessages]);
      
      useEffect(() => {
        if (!('serviceWorker' in navigator)) return;
        const onSwMessage = (e) => {
          if (e.data && e.data.type === 'dotdash:navigate' && e.data.tab) {
            setActiveTab(e.data.tab);
            if (e.data.who) selectDeviceFor(e.data.who);
          }
        };
        navigator.serviceWorker.addEventListener('message', onSwMessage);
        // Also covers the case where iOS resumes the app on a new hash rather
        // than reloading it.
        const onHash = () => {
          const { tab, who } = parseHash();
          setActiveTab(tab);
          if (who) selectDeviceFor(who);
        };
        window.addEventListener('hashchange', onHash);
        return () => {
          navigator.serviceWorker.removeEventListener('message', onSwMessage);
          window.removeEventListener('hashchange', onHash);
        };
      }, []);

      useEffect(() => {
        // Native asks through the plugin; the browser path is unchanged. On
        // native this covers foreground banners only -- the APNs permission the
        // bridge needs is requested separately by the push registration flow.
        if (isNativeApp()) {
          try {
            const ln = window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
            if (ln) ln.requestPermissions();
          } catch (e) {}
        } else if ('Notification' in window && Notification.permission !== 'granted' && Notification.permission !== 'denied') {
          Notification.requestPermission();
        }
        const handleVisibilityChange = () => { isAppActiveRef.current = document.visibilityState === 'visible'; };
        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
      }, []);

      // 3. Global MQTT Connection
      useEffect(() => {
        if (!user) {
           if (mqttClient && typeof mqttClient.end === 'function') {
               mqttClient.end();
               setMqttClient(null);
           }
           return;
        }

        // =========================================================================
        // ✅ HIVEMQ SERVER CONFIGURATION ✅
        // =========================================================================
        const brokerUrl = 'wss://mqtt.dotdashdevice.com:8884/mqtt';
        let client = null;

        let isCanvasBlocked = false;
        try { const testWs = new WebSocket(brokerUrl); testWs.close(); } 
        catch (err) { isCanvasBlocked = true; }

        if (isCanvasBlocked) {
          client = {
            handlers: {},
            connected: false,
            on(event, handler) { if (!this.handlers[event]) this.handlers[event] = []; this.handlers[event].push(handler); },
            emit(event, ...args) { if (this.handlers[event]) this.handlers[event].forEach(h => h(...args)); },
            subscribe() {}, publish() {}, unsubscribe() {}, removeListener() {}, end() {}
          };
          setMqttClient(client);
          setTimeout(() => { client.connected = true; client.emit('connect'); }, 800);
        } else {
          // Broker credentials. These are PUBLIC by necessity -- this file is served
          // to every parent, so treat them as an identity, not a secret. Security
          // comes from the broker ACL: this account may command and claim devices
          // and read Monitor, and nothing outside doorbell/. Devices use a separate
          // account that cannot read Monitor or claim a device.
          const options = { 
            username: 'dotdash-app', 
            password: 'sqEh8Vx6hNE5ZaBKDG2LP1X', 
            clientId: 'web_' + Math.random().toString(16).substr(2, 8) 
          };
          client = mqtt.connect(brokerUrl, options);
          setMqttClient(client);
        }
        // =========================================================================

        client.on('message', async (topic, message) => {
          const payload = message.toString();

          // ---- Low battery ----
          // Handled AHEAD of the empty-payload guard below, because clearing the
          // alert IS an empty retained payload -- that is the device saying "back
          // on charge". Dropping it as a blank message would leave the warning
          // stuck up until the parent reloaded the app.
          const tParts = topic.split('/');
          if (tParts[1] === 'monitor' && tParts[3] === 'battery') {
            const battHash = tParts[2];
            let battChildId = null;
            for (const d of devicesRef.current) {
              const h = d.hashedId || await hashId(d.identity.name + d.identity.pin);
              if (h === battHash) { battChildId = d.id; break; }
            }
            if (!battChildId) return;

            if (payload.split(',')[0] === 'LOWBATT') {
              const mv = parseInt(payload.split(',')[1]) || 0;
              // Notify only on the transition, not on every retained redelivery.
              if (!lowBatteryRef.current[battChildId]) {
                {
                  const dv = devicesRef.current.find(x => x.id === battChildId);
                  const label = dv ? displayName(`${dv.identity.name}${dv.identity.pin}`) : 'A device';
                  notify('🔋 Low battery', `${label} needs charging.`);
                }
              }
              setLowBattery(prev => ({ ...prev, [battChildId]: { mv, at: Date.now() } }));
            } else {
              // Empty payload, or anything we don't recognise: the device is no
              // longer asking for a charge. Clear it.
              setLowBattery(prev => {
                if (!prev[battChildId]) return prev;
                const next = { ...prev };
                delete next[battChildId];
                return next;
              });
            }
            return; // do NOT fall through to the auto-clear: the device owns this slot
          }

          if (!payload) return;

          const currentProfile = parentProfileRef.current;
          const currentDevices = devicesRef.current;
          const parentId = currentProfile?.virtualId || 'PENDING';
          const hashedParent = await hashId(parentId);
          
          const childHashMap = {};
          const inboxTopics = {};
          const monitorTopics = {};
          
          for (const d of currentDevices) {
            const hash = d.hashedId || await hashId(d.identity.name + d.identity.pin);
            childHashMap[hash] = d.id;
            inboxTopics[`doorbell/msg/${hash}`] = d.id;
            monitorTopics[`doorbell/monitor/${hash}`] = d.id;
          }

          if (topic.startsWith('doorbell/presence/')) {
             const incomingHash = topic.split('/').pop();
             const cId = childHashMap[incomingHash];
             if (cId) setChildOnlineStatus(prev => ({...prev, [cId]: payload === "ONLINE"}));
             return;
          }

          const topicParts = topic.split('/');
          const baseTopic = topicParts.slice(0, 3).join('/');
          let msgId = Date.now();
          if (topicParts.length > 3) msgId = parseInt(topicParts[3]);
          // Devices that haven't taken the epoch-timestamp update yet put millis()
          // here -- uptime, not wall clock. It renders as a 1970 time, and being
          // ~1e6 against our ~1e12 epoch ids it sorts every device message ahead
          // of every parent message. The two ranges never overlap (millis() rolls
          // over at 4.3e9), so anything below a plausible epoch is uptime: fall
          // back to arrival time rather than trusting it.
          if (isNaN(msgId) || msgId < 1600000000000) msgId = Date.now();
          
          if (baseTopic === `doorbell/msg/${hashedParent}`) {
            // ORDER MATTERS. The retained copy on the broker is the ONLY copy
            // until this client saves it, so it is released last. Clearing first
            // meant a message could vanish for good: iOS suspends this app within
            // seconds of it connecting, and anything suspended between the clear
            // and the save was gone from the broker and never written anywhere.
            const parts = payload.split(',');
            let stored = false;
            if (parts.length >= 3) {
              const newMsg = {
                id: msgId, type: parts[0], text: parts[1], sender: parts[2], target: parentId, isMe: false,
                timestamp: new Date(msgId).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              };
              setMessages(prev => {
                if (prev.some(m => m.id === msgId)) return prev;
                const next = [...prev, newMsg];
                // Written here rather than left to the effect that mirrors
                // `messages`, because that effect runs a tick later -- which is
                // exactly the gap a suspension falls into.
                try { localStorage.setItem('dotdash_messages', JSON.stringify(next)); } catch (e) {}
                return next;
              });
              stored = true;
            }
            // A payload we could not parse is left on the broker deliberately:
            // better a message that reappears than one silently destroyed.
            if (stored && !isCanvasBlocked) client.publish(topic, "", { retain: true });
            return;
          }

          if (inboxTopics[baseTopic]) {
            const targetChildMac = inboxTopics[baseTopic];
            const parts = payload.split(',');
            if (parts.length >= 3 && parts[2] !== parentId) {
                const newMonMsg = {
                  id: msgId, type: parts[0], text: parts[1], direction: 'in', childMac: targetChildMac, otherParty: parts[2],
                  timestamp: new Date(msgId).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                };
                setMonitorMessages(prev => {
                  if (prev.some(m => m.id === msgId)) return prev;
                  return [...prev, newMonMsg];
                });
            }
            return;
          }

          if (monitorTopics[baseTopic]) {
            const sourceChildMac = monitorTopics[baseTopic];

            // The device reporting the network list it actually holds.
            if (topicParts[3] === 'wifi') {
              const fields = payload.split(String.fromCharCode(0x1f));
              if (fields[0] === 'WIFI') {
                const ssids = fields.slice(1).filter(Boolean);
                setDeviceWifi(prev => ({ ...prev, [sourceChildMac]: ssids }));
              }
              return; // retained and device-owned; do not auto-clear
            }

            // A stranger messaged this child. The device shows its own NEW REQ
            // card, but only a parent can actually add a friend -- so the same
            // event surfaces here, where it can be answered. Retained until
            // answered, like the timer request below.
            if (topicParts[3] === 'friendreq') {
              const parts = payload.split(',');
              if (parts[0] === 'FRIENDREQ' && parts.length >= 2) {
                const strangerId = parts[1];
                const dev = currentDevices.find(d => d.id === sourceChildMac);
                const childLabel = dev ? `${dev.identity.name}${dev.identity.pin}` : 'Your child';
                setPendingFriendReqs(prev => {
                  if (prev.some(r => r.childMac === sourceChildMac && r.strangerId === strangerId)) return prev;
                  return [...prev, { strangerId, childMac: sourceChildMac, childHash: topicParts[2], childLabel, topic }];
                });
                notify('👋 New friend request', `${displayName(strangerId)} sent ${displayName(childLabel)} a message. Add them as a friend?`);
              }
              return; // do NOT auto-clear; cleared when the parent answers
            }

            // Timer-points approval request. Keep it retained until the parent
            // acts, so a closed/reopened app still sees a pending request.
            if (topicParts[3] === 'timerreq') {
              const parts = payload.split(',');
              if (parts[0] === 'TIMERREQ' && parts.length >= 4) {
                const reqId = parts[3];
                const minutes = parseInt(parts[1]) || 0;
                const points = parseInt(parts[2]) || 0;
                const childHash = topicParts[2];
                const dev = currentDevices.find(d => d.id === sourceChildMac);
                const childLabel = dev ? `${dev.identity.name}${dev.identity.pin}` : 'Your child';
                setPendingApprovals(prev => {
                  if (prev.some(p => p.reqId === reqId)) return prev;
                  return [...prev, { reqId, minutes, points, childMac: sourceChildMac, childHash, childLabel, topic }];
                });
                notify('⏱️ Timer completed', `${displayName(childLabel)} finished a ${minutes}-minute timer — approve ${points} point${points > 1 ? 's' : ''}?`);
              }
              return; // do NOT auto-clear; cleared when the parent approves/denies
            }

            const parts = payload.split(',');
            if (parts.length >= 3) {
              let targetFriend = "A Friend";
              if (parts.length > 3) {
                 const targetData = parts[3];
                 if (targetData.length === 64) {
                     for (const d of currentDevices) {
                         if (d.friends) {
                             for (const f of d.friends) {
                                 if (await hashId(f) === targetData) { targetFriend = f; break; }
                             }
                         }
                         if (targetFriend !== "A Friend") break;
                     }
                 } else { targetFriend = targetData; }
              }

              const newMonMsg = {
                id: msgId, type: parts[0], text: parts[1], direction: 'out', childMac: sourceChildMac, otherParty: targetFriend,
                timestamp: new Date(msgId).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              };
              setMonitorMessages(prev => {
                if (prev.some(m => m.id === msgId)) return prev;
                const next = [...prev, newMonMsg];
                try { localStorage.setItem('dotdash_monitor', JSON.stringify(next)); } catch (e) {}
                return next;
              });
              // Released only now, for the same reason as the parent path above.
              if (!isCanvasBlocked) client.publish(topic, "", { retain: true });
            }
          }
        });

        return () => { if (client && typeof client.end === 'function') client.end(); };
      }, [user]); 

      // 4. Dynamic Subscriptions
      useEffect(() => {
        if (!mqttClient) return;

        const updateSubscriptions = async () => {
           if (parentProfile?.virtualId) {
               const hashedParent = await hashId(parentProfile.virtualId);
               mqttClient.subscribe(`doorbell/msg/${hashedParent}`, { qos: 1 });
               mqttClient.subscribe(`doorbell/msg/${hashedParent}/#`, { qos: 1 });
           }
           for (const d of devices) {
               const hash = d.hashedId || await hashId(d.identity.name + d.identity.pin);
               mqttClient.subscribe(`doorbell/presence/${hash}`);
               mqttClient.subscribe(`doorbell/msg/${hash}/#`, { qos: 1 });
               mqttClient.subscribe(`doorbell/monitor/${hash}/#`, { qos: 1 });
           }
        };

        if (mqttClient.connected) {
            updateSubscriptions();
        } else {
            mqttClient.on('connect', updateSubscriptions);
        }

        return () => {
            if (mqttClient && typeof mqttClient.removeListener === 'function') {
                mqttClient.removeListener('connect', updateSubscriptions);
            }
        }
      }, [mqttClient, devices, parentProfile]);


      // A notification names WHO it is about: a sender's NAME+PIN for a chat, or
      // a device hash for a monitor alert. Both resolve to the same device here,
      // because both tabs select by device id.
      //
      // Declared with the other hooks, ABOVE the early returns below. Putting the
      // effect after them broke the Rules of Hooks -- on any render that took an
      // early return the hook was skipped, the hook count changed, and React
      // unmounted the whole tree to a blank screen.
      const selectDeviceFor = (who) => {
        if (!who) return;
        const match = devicesRef.current.find((d) => {
          const label = `${d.identity?.name || ''}${d.identity?.pin || ''}`;
          return label === who || d.hashedId === who;
        });
        if (match) setActiveChildId(match.id);
      };

      // Cold start: devices load asynchronously, so the hash cannot be applied
      // until they exist. Runs once they do, then clears the hash so a later
      // reload does not keep yanking the parent back to an old notification.
      useEffect(() => {
        if (!devices.length) return;
        const { who } = parseHash();
        if (!who) return;
        selectDeviceFor(who);
        try { window.history.replaceState(null, '', window.location.pathname); } catch (e) {}
      }, [devices]);

      // Inbound messages come from FIRESTORE, not only from MQTT.
      //
      // The retained MQTT message is a single copy that the first client to read
      // it consumes. If this app happened to be the one that took it and was
      // then suspended -- which iOS does within seconds -- the message was gone
      // from the broker and stored nowhere. The bridge, which never sleeps, now
      // records every message to this parent, and this listener is what makes it
      // show up reliably and on every one of their devices.
      //
      // The MQTT path stays for immediacy while the app is open. Both merge by
      // id, so the overlap is harmless.
      useEffect(() => {
        if (!user) return;
        // BOUNDED, and this matters more than it looks. onSnapshot reads every
        // document in the collection on first attach, so an unbounded query
        // costs one read per message EVER STORED, on every app open. At 25
        // devices that crosses the free tier's 50k reads/day once each parent
        // has ~200 messages of history -- from history accumulating, not from
        // more devices. With a limit, an app open costs at most MESSAGE_PAGE
        // reads no matter how long the product has been running.
        const ref = query(
          collection(db, 'artifacts', appId, 'users', user.uid, 'messages'),
          orderBy('id', 'desc'),
          limit(MESSAGE_PAGE)
        );
        const unsub = onSnapshot(ref, (snap) => {
          const incoming = snap.docs.map((d) => {
            const m = d.data();
            return {
              id: m.id || Number(d.id),
              type: m.type,
              text: m.text,
              sender: m.sender,
              target: null,
              isMe: false,
              timestamp: new Date(m.id || Number(d.id)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            };
          });
          if (!incoming.length) return;
          setMessages((prev) => {
            const seen = new Set(prev.map((m) => m.id));
            const add = incoming.filter((m) => !seen.has(m.id));
            if (!add.length) return prev;
            const next = [...prev, ...add].sort((a, b) => a.id - b.id);
            try { localStorage.setItem('dotdash_messages', JSON.stringify(next)); } catch (e) {}
            return next;
          });
        }, (e) => console.error('message sync failed', e));
        return () => unsub();
      }, [user]);

      // Notification taps on NATIVE arrive through the Firebase plugin, not a
      // service worker -- the iOS app is a Capacitor WebView and has no SW at
      // all, which is why deep linking worked on the Home Screen PWA and did
      // nothing in the app. Same destination data either way: the bridge puts
      // tab and who in the message's data payload.
      useEffect(() => {
        if (!isNativeApp()) return;
        let remove;
        (async () => {
          try {
            const { FirebaseMessaging } = await import('@capacitor-firebase/messaging');
            const handle = await FirebaseMessaging.addListener('notificationActionPerformed', (event) => {
              const d = event?.notification?.data || {};
              if (d.tab) setActiveTab(d.tab);
              if (d.who) selectDeviceFor(d.who);
            });
            remove = () => handle.remove();
          } catch (e) {}
        })();
        return () => { try { remove && remove(); } catch (e) {} };
      }, []);

      // Pull read state down once signed in, so a second device does not show
      // badges for messages already read on the first.
      useEffect(() => {
        if (!user) return;
        let alive = true;
        getDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'state', 'read'))
          .then((snap) => {
            if (!alive || !snap.exists()) return;
            const remote = snap.data().lastRead || {};
            setReadState((local) => {
              // Merge on the HIGHER id per child: whichever device read further
              // wins, and neither can un-read the other's progress.
              const merged = { ...local };
              for (const [k, v] of Object.entries(remote)) {
                if (!merged[k] || v > merged[k]) merged[k] = v;
              }
              try { localStorage.setItem('dotdash_read', JSON.stringify(merged)); } catch (e) {}
              return merged;
            });
          })
          .catch(() => {});
        return () => { alive = false; };
      }, [user]);

      // Unread per child, and the totals the badges use.
      const unreadByChild = React.useMemo(() => {
        const out = {};
        for (const m of messages) {
          if (m.isMe || !m.sender) continue;
          const seen = readState[m.sender] || 0;
          if (m.id > seen) out[m.sender] = (out[m.sender] || 0) + 1;
        }
        return out;
      }, [messages, readState]);

      const totalUnreadChats = Object.values(unreadByChild).reduce((a, b) => a + b, 0);
      const monitorCount = pendingApprovals.length + pendingFriendReqs.length +
        Object.keys(lowBattery).filter(id => devices.some(d => d.id === id)).length;

      // Opening a child's chat is what marks it read -- not receiving the
      // message, and not merely having the app open on another tab.
      useEffect(() => {
        if (activeTab !== 'chat' || !activeChildId || !user) return;
        const dev = devices.find(d => d.id === activeChildId);
        if (!dev) return;
        const label = `${dev.identity.name}${dev.identity.pin}`;
        const highest = messages.reduce((max, m) => (!m.isMe && m.sender === label && m.id > max ? m.id : max), 0);
        if (!highest || (readState[label] || 0) >= highest) return;

        const next = { ...readState, [label]: highest };
        setReadState(next);
        try { localStorage.setItem('dotdash_read', JSON.stringify(next)); } catch (e) {}
        setDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'state', 'read'),
               { lastRead: next, badge: 0, updatedAt: Date.now() }, { merge: true }).catch(() => {});
      }, [activeTab, activeChildId, messages, devices, user, readState]);

      // The iOS app icon number. Set from here whenever it changes; the bridge
      // keeps it moving while the app is closed.
      useEffect(() => {
        if (!isNativeApp()) return;
        const total = totalUnreadChats + monitorCount;
        (async () => {
          try {
            const { Badge } = await import('@capawesome/capacitor-badge');
            if (total > 0) await Badge.set({ count: total });
            else await Badge.clear();
          } catch (e) {}
        })();
      }, [totalUnreadChats, monitorCount]);

      // Keep the stored badge in step with what the app is showing, so the
      // bridge increments from the right number rather than a stale one.
      useEffect(() => {
        if (!user) return;
        const total = totalUnreadChats + monitorCount;
        setDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'state', 'read'),
               { badge: total }, { merge: true }).catch(() => {});
      }, [totalUnreadChats, monitorCount, user]);

      // --- AUTO-LAUNCH WIZARD ---
      useEffect(() => {
        if (!loading && user && devicesLoaded && (!parentProfile?.virtualId || devices.length === 0) && !isWizardActive) {
           setIsWizardActive(true);
        }
      }, [loading, user, parentProfile, devices, devicesLoaded, isWizardActive]);

      if (loading || (user && !devicesLoaded)) return <div className="flex h-screen items-center justify-center"><Activity className="w-12 h-12 text-blue-500 animate-pulse" /></div>;

      if (!user) return <AuthScreen />;

      if (isWizardActive) {
         return <OnboardingWizard 
                   user={user} 
                   parentProfile={parentProfile} 
                   setParentProfile={setParentProfile} 
                   mqttClient={mqttClient} 
                   appId={appId}
                   onComplete={() => setIsWizardActive(false)} 
                   onCancel={() => {
                       if (devices.length > 0 && parentProfile?.virtualId) {
                           setIsWizardActive(false); // Just cancel adding a 2nd device
                       } else {
                           signOut(auth); // First time setup trap: log out to return to login screen
                       }
                   }}
                />;
      }

      const activeDevice = devices.find(d => d.id === activeChildId);
      const activeChildLabel = activeDevice ? `${activeDevice.identity.name}${activeDevice.identity.pin}` : '';

      return (
        <div className="flex flex-col h-full w-full bg-[#f2f2f7] text-black font-sans selection:bg-blue-200 overflow-hidden">
          <div className="flex-1 flex flex-col px-4 overflow-hidden" style={{ paddingTop: 'max(env(safe-area-inset-top), 1rem)' }}>
            
            {activeTab === 'chat' && <ChatView unreadByChild={unreadByChild} mqttClient={mqttClient} messages={messages} setMessages={setMessages} parentProfile={parentProfile} devices={devices} activeChildId={activeChildId} setActiveChildId={setActiveChildId} childOnlineStatus={childOnlineStatus} activeChildLabel={activeChildLabel} />}
            {activeTab === 'monitor' && <MonitorView monitorMessages={monitorMessages} devices={devices} activeChildId={activeChildId} setActiveChildId={setActiveChildId} activeChildLabel={activeChildLabel} pendingApprovals={pendingApprovals} setPendingApprovals={setPendingApprovals} mqttClient={mqttClient} lowBattery={lowBattery} pendingFriendReqs={pendingFriendReqs} setPendingFriendReqs={setPendingFriendReqs} user={user} parentProfile={parentProfile} />}
            {activeTab === 'tutorials' && <div className="h-full overflow-y-auto pb-4"><TutorialsView /></div>}
            {activeTab === 'settings' && <div className="h-full overflow-y-auto pb-4">
               <SettingsView user={user} parentProfile={parentProfile} devices={devices} activeChildId={activeChildId} setActiveChildId={setActiveChildId} activeDevice={activeDevice} mqttClient={mqttClient} appId={appId} startAddDeviceFlow={() => setIsWizardActive(true)} childOnlineStatus={childOnlineStatus} deviceWifi={deviceWifi} />
            </div>}
          </div>

          <div className="shrink-0 w-full bg-[#f8f8f8]/90 backdrop-blur-md border-t border-gray-300 pt-2 px-4 flex justify-between items-center" style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 16px)' }}>
            <TabButton icon={<MessageCircle className="w-6 h-6"/>} label="Chat" active={activeTab === 'chat'} onClick={() => setActiveTab('chat')} badge={totalUnreadChats} />
            {/* Count only alerts for devices still linked -- an unlinked device
                leaves a stale key behind, and a badge you cannot clear is worse
                than no badge. */}
            <TabButton icon={<Shield className="w-6 h-6"/>} label="Monitor" active={activeTab === 'monitor'} onClick={() => setActiveTab('monitor')} badge={monitorCount} />
            <TabButton icon={<BookOpen className="w-6 h-6"/>} label="Tutorials" active={activeTab === 'tutorials'} onClick={() => setActiveTab('tutorials')} />
            <TabButton icon={<SettingsIcon className="w-6 h-6"/>} label="Settings" active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} />
          </div>
        </div>
      );
    }

    // ==============================================
    //                AUTHENTICATION
    // ==============================================
    function AuthScreen() {
      const [view, setView] = useState('LANDING'); 
      const [email, setEmail] = useState('');
      const [password, setPassword] = useState('');
      const [error, setError] = useState('');
      const [isLoading, setIsLoading] = useState(false); 

      const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setIsLoading(true);
        try {
          if (view === 'LOGIN') {
            await signInWithEmailAndPassword(auth, email, password);
          } else if (view === 'REGISTER') {
            await createUserWithEmailAndPassword(auth, email, password);
          } else if (view === 'FORGOT') {
            await sendPasswordResetEmail(auth, email);
            alert("Password reset email sent!");
            setView('LOGIN');
            setIsLoading(false);
          }
        } catch (err) { 
           setError(err.message); 
           setIsLoading(false);
        }
      };

      if (view === 'LANDING') {
        return (
          <div className="flex flex-col items-center justify-center min-h-screen p-6 text-center space-y-8 pb-12">
            <img src="https://raw.githubusercontent.com/sammyb-clouds/dot-dash-parent/main/icon.jpg" alt="Dot Dash Logo" className="w-28 h-28 rounded-3xl shadow-lg mt-8 object-cover" />
            <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Dot Dash</h1>
            
            <div className="w-full max-w-sm space-y-4">
              <button onClick={() => setView('REGISTER')} className="w-full bg-blue-500 text-white font-bold py-5 rounded-2xl shadow-sm active:bg-blue-600 transition-colors">
                1. Set up or register a Dot Dash
              </button>
              
              <button onClick={() => setView('LOGIN')} className="w-full bg-white text-blue-500 border border-blue-500 font-bold py-5 rounded-2xl shadow-sm active:bg-gray-50 transition-colors">
                2. Log in to Parent Companion App
              </button>
            </div>
          </div>
        );
      }

      return (
        <div className="flex flex-col items-center justify-center min-h-screen p-6 text-center">
          <button onClick={() => setView('LANDING')} className="absolute top-12 left-4 p-2 text-gray-500 font-bold flex items-center"><ArrowLeft className="w-5 h-5 mr-1"/> Back</button>
          
          <div className="w-20 h-20 bg-blue-500 text-white rounded-3xl flex items-center justify-center shadow-lg mb-8 mt-12">
             <Shield className="w-10 h-10" />
          </div>
          <h1 className="text-3xl font-bold mb-8">{view === 'LOGIN' ? 'Sign In' : view === 'REGISTER' ? 'Create Account' : 'Reset Password'}</h1>

          <form onSubmit={handleSubmit} className="w-full max-w-sm bg-white p-6 rounded-3xl shadow-sm border border-gray-100 space-y-4">
            {error && <div className="text-red-500 text-sm bg-red-50 p-3 rounded-xl">{error}</div>}
            
            <input type="email" placeholder="Email Address" required
              className="w-full bg-gray-50 px-4 py-3 rounded-xl outline-none border border-gray-100 focus:border-blue-300"
              value={email} onChange={e => setEmail(e.target.value)} disabled={isLoading} />
            
            {view !== 'FORGOT' && (
              <input type="password" placeholder="Password" required
                className="w-full bg-gray-50 px-4 py-3 rounded-xl outline-none border border-gray-100 focus:border-blue-300"
                value={password} onChange={e => setPassword(e.target.value)} disabled={isLoading} />
            )}
            
            <button type="submit" disabled={isLoading} className="w-full bg-blue-500 text-white font-bold py-4 rounded-xl active:bg-blue-600 transition-colors mt-2 disabled:bg-blue-300 disabled:shadow-none">
              {isLoading ? "Please wait..." : (view === 'LOGIN' ? "Sign In" : view === 'REGISTER' ? "Create Account" : "Send Reset Email")}
            </button>
          </form>

          {view === 'LOGIN' && (
            <button onClick={() => setView('FORGOT')} className="mt-6 text-blue-500 font-medium active:text-blue-700">Forgot password?</button>
          )}
        </div>
      );
    }

    // ==============================================
    //           VIRTUAL ID / PROFILE SETUP
    // ==============================================
    function ProfileSetupScreen({ user, setParentProfile, appId }) {
      const [parentName, setParentName] = useState('');
      const [parentPin, setParentPin] = useState('');
      
      const handleSave = async () => {
        const pName = parentName.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        const pPin = parentPin.trim();
        if (pName.length < 2 || pPin.length !== 4 || isNaN(pPin)) return alert("Enter a valid name and 4-digit PIN.");
        const vid = pName + pPin;
        
        const profileRef = doc(db, 'artifacts', appId, 'users', user.uid, 'profile', 'parent');
        await setDoc(profileRef, {
          email: user.email || 'anonymous@canvas.local',
          virtualId: vid
        });
        setParentProfile({ virtualId: vid });
      };

      return (
        <div className="flex flex-col items-center justify-center min-h-screen p-6 text-center">
          <h1 className="text-3xl font-bold mb-4">Create Your ID</h1>
          <p className="text-gray-500 mb-8 max-w-sm leading-relaxed">This is the ID your child will see when you send them messages (e.g. MOM0101, DAD99).</p>

          <div className="w-full max-w-sm bg-white p-6 rounded-3xl shadow-sm border border-gray-100 space-y-4">
            <input type="text" placeholder="Dad, Mama or Your Name" required maxLength="10"
              className="w-full bg-gray-50 px-4 py-4 rounded-xl outline-none font-bold uppercase text-lg border border-gray-100 focus:border-blue-300"
              value={parentName} onChange={e => setParentName(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
            <input type="text" placeholder="Birthday PIN (MMDD)" required maxLength="4"
              className="w-full bg-gray-50 px-4 py-4 rounded-xl outline-none font-bold uppercase text-lg border border-gray-100 focus:border-blue-300"
              value={parentPin} onChange={e => setParentPin(e.target.value.replace(/\D/g, ''))} />
            <button onClick={handleSave} className="w-full bg-blue-500 text-white font-bold py-4 rounded-xl active:bg-blue-600 transition-colors mt-2">
              Save and Continue
            </button>
          </div>
        </div>
      );
    }

    // ==============================================
    //           ONBOARDING & PAIRING WIZARD
    // ==============================================
    function OnboardingWizard({ user, parentProfile, setParentProfile, mqttClient, appId, onComplete, onCancel }) {
      const [step, setStep] = useState('WIFI_CHECK');
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState('');

      const [childName, setChildName] = useState('');
      const [childPin, setChildPin] = useState('');
      const [pairingCode, setPairingCode] = useState('');
      const [parentName, setParentName] = useState('');
      const [parentPin, setParentPin] = useState('');
      const [friendId, setFriendId] = useState('');
      const [friends, setFriends] = useState([]);
      const [claimedMac, setClaimedMac] = useState(null);

      const checkUniqueness = async (idString) => {
        const hash = await hashId(idString);
        const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'identities', hash);
        const snap = await getDoc(docRef);
        return !snap.exists();
      };

      const handleChildIdSubmit = async () => {
         setError(''); setLoading(true);
         const cName = childName.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
         const cPin = childPin.trim();
         if (cName.length < 2 || cPin.length !== 4 || isNaN(cPin)) {
             setLoading(false); return setError("Enter a valid name and 4-digit PIN.");
         }
         
         const isUnique = await checkUniqueness(cName + cPin);
         if (!isUnique) {
             setLoading(false); return setError("This combination is taken! Please choose a different PIN or Name.");
         }
         
         setChildName(cName); setChildPin(cPin);
         setLoading(false); setStep('PAIRING');
      };

      const handlePairingSubmit = async () => {
         setError(''); setLoading(true);
         const cleanCode = pairingCode.trim().toUpperCase();
         if (cleanCode.length !== 6) { setLoading(false); return setError("Code must be 6 characters."); }

         const replyTopic = `doorbell/pairing/reply/${cleanCode}`;
         mqttClient.subscribe(replyTopic);

         const timeout = setTimeout(() => {
            setLoading(false); setError("Could not find device. Ensure it is powered on and connected to Wi-Fi.");
            mqttClient.unsubscribe(replyTopic);
         }, 15000);

         const messageHandler = async (topic, message) => {
            if (topic === replyTopic) {
               clearTimeout(timeout);
               const payload = message.toString();
               const parts = payload.split(',');
               if (parts.length >= 3) {
                  const mac = parts[0];
                  
                  const childHash = await hashId(childName + childPin);
                  const initialFriends = parentProfile?.virtualId ? [parentProfile.virtualId] : [];
                  
                  await setDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'devices', mac), {
                     pairingCode: cleanCode,
                     hashedId: childHash,
                     identity: { name: childName, pin: childPin },
                     friends: initialFriends, 
                     phrases: defaultPhrases
                  });

                  await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'identities', childHash), {
                     owner: user.uid, idString: childName+childPin, type: 'child'
                  });

                  setClaimedMac(mac);
                  setLoading(false);
                  
                  if (!parentProfile?.virtualId) {
                      setStep('PARENT_ID');
                  } else {
                      setFriends(initialFriends); 
                      setStep('ADD_FRIENDS');
                      mqttClient.publish(`doorbell/cmd/${childHash}`, `CMD,SYNC_FRIENDS,${parentProfile.virtualId}`, {qos: 1, retain: true});
                      mqttClient.publish(`doorbell/cmd/${childHash}`, `CMD,SYNC_PHRASES,${defaultPhrases.join('|')}`, {qos: 1, retain: true});
                  }
               }
               mqttClient.unsubscribe(replyTopic);
               mqttClient.removeListener('message', messageHandler);
            }
         };
         mqttClient.on('message', messageHandler);

         const pIdPayload = parentProfile?.virtualId || 'PENDING';
         mqttClient.publish(`doorbell/pairing/${cleanCode}`, `CLAIM,${pIdPayload},${childName},${childPin}`);
      };

      const handleParentIdSubmit = async () => {
         setError(''); setLoading(true);
         const pName = parentName.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
         const pPin = parentPin.trim();
         if (pName.length < 2 || pPin.length !== 4 || isNaN(pPin)) {
             setLoading(false); return setError("Enter a valid name and 4-digit PIN.");
         }
         const pId = pName + pPin;

         const isUnique = await checkUniqueness(pId);
         if (!isUnique) { setLoading(false); return setError("This Parent ID is taken. Please add a number to the end (e.g. DAD99)."); }

         const profileRef = doc(db, 'artifacts', appId, 'users', user.uid, 'profile', 'parent');
         await setDoc(profileRef, { email: user.email || 'anonymous', virtualId: pId });
         setParentProfile({ virtualId: pId });

         const pHash = await hashId(pId);
         await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'identities', pHash), {
            owner: user.uid, idString: pId, type: 'parent'
         });

         const childHash = await hashId(childName + childPin);
         const devRef = doc(db, 'artifacts', appId, 'users', user.uid, 'devices', claimedMac);
         await updateDoc(devRef, { friends: [pId] });
         mqttClient.publish(`doorbell/cmd/${childHash}`, `CMD,SYNC_FRIENDS,${pId}`, {qos: 1, retain: true});

         setFriends([pId]);
         setLoading(false); setStep('ADD_FRIENDS');
      };

      const handleAddFriend = async () => {
         if (!friendId.trim()) return;
         const fId = friendId.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
         
         const devRef = doc(db, 'artifacts', appId, 'users', user.uid, 'devices', claimedMac);
         const snap = await getDoc(devRef);
         const currentFriends = snap.exists() ? (snap.data().friends || []) : [];
         
         let updatedFriends = [...new Set([parentProfile.virtualId, ...currentFriends].filter(Boolean))];
         
         if (!updatedFriends.includes(fId)) {
             updatedFriends.push(fId);
             await updateDoc(devRef, { friends: updatedFriends });
             
             const childHash = await hashId(childName + childPin);
             mqttClient.publish(`doorbell/cmd/${childHash}`, `CMD,SYNC_FRIENDS,${updatedFriends.join('|')}`, {qos: 1, retain: true});
             setFriends(updatedFriends);
         }
         setFriendId('');
      };

      const displayFriends = [...new Set([parentProfile?.virtualId, ...friends].filter(Boolean))];

      return (
        <div className="fixed inset-0 z-50 bg-white overflow-y-auto flex flex-col min-h-screen">
           <div className="p-4 pt-12 shrink-0 relative flex items-center justify-center">
               <button onClick={onCancel} className="absolute left-4 p-2 text-gray-500 hover:text-gray-700 font-bold flex items-center transition-colors">
                  <ArrowLeft className="w-5 h-5 mr-1"/> Back
               </button>
               <h1 className="text-3xl font-bold text-center">Setup Dot Dash</h1>
           </div>
           
           <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
             
             {step === 'WIFI_CHECK' && (
                <div className="w-full max-w-sm my-auto space-y-6">
                   <h2 className="text-xl font-bold mb-8">Have you connected your Dot Dash to your home Wi-Fi?</h2>
                   <button onClick={()=>setStep('CHILD_ID')} className="w-full bg-blue-500 text-white font-bold py-4 rounded-xl shadow-sm">Yes, it's connected</button>
                   <button onClick={()=>setStep('WIFI_INSTRUCT')} className="w-full bg-white text-gray-700 font-bold py-4 rounded-xl border border-gray-200 shadow-sm">No, I need to do that</button>
                </div>
             )}

             {step === 'WIFI_INSTRUCT' && (
                <div className="w-full max-w-sm my-auto text-left space-y-4">
                   <h2 className="text-2xl font-bold mb-6 text-center">Connect to Wi-Fi</h2>
                   
                   <div className="space-y-3">
                     <div className="flex items-start">
                       <div className="bg-blue-100 text-blue-600 font-bold rounded-full w-6 h-6 flex items-center justify-center shrink-0 mt-0.5 text-sm">1</div>
                       <p className="ml-3 text-gray-700">Turn on your Dot Dash. It will say <strong>HELLO!</strong> — press any button to begin.</p>
                     </div>
                     <div className="flex items-start">
                       <div className="bg-blue-100 text-blue-600 font-bold rounded-full w-6 h-6 flex items-center justify-center shrink-0 mt-0.5 text-sm">2</div>
                       <p className="ml-3 text-gray-700">Press <strong>SELECT</strong> (front arcade button) until you see <SettingsIcon className="inline w-4 h-4 align-text-bottom" /> <strong>TOOLS</strong> on the screen.</p>
                     </div>
                     <div className="flex items-start">
                       <div className="bg-blue-100 text-blue-600 font-bold rounded-full w-6 h-6 flex items-center justify-center shrink-0 mt-0.5 text-sm">3</div>
                       <p className="ml-3 text-gray-700">Press <strong>ENTER</strong> (top arcade button) to open Tools, then <strong>ENTER</strong> again on <strong>WIFI</strong> <span className="text-gray-500">(shown as <strong>DOT DASH SETUP</strong> on devices that haven't updated yet)</span>.</p>
                     </div>
                     <div className="flex items-start">
                       <div className="bg-blue-100 text-blue-600 font-bold rounded-full w-6 h-6 flex items-center justify-center shrink-0 mt-0.5 text-sm">4</div>
                       <p className="ml-3 text-gray-700">Get your phone or computer and open Wi-Fi settings. Join the network named <strong>Dot Dash Setup</strong>.</p>
                     </div>
                     <div className="flex items-start">
                       <div className="bg-blue-100 text-blue-600 font-bold rounded-full w-6 h-6 flex items-center justify-center shrink-0 mt-0.5 text-sm">5</div>
                       <p className="ml-3 text-gray-700">Wait a few seconds for a window to pop up, follow the setup instructions, then come back here!</p>
                     </div>
                   </div>

                   <button onClick={()=>setStep('CHILD_ID')} className="w-full bg-blue-500 text-white font-bold py-4 rounded-xl shadow-sm mt-8 mb-4">Done, let's continue</button>

                   <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-left shadow-sm">
                     <div className="flex items-start">
                        <div className="shrink-0 mt-0.5">
                           <Info className="w-5 h-5 text-amber-500" />
                        </div>
                        <div className="ml-3">
                           <h3 className="text-sm font-bold text-amber-800">Don't see the Dot Dash Setup network?</h3>
                           <p className="text-sm text-amber-700 mt-1 leading-relaxed">
                             Sometimes phones hold onto old network lists. Try turning your phone's Wi-Fi <strong>off and back on</strong> to force it to rescan!
                           </p>
                        </div>
                     </div>
                   </div>
                </div>
             )}

             {step === 'CHILD_ID' && (
                <div className="w-full max-w-sm my-auto space-y-4">
                   <h2 className="text-xl font-bold mb-2">Create Device ID</h2>
                   <p className="text-gray-500 mb-6">Choose a screen name and 4-digit PIN for your child.</p>
                   {error && <div className="text-red-500 text-sm bg-red-50 p-3 rounded-xl">{error}</div>}
                   <input type="text" placeholder="Child's Name (e.g. ARTHUR)" className="w-full bg-gray-50 px-4 py-4 rounded-xl outline-none font-bold uppercase text-lg border border-gray-200 focus:border-blue-400" value={childName} onChange={e=>setChildName(e.target.value)} />
                   <input type="text" placeholder="Birthday PIN (MMDD)" maxLength="4" className="w-full bg-gray-50 px-4 py-4 rounded-xl outline-none font-bold uppercase text-lg border border-gray-200 focus:border-blue-400" value={childPin} onChange={e=>setChildPin(e.target.value.replace(/\D/g, ''))} />
                   <button onClick={handleChildIdSubmit} disabled={loading} className="w-full bg-blue-500 text-white font-bold py-4 rounded-xl shadow-sm mt-4 disabled:bg-blue-300">
                     {loading ? 'Checking...' : 'Next'}
                   </button>
                </div>
             )}

             {step === 'PAIRING' && (
                <div className="w-full max-w-sm my-auto space-y-4">
                   <h2 className="text-xl font-bold mb-2">Link Your Device</h2>
                   <p className="text-gray-500 mb-6 text-left">On your Dot Dash, go to <SettingsIcon className="inline w-4 h-4 align-text-bottom" /> <strong>TOOLS &gt; PAIRING</strong> and enter the 6-character code it shows below.</p>
                   {error && <div className="text-red-500 text-sm bg-red-50 p-3 rounded-xl">{error}</div>}
                   <input type="text" placeholder="AB-12-CD" maxLength="8" className="w-full bg-gray-50 px-4 py-4 rounded-xl outline-none font-bold text-center uppercase text-2xl tracking-widest border border-gray-200 focus:border-blue-400" value={pairingCode} onChange={e=>setPairingCode(e.target.value.toUpperCase())} />
                   <button onClick={handlePairingSubmit} disabled={loading} className="w-full bg-blue-500 text-white font-bold py-4 rounded-xl shadow-sm mt-4 disabled:bg-blue-300">
                     {loading ? 'Searching for device...' : 'Link Device'}
                   </button>
                   
                   <div className="mt-6 bg-blue-50 border border-blue-200 rounded-xl p-4 text-left shadow-sm">
                     <div className="flex items-start">
                        <div className="shrink-0 mt-0.5">
                           <Info className="w-5 h-5 text-blue-500" />
                        </div>
                        <div className="ml-3">
                           <h3 className="text-sm font-bold text-blue-800">Can't find the Pairing code?</h3>
                           <p className="text-sm text-blue-700 mt-1 leading-relaxed">
                             Make sure your device is up to date. Go to <SettingsIcon className="inline w-4 h-4 align-text-bottom" /> <strong>TOOLS &rarr; UPDATE</strong> to download the latest firmware.
                           </p>
                        </div>
                     </div>
                   </div>
                </div>
             )}

             {step === 'PARENT_ID' && (
                <div className="w-full max-w-sm my-auto space-y-4">
                   <h2 className="text-xl font-bold mb-2">Set Up Parent ID</h2>
                   <p className="text-gray-500 mb-6">This is the ID your child will see when you message them (e.g., MOM0101).</p>
                   {error && <div className="text-red-500 text-sm bg-red-50 p-3 rounded-xl">{error}</div>}
                   <input type="text" placeholder="Dad, Mama or Your Name" maxLength="10" className="w-full bg-gray-50 px-4 py-4 rounded-xl outline-none font-bold uppercase text-lg border border-gray-200 focus:border-blue-400" value={parentName} onChange={e=>setParentName(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
                   <input type="text" placeholder="Birthday PIN (MMDD)" maxLength="4" className="w-full bg-gray-50 px-4 py-4 rounded-xl outline-none font-bold uppercase text-lg border border-gray-200 focus:border-blue-400" value={parentPin} onChange={e=>setParentPin(e.target.value.replace(/\D/g, ''))} />
                   <button onClick={handleParentIdSubmit} disabled={loading} className="w-full bg-blue-500 text-white font-bold py-4 rounded-xl shadow-sm mt-4 disabled:bg-blue-300">
                     {loading ? 'Checking...' : 'Save Parent ID'}
                   </button>
                </div>
             )}

             {step === 'ADD_FRIENDS' && (
                <div className="w-full max-w-sm my-auto space-y-4">
                   <h2 className="text-xl font-bold mb-2">Add Friends</h2>
                   <p className="text-gray-500 mb-6">Enter a friend's User ID to add them to your child's approved list.</p>
                   
                   <ul className="space-y-2 mb-4 text-left">
                     {displayFriends.map((f, i) => (
                       <li key={i} className="font-bold text-gray-700 bg-gray-100 p-3 rounded-xl">
                          {f} {f === parentProfile?.virtualId && <span className="text-xs text-blue-500 font-normal ml-1">(You)</span>}
                       </li>
                     ))}
                   </ul>

                   <div className="flex space-x-2">
                     <input type="text" placeholder="Friend ID" className="flex-1 bg-gray-50 px-4 py-3 rounded-xl outline-none font-bold uppercase border border-gray-200" value={friendId} onChange={e=>setFriendId(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
                     <button onClick={handleAddFriend} className="bg-blue-500 text-white font-bold px-6 rounded-xl">Add</button>
                   </div>
                   
                   <button onClick={onComplete} className="w-full bg-green-500 text-white font-bold py-4 rounded-xl shadow-sm mt-8">Finish Setup</button>
                </div>
             )}

           </div>
        </div>
      );
    }

    // ==============================================
    //           SETTINGS & DEVICE MANAGEMENT
    // ==============================================
    function SettingsView({ user, parentProfile, devices, activeChildId, setActiveChildId, activeDevice, mqttClient, appId, startAddDeviceFlow, childOnlineStatus, deviceWifi }) {
       const [unlinkMode, setUnlinkMode] = useState(false);
       const [unlinkCode, setUnlinkCode] = useState('');
       const [newFriendId, setNewFriendId] = useState('');
       const [newPhrase, setNewPhrase] = useState('');
       const [openFriends, setOpenFriends] = useState(false);
       const [openMessages, setOpenMessages] = useState(false);
       const [openWifi, setOpenWifi] = useState(false);
       const [newSsid, setNewSsid] = useState('');
       const [newWifiPass, setNewWifiPass] = useState('');
       const [revealed, setRevealed] = useState({});
       const [wifiSyncMsg, setWifiSyncMsg] = useState('');

       const currentPhrases = activeDevice?.phrases?.length > 0 ? activeDevice.phrases : defaultPhrases;

       // Two sources, one list. Firestore holds the rows a parent typed (with
       // passwords); the device reports what it really has (SSIDs only). A
       // network the device knows but the app does not is shown as saved on the
       // device, and carries a KEEP marker so saving cannot wipe its password.
       const WIFI_KEEP = String.fromCharCode(0x02);
       const savedNets = activeDevice?.wifiNets || [];
       const reported = (deviceWifi && activeDevice) ? (deviceWifi[activeDevice.id] || []) : [];
       const wifiNets = [
         ...savedNets,
         ...reported
           .filter(ssid => !savedNets.some(n => n.ssid === ssid))
           .map(ssid => ({ ssid, pass: WIFI_KEEP, fromDevice: true })),
       ];

       // Saving writes Firestore first, then pushes to the device. Firestore is
       // the record a parent manages; the device copy is derived from it, so a
       // device that is offline picks the list up whenever it next connects.
       const saveWifiNets = async (nets) => {
         if (!activeDevice) return;
         setWifiSyncMsg('');
         // Only rows with a real password are worth storing; a KEEP row is the
         // device's own and belongs to the device, not to Firestore.
         const persist = nets.filter(n => n.pass !== WIFI_KEEP).map(n => ({ ssid: n.ssid, pass: n.pass }));
         await updateDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'devices', activeDevice.id), { wifiNets: persist });
         try {
           const myID = `${activeDevice.identity.name}${activeDevice.identity.pin}`;
           const plain = nets.flatMap(n => [n.ssid, n.pass]).join(WIFI_US);
           const payload = wifiObfuscate(plain, myID);
           mqttClient.publish(`doorbell/cmd/${activeDevice.hashedId}`, `CMD,SYNC_WIFI,${payload}`, { qos: 1, retain: true });
           setWifiSyncMsg(childOnlineStatus?.[activeDevice.id]
             ? 'Sent to the device.'
             : 'Saved. It will load the next time the device is online.');
         } catch (e) {
           setWifiSyncMsg('Saved, but could not reach the device.');
         }
       };

       const handleAddWifi = async () => {
         const ssid = newSsid.trim();
         if (!ssid) return;
         if (wifiNets.length >= 5) return;
         if (wifiNets.some(n => n.ssid === ssid)) return setWifiSyncMsg('That network is already saved.');
         await saveWifiNets([...wifiNets, { ssid, pass: newWifiPass }]);
         setNewSsid(''); setNewWifiPass('');
       };

       const handleRemoveWifi = async (ssid) => {
         if (!window.confirm(`Remove "${ssid}" from this device?`)) return;
         await saveWifiNets(wifiNets.filter(n => n.ssid !== ssid));
       };

       // ---------- ACCOUNT DELETION ----------
       // Required by App Store guideline 5.1.1(v): an app that creates accounts
       // must let people delete them from inside it.
       //
       // Deletes in a deliberate ORDER. Firestore data goes first, while the
       // user is still authenticated -- once the auth account is gone the
       // security rules reject their own writes and the data is orphaned with
       // no way to reach it. The auth account is destroyed last.
       //
       // Devices are unpaired before anything else. A device whose records
       // vanish but which was never told keeps its name and PIN, so friends'
       // devices carry on publishing to an identity nobody is listening on and
       // the messages just disappear -- the same failure unlinking was written
       // to avoid.
       const [deleting, setDeleting] = useState('');

       const deleteAllIn = async (path) => {
         const snap = await getDocs(collection(db, path));
         // Firestore caps a batch at 500 writes.
         for (let i = 0; i < snap.docs.length; i += 400) {
           const batch = writeBatch(db);
           snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
           await batch.commit();
         }
         return snap.size;
       };

       const handleDeleteAccount = async () => {
         if (!window.confirm(
           "Delete your account?\n\n" +
           "This unpairs every Dot Dash device, erases your message history, and " +
           "removes your parent ID. It cannot be undone."
         )) return;
         const typed = window.prompt('This is permanent.\n\nType DELETE to confirm:');
         if (typed !== 'DELETE') return;

         const base = `artifacts/${appId}/users/${user.uid}`;
         try {
           // 1. Release the hardware while we still know each device's hash.
           setDeleting('Unpairing devices...');
           for (const d of devices) {
             try {
               mqttClient?.publish(`doorbell/cmd/${d.hashedId}`, 'CMD,UNPAIR', { qos: 1, retain: true });
               // Drop this device's retained alerts too, or they outlive the account.
               ['battery', 'wifi'].forEach(k =>
                 mqttClient?.publish(`doorbell/monitor/${d.hashedId}/${k}`, '', { retain: true }));
               await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'identities', d.hashedId));
             } catch (e) {}
           }

           setDeleting('Erasing your data...');
           await deleteAllIn(`${base}/devices`);
           await deleteAllIn(`${base}/messages`);
           await deleteAllIn(`${base}/pushTokens`);
           try { await deleteDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'profile', 'parent')); } catch (e) {}
           if (parentProfile?.virtualId) {
             try {
               const pHash = await hashId(parentProfile.virtualId);
               await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'identities', pHash));
             } catch (e) {}
           }

           // 2. The account itself, last.
           setDeleting('Closing your account...');
           try {
             await deleteUser(auth.currentUser);
           } catch (e) {
             // Firebase refuses to delete an account authenticated a while ago.
             // Asking for the password here is the standard remedy -- and it is
             // a reasonable thing to require before destroying an account.
             if (e.code === 'auth/requires-recent-login') {
               const pw = window.prompt('For security, please re-enter your password to finish deleting your account:');
               if (!pw) { setDeleting(''); return alert('Account not deleted. Your data has been removed; sign in again to finish.'); }
               const cred = EmailAuthProvider.credential(auth.currentUser.email, pw);
               await reauthenticateWithCredential(auth.currentUser, cred);
               await deleteUser(auth.currentUser);
             } else {
               throw e;
             }
           }

           try { localStorage.removeItem('dotdash_messages'); } catch (e) {}
           try { localStorage.removeItem('dotdash_monitor'); } catch (e) {}
           try { localStorage.removeItem(PUSH_ID_KEY); } catch (e) {}
           setDeleting('');
           alert('Your account has been deleted.');
         } catch (e) {
           setDeleting('');
           alert(`Could not finish deleting your account: ${e.message}`);
         }
       };

       const handleLogout = () => { if(window.confirm("Are you sure you want to log out?")) signOut(auth); };

       // Background notifications. The toggle is the only way in, because iOS
       // only grants permission from inside a tap handler -- asking on load
       // fails silently, with no prompt and no error.
       const [pushOn, setPushOn] = useState(false);
       const [pushState, setPushState] = useState({ busy: false, msg: '' });

       useEffect(() => {
         let alive = true;
         webPushState(user?.uid).then((on) => { if (alive) setPushOn(on); });
         return () => { alive = false; };
       }, [user]);

       const handleTogglePush = async () => {
         setPushState({ busy: true, msg: '' });
         try {
           if (pushOn) {
             const r = await disableWebPush(user?.uid);
             setPushOn(false);
             setPushState({ busy: false, msg: r.reason });
           } else {
             const r = await enableWebPush(user?.uid);
             setPushOn(!!r.ok);
             setPushState({ busy: false, msg: r.reason });
           }
         } catch (e) {
           setPushState({ busy: false, msg: `Could not change notifications: ${e.message}` });
         }
       };

       const handleUnlink = async () => {
         if (unlinkCode.toUpperCase() !== activeDevice.pairingCode) return alert("Incorrect pairing code.");
         if (window.confirm("Are you sure you want to unlink this device from your account?")) {
            // Tell the device first, and while we still hold its hash. Removing
            // the records alone left it believing it was still paired: it kept the
            // name and PIN, so every friend's device carried on publishing to an
            // identity nobody was listening on any more, and messages vanished
            // silently. Retained so a device that is switched off is released the
            // next time it connects rather than being orphaned for good.
            try { mqttClient.publish(`doorbell/cmd/${activeDevice.hashedId}`, `CMD,UNPAIR`, {qos: 1, retain: true}); } catch(e){}
            // Drop any retained low-battery alert too. The device clears its own
            // once it is charging, but an unlinked one re-pairs under a new hash
            // and never returns to this topic -- so without this the flag would
            // sit on the broker for good.
            try { mqttClient.publish(`doorbell/monitor/${activeDevice.hashedId}/battery`, "", { retain: true }); } catch(e){}
            await deleteDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'devices', activeDevice.id));
            try { await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'identities', activeDevice.hashedId)); } catch(e){}
            setUnlinkMode(false);
         }
       };

       const handleAddFriend = async () => {
         if (!newFriendId.trim()) return;
         const fId = newFriendId.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
         let updatedFriends = [...new Set([parentProfile.virtualId, ...(activeDevice.friends || [])].filter(Boolean))];
         
         if (!updatedFriends.includes(fId)) {
             updatedFriends.push(fId);
             await updateDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'devices', activeDevice.id), { friends: updatedFriends });
             mqttClient.publish(`doorbell/cmd/${activeDevice.hashedId}`, `CMD,SYNC_FRIENDS,${updatedFriends.join('|')}`, {qos: 1, retain: true});
         }
         setNewFriendId('');
       };

       const handleRemoveFriend = async (fIdToRemove) => {
         if (fIdToRemove === parentProfile.virtualId) return; 
         if (!window.confirm(`Remove ${fIdToRemove} from friends?`)) return;
         let updatedFriends = [...new Set([parentProfile.virtualId, ...(activeDevice.friends || [])].filter(Boolean))];
         updatedFriends = updatedFriends.filter(f => f !== fIdToRemove);
         
         await updateDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'devices', activeDevice.id), { friends: updatedFriends });
         mqttClient.publish(`doorbell/cmd/${activeDevice.hashedId}`, `CMD,SYNC_FRIENDS,${updatedFriends.join('|')}`, {qos: 1, retain: true});
       };

       const handleAddPhrase = async () => {
         if (!newPhrase.trim()) return;
         if (currentPhrases.length >= 20) return alert("Maximum of 20 phrases allowed.");
         const p = newPhrase.trim().toUpperCase();
         let updatedPhrases = [...currentPhrases];
         
         if (!updatedPhrases.includes(p)) {
             updatedPhrases.push(p);
             await updateDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'devices', activeDevice.id), { phrases: updatedPhrases });
             mqttClient.publish(`doorbell/cmd/${activeDevice.hashedId}`, `CMD,SYNC_PHRASES,${updatedPhrases.join('|')}`, {qos: 1, retain: true});
         }
         setNewPhrase('');
       };

       const handleRemovePhrase = async (pToRemove) => {
         if (!window.confirm(`Delete phrase "${pToRemove}"?`)) return;
         let updatedPhrases = currentPhrases.filter(p => p !== pToRemove);
         await updateDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'devices', activeDevice.id), { phrases: updatedPhrases });
         mqttClient.publish(`doorbell/cmd/${activeDevice.hashedId}`, `CMD,SYNC_PHRASES,${updatedPhrases.join('|')}`, {qos: 1, retain: true});
       };


       if (unlinkMode) {
          return (
             <div className="p-6 h-full flex flex-col">
                <button onClick={()=>setUnlinkMode(false)} className="flex items-center text-gray-500 font-bold mb-6"><ArrowLeft className="w-5 h-5 mr-1"/> Back</button>
                <h2 className="text-2xl font-bold mb-4">Unlink Device</h2>
                <p className="text-gray-600 mb-6">Navigate to <SettingsIcon className="inline w-4 h-4 align-text-bottom" /> <strong>TOOLS &gt; PAIRING</strong> on your child's Dot Dash and enter the code below to confirm unlinking.</p>
                <input type="text" placeholder="Pairing Code" className="w-full bg-white px-4 py-4 rounded-xl outline-none font-bold text-center uppercase text-xl tracking-widest border border-gray-200 focus:border-red-400 mb-6" value={unlinkCode} onChange={e=>setUnlinkCode(e.target.value)} />
                <button onClick={handleUnlink} className="w-full py-4 text-white font-bold bg-red-500 rounded-xl shadow-sm active:bg-red-600">Confirm Unlink</button>
                
                <div className="mt-6 bg-blue-50 border border-blue-200 rounded-xl p-4 text-left shadow-sm">
                  <div className="flex items-start">
                     <div className="shrink-0 mt-0.5">
                        <Info className="w-5 h-5 text-blue-500" />
                     </div>
                     <div className="ml-3">
                        <h3 className="text-sm font-bold text-blue-800">Can't find the Pairing code?</h3>
                        <p className="text-sm text-blue-700 mt-1 leading-relaxed">
                          Make sure your device is up to date. Go to <SettingsIcon className="inline w-4 h-4 align-text-bottom" /> <strong>TOOLS &rarr; UPDATE</strong> to download the latest firmware.
                        </p>
                     </div>
                  </div>
                </div>
             </div>
          );
       }

       const displayFriends = [...new Set([parentProfile?.virtualId, ...(activeDevice?.friends || [])].filter(Boolean))];

       return (
         <div className="p-6">
            <div className="flex justify-between items-center mb-6">
               <h1 className="text-3xl font-bold">Settings</h1>
               <button onClick={handleLogout} className="flex items-center px-4 py-2 bg-white text-gray-700 font-bold rounded-full shadow-sm active:bg-gray-100 border border-gray-200">
                  <LogOut className="w-4 h-4 mr-2"/> Logout
               </button>
            </div>

            <div className="bg-white rounded-3xl p-5 shadow-sm border border-gray-100 mb-4">
              <label className="text-xs text-gray-500 font-bold uppercase">Your Virtual ID</label>
              <div className="text-xl font-bold text-blue-600">{parentProfile.virtualId}</div>
            </div>

            <div className="bg-white rounded-3xl p-5 shadow-sm border border-gray-100 mb-6">
              <div className="flex justify-between items-center mb-4 border-b border-gray-100 pb-4">
                 <label className="text-xs text-gray-500 font-bold uppercase">Active Device</label>
                 <select className="bg-gray-50 rounded-lg px-3 py-1 font-bold outline-none border border-gray-200 text-sm" value={activeChildId || ''} onChange={e => setActiveChildId(e.target.value)}>
                   {devices.map(d => <option key={d.id} value={d.id}>{d.identity.name}{d.identity.pin}</option>)}
                 </select>
              </div>
              
              <button onClick={startAddDeviceFlow} className="w-full py-3 bg-blue-50 text-blue-600 font-bold rounded-xl mb-6 flex items-center justify-center active:bg-blue-100"><Plus className="w-5 h-5 mr-1"/> Add another device</button>
              
              {/* Approved Friends (collapsible) */}
              <button onClick={() => setOpenFriends(o => !o)} className={`w-full flex items-center justify-between p-4 bg-blue-50 border border-blue-100 active:bg-blue-100 transition-colors ${openFriends ? 'rounded-t-2xl' : 'rounded-2xl mb-3'}`}>
                 <div className="flex items-center space-x-3 min-w-0">
                    <div className="w-10 h-10 rounded-full bg-blue-500 text-white flex items-center justify-center shrink-0"><Users className="w-5 h-5"/></div>
                    <div className="text-left min-w-0">
                       <div className="font-bold text-gray-800 text-base">Approved Friends</div>
                       <div className="text-xs text-gray-500">{displayFriends.length === 1 ? '1 friend on this device' : `${displayFriends.length} friends on this device`}</div>
                    </div>
                 </div>
                 <div className="flex items-center space-x-2 shrink-0 ml-2">
                    <span className="bg-blue-500 text-white text-xs font-bold min-w-[22px] h-[22px] px-1.5 flex items-center justify-center rounded-full">{displayFriends.length}</span>
                    <svg viewBox="0 0 24 24" className={`w-5 h-5 text-blue-400 transition-transform duration-200 ${openFriends ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                 </div>
              </button>
              {openFriends && (
                <div className="border border-t-0 border-blue-100 rounded-b-2xl bg-white p-4 mb-3">
                  <ul className="space-y-2 mb-4">
                    {displayFriends.map((f, i) => (
                       <li key={i} className="flex justify-between items-center bg-gray-50 p-3 rounded-xl border border-gray-100">
                         <span className="font-bold text-gray-700 min-w-0 truncate">
                            {f} {f === parentProfile.virtualId && <span className="text-xs text-blue-500 font-normal ml-2">(You)</span>}
                         </span>
                         {f !== parentProfile.virtualId && (
                             <button onClick={() => handleRemoveFriend(f)} className="text-red-400 hover:text-red-600 p-1 ml-2 shrink-0 active:scale-95 transition-transform">
                               <Trash2 className="w-5 h-5"/>
                             </button>
                         )}
                       </li>
                    ))}
                  </ul>
                  <div className="flex space-x-2">
                     <input type="text" placeholder="Friend ID" className="flex-1 min-w-0 bg-gray-50 px-4 py-2 rounded-xl outline-none uppercase font-bold border border-gray-200" value={newFriendId} onChange={e=>setNewFriendId(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}/>
                     <button onClick={handleAddFriend} className="shrink-0 bg-blue-500 text-white px-5 py-2 font-bold rounded-xl active:bg-blue-600">Add</button>
                  </div>
                </div>
              )}

              {/* Custom Messages (collapsible) */}
              <button onClick={() => setOpenMessages(o => !o)} className={`w-full flex items-center justify-between p-4 bg-indigo-50 border border-indigo-100 active:bg-indigo-100 transition-colors ${openMessages ? 'rounded-t-2xl' : 'rounded-2xl mb-3'}`}>
                 <div className="flex items-center space-x-3 min-w-0">
                    <div className="w-10 h-10 rounded-full bg-indigo-500 text-white flex items-center justify-center shrink-0"><MessageCircle className="w-5 h-5"/></div>
                    <div className="text-left min-w-0">
                       <div className="font-bold text-gray-800 text-base">Quick Messages</div>
                       <div className="text-xs text-gray-500">{currentPhrases.length === 1 ? '1 saved phrase' : `${currentPhrases.length} saved phrases`}</div>
                    </div>
                 </div>
                 <div className="flex items-center space-x-2 shrink-0 ml-2">
                    <span className="bg-indigo-500 text-white text-xs font-bold min-w-[22px] h-[22px] px-1.5 flex items-center justify-center rounded-full">{currentPhrases.length}</span>
                    <svg viewBox="0 0 24 24" className={`w-5 h-5 text-indigo-400 transition-transform duration-200 ${openMessages ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                 </div>
              </button>
              {openMessages && (
                <div className="border border-t-0 border-indigo-100 rounded-b-2xl bg-white p-4 mb-3">
                  <ul className="space-y-2 mb-4">
                    {currentPhrases.map((p, i) => (
                       <li key={i} className="flex justify-between items-center bg-gray-50 p-3 rounded-xl border border-gray-100">
                         <span className="font-bold text-gray-700 text-sm min-w-0 truncate">{p}</span>
                         <button onClick={() => handleRemovePhrase(p)} className="text-red-400 hover:text-red-600 p-1 ml-2 shrink-0 active:scale-95 transition-transform">
                           <Trash2 className="w-5 h-5"/>
                         </button>
                       </li>
                    ))}
                  </ul>
                  <div className="flex space-x-2">
                     <input type="text" placeholder="New message..." maxLength="20" className="flex-1 min-w-0 bg-gray-50 px-4 py-2 rounded-xl outline-none uppercase font-bold border border-gray-200" value={newPhrase} onChange={e=>setNewPhrase(e.target.value.toUpperCase())}/>
                     <button onClick={handleAddPhrase} disabled={currentPhrases.length >= 20} className="shrink-0 bg-indigo-500 text-white px-5 py-2 font-bold rounded-xl active:bg-indigo-600 disabled:bg-indigo-300">Add</button>
                  </div>
                </div>
              )}

              {/* Wi-Fi networks (collapsible) */}
              <button onClick={() => setOpenWifi(o => !o)} className={`w-full flex items-center justify-between p-4 bg-teal-50 border border-teal-100 active:bg-teal-100 transition-colors ${openWifi ? 'rounded-t-2xl' : 'rounded-2xl mb-3'}`}>
                 <div className="flex items-center space-x-3 min-w-0">
                    <div className="w-10 h-10 rounded-full bg-teal-500 text-white flex items-center justify-center shrink-0"><Wifi className="w-5 h-5"/></div>
                    <div className="text-left min-w-0">
                       <div className="font-bold text-gray-800 text-base">Wi-Fi Networks</div>
                       <div className="text-xs text-gray-500">{wifiNets.length === 1 ? '1 network saved' : `${wifiNets.length} networks saved`}</div>
                    </div>
                 </div>
                 <div className="flex items-center space-x-2 shrink-0 ml-2">
                    <span className="bg-teal-500 text-white text-xs font-bold min-w-[22px] h-[22px] px-1.5 flex items-center justify-center rounded-full">{wifiNets.length}</span>
                    <svg viewBox="0 0 24 24" className={`w-5 h-5 text-teal-400 transition-transform duration-200 ${openWifi ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                 </div>
              </button>
              {openWifi && (
                <div className="border border-t-0 border-teal-100 rounded-b-2xl bg-white p-4 mb-3">
                  <p className="text-xs text-gray-500 leading-relaxed mb-4">
                    Save up to 5 networks &mdash; home, a second home, a co-parent's house.
                    The device picks whichever it finds, so it works in each place
                    without being set up again.
                  </p>
                  <ul className="space-y-2 mb-4">
                    {wifiNets.map((n) => (
                       <li key={n.ssid} className="flex justify-between items-center bg-gray-50 p-3 rounded-xl border border-gray-100">
                         <div className="min-w-0 flex-1">
                           <div className="font-bold text-gray-700 text-sm truncate">{n.ssid}</div>
                           <div className="flex items-center gap-2 mt-0.5">
                             {n.fromDevice ? (
                               <span className="text-xs text-gray-400 italic truncate">Saved on the device</span>
                             ) : (
                               <>
                                 <span className="text-xs text-gray-400 font-mono truncate">
                                   {revealed[n.ssid] ? (n.pass || '(no password)') : '\u2022'.repeat(Math.min(n.pass?.length || 0, 12) || 4)}
                                 </span>
                                 <button onClick={() => setRevealed(r => ({ ...r, [n.ssid]: !r[n.ssid] }))}
                                   className="text-xs text-teal-600 font-bold shrink-0">
                                   {revealed[n.ssid] ? 'Hide' : 'Show'}
                                 </button>
                               </>
                             )}
                           </div>
                         </div>
                         <button onClick={() => handleRemoveWifi(n.ssid)} className="text-red-400 hover:text-red-600 p-1 ml-2 shrink-0 active:scale-95 transition-transform">
                           <Trash2 className="w-5 h-5"/>
                         </button>
                       </li>
                    ))}
                    {wifiNets.length === 0 && (
                      <li className="text-sm text-gray-400 text-center py-2">No networks saved yet.</li>
                    )}
                  </ul>
                  <div className="space-y-2">
                     <input type="text" placeholder="Network name (SSID)" className="w-full bg-gray-50 px-4 py-2 rounded-xl outline-none font-bold border border-gray-200" value={newSsid} onChange={e=>setNewSsid(e.target.value)}/>
                     <div className="flex space-x-2">
                       <input type="password" placeholder="Password" autoComplete="new-password" className="flex-1 min-w-0 bg-gray-50 px-4 py-2 rounded-xl outline-none border border-gray-200" value={newWifiPass} onChange={e=>setNewWifiPass(e.target.value)}/>
                       <button onClick={handleAddWifi} disabled={wifiNets.length >= 5 || !newSsid.trim()} className="shrink-0 bg-teal-500 text-white px-5 py-2 font-bold rounded-xl active:bg-teal-600 disabled:bg-teal-300">Add</button>
                     </div>
                  </div>
                  {wifiNets.length >= 5 && <p className="text-xs text-gray-400 mt-2">The device holds 5 networks. Remove one to add another.</p>}
                  {wifiSyncMsg && <p className="text-xs text-gray-600 mt-2">{wifiSyncMsg}</p>}
                </div>
              )}

            </div>

            {/* Sits directly above Add to Home Screen on purpose: on iPhone the
                one is a precondition for the other, and a parent who taps this
                from a Safari tab needs the next box to be the answer. */}
            <div className="bg-white rounded-3xl p-5 shadow-sm border border-gray-100 mb-4">
              <h3 className="font-bold text-gray-800 mb-3 text-sm uppercase tracking-wider flex items-center">
                  <Bell className="w-4 h-4 mr-2" /> Notifications
              </h3>
              <div className="flex items-center justify-between gap-4">
                <p className="text-gray-500 text-sm leading-relaxed flex-1">
                    Get alerted when your child messages you, someone new messages
                    them, a timer needs approving, or a battery runs low.
                </p>
                <button
                  role="switch"
                  aria-checked={pushOn}
                  aria-label="Notifications"
                  onClick={handleTogglePush}
                  disabled={pushState.busy}
                  className={`relative shrink-0 w-14 h-8 rounded-full transition-colors duration-200 disabled:opacity-50 ${pushOn ? 'bg-green-500' : 'bg-gray-300'}`}>
                  <span className={`absolute top-1 left-1 w-6 h-6 bg-white rounded-full shadow transition-transform duration-200 ${pushOn ? 'translate-x-6' : 'translate-x-0'}`} />
                </button>
              </div>
              {pushState.busy && <p className="mt-3 text-sm text-gray-400">Working...</p>}
              {pushState.msg && (
                <p className="mt-3 text-sm text-gray-600 leading-snug">{pushState.msg}</p>
              )}
            </div>

            <div className="bg-white rounded-3xl p-5 shadow-sm border border-gray-100 mb-6">
              <h3 className="font-bold text-gray-800 mb-3 text-sm uppercase tracking-wider flex items-center">
                  <Share className="w-4 h-4 mr-2" /> Add to Home Screen (iOS)
              </h3>
              <ol className="list-decimal list-inside text-gray-500 space-y-2 text-sm leading-relaxed">
                  <li>Open the web app url in the Safari browser</li>
                  <li>Tap the Share button at the bottom of the screen</li>
                  <li>Scroll down and select "Add to Home Screen"</li>
              </ol>
            </div>

            {activeDevice && (
              <button onClick={() => setUnlinkMode(true)} className="w-full py-4 text-red-500 font-bold bg-white border border-red-100 rounded-3xl shadow-sm active:bg-red-50">Unlink Device</button>
            )}

            {/* Account deletion. Required by App Store guideline 5.1.1(v), and
                kept plainly visible rather than buried -- a deletion a reviewer
                has to hunt for is treated as not offered. */}
            <div className="mt-6 mb-2">
              <button onClick={handleDeleteAccount} disabled={!!deleting}
                className="w-full py-4 text-white font-bold bg-red-500 rounded-3xl shadow-sm active:bg-red-600 disabled:bg-red-300">
                {deleting || 'Delete My Account'}
              </button>
              <p className="text-xs text-gray-400 mt-2 text-center leading-relaxed">
                Unpairs every device, erases your messages and removes your parent ID.
                This cannot be undone.
              </p>
            </div>
         </div>
       );
    }

    // ==============================================
    //                MAIN APP VIEWS
    // ==============================================
    function ChatView({ unreadByChild = {}, mqttClient, messages, setMessages, parentProfile, devices, activeChildId, setActiveChildId, childOnlineStatus, activeChildLabel }) {
      const [inputText, setInputText] = useState('');
      const messagesEndRef = useRef(null);

      const activeDevice = devices.find(d => d.id === activeChildId);

      const activeMessages = messages.filter(m => 
        (m.isMe && m.target === activeChildLabel) || (!m.isMe && m.sender === activeChildLabel)
      ).sort((a, b) => a.id - b.id);

      useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [activeMessages]);

      const handleSend = async (type = 'MORSE') => {
        if (!mqttClient || !parentProfile?.virtualId || !activeDevice) return;
        let payload = inputText.trim();
        if (!payload) return;
        
        const baseTopic = `doorbell/msg/${activeDevice.hashedId}`;
        const queueTopic = `${baseTopic}/${Date.now()}`;
        const messageString = `${type},${payload},${parentProfile.virtualId}`;

        // Publish ONLY to the per-message queue topic. Its unique id lets the
        // device's persistent replay guard dedupe reliably. (Previously we also
        // published to the id-less base topic, which the device receives via its
        // overlapping `.../#` subscription -- that second copy is only guarded by
        // a 3s window and slips through when message handling blocks, arriving twice.)
        mqttClient.publish(queueTopic, messageString, { qos: 1, retain: true });
        
        setMessages(prev => [...prev, {
          id: Date.now(), type: type, text: payload, sender: parentProfile.virtualId, target: activeChildLabel, isMe: true,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }]);
        setInputText('');
      };

      return (
        <div className="flex flex-col h-full relative">
          <div className="shrink-0 flex space-x-3 overflow-x-auto pb-4 pt-2 hide-scrollbar mb-2 border-b border-gray-200">
            {devices.map(device => {
               const childLabel = `${device.identity.name}${device.identity.pin}`;
               const online = childOnlineStatus[device.id] || false;
               const isActive = activeChildId === device.id;
               return (
                 <button 
                   key={device.id} onClick={() => setActiveChildId(device.id)}
                   className={`px-5 py-2.5 rounded-full font-bold flex flex-shrink-0 items-center space-x-2 transition-all duration-200 shadow-sm ${isActive ? 'bg-blue-500 text-white' : 'bg-white text-gray-500 border border-gray-100'}`}
                 >
                   <span className={`w-2.5 h-2.5 rounded-full ${online ? (isActive ? 'bg-green-300 shadow-[0_0_6px_#86efac]' : 'bg-green-500 shadow-[0_0_6px_#22c55e]') : (isActive ? 'bg-blue-300' : 'bg-gray-300')}`}></span>
                   <span>{displayName(childLabel)}</span>
                   {/* Unread count for this child. Hidden on the chat you are
                       currently looking at, because opening it is what marks it
                       read -- leaving a number on the open conversation would
                       be telling you about messages you can see. */}
                   {!isActive && unreadByChild[childLabel] > 0 && (
                     <span className="bg-red-500 text-white text-xs font-bold min-w-[20px] h-[20px] px-1.5 flex items-center justify-center rounded-full">
                       {unreadByChild[childLabel] > 99 ? '99+' : unreadByChild[childLabel]}
                     </span>
                   )}
                 </button>
               )
            })}
          </div>

          <div className="flex-1 overflow-y-auto space-y-4 pb-4">
            {activeMessages.length === 0 && <p className="text-center text-gray-400 mt-10">No messages yet with {displayName(activeChildLabel)}.</p>}
            {activeMessages.map((msg) => (
              <div key={msg.id} className={`flex flex-col ${msg.isMe ? 'items-end' : 'items-start'}`}>
                <div className={`max-w-[80%] rounded-2xl px-4 py-3 ${msg.isMe ? 'bg-blue-500 text-white' : 'bg-white text-black shadow-sm border border-gray-100'}`}>
                  {msg.type === 'PULSE' && <Volume2 className="inline mr-2 w-5 h-5" />}
                  {(msg.type === 'MORSE' || msg.type === 'TEXT') && <span>{msg.text}</span>}
                </div>
                <span className="text-xs text-gray-400 mt-1 px-1">{msg.timestamp}</span>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          <div className="shrink-0 bg-[#f2f2f7] pt-2 pb-2">
            <div className="flex items-center space-x-2 bg-white rounded-full px-4 py-2 shadow-sm border border-gray-200">
              <input type="text" placeholder="Text Message..." value={inputText} onChange={(e) => setInputText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleSend('MORSE')} className="flex-1 outline-none bg-transparent py-1 text-lg" />
              <button onClick={() => handleSend('MORSE')} disabled={!inputText} className="bg-blue-500 text-white p-2 rounded-full disabled:bg-blue-300 flex-shrink-0 transition-opacity">
                <Send className="w-5 h-5 ml-0.5" />
              </button>
            </div>
          </div>
        </div>
      );
    }

    function MonitorView({ monitorMessages, devices, activeChildId, setActiveChildId, activeChildLabel, pendingApprovals = [], setPendingApprovals, mqttClient, lowBattery = {}, pendingFriendReqs = [], setPendingFriendReqs, user, parentProfile }) {
      const activeMonitorMsgs = monitorMessages.filter(m => m.childMac === activeChildId).sort((a, b) => b.id - a.id);

      // Shown for EVERY linked device, not just the selected one: a flat battery
      // on the child you are not currently looking at is exactly the one you
      // would otherwise miss.
      const lowBatteryDevices = devices.filter(d => lowBattery[d.id]);

      // Only show requests still worth answering. A stranger added through
      // Settings instead of this card leaves the retained topic behind, so drop
      // those here AND clear the slot -- otherwise the card outlives the
      // question it was asking.
      const liveFriendReqs = pendingFriendReqs.filter(req => {
        const dev = devices.find(d => d.id === req.childMac);
        if (dev && (dev.friends || []).includes(req.strangerId)) {
          try { if (mqttClient) mqttClient.publish(req.topic, "", { retain: true }); } catch (e) {}
          return false;
        }
        return true;
      });

      const respondFriendReq = async (req, accept) => {
        if (accept) {
          const dev = devices.find(d => d.id === req.childMac);
          if (dev) {
            // Same shape as adding a friend by hand in Settings: the parent's own
            // id is always kept in the list, then the write and the device push.
            const updatedFriends = [...new Set([parentProfile?.virtualId, ...(dev.friends || [])].filter(Boolean))];
            if (!updatedFriends.includes(req.strangerId)) {
              updatedFriends.push(req.strangerId);
              try {
                await updateDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'devices', dev.id), { friends: updatedFriends });
                if (mqttClient) mqttClient.publish(`doorbell/cmd/${dev.hashedId}`, `CMD,SYNC_FRIENDS,${updatedFriends.join('|')}`, { qos: 1, retain: true });
              } catch (e) {}
            }
          }
        }
        // Clear the retained request either way -- declining is an answer too,
        // and an unanswered slot would re-surface on the next app load.
        try { if (mqttClient) mqttClient.publish(req.topic, "", { retain: true }); } catch (e) {}
        setPendingFriendReqs(prev => prev.filter(r => !(r.childMac === req.childMac && r.strangerId === req.strangerId)));
      };

      const respondApproval = (appr, grant) => {
        if (mqttClient && typeof mqttClient.publish === 'function') {
          const cmd = grant ? `CMD,GRANT_TIMER,${appr.points},${appr.reqId}` : `CMD,DENY_TIMER,${appr.reqId}`;
          mqttClient.publish(`doorbell/cmd/${appr.childHash}`, cmd, { qos: 1, retain: true });
          mqttClient.publish(appr.topic, "", { retain: true }); // clear the retained request
        }
        setPendingApprovals(prev => prev.filter(p => p.reqId !== appr.reqId));
      };

      return (
        <div className="flex flex-col h-full overflow-hidden">
          <h1 className="text-3xl font-bold mb-4 shrink-0 px-2">Monitor Mode</h1>

          {lowBatteryDevices.length > 0 && (
            <div className="shrink-0 space-y-3 mb-4 px-2">
              {lowBatteryDevices.map(d => (
                <div key={d.id} className="bg-white rounded-2xl p-4 shadow-md border-2 border-red-300">
                  <div className="flex items-center space-x-2 mb-2 text-red-600 font-bold text-sm">
                    <BatteryLow className="w-5 h-5" />
                    <span>Low battery</span>
                  </div>
                  <p className="text-black leading-snug">
                    <span className="font-bold text-indigo-600">{displayName(`${d.identity.name}${d.identity.pin}`)}</span>{' '}
                    needs charging. The battery icon is blinking on the device.
                  </p>
                  {/* No dismiss button, on purpose. The device owns this warning
                      and withdraws it itself once it is charging, so a parent
                      cannot swipe away a problem that is still real. */}
                  <p className="text-gray-400 text-xs mt-2">Clears on its own once it's plugged in.</p>
                </div>
              ))}
            </div>
          )}

          {liveFriendReqs.length > 0 && (
            <div className="shrink-0 space-y-3 mb-4 px-2">
              {liveFriendReqs.map(req => (
                <div key={req.childMac + req.strangerId} className="bg-white rounded-2xl p-4 shadow-md border-2 border-sky-300">
                  <div className="flex items-center space-x-2 mb-2 text-sky-600 font-bold text-sm">
                    <UserPlus className="w-5 h-5" />
                    <span>New friend request</span>
                  </div>
                  <p className="text-black mb-3 leading-snug">
                    <span className="font-bold text-gray-700">{displayName(req.strangerId)}</span> sent a message to{' '}
                    <span className="font-bold text-indigo-600">{displayName(req.childLabel)}</span>, but isn't on their
                    friends list.
                    <br/>Add them as a friend?
                    <br/><span className="text-xs text-gray-400">Full ID: {req.strangerId}</span>
                  </p>
                  <div className="flex space-x-3">
                    <button onClick={() => respondFriendReq(req, true)}
                      className="flex-1 flex items-center justify-center space-x-2 bg-sky-500 active:bg-sky-600 text-white font-bold py-3 rounded-xl shadow-sm">
                      <CheckCircle2 className="w-5 h-5" />
                      <span>Add friend</span>
                    </button>
                    <button onClick={() => respondFriendReq(req, false)}
                      className="flex-1 flex items-center justify-center space-x-2 bg-gray-100 active:bg-gray-200 text-gray-600 font-bold py-3 rounded-xl border border-gray-200">
                      <X className="w-5 h-5" />
                      <span>Ignore</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {pendingApprovals.length > 0 && (
            <div className="shrink-0 space-y-3 mb-4 px-2">
              {pendingApprovals.map(appr => (
                <div key={appr.reqId} className="bg-white rounded-2xl p-4 shadow-md border-2 border-amber-300">
                  <div className="flex items-center space-x-2 mb-2 text-amber-600 font-bold text-sm">
                    <Clock className="w-5 h-5" />
                    <span>Timer completed</span>
                  </div>
                  <p className="text-black mb-3 leading-snug">
                    <span className="font-bold text-indigo-600">{displayName(appr.childLabel)}</span> finished a{' '}
                    <span className="font-bold">{appr.minutes}-minute</span> focus timer.
                    <br/>Grant <span className="font-bold">{appr.points} point{appr.points > 1 ? 's' : ''}</span>?
                  </p>
                  <div className="flex space-x-3">
                    <button onClick={() => respondApproval(appr, true)}
                      className="flex-1 flex items-center justify-center space-x-2 bg-green-500 active:bg-green-600 text-white font-bold py-3 rounded-xl shadow-sm">
                      <CheckCircle2 className="w-5 h-5" />
                      <span>Approve +{appr.points}</span>
                    </button>
                    <button onClick={() => respondApproval(appr, false)}
                      className="flex-1 flex items-center justify-center space-x-2 bg-gray-100 active:bg-gray-200 text-gray-600 font-bold py-3 rounded-xl border border-gray-200">
                      <X className="w-5 h-5" />
                      <span>Deny</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="shrink-0 flex space-x-3 overflow-x-auto pb-4 hide-scrollbar mb-2 border-b border-gray-200 px-2">
            {devices.map(device => {
               const childLabel = `${device.identity.name}${device.identity.pin}`;
               const isActive = activeChildId === device.id;
               return (
                 <button 
                   key={device.id} onClick={() => setActiveChildId(device.id)}
                   className={`px-5 py-2.5 rounded-full font-bold flex flex-shrink-0 items-center space-x-2 transition-all duration-200 shadow-sm ${isActive ? 'bg-indigo-500 text-white' : 'bg-white text-gray-500 border border-gray-100'}`}
                 >
                   <span>{displayName(childLabel)}</span>
                   {lowBattery[device.id] && <BatteryLow className={`w-4 h-4 ${isActive ? 'text-white' : 'text-red-500'}`} />}
                 </button>
               )
            })}
          </div>

          <div className="flex-1 overflow-y-auto space-y-4 pb-4 pt-2 px-2">
            {activeMonitorMsgs.length === 0 && (
               <div className="text-center mt-10">
                 <Shield className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                 <p className="text-gray-400">Monitoring is active.<br/>Intercepted messages will appear here.</p>
               </div>
            )}
            
            {activeMonitorMsgs.map((msg) => {
              const isOutgoing = msg.direction === 'out';
              return (
                <div key={msg.id} className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center space-x-2 text-sm font-bold">
                       {isOutgoing ? (
                         <>
                           <span className="text-indigo-600">{displayName(activeChildLabel)}</span>
                           <ArrowRight className="w-4 h-4 text-gray-400" />
                           <span className="text-gray-500 italic">{displayName(msg.otherParty)}</span>
                         </>
                       ) : (
                         <>
                           <span className="text-gray-600">{displayName(msg.otherParty)}</span>
                           <ArrowRight className="w-4 h-4 text-gray-400" />
                           <span className="text-green-600">{displayName(activeChildLabel)}</span>
                         </>
                       )}
                    </div>
                    <span className="text-xs text-gray-400">{msg.timestamp}</span>
                  </div>
                  
                  <div className={`p-3 rounded-xl text-black ${isOutgoing ? 'bg-indigo-50' : 'bg-green-50'}`}>
                    {msg.type === 'PULSE' && <div className="flex items-center text-gray-500"><Volume2 className="w-4 h-4 mr-2" /> Buzz / Notification</div>}
                    {(msg.type === 'MORSE' || msg.type === 'TEXT') && <span>{msg.text}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    function TutorialsView() {
      const [openSet, setOpenSet] = useState({});
      const [stepIdx, setStepIdx] = useState({});
      const toggle = (i) => {
        setOpenSet(prev => ({ ...prev, [i]: !prev[i] }));
        setStepIdx(prev => ({ ...prev, [i]: 0 }));
      };
      const go = (i, delta, len) => setStepIdx(prev => {
        const cur = prev[i] || 0;
        return { ...prev, [i]: Math.max(0, Math.min(len - 1, cur + delta)) };
      });

      // Small inline menu icons that mirror the on-device menu (used via {{env}} / {{gear}} tokens).
      const iconFor = (name) => {
        const cls = "inline w-4 h-4 align-text-bottom text-gray-700";
        if (name === 'env') return <svg viewBox="0 0 24 24" className={cls} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><polyline points="3 7 12 13 21 7"/></svg>;
        if (name === 'gear') return <svg viewBox="0 0 24 24" className={cls} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>;
        if (name === 'dot') return <svg viewBox="0 0 12 12" className="inline w-2.5 h-2.5 mx-1 align-middle text-gray-800" fill="currentColor"><circle cx="6" cy="6" r="4.5"/></svg>;
        if (name === 'dash') return <svg viewBox="0 0 28 12" className="inline w-6 h-2.5 mx-1 align-middle text-gray-800" fill="currentColor"><rect x="1" y="3" width="26" height="6" rx="3"/></svg>;
        return null;
      };

      // Render tutorial text: swap {{icon}} tokens for menu icons and bold ALL-CAPS words.
      const emphasizeCaps = (text) =>
        text.split(/(\{\{\w+\}\}|[A-Z]{2,})/g).map((part, k) => {
          const tok = part.match(/^\{\{(\w+)\}\}$/);
          if (tok) return <span key={k}>{iconFor(tok[1])}</span>;
          if (/^[A-Z]{2,}$/.test(part)) return <strong key={k} className="text-gray-800">{part}</strong>;
          return part;
        });

      // Symbol shown in each tutorial's collapsible title bar.
      const titleIcon = (name) => {
        if (name === 'env') return <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><polyline points="3 7 12 13 21 7"/></svg>;
        if (name === 'morse') return <svg viewBox="0 0 24 24" className="w-6 h-6" fill="currentColor"><circle cx="5" cy="12" r="2.6"/><rect x="10" y="9.4" width="11" height="5.2" rx="2.6"/></svg>;
        if (name === 'joystick') return <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="5" r="2.6"/><line x1="12" y1="7.6" x2="12" y2="15"/><path d="M7 20 L9 15 L15 15 L17 20 Z"/></svg>;
        if (name === 'rss') return <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="5" cy="19" r="1.9" fill="currentColor" stroke="none"/><path d="M5 13 A 6 6 0 0 1 11 19"/><path d="M5 9 A 10 10 0 0 1 15 19"/></svg>;
        return null;
      };

      const renderBullets = (bullets) => (
        <ul className="text-gray-500 space-y-2 text-sm leading-relaxed">
          {bullets.map((bullet, j) => {
            const splitIndex = bullet.indexOf(':');
            if (splitIndex > -1) {
              return <li key={j} className="flex items-start"><span className="mr-2 mt-1 text-blue-500 text-xs">●</span><span><strong className="text-gray-700">{bullet.substring(0, splitIndex + 1)}</strong>{emphasizeCaps(bullet.substring(splitIndex + 1))}</span></li>;
            }
            return <li key={j} className="flex items-start"><span className="mr-2 mt-1 text-blue-500 text-xs">●</span><span>{emphasizeCaps(bullet)}</span></li>;
          })}
        </ul>
      );

      const tutorials = [
        {
          title: "Sending a Quick Message",
          icon: "env",
          steps: [
            { text: "From the clock screen, tap the front SELECT button to move through the menu, and the top ENTER button to choose an option." },
            { text: "Open {{env}} SEND, then tap SELECT to scroll to the friend you want and ENTER to pick them." },
            { text: "Choose <QUICK> with ENTER (or <DOT DASH> to type your own in Morse code)." },
            { text: "Tap SELECT to browse the pre-written messages, then tap ENTER to send." }
          ]
        },
        {
          title: "Dot Dash Mode",
          icon: "morse",
          steps: [
            { text: "Open SEND, pick a friend, then choose <DOT DASH> to start typing in Morse code." },
            { title: "Dots & dashes", bullets: [ "Dot: {{dot}} short tap the front SELECT button.", "Dash: {{dash}} long-press the front SELECT button." ] },
            { title: "Building words", bullets: [ "Commit a letter: tap the top ENTER button.", "Add a space: tap ENTER on its own.", "Delete: tap ENTER twice quickly." ] },
            { title: "Send it", text: "When your message is ready, long-press ENTER to send." }
          ]
        },
        {
          title: "How Points Work",
          icon: "joystick",
          steps: [
            { text: "Points are earned by messaging friends and spent to unlock arcade games. They're your child's private balance — not a score or competition." },
            { title: "Earning by sending", bullets: [ "Pre-written message: 1 point.", "Dot Dash message: 2 points when it uses at least 3 different characters, otherwise 1 point.", "Counts for up to 2 messages per friend each day.", "Up to 5 sent messages earn points per day." ] },
            { title: "Earning by replying", bullets: [ "Replying to an Inbox message earns 3 points — the most valuable way to earn.", "Only for messages received in the last 24 hours.", "Only once per message.", "No per-friend limit — a real back-and-forth conversation is fully rewarded.", "Up to 5 replies earn points per day." ] },
            { title: "Fair-play safeguards", bullets: [ "A short wait (about 30 seconds) between messages that earn points.", "Sending the exact same message twice in a row only earns once.", "Daily maximum: roughly 25 points." ] },
            { title: "Spending on the arcade", bullets: [ "Counter: 2 points", "Bird: 4 points", "Jumper: 6 points", "Dasher: 8 points", "Defender: 10 points", "Train and the Leaderboards are always free." ] },
            { title: "How unlocking works", bullets: [ "Opening a locked game asks your child to confirm (Yes / No); Yes spends the points.", "Once unlocked, the game stays open for the rest of the day.", "Every day the games re-lock, so points are spent fresh each day.", "If your child doesn't have enough points, the device says so." ] }
          ]
        },
        {
          title: "Changing Wi-Fi Networks",
          icon: "rss",
          steps: [
            { text: "Moving your Dot Dash somewhere new? Add the new network from your phone — the Dot Dash remembers up to five, and picks whichever one it finds." },
            { title: "Step 1", text: "On your Dot Dash, open {{gear}} TOOLS and select WIFI (shown as DOT DASH SETUP on devices that haven't updated yet)." },
            { title: "Step 2", text: "On your phone, open Wi-Fi settings and join the network called Dot Dash Setup." },
            { title: "Step 3", text: "A setup page should pop up automatically. If it doesn't, open a browser and go to 192.168.4.1." },
            { title: "Step 4", text: "Pick your new Wi-Fi network, enter the password, and tap Connect & Restart." },
            { title: "Good to know", text: "Old networks are kept, not replaced. Back at a previous location, the Dot Dash reconnects on its own." }
          ]
        }
      ];

      return (
        <div className="space-y-6 px-2">
          <img
            src="https://raw.githubusercontent.com/sammyb-clouds/dot-dash-parent/main/dotdashkey.jpg"
            alt="Dot Dash Morse code key"
            className="w-full rounded-2xl shadow-sm mb-4"
          />
          <h1 className="text-3xl font-bold mb-4">Tutorials</h1>

          <div className="space-y-3">
            {tutorials.map((tut, i) => {
              const isOpen = !!openSet[i];
              const steps = tut.steps;
              const cur = Math.min(stepIdx[i] || 0, steps.length - 1);
              const card = steps[cur];
              return (
                <div key={i} className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
                  <button onClick={() => toggle(i)} className="w-full flex items-center justify-between px-5 py-4 text-left active:bg-gray-50 transition-colors">
                    <span className="flex items-center gap-2.5 min-w-0">
                      {tut.icon && <span className="text-blue-500 shrink-0">{titleIcon(tut.icon)}</span>}
                      <span className="font-bold text-lg text-gray-900">{tut.title}</span>
                    </span>
                    <svg viewBox="0 0 24 24" className={`w-5 h-5 text-gray-400 shrink-0 ml-3 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                  </button>

                  {isOpen && (
                    <div className="px-4 pb-4">
                      <div className="bg-gray-50 rounded-2xl border border-gray-100 p-4 min-h-[96px]">
                        {card.title && <h4 className="font-bold text-gray-800 text-sm mb-2">{card.title}</h4>}
                        {card.text && <p className="text-gray-600 text-sm leading-relaxed">{emphasizeCaps(card.text)}</p>}
                        {card.bullets && renderBullets(card.bullets)}
                      </div>

                      <div className="flex items-center justify-between mt-3 px-1">
                        <button onClick={() => go(i, -1, steps.length)} disabled={cur === 0} className={`p-2 rounded-full transition-colors ${cur === 0 ? 'text-gray-200' : 'text-blue-500 active:bg-blue-50'}`}>
                          <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                        </button>
                        <span className="text-xs font-semibold text-gray-400">{cur + 1} / {steps.length}</span>
                        <button onClick={() => go(i, 1, steps.length)} disabled={cur === steps.length - 1} className={`p-2 rounded-full transition-colors ${cur === steps.length - 1 ? 'text-gray-200' : 'text-blue-500 active:bg-blue-50'}`}>
                          <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    function TabButton({ icon, label, active, onClick, badge }) {
      return (
        <button onClick={onClick} className={`relative flex flex-col items-center justify-center w-[60px] space-y-1 transition-colors ${active ? 'text-blue-500' : 'text-gray-400'}`}>
          <div className={`${active ? 'scale-110' : 'scale-100'} transition-transform duration-200`}>
            {icon}
          </div>
          {badge > 0 && (
            <span className="absolute top-[-4px] right-[8px] min-w-[18px] h-[18px] px-1 flex items-center justify-center bg-red-500 text-white text-[10px] font-bold rounded-full shadow">
              {badge > 9 ? '9+' : badge}
            </span>
          )}
          <span className="text-[10px] font-medium">{label}</span>
        </button>
      );
    }

    const root = createRoot(document.getElementById('root'));
    root.render(<App />);
  