// Public holidays for the hours checks (checks.js): Google's hours are weekly beyond its 7-day window, so a stop on a
// country's public holiday gets a 'look' ("hours may differ"), never "closed" unless a source says so.
//
// Sources (terms read 2026-10-28):
//   OpenHolidays API  https://openholidaysapi.org  open data, ODbL-1.0 (https://github.com/openpotato/openholidaysapi.data):
//                     commercial use allowed with attribution, so every badge names it. 36 countries (its /Countries,
//                     2026-10-28: OPEN_COUNTRIES below). GET /PublicHolidays?countryIsoCode=IT&validFrom=…&validTo=…
//                     &languageIsoCode=EN → [{ startDate, endDate, type, name: [{ language, text }], nationwide }].
//   Nager.Date        https://date.nager.at/api/v3/PublicHolidays/{year}/{CC} → [{ date, localName, name, global, types }].
//                     Its terms (nagerholidays.com/legal/termsofservice, 2023-09-15): "private or non-profit projects";
//                     "For commercial purposes we require active sponsorship". So off unless NAGER_DATE_SPONSOR=1 (the
//                     owner sponsors), and then only for countries OpenHolidays doesn't cover (the US, the UK, Japan…).
// A country neither covers: no holiday check (nothing said, nothing guessed).
// Only nationwide holidays: a regional one (a city's saint's day) needs the stop's region, which isn't matched here.
//
// Cached in the account's object per source, country and year (tcache:hol1:<src>:<CC>:<year>): fresh 30 days, kept a
// year; a failed lookup isn't cached and says nothing.

import { countriesIn } from './esim.js';

const DAY = 86400_000;
export const HOLIDAYS = { freshMs: 30 * DAY, keepMs: 400 * DAY, timeoutMs: 6000 };
const OPEN = 'https://openholidaysapi.org/PublicHolidays';
const NAGER = 'https://date.nager.at/api/v3/PublicHolidays';
export const OPEN_COUNTRIES = new Set('AD AL AT BE BG BR BY CH CZ DE EE ES FR HR HU IE IT LI LT LU LV MC MD MT MX NL PL PT RO RS SE SI SK SM VA ZA'.split(' '));
export const SOURCE = { open: 'OpenHolidays API', nager: 'Nager.Date' };
const CC = /^[A-Z]{2}$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Which source answers for a country: 'open', 'nager' (sponsor only) or null. */
export function sourceFor(cc, env = {}) {
  if (!CC.test(String(cc || ''))) return null;
  if (OPEN_COUNTRIES.has(cc)) return 'open';
  return String(env.NAGER_DATE_SPONSOR || '') === '1' ? 'nager' : null;
}

/** A stop's country: Google's (the place's addressComponents) first, else the trip's destination when it names one
 *  country (esim.js countriesIn: "Rome, Italy" → IT), else null. */
export function stopCountry(place, trip) {
  if (place && CC.test(String(place.country || ''))) return place.country;
  const cs = countriesIn(trip?.destination).concat(countriesIn(trip?.title)).filter((c, i, a) => a.indexOf(c) === i);
  return cs.length === 1 ? cs[0] : null;
}

let REGION = null;
/** The country's English name (Intl), else its code. */
export function countryName(cc) {
  try { REGION ||= new Intl.DisplayNames(['en'], { type: 'region' }); return REGION.of(cc) || cc; } catch { return cc; }
}

// one source's answer for a year → [{ date, name }], nationwide public holidays only (a multi-day one: each day)
export function parseOpen(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || r.type !== 'Public' || r.nationwide !== true || !YMD.test(r.startDate || '')) continue;
    const names = Array.isArray(r.name) ? r.name : [];
    const name = String((names.find((n) => n?.language === 'EN') || names[0] || {}).text || '').slice(0, 80);
    const end = YMD.test(r.endDate || '') ? r.endDate : r.startDate;
    for (let t = Date.parse(`${r.startDate}T00:00:00Z`), i = 0; t <= Date.parse(`${end}T00:00:00Z`) && i < 31; t += DAY, i++) out.push({ date: new Date(t).toISOString().slice(0, 10), name });
  }
  return out;
}
export function parseNager(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.global === true && YMD.test(r.date || '') && (!Array.isArray(r.types) || r.types.includes('Public')))
    .map((r) => ({ date: r.date, name: String(r.name || r.localName || '').slice(0, 80) }));
}

/**
 * The public-holiday lookup checks.js uses: (cc, 'YYYY-MM-DD') → { date, name, country, country_name, source, checked_at }
 * or null (not a public holiday there, no source for the country, or the source didn't answer). One request per source,
 * country and year, shared through `cache` (ops.js cacheIn: get/put/entry) and memoised for one check.
 */
export function holidayLookup({ env = {}, fetch: fetcher = globalThis.fetch, cache = null, now = () => Date.now() } = {}) {
  const memo = new Map();
  const year = async (src, cc, y) => {
    const key = `hol1:${src}:${cc}:${y}`;
    if (!memo.has(key)) memo.set(key, (async () => {
      // { v, at } of the cached answer; a cache with get/put only: what it has counts as fresh (as checks.js lookups)
      let e;
      if (cache?.entry) e = await cache.entry(key);
      else if (cache) { const v = await cache.get(key); if (v !== undefined) e = { v, at: now() }; }
      if (e && now() - e.at <= HOLIDAYS.freshMs) return e.v;
      const url = src === 'open'
        ? `${OPEN}?countryIsoCode=${cc}&validFrom=${y}-01-01&validTo=${y}-12-31&languageIsoCode=EN`
        : `${NAGER}/${y}/${cc}`;
      try {
        const res = await fetcher(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(HOLIDAYS.timeoutMs) });
        if (!res.ok) throw new Error(String(res.status));
        const list = (src === 'open' ? parseOpen : parseNager)(await res.json());
        const v = { list, source: SOURCE[src], checked_at: new Date(now()).toISOString() };
        if (cache) await cache.put(key, v, HOLIDAYS.freshMs, HOLIDAYS.keepMs);
        return v;
      } catch {
        return e ? e.v : null; // the last answer, however old (it carries its own checked_at), or nothing
      }
    })());
    return memo.get(key);
  };
  return async (cc, date) => {
    const src = sourceFor(cc, env);
    if (!src || !YMD.test(String(date || ''))) return null;
    const y = await year(src, cc, date.slice(0, 4));
    const h = y && y.list.find((x) => x.date === date);
    return h ? { date, name: h.name, country: cc, country_name: countryName(cc), source: y.source, checked_at: y.checked_at } : null;
  };
}

/** "Thu 25 Dec" / "25 Dec" for a 'YYYY-MM-DD'. */
export function dayLabel(date, { weekday = true } = {}) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { ...(weekday ? { weekday: 'short' } : {}), day: 'numeric', month: 'short', timeZone: 'UTC' });
}
