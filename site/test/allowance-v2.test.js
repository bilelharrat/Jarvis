// ALLOWANCE_V2 (accounts/allowance.js): billing-anchored periods, weekly slices, rollover and the
// plan bonus, behind one flag. Off, the included AI is byte-for-byte today's (the golden captured
// from the code before v2: allowance-golden.js). On, the scripted cases of the design.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { call } from '../src/accounts/index.js';
import { parseToken } from '../src/accounts/util.js';
import { addMonthsUTC, allowanceV2, calendarWindow, naturalMonth, sliceAt, weekAt, WEEK_MS } from '../src/accounts/allowance.js';
import { hostedAutopilot, spendWeek } from '../src/eden/chat.js';
import { GOLDEN, SCENARIOS, runScenario } from './allowance-golden.js';
import { Account, namespace } from './fakes.js';

const DAY = 86400_000;
const U = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi); // months 1-based here
const ON = { ALLOWANCE_V2: 'on' };
const TODAY_KEYS = ['period_start', 'period_end', 'spent_usd', 'budget_usd', 'left_usd', 'trial_left_usd', 'trial_usd', 'plus_usd', 'voice_today', 'voice_daily'];
const V2_KEYS = ['allowance', 'period_source', 'week_start', 'week_end', 'week_number', 'weeks_in_period', 'week_slice_usd', 'week_left_usd', 'answer_usd', 'week_answers_left', 'rollover_usd', 'rollover_left_usd', 'bonus_max_pct', 'bonus_usd', 'bonus_left_usd'];
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ''} ${a} ≈ ${b}`);

// ── the pure period math ──

test('addMonthsUTC: clamps to the month, keeps the time of day, never drifts', () => {
  const jan31 = Date.UTC(2027, 0, 31, 10, 11, 12, 13);
  assert.equal(new Date(addMonthsUTC(jan31, 1)).toISOString(), '2027-02-28T10:11:12.013Z');
  assert.equal(new Date(addMonthsUTC(jan31, 2)).toISOString(), '2027-03-31T10:11:12.013Z');
  assert.equal(new Date(addMonthsUTC(jan31, 3)).toISOString(), '2027-04-30T10:11:12.013Z');
  assert.equal(new Date(addMonthsUTC(Date.UTC(2028, 1, 29, 8), 12)).toISOString(), '2029-02-28T08:00:00.000Z');
  assert.equal(new Date(addMonthsUTC(Date.UTC(2028, 1, 29, 8), -12)).toISOString(), '2027-02-28T08:00:00.000Z');
  for (let k = 0; k <= 12; k++) {
    const d = new Date(addMonthsUTC(jan31, k));
    const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    assert.equal(d.getUTCDate(), Math.min(31, dim), `step ${k}`);
    assert.equal(d.getUTCMonth(), (0 + k) % 12);
  }
  assert.equal(new Date(addMonthsUTC(jan31, 12)).toISOString(), '2028-01-31T10:11:12.013Z');
});

test('slices: a monthly window is itself; a yearly one has 12 from its start; an intro week is pro rata', () => {
  const ws = U(2026, 11, 5, 9, 31), we = U(2026, 12, 5, 9, 31);
  for (const now of [ws, ws + 10 * DAY, we - 1]) assert.deepEqual(sliceAt(ws, we, now), { k: 0, n: 1, start: ws, end: we, factor: 1 });
  const ys = U(2027, 1, 31, 10), ye = U(2028, 1, 31, 10);
  const seen = [];
  for (let t = ys; t < ye; t += DAY) {
    const s = sliceAt(ys, ye, t);
    if (!seen.length || seen[seen.length - 1].k !== s.k) seen.push(s);
  }
  assert.equal(seen.length, 12);
  assert.equal(seen[0].start, ys);
  assert.equal(seen[11].end, ye);
  for (let i = 1; i < 12; i++) assert.equal(seen[i].start, seen[i - 1].end, 'contiguous');
  assert.equal(new Date(seen[1].start).toISOString(), '2027-02-28T10:00:00.000Z');
  assert.equal(new Date(seen[2].start).toISOString(), '2027-03-31T10:00:00.000Z', 'counted from the start, not chained');
  for (const s of seen) assert.equal(s.factor, 1);
  const intro = sliceAt(U(2027, 3, 1), U(2027, 3, 8), U(2027, 3, 2));
  near(intro.factor, 7 / 31, 'a 7-day intro');
  const anchor31 = sliceAt(U(2027, 2, 28), U(2027, 3, 31), U(2027, 3, 30));
  assert.equal(anchor31.n, 1, 'a Stripe 31st anchor: one slice');
  assert.equal(anchor31.factor, 1);
  assert.equal(naturalMonth(U(2027, 2, 1)), 28 * DAY);
});

test('weeks: 4×7 days in 28; a 31-day period ends on a 10-day week; DST never moves a boundary', () => {
  const f = U(2027, 2, 1);
  for (let j = 0; j < 4; j++) {
    const w = weekAt(f, f + 28 * DAY, f + j * WEEK_MS + 1);
    assert.deepEqual([w.j, w.W, w.end - w.start], [j, 4, 604800000]);
  }
  const last = weekAt(U(2027, 3, 1), U(2027, 4, 1), U(2027, 3, 30));
  assert.equal(last.W, 4);
  assert.equal(last.end - last.start, 10 * DAY);
  for (const [s, e] of [[U(2026, 10, 25, 14), U(2026, 11, 25, 14)], [U(2027, 3, 10, 6), U(2027, 4, 10, 6)], [U(2027, 3, 20, 23), U(2027, 4, 20, 23)]]) {
    const W = weekAt(s, e, s).W;
    for (let j = 0; j < W; j++) assert.equal(weekAt(s, e, s + j * WEEK_MS).start, s + j * WEEK_MS);
  }
  // the same answers in any process time zone
  const mod = fileURLToPath(new URL('../src/accounts/allowance.js', import.meta.url));
  const script = `import(${JSON.stringify(mod)}).then((m) => { const out = []; for (const [s, e] of [[${U(2026, 10, 25, 14)}, ${U(2026, 11, 25, 14)}], [${U(2027, 3, 10, 6)}, ${U(2027, 4, 10, 6)}], [${U(2027, 3, 20, 23)}, ${U(2027, 4, 20, 23)}], [${U(2027, 1, 31, 10)}, ${U(2028, 1, 31, 10)}]]) for (let t = s; t < e; t += 86400000 / 3) out.push([m.sliceAt(s, e, t), m.weekAt(s, e, t), m.addMonthsUTC(t, 1), m.calendarWindow(t)]); process.stdout.write(JSON.stringify(out)); });`;
  const run = (TZ) => execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ }, encoding: 'utf8' });
  const utc = run('UTC');
  assert.ok(utc.length > 1000);
  assert.equal(run('America/New_York'), utc);
  assert.equal(run('Asia/Kolkata'), utc);
});

test('the calendar fallback is v1’s month for every month of 2026-2028', () => {
  const v1Start = (key) => Date.parse(`${key}-01T00:00:00Z`);
  const v1Next = (key) => { const [y, m] = key.split('-').map(Number); return Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1); };
  for (let y = 2026; y <= 2028; y++) for (let m = 1; m <= 12; m++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    for (const t of [v1Start(key), v1Start(key) + 14 * DAY + 3, v1Next(key) - 1]) {
      assert.deepEqual(calendarWindow(t), { ws: v1Start(key), we: v1Next(key) }, key);
      assert.equal(sliceAt(v1Start(key), v1Next(key), t).factor, 1);
    }
  }
});

test('the flag: ALLOWANCE_V2 = "on" only (PLAN_BONUS_PCT is gone: the bonus is the pool’s, bonus-pool.test.js)', () => {
  assert.equal(allowanceV2({ ALLOWANCE_V2: ' On ' }), true);
  for (const v of [undefined, '', 'off', 'yes', '1', 'true']) assert.equal(allowanceV2({ ALLOWANCE_V2: v }), false);
});

// ── flag off: today's behaviour exactly ──

test('flag off (unset, "off", "yes"): every kind of account answers as the golden from today’s code, and allow2 is never written', async () => {
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  let n = 1;
  for (const name of Object.keys(SCENARIOS)) {
    for (const flag of [{}, { ALLOWANCE_V2: 'off' }, { ALLOWANCE_V2: 'yes' }]) {
      const run = await runScenario(name, flag, n++);
      assert.deepEqual(JSON.parse(JSON.stringify(run.steps)), golden[name], `${name} ${JSON.stringify(flag)}`);
      assert.equal(run.allow2, false, `${name}: no allow2 key`);
    }
  }
});

test('flag off: applyTransaction and the Stripe event store nothing new', async () => {
  for (const flag of [{}, ON]) {
    const a = await account({ env: flag, t: U(2026, 11, 12) });
    await a.obj.applyTransaction({ appAccountToken: a.id, productId: 'com.askeden.eden.plus.monthly', transactionId: '9', originalTransactionId: '9000', expiresDate: U(2026, 12, 12), purchaseDate: U(2026, 11, 12), environment: 'Production', signedDate: U(2026, 11, 12) });
    const plan = await a.obj.storage.get('plan');
    assert.equal('purchase_date' in plan, Boolean(flag.ALLOWANCE_V2), 'purchase_date only with the flag');
    if (flag.ALLOWANCE_V2) assert.equal(plan.purchase_date, U(2026, 11, 12));
  }
  const a = await account({ t: U(2026, 11, 12) });
  const sub = { id: 'sub_9', status: 'active', customer: 'cus_9', price: 'price_x1234', period_end: U(2026, 12, 12), renews: true, plus: true };
  await call(a.env, a.id, 'stripe-event', { id: 'evt_a1', type: 'customer.subscription.created', created: 1, livemode: false, subscription: sub });
  assert.equal('period_start' in (await a.obj.storage.get('stripe_plan')), false);
  await call(a.env, a.id, 'stripe-event', { id: 'evt_a2', type: 'customer.subscription.updated', created: 2, livemode: false, subscription: { ...sub, period_start: U(2026, 11, 12), billing_anchor: U(2026, 11, 12) } });
  const sp = await a.obj.storage.get('stripe_plan');
  assert.equal(sp.period_start, U(2026, 11, 12));
  assert.equal(sp.billing_anchor, U(2026, 11, 12));
});

// ── flag on ──

let nextId = 100;
const stripe = (ps, pe, extra = {}) => ({ customer: 'cus_1', subscription: 'sub_1', status: 'active', price: 'price_1PlusMonthlyTest', period_start: ps, period_end: pe, renews: true, livemode: false, ...extra });

/** An account on the fake clock: helpers through the Worker's call(), as an iPhone (no web sign-in expiry). */
async function account({ store = {}, env = ON, t }) {
  const id = `${String(nextId++).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const e = { TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '6', ...env };
  e.ACCOUNTS = namespace(Account, e);
  e.ACCOUNTS.get(id);
  const obj = e.ACCOUNTS.objects.get(id);
  const clock = { t };
  obj.now = () => clock.t;
  await obj.storage.put('account', { id, created: t - 60 * DAY, origin: 'apple' });
  for (const [k, v] of Object.entries(store)) await obj.storage.put(k, v);
  const auth = parseToken((await obj.makeDevice(id, { name: 'iPhone', kind: 'iphone' })).token);
  const safe = (p) => p.catch((err) => ({ error: err.status, code: err.code, message: err.message }));
  return {
    env: e, obj, id, clock, auth,
    at: (when) => { clock.t = when; },
    put: (k, v) => obj.storage.put(k, v),
    allow: () => call(e, id, 'allow-ai', { eden: true }, auth),
    hold: (usd) => safe(call(e, id, 'hold-ai', { eden: true, usd }, auth)),
    proxy: (usd) => safe(call(e, id, 'hold-proxy', { usd }, auth)),
    spend: (usd, bucket = 'plus') => call(e, id, 'spend', { usd, bucket }),
    get: async () => (await call(e, id, 'get', {}, auth)).usage,
    rec: () => obj.storage.get('allow2'),
  };
}

const feb = () => stripe(U(2027, 2, 1), U(2027, 3, 1)); // a 28-day period: 4 weeks of $1.50

test('weekly slice: $6 over 28 days is $1.50 a week; used up → the trial → the weekly refusal; next week $1.50', async () => {
  const a = await account({ store: { stripe_plan: feb() }, t: U(2027, 2, 2) });
  let allow = await a.allow();
  assert.equal(allow.bucket, 'plus');
  assert.equal(allow.allowance_left, 1.5);
  assert.equal(allow.week_end, U(2027, 2, 8));
  assert.equal(allow.period_start, U(2027, 2, 1));
  assert.equal(allow.budget, 6);
  await a.spend(1.5);
  allow = await a.allow();
  assert.equal(allow.bucket, 'trial');
  await a.spend(1, 'trial');
  allow = await a.allow();
  assert.equal(allow.ok, false);
  assert.equal(allow.why, "This week's Plus AI allowance is used up. More arrives Feb 8, or add credits in Settings › Account.");
  assert.equal(allow.week_end, U(2027, 2, 8));
  assert.equal(allow.period_end, U(2027, 3, 1));
  a.at(U(2027, 2, 9));
  allow = await a.allow();
  assert.equal(allow.bucket, 'plus');
  assert.equal(allow.allowance_left, 1.5);
});

test('weekly carry: unused weeks add up; week 4 untouched is the whole $6; 0.50 in week 1 leaves 2.50 in week 2', async () => {
  const a = await account({ store: { stripe_plan: feb() }, t: U(2027, 2, 23) });
  assert.equal((await a.allow()).allowance_left, 6);
  const b = await account({ store: { stripe_plan: feb() }, t: U(2027, 2, 2) });
  await b.spend(0.5);
  b.at(U(2027, 2, 9));
  assert.equal((await b.allow()).allowance_left, 2.5);
});

test('weekly overspend: $2 in week 1 (no credits) leaves $1 in week 2, and the period never passes $6', async () => {
  const a = await account({ store: { stripe_plan: feb() }, t: U(2027, 2, 2) });
  await a.spend(2);
  let total = 2;
  for (const [day, want] of [[9, 1], [16, 1.5], [23, 1.5]]) {
    a.at(U(2027, 2, day));
    const allow = await a.allow();
    assert.equal(allow.allowance_left, want, `Feb ${day}`);
    await a.spend(allow.allowance_left);
    total += allow.allowance_left;
  }
  assert.equal(total, 6);
  assert.notEqual((await a.allow()).bucket, 'plus');
  const u = await a.get();
  assert.equal(u.left_usd, 0);
  assert.equal(u.spent_usd, 6);
});

test('credits at the week’s limit: 1.50 from the allowance, the rest at the markup; usage dual-written; top-up as today', async () => {
  const lot = { id: 'lot_1', usd: 5, left: 5, at: U(2027, 1, 20), expires: U(2027, 12, 1), source: 'stripe' };
  const a = await account({ store: { stripe_plan: feb(), credits: { customer: null, payment_method: null, lots: [lot] } }, t: U(2027, 2, 2) });
  let topups = 0;
  a.obj.topUpSoon = async () => { topups++; };
  const out = await a.spend(2);
  near(out.charged_usd, 1.5 + 0.5 * 1.25);
  assert.equal((await a.obj.storage.get('credits')).lots[0].left, 5 - 0.625);
  assert.equal((await a.obj.storage.get('usage')).spent, 1.5);
  assert.equal((await a.rec()).spent, 1.5);
  assert.equal(topups, 1);
});

test('holds: can’t stack past the week; the proxy holds what’s left, then 429', async () => {
  const a = await account({ store: { stripe_plan: feb() }, t: U(2027, 2, 2) });
  assert.equal((await a.hold(1)).ok, true);
  const second = await a.hold(1);
  assert.equal(second.ok, false, 'only 0.50 of the week is left');
  assert.equal((await a.proxy(2)).ok, true, 'held min(2, 0.50)');
  const third = await a.proxy(0.1);
  assert.equal(third.error, 429);
});

test('the leak: subscribed Nov 30, nothing new on Dec 1; the next period on Dec 30, nothing rolled when all was spent', async () => {
  const sp = stripe(U(2026, 11, 30, 10), U(2026, 12, 30, 10));
  const v1 = await account({ store: { stripe_plan: sp }, env: {}, t: U(2026, 11, 30, 11) });
  await v1.spend(1.5);
  v1.at(U(2026, 12, 1, 1));
  assert.equal((await v1.allow()).allowance_left, 6, 'v1: a second allowance on the 1st (the leak)');
  const a = await account({ store: { stripe_plan: sp }, t: U(2026, 11, 30, 11) });
  await a.spend(1.5);
  a.at(U(2026, 12, 1, 1));
  const allow = await a.allow();
  assert.notEqual(allow.bucket, 'plus', 'week 1 is used up, December or not');
  let u = await a.get();
  assert.equal(u.period_start, U(2026, 11, 30, 10));
  assert.equal(u.left_usd, 4.5);
  for (const d of [7, 14, 21]) {
    a.at(U(2026, 12, d, 11));
    await a.spend(1.5);
  }
  assert.equal((await a.get()).left_usd, 0);
  await a.put('stripe_plan', stripe(U(2026, 12, 30, 10), U(2027, 1, 30, 10)));
  a.at(U(2026, 12, 30, 11));
  u = await a.get();
  assert.equal(u.period_start, U(2026, 12, 30, 10));
  assert.equal(u.rollover_usd, 0);
  assert.equal(u.week_left_usd, 1.5);
  assert.equal(u.budget_usd, 6);
});

test('anchors: App Store from its expiry (monthly, yearly, with a purchase date), Play from its expiry, promo and Rewards on the calendar', async () => {
  const t = U(2026, 11, 12, 10);
  const apple = (extra) => ({ plan: { product_id: 'com.askeden.eden.plus.monthly', transaction_id: '1', original_transaction_id: 'o1', expires: U(2026, 12, 7, 10), revoked: false, environment: 'Production', ...extra } });
  let u = await (await account({ store: apple(), t })).get();
  assert.deepEqual([u.period_source, u.period_start, u.period_end], ['app_store', U(2026, 11, 7, 10), U(2026, 12, 7, 10)]);
  u = await (await account({ store: apple({ purchase_date: U(2026, 11, 12), expires: U(2026, 11, 19, 10) }), t })).get();
  assert.deepEqual([u.period_start, u.period_end], [U(2026, 11, 12), U(2026, 11, 19, 10)], 'the purchase date when it is later (an intro week)');
  near(u.plus_usd, 6 * ((U(2026, 11, 19, 10) - U(2026, 11, 12)) / (30 * DAY)), 'a short first period is pro rata');
  u = await (await account({ store: apple({ product_id: 'com.askeden.eden.plus.yearly', expires: U(2027, 3, 15) }), t: U(2026, 11, 16) })).get();
  assert.deepEqual([u.period_start, u.period_end, u.plus_usd], [U(2026, 11, 15), U(2026, 12, 15), 6], 'a yearly plan: its monthly slice');
  u = await (await account({ store: apple({ product_id: 'com.askeden.eden.plus.yearly', expires: U(2027, 3, 15) }), t })).get();
  assert.deepEqual([u.period_source, u.period_start, u.period_end], ['calendar', U(2026, 11, 1), U(2026, 12, 1)], 'first seen mid-slice (subscribed before this month): today’s month first');
  const play = { token: 'tok-9', product_id: 'com.askeden.eden.plus.monthly', base_plan: 'monthly', state: 'SUBSCRIPTION_STATE_ACTIVE', expires: U(2026, 12, 3), renews: true, test: false, fetched: t };
  u = await (await account({ store: { play_plan: play }, t })).get();
  assert.deepEqual([u.period_source, u.period_start, u.period_end], ['google_play', U(2026, 11, 3), U(2026, 12, 3)]);
  u = await (await account({ store: { play_plan: { ...play, product_id: 'com.askeden.eden.plus.yearly', expires: U(2027, 6, 3) } }, t })).get();
  assert.deepEqual([u.period_start, u.period_end], [U(2026, 11, 3), U(2026, 12, 3)]);
  for (const store of [{ promo_plan: { until: t + 40 * DAY, codes: [] } }, { plus_bonus_until: { until: t + 30 * DAY, banked_ms: 0 } }]) {
    u = await (await account({ store, t })).get();
    assert.deepEqual([u.period_source, u.period_start, u.period_end], ['calendar', U(2026, 11, 1), U(2026, 12, 1)]);
  }
});

test('rollover: unused moves on once, spent first, expires with the next period, capped at the plan’s month (never the bonus)', async () => {
  const a = await account({ store: { stripe_plan: feb() }, t: U(2027, 2, 2) });
  await a.spend(2);
  await a.put('stripe_plan', stripe(U(2027, 3, 1), U(2027, 4, 1)));
  a.at(U(2027, 3, 2));
  let u = await a.get();
  assert.equal(u.budget_usd, 10);
  assert.equal(u.rollover_usd, 4);
  assert.equal(u.rollover_left_usd, 4);
  assert.equal(u.rollover_expires, U(2027, 4, 1));
  assert.equal(u.week_left_usd, 5.5, 'the rollover isn’t sliced');
  await a.spend(1);
  u = await a.get();
  assert.equal(u.rollover_left_usd, 3);
  assert.equal((await a.rec()).spent, 0, 'the period’s own untouched');
  await a.put('stripe_plan', stripe(U(2027, 4, 1), U(2027, 5, 1)));
  a.at(U(2027, 4, 2));
  u = await a.get();
  assert.equal(u.rollover_usd, 6, 'March’s own $6, not March’s leftover rollover too');
  assert.equal(u.budget_usd, 12);

  const legacy = await account({ env: { ...ON, STRIPE_PRICE_PLUS_LEGACY: 'price_legacyABCD' }, store: { stripe_plan: { ...feb(), price: 'price_legacyABCD' } }, t: U(2027, 2, 2) });
  assert.equal((await legacy.get()).plus_usd, 20);
  await legacy.put('stripe_plan', { ...stripe(U(2027, 3, 1), U(2027, 4, 1)), price: 'price_legacyABCD' });
  legacy.at(U(2027, 3, 2));
  assert.equal((await legacy.get()).rollover_usd, 20);

  const bonus = await account({ env: { ...ON, PLAN_BONUS_PCT: '{"plus":20}' }, store: { stripe_plan: feb() }, t: U(2027, 2, 2) });
  let b = await bonus.get();
  assert.deepEqual([b.bonus_max_pct, b.bonus_usd, b.bonus_left_usd, b.plus_usd], [0, 0, 0, 6], 'PLAN_BONUS_PCT is ignored');
  assert.equal('bonus_pct' in b, false);
  await bonus.put('stripe_plan', stripe(U(2027, 3, 1), U(2027, 4, 1)));
  bonus.at(U(2027, 3, 2));
  b = await bonus.get();
  assert.equal(b.rollover_usd, 6);
  assert.equal(b.budget_usd, 12);

  const yearly = await account({ store: { stripe_plan: stripe(U(2027, 1, 1), U(2028, 1, 1)) }, t: U(2027, 1, 2) });
  await yearly.spend(1);
  yearly.at(U(2027, 2, 2));
  u = await yearly.get();
  assert.deepEqual([u.period_start, u.period_end, u.rollover_usd, u.budget_usd], [U(2027, 2, 1), U(2027, 3, 1), 5, 11], 'slice to slice');
});

test('no rollover for promo or a Rewards month; nothing written for sandbox, a Play tester, unlimited, the trial, credits or Daredevil', async () => {
  for (const store of [{ promo_plan: { until: U(2027, 3, 1), codes: [] } }, { plus_bonus_until: { until: U(2027, 3, 1), banked_ms: 0 } }]) {
    const a = await account({ store, t: U(2026, 11, 12) });
    await a.spend(1);
    a.at(U(2026, 12, 2));
    const u = await a.get();
    assert.equal(u.rollover_usd, 0);
    assert.equal(u.plus_usd, 6);
  }
  const t = U(2026, 11, 12);
  const kinds = {
    sandbox: { plan: { product_id: 'com.askeden.eden.plus.monthly', original_transaction_id: 's', expires: t + 20 * DAY, revoked: false, environment: 'Sandbox' } },
    play_test: { play_plan: { token: 'tok-t', product_id: 'com.askeden.eden.plus.monthly', state: 'SUBSCRIPTION_STATE_ACTIVE', expires: t + 20 * DAY, renews: true, test: true } },
    unlimited: { identities: [{ provider: 'google', sub_hash: 'h', email: 'fam@example.com', added: t }] },
    trial: {},
    credits: { credits: { customer: null, payment_method: null, lots: [{ id: 'l', usd: 5, left: 5, at: t, expires: t + 300 * DAY, source: 'stripe' }] } },
    daredevil: { daredevil: true },
  };
  for (const [name, store] of Object.entries(kinds)) {
    const a = await account({ env: { ...ON, UNLIMITED_EMAILS: 'fam@example.com' }, store, t });
    const allow = await a.allow();
    await a.spend(0.3, allow.bucket || 'trial');
    await a.proxy(0.1);
    a.at(t + 25 * DAY);
    const u = await a.get();
    assert.equal(await a.rec(), undefined, `${name}: no allow2`);
    assert.deepEqual(Object.keys(u), [...TODAY_KEYS, 'allowance'], name);
    assert.equal(allow.week_left, undefined);
  }
});

test('the end: renews off → expiry → a later resubscribe is fresh; an App Store revoke forfeits; past_due inside its grace keeps all', async () => {
  const a = await account({ store: { stripe_plan: { ...feb(), renews: false } }, t: U(2027, 2, 2) });
  await a.spend(1);
  a.at(U(2027, 3, 2));
  assert.deepEqual(Object.keys(await a.get()), [...TODAY_KEYS, 'allowance']);
  assert.equal((await a.rec()).ended, U(2027, 3, 2));
  await a.put('stripe_plan', stripe(U(2027, 3, 20), U(2027, 4, 20), { subscription: 'sub_2' }));
  a.at(U(2027, 3, 20, 1));
  let u = await a.get();
  assert.deepEqual([u.period_start, u.rollover_usd, u.left_usd], [U(2027, 3, 20), 0, 6]);

  // App Store: a renewal read late (a lapse at the boundary, still renewing: a billing retry) keeps the rollover; a revoke then forfeits it
  const apple = { product_id: 'com.askeden.eden.plus.monthly', transaction_id: '1', original_transaction_id: 'o1', expires: U(2026, 11, 7, 10), revoked: false, renews: true, environment: 'Production' };
  const b = await account({ store: { plan: apple }, t: U(2026, 10, 10) });
  await b.spend(2);
  b.at(U(2026, 11, 7, 12));
  await b.get(); // expired for two hours: Plus is off, the record ends
  assert.ok((await b.rec()).ended);
  await b.put('plan', { ...apple, transaction_id: '2', expires: U(2026, 12, 7, 10) });
  b.at(U(2026, 11, 8));
  u = await b.get();
  assert.deepEqual([u.period_start, u.rollover_usd], [U(2026, 11, 7, 10), 4]);
  assert.equal((await b.rec()).ended, null);
  await b.put('plan', { ...apple, transaction_id: '2', expires: U(2026, 12, 7, 10), revoked: true });
  b.at(U(2026, 11, 9));
  const allow = await b.allow();
  assert.equal(allow.bucket, 'trial', 'cap 0 at once');
  let r = await b.rec();
  assert.equal(r.ended, U(2026, 11, 9));
  assert.equal(r.roll, r.roll_spent, 'rollover forfeited');
  await b.put('plan', { ...apple, transaction_id: '3', expires: U(2026, 12, 20), purchase_date: U(2026, 11, 20), revoked: false });
  b.at(U(2026, 11, 20, 1));
  u = await b.get();
  assert.deepEqual([u.period_start, u.spent_usd, u.rollover_usd, u.left_usd], [U(2026, 11, 20), 0, 0, 6], 'a repurchase starts fresh');

  // App Store: renewal turned off, the plan lapses, and the same subscriber comes back inside the snap: no rollover
  const off = { ...apple, renews: false };
  const d = await account({ store: { plan: off }, t: U(2026, 10, 10) });
  await d.spend(2);
  d.at(U(2026, 11, 7, 12));
  await d.get();
  assert.deepEqual([(await d.rec()).ended, (await d.rec()).ended_renews], [U(2026, 11, 7, 12), undefined]);
  await d.put('plan', { ...off, transaction_id: '2', expires: U(2026, 12, 9), purchase_date: U(2026, 11, 9), renews: true });
  d.at(U(2026, 11, 9, 1));
  u = await d.get();
  assert.deepEqual([u.period_start, u.rollover_usd, u.left_usd], [U(2026, 11, 7, 10), 0, 6], 'a cancel forfeits the rollover, even back within 3 days');

  const c = await account({ store: { stripe_plan: feb() }, t: U(2027, 2, 2) });
  await c.spend(1);
  await c.put('stripe_plan', { ...feb(), status: 'past_due', past_due_since: U(2027, 2, 10) });
  c.at(U(2027, 2, 12));
  assert.equal((await c.allow()).bucket, 'plus');
  assert.equal((await c.rec()).ended, null, 'inside the 3-day grace');
  c.at(U(2027, 2, 14));
  await c.get();
  assert.equal((await c.rec()).ended, U(2027, 2, 14));
  await c.put('stripe_plan', feb());
  c.at(U(2027, 2, 15));
  u = await c.get();
  r = await c.rec();
  assert.deepEqual([r.ended, r.spent, u.spent_usd, u.period_start], [null, 1, 1, U(2027, 2, 1)], 'recovered: spent reused');
});

test('revoke or refund, then a repurchase in the same period: the spend stays spent (no second allowance)', async () => {
  const apple = { product_id: 'com.askeden.eden.plus.monthly', transaction_id: '1', original_transaction_id: 'o1', expires: U(2026, 12, 7), purchase_date: U(2026, 11, 7), revoked: false, renews: true, environment: 'Production' };
  const a = await account({ store: { plan: apple }, t: U(2026, 11, 8) });
  await a.spend(1.5);
  await a.put('plan', { ...apple, revoked: true });
  a.at(U(2026, 11, 9));
  assert.equal((await a.allow()).bucket, 'trial');
  await a.put('plan', { ...apple, transaction_id: '2', expires: U(2026, 12, 10), purchase_date: U(2026, 11, 10) });
  a.at(U(2026, 11, 10, 1));
  const u = await a.get();
  assert.deepEqual([u.period_start, u.spent_usd, u.left_usd, u.week_left_usd], [U(2026, 11, 10), 1.5, 4.5, 0]);
});

test('a paid plan kept on by a promo past its grace, then the late renewal: the stub’s spend carries into the paid period', async () => {
  const a = await account({ store: { stripe_plan: stripe(U(2026, 11, 10), U(2026, 12, 10)), promo_plan: { until: U(2027, 1, 31), codes: [] } }, t: U(2026, 11, 11) });
  await a.spend(6);
  a.at(U(2026, 12, 12)); // Stripe past its 1-day grace; the promo keeps Plus on
  let u = await a.get();
  assert.deepEqual([u.period_source, u.period_start, u.period_end, u.rollover_usd], ['calendar', U(2026, 12, 10), U(2027, 1, 1), 0]);
  await a.spend(1.4);
  assert.deepEqual([(await a.rec()).start, (await a.rec()).spent], [U(2026, 12, 10), 1.4], 'the stub runs to its end (not re-made as the whole calendar month)');
  await a.put('stripe_plan', stripe(U(2026, 12, 10), U(2027, 1, 10)));
  a.at(U(2026, 12, 13));
  u = await a.get();
  assert.deepEqual([u.period_source, u.period_start, u.spent_usd, u.left_usd], ['stripe', U(2026, 12, 10), 1.4, 4.6], 'not a fresh 6');
});

test('a renewal pending: an idle older record has nothing to spend; last period’s rollover is not spendable once it ended', async () => {
  const a = await account({ store: { stripe_plan: stripe(U(2026, 10, 1), U(2026, 11, 1)) }, t: U(2026, 10, 2) });
  await a.get();
  await a.put('stripe_plan', stripe(U(2026, 11, 1), U(2026, 12, 1))); // November renewed, but no reads all November
  a.at(U(2026, 12, 1, 5)); // December's renewal not seen yet: inside the 1-day grace
  let u = await a.get();
  assert.deepEqual([u.renewal_pending, u.week_left_usd, u.left_usd], [true, 0, 0], 'not October’s unused 6');
  assert.equal((await a.allow()).bucket, 'trial');
  await a.put('stripe_plan', stripe(U(2026, 12, 1), U(2027, 1, 1)));
  a.at(U(2026, 12, 1, 6));
  u = await a.get();
  assert.deepEqual([u.period_start, u.rollover_usd, u.left_usd], [U(2026, 12, 1), 0, 6]);

  const b = await account({ store: { stripe_plan: feb() }, t: U(2027, 2, 2) });
  await b.spend(2);
  await b.put('stripe_plan', stripe(U(2027, 3, 1), U(2027, 4, 1)));
  b.at(U(2027, 3, 2));
  await b.spend(1); // from the rollover (4)
  b.at(U(2027, 4, 1, 5));
  u = await b.get();
  assert.deepEqual([u.renewal_pending, u.left_usd, u.rollover_left_usd, u.budget_usd, u.spent_usd], [true, 6, 0, 7, 1], 'March’s own leftover only; the rollover ended with March');
  assert.equal((await b.allow()).allowance_left, 6);
  await b.spend(0.5);
  assert.deepEqual([(await b.rec()).roll_spent, (await b.rec()).spent], [1, 0.5], 'a pending spend never draws the expired rollover');
});

test('late renewal: nothing new while the webhook is late (renewal_pending), then a contiguous period with rollover', async () => {
  const a = await account({ store: { stripe_plan: feb() }, t: U(2027, 2, 2) });
  await a.spend(2);
  a.at(U(2027, 3, 1, 5));
  let u = await a.get();
  assert.equal(u.renewal_pending, true);
  assert.equal(u.period_start, U(2027, 2, 1));
  const allow = await a.allow();
  assert.equal(allow.allowance_left, 4, 'only February’s leftover');
  await a.put('stripe_plan', stripe(U(2027, 3, 1), U(2027, 4, 1)));
  a.at(U(2027, 3, 1, 6));
  u = await a.get();
  assert.deepEqual([u.period_start, u.rollover_usd, u.renewal_pending], [U(2027, 3, 1), 4, undefined]);
});

test('a re-anchor while paid: the period runs to its end, then a pro-rata stub; under a week it merges; switches never reset spent', async () => {
  const a = await account({ store: { stripe_plan: stripe(U(2026, 11, 5), U(2026, 12, 5)) }, t: U(2026, 11, 6) });
  await a.spend(1);
  for (const [day, ps, pe] of [[20, U(2026, 11, 20), U(2027, 11, 20)], [25, U(2026, 11, 25), U(2026, 12, 25)], [26, U(2026, 11, 26), U(2027, 11, 26)], [27, U(2026, 11, 25), U(2026, 12, 25)]]) {
    await a.put('stripe_plan', stripe(ps, pe));
    a.at(U(2026, 11, day, 1));
    const u = await a.get();
    assert.deepEqual([u.period_start, u.period_end, u.spent_usd], [U(2026, 11, 5), U(2026, 12, 5), 1], `switch on Nov ${day}`);
  }
  a.at(U(2026, 12, 5, 1));
  let u = await a.get();
  assert.deepEqual([u.period_start, u.period_end, u.rollover_usd], [U(2026, 12, 5), U(2026, 12, 25), 5]);
  near(u.plus_usd, 6 * (20 / 30), 'a 20-day stub of a 30-day month');

  const b = await account({ store: { stripe_plan: stripe(U(2026, 11, 5), U(2026, 12, 5)) }, t: U(2026, 11, 6) });
  await b.get();
  await b.put('stripe_plan', stripe(U(2026, 11, 7, 12), U(2027, 11, 7, 12)));
  b.at(U(2026, 11, 7, 13));
  assert.equal((await b.get()).period_start, U(2026, 11, 5));
  b.at(U(2026, 12, 5, 1));
  u = await b.get();
  assert.deepEqual([u.period_start, u.period_end], [U(2026, 12, 5), U(2027, 1, 7, 12)], 'a 2.5-day stub merged into the next slice');
  near(u.plus_usd, 6 * ((2.5 / 30) + 1));
  assert.equal(u.rollover_usd, 6, 'capped at the plan’s month though the period is longer');
});

test('free or promo to paid: anchored at once, with a fresh allowance', async () => {
  const a = await account({ store: { promo_plan: { until: U(2026, 11, 30), codes: [] } }, t: U(2026, 11, 12) });
  await a.spend(2);
  assert.equal((await a.get()).period_source, 'calendar');
  await a.put('stripe_plan', stripe(U(2026, 11, 14), U(2026, 12, 14)));
  a.at(U(2026, 11, 14, 1));
  const u = await a.get();
  assert.deepEqual([u.period_source, u.period_start, u.spent_usd, u.plus_usd, u.rollover_usd], ['stripe', U(2026, 11, 14), 0, 6, 0]);
});

test('migration: subscribed before this month keeps the calendar month, then a stub to the anchor with rollover; subscribed this month is anchored at once', async () => {
  const a = await account({ store: { stripe_plan: stripe(U(2026, 10, 20), U(2026, 11, 20)), usage: { month: '2026-11', spent: 4.2, trial_spent: 0 } }, t: U(2026, 11, 12) });
  let u = await a.get();
  assert.deepEqual([u.period_source, u.period_start, u.period_end, u.left_usd], ['calendar', U(2026, 11, 1), U(2026, 12, 1), 1.8]);
  await a.put('stripe_plan', stripe(U(2026, 11, 20), U(2026, 12, 20)));
  a.at(U(2026, 11, 25));
  u = await a.get();
  assert.deepEqual([u.period_start, u.left_usd], [U(2026, 11, 1), 1.8], 'November runs to its end');
  a.at(U(2026, 12, 1, 1));
  u = await a.get();
  assert.deepEqual([u.period_source, u.period_start, u.period_end, u.rollover_usd], ['stripe', U(2026, 12, 1), U(2026, 12, 20), 1.8]);
  near(u.plus_usd, 6 * 19 / 30);

  const b = await account({ store: { stripe_plan: stripe(U(2026, 11, 20), U(2026, 12, 20)), usage: { month: '2026-11', spent: 4.2, trial_spent: 0 } }, t: U(2026, 11, 22) });
  u = await b.get();
  assert.deepEqual([u.period_source, u.period_start, u.spent_usd], ['stripe', U(2026, 11, 20), 4.2]);
});

test('migration with live Rewards extra AI: never more left than v1’s cap − spent', async () => {
  const extra = [{ red: 'r1', usd: 5, until: U(2026, 12, 1) }];
  for (const ps of [U(2026, 10, 20), U(2026, 11, 5)]) { // subscribed before this month (calendar), and this month (anchored)
    const store = { stripe_plan: stripe(ps, addMonthsUTC(ps, 1)), usage: { month: '2026-11', spent: 8, trial_spent: 0 }, 'rwd:ai': extra };
    const v1 = await account({ store, env: {}, t: U(2026, 11, 12) });
    const v1u = await v1.get();
    assert.deepEqual([v1u.budget_usd, v1u.left_usd], [11, 3], 'v1: 6 + 5, 8 spent');
    const a = await account({ store, t: U(2026, 11, 12) });
    const u = await a.get();
    assert.equal(u.left_usd, 3, `left ${new Date(ps).toISOString()}`);
    assert.ok(u.week_left_usd <= 3);
    const r = await a.rec();
    assert.deepEqual([r.extra_spent.r1, r.spent], [5, 3], 'the extra first, as charge() spends');
    assert.equal((await a.allow()).bucket, u.week_left_usd > 0 ? 'plus' : 'trial');
  }
});

test('flag on → off → on: what v1 spent while off counts (same month, and across a month)', async () => {
  const a = await account({ store: { stripe_plan: feb() }, t: U(2027, 2, 2) });
  await a.spend(4);
  a.env.ALLOWANCE_V2 = 'off';
  a.at(U(2027, 2, 10));
  await a.spend(2);
  assert.equal((await a.get()).left_usd, 0, 'v1: 6 of 6');
  a.env.ALLOWANCE_V2 = 'on';
  let u = await a.get();
  assert.deepEqual([u.spent_usd, u.left_usd, u.week_left_usd], [6, 0, 0]);
  assert.equal((await a.allow()).bucket, 'trial');

  const b = await account({ store: { stripe_plan: stripe(U(2026, 11, 5), U(2026, 12, 5)) }, t: U(2026, 11, 10) });
  await b.spend(1);
  b.env.ALLOWANCE_V2 = 'off';
  b.at(U(2026, 12, 2));
  await b.spend(2); // v1's December
  b.env.ALLOWANCE_V2 = 'on';
  b.at(U(2026, 12, 3));
  u = await b.get();
  assert.deepEqual([u.period_start, u.spent_usd, u.left_usd], [U(2026, 11, 5), 3, 3]);
  await b.get();
  assert.equal((await b.get()).spent_usd, 3, 'counted once');
});

test('flag on, spend, flag off: today’s numbers, as if v2 had never run', async () => {
  const sp = stripe(U(2026, 11, 5), U(2026, 12, 5));
  const v2 = await account({ store: { stripe_plan: sp }, t: U(2026, 11, 12) });
  const v1 = await account({ store: { stripe_plan: sp }, env: {}, t: U(2026, 11, 12) });
  for (const [day, usd] of [[12, 1], [13, 0.7], [20, 2.25]]) {
    for (const x of [v1, v2]) {
      x.at(U(2026, 11, day));
      await x.spend(usd);
    }
  }
  v2.env.ALLOWANCE_V2 = 'off';
  const strip = ({ ...o }) => o;
  assert.deepEqual(strip(await v2.get()), strip(await v1.get()));
  assert.deepEqual(await v2.allow(), await v1.allow());
  assert.deepEqual(await v2.obj.storage.get('usage'), await v1.obj.storage.get('usage'));
});

test('Rewards extra AI: not sliced, after rollover and before the period’s own, never rolled, used once across periods', async () => {
  const a = await account({ store: { stripe_plan: stripe(U(2026, 11, 5), U(2026, 12, 5)), 'rwd:ai': [{ red: 'r1', usd: 2, until: U(2027, 1, 1) }] }, t: U(2026, 11, 12) });
  let u = await a.get();
  assert.equal(u.week_left_usd, 5, 'week 2: 3 released + 2 extra');
  assert.equal(u.plus_usd, 6);
  assert.equal(u.budget_usd, 8);
  await a.spend(1);
  let r = await a.rec();
  assert.deepEqual([r.extra_spent.r1, r.spent], [1, 0]);
  await a.put('stripe_plan', stripe(U(2026, 12, 5), U(2027, 1, 5)));
  a.at(U(2026, 12, 6));
  u = await a.get();
  assert.equal(u.rollover_usd, 6, 'the period’s own unused; the extra never rolls');
  assert.equal(u.left_usd, 6 + 1 + 6);
  await a.spend(7);
  r = await a.rec();
  assert.deepEqual([r.roll_spent, r.extra_spent.r1, r.spent], [6, 2, 0]);
  await a.put('stripe_plan', stripe(U(2027, 1, 5), U(2027, 2, 5)));
  a.at(U(2027, 1, 6));
  await a.get();
  assert.deepEqual((await a.rec()).extra_spent, {}, 'pruned once the item ended');
});

test('view(): the keys of today with the flag off; Plus adds the documented ones; free and unlimited add `allowance` only', async () => {
  const t = U(2026, 11, 12);
  const sp = stripe(U(2026, 11, 5), U(2026, 12, 5));
  for (const env of [{}, { ALLOWANCE_V2: 'off' }]) {
    for (const store of [{ stripe_plan: sp }, {}]) assert.deepEqual(Object.keys(await (await account({ env, store, t })).get()), TODAY_KEYS);
  }
  const plus = await (await account({ store: { stripe_plan: sp }, t })).get();
  assert.deepEqual(Object.keys(plus), [...TODAY_KEYS, ...V2_KEYS]);
  assert.deepEqual([plus.week_number, plus.weeks_in_period, plus.week_slice_usd, plus.week_left_usd, plus.answer_usd, plus.week_answers_left], [2, 4, 1.5, 3, 0.033, 90]);
  const free = await (await account({ t })).get();
  assert.deepEqual(Object.keys(free), [...TODAY_KEYS, 'allowance']);
  const v1free = await (await account({ env: {}, t })).get();
  assert.deepEqual({ ...free, allowance: undefined }, { ...v1free, allowance: undefined });
  const unl = await (await account({ env: { ...ON, UNLIMITED_EMAILS: 'fam@example.com' }, store: { identities: [{ provider: 'google', sub_hash: 'h', email: 'fam@example.com', added: t }] }, t })).get();
  assert.deepEqual(Object.keys(unl), [...TODAY_KEYS, 'allowance']);
  assert.equal(unl.budget_usd, 1000);
});

test('grants: a delegate gets at most the owner’s week; its pool still resets by calendar month', async () => {
  const a = await account({ store: { stripe_plan: feb(), 'dlg:abc': { status: 'active' }, 'pool:dlg:abc': { cap: 5, month: '2027-01', spent: 5, by: {} } }, t: U(2027, 2, 2) });
  const d = await a.obj.storage.get(`dev:${a.auth.device}`);
  const owner = parseToken((await a.obj.makeDevice(a.id, { name: 'Mac', kind: 'iphone' })).token);
  await a.put(`dev:${a.auth.device}`, { ...d, grant: { type: 'delegate', id: 'abc', label: 'Sam', features: [], account: 'bbbbbbbb' } });
  const mine = await a.allow();
  assert.equal(mine.left, 1.5, 'the owner’s week, and January’s pool spend gone');
  assert.ok(mine.bucket.startsWith('plus|dlg:abc'));
  const theirs = await call(a.env, a.id, 'allow-ai', { eden: true }, owner);
  assert.equal(theirs.week_left, 1.5);
});

test('spends either side of a boundary count where they happened; an advance is written once', async () => {
  const a = await account({ store: { stripe_plan: feb() }, t: U(2027, 2, 7, 23, 59) });
  await a.spend(0.5);
  a.at(U(2027, 2, 8, 0, 1));
  await a.spend(0.5);
  assert.equal((await a.allow()).week_left, 2, 'week 2: 3 released − 1');
  await a.put('stripe_plan', stripe(U(2027, 3, 1), U(2027, 4, 1)));
  a.at(U(2027, 2, 28, 23, 59));
  await a.spend(1);
  a.at(U(2027, 3, 1, 0, 1));
  await a.spend(0.25);
  const r = await a.rec();
  assert.deepEqual([r.start, r.roll, r.roll_spent, r.spent], [U(2027, 3, 1), 4, 0.25, 0]);
  let writes = 0;
  const put = a.obj.storage.put.bind(a.obj.storage);
  a.obj.storage.put = async (k, v) => { if (k === 'allow2' || (typeof k === 'object' && 'allow2' in k)) writes++; return put(k, v); };
  a.at(U(2027, 3, 9));
  for (let i = 0; i < 4; i++) { await a.get(); await a.allow(); }
  assert.equal(writes, 0, 'a new week alone changes nothing stored');
  a.at(U(2027, 4, 1, 1)); // stale: April's renewal not seen yet, no grace (renews: true gives one day)
  await a.put('stripe_plan', stripe(U(2027, 4, 1), U(2027, 5, 1)));
  writes = 0;
  for (let i = 0; i < 4; i++) { await a.get(); await a.allow(); }
  assert.equal(writes, 1, 'the new period written once');
});

test('the chat: the autopilot uses the period and its spend with v2 fields; unchanged without; /api/chat/spend’s week', () => {
  const env = { PLUS_BUDGET_USD: '6' };
  const mid = U(2026, 11, 15, 12);
  const plain = { ok: true, bucket: 'plus', left: 3, allowance_left: 3, budget: 6 };
  const ap = hostedAutopilot(env, plain, mid);
  assert.equal(ap.periodStart, '2026-11-01T00:00:00.000Z');
  assert.equal(ap.spentUSD, 3);
  assert.deepEqual(spendWeek(env, plain), {});
  const v2 = { ...plain, budget: 10, period_start: U(2026, 11, 5), period_end: U(2026, 12, 5), period_spent: 2.5, week_left: 1.5, week_end: U(2026, 11, 19) };
  const ap2 = hostedAutopilot(env, v2, mid);
  assert.deepEqual([ap2.periodStart, ap2.periodEnd, ap2.spentUSD, ap2.budgetUSD], ['2026-11-05T00:00:00.000Z', '2026-12-05T00:00:00.000Z', 2.5, 10]);
  assert.deepEqual(spendWeek(env, v2), { week: { leftUSD: 1.5, end: U(2026, 11, 19), answersLeft: 45 } });
  assert.deepEqual(spendWeek(env, { ...v2, allowance_left: 0.5 }).week, { leftUSD: 0.5, end: U(2026, 11, 19), answersLeft: 15 }, 'net of running turns’ holds');
  assert.deepEqual(spendWeek({ ALLOWANCE_ANSWER_USD: '0.05' }, v2).week.answersLeft, 30);
  const trial = hostedAutopilot(env, { ok: true, bucket: 'trial', left: 0.5, period_start: 1 }, mid);
  assert.equal(trial.method, 'trial', 'the trial ignores period fields');
});
