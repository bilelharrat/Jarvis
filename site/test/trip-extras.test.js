// Eden Travel's extras: the forecast (Open-Meteo), official entry-advice links, and the trip as a
// calendar file. Fake fetches only; nothing here touches the network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FORECAST_DAYS, TOO_FAR, WMO, forecast, summaryOf } from '../src/travel/weather.js';
import { ENTRY_COUNTRIES, entryAdvice } from '../src/travel/entry.js';
import { escapeText, foldLine, tripToIcs } from '../src/travel/ics.js';

const NOW = Date.parse('2026-10-27T10:00:00Z');
const now = () => NOW;
const LISBON = { lat: 38.71, lng: -9.14 };

// Open-Meteo's daily answer for 16 days from 2026-10-27, in the shape the real API sent on 2026-10-27
// (the last day with empty values, as it often is).
function meteoBody() {
  const time = Array.from({ length: 16 }, (_, i) => new Date(Date.UTC(2026, 9, 27 + i)).toISOString().slice(0, 10));
  const fill = (v) => time.map((_, i) => (i === 15 ? null : v(i)));
  return {
    latitude: 38.746, longitude: -9.175, timezone: 'Europe/Lisbon',
    daily_units: { time: 'iso8601', weather_code: 'wmo code', temperature_2m_max: '°C', temperature_2m_min: '°C', precipitation_probability_max: '%' },
    daily: {
      time,
      weather_code: fill((i) => [3, 0, 61, 95][i % 4]),
      temperature_2m_max: fill((i) => 20 + i / 10),
      temperature_2m_min: fill((i) => 12 + i / 10),
      precipitation_probability_max: time.map((_, i) => i * 5),
    },
  };
}
function fakeFetch(answer) {
  const calls = [];
  const f = async (url, init) => {
    calls.push(String(url));
    if (answer instanceof Error) throw answer;
    const { status = 200, body } = typeof answer === 'function' ? answer(url, init) : answer;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  f.calls = calls;
  return f;
}

// ── weather ──

test('forecast: asks Open-Meteo for the daily fields, local time zone, 16 days', async () => {
  const f = fakeFetch({ body: meteoBody() });
  await forecast({ ...LISBON, dates: ['2026-10-28'] }, { fetch: f, now });
  const u = new URL(f.calls[0]);
  assert.equal(u.origin + u.pathname, 'https://api.open-meteo.com/v1/forecast');
  assert.equal(u.searchParams.get('timezone'), 'auto');
  assert.equal(u.searchParams.get('forecast_days'), String(FORECAST_DAYS));
  assert.equal(u.searchParams.get('latitude'), '38.71');
  assert.deepEqual(u.searchParams.get('daily').split(',').sort(), ['precipitation_probability_max', 'temperature_2m_max', 'temperature_2m_min', 'weather_code']);
});

test('forecast: a day in range gets numbers, a summary, source and time', async () => {
  const [d] = await forecast({ ...LISBON, dates: ['2026-10-29'] }, { fetch: fakeFetch({ body: meteoBody() }), now });
  assert.deepEqual(d, { date: '2026-10-29', high_c: 20.2, low_c: 12.2, rain_chance_pct: 10, summary: 'Slight rain', source: 'Open-Meteo', checked_at: '2026-10-27T10:00:00.000Z' });
});

test('forecast: the range cut-off: later days get no forecast, never a guess', async () => {
  const dates = ['2026-10-27', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2027-03-01'];
  const out = await forecast({ ...LISBON, dates }, { fetch: fakeFetch({ body: meteoBody() }), now });
  assert.deepEqual(out.map((d) => d.date), dates, 'in the order asked');
  assert.equal(out[0].summary, 'Overcast');
  assert.equal(out[1].summary, 'Slight rain');
  // 2026-11-11 is the range's last day, sent empty: no numbers, so no forecast
  assert.equal(out[2].forecast, null);
  assert.match(out[2].why, /No forecast/);
  for (const d of out.slice(3)) {
    assert.deepEqual(Object.keys(d).sort(), ['checked_at', 'date', 'forecast', 'source', 'why']);
    assert.equal(d.forecast, null);
    assert.equal(d.why, TOO_FAR);
    assert.equal(d.high_c, undefined);
  }
});

test('forecast: all days too far: no call at all', async () => {
  const f = fakeFetch({ body: meteoBody() });
  const out = await forecast({ ...LISBON, dates: ['2026-11-20', '2026-12-25'] }, { fetch: f, now });
  assert.equal(f.calls.length, 0);
  assert.ok(out.every((d) => d.forecast === null && d.why === TOO_FAR));
});

test('forecast: a past day says so', async () => {
  const [d] = await forecast({ ...LISBON, dates: ['2026-10-20'] }, { fetch: fakeFetch({ body: meteoBody() }), now });
  assert.equal(d.forecast, null);
  assert.match(d.why, /passed/);
});

test('forecast: errors and timeouts are { error }', async () => {
  const timeout = await forecast({ ...LISBON, dates: ['2026-10-28'] }, { fetch: fakeFetch(new DOMException('timed out', 'TimeoutError')), now });
  assert.match(timeout.error, /did not answer/);
  assert.equal(timeout.source, 'Open-Meteo');
  const api = await forecast({ ...LISBON, dates: ['2026-10-28'] }, { fetch: fakeFetch({ status: 400, body: { error: true, reason: 'Latitude must be in range of -90 to 90°.' } }), now });
  assert.match(api.error, /Latitude must be/);
  const http = await forecast({ ...LISBON, dates: ['2026-10-28'] }, { fetch: fakeFetch({ status: 503, body: null }), now });
  assert.match(http.error, /503/);
  const empty = await forecast({ ...LISBON, dates: ['2026-10-28'] }, { fetch: fakeFetch({ body: { daily: {} } }), now });
  assert.match(empty.error, /no daily/);
  assert.ok((await forecast({ lat: null, lng: 1, dates: ['2026-10-28'] }, { fetch: fakeFetch({ body: {} }), now })).error);
  assert.ok((await forecast({ ...LISBON, dates: ['28/10/2026'] }, { fetch: fakeFetch({ body: {} }), now })).error);
  assert.ok((await forecast({ ...LISBON, dates: [] }, { fetch: fakeFetch({ body: {} }), now })).error);
});

test('the WMO code table: every code in Open-Meteo docs, nothing else', () => {
  const codes = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 97, 99];
  assert.deepEqual(Object.keys(WMO).map(Number), codes);
  assert.equal(summaryOf(0), 'Clear sky');
  assert.equal(summaryOf(45), 'Fog');
  assert.equal(summaryOf(82), 'Violent rain showers');
  assert.equal(summaryOf(99), 'Thunderstorm with heavy hail');
  assert.equal(summaryOf(4), null, 'an unknown code is not guessed');
  assert.equal(summaryOf(null), null);
});

// ── entry advice ──

test('entry: US passport → the State Department page', () => {
  const [a, more] = entryAdvice({ country_code: 'PT', passport: 'US' });
  assert.equal(more, undefined);
  assert.equal(a.url, 'https://travel.state.gov/en/international-travel/travel-advisories/portugal.html');
  assert.equal(a.by, 'U.S. Department of State');
  assert.equal(a.title, 'Portugal Travel Advisory');
  assert.equal(a.note, 'Official page: check entry rules and visas there before you go');
  assert.equal(entryAdvice({ country_code: 'jp', passport: 'usa' })[0].url, 'https://travel.state.gov/en/international-travel/travel-advisories/japan.html');
  assert.equal(entryAdvice({ country_code: 'KR', passport: 'US' })[0].url, 'https://travel.state.gov/en/international-travel/travel-advisories/south-korea.html');
});

test('entry: UK passport → the FCDO page', () => {
  const [a] = entryAdvice({ country_code: 'JP', passport: 'GB' });
  assert.equal(a.url, 'https://www.gov.uk/foreign-travel-advice/japan');
  assert.match(a.by, /Foreign, Commonwealth & Development Office/);
  assert.equal(entryAdvice({ country_code: 'PT', passport: 'UK' })[0].url, 'https://www.gov.uk/foreign-travel-advice/portugal');
  assert.equal(entryAdvice({ country_code: 'US', passport: 'GB' })[0].url, 'https://www.gov.uk/foreign-travel-advice/usa');
  assert.equal(entryAdvice({ country_code: 'MM', passport: 'GB' })[0].url, 'https://www.gov.uk/foreign-travel-advice/myanmar');
});

test('entry: no passport → every official page we have', () => {
  const out = entryAdvice({ country_code: 'FR' });
  assert.deepEqual(out.map((a) => a.passport), ['US', 'GB']);
});

test('entry: unknown or unconfirmed → null, never a guessed address', () => {
  assert.equal(entryAdvice({ country_code: 'ZZ', passport: 'US' }), null);
  assert.equal(entryAdvice({ country_code: 'AU', passport: 'US' }), null, 'no confirmed State Department slug for Australia yet');
  assert.equal(entryAdvice({ country_code: 'US', passport: 'US' }), null, 'no advice page for your own country');
  assert.equal(entryAdvice({ country_code: 'GB', passport: 'GB' }), null);
  assert.equal(entryAdvice({ country_code: 'PT', passport: 'FR' }), null, 'no confirmed pages for other passports');
  assert.equal(entryAdvice({ country_code: 'Portugal' }), null);
  assert.equal(entryAdvice({}), null);
});

test('entry: links only: no visa rules in any answer, https official hosts only', () => {
  for (const [gov, codes] of Object.entries(ENTRY_COUNTRIES)) {
    for (const cc of codes) {
      const [a] = entryAdvice({ country_code: cc, passport: gov });
      assert.deepEqual(Object.keys(a).sort(), ['by', 'country_code', 'note', 'passport', 'title', 'url', 'verified_on']);
      const u = new URL(a.url);
      assert.equal(u.protocol, 'https:');
      assert.ok(u.hostname === (gov === 'US' ? 'travel.state.gov' : 'www.gov.uk'), a.url);
      assert.match(u.pathname, gov === 'US' ? /^\/en\/international-travel\/travel-advisories\/[a-z0-9-]+\.html$/ : /^\/foreign-travel-advice\/[a-z0-9-]+$/);
    }
  }
});

// ── calendar ──

const TRIP = {
  id: 'trip_abc',
  title: 'Lisbon, long weekend',
  start: '2026-11-06',
  days: [
    {
      title: 'Day 1',
      stops: [
        { id: 's1', kind: 'stay', place: { id: null, name: 'A hotel in Baixa', lat: 38.7118, lng: -9.1384 }, at: '15:00', minutes: 30, nights: 3, note: '' },
        { id: 's2', kind: 'meal', place: { name: 'Time Out Market, Cais do Sodré', lat: 38.7071, lng: -9.1458 }, at: '19:30', minutes: 90, note: 'Book; ask for a table\\terrace\nsecond line' },
        { id: 's3', kind: 'visit', place: { name: 'Late bar', lat: null, lng: null }, at: '23:30', minutes: 90, note: '' },
      ],
    },
    {
      title: 'Day 2',
      stops: [
        { id: 's4', kind: 'visit', place: { name: 'São Jorge Castle, the long name of a place that will not fit on one calendar line at all', lat: 38.7139, lng: -9.1335 }, at: '09:00', minutes: 0, note: 'é'.repeat(80) },
      ],
    },
  ],
};

const unfold = (ics) => ics.replace(/\r\n /g, '');
const events = (ics) => unfold(ics).split('BEGIN:VEVENT\r\n').slice(1).map((e) => Object.fromEntries(e.split('\r\n').filter((l) => l && l !== 'END:VEVENT' && l !== 'END:VCALENDAR').map((l) => { const i = l.indexOf(':'); return [l.slice(0, i), l.slice(i + 1)]; })));

test('ics: structure: CRLF lines, balanced blocks, required properties', () => {
  const ics = tripToIcs(TRIP, { id: TRIP.id, now: NOW });
  assert.ok(ics.endsWith('\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'every newline is CRLF');
  const lines = ics.split('\r\n').slice(0, -1);
  assert.equal(lines[0], 'BEGIN:VCALENDAR');
  assert.equal(lines.at(-1), 'END:VCALENDAR');
  assert.ok(lines.includes('VERSION:2.0'));
  assert.ok(lines.some((l) => l.startsWith('PRODID:')));
  assert.equal(lines.filter((l) => l === 'BEGIN:VEVENT').length, 4);
  assert.equal(lines.filter((l) => l === 'END:VEVENT').length, 4);
  let depth = 0;
  for (const l of lines) {
    if (l.startsWith('BEGIN:')) depth++;
    if (l.startsWith('END:')) depth--;
    assert.ok(depth >= 0);
  }
  assert.equal(depth, 0);
  for (const e of events(ics)) {
    for (const p of ['UID', 'DTSTAMP', 'SUMMARY']) assert.ok(e[p], `${p} in every event`);
    assert.ok(e.DTSTART || e['DTSTART;VALUE=DATE']);
    assert.equal(e.DTSTAMP, '20261027T100000Z');
  }
});

test('ics: UIDs are <trip id>-<stop id>@askeden.com and unique', () => {
  const uids = events(tripToIcs(TRIP, { id: TRIP.id, now: NOW })).map((e) => e.UID);
  assert.deepEqual(uids, ['trip_abc-s1@askeden.com', 'trip_abc-s2@askeden.com', 'trip_abc-s3@askeden.com', 'trip_abc-s4@askeden.com']);
});

test('ics: floating local times from the day, at and minutes; past midnight rolls to the next day', () => {
  const [, meal, bar, castle] = events(tripToIcs(TRIP, { id: TRIP.id, now: NOW }));
  assert.equal(meal.DTSTART, '20261106T193000');
  assert.equal(meal.DTEND, '20261106T210000');
  assert.equal(bar.DTEND, '20261107T010000');
  assert.equal(castle.DTSTART, '20261107T090000');
  assert.equal(castle.DTEND, undefined, 'a 0-minute stop has no DTEND');
  assert.ok(!/T\d{6}Z/.test(meal.DTSTART), 'no Z: floating time');
});

test('ics: a stay spans its nights as an all-day event', () => {
  const [stay] = events(tripToIcs(TRIP, { id: TRIP.id, now: NOW }));
  assert.equal(stay['DTSTART;VALUE=DATE'], '20261106');
  assert.equal(stay['DTEND;VALUE=DATE'], '20261109', 'three nights: check-out the 9th');
  assert.equal(stay.TRANSP, 'TRANSPARENT');
  assert.equal(stay.DTSTART, undefined);
});

test('ics: SUMMARY, LOCATION, GEO only when known, DESCRIPTION from the note, escaped', () => {
  const [, meal, bar] = events(tripToIcs(TRIP, { id: TRIP.id, now: NOW }));
  assert.equal(meal.SUMMARY, 'Time Out Market\\, Cais do Sodré');
  assert.equal(meal.LOCATION, 'Time Out Market\\, Cais do Sodré');
  assert.equal(meal.GEO, '38.7071;-9.1458');
  assert.equal(meal.DESCRIPTION, 'Book\\; ask for a table\\\\terrace\\nsecond line');
  assert.equal(bar.GEO, undefined);
  assert.equal(bar.DESCRIPTION, undefined, 'no note, no description');
  assert.equal(escapeText('a,b;c\\d\r\ne\nf'), 'a\\,b\\;c\\\\d\\ne\\nf');
});

test('ics: lines fold at 75 octets without splitting a character', () => {
  const ics = tripToIcs(TRIP, { id: TRIP.id, now: NOW });
  const enc = new TextEncoder();
  const raw = ics.split('\r\n');
  for (const l of raw) assert.ok(enc.encode(l).length <= 75, `${enc.encode(l).length} octets: ${l}`);
  assert.ok(raw.some((l) => l.startsWith(' ')), 'the long lines were folded');
  assert.ok(!ics.includes('�'));
  const castle = events(ics)[3];
  assert.equal(castle.DESCRIPTION, 'é'.repeat(80), 'unfolds back to the note');
  assert.match(castle.SUMMARY, /^São Jorge Castle\\, the long name/);
  assert.equal(foldLine('short'), 'short');
  const folded = foldLine(`DESCRIPTION:${'x'.repeat(200)}`);
  assert.deepEqual(folded.split('\r\n').map((l) => l.length), [75, 75, 64]);
  assert.equal(folded.replace(/\r\n /g, ''), `DESCRIPTION:${'x'.repeat(200)}`);
});

test('ics: the id defaults to the trip’s, and odd characters are kept out of the UID', () => {
  const t = { ...TRIP, id: 'trip 9/x', days: [TRIP.days[1]] };
  assert.equal(events(tripToIcs(t, { now: NOW }))[0].UID, 'trip-9-x-s4@askeden.com');
});

test('a train or bus: booked only after a fresh seat check, the person’s button and their acceptance of the carrier’s terms', async () => {
  const { extraOp } = await import('../src/travel/extraops.js');
  const m = new Map();
  const clock = { t: Date.parse('2027-05-01T10:00:00Z') };
  const account = { env: {}, now: () => clock.t, storage: { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v), delete: async (k) => m.delete(k) } };
  const calls = [];
  const rail = {
    vacancy: async (a) => { calls.push(['vacancy', a]); return { vacant: true, total_price: { amount: 48, currency: 'EUR' }, source: 'Distribusion', checked_at: 'now' }; },
    reserve: async (a) => { calls.push(['reserve', a]); return { reservation_id: 'R1234' }; },
    confirm: async (d, o) => { calls.push(['confirm', d, o]); return { reservation_id: 'R1234', carrier_refs: ['SNCF-77'] }; },
  };
  const marks = [];
  const deps = { rail, tripOp: async (_a, op, b) => { marks.push([op, b]); return {}; } };
  const base = { offer_id: 'off_1', passenger_ids: ['p1', 'p2'] };
  await assert.rejects(extraOp(account, 'trip-rail-book', { ...base, terms_accepted: true, confirm: true, passengers: [{ first_name: 'A', last_name: 'B' }, { first_name: 'C', last_name: 'D' }], email: 'a@b.co' }, deps), /Check the seats and price again/);
  await extraOp(account, 'trip-rail-check', { ...base, title: 'Train Paris → Lyon' }, deps);
  await assert.rejects(extraOp(account, 'trip-rail-book', { ...base, confirm: true, terms_accepted: false, passengers: [], email: 'a@b.co' }, deps), /accept the carrier’s terms/);
  await assert.rejects(extraOp(account, 'trip-rail-book', { ...base, terms_accepted: true, passengers: [], email: 'a@b.co' }, deps), /confirm: true/);
  const b = await extraOp(account, 'trip-rail-book', { ...base, confirm: true, terms_accepted: true, passengers: [{ first_name: 'A', last_name: 'B' }, { first_name: 'C', last_name: 'D' }], email: 'a@b.co', id: 't1', stop: 's-1' }, deps);
  assert.deepEqual(b.carrier_refs, ['SNCF-77']);
  assert.equal(calls.find((c) => c[0] === 'confirm')[2].confirm, true);
  assert.deepEqual(marks[0][1], { id: 't1', stop: 's-1', ref: 'SNCF-77', provider: 'Distribusion', via: 'api', cost: { amount: 48, currency: 'EUR' }, confirm: true });
  clock.t += 21 * 60_000;
  await extraOp(account, 'trip-rail-check', { ...base }, deps);
  clock.t += 21 * 60_000;
  await assert.rejects(extraOp(account, 'trip-rail-book', { ...base, confirm: true, terms_accepted: true, passengers: [{ first_name: 'A', last_name: 'B' }, { first_name: 'C', last_name: 'D' }], email: 'a@b.co' }, deps), /ran out/, 'a check older than 20 minutes');
});
