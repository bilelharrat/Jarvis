// Every provider path on the key pool (docs/load-balancing.md, design item 2): raw-key calls never send a vertex://
// key, a 429/5xx on key A moves to key B (same model), and the Router API's short cache for unknown keys.
// Fake providers throughout (globalThis.fetch): no real API call.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { envKeyTiers, serviceFetch } from '../src/accounts/service-ai.js';
import { forward } from '../src/accounts/proxy.js';
import { cleanLocal } from '../src/eden/via-mac.js';
import { pooledFetch } from '../src/eden/chat.js';
import { embedTexts } from '../src/eden/embed.js';
import { resetPool, snapshot } from '../src/eden/key-pool.js';
import { extractMemory } from '../src/eden/memory.js';
import { plainKeys, serviceKeyTiers } from '../src/eden/providers.js';
import { forgetSessions } from '../src/eden/session.js';
import { deleteFile, findFile } from '../src/eden/video.js';
import { resetBadKeys } from '../src/router-api/api.js';
import { RouterApi } from '../src/router-api/store.js';
import { sketchTrip } from '../src/travel/planner.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const A = '22222222-2222-4222-8222-222222222222';
const PIXEL = 'UklGRhYAAABXRUJQVlA4TAoAAAAvAAAAAEX/I/of';
const MP4_B64 = 'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=';
const VERTEX = '{"type":"service_account"}';
const realFetch = globalThis.fetch;
let env;
let waits;
let calls;
let route; // (url, init, key) → Response | null (null: the default answer)
const ctx = { waitUntil: (p) => waits.push(p), passThroughOnException() {} };

const keyOf = (init = {}) => {
  const h = new Headers(init.headers || {});
  return h.get('x-goog-api-key') || (h.get('authorization') || '').replace(/^Bearer /, '') || h.get('x-api-key') || null;
};
const busy = () => Response.json({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } }, { status: 429 });
const google = () => calls.filter((c) => c.url.startsWith('https://generativelanguage.googleapis.com/'));

function geminiDefault(url, method) {
  if (url.includes(':predictLongRunning')) return Response.json({ name: 'models/veo-3.0-fast-generate-001/operations/op-9', done: false });
  if (url.includes('/operations/op-9')) return Response.json({ name: 'op-9', done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { bytesBase64Encoded: MP4_B64, mimeType: 'video/mp4' } }] } } });
  if (url.includes(':predict')) return Response.json({ predictions: [{ bytesBase64Encoded: PIXEL, mimeType: 'image/webp' }] });
  if (url.includes(':streamGenerateContent')) {
    const chunk = { candidates: [{ content: { parts: [{ text: 'A cat jumps.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12000, candidatesTokenCount: 20 } };
    return new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }
  if (url.includes(':generateContent')) return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/webp', data: PIXEL } }] }, finishReason: 'STOP' }] });
  const file = (state) => ({ name: 'files/v1', uri: 'https://generativelanguage.googleapis.com/v1beta/files/v1', mimeType: 'video/mp4', sizeBytes: '5000000', state, videoMetadata: { videoDuration: '20s' } });
  if (url.endsWith('/upload/v1beta/files')) return new Response('', { headers: { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=u9' } });
  if (url.includes('upload_id=u9')) return Response.json({ file: file('ACTIVE') });
  if (url.endsWith('/v1beta/files/v1')) return method === 'DELETE' ? Response.json({}) : Response.json(file('ACTIVE'));
  return new Response('{}', { status: 404 });
}

beforeEach(() => {
  forgetSessions();
  resetPool({ rand: () => 0 }); // idle keys in the given order: key A first
  resetBadKeys();
  waits = [];
  calls = [];
  route = () => null;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = init.method || 'GET';
    const key = keyOf(init);
    calls.push({ url, method, init, key });
    const r = await route(url, init, key);
    if (r) return r;
    if (url.startsWith('https://generativelanguage.googleapis.com/')) return geminiDefault(url, method);
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  env = { EDEN_IMAGES: 'on', EDEN_VIDEOS: 'on', EDEN_VIDEO_POLL_MS: '5', TRIAL_BUDGET_USD: '5', PLUS_BUDGET_USD: '20', LINK_RATE: rateLimiter(), API_RATE: rateLimiter(), EDEN_RATE: rateLimiter(), AUTH_RATE: rateLimiter() };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.IDENTITIES = namespace(Identity, env);
  env.ASSETS = { fetch: async () => new Response('asset') };
});
after(() => {
  globalThis.fetch = realFetch;
});

const settle = async () => {
  while (waits.length) await Promise.all(waits.splice(0));
};
const browser = async () => (await call(env, A, 'web-signin', { account_id: A, create: true, identity: { provider: 'google', sub_hash: 'k'.repeat(64), email: 'k@example.com' }, device: { name: 'Eden on the web: Safari on a Mac' } })).token;
async function hit(path, token, { body, headers = {} } = {}) {
  const init = { method: 'POST', headers: { origin: ORIGIN, 'x-jarvis-chat': '1', cookie: `__Host-eden=${token}`, 'user-agent': 'Mozilla/5.0 Safari/605', ...headers }, body };
  if (typeof body === 'object' && !(body instanceof Uint8Array)) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
  const text = await res.text();
  await settle();
  const events = [...text.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map(([, type, data]) => ({ type, data: JSON.parse(data) }));
  return { status: res.status, text, events };
}

// ── pictures and videos: never vertex://, and a busy key moves to the next ──

test('a picture with Vertex first: only plain keys are sent, and a 429 on key A moves to key B (same model)', async () => {
  Object.assign(env, { VERTEX_CREDENTIALS: VERTEX, GEMINI_API_KEY: 'g-A', GEMINI_API_KEY_2: 'g-B' });
  route = (url, init, key) => (url.includes(':predict') && key === 'g-A' ? busy() : null);
  const token = await browser();
  const r = await hit('/api/chat/send', token, { body: { messages: [{ role: 'user', content: 'draw me a lighthouse at dusk' }] } });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.events.some((e) => e.type === 'image'), r.text);
  const route0 = r.events.find((e) => e.type === 'route').data;
  assert.equal(route0.model, 'imagen-4.0-generate-001');
  assert.ok(!r.events.some((e) => e.type === 'fallback'), 'no model fallback: the same Imagen model on key B');
  const sent = google().map((c) => c.key);
  assert.deepEqual(sent, ['g-A', 'g-B']);
  for (const c of calls) assert.ok(!String(c.key || '').startsWith('vertex://'), c.url);
  const pool = snapshot(env).providers.gemini;
  assert.ok(pool.some((k) => k.state === 'cooldown' && k.lastStatus === 429));
  assert.ok(!JSON.stringify(pool).includes('g-A') && !JSON.stringify(pool).includes('g-B'));
});

test('only a Vertex key for Gemini: pictures behave as "no Gemini" and the fallback chain (OpenAI) runs', async () => {
  Object.assign(env, { VERTEX_CREDENTIALS: VERTEX, OPENAI_API_KEY: 'o-A' });
  route = (url) => (url.startsWith('https://api.openai.com/v1/images/') ? Response.json({ output_format: 'webp', size: '1024x1024', data: [{ b64_json: PIXEL }], usage: { input_tokens: 10, output_tokens: 400 } }) : null);
  const token = await browser();
  const r = await hit('/api/chat/send', token, { body: { messages: [{ role: 'user', content: 'draw me a lighthouse at dusk' }] } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.events.find((e) => e.type === 'route').data.provider, 'openai');
  assert.ok(r.events.some((e) => e.type === 'image'), r.text);
  assert.equal(google().length, 0);
  for (const c of calls) assert.ok(!String(c.key || '').startsWith('vertex://'), c.url);
});

test('a video with Vertex first: Veo starts on key B after key A is busy, and B polls the job', async () => {
  Object.assign(env, { VERTEX_CREDENTIALS: VERTEX, GEMINI_API_KEY: 'g-A,g-B' });
  route = (url, init, key) => (url.includes(':predictLongRunning') && key === 'g-A' ? busy() : null);
  const token = await browser();
  const r = await hit('/api/chat/send', token, { body: { messages: [{ role: 'user', content: 'make a video of a red fox running through snow' }] } });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.events.some((e) => e.type === 'video'), r.text);
  assert.equal(r.events.find((e) => e.type === 'route').data.model, 'veo-3.0-fast-generate-001');
  assert.ok(!r.events.some((e) => e.type === 'fallback'));
  const starts = google().filter((c) => c.url.includes(':predictLongRunning')).map((c) => c.key);
  assert.deepEqual(starts, ['g-A', 'g-B']);
  const polls = google().filter((c) => c.url.includes('/operations/op-9'));
  assert.ok(polls.length > 0);
  for (const p of polls) assert.equal(p.key, 'g-B');
  for (const c of calls) assert.ok(!String(c.key || '').startsWith('vertex://'), c.url);
});

test('a video upload with Vertex first: key A busy → key B uploads; the turn reads it on key B (A gets 403), never Vertex', async () => {
  Object.assign(env, { VERTEX_CREDENTIALS: VERTEX, GEMINI_API_KEY: 'g-A', GEMINI_FALLBACK_KEYS: 'g-B' });
  route = (url, init, key) => {
    if (url.endsWith('/upload/v1beta/files') && key === 'g-A') return busy();
    if (url.endsWith('/v1beta/files/v1') && key === 'g-A') return Response.json({ error: { code: 403, message: 'You do not have permission' } }, { status: 403 }); // B's project owns it
    if (url.includes('aiplatform.googleapis.com') || url.includes('oauth2.googleapis.com')) throw new Error('Vertex must not read a Files API video');
    return null;
  };
  const token = await browser();
  const up = await hit('/api/chat/video', token, { body: new Uint8Array(1000), headers: { 'content-type': 'video/mp4', 'content-length': '1000', 'x-eden-name': 'cat.mp4', 'x-eden-seconds': '20' } });
  assert.equal(up.status, 200, up.text);
  const file = JSON.parse(up.text);
  assert.deepEqual(google().filter((c) => c.url.endsWith('/upload/v1beta/files')).map((c) => c.key), ['g-A', 'g-B']);
  calls.length = 0;
  const r = await hit('/api/chat/send', token, { body: { temporary: true, messages: [{ role: 'user', content: 'What happens?', attachments: [{ kind: 'video', name: 'cat.mp4', mime: 'video/mp4', file: file.file, uri: file.uri, seconds: 20 }] }] } });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.events.some((e) => e.type === 'text'), r.text);
  const stream = calls.find((c) => c.url.includes(':streamGenerateContent'));
  assert.equal(stream.key, 'g-B', 'the key whose project holds the file answers first');
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.key === 'g-B'));
  for (const c of calls) assert.ok(!String(c.key || '').startsWith('vertex://'), c.url);
});

test('findFile tries each plain key (403/404 → next); deleteFile stops at the first that deletes', async () => {
  route = (url, init, key) => (key === 'f-A' ? Response.json({ error: { code: 403 } }, { status: 403 }) : null);
  const found = await findFile(['vertex://p/global#x', 'f-A', 'f-B'], 'files/v1');
  assert.equal(found.key, 'f-B');
  assert.equal(found.file.state, 'ACTIVE');
  assert.deepEqual(calls.map((c) => c.key), ['f-A', 'f-B']);
  calls.length = 0;
  await deleteFile(['f-A', 'f-B', 'f-C'], 'files/v1');
  assert.deepEqual(calls.map((c) => c.key), ['f-A', 'f-B']);
});

// ── the other raw-key paths ──

test('Help/Edu OCR (serviceFetch, gemini-*): the plain Gemini key list, never vertex://; 429 on A → B', async () => {
  const e = { VERTEX_CREDENTIALS: VERTEX, GEMINI_API_KEY: 'h-A', GEMINI_API_KEY_2: 'h-B' };
  const seen = [];
  const f = async (url, init) => {
    seen.push(keyOf(init));
    if (keyOf(init) === 'h-A') return busy();
    return Response.json({ candidates: [{ content: { parts: [{ text: 'read: 42' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } });
  };
  const res = await serviceFetch(e, { model: 'gemini-3.8-flash', max_tokens: 100, messages: [{ role: 'user', content: 'read this' }] }, { fetch: f });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).content[0].text, 'read: 42');
  assert.deepEqual(seen, ['h-A', 'h-B']);
});

test('the service Claude call (serviceFetch): ANTHROPIC_API_KEY_2 joins the pool; a 5xx on A moves to B', async () => {
  const e = { ANTHROPIC_API_KEY: 'a-A', ANTHROPIC_API_KEY_2: 'a-B' };
  const seen = [];
  const f = async (url, init) => {
    seen.push(keyOf(init));
    return keyOf(init) === 'a-A' ? new Response('{"error":{"type":"api_error"}}', { status: 500 }) : Response.json({ id: 'msg', content: [] });
  };
  const res = await serviceFetch(e, { model: 'claude-opus-5-5', max_tokens: 10, messages: [] }, { fetch: f });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ['a-A', 'a-B']);
});

test('memory extraction: the plain Gemini keys (comma list, _2…_9, fallback), 429 on A → B, one time limit', async () => {
  const e = { VERTEX_CREDENTIALS: VERTEX, GEMINI_API_KEY: 'm-A', GEMINI_FALLBACK_KEYS: 'm-B' };
  const seen = [];
  const f = async (url, init) => {
    seen.push(keyOf(init));
    return keyOf(init) === 'm-A' ? busy() : Response.json({ candidates: [{ content: { parts: [{ text: '{"action":"none"}' }] } }] });
  };
  const out = await extractMemory(e, { account: A }, { prompt: 'I live in Lisbon and my daughter is called Ana.', state: { items: [] }, fetch: f });
  assert.equal(out, null);
  assert.deepEqual(seen, ['m-A', 'm-B']);
});

test('Eden Mail embeddings (pooledFetch): the same model on each key; a 5xx on A moves to B', async () => {
  const seen = [];
  const f = async (url, init) => {
    seen.push(keyOf(init));
    return keyOf(init) === 'e-A' ? new Response('{}', { status: 503 }) : Response.json({ data: [{ embedding: [0.1, 0.2] }], model: 'text-embedding-3-small' });
  };
  const vectors = await embedTexts('openai', 'e-A', ['hello'], pooledFetch('openai', ['e-A', 'e-B'], f));
  assert.equal(vectors.length, 1);
  assert.deepEqual(seen, ['e-A', 'e-B']);
});

test('the trip sketch (planner): a key list, 429 on A → B, the same model', async () => {
  const seen = [];
  const f = async (url, init) => {
    seen.push([keyOf(init), /models\/([^:]+):/.exec(url)[1]]);
    if (keyOf(init) === 't-A') return busy();
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ title: 'Lisbon', start: '2026-12-01', days: [{ title: 'Day 1', stops: [{ at: '09:00', name: 'Belém Tower', kind: 'visit', minutes: 60 }] }] }) }] }, finishReason: 'STOP' }] });
  };
  const r = await sketchTrip(['t-A', 't-B'], { request: 'Lisbon', constraints: { destination: 'Lisbon', days: 1, start: '2026-12-01' } }, { today: '2026-11-06', fetch: f, signal: null });
  assert.equal(r.title, 'Lisbon');
  assert.deepEqual(seen.map((s) => s[0]), ['t-A', 't-B']);
  assert.equal(seen[0][1], seen[1][1]);
});

test('envKeyTiers (service-ai.js) is providers.js serviceKeyTiers without Vertex', () => {
  const e = { VERTEX_CREDENTIALS: VERTEX, GEMINI_API_KEY: 'a, b', GEMINI_API_KEY_3: 'c', GEMINI_FALLBACK_KEYS: 'd,a', VERTEX_FIRST: 'on' };
  assert.deepEqual(envKeyTiers(e, 'GEMINI_API_KEY'), plainKeys(serviceKeyTiers(e, 'gemini')));
  assert.deepEqual(envKeyTiers(e, 'GEMINI_API_KEY'), [['a', 'b', 'c'], ['d']]);
  assert.deepEqual(envKeyTiers({ OPENAI_API_KEY: 'x', OPENAI_API_KEY_2: 'y' }, 'OPENAI_API_KEY'), [['x', 'y']]);
  assert.deepEqual(envKeyTiers({}, 'DEEPINFRA_API_KEY'), []);
});

// ── the Router API ──

const HOST = 'https://edenrouter.com';
const ADMIN = 'admin-token-for-tests-0123456789';
function routerEnv(extra = {}) {
  const e = { ROUTER_HOST: 'edenrouter.com', ROUTER_ADMIN_TOKEN: ADMIN, ...extra };
  e.ROUTER_API = namespace(RouterApi, e);
  let hits = 0;
  const get = e.ROUTER_API.get.bind(e.ROUTER_API);
  e.ROUTER_API.get = (id) => {
    const stub = get(id);
    return { fetch: (...a) => { hits++; return stub.fetch(...a); } };
  };
  return { e, hits: () => hits };
}
const routerCall = (e, path, { key, body, method = 'POST', headers = {} } = {}) =>
  worker.fetch(new Request(`${HOST}${path}`, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }), e, ctx);
const UNKNOWN = `sk-eden-${'Z'.repeat(43)}`;

test('Router API: an unknown well-formed key is answered from a ~30 s cache; a valid key never is; ROUTER_BAD_KEY_CACHE=off', async () => {
  let t = 1_000_000;
  resetBadKeys({ now: () => t });
  const { e, hits } = routerEnv();
  const first = await routerCall(e, '/v1/models', { key: UNKNOWN, method: 'GET' });
  assert.equal(first.status, 401);
  const firstBody = await first.json();
  assert.equal(firstBody.error.code, 'invalid_api_key');
  assert.equal(hits(), 1);
  const again = await routerCall(e, '/v1/models', { key: UNKNOWN, method: 'GET' });
  assert.equal(again.status, 401);
  assert.deepEqual(await again.json(), firstBody, 'the same answer the store gave');
  assert.equal(hits(), 1, 'the second try never reached the clients object');
  t += 31_000;
  assert.equal((await routerCall(e, '/v1/models', { key: UNKNOWN, method: 'GET' })).status, 401);
  assert.equal(hits(), 2, 'after ~30 s the store is asked again');

  // a valid key: every request reaches the store (admit counts its rate), nothing cached
  const made = await (await routerCall(e, '/api/admin/router', { key: ADMIN, body: { action: 'create', name: 'C' } })).json();
  const before = hits();
  for (let i = 0; i < 3; i++) assert.equal((await routerCall(e, '/v1/models', { key: made.api_key, method: 'GET' })).status, 200);
  assert.equal(hits() - before, 3);

  // revoked: not cached (only "unknown" is)
  await routerCall(e, '/api/admin/router', { key: ADMIN, body: { action: 'revoke', id: made.client.id } });
  const b2 = hits();
  for (let i = 0; i < 2; i++) assert.equal((await routerCall(e, '/v1/models', { key: made.api_key, method: 'GET' })).status, 401);
  assert.equal(hits() - b2, 2);

  // the kill switch
  const off = routerEnv({ ROUTER_BAD_KEY_CACHE: 'off' });
  const other = `sk-eden-${'Y'.repeat(43)}`;
  for (let i = 0; i < 2; i++) assert.equal((await routerCall(off.e, '/v1/models', { key: other, method: 'GET' })).status, 401);
  assert.equal(off.hits(), 2);
});

test('Router API: service keys come as a pool (comma list + _2), and a 429 on key A moves to key B for the same model', async () => {
  const { e } = routerEnv({ OPENAI_API_KEY: 'o-A', OPENAI_API_KEY_2: 'o-B' });
  route = (url, init, key) => {
    if (!url.startsWith('https://api.openai.com/')) return null;
    if (key === 'o-A') return Response.json({ error: { message: 'Rate limit reached' } }, { status: 429 });
    const body = JSON.parse(init.body);
    const lines = [{ choices: [{ delta: { content: `${body.model} says yes.` }, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } }].map((o) => `data: ${JSON.stringify(o)}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(lines, { headers: { 'content-type': 'text/event-stream' } });
  };
  const made = await (await routerCall(e, '/api/admin/router', { key: ADMIN, body: { action: 'create', name: 'S', service_keys: true } })).json();
  const r = await routerCall(e, '/v1/chat/completions', { key: made.api_key, body: { model: 'eden-router', messages: [{ role: 'user', content: 'Say yes' }] } });
  assert.equal(r.status, 200, await r.clone().text());
  const out = await r.json();
  const openai = calls.filter((c) => c.url.startsWith('https://api.openai.com/'));
  assert.deepEqual(openai.map((c) => c.key), ['o-A', 'o-B']);
  assert.equal(JSON.parse(openai[0].init.body).model, JSON.parse(openai[1].init.body).model, 'the same model on both keys');
  assert.match(out.choices[0].message.content, /says yes/);
  assert.ok(!JSON.stringify(out).includes('o-A') && !JSON.stringify(out).includes('o-B'));
});

// ── review fixes: no repeat of a paid start after a network error; numbered keys count everywhere ──

test('a Veo start that throws (connection reset) is not sent again on key B: the job may already be running', async () => {
  Object.assign(env, { GEMINI_API_KEY: 'g-A', GEMINI_API_KEY_2: 'g-B' });
  route = (url, init, key) => {
    if (url.includes(':predictLongRunning') && key === 'g-A') throw new TypeError('connection reset');
    return null;
  };
  const token = await browser();
  await hit('/api/chat/send', token, { body: { messages: [{ role: 'user', content: 'make a video of a red fox running through snow' }] } });
  const starts = google().filter((c) => c.url.includes(':predictLongRunning')).map((c) => c.key);
  assert.ok(!starts.includes('g-B'), `started again on key B: ${starts}`);
  assert.equal(starts.filter((k) => k === 'g-A').length, 1);
});

test('Eden Plus proxy: ANTHROPIC_API_KEY_2 alone is enough (no 503), the same as Ask and Help', async () => {
  const e = { ANTHROPIC_API_KEY_2: 'a-B' };
  route = (url) => (url.startsWith('https://api.anthropic.com/') ? Response.json({ id: 'm', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } }) : null);
  const req = new Request('https://askeden.com/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }) });
  const res = await forward(req, e, ctx, '/v1/messages', async () => {});
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(calls.filter((c) => c.url.startsWith('https://api.anthropic.com/')).map((c) => c.key), ['a-B']);
});

test('the privacy panel lists DeepInfra when only DEEPINFRA_API_KEY_2 is set (same check as a private turn)', () => {
  const ids = (e) => cleanLocal({ available: false }, e).servers?.map((s) => s.id) || [];
  assert.ok(ids({ DEEPINFRA_API_KEY_2: 'd-B' }).includes('deepinfra'));
  assert.ok(!ids({ DEEPINFRA_API_KEY: ' , ' }).includes('deepinfra'));
  assert.ok(!ids({}).includes('deepinfra'));
});
