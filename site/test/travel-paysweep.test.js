// A travel payment stuck in the middle (travel/pay.js paySweep, alarm 'tpaysweep'): settled from what Stripe, the provider
// and the account's own booking records say, never booked a second time; and the owner's flags (the global index
// tpayflags:global, Mark resolved, the dashboard's switch). Stripe, Duffel and Distribusion are fakes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FLAGS, STUCK, flagOf, payFlagIndexOp, payRefund, payRefundRetry, payResolve, paySweep } from '../src/travel/pay.js';
import { adminTravelRefunds } from '../src/stats/admin.js';
import { queued } from '../src/accounts/schedule.js';
import { Storage } from './fakes.js';

const A = '11111111-1111-4111-8111-111111111111';
const NOW = 1_800_000_000_000;
const PAY = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const PAY2 = 'b1b2c3d4e5f6a1b2c3d4e5f6';

async function fakeAccount() {
  const storage = new Storage();
  await storage.put('account', { id: A });
  const pushes = [], flags = [];
  return {
    storage, pushes, flags, env: {}, clock: NOW, now() { return this.clock; },
    deps: {
      notify: async (_a, p) => { pushes.push(p); return 1; },
      index: async (op, body) => { flags.push({ op, ...body }); return {}; },
    },
  };
}
const rec = (patch) => ({ id: PAY, kind: 'flight', args: { check_id: 'chk1', passengers: [] }, title: 'Flight: TAP Air Portugal, 1 passenger', cents: 41250, fee: 0, currency: 'EUR', amount: 41250, session: 'cs_1', status: 'booking', intent: 'pi_1', created: NOW - 40 * 60_000, booking_at: NOW - 30 * 60_000, ...patch });

function fakeStripe({ pi = 'requires_capture', session = 'complete' } = {}) {
  const s = { calls: [], pi: { id: 'pi_1', status: pi, amount: 41250, currency: 'eur' }, session };
  s.fn = async (method, path, params, opts) => {
    s.calls.push({ method, path, params, opts });
    if (method === 'GET' && path.startsWith('/checkout/sessions/cs_1')) return { id: 'cs_1', status: s.session, payment_intent: s.pi };
    if (method === 'GET' && path === '/payment_intents/pi_1') return s.pi;
    if (method === 'POST' && path === '/payment_intents/pi_1/capture') { s.pi = { ...s.pi, status: 'succeeded' }; return s.pi; }
    if (method === 'POST' && path === '/payment_intents/pi_1/cancel') { s.pi = { ...s.pi, status: 'canceled' }; return s.pi; }
    if (method === 'GET' && path.startsWith('/refunds')) return { data: [] };
    if (method === 'POST' && path === '/refunds') return { id: 're_1' };
    throw new Error(`unexpected ${method} ${path}`);
  };
  return s;
}

function ops({ orders = {}, fail = false } = {}) {
  const calls = [];
  return {
    calls,
    flightOp: async (_a, op, body) => {
      calls.push({ op, body });
      if (fail) throw new Error('Duffel is down');
      if (op === 'flight-order') { const o = orders[body.order_id]; if (!o) throw new Error('no such order'); return { order_id: body.order_id, booking_reference: 'XK9Q2B', status: o }; }
      if (op === 'flight-book') return { order_id: 'ord_new', booking_reference: 'NEW123', status: 'confirmed' };
      throw new Error(`unexpected ${op}`);
    },
    tripOp: async (_a, op, body) => { calls.push({ op, body }); return { booking_id: 'bk_1' }; },
  };
}
const booked = (o) => o.calls.filter((c) => /book|flight-pay$/.test(c.op));
const sweep = (a, stripe, o) => paySweep(a, { ...a.deps, ...o, stripe: stripe.fn });

test('a flight whose order was made (ford: since the booking began, confirmed at Duffel): charged, finished, never booked again', async () => {
  const a = await fakeAccount();
  await a.storage.put(`tpay:${PAY}`, rec());
  await a.storage.put('ford:ord_old', { at: NOW - 3 * 86400_000 }); // an earlier booking of this account: not this one
  await a.storage.put('ford:ord_1', { at: NOW - 29 * 60_000 });
  const stripe = fakeStripe(), o = ops({ orders: { ord_1: 'confirmed', ord_old: 'confirmed' } });
  const out = await sweep(a, stripe, o);
  assert.deepEqual(out, [{ pay_id: PAY, action: 'finished', status: 'paid' }]);
  const r = await a.storage.get(`tpay:${PAY}`);
  assert.equal(r.status, 'paid');
  assert.equal(r.result.order_id, 'ord_1');
  assert.equal(r.args, null, 'the names go once the booking is settled');
  assert.equal(await a.storage.get('tpayby:ord_1'), PAY, 'a later cancellation finds the payment');
  assert.equal(stripe.calls.find((c) => c.path.endsWith('/capture')).opts.idempotency, `tpay-capture-${PAY}`, 'the same key as pay-complete: never captured twice');
  assert.equal(booked(o).length, 0, 'never booked a second time');
  assert.match(a.pushes[0].title, /confirmed/);
  assert.equal(a.pushes[0].data.kind, 'tpay');
  assert.equal((await queued(a)).length, 0, 'nothing left in the middle: the sweep stops');
});

test('no sign of the booking: the hold is released, the traveller told, the owner flagged; nothing booked', async () => {
  const a = await fakeAccount();
  await a.storage.put(`tpay:${PAY}`, rec());
  const stripe = fakeStripe(), o = ops();
  const [r] = await sweep(a, stripe, o);
  assert.equal(r.action, 'review');
  const saved = await a.storage.get(`tpay:${PAY}`);
  assert.equal(saved.status, 'failed');
  assert.match(saved.error, /Nothing was charged/);
  assert.ok(stripe.calls.some((c) => c.path === '/payment_intents/pi_1/cancel'));
  assert.ok(!stripe.calls.some((c) => c.path.endsWith('/capture')));
  assert.equal(booked(o).length, 0);
  assert.match(a.pushes[0].body, /hold on your card is released and nothing was charged/);
  const f = a.flags.at(-1);
  assert.equal(f.op, 'tpayflag-set');
  assert.equal(f.account, A);
  assert.equal(f.flag.why, 'stuck');
  assert.match(f.flag.text, /may exist at Duffel/);
  // swept again: it is the owner's now, left alone
  stripe.calls.length = 0;
  assert.deepEqual(await sweep(a, stripe, o), []);
  assert.equal(stripe.calls.length, 0);
});

test('a held flight being paid: Duffel says still on hold, so it wasn’t paid: released, no owner flag', async () => {
  const a = await fakeAccount();
  await a.storage.put(`tpay:${PAY}`, rec({ kind: 'flight_pay', args: { order_id: 'ord_h', amount: '412.50', currency: 'EUR' } }));
  await a.storage.put('ford:ord_h', { at: NOW - 86400_000 });
  const stripe = fakeStripe(), o = ops({ orders: { ord_h: 'on_hold' } });
  const [r] = await sweep(a, stripe, o);
  assert.deepEqual(r, { pay_id: PAY, action: 'released', status: 'failed' });
  assert.equal(a.flags.length, 0);
  assert.match(a.pushes[0].title, /didn’t go through/);
  assert.equal(booked(o).length, 0);
});

test('a held flight Duffel says is paid: the card is charged for it', async () => {
  const a = await fakeAccount();
  await a.storage.put(`tpay:${PAY}`, rec({ kind: 'flight_pay', args: { order_id: 'ord_h' } }));
  const stripe = fakeStripe(), o = ops({ orders: { ord_h: 'confirmed' } });
  const [r] = await sweep(a, stripe, o);
  assert.equal(r.action, 'finished');
  assert.equal(await a.storage.get('tpayby:ord_h'), PAY);
});

test('already captured (the restart came after the charge): marked paid; the number lost is the owner’s to find', async () => {
  const a = await fakeAccount();
  await a.storage.put(`tpay:${PAY}`, rec());
  const stripe = fakeStripe({ pi: 'succeeded' }), o = ops();
  const [r] = await sweep(a, stripe, o);
  assert.deepEqual(r, { pay_id: PAY, action: 'review', status: 'paid' });
  assert.equal((await a.storage.get(`tpay:${PAY}`)).status, 'paid');
  assert.ok(!stripe.calls.some((c) => c.method === 'POST'), 'nothing captured or released again');
  assert.equal(a.flags.at(-1).flag.why, 'stuck');
});

test('already released at Stripe: failed, the traveller told', async () => {
  const a = await fakeAccount();
  await a.storage.put(`tpay:${PAY}`, rec());
  const stripe = fakeStripe({ pi: 'canceled' });
  const [r] = await sweep(a, stripe, ops());
  assert.equal(r.status, 'failed');
  assert.equal(a.pushes.length, 1);
});

test('the provider can’t be asked: tried again on later sweeps, then released and flagged', async () => {
  const a = await fakeAccount();
  await a.storage.put(`tpay:${PAY}`, rec());
  await a.storage.put('ford:ord_1', { at: NOW - 29 * 60_000 });
  const stripe = fakeStripe(), o = ops({ fail: true });
  for (let i = 1; i < STUCK.tries; i++) {
    const [r] = await sweep(a, stripe, o);
    assert.equal(r.action, 'later');
    assert.equal((await queued(a))[0].kind, 'tpaysweep', 'still in the middle: swept again in 15 minutes');
  }
  const [r] = await sweep(a, stripe, o);
  assert.equal(r.action, 'review');
  assert.equal((await a.storage.get(`tpay:${PAY}`)).status, 'failed');
  assert.ok(stripe.calls.some((c) => c.path === '/payment_intents/pi_1/cancel'));
  assert.equal(booked(o).length, 0);
});

test('a hotel: the stay booked since (same hotel, same total) is found and charged for', async () => {
  const a = await fakeAccount();
  await a.storage.put(`tpay:${PAY}`, rec({ kind: 'stay', args: { quote_id: 'quo_1' } }));
  await a.storage.put('stq:quo_1', { total: '412.50', currency: 'EUR', accommodation: { id: 'acc_1' } });
  await a.storage.put('stbk:bok_other', { booking_id: 'bok_other', accommodation: { id: 'acc_2' }, total: '412.50', currency: 'EUR', created: NOW - 20 * 60_000 });
  await a.storage.put('stbk:bok_1', { booking_id: 'bok_1', reference: 'H1', accommodation: { id: 'acc_1' }, total: '412.50', currency: 'EUR', created: NOW - 25 * 60_000 });
  const stripe = fakeStripe(), o = ops();
  const [r] = await sweep(a, stripe, o);
  assert.equal(r.action, 'finished');
  assert.equal((await a.storage.get(`tpay:${PAY}`)).result.booking_id, 'bok_1');
  assert.equal(await a.storage.get('tpayby:bok_1'), PAY);
  assert.equal(booked(o).length, 0);
});

test('a train: the price check gone means Distribusion confirmed it: charged, the number flagged for the owner', async () => {
  const a = await fakeAccount();
  await a.storage.put(`tpay:${PAY}`, rec({ kind: 'rail', args: { offer_id: 'off_1' } }));
  const stripe = fakeStripe();
  const [r] = await sweep(a, stripe, ops());
  assert.deepEqual(r, { pay_id: PAY, action: 'review', status: 'paid' });
  assert.ok(stripe.calls.some((c) => c.path.endsWith('/capture')));
  // the check still there: no sign it was confirmed
  const b = await fakeAccount();
  await b.storage.put(`tpay:${PAY}`, rec({ kind: 'rail', args: { offer_id: 'off_1' } }));
  await b.storage.put('rlq:off_1', { at: NOW - 35 * 60_000 });
  const s2 = fakeStripe();
  await sweep(b, s2, ops());
  assert.equal((await b.storage.get(`tpay:${PAY}`)).status, 'failed');
});

test('pending: left alone while Stripe’s page can still be paid; after it, the usual completion (booked once)', async () => {
  const a = await fakeAccount();
  await a.storage.put(`tpay:${PAY}`, rec({ status: 'pending', intent: undefined, booking_at: undefined, created: NOW - 10 * 60_000 }));
  const stripe = fakeStripe(), o = ops();
  assert.deepEqual(await sweep(a, stripe, o), []);
  assert.equal(stripe.calls.length, 0);
  assert.equal((await queued(a))[0].at, NOW + 15 * 60_000);
  a.clock = NOW + 30 * 60_000;
  const [r] = await sweep(a, stripe, o);
  assert.deepEqual(r, { pay_id: PAY, action: 'completed', status: 'paid' });
  assert.equal(booked(o).length, 1, 'booked exactly once');
  assert.equal((await queued(a)).length, 0);
});

test('pending over an hour with the card held: released, never booked that late', async () => {
  const a = await fakeAccount();
  await a.storage.put(`tpay:${PAY}`, rec({ status: 'pending', intent: undefined, created: NOW - 2 * 3600_000 }));
  const stripe = fakeStripe(), o = ops();
  const [r] = await sweep(a, stripe, o);
  assert.deepEqual(r, { pay_id: PAY, action: 'released', status: 'failed' });
  assert.equal(booked(o).length, 0);
  // an expired checkout: failed quietly (nothing happened)
  const b = await fakeAccount();
  await b.storage.put(`tpay:${PAY}`, rec({ status: 'pending', intent: undefined, created: NOW - 2 * 3600_000 }));
  const s2 = fakeStripe({ session: 'expired' });
  s2.pi = null;
  const [r2] = await sweep(b, s2, ops());
  assert.equal(r2.action, 'expired');
  assert.equal(b.pushes.length, 0);
});

test('a payment being completed right now in this object is left to it', async () => {
  const a = await fakeAccount();
  await a.storage.put(`tpay:${PAY}`, rec());
  a.paying = new Set([PAY]);
  const stripe = fakeStripe();
  assert.deepEqual(await sweep(a, stripe, ops()), []);
  assert.equal(stripe.calls.length, 0);
  assert.equal((await queued(a)).length, 1);
});

/* ---------- the owner's flags ---------- */

test('refund flags go to the index when raised, with when; cleared once the retry refunds', async () => {
  const a = await fakeAccount();
  await a.storage.put(`tpay:${PAY}`, rec({ status: 'paid' }));
  await a.storage.put('tpayby:ord_1', PAY);
  const failing = async () => { throw new Error('card_declined'); };
  assert.match(await payRefund(a, 'ord_1', 20000, { ...a.deps, stripe: failing }), /didn’t go through/);
  assert.deepEqual(a.flags.at(-1).flag && { why: a.flags.at(-1).flag.why, cents: a.flags.at(-1).flag.cents, since: a.flags.at(-1).flag.since, booking: a.flags.at(-1).flag.booking }, { why: 'refund_failed', cents: 20000, since: NOW, booking: 'ord_1' });
  await payRefundRetry(a, { ...a.deps, stripe: fakeStripe().fn });
  assert.equal(a.flags.at(-1).op, 'tpayflag-clear');
  // another currency: flagged for a refund by hand
  const b = await fakeAccount();
  await b.storage.put(`tpay:${PAY2}`, rec({ id: PAY2, status: 'paid' }));
  await b.storage.put('tpayby:ord_2', PAY2);
  await payRefund(b, 'ord_2', 30000, { ...b.deps, currency: 'USD' });
  assert.equal(b.flags.at(-1).flag.why, 'refund_currency');
  assert.equal(b.flags.at(-1).flag.currency, 'USD');
});

test('the index: only in the object with no account; set, list (oldest first), clear', async () => {
  const person = await fakeAccount();
  await assert.rejects(payFlagIndexOp(person, 'tpayflag-list', {}), /Not found/);
  const idx = { storage: new Storage(), now: () => NOW };
  const flag = (why, since) => ({ why, text: 'x', cents: 100, currency: 'EUR', since, tries: 2, title: 'Flight', kind: 'flight', status: 'paid' });
  await payFlagIndexOp(idx, 'tpayflag-set', { account: A, pay_id: PAY, flag: flag('refund_failed', NOW - 10) });
  await payFlagIndexOp(idx, 'tpayflag-set', { account: A, pay_id: PAY2, flag: flag('stuck', NOW - 100) });
  await assert.rejects(payFlagIndexOp(idx, 'tpayflag-set', { account: A, pay_id: 'nope', flag: flag('stuck', 1) }), /pay_id/);
  await assert.rejects(payFlagIndexOp(idx, 'tpayflag-set', { account: A, pay_id: PAY, flag: flag('made_up', 1) }), /why/);
  const { flags } = await payFlagIndexOp(idx, 'tpayflag-list', {});
  assert.deepEqual(flags.map((f) => f.pay_id), [PAY2, PAY]);
  assert.equal(flags[1].tries, 2);
  await payFlagIndexOp(idx, 'tpayflag-clear', { account: A, pay_id: PAY });
  assert.equal((await payFlagIndexOp(idx, 'tpayflag-list', {})).flags.length, 1);
  assert.equal(FLAGS, 'tpayflags:global');
});

test('Mark resolved: kept in the payment’s history, cleared here and in the index; a stuck one isn’t swept again', async () => {
  const a = await fakeAccount();
  await a.storage.put(`tpay:${PAY}`, rec({ status: 'booking', sweep_review: { why: 'Stripe says the hold is processing', since: NOW } }));
  const out = await payResolve(a, { pay_id: PAY, by: 'owner (11111111)', note: 'captured by hand' }, a.deps);
  assert.deepEqual(out, { resolved: true, pay_id: PAY, why: 'stuck' });
  const r = await a.storage.get(`tpay:${PAY}`);
  assert.equal(flagOf(r), null);
  assert.equal(r.resolved[0].note, 'captured by hand');
  assert.equal(r.swept, true);
  assert.equal(a.flags.at(-1).op, 'tpayflag-clear');
  const stripe = fakeStripe();
  assert.deepEqual(await sweep(a, stripe, ops()), []);
  assert.equal(stripe.calls.length, 0);
  // nothing to resolve: still clears a stale index entry
  assert.equal((await payResolve(a, { pay_id: PAY }, a.deps)).resolved, false);
  await assert.rejects(payResolve({ storage: new Storage(), now: () => NOW }, { pay_id: PAY }), /Not found/);
});

test('the dashboard’s Travel refunds stay off with the dashboard (no ADMIN_EMAILS: not found)', async () => {
  for (const method of ['GET', 'POST']) {
    const res = await adminTravelRefunds(new Request('https://askeden.com/api/admin/travel-refunds', { method, ...(method === 'POST' ? { body: JSON.stringify({ account: A, pay_id: PAY }) } : {}) }), {});
    assert.equal(res.status, 404);
  }
});
