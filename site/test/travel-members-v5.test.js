// Members, v5 (src/travel/members.js, memories.js): the people a trip is shared with add their own photos to its memories
// while the organiser shares them (tagged with who added them, the same checks and caps, deleted only by them or the
// organiser), and use Discover and Near me on the organiser's object, where an "Add" is a suggestion. Fakes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PHOTOS, memoriesOp } from '../src/travel/memories.js';
import { memberApi, memberOp } from '../src/travel/members.js';
import { tripOp } from '../src/travel/ops.js';
import { standinMaps } from '../src/travel/maps.js';

const T0 = Date.parse('2026-12-10T12:00:00Z');
const OWNER = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const OTHER = '44444444-4444-4444-8444-444444444444';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const TID = 'a1b2c3d4e5f60718';
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function account() {
  const m = new Map();
  const storage = {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, m.get(x)])) : m.get(k)),
    put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) m.set(a, b); else m.set(k, v); },
    delete: async (k) => { for (const x of [].concat(k)) m.delete(x); return true; },
    list: async ({ prefix, start }) => new Map([...m].filter(([k]) => k.startsWith(prefix) && (!start || k >= start)).sort(([a], [b]) => (a < b ? -1 : 1))),
    setAlarm: async () => {},
  };
  m.set('account', { id: OWNER });
  m.set(`trip:${TID}`, {
    title: 'Lisbon', destination: 'Lisbon', start: '2026-11-28', travelers: 2, budget: null, rev: 1, created: 0, updated: 0, access: null,
    days: [
      { title: 'Day 1', stops: [{ id: 's-hotel', kind: 'stay', place: { id: null, name: 'A hotel in Baixa', lat: 38.7118, lng: -9.1384 }, at: '11:00', minutes: 60, mode: 'walk', cost: null, nights: 1, link: null, booked: null, note: '' }] },
      { title: 'Day 2', stops: [] },
    ],
  });
  m.set(`tmem:${TID}:${MEMBER}`, { member: MEMBER, name: 'Sam', joined: 0 });
  m.set(`tmem:${TID}:${OTHER}`, { member: OTHER, name: 'Alex', joined: 0 });
  return { m, storage, env: {}, now: () => T0 };
}
const deps = (a) => ({ tripOp: (x, o, b, d) => tripOp(x, o, b, { maps: standinMaps(a.now), fetch: async () => jsonRes({ error: { code: 'missingtitle' } }), ...d }) });
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 0]);
const share = (a, on = true) => memoriesOp(a, 'trip-memories-share', { id: TID, share: on });

test('a member adds photos only while the organiser shares memories, tagged with who added them, with the same checks', async () => {
  const a = account();
  const d = deps(a);
  const add = (member, extra = {}) => memberOp(a, 'tmember-photo-add', { trip: TID, member, name: 'tram.jpg', type: 'image/jpeg', data: b64(JPEG), taken_at: '2026-11-29T10:00:00', lat: 38.71, lng: -9.14, ...extra }, d);
  await assert.rejects(add(MEMBER), /hasn’t shared/);
  await share(a);
  await assert.rejects(add(STRANGER), /not on this trip/);
  await assert.rejects(add(MEMBER, { type: 'image/jpeg', data: b64(PNG) }), /isn’t the kind/);
  await assert.rejects(add(MEMBER, { type: 'text/html' }), /JPEG, HEIC, PNG or WebP/);
  // a forged `by` is ignored: the photo is the member's the Worker named
  const { photo } = await add(MEMBER, { by: OWNER, by_name: 'The organiser' });
  assert.equal(photo.mine, true);
  assert.equal(photo.by, undefined, 'no account id goes back');
  assert.equal(photo.by_name, 'Sam');
  const stored = a.m.get(`tmph:${TID}:${photo.id}`);
  assert.equal(stored.by, MEMBER);
  assert.equal(stored.by_name, 'Sam');
  assert.ok(a.m.has(`tmphb:${photo.id}:0`));
  // the organiser's recap says who added it
  const own = await memoriesOp(a, 'trip-photo-add', { id: TID, name: 'mine.jpg', type: 'image/jpeg', data: b64(JPEG), taken_at: '2026-11-28T12:00:00' });
  const r = await memoriesOp(a, 'trip-memories', { id: TID });
  const byId = Object.fromEntries(r.photos.map((p) => [p.id, p]));
  assert.deepEqual([byId[photo.id].added_by, byId[photo.id].by_name], ['member', 'Sam']);
  assert.deepEqual([byId[own.photo.id].added_by, byId[own.photo.id].by_name], ['organiser', null]);
  // each member sees `mine` on their own only, and no one's account id
  const sam = await memberOp(a, 'tmember-memories', { trip: TID, member: MEMBER }, d);
  const alex = await memberOp(a, 'tmember-memories', { trip: TID, member: OTHER }, d);
  assert.deepEqual(sam.photos.map((p) => [p.id, p.mine]).sort(), [[photo.id, true], [own.photo.id, false]].sort());
  assert.ok(alex.photos.every((p) => p.mine === false));
  assert.ok(!JSON.stringify(alex).includes(MEMBER));
  const pic = await memberOp(a, 'tmember-memory-photo', { trip: TID, member: OTHER, photo: photo.id }, d);
  assert.equal(pic.photo.by, undefined);
  assert.equal(pic.type, 'image/jpeg');
  // sharing off again: no more adding
  await share(a, false);
  await assert.rejects(add(MEMBER), /hasn’t shared/);
});

test('the trip’s cap counts members’ photos too', async () => {
  const a = account();
  await share(a);
  for (let i = 0; i < PHOTOS.perTrip; i++) a.m.set(`tmph:${TID}:p-${String(i).padStart(12, '0')}`, { id: `p-${String(i).padStart(12, '0')}`, trip: TID, bytes: 1, thumb: 0, chunks: 0, added: i });
  await assert.rejects(memberOp(a, 'tmember-photo-add', { trip: TID, member: MEMBER, type: 'image/jpeg', data: b64(JPEG) }, deps(a)), /at most 200/);
});

test('a member deletes only their own photos; the organiser deletes any', async () => {
  const a = account();
  const d = deps(a);
  await share(a);
  const sams = (await memberOp(a, 'tmember-photo-add', { trip: TID, member: MEMBER, type: 'image/jpeg', data: b64(JPEG) }, d)).photo;
  const alexs = (await memberOp(a, 'tmember-photo-add', { trip: TID, member: OTHER, type: 'image/jpeg', data: b64(JPEG) }, d)).photo;
  const own = (await memoriesOp(a, 'trip-photo-add', { id: TID, type: 'image/jpeg', data: b64(JPEG) })).photo;
  await assert.rejects(memberOp(a, 'tmember-photo-delete', { trip: TID, member: MEMBER, photo: alexs.id }, d), /Only the person who added/);
  await assert.rejects(memberOp(a, 'tmember-photo-delete', { trip: TID, member: MEMBER, photo: own.id }, d), /Only the person who added/);
  await assert.rejects(memberOp(a, 'tmember-photo-delete', { trip: TID, member: MEMBER, photo: 'p-nope' }, d), /no such photo/);
  assert.deepEqual(await memberOp(a, 'tmember-photo-delete', { trip: TID, member: MEMBER, photo: sams.id }, d), { deleted: true });
  assert.ok(!a.m.has(`tmph:${TID}:${sams.id}`) && !a.m.has(`tmphb:${sams.id}:0`));
  assert.deepEqual(await memoriesOp(a, 'trip-photo-delete', { id: TID, photo: alexs.id }), { deleted: true });
  // someone taken off the trip can't delete what they added
  const again = (await memberOp(a, 'tmember-photo-add', { trip: TID, member: MEMBER, type: 'image/jpeg', data: b64(JPEG) }, d)).photo;
  a.m.delete(`tmem:${TID}:${MEMBER}`);
  await assert.rejects(memberOp(a, 'tmember-photo-delete', { trip: TID, member: MEMBER, photo: again.id }, d), /not on this trip/);
});

test('Discover and Near me for a member run on the organiser’s object; strangers are refused', async () => {
  const a = account();
  const d = deps(a);
  const disc = await memberOp(a, 'tmember-discover', { trip: TID, member: MEMBER, kind: 'eat' }, d);
  assert.equal(disc.kind, 'eat');
  assert.equal(disc.destination, 'Lisbon');
  assert.ok(disc.rated && Array.isArray(disc.rated.places));
  assert.equal(disc.rated.standin, true, 'stand-in maps say so');
  const near = await memberOp(a, 'tmember-nearby', { trip: TID, member: MEMBER, lat: 38.71, lng: -9.14, kind: 'drink', minutes: 10 }, d);
  assert.equal(near.minutes, 10);
  assert.ok(Array.isArray(near.places));
  await assert.rejects(memberOp(a, 'tmember-discover', { trip: TID, member: STRANGER, kind: 'eat' }, d), /not on this trip/);
  await assert.rejects(memberOp(a, 'tmember-nearby', { trip: TID, member: STRANGER, lat: 1, lng: 1 }, d), /not on this trip/);
  await assert.rejects(memberOp(a, 'tmember-discover', { trip: TID, member: MEMBER, kind: 'shop' }, d), /kind/);
  // the member's "Add": a proposal by the member, the trip itself unchanged
  const before = a.m.get(`trip:${TID}`).rev;
  const out = await memberOp(a, 'tmember-propose', { trip: TID, member: MEMBER, title: 'Add Cervejaria Ramiro to Day 2', ops: [{ op: 'add', day: 1, stop: { kind: 'meal', place: { name: 'Cervejaria Ramiro', lat: 38.72, lng: -9.135 }, at: '19:00', minutes: 90, mode: 'transit' } }] }, d);
  assert.equal(out.proposal.by, 'member');
  assert.equal(out.proposal.by_name, 'Sam');
  assert.equal(a.m.get(`trip:${TID}`).rev, before);
});

test('the Worker: shared-photo-*, shared-discover and shared-nearby ask the organiser’s object as the signed-in member', async () => {
  const asked = [];
  const env = { ACCOUNTS: { idFromName: (n) => n, get: (n) => ({ fetch: async (u, i) => { asked.push([n, u.split('/').pop(), JSON.parse(i.body)]); return jsonRes({ ok: true }); } }) } };
  const who = { account: MEMBER, token: 't' };
  const call = async () => { throw new Error('not the member’s own object'); };
  await memberApi(env, who, 'shared-photo-add', { owner: OWNER, trip: TID, type: 'image/jpeg', data: 'x', member: STRANGER }, { call });
  await memberApi(env, who, 'shared-photo-delete', { owner: OWNER, trip: TID, photo: 'p-000000000001' }, { call });
  await memberApi(env, who, 'shared-discover', { owner: OWNER, trip: TID, kind: 'see' }, { call });
  await memberApi(env, who, 'shared-nearby', { owner: OWNER, trip: TID, lat: 38.7, lng: -9.1, kind: 'eat', minutes: 15 }, { call });
  assert.deepEqual(asked.map(([n, op]) => [n, op]), [[OWNER, 'tmember-photo-add'], [OWNER, 'tmember-photo-delete'], [OWNER, 'tmember-discover'], [OWNER, 'tmember-nearby']]);
  assert.ok(asked.every(([, , b]) => b.member === MEMBER && b.trip === TID && !('owner' in b)), 'always the signed-in member, never one the page names');
});
