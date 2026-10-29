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
    { place: { id: 'ChIJp1aaaaaa', name: 'A', lat: 38.70, lng: -9.20 }, at: '10:00', minutes: 60 },
    { place: { id: 'ChIJp2aaaaaa', name: 'B', lat: 38.72, lng: -9.11 }, at: '11:30', minutes: 60, mode: 'transit' },
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
  assert.equal(b.flight.state, 'scheduled');
  assert.equal(n, 1);
  acct.t += 3 * 60_000;
  await tripOp(acct, 'trip-flight', { ident: 'TP1351', date: '2027-06-12' }, { flightaware });
  assert.equal(n, 2, 'after 2 minutes it looks again');
});

// ── confirmations from Eden Mail (a fake Gmail) ──

const b64u = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const email = (id, subject, from, html, text = '') => ({
  id, internalDate: String(Date.parse('2027-05-02T09:00:00Z')),
  payload: { mimeType: 'multipart/alternative', headers: [{ name: 'Subject', value: subject }, { name: 'From', value: from }], parts: [
    ...(text ? [{ mimeType: 'text/plain', body: { data: b64u(text) } }] : []),
    ...(html ? [{ mimeType: 'text/html', body: { data: b64u(html) } }] : []),
  ] },
});
const ld = (obj) => `<html><head><script type="application/ld+json">${JSON.stringify(obj)}</script></head><body>Thanks!</body></html>`;
function fakeMail(start) {
  const day = (n, t) => { const d = new Date(`${start}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return `${d.toISOString().slice(0, 10)}T${t}:00+01:00`; };
  const box = {
    hotel: email('m-hotel', 'Your booking is confirmed', '"Example Hotels" <no-reply@hotels.example>', ld({ '@context': 'http://schema.org', '@type': 'LodgingReservation', reservationNumber: 'HB-2231', reservationStatus: 'http://schema.org/ReservationConfirmed', checkinTime: day(0, '15:00'), checkoutTime: day(2, '11:00'), totalPrice: '376.00', priceCurrency: 'EUR', reservationFor: { '@type': 'LodgingBusiness', name: 'Hotel Baixa Example', address: { streetAddress: 'Rua Augusta 1', addressLocality: 'Lisboa' }, geo: { latitude: 38.7118, longitude: -9.1384 } }, provider: { name: 'Example Hotels' } })),
    flight: email('m-flight', 'E-ticket TP1351', 'TAP <tickets@tap.example>', ld([{ '@type': 'FlightReservation', reservationNumber: 'ABC123', reservationFor: { '@type': 'Flight', flightNumber: '1351', airline: { '@type': 'Airline', name: 'TAP Air Portugal', iataCode: 'TP' }, departureAirport: { '@type': 'Airport', name: 'London Heathrow', iataCode: 'LHR' }, departureTime: day(0, '06:05'), arrivalAirport: { '@type': 'Airport', name: 'Lisbon', iataCode: 'LIS' }, arrivalTime: day(0, '08:50') } }])),
    tour: email('m-tour', 'Your tuk-tuk tour', 'Tours <hi@tours.example>', '<p>Thanks for booking!</p>', 'Booking reference: TK48812\nSee you soon.'),
    news: email('m-news', 'Our newsletter', 'Shop <news@shop.example>', '<p>Big sale</p>'),
    later: email('m-later', 'Ski chalet confirmed', 'Chalets <c@chalets.example>', ld({ '@type': 'LodgingReservation', reservationNumber: 'CH-9', checkinTime: '2031-01-09T16:00:00', checkoutTime: '2031-01-15T10:00:00', reservationFor: { name: 'Chalet' } })),
  };
  const reads = [];
  return { reads, mail: { async search() { return Object.values(box).map((m) => m.id); }, async full(id) { reads.push(id); const m = Object.values(box).find((x) => x.id === id); if (!m) throw new Error('gone'); return m; } } };
}

test('confirmations: schema.org reservations are read field by field; plain mail gives a reference only', async () => {
  const { bookingsIn, messageParts, jsonLdReservations } = await import('../src/travel/confirmations.js');
  const { mail } = fakeMail('2027-06-05');
  const hotel = bookingsIn(messageParts(await mail.full('m-hotel')))[0];
  assert.deepEqual([hotel.kind, hotel.ref, hotel.provider, hotel.date, hotel.at, hotel.nights, hotel.cost, hotel.place.name, hotel.status, hotel.structured], ['stay', 'HB-2231', 'Example Hotels', '2027-06-05', '15:00', 2, { amount: 376, currency: 'EUR' }, 'Hotel Baixa Example', 'ReservationConfirmed', true]);
  const flight = bookingsIn(messageParts(await mail.full('m-flight')))[0];
  assert.deepEqual([flight.kind, flight.flight, flight.ref, flight.provider, flight.at], ['transport', 'TP1351', 'ABC123', 'TAP Air Portugal', '06:05']);
  const tour = bookingsIn(messageParts(await mail.full('m-tour')))[0];
  assert.deepEqual([tour.ref, tour.provider, tour.date, tour.structured], ['TK48812', 'Tours', null, false]);
  assert.deepEqual(bookingsIn(messageParts(await mail.full('m-news'))), []);
  assert.deepEqual(jsonLdReservations('<script type="application/ld+json">{not json</script>'), [], 'broken JSON is skipped, not thrown');
});

test('Eden Mail scan finds the trip’s bookings; import re-reads the email and marks or adds, only on confirm', async () => {
  const acct = account();
  const { trip } = await tripOp(acct, 'trip-sample');
  const { mail, reads } = fakeMail(trip.start);
  const scan = await tripOp(acct, 'trip-mail-scan', { id: trip.id }, { mail });
  assert.equal(scan.scanned, 5);
  const by = Object.fromEntries(scan.candidates.map((c) => [c.message, c]));
  assert.equal(by['m-hotel'].match.action, 'mark', 'the hotel email confirms the trip’s hotel stop');
  assert.equal(by['m-flight'].match.action, 'mark');
  assert.equal(by['m-tour'].match.action, 'none', 'no date: Eden asks which stop');
  assert.equal(by['m-later'], undefined, 'a booking outside the trip is left out');
  assert.equal(by['m-news'], undefined);
  assert.equal((await tripOp(acct, 'trip-get', { id: trip.id })).trip.rev, 1, 'a scan changes nothing');

  await assert.rejects(tripOp(acct, 'trip-mail-import', { id: trip.id, message: 'm-hotel', index: 0 }, { mail }), /confirm: true/);
  reads.length = 0;
  // whatever the client says about the booking is ignored: the server reads the email again
  const done = await tripOp(acct, 'trip-mail-import', { id: trip.id, message: 'm-hotel', index: 0, confirm: true, ref: 'FAKE', cost: { amount: 1, currency: 'EUR' } }, { mail });
  assert.deepEqual(reads, ['m-hotel']);
  const hotel = done.trip.days[0].stops.find((s) => s.id === done.stop);
  assert.deepEqual([hotel.place.name, hotel.booked.ref, hotel.booked.via, hotel.booked.provider, hotel.cost.amount], ['Your hotel in Baixa', 'HB-2231', 'mail', 'Example Hotels', 376]);
  await assert.rejects(tripOp(acct, 'trip-edit', { id: trip.id, ops: [{ op: 'remove', stop: hotel.id }] }), (e) => e.code === 'locked');

  // a dated booking with no stop to confirm is added, booked
  const t2 = (await tripOp(acct, 'trip-create', { trip: { title: 'x', start: trip.start, days: [{ stops: [] }] } })).trip;
  const added = await tripOp(acct, 'trip-mail-import', { id: t2.id, message: 'm-flight', index: 0, confirm: true }, { mail });
  const f = added.trip.days[0].stops[0];
  assert.deepEqual([f.kind, f.at, f.minutes, f.booked.ref], ['transport', '06:05', 165, 'ABC123']);
  assert.match(f.note, /^From Eden Mail: E-ticket TP1351/);
  // no date: needs the person to say which stop
  await assert.rejects(tripOp(acct, 'trip-mail-import', { id: trip.id, message: 'm-tour', index: 0, confirm: true }, { mail }), (e) => e.code === 'no_match');
  const tourStop = done.trip.days[1].stops[3].id;
  const tour = await tripOp(acct, 'trip-mail-import', { id: trip.id, message: 'm-tour', index: 0, stop: tourStop, confirm: true }, { mail });
  assert.equal(tour.trip.days[1].stops.find((s) => s.id === tourStop).booked.ref, 'TK48812');
});

test('Eden Mail not connected: says so plainly', async () => {
  const acct = account();
  const { trip } = await tripOp(acct, 'trip-sample');
  await assert.rejects(tripOp(acct, 'trip-mail-scan', { id: trip.id }), (e) => e.code === 'not_connected' && /Connect Gmail in Eden Mail/.test(e.message));
});

test('trip-flight-live: airport points kept a month, the plane’s position at most every 5 minutes, none once landed', async () => {
  const acct = account();
  let pos = 0, ap = 0;
  let state = 'in_air';
  const flightaware = {
    async track(ident) { return { ident, fa_flight_id: 'TAP1351-1780000000-schedule-0001', state, origin: { code: 'LHR' }, destination: { code: 'LIS' }, source: 'FlightAware AeroAPI', checked_at: 'now' }; },
    async airport(code) { ap++; return code === 'LHR' ? { code, lat: 51.47, lng: -0.4543 } : { code, lat: 38.7742, lng: -9.1342 }; },
    async position() { pos++; return { lat: 45.1, lng: -5.2, heading: 200, altitude_ft: 36000, speed_kts: 450, at: 'now' }; },
  };
  const a = await tripOp(acct, 'trip-flight-live', { ident: 'TP1351', date: '2027-06-12' }, { flightaware });
  assert.deepEqual([a.from.code, a.to.code, a.position.altitude_ft, a.refresh_s], ['LHR', 'LIS', 36000, 300]);
  acct.t += 3 * 60_000; // the flight status refreshes (2 min), the position doesn't yet (5 min)
  await tripOp(acct, 'trip-flight-live', { ident: 'TP1351', date: '2027-06-12' }, { flightaware });
  assert.deepEqual([pos, ap], [1, 2]);
  acct.t += 3 * 60_000;
  await tripOp(acct, 'trip-flight-live', { ident: 'TP1351', date: '2027-06-12' }, { flightaware });
  assert.deepEqual([pos, ap], [2, 2], 'a new position after 5 minutes; airports still from the cache');
  state = 'landed';
  acct.t += 3 * 60_000;
  const landed = await tripOp(acct, 'trip-flight-live', { ident: 'TP1351', date: '2027-06-12' }, { flightaware });
  assert.deepEqual([landed.position, landed.refresh_s, pos], [null, null, 2], 'no position look once landed');
});

test('FlightAware position and airport: spec field names and units (altitude in hundreds of feet, speed in knots)', async () => {
  const { flightAwareFor } = await import('../src/travel/flightaware.js');
  const urls = [];
  const fetch = async (url) => {
    urls.push(String(url));
    if (String(url).endsWith('/position')) return Response.json({ fa_flight_id: 'X', last_position: { latitude: 45.1, longitude: -5.2, heading: 201, altitude: 360, groundspeed: 452, timestamp: '2027-06-12T07:30:00Z' } });
    if (String(url).includes('/airports/LIS')) return Response.json({ airport_code: 'LPPT', code_iata: 'LIS', name: 'Humberto Delgado', latitude: 38.7742, longitude: -9.1342, country_code: 'PT' });
    return new Response('{}', { status: 404 });
  };
  const fa = flightAwareFor({ FLIGHTAWARE_API_KEY: 'k' }, { fetch });
  assert.deepEqual(await fa.position('TAP1351-1780000000-schedule-0001'), { lat: 45.1, lng: -5.2, heading: 201, altitude_ft: 36000, speed_kts: 452, at: '2027-06-12T07:30:00Z' });
  assert.deepEqual(await fa.airport('lis'), { code: 'LIS', name: 'Humberto Delgado', lat: 38.7742, lng: -9.1342, country: 'PT' });
  assert.match(urls[0], /\/aeroapi\/flights\/TAP1351-1780000000-schedule-0001\/position$/);
  await assert.rejects(fa.position('../x'), (e) => e.code === 'bad_ident');
  await assert.rejects(fa.airport('LONDON'), (e) => e.code === 'bad_ident');
});

test('in-flight map: the view fits both airports; the picture comes through the server, the key never in the answer', async () => {
  const { fitView, worldPx, MAP_SIZE } = await import('../src/travel/maps.js');
  const lhr = { lat: 51.47, lng: -0.4543 }, lis = { lat: 38.7742, lng: -9.1342 };
  const v = fitView(lhr, lis);
  const c = worldPx(v.center.lat, v.center.lng, v.zoom);
  for (const p of [lhr, lis]) {
    const w = worldPx(p.lat, p.lng, v.zoom);
    assert.ok(Math.abs(w.x - c.x) <= MAP_SIZE.w / 2 - MAP_SIZE.pad + 1 && Math.abs(w.y - c.y) <= MAP_SIZE.h / 2 - MAP_SIZE.pad + 1, 'both airports inside the frame, with room');
  }
  assert.ok(v.zoom >= 3 && v.zoom <= 6, `a London–Lisbon view, got zoom ${v.zoom}`);
  const across = fitView({ lat: 35.55, lng: 139.78 }, { lat: 37.62, lng: -122.38 }); // Tokyo → San Francisco, the short way over the Pacific
  assert.ok(Math.abs(across.center.lng) > 150, `centred over the Pacific, got ${across.center.lng}`);

  const seen = [];
  const deps = { call: async () => ({}), limited: async () => {}, readBody: async (r) => r.json(), fetch: async (url) => { seen.push(String(url)); return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }); } };
  const who = { account: 'acct-1', token: {} };
  const req = (q) => new Request(`https://askeden.com/api/chat/travel/map?${q}`);
  await assert.rejects(travelApi(req('a=51.47,-0.45&b=38.77,-9.13'), { EDEN_TRAVEL: '1' }, who, '/api/chat/travel/map', deps), (e) => e.status === 404, 'no key: not set up');
  const env = { EDEN_TRAVEL: '1', GOOGLE_MAPS_SERVER_KEY: 'server-key' };
  const res = await travelApi(req('a=51.47,-0.4543&b=38.7742,-9.1342'), env, who, '/api/chat/travel/map', deps);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-map-zoom'), String(v.zoom));
  assert.match(seen[0], /^https:\/\/maps\.googleapis\.com\/maps\/api\/staticmap\?/);
  assert.ok(![...res.headers.values()].some((h) => h.includes('server-key')), 'the key is never in what the page gets');
  await assert.rejects(travelApi(req('a=bad&b=38.77,-9.13'), env, who, '/api/chat/travel/map', deps), (e) => e.status === 400);
});

test('day map: many points fit in the frame; one point gets a street-level view', async () => {
  const { fitPoints, worldPx, MAP_SIZE } = await import('../src/travel/maps.js');
  const day = [{ lat: 38.7167, lng: -9.1484 }, { lat: 38.6979, lng: -9.2068 }, { lat: 38.6975, lng: -9.2032 }, { lat: 38.7034, lng: -9.1785 }, { lat: 38.7071, lng: -9.1458 }];
  const v = fitPoints(day);
  const c = worldPx(v.center.lat, v.center.lng, v.zoom);
  for (const p of day) {
    const w = worldPx(p.lat, p.lng, v.zoom);
    assert.ok(Math.abs(w.x - c.x) <= MAP_SIZE.w / 2 - MAP_SIZE.pad + 1 && Math.abs(w.y - c.y) <= MAP_SIZE.h / 2 - MAP_SIZE.pad + 1);
  }
  assert.ok(v.zoom >= 11 && v.zoom <= 14, `a Lisbon day, got zoom ${v.zoom}`);
  assert.equal(fitPoints([{ lat: 38.7, lng: -9.14 }]).zoom, 14);
});

test('live maps on: a sample place is still labelled a sample, never "checked by Google"; the map picture takes size, centre, zoom and style', async () => {
  const { mapsFor, flightMapImage } = await import('../src/travel/maps.js');
  const maps = mapsFor({ GOOGLE_MAPS_SERVER_KEY: 'k' }, { fetch: async () => { throw new Error('no Google call for a sample'); } });
  const p = await maps.place('standin:tiles');
  assert.deepEqual([p.standin, /Stand-in/.test(p.source)], [true, true]);
  const seen = [];
  const fetch = async (url) => { seen.push(new URL(String(url))); return new Response(new Uint8Array([137, 80]), { headers: { 'content-type': 'image/png' } }); };
  const res = await flightMapImage({ GOOGLE_MAPS_SERVER_KEY: 'k' }, new URL('https://x/api/chat/travel/map?p=38.71,-9.14|38.70,-9.20&w=400&h=300&style=day&z=13&c=38.705,-9.17'), { fetch });
  assert.equal(res.headers.get('x-map-zoom'), '13');
  assert.equal(seen[0].searchParams.get('size'), '400x300');
  assert.equal(seen[0].searchParams.get('center'), '38.705,-9.17');
  assert.ok(seen[0].searchParams.getAll('style').some((x) => x.includes('poi.business')), 'the light day style');
  await flightMapImage({ GOOGLE_MAPS_SERVER_KEY: 'k' }, new URL('https://x/api/chat/travel/map?p=38.71,-9.14&w=9999&z=99'), { fetch });
  assert.equal(seen[1].searchParams.get('size'), '640x320', 'sizes clamped; a silly zoom falls back to the fitted one');
});

test('a stop’s photo: Google’s first photo with its photographer, fetched through the Worker with the key kept server side', async () => {
  const { placePhoto } = await import('../src/travel/maps.js');
  const name = 'places/ChIJ0123456789/photos/AbCdEfGhIjKlMn';
  const g = fromGooglePlace({ id: 'ChIJ0123456789', photos: [{ name, authorAttributions: [{ displayName: 'Ana M.', uri: 'https://maps.google.com/contrib/1' }] }] }, 'now');
  assert.deepEqual(g.photo, { name, by: 'Ana M.', by_url: 'https://maps.google.com/contrib/1' });
  assert.equal(fromGooglePlace({ id: 'x', photos: [{ name: '../evil' }] }, 'now').photo, null, 'only a real photo name');
  const seen = [];
  const fetch = async (url) => { seen.push(new URL(String(url))); return new Response(new Uint8Array([255, 216]), { headers: { 'content-type': 'image/jpeg' } }); };
  const res = await placePhoto({ GOOGLE_MAPS_SERVER_KEY: 'k' }, new URL(`https://x/api/chat/travel/photo?n=${encodeURIComponent(name)}&w=5000`), { fetch });
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal(seen[0].pathname, `/v1/${name}/media`);
  assert.equal(seen[0].searchParams.get('maxWidthPx'), '1600', 'width clamped (1600: the stop detail’s photo)');
  await assert.rejects(placePhoto({ GOOGLE_MAPS_SERVER_KEY: 'k' }, new URL('https://x/api/chat/travel/photo?n=https://evil.example/x'), { fetch }), /photo name/);
  await assert.rejects(placePhoto({}, new URL(`https://x/api/chat/travel/photo?n=${encodeURIComponent(name)}`), { fetch }), /Google Maps on Eden/);
});

test('a whole trip planned in one card: its named places are found near the destination, flights are not looked up', async () => {
  const { locate } = await import('../src/travel/ops.js');
  const seen = [];
  const maps = { search: async (q) => { seen.push(q); return /^Lisbon$/.test(q) ? [{ id: 'city', name: 'Lisbon', lat: 38.72, lng: -9.14 }] : /Ramiro/.test(q) ? [{ id: 'ChIJramiro', name: 'Cervejaria Ramiro', lat: 38.721, lng: -9.135 }] : /Tower/.test(q) ? [{ id: 'far', name: 'Some Tower', lat: 51.5, lng: -0.12 }] : []; } };
  const t = { title: 'Lisbon', destination: 'Lisbon', start: '2027-05-12', days: [{ stops: [
    { kind: 'transport', place: { name: 'BA500 London Heathrow → Lisbon' } },
    { kind: 'meal', place: { name: 'Cervejaria Ramiro' } },
    { kind: 'activity', place: { name: 'Belem Tower' } },
    { kind: 'visit', place: { id: 'ChIJkept', name: 'Already found' } },
  ] }] };
  await locate(t, maps);
  const s = t.days[0].stops;
  assert.deepEqual(s[1].place, { id: 'ChIJramiro', name: 'Cervejaria Ramiro', lat: 38.721, lng: -9.135 });
  assert.deepEqual(s[2].place, { name: 'Belem Tower' }, 'a hit 2,000 km away is not taken');
  assert.equal(s[3].place.id, 'ChIJkept');
  assert.ok(!seen.some((q) => /BA500/.test(q)), 'a flight is not a place to look up');
  assert.deepEqual(seen.slice(1).sort(), ['Belem Tower, Lisbon', 'Cervejaria Ramiro, Lisbon']);
});

test('stand-in maps answer for Lisbon only: a Tokyo "hotel" is never "A hotel in Baixa"', async () => {
  const m = standinMaps(() => NOW);
  assert.deepEqual(await m.search('hotel'), []);
  assert.deepEqual(await m.search('Hotel near Shinjuku station'), []);
  assert.deepEqual(await m.search('hotel', { lat: 35.69, lng: 139.70 }), []); // near Tokyo
  assert.equal((await m.search('hotel in Lisbon'))[0].id, 'standin:baixa-hotel');
  assert.equal((await m.search('hotel', { lat: 38.71, lng: -9.14 }))[0].id, 'standin:baixa-hotel');
  assert.equal((await m.search('Jerónimos'))[0].id, 'standin:jeronimos');
});

test('a leg too long for one day says a stop is in the wrong place, never "you’d arrive 85877 min late"', async () => {
  const trip = cleanTrip(sampleTrip(NOW), { newId, now: NOW });
  const far = { lat: 35.69, lng: 139.70 };
  const maps = { ...standinMaps(() => NOW), travel: async () => ({ minutes: 85877, mode: 'walk', standin: false, source: 'test', checked_at: new Date(NOW).toISOString() }) };
  trip.days[0].stops[0].place = { ...trip.days[0].stops[0].place, ...far };
  const c = await checkTrip(trip, maps);
  assert.ok(!c.alerts.some((a) => a.kind === 'late'));
  const b = c.days[0].stops[1].badges.travel;
  assert.equal(b.status, 'look');
  assert.match(b.text, /wrong place/);
});

test('only Google place ids go to Google: a made-up id is found by its name near its point; Lisbon samples in a Tokyo trip are flagged', async () => {
  const { isGoogleId, strayStandin } = await import('../src/travel/maps.js');
  assert.ok(isGoogleId('ChIJCewJkL2LGGAR3Qmk0vCTGkg'));
  assert.ok(!isGoogleId('tokyo-tower'));
  assert.ok(!isGoogleId('national-tile-museum-tokyo'));
  assert.ok(strayStandin({ destination: 'Tokyo, Japan' }, { id: 'standin:tiles' }));
  assert.ok(!strayStandin({ destination: 'Lisbon' }, { id: 'standin:tiles' }));
  const asked = [];
  const tower = { id: 'ChIJCewJkL2LGGAR3Qmk0vCTGkg', name: 'Tokyo Tower', lat: 35.6586, lng: 139.7454, status: 'open', hours: null, source: 'Google Maps', checked_at: new Date(NOW).toISOString() };
  const maps = {
    mode: 'google',
    async place(id) { asked.push(`place:${id}`); if (!isGoogleId(id)) throw new Error('400'); return tower; },
    async search(q) { asked.push(`search:${q}`); return [tower]; },
    async travel(a, b, mode) { asked.push(`travel:${a.id}>${b.id}`); return { minutes: 12, mode, standin: false, source: 'Google Maps (Routes API)', checked_at: new Date(NOW).toISOString() }; },
  };
  const trip = cleanTrip({ title: 'Tokyo', destination: 'Tokyo, Japan', start: '2027-05-03', travelers: 1, days: [{ stops: [
    { at: '10:00', place: { id: 'tokyo-tower', name: 'Tokyo Tower', lat: 35.6586, lng: 139.7454 } },
    { at: '12:00', place: { id: 'standin:tiles', name: 'National Tile Museum', lat: 38.7247, lng: -9.1135 } },
    { at: '15:00', place: { id: 'ChIJCewJkL2LGGAR3Qmk0vCTGkg', name: 'Tokyo Tower', lat: 35.6586, lng: 139.7454 } },
  ] }] }, { newId, now: NOW });
  const c = await checkTrip(trip, maps);
  assert.ok(asked.includes('search:Tokyo Tower'), 'the made-up id is looked up by name');
  assert.ok(!asked.includes('place:tokyo-tower') && !asked.includes('place:standin:tiles'));
  assert.ok(!asked.some((x) => x.includes('standin:tiles')), 'no travel to the Lisbon sample');
  assert.equal(c.days[0].stops[0].badges.hours.status === 'unknown' && /isn’t linked/.test(c.days[0].stops[0].badges.hours.text), false);
  assert.ok(JSON.stringify(c.days[0].stops[1].badges).includes('Lisbon sample data'));
});

test('Japan: train and metro legs are estimated (Google has none there), shown as an estimate, never as checked', async () => {
  const { inJapan, japanTransit, mapsFor } = await import('../src/travel/maps.js');
  const hama = { lat: 35.660, lng: 139.763 }, tower = { lat: 35.6586, lng: 139.7454 }, kyoto = { lat: 34.9858, lng: 135.7588 };
  assert.ok(inJapan(hama) && inJapan(kyoto) && inJapan({ lat: 43.06, lng: 141.35 }) && inJapan({ lat: 26.21, lng: 127.68 }));
  assert.ok(!inJapan({ lat: 37.57, lng: 126.98 }) && !inJapan({ lat: 35.18, lng: 129.08 }) && !inJapan({ lat: 43.12, lng: 131.89 }) && !inJapan({ lat: 25.03, lng: 121.56 }));
  const near = japanTransit(hama, tower), far = japanTransit({ lat: 35.681, lng: 139.767 }, kyoto);
  assert.ok(near.estimate && near.minutes >= 15 && near.minutes <= 30, `in town: ${near.minutes}`);
  assert.ok(far.minutes >= 150 && far.minutes <= 210, `Tokyo → Kyoto: ${far.minutes}`);
  let calls = 0;
  const m = mapsFor({ GOOGLE_MAPS_SERVER_KEY: 'k' }, { fetch: async () => { calls++; return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); } });
  const t = await m.travel({ id: null, ...hama }, { id: null, ...tower }, 'transit');
  assert.equal(calls, 0, 'no Google call for a leg it has no answer for');
  assert.ok(t.estimate && /no train times in Japan/.test(t.source));
});
