// The Gemma claim judge (hidden-state probes on Gemma + Qwen, served on Modal) next to EVES's web evidence check.
//
//   GEMMA_JUDGE_MODE  off (default) | shadow | owner          [vars]
//   GEMMA_JUDGE_URL   the Modal web endpoint, no trailing /judge   (secret)
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

export const APP_UA = /^(?!.*\bEdenBeta\/).*\b(?:EdenApp|EdenEdu)\//; // not a TestFlight beta (EdenBeta/): that gets the website's features
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

// Per isolate: Workers isolates share no memory, so each one learns warmth on its own (a cold isolate pings, never waits).
const state = { warmUntil: 0, lastPing: 0 };
export function resetGemmaJudge() {
  state.warmUntil = 0;
  state.lastPing = 0;
}

export function gemmaMode(env, request) {
  if (request && APP_UA.test(request.headers.get('user-agent') || '')) return 'off';
  if (!env || !env.GEMMA_JUDGE_URL || !env.GEMMA_JUDGE_KEY || !env.GEMMA_JUDGE_SECRET) return 'off';
  const m = String(env.GEMMA_JUDGE_MODE ?? 'off').trim().toLowerCase();
  return MODES.has(m) ? m : 'off';
}

const base = (env) => String(env.GEMMA_JUDGE_URL).replace(/\/+$/, '').replace(/\/judge$/, '');
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

export const judgeIsWarm = () => Date.now() < state.warmUntil;
export const judgeCreds = (env) => Boolean(env && env.GEMMA_JUDGE_URL && env.GEMMA_JUDGE_KEY && env.GEMMA_JUDGE_SECRET);

export function ping(env, ctx) {
  const now = Date.now();
  if (now - state.lastPing < PING_EVERY_MS) return;
  state.lastPing = now;
  const p = fetch(`${base(env)}/health`, { headers: headers(env), signal: AbortSignal.timeout(PING_TIMEOUT_MS) })
    .then(async (r) => {
      const j = r.ok ? await r.json().catch(() => null) : null;
      if (j && j.ok && j.loaded) state.warmUntil = Date.now() + WARM_FOR_MS;
    })
    .catch(() => undefined);
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
}

/** One POST /judge for a turn's claims. Resolves { ok, results?, error, ms }; never throws. */
export async function judge(env, claims, signal, timeoutMs = GEMMA_TIMEOUT_MS, { coolOnTimeout = true } = {}) {
  const t0 = Date.now();
  const timeout = AbortSignal.timeout(timeoutMs);
  const sig = signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([timeout, signal]) : timeout;
  try {
    const r = await fetch(`${base(env)}/judge`, { method: 'POST', headers: headers(env), body: JSON.stringify({ claims, lazy_second: true }), signal: sig, redirect: 'manual' });
    if (!r.ok) {
      state.warmUntil = 0;
      return { ok: false, error: `http_${r.status}`, ms: Date.now() - t0 };
    }
    let j;
    try {
      j = await r.json();
    } catch {
      j = null;
    }
    if (!j || !Array.isArray(j.results)) {
      state.warmUntil = 0;
      return { ok: false, error: 'bad_json', ms: Date.now() - t0 };
    }
    state.warmUntil = Date.now() + WARM_FOR_MS;
    return { ok: true, results: j.results, config: typeof j.config === 'string' ? j.config : null, ms: Date.now() - t0 };
  } catch (e) {
    const error = timeout.aborted ? 'timeout' : signal && signal.aborted ? 'stopped' : 'network';
    // a request cut by a short caller budget (gemma-text.js) says the judge is slow, not that it is cold
    if (error !== 'timeout' || coolOnTimeout) state.warmUntil = 0;
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
        if (Date.now() >= state.warmUntil) {
          ping(env, ctx);
          console.log(JSON.stringify({ evt, cold: true, used: false, claims: usable.length, eves: usable.map((it) => it.v.verdict) }));
          return out;
        }
        const claims = usable.map((it, k) => ({ id: String(k), claim: it.claim.slice(0, 1000), type: it.kind || null, evidence: it.rows }));
        const report = (r) => {
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
          const p = judge(env, claims).then(report, () => undefined);
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
