// Plus on the web with Stripe (ROADMAP F15; eden/billing.js, accounts/stripe-plan.js): the
// Checkout Session's parameters, the refusals (Plus already, from either channel; acting for
// someone; a grant's device; a live key), the webhook's signature (real HMAC-SHA256, made here
// with node:crypto, apart from the Worker's WebCrypto), idempotency, each event moving the plan,
// and the plan combining with the App Store's. Stripe's REST API is a fake answering fetch.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { PLUS_PRODUCTS, parseToken } from '../src/accounts/util.js';
import { PAST_DUE_GRACE_MS, combinePlans } from '../src/accounts/stripe-plan.js';
import { billingConfig, billingProblem, plusOffer, stripeForm, verifyStripeSignature } from '../src/eden/billing.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const A = '11111111-1111-4111-8111-111111111111'; // the buyer
const B = '22222222-2222-4222-8222-222222222222'; // a delegate
const KEY = 'sk_test_51FakeKeyForTestsOnly';
const WHSEC = 'whsec_testSecretForTheWebhook123';
const PRICE = 'price_1PlusMonthlyTest';
const DAY = 86400_000;

let env;
let stripe; // the fake: { calls, sessions (by idempotency key), subs, n }
const ctx = { waitUntil: () => {} };
const realFetch = globalThis.fetch;

function fakeStripe(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init.method || 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  const form = init.body ? new URLSearchParams(init.body) : null;
  stripe.calls.push({ url: url.href, path: url.pathname, method, headers, form, body: init.body });
  if (headers.get('authorization') !== `Bearer ${env.STRIPE_SECRET_KEY}`) return Response.json({ error: { type: 'invalid_request_error' } }, { status: 401 });
  if (method === 'POST' && url.pathname === '/v1/checkout/sessions') {
    const key = headers.get('idempotency-key');
    if (key && stripe.sessions.has(key)) {
      // As Stripe: a reused key with other parameters is an idempotency_error, not a replay.
      if (stripe.bodies.get(key) !== init.body) return Response.json({ error: { type: 'idempotency_error', message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.' } }, { status: 400 });
      return Response.json(stripe.sessions.get(key));
    }
    const id = `cs_test_${++stripe.n}`;
    const session = { id, object: 'checkout.session', url: `${url.origin === 'https://api.stripe.com' ? 'https://checkout.stripe.com' : url.origin}/c/pay/${id}`, mode: form.get('mode') };
    stripe.sessions.set(key, session);
    stripe.bodies.set(key, init.body);
    return Response.json(session);
  }
  if (method === 'POST' && url.pathname === '/v1/billing_portal/sessions') return Response.json({ id: 'bps_1', url: `https://billing.stripe.com/p/session/test_${form.get('customer')}` });
  if (method === 'POST' && url.pathname === '/v1/refunds') {
    const key = headers.get('idempotency-key');
    if (!stripe.refunds.has(key)) stripe.refunds.set(key, { id: `re_${stripe.refunds.size + 1}`, payment_intent: form.get('payment_intent'), charge: form.get('charge') });
    return Response.json(stripe.refunds.get(key));
  }
  const sub = /^\/v1\/subscriptions\/(sub_\w+)$/.exec(url.pathname);
  if (sub && stripe.subs.has(sub[1])) {
    if (method === 'DELETE') stripe.subs.get(sub[1]).status = 'canceled';
    return Response.json(stripe.subs.get(sub[1]));
  }
  if (sub) return Response.json({ error: { type: 'invalid_request_error', code: 'resource_missing' } }, { status: 404 });
  throw new Error(`unexpected fetch ${method} ${url.href}`);
}

beforeEach(() => {
  forgetSessions();
  stripe = { calls: [], sessions: new Map(), bodies: new Map(), subs: new Map(), refunds: new Map(), n: 0 };
  globalThis.fetch = async (input, init) => fakeStripe(input, init);
  env = {
    TRIAL_BUDGET_USD: '1',
    PLUS_BUDGET_USD: '20',
    STRIPE_SECRET_KEY: KEY,
    STRIPE_WEBHOOK_SECRET: WHSEC,
    STRIPE_PRICE_PLUS: PRICE,
    LINK_RATE: rateLimiter(),
    API_RATE: rateLimiter(),
    EDEN_RATE: rateLimiter(),
    AUTH_RATE: rateLimiter(),
  };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.IDENTITIES = namespace(Identity, env);
  env.ASSETS = { fetch: async () => new Response('asset') };
});

after(() => {
  globalThis.fetch = realFetch;
});

/** A browser of an account (its session token), as the web sign-in makes one. */
const browser = async (account) => (await call(env, account, 'web-signin', { account_id: account, create: true, device: { name: 'Eden on the web: Safari on a Mac' } })).token;
const iphone = async (account) => (await call(env, account, 'signin', { account_id: account, device: { name: 'iPhone', kind: 'iphone' } })).token;

async function hit(p, { method = 'GET', body, session, acting, token, headers = {} } = {}) {
  const h = { 'user-agent': 'Mozilla/5.0 Safari/605', 'x-jarvis-chat': '1', ...headers };
  if (method !== 'GET' && !('origin' in headers)) h.origin = ORIGIN;
  if (h.origin === undefined) delete h.origin;
  const jar = [];
  if (session) jar.push(`__Host-eden=${session}`);
  if (acting) jar.push(`__Host-eden-as=${acting}`);
  if (jar.length) h.cookie = jar.join('; ');
  if (token) h.authorization = `Bearer ${token}`;
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  return worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
}

const post = (p, body, opts = {}) => hit(p, { method: 'POST', body, ...opts });
const planOf = async (session) => (await (await hit('/api/web/account', { session })).json()).plan;

// ── Stripe's side, faked ──

const nowS = () => Math.floor(Date.now() / 1000);
const sign = (raw, { secret = WHSEC, t = nowS() } = {}) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;

let eventN = 0;
const event = (type, object, { created = nowS() + eventN, livemode = false, id } = {}) => ({ id: id || `evt_test_${++eventN}`, object: 'event', api_version: '2025-09-30.clover', type, created, livemode, data: { object } });

/** A subscription as Stripe sends it; `items` keeps the period on its item (newer API versions). */
function subscription({ id = 'sub_test1', account = A, status = 'active', end = Date.now() + 30 * DAY, cancel = false, price = PRICE, customer = 'cus_test1', oldShape = false, source = null, invoice } = {}) {
  const item = { id: 'si_1', object: 'subscription_item', price: { id: price, object: 'price' }, quantity: 1, ...(oldShape ? {} : { current_period_end: Math.floor(end / 1000) }) };
  return {
    id, object: 'subscription', customer, status, cancel_at_period_end: cancel, cancel_at: null,
    metadata: account ? { account_id: account, ...(source ? { source } : {}) } : {}, items: { object: 'list', data: [item] },
    ...(invoice ? { latest_invoice: invoice } : {}),
    ...(oldShape ? { current_period_end: Math.floor(end / 1000) } : {}),
  };
}

async function webhook(evt, { header, raw = JSON.stringify(evt), ...signing } = {}) {
  return worker.fetch(new Request(`${ORIGIN}/api/stripe/webhook`, {
    method: 'POST',
    // Stripe's servers: no Origin, no cookie.
    headers: { 'content-type': 'application/json; charset=utf-8', 'user-agent': 'Stripe/1.0 (+https://stripe.com/docs/webhooks)', 'stripe-signature': header ?? sign(raw, signing) },
    body: raw,
  }), env, ctx);
}

/** Checkout finished at Stripe: the subscription exists there, then the signed event arrives. */
async function completeCheckout(account = A, sub = subscription({ account })) {
  stripe.subs.set(sub.id, sub);
  const session = { id: 'cs_test_done', object: 'checkout.session', mode: 'subscription', status: 'complete', payment_status: 'paid', client_reference_id: account, metadata: { account_id: account }, customer: sub.customer, subscription: sub.id };
  const response = await webhook(event('checkout.session.completed', session));
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

// ── configuration ──

test('billing stays off until the key, the webhook secret and the price are set; a live key needs STRIPE_LIVE = "1"', async () => {
  const off = { ...env, STRIPE_SECRET_KEY: '' };
  assert.deepEqual(billingConfig(off), { billing: false, billing_in_app: false, billing_off: 'no STRIPE_SECRET_KEY' });
  assert.deepEqual(billingConfig({}), { billing: false, billing_in_app: false }, 'nothing set up: no reason shown');
  assert.match(billingProblem({ ...env, STRIPE_SECRET_KEY: 'pk_test_51Publishable' }), /publishable/);
  assert.equal(billingProblem({ ...env, STRIPE_SECRET_KEY: ` ${env.STRIPE_SECRET_KEY}\n`, STRIPE_WEBHOOK_SECRET: `${env.STRIPE_WEBHOOK_SECRET}\n` }), null, 'pasted with spaces');
  assert.match(billingProblem({ ...env, STRIPE_WEBHOOK_SECRET: '' }), /WEBHOOK/);
  assert.match(billingProblem({ ...env, STRIPE_PRICE_PLUS: '' }), /PRICE/);
  assert.match(billingProblem({ ...env, STRIPE_SECRET_KEY: 'sk_live_51RealLookingKey' }), /live key/);
  assert.equal(billingProblem({ ...env, STRIPE_SECRET_KEY: 'sk_live_51RealLookingKey', STRIPE_LIVE: '1' }), null);
  assert.equal(billingProblem({ ...env, STRIPE_SECRET_KEY: 'rk_live_51RestrictedKey' }), 'a live key without STRIPE_LIVE = "1"');
  assert.deepEqual(billingConfig(env), { billing: true, billing_in_app: false });
  assert.deepEqual(billingConfig({ ...env, STRIPE_IN_EDEN_APP: '1' }), { billing: true, billing_in_app: true });
  // The fake Stripe of dev and tests: loopback only, test keys only.
  assert.equal(billingProblem({ ...env, STRIPE_API_BASE: 'http://127.0.0.1:8805' }), null);
  assert.match(billingProblem({ ...env, STRIPE_API_BASE: 'https://stripe.example.com' }), /loopback/);
  assert.match(billingProblem({ ...env, STRIPE_API_BASE: 'http://127.0.0.1:8805', STRIPE_SECRET_KEY: 'sk_live_51RealLookingKey', STRIPE_LIVE: '1' }), /loopback/);
  // What the page reads.
  const config = await (await hit('/api/web/config')).json();
  assert.equal(config.billing, true);
  const session = await browser(A);
  assert.deepEqual((await (await hit('/api/web/account', { session })).json()).plus, { web_purchase: true, how: 'stripe', price_usd: 10, yearly_usd: null, credit_packs: [], auto_topup: false });
  // Before today's price exists, the old one is sold (and shown) as before.
  env.STRIPE_PRICE_PLUS_LEGACY = PRICE;
  assert.equal((await (await hit('/api/web/account', { session })).json()).plus.price_usd, 20);
  delete env.STRIPE_PRICE_PLUS_LEGACY;
  env.STRIPE_SECRET_KEY = 'sk_live_51RealLookingKey';
  assert.equal((await (await hit('/api/web/config')).json()).billing, false);
  assert.deepEqual((await (await hit('/api/web/account', { session })).json()).plus, { web_purchase: false, how: 'ios' });
});

test('a live key is refused: no Checkout, nothing sent to Stripe; STRIPE_LIVE = "1" allows it', async () => {
  const session = await browser(A);
  env.STRIPE_SECRET_KEY = 'sk_live_51RealLookingKey';
  const refused = await post('/api/web/billing/checkout', {}, { session });
  assert.equal(refused.status, 503);
  assert.equal((await refused.json()).code, 'not_set_up');
  assert.equal(stripe.calls.length, 0);
  // A live event without STRIPE_LIVE is acknowledged and ignored.
  stripe.subs.set('sub_live', subscription({ id: 'sub_live' }));
  const ignored = await (await webhook(event('customer.subscription.created', subscription({ id: 'sub_live' }), { livemode: true }))).json();
  assert.equal(ignored.ignored, 'live');
  assert.equal((await planOf(session)).active, false);
  env.STRIPE_LIVE = '1';
  assert.equal((await post('/api/web/billing/checkout', {}, { session })).status, 200);
});

test('form encoding nests objects and arrays the way Stripe reads them', () => {
  assert.equal(stripeForm({ a: 'x y', line_items: [{ price: 'p', quantity: 1 }], meta: { k: 'v' }, skip: null }).toString(),
    'a=x+y&line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1&meta%5Bk%5D=v');
});

// ── checkout ──

test('Get Plus: a subscription Checkout Session for this account, form-encoded, with an Idempotency-Key; a second click gets the same one', async () => {
  const session = await browser(A);
  const response = await post('/api/web/billing/checkout', {}, { session });
  assert.equal(response.status, 200, await response.clone().text());
  const { url } = await response.json();
  assert.equal(url, 'https://checkout.stripe.com/c/pay/cs_test_1');
  const [made] = stripe.calls;
  assert.equal(made.url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(made.method, 'POST');
  assert.equal(made.headers.get('content-type'), 'application/x-www-form-urlencoded');
  assert.equal(made.headers.get('authorization'), `Bearer ${KEY}`);
  assert.match(made.headers.get('idempotency-key'), /^eden-checkout-[0-9a-f]{32}-price_\w+$/);
  const f = Object.fromEntries(made.form);
  assert.equal(f.mode, 'subscription');
  assert.equal(f['line_items[0][price]'], PRICE);
  assert.equal(f['line_items[0][quantity]'], '1');
  assert.equal(f.client_reference_id, A);
  assert.equal(f['metadata[account_id]'], A);
  assert.equal(f['subscription_data[metadata][account_id]'], A);
  assert.equal(f.success_url, `${ORIGIN}/api/web/billing/return?to=success`);
  assert.equal(f.cancel_url, `${ORIGIN}/api/web/billing/return?to=cancelled`);
  assert.ok(Number(f.expires_at) >= nowS() + 30 * 60, 'Stripe wants at least 30 minutes');
  assert.equal(f.customer, undefined, 'a first purchase: Stripe makes the customer');
  // Clicked again while it's open: the same key, so Stripe answers with the same session.
  const again = await (await post('/api/web/billing/checkout', {}, { session })).json();
  assert.equal(again.url, url);
  assert.equal(stripe.calls[1].headers.get('idempotency-key'), made.headers.get('idempotency-key'));
  assert.equal(stripe.calls[1].form.get('expires_at'), f.expires_at);
  // Signed out, from another site, a GET: refused before Stripe hears of it.
  assert.equal((await post('/api/web/billing/checkout', {})).status, 401);
  assert.equal((await post('/api/web/billing/checkout', {}, { session, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await hit('/api/web/billing/checkout', { session })).status, 404);
  assert.equal(stripe.calls.length, 2);
});

test('Get Plus is refused while the account has Plus from the App Store or from Stripe', async () => {
  const session = await browser(A);
  await call(env, A, 'notification', { transaction: { productId: PLUS_PRODUCTS[0], appAccountToken: A, transactionId: '1', originalTransactionId: '1', expiresDate: Date.now() + 10 * DAY, environment: 'Sandbox' } });
  let refused = await post('/api/web/billing/checkout', {}, { session });
  assert.equal(refused.status, 409);
  let body = await refused.json();
  assert.equal(body.code, 'already_plus');
  assert.match(body.error, /App Store/);
  assert.equal(stripe.calls.length, 0);
  // The App Store's ran out; then Stripe's makes it Plus, and a second subscription is refused.
  env.ACCOUNTS.objects.get(A).now = () => Date.now() + 11 * DAY;
  assert.equal((await post('/api/web/billing/checkout', {}, { session })).status, 200);
  await completeCheckout(A, subscription({ end: Date.now() + 41 * DAY }));
  refused = await post('/api/web/billing/checkout', {}, { session });
  assert.equal(refused.status, 409);
  body = await refused.json();
  assert.equal(body.code, 'already_plus');
  assert.match(body.error, /Manage billing/);
});

test('a delegate acting for someone can’t buy or manage billing, and a grant’s device is refused by the account', async () => {
  const owner = await browser(A);
  await iphone(A);
  const inv = await (await post('/api/web/deleg/invite', { name: 'Sam', from: 'Bilel', cap_usd: 1, features: ['chat'], days: 30 }, { session: owner })).json();
  const sam = await browser(B);
  assert.equal((await post('/api/web/deleg/accept', { code: inv.code }, { session: sam })).status, 200);
  const mine = await (await hit('/api/web/deleg', { session: sam })).json();
  const use = await post('/api/web/deleg/use', { id: mine.mine[0].id }, { session: sam });
  const acting = use.headers.getSetCookie().find((c) => c.startsWith('__Host-eden-as=')).split(';')[0].slice('__Host-eden-as='.length);
  for (const op of ['checkout', 'portal']) {
    const refused = await post(`/api/web/billing/${op}`, {}, { session: sam, acting });
    assert.equal(refused.status, 409, op);
    assert.equal((await refused.json()).code, 'acting');
  }
  // The grant's own token, straight at the owner's account: never.
  await assert.rejects(call(env, A, 'stripe-checkout', { origin: ORIGIN }, parseToken(acting)), (e) => e.status === 403);
  await assert.rejects(call(env, A, 'stripe-portal', {}, parseToken(acting)), (e) => e.status === 403);
  assert.equal(stripe.calls.length, 0);
  // Back on their own account, Sam may buy their own Plus.
  assert.equal((await post('/api/web/billing/checkout', {}, { session: sam })).status, 200);
  assert.equal(stripe.calls[0].form.get('client_reference_id'), B);
});

// ── the webhook's signature ──

test('webhook signatures: good, bad, an old timestamp, several v1 signatures, constant-time checked', async () => {
  const raw = JSON.stringify({ id: 'evt_1', type: 'ping', data: { object: {} } });
  const t = nowS();
  const good = createHmac('sha256', WHSEC).update(`${t}.${raw}`).digest('hex');
  const other = createHmac('sha256', 'whsec_rolledOldSecret00').update(`${t}.${raw}`).digest('hex');
  assert.equal(await verifyStripeSignature(raw, `t=${t},v1=${good}`, WHSEC), true);
  assert.equal(await verifyStripeSignature(raw, `t=${t},v1=${good.toUpperCase()},v0=abc`, WHSEC), true);
  assert.equal(await verifyStripeSignature(raw, `t=${t},v1=${other},v1=${good}`, WHSEC), true, 'one of several (a secret being rolled)');
  assert.equal(await verifyStripeSignature(raw, `t=${t},v1=${good},v1=${other}`, WHSEC), true);
  assert.equal(await verifyStripeSignature(raw, `t=${t},v1=${other}`, WHSEC), false, 'another secret');
  assert.equal(await verifyStripeSignature(`${raw} `, `t=${t},v1=${good}`, WHSEC), false, 'a changed body');
  assert.equal(await verifyStripeSignature(raw, `t=${t + 1},v1=${good}`, WHSEC), false, 'a changed timestamp');
  assert.equal(await verifyStripeSignature(raw, `v1=${good}`, WHSEC), false, 'no timestamp');
  assert.equal(await verifyStripeSignature(raw, `t=${t}`, WHSEC), false, 'no signature');
  assert.equal(await verifyStripeSignature(raw, `t=${t},v0=${good}`, WHSEC), false, 'v0 never counts');
  const old = t - 301;
  const oldSig = createHmac('sha256', WHSEC).update(`${old}.${raw}`).digest('hex');
  assert.equal(await verifyStripeSignature(raw, `t=${old},v1=${oldSig}`, WHSEC), false, 'older than 5 minutes');
  assert.equal(await verifyStripeSignature(raw, `t=${old},v1=${oldSig}`, WHSEC, { now: old + 299 }), true);
  // Through the Worker.
  const session = await browser(A);
  stripe.subs.set('sub_test1', subscription());
  const evt = event('customer.subscription.created', subscription());
  const body = JSON.stringify(evt);
  assert.equal((await webhook(evt, { header: '' })).status, 400);
  assert.equal((await webhook(evt, { secret: 'whsec_notTheRightOne000' })).status, 400);
  assert.equal((await webhook(evt, { t: nowS() - 600 })).status, 400);
  assert.equal((await webhook(evt, { raw: body.replace('"active"', '"trialing"'), header: sign(body) })).status, 400, 'tampered');
  assert.equal((await planOf(session)).active, false, 'nothing unsigned moved the plan');
  const t2 = nowS();
  const both = `t=${t2},v1=${createHmac('sha256', 'whsec_rolledOldSecret00').update(`${t2}.${body}`).digest('hex')},v1=${createHmac('sha256', WHSEC).update(`${t2}.${body}`).digest('hex')}`;
  assert.equal((await webhook(evt, { header: both })).status, 200);
  assert.equal((await planOf(session)).active, true);
  // Only the webhook lives under /api/stripe, and only as a POST.
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/api/stripe/webhook`), env, ctx)).status, 405);
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/api/stripe/checkout`, { method: 'POST', body: '{}' }), env, ctx)).status, 404);
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/api/stripe`, { method: 'POST', body: '{}' }), env, ctx)).status, 404);
});

// ── events moving the plan ──

test('each event moves the plan: checkout completed, updated, payment failed, past due (with grace), deleted', async () => {
  const session = await browser(A);
  assert.equal((await planOf(session)).name, 'free');
  // checkout.session.completed: the subscription is read from Stripe, the plan is Plus via Stripe.
  const first = await completeCheckout(A, subscription({ oldShape: true }));
  assert.equal(first.applied, true);
  assert.ok(stripe.calls.some((c) => c.method === 'GET' && c.path === '/v1/subscriptions/sub_test1'));
  let plan = await planOf(session);
  assert.equal(plan.name, 'plus');
  assert.equal(plan.source, 'stripe');
  assert.deepEqual(plan.manage, { app_store: null, stripe: 'portal' });
  assert.equal(plan.renews, true);
  assert.equal(plan.environment, 'Sandbox');
  assert.equal(plan.product_id, null);
  const account = await (await hit('/api/web/account', { session })).json();
  assert.equal(account.usage.budget_usd, 20, 'the included AI is the same $20 a month');
  // customer.subscription.updated: cancelled at the period's end, still Plus until then.
  const end = Date.now() + 30 * DAY;
  await webhook(event('customer.subscription.updated', subscription({ cancel: true, end })));
  plan = await planOf(session);
  assert.equal(plan.active, true);
  assert.equal(plan.renews, false);
  assert.equal(plan.expires, Math.floor(end / 1000) * 1000);
  // Resumed, then invoice.payment_failed: still Plus, with a warning.
  await webhook(event('customer.subscription.updated', subscription({ end })));
  const invoice = { id: 'in_1', object: 'invoice', customer: 'cus_test1', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_test1', metadata: { account_id: A } } } };
  assert.equal((await (await webhook(event('invoice.payment_failed', invoice))).json()).applied, true);
  plan = await planOf(session);
  assert.equal(plan.active, true);
  assert.equal(plan.payment_failed, true);
  // past_due: Plus for 3 more days while Stripe retries, then not.
  await webhook(event('customer.subscription.updated', subscription({ status: 'past_due', end })));
  plan = await planOf(session);
  assert.equal(plan.active, true);
  assert.equal(plan.payment_failed, true);
  env.ACCOUNTS.objects.get(A).now = () => Date.now() + PAST_DUE_GRACE_MS + 60_000;
  plan = await planOf(session);
  assert.equal(plan.active, false);
  assert.deepEqual(plan.manage, { app_store: null, stripe: 'portal' }, 'Manage billing still shows, to fix the card');
  env.ACCOUNTS.objects.get(A).now = () => Date.now();
  // Paid after all: active again, the warning gone.
  await webhook(event('customer.subscription.updated', subscription({ end })));
  plan = await planOf(session);
  assert.equal(plan.active, true);
  assert.equal(plan.payment_failed, undefined);
  // customer.subscription.deleted: Free.
  await webhook(event('customer.subscription.deleted', subscription({ status: 'canceled', end })));
  plan = await planOf(session);
  assert.equal(plan.name, 'free');
  assert.equal(plan.source, null);
  assert.equal((await (await hit('/api/web/account', { session })).json()).usage.budget_usd, 0);
  // A new Checkout now passes the same Stripe customer.
  await post('/api/web/billing/checkout', {}, { session });
  assert.equal(stripe.calls.at(-1).form.get('customer'), 'cus_test1');
});

test('customer.subscription.created alone makes it Plus; a period kept on the subscription (older API versions) reads too', async () => {
  const session = await browser(A);
  await webhook(event('customer.subscription.created', subscription({ oldShape: true, end: Date.now() + 5 * DAY })));
  const plan = await planOf(session);
  assert.equal(plan.source, 'stripe');
  assert.ok(Math.abs(plan.expires - (Date.now() + 5 * DAY)) < 2000);
});

test('API version 2025-03-31.basil (the webhook endpoint’s): the period on the items, the invoice’s subscription under parent', async () => {
  const session = await browser(A);
  const start = nowS();
  const end = start + 30 * 86400;
  // A basil subscription: no current_period_* on the subscription itself, only on each item.
  const basil = (extra = {}) => ({
    id: 'sub_1Basil', object: 'subscription', customer: 'cus_Basil', status: 'active', cancel_at_period_end: false, cancel_at: null, canceled_at: null,
    billing_cycle_anchor: start, collection_method: 'charge_automatically', livemode: false, metadata: { account_id: A },
    items: { object: 'list', has_more: false, data: [{ id: 'si_Basil', object: 'subscription_item', current_period_start: start, current_period_end: end, quantity: 1, price: { id: PRICE, object: 'price', recurring: { interval: 'month', interval_count: 1 }, unit_amount: 2000, currency: 'usd' } }] },
    ...extra,
  });
  assert.equal(basil().current_period_end, undefined);
  await completeCheckout(A, basil());
  let plan = await planOf(session);
  assert.equal(plan.source, 'stripe');
  assert.equal(plan.expires, end * 1000, 'read from the item');
  assert.equal(plan.renews, true);
  // "Cancel at end of billing period" in the Customer Portal.
  await webhook(event('customer.subscription.updated', basil({ cancel_at_period_end: true, canceled_at: start })));
  plan = await planOf(session);
  assert.equal(plan.active, true);
  assert.equal(plan.renews, false);
  assert.equal(plan.expires, end * 1000);
  // Some versions schedule it with cancel_at instead: it ends then, without renewing.
  await webhook(event('customer.subscription.updated', basil({ cancel_at: end - 86400 })));
  plan = await planOf(session);
  assert.equal(plan.renews, false);
  assert.equal(plan.expires, (end - 86400) * 1000);
  // Resumed; then a basil invoice: no top-level `subscription`, it's under parent.subscription_details.
  await webhook(event('customer.subscription.updated', basil()));
  const invoice = {
    id: 'in_Basil', object: 'invoice', customer: 'cus_Basil', status: 'open', attempt_count: 1, billing_reason: 'subscription_cycle',
    parent: { type: 'subscription_details', quote_details: null, subscription_details: { metadata: { account_id: A }, subscription: 'sub_1Basil' } },
    lines: { object: 'list', data: [{ id: 'il_1', parent: { type: 'subscription_item_details', subscription_item_details: { subscription: 'sub_1Basil', subscription_item: 'si_Basil' } } }] },
  };
  assert.equal((await (await webhook(event('invoice.payment_failed', invoice))).json()).applied, true);
  assert.equal((await planOf(session)).payment_failed, true);
  // Both places at once (an older version, or a mix): the later end counts.
  const both = basil({ current_period_end: end - 5 * 86400 });
  await webhook(event('customer.subscription.updated', both));
  assert.equal((await planOf(session)).expires, end * 1000);
});

test('events apply once, and a late older one never undoes a newer one', async () => {
  const session = await browser(A);
  const created = event('customer.subscription.created', subscription());
  assert.equal((await (await webhook(created)).json()).applied, true);
  const again = await (await webhook(created)).json();
  assert.equal(again.duplicate, true, 'Stripe sent it twice');
  // deleted arrives, then an "updated" from before it: still Free.
  const deleted = event('customer.subscription.deleted', subscription({ status: 'canceled' }), { created: nowS() + 100 });
  const stale = event('customer.subscription.updated', subscription(), { created: nowS() + 50 });
  await webhook(deleted);
  assert.equal((await (await webhook(stale)).json()).applied, false);
  assert.equal((await planOf(session)).active, false);
  // Even a newer event never brings a canceled subscription back.
  await webhook(event('customer.subscription.updated', subscription(), { created: nowS() + 200 }));
  assert.equal((await planOf(session)).active, false);
  // The record of what was seen is capped and ages out.
  const object = env.ACCOUNTS.objects.get(A);
  for (let i = 0; i < 120; i++) await call(env, A, 'stripe-event', { id: `evt_cap_${i}`, type: 'invoice.payment_failed', created: nowS(), invoice: { subscription: 'sub_x' } });
  const seen = await object.storage.get('stripe_seen');
  assert.equal(seen.length, 100);
  assert.equal(seen[0][0], 'evt_cap_20');
  object.now = () => Date.now() + 31 * DAY;
  assert.equal((await call(env, A, 'stripe-event', { id: 'evt_cap_119', type: 'invoice.payment_failed', created: nowS(), invoice: { subscription: 'sub_x' } })).duplicate, false, 'forgotten after 30 days');
});

test('an event for another product, another subscription’s late news, or an account that doesn’t exist is acknowledged and ignored', async () => {
  const session = await browser(A);
  const other = await (await webhook(event('customer.subscription.created', subscription({ id: 'sub_other', price: 'price_somethingElse' })))).json();
  assert.equal(other.applied, false);
  assert.equal((await planOf(session)).active, false);
  // No account named, or one that isn't there: 200 (Stripe needn't retry), and nothing stored for it.
  const ghost = '99999999-9999-4999-8999-999999999999';
  assert.equal((await (await webhook(event('customer.subscription.created', subscription({ account: null })))).json()).ignored, 'no_account');
  const none = await webhook(event('customer.subscription.created', subscription({ account: ghost })));
  assert.equal(none.status, 200);
  assert.equal((await none.json()).ignored, 'not_found');
  assert.equal(env.ACCOUNTS.objects.get(ghost).ctx.storage.map.size, 0);
  // A live subscription isn't replaced by an old one's late cancellation.
  await webhook(event('customer.subscription.created', subscription({ id: 'sub_new' })));
  await webhook(event('customer.subscription.deleted', subscription({ id: 'sub_old', status: 'canceled' })));
  assert.equal((await planOf(session)).active, true);
  // Stripe answering 500 while the subscription is read: Stripe is told to try again.
  const session2 = { id: 'cs_x', object: 'checkout.session', mode: 'subscription', client_reference_id: A, metadata: { account_id: A }, customer: 'cus_test1', subscription: 'sub_missing' };
  assert.equal((await webhook(event('checkout.session.completed', session2))).status, 502);
});

// ── the plan with the App Store's ──

test('the plan combines with the App Store’s: either gives Plus, the later end shows, both are reported', async () => {
  const session = await browser(A);
  const appleEnds = Date.now() + 10 * DAY;
  await call(env, A, 'notification', { transaction: { productId: PLUS_PRODUCTS[0], appAccountToken: A, transactionId: '7', originalTransactionId: '7', expiresDate: appleEnds, environment: 'Production' }, renewal: { originalTransactionId: '7', autoRenewStatus: 1 } });
  let plan = await planOf(session);
  assert.equal(plan.source, 'app_store');
  assert.equal(plan.product_id, PLUS_PRODUCTS[0]);
  assert.equal(plan.manage.app_store, 'https://apps.apple.com/account/subscriptions');
  assert.equal(plan.manage.stripe, null);
  // Stripe too (bought in a race on both): both, expiring at the later one.
  const stripeEnds = Date.now() + 30 * DAY;
  await webhook(event('customer.subscription.created', subscription({ end: stripeEnds })));
  plan = await planOf(session);
  assert.equal(plan.source, 'both');
  assert.equal(plan.active, true);
  assert.equal(plan.expires, Math.floor(stripeEnds / 1000) * 1000);
  assert.equal(plan.product_id, PLUS_PRODUCTS[0]);
  assert.deepEqual(plan.manage, { app_store: 'https://apps.apple.com/account/subscriptions', stripe: 'portal' });
  // Stripe's cancelled: the App Store's alone again, its own end.
  await webhook(event('customer.subscription.deleted', subscription({ status: 'canceled', end: stripeEnds })));
  plan = await planOf(session);
  assert.equal(plan.source, 'app_store');
  assert.equal(plan.expires, appleEnds);
  assert.equal(plan.renews, true);
  // The pure function, for the remaining cases.
  const now = Date.now();
  const store = { expires: now + 5 * DAY, product_id: PLUS_PRODUCTS[0], renews: true, environment: 'Production' };
  const web = { customer: 'cus_1', subscription: 'sub_1', status: 'active', period_end: now + 2 * DAY, renews: true, livemode: false };
  assert.equal(combinePlans(store, web, now).expires, store.expires, 'the App Store’s ends later');
  assert.equal(combinePlans(store, web, now).environment, 'Production');
  assert.equal(combinePlans({ ...store, revoked: true }, web, now).source, 'stripe');
  assert.equal(combinePlans({}, { ...web, status: 'incomplete' }, now).active, false);
  assert.equal(combinePlans({}, { ...web, renews: false, period_end: now - 1000 }, now).active, false, 'cancelled at the period’s end: ends on time');
  assert.equal(combinePlans({}, { ...web, period_end: now - 1000 }, now).active, true, 'a renewal’s webhook a little late');
  assert.equal(combinePlans({}, undefined, now).active, false);
  // The included AI runs on it like any Plus.
  assert.equal((await call(env, A, 'allow-ai', {}, parseToken(await iphone(A)))).ok, true);
});

// ── the portal, and deleting the account ──

test('Manage billing: a Customer Portal session for the account’s Stripe customer; none before a purchase', async () => {
  const session = await browser(A);
  const none = await post('/api/web/billing/portal', {}, { session });
  assert.equal(none.status, 404);
  assert.equal((await none.json()).code, 'no_billing');
  await completeCheckout();
  const response = await post('/api/web/billing/portal', {}, { session });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).url, 'https://billing.stripe.com/p/session/test_cus_test1');
  const made = stripe.calls.at(-1);
  assert.equal(made.path, '/v1/billing_portal/sessions');
  assert.equal(made.form.get('customer'), 'cus_test1');
  assert.equal(made.form.get('return_url'), `${ORIGIN}/api/web/billing/return?to=portal`);
});

test('back from Stripe (no Strict cookie on that navigation): a page of ours moves on to #account, to fixed places only', async () => {
  const back = async (q) => {
    const r = await worker.fetch(new Request(`${ORIGIN}/api/web/billing/return${q}`, { headers: { 'sec-fetch-site': 'cross-site' } }), env, ctx);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
    return /http-equiv="refresh" content="0; url=([^"]+)"/.exec(await r.text())[1];
  };
  assert.equal(await back('?to=success'), '/#account?billing=success');
  assert.equal(await back('?to=cancelled'), '/#account?billing=cancelled');
  assert.equal(await back('?to=portal'), '/#account');
  assert.equal(await back('?to=https://evil.example'), '/#account');
  assert.equal(await back('?to=constructor'), '/#account');
  assert.equal(await back(''), '/#account');
});

test('deleting the account cancels its Stripe subscription at once', async () => {
  const phone = await iphone(A);
  await completeCheckout();
  const response = await hit('/api/account', { method: 'DELETE', token: phone, headers: { origin: undefined } });
  assert.equal(response.status, 204);
  const cancel = stripe.calls.find((c) => c.method === 'DELETE');
  assert.equal(cancel.path, '/v1/subscriptions/sub_test1');
  assert.equal(cancel.headers.get('idempotency-key'), 'eden-cancel-sub_test1');
  assert.equal(stripe.subs.get('sub_test1').status, 'canceled');
  // Stripe's own news of it finds no account: acknowledged, nothing remade.
  assert.equal((await webhook(event('customer.subscription.deleted', stripe.subs.get('sub_test1')))).status, 200);
  assert.equal(env.ACCOUNTS.objects.get(A).ctx.storage.map.size, 0);
  // Stripe down when an account goes: the deletion still happens.
  const B2 = await iphone(B);
  await completeCheckout(B, subscription({ id: 'sub_b', account: B }));
  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.equal((await hit('/api/account', { method: 'DELETE', token: B2, headers: { origin: undefined } })).status, 204);
});

test('the fake Stripe of dev and tests is used only from STRIPE_API_BASE on loopback', async () => {
  env.STRIPE_API_BASE = 'http://127.0.0.1:8805';
  const session = await browser(A);
  const { url } = await (await post('/api/web/billing/checkout', {}, { session })).json();
  assert.equal(stripe.calls[0].url, 'http://127.0.0.1:8805/v1/checkout/sessions');
  assert.equal(url, 'http://127.0.0.1:8805/c/pay/cs_test_1');
  env.STRIPE_API_BASE = 'https://stripe.example.com';
  assert.equal((await post('/api/web/billing/checkout', {}, { session })).status, 503);
  assert.equal(stripe.calls.length, 1);
});

// ── the iPhone app's link-out to askeden.com's Checkout (STRIPE_US_LINKOUT, US storefront only) ──

const APP_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 EdenApp/1.4';
const appPost = (p, body, opts = {}) => post(p, body, { ...opts, headers: { 'user-agent': APP_UA, ...(opts.headers || {}) } });

test('link-out config: absent until STRIPE_US_LINKOUT = "1" with billing ready; then the US only, fixed in code', async () => {
  assert.equal('billing_link_out' in billingConfig(env), false);
  assert.equal('billing_link_out' in billingConfig({ ...env, STRIPE_US_LINKOUT: 'yes' }), false);
  assert.deepEqual(billingConfig({ ...env, STRIPE_US_LINKOUT: '1' }), { billing: true, billing_in_app: false, billing_link_out: ['USA'] });
  assert.equal('billing_link_out' in billingConfig({ ...env, STRIPE_US_LINKOUT: '1', STRIPE_SECRET_KEY: '' }), false, 'billing not ready: no link');
  assert.equal('billing_link_out' in billingConfig({ STRIPE_US_LINKOUT: '1' }), false);
  assert.equal((await (await hit('/api/web/config')).json()).billing_link_out, undefined);
  env.STRIPE_US_LINKOUT = '1';
  assert.deepEqual((await (await hit('/api/web/config')).json()).billing_link_out, ['USA']);
});

test('link-out Checkout: refused without the flag, outside the app or the US storefront; else app return addresses, ios_link metadata, its own keys', async () => {
  const session = await browser(A);
  const body = { plan: 'monthly', via: 'ios_link', storefront: 'USA' };
  const refused = async (b, opts) => {
    const r = await (opts && opts.web ? post : appPost)('/api/web/billing/checkout', b, { session });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, 'link_out_off');
  };
  await refused(body); // the flag off
  env.STRIPE_US_LINKOUT = '1';
  await refused(body, { web: true }); // not the app's user agent
  await refused({ ...body, storefront: 'FRA' });
  await refused({ ...body, storefront: 'usa' });
  await refused({ plan: 'monthly', via: 'ios_link' });
  assert.equal(stripe.calls.length, 0);
  // Good: the app's own return page, named as a link-out.
  const r = await appPost('/api/web/billing/checkout', body, { session });
  assert.equal(r.status, 200, await r.clone().text());
  assert.match((await r.json()).url, /^https:\/\/checkout\.stripe\.com\//);
  const f = Object.fromEntries(stripe.calls[0].form);
  assert.equal(f.success_url, `${ORIGIN}/api/web/billing/return?to=success&app=1`);
  assert.equal(f.cancel_url, `${ORIGIN}/api/web/billing/return?to=cancelled&app=1`);
  assert.equal(f.client_reference_id, A);
  assert.equal(f['metadata[account_id]'], A);
  assert.equal(f['metadata[source]'], 'ios_link');
  assert.equal(f['subscription_data[metadata][source]'], 'ios_link');
  assert.equal(f['subscription_data[metadata][account_id]'], A);
  assert.ok(!Number.isNaN(Date.parse(f['metadata[link_at]'])));
  const linkKey = stripe.calls[0].headers.get('idempotency-key');
  // A second tap on the same plan (back from Safari without paying): the same key and the same body, so
  // Stripe replays the session instead of refusing the key (the fake checks the body, as Stripe does).
  const again = await appPost('/api/web/billing/checkout', body, { session });
  assert.equal(again.status, 200, await again.clone().text());
  assert.equal(stripe.calls[1].headers.get('idempotency-key'), linkKey);
  assert.equal(stripe.calls[1].body, stripe.calls[0].body);
  stripe.calls.splice(1);
  // A web checkout for the same plan: another pending key, so neither session is replayed to the other.
  const web = await post('/api/web/billing/checkout', { plan: 'monthly' }, { session });
  assert.equal(web.status, 200);
  assert.notEqual(stripe.calls[1].headers.get('idempotency-key'), linkKey);
  assert.equal(stripe.calls[1].form.get('success_url'), `${ORIGIN}/api/web/billing/return?to=success`);
  assert.equal(stripe.calls[1].form.get('metadata[source]'), null);
  // Plus already (here from the App Store): 409 as on the web.
  await call(env, A, 'notification', { transaction: { productId: PLUS_PRODUCTS[0], appAccountToken: A, transactionId: '1', originalTransactionId: '1', expiresDate: Date.now() + 10 * DAY, environment: 'Sandbox' } });
  const plus = await appPost('/api/web/billing/checkout', body, { session });
  assert.equal(plus.status, 409);
  assert.equal((await plus.json()).code, 'already_plus');
});

test('link-out portal: the same checks, and a return address back into the app', async () => {
  const session = await browser(A);
  await completeCheckout();
  const body = { via: 'ios_link', storefront: 'USA' };
  const off = await appPost('/api/web/billing/portal', body, { session });
  assert.equal(off.status, 403);
  assert.equal((await off.json()).code, 'link_out_off');
  env.STRIPE_US_LINKOUT = '1';
  assert.equal((await appPost('/api/web/billing/portal', { ...body, storefront: 'FRA' }, { session })).status, 403);
  const r = await appPost('/api/web/billing/portal', body, { session });
  assert.equal(r.status, 200);
  assert.equal(stripe.calls.at(-1).form.get('return_url'), `${ORIGIN}/api/web/billing/return?to=portal&app=1`);
});

test('back from a link-out in Safari (app=1): no meta refresh, one button into the app, fixed places only', async () => {
  const back = async (q) => {
    const r = await worker.fetch(new Request(`${ORIGIN}/api/web/billing/return${q}`, { headers: { 'sec-fetch-site': 'cross-site' } }), env, ctx);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
    const html = await r.text();
    assert.doesNotMatch(html, /http-equiv="refresh"/);
    assert.match(html, /<h1>Back to Eden<\/h1>/);
    return { href: /<a class="button" href="([^"]+)">Back to Eden<\/a>/.exec(html)[1], html };
  };
  const ok = await back('?to=success&app=1');
  assert.equal(ok.href, 'askeden://plus?billing=success');
  assert.match(ok.html, /Payment done\. Plus switches on in Eden in a moment\./);
  assert.equal((await back('?to=cancelled&app=1')).href, 'askeden://plus?billing=cancelled');
  assert.match((await back('?to=cancelled&app=1')).html, /Nothing was charged/);
  assert.equal((await back('?to=portal&app=1')).href, 'askeden://plus?billing=portal');
  assert.equal((await back('?to=https://evil.example&app=1')).href, 'askeden://plus');
  assert.equal((await back('?to=constructor&app=1')).href, 'askeden://plus');
  assert.equal((await back('?app=1')).href, 'askeden://plus');
});

test('settleBoth: an iPhone link-out subscription beside App Store Plus is refunded once and cancelled; a web one is left alone', async () => {
  const session = await browser(A);
  await call(env, A, 'notification', { transaction: { productId: PLUS_PRODUCTS[0], appAccountToken: A, transactionId: '9', originalTransactionId: '9', expiresDate: Date.now() + 20 * DAY, environment: 'Sandbox' } });
  const invoice = { id: 'in_link1', object: 'invoice', amount_paid: 1000, payment_intent: 'pi_link1' };
  const sub = subscription({ id: 'sub_link1', source: 'ios_link', invoice });
  await completeCheckout(A, sub);
  const refunds = stripe.calls.filter((c) => c.path === '/v1/refunds');
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].form.get('payment_intent'), 'pi_link1');
  assert.equal(refunds[0].headers.get('idempotency-key'), 'eden-both-refund-sub_link1');
  const cancel = stripe.calls.filter((c) => c.method === 'DELETE');
  assert.equal(cancel.length, 1);
  assert.equal(cancel[0].path, '/v1/subscriptions/sub_link1');
  assert.equal(stripe.subs.get('sub_link1').status, 'canceled');
  assert.equal((await env.ACCOUNTS.objects.get(A).storage.get('stripe_plan')).via, 'ios_link', 'subscriptionFacts records via');
  // The same event again (Stripe retries), and customer.subscription.created too: no second refund.
  await webhook(event('customer.subscription.created', { ...sub, status: 'active' }));
  assert.equal(stripe.calls.filter((c) => c.path === '/v1/refunds').length, 1);
  assert.equal(stripe.refunds.size, 1);
  // Stripe's deleted: the App Store's alone.
  await webhook(event('customer.subscription.deleted', stripe.subs.get('sub_link1')));
  assert.equal((await planOf(session)).source, 'app_store');
  // A web subscription (not ios_link) beside the App Store's: untouched, "both" as before.
  const before = stripe.calls.length;
  await webhook(event('customer.subscription.created', subscription({ id: 'sub_web1', invoice: { id: 'in_w', amount_paid: 1000, payment_intent: 'pi_w' } })));
  assert.equal((await planOf(session)).source, 'both');
  assert.equal(stripe.calls.slice(before).filter((c) => c.path === '/v1/refunds' || c.method === 'DELETE').length, 0);
});

test('settleBoth: a link-out subscription with no App Store Plus is kept; a later App Store purchase settles it', async () => {
  const session = await browser(A);
  const sub = subscription({ id: 'sub_link2', source: 'ios_link', invoice: { id: 'in_link2', object: 'invoice', amount_paid: 1000, charge: 'ch_link2' } });
  await completeCheckout(A, sub);
  assert.equal((await planOf(session)).source, 'stripe');
  assert.equal(stripe.calls.filter((c) => c.path === '/v1/refunds' || c.method === 'DELETE').length, 0);
  // stripe-both directly (Worker-only): App Store Plus arrives, now it names the subscription.
  assert.deepEqual(await call(env, A, 'stripe-both', {}), { subscription: null });
  await call(env, A, 'notification', { transaction: { productId: PLUS_PRODUCTS[0], appAccountToken: A, transactionId: '11', originalTransactionId: '11', expiresDate: Date.now() + 20 * DAY, environment: 'Sandbox' } });
  assert.deepEqual(await call(env, A, 'stripe-both', {}), { subscription: 'sub_link2' });
  const { settleBoth } = await import('../src/eden/billing.js');
  assert.equal(await settleBoth(env, A), true);
  const refund = stripe.calls.find((c) => c.path === '/v1/refunds');
  assert.equal(refund.form.get('charge'), 'ch_link2');
  assert.equal(stripe.subs.get('sub_link2').status, 'canceled');
  // Called again: Stripe says it's cancelled already, nothing more.
  assert.equal(await settleBoth(env, A), false);
  assert.equal(stripe.calls.filter((c) => c.path === '/v1/refunds').length, 1);
});

// ── PLANS_V2: the six plans on Stripe (accounts/plans.js) ──

const TIER_ENV = {
  PLANS_V2: 'on',
  STRIPE_PRICE_PLUS2: 'price_plus2Monthly', STRIPE_PRICE_PLUS2_YEARLY: 'price_plus2Yearly',
  STRIPE_PRICE_PRO: 'price_proMonthly', STRIPE_PRICE_PRO_YEARLY: 'price_proYearly',
  STRIPE_PRICE_MAX: 'price_maxMonthly,price_maxOlder',
  STRIPE_PRICE_BLACK: 'price_blackMonthly', STRIPE_PRICE_BLACK_YEARLY: 'price_blackYearly',
};

test('plans: Checkout with a tier sells that plan’s price (monthly or yearly); no tier is today’s Plus exactly; a missing price or the flag off is 404', async () => {
  Object.assign(env, TIER_ENV);
  const session = await browser(A);
  const buy = async (body) => post('/api/web/billing/checkout', body, { session });
  const priceOf = (c) => c.form.get('line_items[0][price]');
  let r = await buy({ tier: 'pro' });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(priceOf(stripe.calls.at(-1)), 'price_proMonthly');
  assert.match(stripe.calls.at(-1).headers.get('idempotency-key'), /-price_proMonthly$/, 'the price is part of the key');
  r = await buy({ tier: 'pro', plan: 'yearly' });
  assert.equal(r.status, 200);
  assert.equal(priceOf(stripe.calls.at(-1)), 'price_proYearly');
  r = await buy({ tier: 'max' });
  assert.equal(priceOf(stripe.calls.at(-1)), 'price_maxMonthly', 'the first of the list is sold');
  r = await buy({ tier: 'black', plan: 'yearly' });
  assert.equal(priceOf(stripe.calls.at(-1)), 'price_blackYearly');
  r = await buy({ tier: 'plus2' });
  assert.equal(priceOf(stripe.calls.at(-1)), 'price_plus2Monthly', 'the new Plus');
  for (const body of [{}, { tier: 'plus' }]) {
    r = await buy(body);
    assert.equal(r.status, 200);
    assert.equal(priceOf(stripe.calls.at(-1)), 'price_plus2Monthly', 'no tier with PLANS_V2: the new Plus (today’s is closed to new subscribers)');
  }
  const n = stripe.calls.length;
  for (const body of [{ tier: 'max', plan: 'yearly' }, { tier: 'ultra' }, { tier: 'platinum' }, { tier: 'legacy' }, { tier: 'bogus' }, { tier: 7 }]) {
    r = await buy(body);
    assert.equal(r.status, 404, JSON.stringify(body));
    assert.equal((await r.json()).error, 'That plan isn’t on sale here.');
  }
  env.PLANS_V2 = 'off';
  assert.equal((await buy({ tier: 'pro' })).status, 404, 'flag off: no tier is sold');
  assert.equal(stripe.calls.length, n, 'Stripe never heard of the refused ones');
  assert.equal((await buy({})).status, 200, 'today’s Plus still is');
  assert.equal(priceOf(stripe.calls.at(-1)), PRICE, 'flag off: no tier is today’s Plus exactly');
  env.PLANS_V2 = 'on';
  const plus2 = env.STRIPE_PRICE_PLUS2;
  delete env.STRIPE_PRICE_PLUS2;
  const m = stripe.calls.length;
  assert.equal((await buy({})).status, 404, 'PLANS_V2 with no new-Plus price: today’s Plus isn’t sold either');
  assert.equal(plusOffer(env).web_purchase, false, 'and not offered');
  env.STRIPE_PRICE_PLUS2 = plus2;
  assert.deepEqual([plusOffer(env).web_purchase, plusOffer(env).price_usd, plusOffer(env).yearly_usd], [true, 10, 110], 'the offer is the new Plus’s prices');
  assert.equal(stripe.calls.length, m);
  env.STRIPE_PRICE_PLUS2 = plus2;
});

test('plans: link-out Checkout with a tier (US storefront in the app) sells it with ios_link metadata', async () => {
  Object.assign(env, TIER_ENV, { STRIPE_US_LINKOUT: '1' });
  const session = await browser(A);
  const r = await post('/api/web/billing/checkout', { tier: 'pro', via: 'ios_link', storefront: 'USA' }, { session, headers: { 'user-agent': 'Mozilla/5.0 EdenApp/1.2' } });
  assert.equal(r.status, 200, await r.clone().text());
  const f = Object.fromEntries(stripe.calls.at(-1).form);
  assert.equal(f['line_items[0][price]'], 'price_proMonthly');
  assert.equal(f['metadata[source]'], 'ios_link');
  assert.match(f.success_url, /app=1$/);
});

test('plans: the webhook takes a tier price as Plus and the account shows its tier; an unknown price isn’t taken', async () => {
  Object.assign(env, TIER_ENV);
  const session = await browser(A);
  await completeCheckout(A, subscription({ price: 'price_maxOlder' }));
  let plan = await planOf(session);
  assert.equal(plan.active, true);
  assert.equal(plan.name, 'plus', 'name stays plus for every paid tier');
  assert.deepEqual([plan.tier, plan.label], ['max', 'Max']);
  const usage = (await (await hit('/api/web/account', { session })).json()).usage;
  assert.equal(usage.plus_usd, 28, 'Max’s AI, from the workbook');
  assert.equal(usage.voice_daily, 50000);
  // the flag off: still honoured (the flag gates selling, not honouring)
  env.PLANS_V2 = 'off';
  plan = await planOf(session);
  assert.deepEqual([plan.active, plan.tier, plan.label], [true, 'max', 'Max']);
  const other = await browser(B);
  await completeCheckout(B, subscription({ id: 'sub_test2', account: B, customer: 'cus_test2', price: 'price_somethingElse' }));
  assert.equal((await planOf(other)).active, false, 'an unknown price is not Plus');
});

test('plans: Change plan opens the portal’s update-confirm flow for the target price; same plan 409; App Store 409; no Stripe 404; flag off 404', async () => {
  Object.assign(env, TIER_ENV);
  const session = await browser(A);
  const change = (body, s = session) => post('/api/web/billing/change', body, { session: s });
  let r = await change({ tier: 'pro' });
  assert.equal(r.status, 404);
  assert.equal((await r.json()).code, 'no_billing');
  await completeCheckout(A, subscription({ price: 'price_proMonthly' }));
  r = await change({ tier: 'pro' });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'same_plan');
  r = await change({ tier: 'black', plan: 'yearly' });
  assert.equal(r.status, 200, await r.clone().text());
  assert.match((await r.json()).url, /^https:\/\/billing\.stripe\.com\//);
  const f = Object.fromEntries(stripe.calls.at(-1).form);
  assert.equal(stripe.calls.at(-1).path, '/v1/billing_portal/sessions');
  assert.equal(f.customer, 'cus_test1');
  assert.equal(f['flow_data[type]'], 'subscription_update_confirm');
  assert.equal(f['flow_data[subscription_update_confirm][subscription]'], 'sub_test1');
  assert.equal(f['flow_data[subscription_update_confirm][items][0][id]'], 'si_1');
  assert.equal(f['flow_data[subscription_update_confirm][items][0][price]'], 'price_blackYearly');
  assert.equal(f['flow_data[after_completion][type]'], 'redirect');
  for (const body of [{ tier: 'ultra' }, { tier: 'max', plan: 'yearly' }, { tier: 'plus' }, {}]) assert.equal((await change(body)).status, 404, JSON.stringify(body));
  env.PLANS_V2 = 'off';
  assert.equal((await change({ tier: 'black' })).status, 404);
  env.PLANS_V2 = 'on';
  // an App Store plan changes in the App Store
  const other = await browser(B);
  await call(env, B, 'notification', { transaction: { productId: PLUS_PRODUCTS[0], appAccountToken: B, transactionId: '9', originalTransactionId: '9', expiresDate: Date.now() + 10 * DAY, environment: 'Production' } });
  r = await change({ tier: 'pro' }, other);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'app_store');
});

test('plans: config lists the plans only with PLANS_V2; web only where a monthly price is set; yearly only with its price; no key at all with the flags off', async () => {
  const off = billingConfig(env);
  for (const v of [undefined, 'off', 'yes']) assert.deepEqual(billingConfig({ ...env, PLANS_V2: v, ENTERPRISE_CONTACT: v }), off);
  assert.equal('plans' in off || 'rollover' in off || 'enterprise_contact' in off, false);
  Object.assign(env, TIER_ENV);
  const { plans } = billingConfig(env);
  assert.deepEqual(plans.map((p) => p.tier), ['plus2', 'pro', 'max', 'ultra', 'platinum', 'black']);
  const by = Object.fromEntries(plans.map((p) => [p.tier, p]));
  assert.deepEqual(plans.filter((p) => p.web).map((p) => p.tier), ['plus2', 'pro', 'max', 'black']);
  assert.deepEqual([by.pro.yearly_usd, by.max.yearly_usd, by.black.yearly_usd, by.plus2.yearly_usd], [220, null, 4400, 110]);
  assert.deepEqual([by.black.name, by.black.price_usd, by.black.ai_usd, by.black.answers, by.black.eves_strong, by.black.flash_day, by.black.flash_month, by.black.voice_day, by.black.browser_min], ['Eden Black', 400, 198, 5880, 395, 0, 0, 100000, 1200]);
  assert.ok(plans.every((p) => p.flash_day === 0 && p.flash_month === 0), 'no Flash answers promised until FLASH_FALLBACK (not built)');
  assert.deepEqual(by.ultra.app_products, { monthly: 'com.askeden.eden.ultra.monthly', yearly: 'com.askeden.eden.ultra.yearly' });
  assert.equal(by.ultra.bonus_max_pct, 0, 'no bonus advertised without the pool');
  const pooled = billingConfig({ ...env, ALLOWANCE_V2: 'on', BONUS_POOL: {}, PLAN_CAPS: '{"pro":{"ai_usd":11}}' });
  assert.deepEqual(pooled.plans.map((p) => p.bonus_max_pct), [0, 0, 0, 20, 20, 20]);
  assert.equal(pooled.plans[1].ai_usd, 11, 'the numbers come from PLAN_CAPS');
  assert.equal(pooled.rollover, true);
});
