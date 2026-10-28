// Eden Travel's one door to maps data (research_notes/travel/HANDOFF.md): a place's hours and
// status, and the travel time between two places. Google when the Worker has its key
// (GOOGLE_MAPS_SERVER_KEY: Places API (New) and Routes API, a key restricted to those two);
// until then a stand-in: a few Lisbon places with sample hours and straight-line travel times.
//
// Every answer carries where it came from and when (`source`, `checked_at`), and stand-in
// answers say so (`standin: true`), so a badge never shows a sample as a checked fact.
// Nothing here is cached (checks.js, discover.js and plan.js cache in the account's object). Every paid call asks the
// account's meter first (spend.js: counted by Google SKU, refused past a cap → MapsError 'capped'); the Places and
// Routes quotas are also set in the Google Cloud console (daily caps and a $25 budget alert, per the handoff).

import { placesSku } from './spend.js';

const PLACES = 'https://places.googleapis.com/v1';
const ROUTES = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const BASE_FIELDS = 'id,displayName,formattedAddress,location,businessStatus,regularOpeningHours,utcOffsetMinutes,priceLevel,googleMapsUri,photos,accessibilityOptions,websiteUri';
// + the country (addressComponents: Essentials) and the next 7 days' actual hours with their special days
// (currentOpeningHours: Enterprise, the tier regularOpeningHours already bills), for date-specific checks (holidays.js).
// Field tiers read 2026-10-28: https://developers.google.com/maps/documentation/places/web-service/data-fields
const PLACE_FIELDS = `${BASE_FIELDS},addressComponents,currentOpeningHours`;
// a place in two parts, each cached for its own time (checks.js): what hardly changes (name, where, its access: Pro SKU),
// and what does (status and hours: Enterprise SKU, so the website, price level, photo and country, Enterprise or less,
// ride along at no extra cost)
const STABLE_FIELDS = 'id,displayName,formattedAddress,location,googleMapsUri,accessibilityOptions';
const HOURS_FIELDS = 'id,businessStatus,regularOpeningHours,currentOpeningHours,utcOffsetMinutes,priceLevel,websiteUri,photos,addressComponents';
const PART_FIELDS = { all: PLACE_FIELDS, stable: STABLE_FIELDS, hours: HOURS_FIELDS };
// for Discover and Near me (discover.js): the place, its rating, and whether it is open right now (not the week)
const RATED_FIELDS = `${BASE_FIELDS},rating,userRatingCount,currentOpeningHours.openNow,currentOpeningHours.nextCloseTime,primaryTypeDisplayName,editorialSummary`;
const MATRIX = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
const ROUTE_FIELDS = 'routes.duration,routes.distanceMeters';
const TRANSIT_FIELDS = 'routes.legs.steps.travelMode,routes.legs.steps.transitDetails';
const TIMEOUT = 8000;
const PHOTO_NAME = /^places\/[A-Za-z0-9_-]{10,300}\/photos\/[A-Za-z0-9_-]{10,1000}$/;

export const MODES = ['walk', 'transit', 'drive', 'taxi'];
const GOOGLE_MODE = { walk: 'WALK', transit: 'TRANSIT', drive: 'DRIVE', taxi: 'DRIVE' };
// Stand-in speeds (km/h over the straight line, which undercounts streets and hills) and a fixed
// wait for each mode: rough on purpose, and labelled as samples.
const STANDIN_SPEED = { walk: 4, transit: 14, drive: 22, taxi: 22 };
const STANDIN_WAIT = { walk: 0, transit: 8, drive: 5, taxi: 6 };
const STANDIN_SOURCE = 'Stand-in sample data: no live maps yet';

// Weekly hours as Google gives them: day 0 = Sunday, times in the place's local time.
const daily = (open, close, days = [0, 1, 2, 3, 4, 5, 6]) => days.map((day) => ({ day, open, close }));
const STANDIN = {
  'standin:jeronimos': { name: 'Jerónimos Monastery', area: 'Belém', lat: 38.6979, lng: -9.2068, hours: daily('09:30', '18:00', [0, 2, 3, 4, 5, 6]), price: { amount: 12, currency: 'EUR', per: 'person' } },
  'standin:tiles': { name: 'National Tile Museum', area: 'Xabregas', lat: 38.7247, lng: -9.1135, hours: daily('10:00', '18:00', [0, 2, 3, 4, 5, 6]), price: { amount: 10, currency: 'EUR', per: 'person' } },
  'standin:lx-factory': { name: 'LX Factory', area: 'Alcântara', lat: 38.7034, lng: -9.1785, hours: daily('09:00', '23:59') },
  'standin:time-out-market': { name: 'Time Out Market', area: 'Cais do Sodré', lat: 38.7071, lng: -9.1458, hours: daily('10:00', '23:59') },
  'standin:carmo': { name: 'Carmo Convent ruins', area: 'Chiado', lat: 38.7120, lng: -9.1405, hours: daily('10:00', '18:00', [1, 2, 3, 4, 5, 6]), price: { amount: 5, currency: 'EUR', per: 'person' } },
  'standin:graca': { name: 'Miradouro da Graça', area: 'Graça', lat: 38.7163, lng: -9.1309, hours: null },
  'standin:pasteis-belem': { name: 'Pastéis de Belém', area: 'Belém', lat: 38.6975, lng: -9.2032, hours: daily('08:00', '23:00') },
  'standin:maat': { name: 'MAAT', area: 'Belém', lat: 38.6957, lng: -9.1946, hours: daily('10:00', '19:00', [0, 1, 3, 4, 5, 6]), price: { amount: 11, currency: 'EUR', per: 'person' } },
  'standin:gulbenkian': { name: 'Gulbenkian Museum', area: 'Avenidas Novas', lat: 38.7372, lng: -9.1545, hours: daily('10:00', '18:00', [0, 1, 3, 4, 5, 6]), price: { amount: 10, currency: 'EUR', per: 'person' } },
  'standin:castle': { name: 'São Jorge Castle', area: 'Castelo', lat: 38.7139, lng: -9.1335, hours: daily('09:00', '21:00'), price: { amount: 15, currency: 'EUR', per: 'person' } },
  'standin:oceanario': { name: 'Oceanário de Lisboa', area: 'Parque das Nações', lat: 38.7636, lng: -9.0937, hours: daily('10:00', '20:00'), price: { amount: 25, currency: 'EUR', per: 'person' } },
  'standin:baixa-hotel': { name: 'A hotel in Baixa', area: 'Baixa', lat: 38.7118, lng: -9.1384, hours: null },
  'standin:chiado': { name: 'A restaurant in Chiado', area: 'Chiado', lat: 38.7107, lng: -9.1422, hours: daily('12:00', '23:00') },
  'standin:chiado-cafe': { name: 'A café in Chiado', area: 'Chiado', lat: 38.7105, lng: -9.1410, hours: daily('08:00', '20:00') },
  'standin:alfama': { name: 'A restaurant in Alfama', area: 'Alfama', lat: 38.7110, lng: -9.1300, hours: daily('12:00', '22:30', [1, 2, 3, 4, 5, 6]) },
  'standin:principe-real': { name: 'A café in Príncipe Real', area: 'Príncipe Real', lat: 38.7167, lng: -9.1484, hours: daily('08:00', '19:00') },
  'standin:lis-airport': { name: 'Lisbon airport', area: 'Lisbon', lat: 38.7742, lng: -9.1342, hours: null },
};

const LISBON = { lat: 38.7223, lng: -9.1393 };
const GENERIC = new Set(['hotel', 'hotels', 'restaurant', 'restaurants', 'cafe', 'cafes', 'coffee', 'dinner', 'lunch', 'breakfast', 'museum', 'airport', 'market', 'the', 'and', 'your', 'near', 'stay', 'old', 'town', 'city', 'centre', 'center']);
export class MapsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// The maps this Worker has: google when the key is set, else the stand-in.
// `meter` (spend.js spendMeter): asked before each paid call; none, nothing is counted or capped.
export function mapsFor(env = {}, { fetch: fetcher = globalThis.fetch, now = () => Date.now(), meter = null } = {}) {
  const key = typeof env.GOOGLE_MAPS_SERVER_KEY === 'string' ? env.GOOGLE_MAPS_SERVER_KEY.trim() : '';
  return key ? googleMaps(key, fetcher, now, meter) : standinMaps(now);
}

export function standinMaps(now = () => Date.now()) {
  const stamp = () => new Date(now()).toISOString();
  const view = (id) => {
    const p = STANDIN[id];
    if (!p) return null;
    return { id, name: p.name, address: `${p.area}, Lisbon`, lat: p.lat, lng: p.lng, status: 'open', hours: p.hours, price: p.price || null, standin: true, source: STANDIN_SOURCE, checked_at: stamp() };
  };
  return {
    mode: 'standin',
    async place(id) {
      const p = view(String(id));
      if (!p) throw new MapsError('not_found', `No stand-in place ${id}. Stand-in ids: ${Object.keys(STANDIN).join(', ')}.`);
      return p;
    },
    // the samples are all in Lisbon: never an answer for anywhere else (a Tokyo "hotel" once became "A hotel in Baixa"), and
    // a generic word alone (hotel, restaurant, café) matches nothing unless the search is about Lisbon
    async search(text, near = {}) {
      if (Number.isFinite(near && near.lat) && distanceKm(near, LISBON) > 100) return [];
      const words = String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\W+/).filter((w) => w.length > 2);
      const lisbon = words.some((w) => w === 'lisbon' || w === 'lisboa') || Number.isFinite(near && near.lat);
      if (!lisbon && !words.some((w) => !GENERIC.has(w))) return [];
      const plain = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      return Object.keys(STANDIN)
        .map((id) => ({ id, hits: words.filter((w) => (lisbon || !GENERIC.has(w)) && plain(`${STANDIN[id].name} ${STANDIN[id].area}`).includes(w)).length }))
        .filter((r) => r.hits > 0)
        .sort((a, b) => b.hits - a.hits)
        .slice(0, 5)
        .map((r) => view(r.id));
    },
    async travel(from, to, mode = 'walk') {
      const km = distanceKm(from, to);
      const m = MODES.includes(mode) ? mode : 'walk';
      const minutes = km < 0.05 ? 0 : Math.max(2, Math.round((km * 1.3 * 60) / STANDIN_SPEED[m] + STANDIN_WAIT[m]));
      return { minutes, meters: Math.round(km * 1300), mode: m, standin: true, source: STANDIN_SOURCE, checked_at: stamp() };
    },
    async explore(text) { return (await this.search(text)).map((p) => ({ ...p, rating: null, ratings: null })); },
    async nearby(at, { radius = 1500 } = {}) {
      return Object.keys(STANDIN).map(view).filter((p) => p.hours && distanceKm(at, p) * 1000 <= radius).map((p) => ({ ...p, open_now: null, rating: null, ratings: null }));
    },
    async matrix(origins, destinations, mode = 'walk') {
      const out = [];
      for (let i = 0; i < origins.length; i++) for (let j = 0; j < destinations.length; j++) out.push({ from: i, to: j, ...(await this.travel(origins[i], destinations[j], mode)) });
      return out;
    },
  };
}

// a cap reached (spend.js): no call made; `reason` open|account|global
export async function metered(meter, sku, n = 1) {
  const no = meter ? await meter.take(sku, n) : null;
  if (no) { const e = new MapsError('capped', no.note); e.reason = no.reason; throw e; }
}

function googleMaps(key, fetcher, now, meter) {
  const call = async (url, init, sku, n = 1) => {
    await metered(meter, sku, n);
    let res;
    try {
      res = await fetcher(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
    } catch {
      throw new MapsError('unavailable', 'Google Maps did not answer in time.');
    }
    if (res.status === 404) throw new MapsError('not_found', 'Google Maps has no such place.');
    if (res.status === 429) throw new MapsError('rate_limited', 'Google Maps is over its quota for now.');
    if (!res.ok) throw new MapsError('unavailable', `Google Maps answered ${res.status}.`);
    return await res.json();
  };
  const headers = (fields) => ({ 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': fields });
  const placeView = (g) => fromGooglePlace(g, new Date(now()).toISOString());
  const ratedView = (g) => ({ ...placeView(g), rating: Number.isFinite(g.rating) ? g.rating : null, ratings: Number.isInteger(g.userRatingCount) ? g.userRatingCount : null, open_now: typeof g.currentOpeningHours?.openNow === 'boolean' ? g.currentOpeningHours.openNow : null, closes_at: g.currentOpeningHours?.nextCloseTime || null, type: g.primaryTypeDisplayName?.text || null, about: g.editorialSummary?.text || null });
  return {
    mode: 'google',
    // part: all (one call), or stable / hours (checks.js refreshes each on its own clock)
    async place(id, { part = 'all' } = {}) {
      const pid = String(id || '');
      // a sample place (the Lisbon sample trip) stays a sample with live maps on: never shown as checked by Google
      if (pid.startsWith('standin:') && STANDIN[pid]) return standinMaps(now).place(pid);
      if (!/^[A-Za-z0-9_-]{10,300}$/.test(pid)) throw new MapsError('not_found', 'That is not a Google place id.');
      const fields = PART_FIELDS[part] || PLACE_FIELDS;
      const p = placeView(await call(`${PLACES}/places/${pid}`, { headers: headers(fields) }, placesSku('details', fields)));
      p.part = PART_FIELDS[part] ? part : 'all';
      return p;
    },
    async search(text, { lat, lng } = {}) {
      const body = { textQuery: String(text || '').slice(0, 200), pageSize: 5 };
      if (Number.isFinite(lat) && Number.isFinite(lng)) body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: 20000 } };
      const mask = PLACE_FIELDS.split(',').map((f) => `places.${f}`).join(',');
      const out = await call(`${PLACES}/places:searchText`, { method: 'POST', headers: headers(mask), body: JSON.stringify(body) }, placesSku('text', mask));
      return (out.places || []).map(placeView);
    },
    // places by words, with their ratings and whether they're open now (Discover)
    async explore(text, { lat, lng } = {}) {
      const body = { textQuery: String(text || '').slice(0, 200), pageSize: 12 };
      if (Number.isFinite(lat) && Number.isFinite(lng)) body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: 20000 } };
      const mask = RATED_FIELDS.split(',').map((f) => `places.${f}`).join(',');
      const out = await call(`${PLACES}/places:searchText`, { method: 'POST', headers: headers(mask), body: JSON.stringify(body) }, placesSku('text', mask));
      return (out.places || []).map(ratedView);
    },
    // places of these Google types around a point, nearest first (Near me)
    async nearby(at, { types = [], radius = 1500 } = {}) {
      const body = { maxResultCount: 20, rankPreference: 'DISTANCE', locationRestriction: { circle: { center: { latitude: at.lat, longitude: at.lng }, radius: Math.min(5000, Math.max(100, radius)) } } };
      if (types.length) body.includedTypes = types.slice(0, 10);
      const mask = RATED_FIELDS.split(',').map((f) => `places.${f}`).join(',');
      const out = await call(`${PLACES}/places:searchNearby`, { method: 'POST', headers: headers(mask), body: JSON.stringify(body) }, placesSku('nearby', mask));
      return (out.places || []).map(ratedView);
    },
    // travel times from each origin to each destination in one call (Routes API computeRouteMatrix)
    async matrix(origins, destinations, mode = 'walk') {
      const m = MODES.includes(mode) ? mode : 'walk';
      const wp = (p) => ({ waypoint: p.id && !String(p.id).startsWith('standin:') ? { placeId: p.id } : { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
      const body = { origins: origins.map(wp), destinations: destinations.map(wp), travelMode: GOOGLE_MODE[m] };
      const out = await call(MATRIX, { method: 'POST', headers: headers('originIndex,destinationIndex,duration,distanceMeters,condition'), body: JSON.stringify(body) }, 'matrix_ess', Math.max(1, origins.length * destinations.length)); // billed per element
      const at = new Date(now()).toISOString();
      return (Array.isArray(out) ? out : []).filter((e) => e.condition === 'ROUTE_EXISTS').map((e) => ({ from: e.originIndex || 0, to: e.destinationIndex || 0, minutes: Math.round(parseInt(String(e.duration || '0'), 10) / 60), meters: e.distanceMeters || 0, mode: m, standin: false, source: 'Google Maps (Routes API)', checked_at: at }));
    },
    async travel(from, to, mode = 'walk', { departAt, lessWalking = false } = {}) {
      const m = MODES.includes(mode) ? mode : 'walk';
      const point = (p) => (p.id && !String(p.id).startsWith('standin:') ? { placeId: p.id } : { location: { latLng: { latitude: p.lat, longitude: p.lng } } });
      const body = { origin: point(from), destination: point(to), travelMode: GOOGLE_MODE[m] };
      if (m === 'drive' || m === 'taxi') body.routingPreference = 'TRAFFIC_AWARE';
      if (m === 'transit' && lessWalking) body.transitPreferences = { routingPreference: 'LESS_WALKING' }; // step-free trips (Google doesn't say which stations are step-free)
      if (departAt && (m === 'transit' || body.routingPreference) && Date.parse(departAt) > now()) body.departureTime = new Date(departAt).toISOString();
      // by transit, also the steps' lines (which tram, from which stop), for the day's connectors
      const fields = m === 'transit' ? `${ROUTE_FIELDS},${TRANSIT_FIELDS}` : ROUTE_FIELDS;
      const out = await call(ROUTES, { method: 'POST', headers: headers(fields), body: JSON.stringify(body) }, body.routingPreference ? 'routes_pro' : 'routes_ess');
      const r = (out.routes || [])[0];
      if (!r) throw new MapsError('no_route', `Google Maps found no ${m} route between those places.`);
      const t = { minutes: Math.round(parseInt(String(r.duration || '0'), 10) / 60), meters: r.distanceMeters || 0, mode: m, standin: false, source: 'Google Maps (Routes API)', checked_at: new Date(now()).toISOString() };
      if (m === 'transit') t.lines = transitLines(r);
      return t;
    },
  };
}

// Google's place → ours. Hours: regularOpeningHours.periods ({open:{day,hour,minute}, close:{…}});
// a place open all day has one period with no close.
// A transit route's rides, in order, from Routes API steps (RouteLegStep.transitDetails: transitLine { name, nameShort,
// vehicle { type, name { text } } }, stopDetails { departureStop { name }, arrivalStop { name }, departureTime },
// headsign, stopCount). Only the fields Google sent: a missing one stays out. No departure times: the route is asked for
// now, not for the hour of the trip, so its times would be for the wrong day.
//   → [{ vehicle, vehicle_type, name, headsign, from, to, stops }]
export function transitLines(route) {
  const out = [];
  for (const leg of route?.legs || []) {
    for (const step of leg?.steps || []) {
      const t = step?.transitDetails;
      if (!t || typeof t !== 'object') continue;
      const line = t.transitLine || {}, v = line.vehicle || {}, sd = t.stopDetails || {};
      const ride = {
        vehicle: v.name?.text || v.type,
        vehicle_type: v.type,
        name: line.nameShort || line.name,
        headsign: t.headsign,
        from: sd.departureStop?.name,
        to: sd.arrivalStop?.name,
        stops: Number.isInteger(t.stopCount) ? t.stopCount : undefined,
      };
      out.push(Object.fromEntries(Object.entries(ride).filter(([, x]) => x !== undefined && x !== null && x !== '').map(([k, x]) => [k, typeof x === 'string' ? x.slice(0, 120) : x])));
    }
  }
  return out;
}

export function fromGooglePlace(g, checkedAt) {
  const two = (n) => String(n ?? 0).padStart(2, '0');
  const at = (t) => `${two(t.hour)}:${two(t.minute)}`;
  const periods = g.regularOpeningHours?.periods;
  let hours = null;
  if (Array.isArray(periods) && periods.length) {
    hours = periods.length === 1 && !periods[0].close
      ? [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '00:00', close: '23:59' }))
      : periods.filter((p) => p.open && p.close).map((p) => ({ day: p.open.day, open: at(p.open), close: at(p.close) }));
  }
  const status = { OPERATIONAL: 'open', CLOSED_TEMPORARILY: 'closed_temporarily', CLOSED_PERMANENTLY: 'closed_permanently' }[g.businessStatus] || 'unknown';
  return {
    id: g.id,
    name: g.displayName?.text || 'Unnamed place',
    address: g.formattedAddress || '',
    lat: g.location?.latitude ?? null,
    lng: g.location?.longitude ?? null,
    status,
    hours,
    price: null, // Google gives a price level, not a price; prices come from the trip or a booking
    price_level: g.priceLevel || null,
    url: g.googleMapsUri || null,
    website: /^https?:\/\//.test(g.websiteUri || '') ? g.websiteUri : null,
    // what Google lists of its access (true, false, or not said): for step-free trips
    access: g.accessibilityOptions ? { entrance: g.accessibilityOptions.wheelchairAccessibleEntrance ?? null, restroom: g.accessibilityOptions.wheelchairAccessibleRestroom ?? null, seating: g.accessibilityOptions.wheelchairAccessibleSeating ?? null, parking: g.accessibilityOptions.wheelchairAccessibleParking ?? null } : null,
    photo: photoOf(g.photos),
    ...countryOf(g.addressComponents),
    ...(weekOf(g, checkedAt) || {}),
    standin: false,
    source: 'Google Maps (Places API)',
    checked_at: checkedAt,
  };
}

// the place's country (ISO 3166-1 alpha-2, Google's addressComponents shortText of type 'country'): { country } or {}
function countryOf(parts) {
  const c = Array.isArray(parts) ? parts.find((x) => Array.isArray(x?.types) && x.types.includes('country')) : null;
  return c && /^[A-Z]{2}$/.test(c.shortText || '') ? { country: c.shortText } : {};
}

// The next 7 days' actual hours (currentOpeningHours: "the next seven days (including today) incorporating any special
// opening hours"; periods' points carry the place's local date; specialDays are the dates whose hours differ, e.g.
// Christmas). Read 2026-10-28: https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places
//   → { week: { from, to, days: { 'YYYY-MM-DD': [{ open, close }] }, special: ['YYYY-MM-DD'], closed_week } } or null
// Only from a full answer (weekdayDescriptions, one a day, come with it): Discover asks for openNow alone. Google leaves an
// empty periods list out, so no periods at all means closed every day of the window (closed_week: perhaps seasonal).
export function weekOf(g, checkedAt) {
  const c = g?.currentOpeningHours;
  if (!c || !Array.isArray(c.weekdayDescriptions) || !c.weekdayDescriptions.length) return null;
  const two = (n) => String(n ?? 0).padStart(2, '0');
  const ymd = (d) => (d && Number.isInteger(d.year) ? `${d.year}-${two(d.month)}-${two(d.day)}` : null);
  // the window starts on the place's local date when Google answered (its utcOffsetMinutes; else the UTC date)
  const t0 = Date.parse(checkedAt);
  if (!Number.isFinite(t0)) return null;
  const local = new Date(t0 + (Number.isFinite(g.utcOffsetMinutes) ? g.utcOffsetMinutes : 0) * 60_000);
  const dates = [0, 1, 2, 3, 4, 5, 6].map((i) => new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + i)).toISOString().slice(0, 10));
  const days = Object.fromEntries(dates.map((d) => [d, []]));
  const dateOf = (pt) => ymd(pt.date) || dates.find((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === pt.day) || null;
  const at = (pt) => `${two(pt.hour)}:${two(pt.minute)}`;
  const periods = Array.isArray(c.periods) ? c.periods.filter((p) => p && p.open) : [];
  if (periods.length === 1 && !periods[0].close) for (const d of dates) days[d].push({ open: '00:00', close: '23:59' }); // open all week
  else {
    for (const p of periods) {
      if (!p.close) continue;
      const od = dateOf(p.open), cd = dateOf(p.close);
      if (!od || !days[od]) continue;
      const open = at(p.open);
      let close = at(p.close);
      if (cd && cd !== od && close > open) close = '23:59'; // a period running into a later day: open to the day's end
      days[od].push({ open, close });
    }
  }
  const special = (Array.isArray(c.specialDays) ? c.specialDays : []).map((s) => ymd(s?.date)).filter((d) => d && days[d]);
  return { week: { from: dates[0], to: dates[6], days, special, closed_week: dates.every((d) => !days[d].length) } };
}

// the place's first Google photo: its resource name (fetched through the Worker, /api/chat/travel/photo) and who took
// it, which Google requires shown with it
function photoOf(photos) {
  const p = Array.isArray(photos) ? photos.find((x) => x && PHOTO_NAME.test(x.name || '')) : null;
  if (!p) return null;
  const by = (p.authorAttributions || [])[0] || {};
  return { name: p.name, by: by.displayName || null, by_url: /^https:\/\//.test(by.uri || '') ? by.uri : null };
}

export function distanceKm(a, b) {
  if (![a?.lat, a?.lng, b?.lat, b?.lng].every(Number.isFinite)) return 0;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export const STANDIN_IDS = Object.keys(STANDIN);

// ── the in-flight map's picture (Google Static Maps, fetched here so the key never reaches the page) ──

export const MAP_SIZE = { w: 640, h: 320, pad: 48 };
const STATIC = 'https://maps.googleapis.com/maps/api/staticmap';
const DARK = ['element:geometry|color:0x0b1a2e', 'element:labels|visibility:off', 'feature:water|element:geometry|color:0x050f1c', 'feature:administrative.country|element:geometry.stroke|color:0x2b4a70', 'feature:landscape|element:geometry|color:0x12253d', 'feature:road|visibility:off', 'feature:poi|visibility:off', 'feature:transit|visibility:off'];
const DAY_LIGHT = ['feature:poi.business|visibility:simplified', 'feature:water|element:geometry|color:0xa8d4f0', 'feature:landscape.natural|element:geometry|color:0xebeef2', 'feature:park|element:geometry|color:0xd8ead3'];
const DAY_DARK = ['element:geometry|color:0x1b222c', 'element:labels.text.fill|color:0xb0b8c4', 'element:labels.text.stroke|color:0x1b222c', 'feature:water|element:geometry|color:0x0d1b2a', 'feature:road|element:geometry|color:0x2c3545', 'feature:road.arterial|element:geometry|color:0x374254', 'feature:poi.park|element:geometry|color:0x1e2d24'];

/** Web Mercator world pixels at zoom z (256-pixel tiles), as Google draws them. */
export function worldPx(lat, lng, z) {
  const s = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
  const size = 256 * 2 ** z;
  return { x: ((lng + 180) / 360) * size, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size };
}
function fromWorld(x, y, z) {
  const size = 256 * 2 ** z;
  const lng = (x / size) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / size;
  return { lat: (180 / Math.PI) * Math.atan(Math.sinh(n)), lng };
}

/** The view that fits two points with room around them: { center, zoom } (zoom 1–10). */
export const fitView = (a, b, size = MAP_SIZE) => fitPoints([a, b], size);

/** The view that fits every point (a day's stops, a flight's two airports): { center, zoom }, zoom 1–16. */
export function fitPoints(points, { w, h, pad } = MAP_SIZE) {
  const first = points[0];
  // each point the short way round from the first (a route over the Pacific stays over the Pacific)
  const pts = points.map((p) => ({ lat: p.lat, lng: Math.abs(p.lng - first.lng) > 180 ? p.lng + (p.lng < first.lng ? 360 : -360) : p.lng }));
  const box = (z) => {
    const px = pts.map((p) => worldPx(p.lat, p.lng, z));
    const xs = px.map((p) => p.x), ys = px.map((p) => p.y);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };
  let zoom = 1;
  for (let z = pts.length === 1 ? 14 : 16; z >= 1; z--) {
    const b = box(z);
    if (b.x1 - b.x0 + 2 * pad <= w && b.y1 - b.y0 + 2 * pad <= h) { zoom = z; break; }
  }
  const b = box(zoom);
  const c = fromWorld((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, zoom);
  return { center: { lat: Math.round(c.lat * 1e5) / 1e5, lng: Math.round((((c.lng + 540) % 360) - 180) * 1e5) / 1e5 }, zoom };
}

const point = (v) => {
  const [lat, lng] = String(v || '').split(',').map(Number);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 85 && Math.abs(lng) <= 180 ? { lat, lng } : null;
};
/** GET /api/chat/travel/map?a=lat,lng&b=lat,lng (a flight) or ?p=lat,lng|lat,lng|… (a day's stops, up to 25)
 *  → the picture, with x-map-center and x-map-zoom for the page's overlay. */
export async function flightMapImage(env, url, { fetch: fetcher = globalThis.fetch, meter = null } = {}) {
  const key = typeof env.GOOGLE_MAPS_SERVER_KEY === 'string' ? env.GOOGLE_MAPS_SERVER_KEY.trim() : '';
  if (!key) throw new MapsError('not_set_up', 'The map needs Google Maps on Eden’s server.');
  const listed = url.searchParams.get('p');
  const pts = listed ? listed.split('|').slice(0, 25).map(point) : [point(url.searchParams.get('a')), point(url.searchParams.get('b'))];
  if (!pts.length || pts.some((p) => !p)) throw new MapsError('bad_request', 'a and b (or p) must be lat,lng.');
  const w = Math.min(640, Math.max(200, Number(url.searchParams.get('w')) || MAP_SIZE.w));
  const h = Math.min(640, Math.max(200, Number(url.searchParams.get('h')) || MAP_SIZE.h));
  const fitted = fitPoints(pts, { w, h, pad: MAP_SIZE.pad });
  const cOverride = point(url.searchParams.get('c'));
  const zOverride = Number(url.searchParams.get('z'));
  const center = cOverride || fitted.center;
  const zoom = Number.isFinite(zOverride) && zOverride >= 1 && zOverride <= 18 ? Math.round(zOverride) : fitted.zoom;
  const styleMode = url.searchParams.get('style') || 'flight';
  const styles = styleMode === 'day' ? DAY_LIGHT : styleMode === 'day-dark' ? DAY_DARK : DARK;
  const q = new URLSearchParams({ center: `${center.lat},${center.lng}`, zoom: String(zoom), size: `${w}x${h}`, scale: '2', maptype: 'roadmap', key });
  for (const s of styles) q.append('style', s);
  await metered(meter, 'static_map');
  let res;
  try { res = await fetcher(`${STATIC}?${q}`, { signal: AbortSignal.timeout(TIMEOUT) }); } catch { throw new MapsError('unavailable', 'Google Maps did not answer in time.'); }
  if (!res.ok || !String(res.headers.get('content-type') || '').startsWith('image/')) throw new MapsError('unavailable', `Google Maps answered ${res.status}.`);
  return new Response(res.body, { headers: { 'content-type': res.headers.get('content-type'), 'cache-control': 'private, max-age=86400', 'x-map-center': `${center.lat},${center.lng}`, 'x-map-zoom': String(zoom), 'x-content-type-options': 'nosniff' } });
}

// A place's photo (stop thumbnails): Google Places photo media fetched with the server's key, so the key never reaches
// the page. `n` is the photo's resource name from a place lookup; `w` its width (up to 1600, the stop detail's photo).
export async function placePhoto(env, url, { fetch: fetcher = globalThis.fetch, meter = null } = {}) {
  const key = typeof env.GOOGLE_MAPS_SERVER_KEY === 'string' ? env.GOOGLE_MAPS_SERVER_KEY.trim() : '';
  if (!key) throw new MapsError('not_set_up', 'Photos need Google Maps on Eden’s server.');
  const name = url.searchParams.get('n') || '';
  if (!PHOTO_NAME.test(name)) throw new MapsError('bad_request', 'n must be a Google place photo name.');
  const w = Math.min(1600, Math.max(80, Math.round(Number(url.searchParams.get('w')) || 240)));
  await metered(meter, 'photo');
  let res;
  try { res = await fetcher(`${PLACES}/${name}/media?maxWidthPx=${w}&key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(TIMEOUT) }); } catch { throw new MapsError('unavailable', 'Google Maps did not answer in time.'); }
  if (res.status === 404 || res.status === 400) throw new MapsError('not_found', 'Google has no such photo now.');
  if (!res.ok || !String(res.headers.get('content-type') || '').startsWith('image/')) throw new MapsError('unavailable', `Google Maps answered ${res.status}.`);
  return new Response(res.body, { headers: { 'content-type': res.headers.get('content-type'), 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' } });
}
