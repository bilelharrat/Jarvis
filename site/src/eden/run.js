// POST /api/chat/run: the code canvas's cloud runner (Eden's web/chat/canvas-run.js calls it for
// languages the browser can't run: TypeScript, Bash, Go, Rust, C/C++, Java, Ruby, PHP).
// JavaScript and Python run in the viewer's own browser and never come here.
//
// Signed-in browsers only, from askeden.com's own page, a few runs a minute per account, and
// run-minutes a month by plan (Free 30, Plus 300; RUN_MINUTES_FREE / RUN_MINUTES_PLUS change
// them). Each run: at most 30 s, its code and input size-capped, no outbound network, a memory
// cap. Code and output are never logged or stored.
//
// The runner itself is a Cloudflare Sandbox (a Container per account behind a Durable Object,
// bound as CODE_SANDBOX). Until that binding exists this answers 503 "coming soon".

import { call, limited } from '../accounts/index.js';
import { ApiError } from '../accounts/util.js';
import { currentSession } from './session.js';
import { crossSite, json, problem, sameOrigin } from './web.js';

export const RUN_PATH = '/api/chat/run';

export const RUN_LIMITS = { codeBytes: 100_000, stdinBytes: 64_000, outputBytes: 200_000, timeMs: 30_000, memoryMb: 512 };
export const RUN_MINUTES = { free: 30, plus: 300 };
export const CLOUD_LANGS = ['typescript', 'bash', 'go', 'rust', 'c', 'cpp', 'java', 'ruby', 'php', 'python', 'javascript'];

const bytes = (s) => new TextEncoder().encode(String(s ?? '')).length;

/** The body of a run, checked: { lang, code, stdin } or an ApiError. */
export function checkRun(body) {
  if (!body || typeof body !== 'object') throw new ApiError(400, 'bad_request', 'Send { lang, code }.');
  const { lang, code, stdin = '' } = body;
  if (typeof lang !== 'string' || !CLOUD_LANGS.includes(lang)) throw new ApiError(400, 'bad_language', 'That language doesn’t run here.');
  if (typeof code !== 'string' || !code.trim()) throw new ApiError(400, 'no_code', 'There’s no code to run.');
  if (typeof stdin !== 'string') throw new ApiError(400, 'bad_request', 'Input has to be text.');
  if (bytes(code) > RUN_LIMITS.codeBytes) throw new ApiError(413, 'too_big', `Code over ${RUN_LIMITS.codeBytes / 1000} KB doesn’t run.`);
  if (bytes(stdin) > RUN_LIMITS.stdinBytes) throw new ApiError(413, 'too_big', `Input over ${RUN_LIMITS.stdinBytes / 1000} KB doesn’t run.`);
  return { lang, code, stdin };
}

// ── run-minutes, a month per account ──

export const monthOf = (now) => new Date(now).toISOString().slice(0, 7);
export function runAllowance(env = {}, plus = false) {
  const n = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return plus ? n(env.RUN_MINUTES_PLUS, RUN_MINUTES.plus) : n(env.RUN_MINUTES_FREE, RUN_MINUTES.free);
}
/** A run's charge: its wall time in whole seconds, at least one, at most the time limit. */
export const runCharge = (ms) => Math.min(RUN_LIMITS.timeMs, Math.max(1000, Math.ceil(Math.max(0, Number(ms) || 0) / 1000) * 1000));
/** Usage after one more run (a new month starts at 0). */
export function addRun(usage, ms, now) {
  const month = monthOf(now);
  const base = usage && usage.month === month ? usage.ms : 0;
  return { month, ms: base + runCharge(ms), runs: (usage && usage.month === month ? usage.runs || 0 : 0) + 1 };
}
export const runMinutesLeft = (usage, limit, now) => Math.max(0, limit - ((usage && usage.month === monthOf(now) ? usage.ms : 0) / 60000));
/** May another run start? It needs a whole run's time left, so no run goes past the allowance. */
export const mayRun = (usage, limit, now) => runMinutesLeft(usage, limit, now) * 60000 >= RUN_LIMITS.timeMs;

export async function runApi(request, env) {
  try {
    if (request.method !== 'POST') throw new ApiError(405, 'bad_request', 'POST a run.');
    if (!sameOrigin(request) || crossSite(request)) throw new ApiError(403, 'forbidden', 'Only askeden.com’s own page may do that.');
    const { session } = await currentSession(request, env);
    if (!session) throw new ApiError(401, 'signed_out', 'Sign in to run code in the cloud.');
    await limited(env, 'RUN_RATE', session.account);
    let body;
    try { body = await request.json(); } catch { throw new ApiError(400, 'bad_request', 'Send JSON.'); }
    const run = checkRun(body);
    if (!env.CODE_SANDBOX) throw new ApiError(503, 'not_set_up', 'The cloud runner is coming soon. JavaScript and Python run in your browser now.');
    let plus = false;
    try { plus = Boolean((await call(env, session.account, 'get', {}, session.token)).plan?.active); } catch { /* the free allowance */ }
    const stub = env.CODE_SANDBOX.get(env.CODE_SANDBOX.idFromName(session.account));
    const res = await stub.fetch('https://run/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-eden-plus': plus ? '1' : '0', 'x-eden-allowance': String(runAllowance(env, plus)) },
      body: JSON.stringify({ ...run, limits: RUN_LIMITS }),
    });
    return json(await res.json(), res.status);
  } catch (error) {
    if (error instanceof ApiError) return problem(error.status, error.message, error.code, error.headers);
    console.error('cloud run failed', error && error.name); // never the code or its output
    return problem(500, 'Something went wrong on the server. Try again.', 'server');
  }
}
