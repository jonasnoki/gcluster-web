/* gcluster service worker: cache the app shell. Data comes from Supabase;
 * the app keeps its own offline copy in localStorage. */
// Replaced on each deploy (scripts/deploy-web.sh).
const VERSION = 'gcluster-1.2.0-f164d8c';
const SHELL = [
  './', 'index.html', 'version.js', 'config.js', 'backend.js', 'schedule.js', 'app.js', 'style.css', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

// cache: 'reload' / 'no-cache' skip the browser HTTP cache (GitHub Pages sends
// max-age=600); otherwise a new version can store the old files.
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      // Only our own old caches: other apps on jonasnoki.github.io share this origin.
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('gcluster-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function shellFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req, { ignoreSearch: true });
  const update = fetch(req, { cache: 'no-cache' }).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  if (hit) {
    update.catch(() => {});
    return hit;
  }
  return update;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // Only the app's own files; API calls always go to the network.
  // cache: 'no-store' (the update check in app.js) always goes to the network.
  if (req.cache === 'no-store') return;
  if (new URL(req.url).origin === self.location.origin) e.respondWith(shellFirst(req));
});

// Medication reminders from the `remind` function (Web Push).
self.addEventListener('push', (e) => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch (err) { msg = { title: 'gcluster', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(msg.title || 'gcluster', {
    body: msg.body || '',
    tag: msg.tag, // a later reminder for the same dose replaces the earlier one
    renotify: !!msg.tag,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    data: { url: msg.url || './#/meds' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data && e.notification.data.url || './#/meds', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope)) return c.focus().then(() => c.navigate(url));
    }
    return self.clients.openWindow(url);
  }));
});
