// Eden Plus bought in Eden for Android with Google Play Billing (askeden/android plus/PlusStore.kt):
// the Account object's side. The Worker (accounts/google-play.js) has read the subscription from the
// Google Play Developer API itself (purchases.subscriptionsv2.get), so what arrives here is Google's
// own word, never the app's. The App Store's plan (`plan`), Stripe's (`stripe_plan`) and a promo code's
// stay as they are; Google Play's is kept apart, and the account has Plus while any is active.
//
//   play_plan    { token, product_id, base_plan, state, expires (ms), renews, account, linked, test,
//                  order, fetched (ms: when the Worker read it from Google) }
//   play_claims  [SHA-256 hex of "googleplay:<purchase token>"]: the tokens this account claimed
//                (a code redeemed in the Play Store carries no account id), released when it's deleted
//
// Ops (account.js sends every `play-` op here):
//   play-subscription  the Eden app's web view session (never a grant's): { facts, claimed, claim_hash }
//                      → the account as /api/web/account shows it
//   play-notification  the Worker only (Real-time Developer Notifications): { facts, claimed } → {}

import { ApiError, EDEN_PLUS_PRODUCTS, json } from './util.js';

export const PLAY_PACKAGE = 'com.askeden.eden';
/** The same ids as the App Store's (two Play subscriptions, one base plan each). */
export const PLAY_PLUS_PRODUCTS = EDEN_PLUS_PRODUCTS;
export const PLAY_SUBSCRIPTIONS = 'https://play.google.com/store/account/subscriptions';
// An active subscription that renews keeps Plus a day past its period (the renewal's notification
// may come late), as Stripe's does. A grace period (a card that failed, Google retrying) keeps it
// while Google says so, at most this long past the period.
const RENEW_GRACE_MS = 86400_000;
const GRACE_MAX_MS = 30 * 86400_000;
const CLAIMS_KEPT = 50;

/** Whether Google Play's side gives Plus now. */
export function playActive(p, now) {
  if (!p || !p.token) return false;
  const expires = Number(p.expires) || 0;
  switch (p.state) {
    case 'SUBSCRIPTION_STATE_ACTIVE': return now < expires + (p.renews ? RENEW_GRACE_MS : 0);
    case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD': return now < expires + GRACE_MAX_MS;
    case 'SUBSCRIPTION_STATE_CANCELED': return now < expires; // cancelled: Plus until the period ends
    default: return false; // on hold, paused, expired (refunds and revocations end here), pending
  }
}

/** Play's own subscription page for this subscription. */
export const playManageUrl = (p) => `${PLAY_SUBSCRIPTIONS}?sku=${encodeURIComponent(p.product_id || '')}&package=${PLAY_PACKAGE}`;

/**
 * The plan combinePlans made (App Store, Stripe, promo) with Google Play's added: active while any
 * is; `source` "google_play" alone, "both" beside a paid App Store or Stripe subscription (a promo
 * code's free Plus doesn't count, as in combinePlans). `manage.google_play` says where it's managed.
 * `play`/`play_test`/`before_play` are for plusCap (account.js) only; view() never shows them.
 */
export function withPlayPlan(combined, play, now) {
  if (!play || !play.token) return combined;
  const live = playActive(play, now);
  const plan = { ...combined, manage: { ...(combined.manage || { app_store: null, stripe: null }), google_play: live ? playManageUrl(play) : null } };
  if (!live) return plan;
  const paidElsewhere = Boolean(combined.active) && combined.source !== 'promo';
  plan.before_play = { active: Boolean(combined.active), source: combined.source || null };
  plan.play = true;
  plan.play_test = Boolean(play.test);
  plan.active = true;
  plan.source = paidElsewhere ? 'both' : 'google_play';
  if (!paidElsewhere || (Number(play.expires) || 0) > (Number(combined.expires) || 0)) {
    plan.expires = Number(play.expires) || null;
    plan.renews = Boolean(play.renews) && play.state !== 'SUBSCRIPTION_STATE_CANCELED';
    plan.product_id = play.product_id;
    plan.environment = play.test ? 'Sandbox' : 'Production';
  }
  return plan;
}

/**
 * A month of Plus in dollars with Google Play's in it: today's allowance (it's sold at today's price),
 * a Sandbox-size one for a test purchase (license testers pay nothing), and whatever the other plans
 * give on their own (`inner`: account.js plusCap on the plan without Play's).
 */
export async function playCap(plan, caps, inner) {
  const { play, play_test: test, before_play: before = {}, ...rest } = plan;
  let cap = test ? caps.sandbox : caps.plus;
  const base = { ...rest, active: Boolean(before.active), source: before.source || null };
  if (base.active) cap = Math.max(cap, await inner(base));
  if (plan.unlimited) cap = Math.max(cap, caps.unlimited);
  return cap;
}

/** One subscription's facts from Google, for this account (or refused). */
async function applyPlay(account, { facts, claimed = false } = {}) {
  const me = await account.storage.get('account');
  if (!me) throw new ApiError(404, 'not_found', 'No such account.');
  if (!facts || typeof facts !== 'object' || typeof facts.token !== 'string' || !facts.token) throw new ApiError(400, 'bad_purchase', 'No purchase.');
  if (!PLAY_PLUS_PRODUCTS.includes(facts.product_id)) throw new ApiError(400, 'bad_purchase', 'That isn’t a Plus purchase.');
  // The account the app bought it for (BillingFlowParams.setObfuscatedAccountId), or, with none
  // (a code redeemed in the Play Store), the account that claimed its token first (google-play.js).
  if (facts.account ? String(facts.account).toLowerCase() !== me.id : claimed !== true) {
    throw new ApiError(403, 'forbidden', 'That purchase belongs to another Eden account.');
  }
  const now = account.now();
  const current = (await account.storage.get('play_plan')) || null;
  const next = {
    token: facts.token,
    product_id: facts.product_id,
    base_plan: facts.base_plan || null,
    state: String(facts.state || ''),
    expires: Number(facts.expires) || 0,
    renews: Boolean(facts.renews),
    account: facts.account || null,
    linked: facts.linked || null,
    test: Boolean(facts.test),
    order: facts.order || null,
    fetched: Number(facts.fetched) || now,
  };
  let take;
  if (!current || !current.token) take = true;
  else if (current.token === next.token) take = next.fetched >= (Number(current.fetched) || 0); // an older read of the same one changes nothing
  else if (next.linked && next.linked === current.token) take = true; // a plan change (monthly ↔ yearly) replaces the old token
  else if (!playActive(current, now)) take = true;
  else take = playActive(next, now) && next.expires >= (Number(current.expires) || 0); // an old subscription's late news doesn't replace a live one
  if (take) await account.storage.put('play_plan', next);
  if (next.test) console.warn('google play: a test purchase', next.product_id, 'on account', me.id);
  return { applied: take };
}

export async function playOp(account, op, request) {
  try {
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    if (op === 'play-notification') return json(await applyPlay(account, body)); // the Worker only, after Google's own answer
    if (op === 'play-subscription') {
      const device = await account.authenticate(request);
      if (device.grant) throw new ApiError(403, 'grant_forbidden', 'Only the account’s owner can buy or manage Plus.');
      await applyPlay(account, body);
      const hash = String(body.claim_hash || '');
      if (/^[0-9a-f]{64}$/.test(hash)) {
        const claims = (await account.storage.get('play_claims')) || [];
        if (!claims.includes(hash)) await account.storage.put('play_claims', [...claims, hash].slice(-CLAIMS_KEPT));
      }
      return json(await account.view(device));
    }
    throw new ApiError(404, 'not_found', 'No such thing.');
  } catch (error) {
    if (error instanceof ApiError) return error.response();
    throw error;
  }
}
