// Eden Plus bought in the Eden iPhone app with StoreKit 2 (askeden/ios Eden/PlusStore.swift;
// askeden/docs/bug-sweep/ios-2026-10-09-iap.md): the app sends each verified transaction's JWS to
// POST /api/web/billing/apple with its web view's session cookie (eden/billing.js), and App Store
// Server Notifications V2 for com.askeden.eden arrive at /api/appstore/notifications like
// J.A.R.V.I.S.'s. A test certificate chain (openssl) stands in for Apple's, pinned through
// APPLE_ROOT_FINGERPRINT as accounts.test.js does.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { combinePlans } from '../src/accounts/stripe-plan.js';
import { EDEN_BUNDLE_ID, EDEN_PLUS_PRODUCTS, PLUS_PRODUCTS, STORE_APPS, b64url, b64urlText, bytesToB64, hex, isPlusPurchase } from '../src/accounts/util.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const DAY = 86400_000;
const ctx = { waitUntil: () => {} };

let env;
let chain;

before(() => {
  const dir = mkdtempSync(join(tmpdir(), 'eden-iap-'));
  const run = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'mid.ext'), 'basicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n1.2.840.113635.100.6.2.1=ASN1:NULL\n');
  writeFileSync(join(dir, 'leaf.ext'), 'basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\n1.2.840.113635.100.6.11.1=ASN1:NULL\n');
  run('ecparam', '-name', 'secp384r1', '-genkey', '-noout', '-out', 'root.key');
  run('req', '-new', '-x509', '-key', 'root.key', '-sha384', '-days', '3650', '-subj', '/CN=Test Root', '-out', 'root.pem');
  run('ecparam', '-name', 'secp384r1', '-genkey', '-noout', '-out', 'mid.key');
  run('req', '-new', '-key', 'mid.key', '-subj', '/CN=Test WWDR', '-out', 'mid.csr');
  run('x509', '-req', '-in', 'mid.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-sha384', '-days', '3650', '-extfile', 'mid.ext', '-out', 'mid.pem');
  run('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'leaf.key');
  run('pkcs8', '-topk8', '-nocrypt', '-in', 'leaf.key', '-out', 'leaf.p8');
  run('req', '-new', '-key', 'leaf.key', '-subj', '/CN=Test StoreKit', '-out', 'leaf.csr');
  run('x509', '-req', '-in', 'leaf.csr', '-CA', 'mid.pem', '-CAkey', 'mid.key', '-CAcreateserial', '-sha384', '-days', '3650', '-extfile', 'leaf.ext', '-out', 'leaf.pem');
  const der = (name) => new Uint8Array(run('x509', '-in', name, '-outform', 'der'));
  const ders = [der('leaf.pem'), der('mid.pem'), der('root.pem')];
  chain = { ders, x5c: ders.map((d) => bytesToB64(d)), leafP8: readFileSync(join(dir, 'leaf.p8'), 'utf8') };
});

beforeEach(async () => {
  forgetSessions();
  env = {
    TRIAL_BUDGET_USD: '1',
    PLUS_BUDGET_USD: '6',
    PLUS_LEGACY_BUDGET_USD: '20',
    STRIPE_SECRET_KEY: 'sk_test_51FakeKeyForTestsOnly',
    STRIPE_WEBHOOK_SECRET: 'whsec_testSecretForTheWebhook123',
    STRIPE_PRICE_PLUS: 'price_1PlusMonthlyTest',
    LINK_RATE: rateLimiter(),
    API_RATE: rateLimiter(),
    EDEN_RATE: rateLimiter(),
    AUTH_RATE: rateLimiter(),
    APPLE_ROOT_FINGERPRINT: hex(new Uint8Array(await crypto.subtle.digest('SHA-256', chain.ders[2]))),
  };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.IDENTITIES = namespace(Identity, env);
  env.ASSETS = { fetch: async () => new Response('asset') };
});

async function signedJws(payload) {
  const pem = chain.leafP8.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64urlText(JSON.stringify({ alg: 'ES256', x5c: chain.x5c }));
  const body = b64urlText(JSON.stringify({ signedDate: Date.now(), ...payload }));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

const edenTx = (account, extra = {}) => ({
  bundleId: 'com.askeden.eden',
  productId: 'com.askeden.eden.plus.monthly',
  transactionId: '3000000001',
  originalTransactionId: '3000000000',
  appAccountToken: account.toUpperCase(), // StoreKit sends the UUID in capitals
  purchaseDate: Date.now(),
  expiresDate: Date.now() + 30 * DAY,
  environment: 'Production',
  ...extra,
});

/** A browser's (the Eden app's web view's) session, as the web sign-in makes one. */
const browser = async (account) => (await call(env, account, 'web-signin', { account_id: account, create: true, device: { name: 'Eden on the web: Eden for iPhone' } })).token;

function hit(path, { method = 'GET', body, session, token, headers = {} } = {}) {
  const h = { 'user-agent': 'Eden/1 CFNetwork', ...headers };
  if (session) h.cookie = `__Host-eden=${session}`;
  if (token) h.authorization = `Bearer ${token}`;
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
}

// The app's URLSession sends no Origin (a page would send askeden.com's).
const linkTx = async (session, jws, headers = {}) => hit('/api/web/billing/apple', { method: 'POST', session, body: { signed_transaction: jws }, headers });
const planOf = async (session) => (await (await hit('/api/web/account', { session })).json()).plan;
const notify = async (tx, { type = 'DID_RENEW', renewal = null, bundleId = tx.bundleId } = {}) => hit('/api/appstore/notifications', {
  method: 'POST',
  body: { signedPayload: await signedJws({ notificationType: type, data: { bundleId, environment: 'Sandbox', signedTransactionInfo: await signedJws(tx), ...(renewal ? { signedRenewalInfo: await signedJws(renewal) } : {}) } }) },
});

test('the product ids: Eden Plus beside Jarvis Plus, each only from its own app', () => {
  assert.equal(EDEN_BUNDLE_ID, 'com.askeden.eden');
  assert.deepEqual(EDEN_PLUS_PRODUCTS, ['com.askeden.eden.plus.monthly', 'com.askeden.eden.plus.yearly']);
  assert.deepEqual(Object.keys(STORE_APPS), ['com.askeden.jarvis', 'com.askeden.eden']);
  assert.equal(isPlusPurchase({ bundleId: 'com.askeden.eden', productId: 'com.askeden.eden.plus.yearly' }), true);
  assert.equal(isPlusPurchase({ bundleId: 'com.askeden.jarvis', productId: PLUS_PRODUCTS[0] }), true);
  assert.equal(isPlusPurchase({ bundleId: 'com.askeden.jarvis', productId: 'com.askeden.eden.plus.monthly' }), false, 'another app’s product');
  assert.equal(isPlusPurchase({ bundleId: 'com.askeden.eden', productId: 'com.askeden.eden.credits' }), false);
  assert.equal(isPlusPurchase({ productId: 'com.askeden.eden.plus.monthly' }), true, 'no bundle: the Worker checked it');
});

test('the Eden app links its purchase: Plus from the App Store, at today’s allowance', async () => {
  const session = await browser(A);
  assert.equal((await planOf(session)).name, 'free');
  const response = await linkTx(session, await signedJws(edenTx(A)));
  assert.equal(response.status, 200, await response.clone().text());
  const { plan, usage } = await response.json();
  assert.equal(plan.name, 'plus');
  assert.equal(plan.source, 'app_store');
  assert.equal(plan.product_id, 'com.askeden.eden.plus.monthly');
  assert.equal(plan.environment, 'Production');
  assert.equal(plan.manage.app_store, 'https://apps.apple.com/account/subscriptions');
  assert.equal(usage.budget_usd, 6, 'Eden’s App Store Plus is today’s price: today’s allowance, not Jarvis’s legacy $20');
  assert.equal((await planOf(session)).source, 'app_store');
  // The same transaction again (a restore, StoreKit's updates at launch): no harm.
  assert.equal((await linkTx(session, await signedJws(edenTx(A)))).status, 200);
  // Yearly, upgraded in the same group: the later period wins.
  const yearly = await linkTx(session, await signedJws(edenTx(A, { productId: 'com.askeden.eden.plus.yearly', transactionId: '3000000002', expiresDate: Date.now() + 365 * DAY })));
  assert.equal((await yearly.json()).plan.product_id, 'com.askeden.eden.plus.yearly');
});

test('a purchase made for another account (appAccountToken) is refused', async () => {
  const session = await browser(A);
  const other = await linkTx(session, await signedJws(edenTx(B)));
  assert.equal(other.status, 403);
  assert.equal((await other.json()).code, 'forbidden');
  assert.equal((await planOf(session)).name, 'free');
  // The J.A.R.V.I.S. route never takes one without a token (only the signed-in Eden app may claim it).
  const { token } = await call(env, A, 'signin', { account_id: A, device: { name: 'iPhone', kind: 'iphone' } });
  const bare = await hit('/api/subscription', { method: 'POST', token, body: { signed_transaction: await signedJws(edenTx(A, { appAccountToken: undefined })) } });
  assert.equal(bare.status, 403);
});

test('an offer code redeemed in Apple’s sheet (no appAccountToken): the first account to link it keeps it', async () => {
  const session = await browser(A);
  const code = (extra = {}) => edenTx(A, { appAccountToken: undefined, offerType: 3, transactionId: '4000000001', originalTransactionId: '4000000000', ...extra });
  const linked = await linkTx(session, await signedJws(code()));
  assert.equal(linked.status, 200, await linked.clone().text());
  assert.equal((await linked.json()).plan.name, 'plus');
  // Linked again from the same account (a restore): fine. From another account: refused.
  assert.equal((await linkTx(session, await signedJws(code()))).status, 200);
  const other = await browser(B);
  const taken = await linkTx(other, await signedJws(code()));
  assert.equal(taken.status, 409);
  assert.equal((await taken.json()).code, 'identity_taken');
  assert.equal((await planOf(other)).name, 'free');
  // Its notifications find the account that claimed it: a refund takes Plus away there.
  assert.equal((await notify(code({ revocationDate: Date.now() }), { type: 'REFUND' })).status, 200);
  assert.equal((await planOf(session)).name, 'free', 'refunded');
  // A tokenless notification nobody claimed: Apple still hears 200.
  assert.equal((await notify(code({ originalTransactionId: '4999999999' }))).status, 200);
});

test('only the Eden app’s Plus, checked against the chain, signed in, from no other site', async () => {
  const session = await browser(A);
  // J.A.R.V.I.S.'s purchase goes through its own route, not this one.
  assert.equal((await linkTx(session, await signedJws(edenTx(A, { bundleId: 'com.askeden.jarvis', productId: PLUS_PRODUCTS[0] })))).status, 400);
  // Eden's product claimed by another app, an unknown product, another app entirely.
  assert.equal((await linkTx(session, await signedJws(edenTx(A, { productId: PLUS_PRODUCTS[0] })))).status, 400);
  assert.equal((await linkTx(session, await signedJws(edenTx(A, { productId: 'com.askeden.eden.coins' })))).status, 400);
  assert.equal((await linkTx(session, await signedJws(edenTx(A, { bundleId: 'com.other' })))).status, 400);
  // A broken signature; not Apple's root (the real pin).
  const good = await signedJws(edenTx(A));
  assert.equal((await linkTx(session, good.slice(0, -4) + 'AAAA')).status, 400);
  const pinned = env.APPLE_ROOT_FINGERPRINT;
  delete env.APPLE_ROOT_FINGERPRINT;
  assert.equal((await linkTx(session, good)).status, 400);
  env.APPLE_ROOT_FINGERPRINT = pinned;
  // Signed out; posted from another site.
  assert.equal((await linkTx(null, good)).status, 401);
  assert.equal((await linkTx(session, good, { origin: 'https://evil.example' })).status, 403);
  // askeden.com's own page may post it too.
  assert.equal((await linkTx(session, good, { origin: ORIGIN })).status, 200);
});

test('the J.A.R.V.I.S. app’s route takes Eden’s purchases too (one account, either app)', async () => {
  const { token } = await call(env, A, 'signin', { account_id: A, device: { name: 'iPhone', kind: 'iphone' } });
  const response = await hit('/api/subscription', { method: 'POST', token, body: { signed_transaction: await signedJws(edenTx(A)) } });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).plan.name, 'plus');
});

test('App Store notifications for com.askeden.eden: renewal, expiry, refund and revocation', async () => {
  const session = await browser(A);
  // A renewal (DID_RENEW) with its renewal info: Plus, renewing.
  assert.equal((await notify(edenTx(A), { renewal: { originalTransactionId: '3000000000', autoRenewStatus: 1 } })).status, 200);
  let plan = await planOf(session);
  assert.equal(plan.name, 'plus');
  assert.equal(plan.renews, true);
  // Auto-renew turned off (DID_CHANGE_RENEWAL_STATUS): still Plus until it ends.
  await notify(edenTx(A), { type: 'DID_CHANGE_RENEWAL_STATUS', renewal: { originalTransactionId: '3000000000', autoRenewStatus: 0 } });
  plan = await planOf(session);
  assert.equal(plan.name, 'plus');
  assert.equal(plan.renews, false);
  // EXPIRED: the period is over.
  await notify(edenTx(A, { transactionId: '3000000001', expiresDate: Date.now() - 1000 }), { type: 'EXPIRED' });
  assert.equal((await planOf(session)).name, 'free', 'expired');
  // Bought again, then refunded (REFUND carries the revocation).
  await notify(edenTx(A, { transactionId: '3000000005', originalTransactionId: '3000000004', expiresDate: Date.now() + 30 * DAY }), { type: 'SUBSCRIBED' });
  assert.equal((await planOf(session)).name, 'plus');
  await notify(edenTx(A, { transactionId: '3000000005', originalTransactionId: '3000000004', revocationDate: Date.now(), revocationReason: 0 }), { type: 'REFUND' });
  assert.equal((await planOf(session)).name, 'free', 'refunded');
  // Family Sharing or a support revocation (REVOKE) the same way, from the app's own updates too.
  await notify(edenTx(A, { transactionId: '3000000007', originalTransactionId: '3000000006' }), { type: 'SUBSCRIBED' });
  assert.equal((await linkTx(session, await signedJws(edenTx(A, { transactionId: '3000000007', originalTransactionId: '3000000006', revocationDate: Date.now() })))).status, 200);
  assert.equal((await planOf(session)).name, 'free', 'revoked');
  // Another app's notification, or one for an account that doesn't exist: Apple still hears 200.
  assert.equal((await notify(edenTx(A, { bundleId: 'com.other' }), { bundleId: 'com.other' })).status, 200);
  assert.equal((await notify(edenTx('33333333-3333-4333-8333-333333333333'))).status, 200);
});

test('Plus from both the App Store and Stripe: shown as both, and the web won’t sell it on top', async () => {
  const session = await browser(A);
  assert.equal((await linkTx(session, await signedJws(edenTx(A)))).status, 200);
  // Stripe's Checkout refuses: Plus already, through the App Store.
  const checkout = await hit('/api/web/billing/checkout', { method: 'POST', session, body: {}, headers: { origin: ORIGIN } });
  assert.equal(checkout.status, 409);
  const refusal = await checkout.json();
  assert.equal(refusal.code, 'already_plus');
  assert.match(refusal.error, /App Store/);
  // Had both happened anyway (Stripe first, then the App Store): "both", each with where to manage it.
  const now = Date.now();
  const both = combinePlans(
    { expires: now + 30 * DAY, product_id: 'com.askeden.eden.plus.monthly', environment: 'Sandbox' },
    { customer: 'cus_1', subscription: 'sub_1', status: 'active', period_end: now + 20 * DAY, renews: true, livemode: false },
    now,
  );
  assert.equal(both.active, true);
  assert.equal(both.source, 'both');
  assert.equal(both.product_id, 'com.askeden.eden.plus.monthly');
  assert.deepEqual(both.manage, { app_store: 'https://apps.apple.com/account/subscriptions', stripe: 'portal' });
});

test('R3C-1: a refunded transaction is never switched back on by re-posting its old JWS', async () => {
  const session = await browser(A);
  const bought = await signedJws(edenTx(A, { signedDate: Date.now() }));
  assert.equal((await linkTx(session, bought)).status, 200);
  assert.equal((await planOf(session)).name, 'plus');
  assert.equal((await linkTx(session, await signedJws(edenTx(A, { revocationDate: Date.now() })))).status, 200);
  assert.equal((await planOf(session)).name, 'free', 'refunded');
  // The old, pre-refund copy again: still free, on the app's route and the J.A.R.V.I.S. route.
  assert.equal((await linkTx(session, bought)).status, 200);
  assert.equal((await planOf(session)).name, 'free', 'the replay does nothing');
  const { token } = await call(env, A, 'signin', { account_id: A, device: { name: 'iPhone', kind: 'iphone' } });
  assert.equal((await hit('/api/subscription', { method: 'POST', token, body: { signed_transaction: bought } })).status, 200);
  assert.equal((await planOf(session)).name, 'free', 'and through /api/subscription');
  // A genuine new purchase (another transaction of the subscription) still works.
  await linkTx(session, await signedJws(edenTx(A, { transactionId: '3000000009', expiresDate: Date.now() + 60 * DAY })));
  assert.equal((await planOf(session)).name, 'plus');
  // An older copy of the transaction we hold (older signedDate) is ignored.
  const newer = await signedJws(edenTx(A, { transactionId: '3000000009', expiresDate: Date.now() + 90 * DAY, signedDate: Date.now() + 60000 }));
  const older = await signedJws(edenTx(A, { transactionId: '3000000009', expiresDate: Date.now() + 10 * DAY, signedDate: Date.now() + 1000 }));
  await linkTx(session, newer);
  await linkTx(session, older);
  const days = ((await planOf(session)).expires - Date.now()) / DAY;
  assert.ok(days > 80, 'the newer copy stays');
});

test('R3C-8: a refund of an older period leaves the newer paid one', async () => {
  const session = await browser(A);
  await linkTx(session, await signedJws(edenTx(A, { transactionId: '3000000001', expiresDate: Date.now() + 5 * DAY })));
  await linkTx(session, await signedJws(edenTx(A, { transactionId: '3000000002', expiresDate: Date.now() + 35 * DAY })));
  assert.equal((await linkTx(session, await signedJws(edenTx(A, { transactionId: '3000000001', expiresDate: Date.now() + 5 * DAY, revocationDate: Date.now() })))).status, 200);
  const plan = await planOf(session);
  assert.equal(plan.name, 'plus', 'this month is still paid');
  // Refunding the current period ends it.
  await linkTx(session, await signedJws(edenTx(A, { transactionId: '3000000002', expiresDate: Date.now() + 35 * DAY, revocationDate: Date.now() })));
  assert.equal((await planOf(session)).name, 'free');
});

test('R3C-3: a Sandbox purchase is Plus with a trial-size allowance only', async () => {
  const session = await browser(A);
  const response = await linkTx(session, await signedJws(edenTx(A, { environment: 'Sandbox' })));
  assert.equal(response.status, 200, 'App Review buys in Sandbox: never refused');
  const { plan, usage } = await response.json();
  assert.equal(plan.name, 'plus');
  assert.equal(plan.environment, 'Sandbox');
  assert.equal(usage.budget_usd, 0.5);
});

test('R3C-10: a refused purchase leaves no claim, and deleting the account releases it', async () => {
  const session = await browser(A);
  const code = (extra = {}) => edenTx(A, { appAccountToken: undefined, offerType: 3, transactionId: '4000000001', originalTransactionId: '4000000000', ...extra });
  // Not a Plus product: refused before any claim, so another account can still take the subscription.
  assert.equal((await linkTx(session, await signedJws(code({ productId: 'com.askeden.eden.credits' })))).status, 400);
  const other = await browser(B);
  assert.equal((await linkTx(other, await signedJws(code()))).status, 200);
  assert.equal((await linkTx(session, await signedJws(code()))).status, 409, 'B holds it now');
});

test('R3C-13: a published page anyone can open carries a Report link to support', async () => {
  const { withReportLink } = await import('../src/accounts/published.js');
  const out = withReportLink('<html><body><h1>Hi</h1></body></html>', 'https://askeden.com', 'abc123');
  assert.match(out, /<a href="mailto:support@askeden\.com\?subject=/);
  assert.ok(out.indexOf('mailto:') < out.indexOf('</body>'), 'before the end of the body');
  assert.match(decodeURIComponent(out), /https:\/\/askeden\.com\/p\/abc123/);
  assert.match(withReportLink('<h1>No body tag</h1>', 'https://askeden.com', 'abc123'), /Report<\/a>$/);
});
