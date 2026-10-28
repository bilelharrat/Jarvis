// Memories: a private recap of a trip once it's over, made from the trip itself and the person's own photos. The days,
// every stop (booked ones say "booked", the rest "planned": Eden doesn't know what was really visited), the straight-line
// distance between consecutive stops that have a place on the map (labelled as such, never called the road distance),
// the nights, the places, the money from money.js, and the photos, each on the day nearest when it was taken and on the
// map only where its own GPS put it. A photo without GPS is "not placed"; Eden never guesses a place or a time.
//
// The page reads each photo's EXIF itself (web/chat/travel-exif.js) and sends lat/lng/taken_at beside it; the page also
// re-encodes the picture where the browser can (so the stored copy carries no GPS of its own). The server checks the
// numbers, the type by its first bytes, and the caps. Private by default: the people on the trip (members.js) see it only
// when the organiser switches "Share with the people on the trip" on; there's no public link.
//
// Where it lives (the organiser's object): tmph:<trip>:<photo> → the photo's details · tmphb:<photo>:<n> → its bytes
// (chunks, as inbox.js documents) · tmpht:<photo> → a small thumbnail, when the page made one · tmemo:<trip> → { share }.
//
//   trip-photo-add        { id, name, type, data (base64), thumb? (base64 JPEG/PNG/WebP), lat?, lng?, taken_at?, day?, caption? } → { photo }
//   trip-photos           { id }                         → { photos }
//   trip-photo-get        { id, photo, size? 'thumb' }   → { photo, type, data (base64) }
//   trip-photo-edit       { id, photo, day?, caption? }  → { photo }   (day: the person's own choice, for a photo with no date)
//   trip-photo-delete     { id, photo }                  → { deleted }
//   trip-memories         { id }                         → the recap (recap() below), with { share }
//   trip-memories-share   { id, share: true|false }      → { share }
// A member (members.js, the organiser's object asked by the Worker), only while share is on:
//   tmember-memories      { trip, member }               → the recap (each photo `mine` when this member added it)
//   tmember-memory-photo  { trip, member, photo, size? } → as trip-photo-get
//   tmember-photo-add     { trip, member, …as trip-photo-add } → { photo }  (the same types, sizes and caps; it counts
//                         against the organiser's 200 a trip and 500 MB, and is tagged with who added it)
//   tmember-photo-delete  { trip, member, photo }        → { deleted }  (their own photos only; the organiser deletes any)
// A photo a member added keeps `by` (their account) and `by_name` (their name on the trip then); the recap says "added by".
// GET /api/chat/travel/memory-photo?id=<trip>&p=<photo>[&size=thumb][&owner=<organiser>] → the bytes (memoryPhotoRoute).

import { earnShare, photoCaps } from './rewards.js';
import { ApiError } from '../accounts/util.js';
import { distanceKm } from './maps.js';
import { dayDate } from './trips.js';
import { ask } from './track.js';

export const PHOTOS = { fileBytes: 10 * 1024 * 1024, thumbBytes: 400 * 1024, perTrip: 200, accountBytes: 500 * 1024 * 1024, chunk: 1024 * 1024, caption: 200 };
// what a photo may be, and the bytes it must start with
export const PHOTO_TYPES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/webp': (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  // ftyp with a HEIF brand (heic, heix, mif1, msf1, hevc…), not any ISO media file (an .mp4 is ftyp too)
  'image/heic': (b) => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 && /^(heic|heix|heim|heis|hevc|hevx|mif1|msf1|avif)$/.test(String.fromCharCode(b[8], b[9], b[10], b[11])),
};
const THUMB_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
// Distances: between consecutive stops in time order; places more than this apart count as separate places.
const AREA_KM = 50;
const NEAR_STOP_KM = 0.5;
const TRIP_ID = /^[0-9a-f]{16}$/;
const PHOTO_ID = /^p-[0-9a-f]{12}$/;
const ACCOUNT = /^[0-9a-f-]{36}$/;
// a photo's time as the camera wrote it: local time, with its offset when the camera knew it
const TAKEN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/;
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const latin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const round = (x, n = 1) => Math.round(x * 10 ** n) / 10 ** n;

function bytesOf(b64, what) {
  try { return latin1(atob(String(b64 || ''))); } catch { throw new ApiError(400, 'bad_request', `${what} must be the file in base64.`); }
}
function toB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin);
}
function tripId(v) {
  const id = String(v || '');
  if (!TRIP_ID.test(id)) throw new ApiError(400, 'bad_request', 'id must be a trip id.');
  return id;
}

/** A point from the page's EXIF reading, or null. 0,0 (a camera with no fix often writes it) is no point. */
export function cleanPoint(lat, lng) {
  if (lat == null || lng == null || lat === '' || lng === '') return null;
  const a = Number(lat), b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  if (a === 0 && b === 0) return null;
  return { lat: round(a, 6), lng: round(b, 6) };
}
/** The camera's time (YYYY-MM-DDTHH:MM[:SS][offset]) checked as a real date, or null. */
export function cleanTaken(v) {
  const m = TAKEN.exec(String(v || '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || (s || 0) > 59) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1) return null; // 31 April
  return String(v).trim();
}

/* ---------- the recap: pure, from the trip, its photos and (when there) trip-money ---------- */

const located = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
const dayMs = (iso) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

/** Which trip day a photo goes on: the person's own choice, else the day nearest the camera's date (its local date, as
 *  the trip's days are local dates). `outside` when it was taken more than a day before or after the trip. */
export function dayFor(trip, photo) {
  const n = trip.days.length;
  if (Number.isInteger(photo.day) && photo.day >= 0 && photo.day < n) return { day: photo.day, by: 'person', outside: false };
  if (!photo.taken_at) return null;
  const diff = Math.round((dayMs(photo.taken_at) - dayMs(trip.start)) / 86400_000);
  const day = Math.min(n - 1, Math.max(0, diff));
  return { day, by: 'time', outside: diff < -1 || diff > n };
}

export function recap(trip, photos = [], money = null, { now = Date.now() } = {}) {
  const n = trip.days.length;
  const end = dayDate(trip, n - 1);
  const ordered = []; // every stop with its day, in time order (cleanTrip keeps each day's stops sorted)
  const days = trip.days.map((d, i) => {
    const stops = d.stops.map((s) => {
      const o = { id: s.id, name: s.place.name, kind: s.kind, at: s.at, lat: located(s.place) ? s.place.lat : null, lng: located(s.place) ? s.place.lng : null, status: s.booked ? 'booked' : 'planned', nights: s.kind === 'stay' ? s.nights : null };
      ordered.push({ ...o, day: i });
      return o;
    });
    return { day: i, date: dayDate(trip, i), title: d.title, stops, km: 0, photos: [] };
  });

  // straight lines between consecutive located stops (across days too: the trip's own path)
  let km = 0, prev = null, areas = 0;
  const pts = ordered.filter((s) => located(s));
  for (const s of pts) {
    if (!prev) areas = 1;
    else {
      const leg = distanceKm(prev, s);
      km += leg;
      days[s.day].km += leg;
      if (leg > AREA_KM) areas++;
    }
    prev = s;
  }
  for (const d of days) d.km = round(d.km);

  // photos: each on its day (by the person's pick or its time), on the map only by its own GPS, near a stop when within 500 m
  const placed = [], undated = [];
  for (const p of [...photos].sort((a, b) => String(a.taken_at || '').localeCompare(String(b.taken_at || '')) || a.added - b.added)) {
    const where = dayFor(trip, p);
    const item = { id: p.id, name: p.name, caption: p.caption || '', taken_at: p.taken_at || null, lat: p.lat ?? null, lng: p.lng ?? null, on_map: located(p), thumb: Boolean(p.thumb), w: p.w || null, h: p.h || null, added_by: p.by ? 'member' : 'organiser', by_name: p.by ? p.by_name || 'Someone on the trip' : null };
    if (!where) { undated.push(item); continue; }
    item.day = where.day;
    item.day_by = where.by;
    if (where.outside) item.outside = true;
    if (item.on_map) {
      let best = null;
      for (const s of days[where.day].stops) {
        if (s.lat == null) continue;
        const dkm = distanceKm(p, s);
        if (dkm <= NEAR_STOP_KM && (!best || dkm < best.km)) best = { id: s.id, km: dkm };
      }
      if (best) item.near = best.id;
    }
    days[where.day].photos.push(item.id);
    placed.push(item);
  }

  const stays = ordered.filter((s) => s.kind === 'stay' && s.nights);
  const nightsFromStays = stays.reduce((t, s) => t + s.nights, 0);
  const places = clean(trip.destination, 120).split(/\s*(?:,|\/|→|->|–|—|&|\+|\band\b)\s*/i).map((x) => x.trim()).filter(Boolean);
  const booked = ordered.filter((s) => s.status === 'booked').length;

  return {
    title: trip.title,
    destination: trip.destination || '',
    start: trip.start,
    end,
    ended: Date.parse(`${end}T23:59:59Z`) < now,
    days,
    stats: {
      days: n,
      nights: stays.length ? nightsFromStays : Math.max(0, n - 1),
      nights_from: stays.length ? 'stays' : 'days',
      stops: ordered.length,
      booked,
      planned: ordered.length - booked,
      km: round(km),
      km_method: 'straight_line',
      km_note: 'Straight lines between stops in the order planned, not the distance travelled by road or rail.',
      located_stops: pts.length,
      places,
      places_from: 'trip destination',
      areas, // groups of stops more than 50 km apart
      areas_note: `Groups of stops more than ${AREA_KM} km apart.`,
      photos: photos.length,
      photos_on_map: placed.filter((p) => p.on_map).length + undated.filter((p) => p.on_map).length,
    },
    photos: placed,
    undated,
    money: money ? { currency: money.currency, total: money.total, budget: money.budget || null, expenses: (money.expenses || []).length, rates: money.rates || null, rates_missing: money.rates_missing || null } : null,
  };
}

/* ---------- in the organiser's object ---------- */

async function tripOf(storage, id) {
  const trip = await storage.get(`trip:${id}`);
  if (!trip) throw new ApiError(404, 'not_found', 'There is no such trip.');
  return trip;
}
const photosOf = async (storage, id) => [...(await storage.list({ prefix: `tmph:${id}:` })).values()].sort((a, b) => a.added - b.added);
const shareOf = async (storage, id) => Boolean(((await storage.get(`tmemo:${id}`)) || {}).share);

const dropPhoto = (storage, key, photo) => storage.delete([key, `tmpht:${photo.id}`, ...[...Array(photo.chunks).keys()].map((n) => `tmphb:${photo.id}:${n}`)]);

async function photoBytes(storage, id, photoId, size) {
  if (!PHOTO_ID.test(String(photoId || ''))) throw new ApiError(404, 'not_found', 'There is no such photo.');
  const photo = await storage.get(`tmph:${id}:${photoId}`);
  if (!photo) throw new ApiError(404, 'not_found', 'There is no such photo.');
  if (size === 'thumb' && photo.thumb) {
    const t = await storage.get(`tmpht:${photo.id}`);
    if (t) return { photo, type: photo.thumb_type || 'image/jpeg', data: toB64(new Uint8Array(t)) };
  }
  const parts = await storage.get([...Array(photo.chunks).keys()].map((n) => `tmphb:${photo.id}:${n}`));
  const bytes = new Uint8Array(photo.bytes);
  let at = 0;
  for (let n = 0; n < photo.chunks; n++) {
    const c = parts.get(`tmphb:${photo.id}:${n}`);
    if (!c) throw new ApiError(410, 'gone', 'This photo is damaged. Add it again.');
    bytes.set(new Uint8Array(c), at); at += c.byteLength;
  }
  return { photo, type: photo.type, data: toB64(bytes) };
}

async function photoAdd(account, body, by = null) {
  const storage = account.storage;
  const id = tripId(body.id);
  const trip = await tripOf(storage, id);
  const type = String(body.type || '').toLowerCase();
  if (!PHOTO_TYPES[type]) throw new ApiError(400, 'bad_request', 'A photo can be JPEG, HEIC, PNG or WebP.');
  const bytes = bytesOf(body.data, 'data');
  if (!bytes.length) throw new ApiError(400, 'bad_request', 'That photo is empty.');
  if (bytes.length > PHOTOS.fileBytes) throw new ApiError(413, 'too_large', `A photo can be at most ${PHOTOS.fileBytes / 1024 / 1024} MB.`);
  if (!PHOTO_TYPES[type](bytes)) throw new ApiError(400, 'bad_request', 'That file isn’t the kind of picture it says it is.');
  let thumb = null, thumbType = null;
  if (body.thumb) {
    thumb = bytesOf(body.thumb, 'thumb');
    thumbType = THUMB_TYPES.find((t) => PHOTO_TYPES[t](thumb)) || null;
    if (!thumbType || thumb.length > PHOTOS.thumbBytes) throw new ApiError(400, 'bad_request', `thumb must be a JPEG, PNG or WebP of at most ${PHOTOS.thumbBytes / 1024} KB.`);
  }
  const all = [...(await storage.list({ prefix: 'tmph:' })).values()];
  const caps = await photoCaps(account); // bigger with Eden Rewards status (rewards.js); a member's photo counts on the organiser's
  if (all.filter((p) => p.trip === id).length >= caps.perTrip) throw new ApiError(409, 'too_many', `A trip keeps at most ${caps.perTrip} photos.`);
  const used = all.reduce((t, p) => t + p.bytes + (p.thumb || 0), 0);
  if (used + bytes.length + (thumb ? thumb.length : 0) > caps.accountBytes) throw new ApiError(409, 'too_many', by ? 'The organiser’s Eden Travel photos are full. Ask them to make room.' : 'Your Eden Travel photos are full. Delete some first.');
  const point = cleanPoint(body.lat, body.lng);
  const day = body.day == null || body.day === '' ? null : Number(body.day);
  const w = Number(body.w), h = Number(body.h);
  const photo = {
    id: `p-${hex(6)}`, trip: id, name: clean(body.name, 120) || 'Photo', type, bytes: bytes.length, chunks: Math.ceil(bytes.length / PHOTOS.chunk),
    thumb: thumb ? thumb.length : 0, thumb_type: thumbType,
    lat: point ? point.lat : null, lng: point ? point.lng : null, taken_at: cleanTaken(body.taken_at),
    day: Number.isInteger(day) && day >= 0 && day < trip.days.length ? day : null,
    w: Number.isInteger(w) && w > 0 && w < 100000 ? w : null, h: Number.isInteger(h) && h > 0 && h < 100000 ? h : null,
    caption: clean(body.caption, PHOTOS.caption), added: account.now(),
    ...(by ? { by: by.member, by_name: clean(by.name, 40) || 'Someone on the trip' } : {}),
  };
  const put = { [`tmph:${id}:${photo.id}`]: photo };
  for (let n = 0; n < photo.chunks; n++) put[`tmphb:${photo.id}:${n}`] = bytes.slice(n * PHOTOS.chunk, (n + 1) * PHOTOS.chunk).buffer;
  if (thumb) put[`tmpht:${photo.id}`] = thumb.slice().buffer;
  await storage.put(put);
  return { photo };
}

/** deps.tripOp (ops.js) is used for trip-money; with none (or when it fails) the recap has no money. */
export async function memoriesOp(account, op, body, { tripOp } = {}) {
  const storage = account.storage;
  switch (op) {
    case 'trip-photo-add': return photoAdd(account, body);
    case 'trip-photos': {
      const id = tripId(body.id);
      return { photos: await photosOf(storage, id) };
    }
    case 'trip-photo-get': {
      const id = tripId(body.id);
      return photoBytes(storage, id, body.photo, body.size);
    }
    case 'trip-photo-edit': {
      const id = tripId(body.id);
      const trip = await tripOf(storage, id);
      const key = `tmph:${id}:${String(body.photo || '')}`;
      const photo = PHOTO_ID.test(String(body.photo || '')) ? await storage.get(key) : null;
      if (!photo) throw new ApiError(404, 'not_found', 'There is no such photo.');
      if ('day' in body) {
        const d = body.day == null ? null : Number(body.day);
        if (d !== null && (!Number.isInteger(d) || d < 0 || d >= trip.days.length)) throw new ApiError(400, 'bad_request', `day must be 0 to ${trip.days.length - 1}, or null.`);
        photo.day = d;
      }
      if ('caption' in body) photo.caption = clean(body.caption, PHOTOS.caption);
      await storage.put(key, photo);
      return { photo };
    }
    case 'trip-photo-delete': {
      const id = tripId(body.id);
      const key = `tmph:${id}:${String(body.photo || '')}`;
      const photo = PHOTO_ID.test(String(body.photo || '')) ? await storage.get(key) : null;
      if (!photo) throw new ApiError(404, 'not_found', 'There is no such photo.');
      await dropPhoto(storage, key, photo);
      return { deleted: true };
    }
    case 'trip-memories': {
      const id = tripId(body.id);
      return { ...(await recapFor(account, id, { tripOp })), share: await shareOf(storage, id) };
    }
    case 'trip-memories-share': {
      const id = tripId(body.id);
      await tripOf(storage, id);
      if (typeof body.share !== 'boolean') throw new ApiError(400, 'bad_request', 'share must be true or false.');
      await storage.put(`tmemo:${id}`, { share: body.share, at: account.now() });
      return { share: body.share };
    }
    default:
      throw new ApiError(404, 'not_found', 'Not found');
  }
}

async function recapFor(account, id, { tripOp }) {
  const trip = await tripOf(account.storage, id);
  const photos = await photosOf(account.storage, id);
  const money = tripOp ? await tripOp(account, 'trip-money', { id }).catch(() => null) : null;
  return recap(trip, photos, money, { now: account.now() });
}

/** The organiser's object, asked by the Worker for a member: only someone on the trip, only while sharing is on. */
export async function memoriesMemberOp(account, op, body, { tripOp } = {}) {
  const trip = String(body.trip || ''), member = String(body.member || '');
  const m = TRIP_ID.test(trip) && ACCOUNT.test(member) ? await account.storage.get(`tmem:${trip}:${member}`) : null;
  if (!m) throw new ApiError(404, 'not_found', 'You’re not on this trip any more.');
  if (!(await shareOf(account.storage, trip))) throw new ApiError(403, 'not_shared', 'The organiser hasn’t shared this trip’s memories.');
  // another member's account id never leaves the organiser's object: a member sees names, and `mine` on their own photos
  const strip = ({ by, ...p }) => ({ ...p, mine: by === member });
  if (op === 'tmember-memories') {
    const r = await recapFor(account, trip, { tripOp });
    const mine = new Set((await photosOf(account.storage, trip)).filter((p) => p.by === member).map((p) => p.id));
    for (const p of [...r.photos, ...r.undated]) p.mine = mine.has(p.id);
    return { ...r, share: true, shared: true };
  }
  if (op === 'tmember-memory-photo') { const got = await photoBytes(account.storage, trip, body.photo, body.size); return { ...got, photo: strip(got.photo) }; }
  if (op === 'tmember-photo-add') {
    const { trip: _t, member: _m, by: _b, by_name: _n, ...args } = body;
    const out = await photoAdd(account, { ...args, id: trip }, { member, name: m.name });
    return { photo: strip(out.photo) };
  }
  if (op === 'tmember-photo-delete') {
    const key = `tmph:${trip}:${String(body.photo || '')}`;
    const photo = PHOTO_ID.test(String(body.photo || '')) ? await account.storage.get(key) : null;
    if (!photo) throw new ApiError(404, 'not_found', 'There is no such photo.');
    if (photo.by !== member) throw new ApiError(403, 'forbidden', 'Only the person who added a photo, or the organiser, can delete it.');
    await dropPhoto(account.storage, key, photo);
    return { deleted: true };
  }
  throw new ApiError(404, 'not_found', 'Not found');
}

/** A trip's photos and its sharing switch gone with it (ops.js trip-delete). */
export async function dropTripPhotos(storage, id) {
  const photos = [...(await storage.list({ prefix: `tmph:${id}:` }))];
  const keys = [`tmemo:${id}`, ...photos.flatMap(([k, p]) => [k, `tmpht:${p.id}`, ...[...Array(p.chunks).keys()].map((n) => `tmphb:${p.id}:${n}`)])];
  for (let i = 0; i < keys.length; i += 128) await storage.delete(keys.slice(i, i + 128));
}

/* ---------- the Worker ---------- */

/** GET /api/chat/travel/memory-photo?id=<trip>&p=<photo>[&size=thumb][&owner=<organiser account>]: the organiser's own
 *  photo, or (with owner) a shared trip's photo for a member. Only types checked by their first bytes, nosniff, no script. */
export async function memoryPhotoRoute(request, env, who, { call, ask: askFn = ask }) {
  if (request.method !== 'GET') throw new ApiError(405, 'bad_request', 'GET');
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '', p = url.searchParams.get('p') || '', owner = url.searchParams.get('owner') || '';
  const size = url.searchParams.get('size') === 'thumb' ? 'thumb' : null;
  const got = owner
    ? await askFn(env, owner, 'tmember-memory-photo', { trip: id, member: who.account, photo: p, size })
    : await call(env, who.account, 'trip-photo-get', { id, photo: p, size }, who.token);
  if (!PHOTO_TYPES[got.type]) throw new ApiError(415, 'bad_type', 'Not a photo.');
  const bytes = Uint8Array.from(atob(got.data), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers: { 'content-type': got.type, 'content-disposition': 'inline', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'private, max-age=31536000, immutable' } });
}
