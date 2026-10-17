// Chat sync's list (chat-sync.js csync-list), page by page the way a device reads it: the cursor it
// hands back must not skip rows (bug sweep AS1), a wipe must be visible to a device that synced
// before it (AS7), and old tombstones are cleaned up a bounded number at a time, with a marker
// that tells a device behind the clean-up to list everything again. Once end to end is set up,
// no chat goes in, even from a device that missed the switch (finding 16).
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { CHAT_SYNC, END_TO_END, TOMBSTONE_DAYS, mintMergeToken } from '../src/accounts/chat-sync.js';
import * as E from '../public/eden/eden-crypto.js';
import { Space } from '../src/accounts/space.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const PAGE = CHAT_SYNC.page;
let env;

beforeEach(() => {
  forgetSessions();
  CHAT_SYNC.page = 5; // small pages: the same paging as 200, with fewer chats
  env = { EDEN_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'), LINK_RATE: rateLimiter(), API_RATE: rateLimiter(), EDEN_RATE: rateLimiter(), CSYNC_RATE: rateLimiter(100_000) };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.IDENTITIES = namespace(Identity, env);
  env.SPACES = namespace(Space, env);
  env.ASSETS = { fetch: async () => new Response('asset') };
});
after(() => { CHAT_SYNC.page = PAGE; });

const session = async (account = ACCOUNT) => (await call(env, account, 'web-signin', { account_id: account, create: true, device: { name: 'Eden on the web: Chrome' } })).token;
const send = (p, body, token) => worker.fetch(new Request(`${ORIGIN}${p}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-jarvis-chat': '1', origin: ORIGIN, 'user-agent': 'Mozilla/5.0 Chrome/140', cookie: `__Host-eden=${token}` } }), env, { waitUntil() {} });
async function post(p, body, token) {
  return (await send(p, body, token)).json();
}
const conv = (id) => ({ id, title: id, created: 1, updated: 10, nodes: { m1: { id: 'm1', role: 'user', content: 'hi', parent: null, children: [], sel: 0 } }, root: { children: ['m1'], sel: 0 } });

/** Every id a device sees listing from `since` with the cursor the server returns, as cloud-sync.js does. */
async function listAll(token, since = 0) {
  const ids = [];
  let last;
  for (let i = 0; i < 100; i++) {
    last = await post('/api/web/csync/list', { since }, token);
    ids.push(...last.items.map((x) => x.id));
    since = Math.max(since, last.rev);
    if (!last.more) break;
  }
  return { ids, since, last };
}

test('AS1: listing page by page with the returned cursor reaches every chat', async () => {
  const s = await session();
  for (let i = 0; i < 12; i++) assert.ok((await post('/api/web/csync/put', { id: `c${i}`, conv: conv(`c${i}`), base_rev: 0 }, s)).rev);
  const first = await post('/api/web/csync/list', { since: 0 }, s);
  assert.equal(first.items.length, 5);
  assert.equal(first.more, true);
  assert.equal(first.rev, first.items.at(-1).rev, 'the cursor is the last row sent, not the account revision');
  const { ids, since } = await listAll(s);
  assert.equal(new Set(ids).size, 12, 'all 12 chats listed');
  assert.equal(since, 12);
  // and a later change set bigger than a page arrives whole
  for (let i = 0; i < 7; i++) await post('/api/web/csync/delete', { id: `c${i}` }, s);
  const later = await listAll(s, since);
  assert.equal(later.ids.length, 7);
});

test('AS7: a wipe is visible to a device that synced before it', async () => {
  const s = await session();
  await post('/api/web/csync/put', { id: 'a', conv: conv('a'), base_rev: 0 }, s);
  const before = await listAll(s);
  assert.equal(before.last.wiped, 0);
  await post('/api/web/csync/wipe', {}, s);
  const got = await post('/api/web/csync/list', { since: before.since }, s);
  assert.ok(got.wiped > before.since, 'the wipe is newer than what the device has');
  assert.equal(got.items.length, 0);
  // a device that lists after the wipe is not told again
  await post('/api/web/csync/put', { id: 'b', conv: conv('b'), base_rev: 0 }, s);
  const after1 = await listAll(s);
  assert.ok(after1.since >= after1.last.wiped);
});

test('old tombstones are cleaned up, a bounded number at a time, and `pruned` says so', async () => {
  const s = await session();
  for (let i = 0; i < 4; i++) await post('/api/web/csync/put', { id: `t${i}`, conv: conv(`t${i}`), base_rev: 0 }, s);
  for (let i = 0; i < 3; i++) await post('/api/web/csync/delete', { id: `t${i}` }, s);
  const st = env.ACCOUNTS.objects.get(ACCOUNT).storage;
  // t0 and t1 were deleted long ago; t2 just now
  for (const id of ['t0', 't1']) { const r = await st.get(`cvm:${id}`); await st.put(`cvm:${id}`, { ...r, updated: Date.now() - (TOMBSTONE_DAYS + 1) * 864e5 }); }
  const t1rev = (await st.get('cvm:t1')).rev;
  const got = await listAll(s);
  assert.deepEqual(got.ids.sort(), ['t2', 't3']);
  assert.equal(got.last.pruned, t1rev);
  assert.equal(await st.get('cvm:t0'), undefined);
  assert.ok(await st.get('cvm:t2'), 'a recent tombstone stays');
  assert.equal(await st.get('cvpruned'), t1rev);
});

/** Turns end to end on from this browser (eden-sync.js init, as sync.js does). */
async function endToEndOn(token) {
  const pair = await E.deviceKeyPair('x25519');
  const secret = E.newSecret();
  const gen = 'gen-abcdef12';
  const keycheck = await E.sealItem(await E.itemKey(secret), 'eden/keycheck', { v: 1, check: 'eden-sync-v1', gen });
  const r = await send('/api/web/esync/init', { gen, proof: await E.proofOf(secret), keycheck, wrap: null, public_key: pair.public, alg: pair.alg }, token);
  assert.equal(r.status, 200, await r.clone().text());
}

test('end to end set up: no chat goes in, even from a page that missed the switch; deletes still go; off again, chats sync', async () => {
  const s = await session();
  for (const id of ['a', 'b']) await post('/api/web/csync/put', { id, conv: conv(id), base_rev: 0 }, s);
  // Another device turns end to end on and removes every server copy (its wipe could also fail: the refusal holds anyway).
  await endToEndOn(s);
  const st = env.ACCOUNTS.objects.get(ACCOUNT).storage;
  for (const [p, body] of [['/api/web/csync/put', { id: 'c', conv: conv('c'), base_rev: 0 }], ['/api/web/csync/batch', { puts: [{ id: 'c', conv: conv('c'), base_rev: 0 }] }]]) {
    const r = await send(p, body, s);
    assert.equal(r.status, 409, p);
    assert.deepEqual(await r.json(), { error: END_TO_END, code: 'end_to_end' }, p);
  }
  assert.equal(await st.get('cvm:c'), undefined, 'nothing was stored');
  // deletes (alone or in a batch) and the wipe still go
  assert.ok((await post('/api/web/csync/delete', { id: 'a' }, s)).rev);
  assert.equal((await post('/api/web/csync/batch', { deletes: ['b'] }, s)).deletes[0].id, 'b');
  assert.ok((await post('/api/web/csync/wipe', {}, s)).rev);
  // end to end turned off again (its "start over"): the automatic sync takes chats again
  assert.equal((await send('/api/web/esync/wipe', {}, s)).status, 200);
  assert.ok((await post('/api/web/csync/put', { id: 'c', conv: conv('c'), base_rev: 0 }, s)).rev);
});

test('end to end set up: bringing another sign-in’s chats in stops at once and says why', async () => {
  const OTHER = '22222222-2222-4222-8222-222222222222';
  const other = await session(OTHER);
  for (const id of ['x', 'y']) await post('/api/web/csync/put', { id, conv: conv(id), base_rev: 0 }, other);
  const s = await session();
  await endToEndOn(s);
  const step = await post('/api/web/merge/step', { token: await mintMergeToken(env, ACCOUNT, OTHER), since: 0 }, s);
  assert.deepEqual([step.copied, step.failed, step.done, step.error], [0, 1, true, END_TO_END]);
  assert.equal(await env.ACCOUNTS.objects.get(ACCOUNT).storage.get('cvm:x'), undefined);
});
