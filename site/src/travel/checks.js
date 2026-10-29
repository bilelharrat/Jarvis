// What Eden Travel checks on a trip, and the badges it shows: for each stop its hours (open
// that day, open at that time, not closed for good), the travel time from the stop before
// (and whether you'd get there on time) and its price; for each day the pace.
//
// A badge is { status, text, source, checked_at }. status:
//   ok      checked against the source and fine
//   look    worth a look (a tight connection, no hours to check against, a price not set)
//   warn    a problem (closed that day, late, closed for good)
//   sample  stand-in data, not checked: never shown as a checked fact
//   unknown the source didn't answer
// These are data checks against Google Maps (or the stand-in); EVES's claim checks run on
// Ask Eden's answers (eden/eves.js), not here.
//
// Lookups go through a cache so opening a trip again doesn't pay Google again (lookups() below: how old each answer may
// be, FRESH). Past a spending cap (spend.js) no new call is made: the last answer is shown with its own checked_at and
// `held`, or, never checked, a place says so and a leg gets a straight-line estimate shown as a sample.

import { dayLabel, stopCountry } from './holidays.js';
import { MapsError, distanceKm, isGoogleId, standinMaps, strayStandin } from './maps.js';
import { HELD } from './spend.js';
import { dayDate, hhmm, minutesOf, weekday } from './trips.js';

export const CACHE = { placeMs: 24 * 3600_000, travelMs: 6 * 3600_000, keepMs: 30 * 86400_000 };
const DAY = 86400_000;
// How old a Google answer may be before it is asked again (each badge shows when it was checked):
//   a place's name, where it is and its access: 30 days; its status and hours: a day for a visit in the next two days
//   (or past), 3 days for one within two weeks, 7 beyond. Walking times 7 days; transit a day; driving 6 hours.
// Answers are kept CACHE.keepMs, and past these ages shown only while a cap holds new checks back.
export const FRESH = { stable: 30 * DAY, hours: [[2 * DAY, DAY], [14 * DAY, 3 * DAY], [Infinity, 7 * DAY]], walk: 7 * DAY, transit: DAY, drive: 6 * 3600_000, taxi: 6 * 3600_000 };
const STABLE_KEYS = ['id', 'name', 'address', 'lat', 'lng', 'url', 'access'];
// week: the next 7 days' actual hours from when it was asked (maps.js weekOf), special days included; country: for holidays
const HOURS_KEYS = ['status', 'hours', 'week', 'country', 'price', 'price_level', 'website', 'photo'];
const pick = (p, keys) => Object.fromEntries(keys.filter((k) => k in p).map((k) => [k, p[k]]));
const ESTIMATE = 'A straight-line estimate: not checked';
const HOW = { walk: 'on foot', transit: 'by public transport', drive: 'by car', taxi: 'by taxi' };
const TIGHT = 10; // minutes of slack under which a connection is tight
const LATE = 5; // minutes late before it counts
const FAR = 12 * 60; // a leg between two stops on one day that long means a stop is in the wrong place, not that you're late

export const PACE = { fullStops: 5, rushedStops: 7, fullBusy: 9 * 60, rushedMove: 150 };

// A cache backed by nothing: every lookup goes to the maps.
export const noCache = { get: async () => undefined, put: async () => {}, entry: async () => undefined };

/** How old the hours answer for a visit on `date` may be. */
export function hoursFresh(date, now) {
  const ahead = Date.parse(`${date}T00:00:00Z`) - now;
  return (FRESH.hours.find(([within]) => !(ahead > within)) || FRESH.hours[0])[1];
}

/**
 * The cached lookups the checks (and plan.js) share: place(stop, date) and travel(from, to, mode, { lessWalking }).
 * One lookup per key per check (a hotel twice in a day is asked once); `held` counts answers a cap held back.
 */
export function lookups(maps, cache, { now = () => Date.now(), dest = '' } = {}) {
  const memo = new Map();
  const held = { n: 0, reason: null };
  const once = (key, fn) => { if (!memo.has(key)) memo.set(key, fn()); return memo.get(key); };
  // { v, at } of a cached answer; a cache with get/put only: what it has counts as fresh
  const entry = async (key) => {
    if (cache.entry) return await cache.entry(key);
    const v = await cache.get(key);
    return v === undefined ? undefined : { v, at: now() };
  };
  // a cap reached (spend.js): counted, and its reason; any other error goes on up
  const capped = (err) => {
    if (!(err instanceof MapsError) || err.code !== 'capped') throw err;
    const r = err.reason || 'account';
    held.n++;
    held.reason ||= r;
    return r;
  };
  // the cached answer if young enough, else a new one; a cap reached: the last one, marked held, or { held, note } alone
  const fresh = async (key, maxAge, ask, e) => {
    if (e === undefined) e = await entry(key);
    if (e && now() - e.at <= maxAge) return e.v;
    try {
      const v = await ask();
      await cache.put(key, v, maxAge, CACHE.keepMs);
      return v;
    } catch (err) {
      const r = capped(err);
      return e ? { ...e.v, held: r } : { held: r, note: err.message };
    }
  };
  const failed = (e, what) => ({ error: e instanceof MapsError ? e.message : `The ${what} lookup failed.` });

  const place = (stop, date, linking = false) => {
    const id = stop.place.id;
    if (!id) return maps.mode === 'google' && stop.kind !== 'transport' && stop.place && stop.place.name ? linked(stop, date) : null;
    // an id that isn't Google's (a name a chat card made up): found by its name near its own point, then checked as that
    if (maps.mode === 'google' && !String(id).startsWith('standin:') && !isGoogleId(id)) return linked(stop, date);
    const live = maps.mode === 'google' && !String(id).startsWith('standin:');
    const hoursAge = live ? hoursFresh(date || '', now()) : CACHE.placeMs;
    return once(`p:${id}:${hoursAge}`, async () => {
      try {
        if (!live) return await fresh(`p3:${maps.mode}:${id}`, CACHE.placeMs, () => maps.place(id));
        // two parts on their own clocks; neither cached: one call for both
        const sk = `ps1:${id}`, hk = `ph2:${id}`;
        const [se, he] = [await entry(sk), await entry(hk)];
        const young = (e, age) => e && now() - e.at <= age;
        if (!young(se, FRESH.stable) && !young(he, hoursAge)) {
          let both;
          try {
            both = await maps.place(id, { part: 'all' });
          } catch (err) {
            if (!linking && err instanceof MapsError && err.code === 'not_found' && stop.place && stop.place.name) {
              return await linked({ ...stop, place: { ...stop.place, id: null } }, date);
            }
            const r = capped(err); // held back: the parts last seen, if any
            return merge(se ? { ...se.v, held: r } : null, he ? { ...he.v, held: r } : { held: r, note: err.message });
          }
          const stamp = { source: both.source, checked_at: both.checked_at, standin: both.standin };
          const sv = { ...pick(both, STABLE_KEYS), ...stamp }, hv = { ...pick(both, HOURS_KEYS), ...stamp };
          await cache.put(sk, sv, FRESH.stable, CACHE.keepMs);
          await cache.put(hk, hv, hoursAge, CACHE.keepMs);
          return merge(sv, hv);
        }
        const part = (k, e, age, name, keys) => fresh(k, age, async () => { // one part due: only its fields asked
          const p = await maps.place(id, { part: name });
          return { ...pick(p, keys), source: p.source, checked_at: p.checked_at, standin: p.standin };
        }, e || null);
        return merge(await part(sk, se, FRESH.stable, 'stable', STABLE_KEYS), await part(hk, he, hoursAge, 'hours', HOURS_KEYS));
      } catch (e) {
        if (!linking && e instanceof MapsError && e.code === 'not_found' && stop.place && stop.place.name) {
          return await linked({ ...stop, place: { ...stop.place, id: null } }, date);
        }
        return failed(e, 'maps');
      }
    });
  };
  const linked = (stop, date) => {
    const p = stop.place;
    const near = Number.isFinite(p.lat) && Number.isFinite(p.lng) ? { lat: p.lat, lng: p.lng } : {};
    const d = String(dest || '').trim();
    const withDest = !near.lat && d && !String(p.name).toLowerCase().includes(d.toLowerCase());
    const key = `link4:${String(p.name).toLowerCase()}@${near.lat ? `${near.lat.toFixed(3)},${near.lng.toFixed(3)}` : d.toLowerCase() || '-'}`;
    return once(key, async () => {
      try {
        const q1 = withDest ? `${p.name}, ${d}` : p.name;
        const hits = await fresh(key, FRESH.stable, () => maps.search(q1, near));
        let hit = Array.isArray(hits) ? hits.find((h) => isGoogleId(h.id) && (!near.lat || distanceKm(h, near) <= 30)) : null;
        if (!hit && withDest) {
          const hits2 = await fresh(`${key}:raw`, FRESH.stable, () => maps.search(p.name, near));
          hit = Array.isArray(hits2) ? hits2.find((h) => isGoogleId(h.id)) : null;
        }
        if (!hit) return { error: `${p.name} isn’t linked to a Google Maps place, and Google found no match nearby: search for it to link it.` };
        if (hit.checked_at && (hit.status || hit.hours !== undefined)) {
          // with their stamp: a part cached without checked_at reads back as "Not checked." (every stop found by name did)
          const stamp = { source: hit.source, checked_at: hit.checked_at, standin: hit.standin };
          await cache.put(`ps1:${hit.id}`, { ...pick(hit, STABLE_KEYS), ...stamp }, FRESH.stable, CACHE.keepMs);
          await cache.put(`ph2:${hit.id}`, { ...pick(hit, HOURS_KEYS), ...stamp }, hoursFresh(date || '', now()), CACHE.keepMs);
        }
        // linking: the found id is not looked up by name again if Google can't open it (that waited on itself forever)
        const resolved = await place({ ...stop, place: { ...p, id: hit.id, lat: p.lat ?? hit.lat, lng: p.lng ?? hit.lng } }, date, true);
        if (resolved && resolved.error && Number.isFinite(hit.lat)) return hit;
        return resolved ? { ...resolved, id: resolved.id || hit.id, lat: Number.isFinite(resolved.lat) ? resolved.lat : hit.lat, lng: Number.isFinite(resolved.lng) ? resolved.lng : hit.lng } : resolved;
      } catch (e) {
        return failed(e, 'maps');
      }
    });
  };
  // the place from its two parts: the hours part's checked_at is the place's; access carries its own
  const merge = (sv, hv) => {
    if (!hv || !hv.checked_at) return { error: hv?.note || HELD[hv?.held] || 'Not checked.', held: hv?.held };
    const st = sv && sv.checked_at ? sv : null;
    const out = { ...(st || {}), ...hv, access_checked_at: st ? st.checked_at : null };
    if (st?.held || hv.held) out.held = hv.held || st.held;
    return out;
  };

  const travel = (from, to, mode, { lessWalking = false } = {}) => {
    const a = from.place, b = to.place;
    if (!(Number.isFinite(a.lat) && Number.isFinite(b.lat))) return null;
    const pt = (p) => p.id || `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
    // t2: with the transit lines (older entries had none). The same leg in any of the account's trips shares one entry.
    // The hour: Google is asked for now (a trip has no time zone, so no departure time is sent), so every answer is
    // "now"; once departure times are sent the key carries their hour instead.
    const key = `t2:${maps.mode}:${mode}${lessWalking ? ':lw' : ''}:${pt(a)}>${pt(b)}:now`;
    const age = maps.mode === 'google' ? FRESH[mode] ?? FRESH.transit : CACHE.travelMs;
    return once(key, async () => {
      try {
        const t = await fresh(key, age, () => maps.travel(a, b, mode, lessWalking ? { lessWalking } : undefined));
        if (t.held && !Number.isFinite(t.minutes)) {
          // never checked and held back: a straight-line estimate, shown as a sample
          const est = await standinMaps(now).travel(a, b, mode);
          return { ...est, source: ESTIMATE, held: t.held };
        }
        return t;
      } catch (e) {
        return failed(e, 'travel-time');
      }
    });
  };
  // a search near a point (or in the destination), cached like a place: the replacement offered for a Lisbon sample stop
  const nearby = (q, near = {}) => {
    const key = `near3:${q.toLowerCase()}@${Number.isFinite(near.lat) ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : '-'}`;
    return once(key, async () => {
      try {
        // with ratings (explore), so the pick is a well-reviewed place, not just the first hit ("hotel" near Shinjuku once
        // gave a 2.1-star one): close by, 4 stars or more from 50+ reviews when Google has any, best rated first
        const hits = await fresh(key, FRESH.stable, () => (maps.explore ? maps.explore(q, near) : maps.search(q, near)));
        const ok = (Array.isArray(hits) ? hits : []).filter((h) => isGoogleId(h.id) && Number.isFinite(h.lat) && h.status !== 'closed_permanently' && (!Number.isFinite(near.lat) || distanceKm(h, near) <= 3));
        // the closest ring with a well-reviewed one wins: within 1.5 km before 3 km (Takadanobaba once won for Shinjuku)
        const good = (km) => ok.filter((h) => h.rating >= 4 && h.ratings >= 50 && (!Number.isFinite(near.lat) || distanceKm(h, near) <= km)).sort((a, b) => b.rating - a.rating || b.ratings - a.ratings)[0];
        return good(1.5) || good(3) || ok[0] || null;
      } catch (e) {
        if (e instanceof MapsError && e.code === 'capped') { capped(e); return null; }
        return null;
      }
    });
  };
  return { place, travel, nearby, held };
}


// holidays: holidays.js holidayLookup (cc, date) → a public holiday or null; none: no holiday checks
export async function checkTrip(trip, maps, { cache = noCache, now = () => Date.now(), holidays = null } = {}) {
  const look = lookups(maps, cache, { now, dest: trip.destination || trip.title || '' });
  // a Lisbon sample stop left in another trip (made before Google Maps was on): not checked, not travelled to, replace it
  const nonLisbon = maps.mode === 'google' && !/lisbo[an]/i.test(`${trip.destination || ''} ${trip.title || ''}`);
  const stray = (s) => maps.mode === 'google' && strayStandin(trip, s.place);
  const unstandin = (s) => (nonLisbon && String(s.place?.id || '').startsWith('standin:') && !stray(s)
    ? { ...s, place: { ...s.place, id: null, lat: null, lng: null } }
    : s);
  const placeOf = (stop, date) => (stray(stop) ? { error: `${stop.place.name} is from Eden’s Lisbon sample data (made before Google Maps was on): replace this stop.` } : look.place(unstandin(stop), date));
  const strayLeg = (from, to) => ({ error: `Not checked: ${(stray(from) ? from : to).place.name} is Lisbon sample data, not a real stop here. Replace it first.` });
  const travelOf = (from, to, mode) => (stray(from) || stray(to) ? strayLeg(from, to) : look.travel(from, to, mode, { lessWalking: Boolean(trip.access && trip.access.step_free) && mode === 'transit' }));

  // a point at 0,0 is no point (trips saved before trips.js cleanPlace knew Number(null) is 0): found again by name
  for (const day of trip.days) for (const s of day.stops || []) {
    if (s && s.place && s.place.lat === 0 && s.place.lng === 0) { s.place.lat = null; s.place.lng = null; }
  }
  const days = [];
  const alerts = [];
  let tripCost = 0;
  const currency = trip.budget?.currency || 'EUR';
  for (let d = 0; d < trip.days.length; d++) {
    const date = dayDate(trip, d);
    const stops = trip.days[d].stops;
    const places = await Promise.all(stops.map((s) => placeOf(s, date)));
    for (let k = 0; k < stops.length; k++) {
      const s = stops[k], p = places[k];
      if (s && s.place && p && !p.error && Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
        const wasStandin = nonLisbon && String(s.place.id || '').startsWith('standin:');
        if (!Number.isFinite(s.place.lat) || !Number.isFinite(s.place.lng) || wasStandin) {
          s.place.lat = p.lat;
          s.place.lng = p.lng;
        }
        if ((!s.place.id || wasStandin || (!String(s.place.id).startsWith('standin:') && s.place.id !== p.id)) && isGoogleId(p.id)) {
          s.place.id = p.id;
        }
      }
    }
    const out = [];
    let move = 0, busy = 0, cost = 0, late = 0, unchecked = 0;
    let leave = null; // when you leave the stop before, in minutes
    for (let k = 0; k < stops.length; k++) {
      const s = stops[k];
      const at = minutesOf(s.at);
      const p = places[k];
      const badges = {};
      const stopAlerts = [];

      // travel from the stop before
      let arrive = at;
      if (k > 0) {
        // (no departure time yet: a trip has no time zone, and Google wants one; it plans for now)
        const t = await travelOf(stops[k - 1], s, s.mode);
        if (!t || t.error || t.minutes > FAR) unchecked++;
        if (!t) badges.travel = { status: 'look', text: 'No map point for one of these stops, so the travel time isn’t checked.', source: null, checked_at: null };
        else if (t.error) badges.travel = { status: 'unknown', text: t.error, source: null, checked_at: null };
        else if (t.minutes > FAR) badges.travel = { status: 'look', text: `Not checked: the travel time (${t.minutes} min) can’t be right between one day’s stops, so ${stops[k - 1].place.name} or ${s.place.name} is probably in the wrong place. Search for it again.`, source: t.source, checked_at: t.checked_at };
        else {
          move += t.minutes;
          arrive = (leave ?? at) + t.minutes;
          const slack = at - arrive;
          const words = `${t.estimate ? 'About ' : ''}${t.minutes} min ${HOW[s.mode] || `by ${s.mode}`} from ${stops[k - 1].place.name}${t.estimate ? ' (an estimate: Google Maps has no train times in Japan)' : ''}`;
          let status = 'ok', note = words;
          if (slack < -LATE) {
            status = 'warn';
            note = `${words}: you’d get there at ${hhmm(arrive)}, ${-slack} min after ${s.at}.`;
            stopAlerts.push({ kind: 'late', stop: s.id, day: d, text: `${s.place.name}: you’d arrive at ${hhmm(arrive)}, ${-slack} min after the planned ${s.at}.` });
            late++;
          } else if (slack < TIGHT) {
            status = 'look';
            note = `${words}: only ${Math.max(0, slack)} min to spare.`;
          }
          badges.travel = { status: t.standin ? 'sample' : t.estimate && status === 'ok' ? 'look' : status, text: note, source: t.source, checked_at: t.checked_at, minutes: t.minutes, mode: t.mode || s.mode, ...(t.estimate ? { estimate: true } : {}) };
          if (t.held) badges.travel.held = t.held; // a cap held a new check back: this is the last one (or an estimate)
          if (Array.isArray(t.lines)) badges.travel.lines = t.lines; // the rides Google named (transit only; never on stand-in maps)
        }
      }

      // hours and status
      if (!p) badges.hours = { status: 'look', text: 'Not linked to a map place, so its hours aren’t checked.', source: null, checked_at: null };
      else if (p.error) badges.hours = { status: 'unknown', text: p.error, source: null, checked_at: null, ...(p.held ? { held: p.held } : {}) };
      else {
        // a public holiday there that day (never for a sample place); a source that didn't answer says nothing
        const holiday = holidays && !p.standin ? await holidays(stopCountry(p, trip), date).catch(() => null) : null;
        const h = hoursCheck(p, date, at, s.minutes, { holiday });
        if (h.alert) stopAlerts.push({ kind: h.alert, stop: s.id, day: d, text: `${s.place.name}: ${h.text}` });
        badges.hours = { status: p.standin ? 'sample' : h.status, text: h.text, source: p.source, checked_at: p.checked_at };
        if (h.special) badges.hours.special = h.special; // the date's hours are Google's holiday hours
        if (h.holiday) badges.hours.holiday = h.holiday; // { date, name, country, country_name, source, checked_at }
        if (h.seasonal) badges.hours.seasonal = true;
        if (p.held) badges.hours.held = p.held;
      }

      // step-free trips: what Google lists of the entrance (never assumed either way)
      if (trip.access && trip.access.step_free && s.kind !== 'transport') {
        const e = p && !p.error && p.access ? p.access.entrance : null;
        badges.access = !p || p.error ? { status: 'unknown', text: 'Not linked to a map place, so its entrance isn’t checked.', source: null, checked_at: null }
          : p.standin ? { status: 'sample', text: 'Sample place: its entrance isn’t checked.', source: p.source, checked_at: p.checked_at }
          : e === true ? { status: 'ok', text: 'Step-free entrance, as Google lists it.', source: p.source, checked_at: p.access_checked_at ?? p.checked_at }
          : e === false ? { status: 'warn', text: 'Google lists no step-free entrance here.', source: p.source, checked_at: p.access_checked_at ?? p.checked_at }
          : { status: 'look', text: 'Google doesn’t say whether the entrance is step-free. Worth calling ahead.', source: p.source, checked_at: p.access_checked_at ?? p.checked_at };
        if (e === false) stopAlerts.push({ kind: 'access', stop: s.id, day: d, text: `${s.place.name}: Google lists no step-free entrance.` });
      }

      if (stray(s)) {
        const pts = places.filter((x, i) => x && !x.error && Number.isFinite(x.lat) && !stray(stops[i]));
        const near = pts.length ? { lat: pts.reduce((a, x) => a + x.lat, 0) / pts.length, lng: pts.reduce((a, x) => a + x.lng, 0) / pts.length } : {};
        const what = s.kind === 'stay' ? 'hotel' : s.kind === 'meal' ? 'restaurant' : 'things to do';
        const where = String(trip.destination || '').trim();
        const hit = maps.mode === 'google' ? await look.nearby(near.lat === undefined && where ? `${what} in ${where}` : what, near) : null;
        badges.replace = { status: 'look', text: `${s.place.name} is from Eden’s Lisbon sample data (made before Google Maps was on), not a real place on this trip.${hit ? ` Nearby: ${hit.name}.` : ''}`, suggestion: hit ? { id: hit.id, name: hit.name, lat: hit.lat, lng: hit.lng } : null, source: hit ? 'Google Maps (Places API)' : null, checked_at: hit ? hit.checked_at || new Date(now()).toISOString() : null };
        stopAlerts.push({ kind: 'replace', stop: s.id, day: d, text: `${s.place.name} is sample data from Lisbon: replace it${hit ? ` (Eden suggests ${hit.name})` : ''}.` });
      }

      // price: the trip's own figure, or the place's list price
      if (s.cost) {
        cost += s.cost.amount;
        badges.price = { status: s.booked ? 'ok' : 'look', text: s.booked ? `${fmt(s.cost)}, booked (${s.booked.kind}).` : `${fmt(s.cost)}, an estimate: not booked.`, source: s.booked ? 'Your booking' : 'Trip estimate', checked_at: null };
      } else if (p && !p.error && p.price) {
        const each = p.price.per === 'person' ? p.price.amount * trip.travelers : p.price.amount;
        cost += each;
        badges.price = { status: p.standin ? 'sample' : 'ok', text: `${fmt({ amount: each, currency: p.price.currency })} for ${trip.travelers === 1 ? 'one' : trip.travelers}.`, source: p.source, checked_at: p.checked_at };
      } else badges.price = { status: 'look', text: 'No price set.', source: null, checked_at: null };

      busy += s.minutes;
      leave = Math.max(at, arrive) + s.minutes;
      alerts.push(...stopAlerts);
      const coord = p && !p.error && Number.isFinite(p.lat) && Number.isFinite(p.lng) ? { lat: p.lat, lng: p.lng, ...(isGoogleId(p.id) ? { place_id: p.id } : {}) } : {};
      out.push({ stop: s.id, photo: p && !p.error && p.photo ? p.photo : null, ...coord, arrive: hhmm(Math.max(0, arrive)), leave: hhmm(Math.min(leave, 24 * 60 - 1)), badges, alerts: stopAlerts.map((a) => a.kind) });
    }
    tripCost += cost;
    // the day measured from where you sleep: the stay to the first stop, the last stop back (changing the hotel moves these)
    const home = stayFor(trip, d);
    let anchor = null;
    const first = stops.find((x) => x.id !== home?.id && x.kind !== 'stay'), last = [...stops].reverse().find((x) => x.id !== home?.id && x.kind !== 'stay');
    if (home && first && last) {
      const leg = async (a, b, mode) => {
        const t = await travelOf(a, b, mode);
        return !t ? null : t.error ? { status: 'unknown', text: t.error } : { status: t.standin ? 'sample' : 'ok', minutes: t.minutes, mode: t.mode || mode, source: t.source, checked_at: t.checked_at, ...(Array.isArray(t.lines) ? { lines: t.lines } : {}) };
      };
      anchor = { stay: home.place.name, stay_stop: home.id, out: home.arrival ? null : await leg(home, first, first.mode === 'walk' ? 'walk' : 'transit'), back: await leg(last, home, last.mode === 'walk' ? 'walk' : 'transit'), to: first.id, from: last.id };
    }
    days.push({ day: d, date, stops: out, pace: pace(stops.length, move, busy + move, late), move_minutes: move, move_unchecked: unchecked, cost: { amount: round(cost), currency }, anchor });
  }
  const verdicts = days.map((x) => x.pace);
  return {
    checked_at: new Date(now()).toISOString(),
    maps: maps.mode,
    days,
    alerts,
    pace: verdicts.includes('rushed') ? 'rushed' : verdicts.includes('full') ? 'full' : 'unhurried',
    // answers a spending cap held back (spend.js): shown with when they were last checked, and this note
    ...(look.held.n ? { spend: { held: look.held.n, reason: look.held.reason, note: HELD[look.held.reason] } } : {}),
    cost: { amount: round(tripCost), currency, budget: trip.budget, over: trip.budget ? round(tripCost - trip.budget.amount) > 0 : false },
  };
}

/** Where the traveller sleeps around day d: the stay they woke up in (a stay on an earlier day whose nights reach d),
 *  else the one they check into that day (`arrival`: then only the way back to it counts). */
export function stayFor(trip, d) {
  const lastStay = (i) => [...trip.days[i].stops].reverse().find((x) => x.kind === 'stay' && Number.isFinite(x.place.lat));
  for (let i = Math.min(d, trip.days.length) - 1; i >= 0; i--) {
    const s = lastStay(i);
    if (!s) continue;
    const nights = Number.isInteger(s.nights) && s.nights > 0 ? s.nights : trip.days.length - 1 - i;
    if (i + nights >= d) return { ...s, arrival: false };
    break;
  }
  const today = d < trip.days.length ? lastStay(d) : null;
  return today ? { ...today, arrival: true } : null;
}

// Whether the place is open for this visit: closed for good, closed that day, or the visit starting before it opens or
// running past its close. Within Google's 7-day window (p.week, maps.js weekOf) the date's actual hours count, and a
// special day (Christmas…) wins over the weekly hours; beyond it the weekly hours, with a 'look' when that date is a
// public holiday (`holiday`, holidays.js) or Google shows the place shut all of the coming week (perhaps seasonal).
// Never "closed" unless Google says so.
export function hoursCheck(p, date, at, minutes, { holiday = null } = {}) {
  if (p.status === 'closed_permanently') return { status: 'warn', alert: 'closed', text: 'closed for good.' };
  if (p.status === 'closed_temporarily') return { status: 'warn', alert: 'closed', text: 'closed for now.' };
  const end = at + minutes;
  const fitsIn = (list) => list.find((h) => {
    const o = minutesOf(h.open), c = minutesOf(h.close) <= o ? 24 * 60 : minutesOf(h.close);
    return at >= o && end <= c;
  });
  const fmtSpan = (h) => h.open === '00:00' && (h.close === '00:00' || h.close === '24:00' || h.close === '23:59') ? '24 hours' : `${h.open}–${h.close}`;
  const span = (list) => list.map(fmtSpan).join(', ');
  const visit = `the visit is ${hhmm(at)}–${hhmm(Math.min(end, 24 * 60 - 1))}`;
  const hol = holiday ? { holiday } : {};
  const w = p.week && p.week.days && Array.isArray(p.week.days[date]) ? p.week : null;

  // within Google's window: that date's own hours
  if (w) {
    const list = w.days[date];
    const label = dayLabel(date);
    if (w.special.includes(date)) {
      const head = `holiday hours on ${label} · Google`;
      if (!list.length) return { status: 'warn', alert: 'closed_that_day', special: true, ...hol, text: `${head}: closed that day.` };
      const fits = fitsIn(list);
      if (fits) return { status: 'ok', special: true, ...hol, text: `${head}: open ${fmtSpan(fits)}.` };
      return { status: 'warn', alert: 'out_of_hours', special: true, ...hol, text: `${head}: open ${span(list)}; ${visit}.` };
    }
    // a public holiday Google lists no special hours for: its hours stand, worth a look
    const note = holiday ? ` ${label} is a public holiday in ${holiday.country_name} (${holiday.name} · ${holiday.source}); Google lists no holiday hours for it: check before you go.` : '';
    if (!list.length) return { status: 'warn', alert: 'closed_that_day', ...hol, text: `Google shows it closed on ${label}.${note}` };
    const fits = fitsIn(list);
    if (fits) return { status: holiday ? 'look' : 'ok', ...hol, text: `open ${fmtSpan(fits)} on ${label}.${note}` };
    return { status: 'warn', alert: 'out_of_hours', ...hol, text: `open ${span(list)} on ${label}; ${visit}.${note}` };
  }

  if (!Array.isArray(p.hours)) return { status: 'look', text: 'No opening hours listed: an outdoor place, or check before you go.' };
  const wd = weekday(date);
  const today = p.hours.filter((h) => h.day === wd);
  const dayName = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
  const r = !today.length ? { status: 'warn', alert: 'closed_that_day', text: `closed on ${dayName}s.` }
    : fitsIn(today) ? { status: 'ok', text: `open ${fmtSpan(fitsIn(today))} on ${dayName}.` }
    : { status: 'warn', alert: 'out_of_hours', text: `open ${span(today)} on ${dayName}; ${visit}.` };
  // beyond the window: what the weekly hours can't tell
  const notes = [];
  if (holiday) notes.push(`${dayLabel(date, { weekday: false })} is a public holiday in ${holiday.country_name} (${holiday.name} · ${holiday.source}): hours may differ — Google shows regular hours only.`);
  const seasonal = Boolean(p.week && p.week.closed_week && today.length);
  if (seasonal) notes.push(`Google shows it closed every day from ${dayLabel(p.week.from)} to ${dayLabel(p.week.to)}, though its regular hours say open: it may be seasonal. Check before you go.`);
  if (!notes.length) return r;
  return { ...r, status: r.status === 'ok' ? 'look' : r.status, ...hol, ...(seasonal ? { seasonal } : {}), text: `${notes.join(' ')} Regular hours: ${r.text}` };
}

export function pace(stops, move, busy, late) {
  if (late > 0 || stops >= PACE.rushedStops || move > PACE.rushedMove) return 'rushed';
  if (stops >= PACE.fullStops || busy > PACE.fullBusy) return 'full';
  return 'unhurried';
}

const round = (n) => Math.round(n * 100) / 100;
const fmt = (c) => `${c.currency === 'EUR' ? '€' : c.currency === 'USD' ? '$' : c.currency === 'GBP' ? '£' : `${c.currency} `}${round(c.amount)}`;

// What changed between two checks, for a proposal's preview: travel, cost, alerts gained and gone.
export function compareChecks(before, after) {
  const key = (a) => `${a.kind}:${a.stop}`;
  const was = new Set(before.alerts.map(key));
  const now = new Set(after.alerts.map(key));
  const sum = (c) => c.days.reduce((t, d) => t + d.move_minutes, 0);
  return {
    move_minutes: { before: sum(before), after: sum(after) },
    cost: { before: before.cost.amount, after: after.cost.amount, currency: after.cost.currency },
    pace: { before: before.pace, after: after.pace },
    alerts_fixed: before.alerts.filter((a) => !now.has(key(a))),
    alerts_new: after.alerts.filter((a) => !was.has(key(a))),
  };
}
