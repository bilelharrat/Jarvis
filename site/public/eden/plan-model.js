// Eden Plus in the page, the pure part (plan.js draws it): what askeden.com offers this account,
// from GET /api/web/account and /api/web/config. "Get Plus" (Stripe Checkout) only where the
// account page would offer it: billing on (config `billing`), and inside the Eden iOS app only
// with the server's `billing_in_app` (STRIPE_IN_EDEN_APP; Apple's in-app purchase rules). Not
// while acting for someone (a delegate, a team space): the plan isn't this browser's to buy.

/** What a turn refused for want of included AI says (site: accounts/account.js, eden/chat.js, eden/ask.js). */
export const LIMIT_RE = /included AI|trial of (?:Eden Secretary|Jarvis) AI|trial of Eden’s AI|AI allowance/i;

/** True when an error message is the included allowance running out. */
export const isLimitError = (message) => typeof message === 'string' && LIMIT_RE.test(message);

/**
 * { plus, upgrade, portal, price, yearly, credits, balance } or null (no account, or acting for
 * someone). upgrade: offer "Get Plus" here; portal: offer "Manage billing" (Stripe's Customer
 * Portal); yearly: the yearly price, if sold; credits: credit packs can be bought here (on Free
 * or Plus); balance: the credits left, in dollars. linkOut: inside the app, beside Apple's
 * products, offer askeden.com's Checkout in Safari too: only for an App Store storefront the
 * server lists (config `billing_link_out`, STRIPE_US_LINKOUT: the US) that the app reported.
 */
export function planOffer(account, config, inApp = false, appSells = false, storefront = null) {
  if (!account || typeof account !== 'object' || account.acting) return null;
  const plan = account.plan || {};
  const cfg = config || {};
  const plus = plan.active === true || plan.name === 'plus';
  const here = cfg.billing === true && (!inApp || cfg.billing_in_app === true);
  const manage = plan.manage || {};
  // Inside the app that sells Plus with Apple (caps.plus): Upgrade opens the in-app Plan section (Apple's
  // products), never a web price (3.1.1; R3C-5/6), and credits are neither sold nor mentioned (R3C-7).
  const apple = inApp && appSells;
  const linkOut = apple && cfg.billing === true && storefront === 'USA' && Array.isArray(cfg.billing_link_out) && cfg.billing_link_out.includes(storefront);
  const price = apple ? null : account.plus && typeof account.plus.price_usd === 'number' ? account.plus.price_usd : null;
  const offer = account.plus || {};
  const yearly = !apple && typeof offer.yearly_usd === 'number' ? offer.yearly_usd : null;
  const credits = !inApp && here && Array.isArray(offer.credit_packs) && offer.credit_packs.length > 0;
  const balance = !inApp && account.credits && typeof account.credits.balance_usd === 'number' ? account.credits.balance_usd : 0;
  const label = plus && typeof plan.label === 'string' && plan.label.trim() ? { label: plan.label.trim() } : {}; // PLANS_V2 only: 'Pro', 'Eden Black'…
  return { plus, upgrade: !plus && (here || apple), portal: plus && Boolean(manage.stripe) && (linkOut || (!apple && (!inApp || cfg.billing_in_app === true))), price, yearly, credits, balance, linkOut: !plus && linkOut, ...label };
}

/* ---------- the six plans (askeden.com's PLANS_V2, owner 2026-11-13; site accounts/plans.js) ----------
   GET /api/web/config lists them in `plans` only with the flag on: [{ tier, name, price_usd, yearly_usd,
   web (a monthly Stripe price is set), ai_usd, answers, eves_strong, flash_day, flash_month, voice_day,
   browser_min, bonus_max_pct, app_products }]. Without it everything here is empty and the page is today's.
   'plus2' is the new Plus (named "Plus"); today's Plus ('plus': com.askeden.eden.plus.*, today's Stripe prices)
   is kept for everyone on it but closed to new subscribers while the plans are on (owner's decision A). */

/** The plans sold under PLANS_V2, cheapest first. */
export const TIERS = ['plus2', 'pro', 'max', 'ultra', 'platinum', 'black'];

/** The tier of an Eden App Store product id: today's Plus → 'plus', 'com.askeden.eden.pro.yearly' → 'pro', else null. */
export function productTier(id) {
  const s = String(id || '');
  if (s === 'com.askeden.eden.plus.monthly' || s === 'com.askeden.eden.plus.yearly') return 'plus';
  const m = /^com\.askeden\.eden\.(plus2|pro|max|ultra|platinum|black)\.(monthly|yearly)$/.exec(s);
  return m ? m[1] : null;
}

const count = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0;

/** config.plans, checked: known tiers with a name and a monthly price, once each, cheapest first; [] with the flag off. */
export function serverPlans(config) {
  const list = config && Array.isArray(config.plans) ? config.plans : [];
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (!p || typeof p !== 'object' || !TIERS.includes(p.tier) || seen.has(p.tier)) continue;
    if (typeof p.name !== 'string' || !p.name.trim() || !count(p.price_usd)) continue;
    seen.add(p.tier);
    out.push(p);
  }
  return out.sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier));
}

/** The plans sold on the web: only those with a monthly Stripe price (`web: true`); the rest are App Store only. */
export const webPlans = (config) => serverPlans(config).filter((p) => p.web === true);

/**
 * Whether the iPhone app shows a StoreKit product. Flag off (no plans listed): every product but the new
 * plans', so today's Plus exactly as today. Flag on: only the listed plans' products (today's Plus is
 * closed to new subscribers; its subscribers manage it in Manage Subscription).
 */
export function appShowsProduct(id, config) {
  const listed = serverPlans(config);
  const tier = productTier(id);
  if (!listed.length) return !TIERS.includes(tier);
  return listed.some((p) => p.tier === tier);
}

/** The plan's name as the server gives it (`plan.label`: 'Pro', 'Eden Black'), else 'Plus'. */
export const planLabel = (plan) => (plan && typeof plan.label === 'string' && plan.label.trim() ? plan.label.trim() : 'Plus');

/** 'Plus' → 'Eden Plus', 'Eden Black' stays. */
export const edenName = (label) => (/^Eden\b/.test(label) ? label : `Eden ${label}`);

/** Eden Enterprise's card: with the server's ENTERPRISE_CONTACT, and never in the iPhone app (App Store 3.1.x). */
export const enterpriseOffered = (config, inApp = false) => !inApp && Boolean(config) && config.enterprise_contact === true;

/** The exact rollover sentence (owner, 2026-11-13: "wherever rollover shows"). */
export const ROLLOVER_LINE = 'Unused AI carries over one month, then expires.';

/** "Ultra Bonus: up to +20% AI": never a word on where the bonus comes from (owner, 2026-11-13). */
export const bonusLine = (name, pct) => `${name} Bonus: up to +${Math.round(Number(pct) * 10) / 10}% AI`;

/**
 * A plan's lines, as the plan list and the App Store block show them. `n` writes a count in the page's
 * language; `rollover` is config.rollover (ALLOWANCE_V2). Lines with a missing or zero number are left out.
 */
export function planLines(p, { rollover = false, n = (x) => String(x) } = {}) {
  const lines = [];
  if (count(p.answers)) lines.push(count(p.eves_strong) ? `~${n(p.answers)} answers or ${n(p.eves_strong)} EVES Strong a month` : `~${n(p.answers)} answers a month`);
  if (count(p.flash_day)) lines.push(`Then up to ${n(p.flash_day)} Flash answers a day`);
  if (count(p.browser_min)) lines.push(`${n(p.browser_min)} minutes of the cloud browser a month`);
  if (count(p.voice_day)) lines.push(`${n(p.voice_day)} characters of Eden Secretary voice a day`);
  if (count(p.bonus_max_pct)) lines.push(bonusLine(p.name, p.bonus_max_pct));
  if (rollover === true) lines.push(ROLLOVER_LINE);
  return lines;
}
