// GET /api/admin/providers (stats/admin.js): each provider's own bill, apart from /api/admin/stats so it never slows it.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { forgetSessions } from '../src/eden/session.js';
import { collect } from '../src/stats/admin.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const realFetch = globalThis.fetch;
const realNow = Date.now;
let env;
let moonshot; // calls to Moonshot's balance
let moonshotOk;
const ctx = { waitUntil: () => {} };

beforeEach(() => {
  forgetSessions();
  moonshot = 0;
  moonshotOk = true;
  env = {
    LINK_RATE: rateLimiter(), API_RATE: rateLimiter(), EDEN_RATE: rateLimiter(), AUTH_RATE: rateLimiter(),
    ADMIN_EMAILS: 'owner@example.com', EDEN_TOKEN_KEY: 'k'.repeat(64), MOONSHOT_API_KEY: 'mk',
  };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.IDENTITIES = namespace(Identity, env);
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.moonshot.ai')) {
      moonshot++;
      return moonshotOk
        ? new Response(JSON.stringify({ data: { available_balance: 50, cash_balance: 50, voucher_balance: 0 } }), { headers: { 'content-type': 'application/json' } })
        : new Response('{}', { status: 500 });
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };
});
afterEach(() => { globalThis.fetch = realFetch; Date.now = realNow; });

const browser = async (account, email) => (await call(env, account, 'web-signin', { account_id: account, create: true, identity: { provider: 'google', sub_hash: 'h'.repeat(64), email }, device: { name: 'Eden on the web: Safari on a Mac' } })).token;
const req = (path, token, method = 'GET') => worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) Safari/605', ...(token ? { cookie: `__Host-eden=${token}` } : {}) } }), env, ctx);

test('the owner only, GET only; the owner gets the providers, cached ten minutes; ?fresh=1 reads again', async () => {
  const owner = await browser(A, 'Owner@Example.com');
  const other = await browser(B, 'someone@example.com');
  assert.equal((await req('/api/admin/providers')).status, 404, 'signed out');
  assert.equal((await req('/api/admin/providers', other)).status, 404, 'not the owner');
  assert.equal((await req('/api/admin/providers', owner, 'POST')).status, 404, 'POST');
  assert.equal(moonshot, 0, 'nothing read for them');

  const res = await req('/api/admin/providers?fresh=1', owner);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const data = await res.json();
  assert.ok(Array.isArray(data.providers));
  const kimi = data.providers.find((p) => p.id === 'kimi');
  assert.deepEqual([kimi.status, kimi.balance.usd], ['ok', 50]);
  assert.equal(moonshot, 1);

  await (await req('/api/admin/providers', owner)).json();
  assert.equal(moonshot, 1, 'a plain call within ten minutes uses the cache');
  await (await req('/api/admin/providers?fresh=1', owner)).json();
  assert.equal(moonshot, 2, '?fresh=1 reads again');
});

test('a total failure is kept 30 s, not ten minutes', async () => {
  const owner = await browser(A, 'owner@example.com');
  moonshotOk = false;
  const first = await (await req('/api/admin/providers?fresh=1', owner)).json();
  assert.equal(first.providers.find((p) => p.id === 'kimi').status, 'error');
  assert.equal(moonshot, 1);
  await req('/api/admin/providers', owner);
  assert.equal(moonshot, 1, 'within 30 s: the cache');
  const t0 = realNow();
  Date.now = () => t0 + 31_000;
  moonshotOk = true;
  const again = await (await req('/api/admin/providers', owner)).json();
  assert.equal(moonshot, 2, 'after 30 s: read again');
  assert.equal(again.providers.find((p) => p.id === 'kimi').status, 'ok');
});

test('/api/admin/stats (collect) no longer reads or returns the providers', async () => {
  const out = await collect(env, new URL(`${ORIGIN}/api/admin/stats?fresh=1`));
  assert.ok(!('providers' in out));
  assert.equal(moonshot, 0);
});
