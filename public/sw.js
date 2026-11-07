// DarkLion Service Worker — minimal, no caching
// Just enough for iOS to treat this as an installable PWA

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
self.addEventListener('fetch', () => {}); // pass-through, no caching
