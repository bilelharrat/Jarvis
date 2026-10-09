// Chat sync, end to end with two real clients: the page's own cloud-sync.js / state.js / sync.js (the copy in
// public/eden, as served) run twice, each with its own browser storage, cookie and event target, against the real Worker
// and Account object (test/fakes.js). Unit tests of the rules passed while nothing had ever been run the way two devices
// run it; this is that run. Timers are held (the test drives each pass itself).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { Space } from '../src/accounts/space.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://askeden.com';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const realFetch = globalThis.fetch;
const timers = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval, clearTimeout: globalThis.clearTimeout, clearInterval: globalThis.clearInterval };
const KEYS = ['localStorage', 'document', 'location', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'];
const saved = Object.fromEntries(KEYS.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
let env;
let root;

beforeEach(() => {
  forgetSessions();
  env = { EDEN_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'), LINK_RATE: rateLimiter(), API_RATE: rateLimiter(), EDEN_RATE: rateLimiter() };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.IDENTITIES = namespace(Identity, env);
  env.SPACES = namespace(Space, env);
  env.ASSETS = { fetch: async () => new Response('asset') };
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'csync-clients-'));
});
after(() => {
  for (const k of KEYS) { if (saved[k]) Object.defineProperty(globalThis, k, saved[k]); else delete globalThis[k]; }
  globalThis.fetch = realFetch;
});

const session = async (name) => (await call(env, ACCOUNT, 'web-signin', { account_id: ACCOUNT, create: true, device: { name } })).token;

/** A browser: its own copy of the page's modules (so its own state), storage, cookie and events. */
async function browser(name) {
  const dir = path.join(root, name);
  fs.cpSync(path.join(SITE, 'public/eden'), dir, { recursive: true, filter: (s) => !s.endsWith('.html') || s === path.join(SITE, 'public/eden') });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  const token = await session(`Eden on the web: ${name}`);
  const store = new Map();
  const target = new EventTarget();
  const tab = {
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); }, get length() { return store.size; }, key: (i) => [...store.keys()][i] },
    document: { visibilityState: 'visible', readyState: 'complete', querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, documentElement: { classList: { contains: () => false } } },
    location: { search: '', pathname: '/', origin: ORIGIN },
    addEventListener: (...a) => target.addEventListener(...a),
    removeEventListener: (...a) => target.removeEventListener(...a),
    dispatchEvent: (e) => target.dispatchEvent(e),
    fetch: async (url, init = {}) => {
      const u = new URL(url, ORIGIN);
      const headers = { ...(init.headers || {}), cookie: `__Host-eden=${token}`, 'user-agent': 'Mozilla/5.0 Chrome/140' };
      if (init.method && init.method !== 'GET') headers.origin = ORIGIN;
      return worker.fetch(new Request(u, { ...init, headers }), env, { waitUntil() {} });
    },
    setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
  };
  const b = { tab, log: [] };
  b.use = () => { for (const k of KEYS) Object.defineProperty(globalThis, k, { value: tab[k], configurable: true, writable: true }); };
  b.use();
  const mod = (f) => import(pathToFileURL(path.join(dir, f)).href);
  b.S = await mod('state.js');
  b.C = await mod('cloud-sync.js');
  b.Sync = await mod('sync.js'); // loaded the way account.js does (cloud-sync.js's applyConv/removeConv)
  b.run = async (fn) => { b.use(); return fn(b); };
  b.sync = async () => { b.use(); let i = await b.C.syncNow(); for (let n = 0; i.running && n < 50; n++) { await new Promise((r) => timers.setTimeout(r, 20)); i = b.C.info(); } return i; };
  b.start = async () => { b.use(); b.C.initCloud(ACCOUNT, { e2e: false }); return b.sync(); };
  return b;
}

const chat = (b, title, n = 2, id) => {
  b.use();
  const c = b.S.newConversation();
  if (id) c.id = id;
  c.title = title;
  let parent = null;
  for (let i = 0; i < n; i++) parent = b.S.addNode(c, parent && parent.id, i % 2 ? { role: 'assistant', parts: [{ type: 'text', text: `reply ${i}` }] } : { role: 'user', content: `question ${i}` }).id;
  b.S.state.convs.unshift(c);
  return c;
};
const save = (b, c) => { b.use(); c.updated = Date.now() + Math.floor(Math.random() * 1000); b.S.saveConversation(c, { now: true }); };

test('two browsers on one account: create, appear, continue, merge, delete, temporary stays home', async () => {
  const a = await browser('A');
  const b = await browser('B');
  // A had a chat before sync existed (it is in state when sync starts): it must upload, not just sit there.
  const old = chat(a, 'Made before sync');
  const infoA = await a.start();
  assert.equal(infoA.error, '');
  assert.ok(infoA.last > 0, 'the first pass finished');
  // B signs in later (a new device: nothing local, cursor 0): the chat shows up, whole.
  const infoB = await b.start();
  assert.equal(infoB.error, '');
  b.use();
  const seen = b.S.state.convs.find((c) => c.id === old.id);
  assert.ok(seen, 'B lists the chat');
  assert.equal(seen.title, 'Made before sync');
  assert.equal(Boolean(seen.remote), false, 'and has its messages (fetched in the background)');
  assert.equal(Object.keys(seen.nodes).length, 2);
  // B continues it; A merges on its next pass.
  const last = Object.values(seen.nodes).find((n) => !n.children.length);
  b.S.addNode(seen, last.id, { role: 'user', content: 'from B' });
  save(b, seen);
  await b.sync();
  await a.sync();
  a.use();
  assert.equal(Object.keys(a.S.state.convs.find((c) => c.id === old.id).nodes).length, 3, 'A got B’s message');
  // a temporary chat never leaves the browser
  b.use();
  const temp = b.S.newConversation({ temp: true });
  b.S.addNode(temp, null, { role: 'user', content: 'private' });
  b.S.state.convs.unshift(temp);
  save(b, temp);
  await b.sync();
  await a.sync();
  a.use();
  assert.ok(!a.S.state.convs.some((c) => c.id === temp.id));
  assert.ok(![...(await env.ACCOUNTS.objects.get(ACCOUNT).storage.list({ prefix: 'cvm:' })).keys()].some((k) => k.includes(temp.id)));
  // A deletes it; B drops it.
  a.use();
  a.S.deleteConversation(a.S.state.convs.find((c) => c.id === old.id));
  await a.sync();
  await b.sync();
  b.use();
  assert.ok(!b.S.state.convs.some((c) => c.id === old.id), 'gone on B');
});

test('a first upload of hundreds of chats is not cut off by the chat-turn allowance', async () => {
  env.API_RATE = rateLimiter(120); // the chat turns' allowance: a pass of 150 puts alone would exceed it
  env.CSYNC_RATE = rateLimiter(1000);
  const a = await browser('A');
  for (let i = 0; i < 150; i++) chat(a, `Chat ${i}`);
  const info = await a.start();
  assert.equal(info.error, '', 'no error');
  const b = await browser('B');
  await b.start();
  b.use();
  assert.equal(b.S.state.convs.length, 150);
  assert.ok(env.API_RATE.keys.length < 5, 'sync did not spend the chat allowance');
});

test('too many calls: the pass stops, says so in plain words, keeps its progress, and goes on', async () => {
  env.CSYNC_RATE = rateLimiter(40);
  const a = await browser('A');
  for (let i = 0; i < 100; i++) chat(a, `Chat ${i}`);
  const first = await a.start();
  assert.match(first.error, /slow down/);
  assert.equal(first.last, 0);
  env.CSYNC_RATE.max = 1000; // a minute later
  const second = await a.sync();
  assert.equal(second.error, '');
  assert.ok(second.last > 0);
  const stored = [...(await env.ACCOUNTS.objects.get(ACCOUNT).storage.list({ prefix: 'cvm:' })).keys()];
  assert.equal(stored.length, 100);
});
