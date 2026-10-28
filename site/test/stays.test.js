// Hotels on askeden.com (src/travel/stays.js) against the fake Duffel Stays server (test/stays-fake.js).
// Nothing here reaches Duffel.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StaysError, cancellation, checkDates, priceDrop, staysFor, staysOn } from '../src/travel/stays.js';
import { startFakeStays } from './stays-fake.js';

const TOKEN = 'duffel_test_FAKEtoken1234567890';
const NOW = Date.parse('2027-01-10T12:00:00Z');
const ENV = { EDEN_STAYS: '1', DUFFEL_TOKEN: TOKEN };
const SEARCH = { lat: 38.7118, lng: -9.1384, radius_km: 3, check_in: '2027-03-10', check_out: '2027-03-13', adults: 2, children_ages: [7] };
const GUEST = { given_name: 'Alicia', family_name: 'Quartermaine' };
const BOOK = { guests: [GUEST], email: 'alicia.q@example.com', phone_number: '+14155550142', special_requests: 'A quiet room, please.' };
const svc = (fake, env = ENV, opts = {}) => staysFor(env, { baseUrl: fake.url, now: () => NOW, ...opts });
const code = (c) => (e) => e instanceof StaysError && e.code === c;

test('on only with EDEN_STAYS=1 and a token; a live token is refused unless DUFFEL_LIVE=1, and never shows', () => {
  assert.equal(staysOn({}), false);
  assert.equal(staysOn({ EDEN_STAYS: '1' }), true);
  assert.equal(staysFor({ DUFFEL_TOKEN: TOKEN }), null);
  assert.equal(staysFor({ EDEN_STAYS: '1' }), null);
  assert.equal(staysFor(ENV).mode, 'test');
  const live = { EDEN_STAYS: '1', DUFFEL_TOKEN: 'duffel_live_SECRETlive123456' };
  assert.throws(() => staysFor(live), (e) => code('live_refused')(e) && !e.message.includes('SECRET'));
  assert.equal(staysFor({ ...live, DUFFEL_LIVE: '1' }).mode, 'live');
  assert.throws(() => staysFor({ EDEN_STAYS: '1', DUFFEL_TOKEN: 'sk_nope' }), code('not_set_up'));
});

test('search → rates → quote → book → booking, with Duffel’s headers and fields; confirm is required', async () => {
  const fake = await startFakeStays();
  const logged = [];
  const origLog = console.log, origErr = console.error, origWarn = console.warn;
  console.log = console.error = console.warn = (...a) => logged.push(a.join(' '));
  try {
    const s = svc(fake);
    const found = await s.search(SEARCH);
    assert.equal(found.source, 'Duffel Stays');
    assert.equal(found.checked_at, new Date(NOW).toISOString());
    assert.equal(found.nights, 3);
    assert.equal(found.results.length, 3);
    assert.deepEqual(found.results.map((r) => Number(r.cheapest.total)), [285, 420, 930]); // cheapest first
    const first = found.results[0];
    assert.match(first.search_result_id, /^srr_/);
    assert.equal(first.accommodation.name, 'Alfama Rooms Fake');
    assert.equal(first.accommodation.address.city, 'Lisbon');
    assert.equal(first.cheapest.currency, 'EUR');

    const sent = fake.requests[0];
    assert.equal(sent.headers['duffel-version'], 'v2');
    assert.equal(sent.headers.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(sent.body, { data: { rooms: 1, guests: [{ type: 'adult' }, { type: 'adult' }, { type: 'child', age: 7 }], check_in_date: '2027-03-10', check_out_date: '2027-03-13', location: { radius: 3, geographic_coordinates: { latitude: 38.7118, longitude: -9.1384 } } } });

    const r = await s.rates(first.search_result_id);
    assert.equal(r.source, 'Duffel Stays');
    assert.ok(r.checked_at);
    assert.equal(r.rooms[0].name, 'Double Room');
    assert.deepEqual(r.rooms[0].beds, [{ type: 'double', count: 1 }]);
    const [saver, flexible] = r.rooms[0].rates;
    assert.equal(saver.board_type, 'room_only');
    assert.deepEqual(saver.cancellation, { free_until: null, refunds: [] }); // empty timeline: not refundable
    assert.equal(flexible.conditions[0].title, 'Pets');

    const q = await s.quote(flexible.rate_id);
    assert.match(q.quote_id, /^quo_/);
    assert.equal(q.total, flexible.total);
    assert.equal(q.due_at_accommodation, '4.00');
    assert.equal(q.check_in, '2027-03-10');
    assert.ok(q.source && q.checked_at);

    await assert.rejects(s.book({ ...BOOK, quote_id: q.quote_id }), code('not_confirmed'));
    await assert.rejects(s.book({ ...BOOK, quote_id: q.quote_id, confirm: 'yes' }), code('not_confirmed'));
    assert.ok(!fake.requests.some((x) => x.path === '/stays/bookings'), 'nothing sent without confirm');
    await assert.rejects(s.book({ ...BOOK, quote_id: q.quote_id, phone_number: '415 555 0142', confirm: true }), code('bad_request'));

    const b = await s.book({ ...BOOK, quote_id: q.quote_id, confirm: true });
    assert.match(b.booking_id, /^bok_/);
    assert.equal(b.status, 'confirmed');
    assert.ok(b.reference && b.confirmed_at && b.source && b.checked_at);
    const bookBody = fake.requests.find((x) => x.path === '/stays/bookings').body.data;
    assert.deepEqual(bookBody, { quote_id: q.quote_id, guests: [GUEST], email: BOOK.email, phone_number: BOOK.phone_number, accommodation_special_requests: 'A quiet room, please.' });
    assert.ok(!('payment' in bookBody), 'paid from the Duffel balance: no payment object');
    // no guest details in what Eden hands back
    for (const secret of ['Quartermaine', 'alicia.q@', '+1415']) assert.ok(!JSON.stringify(b).includes(secret));

    const again = await s.booking(b.booking_id);
    assert.equal(again.reference, b.reference);
    assert.equal(again.accommodation.name, 'Alfama Rooms Fake');
    assert.equal(again.status, 'confirmed');
    assert.ok(!logged.some((l) => l.includes(TOKEN) || l.includes('Quartermaine')), 'nothing logged with the token or guests');
  } finally {
    console.log = origLog; console.error = origErr; console.warn = origWarn;
    await fake.close();
  }
});

test('dates: check-out after check-in, at most 99 nights, at most 330 days ahead, not in the past', async () => {
  assert.equal(checkDates('2027-03-10', '2027-03-11', NOW), 1);
  assert.throws(() => checkDates('2027-03-10', '2027-03-10', NOW), code('bad_request'));
  assert.throws(() => checkDates('2027-03-10', '2027-03-09', NOW), code('bad_request'));
  assert.equal(checkDates('2027-03-01', '2027-06-08', NOW), 99);
  assert.throws(() => checkDates('2027-03-01', '2027-06-09', NOW), /99 nights/);
  assert.equal(checkDates('2027-12-06', '2027-12-07', NOW), 1); // 330 days after 2027-01-10
  assert.throws(() => checkDates('2027-12-07', '2027-12-08', NOW), /330 days/);
  assert.throws(() => checkDates('2027-01-01', '2027-01-03', NOW), /past/);
  assert.throws(() => checkDates('2027-02-30', '2027-03-02', NOW), /real dates/);
  assert.throws(() => checkDates('10/03/2027', '2027-03-12', NOW), code('bad_request'));
  const fake = await startFakeStays();
  try {
    const s = svc(fake);
    await assert.rejects(s.search({ ...SEARCH, check_out: SEARCH.check_in }), code('bad_request'));
    await assert.rejects(s.search({ ...SEARCH, rooms: 3 }), code('bad_request')); // more rooms than adults
    await assert.rejects(s.search({ ...SEARCH, lat: 120 }), code('bad_request'));
    assert.equal(fake.requests.length, 0, 'bad input never reaches Duffel');
  } finally {
    await fake.close();
  }
});

test('a 404, a 429, a 401, a 500 and a timeout become StaysErrors', async () => {
  const fake = await startFakeStays();
  try {
    const s = svc(fake, ENV, { timeoutMs: 100 });
    await assert.rejects(s.rates('srr_0000NOSUCHresult'), code('not_found'));
    await assert.rejects(s.booking('bok_0000NOSUCHbooking'), code('not_found'));
    fake.faults.push({ match: 'POST /stays/search', status: 429, body: { errors: [{ type: 'rate_limit_error', code: 'rate_limit_exceeded' }] } });
    await assert.rejects(s.search(SEARCH), code('rate_limited'));
    fake.faults.push({ match: 'POST /stays/search', status: 401 });
    await assert.rejects(s.search(SEARCH), code('not_set_up'));
    fake.faults.push({ match: 'POST /stays/search', status: 500 });
    await assert.rejects(s.search(SEARCH), code('unavailable'));
    fake.faults.push({ match: 'POST /stays/search', status: 200, body: { data: { results: [] } }, delayMs: 400 });
    await assert.rejects(s.search(SEARCH), code('timeout'));
    await assert.rejects(s.quote('not-a-rate'), code('bad_request'));
  } finally {
    await fake.close();
  }
});

test('the cancellation timeline: sorted, free until the last full refund, partial refunds kept', async () => {
  const fake = await startFakeStays();
  try {
    const s = svc(fake);
    const found = await s.search(SEARCH);
    const flexible = (await s.rates(found.results[0].search_result_id)).rooms[0].rates[1];
    assert.equal(flexible.total, '327.75');
    assert.deepEqual(flexible.cancellation, {
      free_until: '2027-03-07T14:00:00.000Z',
      refunds: [{ before: '2027-03-07T14:00:00.000Z', amount: '327.75', currency: 'EUR' }, { before: '2027-03-09T14:00:00.000Z', amount: '163.88', currency: 'EUR' }],
    });
  } finally {
    await fake.close();
  }
  assert.deepEqual(cancellation(null, '100.00', 'EUR'), { free_until: null, refunds: [] });
  assert.equal(cancellation([{ before: '2027-03-01T00:00:00Z', refund_amount: '50.00', currency: 'EUR' }], '100.00', 'EUR').free_until, null); // partial only
  assert.equal(cancellation([{ before: 'soon', refund_amount: '100.00' }], '100.00', 'EUR').refunds.length, 0);
});

test('priceDrop: only same currency, more than 1% cheaper, and before free cancellation ends', () => {
  const booked = { total: '300.00', currency: 'EUR', free_until: '2027-03-07T14:00:00.000Z' };
  assert.deepEqual(priceDrop(booked, { total: '270.00', currency: 'EUR', rate_id: 'rat_0001FAKE' }, NOW), { cheaper: true, by: '30.00', currency: 'EUR', rate_id: 'rat_0001FAKE', rebook_before: booked.free_until });
  assert.equal(priceDrop(booked, { total: '296.99', currency: 'EUR' }, NOW).cheaper, true); // just over 1%
  assert.deepEqual(priceDrop(booked, { total: '297.00', currency: 'EUR' }, NOW), { cheaper: false, why: 'too_small' }); // exactly 1%
  assert.deepEqual(priceDrop(booked, { total: '310.00', currency: 'EUR' }, NOW), { cheaper: false, why: 'not_cheaper' });
  assert.deepEqual(priceDrop(booked, { total: '300.00', currency: 'EUR' }, NOW), { cheaper: false, why: 'not_cheaper' });
  assert.deepEqual(priceDrop(booked, { total: '200.00', currency: 'USD' }, NOW), { cheaper: false, why: 'currency_differs' });
  assert.deepEqual(priceDrop({ ...booked, free_until: null }, { total: '200.00', currency: 'EUR' }, NOW), { cheaper: false, why: 'not_free_to_cancel' });
  assert.deepEqual(priceDrop(booked, { total: '200.00', currency: 'EUR' }, Date.parse('2027-03-07T14:00:00Z')), { cheaper: false, why: 'free_cancellation_over' });
  assert.deepEqual(priceDrop(booked, { total: 'n/a', currency: 'EUR' }, NOW), { cheaper: false, why: 'no_price' });
});
