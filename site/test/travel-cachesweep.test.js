// Old cached lookups swept (travel/cachesweep.js, alarm 'tcachesweep'): expired tcache: entries deleted 128 at a time,
// fresh ones kept, nothing else touched; armed once a day from a cache write.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { armCacheSweep, cacheSweepDue, SWEEP } from '../src/travel/cachesweep.js';
import { queued } from '../src/accounts/schedule.js';
import { Storage } from './fakes.js';

const NOW = 1_800_000_000_000;
function fakeAccount() {
  const storage = new Storage();
  const deletes = [];
  const del = storage.delete.bind(storage);
  storage.delete = async (k) => { deletes.push(Array.isArray(k) ? k.length : 1); return del(k); };
  return { storage, deletes, clock: NOW, now() { return this.clock; } };
}

test('expired lookups go, in batches of at most 128; fresh ones and other keys stay', async () => {
  const a = fakeAccount();
  for (let i = 0; i < 300; i++) await a.storage.put(`tcache:old${String(i).padStart(3, '0')}`, { v: i, until: NOW - 1 });
  for (let i = 0; i < 5; i++) await a.storage.put(`tcache:new${i}`, { v: i, until: NOW + 3600_000 });
  await a.storage.put('tcache:broken', 'not an entry');
  await a.storage.put('trip:abc', { title: 'kept' });
  const r = await cacheSweepDue(a);
  assert.equal(r.deleted, 301);
  assert.equal(r.more, false);
  assert.ok(a.deletes.every((n) => n <= SWEEP.batch), 'storage.delete takes at most 128 keys');
  assert.deepEqual([...(await a.storage.list({ prefix: 'tcache:' })).keys()].sort(), ['tcache:new0', 'tcache:new1', 'tcache:new2', 'tcache:new3', 'tcache:new4']);
  assert.ok(await a.storage.get('trip:abc'));
  const q = await queued(a);
  assert.equal(q.find((j) => j.kind === SWEEP.job).at, NOW + SWEEP.everyMs, 'fresh ones left: again tomorrow');
});

test('nothing left: the job is dropped; a later cache write arms it once a day', async () => {
  const a = fakeAccount();
  await a.storage.put('tcache:x', { v: 1, until: NOW - 5 });
  await cacheSweepDue(a);
  assert.equal((await queued(a)).length, 0);
  assert.equal(await a.storage.get('tcsweep'), undefined);
  assert.equal(await armCacheSweep(a), NOW + SWEEP.everyMs);
  a.clock += 60_000;
  assert.equal(await armCacheSweep(a), NOW + SWEEP.everyMs, 'already armed: the queue isn’t rewritten');
  assert.equal((await queued(a)).filter((j) => j.kind === SWEEP.job).length, 1);
});

test('more than one run’s pages: it comes back in a minute', async () => {
  const a = fakeAccount();
  const n = SWEEP.batch * SWEEP.pages + 10;
  for (let i = 0; i < n; i++) await a.storage.put(`tcache:k${String(i).padStart(5, '0')}`, { v: 0, until: NOW - 1 });
  const r = await cacheSweepDue(a);
  assert.equal(r.deleted, SWEEP.batch * SWEEP.pages);
  assert.equal(r.more, true);
  assert.equal((await queued(a)).find((j) => j.kind === SWEEP.job).at, NOW + SWEEP.soonMs);
  const r2 = await cacheSweepDue(a);
  assert.equal(r2.deleted, 10);
  assert.equal((await queued(a)).length, 0);
});

test('a storage that can’t schedule never breaks the cache write', async () => {
  const a = { now: () => NOW, storage: { get: async () => { throw new Error('boom'); } } };
  assert.equal(await armCacheSweep(a), null);
});
