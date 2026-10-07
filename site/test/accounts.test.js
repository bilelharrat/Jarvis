// Jarvis accounts (docs/accounts.md) through the Worker, with the Durable Objects running in
// memory, Apple's sign-in keys, Apple's push service and Anthropic answered by fakes, and a
// StoreKit certificate chain made here with openssl (its own root, pinned for the test).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { Account } from '../src/accounts/account.js';
import { EDEN_APP_ID, forgetAppleKeys } from '../src/accounts/apple.js';
import { forgetProviderToken } from '../src/accounts/apns.js';
import { Link, cleanCode } from '../src/accounts/link.js';
import { costOf } from '../src/accounts/proxy.js';
import { BUNDLE_ID, PLUS_PRODUCTS, TEAM_ID, accountIdFor, b64url, b64urlText, bytesToB64, hex, parseToken, sha256Hex } from '../src/accounts/util.js';

// ── Durable Objects in memory ──

class Storage {
  constructor() {
    this.map = new Map();
    this.alarm = null;
  }
  async get(key) {
    if (Array.isArray(key)) return new Map(key.filter((k) => this.map.has(k)).map((k) => [k, structuredClone(this.map.get(k))]));
    return this.map.has(key) ? structuredClone(this.map.get(key)) : undefined;
  }
  async put(key, value) {
    if (typeof key === 'object') for (const [k, v] of Object.entries(key)) this.map.set(k, structuredClone(v));
    else this.map.set(key, structuredClone(value));
  }
  async delete(key) {
    for (const k of Array.isArray(key) ? key : [key]) this.map.delete(k);
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
    if (this.closed) throw new Error('closed');
    this.sent.push(message);
  }
  close(code, reason) {
    this.closed = { code, reason };
  }
}

function namespace(Class, env) {
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

// The relay's sockets: fake ones, the server end accepted as the real one would be.
Account.prototype.upgrade = function upgrade(tags) {
  const server = new FakeSocket();
  this.ctx.acceptWebSocket(server, tags);
  return { response: new Response('upgraded', { status: 200, headers: { 'x-upgraded': '1' } }), server };
};

// ── Apple, Anthropic and the push service ──

const rsa = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const appleJwk = { ...(await crypto.subtle.exportKey('jwk', rsa.publicKey)), kid: 'TESTKID', alg: 'RS256', use: 'sig' };

async function identityToken({ sub = 'apple-user-1', nonce = 'raw-nonce', aud = 'com.askeden.jarvis', exp = Date.now() / 1000 + 600, kid = 'TESTKID', iss = 'https://appleid.apple.com' } = {}) {
  const head = b64urlText(JSON.stringify({ alg: 'RS256', kid }));
  const body = b64urlText(JSON.stringify({ iss, aud, exp, iat: Date.now() / 1000, sub, nonce: await sha256Hex(nonce), nonce_supported: true }));
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', rsa.privateKey, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

const p256 = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pushKeyPem = `-----BEGIN PRIVATE KEY-----\n${bytesToB64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', p256.privateKey)))}\n-----END PRIVATE KEY-----`;

let calls = [];
let anthropicAnswer = null;
let apnsAnswer = { status: 200, body: '' };
const realFetch = globalThis.fetch;

function fakeFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input.url;
  calls.push({ url, init });
  if (url === 'https://appleid.apple.com/auth/keys') return Promise.resolve(Response.json({ keys: [appleJwk] }));
  if (url.startsWith('https://api.anthropic.com/')) return Promise.resolve(anthropicAnswer());
  if (url.includes('push.apple.com/3/device/')) {
    return Promise.resolve(new Response(apnsAnswer.body, { status: apnsAnswer.status, headers: { 'apns-id': 'ID-1' } }));
  }
  return Promise.reject(new Error(`unexpected fetch ${url}`));
}

function sse(events) {
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  // In awkward pieces, so the meter has to put lines back together.
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 37) controller.enqueue(bytes.slice(i, i + 37));
      controller.close();
    },
  });
}

// ── the Worker with its bindings ──

let env;
let waits;
const ctx = { waitUntil: (p) => waits.push(p) };

function makeEnv(extra = {}) {
  const e = { ...extra };
  e.ACCOUNTS = namespace(Account, e);
  e.LINKS = namespace(Link, e);
  return e;
}

async function api(path, { method = 'GET', token, body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.authorization = `Bearer ${token}`;
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const response = await worker.fetch(new Request(`https://askeden.com/api${path}`, init), env, ctx);
  await Promise.all(waits.splice(0));
  return response;
}

async function signIn(sub = 'apple-user-1', name = "Bilel's iPhone") {
  const response = await api('/account/apple', {
    method: 'POST',
    body: { identity_token: await identityToken({ sub }), nonce: 'raw-nonce', device: { name, kind: 'iphone', app_version: '1.0' } },
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

beforeEach(() => {
  calls = [];
  waits = [];
  forgetAppleKeys();
  forgetProviderToken();
  globalThis.fetch = fakeFetch;
  env = makeEnv({ ANTHROPIC_API_KEY: 'sk-test', TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20' });
});

after(() => {
  globalThis.fetch = realFetch;
});

// ── signing in ──

test('the account id is a UUID made from the Apple id, and tokens parse', async () => {
  const id = await accountIdFor('apple-user-1');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(id, await accountIdFor('apple-user-1'));
  assert.notEqual(id, await accountIdFor('apple-user-2'));
  assert.equal(parseToken(`jv1.${id}.0123456789abcdef.${'a'.repeat(43)}`).device, '0123456789abcdef');
  assert.equal(parseToken('jv1.nope'), null);
});

test('Sign in with Apple makes the account once and a device each time', async () => {
  const first = await signIn();
  assert.equal(first.new, true);
  assert.match(first.token, /^jv1\./);
  assert.equal(first.account.id, await accountIdFor('apple-user-1'));
  assert.equal(first.account.plan.name, 'free');
  assert.equal(first.account.usage.trial_left_usd, 1);
  assert.deepEqual(first.account.devices.map((d) => [d.name, d.kind, d.this]), [["Bilel's iPhone", 'iphone', true]]);
  const second = await signIn('apple-user-1', 'iPad');
  assert.equal(second.new, false);
  assert.equal(second.account.id, first.account.id);
  assert.equal(second.account.devices.length, 2);
  // No name or email kept anywhere.
  const stored = JSON.stringify([...env.ACCOUNTS.objects.get(first.account.id).storage.map]);
  assert.ok(!stored.includes('apple-user-1'));
  assert.ok(!stored.includes(first.token.split('.')[3]), 'the secret itself is never stored');
});

test("Apple's sign-in is checked: signature, audience, expiry, nonce", async () => {
  const tryWith = async (token, nonce = 'raw-nonce') =>
    (await api('/account/apple', { method: 'POST', body: { identity_token: token, nonce } })).status;
  assert.equal(await tryWith(await identityToken({ aud: 'com.someone.else' })), 401);
  assert.equal(await tryWith(await identityToken({ exp: Date.now() / 1000 - 3600 })), 401);
  assert.equal(await tryWith(await identityToken(), 'another-nonce'), 401);
  assert.equal(await tryWith(await identityToken({ iss: 'https://evil.example' })), 401);
  const good = await identityToken();
  const [h, b] = good.split('.');
  assert.equal(await tryWith(`${h}.${b}.${b64url(new Uint8Array(256))}`), 401);
  assert.equal(await tryWith(await identityToken({ kid: 'OTHER' })), 401);
  assert.equal(await tryWith(good), 200);
});

test('a token works until its device is removed; a wrong secret is signed out', async () => {
  const { token } = await signIn();
  assert.equal((await api('/account', { token })).status, 200);
  const forged = token.replace(/\.[^.]+$/, `.${'x'.repeat(43)}`);
  const refused = await api('/account', { token: forged });
  assert.equal(refused.status, 401);
  assert.equal((await refused.json()).code, 'signed_out');
  assert.equal((await api('/account')).status, 401);
  assert.equal((await api('/devices/me', { method: 'DELETE', token })).status, 204);
  assert.equal((await api('/account', { token })).status, 401);
});

test('a device names itself and registers for pushes; one token belongs to one device', async () => {
  const phone = await signIn();
  const pad = await signIn('apple-user-1', 'iPad');
  const token = 'ab'.repeat(32);
  assert.equal((await api('/devices/me', { method: 'PUT', token: phone.token, body: { apns_token: token, apns_env: 'sandbox', name: 'Phone' } })).status, 204);
  let account = await (await api('/account', { token: phone.token })).json();
  assert.deepEqual(account.devices.map((d) => [d.name, d.push]), [['Phone', true], ['iPad', false]]);
  await api('/devices/me', { method: 'PUT', token: pad.token, body: { apns_token: token } });
  account = await (await api('/account', { token: phone.token })).json();
  assert.deepEqual(account.devices.map((d) => d.push), [false, true]);
  assert.equal((await api('/devices/me', { method: 'PUT', token: phone.token, body: { apns_token: 'not hex' } })).status, 400);
});

test('deleting the account deletes everything', async () => {
  const phone = await signIn();
  const other = await signIn('apple-user-1', 'iPad');
  await api('/sync/memory', { method: 'PUT', token: phone.token, body: { data: 'AAAA', base_rev: 0 } });
  assert.equal((await api('/account', { method: 'DELETE', token: phone.token })).status, 204);
  assert.equal((await api('/account', { token: other.token })).status, 401);
  assert.equal(env.ACCOUNTS.objects.get(phone.account.id).storage.map.size, 0);
  // Signing in again starts a new, empty account.
  const again = await signIn();
  assert.equal(again.new, true);
  assert.equal(again.account.sync.items, 0);
});

// ── linking a Mac ──

const macKey = bytesToB64(new Uint8Array(32).fill(7));

async function startLink() {
  const response = await api('/link/start', { method: 'POST', body: { name: "Bilel's MacBook Air", kind: 'mac', public_key: macKey, app_version: '0.1.6' } });
  assert.equal(response.status, 200);
  return response.json();
}

test('a Mac links: code, the iPhone approves, the Mac polls its token once', async () => {
  const phone = await signIn();
  const { code, poll, expires_in } = await startLink();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(expires_in, 600);
  const waiting = await api('/link/poll', { method: 'POST', body: { code, poll } });
  assert.equal(waiting.status, 202);
  const peek = await (await api(`/link/${code.toLowerCase().replace('-', '')}`, { token: phone.token })).json();
  assert.equal(peek.name, "Bilel's MacBook Air");
  assert.equal(peek.public_key, macKey);
  const approved = await api(`/link/${code}/approve`, { method: 'POST', token: phone.token, body: { sealed_key: 'c2VhbGVk', sender_key: macKey } });
  assert.equal(approved.status, 200);
  const { device_id } = await approved.json();
  assert.equal((await api('/link/poll', { method: 'POST', body: { code, poll: 'wrong' } })).status, 403);
  const done = await (await api('/link/poll', { method: 'POST', body: { code, poll } })).json();
  assert.equal(done.device_id, device_id);
  assert.equal(done.account_id, phone.account.id);
  assert.equal(done.sealed_key, 'c2VhbGVk');
  const mac = await (await api('/account', { token: done.token })).json();
  assert.deepEqual(mac.devices.find((d) => d.this).kind, 'mac');
  assert.equal((await api('/link/poll', { method: 'POST', body: { code, poll } })).status, 404, 'gone after it was taken');
});

test('a link can be turned down, runs out, and only an iPhone approves', async () => {
  const phone = await signIn();
  const first = await startLink();
  assert.equal((await api(`/link/${first.code}/deny`, { method: 'POST', token: phone.token })).status, 204);
  const denied = await api('/link/poll', { method: 'POST', body: first });
  assert.equal(denied.status, 410);
  assert.equal((await denied.json()).code, 'denied');

  const second = await startLink();
  await api(`/link/${second.code}/approve`, { method: 'POST', token: phone.token, body: {} });
  const mac = await (await api('/link/poll', { method: 'POST', body: second })).json();
  const third = await startLink();
  assert.equal((await api(`/link/${third.code}`, { token: mac.token })).status, 403, 'a Mac never approves');
  assert.equal((await api('/link/ZZZZ-ZZZZ', { token: phone.token })).status, 404);

  const link = env.LINKS.objects.get(third.code);
  link.now = () => Date.now() + 601_000;
  assert.equal((await api(`/link/${third.code}/approve`, { method: 'POST', token: phone.token, body: {} })).status, 410);
  assert.equal(cleanCode('jarvis-link://k7qm-4ztr'), 'K7QM-4ZTR');
  assert.equal(cleanCode('K7QM4ZTO'), 'K7QM-4ZT0');
  assert.equal(cleanCode('short'), null);
});

// ── pushes ──

test('pushes go through only to the account’s own devices', async () => {
  const phone = await signIn();
  const device = 'cd'.repeat(32);
  const send = (token, body) => api('/push', { method: 'POST', token, body });
  const alert = { apns_token: device, apns_env: 'sandbox', push_type: 'alert', payload: { aps: { alert: { title: 'Jarvis' } } } };
  assert.equal((await send(phone.token, alert)).status, 503, 'not set up without a key');
  env = makeEnv({ APNS_KEY: pushKeyPem, APNS_KEY_ID: 'KEY1234567' });
  const again = await signIn();
  assert.equal((await send(again.token, alert)).status, 403, 'not a registered token');
  await api('/devices/me', { method: 'PUT', token: again.token, body: { apns_token: device, apns_env: 'sandbox' } });
  const ok = await (await send(again.token, alert)).json();
  assert.deepEqual(ok, { status: 200, apns_id: 'ID-1' });
  const call = calls.find((c) => c.url.includes('/3/device/'));
  assert.equal(call.url, `https://api.sandbox.push.apple.com/3/device/${device}`);
  assert.equal(call.init.headers['apns-topic'], 'com.askeden.jarvis');
  assert.match(call.init.headers.authorization, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.equal(JSON.parse(Buffer.from(call.init.headers.authorization.split('.')[1], 'base64url')).iss, '8CV4X23Y2T', 'the push key is the team’s');
  // A Live Activity's token isn't registered, and goes to its own topic.
  calls = [];
  await send(again.token, { ...alert, apns_token: 'ef'.repeat(32), push_type: 'liveactivity' });
  assert.equal(calls.find((c) => c.url.includes('/3/device/')).init.headers['apns-topic'], 'com.askeden.jarvis.push-type.liveactivity');
  // Apple says the app is gone: the token goes.
  apnsAnswer = { status: 410, body: JSON.stringify({ reason: 'Unregistered' }) };
  assert.deepEqual(await (await send(again.token, alert)).json(), { status: 410, reason: 'Unregistered' });
  apnsAnswer = { status: 200, body: '' };
  const account = await (await api('/account', { token: again.token })).json();
  assert.equal(account.devices[0].push, false);
  assert.equal((await send(again.token, { ...alert, payload: { big: 'x'.repeat(5000) } })).status, 413);
});

// ── included AI ──

function messageStream(model = 'claude-opus-5-5', input = 1000, output = 2000) {
  return () =>
    new Response(
      sse([
        { type: 'message_start', message: { model, usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: 0 } } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Good evening.' } },
        { type: 'message_delta', usage: { output_tokens: output } },
        { type: 'message_stop' },
      ]),
      { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_1' } },
    );
}

test('costs are counted at list prices, caches and searches included', () => {
  // Opus 5.5 $4 / $20 (cache reads $0.20), Sonnet 5.5 $2 / $10, Opus 4.8 $5 / $25: Anthropic's list prices.
  assert.equal(costOf('claude-opus-5-5', { input_tokens: 1e6, output_tokens: 1e6 }), 24);
  assert.equal(costOf('claude-opus-4-8', { input_tokens: 1e6, output_tokens: 1e6 }), 30);
  assert.equal(costOf('claude-sonnet-5-5', { input_tokens: 1e6 }), 2);
  assert.equal(costOf('claude-sonnet-4-6', { input_tokens: 1e6 }), 3);
  assert.equal(costOf('claude-fable-5-1', { output_tokens: 1e6 }), 50);
  assert.equal(costOf('claude-haiku-4-5-20251001', { output_tokens: 1e6 }), 5);
  assert.equal(costOf('claude-opus-5-5', { cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 }), 0.2 + 5);
  assert.equal(costOf('claude-opus-4-8', { cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 }), 0.5 + 6.25);
  assert.equal(costOf('claude-sonnet-5-5', { server_tool_use: { web_search_requests: 3 } }), 0.03);
  assert.equal(costOf('claude-mystery-9', { output_tokens: 1e6 }), 75);
});

test('included AI streams through, counts what it cost, and stops at the allowance', async () => {
  const phone = await signIn();
  anthropicAnswer = messageStream('claude-opus-5-5', 20000, 30000); // 0.08 + 0.60 = $0.68
  const ask = (headers = { authorization: `Bearer ${phone.token}` }, model = 'claude-opus-5-5') =>
    api('/anthropic/v1/messages', { method: 'POST', headers: { ...headers, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'x-test, interleaved-thinking-2025-05-14,code-execution-2025-08-25' }, body: { model, stream: true, max_tokens: 10, messages: [] } });
  const first = await ask();
  assert.equal(first.status, 200);
  assert.match(await first.text(), /Good evening\./);
  await Promise.all(waits.splice(0));
  const sent = calls.find((c) => c.url === 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.init.headers.get('x-api-key'), 'sk-test');
  assert.equal(sent.init.headers.get('anthropic-beta'), 'interleaved-thinking-2025-05-14', 'only allowlisted betas pass');
  assert.equal(sent.init.headers.get('authorization'), null, 'the Jarvis token never goes to Anthropic');
  let account = await (await api('/account', { token: phone.token })).json();
  assert.equal(account.usage.trial_left_usd, 0.32);
  // Claude Code's way: x-api-key carries the Jarvis token.
  assert.equal((await ask({ 'x-api-key': phone.token })).status, 200);
  await (await ask({ 'x-api-key': phone.token })).text().catch(() => {});
  await Promise.all(waits.splice(0));
  const spent = await ask();
  assert.equal(spent.status, 402);
  const error = await spent.json();
  assert.equal(error.type, 'error');
  assert.equal(error.error.type, 'billing_error');
  assert.match(error.error.message, /trial/);
  assert.equal((await ask(undefined, 'gpt-5')).status, 402, 'refused before anything else when nothing is left');
  account = await (await api('/account', { token: phone.token })).json();
  assert.equal(account.usage.trial_left_usd, 0);
});

test('included AI: requests at once hold their worst case, so they cannot spend past the allowance', async () => {
  const phone = await signIn();
  anthropicAnswer = messageStream('claude-opus-5-5', 1000, 1000);
  // Each may cost $0.80 (40 000 tokens out at $20/M): the $1 trial holds one, then the $0.20 left.
  const ask = () => api('/anthropic/v1/messages', { method: 'POST', token: phone.token, body: { model: 'claude-opus-5-5', stream: true, max_tokens: 40000, messages: [] } });
  const first = await ask();
  const second = await ask();
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const third = await ask();
  assert.equal(third.status, 429, 'nothing left but what the requests in flight hold');
  assert.equal((await third.json()).error.type, 'rate_limit_error');
  // Done: each spends what it really cost and lets go of its hold.
  await first.text();
  await second.text();
  await Promise.all(waits.splice(0));
  const fourth = await ask();
  assert.equal(fourth.status, 200);
  await fourth.text();
  await Promise.all(waits.splice(0));
  // A refused request lets go too.
  anthropicAnswer = () => Response.json({ type: 'error', error: { type: 'overloaded_error' } }, { status: 529 });
  for (let i = 0; i < 12; i++) assert.equal((await ask()).status, 529);
});

test('included AI: only Claude, only signed in, counting tokens is free', async () => {
  const phone = await signIn();
  const post = (path, body, token = phone.token) => api(path, { method: 'POST', token, body });
  assert.equal((await post('/anthropic/v1/messages', { model: 'gpt-5' })).status, 400);
  assert.equal((await post('/anthropic/v1/messages', { model: 'claude-opus-5-5' }, null)).status, 401);
  assert.equal((await api('/anthropic/v1/models', { token: phone.token })).status, 404);
  anthropicAnswer = () => Response.json({ input_tokens: 12 });
  const counted = await post('/anthropic/v1/messages/count_tokens', { model: 'claude-opus-5-5', messages: [] });
  assert.deepEqual(await counted.json(), { input_tokens: 12 });
  anthropicAnswer = () => Response.json({ model: 'claude-sonnet-5-5', usage: { input_tokens: 100000, output_tokens: 0 } });
  await (await post('/anthropic/v1/messages', { model: 'claude-sonnet-5-5', messages: [] })).json();
  const account = await (await api('/account', { token: phone.token })).json();
  assert.equal(account.usage.trial_left_usd, 0.8);
  env = makeEnv({});
  const again = await signIn();
  assert.equal((await post('/anthropic/v1/messages', { model: 'claude-opus-5-5' }, again.token)).status, 503);
});

// ── the plan: StoreKit's signed transactions ──

let chain; // { root fingerprint, x5c, leaf key }

before(() => {
  const dir = mkdtempSync(join(tmpdir(), 'storekit-'));
  const run = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'mid.ext'), 'basicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n1.2.840.113635.100.6.2.1=ASN1:NULL\n');
  writeFileSync(join(dir, 'leaf.ext'), 'basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\n1.2.840.113635.100.6.11.1=ASN1:NULL\n');
  run('ecparam', '-name', 'secp384r1', '-genkey', '-noout', '-out', 'root.key');
  run('req', '-new', '-x509', '-key', 'root.key', '-sha384', '-days', '3650', '-subj', '/CN=Test Root', '-out', 'root.pem');
  run('ecparam', '-name', 'secp384r1', '-genkey', '-noout', '-out', 'mid.key');
  run('req', '-new', '-key', 'mid.key', '-subj', '/CN=Test WWDR', '-out', 'mid.csr');
  run('x509', '-req', '-in', 'mid.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-sha384', '-days', '3650', '-extfile', 'mid.ext', '-out', 'mid.pem');
  run('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'leaf.key');
  run('pkcs8', '-topk8', '-nocrypt', '-in', 'leaf.key', '-out', 'leaf.p8');
  run('req', '-new', '-key', 'leaf.key', '-subj', '/CN=Test StoreKit', '-out', 'leaf.csr');
  run('x509', '-req', '-in', 'leaf.csr', '-CA', 'mid.pem', '-CAkey', 'mid.key', '-CAcreateserial', '-sha384', '-days', '3650', '-extfile', 'leaf.ext', '-out', 'leaf.pem');
  const der = (name) => new Uint8Array(run('x509', '-in', name, '-outform', 'der'));
  const ders = [der('leaf.pem'), der('mid.pem'), der('root.pem')];
  chain = { ders, x5c: ders.map((d) => bytesToB64(d)), leafP8: readFileSync(join(dir, 'leaf.p8'), 'utf8') };
});

async function signedJws(payload) {
  const pem = chain.leafP8.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64urlText(JSON.stringify({ alg: 'ES256', x5c: chain.x5c }));
  const body = b64urlText(JSON.stringify({ signedDate: Date.now(), ...payload }));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

const transaction = (accountId, extra = {}) => ({
  bundleId: 'com.askeden.jarvis',
  productId: 'com.askeden.jarvis.plus.monthly',
  transactionId: '2000000001',
  originalTransactionId: '2000000000',
  appAccountToken: accountId.toUpperCase(),
  purchaseDate: Date.now(),
  expiresDate: Date.now() + 30 * 86400_000,
  environment: 'Sandbox',
  ...extra,
});

test('a purchase checked against the chain makes the account Plus', async () => {
  const root = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', chain.ders[2])));
  const phone = await signIn();
  const buy = (jws) => api('/subscription', { method: 'POST', token: phone.token, body: { signed_transaction: jws } });
  // Not Apple's root (the real pin): refused.
  assert.equal((await buy(await signedJws(transaction(phone.account.id)))).status, 400);
  env.APPLE_ROOT_FINGERPRINT = root;
  const plus = await buy(await signedJws(transaction(phone.account.id)));
  assert.equal(plus.status, 200, await plus.clone().text());
  const account = await plus.json();
  assert.equal(account.plan.name, 'plus');
  assert.equal(account.plan.environment, 'Sandbox');
  assert.equal(account.usage.budget_usd, 20);
  assert.equal(account.usage.voice_daily, 100000);
  // Someone else's purchase, another app's, a broken signature.
  assert.equal((await buy(await signedJws(transaction(await accountIdFor('someone'))))).status, 403);
  assert.equal((await buy(await signedJws({ ...transaction(phone.account.id), bundleId: 'com.other' }))).status, 400);
  const good = await signedJws(transaction(phone.account.id));
  assert.equal((await buy(good.slice(0, -4) + 'AAAA')).status, 400);
});

test('App Store notifications renew, expire and refund the plan', async () => {
  env.APPLE_ROOT_FINGERPRINT = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', chain.ders[2])));
  const phone = await signIn();
  const notify = async (tx, renewal = null) =>
    api('/appstore/notifications', {
      method: 'POST',
      body: {
        signedPayload: await signedJws({
          notificationType: 'DID_RENEW',
          data: { bundleId: 'com.askeden.jarvis', signedTransactionInfo: await signedJws(tx), ...(renewal ? { signedRenewalInfo: await signedJws(renewal) } : {}) },
        }),
      },
    });
  assert.equal((await notify(transaction(phone.account.id), { originalTransactionId: '2000000000', autoRenewStatus: 1 })).status, 200);
  let account = await (await api('/account', { token: phone.token })).json();
  assert.equal(account.plan.name, 'plus');
  assert.equal(account.plan.renews, true);
  await notify(transaction(phone.account.id, { revocationDate: Date.now() }));
  account = await (await api('/account', { token: phone.token })).json();
  assert.equal(account.plan.name, 'free', 'refunded');
  // For an account that doesn't exist (deleted): Apple still hears 200.
  assert.equal((await notify(transaction(await accountIdFor('gone')))).status, 200);
  assert.equal((await api('/appstore/notifications', { method: 'POST', body: { signedPayload: 'x.y.z' } })).status, 400);
});

// ── sync ──

test('sync keeps sealed items with revisions, conflicts and tombstones', async () => {
  const phone = await signIn();
  const mac = await signIn('apple-user-1', 'iPad');
  const put = (token, key, data, base_rev) => api(`/sync/${key}`, { method: 'PUT', token, body: { data, base_rev } });
  assert.deepEqual(await (await put(phone.token, 'memory', 'AAAA', 0)).json(), { rev: 1 });
  assert.deepEqual(await (await put(phone.token, 'chat:1f2e', 'BBBB', 0)).json(), { rev: 2 });
  const conflict = await put(mac.token, 'memory', 'CCCC', 0);
  assert.equal(conflict.status, 409);
  assert.deepEqual((await conflict.json()).item, { key: 'memory', rev: 1, data: 'AAAA', deleted: false });
  assert.deepEqual(await (await put(mac.token, 'memory', 'CCCC', 1)).json(), { rev: 3 });
  let page = await (await api('/sync?since=0', { token: phone.token })).json();
  assert.equal(page.rev, 3);
  assert.deepEqual(page.items.map((i) => [i.key, i.rev, i.data]), [['chat:1f2e', 2, 'BBBB'], ['memory', 3, 'CCCC']]);
  assert.equal((await api('/sync/chat:1f2e?base_rev=2', { method: 'DELETE', token: phone.token })).status, 200);
  page = await (await api('/sync?since=3', { token: mac.token })).json();
  assert.deepEqual(page.items.map((i) => [i.key, i.deleted, i.data]), [['chat:1f2e', true, null]]);
  assert.equal((await put(phone.token, 'bad key!', 'AAAA', 0)).status, 400);
  assert.equal((await put(phone.token, 'x', 'not base64 !', 0)).status, 400);
  assert.equal((await put(phone.token, 'x', 'A'.repeat(800000), 0)).status, 413);
  assert.equal((await api('/sync', { method: 'DELETE', token: phone.token })).status, 204);
  page = await (await api('/sync?since=0', { token: phone.token })).json();
  assert.deepEqual(page.items, []);
  assert.ok(page.rev >= 4, 'the revision keeps counting');
});

// ── the relay ──

test('the relay joins a phone to its Mac, bytes both ways, closing together', async () => {
  const phone = await signIn();
  const { code, poll } = await startLink();
  await api(`/link/${code}/approve`, { method: 'POST', token: phone.token, body: {} });
  const mac = await (await api('/link/poll', { method: 'POST', body: { code, poll } })).json();
  const upgrade = { upgrade: 'websocket' };
  const account = env.ACCOUNTS.objects.get(phone.account.id);

  const offline = await api(`/relay/connect?to=${mac.device_id}`, { token: phone.token, headers: upgrade });
  assert.equal(offline.status, 404);
  assert.equal((await offline.json()).code, 'offline');
  assert.equal((await api('/relay/listen', { token: phone.token, headers: upgrade })).status, 403, 'only a Mac listens');
  assert.equal((await api('/relay/listen', { token: mac.token })).status, 426, 'WebSocket only');

  assert.equal((await api('/relay/listen', { token: mac.token, headers: upgrade })).status, 200);
  const listener = account.ctx.getWebSockets('listen')[0];
  assert.equal((await api(`/relay/connect?to=${mac.device_id}`, { token: phone.token, headers: upgrade })).status, 200);
  const open = JSON.parse(listener.sent[0]);
  assert.equal(open.type, 'open');
  assert.equal(open.from, phone.device_id);
  const phoneSocket = account.ctx.getWebSockets(`p:${open.stream}`)[0];

  // The phone's TLS hello arrives before the Mac answers: held, then delivered in order.
  await account.webSocketMessage(phoneSocket, new Uint8Array([0x16, 3, 1]));
  await account.webSocketMessage(phoneSocket, new Uint8Array([9]));
  assert.equal((await api(`/relay/accept?stream=${open.stream}`, { token: phone.token, headers: upgrade })).status, 404, "the phone can't answer for the Mac");
  assert.equal((await api(`/relay/accept?stream=${open.stream}`, { token: mac.token, headers: upgrade })).status, 200);
  const macSocket = account.ctx.getWebSockets(`m:${open.stream}`)[0];
  assert.deepEqual(macSocket.sent.map((b) => [...b]), [[0x16, 3, 1], [9]]);
  await account.webSocketMessage(macSocket, new Uint8Array([1, 2]));
  assert.deepEqual([...phoneSocket.sent.at(-1)], [1, 2]);
  await account.webSocketMessage(phoneSocket, new Uint8Array(70 * 1024));
  assert.equal(phoneSocket.closed.code, 1009, 'frames at most 64 KiB');
  await account.webSocketClose(phoneSocket, 1009);
  assert.ok(macSocket.closed, 'the other end closes too');

  // Unlinking the Mac drops its listen line at once.
  await api(`/devices/${mac.device_id}`, { method: 'DELETE', token: phone.token });
  assert.equal(listener.closed.code, 4001);
});

// ── the voice, per account ──

test('signed in, the JARVIS voice counts against the account', async () => {
  const phone = await signIn();
  env.FISH_API_KEY = 'fish';
  env.VOICE_DAILY_FREE = '10';
  const quota = { fetch: async () => Response.json({ ok: true }) };
  env.VOICE_QUOTA = { idFromName: () => 'daily', get: () => quota };
  globalThis.fetch = async (url) => (String(url).includes('fish.audio') ? new Response('RIFF', { headers: { 'content-type': 'audio/wav' } }) : fakeFetch(url));
  const say = (text) => api('/voice', { method: 'POST', token: phone.token, body: { text } });
  assert.equal((await say('Good evening')).status, 429, 'over the free daily 10 characters');
  assert.equal((await say('Hello')).status, 200);
  assert.equal((await say('Hello again')).status, 429);
  const account = await (await api('/account', { token: phone.token })).json();
  assert.equal(account.usage.voice_today, 5);
});

test('Apple identifiers: team 8CV4X23Y2T and the askeden names, in the code and both Worker configs', async () => {
  assert.equal(TEAM_ID, '8CV4X23Y2T');
  assert.equal(BUNDLE_ID, 'com.askeden.jarvis');
  assert.equal(EDEN_APP_ID, 'com.askeden.eden');
  assert.deepEqual(PLUS_PRODUCTS, ['com.askeden.jarvis.plus.monthly', 'com.askeden.jarvis.plus.yearly']);
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const { previewConfig } = await import('../scripts/preview-config.mjs');
  for (const [which, text] of [['wrangler.toml', toml], ['the preview', previewConfig(toml)]]) {
    assert.match(text, /^APPLE_TEAM_ID = "8CV4X23Y2T"$/m, which);
    assert.match(text, /^WEB_APPLE_SERVICES_ID = "com\.askeden\.eden\.web"$/m, which);
  }
});

test('sign-ups: live is "open" with Turnstile required (a site key, no TURNSTILE_OPTIONAL); the preview is "open" with Turnstile optional', async () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const { previewConfig } = await import('../scripts/preview-config.mjs');
  assert.match(toml, /^SIGNUPS = "open"$/m);
  assert.match(toml, /^TURNSTILE_SITE_KEY = "0x[\w-]+"$/m);
  assert.doesNotMatch(toml, /^TURNSTILE_OPTIONAL/m);
  const preview = previewConfig(toml);
  assert.match(preview, /^SIGNUPS = "open"$/m);
  assert.match(preview, /^TURNSTILE_OPTIONAL = "1"$/m);
});
