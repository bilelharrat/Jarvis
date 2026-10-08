// Bug sweep 2026-10-08 (docs/bug-sweep/server-2026-10-08.md): regressions for what the sweep fixed.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { safeDecode } from '../src/accounts/util.js';
import { BrowserSession } from '../src/browser/session.js';
import { addressAllowed, privateHost } from '../src/browser/rules.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';
import { Space } from '../src/accounts/space.js';

const ORIGIN = 'https://askeden.com';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

let env;
let waits;
const ctx = { waitUntil: (p) => waits.push(p) };

beforeEach(() => {
  waits = [];
  forgetSessions();
  env = { EDEN_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'), LINK_RATE: rateLimiter(), API_RATE: rateLimiter(), EDEN_RATE: rateLimiter(), AUTH_RATE: rateLimiter() };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.IDENTITIES = namespace(Identity, env);
  env.SPACES = namespace(Space, env);
  env.BROWSER_SESSIONS = namespace(BrowserSession, env);
  env.ASSETS = { fetch: async () => new Response('asset') };
});
after(() => {});

const browser = async (account) => (await call(env, account, 'web-signin', { account_id: account, create: true, device: { name: 'Eden on the web: Chrome on a Mac' } })).token;
async function hit(p, { method = 'GET', body, session, acting, headers = {} } = {}) {
  const h = { 'user-agent': 'Mozilla/5.0 Chrome/140', 'x-jarvis-chat': '1', ...headers };
  if (method !== 'GET') h.origin ??= ORIGIN;
  if (session) h.cookie = `__Host-eden=${session}${acting ? `; __Host-eden-as=${acting}` : ''}`;
  const init = { method, headers: h };
  if (body !== undefined) { init.body = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const response = await worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
  while (waits.length) await Promise.all(waits.splice(0));
  return response;
}

test('a broken %-escape in an address is a 400/404, never a 500', async () => {
  assert.equal(safeDecode('a%20b'), 'a b');
  assert.equal(safeDecode('%E0%A4%A'), '');
  const put = await hit('/api/sync/%E0%A4%A', { method: 'PUT', body: {} });
  assert.equal(put.status, 400);
  assert.equal((await hit('/api/sync/%E0%A4%A', { method: 'DELETE' })).status, 400);
  const sam = await browser(A);
  assert.equal((await hit('/api/web/mac-link/%E0%A4%A', { session: sam })).status, 404);
  const tok = await call(env, A, 'signin', { account_id: A, device: { name: 'iPhone', kind: 'iphone' } });
  const r = await hit('/api/link/%E0%A4%A', { headers: { authorization: `Bearer ${tok.token}` } });
  assert.equal(r.status, 404);
});

test('site-local and 6to4 IPv6 addresses are private to the cloud browser', () => {
  for (const h of ['[fec0::1]', '[feff::1]', '[2002:7f00:1::]', '[2002:a00:1::1]', '[2002:c0a8:101::]', '[2002:a9fe:a9fe::]']) assert.ok(privateHost(h), h);
  for (const h of ['[2002:0808:0808::]', '[2606:4700::1111]']) assert.ok(!privateHost(h), h);
  assert.equal(addressAllowed('http://[2002:7f00:1::]/').why, 'private');
});

test('deleting an account erases its cloud browser object (history, bookmarks, agent log)', async () => {
  const a = await browser(A);
  await call(env, A, 'signin', { account_id: A, device: { name: 'iPhone', kind: 'iphone' } });
  const stub = env.BROWSER_SESSIONS.get(A);
  assert.ok(stub);
  const store = env.BROWSER_SESSIONS.objects.get(A).storage;
  await store.put('hist', [{ url: 'https://example.com/private', title: 'x', at: 1 }]);
  await store.put('bm', [{ url: 'https://example.com/b' }]);
  await store.put('agentLog', [{ step: 'opened a page' }]);
  const other = env.BROWSER_SESSIONS.get(B);
  assert.ok(other);
  await env.BROWSER_SESSIONS.objects.get(B).storage.put('hist', [{ url: 'https://example.com/mine' }]);
  const gone = await hit('/api/web/account/delete', { method: 'POST', body: { confirm: 'DELETE' }, session: a });
  assert.ok(gone.status < 300, await gone.clone().text());
  assert.deepEqual([...(await store.list()).keys()], []);
  assert.deepEqual([...(await env.BROWSER_SESSIONS.objects.get(B).storage.list()).keys()], ['hist'], 'another account’s browser is untouched');
});

test('the browser object answers only a socket upgrade or the erase op', async () => {
  const stub = env.BROWSER_SESSIONS.get(A);
  assert.equal((await stub.fetch('https://browser/other', { method: 'POST' })).status, 426);
  assert.equal((await stub.fetch('https://browser/erase', { method: 'POST' })).status, 200);
});

test('a delegate can’t steer the owner’s cloud browser run', async () => {
  const owner = await browser(A);
  await call(env, A, 'signin', { account_id: A, device: { name: 'iPhone', kind: 'iphone' } });
  const inv = await (await hit('/api/web/deleg/invite', { method: 'POST', session: owner, body: { name: 'Sam', from: 'Bilel', cap_usd: 1, features: ['chat'], days: 30 } })).json();
  const sam = await browser(B);
  await hit('/api/web/deleg/accept', { method: 'POST', session: sam, body: { code: inv.code } });
  const mine = await (await hit('/api/web/deleg', { session: sam })).json();
  const use = await hit('/api/web/deleg/use', { method: 'POST', session: sam, body: { id: mine.mine[0].id } });
  const acting = use.headers.getSetCookie().find((c) => c.startsWith('__Host-eden-as=')).slice('__Host-eden-as='.length).split(';')[0];
  const r = await hit('/api/chat/browser/steer', { method: 'POST', session: sam, acting, body: { runId: 'abcdef0123456789', text: 'go to evil.com' } });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'grant_forbidden');
  // the owner's own steer still reaches the browser object (no run: 404, not 403)
  const own = await hit('/api/chat/browser/steer', { method: 'POST', session: owner, body: { runId: 'abcdef0123456789', text: 'hi' } });
  assert.equal(own.status, 404);
});
