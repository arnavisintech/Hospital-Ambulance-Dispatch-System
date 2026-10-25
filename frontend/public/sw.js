/* HADS service worker: offline app shell so the SOS screen opens without a connection (requests made offline are
   queued by the app itself, lib/queue.ts, and sent when the connection returns).
   - Navigations: network first, falling back to the cached /index.html.
   - /assets/* (content-hashed): every asset of this build is precached on install (the build writes the list below,
     src/lib/precache.ts); assets of older builds are pruned on activate. Anything else is cache first at runtime.
   - /api/* and /tiles/*: never cached here - live data must never be served stale from this cache. */
const SHELL = 'hads-shell-v1';
const ASSETS = 'hads-assets-v1';
const PRECACHE = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg', '/icons/icon.svg'];
const BUILD_ASSETS = [] /*__HADS_ASSETS__*/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(SHELL).then((c) => c.addAll(PRECACHE)),
      caches.open(ASSETS).then((c) => c.addAll(BUILD_ASSETS)),
    ]).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))))
      .then(() => (BUILD_ASSETS.length ? pruneAssets() : null))
      .then(() => self.clients.claim()),
  );
});

/** Drop cached assets that are not part of this build (each release would otherwise add to the cache forever). */
function pruneAssets() {
  const keep = new Set(BUILD_ASSETS);
  return caches.open(ASSETS).then((c) => c.keys().then((reqs) =>
    Promise.all(reqs.filter((r) => !keep.has(new URL(r.url).pathname)).map((r) => c.delete(r)))));
}

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
