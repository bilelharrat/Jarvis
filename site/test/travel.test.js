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
  const moved = preview.changes.find((x) => x.stop === tiles.id);
  assert.deepEqual(moved, { stop: tiles.id, how: 'moved', name: 'National Tile Museum', day: 1, at: '17:30', was: { day: 2, at: '11:00' } });
  assert.equal(preview.changes.find((x) => x.how === 'new').name, 'Gulbenkian Museum');
  assert.equal(preview.maps, 'standin');

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

// ── kinds, links, and marking a booking ──

test('stops have a kind, a stay its nights, a link must be plain https', () => {
  const t = cleanTrip({ title: 'Ski week', start: '2027-01-09', days: [{ stops: [
    stop('Chalet', '16:00', { kind: 'stay', nights: 6, link: 'https://example.com/chalet?id=4' }),
    stop('Ski rental', '17:00', { kind: 'rental' }),
    stop('Museum', '10:00', { nights: 3 }),
  ] }] }, { newId, now: NOW });
  const [museum, chalet, skis] = t.days[0].stops;
  assert.deepEqual([chalet.kind, chalet.nights, chalet.link], ['stay', 6, 'https://example.com/chalet?id=4']);
  assert.equal(skis.kind, 'rental');
  assert.equal(museum.kind, 'visit');
  assert.equal(museum.nights, null, 'only a stay has nights');
  for (const link of ['http://example.com', 'javascript:alert(1)', 'https://user:pw@example.com/']) {
    assert.throws(() => cleanTrip({ title: 'x', start: '2027-01-09', days: [{ stops: [stop('A', '10:00', { link })] }] }, { newId, now: NOW }), /https/, link);
  }
  assert.throws(() => cleanTrip({ title: 'x', start: '2027-01-09', days: [{ stops: [stop('A', '10:00', { kind: 'spaceship' })] }] }, { newId, now: NOW }), /kind must be/);
});

test('only the person marks a stop booked; then it is locked; unbook frees it', async () => {
  const acct = account();
  const { trip } = await tripOp(acct, 'trip-create', { trip: { title: 'Ski week', start: '2027-01-09', days: [{ stops: [stop('Chalet', '16:00', { id: 'ch', kind: 'stay', nights: 6 })] }] } });
  await assert.rejects(tripOp(acct, 'trip-mark-booked', { id: trip.id, stop: 'ch', ref: 'BK123' }), /confirm: true/);
  await assert.rejects(tripOp(acct, 'trip-mark-booked', { id: trip.id, stop: 'ch', ref: ' ', confirm: true }), /booking reference/);
  const marked = await tripOp(acct, 'trip-mark-booked', { id: trip.id, stop: 'ch', ref: 'BK123', provider: 'Chalets Ltd', via: 'browser', cost: { amount: 1400, currency: 'EUR' }, confirm: true });
  const ch = marked.trip.days[0].stops[0];
  assert.deepEqual([ch.booked.ref, ch.booked.provider, ch.booked.via, ch.booked.kind, ch.cost.amount], ['BK123', 'Chalets Ltd', 'browser', 'stay', 1400]);
  await assert.rejects(tripOp(acct, 'trip-edit', { id: trip.id, ops: [{ op: 'time', stop: 'ch', at: '15:00' }] }), (e) => e.code === 'locked');
  // a proposal can't mark anything booked: `booked` isn't an op
  await assert.rejects(tripOp(acct, 'trip-edit', { id: trip.id, ops: [{ op: 'book', stop: 'ch' }] }), /op must be/);
  const freed = await tripOp(acct, 'trip-unbook', { id: trip.id, stop: 'ch', confirm: true });
  assert.equal(freed.trip.days[0].stops[0].booked, null);
  await tripOp(acct, 'trip-edit', { id: trip.id, ops: [{ op: 'time', stop: 'ch', at: '15:00' }] });
});

test('the sample trip has a 2-night stay, transport legs and meals', () => {
  const t = cleanTrip(sampleTrip(NOW), { newId, now: NOW });
  const all = t.days.flatMap((d) => d.stops);
  const hotel = all.find((s) => s.kind === 'stay');
  assert.deepEqual([hotel.place.name, hotel.nights], ['Your hotel in Baixa', 2]);
  assert.equal(all.filter((s) => s.kind === 'transport').length, 2);
  assert.equal(all.filter((s) => s.kind === 'meal').length, 5);
});

// ── card rewards ──

test('cards: names only (a number is refused), matched to checked rates; unknown cards say so', async () => {
  const { CARDS, cleanCardNames, matchCard, compareCards } = await import('../src/travel/cards.js');
  assert.ok(CARDS.every((c) => c.source.startsWith('https://') && /^\d{4}-\d{2}-\d{2}$/.test(c.checked)), 'every card has a source and a checked date');
  assert.equal(matchCard('my Chase Sapphire Reserve®').id, 'chase-sapphire-reserve');
  assert.equal(matchCard('Capital One Venture X').id, 'capital-one-venture-x', 'Venture X, not Venture');
  assert.equal(matchCard('capital one venture').id, 'capital-one-venture');
  assert.equal(matchCard('Amex Gold').id, 'amex-gold');
  assert.equal(matchCard('Discover it'), null);
  assert.throws(() => cleanCardNames(['Visa 4111 1111 1111 1111']), /never its number/);
  assert.throws(() => cleanCardNames(['card 41111111']), /never its number/);
  assert.deepEqual(cleanCardNames(['  Amex   Gold ']), ['Amex Gold']);

  const hotel = { kind: 'stay', place: { name: 'Hotel' }, cost: { amount: 376, currency: 'EUR' } };
  const rows = compareCards(hotel, ['Sapphire Preferred', 'Sapphire Reserve', 'Venture', 'Discover it'], Date.parse('2026-11-01'));
  assert.deepEqual(rows.map((r) => r.name), ['Chase Sapphire Reserve', 'Capital One Venture', 'Chase Sapphire Preferred', 'Discover it']);
  assert.deepEqual([rows[0].rate, rows[0].back_pct], [4, 4], 'Reserve: 4x on hotels booked direct at a stated 1¢ = 4% back');
  assert.equal(rows[1].value_implied, true);
  assert.deepEqual([rows[2].rate, rows[2].back_pct], [2, null], 'Preferred: no stated value, so no % back');
  assert.equal(rows[3].known, false);
  assert.equal(compareCards(hotel, ['Sapphire Reserve'], Date.parse('2027-03-01'))[0].stale, true, 'a check older than 90 days is flagged');
  const dinner = compareCards({ kind: 'meal', place: { name: 'Dinner' } }, ['Amex Gold', 'Sapphire Preferred'], Date.parse('2026-11-01'));
  assert.deepEqual(dinner.map((r) => [r.name, r.rate]), [['American Express Gold Card', 4], ['Chase Sapphire Preferred', 3]]);
  assert.equal(compareCards({ kind: 'transport', place: { name: 'Fly home' } }, ['Amex Gold'])[0].category, 'flight');
  // a stop with no kind is guessed from its name, and says so
  const old = compareCards({ place: { name: 'Your hotel in Baixa' } }, ['Sapphire Reserve'])[0];
  assert.deepEqual([old.category, old.guessed, old.rate], ['hotel', true, 4]);
  assert.deepEqual([compareCards({ kind: 'visit', place: { name: 'Lunch in Alfama' } }, ['Amex Gold'])[0].category, compareCards({ kind: 'activity', place: { name: 'Wine bar tour' } }, ['Amex Gold'])[0].category], ['dining', 'other']);
});

test('saving cards needs the person’s confirm; trip-get then carries the comparison for each priced stop', async () => {
  const acct = account();
  const { trip } = await tripOp(acct, 'trip-sample');
  assert.deepEqual((await tripOp(acct, 'trip-get', { id: trip.id })).rewards, []);
  const m = await tripOp(acct, 'trip-cards-match', { names: ['Sapphire Reserve', 'Discover it'] });
  assert.deepEqual(m.cards.map((c) => c.known), [true, false]);
  assert.deepEqual((await tripOp(acct, 'trip-cards')).cards, [], 'match saves nothing');
  await assert.rejects(tripOp(acct, 'trip-cards-save', { names: ['Sapphire Reserve'] }), /confirm: true/);
  await tripOp(acct, 'trip-cards-save', { names: ['Sapphire Reserve', 'Amex Gold'], confirm: true });
  const got = await tripOp(acct, 'trip-get', { id: trip.id });
  const dinner = got.rewards.find((r) => r.name === 'Dinner in Chiado');
  assert.equal(dinner.category, 'dining');
  assert.equal(dinner.cards[0].name, 'Chase Sapphire Reserve', '3x at a stated 1¢ (3%) ranks above 4x with no stated value');
  assert.ok(got.rewards.every((r) => r.cost.amount > 0));
});

// ── live flight status (FlightAware AeroAPI, against a fake) ──

test('FlightAware: off without a key; the key goes in x-apikey; the right day is picked; delays in minutes', async () => {
  const { flightAwareFor, pickFlight } = await import('../src/travel/flightaware.js');
  assert.equal(flightAwareFor({}), null);
  const calls = [];
  const flight = (day, extra = {}) => ({ ident: 'TAP1351', ident_iata: 'TP1351', operator_iata: 'TP', origin: { code_iata: 'LHR', name: 'London Heathrow', city: 'London', timezone: 'Europe/London' }, destination: { code_iata: 'LIS', name: 'Humberto Delgado', city: 'Lisbon', timezone: 'Europe/Lisbon' }, scheduled_out: `${day}T06:05:00Z`, estimated_out: `${day}T06:35:00Z`, scheduled_in: `${day}T08:50:00Z`, estimated_in: `${day}T09:12:00Z`, departure_delay: 1800, arrival_delay: 1320, status: 'Scheduled / Delayed', gate_origin: 'A10', terminal_destination: '1', progress_percent: -1, cancelled: false, diverted: false, ...extra });
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/flights/XX9999')) return new Response('{}', { status: 404 });
    return Response.json({ flights: [flight('2027-06-11'), flight('2027-06-12'), flight('2027-06-13')] });
  };
  const fa = flightAwareFor({ FLIGHTAWARE_API_KEY: 'fa-test-key' }, { fetch, now: () => NOW });
  const f = await fa.track('tp 1351', '2027-06-12');
  assert.equal(calls[0].init.headers['x-apikey'], 'fa-test-key');
  assert.ok(!calls[0].url.includes('fa-test-key'));
  assert.match(calls[0].url, /^https:\/\/aeroapi\.flightaware\.com\/aeroapi\/flights\/TP1351\?ident_type=designator&start=2027-06-11&end=2027-06-14$/);
  assert.equal(f.departure.scheduled, '2027-06-12T06:05:00Z');
  assert.deepEqual([f.ident, f.origin.code, f.destination.code, f.state, f.delay_minutes.departure, f.delay_minutes.arrival, f.departure.gate, f.arrival.terminal, f.progress], ['TP1351', 'LHR', 'LIS', 'delayed', 30, 22, 'A10', '1', null]);
  assert.equal(f.source, 'FlightAware AeroAPI');
  await assert.rejects(fa.track('XX9999', '2027-06-12'), (e) => e.code === 'not_found');
  await assert.rejects(fa.track('hello world', '2027-06-12'), (e) => e.code === 'bad_ident');
  await assert.rejects(fa.track('TP1351', '12/06/2027'), (e) => e.code === 'bad_date');
  assert.equal(pickFlight([flight('2027-06-12', { cancelled: true })], '2027-06-12').cancelled, true);
  const { summary } = await import('../src/travel/flightaware.js');
  assert.equal(summary(flight('2027-06-12', { actual_out: 'x', actual_in: 'y' }), 'now').state, 'landed');
  assert.equal(summary(flight('2027-06-12', { cancelled: true }), 'now').state, 'cancelled');
});

test('trip-flight: not set up says so; a lookup is cached so a second look doesn’t pay again', async () => {
  const acct = account();
  await assert.rejects(tripOp(acct, 'trip-flight', { ident: 'TP1351', date: '2027-06-12' }), (e) => e.code === 'not_set_up');
  let n = 0;
  const flightaware = { async track(ident, date) { n++; return { ident, date, state: 'scheduled', source: 'FlightAware AeroAPI', checked_at: 'now' }; } };
  const a = await tripOp(acct, 'trip-flight', { ident: 'TP1351', date: '2027-06-12' }, { flightaware });
  const b = await tripOp(acct, 'trip-flight', { ident: 'tp 1351', date: '2027-06-12' }, { flightaware });
  assert.equal(a.flight.state, 'scheduled');
  assert.equal(b.cached, true);
  assert.equal(n, 1);
  acct.t += 3 * 60_000;
  await tripOp(acct, 'trip-flight', { ident: 'TP1351', date: '2027-06-12' }, { flightaware });
  assert.equal(n, 2, 'after 2 minutes it looks again');
});
