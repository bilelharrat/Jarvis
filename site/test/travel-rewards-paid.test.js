// Eden Rewards only for real money (security review H1, 2026-10-28): a booking earns once its card charge is captured
// with live keys (pay.js earnPaid), never a held flight or a test booking; a cancel or refund takes the points back
// (payRefund → clawBooking), even after they were spent; a trip counts only with a stop whose reference is a paid,
// uncancelled Eden booking, each booking for one trip. Stripe and the booking ops are fakes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { payOp, payRefund, liveMoney } from '../src/travel/pay.js';
import { REWARDS, clawBooking, earn, earnBooking, ledgerState, paidRefs, rewardsOp, settleTrips, tripTaken } from '../src/travel/rewards.js';

const A = '11111111-1111-4111-8111-111111111111';
const DAY = 86400_000;
const T0 = Date.parse('2026-12-10T12:00:00Z');
const LIVE = { TRAVEL_PAY: '1', STRIPE_SECRET_KEY: 'sk_live_51FakeKeyForTestsOnly', STRIPE_WEBHOOK_SECRET: 'whsec_x', DUFFEL_TOKEN: 'duffel_live_FakeTokenForTests', DUFFEL_LIVE: '1', DISTRIBUSION_ENV: 'production' };

function account(env = LIVE) {
  const m = new Map([['account', { id: A }]]);
  const storage = {
    get: async (k) => m.get(k),
    put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) m.set(a, structuredClone(b)); else m.set(k, structuredClone(v)); },
    delete: async (k) => { for (const x of [].concat(k)) m.delete(x); return true; },
    list: async ({ prefix }) => new Map([...m].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  const a = { m, storage, env, t: T0, now: () => a.t };
  return a;
}
function stripe() {
  const s = { calls: [], pi: { id: 'pi_1', status: 'requires_capture', amount: 41250, currency: 'eur' } };
  s.fn = async (method, path, params) => {
    s.calls.push({ method, path, params });
    if (path === '/checkout/sessions') return { id: 'cs_1', url: 'https://checkout.stripe.com/x' };
    if (path.startsWith('/checkout/sessions/cs_1')) return { id: 'cs_1', status: 'complete', payment_intent: s.pi };
    if (path === '/refunds') return { id: 're_1' };
    if (/\/payment_intents\/pi_1\/(capture|cancel)$/.test(path)) { s.pi = { ...s.pi, status: path.endsWith('capture') ? 'succeeded' : 'canceled' }; return s.pi; }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return s;
}
const ops = {
  flightOp: async (_a, op) => {
    if (op === 'flight-review') return { check_id: 'c1', airline: 'TAP', passengers: 1, total: 41250, currency: 'EUR' };
    if (op === 'flight-book') return { order_id: 'ord_1', booking_reference: 'XK9Q2B' };
    throw new Error(op);
  },
  tripOp: async () => ({ booking_id: 'bk_1', reference: 'H123' }),
};
async function payFlight(a) {
  const s = stripe();
  const { pay_id } = await payOp(a, 'trip-pay-start', { kind: 'flight', args: { check_id: 'c1', id: 'aaaaaaaaaaaaaaaa' }, origin: 'https://askedentravel.com' }, { ...ops, stripe: s.fn });
  const done = await payOp(a, 'trip-pay-complete', { pay_id }, { ...ops, stripe: s.fn });
  return { s, done };
}
const balance = async (a) => (await rewardsOp(a, 'trip-rewards', {})).balance;
const booked = (ref) => ({ id: 's-1', kind: 'flight', booked: { ref, via: 'person' } });
const trip = (start, stops, o = {}) => ({ title: 'Lisbon', start, created: Date.parse(start) - 30 * DAY, days: [{ stops }, { stops: [] }], ...o });

test('live money: Stripe live key and the provider live; test keys, Duffel test, rail demo and eSIMs earn nothing', () => {
  assert.equal(liveMoney(LIVE, 'flight'), true);
  assert.equal(liveMoney(LIVE, 'stay'), true);
  assert.equal(liveMoney(LIVE, 'rail'), true);
  assert.equal(liveMoney({ ...LIVE, STRIPE_SECRET_KEY: 'sk_test_x' }, 'flight'), false);
  assert.equal(liveMoney({ ...LIVE, DUFFEL_TOKEN: 'duffel_test_x' }, 'flight'), false);
  assert.equal(liveMoney({ ...LIVE, DUFFEL_LIVE: undefined }, 'stay'), false);
  assert.equal(liveMoney({ ...LIVE, DISTRIBUSION_ENV: 'demo' }, 'rail'), false);
  assert.equal(liveMoney(LIVE, 'esim'), false);
});

test('a paid flight earns once the card is captured, with its PNR kept for the trip; test mode earns nothing', async () => {
  const a = account();
  const { done } = await payFlight(a);
  assert.equal(done.status, 'paid');
  assert.equal(await balance(a), REWARDS.earn.booking.flight);
  const e = [...a.m].find(([k]) => k.startsWith('rwd:e:'))[1];
  assert.equal(e.ref, 'book:flight:ord_1');
  assert.deepEqual(e.meta.refs, ['ORD_1', 'XK9Q2B']);
  assert.equal(e.meta.trip, 'aaaaaaaaaaaaaaaa');
  const t = account({ ...LIVE, DUFFEL_TOKEN: 'duffel_test_FakeTokenForTests' });
  assert.equal((await payFlight(t)).done.status, 'paid');
  assert.equal(await balance(t), 0, 'a Duffel test booking is free, so it earns nothing');
});

test('cancelled or refunded: the points go back, once; spent already, the balance owes them', async () => {
  const a = account();
  const { s } = await payFlight(a);
  assert.equal(await balance(a), 100);
  await payRefund(a, 'ord_1', 0, { stripe: s.fn }); // cancelled without a refund still takes the points back
  assert.equal(await balance(a), 0);
  await payRefund(a, 'ord_1', 0, { stripe: s.fn });
  await clawBooking(a, 'ord_1');
  assert.equal(await balance(a), 0, 'never twice');
  // spent before the cancel: a debt the next points pay off
  const b = account();
  await earnBooking(b, 'stay', 'bk_9');
  await earn(b, 'share', 'share:x', 3000);
  const r = await rewardsOp(b, 'trip-rewards-redeem', { item: 'plus_month', confirm: true });
  assert.equal(r.balance, 100);
  await earnBooking(b, 'flight', 'ord_2');
  b.t += 1000;
  await clawBooking(b, 'ord_2');
  await clawBooking(b, 'bk_9');
  assert.equal(await balance(b), 0);
  // the redemption had taken bk_9's lot: its clawback is owed
  const c = account();
  await earnBooking(c, 'flight', 'ord_3');
  await earn(c, 'share', 'share:y', 2900);
  await rewardsOp(c, 'trip-rewards-redeem', { item: 'plus_month', confirm: true });
  await clawBooking(c, 'ord_3');
  assert.equal(await balance(c), -100);
  await rewardsOp(c, 'trip-rewards-redeem', { item: 'plus_month', confirm: true }).then(() => assert.fail('redeemed in debt'), (e) => assert.equal(e.code, 'not_enough'));
});

test('ledgerState: a clawback takes from its own lot first', () => {
  const at = T0;
  const entries = [
    { n: 1, kind: 'earn', reason: 'share', amount: 50, at, expires: at + 1e12, ref: 'share:a' },
    { n: 2, kind: 'earn', reason: 'booking', amount: 100, at, expires: at + 1e12, ref: 'book:flight:o' },
    { n: 3, kind: 'clawback', reason: 'booking', amount: -100, at, ref: 'claw:flight:o', meta: { earned: 'book:flight:o' } },
  ];
  const s = ledgerState(entries, at);
  assert.equal(s.balance, 50);
  assert.deepEqual(s.lots.map((l) => l.left), [50, 0]);
});

test('trips: only with a stop booked under a paid, uncancelled Eden booking; one booking, one trip', async () => {
  assert.equal(REWARDS.tripEvidence, 'paid', 'forwarded and imported emails are no proof');
  const a = account();
  await earnBooking(a, 'flight', 'ord_1', { refs: ['XK9Q2B'] });
  a.m.set('trip:aaaaaaaaaaaaaaaa', trip('2026-12-01', [booked('xk9q2b')])); // the PNR, as the person typed it
  a.m.set('trip:bbbbbbbbbbbbbbbb', trip('2026-12-01', [booked('XK9Q2B')])); // the same booking again
  a.m.set('trip:cccccccccccccccc', trip('2026-12-01', [{ id: 's-2', kind: 'stay', booked: { ref: 'FAKE1', via: 'forward' } }])); // a forwarded "confirmation"
  a.m.set('trip:dddddddddddddddd', trip('2026-12-01', [{ id: 's-3', kind: 'stay', booked: { ref: 'ANY', via: 'api' } }])); // the page naming via 'api'
  const added = await settleTrips(a);
  assert.equal(added.length, 1);
  assert.equal(added[0].meta.evidence, 'XK9Q2B');
  assert.equal((await settleTrips(a)).length, 0);
  // a cancelled booking proves nothing
  const b = account();
  await earnBooking(b, 'stay', 'bk_1', { refs: ['H123'] });
  await clawBooking(b, 'bk_1');
  b.m.set('trip:aaaaaaaaaaaaaaaa', trip('2026-12-01', [booked('H123')]));
  assert.equal((await settleTrips(b)).length, 0);
  assert.equal(paidRefs([]).size, 0);
  assert.equal(tripTaken(trip('2026-12-01', [booked('H123')]), T0), null, 'no paid set: nothing counts');
});
