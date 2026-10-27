// Lucid PWA service worker. Scope "/" on lucid.youreasysite.pl.
// The same host also serves the showcase page under /home, and the YES site registers /sw.js
// there too: this worker must therefore leave everything outside the app shell alone.
const CACHE = 'lucid-pwa-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k.startsWith('lucid-pwa-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // model downloads: the library caches them itself

  // App navigation: network first, cached shell offline. /home is the showcase page, not ours.
  if (req.mode === 'navigate') {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      e.respondWith(
        fetch(req)
          .then((r) => {
            const copy = r.clone();
            caches.open(CACHE).then((c) => c.put('/', copy));
            return r;
          })
          .catch(() => caches.match('/')),
      );
    }
    return;
  }

  // Hashed build files under /app/ never change: cache first.
  if (url.pathname.startsWith('/app/') || url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest') {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((r) => {
            const copy = r.clone();
            if (r.ok) caches.open(CACHE).then((c) => c.put(req, copy));
            return r;
          }),
      ),
    );
  }
});
