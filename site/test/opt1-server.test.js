// Optimization pass 1, askeden.com's server side (askeden docs/bug-sweep/r1-optimize-ask-eden-server.md): fewer
// storage reads and fewer calls to the Durable Objects, with the same answers.
//   /api/web/session and /api/web/account: one call to the account (was whoami, then get), view() in one storage.get
//   chat sync: the revision index (a list reads the rows after the cursor, not every row), with the one-time build
//     for accounts that synced before it; csync/batch (many puts and deletes a request); the sync routes trust the
//     isolate's 30 s session check because their ops check the device themselves
//   the course list: each course's card (no member list, no file details)
//   hosted chat: the owner's own API keys read in one call (was one per provider on every request)
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { CHAT_SYNC, TOMBSTONE_DAYS } from '../src/accounts/chat-sync.js';
import { userKeysFor } from '../src/accounts/user-keys.js';
import { sealWith } from '../src/accounts/tokens.js';
import { parseToken } from '../src/accounts/util.js';
import { Space } from '../src/accounts/space.js';
import { Course } from '../src/edu/course.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Identity, Link, Storage, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let env;
const counts = { calls: [], gets: 0, getKeys: 0, lists: 0, listRows: 0, listPrefixes: [] };
const reset = () => Object.assign(counts, { calls: [], gets: 0, getKeys: 0, lists: 0, listRows: 0, listPrefixes: [] });

// count storage reads (every fake object's storage) and calls to the objects
const proto = Storage.prototype;
const origGet = proto.get;
const origList = proto.list;
proto.get = async function get(key) { counts.gets++; counts.getKeys += Array.isArray(key) ? key.length : 1; return origGet.call(this, key); };
proto.list = async function list(o) { counts.lists++; counts.listPrefixes.push(o && o.prefix); const r = await origList.call(this, o); counts.listRows += r.size; return r; };

beforeEach(() => {
  forgetSessions();
  env = { EDEN_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'), LINK_RATE: rateLimiter(), API_RATE: rateLimiter(100_000), EDEN_RATE: rateLimiter(), CSYNC_RATE: rateLimiter(100_000) };
  for (const [k, C] of [['ACCOUNTS', Account], ['LINKS', Link], ['IDENTITIES', Identity], ['SPACES', Space], ['COURSES', Course]]) {
    const ns = namespace(C, env);
    const get = ns.get.bind(ns);
    ns.get = (name) => { const stub = get(name); return { fetch: (input, init) => { counts.calls.push(`${k}:${new URL(input instanceof Request ? input.url : input).pathname.slice(1)}`); return stub.fetch(input, init); } }; };
    env[k] = ns;
  }
  env.ASSETS = { fetch: async () => new Response('asset') };
});

const signIn = async (account = A, name = 'Eden on the web: Chrome') => (await call(env, account, 'web-signin', { account_id: account, create: true, device: { name } })).token;
async function hit(p, token, { method = 'GET', body } = {}) {
  return worker.fetch(new Request(`${ORIGIN}${p}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-jarvis-chat': '1', origin: ORIGIN, 'user-agent': 'Mozilla/5.0 Chrome/140', cookie: `__Host-eden=${token}` } }), env, { waitUntil() {} });
}
const post = async (p, body, token) => (await hit(p, token, { method: 'POST', body })).json();
const conv = (id, text = 'hi') => ({ id, title: id, created: 1, updated: 10, nodes: { m1: { id: 'm1', role: 'user', content: text, parent: null, children: [], sel: 0 } }, root: { children: ['m1'], sel: 0 } });
const parse = (token) => parseToken(token);

// ── the session ──

test('/api/web/session: one call to the account, one batched read, the same plan, usage and sign-ins as the full view', async () => {
  const t = await signIn();
  const full = await call(env, A, 'get', {}, parse(t));
  reset();
  const r = await hit('/api/web/session', t);
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.deepEqual(counts.calls, ['ACCOUNTS:get'], 'whoami and get were two calls');
  assert.equal(counts.lists, 0, 'no device list');
  assert.ok(counts.gets <= 2, `${counts.gets} storage reads (16 before)`);
  assert.deepEqual(s.plan, full.plan);
  assert.deepEqual(s.usage, full.usage);
  assert.deepEqual(s.identities, full.identities);
  assert.equal(s.account_id, A);
  assert.equal(s.signed_in, true);
  assert.equal(s.device.name, 'Eden on the web: Chrome');
});

test('the full view (the apps’ get, /api/web/account) is unchanged: devices, credits, sync', async () => {
  const t = await signIn();
  const full = await call(env, A, 'get', {}, parse(t));
  assert.deepEqual(Object.keys(full), ['id', 'created', 'plan', 'usage', 'credits', 'devices', 'identities', 'sync']);
  assert.equal(full.me, undefined);
  reset();
  const acct = await (await hit('/api/web/account', t)).json();
  assert.deepEqual(counts.calls, ['ACCOUNTS:get']);
  assert.equal(acct.devices.length, 1);
  assert.equal(acct.devices[0].this, true);
  assert.deepEqual(acct.credits, full.credits);
  assert.deepEqual(acct.plan, full.plan);
});

test('/api/web/session: a signed-out browser gets 401 and its cookie cleared, as before', async () => {
  const t = await signIn();
  await call(env, A, 'device-delete', { id: 'me' }, parse(t));
  const r = await hit('/api/web/session', t);
  assert.equal(r.status, 401);
  assert.match(r.headers.get('set-cookie') || '', /__Host-eden=;/);
  assert.equal((await r.json()).error, 'This browser is signed out of Eden.');
  const none = await worker.fetch(new Request(`${ORIGIN}/api/web/session`), env, { waitUntil() {} });
  assert.equal(none.status, 401);
});

// ── chat sync: the revision index ──

test('csync list: an idle device reads no rows, and a device a few changes behind reads only those', async () => {
  const t = await signIn();
  for (let i = 0; i < 60; i++) await post('/api/web/csync/put', { id: `c${i}`, conv: conv(`c${i}`), base_rev: 0 }, t);
  const all = await post('/api/web/csync/list', { since: 0 }, t);
  assert.equal(all.items.length, 60);
  reset();
  const idle = await post('/api/web/csync/list', { since: all.rev }, t);
  assert.equal(idle.items.length, 0);
  assert.equal(counts.listRows, 0, `${counts.listRows} rows read (every row before)`);
  for (let i = 0; i < 3; i++) await post('/api/web/csync/put', { id: `c${i}`, conv: conv(`c${i}`, 'edited'), base_rev: all.items.find((x) => x.id === `c${i}`).rev }, t);
  reset();
  const later = await post('/api/web/csync/list', { since: all.rev }, t);
  assert.deepEqual(later.items.map((x) => x.id), ['c0', 'c1', 'c2']);
  assert.ok(counts.listRows <= 3, `${counts.listRows} rows read`);
  assert.equal(later.rev, all.rev + 3);
  assert.equal(later.more, false);
});

test('csync list: an account that synced before the index lists every chat page by page, and the index is made once', async () => {
  const t = await signIn();
  for (let i = 0; i < 12; i++) await post('/api/web/csync/put', { id: `o${i}`, conv: conv(`o${i}`), base_rev: 0 }, t);
  await post('/api/web/csync/delete', { id: 'o3' }, t);
  // as the account looked before: no index, no marker
  const st = env.ACCOUNTS.objects.get(A).storage;
  for (const k of [...st.map.keys()]) if (k.startsWith('cvr:') || k.startsWith('cvt:') || k === 'cvidx') st.map.delete(k);
  // an old tombstone to clean up
  const r3 = await st.get('cvm:o3');
  await st.put('cvm:o3', { ...r3, updated: Date.now() - (TOMBSTONE_DAYS + 2) * 864e5 });
  const page = CHAT_SYNC.page;
  CHAT_SYNC.page = 5;
  try {
    const ids = [];
    let since = 0;
    let last;
    for (let i = 0; i < 10; i++) {
      last = await post('/api/web/csync/list', { since }, t);
      ids.push(...last.items.map((x) => x.id));
      since = Math.max(since, last.rev);
      if (!last.more) break;
    }
    assert.deepEqual(ids.sort(), Array.from({ length: 12 }, (_, i) => `o${i}`).filter((x) => x !== 'o3').sort(), 'every live chat; the old tombstone cleaned up');
    assert.equal(last.pruned, r3.rev);
    assert.equal(await st.get('cvidx'), 1);
    assert.equal([...st.map.keys()].filter((k) => k.startsWith('cvr:')).length, 11);
    assert.equal(await st.get('cvm:o3'), undefined);
  } finally { CHAT_SYNC.page = page; }
});

test('csync/batch: puts and deletes in one request, each answered as alone; the limits hold', async () => {
  const t = await signIn();
  const one = await post('/api/web/csync/put', { id: 'x', conv: conv('x'), base_rev: 0 }, t);
  reset();
  const out = await post('/api/web/csync/batch', {
    deletes: ['x', 'never-was'],
    puts: [
      { id: 'a', conv: conv('a'), base_rev: 0 },
      { id: 'b', conv: conv('b'), base_rev: 0 },
      { id: 'c', conv: { ...conv('c'), temp: true }, base_rev: 0 },
      { id: 'd', conv: conv('d'), base_rev: 7 },
      { id: 'big', conv: conv('big', 'x'.repeat(CHAT_SYNC.maxChars)), base_rev: 0 },
    ],
  }, t);
  assert.deepEqual(counts.calls.filter((c) => c.startsWith('ACCOUNTS:csync')), ['ACCOUNTS:csync-batch'], 'one call to the account');
  assert.deepEqual(out.deletes.map((d) => d.id), ['x', 'never-was']);
  assert.ok(out.deletes[0].rev > one.rev);
  assert.ok(out.puts[0].rev && out.puts[1].rev > out.puts[0].rev);
  assert.deepEqual(out.puts[2], { id: 'c', code: 'bad_request', error: 'Temporary chats don’t sync.' });
  assert.deepEqual(out.puts[3], { id: 'd', conflict: { rev: 0, deleted: true, updated: 0 } });
  assert.equal(out.puts[4].code, 'too_big');
  const status = await post('/api/web/csync/status', {}, t);
  assert.equal(status.count, 2, 'a and b; x deleted');
  // a conflict with a live chat comes with its copy, as a single put's does
  const again = await post('/api/web/csync/batch', { puts: [{ id: 'a', conv: conv('a', 'mine'), base_rev: 0 }] }, t);
  assert.equal(again.puts[0].conflict.rev, out.puts[0].rev);
  assert.equal(again.puts[0].conflict.conv.nodes.m1.content, 'hi');
  // too many
  const r = await hit('/api/web/csync/batch', t, { method: 'POST', body: { puts: Array.from({ length: CHAT_SYNC.batch + 1 }, (_, i) => ({ id: `z${i}`, conv: conv(`z${i}`), base_rev: 0 })) } });
  assert.equal(r.status, 400);
  // and the list sees what the batch did
  const list = await post('/api/web/csync/list', { since: 0 }, t);
  assert.deepEqual(list.items.filter((x) => !x.deleted).map((x) => x.id).sort(), ['a', 'b']);
  assert.ok(list.items.find((x) => x.id === 'x').deleted);
});

test('the sync routes: one call to the account per request; a sign-out still answers 401 and clears the cookie', async () => {
  const t = await signIn();
  await post('/api/web/csync/status', {}, t);
  reset();
  await post('/api/web/csync/status', {}, t);
  assert.deepEqual(counts.calls, ['ACCOUNTS:csync-status'], 'no whoami before it');
  await call(env, A, 'device-delete', { id: 'me' }, parse(t)); // signed out from another device (this isolate still has it checked)
  for (const p of ['/api/web/csync/list', '/api/web/essays/list']) {
    const r = await hit(p, t, { method: 'POST', body: {} });
    assert.equal(r.status, 401, p);
    assert.match(r.headers.get('set-cookie') || '', /__Host-eden=;/);
    assert.equal((await r.json()).error, 'This browser is signed out of Eden.');
  }
});

// ── the course list ──

test('course list: the same rows, from each course’s card; staff don’t read the member list', async () => {
  const prof = await signIn(A);
  const student = await signIn(B);
  const made = await post('/api/chat/courses', { name: 'BIO 201', term: 'Fall' }, prof);
  const st = env.COURSES.objects.get(made.id).storage;
  await st.put('d:one', { id: 'one', name: 'Notes', kind: 'text', parts: 1, chars: 10, added: 1 });
  await st.put('d:two', { id: 'two', name: 'Key', kind: 'text', parts: 1, chars: 10, added: 2, hidden: true });
  await st.put('d:three', { id: 'three', name: 'Later', kind: 'text', parts: 1, chars: 10, added: 3, from: Date.now() + 864e5 });
  for (let i = 0; i < 40; i++) await st.put(`m:${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`, { account: 'x', role: 'student', joined: 1 });
  const joined = await post('/api/chat/courses/join', { code: made.code, age13: true }, student);
  assert.equal(joined.id, made.id);
  reset();
  const mine = await (await hit('/api/chat/courses', prof)).json();
  assert.deepEqual(mine.courses, [{ id: made.id, name: 'BIO 201', term: 'Fall', role: 'owner', verified: null, docs: 3 }]);
  assert.ok(!counts.listPrefixes.includes('m:'), 'no member list read for the list');
  const theirs = await (await hit('/api/chat/courses', student)).json();
  assert.deepEqual(theirs.courses, [{ id: made.id, name: 'BIO 201', term: 'Fall', role: 'student', verified: null, docs: 1 }], 'hidden and not-yet-open files aren’t counted for a student');
  // the full view still lists them for the course page
  const view = await (await hit(`/api/chat/courses/${made.id}`, prof)).json();
  assert.equal(view.docs.length, 3);
  assert.equal(view.students, 41);
});

// ── hosted chat's own keys ──

test('the owner’s own API keys: every provider in one call to the account', async () => {
  const t = await signIn();
  const who = { account: A, token: parse(t) };
  const record = await sealWith(env, `account:${A}`, `ukey:${A}:gemini`, { key: 'AIza-own-key' });
  await call(env, A, 'ukeys-save', { provider: 'gemini', record, last4: 'key1' }, who.token);
  reset();
  const keys = await userKeysFor(env, who, ['anthropic', 'openai', 'gemini', 'kimi']);
  assert.deepEqual(counts.calls, ['ACCOUNTS:ukeys-get']);
  assert.deepEqual(keys, { anthropic: null, openai: null, gemini: { key: 'AIza-own-key', source: 'user' }, kimi: null });
  reset();
  const meta = await hit('/api/chat/meta', t);
  assert.equal(meta.status, 200);
  assert.equal(counts.calls.filter((c) => c === 'ACCOUNTS:ukeys-get').length, 1, 'one read of the keys per request (was four)');
  assert.deepEqual(await userKeysFor(env, { account: A, token: who.token, grant: { type: 'delegate' } }, ['gemini']), { gemini: null }, 'a grant never reads them');
});
