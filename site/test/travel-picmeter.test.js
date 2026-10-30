// Pictures on Eden's Google key charged to the account (security review M1): a photo only of a place on the account's
// own trips or shown to it lately; each counted on the account's day and refused past its cap; daily counts for
// Decisions and booking windows.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DAILY, notePhotos, photoNames, picOp, takeDaily } from '../src/travel/picmeter.js';

const T0 = Date.parse('2026-10-28T12:00:00Z');
const P1 = 'places/ChIJAAAAAAAAAA/photos/AbCdEfGhIjKlMn';
const P2 = 'places/ChIJBBBBBBBBBB/photos/ZyXwVuTsRqPoNm';
function account(env = { TRAVEL_GOOGLE_ACCOUNT_USD: '0.05' }) {
  const m = new Map();
  const storage = {
    get: async (k) => m.get(k), put: async (k, v) => { m.set(k, structuredClone(v)); },
    delete: async (k) => { for (const x of [].concat(k)) m.delete(x); }, list: async ({ prefix }) => new Map([...m].filter(([k]) => k.startsWith(prefix))),
  };
  const a = { m, storage, env, t: T0, now: () => a.t };
  return a;
}

test('a photo: only one on your own trips or shown to you lately; counted on your day, refused past it', async () => {
  const a = account();
  a.m.set('trip:aaaaaaaaaaaaaaaa', { days: [{ stops: [{ photo: { name: P1 } }] }] });
  assert.deepEqual(await picOp(a, 'trip-pic-take', { kind: 'photo', n: P1 }), { ok: true });
  await assert.rejects(picOp(a, 'trip-pic-take', { kind: 'photo', n: P2 }), (e) => e.status === 404);
  await assert.rejects(picOp(a, 'trip-pic-take', { kind: 'photo', n: 'places/x' }), (e) => e.status === 400);
  await notePhotos(a, [P2, 'not a photo']);
  assert.deepEqual(Object.keys(a.m.get('tpicseen')), [P2]);
  assert.deepEqual(await picOp(a, 'trip-pic-take', { kind: 'photo', n: P2 }), { ok: true });
  a.t += 15 * 86400_000;
  await assert.rejects(picOp(a, 'trip-pic-take', { kind: 'photo', n: P2 }), (e) => e.status === 404, 'seen too long ago');
  // the account's cap ($0.05 here; photos $7 per 1000): the 8th of the day is refused
  const b = account();
  b.m.set('trip:aaaaaaaaaaaaaaaa', { days: [{ stops: [{ photo: { name: P1 } }] }] });
  for (let i = 0; i < 7; i++) await picOp(b, 'trip-pic-take', { kind: 'photo', n: P1 });
  await assert.rejects(picOp(b, 'trip-pic-take', { kind: 'photo', n: P1 }), (e) => e.status === 429 && e.code === 'capped');
  await assert.rejects(picOp(b, 'trip-pic-take', { kind: 'map' }), (e) => e.status === 429);
});

test('photoNames finds photos in lookups and trips', () => {
  assert.deepEqual([...photoNames({ places: [{ photo: { name: P1 } }, { photos: [{ name: P2 }, { name: 'x' }] }] })].sort(), [P1, P2].sort());
});

test('takeDaily: Decisions and booking windows per UTC day', async () => {
  const a = account();
  for (let i = 0; i < DAILY.decisions; i++) await takeDaily(a, 'decisions');
  await assert.rejects(takeDaily(a, 'decisions'), (e) => e.status === 429);
  await takeDaily(a, 'windows');
  a.t += 86400_000;
  await takeDaily(a, 'decisions');
});

test('trip-pic-note: the Worker notes a shared trip’s photos on the member’s own object', async () => {
  const a = account();
  await picOp(a, 'trip-pic-note', { names: [P1] });
  assert.deepEqual(await picOp(a, 'trip-pic-take', { kind: 'photo', n: P1 }), { ok: true });
});
