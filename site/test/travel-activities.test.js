// Eden Travel tours, tickets and restaurant links (activities.js): Viator and GetYourGuide adapters in their documented
// shapes, off without keys, errors per partner, OpenTable/TheFork only as the stop's own link. Fake fetches only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITIES, activitiesOp, gygFor, restaurantLink, viatorFor } from '../src/travel/activities.js';

const T0 = Date.parse('2026-10-28T12:00:00Z');
const TID = 'a1b2c3d4e5f60718';
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ON = { EDEN_ACTIVITIES: '1', VIATOR_API_KEY: 'viator-test-key-123', GYG_API_KEY: 'gyg-test-key-456', GYG_PARTNER_ID: 'EDEN42' };

function lisbon() {
  return {
    title: 'Lisbon', destination: 'Lisbon, Portugal', start: '2026-11-28', travelers: 2, budget: { amount: 900, currency: 'EUR' }, rev: 1, days: [
      { title: 'Day 1', stops: [
        { id: 's-tower', kind: 'visit', place: { id: 'g:1', name: 'Belém Tower', lat: 38.6916, lng: -9.216 }, at: '10:00', minutes: 60, mode: 'walk', cost: null, nights: null, link: null, booked: null, note: '' },
        { id: 's-dinner', kind: 'meal', place: { id: 'g:2', name: 'Taberna X', lat: 38.71, lng: -9.14 }, at: '20:00', minutes: 90, mode: 'walk', cost: null, nights: null, link: 'https://www.opentable.com/r/taberna-x-lisboa', booked: null, note: '' },
      ] },
      { title: 'Day 2', stops: [] },
    ],
  };
}
function account(env = ON, trip = lisbon()) {
  const m = new Map([[`trip:${TID}`, trip]]);
  return { env, now: () => T0, storage: { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v) } };
}
function memCache() {
  const m = new Map();
  return { m, get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); } };
}
const VIATOR_PRODUCT = {
  productCode: '5657BRIDGE', title: 'Belém Tower skip-the-line ticket', description: 'Enter the tower…',
  reviews: { totalReviews: 1243, combinedAverageRating: 4.62 },
  duration: { fixedDurationInMinutes: 90 },
  pricing: { summary: { fromPrice: 18.5 }, currency: 'EUR' },
  productUrl: 'https://www.viator.com/tours/Lisbon/Belem/d538-5657BRIDGE?mcid=42383&pid=P00045135&medium=api&version=2.0',
  flags: ['FREE_CANCELLATION'], confirmationType: 'INSTANT',
};
const GYG_TOUR = {
  tour_id: 12345, title: 'Lisbon: Belém food tour', abstract: 'Pastéis and more', overall_rating: 4.8, number_of_ratings: 532,
  price: { values: { amount: 49 }, description: 'per person' }, durations: [{ duration: 3, unit: 'hour' }],
  cancellation_policy: { cancellable: true, cancellation_fee_value: 0, cancellation_offset_minutes: 1440, cancellation_policy_text: 'Cancel up to 24 hours in advance for a full refund' },
  partner_business_category: 'Walking Tours', activity_type: 'guidedTour', free_sale: true,
  url: 'https://www.getyourguide.com/lisbon-l42/belem-food-tour-t12345/',
};

function fakeFetch(log, { viator = {}, gyg = {} } = {}) {
  return async (url, init) => {
    log.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (url.includes('viator.com')) {
      if (viator.status) return jsonRes({ code: 'X', message: 'secret echo' }, viator.status);
      if (url.includes('/search/freetext')) {
        const b = JSON.parse(init.body);
        if (b.searchTypes[0].searchType === 'DESTINATIONS') return jsonRes({ destinations: { totalCount: 1, results: [{ id: 538, name: 'Lisbon' }] } });
        return jsonRes({ products: { totalCount: 1, results: [VIATOR_PRODUCT] } });
      }
      if (url.includes('/products/search')) return jsonRes({ products: [VIATOR_PRODUCT, { ...VIATOR_PRODUCT, productCode: 'B', title: 'Tram 28', flags: [], productUrl: 'javascript:alert(1)', duration: { variableDurationFromMinutes: 60, variableDurationToMinutes: 120 } }], totalCount: 2 });
    }
    if (url.includes('getyourguide.com') || url.includes('gygtest.net')) {
      if (gyg.status) return jsonRes({}, gyg.status);
      return jsonRes({ _metadata: { status: 'OK' }, data: { tours: [GYG_TOUR, { ...GYG_TOUR, tour_id: 2, title: 'Sintra day trip', cancellation_policy: { cancellable: false, cancellation_policy_text: 'Non-refundable' }, partner_business_category: 'Day Trips', url: 'https://www.getyourguide.com/x-t2/?partner_id=OTHER' }] } });
    }
    throw new Error(`unexpected ${url}`);
  };
}

test('off without EDEN_ACTIVITIES or keys: every partner says it isn’t switched on, no fetch', async () => {
  const log = [];
  for (const env of [{}, { EDEN_ACTIVITIES: '1' }, { VIATOR_API_KEY: ON.VIATOR_API_KEY, GYG_API_KEY: ON.GYG_API_KEY }]) {
    assert.equal(viatorFor(env), null);
    assert.equal(gygFor(env), null);
    const r = await activitiesOp(account(env), 'trip-activities', { id: TID }, { fetch: fakeFetch(log), cache: memCache() });
    assert.deepEqual(r.partners.map((p) => [p.id, p.on]), [['viator', false], ['getyourguide', false], ['opentable', false], ['thefork', false]]);
    assert.ok(r.partners.every((p) => p.note && p.results.length === 0 && p.checked_at));
  }
  assert.equal(log.length, 0);
});

test('destination search: Viator by destination id, GetYourGuide by name; shapes, sources and links', async () => {
  const log = [];
  const cache = memCache();
  const r = await activitiesOp(account(), 'trip-activities', { id: TID }, { fetch: fakeFetch(log), cache });
  assert.equal(r.date, '2026-11-28');
  assert.equal(r.currency, 'EUR');
  const [v, g, ot, tf] = r.partners;
  // Viator: freetext DESTINATIONS, then /products/search with the documented headers
  const vd = log.find((x) => x.url.includes('viator'));
  assert.match(vd.url, /^https:\/\/api\.viator\.com\/partner\/search\/freetext$/);
  assert.equal(vd.body.searchTerm, 'Lisbon');
  const ps = log.find((x) => x.url.includes('/products/search'));
  assert.equal(ps.init.headers['exp-api-key'], ON.VIATOR_API_KEY);
  assert.equal(ps.init.headers.Accept, 'application/json;version=2.0');
  assert.deepEqual(ps.body.filtering, { destination: '538', startDate: '2026-11-28', endDate: '2026-11-28' });
  assert.equal(ps.body.currency, 'EUR');
  assert.equal(v.on, true);
  assert.equal(v.results.length, 2);
  const a = v.results[0];
  assert.deepEqual(a.price, { amount: 18.5, currency: 'EUR', kind: 'from', per: 'person' });
  assert.equal(a.rating, 4.62); assert.equal(a.reviews, 1243); assert.equal(a.duration_min, 90);
  assert.deepEqual(a.free_cancellation, { free: true, text: null });
  assert.equal(a.book_url, VIATOR_PRODUCT.productUrl); // unmodified affiliate link
  assert.equal(a.source, 'Viator'); assert.equal(a.checked_at, new Date(T0).toISOString());
  const b = v.results[1];
  assert.equal(b.book_url, null); // not https: dropped
  assert.equal(b.free_cancellation, null); // not asked for: unknown, not "no"
  assert.equal(b.duration_min, 60); assert.equal(b.duration_max_min, 120);
  // GetYourGuide: GET /1/tours with q, both dates, the token header
  const gl = log.find((x) => x.url.includes('getyourguide'));
  assert.match(gl.url, /^https:\/\/api\.getyourguide\.com\/1\/tours\?cnt_language=en&currency=EUR&/);
  assert.match(gl.url, /&q=Lisbon&date\[\]=2026-11-28T00%3A00%3A00&date\[\]=2026-11-28T23%3A59%3A59$/);
  assert.equal(gl.init.headers['X-ACCESS-TOKEN'], ON.GYG_API_KEY);
  assert.equal(g.results.length, 2);
  const t = g.results[0];
  assert.deepEqual(t.price, { amount: 49, currency: 'EUR', kind: 'from', per: 'per person' });
  assert.equal(t.duration_min, 180); assert.equal(t.rating, 4.8); assert.equal(t.reviews, 532);
  assert.deepEqual(t.free_cancellation, { free: true, text: 'Cancel up to 24 hours in advance for a full refund', until_hours_before: 24 });
  assert.equal(new URL(t.book_url).searchParams.get('partner_id'), 'EDEN42');
  assert.equal(new URL(g.results[1].book_url).searchParams.get('partner_id'), 'OTHER'); // GYG's own partner id kept
  assert.equal(g.results[1].free_cancellation.free, false);
  // no stop: restaurants have nothing to link
  assert.equal(ot.on, false); assert.equal(tf.on, false);
  // cached: a second look fetches nothing
  const n = log.length;
  await activitiesOp(account(), 'trip-activities', { id: TID }, { fetch: fakeFetch(log), cache });
  assert.equal(log.length, n);
});

test('near a stop: Viator free-text on the stop’s name, GetYourGuide by coordinates; kind and free cancellation', async () => {
  const log = [];
  const r = await activitiesOp(account(), 'trip-activities', { id: TID, stop: 's-tower', kind: 'tours', free_cancel: true }, { fetch: fakeFetch(log), cache: memCache() });
  const ft = log.filter((x) => x.url.includes('/search/freetext'))[1];
  assert.equal(ft.body.searchTerm, 'Belém Tower tour');
  assert.deepEqual(ft.body.productFiltering, { destination: '538', dateRange: { from: '2026-11-28', to: '2026-11-28' }, flags: ['FREE_CANCELLATION'] });
  const gl = log.find((x) => x.url.includes('getyourguide'));
  assert.match(gl.url, /coordinates\[\]=38\.6916&coordinates\[\]=-9\.216&coordinates\[\]=3&/);
  assert.ok(!gl.url.includes('&q='));
  const g = r.partners[1];
  assert.deepEqual(g.results.map((x) => x.id), ['12345']); // Sintra: a day trip (a tour) but not free to cancel
});

test('a meal stop whose link is its OpenTable page: Book on OpenTable, nothing searched there', async () => {
  const r = await activitiesOp(account(), 'trip-activities', { id: TID, stop: 's-dinner' }, { fetch: fakeFetch([]), cache: memCache() });
  const ot = r.partners.find((p) => p.id === 'opentable');
  assert.equal(ot.on, true); assert.equal(ot.link_only, true);
  assert.equal(ot.results[0].book_url, 'https://www.opentable.com/r/taberna-x-lisboa');
  assert.equal(ot.results[0].book_label, 'Book on OpenTable');
  assert.equal(r.partners.find((p) => p.id === 'thefork').on, false);
  assert.equal(restaurantLink('https://www.thefork.co.uk/restaurant/x-r123')?.partner, 'thefork');
  assert.equal(restaurantLink('https://www.opentable.com/'), null); // the home page isn't a venue
  assert.equal(restaurantLink('https://opentable.com.evil.example/r/x'), null);
  assert.equal(restaurantLink('http://www.opentable.com/r/x'), null);
});

test('one partner failing doesn’t hide the other; the partner’s own words aren’t passed on; errors aren’t cached', async () => {
  const cache = memCache();
  const r = await activitiesOp(account(), 'trip-activities', { id: TID }, { fetch: fakeFetch([], { viator: { status: 401 } }), cache });
  const [v, g] = r.partners;
  assert.equal(v.code, 'not_set_up'); assert.equal(v.results.length, 0); assert.ok(!v.error.includes('secret'));
  assert.equal(g.results.length, 2);
  assert.ok(![...cache.m.keys()].some((k) => k.startsWith('act1:viator')));
  const r2 = await activitiesOp(account(), 'trip-activities', { id: TID }, { fetch: fakeFetch([], { gyg: { status: 429 } }), cache: memCache() });
  assert.equal(r2.partners[1].code, 'rate_limited');
});

test('sandbox and testing servers; destination without a trip; bad input', async () => {
  const log = [];
  const env = { ...ON, VIATOR_SANDBOX: '1', GYG_TESTING: '1', VIATOR_CAMPAIGN: 'trip-planner' };
  const r = await activitiesOp(account(env, null), 'trip-activities', { destination: 'Porto', date: '2026-12-01', currency: 'GBP' }, { fetch: fakeFetch(log), cache: memCache() });
  assert.ok(log.some((x) => x.url.startsWith('https://api.sandbox.viator.com/partner/search/freetext?campaign-value=trip-planner')));
  assert.ok(log.some((x) => x.url.startsWith('https://api.gygtest.net/1/tours?')));
  assert.equal(r.currency, 'GBP');
  assert.equal(r.partners[0].results[0].source, 'Viator (sandbox, test data)');
  const op = (b) => activitiesOp(account(), 'trip-activities', b, { fetch: fakeFetch([]), cache: memCache() });
  await assert.rejects(op({}), /Where\?/);
  await assert.rejects(op({ id: TID, stop: 's-nope' }), /no such stop/);
  await assert.rejects(op({ id: TID, kind: 'spa' }), /kind must be/);
  await assert.rejects(op({ id: TID, date: '28/11/2026' }), /YYYY-MM-DD/);
  await assert.rejects(op({ id: TID, date: new Date(T0 + (ACTIVITIES.daysAhead + 2) * 86400_000).toISOString().slice(0, 10) }), /a year ahead/);
  // a past date (a trip under way) looks from today
  const past = await op({ id: TID, date: '2026-10-01' });
  assert.equal(past.date, '2026-10-28');
});
