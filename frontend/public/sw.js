/* HADS service worker: offline app shell so the SOS screen opens without a connection (requests made offline are
   queued by the app itself, lib/queue.ts, and sent when the connection returns).
   - Navigations: network first, falling back to the cached /index.html.
   - /assets/* (content-hashed): cache first, filled at runtime.
   - /api/* and /tiles/*: never cached here - live data must never be served stale from this cache. */
const SHELL = 'hads-shell-v1';
const ASSETS = 'hads-assets-v1';
const PRECACHE = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg', '/icons/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/tiles/')) return; // network only

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put('/index.html', copy)); }
          return res;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(ASSETS).then((c) => c.put(req, copy)); }
        return res;
      })),
    );
  }
});
