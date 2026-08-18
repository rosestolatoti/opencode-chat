// NEXUS Service Worker - Cache estático para PWA
const CACHE_NAME = 'nexus-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/static/style.css',
  '/static/app.js',
  '/manifest.json'
];

// Install - cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate - clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch - cache first, network fallback
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  
  // Only handle same-origin requests
  if (url.origin !== location.origin) return;
  
  // Skip non-GET
  if (event.request.method !== 'GET') return;
  
  // Skip API calls and uploads
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/') || url.pathname.startsWith('/ws')) {
    return;
  }
  
  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        if (cached) return cached;
        return fetch(event.request)
          .then(response => {
            if (response.ok && (response.type === 'basic' || response.type === 'cors')) {
              const respClone = response.clone();
              caches.open(CACHE_NAME).then(cache => cache.put(event.request, respClone));
            }
            return response;
          })
          .catch(() => cached);
      })
  );
});