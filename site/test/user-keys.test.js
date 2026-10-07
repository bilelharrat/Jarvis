// The owner's own API keys on askeden.com (src/accounts/user-keys.js) against a fake provider:
// sealing, validation, the never-returned rule, delegates and spaces refused, deletion, the
// providerKey hook's precedence and billing. Nothing here reaches a real provider.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { sha256Hex } from '../src/accounts/util.js';
import { openWith } from '../src/accounts/tokens.js';
import { billsAllowance, checkShape, fakeProviderBase, keysApi, scrub, userKeyFor } from '../src/accounts/user-keys.js';
import { chatApi } from '../src/eden/chat.js';
import { metered, providerKey } from '../src/eden/providers.js';
import { Account, namespace, rateLimiter } from './fakes.js';

const ACCOUNT = 'a'.repeat(32);
const OWNER = { device: '1111111111111111', secret: 'owner-secret' };
const DELEGATE = { device: '2222222222222222', secret: 'delegate-secret' };
const SPACE = { device: '3333333333333333', secret: 'space-secret' };
const OPENAI = `sk-proj-${'A'.repeat(40)}1234`;
const LOCAL = 'http://byok.localhost:8816';

let env;
let seen; // every request the fake provider got
let logs;
const realFetch = globalThis.fetch;
const realConsole = { log: console.log, warn: console.warn, error: console.error };

beforeEach(async () => {
  env = { EDEN_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'), EDEN_FAKE_PROVIDER_BASE: 'http://127.0.0.1:9', API_RATE: rateLimiter(), EDEN_RATE: rateLimiter() };
  env.ACCOUNTS = namespace(Account, env);
  const object = env.ACCOUNTS.objects;
  env.ACCOUNTS.get(ACCOUNT);
  const storage = object.get(ACCOUNT).storage;
  await storage.put('account', { id: ACCOUNT });
  await storage.put(`dev:${OWNER.device}`, { id: OWNER.device, kind: 'web', secret_hash: await sha256Hex(OWNER.secret) });
  await storage.put(`dev:${DELEGATE.device}`, { id: DELEGATE.device, kind: 'web', secret_hash: await sha256Hex(DELEGATE.secret), grant: { type: 'delegate', id: 'd1', features: ['mail'] } });
  await storage.put(`dev:${SPACE.device}`, { id: SPACE.device, kind: 'web', secret_hash: await sha256Hex(SPACE.secret), grant: { type: 'space', id: 's1' } });
  seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), headers: init.headers || {} });
    const auth = (init.headers && (init.headers.authorization || init.headers['x-api-key'] || init.headers['x-goog-api-key'])) || '';
    if (auth.includes('BAD')) return new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${auth.replace('Bearer ', '')}` } }), { status: 401 });
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  logs = [];
  for (const k of Object.keys(realConsole)) console[k] = (...a) => logs.push(a.join(' '));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(console, realConsole);
});

const who = (auth, grant) => ({ account: ACCOUNT, token: { account: ACCOUNT, ...auth }, device: { kind: 'web' }, ...(grant ? { grant } : {}) });
const readBody = async (request) => request.json();
const post = (body, origin = LOCAL) => new Request(`${LOCAL}/api/chat/keys`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
const get = () => new Request(`${LOCAL}/api/chat/keys`);
const storage = () => env.ACCOUNTS.objects.get(ACCOUNT).storage;

test('a saved key is checked at the provider, sealed in the account, and never returned', async () => {
  const saved = await keysApi(post({ provider: 'openai', key: OPENAI }), env, who(OWNER), { readBody });
  assert.deepEqual(saved.openai, { set: true, source: 'account', last4: '1234', added: saved.openai.added });
  assert.deepEqual(saved.check, { ok: true, message: 'Key works' });
  assert.equal(seen[0].url, 'http://127.0.0.1:9/api.openai.com/v1/models'); // the fake, on loopback only
  const record = await storage().get('ukey:openai');
  assert.ok(!JSON.stringify(record).includes(OPENAI.slice(8, -4)));
  // sealed to this account and provider
  assert.deepEqual(await openWith(env, `account:${ACCOUNT}`, `ukey:${ACCOUNT}:openai`, record), { key: OPENAI });
  assert.equal(await openWith(env, `account:${ACCOUNT}`, `ukey:${ACCOUNT}:kimi`, record), null);
  assert.equal(await openWith(env, `account:${'b'.repeat(32)}`, `ukey:${'b'.repeat(32)}:openai`, record), null);
  const listed = await keysApi(get(), env, who(OWNER), { readBody });
  for (const text of [JSON.stringify(saved), JSON.stringify(listed), logs.join('\n')]) assert.ok(!text.includes(OPENAI) && !text.includes(OPENAI.slice(0, 20)));
  assert.deepEqual(listed.gemini, { set: false, source: null });
});

test('format checks refuse other providers’ and publishable keys before any call', () => {
  assert.throws(() => checkShape('openai', `sk-ant-api03-${'x'.repeat(40)}`), /Anthropic key/);
  assert.throws(() => checkShape('openai', `pk_live_${'x'.repeat(30)}`), /Stripe/);
  assert.throws(() => checkShape('kimi', OPENAI), /OpenAI key/);
  assert.throws(() => checkShape('gemini', OPENAI), /Google Gemini/);
  assert.throws(() => checkShape('anthropic', `sk-ant-admin01-${'x'.repeat(40)}`), /admin/);
  assert.equal(checkShape('gemini', ` AIza${'b'.repeat(35)} `), `AIza${'b'.repeat(35)}`);
  assert.equal(checkShape('kimi', `sk-${'k'.repeat(48)}`), `sk-${'k'.repeat(48)}`);
});

test('a refused key: the provider’s words, scrubbed of the key, and nothing saved or logged', async () => {
  const bad = `sk-proj-BAD${'z'.repeat(40)}`;
  await assert.rejects(keysApi(post({ provider: 'openai', key: bad }), env, who(OWNER), { readBody }), (e) => {
    assert.match(e.message, /^OpenAI refused this key: Incorrect API key provided: \[key\]/);
    assert.ok(!e.message.includes(bad) && !e.message.includes('zzzzzzzz'));
    return true;
  });
  assert.equal(await storage().get('ukey:openai'), undefined);
  assert.ok(!logs.join('\n').includes('zzzzzzzz'));
  assert.equal(scrub(`key AIza${'q'.repeat(35)} and sk-abcdefghijkl`), 'key [key] and [key]');
});

test('the hosted route answers the Mac’s contract; a key never appears in any response', async () => {
  env.LINKS = {};
  const r = await keysApi(post({ provider: 'gemini', key: `AIza${'g'.repeat(35)}` }), env, who(OWNER), { readBody });
  assert.equal(seen.at(-1).headers['x-goog-api-key'], `AIza${'g'.repeat(35)}`);
  assert.ok(!seen.at(-1).url.includes('AIza')); // never in a URL
  assert.deepEqual(Object.keys(r).sort(), ['anthropic', 'check', 'gemini', 'kimi', 'openai']);
  // a signed-out POST from another site never reaches the keys
  const response = await chatApi(post({ provider: 'openai', key: OPENAI }, 'https://evil.example'), env, {}, '/api/chat/keys');
  assert.equal(response.status, 403);
  assert.ok(!(await response.text()).includes(OPENAI));
});

test('delegates and team spaces can’t see, set or use the owner’s keys (Worker and object)', async () => {
  await keysApi(post({ provider: 'openai', key: OPENAI }), env, who(OWNER), { readBody });
  for (const [auth, grant] of [[DELEGATE, { type: 'delegate', id: 'd1' }], [SPACE, { type: 'space', id: 's1' }]]) {
    await assert.rejects(keysApi(get(), env, who(auth, grant), { readBody }), { code: 'grant_forbidden' });
    assert.equal(await userKeyFor(env, who(auth, grant), 'openai'), null);
    // even calling the object directly as that device, without the grant on `who`
    await assert.rejects(keysApi(get(), env, who(auth), { readBody }), { status: 403 });
    assert.equal(await userKeyFor(env, who(auth), 'openai'), null);
  }
});

test('removing a key, and deleting the account, removes it; saves are rate-limited', async () => {
  await keysApi(post({ provider: 'openai', key: OPENAI }), env, who(OWNER), { readBody });
  const removed = await keysApi(post({ provider: 'openai', key: '' }), env, who(OWNER), { readBody });
  assert.deepEqual(removed.openai, { set: false, source: null });
  assert.equal(await userKeyFor(env, who(OWNER), 'openai'), null);
  await keysApi(post({ provider: 'openai', key: OPENAI }), env, who(OWNER), { readBody });
  await env.ACCOUNTS.objects.get(ACCOUNT).deleteAll();
  assert.equal(await storage().get('ukey:openai'), undefined);
  // the object's own limit: 10 saves an hour
  await storage().put('account', { id: ACCOUNT });
  await storage().put(`dev:${OWNER.device}`, { id: OWNER.device, kind: 'web', secret_hash: await sha256Hex(OWNER.secret) });
  for (let i = 0; i < 10; i++) await keysApi(post({ provider: 'openai', key: OPENAI }), env, who(OWNER), { readBody });
  await assert.rejects(keysApi(post({ provider: 'openai', key: OPENAI }), env, who(OWNER), { readBody }), { status: 429 });
});

test('the hook: the owner’s own key first (source user), billing skipped for it', async () => {
  assert.equal(await userKeyFor(env, who(OWNER), 'openai'), null); // → the service key
  await keysApi(post({ provider: 'openai', key: OPENAI }), env, who(OWNER), { readBody });
  assert.deepEqual(await userKeyFor(env, who(OWNER), 'openai'), { key: OPENAI, source: 'user' });
  env.OPENAI_API_KEY = 'sk-service-key-not-the-users';
  const keys = { openai: await providerKey(env, who(OWNER), 'openai'), kimi: null };
  assert.deepEqual(keys.openai, { key: OPENAI, source: 'user' }); // the owner's own key wins
  assert.equal(metered(keys, 'openai'), false); // never held or spent on the included AI
  assert.deepEqual(await providerKey(env, who(DELEGATE, { type: 'delegate', id: 'd1' }), 'openai'), { key: 'sk-service-key-not-the-users', source: 'service' });
  assert.equal(billsAllowance('user'), false);
  assert.equal(billsAllowance('service'), true);
  assert.equal(await userKeyFor({ ...env, EDEN_TOKEN_KEY: '' }, who(OWNER), 'openai'), null);
});

test('the fake provider base is honoured only on loopback', () => {
  assert.equal(fakeProviderBase(env, new Request('https://askeden.com/api/chat/keys')), null);
  assert.equal(fakeProviderBase({ EDEN_FAKE_PROVIDER_BASE: 'http://evil.example' }, get()), null);
  assert.equal(fakeProviderBase(env, get()), 'http://127.0.0.1:9');
});
