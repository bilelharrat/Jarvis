// "Best time to go" (the page's travel-pto.js): a country's public holidays for a year, so the page can turn the
// person's days off (PTO) into the longest breaks. The optimizer itself runs on the page; this only says which days are
// public holidays there, each with its source and when it was checked.
//
// Sources: the same as holidays.js (read its header for the terms): OpenHolidays API (ODbL, attribution on every
// badge; 36 countries) first, Nager.Date only when the owner sponsors it (NAGER_DATE_SPONSOR=1) and only for the
// countries OpenHolidays doesn't cover. holidays.js keeps nationwide holidays only (it has no region to match); here a
// region the person picks adds that region's holidays too: OpenHolidays' subdivisions (IT-LO, DE-BY…; its
// /Subdivisions list for the picker), Nager.Date's "counties" (US-CA…). A holiday for part of a region (a city's saint's
// day, IT-VE-VE) counts only when that part is what was picked. A half-day holiday (OpenHolidays temporalScope
// HalfDay) is listed but marked half: the page never counts it as a day off.
// A country neither source covers: a clear "not covered", naming Nager.Date when its list has the country (its
// /AvailableCountries, read 2026-10-28: NAGER_COUNTRIES below), and that it needs the owner's sponsorship.
//
// Cached in the account's object like holidays.js, under its own keys (tcache:pto1:…; regional rows kept): fresh 30
// days, kept a year; a failed lookup isn't cached and says so.

import { TripError } from './trips.js';
import { ApiError } from '../accounts/util.js';
import { HOLIDAYS, OPEN_COUNTRIES, SOURCE, countryName, sourceFor } from './holidays.js';

const OPEN = 'https://openholidaysapi.org';
const NAGER = 'https://date.nager.at/api/v3/PublicHolidays';
export const SOURCE_URL = { open: 'https://openholidaysapi.org', nager: 'https://date.nager.at' };
export const LICENCE = { open: 'Open Data Commons ODbL 1.0', nager: 'Nager.Date terms (sponsored)' };
// Nager.Date's /AvailableCountries (204 countries, read 2026-10-28): only to say which source would cover a country
export const NAGER_COUNTRIES = new Set(('AD AG AI AL AM AO AR AT AU AW AX BA BB BD BE BF BG BH BI BJ BL BM BO BQ BR BS BW BY BZ CA CC CD '
  + 'CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FK FM FO FR GA GB GD GE GF GG GH '
  + 'GI GL GM GN GP GQ GR GT GW GY HK HN HR HT HU ID IE IM IQ IS IT JE JM JP KE KH KI KM KN KR KY KZ LC LI LR LS LT LU LV LY '
  + 'MA MC MD ME MF MG MH MK ML MN MP MQ MR MS MT MW MX MZ NA NC NE NF NG NI NL NO NR NU NZ PA PE PF PG PH PL PM PN PR PT PW '
  + 'PY RO RS RU RW SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TK TN TO TR TT TV TZ UA UG US UY VA '
  + 'VC VE VG VI VN VU WF WS YE ZA ZM ZW').split(' '));
export const PTO = { years: [-1, 2] }; // this year minus one to this year plus two
const CC = /^[A-Z]{2}$/;
const REGION = /^[A-Z]{2}(-[A-Z0-9]{1,4}){1,2}$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86400_000;
const nameOf = (names) => { const a = Array.isArray(names) ? names : []; return String((a.find((n) => n?.language === 'EN') || a[0] || {}).text || '').slice(0, 80); };

/** OpenHolidays rows → [{ date, name, regions: null | ['IT-LO', …], half }] (public holidays; a multi-day one: each day). */
export function parseOpenAll(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || r.type !== 'Public' || !YMD.test(r.startDate || '')) continue;
    const regions = r.nationwide === true ? null : (Array.isArray(r.subdivisions) ? r.subdivisions.map((s) => String(s?.code || '')).filter((c) => REGION.test(c)) : []);
    if (regions && !regions.length) continue; // regional, but no region it applies to: nothing to match
    const end = YMD.test(r.endDate || '') ? r.endDate : r.startDate;
    const half = r.temporalScope === 'HalfDay';
    for (let t = Date.parse(`${r.startDate}T00:00:00Z`), i = 0; t <= Date.parse(`${end}T00:00:00Z`) && i < 31; t += DAY, i++) out.push({ date: new Date(t).toISOString().slice(0, 10), name: nameOf(r.name), regions, half });
  }
  return out;
}
/** Nager.Date rows → the same shape (its "counties" are the regions). */
export function parseNagerAll(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && YMD.test(r.date || '') && (!Array.isArray(r.types) || r.types.includes('Public')))
    .map((r) => ({ date: r.date, name: String(r.name || r.localName || '').slice(0, 80), regions: r.global === true ? null : (Array.isArray(r.counties) ? r.counties.filter((c) => REGION.test(String(c))) : []), half: false }))
    .filter((h) => !h.regions || h.regions.length);
}
/** OpenHolidays /Subdivisions → [{ code, name }], children after their parent ("Lombardy · Milan"). */
export function parseSubdivisions(rows) {
  const out = [];
  const walk = (list, parent) => {
    for (const s of Array.isArray(list) ? list : []) {
      if (!s || !REGION.test(String(s.code || ''))) continue;
      const name = nameOf(s.name) || s.code;
      out.push({ code: s.code, name: parent ? `${parent} · ${name}` : name });
      if (out.length < 400) walk(s.children, parent ? `${parent} · ${name}` : name);
    }
  };
  walk(rows, '');
  return out.slice(0, 400);
}

/** Does a holiday for these regions apply to the region picked? The region itself or a part of one listed (a
 *  holiday for IT-LO applies in IT-LO-MI); never the other way (Milan's saint's day isn't Lombardy's). */
export function appliesIn(regions, region) {
  if (!regions) return true;
  if (!region) return false;
  return regions.some((c) => region === c || region.startsWith(`${c}-`));
}

// one cached GET (the cache: ops.js cacheIn), { v, checked_at } or null; the last answer however old when it fails
async function cached({ cache, fetch: fetcher, now }, key, url, parse) {
  let e;
  if (cache?.entry) e = await cache.entry(key);
  else if (cache) { const v = await cache.get(key); if (v !== undefined) e = { v, at: now() }; }
  if (e && now() - e.at <= HOLIDAYS.freshMs) return e.v;
  try {
    const res = await fetcher(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(HOLIDAYS.timeoutMs) });
    if (!res.ok) throw new Error(String(res.status));
    const v = { list: parse(await res.json()), checked_at: new Date(now()).toISOString() };
    if (cache) await cache.put(key, v, HOLIDAYS.freshMs, HOLIDAYS.keepMs);
    return v;
  } catch {
    return e ? e.v : null;
  }
}

/** Not covered: which source would cover the country, and why it's off. */
export function notCovered(cc) {
  const nager = NAGER_COUNTRIES.has(cc);
  return {
    covered: false,
    why: nager
      ? `OpenHolidays API doesn’t cover ${countryName(cc)}. Nager.Date does, but its terms ask commercial users to sponsor it, so it stays off until Eden’s owner sponsors it.`
      : `Neither OpenHolidays API nor Nager.Date covers ${countryName(cc)}, so Eden has no public holidays for it. Enter them as company days off.`,
    would_cover: nager ? { source: SOURCE.nager, url: SOURCE_URL.nager, needs: 'the owner’s sponsorship' } : null,
  };
}

/**
 * A country's public holidays for a year (and a region's, when one is given):
 * { covered, country, country_name, region, year, source, source_url, licence, checked_at, regions, holidays:
 *   [{ date, name, scope: 'national'|'regional', half, source, checked_at }] } or covered:false with why.
 */
export async function ptoHolidays({ country, region = null, year }, { env = {}, fetch: fetcher = globalThis.fetch, cache = null, now = () => Date.now() } = {}) {
  const cc = String(country || '').toUpperCase();
  const base = { country: cc, country_name: countryName(cc), region: region || null, year };
  const src = sourceFor(cc, env);
  if (!src) return { ...base, ...notCovered(cc), holidays: [], regions: [] };
  const deps = { cache, fetch: fetcher, now };
  const url = src === 'open'
    ? `${OPEN}/PublicHolidays?countryIsoCode=${cc}&validFrom=${year}-01-01&validTo=${year}-12-31&languageIsoCode=EN`
    : `${NAGER}/${year}/${cc}`;
  const [y, subs] = await Promise.all([
    cached(deps, `pto1:${src}:${cc}:${year}`, url, src === 'open' ? parseOpenAll : parseNagerAll),
    src === 'open' ? cached(deps, `pto1:subs:${cc}`, `${OPEN}/Subdivisions?countryIsoCode=${cc}&languageIsoCode=EN`, parseSubdivisions) : null,
  ]);
  const meta = { source: SOURCE[src], source_url: SOURCE_URL[src], licence: LICENCE[src] };
  if (!y) return { ...base, covered: true, ...meta, checked_at: null, unavailable: `${SOURCE[src]} didn’t answer. Nothing is counted as a holiday until it does; try again later.`, holidays: [], regions: subs?.list || [] };
  // the region picker: OpenHolidays' list; Nager.Date has none, so the regions its holidays name (codes only)
  const regions = subs?.list?.length ? subs.list : [...new Set(y.list.flatMap((h) => h.regions || []))].sort().map((code) => ({ code, name: code }));
  const seen = new Set();
  const holidays = y.list
    .filter((h) => appliesIn(h.regions, region))
    .filter((h) => { const k = `${h.date}|${h.name}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((h) => ({ date: h.date, name: h.name, scope: h.regions ? 'regional' : 'national', half: Boolean(h.half), source: SOURCE[src], checked_at: y.checked_at }));
  return { ...base, covered: true, ...meta, checked_at: y.checked_at, holidays, regions };
}

/** The countries with a source now (the page's picker): OpenHolidays' 36, plus Nager.Date's when sponsored. */
export function ptoCountries(env = {}) {
  const codes = new Set(OPEN_COUNTRIES);
  if (String(env.NAGER_DATE_SPONSOR || '') === '1') for (const c of NAGER_COUNTRIES) codes.add(c);
  return [...codes].map((code) => ({ code, name: countryName(code), source: SOURCE[sourceFor(code, env)] })).sort((a, b) => a.name.localeCompare(b.name));
}

/** ops.js: trip-pto-holidays { country?, region?, year? } → the holidays (above), with the countries for the picker. */
export async function ptoOp(account, op, body = {}, { cache, fetch } = {}) {
  if (op !== 'trip-pto-holidays') throw new ApiError(404, 'not_found', 'Not found');
  const now = () => account.now();
  const countries = ptoCountries(account.env || {});
  if (body.country == null || body.country === '') return { countries };
  const cc = String(body.country).toUpperCase();
  if (!CC.test(cc)) throw new TripError('country must be a two-letter country code (IT, DE…).');
  const thisYear = new Date(now()).getUTCFullYear();
  const year = body.year == null || body.year === '' ? thisYear : Number(body.year);
  if (!Number.isInteger(year) || year < thisYear + PTO.years[0] || year > thisYear + PTO.years[1]) throw new TripError(`year: ${thisYear + PTO.years[0]} to ${thisYear + PTO.years[1]}.`);
  let region = null;
  if (body.region != null && body.region !== '') {
    region = String(body.region).toUpperCase();
    if (!REGION.test(region) || !region.startsWith(`${cc}-`)) throw new TripError(`region must be one of ${cc}’s region codes (${cc}-…).`);
  }
  return { ...(await ptoHolidays({ country: cc, region, year }, { env: account.env || {}, fetch, cache, now })), countries };
}
