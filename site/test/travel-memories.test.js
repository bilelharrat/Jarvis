// Memories (src/travel/memories.js): photos stored and capped like documents, the recap from the trip itself, sharing
// only with the trip's members, cleanup on trip delete, and the page's EXIF reader (askeden web/chat/travel-exif.js,
// pure, loaded from TRAVEL_PAGE_CHAT or the sibling worktree; those tests skip when it isn't there). Fakes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PHOTOS, cleanPoint, cleanTaken, dayFor, dropTripPhotos, memoriesMemberOp, memoriesOp, memoryPhotoRoute, recap } from '../src/travel/memories.js';

const T0 = Date.parse('2026-12-10T12:00:00Z'); // after the trip
const OWNER = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const TID = 'a1b2c3d4e5f60718';

function account({ trip } = {}) {
  const m = new Map();
  const storage = {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, m.get(x)])) : m.get(k)),
    put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) m.set(a, b); else m.set(k, v); },
    delete: async (k) => { for (const x of [].concat(k)) m.delete(x); return true; },
    list: async ({ prefix }) => new Map([...m].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  m.set('account', { id: OWNER });
  m.set(`trip:${TID}`, trip || lisbon());
  return { m, storage, env: {}, now: () => T0 };
}
const stop = (id, name, at, lat, lng, extra = {}) => ({ id, kind: 'visit', place: { id: null, name, lat, lng }, at, minutes: 60, mode: 'walk', cost: null, nights: null, link: null, booked: null, note: '', ...extra });
function lisbon() {
  return {
    title: 'Lisbon and Porto', destination: 'Lisbon, Porto', start: '2026-11-28', travelers: 2, budget: { amount: 900, currency: 'EUR' }, rev: 1, created: 0, updated: 0, access: null,
    days: [
      { title: 'Arrive', stops: [
        stop('s-air', 'Lisbon airport', '09:00', 38.7742, -9.1342, { kind: 'transport' }),
        stop('s-hotel', 'A hotel in Baixa', '11:00', 38.7118, -9.1384, { kind: 'stay', nights: 2, booked: { kind: 'stay', ref: 'H1', provider: 'Hotel', via: 'person', at: 0 } }),
      ] },
      { title: 'Belém', stops: [stop('s-jer', 'Jerónimos Monastery', '10:00', 38.6979, -9.2068), stop('s-nowhere', 'Somewhere unlocated', '15:00', null, null)] },
      { title: 'Porto', stops: [stop('s-porto', 'Ribeira, Porto', '14:00', 41.1407, -8.6131)] },
    ],
  };
}
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 0]);
const fakeMoney = async (_a, op) => { assert.equal(op, 'trip-money'); return { currency: 'EUR', total: 812.5, budget: { amount: 900, currency: 'EUR' }, expenses: [{}, {}, {}], rates: { date: '2026-12-01', source: 'ECB' } }; };

// ── checks on what the page sends ──

test('points and times: only real ones are kept', () => {
  assert.deepEqual(cleanPoint(38.7, -9.1), { lat: 38.7, lng: -9.1 });
  assert.equal(cleanPoint(0, 0), null); // a camera with no fix
  assert.equal(cleanPoint(91, 0), null);
  assert.equal(cleanPoint(null, 3), null);
  assert.equal(cleanPoint('', ''), null);
  assert.equal(cleanTaken('2026-11-29T14:03:00'), '2026-11-29T14:03:00');
  assert.equal(cleanTaken('2026-11-29T14:03:00+00:00'), '2026-11-29T14:03:00+00:00');
  assert.equal(cleanTaken('2026-04-31T10:00:00'), null);
  assert.equal(cleanTaken('2026:11:29 14:03:00'), null);
  assert.equal(cleanTaken('yesterday'), null);
});

// ── photos stored like documents ──

test('photos: added with their own place and time, typed by first bytes, capped, read back, edited, deleted', async () => {
  const a = account();
  const { photo } = await memoriesOp(a, 'trip-photo-add', { id: TID, name: 'belem.jpg', type: 'image/jpeg', data: b64(JPEG), thumb: b64(JPEG), lat: 38.698, lng: -9.2066, taken_at: '2026-11-29T10:20:00', w: 2048, h: 1536 });
  assert.match(photo.id, /^p-[0-9a-f]{12}$/);
  assert.equal(photo.lat, 38.698);
  assert.equal(photo.thumb_type, 'image/jpeg');
  assert.ok(a.m.has(`tmphb:${photo.id}:0`) && a.m.has(`tmpht:${photo.id}`));
  // a PNG called a JPEG, a page called a photo, no data: refused
  await assert.rejects(memoriesOp(a, 'trip-photo-add', { id: TID, type: 'image/jpeg', data: b64(PNG) }), /isn’t the kind/);
  await assert.rejects(memoriesOp(a, 'trip-photo-add', { id: TID, type: 'text/html', data: b64(JPEG) }), /JPEG, HEIC, PNG or WebP/);
  await assert.rejects(memoriesOp(a, 'trip-photo-add', { id: TID, type: 'image/jpeg', data: '' }), /empty/);
  await assert.rejects(memoriesOp(a, 'trip-photo-add', { id: TID, type: 'image/jpeg', data: b64(JPEG), thumb: b64(Uint8Array.from([60, 104, 116, 109, 108])) }), /thumb must be/);
  // an .mp4 (ftyp, not a HEIF brand) isn't a HEIC
  const mp4 = Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
  await assert.rejects(memoriesOp(a, 'trip-photo-add', { id: TID, type: 'image/heic', data: b64(mp4) }), /isn’t the kind/);
  const heic = Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0]);
  const h = await memoriesOp(a, 'trip-photo-add', { id: TID, type: 'image/heic', data: b64(heic), lat: 0, lng: 0, taken_at: 'nonsense' });
  assert.equal(h.photo.lat, null); // 0,0 is no place
  assert.equal(h.photo.taken_at, null);

  const list = await memoriesOp(a, 'trip-photos', { id: TID });
  assert.equal(list.photos.length, 2);
  const full = await memoriesOp(a, 'trip-photo-get', { id: TID, photo: photo.id });
  assert.deepEqual([...Buffer.from(full.data, 'base64')], [...JPEG]);
  assert.equal(full.type, 'image/jpeg');
  const thumb = await memoriesOp(a, 'trip-photo-get', { id: TID, photo: photo.id, size: 'thumb' });
  assert.equal(thumb.type, 'image/jpeg');
  await assert.rejects(memoriesOp(a, 'trip-photo-get', { id: TID, photo: '../x' }), /no such photo/);

  const e = await memoriesOp(a, 'trip-photo-edit', { id: TID, photo: h.photo.id, day: 2, caption: 'Ribeira\u0000 at dusk' });
  assert.equal(e.photo.day, 2);
  assert.equal(e.photo.caption, 'Ribeira at dusk');
  await assert.rejects(memoriesOp(a, 'trip-photo-edit', { id: TID, photo: h.photo.id, day: 9 }), /day must be/);

  await memoriesOp(a, 'trip-photo-delete', { id: TID, photo: photo.id });
  assert.ok(![...a.m.keys()].some((k) => k.includes(photo.id)));
});

test('photos: per-trip and per-account caps, and a bigger file than allowed', async () => {
  const a = account();
  for (let i = 0; i < PHOTOS.perTrip; i++) a.m.set(`tmph:${TID}:p-${String(i).padStart(12, '0')}`, { id: `p-${i}`, trip: TID, bytes: 1, thumb: 0, chunks: 1, added: i });
  await assert.rejects(memoriesOp(a, 'trip-photo-add', { id: TID, type: 'image/jpeg', data: b64(JPEG) }), /at most 200 photos/);
  const b = account();
  b.m.set('tmph:ffffffffffffffff:p-000000000001', { id: 'p-000000000001', trip: 'ffffffffffffffff', bytes: PHOTOS.accountBytes, thumb: 0, chunks: 1, added: 0 });
  await assert.rejects(memoriesOp(b, 'trip-photo-add', { id: TID, type: 'image/jpeg', data: b64(JPEG) }), /photos are full/);
  const big = new Uint8Array(PHOTOS.fileBytes + 1); big.set(JPEG);
  await assert.rejects(memoriesOp(account(), 'trip-photo-add', { id: TID, type: 'image/jpeg', data: b64(big) }), /at most 10 MB/);
  // a file over one chunk is stored in chunks and read back whole
  const c = account();
  const two = new Uint8Array(PHOTOS.chunk + 10); two.set(JPEG); two[two.length - 1] = 7;
  const { photo } = await memoriesOp(c, 'trip-photo-add', { id: TID, type: 'image/jpeg', data: b64(two) });
  assert.equal(photo.chunks, 2);
  const back = Buffer.from((await memoriesOp(c, 'trip-photo-get', { id: TID, photo: photo.id })).data, 'base64');
  assert.equal(back.length, two.length);
  assert.equal(back[back.length - 1], 7);
});

// ── the recap ──

test('recap: days, planned vs booked, straight-line km, nights, places, money', () => {
  const r = recap(lisbon(), [], { currency: 'EUR', total: 812.5, expenses: [{}], rates: null }, { now: T0 });
  assert.equal(r.ended, true);
  assert.equal(r.end, '2026-11-30');
  assert.equal(r.stats.days, 3);
  assert.equal(r.stats.nights, 2);
  assert.equal(r.stats.nights_from, 'stays');
  assert.equal(r.stats.stops, 5);
  assert.equal(r.stats.booked, 1);
  assert.equal(r.stats.planned, 4);
  assert.equal(r.days[0].stops[1].status, 'booked');
  assert.equal(r.days[1].stops[1].status, 'planned');
  assert.equal(r.days[1].stops[1].lat, null); // unlocated stops stay unlocated and add no distance
  assert.equal(r.stats.located_stops, 4);
  assert.equal(r.stats.km_method, 'straight_line');
  // airport→hotel ~7 km, hotel→Jerónimos ~6 km, Jerónimos→Porto ~275 km
  assert.ok(r.stats.km > 280 && r.stats.km < 300, String(r.stats.km));
  assert.ok(r.days[2].km > 260);
  assert.equal(r.stats.areas, 2);
  assert.deepEqual(r.stats.places, ['Lisbon', 'Porto']);
  assert.equal(r.money.total, 812.5);
  // before the trip ends it says so; no stays → nights from the days
  const t = lisbon(); t.days[0].stops.splice(1, 1);
  const early = recap(t, [], null, { now: Date.parse('2026-11-29T00:00:00Z') });
  assert.equal(early.ended, false);
  assert.equal(early.stats.nights, 2);
  assert.equal(early.stats.nights_from, 'days');
  assert.equal(early.money, null);
});

test('recap: photos on the day nearest their time, on the map only with GPS, near a stop within 500 m', () => {
  const trip = lisbon();
  const photos = [
    { id: 'p-1', name: 'a', taken_at: '2026-11-29T10:30:00', lat: 38.6981, lng: -9.2065, added: 1 }, // at Jerónimos
    { id: 'p-2', name: 'b', taken_at: '2026-11-30T18:00:00+00:00', lat: null, lng: null, added: 2 }, // no GPS: not placed
    { id: 'p-3', name: 'c', taken_at: '2026-12-05T12:00:00', lat: 41.15, lng: -8.61, added: 3 }, // after the trip
    { id: 'p-4', name: 'd', taken_at: null, lat: 38.71, lng: -9.14, added: 4 }, // no date
    { id: 'p-5', name: 'e', taken_at: null, day: 0, lat: null, lng: null, added: 5 }, // the person chose the day
    { id: 'p-6', name: 'f', taken_at: '2026-11-27T22:00:00', lat: 38.77, lng: -9.13, added: 6 }, // the evening before: day 0, not outside
  ];
  const r = recap(trip, photos, null, { now: T0 });
  const by = Object.fromEntries(r.photos.map((p) => [p.id, p]));
  assert.equal(by['p-1'].day, 1);
  assert.equal(by['p-1'].near, 's-jer');
  assert.equal(by['p-1'].on_map, true);
  assert.equal(by['p-2'].day, 2);
  assert.equal(by['p-2'].on_map, false);
  assert.equal(by['p-2'].near, undefined);
  assert.equal(by['p-3'].day, 2);
  assert.equal(by['p-3'].outside, true);
  assert.equal(by['p-5'].day, 0);
  assert.equal(by['p-5'].day_by, 'person');
  assert.equal(by['p-6'].day, 0);
  assert.equal(by['p-6'].outside, undefined);
  assert.deepEqual(r.undated.map((p) => p.id), ['p-4']);
  assert.deepEqual(r.days[1].photos, ['p-1']);
  assert.equal(r.stats.photos, 6);
  assert.equal(r.stats.photos_on_map, 4);
  assert.equal(dayFor(trip, { taken_at: null }), null);
});

// ── private by default; members only when shared ──

test('memories: private by default, shared only with the trip’s members, never anyone else', async () => {
  const a = account();
  await memoriesOp(a, 'trip-photo-add', { id: TID, type: 'image/jpeg', data: b64(JPEG), lat: 38.698, lng: -9.2066, taken_at: '2026-11-29T10:20:00' });
  const mine = await memoriesOp(a, 'trip-memories', { id: TID }, { tripOp: fakeMoney });
  assert.equal(mine.share, false);
  assert.equal(mine.money.total, 812.5);
  assert.equal(mine.photos.length, 1);
  // a failing money lookup leaves money out, not the recap
  const noMoney = await memoriesOp(a, 'trip-memories', { id: TID }, { tripOp: async () => { throw new Error('rates'); } });
  assert.equal(noMoney.money, null);

  a.m.set(`tmem:${TID}:${MEMBER}`, { member: MEMBER, name: 'Sam', joined: 0 });
  await assert.rejects(memoriesMemberOp(a, 'tmember-memories', { trip: TID, member: MEMBER }), /hasn’t shared/);
  await assert.rejects(memoriesOp(a, 'trip-memories-share', { id: TID, share: 'yes' }), /true or false/);
  assert.equal((await memoriesOp(a, 'trip-memories-share', { id: TID, share: true })).share, true);
  const theirs = await memoriesMemberOp(a, 'tmember-memories', { trip: TID, member: MEMBER }, { tripOp: fakeMoney });
  assert.equal(theirs.shared, true);
  assert.equal(theirs.photos.length, 1);
  const pic = await memoriesMemberOp(a, 'tmember-memory-photo', { trip: TID, member: MEMBER, photo: theirs.photos[0].id });
  assert.equal(pic.type, 'image/jpeg');
  await assert.rejects(memoriesMemberOp(a, 'tmember-memories', { trip: TID, member: STRANGER }), /not on this trip/);
  await assert.rejects(memoriesMemberOp(a, 'tmember-memories', { trip: 'nope', member: MEMBER }), /not on this trip/);
  await memoriesOp(a, 'trip-memories-share', { id: TID, share: false });
  await assert.rejects(memoriesMemberOp(a, 'tmember-memory-photo', { trip: TID, member: MEMBER, photo: theirs.photos[0].id }), /hasn’t shared/);
});

test('trip delete takes its photos and sharing switch, nothing of other trips', async () => {
  const a = account();
  const { photo } = await memoriesOp(a, 'trip-photo-add', { id: TID, type: 'image/jpeg', data: b64(JPEG), thumb: b64(JPEG) });
  await memoriesOp(a, 'trip-memories-share', { id: TID, share: true });
  a.m.set('tmph:ffffffffffffffff:p-aaaaaaaaaaaa', { id: 'p-aaaaaaaaaaaa', trip: 'ffffffffffffffff', bytes: 1, chunks: 1, thumb: 0 });
  a.m.set('tmphb:p-aaaaaaaaaaaa:0', new ArrayBuffer(1));
  await dropTripPhotos(a.storage, TID);
  assert.ok(![...a.m.keys()].some((k) => k.includes(photo.id) || k === `tmemo:${TID}`));
  assert.ok(a.m.has('tmph:ffffffffffffffff:p-aaaaaaaaaaaa') && a.m.has('tmphb:p-aaaaaaaaaaaa:0'));
});

test('the bytes route: the owner’s own photo, a member’s through the organiser, nosniff and sandboxed', async () => {
  const a = account();
  const { photo } = await memoriesOp(a, 'trip-photo-add', { id: TID, type: 'image/jpeg', data: b64(JPEG) });
  const call = async (_env, acct, op, body) => { assert.equal(acct, OWNER); return memoriesOp(a, op, body); };
  const res = await memoryPhotoRoute(new Request(`https://x/api/chat/travel/memory-photo?id=${TID}&p=${photo.id}`), {}, { account: OWNER, token: 't' }, { call });
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
  assert.equal(res.headers.get('cache-control'), 'private, no-store', 'never kept by a shared browser (M4)');
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [...JPEG]);
  a.m.set(`tmem:${TID}:${MEMBER}`, { member: MEMBER });
  await memoriesOp(a, 'trip-memories-share', { id: TID, share: true });
  const ask = async (_env, owner, op, body) => { assert.equal(owner, OWNER); assert.equal(body.member, MEMBER); return memoriesMemberOp(a, op, body); };
  const r2 = await memoryPhotoRoute(new Request(`https://x/m?id=${TID}&p=${photo.id}&owner=${OWNER}`), {}, { account: MEMBER }, { call: null, ask });
  assert.equal(r2.status, 200);
  await assert.rejects(memoryPhotoRoute(new Request('https://x/m', { method: 'POST' }), {}, { account: OWNER }, { call }), /GET/);
});

// ── the page's EXIF reader ──

const PAGE = [process.env.TRAVEL_PAGE_CHAT, new URL('../../../askeden-travel/web/chat', import.meta.url).pathname].filter(Boolean).find((d) => existsSync(`${d}/travel-exif.js`));
const exif = PAGE ? await import(pathToFileURL(`${PAGE}/travel-exif.js`).href) : null;

// A TIFF block: IFD0 (orientation, Exif and GPS pointers), the Exif IFD (DateTimeOriginal, OffsetTimeOriginal), the GPS IFD.
function tiff({ le = false, lat = [38, 41, 52.8], latRef = 'N', lng = [9, 12, 24], lngRef = 'W', when = '2026:11:29 10:20:05', offset = '+00:00', status = null, gps = true } = {}) {
  const buf = new Uint8Array(1024);
  const v = new DataView(buf.buffer);
  const w16 = (o, x) => v.setUint16(o, x, le), w32 = (o, x) => v.setUint32(o, x, le);
  buf.set(le ? [0x49, 0x49] : [0x4d, 0x4d], 0); w16(2, 42); w32(4, 8);
  let heap = 400;
  const ascii = (s) => { const at = heap; for (let i = 0; i < s.length; i++) buf[at + i] = s.charCodeAt(i); buf[at + s.length] = 0; heap += s.length + 2; return at; };
  const rats = (xs) => { const at = heap; xs.forEach((x, i) => { w32(at + i * 8, Math.round(x * 100)); w32(at + i * 8 + 4, 100); }); heap += xs.length * 8; return at; };
  const ifd = (o, entries) => {
    w16(o, entries.length);
    entries.forEach(([tag, type, count, val], i) => {
      const e = o + 2 + i * 12; w16(e, tag); w16(e + 2, type); w32(e + 4, count);
      if (type === 3 && count === 1) w16(e + 8, val); else if (type === 2 && count <= 4) { for (let k = 0; k < count; k++) buf[e + 8 + k] = val.charCodeAt(k) || 0; } else w32(e + 8, val);
    });
    w32(o + 2 + entries.length * 12, 0);
  };
  const exifAt = 100, gpsAt = 200;
  ifd(8, [[0x0112, 3, 1, 6], [0x8769, 4, 1, exifAt], ...(gps ? [[0x8825, 4, 1, gpsAt]] : [])]);
  ifd(exifAt, [[0x9003, 2, when.length + 1, ascii(when)], ...(offset ? [[0x9011, 2, offset.length + 1, ascii(offset)]] : [])]);
  if (gps) ifd(gpsAt, [[0x0001, 2, 2, latRef], [0x0002, 5, 3, rats(lat)], [0x0003, 2, 2, lngRef], [0x0004, 5, 3, rats(lng)], ...(status ? [[0x0009, 2, 2, status]] : [])]);
  return buf.subarray(0, heap);
}
function jpegWith(t) {
  const app1 = [0xff, 0xe1, ((t.length + 8) >> 8) & 255, (t.length + 8) & 255, 0x45, 0x78, 0x69, 0x66, 0, 0];
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, ...app1, ...t, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
}
const box = (type, ...parts) => { const body = parts.flatMap((p) => [...p]); const n = 8 + body.length; return Uint8Array.from([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255, ...[...type].map((c) => c.charCodeAt(0)), ...body]); };
const be = (n, size) => [...Array(size)].map((_, i) => (n >>> ((size - 1 - i) * 8)) & 255);
// a HEIC: ftyp, meta { hdlr, iinf { infe v2 'hvc1' id 1, infe v2 'Exif' id 2 }, iloc v0 }, mdat holding the Exif item
function heicWith(t) {
  const item = Uint8Array.from([0, 0, 0, 6, 0x45, 0x78, 0x69, 0x66, 0, 0, ...t]);
  const ftyp = box('ftyp', [...'heic'].map((c) => c.charCodeAt(0)), [0, 0, 0, 0], [...'mif1heic'].map((c) => c.charCodeAt(0)));
  const infe = (id, type) => box('infe', [2, 0, 0, 0], be(id, 2), [0, 0], [...type].map((c) => c.charCodeAt(0)), [0]);
  const iinf = box('iinf', [0, 0, 0, 0], be(2, 2), infe(1, 'hvc1'), infe(2, 'Exif'));
  const hdlr = box('hdlr', [0, 0, 0, 0, 0, 0, 0, 0], [...'pict'].map((c) => c.charCodeAt(0)), new Array(13).fill(0));
  const ilocFor = (off) => box('iloc', [0, 0, 0, 0], [0x44, 0x00], be(2, 2), be(1, 2), [0, 0], be(1, 2), be(0, 4), be(4, 4), be(2, 2), [0, 0], be(1, 2), be(off, 4), be(item.length, 4));
  const meta0 = box('meta', [0, 0, 0, 0], hdlr, ilocFor(0), iinf);
  const off = ftyp.length + meta0.length + 8 + 4; // mdat header, then 4 bytes of "picture" before the Exif item
  const meta = box('meta', [0, 0, 0, 0], hdlr, ilocFor(off), iinf);
  return Uint8Array.from([...ftyp, ...meta, ...box('mdat', [1, 2, 3, 4], item)]);
}

test('EXIF: JPEG GPS and DateTimeOriginal, both byte orders', { skip: !exif && 'travel-exif.js not found (set TRAVEL_PAGE_CHAT)' }, () => {
  for (const le of [false, true]) {
    const r = exif.readExif(jpegWith(tiff({ le })));
    assert.equal(r.format, 'jpeg');
    assert.equal(r.found, true);
    assert.equal(r.lat, 38.698);
    assert.equal(r.lng, -9.206667);
    assert.equal(r.taken_at, '2026-11-29T10:20:05+00:00');
    assert.equal(r.orientation, 6);
  }
  const s = exif.readExif(jpegWith(tiff({ latRef: 'S', lngRef: 'E', offset: null })));
  assert.equal(s.lat, -38.698);
  assert.equal(s.lng, 9.206667);
  assert.equal(s.taken_at, '2026-11-29T10:20:05');
});

test('EXIF: no place is invented', { skip: !exif && 'travel-exif.js not found' }, () => {
  const none = exif.readExif(jpegWith(tiff({ gps: false })));
  assert.equal(none.lat, null); assert.equal(none.lng, null);
  assert.equal(none.taken_at, '2026-11-29T10:20:05+00:00');
  assert.equal(exif.readExif(jpegWith(tiff({ status: 'V' }))).lat, null); // a void fix
  assert.equal(exif.readExif(jpegWith(tiff({ lat: [0, 0, 0], lng: [0, 0, 0] }))).lat, null); // 0,0
  assert.equal(exif.readExif(jpegWith(tiff({ lat: [95, 0, 0] }))).lat, null);
  assert.equal(exif.readExif(jpegWith(tiff({ latRef: 'X' }))).lat, null);
  assert.equal(exif.readExif(jpegWith(tiff({ when: '0000:00:00 00:00:00' }))).taken_at, null);
  // no EXIF at all, a damaged one, junk, a cut-off file: nothing, never a throw
  assert.deepEqual(exif.readExif(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])).found, false);
  const cut = jpegWith(tiff()).subarray(0, 60);
  assert.equal(exif.readExif(cut).lat, null);
  const broken = jpegWith(tiff()); broken[broken.indexOf(0x4d, 14) + 4] = 0xff; // IFD0 offset into nowhere
  assert.equal(exif.readExif(broken).lat, null);
  assert.equal(exif.readExif(new Uint8Array(0)).found, false);
  assert.equal(exif.readExif(Uint8Array.from({ length: 4096 }, (_, i) => (i * 7919) % 256)).lat, null);
});

test('EXIF: HEIC (Exif item through iinf/iloc), PNG eXIf and WebP EXIF', { skip: !exif && 'travel-exif.js not found' }, () => {
  const h = exif.readExif(heicWith(tiff({ le: true })));
  assert.equal(h.format, 'heic');
  assert.equal(h.lat, 38.698);
  assert.equal(h.taken_at, '2026-11-29T10:20:05+00:00');
  const t = tiff();
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, ...be(t.length, 4), ...[...'eXIf'].map((c) => c.charCodeAt(0)), ...t, 0, 0, 0, 0]);
  assert.equal(exif.readExif(png).lng, -9.206667);
  const chunk = [...[...'EXIF'].map((c) => c.charCodeAt(0)), t.length & 255, (t.length >> 8) & 255, 0, 0, ...t, ...(t.length & 1 ? [0] : [])];
  const webp = Uint8Array.from([...[...'RIFF'].map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...[...'WEBP'].map((c) => c.charCodeAt(0)), ...chunk]);
  assert.equal(exif.readExif(webp).lat, 38.698);
});
