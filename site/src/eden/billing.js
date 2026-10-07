// Plus on the web, with Stripe (ROADMAP F15; docs/web-auth.md "Billing on the web (Stripe)"),
// beside the App Store purchase in the J.A.R.V.I.S. iPhone app, never instead of it:
//
//   POST /api/web/billing/checkout   the signed-in browser's own account (not while acting for
//                                    someone) → { url }: a Stripe Checkout Session for a
//                                    subscription to STRIPE_PRICE_PLUS. 409 already_plus when the
//                                    account has Plus from either the App Store or Stripe.
//                                    { plan: "yearly" } STRIPE_PRICE_PLUS_YEARLY instead.
//   POST /api/web/billing/credits    { pack: 5 | 10 | 25 } → { url }: a one-time Checkout (mode
//                                    payment) for a credit pack, STRIPE_PRICE_CREDITS_<pack>; the
//                                    card is saved for auto top-up (setup_future_usage)
//   POST /api/web/billing/autotopup  { enabled } → the credits: auto top-up on or off
//   POST /api/web/billing/portal     → { url }: a Stripe Customer Portal session (cancel, card)
//   GET  /api/web/billing/return     where Stripe sends the browser back: a small page of ours
//                                    that moves on to #account (see billingReturn)
//   POST /api/stripe/webhook         Stripe's events, checked by their signature (no Origin, no
//                                    session), set the account's Stripe plan
//
// The account keeps the two plans apart (accounts/stripe-plan.js) and has Plus while either is
// active. Stripe is reached over its REST API with fetch, form-encoded; no SDK, no key in any
// log. Test mode first: a live key (sk_live_…, rk_live_…) is refused unless STRIPE_LIVE = "1".
// Billing is off (config `billing: false`, the page hides it) until STRIPE_SECRET_KEY,
// STRIPE_WEBHOOK_SECRET and STRIPE_PRICE_PLUS are all set: without the webhook a payment would
// never reach the plan.
//
// Dev and tests only: STRIPE_API_BASE points the module at a fake Stripe on this machine
// (loopback only, test keys only); anything else turns billing off.

import { call, limited } from '../accounts/index.js';
import { AUTO, PACKS } from '../accounts/credits.js';
import { legacyPrices, legacyPrice } from '../accounts/stripe-plan.js';
import { ApiError, hex, json, sameText, validAccountId } from '../accounts/util.js';
import { SIGNIN_CSP, page } from './web.js';

// What the prices charge, for the buttons. Change them with the prices in Stripe.
//   STRIPE_PRICE_PLUS          today's Plus, $10/month ($6 of AI a month); more ids after commas
//                              are honoured too. The first is sold.
//   STRIPE_PRICE_PLUS_LEGACY   the old $20/month ($20 of AI): honoured, never sold, unless it is
//                              STRIPE_PRICE_PLUS's first (before today's price exists)
//   STRIPE_PRICE_PLUS_YEARLY   $96/year ($6 of AI a month); empty: no yearly option
//   STRIPE_PRICE_CREDITS_5/_10/_25   one-time credit packs; an empty one isn't offered
export const PLUS_PRICE_USD = 10;
export const PLUS_LEGACY_PRICE_USD = 20;
export const PLUS_YEARLY_PRICE_USD = 96;
const STRIPE = 'https://api.stripe.com';
export const SIGNATURE_TOLERANCE_S = 300; // a webhook signed more than 5 minutes ago (or ahead) is refused
const WEBHOOK_BYTES = 1 << 20;
const KEY = /^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// ── configuration ──

/** The Stripe secrets as pasted into `wrangler secret put`, without stray spaces or line breaks. */
const stripeKey = (env) => String(env.STRIPE_SECRET_KEY || '').trim();
const webhookSecret = (env) => String(env.STRIPE_WEBHOOK_SECRET || '').trim();

const priceList = (v) => String(v || '').split(/[\s,]+/).filter((p) => /^price_[A-Za-z0-9]{4,}$/.test(p));
/** The price ids STRIPE_PRICE_PLUS lists (commas): the first for new subscriptions. */
const prices = (env) => priceList(env.STRIPE_PRICE_PLUS);
const yearlyPrice = (env) => priceList(env.STRIPE_PRICE_PLUS_YEARLY)[0] || null;
/** Every Plus price a subscription may have: today's, the yearly and the grandfathered. */
const honoured = (env) => [...prices(env), ...priceList(env.STRIPE_PRICE_PLUS_YEARLY), ...legacyPrices(env)];
/** The credit packs whose price is set: { 5: price_…, … }. */
export function packPrices(env) {
  const out = {};
  for (const pack of PACKS) {
    const id = priceList(env[`STRIPE_PRICE_CREDITS_${pack}`])[0];
    if (id) out[pack] = id;
  }
  return out;
}

/** Why billing is off here, or null when it's on. */
export function billingProblem(env) {
  const key = stripeKey(env);
  if (!KEY.test(key)) return /^pk_/.test(key) ? 'STRIPE_SECRET_KEY is a publishable key (pk_), not the secret key' : key ? 'STRIPE_SECRET_KEY doesn\'t look like sk_test_… or rk_…' : 'no STRIPE_SECRET_KEY';
  if (/^(sk|rk)_live_/.test(key) && String(env.STRIPE_LIVE || '') !== '1') return 'a live key without STRIPE_LIVE = "1"';
  if (!/^whsec_[A-Za-z0-9+/=_-]{8,}$/.test(webhookSecret(env))) return /^pk_/.test(stripeKey(env)) ? 'STRIPE_SECRET_KEY is a publishable key (pk_), not the secret key' : 'no STRIPE_WEBHOOK_SECRET';
  if (!prices(env).length) return 'no STRIPE_PRICE_PLUS';
  if (env.STRIPE_API_BASE && !fakeBase(env)) return 'STRIPE_API_BASE is not a loopback address (dev and tests only)';
  return null;
}

export const billingReady = (env) => !billingProblem(env);

/** /api/web/config's part: buy Plus on the web; and inside the Eden iOS app too (the owner's flag). */
export function billingConfig(env) {
  const on = billingReady(env);
  // Off: which check failed, in words (never a value), so the owner can see why without reading secrets.
  return { billing: on, billing_in_app: on && String(env.STRIPE_IN_EDEN_APP || '') === '1', ...(on || !(env.STRIPE_SECRET_KEY || env.STRIPE_WEBHOOK_SECRET) ? {} : { billing_off: billingProblem(env) }) };
}

/** GET /api/web/account's `plus`: how Plus is bought. */
export function plusOffer(env) {
  if (!billingReady(env)) return { web_purchase: false, how: 'ios' };
  const legacy = legacyPrice(env, prices(env)[0]); // today's price not created yet: the old one is sold
  const packs = Object.keys(packPrices(env)).map(Number);
  return {
    web_purchase: true,
    how: 'stripe',
    price_usd: legacy ? PLUS_LEGACY_PRICE_USD : PLUS_PRICE_USD,
    yearly_usd: yearlyPrice(env) ? PLUS_YEARLY_PRICE_USD : null,
    credit_packs: packs,
    auto_topup: packs.includes(AUTO.amount),
  };
}

// A fake Stripe for dev and tests: loopback, and never with a live key.
function fakeBase(env) {
  let url;
  try {
    url = new URL(String(env.STRIPE_API_BASE));
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK.has(url.hostname)) return null;
  return /^(sk|rk)_test_/.test(stripeKey(env)) ? url.origin : null;
}

const apiBase = (env) => (env.STRIPE_API_BASE ? fakeBase(env) : null) || STRIPE;

// ── Stripe's REST API ──

/** Stripe's form encoding: nested objects and arrays as a[b][0][c]=…; null and undefined left out. */
export function stripeForm(params, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    const name = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') stripeForm(v, name, out);
    else out.append(name, String(v));
  }
  return out;
}

async function stripe(env, method, path, params = null, { idempotency = null, raw = false } = {}) {
  const headers = { authorization: `Bearer ${stripeKey(env)}` };
  if (idempotency) headers['idempotency-key'] = idempotency;
  const init = { method, headers };
  if (params) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    init.body = stripeForm(params).toString();
  }
  let response;
  try {
    response = await fetch(`${apiBase(env)}/v1${path}`, init);
  } catch {
    throw new ApiError(502, 'stripe', 'Stripe didn’t answer. Try again in a moment.');
  }
  const out = await response.json().catch(() => ({}));
  if (raw) return { ok: response.ok, status: response.status, body: out };
  if (!response.ok) {
    const e = out.error || {};
    console.error('stripe refused', method, path.replace(/\/(sub|cus|cs|pi)_[A-Za-z0-9]+/, '/$1_…'), response.status, e.type || '', e.code || '');
    throw new ApiError(502, 'stripe', 'Stripe said no. Try again in a moment.');
  }
  return out;
}

/** An address Stripe sent back for the browser to open: Stripe's own, or the fake's in dev. */
function stripePage(env, url, host) {
  const text = String(url || '');
  const fake = env.STRIPE_API_BASE ? fakeBase(env) : null;
  return text.startsWith(`https://${host}/`) || Boolean(fake && text.startsWith(`${fake}/`));
}

/** Cancels a subscription at once (the account was deleted): best effort, never throws. */
export async function cancelSubscription(env, subscription) {
  if (!subscription || !KEY.test(stripeKey(env))) return false;
  try {
    await stripe(env, 'DELETE', `/subscriptions/${encodeURIComponent(subscription)}`, null, { idempotency: `eden-cancel-${subscription}` });
    return true;
  } catch (error) {
    console.error('stripe: cancelling a deleted account’s subscription failed', error && error.message);
    return false;
  }
}

// ── /api/web/billing/<op> (eden/session.js: the browser's own session, checked fresh) ──

export async function billingApi(request, env, who, op, { acting = null, origin = '' } = {}) {
  if (request.method !== 'POST' || !['checkout', 'portal', 'credits', 'autotopup'].includes(op)) throw new ApiError(404, 'not_found', 'No such thing here.');
  if (!billingReady(env)) throw new ApiError(503, 'not_set_up', 'Buying Plus on the web isn’t set up here yet. Get it in the J.A.R.V.I.S. iPhone app.');
  if (acting) throw new ApiError(409, 'acting', 'You’re using someone else’s Eden right now. Switch back to your own account first.');
  await limited(env, 'EDEN_RATE', `billing:${who.account}`);
  const body = await request.json().catch(() => ({}));
  if (op === 'credits') {
    const pack = Number(body && body.pack);
    const price = packPrices(env)[pack];
    if (!price) throw new ApiError(404, 'not_found', 'That credit pack isn’t on sale here.');
    const begun = await call(env, who.account, 'stripe-credits', { pack }, who.token);
    const metadata = { account_id: who.account, kind: 'credits', pack: String(pack) };
    const session = await stripe(env, 'POST', '/checkout/sessions', {
      mode: 'payment',
      line_items: [{ price, quantity: 1 }],
      client_reference_id: who.account,
      metadata,
      // The card is kept for auto top-up (the person turns it on); the PaymentIntent names the
      // pack so payment_intent.* events can be told apart from auto top-ups.
      payment_intent_data: { metadata, setup_future_usage: 'off_session' },
      success_url: `${origin}/api/web/billing/return?to=credits`,
      cancel_url: `${origin}/api/web/billing/return?to=cancelled`,
      ...(begun.customer ? { customer: begun.customer } : { customer_creation: 'always' }),
    }, { idempotency: `eden-credits-${begun.key}` });
    if (!stripePage(env, session.url, 'checkout.stripe.com')) throw new ApiError(502, 'stripe', 'Stripe sent back no checkout page. Try again.');
    return json({ url: session.url });
  }
  if (op === 'autotopup') {
    if (!plusOffer(env).auto_topup) throw new ApiError(404, 'not_found', 'Auto top-up isn’t offered here.');
    return json(await call(env, who.account, 'stripe-autotopup', { enabled: body && body.enabled === true }, who.token)); // 409 no_card
  }
  if (op === 'checkout') {
    const yearly = body && body.plan === 'yearly';
    const price = yearly ? yearlyPrice(env) : prices(env)[0];
    if (!price) throw new ApiError(404, 'not_found', 'Yearly Plus isn’t on sale here.');
    const begun = await call(env, who.account, 'stripe-checkout', { origin: `${origin}#${yearly ? 'yearly' : 'monthly'}` }, who.token); // 409 already_plus
    const session = await stripe(env, 'POST', '/checkout/sessions', {
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      client_reference_id: who.account,
      metadata: { account_id: who.account },
      subscription_data: { metadata: { account_id: who.account } }, // so every subscription event names the account
      success_url: `${origin}/api/web/billing/return?to=success`, // on to /#account?billing=success
      cancel_url: `${origin}/api/web/billing/return?to=cancelled`, // on to /#account?billing=cancelled
      expires_at: begun.expires_at,
      customer: begun.customer, // a returning subscriber keeps one Stripe customer
    }, { idempotency: `eden-checkout-${begun.key}` });
    if (!stripePage(env, session.url, 'checkout.stripe.com')) throw new ApiError(502, 'stripe', 'Stripe sent back no checkout page. Try again.');
    return json({ url: session.url });
  }
  const { customer } = await call(env, who.account, 'stripe-portal', {}, who.token); // 404 no_billing
  const portal = await stripe(env, 'POST', '/billing_portal/sessions', { customer, return_url: `${origin}/api/web/billing/return?to=portal` });
  if (!stripePage(env, portal.url, 'billing.stripe.com')) throw new ApiError(502, 'stripe', 'Stripe sent back no billing page. Try again.');
  return json({ url: portal.url });
}

// Where Stripe sends the browser back, and where that goes next: fixed places, nothing taken
// from the address but which one.
const RETURNS = { success: '/#account?billing=success', credits: '/#account?billing=credits', cancelled: '/#account?billing=cancelled', portal: '/#account' };

/**
 * GET /api/web/billing/return?to=success|cancelled|portal. Coming back from Stripe's site is a
 * cross-site navigation, so the session cookie (SameSite=Strict) isn't sent with it, and / would
 * look signed out. This page needs no cookie: it moves on at once with a meta refresh, which this
 * site starts, so the cookie comes along (as the sign-in callbacks end, eden/session.js onward).
 */
export function billingReturn(request) {
  const which = new URL(request.url).searchParams.get('to');
  const to = Object.hasOwn(RETURNS, which || '') ? RETURNS[which] : '/#account';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0; url=${to}"><title>Eden</title><link rel="stylesheet" href="/signin/signin.css"></head>
<body><main class="card"><h1>Back to Eden…</h1><p><a class="button" href="${to}">Continue to your account</a></p></main></body></html>`;
  return page(new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }), SIGNIN_CSP);
}

// ── /api/stripe/… : the webhook, and nothing else ──

export async function stripeApi(request, env, ctx, path) {
  try {
    if (path !== '/api/stripe/webhook') throw new ApiError(404, 'not_found', 'No such thing here.');
    if (request.method !== 'POST') throw new ApiError(405, 'bad_request', 'POST it.');
    return await webhook(request, env);
  } catch (error) {
    if (error instanceof ApiError) return error.response();
    console.error('stripe webhook failed', error && error.stack);
    return json({ error: 'Something went wrong on the server.', code: 'server' }, 500); // Stripe tries again
  }
}

async function hmacHex(secret, text) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

/**
 * Stripe-Signature: "t=<unix s>,v1=<hex>[,v1=<hex>…][,v0=…]". Good when one v1 is HMAC-SHA256 of
 * "<t>.<raw body>" with the endpoint's secret (compared in constant time), and t is within the
 * tolerance. Several v1s come while a secret is being rolled.
 */
export async function verifyStripeSignature(payload, header, secret, { now = Date.now() / 1000, tolerance = SIGNATURE_TOLERANCE_S } = {}) {
  if (!secret || typeof payload !== 'string') return false;
  let t = null;
  const v1 = [];
  for (const part of String(header || '').split(',')) {
    const at = part.indexOf('=');
    const k = part.slice(0, at).trim();
    const v = part.slice(at + 1).trim();
    if (k === 't' && /^\d{1,12}$/.test(v)) t = v;
    else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v) && v1.length < 8) v1.push(v.toLowerCase());
  }
  if (t === null || !v1.length || Math.abs(now - Number(t)) > tolerance) return false;
  const expected = await hmacHex(secret, `${t}.${payload}`);
  let ok = false;
  for (const sig of v1) ok = sameText(sig, expected) || ok; // every one compared, whatever matched
  return ok;
}

const received = (extra = {}) => json({ received: true, ...extra });
const idOf = (x) => (typeof x === 'string' ? x : x && typeof x.id === 'string' ? x.id : null);

async function webhook(request, env) {
  const secret = webhookSecret(env);
  if (!secret) throw new ApiError(503, 'not_set_up', 'Stripe isn’t set up here.');
  const raw = await request.text();
  if (raw.length > WEBHOOK_BYTES) throw new ApiError(413, 'too_big', 'That event is too big.');
  if (!(await verifyStripeSignature(raw, request.headers.get('stripe-signature'), secret))) {
    throw new ApiError(400, 'bad_signature', 'That isn’t signed by Stripe.');
  }
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    throw new ApiError(400, 'bad_request', 'Not JSON.');
  }
  if (!event || typeof event.id !== 'string' || typeof event.type !== 'string' || !event.data || typeof event.data.object !== 'object') {
    throw new ApiError(400, 'bad_request', 'Not a Stripe event.');
  }
  if (event.livemode && String(env.STRIPE_LIVE || '') !== '1') return received({ ignored: 'live' });
  try {
    return received(await handle(env, event));
  } catch (error) {
    // An account that's gone, a refusal of ours: Stripe needn't send it again.
    if (error instanceof ApiError && error.status < 500) return received({ ignored: error.code });
    throw error;
  }
}

/** The Plus price among a subscription's items, or null. */
function plusPrice(sub, env) {
  const list = honoured(env);
  for (const item of (sub.items && sub.items.data) || []) {
    const price = idOf(item.price) || idOf(item.plan);
    if (list.includes(price)) return price;
  }
  return null;
}

// Newer API versions keep the period on each item; older ones on the subscription.
function periodEnd(sub) {
  const ends = [Number(sub.current_period_end) || 0, ...((sub.items && sub.items.data) || []).map((i) => Number(i.current_period_end) || 0)];
  let end = Math.max(...ends) * 1000;
  if (Number(sub.cancel_at)) end = Math.min(end || Infinity, Number(sub.cancel_at) * 1000);
  return end || 0;
}

/** What the account object needs of a subscription. */
function subscriptionFacts(sub, env) {
  const price = plusPrice(sub, env);
  return {
    id: String(sub.id),
    status: String(sub.status || ''),
    customer: idOf(sub.customer),
    price,
    plus: Boolean(price),
    period_end: periodEnd(sub),
    renews: !sub.cancel_at_period_end && !Number(sub.cancel_at) && !['canceled', 'incomplete_expired'].includes(sub.status),
  };
}

const accountIn = (...ids) => {
  const found = [...new Set(ids.filter(Boolean).map((id) => String(id).toLowerCase()))];
  return found.length === 1 && validAccountId(found[0]) ? found[0] : null;
};

/** A credit pack's Checkout, paid: its credits, and the card for auto top-up. */
async function creditsPaid(env, session, apply) {
  const meta = session.metadata || {};
  if (meta.kind !== 'credits') return { ignored: 'not_credits' };
  if (session.payment_status !== 'paid') return { ignored: 'unpaid' };
  const usd = Number(meta.pack);
  if (!PACKS.includes(usd)) return { ignored: 'no_pack' };
  const account = accountIn(session.client_reference_id, meta.account_id);
  if (!account) return { ignored: 'no_account' };
  const intent = idOf(session.payment_intent);
  let payment_method = null;
  if (intent) {
    const pi = await stripe(env, 'GET', `/payment_intents/${encodeURIComponent(intent)}`, null, { raw: true });
    if (pi.ok) payment_method = idOf(pi.body.payment_method);
  }
  return apply(account, { credit: { id: intent || String(session.id), usd, source: 'stripe', customer: idOf(session.customer), payment_method } });
}

/**
 * An automatic top-up (accounts/credits.js maybeTopUp): an off-session PaymentIntent for `usd`
 * with the customer's default card (else the one saved with a pack), confirmed at once. Its
 * idempotency key is the top-up's own: the same top-up is never charged twice. → { status:
 * "succeeded" | "requires_action" | "failed" | "processing", id, usd, why }.
 */
export async function chargeTopUp(env, { account, customer, payment_method, usd, key }) {
  if (!billingReady(env) || !plusOffer(env).auto_topup) return { status: 'failed', id: null, usd, why: 'auto top-up is off here' };
  let method = null;
  const cus = await stripe(env, 'GET', `/customers/${encodeURIComponent(customer)}`, null, { raw: true });
  if (cus.ok) method = idOf(cus.body.invoice_settings && cus.body.invoice_settings.default_payment_method) || idOf(cus.body.default_source);
  method = method || payment_method;
  if (!method) return { status: 'failed', id: null, usd, why: 'no card on file' };
  const out = await stripe(env, 'POST', '/payment_intents', {
    amount: Math.round(usd * 100),
    currency: 'usd',
    customer,
    payment_method: method,
    off_session: true,
    confirm: true,
    description: `Eden credits: automatic top-up of $${usd}`,
    metadata: { account_id: account, kind: 'auto_topup', pack: String(usd), topup_key: key },
  }, { idempotency: key, raw: true });
  if (out.status >= 500 || out.status === 429) throw new ApiError(502, 'stripe', 'Stripe didn’t answer.');
  const pi = out.ok ? out.body : (out.body.error && out.body.error.payment_intent) || {};
  const status = pi.status === 'succeeded' ? 'succeeded'
    : pi.status === 'requires_action' || (out.body.error && out.body.error.code === 'authentication_required') ? 'requires_action'
    : pi.status === 'processing' ? 'processing'
    : 'failed';
  const e = out.body.error || {};
  return { status, id: pi.id || null, usd, why: status === 'failed' ? e.decline_code || e.code || null : null };
}

async function handle(env, event) {
  const object = event.data.object;
  const base = { id: event.id, type: event.type, created: Number(event.created) || 0, livemode: Boolean(event.livemode) };
  const apply = async (account, facts) => {
    if (!account) return { ignored: 'no_account' };
    return call(env, account, 'stripe-event', { ...base, ...facts });
  };
  switch (event.type) {
    case 'checkout.session.completed': {
      if (object.mode === 'payment') return creditsPaid(env, object, apply);
      if (object.mode !== 'subscription' || !idOf(object.subscription)) return { ignored: 'not_a_subscription' };
      const account = accountIn(object.client_reference_id, object.metadata && object.metadata.account_id);
      if (!account) return { ignored: 'no_account' };
      // The session doesn't carry the subscription's state: Stripe's current one is read.
      const sub = await stripe(env, 'GET', `/subscriptions/${encodeURIComponent(idOf(object.subscription))}`);
      return apply(account, { customer: idOf(object.customer), subscription: subscriptionFacts(sub, env), fresh: true });
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return apply(accountIn(object.metadata && object.metadata.account_id), { customer: idOf(object.customer), subscription: subscriptionFacts(object, env) });
    case 'payment_intent.succeeded':
    case 'payment_intent.payment_failed': {
      const meta = object.metadata || {};
      if (meta.kind !== 'auto_topup') return { ignored: 'not_a_top_up' }; // a pack's: checkout.session.completed adds it
      const account = accountIn(meta.account_id);
      const usd = Number(meta.pack);
      if (!PACKS.includes(usd)) return { ignored: 'no_pack' };
      const ok = event.type === 'payment_intent.succeeded';
      if (ok && Number(object.amount_received) < usd * 100) return { ignored: 'short' };
      const why = !ok && object.last_payment_error ? object.last_payment_error.code || object.last_payment_error.decline_code || null : null;
      return apply(account, { topup: { key: String(meta.topup_key || ''), status: ok ? 'succeeded' : 'failed', id: String(object.id), usd, why } });
    }
    case 'invoice.payment_failed': {
      const details = (object.parent && object.parent.subscription_details) || object.subscription_details || {};
      const subscription = idOf(object.subscription) || idOf(details.subscription);
      if (!subscription) return { ignored: 'no_subscription' };
      return apply(accountIn(details.metadata && details.metadata.account_id), { invoice: { subscription, customer: idOf(object.customer) } });
    }
    default:
      return { ignored: 'type' };
  }
}
