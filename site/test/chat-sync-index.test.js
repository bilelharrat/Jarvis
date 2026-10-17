// Chat sync's storage (chat-sync.js), from the Oct 10-11 bug sweep's optimization pass (origin/main test/opt1-server.test.js,
// its chat sync part): the revision index (a list reads the rows after the cursor, not every row), with the one-time
// build for accounts that synced before it; csync/batch (many puts and deletes a request); the sync routes trust the
// isolate's 30 s session check because their ops check the device themselves. And csync-wipe: every copy goes
// without any chat's text being read into memory (it listed every chunk's value to get the keys).
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { CHAT_SYNC, TOMBSTONE_DAYS } from '../src/accounts/chat-sync.js';
import { parseToken } from '../src/accounts/util.js';
import { Space } from '../src/accounts/space.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Identity, Link, Storage, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const A = '11111111-1111-4111-8111-111111111111';
let env;
const counts = { calls: [], lists: 0, listRows: 0, listed: [] };
const reset = () => Object.assign(counts, { calls: [], lists: 0, listRows: 0, listed: [] });

// count storage lists (every fake object's storage) and calls to the objects
const proto = Storage.prototype;
const origList = proto.list;
proto.list = async function list(o) { counts.lists++; const r = await origList.call(this, o); counts.listRows += r.size; counts.listed.push(...r.keys()); return r; };

beforeEach(() => {
  forgetSessions();
  env = { EDEN_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'), LINK_RATE: rateLimiter(), API_RATE: rateLimiter(100_000), EDEN_RATE: rateLimiter(), CSYNC_RATE: rateLimiter(100_000) };
  for (const [k, C] of [['ACCOUNTS', Account], ['LINKS', Link], ['IDENTITIES', Identity], ['SPACES', Space]]) {
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

// ── the revision index ──

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

// ── csync/batch ──

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

// ── the sync routes ──

test('the sync routes: one call to the account per request; a sign-out still answers 401 and clears the cookie', async () => {
  const t = await signIn();
  await post('/api/web/csync/status', {}, t);
  reset();
  await post('/api/web/csync/status', {}, t);
  assert.deepEqual(counts.calls, ['ACCOUNTS:csync-status'], 'no whoami before it');
  await call(env, A, 'device-delete', { id: 'me' }, parseToken(t)); // signed out from another device (this isolate still has it checked)
  for (const p of ['/api/web/csync/list', '/api/web/esync/pull']) {
    const r = await hit(p, t, { method: 'POST', body: {} });
    assert.equal(r.status, 401, p);
    assert.match(r.headers.get('set-cookie') || '', /__Host-eden=;/);
    assert.equal((await r.json()).error, 'This browser is signed out of Eden.');
  }
  // and with nothing checked in this isolate, a signed-out cookie is refused before any sync op
  forgetSessions();
  reset();
  const r = await hit('/api/web/csync/status', t, { method: 'POST', body: {} });
  assert.equal(r.status, 401);
  assert.ok(!counts.calls.includes('ACCOUNTS:csync-status'));
});

test('the sync routes: a page syncing for another account than the cookie’s (a tab left open on it) is refused, before any op', async () => {
  const B = '22222222-2222-4222-8222-222222222222';
  const t = await signIn(B); // another tab signed this browser in to B
  const as = (account, p, body) => worker.fetch(new Request(`${ORIGIN}${p}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-jarvis-chat': '1', origin: ORIGIN, cookie: `__Host-eden=${t}`, ...(account ? { 'x-eden-account': account } : {}) } }), env, { waitUntil() {} });
  for (const p of ['/api/web/csync/put', '/api/web/csync/list', '/api/web/esync/pull']) {
    reset();
    const r = await as(A, p, { id: 'x', conv: conv('x'), base_rev: 7, since: 0 });
    assert.equal(r.status, 409, p);
    const out = await r.json();
    assert.equal(out.code, 'other_account');
    assert.match(out.error, /another Eden account/);
    assert.ok(!counts.calls.some((c) => /csync-|esync/.test(c)), `${p}: nothing reached the account`);
  }
  assert.equal((await post('/api/web/csync/status', {}, t)).count, 0, 'nothing was stored in B');
  // the page's own account, or a page that doesn't say (older), goes on
  assert.equal((await as(B, '/api/web/csync/put', { id: 'y', conv: conv('y'), base_rev: 0 })).status, 200);
  assert.equal((await as(null, '/api/web/csync/list', { since: 0 })).status, 200);
});

// ── csync-wipe ──

test('csync wipe: every row, chunk and index entry goes, page by page, without listing any chunk’s text', async () => {
  const t = await signIn();
  const big = 'x'.repeat(CHAT_SYNC.chunk * 3); // several chunks each
  for (let i = 0; i < 6; i++) await post('/api/web/csync/put', { id: `w${i}`, conv: conv(`w${i}`, i % 2 ? big : 'small'), base_rev: 0 }, t);
  await post('/api/web/csync/delete', { id: 'w0' }, t);
  const st = env.ACCOUNTS.objects.get(A).storage;
  await post('/api/web/csync/list', { since: 0 }, t); // the index made (cvidx)
  await st.put('cvb:lost:0', 'a chunk no row names (a write cut short)');
  assert.ok([...st.map.keys()].filter((k) => k.startsWith('cvb:')).length > 6);
  reset();
  const out = await post('/api/web/csync/wipe', {}, t);
  assert.ok(out.rev > 0);
  const left = [...st.map.keys()].filter((k) => /^(cvm|cvb|cvr|cvt):/.test(k) || k === 'cvidx');
  assert.deepEqual(left, [], 'nothing of the chats is left');
  assert.deepEqual(counts.listed.filter((k) => k.startsWith('cvb:')), ['cvb:lost:0'], 'only the stray chunk was ever listed');
  assert.equal(await st.get('cvwiped'), out.rev);
  const status = await post('/api/web/csync/status', {}, t);
  assert.deepEqual([status.count, status.bytes, status.rev], [0, 0, out.rev]);
  // a device behind the wipe is told; the account syncs again from nothing
  const list = await post('/api/web/csync/list', { since: 1 }, t);
  assert.equal(list.wiped, out.rev);
  assert.equal(list.items.length, 0);
  const again = await post('/api/web/csync/put', { id: 'w1', conv: conv('w1'), base_rev: 0 }, t);
  assert.ok(again.rev > out.rev);
  assert.deepEqual((await post('/api/web/csync/list', { since: out.rev }, t)).items.map((x) => x.id), ['w1']);
});

test('csync wipe: an account with more rows than a page is wiped whole', async () => {
  const t = await signIn();
  const st = env.ACCOUNTS.objects.get(A).storage;
  // rows written straight into storage (faster than 450 puts), as putChat writes them
  for (let i = 0; i < 450; i++) {
    const id = `m${String(i).padStart(4, '0')}`;
    await st.put({ [`cvm:${id}`]: { id, rev: i + 1, updated: 1, deleted: false, size: 3, n: 2, iv: 'iv', miv: 'iv', mct: 'ct' }, [`cvb:${id}:0`]: 'abc', [`cvb:${id}:1`]: 'def', [`cvr:${String(i + 1).padStart(12, '0')}`]: id });
  }
  await st.put({ cvrev: 450, cvcount: 450, cvbytes: 1350, cvidx: 1 });
  const out = await post('/api/web/csync/wipe', {}, t);
  assert.equal(out.rev, 451);
  assert.deepEqual([...st.map.keys()].filter((k) => /^(cvm|cvb|cvr|cvt):/.test(k)), []);
});
