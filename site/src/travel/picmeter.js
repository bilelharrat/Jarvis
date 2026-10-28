// Pictures on Eden's Google key (the stop photos and the in-flight map: maps.js placePhoto, flightMapImage), charged to
// the account that asked, not only to the global day (security review M1, 2026-10-28): one Plus account looping
// /api/chat/travel/photo could otherwise spend the whole TRAVEL_GOOGLE_DAILY_USD for everyone in minutes. And a photo
// only of a place this account was shown: one on its own trips, or one Eden named to it lately (notePhotos: places,
// discover, nearby, a shared trip's stops), never any Google photo on Eden's key.
//
//   trip-pic-take  { kind: 'photo'|'map', n? }  → { ok: true } | 429 capped (the account's or the global cap) | 404 not yours
//   trip-pic-note  { names }                     → { ok: true }  (the Worker only, after a shared trip's answer: never in
//                                                  api.js ACTIONS, or a page could name any photo)
//
// And a daily count for the model calls a page can repeat at will (takeDaily: trip-decisions, trip-windows).
//
// Stored (the account's object): tpicseen → { [name]: at } (at most PICS.seenMax, each PICS.seenMs) ·
// tday:<kind> → { day, n }.

import { TripError } from './trips.js';
import { spendMeter } from './spend.js';

export const PICS = { seenMax: 600, seenMs: 14 * 86400_000 };
// a day's (UTC) calls per account: Decisions is a Haiku call per press, booking windows a page fetch and a model read
export const DAILY = { decisions: 200, windows: 100 };
const NAME = /^places\/[A-Za-z0-9_-]{10,300}\/photos\/[A-Za-z0-9_-]{10,1000}$/;
const SKU = { photo: 'photo', map: 'static_map' };

/** Photo names Eden showed this account (from a lookup's answer): kept so the photo proxy serves them. Never throws. */
export async function notePhotos(account, names) {
  try {
    const fresh = [...new Set((Array.isArray(names) ? names : []).filter((n) => NAME.test(String(n))))];
    if (!fresh.length) return;
    const now = account.now();
    const seen = (await account.storage.get('tpicseen')) || {};
    for (const n of fresh) seen[n] = now;
    const kept = Object.entries(seen).filter(([, at]) => now - at < PICS.seenMs).sort((a, b) => b[1] - a[1]).slice(0, PICS.seenMax);
    await account.storage.put('tpicseen', Object.fromEntries(kept));
  } catch (e) { console.error('travel photos seen', e && e.message); }
}

/** The names of photos found in any value (a lookup's answer, a trip): { photo: { name } } and { photos: [{ name }] }. */
export function photoNames(value, out = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8 || out.size > 400) return out;
  if (Array.isArray(value)) { for (const v of value) photoNames(v, out, depth + 1); return out; }
  for (const [k, v] of Object.entries(value)) {
    if ((k === 'photo' || k === 'photos') && v) for (const p of [].concat(v)) if (p && NAME.test(String(p.name))) out.add(p.name);
    if (v && typeof v === 'object') photoNames(v, out, depth + 1);
  }
  return out;
}

async function onOwnTrips(account, name) {
  for (const [, trip] of await account.storage.list({ prefix: 'trip:' })) {
    if (trip && Array.isArray(trip.days) && trip.days.some((d) => (d.stops || []).some((s) => s.photo && s.photo.name === name))) return true;
  }
  return false;
}

export async function picOp(account, op, body = {}) {
  if (op === 'trip-pic-note') { await notePhotos(account, Array.isArray(body.names) ? body.names.slice(0, 400) : []); return { ok: true }; }
  if (op !== 'trip-pic-take') throw new TripError('Unknown trip op.', 404, 'not_found');
  const kind = String(body.kind || '');
  if (!Object.hasOwn(SKU, kind)) throw new TripError('kind must be photo or map.');
  if (kind === 'photo') {
    const n = String(body.n || '');
    if (!NAME.test(n)) throw new TripError('n must be a Google place photo name.');
    const seen = (await account.storage.get('tpicseen')) || {};
    const lately = Object.hasOwn(seen, n) && account.now() - seen[n] < PICS.seenMs;
    if (!lately && !(await onOwnTrips(account, n))) throw new TripError('No such photo in your Eden Travel.', 404, 'not_found');
  }
  const held = await spendMeter(account).take(SKU[kind]); // the account's day ($3) and the global day ($20)
  if (held) throw new TripError(held.note || 'Eden’s Google allowance for today is used up.', 429, 'capped');
  return { ok: true };
}

/** One more call of `kind` today (UTC) on this account, or 429 past DAILY[kind]. */
export async function takeDaily(account, kind) {
  const cap = DAILY[kind];
  if (!cap) return;
  const day = new Date(account.now()).toISOString().slice(0, 10);
  const key = `tday:${kind}`;
  const rec = await account.storage.get(key);
  const n = rec && rec.day === day ? rec.n : 0;
  if (n >= cap) throw new TripError(`That’s today’s ${cap} for this. It starts again at midnight UTC.`, 429, 'rate_limited');
  await account.storage.put(key, { day, n: n + 1 });
}
