// Hotels in Eden Travel and the price watch (src/travel/stayops.js), with a fake stays service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { priceDrops, refundNow, stayOp, stayWatchDue } from '../src/travel/stayops.js';

function account(now) {
  const m = new Map();
  const storage = {
    get: async (k) => m.get(k),
    put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) m.set(a, b); else m.set(k, v); },
    delete: async (k) => m.delete(k),
    list: async ({ prefix }) => new Map([...m].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
  };
  m.set('trip:t1', { title: 'Lisbon', start: '2027-05-12', travelers: 2, days: [{ stops: [{ id: 's-h', kind: 'stay', nights: 2, at: '15:00', place: { name: 'Hotel do Chiado', lat: 38.71, lng: -9.14 } }] }, { stops: [] }, { stops: [] }] });
  return { m, storage, env: {}, now: () => now.t };
}
const acc = { id: 'acc_1', name: 'Hotel do Chiado', lat: 38.71, lng: -9.14 };
function fakeStays(price) {
  const seen = [];
  return {
    seen,
    search: async (a) => { seen.push(['search', a]); return { results: [{ search_result_id: 'srr_1', accommodation: acc, cheapest: { total: price.now, currency: 'EUR' } }] }; },
    rates: async () => ({ accommodation: acc, rooms: [
      { name: 'Double', rates: [{ rate_id: 'rat_1', total: price.room || '400.00', currency: 'EUR', cancellation: { free_until: '2027-05-10T12:00:00Z', refunds: [] } },
        { rate_id: 'rat_nr', total: '300.00', currency: 'EUR', cancellation: { free_until: null, refunds: [] } }] }, // non-refundable: never compared
      { name: 'Single', rates: [{ rate_id: 'rat_s', total: '250.00', currency: 'EUR', cancellation: { free_until: '2027-05-10T12:00:00Z', refunds: [] } }] }] }), // another room: not like for like
    quote: async () => ({ quote_id: 'quo_1', total: '400.00', currency: 'EUR', accommodation: acc }),
    book: async (a) => { assert.equal(a.confirm, true); return { booking_id: 'bok_1', reference: 'HDC-77', status: 'confirmed', check_in: '2027-05-12', check_out: '2027-05-14', accommodation: acc }; },
    cancel: async () => ({ booking_id: 'bok_1', status: 'cancelled' }),
  };
}

test('a stay stop: search near it for its own dates, rate → quote (with its cancellation) → book marks the stop booked', async () => {
  const clock = { t: Date.parse('2027-04-01T09:00:00Z') };
  const a = account(clock);
  const stays = fakeStays({ now: '400.00' });
  const marks = [];
  const tripOp = async (_a, op, b) => { marks.push([op, b]); return {}; };
  await stayOp(a, 'trip-stays-search', { id: 't1', stop: 's-h' }, { stays });
  assert.deepEqual(stays.seen[0][1], { lat: 38.71, lng: -9.14, check_in: '2027-05-12', check_out: '2027-05-14', adults: 2, rooms: 1, radius_km: 3 });
  await stayOp(a, 'trip-stays-rates', { search_result_id: 'srr_1' }, { stays });
  const q = await stayOp(a, 'trip-stays-quote', { rate_id: 'rat_1' }, { stays });
  assert.equal(q.cancellation.free_until, '2027-05-10T12:00:00Z');
  await assert.rejects(stayOp(a, 'trip-stays-book', { quote_id: 'quo_1' }, { stays, tripOp }), /confirm: true/);
  const b = await stayOp(a, 'trip-stays-book', { quote_id: 'quo_1', guests: [{ given_name: 'A', family_name: 'B' }], email: 'a@b.co', phone_number: '+15555550100', id: 't1', stop: 's-h', confirm: true }, { stays, tripOp });
  assert.equal(b.reference, 'HDC-77');
  assert.deepEqual(marks[0][1], { id: 't1', stop: 's-h', ref: 'HDC-77', provider: 'Hotel do Chiado', via: 'api', cost: { amount: 400, currency: 'EUR' }, confirm: true });
  assert.equal(a.m.get('stbk:bok_1').free_until, '2027-05-10T12:00:00Z');
});

test('price protection: cheaper before free cancellation ends → one push and Eden noticed shows it; after the deadline, nothing', async () => {
  const clock = { t: Date.parse('2027-04-01T09:00:00Z') };
  const a = account(clock);
  a.m.set('stbk:bok_1', { booking_id: 'bok_1', trip: 't1', stop: 's-h', accommodation: acc, check_in: '2027-05-12', check_out: '2027-05-14', adults: 2, rooms: 1, room: 'Double', total: '400.00', currency: 'EUR', free_until: '2027-05-10T12:00:00Z', drop: null });
  const pushes = [];
  const notify = async (_a, n) => { pushes.push(n); return 1; };
  await stayWatchDue(a, { notify, stays: fakeStays({ now: '250.00', room: '400.00' }) });
  assert.equal(pushes.length, 0, 'the hotel’s cheapest is another room or non-refundable: not a drop');
  await stayWatchDue(a, { notify, stays: fakeStays({ now: '250.00', room: '360.00' }) });
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].title, /Hotel do Chiado is cheaper now/);
  assert.match(pushes[0].body, /40\.00 EUR less|40 EUR less/);
  const drops = await priceDrops(a, 't1');
  assert.equal(drops[0].now, '360.00');
  await stayWatchDue(a, { notify, stays: fakeStays({ now: '250.00', room: '360.00' }) });
  assert.equal(pushes.length, 1, 'the same drop is told once');
  clock.t = Date.parse('2027-05-11T00:00:00Z');
  assert.deepEqual(await priceDrops(a, 't1'), [], 'past free cancellation: no rebook offer');
});

test('a hotel booking is cancelled only from the account that made it (Eden books on one Duffel account for everyone)', async () => {
  const a = account({ t: Date.parse('2027-04-01T09:00:00Z') });
  const stays = fakeStays({ now: '400.00' });
  await assert.rejects(stayOp(a, 'trip-stays-cancel', { booking_id: 'bok_1', confirm: true }, { stays }), /no such hotel booking/);
  a.m.set('stbk:bok_1', { booking_id: 'bok_1' });
  assert.equal((await stayOp(a, 'trip-stays-cancel', { booking_id: 'bok_1', confirm: true }, { stays })).status, 'cancelled');
});

test('a hotel quote is kept for payment even when the room list is older than two hours, at the quote’s own price', async () => {
  const a = account({ t: Date.parse('2027-04-01T09:00:00Z') });
  const stays = { ...fakeStays({ now: '400.00' }), quote: async () => ({ quote_id: 'quo_9', total: '412.00', currency: 'EUR', accommodation: acc }) };
  await stayOp(a, 'trip-stays-quote', { rate_id: 'rat_never_listed' }, { stays });
  assert.equal(a.m.get('stq:quo_9').total, '412.00');
});

test('a hotel cancelled after its free window: the card gets the timeline’s refund for now', () => {
  const b = { total: '400.00', currency: 'EUR', free_until: '2027-05-01T00:00:00Z', refunds: [{ before: '2027-05-01T00:00:00Z', amount: '400.00', currency: 'EUR' }, { before: '2027-05-10T00:00:00Z', amount: '200.00', currency: 'EUR' }] };
  assert.equal(refundNow(b, Date.parse('2027-04-20T00:00:00Z')), 40000);
  assert.equal(refundNow(b, Date.parse('2027-05-05T00:00:00Z')), 20000);
  assert.equal(refundNow(b, Date.parse('2027-05-11T00:00:00Z')), 0);
});
