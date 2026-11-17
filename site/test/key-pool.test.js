// The key pool (src/eden/key-pool.js, docs/load-balancing.md): tier order, spreading within a tier, cooldowns and the
// circuit, the KEY_POOL=off kill switch, failover in withPool and streamCall, the tiers providers.js builds, raw-key
// callers never getting a vertex:// credential, and the owner's health route never showing a key.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { acquire, classify, fingerprint, order, poolEnabled, report, resetPool, retryAfterMs, sha256Hex, snapshot, withPool } from '../src/eden/key-pool.js';
import { modelOf, plainKeys, plainServiceKeys, providerKey, ratingRouter, serviceKeyList, serviceKeyTiers, streamCall } from '../src/eden/providers.js';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';

let now;
beforeEach(() => {
  now = 1_000_000;
  resetPool({ now: () => now });
});

const seq = (...xs) => {
  let i = 0;
  return () => xs[i++ % xs.length];
};

test('fingerprints are SHA-256, 8 chars', () => {
  for (const s of ['', 'abc', 'x'.repeat(56), 'é'.repeat(300)]) assert.equal(sha256Hex(s), createHash('sha256').update(s).digest('hex'));
  assert.equal(fingerprint('sk-secret'), createHash('sha256').update('sk-secret').digest('hex').slice(0, 8));
});

test('tiers keep their order; a lower tier only comes first when the one above is out of credit', () => {
  const tiers = [['v'], ['a', 'b'], ['f']];
  for (let i = 0; i < 20; i++) {
    const o = order('gemini', tiers);
    assert.equal(o[0], 'v');
    assert.deepEqual(o.slice(1, 3).sort(), ['a', 'b']);
    assert.equal(o[3], 'f');
  }
  report('gemini', 'v', { kind: 'cooldown', status: 402 });
  report('gemini', 'a', { kind: 'cooldown', status: 400, body: 'Your credit balance is too low' });
  report('gemini', 'b', { kind: 'cooldown', status: 429, body: '{"error":{"code":"insufficient_quota"}}' });
  assert.deepEqual(order('gemini', tiers), ['f', 'v', 'a', 'b']); // the sick still tried, last, in tier order
});

test('a rate limit, overload or open circuit keeps the key in its tier, behind that tier\'s healthy keys', () => {
  const tiers = [['a', 'b'], ['f']];
  order('openai', tiers);
  report('openai', 'a', { kind: 'cooldown', status: 429, body: 'Rate limit reached for gpt-x on tokens per min' });
  for (let i = 0; i < 10; i++) assert.deepEqual(order('openai', tiers), ['b', 'a', 'f']);
  report('openai', 'b', { kind: 'cooldown', status: 529, retryAfter: 1_000 });
  assert.deepEqual(order('openai', tiers), ['b', 'a', 'f']); // both cooling: soonest back first, still before the fallback
  // one primary key + a fallback tier behaves as today: the primary first on each call
  const env = { GEMINI_API_KEY: 'g1', GEMINI_FALLBACK_KEYS: 'f1', VERTEX_FIRST: 'off' };
  const first = async () => {
    const k = await providerKey(env, null, 'gemini');
    return [k.key, ...k.fallbackKeys];
  };
  return (async () => {
    assert.deepEqual(await first(), ['g1', 'f1']);
    report('gemini', 'g1', { kind: 'cooldown', status: 429, body: '{"error":{"status":"RESOURCE_EXHAUSTED","message":"check your plan and billing details"}}' });
    assert.deepEqual(await first(), ['g1', 'f1']); // the rating model's 429 doesn't send a Pro chat to the fallback
    for (let i = 0; i < 3; i++) report('gemini', 'g1', { kind: 'failure', status: 503 });
    assert.equal(snapshot().providers.gemini.find((e) => e.fp === fingerprint('g1')).state, 'circuit');
    assert.deepEqual(await first(), ['g1', 'f1']);
    report('gemini', 'g1', { kind: 'cooldown', status: 402 });
    assert.deepEqual(await first(), ['f1', 'g1']); // out of credit: the fallback first
    report('gemini', 'g1', { kind: 'ok', status: 200 });
    assert.deepEqual(await first(), ['g1', 'f1']);
  })();
});

test('within a tier the less busy key is picked (power of two choices) and both get used', () => {
  resetPool({ now: () => now, rand: seq(0, 0.99) });
  order('openai', [['a', 'b', 'c']]);
  const r1 = acquire('openai', 'a');
  acquire('openai', 'a');
  const o = order('openai', [['a', 'b', 'c']]);
  assert.notEqual(o[0], 'a'); // a has 2 in flight
  assert.equal(o[o.length - 1], 'a');
  r1();
  r1(); // releasing twice counts once
  assert.equal(snapshot().providers.openai.find((e) => e.fp === fingerprint('a')).inFlight, 1);
  resetPool({ now: () => now });
  const firsts = new Set();
  for (let i = 0; i < 60; i++) firsts.add(order('openai', [['a', 'b', 'c']])[0]);
  assert.deepEqual([...firsts].sort(), ['a', 'b', 'c']);
});

test('cooldown: Retry-After, else 15 s doubling to 5 min; a success resets', () => {
  const tiers = [['a', 'b']];
  order('kimi', tiers);
  report('kimi', 'a', { kind: 'cooldown', status: 429, retryAfter: 2_000 });
  assert.equal(order('kimi', tiers)[0], 'b');
  now += 2_001;
  assert.ok(order('kimi', tiers).includes('a'));
  assert.equal(snapshot().providers.kimi.find((e) => e.fp === fingerprint('a')).state, 'ok');
  report('kimi', 'a', { kind: 'cooldown', status: 429 }); // second in a row: 30 s
  assert.equal(snapshot().providers.kimi.find((e) => e.fp === fingerprint('a')).backInMs, 30_000);
  for (let i = 0; i < 10; i++) report('kimi', 'a', { kind: 'cooldown', status: 529 });
  assert.equal(snapshot().providers.kimi.find((e) => e.fp === fingerprint('a')).backInMs, 300_000);
  report('kimi', 'a', { kind: 'ok', status: 200 });
  const a = snapshot().providers.kimi.find((e) => e.fp === fingerprint('a'));
  assert.equal(a.state, 'ok');
  report('kimi', 'a', { kind: 'cooldown', status: 429 });
  assert.equal(snapshot().providers.kimi.find((e) => e.fp === fingerprint('a')).backInMs, 15_000);
  const h = new Headers({ 'retry-after': '7' });
  assert.equal(retryAfterMs(h), 7_000);
  assert.equal(retryAfterMs(new Headers()), null);
});

test('circuit: opens after 3 failures in a row for 30 s; a success in between resets', () => {
  const tiers = [['a', 'b']];
  order('openai', tiers);
  report('openai', 'a', { kind: 'failure', status: 500 });
  report('openai', 'a', { kind: 'failure', status: 0 });
  report('openai', 'a', { kind: 'ok', status: 200 });
  report('openai', 'a', { kind: 'failure', status: 503 });
  report('openai', 'a', { kind: 'failure', status: 502 });
  assert.equal(snapshot().providers.openai.find((e) => e.fp === fingerprint('a')).state, 'ok');
  report('openai', 'a', { kind: 'failure', status: 500 });
  const a = snapshot().providers.openai.find((e) => e.fp === fingerprint('a'));
  assert.equal(a.state, 'circuit');
  assert.equal(a.backInMs, 30_000);
  assert.deepEqual(order('openai', tiers), ['b', 'a']);
  now += 30_001;
  assert.equal(snapshot().providers.openai.find((e) => e.fp === fingerprint('a')).state, 'ok');
});

test('classify', () => {
  assert.equal(classify(200), 'ok');
  assert.equal(classify(429), 'cooldown');
  assert.equal(classify(529), 'cooldown');
  assert.equal(classify(402), 'cooldown');
  assert.equal(classify(403, '{"error":"You exceeded your current quota"}'), 'cooldown');
  assert.equal(classify(400, 'bad request'), 'neutral');
  assert.equal(classify(404), 'neutral');
  assert.equal(classify(500), 'failure');
  assert.equal(classify(0), 'failure');
  // a request's own error is not the key's: an over-long prompt never parks a healthy key for everyone
  const tooLong = '{"error":{"message":"This model\'s maximum context length is 128000 tokens.","type":"invalid_request_error","code":"context_length_exceeded"}}';
  assert.equal(classify(400, tooLong), 'neutral');
  report('openai', 'primary', { kind: classify(400, tooLong), status: 400 });
  assert.deepEqual(order('openai', [['primary'], ['fallback']]), ['primary', 'fallback']);
  assert.equal(classify(429, 'Rate limit exceeded'), 'cooldown');
  assert.equal(classify(400, '{"error":{"code":"insufficient_quota"}}'), 'cooldown');
});

test('a sick Vertex key keeps its tier (its limits are per model); a sick plain key still moves back', async () => {
  const env = { VERTEX_ACCESS_TOKEN: 'ya29.token', VERTEX_PROJECT: 'p1', GEMINI_API_KEY: 'g1', GEMINI_FALLBACK_KEYS: 'f1' };
  const v = 'vertex://p1/global#ya29.token';
  await providerKey(env, null, 'gemini');
  report('gemini', v, { kind: 'cooldown', status: 429 }); // model A's quota on Vertex
  for (let i = 0; i < 3; i++) report('gemini', v, { kind: 'failure', status: 503 });
  const k = await providerKey(env, null, 'gemini'); // model B's call: still Vertex first
  assert.deepEqual([k.key, ...k.fallbackKeys], [v, 'g1', 'f1']);
  assert.equal(snapshot().providers.gemini.find((e) => e.kind === 'vertex').state, 'circuit'); // still shown
  report('gemini', 'g1', { kind: 'cooldown', status: 402 });
  const after = await providerKey(env, null, 'gemini');
  assert.deepEqual([after.key, ...after.fallbackKeys], [v, 'f1', 'g1']);
});

test('KEY_POOL=off: the input order, unchanged, whatever the health', () => {
  const env = { KEY_POOL: 'off' };
  order('gemini', [['a', 'b', 'c'], ['f']]);
  report('gemini', 'a', { kind: 'cooldown', status: 429 });
  acquire('gemini', 'b');
  for (let i = 0; i < 10; i++) assert.deepEqual(order('gemini', [['a', 'b', 'c'], ['f']], { env }), ['a', 'b', 'c', 'f']);
  assert.equal(poolEnabled(), false);
  assert.deepEqual(order('gemini', [['a', 'b', 'c'], ['f']], { env: {} }).length, 4);
  assert.equal(poolEnabled(), true);
});

test('withPool fails over on 429/5xx/network/quota text, returns the last answer, stops on a plain 4xx', async () => {
  const calls = [];
  const answers = { a: () => new Response('busy', { status: 429, headers: { 'retry-after': '5' } }), b: () => { throw new TypeError('network'); }, c: () => new Response('quota exceeded', { status: 403 }), d: () => new Response('ok') };
  const res = await withPool('openai', ['a', 'b', 'c', 'd'], (k) => (calls.push(k), answers[k]()), { ordered: true });
  assert.deepEqual(calls, ['a', 'b', 'c', 'd']);
  assert.equal(await res.text(), 'ok');
  const last = await withPool('openai', ['a', 'c'], (k) => answers[k](), { ordered: true });
  assert.equal(last.status, 403);
  assert.equal(await last.text(), 'quota exceeded'); // body still readable
  const stop = [];
  const r400 = await withPool('openai', ['x', 'y'], (k) => (stop.push(k), new Response('bad', { status: 400 })), { ordered: true });
  assert.equal(r400.status, 400);
  assert.deepEqual(stop, ['x']);
  await assert.rejects(withPool('openai', ['p', 'q'], () => { throw new Error('down'); }, { ordered: true }), /down/);
  const ac = new AbortController();
  const tried = [];
  await assert.rejects(withPool('openai', ['p', 'q'], (k) => { tried.push(k); ac.abort(); throw new Error('aborted'); }, { ordered: true, signal: ac.signal }));
  assert.deepEqual(tried, ['p']);
});

test('withPool balances endpoint URLs and moves off a failing one', async () => {
  resetPool({ now: () => now, rand: seq(0) }); // ties go to judge-1, so the first call meets the failure
  const urls = ['https://judge-1.example/run', 'https://judge-2.example/run'];
  const hits = [];
  for (let i = 0; i < 6; i++) await withPool('gemma-judge', urls, (u) => (hits.push(u), u.includes('-1') ? new Response('', { status: 502 }) : new Response('{}')));
  const snap = snapshot().providers['gemma-judge'];
  assert.equal(snap.find((e) => e.fp === fingerprint(urls[0])).kind, 'url');
  assert.ok(snap.find((e) => e.fp === fingerprint(urls[0])).errors >= 1);
  assert.equal(snap.find((e) => e.fp === fingerprint(urls[1])).ok, 6); // every call answered by judge-2
  // with a recent error, judge-1 loses every pick against an idle judge-2
  const after = [];
  await withPool('gemma-judge', urls, (u) => (after.push(u), new Response('{}')));
  assert.deepEqual(after, [urls[1]]);
});

test('a key never appears in the snapshot', () => {
  const secret = 'AIzaSySECRETSECRETSECRET123';
  const vertex = 'vertex://proj/global#{"private_key":"-----BEGIN PRIVATE KEY-----abc"}';
  order('gemini', [[vertex], [secret]]);
  report('gemini', secret, { kind: 'cooldown', status: 429 });
  const text = JSON.stringify(snapshot());
  assert.ok(!text.includes(secret) && !text.includes('SECRET') && !text.includes('PRIVATE') && !text.includes('proj'));
  assert.match(text, new RegExp(fingerprint(secret)));
  // keys the pool was never given (an asker's own) aren't tracked or shown
  report('gemini', 'sk-users-own', { kind: 'ok', status: 200 });
  assert.ok(!JSON.stringify(snapshot()).includes(fingerprint('sk-users-own')));
});

// ── providers.js ──

const VERTEX_ENV = { VERTEX_ACCESS_TOKEN: 'ya29.token', VERTEX_PROJECT: 'p1' };

test('service key tiers: Vertex first, primary + numbered vars, then fallback keys; the flat list is unchanged', () => {
  const env = { ...VERTEX_ENV, GEMINI_API_KEY: 'g1, g2', GEMINI_API_KEY_2: 'g3', GEMINI_API_KEY_9: 'g4,g1', GEMINI_FALLBACK_KEYS: 'f1,g2' };
  const v = 'vertex://p1/global#ya29.token';
  assert.deepEqual(serviceKeyTiers(env, 'gemini'), [[v], ['g1', 'g2', 'g3', 'g4'], ['f1']]);
  assert.deepEqual(serviceKeyList(env, 'gemini'), [v, 'g1', 'g2', 'g3', 'g4', 'f1']);
  assert.deepEqual(serviceKeyTiers({ ...env, VERTEX_FIRST: 'off' }, 'gemini'), [['g1', 'g2', 'g3', 'g4'], ['f1'], [v]]);
  assert.deepEqual(serviceKeyTiers({ OPENAI_API_KEY: 'o1' }, 'openai'), [['o1']]);
  assert.deepEqual(serviceKeyTiers({ META_API_KEY: 'm1', META_API_KEY_2: 'm2' }, 'meta'), [['m1', 'm2']]);
  assert.deepEqual(serviceKeyTiers({}, 'kimi'), []);
});

test('raw-key callers get only plain keys, never vertex://', () => {
  const v = 'vertex://p1/global#ya29.token';
  assert.deepEqual(plainKeys({ key: v, fallbackKeys: ['g1', 'g2', v] }), ['g1', 'g2']);
  assert.deepEqual(plainKeys([v, 'g1']), ['g1']);
  assert.deepEqual(plainKeys(v), []);
  assert.deepEqual(plainKeys([[v], ['g1', 'g2'], ['f1']]), [['g1', 'g2'], ['f1']]);
  assert.deepEqual(plainKeys(null), []);
  const keys = plainServiceKeys({ ...VERTEX_ENV, GEMINI_API_KEY: 'g1,g2', GEMINI_FALLBACK_KEYS: 'f1' }, 'gemini');
  assert.deepEqual(keys.slice(0, 2).sort(), ['g1', 'g2']);
  assert.equal(keys[2], 'f1');
  assert.deepEqual(plainServiceKeys(VERTEX_ENV, 'gemini'), []);
});

test('providerKey: Vertex stays first, primary keys spread, KEY_POOL=off keeps the fixed order', async () => {
  const env = { ...VERTEX_ENV, GEMINI_API_KEY: 'g1,g2,g3', GEMINI_FALLBACK_KEYS: 'f1' };
  const seconds = new Set();
  for (let i = 0; i < 40; i++) {
    const k = await providerKey(env, null, 'gemini');
    assert.equal(k.key, 'vertex://p1/global#ya29.token');
    assert.equal(k.fallbackKeys[3], 'f1');
    seconds.add(k.fallbackKeys[0]);
  }
  assert.ok(seconds.size > 1);
  for (let i = 0; i < 10; i++) {
    const k = await providerKey({ ...env, KEY_POOL: 'off' }, null, 'gemini');
    assert.deepEqual([k.key, ...k.fallbackKeys], ['vertex://p1/global#ya29.token', 'g1', 'g2', 'g3', 'f1']);
  }
});

test('the Gemini rating never sends a vertex:// key and moves to the next plain key on a 429', async () => {
  const cfg = { models: ['gemini-3.8-flash', 'gpt-6-luna'].map(modelOf).filter(Boolean) };
  assert.equal(cfg.models.length, 2);
  assert.equal(ratingRouter(cfg, { gemini: { key: 'vertex://p/global#tok', source: 'service' } }), null);
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const k = new Headers(init.headers).get('x-goog-api-key');
    sent.push(k);
    if (k === 'g1') return new Response('{"error":{"message":"rate limit"}}', { status: 429 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"complexity":"simple","difficulty":0.1,"skills":{"general":1},"outputTokens":100,"reason":"x"}' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const r = ratingRouter(cfg, { gemini: { key: 'vertex://p/global#tok', fallbackKeys: ['g1', 'g2'], source: 'service' } });
    assert.ok(r);
    await r.router.route({ prompt: 'Prove the Riemann hypothesis for me in detail with all the steps', classifier: 'always' }).catch(() => null);
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(sent, ['g1', 'g2']);
  // KEY_POOL=off: one call on the first key, no retry (as before the pool)
  await providerKey({ GEMINI_API_KEY: 'g1', KEY_POOL: 'off' }, null, 'gemini'); // the switch as this copy reads it
  sent.length = 0;
  globalThis.fetch = async (url, init) => (sent.push(new Headers(init.headers).get('x-goog-api-key')), new Response('{"error":{"message":"rate limit"}}', { status: 429 }));
  try {
    const r = ratingRouter(cfg, { gemini: { key: 'g1', fallbackKeys: ['g2'], source: 'service' } });
    await r.router.route({ prompt: 'Prove the Riemann hypothesis for me in detail with all the steps', classifier: 'always' }).catch(() => null);
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(sent, ['g1']);
});

test('streamCall: a 5xx or network error moves to the next key; KEY_POOL=off keeps the old rule', async () => {
  const m = modelOf('gpt-6-luna');
  assert.ok(m);
  const request = { provider: 'openai', params: { model: m.id, max_completion_tokens: 100 } };
  const real = globalThis.fetch;
  const run = async (keys) => {
    const tried = [];
    globalThis.fetch = async (url, init) => {
      const auth = new Headers(init.headers).get('authorization') || '';
      const k = auth.replace(/^Bearer /, '');
      tried.push(k);
      if (k === 'k500') return new Response('{"error":{"message":"server"}}', { status: 500 });
      if (k === 'knet') throw new TypeError('fetch failed');
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    };
    try {
      const r = await streamCall({ model: m, request, messages: [{ role: 'user', content: 'hi' }], system: '', key: keys[0], fallbackKeys: keys.slice(1) }, { signal: new AbortController().signal, emit() {} });
      return { r, tried };
    } finally {
      globalThis.fetch = real;
    }
  };
  order('openai', [['k500', 'knet', 'kok']], { env: {} }); // the pool knows these keys; on
  let { r, tried } = await run(['k500', 'knet', 'kok']);
  assert.deepEqual(tried, ['k500', 'knet', 'kok']);
  assert.equal(r.failure, null);
  const snap = snapshot().providers.openai;
  assert.equal(snap.find((e) => e.fp === fingerprint('k500')).lastStatus, 500);
  assert.equal(snap.find((e) => e.fp === fingerprint('kok')).ok, 1);
  assert.equal(snap.find((e) => e.fp === fingerprint('kok')).inFlight, 0); // released when the stream ended
  order('openai', [['k500', 'kok']], { env: { KEY_POOL: 'off' } });
  ({ r, tried } = await run(['k500', 'kok']));
  assert.deepEqual(tried, ['k500']);
  assert.match(r.failure, /HTTP 500/);
  order('openai', [['k500']], { env: {} }); // back on for the tests after
});

test('GET /api/admin/lb: the owner sees fingerprints and health, never a key; anyone else 404', async () => {
  forgetSessions();
  const env = {
    TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '6', LINK_RATE: rateLimiter(), API_RATE: rateLimiter(), EDEN_RATE: rateLimiter(), AUTH_RATE: rateLimiter(),
    ADMIN_EMAILS: 'owner@example.com', EDEN_TOKEN_KEY: 'k'.repeat(64),
    GEMINI_API_KEY: 'AIzaSyOWNERSECRET1,AIzaSyOWNERSECRET2', OPENAI_API_KEY: 'sk-proj-SECRETOPENAI', VERTEX_ACCESS_TOKEN: 'ya29.SECRETTOKEN',
    GEMMA_JUDGE_URL: 'https://judge-a.SECRET.modal.run, https://judge-b.SECRET.modal.run/judge',
  };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.IDENTITIES = namespace(Identity, env);
  env.ASSETS = { fetch: async () => new Response('') };
  const signin = async (account, email) => (await call(env, account, 'web-signin', { account_id: account, create: true, identity: { provider: 'google', sub_hash: 'h'.repeat(64), email }, device: { name: 'Eden on the web: Safari on a Mac' } })).token;
  const owner = await signin('11111111-1111-4111-8111-111111111111', 'owner@example.com');
  const other = await signin('22222222-2222-4222-8222-222222222222', 'someone@example.com');
  const get = (token) => worker.fetch(new Request('https://askeden.com/api/admin/lb', { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) Safari/605', ...(token ? { cookie: `__Host-eden=${token}` } : {}) } }), env, { waitUntil() {} });
  assert.equal((await get(null)).status, 404);
  assert.equal((await get(other)).status, 404);
  const res = await get(owner);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const text = await res.text();
  assert.ok(!/SECRET|AIza|sk-proj|ya29/.test(text), text);
  const data = JSON.parse(text);
  assert.equal(data.on, true);
  assert.equal(data.providers.gemini.length, 3);
  assert.deepEqual(data.providers.gemini.map((e) => e.kind), ['vertex', 'key', 'key']);
  assert.ok(data.providers.gemini.some((e) => e.fp === fingerprint('AIzaSyOWNERSECRET1')));
  assert.equal(data.providers.openai[0].fp, fingerprint('sk-proj-SECRETOPENAI'));
  // judge URLs are listed before any judge call in this copy
  assert.deepEqual(data.providers['gemma-judge'].map((e) => e.fp).sort(), [fingerprint('https://judge-a.SECRET.modal.run'), fingerprint('https://judge-b.SECRET.modal.run')].sort());
  assert.ok(!/modal\.run/.test(text));
});

test('withPool reads a 429 body: account words move the key behind lower tiers, a plain rate limit does not', async () => {
  const tiers = [['p'], ['f']];
  order('openai', tiers);
  await withPool('openai', tiers, (k) => new Response(k === 'p' ? '{"error":{"message":"Rate limit reached"}}' : 'ok', { status: k === 'p' ? 429 : 200 }));
  assert.deepEqual(order('openai', tiers), ['p', 'f']);
  await withPool('openai', tiers, (k) => new Response(k === 'p' ? '{"error":{"code":"insufficient_quota"}}' : 'ok', { status: k === 'p' ? 429 : 200 }));
  assert.deepEqual(order('openai', tiers), ['f', 'p']);
});

test('withPool: an abort after a failed answer cancels that answer\'s body', async () => {
  let cancelled = false;
  const ac = new AbortController();
  const body = new ReadableStream({ pull() {}, cancel() { cancelled = true; } });
  await assert.rejects(
    withPool('openai', ['ab-A', 'ab-B'], (k) => {
      if (k === 'ab-A') return new Response(body, { status: 503 });
      ac.abort();
      throw new Error('aborted');
    }, { ordered: true, signal: ac.signal }),
    /aborted/
  );
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(cancelled, true);
});

test('KEY_POOL=off is read by providerKey before an own-key or early return', async () => {
  assert.equal(poolEnabled(), true);
  assert.equal(await providerKey({ KEY_POOL: 'off', EDEN_GEMINI: 'off' }, null, 'gemini'), null);
  assert.equal(poolEnabled(), false);
  await providerKey({}, null, 'gemini');
  assert.equal(poolEnabled(), true);
});

test('withPool retryThrown: false: a thrown error is reported and thrown, no next key; 429/5xx still move on', async () => {
  order('gemini', ['t-A', 't-B']); // registered, as service keys are
  const tried = [];
  await assert.rejects(withPool('gemini', ['t-A', 't-B'], (k) => { tried.push(k); throw new TypeError('reset'); }, { ordered: true, retryThrown: false }), /reset/);
  assert.deepEqual(tried, ['t-A']);
  assert.equal(snapshot().providers.gemini.find((e) => e.fp === fingerprint('t-A')).failsInRow, 1);
  const moved = [];
  const res = await withPool('gemini', ['u-A', 'u-B'], (k) => (moved.push(k), new Response('x', { status: k === 'u-A' ? 503 : 200 })), { ordered: true, retryThrown: false });
  assert.equal(res.status, 200);
  assert.deepEqual(moved, ['u-A', 'u-B']);
});

test('the tier shown for a key comes from the widest tier list, whichever caller ran last', () => {
  order('gemini', [['vertex://p/l#{}'], ['w-A', 'w-B'], ['w-F']]); // providerKey's view (Vertex first)
  order('gemini', [['w-A', 'w-B'], ['w-F']]); // service-ai.js envKeyTiers (no Vertex)
  order('gemini', ['w-A', 'w-B', 'w-F']); // a flat list
  const tierOf = (k) => snapshot().providers.gemini.find((e) => e.fp === fingerprint(k)).tier;
  assert.deepEqual([tierOf('w-A'), tierOf('w-B'), tierOf('w-F')], [1, 1, 2]);
});
