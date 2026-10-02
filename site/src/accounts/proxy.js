// Included AI: an Anthropic-compatible door (POST /api/anthropic/v1/messages and
// …/count_tokens). The app sends Anthropic's own request with its Jarvis token; the server
// asks the account whether there's allowance left, swaps in its own key (Worker secret
// ANTHROPIC_API_KEY), passes the answer through as it streams, and counts what it cost
// from the answer's usage once it's done. A request that starts inside the allowance always
// finishes; the next one is refused when it's spent.

const ANTHROPIC = 'https://api.anthropic.com';
const PASS_HEADERS = ['anthropic-version', 'anthropic-beta', 'content-type'];

// List prices, dollars per million tokens: [input, output]. Cache writes are 1.25× input
// (5 minutes) or 2× (an hour), cache reads 0.1× input. Unknown models cost the most.
const PRICES = [
  [/claude-opus-4-(0|1)\b|claude-opus-4-2025|claude-3-opus/, [15, 75]],
  [/opus/, [5, 25]],
  [/sonnet/, [3, 15]],
  [/haiku-3|3-haiku/, [0.25, 1.25]],
  [/haiku/, [1, 5]],
];
const UNKNOWN = [15, 75];
const WEB_SEARCH = 0.01; // dollars a search

export function priceOf(model) {
  for (const [pattern, price] of PRICES) if (pattern.test(String(model))) return price;
  return UNKNOWN;
}

export function costOf(model, usage = {}) {
  const [input, output] = priceOf(model);
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const creation = usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : null;
  const writes5m = creation ? n(creation.ephemeral_5m_input_tokens) : n(usage.cache_creation_input_tokens);
  const writes1h = creation ? n(creation.ephemeral_1h_input_tokens) : 0;
  const tools = usage.server_tool_use || {};
  const dollars =
    (n(usage.input_tokens) * input +
      writes5m * input * 1.25 +
      writes1h * input * 2 +
      n(usage.cache_read_input_tokens) * input * 0.1 +
      n(usage.output_tokens) * output) / 1e6 +
    n(tools.web_search_requests) * WEB_SEARCH; // web fetches cost only their tokens
  return Math.round(dollars * 1e6) / 1e6;
}

// The usage of a streamed answer, gathered from its server-sent events as they pass: the
// message_start's (input, caches) with each message_delta's on top (output, and newer
// totals). Returns a TransformStream that passes every byte on untouched.
export function meteredStream(onDone) {
  const decoder = new TextDecoder();
  let buffer = '';
  let model = '';
  let usage = {};
  const take = (line) => {
    if (!line.startsWith('data:')) return;
    let event;
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      return;
    }
    if (event.type === 'message_start' && event.message) {
      model = event.message.model || model;
      usage = { ...usage, ...(event.message.usage || {}) };
    } else if (event.type === 'message_delta' && event.usage) {
      for (const [key, value] of Object.entries(event.usage)) if (value !== null && value !== undefined) usage[key] = value;
    }
  };
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n')) >= 0) {
        take(buffer.slice(0, cut).trimEnd());
        buffer = buffer.slice(cut + 1);
      }
    },
    flush() {
      if (buffer) take(buffer.trimEnd());
      onDone(model, usage);
    },
  });
}

export const anthropicError = (status, type, message, headers = {}) =>
  new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

// Forward one request. `allow` is what the account said ({ ok, why }); `record(model,
// usage)` counts the cost afterwards (through ctx.waitUntil).
export async function forward(request, env, ctx, path, record) {
  if (!env.ANTHROPIC_API_KEY) return anthropicError(503, 'api_error', 'Jarvis Plus AI is not set up on the server yet.');
  const bodyText = await request.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return anthropicError(400, 'invalid_request_error', 'Send JSON.');
  }
  if (typeof body.model !== 'string' || !/^claude-[\w.-]+$/.test(body.model)) {
    return anthropicError(400, 'invalid_request_error', 'Only Claude models are included.');
  }
  const headers = new Headers({ 'x-api-key': env.ANTHROPIC_API_KEY });
  for (const name of PASS_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  const upstream = await fetch(`${ANTHROPIC}${path}`, { method: 'POST', headers, body: bodyText });
  const out = new Headers();
  for (const name of ['content-type', 'request-id', 'retry-after', 'anthropic-ratelimit-requests-remaining']) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  out.set('cache-control', 'no-store');
  if (path.endsWith('/count_tokens')) return new Response(upstream.body, { status: upstream.status, headers: out });
  const streaming = (upstream.headers.get('content-type') || '').includes('text/event-stream');
  if (upstream.ok && streaming && upstream.body) {
    const meter = meteredStream((model, usage) => ctx.waitUntil(record(model || body.model, usage)));
    return new Response(upstream.body.pipeThrough(meter), { status: upstream.status, headers: out });
  }
  const text = await upstream.text();
  if (upstream.ok) {
    try {
      const answer = JSON.parse(text);
      ctx.waitUntil(record(answer.model || body.model, answer.usage || {}));
    } catch {
      // nothing to count
    }
  }
  return new Response(text, { status: upstream.status, headers: out });
}
