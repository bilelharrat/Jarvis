// Eden Code on the phone's service worker (features/code_phone.py): what makes the page an
// app on the Home Screen. It keeps only the page's own files, to open with no network (the
// page then says it can't reach the Mac); every /api call goes to the Mac as it is, never
// kept, and a newer page is taken whenever the Mac is reachable.
'use strict';

const CACHE = 'eden-code-phone-v1';
const SHELL = ['/code/', '/code/phone.js', '/code/phone.css', '/code/manifest.webmanifest', '/code/icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return;
  event.respondWith(
    fetch(event.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {}); }
      return res;
    }).catch(() => caches.match(event.request).then((hit) => hit || Response.error())),
  );
});
