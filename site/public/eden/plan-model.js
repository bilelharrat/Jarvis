// Eden Plus in the page, the pure part (plan.js draws it): what askeden.com offers this account,
// from GET /api/web/account and /api/web/config. "Get Plus" (Stripe Checkout) only where the
// account page would offer it: billing on (config `billing`), and inside the Eden iOS app only
// with the server's `billing_in_app` (STRIPE_IN_EDEN_APP; Apple's in-app purchase rules). Not
// while acting for someone (a delegate, a team space): the plan isn't this browser's to buy.

/** What a turn refused for want of included AI says (site: accounts/account.js, eden/chat.js, eden/ask.js). */
export const LIMIT_RE = /included AI|trial of Jarvis AI|trial of Eden’s AI|AI allowance/i;

/** True when an error message is the included allowance running out. */
export const isLimitError = (message) => typeof message === 'string' && LIMIT_RE.test(message);

/**
 * { plus, upgrade, portal, price, yearly, credits, balance } or null (no account, or acting for
 * someone). upgrade: offer "Get Plus" here; portal: offer "Manage billing" (Stripe's Customer
 * Portal); yearly: the yearly price, if sold; credits: credit packs can be bought here (on Free
 * or Plus); balance: the credits left, in dollars.
 */
export function planOffer(account, config, inApp = false) {
  if (!account || typeof account !== 'object' || account.acting) return null;
  const plan = account.plan || {};
  const cfg = config || {};
  const plus = plan.active === true || plan.name === 'plus';
  const here = cfg.billing === true && (!inApp || cfg.billing_in_app === true);
  const manage = plan.manage || {};
  const price = account.plus && typeof account.plus.price_usd === 'number' ? account.plus.price_usd : null;
  const offer = account.plus || {};
  const yearly = typeof offer.yearly_usd === 'number' ? offer.yearly_usd : null;
  const credits = here && Array.isArray(offer.credit_packs) && offer.credit_packs.length > 0;
  const balance = account.credits && typeof account.credits.balance_usd === 'number' ? account.credits.balance_usd : 0;
  return { plus, upgrade: !plus && here, portal: plus && Boolean(manage.stripe) && (!inApp || cfg.billing_in_app === true), price, yearly, credits, balance };
}
