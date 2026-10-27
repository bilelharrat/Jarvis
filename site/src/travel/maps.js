// Eden Travel's one door to maps data (research_notes/travel/HANDOFF.md): a place's hours and
// status, and the travel time between two places. Google when the Worker has its key
// (GOOGLE_MAPS_SERVER_KEY: Places API (New) and Routes API, a key restricted to those two);
// until then a stand-in: a few Lisbon places with sample hours and straight-line travel times.
//
// Every answer carries where it came from and when (`source`, `checked_at`), and stand-in
// answers say so (`standin: true`), so a badge never shows a sample as a checked fact.
// Nothing here is cached across requests yet; the Places and Routes quotas are set in the
// Google Cloud console (daily caps and a $25 budget alert, per the handoff).

const PLACES = 'https://places.googleapis.com/v1';
const ROUTES = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const PLACE_FIELDS = 'id,displayName,formattedAddress,location,businessStatus,regularOpeningHours,utcOffsetMinutes,priceLevel,googleMapsUri';
const TIMEOUT = 8000;

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

export class MapsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// The maps this Worker has: google when the key is set, else the stand-in.
export function mapsFor(env = {}, { fetch: fetcher = globalThis.fetch, now = () => Date.now() } = {}) {
  const key = typeof env.GOOGLE_MAPS_SERVER_KEY === 'string' ? env.GOOGLE_MAPS_SERVER_KEY.trim() : '';
  return key ? googleMaps(key, fetcher, now) : standinMaps(now);
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
    async search(text) {
      const words = String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\W+/).filter((w) => w.length > 2);
      const plain = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      return Object.keys(STANDIN)
        .map((id) => ({ id, hits: words.filter((w) => plain(`${STANDIN[id].name} ${STANDIN[id].area}`).includes(w)).length }))
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
  };
}

function googleMaps(key, fetcher, now) {
  const call = async (url, init, field) => {
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
  return {
    mode: 'google',
    async place(id) {
      const pid = String(id || '');
      if (!/^[A-Za-z0-9_-]{10,300}$/.test(pid)) throw new MapsError('not_found', 'That is not a Google place id.');
      return placeView(await call(`${PLACES}/places/${pid}`, { headers: headers(PLACE_FIELDS) }));
    },
    async search(text, { lat, lng } = {}) {
      const body = { textQuery: String(text || '').slice(0, 200), pageSize: 5 };
      if (Number.isFinite(lat) && Number.isFinite(lng)) body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: 20000 } };
      const out = await call(`${PLACES}/places:searchText`, { method: 'POST', headers: headers(PLACE_FIELDS.split(',').map((f) => `places.${f}`).join(',')), body: JSON.stringify(body) });
      return (out.places || []).map(placeView);
    },
    async travel(from, to, mode = 'walk', { departAt } = {}) {
      const m = MODES.includes(mode) ? mode : 'walk';
      const point = (p) => (p.id && !String(p.id).startsWith('standin:') ? { placeId: p.id } : { location: { latLng: { latitude: p.lat, longitude: p.lng } } });
      const body = { origin: point(from), destination: point(to), travelMode: GOOGLE_MODE[m] };
      if (m === 'drive' || m === 'taxi') body.routingPreference = 'TRAFFIC_AWARE';
      if (departAt && (m === 'transit' || body.routingPreference) && Date.parse(departAt) > now()) body.departureTime = new Date(departAt).toISOString();
      const out = await call(ROUTES, { method: 'POST', headers: headers('routes.duration,routes.distanceMeters'), body: JSON.stringify(body) });
      const r = (out.routes || [])[0];
      if (!r) throw new MapsError('no_route', `Google Maps found no ${m} route between those places.`);
      return { minutes: Math.round(parseInt(String(r.duration || '0'), 10) / 60), meters: r.distanceMeters || 0, mode: m, standin: false, source: 'Google Maps (Routes API)', checked_at: new Date(now()).toISOString() };
    },
  };
}

// Google's place → ours. Hours: regularOpeningHours.periods ({open:{day,hour,minute}, close:{…}});
// a place open all day has one period with no close.
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
    standin: false,
    source: 'Google Maps (Places API)',
    checked_at: checkedAt,
  };
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
export async function flightMapImage(env, url, { fetch: fetcher = globalThis.fetch } = {}) {
  const key = typeof env.GOOGLE_MAPS_SERVER_KEY === 'string' ? env.GOOGLE_MAPS_SERVER_KEY.trim() : '';
  if (!key) throw new MapsError('not_set_up', 'The map needs Google Maps on Eden’s server.');
  const listed = url.searchParams.get('p');
  const pts = listed ? listed.split('|').slice(0, 25).map(point) : [point(url.searchParams.get('a')), point(url.searchParams.get('b'))];
  if (!pts.length || pts.some((p) => !p)) throw new MapsError('bad_request', 'a and b (or p) must be lat,lng.');
  const { center, zoom } = fitPoints(pts);
  const q = new URLSearchParams({ center: `${center.lat},${center.lng}`, zoom: String(zoom), size: `${MAP_SIZE.w}x${MAP_SIZE.h}`, scale: '2', maptype: 'roadmap', key });
  for (const s of DARK) q.append('style', s);
  let res;
  try { res = await fetcher(`${STATIC}?${q}`, { signal: AbortSignal.timeout(TIMEOUT) }); } catch { throw new MapsError('unavailable', 'Google Maps did not answer in time.'); }
  if (!res.ok || !String(res.headers.get('content-type') || '').startsWith('image/')) throw new MapsError('unavailable', `Google Maps answered ${res.status}.`);
  return new Response(res.body, { headers: { 'content-type': res.headers.get('content-type'), 'cache-control': 'private, max-age=86400', 'x-map-center': `${center.lat},${center.lng}`, 'x-map-zoom': String(zoom), 'x-content-type-options': 'nosniff' } });
}
