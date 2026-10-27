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
// Lookups go through a cache (place answers a day, travel times six hours) so opening a trip
// again doesn't pay Google again.

import { MapsError } from './maps.js';
import { dayDate, hhmm, minutesOf, weekday } from './trips.js';

export const CACHE = { placeMs: 24 * 3600_000, travelMs: 6 * 3600_000 };
const HOW = { walk: 'on foot', transit: 'by public transport', drive: 'by car', taxi: 'by taxi' };
const TIGHT = 10; // minutes of slack under which a connection is tight
const LATE = 5; // minutes late before it counts

export const PACE = { fullStops: 5, rushedStops: 7, fullBusy: 9 * 60, rushedMove: 150 };

// A cache backed by nothing: every lookup goes to the maps.
export const noCache = { get: async () => undefined, put: async () => {} };

export async function checkTrip(trip, maps, { cache = noCache, now = () => Date.now() } = {}) {
  const placeOf = async (stop) => {
    if (!stop.place.id) return null;
    const key = `p:${maps.mode}:${stop.place.id}`;
    const hit = await cache.get(key);
    if (hit) return hit;
    try {
      const p = await maps.place(stop.place.id);
      await cache.put(key, p, CACHE.placeMs);
      return p;
    } catch (e) {
      return { error: e instanceof MapsError ? e.message : 'The maps lookup failed.' };
    }
  };
  const travelOf = async (from, to, mode) => {
    const a = from.place, b = to.place;
    if (!(Number.isFinite(a.lat) && Number.isFinite(b.lat))) return null;
    const key = `t:${maps.mode}:${mode}:${a.id || `${a.lat},${a.lng}`}>${b.id || `${b.lat},${b.lng}`}`;
    const hit = await cache.get(key);
    if (hit) return hit;
    try {
      const t = await maps.travel(a, b, mode);
      await cache.put(key, t, CACHE.travelMs);
      return t;
    } catch (e) {
      return { error: e instanceof MapsError ? e.message : 'The travel-time lookup failed.' };
    }
  };

  const days = [];
  const alerts = [];
  let tripCost = 0;
  const currency = trip.budget?.currency || 'EUR';
  for (let d = 0; d < trip.days.length; d++) {
    const date = dayDate(trip, d);
    const stops = trip.days[d].stops;
    const places = await Promise.all(stops.map(placeOf));
    const out = [];
    let move = 0, busy = 0, cost = 0, late = 0;
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
        if (!t) badges.travel = { status: 'look', text: 'No map point for one of these stops, so the travel time isn’t checked.', source: null, checked_at: null };
        else if (t.error) badges.travel = { status: 'unknown', text: t.error, source: null, checked_at: null };
        else {
          move += t.minutes;
          arrive = (leave ?? at) + t.minutes;
          const slack = at - arrive;
          const words = `${t.minutes} min ${HOW[s.mode] || `by ${s.mode}`} from ${stops[k - 1].place.name}`;
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
          badges.travel = { status: t.standin ? 'sample' : status, text: note, source: t.source, checked_at: t.checked_at, minutes: t.minutes };
        }
      }

      // hours and status
      if (!p) badges.hours = { status: 'look', text: 'Not linked to a map place, so its hours aren’t checked.', source: null, checked_at: null };
      else if (p.error) badges.hours = { status: 'unknown', text: p.error, source: null, checked_at: null };
      else {
        const h = hoursCheck(p, date, at, s.minutes);
        if (h.alert) stopAlerts.push({ kind: h.alert, stop: s.id, day: d, text: `${s.place.name}: ${h.text}` });
        badges.hours = { status: p.standin ? 'sample' : h.status, text: h.text, source: p.source, checked_at: p.checked_at };
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
      out.push({ stop: s.id, arrive: hhmm(Math.max(0, arrive)), leave: hhmm(Math.min(leave, 24 * 60 - 1)), badges, alerts: stopAlerts.map((a) => a.kind) });
    }
    tripCost += cost;
    days.push({ day: d, date, stops: out, pace: pace(stops.length, move, busy + move, late), move_minutes: move, cost: { amount: round(cost), currency } });
  }
  const verdicts = days.map((x) => x.pace);
  return {
    checked_at: new Date(now()).toISOString(),
    maps: maps.mode,
    days,
    alerts,
    pace: verdicts.includes('rushed') ? 'rushed' : verdicts.includes('full') ? 'full' : 'unhurried',
    cost: { amount: round(tripCost), currency, budget: trip.budget, over: trip.budget ? round(tripCost - trip.budget.amount) > 0 : false },
  };
}

// Whether the place is open for this visit: closed for good, closed that weekday, or the visit
// starting before it opens or running past its close.
export function hoursCheck(p, date, at, minutes) {
  if (p.status === 'closed_permanently') return { status: 'warn', alert: 'closed', text: 'closed for good.' };
  if (p.status === 'closed_temporarily') return { status: 'warn', alert: 'closed', text: 'closed for now.' };
  if (!Array.isArray(p.hours)) return { status: 'look', text: 'No opening hours listed: an outdoor place, or check before you go.' };
  const wd = weekday(date);
  const today = p.hours.filter((h) => h.day === wd);
  const dayName = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
  if (!today.length) return { status: 'warn', alert: 'closed_that_day', text: `closed on ${dayName}s.` };
  const end = at + minutes;
  const fits = today.find((h) => {
    const o = minutesOf(h.open), c = minutesOf(h.close) <= o ? 24 * 60 : minutesOf(h.close);
    return at >= o && end <= c;
  });
  if (fits) return { status: 'ok', text: `open ${fits.open}–${fits.close} on ${dayName}.` };
  const span = today.map((h) => `${h.open}–${h.close}`).join(', ');
  return { status: 'warn', alert: 'out_of_hours', text: `open ${span} on ${dayName}; the visit is ${hhmm(at)}–${hhmm(Math.min(end, 24 * 60 - 1))}.` };
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
