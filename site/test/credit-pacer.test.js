// The GCP credit pacer (src/eden/credit-pacer.js, askeden docs/gcp-credit-plan-b.md): the rule (allowance, roll
// forward, levels, a runaway hour), dated Google prices, the day counter on a VoiceQuota object, metering, pacing an
// unpaid allowance, and failing open. The hooks in the request paths: test/credit-pacer-hooks.test.js.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { VoiceQuota } from '../src/worker.js';
import {
  COUNTER_OBJECT,
  COUNTER_TIMEOUT_MS,
  DATED_PRICES,
  PACER_COPY,
  PACER_DEFAULTS,
  STATUS_TTL_MS,
  allowPaid,
  allowanceFor,
  anthropicUsage,
  creditCounterFetch,
  googleCostUSD,
  isGoogle,
  levelFor,
  meterGoogle,
  pacedBackground,
  pacerAllow,
  pacerCall,
  pacerConfig,
  pacerMode,
  pacerStatus,
  pacificDay,
  pacificParts,
  paidBucket,
  priceOn,
  recordExternal,
  resetPacerCache,
  secondsToPacificMidnight,
  travelPaid,
  travelPlusOnly,
  unpaidPace,
} from '../src/eden/credit-pacer.js';
import { Storage } from './fakes.js';
import { namespace } from './fakes.js';
import { configureDatedPrices, datedCharging } from '../src/eden/dated-prices.js';

const ms = (iso) => Date.parse(iso);
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

/** An env with the real VoiceQuota objects (the counter lives in one of them), and a log of the requests they got. */
function envWith(extra = {}) {
  const e = { ...extra };
  const ns = namespace(VoiceQuota, e);
  const seen = [];
  e.VOICE_QUOTA = {
    objects: ns.objects,
    seen,
    idFromName: ns.idFromName,
    get(name) {
      const stub = ns.get(name);
      return { fetch: (input, init) => { seen.push({ name, url: String(input) }); return stub.fetch(input, init); } };
    },
  };
  return e;
}
/** A counter that is down: every request throws. */
const brokenCounter = () => ({ idFromName: (n) => n, get: () => ({ fetch: async () => { throw new Error('counter down'); } }) });
/** Puts `usd` on the counter's day for `at` (unpaid unless `paid`). */
async function add(env, usd, { paid = false, at = Date.now(), feature = 'chat' } = {}) {
  const p = pacificParts(at);
  const stub = env.VOICE_QUOTA.get(env.VOICE_QUOTA.idFromName(COUNTER_OBJECT));
  const r = await stub.fetch('https://credit-pacer/add', { method: 'POST', body: JSON.stringify({ day: p.day, hour: p.hour, usd, paid, feature }) });
  assert.equal(r.status, 200, await r.clone().text());
}

beforeEach(() => resetPacerCache());

// ── settings ──

test('the mode is off unless CREDIT_PACER is warn or on; the defaults are the placeholders until the owner sets them', () => {
  for (const v of [undefined, '', 'off', 'yes', 'true', '1', 'enforce']) assert.equal(pacerMode({ CREDIT_PACER: v }), 'off', String(v));
  assert.equal(pacerMode({ CREDIT_PACER: ' ON ' }), 'on');
  assert.equal(pacerMode({ CREDIT_PACER: 'warn' }), 'warn');
  assert.deepEqual(pacerConfig({}), { mode: 'off', balanceUSD: 16000, balanceDate: '2026-11-09', expiry: null, reserveUSD: 500, unpaidDailyCapUSD: 40, allowDay: null });
  assert.equal(PACER_DEFAULTS.unpaidDailyCapUSD, 40);
  const c = pacerConfig({ CREDIT_BALANCE_USD: '12000.5', CREDIT_BALANCE_DATE: '2026-11-20', CREDIT_EXPIRY: '2027-06-30', CREDIT_RESERVE_USD: '0', CREDIT_UNPAID_DAILY_CAP_USD: '15', CREDIT_ALLOW_DAY: '2026-11-21' });
  assert.deepEqual(c, { mode: 'off', balanceUSD: 12000.5, balanceDate: '2026-11-20', expiry: '2027-06-30', reserveUSD: 0, unpaidDailyCapUSD: 15, allowDay: '2026-11-21' });
  // nonsense falls back, never to NaN
  const bad = pacerConfig({ CREDIT_BALANCE_USD: 'lots', CREDIT_BALANCE_DATE: '2026-02-30', CREDIT_EXPIRY: 'soon', CREDIT_RESERVE_USD: '-5', CREDIT_UNPAID_DAILY_CAP_USD: 'x', CREDIT_ALLOW_DAY: 'today' });
  assert.deepEqual(bad, { mode: 'off', balanceUSD: 16000, balanceDate: '2026-11-09', expiry: null, reserveUSD: 500, unpaidDailyCapUSD: 40, allowDay: null });
});

test('days are Pacific: the day and hour of a UTC instant, and the seconds to the next Pacific midnight', () => {
  assert.deepEqual(pacificParts(ms('2026-11-10T07:59:59Z')).day, '2026-11-09'); // 23:59:59 PST
  assert.deepEqual(pacificParts(ms('2026-11-10T08:00:00Z')), { day: '2026-11-10', hour: 0, minute: 0, second: 0 });
  assert.equal(pacificParts(ms('2026-07-04T19:30:00Z')).hour, 12); // PDT
  assert.equal(secondsToPacificMidnight(ms('2026-11-10T07:00:00Z')), 3600);
  assert.equal(secondsToPacificMidnight(ms('2026-11-10T07:59:30Z')), 60); // at least a minute
});

// ── the rule ──

test('allowance: no expiry is the fixed daily cap (never past what is left); with an expiry, what is left over the days left', () => {
  const cfg = pacerConfig({});
  assert.deepEqual(allowanceFor(cfg, { today: '2026-11-09' }), { allowanceUSD: 40, remainingUSD: 15500, daysLeft: null, rule: 'daily-cap' });
  assert.equal(allowanceFor({ ...cfg, balanceUSD: 520 }, { today: '2026-11-09' }).allowanceUSD, 20); // only $20 above the reserve
  assert.equal(allowanceFor({ ...cfg, balanceUSD: 400 }, { today: '2026-11-09' }).allowanceUSD, 0); // under the reserve: nothing
  const exp = { ...cfg, expiry: '2026-12-09' };
  const a = allowanceFor(exp, { today: '2026-11-09', spentBeforeUSD: 0 });
  assert.equal(a.daysLeft, 30);
  close(a.allowanceUSD, 15500 / 30);
  assert.equal(allowanceFor(exp, { today: '2026-12-09' }).daysLeft, 1); // the last day: at least one
  assert.equal(allowanceFor(exp, { today: '2026-12-09' }).allowanceUSD, 15500);
  // past the expiry what's spent is cash: back to the fixed cap
  assert.deepEqual(allowanceFor(exp, { today: '2026-12-10' }), { allowanceUSD: 40, remainingUSD: 15500, daysLeft: null, rule: 'expired-daily-cap' });
});

test('levels: green under 70%, amber from 70% or one hour over a quarter of the allowance, red at 100%; no allowance is red', () => {
  assert.equal(levelFor({ allowanceUSD: 40, unpaidUSD: 27.99, busiestHourUSD: 9 }), 'green');
  assert.equal(levelFor({ allowanceUSD: 40, unpaidUSD: 28 }), 'amber');
  assert.equal(levelFor({ allowanceUSD: 40, unpaidUSD: 11, busiestHourUSD: 10 }), 'green'); // exactly a quarter is not a runaway
  assert.equal(levelFor({ allowanceUSD: 40, unpaidUSD: 11, busiestHourUSD: 10.01 }), 'amber'); // a runaway hour
  assert.equal(levelFor({ allowanceUSD: 40, unpaidUSD: 40 }), 'red');
  assert.equal(levelFor({ allowanceUSD: 40, unpaidUSD: 55 }), 'red');
  assert.equal(levelFor({ allowanceUSD: 0, unpaidUSD: 0 }), 'red');
});

test('roll forward: a quiet day raises tomorrow\'s allowance, a busy day lowers it (all spend since the balance date counts)', async () => {
  const env = envWith({ CREDIT_PACER: 'warn', CREDIT_BALANCE_USD: '1500', CREDIT_BALANCE_DATE: '2026-11-09', CREDIT_RESERVE_USD: '0', CREDIT_EXPIRY: '2026-11-19' });
  const day1 = ms('2026-11-09T20:00:00Z'); // noon Pacific
  const day2 = ms('2026-11-10T20:00:00Z');
  const s1 = await pacerStatus(env, { now: day1, fresh: true });
  assert.equal(s1.daysLeft, 10);
  close(s1.allowanceUSD, 150);
  // quiet: $50 of the $150 used (paid $20 counts against the balance too, not against the free allowance)
  await add(env, 30, { at: day1 });
  await add(env, 20, { at: day1, paid: true });
  const quiet = await pacerStatus(env, { now: day2, fresh: true });
  assert.equal(quiet.spentBeforeUSD, 50);
  close(quiet.allowanceUSD, (1500 - 50) / 9); // 161.11 > 150: the unused part rolled forward
  assert.ok(quiet.allowanceUSD > s1.allowanceUSD);
  // busy: another $400 on day 2 → day 3 lower than an even split
  await add(env, 400, { at: day2 });
  const day3 = await pacerStatus(env, { now: ms('2026-11-11T20:00:00Z'), fresh: true });
  close(day3.allowanceUSD, (1500 - 450) / 8);
  assert.ok(day3.allowanceUSD < quiet.allowanceUSD);
  // spend before the balance date never counts
  const later = await pacerStatus({ ...env, CREDIT_BALANCE_DATE: '2026-11-11', CREDIT_BALANCE_USD: '1000' }, { now: ms('2026-11-11T20:00:00Z'), fresh: true });
  assert.equal(later.spentBeforeUSD, 0);
});

test('status: today\'s paid and unpaid, the busiest unpaid hour (a runaway makes it amber), and red at the allowance', async () => {
  const env = envWith({ CREDIT_PACER: 'on', CREDIT_UNPAID_DAILY_CAP_USD: '40' });
  const now = Date.now();
  assert.equal((await pacerStatus(env, { now, fresh: true })).level, 'green');
  await add(env, 500, { paid: true }); // paid never makes it amber or red
  let s = await pacerStatus(env, { now, fresh: true });
  assert.equal(s.level, 'green');
  assert.equal(s.paidTodayUSD, 500);
  await add(env, 10.5); // one hour > $10 (a quarter of $40): a runaway
  s = await pacerStatus(env, { now, fresh: true });
  assert.equal(s.level, 'amber');
  assert.equal(s.burst, true);
  assert.equal(s.unpaidTodayUSD, 10.5);
  assert.equal(s.byFeature['unpaid:chat'], 10.5);
  await add(env, 30);
  s = await pacerStatus(env, { now, fresh: true });
  assert.equal(s.level, 'red');
  assert.equal(s.usedShare, round(40.5 / 40));
  // off: no request to the counter at all
  const before = env.VOICE_QUOTA.seen.length;
  const off = await pacerStatus({ ...env, CREDIT_PACER: 'off' }, { fresh: true });
  assert.equal(off.mode, 'off');
  assert.equal(env.VOICE_QUOTA.seen.length, before);
});
const round = (x) => Math.round(x * 1e6) / 1e6;

test('the counter is its own VoiceQuota object: a voice day starting never wipes it, and bad requests are refused', async () => {
  const env = envWith();
  await add(env, 2);
  const voice = env.VOICE_QUOTA.get('daily');
  const r = await voice.fetch('https://quota/take', { method: 'POST', body: JSON.stringify({ install: 'i', network: 'n', chars: 5, limits: { install: 10, network: 10, everyone: 10 } }) });
  assert.equal((await r.json()).ok, true);
  const stub = env.VOICE_QUOTA.get(COUNTER_OBJECT);
  const s = await (await stub.fetch('https://credit-pacer/status', { method: 'POST', body: JSON.stringify({ today: pacificDay() }) })).json();
  assert.equal(s.record.unpaid, 2);
  for (const body of [{ day: 'x', hour: 1, usd: 1 }, { day: '2026-11-09', hour: 24, usd: 1 }, { day: '2026-11-09', hour: 1, usd: -1 }, { day: '2026-11-09', hour: 1, usd: 1e9 }]) {
    const bad = await stub.fetch('https://credit-pacer/add', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(bad.status, 400, JSON.stringify(body));
  }
});

// ── prices by date ──

test('dated prices: Argon doubles from 2026-12-01 and 3.8 Flash from 2027-01-01 (Pacific), each keeping its own cached share', () => {
  assert.deepEqual(priceOn('gemini-4-argon', '2026-11-30'), { from: '2000-01-01', input: 2, output: 10, cached: 0.05 });
  assert.deepEqual(priceOn('gemini-4-argon', '2026-12-01'), { from: '2026-12-01', input: 4, output: 20, cached: 0.05 });
  assert.equal(priceOn('gemini-3.8-flash', '2026-12-31').input, 0.75);
  assert.equal(priceOn('gemini-3.8-flash', '2027-01-01').input, 1.5);
  assert.equal(priceOn('claude-opus-5-5', '2027-01-01'), null);
  const u = { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000, reasoningTokens: 100_000 };
  // Argon, 30 Nov 23:59 Pacific (already 1 Dec in UTC): the old price. 600k × $2 + 400k × $0.10 + 200k × $10
  close(googleCostUSD({ model: 'gemini-4-argon', usage: u, at: ms('2026-12-01T07:59:00Z') }), 1.2 + 0.04 + 2);
  // 1 Dec 00:00 Pacific: $4 / $0.20 cached / $20
  close(googleCostUSD({ model: 'gemini-4-argon', usage: u, at: ms('2026-12-01T08:00:00Z') }), 2.4 + 0.08 + 4);
  // 3.8 Flash: 600k × $0.75 + 400k × $0.075 + 200k × $3.75, then all doubled on 1 Jan 2027 (cached $0.15/M)
  close(googleCostUSD({ model: 'gemini-3.8-flash', usage: u, at: ms('2026-12-31T20:00:00Z') }), 0.45 + 0.03 + 0.75);
  close(googleCostUSD({ model: 'gemini-3.8-flash', usage: u, at: ms('2027-01-01T20:00:00Z') }), 0.9 + 0.06 + 1.5);
  // grounding queries on top
  close(googleCostUSD({ model: 'gemini-4-argon', usage: { inputTokens: 0, outputTokens: 1000, webSearches: 3 }, at: ms('2026-11-15T12:00:00Z') }), 0.01 + 0.042);
  // no token counts: the path's own dollars, already priced on the call's day by dated charging (dated-prices.js)
  assert.equal(googleCostUSD({ model: 'gemini-4-argon', usd: 0.5, at: ms('2026-11-20T12:00:00Z') }), 0.5);
  assert.equal(googleCostUSD({ model: 'gemini-4-argon', usd: 1, at: ms('2026-12-02T12:00:00Z') }), 1);
  assert.equal(googleCostUSD({ model: 'gemini-3.8-flash', usd: 1, at: ms('2027-01-02T12:00:00Z') }), 1);
  // a model without dated prices: as the path counted it
  assert.equal(googleCostUSD({ model: 'imagen-4.0-generate-001', usd: 0.04, at: ms('2027-03-01T12:00:00Z') }), 0.04);
  assert.equal(googleCostUSD({ model: 'gemini-4-argon' }), 0);
  assert.ok(Object.isFrozen(DATED_PRICES));
});

test('who pays, and what is Google', () => {
  for (const b of ['plus', 'credits', 'edu-crs', 'edu-crs|crs:abc', 'plus|dlg:x|by1']) assert.equal(paidBucket(b), true, b);
  for (const b of ['trial', 'edu-free', 'allowance', 'none', '', null, undefined]) assert.equal(paidBucket(b), false, String(b));
  assert.equal(allowPaid({ ok: true, bucket: 'trial', credits_usd: 3 }), true); // bought credits: paying
  assert.equal(allowPaid({ ok: true, bucket: 'trial', credits_usd: 0 }), false);
  assert.equal(isGoogle('gemini', 'imagen-4.0-generate-001'), true);
  assert.equal(isGoogle('openai', 'gemini-4-argon'), false); // the provider decides when it is given
  assert.equal(isGoogle(null, 'gemini-3.8-flash'), true);
  assert.equal(isGoogle(null, 'models/veo-3.0-generate-001'), true);
  assert.equal(isGoogle(null, 'claude-haiku-4-5'), false);
  assert.equal(isGoogle(null, 'gpt-6.1-sol'), false);
  assert.deepEqual(anthropicUsage({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900 }), { inputTokens: 1000, cachedInputTokens: 900, outputTokens: 20 });
});

// ── metering ──

test('metering: off does nothing at all; on or warn, each Google call is counted paid or unpaid, after the reply (waitUntil)', async () => {
  const off = envWith();
  assert.equal(meterGoogle(off, null, { provider: 'gemini', model: 'gemini-3.8-flash', usd: 1, bucket: 'trial' }), null);
  assert.equal(off.VOICE_QUOTA.seen.length, 0);
  const env = envWith({ CREDIT_PACER: 'warn' });
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  meterGoogle(env, ctx, { provider: 'gemini', model: 'gemini-3.8-flash', usd: 0.25, bucket: 'trial', feature: 'chat' });
  meterGoogle(env, ctx, { provider: 'gemini', model: 'gemini-3.8-flash', usd: 0.5, bucket: 'plus', feature: 'chat' });
  meterGoogle(env, ctx, { provider: 'gemini', usd: 0.125, bucket: 'trial', credits: 4, feature: 'memory' }); // credits: paid
  meterGoogle(env, ctx, { provider: 'anthropic', model: 'claude-haiku-4-5', usd: 9, bucket: 'trial' }); // not Google: the spend counter's (spend-counter.js), never the credits'
  meterGoogle(env, ctx, { model: 'gemini-3.8-flash', usage: { inputTokens: 1000, outputTokens: 1000 }, paid: false, feature: 'help' }); // $0.0045
  assert.equal(waits.length, 5);
  await Promise.all(waits);
  const s = await pacerStatus(env, { fresh: true });
  close(s.unpaidTodayUSD, 0.25 + 0.0045);
  close(s.paidTodayUSD, 0.625);
  assert.equal(s.calls, 4);
  close(s.byFeature['unpaid:help'], 0.0045);
  close(s.byFeature['paid:memory'], 0.125);
  close(s.busiestHourUSD, 0.2545); // unpaid only
});

test('fail open: a counter that throws never breaks metering, the status, the pace, an allowance or the call', async () => {
  const env = { CREDIT_PACER: 'on', VOICE_QUOTA: brokenCounter() };
  const logs = [];
  const real = console.log;
  console.log = (line) => logs.push(String(line));
  try {
    const work = meterGoogle(env, null, { provider: 'gemini', usd: 1, bucket: 'trial' });
    await work; // resolves, never rejects
    const s = await pacerStatus(env, { fresh: true });
    assert.equal(s.level, 'green');
    assert.match(s.failed, /counter down/);
    assert.equal((await unpaidPace(env)).refuse, false);
    const allow = { ok: true, bucket: 'trial', left: 0.4, allowance_left: 0.4, budget: 1, credits_usd: 0 };
    assert.equal(await pacerAllow(env, allow), allow);
    const call = pacerCall(env, async (e, a, op) => (op === 'hold-ai' ? { ok: true, bucket: 'trial', hold: 'h1' } : allow));
    assert.equal((await call(env, 'acct', 'allow-ai', {})).ok, true);
    assert.equal((await call(env, 'acct', 'hold-ai', { usd: 0.1 })).hold, 'h1');
    // no binding at all: the same
    assert.equal((await pacerStatus({ CREDIT_PACER: 'on' }, { fresh: true })).level, 'green');
  } finally {
    console.log = real;
  }
  assert.ok(logs.some((l) => l.includes('credit_pacer_fail')));
});

test('fail open: a counter that hangs is given up on quickly, and the request goes on as green', async () => {
  const env = { CREDIT_PACER: 'on', VOICE_QUOTA: { idFromName: (n) => n, get: () => ({ fetch: () => new Promise(() => {}) }) } };
  const real = console.log;
  console.log = () => {};
  try {
    const t0 = Date.now();
    const pace = await unpaidPace(env);
    assert.equal(pace.refuse, false);
    assert.ok(Date.now() - t0 < 3000, `waited ${Date.now() - t0} ms`);
  } finally {
    console.log = real;
  }
});

// ── pacing unpaid use ──

test('pace: paid is never paced; amber halves a cap; red refuses until Pacific midnight; off is green without a request', async () => {
  const red = envWith({ CREDIT_PACER: 'on', CREDIT_BALANCE_USD: '0' }); // nothing left: red
  const p = await unpaidPace(red);
  assert.equal(p.level, 'red');
  assert.equal(p.refuse, true);
  assert.ok(p.retryAfter >= 60 && p.retryAfter <= 86_400);
  assert.equal((await unpaidPace(red, { paid: true })).refuse, false);
  assert.equal((await unpaidPace(red, { paid: async () => true })).refuse, false);
  assert.equal((await unpaidPace({ ...red, CREDIT_PACER: 'warn' })).refuse, false); // warn never refuses
  const offEnv = envWith({ CREDIT_BALANCE_USD: '0' });
  assert.equal((await unpaidPace(offEnv)).level, 'green');
  assert.equal(offEnv.VOICE_QUOTA.seen.length, 0);
  resetPacerCache();
  const amber = envWith({ CREDIT_PACER: 'on', CREDIT_UNPAID_DAILY_CAP_USD: '1' });
  await add(amber, 0.75);
  const a = await unpaidPace(amber);
  assert.equal(a.level, 'amber');
  assert.equal(a.cap(30), 15); // Help's questions
  assert.equal(a.cap(20), 10); // Travel's plans
  assert.equal(a.cap(1), 1);
  assert.equal(a.cap(0.1), 0.05);
});

test('an unpaid allowance: red refuses (Edu with its own 402); amber counts the trial and the free study day as half; paid untouched', async () => {
  const trial = { ok: true, bucket: 'trial', left: 0.8, allowance_left: 0.8, budget: 1, credits_usd: 0 };
  const plus = { ok: true, bucket: 'plus', left: 3, allowance_left: 3, budget: 6, credits_usd: 0 };
  const edu = { ok: true, bucket: 'edu-free', left: 0.024, allowance_left: 0.024, budget: 0.1, today_left: 0.09, credits_usd: 0, source: 'free' };
  const red = envWith({ CREDIT_PACER: 'on', CREDIT_BALANCE_USD: '0' });
  assert.equal(await pacerAllow(red, plus), plus);
  assert.equal(await pacerAllow(red, { ...trial, credits_usd: 2 }).then((a) => a.ok), true);
  assert.deepEqual(await pacerAllow(red, trial), { ok: false, why: PACER_COPY.full, pacer: 'red' });
  await assert.rejects(pacerAllow(red, edu), (e) => e.status === 402 && e.code === 'edu_allowance_used' && e.message === PACER_COPY.eduFull);
  assert.equal(await pacerAllow({ ...red, CREDIT_PACER: 'off' }, trial), trial);
  const notOk = { ok: false, why: 'used up' };
  assert.equal(await pacerAllow(red, notOk), notOk);
  resetPacerCache();
  const amber = envWith({ CREDIT_PACER: 'on', CREDIT_UNPAID_DAILY_CAP_USD: '1' });
  await add(amber, 0.8);
  // $0.80 of the $1 trial left: under half used, so the very same allowance (never shrunk: same model, checks, room)
  assert.equal(await pacerAllow(amber, trial), trial);
  assert.deepEqual(await pacerAllow(amber, { ...trial, left: 0.4, allowance_left: 0.4 }), { ok: false, why: PACER_COPY.limited, pacer: 'amber' });
  assert.equal(await pacerAllow(amber, edu), edu); // $0.09 of today's $0.10 left: under half used
  await assert.rejects(pacerAllow(amber, { ...edu, today_left: 0.051 }), (x) => x.code === 'edu_allowance_used' && x.message === PACER_COPY.eduLimited);
  assert.equal(await pacerAllow(amber, plus), plus);
});

test('the paced call: off is the very same function; on, an unpaid hold at red is released and refused, a paid one kept', async () => {
  const calls = [];
  const base = async (e, account, op, body) => {
    calls.push(op);
    if (op === 'allow-ai') return { ok: true, bucket: account === 'payer' ? 'plus' : 'trial', left: 0.5, allowance_left: 0.5, budget: 1, credits_usd: 0 };
    if (op === 'hold-ai') return { ok: true, bucket: account === 'payer' ? 'plus' : 'trial', hold: 'h-1' };
    return { op, body };
  };
  assert.equal(pacerCall({}, base), base);
  assert.equal(pacerCall({ CREDIT_PACER: 'warn' }, base), base);
  const red = envWith({ CREDIT_PACER: 'on', CREDIT_BALANCE_USD: '0' });
  const call = pacerCall(red, base);
  assert.deepEqual(await call(red, 'free', 'allow-ai', {}), { ok: false, why: PACER_COPY.full, pacer: 'red' });
  calls.length = 0;
  assert.deepEqual(await call(red, 'free', 'hold-ai', { usd: 0.1 }), { ok: false, why: PACER_COPY.full, pacer: 'red' });
  assert.deepEqual(calls, ['hold-ai', 'allow-ai', 'release-ai']); // released at once, not left to lapse
  assert.equal((await call(red, 'payer', 'hold-ai', { usd: 0.1 })).hold, 'h-1');
  assert.equal((await call(red, 'payer', 'allow-ai', {})).ok, true);
  assert.deepEqual(await call(red, 'free', 'spend', { usd: 1 }), { op: 'spend', body: { usd: 1 } }); // other ops untouched
  // an Edu free hold at red: released, then the Edu 402
  const eduCalls = [];
  const eduPayer = async (e, a, op) => { eduCalls.push(op); return op === 'hold-ai' ? { ok: true, bucket: 'edu-free', hold: 'free:1' } : {}; };
  await assert.rejects(pacerCall(red, eduPayer)(red, 'student', 'hold-ai', { usd: 0.01 }), (x) => x.code === 'edu_allowance_used');
  assert.deepEqual(eduCalls, ['hold-ai', 'release-ai']);
});

// ── the review's fixes (2026-11-09) ──

test('a counter that is down costs one wait per reading, not one per request; requests at the same moment share it', async () => {
  let asked = 0;
  const hung = { CREDIT_PACER: 'on', VOICE_QUOTA: { idFromName: (n) => n, get: () => ({ fetch: () => { asked++; return new Promise(() => {}); } }) } };
  const real = console.log;
  const logs = [];
  console.log = (line) => logs.push(String(line));
  try {
    const t0 = Date.now();
    // a free chat turn asks twice (allow-ai, then hold-ai), and other requests arrive meanwhile: one wait, one request
    const paces = await Promise.all([unpaidPace(hung), unpaidPace(hung), pacerAllow(hung, { ok: true, bucket: 'trial', allowance_left: 0.5, budget: 1 })]);
    assert.ok(paces.slice(0, 2).every((p) => p.level === 'green'));
    assert.equal(paces[2].ok, true);
    assert.equal(asked, 1, 'one request to the counter');
    const waited = Date.now() - t0;
    assert.ok(waited >= COUNTER_TIMEOUT_MS - 50 && waited < COUNTER_TIMEOUT_MS * 2, `waited ${waited} ms`);
    // the next requests within STATUS_TTL_MS don't wait again
    const t1 = Date.now();
    assert.equal((await unpaidPace(hung)).refuse, false);
    assert.equal((await pacerStatus(hung)).failed, 'the counter took too long');
    assert.ok(Date.now() - t1 < 100, `waited ${Date.now() - t1} ms`);
    assert.equal(asked, 1);
    assert.equal(logs.filter((l) => l.includes('credit_pacer_fail')).length, 1, 'logged once');
    // a counter that throws: the same (no wait at all), and tried again once the reading is old
    resetPacerCache();
    let thrown = 0;
    const down = { CREDIT_PACER: 'on', VOICE_QUOTA: { idFromName: (n) => n, get: () => ({ fetch: async () => { thrown++; throw new Error('counter down'); } }) } };
    const now = Date.now();
    for (let i = 0; i < 5; i++) assert.equal((await unpaidPace(down, { now })).level, 'green');
    assert.equal(thrown, 1);
    await unpaidPace(down, { now: now + STATUS_TTL_MS + 1 });
    assert.equal(thrown, 2);
  } finally {
    console.log = real;
  }
});

test('the counter lists past days once a day, not on every add, and a late add to a past day is counted', async () => {
  const storage = new Storage();
  let lists = 0;
  const list = storage.list.bind(storage);
  storage.list = (o) => { lists++; return list(o); };
  const post = async (path, body) => (await creditCounterFetch(storage, new Request(`https://credit-pacer${path}`, { method: 'POST', body: JSON.stringify(body) }))).json();
  await post('/add', { day: '2026-11-09', hour: 10, usd: 5, paid: false, since: '2026-11-09' });
  for (let i = 0; i < 3; i++) await post('/add', { day: '2026-11-10', hour: 9, usd: 1, paid: i === 0, since: '2026-11-09' });
  assert.equal(lists, 1, 'listed once for the day');
  const late = await post('/add', { day: '2026-11-09', hour: 23, usd: 2, paid: false, since: '2026-11-09' }); // yesterday's call, counted late
  assert.equal(late.record.unpaid, 7);
  const today = await post('/status', { today: '2026-11-10', since: '2026-11-09' });
  assert.equal(today.spentBeforeUSD, 7, 'the late add is in what was spent before today');
  assert.equal(today.record.hours[9], 3, 'every side by hour (the runaway flag)');
  assert.deepEqual(today.record.unpaidHours, { 9: 2 });
});

test('prices by date stay right once the billing registry gets the new prices (never doubled twice)', () => {
  // charging is dated (the default): a path's dollars after 1 Dec are already at $4, so they are taken as they are
  assert.equal(datedCharging(), true);
  assert.equal(googleCostUSD({ model: 'gemini-4-argon', usd: 1, at: ms('2026-12-02T12:00:00Z') }), 1);
  // DATED_PRICES=off: charging uses the registry's one price ($2), so the counter doubles a path's dollars after 1 Dec
  configureDatedPrices({ DATED_PRICES: 'off' });
  try {
    assert.equal(googleCostUSD({ model: 'gemini-4-argon', usd: 0.5, at: ms('2026-12-02T12:00:00Z') }), 1);
    assert.equal(googleCostUSD({ model: 'gemini-4-argon', usd: 0.5, at: ms('2026-11-20T12:00:00Z') }), 0.5);
  } finally {
    configureDatedPrices({});
  }
  // once the registry (and so the path) prices Argon at $4: as the path counted it after 1 Dec, halved before it
  assert.equal(googleCostUSD({ model: 'gemini-4-argon', usd: 1, pricedAt: 4, at: ms('2026-12-02T12:00:00Z') }), 1);
  assert.equal(googleCostUSD({ model: 'gemini-4-argon', usd: 1, pricedAt: 4, at: ms('2026-11-20T12:00:00Z') }), 0.5);
  assert.equal(googleCostUSD({ model: 'gemini-3.8-flash', usd: 1, pricedAt: 1.5, at: ms('2027-01-02T12:00:00Z') }), 1);
  // with token counts the path's dollars don't matter, and grounding isn't doubled
  close(googleCostUSD({ model: 'gemini-4-argon', usd: 99, usage: { inputTokens: 0, outputTokens: 1000, webSearches: 3 }, at: ms('2026-12-02T12:00:00Z') }), 0.02 + 0.042);
});

test('who pays: a Plus account on the trial pays, Daredevil\'s free allowance doesn\'t, and the meter follows the allowance', async () => {
  assert.equal(allowPaid({ ok: true, bucket: 'trial', credits_usd: 0, plan_active: true }), true); // Plus past the month's allowance
  assert.equal(allowPaid({ ok: false, why: 'used up', plan_active: true }), true);
  assert.equal(allowPaid({ ok: true, bucket: 'plus', daredevil: true }), false);
  assert.equal(allowPaid({ ok: true, bucket: 'plus', credits_usd: 5, daredevil: true }), false);
  const red = envWith({ CREDIT_PACER: 'on', CREDIT_BALANCE_USD: '0' });
  const plusOnTrial = { ok: true, bucket: 'trial', left: 0.2, allowance_left: 0.2, budget: 1, credits_usd: 0, plan_active: true };
  assert.equal(await pacerAllow(red, plusOnTrial), plusOnTrial, 'never refused, never told to get Plus');
  const env = envWith({ CREDIT_PACER: 'warn' });
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  meterGoogle(env, ctx, { model: 'gemini-3.8-flash', usd: 0.25, bucket: 'trial', allow: plusOnTrial, feature: 'chat' });
  meterGoogle(env, ctx, { model: 'gemini-3.8-flash', usd: 0.5, bucket: 'plus', allow: { ok: true, bucket: 'plus', hold: 'h', daredevil: true }, feature: 'app' });
  await Promise.all(waits);
  const s = await pacerStatus(env, { fresh: true });
  close(s.paidTodayUSD, 0.25);
  close(s.unpaidTodayUSD, 0.5);
  close(s.byFeature['unpaid:app'], 0.5);
});

test('amber: a picture\'s hold (no allow-ai first) counts the trial as half too; a turn already paced isn\'t asked again', async () => {
  const amber = envWith({ CREDIT_PACER: 'on', CREDIT_UNPAID_DAILY_CAP_USD: '1' });
  await add(amber, 0.8);
  // `allowanceLeft`: the trial left before the turn; allow-ai answers after any hold (as account.js does)
  const run = (allowanceLeft, extra = {}) => {
    const calls = [];
    let held = 0;
    const base = async (e, a, op, body) => {
      calls.push(op);
      if (op === 'hold-ai') { held = body.usd; return { ok: true, bucket: 'trial', hold: 'h-1', left: allowanceLeft - body.usd, ...extra }; }
      if (op === 'allow-ai') return { ok: true, bucket: 'trial', left: allowanceLeft - held, allowance_left: allowanceLeft - held, budget: 1, credits_usd: 0, ...extra };
      return {};
    };
    return { calls, call: pacerCall(amber, base) };
  };
  // $0.80 of the $1 trial left before the picture: under half used, kept (the hold put back before asking)
  let r = run(0.8);
  assert.equal((await r.call(amber, 'free', 'hold-ai', { usd: 0.35 })).hold, 'h-1');
  assert.deepEqual(r.calls, ['hold-ai', 'allow-ai']);
  // $0.40 left: past half, refused with the amber words and released at once
  r = run(0.4);
  assert.deepEqual(await r.call(amber, 'free', 'hold-ai', { usd: 0.35 }), { ok: false, why: PACER_COPY.limited, pacer: 'amber' });
  assert.deepEqual(r.calls, ['hold-ai', 'allow-ai', 'release-ai']);
  // a Plus account on the trial: its hold says so, nothing asked
  r = run(0.4, { plan_active: true });
  assert.equal((await r.call(amber, 'plus-on-trial', 'hold-ai', { usd: 0.35 })).hold, 'h-1');
  assert.deepEqual(r.calls, ['hold-ai']);
  // a chat turn: allow-ai paced first (it went through), so its hold isn't asked again
  r = run(0.8);
  assert.equal((await r.call(amber, 'free', 'allow-ai', {})).ok, true);
  assert.equal((await r.call(amber, 'free', 'hold-ai', { usd: 0.05 })).hold, 'h-1');
  assert.deepEqual(r.calls, ['allow-ai', 'hold-ai']);
});

test('a runaway is flagged whoever pays (never refusing), and logged once an hour while it lasts', async () => {
  const env = envWith({ CREDIT_PACER: 'on', CREDIT_UNPAID_DAILY_CAP_USD: '40' });
  const logs = [];
  const real = console.log;
  console.log = (line) => logs.push(String(line));
  try {
    const now = Date.now();
    await add(env, 30, { paid: true, at: now });
    let s = await pacerStatus(env, { now, fresh: true });
    assert.equal(s.runaway, false);
    await add(env, 15, { paid: true, at: now }); // $45 in one hour: over the whole $40 allowance
    s = await pacerStatus(env, { now, fresh: true });
    assert.equal(s.runaway, true);
    assert.equal(s.level, 'green', 'paid spend never refuses free use either');
    assert.equal(s.totalTodayUSD, 45);
    assert.equal(s.busiestTotalHourUSD, 45);
    assert.equal((await unpaidPace(env, { now })).refuse, false);
    await pacerStatus(env, { now, fresh: true });
    assert.equal(logs.filter((l) => l.includes('credit_pacer_runaway')).length, 1, 'once this hour');
    // spread over the day: 3× the allowance in all (paid, unpaid, elsewhere) is one too
    const day = envWith({ CREDIT_PACER: 'warn', CREDIT_UNPAID_DAILY_CAP_USD: '10' });
    const p = pacificParts(now);
    const stub = day.VOICE_QUOTA.get(COUNTER_OBJECT);
    for (const [hour, usd] of [[1, 9], [2, 9], [3, 9]]) await stub.fetch('https://credit-pacer/add', { method: 'POST', body: JSON.stringify({ day: p.day, hour, usd, paid: true }) });
    assert.equal((await pacerStatus(day, { now, fresh: true })).runaway, false);
    await recordExternal(day, { day: p.day, source: 'mac', usd: 3 });
    const d = await pacerStatus(day, { now, fresh: true });
    assert.equal(d.runaway, true);
    assert.equal(d.externalTodayUSD, 3);
  } finally {
    console.log = real;
  }
});

test('spend made elsewhere (Eden Code on the Mac): a day total, replaced when sent again, counted against the balance from the next day', async () => {
  const env = envWith({ CREDIT_PACER: 'warn', CREDIT_BALANCE_USD: '1500', CREDIT_BALANCE_DATE: '2026-11-09', CREDIT_RESERVE_USD: '0', CREDIT_EXPIRY: '2026-11-19' });
  const day1 = ms('2026-11-09T20:00:00Z');
  await recordExternal(env, { day: '2026-11-09', source: 'mac', usd: 120 });
  await recordExternal(env, { day: '2026-11-09', source: 'mac', usd: 100 }); // the day's total so far: replaces, never adds
  const s1 = await pacerStatus(env, { now: day1, fresh: true });
  assert.equal(s1.externalTodayUSD, 100);
  assert.equal(s1.level, 'green', 'never against today\'s free allowance');
  assert.deepEqual(s1.external, { mac: 100 });
  const s2 = await pacerStatus(env, { now: ms('2026-11-10T20:00:00Z'), fresh: true });
  assert.equal(s2.spentBeforeUSD, 100);
  close(s2.allowanceUSD, (1500 - 100) / 9);
  await assert.rejects(recordExternal(env, { day: '2026-11-09', source: 'Mac App!', usd: 1 }), (e) => e.status === 400);
  await assert.rejects(recordExternal(env, { day: 'yesterday', source: 'mac', usd: 1 }), (e) => e.status === 400);
  await assert.rejects(recordExternal(env, { day: '2026-11-09', source: 'mac', usd: -1 }), (e) => e.status === 400);
  await assert.rejects(recordExternal(envWith(), { day: '2026-11-09', source: 'mac', usd: 1 }), (e) => e.status === 409); // off
});

test('CREDIT_ALLOW_DAY: the owner\'s "allow today": nothing is refused or halved that Pacific day, still counted', async () => {
  const today = pacificDay();
  const red = envWith({ CREDIT_PACER: 'on', CREDIT_BALANCE_USD: '0', CREDIT_ALLOW_DAY: today });
  assert.equal((await unpaidPace(red)).refuse, false);
  const trial = { ok: true, bucket: 'trial', left: 0.8, allowance_left: 0.8, budget: 1, credits_usd: 0 };
  assert.equal(await pacerAllow(red, trial), trial);
  const s = await pacerStatus(red, { fresh: true });
  assert.equal(s.level, 'red');
  assert.equal(s.allowedToday, true);
  resetPacerCache();
  assert.equal((await unpaidPace({ ...red, CREDIT_ALLOW_DAY: '2026-01-01' })).refuse, true, 'another day: as usual');
});

test('background runs (tasks, Auto Drafts): a free account\'s Google run is skipped at red with words for a run; others as they were', async () => {
  const red = envWith({ CREDIT_PACER: 'on', CREDIT_BALANCE_USD: '0' });
  const trial = { ok: true, bucket: 'trial', left: 0.8, allowance_left: 0.8, budget: 1, credits_usd: 0 };
  assert.deepEqual(await pacedBackground(red, trial, 'gemini-3.8-flash'), { ok: false, why: PACER_COPY.background, pacer: 'red' });
  assert.equal(await pacedBackground(red, trial, 'claude-haiku-4-5'), trial, 'not Google: not paced');
  assert.equal(await pacedBackground(red, { ...trial, bucket: 'plus' }, 'gemini-3.8-flash').then((a) => a.ok), true);
  assert.equal(await pacedBackground({ ...red, CREDIT_PACER: 'warn' }, trial, 'gemini-3.8-flash'), trial);
  resetPacerCache();
  const amber = envWith({ CREDIT_PACER: 'on', CREDIT_UNPAID_DAILY_CAP_USD: '1' });
  await add(amber, 0.8);
  assert.equal(await pacedBackground(amber, trial, 'gemini-3.8-flash'), trial, 'under half the trial used: runs');
  assert.deepEqual(await pacedBackground(amber, { ...trial, allowance_left: 0.4 }, 'gemini-3.8-flash'), { ok: false, why: PACER_COPY.backgroundLimited, pacer: 'amber' });
  const down = { CREDIT_PACER: 'on', VOICE_QUOTA: brokenCounter() };
  const real = console.log;
  console.log = () => {};
  try {
    assert.equal(await pacedBackground(down, trial, 'gemini-3.8-flash'), trial, 'fail open');
  } finally {
    console.log = real;
  }
});

test('Travel pays while it is Plus only (TRAVEL_PLUS, the default); with it off, the account\'s plan says', async () => {
  assert.equal(travelPlusOnly({}), true);
  assert.equal(travelPlusOnly({ TRAVEL_PLUS: '0' }), false);
  assert.equal(await travelPaid({}, { planNow: async () => { throw new Error('never asked'); } }), true);
  assert.equal(await travelPaid({ TRAVEL_PLUS: '0' }, { planNow: async () => ({ active: true }) }), true);
  assert.equal(await travelPaid({ TRAVEL_PLUS: '0' }, { planNow: async () => ({ active: false }) }), false);
  const real = console.log;
  console.log = () => {};
  try {
    assert.equal(await travelPaid({ TRAVEL_PLUS: '0' }, { planNow: async () => { throw new Error('down'); } }), false); // never throws
  } finally {
    console.log = real;
  }
});
