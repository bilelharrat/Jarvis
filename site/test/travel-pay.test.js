// Paying for a booking with the traveller's card (travel/pay.js): the card is only held at Stripe Checkout for the price
// Eden checked, the booking is made once Stripe says it is held, then the hold is captured; a booking that fails releases
// it. With payments on, the account refuses those bookings without a payment. Stripe and the booking ops are fakes.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { payOp, stripeAmount } from '../src/travel/pay.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';

const A = '11111111-1111-4111-8111-111111111111';
const WHSEC = 'whsec_testSecretForTheWebhook123';
const PAY_ENV = { TRAVEL_PAY: '1', STRIPE_SECRET_KEY: 'sk_test_51FakeKeyForTestsOnly', STRIPE_WEBHOOK_SECRET: WHSEC };

/** A stand-in account object: its storage, its clock, its env. */
function fakeAccount(env = PAY_ENV) {
  const store = new Map([['account', { id: A }]]);
  return {
    env, store, now: () => 1_800_000_000_000,
    storage: {
      get: async (k) => store.get(k),
      put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) store.set(a, b); else store.set(k, v); },
    },
  };
}

/** Stripe, faked: a Checkout session, its payment intent in `pi`, and the calls made. */
function fakeStripe({ pi = null, status = 'complete' } = {}) {
  const s = { calls: [], pi, status };
  s.fn = async (method, path, params, opts) => {
    s.calls.push({ method, path, params, opts });
    if (method === 'POST' && path === '/checkout/sessions') return { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' };
    if (method === 'GET' && path.startsWith('/checkout/sessions/cs_test_1')) return { id: 'cs_test_1', status: s.status, payment_intent: s.pi };
    if (method === 'POST' && /^\/payment_intents\/pi_1\/(capture|cancel)$/.test(path)) { s.pi = { ...s.pi, status: path.endsWith('capture') ? 'succeeded' : 'canceled' }; return s.pi; }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return s;
}

const CHECK = { check_id: 'abc123', airline: 'TAP Air Portugal', passengers: 2, total: 41250, currency: 'EUR' };
const PASSENGERS = [{ given_name: 'Ana', family_name: 'Silva' }, { given_name: 'Rui', family_name: 'Silva' }];
const bookingOps = ({ fail = false } = {}) => {
  const calls = [];
  return {
    calls,
    flightOp: async (_account, op, body) => {
      calls.push({ op, body });
      if (op === 'flight-review') return CHECK;
      if (op === 'flight-book') { if (fail) throw new Error('The airline refused the booking.'); return { order_id: 'ord_1', booking_reference: 'XK9Q2B', total_text: '€412.50' }; }
      throw new Error(`unexpected ${op}`);
    },
    tripOp: async (_account, op, body) => { calls.push({ op, body }); return { booking_id: 'bk_1', reference: 'H123' }; },
  };
};
const start = (account, stripe, ops, args = { check_id: 'abc123', amount: '1.00', currency: 'EUR', passengers: PASSENGERS }) =>
  payOp(account, 'trip-pay-start', { kind: 'flight', args, origin: 'https://askedentravel.com' }, { ...ops, stripe: stripe.fn });

test('pay-start: the card is only held, for the price Eden checked (not the page’s), with the fee on its own line', async () => {
  const account = fakeAccount({ ...PAY_ENV, TRAVEL_FEE_CENTS: '500' });
  const stripe = fakeStripe();
  const r = await start(account, stripe, bookingOps());
  assert.equal(r.required, true);
  assert.equal(r.url, 'https://checkout.stripe.com/c/pay/cs_test_1');
  assert.equal(r.total_text, '€417.50');
  const [{ params, opts }] = stripe.calls;
  assert.equal(params.mode, 'payment');
  assert.equal(params.payment_intent_data.capture_method, 'manual', 'a hold, never a charge before the booking');
  assert.equal(params.line_items[0].price_data.unit_amount, 41250, 'the checked price, not the page’s 1.00');
  assert.equal(params.line_items[0].price_data.currency, 'eur');
  assert.equal(params.line_items[1].price_data.unit_amount, 500);
  assert.equal(params.success_url, 'https://askedentravel.com/api/web/billing/return?to=trip');
  assert.deepEqual(params.metadata, { account_id: A, kind: 'travel', pay_id: r.pay_id, booking: 'flight' });
  assert.match(opts.idempotency, /^tpay-[0-9a-f]{24}$/);
  const rec = account.store.get(`tpay:${r.pay_id}`);
  assert.equal(rec.status, 'pending');
  assert.equal(rec.amount, 41750);
  assert.deepEqual(rec.args.passengers, PASSENGERS, 'the names wait here until the booking is made');
  assert.equal(account.store.get('tpay:last'), r.pay_id);
});

test('payments off: the page books as before, and Stripe is never asked', async () => {
  const stripe = fakeStripe();
  assert.deepEqual(await start(fakeAccount({}), stripe, bookingOps()), { required: false });
  assert.equal(stripe.calls.length, 0);
});

test('held: Eden books with the waiting details, then charges; the second word back finds it done', async () => {
  const account = fakeAccount();
  const stripe = fakeStripe();
  const ops = bookingOps();
  const { pay_id } = await start(account, stripe, ops);
  // still on Stripe's page: nothing happens
  assert.equal((await payOp(account, 'trip-pay-complete', { pay_id }, { ...ops, stripe: stripe.fn })).status, 'pending');
  assert.equal(ops.calls.filter((c) => c.op === 'flight-book').length, 0);
  stripe.pi = { id: 'pi_1', status: 'requires_capture', amount: 41250, currency: 'eur' };
  const done = await payOp(account, 'trip-pay-complete', { pay_id }, { ...ops, stripe: stripe.fn });
  assert.equal(done.status, 'paid');
  assert.equal(done.result.booking_reference, 'XK9Q2B');
  const booked = ops.calls.find((c) => c.op === 'flight-book');
  assert.equal(booked.body.confirm, true);
  assert.deepEqual(booked.body.passengers, PASSENGERS);
  assert.ok(stripe.calls.some((c) => c.path === '/payment_intents/pi_1/capture'));
  assert.equal(account.store.get(`tpay:${pay_id}`).args, null, 'the names go once booked');
  // the webhook arriving after the page: no second booking, no second charge
  const again = await payOp(account, 'pay-webhook', { pay_id, session: 'cs_test_1' }, { ...ops, stripe: stripe.fn });
  assert.equal(again.status, 'paid');
  assert.equal(ops.calls.filter((c) => c.op === 'flight-book').length, 1);
  assert.equal(stripe.calls.filter((c) => c.path.endsWith('/capture')).length, 1);
});

test('a booking that fails releases the hold: nothing is charged', async () => {
  const account = fakeAccount();
  const stripe = fakeStripe();
  const ops = bookingOps({ fail: true });
  const { pay_id } = await start(account, stripe, ops);
  stripe.pi = { id: 'pi_1', status: 'requires_capture', amount: 41250, currency: 'eur' };
  const r = await payOp(account, 'trip-pay-complete', { pay_id }, { ...ops, stripe: stripe.fn });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /refused the booking\. Nothing was charged\./);
  assert.ok(stripe.calls.some((c) => c.path === '/payment_intents/pi_1/cancel'));
  assert.ok(!stripe.calls.some((c) => c.path.endsWith('/capture')));
});

test('a hold for another amount is released and nothing is booked; an expired Checkout ends the payment', async () => {
  const account = fakeAccount();
  const stripe = fakeStripe();
  const ops = bookingOps();
  const { pay_id } = await start(account, stripe, ops);
  stripe.pi = { id: 'pi_1', status: 'requires_capture', amount: 100, currency: 'eur' };
  assert.equal((await payOp(account, 'trip-pay-complete', { pay_id }, { ...ops, stripe: stripe.fn })).status, 'failed');
  assert.equal(ops.calls.filter((c) => c.op === 'flight-book').length, 0);
  assert.ok(stripe.calls.some((c) => c.path === '/payment_intents/pi_1/cancel'));

  const later = fakeAccount();
  const s2 = fakeStripe({ status: 'expired' });
  const p2 = await start(later, s2, ops);
  const r2 = await payOp(later, 'trip-pay-complete', { pay_id: p2.pay_id }, { ...ops, stripe: s2.fn });
  assert.equal(r2.status, 'failed');
  assert.match(r2.error, /wasn’t finished in time/);
});

test('the webhook must name this payment’s own session; a hotel books through its own op', async () => {
  const account = fakeAccount();
  account.store.set('stq:q1', { total: '180.00', currency: 'EUR', accommodation: { name: 'Hotel Baixa' }, room: 'Double' });
  const stripe = fakeStripe();
  const ops = bookingOps();
  const r = await payOp(account, 'trip-pay-start', { kind: 'stay', args: { quote_id: 'q1', guests: [{ given_name: 'Ana', family_name: 'Silva' }] }, origin: 'https://askedentravel.com' }, { ...ops, stripe: stripe.fn });
  assert.equal(stripe.calls[0].params.line_items[0].price_data.unit_amount, 18000);
  assert.equal(stripe.calls[0].params.line_items[0].price_data.product_data.name, 'Hotel: Hotel Baixa, Double');
  await assert.rejects(payOp(account, 'pay-webhook', { pay_id: r.pay_id, session: 'cs_other' }, { ...ops, stripe: stripe.fn }), /not this payment’s/);
  stripe.pi = { id: 'pi_1', status: 'requires_capture', amount: 18000, currency: 'eur' };
  assert.equal((await payOp(account, 'pay-webhook', { pay_id: r.pay_id, session: 'cs_test_1' }, { ...ops, stripe: stripe.fn })).status, 'paid');
  assert.equal(ops.calls.find((c) => c.op === 'trip-stays-book').body.quote_id, 'q1');
  await assert.rejects(payOp(account, 'trip-pay-start', { kind: 'stay', args: { quote_id: 'gone' }, origin: 'https://askedentravel.com' }, { ...ops, stripe: stripe.fn }), /no recent price/);
});

test('Stripe’s units: hundredths for most currencies, whole yen, and three-decimal currencies refused', () => {
  assert.equal(stripeAmount(41250, 'EUR'), 41250);
  assert.equal(stripeAmount(1200000, 'JPY'), 12000);
  assert.throws(() => stripeAmount(1000, 'KWD'), /can't take payment in KWD/);
  assert.throws(() => stripeAmount(0, 'EUR'), /Nothing to pay/);
});

// ── through the Worker: the gate, and Stripe's signed event reaching the account ──

let env;
const realFetch = globalThis.fetch;
let stripeCalls;
beforeEach(() => {
  forgetSessions();
  stripeCalls = [];
  env = { ...PAY_ENV, EDEN_TRAVEL: '1', TRAVEL_PLUS: '0', TRIAL_BUDGET_USD: '1', LINK_RATE: rateLimiter(), API_RATE: rateLimiter(), EDEN_RATE: rateLimiter(), AUTH_RATE: rateLimiter() };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.IDENTITIES = namespace(Identity, env);
  env.ASSETS = { fetch: async () => new Response('asset') };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    stripeCalls.push(`${init.method || 'GET'} ${url.pathname}`);
    if (url.pathname === '/v1/checkout/sessions/cs_live_9') return Response.json({ id: 'cs_live_9', status: 'complete', payment_intent: { id: 'pi_1', status: 'requires_capture', amount: 18000, currency: 'eur' } });
    if (url.pathname === '/v1/payment_intents/pi_1/cancel') return Response.json({ id: 'pi_1', status: 'canceled' });
    throw new Error(`unexpected fetch ${url.href}`);
  };
});
after(() => { globalThis.fetch = realFetch; });

const post = (p, body, session) => worker.fetch(new Request(`https://askeden.com${p}`, { method: 'POST', headers: { origin: 'https://askeden.com', 'x-jarvis-chat': '1', 'content-type': 'application/json', cookie: `__Host-eden=${session}`, 'user-agent': 'Mozilla/5.0 Safari/605' }, body: JSON.stringify(body) }), env, { waitUntil: () => {} });

test('with payments on, a hotel isn’t booked without a payment; Stripe’s signed event starts the booking (here it fails, so the hold goes)', async () => {
  const session = (await call(env, A, 'web-signin', { account_id: A, create: true, device: { name: 'Eden on the web: Safari on a Mac' } })).token;
  const refused = await post('/api/chat/travel', { action: 'stays-book', args: { quote_id: 'q1', confirm: true } }, session);
  assert.equal(refused.status, 402);
  assert.equal((await refused.json()).code, 'pay_first');
  // a payment waiting for its hold, as pay-start leaves it (Duffel isn't set up here, so the booking itself fails)
  const object = env.ACCOUNTS.objects.get(A);
  await object.storage.put('tpay:0123456789abcdef01234567', { id: '0123456789abcdef01234567', kind: 'stay', args: { quote_id: 'q1', guests: [] }, title: 'Hotel', cents: 18000, fee: 0, currency: 'EUR', amount: 18000, session: 'cs_live_9', status: 'pending' });
  const evt = { id: 'evt_1', object: 'event', type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000), livemode: false, data: { object: { id: 'cs_live_9', object: 'checkout.session', mode: 'payment', payment_status: 'unpaid', client_reference_id: A, metadata: { account_id: A, kind: 'travel', pay_id: '0123456789abcdef01234567' } } } };
  const raw = JSON.stringify(evt);
  const t = Math.floor(Date.now() / 1000);
  const res = await worker.fetch(new Request('https://askeden.com/api/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${createHmac('sha256', WHSEC).update(`${t}.${raw}`).digest('hex')}` }, body: raw }), env, { waitUntil: () => {} });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(stripeCalls, ['GET /v1/checkout/sessions/cs_live_9', 'POST /v1/payment_intents/pi_1/cancel']);
  const rec = await object.storage.get('tpay:0123456789abcdef01234567');
  assert.equal(rec.status, 'failed');
  assert.match(rec.error, /Nothing was charged\./);
});
