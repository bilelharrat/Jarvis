// Eden Travel's trains and buses: Distribusion's retailer API v4. Everything here is from
// docs.distribusion.com (read 2026-10-27): API Authentication, Demo Environment, and the pages
// for GET /stations, POST /connections/find, POST /connections/vacancy, POST /reservations/create
// and PUT /reservations/confirm. Gaps in the docs are marked GAP and nothing is filled in for them.
//
// Off unless EDEN_RAIL === "1" and DISTRIBUSION_API_KEY is set (a secret, sent only in the
// Api-Key header, never logged). Each environment has its own key, so DISTRIBUSION_ENV picks
// which base the key is for: the demo unless it says "production".
//   production: https://api.distribusion.com (auth page) + /retailers/v4
//   demo:       https://api.demo.distribusion.com/retailers/v4 (auth page's curl example)
// GAP: the docs only show /retailers/v4 on the demo host; we assume production uses the same path.
// The demo prices /connections/vacancy at a dummy 2500 (EUR cents), unlike /connections/find.
//
// Money in every response is in cents, in `meta.currency`. Times (departure_time, arrival_time)
// are the station's local time with no offset ("2026-05-03T10:07"), so `duration` (seconds, per the
// docs' example: 8580 for 10:07 Paris → 11:30 London) is the only safe journey length.
//
// confirm() completes a booking with the carrier, so it throws unless the caller passes
// { confirm: true }: the traveller's own yes, asked for in Eden's UI, never inferred.

import { DATE, GroundError, journeyOption, text } from './ground.js';

export const DISTRIBUSION_BASE = { production: 'https://api.distribusion.com/retailers/v4', demo: 'https://api.demo.distribusion.com/retailers/v4' };
const TIMEOUT = 10_000;
const STATION = /^[A-Z0-9]{8}$/; // the API's own error: "departure_location[stations] must be exactly 8 uppercase le…" (GAP: letters only, or digits too? we allow both)
const PAX_ID = /^[A-Za-z0-9_-]{1,80}$/;
const PAX_TYPE = /^[A-Z]{4}$/; // the docs' pattern for passenger type ("PNOS" = adult in the example)
const OFFER_ID = /^[A-Za-z0-9|:_-]{1,200}$/;
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]+$/; // the docs' pattern
const CURRENCY = /^[A-Z]{3}$/;
const LOCALE = /^[a-z]{2}$/;
// connections/find needs an age for each group (pax + max_age). The docs' example sends 40, inside
// the example's adult type PNOS (26–59); we send the same for "adults". GAP: how youth/senior map.
const ADULT_AGE = 40;

const money = (v, currency) => (Number.isFinite(v) && CURRENCY.test(String(currency || '')) ? { amount: v / 100, currency } : null);

// JSON:API's `included` as a lookup: type → id → resource.
function index(included) {
  const out = {};
  for (const r of Array.isArray(included) ? included : []) {
    if (!r || typeof r.type !== 'string' || typeof r.id !== 'string') continue;
    (out[r.type] = out[r.type] || {})[r.id] = r;
  }
  return out;
}
const rel = (r, name) => (r && r.relationships && r.relationships[name] ? r.relationships[name].data : null);
const many = (d) => (Array.isArray(d) ? d : d ? [d] : []);

// The docs show vehicle_types code "TRAIN"; GAP: the full list. A bus or ferry code maps to its mode.
const MODE_OF = { TRAIN: 'train', BUS: 'bus', FERRY: 'ferry' };

/** A connections/find response → journey options (cheapest fare that isn't booked out). */
export function railOptions(out, { checkedAt }) {
  const inc = index(out && out.included);
  const currency = out && out.meta && out.meta.currency;
  const stationName = (id) => (inc.stations && inc.stations[id] && inc.stations[id].attributes ? inc.stations[id].attributes.name : null);
  return (Array.isArray(out && out.data) ? out.data : []).filter((c) => c && c.type === 'connections' && c.attributes).map((c) => {
    const a = c.attributes;
    const dep = rel(c, 'departure_station');
    const arr = rel(c, 'arrival_station');
    const carrier = rel(c, 'marketing_carrier');
    const mc = carrier && inc.marketing_carriers ? inc.marketing_carriers[carrier.id] : null;
    const segs = many(rel(c, 'segments')).map((s) => inc.segments && inc.segments[s.id]).filter(Boolean);
    const vehicle = segs.length ? rel(segs[0], 'vehicle') : null;
    const vt = vehicle && inc.vehicles && inc.vehicles[vehicle.id] ? rel(inc.vehicles[vehicle.id], 'vehicle_type') : null;
    const code = vt && inc.vehicle_types && inc.vehicle_types[vt.id] ? inc.vehicle_types[vt.id].attributes.code : vt && vt.id;
    // fares: the connection lists its fare ids; the priced offers are in included (type "fares")
    const offers = many(rel(c, 'fares'))
      .map((f) => inc.fares && inc.fares[f.id])
      .filter((f) => f && f.attributes && Number.isFinite(f.attributes.price))
      .map((f) => {
        const fc = rel(f, 'fare_class');
        const cls = fc && inc.fare_classes && inc.fare_classes[fc.id];
        return {
          offer_id: text(f.attributes.offer_id, 200),
          fare_class: text(cls && cls.attributes && cls.attributes.name) || text(fc && fc.id, 80),
          price: money(f.attributes.price, currency),
          booked_out: f.attributes.booked_out === true,
          seats_left: Number.isFinite(f.attributes.seats_left) ? f.attributes.seats_left : null,
          passenger_ids: (Array.isArray(f.attributes.passenger_ids) ? f.attributes.passenger_ids : []).map((p) => text(p, 80)).filter(Boolean),
          expires_at: text(f.attributes.offer_expires_at, 40),
        };
      });
    const open = offers.filter((o) => !o.booked_out && o.offer_id && o.price).sort((x, y) => x.price.amount - y.price.amount);
    // GAP: whether a fare's `price` covers all its passenger_ids or one. The docs' fares are
    // "collective" (one offer for the listed passengers), so we show it as the party's price.
    return journeyOption({
      mode: MODE_OF[code] || 'train',
      provider: 'distribusion',
      id: c.id,
      from: { name: stationName(dep && dep.id), code: dep && dep.id },
      to: { name: stationName(arr && arr.id), code: arr && arr.id },
      depart: a.departure_time, // local station time, no offset
      arrive: a.arrival_time,
      duration_min: Number.isFinite(a.duration) ? a.duration / 60 : null,
      operator: (mc && mc.attributes && (mc.attributes.trade_name || mc.attributes.legal_name)) || (carrier && carrier.id) || null,
      price: open.length ? open[0].price : null,
      price_kind: 'bookable',
      book_url: null,
      booked_out: a.booked_out === true,
      offers: open,
      source: 'Distribusion',
      checked_at: checkedAt,
    });
  });
}

function cleanPassengers(list, { detailed = false } = {}) {
  if (!Array.isArray(list) || !list.length || list.length > 9) throw new GroundError('bad_request', 'passengers: 1 to 9 of them.');
  return list.map((p) => {
    if (!p || !PAX_ID.test(String(p.id || '')) || !PAX_TYPE.test(String(p.type || ''))) throw new GroundError('bad_request', 'each passenger needs the id and type from the search.');
    const out = { id: p.id, type: p.type };
    if (detailed) {
      if (!text(p.first_name, 80) || !text(p.last_name, 80)) throw new GroundError('bad_request', 'each passenger needs a first and last name.');
      out.first_name = text(p.first_name, 80);
      out.last_name = text(p.last_name, 80);
      if (p.birthdate !== undefined) {
        if (!DATE.test(String(p.birthdate))) throw new GroundError('bad_request', 'birthdate must be YYYY-MM-DD.');
        out.birthdate = p.birthdate;
      }
    } else out.pax = Number.isInteger(p.pax) && p.pax > 0 ? p.pax : 1;
    return out;
  });
}
function cleanOffers(list) {
  if (!Array.isArray(list) || !list.length || list.length > 4) throw new GroundError('bad_request', 'offers: the offer ids from the search.');
  return list.map((o) => {
    if (!o || !OFFER_ID.test(String(o.id || ''))) throw new GroundError('bad_request', 'an offer id from the search is needed.');
    const ids = Array.isArray(o.passenger_ids) ? o.passenger_ids : [];
    if (!ids.every((p) => PAX_ID.test(String(p)))) throw new GroundError('bad_request', 'passenger_ids must come from the search.');
    return { id: o.id, passenger_ids: ids };
  });
}

// The reservation resource → ours (no passenger details echoed back).
function reservation(out, checkedAt) {
  const d = out && out.data;
  if (!d || !d.attributes) throw new GroundError('unavailable', 'Distribusion sent no reservation.');
  const a = d.attributes;
  const currency = out.meta && out.meta.currency;
  return {
    reservation_id: text(d.id, 80),
    state: text(a.state, 40),
    total_price: money(a.total_price, currency),
    created_at: text(a.created_at, 40),
    expires_at: text(a.expires_at, 40),
    confirmed_at: text(a.confirmed_at, 40),
    processing_deadline: text(a.processing_deadline, 40),
    carrier_refs: (Array.isArray(a.marketing_carrier_reservation_ids) ? a.marketing_carrier_reservation_ids : []).map((r) => text(r, 80)).filter(Boolean),
    source: 'Distribusion',
    checked_at: checkedAt,
  };
}

/** Trains and buses, or null when Distribusion isn't set up. */
export function railFor(env = {}, { fetch: fetcher = globalThis.fetch, now = () => Date.now() } = {}) {
  const key = typeof env.DISTRIBUSION_API_KEY === 'string' ? env.DISTRIBUSION_API_KEY.trim() : '';
  if (env.EDEN_RAIL !== '1' || !key) return null;
  const base = env.DISTRIBUSION_ENV === 'production' ? DISTRIBUSION_BASE.production : DISTRIBUSION_BASE.demo;
  const stamp = () => new Date(now()).toISOString();
  const call = async (method, path, body) => {
    const headers = { 'Api-Key': key, accept: 'application/json' };
    if (body) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await fetcher(`${base}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(TIMEOUT) });
    } catch {
      throw new GroundError('unavailable', 'Distribusion did not answer in time.');
    }
    if (res.status === 401 || res.status === 403) throw new GroundError('unavailable', 'Distribusion refused the key.');
    if (res.status === 404) throw new GroundError('not_found', 'Distribusion has nothing for that.');
    if (res.status === 429) throw new GroundError('rate_limited', 'Distribusion is over its rate limit for now.');
    if (res.status === 400 || res.status === 422) {
      // errors: [{ code, title, detail }] (the docs' 400 examples)
      let said = '';
      try {
        const e = (await res.json()).errors[0];
        said = text(e.detail || e.title) || '';
      } catch { /* no body */ }
      throw new GroundError('bad_request', `Distribusion: ${said || 'the request was refused'}.`);
    }
    if (!res.ok) throw new GroundError('unavailable', `Distribusion answered ${res.status}.`);
    return res.json();
  };
  return {
    mode: 'rail',
    env: base === DISTRIBUSION_BASE.production ? 'production' : 'demo',
    /**
     * Stations whose name or code matches. GET /stations has no text filter (locale, page[size]
     * 1–1000, page[after], filter[marketing_carrier_codes][]), so we read one page of 1000 and
     * match here. GAP: the docs don't show where the next page[after] cursor comes back, so only
     * the first 1000 stations are searched.
     */
    async stations(query, { locale = 'en' } = {}) {
      const q = String(query || '').toLowerCase().trim();
      if (q.length < 2 || q.length > 100) throw new GroundError('bad_request', 'Give a station or city name.');
      if (!LOCALE.test(locale)) throw new GroundError('bad_request', 'locale is two letters, like en.');
      const out = await call('GET', `/stations?locale=${locale}&page%5Bsize%5D=1000`);
      // GAP: the docs show one station resource as the 200 body; JSON:API lists come in `data`
      const list = Array.isArray(out && out.data) ? out.data : Array.isArray(out) ? out : out && out.data ? [out.data] : [];
      const at = stamp();
      return list
        .filter((s) => s && s.attributes && [s.attributes.name, s.attributes.code].some((v) => String(v || '').toLowerCase().includes(q)))
        .slice(0, 20)
        .map((s) => {
          const city = rel(s, 'city');
          return { code: text(s.attributes.code || s.id, 20), name: text(s.attributes.name), kind: text(s.attributes.station_type, 40), time_zone: text(s.attributes.time_zone, 60), lat: Number.isFinite(s.attributes.latitude) ? s.attributes.latitude : null, lng: Number.isFinite(s.attributes.longitude) ? s.attributes.longitude : null, city_code: text(city && city.id, 20), source: 'Distribusion', checked_at: at };
        });
    },
    /** One-way connections between two station codes on a day: bookable journey options. */
    async search({ from_station, to_station, date, adults = 1, currency = 'EUR', locale = 'en' } = {}) {
      const a = Number(adults);
      if (!STATION.test(String(from_station || '')) || !STATION.test(String(to_station || ''))) throw new GroundError('bad_request', 'Stations are 8-character Distribusion codes, like FRPARPGN.');
      if (!DATE.test(String(date || ''))) throw new GroundError('bad_request', 'date must be YYYY-MM-DD.');
      if (!Number.isInteger(a) || a < 1 || a > 9) throw new GroundError('bad_request', 'adults must be 1 to 9.');
      if (!CURRENCY.test(currency) || !LOCALE.test(locale)) throw new GroundError('bad_request', 'currency is ISO 4217 (EUR), locale two letters (en).');
      const out = await call('POST', '/connections/find', {
        locale,
        currency,
        search_bounds: [{ is_requested: true, departure_date: date, departure_location: { type: 'stations', value: [from_station] }, arrival_location: { type: 'stations', value: [to_station] } }],
        passengers: [{ pax: a, max_age: ADULT_AGE }],
      });
      return railOptions(out, { checkedAt: stamp() });
    },
    /**
     * Is the offer still there, at what price, and what will booking ask for?
     * offers: [{ id, passenger_ids }], passengers: [{ id, type, pax }] (ids and types from the search).
     */
    async vacancy({ offers, passengers, currency = 'EUR', locale = 'en' } = {}) {
      if (!CURRENCY.test(currency) || !LOCALE.test(locale)) throw new GroundError('bad_request', 'currency is ISO 4217 (EUR), locale two letters (en).');
      const out = await call('POST', '/connections/vacancy', { locale, currency, offers: cleanOffers(offers), passengers: cleanPassengers(passengers) });
      const d = (out && out.data) || {};
      const inc = index(out && out.included);
      const at = stamp();
      if (!d.attributes || d.attributes.vacant !== true) {
        const why = rel(d, 'reason');
        return { vacant: false, reason: text((why && why.id) || null, 80), source: 'Distribusion', checked_at: at };
      }
      // required_attributes: per booking step, the fields it needs ({ endpoint, mandatory[] })
      const needs = (type) => Object.values(inc[type] || {}).map((r) => ({ endpoint: text(r.attributes && r.attributes.endpoint, 60), mandatory: (r.attributes && Array.isArray(r.attributes.mandatory) ? r.attributes.mandatory : []).map((m) => text(m, 60)).filter(Boolean) }));
      return {
        vacant: true,
        total_price: money(d.attributes.total_price, out.meta && out.meta.currency),
        required: needs('required_attributes'),
        passenger_required: needs('passenger_required_attributes'),
        source: 'Distribusion',
        checked_at: at,
      };
    },
    /**
     * Hold the offer: POST /reservations/create. Nothing is paid or ticketed yet; the reservation
     * expires (expires_at) unless confirmed. Sends the traveller's email and names, so only call it
     * from the traveller's own booking step.
     */
    async reserve({ email, offers, passengers } = {}) {
      if (!EMAIL.test(String(email || '')) || String(email).length > 200) throw new GroundError('bad_request', 'A valid email is needed to reserve.');
      const out = await call('POST', '/reservations/create', { email, offers: cleanOffers(offers), passengers: cleanPassengers(passengers, { detailed: true }) });
      return reservation(out, stamp());
    },
    /**
     * Book it: PUT /reservations/confirm. Throws before any request unless { confirm: true }.
     * terms_accepted must be the traveller's own acceptance of the carrier's terms, passed as true.
     * GAP: the docs list execute_payment (example false) and payment_method (example "demand_note")
     * without saying what the values do, so they're sent only if the caller sets them; the docs'
     * body also has one field with no name, which we leave out.
     */
    async confirm(details = {}, { confirm } = {}) {
      if (confirm !== true) throw new GroundError('bad_request', 'Booking needs the traveller’s explicit yes (confirm: true).');
      const d = details || {};
      if (!/^[A-Z0-9]{4,20}$/.test(String(d.reservation_id || ''))) throw new GroundError('bad_request', 'reservation_id from reserve() is needed.');
      if (d.terms_accepted !== true) throw new GroundError('bad_request', 'The traveller has to accept the carrier’s terms first.');
      if (!EMAIL.test(String(d.email || ''))) throw new GroundError('bad_request', 'A valid email is needed to book.');
      if (!text(d.first_name, 80) || !text(d.last_name, 80)) throw new GroundError('bad_request', 'The lead passenger’s first and last name are needed.');
      const body = { reservation_id: d.reservation_id, first_name: text(d.first_name, 80), last_name: text(d.last_name, 80), email: d.email, terms_accepted: true, passengers: cleanPassengers(d.passengers, { detailed: true }) };
      if (d.title !== undefined) body.title = text(d.title, 20);
      if (d.phone !== undefined) body.phone = text(d.phone, 40);
      if (typeof d.send_customer_email === 'boolean') body.send_customer_email = d.send_customer_email;
      if (typeof d.execute_payment === 'boolean') body.execute_payment = d.execute_payment;
      if (d.payment_method !== undefined) body.payment_method = text(d.payment_method, 40);
      const out = await call('PUT', '/reservations/confirm', body);
      return reservation(out, stamp());
    },
  };
}
