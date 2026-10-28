// Discover and Near me: places to add to a trip, each with who recommends it and how that was checked.
//
//   Wikivoyage (its travellers' own picks, CC BY-SA 4.0): the "See", "Do", "Eat" and "Drink" listings of the
//   destination's article and its districts, read from the wikitext's listing templates (name, coordinates, website,
//   the traveller's words and when that listing was last edited). Their hours are a traveller's note, not a check:
//   a place's hours are checked (Google) once it's added to a day, like every stop.
//   Google Maps: the best rated places of a kind there (rating and how many people rated it, as Google gives them).
//   Near me: what is open right now (Google's openNow) within a walk of where the person is, with the walking minutes
//   from the Routes API. A place Google doesn't say is open isn't listed as open.
//
//   trip-discover { id, kind: see|do|eat|drink }        → { wikivoyage: { places, page, licence, checked_at } | null,
//                                                            rated: { places, source, checked_at } }
//   trip-nearby   { lat, lng, kind, minutes = 15 }      → { places: [… walk_minutes], source, checked_at }

import { TripError } from './trips.js';
import { MapsError, distanceKm } from './maps.js';

export const DISCOVER = { wikiMs: 7 * 86400_000, ratedMs: 24 * 3600_000, nearbyMs: 10 * 60_000, districts: 8, places: 40 };
export const KINDS = { see: 'things to see', do: 'things to do', eat: 'restaurants', drink: 'cafés and bars' };
const NEAR_TYPES = { see: ['tourist_attraction', 'museum', 'art_gallery', 'historical_landmark', 'park'], do: ['tourist_attraction', 'amusement_park', 'aquarium', 'zoo', 'park', 'movie_theater'], eat: ['restaurant'], drink: ['cafe', 'bar', 'coffee_shop'] };
const WIKI_API = 'https://en.wikivoyage.org/w/api.php';
const UA = 'EdenTravel/1.0 (https://askeden.com)'; // Wikimedia's User-Agent policy
const TIMEOUT = 8000;
export const WIKI_LICENCE = { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' };

/* ---------- Wikivoyage's listings ---------- */

/** The template's own text from `start` (at "{{"), nested templates and links kept whole. */
function templateAt(w, start) {
  let depth = 0;
  for (let i = start; i < w.length - 1; i++) {
    if (w[i] === '{' && w[i + 1] === '{') { depth++; i++; } else if (w[i] === '}' && w[i + 1] === '}') { depth--; i++; if (depth === 0) return w.slice(start + 2, i - 1); }
  }
  return null;
}
function fieldsOf(body) {
  const out = {};
  let depth = 0, cur = '';
  const parts = [];
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === '{{' || two === '[[') { depth++; cur += two; i++; continue; }
    if ((two === '}}' || two === ']]') && depth > 0) { depth--; cur += two; i++; continue; }
    if (body[i] === '|' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += body[i];
  }
  parts.push(cur);
  out._name = parts.shift().trim().toLowerCase();
  for (const p of parts) { const k = p.indexOf('='); if (k > 0) out[p.slice(0, k).trim().toLowerCase()] = p.slice(k + 1).trim(); }
  return out;
}
/** Wikitext → plain words: links' labels, templates' first argument (station names, {{m2|140000}} → 140000 m²). */
export function plainWiki(s) {
  return String(s || '')
    .replace(/\{\{m2\|([^}|]+)\}\}/gi, '$1 m²')
    .replace(/\{\{[^{}|]*\|([^{}|]*)[^{}]*\}\}/g, '$1')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/\[https?:\/\/\S+ ([^\]]+)\]/g, '$1')
    .replace(/'{2,}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
const KIND_OF = { see: 'see', do: 'do', eat: 'eat', drink: 'drink' };
/** The page's listings of one kind: { name, alt, lat, lng, url, about, hours_note, price_note, edited }. */
export function listingsIn(w, kind) {
  const out = [];
  const re = /\{\{\s*(see|do|eat|drink|buy|sleep|listing)\s*[\n|]/gi;
  let m;
  while ((m = re.exec(w))) {
    const body = templateAt(w, m.index);
    if (!body) continue;
    const f = fieldsOf(body);
    const k = f._name === 'listing' ? String(f.type || '').toLowerCase() : f._name;
    if (KIND_OF[k] !== kind) continue;
    const name = plainWiki(f.name).slice(0, 120);
    if (!name) continue;
    const lat = Number(f.lat), lng = Number(f.long);
    out.push({
      name, alt: plainWiki(f.alt).slice(0, 120) || null,
      lat: f.lat && Number.isFinite(lat) && Math.abs(lat) <= 90 ? lat : null, lng: f.long && Number.isFinite(lng) && Math.abs(lng) <= 180 ? lng : null,
      url: /^https?:\/\/[^\s]+$/.test(f.url || '') ? f.url.replace(/^http:/, 'https:') : null,
      about: plainWiki(f.content).slice(0, 400) || null, address: plainWiki(f.address).slice(0, 160) || null,
      hours_note: plainWiki(f.hours).slice(0, 160) || null, price_note: plainWiki(f.price).slice(0, 80) || null,
      edited: /^\d{4}-\d{2}(-\d{2})?$/.test(f.lastedit || '') ? f.lastedit : null,
    });
  }
  return out;
}

async function wikiPage(title, fetcher) {
  const u = new URL(WIKI_API);
  for (const [k, v] of Object.entries({ action: 'parse', page: title, prop: 'wikitext', format: 'json', formatversion: '2', redirects: '1' })) u.searchParams.set(k, v);
  let res;
  try { res = await fetcher(u.toString(), { headers: { 'Api-User-Agent': UA, 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) }); } catch { return null; }
  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  return j && j.parse && typeof j.parse.wikitext === 'string' ? { title: j.parse.title, wikitext: j.parse.wikitext } : null;
}

/** The destination's Wikivoyage listings of a kind, from its article and its district articles (Lisbon/Belém…). */
export async function wikivoyage(destination, kind, { fetch: fetcher = globalThis.fetch, now = Date.now() } = {}) {
  const name = String(destination || '').split(',')[0].trim().slice(0, 80);
  if (!name) return null;
  const main = await wikiPage(name, fetcher);
  if (!main) return null;
  const esc = main.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const districts = [...new Set([...main.wikitext.matchAll(new RegExp(`\\[\\[(${esc}/[^\\]|#]+)`, 'g'))].map((x) => x[1]))].slice(0, DISCOVER.districts);
  const pages = [main, ...(await Promise.all(districts.map((t) => wikiPage(t, fetcher)))).filter(Boolean)];
  const seen = new Set();
  const places = [];
  for (const p of pages) {
    for (const l of listingsIn(p.wikitext, kind)) {
      const key = l.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      places.push({ ...l, page: p.title, page_url: `https://en.wikivoyage.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_')).replace(/%2F/g, '/')}` });
    }
  }
  return { page: main.title, page_url: `https://en.wikivoyage.org/wiki/${encodeURIComponent(main.title.replace(/ /g, '_'))}`, places: places.slice(0, DISCOVER.places), source: 'Wikivoyage travellers', licence: WIKI_LICENCE, checked_at: new Date(now).toISOString() };
}

/* ---------- the account's ops ---------- */

const where = (trip) => {
  const pts = trip.days.flatMap((d) => d.stops).map((s) => s.place).filter((p) => Number.isFinite(p.lat));
  if (!pts.length) return {};
  return { lat: pts.reduce((n, p) => n + p.lat, 0) / pts.length, lng: pts.reduce((n, p) => n + p.lng, 0) / pts.length };
};

export async function discoverOp(account, op, body, { maps, cache, fetch: fetcher }) {
  const now = account.now();
  const kind = String(body.kind || 'see');
  if (!KINDS[kind]) throw new TripError('kind must be see, do, eat or drink.');
  try {
    if (op === 'trip-discover') {
      const trip = await account.storage.get(`trip:${String(body.id || '')}`);
      if (!trip) throw new TripError('There is no such trip.', 404, 'not_found');
      const dest = trip.destination || trip.title;
      const wkey = `wv1:${dest.toLowerCase()}:${kind}`;
      let wiki = await cache.get(wkey);
      if (wiki === undefined) {
        wiki = await wikivoyage(dest, kind, { fetch: fetcher || globalThis.fetch, now });
        await cache.put(wkey, wiki, wiki ? DISCOVER.wikiMs : 3600_000);
      }
      const rkey = `rated1:${maps.mode}:${dest.toLowerCase()}:${kind}`;
      let rated = await cache.get(rkey);
      if (rated === undefined) {
        const places = await maps.explore(`best ${KINDS[kind]} in ${dest}`, where(trip));
        rated = { places: places.filter((p) => p.status !== 'closed_permanently'), source: maps.mode === 'google' ? 'Google Maps ratings' : 'Stand-in sample data: no live maps yet', checked_at: new Date(now).toISOString(), standin: maps.mode !== 'google' };
        await cache.put(rkey, rated, DISCOVER.ratedMs);
      }
      return { kind, destination: dest, wikivoyage: wiki, rated };
    }
    if (op === 'trip-nearby') {
      const at = { lat: Number(body.lat), lng: Number(body.lng) };
      if (!Number.isFinite(at.lat) || !Number.isFinite(at.lng) || Math.abs(at.lat) > 90 || Math.abs(at.lng) > 180) throw new TripError('Where are you? lat and lng.');
      const minutes = Math.min(30, Math.max(5, Number(body.minutes) || 15));
      // a walk of `minutes` at about 4.5 km/h, as the crow flies first (the walk itself comes from Google's routes)
      const radius = Math.round(minutes * 75);
      const key = `near1:${maps.mode}:${kind}:${at.lat.toFixed(3)},${at.lng.toFixed(3)}:${minutes}`;
      const hit = await cache.get(key);
      if (hit) return hit;
      const found = (await maps.nearby(at, { types: NEAR_TYPES[kind], radius })).filter((p) => p.status !== 'closed_permanently' && Number.isFinite(p.lat)).slice(0, 15);
      const walks = found.length ? await maps.matrix([at], found, 'walk') : [];
      const places = found.map((p, j) => {
        const w = walks.find((x) => x.to === j);
        return { ...p, walk_minutes: w ? w.minutes : null, km: Math.round(distanceKm(at, p) * 10) / 10 };
      }).filter((p) => p.walk_minutes !== null && p.walk_minutes <= minutes && p.open_now !== false)
        .sort((a, b) => (b.open_now === true) - (a.open_now === true) || a.walk_minutes - b.walk_minutes);
      const out = { kind, minutes, places, source: maps.mode === 'google' ? 'Google Maps (Places and Routes APIs)' : 'Stand-in sample data: no live maps yet', standin: maps.mode !== 'google', checked_at: new Date(now).toISOString() };
      await cache.put(key, out, DISCOVER.nearbyMs);
      return out;
    }
  } catch (e) {
    if (e instanceof MapsError) throw new TripError(e.message, e.code === 'rate_limited' ? 429 : 503, e.code);
    throw e;
  }
  throw new TripError('Unknown discover op.', 404, 'not_found');
}
