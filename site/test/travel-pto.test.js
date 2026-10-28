// "Best time to go" (travel/pto.js): a country's public holidays for a year, a region's added only when one is picked,
// half days marked, each with its source and checked_at; the countries for the picker; a clear "not covered" (Nager.Date
// named, with the sponsorship it needs); cached per source, country and year. Fake fetches only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appliesIn, notCovered, parseSubdivisions, ptoCountries, ptoOp } from '../src/travel/pto.js';

const NOW = Date.parse('2026-10-28T10:00:00Z');
const row = (date, text, o = {}) => ({ startDate: date, endDate: date, type: 'Public', name: [{ language: 'EN', text }], nationwide: true, temporalScope: 'FullDay', ...o });
const IT_2027 = [
  row('2027-01-01', "New Year's Day"), row('2027-03-29', 'Easter Monday'), row('2027-04-25', 'Liberation Day'),
  row('2027-12-07', "St. Ambrose's Day", { nationwide: false, subdivisions: [{ code: 'IT-LO-MI' }] }),
  row('2027-06-24', "St. John's Day", { nationwide: false, subdivisions: [{ code: 'IT-LI-GE' }, { code: 'IT-TO-FI' }] }),
  row('2027-04-28', "Sardinia's Day", { nationwide: false, subdivisions: [{ code: 'IT-SA' }] }),
  row('2027-12-24', 'Christmas Eve', { temporalScope: 'HalfDay' }),
  row('2027-12-25', 'Christmas Day'),
  { startDate: '2027-05-01', endDate: '2027-05-01', type: 'Bank', name: [{ language: 'EN', text: 'Not public' }], nationwide: true },
];
const SUBS = [{ code: 'IT-LO', name: [{ language: 'EN', text: 'Lombardy' }], children: [{ code: 'IT-LO-MI', name: [{ language: 'EN', text: 'Milan' }] }] },
  { code: 'IT-SA', name: [{ language: 'EN', text: 'Sardinia' }] }];

function fakes({ down = false } = {}) {
  const calls = [];
  const fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (down) return new Response('no', { status: 503 });
    if (u.startsWith('https://openholidaysapi.org/PublicHolidays?countryIsoCode=IT&validFrom=2027')) return Response.json(IT_2027);
    if (u.startsWith('https://openholidaysapi.org/Subdivisions?countryIsoCode=IT')) return Response.json(SUBS);
    if (u === 'https://date.nager.at/api/v3/PublicHolidays/2027/US') {
      return Response.json([
        { date: '2027-07-05', localName: 'Independence Day', name: 'Independence Day', global: true, counties: null, types: ['Public'] },
        { date: '2027-03-31', localName: 'César Chávez Day', name: 'César Chávez Day', global: false, counties: ['US-CA'], types: ['Public'] },
        { date: '2027-02-15', localName: 'x', name: 'Observance', global: true, types: ['Observance'] },
      ]);
    }
    return new Response('{}', { status: 404 });
  };
  return { fetch, calls };
}
function account(env = {}) {
  const m = new Map();
  const storage = { async get(k) { return m.get(k); }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } };
  return { storage, env, now: () => NOW, m };
}
function memCache(now = () => NOW) {
  const m = new Map();
  return {
    m,
    async get(k) { const e = m.get(k); return e && e.fresh > now() ? e.v : undefined; },
    async entry(k) { const e = m.get(k); return e && e.until > now() ? { v: e.v, at: e.at } : undefined; },
    async put(k, v, ms, keep = ms) { m.set(k, { v, at: now(), fresh: now() + ms, until: now() + Math.max(ms, keep) }); },
  };
}

test('nationwide only without a region; half days marked; non-public dropped; source and checked_at on each', async () => {
  const { fetch, calls } = fakes();
  const r = await ptoOp(account(), 'trip-pto-holidays', { country: 'it', year: 2027 }, { cache: memCache(), fetch });
  assert.equal(r.covered, true);
  assert.equal(r.country, 'IT');
  assert.equal(r.country_name, 'Italy');
  assert.equal(r.source, 'OpenHolidays API');
  assert.match(r.licence, /ODbL/);
  assert.deepEqual(r.holidays.map((h) => h.date), ['2027-01-01', '2027-03-29', '2027-04-25', '2027-12-24', '2027-12-25']);
  assert.equal(r.holidays.find((h) => h.date === '2027-12-24').half, true);
  assert.ok(r.holidays.every((h) => h.source === 'OpenHolidays API' && h.checked_at === '2026-10-28T10:00:00.000Z' && h.scope === 'national'));
  assert.deepEqual(r.regions, [{ code: 'IT-LO', name: 'Lombardy' }, { code: 'IT-LO-MI', name: 'Lombardy · Milan' }, { code: 'IT-SA', name: 'Sardinia' }]);
  assert.ok(r.countries.some((c) => c.code === 'IT') && !r.countries.some((c) => c.code === 'US'));
  assert.equal(calls.length, 2);
});

test('a region adds its own holidays and its parts’ only when that part is picked', async () => {
  const { fetch } = fakes();
  const milan = await ptoOp(account(), 'trip-pto-holidays', { country: 'IT', region: 'it-lo-mi', year: 2027 }, { cache: memCache(), fetch });
  assert.ok(milan.holidays.some((h) => h.name === "St. Ambrose's Day" && h.scope === 'regional'));
  assert.ok(!milan.holidays.some((h) => h.name === "Sardinia's Day"));
  const lombardy = await ptoOp(account(), 'trip-pto-holidays', { country: 'IT', region: 'IT-LO', year: 2027 }, { cache: memCache(), fetch });
  assert.ok(!lombardy.holidays.some((h) => h.name === "St. Ambrose's Day")); // Milan's day isn't all Lombardy's
  const sardinia = await ptoOp(account(), 'trip-pto-holidays', { country: 'IT', region: 'IT-SA', year: 2027 }, { cache: memCache(), fetch });
  assert.ok(sardinia.holidays.some((h) => h.date === '2027-04-28'));
  assert.equal(appliesIn(['IT-LO'], 'IT-LO-MI'), true);
  assert.equal(appliesIn(['IT-LO-MI'], 'IT-LO'), false);
  assert.equal(appliesIn(null, null), true);
});

test('cached per source, country and year: the second call fetches nothing', async () => {
  const { fetch, calls } = fakes();
  const cache = memCache();
  await ptoOp(account(), 'trip-pto-holidays', { country: 'IT', year: 2027 }, { cache, fetch });
  await ptoOp(account(), 'trip-pto-holidays', { country: 'IT', region: 'IT-SA', year: 2027 }, { cache, fetch });
  assert.equal(calls.length, 2);
  assert.ok(cache.m.has('pto1:open:IT:2027') && cache.m.has('pto1:subs:IT'));
});

test('the source down: nothing counted, says so; not cached', async () => {
  const { fetch } = fakes({ down: true });
  const cache = memCache();
  const r = await ptoOp(account(), 'trip-pto-holidays', { country: 'IT', year: 2027 }, { cache, fetch });
  assert.equal(r.covered, true);
  assert.deepEqual(r.holidays, []);
  assert.match(r.unavailable, /didn’t answer/);
  assert.equal(cache.m.size, 0);
});

test('not covered: the US without the sponsorship names Nager.Date and the owner’s sponsorship; fetches nothing', async () => {
  const { fetch, calls } = fakes();
  const r = await ptoOp(account(), 'trip-pto-holidays', { country: 'US', year: 2027 }, { cache: memCache(), fetch });
  assert.equal(r.covered, false);
  assert.deepEqual(r.holidays, []);
  assert.match(r.why, /Nager\.Date does/);
  assert.match(r.why, /sponsor/);
  assert.equal(r.would_cover.source, 'Nager.Date');
  assert.equal(calls.length, 0);
  // a country neither has
  assert.match(notCovered('KP').why, /Neither OpenHolidays API nor Nager\.Date/);
  assert.equal(notCovered('KP').would_cover, null);
});

test('with the sponsorship: Nager.Date for the US, its counties as regions, observances left out', async () => {
  const { fetch } = fakes();
  const env = { NAGER_DATE_SPONSOR: '1' };
  const r = await ptoOp(account(env), 'trip-pto-holidays', { country: 'US', year: 2027 }, { cache: memCache(), fetch });
  assert.equal(r.source, 'Nager.Date');
  assert.deepEqual(r.holidays.map((h) => h.name), ['Independence Day']);
  assert.deepEqual(r.regions, [{ code: 'US-CA', name: 'US-CA' }]);
  const ca = await ptoOp(account(env), 'trip-pto-holidays', { country: 'US', region: 'US-CA', year: 2027 }, { cache: memCache(), fetch });
  assert.deepEqual(ca.holidays.map((h) => h.name), ['César Chávez Day', 'Independence Day']);
  assert.ok(ptoCountries(env).some((c) => c.code === 'US' && c.source === 'Nager.Date'));
});

test('arguments: no country lists the countries; bad country, year or region refused', async () => {
  const { fetch } = fakes();
  const r = await ptoOp(account(), 'trip-pto-holidays', {}, { fetch });
  assert.equal(r.countries.length, 36);
  assert.equal(r.holidays, undefined);
  await assert.rejects(ptoOp(account(), 'trip-pto-holidays', { country: 'Italy' }, { fetch }), /two-letter/);
  await assert.rejects(ptoOp(account(), 'trip-pto-holidays', { country: 'IT', year: 2030 }, { fetch }), /year: 2025 to 2028/);
  await assert.rejects(ptoOp(account(), 'trip-pto-holidays', { country: 'IT', region: 'DE-BY' }, { fetch }), /region/);
  await assert.rejects(ptoOp(account(), 'trip-nope', {}, { fetch }), /Not found/);
  assert.deepEqual(parseSubdivisions([{ code: 'bad' }, { code: 'DE-BY', name: [] }]), [{ code: 'DE-BY', name: 'DE-BY' }]);
});
