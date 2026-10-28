// The Eden Price Promise (src/travel/promise.js): one view of every watch, the guided rebook (book the new rate first,
// cancel the old only after, never the other way), its failure paths, the savings ledger and the flight auto-watch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promiseAutoWatch, promiseDue, promiseOp, REBOOK } from '../src/travel/promise.js';
import { FPWATCH } from '../src/travel/fpwatch.js';

const T0 = Date.parse('2027-04-01T09:00:00Z');
const FREE = '2027-05-10T12:00:00Z';
const acc = { id: 'acc_1', name: 'Hotel do Chiado', lat: 38.71, lng: -9.14 };

function account(clock = { t: T0 }) {
  const m = new Map();
  const storage = {
    get: async (k) => m.get(k),
    put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) m.set(a, b); else m.set(k, v); },
    delete: async (k) => m.delete(k),
    list: async ({ prefix }) => new Map([...m].filter(([k]) => k.startsWith(prefix))),
  };
  m.set('trip:t1', { title: 'Lisbon', start: '2027-05-12', travelers: 2, days: [{ stops: [{ id: 's-h', kind: 'stay', nights: 2, place: { name: 'Hotel do Chiado' } }, { id: 's-f', kind: 'transport', place: { name: 'LHR → LIS' } }] }, { stops: [] }, { stops: [] }] });
  m.set('stbk:bok_old', { booking_id: 'bok_old', reference: 'OLD-1', trip: 't1', stop: 's-h', accommodation: acc, check_in: '2027-05-12', check_out: '2027-05-14', adults: 2, rooms: 1, room: 'Double', total: '400.00', currency: 'EUR', free_until: FREE, refunds: [],
    checked: { at: '2027-04-01T08:00:00.000Z', total: '360.00', currency: 'EUR' }, drop: { total: '360.00', by: '40.00', rate_id: 'rat_cheap', search_result_id: 'srr_1', checked_at: '2027-04-01T08:00:00.000Z' } });
  return { m, storage, env: {}, now: () => clock.t, clock };
}

/** The stays ops as ops.js would run them, recording the order they were called in. */
function fakeTrip(a, { quote = '360.00', freeUntil = FREE, book, cancel } = {}) {
  const calls = [];
  const tripOp = async (_a, op, b) => {
    calls.push(op);
    if (op === 'trip-stays-quote') return { quote_id: 'quo_2', total: quote, currency: 'EUR', room: 'Double', cancellation: { free_until: freeUntil, refunds: [] }, accommodation: acc };
    if (op === 'trip-stays-book') {
      assert.equal(b.confirm, true);
      if (book) return book(b);
      a.m.set('stbk:bok_new', { booking_id: 'bok_new', reference: 'NEW-2', trip: b.id, stop: b.stop, accommodation: acc, total: quote, currency: 'EUR', free_until: freeUntil });
      return { booking_id: 'bok_new', reference: 'NEW-2', status: 'confirmed', accommodation: acc };
    }
    if (op === 'trip-stays-cancel') {
      assert.equal(b.confirm, true);
      if (cancel) return cancel(b);
      a.m.delete(`stbk:${b.booking_id}`);
      return { booking_id: b.booking_id, status: 'cancelled' };
    }
    throw new Error(`unexpected ${op}`);
  };
  return { calls, tripOp };
}
const guest = { guests: [{ given_name: 'Ana', family_name: 'Silva' }], email: 'ana@example.com', phone_number: '+15555550100' };

function deps(t, extra = {}) {
  const flags = [], pushes = [], refunds = [];
  return {
    flags, pushes, refunds,
    d: { tripOp: t.tripOp, payOn: false, notify: async (_a, n) => { pushes.push(n); }, flag: async (_a, r, text) => { flags.push(text); }, payRefund: async (_a, id, c) => { refunds.push([id, c]); return 'Refunded to your card.'; }, ...extra },
  };
}
const press = (a, d, step, more = {}) => promiseOp(a, 'trip-promise-rebook', { booking_id: 'bok_old', step, confirm: true, ...more }, d);

test('rebook: check → book the new rate → only then cancel the old; the saving goes into the ledger once', async () => {
  const a = account();
  const t = fakeTrip(a);
  const { d, refunds, flags } = deps(t);
  await assert.rejects(press(a, d, 'cancel'), (e) => e.code === 'wrong_step', 'never cancel first');
  await assert.rejects(press(a, d, 'book', guest), (e) => e.code === 'wrong_step');
  await assert.rejects(promiseOp(a, 'trip-promise-rebook', { booking_id: 'bok_old', step: 'check' }, d), /confirm: true/);
  let r = (await press(a, d, 'check')).rebook;
  assert.equal(r.next, 'book');
  assert.equal(r.quote.total, '360.00');
  assert.deepEqual(r.saving, { amount: '40.00', currency: 'EUR' });
  await assert.rejects(press(a, d, 'cancel'), (e) => e.code === 'wrong_step', 'a press meant for book never cancels');
  r = (await press(a, d, 'book', guest)).rebook;
  assert.equal(r.next, 'cancel');
  assert.equal(r.new.booking_id, 'bok_new');
  assert.ok(a.m.get('stbk:bok_old'), 'the old booking is untouched after the new one is booked');
  await assert.rejects(press(a, d, 'book', guest), (e) => e.code === 'wrong_step', 'a second Book press books nothing');
  r = (await press(a, d, 'cancel')).rebook;
  assert.equal(r.state, 'done');
  assert.deepEqual(t.calls, ['trip-stays-quote', 'trip-stays-book', 'trip-stays-cancel']);
  assert.deepEqual(refunds, [['bok_old', 40000]], 'the old booking’s whole price back to the card inside the free window');
  assert.equal(flags.length, 0);
  const v = await promiseOp(a, 'trip-promise', {}, d);
  assert.deepEqual(v.saved.totals, [{ currency: 'EUR', amount: '40.00' }]);
  assert.equal(v.saved.entries[0].new.reference, 'NEW-2');
  await assert.rejects(press(a, d, 'cancel'), (e) => e.code === 'done');
  assert.equal((await promiseOp(a, 'trip-promise', {}, d)).saved.entries.length, 1);
});

test('book fails: nothing is cancelled, the rebook goes back to check', async () => {
  const a = account();
  const t = fakeTrip(a, { book: () => { throw new Error('The rate sold out.'); } });
  const { d } = deps(t);
  await press(a, d, 'check');
  const r = (await press(a, d, 'book', guest)).rebook;
  assert.equal(r.state, 'check');
  assert.match(r.error, /sold out.*as it was/);
  assert.deepEqual(t.calls, ['trip-stays-quote', 'trip-stays-book']);
  assert.ok(a.m.get('stbk:bok_old'));
});

test('book answered but not confirmed: the old booking is kept and the owner flagged', async () => {
  const a = account();
  const t = fakeTrip(a, { book: () => ({ booking_id: 'bok_new', status: 'pending' }) });
  const { d, flags } = deps(t);
  await press(a, d, 'check');
  const r = (await press(a, d, 'book', guest)).rebook;
  assert.equal(r.state, 'unconfirmed');
  assert.equal(flags.length, 1);
  await assert.rejects(press(a, d, 'cancel'), (e) => e.code === 'locked');
  assert.ok(!t.calls.includes('trip-stays-cancel'));
});

test('cancel fails: the person is told and the owner flagged once; pressing again later finishes it', async () => {
  const a = account();
  let fail = true;
  const t = fakeTrip(a, { cancel: (b) => { if (fail) throw new Error('Duffel is unavailable.'); a.m.delete(`stbk:${b.booking_id}`); return { status: 'cancelled' }; } });
  const { d, flags, pushes } = deps(t);
  await press(a, d, 'check');
  await press(a, d, 'book', guest);
  let r = (await press(a, d, 'cancel')).rebook;
  assert.equal(r.state, 'cancel_failed');
  assert.match(r.error, /both bookings/);
  assert.equal(r.owner_flagged, true);
  await press(a, d, 'cancel');
  assert.equal(flags.length, 1, 'flagged once, not on every retry');
  assert.equal(pushes.length, 1);
  fail = false;
  r = (await press(a, d, 'cancel')).rebook;
  assert.equal(r.state, 'done');
  assert.deepEqual((await promiseOp(a, 'trip-promise', {}, d)).saved.totals, [{ currency: 'EUR', amount: '40.00' }]);
});

test('the free window ends between book and cancel: Eden doesn’t cancel (it would cost), flags it', async () => {
  const a = account();
  const t = fakeTrip(a);
  const { d, flags } = deps(t);
  await press(a, d, 'check');
  await press(a, d, 'book', guest);
  a.clock.t = Date.parse(FREE) + 60_000;
  const r = (await press(a, d, 'cancel')).rebook;
  assert.equal(r.state, 'cancel_late');
  assert.ok(!t.calls.includes('trip-stays-cancel'));
  assert.equal(flags.length, 1);
  assert.equal((await promiseOp(a, 'trip-promise', {}, d)).saved.entries.length, 0, 'no saving: the rebook didn’t complete');
});

test('check refuses: the lower price gone, a non-refundable new rate, too little time left; a stale quote is checked again', async () => {
  let a = account();
  let { d } = deps(fakeTrip(a, { quote: '399.00' }));
  let r = (await press(a, d, 'check')).rebook;
  assert.equal(r.state, 'check');
  assert.match(r.error, /lower price has gone/);
  a = account();
  ({ d } = deps(fakeTrip(a, { freeUntil: null })));
  assert.match((await press(a, d, 'check')).rebook.error, /no longer cancels for free/);
  a = account({ t: Date.parse(FREE) - REBOOK.marginMs + 1000 });
  ({ d } = deps(fakeTrip(a)));
  await assert.rejects(press(a, d, 'check'), (e) => e.code === 'too_late');
  a = account();
  const t = fakeTrip(a);
  ({ d } = deps(t));
  await press(a, d, 'check');
  a.clock.t += REBOOK.quoteMs + 1000;
  r = (await press(a, d, 'book', guest)).rebook;
  assert.equal(r.state, 'check');
  assert.ok(!t.calls.includes('trip-stays-book'));
});

test('with payments on: book only starts the card hold; the payment’s outcome moves the rebook (paid → cancel, failed → check)', async () => {
  const a = account();
  const t = fakeTrip(a);
  const started = [];
  const { d } = deps(t, { payOn: true, payStart: async (acct, b) => { started.push(b); acct.m.set(`tpay:${'a'.repeat(24)}`, { status: 'pending' }); return { required: true, pay_id: 'a'.repeat(24), url: 'https://checkout.stripe.test/s1', total_text: '€360.00' }; } });
  await press(a, d, 'check');
  const out = await press(a, d, 'book', { ...guest, origin: 'https://askeden.com' });
  assert.equal(out.pay.url, 'https://checkout.stripe.test/s1');
  assert.equal(out.rebook.state, 'paying');
  assert.equal(started[0].kind, 'stay');
  assert.deepEqual({ ...started[0].args, guests: null }, { quote_id: 'quo_2', guests: null, email: 'ana@example.com', phone_number: '+15555550100', id: 't1', stop: 's-h' });
  assert.ok(!t.calls.includes('trip-stays-book'), 'never booked here while the card isn’t held');
  assert.equal((await press(a, d, 'book', guest)).pay.url, 'https://checkout.stripe.test/s1', 'a second press resumes the same payment');
  assert.equal(started.length, 1);
  await assert.rejects(press(a, d, 'cancel'), (e) => e.code === 'wrong_step', 'still paying: no cancel');
  // pay.js finished it (pay-complete booked the new rate with trip-stays-book)
  a.m.set('stbk:bok_new', { booking_id: 'bok_new', total: '360.00', currency: 'EUR', free_until: FREE });
  a.m.set(`tpay:${'a'.repeat(24)}`, { status: 'paid', result: { booking_id: 'bok_new', reference: 'NEW-2', status: 'confirmed' } });
  const s = await promiseOp(a, 'trip-promise-rebook-status', { booking_id: 'bok_old' }, d);
  assert.equal(s.rebook.next, 'cancel');
  assert.equal((await press(a, d, 'cancel')).rebook.state, 'done');

  const b = account();
  const { d: d2 } = deps(fakeTrip(b), { payOn: true, payStart: async () => ({ required: true, pay_id: 'b'.repeat(24), url: 'https://x' }) });
  await press(b, d2, 'check');
  await press(b, d2, 'book', guest);
  b.m.set(`tpay:${'b'.repeat(24)}`, { status: 'failed', error: 'The payment wasn’t finished in time. Nothing was charged or booked.' });
  const f = await promiseOp(b, 'trip-promise-rebook-status', { booking_id: 'bok_old' }, d2);
  assert.equal(f.rebook.state, 'check');
  assert.match(f.rebook.error, /Nothing was charged.*as it was/);
});

test('cancel needs the new booking in this account’s records', async () => {
  const a = account();
  const t = fakeTrip(a);
  const { d } = deps(t);
  await press(a, d, 'check');
  await press(a, d, 'book', guest);
  a.m.delete('stbk:bok_new');
  await assert.rejects(press(a, d, 'cancel'), (e) => e.code === 'no_new_booking');
  assert.ok(!t.calls.includes('trip-stays-cancel'));
});

test('promiseDue: a push the day before the deadline (once), then flagged once it passes uncancelled', async () => {
  const a = account();
  const { d, pushes, flags } = deps(fakeTrip(a));
  await press(a, d, 'check');
  await press(a, d, 'book', guest);
  a.clock.t = Date.parse(FREE) - 3600_000;
  await promiseDue(a, d);
  await promiseDue(a, d);
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].title, /cancel the old booking/);
  a.clock.t = Date.parse(FREE) + 1000;
  await promiseDue(a, d);
  assert.equal(a.m.get('tprb:bok_old').state, 'cancel_late');
  assert.equal(flags.length, 1);
});

test('the view: each hotel with what was paid, the lowest like-for-like with source and time, the deadline; each flight watch', async () => {
  const a = account();
  a.m.set('fpw:t1:s-f', { trip: 't1', stop: 's-f', route: { origin: 'LHR', destination: 'LIS', date: '2027-05-12', cabin: 'economy', adults: 2, max_stops: 1 }, base: { total: '180.00', currency: 'GBP', stops: 0, at: '2027-03-30T10:00:00.000Z', source: 'Duffel search' }, best: { total: '150.00', currency: 'GBP', stops: 0, at: '2027-04-01T06:00:00.000Z' }, drop: { total: '150.00', by: '30.00', pct: 16.7, checked_at: '2027-04-01T06:00:00.000Z' }, checked_at: T0 - 3600_000 });
  a.m.set('tpaw:t1:s-f', { how: 'auto', at: T0 });
  const v = await promiseOp(a, 'trip-promise', {}, {});
  assert.equal(v.promise.name, 'The Eden Price Promise');
  const h = v.hotels[0];
  assert.deepEqual([h.paid.total, h.lowest.total, h.lowest.source, h.lowest.at, h.deadline.at, h.watching, h.trip_title], ['400.00', '360.00', 'Duffel Stays', '2027-04-01T08:00:00.000Z', FREE, true, 'Lisbon']);
  assert.equal(h.cheaper.by, '40.00');
  const f = v.flights[0];
  assert.deepEqual([f.route, f.seen.total, f.lowest.total, f.lowest.source, f.auto], ['LHR → LIS', '180.00', '150.00', 'Duffel', true]);
  assert.deepEqual(v.saved.totals, []);
});

test('watch every flight I add: flights already there are left alone; new ones with airports are watched, within the cap', async () => {
  const a = account();
  const on = [];
  const fpwatchOp = async (acct, op, b) => { on.push(b.stop); acct.m.set(`fpw:${b.id}:${b.stop}`, {}); return {}; };
  await assert.rejects(promiseOp(a, 'trip-promise-settings', { watch_flights: 'yes' }), /true or false/);
  assert.equal((await promiseOp(a, 'trip-promise-settings', { watch_flights: true })).settings.watch_flights, true);
  assert.equal(a.m.get('tpaw:t1:s-f').how, 'existing');
  const trip = a.m.get('trip:t1');
  trip.days[1].stops.push({ id: 's-new', kind: 'transport', place: { name: 'LIS → OPO' } }, { id: 's-word', kind: 'transport', place: { name: 'Train to Porto' } }, { id: 's-bk', kind: 'transport', place: { name: 'OPO → LHR' }, booked: { ref: 'X' } });
  let r = await promiseAutoWatch(a, { trip: { id: 't1' } }, { fpwatchOp });
  assert.deepEqual(on, ['s-new']);
  assert.deepEqual(r.skipped, [{ stop: 's-word', why: 'no_airports' }]);
  r = await promiseAutoWatch(a, { trip: { id: 't1' } }, { fpwatchOp });
  assert.deepEqual(on, ['s-new'], 'tried once');
  // the cap: no Duffel search once fpwatch is full
  for (let i = 0; i < FPWATCH.max; i++) a.m.set(`fpw:other:${i}`, {});
  trip.days[2].stops.push({ id: 's-cap', kind: 'transport', place: { name: 'LHR → CDG' } });
  r = await promiseAutoWatch(a, { trip: { id: 't1' } }, { fpwatchOp });
  assert.deepEqual(r.skipped.find((x) => x.stop === 's-cap'), { stop: 's-cap', why: 'cap' });
  assert.ok(!on.includes('s-cap'));
  await promiseOp(a, 'trip-promise-settings', { watch_flights: false });
  for (let i = 0; i < FPWATCH.max; i++) a.m.delete(`fpw:other:${i}`);
  r = await promiseAutoWatch(a, { trip: { id: 't1' } }, { fpwatchOp });
  assert.deepEqual(r.watched, [], 'off: nothing is turned on');
});
