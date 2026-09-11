/*
 * Service worker for Web Push.
 *
 * Deliberately NOT the Firebase messaging SDK. The usual firebase-messaging-sw
 * pulls two compat bundles from gstatic via importScripts, which would put back
 * the CDN dependency the build just removed. FCM delivers a plain Web Push
 * event, so a handful of lines of standard Push API does the same job with
 * nothing to download.
 *
 * This file CANNOT be inlined into index.html: a service worker has to be its
 * own file, served from a path whose scope covers the page. That is why the
 * deploy is more than one file now.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { notification: { title: 'Dot Dash', body: event.data ? event.data.text() : '' } };
  }

  const n = payload.notification || {};
  const d = payload.data || {};
  const title = n.title || d.title || 'Dot Dash';

  event.waitUntil(
    self.registration.showNotification(title, {
      body: n.body || d.body || '',
      icon: '/icon.jpg',
      badge: '/icon.jpg',
      // Collapse repeats of the same kind for the same child rather than
      // stacking them: a device that keeps reporting a flat battery should
      // leave one notification, not twelve.
      tag: d.kind && d.child ? `${d.kind}:${d.child}` : undefined,
      renotify: false,
      data: d,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Land on the tab that answers the alert rather than the home screen.
  const target = event.notification.data && event.notification.data.link
    ? event.notification.data.link
    : '/test.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
