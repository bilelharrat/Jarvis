// The company spend counter on askeden.com (askeden docs/spend-guard.md): the GCP credit pacer's day counter
// (credit-pacer.js), widened to every paid provider the Worker calls, split paid and unpaid.
//
//   google      Gemini, Imagen, Veo: credit-pacer.js itself (the credit pacing rule: allowance to expiry, green/amber/red)
//   anthropic   Claude (the service key, the stand-ins), openai (GPT), moonshot (Kimi), perplexity (Sonar checks),
//   deepinfra   privacy turns (chat.js), fish (Fish Audio voice, at list price per byte: an upper bound),
//   modal       the Gemma claim judge's GPU time: an ESTIMATE (call time, a cold start counted as a whole warm window)
//   maps        Google Maps for Travel: travel/spend.js counts and caps it already (the object tspend:global, UTC days);
//               it is only read here, for /admin, never counted twice
//
// The same switch as the pacer: CREDIT_PACER off (default) = nothing at all; warn = counted, nothing refused; on =
// counted, and a provider with a cap refuses unpaid use once today's unpaid spend reaches it:
//   SPEND_CAP_<PROVIDER>_USD   e.g. SPEND_CAP_ANTHROPIC_USD=10: unpaid use of that provider a (Pacific) day, unset = no cap.
//                              Not for Google (its credit pacing rule decides) or Maps (TRAVEL_GOOGLE_DAILY_USD decides).
//                              The cap counts every unpaid call of that provider, but only these refuse once it is full:
//                              chat turns (the first model and each fallback), Compare, EVES (every metered lane, check
//                              model and Perplexity), private chats (DEEPINFRA_CHARGE=on), voice (Fish) and the Gemma
//                              shadow (Modal). Ask, tasks, autodrafts, browser turns, images, courses and the apps' proxy
//                              are counted, not refused: they keep their own allowance holds.
// Paid use (Plus, credits, a course budget, the owner family, Router API clients) is counted, never refused.
//
// Only calls on the service's own keys are counted (a person's own API key is theirs to pay): the hooks are where the
// pacer's were (meterGoogle, which now hands anything that isn't Google to meterProvider here), plus DeepInfra, Fish
// and the Gemma judge. Nothing here may slow or break a request: counting runs after the call (ctx.waitUntil), a
// counter that fails is logged and the request goes on ("fail open"), a reading is reused for 10 s.
//
// Storage: the pacer's own object ("credit-pacer", in VOICE_QUOTA), its own keys `p:<day>` → { <provider>: { paid,
// unpaid, calls, by } }, so the pacer's `d:<day>` records (and what it has spent against the credits) never change.

import { ApiError } from '../accounts/util.js';
import { MODELS } from './vendor/model-router.js';
import { datedModel } from './dated-prices.js';
import { COUNTER_OBJECT, allowPaid, creditCounterFetch, isGoogle, pacerMode, pacerStatus, pacificParts, paidBucket, secondsToPacificMidnight, validDay } from './credit-pacer.js';

export const PROVIDERS = Object.freeze([
  Object.freeze({ id: 'google', name: 'Google AI (Gemini)', capVar: null }),
  Object.freeze({ id: 'anthropic', name: 'Anthropic (Claude)', capVar: 'SPEND_CAP_ANTHROPIC_USD' }),
  Object.freeze({ id: 'openai', name: 'OpenAI (GPT)', capVar: 'SPEND_CAP_OPENAI_USD' }),
  Object.freeze({ id: 'moonshot', name: 'Moonshot (Kimi)', capVar: 'SPEND_CAP_MOONSHOT_USD' }),
  Object.freeze({ id: 'perplexity', name: 'Perplexity', capVar: 'SPEND_CAP_PERPLEXITY_USD' }),
  Object.freeze({ id: 'deepinfra', name: 'DeepInfra (private chats)', capVar: 'SPEND_CAP_DEEPINFRA_USD' }),
  Object.freeze({ id: 'fish', name: 'Fish Audio (voice)', capVar: 'SPEND_CAP_FISH_USD' }),
  Object.freeze({ id: 'modal', name: 'Modal (Gemma judge, estimate)', capVar: 'SPEND_CAP_MODAL_USD' }),
  Object.freeze({ id: 'maps', name: 'Google Maps (Travel)', capVar: null }),
]);
const KNOWN = new Set(PROVIDERS.map((p) => p.id));
const ID = /^[a-z0-9-]{1,24}$/;
const FEATURE = /^[a-z0-9_-]{1,24}$/;
const STATUS_TTL_MS = 10_000;
const TIMEOUT_MS = 1500;
const URL_BASE = 'https://credit-pacer';

/** What a person sees when a provider's free use is full today. Plain: what happened, what to do. */
export const SPEND_COPY = Object.freeze({
  model: 'Free use of this model is full for today. Pick another model, get Plus in Settings › Account, or try again tomorrow.',
  privacy: 'Free private chats are full for today. Plus keeps working: get it in Settings › Account. Or try again tomorrow.',
  voice: 'Free voice is full for today. Plus keeps working: get it in Settings › Account. Or try again tomorrow.',
});

// ── list prices the counter needs that no registry has (dated: a price applies from its day on) ──

/** Fish Audio TTS, dollars per million UTF-8 bytes of text (fish.audio pricing, read 2026-11-10; the free model may bill $0). */
export const FISH_PRICES = Object.freeze([Object.freeze({ from: '2025-01-01', perMillionBytes: 15 })]);
/**
 * Modal GPU time for the Gemma judge (A100 80 GB, list $/s, read 2026-11-10), and what a cold start costs: the start
 * itself plus the warm window Modal keeps it up for afterwards (scaledown 300 s), so about $0.25 a wake.
 */
export const MODAL_PRICES = Object.freeze([Object.freeze({ from: '2025-01-01', gpuPerSecond: 0.000694, wakeSeconds: 360 })]);
const rowOn = (rows, day) => rows.reduce((row, r) => (day >= r.from ? r : row), rows[0]);

const round6 = (x) => Math.round(x * 1e6) / 1e6;
const num0 = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : 0);
const log = (evt, extra) => {
  try {
    console.log(JSON.stringify({ evt, ...extra }));
  } catch {
    // never
  }
};
const failed = (where, error) => log('spend_counter_fail', { where, why: String((error && error.message) || error).slice(0, 160) });

/** Fish Audio's cost for one text at `at` (an upper bound: list price per UTF-8 byte). */
export function fishCostUSD(text, at = Date.now()) {
  const bytes = new TextEncoder().encode(String(text || '')).length;
  return round6((bytes * rowOn(FISH_PRICES, pacificParts(at).day).perMillionBytes) / 1e6);
}

/** The Gemma judge's GPU cost, estimated: `ms` of a call, or a whole warm window when it `woke` a cold judge. */
export function modalCostUSD({ ms = 0, woke = false, at = Date.now() } = {}) {
  const row = rowOn(MODAL_PRICES, pacificParts(at).day);
  return round6((woke ? row.wakeSeconds : num0(ms) / 1000) * row.gpuPerSecond);
}

// ── which provider ──

const ALIASES = { gemini: 'google', vertex: 'google', google: 'google', claude: 'anthropic', kimi: 'moonshot', 'gemma-judge': 'modal' };
/** The counter's provider for a call: the provider's name (aliases folded), else the model's; 'other' when unknown. */
export function providerId(provider, model) {
  const p = String(provider || '').trim().toLowerCase();
  if (p) {
    const id = ALIASES[p] || p;
    return ID.test(id) ? id : 'other';
  }
  const m = String(model || '').replace(/^models\//, '').toLowerCase();
  if (isGoogle(null, m)) return 'google';
  if (/^claude/.test(m)) return 'anthropic';
  if (/^(?:gpt|o\d|chatgpt|text-embedding-3|whisper|dall-e)/.test(m)) return 'openai';
  if (/^kimi|^moonshot/.test(m)) return 'moonshot';
  if (/^sonar/.test(m)) return 'perplexity';
  return 'other';
}

/** A call's dollars: the path's own, else its token counts at the registry's (dated) price; 0 when it can't say. */
export function providerCostUSD({ model = null, usd = 0, usage = null, at = Date.now() } = {}) {
  const given = num0(usd);
  if (given > 0) return round6(given);
  const u = usage || {};
  const m = MODELS.find((x) => x.id === String(model || '').replace(/^models\//, ''));
  if (!m || !m.pricing) return 0;
  const p = datedModel(m, at).pricing;
  const input = num0(u.inputTokens);
  const cached = Math.min(input, num0(u.cachedInputTokens));
  const out = num0(u.outputTokens) + num0(u.reasoningTokens);
  return round6(((input - cached + cached * (m.provider === 'openai' ? 0.5 : 0.1)) * num0(p.inputPer1M) + out * num0(p.outputPer1M)) / 1e6);
}

// ── the counter's side (worker.js VoiceQuota hands https://credit-pacer/... to companyCounterFetch) ──

const queues = new WeakMap();
/** The pacer's object, with this counter's two requests: POST /spend and POST /spend-status; the rest is the pacer's. */
export function companyCounterFetch(storage, request) {
  const { pathname } = new URL(request.url);
  if (pathname !== '/spend' && pathname !== '/spend-status') return creditCounterFetch(storage, request);
  const run = (queues.get(storage) || Promise.resolve()).then(() => spendRequest(storage, request, pathname));
  queues.set(storage, run.catch(() => {}));
  return run;
}

async function spendRequest(storage, request, pathname) {
  if (request.method !== 'POST') return Response.json({ ok: false, error: 'POST only' }, { status: 405 });
  const body = await request.json().catch(() => ({}));
  const bad = (why) => Response.json({ ok: false, error: why }, { status: 400 });
  const day = validDay(body.day);
  if (!day) return bad('day');
  const key = `p:${day}`;
  if (pathname === '/spend-status') return Response.json({ ok: true, day, providers: (await storage.get(key)) || {} });
  const provider = String(body.provider || '');
  const usd = Number(body.usd);
  if (!ID.test(provider) || provider === 'google' || provider === 'maps') return bad('provider'); // Google: /add (the pacer's); Maps: travel/spend.js
  if (!Number.isFinite(usd) || usd <= 0 || usd > 10_000) return bad('usd');
  const all = (await storage.get(key)) || {};
  const rec = { paid: 0, unpaid: 0, calls: 0, by: {}, ...(all[provider] || {}) };
  const side = body.paid === true ? 'paid' : 'unpaid';
  rec[side] = round6(num0(rec[side]) + usd);
  rec.calls = (Number(rec.calls) || 0) + 1;
  const feature = FEATURE.test(String(body.feature || '')) ? String(body.feature) : 'other';
  rec.by = { ...rec.by, [`${side}:${feature}`]: round6(num0(rec.by && rec.by[`${side}:${feature}`]) + usd) };
  const next = { ...all, [provider]: rec };
  await storage.put(key, next);
  return Response.json({ ok: true, day, providers: next });
}

// ── the Worker's side ──

async function post(env, path, body) {
  const ns = env && env.VOICE_QUOTA;
  if (!ns || typeof ns.get !== 'function' || typeof ns.idFromName !== 'function') throw new Error('no counter: the VOICE_QUOTA binding is missing');
  let timer;
  const slow = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('the counter took too long')), TIMEOUT_MS);
  });
  try {
    const ask = (async () => {
      const res = await ns.get(ns.idFromName(COUNTER_OBJECT)).fetch(`${URL_BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const out = await res.json().catch(() => null);
      if (!res.ok || !out || !out.ok) throw new Error(`the counter answered ${res.status}${out && out.error ? `: ${out.error}` : ''}`);
      return out;
    })();
    ask.catch(() => {});
    return await Promise.race([ask, slow]);
  } finally {
    clearTimeout(timer);
  }
}

// one Worker copy's last reading of today's providers: { day, until, providers } (a failure: { day, until, failed })
let reading = null;
let pending = null;
/** Tests: forget the last reading. */
export function resetSpendCache() {
  reading = null;
  pending = null;
}

const whoPays = ({ paid, bucket, credits, allow }) => (typeof paid === 'boolean' ? paid : allow && allow.daredevil ? false : paidBucket(bucket) || Number(credits) > 0 || allowPaid(allow));

/**
 * Counts one paid call that isn't Google's (Google's go to credit-pacer.js meterGoogle, which hands the rest here). Fire
 * and forget: never throws, never awaited by a reply (ctx.waitUntil keeps it alive). CREDIT_PACER off: nothing.
 * → the counting's promise, or null when nothing is counted.
 */
export function meterProvider(env, ctx, { provider = null, model = null, usd = 0, usage = null, bucket = null, credits = 0, allow = null, paid = null, feature = null, at = Date.now() } = {}) {
  try {
    if (pacerMode(env) === 'off') return null;
    const id = providerId(provider, model);
    if (id === 'google' || id === 'maps') return null; // the pacer's own, and travel/spend.js's
    const cost = providerCostUSD({ model, usd, usage, at });
    if (!(cost > 0)) return null;
    const { day } = pacificParts(at);
    const work = post(env, '/spend', { day, provider: id, usd: cost, paid: whoPays({ paid, bucket, credits, allow }), feature: feature || 'other' })
      .then((out) => {
        reading = { day, until: Date.now() + STATUS_TTL_MS, providers: out.providers || {} };
      })
      .catch((error) => failed('meter', error));
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(work);
    return work;
  } catch (error) {
    failed('meter', error);
    return null;
  }
}

/** Today's providers (not Google's, which the pacer keeps): { <provider>: { paid, unpaid, calls, by } }; throws on a failure. */
async function todayProviders(env, { now = Date.now(), fresh = false } = {}) {
  const { day } = pacificParts(now);
  if (!fresh && reading && reading.day === day && reading.until > now) {
    if (reading.failed) throw new Error(reading.failed);
    return reading.providers;
  }
  if (!fresh && pending && pending.day === day) return pending.promise;
  const promise = post(env, '/spend-status', { day }).then(
    (out) => {
      reading = { day, until: now + STATUS_TTL_MS, providers: out.providers || {} };
      return reading.providers;
    },
    (error) => {
      reading = { day, until: now + STATUS_TTL_MS, failed: String((error && error.message) || error).slice(0, 160) };
      throw error;
    },
  );
  const mine = { day, promise };
  pending = mine;
  promise.then(() => {}, () => {}).then(() => {
    if (pending === mine) pending = null;
  });
  return promise;
}

/** A provider's daily cap on unpaid use (SPEND_CAP_<PROVIDER>_USD), or null: unset, not a number, or not capped here. */
export function capFor(env, id) {
  const p = PROVIDERS.find((x) => x.id === id);
  const v = p && p.capVar && env ? env[p.capVar] : undefined;
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const levelOf = (unpaid, cap) => (cap === null ? 'no-cap' : unpaid >= cap ? 'red' : unpaid >= 0.7 * cap ? 'amber' : 'green');

/**
 * Whether a provider's unpaid use is full today: { full, retryAfter }. Only with CREDIT_PACER=on, a cap set for it, an
 * unpaid call and no CREDIT_ALLOW_DAY today; `paid` may be an async test, asked only when it would matter. Never throws:
 * a counter that fails says not full.
 */
export async function providerFull(env, provider, { paid = false, now = Date.now() } = {}) {
  const no = { full: false, retryAfter: null };
  try {
    if (pacerMode(env) !== 'on' || paid === true) return no;
    const id = providerId(provider, null);
    const cap = capFor(env, id);
    if (cap === null) return no;
    if (validDay(env && env.CREDIT_ALLOW_DAY) === pacificParts(now).day) return no;
    const rec = (await todayProviders(env, { now }))[id] || {};
    if (num0(rec.unpaid) < cap) return no;
    if (typeof paid === 'function' && (await paid())) return no;
    return { full: true, retryAfter: secondsToPacificMidnight(now) };
  } catch (error) {
    failed('cap', error);
    return no;
  }
}

/** providerFull as the refusal a chat turn throws (the page shows it as it shows the allowance's): or nothing. */
export async function providerCapCheck(env, provider, { paid = false, copy = SPEND_COPY.model, now = Date.now() } = {}) {
  const f = await providerFull(env, provider, { paid, now });
  if (f.full) throw new ApiError(402, 'no_allowance', copy, { 'retry-after': String(f.retryAfter || 3600) });
}

/** providerCapCheck for every provider a turn may call (aliases folded, each asked once): refuses if any is full. */
export async function providersCapCheck(env, providers, { paid = false, copy = SPEND_COPY.model, now = Date.now() } = {}) {
  const ids = [...new Set((providers || []).filter(Boolean).map((p) => providerId(p, null)))];
  for (const id of ids) await providerCapCheck(env, id, { paid, copy, now });
}

// Maps: read from travel/spend.js's own global counter (UTC days), never counted here
async function mapsToday(env, now) {
  if (!env || !env.ACCOUNTS) return null;
  const day = new Date(now).toISOString().slice(0, 10);
  const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName('tspend:global'));
  const res = await stub.fetch('https://account/tspend-read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `travel spend answered ${res.status}`);
  const rec = (out.days || []).find((d) => d.day === day);
  return { day, usd: round6(num0(rec && rec.usd)) };
}

/**
 * The pacer's status (pacerStatus) with every provider's spend today: `providers`: [{ id, name, paidUSD, unpaidUSD,
 * totalUSD, calls, capUSD, level, note }]. For the owner's /admin; never throws.
 */
export async function companySpendStatus(env = {}, { now = Date.now() } = {}) {
  const pacer = await pacerStatus(env, { now, fresh: true });
  if (pacer.mode === 'off') return { ...pacer, providers: [] };
  let others = {};
  let othersFailed = null;
  try {
    others = await todayProviders(env, { now, fresh: true });
  } catch (error) {
    othersFailed = String((error && error.message) || error).slice(0, 160);
  }
  let maps = null;
  let mapsFailed = null;
  try {
    maps = await mapsToday(env, now);
  } catch (error) {
    mapsFailed = String((error && error.message) || error).slice(0, 160);
  }
  const ids = [...PROVIDERS.map((p) => p.id), ...Object.keys(others).filter((id) => !KNOWN.has(id)).sort()];
  const providers = ids.map((id) => {
    const p = PROVIDERS.find((x) => x.id === id) || { id, name: id, capVar: null };
    if (id === 'google') {
      const paid = num0(pacer.paidTodayUSD);
      const unpaid = num0(pacer.unpaidTodayUSD);
      return { id, name: p.name, paidUSD: paid, unpaidUSD: unpaid, totalUSD: round6(paid + unpaid), calls: Number(pacer.calls) || 0, capUSD: pacer.allowanceUSD ?? null, level: pacer.failed ? 'failed' : pacer.level, note: 'Credit pacing: free use against the credits’ daily allowance.' };
    }
    if (id === 'maps') {
      if (mapsFailed || !maps) return { id, name: p.name, paidUSD: 0, unpaidUSD: 0, totalUSD: 0, calls: null, capUSD: null, level: mapsFailed ? 'failed' : 'no-cap', note: mapsFailed ? `Couldn’t read it (${mapsFailed}).` : 'Not set up here.' };
      return { id, name: p.name, paidUSD: 0, unpaidUSD: 0, totalUSD: maps.usd, calls: null, capUSD: null, level: 'no-cap', note: `Travel’s own counter (UTC day ${maps.day}), capped by TRAVEL_GOOGLE_DAILY_USD.` };
    }
    if (othersFailed) return { id, name: p.name, paidUSD: 0, unpaidUSD: 0, totalUSD: 0, calls: 0, capUSD: capFor(env, id), level: 'failed', note: `Couldn’t read it (${othersFailed}).` };
    const rec = others[id] || {};
    const paid = round6(num0(rec.paid));
    const unpaid = round6(num0(rec.unpaid));
    const cap = capFor(env, id);
    return { id, name: p.name, paidUSD: paid, unpaidUSD: unpaid, totalUSD: round6(paid + unpaid), calls: Number(rec.calls) || 0, capUSD: cap, level: levelOf(unpaid, cap), byFeature: rec.by || {}, ...(id === 'modal' ? { note: 'An estimate from GPU time, not Modal’s bill.' } : id === 'fish' ? { note: 'At list price per character sent; the free model may cost nothing.' } : {}) };
  });
  return { ...pacer, providers };
}
