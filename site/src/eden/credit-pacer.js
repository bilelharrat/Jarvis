// The GCP credit pacer on askeden.com (askeden docs/gcp-credit-plan-b.md): every Google AI call's cost goes into one
// company-wide daily counter, split paid and unpaid, and unpaid use is paced so the credits last until they expire.
// Every other provider's cost goes to the company spend counter (spend-counter.js, the same switch and object), which
// meterGoogle hands it to; the credit pacing rule below stays Google's only.
//
//   CREDIT_PACER                 off (default) | warn | on
//       off    nothing at all: no counting, no checks, no extra request (askeden.com as it was)
//       warn   every Google AI call is counted and a change of level is logged; nothing is refused or shrunk
//       on     counted, and unpaid use is paced: amber halves the unpaid daily caps, red refuses unpaid requests
//   CREDIT_BALANCE_USD           the credit balance on CREDIT_BALANCE_DATE (default 16000, a placeholder)
//   CREDIT_BALANCE_DATE          YYYY-MM-DD, the day that balance was read (default 2026-11-09)
//   CREDIT_EXPIRY                YYYY-MM-DD, the day the credits expire; unset: the fixed daily cap below
//   CREDIT_RESERVE_USD           kept back, never paced away (default 500)
//   CREDIT_UNPAID_DAILY_CAP_USD  unpaid Google AI a day when there's no expiry, or once it has passed (default 40)
//   CREDIT_ALLOW_DAY             YYYY-MM-DD (Pacific): that day nothing is refused or halved (still counted): "allow today"
//
// Set these as Worker secrets (`npx wrangler secret put CREDIT_PACER`, …), not as plain dashboard variables:
// wrangler.toml has a [vars] block and no keep_vars, so every `wrangler deploy` wipes dashboard variables, while
// secrets stay. A secret takes effect at once, without a deploy (CREDIT_ALLOW_DAY is the owner's quick override).
//
// The balance is askeden.com's share: this counter sees only the Worker's own Google calls, never Eden Code's on the
// Mac or anything else on the same credits. So CREDIT_BALANCE_USD is the slice of the credits askeden.com may use (the
// rest is the Mac's, its own pacer), refreshed from Billing › Credits with CREDIT_BALANCE_DATE. Spend made elsewhere
// can also be put on the counter as a day total (POST /external, recordExternal: "external", counted against the
// balance on later days and shown on /admin, never against today's free allowance).
//
// The rule (the same as Eden Code's on the owner's Mac):
//   allowance today = max(0, balance − reserve − spent since the balance date, before today) ÷ whole days left (≥ 1)
//                     no expiry (or past it): min(the daily cap, what's left)
//   level = red    unpaid today ≥ the allowance
//           amber  unpaid today ≥ 70% of it, or one clock hour today with unpaid > a quarter of it (a runaway)
//           green  otherwise
// Unused allowance rolls forward: each day's is worked out again from what's left. Days are Pacific
// (America/Los_Angeles), as Google's billing days are. Paid use (Plus, legacy Plus, the App Store, owner family, bought
// credits, a professor's course budget, Router API clients; a Plus account past its month's allowance on the trial
// too) is counted, so it shrinks later days' allowance, but is never refused or shrunk. Unpaid: the trial, Daredevil's
// free allowance, Edu free turns, Help (a paying account's questions aren't refused), anything else no one pays for.
// The Travel planner is Plus only (TRAVEL_PLUS), so its plans count as paid.
//
// A runaway is flagged whoever pays: today's Google AI in all (paid, unpaid and external) at RUNAWAY_DAY_FACTOR times
// the allowance, or one clock hour at the whole allowance. It never refuses anything (paid use is never throttled);
// status() says `runaway`, /admin shows it, and `credit_pacer_runaway` is logged once an hour while it lasts.
//
// The counter: one VoiceQuota object named "credit-pacer" (worker.js sends https://credit-pacer/... to
// creditCounterFetch below), so no new Durable Object class, binding or migration. One record a Pacific day.
//
// Prices: Google's list prices change by date (dated-prices.js, which charging uses too). A call with token counts is
// priced from them on its own (Pacific) day; one with only the path's dollars is scaled by the dated price over the
// price the path charged that day: 1 with dated charging (the default), so a cost is never scaled twice.
//
// Nothing here may break or slow a request: metering runs after the call (ctx.waitUntil where there is one), a counter
// that fails is logged and the request goes on as if green ("fail open"), a reading (or a failed one) is reused for
// 10 s, and requests at the same moment share one reading.

import { ApiError } from '../accounts/util.js';
import { DATED_PRICES, chargePriceOn, priceOn } from './dated-prices.js';
import { meterProvider } from './spend-counter.js'; // every other provider's day counter (askeden docs/spend-guard.md); used only inside meterGoogle

export const PACER_DEFAULTS = Object.freeze({ balanceUSD: 16000, balanceDate: '2026-11-09', reserveUSD: 500, unpaidDailyCapUSD: 40 });
export const AMBER_SHARE = 0.7;
export const BURST_SHARE = 0.25;
export const RUNAWAY_DAY_FACTOR = 3; // all of today's Google AI (paid too) at 3× the allowance: a runaway to look at
export const RUNAWAY_HOUR_SHARE = 1; // or one clock hour at the whole allowance
export const STATUS_TTL_MS = 10_000;
export const COUNTER_OBJECT = 'credit-pacer';
const COUNTER_URL = 'https://credit-pacer';
const TZ = 'America/Los_Angeles';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FEATURE = /^[a-z0-9_-]{1,24}$/;
const MIN_TRIAL_TURN_USD = 0.001; // chat.js: less than this left is no allowance
const MIN_EDU_TURN_USD = 0.002; // edu/budget.js EDU_FREE.minTurnUSD

// Google list prices per million tokens by the date they start (Pacific): dated-prices.js, shared with charging
export { DATED_PRICES, priceOn };
export const GROUNDING_QUERY_USD = 0.014; // Gemini 3.x grounding, per search query (providers.js GEMINI_QUERY_USD)

/** What a person sees when the pacer stops or shrinks free use. Plain words; what happens and what they can do. */
export const PACER_COPY = Object.freeze({
  full: 'Free use is full for today. Plus keeps working: get it in Settings › Account. Or try again tomorrow.',
  limited: 'Free use is limited today, and you’ve used your share. Plus keeps working: get it in Settings › Account. Or try again tomorrow.',
  eduFull: 'Free study AI is full for today. You can keep going on your own Eden allowance if you choose, or try again tomorrow.',
  eduLimited: 'Free study AI is limited today, and you’ve used your share. You can keep going on your own Eden allowance if you choose, or try again tomorrow.',
  help: 'Help’s chat is full for today. The Help pages still work, and Contact support reaches a person.',
  travel: 'Free trip planning is full for today. Plus keeps working, or start a trip by hand.',
  background: 'Free AI use is full for today, so this run was skipped. It runs again next time. Plus keeps it running: get it in Settings › Account.',
  backgroundLimited: 'Free AI use is limited today, and you’ve used your share, so this run was skipped. It runs again next time. Plus keeps it running: get it in Settings › Account.',
});

const round6 = (x) => Math.round(x * 1e6) / 1e6;
const num0 = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : 0);
const log = (evt, extra) => {
  try {
    console.log(JSON.stringify({ evt, ...extra }));
  } catch {
    // never
  }
};
const failed = (where, error) => log('credit_pacer_fail', { where, why: String((error && error.message) || error).slice(0, 160) });

// ── settings ──

/** off | warn | on. Anything else is off. */
export function pacerMode(env = {}) {
  const v = String((env && env.CREDIT_PACER) ?? '').trim().toLowerCase();
  return v === 'on' || v === 'warn' ? v : 'off';
}

const amount = (v, fallback) => {
  const n = Number(v);
  return v !== undefined && v !== null && String(v).trim() !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
};
/** A real YYYY-MM-DD, else null. */
export function validDay(v) {
  const s = String(v ?? '').trim();
  if (!DAY.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s ? s : null;
}

export function pacerConfig(env = {}) {
  const e = env || {};
  return {
    mode: pacerMode(e),
    balanceUSD: amount(e.CREDIT_BALANCE_USD, PACER_DEFAULTS.balanceUSD),
    balanceDate: validDay(e.CREDIT_BALANCE_DATE) || PACER_DEFAULTS.balanceDate,
    expiry: validDay(e.CREDIT_EXPIRY),
    reserveUSD: amount(e.CREDIT_RESERVE_USD, PACER_DEFAULTS.reserveUSD),
    unpaidDailyCapUSD: amount(e.CREDIT_UNPAID_DAILY_CAP_USD, PACER_DEFAULTS.unpaidDailyCapUSD),
    allowDay: validDay(e.CREDIT_ALLOW_DAY),
  };
}
const configView = (cfg) => ({ balanceUSD: cfg.balanceUSD, balanceDate: cfg.balanceDate, expiry: cfg.expiry, reserveUSD: cfg.reserveUSD, unpaidDailyCapUSD: cfg.unpaidDailyCapUSD, allowDay: cfg.allowDay });

// ── Pacific days ──

const PACIFIC = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

/** { day: 'YYYY-MM-DD', hour: 0..23, minute, second } on the Pacific clock. */
export function pacificParts(at = Date.now()) {
  const p = {};
  for (const x of PACIFIC.formatToParts(new Date(at))) if (x.type !== 'literal') p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second) };
}
export const pacificDay = (at = Date.now()) => pacificParts(at).day;
/** Seconds until the next Pacific midnight (a Retry-After), at least a minute. */
export function secondsToPacificMidnight(at = Date.now()) {
  const p = pacificParts(at);
  return Math.max(60, (23 - p.hour) * 3600 + (59 - p.minute) * 60 + (60 - p.second));
}
const dayNumber = (day) => Date.parse(`${day}T00:00:00Z`) / 86_400_000;
/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export const daysBetween = (from, to) => Math.round(dayNumber(to) - dayNumber(from));

// ── the rule ──

/** Today's unpaid allowance: { allowanceUSD, remainingUSD, daysLeft, rule }. `spentBeforeUSD`: since the balance date, before today. */
export function allowanceFor(cfg, { today, spentBeforeUSD = 0 }) {
  const remaining = Math.max(0, cfg.balanceUSD - cfg.reserveUSD - num0(spentBeforeUSD));
  if (cfg.expiry && today <= cfg.expiry) {
    const daysLeft = Math.max(1, daysBetween(today, cfg.expiry));
    return { allowanceUSD: round6(remaining / daysLeft), remainingUSD: round6(remaining), daysLeft, rule: 'until-expiry' };
  }
  // no expiry (or it has passed, and what's spent now is cash): a fixed daily cap, never past what's left
  return { allowanceUSD: round6(Math.min(cfg.unpaidDailyCapUSD, remaining)), remainingUSD: round6(remaining), daysLeft: null, rule: cfg.expiry ? 'expired-daily-cap' : 'daily-cap' };
}

/** green | amber | red for today's unpaid spend against the allowance. */
export function levelFor({ allowanceUSD, unpaidUSD = 0, busiestHourUSD = 0 }) {
  if (!(allowanceUSD > 0) || unpaidUSD >= allowanceUSD) return 'red';
  if (unpaidUSD >= AMBER_SHARE * allowanceUSD || busiestHourUSD > BURST_SHARE * allowanceUSD) return 'amber';
  return 'green';
}

// ── who pays, and what a Google call cost ──

/** A paid bucket (accounts/account.js allowAi, edu/budget.js, delegates.js `base|pool|by`): Plus, credits, a course budget. */
export function paidBucket(bucket) {
  const base = String(bucket || '').split('|')[0];
  return base === 'plus' || base === 'credits' || base === 'edu-crs';
}
/**
 * An allowance (allow-ai's or hold-ai's answer) that someone pays for: a paid bucket, an account on Plus (`plan_active`:
 * a subscriber past the month's allowance spends the trial next), or one with bought credits. Daredevil's free
 * allowance (`daredevil`, the apps' proxy) is spent from the "plus" bucket but nobody pays for it.
 */
export const allowPaid = (a) => Boolean(a && !a.daredevil && (a.plan_active === true || paidBucket(a.bucket) || Number(a.credits_usd) > 0));

/** Travel is Plus only unless TRAVEL_PLUS = "0" (accounts/account.js refuses every other trip op first). */
export const travelPlusOnly = (env) => String((env && env.TRAVEL_PLUS) ?? '1') !== '0';
/** Whether a trip account pays: always, while Travel is Plus only; else its plan. Never throws (a failure: unpaid). */
export async function travelPaid(env, account) {
  if (travelPlusOnly(env)) return true;
  try {
    return Boolean(account && typeof account.planNow === 'function' && (await account.planNow()).active);
  } catch (error) {
    failed('travel-paid', error);
    return false;
  }
}

const GOOGLE_PROVIDERS = new Set(['gemini', 'google', 'vertex']);
const GOOGLE_MODEL = /^(?:models\/)?(?:gemini|gemma|imagen|veo|text-embedding|learnlm)\b/i;
/** A call on Google's AI: the provider says so, or (no provider given) the model's name does. */
export function isGoogle(provider, model) {
  if (provider) return GOOGLE_PROVIDERS.has(String(provider).toLowerCase());
  return GOOGLE_MODEL.test(String(model || ''));
}

/**
 * One Google call's cost on its own date. With token counts (inputTokens incl. cachedInputTokens, outputTokens,
 * reasoningTokens, webSearches) and dated prices: priced here. Without counts: the path's own `usd` (priced at the
 * billing registry's price), scaled by the dated price over the registry's: doubled after a rise the registry hasn't
 * got yet, as it was once it has. Other models: the path's `usd`.
 */
export function googleCostUSD({ model, usage = null, usd = 0, at = Date.now(), pricedAt = null } = {}) {
  const given = num0(usd);
  const row = priceOn(model, pacificDay(at));
  if (!row) return round6(given);
  const u = usage || {};
  if (num0(u.inputTokens) || num0(u.outputTokens) || num0(u.reasoningTokens)) {
    const input = num0(u.inputTokens);
    const cached = Math.min(input, num0(u.cachedInputTokens));
    const out = num0(u.outputTokens) + num0(u.reasoningTokens);
    return round6(((input - cached) * row.input + cached * row.input * row.cached + out * row.output) / 1e6 + num0(u.webSearches) * GROUNDING_QUERY_USD);
  }
  const id = String(model).replace(/^models\//, '');
  // the price the path's dollars were priced at on this call's day: with dated charging (dated-prices.js, the default) the
  // dated price itself, so nothing is scaled twice; DATED_PRICES=off: the registry's one price, scaled up after a rise
  const base = num0(pricedAt) || chargePriceOn(id, at) || DATED_PRICES[id][0].input; // pricedAt: tests
  return round6(given * (row.input / base));
}

/** An Anthropic-shaped usage (service-ai.js stand-in answers: Help, Ask, tasks, OCR) as googleCostUSD's counts. */
export function anthropicUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const cached = num0(u.cache_read_input_tokens);
  return { inputTokens: num0(u.input_tokens) + cached, cachedInputTokens: cached, outputTokens: num0(u.output_tokens) };
}

// ── the counter (the Durable Object's side: worker.js VoiceQuota hands it https://credit-pacer/...) ──

// unpaidHours: unpaid by Pacific hour (the level's runaway hour); hours: all of it by hour (the runaway flag);
// external: day totals put here from elsewhere (POST /external, by source), counted against the balance only
const emptyDay = () => ({ paid: 0, unpaid: 0, calls: 0, unpaidHours: {}, hours: {}, external: {}, by: {} });
const externalOf = (rec) => Object.values((rec && rec.external) || {}).reduce((s, v) => s + num0(v), 0);

// What was spent since the balance date, before today: past days never change (a late add to one forgets it), so it
// is listed once a day per counter object, not on every add.
const before = new WeakMap(); // storage → { since, today, usd }
async function spentBefore(storage, since, today) {
  if (!since || since >= today) return 0;
  const hit = before.get(storage);
  if (hit && hit.since === since && hit.today === today) return hit.usd;
  let usd = 0;
  const rows = await storage.list({ prefix: 'd:', start: `d:${since}`, end: `d:${today}` });
  for (const v of rows.values()) usd += num0(v && v.paid) + num0(v && v.unpaid) + externalOf(v);
  usd = round6(usd);
  before.set(storage, { since, today, usd });
  return usd;
}
const changedDay = (storage, day) => {
  const hit = before.get(storage);
  if (hit && day < hit.today) before.delete(storage);
};

// One request at a time per object: a Durable Object's input gates already keep a read and its write together; this
// keeps them together with any storage (and in the tests' fakes).
const queues = new WeakMap();

/**
 * The counter object's requests: POST /add { day, hour, usd, paid, feature, since? }, POST /status { today, since } and
 * POST /external { day, source, usd, since? } (a day's total spent elsewhere, e.g. Eden Code's; sent again it replaces
 * the last one). Each answers { ok, today, record: { paid, unpaid, calls, unpaidHours, hours, external, by }, spentBeforeUSD }.
 */
export function creditCounterFetch(storage, request) {
  const run = (queues.get(storage) || Promise.resolve()).then(() => counterRequest(storage, request));
  queues.set(storage, run.catch(() => {}));
  return run;
}

async function counterRequest(storage, request) {
  const { pathname } = new URL(request.url);
  const body = await request.json().catch(() => ({}));
  const bad = (why) => Response.json({ ok: false, error: why }, { status: 400 });
  if (request.method !== 'POST') return Response.json({ ok: false, error: 'POST only' }, { status: 405 });
  if (pathname === '/add') {
    const day = validDay(body.day);
    const hour = Number(body.hour);
    const usd = Number(body.usd);
    if (!day || !Number.isInteger(hour) || hour < 0 || hour > 23) return bad('day and hour');
    if (!Number.isFinite(usd) || usd <= 0 || usd > 10_000) return bad('usd');
    const key = `d:${day}`;
    const rec = { ...emptyDay(), ...((await storage.get(key)) || {}) };
    const side = body.paid === true ? 'paid' : 'unpaid';
    rec[side] = round6(num0(rec[side]) + usd);
    rec.calls = (Number(rec.calls) || 0) + 1;
    if (side === 'unpaid') rec.unpaidHours = { ...rec.unpaidHours, [hour]: round6(num0(rec.unpaidHours && rec.unpaidHours[hour]) + usd) };
    rec.hours = { ...rec.hours, [hour]: round6(num0(rec.hours && rec.hours[hour]) + usd) };
    const feature = FEATURE.test(String(body.feature || '')) ? String(body.feature) : 'other';
    rec.by = { ...rec.by, [`${side}:${feature}`]: round6(num0(rec.by && rec.by[`${side}:${feature}`]) + usd) };
    await storage.put(key, rec);
    changedDay(storage, day);
    return Response.json({ ok: true, today: day, record: rec, spentBeforeUSD: await spentBefore(storage, validDay(body.since), day) });
  }
  if (pathname === '/external') {
    const day = validDay(body.day);
    const usd = Number(body.usd);
    const source = String(body.source || '');
    if (!day) return bad('day');
    if (!FEATURE.test(source)) return bad('source');
    if (!Number.isFinite(usd) || usd < 0 || usd > 100_000) return bad('usd');
    const key = `d:${day}`;
    const rec = { ...emptyDay(), ...((await storage.get(key)) || {}) };
    rec.external = { ...rec.external, [source]: round6(usd) };
    await storage.put(key, rec);
    changedDay(storage, day);
    return Response.json({ ok: true, today: day, record: rec, spentBeforeUSD: await spentBefore(storage, validDay(body.since), day) });
  }
  if (pathname === '/status') {
    const today = validDay(body.today);
    if (!today) return bad('today');
    const rec = { ...emptyDay(), ...((await storage.get(`d:${today}`)) || {}) };
    return Response.json({ ok: true, today, record: rec, spentBeforeUSD: await spentBefore(storage, validDay(body.since), today) });
  }
  return Response.json({ ok: false, error: 'not found' }, { status: 404 });
}

// ── the Worker's side ──

export const COUNTER_TIMEOUT_MS = 1500; // a slow counter is a failed one: the request goes on (fail open)

async function counter(env, path, body) {
  const ns = env && env.VOICE_QUOTA;
  if (!ns || typeof ns.get !== 'function' || typeof ns.idFromName !== 'function') throw new Error('no counter: the VOICE_QUOTA binding is missing');
  let timer;
  const slow = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the counter took too long')), COUNTER_TIMEOUT_MS); });
  try {
    const ask = (async () => {
      const res = await ns.get(ns.idFromName(COUNTER_OBJECT)).fetch(`${COUNTER_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const out = await res.json().catch(() => null);
      if (!res.ok || !out || !out.ok) throw new Error(`the counter answered ${res.status}${out && out.error ? `: ${out.error}` : ''}`);
      return out;
    })();
    ask.catch(() => {}); // a late failure after the timeout is already handled
    return await Promise.race([ask, slow]);
  } finally {
    clearTimeout(timer);
  }
}

// One Worker copy's last reading: { key, until, value: the counter's answer } or, after a failure, { key, until,
// failed } (so a counter that is down or slow costs one wait per STATUS_TTL_MS, not one per request). `pending`: the
// reading being fetched, shared by every request that needs it meanwhile.
let reading = null;
let pending = null; // { key, promise }
let lastLevel = null;
let lastRunaway = null; // the Pacific day|hour a runaway was last logged
/** Tests: forget the last reading, level and runaway. */
export function resetPacerCache() {
  reading = null;
  pending = null;
  lastLevel = null;
  lastRunaway = null;
}

const busiest = (byHour) => Object.entries(byHour || {}).map(([h, usd]) => [Number(h), num0(usd)]).reduce((best, x) => (x[1] > best[1] ? x : best), [null, 0]);

function statusOf(cfg, out, { today, hour }) {
  const rec = { ...emptyDay(), ...(out.record || {}) };
  const [busiestHour, busiestHourUSD] = busiest(rec.unpaidHours);
  const [busiestTotalHour, busiestTotalHourUSD] = busiest(rec.hours);
  const a = allowanceFor(cfg, { today, spentBeforeUSD: out.spentBeforeUSD });
  const unpaid = round6(num0(rec.unpaid));
  const paid = round6(num0(rec.paid));
  const external = round6(externalOf(rec));
  const total = round6(unpaid + paid + external);
  const level = levelFor({ allowanceUSD: a.allowanceUSD, unpaidUSD: unpaid, busiestHourUSD });
  // a runaway, whoever pays: never refuses anything, only says so (with no allowance left, any spend is one)
  const runaway = a.allowanceUSD > 0 ? total >= RUNAWAY_DAY_FACTOR * a.allowanceUSD || busiestTotalHourUSD >= RUNAWAY_HOUR_SHARE * a.allowanceUSD : total > 0;
  return {
    mode: cfg.mode,
    level,
    today,
    hour,
    ...a,
    unpaidTodayUSD: unpaid,
    paidTodayUSD: paid,
    externalTodayUSD: external,
    totalTodayUSD: total,
    usedShare: a.allowanceUSD > 0 ? round6(unpaid / a.allowanceUSD) : null,
    busiestHour,
    busiestHourUSD: round6(busiestHourUSD),
    burst: busiestHourUSD > BURST_SHARE * a.allowanceUSD,
    busiestTotalHour,
    busiestTotalHourUSD: round6(busiestTotalHourUSD),
    runaway,
    allowedToday: cfg.allowDay === today,
    spentBeforeUSD: round6(num0(out.spentBeforeUSD)),
    calls: Number(rec.calls) || 0,
    byFeature: rec.by || {},
    external: rec.external || {},
    config: configView(cfg),
  };
}

function noteLevel(s) {
  if (s.runaway && lastRunaway !== `${s.today}|${s.hour}`) {
    lastRunaway = `${s.today}|${s.hour}`; // once an hour (per Worker copy) while it lasts
    log('credit_pacer_runaway', { mode: s.mode, day: s.today, hour: s.hour, total_usd: s.totalTodayUSD, paid_usd: s.paidTodayUSD, unpaid_usd: s.unpaidTodayUSD, external_usd: s.externalTodayUSD, busiest_hour_usd: s.busiestTotalHourUSD, allowance_usd: s.allowanceUSD });
  }
  if (s.level === lastLevel) return;
  const was = lastLevel;
  lastLevel = s.level;
  if (was === null && s.level === 'green') return; // a fresh Worker copy: only a change is news
  log('credit_pacer_level', { mode: s.mode, level: s.level, was, unpaid_usd: s.unpaidTodayUSD, paid_usd: s.paidTodayUSD, allowance_usd: s.allowanceUSD, busiest_hour_usd: s.busiestHourUSD, day: s.today });
}

const failedStatus = (cfg, today, hour, why) => ({ mode: cfg.mode, level: 'green', today, hour, failed: why, config: configView(cfg) });

/**
 * The pacer's state now (owner's /admin, and the checks below). Off: the settings only, no request. A counter that
 * fails: green with `failed` (logged once, and kept for STATUS_TTL_MS so the next requests don't wait on it again),
 * never a throw. `fresh` (the owner's /admin) always asks the counter.
 */
export async function pacerStatus(env = {}, { now = Date.now(), fresh = false } = {}) {
  const cfg = pacerConfig(env);
  const { day: today, hour } = pacificParts(now);
  if (cfg.mode === 'off') {
    return { mode: 'off', level: 'off', today, hour, ...allowanceFor(cfg, { today }), allowedToday: cfg.allowDay === today, config: configView(cfg) };
  }
  try {
    const key = `${today}|${cfg.balanceDate}`;
    if (fresh || !reading || reading.key !== key || !(reading.until > now)) {
      let job = !fresh && pending && pending.key === key ? pending : null; // a reading already on its way: shared
      if (!job) {
        const promise = counter(env, '/status', { today, since: cfg.balanceDate }).then(
          (value) => ({ key, until: now + STATUS_TTL_MS, value }),
          (error) => {
            failed('status', error);
            return { key, until: now + STATUS_TTL_MS, failed: String((error && error.message) || error).slice(0, 160) };
          },
        );
        const mine = { key, promise };
        job = mine;
        pending = mine;
        promise.then((r) => {
          if (pending === mine) pending = null;
          reading = r; // before any waiting request goes on (the first `then`)
        });
      }
      const r = await job.promise;
      if (r.failed) return failedStatus(cfg, today, hour, r.failed);
      const s = statusOf(cfg, r.value, { today, hour });
      noteLevel(s);
      return s;
    }
    if (reading.failed) return failedStatus(cfg, today, hour, reading.failed);
    const s = statusOf(cfg, reading.value, { today, hour });
    noteLevel(s);
    return s;
  } catch (error) {
    failed('status', error);
    return failedStatus(cfg, today, hour, String((error && error.message) || error).slice(0, 160));
  }
}

/**
 * Counts one Google AI call (fire and forget: never throws, never awaited by the reply; ctx.waitUntil keeps it alive).
 * `paid`: true/false, else from `bucket` (+ `credits`, an allowance's credits_usd, + `allow`, the allow-ai or hold-ai
 * answer: allowPaid). `usage`: the call's token counts, priced here by its date. Not Google, or CREDIT_PACER off: nothing.
 */
export function meterGoogle(env, ctx, { provider = null, model = null, usd = 0, usage = null, bucket = null, credits = 0, allow = null, paid = null, feature = null, at = Date.now() } = {}) {
  try {
    const mode = pacerMode(env);
    if (mode === 'off') return null;
    // any other provider: the company spend counter (spend-counter.js), never this credit pacing rule
    if (!isGoogle(provider, model)) return meterProvider(env, ctx, { provider, model, usd, usage, bucket, credits, allow, paid, feature, at });
    const cost = googleCostUSD({ model, usage, usd, at });
    if (!(cost > 0)) return null;
    const cfg = pacerConfig(env);
    const { day, hour } = pacificParts(at);
    const isPaid = typeof paid === 'boolean' ? paid : allow && allow.daredevil ? false : paidBucket(bucket) || Number(credits) > 0 || allowPaid(allow);
    const work = counter(env, '/add', { day, hour, usd: cost, paid: isPaid, feature: feature || 'other', since: cfg.balanceDate })
      .then((out) => {
        reading = { key: `${day}|${cfg.balanceDate}`, until: Date.now() + STATUS_TTL_MS, value: out }; // the freshest reading there is
        noteLevel(statusOf(cfg, out, { today: day, hour }));
      })
      .catch((error) => failed('meter', error));
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(work);
    return work;
  } catch (error) {
    failed('meter', error);
    return null;
  }
}

/**
 * Puts a day's total of Google AI spent outside this Worker (e.g. Eden Code on the Mac: `source` "mac") on the counter:
 * counted against the balance on later days and shown on /admin, never against today's free allowance. Sent again for
 * the same day and source, it replaces the last total. Off: nothing. → the counter's answer; throws on a bad request.
 */
export async function recordExternal(env, { day, source, usd } = {}) {
  const cfg = pacerConfig(env);
  if (cfg.mode === 'off') throw new ApiError(409, 'pacer_off', 'The credit pacer is off (CREDIT_PACER), so nothing was recorded.');
  if (!validDay(day)) throw new ApiError(400, 'bad_request', 'day: YYYY-MM-DD.');
  if (!FEATURE.test(String(source || ''))) throw new ApiError(400, 'bad_request', 'source: a short name (a-z, 0-9, - or _).');
  const n = Number(usd);
  if (!Number.isFinite(n) || n < 0 || n > 100_000) throw new ApiError(400, 'bad_request', 'usd: the day’s total in dollars.');
  const out = await counter(env, '/external', { day, source, usd: n, since: cfg.balanceDate });
  reading = null; // the next status reads it
  return out;
}

const GREEN = Object.freeze({ level: 'green', refuse: false, factor: 1, cap: (n) => n, retryAfter: null });
const halve = (n) => (Number.isInteger(n) ? Math.max(1, Math.floor(n / 2)) : n / 2);

/**
 * The pace for one unpaid request: { level, refuse, factor, cap(n), retryAfter }. Green (cap unchanged) unless
 * CREDIT_PACER=on, the request is unpaid and the day is amber (cap halved) or red (refuse). `paid`: a boolean, or an
 * async test asked only when it would matter. CREDIT_ALLOW_DAY today: green. Never throws.
 */
export async function unpaidPace(env = {}, { paid = false, now = Date.now() } = {}) {
  try {
    if (pacerMode(env) !== 'on' || paid === true) return GREEN;
    if (validDay(env && env.CREDIT_ALLOW_DAY) === pacificDay(now)) return GREEN; // the owner's "allow today"
    const s = await pacerStatus(env, { now });
    if (s.failed || (s.level !== 'amber' && s.level !== 'red')) return GREEN;
    if (typeof paid === 'function' && (await paid())) return GREEN;
    if (s.level === 'red') return { level: 'red', refuse: true, factor: 0, cap: () => 0, retryAfter: secondsToPacificMidnight(now) };
    return { level: 'amber', refuse: false, factor: 0.5, cap: halve, retryAfter: null };
  } catch (error) {
    failed('pace', error);
    return GREEN;
  }
}

const eduRefusal = (why) => new ApiError(402, 'edu_allowance_used', why, {}, { edu: true });

/** Help's answer when the day is red: the same shape as Help's own "resting for today". */
export const helpRefusal = (pace) => new ApiError(503, 'help_busy', PACER_COPY.help, { 'retry-after': String((pace && pace.retryAfter) || 3600) });

// An unpaid allowance at amber: the trial's, or the day's free study AI, counts as half its size. Past that half the
// turn is refused; under it the allowance goes on exactly as it was. A turn that starts is never shrunk, so the pacer
// never changes its model (the autopilot, an essay's writer), its checks or its reply room: it only says no.
function halvedAllow(allow) {
  const base = String(allow.bucket || '').split('|')[0];
  const budget = Number(allow.budget);
  if (base === 'edu-free') {
    const todayLeft = Number(allow.today_left);
    if (!(budget > 0) || allow.today_left === undefined || !Number.isFinite(todayLeft)) return allow;
    return todayLeft - budget / 2 < MIN_EDU_TURN_USD ? eduRefusal(PACER_COPY.eduLimited) : allow;
  }
  if (base === 'trial') {
    const own = Number(allow.allowance_left);
    if (!(budget > 0) || allow.allowance_left === undefined || !Number.isFinite(own)) return allow;
    return own - budget / 2 < MIN_TRIAL_TURN_USD ? { ok: false, why: PACER_COPY.limited, pacer: 'amber' } : allow;
  }
  return allow;
}

/**
 * An allow-ai answer, paced (chat, EVES, compare, Edu course turns): paid or not on: as it was. Unpaid at red:
 * { ok: false, why } (the asker's own keys still answer), or for a free study turn a 402 edu_allowance_used.
 * Unpaid at amber: refused the same way once half the trial, or half the day's free study AI, is used; else as it
 * was (never shrunk: no other model, check or reply length). A failure: as it was.
 */
export async function pacerAllow(env, allow, { now = Date.now() } = {}) {
  if (pacerMode(env) !== 'on' || !allow || !allow.ok || allowPaid(allow)) return allow;
  let out = allow;
  try {
    const pace = await unpaidPace(env, { now });
    if (pace.level === 'red') out = String(allow.bucket || '').startsWith('edu-free') ? eduRefusal(PACER_COPY.eduFull) : { ok: false, why: PACER_COPY.full, pacer: 'red' };
    else if (pace.level === 'amber') out = halvedAllow(allow);
  } catch (error) {
    failed('allow', error);
    return allow;
  }
  if (out instanceof ApiError) throw out;
  return out;
}

/**
 * A background run's allowance (a scheduled task, an Auto Draft: in the account's own object), paced like a chat
 * turn's when the run's model is Google's: refused at red, or at amber past half the trial, with words for a run that
 * is skipped and tried again next time. Off or warn, paid, another model, or a failure: the allowance as it was.
 */
export async function pacedBackground(env, allow, model) {
  if (pacerMode(env) !== 'on' || !isGoogle(null, model)) return allow;
  try {
    const out = await pacerAllow(env, allow);
    return out && out.ok === false && out.pacer ? { ...out, why: out.pacer === 'amber' ? PACER_COPY.backgroundLimited : PACER_COPY.background } : out;
  } catch (error) {
    failed('background', error);
    return allow;
  }
}

/**
 * The accounts `call` (or an Edu payer's) with allow-ai and hold-ai paced for unpaid turns; everything else as it
 * was. Off or warn: `call` itself. One per turn (chat.js). A hold refused is released at once: at red, any unpaid
 * hold; at amber, a trial hold past half the trial, when this turn's allow-ai wasn't paced already (a picture or a
 * video holds without asking allow-ai first).
 */
export function pacerCall(env, call) {
  if (pacerMode(env) !== 'on' || typeof call !== 'function') return call;
  let paced = false; // this turn's allow-ai went through pacerAllow already
  return async (e, account, op, body, auth) => {
    const out = await call(e, account, op, body, auth);
    if (op === 'allow-ai') {
      paced = true;
      return pacerAllow(env, out);
    }
    if (op !== 'hold-ai' || !out || !out.ok || allowPaid(out)) return out;
    let refusal = null;
    try {
      const pace = await unpaidPace(env);
      if (pace.level !== 'red' && pace.level !== 'amber') return out;
      const edu = String(out.bucket || '').startsWith('edu-free');
      if (pace.level === 'amber') {
        if (paced || edu || String(out.bucket || '').split('|')[0] !== 'trial') return out;
        const allow = await call(e, account, 'allow-ai', { eden: true }, auth).catch(() => null);
        if (!allow || !allow.ok || allowPaid(allow)) return out;
        // the hold is already off allowance_left: put it back, so this asks what allow-ai would have before the hold
        const before = String(allow.bucket || '').split('|')[0] === 'trial' && allow.allowance_left !== undefined ? { ...allow, allowance_left: Number(allow.allowance_left) + (Number(body && body.usd) || 0) } : allow;
        const halved = halvedAllow(before);
        if (halved === before || halved instanceof ApiError) return out;
        refusal = halved;
      } else {
        // a trial with bought credits, or a Plus account on the trial, is paying: asked only here (never an Edu payer's, whose answer it would change)
        if (!edu && allowPaid(await call(e, account, 'allow-ai', { eden: true }, auth).catch(() => null))) return out;
        refusal = edu ? eduRefusal(PACER_COPY.eduFull) : { ok: false, why: PACER_COPY.full, pacer: 'red' };
      }
      if (out.hold) await call(e, account, 'release-ai', { hold: out.hold }).catch(() => {});
    } catch (error) {
      failed('hold', error);
      return out;
    }
    if (refusal instanceof ApiError) throw refusal;
    return refusal;
  };
}
