// The Gemma claim judge (hidden-state probes on Gemma + Qwen, served on Modal) next to EVES's web evidence check.
//
//   GEMMA_JUDGE_MODE  off (default) | shadow | owner          [vars]
//   GEMMA_JUDGE_URL   the Modal web endpoint, no trailing /judge   (secret)
//                     several copies: comma-separated (same model and config at each). Calls are spread over the warm
//                     ones by the key pool (key-pool.js) and move to the next on 429/5xx/network; one URL = as before.
//   GEMMA_JUDGE_KEY / GEMMA_JUDGE_SECRET  a Modal proxy-auth token, sent as Modal-Key / Modal-Secret   (secrets)
//
// shadow: every website turn's checked claims are also sent to the judge in the background (ctx.waitUntil); its verdict is
//         only logged ("gemma_shadow"); the answer is EVES's, byte for byte.
// owner:  the same for everyone, except owner accounts (owner-emails.js): their settled claims ("supported" /
//         "contradicted" at the judge's frozen thresholds) take the judge's verdict ("gemma_owner"); "escalate", a cold
//         judge, a timeout, a 429/5xx or bad JSON leave EVES's own verdict.
// The iPhone and Edu apps (UA EdenApp/ or EdenEdu/, as pages.js isIosAppRequest) never reach the judge, not even a ping.
// Evidence is the text EVES's own web check already produced for the claim (no page is fetched for the judge).
// A cold judge is never waited on: the turn goes on as today and at most one warm-up ping a minute is sent in the background.
// Only an owner turn sends that ping: a shadow turn runs only on a judge that is already warm, never waking it
// (gemma-spend.js; GEMMA_SHADOW_WAKE=on: shadow turns ping as before 2026-11-10).

import { withPool } from './key-pool.js';
import { COLD_PING_MS, mayWake, meterJudge, shadowCapped } from './gemma-spend.js';

export const APP_UA = /\b(?:EdenApp|EdenEdu)\//; // website-only experiments: the iPhone and Edu apps stay off
const MODES = new Set(['off', 'shadow', 'owner']);
export const GEMMA_TIMEOUT_MS = 6_000;
const PING_EVERY_MS = 60_000;
const PING_TIMEOUT_MS = 25_000; // waitUntil runs at most ~30 s after the response; the request only needs to start the container
const WARM_FOR_MS = 240_000; // Modal scaledown_window is 300 s; stay under it
const MAX_CLAIMS = 64; // server.py limit
const MAX_ROW = 1_400; // server.py limit per evidence row
const SETTLED = new Set(['supported', 'contradicted']);
// The web check's stock summaries carry no evidence of their own (vendor/verify.js)
const EMPTY_SUMMARY = /^(?:Sources confirm it\.|Sources show it is wrong\.|The web search found no clear evidence either way\.|The web check gave no usable answer\.)$/;

const POOL = 'gemma-judge'; // the key pool's name for the judge URLs (GET /api/admin/lb shows fingerprints only)

// Per isolate and per judge URL: Workers isolates share no memory, so each one learns warmth on its own (a cold isolate
// pings, never waits).
const state = new Map(); // base URL → { warmUntil, lastPing }
const urlState = (u) => {
  let s = state.get(u);
  if (!s) state.set(u, (s = { warmUntil: 0, lastPing: 0 }));
  return s;
};
const warmNow = (u) => Date.now() < (state.get(u)?.warmUntil ?? 0);
export function resetGemmaJudge() {
  state.clear();
}

/** The judge's base URLs from GEMMA_JUDGE_URL (comma-separated), without a trailing / or /judge. */
export const judgeUrls = (env) => [...new Set(String((env && env.GEMMA_JUDGE_URL) || '').split(',').map((u) => u.trim().replace(/\/+$/, '').replace(/\/judge$/, '')).filter(Boolean))];

export function gemmaMode(env, request) {
  if (request && APP_UA.test(request.headers.get('user-agent') || '')) return 'off';
  if (!judgeCreds(env)) return 'off';
  const m = String(env.GEMMA_JUDGE_MODE ?? 'off').trim().toLowerCase();
  return MODES.has(m) ? m : 'off';
}

const headers = (env) => ({ 'content-type': 'application/json', 'Modal-Key': env.GEMMA_JUDGE_KEY, 'Modal-Secret': env.GEMMA_JUDGE_SECRET });

export async function claimHash(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(d).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The evidence rows for one claim: what EVES's web check read, never the answer's own words. */
export function evidenceRows(v) {
  if (!v || v.verdict === 'unresolved' || !Array.isArray(v.sources) || !v.sources.length) return [];
  const s = typeof v.summary === 'string' ? v.summary.trim() : '';
  if (!s || EMPTY_SUMMARY.test(s)) return [];
  return [s.slice(0, MAX_ROW)];
}

/** Is any judge URL warm (env given: any of its URLs; none: any this isolate knows)? */
export const judgeIsWarm = (env) => (env ? judgeUrls(env) : [...state.keys()]).some(warmNow);
export const judgeCreds = (env) => Boolean(env && judgeUrls(env).length && env.GEMMA_JUDGE_KEY && env.GEMMA_JUDGE_SECRET);

/** Warm-up pings for the judge URLs that are cold (at most one a minute each); warm ones are left alone. */
export function ping(env, ctx) {
  const now = Date.now();
  for (const u of judgeUrls(env)) {
    const s = urlState(u);
    if (now < s.warmUntil || now - s.lastPing < PING_EVERY_MS) continue;
    s.lastPing = now;
    const p = fetch(`${u}/health`, { headers: headers(env), signal: AbortSignal.timeout(PING_TIMEOUT_MS) })
      .then(async (r) => {
        const j = r.ok ? await r.json().catch(() => null) : null;
        if (j && j.ok && j.loaded) s.warmUntil = Date.now() + WARM_FOR_MS;
        const ms = Date.now() - now;
        meterJudge(env, ctx, { ms, woke: ms >= COLD_PING_MS, feature: 'gemma-wake' }); // a slow answer: it started the GPU (an estimate)
      })
      .catch(() => undefined);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
  }
}

/**
 * One POST /judge for a turn's claims. Resolves { ok, results?, error, ms }; never throws.
 * Several URLs: only the warm ones take the call (a cold one would hold it until the timeout; none warm: all of them),
 * spread by the key pool, moving to the next on 429/5xx/network. The timeout covers the whole walk.
 */
export async function judge(env, claims, signal, timeoutMs = GEMMA_TIMEOUT_MS, { coolOnTimeout = true } = {}) {
  const t0 = Date.now();
  const timeout = AbortSignal.timeout(timeoutMs);
  const sig = signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([timeout, signal]) : timeout;
  const all = judgeUrls(env);
  const warm = all.filter(warmNow);
  const cool = (u) => {
    urlState(u).warmUntil = 0;
  };
  let at = null; // the URL last called
  const call = async (u) => {
    at = u;
    try {
      const res = await fetch(`${u}/judge`, { method: 'POST', headers: headers(env), body: JSON.stringify({ claims, lazy_second: true }), signal: sig, redirect: 'manual' });
      if (!res.ok) cool(u);
      return res;
    } catch (e) {
      // a request cut by a short caller budget (gemma-text.js) says the judge is slow, not that it is cold
      if (!timeout.aborted || coolOnTimeout) cool(u);
      throw e;
    }
  };
  try {
    const list = warm.length ? warm : all;
    const r = await withPool(POOL, list, call, { signal: sig, env });
    if (!r) {
      // stopped before any call (signal already aborted): label and cool as a cut fetch did with one URL
      if (sig.aborted && list.length === 1 && (!timeout.aborted || coolOnTimeout)) cool(list[0]);
      const error = timeout.aborted ? 'timeout' : signal && signal.aborted ? 'stopped' : 'network';
      return { ok: false, error, ms: Date.now() - t0 };
    }
    if (!r.ok) return { ok: false, error: `http_${r.status}`, ms: Date.now() - t0 };
    let j;
    try {
      j = await r.json();
    } catch {
      j = null;
    }
    if (!j || !Array.isArray(j.results)) {
      cool(at);
      return { ok: false, error: 'bad_json', ms: Date.now() - t0 };
    }
    urlState(at).warmUntil = Date.now() + WARM_FOR_MS;
    return { ok: true, results: j.results, config: typeof j.config === 'string' ? j.config : null, ms: Date.now() - t0 };
  } catch {
    const error = timeout.aborted ? 'timeout' : signal && signal.aborted ? 'stopped' : 'network';
    return { ok: false, error, ms: Date.now() - t0 };
  }
}

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/**
 * A turn's judge session, or null when the judge is off for this request (mode off, app UA, secrets missing).
 * whoIsOwner: () => Promise<boolean>, asked only in owner mode, started here so it is settled by the time claims are.
 */
/** Is this turn in the shadow sample? GEMMA_SHADOW_SHARE (0..1, default 1) of website turns; owners are always judged. */
export function shadowSampled(env, rand = Math.random) {
  const share = Number(env && env.GEMMA_SHADOW_SHARE);
  return !Number.isFinite(share) || share >= 1 || rand() < Math.max(0, share);
}

export function gemmaSession(request, env, ctx, whoIsOwner, { shadow = true } = {}) {
  const mode = gemmaMode(env, request);
  if (mode === 'off') return null;
  const ownerP = mode === 'owner' ? Promise.resolve().then(whoIsOwner).then(Boolean, () => false) : Promise.resolve(false);
  ownerP.catch(() => undefined);
  return {
    mode,
    /**
     * items: [{ id, claim, kind, v }] where v is checkEvidence's result. Returns a Map id → the verdict to use instead
     * of v (owner accounts, settled claims only); empty otherwise. Never throws, never waits on a cold judge.
     */
    async settle(items, { signal } = {}) {
      const out = new Map();
      try {
        const usable = items.map((it) => ({ ...it, rows: evidenceRows(it.v) })).filter((it) => it.rows.length && typeof it.claim === 'string' && it.claim.trim()).slice(0, MAX_CLAIMS);
        if (!usable.length) return out;
        const live = await ownerP;
        if (!live && !shadow) return out; // not in this turn's shadow sample (GEMMA_SHADOW_SHARE)
        const evt = live ? 'gemma_owner' : 'gemma_shadow';
        const hashes = await Promise.all(usable.map((it) => claimHash(it.claim)));
        const wake = mayWake(env, live); // gemma-spend.js: a shadow turn never wakes a cold judge (GEMMA_SHADOW_WAKE=on: as before)
        if (!judgeIsWarm(env)) {
          if (wake) ping(env, ctx);
          console.log(JSON.stringify({ evt, cold: true, used: false, claims: usable.length, eves: usable.map((it) => it.v.verdict), ...(wake ? {} : { woke: false }) }));
          return out;
        }
        if (wake) ping(env, ctx); // warms any other judge copy that is cold (one URL: nothing to do)
        const claims = usable.map((it, k) => ({ id: String(k), claim: it.claim.slice(0, 1000), type: it.kind || null, evidence: it.rows }));
        const report = (r) => {
          meterJudge(env, ctx, { ms: r.ms, paid: live, feature: live ? 'gemma-owner' : 'gemma-shadow' }); // GPU time, an estimate (spend-counter.js)
          if (!r.ok) {
            console.log(JSON.stringify({ evt, cold: false, used: false, error: r.error, ms: r.ms, claims: usable.length }));
            return;
          }
          const byId = new Map(r.results.map((x) => [String(x && x.id), x]));
          usable.forEach((it, k) => {
            const g = byId.get(String(k)) || {};
            const verdict = typeof g.verdict === 'string' ? g.verdict : null;
            const used = live && SETTLED.has(verdict);
            console.log(JSON.stringify({ evt, claim: hashes[k], kind: it.kind || null, gemma: verdict, S: num(g.S), C: num(g.C), eves: it.v.verdict, agree: verdict === it.v.verdict, used, ms: r.ms, cold: false, config: r.config }));
            if (used) out.set(it.id, verdict);
          });
        };
        if (!live) {
          // shadow: the answer never waits on the judge
          // SPEND_CAP_MODAL_USD reached today (CREDIT_PACER=on, gemma-spend.js): no shadow call, only a log line
          const p = shadowCapped(env)
            .then((capped) => (capped ? console.log(JSON.stringify({ evt, cold: false, used: false, capped: true, claims: usable.length })) : judge(env, claims).then(report)))
            .catch(() => undefined);
          if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
          return out;
        }
        report(await judge(env, claims, signal));
      } catch {
        out.clear();
      }
      return out;
    },
  };
}

/** checkEvidence's result as the judge settled it: its sources and summary stay, the verdict is the judge's. */
export function withGemmaVerdict(v, verdict) {
  if (!v || !SETTLED.has(verdict) || v.verdict === verdict) return v;
  const { fixedSentence, lean, ...rest } = v;
  return { ...rest, verdict };
}
