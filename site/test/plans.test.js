// PLANS_V2 (accounts/plans.js): the six plans' caps from the workbook, which tier a price or product is,
// and what the account shows and allows on each. Flag off (and on with no plan sold): today's answers exactly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { call } from '../src/accounts/index.js';
import { isPlusPurchase, parseToken } from '../src/accounts/util.js';
import { PLAN_DEFAULTS, TIERS, planCaps, plansConfig, priceTier, productTier } from '../src/accounts/plans.js';
import { allowance as browserMinutes } from '../src/browser/rules.js';
import { GOLDEN, SCENARIOS, runScenario } from './allowance-golden.js';
import { Account, namespace } from './fakes.js';

const DAY = 86400_000;
const U = (y, m, d, h = 0) => Date.UTC(y, m - 1, d, h);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ''} ${a} ≈ ${b}`);
const PRICES = {
  STRIPE_PRICE_PLUS2: 'price_plus2M', STRIPE_PRICE_PLUS2_YEARLY: 'price_plus2Y',
  STRIPE_PRICE_PRO: 'price_proM, price_proOld', STRIPE_PRICE_PRO_YEARLY: 'price_proY',
  STRIPE_PRICE_MAX: 'price_maxM', STRIPE_PRICE_MAX_YEARLY: 'price_maxY',
  STRIPE_PRICE_ULTRA: 'price_ultraM', STRIPE_PRICE_ULTRA_YEARLY: 'price_ultraY',
  STRIPE_PRICE_PLATINUM: 'price_platM', STRIPE_PRICE_PLATINUM_YEARLY: 'price_platY',
  STRIPE_PRICE_BLACK: 'price_blackM', STRIPE_PRICE_BLACK_YEARLY: 'price_blackY',
};

// ── flag off: today's answers ──

const strip = (steps) => JSON.parse(JSON.stringify(steps, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) && 'name' in v && 'active' in v ? (({ tier, label, ...rest }) => rest)(v) : v)));

test('PLANS_V2 unset, "off", or "on" with no plan price: every kind of account answers as the golden (on adds only plan.tier and plan.label)', async () => {
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  let n = 500;
  for (const name of Object.keys(SCENARIOS)) {
    for (const flag of [{ PLANS_V2: 'off' }, { PLANS_V2: 'yes' }, { PLANS_V2: 'off', PLAN_CAPS: '{"pro":{"ai_usd":1}}' }]) {
      const run = await runScenario(name, flag, n++);
      assert.deepEqual(JSON.parse(JSON.stringify(run.steps)), golden[name], `${name} ${JSON.stringify(flag)}`);
    }
    const on = await runScenario(name, { PLANS_V2: 'on' }, n++);
    assert.deepEqual(strip(on.steps), golden[name], `${name} on`);
    const get = on.steps.find((s) => s.step === 'get').out;
    if (['free_trial', 'stripe_plus', 'promo', 'app_store_legacy'].includes(name)) assert.equal(typeof get.plan.label, 'string', `${name}: on, the plan has its label`);
  }
});

test('ALLOWANCE_V2 on: PLANS_V2 on (no plan sold, no pool) changes nothing but plan.tier and plan.label', async () => {
  let n = 700;
  for (const name of Object.keys(SCENARIOS)) {
    const a = await runScenario(name, { ALLOWANCE_V2: 'on' }, n++);
    const b = await runScenario(name, { ALLOWANCE_V2: 'on', PLANS_V2: 'on' }, n++);
    assert.deepEqual(strip(b.steps), JSON.parse(JSON.stringify(a.steps)), name);
  }
});

test('config: no plans, rollover or enterprise_contact key with the flags off', () => {
  for (const v of [undefined, '', 'off', 'yes', '1']) assert.deepEqual(plansConfig({ PLANS_V2: v, ALLOWANCE_V2: v, ENTERPRISE_CONTACT: v, ...PRICES }), {});
  assert.deepEqual(Object.keys(plansConfig({ PLANS_V2: 'on', ALLOWANCE_V2: ' On ', ENTERPRISE_CONTACT: 'on' })), ['plans', 'rollover', 'enterprise_contact']);
  const plans = plansConfig({ PLANS_V2: 'on' }).plans;
  assert.equal(plans.every((p) => p.web === false && p.yearly_usd === null), true, 'no price set: listed for the app, sold nowhere on the web');
});

// ── the caps ──

test('planCaps: the workbook’s numbers; PLAN_CAPS overrides field by field; bad JSON → defaults with one warning; negatives clamped; Plus cohorts ignore it', () => {
  assert.deepEqual(planCaps({}, 'pro'), { ai_usd: 10, flash_day: 40, flash_month: 250, flash_usd: 4, voice_day: 50000, browser_min: 300, answers: 300, eves_strong: 20 });
  assert.deepEqual(TIERS.map((t) => planCaps({}, t).ai_usd), [5, 10, 28, 49, 98, 198]);
  assert.deepEqual(TIERS.map((t) => planCaps({}, t).voice_day), [20000, 50000, 50000, 75000, 100000, 100000]);
  assert.deepEqual(TIERS.map((t) => planCaps({}, t).browser_min), [120, 300, 300, 600, 900, 1200]);
  assert.deepEqual(TIERS.map((t) => [planCaps({}, t).flash_day, planCaps({}, t).flash_month, planCaps({}, t).flash_usd]), [[20, 120, 2], [40, 250, 4], [85, 510, 8], [150, 900, 14], [320, 1930, 30], [635, 3800, 59]]);
  const env = { PLAN_CAPS: JSON.stringify({ pro: { ai_usd: 12, voice_day: -5, flash_day: 'x' }, max: { browser_min: 0 }, nope: { ai_usd: 1 }, plus: { ai_usd: 99 }, legacy: { ai_usd: 99 } }) };
  assert.deepEqual(planCaps(env, 'pro'), { ...PLAN_DEFAULTS.pro, ai_usd: 12, voice_day: 0 });
  assert.equal(planCaps(env, 'max').browser_min, 0);
  assert.equal(planCaps(env, 'nope'), null);
  assert.equal(planCaps(env, 'plus'), null, 'today’s Plus keeps allowances()');
  assert.equal(planCaps(env, 'legacy'), null);
  const warn = console.warn;
  const said = [];
  console.warn = (...a) => said.push(a.join(' '));
  try {
    for (const raw of ['{', '[]', '7', 'null']) assert.deepEqual(planCaps({ PLAN_CAPS: raw }, 'ultra'), PLAN_DEFAULTS.ultra, raw);
  } finally {
    console.warn = warn;
  }
  assert.ok(said.length <= 1, 'one warning at most');
});

test('priceTier: every STRIPE_PRICE_<PLAN>[_YEARLY] (comma lists); today’s Plus; the old $20 → legacy; unknown → null', () => {
  const env = { ...PRICES, STRIPE_PRICE_PLUS: 'price_plusM', STRIPE_PRICE_PLUS_YEARLY: 'price_plusY', STRIPE_PRICE_PLUS_LEGACY: 'price_old20' };
  const want = { price_plus2M: 'plus2', price_plus2Y: 'plus2', price_proM: 'pro', price_proOld: 'pro', price_proY: 'pro', price_maxM: 'max', price_maxY: 'max', price_ultraM: 'ultra', price_ultraY: 'ultra', price_platM: 'platinum', price_platY: 'platinum', price_blackM: 'black', price_blackY: 'black', price_plusM: 'plus', price_plusY: 'plus', price_old20: 'legacy', price_unknown: null, '': null };
  for (const [p, t] of Object.entries(want)) assert.equal(priceTier(env, p), t, p);
});

test('productTier: the 12 plan products, today’s Plus, J.A.R.V.I.S.’s → legacy; isPlusPurchase takes the new ids from Eden for iPhone only', () => {
  for (const t of TIERS) for (const i of ['monthly', 'yearly']) {
    const id = `com.askeden.eden.${t}.${i}`;
    assert.equal(productTier(id), t);
    assert.equal(isPlusPurchase({ productId: id, bundleId: 'com.askeden.eden' }), true, id);
    assert.equal(isPlusPurchase({ productId: id }), true, `${id} (checked already)`);
    assert.equal(isPlusPurchase({ productId: id, bundleId: 'com.askeden.jarvis' }), false, `${id} from J.A.R.V.I.S.`);
  }
  assert.equal(productTier('com.askeden.eden.plus.monthly'), 'plus');
  assert.equal(productTier('com.askeden.jarvis.plus.yearly'), 'legacy');
  assert.equal(productTier('com.askeden.eden.gold.monthly'), null);
  assert.equal(isPlusPurchase({ productId: 'com.askeden.eden.gold.monthly', bundleId: 'com.askeden.eden' }), false);
});

// ── the account on each plan ──

let nextId = 900;
async function account({ store = {}, env = {}, t = U(2026, 11, 12, 10) }) {
  const id = `${String(nextId++).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const e = { TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '6', ...PRICES, ...env };
  e.ACCOUNTS = namespace(Account, e);
  e.ACCOUNTS.get(id);
  const obj = e.ACCOUNTS.objects.get(id);
  const clock = { t };
  obj.now = () => clock.t;
  await obj.storage.put('account', { id, created: t - 60 * DAY, origin: 'apple' });
  for (const [k, v] of Object.entries(store)) await obj.storage.put(k, v);
  const auth = parseToken((await obj.makeDevice(id, { name: 'iPhone', kind: 'iphone' })).token);
  return {
    env: e, obj, id, clock,
    at: (when) => { clock.t = when; },
    put: (k, v) => obj.storage.put(k, v),
    view: () => call(e, id, 'get', {}, auth),
    allow: () => call(e, id, 'allow-ai', { eden: true }, auth),
    spend: (usd, bucket = 'plus') => call(e, id, 'spend', { usd, bucket }),
    voice: (chars) => call(e, id, 'voice', { chars }, auth),
    rec: () => obj.storage.get('allow2'),
  };
}
const stripe = (price, ps = U(2026, 11, 5, 9), pe = U(2026, 12, 5, 9), extra = {}) => ({ stripe_plan: { customer: 'cus_1', subscription: 'sub_1', status: 'active', price, period_start: ps, period_end: pe, renews: true, livemode: false, ...extra } });
const apple = (product, env = 'Production', t = U(2026, 11, 12, 10)) => ({ plan: { product_id: product, transaction_id: '1', original_transaction_id: 'o1', expires: t + 25 * DAY, revoked: false, environment: env, signed_date: t - DAY } });

test('each plan, through Stripe and the App Store: its AI, voice, browser minutes, tier and label; the higher of two wins; sandbox, promo and unlimited as today', async () => {
  const ON = { PLANS_V2: 'on' };
  const cases = [
    ['stripe plus2', stripe('price_plus2M'), 'plus2', 'Plus', 5, 20000, 120],
    ['stripe pro', stripe('price_proOld'), 'pro', 'Pro', 10, 50000, 300],
    ['stripe max yearly', stripe('price_maxY'), 'max', 'Max', 28, 50000, 300],
    ['stripe ultra', stripe('price_ultraM'), 'ultra', 'Ultra', 49, 75000, 600],
    ['app platinum', apple('com.askeden.eden.platinum.monthly'), 'platinum', 'Platinum', 98, 100000, 900],
    ['app black', apple('com.askeden.eden.black.yearly'), 'black', 'Eden Black', 198, 100000, 1200],
    ['app today’s Plus', apple('com.askeden.eden.plus.monthly'), 'plus', 'Plus', 6, 100000, 600],
    ['app J.A.R.V.I.S.', apple('com.askeden.jarvis.plus.monthly'), 'legacy', 'Plus', 20, 100000, 600],
    ['both: Pro on the web, Max at Apple', { ...stripe('price_proM'), ...apple('com.askeden.eden.max.monthly') }, 'max', 'Max', 28, 50000, 300],
    ['both: Black on the web, Plus at Apple', { ...stripe('price_blackM'), ...apple('com.askeden.eden.plus.monthly') }, 'black', 'Eden Black', 198, 100000, 1200],
    ['sandbox Ultra alone', apple('com.askeden.eden.ultra.monthly', 'Sandbox'), 'sandbox', 'Plus', 0.5, 100000, 600],
    ['promo', { promo_plan: { until: U(2027, 1, 1), codes: [] } }, 'plus', 'Plus', 6, 100000, 600],
  ];
  for (const [name, store, tier, label, ai, voice, minutes] of cases) {
    const a = await account({ store, env: ON });
    const v = await a.view();
    assert.deepEqual([v.plan.name, v.plan.tier, v.plan.label], ['plus', tier, label], name);
    assert.equal(v.usage.plus_usd, ai, `${name}: AI`);
    assert.equal(v.usage.budget_usd, ai, `${name}: budget`);
    assert.equal(v.usage.voice_daily, voice, `${name}: voice`);
    assert.equal(browserMinutes(a.env, true, v.plan.tier), minutes, `${name}: browser`);
    assert.equal((await a.allow()).allowance_left, ai, `${name}: allow`);
    assert.equal((await a.voice(voice)).ok, true, `${name}: a day's voice`);
    assert.equal((await a.voice(1)).ok, false, `${name}: then no more`);
  }
  const unl = await account({ env: { ...ON, UNLIMITED_EMAILS: 'fam@example.com' }, store: { ...stripe('price_blackM'), identities: [{ provider: 'google', sub_hash: 'h1', email: 'fam@example.com', added: 1 }] } });
  const u = await unl.view();
  assert.deepEqual([u.plan.tier, u.plan.label, u.usage.plus_usd], ['unlimited', 'Unlimited', 1000]);
  const free = await (await account({ env: ON })).view();
  assert.deepEqual([free.plan.name, free.plan.tier, free.plan.label, free.usage.voice_daily], ['free', 'free', 'Free', 20000]);
  // flag off: a v2 plan is still honoured and labelled; today's Plus shows no new key
  const off = await (await account({ store: stripe('price_maxM') })).view();
  assert.deepEqual([off.plan.tier, off.usage.plus_usd], ['max', 28]);
  const today = await (await account({ store: apple('com.askeden.eden.plus.monthly') })).view();
  assert.equal('tier' in today.plan || 'label' in today.plan, false);
  // the free browser and today's Plus browser: unchanged
  assert.equal(browserMinutes({}, false, 'black'), 60, 'not Plus: the free minutes whatever the header');
  assert.equal(browserMinutes({ BROWSER_MINUTES_PLUS: '700' }, true, 'plus'), 700);
  assert.equal(browserMinutes({ PLAN_CAPS: '{"max":{"browser_min":42}}' }, true, 'max'), 42);
});

test('the refusal names the plan and keeps “AI allowance” (web/chat plan-model.js LIMIT_RE)', async () => {
  const a = await account({ store: stripe('price_proM'), env: { PLANS_V2: 'on', TRIAL_BUDGET_USD: '0' } });
  await a.spend(10);
  const r = await a.allow();
  assert.equal(r.ok, false);
  assert.equal(r.why, "This month's Pro AI allowance is used up. It starts again on the 1st, or add credits in Settings › Account.");
  const v2 = await account({ store: stripe('price_blackM', U(2027, 2, 1), U(2027, 3, 1)), env: { PLANS_V2: 'on', ALLOWANCE_V2: 'on', TRIAL_BUDGET_USD: '0' }, t: U(2027, 2, 2) });
  await v2.spend(198 / 4);
  const w = await v2.allow();
  assert.equal(w.why, "This week's Eden Black AI allowance is used up. More arrives Feb 8, or add credits in Settings › Account.");
  for (const why of [r.why, w.why]) assert.match(why, /AI allowance/);
});

// ── a plan change inside a period (ALLOWANCE_V2) ──

test('mid-period upgrade: cap = old + (new − old) × the period left; downgrade lowers it; spent kept; left never negative; the week uses the new cap', async () => {
  const ON = { PLANS_V2: 'on', ALLOWANCE_V2: 'on' };
  const ps = U(2027, 2, 1);
  const pe = U(2027, 3, 1); // 28 days, 4 weeks
  const a = await account({ store: stripe('price_proM', ps, pe), env: ON, t: U(2027, 2, 2) });
  let v = (await a.view()).usage;
  assert.deepEqual([v.plus_usd, v.budget_usd], [10, 10]);
  await a.spend(2);
  // day 21 of 28: Eden Black for the last quarter
  a.at(U(2027, 2, 22));
  await a.put('stripe_plan', stripe('price_blackM', ps, pe).stripe_plan);
  v = (await a.view()).usage;
  near(v.plus_usd, 10 + (198 - 10) * 0.25, 'a quarter of the month on Black');
  assert.equal((await a.rec()).tier, 'black');
  assert.equal((await a.rec()).spent, 2, 'spent stays spent');
  near(v.left_usd, 10 + 188 * 0.25 - 2);
  near((await a.allow()).allowance_left, v.plus_usd - 2, 'week 4: the whole period released, at the new cap');
  // the leak: buying Eden Black on day 29 of a 30-day month is a day of Black, not a month
  const late = await account({ store: stripe('price_proM', U(2027, 4, 1), U(2027, 5, 1)), env: ON, t: U(2027, 4, 2) });
  await late.view();
  late.at(U(2027, 4, 30));
  await late.put('stripe_plan', stripe('price_blackM', U(2027, 4, 1), U(2027, 5, 1)).stripe_plan);
  near((await late.view()).usage.plus_usd, 10 + 188 / 30);
  // the next period: the new plan whole, no adjustment
  await late.put('stripe_plan', stripe('price_blackM', U(2027, 5, 1), U(2027, 6, 1)).stripe_plan);
  late.at(U(2027, 5, 2));
  const next = (await late.view()).usage;
  assert.equal(next.plus_usd, 198);
  assert.equal('adj' in (await late.rec()), false);
  // a downgrade halfway: Max → Pro, after spending most of Max's month
  const d = await account({ store: stripe('price_maxM', ps, pe), env: ON, t: U(2027, 2, 2) });
  await d.spend(25);
  d.at(U(2027, 2, 15));
  await d.put('stripe_plan', stripe('price_proM', ps, pe).stripe_plan);
  const dv = (await d.view()).usage;
  near(dv.plus_usd, 28 - 18 * 0.5);
  assert.equal(dv.left_usd, 0, 'never negative');
  assert.equal((await d.rec()).spent, 25);
  assert.notEqual((await d.allow()).bucket, 'plus');
});

test('an App Store in-group upgrade (a new expiry) re-anchors with the new plan', async () => {
  const ON = { PLANS_V2: 'on', ALLOWANCE_V2: 'on' };
  const a = await account({ store: { plan: { product_id: 'com.askeden.eden.pro.monthly', transaction_id: '1', original_transaction_id: 'o1', expires: U(2027, 3, 1), purchase_date: U(2027, 2, 1), revoked: false, environment: 'Production' } }, env: ON, t: U(2027, 2, 2) });
  assert.equal((await a.view()).usage.plus_usd, 10);
  a.at(U(2027, 2, 15));
  await a.put('plan', { product_id: 'com.askeden.eden.ultra.monthly', transaction_id: '2', original_transaction_id: 'o1', expires: U(2027, 3, 15), purchase_date: U(2027, 2, 15), revoked: false, environment: 'Production' });
  let v = (await a.view()).usage;
  near(v.plus_usd, 10 + 39 * 0.5, 'the old period: half on Ultra');
  assert.equal(v.period_end, U(2027, 3, 1));
  a.at(U(2027, 3, 2));
  v = (await a.view()).usage;
  assert.deepEqual([v.period_start, v.period_end], [U(2027, 3, 1), U(2027, 3, 15)], 'a stub to the new anchor');
  near(v.plus_usd, 49 * (14 / 28), 'the stub is the new plan, pro rata');
  assert.equal((await a.rec()).tier, 'ultra');
});
