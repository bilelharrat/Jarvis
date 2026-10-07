// Hosted Eden on every provider (askeden.com): Anthropic, OpenAI, Gemini and Moonshot Kimi, streamed
// with the Mac's own code (src/eden/providers.js, vendor/providers.js) against fake endpoints — the
// candidate set following the keys, each provider's stream and its billing at list price, a stopped
// stream billed for what it used, holds, the fallback, compare mixing providers, the caps, vision.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { forgetSessions } from '../src/eden/session.js';
import { CLAUDE_NEEDS_KEY, DEFAULT_MODEL, KEYS_SETTINGS, defaultModel, devProviderBase, modelOf, providerKey, testOnlyServiceClaude, usageUSD } from '../src/eden/providers.js';
import { Account, Link, appleJwk, claudeAnswer, identityToken, namespace, readEvents, sseBody } from './fakes.js';

const PROVIDER_URLS = [
  ['anthropic', /^https:\/\/api\.anthropic\.com\/v1\/messages$/],
  ['openai', /^https:\/\/api\.openai\.com\/v1\/chat\/completions$/],
  ['kimi', /^https:\/\/api\.moonshot\.ai\/v1\/chat\/completions$/],
  ['gemini', /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\//],
];

/** Raw SSE text as a body, in pieces; `hold`: it never ends (until cancelled). */
function rawSse(text, { hold = false } = {}) {
  const bytes = new TextEncoder().encode(text);
  let cancelled = false;
  const body = new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += 23) c.enqueue(bytes.slice(i, i + 23));
      if (!hold) c.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  body.wasCancelled = () => cancelled;
  return body;
}
const sse = (body) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
const lines = (objs) => objs.map((o) => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`).join('');

/** A finished answer from each provider, in its own wire format: "<model> says yes." */
function answer(provider, body, url) {
  if (provider === 'anthropic') return sse(sseBody(claudeAnswer({ model: body.model, input: 500, output: 200, text: [`${body.model} `, 'says yes.'] })));
  if (provider === 'gemini') {
    const model = /models\/([^:]+):/.exec(url)[1];
    return sse(rawSse(lines([
      { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: `${model} says yes.` }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 150, thoughtsTokenCount: 50 } },
    ])));
  }
  const usage = { prompt_tokens: 500, completion_tokens: 200, ...(provider === 'openai' ? { completion_tokens_details: { reasoning_tokens: 50 } } : {}) };
  return sse(rawSse(lines([
    { choices: [{ delta: provider === 'kimi' ? { reasoning_content: 'hmm' } : { content: '' } }] },
    { choices: [{ delta: { content: `${body.model} says yes.` }, finish_reason: 'stop' }] },
    provider === 'kimi' ? { choices: [{ delta: {}, usage }] } : { choices: [], usage },
    '[DONE]',
  ])));
}

const ORIGIN = 'https://askeden.com';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';

// ── the Worker with fakes (as eden.test.js) ──

let env;
let waits;
let calls;
let fake; // (provider, body, url) => Response
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;

function makeEnv() {
  const e = { ANTHROPIC_API_KEY: 'sk-test', OPENAI_API_KEY: 'sk-openai-test', GEMINI_API_KEY: 'gm-test', MOONSHOT_API_KEY: 'ms-test', TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20' };
  e.ACCOUNTS = namespace(Account, e);
  e.LINKS = namespace(Link, e);
  e.ASSETS = { fetch: async () => new Response('asset') };
  return e;
}

beforeEach(() => {
  waits = [];
  calls = [];
  forgetAppleKeys();
  forgetSessions();
  fake = answer;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    const provider = PROVIDER_URLS.find(([, re]) => re.test(url));
    if (provider) {
      if (/:generateContent/.test(url)) return new Response('{"error":{"message":"no rating in tests"}}', { status: 500 }); // the Gemini rating: rules instead
      const body = JSON.parse(init.body);
      calls.push({ provider: provider[0], url, body, headers: init.headers });
      return fake(provider[0], body, url, init);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  env = makeEnv();
});

after(() => {
  globalThis.fetch = realFetch;
});

async function settle() {
  while (waits.length) await Promise.all(waits.splice(0));
}

async function hit(p, { method = 'GET', body, headers = {}, browser = true, session, token, raw = false } = {}) {
  const h = { ...headers };
  if (browser) {
    h['user-agent'] ??= SAFARI;
    if (method !== 'GET' && method !== 'HEAD') h.origin ??= ORIGIN;
  }
  if (session) h.cookie = [`__Host-eden=${session}`, h.cookie].filter(Boolean).join('; ');
  if (token) h.authorization = `Bearer ${token}`;
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    h['content-type'] ??= 'application/json';
  }
  const response = await worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
  if (!raw) await settle();
  return response;
}

const cookieValue = (response, name) => {
  const found = (response.headers.getSetCookie ? response.headers.getSetCookie() : []).find((c) => c.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1).split(';')[0] : undefined;
};

async function phone() {
  const response = await hit('/api/account/apple', {
    method: 'POST',
    browser: false,
    body: { identity_token: await identityToken({ sub: 'apple-user-1' }), nonce: 'raw-nonce', device: { name: "Bilel's iPhone", kind: 'iphone' } },
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

async function signedInBrowser(owner) {
  const started = await hit('/api/web/link', { method: 'POST', body: {} });
  const link = await started.json();
  const cookie = `__Host-eden-link=${cookieValue(started, '__Host-eden-link')}`;
  const approved = await hit(`/api/link/${link.code}/approve`, { method: 'POST', browser: false, token: owner.token, body: { sealed_key: null, sender_key: null } });
  assert.equal(approved.status, 200, await approved.clone().text());
  const done = await hit('/api/web/link/poll', { method: 'POST', body: {}, headers: { cookie } });
  return cookieValue(done, '__Host-eden');
}

const chat = (p, session, opts = {}) => hit(p, { session, ...opts, headers: { 'x-jarvis-chat': '1', ...(opts.headers || {}) } });
const accountOf = (owner) => env.ACCOUNTS.objects.get(owner.account.id);
const trialLeft = async (owner) => (await (await hit('/api/account', { browser: false, token: owner.token })).json()).usage.trial_left_usd;
const turn = (session, body, opts) => chat('/api/chat/send', session, { method: 'POST', ...opts, body: { messages: [{ role: 'user', content: 'Is a tomato a fruit or a vegetable?' }], settings: { level: 3 }, ...body } });

test('the candidate set follows the keys: meta lists every keyed provider’s models; switching one off or removing its key shrinks it', async () => {
  const value = await signedInBrowser(await phone());
  const meta = await (await chat('/api/chat/meta', value)).json();
  assert.deepEqual(meta.providers.map((p) => [p.id, p.available]), [['anthropic', true], ['openai', true], ['gemini', true], ['kimi', true]]);
  assert.deepEqual(new Set(meta.models.map((m) => m.provider)), new Set(['anthropic', 'openai', 'gemini', 'kimi']));
  assert.ok(meta.models.every((m) => m.keySource === 'service' && !m.efforts.includes('xhigh')));
  assert.equal(meta.models.find((m) => m.id === 'kimi-k2.7-code').vision, false);
  assert.equal(meta.models.find((m) => m.id === 'gpt-6-sol').vision, true);
  assert.equal(meta.classifier.available, true);
  assert.equal(meta.search.via, 'gemini');
  delete env.OPENAI_API_KEY;
  env.EDEN_GEMINI = 'off';
  const less = await (await chat('/api/chat/meta', value)).json();
  assert.deepEqual([...new Set(less.models.map((m) => m.provider))].sort(), ['anthropic', 'kimi']);
  assert.match(less.providers.find((p) => p.id === 'openai').reason, /No OpenAI API key/);
  assert.equal(less.classifier.available, false);
  assert.equal(less.search.via, 'anthropic');
  const preview = await (await hit('/api/route', { method: 'POST', session: value, body: { prompt: 'Prove there are infinitely many primes.', level: 3 } })).json();
  assert.ok(['anthropic', 'kimi'].includes(preview.pick.provider ?? modelOf(preview.pick.model).provider));
});

test('each provider streams with the Mac’s code and is billed at its list price; the caps reach every request', async () => {
  const owner = await phone();
  const value = await signedInBrowser(owner);
  let spent = 0;
  for (const [model, label] of [['gpt-6-sol', 'OpenAI cloud'], ['gemini-3.8-flash', 'Google cloud'], ['kimi-k3', 'Moonshot cloud'], ['claude-sonnet-5-5', 'Anthropic cloud']]) {
    const events = await readEvents(await turn(value, { override: { model, effort: 'max' }, settings: { level: 3, classifier: 'off' } }));
    const route = events.find((e) => e.type === 'route').data;
    assert.equal(route.where.label, label, model);
    assert.equal(route.provider, modelOf(model).provider);
    assert.ok(!['xhigh', 'max'].includes(route.effort), `${model} effort capped: ${route.effort}`);
    assert.match(events.filter((e) => e.type === 'text').map((e) => e.data.text).join(''), new RegExp(`${model} says yes\\.`));
    const usage = events.find((e) => e.type === 'usage').data;
    assert.equal(usage.costUSD, usageUSD(modelOf(model), usage), model);
    assert.ok(usage.costUSD > 0);
    assert.deepEqual(events.at(-1), { type: 'done', data: { finish: 'stop' } });
    spent += usage.costUSD;
  }
  const [openai, gemini, kimi, claude] = calls;
  assert.ok(openai.body.max_completion_tokens <= 16000 && openai.body.stream_options.include_usage && openai.headers.authorization === 'Bearer sk-openai-test');
  assert.ok(gemini.body.generationConfig.maxOutputTokens <= 16000 && gemini.headers['x-goog-api-key'] === 'gm-test');
  assert.ok(kimi.body.max_completion_tokens <= 16000 && kimi.body.reasoning_effort === 'high');
  assert.ok(claude.body.max_tokens <= 16000);
  assert.ok(Math.abs((await trialLeft(owner)) - (1 - spent)) < 1e-5);
  assert.equal(accountOf(owner).holds.size, 0);
});

test('a stopped stream is held up front and billed for what it used (estimated where the provider hadn’t reported)', async () => {
  const owner = await phone();
  const value = await signedInBrowser(owner);
  let body;
  fake = () => sse((body = rawSse(lines([{ choices: [{ delta: { content: 'x'.repeat(300) } }] }]), { hold: true })));
  const response = await turn(value, { override: { model: 'gpt-6-sol', effort: 'none' }, settings: { classifier: 'off' } }, { raw: true });
  assert.equal(response.status, 200);
  assert.equal(accountOf(owner).holds.size, 1, 'the worst case is held');
  const reader = response.body.getReader();
  let text = '';
  while (!text.includes('xxx')) text += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel(); // Stop
  await settle();
  assert.ok(body.wasCancelled(), 'the request to OpenAI is cancelled');
  assert.equal(accountOf(owner).holds.size, 0);
  const left = await trialLeft(owner);
  const m = modelOf('gpt-6-sol');
  const floor = (100 * m.pricing.outputPer1M) / 1e6; // 300 characters → 100 tokens at least
  assert.ok(1 - left >= floor, `charged ${1 - left}`);
});

test('a provider error before any text falls back to the router’s next choice on another model', async () => {
  const value = await signedInBrowser(await phone());
  let n = 0;
  fake = (provider, body, url) => (n++ === 0 ? new Response('{"error":{"message":"rate limited"}}', { status: 429 }) : answer(provider, body, url));
  const events = await readEvents(await turn(value, { settings: { level: 3, classifier: 'off' } }));
  const routes = events.filter((e) => e.type === 'route');
  assert.equal(routes.length, 2);
  assert.match(events.find((e) => e.type === 'fallback').data.reason, /busy right now \(HTTP 429\)/);
  assert.notEqual(routes[0].data.model, routes[1].data.model);
  assert.equal(events.at(-1).type, 'done', JSON.stringify(events.at(-1)));
});

test('compare mixes providers: Claude, GPT and Gemini lanes under one hold, the cheapest summary, every stream counted', async () => {
  const owner = await phone();
  const value = await signedInBrowser(owner);
  const lanes = [{ model: 'claude-sonnet-5-5', effort: 'low' }, { model: 'gpt-6-sol', effort: 'low' }, { model: 'gemini-3.8-flash', effort: 'low' }];
  const events = await readEvents(await chat('/api/chat/compare', value, { method: 'POST', body: { messages: [{ role: 'user', content: 'Is a tomato a fruit?' }], settings: { level: 3 }, models: lanes } }));
  const head = events[0].data;
  assert.deepEqual(head.lanes.map((l) => l.provider), ['anthropic', 'openai', 'gemini']);
  assert.equal(head.synthesis.model, 'gpt-6-luna', 'the cheapest model writes the summary');
  for (const lane of [0, 1, 2]) assert.deepEqual([...new Set(events.filter((e) => e.data.lane === lane).map((e) => e.type).filter((t) => t !== 'thinking'))], ['text', 'usage', 'done'], `lane ${lane}`);
  assert.equal(events.at(-1).type, 'end');
  const spent = events.filter((e) => e.type === 'usage').reduce((n, e) => n + e.data.costUSD, 0);
  assert.ok(Math.abs((await trialLeft(owner)) - (1 - spent)) < 1e-5);
  assert.equal(accountOf(owner).holds.size, 0);
});

test('vision: images go only to vision models; a non-vision pick or provider set is refused', async () => {
  const value = await signedInBrowser(await phone());
  const image = { role: 'user', content: 'What is this?', attachments: [{ kind: 'image', mime: 'image/png', data: 'iVBORw0KGgo=' }] };
  const kimiOnly = await turn(value, { messages: [image], override: { model: 'kimi-k2.7-code' } });
  assert.equal(kimiOnly.status, 422);
  const events = await readEvents(await turn(value, { messages: [image], settings: { level: 1, providers: ['kimi', 'openai'], classifier: 'off' } }));
  const route = events.find((e) => e.type === 'route').data;
  assert.ok(route.model !== 'kimi-k2.7-code' && route.model !== 'kimi-k2.7-code-highspeed', route.model);
  const sent = calls.at(-1).body.messages.at(-1).content;
  assert.ok(Array.isArray(sent) && sent.some((p) => p.type === 'image_url'), 'the image went as an image');
});

test('fake provider endpoints are honoured only for a local request and a loopback http base', () => {
  const env2 = { EDEN_FAKE_PROVIDER_BASE: 'http://127.0.0.1:8899' };
  assert.equal(devProviderBase(env2, new Request('http://multi.localhost:8814/api/chat/send')), 'http://127.0.0.1:8899');
  assert.equal(devProviderBase(env2, new Request('https://askeden.com/api/chat/send')), null);
  assert.equal(devProviderBase({ EDEN_FAKE_PROVIDER_BASE: 'https://evil.example' }, new Request('http://localhost/')), null);
});

test('Claude is bring-your-own-key: no service Anthropic key for anyone; its models are listed locked; Gemini is the default; the router never picks Claude', async () => {
  testOnlyServiceClaude(false); // the real rule (fakes.js turns it back on for the older suites)
  try {
    assert.equal(await providerKey(env, null, 'anthropic'), null, 'ANTHROPIC_API_KEY is set, and still not used');
    assert.deepEqual(await providerKey(env, null, 'gemini'), { key: 'gm-test', source: 'service' });
    const owner = await phone();
    const value = await signedInBrowser(owner);
    const meta = await (await chat('/api/chat/meta', value)).json();
    const claude = meta.providers.find((p) => p.id === 'anthropic');
    assert.deepEqual([claude.available, claude.reason, claude.needsKey, claude.link], [false, CLAUDE_NEEDS_KEY, true, KEYS_SETTINGS]);
    const locked = meta.models.filter((m) => m.provider === 'anthropic');
    assert.ok(locked.length > 0 && locked.every((m) => m.available === false && m.needsKey === true && m.reason === CLAUDE_NEEDS_KEY && m.link === KEYS_SETTINGS));
    assert.ok(meta.models.filter((m) => m.provider !== 'anthropic').every((m) => m.available && m.keySource === 'service'));
    assert.equal(meta.defaultModel, DEFAULT_MODEL);
    assert.equal(modelOf(DEFAULT_MODEL).provider, 'gemini');
    // The router, at every level, over the hard prompts Claude used to win: never Claude.
    for (const level of [1, 3, 5]) {
      const preview = await (await hit('/api/route', { method: 'POST', session: value, body: { prompt: 'Refactor this 2,000-line TypeScript service and prove the invariants hold.', level } })).json();
      assert.notEqual(preview.pick.provider ?? modelOf(preview.pick.model).provider, 'anthropic', `level ${level}`);
    }
    const events = await readEvents(await turn(value, { settings: { level: 5, classifier: 'off' } }));
    assert.notEqual(events.find((e) => e.type === 'route').data.provider, 'anthropic');
    // A Claude pick (a stale override) is refused in words, and nothing goes to Anthropic.
    const picked = await turn(value, { override: { model: 'claude-sonnet-5-5' } });
    assert.equal(picked.status, 422);
    assert.deepEqual(await picked.json(), { error: `${CLAUDE_NEEDS_KEY}.`, code: 'needs_key' });
    assert.ok(calls.every((c) => c.provider !== 'anthropic'));
  } finally {
    testOnlyServiceClaude(true);
  }
});

test('the default model: Gemini Flash when there, else the cheapest non-Claude model, never Claude', () => {
  const cfg = (ids) => ({ models: ids.map(modelOf) });
  assert.equal(defaultModel(cfg(['claude-haiku-4-5', 'gpt-6-luna', 'gemini-3.8-flash'])), 'gemini-3.8-flash');
  assert.equal(modelOf(defaultModel(cfg(['claude-haiku-4-5', 'gpt-6-sol', 'gpt-6-luna']))).provider, 'openai');
  assert.equal(defaultModel(cfg(['claude-haiku-4-5', 'claude-opus-5-5'])), null);
});
