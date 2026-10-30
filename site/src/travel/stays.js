// Eden Travel's hotels: Duffel Stays (duffel.com/docs/api/v2, read 2026-10-27: stays-search, fetch-all-rates,
// create-quote, create-booking, get-booking, and the "Displaying the Cancellation Timeline" guide). The flow is
// Duffel's own: search an area → fetch all rates for one hotel → quote a rate (Duffel checks it is still bookable at
// that price) → book the quote. Bookings are paid from the Duffel balance: Duffel says the `payment` object must be
// omitted for that, so none is sent.
//
// Off unless the Worker has EDEN_STAYS = "1" and DUFFEL_TOKEN (the same secret as flights). A duffel_live_ token is
// refused unless DUFFEL_LIVE = "1", as flights do, so a test setup can never book a real room. Nothing here logs:
// the token goes only in the Authorization header, and guests' names, email and phone go only in the booking body
// and are never in an answer or an error message.
//
// Every answer carries `source` and `checked_at`. Amounts stay the decimal strings Duffel sends ("799.00"), so
// nothing is rounded on the way to the card.
//
// Hotel loyalty (read 2026-10-28; loyalty.js has the quotes): the quote's `supported_loyalty_programme`
// (duffel.com/docs/api/v2/quotes/create-quote) names the one programme a booking of it can earn with, and Create booking
// takes one `loyalty_programme_account_number` (duffel.com/docs/api/v2/bookings/create-booking), sent "only when the
// quote has a supported_loyalty_programme indicated" or Duffel errors. Rates carry the same field in Duffel's samples
// (shown as a hint; the quote's is the one that decides). The rate's `loyalty_programme_required` is in the samples
// but undocumented, so it isn't read.
//
// Left out on purpose (not documented, or not needed yet): Duffel's error codes for Stays (the pages list none, so
// errors map by HTTP status), the full set of board_type / payment_type values (only samples: room_only, pay_now),
// any radius limit, and cancel (POST /stays/bookings/{id}/actions/cancel exists; not wired until it is asked for).

const BASE = 'https://api.duffel.com';
const TIMEOUT = 12000; // a search fans out to many hotel sources, slower than a flight offer request
const SOURCE = 'Duffel Stays';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86400_000;
export const MAX_NIGHTS = 99; // Duffel: "A stay can be up to 99 nights"
export const MAX_DAYS_AHEAD = 330; // Duffel: check-in "no more than 330 days in the future"
const MAX_RADIUS_KM = 50; // ours, not Duffel's: a city is wide enough for a hotel search
const MAX_RESULTS = 20; // the summary list a card can show
// Duffel ids as the docs' samples show them (srr_0000ARxBI85qTkbVapZMO2, rat_…, quo_…, bok_…).
const ID = { srr: /^srr_[A-Za-z0-9]{6,60}$/, rat: /^rat_[A-Za-z0-9]{6,60}$/, quo: /^quo_[A-Za-z0-9]{6,60}$/, bok: /^bok_[A-Za-z0-9]{6,60}$/ };
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const E164 = /^\+[1-9]\d{6,14}$/; // Duffel: "E.164 format", e.g. +442080160509

export class StaysError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // not_set_up | live_refused | bad_request | not_found | rate_limited | unavailable | timeout | not_confirmed
    this.name = 'StaysError';
  }
}

export const staysOn = (env) => String(env?.EDEN_STAYS || '') === '1';

/** The hotel service, or null when stays are off or there's no token. Throws live_refused for an unallowed live token. */
export function staysFor(env = {}, { fetch: fetcher = globalThis.fetch, now = () => Date.now(), baseUrl = BASE, timeoutMs = TIMEOUT } = {}) {
  if (!staysOn(env)) return null;
  const token = typeof env.DUFFEL_TOKEN === 'string' ? env.DUFFEL_TOKEN.trim() : '';
  if (!token) return null;
  if (!/^duffel_(test|live)_[A-Za-z0-9_\-=.+/]{8,400}$/.test(token)) throw new StaysError('not_set_up', 'The Duffel token doesn’t look right (it should start with duffel_test_).');
  const live = token.startsWith('duffel_live_');
  if (live && env.DUFFEL_LIVE !== '1') throw new StaysError('live_refused', 'Eden refused a live Duffel token: only test bookings are allowed until DUFFEL_LIVE=1 is set.');
  const mode = live ? 'live' : 'test';
  const base = String(baseUrl).replace(/\/+$/, '');
  const stamp = () => new Date(now()).toISOString();

  const call = async (method, path, data) => {
    let res;
    try {
      res = await fetcher(`${base}${path}`, {
        method,
        headers: { 'Duffel-Version': 'v2', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        ...(data === undefined ? {} : { body: JSON.stringify({ data }) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new StaysError('timeout', 'Duffel took too long to answer.');
      throw new StaysError('unavailable', 'Eden couldn’t reach Duffel.');
    }
    // By status only: the Stays pages document no error codes. Duffel's message isn't passed on (it can echo input).
    if (res.status === 401 || res.status === 403) throw new StaysError('not_set_up', 'Duffel refused: hotel booking (Stays) may not be switched on for Eden’s Duffel account yet.');
    if (res.status === 404) throw new StaysError('not_found', 'Duffel has no such hotel, rate, quote or booking (it may have expired).');
    if (res.status === 429) throw new StaysError('rate_limited', 'Duffel is busy. Try again in a minute.');
    if (res.status === 400 || res.status === 422) throw new StaysError('bad_request', 'Duffel said some details aren’t valid, or the rate is no longer available.');
    if (res.status === 504) throw new StaysError('timeout', 'Duffel took too long to answer.');
    if (!res.ok) throw new StaysError('unavailable', `Duffel answered ${res.status}.`);
    const out = await res.json().catch(() => null);
    if (!out || typeof out.data !== 'object' || !out.data) throw new StaysError('unavailable', 'Duffel sent an answer Eden couldn’t read.');
    return out.data;
  };

  return {
    mode,
    /** Hotels near a point: { results: [summary…], check_in, check_out, nights, source, checked_at, mode }. */
    async search(args = {}) {
      const q = searchArgs(args, now());
      const data = await call('POST', '/stays/search', {
        rooms: q.rooms,
        guests: [...Array(q.adults)].map(() => ({ type: 'adult' })).concat(q.children_ages.map((age) => ({ type: 'child', age }))),
        check_in_date: q.check_in,
        check_out_date: q.check_out,
        location: { radius: q.radius_km, geographic_coordinates: { latitude: q.lat, longitude: q.lng } },
      });
      const list = Array.isArray(data.results) ? data.results : [];
      const results = list.map(resultSummary).filter(Boolean)
        .sort((a, b) => Number(a.cheapest.total) - Number(b.cheapest.total))
        .slice(0, MAX_RESULTS);
      return { results, check_in: q.check_in, check_out: q.check_out, nights: q.nights, mode, source: SOURCE, checked_at: stamp() };
    },
    /** Every room and rate of one search result, each rate's cancellation normalized. */
    async rates(searchResultId) {
      const id = checkId(searchResultId, 'srr', 'search result');
      const data = await call('POST', `/stays/search_results/${id}/actions/fetch_all_rates`); // no body: Duffel's sample sends none
      const acc = data.accommodation || {};
      const rooms = (Array.isArray(acc.rooms) ? acc.rooms : []).map((r) => ({
        name: r.name || null,
        beds: (Array.isArray(r.beds) ? r.beds : []).map((b) => ({ type: b.type || null, count: Number.isFinite(b.count) ? b.count : null })),
        photos: photoUrls(r.photos),
        rates: (Array.isArray(r.rates) ? r.rates : []).map(rateView),
      }));
      return { search_result_id: searchResultId, accommodation: accView(acc), expires_at: data.expires_at || null, rooms, mode, source: SOURCE, checked_at: stamp() };
    },
    /** Duffel's check that a rate is still there at its price: what the confirm card shows. */
    async quote(rateId) {
      const data = await call('POST', '/stays/quotes', { rate_id: checkId(rateId, 'rat', 'rate') });
      return {
        quote_id: data.id,
        total: data.total_amount ?? null,
        currency: data.total_currency ?? null,
        tax: data.tax_amount ?? null,
        tax_currency: data.tax_currency ?? null,
        fee: data.fee_amount ?? null,
        fee_currency: data.fee_currency ?? null,
        due_at_accommodation: data.due_at_accommodation_amount ?? null, // paid at the hotel, on top of what Duffel takes now
        due_at_accommodation_currency: data.due_at_accommodation_currency ?? null,
        check_in: data.check_in_date ?? null,
        check_out: data.check_out_date ?? null,
        accommodation: accView(data.accommodation),
        loyalty_programme: typeof data.supported_loyalty_programme === 'string' ? data.supported_loyalty_programme : null, // the one a booking of this quote earns with
        mode,
        source: SOURCE,
        checked_at: stamp(),
      };
    },
    /** Books a quote from the Duffel balance. Only the card's button sends confirm: true. */
    async book(args = {}) {
      if (args.confirm !== true) throw new StaysError('not_confirmed', 'Not confirmed: a hotel is booked only from the confirm button.');
      const body = bookingBody(args);
      return bookingView(await call('POST', '/stays/bookings', body), mode, stamp());
    },
    /** Cancels a booking (Duffel: POST /stays/bookings/{id}/actions/cancel). Only a confirm button sends confirm: true. */
    async cancel(id, { confirm } = {}) {
      if (confirm !== true) throw new StaysError('not_confirmed', 'Not confirmed: a booking is cancelled only from the confirm button.');
      return bookingView(await call('POST', `/stays/bookings/${checkId(id, 'bok', 'booking')}/actions/cancel`), mode, stamp());
    },
    /** A booking's state now (confirmed or cancelled). */
    async booking(id) {
      return bookingView(await call('GET', `/stays/bookings/${checkId(id, 'bok', 'booking')}`), mode, stamp());
    },
  };
}

// ---- input --------------------------------------------------------------------------------------------------

const bad = (message) => new StaysError('bad_request', message);

function checkId(v, prefix, what) {
  if (typeof v !== 'string' || !ID[prefix].test(v)) throw bad(`That isn’t a Duffel ${what} id.`);
  return encodeURIComponent(v);
}

/** Search input, checked before anything is sent (Duffel bills nothing for a refused search, but it is a wasted call). */
export function searchArgs({ lat, lng, radius_km = 5, check_in, check_out, adults = 1, children_ages = [], rooms = 1 } = {}, nowMs = Date.now()) {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) throw bad('lat and lng must be a point on the map.');
  if (!Number.isFinite(radius_km) || radius_km <= 0 || radius_km > MAX_RADIUS_KM) throw bad(`radius_km must be more than 0 and at most ${MAX_RADIUS_KM}.`);
  const nights = checkDates(check_in, check_out, nowMs);
  if (!Number.isInteger(adults) || adults < 1 || adults > 9) throw bad('adults must be 1 to 9.');
  if (!Array.isArray(children_ages) || children_ages.length > 8 || children_ages.some((a) => !Number.isInteger(a) || a < 0 || a > 17)) throw bad('children_ages must be a list of ages 0 to 17.');
  // every room needs an adult in it
  if (!Number.isInteger(rooms) || rooms < 1 || rooms > adults) throw bad('rooms must be at least 1 and no more than the number of adults.');
  return { lat, lng, radius_km, check_in, check_out, nights, adults, children_ages, rooms };
}

/** Nights between the two dates, or a bad_request: check-out after check-in, at most 99 nights, check-in within 330 days. */
export function checkDates(checkIn, checkOut, nowMs = Date.now()) {
  if (!DATE.test(String(checkIn || '')) || !DATE.test(String(checkOut || ''))) throw bad('check_in and check_out must be dates, YYYY-MM-DD.');
  const a = Date.parse(`${checkIn}T00:00:00Z`), b = Date.parse(`${checkOut}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || new Date(a).toISOString().slice(0, 10) !== checkIn || new Date(b).toISOString().slice(0, 10) !== checkOut) throw bad('check_in and check_out must be real dates.');
  // "today" is a day early anywhere west of UTC late in the evening, so a day's grace before calling a date past
  const today = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00Z`);
  if (a < today - DAY) throw bad('check_in is in the past.');
  if (a > today + MAX_DAYS_AHEAD * DAY) throw bad(`check_in can be at most ${MAX_DAYS_AHEAD} days ahead.`);
  if (b <= a) throw bad('check_out must be after check_in.');
  const nights = Math.round((b - a) / DAY);
  if (nights > MAX_NIGHTS) throw bad(`A stay can be at most ${MAX_NIGHTS} nights.`);
  return nights;
}

function bookingBody({ quote_id, guests, email, phone_number, special_requests, loyalty_programme_account_number }) {
  const name = (v) => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 60;
  if (!Array.isArray(guests) || guests.length < 1 || guests.length > 18 || !guests.every((g) => g && name(g.given_name) && name(g.family_name))) throw bad('guests must list each guest’s given_name and family_name.');
  if (typeof email !== 'string' || !EMAIL.test(email.trim())) throw bad('email must be the lead guest’s email address.');
  if (typeof phone_number !== 'string' || !E164.test(phone_number.trim())) throw bad('phone_number must be in E.164 form, like +442080160509.');
  if (special_requests != null && (typeof special_requests !== 'string' || special_requests.length > 500)) throw bad('special_requests must be text, at most 500 characters.');
  const body = {
    quote_id: decodeURIComponent(checkId(quote_id, 'quo', 'quote')),
    guests: guests.map((g) => ({ given_name: g.given_name.trim(), family_name: g.family_name.trim() })),
    email: email.trim(),
    phone_number: phone_number.trim(),
  };
  // Duffel forwards these to the hotel and asks for nothing medical or sensitive in them; the card says so.
  if (special_requests && special_requests.trim()) body.accommodation_special_requests = special_requests.trim();
  // only stayops sends one, and only when the quote named a programme (Duffel errors otherwise)
  if (loyalty_programme_account_number != null) {
    if (typeof loyalty_programme_account_number !== 'string' || !/^[A-Z0-9]{4,20}$/.test(loyalty_programme_account_number)) throw bad('loyalty_programme_account_number must be 4 to 20 letters or digits.');
    body.loyalty_programme_account_number = loyalty_programme_account_number;
  }
  return body;
}

// ---- output -------------------------------------------------------------------------------------------------

const photoUrls = (photos) => (Array.isArray(photos) ? photos.map((p) => p && p.url).filter((u) => typeof u === 'string' && /^https:\/\//.test(u)) : []);

function accView(a) {
  if (!a || typeof a !== 'object') return null;
  const loc = a.location || {}, addr = loc.address || {}, geo = loc.geographic_coordinates || {};
  return {
    id: a.id || null,
    name: a.name || null,
    rating: Number.isFinite(a.rating) ? a.rating : null, // star rating
    review_score: Number.isFinite(a.review_score) ? a.review_score : null,
    photos: photoUrls(a.photos).slice(0, 6),
    address: { line_one: addr.line_one || null, city: addr.city_name || null, country_code: addr.country_code || null },
    lat: Number.isFinite(geo.latitude) ? geo.latitude : null,
    lng: Number.isFinite(geo.longitude) ? geo.longitude : null,
  };
}

function resultSummary(r) {
  if (!r || typeof r.id !== 'string') return null;
  return { search_result_id: r.id, accommodation: accView(r.accommodation), cheapest: { total: r.cheapest_rate_total_amount ?? null, currency: r.cheapest_rate_currency ?? null }, expires_at: r.expires_at || null };
}

function rateView(r) {
  return {
    rate_id: r.id,
    total: r.total_amount ?? null,
    currency: r.total_currency ?? null,
    board_type: r.board_type || null,
    payment_type: r.payment_type || null,
    conditions: (Array.isArray(r.conditions) ? r.conditions : []).map((c) => ({ title: c.title || null, description: c.description || null })),
    cancellation: cancellation(r.cancellation_timeline, r.total_amount, r.total_currency),
    expires_at: r.expires_at || null,
    loyalty_programme: typeof r.supported_loyalty_programme === 'string' ? r.supported_loyalty_programme : null,
  };
}

/**
 * Duffel's cancellation_timeline → { free_until, refunds }. Per Duffel's guide: each entry's refund_amount applies until
 * its `before` (UTC); a refund equal to the rate's total is a full refund; an empty timeline means not refundable; time
 * after the last `before` is not refundable. So free_until is the latest `before` with a full refund, else null.
 * Entries are sorted by `before` here: the guide implies time order but doesn't promise it.
 */
export function cancellation(timeline, total, currency) {
  const refunds = (Array.isArray(timeline) ? timeline : [])
    .filter((t) => t && typeof t.before === 'string' && Number.isFinite(Date.parse(t.before)) && t.refund_amount != null && Number.isFinite(Number(t.refund_amount)))
    .map((t) => ({ before: new Date(Date.parse(t.before)).toISOString(), amount: String(t.refund_amount), currency: t.currency || currency || null }))
    .sort((a, b) => Date.parse(a.before) - Date.parse(b.before));
  const whole = Number(total);
  const full = Number.isFinite(whole) ? refunds.filter((r) => Number(r.amount) >= whole && (!currency || r.currency === currency)) : [];
  return { free_until: full.length ? full[full.length - 1].before : null, refunds };
}

function bookingView(b, mode, checkedAt) {
  return {
    booking_id: b.id,
    reference: b.reference || null, // the hotel's reference, for the guest to quote at the desk
    status: b.status || null, // confirmed | cancelled
    confirmed_at: b.confirmed_at || null,
    cancelled_at: b.cancelled_at || null,
    check_in: b.check_in_date || null,
    check_out: b.check_out_date || null,
    accommodation: accView(b.accommodation),
    mode,
    source: SOURCE,
    checked_at: checkedAt,
  };
}

// ---- price protection ---------------------------------------------------------------------------------------

/**
 * Is a fresh rate worth rebooking for? booked { total, currency, free_until }, fresh { total, currency, rate_id }.
 * Only when the currency is the same (no exchange-rate guesses), the fresh price is lower by more than 1% (less is
 * noise and not worth a cancel-and-rebook), and the booking can still be cancelled for free.
 */
export function priceDrop(booked, fresh, nowMs = Date.now()) {
  const was = Number(booked?.total), is = Number(fresh?.total);
  if (!Number.isFinite(was) || !Number.isFinite(is) || was <= 0 || is <= 0) return { cheaper: false, why: 'no_price' };
  if (!booked.currency || booked.currency !== fresh.currency) return { cheaper: false, why: 'currency_differs' };
  const until = Date.parse(booked.free_until || '');
  if (!Number.isFinite(until)) return { cheaper: false, why: 'not_free_to_cancel' };
  if (nowMs >= until) return { cheaper: false, why: 'free_cancellation_over' };
  if (is >= was * 0.99) return { cheaper: false, why: is < was ? 'too_small' : 'not_cheaper' };
  return { cheaper: true, by: (Math.round((was - is) * 100) / 100).toFixed(2), currency: booked.currency, rate_id: fresh.rate_id ?? null, rebook_before: booked.free_until };
}
