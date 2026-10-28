// The rest of a trip's world as the account's trip ops: getting around on the ground (ferries.js, rail.js, cars.js
// through ground.js), the weather for each day (weather.js), and the official entry advice for where it goes (entry.js).
// Each answer says where it came from and when; nothing is guessed (a day too far ahead has no forecast).
//
//   trip-ground-search   { mode: 'ferry'|'train'|'bus'|'car', from, to, date, adults }   → { options, mode }
//   trip-ground-stations { mode: 'ferry'|'train', query }                               → ports or stations
//   trip-weather         { id }    → { days: [{ date, place, high_c, low_c, rain_chance_pct, summary } | { date, forecast: null, why }] }
//   trip-entry           { country_code, passport? }   → the official pages to read (never rules of Eden's own)

import { GroundError, groundFor } from './ground.js';
import { entryAdvice } from './entry.js';
import { forecast } from './weather.js';
import { TripError, dayDate } from './trips.js';

export const WEATHER_MS = 3 * 3600_000; // a forecast kept 3 hours per trip

const asTripError = (e) => (e instanceof GroundError ? new TripError(e.message, e.code === 'not_found' || e.code === 'not_set_up' ? 404 : e.code === 'rate_limited' ? 429 : e.code === 'unavailable' ? 503 : 400, e.code) : e);

export async function extraOp(account, op, body, { cache, fetch } = {}) {
  const now = () => account.now();
  try {
    switch (op) {
      case 'trip-ground-search':
      case 'trip-ground-stations': {
        const mode = String(body.mode || '');
        const g = groundFor(account.env, { fetch, now });
        const p = mode === 'ferry' ? g.ferries : mode === 'train' || mode === 'bus' ? g.rail : mode === 'car' ? g.cars : null;
        if (!['ferry', 'train', 'bus', 'car'].includes(mode)) throw new TripError('mode must be ferry, train, bus or car.');
        if (!p) throw new TripError(mode === 'ferry' ? 'Ferry search isn’t switched on yet (Ferryhopper).' : mode === 'car' ? 'Car hire isn’t switched on yet: it needs CarTrawler’s partner spec.' : 'Train and bus booking isn’t switched on yet (Distribusion needs its key).', 404, 'not_set_up');
        if (op === 'trip-ground-stations') return mode === 'ferry' ? { ports: await p.ports(body.query) } : { stations: await p.stations(body.query) };
        if (mode === 'car') { const c = await p.search(body); return { mode, options: Array.isArray(c) ? c : c.options || [] }; }
        const out = mode === 'ferry' ? await p.search({ from: body.from, to: body.to, date: body.date, adults: body.adults }) : await p.search({ from_station: body.from, to_station: body.to, date: body.date, adults: body.adults });
        return { mode, options: Array.isArray(out) ? out : out.options || [] };
      }
      case 'trip-weather': {
        const id = String(body.id || '');
        const trip = await account.storage.get(`trip:${id}`);
        if (!trip) throw new TripError('There is no such trip.', 404, 'not_found');
        const key = `w:${id}:${trip.rev}`;
        const hit = cache && (await cache.get(key));
        if (hit) return hit;
        // each day's weather where that day is: its first stop on the map
        const days = await Promise.all(trip.days.map(async (d, i) => {
          const date = dayDate(trip, i);
          const at = d.stops.find((s) => Number.isFinite(s.place.lat) && Number.isFinite(s.place.lng));
          if (!at) return { date, forecast: null, why: 'No stop on the map that day' };
          const f = await forecast({ lat: at.place.lat, lng: at.place.lng, dates: [date] }, { fetch, now });
          if (!Array.isArray(f)) return { date, forecast: null, why: f.error || 'No forecast', source: f.source, checked_at: f.checked_at };
          return { ...(f[0] || { date, forecast: null, why: 'No forecast' }), place: at.place.name };
        }));
        const out = { days };
        if (cache) await cache.put(key, out, WEATHER_MS);
        return out;
      }
      case 'trip-entry': {
        const a = entryAdvice({ country_code: body.country_code, passport: body.passport });
        return { advice: a ? (Array.isArray(a) ? a : [a]) : [], note: a ? null : 'Eden has no checked official page for that country and passport yet: look on your government’s travel advice site.' };
      }
      default:
        throw new TripError('Unknown trip op.', 404, 'not_found');
    }
  } catch (e) { throw asTripError(e); }
}
