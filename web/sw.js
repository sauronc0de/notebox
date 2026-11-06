// Network-first service worker: always fresh when the server is reachable,
// cached shell + last API responses when it is not.
const SHELL_CACHE = 'notebox-shell-v2';
const API_CACHE = 'notebox-api-v1';
const SHELL = [
  '/', '/style.css', '/manifest.webmanifest',
  '/js/app.js', '/js/api.js', '/js/md.js', '/js/ui.js', '/js/util.js',
  '/icons/icon.svg', '/icons/icon-192.png',
  '/fonts/space-grotesk-400.woff2', '/fonts/space-grotesk-500.woff2', '/fonts/space-grotesk-600.woff2', '/fonts/space-grotesk-700.woff2',
  '/fonts/jetbrains-mono-400.woff2', '/fonts/jetbrains-mono-500.woff2', '/fonts/jetbrains-mono-700.woff2',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== API_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const isApi = url.pathname.startsWith('/api/');
  const cacheable = !isApi || !(url.searchParams.has('search') || url.pathname === '/api/export');

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok && cacheable) {
        const copy = response.clone();
        caches.open(isApi ? API_CACHE : SHELL_CACHE).then(cache => cache.put(isApi ? request : url.pathname, copy));
      }
      return response;
    } catch (err) {
      if (!isApi) {
        const cached = await caches.match(url.pathname, { cacheName: SHELL_CACHE }) || (request.mode === 'navigate' && await caches.match('/', { cacheName: SHELL_CACHE }));
        if (cached) return cached;
        throw err;
      }
      const cached = await caches.match(request, { cacheName: API_CACHE });
      if (!cached) throw err;
      const headers = new Headers(cached.headers);
      headers.set('X-Notebox-Offline', '1');
      return new Response(await cached.blob(), { status: cached.status, headers });
    }
  })());
});
