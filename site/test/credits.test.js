// Pay-as-you-go credits (accounts/credits.js; eden/billing.js packs, webhook, auto top-up): the
// markup, FIFO by expiry, the allowance before the credits, a pack's webhook added once however
// often it comes, and the auto top-up (once per top-up, idempotency key, off after a 3-D Secure
// ask). Stripe is a fake answering fetch.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { parseToken } from '../src/accounts/util.js';
import { MARKUP, balanceOf, creditPrice, expiryOf, takeFIFO } from '../src/accounts/credits.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const A = '11111111-1111-4111-8111-111111111111';
const WHSEC = 'whsec_testSecretForTheWebhook123';
const PRICE = 'price_1PlusMonthlyTest';
const DAY = 86400_000;

let env;
let stripe;
const ctx = { waitUntil: () => {} };
const realFetch = globalThis.fetch;

function fakeStripe(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init.method || 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  const form = init.body ? new URLSearchParams(init.body) : null;
  stripe.calls.push({ path: url.pathname, method, headers, form });
  if (method === 'POST' && url.pathname === '/v1/checkout/sessions') {
    const id = `cs_test_${++stripe.n}`;
    return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}`, mode: form.get('mode') });
  }
  if (method === 'GET' && /^\/v1\/payment_intents\/pi_/.test(url.pathname)) return Response.json({ id: url.pathname.split('/').pop(), payment_method: 'pm_card_1' });
  if (method === 'GET' && /^\/v1\/customers\/cus_/.test(url.pathname)) return Response.json({ id: 'cus_1', invoice_settings: { default_payment_method: null } });
  if (method === 'POST' && url.pathname === '/v1/payment_intents') {
    const key = headers.get('idempotency-key');
    if (!stripe.intents.has(key)) stripe.intents.set(key, stripe.answer(form, ++stripe.n));
    const out = stripe.intents.get(key);
    return Response.json(out.body, { status: out.status });
  }
  throw new Error(`unexpected fetch ${method} ${url.href}`);
}

beforeEach(() => {
  forgetSessions();
  stripe = {
    calls: [], n: 0, intents: new Map(),
    answer: (form, n) => ({ status: 200, body: { id: `pi_auto_${n}`, status: 'succeeded', amount_received: Number(form.get('amount')) } }),
  };
  globalThis.fetch = async (input, init) => fakeStripe(input, init);
  env = {
    TRIAL_BUDGET_USD: '1',
    PLUS_BUDGET_USD: '6',
    STRIPE_SECRET_KEY: 'sk_test_51FakeKeyForTestsOnly',
    STRIPE_WEBHOOK_SECRET: WHSEC,
    STRIPE_PRICE_PLUS: PRICE,
    STRIPE_PRICE_CREDITS_5: 'price_credits5',
    STRIPE_PRICE_CREDITS_10: 'price_credits10',
    STRIPE_PRICE_CREDITS_25: 'price_credits25',
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

const browser = async () => (await call(env, A, 'web-signin', { account_id: A, create: true, device: { name: 'Eden on the web: Safari on a Mac' } })).token;
const post = (p, body, session) => worker.fetch(new Request(`${ORIGIN}${p}`, {
  method: 'POST',
  headers: { 'user-agent': 'Mozilla/5.0 Safari/605', 'x-jarvis-chat': '1', origin: ORIGIN, cookie: `__Host-eden=${session}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
}), env, ctx);
const accountOf = async (session) => (await worker.fetch(new Request(`${ORIGIN}/api/web/account`, { headers: { 'user-agent': 'Mozilla/5.0 Safari/605', 'x-jarvis-chat': '1', cookie: `__Host-eden=${session}` } }), env, ctx)).json();

let eventN = 0;
const nowS = () => Math.floor(Date.now() / 1000);
async function webhook(type, object, { id = `evt_c_${++eventN}` } = {}) {
  const raw = JSON.stringify({ id, object: 'event', type, created: nowS(), livemode: false, data: { object } });
  const t = nowS();
  const response = await worker.fetch(new Request(`${ORIGIN}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${createHmac('sha256', WHSEC).update(`${t}.${raw}`).digest('hex')}` },
    body: raw,
  }), env, ctx);
  assert.equal(response.status, 200);
  return response.json();
}
const packPaid = (pack, pi, extra = {}) => ({ id: `cs_${pi}`, object: 'checkout.session', mode: 'payment', payment_status: 'paid', client_reference_id: A, metadata: { account_id: A, kind: 'credits', pack: String(pack) }, customer: 'cus_1', payment_intent: pi, ...extra });

// ── the arithmetic ──

test('markup: provider cost × 1.40 on Free, × 1.25 with Plus', () => {
  assert.equal(MARKUP.free, 1.4);
  assert.equal(MARKUP.plus, 1.25);
  assert.equal(creditPrice(1, { active: false }), 1.4);
  assert.equal(creditPrice(1, { active: true }), 1.25);
  assert.equal(creditPrice(0.012345, { active: true }), 0.015431);
});

test('credits expire 12 months after purchase, and spending takes the soonest to expire first (FIFO)', () => {
  const t0 = Date.UTC(2026, 0, 31);
  assert.equal(expiryOf(t0), Date.UTC(2027, 0, 31));
  const lots = [
    { id: 'b', usd: 10, left: 10, at: t0 + 30 * DAY, expires: expiryOf(t0 + 30 * DAY) },
    { id: 'a', usd: 5, left: 5, at: t0, expires: expiryOf(t0) },
  ];
  const { lots: after1, taken } = takeFIFO(lots, 7, t0 + 40 * DAY);
  assert.equal(taken, 7);
  assert.deepEqual(after1.map((l) => [l.id, l.left]), [['b', 8], ['a', 0]], 'the older lot is used up first');
  assert.equal(balanceOf({ lots: after1 }, t0 + 40 * DAY), 8);
  // A year on, lot a has expired (empty anyway); b still counts until its own day.
  assert.equal(balanceOf({ lots }, expiryOf(t0) + 1), 10, 'an expired lot no longer counts');
  assert.equal(balanceOf({ lots }, expiryOf(t0 + 30 * DAY)), 0);
  // Never below zero: asking more than there is takes what's there.
  assert.equal(takeFIFO(lots, 100, t0).taken, 15);
  // An expired lot is never spent.
  assert.equal(takeFIFO(lots, 3, expiryOf(t0) + 1).lots.find((l) => l.id === 'a').left, 5);
});

// ── packs on the web, and the webhook ──

test('a pack: Checkout in payment mode with the pack named; its webhook adds it once, however often it comes', async () => {
  const session = await browser();
  const res = await post('/api/web/billing/credits', { pack: 10 }, session);
  assert.equal(res.status, 200, await res.clone().text());
  const made = stripe.calls.find((c) => c.path === '/v1/checkout/sessions');
  assert.equal(made.form.get('mode'), 'payment');
  assert.equal(made.form.get('line_items[0][price]'), 'price_credits10');
  assert.equal(made.form.get('metadata[kind]'), 'credits');
  assert.equal(made.form.get('metadata[pack]'), '10');
  assert.equal(made.form.get('payment_intent_data[setup_future_usage]'), 'off_session');
  assert.equal((await post('/api/web/billing/credits', { pack: 7 }, session)).status, 404, 'no such pack');
  delete env.STRIPE_PRICE_CREDITS_25;
  assert.equal((await post('/api/web/billing/credits', { pack: 25 }, session)).status, 404, 'a pack without its price isn’t sold');

  const evt = { id: 'evt_pack_1' };
  assert.equal((await webhook('checkout.session.completed', packPaid(10, 'pi_pack_1'), evt)).applied, true);
  assert.equal((await webhook('checkout.session.completed', packPaid(10, 'pi_pack_1'), evt)).duplicate, true, 'the same event');
  assert.equal((await webhook('checkout.session.completed', packPaid(10, 'pi_pack_1'))).applied, false, 'another event, the same purchase');
  assert.equal((await webhook('checkout.session.completed', packPaid(10, 'pi_unpaid', { payment_status: 'unpaid' }))).ignored, 'unpaid');
  assert.equal((await webhook('payment_intent.succeeded', { id: 'pi_pack_1', metadata: { kind: 'credits', account_id: A, pack: '10' }, amount_received: 1000 })).ignored, 'not_a_top_up');
  const credits = (await accountOf(session)).credits;
  assert.equal(credits.balance_usd, 10);
  assert.equal(credits.history.length, 1);
  assert.equal(credits.markup, 1.4);
  assert.equal(credits.auto_topup.card_on_file, true);
});

test('the allowance first, then the credits at the user’s price; a turn running past the allowance pays the rest from credits', async () => {
  const session = await browser();
  const t = parseToken(session);
  await webhook('checkout.session.completed', packPaid(5, 'pi_a'));
  let allow = await call(env, A, 'allow-ai', { eden: true }, t);
  assert.equal(allow.bucket, 'trial');
  assert.equal(allow.allowance_left, 1);
  assert.equal(allow.left, Math.round((1 + 5 / 1.4) * 1e6) / 1e6, 'the trial, then the credits in provider cost');
  // $0.90 of the $1 trial, then $0.30 more: $0.10 from the trial, $0.20 × 1.4 = $0.28 from credits.
  await call(env, A, 'spend', { usd: 0.9, bucket: 'trial' });
  assert.equal((await call(env, A, 'spend', { usd: 0.3, bucket: 'trial' })).charged_usd, 0.38);
  let view = await accountOf(session);
  assert.equal(view.usage.trial_left_usd, 0);
  assert.equal(view.credits.balance_usd, 4.72);
  allow = await call(env, A, 'allow-ai', { eden: true }, t);
  assert.equal(allow.bucket, 'credits');
  assert.equal(allow.markup, 1.4);
  assert.equal((await call(env, A, 'spend', { usd: 1, bucket: 'credits' })).charged_usd, 1.4);
  // With Plus the markup is 1.25, and the month's allowance comes before the credits again.
  const account = env.ACCOUNTS.objects.get(A);
  await account.storage.put('stripe_plan', { customer: 'cus_1', subscription: 'sub_1', status: 'active', price: PRICE, period_end: Date.now() + 30 * DAY, renews: true });
  allow = await call(env, A, 'allow-ai', { eden: true }, t);
  assert.equal(allow.bucket, 'plus');
  assert.equal(allow.budget, 6, 'today’s Plus: $6 a month');
  assert.equal((await call(env, A, 'spend', { usd: 6.5, bucket: 'plus' })).charged_usd, 6.625);
  view = await accountOf(session);
  assert.equal(view.usage.left_usd, 0);
  assert.equal(view.credits.balance_usd, Math.round((3.32 - 0.625) * 1e6) / 1e6);
  // The old $20 price is grandfathered: $20 a month.
  env.STRIPE_PRICE_PLUS_LEGACY = PRICE;
  assert.equal((await call(env, A, 'allow-ai', { eden: true }, t)).budget, 20);
  // Nothing left anywhere: refused.
  await account.storage.put('credits', { ...(await account.storage.get('credits')), lots: [] });
  await call(env, A, 'spend', { usd: 20, bucket: 'plus' });
  assert.equal((await call(env, A, 'allow-ai', { eden: true }, t)).ok, false);
});

// ── auto top-up ──

test('auto top-up: under $2 it charges the saved card $10 once (its idempotency key), and adds it once', async () => {
  const session = await browser();
  const t = parseToken(session);
  assert.equal((await post('/api/web/billing/autotopup', { enabled: true }, session)).status, 409, 'no card yet');
  await webhook('checkout.session.completed', packPaid(5, 'pi_first'));
  const on = await post('/api/web/billing/autotopup', { enabled: true }, session);
  assert.equal(on.status, 200);
  assert.equal((await on.json()).auto_topup.enabled, true);
  await call(env, A, 'spend', { usd: 1, bucket: 'trial' }); // the trial: no credits used
  assert.equal(stripe.calls.filter((c) => c.path === '/v1/payment_intents').length, 0);
  await call(env, A, 'spend', { usd: 2, bucket: 'credits' }); // $2.80 off $5: $2.20 left, above $2
  assert.equal(stripe.calls.filter((c) => c.path === '/v1/payment_intents').length, 0);
  await call(env, A, 'spend', { usd: 0.5, bucket: 'credits' }); // $1.50 left: top up
  const charges = stripe.calls.filter((c) => c.path === '/v1/payment_intents');
  assert.equal(charges.length, 1);
  assert.equal(charges[0].headers.get('idempotency-key'), `eden-topup-${A}-1`);
  assert.equal(charges[0].form.get('amount'), '1000');
  assert.equal(charges[0].form.get('off_session'), 'true');
  assert.equal(charges[0].form.get('payment_method'), 'pm_card_1');
  let view = await accountOf(session);
  assert.equal(view.credits.balance_usd, 11.5);
  assert.equal(view.credits.history[0].source, 'auto_topup');
  // Its webhook comes too: the same PaymentIntent, not added again.
  const pi = { id: 'pi_auto_1', amount_received: 1000, metadata: { kind: 'auto_topup', account_id: A, pack: '10', topup_key: `eden-topup-${A}-1` } };
  assert.equal((await webhook('payment_intent.succeeded', pi)).applied, false);
  view = await accountOf(session);
  assert.equal(view.credits.balance_usd, 11.5);
  // The next one has the next key.
  await call(env, A, 'spend', { usd: 7, bucket: 'credits' });
  assert.equal(stripe.calls.filter((c) => c.path === '/v1/payment_intents').at(-1).headers.get('idempotency-key'), `eden-topup-${A}-2`);
  assert.equal((await call(env, A, 'allow-ai', { eden: true }, t)).ok, true);
});

test('auto top-up: the bank asks for 3-D Secure → nothing added, auto top-up off, the person told; Stripe silent → the same key next time', async () => {
  const session = await browser();
  await webhook('checkout.session.completed', packPaid(5, 'pi_first'));
  await post('/api/web/billing/autotopup', { enabled: true }, session);
  // Stripe doesn't answer: nothing added, the top-up waits (tried again with the same key).
  let down = true;
  const realAnswer = stripe.answer;
  globalThis.fetch = async (input, init) => {
    if (down && new URL(input.url || input).pathname === '/v1/payment_intents') throw new TypeError('network');
    return fakeStripe(input, init);
  };
  await call(env, A, 'spend', { usd: 3, bucket: 'credits' });
  const account = env.ACCOUNTS.objects.get(A);
  const pending = (await account.storage.get('credit_auto')).pending;
  assert.equal(pending.key, `eden-topup-${A}-1`);
  await call(env, A, 'spend', { usd: 0.1, bucket: 'credits' });
  assert.equal((await account.storage.get('credit_auto')).pending.key, pending.key, 'not a second top-up while one is in flight');
  // An hour on, Stripe answers: it wants the person (authentication_required).
  down = false;
  stripe.answer = () => ({ status: 402, body: { error: { type: 'card_error', code: 'authentication_required', payment_intent: { id: 'pi_3ds', status: 'requires_payment_method' } } } });
  const realNow = account.now;
  account.now = () => Date.now() + 2 * 3600_000;
  await call(env, A, 'spend', { usd: 0.1, bucket: 'credits' });
  const tries = stripe.calls.filter((c) => c.path === '/v1/payment_intents');
  assert.equal(tries.at(-1).headers.get('idempotency-key'), `eden-topup-${A}-1`, 'the same top-up, the same key');
  const view = await accountOf(session);
  assert.equal(view.credits.auto_topup.enabled, false);
  assert.match(view.credits.auto_topup.last.why, /confirm/);
  assert.ok(view.credits.balance_usd < 1.5);
  // Off: no more charges.
  const n = tries.length;
  await call(env, A, 'spend', { usd: 0.1, bucket: 'credits' });
  assert.equal(stripe.calls.filter((c) => c.path === '/v1/payment_intents').length, n);
  // A failed auto top-up's webhook: also turns it off (already off), adds nothing.
  assert.equal((await webhook('payment_intent.payment_failed', { id: 'pi_x', metadata: { kind: 'auto_topup', account_id: A, pack: '10', topup_key: 'other' }, last_payment_error: { code: 'card_declined' } })).applied, true);
  stripe.answer = realAnswer;
  account.now = realNow;
});

test('a grant’s pool never spends the owner’s credits', async () => {
  await browser();
  await webhook('checkout.session.completed', packPaid(5, 'pi_g'));
  const account = env.ACCOUNTS.objects.get(A);
  const allow = await account.allowAi(null, { credits: false });
  assert.equal(allow.left, 1, 'the trial only');
  await call(env, A, 'spend', { usd: 2, bucket: 'trial|dlg:x|someone' }).catch(() => {});
  assert.equal(((await account.storage.get('credits')).lots[0]).left, 5);
});
