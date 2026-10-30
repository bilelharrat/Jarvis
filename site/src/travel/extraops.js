// The rest of a trip's world as the account's trip ops: getting around on the ground (ferries.js, rail.js, cars.js
// through ground.js), the weather for each day (weather.js), and the official entry advice for where it goes (entry.js).
// Each answer says where it came from and when; nothing is guessed (a day too far ahead has no forecast).
//
//   trip-ground-search   { mode: 'ferry'|'train'|'bus'|'car', from, to, date, adults }   → { options, mode }
//   trip-ground-stations { mode: 'ferry'|'train', query }                               → ports or stations
//   trip-weather         { id }    → { days: [{ date, place, high_c, low_c, rain_chance_pct, summary, sunrise, sunset } | { date, forecast: null, why }],
//                                      after_dark: afterDark(trip, days) }
//   trip-entry           { country_code, passport? }   → the official pages to read (never rules of Eden's own)
//   trip-rail-check      { offer_id, passenger_ids, adults, currency }  → Distribusion's live seats and price (kept a while)
//   trip-rail-book       { offer_id, passenger_ids, passengers: [{ first_name, last_name }], email, terms_accepted: true,
//                          id?, stop?, confirm: true } → reserve, then confirm; the stop marked booked (via api)
// A train or bus is bought by Eden from Distribusion (invoiced to Eden), so with TRAVEL_PAY on the traveller pays first
// (pay.js kind rail; account.js refuses trip-rail-book without it, 402 pay_first).

import { GroundError, groundFor } from './ground.js';
import { entryAdvice } from './entry.js';
import { forecast } from './weather.js';
import { TripError, dayDate, hhmm, minutesOf } from './trips.js';

export const WEATHER_MS = 3 * 3600_000; // a forecast kept 3 hours per trip
export const RAIL_CHECK_MS = 20 * 60_000; // a seat check is good this long for the booking that follows
const ADULT = 'PNOS'; // Distribusion's passenger type in its docs' example (an adult); GAP: other types aren't documented

const asTripError = (e) => (e instanceof GroundError ? new TripError(e.message, e.code === 'not_found' || e.code === 'not_set_up' ? 404 : e.code === 'rate_limited' ? 429 : e.code === 'unavailable' ? 503 : 400, e.code) : e);

export async function extraOp(account, op, body, deps = {}) {
  const { cache, fetch } = deps;
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
        if (mode === 'car') {
          // car hire: pick up at from on date, give back at to (default: the same place) on return_date (default: the next day)
          if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) || !Number.isFinite(Date.parse(`${body.date}T00:00:00Z`))) throw new TripError('Which day? A date as YYYY-MM-DD.', 400, 'bad_request');
          const back = body.return_date || new Date(Date.parse(`${body.date}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
          const c = await p.search({ pickup: body.from, dropoff: body.to || body.from, from: body.date, to: back, driver_age: body.driver_age ?? 30 });
          return { mode, options: Array.isArray(c) ? c : c.options || [] };
        }
        const out = mode === 'ferry' ? await p.search({ from: body.from, to: body.to, date: body.date, adults: body.adults }) : await p.search({ from_station: body.from, to_station: body.to, date: body.date, adults: body.adults });
        return { mode, options: Array.isArray(out) ? out : out.options || [] };
      }
      case 'trip-rail-check':
      case 'trip-rail-book': {
        const rail = deps.rail !== undefined ? deps.rail : groundFor(account.env, { fetch, now }).rail;
        if (!rail) throw new TripError('Train and bus booking isn’t switched on yet (Distribusion needs its key).', 404, 'not_set_up');
        const ids = (Array.isArray(body.passenger_ids) ? body.passenger_ids : []).map(String).slice(0, 9);
        const offers = [{ id: String(body.offer_id || ''), passenger_ids: ids }];
        if (op === 'trip-rail-check') {
          const v = await rail.vacancy({ offers, passengers: ids.map((id) => ({ id, type: ADULT, pax: 1 })), currency: body.currency || 'EUR' });
          if (v.vacant) await account.storage.put(`rlq:${body.offer_id}`, { at: now(), total: v.total_price, offer_id: body.offer_id, passenger_ids: ids, title: String(body.title || 'Train').slice(0, 120) });
          return v;
        }
        if (body.confirm !== true) throw new TripError('rail-book needs confirm: true (the person pressed Book).');
        if (body.terms_accepted !== true) throw new TripError('The traveller has to accept the carrier’s terms first.');
        const kept = await account.storage.get(`rlq:${String(body.offer_id || '')}`);
        if (!kept || now() - kept.at > RAIL_CHECK_MS) throw new TripError('Check the seats and price again first: the last check ran out.', 409, 'check_expired');
        // the passengers booked are exactly those whose price was checked (and paid for): never more
        if (JSON.stringify(kept.passenger_ids) !== JSON.stringify(ids)) throw new TripError('The passengers changed since the price check. Check the seats and price again.', 409, 'check_expired');
        const people = (Array.isArray(body.passengers) ? body.passengers : []).filter((p) => p && typeof p === 'object').slice(0, ids.length);
        if (people.length !== ids.length) throw new TripError('A first and last name is needed for each passenger.');
        const passengers = ids.map((id, i) => ({ id, type: ADULT, first_name: people[i].first_name, last_name: people[i].last_name }));
        const r = await rail.reserve({ email: body.email, offers, passengers });
        // Distribusion's own total for the reservation can't be above the checked (and paid) one: then nothing is confirmed
        // with a card hold (pay.js) the hold is the ceiling, not a later re-check's price
        const ceiling = body.held && Number.isFinite(Number(body.held.amount)) ? { amount: Number(body.held.amount), currency: String(body.held.currency || '').toUpperCase() } : kept.total;
        if (r.total_price && ceiling && (r.total_price.currency !== ceiling.currency || r.total_price.amount > ceiling.amount + 0.005)) throw new TripError(`The price went up to ${r.total_price.amount} ${r.total_price.currency}: nothing was booked. Check the seats and price again.`, 409, 'price_changed');
        const b = await rail.confirm({ reservation_id: r.reservation_id, first_name: people[0].first_name, last_name: people[0].last_name, email: body.email, terms_accepted: true, passengers }, { confirm: true });
        if (body.id && body.stop && deps.tripOp) await deps.tripOp(account, 'trip-mark-booked', { id: body.id, stop: body.stop, ref: (b.carrier_refs && b.carrier_refs[0]) || b.reservation_id || r.reservation_id, provider: 'Distribusion', via: 'api', cost: kept.total ? { amount: Number(kept.total.amount), currency: kept.total.currency } : undefined, confirm: true }).catch(() => {});
        await account.storage.delete(`rlq:${body.offer_id}`);
        return b;
      }
      case 'trip-weather': {
        const id = String(body.id || '');
        const trip = await account.storage.get(`trip:${id}`);
        if (!trip) throw new TripError('There is no such trip.', 404, 'not_found');
        const key = `w2:${id}:${trip.rev}`; // w2: with sunrise, sunset and after_dark
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
        const out = { days, after_dark: afterDark(trip, days) };
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

// A view or an outdoor sight planned after dark: an activity or visit whose end (its time + minutes) is after that day's
// sunset (weatherDays[i].sunset, "HH:MM" from Open-Meteo), and whose name says it is something to see outside. Days with
// no sunset (too far ahead for the forecast) aren't judged. → [{ day, stop, text, source, checked_at }]
export const OUTDOOR = /\b(miradouro|viewpoint|view|lookout|beach|park|garden|hike|trail|belvedere|terrace|rooftop)s?\b/i;
export function afterDark(trip, weatherDays) {
  const out = [];
  (trip?.days || []).forEach((d, i) => {
    const w = Array.isArray(weatherDays) ? weatherDays[i] : null;
    if (!w || !/^\d{2}:\d{2}$/.test(String(w.sunset || ''))) return;
    const dark = minutesOf(w.sunset);
    for (const s of d.stops || []) {
      if (s.kind !== 'activity' && s.kind !== 'visit') continue;
      if (!OUTDOOR.test(String(s.place?.name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) continue;
      const end = minutesOf(s.at) + (Number(s.minutes) || 0);
      if (end <= dark) continue;
      out.push({ day: i, stop: s.id, text: `${s.place.name}: after sunset (${w.sunset}); the visit runs ${s.at}–${hhmm(Math.min(end, 24 * 60 - 1))}.`, source: w.source || 'Open-Meteo', checked_at: w.checked_at || null });
    }
  });
  return out;
}
