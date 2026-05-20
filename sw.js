/* Service worker: cache the app shell so the PWA works offline.
   Cache versioning: bump CACHE_NAME to force clients to pull fresh files after deploy. */
const CACHE_NAME = 'tdee-tracker-v2';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './tdee.js',
  './import-health.js',
  './charts.js',
  './export.js',
  './cheat-day.js',
  './backup.js',
  './manifest.json',
  './icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Use Promise.allSettled so a single 404 doesn't fail install
      Promise.all(SHELL.map((url) =>
        cache.add(url).catch(() => null)
      ))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Bypass non-GET and cross-origin CDN requests (Chart.js, JSZip, SheetJS)
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        // Cache successful navigations + same-origin assets
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        }
        return resp;
      }).catch(() => cached); // offline fallback
    })
  );
});
