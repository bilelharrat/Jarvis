// In-memory Durable Objects and Apple's sign-in keys, for the Eden tests (eden.test.js). The
// same fakes as accounts.test.js, shared here so the new tests don't reach into that file.
import { Account } from '../src/accounts/account.js';
import { Link } from '../src/accounts/link.js';
import { b64url, b64urlText, sha256Hex } from '../src/accounts/util.js';

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
  async list({ prefix = '' } = {}) {
    return new Map([...this.map].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, structuredClone(v)]));
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

export async function identityToken({ sub = 'apple-user-1', nonce = 'raw-nonce', aud = 'com.bshventures.jarvis.companion', exp = Date.now() / 1000 + 600 } = {}) {
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
