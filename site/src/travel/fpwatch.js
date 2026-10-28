// Flight price watch (the hotel one is stayops.js; flight status pushes are watch.js): for a flight stop not booked yet
// whose route and day are known, the person turns "Watch the price" on. Twice a day Eden searches Duffel for the same
// route, day, cabin and passengers, keeps the lowest comparable fare (the same cabin on every segment, no more stops
// than the fare it started from, the same currency) and pushes when it is more than 5% and at least 10 (in that
// currency) under where the watch started. Booking stays the person's: the push and Eden noticed only say it.
//
//   trip-fwatch-on  { id, stop, offer_id?, origin?, destination?, cabin?, adults?, max_stops? }
//       route from (in order): the Duffel offer the person picked (offer_id), the body's origin/destination, or the
//       stop's own name or note ("LHR → LIS", "LHR-LIS", "LHR to LIS"). The day is the stop's day in the trip.
//       → { watch } (the fare it starts from, and the lowest now)
//   trip-fwatch-off { id, stop } → { off: true }
//   alarm kind 'fpwatch' (account.js): flightPriceWatchDue
//
// fpw:<trip>:<stop> → { trip, stop, route: { origin, destination, date, cabin, adults, children_ages, max_stops },
//   base: { total, currency, stops, offer_id, at, source }, best: { …same, at } | null, drop: null | { total, by, pct,
//   offer_id, checked_at }, told: total | null, created, checked_at, next }

import { scheduleJob, unscheduleJob } from '../accounts/schedule.js';
import { createDuffelClient, DuffelError, httpStatusFor } from './vendor-flights.js';
import { flightsOn } from './flights.js';
import { TripError, dayDate } from './trips.js';

export const FPWATCH = { everyMs: 12 * 3600_000, minPct: 0.05, minAmount: 10, max: 10 };
const JOB = 'fpwatch';
const CABINS = ['economy', 'premium_economy', 'business', 'first'];
const IATA = /^[A-Z]{3}$/;
// "LHR → LIS", "LHR->LIS", "LHR - LIS", "LHR to LIS" (codes in capitals, as the page writes them)
export const ROUTE = /\b([A-Z]{3})\s*(?:→|->|–|—|-|\bto\b)\s*([A-Z]{3})\b/;

const cents = (a) => Math.round(Number(a ?? 0) * 100);
const amt = (c) => (c / 100).toFixed(2);
const key = (trip, stop) => `fpw:${trip}:${stop}`;
const dayStart = (date) => Date.parse(`${date}T00:00:00Z`);

const asTripError = (e) => (e instanceof DuffelError ? new TripError(e.message, httpStatusFor(e), e.code) : e);

function duffelFor(account, deps) {
  if (deps.duffel) return deps.duffel;
  const env = account.env || {};
  if (!flightsOn(env)) throw new TripError('Flight search isn’t switched on yet (Duffel).', 404, 'not_set_up');
  try {
    return createDuffelClient({ env, fetch: deps.fetch, baseUrl: deps.baseUrl, sleep: deps.sleep, now: () => account.now(), log: deps.log || ((line) => console.log(JSON.stringify(line))) });
  } catch (e) { throw asTripError(e); }
}

/** Where a stop sits in the trip: { di, stop } or null. */
function stopOf(trip, stopId) {
  const di = trip.days.findIndex((d) => d.stops.some((s) => s.id === stopId));
  return di < 0 ? null : { di, stop: trip.days[di].stops.find((s) => s.id === stopId) };
}

/** The route a stop's own words give ("LHR → LIS"), or null. */
export function routeFromStop(stop) {
  const m = ROUTE.exec(`${stop.place?.name || ''} ${stop.note || ''}`);
  return m && m[1] !== m[2] ? { origin: m[1], destination: m[2] } : null;
}

/** Most stops on any slice of a Duffel offer. */
const stopsOf = (o) => Math.max(0, ...(o.slices || []).map((s) => (s.segments || []).length - 1));

/** Whether a Duffel offer is the same kind of fare as the watch: the cabin on every segment for every passenger (as
 *  Duffel lists it in segments[].passengers[].cabin_class; missing counts as not the same), no more stops, one way. */
export function comparable(o, { cabin, maxStops, currency }) {
  if (!o || !Array.isArray(o.slices) || o.slices.length !== 1) return false;
  if (currency && o.total_currency !== currency) return false;
  if (stopsOf(o) > maxStops) return false;
  for (const s of o.slices) for (const seg of s.segments || []) {
    const pax = seg.passengers || [];
    if (!pax.length || pax.some((p) => p.cabin_class !== cabin)) return false;
  }
  return Number.isFinite(Number(o.total_amount));
}

/** The lowest comparable fare in a Duffel offer list: { total, currency, stops, offer_id } or null. */
export function lowestFare(offers, want) {
  let best = null;
  let currency = want.currency || null; // with none asked, the first comparable fare's (Duffel prices a search in one)
  for (const o of offers || []) {
    if (!comparable(o, { ...want, currency })) continue;
    currency = o.total_currency;
    if (!best || cents(o.total_amount) < cents(best.total)) best = { total: amt(cents(o.total_amount)), currency: o.total_currency, stops: stopsOf(o), offer_id: o.id };
  }
  return best;
}

/** Whether `now` is a drop worth telling from `base`: more than 5% and at least 10 in the currency. */
export function fareDrop(base, now) {
  if (!base || !now || base.currency !== now.currency) return { cheaper: false };
  const by = cents(base.total) - cents(now.total);
  const pct = cents(base.total) > 0 ? by / cents(base.total) : 0;
  return { cheaper: by >= FPWATCH.minAmount * 100 && pct > FPWATCH.minPct, by: amt(Math.max(0, by)), pct: Math.round(pct * 1000) / 10 };
}

async function search(duffel, r) {
  const passengers = [...Array.from({ length: r.adults }, () => ({ type: 'adult' })), ...(r.children_ages || []).map((age) => ({ age }))];
  const req = await duffel.searchOffers({ slices: [{ origin: r.origin, destination: r.destination, departure_date: r.date }], passengers, cabin_class: r.cabin, max_connections: r.max_stops });
  return (req && req.offers) || [];
}

export async function fpwatchOp(account, op, body, deps = {}) {
  const storage = account.storage;
  const now = account.now();
  const id = String(body.id || ''), stopId = String(body.stop || '');
  const trip = await storage.get(`trip:${id}`);
  if (!trip) throw new TripError('There is no such trip.', 404, 'not_found');
  if (op === 'trip-fwatch-off') {
    await storage.delete(key(id, stopId));
    await armFlightPriceWatch(account);
    return { off: true };
  }
  if (op !== 'trip-fwatch-on') throw new TripError('Unknown trip op.', 404, 'not_found');
  const at = stopOf(trip, stopId);
  if (!at) throw new TripError('There is no such stop in this trip.', 404, 'not_found');
  if (at.stop.kind !== 'transport') throw new TripError('Only a flight stop can have its price watched.');
  if (at.stop.booked) throw new TripError('This flight is booked already, so there is no price to watch.', 409, 'locked');
  const date = dayDate(trip, at.di);
  if (now >= dayStart(date)) throw new TripError('That flight’s day has come, so there is no price left to watch.');
  if (!(await storage.get(key(id, stopId)))) {
    const all = await storage.list({ prefix: 'fpw:' });
    if (all.size >= FPWATCH.max) throw new TripError(`Eden watches at most ${FPWATCH.max} flight prices at a time. Turn one off first.`, 409, 'too_many');
  }
  const duffel = duffelFor(account, deps);
  try {
    // the route: the offer the person picked, else what they said, else the stop's own words
    let offer = null;
    if (body.offer_id) offer = await duffel.getOffer(String(body.offer_id)).catch(() => null); // an expired offer: the words below
    const from = offer && offer.slices && offer.slices.length === 1 ? { origin: offer.slices[0].origin?.iata_code, destination: offer.slices[0].destination?.iata_code } : null;
    const words = body.origin && body.destination ? { origin: String(body.origin).trim().toUpperCase(), destination: String(body.destination).trim().toUpperCase() } : null;
    const route = from || words || routeFromStop(at.stop);
    if (!route || !IATA.test(route.origin || '') || !IATA.test(route.destination || '') || route.origin === route.destination) throw new TripError('Eden needs the flight’s airports to watch its price: pick a Duffel fare, or write them in the stop like “LHR → LIS”.');
    const offerCabin = offer && offer.slices[0].segments?.[0]?.passengers?.[0]?.cabin_class;
    const cabin = String(body.cabin || offerCabin || 'economy').toLowerCase().replace(/[\s-]+/g, '_');
    if (!CABINS.includes(cabin)) throw new TripError(`cabin must be ${CABINS.join(', ')}.`);
    const adults = Number(body.adults ?? (offer ? offer.passengers.filter((p) => p.type === 'adult' || p.age === undefined || p.age >= 18).length : trip.travelers));
    if (!Number.isInteger(adults) || adults < 1 || adults > 9) throw new TripError('adults must be 1 to 9.');
    const children_ages = offer ? offer.passengers.filter((p) => p.type !== 'adult' && Number.isInteger(p.age) && p.age < 18).map((p) => p.age) : [];
    const maxStops = offer ? stopsOf(offer) : Number(body.max_stops ?? 1);
    if (!Number.isInteger(maxStops) || maxStops < 0 || maxStops > 2) throw new TripError('max_stops must be 0, 1 or 2.');
    const r = { origin: route.origin, destination: route.destination, date, cabin, adults, children_ages, max_stops: maxStops };
    const offers = await search(duffel, r);
    const lowest = lowestFare(offers, { cabin, maxStops, currency: offer ? offer.total_currency : null });
    const stamp = new Date(now).toISOString();
    // where the watch starts: the fare the person picked (Duffel's own figure for it now), else the lowest now
    const base = offer && comparable(offer, { cabin, maxStops, currency: offer.total_currency })
      ? { total: amt(cents(offer.total_amount)), currency: offer.total_currency, stops: stopsOf(offer), offer_id: offer.id, at: stamp, source: `Duffel offer ${offer.id}` }
      : lowest ? { ...lowest, at: stamp, source: 'Duffel search' } : null;
    if (!base) throw new TripError(`Duffel found no ${cabin.replace('_', ' ')} flights ${r.origin} → ${r.destination} on ${date} to watch.`, 404, 'not_found');
    const w = { trip: id, stop: stopId, route: r, base, best: lowest ? { ...lowest, at: stamp } : null, drop: null, told: null, created: now, checked_at: now, next: now + FPWATCH.everyMs };
    await storage.put(key(id, stopId), w);
    await armFlightPriceWatch(account);
    return { watch: view(w) };
  } catch (e) { throw asTripError(e); }
}

const view = (w) => ({ stop: w.stop, route: `${w.route.origin} → ${w.route.destination}`, date: w.route.date, cabin: w.route.cabin, adults: w.route.adults, max_stops: w.route.max_stops, base: w.base, lowest: w.best, checked_at: new Date(w.checked_at).toISOString(), source: 'Duffel' });

/** The one job: the soonest look any watch needs, or none. Watches whose day has come are dropped. */
export async function armFlightPriceWatch(account) {
  const now = account.now();
  let next = Infinity;
  for (const [k, w] of await account.storage.list({ prefix: 'fpw:' })) {
    if (now >= dayStart(w.route.date)) { await account.storage.delete(k); continue; }
    next = Math.min(next, Math.max(now + 1000, w.next || now));
  }
  if (Number.isFinite(next)) await scheduleJob(account, JOB, JOB, next);
  else await unscheduleJob(account, JOB);
  return Number.isFinite(next) ? next : null;
}

/** The trip's watched flights (for trip-get: which stops have "Watch the price" on). */
export async function flightWatches(account, tripId) {
  return [...(await account.storage.list({ prefix: `fpw:${tripId}:` })).values()].map(view);
}

/** Flights cheaper now than when the watch started (for trip-get, as price_drops is for hotels). */
export async function flightPriceDrops(account, tripId) {
  const now = account.now();
  return [...(await account.storage.list({ prefix: `fpw:${tripId}:` })).values()]
    .filter((w) => w.drop && now < dayStart(w.route.date))
    .map((w) => ({ stop: w.stop, route: `${w.route.origin} → ${w.route.destination}`, date: w.route.date, cabin: w.route.cabin, was: w.base.total, was_at: w.base.at, now: w.drop.total, by: w.drop.by, pct: w.drop.pct, currency: w.base.currency, stops: w.drop.stops, offer_id: w.drop.offer_id, checked_at: w.drop.checked_at, source: 'Duffel' }));
}

/** The job: each watch whose look is due searches Duffel again; a new low past the threshold is pushed once. */
export async function flightPriceWatchDue(account, { notify, fetch, duffel: given, baseUrl, sleep } = {}) {
  const now = account.now();
  const storage = account.storage;
  let duffel = given;
  if (!duffel) { try { duffel = duffelFor(account, { fetch, baseUrl, sleep }); } catch { duffel = null; } }
  for (const [k, w] of await storage.list({ prefix: 'fpw:' })) {
    if (now < (w.next || 0)) continue;
    const trip = await storage.get(`trip:${w.trip}`);
    const at = trip ? stopOf(trip, w.stop) : null;
    // the trip or stop gone, booked, or no longer a flight: nothing to watch
    if (!at || at.stop.booked || at.stop.kind !== 'transport') { await storage.delete(k); continue; }
    const date = dayDate(trip, at.di);
    if (now >= dayStart(date)) { await storage.delete(k); continue; }
    if (!duffel) { await storage.put(k, { ...w, next: now + FPWATCH.everyMs }); continue; }
    const moved = date !== w.route.date; // the stop moved to another day: the watch starts again from that day's fare
    const r = { ...w.route, date };
    let lowest;
    try { lowest = lowestFare(await search(duffel, r), { cabin: r.cabin, maxStops: w.base.stops, currency: w.base.currency }); }
    catch { await storage.put(k, { ...w, next: now + FPWATCH.everyMs }); continue; } // Duffel down: next time
    const stamp = new Date(now).toISOString();
    if (moved) {
      await storage.put(k, { ...w, route: r, base: lowest ? { ...lowest, at: stamp, source: 'Duffel search' } : w.base, best: lowest ? { ...lowest, at: stamp } : null, drop: null, told: null, checked_at: now, next: now + FPWATCH.everyMs });
      continue;
    }
    const next = { ...w, best: lowest ? { ...lowest, at: stamp } : null, checked_at: now, next: now + FPWATCH.everyMs };
    const d = fareDrop(w.base, lowest);
    if (!d.cheaper) { next.drop = null; next.told = null; await storage.put(k, next); continue; } // back up: a later drop is news again
    next.drop = { total: lowest.total, by: d.by, pct: d.pct, stops: lowest.stops, offer_id: lowest.offer_id, checked_at: stamp };
    // told once per new low: again only when it falls a further threshold under what was told
    const fresh = w.told === null || w.told === undefined || fareDrop({ total: w.told, currency: w.base.currency }, lowest).cheaper;
    if (fresh) next.told = lowest.total;
    await storage.put(k, next);
    if (fresh && notify) {
      const c = w.base.currency;
      await notify(account, {
        title: `${r.origin} → ${r.destination} is ${d.by} ${c} cheaper`,
        body: `${lowest.total} ${c} on ${date} (${r.cabin.replace('_', ' ')}, ${lowest.stops ? `${lowest.stops} stop${lowest.stops > 1 ? 's' : ''}` : 'nonstop'}), was ${w.base.total} ${c} when you started watching. Duffel, ${stamp.slice(11, 16)} UTC.`,
        data: { kind: 'fprice', trip: w.trip, stop: w.stop },
      });
    }
  }
  await armFlightPriceWatch(account);
}
