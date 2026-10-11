// In-memory Durable Objects and Apple's sign-in keys, for the Eden tests (eden.test.js). The
// same fakes as accounts.test.js, shared here so the new tests don't reach into that file.
import { Account } from '../src/accounts/account.js';
import { Link } from '../src/accounts/link.js';
import { Identity } from '../src/accounts/identity.js';
import { b64url, b64urlText, sha256Hex } from '../src/accounts/util.js';
import { testOnlyServiceClaude } from '../src/eden/providers.js';

// The suites below run Claude on a Worker key (ANTHROPIC_API_KEY). askeden.com does that too since
// "Claude for everyone" (providers.js serviceClaude, 2026-10-10); the switch keeps the older suites
// independent of that rule. test/byok.test.js and anywhere-public-models.test.js check the real rule.
testOnlyServiceClaude(true);

export class Storage {
  constructor() {
    this.map = new Map();
    this.alarm = null;
  }
  async get(key) {
    if (Array.isArray(key)) return new Map(key.filter((k) => this.map.has(k)).map((k) => [k, structuredClone(this.map.get(k))]));
    return this.map.has(key) ? structuredClone(this.map.get(key)) : undefined;
  }
  async put(key, value) {
    if (typeof key === 'object') {
      if (Object.keys(key).length > 128) throw new Error('at most 128 keys a put');
      for (const [k, v] of Object.entries(key)) this.map.set(k, structuredClone(v));
    } else this.map.set(key, structuredClone(value));
  }
  async delete(key) {
    const keys = Array.isArray(key) ? key : [key];
    if (keys.length > 128) throw new Error('at most 128 keys a delete');
    for (const k of keys) this.map.delete(k);
  }
  // As a Durable Object's storage.list: prefix, start (inclusive) or startAfter, end (exclusive), reverse, limit.
  async list({ prefix = '', start, startAfter, end, reverse = false, limit } = {}) {
    let rows = [...this.map].filter(([k]) => k.startsWith(prefix) && (start === undefined || k >= start) && (startAfter === undefined || k > startAfter) && (end === undefined || k < end)).sort(([a], [b]) => (a < b ? -1 : 1));
    if (reverse) rows.reverse();
    if (limit !== undefined) rows = rows.slice(0, limit);
    return new Map(rows.map(([k, v]) => [k, structuredClone(v)]));
  }
  async deleteAll() {
    this.map.clear();
  }
  async setAlarm(at) {
    this.alarm = at;
  }
}

class FakeSocket {
  constructor() {
    this.sent = [];
    this.closed = null;
  }
  send(message) {
    this.sent.push(message);
  }
  close(code, reason) {
    this.closed = { code, reason };
  }
}

export function namespace(Class, env) {
  const objects = new Map();
  return {
    objects,
    idFromName: (name) => name,
    get(name) {
      if (!objects.has(name)) {
        const sockets = [];
        const ctx = {
          storage: new Storage(),
          sockets,
          acceptWebSocket: (ws, tags) => sockets.push({ ws, tags }),
          getWebSockets: (tag) => sockets.filter((s) => !s.ws.closed && (!tag || s.tags.includes(tag))).map((s) => s.ws),
          getTags: (ws) => (sockets.find((s) => s.ws === ws) || { tags: [] }).tags,
        };
        objects.set(name, new Class(ctx, env));
      }
      const object = objects.get(name);
      return { fetch: (input, init) => object.fetch(input instanceof Request ? input : new Request(input, init)) };
    },
  };
}

Account.prototype.upgrade = function upgrade(tags) {
  const server = new FakeSocket();
  this.ctx.acceptWebSocket(server, tags);
  return { response: new Response('upgraded', { status: 200, headers: { 'x-upgraded': '1' } }), server };
};

export { Account, Link };

// ── Apple's sign-in ──

const rsa = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
export const appleJwk = { ...(await crypto.subtle.exportKey('jwk', rsa.publicKey)), kid: 'TESTKID', alg: 'RS256', use: 'sig' };

export async function identityToken({ sub = 'apple-user-1', nonce = 'raw-nonce', aud = 'com.askeden.jarvis', exp = Date.now() / 1000 + 600 } = {}) {
  const head = b64urlText(JSON.stringify({ alg: 'RS256', kid: 'TESTKID' }));
  const body = b64urlText(JSON.stringify({ iss: 'https://appleid.apple.com', aud, exp, iat: Date.now() / 1000, sub, nonce: await sha256Hex(nonce) }));
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', rsa.privateKey, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

/** Server-sent events as Anthropic streams them, in awkward pieces. */
export function sseBody(events, { pieces = 37, hold = false } = {}) {
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  let cancelled = null;
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += pieces) controller.enqueue(bytes.slice(i, i + pieces));
      if (!hold) controller.close(); // hold: the answer goes on (until the reader stops it)
    },
    cancel(reason) {
      cancelled = reason ?? true;
    },
  });
  stream.wasCancelled = () => cancelled !== null;
  return stream;
}

/** One Claude answer: message_start, the text in deltas, message_delta (usage, stop), message_stop. */
export function claudeAnswer({ model = 'claude-sonnet-5-5', input = 1000, output = 2000, text = ['Good ', 'evening.'], thinking = [], stop = 'end_turn', citations = [], final = true } = {}) {
  const events = [{ type: 'message_start', message: { model, usage: { input_tokens: input, output_tokens: 1 } } }];
  for (const t of thinking) events.push({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: t } });
  for (const t of text) events.push({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: t } });
  for (const c of citations) events.push({ type: 'content_block_delta', index: 1, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', ...c } } });
  if (final) {
    events.push({ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: output } });
    events.push({ type: 'message_stop' });
  }
  return events;
}

/** The events of an Eden SSE response body: [{ type, data }]. */
export async function readEvents(response) {
  const text = await response.text();
  const out = [];
  for (const block of text.split(/\n\n/)) {
    let type = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) type = line.slice(7);
      else if (line.startsWith('data: ')) data.push(line.slice(6));
    }
    if (data.length) out.push({ type, data: JSON.parse(data.join('\n')) });
  }
  return out;
}

// ── sign-in identities and Google (auth.test.js) ──

export { Identity };

/** An RSA signing key as an OpenID provider has one: { jwk, sign(claims, header?) → JWT }. */
export async function rsaSigner(kid) {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid, alg: 'RS256', use: 'sig' };
  async function sign(claims, header = {}) {
    const head = b64urlText(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT', ...header }));
    const body = b64urlText(JSON.stringify(claims));
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${head}.${body}`)));
    return `${head}.${body}.${b64url(sig)}`;
  }
  return { jwk, sign };
}

export const GOOGLE_CLIENT = 'test-client.apps.googleusercontent.com';
export const google = await rsaSigner('GOOGLEKID1');

/** A Google id_token: valid unless told otherwise. */
export function googleIdToken({ sub = 'google-user-1', nonce, aud = GOOGLE_CLIENT, email = 'person@example.com', email_verified = true, iss = 'https://accounts.google.com', exp = Date.now() / 1000 + 600, signer = google } = {}) {
  return signer.sign({ iss, aud, azp: aud, sub, email, email_verified, nonce, iat: Math.floor(Date.now() / 1000), exp });
}

/** A Workers rate-limit binding that allows `limit` per key; `keys` records every key asked. */
export function rateLimiter(limit = 1000) {
  const counts = new Map();
  return {
    keys: [],
    max: limit,
    async limit({ key }) {
      this.keys.push(key);
      counts.set(key, (counts.get(key) || 0) + 1);
      return { success: counts.get(key) <= this.max };
    },
  };
}

// ── Claude-shaped fakes answered as Gemini (the Ask Eden apps' routes, eden/ask.js, ask the public models: R3X2) ──

/** Gemini's streaming endpoint, as eden/vendor/providers.js calls it; [1] is the model. */
export const GEMINI_STREAM = /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/([^/:?]+):streamGenerateContent\?alt=sse$/;

/** A Gemini streaming request as the Claude payload the older suites check: { model, max_tokens, stream, system, messages }. */
export function claudeShaped(url, init) {
  const body = JSON.parse(init.body);
  const text = (parts = []) => parts.map((p) => p.text || '').join('');
  return {
    model: decodeURIComponent(GEMINI_STREAM.exec(url)[1]),
    max_tokens: body.generationConfig?.maxOutputTokens,
    stream: true,
    ...(body.systemInstruction ? { system: text(body.systemInstruction.parts) } : {}),
    messages: body.contents.map((c) => ({ role: c.role === 'model' ? 'assistant' : 'user', content: text(c.parts) })),
    ...(body.tools ? { tools: body.tools } : {}),
    generationConfig: body.generationConfig,
  };
}

const GEMINI_FINISH = { end_turn: 'STOP', stop_sequence: 'STOP', max_tokens: 'MAX_TOKENS', refusal: 'SAFETY' };

/**
 * A fake Claude response (sseBody(claudeAnswer(…)), or any Anthropic event stream) as Gemini's stream: the same
 * text pieces, usage and ending, event by event as they come (pings send nothing); cancelling it cancels the
 * Claude-shaped body. An error response is returned as it is.
 */
export function asGemini(response) {
  if (!response.ok || !response.body) return response;
  const source = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let input = 0;
  const chunk = (j) => encoder.encode(`data: ${JSON.stringify(j)}\r\n\r\n`);
  const translate = (block) => {
    const line = block.split('\n').find((l) => l.startsWith('data: '));
    if (!line) return null;
    const e = JSON.parse(line.slice(6));
    if (e.type === 'message_start') {
      input = e.message?.usage?.input_tokens || 0;
      return null;
    }
    if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') return chunk({ candidates: [{ content: { role: 'model', parts: [{ text: e.delta.text }] } }], usageMetadata: { promptTokenCount: input, candidatesTokenCount: 0 } });
    if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') return chunk({ candidates: [{ content: { role: 'model', parts: [{ text: e.delta.thinking, thought: true }] } }], usageMetadata: { promptTokenCount: input, candidatesTokenCount: 0 } });
    if (e.type === 'message_delta') return chunk({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: GEMINI_FINISH[e.delta?.stop_reason] || 'OTHER' }], usageMetadata: { promptTokenCount: input, candidatesTokenCount: e.usage?.output_tokens || 0 } });
    if (e.type === 'error') return chunk({ error: { code: 500, message: e.error?.message || 'error', status: 'INTERNAL' } });
    return null; // ping, message_stop, content_block_start/stop
  };
  const body = new ReadableStream({
    async pull(controller) {
      for (;;) {
        const { done, value } = await source.read();
        if (done) {
          controller.close();
          return;
        }
        buffer += typeof value === 'string' ? value : decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop();
        const out = blocks.map(translate).filter(Boolean);
        if (out.length) {
          for (const bytes of out) controller.enqueue(bytes);
          return;
        }
      }
    },
    cancel(reason) {
      return source.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, headers: { 'content-type': 'text/event-stream' } });
}
