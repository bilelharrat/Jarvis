// Eden Travel's card-rewards comparison: the person names their cards (names only: anything that
// looks like a card number is refused), and each priced stop shows what each card earns on it.
//
// Every rate below was read from the issuer's own card page on the date in `checked`, and only
// what the page states is here: a figure the page doesn't give is null and shown as "not stated",
// never filled in from memory. A point's value is given only where the issuer states one
// (`value.how` says on what terms). Rates change: a check older than STALE_DAYS is flagged.
//
// Categories: hotel, flight (booked with the hotel or airline directly), travel (other travel:
// trains, ferries, car hire, taxis), dining, other. `portal` is the issuer's own travel site,
// which earns more but means booking there instead of on the provider's site.

import { TripError } from './trips.js';

export const STALE_DAYS = 90;

export const CARDS = [
  {
    id: 'chase-sapphire-preferred', name: 'Chase Sapphire Preferred', issuer: 'Chase', aliases: ['sapphire preferred', 'csp'],
    unit: 'Chase Ultimate Rewards points',
    rates: { hotel: 2, flight: 2, travel: 2, dining: 3, other: 1 },
    portal: [{ site: 'Chase Travel', rate: 5, what: 'purchases through Chase Travel (the first $100 of Chase Travel hotels a year earn nothing)' }],
    value: null, annual_fee: 95, ftf: 0,
    notes: ['Hotels and flights booked directly fall under “2x on all other travel”.'],
    source: 'https://creditcards.chase.com/rewards-credit-cards/sapphire/preferred', checked: '2026-10-26',
  },
  {
    id: 'chase-sapphire-reserve', name: 'Chase Sapphire Reserve', issuer: 'Chase', aliases: ['sapphire reserve', 'csr'],
    unit: 'Chase Ultimate Rewards points',
    rates: { hotel: 4, flight: 4, travel: 1, dining: 3, other: 1 },
    portal: [{ site: 'Chase Travel', rate: 8, what: 'purchases through Chase Travel' }],
    value: { cents: 1, how: 'when redeemed through Chase Travel' }, annual_fee: 795, ftf: 0,
    notes: ['The page lists no separate rate for other travel (trains, car hire), so it is counted at 1x.'],
    source: 'https://creditcards.chase.com/rewards-credit-cards/sapphire/reserve', checked: '2026-10-26',
  },
  {
    id: 'capital-one-venture-x', name: 'Capital One Venture X', issuer: 'Capital One', aliases: ['venture x'],
    unit: 'Capital One miles',
    rates: { hotel: 2, flight: 2, travel: 2, dining: 2, other: 2 },
    portal: [{ site: 'Capital One Travel', rate: 10, what: 'hotels and rental cars through Capital One Travel' }, { site: 'Capital One Travel', rate: 5, what: 'flights and vacation rentals through Capital One Travel' }],
    value: null, annual_fee: 395, ftf: 0,
    notes: [],
    source: 'https://www.capitalone.com/credit-cards/venture-x/', checked: '2026-10-26',
  },
  {
    id: 'capital-one-venture', name: 'Capital One Venture', issuer: 'Capital One', aliases: ['venture', 'venture rewards', 'capital one venture card'],
    unit: 'Capital One miles',
    rates: { hotel: 2, flight: 2, travel: 2, dining: 2, other: 2 },
    portal: [{ site: 'Capital One Travel', rate: 5, what: 'hotels, vacation rentals and rental cars through Capital One Travel' }],
    value: { cents: 1, how: 'toward travel, as the issuer’s own calculator shows (52,800 miles = $528)', implied: true }, annual_fee: 95, ftf: 0,
    notes: [],
    source: 'https://www.capitalone.com/credit-cards/venture/', checked: '2026-10-26',
  },
  {
    id: 'amex-gold', name: 'American Express Gold Card', issuer: 'American Express', aliases: ['amex gold', 'gold card'],
    unit: 'Membership Rewards points',
    rates: { hotel: 1, flight: 3, travel: 1, dining: 4, other: 1 },
    portal: [{ site: 'Amex Travel', rate: 5, what: 'prepaid hotels through AmexTravel.com' }],
    value: null, annual_fee: null, ftf: null,
    notes: ['Restaurants: 4x on up to $50K a year. Flights: 3x booked directly with the airline or through Amex Travel.', 'The page as read did not show the annual fee or the foreign transaction fee.'],
    source: 'https://www.americanexpress.com/us/credit-cards/card/gold-card/', checked: '2026-10-26',
  },
];

const plain = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[®™]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** The card a name means, or null: the longest alias or name found in it ("my chase sapphire reserve" → CSR). */
export function matchCard(name) {
  const n = ` ${plain(name)} `;
  let best = null, len = 0;
  for (const c of CARDS) for (const a of [c.name, ...c.aliases]) {
    const p = plain(a);
    if (n.includes(` ${p} `) && p.length > len) { best = c; len = p.length; }
  }
  return best;
}

/** The person's card names, cleaned; a card number (or anything with a long run of digits) is refused. */
export function cleanCardNames(names) {
  if (!Array.isArray(names) || names.length > 12) throw new TripError('cards: a list of up to 12 card names.');
  return names.map((raw) => {
    const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name) throw new TripError('A card needs a name.');
    if (/\d[\d -]{6,}\d/.test(name)) throw new TripError('Only the card’s name, never its number. Eden doesn’t keep card numbers.');
    return name;
  });
}

/** Which earning category a stop falls in. */
export function categoryOf(stop) {
  switch (stop.kind) {
    case 'stay': return 'hotel';
    case 'transport': return /\b(fly|flight|airline|airport|plane)\b/i.test(`${stop.place.name} ${stop.note || ''}`) ? 'flight' : 'travel';
    case 'meal': return 'dining';
    default: return 'other';
  }
}

const daysOld = (checked, now) => Math.floor((now - Date.parse(`${checked}T00:00:00Z`)) / 86400_000);

/**
 * What each of the person's cards earns on one priced stop: [{ name, card?, rate, unit, back_pct?, portal, ftf, source, checked, stale, notes }],
 * best first (by stated value back where the issuer gives one, then by rate). A name Eden has no checked rates for
 * comes back with `known: false`.
 */
export function compareCards(stop, names, now = Date.now()) {
  const cat = categoryOf(stop);
  const rows = names.map((name) => {
    const c = matchCard(name);
    if (!c) return { name, known: false };
    const rate = c.rates[cat];
    const back = c.value && rate != null ? Math.round(rate * c.value.cents * 100) / 100 : null; // % back: rate × cents per point
    return {
      name: c.name, known: true, card: c.id, category: cat, rate, unit: c.unit,
      back_pct: back, value_how: c.value ? c.value.how : null, value_implied: Boolean(c.value && c.value.implied),
      portal: c.portal, ftf: c.ftf, annual_fee: c.annual_fee, notes: c.notes,
      source: c.source, checked: c.checked, stale: daysOld(c.checked, now) > STALE_DAYS,
    };
  });
  const score = (r) => (r.known ? [r.back_pct ?? -1, r.rate ?? -1] : [-2, -2]);
  return rows.sort((a, b) => { const x = score(a), y = score(b); return y[0] - x[0] || y[1] - x[1]; });
}

/** The comparison for every priced stop of a trip: [{ stop, day, name, category, cost, cards }]. */
export function tripRewards(trip, names, now = Date.now()) {
  if (!names || !names.length) return [];
  const out = [];
  trip.days.forEach((d, day) => d.stops.forEach((s) => {
    if (s.cost && s.cost.amount > 0) out.push({ stop: s.id, day, name: s.place.name, category: categoryOf(s), cost: s.cost, booked: Boolean(s.booked), cards: compareCards(s, names, now) });
  }));
  return out;
}
