// Eden Plus bought in Eden for Android with Google Play Billing (askeden/android plus/PlusStore.kt),
// beside the App Store's (eden/billing.js appleTransaction) and Stripe's:
//
//   POST /api/web/billing/google { purchase_token, product_id }
//        The Eden Android app's web view session (its cookie), after Play's purchase sheet. The
//        subscription is read from Google itself (purchases.subscriptionsv2.get, with the service
//        account below): Google's answer, never the app's, moves the plan (accounts/play-plan.js).
//        It must be Eden's, a Plus product, and carry this account's id (the app's
//        setObfuscatedAccountId); one without (a code redeemed in the Play Store) goes to the first
//        account that links it, by its purchase token (the `googleplay` identity). Once the account
//        has it, the purchase is acknowledged with Google here (the app acknowledges too, only after
//        this answer), so Google never refunds a purchase Eden took, and always one it didn't.
//        → { plan, usage, acknowledged }
//   POST /api/googleplay/notifications
//        Real-time Developer Notifications (Pub/Sub push, authenticated with Google-signed OIDC
//        tokens of GOOGLE_PLAY_RTDN_EMAIL): renewals, cancellations, holds, expiries, refunds and
//        revocations. The token's subscription is read from Google again and applied to the account
//        it belongs to; a purchase that completed while the app was closed is acknowledged too.
//
// Configuration (nothing here is set by code; the owner sets them):
//   GOOGLE_PLAY_SERVICE_ACCOUNT   (secret) the service account's JSON key, with Play Console's
//                                 "View financial data" and "Manage orders and subscriptions"
//   GOOGLE_PLAY_RTDN_EMAIL        the service account Pub/Sub signs its pushes as
//   GOOGLE_PLAY_RTDN_AUDIENCE     the push's audience (default: this endpoint's URL)
// Without the service account the endpoint answers 503 not_set_up (the app keeps the purchase
// unacknowledged and tries again later).

import { call, callIdentity, limited, subHashOf } from './index.js';
import { PLAY_PACKAGE, PLAY_PLUS_PRODUCTS } from './play-plan.js';
import { ApiError, b64ToBytes, b64url, b64urlText, json, readJson, validAccountId } from './util.js';

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const SKEW_S = 300;
export const PLAY_TOKEN = /^[A-Za-z0-9._:-]{10,1024}$/;
export const RTDN_PATH = '/api/googleplay/notifications';
// Subscription notification types (Google's numbering) that are about a subscription's state.
const SUBSCRIPTION_REVOKED = 12;

// Tests point these at a fake Google (testOnlyPlayFetch).
let fetcher = (...args) => fetch(...args);
let accessCache = null; // { email, token, until }
let certsCache = null; // { until, keys }
export function testOnlyPlayFetch(fn) {
  fetcher = fn || ((...args) => fetch(...args));
  accessCache = null;
  certsCache = null;
}

export const playReady = (env) => Boolean(serviceAccount(env));

function serviceAccount(env) {
  try {
    const sa = JSON.parse(String(env.GOOGLE_PLAY_SERVICE_ACCOUNT || ''));
    if (sa && typeof sa.client_email === 'string' && typeof sa.private_key === 'string') return sa;
  } catch {
    // not set, or not the JSON key
  }
  return null;
}

const unavailable = (why) => new ApiError(503, 'play_unreachable', `Google Play can't be reached right now (${why}). Try again in a minute.`, { 'retry-after': '60' });

// ── the service account's access token (OAuth 2.0 JWT bearer, RS256) ──

async function accessToken(env) {
  const sa = serviceAccount(env);
  if (!sa) throw new ApiError(503, 'not_set_up', 'Eden Plus on Google Play isn’t set up here yet.');
  const now = Math.floor(Date.now() / 1000);
  if (accessCache && accessCache.email === sa.client_email && accessCache.until > now + 60) return accessCache.token;
  const head = b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) }));
  const claims = b64urlText(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri || TOKEN_URL, iat: now, exp: now + 3600 }));
  let key;
  try {
    const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    key = await crypto.subtle.importKey('pkcs8', b64ToBytes(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch {
    throw new ApiError(503, 'not_set_up', 'Eden Plus on Google Play isn’t set up here yet (the service account key is unreadable).');
  }
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${claims}`)));
  let response;
  try {
    response = await fetcher(sa.token_uri || TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${b64url(sig)}` }).toString(),
    });
  } catch {
    throw unavailable('sign-in');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.access_token !== 'string') {
    console.error('google play: the service account sign-in failed', response.status, body && body.error);
    throw unavailable('sign-in');
  }
  accessCache = { email: sa.client_email, token: body.access_token, until: now + (Number(body.expires_in) || 3600) };
  return body.access_token;
}

async function google(env, method, path, body) {
  const token = await accessToken(env);
  try {
    return await fetcher(`${API}/${PLAY_PACKAGE}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw unavailable('network');
  }
}

/** subscriptionsv2.get: Google's own record of a purchase token, or null when Google has none. */
export async function readSubscription(env, token) {
  const response = await google(env, 'GET', `/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`);
  if (response.status === 404 || response.status === 410 || response.status === 400) return null;
  if (!response.ok) {
    console.error('google play: subscriptionsv2.get failed', response.status);
    throw unavailable(String(response.status));
  }
  return response.json();
}

/** subscriptions.acknowledge; true when Google took it (or it was already). */
export async function acknowledge(env, productId, token) {
  try {
    const response = await google(env, 'POST', `/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:acknowledge`, {});
    if (!response.ok) console.error('google play: acknowledge failed', response.status);
    return response.ok;
  } catch {
    return false;
  }
}

/** The facts Eden keeps from a SubscriptionPurchaseV2, its Plus line item's; null if it has none. */
export function playFacts(sub, token, now = Date.now()) {
  const items = (Array.isArray(sub && sub.lineItems) ? sub.lineItems : []).filter((li) => li && PLAY_PLUS_PRODUCTS.includes(li.productId));
  if (!items.length) return null;
  const item = items.reduce((a, b) => ((Date.parse(b.expiryTime) || 0) > (Date.parse(a.expiryTime) || 0) ? b : a));
  const account = String((sub.externalAccountIdentifiers && sub.externalAccountIdentifiers.obfuscatedExternalAccountId) || '').toLowerCase();
  return {
    token,
    product_id: item.productId,
    base_plan: (item.offerDetails && item.offerDetails.basePlanId) || null,
    state: String(sub.subscriptionState || ''),
    expires: Date.parse(item.expiryTime) || 0,
    renews: Boolean(item.autoRenewingPlan && item.autoRenewingPlan.autoRenewEnabled),
    account: account || null,
    linked: sub.linkedPurchaseToken || null,
    test: Boolean(sub.testPurchase),
    order: sub.latestOrderId || null,
    acknowledged: sub.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    fetched: now,
  };
}

const claimOf = (token) => subHashOf('googleplay', token);

// ── POST /api/web/billing/google (eden/billing.js sends it here) ──

export async function playPurchase(request, env, who) {
  await limited(env, 'USER_RATE', `play:${who.account}`);
  const body = await readJson(request, 8 * 1024);
  const token = String(body.purchase_token || '');
  if (!PLAY_TOKEN.test(token)) throw new ApiError(400, 'bad_purchase', 'No purchase token.');
  if (who.grant) throw new ApiError(403, 'grant_forbidden', 'Only the account’s owner can buy or manage Plus.');
  const sub = await readSubscription(env, token);
  const facts = sub && playFacts(sub, token);
  if (!facts) throw new ApiError(400, 'bad_purchase', 'That isn’t an Eden Plus purchase on Google Play.');
  if (facts.state === 'SUBSCRIPTION_STATE_PENDING') throw new ApiError(409, 'pending', 'That purchase is still waiting for its payment.');
  // The account's own checks come first, so a refused purchase leaves no claim behind.
  if (facts.account && facts.account !== who.account) throw new ApiError(403, 'forbidden', 'That purchase belongs to another Eden account.');
  // The first account to link a purchase token keeps it (409 identity_taken for any other).
  const claimHash = await claimOf(token);
  await callIdentity(env, 'googleplay', claimHash, 'claim', { account_id: who.account });
  const account = await call(env, who.account, 'play-subscription', { facts, claimed: !facts.account, claim_hash: claimHash }, who.token);
  const acknowledged = facts.acknowledged || (await acknowledge(env, facts.product_id, token));
  return { plan: account.plan, usage: account.usage, acknowledged };
}

// ── Real-time Developer Notifications ──

async function googleCerts(force = false) {
  const now = Date.now();
  if (!force && certsCache && certsCache.until > now) return certsCache.keys;
  const response = await fetcher(CERTS_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!response.ok) throw unavailable('keys');
  const { keys } = await response.json();
  certsCache = { until: now + 3600_000, keys: Array.isArray(keys) ? keys : [] };
  return certsCache.keys;
}

/** The push's OIDC token: Google-signed, for our audience, from the service account the owner named. */
export async function verifyPushToken(request, env) {
  const email = String(env.GOOGLE_PLAY_RTDN_EMAIL || '').trim().toLowerCase();
  if (!email) throw new ApiError(503, 'not_set_up', 'Google Play notifications aren’t set up here yet.');
  const refused = (why) => new ApiError(401, 'bad_push', `That push didn't check out (${why}).`);
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') || '');
  const parts = m ? m[1].split('.') : [];
  if (parts.length !== 3) throw refused('no token');
  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(b64ToBytes(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(b64ToBytes(parts[1])));
  } catch {
    throw refused('unreadable');
  }
  if (header.alg !== 'RS256') throw refused('algorithm');
  let jwk = (await googleCerts()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await googleCerts(true)).find((k) => k.kid === header.kid);
  if (!jwk) throw refused('unknown key');
  const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64ToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`)))) throw refused('signature');
  const now = Date.now() / 1000;
  const audience = String(env.GOOGLE_PLAY_RTDN_AUDIENCE || '').trim() || `${new URL(request.url).origin}${RTDN_PATH}`;
  if (!ISSUERS.includes(claims.iss)) throw refused('issuer');
  if (claims.aud !== audience) throw refused('audience');
  if (!(Number(claims.exp) + SKEW_S > now) || Number(claims.iat) - SKEW_S > now) throw refused('expired');
  if (String(claims.email || '').toLowerCase() !== email || (claims.email_verified !== true && claims.email_verified !== 'true')) throw refused('sender');
  return claims;
}

const ok = () => new Response(null, { status: 204 });

export async function playNotification(request, env) {
  await verifyPushToken(request, env);
  const body = await readJson(request, 64 * 1024);
  let note;
  try {
    note = JSON.parse(new TextDecoder().decode(b64ToBytes(String((body.message && body.message.data) || ''))));
  } catch {
    return ok(); // nothing Eden can read: Pub/Sub needn't send it again
  }
  if (!note || note.packageName !== PLAY_PACKAGE || note.testNotification) return ok();
  const subNote = note.subscriptionNotification;
  const voided = note.voidedPurchaseNotification;
  const token = String((subNote && subNote.purchaseToken) || (voided && voided.purchaseToken) || '');
  if (!PLAY_TOKEN.test(token)) return ok();
  if (subNote && subNote.subscriptionId && !PLAY_PLUS_PRODUCTS.includes(subNote.subscriptionId)) return ok();
  const sub = await readSubscription(env, token); // Google's word now, whatever the notification said
  const facts = sub && playFacts(sub, token);
  if (!facts) return ok();
  // Whose: the account it was bought for, else the account that claimed its token (a redeemed code),
  // else the one that claimed the token it replaced (a plan change of a redeemed code's subscription).
  let accountId = facts.account || '';
  let claimed = false;
  if (!accountId) {
    accountId = (await callIdentity(env, 'googleplay', await claimOf(token), 'get')).account_id || '';
    if (!accountId && facts.linked && PLAY_TOKEN.test(facts.linked)) {
      accountId = (await callIdentity(env, 'googleplay', await claimOf(facts.linked), 'get')).account_id || '';
      if (validAccountId(accountId)) await callIdentity(env, 'googleplay', await claimOf(token), 'claim', { account_id: accountId }).catch(() => { accountId = ''; });
    }
    claimed = Boolean(accountId);
  }
  if (!validAccountId(accountId)) return ok(); // nobody's yet: the app links it when it's next open
  try {
    await call(env, accountId, 'play-notification', { facts, claimed });
  } catch (error) {
    // A deleted account, or someone else's purchase: Google needn't send it again.
    if (!(error instanceof ApiError && error.status < 500)) throw error;
    return ok();
  }
  // A purchase that completed while the app was closed (a pending payment, say), now the account has it.
  if (!facts.acknowledged && facts.state === 'SUBSCRIPTION_STATE_ACTIVE') await acknowledge(env, facts.product_id, token);
  if (subNote && Number(subNote.notificationType) === SUBSCRIPTION_REVOKED) console.warn('google play: a subscription revoked on account', accountId);
  return ok();
}
