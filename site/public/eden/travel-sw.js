// Ask Eden Travel offline (registered by travel.js, only on its own address: askedentravel.com). The app's own files and
// the trip's map pictures and place photos are kept, so the app opens and the trip (saved by travel.js on the device)
// shows with no signal. Nothing else from the server is kept: no API answers, no sign-in; the only private thing kept is the person's own
// documents, on their own device.
//   pages: the network first, the kept copy when there's none
//   the app's files: the network first, the kept copy with no signal
//   /api/chat/travel/map and /photo: kept after the first look (a picture of a place doesn't change)
//   /api/chat/travel/doc: the person's own documents, the network first, the kept copy only with no signal (security
//     review M4: the server decides who sees one, so a signed-out browser or a deleted document is never answered
//     from here); gone on any sign-out (travel-privacy.js), on a 401, and one by one when the server no longer has it
const CACHE = 'eden-travel-v7';
const PICTURES = /^\/api\/chat\/travel\/(map|photo)$/;
// a stop's documents (tickets, passes): kept on the device once seen, for no signal; a document never changes (its id is
// new each time), and every sign-out deletes them (travel-privacy.js)
const DOCS = 'eden-travel-docs';
const DOC = /^\/api\/chat\/travel\/doc$/;

/** The server said no: signed out (401), every private thing kept goes; gone (403, 404, 410), that one copy goes. */
async function refused(res, cache, req) {
  try {
    if (res.status === 401) { for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k); const c = await caches.open(CACHE); for (const k of await c.keys()) if (PICTURES.test(new URL(k.url).pathname)) await c.delete(k); }
    else if ([403, 404, 410].includes(res.status)) await (cache || (await caches.open(CACHE))).delete(req);
  } catch { /* nothing kept */ }
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE && k !== DOCS) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // the app's page: only the front (/) is kept, never another page or a sign-in step
    e.respondWith(fetch(req).then((res) => {
      if (res.ok && url.pathname === '/') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); }
      return res;
    }).catch(async () => (await caches.match('/')) || Response.error()));
    return;
  }
  if (DOC.test(url.pathname)) {
    e.respondWith(caches.open(DOCS).then((c) => fetch(req).then(async (res) => {
      if (res.ok) await c.put(req, res.clone());
      else await refused(res, c, req);
      return res;
    }, async () => (await c.match(req)) || Response.error()))); // no signal: the kept copy
    return;
  }
  if (PICTURES.test(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then(async (res) => {
      if (!res.ok) await refused(res, null, req);
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(async (c) => { await c.put(req, copy); const keys = (await c.keys()).filter((k) => PICTURES.test(new URL(k.url).pathname)); for (const k of keys.slice(0, Math.max(0, keys.length - 120))) await c.delete(k); }); } // the latest 120 pictures
      return res;
    })));
    return;
  }
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/t/') || url.pathname.startsWith('/f/') || url.pathname.startsWith('/c/')) return;
  // the app's own files (scripts, styles, icons): the network first, the kept copy only with no signal. Kept-first would
  // mix versions right after a deploy (a fresh page with old modules: the kind of blank app seen on 2026-10-20)
  if (!/\.(js|css|svg|png|jpg|woff2?)$/.test(url.pathname)) return;
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(async () => (await caches.match(req)) || Response.error()));
});
