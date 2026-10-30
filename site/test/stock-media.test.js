// Eden Slides' stock media library on askeden.com (src/eden/stock-media.js; the page is askeden web/chat/deck-media.js):
// signed in, Openverse + Commons merged with licences, rate limits said plainly, files only from the libraries.
// Fake fetch: no Openverse, no Wikimedia.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { forgetSessions } from '../src/eden/session.js';
import { createStockMedia, fromCommons } from '../src/eden/stock-media.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const A = '22222222-2222-4222-8222-222222222222';
const OV = { id: '94f51e61-f870-47f7-bdec-49cd2eb5f173', title: 'Lighthouse', url: 'https://live.staticflickr.com/1/2_b.jpg', foreign_landing_url: 'https://www.flickr.com/photos/x/1', creator: 'Kenneth Moore', license: 'by', license_version: '2.0', license_url: 'https://creativecommons.org/licenses/by/2.0/', provider: 'flickr', thumbnail: 'https://api.openverse.org/v1/images/94f51e61-f870-47f7-bdec-49cd2eb5f173/thumb/' };
const WC = { pageid: 42, title: 'File:Leuchtturm.jpg', index: 1, imageinfo: [{ width: 4000, height: 3000, mime: 'image/jpeg', url: 'https://upload.wikimedia.org/a/Leuchtturm.jpg', thumburl: 'https://upload.wikimedia.org/thumb/a/Leuchtturm.jpg/1280px-Leuchtturm.jpg?utm_source=x', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Leuchtturm.jpg', extmetadata: { Artist: { value: '<a href="//x">Marco</a>' }, LicenseShortName: { value: 'CC BY-SA 4.0' } } }] };

let env;
let ovStatus;
const ctx = { waitUntil: () => {} };
const realFetch = globalThis.fetch;
beforeEach(() => {
  forgetSessions();
  ovStatus = 200;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://api.openverse.org/v1/images/?')) return ovStatus === 200 ? Response.json({ results: [OV, { ...OV, id: 'x', license: 'by-nc' }] }) : Response.json({}, { status: ovStatus });
    if (url.startsWith('https://commons.wikimedia.org/w/api.php')) return Response.json({ query: { pages: [WC] } });
    if (url.startsWith('https://upload.wikimedia.org/thumb/')) return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg', 'content-length': '3' } });
    if (url.startsWith('https://upload.wikimedia.org/')) return new Response('<html>', { headers: { 'content-type': 'text/html' } });
    throw new Error(`unexpected fetch ${url}`);
  };
  env = { OPENAI_API_KEY: 'sk-openai-test', TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '6', LINK_RATE: rateLimiter(), API_RATE: rateLimiter(), EDEN_RATE: rateLimiter(), AUTH_RATE: rateLimiter() };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.IDENTITIES = namespace(Identity, env);
  env.ASSETS = { fetch: async () => new Response('asset') };
});
after(() => { globalThis.fetch = realFetch; });

const browser = async () => (await call(env, A, 'web-signin', { account_id: A, create: true, identity: { provider: 'google', sub_hash: 'm'.repeat(64), email: 'm@example.com' }, device: { name: 'Eden on the web: Safari on a Mac' } })).token;
const get = (path, cookie, headers = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { cookie, 'user-agent': 'Mozilla/5.0 Safari/605', 'sec-fetch-site': 'same-origin', ...headers } }), env, ctx);

test('GET /api/chat/media/search: signed in, both libraries with their licences, NC dropped; signed out refused', async () => {
  const cookie = `__Host-eden=${await browser()}`;
  const r = await get('/api/chat/media/search?kind=photo&q=lighthouse%20search-one', cookie);
  assert.equal(r.status, 200, await r.clone().text());
  const body = await r.json();
  assert.deepEqual(body.items.map((i) => [i.source, i.licence, i.author]), [['Openverse', 'CC BY 2.0', 'Kenneth Moore'], ['Wikimedia Commons', 'CC BY-SA 4.0', 'Marco']]);
  assert.ok(body.items.every((i) => i.url.startsWith('/api/chat/media/file?u=')));
  assert.ok(!decodeURIComponent(body.items[1].url).includes('utm_'));
  assert.ok([401, 403].includes((await get('/api/chat/media/search?kind=photo&q=x', '')).status), 'signed out');
  assert.equal((await get('/api/chat/media/search?kind=gif&q=x', cookie)).status, 400);
});

test('a rate limit is a notice while Commons answers, and a clear 429 when nothing does', async () => {
  const cookie = `__Host-eden=${await browser()}`;
  ovStatus = 429;
  const r = await (await get('/api/chat/media/search?kind=photo&q=busy-one', cookie)).json();
  assert.equal(r.items.length, 1);
  assert.match(r.notices[0], /Openverse is busy/);
  const none = createStockMedia({ fetcher: async () => Response.json({}, { status: 429 }) });
  await assert.rejects(none.search('audio', 'piano'), (e) => e.status === 429 && /Wait a minute/.test(e.message));
});

test('GET /api/chat/media/file: libraries only, pictures/sound/video only, Range passed on', async () => {
  const cookie = `__Host-eden=${await browser()}`;
  const file = (u, h) => get(`/api/chat/media/file?u=${encodeURIComponent(u)}`, cookie, h);
  const ok = await file('https://upload.wikimedia.org/thumb/a/Leuchtturm.jpg/330px-Leuchtturm.jpg');
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal(ok.headers.get('content-type'), 'image/jpeg');
  assert.match(ok.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await ok.arrayBuffer()).byteLength, 3);
  assert.equal((await file('https://evil.example/x.jpg')).status, 400);
  assert.equal((await file('https://api.openverse.org/v1/images/?q=x')).status, 400);
  assert.equal((await file('https://upload.wikimedia.org/x.html')).status, 502);
  let seen = null;
  const media = createStockMedia({ fetcher: async (u, init) => { seen = init; return new Response('ab', { status: 206, headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-1/9', 'content-length': '2' } }); } });
  const part = await media.file(new Request('https://askeden.com/x', { headers: { range: 'bytes=0-1' } }), 'https://cdn.freesound.org/previews/1/1.mp3');
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 0-1/9');
  assert.equal(seen.headers.range, 'bytes=0-1');
  const ogv = fromCommons({ title: 'File:W.ogv', videoinfo: [{ mime: 'application/ogg', url: 'https://upload.wikimedia.org/a/W.ogv', thumburl: 'https://upload.wikimedia.org/a/W.jpg', derivatives: [{ src: 'https://upload.wikimedia.org/t/W.ogv.480p.vp9.webm', type: 'video/webm; codecs="vp9"', width: 854 }] }] }, 'video');
  assert.match(decodeURIComponent(ogv.url), /480p\.vp9\.webm$/);
});
