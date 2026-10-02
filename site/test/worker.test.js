// The download Worker with fake R2 and assets: what the page and a browser get.
import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { parseRange } from '../src/worker.js';

const FILE = 'J.A.R.V.I.S.-0.1.0.dmg';
const BYTES = new Uint8Array(1000).map((_, i) => i % 256);

function env({ latest = { version: '0.1.0', size: BYTES.length, file: FILE }, file = true } = {}) {
  const store = new Map();
  if (latest) store.set('latest.json', JSON.stringify(latest));
  if (file) store.set(FILE, BYTES);
  const object = (key, range) => {
    const value = store.get(key);
    if (value === undefined) return null;
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    let body = bytes;
    if (range) {
      const start = range.offset ?? bytes.length - range.suffix;
      body = bytes.slice(start, range.length ? start + range.length : undefined);
    }
    return { size: bytes.length, httpEtag: '"e1"', body: new Blob([body]).stream(), text: async () => new TextDecoder().decode(bytes) };
  };
  const assets = [];
  return {
    assets,
    DOWNLOADS: { get: async (key, opts = {}) => object(key, opts.range), head: async (key) => object(key) },
    ASSETS: { fetch: async (req) => { assets.push(new URL(req.url).pathname); return new Response('page'); } },
  };
}

const get = (path, e, init = {}) => worker.fetch(new Request(`https://www.askeden.com${path}`, init), e);

test('the page is the root and /jarvis; its images by path; old addresses go home', async () => {
  const e = env();
  await get('/', e);
  await get('/jarvis', e);
  await get('/jarvis/', e);
  await get('/jarvis/icon.png', e);
  assert.deepEqual(e.assets, ['/jarvis/', '/jarvis/', '/jarvis/', '/jarvis/icon.png']);
  const old = await get('/pricing', e);
  assert.equal(old.status, 302);
  assert.equal(old.headers.get('location'), 'https://www.askeden.com/');
});

test('/download and /latest.json work at the root as well', async () => {
  assert.equal((await get('/download', env())).status, 200);
  assert.equal((await (await get('/latest.json', env())).json()).version, '0.1.0');
});

test('the download is the latest disk image, whole and resumable', async () => {
  const whole = await get('/jarvis/download', env());
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-type'), 'application/x-apple-diskimage');
  assert.match(whole.headers.get('content-disposition'), /attachment; filename="J\.A\.R\.V\.I\.S\.-0\.1\.0\.dmg"/);
  assert.equal(whole.headers.get('content-length'), '1000');
  assert.equal((await whole.arrayBuffer()).byteLength, 1000);
  const part = await get('/jarvis/download', env(), { headers: { range: 'bytes=100-199' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 100-199/1000');
  assert.deepEqual(new Uint8Array(await part.arrayBuffer()), BYTES.slice(100, 200));
  const rest = await get('/jarvis/download', env(), { headers: { range: 'bytes=990-' } });
  assert.equal(rest.headers.get('content-range'), 'bytes 990-999/1000');
  const head = await get('/jarvis/download', env(), { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '1000');
});

test('nothing is offered before a release, or when its file is missing', async () => {
  assert.equal((await get('/jarvis/download', env({ latest: null }))).status, 404);
  assert.equal((await get('/jarvis/download', env({ file: false }))).status, 404);
  assert.equal((await get('/jarvis/latest.json', env({ latest: null }))).status, 404);
});

test('latest.json tells the page the version and size', async () => {
  const r = await get('/jarvis/latest.json', env());
  assert.deepEqual(await r.json(), { version: '0.1.0', size: 1000, file: FILE, published: '' });
});

test('only reading is allowed', async () => {
  assert.equal((await get('/jarvis/download', env(), { method: 'POST' })).status, 405);
});

test('ranges as browsers send them', () => {
  assert.deepEqual(parseRange('bytes=0-99'), { offset: 0, length: 100 });
  assert.deepEqual(parseRange('bytes=5-'), { offset: 5 });
  assert.deepEqual(parseRange('bytes=-10'), { suffix: 10 });
  assert.equal(parseRange('bytes=9-3'), null);
  assert.equal(parseRange('bytes=0-1,5-6'), null);
  assert.equal(parseRange(null), null);
});

test('without the R2 bucket bound, the download is the latest GitHub release', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    currentRelease: '0.1.1',
    releases: [{ version: '0.1.1', updateTo: { url: 'https://github.com/bilelharrat/Jarvis/releases/latest/download/J.A.R.V.I.S.-0.1.1-mac.zip' } }],
  }));
  const e = env();
  delete e.DOWNLOADS;
  const r = await get('/download', e);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://github.com/bilelharrat/Jarvis/releases/latest/download/J.A.R.V.I.S.-0.1.1.dmg');
  assert.equal((await (await get('/latest.json', e)).json()).version, '0.1.1');
});

test('with the feed unreadable, the download still goes somewhere real', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  const e = env();
  delete e.DOWNLOADS;
  assert.match((await get('/download', e)).headers.get('location'), /J\.A\.R\.V\.I\.S\.-0\.1\.\d\.dmg$/);
});

// ── the hosted JARVIS voice ──

import { VoiceQuota, JARVIS_VOICE_ID } from '../src/worker.js';

function quotaEnv(extra = {}) {
  const store = new Map();
  const storage = {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => store.has(x)).map((x) => [x, store.get(x)])) : store.get(k)),
    put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) store.set(a, b); else store.set(k, v); },
    deleteAll: async () => store.clear(),
  };
  const object = new VoiceQuota({ storage });
  return {
    FISH_API_KEY: 'owner-secret',
    VOICE_QUOTA: { idFromName: () => 'daily', get: () => ({ fetch: (u, init) => object.fetch(new Request(u, init)) }) },
    VOICE_DAILY_PER_INSTALL: '30',
    VOICE_DAILY_PER_NETWORK: '50',
    VOICE_DAILY_TOTAL: '1000',
    ...extra,
  };
}

const INSTALL = 'ab'.repeat(16);
const say = (e, text, init = {}) => worker.fetch(new Request('https://askeden.com/api/voice', {
  method: 'POST',
  headers: { 'x-jarvis-install': INSTALL, 'cf-connecting-ip': '1.2.3.4', ...(init.headers || {}) },
  body: JSON.stringify({ text, format: 'pcm', ...(init.body || {}) }),
}), e);

test('the JARVIS voice: the owner key goes to Fish, never back; audio streams through', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  });
  const r = await say(quotaEnv(), 'Good evening.', { body: { speed: 1.2 } });
  assert.equal(r.status, 200);
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.equal(calls[0].url, 'https://api.fish.audio/v1/tts');
  assert.equal(calls[0].init.headers.authorization, 'Bearer owner-secret');
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.reference_id, JARVIS_VOICE_ID);
  assert.equal(sent.format, 'pcm');
  assert.deepEqual(sent.prosody, { speed: 1.2 });
  assert.ok(!r.headers.get('authorization'));
});

test('each install and network has a daily allowance; past it, 429 and no Fish call', async (t) => {
  let fishCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { fishCalls += 1; return new Response('x'); });
  const e = quotaEnv();
  assert.equal((await say(e, 'a'.repeat(20))).status, 200);
  const over = await say(e, 'b'.repeat(20)); // 40 > this install's 30
  assert.equal(over.status, 429);
  assert.match((await over.json()).error, /Settings › Speaking/);
  assert.equal(fishCalls, 1);
  // another install on the same network: 20 more fit under the network's 50, then no
  const other = (text) => say(e, text, { headers: { 'x-jarvis-install': 'cd'.repeat(16) } });
  assert.equal((await other('c'.repeat(20))).status, 200);
  assert.equal((await other('d'.repeat(20))).status, 429);
});

test('bad requests are refused before anything is spent', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('no network in tests'); });
  const e = quotaEnv();
  assert.equal((await say(e, '')).status, 400);
  assert.equal((await say(e, 'x'.repeat(601))).status, 413);
  assert.equal((await say(e, 'hi', { headers: { 'x-jarvis-install': 'nope' } })).status, 400);
  const get = await worker.fetch(new Request('https://askeden.com/api/voice'), e);
  assert.equal(get.status, 405);
  const unset = await say({ ...e, FISH_API_KEY: '' }, 'hi');
  assert.equal(unset.status, 503);
});

test('the other apps\' buttons: "almost ready" until their address is set, then a redirect', async () => {
  for (const path of ['/jarvis/iphone', '/messenger/download', '/messenger/mac', '/messenger/iphone']) {
    const soon = await get(path, env());
    assert.equal(soon.status, 200, path);
    assert.match(soon.headers.get('content-type'), /text\/html/);
    assert.match(await soon.text(), /almost ready/);
  }
  const e = { ...env(), MESSENGER_MAC_URL: 'https://example.com/Eden-Messenger.dmg', JARVIS_IPHONE_URL: 'http://not-https.example' };
  const mac = await get('/messenger/download', e);
  assert.equal(mac.status, 302);
  assert.equal(mac.headers.get('location'), 'https://example.com/Eden-Messenger.dmg');
  assert.equal((await get('/jarvis/iphone', e)).status, 200);
  assert.equal((await get('/messenger/nonsense', e)).status, 302);
});
