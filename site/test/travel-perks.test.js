// Plus perks (src/travel/companions.js, yearinreview.js, cardperk.js): what Plus covers for the people on a trip and the
// members' own flight alerts (consent on both sides, nothing beyond the trip), the year in travel (every figure with its
// basis, money never summed across currencies without a dated ECB rate), and the best card for each booking (rate, source,
// date, dollars converted at a stated rate). Fakes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COVERS, coversMemberOp, coversOp, companionsApi, joinedAlertsOp, memberFlightNews, ALERTS } from '../src/travel/companions.js';
import { yearOf, yearOp, placesIn } from '../src/travel/yearinreview.js';
import { cardPerk, cardPerkOp, perkTrip, portalBetter } from '../src/travel/cardperk.js';
import { tripRewards } from '../src/travel/cards.js';
import { checkSnapshot } from '../src/travel/accuracy.js';

const T0 = Date.parse('2026-10-28T12:00:00Z');
const OWNER = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const TID = 'a1b2c3d4e5f60718';
const TID2 = 'b1b2c3d4e5f60718';
const TID3 = 'c1b2c3d4e5f60718';

function account(id = OWNER, now = T0) {
  const m = new Map();
  const storage = {
    get: async (k) => m.get(k),
    put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) m.set(a, b); else m.set(k, v); },
    delete: async (k) => { for (const x of [].concat(k)) m.delete(x); return true; },
    list: async ({ prefix }) => new Map([...m].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  m.set('account', { id });
  return { m, storage, env: {}, now: () => now };
}
const stop = (id, name, extra = {}) => ({ id, kind: 'visit', place: { id: null, name, lat: null, lng: null }, at: '10:00', minutes: 60, mode: 'walk', cost: null, nights: null, link: null, booked: null, note: '', ...extra });
const BOOKED = { kind: 'x', ref: 'R', provider: 'P', via: 'person', at: 0 };
function trip(o = {}) {
  return {
    title: 'Lisbon', destination: 'Lisbon, Portugal', start: '2026-05-01', travelers: 2, budget: { amount: 900, currency: 'EUR' }, rev: 1, created: 0, updated: 0, access: null,
    days: [
      { title: 'Arrive', stops: [
        stop('s-fl', 'TP1351 LHR → LIS', { kind: 'transport', booked: BOOKED, cost: { amount: 200, currency: 'USD' } }),
        stop('s-h', 'Hotel Baixa', { kind: 'stay', nights: 2, place: { id: null, name: 'Hotel Baixa', lat: 38.7118, lng: -9.1384 }, booked: BOOKED, cost: { amount: 300, currency: 'EUR' } }),
      ] },
      { title: 'Belém', stops: [stop('s-j', 'Jerónimos', { place: { id: null, name: 'Jerónimos', lat: 38.6979, lng: -9.2068 } }), stop('s-d', 'Dinner at Tasca', { kind: 'meal', cost: { amount: 60, currency: 'EUR' } })] },
      { title: 'Leave', stops: [] },
    ],
    ...o,
  };
}

/* ---------- Plus covers your companions ---------- */

test('covers: every member feature is listed with how it is covered; the gaps say so', () => {
  const keys = COVERS.map((c) => c.key);
  for (const k of ['trip', 'suggest', 'chat', 'money', 'discover', 'presence', 'memories', 'alerts', 'copy', 'pictures', 'book']) assert.ok(keys.includes(k), k);
  assert.equal(COVERS.find((c) => c.key === 'copy').covered, 'own');
  assert.equal(COVERS.find((c) => c.key === 'pictures').gap, true);
  for (const c of COVERS) assert.ok(['yes', 'shared', 'opt_in', 'own', 'no'].includes(c.covered) && c.how.length > 10);
});

test('covers: a member sees memories on only while shared, alerts only when they turned them on', async () => {
  const a = account();
  a.m.set(`trip:${TID}`, trip());
  a.m.set(`tmem:${TID}:${MEMBER}`, { member: MEMBER, name: 'Sam', joined: 0 });
  let r = await coversMemberOp(a, 'tmember-covers', { trip: TID, member: MEMBER });
  assert.equal(r.covers.find((c) => c.key === 'memories').on, false);
  assert.equal(r.covers.find((c) => c.key === 'alerts').on, false);
  a.m.set(`tmemo:${TID}`, { share: true });
  await coversMemberOp(a, 'tmember-alerts', { trip: TID, member: MEMBER, on: true });
  r = await coversMemberOp(a, 'tmember-covers', { trip: TID, member: MEMBER });
  assert.equal(r.covers.find((c) => c.key === 'memories').on, true);
  assert.equal(r.alerts, true);
  await assert.rejects(coversMemberOp(a, 'tmember-covers', { trip: TID, member: OTHER }), /not on this trip/);
  const org = await coversOp(a, 'trip-plus-covers', { id: TID });
  assert.deepEqual(org.members, [{ name: 'Sam', alerts: true }]);
  assert.equal(org.memories_shared, true);
});

test('tmember-read: the trip with no checks run, and the money as this member sees it', async () => {
  const a = account();
  a.m.set(`trip:${TID}`, trip());
  a.m.set(`tmem:${TID}:${MEMBER}`, { member: MEMBER, name: 'Sam', joined: 0 });
  const calls = [];
  const tripOp = async (_a, op, body, deps) => { calls.push([op, body, deps]); return { currency: 'EUR', total: 10 }; };
  const r = await coversMemberOp(a, 'tmember-read', { trip: TID, member: MEMBER }, { tripOp });
  assert.equal(r.trip.id, TID);
  assert.deepEqual(calls.map((c) => c[0]), ['trip-money']);
  assert.equal(calls[0][2].by, MEMBER);
});

test('member flight alerts: only members who opted in, only while the organiser has Plus, consent checked on the member side', async () => {
  const org = account();
  org.m.set(`tmem:${TID}:${MEMBER}`, { member: MEMBER, name: 'Sam', alerts: true });
  org.m.set(`tmem:${TID}:${OTHER}`, { member: OTHER, name: 'Jo' });
  const mem = account(MEMBER);
  mem.m.set(`tjoin:${OWNER}:${TID}`, { owner: OWNER, trip: TID, title: 'Lisbon', alerts: true });
  const pushed = [];
  const notify = async (_a, p) => { pushed.push(p); return 1; };
  const asks = [];
  const ask = async (_env, name, op, body) => { asks.push(name); assert.equal(name, MEMBER); return joinedAlertsOp(mem, op, body, { notify }); };
  const f = { trip: TID, stop: 's-fl', ident: 'TP1351' };
  const news = [{ title: 'TP1351: gate changed to 12', body: 'Was gate 9. Now leaves 10:05.' }];
  assert.equal(await memberFlightNews(org, f, news, { plus: false, ask }), 0);
  assert.equal(await memberFlightNews(org, f, news, { ask }), 1);
  assert.deepEqual(asks, [MEMBER]);
  assert.equal(pushed.length, 1);
  assert.match(pushed[0].body, /^Lisbon: Was gate 9/);
  assert.deepEqual(pushed[0].data, { kind: 'flight', ident: 'TP1351', shared: { owner: OWNER, trip: TID } });
  // nothing of the organiser's beyond the flight change: no booking reference, no other fields
  assert.deepEqual(Object.keys(pushed[0]).sort(), ['body', 'data', 'title']);
  // the member turned them off on their side: nothing pushed even though the organiser still asks
  await joinedAlertsOp(mem, 'trip-joined-alerts', { owner: OWNER, trip: TID, on: false });
  await memberFlightNews(org, f, news, { ask });
  assert.equal(pushed.length, 1);
  // a member who left (no pointer): nothing
  mem.m.delete(`tjoin:${OWNER}:${TID}`);
  assert.deepEqual(await joinedAlertsOp(mem, 'tjoin-flight-news', { owner: OWNER, trip: TID, title: 'x', body: 'y' }, { notify }), { sent: 0, reason: 'off' });
});

test('member flight alerts: a daily cap on the member side', async () => {
  const mem = account(MEMBER);
  mem.m.set(`tjoin:${OWNER}:${TID}`, { owner: OWNER, trip: TID, title: 'Lisbon', alerts: true });
  let n = 0;
  const notify = async () => { n++; return 1; };
  for (let i = 0; i < ALERTS.perDay + 3; i++) await joinedAlertsOp(mem, 'tjoin-flight-news', { owner: OWNER, trip: TID, title: 'TP1 delayed', body: 'x' }, { notify });
  assert.equal(n, ALERTS.perDay);
});

test('shared-alerts: consent saved on the member first, undone if the organiser refuses', async () => {
  const calls = [];
  const call = async (_env, acct, op, body) => { calls.push([acct, op, body.on]); return { alerts: body.on }; };
  const ok = await companionsApi({}, { account: MEMBER, token: 't' }, 'shared-alerts', { owner: OWNER, trip: TID, on: true }, { call, ask: async () => ({ alerts: true }) });
  assert.deepEqual(ok, { alerts: true });
  assert.deepEqual(calls, [[MEMBER, 'trip-joined-alerts', true]]);
  calls.length = 0;
  await assert.rejects(companionsApi({}, { account: MEMBER, token: 't' }, 'shared-alerts', { owner: OWNER, trip: TID, on: true }, { call, ask: async () => { throw new Error('not on this trip'); } }));
  assert.deepEqual(calls.map((c) => c[2]), [true, false]);
});

/* ---------- Your year in travel ---------- */

test('places: countries only where named, the rest are cities', () => {
  const p = placesIn('Lisbon, Porto & Portugal');
  assert.deepEqual(p.cities, ['Lisbon', 'Porto']);
  assert.deepEqual(p.countries.map((c) => c.code), ['PT']);
  assert.deepEqual(placesIn('Tokyo / UK').countries.map((c) => c.code), ['GB']);
});

test('year: taken vs still to come, days in the year only, straight-line km labelled, flights from the plan', () => {
  const nye = trip({ title: 'New Year', destination: 'Paris, France', start: '2026-12-30', days: [{ title: 'a', stops: [] }, { title: 'b', stops: [] }, { title: 'c', stops: [] }, { title: 'd', stops: [] }] });
  const now = Date.parse('2027-02-01T00:00:00Z');
  const y = yearOf(2026, [{ id: TID, trip: trip() }, { id: TID2, trip: nye }, { id: TID3, trip: trip({ start: '2025-06-01' }) }], {}, { now });
  assert.equal(y.stats.trips, 2);
  assert.equal(y.stats.days_away, 3 + 2); // Lisbon 3 days, New Year only Dec 30 and 31
  assert.equal(y.stats.km_method, 'straight_line');
  assert.ok(y.stats.km > 5 && y.stats.km < 10); // Baixa → Jerónimos, about 6.5 km
  assert.equal(y.stats.flights, 1);
  assert.equal(y.stats.flights_booked, 1);
  assert.deepEqual(y.stats.countries.map((c) => c.code).sort(), ['FR', 'PT']);
  assert.equal(y.stats.nights, 2 + 3); // Lisbon from its stay, New Year from its days
  const early = yearOf(2026, [{ id: TID2, trip: nye }], {}, { now: T0 });
  assert.equal(early.stats.trips, 0);
  assert.equal(early.upcoming.length, 1);
  assert.equal(y.private, true);
});

test('year: money per currency, one total only at a dated ECB rate, your share beside it', () => {
  const now = Date.parse('2027-01-10T00:00:00Z');
  const e = (id, cur, total, mine) => ({ id, trip: trip({ start: '2026-03-01' }), money: { currency: cur, total, you: OWNER, shares: [{ id: OWNER, amount: mine }] } });
  let y = yearOf(2026, [e(TID, 'EUR', 800, 400), e(TID2, 'GBP', 300, 150)], {}, { now });
  assert.deepEqual(y.money.currencies.map((c) => [c.currency, c.total, c.yours]), [['EUR', 800, 400], ['GBP', 300, 150]]);
  assert.equal(y.money.converted, null); // no rates: never summed
  y = yearOf(2026, [e(TID, 'EUR', 800, 400), e(TID2, 'GBP', 300, 150)], { fx: { base: 'EUR', date: '2027-01-09', rates: { GBP: 0.5 }, source: 'ECB' } }, { now });
  assert.equal(y.money.converted.total, 1400);
  assert.equal(y.money.converted.yours, 700);
  assert.equal(y.money.converted.date, '2027-01-09');
  // a currency the rates don't have: no total
  y = yearOf(2026, [e(TID, 'EUR', 800, 400), e(TID2, 'XYZ', 300, 150)], { fx: { base: 'EUR', date: '2027-01-09', rates: { GBP: 0.5 } } }, { now });
  assert.equal(y.money.converted, null);
});

test('year op: own and shared trips, drops found vs saved, checks from snapshots, reports, card estimate', async () => {
  const a = account(OWNER, Date.parse('2026-10-28T12:00:00Z'));
  a.m.set(`trip:${TID}`, trip());
  a.m.set(`trip:${TID2}`, trip({ start: '2025-05-01' }));
  a.m.set('tcards', ['Chase Sapphire Reserve']);
  a.m.set(`tjoin:${OTHER}:${TID3}`, { owner: OTHER, trip: TID3, title: 'Shared' });
  a.m.set(`tjoin:${MEMBER}:${TID2}`, { owner: MEMBER, trip: TID2, title: 'Gone' });
  a.m.set('stbk:b1', { trip: TID, currency: 'EUR', drop: { by: '25.00' }, accommodation: { name: 'Hotel Baixa' } });
  a.m.set('tsaved:x', { amount: 25, currency: 'EUR', at: Date.parse('2026-04-10T00:00:00Z'), what: 'Hotel Baixa' });
  a.m.set('tacr:r1', { at: Date.parse('2026-05-02T00:00:00Z') });
  const checks = { maps: 'google', days: [{ day: 1, date: '2026-05-02', stops: [{ stop: 's-j', badges: { hours: { status: 'ok', source: 'Google Maps (Places API)' }, travel: { status: 'warn', source: 'Google Maps (Routes API)' } } }] }] };
  a.m.set(`tacsnap:${TID}`, { snap: checkSnapshot(trip(), checks) });
  const ask = async (_env, owner, op, body) => {
    assert.equal(op, 'tmember-read');
    assert.equal(body.member, OWNER);
    if (owner === MEMBER) throw new Error('not on this trip');
    return { trip: { id: TID3, ...trip({ title: 'Shared one', destination: 'Rome, Italy', start: '2026-07-01' }) }, money: { currency: 'EUR', total: 90, shares: [{ id: OWNER, amount: 30 }] } };
  };
  const tripOp = async (_a, op) => { assert.equal(op, 'trip-money'); return { currency: 'EUR', total: 560, you: OWNER, shares: [{ id: OWNER, amount: 280 }] }; };
  const fetch = async (url) => { assert.match(String(url), /frankfurter\.dev\/v1\/latest\?base=USD/); return { ok: true, json: async () => ({ date: '2026-10-27', rates: { EUR: 0.8 } }) }; };
  const y = await yearOp(a, 'trip-year', { year: 2026 }, { tripOp, ask, fetch });
  assert.equal(y.stats.trips, 2);
  assert.equal(y.stats.shared_trips, 1);
  assert.equal(y.unavailable_shared, 1);
  assert.deepEqual(y.money.currencies.map((c) => [c.currency, c.total, c.yours]), [['EUR', 650, 310]]);
  assert.deepEqual(y.savings.drops_found, [{ currency: 'EUR', amount: 25, found: 1 }]);
  assert.deepEqual(y.savings.saved, [{ currency: 'EUR', amount: 25, count: 1 }]);
  assert.deepEqual([y.checks.shown, y.checks.flagged, y.checks.reported_wrong], [2, 1, 1]);
  // booked stops: the flight (USD 200 × 4) and the hotel (EUR 300 → USD 375 × 4); the dinner wasn't booked
  assert.equal(y.card_estimate.stops, 2);
  assert.deepEqual(y.card_estimate.totals, [{ unit: 'Chase Ultimate Rewards points', points: 800 + 1500, stops: 2 }]);
  assert.equal(y.card_estimate.fx.date, '2026-10-27');
  assert.equal(y.points, null);
  await assert.rejects(yearOp(a, 'trip-year', { year: 2030 }, {}), /year/);
});

test('year op: points from rewards.js when it is handed in', async () => {
  const a = account();
  const y = await yearOp(a, 'trip-year', {}, { rewards: async (_a, year) => ({ points: [{ unit: 'Eden points', amount: 120 }], source: 'rewards.js', year }) });
  assert.equal(y.year, 2026);
  assert.deepEqual(y.points.points, [{ unit: 'Eden points', amount: 120 }]);
});

/* ---------- Best card for each booking ---------- */

test('card perk: the best card per booking, points per dollar, source and date, converted at a stated rate', () => {
  // a flight named by its number counts as a flight (cards.js reads the flight number and airport codes: 4x, not 1x)
  assert.equal(tripRewards(trip(), ['Sapphire Reserve'], T0).find((r) => r.stop === 's-fl').category, 'flight');
  const rewards = tripRewards(perkTrip(trip()), ['Sapphire Reserve', 'Venture X', 'My store card'], T0);
  assert.equal(rewards.find((r) => r.stop === 's-fl').category, 'flight');
  const fx = { date: '2026-10-27', rates: { EUR: 0.8, USD: 1 }, source: 'European Central Bank reference rates (via Frankfurter)', checked_at: 'x' };
  const p = cardPerk(rewards, fx, { now: T0 });
  const by = Object.fromEntries(p.items.map((i) => [i.stop, i]));
  assert.equal(by['s-fl'].card, 'Chase Sapphire Reserve');
  assert.equal(by['s-fl'].points, 800);
  assert.equal(by['s-fl'].converted, null);
  assert.equal(by['s-h'].usd, 375);
  assert.equal(by['s-h'].points, 1500);
  assert.deepEqual(by['s-h'].converted, { from: 'EUR', rate: 0.8, date: '2026-10-27', source: fx.source });
  assert.match(by['s-h'].source, /^https:\/\/creditcards\.chase\.com/);
  assert.equal(by['s-h'].checked, '2026-10-26');
  // CSR states 1 cent a point through Chase Travel: the value back says on what terms
  assert.equal(by['s-fl'].back, 8);
  assert.match(by['s-fl'].back_how, /Chase Travel/);
  assert.ok(p.totals.length >= 1);
  assert.ok(p.fx && p.fx.date === '2026-10-27');
  // no rates: the card and rate, no points
  const q = cardPerk(rewards, null, { now: T0 });
  const h = q.items.find((i) => i.stop === 's-h');
  assert.equal(h.points, null);
  assert.match(h.why, /EUR/);
});

test('card perk: portal offers only where they apply to the category', () => {
  assert.equal(portalBetter('capital-one-venture-x', 'hotel', 2).rate, 10);
  assert.equal(portalBetter('capital-one-venture-x', 'flight', 2).rate, 5);
  assert.equal(portalBetter('capital-one-venture-x', 'dining', 2), null);
  assert.equal(portalBetter('chase-sapphire-reserve', 'flight', 4).rate, 8);
  assert.equal(portalBetter('amex-gold', 'flight', 3), null);
});

test('card perk op: one stop for the pay step; nothing without cards', async () => {
  const a = account();
  a.m.set(`trip:${TID}`, trip());
  let r = await cardPerkOp(a, 'trip-card-perk', { id: TID });
  assert.equal(r.cards, 0);
  assert.deepEqual(r.items, []);
  a.m.set('tcards', ['Amex Gold']);
  let fetched = 0;
  r = await cardPerkOp(a, 'trip-card-perk', { id: TID, stop: 's-fl' }, { fetch: async () => { fetched++; return { ok: false }; } });
  assert.equal(fetched, 0); // a dollar price needs no rates
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].card, 'American Express Gold Card');
  assert.equal(r.items[0].points, 600);
  // the quote's price, not the plan's
  r = await cardPerkOp(a, 'trip-card-perk', { id: TID, stop: 's-fl', cost: { amount: 250, currency: 'USD' } });
  assert.equal(r.items[0].points, 750);
  await assert.rejects(cardPerkOp(a, 'trip-card-perk', { id: TID, stop: 's-fl', cost: { amount: -1 } }), /cost/);
  await assert.rejects(cardPerkOp(a, 'trip-card-perk', { id: 'nope' }), /trip id/);
});
