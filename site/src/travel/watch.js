// Flight changes pushed to the traveller (the account's own phone, through notifyOwner in tasks.js, which Apple holds
// until the phone is back online): a delay that moves by 15 minutes or more, a new or changed gate or terminal, a
// cancellation, a diversion. Each trip's flight stops (a flight number in the stop, as the page reads them) are looked at
// on FlightAware from a day before they leave until they land, more often near departure. One job in the account's
// alarm queue (schedule.js, kind 'fwatch') for all of them; armed again whenever a trip changes.
//
// What was last told is kept per flight (`fwsnap:<ident>:<date>`), so a change is pushed once.

import { scheduleJob, unscheduleJob } from '../accounts/schedule.js';
import { cleanIdent } from './flightaware.js';
import { dayDate } from './trips.js';

export const FLIGHT_NO = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{1,4})\b/; // as the page's (web/chat/travel.js)
export const WATCH = {
  aheadMs: 24 * 3600_000, // start this long before the planned day
  farMs: 30 * 60_000, // more than 3 hours before departure: every 30 minutes
  nearMs: 10 * 60_000, // from 3 hours before until it lands: every 10 minutes (about $0.50 of AeroAPI a flight)
  nearBeforeMs: 3 * 3600_000,
  afterMs: 36 * 3600_000, // a flight still not landed this long after its planned day: stop looking
  delayStepMin: 15,
};
const JOB = 'fwatch';

/** Every flight stop of every trip, with its planned day: [{ trip, stop, ident, date }]. */
export async function flightStops(storage) {
  const out = [];
  for (const [key, trip] of await storage.list({ prefix: 'trip:' })) {
    trip.days.forEach((d, i) => {
      for (const s of d.stops) {
        if (s.kind !== 'transport') continue;
        const m = FLIGHT_NO.exec(`${s.place.name} ${s.note || ''}`);
        if (m) out.push({ trip: key.slice(5), title: trip.title, stop: s.id, ident: cleanIdent(`${m[1]}${m[2]}`), date: dayDate(trip, i) });
      }
    });
  }
  return out;
}

const dayStart = (date) => Date.parse(`${date}T00:00:00Z`);

/** Set the one job to the next look any flight needs, or drop it. */
export async function armFlightWatch(account) {
  if (!account.env || !String(account.env.FLIGHTAWARE_API_KEY || '').trim()) return null;
  const now = account.now();
  let next = Infinity;
  for (const f of await flightStops(account.storage)) {
    const snap = await account.storage.get(snapKey(f));
    if (snap && snap.done) continue;
    const from = dayStart(f.date) - WATCH.aheadMs;
    if (now > dayStart(f.date) + WATCH.afterMs) continue;
    next = Math.min(next, Math.max(now + 1000, from));
  }
  if (Number.isFinite(next)) await scheduleJob(account, JOB, JOB, next);
  else await unscheduleJob(account, JOB);
  return Number.isFinite(next) ? next : null;
}

const snapKey = (f) => `fwsnap:${f.ident}:${f.date}`;

/** What changed between what the traveller was last told and now: [{ title, body }] (no news: []). */
export function flightNews(before, f) {
  const out = [];
  const tz = f.origin && f.origin.tz;
  const time = (iso) => { try { return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz || 'UTC' }); } catch { return String(iso).slice(11, 16); } };
  const where = f.origin && (f.origin.city || f.origin.code);
  const dep = f.departure || {};
  const leaves = dep.estimated || dep.scheduled;
  const at = leaves ? `Now leaves ${time(leaves)}${where ? ` ${where} time` : ''}.` : '';
  const b = before || {};
  if (f.state === 'cancelled' && b.state !== 'cancelled') return [{ title: `${f.ident} is cancelled`, body: 'FlightAware shows this flight as cancelled. Check with the airline for a new flight.' }];
  if (f.state === 'diverted' && b.state !== 'diverted') out.push({ title: `${f.ident} is diverted`, body: `FlightAware shows this flight as diverted${f.status ? ` (${f.status})` : ''}.` });
  const delay = Math.max(0, (f.delay_minutes && f.delay_minutes.departure) || 0);
  const told = b.delay || 0;
  if (!dep.actual && Math.abs(delay - told) >= WATCH.delayStepMin) {
    out.push(delay > told
      ? { title: `${f.ident} is delayed ${delay} min`, body: at || 'FlightAware shows a later departure.' }
      : { title: `${f.ident}: delay down to ${delay} min`, body: at || 'FlightAware shows an earlier departure.' });
  }
  if (dep.gate && dep.gate !== b.gate) out.push({ title: b.gate ? `${f.ident}: gate changed to ${dep.gate}` : `${f.ident} leaves from gate ${dep.gate}`, body: `${b.gate ? `Was gate ${b.gate}. ` : ''}${dep.terminal ? `Terminal ${dep.terminal}. ` : ''}${at}`.trim() });
  else if (dep.terminal && b.terminal && dep.terminal !== b.terminal) out.push({ title: `${f.ident}: now terminal ${dep.terminal}`, body: `Was terminal ${b.terminal}. ${at}`.trim() });
  return out;
}

/**
 * Eden's fix for a late flight (the concierge: Eden has it ready, the person applies it): the rest of that day's stops,
 * those not booked, moved later by the delay (rounded up to 5 minutes), as a proposal the person sees in Eden noticed.
 * Null when nothing after the flight can move.
 */
export function delayFix(trip, f, delayMin) {
  const di = trip.days.findIndex((_, i) => dayDate(trip, i) === f.date);
  if (di < 0 || !(delayMin > 0)) return null;
  const stops = trip.days[di].stops;
  const k = stops.findIndex((s) => s.id === f.stop);
  const shift = Math.ceil(delayMin / 5) * 5;
  const ops = [];
  for (const s of stops.slice(k + 1)) {
    if (s.booked) continue; // a booked stop keeps its time: the person decides
    const [h, m] = s.at.split(':').map(Number);
    const t = h * 60 + m + shift;
    if (t > 23 * 60 + 55) continue;
    ops.push({ op: 'time', stop: s.id, at: `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` });
  }
  if (!ops.length) return null;
  return { id: f.trip, by: 'eden', title: `${f.ident} is ${delayMin} min late: the rest of Day ${di + 1} ${shift} min later`, reason: `FlightAware shows ${f.ident} leaving ${delayMin} minutes late, so each stop after it that isn’t booked moves ${shift} minutes later. Booked stops keep their times.`, ops };
}

/** The job: look at each flight that needs it, push what changed, set the next look. */
export async function flightWatchDue(account, { tripOp, notify }) {
  const now = account.now();
  for (const f of await flightStops(account.storage)) {
    const key = snapKey(f);
    const snap = (await account.storage.get(key)) || null;
    if (snap && snap.done) continue;
    if (now < dayStart(f.date) - WATCH.aheadMs || now > dayStart(f.date) + WATCH.afterMs) continue;
    if (snap && snap.next && now < snap.next) continue;
    let flight;
    try {
      ({ flight } = await tripOp(account, 'trip-flight', { ident: f.ident, date: f.date }));
    } catch {
      await account.storage.put(key, { ...(snap || {}), next: now + WATCH.farMs }); // FlightAware down or no such flight yet: try later
      continue;
    }
    const news = flightNews(snap, flight);
    // a later departure: Eden has the day's fix ready as a proposal (applied only by the person)
    const late = news.some((n) => / is delayed /.test(n.title)) ? Math.max(0, (flight.delay_minutes && flight.delay_minutes.departure) || 0) : 0;
    let fixed = false;
    if (late) {
      const trip = await account.storage.get(`trip:${f.trip}`);
      const fix = trip ? delayFix(trip, f, late) : null;
      if (fix) fixed = await tripOp(account, 'trip-propose', fix).then(() => true).catch(() => false);
    }
    for (const n of news) await notify(account, { title: n.title, body: fixed && / is delayed /.test(n.title) ? `${n.body} Eden has the rest of the day moved later, ready for you to apply in Eden Travel.` : n.body, data: { kind: 'flight', trip: f.trip, stop: f.stop, ident: f.ident } });
    const leaves = Date.parse(flight.departure.estimated || flight.departure.scheduled || '') || dayStart(f.date);
    const done = flight.state === 'landed' || flight.state === 'cancelled';
    await account.storage.put(key, {
      state: flight.state, gate: flight.departure.gate || (snap && snap.gate) || null, terminal: flight.departure.terminal || (snap && snap.terminal) || null,
      delay: news.some((n) => /delay/.test(n.title)) || !snap ? Math.max(0, flight.delay_minutes.departure || 0) : snap.delay || 0,
      done, checked_at: now, next: now + (leaves - now <= WATCH.nearBeforeMs ? WATCH.nearMs : WATCH.farMs),
    });
  }
  // the soonest of each flight's own next look
  let next = Infinity;
  for (const f of await flightStops(account.storage)) {
    const snap = await account.storage.get(snapKey(f));
    if ((snap && snap.done) || now > dayStart(f.date) + WATCH.afterMs) continue;
    next = Math.min(next, Math.max(now + 1000, snap && snap.next ? snap.next : dayStart(f.date) - WATCH.aheadMs));
  }
  if (Number.isFinite(next)) await scheduleJob(account, JOB, JOB, next);
  else await unscheduleJob(account, JOB);
}
