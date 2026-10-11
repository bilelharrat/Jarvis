// Optimization pass 2, askeden.com's Worker (askeden docs/bug-sweep/r2-optimize-site-mobile.md):
//   startup: hosted chat and @Eden (and the Model Router's classifier they bring) load on their first request, not when an
//     isolate starts; priceOf learns the registry's prices on use (pricesReady), so every path still bills a stand-in model
//     at its own list price
//   GET /api/web/session?account=1: the session and the account page's answer from one call to the account
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { costOf, priceOf, pricesReady, testOnlyForgetModels } from '../src/accounts/proxy.js';
import { askModel } from '../src/accounts/tasks.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { forgetSessions } from '../src/eden/session.js';
import { Space } from '../src/accounts/space.js';
import { Course } from '../src/edu/course.js';
import { Account, Identity, Link, appleJwk, identityToken, namespace, rateLimiter } from './fakes.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const ORIGIN = 'https://askeden.com';
const A = '11111111-1111-4111-8111-111111111111';
const UNKNOWN = [15, 75, 0.1];
const GEMINI = [0.75, 3.75]; // gemini-3.8-flash in the registry (service-ai.test.js)

/** Every module worker.js loads at startup: its static imports, followed (dynamic import() is not followed). */
function staticGraph(entry) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/^\s*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm)) walk(join(dirname(file), m[1]));
  };
  walk(entry);
  return [...seen].map((f) => f.slice(SRC.length + 1));
}

test('startup: the classifier, hosted chat and @Eden are not loaded when an isolate starts', () => {
  const graph = staticGraph(join(SRC, 'worker.js'));
  assert.ok(graph.includes('accounts/index.js') && graph.includes('eden/pages.js') && graph.includes('edu/course.js'), 'the walk follows imports');
  for (const lazy of ['eden/vendor/model-router.js', 'eden/vendor/providers.js', 'eden/vendor/verify.js', 'eden/chat.js', 'eden/ask.js', 'eden/providers.js']) {
    assert.ok(!graph.includes(lazy), `${lazy} is loaded at startup`);
  }
});

test('priceOf: a stand-in model is priced from the registry once it is ready, and a new isolate loads it on use', async () => {
  testOnlyForgetModels();
  assert.deepEqual(priceOf('gemini-3.8-flash'), UNKNOWN, 'not loaded yet (a new isolate)');
  await pricesReady();
  assert.deepEqual(priceOf('gemini-3.8-flash').slice(0, 2), GEMINI);
  assert.deepEqual(priceOf('claude-opus-5-5'), [4, 20, 0.05], 'Claude never needed it');
  assert.deepEqual(priceOf('nothing-known'), UNKNOWN);
  await Promise.all([pricesReady(), pricesReady()]);
});

const geminiReply = (text) => ({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 1_000_000 } });

test('a background task run without an Anthropic key is billed at the stand-in price in a new isolate', async () => {
  testOnlyForgetModels();
  const f = async () => Response.json(geminiReply('{"ok":true}'));
  const out = await askModel({ GEMINI_API_KEY: 'g' }, { system: 's', user: 'u', schema: { type: 'object' }, maxTokens: 200, model: 'claude-sonnet-5-5', fetch: f });
  assert.equal(out.model, 'gemini-3.8-flash');
  assert.equal(out.costUSD, GEMINI[0] + GEMINI[1], 'a million in and out at its own price, not the unknown model’s $90');
});

// ── the Anthropic door (the apps' included AI) without an Anthropic key, in a new isolate ──

let env;
const waits = [];
const ctx = { waitUntil: (p) => waits.push(p) };
const counts = { calls: [] };
beforeEach(() => {
  forgetSessions();
  forgetAppleKeys();
  counts.calls = [];
  env = { EDEN_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'), TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20', LINK_RATE: rateLimiter(), API_RATE: rateLimiter(100_000), AUTH_RATE: rateLimiter(), EDEN_RATE: rateLimiter() };
  for (const [k, C] of [['ACCOUNTS', Account], ['LINKS', Link], ['IDENTITIES', Identity], ['SPACES', Space], ['COURSES', Course]]) {
    const ns = namespace(C, env);
    const get = ns.get.bind(ns);
    ns.get = (name) => { const stub = get(name); return { fetch: (input, init) => { counts.calls.push(`${k}:${new URL(input instanceof Request ? input.url : input).pathname.slice(1)}`); return stub.fetch(input, init); } }; };
    env[k] = ns;
  }
  env.ASSETS = { fetch: async () => new Response('asset') };
});

test('the Anthropic door bills a Gemini stand-in answer at its own price in a new isolate (registry loaded on use)', async () => {
  testOnlyForgetModels();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    if (url.startsWith('https://generativelanguage.googleapis.com/')) return Response.json({ ...geminiReply('Hi'), usageMetadata: { promptTokenCount: 100_000, candidatesTokenCount: 100_000 } });
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    env.GEMINI_API_KEY = 'g';
    const api = (path, init) => worker.fetch(new Request(`${ORIGIN}/api${path}`, init), env, ctx);
    const signed = await (await api('/account/apple', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity_token: await identityToken(), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone', app_version: '1.0' } }) })).json();
    assert.ok(signed.token, JSON.stringify(signed));
    const res = await api('/anthropic/v1/messages', { method: 'POST', headers: { authorization: `Bearer ${signed.token}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(res.status, 200, await res.clone().text());
    await res.text();
    await Promise.all(waits.splice(0));
    const account = await (await api('/account', { headers: { authorization: `Bearer ${signed.token}` } })).json();
    const billed = Math.round((1 - account.usage.trial_left_usd) * 1e6) / 1e6;
    assert.equal(billed, costOf('gemini-3.8-flash', { input_tokens: 100_000, output_tokens: 100_000 }));
    assert.equal(billed, 0.45, '$0.075 + $0.375 at Gemini 3.8 Flash’s price ($9 as an unknown model)');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── GET /api/web/session?account=1 ──

const signInWeb = async () => (await call(env, A, 'web-signin', { account_id: A, create: true, device: { name: 'Eden on the web: Chrome' } })).token;
const hit = (p, token) => worker.fetch(new Request(`${ORIGIN}${p}`, { headers: { 'x-jarvis-chat': '1', 'user-agent': 'Mozilla/5.0 Chrome/140', ...(token ? { cookie: `__Host-eden=${token}` } : {}) } }), env, ctx);

test('/api/web/session?account=1: the session and the account page’s answer in one call to the account', async () => {
  const t = await signInWeb();
  const plain = await (await hit('/api/web/session', t)).json();
  const acct = await (await hit('/api/web/account', t)).json();
  counts.calls = [];
  const r = await hit('/api/web/session?account=1', t);
  assert.equal(r.status, 200);
  const both = await r.json();
  assert.deepEqual(counts.calls, ['ACCOUNTS:get'], 'one call for both');
  const { account, ...session } = both;
  assert.deepEqual(session, plain, 'the session part is /api/web/session’s answer');
  assert.deepEqual(account, acct, 'account is /api/web/account’s answer');
  assert.equal(account.devices.find((d) => d.this).name, 'Eden on the web: Chrome');
  // Without the flag: the same answer as before (no account part, the slim view).
  const again = await (await hit('/api/web/session', t)).json();
  assert.equal('account' in again, false);
  // Signed out: 401 and the cookie cleared, as /api/web/session.
  const out = await hit('/api/web/session?account=1', `${t.slice(0, -4)}AAAA`);
  assert.equal(out.status, 401);
  assert.match(out.headers.get('set-cookie') || '', /__Host-eden=;/);
});

// ── a course's turn log (`r:` records): counted, so a turn reads the oldest few records, not all 2,000 ──

import { COURSES, coursesApi } from '../src/edu/course.js';

const PROF = '44444444-4444-4444-8444-444444444444';
const STUDENT = '55555555-5555-4555-8555-555555555555';
function courseSetup() {
  const cenv = {};
  cenv.COURSES = namespace(Course, cenv);
  const deps = { call: async (_e, _a, o) => (o === 'get' ? { identities: [] } : {}), limited: async () => {}, readBody: async (r) => JSON.parse((await r.text()) || '{}') };
  const api = (account, method, path, body) => coursesApi(new Request(`https://askeden.com${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }), cenv, { account }, path.split('?')[0], deps);
  const storage = (id) => { cenv.COURSES.get(id); return cenv.COURSES.objects.get(id).storage; };
  const op = (id, what, body) => cenv.COURSES.get(id).fetch(`https://course/${what}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
  return { api, storage, op };
}

test('course turn log: an old course is counted once, then each turn reads a few records; the cap and the year still hold', async () => {
  const { api, storage, op } = courseSetup();
  const made = await api(PROF, 'POST', '/api/chat/courses', { name: 'BIO' });
  const s = storage(made.id);
  const now = Date.now();
  const year = 365 * 864e5;
  // a course from before the count: full, the first 5 more than a year old
  for (let i = 0; i < COURSES.records + 3; i++) {
    const at = i < 5 ? now - year - 864e5 + i : now - 1e6 + i;
    s.map.set(`r:${String(at).padStart(14, '0')}:x${String(i).padStart(5, '0')}`, { at, member: 'm', status: 'verified', hits: [], q: null });
  }
  const recs = () => [...s.map.keys()].filter((k) => k.startsWith('r:'));
  let rows = 0;
  const list = s.list.bind(s);
  s.list = async (o) => { const r = await list(o); if (o && o.prefix === 'r:') rows += r.size; return r; };
  assert.deepEqual(await op(made.id, 'record', { account: PROF, status: 'verified', hits: [] }), { ok: true });
  assert.equal(recs().length, COURSES.records - 1, 'the 5 old ones dropped (and none over the cap)'); // 2003 + 1 − 5
  assert.equal(s.map.get('rn'), recs().length);
  // steady state: one short listing a turn
  for (let i = 0; i < 3; i++) {
    rows = 0;
    await op(made.id, 'record', { account: PROF, status: 'general', hits: [], question: `q${i}` });
    assert.ok(rows <= 9, `${rows} rows read`);
  }
  assert.equal(recs().length, COURSES.records, 'at the cap: the oldest goes for each new one');
  assert.equal(s.map.get('rn'), COURSES.records);
  const oldest = recs()[0];
  await op(made.id, 'record', { account: PROF, status: 'verified', hits: [] });
  assert.equal(recs().length, COURSES.records);
  assert.ok(!recs().includes(oldest), 'the oldest went');
  // records that turn a year old go on the next turn, beside the one over the cap
  const [first, second] = recs();
  for (const k of [first, second]) s.map.set(k, { ...s.map.get(k), at: now - year - 1 });
  await op(made.id, 'record', { account: PROF, status: 'verified', hits: [] });
  assert.ok(!recs().includes(first) && !recs().includes(second));
  assert.equal(recs().length, COURSES.records - 1);
  assert.equal(s.map.get('rn'), recs().length);
});

// ── what an open page polls: no read of the owner's API keys ──

test('polled routes (tasks, Eden on the Mac’s status, projects, the prep look) skip the keys read; meta still reads them', async () => {
  const t = await signInWeb();
  const post = (p, body) => worker.fetch(new Request(`${ORIGIN}${p}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-jarvis-chat': '1', origin: ORIGIN, 'user-agent': 'Mozilla/5.0 Chrome/140', cookie: `__Host-eden=${t}` } }), env, ctx);
  await hit('/api/chat/meta', t); // the session check is cached after this
  for (const [label, go] of [['tasks', () => hit('/api/chat/tasks', t)], ['status', () => hit('/api/chat/jarvis/status', t)], ['projects', () => hit('/api/chat/projects', t)], ['brief', () => post('/api/chat/brief', { kind: 'events' })]]) {
    counts.calls = [];
    const r = await go();
    assert.equal(r.status, 200, `${label}: ${await r.clone().text()}`);
    assert.ok(!counts.calls.includes('ACCOUNTS:ukeys-get'), `${label}: ${counts.calls}`);
    assert.equal(counts.calls.length, 1, `${label}: ${counts.calls}`);
  }
  counts.calls = [];
  const meta = await (await hit('/api/chat/meta', t)).json();
  assert.ok(counts.calls.includes('ACCOUNTS:ukeys-get'), 'meta lists the models this person has keys for');
  assert.ok(Array.isArray(meta.models));
  // tasks answers as before
  assert.ok(Array.isArray((await (await hit('/api/chat/tasks', t)).json()).tasks));
});

// ── the front page's HTML kept in the isolate ──

test('/ signed out: the page is read from assets once per isolate; the same bytes and headers after; HEAD and If-None-Match work', async () => {
  const reads = [];
  env.ASSETS = { fetch: async (req) => { reads.push([new URL(req.url).pathname, req.headers.get('if-none-match')]); return new Response('<!doctype html><title>Eden</title>', { headers: { 'content-type': 'text/html', etag: '"v1"' } }); } };
  const visit = (headers = {}, method = 'GET') => worker.fetch(new Request(`${ORIGIN}/`, { method, headers: { 'user-agent': 'Mozilla/5.0', ...headers } }), env, ctx);
  const a = await visit();
  const b = await visit({ 'if-none-match': 'W/"other"' });
  assert.deepEqual(reads, [['/home/', null]], 'one plain read, never the visit’s conditional headers');
  assert.equal(await a.text(), '<!doctype html><title>Eden</title>');
  assert.equal(await b.text(), '<!doctype html><title>Eden</title>');
  for (const h of ['content-security-policy', 'cache-control', 'vary', 'x-frame-options', 'content-type']) assert.equal(b.headers.get(h), a.headers.get(h), h);
  assert.equal(a.headers.get('cache-control'), 'no-store');
  const notModified = await visit({ 'if-none-match': '"v1"' });
  assert.equal(notModified.status, 304);
  const head = await visit({}, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  // another deployment's assets (a new isolate in production; another env here) are read afresh
  const old = env.ASSETS;
  env.ASSETS = { fetch: async () => new Response('new page', { headers: { 'content-type': 'text/html' } }) };
  assert.equal(await (await visit()).text(), 'new page');
  env.ASSETS = old;
  // a page that isn't there is passed on as it was
  env.ASSETS = { fetch: async () => new Response('missing', { status: 404 }) };
  assert.equal((await visit()).status, 404);
});
