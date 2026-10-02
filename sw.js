/* gcluster service worker: cache the app shell. Data comes from Supabase;
 * the app keeps its own offline copy in localStorage. */
const VERSION = 'gcluster-v3';
const SHELL = [
  './', 'index.html', 'config.js', 'backend.js', 'app.js', 'style.css', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function shellFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req, { ignoreSearch: true });
  const update = fetch(req).then((res) => {
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
  if (new URL(req.url).origin === self.location.origin) e.respondWith(shellFirst(req));
});
