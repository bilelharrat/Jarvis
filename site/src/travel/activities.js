// Tours, tickets and restaurant links for a trip: what a partner sells near a stop or in the destination on a day, with
// its price as the partner gives it, its rating and how many people rated it, how long it lasts, whether it can be
// cancelled for free, and the partner's own page to book it on. Eden takes no payment here: the person books on the
// partner's site (an affiliate link where the partner gives one).
//
//   trip-activities { id, stop? } | { id?, destination, date? } (+ kind?: tours|tickets|food|outdoors, free_cancel?, currency?)
//     → { partners: [{ id, name, kind: 'activities'|'restaurants', on, results, note?, error?, source, checked_at }],
//         destination, date, currency, checked_at }
//
// Partners, each off until the Worker has EDEN_ACTIVITIES = "1" and that partner's key:
//
//   Viator Partner API v2 (affiliate). Docs read 2026-10-28: https://docs.viator.com/partner-api/technical/
//   (OpenAPI 2.0, servers https://api.viator.com/partner and https://api.sandbox.viator.com/partner; header
//   `exp-api-key`, `Accept: application/json;version=2.0`, `Accept-Language`), the golden path for Basic Access
//   affiliates https://partnerresources.viator.com/travel-commerce/affiliate/basic-access/golden-path/ and
//   https://partnerresources.viator.com/travel-commerce/affiliate/attribution/.
//     POST /search/freetext  { searchTerm, searchTypes: [{ searchType: 'DESTINATIONS'|'PRODUCTS', pagination }],
//                              productFiltering: { destination, dateRange: { from, to }, flags }, currency }
//     POST /products/search  { filtering: { destination, startDate, endDate, flags }, sorting, pagination, currency }
//     Both answer ProductSummary: productCode, title, reviews.{totalReviews, combinedAverageRating},
//     duration.{fixedDurationInMinutes | variableDurationFromMinutes/ToMinutes}, pricing.{summary.fromPrice, currency},
//     productUrl (affiliates only; "You must use the full URL and not modify it in any way"), flags.
//     The response's `flags` lists only the flags asked for, so free cancellation is known only when Eden asked
//     for FREE_CANCELLATION (then every result has it); otherwise it is null: "check on Viator".
//     A merchant key gets no productUrl and books through /bookings/*, which needs payment: not switched on here.
//   Env: VIATOR_API_KEY, VIATOR_SANDBOX = "1" (sandbox server), VIATOR_CAMPAIGN (optional `campaign-value`).
//
//   GetYourGuide Partner API v1. Spec read 2026-10-28: https://github.com/getyourguide/partner-api-spec
//   (spec/api.yaml, spec/paths/tours.yaml, spec/components/schema/tour.yaml, spec/components/commons/query.yaml;
//   reference https://code.getyourguide.com/partner-api-spec/; wiki "Getting started"). Servers
//   https://api.getyourguide.com and https://api.gygtest.net; header X-ACCESS-TOKEN; Accept: application/json.
//     GET /1/tours?cnt_language&currency (both required) & (q=<location> | coordinates[]=lat&coordinates[]=lng&
//         coordinates[]=radius) & date[]=<from>&date[]=<to> & sortfield & limit
//     → data.tours[]: tour_id, title, overall_rating, number_of_ratings, price.values.amount (+ price.description,
//       "per person"…; in the currency asked for), durations[{duration, unit: day|hour|minute}],
//       cancellation_policy { cancellable, cancellation_fee_value (null or 0 = no fee), cancellation_offset_minutes,
//       cancellation_policy_text }, activity_type, partner_business_category, url (carries partner_id).
//     Booking through /carts and /bookings takes payment through GetYourGuide's API: not switched on here.
//   Env: GYG_API_KEY, GYG_TESTING = "1" (the gygtest server), GYG_PARTNER_ID (added to a tour url only if it lacks one).
//
//   Restaurants: OpenTable and TheFork publish no open API for searching or booking tables. OpenTable's partner APIs
//   are approval-gated (https://dev.opentable.com/partner-portal/faqs); TheFork's B2B API
//   (https://docs.thefork.io, api.thefork.io/manager) is for a restaurant's own systems. So Eden only links: when a
//   meal stop's own link is a page on opentable.* or thefork.*, that page is the "Book on OpenTable/TheFork" link.
//   Nothing is searched and no table is held.
//
// Every result carries source and checked_at. A partner's words are plain short strings (ground.js text()).

import { text } from './ground.js';
import { TripError, dayDate } from './trips.js';

const TIMEOUT = 10000;
const MAX = 10; // results per partner
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CUR = /^[A-Z]{3}$/;
export const ACTIVITIES = { resultsMs: 6 * 3600_000, destMs: 30 * 86400_000, radiusKm: 3, daysAhead: 365 };
// ours, not a partner's: a few kinds the page offers, mapped to each partner's own words or fields
export const ACTIVITY_KINDS = {
  tours: { label: 'Tours', viator: 'tour', gyg: (t) => /Walking Tours|Bus Tours|Boat Tours|Day Trips|Attraction Tours|Multi-Day Trips/.test(t.partner_business_category || '') || /guidedTour|privateTour|dayTrip|hopOnHopOff|multiDayTrip/.test(t.activity_type || '') },
  tickets: { label: 'Tickets', viator: 'tickets', gyg: (t) => /Entrance Tickets|City Cards|Shows and Events/.test(t.partner_business_category || '') || /ticket|Ticket|cityCard/.test(t.activity_type || '') },
  food: { label: 'Food and drink', viator: 'food tour', gyg: (t) => /food|wine|tasting|cooking|culinary|beer|market/i.test(t.title || '') },
  outdoors: { label: 'Outdoors', viator: 'outdoor', gyg: (t) => /Adventure Tours|Boat Tours/.test(t.partner_business_category || '') || /waterActivity/.test(t.activity_type || '') },
};
export const PARTNERS = [
  { id: 'viator', name: 'Viator', kind: 'activities' },
  { id: 'getyourguide', name: 'GetYourGuide', kind: 'activities' },
  { id: 'opentable', name: 'OpenTable', kind: 'restaurants' },
  { id: 'thefork', name: 'TheFork', kind: 'restaurants' },
];

export class ActivitiesError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // not_set_up | bad_request | not_found | rate_limited | unavailable | timeout
    this.name = 'ActivitiesError';
  }
}

export const activitiesOn = (env) => String(env?.EDEN_ACTIVITIES || '') === '1';
const key = (v) => (typeof v === 'string' && /^[A-Za-z0-9_\-.:]{8,200}$/.test(v.trim()) ? v.trim() : '');
const stamp = (now) => new Date(now()).toISOString();
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** One fetch with a timeout; a partner's error mapped by HTTP status (its message isn't passed on: it can echo input). */
async function request(fetcher, url, init, who, timeoutMs) {
  let res;
  try {
    res = await fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new ActivitiesError('timeout', `${who} took too long to answer.`);
    throw new ActivitiesError('unavailable', `Eden couldn’t reach ${who}.`);
  }
  if (res.status === 401 || res.status === 403) throw new ActivitiesError('not_set_up', `${who} refused Eden’s key (it may be wrong, or not cover this).`);
  if (res.status === 404) throw new ActivitiesError('not_found', `${who} found nothing for that.`);
  if (res.status === 429) throw new ActivitiesError('rate_limited', `${who} is busy. Try again in a minute.`);
  if (res.status === 400 || res.status === 422) throw new ActivitiesError('bad_request', `${who} said some details aren’t valid.`);
  if (!res.ok) throw new ActivitiesError('unavailable', `${who} answered ${res.status}.`);
  const out = await res.json().catch(() => null);
  if (!out || typeof out !== 'object') throw new ActivitiesError('unavailable', `${who} sent an answer Eden couldn’t read.`);
  return out;
}

/* ---------- Viator ---------- */

/** One Viator ProductSummary in Eden's shape. */
export function viatorResult(p, { freeCancelAsked = false, checkedAt, mode }) {
  if (!p || typeof p !== 'object') return null;
  const title = text(p.title, 160);
  if (!title) return null;
  const d = p.duration || {};
  const fixed = num(d.fixedDurationInMinutes);
  const from = num(d.variableDurationFromMinutes), to = num(d.variableDurationToMinutes);
  const r = p.reviews || {};
  const pr = p.pricing || {};
  const amount = num(pr.summary && pr.summary.fromPrice);
  const currency = CUR.test(String(pr.currency || '')) ? pr.currency : null;
  const flags = Array.isArray(p.flags) ? p.flags : [];
  const url = typeof p.productUrl === 'string' && /^https:\/\/[^\s]+$/.test(p.productUrl) && p.productUrl.length <= 1000 ? p.productUrl : null;
  return {
    partner: 'viator',
    id: text(p.productCode, 60),
    title,
    about: text(p.description, 280),
    price: amount !== null && currency ? { amount, currency, kind: 'from', per: 'person' } : null, // Viator: lowest per-person retail price
    rating: num(r.combinedAverageRating),
    reviews: Number.isInteger(r.totalReviews) ? r.totalReviews : null,
    duration_min: fixed ?? from,
    duration_max_min: fixed === null && to !== null ? to : null,
    duration_text: fixed === null && from === null ? text(d.unstructuredDuration, 80) : null,
    free_cancellation: flags.includes('FREE_CANCELLATION') || freeCancelAsked ? { free: true, text: null } : null,
    confirmation: p.confirmationType === 'INSTANT' ? 'instant' : p.confirmationType === 'MANUAL' ? 'manual' : null,
    book_url: url, // the full affiliate link, unmodified (Viator's rule)
    book_label: 'Book on Viator',
    source: mode === 'sandbox' ? 'Viator (sandbox, test data)' : 'Viator',
    checked_at: checkedAt,
  };
}

/** The Viator client, or null when activities are off or there's no key. */
export function viatorFor(env = {}, { fetch: fetcher = globalThis.fetch, now = () => Date.now(), timeoutMs = TIMEOUT } = {}) {
  if (!activitiesOn(env)) return null;
  const k = key(env.VIATOR_API_KEY);
  if (!k) return null;
  const mode = env.VIATOR_SANDBOX === '1' ? 'sandbox' : 'live';
  const base = mode === 'sandbox' ? 'https://api.sandbox.viator.com/partner' : 'https://api.viator.com/partner';
  const campaign = typeof env.VIATOR_CAMPAIGN === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(env.VIATOR_CAMPAIGN) ? env.VIATOR_CAMPAIGN : '';
  const qs = campaign ? `?campaign-value=${encodeURIComponent(campaign)}` : '';
  const post = (path, body, ct = 'application/json') => request(fetcher, `${base}${path}${qs}`, {
    method: 'POST',
    headers: { 'exp-api-key': k, Accept: 'application/json;version=2.0', 'Accept-Language': 'en-US', 'Content-Type': ct },
    body: JSON.stringify(body),
  }, 'Viator', timeoutMs);

  return {
    id: 'viator',
    mode,
    /** Viator's destination id for a place name, or null. */
    async destination(name) {
      const out = await post('/search/freetext', { searchTerm: name, searchTypes: [{ searchType: 'DESTINATIONS', pagination: { start: 1, count: 1 } }], currency: 'USD' });
      const d = out.destinations && Array.isArray(out.destinations.results) ? out.destinations.results[0] : null;
      return d && Number.isInteger(d.id) ? { id: String(d.id), name: text(d.name, 120) } : null;
    },
    /** Products in a destination on a date; `term` (a stop's name or a kind) narrows it through free-text search. */
    async search({ destId, date, term, freeCancel, currency }) {
      const checkedAt = stamp(now);
      const flags = freeCancel ? ['FREE_CANCELLATION'] : undefined;
      let list;
      if (term) {
        const out = await post('/search/freetext', {
          searchTerm: term,
          searchTypes: [{ searchType: 'PRODUCTS', pagination: { start: 1, count: MAX } }],
          productFiltering: { ...(destId ? { destination: destId } : {}), dateRange: { from: date, to: date }, ...(flags ? { flags } : {}) },
          productSorting: { sort: 'DEFAULT' },
          currency,
        });
        list = out.products && Array.isArray(out.products.results) ? out.products.results : [];
      } else {
        const out = await post('/products/search', {
          filtering: { destination: destId, startDate: date, endDate: date, ...(flags ? { flags } : {}) },
          sorting: { sort: 'TRAVELER_RATING', order: 'DESCENDING' },
          pagination: { start: 1, count: MAX },
          currency,
        }, 'application/json;version=2.0');
        list = Array.isArray(out.products) ? out.products : [];
      }
      return list.map((p) => viatorResult(p, { freeCancelAsked: !!freeCancel, checkedAt, mode })).filter(Boolean).slice(0, MAX);
    },
  };
}

/* ---------- GetYourGuide ---------- */

const UNIT_MIN = { minute: 1, hour: 60, day: 1440 };

/** One GetYourGuide Tour in Eden's shape. */
export function gygResult(t, { currency, partnerId, checkedAt, mode }) {
  if (!t || typeof t !== 'object') return null;
  const title = text(t.title, 160);
  if (!title) return null;
  const durs = (Array.isArray(t.durations) ? t.durations : []).map((d) => (num(d && d.duration) !== null && UNIT_MIN[d.unit] ? Math.round(d.duration * UNIT_MIN[d.unit]) : null)).filter((x) => x !== null).sort((a, b) => a - b);
  const amount = num(t.price && t.price.values && t.price.values.amount);
  const cp = t.cancellation_policy && typeof t.cancellation_policy === 'object' ? t.cancellation_policy : null;
  let free = null;
  if (cp && typeof cp.cancellable === 'boolean') {
    const fee = num(cp.cancellation_fee_value);
    const off = num(cp.cancellation_offset_minutes);
    free = { free: cp.cancellable && !fee, text: text(cp.cancellation_policy_text, 240) || text(t.cancellation_policy_text, 240), ...(cp.cancellable && !fee && off ? { until_hours_before: Math.round(off / 60) } : {}) };
  } else if (text(t.cancellation_policy_text, 240)) free = { free: null, text: text(t.cancellation_policy_text, 240) };
  let url = null;
  if (typeof t.url === 'string' && t.url.length <= 1000) {
    try {
      const u = new URL(t.url);
      if (u.protocol === 'https:') {
        if (partnerId && !u.searchParams.has('partner_id')) u.searchParams.set('partner_id', partnerId);
        url = u.toString();
      }
    } catch { /* not a link */ }
  }
  return {
    partner: 'getyourguide',
    id: Number.isInteger(t.tour_id) ? String(t.tour_id) : text(t.tour_id, 40),
    title,
    about: text(t.abstract, 280),
    price: amount !== null ? { amount, currency, kind: 'from', per: text(t.price.description, 60) } : null, // GYG: a starting price, in the currency asked for
    rating: num(t.overall_rating),
    reviews: Number.isInteger(t.number_of_ratings) ? t.number_of_ratings : null,
    duration_min: durs.length ? durs[0] : null,
    duration_max_min: durs.length > 1 && durs[durs.length - 1] !== durs[0] ? durs[durs.length - 1] : null,
    duration_text: null,
    free_cancellation: free,
    confirmation: t.free_sale === true ? 'instant' : null,
    category: text(t.partner_business_category, 60),
    book_url: url,
    book_label: 'Book on GetYourGuide',
    source: mode === 'testing' ? 'GetYourGuide (testing server)' : 'GetYourGuide',
    checked_at: checkedAt,
  };
}

/** The GetYourGuide client, or null when activities are off or there's no key. */
export function gygFor(env = {}, { fetch: fetcher = globalThis.fetch, now = () => Date.now(), timeoutMs = TIMEOUT } = {}) {
  if (!activitiesOn(env)) return null;
  const k = key(env.GYG_API_KEY);
  if (!k) return null;
  const mode = env.GYG_TESTING === '1' ? 'testing' : 'live';
  const base = mode === 'testing' ? 'https://api.gygtest.net' : 'https://api.getyourguide.com';
  const partnerId = typeof env.GYG_PARTNER_ID === 'string' && /^[A-Za-z0-9]{2,40}$/.test(env.GYG_PARTNER_ID) ? env.GYG_PARTNER_ID : '';
  return {
    id: 'getyourguide',
    mode,
    /** Tours near a point (or in a named place) on a date. */
    async search({ lat, lng, place, date, kind, freeCancel, currency }) {
      const checkedAt = stamp(now);
      // the spec marks these params allowReserved, so the [] stays literal; values are encoded
      const p = [['cnt_language', 'en'], ['currency', currency], ['sortfield', 'popularity'], ['limit', String(kind || freeCancel ? 40 : MAX)]];
      if (Number.isFinite(lat) && Number.isFinite(lng)) p.push(['coordinates[]', String(lat)], ['coordinates[]', String(lng)], ['coordinates[]', String(ACTIVITIES.radiusKm)]);
      else p.push(['q', String(place).replace(/[^\p{L}\p{N} ,.'-]/gu, ' ').slice(0, 150)]); // GYG: q ≤ 150 characters
      p.push(['date[]', `${date}T00:00:00`], ['date[]', `${date}T23:59:59`]);
      const qs = p.map(([a, b]) => `${a}=${encodeURIComponent(b)}`).join('&');
      const out = await request(fetcher, `${base}/1/tours?${qs}`, { method: 'GET', headers: { 'X-ACCESS-TOKEN': k, Accept: 'application/json' } }, 'GetYourGuide', timeoutMs);
      let tours = out.data && Array.isArray(out.data.tours) ? out.data.tours : [];
      if (kind && ACTIVITY_KINDS[kind]) tours = tours.filter(ACTIVITY_KINDS[kind].gyg);
      let list = tours.map((t) => gygResult(t, { currency, partnerId, checkedAt, mode })).filter(Boolean);
      if (freeCancel) list = list.filter((r) => r.free_cancellation && r.free_cancellation.free === true);
      return list.slice(0, MAX);
    },
  };
}

/* ---------- restaurants: links only ---------- */

const RESTAURANT_HOSTS = [
  { id: 'opentable', name: 'OpenTable', re: /(^|\.)opentable\.(com|co\.uk|ca|de|ie|it|jp|com\.au|com\.mx|nl|es|ae|sg|hk|fr)$/ },
  { id: 'thefork', name: 'TheFork', re: /(^|\.)(thefork\.(com|co\.uk|fr|it|es|nl|be|ch|pt|dk|se|at|com\.au|com\.br)|lafourchette\.com|eltenedor\.es)$/ },
];
/** The booking partner of a venue's own link (OpenTable or TheFork), or null. Only a page we were given, never a guess. */
export function restaurantLink(link) {
  if (typeof link !== 'string' || link.length > 500) return null;
  let u;
  try { u = new URL(link); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.pathname === '/' || !u.pathname) return null; // a venue's page, not the home page
  const host = u.hostname.toLowerCase();
  const p = RESTAURANT_HOSTS.find((h) => h.re.test(host));
  return p ? { partner: p.id, name: p.name, url: u.toString() } : null;
}

/* ---------- the account's op ---------- */

const NOTE_OFF = {
  viator: 'Viator isn’t switched on yet (it needs Eden’s Viator partner key).',
  getyourguide: 'GetYourGuide isn’t switched on yet (it needs Eden’s GetYourGuide partner key).',
  opentable: 'OpenTable has no open booking API. When a meal stop’s link is its OpenTable page, it shows here to book on OpenTable.',
  thefork: 'TheFork has no open booking API. When a meal stop’s link is its TheFork page, it shows here to book on TheFork.',
};

function where(trip, stopId) {
  for (let d = 0; d < trip.days.length; d++) {
    const s = trip.days[d].stops.find((x) => x.id === stopId);
    if (s) return { stop: s, day: d };
  }
  throw new TripError('There is no such stop in this trip.', 404, 'not_found');
}

/** trip-activities: each partner's results, or why it has none. `deps.partners` lets tests hand in clients. */
export async function activitiesOp(account, op, body = {}, deps = {}) {
  if (op !== 'trip-activities') throw new TripError('Unknown activities op.', 404, 'not_found');
  const now = () => account.now();
  const cache = deps.cache || { get: async () => undefined, put: async () => {} };
  let trip = null, stop = null, dayIndex = null;
  if (body.id != null) {
    trip = await account.storage.get(`trip:${String(body.id)}`);
    if (!trip) throw new TripError('There is no such trip.', 404, 'not_found');
    if (body.stop != null) ({ stop, day: dayIndex } = where(trip, String(body.stop)));
  } else if (body.stop != null) throw new TripError('A stop needs its trip id.');
  const destination = text(body.destination, 120) || (trip && text(trip.destination || trip.title, 120));
  if (!destination) throw new TripError('Where? A trip id or a destination.');
  const city = destination.split(',')[0].trim();
  let date = body.date != null ? String(body.date) : trip ? dayDate(trip, dayIndex ?? 0) : '';
  if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new TripError('date must be YYYY-MM-DD.');
  const today = new Date(now()).toISOString().slice(0, 10);
  const last = new Date(now() + ACTIVITIES.daysAhead * 86400_000).toISOString().slice(0, 10);
  if (date < today) date = today; // partners refuse past dates (Viator: "cannot be in the past"); a trip under way looks from today
  if (date > last) throw new TripError('Partners sell up to a year ahead: pick a nearer date.');
  const kind = body.kind == null || body.kind === '' ? null : String(body.kind);
  if (kind && !ACTIVITY_KINDS[kind]) throw new TripError(`kind must be one of ${Object.keys(ACTIVITY_KINDS).join(', ')}.`);
  const freeCancel = body.free_cancel === true;
  const currency = CUR.test(String(body.currency || '')) ? String(body.currency) : trip && trip.budget && CUR.test(String(trip.budget.currency || '')) ? trip.budget.currency : 'EUR';
  const checkedAt = new Date(now()).toISOString();
  const point = stop && Number.isFinite(stop.place.lat) && Number.isFinite(stop.place.lng) ? { lat: stop.place.lat, lng: stop.place.lng } : null;
  const clientDeps = { fetch: deps.fetch, now };
  const clients = deps.partners || { viator: viatorFor(account.env, clientDeps), getyourguide: gygFor(account.env, clientDeps) };

  const run = async (id, fn) => {
    const c = clients[id];
    const meta = PARTNERS.find((p) => p.id === id);
    if (!c) return { ...meta, on: false, results: [], note: NOTE_OFF[id], source: meta.name, checked_at: checkedAt };
    const ck = `act1:${id}:${c.mode}:${city.toLowerCase()}:${stop ? stop.place.name.toLowerCase() : ''}:${point ? `${point.lat.toFixed(3)},${point.lng.toFixed(3)}` : ''}:${date}:${kind || ''}:${freeCancel ? 1 : 0}:${currency}`;
    try {
      let results = await cache.get(ck);
      if (results === undefined) {
        results = await fn(c);
        await cache.put(ck, results, ACTIVITIES.resultsMs);
      }
      return { ...meta, on: true, mode: c.mode, results, source: meta.name, checked_at: results[0] ? results[0].checked_at : checkedAt };
    } catch (e) {
      if (!(e instanceof ActivitiesError)) throw e;
      return { ...meta, on: true, mode: c.mode, results: [], error: e.message, code: e.code, source: meta.name, checked_at: checkedAt };
    }
  };

  const partners = await Promise.all([
    run('viator', async (c) => {
      const dk = `vdest1:${c.mode}:${city.toLowerCase()}`;
      let dest = await cache.get(dk);
      if (dest === undefined) { dest = await c.destination(city); await cache.put(dk, dest, dest ? ACTIVITIES.destMs : 24 * 3600_000); }
      if (!dest) throw new ActivitiesError('not_found', `Viator has no destination called ${city}.`);
      const term = [stop && stop.kind !== 'stay' ? stop.place.name : null, kind ? ACTIVITY_KINDS[kind].viator : null].filter(Boolean).join(' ');
      return c.search({ destId: dest.id, date, term: term || null, freeCancel, currency });
    }),
    run('getyourguide', (c) => c.search({ ...(point || {}), place: city, date, kind, freeCancel, currency })),
  ]);
  // restaurants: only the stop's own page on the partner's site
  const venue = stop ? restaurantLink(stop.link) : null;
  for (const meta of PARTNERS.filter((p) => p.kind === 'restaurants')) {
    const hit = venue && venue.partner === meta.id;
    partners.push({
      ...meta,
      on: !!hit,
      link_only: true,
      results: hit ? [{ partner: meta.id, id: null, title: stop.place.name, about: null, price: null, rating: null, reviews: null, duration_min: null, duration_max_min: null, duration_text: null, free_cancellation: null, confirmation: null, book_url: venue.url, book_label: `Book on ${meta.name}`, source: `The stop’s own link (${meta.name})`, checked_at: checkedAt }] : [],
      note: NOTE_OFF[meta.id],
      source: meta.name,
      checked_at: checkedAt,
    });
  }
  return { destination: city, date, kind, currency, stop: stop ? stop.id : null, partners, checked_at: checkedAt };
}
