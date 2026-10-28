// The travel day's Live Activity on the Ask Eden Travel iPhone app (askeden/ios EdenTravel TravelLive.swift), kept up to
// date with the app closed: ActivityKit pushes (apns-push-type liveactivity, topic com.askeden.travel.push-type.
// liveactivity) through askeden.com's push key (accounts/apns.js sendPush: its provider token, HTTP/2, the device's
// sandbox or production host as the app said).
//
// The app gives the activity's push token (and, iOS 17.2+, its push-to-start token) once the person has tapped "Show on
// Lock Screen" (the page passes them on: web/chat/travel-live.js → trip-live-token). Then, in the trip's time zone
// (tz:<trip>, as reminders.js reads it; UTC without one):
//   - when the next stop changes (a minute after each stop's time, as the page's Today view counts it): an update;
//   - at a stop's leave-by (its time less the travel time checks.js checked, never a guess): an update with an alert;
//   - a flight's new gate, terminal or delay (watch.js, from the snapshot it keeps): an update with its news as the alert;
//   - once the day's last stop is behind (a minute after its time, when the page's Today view ends it too): an end.
// With a push-to-start token, a trip day's activity starts 90 minutes before its first stop, unless the person ended it
// that day (trip-live-end) or said never (trip-live-end { never: true }, which forgets the token).
//
// The content-state is TravelDayAttributes.ContentState exactly (askeden/ios EdenTravel/TravelDayAttributes.swift):
// its dates are seconds since 2001-01-01 (Swift's JSONDecoder default, as ActivityKit decodes it); a field without a
// value is left out. The aps dates (timestamp, stale-date, dismissal-date) are Unix seconds, as Apple's docs say.
//
// Ask Eden Travel for Android has no activity token (android/travel TravelLive.kt): its Today notification gets the
// day as an FCM data message { type: 'travel.live', plan } (fcm.js), plan being the page's travel-live.js livePlan
// shape as JSON text (androidPlan), sent to every web device of the account registered with the Travel app's
// Firebase token (POST /api/web/push, platform android). A trip day is taken up for Android (`android: true` on its
// record) from 90 minutes before its first stop, as push-to-start does; then the same updates and the same end go
// there (the end: the plan with no next stop, which takes the notification away). The app shows it only to someone
// who turned it on; ending it there (trip-live-end, through the page) ends that day here too.
//
// tlive:<trip>:<date> → { token | null, env, trip, date, at, sent, told: [stop ids alerted], android?, ended?, done? }
// tlivestart → { token, env, at }: this iPhone's push-to-start token (one app install; the latest wins).
// One job in the account's alarm queue (kind 'tlive'); armed again on each token, each trip write and each run.
//
// trip-live-token { token?, push_to_start?, trip?, day?, env } → { ok, next }   (token needs trip and day, yyyy-mm-dd)
// trip-live-end { trip?, day?, never? }                       → { ended: true }

import { GONE, MAX_PAYLOAD, pushReady, sendPush } from '../accounts/apns.js';
import { FCM_GONE, fcmReady, sendFcm } from '../accounts/fcm.js';
import { TRAVEL_BUNDLE_ID } from '../accounts/util.js';
import { backgroundFetch, scheduleJob, unscheduleJob } from '../accounts/schedule.js';
import { cleanIdent } from './flightaware.js';
import { localInstant } from './reminders.js';
import { TripError, dayDate } from './trips.js';

export const LIVE = {
  topic: `${TRAVEL_BUNDLE_ID}.push-type.liveactivity`,
  startLeadMs: 90 * 60_000, // a day's activity starts by push this long before its first stop
  leaveLateMs: 10 * 60_000, // a leave-by alert more than this late (the job was held up) isn't sent
  endDismissMs: 15 * 60_000, // an ended day stays on the Lock Screen this long
  retryMs: 60_000, // a push refused for now (Apple down, 60 a minute reached): tried again then
  keepDays: 2, // a day's record is forgotten this long after it
};
const JOB = 'tlive';
const REF_S = 978307200; // 2001-01-01T00:00:00Z in Unix seconds: Swift's reference date
const TRIP_ID = /^[0-9a-f]{16}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN = /^[0-9a-f]{32,200}$/;
const FLIGHT_NO = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{1,4})\b/; // as watch.js and the page's travel-live.js
const MODES = new Set(['walk', 'transit', 'drive', 'taxi']);
const HOWW = { walk: 'walk', transit: 'public transport', drive: 'drive', taxi: 'taxi' }; // the page's words (travel.js)

const recKey = (trip, date) => `tlive:${trip}:${date}`;
const ref = (ms) => Math.round(ms / 1000 - REF_S); // a Swift Date as JSONEncoder writes it (whole seconds)
const unix = (ms) => Math.floor(ms / 1000);
const zoneOf = async (storage, id) => { const z = await storage.get(`tz:${id}`); return z && typeof z === 'object' ? z.zone : typeof z === 'string' ? z : null; };
const clip = (v, n) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s ? s.slice(0, n) : null; };

/** The traveller's day at `now` in `zone` (yyyy-mm-dd; UTC without a zone). */
export function todayIn(zone, now) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: zone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now)); } catch { return new Date(now).toISOString().slice(0, 10); }
}

/**
 * One day of a trip as the Live Activity reads it: { date, day, title, stops: [{ id, name, start, leave, mode, minutes,
 * source }], dayEnds, flight }. Mirrors travel-live.js livePlan: a stop earlier than the one before it is after
 * midnight; "leave" only from a checked travel time; the flight's gate and terminal from watch.js's last FlightAware
 * snapshot. `checks` is trip-get's (null: no leave-by). Times are instants (ms) in `zone`.
 */
export function dayPlan(trip, i, { checks = null, zone = null, snap = null } = {}) {
  const d = trip && trip.days && trip.days[i];
  if (!d) return null;
  const date = dayDate(trip, i);
  const c = (checks && checks.days && checks.days[i]) || { stops: [] };
  let prev = -1;
  const stops = (d.stops || []).map((s, k) => {
    const [h, m] = String(s.at || '').split(':').map(Number);
    let v = h * 60 + m;
    if (!Number.isFinite(v)) return null;
    if (v < prev) v += 1440;
    prev = v;
    const t = (((c.stops || [])[k] || {}).badges || {}).travel;
    const checked = Boolean(t && Number.isFinite(t.minutes) && t.minutes >= 0);
    const start = localInstant(date, v, zone);
    const mode = (checked && t.mode) || s.mode;
    return {
      id: s.id, name: clip(s.place && s.place.name, 60) || 'Next stop', start, span: Number(s.minutes) || 0,
      leave: checked ? start - t.minutes * 60_000 : null, mode: MODES.has(mode) ? mode : null,
      minutes: checked ? t.minutes : null, source: checked ? clip(t.source || 'checked', 30) : null,
    };
  });
  const last = stops.reduce((acc, s, k) => (s ? k : acc), -1);
  const fs = (d.stops || []).find((x) => x.kind === 'transport' && FLIGHT_NO.test(`${x.place && x.place.name} ${x.note || ''}`));
  const fm = fs && FLIGHT_NO.exec(`${fs.place && fs.place.name} ${fs.note || ''}`);
  const flight = fm ? { ident: `${fm[1]}${fm[2]}`, gate: clip(snap && snap.gate, 8), terminal: clip(snap && snap.terminal, 8) } : null;
  return {
    date, day: i + 1, title: clip(trip.title || trip.name || trip.destination, 60) || 'Your trip',
    stops, count: stops.length, dayEnds: last >= 0 ? stops[last].start + stops[last].span * 60_000 : null, flight,
  };
}

/** The stop that's next at `now` (the page's: until a minute after its time), or -1 when the day's last is behind. */
export const nextIndex = (plan, now) => plan.stops.findIndex((s) => s && now < s.start + 60_000);

/** TravelDayAttributes.ContentState for stop `k`, as JSON (dates since 2001, empty fields left out). */
export function contentState(plan, k) {
  const s = plan.stops[k];
  const out = { stop: s.name, startsAt: ref(s.start) };
  if (s.leave !== null && s.leave <= s.start) out.leaveBy = ref(s.leave);
  if (s.mode) out.mode = s.mode;
  if (s.minutes !== null) out.minutes = s.minutes;
  if (s.source) out.source = s.source;
  if (plan.flight) {
    out.flight = plan.flight.ident.slice(0, 10);
    if (plan.flight.gate) out.gate = plan.flight.gate;
    if (plan.flight.terminal) out.terminal = plan.flight.terminal;
  }
  out.stopsAfter = Math.max(0, Math.min(99, plan.count - k - 1));
  out.dayEndsAt = ref(Math.max(plan.dayEnds ?? s.start, s.start));
  return out;
}

/** The aps for one push: event update | end | start. */
export function livePayload(event, plan, k, now, { alert = null } = {}) {
  const state = contentState(plan, k);
  const aps = { timestamp: unix(now), event, 'content-state': state };
  if (event === 'end') aps['dismissal-date'] = unix(now + LIVE.endDismissMs);
  else aps['stale-date'] = unix(plan.stops[k].start);
  if (event === 'start') {
    aps['attributes-type'] = 'TravelDayAttributes';
    aps.attributes = { trip: plan.title, day: `Day ${plan.day}`, date: plan.date, ...(plan.id ? { tripId: plan.id } : {}) };
  }
  if (alert) aps.alert = { title: clip(alert.title, 120), body: clip(alert.body, 240) || '' };
  return { aps };
}

const clockIn = (ms, zone) => { try { return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: zone || 'UTC' }); } catch { return new Date(ms).toISOString().slice(11, 16); } };

/** "Leave now for Belém Tower" / "18 min public transport · Google Maps". */
export function leaveAlert(s) {
  return { title: `Leave now for ${s.name}`, body: [s.minutes !== null ? `${s.minutes} min${s.mode ? ` ${HOWW[s.mode]}` : ''}` : null, s.source].filter(Boolean).join(' · ') };
}

// ── sending ──

// sendPush puts the Eden Secretary app's topic on a liveactivity push; Ask Eden Travel's is its own
const travelTopic = (fetcher) => (url, init) => fetcher(url, { ...init, headers: { ...init.headers, 'apns-topic': LIVE.topic } });

/** One push to a token; returns 'sent' | 'gone' (Apple says the token is no good) | 'later'. */
async function send(account, { token, env }, body, priority) {
  const text = JSON.stringify(body);
  if (new TextEncoder().encode(text).length > MAX_PAYLOAD) return 'gone';
  const push = { apns_token: token, apns_env: env, apns_topic: TRAVEL_BUNDLE_ID, push_type: 'liveactivity', priority, body: text };
  try {
    if (account.pushCheck) await account.pushCheck({ apns_token: token, push_type: 'liveactivity' }); // 60 a minute (account.js)
    const r = account.sendPush ? await account.sendPush(push) : await sendPush(account.env, push, travelTopic(backgroundFetch(account.env, false)));
    if (r.status === 200) return 'sent';
    if (GONE.has(r.reason) || r.status === 410) return 'gone';
    console.error('live activity push', r.status, r.reason);
    return 'later';
  } catch (e) {
    console.error('live activity push failed', e && e.message);
    return 'later';
  }
}

const apnsReady = (account) => Boolean(account.sendPush) || pushReady(account.env || {});
const fcmOn = (account) => Boolean(account.sendFcm) || fcmReady(account.env || {});
const ready = (account) => apnsReady(account) || fcmOn(account);

/** The account's Ask Eden Travel installs on Android: web devices with the Travel app's Firebase token. */
async function androids(account) {
  if (!fcmOn(account) || typeof account.devices !== 'function') return [];
  const now = account.now();
  return (await account.devices()).filter((d) => d.kind === 'web' && d.fcm_token && d.fcm_app === TRAVEL_BUNDLE_ID && !(d.expires && d.expires <= now));
}

/**
 * The day as Android's Today notification reads it (TravelLivePlan.kt parse; the page's travel-live.js livePlan):
 * { trip, id, day, date, next: { name, start, leave, mode, minutes, source } | null, stopsAfter, dayEnds, flight? },
 * times in ms. `k` < 0: the day is over (next null: the app takes the notification away).
 */
export function androidPlan(plan, k) {
  const s = k >= 0 ? plan.stops[k] : null;
  const out = { trip: plan.title, id: plan.id || null, day: plan.day, date: plan.date, next: null, stopsAfter: 0, dayEnds: plan.dayEnds };
  if (s) {
    out.next = { name: s.name, start: s.start, leave: s.leave !== null && s.leave <= s.start ? s.leave : null, mode: s.mode, minutes: s.minutes, source: s.source };
    out.stopsAfter = Math.max(0, plan.count - k - 1);
  }
  if (plan.flight) out.flight = { ident: plan.flight.ident.slice(0, 10), gate: plan.flight.gate, terminal: plan.flight.terminal };
  return out;
}

/** The day to each Android install; returns 'sent' | 'gone' (none left: no installs, or FCM says every token is gone) | 'later'. */
async function sendAndroid(account, plan, k) {
  const devices = await androids(account);
  if (!devices.length) return 'gone';
  const data = { type: 'travel.live', plan: JSON.stringify(androidPlan(plan, k)) };
  let sent = 0, later = 0;
  for (const d of devices) {
    try {
      await account.pushCheck({ fcm_token: d.fcm_token, push_type: 'liveactivity' }); // 60 a minute (account.js)
      const msg = { token: d.fcm_token, data, collapse: 'travel.live', priority: 'high' };
      const r = account.sendFcm ? await account.sendFcm(msg) : await sendFcm(account.env, msg, backgroundFetch(account.env, false));
      if (r.status === 200) sent += 1;
      else if (FCM_GONE.has(r.reason)) await account.pushGone({ fcm_token: d.fcm_token });
      else { later += 1; console.error('travel day push (android)', r.status, r.reason); }
    } catch (e) {
      later += 1;
      console.error('travel day push (android) failed', e && e.message);
    }
  }
  return sent ? 'sent' : later ? 'later' : 'gone';
}

/**
 * One moment of a day to wherever it's on show: the iPhone's activity (r.token, APNs) and Android's Today notification
 * (r.android, FCM). Returns 'sent' | 'later' | 'gone' (nowhere left) and the record's token and android after it.
 */
async function deliver(account, r, body, plan, k, priority) {
  let token = r.token || null, android = Boolean(r.android), later = false, sent = false;
  if (token && apnsReady(account)) {
    const res = await send(account, r, body, priority);
    if (res === 'gone') token = null;
    else if (res === 'later') later = true;
    else sent = true;
  }
  if (android && fcmOn(account) && plan) {
    const res = await sendAndroid(account, plan, k);
    if (res === 'gone') android = false;
    else if (res === 'later') later = true;
    else sent = true;
  }
  return { res: later ? 'later' : sent ? 'sent' : token || android ? 'sent' : 'gone', token, android };
}

// a day's plan with its checks (trip-get, whose maps answers are cached; a failure: no leave-by) and the flight snapshot
async function planFor(account, id, date, { tripOp, withChecks = true } = {}) {
  const trip = await account.storage.get(`trip:${id}`);
  if (!trip) return null;
  const i = trip.days.findIndex((_, j) => dayDate(trip, j) === date);
  if (i < 0) return null;
  let checks = null;
  if (withChecks && tripOp) checks = await tripOp(account, 'trip-get', { id }).then((r) => r.checks).catch(() => null);
  const zone = await zoneOf(account.storage, id);
  const plan0 = dayPlan(trip, i, { zone });
  const snap = plan0.flight ? await account.storage.get(`fwsnap:${cleanIdent(plan0.flight.ident)}:${date}`) : null;
  return { ...dayPlan(trip, i, { checks, zone, snap }), id, zone };
}

// ── the ops ──

export async function liveOp(account, op, body = {}, deps = {}) {
  const storage = account.storage;
  const now = account.now();
  const env = body.env === 'sandbox' ? 'sandbox' : 'production';
  const trip = body.trip == null ? null : String(body.trip);
  const date = body.day == null ? null : String(body.day);
  if (trip !== null && !TRIP_ID.test(trip)) throw new TripError('trip must be a trip id.');
  if (date !== null && !DAY.test(date)) throw new TripError('day must be a date (yyyy-mm-dd).');
  if (op === 'trip-live-token') {
    const token = body.token == null ? null : String(body.token).toLowerCase();
    const start = body.push_to_start == null ? null : String(body.push_to_start).toLowerCase();
    if (token === null && start === null) throw new TripError('Send the activity’s push token, its push-to-start token, or both.');
    if ((token !== null && !TOKEN.test(token)) || (start !== null && !TOKEN.test(start))) throw new TripError("That isn't a push token.");
    if (token !== null) {
      if (!trip || !date) throw new TripError('An activity’s token needs its trip and day.');
      const t = await storage.get(`trip:${trip}`);
      if (!t) throw new TripError('There is no such trip.', 404, 'not_found');
      if (!t.days.some((_, j) => dayDate(t, j) === date)) throw new TripError('That day isn’t on this trip.');
      const old = (await storage.get(recKey(trip, date))) || {};
      // the same day's activity (a token Apple rotated, or one this server started): what it shows is kept
      await storage.put(recKey(trip, date), { trip, date, sent: null, told: [], ...old, token, env, at: now, ended: false, done: false });
    }
    if (start !== null) await storage.put('tlivestart', { token: start, env, at: now });
    return { ok: true, next: await armLive(account, deps) };
  }
  if (op === 'trip-live-end') {
    if (trip && date) {
      const old = (await storage.get(recKey(trip, date))) || { trip, date, sent: null, told: [] };
      await storage.put(recKey(trip, date), { ...old, token: null, ended: true, at: now }); // off for the rest of that day
    }
    if (body.never === true) await storage.delete('tlivestart');
    await armLive(account, deps);
    return { ended: true };
  }
  throw new TripError('Unknown Live Activity op.', 404, 'not_found');
}

// ── the job ──

async function records(storage) {
  return [...(await storage.list({ prefix: 'tlive:' }))].map(([k, r]) => ({ key: k, ...r }));
}

/** Set the one job to the next moment anything should be pushed, or drop it. */
export async function armLive(account, { tripOp } = {}) {
  const storage = account.storage;
  const now = account.now();
  if (!ready(account)) { await unscheduleJob(account, JOB); return null; }
  let next = Infinity;
  const at = (t) => { if (Number.isFinite(t)) next = Math.min(next, Math.max(now + 1000, t)); };
  const recs = await records(storage);
  for (const r of recs) {
    if (!(r.token || r.android) || r.ended || r.done) continue;
    const plan = await planFor(account, r.trip, r.date, { tripOp });
    if (!plan || !plan.stops.some(Boolean)) { at(now); continue; } // the day went: end it now
    for (const s of plan.stops) {
      if (!s) continue;
      if (s.leave !== null && s.leave > now - LIVE.leaveLateMs && !(r.told || []).includes(s.id)) at(s.leave);
      at(s.start + 60_000 > now ? s.start + 60_000 : NaN);
    }
    if (nextIndex(plan, now) < 0) at(now); // the last stop is behind: the end goes now
  }
  const start = apnsReady(account) ? await storage.get('tlivestart') : null;
  const android = (await androids(account)).length > 0;
  if (start || android) {
    // a day the iPhone's activity is on already (or ended): not started again; one Android has: not taken up again
    const iosHas = new Set(recs.filter(iosStarted).map((r) => `${r.trip}:${r.date}`));
    const androidHas = new Set(recs.filter((r) => r.android || r.ended || r.done).map((r) => `${r.trip}:${r.date}`));
    for (const [k, trip] of await storage.list({ prefix: 'trip:' })) {
      const id = k.slice(5);
      const zone = await zoneOf(storage, id);
      for (let i = 0; i < trip.days.length; i++) {
        const key = `${id}:${dayDate(trip, i)}`;
        if (!(start && !iosHas.has(key)) && !(android && !androidHas.has(key))) continue;
        const p = dayPlan(trip, i, { zone });
        const first = p.stops.find(Boolean);
        if (!first || nextIndex(p, now) < 0) continue;
        at(first.start - LIVE.startLeadMs);
      }
    }
  }
  if (Number.isFinite(next)) await scheduleJob(account, JOB, JOB, next);
  else await unscheduleJob(account, JOB);
  return Number.isFinite(next) ? next : null;
}

// a day the iPhone's activity has (its token), had (started by push, ended, over): push-to-start leaves it alone
const iosStarted = (r) => Boolean(r.token || r.started_at || r.ended || r.done);

/** One day's record brought up to date: an update when the next stop changed, an alert at leave-by, an end after. */
async function runRecord(account, r, deps, { alert = null } = {}) {
  const storage = account.storage;
  const now = account.now();
  const plan = await planFor(account, r.trip, r.date, deps);
  const k = plan ? nextIndex(plan, now) : -1;
  if (!plan || k < 0) {
    // the day is over (or gone from the trip): an end with the day's last stop, then nothing more
    const lastK = plan ? plan.stops.reduce((acc, s, j) => (s ? j : acc), -1) : -1;
    const body = lastK >= 0 ? livePayload('end', plan, lastK, now)
      : { aps: { timestamp: unix(now), event: 'end', 'content-state': r.state || { stop: '', startsAt: ref(now), stopsAfter: 0, dayEndsAt: ref(now) }, 'dismissal-date': unix(now) } };
    // Android: the day with no next stop (the trip's own plan when the day went: just its name and date)
    const gone = plan || { title: 'Your trip', id: r.trip, day: 1, date: r.date, stops: [], count: 0, dayEnds: null, flight: null };
    const d = await deliver(account, r, body, gone, -1, 5);
    if (d.res === 'later') return 'later';
    await storage.put(r.key, { ...strip(r), token: d.token, android: d.android, done: true });
    return d.res;
  }
  const s = plan.stops[k];
  const told = r.told || [];
  const leaveNow = s.leave !== null && now >= s.leave && now < s.leave + LIVE.leaveLateMs && !told.includes(s.id);
  const why = alert || (leaveNow ? leaveAlert(s) : null);
  const state = contentState(plan, k);
  const key = JSON.stringify(state);
  if (key === r.sent && !why) return 'same';
  const d = await deliver(account, r, livePayload('update', plan, k, now, { alert: why }), plan, k, why ? 10 : 5);
  if (d.res === 'later') return 'later';
  if (d.res === 'gone') { await storage.put(r.key, { ...strip(r), token: null, android: false, done: true }); return 'gone'; }
  await storage.put(r.key, { ...strip(r), token: d.token, android: d.android, sent: key, state, told: leaveNow ? [...told, s.id] : told.filter((id) => plan.stops.some((x) => x && x.id === id)) });
  return 'sent';
}
const strip = ({ key: _k, ...r }) => r;

/** The job: each day on show brought up to date, a day due its start started, old records forgotten, the next set. */
export async function liveDue(account, deps = {}) {
  const storage = account.storage;
  const now = account.now();
  if (!ready(account)) return unscheduleJob(account, JOB);
  let retry = false;
  const recs = await adoptAndroid(account, await records(storage), now);
  for (const r of recs) {
    if (Date.parse(`${r.date}T00:00:00Z`) + (LIVE.keepDays + 1) * 86400_000 < now) { await storage.delete(r.key); continue; }
    if (!(r.token || r.android) || r.ended || r.done) continue;
    if ((await runRecord(account, r, deps)) === 'later') retry = true;
  }
  // a trip day due to start by push (iOS 17.2+), not ended by the person, not started already: the soonest one
  const start = apnsReady(account) ? await storage.get('tlivestart') : null;
  if (start) {
    const have = new Set(recs.filter(iosStarted).map((r) => `${r.trip}:${r.date}`));
    let pick = null;
    for (const [k, trip] of await storage.list({ prefix: 'trip:' })) {
      const id = k.slice(5);
      const zone = await zoneOf(storage, id);
      for (let i = 0; i < trip.days.length; i++) {
        const date = dayDate(trip, i);
        if (have.has(`${id}:${date}`)) continue;
        const p = dayPlan(trip, i, { zone });
        const first = p.stops.find(Boolean);
        if (!first || now < first.start - LIVE.startLeadMs || nextIndex(p, now) < 0) continue;
        if (!pick || first.start < pick.first) pick = { id, date, first: first.start };
      }
    }
    if (pick) {
      const plan = await planFor(account, pick.id, pick.date, deps);
      const k = plan ? nextIndex(plan, now) : -1;
      if (k >= 0) {
        const s = plan.stops[k];
        const body = livePayload('start', plan, k, now, { alert: { title: `${plan.title}: Day ${plan.day}`, body: `Next: ${s.name} at ${clockIn(s.start, plan.zone)}` } });
        const res = await send(account, start, body, 10);
        if (res === 'gone') await storage.delete('tlivestart');
        else if (res === 'later') retry = true;
        else await storage.put(recKey(pick.id, pick.date), { ...((await storage.get(recKey(pick.id, pick.date))) || {}), trip: pick.id, date: pick.date, token: null, env: start.env, at: now, started_at: now, sent: JSON.stringify(contentState(plan, k)), state: contentState(plan, k), told: [] }); // Android's `android` kept
      }
    }
  }
  await armLive(account, deps);
  if (retry) await scheduleJob(account, JOB, JOB, now + LIVE.retryMs); // not every second while Apple says no
}

/**
 * Android's Today notification: each trip day due (from 90 minutes before its first stop, a stop still ahead), not
 * ended or over, is taken up (`android: true`, sent afresh) while the account has the Travel app on Android. Returns the
 * records as they now are.
 */
async function adoptAndroid(account, recs, now) {
  if (!(await androids(account)).length) return recs;
  const storage = account.storage;
  const byKey = new Map(recs.map((r) => [`${r.trip}:${r.date}`, r]));
  const out = [...recs];
  for (const [k, trip] of await storage.list({ prefix: 'trip:' })) {
    const id = k.slice(5);
    const zone = await zoneOf(storage, id);
    for (let i = 0; i < trip.days.length; i++) {
      const date = dayDate(trip, i);
      const old = byKey.get(`${id}:${date}`);
      if (old && (old.android || old.ended || old.done)) continue;
      const p = dayPlan(trip, i, { zone });
      const first = p.stops.find(Boolean);
      if (!first || now < first.start - LIVE.startLeadMs || nextIndex(p, now) < 0) continue;
      const r = { trip: id, date, token: null, env: 'production', told: [], ...(old ? strip(old) : {}), android: true, sent: null, at: now };
      await storage.put(recKey(id, date), r);
      const kept = { key: recKey(id, date), ...r };
      if (old) out[out.indexOf(old)] = kept;
      else out.push(kept);
    }
  }
  return out;
}

/**
 * watch.js's hook: a flight's news (a gate, a terminal, a delay, cancelled) on that day's activity, its first line as
 * the alert. Call after watch.js keeps its snapshot (the gate is read from it). Returns whether a push went.
 */
export async function liveFlightNews(account, { trip, date, news }, deps = {}) {
  if (!news || !news.length || !ready(account)) return false;
  const key = recKey(trip, date);
  const r = await account.storage.get(key);
  if (!r || !(r.token || r.android) || r.ended || r.done) return false;
  return (await runRecord(account, { key, ...r }, deps, { alert: news[0] })) === 'sent';
}
