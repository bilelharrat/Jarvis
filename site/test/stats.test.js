// The owner's dashboard (src/stats/): what the Worker counts, who may see it, and the unlimited emails.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { parseToken } from '../src/accounts/util.js';
import { forgetSessions } from '../src/eden/session.js';
import { productOf, routeName, deviceOf, record } from '../src/stats/stats.js';
import { RouterApi } from '../src/router-api/store.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';

/** Cloudflare D1, on Node's own SQLite (the same SQL). */
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  const statement = (sql, args = []) => ({
    sql,
    args,
    bind: (...a) => statement(sql, a),
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
    all: async () => ({ results: db.prepare(sql).all(...args) }),
  });
  return {
    db,
    prepare: (sql) => statement(sql),
    batch: async (list) => list.map((s) => (/^\s*(SELECT|WITH)/i.test(s.sql) ? { results: s.args.length ? db.prepare(s.sql).all(...s.args) : db.prepare(s.sql).all() } : (db.prepare(s.sql).run(...s.args), { results: [] }))),
  };
}

const ORIGIN = 'https://askeden.com';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let env;
let pending;
const ctx = { waitUntil: (p) => pending.push(p) };
const settle = async () => { while (pending.length) await pending.shift(); };
const rows = (where = '1=1') => env.STATS.db.prepare(`SELECT * FROM events WHERE ${where} ORDER BY ts`).all();

beforeEach(() => {
  forgetSessions();
  pending = [];
  env = {
    TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '6', LINK_RATE: rateLimiter(), API_RATE: rateLimiter(), EDEN_RATE: rateLimiter(), AUTH_RATE: rateLimiter(),
    ADMIN_EMAILS: 'owner@example.com, Second@Example.com', UNLIMITED_EMAILS: 'owner@example.com brother@example.com', EDEN_TOKEN_KEY: 'k'.repeat(64),
    STATS: fakeD1(),
  };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.IDENTITIES = namespace(Identity, env);
  env.ROUTER_API = namespace(RouterApi, env);
  env.ASSETS = { fetch: async (req) => new Response(`<html>${new URL(req.url).pathname}</html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } }) };
});

const browser = async (account, email) => {
  const r = await call(env, account, 'web-signin', { account_id: account, create: true, identity: { provider: 'google', sub_hash: 'h'.repeat(64), email }, device: { name: 'Eden on the web: Safari on a Mac' } });
  return r.token;
};
const get = (path, headers = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605', ...headers } }), env, ctx);

test('every product is named', () => {
  assert.equal(productOf('askedenedu.com', '/'), 'edu');
  assert.equal(productOf('askeden.com', '/edu'), 'edu');
  assert.equal(productOf('askedenmail.com', '/'), 'mail');
  assert.equal(productOf('askeden.com', '/mail'), 'mail');
  assert.equal(productOf('askeden.com', '/eden-code'), 'code');
  assert.equal(productOf('askedencode.com', '/'), 'code');
  assert.equal(productOf('askeden.com', '/jarvis/download'), 'secretary');
  assert.equal(productOf('askeden.com', '/daredevil/windows'), 'daredevil');
  assert.equal(productOf('askeden.com', '/download/mac'), 'ask-eden');
  assert.equal(productOf('askeden.com', '/messenger/iphone'), 'messenger');
  assert.equal(productOf('askeden.com', '/router'), 'router');
  assert.equal(productOf('askeden.com', '/'), 'eden');
  assert.equal(productOf('askeden.com', '/home'), 'site');
  assert.equal(routeName('/api/web/devices/0123456789abcdef/signout'), '/api/web/devices/:id/signout');
  assert.equal(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'iphone');
  assert.equal(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'windows');
});

test('a page visit and a download are counted with where they came from, never the address', async () => {
  await get('/privacy', { 'cf-connecting-ip': '203.0.113.9', referer: 'https://news.ycombinator.com/item?id=1' });
  const req = new Request(`${ORIGIN}/download/windows`, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
  Object.defineProperty(req, 'cf', { value: { country: 'FR', region: 'Île-de-France', city: 'Paris' } });
  const res = await worker.fetch(req, env, ctx);
  assert.equal(res.status, 302);
  await get('/privacy', { 'user-agent': 'Googlebot/2.1' }); // bots aren't visitors
  await settle();
  const visits = rows("kind = 'visit'");
  assert.equal(visits.length, 1);
  assert.equal(visits[0].name, '/privacy');
  assert.equal(visits[0].product, 'site');
  assert.equal(visits[0].ref, 'news.ycombinator.com');
  assert.match(visits[0].visitor, /^[0-9a-f]{16}$/);
  const [download] = rows("kind = 'download'");
  assert.deepEqual([download.name, download.product, download.country, download.city, download.device], ['windows', 'ask-eden', 'FR', 'Paris', 'windows']);
  assert.ok(!JSON.stringify(rows()).includes('203.0.113.9'));
});

test('only the owner’s emails open /admin and its numbers', async () => {
  const owner = await browser(A, 'Owner@Example.com');
  const other = await browser(B, 'someone@example.com');
  assert.equal((await get('/admin')).status, 302); // signed out: sign in first
  assert.equal((await get('/admin', { cookie: `__Host-eden=${other}` })).status, 404);
  assert.equal((await get('/api/admin/stats', { cookie: `__Host-eden=${other}` })).status, 404);
  const page = await get('/admin', { cookie: `__Host-eden=${owner}` });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  await record(env, { kind: 'signup', name: 'google', country: 'US' });
  await record(env, { kind: 'visit', name: '/', country: 'US', device: 'mac' });
  await record(env, { kind: 'download', name: 'mac', country: 'US', device: 'mac' });
  await record(env, { kind: 'ai', name: 'chat', usd: 0.25, tin: 1000, tout: 200, model: 'claude-sonnet-5-5', user: 'u1' });
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }); // GitHub: no releases; Stripe: no key
  try {
    const res = await get('/api/admin/stats', { cookie: `__Host-eden=${owner}` });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.events.ready, true, data.events.error);
    assert.equal(data.events.counts.find((c) => c.kind === 'signup').total, 1);
    assert.equal(data.events.ai.total, 0.25);
    assert.equal(data.events.ai.tok_total, 1200);
    assert.equal(data.events.ai.by_feature[0].name, 'chat');
    assert.equal(data.stripe.error, 'STRIPE_SECRET_KEY is not set.');
    assert.equal(data.messenger.error, 'not connected');
    assert.equal(data.unlimited, 2);
    // one row per country, device and model, whatever the events were
    assert.deepEqual(data.events.countries.map((c) => [c.name, c.visits, c.downloads, c.signups]), [['US', 1, 1, 1], ['??', 0, 0, 0]]);
    assert.equal(data.events.devices.filter((d) => d.name === 'mac').length, 1);
    assert.deepEqual(data.events.ai.by_model.map((m) => m.name), ['claude-sonnet-5-5']);
    assert.deepEqual(data.events.ai.by_product.map((m) => m.name), ['eden']);
  } finally {
    globalThis.fetch = real;
  }
});

test('an unlimited email has Plus for good and a big allowance; AI use is counted, scrambled', async () => {
  const token = await browser(A, 'brother@example.com');
  const plain = await browser(B, 'nobody@example.com');
  const view = await call(env, A, 'get', {}, parseToken(token));
  assert.equal(view.plan.active, true);
  assert.equal(view.plan.source, 'unlimited');
  const allow = await call(env, A, 'allow-ai', { eden: true }, parseToken(token));
  assert.equal(allow.bucket, 'plus');
  assert.equal(allow.budget, 1000);
  assert.equal((await call(env, B, 'get', {}, parseToken(plain))).plan.active, false);
  await call(env, A, 'spend', { usd: 0.5, bucket: 'plus', meta: { feature: 'chat', model: 'gpt-5', tin: 10, tout: 20 } });
  await new Promise((r) => setTimeout(r, 20));
  const [ai] = rows("kind = 'ai'");
  assert.deepEqual([ai.name, ai.model, ai.usd, ai.tin, ai.tout, ai.product], ['chat', 'gpt-5', 0.5, 10, 20, 'eden']);
  assert.match(ai.user, /^[0-9a-f]{16}$/);
  assert.notEqual(ai.user, A);
});

test('a browser’s error report is kept, from this site only', async () => {
  const post = (origin) => worker.fetch(new Request(`${ORIGIN}/api/stats/error`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'TypeError: x is undefined', page: '/edu' }) }), env, ctx);
  assert.equal((await post('https://evil.example')).status, 403);
  assert.equal((await post(ORIGIN)).status, 204);
  await settle();
  const [e] = rows("kind = 'client'");
  assert.deepEqual([e.name, e.detail, e.product], ['/edu', 'TypeError: x is undefined', 'edu']);
});

test('without the database nothing breaks', async () => {
  delete env.STATS;
  assert.equal((await get('/privacy')).status, 200);
  await settle();
});

test('owner dashboard /api/admin/keys manages API keys, spend limits, monthly failover policies, and CSV export', async () => {
  const owner = await browser(A, 'owner@example.com');
  const other = await browser(B, 'someone@example.com');
  const postKey = (body, cookie = `__Host-eden=${owner}`) =>
    worker.fetch(new Request(`${ORIGIN}/api/admin/keys`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), env, ctx);

  // Non-owners cannot access /api/admin/keys
  assert.equal((await get('/api/admin/keys')).status, 404);
  assert.equal((await get('/api/admin/keys', { cookie: `__Host-eden=${other}` })).status, 404);

  // Create a scoped key with daily and monthly spend limits
  const createdRes = await postKey({
    action: 'create',
    name: 'Production Mobile Gateway',
    daily_usd: 200,
    monthly_usd: 5000,
    rpm: 120,
    tag: 'tag: mobile-ios',
    ip_whitelist: ['198.51.100.0/24'],
    on_cap_breach: 'failover',
    models: ['claude-3-5-sonnet', 'gpt-4o'],
  });
  assert.equal(createdRes.status, 200);
  const created = await createdRes.json();
  assert.match(created.api_key, /^sk-eden-[A-Za-z0-9_-]{43}$/);
  assert.equal(created.client.name, 'Production Mobile Gateway');
  assert.equal(created.client.daily_usd, 200);
  assert.equal(created.client.monthly_usd, 5000);
  assert.equal(created.client.rpm, 120);
  assert.equal(created.client.tag, 'tag: mobile-ios');
  assert.deepEqual(created.client.models, ['claude-3-5-sonnet', 'gpt-4o']);

  // Pause (hold) and resume key
  const paused = await (await postKey({ action: 'pause', id: created.client.id })).json();
  assert.equal(paused.client.paused, true);
  const resumed = await (await postKey({ action: 'resume', id: created.client.id })).json();
  assert.equal(resumed.client.paused, false);

  // Rotate with 24h grace period
  const rotated = await (await postKey({ action: 'rotate', id: created.client.id, grace_period_ms: 86_400_000 })).json();
  assert.match(rotated.api_key, /^sk-eden-[A-Za-z0-9_-]{43}$/);
  assert.notEqual(rotated.api_key, created.api_key);
  assert.equal(rotated.grace_period_ms, 86_400_000);

  // Update monthly failover & alert policy
  const pol = await (await postKey({
    action: 'policy',
    policy: {
      daily_pool_cap_usd: 600,
      monthly_pool_cap_usd: 12000,
      slack_alerts_enabled: true,
      webhook_url: 'https://hooks.slack.com/services/T00/B00/X99',
      ttft_threshold_ms: 2200,
    },
  })).json();
  assert.equal(pol.policy.daily_pool_cap_usd, 600);
  assert.equal(pol.policy.monthly_pool_cap_usd, 12000);
  assert.equal(pol.policy.ttft_threshold_ms, 2200);

  // Read full dashboard state
  const dash = await (await get('/api/admin/keys', { cookie: `__Host-eden=${owner}` })).json();
  assert.equal(dash.totals.active_keys, 1);
  assert.ok(dash.audits.length >= 4);

  // CSV export
  const csvRes = await get('/api/admin/keys?format=csv', { cookie: `__Host-eden=${owner}` });
  assert.equal(csvRes.status, 200);
  const csvText = await csvRes.text();
  assert.match(csvText, /Production Mobile Gateway/);
  assert.match(csvText, /tag: mobile-ios/);
});
