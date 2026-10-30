// Frequent-flyer numbers (src/travel/loyalty.js) and how a Duffel booking carries them (src/travel/flights.js): saved
// per passenger and airline, shown masked, sent on the offer's passenger (PATCH, as Duffel's docs say) only for airlines
// the fare takes, and a price that moves after it stops the booking. Against the fake Duffel server (test/duffel-fake.js);
// the PATCH, which that fake doesn't know, is answered here. Nothing reaches Duffel.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flightOp } from '../src/travel/flights.js';
import { applyLoyalty, loyaltyFor, loyaltyOp, mask, nameKey } from '../src/travel/loyalty.js';
import { startFakeDuffel } from './duffel-fake.js';
import { Storage } from './fakes.js';

const TOKEN = 'duffel_test_FAKEtoken1234567890';
const ALICE = { title: 'ms', gender: 'f', given_name: 'Alicia', family_name: 'Quartermaine', born_on: '1987-04-12', email: 'alicia.q@example.com', phone_number: '+14155550142' };
const SEARCH = { origin: 'JFK', destination: 'LHR', depart_date: '2027-03-10', adults: 1 };
const account = () => ({ storage: new Storage(), env: { EDEN_FLIGHTS: '1', DUFFEL_TOKEN: TOKEN }, now: () => Date.now() });
const save = (a, x) => loyaltyOp(a, 'trip-loyalty-save', { confirm: true, ...x });

test('saved per passenger and airline; the page sees only the last 4; same person and airline replaces; checks', async () => {
  const a = account();
  await assert.rejects(loyaltyOp(a, 'trip-loyalty-save', { given_name: 'A', family_name: 'B', airline: 'BA', number: '12345678' }), /confirm/);
  await assert.rejects(save(a, { given_name: 'Alicia', family_name: 'Q', airline: 'British', number: '12345678' }), /two-character/);
  await assert.rejects(save(a, { given_name: 'Alicia', family_name: 'Q', airline: '12', number: '12345678' }), /two-character/);
  await assert.rejects(save(a, { given_name: 'Alicia', family_name: 'Q', airline: 'BA', number: '12' }), /4 to 20/);
  await assert.rejects(save(a, { given_name: '', family_name: 'Q', airline: 'BA', number: '12345678' }), /name/);
  let r = await save(a, { given_name: 'Alicia', family_name: 'Quartermaine', airline: 'ba', number: '1290 1014' });
  assert.equal(r.accounts.length, 1);
  assert.deepEqual({ ...r.accounts[0], id: 'x', added: 'x' }, { id: 'x', given_name: 'Alicia', family_name: 'Quartermaine', airline: 'BA', number: '•••• 1014', added: 'x' });
  assert.ok(!JSON.stringify(r).includes('12901014'), 'the full number never goes back to the page');
  r = await save(a, { given_name: 'ALICIA', family_name: 'quartermaine', airline: 'BA', number: '99990000' });
  assert.equal(r.accounts.length, 1, 'same person + airline: replaced');
  assert.equal(r.accounts[0].number, '•••• 0000');
  r = await save(a, { given_name: 'Alicia', family_name: 'Quartermaine', airline: 'AA', number: 'AB12CD34' });
  assert.equal(r.accounts.length, 2);
  assert.equal((await a.storage.get('tloyal'))[1].number, 'AB12CD34', 'kept in full in the account object');
  r = await loyaltyOp(a, 'trip-loyalty-delete', { id: r.accounts[0].id });
  assert.deepEqual(r.accounts.map((x) => x.airline), ['AA']);
  await assert.rejects(loyaltyOp(a, 'trip-loyalty-delete', { id: 'l-0000000000' }), (e) => e.status === 404);
  assert.equal((await loyaltyOp(a, 'trip-loyalty', {})).accounts.length, 1);
});

test('matching: by passport name (case, accents, hyphens aside), only airlines the offer takes', () => {
  assert.equal(nameKey('José', 'García-López'), nameKey('jose', 'garcia lopez'));
  assert.equal(mask('12901014'), '•••• 1014');
  const saved = [
    { airline: 'BA', given_name: 'Alicia', family_name: 'Quartermaine', number: '111111' },
    { airline: 'AA', given_name: 'Alicia', family_name: 'Quartermaine', number: '222222' },
    { airline: 'BA', given_name: 'Bob', family_name: 'Quartermaine', number: '333333' },
  ];
  const pax = [{ given_name: 'alicia', family_name: 'QUARTERMAINE' }, { given_name: 'Carol', family_name: 'Q' }];
  assert.deepEqual(loyaltyFor(saved, pax, ['BA', 'KL']), [{ index: 0, accounts: [{ airline_iata_code: 'BA', account_number: '111111' }] }]);
  assert.deepEqual(loyaltyFor(saved, pax, []), [], 'an empty list: the fare takes none');
  assert.deepEqual(loyaltyFor(saved, pax, undefined), [], 'no list: nothing sent');
});

// the fake Duffel, plus the offer-passenger PATCH it doesn't have (Duffel's: { data: { given_name, family_name, loyalty_programme_accounts } })
async function duffelWithPatch() {
  const fake = await startFakeDuffel();
  const patches = [];
  let reprice = null;
  const fetch = async (url, init) => {
    const u = new URL(url);
    const m = /^\/air\/offers\/(\w+)\/passengers\/(\w+)$/.exec(u.pathname);
    if (init.method === 'PATCH' && m) {
      patches.push({ offer: m[1], passenger: m[2], data: JSON.parse(init.body).data, auth: init.headers.Authorization });
      if (reprice) fake.repriced.set(m[1], reprice);
      return new Response(JSON.stringify({ data: { id: m[2] } }), { status: 200 });
    }
    return globalThis.fetch(url, init);
  };
  return { fake, patches, fetch, setReprice: (v) => { reprice = v; } };
}

async function checked(a, d, deps, supported) {
  const found = await flightOp(a, 'flight-search', SEARCH, deps);
  const c = await flightOp(a, 'flight-check', { offer_id: found.offers[0].offer_id }, deps);
  d.fake.offers.get(c.offer_id).supported_loyalty_programmes = supported;
  return { c, book: { check_id: c.check_id, offer_id: c.offer_id, amount: (c.total / 100).toFixed(2), currency: c.currency, passengers: [ALICE], confirm: true } };
}

test('booking: the passenger’s number for a taken airline goes on the offer’s passenger before the order', async () => {
  const d = await duffelWithPatch();
  try {
    const a = account();
    const deps = { baseUrl: d.fake.url, fetch: d.fetch, log: () => {}, sleep: async () => {} };
    await save(a, { given_name: 'Alicia', family_name: 'Quartermaine', airline: 'BA', number: '12901014' });
    await save(a, { given_name: 'Alicia', family_name: 'Quartermaine', airline: 'DL', number: '55556666' });
    const { c, book } = await checked(a, d, deps, ['BA', 'AA']);
    const pas = d.fake.offers.get(c.offer_id).passengers[0].id;
    const order = await flightOp(a, 'flight-book', book, deps);
    assert.ok(order.order_id);
    assert.deepEqual(order.loyalty, [{ passenger: 'Alicia Quartermaine', airline: 'BA', number: '•••• 1014' }]);
    assert.equal(d.patches.length, 1);
    assert.deepEqual(d.patches[0], { offer: c.offer_id, passenger: pas, data: { given_name: 'Alicia', family_name: 'Quartermaine', loyalty_programme_accounts: [{ airline_iata_code: 'BA', account_number: '12901014' }] }, auth: `Bearer ${TOKEN}` });
    // the PATCH comes before the order; the order's passengers carry no loyalty field (Duffel's create order has none)
    const paths = d.fake.requests.map((r) => `${r.method} ${r.path}`);
    assert.ok(paths.lastIndexOf('POST /air/orders') > paths.findIndex((p) => p.startsWith('GET /air/offers/')));
    const post = d.fake.requests.find((r) => r.method === 'POST' && r.path === '/air/orders');
    assert.ok(post && !JSON.stringify(post.body).includes('loyalty'));
  } finally { await d.fake.close(); }
});

test('booking: a fare that takes none of the airlines, no saved numbers, or loyalty: false send nothing', async () => {
  const d = await duffelWithPatch();
  try {
    const deps = { baseUrl: d.fake.url, fetch: d.fetch, log: () => {}, sleep: async () => {} };
    const a = account();
    await save(a, { given_name: 'Alicia', family_name: 'Quartermaine', airline: 'BA', number: '12901014' });
    let { book } = await checked(a, d, deps, ['KL']);
    assert.equal((await flightOp(a, 'flight-book', book, deps)).loyalty, undefined);
    ({ book } = await checked(a, d, deps, ['BA']));
    assert.equal((await flightOp(a, 'flight-book', { ...book, loyalty: false }, deps)).loyalty, undefined);
    const b = account();
    ({ book } = await checked(b, d, deps, ['BA']));
    assert.ok((await flightOp(b, 'flight-book', book, deps)).order_id);
    assert.equal(d.patches.length, 0);
  } finally { await d.fake.close(); }
});

test('booking: the airline’s price moves with the number: nothing booked, the check stays for a fresh look', async () => {
  const d = await duffelWithPatch();
  try {
    const deps = { baseUrl: d.fake.url, fetch: d.fetch, log: () => {}, sleep: async () => {} };
    const a = account();
    await save(a, { given_name: 'Alicia', family_name: 'Quartermaine', airline: 'BA', number: '12901014' });
    const { book } = await checked(a, d, deps, ['BA']);
    d.setReprice('499.00');
    await assert.rejects(flightOp(a, 'flight-book', book, deps), (e) => e.status === 409 && e.code === 'price_changed' && /499\.00/.test(e.message) && !/12901014/.test(e.message));
    assert.ok(!d.fake.requests.some((r) => r.method === 'POST' && r.path === '/air/orders'), 'nothing booked');
    // checked again: the new price (the number is on the offer now), and booking at it goes through
    d.setReprice(null);
    const again = await flightOp(a, 'flight-check', { offer_id: book.offer_id }, deps);
    assert.equal(again.total, 49900);
    const order = await flightOp(a, 'flight-book', { ...book, check_id: again.check_id, amount: '499.00' }, deps);
    assert.ok(order.order_id);
    assert.equal(order.loyalty[0].airline, 'BA');
  } finally { await d.fake.close(); }
});

test('applyLoyalty: a name longer than Duffel takes (20) is skipped, not cut', async () => {
  const a = account();
  await a.storage.put('tloyal', [{ id: 'l-0000000001', given_name: 'Maximiliana-Theodoras', family_name: 'Q', airline: 'BA', number: '12345678', added: 0 }]);
  const calls = [];
  const client = { getOffer: async () => { calls.push('get'); return { supported_loyalty_programmes: ['BA'], total_amount: '1.00', total_currency: 'USD' }; }, updateOfferPassenger: async () => { calls.push('patch'); } };
  const out = await applyLoyalty(a, client, { offer_id: 'off_x', passenger_ids: ['pas_1'], fare: 100, currency: 'USD' }, [{ given_name: 'Maximiliana-Theodoras', family_name: 'Q' }]);
  assert.deepEqual(out, []);
  assert.deepEqual(calls, ['get']);
});

// ---- hotel programmes (Duffel Stays): saved per guest and programme, one number per booking, only when the quote names it ----
import { HOTEL_PROGRAMMES, hotelLoyaltyFor } from '../src/travel/loyalty.js';
import { stayOp } from '../src/travel/stayops.js';
import { staysFor } from '../src/travel/stays.js';

test('hotel numbers: only programmes Duffel lists, per guest + programme, masked, deleted by id', async () => {
  const a = account();
  await assert.rejects(save(a, { given_name: 'Alicia', family_name: 'Quartermaine', programme: 'starwood_preferred', number: '12345678' }), /Duffel Stays lists/);
  await assert.rejects(save(a, { given_name: 'Alicia', family_name: 'Quartermaine', programme: 'marriott_bonvoy', number: '1' }), /4 to 20/);
  let r = await save(a, { given_name: 'Alicia', family_name: 'Quartermaine', programme: 'marriott_bonvoy', number: '201 154 908' });
  r = await save(a, { given_name: 'alicia', family_name: 'QUARTERMAINE', programme: 'Marriott_Bonvoy', number: '201154999' });
  r = await save(a, { given_name: 'Alicia', family_name: 'Quartermaine', airline: 'BA', number: '12901014' });
  assert.equal(r.hotel_accounts.length, 1, 'same guest + programme: replaced');
  assert.deepEqual({ ...r.hotel_accounts[0], id: 'x', added: 'x' }, { id: 'x', given_name: 'alicia', family_name: 'QUARTERMAINE', programme: 'marriott_bonvoy', programme_name: 'Marriott Bonvoy', number: '•••• 4999', added: 'x' });
  assert.equal(r.accounts.length, 1, 'flight numbers kept apart');
  assert.ok(!JSON.stringify(r).includes('201154999'));
  assert.equal(r.hotel_programmes.length, Object.keys(HOTEL_PROGRAMMES).length);
  r = await loyaltyOp(a, 'trip-loyalty-delete', { id: r.hotel_accounts[0].id });
  assert.equal(r.hotel_accounts.length, 0);
  assert.equal(r.accounts.length, 1);
});

test('hotel matching: the quote’s programme only, first guest in order with a number; unknown or none → nothing', () => {
  const saved = [
    { programme: 'hilton_honors', given_name: 'Bob', family_name: 'Q', number: 'H1111111' },
    { programme: 'marriott_bonvoy', given_name: 'Bob', family_name: 'Q', number: 'M2222222' },
    { programme: 'marriott_bonvoy', given_name: 'Alicia', family_name: 'Quartermaine', number: 'M3333333' },
  ];
  const guests = [{ given_name: 'Carol', family_name: 'Z' }, { given_name: 'bob', family_name: 'q' }, { given_name: 'Alicia', family_name: 'Quartermaine' }];
  assert.deepEqual(hotelLoyaltyFor(saved, guests, 'marriott_bonvoy'), { number: 'M2222222', programme: 'marriott_bonvoy', name: 'Marriott Bonvoy', guest: 'Bob Q', masked: '•••• 2222' });
  assert.equal(hotelLoyaltyFor(saved, guests, 'world_of_hyatt'), null, 'no guest has one');
  assert.equal(hotelLoyaltyFor(saved, guests, null), null, 'the quote names none');
  assert.equal(hotelLoyaltyFor(saved, guests, 'made_up_rewards'), null, 'one Duffel doesn’t list');
});

test('a stay: the quote card says what it earns with; the booking sends the number only for the quote’s programme', async () => {
  const a = account();
  a.env = {};
  await save(a, { given_name: 'Alicia', family_name: 'Quartermaine', programme: 'marriott_bonvoy', number: '201154908' });
  const booked = [];
  const stays = (programme) => ({
    quote: async () => ({ quote_id: 'quo_1', total: '400.00', currency: 'EUR', accommodation: { name: 'H' }, loyalty_programme: programme }),
    book: async (x) => { booked.push(x); return { booking_id: 'bok_1', reference: 'R1', accommodation: { name: 'H' } }; },
  });
  const BOOK = { quote_id: 'quo_1', guests: [{ given_name: 'Alicia', family_name: 'Quartermaine' }], email: 'a@b.co', phone_number: '+15555550100', confirm: true };

  let q = await stayOp(a, 'trip-stays-quote', { rate_id: 'rat_1' }, { stays: stays('marriott_bonvoy') });
  assert.deepEqual(q.loyalty, { programme: 'marriott_bonvoy', name: 'Marriott Bonvoy', saved: [{ guest: 'Alicia Quartermaine', number: '•••• 4908' }] });
  let b = await stayOp(a, 'trip-stays-book', { ...BOOK }, { stays: stays('marriott_bonvoy') });
  assert.equal(booked[0].loyalty_programme_account_number, '201154908');
  assert.deepEqual(b.loyalty, { programme: 'marriott_bonvoy', name: 'Marriott Bonvoy', guest: 'Alicia Quartermaine', number: '•••• 4908' });
  assert.ok(!JSON.stringify(b).includes('201154908'));

  q = await stayOp(a, 'trip-stays-quote', { rate_id: 'rat_1' }, { stays: stays('hilton_honors') });
  assert.deepEqual(q.loyalty, { programme: 'hilton_honors', name: 'Hilton Honors', saved: [] }, 'earns with Hilton, none saved');
  b = await stayOp(a, 'trip-stays-book', { ...BOOK, loyalty_programme_account_number: '201154908' }, { stays: stays('hilton_honors') });
  assert.equal(booked[1].loyalty_programme_account_number, undefined, 'a Marriott number never goes to a Hilton rate, nor one the request names');
  assert.equal(b.loyalty, undefined);

  q = await stayOp(a, 'trip-stays-quote', { rate_id: 'rat_1' }, { stays: stays(null) });
  assert.equal(q.loyalty, null, 'the quote names no programme: nothing claimed');
  await stayOp(a, 'trip-stays-book', { ...BOOK }, { stays: stays(null) });
  assert.equal(booked[2].loyalty_programme_account_number, undefined);
});

test('stays.js: the quote’s supported_loyalty_programme read; the number goes in Create booking’s body only when given', async () => {
  const sent = [];
  const fetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body).data : null;
    sent.push([url, body]);
    const data = url.endsWith('/stays/quotes')
      ? { id: 'quo_ABCDEF1', total_amount: '400.00', total_currency: 'EUR', supported_loyalty_programme: 'duffel_hotel_group_rewards', accommodation: { name: 'Duffel Test Hotel' } }
      : { id: 'bok_ABCDEF1', reference: 'R1', status: 'confirmed', loyalty_programme_account_number: body.loyalty_programme_account_number ?? null };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const s = staysFor({ EDEN_STAYS: '1', DUFFEL_TOKEN: TOKEN }, { fetch });
  assert.equal((await s.quote('rat_ABCDEF1')).loyalty_programme, 'duffel_hotel_group_rewards');
  const base = { quote_id: 'quo_ABCDEF1', guests: [{ given_name: 'A', family_name: 'B' }], email: 'a@b.co', phone_number: '+15555550100', confirm: true };
  const b = await s.book({ ...base, loyalty_programme_account_number: '201154908' });
  assert.equal(sent[1][1].loyalty_programme_account_number, '201154908');
  assert.ok(!JSON.stringify(b).includes('201154908'), 'the booking view doesn’t echo the number');
  await s.book(base);
  assert.ok(!('loyalty_programme_account_number' in sent[2][1]));
  await assert.rejects(s.book({ ...base, loyalty_programme_account_number: 'x' }), /4 to 20/);
});
