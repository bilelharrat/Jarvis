// A trip shared with the people on it: askeden.com/t/<code> (askedentravel.com/t/<code> on the travel address), a page
// anyone with the link can open without signing in. It always shows the trip as it is now: each day, each stop's time,
// place and what was checked (hours, travel times, with their sources), the day's map, and a calendar file. Never on
// it: prices, booking references, providers' links, cards, notes from Eden Mail. The owner makes, lists and ends links.
//
// Where it lives (as the flight tracker, track.js): the link in the owner's account object, `tln:<code>`; the code's
// account found from the link alone through the same index objects (`trk:<code>`). A link ends 2 days after the trip's
// last day (at most 120 days after it was made), or when revoked.
//
//   owner (trip ops, signed in): trip-link-create { id } → { code, url, expires } · trip-links { id? } → { links }
//                                trip-link-revoke { code }
//   anyone with the link (the Worker): tlink-view { code }
//   GET /t/<code>                 the page (public/travel-trip/), noindex
//   GET /t/<code>/data            → tlink-view
//   GET /t/<code>/map?day=N       that day's map picture, from its own stops (only while the link is live)
//   GET /t/<code>/calendar.ics    the trip as a calendar file (ics.js)
//   GET /t/<file>                 the page's own files (TRIP_FILES)

import { ApiError, json } from '../accounts/util.js';
import { page as pageHeaders, withHeaders } from '../eden/web.js';
import { travelOn } from './api.js';
import { flightMapImage, MapsError } from './maps.js';
import { CODE, NOINDEX, TRACK_CSP, ask, asset, index, newCode, slowDown } from './track.js';
import { dayDate } from './trips.js';

export const LINK_MAX = 20; // live trip links an account keeps at once
const AFTER_MS = 2 * 86400_000;
const LONGEST_MS = 120 * 86400_000;
export const TRIP_FILES = new Set(['trip.js', 'trip.css']);

const endOf = (trip) => Date.parse(`${dayDate(trip, Math.max(0, trip.days.length - 1))}T23:59:59Z`);

export async function linkCreate(account, body) {
  const id = String(body.id || '');
  const trip = await account.storage.get(`trip:${id}`);
  if (!trip) throw new ApiError(404, 'not_found', 'There is no such trip.');
  const now = account.now();
  const live = [...(await account.storage.list({ prefix: 'tln:' })).values()].filter((x) => x.expires > now && !x.revoked);
  if (live.length >= LINK_MAX) throw new ApiError(409, 'too_many', `At most ${LINK_MAX} trip links at once. End one first.`);
  const acct = ((await account.storage.get('account')) || {}).id;
  let code;
  for (let i = 0; i < 4 && !code; i++) {
    const c = newCode();
    const claimed = await index(account.env, c, 'tshare-index-claim', { account: acct }).catch(() => null);
    if (claimed && claimed.ok) code = c;
  }
  if (!code) throw new ApiError(503, 'unavailable', 'Couldn’t make a link just now. Try again.');
  const link = { code, trip: id, created: now, expires: Math.min(now + LONGEST_MS, Math.max(now, endOf(trip)) + AFTER_MS) };
  await account.storage.put(`tln:${code}`, link);
  return { code, url: `/t/${code}`, expires: link.expires };
}

export async function linkList(account, body = {}) {
  const now = account.now();
  const out = [];
  for (const [key, l] of await account.storage.list({ prefix: 'tln:' })) {
    if (l.expires <= now || l.revoked) { if (now - l.expires > 7 * 86400_000) await account.storage.delete(key); continue; }
    if (body.id && l.trip !== body.id) continue;
    out.push({ code: l.code, url: `/t/${l.code}`, trip: l.trip, created: l.created, expires: l.expires });
  }
  return { links: out.sort((a, b) => b.created - a.created) };
}

export async function linkRevoke(account, body) {
  const key = `tln:${String(body.code || '')}`;
  const l = await account.storage.get(key);
  if (!l) throw new ApiError(404, 'not_found', 'No such link.');
  l.revoked = true;
  l.expires = Math.min(l.expires, account.now());
  await account.storage.put(key, l);
  await index(account.env, l.code, 'tshare-index-drop', {}).catch(() => {});
  return { revoked: true };
}

/** What the people on the trip see: the plan and what was checked, nothing private (no prices, references, links). */
export function guestView(trip, checks) {
  const badge = (b) => (b ? { status: b.status, text: b.text, source: b.source || null, checked_at: b.checked_at || null } : null);
  return {
    title: trip.title,
    start: trip.start,
    travelers: trip.travelers,
    checked_at: checks.checked_at,
    maps: checks.maps,
    days: trip.days.map((d, i) => {
      const c = checks.days[i] || { stops: [] };
      return {
        title: d.title || null,
        date: c.date || dayDate(trip, i),
        pace: c.pace || null,
        stops: d.stops.map((s, k) => {
          const v = c.stops[k] || { badges: {} };
          return {
            id: s.id, kind: s.kind, at: s.at, minutes: s.minutes, mode: s.mode || null, nights: s.nights || null,
            place: { name: s.place.name, lat: s.place.lat, lng: s.place.lng },
            booked: Boolean(s.booked), // booked or not, never the reference
            hours: badge(v.badges && v.badges.hours), travel: badge(v.badges && v.badges.travel),
          };
        }),
      };
    }),
    alerts: (checks.alerts || []).map((a) => ({ day: a.day, stop: a.stop, text: a.text })),
  };
}

/** The account object's public side for trip links. `deps.tripOp`: travel/ops.js. */
export async function linkPublicOp(account, op, body, { tripOp }) {
  const code = String(body.code || '');
  const l = CODE.test(code) ? await account.storage.get(`tln:${code}`) : null;
  if (!l || l.revoked || l.expires <= account.now()) throw new ApiError(404, 'not_found', 'This trip link has ended.');
  if (op !== 'tlink-view') throw new ApiError(404, 'not_found', 'Not found');
  let got;
  try { got = await tripOp(account, 'trip-get', { id: l.trip }); } catch (e) { if (e && e.status === 404) throw new ApiError(404, 'not_found', 'This trip was deleted.'); throw e; }
  return { trip: guestView(got.trip, got.checks), expires: l.expires, tripRaw: body.raw === true ? got.trip : undefined };
}

/** GET /t/…: the page, its files, its data, the map and the calendar file. Null: not ours. */
export async function tripLinkPage(request, env, path, { tripToIcs } = {}) {
  const m = /^\/t\/([a-z0-9]{12})(?:\/(data|map|calendar\.ics))?$/.exec(path);
  if (!m) {
    const file = path.slice(3);
    if (!TRIP_FILES.has(file)) return null;
    return withHeaders(await asset(env, request, `/travel-trip/${file}`), { 'cache-control': 'public, no-cache', 'x-content-type-options': 'nosniff' });
  }
  if (!travelOn(env)) return null;
  const [, code, part] = m;
  if (!part) return withHeaders(pageHeaders(await asset(env, request, '/travel-trip/'), TRACK_CSP), NOINDEX);
  if (request.method !== 'GET') throw new ApiError(405, 'bad_request', 'GET');
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  try {
    await slowDown(env, 'API_RATE', `tln-ip:${ip}`);
    const { account } = await index(env, code, 'tshare-index-get');
    if (part === 'data') return withHeaders(json(await ask(env, account, 'tlink-view', { code })), NOINDEX);
    if (part === 'map') {
      // the day's own stops only (built here from the trip, never points from the request): not a map of anywhere on Eden's key
      const view = await ask(env, account, 'tlink-view', { code });
      const day = view.trip.days[Math.max(0, Math.min(view.trip.days.length - 1, Number(new URL(request.url).searchParams.get('day')) || 0))];
      const pts = (day ? day.stops : []).filter((x) => Number.isFinite(x.place.lat) && Number.isFinite(x.place.lng)).slice(0, 25).map((x) => `${x.place.lat},${x.place.lng}`);
      if (!pts.length) throw new ApiError(404, 'not_found', 'No stop on the map that day.');
      const built = new URL(`https://map.invalid/?p=${encodeURIComponent(pts.join('|'))}&w=640&h=320&style=day`);
      return withHeaders(await flightMapImage(env, built), NOINDEX);
    }
    if (!tripToIcs) throw new ApiError(404, 'not_found', 'Not found');
    const out = await ask(env, account, 'tlink-view', { code, raw: true });
    // the people on the trip get the plan only: no notes (they can hold references), links, costs or bookings
    const t = out.tripRaw;
    const plain = { title: t.title, start: t.start, days: t.days.map((d) => ({ title: d.title, stops: d.stops.map((x) => ({ id: x.id, kind: x.kind, at: x.at, minutes: x.minutes, nights: x.nights, place: { name: x.place.name, lat: x.place.lat, lng: x.place.lng } })) })) }; // named fields only
    const ics = tripToIcs(plain, { id: code, now: Date.now() });
    return new Response(ics, { headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="trip.ics"', 'cache-control': 'private, no-cache', ...NOINDEX } });
  } catch (e) {
    if (e instanceof MapsError) return withHeaders(json({ error: e.message, code: e.code }, 502), NOINDEX);
    if (e instanceof ApiError) return withHeaders(e.response(), NOINDEX);
    throw e;
  }
}
