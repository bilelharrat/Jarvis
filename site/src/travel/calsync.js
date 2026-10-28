// Eden Travel in the traveller's own calendar, two ways:
//
// 1. A private subscription link (any calendar: Apple Calendar, Google Calendar, Outlook): GET /c/<code>.ics is every trip
//    of the account as it is now, one event per stop (ics.js), refreshed by the calendar app itself. The code (32 letters
//    and digits, 160 bits) is the only key: it never ends by itself, and making a new one (or switching it off) ends the old.
//    Where it lives, like a trip link (triplink.js): `tcf:<code>` and `tcf:current` in the account object, the code's
//    account found through the index object `cal:<code>` (track.js's tshare-index-* ops).
//      trip-calfeed → { url, webcal, google, outlook } or { url: null } · trip-calfeed-create · trip-calfeed-revoke
//      anyone with the link (the Worker): tcal-feed { code } → the calendar text
//
// 2. Google Calendar directly (Eden's own Google connection, accounts/schedule.js googleInAccount): each stop of one trip
//    an event in a Google calendar the person picks, written only when they press the button (the first time, and Update
//    after the trip changed: the status counts what changed since); stops taken out are deleted then, and stopping deletes
//    them all. Google needs a time zone for a timed event: the trip's, from its first stop (Places' timeZone, or the Time
//    Zone API), so 10:00 at a museum in Lisbon is 10:00 in Lisbon.
//      trip-gcal-calendars → the calendars it can write to · trip-gcal-status { id } → … pending
//      trip-gcal-sync { id, calendarId, confirm: true } · trip-gcal-off { id, confirm: true }
//
// Both carry named fields only (as a trip link's file, triplink.js): the trip's title and dates, each stop's place, time
// and length. Never notes, links, costs or booking references: a calendar is copied into other apps and kept.

import { ApiError } from '../accounts/util.js';
import { googleInAccount, calendarScopesOk } from '../accounts/schedule.js';
import { runCalendarAction } from '../eden/vendor/google.js';
import { travelOn } from './api.js';
import { tripToIcs } from './ics.js';
import { ALPHA, ask, slowDown, NOINDEX } from './track.js';
import { dayDate, minutesOf } from './trips.js';

export const FEED_CODE = /^[a-z0-9]{32}$/;
const newFeedCode = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => ALPHA[b % ALPHA.length]).join('');
const feedIndex = (env, code, op, body = {}) => ask(env, `cal:${code}`, op, body);
const GKEY = (trip) => `gcal:${trip}`;

// ── 1. the subscription link ──

function feedView(rec) {
  if (!rec) return { url: null };
  const url = `${rec.origin}/c/${rec.code}.ics`;
  const webcal = url.replace(/^https?:/, 'webcal:');
  return {
    url, webcal, created: rec.created,
    // each calendar's own "subscribe from a link" page
    google: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`,
    outlook: `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(url)}&name=${encodeURIComponent('Eden Travel')}`,
  };
}

async function feedCreate(account, body) {
  const origin = String(body.origin || '');
  if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) throw new ApiError(400, 'bad_request', 'No address for the link.');
  await feedRevoke(account); // one link at a time: a new one ends the old
  const acct = ((await account.storage.get('account')) || {}).id;
  let code;
  for (let i = 0; i < 4 && !code; i++) {
    const c = newFeedCode();
    const claimed = await feedIndex(account.env, c, 'tshare-index-claim', { account: acct }).catch(() => null);
    if (claimed && claimed.ok) code = c;
  }
  if (!code) throw new ApiError(503, 'unavailable', 'Couldn’t make a calendar link just now. Try again.');
  const rec = { code, origin, created: account.now() };
  await account.storage.put({ [`tcf:${code}`]: rec, 'tcf:current': code });
  return feedView(rec);
}

async function feedRevoke(account) {
  const code = await account.storage.get('tcf:current');
  if (!code) return { revoked: false };
  await account.storage.delete([`tcf:${code}`, 'tcf:current']);
  await feedIndex(account.env, code, 'tshare-index-drop').catch(() => {});
  return { revoked: true };
}

/** The trip with named fields only (as triplink.js gives the people on it): nothing private goes into a calendar. */
export const plainTrip = (t, id = t.id) => ({ id, title: t.title, start: t.start, days: (t.days || []).map((d) => ({ title: d.title, stops: (d.stops || []).map((x) => ({ id: x.id, kind: x.kind, at: x.at, minutes: x.minutes, nights: x.nights, place: { name: x.place && x.place.name, lat: x.place && x.place.lat, lng: x.place && x.place.lng } })) })) });

/** Every trip of the account in one calendar (each trip's events from ics.js, under one name). */
export function tripsToIcs(trips, { now = Date.now() } = {}) {
  const events = [];
  for (const trip of trips) {
    const lines = tripToIcs(trip, { id: trip.id, now }).split('\r\n');
    let inEvent = false;
    for (const line of lines) {
      if (line === 'BEGIN:VEVENT') inEvent = true;
      if (inEvent) events.push(line);
      if (line === 'END:VEVENT') inEvent = false;
    }
  }
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ask Eden//Eden Travel//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Eden Travel', 'X-WR-CALDESC:Your trips from Ask Eden Travel', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
    ...events, 'END:VCALENDAR'].join('\r\n') + '\r\n';
}

/** The account object's public side (no device: anyone holding the code). `deps.tripOp`: travel/ops.js. */
export async function feedPublicOp(account, op, body, { tripOp }) {
  const code = String(body.code || '');
  const rec = FEED_CODE.test(code) ? await account.storage.get(`tcf:${code}`) : null;
  if (!rec || op !== 'tcal-feed') throw new ApiError(404, 'not_found', 'This calendar link was switched off.');
  const list = (await tripOp(account, 'trip-list', {})).trips || [];
  const trips = [];
  for (const t of list.slice(0, 50)) {
    try {
      // named fields only, as the trip link's calendar (triplink.js): a subscription link gets copied into other apps and
      // kept, and a stop's note can hold a booking reference, so no notes, links, costs or bookings
      const x = (await tripOp(account, 'trip-get', { id: t.id })).trip;
      trips.push({ id: t.id, title: x.title, start: x.start, days: x.days.map((d) => ({ title: d.title, stops: d.stops.map((st) => ({ id: st.id, kind: st.kind, at: st.at, minutes: st.minutes, nights: st.nights, place: { name: st.place.name, lat: st.place.lat, lng: st.place.lng } })) })) });
    } catch { /* a trip gone meanwhile */ }
  }
  return { ics: tripsToIcs(trips, { now: account.now() }) };
}

/** GET /c/<code>.ics (pages.js): the calendar, for the calendar app that subscribed. Null: not ours. */
export async function calFeedPage(request, env, path) {
  const m = /^\/c\/([a-z0-9]{32})\.ics$/.exec(path);
  if (!m || !travelOn(env)) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(405, 'bad_request', 'GET');
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  try {
    await slowDown(env, 'API_RATE', `tcf-ip:${ip}`);
    const { account } = await feedIndex(env, m[1], 'tshare-index-get');
    const { ics } = await ask(env, account, 'tcal-feed', { code: m[1] });
    return new Response(request.method === 'HEAD' ? null : ics, { headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'inline; filename="eden-travel.ics"', 'cache-control': 'private, max-age=300', ...NOINDEX } });
  } catch (e) {
    if (e instanceof ApiError) return new Response('This calendar link was switched off.', { status: e.status === 404 ? 404 : e.status, headers: { 'content-type': 'text/plain; charset=utf-8', ...NOINDEX } });
    throw e;
  }
}

// ── 2. Google Calendar ──

/** The offset of `zone` at a wall-clock time there, as +HH:MM (DST included). */
export function offsetAt(date, minutes, zone) {
  const guess = Date.parse(`${date}T00:00:00Z`) + minutes * 60_000;
  const parts = (ms) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const wallOf = (ms) => { const p = parts(ms); return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`); };
  let off = wallOf(guess) - guess; // first guess, then once more at the instant it gives (the hour a clock changes)
  off = wallOf(guess - off) - (guess - off);
  const m = Math.round(off / 60_000), sign = m < 0 ? '-' : '+', a = Math.abs(m);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/** The trip's time zone (IANA), from its first stop Google knows: Places' timeZone, else the Time Zone API at its spot. */
async function tripZone(account, trip, fetcher) {
  const kept = await account.storage.get(`tz:${trip.id}`);
  if (kept) return kept;
  const key = String(account.env.GOOGLE_MAPS_SERVER_KEY || '').trim();
  const stops = trip.days.flatMap((d) => d.stops);
  let zone = null;
  if (key) {
    for (const s of stops) {
      const id = String(s.place && s.place.id || '');
      if (!/^[A-Za-z0-9_-]{10,300}$/.test(id) || id.startsWith('standin')) continue;
      const r = await fetcher(`https://places.googleapis.com/v1/places/${id}`, { headers: { 'x-goog-api-key': key, 'x-goog-fieldmask': 'timeZone' } }).catch(() => null);
      const j = r && r.ok ? await r.json().catch(() => ({})) : {};
      if (j.timeZone && j.timeZone.id) { zone = j.timeZone.id; break; }
    }
    const at = !zone && stops.find((s) => s.place && Number.isFinite(s.place.lat) && Number.isFinite(s.place.lng));
    if (at) {
      const r = await fetcher(`https://maps.googleapis.com/maps/api/timezone/json?location=${at.place.lat},${at.place.lng}&timestamp=${Math.floor(Date.parse(`${trip.start}T12:00:00Z`) / 1000)}&key=${encodeURIComponent(key)}`).catch(() => null);
      const j = r && r.ok ? await r.json().catch(() => ({})) : {};
      if (j.status === 'OK' && j.timeZoneId) zone = j.timeZoneId;
    }
  }
  if (!zone) throw new ApiError(409, 'no_time_zone', 'Eden couldn’t tell this trip’s time zone (its places aren’t on Google Maps yet). Add a real place first, or use the calendar link instead.');
  await account.storage.put(`tz:${trip.id}`, zone);
  return zone;
}

/** One stop as a Google Calendar event: timed in the trip's zone, a stay all day over its nights. */
export function stopEvent(trip, d, s, zone) {
  const date = dayDate(trip, d);
  const base = { title: s.place && s.place.name || 'Stop', location: s.place && s.place.name || undefined, notes: 'From Ask Eden Travel' }; // never the stop's own notes
  if (s.kind === 'stay' && Number.isInteger(s.nights) && s.nights > 0) {
    const end = new Date(Date.parse(`${date}T00:00:00Z`) + s.nights * 86400_000).toISOString().slice(0, 10);
    return { ...base, allDay: true, start: date, end };
  }
  const startMin = minutesOf(s.at);
  const endMin = startMin + Math.max(15, Number(s.minutes) || 0); // Google needs an end after the start
  const at = (mins) => {
    const t = new Date(Date.parse(`${date}T00:00:00Z`) + mins * 60_000).toISOString().slice(0, 16);
    return `${t}:00${offsetAt(t.slice(0, 10), Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16)), zone)}`;
  };
  return { ...base, allDay: false, start: at(startMin), end: at(endMin), timeZone: zone };
}

/** Eden's Google Calendar, and the calendars it may write to (never a read-only one). */
async function googleCalendars(account, deps) {
  const google = deps.google ? await deps.google(account) : await googleInAccount(account);
  if (!calendarScopesOk(google.scopes)) throw new ApiError(409, 'not_connected', 'Connect Google Calendar to Eden first (Settings › Google), then turn this on.');
  const api = google.calendar();
  const writable = (await api.calendars()).filter((c) => !c.readOnly);
  return { api, writable, email: google.email };
}

/** The calendar the person picked, still one Eden may write to. */
async function googleCalendar(account, deps, calendarId) {
  const { api, writable } = await googleCalendars(account, deps);
  const cal = writable.find((c) => c.id === calendarId);
  if (!cal) throw new ApiError(400, 'bad_request', 'Pick one of your Google calendars to add the trip to.');
  return { api, cal };
}

/** What would change in Google: stops new, changed or taken out since the last sync (no call to Google). */
async function pending(account, tripId, on, deps) {
  const zone = await account.storage.get(`tz:${tripId}`);
  if (!zone) return null;
  const plain = plainTrip((await deps.tripOp(account, 'trip-get', { id: tripId })).trip, tripId);
  const events = on.events || {};
  let n = 0;
  const seen = new Set();
  plain.days.forEach((day, d) => day.stops.forEach((s) => { seen.add(s.id); const was = events[s.id]; if (!was || was.sig !== JSON.stringify(stopEvent(plain, d, s, zone))) n++; }));
  for (const stop of Object.keys(events)) if (!seen.has(stop)) n++;
  return n;
}

/** Writes the trip to Google Calendar: new stops added, changed ones updated, removed ones deleted. */
export async function gcalWrite(account, tripId, deps) {
  const on = await account.storage.get(GKEY(tripId));
  if (!on) return null;
  const raw = (await deps.tripOp(account, 'trip-get', { id: tripId })).trip;
  const zone = await tripZone(account, { ...raw, id: tripId }, deps.fetch || fetch); // the places' Google ids: for the zone only
  const trip = plainTrip(raw, tripId); // what Google is given: named fields only
  const { api, cal } = await googleCalendar(account, deps, on.calendarId);
  const act = deps.calendarAction || runCalendarAction;
  const events = { ...(on.events || {}) }; // stop id → { id, sig }
  const seen = new Set();
  let added = 0, updated = 0, removed = 0;
  for (const [d, day] of trip.days.entries()) {
    for (const s of day.stops) {
      seen.add(s.id);
      const event = stopEvent(trip, d, s, zone);
      const sig = JSON.stringify(event);
      const was = events[s.id];
      if (was && was.sig === sig) continue;
      if (was) {
        try { await act(api, 'update', { calendarId: cal.id, id: was.id, event, confirm: true }); events[s.id] = { id: was.id, sig }; updated++; continue; }
        catch (e) { if (!(e && e.code === 'not_found')) throw e; } // deleted in Google: made again
      }
      const made = await act(api, 'create', { calendarId: cal.id, event, confirm: true });
      events[s.id] = { id: made.event.id, sig };
      added++;
    }
  }
  for (const [stop, ev] of Object.entries(events)) {
    if (seen.has(stop)) continue;
    await act(api, 'delete', { calendarId: cal.id, id: ev.id, confirm: true }).catch((e) => { if (!(e && e.code === 'not_found')) throw e; });
    delete events[stop];
    removed++;
  }
  const rec = { ...on, events, calendar: cal.title || 'Google Calendar', calendarId: cal.id, zone, synced: account.now() };
  await account.storage.put(GKEY(tripId), rec);
  return { on: true, calendar: rec.calendar, zone, synced: rec.synced, added, updated, removed, events: Object.keys(events).length };
}

/** The account object's side: trip-calfeed*, trip-gcal-*. `deps`: { tripOp, google?, fetch?, calendarAction? } (the last three: tests) */
export async function calOp(account, op, body, deps) {
  if (op === 'trip-calfeed') { const code = await account.storage.get('tcf:current'); return feedView(code ? await account.storage.get(`tcf:${code}`) : null); }
  if (op === 'trip-calfeed-create') return feedCreate(account, body);
  if (op === 'trip-calfeed-revoke') return feedRevoke(account);
  if (op === 'trip-gcal-calendars') {
    const { writable, email } = await googleCalendars(account, deps);
    return { email, calendars: writable.map((c) => ({ id: c.id, title: c.title, primary: Boolean(c.primary) })) };
  }
  const id = String(body.id || '');
  if (!id) throw new ApiError(400, 'bad_request', 'Which trip?');
  if (op === 'trip-gcal-status') {
    const on = await account.storage.get(GKEY(id));
    return on ? { on: true, calendar: on.calendar || null, calendarId: on.calendarId || null, synced: on.synced || null, events: Object.keys(on.events || {}).length, pending: await pending(account, id, on, deps).catch(() => null) } : { on: false };
  }
  if (op === 'trip-gcal-sync') {
    if (body.confirm !== true) throw new ApiError(400, 'bad_request', 'Syncing to Google Calendar needs confirm: true (the person pressed it).');
    await deps.tripOp(account, 'trip-get', { id }); // a trip of this account (404 otherwise)
    const was = await account.storage.get(GKEY(id));
    // the calendar the person picked (the first time); later updates write to the same one
    const calendarId = (was && was.calendarId) || String(body.calendarId || '');
    if (!calendarId) throw new ApiError(400, 'bad_request', 'Pick one of your Google calendars to add the trip to.');
    await googleCalendar(account, deps, calendarId);
    await account.storage.put(GKEY(id), { ...(was || { events: {} }), on: true, calendarId, since: (was && was.since) || account.now() });
    try { return await gcalWrite(account, id, deps); } catch (e) { if (!was) await account.storage.delete(GKEY(id)); throw e; }
  }
  if (op === 'trip-gcal-off') {
    if (body.confirm !== true) throw new ApiError(400, 'bad_request', 'Turning off needs confirm: true.');
    const on = await account.storage.get(GKEY(id));
    if (!on) return { on: false, removed: 0 };
    let removed = 0;
    const { api } = await googleCalendars(account, deps).catch(() => ({}));
    for (const ev of Object.values(on.events || {})) {
      if (!api) break;
      await (deps.calendarAction || runCalendarAction)(api, 'delete', { calendarId: on.calendarId, id: ev.id, confirm: true }).then(() => removed++, () => {});
    }
    await account.storage.delete(GKEY(id));
    return { on: false, removed };
  }
  throw new ApiError(404, 'not_found', 'Unknown calendar action.');
}
