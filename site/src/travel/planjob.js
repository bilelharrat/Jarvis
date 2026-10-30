// A new trip's plan as a job (owner, 2026-10-28: "make the wait the proof"). planner.js takes about 100 s (Gemini 4 Argon
// + Google Search drafts in about 80 s, then Google's checks); the page polls and shows each step as it happens instead
// of a spinner: the first sketch, the draft's stops, each place as Google Maps answers it, each change.
//
// trip-plan-start { request, constraints? } → { job, state, poll_ms }     (ops.js counts it against the daily plans first)
// trip-plan-status { job, after? }           → { job, state, events: [n > after], next, result?, error?, code? }
// trip-plan-cancel { job }                   → { job, state: 'cancelled' }
//
// Stored: tpjob:<job> → { id, state: running | done | failed | cancelled, created, updated, body, events, n, result?,
// error?, code?, restarts } for a day (JOB.keepMs). `result` is trip-plan's answer without `checks` (the page drops them;
// they can pass a Durable Object value's 128 KiB), with `alerts`: how many the checks left.
//
// Where the work runs: in the account's Durable Object, after trip-plan-start has answered (a promise this object keeps;
// ctx.waitUntil too where there is one). A Durable Object keeps running while it waits on its own fetches and while
// requests come in (the page polls every 1.5 s), but Cloudflare may still restart it (a deploy, a move). A job still
// "running" that this instance doesn't hold was cut off that way: the next status starts it again once from the start
// (JOB.restarts; the plan isn't counted twice), then says it stopped.

import { PlanError } from './planner.js';
import { TripError } from './trips.js';

export const JOB = { keepMs: 86_400_000, events: 240, running: 2, restarts: 1, restartWithinMs: 10 * 60_000, pollMs: 1500, text: 400 };
const ID = /^[0-9a-f]{16}$/;
const key = (id) => `tpjob:${id}`;
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

// The jobs this instance is running: account object → job id → { job, ctl, saving }. Gone when the object restarts.
const RUNNING = new WeakMap();
const mine = (account) => { let m = RUNNING.get(account); if (!m) RUNNING.set(account, (m = new Map())); return m; };

/** An event as kept: its strings capped, its number in the job's order. */
function keep(job, ev) {
  const out = { n: ++job.n };
  for (const [k, v] of Object.entries(ev)) out[k] = typeof v === 'string' ? v.slice(0, JOB.text) : v;
  job.events.push(out);
  // a very long plan keeps its first events (the sketch, the draft) and its latest; the page has seen the middle
  if (job.events.length > JOB.events) job.events.splice(2, job.events.length - JOB.events);
  return out;
}

/** trip-plan's answer as a job keeps it: no `checks` (the page drops them), how many alerts they left. */
export function slimResult(r) {
  const { checks, ...rest } = r;
  const out = { ...rest, alerts: checks && Array.isArray(checks.alerts) ? checks.alerts.length : 0 };
  if (JSON.stringify(out).length > 100_000) out.sources = (out.sources || []).slice(0, 12);
  return out;
}

/**
 * Starts (or starts again) the job's work in this instance. `run(body, { progress, signal, sketch })` is planTrip with the
 * account's maps and meter (ops.js).
 */
function launch(account, job, run, now) {
  const ctl = new AbortController();
  const entry = { job, ctl, saving: Promise.resolve() };
  // only while this run is the job's own (a run cut off and started again never writes over the new one)
  const save = () => { if (mine(account).get(job.id) === entry) entry.saving = entry.saving.then(() => account.storage.put(key(job.id), job)).catch(() => {}); return entry.saving; };
  entry.save = save;
  mine(account).set(job.id, entry);
  const work = (async () => {
    try {
      const r = await run(job.body, { progress: (ev) => { if (job.state === 'running') { keep(job, ev); job.updated = now(); save(); } }, signal: ctl.signal, sketch: true });
      if (job.state !== 'running') return; // cancelled meanwhile
      job.result = slimResult(r);
      job.state = 'done';
      keep(job, { type: 'stage', stage: 'done', text: 'Done', t: r.took_ms });
    } catch (e) {
      if (job.state !== 'running') return;
      job.state = 'failed';
      job.error = e instanceof TripError || e instanceof PlanError ? e.message : 'The plan stopped on an error. Try again.';
      job.code = (e && e.code) || 'failed';
      keep(job, { type: 'stage', stage: 'failed', text: job.error });
    } finally {
      job.updated = now();
      await save();
      if (mine(account).get(job.id) === entry) mine(account).delete(job.id);
    }
  })();
  if (account.ctx && typeof account.ctx.waitUntil === 'function') account.ctx.waitUntil(work);
  entry.work = work;
  return entry;
}

async function sweep(storage, now) {
  const all = await storage.list({ prefix: 'tpjob:' });
  const old = [...all].filter(([, j]) => !j || now() - (j.created || 0) > JOB.keepMs).map(([k]) => k);
  if (old.length) await storage.delete(old);
}

/** The view the page polls. */
function view(job, after) {
  const out = { job: job.id, state: job.state, events: job.events.filter((e) => e.n > after), next: job.n, poll_ms: JOB.pollMs };
  if (job.state === 'done') out.result = job.result;
  if (job.state === 'failed') { out.error = job.error; out.code = job.code; }
  return out;
}

/** Two plans at once at most (ops.js asks before a plan is counted). */
export function roomForPlan(account) {
  if ([...mine(account).values()].filter((x) => x.job.state === 'running').length >= JOB.running) throw new TripError('Eden is already planning two trips for you. Wait for one, or cancel it.', 429, 'busy');
}

/** trip-plan-start / -status / -cancel. deps: { run, now }. The start's own checks and count are ops.js's. */
export async function planJobOp(account, op, body = {}, { run, now = () => Date.now() } = {}) {
  const storage = account.storage;
  const here = mine(account);
  if (op === 'trip-plan-start') {
    roomForPlan(account);
    await sweep(storage, now);
    const job = { id: hex(8), state: 'running', created: now(), updated: now(), body: { request: body.request, constraints: body.constraints }, events: [], n: 0, restarts: 0 };
    const entry = launch(account, job, run, now);
    await entry.save();
    return { job: job.id, state: job.state, poll_ms: JOB.pollMs };
  }
  const id = String(body.job || '');
  if (!ID.test(id)) throw new TripError('job must be a plan job id.');
  const live = here.get(id);
  let job = live ? live.job : await storage.get(key(id));
  if (!job) throw new TripError('There is no such plan (plans are kept a day).', 404, 'not_found');
  if (op === 'trip-plan-cancel') {
    if (job.state !== 'running') return { job: id, state: job.state };
    job.state = 'cancelled';
    job.updated = now();
    keep(job, { type: 'stage', stage: 'cancelled', text: 'Stopped. Nothing was saved.' });
    if (live) { live.ctl.abort(); await live.save(); } else await storage.put(key(id), job);
    return { job: id, state: job.state };
  }
  if (op !== 'trip-plan-status') throw new TripError('Unknown trip op.', 404, 'not_found');
  const after = Number.isInteger(Number(body.after)) && Number(body.after) >= 0 ? Number(body.after) : 0;
  if (job.state === 'running' && !live) {
    // cut off by a restart of this object: once more from the start, if it's recent; else it says so
    if (job.restarts < JOB.restarts && now() - job.created < JOB.restartWithinMs) {
      job.restarts++;
      keep(job, { type: 'stage', stage: 'restarted', text: 'Eden’s server restarted mid-plan: planning again from the start.' });
      job.updated = now();
      const entry = launch(account, job, run, now);
      await entry.save();
    } else {
      job.state = 'failed';
      job.error = 'The plan was cut off on Eden’s server. Try again.';
      job.code = 'interrupted';
      keep(job, { type: 'stage', stage: 'failed', text: job.error });
      job.updated = now();
      await storage.put(key(id), job);
    }
  }
  return view(job, after);
}

/** For tests: the work of a job this instance runs (resolves when it ends). */
export const jobWork = (account, id) => (mine(account).get(id) || {}).work || Promise.resolve();
/** For tests: forget the jobs this instance holds, as a restart of the object would. */
export const forgetJobs = (account) => RUNNING.delete(account);
