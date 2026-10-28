// Eden Travel in the traveller's own calendar (travel/calsync.js): the private subscription link (any calendar app) and
// Google Calendar written directly, in the trip's own time zone, kept up to date and cleaned up when switched off.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { calOp, offsetAt, stopEvent, tripsToIcs } from '../src/travel/calsync.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';

const A = '11111111-1111-4111-8111-111111111111';
const TRIP = {
  id: 'trip1', title: 'Lisbon', start: '2026-11-28',
  days: [
    { title: 'Arrival', stops: [
      { id: 'hotel', kind: 'stay', at: '15:00', minutes: 0, nights: 2, place: { id: 'ChIJhotel_baixa_1', name: 'Hotel Baixa', lat: 38.71, lng: -9.14 } },
      { id: 'museum', kind: 'visit', at: '10:00', minutes: 90, place: { id: 'ChIJtiles_museum_1', name: 'Tile Museum', lat: 38.72, lng: -9.11 }, note: 'Closed Mondays' },
    ] },
    { title: 'Belém', stops: [{ id: 'coffee', kind: 'meal', at: '09:00', minutes: 0, place: { name: 'Coffee, Príncipe Real' } }] },
  ],
};

test('a zone’s offset at a wall-clock time there, summer time included', () => {
  assert.equal(offsetAt('2026-07-01', 600, 'Europe/Lisbon'), '+01:00');
  assert.equal(offsetAt('2026-11-28', 600, 'Europe/Lisbon'), '+00:00');
  assert.equal(offsetAt('2026-11-28', 600, 'America/New_York'), '-05:00');
  assert.equal(offsetAt('2026-03-29', 600, 'Europe/Paris'), '+02:00', 'the morning after the clocks go forward');
  assert.equal(offsetAt('2026-11-28', 600, 'Asia/Kolkata'), '+05:30');
});

test('one stop as a Google event: timed in the trip’s zone (15 minutes at least), a stay all day over its nights', () => {
  const museum = stopEvent(TRIP, 0, TRIP.days[0].stops[1], 'Europe/Lisbon');
  assert.deepEqual({ start: museum.start, end: museum.end, allDay: museum.allDay, timeZone: museum.timeZone }, { start: '2026-11-28T10:00:00+00:00', end: '2026-11-28T11:30:00+00:00', allDay: false, timeZone: 'Europe/Lisbon' });
  assert.equal(museum.notes, 'From Ask Eden Travel', 'never the stop’s own notes (they can hold references)');
  const hotel = stopEvent(TRIP, 0, TRIP.days[0].stops[0], 'Europe/Lisbon');
  assert.deepEqual({ start: hotel.start, end: hotel.end, allDay: hotel.allDay }, { start: '2026-11-28', end: '2026-11-30', allDay: true });
  const coffee = stopEvent(TRIP, 1, TRIP.days[1].stops[0], 'Europe/Lisbon');
  assert.equal(coffee.end, '2026-11-29T09:15:00+00:00', 'a 0-minute stop still ends after it starts');
});

test('every trip in one calendar, named Eden Travel, with a refresh hint for the calendar app', () => {
  const ics = tripsToIcs([TRIP, { ...TRIP, id: 'trip2', title: 'Porto' }], { now: 0 });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /X-WR-CALNAME:Eden Travel\r\n/);
  assert.match(ics, /REFRESH-INTERVAL;VALUE=DURATION:PT1H/);
  assert.equal(ics.match(/BEGIN:VEVENT/g).length, 6);
  assert.equal(ics.match(/BEGIN:VCALENDAR/g).length, 1);
  assert.match(ics, /UID:trip2-museum@askeden\.com/);
});

// ── Google Calendar, with a fake Google ──

function fakeAccount() {
  const store = new Map([['account', { id: A }]]);
  return {
    env: { GOOGLE_MAPS_SERVER_KEY: 'maps-key' }, store, now: () => 1_800_000_000_000,
    storage: {
      get: async (k) => store.get(k),
      put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) store.set(a, b); else store.set(k, v); },
      delete: async (k) => { for (const x of [].concat(k)) store.delete(x); },
    },
  };
}
function google({ scopes = ['https://www.googleapis.com/auth/calendar.events'] } = {}) {
  const g = { actions: [], n: 0, scopes };
  g.deps = (trip) => ({
    tripOp: async (_a, op, body) => { if (op === 'trip-get' && body.id === 'trip1') return { trip: g.trip || trip }; throw Object.assign(new Error('There is no such trip.'), { status: 404 }); },
    google: async () => ({ email: 'ana@example.com', scopes: g.scopes, calendar: () => ({ calendars: async () => [{ id: 'cal-shared', title: 'Work', readOnly: true }, { id: 'primary-cal', title: 'Ana', primary: true }] }) }),
    calendarAction: async (_api, action, args) => { g.actions.push({ action, args }); if (action === 'create') return { event: { id: `ev${++g.n}` } }; return {}; },
    fetch: async (url) => { g.lookups = (g.lookups || 0) + 1; return /places\.googleapis/.test(url) ? Response.json({ timeZone: { id: 'Europe/Lisbon' } }) : Response.json({ status: 'ZERO_RESULTS' }); },
  });
  return g;
}

test('Google Calendar: the person picks a calendar it may write to; each stop an event there, in Lisbon time, named fields only', async () => {
  const account = fakeAccount();
  const g = google();
  assert.deepEqual(await calOp(account, 'trip-gcal-calendars', {}, g.deps(TRIP)), { email: 'ana@example.com', calendars: [{ id: 'primary-cal', title: 'Ana', primary: true }] }, 'never a read-only one');
  await assert.rejects(calOp(account, 'trip-gcal-sync', { id: 'trip1', calendarId: 'primary-cal' }, g.deps(TRIP)), /confirm: true/);
  await assert.rejects(calOp(account, 'trip-gcal-sync', { id: 'trip1', confirm: true }, g.deps(TRIP)), /Pick one of your Google calendars/);
  await assert.rejects(calOp(account, 'trip-gcal-sync', { id: 'trip1', calendarId: 'cal-shared', confirm: true }, g.deps(TRIP)), /Pick one/, 'a read-only calendar can’t be picked');
  assert.equal(account.store.get('gcal:trip1'), undefined);
  const r = await calOp(account, 'trip-gcal-sync', { id: 'trip1', calendarId: 'primary-cal', confirm: true }, g.deps(TRIP));
  assert.deepEqual({ on: r.on, calendar: r.calendar, zone: r.zone, added: r.added }, { on: true, calendar: 'Ana', zone: 'Europe/Lisbon', added: 3 });
  assert.ok(g.actions.every((a) => a.args.calendarId === 'primary-cal' && a.args.confirm === true));
  const museum = g.actions.find((a) => a.args.event.title === 'Tile Museum').args.event;
  assert.equal(museum.start, '2026-11-28T10:00:00+00:00');
  assert.equal(museum.notes, 'From Ask Eden Travel', 'never the stop’s own notes');
  assert.equal(account.store.get('tz:trip1').zone, 'Europe/Lisbon', 'the zone is looked up once, kept with the stop it came from');
  assert.deepEqual(await calOp(account, 'trip-gcal-status', { id: 'trip1' }, g.deps(TRIP)), { on: true, calendar: 'Ana', calendarId: 'primary-cal', synced: 1_800_000_000_000, events: 3, pending: 0 });
});

test('Google Calendar: Update writes what changed (a moved stop updated, a removed one deleted, the rest left); stopping deletes them all', async () => {
  const account = fakeAccount();
  const g = google();
  await calOp(account, 'trip-gcal-sync', { id: 'trip1', calendarId: 'primary-cal', confirm: true }, g.deps(TRIP));
  g.actions.length = 0;
  g.trip = { ...TRIP, days: [{ ...TRIP.days[0], stops: [TRIP.days[0].stops[0], { ...TRIP.days[0].stops[1], at: '11:00' }] }, { title: 'Belém', stops: [] }] };
  // nothing is written until the person presses Update: the status says what changed
  assert.equal(g.actions.length, 0);
  assert.equal((await calOp(account, 'trip-gcal-status', { id: 'trip1' }, g.deps(TRIP))).pending, 2);
  const again = await calOp(account, 'trip-gcal-sync', { id: 'trip1', confirm: true }, g.deps(TRIP));
  assert.deepEqual({ added: again.added, updated: again.updated, removed: again.removed }, { added: 0, updated: 1, removed: 1 });
  assert.deepEqual(g.actions.map((a) => a.action).sort(), ['delete', 'update']);
  g.actions.length = 0;
  const off = await calOp(account, 'trip-gcal-off', { id: 'trip1', confirm: true }, g.deps(TRIP));
  assert.deepEqual(off, { on: false, removed: 2 });
  assert.equal(account.store.get('gcal:trip1'), undefined);
  assert.deepEqual(await calOp(account, 'trip-gcal-status', { id: 'trip1' }, g.deps(TRIP)), { on: false });
});

test('Google Calendar refused without the calendar permission, or for another account’s trip; nothing is left switched on', async () => {
  const account = fakeAccount();
  await assert.rejects(calOp(account, 'trip-gcal-sync', { id: 'trip1', calendarId: 'primary-cal', confirm: true }, google({ scopes: [] }).deps(TRIP)), /Connect Google Calendar/);
  assert.equal(account.store.get('gcal:trip1'), undefined);
  await assert.rejects(calOp(account, 'trip-gcal-sync', { id: 'nope', calendarId: 'primary-cal', confirm: true }, google().deps(TRIP)), /no such trip/);
});

// ── the subscription link, through the Worker ──

let env;
beforeEach(() => {
  forgetSessions();
  env = { EDEN_TRAVEL: '1', TRAVEL_PLUS: '0', TRIAL_BUDGET_USD: '1', LINK_RATE: rateLimiter(), API_RATE: rateLimiter(), EDEN_RATE: rateLimiter(), AUTH_RATE: rateLimiter() };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.IDENTITIES = namespace(Identity, env);
  env.ASSETS = { fetch: async () => new Response('asset') };
});
const ctx = { waitUntil: () => {} };
const post = (body, session) => worker.fetch(new Request('https://askeden.com/api/chat/travel', { method: 'POST', headers: { origin: 'https://askeden.com', 'x-jarvis-chat': '1', 'content-type': 'application/json', cookie: `__Host-eden=${session}`, 'user-agent': 'Mozilla/5.0 Safari/605' }, body: JSON.stringify(body) }), env, ctx);
const get = (path) => worker.fetch(new Request(`https://askeden.com${path}`, { headers: { 'user-agent': 'Calendar/1.0' } }), env, ctx); // a calendar app: no cookie

test('the subscription link: every trip, for any calendar app, no sign-in; a new link or switching off ends the old one', async () => {
  const session = (await call(env, A, 'web-signin', { account_id: A, create: true, device: { name: 'Eden on the web: Safari on a Mac' } })).token;
  assert.equal((await post({ action: 'sample', args: {} }, session)).status, 200);
  assert.deepEqual(await (await post({ action: 'calfeed', args: {} }, session)).json(), { url: null });
  const made = await (await post({ action: 'calfeed-create', args: { origin: 'https://evil.example' } }, session)).json();
  assert.match(made.url, /^https:\/\/askeden\.com\/c\/[a-z0-9]{32}\.ics$/, 'its own address, never one the page names');
  assert.equal(made.webcal, made.url.replace('https:', 'webcal:'));
  assert.equal(made.google, `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(made.webcal)}`);
  const feed = await get(new URL(made.url).pathname);
  assert.equal(feed.status, 200);
  assert.match(feed.headers.get('content-type'), /^text\/calendar/);
  assert.match(feed.headers.get('x-robots-tag'), /noindex/);
  const text = await feed.text();
  assert.match(text, /X-WR-CALNAME:Eden Travel/);
  assert.ok((text.match(/BEGIN:VEVENT/g) || []).length > 3, 'the sample trip’s stops');
  const second = await (await post({ action: 'calfeed-create', args: {} }, session)).json();
  assert.notEqual(second.url, made.url);
  assert.equal((await get(new URL(made.url).pathname)).status, 404, 'the old link ended');
  assert.equal((await get(new URL(second.url).pathname)).status, 200);
  assert.deepEqual(await (await post({ action: 'calfeed-revoke', args: {} }, session)).json(), { revoked: true });
  assert.equal((await get(new URL(second.url).pathname)).status, 404);
  assert.doesNotMatch((await get('/c/short.ics')).headers.get('content-type') || '', /calendar/, 'not a feed address: never a calendar');
});

test('Plus: making a calendar link needs it; switching one off doesn’t; a link stops serving while the owner has no Plus', async () => {
  const session = (await call(env, A, 'web-signin', { account_id: A, create: true, device: { name: 'Eden on the web: Safari on a Mac' } })).token;
  await post({ action: 'sample', args: {} }, session);
  const made = await (await post({ action: 'calfeed-create', args: {} }, session)).json();
  assert.equal((await get(new URL(made.url).pathname)).status, 200);
  env.TRAVEL_PLUS = '1'; // Plus required again, and this account has none
  assert.equal((await get(new URL(made.url).pathname)).status, 404, 'not served without Plus');
  const refused = await post({ action: 'calfeed-create', args: {} }, session);
  assert.equal(refused.status, 402);
  assert.equal((await post({ action: 'calfeed', args: {} }, session)).status, 200, 'seeing it, without Plus');
  assert.deepEqual(await (await post({ action: 'calfeed-revoke', args: {} }, session)).json(), { revoked: true }, 'switching it off, without Plus');
});
