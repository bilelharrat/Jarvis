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

test('the page is served for /jarvis and /jarvis/, its images by path', async () => {
  const e = env();
  await get('/jarvis', e);
  await get('/jarvis/', e);
  await get('/jarvis/icon.png', e);
  assert.deepEqual(e.assets, ['/jarvis/', '/jarvis/', '/jarvis/icon.png']);
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
