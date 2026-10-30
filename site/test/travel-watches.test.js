// Eden Travel's watches beyond flight status: the flight price watch (src/travel/fpwatch.js, a fake Duffel in Duffel's
// own answer shape), booking-window reminders (src/travel/reminders.js) and the rain and closure fixes at the re-check
// (src/travel/disrupt.js). Fake fetches and a fake clock only; nothing here reaches Duffel, Google or Open-Meteo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './fakes.js';
import { queued } from '../src/accounts/schedule.js';
import { FPWATCH, comparable, fareDrop, flightPriceDrops, flightPriceWatchDue, flightWatches, fpwatchOp, lowestFare, routeFromStop } from '../src/travel/fpwatch.js';
import { armWindowReminders, localInstant, reminderTime, windowRemindersDue } from '../src/travel/reminders.js';
import { disruptionPush, disruptions, dry, outdoor, proposeFix, recheckDisruptions, wet } from '../src/travel/disrupt.js';
import { sampleTrip, tripOp } from '../src/travel/ops.js';
import { standinMaps } from '../src/travel/maps.js';
import { applyOps } from '../src/travel/trips.js';

const account = (t, env = {}) => ({ storage: new Storage(), env, t, now() { return this.t; } });
const jobAt = async (a, kind) => (await queued(a)).find((j) => j.kind === kind)?.at ?? null;
const H = 3600_000;

// ── a fake Duffel: POST /air/offer_requests and GET /air/offers/:id, in Duffel v2's shape ──

let seq = 0;
function offer({ total, currency = 'GBP', cabin = 'economy', stops = 0, from = 'LHR', to = 'LIS', date = '2027-05-12', pax = 2, cabins }) {
  const passengers = Array.from({ length: pax }, (_, i) => ({ id: `pas_000${i}AAAAAA`, type: 'adult' }));
  const via = ['MAD', 'OPO'];
  const points = [from, ...via.slice(0, stops), to];
  const segments = points.slice(1).map((dest, i) => ({
    origin: { iata_code: points[i] }, destination: { iata_code: dest },
    departing_at: `${date}T0${8 + i}:00:00`, arriving_at: `${date}T0${9 + i}:00:00`, duration: 'PT1H',
    marketing_carrier: { iata_code: 'TP', name: 'TAP' }, operating_carrier: { iata_code: 'TP', name: 'TAP' }, marketing_carrier_flight_number: String(1300 + i),
    passengers: passengers.map((p) => ({ passenger_id: p.id, cabin_class: cabins ? cabins[i] : cabin, baggages: [] })),
  }));
  return { id: `off_${String(++seq).padStart(4, '0')}FAKE`, live_mode: false, total_amount: Number(total).toFixed(2), total_currency: currency, slices: [{ origin: { iata_code: from }, destination: { iata_code: to }, segments }], passengers, owner: { name: 'TAP' } };
}
function fakeDuffel(list) {
  const calls = [];
  const byId = new Map();
  const state = { list, fail: false };
  const fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: init.headers, body: init.body ? JSON.parse(init.body).data : null });
    if (state.fail) return new Response(JSON.stringify({ errors: [{ type: 'api_error', code: 'internal_server_error', message: 'down' }] }), { status: 500 });
    if (init.method === 'POST' && u.pathname === '/air/offer_requests') {
      const offers = (typeof state.list === 'function' ? state.list() : state.list).map((o) => { byId.set(o.id, o); return o; });
      return new Response(JSON.stringify({ data: { id: 'orq_0001FAKE', live_mode: false, offers } }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    const m = /^\/air\/offers\/(\w+)$/.exec(u.pathname);
    if (init.method === 'GET' && m) {
      const o = byId.get(m[1]);
      return o ? new Response(JSON.stringify({ data: o }), { status: 200 }) : new Response(JSON.stringify({ errors: [{ type: 'invalid_request_error', code: 'not_found', message: 'no' }] }), { status: 404 });
    }
    return new Response('{}', { status: 404 });
  };
  return { fetch, calls, state, byId };
}
const ENV = { EDEN_FLIGHTS: '1', DUFFEL_TOKEN: 'duffel_test_abcdefgh12345' };
const deps = (d) => ({ fetch: d.fetch, sleep: async () => {}, log: () => {} });

const T0 = Date.parse('2027-04-01T09:00:00Z');
function flightTrip(a, { note = 'LHR → LIS', booked = null, kind = 'transport' } = {}) {
  a.storage.map.set('trip:t1', { title: 'Lisbon', start: '2027-05-12', travelers: 2, days: [
    { stops: [{ id: 's-fl', kind, at: '08:00', minutes: 150, place: { name: 'Flight to Lisbon', lat: null, lng: null }, note, booked }] },
    { stops: [] },
  ] });
}

test('fpwatch: the route from a stop’s words, like-for-like fares, the drop threshold', () => {
  assert.deepEqual(routeFromStop({ place: { name: 'Flight' }, note: 'LHR → LIS' }), { origin: 'LHR', destination: 'LIS' });
  assert.deepEqual(routeFromStop({ place: { name: 'BA 500 LGW-LIS' }, note: '' }), { origin: 'LGW', destination: 'LIS' });
  assert.deepEqual(routeFromStop({ place: { name: 'JFK to SFO' } }), { origin: 'JFK', destination: 'SFO' });
  assert.equal(routeFromStop({ place: { name: 'Fly to Lisbon' }, note: 'bring the ABC book' }), null);
  const want = { cabin: 'economy', maxStops: 0, currency: 'GBP' };
  assert.equal(comparable(offer({ total: 100 }), want), true);
  assert.equal(comparable(offer({ total: 100, stops: 1 }), want), false, 'more stops than the fare watched');
  assert.equal(comparable(offer({ total: 100, cabin: 'business' }), want), false);
  assert.equal(comparable(offer({ total: 100, stops: 1, cabins: ['business', 'economy'] }), { ...want, cabin: 'business', maxStops: 1 }), false, 'a mixed cabin is not the same fare');
  assert.equal(comparable(offer({ total: 100, currency: 'EUR' }), want), false);
  const noCabin = offer({ total: 100 });
  delete noCabin.slices[0].segments[0].passengers[0].cabin_class;
  assert.equal(comparable(noCabin, want), false, 'a cabin Duffel doesn’t list is never assumed');
  assert.equal(lowestFare([offer({ total: 90, cabin: 'business' }), offer({ total: 120 }), offer({ total: 80, stops: 1 }), offer({ total: 110 })], want).total, '110.00');
  assert.equal(lowestFare([offer({ total: 50, currency: 'EUR' }), offer({ total: 120 })], { cabin: 'economy', maxStops: 0, currency: null }).currency, 'EUR', 'no currency asked: the first fare’s, never a mix');
  assert.equal(fareDrop({ total: '200.00', currency: 'GBP' }, { total: '191.00', currency: 'GBP' }).cheaper, false, '4.5%: under 5%');
  assert.equal(fareDrop({ total: '100.00', currency: 'GBP' }, { total: '91.00', currency: 'GBP' }).cheaper, false, '9%, but under 10 in the currency');
  assert.deepEqual(fareDrop({ total: '200.00', currency: 'GBP' }, { total: '180.00', currency: 'GBP' }), { cheaper: true, by: '20.00', pct: 10 });
  assert.equal(fareDrop({ total: '200.00', currency: 'GBP' }, { total: '100.00', currency: 'EUR' }).cheaper, false);
});

test('fpwatch on: the same route, day, cabin and passengers on Duffel; it starts from the lowest like-for-like fare', async () => {
  const a = account(T0, ENV);
  flightTrip(a);
  const d = fakeDuffel(() => [offer({ total: 260 }), offer({ total: 240 }), offer({ total: 150, stops: 1 }), offer({ total: 200, cabin: 'premium_economy' })]);
  const { watch } = await fpwatchOp(a, 'trip-fwatch-on', { id: 't1', stop: 's-fl', max_stops: 0 }, deps(d));
  const req = d.calls[0];
  assert.equal(req.path, '/air/offer_requests');
  assert.equal(req.query.return_offers, 'true');
  assert.equal(req.headers['Duffel-Version'], 'v2');
  assert.equal(req.headers.Authorization, 'Bearer duffel_test_abcdefgh12345');
  assert.deepEqual(req.body, { slices: [{ origin: 'LHR', destination: 'LIS', departure_date: '2027-05-12' }], passengers: [{ type: 'adult' }, { type: 'adult' }], cabin_class: 'economy', max_connections: 0 });
  assert.equal(watch.route, 'LHR → LIS');
  assert.equal(watch.base.total, '240.00');
  assert.equal(watch.base.source, 'Duffel search');
  assert.equal(watch.base.at, new Date(T0).toISOString());
  assert.equal(await jobAt(a, 'fpwatch'), T0 + FPWATCH.everyMs, 'twice a day');
  assert.equal((await flightWatches(a, 't1')).length, 1);
  // what can’t be watched
  const b = account(T0, ENV);
  flightTrip(b, { note: 'the morning flight' });
  await assert.rejects(fpwatchOp(b, 'trip-fwatch-on', { id: 't1', stop: 's-fl' }, deps(d)), /airports/);
  flightTrip(b, { booked: { kind: 'flight', ref: 'X', provider: 'TAP', via: 'person', at: null } });
  await assert.rejects(fpwatchOp(b, 'trip-fwatch-on', { id: 't1', stop: 's-fl' }, deps(d)), /booked already/);
  flightTrip(b, { kind: 'visit' });
  await assert.rejects(fpwatchOp(b, 'trip-fwatch-on', { id: 't1', stop: 's-fl' }, deps(d)), /Only a flight/);
  flightTrip(b);
  await assert.rejects(fpwatchOp(account(T0, {}), 'trip-fwatch-on', { id: 't1', stop: 's-fl' }, deps(d)), /no such trip/);
  const off = account(T0, {});
  flightTrip(off);
  await assert.rejects(fpwatchOp(off, 'trip-fwatch-on', { id: 't1', stop: 's-fl' }, deps(d)), /isn’t switched on/);
  const late = account(Date.parse('2027-05-12T06:00:00Z'), ENV);
  flightTrip(late);
  await assert.rejects(fpwatchOp(late, 'trip-fwatch-on', { id: 't1', stop: 's-fl' }, deps(d)), /day has come/);
  const none = fakeDuffel([offer({ total: 90, cabin: 'first' })]);
  await assert.rejects(fpwatchOp(b, 'trip-fwatch-on', { id: 't1', stop: 's-fl' }, deps(none)), /found no economy flights LHR → LIS on 2027-05-12/);
});

test('fpwatch on from a picked Duffel offer: its own route, cabin, stops and price', async () => {
  const a = account(T0, ENV);
  flightTrip(a, { note: '' });
  const picked = offer({ total: 310, cabin: 'business', stops: 1, from: 'LGW', to: 'LIS' });
  const d = fakeDuffel([picked, offer({ total: 300, cabin: 'business', stops: 1, from: 'LGW' }), offer({ total: 280, cabin: 'business', stops: 2, from: 'LGW' })]);
  d.byId.set(picked.id, picked);
  const { watch } = await fpwatchOp(a, 'trip-fwatch-on', { id: 't1', stop: 's-fl', offer_id: picked.id }, deps(d));
  assert.equal(d.calls[0].method, 'GET');
  assert.equal(watch.route, 'LGW → LIS');
  assert.equal(watch.cabin, 'business');
  assert.equal(watch.max_stops, 1);
  assert.equal(watch.base.total, '310.00');
  assert.equal(watch.base.source, `Duffel offer ${picked.id}`);
  assert.equal(watch.lowest.total, '300.00', 'the 2-stop fare is not like for like');
  assert.equal(d.calls[1].body.cabin_class, 'business');
});

test('fpwatch due: a drop past the threshold is pushed once; back up clears it; a stop booked ends the watch', async () => {
  const a = account(T0, ENV);
  flightTrip(a);
  let price = 240;
  const d = fakeDuffel(() => [offer({ total: price }), offer({ total: price - 100, stops: 1 })]);
  await fpwatchOp(a, 'trip-fwatch-on', { id: 't1', stop: 's-fl', max_stops: 0 }, deps(d));
  const pushes = [];
  const notify = async (_a, n) => { pushes.push(n); };
  const run = async (p) => { price = p; a.t += FPWATCH.everyMs; await flightPriceWatchDue(a, { notify, ...deps(d) }); };
  await flightPriceWatchDue(a, { notify, ...deps(d) });
  assert.equal(d.calls.length, 1, 'not due yet: no search');
  await run(232);
  assert.equal(pushes.length, 0, '3%: not worth a push');
  assert.deepEqual(await flightPriceDrops(a, 't1'), []);
  await run(216);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, 'LHR → LIS is 24.00 GBP cheaper');
  assert.match(pushes[0].body, /^216\.00 GBP on 2027-05-12 \(economy, nonstop\), was 240\.00 GBP when you started watching\. Duffel, \d\d:\d\d UTC\.$/);
  assert.deepEqual(pushes[0].data, { kind: 'fprice', trip: 't1', stop: 's-fl' });
  const [drop] = await flightPriceDrops(a, 't1');
  assert.equal(drop.was, '240.00');
  assert.equal(drop.now, '216.00');
  assert.equal(drop.source, 'Duffel');
  assert.equal(drop.checked_at, new Date(a.t).toISOString());
  await run(214);
  assert.equal(pushes.length, 1, 'a little lower again: told already');
  assert.equal((await flightPriceDrops(a, 't1'))[0].now, '214.00', 'Eden noticed shows the latest');
  await run(190);
  assert.equal(pushes.length, 2, 'a further real drop under what was told');
  await run(239);
  assert.deepEqual(await flightPriceDrops(a, 't1'), [], 'back up: no drop shown');
  await run(210);
  assert.equal(pushes.length, 3, 'down again after going back up: news again');
  d.state.fail = true;
  await run(100);
  assert.equal(pushes.length, 3, 'Duffel down: no push, no throw');
  assert.equal(await jobAt(a, 'fpwatch'), a.t + FPWATCH.everyMs);
  d.state.fail = false;
  // booked: the watch ends
  const t = a.storage.map.get('trip:t1');
  t.days[0].stops[0].booked = { kind: 'flight', ref: 'ABC', provider: 'TAP', via: 'person', at: null };
  await run(100);
  assert.equal(pushes.length, 3);
  assert.equal((await flightWatches(a, 't1')).length, 0);
  assert.equal(await jobAt(a, 'fpwatch'), null);
});

test('fpwatch due: a stop moved to another day starts again from that day’s fare; off ends it; the day coming ends it', async () => {
  const a = account(T0, ENV);
  flightTrip(a);
  let price = 240;
  const d = fakeDuffel(() => [offer({ total: price, date: '2027-05-13' })]);
  await fpwatchOp(a, 'trip-fwatch-on', { id: 't1', stop: 's-fl', max_stops: 0 }, deps(d));
  const t = a.storage.map.get('trip:t1');
  t.days[1].stops.push(t.days[0].stops.pop());
  const pushes = [];
  price = 150;
  a.t += FPWATCH.everyMs;
  await flightPriceWatchDue(a, { notify: async (_a, n) => pushes.push(n), ...deps(d) });
  assert.equal(pushes.length, 0, 'another day’s fare is not a drop');
  assert.equal(d.calls.at(-1).body.slices[0].departure_date, '2027-05-13');
  const [w] = await flightWatches(a, 't1');
  assert.equal(w.date, '2027-05-13');
  assert.equal(w.base.total, '150.00');
  await fpwatchOp(a, 'trip-fwatch-off', { id: 't1', stop: 's-fl' }, deps(d));
  assert.equal((await flightWatches(a, 't1')).length, 0);
  assert.equal(await jobAt(a, 'fpwatch'), null);
  // the day comes: the watch goes without a search
  await fpwatchOp(a, 'trip-fwatch-on', { id: 't1', stop: 's-fl', max_stops: 0 }, deps(d));
  const n = d.calls.length;
  a.t = Date.parse('2027-05-13T00:00:00Z');
  await flightPriceWatchDue(a, { notify: async () => {}, ...deps(d) });
  assert.equal(d.calls.length, n);
  assert.equal((await flightWatches(a, 't1')).length, 0);
});

// ── booking-window reminders ──

function windowTrip(a, { zone = 'Europe/Lisbon' } = {}) {
  a.storage.map.set('trip:abcd', { title: 'Lisbon', start: '2027-07-10', travelers: 2, days: [
    { stops: [] }, { stops: [] },
    { stops: [{ id: 's-tw', kind: 'visit', at: '10:00', minutes: 90, place: { id: 'g1', name: 'Belém Tower', lat: 38.69, lng: -9.21 }, booked: null }] },
  ] });
  if (zone) a.storage.map.set('tz:abcd', { zone });
}

test('reminders: the opening day counted back from the stop’s day, 08:00 where the trip is (or 30 min before an early opening)', () => {
  const trip = { start: '2027-07-10', days: [{ stops: [] }, { stops: [] }, { stops: [{ id: 's-tw' }] }] };
  const w = { found: true, days_ahead: 30, opens_on: '2027-06-01', opens_at: '10:00' };
  const t = reminderTime(trip, 's-tw', w, 'Europe/Lisbon');
  assert.equal(t.opens_on, '2027-06-12', 'from the stop’s day now (12 Jul − 30), not the kept opens_on');
  assert.equal(t.at, Date.parse('2027-06-12T07:00:00Z'), '08:00 in Lisbon in summer is 07:00 UTC');
  assert.equal(reminderTime(trip, 's-tw', { ...w, opens_at: '07:00' }, 'Europe/Lisbon').at, Date.parse('2027-06-12T05:30:00Z'), '06:30 Lisbon');
  assert.equal(reminderTime(trip, 's-tw', { found: true, opens_on: '2027-06-20', opens_at: null }, null).at, Date.parse('2027-06-20T08:00:00Z'), 'no days_ahead: the kept day; no zone: UTC');
  assert.equal(reminderTime(trip, 's-tw', { found: false }, null), null);
  assert.equal(reminderTime(trip, 's-gone', w, null), null);
  assert.equal(localInstant('2027-01-15', 8 * 60, 'America/New_York'), Date.parse('2027-01-15T13:00:00Z'));
});

test('reminders: armed, pushed once on the morning, re-armed when the stop moves; booked or missed → none', async () => {
  const a = account(Date.parse('2027-06-01T09:00:00Z'));
  windowTrip(a);
  a.storage.map.set('twin:abcd:s-tw', { stop: 's-tw', place: 'Belém Tower', found: true, days_ahead: 30, opens_on: '2027-06-12', opens_at: '10:00', quote: 'Tickets go on sale 30 days ahead at 10:00.', url: 'https://example.pt/tickets', source: 'The venue’s own website', checked_at: '2027-05-30T10:00:00Z' });
  assert.equal(await armWindowReminders(a), Date.parse('2027-06-12T07:00:00Z'));
  assert.equal(await jobAt(a, 'twrem'), Date.parse('2027-06-12T07:00:00Z'));
  const pushes = [];
  const notify = async (_a, n) => pushes.push(n);
  await windowRemindersDue(a, { notify });
  assert.equal(pushes.length, 0, 'not yet');
  a.t = Date.parse('2027-06-12T07:00:00Z');
  await windowRemindersDue(a, { notify });
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, 'Bookings open today: Belém Tower');
  assert.equal(pushes[0].body, 'Bookings for Belém Tower open today at 10:00 (the venue’s site), for your visit on Mon 12 Jul.');
  assert.deepEqual(pushes[0].data, { kind: 'window', trip: 'abcd', stop: 's-tw', url: 'https://example.pt/tickets' });
  assert.equal(await jobAt(a, 'twrem'), null, 'nothing more to come');
  a.t += 3600_000;
  await windowRemindersDue(a, { notify });
  assert.equal(pushes.length, 1, 'once');
  // the stop moves a day later: a new opening day, a new reminder
  const t = a.storage.map.get('trip:abcd');
  t.days.push({ stops: [t.days[2].stops.pop()] });
  assert.equal(await armWindowReminders(a), Date.parse('2027-06-13T07:00:00Z'));
  a.t = Date.parse('2027-06-13T07:05:00Z');
  await windowRemindersDue(a, { notify });
  assert.equal(pushes.length, 2);
  assert.match(pushes[1].body, /visit on Tue 13 Jul/);
  // booked: no reminder
  const b = account(Date.parse('2027-06-12T07:00:00Z'));
  windowTrip(b);
  b.storage.map.get('trip:abcd').days[2].stops[0].booked = { kind: 'ticket', ref: 'T1', provider: 'x', via: 'person', at: null };
  b.storage.map.set('twin:abcd:s-tw', { found: true, days_ahead: 30, opens_at: '10:00' });
  await windowRemindersDue(b, { notify });
  assert.equal(pushes.length, 2);
  // the job was off for a day: not sent late, and forgotten
  const c = account(Date.parse('2027-06-13T09:00:00Z'));
  windowTrip(c);
  c.storage.map.set('twin:abcd:s-tw', { found: true, days_ahead: 30, opens_at: '10:00' });
  await windowRemindersDue(c, { notify });
  assert.equal(pushes.length, 2);
  assert.equal(c.storage.map.get('twrem:abcd:s-tw').missed, true);
  // the window gone (trip deleted): its state goes too
  c.storage.map.delete('twin:abcd:s-tw');
  await armWindowReminders(c);
  assert.equal(c.storage.map.has('twrem:abcd:s-tw'), false);
});

// ── disruption fixes ──

const W = (rain, more = {}) => ({ date: 'x', high_c: 20, low_c: 12, rain_chance_pct: rain, summary: rain >= 70 ? 'Moderate rain' : 'Partly cloudy', sunrise: '07:00', sunset: '20:30', source: 'Open-Meteo', checked_at: '2027-05-11T06:00:00.000Z', ...more });
const NO = { date: 'x', forecast: null, why: 'Too far ahead for a forecast', source: 'Open-Meteo', checked_at: '2027-05-11T06:00:00.000Z' };
const st = (id, name, at, extra = {}) => ({ id, kind: 'visit', at, minutes: 60, place: { id: null, name, lat: 38.7, lng: -9.1 }, booked: null, ...extra });
function rainyTrip() {
  return { title: 'Lisbon', start: '2027-05-12', days: [
    { stops: [st('s-mir', 'Miradouro de Santa Luzia', '10:00'), st('s-mus', 'Gulbenkian Museum', '12:00'), st('s-lun', 'Lunch', '13:30', { kind: 'meal' }), st('s-bch', 'Praia do Guincho', '16:00', { booked: { kind: 'tour', ref: 'G', provider: 'x', via: 'person', at: null } })] },
    { stops: [st('s-a', 'Carmo Convent', '10:00'), st('s-b', 'Tile Museum', '14:00')] },
    { stops: [] },
  ] };
}

test('disrupt: what counts as wet, dry and outdoors (and how it was decided)', () => {
  assert.equal(wet(W(70)), true);
  assert.equal(wet(W(30, { summary: 'Thunderstorm' })), true, 'the summary alone');
  assert.equal(wet(W(69)), false);
  assert.equal(wet(NO), false);
  assert.equal(dry(W(39)), true);
  assert.equal(dry(W(40)), false);
  assert.equal(dry(NO), false, 'no forecast is never called dry');
  assert.equal(dry(W(null)), false);
  assert.equal(outdoor(st('x', 'Miradouro da Graça', '10:00')), 'name');
  assert.equal(outdoor(st('x', 'Jardim', '10:00'), ['park', 'tourist_attraction']), 'google_types');
  assert.equal(outdoor(st('x', 'Garden Café', '10:00'), ['cafe', 'restaurant']), null, 'Google types win over the name');
  assert.equal(outdoor(st('x', 'Beach lunch', '10:00', { kind: 'meal' })), null, 'only sights and activities move');
});

test('disrupt: rain on an outdoor stop → moved to a free slot on the nearest dry day at the same time; booked ones told only', () => {
  const trip = rainyTrip();
  const found = disruptions(trip, { alerts: [], days: [] }, [W(85), W(60), W(10)], { today: '2027-05-12' });
  assert.deepEqual(found.items.map((i) => [i.kind, i.stop, i.how, Boolean(i.fix)]), [['rain', 's-mir', 'name', true], ['rain', 's-bch', 'name', false]]);
  const mir = found.items[0];
  assert.equal(mir.text, 'Miradouro de Santa Luzia: 85% chance of rain, Moderate rain on Day 1 (Wed 12 May) (Open-Meteo, checked 06:00 UTC).');
  assert.deepEqual(mir.fix.ops, [{ op: 'move', stop: 's-mir', day: 2, at: '10:00' }], 'Day 2 is 60%: not dry; Day 3 is');
  assert.match(mir.fix.text, /moved to Day 3 \(Fri 14 May\) at 10:00: 10% chance of rain then \(Open-Meteo\)/);
  assert.deepEqual(found.ops, mir.fix.ops);
  // no dry day with a forecast: nothing proposed, still told
  const none = disruptions(trip, { alerts: [] }, [W(85), NO, NO]);
  assert.equal(none.items[0].fix, null);
  // a day already passed is left alone
  assert.equal(disruptions(trip, { alerts: [] }, [W(85), W(10), W(10)], { today: '2027-05-13' }).items.length, 0);
});

test('disrupt: no free slot on the dry day → swapped with an indoor sight there; the sunset bounds an outdoor slot', () => {
  const trip = rainyTrip();
  trip.days[0].stops = [st('s-mir', 'Miradouro de Santa Luzia', '10:00')];
  trip.days[1].stops = Array.from({ length: 6 }, (_, i) => st(`s-${i}`, i === 2 ? 'Gulbenkian Museum' : `Park ${i}`, `${String(9 + i * 2).padStart(2, '0')}:00`, { minutes: 90 }));
  const found = disruptions(trip, { alerts: [] }, [W(90), W(5), W(80)]);
  const [it] = found.items;
  assert.deepEqual(it.fix.ops, [{ op: 'move', stop: 's-mir', day: 1, at: '13:00' }, { op: 'move', stop: 's-2', day: 0, at: '10:00' }]);
  assert.match(it.fix.text, /swapped with Gulbenkian Museum/);
  applyOps(trip, found.ops, { newId: () => 's-new' }); // the ops are valid trip ops
  // sunset at 10:30 on the dry day: a 60-minute outdoor visit has no daylight slot from 09:00 on; nothing indoor either
  const t2 = rainyTrip();
  t2.days[1].stops = [];
  const dark = disruptions(t2, { alerts: [] }, [W(90), W(5, { sunset: '09:30' }), NO]);
  assert.equal(dark.items[0].fix, null);
});

test('disrupt: closed that weekday → another weekday; closed for good → off the plan; sample and booked stops untouched', () => {
  const trip = rainyTrip();
  const alerts = [
    { kind: 'closed_that_day', stop: 's-b', day: 1, text: 'Tile Museum: closed on Thursdays.' },
    { kind: 'closed', stop: 's-a', day: 1, text: 'Carmo Convent: closed for good.' },
    { kind: 'late', stop: 's-mus', day: 0, text: 'late' },
  ];
  const checks = { maps: 'google', alerts, days: [{}, { stops: [{ stop: 's-b', badges: { hours: { status: 'warn', source: 'Google Maps', checked_at: '2027-05-11T06:00:00.000Z' } } }, { stop: 's-a', badges: { hours: { status: 'warn', source: 'Google Maps', checked_at: '2027-05-11T06:00:00.000Z' } } }] }] };
  const found = disruptions(trip, checks, [W(10), W(10), W(10)]);
  const b = found.items.find((i) => i.stop === 's-b');
  assert.equal(b.text, 'Tile Museum: closed on Thursdays. (Google Maps, checked 06:00 UTC)');
  assert.deepEqual(b.fix.ops, [{ op: 'move', stop: 's-b', day: 2, at: '14:00' }], 'nearest, later first on a tie: Friday');
  const a = found.items.find((i) => i.stop === 's-a');
  assert.deepEqual(a.fix.ops, [{ op: 'remove', stop: 's-a' }]);
  assert.equal(a.fix.title, 'Carmo Convent is closed for good: off the plan');
  // hours known: a day it is also closed is skipped
  const places = { 's-b': { status: 'open', hours: [{ day: 4, open: '10:00', close: '18:00' }] } }; // open Thursdays only (12 May 2027 is a Wednesday)
  const withHours = disruptions(trip, checks, [W(10), W(10), W(10)], { places });
  assert.equal(withHours.items.find((i) => i.stop === 's-b').fix, null, 'open on no other trip day');
  // stand-in maps or sample hours: not news
  assert.equal(disruptions(trip, { ...checks, maps: 'standin' }, []).items.length, 0);
  const sample = structuredClone(checks);
  sample.days[1].stops[0].badges.hours.status = 'sample';
  assert.equal(disruptions(trip, sample, []).items.some((i) => i.stop === 's-b'), false);
});

test('proposeFix: one proposal by Eden; a move the preview finds closed is dropped and the rest proposed again', async () => {
  const trip = rainyTrip();
  const found = disruptions(trip, { alerts: [] }, [W(85), W(10), W(10)]);
  const calls = [];
  const fake = (bad) => async (_a, op, body) => {
    calls.push([op, body]);
    if (op === 'trip-discard') return { discarded: true };
    applyOps(trip, body.ops, { newId: () => 's-n' });
    return { proposal: { id: 'abcdef123456' }, preview: { checks: { alerts: bad ? [{ kind: 'closed_that_day', stop: 's-mir', day: body.ops[0].day }] : [] } } };
  };
  const out = await proposeFix({}, 'abcd', trip, found, { tripOp: fake(false) });
  assert.equal(out.proposal.id, 'abcdef123456');
  assert.equal(calls[0][0], 'trip-propose');
  assert.equal(calls[0][1].by, 'eden');
  assert.equal(calls[0][1].title, 'Rain on Day 1: Miradouro de Santa Luzia to Day 2');
  assert.match(calls[0][1].reason, /85% chance of rain.*Open-Meteo, checked 06:00 UTC.*moved to Day 2/);
  calls.length = 0;
  assert.equal(await proposeFix({}, 'abcd', trip, found, { tripOp: fake(true) }), null);
  assert.deepEqual(calls.map((c) => c[0]), ['trip-propose', 'trip-discard'], 'nothing left: the bad proposal is taken back');
  assert.equal(await proposeFix({}, 'abcd', trip, { items: [] }, { tripOp: fake(false) }), null);
});

test('recheckDisruptions with the real trip ops: a closure and rain → one proposal the preview checks; told once; the push says a fix is ready', async () => {
  const sm = standinMaps(() => T0);
  const maps = { ...sm, mode: 'google', place: async (id) => ({ ...(await sm.place(id)), standin: false, source: 'Google Maps' }), travel: async (...x) => ({ ...(await sm.travel(...x)), standin: false, source: 'Google Maps' }) };
  const a = account(T0);
  const real = (acc, op, body) => tripOp(acc, op, body, { maps });
  const { trip } = await real(a, 'trip-sample', {});
  const { checks } = await real(a, 'trip-get', { id: trip.id });
  const closed = checks.alerts.find((x) => x.kind === 'closed_that_day');
  assert.ok(closed, 'the sample’s Tile Museum is closed on Mondays');
  const weather = { days: [W(80), W(15), W(20)] };
  const ops = (acc, op, body) => (op === 'trip-weather' ? weather : real(acc, op, body));
  const stored = a.storage.map.get(`trip:${trip.id}`);
  const dis = await recheckDisruptions(a, trip.id, stored, checks, { tripOp: ops });
  assert.deepEqual(dis.fresh.map((i) => i.kind).sort(), ['closed_that_day', 'rain']);
  assert.equal(dis.fresh.find((i) => i.kind === 'rain').name, 'Miradouro da Graça');
  assert.ok(dis.proposal, 'a proposal was made');
  assert.equal(dis.proposal.proposal.by, 'eden');
  assert.equal(dis.proposal.preview.checks.alerts.filter((x) => x.kind === 'closed_that_day').length, 0, 'applied, nothing is closed');
  assert.equal(a.storage.map.get(`tprop:${trip.id}`).title, '2 fixes for rain and closures');
  const push = disruptionPush(stored, trip.id, [closed], dis);
  assert.equal(push.title, 'Three days in Lisbon: 2 things changed; Eden has a fix ready');
  assert.match(push.body, /National Tile Museum: closed on Mondays\. .*Miradouro da Graça: 80% chance of rain/);
  assert.equal(push.data.proposal, dis.proposal.proposal.id);
  // the next re-check: nothing new, nothing proposed again, nothing pushed
  const again = await recheckDisruptions(a, trip.id, stored, checks, { tripOp: ops });
  assert.equal(again.fresh.length, 0);
  assert.equal(again.proposal, null);
  assert.equal(disruptionPush(stored, trip.id, [], again), null);
  // a closure with nothing to fix it with still counts, without "fix ready"
  assert.equal(disruptionPush(stored, trip.id, [closed], { fresh: [], proposal: null }).title, 'Three days in Lisbon: 1 thing changed');
});
