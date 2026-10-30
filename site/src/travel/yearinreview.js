// "Your year in travel": one calendar year of the account's trips, the organiser's own and the ones shared with them,
// from what Eden Travel holds, each figure saying where it came from:
//   trips      trips that start in the year and have ended (ones still to come are counted apart, never in the totals)
//   days away  the trips' dates that fall in the year (a trip over New Year gives each year its own days)
//   places     cities and countries from the trips' destinations as the person named them; a country is listed only
//              where a destination names it (no reverse lookup), so cities without a named country don't add one
//   distance   straight lines between stops in the order planned (memories.js recap), never road or air miles; the way
//              from home and back isn't known, so it isn't in it
//   nights     from the stays' nights, else the trip's days less one (memories.js recap says which)
//   flights    flight stops in the plans (a flight word or number in a transport stop), and how many were booked
//   money      each trip's total in its own currency (money.js); summed across currencies only when converted at the
//              European Central Bank's rate of a stated date, and your share beside each total
//   price drops cheaper prices Eden found for your bookings (stayops.js, fpwatch.js) still on record: found, not saved,
//              unless a saving was recorded (`tsaved:`, written when a rebook goes through)
//   checks     Eden's live-source checks on the year's trips as last looked at (accuracy.js snapshots), how many flagged
//              something, and how many you reported wrong
//   points     from rewards.js when the account has it (handed in as deps.rewards), else the card estimate below
//   card estimate  what the best of your saved cards would earn on the booked stops (cardperk.js), estimated
//
// Private: it's computed for the signed-in person only; the page draws the shareable card on the device and nothing is
// published.
//
//   trip-year { year? } → the year (yearOf below)

import { ApiError } from '../accounts/util.js';
import { recap } from './memories.js';
import { dayDate } from './trips.js';
import { FLIGHT_NO } from './watch.js';
import { snapValue } from './accuracy.js';
import { tripRewards } from './cards.js';
import { cardPerk, ecbRates, perkTrip, usdRates } from './cardperk.js';
import { ask as askDefault } from './track.js';
import { RATES_SOURCE } from './money.js';

export const YEAR = { min: 2000, joined: 40 };
const FLIGHT_WORD = /\b(fly|flights?|airlines?|plane)\b/i;
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// country names as Intl knows them (English), plus the short forms people write; lower case → { code, name }
let COUNTRY = null;
export function countries() {
  if (COUNTRY) return COUNTRY;
  COUNTRY = new Map();
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      let name;
      try { name = names.of(code); } catch { continue; }
      // the first code for a name wins (FR before the old FX "France", GB before UK)
      if (name && name !== code && !/unknown/i.test(name) && !COUNTRY.has(name.toLowerCase())) COUNTRY.set(name.toLowerCase(), { code, name });
    }
  } catch { /* no Intl regions: no countries, only cities */ }
  for (const [k, code] of [['usa', 'US'], ['us', 'US'], ['america', 'US'], ['uk', 'GB'], ['great britain', 'GB'], ['britain', 'GB'], ['uae', 'AE'], ['holland', 'NL'], ['czechia', 'CZ']]) {
    const hit = [...COUNTRY.values()].find((c) => c.code === code);
    if (hit && !COUNTRY.has(k)) COUNTRY.set(k, hit);
  }
  return COUNTRY;
}

/** A destination's parts ("Lisbon, Porto & Portugal") → { cities, countries } as written. */
export function placesIn(destination) {
  const parts = clean(destination, 200).split(/\s*(?:,|\/|→|->|–|—|&|\+|\band\b)\s*/i).map((x) => x.trim()).filter(Boolean);
  const C = countries();
  const out = { cities: [], countries: [] };
  for (const p of parts) {
    const c = C.get(p.toLowerCase());
    if (c) out.countries.push(c);
    else out.cities.push(p);
  }
  return out;
}

const isFlight = (s) => s.kind === 'transport' && (FLIGHT_WORD.test(`${s.place.name} ${s.note || ''}`) || FLIGHT_NO.test(`${s.place.name} ${s.note || ''}`));

/**
 * The year, from what's been gathered (pure). entries: [{ id, trip, shared, money?, snap?, reports? }];
 * extra: { drops: [{ currency, by, what, source, kind }], saved: [{ currency, amount, what, at }], fx (ECB, base = the
 * year's main currency), reports (count you reported wrong), rewards (rewards.js points or null), cardEstimate }.
 */
export function yearOf(year, entries, extra = {}, { now = Date.now() } = {}) {
  const first = `${year}-01-01`, last = `${year}-12-31`;
  const taken = [], upcoming = [];
  for (const e of entries) {
    const n = e.trip.days.length;
    const start = e.trip.start, end = dayDate(e.trip, n - 1);
    if (start < first || start > last) continue;
    (Date.parse(`${end}T23:59:59Z`) < now ? taken : upcoming).push({ ...e, end });
  }
  const cities = new Map(), nations = new Map();
  let days = 0, nights = 0, km = 0, located = 0, flights = 0, flightsBooked = 0;
  const money = [], checks = { shown: 0, flagged: 0, trips: 0 };
  const trips = taken.sort((a, b) => a.trip.start.localeCompare(b.trip.start)).map((e) => {
    const r = recap(e.trip, [], null, { now });
    const n = e.trip.days.length;
    let inYear = 0;
    for (let i = 0; i < n; i++) { const d = dayDate(e.trip, i); if (d >= first && d <= last) inYear++; }
    days += inYear;
    nights += r.stats.nights;
    km += r.stats.km;
    located += r.stats.located_stops;
    const p = placesIn(e.trip.destination);
    for (const c of p.cities) { const k = c.toLowerCase(); if (!cities.has(k)) cities.set(k, { name: c, trips: 0 }); cities.get(k).trips++; }
    for (const c of p.countries) { if (!nations.has(c.code)) nations.set(c.code, { ...c, trips: 0 }); nations.get(c.code).trips++; }
    const fl = e.trip.days.flatMap((d) => d.stops).filter(isFlight);
    flights += fl.length;
    flightsBooked += fl.filter((s) => s.booked).length;
    if (e.money && e.money.currency) {
      const you = e.money.you || (e.money.people && e.money.people[0] && e.money.people[0].id);
      const share = (e.money.shares || []).find((s) => s.id === you);
      money.push({ trip: e.id, title: e.trip.title, currency: e.money.currency, total: e.money.total, yours: share ? share.amount : null, rates: e.money.rates || null, rates_missing: e.money.rates_missing || null });
    }
    if (e.snap) {
      const vals = Object.values(e.snap);
      checks.shown += vals.length;
      checks.flagged += vals.filter((v) => snapValue(v).status !== 'ok').length;
      checks.trips += 1;
    }
    return { id: e.id, title: e.trip.title, destination: e.trip.destination || '', start: e.trip.start, end: e.end, days: n, days_in_year: inYear, nights: r.stats.nights, nights_from: r.stats.nights_from, km: r.stats.km, flights: fl.length, shared: Boolean(e.shared) };
  });

  // money: per currency, and one total only when every currency could be converted at one ECB date
  const per = new Map();
  for (const m of money) {
    const x = per.get(m.currency) || { currency: m.currency, total: 0, yours: 0, yours_known: true, trips: 0 };
    x.total = round2(x.total + m.total);
    if (m.yours == null) x.yours_known = false; else x.yours = round2(x.yours + m.yours);
    x.trips += 1;
    per.set(m.currency, x);
  }
  const currencies = [...per.values()].sort((a, b) => b.total - a.total);
  let converted = null;
  if (currencies.length > 1 && extra.fx && extra.fx.base) {
    const base = extra.fx.base, rates = extra.fx.rates || {};
    // Frankfurter's rates from `base`: units of X for one `base`
    if (currencies.every((c) => c.currency === base || Number(rates[c.currency]) > 0)) {
      const conv = (a, c) => (c === base ? a : a / Number(rates[c]));
      converted = {
        currency: base,
        total: round2(currencies.reduce((t, c) => t + conv(c.total, c.currency), 0)),
        yours: currencies.every((c) => c.yours_known) ? round2(currencies.reduce((t, c) => t + conv(c.yours, c.currency), 0)) : null,
        date: extra.fx.date, source: extra.fx.source || RATES_SOURCE,
        note: `Other currencies turned into ${base} at the European Central Bank’s reference rate of ${extra.fx.date}, not the rate on the day you paid.`,
      };
    }
  }

  const dropsBy = new Map();
  for (const d of extra.drops || []) {
    const x = dropsBy.get(d.currency) || { currency: d.currency, amount: 0, found: 0 };
    x.amount = round2(x.amount + Number(d.by || 0));
    x.found += 1;
    dropsBy.set(d.currency, x);
  }
  const savedBy = new Map();
  for (const s of extra.saved || []) {
    const x = savedBy.get(s.currency) || { currency: s.currency, amount: 0, count: 0 };
    x.amount = round2(x.amount + Number(s.amount || 0));
    x.count += 1;
    savedBy.set(s.currency, x);
  }

  return {
    year,
    as_of: new Date(now).toISOString(),
    trips,
    upcoming: upcoming.map((e) => ({ id: e.id, title: e.trip.title, start: e.trip.start, shared: Boolean(e.shared) })),
    stats: {
      trips: trips.length,
      shared_trips: trips.filter((t) => t.shared).length,
      days_away: days,
      days_note: 'The days of your trips that fall in this year.',
      nights,
      km: round1(km),
      km_method: 'straight_line',
      km_note: 'Straight lines between stops in the order planned, within each trip. Not road or air miles, and not the way from home and back.',
      located_stops: located,
      cities: [...cities.values()],
      cities_from: 'Your trips’ destinations, as you named them.',
      countries: [...nations.values()],
      countries_from: 'Only countries named in your trips’ destinations; Eden doesn’t look up the country of a city.',
      flights,
      flights_booked: flightsBooked,
      flights_note: 'Flight stops in your plans; booked ones you marked or made in Eden Travel.',
    },
    money: { currencies, trips: money, converted, note: 'Each trip’s total is everything the group logged and booked, in the trip’s currency (money.js); your share is beside it.' },
    savings: {
      saved: [...savedBy.values()],
      drops_found: [...dropsBy.values()],
      note: 'Cheaper prices Eden found for your bookings that are still on record. A drop is only saved if you rebooked.',
    },
    checks: {
      shown: checks.shown, flagged: checks.flagged, trips: checks.trips, reported_wrong: extra.reports || 0,
      note: 'Eden’s checks against live sources (Google Maps, venues’ own sites) on this year’s trips, as last looked at. Flagged: a look or a warning.',
    },
    points: extra.rewards || null,
    card_estimate: extra.cardEstimate || null,
    private: true,
  };
}

/* ---------- in the account's object ---------- */

/**
 * trip-year { year? } (signed in). deps: { tripOp, cache, fetch, ask (to the organisers of shared trips),
 * rewards?: async (account, year) → { points: [{ unit, amount }], source } (rewards.js, when it exists) }.
 */
export async function yearOp(account, op, body, { tripOp, cache, fetch, ask = askDefault, rewards = null } = {}) {
  if (op !== 'trip-year') throw new ApiError(404, 'not_found', 'Not found');
  const now = account.now();
  const thisYear = new Date(now).getUTCFullYear();
  const year = body.year == null ? thisYear : Number(body.year);
  if (!Number.isInteger(year) || year < YEAR.min || year > thisYear) throw new ApiError(400, 'bad_request', `year: ${YEAR.min} to ${thisYear}.`);
  const storage = account.storage;
  const inYear = (t) => t && typeof t.start === 'string' && t.start.startsWith(`${year}-`);

  const entries = [];
  for (const [k, trip] of await storage.list({ prefix: 'trip:' })) {
    if (!inYear(trip)) continue;
    const id = k.slice(5);
    const money = tripOp ? await tripOp(account, 'trip-money', { id }).catch(() => null) : null;
    const snap = ((await storage.get(`tacsnap:${id}`)) || {}).snap || null;
    entries.push({ id, trip, shared: false, money, snap });
  }
  // trips shared with this person: read through each organiser (only while they're on it and the organiser has Plus)
  let unavailable = 0;
  const me = ((await storage.get('account')) || {}).id;
  const joined = [...(await storage.list({ prefix: 'tjoin:' })).values()].slice(0, YEAR.joined);
  for (const j of joined) {
    try {
      const got = await ask(account.env, j.owner, 'tmember-read', { trip: j.trip, member: me });
      if (inYear(got.trip)) entries.push({ id: j.trip, trip: got.trip, shared: true, money: got.money ? { ...got.money, you: me } : null });
    } catch { unavailable += 1; }
  }

  const ids = new Set(entries.filter((e) => !e.shared).map((e) => e.id));
  const drops = [];
  for (const b of (await storage.list({ prefix: 'stbk:' })).values()) {
    if (ids.has(b.trip) && b.drop && b.currency) drops.push({ currency: b.currency, by: Number(b.drop.by), what: (b.accommodation && b.accommodation.name) || 'A hotel', source: 'Duffel Stays', kind: 'stay' });
  }
  for (const w of (await storage.list({ prefix: 'fpw:' })).values()) {
    if (ids.has(w.trip) && w.drop && w.base) drops.push({ currency: w.base.currency, by: Number(w.drop.by), what: `${w.route.origin} → ${w.route.destination}`, source: 'Duffel', kind: 'flight' });
  }
  const saved = [...(await storage.list({ prefix: 'tsaved:' })).values()].filter((s) => s && new Date(s.at).getUTCFullYear() === year && Number(s.amount) > 0 && /^[A-Z]{3}$/.test(String(s.currency)));
  const reports = [...(await storage.list({ prefix: 'tacr:' })).values()].filter((r) => r && new Date(r.at).getUTCFullYear() === year).length;

  // one conversion for the money (the currency with the most spent), only when there's more than one currency
  const cur = new Map();
  for (const e of entries) if (e.money && e.money.currency) cur.set(e.money.currency, (cur.get(e.money.currency) || 0) + Number(e.money.total || 0));
  let fx = null;
  if (cur.size > 1) {
    const base = [...cur].sort((a, b) => b[1] - a[1])[0][0];
    const r = await ecbRates(base, { cache, fetch, now });
    if (r) fx = { base, date: r.date, rates: r.rates, source: r.source };
  }

  // the card estimate on the booked stops of your own trips (your cards never reach a shared trip)
  const names = (await storage.get('tcards')) || [];
  let cardEstimate = null;
  if (names.length) {
    const rew = entries.filter((e) => !e.shared && Date.parse(`${dayDate(e.trip, e.trip.days.length - 1)}T23:59:59Z`) < now)
      .flatMap((e) => tripRewards(perkTrip(e.trip), names, now).filter((r) => r.booked));
    if (rew.length) {
      const usd = rew.some((r) => r.cost.currency !== 'USD') ? await usdRates({ cache, fetch, now }) : null;
      const p = cardPerk(rew, usd, { now });
      cardEstimate = { totals: p.totals, value: p.value, stops: p.items.length, fx: p.fx, note: 'If each booked stop was paid with the best of your saved cards. An estimate from the issuers’ published rates, not what your card account shows.' };
    }
  }
  const pts = rewards ? await rewards(account, year).catch(() => null) : null;

  const out = yearOf(year, entries, { drops, saved, fx, reports, rewards: pts, cardEstimate }, { now });
  out.unavailable_shared = unavailable;
  return out;
}

