// The service's own AI for askeden.com's background work and fixed features (Help's chat, @Eden
// for Messenger, background tasks, the iPhone app's included AI): Claude on ANTHROPIC_API_KEY
// when it's set, else a stand-in on the service's Gemini or OpenAI key, so nothing stops working
// for lack of an Anthropic key (docs/accounts.md "Included AI without an Anthropic key").
//
//   serviceAiReady(env)                       any service key at all
//   serviceFallback(env) → { provider, model, key } | null   the stand-in (no Anthropic key only)
//   serviceFetch(env, payload, { signal, fetch, url })        an Anthropic Messages call → a Response
//                                                             in Anthropic's shape (JSON, or SSE when
//                                                             payload.stream); null: no key at all
//
// The stand-in: Gemini 3.8 Flash on GEMINI_API_KEY, else GPT-6 Luna on OPENAI_API_KEY (either
// switched off by EDEN_GEMINI / EDEN_OPENAI = "off"). The Anthropic request is translated (system,
// text, images and PDFs, tools and tool results, tool_choice, a JSON schema answer), asked once
// without streaming, and the answer translated back; a streamed request gets it as one burst of
// Anthropic events. The answer's `model` is the stand-in's id, so what it cost is counted at its
// own list price (proxy.js priceOf).

const ANTHROPIC_MESSAGES = 'https://api.anthropic.com/v1/messages';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENAI = 'https://api.openai.com/v1/chat/completions';

export const FALLBACKS = [
  { provider: 'gemini', model: 'gemini-3.8-flash', keyVar: 'GEMINI_API_KEY', switchVar: 'EDEN_GEMINI' },
  { provider: 'openai', model: 'gpt-6-luna', keyVar: 'OPENAI_API_KEY', switchVar: 'EDEN_OPENAI' },
];
// Gemini 3 wants a function call's thought signature back; a translated history has none.
export const SKIP_SIGNATURE = 'skip_thought_signature_validator';

const off = (env, name) => /^(off|0|false|no)$/i.test(String(env[name] ?? '').trim());

/** The stand-in for Claude when there's no service Anthropic key; null when there's one, or nothing. */
export function serviceFallback(env = {}) {
  if (String(env.ANTHROPIC_API_KEY || '').trim()) return null;
  for (const f of FALLBACKS) {
    const key = String(env[f.keyVar] || '').trim();
    if (key && !off(env, f.switchVar)) return { provider: f.provider, model: f.model, key };
  }
  return null;
}

/** Whether the service has any AI key for these features. */
export const serviceAiReady = (env = {}) => Boolean(String(env.ANTHROPIC_API_KEY || '').trim()) || Boolean(serviceFallback(env));

/**
 * One Anthropic Messages call on the service's key: Anthropic itself, or the stand-in. A Response
 * in Anthropic's shape either way; throws where fetch would (couldn't reach it); null with no key.
 */
export async function serviceFetch(env, payload, { signal, fetch: f = (u, i) => fetch(u, i), url = ANTHROPIC_MESSAGES } = {}) {
  if (String(env.ANTHROPIC_API_KEY || '').trim()) {
    return f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(payload),
      signal,
    });
  }
  const fb = serviceFallback(env);
  if (!fb) return null;
  const { status, message, error } = await fallbackMessages(fb, payload, { signal, fetch: f });
  if (error) return new Response(JSON.stringify({ type: 'error', error }), { status, headers: { 'content-type': 'application/json' } });
  if (payload.stream) return new Response(sseOf(message), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  return new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** An Anthropic message as the events a streamed answer would have sent. */
export function sseOf(message) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const out = [ev('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: message.usage.input_tokens, output_tokens: 0 } } })];
  message.content.forEach((block, index) => {
    if (block.type === 'text') {
      out.push(ev('content_block_start', { index, content_block: { type: 'text', text: '' } }));
      out.push(ev('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } }));
    } else {
      out.push(ev('content_block_start', { index, content_block: { ...block, input: {} } }));
      out.push(ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }));
    }
    out.push(ev('content_block_stop', { index }));
  });
  out.push(ev('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } }));
  out.push(ev('message_stop', {}));
  return out.join('');
}

// ── Anthropic → a neutral form ──

const blocks = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []);
const systemText = (system) => blocks(system).filter((b) => b && b.type === 'text').map((b) => b.text).join('\n\n');
const media = (b) => (b && b.source && b.source.type === 'base64' && typeof b.source.data === 'string' ? { mime: b.source.media_type || 'application/octet-stream', data: b.source.data } : null);
const resultText = (content) => blocks(content).filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
const resultMedia = (content) => blocks(content).map((b) => (b && (b.type === 'image' || b.type === 'document') ? media(b) : null)).filter(Boolean);
const customTools = (tools) => (Array.isArray(tools) ? tools.filter((t) => t && typeof t.name === 'string' && t.input_schema && (!t.type || t.type === 'custom')) : []);
const schemaOf = (payload) => {
  const format = payload.output_config && payload.output_config.format;
  return format && format.type === 'json_schema' && format.schema ? format.schema : null;
};

function toGemini(payload) {
  const names = {};
  const contents = [];
  for (const m of Array.isArray(payload.messages) ? payload.messages : []) {
    const parts = [];
    for (const b of blocks(m.content)) {
      if (!b) continue;
      if (b.type === 'text' && b.text) parts.push({ text: b.text });
      else if (b.type === 'image' || b.type === 'document') {
        const d = media(b);
        if (d) parts.push({ inlineData: { mimeType: d.mime, data: d.data } });
      } else if (b.type === 'tool_use') {
        names[b.id] = b.name;
        parts.push({ functionCall: { name: b.name, args: b.input || {} }, thoughtSignature: SKIP_SIGNATURE });
      } else if (b.type === 'tool_result') {
        parts.push({ functionResponse: { name: names[b.tool_use_id] || 'tool', response: { [b.is_error ? 'error' : 'content']: resultText(b.content) } } });
        for (const d of resultMedia(b.content)) parts.push({ inlineData: { mimeType: d.mime, data: d.data } });
      }
    }
    if (parts.length) contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  const body = { contents, generationConfig: { maxOutputTokens: payload.max_tokens || 4096 } };
  const system = systemText(payload.system);
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (typeof payload.temperature === 'number') body.generationConfig.temperature = payload.temperature;
  if (Array.isArray(payload.stop_sequences) && payload.stop_sequences.length) body.generationConfig.stopSequences = payload.stop_sequences.slice(0, 5);
  const schema = schemaOf(payload);
  if (schema) Object.assign(body.generationConfig, { responseMimeType: 'application/json', responseJsonSchema: schema });
  const tools = customTools(payload.tools);
  if (tools.length) {
    body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description || '', parametersJsonSchema: t.input_schema })) }];
    const choice = payload.tool_choice || {};
    if (choice.type === 'any') body.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
    else if (choice.type === 'tool') body.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.name] } };
    else if (choice.type === 'none') body.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
  }
  return body;
}

function fromGemini(body, model) {
  const cand = (body.candidates || [])[0] || {};
  const content = [];
  for (const p of (cand.content && cand.content.parts) || []) {
    if (p.thought) continue;
    if (typeof p.text === 'string' && p.text) content.push({ type: 'text', text: p.text });
    else if (p.functionCall) content.push({ type: 'tool_use', id: toolId(), name: p.functionCall.name, input: p.functionCall.args || {} });
  }
  const u = body.usageMetadata || {};
  const reason = cand.finishReason || (body.promptFeedback && body.promptFeedback.blockReason ? 'SAFETY' : 'STOP');
  const stop = content.some((b) => b.type === 'tool_use') ? 'tool_use' : reason === 'MAX_TOKENS' ? 'max_tokens' : /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION|OTHER/.test(reason) && !content.length ? 'refusal' : 'end_turn';
  return message(model, content, stop, u.promptTokenCount, (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0));
}

function toOpenAi(payload, model) {
  const messages = [];
  const system = systemText(payload.system);
  if (system) messages.push({ role: 'system', content: system });
  for (const m of Array.isArray(payload.messages) ? payload.messages : []) {
    if (m.role === 'assistant') {
      const text = blocks(m.content).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
      const calls = blocks(m.content).filter((b) => b && b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
      messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    const parts = [];
    for (const b of blocks(m.content)) {
      if (!b) continue;
      if (b.type === 'tool_result') {
        messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: resultText(b.content) || (b.is_error ? 'error' : 'ok') });
        for (const d of resultMedia(b.content)) if (d.mime.startsWith('image/')) parts.push({ type: 'image_url', image_url: { url: `data:${d.mime};base64,${d.data}` } });
      } else if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image') {
        const d = media(b);
        if (d) parts.push({ type: 'image_url', image_url: { url: `data:${d.mime};base64,${d.data}` } });
      } else if (b.type === 'document') {
        const d = media(b);
        if (d) parts.push({ type: 'file', file: { filename: 'document.pdf', file_data: `data:${d.mime};base64,${d.data}` } });
      }
    }
    if (parts.length) messages.push({ role: 'user', content: parts });
  }
  const body = { model, messages, max_completion_tokens: payload.max_tokens || 4096 };
  const schema = schemaOf(payload);
  if (schema) body.response_format = { type: 'json_schema', json_schema: { name: 'answer', schema, strict: false } };
  const tools = customTools(payload.tools);
  if (tools.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema } }));
    const choice = payload.tool_choice || {};
    if (choice.type === 'any') body.tool_choice = 'required';
    else if (choice.type === 'tool') body.tool_choice = { type: 'function', function: { name: choice.name } };
    else if (choice.type === 'none') body.tool_choice = 'none';
  }
  return body;
}

function fromOpenAi(body, model) {
  const choice = (body.choices || [])[0] || {};
  const m = choice.message || {};
  const content = [];
  if (typeof m.content === 'string' && m.content) content.push({ type: 'text', text: m.content });
  for (const c of m.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(c.function.arguments || '{}');
    } catch {
      input = {};
    }
    content.push({ type: 'tool_use', id: c.id || toolId(), name: c.function.name, input });
  }
  const u = body.usage || {};
  const stop = content.some((b) => b.type === 'tool_use') ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : m.refusal || choice.finish_reason === 'content_filter' ? 'refusal' : 'end_turn';
  return message(model, content, stop, u.prompt_tokens, u.completion_tokens);
}

const toolId = () => `toolu_${crypto.randomUUID().replace(/-/g, '')}`;
const message = (model, content, stop, input, output) => ({
  id: `msg_${crypto.randomUUID().replace(/-/g, '')}`,
  type: 'message',
  role: 'assistant',
  model,
  content,
  stop_reason: stop,
  stop_sequence: null,
  usage: { input_tokens: Number(input) || 0, output_tokens: Number(output) || 0 },
});

/** The stand-in's answer: { status, message } or { status, error: { type, message } }. Throws where fetch would. */
export async function fallbackMessages(fb, payload, { signal, fetch: f = (u, i) => fetch(u, i) } = {}) {
  const gemini = fb.provider === 'gemini';
  const res = gemini
    ? await f(`${GEMINI}/${fb.model}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': fb.key }, body: JSON.stringify(toGemini(payload)), signal })
    : await f(OPENAI, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${fb.key}` }, body: JSON.stringify(toOpenAi(payload, fb.model)), signal });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) {
    const status = res.status === 429 || res.status === 503 ? 529 : res.ok ? 502 : res.status >= 500 ? 502 : res.status;
    return { status, error: { type: status === 529 ? 'overloaded_error' : 'api_error', message: `The included AI answered HTTP ${res.status}.` } };
  }
  return { status: 200, message: gemini ? fromGemini(body, fb.model) : fromOpenAi(body, fb.model) };
}
