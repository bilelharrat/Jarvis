// Plus bought on the web with Stripe (ROADMAP F15; docs/accounts.md "Billing on the web"): the
// Account object's side. The App Store's plan stays in `plan` (account.js applyTransaction,
// unchanged); Stripe's is kept apart, and the account has Plus while either is active, until
// the later of the two ends. The included AI doesn't care which one paid. Nothing here talks to
// Stripe: the Worker (eden/billing.js) makes the Checkout and portal sessions and checks each
// webhook's signature, then hands its facts here.
//
//   stripe_plan     { customer, subscription, status, price, period_end (ms), renews, livemode,
//                     past_due_since (ms) | null, payment_failed_at (ms) | null, updated (the
//                     newest applied event's `created`, s) }
//   stripe_pending  { key, expires_at (s), origin }: the open Checkout's idempotency key, so a
//                   second "Get Plus" while it's open gets the same session, not a second one
//   stripe_seen     [[event id, ms], …]: events already applied (SEEN.max at most, SEEN.days)
//
// Ops (account.js sends every `stripe-` op here):
//   stripe-checkout   a device of the account (never a grant's): may it start a Checkout?
//                     → { account_id, key, expires_at, customer }; 409 already_plus
//   stripe-portal     the same device: → { customer }; 404 no_billing
//   stripe-event      the Worker only, after the signature checked: apply one event, once

import { ApiError, hex, json, randomBytes } from './util.js';

export const APP_STORE_SUBSCRIPTIONS = 'https://apps.apple.com/account/subscriptions';
const LIVE = new Set(['active', 'trialing']);
const TERMINAL = new Set(['canceled', 'incomplete_expired']);
// A renewal's webhook may come a little late: an active subscription that renews keeps Plus a
// day past its period. A failed payment (past_due) keeps it 3 days while Stripe retries.
const RENEW_GRACE_MS = 86400_000;
export const PAST_DUE_GRACE_MS = 3 * 86400_000;
// A Checkout Session lasts an hour (Stripe: 30 minutes at least); "Get Plus" again within the
// first half of it gets the same one.
export const CHECKOUT = { minutes: 60, reuseMinutes: 29 };
export const SEEN = { max: 100, days: 30 };

/** Whether Stripe's side gives Plus now. */
export function stripeActive(p, now) {
  if (!p || !p.subscription) return false;
  if (LIVE.has(p.status)) return now < (Number(p.period_end) || 0) + (p.renews ? RENEW_GRACE_MS : 0);
  if (p.status === 'past_due') return now < (Number(p.past_due_since) || 0) + PAST_DUE_GRACE_MS && now < (Number(p.period_end) || 0) + RENEW_GRACE_MS;
  return false;
}

/**
 * The account's plan: the App Store's record (`store`, as account.js keeps it) and Stripe's,
 * together. Active while either is; `expires`, `renews` and `environment` are the later one's.
 * `source`: "app_store" | "stripe" | "both" | null; `manage`: where each is managed.
 */
export function combinePlans(store, stripe, now) {
  const apple = Boolean(store.expires && store.expires > now && !store.revoked);
  const web = stripeActive(stripe, now);
  const plan = { ...store, active: apple || web };
  plan.source = apple && web ? 'both' : apple ? 'app_store' : web ? 'stripe' : null;
  const webExpires = Number(stripe && stripe.period_end) || 0;
  // Stripe's end is the later one (or the only one): its expiry, renewal and environment show.
  const stripeLater = stripe && stripe.subscription && (web ? !apple || webExpires > store.expires : !apple && webExpires > (Number(store.expires) || 0));
  if (stripeLater) {
    plan.expires = webExpires || null;
    plan.renews = web ? Boolean(stripe.renews) : false;
    plan.environment = stripe.livemode ? 'Production' : 'Sandbox';
    if (!apple) plan.product_id = null;
  }
  const fixable = stripe && ['past_due', 'unpaid', 'incomplete'].includes(stripe.status);
  plan.manage = {
    app_store: apple ? APP_STORE_SUBSCRIPTIONS : null,
    stripe: stripe && stripe.customer && (web || fixable) ? 'portal' : null,
  };
  plan.payment_failed = Boolean(stripe && (fixable || (stripe.payment_failed_at && LIVE.has(stripe.status))));
  return plan;
}

/** What view() adds to the plan it shows (account.js). */
export function planSource(plan) {
  return {
    source: plan.source || null,
    manage: plan.manage || { app_store: null, stripe: null },
    ...(plan.payment_failed ? { payment_failed: true } : {}),
  };
}

/** The Stripe subscription to cancel when the account is deleted (eden/billing.js does), or null. */
export async function stripeToCancel(account) {
  const p = await account.storage.get('stripe_plan');
  return p && p.subscription && !TERMINAL.has(p.status) ? p.subscription : null;
}

export async function stripeOp(account, op, request) {
  try {
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    if (op === 'stripe-event') return json(await applyEvent(account, body));
    // A grant's device (a delegate, a space member) never gets here: authenticate's grantGuard
    // refuses every op it doesn't list. Checked again, so it stays true if that list grows.
    const device = await account.authenticate(request);
    if (device.grant) throw new ApiError(403, 'grant_forbidden', 'Only the account’s owner can buy or manage Plus.');
    if (op === 'stripe-checkout') return json(await checkoutBegin(account, body));
    if (op === 'stripe-portal') return json(await portalBegin(account));
    throw new ApiError(404, 'not_found', 'No such thing.');
  } catch (error) {
    if (error instanceof ApiError) return error.response();
    throw error;
  }
}

async function checkoutBegin(account, { origin }) {
  const plan = await account.planNow();
  if (plan.active) {
    throw new ApiError(409, 'already_plus', plan.source === 'stripe'
      ? 'You already have Plus, billed on askeden.com. Use Manage billing to change it.'
      : 'You already have Plus through the App Store. Manage it in the App Store (Settings › your name › Subscriptions).');
  }
  const now = account.now();
  const from = String(origin || '').slice(0, 200);
  let pending = await account.storage.get('stripe_pending');
  if (!pending || pending.origin !== from || pending.expires_at * 1000 - now < (CHECKOUT.minutes - CHECKOUT.reuseMinutes) * 60_000) {
    pending = { key: hex(randomBytes(16)), expires_at: Math.floor(now / 1000) + CHECKOUT.minutes * 60, origin: from };
    await account.storage.put('stripe_pending', pending);
  }
  const stripe = await account.storage.get('stripe_plan');
  return { account_id: (await account.storage.get('account')).id, key: pending.key, expires_at: pending.expires_at, customer: (stripe && stripe.customer) || null };
}

async function portalBegin(account) {
  const stripe = await account.storage.get('stripe_plan');
  if (!stripe || !stripe.customer) throw new ApiError(404, 'no_billing', 'This account has no billing on askeden.com.');
  return { customer: stripe.customer };
}

// ── events (the Worker has checked the signature, the price and the account) ──

/**
 * One event's facts: { id, type, created (s), livemode, customer?, subscription?: { id, status,
 * customer, price, period_end, renews, plus }, invoice?: { subscription } }. Applied once
 * (stripe_seen), in order per subscription (`created`), never to an account that's gone.
 */
async function applyEvent(account, facts) {
  const storage = account.storage;
  if (!(await storage.get('account'))) throw new ApiError(404, 'not_found', 'No such account.');
  const id = String(facts.id || '');
  if (!/^evt_[A-Za-z0-9_]{1,250}$/.test(id)) throw new ApiError(400, 'bad_request', 'No event id.');
  const now = account.now();
  let seen = ((await storage.get('stripe_seen')) || []).filter(([, at]) => now - at < SEEN.days * 86400_000);
  if (seen.some(([e]) => e === id)) return { duplicate: true, applied: false };
  const before = (await storage.get('stripe_plan')) || null;
  let after = before;
  if (facts.subscription) after = takeSubscription(before, facts);
  else if (facts.invoice && before && before.subscription && before.subscription === facts.invoice.subscription) {
    after = { ...before, payment_failed_at: Number(facts.created) * 1000 || now };
  }
  seen.push([id, now]);
  if (seen.length > SEEN.max) seen = seen.slice(-SEEN.max);
  const write = { stripe_seen: seen };
  if (after && after !== before) write.stripe_plan = after;
  await storage.put(write);
  // A Checkout that finished isn't open any more: the next "Get Plus" (after a cancel) is a new one.
  if (facts.type === 'checkout.session.completed') await storage.delete('stripe_pending');
  return { duplicate: false, applied: after !== before };
}

function takeSubscription(plan, facts) {
  const s = facts.subscription;
  const created = Number(facts.created) || 0;
  const same = Boolean(plan && plan.subscription === s.id);
  if (same) {
    if (TERMINAL.has(plan.status)) return plan; // Stripe never brings a canceled subscription back
    if (!facts.fresh && created < (plan.updated || 0)) return plan; // older than what's here already
  } else {
    if (!s.plus) return plan; // not a Plus subscription: never taken on
    // Another subscription: an old one's late news doesn't replace a live one.
    if (plan && plan.subscription && (LIVE.has(plan.status) || plan.status === 'past_due') && !LIVE.has(s.status)) return plan;
    if (plan && plan.subscription && LIVE.has(plan.status) && LIVE.has(s.status)) {
      console.warn('stripe: a second live Plus subscription', s.id, 'beside', plan.subscription);
      if ((Number(s.period_end) || 0) <= (Number(plan.period_end) || 0)) return plan;
    }
  }
  const pastDue = s.status === 'past_due';
  return {
    customer: s.customer || facts.customer || (plan && plan.customer) || null,
    subscription: s.id,
    status: s.status,
    price: s.price || null,
    period_end: Number(s.period_end) || 0,
    renews: Boolean(s.renews),
    livemode: Boolean(facts.livemode),
    past_due_since: pastDue ? (same && plan.past_due_since) || created * 1000 || null : null,
    // A failed payment shows until Stripe says the subscription is paid up again.
    payment_failed_at: same && plan.payment_failed_at && !(s.status === 'active' && created * 1000 > plan.payment_failed_at) ? plan.payment_failed_at : null,
    updated: Math.max(created, same ? plan.updated || 0 : 0),
  };
}
