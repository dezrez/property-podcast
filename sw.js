/* Service worker: app shell offline + fresh-but-resilient feed. */
const VERSION = 'v1';
const SHELL_CACHE = 'shell-' + VERSION;
const DATA_CACHE = 'data-' + VERSION;

const SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-32.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

const FEED_HOST = 'richiep540.github.io';

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // addAll is all-or-nothing; cache individually so one 404 cannot
      // abort the whole install.
      .then(cache => Promise.all(SHELL.map(url =>
        cache.add(url).catch(() => {})
      )))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(k => k !== SHELL_CACHE && k !== DATA_CACHE)
        .map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never intercept audio: range requests and multi-MB bodies belong to the
  // browser's own media pipeline, not to us.
  if (url.pathname.endsWith('.mp3') || req.destination === 'audio') return;

  // Feed: network first, fall back to the last good copy.
  if (url.hostname === FEED_HOST && url.pathname.endsWith('feed.xml')) {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(DATA_CACHE).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then(hit => hit || Response.error()))
    );
    return;
  }

  // Cover art and other cross-origin GETs: cache first, refresh in background.
  if (url.origin !== self.location.origin) {
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(DATA_CACHE).then(c => c.put(req, copy));
        }
        return res;
      }))
    );
    return;
  }

  // App shell: stale-while-revalidate. Serve the cached copy instantly, but
  // always re-fetch in the background so a redeployed build is picked up on
  // the next launch without needing a VERSION bump.
  event.respondWith(
    caches.match(req).then(hit => {
      const network = fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => {
        if (hit) return hit;
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
      return hit || network;
    })
  );
});
