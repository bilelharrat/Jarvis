// Pay-as-you-go credits (the Account object's side): prepaid dollars bought in packs ($5, $10,
// $25: Stripe Checkout on the web, the App Store later), spent after the month's included AI
// (Plus) or the trial, at the provider's cost times a markup (MARKUP: Plus pays less). Each
// purchase is a lot that expires 12 months after it was bought; spending takes the oldest lot
// first (FIFO). Nothing here talks to Stripe but the auto top-up, through eden/billing.js.
//
//   credits        { customer, payment_method, lots: [{ id, usd, left, at, expires, source }] }
//                  `id` is the purchase's own id (a PaymentIntent, a Checkout Session, an App
//                  Store transaction): a purchase is added once, however often its event comes.
//   credit_auto    { enabled, threshold_usd, amount_usd, n, pending: { key, at } | null,
//                    last: { at, ok, why } | null }: "when the balance is under $2, add $10"
//                  with the card on file (an off-session PaymentIntent). `n` numbers the
//                  top-ups: the idempotency key of the next one is eden-topup-<account>-<n+1>, so
//                  a retry of the same top-up is never charged twice. A charge that needs the
//                  person (3-D Secure) or fails turns auto top-up off and says so.

import { ApiError } from './util.js';

export const MARKUP = { free: 1.4, plus: 1.25 };
export const PACKS = [5, 10, 25];
export const AUTO = { threshold: 2, amount: 10, retryMs: 3600_000 };
const MAX_LOTS = 200;
const round = (usd) => Math.round(usd * 1e6) / 1e6;

/** A purchase's expiry: 12 calendar months later (UTC). */
export function expiryOf(at) {
  const d = new Date(at);
  d.setUTCMonth(d.getUTCMonth() + 12);
  return d.getTime();
}

export const markupFor = (plan) => (plan && plan.active ? MARKUP.plus : MARKUP.free);

/** The user's price of `usd` of provider cost on credits. */
export const creditPrice = (usd, plan) => round(usd * markupFor(plan));

/** Dollars left on lots not yet expired. */
export function balanceOf(credits, now) {
  let usd = 0;
  for (const lot of (credits && credits.lots) || []) if (lot.expires > now) usd += lot.left;
  return round(usd);
}

/** Takes `usd` from the lots, the soonest to expire first; → { lots, taken }. Never below zero. */
export function takeFIFO(lots, usd, now) {
  let want = round(usd);
  const out = lots.map((l) => ({ ...l }));
  const live = out.filter((l) => l.expires > now && l.left > 0).sort((a, b) => a.expires - b.expires || a.at - b.at);
  for (const lot of live) {
    if (want <= 0) break;
    const take = Math.min(lot.left, want);
    lot.left = round(lot.left - take);
    want = round(want - take);
  }
  return { lots: out, taken: round(usd - Math.max(0, want)) };
}

export async function creditsOf(account) {
  return (await account.storage.get('credits')) || { customer: null, payment_method: null, lots: [] };
}

/**
 * Adds a purchase once (by its id) → { added, balance }. The hook for every channel: Stripe's
 * webhook (stripe-plan.js), the auto top-up, and the App Store's consumable purchases once the
 * iOS app sells packs (storekit.js would call this with the transaction id, source "app_store").
 */
export async function grantCredits(account, { id, usd, source, at = null, customer = null, payment_method = null }) {
  const amount = Number(usd);
  if (!id || !(amount > 0) || amount > 1000) throw new ApiError(400, 'bad_request', 'Not a credit purchase.');
  const now = account.now();
  const credits = await creditsOf(account);
  if (customer) credits.customer = customer;
  if (payment_method) credits.payment_method = payment_method;
  const added = !credits.lots.some((l) => l.id === id);
  if (added) {
    const when = Number(at) || now;
    credits.lots.push({ id: String(id), usd: round(amount), left: round(amount), at: when, expires: expiryOf(when), source: String(source || 'stripe') });
  }
  // Keep every lot that still counts, and the newest spent or expired ones for the history.
  if (credits.lots.length > MAX_LOTS) {
    const keep = credits.lots.filter((l) => l.expires > now && l.left > 0);
    const old = credits.lots.filter((l) => !(l.expires > now && l.left > 0)).sort((a, b) => b.at - a.at);
    credits.lots = [...keep, ...old.slice(0, Math.max(0, MAX_LOTS - keep.length))];
  }
  await account.storage.put('credits', credits);
  return { added, balance: balanceOf(credits, now) };
}

/** Spends `usd` (already at the user's price) from the credits → what was taken. */
export async function spendCredits(account, usd) {
  if (!(usd > 0)) return 0;
  const credits = await creditsOf(account);
  const { lots, taken } = takeFIFO(credits.lots, usd, account.now());
  credits.lots = lots;
  await account.storage.put('credits', credits);
  return taken;
}

export async function autoOf(account) {
  return (await account.storage.get('credit_auto')) || { enabled: false, threshold_usd: AUTO.threshold, amount_usd: AUTO.amount, n: 0, pending: null, last: null };
}

/** What the account page shows. */
export async function creditsView(account, plan) {
  const now = account.now();
  const credits = await creditsOf(account);
  const auto = await autoOf(account);
  const stripe = await account.storage.get('stripe_plan');
  const soonest = credits.lots.filter((l) => l.expires > now && l.left > 0).reduce((m, l) => Math.min(m, l.expires), Infinity);
  return {
    balance_usd: balanceOf(credits, now),
    markup: markupFor(plan),
    next_expiry: soonest === Infinity ? null : soonest,
    history: [...credits.lots].sort((a, b) => b.at - a.at).slice(0, 20).map((l) => ({ usd: l.usd, left: l.expires > now ? l.left : 0, at: l.at, expires: l.expires, source: l.source, expired: l.expires <= now })),
    auto_topup: {
      enabled: Boolean(auto.enabled),
      threshold_usd: auto.threshold_usd,
      amount_usd: auto.amount_usd,
      card_on_file: Boolean(credits.payment_method || (stripe && stripe.customer)),
      last: auto.last || null,
    },
  };
}

/** stripe-autotopup: turn it on or off (on needs a Stripe customer with a card). */
export async function setAutoTopUp(account, { enabled }) {
  const auto = await autoOf(account);
  if (enabled) {
    const credits = await creditsOf(account);
    const stripe = await account.storage.get('stripe_plan');
    if (!credits.payment_method && !(stripe && stripe.customer)) {
      throw new ApiError(409, 'no_card', 'Buy a credit pack first: its card is the one auto top-up uses.');
    }
  }
  auto.enabled = Boolean(enabled);
  if (enabled) auto.last = null;
  await account.storage.put('credit_auto', auto);
  return { enabled: auto.enabled };
}

/**
 * After a spend: below the threshold, with auto top-up on and none in flight, charge the card
 * once (`charge`: eden/billing.js chargeTopUp). Never two at once (`pending` is written before
 * the call), never twice for one top-up (its idempotency key), at most one try an hour while
 * Stripe's answer is unknown.
 */
export async function maybeTopUp(account, charge) {
  const auto = await autoOf(account);
  if (!auto.enabled) return { charged: false };
  const now = account.now();
  const credits = await creditsOf(account);
  if (balanceOf(credits, now) >= auto.threshold_usd) return { charged: false };
  if (auto.pending && now - auto.pending.at < AUTO.retryMs) return { charged: false, pending: true };
  const id = (await account.storage.get('account')).id;
  const stripe = await account.storage.get('stripe_plan');
  const customer = credits.customer || (stripe && stripe.customer) || null;
  if (!customer) {
    await account.storage.put('credit_auto', { ...auto, enabled: false, pending: null, last: { at: now, ok: false, why: 'No card on file. Buy a pack to add one.' } });
    return { charged: false };
  }
  const key = (auto.pending && auto.pending.key) || `eden-topup-${id}-${(auto.n || 0) + 1}`;
  await account.storage.put('credit_auto', { ...auto, pending: { key, at: now } });
  let result;
  try {
    result = await charge({ account: id, customer, payment_method: credits.payment_method || null, usd: auto.amount_usd, key });
  } catch (error) {
    console.error('auto top-up: Stripe didn’t answer', error && error.message);
    return { charged: false, pending: true }; // tried again within the hour, with the same key
  }
  return topUpOutcome(account, { key, ...result });
}

/**
 * What became of a top-up (the charge's answer, or a payment_intent.* webhook): `status`
 * "succeeded" adds the credits (once, by the PaymentIntent's id); "failed" (or "requires_action":
 * the bank wants the person there) turns auto top-up off and says why; anything else waits.
 */
export async function topUpOutcome(account, { key, status, id, usd, why }) {
  const auto = await autoOf(account);
  const now = account.now();
  const mine = auto.pending && auto.pending.key === key;
  if (status === 'succeeded') {
    const { added } = await grantCredits(account, { id, usd, source: 'auto_topup' });
    const next = await autoOf(account);
    if (mine) await account.storage.put('credit_auto', { ...next, n: (next.n || 0) + 1, pending: null, last: { at: now, ok: true, why: null } });
    return { charged: added };
  }
  if (status === 'failed' || status === 'requires_action') {
    const words = status === 'requires_action'
      ? 'Your bank asked to confirm the automatic top-up, so it didn’t go through. Auto top-up is off: buy a pack to continue, then turn it on again.'
      : `The automatic top-up didn’t go through${why ? ` (${String(why).slice(0, 120)})` : ''}. Auto top-up is off: buy a pack, then turn it on again.`;
    await account.storage.put('credit_auto', { ...auto, enabled: false, n: mine ? (auto.n || 0) + 1 : auto.n, pending: mine ? null : auto.pending, last: { at: now, ok: false, why: words } });
    return { charged: false, failed: true };
  }
  return { charged: false, pending: true };
}
