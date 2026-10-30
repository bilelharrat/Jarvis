// Old cached lookups out of the account's object. ops.js's cache (tcache:<key> → { v, until }) deletes an expired answer
// only when the same lookup is asked again, so a place looked up once stays forever. Alarm 'tcachesweep' (account.js),
// once a day while any tcache: is kept: the expired ones (and any without an `until`) deleted, 128 keys a time (the
// most one storage.delete takes). A run reads at most SWEEP.pages pages; more left, it comes back in a minute.
//
// Stored: tcsweep → when the sweep is next due (so a cache write arms the job once a day, not on every write).

import { scheduleJob, unscheduleJob } from '../accounts/schedule.js';

export const SWEEP = { job: 'tcachesweep', everyMs: 24 * 3600_000, batch: 128, pages: 20, soonMs: 60_000 };
const PREFIX = 'tcache:';
const NEXT = 'tcsweep';

/** After a cache write (ops.js cacheIn put): the daily sweep armed, once. Never throws (a cache write mustn't fail on it). */
export async function armCacheSweep(account) {
  try {
    const now = account.now();
    const next = await account.storage.get(NEXT);
    if (Number.isFinite(next) && next > now) return next;
    const at = now + SWEEP.everyMs;
    await scheduleJob(account, SWEEP.job, SWEEP.job, at);
    await account.storage.put(NEXT, at);
    return at;
  } catch (e) {
    console.error('travel cache sweep not armed', e && e.message);
    return null;
  }
}

/** Alarm 'tcachesweep': the expired lookups deleted. → { seen, deleted, more } */
export async function cacheSweepDue(account) {
  const now = account.now();
  const storage = account.storage;
  let seen = 0, deleted = 0, kept = 0, after;
  let more = false;
  for (let page = 0; page < SWEEP.pages; page++) {
    const rows = await storage.list({ prefix: PREFIX, limit: SWEEP.batch, ...(after ? { startAfter: after } : {}) });
    const keys = [...rows.keys()];
    if (!keys.length) break;
    seen += keys.length;
    after = keys[keys.length - 1];
    const old = [];
    for (const [k, v] of rows) {
      if (!v || typeof v !== 'object' || !Number.isFinite(v.until) || v.until <= now) old.push(k);
      else kept++;
    }
    if (old.length) { await storage.delete(old); deleted += old.length; }
    if (keys.length < SWEEP.batch) break;
    if (page === SWEEP.pages - 1) more = true;
  }
  if (more) {
    await scheduleJob(account, SWEEP.job, SWEEP.job, now + SWEEP.soonMs);
    await storage.put(NEXT, now + SWEEP.soonMs);
  } else if (kept) {
    await scheduleJob(account, SWEEP.job, SWEEP.job, now + SWEEP.everyMs);
    await storage.put(NEXT, now + SWEEP.everyMs);
  } else {
    await unscheduleJob(account, SWEEP.job);
    await storage.delete(NEXT);
  }
  return { seen, deleted, more };
}
