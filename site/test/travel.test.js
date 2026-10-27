// Eden Travel's backend (src/travel): the maps seam (stand-in, and Google against a fake), the
// trip rules, the checks and badges, propose → Apply → Undo in the account object, and the
// route's switch. Nothing here reaches Google.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { travelApi, travelOn } from '../src/travel/api.js';
import { checkTrip, compareChecks, hoursCheck, pace } from '../src/travel/checks.js';
import { MapsError, STANDIN_IDS, fromGooglePlace, mapsFor, standinMaps } from '../src/travel/maps.js';
import { PROPOSAL_MS, sampleTrip, tripOp } from '../src/travel/ops.js';
import { TripError, applyOps, cleanTrip } from '../src/travel/trips.js';
import { Storage } from './fakes.js';

const NOW = Date.parse('2027-05-01T12:00:00Z');
let n = 0;
const newId = () => `s-${(++n).toString(16).padStart(4, '0')}`;
const account = (env = {}) => ({ storage: new Storage(), env, t: NOW, now() { return this.t; } });
const stop = (name, at, extra = {}) => ({ place: { id: null, name, lat: null, lng: null }, at, minutes: 60, ...extra });

// ── maps ──

test('the stand-in answers with sample data, labelled as such', async () => {
  const maps = mapsFor({}, { now: () => NOW });
  assert.equal(maps.mode, 'standin');
  const p = await maps.place('standin:jeronimos');
  assert.equal(p.name, 'Jerónimos Monastery');
  assert.equal(p.standin, true);
  assert.match(p.source, /Stand-in/);
  assert.equal(p.checked_at, new Date(NOW).toISOString());
  await assert.rejects(maps.place('standin:nowhere'), MapsError);
  const found = await maps.search('jeronimos monastery');
  assert.equal(found[0].id, 'standin:jeronimos');
  const t = await maps.travel(p, await maps.place('standin:pasteis-belem'), 'walk');
  assert.ok(t.minutes >= 2 && t.minutes < 15, `a short walk in Belém, got ${t.minutes}`);
  assert.equal((await maps.travel(p, p, 'walk')).minutes, 0);
  assert.ok(STANDIN_IDS.length >= 10);
});

test('Google: the key goes in a header, never the URL; places and routes map to ours', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('computeRoutes')) return Response.json({ routes: [{ duration: '754s', distanceMeters: 2100 }] });
    if (String(url).endsWith('places:searchText')) return Response.json({ places: [] });
    if (String(url).includes('/places/missingplace123')) return new Response('{}', { status: 404 });
    return Response.json({
      id: 'ChIJabcdefghij', displayName: { text: 'Museu Nacional do Azulejo' }, formattedAddress: 'R. Me. Deus 4, Lisboa',
      location: { latitude: 38.7247, longitude: -9.1135 }, businessStatus: 'OPERATIONAL',
      regularOpeningHours: { periods: [{ open: { day: 2, hour: 10, minute: 0 }, close: { day: 2, hour: 18, minute: 0 } }] },
    });
  };
  const maps = mapsFor({ GOOGLE_MAPS_SERVER_KEY: 'test-key' }, { fetch, now: () => NOW });
  assert.equal(maps.mode, 'google');
  const p = await maps.place('ChIJabcdefghij');
  assert.deepEqual(p.hours, [{ day: 2, open: '10:00', close: '18:00' }]);
  assert.equal(p.status, 'open');
  assert.equal(p.standin, false);
  assert.equal(calls[0].init.headers['X-Goog-Api-Key'], 'test-key');
  assert.ok(!calls.some((c) => c.url.includes('test-key')));
  assert.match(calls[0].init.headers['X-Goog-FieldMask'], /regularOpeningHours/);
  await assert.rejects(maps.place('missingplace123'), (e) => e.code === 'not_found');
  await assert.rejects(maps.place('../evil'), (e) => e.code === 'not_found');
  const t = await maps.travel({ id: 'ChIJaaaaaaaaaa' }, { lat: 38.7, lng: -9.1 }, 'transit');
  assert.equal(t.minutes, 13);
  const body = JSON.parse(calls.at(-1).init.body);
  assert.deepEqual(body.origin, { placeId: 'ChIJaaaaaaaaaa' });
  assert.equal(body.travelMode, 'TRANSIT');
  await maps.search('tile museum', { lat: 38.7, lng: -9.1 });
  assert.match(calls.at(-1).init.headers['X-Goog-FieldMask'], /^places\.id,/);
});

test('Google place: always open, closed for good, no hours', () => {
  const always = fromGooglePlace({ id: 'x', regularOpeningHours: { periods: [{ open: { day: 0, hour: 0, minute: 0 } }] } }, 'now');
  assert.equal(always.hours.length, 7);
  assert.equal(fromGooglePlace({ id: 'x', businessStatus: 'CLOSED_PERMANENTLY' }, 'now').status, 'closed_permanently');
  assert.equal(fromGooglePlace({ id: 'x' }, 'now').hours, null);
});

// ── trips ──

test('a trip is cleaned: times, modes, ids, sorted stops, limits', () => {
  const t = cleanTrip({ title: '  Rome ', start: '2027-06-12', days: [{ stops: [stop('B', '14:00'), stop('A', '09:00', { id: 'a', mode: 'transit' })] }] }, { newId, now: NOW });
  assert.equal(t.title, 'Rome');
  assert.deepEqual(t.days[0].stops.map((s) => s.place.name), ['A', 'B']);
  assert.equal(t.days[0].stops[0].id, 'a');
  assert.equal(t.days[0].title, 'Day 1');
  assert.equal(t.rev, 1);
  assert.throws(() => cleanTrip({ title: 'x', start: '12/06/2027', days: [{}] }, { newId, now: NOW }), /YYYY-MM-DD/);
  assert.throws(() => cleanTrip({ title: 'x', start: '2027-06-12', days: [{ stops: [stop('A', '9am')] }] }, { newId, now: NOW }), /HH:MM/);
  assert.throws(() => cleanTrip({ title: 'x', start: '2027-06-12', days: [{ stops: [stop('A', '09:00', { mode: 'jetpack' })] }] }, { newId, now: NOW }), /mode/);
  assert.throws(() => cleanTrip({ title: 'x', start: '2027-06-12', days: [] }, { newId, now: NOW }), /1 to 30 days/);
});

test('ops change a copy; a booked stop is locked except its note', () => {
  const t = cleanTrip({ title: 'x', start: '2027-06-12', days: [
    { stops: [stop('Flight', '08:00', { id: 'fl', booked: { kind: 'flight', ref: 'ABC123' } }), stop('Museum', '11:00', { id: 'mu' })] },
    { stops: [] },
  ] }, { newId, now: NOW });
  const { trip, changed } = applyOps(t, [
    { op: 'move', stop: 'mu', day: 1, at: '10:00' },
    { op: 'add', day: 0, stop: stop('Lunch', '12:30') },
    { op: 'title', day: 1, title: 'Museum day' },
    { op: 'edit', stop: 'fl', note: 'Terminal 1' },
  ], { newId });
  assert.equal(t.days[1].stops.length, 0, 'the original is untouched');
  assert.equal(trip.days[1].stops[0].at, '10:00');
  assert.equal(trip.days[1].title, 'Museum day');
  assert.equal(trip.days[0].stops[0].note, 'Terminal 1');
  assert.equal(changed.mu, 'moved');
  assert.equal(Object.values(changed).filter((v) => v === 'new').length, 1);
  for (const op of [{ op: 'remove', stop: 'fl' }, { op: 'move', stop: 'fl', day: 1 }, { op: 'time', stop: 'fl', at: '09:00' }, { op: 'edit', stop: 'fl', minutes: 10 }]) {
    assert.throws(() => applyOps(t, [op], { newId }), (e) => e instanceof TripError && e.status === 409 && e.code === 'locked', op.op);
  }
  // an added stop can't arrive booked
  const added = applyOps(t, [{ op: 'add', day: 0, stop: stop('Sneaky', '20:00', { booked: { kind: 'hotel', ref: 'x' } }) }], { newId }).trip;
  assert.equal(added.days[0].stops.at(-1).booked, null);
  assert.throws(() => applyOps(t, [{ op: 'remove', stop: 'nope' }], { newId }), /no stop nope/);
  assert.throws(() => applyOps(t, [], { newId }), /1 to 40/);
});

// ── checks ──

test('hours: closed that weekday, out of hours, closed for good, no hours', () => {
  const p = { status: 'open', hours: [{ day: 2, open: '10:00', close: '18:00' }] };
  assert.equal(hoursCheck(p, '2027-06-15', 11 * 60, 90).status, 'ok'); // a Tuesday
  assert.equal(hoursCheck(p, '2027-06-14', 11 * 60, 90).alert, 'closed_that_day'); // a Monday
  assert.equal(hoursCheck(p, '2027-06-15', 17 * 60, 90).alert, 'out_of_hours');
  assert.equal(hoursCheck({ ...p, status: 'closed_permanently' }, '2027-06-15', 660, 60).alert, 'closed');
  assert.equal(hoursCheck({ status: 'open', hours: null }, '2027-06-15', 660, 60).status, 'look');
  assert.equal(hoursCheck({ status: 'open', hours: [{ day: 2, open: '18:00', close: '02:00' }] }, '2027-06-15', 22 * 60, 60).status, 'ok');
  assert.equal(pace(3, 40, 300, 0), 'unhurried');
  assert.equal(pace(5, 40, 300, 0), 'full');
  assert.equal(pace(3, 40, 300, 1), 'rushed');
});

test('the sample trip: Day 3 is a Monday, so the Tile Museum alert fires; stand-in badges say sample', async () => {
  const trip = cleanTrip(sampleTrip(NOW), { newId, now: NOW });
  const checks = await checkTrip(trip, standinMaps(() => NOW));
  assert.equal(checks.maps, 'standin');
  assert.equal(checks.days[2].date.length, 10);
  assert.equal(new Date(`${checks.days[2].date}T00:00:00Z`).getUTCDay(), 1);
  const tiles = trip.days[2].stops.find((s) => s.place.id === 'standin:tiles');
  assert.ok(checks.alerts.some((a) => a.kind === 'closed_that_day' && a.stop === tiles.id));
  const badges = checks.days.flatMap((d) => d.stops.map((s) => s.badges));
  assert.ok(badges.every((b) => b.hours.status !== 'ok'), 'no stand-in hours shown as checked');
  assert.ok(badges.filter((b) => b.travel).every((b) => ['sample', 'look', 'unknown'].includes(b.travel.status)));
  assert.ok(checks.cost.amount > 0 && checks.cost.currency === 'EUR');
  assert.equal(checks.cost.over, false);
});

test('a late arrival is caught with real (fake Google) travel times, and the cache saves the second look', async () => {
  let routes = 0, places = 0;
  const maps = {
    mode: 'google',
    async place(id) { places++; return { id, name: id, status: 'open', hours: null, standin: false, source: 'Google Maps (Places API)', checked_at: 'now' }; },
    async travel() { routes++; return { minutes: 50, meters: 9000, mode: 'transit', standin: false, source: 'Google Maps (Routes API)', checked_at: 'now' }; },
  };
  const trip = cleanTrip({ title: 'x', start: '2027-06-15', days: [{ stops: [
    { place: { id: 'p1', name: 'A', lat: 38.70, lng: -9.20 }, at: '10:00', minutes: 60 },
    { place: { id: 'p2', name: 'B', lat: 38.72, lng: -9.11 }, at: '11:30', minutes: 60, mode: 'transit' },
  ] }] }, { newId, now: NOW });
  const store = new Map();
  const cache = { get: async (k) => store.get(k), put: async (k, v) => store.set(k, v) };
  const c = await checkTrip(trip, maps, { cache });
  assert.equal(c.alerts[0].kind, 'late');
  assert.match(c.alerts[0].text, /11:50, 20 min after the planned 11:30/);
  assert.equal(c.days[0].stops[1].badges.travel.status, 'warn');
  assert.equal(c.days[0].pace, 'rushed');
  await checkTrip(trip, maps, { cache });
  assert.deepEqual([places, routes], [2, 1], 'the second check comes from the cache');
  const failing = { ...maps, async place() { throw new MapsError('unavailable', 'Google Maps did not answer in time.'); } };
  const u = await checkTrip(trip, failing);
  assert.equal(u.days[0].stops[0].badges.hours.status, 'unknown');
  const later = await checkTrip(applyOps(trip, [{ op: 'time', stop: trip.days[0].stops[1].id, at: '12:00' }], { newId }).trip, maps);
  const diff = compareChecks(c, later);
  assert.equal(diff.alerts_fixed.length, 1);
  assert.equal(diff.alerts_new.length, 0);
});

// ── the account object: propose, Apply, Undo ──

test('propose changes nothing; Apply needs confirm and writes what was previewed; Undo goes back', async () => {
  const acct = account();
  const { trip } = await tripOp(acct, 'trip-sample');
  assert.match(trip.id, /^[0-9a-f]{16}$/);
  const list = await tripOp(acct, 'trip-list');
  assert.equal(list.trips.length, 1);
  assert.equal(list.maps, 'standin');

  const tiles = trip.days[2].stops.find((s) => s.place.id === 'standin:tiles');
  const ops = [{ op: 'move', stop: tiles.id, day: 1, at: '17:30' }, { op: 'add', day: 2, stop: { place: { id: 'standin:gulbenkian', name: 'Gulbenkian Museum', lat: 38.7372, lng: -9.1545 }, at: '11:00', minutes: 90, mode: 'taxi' } }];
  const { proposal, preview } = await tripOp(acct, 'trip-propose', { id: trip.id, ops, title: 'Move the Tile Museum to Sunday', reason: 'It is closed on Mondays.', by: 'eden' });
  assert.equal(proposal.by, 'eden');
  assert.equal(preview.changed[tiles.id], 'moved');
  assert.ok(preview.diff.alerts_fixed.some((a) => a.kind === 'closed_that_day'));
  const added = Object.keys(preview.changed).find((k) => preview.changed[k] === 'new');

  const still = await tripOp(acct, 'trip-get', { id: trip.id });
  assert.equal(still.trip.rev, 1, 'a proposal changes nothing');
  assert.equal(still.proposal.id, proposal.id);

  await assert.rejects(tripOp(acct, 'trip-apply', { id: trip.id, proposal: proposal.id }), /confirm: true/);
  const applied = await tripOp(acct, 'trip-apply', { id: trip.id, proposal: proposal.id, confirm: true });
  assert.equal(applied.trip.rev, 2);
  assert.ok(applied.trip.days[2].stops.some((s) => s.id === added), 'the stop shown in the preview is the one saved');
  assert.ok(!applied.checks.alerts.some((a) => a.kind === 'closed_that_day'));
  await assert.rejects(tripOp(acct, 'trip-apply', { id: trip.id, proposal: proposal.id, confirm: true }), (e) => e.code === 'gone');

  const undone = await tripOp(acct, 'trip-undo', { id: trip.id });
  assert.equal(undone.trip.rev, 3);
  assert.ok(undone.trip.days[2].stops.some((s) => s.id === tiles.id));
  await assert.rejects(tripOp(acct, 'trip-undo', { id: trip.id }), (e) => e.code === 'nothing');
});

test('a proposal goes stale when the trip changes, and old ones expire', async () => {
  const acct = account();
  const { trip } = await tripOp(acct, 'trip-sample');
  const first = trip.days[0].stops[2];
  const { proposal } = await tripOp(acct, 'trip-propose', { id: trip.id, ops: [{ op: 'time', stop: first.id, at: '13:30' }] });
  await tripOp(acct, 'trip-edit', { id: trip.id, rev: 1, ops: [{ op: 'title', day: 0, title: 'Landing day' }] });
  await assert.rejects(tripOp(acct, 'trip-apply', { id: trip.id, proposal: proposal.id, confirm: true }), (e) => e.code === 'gone' || e.code === 'stale');
  await assert.rejects(tripOp(acct, 'trip-edit', { id: trip.id, rev: 1, ops: [{ op: 'title', day: 0, title: 'x' }] }), (e) => e.code === 'stale');

  const again = await tripOp(acct, 'trip-propose', { id: trip.id, ops: [{ op: 'time', stop: first.id, at: '13:30' }] });
  acct.t += PROPOSAL_MS + 1;
  assert.equal((await tripOp(acct, 'trip-get', { id: trip.id })).proposal, null);
  await assert.rejects(tripOp(acct, 'trip-apply', { id: trip.id, proposal: again.proposal.id, confirm: true }), (e) => e.code === 'gone');
});

test('Undo never unbooks a stop booked since; discard; delete; ids are checked', async () => {
  const acct = account();
  const { trip } = await tripOp(acct, 'trip-create', { trip: { title: 'x', start: '2027-06-12', days: [{ stops: [stop('Hotel', '15:00', { id: 'ho' })] }] } });
  await tripOp(acct, 'trip-edit', { id: trip.id, ops: [{ op: 'add', day: 0, stop: stop('Dinner', '19:00') }] });
  // a booking lands (the booking flow marks the stop; simulated here in storage)
  const saved = await acct.storage.get(`trip:${trip.id}`);
  saved.days[0].stops.find((s) => s.id === 'ho').booked = { kind: 'hotel', ref: 'H1' };
  await acct.storage.put(`trip:${trip.id}`, saved);
  const undone = await tripOp(acct, 'trip-undo', { id: trip.id });
  assert.equal(undone.trip.days[0].stops.find((s) => s.id === 'ho').booked.ref, 'H1');

  const { proposal } = await tripOp(acct, 'trip-propose', { id: trip.id, ops: [{ op: 'title', day: 0, title: 'y' }] });
  await tripOp(acct, 'trip-discard', { id: trip.id, proposal: proposal.id });
  assert.equal((await tripOp(acct, 'trip-get', { id: trip.id })).proposal, null);
  await assert.rejects(tripOp(acct, 'trip-get', { id: '../trip' }), /trip id/);
  await assert.rejects(tripOp(acct, 'trip-get', { id: 'ffffffffffffffff' }), (e) => e.status === 404);
  await tripOp(acct, 'trip-delete', { id: trip.id });
  assert.equal((await tripOp(acct, 'trip-list')).trips.length, 0);
  assert.equal([...(await acct.storage.list({ prefix: 'thist:' }))].length, 0);
});

test('place search goes through the maps; the maps cache lives in the account', async () => {
  const acct = account();
  const r = await tripOp(acct, 'trip-places', { text: 'tile museum' });
  assert.equal(r.places[0].id, 'standin:tiles');
  await assert.rejects(tripOp(acct, 'trip-places', { text: 'x' }), /what to look for/);
  await tripOp(acct, 'trip-sample');
  assert.ok((await acct.storage.list({ prefix: 'tcache:' })).size > 0);
});

// ── the route ──

test('the route is off unless EDEN_TRAVEL=1, then hands each action to the account object', async () => {
  const seen = [];
  const deps = {
    call: async (env, account, op, body, token) => { seen.push({ account, op, body, token }); return { ok: op }; },
    limited: async () => {},
    readBody: async (request) => request.json(),
  };
  const who = { account: 'acct-1', token: { device: 'd', secret: 's' } };
  const get = (q = '') => new Request(`https://askeden.com/api/chat/travel${q}`);
  const post = (body) => new Request('https://askeden.com/api/chat/travel', { method: 'POST', body: JSON.stringify(body) });
  assert.equal(travelOn({}), false);
  await assert.rejects(travelApi(get(), {}, who, '/api/chat/travel', deps), (e) => e.status === 404);
  const env = { EDEN_TRAVEL: '1' };
  await travelApi(get(), env, who, '/api/chat/travel', deps);
  await travelApi(get('?id=0123456789abcdef'), env, who, '/api/chat/travel', deps);
  await travelApi(post({ action: 'apply', args: { id: 'x', proposal: 'y', confirm: true } }), env, who, '/api/chat/travel', deps);
  assert.deepEqual(seen.map((s) => s.op), ['trip-list', 'trip-get', 'trip-apply']);
  assert.equal(seen[2].body.confirm, true);
  assert.equal(seen[0].token, who.token);
  await assert.rejects(travelApi(post({ action: 'book' }), env, who, '/api/chat/travel', deps), /action must be one of/);
});
