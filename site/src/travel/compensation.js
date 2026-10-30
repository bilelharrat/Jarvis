// Delay compensation (a Plus perk, no partner): after a flight is 3 hours or more late at arrival, cancelled, or the
// person was denied boarding, Eden says whether the passenger rules likely give money back, how much, why, and what
// would make them not apply, then prepares the claim letter. The person sends it themselves: Eden never contacts the
// airline. Eden never says "you are owed": an airline can still prove extraordinary circumstances.
//
// Rules are read from the official texts only (RULES below; each has its URL and the day it was read):
//   EU261  Regulation (EC) No 261/2004 (Art. 3 scope, 4 denied boarding, 5 cancellation, 7 amounts) and the CJEU:
//          Sturgeon (C-402/07, C-432/07) and Nelson (C-581/10) for a delay of 3 hours or more at arrival; Germanwings
//          (C-452/13): arrival is when a door opens; Wallentin-Hermann (C-549/07): a technical problem is usually not
//          extraordinary; Pešková (C-315/15): a bird strike is; Airhelp v SAS (C-28/20): the airline's own staff
//          striking is not. Areas: the 27 EU states with their outermost regions, plus Iceland, Norway and Switzerland
//          (Your Europe, the Commission's own page).
//   UK261  the same Regulation as it has effect in the UK (legislation.gov.uk: Art. 3(1) as substituted from
//          31 Dec 2020, Art. 7 in pounds).
//   APPR   Canada's Air Passenger Protection Regulations, SOR/2019-150 (s. 10–12, 19, 20).
//   US     14 CFR Part 260 (refund of the fare for a cancelled or significantly changed flight): a refund, not
//          compensation.
// Distances are the great circle between the two airports (Art. 7(4)), from FlightAware's airport points (ops.js
// trip-flight-live gives them, cached a month). The operating carrier's licence comes from CARRIERS (small, sourced).
//
// The data is the flight watch's (watch.js): when a watched flight lands or is cancelled, claimAfterLanding saves
// what FlightAware said (fclaim:<ident>:<date>) and pushes once when it looks likely eligible.
//
//   trip-claims       { id, facts?: { [stop]: Facts } }           → { claims: [{ stop, ident, date, title, assessment, form }], checked }
//   trip-claim-letter { id, stop, passengers: [name], booking_ref?, facts?: Facts, law? }
//                     → { subject, letter, to: { airline, form_url, form_source }, law, amount, assessment }
//   Facts: { denied_boarding?: true, notice_days?: number (when the airline told of the cancellation),
//            reroute?: { depart_earlier_min, arrive_later_min } }

import { flightStops } from './watch.js';
import { distanceKm } from './maps.js';
import { TripError } from './trips.js';

export const RULES_CHECKED = '2026-10-28';
export const DELAY_MIN = 180; // "three hours or more" at arrival (Sturgeon)
const CLOSE_MIN = 10; // FlightAware's gate time and the door opening can differ by a few minutes

export const RULES = {
  eu261: { title: 'Regulation (EC) No 261/2004, Articles 3, 4, 5 and 7', url: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32004R0261', also: 'https://www.legislation.gov.uk/eur/2004/261/adopted' },
  sturgeon: { title: 'CJEU, Sturgeon (C-402/07 and C-432/07): a delay of 3 hours or more at arrival is compensated like a cancellation', url: 'https://curia.europa.eu/juris/liste.jsf?num=C-402/07' },
  nelson: { title: 'CJEU, Nelson (C-581/10 and C-629/10): Sturgeon confirmed', url: 'https://curia.europa.eu/juris/liste.jsf?num=C-581/10' },
  germanwings: { title: 'CJEU, Germanwings (C-452/13): arrival is when at least one door opens', url: 'https://curia.europa.eu/juris/liste.jsf?num=C-452/13' },
  wallentin: { title: 'CJEU, Wallentin-Hermann (C-549/07): a technical problem is usually not extraordinary', url: 'https://curia.europa.eu/juris/liste.jsf?num=C-549/07' },
  peskova: { title: 'CJEU, Pešková (C-315/15): a bird strike is extraordinary', url: 'https://curia.europa.eu/juris/liste.jsf?num=C-315/15' },
  airhelp: { title: 'CJEU, Airhelp v SAS (C-28/20): a strike by the airline’s own staff is not extraordinary', url: 'https://curia.europa.eu/juris/liste.jsf?num=C-28/20' },
  youreurope: { title: 'Your Europe (European Commission): air passenger rights, where they apply', url: 'https://europa.eu/youreurope/citizens/travel/passenger-rights/air/index_en.htm' },
  uk261: { title: 'Regulation (EC) No 261/2004 as it has effect in the UK, Articles 2, 3 and 7', url: 'https://www.legislation.gov.uk/eur/2004/261/contents' },
  caa: { title: 'UK Civil Aviation Authority: Type A operating licence holders', url: 'https://www.caa.co.uk/commercial-industry/airlines/licensing/licence-types/airline-licence-holders/' },
  appr: { title: 'Air Passenger Protection Regulations (SOR/2019-150), sections 10–12, 19 and 20', url: 'https://laws-lois.justice.gc.ca/eng/regulations/SOR-2019-150/FullText.html' },
  us260: { title: '14 CFR Part 260: refunds for cancelled or significantly changed flights', url: 'https://www.ecfr.gov/current/title-14/chapter-II/subchapter-A/part-260' },
};
const src = (...keys) => keys.map((k) => ({ key: k, ...RULES[k], checked: RULES_CHECKED }));

// The 27 EU states and their outermost regions where they have their own ISO code (Your Europe lists the French overseas
// departments, the Azores, Madeira and the Canaries; the Faroe Islands are out), then Iceland, Norway and Switzerland.
export const EU = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'GP', 'MQ', 'GF', 'RE', 'YT', 'MF']);
export const EU_AREA = new Set([...EU, 'IS', 'NO', 'LI', 'CH']);
const UK = 'GB'; // Jersey, Guernsey and the Isle of Man have their own codes and are not in the UK

// The operating carrier's licence. UK: each name is on the CAA's Type A list (read 2026-10-28); the two-letter code
// beside it is Eden's (the CAA lists names only). EU/EEA/CH: the airline's home state; not checked line by line
// against the Commission's Official Journal notices (Art. 10(3) of Regulation 1008/2008), so `checked: false`.
// A designator several licensed companies fly under (easyJet's U2) lists each licence it can be.
export const CARRIERS = {
  BA: { name: 'British Airways', licence: ['UK'], checked: true },
  VS: { name: 'Virgin Atlantic', licence: ['UK'], checked: true },
  LS: { name: 'Jet2.com', licence: ['UK'], checked: true },
  LM: { name: 'Loganair', licence: ['UK'], checked: true },
  BY: { name: 'TUI Airways', licence: ['UK'], checked: true },
  RK: { name: 'Ryanair UK', licence: ['UK'], checked: true },
  W9: { name: 'Wizz Air UK', licence: ['UK'], checked: true },
  U2: { name: 'easyJet', licence: ['UK', 'EU', 'CH'], checked: true }, // easyJet UK Limited is on the CAA list; easyJet Europe (Austria) and Switzerland fly U2 too
  LH: { name: 'Lufthansa', licence: ['EU'], country: 'DE', checked: false },
  EW: { name: 'Eurowings', licence: ['EU'], country: 'DE', checked: false },
  AF: { name: 'Air France', licence: ['EU'], country: 'FR', checked: false },
  KL: { name: 'KLM', licence: ['EU'], country: 'NL', checked: false },
  HV: { name: 'Transavia', licence: ['EU'], country: 'NL', checked: false },
  IB: { name: 'Iberia', licence: ['EU'], country: 'ES', checked: false },
  VY: { name: 'Vueling', licence: ['EU'], country: 'ES', checked: false },
  TP: { name: 'TAP Air Portugal', licence: ['EU'], country: 'PT', checked: false },
  FR: { name: 'Ryanair', licence: ['EU'], country: 'IE', checked: false },
  EI: { name: 'Aer Lingus', licence: ['EU'], country: 'IE', checked: false },
  AY: { name: 'Finnair', licence: ['EU'], country: 'FI', checked: false },
  OS: { name: 'Austrian Airlines', licence: ['EU'], country: 'AT', checked: false },
  SN: { name: 'Brussels Airlines', licence: ['EU'], country: 'BE', checked: false },
  AZ: { name: 'ITA Airways', licence: ['EU'], country: 'IT', checked: false },
  A3: { name: 'Aegean Airlines', licence: ['EU'], country: 'GR', checked: false },
  LO: { name: 'LOT Polish Airlines', licence: ['EU'], country: 'PL', checked: false },
  W6: { name: 'Wizz Air', licence: ['EU'], country: 'HU', checked: false },
  SK: { name: 'SAS', licence: ['EU'], country: 'DK', checked: false },
  DY: { name: 'Norwegian', licence: ['EEA'], country: 'NO', checked: false },
  LX: { name: 'Swiss', licence: ['CH'], country: 'CH', checked: false },
};

// The airline's own claim page, where one was found on its own site (search, 2026-10-28; most airline sites refuse
// automated reads, so only easyJet's page was opened). Otherwise the letter says "the airline's website".
export const CLAIM_FORMS = {
  FR: { url: 'https://eu261compensationclaims.ryanair.com/', seen: '2026-10-28', opened: false },
  BA: { url: 'https://www.britishairways.com/content/information/help-and-contacts/complaints-and-claims', seen: '2026-10-28', opened: false },
  LH: { url: 'https://www.lufthansa.com/mk/en/compensation-in-the-event-of-flight-irregularities', seen: '2026-10-28', opened: false },
  TP: { url: 'https://www.flytap.com/en-us/help/delays-cancellations', seen: '2026-10-28', opened: false },
  KL: { url: 'https://www.klm.com/information/refund-compensation/compensation', seen: '2026-10-28', opened: false },
  AF: { url: 'https://wwws.airfrance.fr/en/information/legal/assistance-et-indemnisation', seen: '2026-10-28', opened: false },
  U2: { url: 'https://www.easyjet.com/en/claim/eu261', seen: '2026-10-28', opened: true },
};

// Amounts (Art. 7(1)) and the reroute windows that let the airline halve them (Art. 7(2)): by distance band.
const EU_PAY = { short: 250, mid: 400, long: 600 };
const UK_PAY = { short: 220, mid: 350, long: 520 };
const HALF_WITHIN_H = { short: 2, mid: 3, long: 4 };

/** The distance band (Art. 7(1)): 'short' up to 1500 km, 'mid' over 1500 within the EU or up to 3500, else 'long'. */
export function band(km, { intraEU = false } = {}) {
  if (!Number.isFinite(km) || km <= 0) return null;
  if (km <= 1500) return 'short';
  if (intraEU || km <= 3500) return 'mid';
  return 'long';
}

const cc = (a) => (a && a.country ? String(a.country).toUpperCase() : null);
const minsBetween = (a, b) => (Date.parse(a || '') && Date.parse(b || '') ? Math.round((Date.parse(b) - Date.parse(a)) / 60000) : null);
const hm = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
const sym = { EUR: '€', GBP: '£', CAD: 'CA$' };
export const moneyText = (cur, v) => `${sym[cur] || `${cur} `}${Number(v).toLocaleString('en-GB')}`;

/** Whether the operating carrier's licence is in `want`: 'yes', 'maybe' (some of its licences, or not checked), 'no', or 'unknown'. */
function carrierIn(carrier, want) {
  if (!carrier) return 'unknown';
  const hit = carrier.licence.filter((l) => want.includes(l));
  if (!hit.length) return 'no';
  return hit.length === carrier.licence.length ? 'yes' : 'maybe';
}

/** What happened to the flight, from FlightAware's summary: { what, delay_min, final }. */
export function outcome(flight, facts = {}) {
  if (facts.denied_boarding) return { what: 'denied', delay_min: null, final: true };
  if (!flight) return { what: 'unknown', delay_min: null, final: false };
  if (flight.state === 'cancelled') return { what: 'cancelled', delay_min: null, final: true };
  const arr = flight.arrival || {};
  const landed = flight.state === 'landed' || Boolean(arr.actual);
  const late = arr.actual ? minsBetween(arr.scheduled, arr.actual) : flight.delay_minutes && Number.isFinite(flight.delay_minutes.arrival) ? flight.delay_minutes.arrival : arr.estimated ? minsBetween(arr.scheduled, arr.estimated) : null;
  if (flight.state === 'diverted') return { what: 'diverted', delay_min: late, final: landed };
  if (!landed) return { what: 'not_yet', delay_min: late, final: false };
  return { what: late !== null && late >= DELAY_MIN - CLOSE_MIN ? 'delay' : 'on_time', delay_min: late, final: true };
}

// What would make EU261/UK261 not apply (or lower it), for every claim.
const EU_NOT_IF = [
  'The airline proves extraordinary circumstances it couldn’t have avoided with all reasonable measures (Art. 5(3)): bad weather, an air traffic control decision or strike, a security risk, political instability, a bird strike. It is for the airline to prove, not for you.',
  'Most technical problems and strikes by the airline’s own staff are not extraordinary (CJEU C-549/07, C-28/20).',
  'You travelled free or on a fare not available to the public (Art. 3(3)); frequent-flyer tickets are covered.',
  'You already received compensation and assistance under another country’s law for this flight (Art. 3(1)(b)).',
];

function cancellationCheck(o, facts, b) {
  const why = [];
  const notice = Number.isFinite(facts.notice_days) ? facts.notice_days : null;
  const r = facts.reroute || null;
  if (notice === null) return { ok: 'maybe', why: ['A cancellation is compensated unless the airline told you at least 14 days before departure, or 7 to 13 days before with a close enough new flight (Art. 5(1)(c)). Eden doesn’t know when you were told; the airline has to prove it (Art. 5(4)).'], ask: 'When did the airline tell you about the cancellation?' };
  if (notice >= 14) return { ok: 'no', why: [`You were told ${notice} days before departure: 14 days or more means no compensation (Art. 5(1)(c)(i)).`] };
  const [early, late] = notice >= 7 ? [120, 240] : [60, 120];
  if (r && Number.isFinite(r.depart_earlier_min) && Number.isFinite(r.arrive_later_min)) {
    if (r.depart_earlier_min <= early && r.arrive_later_min < late) return { ok: 'no', why: [`You were told ${notice} days before and offered a flight leaving at most ${hm(early)} earlier and arriving under ${hm(late)} later: that rules compensation out (Art. 5(1)(c)(${notice >= 7 ? 'ii' : 'iii'})).`] };
    why.push(`You were told ${notice} days before; the new flight you were offered was outside the ${hm(early)} earlier / ${hm(late)} later window (Art. 5(1)(c)).`);
  } else {
    why.push(`You were told ${notice} days before departure, so it is compensated unless the airline offered a flight leaving no more than ${hm(early)} earlier and arriving less than ${hm(late)} later (Art. 5(1)(c)).`);
  }
  return { ok: 'yes', why, b };
}

function euLike(law, o, ctx) {
  const { from, to, carrier, op, km, facts } = ctx;
  const fc = cc(from), tc = cc(to);
  const isUK = law === 'UK261';
  let covered, scope;
  if (!isUK) {
    if (fc && EU_AREA.has(fc)) { covered = 'yes'; scope = `It leaves from ${fc}, where the EU rules apply to every airline (Art. 3(1)(a)).`; }
    else if (tc && EU_AREA.has(tc)) {
      const c = carrierIn(carrier, ['EU']);
      const eea = carrier && carrier.licence.some((l) => l === 'EEA' || l === 'CH');
      covered = c === 'yes' ? (carrier.checked ? 'yes' : 'maybe') : c === 'maybe' || eea ? 'maybe' : 'no';
      scope = covered === 'no'
        ? `It arrives in ${tc} from outside the EU on ${carrier ? carrier.name : op || 'an airline'}${carrier ? ', not an EU airline' : ', which Eden doesn’t know as an EU airline'}: the EU rules cover that only on an EU airline (Art. 3(1)(b)).`
        : `It arrives in ${tc} from outside the EU, so the EU rules apply only if the operating airline holds an EU licence (Art. 3(1)(b)); ${carrier.name} ${covered === 'yes' ? 'does' : 'likely does, but Eden hasn’t checked its licence against the official list'}.`;
    } else { covered = 'no'; scope = 'It neither leaves from nor arrives in the EU, Iceland, Norway or Switzerland.'; }
  } else if (fc === UK) { covered = 'yes'; scope = 'It leaves from the UK, where the UK rules apply to every airline (Art. 3(1)(a)).'; }
  else if (tc === UK) {
    const c = carrierIn(carrier, ['UK', 'EU']);
    covered = c === 'yes' ? (carrier.checked ? 'yes' : 'maybe') : c === 'maybe' ? 'maybe' : 'no';
    scope = covered === 'no' ? `It arrives in the UK on ${carrier ? carrier.name : op || 'an airline'}, ${carrier ? 'not a UK or EU airline' : 'which Eden doesn’t know as a UK or EU airline'}: the UK rules cover arrivals only on a UK or EU airline (Art. 3(1)(b)(i)).` : `It arrives in the UK on ${carrier.name}; arrivals are covered on a UK or EU airline (Art. 3(1)(b)(i)).`;
  } else if (tc && EU.has(tc)) {
    const c = carrierIn(carrier, ['UK']);
    covered = c === 'no' || c === 'unknown' ? 'no' : c;
    scope = covered === 'no' ? 'It doesn’t leave from the UK, and it isn’t a UK airline arriving in the EU (Art. 3(1)(b)(ii)).' : `It arrives in the EU on ${carrier.name}, a UK airline, which the UK rules cover (Art. 3(1)(b)(ii)).`;
  } else { covered = 'no'; scope = 'It neither leaves from nor arrives in the UK.'; }

  const intraEU = !isUK && fc && tc && EU.has(fc) && EU.has(tc);
  const b = band(km, { intraEU });
  const pay = isUK ? UK_PAY : EU_PAY;
  const cur = isUK ? 'GBP' : 'EUR';
  const amount = b ? { currency: cur, value: pay[b], half: pay[b] / 2, half_if: `the airline rerouted you and you arrived no more than ${HALF_WITHIN_H[b]} hours after the planned time (Art. 7(2))`, band: b } : { currency: cur, value: null, range: [pay.short, pay.long], why: 'Eden couldn’t get both airports’ positions to measure the distance.' };
  const out = { law, name: isUK ? 'UK261 (UK air passenger rights)' : 'EU261 (EU air passenger rights)', kind: 'compensation', covered, scope, amount, why: [], not_if: EU_NOT_IF, ask: null, sources: isUK ? src('uk261', 'caa', 'sturgeon', 'germanwings') : src('eu261', 'youreurope', 'sturgeon', 'nelson', 'germanwings', 'wallentin', 'peskova', 'airhelp') };
  if (covered === 'no') return { ...out, verdict: 'not_covered' };

  let met = 'no';
  if (o.what === 'delay') {
    met = o.delay_min >= DELAY_MIN ? 'yes' : 'maybe';
    out.why.push(o.delay_min >= DELAY_MIN
      ? `FlightAware has it arriving ${hm(o.delay_min)} late at the gate: 3 hours or more at arrival is compensated like a cancellation (CJEU Sturgeon, Nelson).`
      : `FlightAware has it arriving ${hm(o.delay_min)} late at the gate, just under 3 hours. The time that counts is when a door opened (CJEU C-452/13), which can be a few minutes later.`);
    if (o.delay_min < DELAY_MIN) out.ask = 'When did the doors open? Your boarding pass app or a photo time can show it.';
  } else if (o.what === 'cancelled') {
    const c = cancellationCheck(o, facts, b);
    met = c.ok; out.why.push(...c.why); out.ask = c.ask || null;
  } else if (o.what === 'denied') {
    met = 'yes';
    out.why.push('Denied boarding against your will is compensated straight away (Art. 4(3)), unless there were reasonable grounds such as health, safety, security or travel documents. If you gave up your seat as a volunteer, you agreed your own terms instead (Art. 4(1)).');
  } else if (o.what === 'diverted') {
    met = 'maybe';
    out.why.push(`FlightAware shows it diverted${o.delay_min !== null ? `, arriving ${hm(o.delay_min)} late` : ''}. What counts is how late you reached the destination on your ticket.`);
  }
  out.why.push('If this flight was one leg of a longer booking, the delay and the distance count to your final destination (Art. 7(1)).');
  out.why.push(scope);
  const verdict = met === 'no' ? 'unlikely' : met === 'yes' && covered === 'yes' ? 'likely' : 'check';
  return { ...out, verdict };
}

function appr(o, ctx) {
  const { from, to } = ctx;
  const covered = cc(from) === 'CA' || cc(to) === 'CA' ? 'yes' : 'no';
  const out = { law: 'APPR', name: 'Canada’s Air Passenger Protection Regulations', kind: 'compensation', covered, scope: covered === 'yes' ? 'It flies to or from Canada.' : 'It doesn’t fly to or from Canada.', why: [], ask: null, sources: src('appr'),
    not_if: [
      'The cause was outside the airline’s control (s. 10): weather that makes flying unsafe, air traffic control instructions, airport operation issues, a security threat, a medical emergency, a wildlife strike, a labour disruption, among others.',
      'The cause was within the airline’s control but needed for safety (s. 11).',
      'You were told 14 days or more before departure (s. 12(2)(d), 12(3)(d)).',
      'Canada proposed changes to these rules in December 2024; they weren’t in the text Eden read on 2026-10-28.',
    ] };
  if (covered === 'no') return { ...out, verdict: 'not_covered', amount: null };
  const size = 'large airlines (2 million passengers or more in each of the two years before) pay more than small ones (s. 1)';
  const tier = (m) => (m >= 540 ? 2 : m >= 360 ? 1 : 0);
  if (o.what === 'denied') {
    const t = o.delay_min === null ? null : tier(o.delay_min);
    out.amount = { currency: 'CAD', value: t === null ? null : [900, 1800, 2400][t], range: [900, 2400], why: 'CA$900 under 6 hours late, CA$1,800 for 6 to 9 hours, CA$2,400 for 9 or more (s. 20(1)).' };
    out.why.push('Denied boarding within the airline’s control is compensated (s. 12(4), 20).');
    return { ...out, verdict: 'likely' };
  }
  if (o.what === 'delay' && o.delay_min >= DELAY_MIN || o.what === 'cancelled') {
    const t = o.what === 'delay' ? tier(o.delay_min) : null;
    out.amount = { currency: 'CAD', value: null, range: t === null ? [125, 1000] : [[125, 400], [250, 700], [500, 1000]][t], why: `${t === null ? 'It depends on how late you reached your destination: ' : ''}${size}: CA$400/700/1,000 (large) or CA$125/250/500 (small) for 3, 6 or 9+ hours late (s. 19(1)); CA$400 or CA$125 if you took a refund instead (s. 19(2)).` };
    out.why.push(o.what === 'delay' ? `FlightAware has it arriving ${hm(o.delay_min)} late; 3 hours or more is compensated when it was within the airline’s control and not needed for safety (s. 12, 19).` : 'A cancellation within the airline’s control, not needed for safety, is compensated when you were told 14 days or less before (s. 12(3)(d)).');
    out.why.push('Ask the airline within a year; it must pay or explain why not within 30 days (s. 19(3), (4)).');
    return { ...out, verdict: 'check' }; // the cause decides it, and only the airline knows the cause at first
  }
  return { ...out, verdict: 'unlikely', amount: null };
}

function usRefund(o, ctx) {
  const { from, to } = ctx;
  const fc = cc(from), tc = cc(to);
  const covered = fc === 'US' || tc === 'US' ? 'yes' : 'no';
  const out = { law: 'US-DOT', name: 'US refund rules (14 CFR Part 260)', kind: 'refund', amount: null, covered, scope: covered === 'yes' ? 'It flies to, from or within the United States.' : 'It doesn’t fly to or from the United States.', why: [], ask: null, sources: src('us260'),
    not_if: ['You flew on it anyway, or took the rebooking, a voucher or a credit (§ 260.6(a)(1)).', 'This is a refund of the fare and fees you paid, not extra compensation.'] };
  if (covered === 'no') return { ...out, verdict: 'not_covered' };
  const domestic = fc === 'US' && tc === 'US';
  const sig = domestic ? 180 : 360;
  if (o.what === 'cancelled' || (o.what === 'delay' && o.delay_min >= sig)) {
    out.why.push(o.what === 'cancelled' ? 'A cancelled flight: if you chose not to travel or rebook, the airline must refund the fare, taxes and fees (§ 260.6).' : `It arrived ${hm(o.delay_min)} late, ${domestic ? '3' : '6'} hours or more for a${domestic ? ' domestic' : 'n international'} flight: a “significantly delayed” flight. If you chose not to fly it, the fare is refunded (§ 260.2, 260.6).`);
    return { ...out, verdict: 'check' };
  }
  return { ...out, verdict: 'unlikely' };
}

const RANK = { likely: 0, check: 1, unlikely: 2, not_covered: 3 };

/**
 * Pure: whether the passenger rules likely give money back for one flight.
 * `snap` is { flight, from, to } (FlightAware's summary and its two airports { code, lat, lng, country }), or the
 * summary alone. `stop` is the trip stop (for its name); `facts` what the person told Eden (see the header).
 */
export function assessFlight(snap, stop = null, facts = {}) {
  const flight = snap && snap.flight ? snap.flight : snap;
  const from = (snap && snap.from) || null;
  const to = (snap && snap.to) || null;
  const op = flight && flight.operator ? String(flight.operator).toUpperCase() : (flight && flight.ident ? String(flight.ident).slice(0, 2).toUpperCase() : null);
  const carrier = op && CARRIERS[op] ? { code: op, ...CARRIERS[op] } : null;
  const km = from && to && [from.lat, from.lng, to.lat, to.lng].every(Number.isFinite) ? Math.round(distanceKm(from, to)) : null;
  const o = outcome(flight, facts || {});
  const base = {
    ident: flight ? flight.ident : null, stop: stop ? stop.id : null, operator: carrier ? { code: op, name: carrier.name } : op ? { code: op, name: null } : null,
    route: { from: from ? from.code : flight && flight.origin && flight.origin.code, to: to ? to.code : flight && flight.destination && flight.destination.code, from_country: cc(from), to_country: cc(to) },
    distance_km: km, distance_how: km ? 'Great circle between the two airports (Art. 7(4)), from FlightAware’s airport positions.' : null,
    what: o.what, arrival_delay_min: o.delay_min,
    data: flight ? { source: flight.source || 'FlightAware AeroAPI', checked_at: flight.checked_at || null, scheduled_arrival: flight.arrival && flight.arrival.scheduled, actual_arrival: flight.arrival && flight.arrival.actual } : null,
    rules_checked: RULES_CHECKED,
  };
  if (o.what === 'not_yet' || o.what === 'unknown') return { ...base, verdict: 'too_early', headline: 'Eden will look once it has landed.', laws: [] };
  if (o.what === 'on_time') return { ...base, verdict: o.delay_min === null ? 'too_early' : 'unlikely', headline: o.delay_min === null ? 'FlightAware has no arrival time for it yet.' : `It arrived ${o.delay_min > 0 ? `${hm(o.delay_min)} late` : 'on time'}: the rules start at 3 hours late at arrival.`, laws: [] };
  const ctx = { from, to, carrier, op, km, facts: facts || {} };
  const laws = [euLike('EU261', o, ctx), euLike('UK261', o, ctx), appr(o, ctx), usRefund(o, ctx)].filter((l) => l.covered !== 'no').sort((a, b) => RANK[a.verdict] - RANK[b.verdict]);
  const best = laws[0] || null;
  const verdict = best ? best.verdict : 'not_covered';
  const amt = best && best.amount ? (best.amount.value ? moneyText(best.amount.currency, best.amount.value) : best.amount.range ? `${moneyText(best.amount.currency, best.amount.range[0])} to ${moneyText(best.amount.currency, best.amount.range[1])}` : null) : null;
  const headline = !best ? 'No passenger rules Eden knows cover this route and airline.'
    : verdict === 'likely' ? `Likely eligible for ${amt} under ${best.law}.`
    : verdict === 'check' ? (best.kind === 'refund' ? `You may be due a refund of the fare under ${best.name}.` : `Possibly eligible${amt ? ` for ${amt}` : ''} under ${best.law}: ${best.ask ? 'one question first.' : 'it depends on the cause.'}`)
    : `Unlikely under ${best.law}.`;
  const notes = [];
  if (laws.filter((l) => l.law === 'EU261' || l.law === 'UK261').length === 2) notes.push('Both the EU and UK rules cover this flight: claim under one only.');
  return { ...base, verdict, headline, laws, notes };
}

/* ---------- the letter ---------- */

/** The claim letter, as plain text, for the person to send themselves. */
export function claimLetter(a, { passengers = [], booking_ref = null, law = null, date = null } = {}) {
  const l = (law && a.laws.find((x) => x.law === law)) || a.laws.find((x) => x.kind === 'compensation' && x.verdict !== 'unlikely') || a.laws[0];
  if (!l) throw new TripError('No passenger rules Eden knows cover this flight, so there is no letter to write.', 409, 'not_covered');
  const names = passengers.map((p) => String((p && p.name) || p || '').replace(/\s+/g, ' ').trim().slice(0, 80)).filter(Boolean).slice(0, 9);
  if (!names.length) throw new TripError('Whose names go on the claim? Add at least one passenger.');
  const airline = (a.operator && a.operator.name) || (a.operator && a.operator.code) || 'the airline';
  const route = `${a.route.from || '?'} to ${a.route.to || '?'}`;
  const when = date || (a.data && a.data.scheduled_arrival ? a.data.scheduled_arrival.slice(0, 10) : '');
  const fmt = (iso) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : 'unknown');
  const what = a.what === 'cancelled' ? 'was cancelled' : a.what === 'denied' ? 'was one we were denied boarding on' : `arrived ${hm(a.arrival_delay_min || 0)} after its scheduled time`;
  const amount = l.amount && l.amount.value ? `${moneyText(l.amount.currency, l.amount.value)} per passenger` : null;
  const article = l.law === 'EU261' ? 'Regulation (EC) No 261/2004' : l.law === 'UK261' ? 'Regulation (EC) No 261/2004 as it has effect in the United Kingdom (UK261)' : l.law === 'APPR' ? 'the Air Passenger Protection Regulations (SOR/2019-150)' : '14 CFR Part 260';
  const lines = [
    `To ${airline} customer relations`,
    '',
    `Re: ${l.kind === 'refund' ? 'refund' : 'compensation'} claim, flight ${a.ident} on ${when}${booking_ref ? `, booking ${String(booking_ref).slice(0, 20)}` : ''}`,
    '',
    `I am writing about flight ${a.ident} from ${route} on ${when}, operated by ${airline}, which ${what}.`,
    a.what === 'delay' ? `Scheduled arrival: ${fmt(a.data && a.data.scheduled_arrival)}. Actual arrival at the gate: ${fmt(a.data && a.data.actual_arrival)} (FlightAware).` : null,
    '',
    l.kind === 'refund'
      ? `Under ${article}, I ask for a full refund of the fare, taxes and fees, as I did not take the flight or accept a rebooking or voucher.`
      : `Under ${article}${l.law === 'EU261' || l.law === 'UK261' ? ' (Articles 5 and 7, and the Court of Justice’s rulings in Sturgeon C-402/07 and Nelson C-581/10 for delays of three hours or more at arrival)' : ''}, I believe ${names.length > 1 ? 'we are' : 'I am'} entitled to compensation${amount ? ` of ${amount}` : ''}${a.distance_km && (l.law === 'EU261' || l.law === 'UK261') ? `, the flight distance being about ${a.distance_km.toLocaleString('en-GB')} km` : ''}.`,
    l.kind === 'refund' ? null : 'If you consider that extraordinary circumstances apply, please tell me in writing what they were and how they caused this disruption, with the evidence, and what reasonable measures were taken to avoid it.',
    '',
    `Passengers: ${names.join(', ')}.`,
    'Please pay by bank transfer; I will send the account details on request. I do not accept vouchers in place of money.',
    '',
    'Yours faithfully,',
    names[0],
  ].filter((x) => x !== null);
  const form = a.operator && CLAIM_FORMS[a.operator.code];
  return {
    subject: `${l.kind === 'refund' ? 'Refund' : 'Compensation'} claim: ${a.ident} on ${when}`,
    letter: lines.join('\n'),
    to: { airline, form_url: form ? form.url : null, form_source: form ? `Found on ${airline}’s own site, ${form.seen}` : 'Use the airline’s website: Eden doesn’t have its claim page.' },
    law: l.law, amount: l.amount || null,
    sends: 'You send this yourself. Eden doesn’t contact the airline.',
  };
}

/* ---------- saved results, the push, and the ops ---------- */

const claimKey = (ident, date) => `fclaim:${ident}:${date}`;

/**
 * watch.js, once a watched flight has landed, been cancelled or come down after a diversion: what FlightAware said is
 * saved and, when it looks likely eligible, pushed once. `before` is the watch's previous snapshot (a flight seen
 * running then cancelled was cancelled after that look, so the notice is shorter than the time left then).
 */
export async function claimAfterLanding(account, f, flight, before, { tripOp, notify }) {
  const key = claimKey(f.ident, f.date);
  const had = await account.storage.get(key);
  if (had && had.told) return had;
  let from = null, to = null;
  try { ({ from, to } = await tripOp(account, 'trip-flight-live', { ident: f.ident, date: f.date })); } catch { /* airports unknown: amounts as a range */ }
  const facts = {};
  if (flight.state === 'cancelled' && before && before.state && before.state !== 'cancelled' && before.checked_at) {
    const leaves = Date.parse(flight.departure.scheduled || '');
    if (leaves) facts.notice_days = Math.max(0, Math.floor((leaves - before.checked_at) / 86400_000));
  }
  const a = assessFlight({ flight, from, to }, { id: f.stop }, facts);
  const rec = { trip: f.trip, stop: f.stop, ident: f.ident, date: f.date, flight, from, to, facts, verdict: a.verdict, saved: account.now(), told: false };
  if (a.verdict === 'likely') {
    const what = a.what === 'cancelled' ? 'was cancelled' : `arrived ${hm(a.arrival_delay_min)} late`;
    await notify(account, { title: `${f.ident}: money back likely`, body: `${f.ident} ${what}. ${a.headline} Eden has the claim letter ready in Eden Travel.`, data: { kind: 'claim', trip: f.trip, stop: f.stop, ident: f.ident } });
    rec.told = true;
  }
  await account.storage.put(key, rec);
  return rec;
}

export async function claimsOp(account, op, body = {}, { tripOp } = {}) {
  const storage = account.storage;
  const id = String(body.id || '');
  if (!/^[0-9a-f]{16}$/.test(id)) throw new TripError('id must be a trip id.');
  const trip = await storage.get(`trip:${id}`);
  if (!trip) throw new TripError('There is no such trip.', 404, 'not_found');
  const today = new Date(account.now()).toISOString().slice(0, 10);
  const flights = (await flightStops(storage)).filter((f) => f.trip === id);
  const factsFor = (stop) => (body.facts && typeof body.facts === 'object' && body.facts[stop]) || (op === 'trip-claim-letter' && body.facts) || {};
  const clean = (x) => ({ denied_boarding: x.denied_boarding === true || undefined, notice_days: Number.isFinite(Number(x.notice_days)) && x.notice_days !== null && x.notice_days !== '' ? Math.max(0, Math.round(Number(x.notice_days))) : undefined, reroute: x.reroute && typeof x.reroute === 'object' ? { depart_earlier_min: Number(x.reroute.depart_earlier_min), arrive_later_min: Number(x.reroute.arrive_later_min) } : undefined });

  const one = async (f) => {
    let rec = await storage.get(claimKey(f.ident, f.date));
    if (!rec && f.date <= today && tripOp) {
      // not watched to the end (no FlightAware key then, or added late): one look now, kept like the watch's
      try {
        const live = await tripOp(account, 'trip-flight-live', { ident: f.ident, date: f.date });
        if (live.flight.state === 'landed' || live.flight.state === 'cancelled') {
          rec = { trip: f.trip, stop: f.stop, ident: f.ident, date: f.date, flight: live.flight, from: live.from, to: live.to, facts: {}, saved: account.now(), told: false };
          await storage.put(claimKey(f.ident, f.date), rec);
        } else rec = { flight: live.flight, from: live.from, to: live.to, facts: {} };
      } catch (e) { return { stop: f.stop, ident: f.ident, date: f.date, title: f.title, assessment: null, why: e.message || 'FlightAware has nothing for it.' }; }
    }
    const asked = clean(factsFor(f.stop));
    const facts = { ...((rec && rec.facts) || {}), ...Object.fromEntries(Object.entries(asked).filter(([, v]) => v !== undefined)) };
    const a = rec ? assessFlight(rec, { id: f.stop }, facts) : assessFlight(null, { id: f.stop }, facts);
    if (!rec && !facts.denied_boarding) return { stop: f.stop, ident: f.ident, date: f.date, assessment: null, why: f.date > today ? 'Not flown yet.' : 'No flight status for it.' };
    const form = a.operator && CLAIM_FORMS[a.operator.code];
    return { stop: f.stop, ident: f.ident, date: f.date, assessment: { ...a, ident: a.ident || f.ident }, form: form ? { url: form.url, seen: form.seen } : null };
  };

  if (op === 'trip-claims') {
    const claims = [];
    for (const f of flights) if (f.date <= today) claims.push(await one(f));
    return { claims, checked: RULES_CHECKED, note: 'Eden says “likely eligible”, never “owed”: the airline can still prove extraordinary circumstances. You send any claim yourself.' };
  }
  if (op === 'trip-claim-letter') {
    const f = flights.find((x) => x.stop === String(body.stop || ''));
    if (!f) throw new TripError('That stop isn’t a flight on this trip.', 404, 'not_found');
    const c = await one(f);
    if (!c.assessment) throw new TripError(c.why || 'No flight status for it yet.', 409, 'no_data');
    const passengers = Array.isArray(body.passengers) ? body.passengers : [];
    return { ...claimLetter(c.assessment, { passengers, booking_ref: body.booking_ref || null, law: body.law || null, date: f.date }), assessment: c.assessment };
  }
  throw new TripError('Unknown claims op.', 404, 'not_found');
}
