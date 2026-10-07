// Included AI: an Anthropic-compatible door (POST /api/anthropic/v1/messages and
// …/count_tokens). The app sends Anthropic's own request with its Jarvis token; the server
// asks the account whether there's allowance left, swaps in its own key (Worker secret
// ANTHROPIC_API_KEY), passes the answer through as it streams, and counts what it cost
// from the answer's usage once it's done. A request that starts inside the allowance always
// finishes; the next one is refused when it's spent.

import { MODELS } from '../eden/vendor/model-router.js';
import { serviceFallback, serviceFetch, sseOf as sseText } from './service-ai.js';

const ANTHROPIC = 'https://api.anthropic.com';
const PASS_HEADERS = ['anthropic-version', 'content-type'];

// The anthropic-beta values passed through: only those whose cost is all tokens (or web
// searches), which costOf counts. Any other beta (code execution's container time, the Files
// API, MCP connectors, 1M-context pricing, …) is dropped, so it can't spend what isn't counted
// (docs/security-review-2026-10-07.md, finding 4).
export const BETAS = new Set([
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  'fine-grained-tool-streaming-2025-05-14',
  'token-efficient-tools-2025-02-19',
  'prompt-caching-2024-07-31',
  'extended-cache-ttl-2025-04-11',
  'context-management-2025-06-27',
  'output-128k-2025-02-19',
  'server-side-fallback-2026-07-01',
]);

/** The allowed betas of an anthropic-beta header, comma-joined, or '' for none. */
export function allowedBetas(header) {
  const seen = new Set();
  for (const raw of String(header || '').split(',')) {
    const beta = raw.trim().toLowerCase();
    if (BETAS.has(beta)) seen.add(beta);
  }
  return [...seen].join(',');
}

// List prices, dollars per million tokens: [input, output, cache reads as a share of input].
// Cache writes are 1.25× input (5 minutes) or 2× (an hour). Unknown models cost the most.
// (Anthropic's prices of 2026-09-25: Opus 5.5 $4/$20 with $0.20 cache reads, Sonnet 5.5 and
// 5 $2/$10, Fable and Mythos $10/$50 with $0.25 cache reads.)
const PRICES = [
  [/claude-opus-4-(0|1)\b|claude-opus-4-2025|claude-3-opus/, [15, 75, 0.1]],
  [/claude-(fable|mythos)/, [10, 50, 0.025]],
  [/claude-opus-5-5/, [4, 20, 0.05]],
  [/opus/, [5, 25, 0.1]],
  [/claude-sonnet-5/, [2, 10, 0.1]],
  [/sonnet/, [3, 15, 0.1]],
  [/haiku-3|3-haiku/, [0.25, 1.25, 0.1]],
  [/haiku/, [1, 5, 0.1]],
];
const UNKNOWN = [15, 75, 0.1];
const WEB_SEARCH = 0.01; // dollars a search
export const WEB_SEARCH_USD = WEB_SEARCH;

export function priceOf(model) {
  for (const [pattern, price] of PRICES) if (pattern.test(String(model))) return price;
  // The stand-in for Claude without an Anthropic key (service-ai.js): its own registry price.
  const other = MODELS.find((m) => m.id === model);
  if (other) return [other.pricing.inputPer1M, other.pricing.outputPer1M, 0.1];
  return UNKNOWN;
}

export function costOf(model, usage = {}) {
  const [input, output, cacheRead] = priceOf(model);
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const creation = usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : null;
  const writes5m = creation ? n(creation.ephemeral_5m_input_tokens) : n(usage.cache_creation_input_tokens);
  const writes1h = creation ? n(creation.ephemeral_1h_input_tokens) : 0;
  const tools = usage.server_tool_use || {};
  const dollars =
    (n(usage.input_tokens) * input +
      writes5m * input * 1.25 +
      writes1h * input * 2 +
      n(usage.cache_read_input_tokens) * input * cacheRead +
      n(usage.output_tokens) * output) / 1e6 +
    n(tools.web_search_requests) * WEB_SEARCH; // web fetches cost only their tokens
  return Math.round(dollars * 1e6) / 1e6;
}

// About this many characters of streamed text make a token, when a stopped answer's output
// has to be estimated (on the low side, so the estimate errs towards counting more).
export const CHARS_PER_TOKEN = 3;

// What a streamed answer has used so far, from its server-sent events: the message_start's
// usage (input, caches) with each message_delta's on top (output, and newer totals), and how
// many characters of text, thinking and tool input have streamed.
export function usageMeter() {
  let model = '';
  let usage = {};
  let streamed = 0;
  let final = false; // a message_delta has given the output count
  return {
    line(line) {
      if (!line.startsWith('data:')) return null;
      let event;
      try {
        event = JSON.parse(line.slice(5).trim());
      } catch {
        return null;
      }
      if (event.type === 'message_start' && event.message) {
        model = event.message.model || model;
        usage = { ...usage, ...(event.message.usage || {}) };
      } else if (event.type === 'content_block_delta' && event.delta) {
        const d = event.delta;
        streamed += String(d.text ?? d.thinking ?? d.partial_json ?? '').length;
      } else if (event.type === 'message_delta' && event.usage) {
        for (const [key, value] of Object.entries(event.usage)) if (value !== null && value !== undefined) usage[key] = value;
        if (event.usage.output_tokens !== undefined && event.usage.output_tokens !== null) final = true;
      }
      return event;
    },
    // The last, cut-off line of a stopped stream: counted as streamed text if it can't be read.
    tail(line) {
      if (line && !this.line(line) && line.startsWith('data:')) streamed += line.length;
    },
    get model() {
      return model;
    },
    get final() {
      return final;
    },
    // The usage to bill. Without the final count (stopped, failed, cut short): the output as
    // it streamed (at least), and the input as estimated when it never came (`input`).
    usage({ input = 0 } = {}) {
      if (final) return { ...usage };
      const estimate = Math.ceil(streamed / CHARS_PER_TOKEN);
      const out = { ...usage, output_tokens: Math.max(Number(usage.output_tokens) || 0, estimate) };
      if (out.input_tokens === undefined && input > 0) out.input_tokens = input;
      return out;
    },
  };
}

// Passes a streamed answer's bytes on untouched while metering them. `onDone(model, usage,
// { stopped })` runs exactly once: when the answer ends, when its stream fails, or when the
// app stops reading (a Stop button, a closed connection). A stopped answer still counts what
// it used: the input in full, the output as estimated from what streamed (F9: the meter used
// to run only at the end of a whole answer, so stopping one was free).
export function meteredBody(body, onDone) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const meter = usageMeter();
  let buffer = '';
  let finished = false;
  const lines = (text) => {
    buffer += text;
    let cut;
    while ((cut = buffer.indexOf('\n')) >= 0) {
      meter.line(buffer.slice(0, cut).trimEnd());
      buffer = buffer.slice(cut + 1);
    }
  };
  const finish = (stopped) => {
    if (finished) return;
    finished = true;
    lines(decoder.decode());
    meter.tail(buffer.trimEnd());
    buffer = '';
    onDone(meter.model, meter.usage(), { stopped });
  };
  return new ReadableStream({
    async pull(controller) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        finish(true);
        controller.error(error);
        return;
      }
      if (chunk.done) {
        finish(false);
        controller.close();
        return;
      }
      controller.enqueue(chunk.value);
      lines(decoder.decode(chunk.value, { stream: true }));
    },
    cancel(reason) {
      finish(true);
      return reader.cancel(reason).catch(() => {});
    },
  });
}

// No Anthropic key here: the same request answered by the service's Gemini or OpenAI key
// (service-ai.js), in Anthropic's shape, counted at the stand-in's price. Token counts are estimated.
async function standIn(body, env, ctx, path, record) {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  if (path.endsWith('/count_tokens')) {
    return new Response(JSON.stringify({ input_tokens: Math.ceil(new TextEncoder().encode(JSON.stringify(body)).length / CHARS_PER_TOKEN) }), { status: 200, headers });
  }
  let upstream;
  try {
    upstream = await serviceFetch(env, { ...body, stream: false });
  } catch {
    return anthropicError(502, 'api_error', 'The included AI couldn’t be reached. Try again.');
  }
  const text = await upstream.text();
  if (!upstream.ok) return new Response(text, { status: upstream.status, headers });
  const answer = JSON.parse(text);
  ctx.waitUntil(record(answer.model, answer.usage || {}));
  if (!body.stream) return new Response(text, { status: 200, headers });
  return new Response(sseText(answer), { status: 200, headers: { ...headers, 'content-type': 'text/event-stream' } });
}

export const anthropicError = (status, type, message, headers = {}) =>
  new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

// Forward one request. `allow` is what the account said ({ ok, why }); `record(model,
// usage)` counts the cost afterwards (through ctx.waitUntil).
export async function forward(request, env, ctx, path, record) {
  const fallback = serviceFallback(env);
  if (!env.ANTHROPIC_API_KEY && !fallback) return anthropicError(503, 'api_error', 'Jarvis Plus AI is not set up on the server yet.');
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
  if (!env.ANTHROPIC_API_KEY) return standIn(body, env, ctx, path, record);
  const headers = new Headers({ 'x-api-key': env.ANTHROPIC_API_KEY });
  for (const name of PASS_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const betas = allowedBetas(request.headers.get('anthropic-beta'));
  if (betas) headers.set('anthropic-beta', betas);
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
    const metered = meteredBody(upstream.body, (model, usage) => ctx.waitUntil(record(model || body.model, usage)));
    return new Response(metered, { status: upstream.status, headers: out });
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
