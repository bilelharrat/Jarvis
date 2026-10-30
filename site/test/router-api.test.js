// Eden Router API, private beta (src/router-api/): admin keys, auth, revoked keys, limits, routing on the client's
// own provider keys, streaming, the one fallback, OpenAI's shapes, and nothing secret or private in logs or storage.
// Fake providers throughout (globalThis.fetch): no real API call.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { RouterApi, LOG_KEEP } from '../src/router-api/store.js';
import { namespace, claudeAnswer, sseBody } from './fakes.js';

const ADMIN = 'admin-token-for-tests-0123456789';
const HOST = 'https://edenrouter.com';
const PROMPT = 'Tell me a secret about lighthouses please';
const OPENAI_KEY = 'sk-proj-client-openai-KEY-123456';
const GEMINI_KEY = 'AIza-client-gemini-KEY-123456';
const ANTHROPIC_KEY = 'sk-ant-client-KEY-123456';

const realFetch = globalThis.fetch;
let env, calls, plan, logs;
const origConsole = {};

const sse = (text) => new Response(new ReadableStream({ start(c) { const b = new TextEncoder().encode(text); for (let i = 0; i < b.length; i += 29) c.enqueue(b.slice(i, i + 29)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
const lines = (objs) => objs.map((o) => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`).join('');

function answer(provider, body, url) {
  if (provider === 'anthropic') return new Response(sseBody(claudeAnswer({ model: body.model, input: 50, output: 20, text: [`${body.model} `, 'says yes.'] })), { headers: { 'content-type': 'text/event-stream' } });
  if (provider === 'gemini') {
    const model = /models\/([^:]+):/.exec(url)[1];
    return sse(lines([{ candidates: [{ content: { parts: [{ text: `${model} ` }] } }] }, { candidates: [{ content: { parts: [{ text: 'says yes.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 15, thoughtsTokenCount: 5 } }]));
  }
  return sse(lines([{ choices: [{ delta: { content: `${body.model} ` } }] }, { choices: [{ delta: { content: 'says yes.' }, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 50, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 5 } } }, '[DONE]']));
}
const providerOf = (u) => (/anthropic\.com/.test(u) ? 'anthropic' : /openai\.com/.test(u) ? 'openai' : /googleapis\.com/.test(u) ? 'gemini' : /moonshot/.test(u) ? 'kimi' : null);

beforeEach(() => {
  env = { ROUTER_HOST: 'edenrouter.com', ROUTER_ADMIN_TOKEN: ADMIN, OPENAI_API_KEY: 'sk-SERVICE-openai-key-999', GEMINI_API_KEY: 'AIza-SERVICE-999' };
  env.ROUTER_API = namespace(RouterApi, env);
  calls = [];
  plan = {}; // provider → 'fail' | 'fail-once'
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const provider = providerOf(url);
    if (!provider) throw new Error(`unexpected fetch ${url}`);
    const body = JSON.parse(init.body);
    const headers = new Headers(init.headers);
    calls.push({ provider, url, body, key: headers.get('authorization') || headers.get('x-api-key') || headers.get('x-goog-api-key') || new URL(url).searchParams.get('key') });
    if (plan[provider] === 'fail' || (plan[provider] === 'fail-once' && calls.filter((c) => c.provider === provider).length === 1)) return new Response(JSON.stringify({ error: { message: 'internal upstream trouble' } }), { status: 500 });
    return answer(provider, body, url);
  };
  logs = [];
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
    origConsole[k] = console[k];
    console[k] = (...a) => logs.push(a.map(String).join(' '));
  }
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(origConsole)) console[k] = origConsole[k];
});

const ctx = () => ({ waitUntil() {}, passThroughOnException() {} });
const admin = (body, token = ADMIN) => worker.fetch(new Request(`${HOST}/api/admin/router`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env, ctx());
async function newClient(extra = {}) {
  const r = await admin({ action: 'create', name: 'Client One', ...extra });
  assert.equal(r.status, 200);
  return r.json();
}
const call = (path, { key, body, method = 'POST', headers = {} } = {}) =>
  worker.fetch(new Request(`${HOST}${path}`, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }), env, ctx());
const chat = (key, body = {}, headers = { 'x-openai-key': OPENAI_KEY }) => call('/v1/chat/completions', { key, headers, body: { model: 'eden-router', messages: [{ role: 'user', content: PROMPT }], ...body } });
const storeText = () => JSON.stringify([...env.ROUTER_API.objects.values()].map((o) => [...o.storage.map]));

async function readSse(r) {
  const text = await r.text();
  return text.split('\n\n').filter(Boolean).map((b) => b.replace(/^data: /, '')).map((d) => (d === '[DONE]' ? d : JSON.parse(d)));
}

// ── admin ──

test('admin: token required, no browser, creates a key shown once and kept hashed', async () => {
  assert.equal((await admin(null, 'wrong-token-wrong-token-wrong')).status, 401);
  assert.equal((await worker.fetch(new Request(`${HOST}/api/admin/router`, { headers: { authorization: `Bearer ${ADMIN}`, origin: 'https://evil.example' } }), env, ctx())).status, 403);
  const short = { ...env, ROUTER_ADMIN_TOKEN: 'short' };
  assert.equal((await worker.fetch(new Request(`${HOST}/api/admin/router`, { headers: { authorization: 'Bearer short' } }), short, ctx())).status, 503);
  const made = await newClient({ rpm: 5, daily_usd: 2 });
  assert.match(made.api_key, /^sk-eden-[A-Za-z0-9_-]{43}$/);
  assert.equal(made.client.rpm, 5);
  assert.equal(made.client.service_keys, false);
  assert.ok(!storeText().includes(made.api_key), 'the key itself is never stored');
  const list = await (await admin()).json();
  assert.equal(list.clients.length, 1);
  assert.ok(!JSON.stringify(list).includes('hash'));
  assert.equal((await admin({ action: 'create', rpm: -1 })).status, 400);
});

// ── auth ──

test('auth: missing, malformed, unknown and revoked keys are refused in OpenAI error shape', async () => {
  const { api_key, client } = await newClient();
  let r = await chat(null);
  assert.equal(r.status, 401);
  let e = await r.json();
  assert.equal(e.error.code, 'missing_api_key');
  assert.equal(e.error.type, 'authentication_error');
  assert.equal((await (await chat('sk-eden-short')).json()).error.code, 'invalid_api_key');
  assert.equal((await chat(`sk-eden-${'A'.repeat(43)}`)).status, 401);
  assert.equal((await chat(api_key)).status, 200);
  assert.equal((await admin({ action: 'revoke', id: client.id })).status, 200);
  r = await chat(api_key);
  assert.equal(r.status, 401);
  e = await r.json();
  assert.equal(e.error.code, 'revoked_api_key');
  assert.equal(calls.length, 1, 'no provider call after revocation');
});

test('no CORS: a request with an Origin is refused, OPTIONS too; /v1 only on the router host', async () => {
  const { api_key } = await newClient();
  const r = await call('/v1/models', { key: api_key, method: 'GET', headers: { origin: 'https://site.example' } });
  assert.equal(r.status, 403);
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  assert.equal((await call('/v1/models', { key: api_key, method: 'OPTIONS' })).status, 405);
  const other = await worker.fetch(new Request('https://askeden.com/v1/models', { headers: { authorization: `Bearer ${api_key}` } }), env, ctx());
  assert.notEqual(other.headers.get('content-type'), 'application/json');
});

// ── routing and the OpenAI shape ──

test('chat (non-streaming): OpenAI chat.completion shape, routed among the client keys only, x_eden block', async () => {
  const { api_key } = await newClient();
  const r = await chat(api_key, { messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: [{ type: 'text', text: PROMPT }] }] });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.object, 'chat.completion');
  assert.match(j.id, /^chatcmpl-/);
  assert.equal(typeof j.created, 'number');
  assert.equal(j.choices.length, 1);
  assert.equal(j.choices[0].message.role, 'assistant');
  assert.match(j.choices[0].message.content, /says yes\./);
  assert.equal(j.choices[0].finish_reason, 'stop');
  assert.equal(j.usage.prompt_tokens, 50);
  assert.equal(j.usage.total_tokens, j.usage.prompt_tokens + j.usage.completion_tokens);
  assert.equal(j.x_eden.provider, 'openai', 'only OpenAI had a key');
  assert.equal(j.model, j.x_eden.model);
  assert.ok(j.x_eden.effort);
  assert.ok(j.x_eden.estimated_cost_usd > 0 && j.x_eden.actual_cost_usd > 0);
  assert.ok(j.x_eden.rationale.length > 10);
  assert.equal(j.x_eden.key_source, 'client');
  assert.equal(j.x_eden.fallback, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'openai');
  assert.ok(calls[0].key.includes(OPENAI_KEY), "the client's own key, not the Worker's");
  assert.ok(JSON.stringify(calls[0].body).includes('Be brief.'));
});

test('routing follows the level, x_eden.providers and the keys sent; service keys only when the client may', async () => {
  const { api_key } = await newClient();
  const both = { 'x-openai-key': OPENAI_KEY, 'x-gemini-key': GEMINI_KEY };
  const r = await chat(api_key, { x_eden: { providers: ['gemini'] } }, both);
  assert.equal((await r.json()).x_eden.provider, 'gemini');
  const lo = await (await call('/v1/route', { key: api_key, headers: both, body: { model: 'eden-router:level-1', messages: [{ role: 'user', content: 'Prove the Riemann hypothesis step by step with full rigor' }] } })).json();
  const hi = await (await call('/v1/route', { key: api_key, headers: both, body: { model: 'eden-router:level-5', messages: [{ role: 'user', content: 'Prove the Riemann hypothesis step by step with full rigor' }] } })).json();
  assert.equal(lo.x_eden.level, 1);
  assert.equal(hi.x_eden.level, 5);
  assert.ok(lo.x_eden.estimated_cost_usd <= hi.x_eden.estimated_cost_usd);
  const sliders = await (await call('/v1/route', { key: api_key, headers: both, body: { model: 'eden-router', x_eden: { efficiency: 90, performance: 20 }, messages: [{ role: 'user', content: 'hi' }] } })).json();
  assert.equal(sliders.x_eden.efficiency, 90);
  // no key sent and no service keys: refused, no call
  const none = await chat(api_key, {}, {});
  assert.equal(none.status, 400);
  assert.match((await none.json()).error.message, /x-openai-key/);
  // a client allowed the Worker's keys
  const svc = await newClient({ service_keys: true });
  const s = await (await chat(svc.api_key, {}, {})).json();
  assert.equal(s.x_eden.key_source, 'service');
  assert.ok(['openai', 'gemini'].includes(s.x_eden.provider));
});

test('/v1/route makes no provider call; /v1/models lists the levels; bad requests are clear', async () => {
  const { api_key } = await newClient();
  const r = await call('/v1/route', { key: api_key, headers: { 'x-anthropic-key': ANTHROPIC_KEY }, body: { model: 'eden-router', messages: [{ role: 'user', content: PROMPT }] } });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.object, 'eden.route');
  assert.equal(j.x_eden.provider, 'anthropic');
  assert.ok(j.x_eden.request && j.x_eden.request.params);
  assert.equal(calls.length, 0);
  const m = await (await call('/v1/models', { key: api_key, method: 'GET' })).json();
  assert.equal(m.object, 'list');
  assert.deepEqual(m.data.map((x) => x.id), ['eden-router', 'eden-router:level-1', 'eden-router:level-2', 'eden-router:level-3', 'eden-router:level-4', 'eden-router:level-5']);
  const unknown = await chat(api_key, { model: 'gpt-4o' });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, 'model_not_found');
  assert.equal((await chat(api_key, { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] })).status, 400);
  assert.equal((await chat(api_key, { tools: 'not-an-array' })).status, 400);
  assert.equal((await chat(api_key, { x_eden: { efficiency: 200 } })).status, 400);
  assert.equal((await call('/v1/nope', { key: api_key })).status, 404);
  assert.equal(calls.length, 0);
});

// ── streaming ──

test('streaming: OpenAI chunks, x_eden on the last one, usage when asked, [DONE]', async () => {
  const { api_key } = await newClient();
  const r = await chat(api_key, { stream: true, stream_options: { include_usage: true } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const ev = await readSse(r);
  assert.equal(ev.at(-1), '[DONE]');
  const chunks = ev.filter((e) => e !== '[DONE]');
  assert.ok(chunks.every((c) => c.object === 'chat.completion.chunk' && c.id === chunks[0].id));
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  const text = chunks.map((c) => (c.choices[0] && c.choices[0].delta.content) || '').join('');
  assert.match(text, /says yes\./);
  const last = chunks.find((c) => c.choices[0] && c.choices[0].finish_reason);
  assert.equal(last.choices[0].finish_reason, 'stop');
  assert.equal(last.x_eden.provider, 'openai');
  const usage = chunks.at(-1);
  assert.deepEqual(usage.choices, []);
  assert.equal(usage.usage.prompt_tokens, 50);
});

// ── fallback ──

test('fallback: a provider error before any text goes once to the next pick; both failing is a clear 502', async () => {
  const { api_key } = await newClient();
  const both = { 'x-openai-key': OPENAI_KEY, 'x-gemini-key': GEMINI_KEY };
  const first = (await (await call('/v1/route', { key: api_key, headers: both, body: { model: 'eden-router', messages: [{ role: 'user', content: PROMPT }] } })).json()).x_eden;
  plan[first.provider] = 'fail-once';
  const j = await (await chat(api_key, {}, both)).json();
  assert.equal(j.x_eden.fallback.from, first.model);
  assert.notEqual(j.x_eden.model, first.model);
  assert.match(j.choices[0].message.content, /says yes/);
  assert.equal(calls.length, 2);
  // streamed fallback
  calls = [];
  plan = { [first.provider]: 'fail-once' };
  const ev = await readSse(await chat(api_key, { stream: true }, both));
  assert.equal(ev.find((c) => c.x_eden).x_eden.fallback.from, first.model);
  // everything failing: one retry only, then an OpenAI-style error (streamed or not)
  calls = [];
  plan = { openai: 'fail', gemini: 'fail' };
  const r = await chat(api_key, {}, both);
  assert.equal(r.status, 502);
  const e = await r.json();
  assert.equal(e.error.code, 'provider_error');
  assert.equal(e.error.upstream_status, 500);
  assert.equal(calls.length, 2);
  const s = await chat(api_key, { stream: true }, both);
  assert.equal(s.status, 502);
  assert.equal((await s.json()).error.type, 'api_error');
});

// ── limits and usage ──

test('limits: requests a minute (429 + Retry-After) and the daily spend cap', async () => {
  const { api_key, client } = await newClient({ rpm: 2 });
  assert.equal((await chat(api_key)).status, 200);
  assert.equal((await chat(api_key)).status, 200);
  const r = await chat(api_key);
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.equal((await r.json()).error.code, 'rate_limit_exceeded');
  const capped = await newClient({ daily_usd: 0 });
  const c = await chat(capped.api_key);
  assert.equal(c.status, 429);
  const e = await c.json();
  assert.equal(e.error.code, 'daily_spend_cap');
  assert.equal(e.error.type, 'insufficient_quota');
  assert.equal(calls.length, 2);
  assert.equal((await admin({ action: 'update', id: client.id, rpm: 100 })).status, 200);
  assert.equal((await chat(api_key)).status, 200);
});

test('usage: GET /v1/usage has the client lines and totals, numbers only; old lines are trimmed', async () => {
  const { api_key, client } = await newClient();
  await chat(api_key);
  await chat(api_key, { stream: true }).then((r) => r.text());
  await call('/v1/route', { key: api_key, headers: { 'x-openai-key': OPENAI_KEY }, body: { model: 'eden-router', messages: [{ role: 'user', content: PROMPT }] } });
  const u = await (await call('/v1/usage', { key: api_key, method: 'GET' })).json();
  assert.equal(u.object, 'eden.usage');
  assert.equal(u.data.length, 3);
  assert.deepEqual(u.data.map((x) => x.kind), ['route', 'chat', 'chat']);
  const line = u.data[2];
  for (const k of ['time', 'model', 'provider', 'effort', 'tokens_in', 'tokens_out', 'cost_usd', 'latency_ms', 'status']) assert.ok(k in line, k);
  assert.equal(line.status, 200);
  assert.equal(u.data[1].stream, true);
  assert.equal(u.daily[0].requests, 3);
  assert.ok(u.spent_today_usd > 0);
  assert.equal(u.limits.daily_usd, 10);
  // the admin sees the same
  assert.equal((await (await admin({ action: 'usage', id: client.id })).json()).data.length, 3);
  // trimming past LOG_KEEP
  const obj = [...env.ROUTER_API.objects.values()][0];
  for (let i = 0; i < 3; i++) await obj.record({ id: client.id, entry: { status: 200 } });
  await obj.storage.put(`seq:${client.id}`, LOG_KEEP + 10);
  await obj.record({ id: client.id, entry: { status: 200 } });
  assert.ok(![...obj.storage.map.keys()].includes(`log:${client.id}:${String(11).padStart(12, '0')}`));
});

test('privacy: no API key, provider key, prompt or answer in logs or storage', async () => {
  const { api_key } = await newClient();
  const headers = { 'x-openai-key': OPENAI_KEY, 'x-gemini-key': GEMINI_KEY, 'x-anthropic-key': ANTHROPIC_KEY };
  await chat(api_key, {}, headers);
  await chat(api_key, { stream: true }, headers).then((r) => r.text());
  plan = { openai: 'fail', gemini: 'fail', anthropic: 'fail' };
  await chat(api_key, {}, headers);
  await chat(api_key, { model: 'nope' }, headers);
  const everything = logs.join('\n') + storeText();
  for (const secret of [api_key, OPENAI_KEY, GEMINI_KEY, ANTHROPIC_KEY, PROMPT, 'says yes', 'lighthouse']) assert.ok(!everything.includes(secret), `leaked: ${secret}`);
});

test('v2 endpoints: risk_aware routing, /v1/route/failover, /v1/route/cascade, and /v1/route/batch', async () => {
  const { api_key } = await newClient();
  const headers = { 'x-openai-key': OPENAI_KEY, 'x-gemini-key': GEMINI_KEY, 'x-anthropic-key': ANTHROPIC_KEY };

  const routed = await (await call('/v1/route', { key: api_key, headers, body: { model: 'eden-router', messages: [{ role: 'user', content: 'What is the maximum safe dosage of amoxicillin for a child with renal impairment?' }], x_eden: { risk_aware: true } } })).json();
  assert.equal(routed.object, 'eden.route');
  assert.equal(typeof routed.x_eden.reliability, 'number');
  assert.ok(routed.x_eden.risk);
  assert.equal(routed.x_eden.risk.level, 'high');

  const failover = await (await call('/v1/route/failover', { key: api_key, headers, body: { prompt: PROMPT } })).json();
  assert.equal(failover.object, 'eden.route.failover');
  assert.ok(failover.chain.length >= 2);
  const providers = new Set(failover.chain.map((c) => c.provider));
  assert.equal(providers.size, failover.chain.length, 'provider-diverse failover chain');

  const cascade = await (await call('/v1/route/cascade', { key: api_key, headers, body: { prompt: 'What is the maximum safe dosage of warfarin?' } })).json();
  assert.equal(cascade.object, 'eden.route.cascade');
  assert.equal(cascade.use_cascade, false, 'high hallucination-risk query disables speculative drafter');

  const batch = await (await call('/v1/route/batch', { key: api_key, headers, body: { prompts: ['Hello there', 'Write a distributed Raft consensus engine in Rust'], max_total_cost_usd: 0.0001 } })).json();
  assert.equal(batch.object, 'eden.route.batch');
  assert.equal(batch.count, 2);
  assert.equal(typeof batch.average_reliability, 'number');

  // Health & OpenAPI without auth
  const healthRes = await call('/v1/health', { method: 'GET' });
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json();
  assert.equal(health.status, 'ok');

  const specRes = await call('/v1/openapi.json', { method: 'GET' });
  assert.equal(specRes.status, 200);
  assert.equal((await specRes.json()).openapi, '3.1.0');

  // /v1/analyze and /v1/risk
  const analyzed = await (await call('/v1/analyze', { key: api_key, body: { prompt: 'Prove that sqrt(2) is irrational.' } })).json();
  assert.equal(analyzed.object, 'eden.analyze');
  assert.ok(analyzed.risk);

  const riskRes = await (await call('/v1/risk', { key: api_key, body: { prompt: 'What is the exact dosage of methotrexate?' } })).json();
  assert.equal(riskRes.object, 'eden.risk');
  assert.equal(riskRes.risk.level, 'high');
  assert.ok(Array.isArray(riskRes.top_reliable_models) && riskRes.top_reliable_models.length > 0);

  // Multimodal base64 image + tools + sampling params
  const mmChat = await chat(
    api_key,
    {
      temperature: 0.3,
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' } },
          ],
        },
      ],
    },
    headers,
  );
  assert.equal(mmChat.status, 200);

  // Usage logs preserve distinct kinds (failover, cascade, batch, analyze, risk, route, chat)
  const usage = await (await call('/v1/usage', { key: api_key, method: 'GET' })).json();
  const kinds = new Set(usage.data.map((d) => d.kind));
  for (const k of ['route', 'failover', 'cascade', 'batch', 'analyze', 'risk', 'chat']) {
    assert.ok(kinds.has(k), `expected usage log kind ${k}`);
  }
});
