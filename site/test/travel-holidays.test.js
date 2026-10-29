// Date-specific hours (travel/holidays.js, checks.js hoursCheck, maps.js weekOf): Google's next-7-days hours with a
// special day (Christmas) winning over the weekly hours; a public holiday beyond the window as a 'look'; "may be
// seasonal"; the holiday sources (OpenHolidays API, Nager.Date only for a sponsor) cached per country and year.
// Fake fetches only: nothing reaches Google or a holiday API.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkTrip, hoursCheck } from '../src/travel/checks.js';
import { HOLIDAYS, holidayLookup, sourceFor, stopCountry } from '../src/travel/holidays.js';
import { fromGooglePlace, mapsFor, weekOf } from '../src/travel/maps.js';

const NOW = Date.parse('2026-12-22T10:00:00Z'); // Tue 22 Dec: Google's window is 22–28 Dec in Rome
const DAY = 86400_000;
const PID = 'ChIJromeMuseum01';
const ymd = (s) => { const [year, month, day] = s.split('-').map(Number); return { year, month, day }; };
const pt = (date, hour, minute = 0) => ({ date: ymd(date), day: new Date(`${date}T00:00:00Z`).getUTCDay(), hour, minute });

// a museum open 09:00–19:00 every day; on Christmas Day, holiday hours 10:00–14:00
const week = ['2026-12-22', '2026-12-23', '2026-12-24', '2026-12-25', '2026-12-26', '2026-12-27', '2026-12-28'];
const googlePlace = (over = {}) => ({
  id: PID, displayName: { text: 'Musei Capitolini' }, formattedAddress: 'Piazza del Campidoglio, Roma',
  location: { latitude: 41.8929, longitude: 12.4825 }, businessStatus: 'OPERATIONAL', utcOffsetMinutes: 60,
  addressComponents: [{ longText: 'Roma', shortText: 'Roma', types: ['locality'] }, { longText: 'Italy', shortText: 'IT', types: ['country', 'political'] }],
  regularOpeningHours: { periods: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ open: { day, hour: 9, minute: 0 }, close: { day, hour: 19, minute: 0 } })) },
  currentOpeningHours: {
    openNow: true,
    weekdayDescriptions: week.map((d) => d),
    periods: week.map((d) => (d === '2026-12-25' ? { open: pt(d, 10), close: pt(d, 14) } : { open: pt(d, 9), close: pt(d, 19) })),
    specialDays: [{ date: ymd('2026-12-25') }],
  },
  ...over,
});

const openRows = {
  2026: [
    { startDate: '2026-12-08', endDate: '2026-12-08', type: 'Public', name: [{ language: 'EN', text: 'Immaculate Conception' }], nationwide: true },
    { startDate: '2026-12-25', endDate: '2026-12-25', type: 'Public', name: [{ language: 'EN', text: 'Christmas Day' }], nationwide: true },
    { startDate: '2026-12-26', endDate: '2026-12-26', type: 'Public', name: [{ language: 'EN', text: "St. Stephen's Day" }], nationwide: true },
    { startDate: '2026-12-07', endDate: '2026-12-07', type: 'Public', name: [{ language: 'EN', text: 'St. Ambrose' }], nationwide: false, subdivisions: [{ code: 'IT-LO-MI' }] },
  ],
  2027: [{ startDate: '2027-01-06', endDate: '2027-01-06', type: 'Public', name: [{ language: 'EN', text: 'Epiphany' }], nationwide: true }],
};

// one fake fetch for Google and the holiday sources; `calls` records each URL
function fakes({ place = googlePlace(), down = false } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ u, mask: init.headers?.['X-Goog-FieldMask'] });
    if (u.startsWith('https://places.googleapis.com/')) return Response.json(place);
    if (down) return new Response('no', { status: 503 });
    if (u.startsWith('https://openholidaysapi.org/PublicHolidays')) return Response.json(openRows[new URL(u).searchParams.get('validFrom').slice(0, 4)] || []);
    if (u.startsWith('https://date.nager.at/api/v3/PublicHolidays/2026/US')) return Response.json([{ date: '2026-12-25', localName: 'Christmas Day', name: 'Christmas Day', countryCode: 'US', global: true, types: ['Public'] }]);
    return new Response('{}', { status: 404 });
  };
  return { fetch, calls };
}

// a cache like ops.js cacheIn: get answers while fresh, entry however old (while kept)
function memCache(now) {
  const m = new Map();
  return {
    m,
    async get(k) { const e = m.get(k); return e && e.fresh > now() ? e.v : undefined; },
    async entry(k) { const e = m.get(k); return e && e.until > now() ? { v: e.v, at: e.at } : undefined; },
    async put(k, v, ms, keep = ms) { m.set(k, { v, at: now(), fresh: now() + ms, until: now() + Math.max(ms, keep) }); },
  };
}

const trip = (start, stops, destination = 'Rome, Italy') => ({
  id: 't1', title: 'Rome', destination, start, travelers: 2, budget: null, access: null,
  days: [{ stops: stops.map(([id, at, minutes]) => ({ id, kind: 'visit', mode: 'walk', at, minutes, place: { id: PID, name: 'Musei Capitolini', lat: 41.8929, lng: 12.4825 } })) }],
});

test('Google place: the next 7 days by date, the special day and the country', () => {
  const p = fromGooglePlace(googlePlace(), new Date(NOW).toISOString());
  assert.equal(p.country, 'IT');
  assert.equal(p.week.from, '2026-12-22');
  assert.equal(p.week.to, '2026-12-28');
  assert.deepEqual(p.week.special, ['2026-12-25']);
  assert.deepEqual(p.week.days['2026-12-25'], [{ open: '10:00', close: '14:00' }]);
  assert.deepEqual(p.week.days['2026-12-24'], [{ open: '09:00', close: '19:00' }]);
  assert.equal(p.week.closed_week, false);
  // Discover asks for openNow alone: no week is made from it
  assert.equal(fromGooglePlace({ id: 'x', currentOpeningHours: { openNow: false } }, 'now').week, undefined);
});

test('within 7 days: Christmas holiday hours win over the weekly hours (Google), and the mask asks for them', async () => {
  const { fetch, calls } = fakes();
  const now = () => NOW;
  const maps = mapsFor({ GOOGLE_MAPS_SERVER_KEY: 'k' }, { fetch, now });
  const holidays = holidayLookup({ fetch, now, cache: memCache(now) });
  const out = await checkTrip(trip('2026-12-25', [['a', '10:30', 120], ['b', '15:00', 60]]), maps, { cache: memCache(now), now, holidays });
  const [a, b] = out.days[0].stops.map((s) => s.badges.hours);
  assert.equal(a.status, 'ok');
  assert.equal(a.text, 'holiday hours on Fri 25 Dec · Google: open 10:00–14:00.');
  assert.equal(a.special, true);
  assert.equal(a.source, 'Google Maps (Places API)');
  assert.equal(a.holiday.name, 'Christmas Day');
  // weekly hours say 09:00–19:00; Google's holiday hours close at 14:00
  assert.equal(b.status, 'warn');
  assert.match(b.text, /^holiday hours on Fri 25 Dec · Google: open 10:00–14:00; the visit is 15:00–16:00\.$/);
  assert.ok(out.alerts.some((x) => x.kind === 'out_of_hours' && x.stop === 'b'));
  const g = calls.find((c) => c.u.startsWith('https://places.googleapis.com/'));
  assert.match(g.mask, /currentOpeningHours/);
  assert.match(g.mask, /addressComponents/);
});

test('within 7 days: a public holiday Google lists no special hours for is a look, not closed', () => {
  const p = fromGooglePlace(googlePlace({ currentOpeningHours: { ...googlePlace().currentOpeningHours, specialDays: [] } }), new Date(NOW).toISOString());
  p.week.days['2026-12-26'] = [{ open: '09:00', close: '19:00' }];
  const h = hoursCheck(p, '2026-12-26', 600, 60, { holiday: { date: '2026-12-26', name: "St. Stephen's Day", country: 'IT', country_name: 'Italy', source: 'OpenHolidays API', checked_at: 'x' } });
  assert.equal(h.status, 'look');
  assert.match(h.text, /^open 09:00–19:00 on Sat 26 Dec\. Sat 26 Dec is a public holiday in Italy \(St\. Stephen's Day · OpenHolidays API\); Google lists no holiday hours for it: check before you go\.$/);
  // Google's date shows no hours (not a special day): closed that date, as Google says
  p.week.days['2026-12-27'] = [];
  assert.equal(hoursCheck(p, '2026-12-27', 600, 60).status, 'warn');
  assert.equal(hoursCheck(p, '2026-12-27', 600, 60).text, 'Google shows it closed on Sun 27 Dec.');
});

test('beyond 7 days: a public holiday gets a look with its source; never "closed"', async () => {
  const { fetch } = fakes();
  const now = () => NOW;
  const maps = mapsFor({ GOOGLE_MAPS_SERVER_KEY: 'k' }, { fetch, now });
  const holidays = holidayLookup({ fetch, now, cache: memCache(now) });
  const out = await checkTrip(trip('2027-01-06', [['a', '10:00', 90]]), maps, { cache: memCache(now), now, holidays });
  const h = out.days[0].stops[0].badges.hours;
  assert.equal(h.status, 'look');
  assert.equal(h.text, '6 Jan is a public holiday in Italy (Epiphany · OpenHolidays API): hours may differ — Google shows regular hours only. Regular hours: open 09:00–19:00 on Wednesday.');
  assert.equal(h.holiday.source, 'OpenHolidays API');
  assert.doesNotMatch(h.text, /closed/);
  assert.equal(out.alerts.length, 0);
  // an ordinary day beyond the window: as before
  const plain = await checkTrip(trip('2027-01-07', [['a', '10:00', 90]]), maps, { cache: memCache(now), now, holidays });
  assert.equal(plain.days[0].stops[0].badges.hours.status, 'ok');
  assert.equal(plain.days[0].stops[0].badges.hours.text, 'open 09:00–19:00 on Thursday.');
  // no holiday lookup handed in: no holiday checks
  const off = await checkTrip(trip('2027-01-06', [['a', '10:00', 90]]), maps, { cache: memCache(now), now });
  assert.equal(off.days[0].stops[0].badges.hours.status, 'ok');
});

test('may be seasonal: Google shows it shut all of the coming week though its regular hours say open', () => {
  const g = googlePlace({ currentOpeningHours: { openNow: false, weekdayDescriptions: week.map(() => 'Closed') } });
  const p = fromGooglePlace(g, new Date(NOW).toISOString());
  assert.equal(p.week.closed_week, true);
  const later = hoursCheck(p, '2027-04-14', 600, 60);
  assert.equal(later.status, 'look');
  assert.equal(later.seasonal, true);
  assert.match(later.text, /^Google shows it closed every day from Tue 22 Dec to Mon 28 Dec, though its regular hours say open: it may be seasonal\. Check before you go\. Regular hours: open 09:00–19:00 on Wednesday\.$/);
  // within the window it is closed that date, as Google says
  assert.equal(hoursCheck(p, '2026-12-23', 600, 60).status, 'warn');
});

test('holidays: cached per country and year; a stale answer is asked again, kept if the source fails', async () => {
  let t = NOW;
  const now = () => t;
  const cache = memCache(now);
  const { fetch, calls } = fakes();
  const one = holidayLookup({ fetch, now, cache });
  assert.equal((await one('IT', '2026-12-25')).name, 'Christmas Day');
  assert.equal(await one('IT', '2026-12-07'), null, 'a regional holiday (Milan) is not counted nationwide');
  assert.equal(await one('IT', '2026-12-24'), null);
  // another check (a new lookup) reads the cache: still one request for IT 2026
  const two = holidayLookup({ fetch, now, cache });
  assert.equal((await two('IT', '2026-12-26')).name, "St. Stephen's Day");
  assert.equal(calls.filter((c) => c.u.includes('openholidaysapi')).length, 1);
  assert.ok(cache.m.has('hol1:open:IT:2026'));
  // 31 days on: asked again; the source down: the last answer, with its own checked_at
  t = NOW + 31 * DAY;
  const down = fakes({ down: true });
  const three = holidayLookup({ fetch: down.fetch, now, cache });
  const h = await three('IT', '2026-12-25');
  assert.equal(h.name, 'Christmas Day');
  assert.equal(h.checked_at, new Date(NOW).toISOString());
  assert.equal(down.calls.length, 1);
  // never cached and the source down: nothing said
  assert.equal(await holidayLookup({ fetch: down.fetch, now, cache: memCache(now) })('FR', '2026-12-25'), null);
  assert.ok(HOLIDAYS.keepMs > 365 * DAY);
});

test('holiday sources: OpenHolidays by default; Nager.Date only with the sponsor switch; country from Google, else the trip', async () => {
  assert.equal(sourceFor('IT'), 'open');
  assert.equal(sourceFor('US'), null, 'Nager.Date terms: commercial use needs sponsorship');
  assert.equal(sourceFor('US', { NAGER_DATE_SPONSOR: '1' }), 'nager');
  assert.equal(sourceFor('IT', { NAGER_DATE_SPONSOR: '1' }), 'open');
  const { fetch, calls } = fakes();
  const now = () => NOW;
  assert.equal(await holidayLookup({ fetch, now })('US', '2026-12-25'), null);
  assert.equal(calls.length, 0);
  const us = await holidayLookup({ fetch, now, env: { NAGER_DATE_SPONSOR: '1' } })('US', '2026-12-25');
  assert.equal(us.source, 'Nager.Date');
  assert.equal(us.country_name, 'United States');
  assert.equal(stopCountry({ country: 'FR' }, { destination: 'Rome, Italy' }), 'FR');
  assert.equal(stopCountry({}, { destination: 'Rome, Italy' }), 'IT');
  assert.equal(stopCountry({}, { destination: 'Rome' }), null);
  assert.equal(stopCountry({}, { destination: 'Paris, France and Rome, Italy' }), null, 'two countries: not guessed');
});

test('a place open 24 hours: Google sends one period over the whole week, and every day of it is open (a Shinjuku hotel read "closed" on 4 Nov)', () => {
  const g = { utcOffsetMinutes: 540, currentOpeningHours: {
    weekdayDescriptions: ['Monday: Open 24 hours', 'Tuesday: Open 24 hours', 'Wednesday: Open 24 hours', 'Thursday: Open 24 hours', 'Friday: Open 24 hours', 'Saturday: Open 24 hours', 'Sunday: Open 24 hours'],
    periods: [{ open: { day: 5, hour: 0, minute: 0, truncated: true, date: { year: 2026, month: 10, day: 30 } }, close: { day: 4, hour: 23, minute: 59, truncated: true, date: { year: 2026, month: 11, day: 5 } } }],
  } };
  const { week } = weekOf(g, '2026-10-29T17:00:00Z'); // 30 Oct in Tokyo
  assert.equal(week.from, '2026-10-30');
  for (const d of Object.keys(week.days)) assert.deepEqual(week.days[d], [{ open: '00:00', close: '23:59' }], d);
  assert.equal(week.closed_week, false);
});

test('a bar open past midnight: its night on the day it opens, its small hours on the next day', () => {
  const g = { utcOffsetMinutes: 540, currentOpeningHours: { weekdayDescriptions: ['x'],
    periods: [{ open: { day: 5, hour: 18, minute: 0, date: { year: 2026, month: 10, day: 30 } }, close: { day: 6, hour: 2, minute: 0, date: { year: 2026, month: 10, day: 31 } } }] } };
  const { week } = weekOf(g, '2026-10-29T17:00:00Z');
  assert.deepEqual(week.days['2026-10-30'], [{ open: '18:00', close: '23:59' }]);
  assert.deepEqual(week.days['2026-10-31'], [{ open: '00:00', close: '02:00' }]);
  assert.deepEqual(week.days['2026-11-01'], []);
});
