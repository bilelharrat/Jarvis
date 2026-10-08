// Web search for GPT models on askeden.com: OpenAI's Responses API web_search tool through the
// Mac's own stream code (vendor/providers.js), the providers that may answer a search turn, and
// what a search is metered at. Fake fetch and a hand-written Responses stream; nothing is called.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { OPENAI_SEARCH_USD, fitCall, modelOf, narrowFor, searchProvider, searchUSD, streamCall, usageUSD } from '../src/eden/providers.js';

const STREAM = [
  ['response.output_item.done', { type: 'response.output_item.done', item: { id: 'ws_1', type: 'web_search_call', status: 'completed' } }],
  ['response.output_text.delta', { type: 'response.output_text.delta', delta: 'Lisbon is sunny, ' }],
  ['response.output_text.delta', { type: 'response.output_text.delta', delta: '21 degrees.' }],
  ['response.output_text.annotation.added', { type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', url: 'https://ipma.pt/en?utm_source=openai', title: 'IPMA' } }],
  ['response.output_item.done', { type: 'response.output_item.done', item: { id: 'ws_2', type: 'web_search_call', status: 'completed' } }],
  ['response.completed', { type: 'response.completed', response: { usage: { input_tokens: 1000, output_tokens: 300, output_tokens_details: { reasoning_tokens: 100 } } } }],
].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const cfg = (ids) => ({ models: ids.map(modelOf), locked: [] });
const LUNA = 'gpt-6-luna';
const luna = (effort = 'medium') => ({ provider: 'openai', params: { model: LUNA, max_completion_tokens: 4000, reasoning_effort: effort } });

test('narrowFor: a search turn may use Gemini, GPT and Claude, Gemini first; Kimi is out', () => {
  const ids = ['gemini-3.8-flash', LUNA, 'claude-sonnet-5-5', 'kimi-k3'].filter(modelOf);
  const out = narrowFor(cfg(ids), { mode: 'search' });
  assert.ok(out.models.some((m) => m.provider === 'openai'), 'GPT can search now');
  assert.ok(!out.models.some((m) => m.provider === 'kimi'));
  assert.equal(out.models[0].provider, 'gemini');
  assert.equal(narrowFor(cfg([LUNA]), { mode: 'research' }).models[0].id, LUNA);
  assert.equal(narrowFor(cfg([LUNA]), { mode: 'search', override: { model: LUNA } }).models.length, 1);
  assert.equal(searchProvider(cfg([LUNA])), 'openai');
  assert.equal(searchProvider(cfg(['gemini-3.8-flash', LUNA])), 'gemini');
  assert.throws(() => narrowFor(cfg(['kimi-k3'].filter(modelOf)), { mode: 'search' }), /Gemini, GPT or Claude/);
});

test('metering: each OpenAI search call is $0.01 on top of the tokens', () => {
  const m = modelOf(LUNA);
  assert.equal(OPENAI_SEARCH_USD, 0.01);
  assert.equal(searchUSD(m, 3), 0.03);
  assert.equal(searchUSD(m, 0), 0);
  const plain = usageUSD(m, { inputTokens: 1000, outputTokens: 200 });
  assert.ok(Math.abs(usageUSD(m, { inputTokens: 1000, outputTokens: 200, webSearches: 2 }) - plain - 0.02) < 1e-9);
});

test('fitCall: a GPT search turn’s worst case includes the searches and the pages they read; too little money is a search shortfall', () => {
  const m = modelOf(LUNA);
  const request = luna();
  const none = fitCall(m, request, { leftUSD: 1, inputTokens: 500, searches: 0, maxTokens: 2000 });
  const five = fitCall(m, request, { leftUSD: 1, inputTokens: 500, searches: 5, maxTokens: 2000, resultTokens: 10_000 });
  assert.equal(five.uses, 5);
  assert.ok(five.worstUSD - none.worstUSD >= 0.05, 'five searches at $0.01 are held');
  assert.ok(five.worstUSD - none.worstUSD >= 0.05 + (5 * 10_000 * 0.1) / 1e6 - 1e-6, 'and their pages as input');
  assert.deepEqual(fitCall(m, request, { leftUSD: 0.004, inputTokens: 500, searches: 5, maxTokens: 2000 }), { short: 'search' });
  assert.equal(fitCall(m, request, { leftUSD: 0.03, inputTokens: 500, searches: 5, maxTokens: 2000 }).uses < 5, true, 'fewer searches when money is short');
});

test('streamCall: a GPT search turn calls the Responses API, streams text, parses url_citation sources and counts the searches', async () => {
  const m = modelOf(LUNA);
  const request = luna();
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url: String(url), body: JSON.parse(init.body) };
    return new Response(STREAM, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const events = [];
  const r = await streamCall({ model: m, request, messages: [{ role: 'user', content: 'weather in Lisbon' }], system: 'be brief', search: true, uses: 3, key: 'sk-test', inputTokens: 500 }, { signal: new AbortController().signal, emit: (t, d) => events.push([t, d]) });
  assert.match(sent.url, /api\.openai\.com\/v1\/responses$/);
  assert.deepEqual(sent.body.tools, [{ type: 'web_search' }]);
  assert.equal(sent.body.max_tool_calls, 3);
  assert.equal(sent.body.instructions, 'be brief');
  assert.equal(r.failure, null);
  assert.equal(r.text, 'Lisbon is sunny, 21 degrees.');
  assert.deepEqual(r.citations, [{ title: 'IPMA', url: 'https://ipma.pt/en' }]);
  assert.equal(r.usage.webSearches, 2);
  assert.equal(r.usage.reasoningTokens, 100);
  assert.ok(r.costUSD >= 0.02, 'the two search calls are in the cost');
  assert.ok(events.some(([t]) => t === 'text'));
});

test('streamCall without search still uses Chat Completions', async () => {
  const m = modelOf(LUNA);
  const request = luna();
  let url;
  globalThis.fetch = async (u) => { url = String(u); return new Response('data: [DONE]\n\n', { status: 200 }); };
  await streamCall({ model: m, request, messages: [{ role: 'user', content: 'hi' }], key: 'sk-test' }, { signal: new AbortController().signal, emit() {} });
  assert.match(url, /chat\/completions$/);
});
