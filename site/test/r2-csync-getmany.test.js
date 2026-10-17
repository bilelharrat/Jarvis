// Bug sweep round 2 (askeden docs/bug-sweep/r2-ask-eden-sidebar-sync.md, "Fixes (round 2)"): csync/getmany, a new
// device's first downloads several chats a request (cloud-sync.js; it was one csync/get a chat), mirroring
// csync/batch: one call to the account, each chat answered as csync/get would, the limits held, and a big chat
// never makes the answer too big (as many as fit, at least one; the page asks again for the rest).
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { CHAT_SYNC } from '../src/accounts/chat-sync.js';
import { forgetSessions } from '../src/eden/session.js';
import { Space } from '../src/accounts/space.js';
import { Course } from '../src/edu/course.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let env;
let calls = [];

beforeEach(() => {
  forgetSessions();
  calls = [];
  env = { EDEN_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'), LINK_RATE: rateLimiter(), API_RATE: rateLimiter(100_000), EDEN_RATE: rateLimiter(), CSYNC_RATE: rateLimiter(100_000) };
  for (const [k, C] of [['ACCOUNTS', Account], ['LINKS', Link], ['IDENTITIES', Identity], ['SPACES', Space], ['COURSES', Course]]) {
    const ns = namespace(C, env);
    const get = ns.get.bind(ns);
    ns.get = (name) => { const stub = get(name); return { fetch: (input, init) => { calls.push(`${k}:${new URL(input instanceof Request ? input.url : input).pathname.slice(1)}`); return stub.fetch(input, init); } }; };
    env[k] = ns;
  }
  env.ASSETS = { fetch: async () => new Response('asset') };
});

const signIn = async (account = A) => (await call(env, account, 'web-signin', { account_id: account, create: true, device: { name: 'Eden on the web: Chrome' } })).token;
async function hit(p, token, body) {
  return worker.fetch(new Request(`${ORIGIN}${p}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-jarvis-chat': '1', origin: ORIGIN, 'user-agent': 'Mozilla/5.0 Chrome/140', cookie: `__Host-eden=${token}` } }), env, { waitUntil() {} });
}
const post = async (p, body, token) => (await hit(p, token, body)).json();
const conv = (id, text = 'hi') => ({ id, title: id, created: 1, updated: 10, nodes: { m1: { id: 'm1', role: 'user', content: text, parent: null, children: [], sel: 0 } }, root: { children: ['m1'], sel: 0 } });

test('csync/getmany: several chats in one call to the account, each as csync/get answers it', async () => {
  const t = await signIn();
  await post('/api/web/csync/batch', { puts: ['a', 'b', 'c', 'gone'].map((id) => ({ id, conv: conv(id, `text ${id}`), base_rev: 0 })) }, t);
  await post('/api/web/csync/delete', { id: 'gone' }, t);
  calls = [];
  const out = await post('/api/web/csync/getmany', { ids: ['a', 'gone', 'never', 'c', 'b'] }, t);
  assert.deepEqual(calls.filter((c) => c.startsWith('ACCOUNTS:csync')), ['ACCOUNTS:csync-getmany'], 'one call to the account');
  assert.deepEqual(out.items.map((x) => x.id), ['a', 'gone', 'never', 'c', 'b'], 'in the order asked');
  for (const [i, id] of [[0, 'a'], [3, 'c'], [4, 'b']]) {
    const one = await post('/api/web/csync/get', { id }, t);
    assert.deepEqual(out.items[i], one, `${id} as csync/get answers it`);
  }
  assert.equal(out.items[1].deleted, true);
  assert.deepEqual(out.items[2], { id: 'never', missing: true });
});

test('csync/getmany: the limits hold, and big chats come as many as fit (at least one)', async () => {
  const t = await signIn();
  const r = await hit('/api/web/csync/getmany', t, { ids: Array.from({ length: CHAT_SYNC.batch + 1 }, (_, i) => `z${i}`) });
  assert.equal(r.status, 400);
  assert.equal((await hit('/api/web/csync/getmany', t, { ids: 'a' })).status, 400);
  const big = 'x'.repeat(CHAT_SYNC.maxChars - 1000);
  const ids = ['b1', 'b2', 'b3', 'b4'];
  for (const id of ids) await post('/api/web/csync/put', { id, conv: conv(id, big), base_rev: 0 }, t);
  const first = await post('/api/web/csync/getmany', { ids }, t);
  assert.ok(first.items.length >= 1 && first.items.length < ids.length, `some, not all (${first.items.length})`);
  assert.ok(JSON.stringify(first).length < CHAT_SYNC.batchChars * 1.5, 'the answer stays bounded');
  const rest = await post('/api/web/csync/getmany', { ids: ids.slice(first.items.length) }, t);
  assert.ok(rest.items.length >= 1);
  assert.equal(first.items[0].conv.nodes.m1.content.length, big.length);
  // one huge chat alone still comes
  const solo = await post('/api/web/csync/getmany', { ids: ['b4'] }, t);
  assert.equal(solo.items.length, 1);
});

test('csync/getmany: another account’s chats stay out of reach', async () => {
  const ta = await signIn(A);
  const tb = await signIn(B);
  await post('/api/web/csync/put', { id: 'mine', conv: conv('mine', 'secret'), base_rev: 0 }, ta);
  const out = await post('/api/web/csync/getmany', { ids: ['mine'] }, tb);
  assert.deepEqual(out.items, [{ id: 'mine', missing: true }]);
});
