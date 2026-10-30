// Disruption fixes beyond flights (watch.js delayFix is the flight one): at the re-check moments (recheck.js: a week
// before, the day before, each morning) Eden looks for
//   (a) an outdoor stop on a day whose checked forecast says heavy rain: Open-Meteo's rain chance 70% or more, or a
//       summary of heavy rain, violent showers or a thunderstorm. Outdoor is decided by the place's Google types when
//       the caller has them (park, beach, garden, hiking area…), else by words in its name (extraops.js OUTDOOR:
//       miradouro, viewpoint, beach, park, garden…); each item says which (`how`).
//   (b) a stop the hours check now finds closed: closed that weekday (moved to a day it isn't), or closed for good / for
//       now (taken off the plan).
// For each, Eden builds the fix as one proposal (ops.js trip-propose: the person applies it or not): the stop moved to
// a free slot on a dry day of the trip (a day whose forecast is a rain chance under 40%), else swapped with an indoor
// sight on that day. Never a new place. A booked stop is told, never moved.
//
//   disruptions(trip, checks, weatherDays, { today?, types?, places? }) → { items, ops }   (pure)
//   proposeFix(account, id, trip, found, { tripOp })  → the proposal, or null (checked: a move that the preview's own
//                                                         hours check finds closed or out of hours is dropped)
//   recheckDisruptions(account, id, trip, checks, { tripOp }) → { fresh, items, proposal }   (for recheckDue)
//   disruptionPush(trip, id, freshAlerts, dis) → the re-check's push: "Lisbon: 3 things changed; Eden has a fix ready"
//
// tdis:<trip> → { keys: [kind:stop:day] }: what was last told, so each disruption is pushed and proposed once.

import { OUTDOOR } from './extraops.js';
import { RECHECK } from './recheck.js';
import { dayDate, hhmm, minutesOf, weekday } from './trips.js';

export const DISRUPT = { wetPct: 70, dryPct: 40, from: 9 * 60, until: 20 * 60, gap: 30, step: 30 };
const HEAVY = /^(Heavy rain|Heavy freezing rain|Violent rain showers|Thunderstorm|Thunderstorm with slight hail|Heavy thunderstorm|Thunderstorm with heavy hail)$/;
// Places API (New) types (Table A) that are outdoors
// words extraops.js OUTDOOR lacks: beach, garden, park in Portuguese, Spanish, French, Italian, German
const OUTDOOR_MORE = /\b(praia|playa|plage|spiaggia|strand|jardim|jardin|giardino|parque|parc|parco)s?\b/i;
export const OUTDOOR_TYPES = new Set(['park', 'national_park', 'state_park', 'beach', 'garden', 'botanical_garden', 'hiking_area', 'picnic_ground', 'campground', 'plaza', 'dog_park', 'playground', 'marina']);
const MOVABLE = new Set(['visit', 'activity']);
const keyOf = (i) => `${i.kind}:${i.stop}:${i.day}`;
const at = (iso) => (iso ? `${String(iso).slice(11, 16)} UTC` : 'time not given');
const dayLabel = (trip, d) => `Day ${d + 1} (${new Date(`${dayDate(trip, d)}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })})`;

/** A forecast day with heavy rain. */
export const wet = (w) => Boolean(w && w.forecast !== null && ((Number.isFinite(w.rain_chance_pct) && w.rain_chance_pct >= DISRUPT.wetPct) || HEAVY.test(String(w.summary || ''))));
/** A forecast day that is dry: a rain chance known and under 40%, no heavy summary. No forecast is never dry. */
export const dry = (w) => Boolean(w && w.forecast !== null && Number.isFinite(w.rain_chance_pct) && w.rain_chance_pct < DISRUPT.dryPct && !HEAVY.test(String(w.summary || '')));

/** Whether a stop is outdoors, and how that was decided: 'google_types' | 'name' | null (not outdoors). */
export function outdoor(stop, types) {
  if (!MOVABLE.has(stop.kind)) return null;
  const t = Array.isArray(types) ? types : Array.isArray(stop.place?.types) ? stop.place.types : null;
  if (t && t.length) return t.some((x) => OUTDOOR_TYPES.has(x)) ? 'google_types' : null;
  const name = String(stop.place?.name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return OUTDOOR.test(name) || OUTDOOR_MORE.test(name) ? 'name' : null;
}

const get = (m, k) => (m instanceof Map ? m.get(k) : m ? m[k] : undefined);

// a slot for `minutes` on a day (its stops as [{ id, at, minutes }]): the start nearest `want`, between 09:00 and
// `until`, with 30 minutes to get there and away from each other stop; null when none
function freeSlot(stops, minutes, want, until, skip = new Set()) {
  const busy = stops.filter((s) => !skip.has(s.id)).map((s) => [s.at - DISRUPT.gap, s.at + s.minutes + DISRUPT.gap]);
  const fits = (t) => t >= DISRUPT.from && t + minutes <= until && busy.every(([a, b]) => t + minutes <= a || t >= b);
  const tries = [want];
  for (let t = DISRUPT.from; t + minutes <= until; t += DISRUPT.step) tries.push(t);
  return tries.filter(fits).sort((a, b) => Math.abs(a - want) - Math.abs(b - want))[0] ?? null;
}

/**
 * What the re-check found that a plan change can fix, and the fix: { items: [{ kind: 'rain'|'closed_that_day'|'closed',
 * day, stop, name, text, source, checked_at, how?, booked, fix: { ops, text } | null }], ops }.
 * `checks`: trip-get's checks (checks.js). `weatherDays`: trip-weather's days, one per trip day (weather.js).
 * Options: `today` ('YYYY-MM-DD', the trip's own date now: earlier days are left alone), `types` and `places`
 * (stop id → Google types / the place with hours, as maps.place answers), used when given.
 */
export function disruptions(trip, checks, weatherDays, { today = null, types = null, places = null } = {}) {
  const days = trip.days || [];
  const W = Array.isArray(weatherDays) ? weatherDays : [];
  const first = today ? Math.max(0, days.findIndex((_, i) => dayDate(trip, i) >= today)) : 0;
  const live = (d) => d >= first && (!today || dayDate(trip, d) >= today);
  const byStop = new Map();
  // (b) closed: the hours check's own alerts, with the Google figure's source and time (none from sample places)
  for (const a of checks?.alerts || []) {
    if (a.kind !== 'closed_that_day' && a.kind !== 'closed') continue;
    if (!live(a.day) || checks.maps === 'standin') continue;
    const cs = (checks.days?.[a.day]?.stops || []).find((x) => x.stop === a.stop);
    const h = cs?.badges?.hours;
    if (h && h.status === 'sample') continue;
    const stop = days[a.day]?.stops.find((s) => s.id === a.stop);
    if (!stop) continue;
    byStop.set(a.stop, { kind: a.kind, day: a.day, stop: a.stop, name: stop.place.name, text: `${a.text} (${h?.source || 'Google Maps'}, checked ${at(h?.checked_at)})`, source: h?.source || 'Google Maps', checked_at: h?.checked_at || null, forGood: a.kind === 'closed', booked: Boolean(stop.booked) });
  }
  // (a) rain on an outdoor stop
  days.forEach((d, i) => {
    const w = W[i];
    if (!live(i) || !wet(w)) return;
    for (const s of d.stops) {
      const how = outdoor(s, get(types, s.id));
      if (!how || byStop.has(s.id)) continue;
      const why = [Number.isFinite(w.rain_chance_pct) ? `${w.rain_chance_pct}% chance of rain` : null, w.summary].filter(Boolean).join(', ');
      byStop.set(s.id, { kind: 'rain', day: i, stop: s.id, name: s.place.name, how, text: `${s.place.name}: ${why} on ${dayLabel(trip, i)} (${w.source || 'Open-Meteo'}, checked ${at(w.checked_at)}).`, source: w.source || 'Open-Meteo', checked_at: w.checked_at || null, booked: Boolean(s.booked) });
    }
  });

  // the fixes, one after another on a working copy of each day's times (so two never take the same slot)
  const plan = days.map((d) => d.stops.map((s) => ({ id: s.id, at: minutesOf(s.at), minutes: s.minutes })));
  const stopById = new Map(days.flatMap((d) => d.stops.map((s) => [s.id, s])));
  const moved = new Set([...byStop.keys()]);
  const items = [...byStop.values()].sort((a, b) => a.day - b.day);
  const ops = [];
  for (const it of items) {
    it.fix = null;
    const s = stopById.get(it.stop);
    if (it.booked || !MOVABLE.has(s.kind)) continue; // a booked stop (or a meal, a stay…) is told, never moved
    if (it.forGood) {
      const words = /for good/.test(it.text) ? 'closed for good' : 'closed for now';
      it.fix = { title: `${s.place.name} is ${words}: off the plan`, ops: [{ op: 'remove', stop: s.id }], text: `${s.place.name} taken off the plan (Google lists it ${words}).` };
      ops.push(...it.fix.ops);
      plan[it.day] = plan[it.day].filter((x) => x.id !== s.id);
      continue;
    }
    const isOut = it.kind === 'rain' || Boolean(outdoor(s, get(types, s.id)));
    const place = get(places, s.id);
    const okDay = (j) => {
      if (j === it.day || !live(j)) return false;
      if (isOut && !dry(W[j])) return false; // outdoors: only to a day forecast dry
      if (it.kind === 'closed_that_day' && weekday(dayDate(trip, j)) === weekday(dayDate(trip, it.day))) return false;
      return true;
    };
    // hours known (the caller's places): the slot has to be open; unknown, the proposal's own check decides (proposeFix)
    const open = (j, t, m = s.minutes, p = place) => !p || !Array.isArray(p.hours) || hoursOk(p, dayDate(trip, j), t, m);
    const cands = days.map((_, j) => j).filter(okDay).sort((a, b) => Math.abs(a - it.day) - Math.abs(b - it.day) || b - a);
    const want = minutesOf(s.at);
    for (const j of cands) {
      const sunset = /^\d{2}:\d{2}$/.test(String(W[j]?.sunset || '')) ? minutesOf(W[j].sunset) : DISRUPT.until;
      const until = isOut ? Math.min(DISRUPT.until, sunset) : DISRUPT.until;
      const t = freeSlot(plan[j], s.minutes, want, until);
      if (t !== null && open(j, t)) {
        it.fix = { title: `${it.kind === 'rain' ? `Rain on Day ${it.day + 1}` : `Closed on Day ${it.day + 1}`}: ${s.place.name} to Day ${j + 1}`, ops: [{ op: 'move', stop: s.id, day: j, at: hhmm(t) }], text: `${s.place.name} moved to ${dayLabel(trip, j)} at ${hhmm(t)}${isOut ? `: ${W[j].rain_chance_pct}% chance of rain then (${W[j].source || 'Open-Meteo'})` : ''}.` };
        plan[it.day] = plan[it.day].filter((x) => x.id !== s.id);
        plan[j].push({ id: s.id, at: t, minutes: s.minutes });
        break;
      }
      // no free slot: swap with an indoor sight there that isn't booked or itself being moved
      const other = days[j].stops.find((o) => MOVABLE.has(o.kind) && !o.booked && !moved.has(o.id) && !outdoor(o, get(types, o.id)));
      if (!other) continue;
      const tA = minutesOf(other.at), tB = want;
      const fitsA = freeSlot(plan[j], s.minutes, tA, until, new Set([other.id])) === tA && open(j, tA);
      const fitsB = freeSlot(plan[it.day].filter((x) => x.id !== s.id), other.minutes, tB, DISRUPT.until, new Set([other.id])) === tB && open(it.day, tB, other.minutes, get(places, other.id));
      if (!fitsA || !fitsB) continue;
      it.fix = { title: `${it.kind === 'rain' ? `Rain on Day ${it.day + 1}` : `Closed on Day ${it.day + 1}`}: ${s.place.name} swapped with ${other.place.name}`, ops: [{ op: 'move', stop: s.id, day: j, at: hhmm(tA) }, { op: 'move', stop: other.id, day: it.day, at: hhmm(tB) }], text: `${s.place.name} swapped with ${other.place.name}: ${s.place.name} to ${dayLabel(trip, j)} at ${hhmm(tA)}, ${other.place.name} (indoors) to ${dayLabel(trip, it.day)} at ${hhmm(tB)}.` };
      moved.add(other.id);
      plan[it.day] = plan[it.day].filter((x) => x.id !== s.id).concat({ id: other.id, at: tB, minutes: other.minutes });
      plan[j] = plan[j].filter((x) => x.id !== other.id).concat({ id: s.id, at: tA, minutes: s.minutes });
      break;
    }
    if (it.fix) ops.push(...it.fix.ops);
  }
  for (const it of items) delete it.forGood;
  return { items, ops };
}

// the same rule as checks.js hoursCheck for a visit (kept here so this file stays pure of maps)
function hoursOk(p, date, t, minutes) {
  if (p.status === 'closed_permanently' || p.status === 'closed_temporarily') return false;
  const today = p.hours.filter((h) => h.day === weekday(date));
  return today.some((h) => { const o = minutesOf(h.open), c = minutesOf(h.close) <= o ? 24 * 60 : minutesOf(h.close); return t >= o && t + minutes <= c; });
}

const BAD = new Set(['closed', 'closed_that_day', 'out_of_hours']);

/** Eden's fix as one proposal (the person applies it). A move the preview's own hours check finds closed or out of
 *  hours is dropped and the rest proposed again; nothing left → no proposal. → trip-propose's answer, or null. */
export async function proposeFix(account, id, trip, found, { tripOp }) {
  let items = (found?.items || []).filter((i) => i.fix);
  for (let round = 0; round < 3 && items.length; round++) {
    const ops = items.flatMap((i) => i.fix.ops);
    const n = items.length;
    const title = (n === 1 ? items[0].fix.title : `${n} fixes for rain and closures`).slice(0, 120);
    const reason = items.map((i) => `${i.text} ${i.fix.text}`).join(' ');
    const out = await tripOp(account, 'trip-propose', { id, by: 'eden', title, reason, ops });
    const movedTo = new Map(ops.filter((o) => o.op === 'move').map((o) => [o.stop, Number(o.day)]));
    const bad = new Set((out?.preview?.checks?.alerts || []).filter((a) => BAD.has(a.kind) && movedTo.get(a.stop) === a.day).map((a) => a.stop));
    if (!bad.size) return out;
    items = items.filter((i) => !i.fix.ops.some((o) => bad.has(o.stop)));
    if (!items.length || round === 2) { await tripOp(account, 'trip-discard', { id, proposal: out.proposal.id }).catch(() => {}); return null; }
  }
  return null;
}

// the trip's own date now (its zone from tz:<trip>, as recheck.js reads it; UTC without)
async function todayFor(account, id) {
  const z = await account.storage.get(`tz:${id}`);
  const zone = z && typeof z === 'object' ? z.zone : typeof z === 'string' ? z : null;
  const now = new Date(account.now());
  try { return now.toLocaleDateString('en-CA', { timeZone: zone || 'UTC' }); } catch { return now.toISOString().slice(0, 10); }
}

/**
 * For recheckDue, after it has `checks` (trip-get): the day's weather (trip-weather, Open-Meteo, cached 3 hours), what
 * is disrupted, and, when something new is, Eden's fix proposed. → { fresh: [item], items: [item], proposal | null }.
 * `opts.types` / `opts.places`: as disruptions takes them.
 */
export async function recheckDisruptions(account, id, trip, checks, { tripOp, types = null, places = null }) {
  const weather = await Promise.resolve().then(() => tripOp(account, 'trip-weather', { id })).catch(() => null);
  const found = disruptions(trip, checks, weather && Array.isArray(weather.days) ? weather.days : [], { today: await todayFor(account, id), types, places });
  const k = `tdis:${id}`;
  const told = new Set(((await account.storage.get(k)) || {}).keys || []);
  const fresh = found.items.filter((i) => !told.has(keyOf(i)));
  let proposal = null;
  // a fix only when something new needs one (one the person discarded isn't proposed again every morning)
  if (fresh.some((i) => i.fix)) proposal = await proposeFix(account, id, trip, found, { tripOp }).catch((e) => { console.error('trip fix', id, e && e.message); return null; });
  await account.storage.put(k, { keys: found.items.map(keyOf), at: account.now() });
  return { fresh, items: found.items, proposal };
}

/** The re-check's push with the disruptions in it: the new alerts (recheck.js newAlerts) and the new rain items, one
 *  line each; "; Eden has a fix ready" when a proposal was made. Null when nothing is new. */
export function disruptionPush(trip, id, freshAlerts, dis) {
  const lines = (freshAlerts || []).map((a) => ({ stop: a.stop, day: a.day, text: a.text }));
  for (const i of dis?.fresh || []) if (!lines.some((l) => l.stop === i.stop && l.day === i.day)) lines.push({ stop: i.stop, day: i.day, text: i.text });
  if (!lines.length) return null;
  const n = lines.length;
  const fix = Boolean(dis && dis.proposal);
  const more = n > RECHECK.shown ? ` And ${n - RECHECK.shown} more.` : '';
  return {
    title: `${trip.title || 'Your trip'}: ${n === 1 ? '1 thing' : `${n} things`} changed${fix ? '; Eden has a fix ready' : ''}`,
    body: `${lines.slice(0, RECHECK.shown).map((l) => l.text).join(' ')}${more}`.slice(0, 400),
    data: { kind: 'recheck', trip: id, ...(fix ? { proposal: dis.proposal.proposal?.id || true } : {}) },
  };
}
