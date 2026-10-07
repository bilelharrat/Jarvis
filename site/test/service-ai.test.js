import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SKIP_SIGNATURE, serviceAiReady, serviceFallback, serviceFetch, sseOf } from '../src/accounts/service-ai.js';
import { forward, priceOf } from '../src/accounts/proxy.js';
import { askModel } from '../src/accounts/tasks.js';

const geminiAnswer = (parts, finishReason = 'STOP') => ({ candidates: [{ content: { role: 'model', parts }, finishReason }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5 } });

function recorder(answer) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(typeof answer === 'function' ? answer(calls.length) : answer), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, f };
}

test('the stand-in: Gemini first, then OpenAI, never with an Anthropic key, and either may be switched off', () => {
  assert.equal(serviceFallback({ ANTHROPIC_API_KEY: 'sk', GEMINI_API_KEY: 'g' }), null);
  assert.equal(serviceFallback({ GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o' }).provider, 'gemini');
  assert.equal(serviceFallback({ GEMINI_API_KEY: 'g', EDEN_GEMINI: 'off', OPENAI_API_KEY: 'o' }).model, 'gpt-6-luna');
  assert.equal(serviceFallback({}), null);
  assert.equal(serviceAiReady({}), false);
  assert.equal(serviceAiReady({ OPENAI_API_KEY: 'o' }), true);
  assert.equal(serviceAiReady({ ANTHROPIC_API_KEY: 'sk' }), true);
});

test('an Anthropic request with tools and a screenshot, asked of Gemini and answered in Anthropic’s shape', async () => {
  const { calls, f } = recorder(geminiAnswer([{ thought: true, text: 'hmm' }, { text: 'Checking.' }, { functionCall: { name: 'weather', args: { city: 'Lyon' } } }]));
  const payload = {
    model: 'claude-sonnet-5-5',
    max_tokens: 500,
    system: [{ type: 'text', text: 'Be brief.' }],
    tools: [{ name: 'weather', description: 'The weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }, { type: 'web_search_20250305', name: 'web_search' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Weather?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'weather', input: { city: 'Paris' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Sunny' }] },
    ],
  };
  const res = await serviceFetch({ GEMINI_API_KEY: 'g-key' }, payload, { fetch: f });
  const sent = calls[0];
  assert.match(sent.url, /gemini-3\.8-flash:generateContent$/);
  assert.equal(sent.headers['x-goog-api-key'], 'g-key');
  assert.deepEqual(sent.body.systemInstruction, { parts: [{ text: 'Be brief.' }] });
  assert.deepEqual(sent.body.contents[0].parts[1], { inlineData: { mimeType: 'image/png', data: 'AAAA' } });
  assert.equal(sent.body.contents[1].role, 'model');
  assert.equal(sent.body.contents[1].parts[0].thoughtSignature, SKIP_SIGNATURE);
  assert.deepEqual(sent.body.contents[2].parts[0], { functionResponse: { name: 'weather', response: { content: 'Sunny' } } });
  assert.equal(sent.body.tools[0].functionDeclarations.length, 1, 'server tools are left out');
  assert.equal(sent.body.generationConfig.maxOutputTokens, 500);
  const answer = await res.json();
  assert.equal(answer.model, 'gemini-3.8-flash');
  assert.equal(answer.stop_reason, 'tool_use');
  assert.deepEqual(answer.content.map((b) => b.type), ['text', 'tool_use']);
  assert.deepEqual(answer.content[1].input, { city: 'Lyon' });
  assert.deepEqual(answer.usage, { input_tokens: 100, output_tokens: 25 });
});

test('OpenAI as the stand-in: tool results become tool messages, a JSON schema its response_format', async () => {
  const { calls, f } = recorder({ choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4 } });
  const res = await serviceFetch(
    { OPENAI_API_KEY: 'o-key' },
    {
      model: 'claude-haiku-4-5',
      max_tokens: 100,
      system: 'S',
      output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 't', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'done' }] }, { type: 'text', text: 'and?' }] },
      ],
    },
    { fetch: f },
  );
  const sent = calls[0].body;
  assert.equal(calls[0].headers.authorization, 'Bearer o-key');
  assert.equal(sent.model, 'gpt-6-luna');
  assert.equal(sent.max_completion_tokens, 100);
  assert.deepEqual(sent.messages[0], { role: 'system', content: 'S' });
  assert.equal(sent.messages[1].tool_calls[0].id, 'c1');
  assert.deepEqual(sent.messages[2], { role: 'tool', tool_call_id: 'c1', content: 'done' });
  assert.equal(sent.response_format.type, 'json_schema');
  const answer = await res.json();
  assert.equal(answer.content[0].text, '{"a":1}');
  assert.equal(answer.stop_reason, 'end_turn');
});

test('a streamed request gets the answer as Anthropic events', async () => {
  const { f } = recorder(geminiAnswer([{ text: 'Hello' }]));
  const res = await serviceFetch({ GEMINI_API_KEY: 'g' }, { model: 'x', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'hi' }] }, { fetch: f });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const text = await res.text();
  assert.match(text, /event: message_start\ndata: .*"model":"gemini-3\.8-flash"/);
  assert.match(text, /"text_delta","text":"Hello"/);
  assert.match(text, /"stop_reason":"end_turn"/);
  assert.match(text, /event: message_stop/);
  assert.ok(sseOf({ model: 'm', content: [{ type: 'tool_use', id: 'i', name: 'n', input: { a: 1 } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 2 } }).includes('input_json_delta'));
});

test('the stand-in is priced at its own list price, not as an unknown model', () => {
  assert.deepEqual(priceOf('gemini-3.8-flash').slice(0, 2), [0.75, 3.75]);
  assert.deepEqual(priceOf('nothing-known'), [15, 75, 0.1]);
});

test('the iPhone app’s included AI keeps working without an Anthropic key', async () => {
  const real = globalThis.fetch;
  const { calls, f } = recorder(geminiAnswer([{ text: 'Hi from Gemini' }]));
  globalThis.fetch = f;
  try {
    const waits = [];
    const recorded = [];
    const ctx = { waitUntil: (p) => waits.push(p) };
    const request = new Request('https://askeden.com/api/anthropic/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
    const res = await forward(request, { GEMINI_API_KEY: 'g' }, ctx, '/v1/messages', async (model, usage) => recorded.push({ model, usage }));
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Hi from Gemini/);
    await Promise.all(waits);
    assert.equal(calls.length, 1);
    assert.deepEqual(recorded, [{ model: 'gemini-3.8-flash', usage: { input_tokens: 100, output_tokens: 25 } }]);
    const none = await forward(new Request('https://askeden.com/x', { method: 'POST', body: '{}' }), {}, ctx, '/v1/messages', async () => {});
    assert.equal(none.status, 503);
  } finally {
    globalThis.fetch = real;
  }
});

test('a background task’s structured answer comes from the stand-in, with its cost', async () => {
  const { calls, f } = recorder(geminiAnswer([{ text: '{"ok":true}' }]));
  const out = await askModel({ GEMINI_API_KEY: 'g' }, { system: 's', user: 'u', schema: { type: 'object' }, maxTokens: 200, model: 'claude-sonnet-5-5', fetch: f });
  assert.equal(out.ok, true);
  assert.deepEqual(out.value, { ok: true });
  assert.equal(out.model, 'gemini-3.8-flash');
  assert.ok(out.costUSD > 0);
  assert.equal(calls[0].body.generationConfig.responseMimeType, 'application/json');
  const none = await askModel({}, { system: 's', user: 'u', schema: {}, maxTokens: 1, model: 'm', fetch: f });
  assert.equal(none.ok, false);
});
