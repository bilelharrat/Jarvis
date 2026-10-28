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
