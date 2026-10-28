// Re-checked before you go (planner v2, research_notes/travel/planner-v2-design.md §7): each trip's checks run again
// a week before it starts, the day before, and on the morning of each of its days (all at 07:00 UTC), and what changed
// is pushed once (the account's own phone, through notifyOwner in tasks.js): "Lisbon: 2 things changed".
// One job in the account's alarm queue (schedule.js, kind 'tcheck') for every trip; armed again whenever a trip changes.
//
// tchk:<trip> → { alerts: [key], ran } : the alerts the person last knew of (from their own last change, or the last
// re-check) and when the last re-check ran. A re-check with nothing saved yet only sets it: no push about what the
// person already saw. Stand-in (sample) answers are never pushed as news.

import { scheduleJob, unscheduleJob } from '../accounts/schedule.js';
import { dayDate } from './trips.js';

export const RECHECK = { weekMs: 7 * 86400_000, dayMs: 86400_000, hourUtc: 7, shown: 2 };
const JOB = 'tcheck';

const at7 = (date) => Date.parse(`${date}T00:00:00Z`) + RECHECK.hourUtc * 3600_000;
const alertKey = (a) => `${a.kind}:${a.stop}:${a.day}`;

/** When a trip is re-checked: 7 days and 1 day before its first day, then each of its days, at 07:00 UTC. */
export function recheckTimes(trip) {
  if (!trip || !trip.start || !Array.isArray(trip.days) || !trip.days.length) return [];
  const first = at7(trip.start);
  const times = [first - RECHECK.weekMs, first - RECHECK.dayMs];
  for (let i = 0; i < trip.days.length; i++) times.push(at7(dayDate(trip, i)));
  return times.filter(Number.isFinite);
}

// the first re-check still to come for a trip: after its last run (or after it was made: a re-check a trip was made too
// late for is never run)
function nextTime(trip, state) {
  const since = state && Number.isFinite(state.ran) ? state.ran : Number.isFinite(trip.created) ? trip.created : -Infinity;
  return recheckTimes(trip).find((t) => t > since) ?? null;
}

/**
 * Set the one job to the soonest re-check any trip needs, or drop it. `written` (optional): a trip write's answer
 * ({ trip: { id }, checks }), whose alerts the person has just seen, saved as what they know.
 */
export async function armRecheck(account, written = null) {
  const storage = account.storage;
  if (written && written.trip && written.trip.id && written.checks && Array.isArray(written.checks.alerts)) {
    const k = `tchk:${written.trip.id}`;
    const was = (await storage.get(k)) || {};
    await storage.put(k, { ...was, alerts: pushable(written.checks).map(alertKey) });
  }
  const trips = await storage.list({ prefix: 'trip:' });
  let next = Infinity;
  for (const [key, trip] of trips) next = Math.min(next, nextTime(trip, await storage.get(`tchk:${key.slice(5)}`)) ?? Infinity);
  // a deleted trip's saved alerts go with it
  for (const [key] of await storage.list({ prefix: 'tchk:' })) if (!trips.has(`trip:${key.slice(5)}`)) await storage.delete(key);
  if (Number.isFinite(next)) await scheduleJob(account, JOB, JOB, Math.max(account.now() + 1000, next));
  else await unscheduleJob(account, JOB);
  return Number.isFinite(next) ? next : null;
}

// the alerts worth telling: none from stand-in maps, none on a stop whose facts are samples
function pushable(checks) {
  if (!checks || checks.maps === 'standin') return [];
  const sample = new Set();
  for (const d of checks.days || []) for (const s of d.stops || []) if (Object.values(s.badges || {}).some((b) => b && b.status === 'sample')) sample.add(`${d.day}:${s.stop}`);
  return (checks.alerts || []).filter((a) => !sample.has(`${a.day}:${a.stop}`));
}

/** The alerts in `now` that weren't in the saved keys: [alert]. */
export function newAlerts(savedKeys, alerts) {
  const was = new Set(savedKeys || []);
  return (alerts || []).filter((a) => !was.has(alertKey(a)));
}

/** The push for a trip's new alerts: { title, body, data } (none: null). */
export function recheckPush(trip, id, fresh) {
  if (!fresh.length) return null;
  const n = fresh.length;
  const more = n > RECHECK.shown ? ` And ${n - RECHECK.shown} more.` : '';
  return {
    title: `${trip.title || 'Your trip'}: ${n === 1 ? '1 thing' : `${n} things`} changed`,
    body: `${fresh.slice(0, RECHECK.shown).map((a) => a.text).join(' ')}${more}`.slice(0, 400),
    data: { kind: 'recheck', trip: id },
  };
}

/**
 * The job: each trip with a re-check due runs its checks again (tripOp 'trip-get', as the page does), pushes what's new
 * once, saves what it found, then sets the next one. `plus` (optional): whether the account still has Eden Travel;
 * without it nothing is looked up (each check is billed by Google).
 */
export async function recheckDue(account, { tripOp, notify, plus = async () => true }) {
  const now = account.now();
  const storage = account.storage;
  const on = await plus().catch(() => false);
  for (const [key, trip] of await storage.list({ prefix: 'trip:' })) {
    const id = key.slice(5);
    const state = (await storage.get(`tchk:${id}`)) || null;
    const due = nextTime(trip, state);
    if (due === null || due > now) continue;
    if (!on) { await storage.put(`tchk:${id}`, { ...(state || {}), ran: now }); continue; } // skipped, not caught up later
    let checks;
    try {
      ({ checks } = await tripOp(account, 'trip-get', { id }));
    } catch (e) {
      console.error('trip recheck', id, e && e.message);
      await storage.put(`tchk:${id}`, { ...(state || {}), ran: now });
      continue;
    }
    const alerts = pushable(checks);
    if (state && Array.isArray(state.alerts)) {
      const push = recheckPush(trip, id, newAlerts(state.alerts, alerts));
      if (push) await notify(account, push);
    }
    await storage.put(`tchk:${id}`, { alerts: alerts.map(alertKey), ran: now });
  }
  let next = Infinity;
  for (const [key, trip] of await storage.list({ prefix: 'trip:' })) next = Math.min(next, nextTime(trip, await storage.get(`tchk:${key.slice(5)}`)) ?? Infinity);
  if (Number.isFinite(next)) await scheduleJob(account, JOB, JOB, Math.max(now + 1000, next));
  else await unscheduleJob(account, JOB);
}
