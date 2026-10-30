// The shared TEST account (src/accounts/test-login.js): off by default and then nothing changes; on (TEST_LOGIN = "on"
// and the secret TEST_LOGIN_PASSWORD), test@askeden.com + the password signs in to one fixed account with Plus, a daily
// AI cap, an allow-list of routes, per-network limits, a daily wipe, 24-hour sessions, and switch-off ends them all.
// No paid calls, no real accounts: in-memory Durable Objects (fakes.js) and a fake password of this file's own.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { parseToken } from '../src/accounts/util.js';
import { forgetSessions } from '../src/eden/session.js';
import { TEST_ACCOUNT_ID, TEST_ALLOWANCE_USED, TEST_BANNER, TEST_FAILED, TEST_RATE_OBJECT, testRouteAllowed } from '../src/accounts/test-login.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const FAKE_PASSWORD = 'fake-test-password-for-unit-tests-only';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ctx = { waitUntil: () => {} };
const DAY = 86400_000;
let env;

const fresh = (extra = {}) => {
  forgetSessions();
  env = { TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '6', LINK_RATE: rateLimiter(), API_RATE: rateLimiter(), EDEN_RATE: rateLimiter(), AUTH_RATE: rateLimiter(), ...extra };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.IDENTITIES = namespace(Identity, env);
  env.ASSETS = { fetch: async () => new Response('asset') };
};
beforeEach(() => fresh({ TEST_LOGIN: 'on', TEST_LOGIN_PASSWORD: FAKE_PASSWORD }));

const cookieValue = (r, name) => {
  for (const c of r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || '']) {
    const m = new RegExp(`^${name}=([^;]*)`).exec(c);
    if (m) return m[1];
  }
  return null;
};

function hit(path, { method = 'GET', body, session, origin = ORIGIN, ip = '203.0.113.7', headers = {} } = {}) {
  const h = { 'cf-connecting-ip': ip, 'x-jarvis-chat': '1', ...headers };
  if (origin) h.origin = origin;
  if (session) h.cookie = `__Host-eden=${session}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
}

const signIn = (password = FAKE_PASSWORD, { email = 'test@askeden.com', ip, origin } = {}) => hit('/api/web/test-login', { method: 'POST', body: { email, password }, ip, origin });

async function session() {
  const r = await signIn();
  assert.equal(r.status, 200);
  const s = cookieValue(r, '__Host-eden');
  assert.ok(s);
  return s;
}

const testObject = () => env.ACCOUNTS.objects.get(TEST_ACCOUNT_ID);

// ── switch off: nothing changes ──

test('off (unset, "off", or on without the password): test@askeden.com is nothing special, config unchanged', async () => {
  for (const vars of [{}, { TEST_LOGIN: 'off', TEST_LOGIN_PASSWORD: FAKE_PASSWORD }, { TEST_LOGIN: 'on' }, { TEST_LOGIN: 'on', TEST_LOGIN_PASSWORD: '' }, { TEST_LOGIN_PASSWORD: FAKE_PASSWORD }]) {
    fresh(vars);
    const r = await signIn();
    assert.equal(r.status, 404, JSON.stringify(vars));
    assert.equal(cookieValue(r, '__Host-eden'), null);
    assert.equal(env.ACCOUNTS.objects.has(TEST_ACCOUNT_ID), false); // no account made
    assert.equal(env.ACCOUNTS.objects.has(TEST_RATE_OBJECT), false);
    const config = await (await hit('/api/web/config')).json();
    assert.equal('test_login' in config, false);
  }
  fresh({});
  const plain = await (await hit('/api/web/config')).json();
  fresh({ TEST_LOGIN: 'off' });
  assert.deepEqual(await (await hit('/api/web/config')).json(), plain);
});

test('off: a normal account and its routes are untouched by the guard', async () => {
  fresh({});
  const made = await call(env, OTHER, 'web-signin', { account_id: OTHER, create: true, identity: { provider: 'passkey', sub_hash: 'a'.repeat(64), email: 'test@askeden.com' }, device: { name: 'Safari' } });
  const r = await hit('/api/web/session', { session: made.token });
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.account_id, OTHER);
  assert.equal('test' in s, false);
  assert.notEqual(s.plan.source, 'promo');
  assert.equal(s.plan.active, false); // an identity's email test@askeden.com gives nothing
});

// ── switch on ──

test('on: the config says so, and the right email + password sign in to the one test account with Plus', async () => {
  assert.equal((await (await hit('/api/web/config')).json()).test_login, true);
  const r = await signIn('fake-test-password-for-unit-tests-only', { email: '  Test@AskEden.com ' });
  assert.equal(r.status, 200);
  const set = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')]).join('\n');
  assert.match(set, /__Host-eden=jv1\.[^;]+; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=86400/);
  assert.doesNotMatch(set, /__Host-eden-last/); // the test account is nobody's "last way in"
  const token = parseToken(cookieValue(r, '__Host-eden'));
  assert.equal(token.account, TEST_ACCOUNT_ID);
  const s = await (await hit('/api/web/session', { session: cookieValue(r, '__Host-eden') })).json();
  assert.equal(s.account_id, TEST_ACCOUNT_ID);
  assert.equal(s.plan.active, true);
  assert.equal(s.plan.name, 'plus');
  assert.equal(s.plan.source, 'promo'); // a promo-style grant: never Stripe, never the App Store
  assert.equal(s.plan.renews, false);
  assert.equal(s.plan.test, true);
  assert.equal(s.plan.unlimited, undefined);
  assert.equal(s.test, undefined); // no banner (owner, 2026-10-28)
  assert.equal(s.usage.budget_usd, 2);
  assert.deepEqual(s.identities, []);
  // A second tester lands in the same account, with a session of their own.
  const two = parseToken(cookieValue(await signIn(), '__Host-eden'));
  assert.equal(two.account, TEST_ACCOUNT_ID);
  assert.notEqual(two.device, token.device);
  const stored = await testObject().storage.get(`dev:${token.device}`);
  assert.equal(stored.name, 'Test session'); // no browser or city for the next tester to see
  assert.equal(stored.expires - stored.created, DAY);
  assert.equal(JSON.stringify([...testObject().storage.map]).includes(FAKE_PASSWORD), false); // the password is never stored
});

test('on: a wrong password or email gets the one generic answer, and no session', async () => {
  for (const [password, email] of [['wrong', 'test@askeden.com'], ['', 'test@askeden.com'], [FAKE_PASSWORD, 'test2@askeden.com'], [FAKE_PASSWORD, ''], [`${FAKE_PASSWORD} `, 'test@askeden.com']]) {
    const r = await signIn(password, { email });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error, TEST_FAILED);
    assert.equal(cookieValue(r, '__Host-eden'), null);
  }
  const bad = await hit('/api/web/test-login', { method: 'POST', body: { email: 'test@askeden.com', password: 42 } });
  assert.equal((await bad.json()).error, TEST_FAILED);
  // Only askeden.com's own page may post it.
  assert.equal((await signIn(FAKE_PASSWORD, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await signIn(FAKE_PASSWORD, { origin: null })).status, 403);
});

test('on: the daily AI cap is enforced in the account (TEST_LOGIN_DAILY_USD, default $2), then the normal "used up" answer', async () => {
  const token = parseToken(await session());
  let allow = await call(env, TEST_ACCOUNT_ID, 'allow-ai', { eden: true }, token);
  assert.equal(allow.ok, true);
  assert.equal(allow.left, 2);
  assert.equal(allow.credits_usd, 0);
  await call(env, TEST_ACCOUNT_ID, 'spend', { usd: 1.5, bucket: 'plus' });
  allow = await call(env, TEST_ACCOUNT_ID, 'allow-ai', { eden: true }, token);
  assert.equal(allow.left, 0.5);
  assert.equal((await call(env, TEST_ACCOUNT_ID, 'hold-ai', { usd: 1, eden: true }, token)).ok, false); // more than is left
  await call(env, TEST_ACCOUNT_ID, 'spend', { usd: 0.6, bucket: 'plus' });
  allow = await call(env, TEST_ACCOUNT_ID, 'allow-ai', { eden: true }, token);
  assert.equal(allow.ok, false);
  assert.equal(allow.why, TEST_ALLOWANCE_USED);
  assert.equal((await call(env, TEST_ACCOUNT_ID, 'hold-ai', { usd: 0.01, eden: true }, token)).ok, false);
  // The cap is the Worker var's.
  env.TEST_LOGIN_DAILY_USD = '5';
  assert.equal((await call(env, TEST_ACCOUNT_ID, 'allow-ai', { eden: true }, token)).ok, true);
  env.TEST_LOGIN_DAILY_USD = '0';
  assert.equal((await call(env, TEST_ACCOUNT_ID, 'allow-ai', { eden: true }, token)).ok, false);
});

test('on: every blocked feature is refused for a test session, with a clear message', async () => {
  const s = await session();
  const blocked = [
    ['POST', '/api/chat/google/connect', {}], ['GET', '/api/chat/google/connect'], ['POST', '/api/chat/gmail', {}], ['POST', '/api/chat/gcal', {}], ['POST', '/api/chat/sheets', {}], ['POST', '/api/chat/approve', {}],
    ['GET', '/api/web/mac-link'], ['GET', '/api/web/mac-link/ABCD-EFGH'], ['POST', '/api/web/mac-link/ABCD-EFGH/approve', {}], ['POST', '/api/link/ABCD-EFGH/approve', {}], ['POST', '/api/link/start', {}], ['POST', '/api/chat/jarvis', {}], ['POST', '/api/chat/mac/send', {}],
    ['GET', '/api/chat/keys'], ['POST', '/api/chat/keys', {}], ['GET', '/api/web/apps'], ['POST', '/api/eden/connect', {}],
    ['POST', '/api/web/billing/checkout', {}], ['POST', '/api/web/billing/credits', {}], ['POST', '/api/web/billing/portal', {}], ['POST', '/api/promo/redeem', { code: 'EDEN-AAAA-BBBB' }], ['POST', '/api/subscription', {}],
    ['POST', '/api/chat/publish', {}], ['GET', '/api/chat/published'], ['POST', '/api/chat/share', {}], ['GET', '/api/chat/shares'], ['POST', '/api/chat/audience', {}], ['GET', '/api/chat/deck-room/abc'],
    ['POST', '/api/chat/receipts', {}], ['POST', '/api/chat/autodrafts', {}], ['POST', '/api/chat/tasks', {}], ['POST', '/api/chat/courses', {}],
    ['POST', '/api/web/deleg/invite', {}], ['POST', '/api/web/space/create', {}], ['POST', '/api/web/merge', {}],
    ['GET', '/api/admin/stats'], ['GET', '/api/admin/keys'], ['GET', '/api/admin/leads'], ['POST', '/api/admin/promo', {}], ['POST', '/api/chat/eves/flag', {}],
    ['POST', '/api/web/passkey/options', { mode: 'add' }], ['GET', '/api/web/apple?link=1'], ['GET', '/api/web/google?link=1'], ['POST', '/api/web/identities/apple/unlink', {}],
    ['POST', '/api/web/account/delete', { confirm: 'DELETE' }], ['POST', '/api/web/signout-everywhere', {}], ['POST', '/api/web/devices/0123456789abcdef/signout', {}],
    ['GET', '/api/account'], ['POST', '/api/anthropic/v1/messages', {}],
  ];
  for (const [method, path, body] of blocked) {
    const r = await hit(path, { method, body, session: s });
    assert.equal(r.status, 403, `${method} ${path}`);
    const out = await r.json();
    assert.equal(out.code, 'test_account', `${method} ${path}`);
    assert.match(out.error, /test account/);
  }
  // The same with the token as a Bearer (the apps' routes).
  const bearer = await hit('/api/account', { headers: { authorization: `Bearer ${s}` }, origin: null });
  assert.equal(bearer.status, 403);
  // What a tester needs still works.
  assert.equal((await hit('/api/web/session', { session: s })).status, 200);
  assert.equal((await hit('/api/web/account', { session: s })).status, 200);
  assert.equal(testRouteAllowed('POST', '/api/chat/send'), true);
  assert.equal(testRouteAllowed('POST', '/api/web/csync/put'), true);
  // The account's object refuses the same ops again, whoever asks.
  const token = parseToken(s);
  for (const op of ['ukeys-save', 'scoped-code', 'pub-put', 'share-put', 'deleg-invite', 'stripe-checkout', 'add-device', 'promo-grant', 'subscription', 'delete', 'browsers-signout', 'identity-link', 'google-save', 'mail-schedule', 'task-add', 'edu-grant', 'web-signin']) {
    await assert.rejects(call(env, TEST_ACCOUNT_ID, op, { confirm: 'DELETE', account_id: TEST_ACCOUNT_ID }, token), (e) => e.status === 403 && e.code === 'test_account', op);
  }
});

test('on: 10 sign-in tries an hour per network; 10 failures lock the test login there for an hour', async () => {
  const rate = () => env.ACCOUNTS.objects.get(TEST_RATE_OBJECT);
  const t0 = Date.parse('2026-11-02T10:00:00Z');
  await signIn('wrong'); // makes the rate object
  rate().now = () => t0;
  await rate().storage.deleteAll();
  for (let i = 0; i < 10; i++) assert.equal((await signIn('wrong')).status, 401);
  const locked = await signIn();
  assert.equal(locked.status, 429); // even with the right password
  assert.equal(cookieValue(locked, '__Host-eden'), null);
  rate().now = () => t0 + 59 * 60_000;
  assert.equal((await signIn()).status, 429);
  assert.equal((await signIn(FAKE_PASSWORD, { ip: '198.51.100.9' })).status, 200); // another network isn't locked
  rate().now = () => t0 + 61 * 60_000;
  assert.equal((await signIn()).status, 200);
  // Successes count too: 10 an hour.
  const ip = '192.0.2.44';
  for (let i = 0; i < 10; i++) assert.equal((await signIn(FAKE_PASSWORD, { ip })).status, 200);
  assert.equal((await signIn(FAKE_PASSWORD, { ip })).status, 429);
  // The address itself is never kept: only a hash.
  assert.equal(JSON.stringify([...rate().storage.map]).includes(ip), false);
});

test('on: a test session\'s requests are rate limited per network', async () => {
  const s = await session();
  env.API_RATE = rateLimiter(3);
  for (let i = 0; i < 3; i++) assert.equal((await hit('/api/web/session', { session: s })).status, 200);
  assert.equal((await hit('/api/web/session', { session: s })).status, 429);
  assert.ok(env.API_RATE.keys.every((k) => k.startsWith('test-ip:')));
});

test('on: everything of the test account is wiped at the first use of a new UTC day', async () => {
  const s = await session();
  const token = parseToken(s);
  const created = (await testObject().storage.get(`dev:${token.device}`)).created;
  const midnight = Date.parse(`${new Date(created).toISOString().slice(0, 10)}T00:00:00Z`) + DAY;
  await testObject().storage.put('mem:note', { text: 'something a tester typed' });
  const { id } = await call(env, TEST_ACCOUNT_ID, 'artifact-put', { html: '<p>hi</p>' }, token);
  await call(env, TEST_ACCOUNT_ID, 'spend', { usd: 1.9, bucket: 'plus' });
  assert.ok(await call(env, TEST_ACCOUNT_ID, 'artifact-get', { id }, token));
  testObject().now = () => midnight + 1000; // just after midnight UTC: the session has hours left, but it's a new day
  forgetSessions();
  await assert.rejects(call(env, TEST_ACCOUNT_ID, 'whoami', {}, token), (e) => e.status === 401); // yesterday's session ended with the wipe
  assert.equal(await testObject().storage.get('mem:note'), undefined);
  assert.equal((await hit('/api/web/session', { session: s })).status, 401);
  const s2 = parseToken(await session());
  assert.equal((await call(env, TEST_ACCOUNT_ID, 'allow-ai', { eden: true }, s2)).left, 2); // the day's AI starts again
  await assert.rejects(call(env, TEST_ACCOUNT_ID, 'artifact-get', { id }, s2));
  assert.equal((await call(env, TEST_ACCOUNT_ID, 'get', {}, s2)).plan.active, true);
});

test('on: a test session ends after 24 hours', async () => {
  const s = await session();
  const token = parseToken(s);
  const device = await testObject().storage.get(`dev:${token.device}`);
  testObject().now = () => device.created + DAY - 1000;
  await testObject().storage.put('test_day', new Date(device.created + DAY - 1000).toISOString().slice(0, 10)); // the same "day", to see the expiry alone
  assert.equal((await call(env, TEST_ACCOUNT_ID, 'whoami', {}, token)).account_id, TEST_ACCOUNT_ID);
  testObject().now = () => device.created + DAY + 1000;
  await testObject().storage.put('test_day', new Date(device.created + DAY + 1000).toISOString().slice(0, 10));
  await assert.rejects(call(env, TEST_ACCOUNT_ID, 'whoami', {}, token), (e) => e.status === 401);
});

test('switching the test login off ends every test session at once, and they stay ended when it comes back on', async () => {
  const a = await session();
  const b = await session();
  assert.equal((await hit('/api/web/session', { session: a })).status, 200);
  env.TEST_LOGIN = 'off';
  for (const s of [a, b]) {
    const r = await hit('/api/web/session', { session: s });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('set-cookie') || '', /__Host-eden=; .*Max-Age=0/);
    assert.equal((await hit('/api/chat/meta', { session: s })).status, 401);
  }
  await assert.rejects(call(env, TEST_ACCOUNT_ID, 'whoami', {}, parseToken(a)), (e) => e.status === 401);
  assert.equal((await signIn()).status, 404);
  env.TEST_LOGIN = 'on';
  forgetSessions();
  assert.equal((await hit('/api/web/session', { session: a })).status, 401);
  assert.equal((await hit('/api/web/session', { session: b })).status, 401);
  // Removing the secret is off too; changing it ends the sessions made under the old one.
  const c = await session();
  env.TEST_LOGIN_PASSWORD = 'another-fake-password';
  forgetSessions();
  assert.equal((await hit('/api/web/session', { session: c })).status, 401);
});

test('the test account never reaches another account, and its sign-in never touches another account\'s object', async () => {
  const other = await call(env, OTHER, 'web-signin', { account_id: OTHER, create: true, identity: { provider: 'passkey', sub_hash: 'b'.repeat(64), email: null }, device: { name: 'Safari' } });
  const s = await session();
  const t = parseToken(s);
  // Its token opens nothing in another account's object.
  await assert.rejects(call(env, OTHER, 'get', {}, t), (e) => e.status === 401);
  await assert.rejects(call(env, OTHER, 'whoami', {}, t), (e) => e.status === 401);
  // A forged cookie naming another account with the test session's secret: signed out.
  const forged = `jv1.${OTHER}.${t.device}.${t.secret}`;
  assert.equal((await hit('/api/web/session', { session: forged })).status, 401);
  // The test sign-in op refuses any other account's object.
  await assert.rejects(call(env, OTHER, 'test-signin', { account_id: TEST_ACCOUNT_ID }), (e) => e.status === 403);
  await assert.rejects(call(env, OTHER, 'test-signin', { account_id: OTHER }), (e) => e.status === 403);
  // The other account is untouched: its plan, its session, no test banner.
  const mine = await (await hit('/api/web/session', { session: other.token })).json();
  assert.equal(mine.account_id, OTHER);
  assert.equal(mine.plan.active, false);
  assert.equal('test' in mine, false);
  const keys = await hit('/api/chat/keys', { session: other.token });
  assert.notEqual((await keys.json()).code, 'test_account'); // the guard leaves it alone
});
