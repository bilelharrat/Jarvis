// The bonus pool (accounts/bonus-pool.js) and the account's side of it (accounts/allowance.js poolSync):
// funded only by rollover that expired unused, split by plan price across Ultra, Platinum and Eden Black,
// each capped at +20% of the plan's AI and at what the pool holds, fixed at the start of a period.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call } from '../src/accounts/index.js';
import { parseToken } from '../src/accounts/util.js';
import { BonusPool, addMonth } from '../src/accounts/bonus-pool.js';
import { Account, namespace } from './fakes.js';

const DAY = 86400_000;
const U = (y, m, d, h = 0) => Date.UTC(y, m - 1, d, h);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ''} ${a} ≈ ${b}`);

/** A pool on a clock of our own; `calls` counts every op; `down` makes it unreachable. */
function poolNs(clock) {
  const ns = namespace(BonusPool, {});
  const calls = [];
  const fake = {
    calls,
    down: false,
    idFromName: (n) => n,
    get(name) {
      const stub = ns.get(name);
      ns.objects.get(name).now = () => clock.t;
      return {
        fetch: async (url, init = {}) => {
          calls.push({ op: new URL(url).pathname.slice(1), body: init.body ? JSON.parse(init.body) : null });
          if (fake.down) throw new Error('pool down');
          return stub.fetch(url, init);
        },
      };
    },
  };
  return fake;
}
const op = async (pool, name, body = {}) => {
  const res = await pool.get('global').fetch(`https://pool/${name}`, { method: 'POST', body: JSON.stringify(body) });
  return { status: res.status, ...(await res.json()) };
};
const monthOf = async (pool, m) => (await op(pool, 'state')).months.find((x) => x.month === m);

// ── the pool itself ──

test('contribute: once per key; bad, negative, NaN, zero or over $1,000 → 400', async () => {
  const clock = { t: U(2027, 1, 10) };
  const pool = poolNs(clock);
  assert.deepEqual(await op(pool, 'contribute', { key: 'a:rollover:sub_1:1', usd: 3.5, kind: 'rollover' }), { status: 200, ok: true, duplicate: false });
  assert.deepEqual(await op(pool, 'contribute', { key: 'a:rollover:sub_1:1', usd: 3.5, kind: 'rollover' }), { status: 200, ok: true, duplicate: true });
  for (const body of [{ key: 'k', usd: -1, kind: 'rollover' }, { key: 'k', usd: 0, kind: 'rollover' }, { key: 'k', usd: Number.NaN, kind: 'rollover' }, { key: 'k', usd: '3', kind: 'rollover' }, { key: 'k', usd: 1000.01, kind: 'rollover' }, { key: 'k', usd: 1, kind: 'gift' }, { key: 'bad key', usd: 1, kind: 'rollover' }, { key: '', usd: 1, kind: 'rollover' }, { key: 'x'.repeat(201), usd: 1, kind: 'rollover' }]) {
    assert.equal((await op(pool, 'contribute', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await monthOf(pool, '2027-01')).contrib, 3.5);
  const res = await pool.get('global').fetch('https://pool/steal', { method: 'POST', body: '{}' });
  assert.equal(res.status, 404);
});

test('months: the first has no weight so nothing is granted; avail = contrib + leftover; rate = avail / last month’s weight; skipped months keep the last weight', async () => {
  const clock = { t: U(2027, 1, 10) };
  const pool = poolNs(clock);
  await op(pool, 'contribute', { key: 'c1', usd: 100, kind: 'rollover' });
  let c = await op(pool, 'claim', { key: 'u1', tier: 'ultra', weight: 100, cap_usd: 9.8 });
  assert.deepEqual([c.usd, c.month, c.duplicate], [0, '2027-01', false], 'the first month: no weight yet');
  await op(pool, 'claim', { key: 'b1', tier: 'black', weight: 400, cap_usd: 39.6 });
  let jan = await monthOf(pool, '2027-01');
  assert.deepEqual([jan.contrib, jan.weight, jan.granted], [100, 500, 0]);
  clock.t = U(2027, 2, 3);
  await op(pool, 'contribute', { key: 'c2', usd: 7, kind: 'bonus_return' });
  const feb = await monthOf(pool, '2027-02');
  assert.equal(feb.avail, 100);
  near(feb.rate, 100 / 500);
  c = await op(pool, 'claim', { key: 'u2', tier: 'ultra', weight: 100, cap_usd: 9.8 });
  near(c.usd, 9.8, 'min(100 × 0.2 = 20, the cap 9.8)');
  c = await op(pool, 'claim', { key: 'p2', tier: 'platinum', weight: 200, cap_usd: 19.6 });
  near(c.usd, 19.6);
  // April with nothing in March: March's avail = Feb's contrib + Feb's leftover; the weight is February's (300)
  clock.t = U(2027, 4, 2);
  const state = await op(pool, 'state');
  const mar = state.months.find((m) => m.month === '2027-03');
  const apr = state.months.find((m) => m.month === '2027-04');
  near(mar.avail, 7 + (100 - 9.8 - 19.6));
  near(mar.rate, mar.avail / 300);
  near(apr.avail, mar.avail, 'nothing granted or added in March: all of it carries');
  near(apr.rate, apr.avail / 300, 'a skipped month keeps the last known weight');
  assert.deepEqual(state.months.map((m) => m.month), ['2027-04', '2027-03', '2027-02', '2027-01']);
  assert.equal(addMonth('2027-12', 1), '2028-01');
  assert.equal(addMonth('2027-01', -2), '2026-11');
});

/** A pool in February with $avail to grant at `rate` dollars per weight dollar. */
async function seeded(avail, janWeight) {
  const clock = { t: U(2027, 1, 10) };
  const pool = poolNs(clock);
  for (let i = 0, left = avail; left > 0; i++, left -= 1000) await op(pool, 'contribute', { key: `seed${i}`, usd: Math.min(1000, left), kind: 'rollover' });
  for (let w = 0, i = 0; w < janWeight; w += 100, i++) await op(pool, 'claim', { key: `w${i}`, tier: 'ultra', weight: 100, cap_usd: 0 });
  clock.t = U(2027, 2, 2);
  pool.calls.length = 0; // count only what comes after the seeding
  return { pool, clock };
}

test('claim: min(price × rate, the cap, what is left), split 1:2:4 by price; once per key, the same amount after', async () => {
  const { pool } = await seeded(70, 1000); // rate 0.07: Ultra 7, Platinum 14, Black 28, each under its cap
  const u = await op(pool, 'claim', { key: 'u', tier: 'ultra', weight: 100, cap_usd: 9.8 });
  const p = await op(pool, 'claim', { key: 'p', tier: 'platinum', weight: 200, cap_usd: 19.6 });
  const b = await op(pool, 'claim', { key: 'b', tier: 'black', weight: 400, cap_usd: 39.6 });
  near(u.usd, 7);
  near(p.usd, 14);
  near(b.usd, 28);
  const again = await op(pool, 'claim', { key: 'p', tier: 'platinum', weight: 200, cap_usd: 19.6 });
  assert.deepEqual([again.usd, again.duplicate], [p.usd, true]);
  const late = await op(pool, 'claim', { key: 'b2', tier: 'black', weight: 400, cap_usd: 39.6 });
  near(late.usd, 70 - 49, 'never more than is left');
  assert.equal((await op(pool, 'claim', { key: 'b3', tier: 'black', weight: 400, cap_usd: 39.6 })).usd, 0);
  const feb = await monthOf(pool, '2027-02');
  near(feb.granted, 70);
  assert.equal(feb.weight, 100 + 200 + 400 * 3, 'a zero claim still weighs');
  for (const body of [{ key: 'x', tier: 'max', weight: 50, cap_usd: 1 }, { key: 'x', tier: 'ultra', weight: 400, cap_usd: 1 }, { key: 'x', tier: 'ultra', weight: 100, cap_usd: -1 }, { key: 'x', tier: 'ultra', weight: 100 }]) {
    assert.equal((await op(pool, 'claim', body)).status, 400, JSON.stringify(body));
  }
});

test('50 claims at once never pass what the pool holds; a random run keeps Σ granted ≤ avail every month', async () => {
  const { pool } = await seeded(100, 1000); // rate 0.1: Black wants 39.6, Ultra 9.8
  const tiers = [['ultra', 100, 9.8], ['platinum', 200, 19.6], ['black', 400, 39.6]];
  const outs = await Promise.all(Array.from({ length: 50 }, (_, i) => { const [tier, weight, cap] = tiers[i % 3]; return op(pool, 'claim', { key: `p${i}`, tier, weight, cap_usd: cap }); }));
  const total = outs.reduce((s, o) => s + o.usd, 0);
  assert.ok(total <= 100 + 1e-9, `granted ${total}`);
  near(total, 100, 'and all of it went');
  // property: random contributions and claims over many months
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const clock = { t: U(2027, 1, 1) };
  const p2 = poolNs(clock);
  for (let i = 0; i < 400; i++) {
    clock.t += Math.floor(rnd() * 3 * DAY);
    if (rnd() < 0.4) await op(p2, 'contribute', { key: `c${i}`, usd: Math.round(rnd() * 5000) / 100 + 0.01, kind: rnd() < 0.8 ? 'rollover' : 'bonus_return' });
    else { const [tier, weight, cap] = tiers[Math.floor(rnd() * 3)]; await op(p2, 'claim', { key: `k${i % 150}`, tier, weight, cap_usd: cap * (rnd() < 0.2 ? 0.3 : 1) }); }
  }
  for (const m of (await op(p2, 'state')).months) assert.ok(m.granted <= m.avail + 1e-6, `${m.month}: ${m.granted} ≤ ${m.avail}`);
});

// ── the account's side ──

let nextId = 3000;
const ON = { ALLOWANCE_V2: 'on', PLANS_V2: 'on', STRIPE_PRICE_ULTRA: 'price_ultraM', STRIPE_PRICE_BLACK: 'price_blackM', STRIPE_PRICE_PRO: 'price_proM', STRIPE_PRICE_MAX: 'price_maxM', STRIPE_PRICE_PLATINUM: 'price_platM' };
const sp = (price, ps, pe, extra = {}) => ({ customer: 'cus_1', subscription: 'sub_1', status: 'active', price, period_start: ps, period_end: pe, renews: true, livemode: false, ...extra });

async function account({ store = {}, env = ON, pool, clock }) {
  const id = `${String(nextId++).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const e = { TRIAL_BUDGET_USD: '0', PLUS_BUDGET_USD: '6', ...env, ...(pool ? { BONUS_POOL: pool } : {}) };
  e.ACCOUNTS = namespace(Account, e);
  e.ACCOUNTS.get(id);
  const obj = e.ACCOUNTS.objects.get(id);
  obj.now = () => clock.t;
  await obj.storage.put('account', { id, created: clock.t - 60 * DAY, origin: 'apple' });
  for (const [k, v] of Object.entries(store)) await obj.storage.put(k, v);
  const auth = parseToken((await obj.makeDevice(id, { name: 'iPhone', kind: 'iphone' })).token);
  return {
    obj,
    put: (k, v) => obj.storage.put(k, v),
    view: () => call(e, id, 'get', {}, auth),
    usage: async () => (await call(e, id, 'get', {}, auth)).usage,
    allow: () => call(e, id, 'allow-ai', { eden: true }, auth),
    spend: (usd) => call(e, id, 'spend', { usd, bucket: 'plus' }),
    rec: () => obj.storage.get('allow2'),
  };
}
const contributions = (pool, kind) => pool.calls.filter((c) => c.op === 'contribute' && (!kind || c.body.kind === kind));
const claims = (pool) => pool.calls.filter((c) => c.op === 'claim');

test('the account: Ultra claims +20% at its period’s start; budget and left include it; spend order rollover → week → bonus; never rolled; unspent goes back once', async () => {
  const { pool, clock } = await seeded(1000, 100); // rate 10: everyone gets the cap
  const a = await account({ store: { stripe_plan: sp('price_ultraM', U(2027, 2, 1), U(2027, 3, 1)) }, pool, clock });
  let u = await a.usage();
  assert.equal(claims(pool).length, 1);
  assert.deepEqual(claims(pool)[0].body.tier, 'ultra');
  assert.equal(claims(pool)[0].body.weight, 100);
  near(claims(pool)[0].body.cap_usd, 9.8);
  assert.deepEqual([u.bonus_max_pct, u.bonus_usd, u.bonus_left_usd, u.plus_usd], [20, 9.8, 9.8, 49]);
  near(u.budget_usd, 58.8);
  near(u.left_usd, 58.8);
  near(u.week_left_usd, 49 / 4 + 9.8, 'the bonus isn’t sliced');
  await a.usage();
  assert.equal(claims(pool).length, 1, 'claimed once a period');
  // the week's own first, then the bonus, then any overspend on the period's own
  await a.spend(12.25);
  u = await a.usage();
  assert.deepEqual([u.bonus_left_usd, (await a.rec()).spent], [9.8, 12.25]);
  await a.spend(5);
  near((await a.usage()).bonus_left_usd, 4.8);
  assert.equal((await a.rec()).spent, 12.25);
  // the next period, settled as if the bonus were spent last: 17.25 of own 49 used, so 31.75 rolls and all 9.8 of the
  // bonus goes back once (a bonus spent early never becomes the subscriber's rollover)
  await a.put('stripe_plan', sp('price_ultraM', U(2027, 3, 1), U(2027, 4, 1)));
  clock.t = U(2027, 3, 2);
  u = await a.usage();
  near(u.rollover_usd, 49 - 17.25);
  const back = contributions(pool, 'bonus_return');
  assert.equal(back.length, 1);
  near(back[0].body.usd, 9.8);
  assert.equal(contributions(pool, 'rollover').length, 0, 'live rollover never funds the pool');
  near(u.bonus_usd, 9.8, 'March’s own claim (rate from February)');
  await a.usage();
  assert.equal(contributions(pool).length, 1, 'once');
  // spend order now: the rollover first
  await a.spend(10);
  const rec = await a.rec();
  assert.deepEqual([rec.roll_spent, rec.spent, rec.bonus.spent], [10, 0, 0]);
});

test('the bonus is spent last when a period closes: only spend beyond the own allowance uses it (the reviewer’s probe)', async () => {
  const { pool, clock } = await seeded(1000, 100);
  const a = await account({ store: { stripe_plan: sp('price_ultraM', U(2027, 2, 1), U(2027, 3, 1)) }, pool, clock });
  await a.usage();
  await a.spend(22.05); // week 1: own 12.25 then bonus 9.8
  assert.equal((await a.usage()).bonus_left_usd, 0);
  await a.put('stripe_plan', sp('price_ultraM', U(2027, 3, 1), U(2027, 4, 1)));
  clock.t = U(2027, 3, 2);
  const u = await a.usage();
  near(u.rollover_usd, 49 - 22.05, 'own unused only: 26.95, not 36.75');
  near(contributions(pool, 'bonus_return')[0].body.usd, 9.8, 'the whole bonus goes back');
});

test('an upgrade into a bonus plan mid-period claims nothing until the next period; a downgrade after a claim keeps none of it', async () => {
  const { pool, clock } = await seeded(1000, 100);
  clock.t = U(2027, 2, 2);
  const a = await account({ store: { stripe_plan: sp('price_proM', U(2027, 2, 1), U(2027, 3, 1), { updated: U(2027, 2, 1) / 1000 }) }, pool, clock });
  await a.usage();
  clock.t = U(2027, 2, 27);
  await a.put('stripe_plan', sp('price_blackM', U(2027, 2, 1), U(2027, 3, 1), { updated: U(2027, 2, 27) / 1000 }));
  let u = await a.usage();
  assert.equal(claims(pool).length, 0, 'no claim in the period of the upgrade');
  assert.equal(u.bonus_usd, 0);
  // the same upgrade never read until day 27 (no record of the Pro days): the store's change time still blocks it
  const b = await account({ store: { stripe_plan: sp('price_blackM', U(2027, 2, 1), U(2027, 3, 1), { updated: U(2027, 2, 26) / 1000 }) }, pool, clock });
  assert.equal((await b.usage()).bonus_usd, 0);
  assert.equal(claims(pool).length, 0);
  // the next period (renewed at its start) claims
  await a.put('stripe_plan', sp('price_blackM', U(2027, 3, 1), U(2027, 4, 1), { updated: U(2027, 3, 1) / 1000 }));
  clock.t = U(2027, 3, 2);
  u = await a.usage();
  assert.equal(claims(pool).length, 1);
  near(u.bonus_usd, 39.6);
  // a downgrade after the claim: none of the bonus is left to spend, and what was unspent goes back when the period closes
  clock.t = U(2027, 3, 3);
  await a.put('stripe_plan', sp('price_proM', U(2027, 3, 1), U(2027, 4, 1), { updated: U(2027, 3, 3) / 1000 }));
  u = await a.usage();
  assert.equal(u.bonus_left_usd, 0);
  await a.put('stripe_plan', sp('price_proM', U(2027, 4, 1), U(2027, 5, 1), { updated: U(2027, 4, 1) / 1000 }));
  clock.t = U(2027, 4, 2);
  await a.usage();
  near(contributions(pool, 'bonus_return')[0].body.usd, 39.6);
});

test('a tier change counts from when the store says it changed, not from the first read after it', async () => {
  const { pool, clock } = await seeded(1000, 100);
  clock.t = U(2027, 2, 1, 1);
  const a = await account({ store: { stripe_plan: sp('price_blackM', U(2027, 2, 1), U(2027, 3, 1), { updated: U(2027, 2, 1) / 1000 }) }, pool, clock });
  await a.usage();
  // Black → Pro on day 2 (28-day period), first read on day 27
  await a.put('stripe_plan', sp('price_proM', U(2027, 2, 1), U(2027, 3, 1), { updated: U(2027, 2, 2) / 1000 }));
  clock.t = U(2027, 2, 27);
  const u = await a.usage();
  near(u.plus_usd, 10 + 188 * (1 / 28), 'the Black share is one day, not 26');
});

test('a refund and a repurchase in the same period never draw a second bonus', async () => {
  const { pool, clock } = await seeded(1000, 100);
  clock.t = U(2027, 2, 2);
  const a = await account({ store: { stripe_plan: sp('price_ultraM', U(2027, 2, 1), U(2027, 3, 1), { updated: U(2027, 2, 1) / 1000 }) }, pool, clock });
  await a.usage();
  await a.spend(20); // own 12.25 of week 1, then 7.75 of the bonus
  await a.put('stripe_plan', sp('price_ultraM', U(2027, 2, 1), U(2027, 3, 1), { status: 'canceled', updated: U(2027, 2, 3) / 1000 }));
  clock.t = U(2027, 2, 3);
  await a.usage();
  await a.put('stripe_plan', sp('price_ultraM', U(2027, 2, 3), U(2027, 3, 3), { subscription: 'sub_2', updated: U(2027, 2, 3) / 1000 }));
  clock.t = U(2027, 2, 3, 1);
  const u = await a.usage();
  assert.equal(claims(pool).length, 1, 'one claim for the two purchases');
  assert.equal(u.bonus_left_usd, 0);
});

test('a scripted run: contributions are exactly the expired rollover (end of the next period, a pending renewal, the plan’s end), never live rollover or an allowance', async () => {
  const { pool, clock } = await seeded(10, 100);
  clock.t = U(2027, 2, 2);
  const a = await account({ store: { stripe_plan: sp('price_maxM', U(2027, 2, 1), U(2027, 3, 1)) }, pool, clock }); // Max: no bonus, but its rollover funds the pool
  await a.spend(8); // Feb: 28 − 8 = 20 rolls into March
  await a.put('stripe_plan', sp('price_maxM', U(2027, 3, 1), U(2027, 4, 1)));
  clock.t = U(2027, 3, 2);
  near((await a.usage()).rollover_usd, 20);
  await a.spend(5); // from March's rollover: 15 of it will expire
  assert.equal(contributions(pool).length, 0);
  // the renewal is late: March's window ended, the plan runs on its grace; nothing expires into the pool yet
  clock.t = U(2027, 4, 1, 6);
  const pending = await a.usage();
  assert.equal(pending.renewal_pending, true);
  assert.equal(contributions(pool).length, 0);
  // the renewal lands: March's unspent rollover (15) went, once
  await a.put('stripe_plan', sp('price_maxM', U(2027, 4, 1), U(2027, 5, 1)));
  clock.t = U(2027, 4, 1, 7);
  await a.usage();
  await a.usage();
  let c = contributions(pool, 'rollover');
  assert.equal(c.length, 1);
  near(c[0].body.usd, 15);
  assert.match(c[0].body.key, /^[0-9a-f]{24}:rollover:sub_1:\d+$/);
  // April: March's own 28 unused rolled; the plan ends (cancelled, refunded): all of April's rollover goes, once
  near((await a.usage()).rollover_usd, 28);
  await a.spend(3);
  await a.put('stripe_plan', sp('price_maxM', U(2027, 4, 1), U(2027, 5, 1), { status: 'canceled', renews: false }));
  clock.t = U(2027, 4, 10);
  await a.usage();
  await a.usage();
  c = contributions(pool, 'rollover');
  assert.equal(c.length, 2);
  near(c[1].body.usd, 25);
  near(c.reduce((s, x) => s + x.body.usd, 0), 15 + 25, 'the expired rollover, exactly');
  assert.equal(claims(pool).length, 0, 'Max never claims');
});

test('the outbox: a pool that can’t be reached keeps the entry and no bonus; the next read sends it, claims, and clears it', async () => {
  const { pool, clock } = await seeded(1000, 100);
  const a = await account({ store: { stripe_plan: sp('price_blackM', U(2027, 2, 1), U(2027, 3, 1)) }, pool, clock });
  pool.down = true;
  let u = await a.usage();
  assert.equal(u.bonus_usd, 0, 'no bonus on this read');
  await a.spend(10);
  await a.put('stripe_plan', sp('price_blackM', U(2027, 3, 1), U(2027, 4, 1)));
  clock.t = U(2027, 3, 2);
  await a.usage();
  // March: February's period had no bonus; its own unused rolled (live: no contribution). Let March's rollover expire:
  await a.put('stripe_plan', sp('price_blackM', U(2027, 4, 1), U(2027, 5, 1)));
  clock.t = U(2027, 4, 2);
  await a.usage();
  const rec = await a.rec();
  assert.equal(rec.pool_out.length, 1, 'kept for the next read');
  assert.equal(rec.pool_out[0].kind, 'rollover');
  near(rec.pool_out[0].usd, 198 - 10, 'March’s rollover (February’s own unused), expired');
  assert.equal(rec.bonus, undefined);
  pool.down = false;
  u = await a.usage();
  assert.equal((await a.rec()).pool_out, undefined, 'acked: cleared');
  assert.ok(u.bonus_usd > 0, 'claimed once the pool answers');
  near(u.bonus_usd, 39.6);
  const sent = contributions(pool).filter((x) => x.body.kind === 'rollover');
  assert.ok(sent.length >= 2, 'tried while down, then sent');
  // the claimed amount stays fixed for the period, whatever the pool holds later
  await (pool.get('global')).fetch('https://pool/contribute', { method: 'POST', body: JSON.stringify({ key: 'more', usd: 900, kind: 'rollover' }) });
  near((await a.usage()).bonus_usd, 39.6);
  assert.equal(claims(pool).filter((x) => !pool.down).length >= 1, true);
});

test('only Ultra, Platinum and Eden Black that pay claim: Plus, Pro, Max, promo, sandbox, unlimited and the trial never do', async () => {
  const { pool, clock } = await seeded(1000, 100);
  const stores = [
    { stripe_plan: sp('price_proM', U(2027, 2, 1), U(2027, 3, 1)) },
    { stripe_plan: sp('price_maxM', U(2027, 2, 1), U(2027, 3, 1)) },
    { stripe_plan: sp('price_1PlusMonthlyTest', U(2027, 2, 1), U(2027, 3, 1)) },
    { promo_plan: { until: U(2027, 3, 1), codes: [] } },
    { plan: { product_id: 'com.askeden.eden.black.monthly', transaction_id: '1', original_transaction_id: 'o1', expires: U(2027, 3, 1), revoked: false, environment: 'Sandbox' } },
    {},
  ];
  for (const store of stores) await (await account({ store, pool, clock })).usage();
  await (await account({ store: { stripe_plan: sp('price_blackM', U(2027, 2, 1), U(2027, 3, 1)), identities: [{ provider: 'google', sub_hash: 'h', email: 'fam@example.com', added: 1 }] }, env: { ...ON, UNLIMITED_EMAILS: 'fam@example.com' }, pool, clock })).usage();
  assert.equal(claims(pool).length, 0);
  await (await account({ store: { stripe_plan: sp('price_platM', U(2027, 2, 1), U(2027, 3, 1)) }, pool, clock })).usage();
  assert.equal(claims(pool).length, 1);
  assert.equal(claims(pool)[0].body.weight, 200);
});

test('flags: ALLOWANCE_V2 off, PLANS_V2 off, or no BONUS_POOL binding → not one pool call, and no bonus', async () => {
  for (const env of [{ ...ON, ALLOWANCE_V2: 'off' }, { ...ON, PLANS_V2: 'off' }]) {
    const { pool, clock } = await seeded(1000, 100);
    const before = pool.calls.length;
    const a = await account({ store: { stripe_plan: sp('price_blackM', U(2027, 2, 1), U(2027, 3, 1)) }, env, pool, clock });
    await a.usage();
    await a.spend(30);
    await a.put('stripe_plan', sp('price_blackM', U(2027, 3, 1), U(2027, 4, 1)));
    clock.t = U(2027, 3, 2);
    await a.allow();
    await a.put('stripe_plan', sp('price_blackM', U(2027, 3, 1), U(2027, 4, 1), { status: 'canceled', renews: false }));
    clock.t = U(2027, 3, 9);
    await a.usage();
    assert.equal(pool.calls.length, before, JSON.stringify(env));
    const rec = await a.rec();
    assert.equal(rec && (rec.pool_out || rec.bonus), undefined);
  }
  const clock = { t: U(2027, 2, 2) };
  const a = await account({ store: { stripe_plan: sp('price_blackM', U(2027, 2, 1), U(2027, 3, 1)) }, clock });
  const u = await a.usage();
  assert.deepEqual([u.bonus_max_pct, u.bonus_usd], [0, 0]);
});

test('words: nothing a person sees names a pool, rollover, other members or unused next to the bonus; bonus_pct is gone', async () => {
  const { pool, clock } = await seeded(1000, 100);
  const a = await account({ store: { stripe_plan: sp('price_ultraM', U(2027, 2, 1), U(2027, 3, 1)) }, pool, clock });
  const view = await a.view();
  const bonusKeys = Object.keys(view.usage).filter((k) => /bonus/.test(k));
  assert.deepEqual(bonusKeys, ['bonus_max_pct', 'bonus_usd', 'bonus_left_usd']);
  assert.doesNotMatch(JSON.stringify(view), /pool|other members|unused/i);
  await a.spend(49 / 4 + 9.8);
  const refused = await a.allow();
  assert.equal(refused.ok, false);
  assert.doesNotMatch(JSON.stringify(refused), /pool|rollover|other members|unused/i);
  assert.match(refused.why, /^This week's Ultra AI allowance is used up\./);
});

// ── the owner's switches (/admin): on/off, the cap in %, which plans ──

test('switches: default on at 20% for Ultra, Platinum, Eden Black; off → 0 (weight still counts); 10% halves the cap, 40% doubles it; an unticked plan gets 0', async () => {
  const { pool } = await seeded(1000, 1000); // rate 1: every claim gets its (scaled) cap
  assert.deepEqual(await op(pool, 'settings'), { status: 200, on: true, max_pct: 20, tiers: ['ultra', 'platinum', 'black'] });
  near((await op(pool, 'claim', { key: 'u0', tier: 'ultra', weight: 100, cap_usd: 9.8 })).usd, 9.8, 'the default');
  await op(pool, 'set-settings', { on: false });
  assert.equal((await op(pool, 'claim', { key: 'u1', tier: 'ultra', weight: 100, cap_usd: 9.8 })).usd, 0, 'off');
  await op(pool, 'set-settings', { on: true, max_pct: 10 });
  near((await op(pool, 'claim', { key: 'u2', tier: 'ultra', weight: 100, cap_usd: 9.8 })).usd, 4.9, '10%');
  await op(pool, 'set-settings', { max_pct: 40 });
  near((await op(pool, 'claim', { key: 'u3', tier: 'ultra', weight: 100, cap_usd: 9.8 })).usd, 19.6, '40%');
  await op(pool, 'set-settings', { tiers: ['ultra', 'platinum'] });
  assert.equal((await op(pool, 'claim', { key: 'b1', tier: 'black', weight: 400, cap_usd: 39.6 })).usd, 0, 'Eden Black unticked');
  const feb = await monthOf(pool, '2027-02');
  assert.equal(feb.weight, 100 * 4 + 400, 'claims at 0 still weigh');
  near(feb.granted, 9.8 + 4.9 + 19.6);
  // the object cleans what it is given: a wrong field keeps the last good value
  const s = await op(pool, 'set-settings', { max_pct: 500, tiers: ['pro', 'ultra'], on: 'yes' });
  assert.deepEqual([s.on, s.max_pct, s.tiers], [true, 20, ['ultra']]);
  assert.deepEqual((await op(pool, 'state')).settings, { on: true, max_pct: 20, tiers: ['ultra'] });
});

test('switches: /api/admin/bonus-pool — the owner only; POST checked (400 on a wrong field, nothing changed); GET shows them', async () => {
  const { adminBonusPool, forgetBonusSettings, bonusSettings } = await import('../src/accounts/bonus-pool.js');
  const clock = { t: U(2027, 2, 2) };
  const pool = poolNs(clock);
  const env = { BONUS_POOL: pool };
  const owner = async () => ({ account: 'owner' });
  const nobody = async () => null;
  const req = (method, body, type = 'application/json') => new Request('https://askeden.com/api/admin/bonus-pool', { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': type } } : {}) });
  assert.equal((await adminBonusPool(req('POST', { on: false }, 'text/plain'), env, owner)).status, 415, 'a plain form post is refused');
  assert.equal((await adminBonusPool(req('GET'), env, nobody)).status, 404);
  assert.equal((await adminBonusPool(req('POST', { on: false }), env, nobody)).status, 404);
  assert.equal((await op(pool, 'settings')).on, true, 'a stranger changed nothing');
  for (const body of [{ on: 'no' }, { max_pct: 51 }, { max_pct: -1 }, { max_pct: '10' }, { tiers: ['pro'] }, { tiers: 'ultra' }, [1]]) {
    assert.equal((await adminBonusPool(req('POST', body), env, owner)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(await op(pool, 'settings'), { status: 200, on: true, max_pct: 20, tiers: ['ultra', 'platinum', 'black'] }, 'nothing changed by a bad POST');
  forgetBonusSettings();
  assert.equal((await bonusSettings(env)).max_pct, 20);
  const res = await adminBonusPool(req('POST', { max_pct: 12.5, tiers: ['black'] }), env, owner);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).settings, { on: true, max_pct: 12.5, tiers: ['black'] });
  assert.equal((await bonusSettings(env)).max_pct, 12.5, 'a change through /admin is seen at once in this Worker copy');
  const got = await (await adminBonusPool(req('GET'), env, owner)).json();
  assert.deepEqual([got.ready, got.settings.max_pct, Array.isArray(got.months)], [true, 12.5, true]);
  pool.down = true;
  forgetBonusSettings();
  assert.deepEqual(await bonusSettings(env), { on: true, max_pct: 20, tiers: ['ultra', 'platinum', 'black'] }, 'the pool unreachable: the defaults');
  forgetBonusSettings();
  assert.deepEqual(await bonusSettings({}), { on: true, max_pct: 20, tiers: ['ultra', 'platinum', 'black'] }, 'no pool: the defaults');
});

test('switches: the account meter and the plan cards say what the owner set', async () => {
  const { forgetBonusSettings } = await import('../src/accounts/bonus-pool.js');
  const { plansConfig } = await import('../src/accounts/plans.js');
  const { pool, clock } = await seeded(1000, 100);
  await op(pool, 'set-settings', { max_pct: 10 });
  forgetBonusSettings();
  const a = await account({ store: { stripe_plan: sp('price_ultraM', U(2027, 2, 1), U(2027, 3, 1)) }, pool, clock });
  const u = await a.usage();
  assert.equal(u.bonus_max_pct, 10);
  near(u.bonus_usd, 4.9, 'granted at 10%: half the 20% cap');
  const env = { ...ON, BONUS_POOL: pool };
  assert.deepEqual(plansConfig(env, { on: true, max_pct: 10, tiers: ['ultra', 'black'] }).plans.map((p) => p.bonus_max_pct), [0, 0, 0, 10, 0, 10]);
  assert.deepEqual(plansConfig(env, { on: false, max_pct: 10, tiers: ['ultra'] }).plans.map((p) => p.bonus_max_pct), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(plansConfig(env).plans.map((p) => p.bonus_max_pct), [0, 0, 0, 20, 20, 20], 'no settings given: the defaults');
  await op(pool, 'set-settings', { max_pct: 20 });
  forgetBonusSettings();
});

test('switches: /api/admin/bonus-pool says whether the bonus runs (active: ALLOWANCE_V2 + PLANS_V2 + the binding); saving works either way', async () => {
  const { adminBonusPool } = await import('../src/accounts/bonus-pool.js');
  const pool = poolNs({ t: U(2027, 2, 2) });
  const owner = async () => ({ account: 'owner' });
  const req = (method, body) => new Request('https://askeden.com/api/admin/bonus-pool', { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
  const off = { BONUS_POOL: pool, ALLOWANCE_V2: 'on' }; // PLANS_V2 off
  const got = await (await adminBonusPool(req('GET'), off, owner)).json();
  assert.deepEqual([got.ready, got.active], [true, false]);
  const saved = await (await adminBonusPool(req('POST', { max_pct: 15 }), off, owner)).json();
  assert.deepEqual([saved.ready, saved.active, saved.settings.max_pct], [true, false, 15], 'kept for later while inactive');
  const on = { BONUS_POOL: pool, ALLOWANCE_V2: 'on', PLANS_V2: 'on' };
  const live = await (await adminBonusPool(req('GET'), on, owner)).json();
  assert.deepEqual([live.ready, live.active, live.settings.max_pct], [true, true, 15]);
  assert.equal((await (await adminBonusPool(req('POST', { on: true }), on, owner)).json()).active, true);
  const none = await (await adminBonusPool(req('GET'), { ALLOWANCE_V2: 'on', PLANS_V2: 'on' }, owner)).json();
  assert.deepEqual([none.ready, none.active], [false, false], 'no binding: not ready, not active');
});
