// Eden's six plans (owner's decisions A-F, 2026-11-13), behind PLANS_V2 = "on". Pure: no I/O.
//
//   plus2     the new Plus ($10 / $110 a year). Today's Plus ("plus": STRIPE_PRICE_PLUS, _YEARLY,
//             com.askeden.eden.plus.*, promo codes, Rewards months, Google Play) is closed to new
//             subscribers under PLANS_V2 but kept exactly as it is for everyone on it (decision A):
//             its allowance stays account.js allowances() (PLUS_BUDGET_USD, VOICE_DAILY_PLUS,
//             BROWSER_MINUTES_PLUS), never PLAN_CAPS.
//   pro, max, ultra, platinum, black ("Eden Black")
//
// Each plan's AI, Flash fallback, voice and browser caps come from the business-model workbook
// (research_notes/eden-business-model-2026-11-06, regenerated 2026-11-13): sized so that no plan
// loses money on a user who hits every cap, on any channel (web monthly/yearly, App Store at 15%),
// with ALLOWANCE_V2's billing-date periods and the full +20% bonus counted. PLAN_CAPS (JSON) may
// override any field. Flag off: nothing here is sold, but a paid tier is always honoured (the flag
// gates selling, not honouring), so a subscriber is never downgraded if the flag goes off.

import { EDEN_TIER_PRODUCTS } from './util.js';

const on = (v) => String(v || '').trim().toLowerCase() === 'on';
/** The plans switch: PLANS_V2 = "on". */
export const plansV2 = (env) => on(env && env.PLANS_V2);
/** The bonus pool runs only with ALLOWANCE_V2 (rollover exists), PLANS_V2 and the BONUS_POOL binding (bonus-pool.js). */
export const poolOn = (env) => Boolean(env && on(env.ALLOWANCE_V2) && plansV2(env) && env.BONUS_POOL);
/** The Eden Enterprise card and form: ENTERPRISE_CONTACT = "on". */
export const enterpriseOn = (env) => on(env && env.ENTERPRISE_CONTACT);

/** The plans sold under PLANS_V2, cheapest first. */
/** FLASH_FALLBACK: the Flash answers after a plan's AI runs out (not built yet; off until it is). */
export const flashOn = (env) => on(env && env.FLASH_FALLBACK);

export const TIERS = Object.freeze(['plus2', 'pro', 'max', 'ultra', 'platinum', 'black']);
export const isV2Tier = (tier) => TIERS.includes(tier);
/** What a person sees; every Plus cohort is "Plus". */
export const NAMES = Object.freeze({ plus: 'Plus', legacy: 'Plus', plus2: 'Plus', pro: 'Pro', max: 'Max', ultra: 'Ultra', platinum: 'Platinum', black: 'Eden Black', sandbox: 'Plus', unlimited: 'Unlimited', free: 'Free' });
export const labelOf = (tier) => NAMES[tier] || 'Plus';
/** Web list prices (USD): monthly (also the bonus weight) and yearly (one month free; today's Plus keeps $96). */
export const PRICE_USD = Object.freeze({ plus: 10, legacy: 20, plus2: 10, pro: 20, max: 50, ultra: 100, platinum: 200, black: 400 });
export const YEARLY_USD = Object.freeze({ plus: 96, plus2: 110, pro: 220, max: 550, ultra: 1100, platinum: 2200, black: 4400 });
/** The App Store prices the workbook set so Apple's 15% is covered (the owner creates them; StoreKit shows its own). */
export const APP_PRICE_USD = Object.freeze({ plus2: [10.99, 124.99], pro: [22.49, 249.99], max: [56.99, 629.99], ultra: [112.99, 1299.99], platinum: [229.99, 2599.99], black: [454.99, 5099.99] });
/** The plans whose subscribers get the bonus (decision D), and its cap: +20% of the plan's AI. */
export const BONUS_TIERS = Object.freeze(['ultra', 'platinum', 'black']);
export const BONUS_MAX_PCT = 20;
/** The owner's bonus switches (/admin, kept in the BonusPool object): on, the cap in % of the plan's AI, which plans. */
export const DEFAULT_BONUS = Object.freeze({ on: true, max_pct: BONUS_MAX_PCT, tiers: BONUS_TIERS });
export const BONUS_PCT_LIMIT = 50; // the most the owner may set: the pool still pays only from expired rollover
/** Settings as given, checked: anything missing or wrong falls back to the default. */
export function cleanBonus(s) {
  const v = s && typeof s === 'object' ? s : {};
  const pct = Number(v.max_pct);
  return {
    on: typeof v.on === 'boolean' ? v.on : DEFAULT_BONUS.on,
    max_pct: Number.isFinite(pct) && pct >= 0 && pct <= BONUS_PCT_LIMIT ? Math.round(pct * 10) / 10 : DEFAULT_BONUS.max_pct,
    tiers: Array.isArray(v.tiers) ? BONUS_TIERS.filter((t) => v.tiers.includes(t)) : [...DEFAULT_BONUS.tiers],
  };
}
/** The bonus a tier may get, in % of its plan's AI, under these settings (null: the defaults). */
export const bonusPct = (settings, tier) => {
  const s = settings ? cleanBonus(settings) : DEFAULT_BONUS;
  return s.on && s.tiers.includes(tier) ? s.max_pct : 0;
};

// The workbook's caps (eden-business-model.xlsx, 2026-11-13): ai_usd a month of provider cost;
// flash_day / flash_month answers and flash_usd the ceiling of the Flash fallback after the AI runs
// out; voice_day characters; browser_min minutes a month; answers and eves_strong the estimates the
// plan cards quote ("~N mixed answers or M EVES Strong a month").
export const PLAN_DEFAULTS = Object.freeze({
  plus2: Object.freeze({ ai_usd: 5, flash_day: 20, flash_month: 120, flash_usd: 2, voice_day: 20000, browser_min: 120, answers: 150, eves_strong: 10 }),
  pro: Object.freeze({ ai_usd: 10, flash_day: 40, flash_month: 250, flash_usd: 4, voice_day: 50000, browser_min: 300, answers: 300, eves_strong: 20 }),
  max: Object.freeze({ ai_usd: 28, flash_day: 85, flash_month: 510, flash_usd: 8, voice_day: 50000, browser_min: 300, answers: 830, eves_strong: 55 }),
  ultra: Object.freeze({ ai_usd: 49, flash_day: 150, flash_month: 900, flash_usd: 14, voice_day: 75000, browser_min: 600, answers: 1450, eves_strong: 95 }),
  platinum: Object.freeze({ ai_usd: 98, flash_day: 320, flash_month: 1930, flash_usd: 30, voice_day: 100000, browser_min: 900, answers: 2910, eves_strong: 195 }),
  black: Object.freeze({ ai_usd: 198, flash_day: 635, flash_month: 3800, flash_usd: 59, voice_day: 100000, browser_min: 1200, answers: 5880, eves_strong: 395 }),
});
const FIELDS = Object.keys(PLAN_DEFAULTS.pro);

let warnedCaps = false;
/** PLAN_CAPS as a table of overrides: a plain JSON object only; anything else is {} (and one warning). */
function overrides(env) {
  const raw = env && env.PLAN_CAPS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return {};
  let v;
  try {
    v = JSON.parse(String(raw));
  } catch {
    v = undefined;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    if (!warnedCaps) console.warn('PLAN_CAPS is not a JSON object; the workbook defaults apply');
    warnedCaps = true;
    return {};
  }
  return v;
}

/**
 * A v2 plan's caps: the workbook's, with PLAN_CAPS merged over them field by field (numbers ≥ 0
 * only). null for today's Plus, the old $20 Plus and anything else: those keep account.js allowances().
 */
export function planCaps(env, tier) {
  if (!isV2Tier(tier)) return null;
  const over = overrides(env)[tier];
  const out = { ...PLAN_DEFAULTS[tier] };
  if (over && typeof over === 'object' && !Array.isArray(over)) {
    for (const f of FIELDS) {
      const n = over[f];
      if (typeof n === 'number' && Number.isFinite(n)) out[f] = Math.max(0, n);
    }
  }
  return out;
}

/** The monthly bonus cap in dollars (before the period's pro-rata factor): +20% of the plan's AI; 0 off the bonus plans. */
export const bonusCapUsd = (env, tier) => (BONUS_TIERS.includes(tier) ? (planCaps(env, tier).ai_usd * BONUS_MAX_PCT) / 100 : 0);

// ── Stripe prices and App Store products → the tier ──

const priceList = (v) => String(v || '').split(/[\s,]+/).filter((p) => /^price_[A-Za-z0-9]{4,}$/.test(p));
const envKey = (tier) => `STRIPE_PRICE_${tier.toUpperCase()}`;
/** A v2 plan's Stripe prices: { monthly: [...], yearly: [...] } (the first of each is sold). */
export const tierPriceLists = (env, tier) => ({ monthly: priceList(env && env[envKey(tier)]), yearly: priceList(env && env[`${envKey(tier)}_YEARLY`]) });
/** The price sold for a v2 plan and interval, or null. */
export const tierPrice = (env, tier, yearly = false) => (isV2Tier(tier) ? tierPriceLists(env, tier)[yearly ? 'yearly' : 'monthly'][0] || null : null);
/** Every v2 plan price (both intervals): the webhook honours them as Plus. */
export const tierPricesAll = (env) => TIERS.flatMap((t) => { const l = tierPriceLists(env, t); return [...l.monthly, ...l.yearly]; });

/**
 * The tier a Stripe price is: the old $20 → "legacy"; today's Plus → "plus"; a v2 plan's → it; else
 * null. Worked out at read time from stripe_plan.price, so stored data never needs migrating.
 */
export function priceTier(env, price) {
  if (!price) return null;
  const e = env || {};
  if (priceList(e.STRIPE_PRICE_PLUS_LEGACY).includes(price)) return 'legacy';
  if (priceList(e.STRIPE_PRICE_PLUS).includes(price) || priceList(e.STRIPE_PRICE_PLUS_YEARLY).includes(price)) return 'plus';
  return TIERS.find((t) => { const l = tierPriceLists(e, t); return l.monthly.includes(price) || l.yearly.includes(price); }) || null;
}

const TIER_PRODUCT = /^com\.askeden\.eden\.(plus2|pro|max|ultra|platinum|black)\.(monthly|yearly)$/;
/** The tier an App Store product is: Eden's today's Plus → "plus", a v2 plan's → it, J.A.R.V.I.S.'s → "legacy", else null. */
export function productTier(id) {
  const s = String(id || '');
  if (s === 'com.askeden.eden.plus.monthly' || s === 'com.askeden.eden.plus.yearly') return 'plus';
  const m = TIER_PRODUCT.exec(s);
  if (m) return m[1];
  if (/^com\.askeden\.jarvis\./.test(s)) return 'legacy';
  return null;
}
export const tierProducts = (tier) => ({ monthly: `com.askeden.eden.${tier}.monthly`, yearly: `com.askeden.eden.${tier}.yearly` });

/** The higher of two tiers: the one with more AI a month (`aiOf(tier)` → dollars), the dearer on a tie. */
export function higherTier(a, b, aiOf) {
  if (!a) return b;
  if (!b) return a;
  const da = aiOf(a);
  const db = aiOf(b);
  if (da !== db) return da > db ? a : b;
  return (PRICE_USD[a] || 0) >= (PRICE_USD[b] || 0) ? a : b;
}

// ── /api/web/config ──

/**
 * What /api/web/config adds, only for the flags that are on (off: no key at all, so the config is
 * byte-identical): `plans` (PLANS_V2), `rollover` (ALLOWANCE_V2), `enterprise_contact` (ENTERPRISE_CONTACT).
 * Every v2 plan is listed so the iPhone app can match its StoreKit products; the web offers only
 * `web: true` ones (a monthly Stripe price is set) and the yearly button only with `yearly_usd`.
 */
export function plansConfig(env, bonus = null) {
  const out = {};
  if (plansV2(env)) {
    out.plans = TIERS.map((tier) => {
      const c = planCaps(env, tier);
      return {
        tier,
        name: labelOf(tier),
        price_usd: PRICE_USD[tier],
        yearly_usd: tierPrice(env, tier, true) ? YEARLY_USD[tier] : null,
        web: Boolean(tierPrice(env, tier, false)),
        ai_usd: c.ai_usd,
        answers: Math.round(c.answers),
        eves_strong: Math.round(c.eves_strong),
        // The Flash fallback after the AI runs out isn't built yet: promised only once FLASH_FALLBACK is on.
        flash_day: flashOn(env) ? Math.round(c.flash_day) : 0,
        flash_month: flashOn(env) ? Math.round(c.flash_month) : 0,
        voice_day: Math.round(c.voice_day),
        browser_min: Math.round(c.browser_min),
        bonus_max_pct: poolOn(env) ? bonusPct(bonus, tier) : 0, // the owner's settings (/admin) when given
        app_products: tierProducts(tier),
      };
    });
  }
  if (on(env && env.ALLOWANCE_V2)) out.rollover = true;
  if (enterpriseOn(env)) out.enterprise_contact = true;
  return out;
}
