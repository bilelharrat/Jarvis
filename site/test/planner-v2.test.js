// Eden Travel planner v2, the server side (research_notes/travel/planner-v2-design.md): transit lines on legs,
// sunset and after-dark stops, the re-check before you go, the licensed destination photo, the photo proxy width.
// Fake fetches only; nothing here imports src/worker.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapsFor, placePhoto, standinMaps, transitLines } from '../src/travel/maps.js';
import { checkTrip } from '../src/travel/checks.js';
import { forecast, localClock } from '../src/travel/weather.js';
import { afterDark, extraOp } from '../src/travel/extraops.js';
import { armRecheck, newAlerts, recheckDue, recheckTimes } from '../src/travel/recheck.js';
import { allowedLicence, licenceDeed, heroFor, heroImage, heroImageAllowed, plainText } from '../src/travel/hero.js';

const T0 = Date.parse('2026-10-27T12:00:00Z');
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ── 1. transit lines ──

// Routes API computeRoutes, as its reference documents RouteLegStep and RouteLegStepTransitDetails
const ROUTES_SAMPLE = {
  routes: [{
    duration: '1260s',
    distanceMeters: 4100,
    legs: [{ steps: [
      { travelMode: 'WALK', staticDuration: '240s' },
      { travelMode: 'TRANSIT', staticDuration: '780s', transitDetails: {
        stopDetails: { departureStop: { name: 'Martim Moniz' }, arrivalStop: { name: 'Graça' }, departureTime: '2026-10-28T09:12:00Z', arrivalTime: '2026-10-28T09:25:00Z' },
        localizedValues: { departureTime: { time: { text: '09:12' }, timeZone: 'Europe/Lisbon' } },
        headsign: 'Campo Ourique (Prazeres)',
        transitLine: { name: 'Martim Moniz - Campo Ourique', nameShort: '28E', vehicle: { type: 'TRAM', name: { text: 'Tram' } } },
        stopCount: 6,
      } },
      { travelMode: 'WALK', staticDuration: '180s' },
    ] }],
  }],
};

test('transit lines: each ride from the Routes steps, only what Google sent', () => {
  assert.deepEqual(transitLines(ROUTES_SAMPLE.routes[0]), [{ vehicle: 'Tram', vehicle_type: 'TRAM', name: '28E', headsign: 'Campo Ourique (Prazeres)', from: 'Martim Moniz', to: 'Graça', stops: 6 }], 'no departure times: the route is for now, not the trip');
  assert.deepEqual(transitLines({ legs: [{ steps: [{ travelMode: 'TRANSIT', transitDetails: { transitLine: { name: 'Linha Verde', vehicle: { type: 'SUBWAY' } } } }] }] }), [{ vehicle: 'SUBWAY', vehicle_type: 'SUBWAY', name: 'Linha Verde' }]);
  assert.deepEqual(transitLines({}), []);
});

test('travel(): transit asks for the steps and returns lines; walking does not; the badge carries them', async () => {
  const masks = [];
  const fetch = async (url, init) => {
    masks.push(init.headers['X-Goog-FieldMask']);
    const body = JSON.parse(init.body);
    return jsonRes(body.travelMode === 'TRANSIT' ? ROUTES_SAMPLE : { routes: [{ duration: '600s', distanceMeters: 800 }] });
  };
  const maps = mapsFor({ GOOGLE_MAPS_SERVER_KEY: 'k' }, { fetch, now: () => T0 });
  const a = { lat: 38.716, lng: -9.136 }, b = { lat: 38.716, lng: -9.131 };
  const t = await maps.travel(a, b, 'transit');
  assert.equal(masks[0], 'routes.duration,routes.distanceMeters,routes.legs.steps.travelMode,routes.legs.steps.transitDetails');
  assert.equal(t.minutes, 21);
  assert.equal(t.lines[0].name, '28E');
  const w = await maps.travel(a, b, 'walk');
  assert.equal(masks[1], 'routes.duration,routes.distanceMeters');
  assert.equal(w.lines, undefined);

  const trip = { start: '2026-10-28', travelers: 1, days: [{ stops: [
    { id: 's-a', kind: 'visit', at: '09:00', minutes: 30, mode: 'walk', place: { name: 'Martim Moniz', ...a } },
    { id: 's-b', kind: 'visit', at: '10:00', minutes: 30, mode: 'transit', place: { name: 'Graça', ...b } },
  ] }] };
  const cache = new Map();
  const checks = await checkTrip(trip, maps, { cache: { get: async (k) => cache.get(k), put: async (k, v) => cache.set(k, v) }, now: () => T0 });
  const badge = checks.days[0].stops[1].badges.travel;
  assert.equal(badge.mode, 'transit');
  assert.equal(badge.lines[0].from, 'Martim Moniz');
  assert.ok([...cache.keys()].some((k) => k.startsWith('t2:google:transit:')), 'the travel cache key moved on, so old entries without lines refresh');

  const sample = await checkTrip(trip, standinMaps(() => T0), { now: () => T0 });
  assert.equal(sample.days[0].stops[1].badges.travel.mode, 'transit');
  assert.equal(sample.days[0].stops[1].badges.travel.lines, undefined, 'stand-in maps have no lines');
});

// ── 2. sunset ──

test('forecast: each day’s sunrise and sunset in the place’s own clock, past a daylight-saving change', async () => {
  let asked;
  const fetch = async (url) => {
    asked = new URL(url);
    // Lisbon asked on 2026-10-20 (UTC+1, summer time): Open-Meteo keeps +1 through the 25 October change, per its docs
    return jsonRes({ timezone: 'Europe/Lisbon', utc_offset_seconds: 3600, daily: {
      time: ['2026-10-24', '2026-10-26'],
      weather_code: [1, 3], temperature_2m_max: [22, 20], temperature_2m_min: [15, 14], precipitation_probability_max: [5, 40],
      sunrise: ['2026-10-24T08:11', '2026-10-26T08:13'], sunset: ['2026-10-24T18:44', '2026-10-26T18:41'],
    } });
  };
  const out = await forecast({ lat: 38.72, lng: -9.14, dates: ['2026-10-24', '2026-10-26'] }, { fetch, now: () => Date.parse('2026-10-20T12:00:00Z') });
  assert.match(asked.searchParams.get('daily'), /sunrise,sunset/);
  assert.equal(out[0].sunrise, '08:11');
  assert.equal(out[0].sunset, '18:44');
  assert.equal(out[1].sunset, '17:41', 'after the change Lisbon is UTC+0: 18:41 at +1 is 17:41 local');
  assert.equal(out[1].source, 'Open-Meteo');
  assert.equal(localClock('2026-10-24T18:44', undefined, null), '18:44', 'no offset or zone: the time as sent');
  assert.equal(localClock('soon', 0, 'UTC'), null);
});

test('afterDark: a viewpoint or outdoor stop that ends after sunset, nothing else', () => {
  const trip = { start: '2026-10-28', days: [
    { stops: [
      { id: 's-1', kind: 'visit', at: '17:30', minutes: 60, place: { name: 'Miradouro da Graça' } },
      { id: 's-2', kind: 'visit', at: '17:30', minutes: 60, place: { name: 'Gulbenkian Museum' } },
      { id: 's-3', kind: 'meal', at: '19:00', minutes: 90, place: { name: 'Rooftop restaurant' } },
      { id: 's-4', kind: 'activity', at: '16:00', minutes: 60, place: { name: 'Eduardo VII Park' } },
      { id: 's-5', kind: 'activity', at: '19:00', minutes: 60, place: { name: 'Praia de Carcavelos beach' } },
    ] },
    { stops: [{ id: 's-6', kind: 'visit', at: '20:00', minutes: 30, place: { name: 'Lookout' } }] },
  ] };
  const days = [{ date: '2026-10-28', sunset: '18:02', source: 'Open-Meteo', checked_at: '2026-10-27T12:00:00.000Z' }, { date: '2026-10-29', forecast: null, why: 'Too far ahead for a forecast' }];
  const out = afterDark(trip, days);
  assert.deepEqual(out.map((x) => x.stop), ['s-1', 's-5'], 'museum indoors, a meal, a park visit before dusk and a day without a sunset are not flagged');
  assert.equal(out[0].text, 'Miradouro da Graça: after sunset (18:02); the visit runs 17:30–18:30.');
  assert.deepEqual([out[0].day, out[0].source, out[0].checked_at], [0, 'Open-Meteo', '2026-10-27T12:00:00.000Z']);
});

test('trip-weather returns sunrise, sunset and after_dark', async () => {
  const store = new Map([['trip:abc', { rev: 1, start: '2026-10-28', days: [{ stops: [{ id: 's-1', kind: 'visit', at: '17:45', minutes: 45, place: { name: 'Miradouro de Santa Luzia', lat: 38.711, lng: -9.13 } }] }] }]]);
  const account = { now: () => T0, env: {}, storage: { get: async (k) => store.get(k), put: async () => {}, delete: async () => {} } };
  const fetch = async () => jsonRes({ timezone: 'Europe/Lisbon', utc_offset_seconds: 0, daily: { time: ['2026-10-28'], weather_code: [0], temperature_2m_max: [20], temperature_2m_min: [13], precipitation_probability_max: [0], sunrise: ['2026-10-28T07:15'], sunset: ['2026-10-28T18:02'] } });
  const out = await extraOp(account, 'trip-weather', { id: 'abc' }, { fetch });
  assert.equal(out.days[0].sunset, '18:02');
  assert.equal(out.days[0].sunrise, '07:15');
  assert.equal(out.after_dark.length, 1);
  assert.match(out.after_dark[0].text, /Miradouro de Santa Luzia: after sunset \(18:02\)/);
});

// ── 3. re-checked before you go ──

function fakeAccount(clock, trips) {
  const m = new Map(Object.entries(trips).map(([id, t]) => [`trip:${id}`, t]));
  const storage = {
    get: async (k) => m.get(k),
    put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) m.set(a, b); else m.set(k, v); },
    delete: async (k) => { for (const x of [].concat(k)) m.delete(x); },
    list: async ({ prefix }) => new Map([...m].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
  };
  return { m, storage, env: {}, now: () => clock.t };
}
const ROME = { title: 'Rome', start: '2026-11-10', created: Date.parse('2026-10-01T00:00:00Z'), days: [{ stops: [] }, { stops: [] }] };
const alarmAt = (a) => (a.m.get('alarmq') || []).find((j) => j.key === 'tcheck')?.at;

test('the re-check times: a week before, the day before, each morning at 07:00 UTC', () => {
  assert.deepEqual(recheckTimes(ROME).map((t) => new Date(t).toISOString()), ['2026-11-03T07:00:00.000Z', '2026-11-09T07:00:00.000Z', '2026-11-10T07:00:00.000Z', '2026-11-11T07:00:00.000Z']);
  assert.deepEqual(recheckTimes({ start: '2026-11-10', days: [] }), []);
});

test('the re-check times: 07:00 where the trip is, once its time zone is known', async () => {
  assert.equal(new Date(recheckTimes(ROME, 'Europe/Rome')[2]).toISOString(), '2026-11-10T06:00:00.000Z');
  assert.equal(new Date(recheckTimes({ ...ROME, start: '2026-07-10' }, 'America/New_York')[2]).toISOString(), '2026-07-10T11:00:00.000Z');
  assert.equal(new Date(recheckTimes(ROME, 'Not/AZone')[2]).toISOString(), '2026-11-10T07:00:00.000Z', 'a zone it can’t read: UTC');
  const a = fakeAccount({ t: Date.parse('2026-10-27T12:00:00Z') }, { r1: ROME });
  await a.storage.put('tz:r1', { zone: 'Europe/Rome', from: 'x' });
  assert.equal(await armRecheck(a), Date.parse('2026-11-03T06:00:00Z'));
});

test('the re-check: one missed by more than a day (the job was off) is skipped, not run late', async () => {
  const a = fakeAccount({ t: Date.parse('2026-11-05T07:00:00Z') }, { r1: ROME });
  await a.storage.put('tchk:r1', { alerts: [], ran: Date.parse('2026-10-20T00:00:00Z') });
  let looked = 0;
  await recheckDue(a, { tripOp: async () => { looked++; return { checks: { maps: 'google', days: [], alerts: [] } }; }, notify: async () => {} });
  assert.equal(looked, 0);
  assert.equal(alarmAt(a), Date.parse('2026-11-09T07:00:00Z'));
});

test('the re-check job: one push per new alert, never twice; then the next time; done after the trip', async () => {
  const clock = { t: Date.parse('2026-10-27T12:00:00Z') };
  const a = fakeAccount(clock, { r1: ROME });
  const closed = { kind: 'closed_that_day', stop: 's-x', day: 0, text: 'Vatican Museums: closed on Sundays.' };
  const late = { kind: 'closed_that_day', stop: 's-y', day: 1, text: 'Colosseum: closed that day.' };
  const tight = { kind: 'late', stop: 's-w', day: 1, text: 'the plan’s own timing: not news' };
  const hours = { kind: 'out_of_hours', stop: 's-z', day: 1, text: 'Borghese: open 09:00–19:00 on Wednesday; the visit is 18:30–19:30.' };
  let alerts = [closed];
  const tripOp = async (_a, op, body) => { assert.equal(op, 'trip-get'); assert.equal(body.id, 'r1'); return { checks: { maps: 'google', days: [], alerts } }; };
  const pushes = [];
  const notify = async (_a, n) => { pushes.push(n); return 1; };

  // after a write, the alerts the person saw are what they know; the first re-check is a week before
  assert.equal(await armRecheck(a, { trip: { id: 'r1' }, checks: { maps: 'google', days: [], alerts: [closed] } }), Date.parse('2026-11-03T07:00:00Z'));
  assert.equal(alarmAt(a), Date.parse('2026-11-03T07:00:00Z'));

  clock.t = Date.parse('2026-11-03T07:00:00Z');
  await recheckDue(a, { tripOp, notify });
  assert.equal(pushes.length, 0, 'nothing changed: no push');
  assert.equal(alarmAt(a), Date.parse('2026-11-09T07:00:00Z'));

  alerts = [closed, late, hours, tight];
  clock.t = Date.parse('2026-11-09T07:00:05Z');
  await recheckDue(a, { tripOp, notify });
  assert.equal(pushes.length, 1, 'one push for the two new alerts');
  assert.equal(pushes[0].title, 'Rome: 2 things changed');
  assert.equal(pushes[0].body, `${late.text} ${hours.text}`);
  assert.deepEqual(pushes[0].data, { kind: 'recheck', trip: 'r1' });

  clock.t = Date.parse('2026-11-10T07:00:00Z');
  await recheckDue(a, { tripOp, notify });
  assert.equal(pushes.length, 1, 'the same alerts are not pushed again');

  clock.t = Date.parse('2026-11-11T07:00:00Z');
  await recheckDue(a, { tripOp, notify });
  assert.equal(alarmAt(a), undefined, 'the trip is over: no more re-checks');
  assert.deepEqual(newAlerts(['closed_that_day:s-y:1'], [late, closed]), [closed]);
});

test('the re-check: no baseline yet only sets one; stand-in answers and no Plus push nothing; a trip made late skips past times', async () => {
  const clock = { t: Date.parse('2026-11-03T07:00:00Z') };
  const a = fakeAccount(clock, { r1: ROME });
  const alert = { kind: 'out_of_hours', stop: 's-y', day: 1, text: 'out of hours' };
  const pushes = [];
  const notify = async (_a, n) => { pushes.push(n); };
  let maps = 'google';
  let looked = 0;
  const tripOp = async () => { looked++; return { checks: { maps, days: [], alerts: [alert] } }; };
  await recheckDue(a, { tripOp, notify });
  assert.equal(pushes.length, 0, 'the first look only sets what the person knows');
  assert.deepEqual(a.m.get('tchk:r1').alerts, ['out_of_hours:s-y:1']);

  const b = fakeAccount(clock, { r1: ROME });
  await b.storage.put('tchk:r1', { alerts: [] });
  maps = 'standin';
  await recheckDue(b, { tripOp, notify });
  assert.equal(pushes.length, 0, 'sample data is never news');

  const c = fakeAccount(clock, { r1: ROME });
  await c.storage.put('tchk:r1', { alerts: [] });
  looked = 0;
  await recheckDue(c, { tripOp, notify, plus: async () => false });
  assert.equal(looked, 0, 'no Plus: nothing looked up');

  const late = fakeAccount({ t: Date.parse('2026-11-08T12:00:00Z') }, { r2: { ...ROME, created: Date.parse('2026-11-08T12:00:00Z') } });
  assert.equal(await armRecheck(late), Date.parse('2026-11-09T07:00:00Z'), 'the week-before time had passed when it was made');
  await late.storage.delete('trip:r2');
  await late.storage.put('tchk:r2', { alerts: [] });
  assert.equal(await armRecheck(late), null);
  assert.equal(late.m.has('tchk:r2'), false, 'a deleted trip’s saved alerts go');
});

// ── 4. the destination's hero photo ──

const THUMB = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Lisbon_view.jpg/1600px-Lisbon_view.jpg';
function wiki({ licence = 'CC BY-SA 4.0', artist = '<a href="//commons.wikimedia.org/wiki/User:Ana">Ana &amp; Rui</a>', original = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Lisbon_view.jpg', thumb = THUMB } = {}) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    const u = new URL(url);
    if (u.hostname === 'en.wikipedia.org') return jsonRes({ type: 'standard', title: 'Lisbon', originalimage: { source: original, width: 4000, height: 2667 } });
    if (u.hostname === 'commons.wikimedia.org') {
      const meta = { Artist: { value: artist }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' }, UsageTerms: { value: 'Creative Commons Attribution-Share Alike 4.0' } };
      if (licence !== null) meta.LicenseShortName = { value: licence };
      return jsonRes({ query: { pages: [{ title: 'File:Lisbon view.jpg', imageinfo: [{ thumburl: thumb, thumbwidth: 1600, thumbheight: 1067, url: original, descriptionurl: 'https://commons.wikimedia.org/wiki/File:Lisbon_view.jpg', extmetadata: meta }] }] } });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fetch, calls };
}

test('hero: a CC BY-SA photo with its author, licence and file page', async () => {
  const { fetch, calls } = wiki();
  const h = await heroFor({}, 'Lisbon', { fetch, now: () => T0 });
  assert.deepEqual(h, { url: THUMB, width: 1600, height: 1067, author: 'Ana & Rui', licence: 'CC BY-SA 4.0', licence_url: 'https://creativecommons.org/licenses/by-sa/4.0', usage_terms: 'Creative Commons Attribution-Share Alike 4.0', file_page: 'https://commons.wikimedia.org/wiki/File:Lisbon_view.jpg', title: 'Lisbon', source: 'Wikimedia Commons', checked_at: new Date(T0).toISOString() });
  const q = new URL(calls[1]).searchParams;
  assert.deepEqual([q.get('titles'), q.get('prop'), q.get('iiprop'), q.get('iiurlwidth')], ['File:Lisbon_view.jpg', 'imageinfo', 'extmetadata|url', '1600']);
});

test('hero: NC, ND, a missing licence, a non-Commons image and an uncredited CC BY are refused', async () => {
  assert.equal(await heroFor({}, 'Lisbon', { fetch: wiki({ licence: 'CC BY-NC 2.0' }).fetch }), null);
  assert.equal(await heroFor({}, 'Lisbon', { fetch: wiki({ licence: 'CC BY-SA-ND 3.0' }).fetch }), null);
  assert.equal(await heroFor({}, 'Lisbon', { fetch: wiki({ licence: null }).fetch }), null);
  assert.equal(await heroFor({}, 'Lisbon', { fetch: wiki({ licence: 'Fair use' }).fetch }), null);
  assert.equal(await heroFor({}, 'Lisbon', { fetch: wiki({ original: 'https://upload.wikimedia.org/wikipedia/en/a/ab/Poster.jpg' }).fetch }), null, 'English Wikipedia’s own (non-free) file');
  assert.equal(await heroFor({}, 'Lisbon', { fetch: wiki({ artist: '' }).fetch }), null, 'CC BY-SA with no one to credit');
  assert.equal((await heroFor({}, 'Lisbon', { fetch: wiki({ licence: 'Public domain', artist: '' }).fetch })).author, null, 'public domain needs no credit');
  assert.equal(await heroFor({}, 'Lisbon', { fetch: wiki({ thumb: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Lisbon_view.jpg' }).fetch }), null, 'no 1600 px thumbnail');
  assert.deepEqual(['CC0', 'Public domain', 'CC BY 4.0', 'CC BY-SA 2.0 de', 'CC BY-NC-SA 4.0', 'CC BY-ND 4.0', '', 'GFDL'].map(allowedLicence), ['CC0', 'Public domain', 'CC BY 4.0', 'CC BY-SA 2.0 de', null, null, null, null]);
  assert.equal(plainText('<span>Foo&#39;s <b>photo</b>&nbsp;</span>'), 'Foo\'s photo');
});

test('hero-image proxy: only Commons thumbnails, images only, cached publicly a day', async () => {
  for (const bad of ['https://example.com/x.jpg', 'http://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/1600px-X.jpg', 'https://upload.wikimedia.org/wikipedia/en/thumb/a/ab/X.jpg/1600px-X.jpg', 'https://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg', 'https://upload.wikimedia.org.evil.com/wikipedia/commons/thumb/a/ab/X.jpg/1600px-X.jpg', `${THUMB}?x=1`, 'https://upload.wikimedia.org:8443/wikipedia/commons/thumb/a/ab/X.jpg/1600px-X.jpg', '']) {
    assert.equal(heroImageAllowed(bad), false, bad);
    await assert.rejects(heroImage(new URL(`https://askeden.com/api/chat/travel/hero-image?u=${encodeURIComponent(bad)}`), { fetch: async () => { throw new Error('fetched'); } }), (e) => e.code === 'bad_request');
  }
  assert.equal(heroImageAllowed(THUMB), true);
  const ok = await heroImage(new URL(`https://askeden.com/api/chat/travel/hero-image?u=${encodeURIComponent(THUMB)}`), { fetch: async () => new Response('jpg', { headers: { 'content-type': 'image/jpeg' } }) });
  assert.equal(ok.headers.get('cache-control'), 'public, max-age=86400');
  assert.equal(ok.headers.get('content-type'), 'image/jpeg');
  await assert.rejects(heroImage(new URL(`https://askeden.com/api/chat/travel/hero-image?u=${encodeURIComponent(THUMB)}`), { fetch: async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }) }), (e) => e.code === 'unavailable');
});

// ── 5. the stop detail's larger photo ──

test('place photos go up to 1600 px wide', async () => {
  let asked;
  const fetch = async (url) => { asked = new URL(url); return new Response('jpg', { headers: { 'content-type': 'image/jpeg' } }); };
  const name = 'places/ChIJ0000000000/photos/AbCdEfGhIjKlMn';
  await placePhoto({ GOOGLE_MAPS_SERVER_KEY: 'k' }, new URL(`https://askeden.com/api/chat/travel/photo?n=${name}&w=1200`), { fetch });
  assert.equal(asked.searchParams.get('maxWidthPx'), '1200');
  await placePhoto({ GOOGLE_MAPS_SERVER_KEY: 'k' }, new URL(`https://askeden.com/api/chat/travel/photo?n=${name}&w=4000`), { fetch });
  assert.equal(asked.searchParams.get('maxWidthPx'), '1600');
});

test('a CC BY credit always links its licence: from Commons, else built from the name', () => {
  assert.equal(licenceDeed('CC BY-SA 2.0 de'), 'https://creativecommons.org/licenses/by-sa/2.0/de/');
  assert.equal(licenceDeed('CC BY 4.0'), 'https://creativecommons.org/licenses/by/4.0/');
  assert.equal(licenceDeed('Public domain'), null);
});
