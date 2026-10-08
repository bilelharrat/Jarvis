// Chat sync (chat-sync.js; derived from the eden-sync test harness) — Eden sync (H1), delegated access (H14) and team spaces (G8): the browser's own crypto
// (public/eden/eden-crypto.js, the copy scripts/sync-eden.mjs makes of web/chat) round trips,
// the server's boundaries (a browser still can't touch the apps' sync; only a trusted device
// reads or writes Eden's items; a delegate or space member can only chat, within its pool),
// revocation, and the Durable Object migrations.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { Space } from '../src/accounts/space.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Identity, Link, claudeAnswer, namespace, rateLimiter, readEvents, sseBody } from './fakes.js';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://askeden.com';
const A = '11111111-1111-4111-8111-111111111111'; // the owner
const B = '22222222-2222-4222-8222-222222222222'; // a delegate, a space member
const C = '33333333-3333-4333-8333-333333333333'; // someone else

let env;
let waits;
let anthropic;
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;

beforeEach(() => {
  waits = [];
  forgetSessions();
  anthropic = () => new Response(sseBody(claudeAnswer({ model: 'claude-sonnet-5-5', input: 1000, output: 2000 })), { headers: { 'content-type': 'text/event-stream' } });
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://api.anthropic.com/v1/messages') return anthropic(JSON.parse(init.body));
    throw new Error(`unexpected fetch ${url}`);
  };
  env = { EDEN_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'), ANTHROPIC_API_KEY: 'sk-test', TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20', LINK_RATE: rateLimiter(), API_RATE: rateLimiter(), EDEN_RATE: rateLimiter() };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.IDENTITIES = namespace(Identity, env);
  env.SPACES = namespace(Space, env);
  env.ASSETS = { fetch: async () => new Response('asset') };
});

after(() => {
  globalThis.fetch = realFetch;
});

async function settle() {
  while (waits.length) await Promise.all(waits.splice(0));
}

/** A browser of an account (its session token), as the web sign-in makes one. */
const browser = async (account, name = 'Eden on the web: Chrome on a Mac') => (await call(env, account, 'web-signin', { account_id: account, create: true, device: { name } })).token;
const iphone = async (account) => (await call(env, account, 'signin', { account_id: account, device: { name: 'iPhone', kind: 'iphone' } })).token;
const plus = (account) => env.ACCOUNTS.objects.get(account).storage.put('plan', { product_id: 'com.askeden.jarvis.plus.monthly', expires: Date.now() + 30 * 86400_000 });

async function hit(p, { method = 'GET', body, session, acting, token, headers = {} } = {}) {
  const h = { 'user-agent': 'Mozilla/5.0 Chrome/140', 'x-jarvis-chat': '1', ...headers };
  if (method !== 'GET') h.origin ??= ORIGIN;
  const jar = [];
  if (session) jar.push(`__Host-eden=${session}`);
  if (acting) jar.push(`__Host-eden-as=${acting}`);
  if (jar.length) h.cookie = jar.join('; ');
  if (token) h.authorization = `Bearer ${token}`;
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  const response = await worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
  await settle();
  return response;
}

const post = (p, body, opts = {}) => hit(p, { method: 'POST', body, ...opts });
const cookieOf = (response, name) => {
  const c = response.headers.getSetCookie().find((x) => x.startsWith(`${name}=`));
  return c ? c.slice(name.length + 1).split(';')[0] : undefined;
};


const conv = (id, extra = {}) => ({ id, title: 'Trip plans', created: 1, updated: 10, nodes: { m1: { id: 'm1', role: 'user', content: 'Where to in May?', children: ['m2'], sel: 0 }, m2: { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'Lisbon.' }], children: [], sel: 0 } }, root: { children: ['m1'], sel: 0 }, ...extra });
const put = (session, c, base = 0) => post('/api/web/csync/put', { id: c.id, conv: c, base_rev: base }, { session }).then((r) => r.json());

test('chat sync: sealed at rest, list then lazy get, other devices see it', async () => {
  const a = await browser(A);
  const b = await browser(A, 'Eden on the web: Safari on an iPhone');
  const c = conv('c1', { title: 'Secret holiday' });
  const out = await put(a, c);
  assert.ok(out.rev);
  // The object holds ciphertext only: neither the title nor the text appear in storage.
  const dump = JSON.stringify(await env.ACCOUNTS.objects.get(A).storage.list({ prefix: 'cv' }).then((m) => [...m.entries()]));
  assert.ok(dump.includes('cvm:c1'));
  assert.ok(!dump.includes('Secret holiday') && !dump.includes('Lisbon'));
  const list = await (await post('/api/web/csync/list', { since: 0 }, { session: b })).json();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].meta.title, 'Secret holiday');
  assert.equal(list.items[0].meta.messages, 2);
  const got = await (await post('/api/web/csync/get', { id: 'c1' }, { session: b })).json();
  assert.equal(got.conv.nodes.m2.parts[0].text, 'Lisbon.');
  // an app (bearer token) reaches the same chats
  const app = await iphone(A);
  const viaApp = await (await post('/api/csync/list', { since: 0 }, { token: app })).json();
  assert.equal(viaApp.items[0].id, 'c1');
  // another account sees nothing
  const other = await browser(C);
  assert.equal((await (await post('/api/web/csync/list', { since: 0 }, { session: other })).json()).items.length, 0);
});

test('chat sync: big conversations are chunked and come back whole', async () => {
  const a = await browser(A);
  const c = conv('big');
  c.nodes.m2.parts[0].text = 'abcdefghij'.repeat(60_000); // 600 KB
  assert.ok((await put(a, c)).rev);
  const got = await (await post('/api/web/csync/get', { id: 'big' }, { session: a })).json();
  assert.equal(got.conv.nodes.m2.parts[0].text.length, 600_000);
  const keys = [...(await env.ACCOUNTS.objects.get(A).storage.list({ prefix: 'cvb:big:' })).keys()];
  assert.ok(keys.length > 5);
  const tooBig = conv('huge');
  tooBig.nodes.m2.parts[0].text = 'x'.repeat(1_600_000);
  assert.equal((await put(a, tooBig)).code, 'too_big');
});

test('chat sync: stale writes conflict with the current copy; tombstones propagate; temporary chats are refused', async () => {
  const a = await browser(A);
  const first = await put(a, conv('c2'));
  const second = await put(a, conv('c2', { updated: 20 }), first.rev);
  assert.ok(second.rev > first.rev);
  const stale = await put(a, conv('c2', { updated: 30 }), first.rev);
  assert.equal(stale.conflict.rev, second.rev);
  assert.equal(stale.conflict.conv.updated, 20);
  // delete: a tombstone with no content, and the chunks are gone
  assert.ok((await (await post('/api/web/csync/delete', { id: 'c2' }, { session: a })).json()).rev);
  const list = await (await post('/api/web/csync/list', { since: second.rev }, { session: a })).json();
  assert.deepEqual(list.items.map((i) => [i.id, i.deleted]), [['c2', true]]);
  assert.equal((await put(a, conv('c2'), second.rev)).conflict.deleted, true); // a device that still has it learns it was deleted
  assert.equal([...(await env.ACCOUNTS.objects.get(A).storage.list({ prefix: 'cvb:c2' })).keys()].length, 0);
  const temp = await post('/api/web/csync/put', { id: 't1', conv: conv('t1', { temp: true }), base_rev: 0 }, { session: a });
  assert.equal(temp.status, 400);
});

test('chat sync: wipe erases every copy; deleting the account erases them', async () => {
  const a = await browser(A);
  await put(a, conv('w1'));
  await put(a, conv('w2'));
  assert.equal((await (await post('/api/web/csync/status', {}, { session: a })).json()).count, 2);
  await post('/api/web/csync/wipe', {}, { session: a });
  const dump = [...(await env.ACCOUNTS.objects.get(A).storage.list({ prefix: 'cv' })).keys()].filter((k) => k !== 'cvrev' && k !== 'cvcount' && k !== 'cvbytes' && k !== 'cvwiped');
  assert.deepEqual(dump, []);
  await put(a, conv('w3'));
  const gone = await post('/api/web/account/delete', { confirm: 'DELETE' }, { session: a });
  assert.ok(gone.status < 300);
  assert.equal(env.ACCOUNTS.objects.get(A) && [...(await env.ACCOUNTS.objects.get(A).storage.list({ prefix: 'cv' })).keys()].length, 0);
  assert.equal((await post('/api/web/csync/list', { since: 0 }, { session: a })).status, 401);
});
