// Eden Travel's live flight status: FlightAware AeroAPI v4 (field names from FlightAware's own
// OpenAPI spec, 4.17.1, read 2026-10-26). Off until the Worker has FLIGHTAWARE_API_KEY (a secret,
// sent only in the x-apikey header, never logged). Each lookup is billed per result set
// (GET /flights/{ident}: $0.005 on the price page, 2026-10-26), so answers are cached
// (CACHE_MS) and the caller is rate-limited. Business use needs AeroAPI Standard or above:
// the Personal tier is for personal or academic use only.

const BASE = 'https://aeroapi.flightaware.com/aeroapi';
const TIMEOUT = 8000;
export const CACHE_MS = 2 * 60_000;
export const POSITION_MS = 5 * 60_000; // a live position: $0.010 a look (price page, 2026-10-26), so at most one per 5 minutes per flight
export const AIRPORT_MS = 30 * 86400_000; // airports don't move: $0.015 a look, kept a month
const IDENT = /^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/; // a designator: TP1351, BA2, U2-style codes after cleaning
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class FlightError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const cleanIdent = (v) => String(v || '').toUpperCase().replace(/[\s-]/g, '');

/** The tracker, or null when FlightAware isn't set up. */
export function flightAwareFor(env = {}, { fetch: fetcher = globalThis.fetch, now = () => Date.now() } = {}) {
  const key = typeof env.FLIGHTAWARE_API_KEY === 'string' ? env.FLIGHTAWARE_API_KEY.trim() : '';
  if (!key) return null;
  const get = async (path) => {
    let res;
    try {
      res = await fetcher(`${BASE}${path}`, { headers: { 'x-apikey': key, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
    } catch {
      throw new FlightError('unavailable', 'FlightAware did not answer in time.');
    }
    if (res.status === 401 || res.status === 403) throw new FlightError('unavailable', 'FlightAware refused the key.');
    if (res.status === 429) throw new FlightError('rate_limited', 'FlightAware is over its rate limit for now.');
    if (res.status === 404) throw new FlightError('not_found', 'FlightAware has nothing for that.');
    if (!res.ok) throw new FlightError('unavailable', `FlightAware answered ${res.status}.`);
    return res.json();
  };
  return {
    /** Where the plane is now: { lat, lng, heading, altitude_ft, speed_kts, at }, or null before it has a position. */
    async position(faId) {
      if (!/^[A-Za-z0-9-]{6,80}$/.test(String(faId || ''))) throw new FlightError('bad_ident', 'That isn’t a FlightAware flight id.');
      const out = await get(`/flights/${encodeURIComponent(faId)}/position`);
      const p = out && out.last_position;
      if (!p || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) return null;
      return { lat: p.latitude, lng: p.longitude, heading: Number.isFinite(p.heading) ? p.heading : null, altitude_ft: Number.isFinite(p.altitude) ? p.altitude * 100 : null, speed_kts: Number.isFinite(p.groundspeed) ? p.groundspeed : null, at: p.timestamp || null };
    },
    /** An airport's point: { code, name, lat, lng }. */
    async airport(code) {
      const c = String(code || '').toUpperCase();
      if (!/^[A-Z0-9]{3,4}$/.test(c)) throw new FlightError('bad_ident', 'An airport code looks like LIS or LPPT.');
      const a = await get(`/airports/${c}`);
      return { code: a.code_iata || a.airport_code || c, name: a.name || null, lat: a.latitude, lng: a.longitude };
    },
    /** One flight on one day (the departure's local date): our summary, or a FlightError. */
    async track(identRaw, date) {
      const ident = cleanIdent(identRaw);
      if (!IDENT.test(ident)) throw new FlightError('bad_ident', 'A flight number looks like TP1351 or BA2.');
      if (!DATE.test(String(date || ''))) throw new FlightError('bad_date', 'date must be the departure day, YYYY-MM-DD.');
      // the day either side, since "the departure day" is local and AeroAPI's window is UTC
      const day = Date.parse(`${date}T00:00:00Z`);
      const start = new Date(day - 86400_000).toISOString().slice(0, 10);
      const end = new Date(day + 2 * 86400_000).toISOString().slice(0, 10);
      let res;
      try {
        res = await fetcher(`${BASE}/flights/${encodeURIComponent(ident)}?ident_type=designator&start=${start}&end=${end}`, { headers: { 'x-apikey': key, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
      } catch {
        throw new FlightError('unavailable', 'FlightAware did not answer in time.');
      }
      if (res.status === 401 || res.status === 403) throw new FlightError('unavailable', 'FlightAware refused the key.');
      if (res.status === 429) throw new FlightError('rate_limited', 'FlightAware is over its rate limit for now.');
      if (res.status === 404) throw new FlightError('not_found', `FlightAware has no flight ${ident} around ${date}.`);
      if (!res.ok) throw new FlightError('unavailable', `FlightAware answered ${res.status}.`);
      const out = await res.json();
      const flights = Array.isArray(out.flights) ? out.flights : [];
      const pick = pickFlight(flights, date);
      if (!pick) throw new FlightError('not_found', `FlightAware has no flight ${ident} departing ${date}.`);
      return summary(pick, new Date(now()).toISOString());
    },
  };
}

// The flight that departs on `date` in its origin's own time zone (else the nearest scheduled one).
export function pickFlight(flights, date) {
  const localDay = (iso, tz) => { try { return new Date(iso).toLocaleDateString('en-CA', { timeZone: tz || 'UTC' }); } catch { return String(iso).slice(0, 10); } };
  const dated = flights.filter((f) => f.scheduled_out);
  return dated.find((f) => localDay(f.scheduled_out, f.origin && f.origin.timezone) === date)
    || dated.sort((a, b) => Math.abs(Date.parse(a.scheduled_out) - Date.parse(`${date}T12:00:00Z`)) - Math.abs(Date.parse(b.scheduled_out) - Date.parse(`${date}T12:00:00Z`)))[0]
    || null;
}

const airport = (a) => (a ? { code: a.code_iata || a.code_icao || a.code || null, name: a.name || null, city: a.city || null, tz: a.timezone || null } : null);
const min = (s) => (Number.isFinite(s) ? Math.round(s / 60) : null);

/** AeroAPI's flight → what Eden shows (and what the share page may show: no passenger data is in it). */
export function summary(f, checkedAt) {
  const state = f.cancelled ? 'cancelled' : f.diverted ? 'diverted' : f.actual_in || f.actual_on ? 'landed' : f.actual_off || f.actual_out ? 'in_air' : (f.departure_delay || 0) >= 15 * 60 ? 'delayed' : 'scheduled';
  return {
    ident: f.ident_iata || f.ident,
    fa_flight_id: f.fa_flight_id || null,
    operator: f.operator_iata || f.operator || null,
    origin: airport(f.origin),
    destination: airport(f.destination),
    departure: { scheduled: f.scheduled_out || null, estimated: f.estimated_out || null, actual: f.actual_out || null, gate: f.gate_origin || null, terminal: f.terminal_origin || null },
    arrival: { scheduled: f.scheduled_in || null, estimated: f.estimated_in || null, actual: f.actual_in || null, gate: f.gate_destination || null, terminal: f.terminal_destination || null, baggage: f.baggage_claim || null },
    delay_minutes: { departure: min(f.departure_delay), arrival: min(f.arrival_delay) },
    state,
    status: f.status || null, // FlightAware's own words ("En Route / On Time")
    progress: Number.isFinite(f.progress_percent) && f.progress_percent >= 0 ? f.progress_percent : null,
    source: 'FlightAware AeroAPI',
    checked_at: checkedAt,
  };
}
