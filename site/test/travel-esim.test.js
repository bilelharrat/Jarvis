// Eden Travel mobile data (esim.js): Airalo and eSIM Go adapters in their documented shapes, off without keys, errors per
// partner, Airalo ordered only with the traveller's card held (pay.js), installation details kept on the trip. Fake fetches only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ESIM, airaloFor, countriesIn, esimFound, esimOp, esimPrice, esimgoFor, rank } from '../src/travel/esim.js';

const T0 = Date.parse('2026-10-28T12:00:00Z');
const TID = 'a1b2c3d4e5f60718';
const jsonRes = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const ON = { EDEN_ESIM: '1', AIRALO_CLIENT_ID: 'airalo-client-123', AIRALO_CLIENT_SECRET: 'airalo-secret-456', ESIMGO_API_KEY: 'esimgo-key-789' };

const trip = () => ({ id: TID, title: 'Iberia', destination: 'Lisbon, Portugal and Spain', start: '2026-11-28', budget: { amount: 900, currency: 'EUR' }, days: [{ stops: [] }, { stops: [] }, { stops: [] }, { stops: [] }, { stops: [] }] });
function account(env = ON, t = trip()) {
  const m = new Map([[`trip:${TID}`, t]]);
  const storage = {
    m,
    get: async (k) => (Array.isArray(k) ? new Map(k.map((x) => [x, m.get(x)])) : m.get(k)),
    put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) m.set(a, b); else m.set(k, v); },
    delete: async (k) => { for (const x of [].concat(k)) m.delete(x); },
    list: async ({ prefix }) => new Map([...m].filter(([k]) => k.startsWith(prefix))),
  };
  return { env, now: () => T0, storage };
}
function memCache() {
  const m = new Map();
  return { m, get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); } };
}

// Airalo's documented shapes (get-packages, submit-order examples)
const rrp = (usd, eur) => ({ net_price: { USD: usd / 2, EUR: eur / 2 }, recommended_retail_price: { USD: usd, EUR: eur } });
const PT = { slug: 'portugal', country_code: 'PT', title: 'Portugal', operators: [{ title: 'Eurolink', type: 'local', is_roaming: true, rechargeability: true, activation_policy: 'first-usage', is_kyc_verify: false, install_window_days: 180, coverages: [{ name: 'PT', networks: [{ name: 'MEO', types: ['4G'] }] }], countries: [{ country_code: 'PT', title: 'Portugal' }], packages: [
  { id: 'eurolink-7days-1gb', type: 'sim', price: 4.5, net_price: 1.4, amount: 1024, day: 7, is_unlimited: false, title: '1 GB - 7 days', data: '1 GB', prices: rrp(4.5, 3.87) },
  { id: 'eurolink-30days-5gb', type: 'sim', price: 12, amount: 5120, day: 30, is_unlimited: false, title: '5 GB - 30 days', data: '5 GB', prices: rrp(12, 10.3) },
  { id: 'eurolink-topup-1gb', type: 'topup', price: 4, amount: 1024, day: 7, title: 'top-up', data: '1 GB', prices: rrp(4, 3.4) },
] }] };
const ES = { slug: 'spain', country_code: 'ES', title: 'Spain', operators: [{ title: 'Kyc Co', type: 'local', is_kyc_verify: true, packages: [{ id: 'kyc-1', type: 'sim', price: 1, amount: 1024, day: 7, title: 'x', data: '1 GB', prices: rrp(1, 1) }] }] };
const EU = { slug: 'europe', country_code: '', title: 'Europe', operators: [{ title: 'EUconnect', type: 'global', is_roaming: true, rechargeability: true, install_window_days: 30, coverages: [], countries: [{ country_code: 'PT', title: 'Portugal' }, { country_code: 'ES', title: 'Spain' }, { country_code: 'FR', title: 'France' }], packages: [
  { id: 'eu-connect-in-7days-1gb', type: 'sim', price: 4, amount: 1024, day: 7, is_unlimited: false, title: '1 GB - 7 days', data: '1 GB', prices: rrp(4, 3.44) },
  { id: 'eu-connect-15days-unl', type: 'sim', price: 30, amount: 0, day: 15, is_unlimited: true, title: 'Unlimited - 15 days', data: 'Unlimited', is_fair_usage_policy: true, fair_usage_policy: 'Lower speed rate of 1 Mbps after 3 GB usage per day.', prices: rrp(30, 25.8) },
] }] };
const ASIA = { slug: 'asia', country_code: '', title: 'Asia', operators: [{ title: 'Asialink', type: 'global', countries: [{ country_code: 'JP' }], packages: [{ id: 'asia-1', type: 'sim', price: 5, amount: 1024, day: 7, title: '1 GB', data: '1 GB', prices: rrp(5, 4) }] }] };
const ORDER = { id: 9666, code: '20261028-009666', package_id: 'eu-connect-15days-unl', quantity: '1', type: 'sim', description: 'eden x', validity: 15, package: 'EUconnect-Unlimited - 15 Days', data: 'Unlimited', price: 30, currency: 'USD',
  manual_installation: '<p><b>eSIM name:</b> EUconnect</p><ol><li>Settings &gt; Cellular</li><li>Enter the SM-DP+ Address</li></ol>',
  installation_guides: { en: 'https://www.airalo.com/help/getting-started-with-airalo' },
  sims: [{ id: 11047, iccid: '8944465400003573253', lpa: 'RSP-3088.IDEMIA.IO', matching_id: 'YVTGM-5LZC6', qrcode: 'LPA:1$RSP-3088.IDEMIA.IO$YVTGM-5LZC6', qrcode_url: 'https://www.airalo.com/qr?expires=1&id=1&signature=x', direct_apple_installation_url: 'https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=LPA:1$RSP-3088.IDEMIA.IO$YVTGM-5LZC6', apn_type: 'manual', apn_value: 'globaldata', is_roaming: true, confirmation_code: null, msisdn: null }] };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function fakeFetch(log, { airalo = {}, esimgo = {} } = {}) {
  return async (url, init = {}) => {
    log.push({ url, init });
    if (url.startsWith('https://partners-api.airalo.com')) {
      if (url.endsWith('/v2/token')) return airalo.tokenStatus ? jsonRes({}, airalo.tokenStatus) : jsonRes({ data: { token_type: 'Bearer', expires_in: 31622400, access_token: `tok-${log.filter((x) => x.url.endsWith('/v2/token')).length}` }, meta: { message: 'success' } });
      if (airalo.reject && init.headers.Authorization === airalo.reject) return jsonRes({ meta: { message: 'Unauthenticated.' } }, 401);
      if (airalo.status) return jsonRes({ code: airalo.code, data: { secret: 'echo' }, meta: { message: 'secret echo' } }, airalo.status);
      if (url.includes('/v2/packages')) {
        if (url.includes('filter[type]=global')) return jsonRes({ data: { 1: EU, 2: ASIA }, meta: { message: 'success' } }); // page-2 style object
        if (url.includes('filter[country]=PT')) return jsonRes({ data: [PT], meta: { message: 'success' } });
        if (url.includes('filter[country]=ES')) return jsonRes({ data: [ES], meta: { message: 'success' } });
        return jsonRes({ data: [] });
      }
      if (url.endsWith('/v2/orders') && init.method === 'POST') return airalo.orderCode ? jsonRes({ code: airalo.orderCode, meta: { message: 'x' } }, 422) : jsonRes({ data: ORDER, meta: { message: 'success' } });
      if (url.includes('/v2/orders?')) return jsonRes({ data: airalo.found ? [{ ...ORDER, description: decodeURIComponent(url.split('filter[description]=')[1].split('&')[0]) }] : [] });
    }
    if (url.startsWith('https://www.airalo.com/qr')) return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    if (url.startsWith('https://api.esim-go.com/v2.5')) {
      if (esimgo.status) return jsonRes({ message: 'secret echo' }, esimgo.status);
      if (url.endsWith('/organisation')) return jsonRes({ organisations: [{ name: 'Eden', currency: 'USD', balance: 10000 }] });
      if (url.includes('/catalogue')) return jsonRes({ bundles: [
        { name: 'esim_1GB_7D_PT_V2', description: '1GB, 7 Days, Portugal', countries: [{ name: 'Portugal', iso: 'PT' }], dataAmount: 1000, duration: 7, unlimited: false, price: 1.52, autostart: true },
        { name: 'esim_EU_5GB', description: '5GB Europe', countries: [{ iso: 'PT' }], roamingEnabled: [{ iso: 'ES' }, { iso: 'FR' }], dataAmount: 5000, duration: 30, unlimited: false, price: 6 },
      ] });
    }
    throw new Error(`unexpected ${url}`);
  };
}

test('countries are read only from exact country names in the destination', () => {
  assert.deepEqual(countriesIn('Lisbon, Portugal and Spain'), ['PT', 'ES']);
  assert.deepEqual(countriesIn('London, UK'), ['GB']);
  assert.deepEqual(countriesIn('Paris'), []); // a city is not a country: nothing guessed
  assert.deepEqual(countriesIn('Georgia Aquarium, Atlanta'), []);
});

test('off without EDEN_ESIM or keys: each partner says why, no fetch', async () => {
  const log = [];
  for (const env of [{}, { EDEN_ESIM: '1' }, { ...ON, EDEN_ESIM: '0' }]) {
    const r = await esimOp(account(env), 'trip-esim', { id: TID }, { fetch: fakeFetch(log) });
    assert.equal(r.partners.length, 2);
    assert.ok(r.partners.every((p) => p.on === false && /isn’t switched on/.test(p.note) && p.checked_at));
  }
  assert.equal(log.length, 0);
  assert.equal(airaloFor({ EDEN_ESIM: '1', AIRALO_CLIENT_ID: 'x' }), null);
  assert.equal(esimgoFor({ EDEN_ESIM: '1' }), null);
});

test('trip-esim: Airalo packages for the trip countries, ranked, with source and checked_at', async () => {
  const log = [];
  const cache = memCache();
  const a = account();
  const r = await esimOp(a, 'trip-esim', { id: TID }, { fetch: fakeFetch(log), cache });
  assert.deepEqual(r.countries.map((c) => c.code), ['PT', 'ES']);
  assert.equal(r.countries_from, 'destination');
  assert.equal(r.days, 5);
  assert.equal(r.end, '2026-12-02');
  assert.equal(r.currency, 'EUR');
  const air = r.partners.find((p) => p.id === 'airalo');
  assert.equal(air.on, true);
  const ids = air.results.map((x) => x.id);
  assert.ok(!ids.includes('eurolink-topup-1gb') && !ids.includes('kyc-1') && !ids.includes('asia-1')); // top-ups, eKYC, other regions out
  // covers both countries first; of those, lasts the 5 days, then cheaper
  assert.deepEqual(ids.slice(0, 2), ['eu-connect-in-7days-1gb', 'eu-connect-15days-unl']);
  const eu = air.results[0];
  assert.deepEqual(eu.price, { amount: 3.44, currency: 'EUR', kind: 'retail' });
  assert.equal(eu.covers_all, true);
  assert.equal(eu.lasts_trip, true);
  assert.equal(eu.area, 'region');
  assert.equal(eu.install_within_days, 30);
  assert.equal(eu.source, 'Airalo');
  assert.equal(eu.checked_at, new Date(T0).toISOString());
  const unl = air.results[1];
  assert.equal(unl.unlimited, true);
  assert.equal(unl.data_mb, null);
  assert.match(unl.fair_use, /1 Mbps/);
  const pt = air.results.find((x) => x.id === 'eurolink-7days-1gb');
  assert.deepEqual(pt.covers_trip, ['PT']);
  assert.equal(pt.covers_all, false);
  assert.deepEqual(pt.networks, ['MEO']);
  // documented auth: form-encoded client credentials, then Bearer
  const tok = log.find((x) => x.url.endsWith('/v2/token'));
  assert.equal(tok.init.method, 'POST');
  assert.match(tok.init.body, /grant_type=client_credentials/);
  assert.match(tok.init.body, /client_id=airalo-client-123/);
  const pk = log.find((x) => x.url.includes('filter[country]=PT'));
  assert.equal(pk.init.headers.Authorization, 'Bearer tok-1');
  assert.ok(pk.url.includes('filter[type]=local') && pk.url.includes('limit=1000'));
  // eSIM Go: listed to compare; its price is Eden's cost, never a price
  const go = r.partners.find((p) => p.id === 'esimgo');
  assert.equal(go.on, true);
  const g1 = go.results.find((x) => x.id === 'esim_1GB_7D_PT_V2');
  assert.equal(g1.price, null);
  assert.deepEqual(g1.cost, { amount: 1.52, currency: 'USD', kind: 'cost' });
  assert.equal(g1.validity_days, 7); // the name says 7D
  assert.equal(g1.orderable, false);
  const g2 = go.results.find((x) => x.id === 'esim_EU_5GB');
  assert.equal(g2.validity_days, null); // no unit given and the name doesn't say
  assert.match(g2.duration_text, /doesn’t say/);
  assert.equal(g2.covers_all, true);
  assert.equal(log.find((x) => x.url.includes('esim-go')).init.headers['X-API-Key'], 'esimgo-key-789');
  // again: from the cache (results and token), no second call
  const n = log.length;
  await esimOp(a, 'trip-esim', { id: TID }, { fetch: fakeFetch(log), cache });
  assert.equal(log.length, n);
});

test('countries asked for win; unknown or missing countries are refused', async () => {
  const r = await esimOp(account({}), 'trip-esim', { id: TID, countries: ['pt'] }, {});
  assert.deepEqual(r.countries, [{ code: 'PT', name: 'Portugal' }]);
  assert.equal(r.countries_from, 'asked');
  await assert.rejects(esimOp(account({}), 'trip-esim', { id: TID, countries: ['XX'] }, {}), /ISO codes/);
  const t = { ...trip(), destination: 'Paris', title: 'Weekend' };
  await assert.rejects(esimOp(account({}, t), 'trip-esim', { id: TID }, {}), (e) => e.code === 'countries_needed');
});

test('one partner failing does not hide the other; its message is Eden’s own', async () => {
  const log = [];
  const r = await esimOp(account(), 'trip-esim', { id: TID }, { fetch: fakeFetch(log, { esimgo: { status: 500 } }) });
  const go = r.partners.find((p) => p.id === 'esimgo');
  assert.equal(go.code, 'unavailable');
  assert.ok(!/secret/.test(go.error));
  assert.ok(r.partners.find((p) => p.id === 'airalo').results.length > 0);
  const r2 = await esimOp(account(), 'trip-esim', { id: TID }, { fetch: fakeFetch([], { airalo: { status: 403, code: 89 } }) });
  const air = r2.partners.find((p) => p.id === 'airalo');
  assert.equal(air.code, 'not_set_up');
  assert.match(air.error, /server address/);
  const r3 = await esimOp(account(), 'trip-esim', { id: TID }, { fetch: fakeFetch([], { airalo: { status: 429 } }) });
  assert.equal(r3.partners.find((p) => p.id === 'airalo').code, 'rate_limited');
});

test('a token Airalo refuses is asked for again once', async () => {
  const log = [];
  const cache = memCache();
  cache.m.set('airtok1:airalo-clien', 'old-token');
  const c = airaloFor(ON, { fetch: fakeFetch(log, { airalo: { reject: 'Bearer old-token' } }), now: () => T0, cache });
  const list = await c.packages({ countries: ['PT'], currency: 'USD', days: 5 });
  assert.ok(list.length);
  assert.equal(log.filter((x) => x.url.endsWith('/v2/token')).length, 1);
  assert.equal(cache.m.get('airtok1:airalo-clien'), 'tok-1');
});

test('check, then order only with the card held; install details kept on the trip; never bought twice', async () => {
  const log = [];
  const a = account();
  const deps = { fetch: fakeFetch(log), cache: memCache() };
  await assert.rejects(esimOp(a, 'trip-esim-check', { id: TID, package_id: 'eu-connect-15days-unl' }, deps), (e) => e.code === 'check_expired'); // not shown yet
  await esimOp(a, 'trip-esim', { id: TID }, deps);
  const chk = await esimOp(a, 'trip-esim-check', { id: TID, package_id: 'eu-connect-15days-unl' }, deps);
  assert.equal(chk.pay_kind, 'esim');
  assert.deepEqual(chk.price, { amount: 25.8, currency: 'EUR', kind: 'retail' });
  assert.deepEqual(await esimPrice(a, { check_id: chk.check_id }), { cents: 2580, currency: 'EUR', title: 'eSIM: Unlimited - 15 days, Europe' });
  // without the hold, or a smaller one, or another currency: nothing bought
  for (const held of [undefined, { amount: 20, currency: 'EUR' }, { amount: 25.8, currency: 'USD' }]) {
    await assert.rejects(esimOp(a, 'trip-esim-order', { check_id: chk.check_id, held, confirm: true }, deps), (e) => e.code === 'pay_first');
  }
  await assert.rejects(esimOp(a, 'trip-esim-order', { check_id: chk.check_id, held: { amount: 25.8, currency: 'EUR' } }, deps), /confirm/);
  assert.equal(log.filter((x) => x.url.endsWith('/v2/orders')).length, 0);
  const out = await esimOp(a, 'trip-esim-order', { check_id: chk.check_id, held: { amount: 25.8, currency: 'EUR' }, confirm: true }, deps);
  assert.equal(out.order_id, '9666');
  const post = log.find((x) => x.url.endsWith('/v2/orders'));
  assert.ok(post.init.body instanceof FormData);
  assert.equal(post.init.body.get('package_id'), 'eu-connect-15days-unl');
  assert.equal(post.init.body.get('quantity'), '1');
  assert.equal(post.init.body.get('description'), `eden ${chk.check_id}`);
  const sim = out.esim.sims[0];
  assert.equal(sim.lpa, 'LPA:1$RSP-3088.IDEMIA.IO$YVTGM-5LZC6');
  assert.equal(sim.smdp, 'RSP-3088.IDEMIA.IO');
  assert.equal(sim.activation_code, 'YVTGM-5LZC6');
  assert.equal(sim.apn, 'globaldata');
  assert.match(sim.apple_url, /^https:\/\/esimsetup\.apple\.com\//);
  assert.match(out.esim.steps, /Settings > Cellular/);
  assert.equal(out.esim.install_by, '2026-11-27'); // 30 days from today
  assert.ok(out.esim.doc && /^d-/.test(out.esim.doc)); // the QR picture among the trip's documents
  assert.ok([...a.storage.m.keys()].some((k) => k.startsWith(`tdoc:${TID}:`)));
  const listed = await esimOp(a, 'trip-esims', { id: TID }, deps);
  assert.equal(listed.esims.length, 1);
  assert.equal(listed.esims[0].sims[0].iccid, '8944465400003573253');
  // asked again (pay.js and its sweep): the same answer, no second order
  const again = await esimOp(a, 'trip-esim-order', { check_id: chk.check_id, held: { amount: 25.8, currency: 'EUR' }, confirm: true }, deps);
  assert.equal(again.order_id, '9666');
  assert.equal(log.filter((x) => x.url.endsWith('/v2/orders')).length, 1);
  assert.equal(await esimPrice(a, { check_id: chk.check_id }), null); // the check is used up
  assert.equal((await esimFound(a, { check_id: chk.check_id }, deps)).booking, '9666');
});

test('Airalo code 83 (identical order a moment ago): the order is looked up, not bought again', async () => {
  const log = [];
  const a = account();
  const deps = { fetch: fakeFetch(log, { airalo: { orderCode: 83, found: true } }), cache: memCache() };
  await esimOp(a, 'trip-esim', { id: TID }, deps);
  const chk = await esimOp(a, 'trip-esim-check', { id: TID, package_id: 'eurolink-7days-1gb' }, deps);
  const out = await esimOp(a, 'trip-esim-order', { check_id: chk.check_id, held: { amount: 3.87, currency: 'EUR' }, confirm: true }, deps);
  assert.equal(out.order_id, '9666');
  assert.ok(log.some((x) => x.url.includes(`filter[description]=eden%20${chk.check_id}`)));
});

test('sold out at order: a clear error, nothing kept', async () => {
  const a = account();
  const deps = { fetch: fakeFetch([], { airalo: { orderCode: 34 } }), cache: memCache() };
  await esimOp(a, 'trip-esim', { id: TID }, deps);
  const chk = await esimOp(a, 'trip-esim-check', { id: TID, package_id: 'eurolink-7days-1gb' }, deps);
  await assert.rejects(esimOp(a, 'trip-esim-order', { check_id: chk.check_id, held: { amount: 3.87, currency: 'EUR' }, confirm: true }, deps), (e) => e.code === 'sold_out');
  assert.equal([...a.storage.m.keys()].filter((k) => k.startsWith('tesim:')).length, 0);
});

test('the sweep: an order Airalo has is found and kept; none means none', async () => {
  const a = account();
  const deps = { fetch: fakeFetch([], { airalo: { found: false } }), cache: memCache() };
  await esimOp(a, 'trip-esim', { id: TID }, deps);
  const chk = await esimOp(a, 'trip-esim-check', { id: TID, package_id: 'eurolink-7days-1gb' }, deps);
  assert.deepEqual(await esimFound(a, { check_id: chk.check_id }, deps), { state: 'none' });
  const found = await esimFound(a, { check_id: chk.check_id }, { ...deps, fetch: fakeFetch([], { airalo: { found: true } }) });
  assert.equal(found.state, 'made');
  assert.equal(found.booking, '9666');
  assert.ok(a.storage.m.get(`tesim:${TID}:9666`));
});

test('sandbox: results and eSIMs say test; no QR document', async () => {
  const a = account({ ...ON, AIRALO_SANDBOX: '1' });
  const deps = { fetch: fakeFetch([]), cache: memCache() };
  const r = await esimOp(a, 'trip-esim', { id: TID }, deps);
  assert.match(r.partners[0].results[0].source, /sandbox/);
  const chk = await esimOp(a, 'trip-esim-check', { id: TID, package_id: 'eurolink-7days-1gb' }, deps);
  const out = await esimOp(a, 'trip-esim-order', { check_id: chk.check_id, held: { amount: 3.87, currency: 'EUR' }, confirm: true }, deps);
  assert.equal(out.esim.test, true);
  assert.equal(out.esim.doc, undefined);
});

test('rank: all countries, then the whole trip, then price', () => {
  const p = (id, all, lasts, amount) => ({ id, covers_all: all, lasts_trip: lasts, price: { amount }, data_mb: 1024 });
  assert.deepEqual([p('a', false, true, 1), p('b', true, false, 1), p('c', true, true, 9), p('d', true, true, 5)].sort(rank).map((x) => x.id), ['d', 'c', 'b', 'a']);
  assert.equal(ESIM.resultsMs, 3600_000); // Airalo's docs: sync hourly
});
