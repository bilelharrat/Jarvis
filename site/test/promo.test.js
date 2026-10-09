// Promo codes (accounts/promo.js): minted by the owner's token, redeemed once per account, free
// Plus that stacks, ends on its own, and gives the use back when the account can't take it.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { parseToken } from '../src/accounts/util.js';
import { cleanPromo } from '../src/accounts/promo.js';
import { Promo } from '../src/accounts/promo.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ADMIN = 'admin-token-for-tests-0123456789';
const DAY = 86400_000;
const ctx = { waitUntil: () => {} };
let env;

beforeEach(() => {
  forgetSessions();
  env = { TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '6', PROMO_ADMIN_TOKEN: ADMIN, LINK_RATE: rateLimiter(), API_RATE: rateLimiter(), EDEN_RATE: rateLimiter(), AUTH_RATE: rateLimiter() };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.IDENTITIES = namespace(Identity, env);
  env.PROMOS = namespace(Promo, env);
  env.ASSETS = { fetch: async () => new Response('asset') };
});

const iphone = async (account) => (await call(env, account, 'signin', { account_id: account, device: { name: 'iPhone', kind: 'iphone' } })).token;
const mint = (body, token = ADMIN, extra = {}) =>
  worker.fetch(new Request(`${ORIGIN}/api/admin/promo`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) }), env, ctx);
const redeem = (token, code) =>
  worker.fetch(new Request(`${ORIGIN}/api/promo/redeem`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ code }) }), env, ctx);
const plan = async (token, account) => (await call(env, account, 'get', {}, parseToken(token))).plan;

test('codes are typed loosely and kept in one shape', () => {
  assert.equal(cleanPromo('eden abcd 2345'), 'EDEN-ABCD-2345');
  assert.equal(cleanPromo('ABCD2345'), 'EDEN-ABCD-2345');
  assert.equal(cleanPromo('EDEN-ABCD-234'), null);
  assert.equal(cleanPromo('EDEN-ABCD-23O5'), null); // no O
  assert.equal(cleanPromo(''), null);
});

test('only the owner’s token mints codes, and never from a web page', async () => {
  assert.equal((await mint({ days: 30 }, 'wrong-wrong-wrong-wrong-wrong')).status, 401);
  assert.equal((await mint({ days: 30 }, ADMIN, { origin: ORIGIN })).status, 403);
  env.PROMO_ADMIN_TOKEN = '';
  assert.equal((await mint({ days: 30 })).status, 503);
  env.PROMO_ADMIN_TOKEN = ADMIN;
  assert.equal((await mint({ days: 0 })).status, 400);
  assert.equal((await mint({ days: 400 })).status, 400);
  assert.equal((await mint({ days: 30, count: 501 })).status, 400);
  const ok = await mint({ days: 30, count: 3, note: 'launch' });
  assert.equal(ok.status, 201);
  const { codes } = await ok.json();
  assert.equal(codes.length, 3);
  assert.equal(new Set(codes).size, 3);
  for (const code of codes) assert.match(code, /^EDEN-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
});

test('a code gives free Plus once per account, and stacks days across codes', async () => {
  const [one, two] = (await (await mint({ days: 30, count: 2 })).json()).codes;
  const token = await iphone(A);
  assert.equal((await plan(token, A)).active, false);
  const first = await redeem(token, one.toLowerCase());
  assert.equal(first.status, 200);
  const got = await first.json();
  assert.equal(got.days, 30);
  let p = await plan(token, A);
  assert.equal(p.active, true);
  assert.equal(p.name, 'plus');
  assert.equal(p.source, 'promo');
  assert.equal(p.renews, false);
  assert.ok(Math.abs(p.expires - (Date.now() + 30 * DAY)) < 60_000);
  const view = await call(env, A, 'get', {}, parseToken(token));
  assert.equal(view.usage.budget_usd, 6);
  // The same code again: refused, nothing added.
  const again = await redeem(token, one);
  assert.equal(again.status, 409);
  assert.equal((await again.json()).code, 'already_used');
  // Another code stacks after the first ends.
  assert.equal((await redeem(token, two)).status, 200);
  p = await plan(token, A);
  assert.ok(Math.abs(p.expires - (Date.now() + 60 * DAY)) < 60_000);
});

test('max_uses, expiry and bad codes', async () => {
  const [single] = (await (await mint({ days: 7 })).json()).codes; // max_uses defaults to 1
  const a = await iphone(A);
  const b = await iphone(B);
  assert.equal((await redeem(a, single)).status, 200);
  const spent = await redeem(b, single);
  assert.equal(spent.status, 409);
  assert.equal((await spent.json()).code, 'used_up');
  assert.equal((await plan(b, B)).active, false);
  assert.equal((await redeem(b, 'EDEN-ZZZZ-ZZZZ')).status, 404);
  assert.equal((await redeem(b, 'nonsense')).status, 400);
  // Expired.
  const [old] = (await (await mint({ days: 7, expires_days: 1 })).json()).codes;
  const real = Date.now;
  Date.now = () => real() + 2 * DAY;
  try {
    assert.equal((await redeem(b, old)).status, 410);
  } finally {
    Date.now = real;
  }
  // A multi-use code.
  const [many] = (await (await mint({ days: 7, max_uses: 2 })).json()).codes;
  assert.equal((await redeem(a, many)).status, 200);
  assert.equal((await redeem(b, many)).status, 200);
});

test('promo Plus ends on its own, and the browser can redeem too', async () => {
  const [code] = (await (await mint({ days: 1 })).json()).codes;
  const token = await call(env, A, 'web-signin', { account_id: A, create: true, device: { name: 'Eden on the web: Safari on a Mac' } }).then((r) => r.token);
  const res = await worker.fetch(new Request(`${ORIGIN}/api/web/billing/promo`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-jarvis-chat': '1', cookie: `__Host-eden=${token}`, 'user-agent': 'Mozilla/5.0 Safari/605' }, body: JSON.stringify({ code }) }), env, ctx);
  assert.equal(res.status, 200);
  assert.equal((await plan(token, A)).active, true);
  const real = Date.now;
  Date.now = () => real() + 2 * DAY;
  try {
    assert.equal((await plan(token, A)).active, false);
  } finally {
    Date.now = real;
  }
});

test('signed out: no redeeming', async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/promo/redeem`, { method: 'POST', body: JSON.stringify({ code: 'EDEN-ABCD-2345' }) }), env, ctx);
  assert.equal(res.status, 401);
});
