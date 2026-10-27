// Flights on askeden.com (src/travel/flights.js): Eden's Duffel core in the account object, against the fake Duffel
// server (test/duffel-fake.js, from the askeden repo). Nothing here reaches Duffel.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FLIGHT_ACTIONS, flightOp, flightStatus, flightsApi } from '../src/travel/flights.js';
import { startFakeDuffel } from './duffel-fake.js';
import { Storage } from './fakes.js';

const TOKEN = 'duffel_test_FAKEtoken1234567890';
const ALICE = { title: 'ms', gender: 'f', given_name: 'Alicia', family_name: 'Quartermaine', born_on: '1987-04-12', email: 'alicia.q@example.com', phone_number: '+14155550142' };
const SEARCH = { origin: 'JFK', destination: 'LHR', depart_date: '2027-03-10', adults: 1 };
const account = (env = { EDEN_FLIGHTS: '1', DUFFEL_TOKEN: TOKEN }) => ({ storage: new Storage(), env, now: () => Date.now() });

test('status: off by default; on without a token says so; a live token needs DUFFEL_LIVE=1; the token never shows', () => {
  assert.deepEqual(flightStatus({}), { enabled: false, ready: false, mode: null });
  assert.equal(flightStatus({ EDEN_FLIGHTS: '1' }).code, 'not_configured');
  assert.equal(flightStatus({ EDEN_FLIGHTS: '1', DUFFEL_TOKEN: 'duffel_live_SECRETlive123456' }).code, 'live_token_refused');
  assert.ok(!JSON.stringify(flightStatus({ EDEN_FLIGHTS: '1', DUFFEL_TOKEN: 'duffel_live_SECRETlive123456' })).includes('SECRET'));
  assert.deepEqual(flightStatus({ EDEN_FLIGHTS: '1', DUFFEL_TOKEN: TOKEN }), { enabled: true, ready: true, mode: 'test' });
  assert.ok(FLIGHT_ACTIONS.includes('book'));
});

test('search → check → book across separate requests: the check is kept in the account, used once, and only with confirm', async () => {
  const fake = await startFakeDuffel();
  try {
    const acct = account();
    const deps = { baseUrl: fake.url, log: () => {}, sleep: async () => {} };
    const found = await flightOp(acct, 'flight-search', SEARCH, deps);
    assert.equal(found.mode, 'test');
    assert.ok(found.offers.length >= 1);
    const offer = found.offers[0];
    const checked = await flightOp(acct, 'flight-check', { offer_id: offer.offer_id }, deps); // a new request: a new service
    const review = await flightOp(acct, 'flight-review', { check_id: checked.check_id }, deps);
    assert.equal(review.total, checked.total);
    const book = { check_id: checked.check_id, offer_id: checked.offer_id, amount: (checked.total / 100).toFixed(2), currency: checked.currency, passengers: [ALICE] };
    await assert.rejects(flightOp(acct, 'flight-book', book, deps), (e) => e.status === 400 && e.code === 'input' && /Not confirmed/.test(e.message));
    await assert.rejects(flightOp(acct, 'flight-book', { ...book, amount: '1.00', confirm: true }, deps), (e) => e.code === 'price_changed');
    const order = await flightOp(acct, 'flight-book', { ...book, confirm: true }, deps);
    assert.match(order.order_id, /^ord_/);
    assert.ok(order.booking_reference);
    await assert.rejects(flightOp(acct, 'flight-book', { ...book, confirm: true }, deps), (e) => e.code === 'invalid_state', 'a check books once');
    // nothing about the passenger is kept
    const kept = JSON.stringify([...(await acct.storage.list())]);
    for (const s of ['Alicia', 'Quartermaine', 'alicia.q', '1987-04-12', '+1415']) assert.ok(!kept.includes(s), `${s} not stored`);
    assert.ok(!kept.includes(TOKEN));
  } finally { await fake.close(); }
});

test('two requests at once both keep their checks; an unknown check is refused plainly', async () => {
  const fake = await startFakeDuffel();
  try {
    const acct = account();
    const deps = { baseUrl: fake.url, log: () => {}, sleep: async () => {} };
    const found = await flightOp(acct, 'flight-search', SEARCH, deps);
    const [a, b] = await Promise.all(found.offers.slice(0, 2).map((o) => flightOp(acct, 'flight-check', { offer_id: o.offer_id }, deps)));
    for (const c of [a, b]) assert.equal((await flightOp(acct, 'flight-review', { check_id: c.check_id }, deps)).check_id, c.check_id);
    await assert.rejects(flightOp(acct, 'flight-review', { check_id: 'f'.repeat(24) }, deps), (e) => e.status === 409 && /no recent price check/.test(e.message));
  } finally { await fake.close(); }
});

test('the route: off is a 404; status needs no account; actions go to the account object as flight-<action>', async () => {
  const seen = [];
  const deps = { call: async (env, acct, op, body) => { seen.push(op); return { ok: op }; }, limited: async () => {}, readBody: async (r) => r.json() };
  const who = { account: 'acct-1', token: {} };
  const post = (body) => new Request('https://askeden.com/api/chat/flights', { method: 'POST', body: JSON.stringify(body) });
  await assert.rejects(flightsApi(post({ action: 'search', args: SEARCH }), {}, who, '/api/chat/flights', deps), (e) => e.status === 404);
  const st = await flightsApi(new Request('https://askeden.com/api/chat/flights/status'), { EDEN_FLIGHTS: '1', DUFFEL_TOKEN: TOKEN }, who, '/api/chat/flights/status', deps);
  assert.deepEqual(await st.json(), { enabled: true, ready: true, mode: 'test' });
  const env = { EDEN_FLIGHTS: '1', DUFFEL_TOKEN: TOKEN };
  await flightsApi(post({ action: 'check', args: { offer_id: 'off_x' } }), env, who, '/api/chat/flights', deps);
  assert.deepEqual(seen, ['flight-check']);
  await assert.rejects(flightsApi(post({ action: 'teleport', args: {} }), env, who, '/api/chat/flights', deps), /action must be one of/);
  await assert.rejects(flightOp(account({}), 'flight-search', SEARCH), (e) => e.status === 404, 'the account object refuses too when off');
});
