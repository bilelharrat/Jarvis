// Bringing another sign-in's chats into this account (chat-sync.js, merge): copied across sealed under the
// receiving account, only for the account the grant names, never twice, and only with an unexpired grant.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { mintMergeToken } from '../src/accounts/chat-sync.js';
import { Space } from '../src/accounts/space.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const A = '11111111-1111-4111-8111-111111111111'; // the account the person is in
const B = '22222222-2222-4222-8222-222222222222'; // the account their other sign-in opens
const C = '33333333-3333-4333-8333-333333333333'; // someone else
let env;
const tokens = {};

beforeEach(async () => {
  forgetSessions();
  env = { EDEN_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'), LINK_RATE: rateLimiter(), API_RATE: rateLimiter(), EDEN_RATE: rateLimiter() };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.IDENTITIES = namespace(Identity, env);
  env.SPACES = namespace(Space, env);
  env.ASSETS = { fetch: async () => new Response('asset') };
  for (const id of [A, B, C]) tokens[id] = (await call(env, id, 'web-signin', { account_id: id, create: true, device: { name: 'test' } })).token;
});

const api = (id, path, body) => worker.fetch(new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { cookie: `__Host-eden=${tokens[id]}`, origin: ORIGIN, 'content-type': 'application/json', 'x-jarvis-chat': '1', 'user-agent': 'Mozilla/5.0 Chrome/140' }, body: JSON.stringify(body) }), env, { waitUntil() {} });
const conv = (id, title) => ({ id, title, created: 1, updated: 2, kind: 'chat', temp: false, root: { children: ['u1'], sel: 0 }, nodes: { u1: { id: 'u1', parent: null, role: 'user', content: `hello ${title}`, children: [], sel: 0 } } });
const put = async (who, c) => (await api(who, '/api/web/csync/put', { id: c.id, conv: c, base_rev: 0 })).json();
const list = async (who) => (await (await api(who, '/api/web/csync/list', { since: 0 })).json()).items;

test('merge: another account\'s chats are copied across, readable by this account, and nothing is copied twice', async () => {
  for (let i = 0; i < 30; i++) await put(B, conv(`b${i}`, `chat ${i}`));
  await put(A, conv('mine', 'my own'));
  await put(A, conv('b3', 'already here'));
  const token = await mintMergeToken(env, A, B);
  const pre = await (await api(A, '/api/web/merge/preview', { token })).json();
  assert.equal(pre.count, 30);
  let since = 0, copied = 0, skipped = 0, rounds = 0, done = false;
  while (!done && rounds++ < 10) {
    const r = await (await api(A, '/api/web/merge/step', { token, since })).json();
    copied += r.copied; skipped += r.skipped; since = r.since; done = r.done;
  }
  assert.equal(copied, 29);
  assert.equal(skipped, 1);
  const mine = await list(A);
  assert.equal(mine.filter((x) => !x.deleted).length, 31);
  const got = await (await api(A, '/api/web/csync/get', { id: 'b7' })).json();
  assert.equal(got.conv.nodes.u1.content, 'hello chat 7');
  assert.equal((await list(B)).filter((x) => !x.deleted).length, 30); // the other account keeps its own copy
});

test('merge: a grant works only for the account it names, and not once it has run out', async () => {
  await put(B, conv('b1', 'secret'));
  const token = await mintMergeToken(env, A, B);
  assert.equal((await api(C, '/api/web/merge/preview', { token })).status, 403); // someone else's session can't use it
  assert.equal((await api(A, '/api/web/merge/preview', { token: { iv: 'x', ct: 'y' } })).status, 403);
  const real = Date.now;
  Date.now = () => real() + 16 * 60 * 1000;
  try { assert.equal((await api(A, '/api/web/merge/step', { token, since: 0 })).status, 403); } finally { Date.now = real; }
  assert.equal((await api(A, '/api/web/merge/preview', { token: await mintMergeToken(env, A, A) })).status, 400); // not its own account
});

test('merge: the other account\'s object refuses a grant that isn\'t for it', async () => {
  const token = await mintMergeToken(env, A, B);
  await assert.rejects(() => call(env, C, 'cmerge-list', { a: A, token, since: 0 }));
});
