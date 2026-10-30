// Watching Eden Mail for bookings: the person turns on "Watch my email for bookings" and, every few hours, Eden looks
// at the Gmail that came in since its last look (the same search and reader as the scan button, ops.js trip-mail-scan
// and confirmations.js), keeps each structured booking (the airline's or hotel's own schema.org data; an email with
// only a reference in its words is left for the scan button, where the person reads it) that falls inside one of the
// person's trips, and pushes once: "2 bookings found in your email". Nothing is added to a trip here: the page shows
// them as the scan's cards, and only the person's Add (trip-mail-import, which reads the email again) changes the trip.
//
// Gmail not connected, or connected without mail access: the watch stays on and says so (status `gmail.problem`);
// the next look tries again.
//
//   trip-mailwatch-on     { confirm: true }    → status     (`local` from api.js, as the scan's)
//   trip-mailwatch-off    {}                   → { on: false }   (what was found stays until it's added or dropped)
//   trip-mailwatch-status {}                   → { on, since, last, gmail, found: n }
//   trip-mail-found       { id? }              → { candidates }  (as trip-mail-scan's, source 'mail'; `id`: one trip,
//                                                                 matched again against it as it is now)
//   trip-mailwatch-drop   { message, index }   → { dropped }
//   alarm kind 'tmailw' (account.js): mailWatchDue
//
// tmw → { on, since (ms: mail after this is new), local, started, last: { at, scanned, found, problem? } | null }
// tmwfound → [{ trip, message, index, subject, from, received, booking, found_at }]   (newest first, capped)
// tmwseen → [message ids already read]   (capped; Gmail's after: works in whole seconds, so the edges overlap)

import { scheduleJob, unscheduleJob } from '../accounts/schedule.js';
import { MAIL_QUERY, SCAN_LIMIT, bookingsIn, matchBooking, messageParts } from './confirmations.js';
import { TripError } from './trips.js';

export const MAILWATCH = { everyMs: 4 * 3600_000, firstDays: 30, keep: 50, seen: 500 };
const JOB = 'tmailw';
const NOT_CONNECTED = 'Connect Gmail in Eden Mail so Eden can look for your bookings.';
const NO_SCOPE = 'Eden Mail is connected without access to read your mail: connect Gmail again in Mail.';

/** The Gmail query for mail after `since` (ms): the scan's words, newer than the last look instead of 400 days. */
export const watchQuery = (since) => `${MAIL_QUERY.replace(/\s*newer_than:\S+/, '')} after:${Math.floor(since / 1000)}`;

/** Eden Mail from inside the account object, or { problem } when it can't be read (never thrown). */
async function mailFor(account, local) {
  const { googleInAccount, gmailScopesOk } = await import('../accounts/schedule.js');
  let google;
  try { google = await googleInAccount(account, { local }); } catch { return { problem: NOT_CONNECTED }; }
  if (!gmailScopesOk(google.scopes)) return { problem: NO_SCOPE };
  const api = google.gmail();
  return {
    async search(query, limit) { const r = await api.search({ query, limit }); return (r.messages || r || []).map((m) => m.id).filter(Boolean); },
    full: (id) => google.gmailMessage(id),
  };
}

/** Each trip whose days cover a booking: [{ id, trip, match }] (the match is matchBooking's 'mark' or 'add'). */
export function tripsFor(trips, b) {
  return trips.map(([id, trip]) => ({ id, trip, match: matchBooking(trip, b) })).filter((x) => x.match.action !== 'none');
}

const view = (w, found) => ({
  on: Boolean(w && w.on),
  since: w && w.since ? new Date(w.since).toISOString() : null,
  last: w && w.last ? { ...w.last, at: new Date(w.last.at).toISOString() } : null,
  gmail: w && w.last && w.last.problem ? { ok: false, problem: w.last.problem } : { ok: true },
  found: found.length,
  source: 'Eden Mail (Gmail)',
});

const allTrips = async (storage) => [...(await storage.list({ prefix: 'trip:' }))].map(([k, t]) => [k.slice(5), t]);

export async function mailWatchOp(account, op, body = {}, deps = {}) {
  const storage = account.storage;
  const now = account.now();
  const w = (await storage.get('tmw')) || null;
  const found = (await storage.get('tmwfound')) || [];
  switch (op) {
    case 'trip-mailwatch-status':
      return view(w, found);
    case 'trip-mailwatch-on': {
      if (body.confirm !== true) throw new TripError('mailwatch-on needs confirm: true (the person turned it on).');
      const local = body.local === true;
      // said at once when Gmail can't be read; the watch is on either way and tries again each look
      const mail = deps.mail || (await mailFor(account, local));
      const next = { on: true, since: w && w.on ? w.since : now - MAILWATCH.firstDays * 86400_000, local, started: w && w.on ? w.started : now, last: mail.problem ? { at: now, scanned: 0, found: 0, problem: mail.problem } : (w && w.last) || null };
      await storage.put('tmw', next);
      await scheduleJob(account, JOB, JOB, now + 1000); // the first look straight away
      return view(next, found);
    }
    case 'trip-mailwatch-off':
      await storage.delete(['tmw', 'tmwseen']);
      await unscheduleJob(account, JOB);
      return { on: false };
    case 'trip-mailwatch-drop': {
      const left = found.filter((f) => !(f.message === String(body.message || '') && f.index === Number(body.index)));
      await storage.put('tmwfound', left);
      return { dropped: found.length - left.length };
    }
    case 'trip-mail-found': {
      const id = body.id === undefined ? null : String(body.id);
      const trips = new Map(await allTrips(storage));
      if (id !== null && !trips.has(id)) throw new TripError('There is no such trip.', 404, 'not_found');
      const out = [];
      for (const f of found) {
        if (id !== null && f.trip !== id) continue;
        const trip = trips.get(f.trip);
        if (!trip) continue;
        // matched again against the trip as it is now; one already in it (the same reference booked) isn't shown
        const refs = new Set(trip.days.flatMap((d) => d.stops).map((s) => s.booked && s.booked.ref).filter(Boolean));
        if (f.booking.ref && refs.has(f.booking.ref)) continue;
        const match = matchBooking(trip, f.booking);
        if (match.action === 'none') continue;
        out.push({ source: 'mail', trip: f.trip, trip_title: trip.title, message: f.message, index: f.index, subject: f.subject, from: f.from, received: f.received, booking: f.booking, match, found_at: new Date(f.found_at).toISOString() });
      }
      return { candidates: out };
    }
    default:
      throw new TripError('Unknown trip op.', 404, 'not_found');
  }
}

/**
 * The job: one look at the mail since the last, while the watch is on. Returns when to look next (runAlarms keeps the
 * job), or nothing when the watch is off. `deps.mail` stands in for Gmail in tests.
 */
export async function mailWatchDue(account, { notify, mail: given } = {}) {
  const storage = account.storage;
  const now = account.now();
  const w = await storage.get('tmw');
  if (!w || !w.on) return undefined;
  const next = now + MAILWATCH.everyMs;
  const mail = given || (await mailFor(account, w.local === true));
  if (mail.problem) { await storage.put('tmw', { ...w, last: { at: now, scanned: 0, found: 0, problem: mail.problem } }); return next; }
  let ids;
  try { ids = (await mail.search(watchQuery(w.since), SCAN_LIMIT)).slice(0, SCAN_LIMIT); }
  catch { await storage.put('tmw', { ...w, last: { at: now, scanned: 0, found: 0, problem: 'Gmail didn’t answer. Eden tries again at the next look.' } }); return next; }
  const seen = new Set((await storage.get('tmwseen')) || []);
  const trips = await allTrips(storage);
  const found = (await storage.get('tmwfound')) || [];
  const fresh = [];
  for (const m of ids) {
    if (seen.has(m)) continue;
    let parts;
    try { parts = messageParts(await mail.full(m)); } catch { continue; } // one unreadable email doesn't stop the look (read again next time)
    seen.add(m);
    bookingsIn(parts).forEach((b, index) => {
      if (b.structured === false || !b.date) return; // structured bookings only: a reference read from the words is the scan's
      for (const t of tripsFor(trips, b)) {
        if (found.some((f) => f.trip === t.id && f.message === m && f.index === index)) continue;
        fresh.push({ trip: t.id, message: m, index, subject: parts.subject, from: parts.from, received: parts.date, booking: b, found_at: now });
      }
    });
  }
  // mail that came in while this ran is looked at next time: the next look starts a little before this one did
  await storage.put('tmw', { ...w, since: now - 60_000, last: { at: now, scanned: ids.length, found: fresh.length } });
  await storage.put('tmwseen', [...seen].slice(-MAILWATCH.seen));
  if (fresh.length) {
    await storage.put('tmwfound', [...fresh, ...found].slice(0, MAILWATCH.keep));
    const n = new Set(fresh.map((f) => `${f.message}:${f.index}`)).size;
    const names = [...new Set(fresh.map((f) => f.booking.title || (f.booking.place && f.booking.place.name) || f.subject).filter(Boolean))].slice(0, 3);
    if (notify) {
      await notify(account, {
        title: `${n} booking${n === 1 ? '' : 's'} found in your email`,
        body: `${names.join(', ')}. Open Eden Travel to add ${n === 1 ? 'it' : 'them'} to your trip; nothing was added yet. From Eden Mail (Gmail).`,
        data: { kind: 'tmail', trip: fresh[0].trip },
        local: w.local === true,
      });
    }
  }
  return next;
}
