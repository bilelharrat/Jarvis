// Share flight tracking: askeden.com/f/<code>, a page anyone with the link can open without signing in, for whoever
// is picking the traveller up. It shows the traveller's first name, the flight, the live map (FlightAware) and the
// airport pickup planner (pickup.js); the driver picks a spot and it goes to the traveller: saved on the share, and
// pushed to the traveller's iPhone (Apple holds the notification while the phone is offline, on a plane without
// wifi, and delivers it as soon as it reconnects). Nothing else of the trip is on the page.
//
// Where it lives (as shared chats, accounts/shared-chats.js): the share in the owner's account object, `tsh:<code>`;
// to find the account from the link alone, an account-namespace object named `trk:<code>` holds { account } only.
// A share ends 2 hours after the flight lands (or 3 days after it was made, whichever is first), or when revoked.
//
//   owner (trip ops, signed in): trip-share-create { ident, date, first_name, trip?, stop? } → { code, url, expires }
//                                trip-shares {} → { shares }   trip-share-revoke { code }
//   anyone with the link (the Worker): tshare-view { code } · tshare-options { code, from } · tshare-pick { code, index, note, name }
//   GET  /f/<code>            the page (public/travel-track/), noindex
//   GET  /f/<code>/data       → tshare-view          POST /f/<code>/options { from: { lat, lng } | { text } } → tshare-options
//   GET  /f/<code>/map?a=&b=  the map picture       POST /f/<code>/pick { index, note, name } → tshare-pick
//   GET  /f/<file>            the page's own files (TRACK_FILES), anyone

import { ApiError, json } from '../accounts/util.js';
import { page as pageHeaders, withHeaders } from '../eden/web.js';
import { travelOn } from './api.js';
import { flightMapImage, mapsFor, MapsError } from './maps.js';
import { OPTIONS_MS, pickupOptions } from './pickup.js';

export const CODE = /^[a-z0-9]{12}$/;
export const SHARE_MAX = 10; // live shares an account keeps at once
const KEEP_MS = 3 * 86400_000;
const AFTER_LANDING_MS = 2 * 3600_000;
export const TRACK_FILES = new Set(['track.js', 'track.css', 'trip-tools.js']);
const NOINDEX = { 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' };
export const TRACK_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const ALPHA = 'abcdefghijkmnpqrstuvwxyz23456789'; // no l/o/0/1 to misread when read aloud
const newCode = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => ALPHA[b % ALPHA.length]).join('');
const text = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** The share once its flight is known to have landed: gone 2 hours later. */
function expiresFor(share, flight, now) {
  const landed = flight && Date.parse((flight.arrival && (flight.arrival.actual || flight.arrival.estimated)) || '');
  return Math.min(share.created + KEEP_MS, Number.isFinite(landed) ? landed + AFTER_LANDING_MS : Infinity);
}

/* ---------- in the owner's account object ---------- */

export async function shareCreate(account, body, { tripOp }) {
  const ident = String(body.ident || '').toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/.test(ident)) throw new ApiError(400, 'bad_request', 'ident must be a flight number like TP1351.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date || ''))) throw new ApiError(400, 'bad_request', 'date must be YYYY-MM-DD.');
  const first = text(body.first_name, 40).split(' ')[0];
  if (!first) throw new ApiError(400, 'bad_request', 'first_name: the name the driver will see.');
  const now = account.now();
  const live = [...(await account.storage.list({ prefix: 'tsh:' })).values()].filter((x) => x.expires > now && !x.revoked);
  if (live.length >= SHARE_MAX) throw new ApiError(409, 'too_many', `At most ${SHARE_MAX} tracking links at once. Revoke one first.`);
  // the flight must exist (and FlightAware be on) before a link is handed out
  await tripOp(account, 'trip-flight', { ident, date: body.date });
  const id = ((await account.storage.get('account')) || {}).id;
  let code;
  for (let i = 0; i < 4 && !code; i++) {
    const c = newCode();
    const claimed = await index(account.env, c, 'tshare-index-claim', { account: id }).catch(() => null);
    if (claimed && claimed.ok) code = c;
  }
  if (!code) throw new ApiError(503, 'unavailable', 'Couldn’t make a link just now. Try again.');
  const share = { code, ident, date: body.date, first_name: first, trip: text(body.trip, 16) || null, stop: text(body.stop, 40) || null, created: now, expires: now + KEEP_MS, pickup: null, seen: null };
  await account.storage.put(`tsh:${code}`, share);
  return { code, url: `/f/${code}`, expires: share.expires };
}

export async function shareList(account) {
  const now = account.now();
  const out = [];
  for (const [key, s] of await account.storage.list({ prefix: 'tsh:' })) {
    if (s.expires <= now || s.revoked) { if (now - s.expires > 7 * 86400_000) await account.storage.delete(key); continue; }
    out.push({ code: s.code, url: `/f/${s.code}`, ident: s.ident, date: s.date, first_name: s.first_name, trip: s.trip, stop: s.stop, expires: s.expires, pickup: s.pickup });
  }
  // the flyer has now seen their pickups (the app shows them): marked once
  for (const s of out) if (s.pickup && !s.pickup.seen_at) { const k = `tsh:${s.code}`; const v = await account.storage.get(k); v.pickup.seen_at = now; await account.storage.put(k, v); }
  return { shares: out.sort((a, b) => b.expires - a.expires) };
}

export async function shareRevoke(account, body) {
  const key = `tsh:${String(body.code || '')}`;
  const s = await account.storage.get(key);
  if (!s) throw new ApiError(404, 'not_found', 'No such link.');
  s.revoked = true;
  s.expires = Math.min(s.expires, account.now());
  await account.storage.put(key, s);
  await index(account.env, s.code, 'tshare-index-drop', {}).catch(() => {});
  return { revoked: true };
}

/** The account object's public side (no device: anyone holding the code). `deps`: { tripOp, maps?, notify? } */
export async function sharePublicOp(account, op, body, deps) {
  const now = account.now();
  if (op.startsWith('tshare-index-')) {
    const rec = await account.storage.get('tsidx');
    if (op === 'tshare-index-get') { if (!rec) throw new ApiError(404, 'not_found', 'No such link.'); return { account: rec.account }; }
    if (op === 'tshare-index-claim') { if (rec) return { ok: false }; await account.storage.put('tsidx', { account: String(body.account || '') }); return { ok: true }; }
    if (op === 'tshare-index-drop') { await account.storage.delete('tsidx'); return { dropped: true }; }
  }
  const code = String(body.code || '');
  const key = `tsh:${code}`;
  const s = CODE.test(code) ? await account.storage.get(key) : null;
  if (!s || s.revoked || s.expires <= now) throw new ApiError(404, 'not_found', 'This tracking link has ended.');
  const live = await deps.tripOp(account, 'trip-flight-live', { ident: s.ident, date: s.date });
  const ends = expiresFor(s, live.flight, now);
  if (ends !== s.expires) { s.expires = ends; await account.storage.put(key, s); }
  if (ends <= now) throw new ApiError(404, 'not_found', 'This tracking link has ended.');
  switch (op) {
    case 'tshare-view':
      return { first_name: s.first_name, ident: s.ident, date: s.date, live, expires: s.expires, pickup: s.pickup ? { label: s.pickup.label, place: s.pickup.place, note: s.pickup.note, name: s.pickup.name, at: s.pickup.at, notified: Boolean(s.pickup.notified) } : null };
    case 'tshare-options': {
      if (!live.to) throw new ApiError(409, 'no_airport', 'FlightAware doesn’t say where this flight lands yet.');
      const maps = deps.maps || mapsFor(account.env);
      if (maps.mode !== 'google') throw new ApiError(503, 'not_set_up', 'The pickup planner needs Google Maps on Eden’s server.');
      let from = body.from && Number.isFinite(Number(body.from.lat)) && Number.isFinite(Number(body.from.lng)) ? { lat: Number(body.from.lat), lng: Number(body.from.lng) } : null;
      if (!from && body.from && text(body.from.text, 200).length >= 3) {
        const hit = (await maps.search(text(body.from.text, 200), { lat: live.to.lat, lng: live.to.lng }))[0];
        if (hit && Number.isFinite(hit.lat)) from = { lat: hit.lat, lng: hit.lng, name: hit.name };
      }
      if (!from) throw new ApiError(400, 'bad_request', 'Where are you coming from? Share your location or type a place.');
      // the same driver asking again soon gets the same answer (each look is several Google lookups)
      const ck = `tsopt:${code}:${from.lat.toFixed(2)},${from.lng.toFixed(2)}`;
      const hit = await account.storage.get(ck);
      if (hit && hit.until > now) return hit.v;
      const v = { from, ...(await pickupOptions({ maps, flight: live.flight, airport: live.to, origin: live.from, from, now })) };
      await account.storage.put(ck, { v, until: now + OPTIONS_MS });
      await account.storage.put(`${key}:opts`, v); // what a pick refers to
      return v;
    }
    case 'tshare-pick': {
      const opts = await account.storage.get(`${key}:opts`);
      const o = opts && opts.options[Number(body.index)];
      if (!o) throw new ApiError(409, 'stale', 'Show the pickup options again, then pick one.');
      const name = text(body.name, 40) || 'Your driver';
      const note = text(body.note, 300);
      s.pickup = { label: o.label, kind: o.kind, place: o.place, leave_by: o.leave_by, out_at: o.out_at, note, name, at: now, seen_at: null };
      await account.storage.put(key, s);
      // to the traveller's iPhone: Apple keeps it while the phone is offline and shows it the moment it reconnects
      const sent = await (deps.notify || notifyStub)(account, { title: `${name} picked where to meet`, body: `${o.label}${o.place && o.place.name && o.place.name !== o.label ? ` (${o.place.name})` : ''}${note ? ` · “${note}”` : ''}`, data: { kind: 'pickup', code } }).catch(() => 0);
      s.pickup.notified = sent > 0;
      await account.storage.put(key, s);
      return { saved: true, notified: sent };
    }
    default:
      throw new ApiError(404, 'not_found', 'Not found');
  }
}
const notifyStub = async () => 0;

/* ---------- the Worker's side ---------- */

async function ask(env, name, op, body = {}) {
  const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName(name));
  const response = await stub.fetch(`https://account/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = await response.json().catch(() => ({}));
  if (response.status >= 400) throw new ApiError(response.status, out.code || 'error', out.error || 'Something went wrong.');
  return out;
}
const index = (env, code, op, body) => ask(env, `trk:${code}`, op, body);

async function slowDown(env, binding, key) {
  const limiter = env[binding];
  if (!limiter) return;
  const { success } = await limiter.limit({ key });
  if (!success) throw new ApiError(429, 'slow_down', 'Too many tries; wait a minute.', { 'retry-after': '60' });
}

const asset = (env, request, path) => env.ASSETS.fetch(new Request(new URL(path, request.url), request));

/** GET/POST /f/…: the page, its files and its data. Null: not ours. */
export async function trackPage(request, env, path) {
  const m = /^\/f\/([a-z0-9]{12})(?:\/(data|options|pick|map))?$/.exec(path);
  if (!m) {
    const file = path.slice(3);
    if (!TRACK_FILES.has(file)) return null;
    return withHeaders(await asset(env, request, file === 'trip-tools.js' ? '/eden/trip-tools.js' : `/travel-track/${file}`), { 'cache-control': 'public, no-cache', 'x-content-type-options': 'nosniff' });
  }
  if (!travelOn(env)) return null;
  const [, code, part] = m;
  if (!part) return withHeaders(pageHeaders(await asset(env, request, '/travel-track/'), TRACK_CSP), { ...NOINDEX, 'permissions-policy': 'geolocation=(self)' });
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  try {
    await slowDown(env, 'API_RATE', `trk-ip:${ip}`);
    const { account } = await index(env, code, 'tshare-index-get');
    if (part === 'map') {
      await ask(env, account, 'tshare-view', { code }); // the link must still be live
      return withHeaders(await flightMapImage(env, new URL(request.url)), NOINDEX);
    }
    if (part === 'data' && request.method === 'GET') return withHeaders(json(await ask(env, account, 'tshare-view', { code })), NOINDEX);
    if (request.method !== 'POST') throw new ApiError(405, 'bad_request', 'POST');
    const body = await request.json().catch(() => ({}));
    if (part === 'options') {
      await slowDown(env, 'EDEN_RATE', `trk-opt:${code}`); // each look costs Google lookups: held per link
      return withHeaders(json(await ask(env, account, 'tshare-options', { code, from: body.from })), NOINDEX);
    }
    return withHeaders(json(await ask(env, account, 'tshare-pick', { code, index: body.index, note: body.note, name: body.name })), NOINDEX);
  } catch (e) {
    if (e instanceof MapsError) return withHeaders(json({ error: e.message, code: e.code }, 502), NOINDEX);
    if (e instanceof ApiError) return withHeaders(e.response(), NOINDEX);
    throw e;
  }
}
