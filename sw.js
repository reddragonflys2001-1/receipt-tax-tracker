const CACHE='receipt-tax-tracker-drive-v2';
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['./','./index.html','./styles.css','./app.js','./manifest.webmanifest']))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))));
self.addEventListener('fetch', event => { if (event.request.url.startsWith(self.location.origin)) event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request))); });
