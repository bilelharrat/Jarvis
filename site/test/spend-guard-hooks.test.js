// The spend guard's hooks in askeden.com's request paths (askeden docs/spend-guard.md), through the Worker:
//   DeepInfra privacy turns: by default as before (no max_tokens, $0 notional usage line), plus the usage asked for,
//     logged and counted; DEEPINFRA_CHARGE=on: gated, capped (max_tokens), charged to the account, its hold released
//   Fish voice: counted; with VOICE_PHRASE_CACHE=on Eden's own fixed phrases come from the cache the second time,
//     never a person's text
//   a provider's SPEND_CAP_<PROVIDER>_USD refuses an unpaid chat turn before any model call
// Fake providers and fake Durable Objects throughout; no network.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker, { VoiceQuota } from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { pacificParts, resetPacerCache } from '../src/eden/credit-pacer.js';
import { SPEND_COPY, companySpendStatus, resetSpendCache } from '../src/eden/spend-counter.js';
import { FIXED_VOICE_PHRASES } from '../src/eden/voice-cache.js';
import { resetPool } from '../src/eden/key-pool.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const A = '44444444-4444-4444-8444-444444444444';
const realFetch = globalThis.fetch;
const realLog = console.log;
let env;
let waits;
let calls;
let logs;
let route;
const ctx = { waitUntil: (p) => waits.push(p), passThroughOnException() {} };

function makeEnv(extra = {}) {
  const e = { GEMINI_API_KEY: 'g-A', DEEPINFRA_API_KEY: 'di-A', FISH_API_KEY: 'fish-A', TRIAL_BUDGET_USD: '5', PLUS_BUDGET_USD: '20', LINK_RATE: rateLimiter(), API_RATE: rateLimiter(), EDEN_RATE: rateLimiter(), AUTH_RATE: rateLimiter(), USER_RATE: rateLimiter(), ...extra };
  e.ACCOUNTS = namespace(Account, e);
  e.LINKS = namespace(Link, e);
  e.IDENTITIES = namespace(Identity, e);
  e.VOICE_QUOTA = namespace(VoiceQuota, e);
  e.ASSETS = { fetch: async () => new Response('asset') };
  return e;
}

// DeepInfra's OpenAI-shaped stream: two text chunks, then the usage chunk (only when asked for it)
function deepInfraStream(body) {
  const chunks = [
    { choices: [{ delta: { content: 'Hello ' } }] },
    { choices: [{ delta: { content: 'there.' }, finish_reason: 'stop' }] },
  ];
  if (body.stream_options && body.stream_options.include_usage) chunks.push({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 300, estimated_cost: 0.00042 } });
  return new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

beforeEach(() => {
  forgetSessions();
  resetPool({ rand: () => 0 });
  resetPacerCache();
  resetSpendCache();
  waits = [];
  calls = [];
  logs = [];
  route = () => null;
  console.log = (line) => {
    try {
      logs.push(JSON.parse(line));
    } catch {
      // not ours
    }
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const body = init.body && typeof init.body === 'string' ? (() => { try { return JSON.parse(init.body); } catch { return null; } })() : null;
    calls.push({ url, init, body });
    const r = await route(url, init, body);
    if (r) return r;
    if (url === 'https://api.deepinfra.com/v1/openai/chat/completions') return deepInfraStream(body || {});
    if (url === 'https://api.fish.audio/v1/tts') return new Response(new Uint8Array([82, 73, 70, 70, 1, 2, 3]), { headers: { 'content-type': 'audio/wav' } });
    if (url.startsWith('https://generativelanguage.googleapis.com/') && url.includes(':streamGenerateContent')) {
      return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'A cat.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5 } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
});
after(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
});

const settle = async () => {
  while (waits.length) await Promise.all(waits.splice(0));
};
const browser = async (email = 'free@example.com') => (await call(env, A, 'web-signin', { account_id: A, create: true, identity: { provider: 'google', sub_hash: 'q'.repeat(64), email }, device: { name: 'Eden on the web: Safari on a Mac' } })).token;
async function hit(path, token, { body } = {}) {
  const init = { method: 'POST', headers: { origin: ORIGIN, 'x-jarvis-chat': '1', cookie: `__Host-eden=${token}`, 'user-agent': 'Mozilla/5.0 Safari/605', 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
  const buf = await res.arrayBuffer();
  await settle();
  await new Promise((r) => setTimeout(r, 5)); // the private turn's stream ends in its own task
  await settle();
  const text = new TextDecoder().decode(buf);
  const events = [...text.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map(([, type, data]) => ({ type, data: JSON.parse(data) }));
  return { status: res.status, text, bytes: buf, events, headers: res.headers, json: () => JSON.parse(text) };
}
const privateTurn = (token) => hit('/api/chat/send', token, { body: { messages: [{ role: 'user', content: 'Something private' }], privacy: true } });
const deepInfraCalls = () => calls.filter((c) => c.url === 'https://api.deepinfra.com/v1/openai/chat/completions');
const spentNow = async () => (await env.ACCOUNTS.objects.get(A).usageNow()).trial_spent;

// ── DeepInfra privacy turns ──

test('DeepInfra, defaults: the turn is as before (no max_tokens, $0 notional) and its real cost is logged; nothing charged', async () => {
  env = makeEnv();
  const token = await browser();
  const r = await privateTurn(token);
  assert.equal(r.status, 200, r.text);
  assert.ok(r.events.some((e) => e.type === 'text' && e.data.text === 'Hello '), r.text);
  const [c] = deepInfraCalls();
  assert.equal(c.body.max_tokens, undefined, 'no max_tokens until the owner turns it on');
  assert.deepEqual(c.body.stream_options, { include_usage: true }, 'DEEPINFRA_METERED (default on): the usage asked for');
  const usage = r.events.find((e) => e.type === 'usage').data;
  assert.equal(usage.costUSD, 0);
  assert.equal(usage.notional, true);
  const line = logs.find((l) => l.evt === 'deepinfra_usage');
  assert.equal(line.usd, 0.00042, 'DeepInfra’s own estimated_cost');
  assert.equal(line.charged, false);
  assert.ok(!JSON.stringify(logs).includes('Something private'), 'no text in the logs');
  assert.equal(await spentNow(), 0, 'nothing charged to the account');
});

test('DeepInfra, DEEPINFRA_METERED=off: the request is byte-for-byte the old one, nothing logged', async () => {
  env = makeEnv({ DEEPINFRA_METERED: 'off' });
  const token = await browser();
  const r = await privateTurn(token);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(deepInfraCalls()[0].body).sort(), ['messages', 'model', 'stream']);
  assert.ok(!logs.some((l) => l.evt === 'deepinfra_usage'));
});

test('DeepInfra, CREDIT_PACER=warn: the turn goes on the company counter as unpaid DeepInfra spend', async () => {
  env = makeEnv({ CREDIT_PACER: 'warn' });
  const token = await browser();
  await privateTurn(token);
  const s = await companySpendStatus(env);
  const di = s.providers.find((p) => p.id === 'deepinfra');
  assert.equal(di.unpaidUSD, 0.00042);
  assert.equal(di.byFeature['unpaid:privacy'], 0.00042);
});

test('DeepInfra, DEEPINFRA_CHARGE=on: gated like other turns, max_tokens sent, the real cost charged and shown, the hold released', async () => {
  env = makeEnv({ DEEPINFRA_CHARGE: 'on' });
  const token = await browser();
  const r = await privateTurn(token);
  assert.equal(r.status, 200, r.text);
  const [c] = deepInfraCalls();
  assert.ok(Number.isInteger(c.body.max_tokens) && c.body.max_tokens >= 512 && c.body.max_tokens <= 16_384, `max_tokens ${c.body.max_tokens}`);
  const usage = r.events.find((e) => e.type === 'usage').data;
  assert.equal(usage.notional, false);
  assert.equal(usage.costUSD, 0.00042);
  assert.equal(usage.inputTokens, 1200);
  assert.equal(await spentNow(), 0.00042, 'charged to the trial allowance');
  assert.equal(env.ACCOUNTS.objects.get(A).holds.size, 0, 'the hold is released');
});

test('DeepInfra, DEEPINFRA_CHARGE=on: no allowance left is refused before any call, with the allowance’s own words', async () => {
  env = makeEnv({ DEEPINFRA_CHARGE: 'on', TRIAL_BUDGET_USD: '0' });
  const token = await browser();
  const r = await privateTurn(token);
  assert.equal(r.status, 402, r.text);
  assert.equal(r.json().code, 'no_allowance');
  assert.equal(deepInfraCalls().length, 0);
});

test('DeepInfra, DEEPINFRA_CHARGE=on with SPEND_CAP_DEEPINFRA_USD reached: free private chats are refused (CREDIT_PACER=on)', async () => {
  env = makeEnv({ DEEPINFRA_CHARGE: 'on', CREDIT_PACER: 'on', SPEND_CAP_DEEPINFRA_USD: '0' });
  const token = await browser();
  const r = await privateTurn(token);
  assert.equal(r.status, 402, r.text);
  assert.equal(r.json().error, SPEND_COPY.privacy);
  assert.equal(deepInfraCalls().length, 0);
  assert.equal(env.ACCOUNTS.objects.get(A).holds.size, 0);
});

test('DeepInfra, DEEPINFRA_CHARGE=on and the stream fails: what was seen is charged and the hold released', async () => {
  env = makeEnv({ DEEPINFRA_CHARGE: 'on' });
  route = (url) => (url.startsWith('https://api.deepinfra.com/') ? new Response('nope', { status: 500 }) : null);
  const token = await browser();
  const r = await privateTurn(token);
  assert.ok(r.events.some((e) => e.type === 'error'), r.text);
  assert.equal(await spentNow(), 0, 'DeepInfra never answered: nothing charged');
  assert.equal(env.ACCOUNTS.objects.get(A).holds.size, 0, 'the hold is released');
});

// ── a provider's unpaid cap in a chat turn ──

test('a chat turn on a capped provider is refused before any model call (never moved to another model); Google is never capped here', async () => {
  env = makeEnv({ CREDIT_PACER: 'on', OPENAI_API_KEY: 'o-A', SPEND_CAP_OPENAI_USD: '0', SPEND_CAP_GOOGLE_USD: '0' });
  const token = await browser();
  const r = await hit('/api/chat/send', token, { body: { messages: [{ role: 'user', content: 'Say hello to the cat' }], override: { model: 'gpt-6.1-sol', effort: 'low' } } });
  assert.equal(r.status, 402, r.text);
  assert.equal(r.json().error, SPEND_COPY.model);
  assert.equal(calls.filter((c) => c.url.startsWith('https://api.openai.com/') || c.url.startsWith('https://generativelanguage.googleapis.com/')).length, 0, 'no model call, and no other model instead');
  const g = await hit('/api/chat/send', token, { body: { messages: [{ role: 'user', content: 'Say hello to the cat' }], override: { model: 'gemini-3.8-flash' } } });
  assert.equal(g.status, 200, `a Gemini turn: no Google cap here (${g.text.slice(0, 200)})`);
  // paid accounts are never refused
  env.UNLIMITED_EMAILS = 'family@example.com';
  const fam = await browser('family@example.com');
  route = (url) => (url.startsWith('https://api.openai.com/') ? new Response('{}', { status: 500 }) : null);
  const p = await hit('/api/chat/send', fam, { body: { messages: [{ role: 'user', content: 'Say hello' }], override: { model: 'gpt-6.1-sol', effort: 'low' } } });
  assert.notEqual(p.status, 402, p.text.slice(0, 200));
  assert.ok(calls.some((c) => c.url.startsWith('https://api.openai.com/')), 'a paying account reaches the model');
});

// ── Fish voice ──

test('voice: counted on the company counter (CREDIT_PACER=warn); a person’s text never cached', async () => {
  env = makeEnv({ CREDIT_PACER: 'warn', VOICE_PHRASE_CACHE: 'on' });
  const store = new Map();
  globalThis.caches = { default: { match: async (k) => store.get(k)?.clone() || undefined, put: async (k, res) => { store.set(k, res); } } };
  try {
    const token = await browser();
    const a = await hit('/api/chat/voice', token, { body: { text: 'My own words' } });
    const b = await hit('/api/chat/voice', token, { body: { text: 'My own words' } });
    assert.equal(a.status, 200, a.text);
    assert.equal(b.status, 200);
    assert.equal(calls.filter((c) => c.url === 'https://api.fish.audio/v1/tts').length, 2, 'never cached: Fish each time');
    assert.equal(store.size, 0);
    const s = await companySpendStatus(env);
    assert.ok(s.providers.find((p) => p.id === 'fish').unpaidUSD > 0);
  } finally {
    delete globalThis.caches;
  }
});

test('voice: with VOICE_PHRASE_CACHE=on, a fixed phrase is fetched once and then comes from the cache (same audio); off: Fish each time', async () => {
  const phrase = [...FIXED_VOICE_PHRASES][0];
  const store = new Map();
  globalThis.caches = { default: { match: async (k) => store.get(k)?.clone() || undefined, put: async (k, res) => { store.set(k, res); } } };
  try {
    env = makeEnv({ VOICE_PHRASE_CACHE: 'on' });
    const token = await browser();
    const a = await hit('/api/chat/voice', token, { body: { text: phrase, format: 'pcm' } });
    const b = await hit('/api/chat/voice', token, { body: { text: phrase, format: 'pcm' } });
    assert.equal(a.status, 200, a.text);
    assert.equal(b.status, 200, b.text);
    assert.deepEqual(new Uint8Array(b.bytes), new Uint8Array(a.bytes), 'the same audio');
    assert.equal(b.headers.get('x-eden-voice'), 'cached');
    assert.equal(calls.filter((c) => c.url === 'https://api.fish.audio/v1/tts').length, 1, 'one Fish call');
    // off (the default): Fish each time
    store.clear();
    calls.length = 0;
    env = makeEnv();
    const t2 = await browser('other@example.com');
    await hit('/api/chat/voice', t2, { body: { text: phrase, format: 'pcm' } });
    await hit('/api/chat/voice', t2, { body: { text: phrase, format: 'pcm' } });
    assert.equal(calls.filter((c) => c.url === 'https://api.fish.audio/v1/tts').length, 2);
    assert.equal(store.size, 0);
  } finally {
    delete globalThis.caches;
  }
});

test('the pacer’s day is untouched by other providers (the credits are Google’s only)', async () => {
  env = makeEnv({ CREDIT_PACER: 'warn' });
  const token = await browser();
  await privateTurn(token);
  const s = await companySpendStatus(env);
  assert.equal(s.unpaidTodayUSD, 0);
  assert.equal(s.paidTodayUSD, 0);
  assert.equal(s.today, pacificParts(Date.now()).day);
});

// ── the provider caps on the other chat surfaces (Compare, a chat turn's fallback) and voice ──

test('Compare: an unpaid Compare that would call a capped provider is refused before any model call (CREDIT_PACER=on)', async () => {
  env = makeEnv({ CREDIT_PACER: 'on', OPENAI_API_KEY: 'o-A', SPEND_CAP_OPENAI_USD: '0' });
  const token = await browser();
  const r = await hit('/api/chat/compare', token, { body: { messages: [{ role: 'user', content: 'Say hello to the cat' }], models: [{ model: 'gpt-6.1-sol', effort: 'low' }, { model: 'gemini-3.8-flash' }] } });
  assert.equal(r.status, 402, r.text.slice(0, 300));
  assert.equal(r.json().error, SPEND_COPY.model);
  assert.equal(calls.filter((c) => c.url.startsWith('https://api.openai.com/') || c.url.startsWith('https://generativelanguage.googleapis.com/')).length, 0);
});

test('a chat turn’s fallback onto a capped provider stops with the cap’s words instead of calling it (CREDIT_PACER=on)', async () => {
  env = makeEnv({ CREDIT_PACER: 'on', OPENAI_API_KEY: 'o-A', SPEND_CAP_OPENAI_USD: '0' });
  const token = await browser();
  route = (url) => (url.startsWith('https://generativelanguage.googleapis.com/') ? new Response('{"error":{"code":500,"message":"down"}}', { status: 500 }) : null);
  const r = await hit('/api/chat/send', token, { body: { messages: [{ role: 'user', content: 'Say hello to the cat' }], settings: { providers: ['gemini', 'openai'] } } }); // routed (no override): fallbacks allowed
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.ok(r.events.some((e) => e.type === 'fallback'), 'Gemini failed: the router falls back');
  assert.ok(r.events.some((e) => e.type === 'route' && /^gpt/.test(String(e.data.model && (e.data.model.id || e.data.model)))), 'onto GPT');
  assert.ok(r.events.some((e) => e.type === 'error' && e.data.message === SPEND_COPY.model), 'with the cap’s words');
  assert.equal(calls.filter((c) => c.url.startsWith('https://api.openai.com/')).length, 0, 'the capped provider is never called');
});

test('voice: a Plus account’s speech is counted as paid, a free one’s as unpaid (CREDIT_PACER=warn)', async () => {
  env = makeEnv({ CREDIT_PACER: 'warn', UNLIMITED_EMAILS: 'family@example.com' });
  const fam = await browser('family@example.com');
  assert.equal((await hit('/api/chat/voice', fam, { body: { text: 'Plus words' } })).status, 200);
  let fish = (await companySpendStatus(env)).providers.find((p) => p.id === 'fish');
  assert.ok(fish.paidUSD > 0, JSON.stringify(fish));
  assert.equal(fish.unpaidUSD, 0);
  resetSpendCache();
  const free = await browser('free2@example.com');
  assert.equal((await hit('/api/chat/voice', free, { body: { text: 'Free words' } })).status, 200);
  fish = (await companySpendStatus(env)).providers.find((p) => p.id === 'fish');
  assert.ok(fish.unpaidUSD > 0, JSON.stringify(fish));
});

test('voice: with SPEND_CAP_FISH_USD used up (CREDIT_PACER=on), free voice is refused without a Fish call; Plus still speaks', async () => {
  env = makeEnv({ CREDIT_PACER: 'on', SPEND_CAP_FISH_USD: '0', UNLIMITED_EMAILS: 'family@example.com' });
  const free = await browser();
  const r = await hit('/api/chat/voice', free, { body: { text: 'Free words' } });
  assert.equal(r.status, 429, r.text);
  assert.equal(r.json().error, SPEND_COPY.voice);
  assert.equal(calls.filter((c) => c.url === 'https://api.fish.audio/v1/tts').length, 0);
  const fam = await browser('family@example.com');
  assert.equal((await hit('/api/chat/voice', fam, { body: { text: 'Plus words' } })).status, 200);
  assert.equal(calls.filter((c) => c.url === 'https://api.fish.audio/v1/tts').length, 1);
  // warn: counted only
  env.CREDIT_PACER = 'warn';
  resetSpendCache();
  assert.equal((await hit('/api/chat/voice', free, { body: { text: 'Free words' } })).status, 200);
});
