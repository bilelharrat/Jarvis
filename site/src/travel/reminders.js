// Booking-window reminders: when a venue's own website says how far ahead it takes bookings (plan.js trip-windows,
// kept at twin:<trip>:<stop> with found: true), Eden pushes on the morning they open, where the trip is: "Bookings for
// Belém Tower open today at 10:00 (the venue's site)". 08:00 in the trip's time zone (tz:<trip>, as recheck.js reads
// it; UTC without one), or 30 minutes before the opening time when that is earlier than 08:30. The opening time is the
// venue's own words (its local time); the trip's zone stands in for the venue's.
//
// The opening day follows the stop: with the window's days_ahead, it is counted back from the stop's day now (a stop
// moved to another day moves its reminder); without it, the kept opens_on. A booked stop, a removed stop or a window
// no longer found gets no push.
//
// twrem:<trip>:<stop> → { opens_on, sent_at | null, missed? }: pushed once for that opening day.
// One job in the account's alarm queue (kind 'twrem'); armed again whenever a trip or a window changes.

import { scheduleJob, unscheduleJob } from '../accounts/schedule.js';
import { dayDate } from './trips.js';

export const REMIND = { hour: 8, beforeMs: 30 * 60_000, lateMs: 18 * 3600_000 };
const JOB = 'twrem';
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// how far a zone is ahead of UTC at `t` (ms), as recheck.js works it out
function offsetMs(zone, t) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t));
  const g = (k) => Number(p.find((x) => x.type === k).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - t;
}
/** A wall-clock time on a date in `zone` as a UTC instant (UTC without a zone). */
export function localInstant(date, minutes, zone) {
  const utc = Date.parse(`${date}T00:00:00Z`) + minutes * 60_000;
  if (!zone || !Number.isFinite(utc)) return utc;
  try { return utc - offsetMs(zone, utc); } catch { return utc; }
}
const zoneOf = async (storage, id) => { const z = await storage.get(`tz:${id}`); return z && typeof z === 'object' ? z.zone : typeof z === 'string' ? z : null; };
const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** When to push for one window: { opens_on, opens_at, at } or null (not found, or no day to count from). */
export function reminderTime(trip, stopId, w, zone = null) {
  if (!w || w.found !== true) return null;
  const di = trip.days.findIndex((d) => d.stops.some((s) => s.id === stopId));
  if (di < 0) return null;
  const visit = dayDate(trip, di);
  const opens_on = Number.isInteger(w.days_ahead) && w.days_ahead > 0
    ? new Date(Date.parse(`${visit}T00:00:00Z`) - w.days_ahead * 86400_000).toISOString().slice(0, 10)
    : /^\d{4}-\d{2}-\d{2}$/.test(String(w.opens_on || '')) ? w.opens_on : null;
  if (!opens_on) return null;
  const opens_at = TIME.test(String(w.opens_at || '')) ? w.opens_at : null;
  const morning = REMIND.hour * 60;
  const local = opens_at && mins(opens_at) - 30 < morning ? Math.max(0, mins(opens_at) - 30) : morning;
  return { opens_on, opens_at, visit, at: localInstant(opens_on, local, zone) };
}

/** The push for one window. */
export function reminderPush(trip, id, stop, t, w) {
  const visit = new Date(`${t.visit}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return {
    title: `Bookings open today: ${stop.place.name}`.slice(0, 120),
    body: `Bookings for ${stop.place.name} open today${t.opens_at ? ` at ${t.opens_at}` : ''} (the venue’s site), for your visit on ${visit}.`,
    data: { kind: 'window', trip: id, stop: stop.id, ...(w.url ? { url: w.url } : {}) },
  };
}

// every window worth a reminder: [{ key, id, trip, stop, w, t }]
async function pending(storage) {
  const out = [];
  for (const [k, w] of await storage.list({ prefix: 'twin:' })) {
    const [, id, stopId] = k.split(':');
    const trip = await storage.get(`trip:${id}`);
    if (!trip) continue;
    const stop = trip.days.flatMap((d) => d.stops).find((s) => s.id === stopId);
    if (!stop || stop.booked) continue;
    const t = reminderTime(trip, stopId, w, await zoneOf(storage, id));
    if (t) out.push({ key: `twrem:${id}:${stopId}`, id, trip, stop, w, t });
  }
  return out;
}

/** Set the one job to the soonest reminder still to come, or drop it. Reminders whose window went are forgotten. */
export async function armWindowReminders(account) {
  const storage = account.storage;
  const now = account.now();
  const list = await pending(storage);
  const live = new Set(list.map((p) => p.key));
  for (const [k] of await storage.list({ prefix: 'twrem:' })) if (!live.has(k)) await storage.delete(k);
  let next = Infinity;
  for (const p of list) {
    const sent = await storage.get(p.key);
    if (sent && sent.opens_on === p.t.opens_on) continue; // told (or missed) for this opening day
    if (now > p.t.at + REMIND.lateMs) continue;
    next = Math.min(next, Math.max(now + 1000, p.t.at));
  }
  if (Number.isFinite(next)) await scheduleJob(account, JOB, JOB, next);
  else await unscheduleJob(account, JOB);
  return Number.isFinite(next) ? next : null;
}

/** The job: each reminder due now is pushed once; one whose morning passed long ago (the job was off) is not sent late. */
export async function windowRemindersDue(account, { notify }) {
  const storage = account.storage;
  const now = account.now();
  for (const p of await pending(storage)) {
    const sent = await storage.get(p.key);
    if (sent && sent.opens_on === p.t.opens_on) continue;
    if (now < p.t.at) continue;
    if (now > p.t.at + REMIND.lateMs) { await storage.put(p.key, { opens_on: p.t.opens_on, sent_at: null, missed: true }); continue; }
    await notify(account, reminderPush(p.trip, p.id, p.stop, p.t, p.w));
    await storage.put(p.key, { opens_on: p.t.opens_on, sent_at: now });
  }
  await armWindowReminders(account);
}
