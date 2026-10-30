// How often Eden Travel's checks turned out wrong (src/travel/accuracy.js): "This was wrong" reports, "changed after
// checking" at a re-check, the hourly batch to the global index and the plain sentences the page shows. Fake storage,
// fake clock and a fake global object; nothing here reaches Google.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './fakes.js';
import { queued } from '../src/accounts/schedule.js';
import { ACCURACY, GLOBAL, accuracyFlush, accuracyIndexOp, accuracyOp, accuracyRows, changedAfterChecking, checkSnapshot, countable, noteChecks, noteWindow, rateText, snapValue } from '../src/travel/accuracy.js';

const T0 = Date.parse('2026-10-20T09:00:00Z');
const H = 3600_000;
const account = (env = {}) => ({ storage: new Storage(), env, t: T0, now() { return this.t; } });
const TRIP_ID = '0123456789abcdef';
const PLACES = 'Google Maps (Places API)', ROUTES = 'Google Maps (Routes API)';

const trip = (o = {}) => ({
  title: 'Lisbon', start: '2026-11-02', travelers: 2,
  days: [{ stops: [
    { id: 's-a', kind: 'visit', place: { id: 'ChIJa', name: 'Belém Tower' }, at: '10:00', minutes: 60, mode: 'walk', ...o.a },
    { id: 's-b', kind: 'visit', place: { id: 'ChIJb', name: 'Jerónimos Monastery' }, at: '11:30', minutes: 90, mode: 'walk', ...o.b },
  ] }],
});
const badge = (status, source = PLACES, extra = {}) => ({ status, text: `${status} text`, source, checked_at: '2026-10-20T08:00:00.000Z', ...extra });
const checks = ({ hoursB = badge('ok'), travelB = badge('ok', ROUTES), priceB = badge('look', null), maps = 'google' } = {}) => ({
  maps,
  days: [{ day: 0, date: '2026-11-02', stops: [
    { stop: 's-a', badges: { hours: badge('ok'), price: badge('look', null) } },
    { stop: 's-b', badges: { travel: travelB, hours: hoursB, price: priceB } },
  ] }],
});
const kindsOf = (snap) => Object.values(snap).map((v) => snapValue(v).kind).sort();

// the global object, reached through a fake ACCOUNTS namespace as track.js's ask() does
function withGlobal() {
  const global = account();
  const env = { ACCOUNTS: { idFromName: (n) => n, get: (n) => ({ fetch: async (url, init) => {
    assert.equal(n, GLOBAL);
    try { return Response.json(await accuracyIndexOp(global, new URL(url).pathname.slice(1), JSON.parse(init.body))); } catch (e) { return Response.json({ error: e.message, code: e.code }, { status: e.status || 500 }); }
  } }) } };
  return { global, env };
}

test('only checks against a live source count: no samples, no stand-in maps, not the person’s own figures', () => {
  assert.equal(countable(badge('ok')), true);
  assert.equal(countable(badge('warn', ROUTES)), true);
  assert.equal(countable(badge('sample')), false);
  assert.equal(countable(badge('unknown')), false);
  assert.equal(countable(badge('ok', 'Your booking')), false);
  assert.equal(countable(badge('look', 'Trip estimate')), false);
  assert.equal(countable(badge('look', null)), false);
  assert.deepEqual(kindsOf(checkSnapshot(trip(), checks())), ['hours', 'hours', 'travel']);
  assert.deepEqual(checkSnapshot(trip(), checks({ maps: 'standin' })), {});
});

test('changed after checking: ok then a problem for the same place, day and plan; never the person’s own change', () => {
  const before = checkSnapshot(trip(), checks());
  assert.deepEqual(changedAfterChecking(before, checkSnapshot(trip(), checks({ hoursB: badge('warn') }))), [{ kind: 'hours', source: 'google_places' }]);
  // look → warn, warn → warn: not a change from a checked "fine"
  assert.deepEqual(changedAfterChecking(checkSnapshot(trip(), checks({ hoursB: badge('look') })), checkSnapshot(trip(), checks({ hoursB: badge('warn') }))), []);
  // the person moved the visit later: a different check, not "changed after checking"
  assert.deepEqual(changedAfterChecking(before, checkSnapshot(trip({ b: { at: '18:30' } }), checks({ hoursB: badge('warn') }))), []);
  // another place on the stop: not the same check either
  assert.deepEqual(changedAfterChecking(before, checkSnapshot(trip({ b: { place: { id: 'ChIJz', name: 'Other' } } }), checks({ hoursB: badge('warn') }))), []);
  // travel time gone late with the same stops and times: counted as travel
  assert.deepEqual(changedAfterChecking(before, checkSnapshot(trip(), checks({ travelB: badge('warn', ROUTES) }))), [{ kind: 'travel', source: 'google_routes' }]);
});

test('shown counts each check once a month; a re-check counts changes but nothing as shown', async () => {
  const a = account();
  assert.deepEqual(await noteChecks(a, TRIP_ID, trip(), checks()), { shown: 3, changed: 0 });
  assert.deepEqual(await noteChecks(a, TRIP_ID, trip(), checks()), { shown: 0, changed: 0 }); // opened again: not again
  const job = (await queued(a)).find((j) => j.kind === 'taccflush');
  assert.ok(job && job.at >= T0 + ACCURACY.batchMs);
  // the re-check (recheck.js): hours changed since
  assert.deepEqual(await noteChecks(a, TRIP_ID, trip(), checks({ hoursB: badge('warn') }), { shown: false }), { shown: 0, changed: 1 });
  assert.deepEqual(await noteChecks(a, TRIP_ID, trip(), checks({ hoursB: badge('warn') }), { shown: false }), { shown: 0, changed: 0 }); // counted once
  const q = await a.storage.get('taccq');
  assert.deepEqual(q.counts, { '2026-10': { 'hours:google_places': [2, 0, 1], 'travel:google_routes': [1, 0, 0] } });
  // next month the same checks count as shown again
  a.t = Date.parse('2026-11-01T08:00:00Z');
  assert.equal((await noteChecks(a, TRIP_ID, trip(), checks({ hoursB: badge('warn') }))).shown, 3);
  // stand-in maps: nothing
  assert.deepEqual(await noteChecks(a, TRIP_ID, trip(), checks({ maps: 'standin' })), { shown: 0, changed: 0 });
  // a booking window found on the venue's site: once per stop and opening date
  assert.equal(await noteWindow(a, TRIP_ID, { found: true, stop: 's-b', opens_on: '2026-10-03' }), true);
  assert.equal(await noteWindow(a, TRIP_ID, { found: true, stop: 's-b', opens_on: '2026-10-03' }), false);
  assert.equal(await noteWindow(a, TRIP_ID, { found: false, stop: 's-a' }), false);
});

test('“This was wrong”: kept with the check as shown; samples and the person’s own figures refused; once per check', async () => {
  const { env } = withGlobal();
  const a = account(env);
  await a.storage.put(`trip:${TRIP_ID}`, trip());
  let current = checks({ priceB: badge('ok', 'Your booking') });
  const deps = { check: async () => current };
  const { report } = await accuracyOp(a, 'trip-check-report', { id: TRIP_ID, stop: 's-b', check: 'hours', note: '  Closed when\nwe got there ', actual: 'Closed on Mondays' }, deps);
  assert.equal(report.place.name, 'Jerónimos Monastery');
  assert.equal(report.place.id, 'ChIJb');
  assert.equal(report.date, '2026-11-02');
  assert.deepEqual(report.shown, { status: 'ok', text: 'ok text', source: PLACES, checked_at: '2026-10-20T08:00:00.000Z' });
  assert.equal(report.note, 'Closed when we got there');
  assert.equal(report.actual, 'Closed on Mondays');
  // the same check again: words updated, not counted twice
  const again = await accuracyOp(a, 'trip-check-report', { id: TRIP_ID, stop: 's-b', check: 'hours', actual: 'Closed all day' }, deps);
  assert.equal(again.again, true);
  assert.equal(again.report.id, report.id);
  assert.equal(again.report.note, 'Closed when we got there');
  assert.deepEqual((await a.storage.get('taccq')).counts, { '2026-10': { 'hours:google_places': [0, 1, 0] } });
  await assert.rejects(accuracyOp(a, 'trip-check-report', { id: TRIP_ID, stop: 's-b', check: 'price' }, deps), /your own figure/);
  await assert.rejects(accuracyOp(a, 'trip-check-report', { id: TRIP_ID, stop: 's-a', check: 'travel' }, deps), /didn’t check/);
  await assert.rejects(accuracyOp(a, 'trip-check-report', { id: TRIP_ID, stop: 's-a', check: 'window' }, deps), /hasn’t found/);
  await assert.rejects(accuracyOp(a, 'trip-check-report', { id: TRIP_ID, stop: 's-x', check: 'hours' }, deps), /no such stop/);
  await assert.rejects(accuracyOp(a, 'trip-check-report', { id: TRIP_ID, stop: 's-b', check: 'vibes' }, deps), /check must be/);
  current = checks({ hoursB: badge('sample') });
  await assert.rejects(accuracyOp(a, 'trip-check-report', { id: TRIP_ID, stop: 's-b', check: 'hours' }, deps), /sample data/);
  // a booking window: from the venue's own page, as plan.js kept it
  await a.storage.put(`twin:${TRIP_ID}:s-a`, { stop: 's-a', found: true, days_ahead: 30, opens_on: '2026-10-03', opens_at: '10:00', quote: 'Tickets go on sale 30 days ahead at 10:00.', url: 'https://example.org/tickets', source: 'The venue’s own website', checked_at: '2026-10-19T10:00:00.000Z' });
  const w = await accuracyOp(a, 'trip-check-report', { id: TRIP_ID, stop: 's-a', check: 'window', actual: 'Sold out 60 days ahead' }, deps);
  assert.match(w.report.shown.text, /30 days ahead \(2026-10-03 at 10:00\)/);
  // the list: newest first, this trip's or all; the global rates alongside
  const list = await accuracyOp(a, 'trip-check-reports', { id: TRIP_ID }, deps);
  assert.deepEqual(list.reports.map((r) => r.check).sort(), ['hours', 'window']);
  assert.ok(list.global && Array.isArray(list.global.rows));
  // taken back: gone, and the count goes down again
  assert.deepEqual(await accuracyOp(a, 'trip-check-unreport', { report: report.id }, deps), { removed: true });
  assert.deepEqual((await a.storage.get('taccq')).counts['2026-10']['hours:google_places'], [0, 0, 0]);
  await assert.rejects(accuracyOp(a, 'trip-check-unreport', { report: report.id }, deps), /No such report/);
});

test('reports: at most ACCURACY.reports kept, the oldest dropped', async () => {
  const a = account();
  for (let i = 0; i < ACCURACY.reports + 3; i++) await a.storage.put(`tacr:${String(i).padStart(12, '0')}`, { id: String(i).padStart(12, '0'), trip: TRIP_ID, stop: 'old', check: 'hours', shown: { text: String(i) }, at: T0 - 1e9 + i });
  await a.storage.put(`trip:${TRIP_ID}`, trip());
  await accuracyOp(a, 'trip-check-report', { id: TRIP_ID, stop: 's-b', check: 'hours' }, { check: async () => checks() });
  const all = [...(await a.storage.list({ prefix: 'tacr:' })).values()];
  assert.equal(all.length, ACCURACY.reports);
  assert.ok(!all.some((r) => r.shown.text === '0'));
});

test('the batch: at most hourly, counts only (no place, trip or account), and the global index adds them up', async () => {
  const { global, env } = withGlobal();
  const a = account(env);
  await a.storage.put('account', { id: 'acct-1' });
  await a.storage.put(`trip:${TRIP_ID}`, trip());
  await noteChecks(a, TRIP_ID, trip(), checks());
  await accuracyOp(a, 'trip-check-report', { id: TRIP_ID, stop: 's-b', check: 'hours', note: 'Jerónimos was shut' }, { check: async () => checks() });
  const sent = [];
  const send = async (counts) => { sent.push(JSON.stringify(counts)); return accuracyIndexOp(global, 'tacc-add', { counts }); };
  assert.equal(await accuracyFlush(a, { send }), undefined);
  assert.equal(sent.length, 1);
  for (const words of ['Jer', 'ChIJ', TRIP_ID, 'acct-1', 'Lisbon', 'shut']) assert.ok(!sent[0].includes(words), words);
  assert.equal(await a.storage.get('taccq'), undefined);
  // more within the hour waits for the hour
  a.t += 10 * 60_000;
  await noteChecks(a, 'fedcba9876543210', trip(), checks());
  assert.equal(await accuracyFlush(a, { send }), T0 + H);
  assert.equal(sent.length, 1);
  a.t = T0 + H;
  await accuracyFlush(a, { send });
  assert.equal(sent.length, 2);
  // a failed send keeps the counts for the next try
  await noteChecks(a, TRIP_ID, trip(), checks({ hoursB: badge('warn') }), { shown: false });
  a.t += H;
  await assert.rejects(accuracyFlush(a, { send: async () => { throw new Error('down'); } }), /down/);
  assert.ok(await a.storage.get('taccq'));
  const { months } = await accuracyIndexOp(global, 'tacc-read', {});
  assert.deepEqual(months, [{ month: '2026-10', kinds: { hours: { google_places: { shown: 4, wrong: 1, changed: 0 } }, travel: { google_routes: { shown: 2, wrong: 0, changed: 0 } } } }]);
});

test('the global index: only in the global object; rows checked; never below zero', async () => {
  const mine = account();
  await mine.storage.put('account', { id: 'acct-1' });
  await assert.rejects(accuracyIndexOp(mine, 'tacc-read', {}), /Not found/);
  const g = account();
  await assert.rejects(accuracyIndexOp(g, 'tacc-add', { counts: { '2026-10': { 'hours:my_blog': [1, 0, 0] } } }), /bad row/);
  await assert.rejects(accuracyIndexOp(g, 'tacc-add', { counts: { 'October': { 'hours:google_places': [1, 0, 0] } } }), /bad month/);
  await assert.rejects(accuracyIndexOp(g, 'tacc-add', { counts: { '2026-10': { 'hours:google_places': [1.5, 0, 0] } } }), /bad row/);
  await accuracyIndexOp(g, 'tacc-add', { counts: { '2026-10': { 'hours:google_places': [1, 0, 0] } } });
  await accuracyIndexOp(g, 'tacc-add', { counts: { '2026-10': { 'hours:google_places': [0, -1, 0] } } });
  assert.deepEqual((await accuracyIndexOp(g, 'tacc-read', {})).months[0].kinds.hours.google_places, { shown: 1, wrong: 0, changed: 0 });
});

test('the page’s sentences: plain, with the sample size, and no rate from too few', () => {
  assert.equal(rateText({ kind: 'hours', month: '2026-10', shown: 1240, wrong: 2, changed: 0 }), '2 of 1,240 opening-hours checks reported wrong in October 2026 (0.2%).');
  assert.equal(rateText({ kind: 'travel', month: '2026-10', shown: 400, wrong: 0, changed: 3 }), 'None of 400 travel-time checks reported wrong in October 2026. 3 changed after Eden checked (for example new hours): not necessarily wrong when checked.');
  assert.equal(rateText({ kind: 'price', month: '2026-09', shown: 12, wrong: 1, changed: 0 }), '12 price checks in September 2026 so far: too few to give a rate. 1 reported wrong.');
  const rows = accuracyRows([
    { month: '2026-10', kinds: { hours: { google_places: { shown: 1240, wrong: 2, changed: 5 } }, window: { venue_site: { shown: 0, wrong: 0, changed: 0 } } } },
    { month: '2026-09', kinds: { travel: { google_routes: { shown: 50, wrong: 1, changed: 0 } } } },
    { month: '2026-01', kinds: { hours: { google_places: { shown: 9, wrong: 9, changed: 0 } } } },
  ], '2026-10');
  assert.deepEqual(rows.map((r) => [r.month, r.kind, r.shown]), [['2026-10', 'hours', 1240], ['2026-09', 'travel', 50]]);
  assert.match(rows[1].text, /^1 of 50 travel-time checks reported wrong in September 2026 \(2\.0%\)\.$/);
});
