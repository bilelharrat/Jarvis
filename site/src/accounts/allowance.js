// Plus's included AI, version 2 (owner's allocation strategy, 2026-11-12), behind ONE flag:
// ALLOWANCE_V2 = "on". Off (unset, "off", anything else), account.js runs exactly as before and
// nothing here is read or written.
//
//   Periods  anchored to the subscription's billing instant when it is known (Stripe's
//            current_period_start/end, the App Store's expiry and purchase date, Google Play's
//            expiry), else the calendar month in UTC (promo codes, an Eden Rewards Plus month:
//            today's grid). A yearly plan gets monthly slices of its year. A new subscriber no
//            longer gets a second allowance on the 1st.
//   Weekly   each period's allowance C is released in weekly slices (C/W a week, cumulative), so
//            unused weeks carry forward and only a sprint is limited, never the period's total.
//   Rollover a subscriber's own unused AI moves into the next period only, capped at 1x the plan's
//            monthly allowance, spent first, lost at that period's end or when the plan ends.
//   Tiers    PLANS_V2's six plans (plans.js): the record keeps its tier; a change inside a period
//            moves the period's allowance pro rata (an upgrade on day 29 is a day of the new plan).
//   Bonus    Ultra, Platinum and Eden Black (decision D): up to +20% of the plan's AI, claimed once at
//            the start of each period from the BonusPool (bonus-pool.js), which only expired rollover
//            funds. Spent after the week's own AI, never sliced, never rolled; unspent goes back.
//            Only with ALLOWANCE_V2, PLANS_V2 and the BONUS_POOL binding (plans.js poolOn).
//
// Kept on today's path even with the flag on: free and trial, credits, Daredevil, unlimited
// accounts, App Store Sandbox, Google Play license testers, the shared test account, and a
// delegate's or space's pool (it is still narrowed by the owner's week through allowAi).
//
// Storage: `allow2` = { v:1, src, sub, paid, start, end, factor, cap, spent, roll, roll_spent,
// extra_spent: { [rwd:ai redemption]: usd }, ended, ended_renews?, tier?, base?, adj?, bonus?: { start,
// usd, spent, returned? }, pool_out?: [{ key, usd, kind }] (the pool's outbox), migrated?, usage_month?,
// usage_spent? }. `usage` (account.js) stays the record of trial_spent and is dual-written by
// spend(), so turning the flag off brings back exactly today's calendar numbers, with no free reset.
// usage_month/usage_spent mirror `usage` as of allow2's last write: whatever `usage` gained while the
// flag was off (on → off → on) is charged to allow2 on the next v2 read. Every time here is UTC milliseconds.

import { aiExtraUsd } from '../travel/rewards.js';
import { playActive } from './play-plan.js';
import { stripeActive } from './stripe-plan.js';
import { sha256Hex } from './util.js';
import { BONUS_TIERS, PRICE_USD, bonusCapUsd, bonusPct, labelOf, poolOn } from './plans.js';
import { bonusSettings } from './bonus-pool.js';

export const DAY_MS = 86400_000;
export const WEEK_MS = 7 * DAY_MS;
const SNAP_MS = 3 * DAY_MS; // a renewal this close to the old period's end is the same grid (Apple's drift)
const SLICE_MS = 30.44 * DAY_MS;
const FULL_MONTH = [28 * DAY_MS - 6 * 3600_000, 31 * DAY_MS + 6 * 3600_000]; // any slice this long is one whole month (factor 1)
export const ANSWER_USD = 0.033; // ≈ one answer of provider cost ($5 → 150 answers: the business-model summary)
const round = (usd) => Math.round(usd * 1e6) / 1e6;

/** The one switch: ALLOWANCE_V2 = "on". */
export function allowanceV2(env) {
  return String((env && env.ALLOWANCE_V2) || '').trim().toLowerCase() === 'on';
}

/** What one answer costs, for "~N answers": ALLOWANCE_ANSWER_USD, else 0.033. */
export function answerUsd(env) {
  const n = Number(env && env.ALLOWANCE_ANSWER_USD);
  return Number.isFinite(n) && n > 0 ? n : ANSWER_USD;
}

// ── period math (pure) ──

const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** `t` moved k calendar months in UTC, the day clamped to the month's last and the time of day kept. */
export function addMonthsUTC(t, k) {
  const d = new Date(t);
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + k;
  const y = Math.floor(total / 12);
  const m = total - y * 12;
  return Date.UTC(y, m, Math.min(d.getUTCDate(), daysIn(y, m)), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

/** The length of the month that starts at `start`. */
export const naturalMonth = (start) => addMonthsUTC(start, 1) - start;

export const monthKey = (now) => new Date(now).toISOString().slice(0, 7);

/** The calendar month in UTC (today's grid): { ws, we }. */
export function calendarWindow(now) {
  const d = new Date(now);
  return { ws: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), we: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
}

const factorOf = (start, end) => {
  const len = end - start;
  return len >= FULL_MONTH[0] && len <= FULL_MONTH[1] ? 1 : len / naturalMonth(start);
};

/**
 * The monthly slice of the billing window [ws, we) holding `now`: { k, n, start, end, factor }.
 * Slice k starts at addMonthsUTC(ws, k), always counted from ws, never chained; the last ends at we.
 * factor: 1 for a whole month, pro rata for an intro week or a stub.
 */
export function sliceAt(ws, we, now) {
  const n = Math.max(1, Math.round((we - ws) / SLICE_MS));
  let k = 0;
  while (k < n - 1 && addMonthsUTC(ws, k + 1) <= now) k++;
  const start = addMonthsUTC(ws, k);
  const end = k === n - 1 ? we : addMonthsUTC(ws, k + 1);
  return { k, n, start, end, factor: factorOf(start, end) };
}

/** The week of the period [start, end) holding `now`: { j, W, start, end }. The last week runs to the period's end. */
export function weekAt(start, end, now) {
  const W = Math.max(1, Math.round((end - start) / WEEK_MS));
  const j = Math.max(0, Math.min(W - 1, Math.floor((now - start) / WEEK_MS)));
  return { j, W, start: start + j * WEEK_MS, end: j === W - 1 ? end : start + (j + 1) * WEEK_MS };
}

// ── where the period comes from (pure) ──

const unitOf = (text) => (/yearly|annual/i.test(String(text || '')) ? 12 : 1);

/**
 * The billing window: { src, ws, we, sub, linked, paid, slice, stale }. Stripe first, then the App
 * Store (production), then Google Play (not a license tester), else the calendar month.
 * `stores`: { stripe (stripe_plan), store (plan), play (play_plan), playSub, playLinked (hashes) }.
 * `stale`: the window has ended while the plan still runs on a renewal's grace.
 */
export function windowOf(plan, stores, now) {
  const { stripe = null, store = {}, play = null } = stores || {};
  const appleLive = Boolean(store && store.expires && store.expires > now && !store.revoked);
  const sandbox = appleLive && /^sandbox$/i.test(String(store.environment || ''));
  const playLive = Boolean(play && playActive(play, now));
  let w = null;
  if (stripe && stripeActive(stripe, now)) {
    const we = Number(stripe.period_end) || 0;
    let ws = Number(stripe.period_start) || 0;
    // Before period_start was kept: back from the end by a month, or a year when that month hasn't begun.
    if (!(ws > 0 && ws < we)) ws = addMonthsUTC(we, addMonthsUTC(we, -1) <= now ? -1 : -12);
    w = { src: 'stripe', ws, we, sub: String(stripe.subscription), linked: null };
  } else if (appleLive && !sandbox) {
    const we = Number(store.expires);
    const bought = Number(store.purchase_date) || 0;
    w = { src: 'app_store', ws: Math.max(addMonthsUTC(we, -unitOf(store.product_id)), bought < we ? bought : 0), we, sub: String(store.original_transaction_id || ''), linked: null };
  } else if (playLive && !play.test) {
    const we = Number(play.expires) || 0;
    w = { src: 'google_play', ws: addMonthsUTC(we, -unitOf(`${play.product_id || ''} ${play.base_plan || ''}`)), we, sub: stores.playSub || null, linked: stores.playLinked || null };
  }
  const active = Boolean(plan && plan.active);
  const unlimited = Boolean(plan && plan.unlimited);
  if (w && w.we > w.ws) return { ...w, paid: true, slice: active && !unlimited, stale: now >= w.we };
  const { ws, we } = calendarWindow(now);
  return { src: 'calendar', ws, we, sub: null, linked: null, paid: false, slice: active && !unlimited && !sandbox && !(playLive && play.test), stale: false };
}

// ── the record (pure) ──

/** allow2 in one key order, so an unchanged record is never written again. */
export function normal(r) {
  return {
    v: 1,
    src: r.src,
    sub: r.sub ?? null,
    paid: Boolean(r.paid),
    start: r.start,
    end: r.end,
    factor: r.factor,
    cap: round(Number(r.cap) || 0),
    spent: round(Number(r.spent) || 0),
    roll: round(Number(r.roll) || 0),
    roll_spent: round(Number(r.roll_spent) || 0),
    extra_spent: { ...(r.extra_spent || {}) },
    ended: r.ended ?? null,
    ...(r.ended && r.ended_renews ? { ended_renews: true } : {}),
    ...(r.tier ? { tier: r.tier, base: round(Number(r.base) || 0) } : {}),
    ...(r.adj ? { adj: round(Number(r.adj) || 0) } : {}),
    ...(r.bonus ? { bonus: { start: r.bonus.start, usd: round(Number(r.bonus.usd) || 0), spent: round(Number(r.bonus.spent) || 0), ...(r.bonus.returned ? { returned: true } : {}) } } : {}),
    ...(Array.isArray(r.pool_out) && r.pool_out.length ? { pool_out: r.pool_out.map((e) => ({ key: e.key, usd: round(Number(e.usd) || 0), kind: e.kind })) } : {}),
    ...(r.migrated ? { migrated: r.migrated } : {}),
    ...(r.usage_month ? { usage_month: r.usage_month, usage_spent: round(Number(r.usage_spent) || 0) } : {}),
  };
}

const liveExtras = (list, now) => (Array.isArray(list) ? list : []).filter((x) => x && x.until > now && x.red);
const sameChain = (rec, ctx) => Boolean(rec.sub) && (rec.sub === ctx.sub || (Boolean(ctx.linked) && ctx.linked === rec.sub));

function fresh(ctx, period, { spent = 0, roll = 0, extra_spent = {}, src = ctx.src, mirror = null } = {}) {
  return normal({ src, sub: ctx.sub, paid: ctx.paid, start: period.start, end: period.end, factor: period.factor, cap: ctx.monthly * period.factor, spent, roll, roll_spent: 0, extra_spent, ended: null, ...(ctx.tier ? { tier: ctx.tier, base: ctx.monthly } : {}), ...(mirror || {}) });
}

/** The period's own allowance: the plan's month × the period's factor, moved by any tier change inside it (adj). Never below 0. */
export const capOf = (rec, ctx) => round(Math.max(0, ctx.monthly * rec.factor + (Number(rec.adj) || 0)));

/** The record's bonus when it belongs to its period: { usd, spent, left } (left 0 once returned or the period closed), else null. */
function bonusOf(rec, pending) {
  const b = rec.bonus;
  if (!b || b.start !== rec.start) return null;
  const off = rec.tier && !BONUS_TIERS.includes(rec.tier); // moved off a bonus plan mid-period: the rest goes back when it closes
  const left = b.returned || pending || off ? 0 : Math.max(0, b.usd - b.spent);
  return { usd: b.usd, spent: b.spent, left };
}

/**
 * A period settled as if its bonus were spent last (charge() may draw it before the period's own runs out):
 * own = what the period's own allowance really paid, bonusUsed = only the overspend beyond it. So a bonus
 * spent early never turns into the subscriber's rollover; the pool gets back usd − bonusUsed.
 */
export function settle(r) {
  const b = r.bonus && r.bonus.start === r.start ? r.bonus : null;
  const total = (Number(r.spent) || 0) + (b ? Number(b.spent) || 0 : 0);
  const cap = Number(r.cap) || 0;
  const own = Math.min(cap, total);
  const bonusUsed = b ? Math.min(b.usd, Math.max(0, total - cap)) : 0;
  return { ownLeft: Math.max(0, cap - own), bonusBack: b && !b.returned ? round(Math.max(0, b.usd - bonusUsed)) : 0 };
}

/** What a period leaves the pool when it closes or the plan ends: its rollover unspent (expired), its bonus unspent (returned). */
function leftovers(r) {
  const out = [];
  const roll = round(Math.max(0, r.roll - r.roll_spent));
  if (r.paid && roll > 0) out.push({ key: `rollover:${r.sub || 'cal'}:${r.start}`, usd: roll, kind: 'rollover' });
  const b = r.bonus;
  const back = b && b.start === r.start ? settle(r).bonusBack : b && !b.returned ? round(Math.max(0, b.usd - b.spent)) : 0;
  if (back > 0) out.push({ key: `bonus:${r.sub || 'cal'}:${b.start}`, usd: back, kind: 'bonus_return' });
  return out;
}
const withOutbox = (list, more) => {
  const seen = new Set(list.map((e) => e.key));
  return [...list, ...more.filter((e) => !seen.has(e.key) && seen.add(e.key))];
};

const mirrorOf = (r) => (r.usage_month ? { usage_month: r.usage_month, usage_spent: r.usage_spent } : null);

/**
 * The first v2 read (no allow2). Subscribed this calendar month (or a calendar source): the anchored
 * period, counting this month's spend so far. Subscribed before: today's calendar month exactly, and
 * the anchored grid from the 1st on (advance's stub). v1's spend already used any live Rewards extra
 * AI (plusCap adds it), so it is charged in charge()'s order (the extra, soonest to end first, then
 * the period's own): left is never more than v1's cap − spent.
 */
export function migrate(usage, ctx, now) {
  const cal = calendarWindow(now);
  const spent = usage && usage.month === monthKey(now) ? Number(usage.spent) || 0 : 0;
  const rec = ctx.P.start >= cal.ws ? fresh(ctx, ctx.P) : normal({ ...fresh(ctx, { start: cal.ws, end: cal.we, factor: 1 }, { src: 'calendar' }), migrated: monthKey(now) });
  return charge(rec, ctx, now, spent);
}

/** The next period once `now` has reached rec.end: contiguous (with rollover), a gap (none), or a stub to a new anchor. */
function nextPeriod(rec, ctx) {
  const P = ctx.P;
  const gap = P.start - rec.end;
  const extra_spent = rec.extra_spent;
  const mirror = mirrorOf(rec);
  if (gap > SNAP_MS) return fresh(ctx, P, { extra_spent, mirror }); // (d) a gap or an idle period: nothing rolls
  // Only the subscriber's own unused AI, only between paid periods, never after the plan ended
  // (a lapse right at the boundary that the same subscription renews within the snap is no end, but
  // only while it was still renewing, i.e. a billing retry: a subscriber who turned renewal off forfeits it).
  const live = !rec.ended || (rec.ended >= rec.end && rec.ended_renews && sameChain(rec, ctx));
  const roll = rec.paid && ctx.paid && live ? Math.min(ctx.monthly, settle(rec).ownLeft) : 0;
  if (gap >= -SNAP_MS) return fresh(ctx, { start: rec.end, end: P.end, factor: P.factor }, { roll, extra_spent, mirror }); // (c) the same grid
  // (e) a new anchor seen at the boundary: a pro-rata stub to it; under a week, merged into the next slice
  let end = P.end;
  let factor = (P.factor * (P.end - rec.end)) / (P.end - P.start);
  if (P.end - rec.end < WEEK_MS && ctx.next) {
    end = ctx.next.end;
    factor += ctx.next.factor;
  }
  return fresh(ctx, { start: rec.end, end, factor }, { roll, extra_spent, mirror });
}

/**
 * The record brought to `now` (pure; the caller writes it only if it changed).
 * ctx: { active, renewing, slice, src, sub, linked, paid, stale, P, next, monthly, extras }.
 */
export function advance(prev, ctx, now) {
  let rec = normal(prev);
  const old = rec;
  let outbox = rec.pool_out || [];
  if (!ctx.active) {
    // (a) a refund, a revoke, an expiry, past_due beyond its grace: the plan ended; its rollover goes.
    // ended_renews: it was still renewing (a billing retry), so a renewal within the snap keeps next period's rollover.
    // With the pool on, the rollover that went expired (it funds the pool) and the unspent bonus goes back.
    if (!rec.ended) {
      if (ctx.pool) outbox = withOutbox(outbox, leftovers(rec));
      rec = normal({ ...rec, ended: now, ended_renews: Boolean(ctx.renewing), roll: rec.roll_spent, ...(rec.bonus ? { bonus: { ...rec.bonus, returned: true } } : {}), pool_out: outbox });
    }
    return rec;
  }
  if (!ctx.slice) return rec; // unlimited, Sandbox, a license tester: today's path; the record waits
  const live = new Set(liveExtras(ctx.extras, now).map((x) => x.red));
  rec.extra_spent = Object.fromEntries(Object.entries(rec.extra_spent).filter(([red]) => live.has(red)));
  if (now >= rec.end) {
    // (b) the window ended but the plan runs on a renewal's grace: stay in the period that window just
    // closed (available() says renewal_pending). An older record (no reads all last period) has no
    // claim on that period: a record with nothing in it until the renewal arrives.
    if (!ctx.stale) rec = nextPeriod(rec, ctx);
    else if (rec.end < ctx.P.end - SNAP_MS) rec = fresh(ctx, { start: Math.max(rec.end, ctx.P.start), end: ctx.P.end, factor: 0 }, { extra_spent: rec.extra_spent, mirror: mirrorOf(rec) });
  } else if (rec.ended) {
    // (g) the same subscription back in the same period (a payment recovered): as it was. Else a new
    // purchase: a new period, but a paid record's spend stays spent (a refund or revoke and a repurchase
    // in the same period is not a second allowance; v1 kept the month's spend too).
    const carry = rec.paid ? Math.min(ctx.monthly * ctx.P.factor, rec.spent) : 0;
    if (sameChain(rec, ctx) && (rec.start === ctx.P.start || rec.migrated)) rec = normal({ ...rec, ended: null });
    else {
      // A bonus already drawn in a period this one overlaps stays drawn: marked claimed (nothing left, nothing to return), no second claim.
      const b = rec.bonus && rec.bonus.start === rec.start && rec.paid && rec.end > ctx.P.start && rec.start < ctx.P.end ? rec.bonus : null;
      rec = fresh(ctx, ctx.P, { spent: carry, extra_spent: rec.extra_spent, mirror: mirrorOf(rec) });
      if (b) rec = normal({ ...rec, bonus: { start: rec.start, usd: b.spent, spent: b.spent, returned: true } });
    }
  } else if (!rec.paid && ctx.paid && (rec.src !== ctx.src || rec.start !== ctx.P.start || (rec.sub || null) !== (ctx.sub || null))) {
    // (f) free, promo or Rewards Plus becoming paid (or another anchor): the paid period starts now, fresh.
    // (An unpaid record under an unpaid window is the calendar month or (e)'s stub into it: it runs to its end.)
    // A paid one (a switch of interval or store, Apple's drift) runs to its end first: churn never resets it.
    // A paid period that began no later than this record (a lapsed paid plan kept on by a promo or a Rewards
    // month, then the late renewal): what was spent since is inside the paid period, so it carries.
    const carry = ctx.paid && ctx.P.start <= rec.start ? Math.min(ctx.monthly * ctx.P.factor, rec.spent) : 0;
    rec = fresh(ctx, ctx.P, { spent: carry, extra_spent: rec.extra_spent, mirror: mirrorOf(rec) });
  }
  if (ctx.linked && rec.sub === ctx.linked) rec.sub = ctx.sub; // a Google Play plan change: the chain's newest token
  // A new period (or a new record) replaced the old one: its rollover expired and its bonus is over (the pool's, once each by key).
  if (ctx.pool && rec.start !== old.start && !old.ended) outbox = withOutbox(outbox, leftovers(old));
  rec.pool_out = outbox;
  // PLANS_V2: a tier change inside the period moves its allowance pro rata. What the old plan gave for the share
  // already gone stays; the rest is the new plan's: cap = new × f − (new − old) × f × elapsed. Spent stays spent.
  if (ctx.tier) {
    if (rec.tier && rec.tier !== ctx.tier && now < rec.end && rec.end > rec.start) {
      // From when the plan changed (the store's own timestamp, ctx.changedAt), not when it was first read here.
      const at = Number(ctx.changedAt) > rec.start && Number(ctx.changedAt) < now ? Number(ctx.changedAt) : now;
      const elapsed = Math.min(1, Math.max(0, (at - rec.start) / (rec.end - rec.start)));
      rec.adj = (Number(rec.adj) || 0) + (Number(rec.base) - ctx.monthly) * rec.factor * elapsed;
    }
    rec.tier = ctx.tier;
    rec.base = ctx.monthly;
  }
  rec.cap = capOf(rec, ctx);
  return normal(rec);
}

/**
 * What the record allows at `now`: { C, budget, weekLeft, periodLeft, periodSpent, rollLeft, extraLeft,
 * week, pending }. Released AI is cumulative (C × (j+1)/W), so unused weeks carry forward; the
 * rollover and Rewards extra AI are not sliced.
 */
export function available(rec, ctx, now) {
  const C = capOf(rec, ctx);
  const extras = liveExtras(ctx.extras, now);
  const spentOf = (x) => Math.min(x.usd, Number(rec.extra_spent[x.red]) || 0);
  const extraLeft = extras.reduce((s, x) => s + Math.max(0, x.usd - spentOf(x)), 0);
  const pending = Boolean(ctx.stale && now >= rec.end); // the rollover expired with the period
  const rollLeft = pending ? 0 : Math.max(0, rec.roll - rec.roll_spent);
  const bonus = bonusOf(rec, pending); // not sliced, like the rollover
  const bonusLeft = bonus ? bonus.left : 0;
  const week = weekAt(rec.start, rec.end, now);
  const released = (C * (week.j + 1)) / week.W;
  const periodLeft = rollLeft + extraLeft + bonusLeft + Math.max(0, C - rec.spent);
  const weekLeft = Math.min(rollLeft + extraLeft + bonusLeft + Math.max(0, released - rec.spent), periodLeft);
  return {
    C: round(C),
    budget: round(C + (pending ? rec.roll_spent : rec.roll) + extras.reduce((s, x) => s + x.usd, 0) + (bonus ? bonus.spent + bonusLeft : 0)),
    weekLeft: round(weekLeft),
    periodLeft: round(periodLeft),
    periodSpent: round(rec.roll_spent + extras.reduce((s, x) => s + spentOf(x), 0) + rec.spent + (bonus ? bonus.spent : 0)),
    rollLeft: round(rollLeft),
    extraLeft: round(extraLeft),
    bonusUsd: bonus ? round(bonus.usd) : 0,
    bonusLeft: round(bonusLeft),
    week,
    pending,
  };
}

/**
 * `usd` taken from the allowance: the rollover first, then Rewards extra AI (soonest to end first), then the
 * period's own up to this week's release, then the bonus, and any overspend on the period's own (as before).
 */
export function charge(rec, ctx, now, usd) {
  const r = normal(rec);
  let left = Math.max(0, Number(usd) || 0);
  const pending = Boolean(ctx.stale && now >= r.end); // the rollover expired with the period (available())
  const fromRoll = pending ? 0 : Math.min(left, Math.max(0, r.roll - r.roll_spent));
  r.roll_spent = round(r.roll_spent + fromRoll);
  left -= fromRoll;
  for (const x of liveExtras(ctx.extras, now).sort((a, b) => a.until - b.until)) {
    if (!(left > 1e-12)) break;
    const take = Math.min(left, Math.max(0, x.usd - (Number(r.extra_spent[x.red]) || 0)));
    if (take > 0) {
      r.extra_spent[x.red] = round((Number(r.extra_spent[x.red]) || 0) + take);
      left -= take;
    }
  }
  const bonus = bonusOf(r, pending);
  if (bonus && bonus.left > 0 && left > 1e-12) {
    const week = weekAt(r.start, r.end, now);
    const own = Math.min(left, Math.max(0, (capOf(r, ctx) * (week.j + 1)) / week.W - r.spent));
    r.spent = round(r.spent + own);
    left -= own;
    const take = Math.min(left, bonus.left);
    r.bonus = { ...r.bonus, spent: round(r.bonus.spent + take) };
    left -= take;
  }
  if (left > 1e-12) r.spent = round(r.spent + left);
  r.cap = capOf(r, ctx);
  return normal(r);
}

// ── the Durable Object's glue (account.js calls these only with the flag on) ──

/** The plan's window and sizes now. `caps`: account.js allowances(env). */
async function contextOf(account, plan, caps, now) {
  const s = account.storage;
  const pool = poolOn(account.env);
  const [stripe, store, play, extras] = [await s.get('stripe_plan'), await s.get('plan'), await s.get('play_plan'), await s.get('rwd:ai')];
  const playSub = play && play.token ? await sha256Hex(`googleplay:${play.token}`) : null;
  const playLinked = play && play.linked ? await sha256Hex(`googleplay:${play.linked}`) : null;
  const win = windowOf(plan, { stripe: stripe || null, store: store || {}, play: play || null, playSub, playLinked }, now);
  const ctx = { active: Boolean(plan.active), extras: extras || [], pool, ...win };
  if (!win.slice) return ctx;
  const planBase = Math.max(0, (await account.plusCap(plan)) - aiExtraUsd(extras, now));
  const { tier } = await account.planTier(plan); // plans.js: today's Plus, the old $20, or one of PLANS_V2's six
  const P = sliceAt(win.ws, win.we, now);
  // When the plan last changed, from the store that sells tiers: Stripe's event time (s) or Apple's signed date (ms).
  const changedAt = Math.min(now, Math.max(stripe && stripe.updated ? Number(stripe.updated) * 1000 : 0, store && store.signed_date ? Number(store.signed_date) : 0)) || null;
  return { ...ctx, P, next: P.end < win.we ? sliceAt(win.ws, win.we, P.end) : null, changedAt, planBase, tier, bonusCap: bonusCapUsd(account.env, tier), bonus: pool ? await bonusSettings(account.env) : null, monthly: planBase };
}

/**
 * The account's v2 allowance now: { ctx, rec, avail } (avail null off the sliced path). Migrates
 * and advances the record, writing it only when it changed (`persist: false`: the caller writes it).
 */
export async function allowanceNow(account, plan, usage, caps, { persist = true } = {}) {
  const now = account.now();
  const prev = (await account.storage.get('allow2')) || null;
  if (!plan.active) {
    const pool = poolOn(account.env);
    if (prev && !prev.ended) {
      let rec = advance(prev, { active: false, renewing: await renewingOf(account, prev), pool }, now);
      if (persist) await account.storage.put('allow2', rec);
      if (persist && pool) rec = await poolSync(account, null, rec, now);
      return { ctx: null, rec, avail: null };
    }
    const rec = persist && pool && prev && prev.pool_out ? await poolSync(account, null, prev, now) : prev; // an outbox the pool hadn't acked yet
    return { ctx: null, rec, avail: null };
  }
  const ctx = await contextOf(account, plan, caps, now);
  if (!ctx.slice) return { ctx, rec: prev, avail: null };
  let rec = catchUp(prev ? advance(prev, ctx, now) : migrate(usage, ctx, now), ctx, now, usage, Boolean(prev));
  if (persist && JSON.stringify(rec) !== JSON.stringify(prev)) await account.storage.put('allow2', rec);
  if (persist && ctx.pool) rec = await poolSync(account, ctx, rec, now);
  return { ctx, rec, avail: available(rec, ctx, now) };
}

// ── the bonus pool's glue (only with plans.js poolOn: ALLOWANCE_V2, PLANS_V2 and the BONUS_POOL binding) ──

/** One op on the global BonusPool (bonus-pool.js): its JSON answer, or null when it failed. */
async function poolCall(env, op, body) {
  try {
    const ns = env.BONUS_POOL;
    const res = await ns.get(ns.idFromName('global')).fetch(`https://pool/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return res.ok ? await res.json() : null;
  } catch (error) {
    console.error('bonus pool', op, 'failed', error && error.message);
    return null;
  }
}

/**
 * Whether this period may claim its bonus now: a bonus plan, paid, live, not claimed for this period yet, and on
 * that plan from the period's start (no tier change inside it, and the store's last change no later than a day in):
 * an upgrade mid-period claims from the next period.
 */
const claimable = (ctx, rec, now) => Boolean(ctx && BONUS_TIERS.includes(ctx.tier) && rec && rec.paid && !rec.ended && now < rec.end && !(ctx.stale && now >= rec.end) && !(rec.bonus && rec.bonus.start === rec.start) && !rec.adj && !(Number(ctx.changedAt) > rec.start + DAY_MS));

/**
 * Sends the outbox (expired rollover, unspent bonus) and claims the period's bonus, then applies what
 * the pool acked to allow2 as it is NOW (re-read: a spend may have landed while the pool answered), so
 * nothing is ever lost or paid twice. A failure leaves the outbox (retried on the next read) and no bonus
 * on this read (claimed again while the period is live; the pool answers a repeat with the same amount).
 */
async function poolSync(account, ctx, rec, now) {
  const outbox = (rec && rec.pool_out) || [];
  const claim = claimable(ctx, rec, now);
  if (!outbox.length && !claim) return rec;
  const me = await account.storage.get('account');
  const hash = (await sha256Hex(`bonus-pool:${(me && me.id) || ''}`)).slice(0, 24);
  const acked = new Set();
  for (const e of outbox) {
    const out = await poolCall(account.env, 'contribute', { key: `${hash}:${e.key}`, usd: e.usd, kind: e.kind });
    if (out && out.ok) acked.add(e.key);
  }
  let granted = null;
  if (claim) {
    const out = await poolCall(account.env, 'claim', { key: `${hash}:${rec.sub || 'cal'}:${rec.start}`, tier: ctx.tier, weight: PRICE_USD[ctx.tier], cap_usd: round(ctx.bonusCap * rec.factor) });
    if (out && Number.isFinite(Number(out.usd))) granted = { start: rec.start, usd: round(Math.max(0, Number(out.usd))), spent: 0 };
  }
  const cur = await account.storage.get('allow2');
  if (!cur) return rec;
  const next = normal({
    ...cur,
    pool_out: (cur.pool_out || []).filter((e) => !acked.has(e.key)),
    ...(granted && cur.start === granted.start && !cur.ended && !(cur.bonus && cur.bonus.start === cur.start) ? { bonus: granted } : {}),
  });
  if (JSON.stringify(next) !== JSON.stringify(normal(cur))) await account.storage.put('allow2', next);
  return next;
}

/** Whether the plan the record belongs to was still renewing when it ended (a billing retry, not a cancel). */
async function renewingOf(account, rec) {
  const key = { app_store: 'plan', stripe: 'stripe_plan', google_play: 'play_plan' }[rec.src];
  const p = key ? await account.storage.get(key) : null;
  return Boolean(p && p.renews);
}

/**
 * What `usage` (v1's calendar month) gained since allow2's last write, charged to allow2: spends made
 * while the flag was off (on → off → on), or by a path that writes only `usage`. Same month as the
 * mirror: the difference; a later month: all of it (allow2 saw none of it). Then the mirror is `usage`.
 */
export function catchUp(rec, ctx, now, usage, known) {
  const u = { month: (usage && usage.month) || monthKey(now), spent: Number(usage && usage.spent) || 0 };
  let r = rec;
  if (known && r.usage_month) {
    const gained = u.month === r.usage_month ? u.spent - (Number(r.usage_spent) || 0) : u.spent;
    if (gained > 1e-9) r = charge(r, ctx, now, gained);
  }
  return normal({ ...r, usage_month: u.month, usage_spent: u.spent });
}

/** allow2 after spend() took `usd` into the allowance, with `usage` as just written beside it (account.js puts both at once; `state` from allowanceNow). */
export function chargeAllowance(state, usd, now, usage) {
  const r = charge(state.rec, state.ctx, now, usd);
  return usage ? normal({ ...r, usage_month: usage.month, usage_spent: usage.spent }) : r;
}

/** What allow-ai's answer adds on the plus bucket. */
export function allowFields(state) {
  const a = state.avail;
  return { budget: a.budget, week_left: a.weekLeft, week_end: a.week.end, period_left: a.periodLeft, period_spent: a.periodSpent, period_start: state.rec.start, period_end: state.rec.end };
}

const dayText = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** The refusal when the week (or the period) is used up and neither the trial nor credits are left. */
export function refusalFields(state) {
  const a = state.avail;
  const label = labelOf(state.ctx && state.ctx.tier); // "Plus", "Pro", "Eden Black"…; "AI allowance" kept (web/chat plan-model.js LIMIT_RE)
  let why;
  if (a.periodLeft > 0) why = `This week's ${label} AI allowance is used up. More arrives ${dayText(a.week.end)}, or add credits in Settings › Account.`;
  else if (a.pending) why = `This month's ${label} AI allowance is used up. It starts again once your renewal goes through, or add credits in Settings › Account.`;
  else why = `This month's ${label} AI allowance is used up. It starts again ${dayText(state.rec.end)}, or add credits in Settings › Account.`;
  return { why, week_end: a.week.end, period_end: state.rec.end };
}

/**
 * What view() puts in `usage` with the flag on (account.js): the period, the week, rollover and bonus; or only
 * `allowance`. budget_usd and left_usd include the bonus; bonus_usd is fixed at the period's start.
 */
export async function allowView(account, plan, usage, caps) {
  const state = await allowanceNow(account, plan, usage, caps);
  if (!state.avail) return { allowance: 'v2' };
  const { rec, ctx, avail: a } = state;
  const answer = answerUsd(account.env);
  return {
    period_start: rec.start,
    period_end: rec.end,
    spent_usd: a.periodSpent,
    budget_usd: a.budget,
    left_usd: a.periodLeft,
    plus_usd: a.C,
    allowance: 'v2',
    period_source: rec.src,
    week_start: a.week.start,
    week_end: a.week.end,
    week_number: a.week.j + 1,
    weeks_in_period: a.week.W,
    week_slice_usd: round(a.C / a.week.W),
    week_left_usd: a.weekLeft,
    answer_usd: answer,
    week_answers_left: Math.floor(a.weekLeft / answer + 1e-9),
    rollover_usd: rec.roll,
    rollover_left_usd: a.rollLeft,
    ...(rec.roll > 0 ? { rollover_expires: rec.end } : {}),
    bonus_max_pct: ctx.pool ? bonusPct(ctx.bonus, ctx.tier) : 0, // the owner's switches (bonus-pool.js)
    bonus_usd: a.bonusUsd,
    bonus_left_usd: a.bonusLeft,
    ...(a.pending ? { renewal_pending: true } : {}),
  };
}
