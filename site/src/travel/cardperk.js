// "Best card for each booking", a named Plus perk (cards.js has the rates): for one trip, which of the person's cards to
// pay each priced stop with, what it is estimated to earn, and the total. Every estimate carries the rate's source (the
// issuer's own page) and the date it was read; nothing is filled in where the issuer states nothing.
//
// The cards in cards.js are US cards: they earn per US dollar charged. A stop priced in another currency is turned into
// dollars at the European Central Bank's reference rate of the day (Frankfurter, as money.js), and says so: the card
// itself converts at its own network's rate on the day it posts, so that figure is an estimate. With no rates, a
// non-dollar stop shows the card and its rate without a points figure.
//
//   trip-card-perk { id, stop?, cost? } → { cards, items, totals, value, none, fx, as_of, note }
//     stop: just that one, for the pay step; cost { amount, currency }: the price about to be paid (the quote), for that stop
// Organiser only: a member never sees the organiser's cards (members.js).

import { ApiError } from '../accounts/util.js';
import { CARDS, tripRewards } from './cards.js';
import { RATES_SOURCE } from './money.js';
import { TripError, money } from './trips.js';
import { FLIGHT_NO } from './watch.js';

export const CARDPERK = { ratesMs: 6 * 3600_000 };
const RATES = 'https://api.frankfurter.dev/v1/latest';
const TRIP_ID = /^[0-9a-f]{16}$/;
const round2 = (x) => Math.round(x * 100) / 100;

/** Today's ECB rates from `base` (cached under money.js's key `fx1:<base>`, so both read one copy), or null. */
export async function ecbRates(base, { cache, fetch: fetcher = globalThis.fetch, now = Date.now() } = {}) {
  const key = `fx1:${base}`;
  const hit = cache && (await cache.get(key));
  if (hit) return hit;
  try {
    const res = await fetcher(`${RATES}?base=${base}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j || typeof j.rates !== 'object') return null;
    const out = { base, date: String(j.date || '').slice(0, 10), rates: { ...j.rates, [base]: 1 }, source: RATES_SOURCE, checked_at: new Date(now).toISOString() };
    if (cache) await cache.put(key, out, CARDPERK.ratesMs);
    return out;
  } catch { return null; }
}
export const usdRates = (deps) => ecbRates('USD', deps);

// which portal offers can apply to a category: one that names kinds must name this one ("hotels and rental cars"); one
// that names none ("purchases through Chase Travel") applies to any travel booking, never to dining or other
const KIND_WORDS = { hotel: /hotel|vacation rental/i, flight: /flight/i, travel: /car|rental car/i };
const NAMES_KIND = /hotel|flight|car|vacation rental/i;

/** The best portal offer above the card's own rate for this category, or null (booking there means booking on the issuer's site). */
export function portalBetter(cardId, category, rate) {
  const c = CARDS.find((x) => x.id === cardId);
  if (!c || !KIND_WORDS[category]) return null;
  const fits = (c.portal || []).filter((p) => (NAMES_KIND.test(p.what) ? KIND_WORDS[category].test(p.what) : true));
  const best = fits.reduce((a, p) => (p.rate > (a ? a.rate : rate ?? 0) ? p : a), null);
  return best ? { site: best.site, rate: best.rate, what: best.what } : null;
}

/**
 * The perk for a trip: `rewards` as cards.js tripRewards gives it, `fx` from usdRates (or null).
 * items: [{ stop, day, name, category, guessed, cost, booked, card, rate, unit, usd, converted, points, back, back_how,
 *           portal, source, checked, stale, why }]
 * totals: [{ unit, points, stops }] and value: [{ currency: 'USD', amount, how }] where the issuer states a point value.
 */
export function cardPerk(rewards, fx = null, { now = Date.now() } = {}) {
  const items = [], none = [];
  for (const r of rewards) {
    const best = (r.cards || []).find((c) => c.known && c.rate != null);
    if (!best) { none.push({ stop: r.stop, name: r.name }); continue; }
    const cur = r.cost.currency;
    const perUsd = cur === 'USD' ? 1 : fx && fx.rates && Number(fx.rates[cur]) > 0 ? Number(fx.rates[cur]) : null;
    const usd = perUsd ? round2(r.cost.amount / perUsd) : null;
    items.push({
      stop: r.stop, day: r.day, name: r.name, category: r.category, guessed: r.guessed, cost: r.cost, booked: r.booked,
      card: best.name, card_id: best.card, rate: best.rate, unit: best.unit,
      usd,
      converted: cur !== 'USD' && usd != null ? { from: cur, rate: perUsd, date: fx.date, source: fx.source } : null,
      points: usd != null ? Math.round(usd * best.rate) : null,
      back: usd != null && best.back_pct != null ? round2((usd * best.back_pct) / 100) : null,
      back_how: best.back_pct != null ? best.value_how : null,
      back_implied: best.value_implied || false,
      portal: portalBetter(best.card, r.category, best.rate),
      source: best.source, checked: best.checked, stale: best.stale,
      why: usd == null ? `Priced in ${cur}: the day’s exchange rates didn’t load, so the points aren’t estimated.` : null,
    });
  }
  const units = new Map(), value = { amount: 0, n: 0, how: new Set() };
  for (const i of items) {
    if (i.points == null) continue;
    const u = units.get(i.unit) || { unit: i.unit, points: 0, stops: 0 };
    u.points += i.points; u.stops += 1;
    units.set(i.unit, u);
    if (i.back != null) { value.amount += i.back; value.n += 1; value.how.add(i.back_how); }
  }
  return {
    items,
    totals: [...units.values()].sort((a, b) => b.points - a.points),
    value: value.n ? { currency: 'USD', amount: round2(value.amount), stops: value.n, how: [...value.how].filter(Boolean) } : null,
    none,
    fx: fx && items.some((i) => i.converted) ? { date: fx.date, source: fx.source, checked_at: fx.checked_at } : null,
    as_of: new Date(now).toISOString(),
    note: 'Estimated from each issuer’s published earn rate per US dollar. Charges in other currencies are converted by your card on the day they post, so the real figure can differ. A comparison, not financial advice.',
  };
}

/**
 * The trip as the perk prices it: a transport stop named by its flight number ("TP1351 LHR → LIS") is a flight. cards.js
 * categoryOf looks only for flight words, so it would count it as other travel (1x on a Sapphire Reserve, not 4x).
 */
export function perkTrip(trip) {
  return { ...trip, days: trip.days.map((d) => ({ ...d, stops: d.stops.map((s) => (s.kind === 'transport' && FLIGHT_NO.test(`${s.place.name} ${s.note || ''}`) && !/\bflights?\b/i.test(`${s.place.name} ${s.note || ''}`) ? { ...s, note: `${s.note || ''} flight`.trim() } : s)) })) };
}

/** trip-card-perk (the organiser's object, signed in): `deps.cache`, `deps.fetch` as ops.js passes to money.js. */
export async function cardPerkOp(account, op, body, { cache, fetch } = {}) {
  if (op !== 'trip-card-perk') throw new ApiError(404, 'not_found', 'Not found');
  const id = String(body.id || '');
  if (!TRIP_ID.test(id)) throw new TripError('id must be a trip id.');
  const trip = await account.storage.get(`trip:${id}`);
  if (!trip) throw new TripError('There is no such trip.', 404, 'not_found');
  const now = account.now();
  const names = (await account.storage.get('tcards')) || [];
  // the pay step can price the stop at the quote it is about to pay (cost), not the plan's estimate
  const sid = body.stop != null ? String(body.stop) : null;
  let priced = trip;
  if (sid && body.cost != null) {
    const cost = money(body.cost, 'cost');
    priced = { ...trip, days: trip.days.map((d) => ({ ...d, stops: d.stops.map((s) => (s.id === sid ? { ...s, cost } : s)) })) };
  }
  let rewards = tripRewards(perkTrip(priced), names, now);
  if (sid) rewards = rewards.filter((r) => r.stop === sid);
  const fx = rewards.some((r) => r.cost.currency !== 'USD') ? await usdRates({ cache, fetch, now }) : null;
  return { cards: names.length, ...cardPerk(rewards, fx, { now }) };
}
