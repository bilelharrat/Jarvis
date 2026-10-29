// Google spend (travel/spend.js): what each call costs by SKU, the caps (per open, per account a day, everyone a day),
// what the checks show past a cap (the last answer with its own checked_at, never as new), and the caching that keeps
// opening a trip again from paying Google again (checks.js FRESH, ops.js trip-get reuse).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tripOp } from '../src/travel/ops.js';
import { HELD, PRICE, placesSku, spendIndexOp, spendMeter, spendRead } from '../src/travel/spend.js';

const T0 = Date.parse('2026-10-28T12:00:00Z');
const H = 3600_000;
const TID = 'a1b2c3d4e5f60718';
const OWNER = '11111111-1111-4111-8111-111111111111';

function account({ env = {}, trip, id = TID } = {}) {
  const m = new Map();
  const clock = { t: T0 };
  const storage = {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, m.get(x)])) : m.get(k)),
    put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) m.set(a, b); else m.set(k, v); },
    delete: async (k) => { for (const x of [].concat(k)) m.delete(x); return true; },
    list: async ({ prefix, start }) => new Map([...m].filter(([k]) => k.startsWith(prefix) && (!start || k >= start)).sort(([a], [b]) => (a < b ? -1 : 1))),
    setAlarm: async () => {},
  };
  m.set('account', { id: OWNER });
  if (trip) m.set(`trip:${id}`, trip);
  return { m, storage, env: { GOOGLE_MAPS_SERVER_KEY: 'k', ...env }, now: () => clock.t, clock };
}

// Lisbon, like the sample trip, on (fake) Google places: three days from a hotel in Baixa, on foot, by tram and by taxi
const P = {
  air: ['ChIJairport001', 'Lisbon airport', 38.7742, -9.1342], hotel: ['ChIJhotelbaixa', 'Hotel in Baixa', 38.7118, -9.1384],
  jer: ['ChIJjeronimos1', 'Jerónimos Monastery', 38.6979, -9.2068], pas: ['ChIJpasteisbel', 'Pastéis de Belém', 38.6975, -9.2032],
  maat: ['ChIJmaatbelem1', 'MAAT', 38.6957, -9.1946], lx: ['ChIJlxfactory1', 'LX Factory', 38.7034, -9.1785],
  cas: ['ChIJcastlesj01', 'São Jorge Castle', 38.7139, -9.1335], gra: ['ChIJgracaview1', 'Miradouro da Graça', 38.7163, -9.1309],
  alf: ['ChIJalfamafood', 'A restaurant in Alfama', 38.7110, -9.1300], tile: ['ChIJtilemuseum', 'National Tile Museum', 38.7247, -9.1135],
  carmo: ['ChIJcarmoruins', 'Carmo Convent ruins', 38.7120, -9.1405], chi: ['ChIJchiadofood', 'A restaurant in Chiado', 38.7107, -9.1422],
};
let n = 0;
const stop = (k, at, mode, kind = 'visit', extra = {}) => ({ id: `s-${++n}`, kind, place: { id: P[k][0], name: P[k][1], lat: P[k][2], lng: P[k][3] }, at, minutes: 60, mode, cost: null, nights: null, link: null, booked: null, note: '', ...extra });
function lisbon() {
  return {
    title: 'Lisbon', destination: 'Lisbon', start: '2026-11-28', travelers: 2, budget: { amount: 900, currency: 'EUR' }, rev: 1, created: T0, updated: T0, access: null,
    days: [
      { title: 'Day 1', stops: [stop('air', '09:00', 'taxi', 'transport'), stop('hotel', '10:00', 'taxi', 'stay', { nights: 3 }), stop('carmo', '12:00', 'walk'), stop('chi', '13:30', 'walk', 'meal'), stop('cas', '16:00', 'transit')] },
      { title: 'Day 2', stops: [stop('jer', '10:00', 'transit'), stop('pas', '11:30', 'walk', 'meal'), stop('maat', '13:00', 'walk'), stop('lx', '15:00', 'taxi'), stop('chi', '20:00', 'taxi', 'meal')] },
      { title: 'Day 3', stops: [stop('tile', '10:00', 'transit'), stop('gra', '12:30', 'taxi'), stop('alf', '13:30', 'walk', 'meal'), stop('cas', '15:30', 'walk')] },
    ],
  };
}

const json = (b) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
function fakeGoogle() {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ u, mask: init.headers?.['X-Goog-FieldMask'], body: init.body ? JSON.parse(init.body) : null });
    if (u.includes('computeRoutes')) return json({ routes: [{ duration: '600s', distanceMeters: 1200 }] });
    const id = u.split('/places/')[1];
    const p = Object.values(P).find((x) => x[0] === id);
    if (!p) return new Response('{}', { status: 404 });
    return json({ id, displayName: { text: p[1] }, formattedAddress: 'Lisboa', location: { latitude: p[2], longitude: p[3] }, businessStatus: 'OPERATIONAL', regularOpeningHours: { periods: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ open: { day, hour: 8, minute: 0 }, close: { day, hour: 23, minute: 0 } })) }, accessibilityOptions: { wheelchairAccessibleEntrance: true } });
  };
  return { calls, fetch, places: () => calls.filter((c) => c.u.includes('/places/')).length, routes: () => calls.filter((c) => c.u.includes('computeRoutes')).length };
}

// ten opens over three days: a burst, then the next morning and two more days
const OPENS = [0, 1 / 60, 5 / 60, 0.5, 2, 7, 13, 26, 50, 75].map((h) => T0 + h * H);

test('opening the Lisbon trip ten times over three days: far fewer paid Google calls than before', async () => {
  const a = account({ trip: lisbon() });
  const g = fakeGoogle();
  for (const t of OPENS) {
    a.clock.t = t;
    const { checks } = await tripOp(a, 'trip-get', { id: TID }, { fetch: g.fetch });
    assert.equal(checks.spend, undefined, 'no cap reached');
    assert.equal(checks.days[0].stops[2].badges.hours.status, 'ok');
  }
  const total = g.calls.length;
  // Measured with the modules before this change (place answers kept a day, every leg six hours, no reuse), the
  // same ten opens made 144 calls: 48 Place Details (12 places × 4) and 96 computeRoutes (16 legs × 6).
  // Now: each place once (hours of a visit a month away keep 7 days), walking legs once, transit legs a day, taxi
  // legs six hours.
  assert.equal(g.places(), 12);
  assert.ok(total <= 60, `paid calls: ${total}`);
  assert.ok(total < 144 / 2, 'under half of before');
  // the account's spend counted by SKU
  const days = await spendRead(a);
  assert.equal(days.reduce((t, d) => t + (d.counts.details_ent || 0), 0), 12);
  assert.equal(days.reduce((t, d) => t + Object.values(d.counts).reduce((x, y) => x + y, 0), 0), total);
  console.log(`travel-spend: 10 opens → ${total} paid calls (${g.places()} places, ${g.routes()} routes), $${days.reduce((t, d) => t + d.usd, 0).toFixed(3)} at list price; before: 144`);
});

test('the same trip opened again within ten minutes: the same checks, no lookups; a change checks again', async () => {
  const a = account({ trip: lisbon() });
  const g = fakeGoogle();
  const first = (await tripOp(a, 'trip-get', { id: TID }, { fetch: g.fetch })).checks;
  const calls = g.calls.length;
  a.clock.t += 9 * 60_000;
  const again = (await tripOp(a, 'trip-get', { id: TID }, { fetch: g.fetch })).checks;
  assert.equal(again.checked_at, first.checked_at, 'reused checks keep when they were checked');
  a.clock.t += 2 * 60_000;
  const later = (await tripOp(a, 'trip-get', { id: TID }, { fetch: g.fetch })).checks;
  assert.notEqual(later.checked_at, first.checked_at);
  assert.equal(g.calls.length, calls, 'and the lookups behind them were still fresh');
  const t = a.m.get(`trip:${TID}`);
  t.days[0].stops[2].at = '12:30'; // changed without a rev bump: the content key still sees it
  a.clock.t += 60_000;
  const changed = (await tripOp(a, 'trip-get', { id: TID }, { fetch: g.fetch })).checks;
  assert.notEqual(changed.checked_at, later.checked_at);
});

test('past the account’s daily cap: last answers with their own checked_at, held, and a note; never as new', async () => {
  const a = account({ trip: lisbon(), env: { TRAVEL_GOOGLE_ACCOUNT_USD: '0.5' } });
  const g = fakeGoogle();
  await tripOp(a, 'trip-get', { id: TID }, { fetch: g.fetch });
  const firstAt = new Date(T0).toISOString();
  // eight days on (hours due again), and the account already spent its day
  a.clock.t = T0 + 8 * 24 * H;
  const day = new Date(a.clock.t).toISOString().slice(0, 10);
  a.m.set(`tspend:${day}`, { counts: { details_ent: 25 }, usd: 0.5 });
  const before = g.calls.length;
  const { checks } = await tripOp(a, 'trip-get', { id: TID }, { fetch: g.fetch });
  assert.equal(g.calls.length, before, 'no paid call');
  const hours = checks.days[1].stops[0].badges.hours;
  assert.equal(hours.checked_at, firstAt);
  assert.equal(hours.held, 'account');
  assert.equal(hours.status, 'ok');
  assert.equal(checks.spend.reason, 'account');
  assert.equal(checks.spend.note, HELD.account);
  // not kept for reuse: the next day checks again
  a.clock.t += 24 * H;
  const next = (await tripOp(a, 'trip-get', { id: TID }, { fetch: g.fetch })).checks;
  assert.equal(next.spend, undefined);
  assert.notEqual(next.days[1].stops[0].badges.hours.checked_at, firstAt);
});

test('never checked and held back: the place says so, a leg is a straight-line sample', async () => {
  const a = account({ trip: lisbon(), env: { TRAVEL_GOOGLE_ACCOUNT_USD: '0.0001' } });
  const g = fakeGoogle();
  const { checks } = await tripOp(a, 'trip-get', { id: TID }, { fetch: g.fetch });
  assert.equal(g.calls.length, 0);
  const s = checks.days[0].stops[2];
  assert.equal(s.badges.hours.status, 'unknown');
  assert.equal(s.badges.hours.held, 'account');
  assert.equal(s.badges.travel.status, 'sample');
  assert.match(s.badges.travel.source, /straight-line estimate: not checked/);
  assert.equal(s.badges.travel.held, 'account');
});

test('the per-open cap: part checked now, the rest on the next open', async () => {
  const a = account({ trip: lisbon(), env: { TRAVEL_GOOGLE_OPEN_USD: '0.1' } });
  const g = fakeGoogle();
  const one = (await tripOp(a, 'trip-get', { id: TID }, { fetch: g.fetch })).checks;
  assert.equal(one.spend.reason, 'open');
  assert.equal(one.spend.note, HELD.open);
  const firstCalls = g.calls.length;
  assert.ok(firstCalls > 0 && firstCalls <= 10, `${firstCalls}`);
  let checks = one;
  for (let i = 0; i < 10 && checks.spend; i++) checks = (await tripOp(a, 'trip-get', { id: TID }, { fetch: g.fetch })).checks;
  assert.equal(checks.spend, undefined, 'all checked after a few opens');
  assert.ok(g.calls.length > firstCalls);
});

test('the global daily cap (the shared counter): only cached answers past it', async () => {
  const a = account({ trip: lisbon() });
  const g = fakeGoogle();
  const global = account({});
  global.m.delete('account'); // the shared object has no account record
  let usd = 0;
  const take = async (day, sku, n, cap) => spendIndexOp(global, 'tspend-take', { day, sku, n, cap }).then((r) => { usd = r.usd; return r; });
  const meter = spendMeter(a, { caps: { openUsd: 0, accountUsd: 0, globalUsd: 0.1 }, global: take });
  const { checks } = await tripOp(a, 'trip-get', { id: TID }, { fetch: g.fetch, meter });
  assert.equal(checks.spend.reason, 'global');
  assert.ok(usd <= 0.1 && usd > 0.05, `${usd}`);
  const read = await spendIndexOp(global, 'tspend-read', {});
  assert.equal(read.days[0].usd, usd);
  assert.deepEqual(Object.keys(read.days[0].counts).sort(), Object.keys(read.days[0].counts).filter((k) => k in PRICE).sort(), 'counts by SKU only');
  await assert.rejects(spendIndexOp(a, 'tspend-take', { day: '2026-10-28', sku: 'routes_ess', n: 1, cap: 1 }), /Not found/, 'never in a person’s object');
  await assert.rejects(spendIndexOp(global, 'tspend-take', { day: 'x', sku: 'routes_ess', n: 1, cap: 1 }), /tspend-take/);
});

test('which SKU a field mask is billed at', () => {
  assert.equal(placesSku('details', 'id,displayName,formattedAddress,location,businessStatus,regularOpeningHours,utcOffsetMinutes,priceLevel,googleMapsUri,photos,accessibilityOptions,websiteUri'), 'details_ent');
  assert.equal(placesSku('details', 'id,displayName,formattedAddress,location,googleMapsUri,accessibilityOptions'), 'details_pro');
  assert.equal(placesSku('details', 'id,photos'), 'details_ids');
  assert.equal(placesSku('details', 'id,location'), 'details_ess');
  assert.equal(placesSku('text', 'places.id,places.location'), 'text_pro');
  assert.equal(placesSku('text', 'places.id,places.rating,places.editorialSummary'), 'text_atmo');
  assert.equal(placesSku('nearby', 'places.id,places.currentOpeningHours.openNow'), 'nearby_ent');
  assert.equal(placesSku('details', 'id,somethingNew'), 'details_ent', 'an unknown field is never counted cheap');
});

test('the stable part of a place is asked alone when only it is due (Pro, not Enterprise)', async () => {
  const a = account({ trip: lisbon() });
  const g = fakeGoogle();
  await tripOp(a, 'trip-get', { id: TID }, { fetch: g.fetch });
  // hours stay fresh, the stable part is made old
  for (const [k, v] of a.m) if (k.startsWith('tcache:ps2:')) v.at -= 31 * 24 * H;
  a.clock.t += 20 * 60_000;
  const before = g.calls.length;
  await tripOp(a, 'trip-get', { id: TID }, { fetch: g.fetch });
  const asked = g.calls.slice(before).filter((c) => c.u.includes('/places/'));
  assert.equal(asked.length, 12);
  assert.ok(asked.every((c) => placesSku('details', c.mask) === 'details_pro'));
});

test('the Worker’s photo and map calls: the global cap only', async () => {
  const { globalMeter } = await import('../src/travel/spend.js');
  const { placePhoto } = await import('../src/travel/maps.js');
  const global = account({});
  global.m.delete('account');
  const env = { GOOGLE_MAPS_SERVER_KEY: 'k', TRAVEL_GOOGLE_DAILY_USD: '0.007', ACCOUNTS: { idFromName: (x) => x, get: () => ({ fetch: async (url, init) => json(await spendIndexOp(global, new URL(url).pathname.slice(1), JSON.parse(init.body))) }) } };
  let fetched = 0;
  const fetch = async () => { fetched++; return new Response('img', { headers: { 'content-type': 'image/jpeg' } }); };
  const url = new URL('https://x/api/chat/travel/photo?n=places/ChIJabcdefghij/photos/AbCdEfGhIjKl&w=240');
  await placePhoto(env, url, { fetch, meter: globalMeter(env) });
  await assert.rejects(placePhoto(env, url, { fetch, meter: globalMeter(env) }), (e) => e.code === 'capped');
  assert.equal(fetched, 1);
});
