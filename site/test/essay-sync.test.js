// Essay sync (accounts/essay-sync.js; askeden ROADMAP T11): the essay writer's essays sealed at rest in the
// account's object, listed then fetched on another device, stale writes answered with the current copy,
// tombstones, chunking, and the boundaries (another account, a bad essay). Harness from chat-sync.test.js.
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


const essay = (id, extra = {}) => ({ id, created: 1, updated: 10, style: 'apa', details: { title: 'Sleep and Memory', name: 'Ana López' }, format: {}, goal: 0, sources: [], doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Teenagers need more sleep.' }] }] }, ...extra });
const put = (session, e, base = 0) => post('/api/web/essays/put', { id: e.id, essay: e, base_rev: base }, { session }).then((r) => r.json());

test('essay sync: sealed at rest, listed with its title, fetched whole on another device and by the apps', async () => {
  const a = await browser(A);
  const b = await browser(A, 'Eden on the web: Safari on an iPhone');
  const out = await put(a, essay('es1'));
  assert.ok(out.rev);
  const dump = JSON.stringify(await env.ACCOUNTS.objects.get(A).storage.list({ prefix: 'es' }).then((m) => [...m.entries()]));
  assert.ok(dump.includes('esm:es1'));
  assert.ok(!dump.includes('Sleep and Memory') && !dump.includes('Teenagers need'), 'only ciphertext in storage');
  const list = await (await post('/api/web/essays/list', { since: 0 }, { session: b })).json();
  assert.deepEqual(list.items.map((i) => [i.id, i.meta.title, i.meta.style]), [['es1', 'Sleep and Memory', 'apa']]);
  const got = await (await post('/api/web/essays/get', { id: 'es1' }, { session: b })).json();
  assert.equal(got.essay.doc.content[0].content[0].text, 'Teenagers need more sleep.');
  const app = await iphone(A);
  assert.equal((await (await post('/api/essays/list', { since: 0 }, { token: app })).json()).items[0].id, 'es1');
  const other = await browser(C);
  assert.equal((await (await post('/api/web/essays/list', { since: 0 }, { session: other })).json()).items.length, 0);
  // chats and essays are separate stores
  assert.equal((await (await post('/api/web/csync/list', { since: 0 }, { session: a })).json()).items.length, 0);
});

test('essay sync: a stale write gets the current copy; deletes are tombstones; long essays are chunked; bad ones refused', async () => {
  const a = await browser(A);
  const first = await put(a, essay('es2'));
  const second = await put(a, essay('es2', { updated: 20 }), first.rev);
  const stale = await put(a, essay('es2', { updated: 30 }), first.rev);
  assert.equal(stale.conflict.rev, second.rev);
  assert.equal(stale.conflict.essay.updated, 20);
  assert.ok((await (await post('/api/web/essays/delete', { id: 'es2' }, { session: a })).json()).rev);
  const list = await (await post('/api/web/essays/list', { since: second.rev }, { session: a })).json();
  assert.deepEqual(list.items.map((i) => [i.id, i.deleted]), [['es2', true]]);
  assert.equal((await put(a, essay('es2'), second.rev)).conflict.deleted, true);
  const long = essay('es3');
  long.doc.content[0].content[0].text = 'word '.repeat(120_000); // 600 KB
  assert.ok((await put(a, long)).rev);
  assert.ok([...(await env.ACCOUNTS.objects.get(A).storage.list({ prefix: 'esb:es3:' })).keys()].length > 5);
  assert.equal((await (await post('/api/web/essays/get', { id: 'es3' }, { session: a })).json()).essay.doc.content[0].content[0].text.length, 600_000);
  long.doc.content[0].content[0].text = 'x'.repeat(1_600_000);
  assert.equal((await put(a, long, (await (await post('/api/web/essays/list', { since: 0 }, { session: a })).json()).items.find((i) => i.id === 'es3').rev)).code, 'too_big');
  assert.equal((await post('/api/web/essays/put', { id: 'x1', essay: { id: 'other' }, base_rev: 0 }, { session: a })).status, 400);
  assert.equal((await post('/api/web/essays/put', { id: 'x1', essay: essay('x1'), base_rev: 0 })).status, 401, 'signed out');
});
