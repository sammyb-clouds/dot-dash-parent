// Service worker for the web-link chat page (/c/). Only shows notifications;
// it caches nothing, so a deploy is never hidden behind a stale copy.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Always show one: iOS revokes a push subscription that receives pushes
// without a visible notification, and the tag replaces rather than stacks.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(self.registration.showNotification(d.title || 'Dot Dash', {
    body: d.body || 'New message',
    tag: d.tag || 'dotdash',
    renotify: true,
    icon: '/icon.png',
    badge: '/icon.png',
    data: { chat: d.chat || null },
  }));
});

// Open the chat the notification is about. With the page already open, tell
// it which chat (it may hold several) and bring it forward; otherwise open
// /c/#chat=<id>, which the page resolves from the chats it has saved.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const chat = e.notification.data && e.notification.data.chat;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (c.url.includes('/c/') && 'focus' in c) {
        if (chat) c.postMessage({ openChat: chat });
        return c.focus();
      }
    }
    return self.clients.openWindow(chat ? `/c/#chat=${chat}` : '/c/');
  }));
});
