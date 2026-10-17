// Eden Plus bought in Eden for Android with Google Play Billing (askeden/android plus/PlusStore.kt):
// the app posts each purchase token to POST /api/web/billing/google with its web view's session
// cookie; askeden.com reads the subscription from a fake Google Play Developer API (service-account
// JWT → access token → subscriptionsv2.get), grants Plus, acknowledges; Real-time Developer
// Notifications arrive at /api/googleplay/notifications with Pub/Sub's OIDC token.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call, callIdentity, subHashOf } from '../src/accounts/index.js';
import { PLAY_PLUS_PRODUCTS, playActive, playCap, withPlayPlan } from '../src/accounts/play-plan.js';
import { playFacts, testOnlyPlayFetch } from '../src/accounts/google-play.js';
import { combinePlans } from '../src/accounts/stripe-plan.js';
import { b64ToBytes, b64url, b64urlText, bytesToB64 } from '../src/accounts/util.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const DAY = 86400_000;
const PUSHER = 'play-rtdn@eden-510902.iam.gserviceaccount.com';
const ctx = { waitUntil: () => {} };

let env;
let keys; // { sa: { privatePem, publicKey }, oidc: { privateKey, jwk } }
let google; // the fake Google's state

const pem = (der) => `-----BEGIN PRIVATE KEY-----\n${bytesToB64(new Uint8Array(der)).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;
const rsa = () => crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);

before(async () => {
  const sa = await rsa();
  const oidc = await rsa();
  const jwk = await crypto.subtle.exportKey('jwk', oidc.publicKey);
  keys = {
    sa: { privatePem: pem(await crypto.subtle.exportKey('pkcs8', sa.privateKey)), publicKey: sa.publicKey },
    oidc: { privateKey: oidc.privateKey, jwk: { kty: 'RSA', n: jwk.n, e: jwk.e, kid: 'k1', alg: 'RS256', use: 'sig' } },
  };
});

after(() => testOnlyPlayFetch(null));

// A fake Google: OAuth token endpoint (checks the service account's JWT), the Play Developer API, its certs.
async function fakeGoogle(url, init = {}) {
  const u = new URL(url);
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (u.href === 'https://oauth2.googleapis.com/token') {
    const assertion = new URLSearchParams(init.body).get('assertion');
    const [h, c, s] = assertion.split('.');
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', keys.sa.publicKey, b64ToBytes(s), new TextEncoder().encode(`${h}.${c}`));
    const claims = JSON.parse(new TextDecoder().decode(b64ToBytes(c)));
    if (!ok || claims.scope !== 'https://www.googleapis.com/auth/androidpublisher' || claims.iss !== 'eden-play@eden-510902.iam.gserviceaccount.com') return reply({ error: 'invalid_grant' }, 400);
    google.signIns++;
    return reply({ access_token: 'ya29.fake', expires_in: 3600 });
  }
  if (u.href === 'https://www.googleapis.com/oauth2/v3/certs') return reply({ keys: [keys.oidc.jwk] });
  const base = '/androidpublisher/v3/applications/com.askeden.eden/purchases/';
  if (u.hostname === 'androidpublisher.googleapis.com' && u.pathname.startsWith(base)) {
    if ((init.headers || {}).authorization !== 'Bearer ya29.fake') return reply({ error: { code: 401 } }, 401);
    if (google.down) return reply({ error: { code: 500 } }, 500);
    const rest = decodeURIComponent(u.pathname.slice(base.length));
    const get = /^subscriptionsv2\/tokens\/(.+)$/.exec(rest);
    if (get && (init.method || 'GET') === 'GET') return google.subs[get[1]] ? reply(google.subs[get[1]]) : reply({ error: { code: 404 } }, 404);
    const ack = /^subscriptions\/([^/]+)\/tokens\/(.+):acknowledge$/.exec(rest);
    if (ack && init.method === 'POST') {
      google.acks.push([ack[1], ack[2]]);
      if (google.subs[ack[2]]) google.subs[ack[2]].acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
      return reply({});
    }
  }
  return reply({ error: 'unexpected' }, 599);
}

beforeEach(() => {
  forgetSessions();
  google = { subs: {}, acks: [], signIns: 0, down: false };
  testOnlyPlayFetch(fakeGoogle);
  env = {
    TRIAL_BUDGET_USD: '1',
    PLUS_BUDGET_USD: '6',
    PLUS_LEGACY_BUDGET_USD: '20',
    LINK_RATE: rateLimiter(),
    API_RATE: rateLimiter(),
    EDEN_RATE: rateLimiter(),
    AUTH_RATE: rateLimiter(),
    GOOGLE_PLAY_SERVICE_ACCOUNT: JSON.stringify({ type: 'service_account', client_email: 'eden-play@eden-510902.iam.gserviceaccount.com', private_key: keys.sa.privatePem, private_key_id: 'abc' }),
    GOOGLE_PLAY_RTDN_EMAIL: PUSHER,
  };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.IDENTITIES = namespace(Identity, env);
  env.ASSETS = { fetch: async () => new Response('asset') };
});

/** A SubscriptionPurchaseV2 as Google returns it. */
const playSub = (account, extra = {}, item = {}) => ({
  kind: 'androidpublisher#subscriptionPurchaseV2',
  regionCode: 'FR',
  startTime: new Date(Date.now() - DAY).toISOString(),
  subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
  latestOrderId: 'GPA.3333-4444-5555-66666',
  acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
  ...(account ? { externalAccountIdentifiers: { obfuscatedExternalAccountId: account } } : {}),
  lineItems: [{ productId: 'com.askeden.eden.plus.monthly', expiryTime: new Date(Date.now() + 30 * DAY).toISOString(), autoRenewingPlan: { autoRenewEnabled: true }, offerDetails: { basePlanId: 'monthly' }, ...item }],
  ...extra,
});

const browser = async (account) => (await call(env, account, 'web-signin', { account_id: account, create: true, device: { name: 'Eden on the web: Eden for Android' } })).token;

function hit(path, { method = 'GET', body, session, headers = {} } = {}) {
  const h = { 'user-agent': 'Mozilla/5.0 (Linux; Android 15) EdenApp/1.0 EdenAndroid/1.0', ...headers };
  if (session) h.cookie = `__Host-eden=${session}`;
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
}

const link = (session, token, product = 'com.askeden.eden.plus.monthly') => hit('/api/web/billing/google', { method: 'POST', session, body: { purchase_token: token, product_id: product } });
const planOf = async (session) => (await (await hit('/api/web/account', { session })).json()).plan;
const usageOf = async (session) => (await (await hit('/api/web/account', { session })).json()).usage;

async function oidc(claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64urlText(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const body = b64urlText(JSON.stringify({ iss: 'https://accounts.google.com', aud: `${ORIGIN}/api/googleplay/notifications`, email: PUSHER, email_verified: true, iat: now, exp: now + 3600, sub: '1', ...claims }));
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.oidc.privateKey, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

async function push(note, { token, claims } = {}) {
  const data = bytesToB64(new TextEncoder().encode(JSON.stringify({ version: '1.0', packageName: 'com.askeden.eden', eventTimeMillis: String(Date.now()), ...note })));
  const bearer = token === undefined ? await oidc(claims) : token;
  return hit('/api/googleplay/notifications', { method: 'POST', headers: bearer ? { authorization: `Bearer ${bearer}` } : {}, body: { message: { data, messageId: '1' }, subscription: 'projects/eden/subscriptions/play' } });
}
const subNote = (token, type = 2, id = 'com.askeden.eden.plus.monthly') => ({ subscriptionNotification: { version: '1.0', notificationType: type, purchaseToken: token, subscriptionId: id } });

test('a Play purchase made for this account: Plus from Google Play at today’s allowance, then acknowledged', async () => {
  const session = await browser(A);
  google.subs['tok-aaaa-1111'] = playSub(A);
  const response = await link(session, 'tok-aaaa-1111');
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.plan.name, 'plus');
  assert.equal(body.plan.source, 'google_play');
  assert.equal(body.plan.product_id, 'com.askeden.eden.plus.monthly');
  assert.equal(body.plan.environment, 'Production');
  assert.equal(body.plan.renews, true);
  assert.match(body.plan.manage.google_play, /^https:\/\/play\.google\.com\/store\/account\/subscriptions\?sku=com\.askeden\.eden\.plus\.monthly&package=com\.askeden\.eden$/);
  assert.equal(body.plan.manage.app_store, null);
  assert.equal(body.usage.budget_usd, 6);
  assert.equal(body.acknowledged, true);
  assert.deepEqual(google.acks, [['com.askeden.eden.plus.monthly', 'tok-aaaa-1111']], 'acknowledged once the account had it');
  // Again (the app at its next launch): no harm, no second acknowledgement, one sign-in to Google kept.
  assert.equal((await link(session, 'tok-aaaa-1111')).status, 200);
  assert.equal(google.acks.length, 1);
  assert.equal(google.signIns, 1);
  assert.equal((await planOf(session)).source, 'google_play');
});

test('another account’s purchase, a pending one, an unknown token, a non-Plus product: refused, nothing kept', async () => {
  const session = await browser(A);
  google.subs['tok-bbbb-2222'] = playSub(B);
  const other = await link(session, 'tok-bbbb-2222');
  assert.equal(other.status, 403);
  assert.equal((await other.json()).code, 'forbidden');
  assert.equal((await callIdentity(env, 'googleplay', await subHashOf('googleplay', 'tok-bbbb-2222'), 'get')).state, 'none', 'no claim left behind');
  google.subs['tok-pend-3333'] = playSub(A, { subscriptionState: 'SUBSCRIPTION_STATE_PENDING' });
  const pending = await link(session, 'tok-pend-3333');
  assert.equal(pending.status, 409);
  assert.equal((await pending.json()).code, 'pending');
  assert.equal((await link(session, 'tok-none-4444')).status, 400);
  google.subs['tok-coin-5555'] = playSub(A, {}, { productId: 'com.askeden.eden.coins' });
  assert.equal((await link(session, 'tok-coin-5555')).status, 400);
  assert.equal((await link(session, 'x')).status, 400, 'not a token');
  assert.equal(google.acks.length, 0, 'nothing refused is acknowledged (Google refunds it in 3 days)');
  assert.equal((await planOf(session)).name, 'free');
  // Signed out.
  assert.equal((await link(null, 'tok-aaaa-1111')).status, 401);
});

test('not set up, or Google down: 503, so the app keeps the purchase and tries again', async () => {
  const session = await browser(A);
  google.subs['tok-aaaa-1111'] = playSub(A);
  delete env.GOOGLE_PLAY_SERVICE_ACCOUNT;
  const off = await link(session, 'tok-aaaa-1111');
  assert.equal(off.status, 503);
  assert.equal((await off.json()).code, 'not_set_up');
  env.GOOGLE_PLAY_SERVICE_ACCOUNT = JSON.stringify({ client_email: 'eden-play@eden-510902.iam.gserviceaccount.com', private_key: keys.sa.privatePem });
  google.down = true;
  assert.equal((await link(session, 'tok-aaaa-1111')).status, 503);
  assert.equal(google.acks.length, 0);
  google.down = false;
  assert.equal((await link(session, 'tok-aaaa-1111')).status, 200);
});

test('a code redeemed in the Play Store (no account id): the first account to link it keeps it', async () => {
  const a = await browser(A);
  const b = await browser(B);
  google.subs['tok-code-6666'] = playSub(null);
  assert.equal((await link(a, 'tok-code-6666')).status, 200);
  const taken = await link(b, 'tok-code-6666');
  assert.equal(taken.status, 409);
  assert.equal((await taken.json()).code, 'identity_taken');
  assert.equal((await planOf(b)).name, 'free');
  // Its notifications find the claiming account: it expires there.
  google.subs['tok-code-6666'].subscriptionState = 'SUBSCRIPTION_STATE_EXPIRED';
  google.subs['tok-code-6666'].lineItems[0].expiryTime = new Date(Date.now() - DAY).toISOString();
  assert.equal((await push(subNote('tok-code-6666', 13))).status, 204);
  assert.equal((await planOf(a)).name, 'free');
  // A plan change of it (a new token, linked to the old one) goes to the same account.
  google.subs['tok-code-7777'] = playSub(null, { linkedPurchaseToken: 'tok-code-6666' }, { productId: 'com.askeden.eden.plus.yearly', expiryTime: new Date(Date.now() + 365 * DAY).toISOString() });
  assert.equal((await push(subNote('tok-code-7777', 4, 'com.askeden.eden.plus.yearly'))).status, 204);
  const plan = await planOf(a);
  assert.equal(plan.name, 'plus');
  assert.equal(plan.product_id, 'com.askeden.eden.plus.yearly');
  assert.deepEqual(google.acks.at(-1), ['com.askeden.eden.plus.yearly', 'tok-code-7777'], 'a purchase completed outside the app is acknowledged by the server');
  // Deleting the account frees both tokens.
  const erased = await hit('/api/web/account/delete', { method: 'POST', session: a, headers: { origin: ORIGIN }, body: { confirm: 'DELETE' } });
  assert.equal(erased.status, 204, await erased.clone().text());
  assert.equal((await callIdentity(env, 'googleplay', await subHashOf('googleplay', 'tok-code-6666'), 'get')).state, 'none');
  assert.equal((await link(b, 'tok-code-6666')).status, 200, 'free to claim again');
});

test('notifications: renewals, cancellation, hold and revocation follow Google’s own record', async () => {
  const session = await browser(A);
  google.subs['tok-aaaa-1111'] = playSub(A);
  assert.equal((await link(session, 'tok-aaaa-1111')).status, 200);
  // Cancelled: Plus until the period ends, no longer renewing.
  google.subs['tok-aaaa-1111'].subscriptionState = 'SUBSCRIPTION_STATE_CANCELED';
  google.subs['tok-aaaa-1111'].lineItems[0].autoRenewingPlan = { autoRenewEnabled: false };
  assert.equal((await push(subNote('tok-aaaa-1111', 3))).status, 204);
  let plan = await planOf(session);
  assert.equal(plan.name, 'plus');
  assert.equal(plan.renews, false);
  // Renewed again (restarted), the period moved on.
  google.subs['tok-aaaa-1111'].subscriptionState = 'SUBSCRIPTION_STATE_ACTIVE';
  google.subs['tok-aaaa-1111'].lineItems[0] = { ...google.subs['tok-aaaa-1111'].lineItems[0], autoRenewingPlan: { autoRenewEnabled: true }, expiryTime: new Date(Date.now() + 60 * DAY).toISOString() };
  assert.equal((await push(subNote('tok-aaaa-1111', 2))).status, 204);
  plan = await planOf(session);
  assert.equal(plan.renews, true);
  assert.ok(plan.expires > Date.now() + 59 * DAY);
  // On hold (payment failed past the grace period): no Plus.
  google.subs['tok-aaaa-1111'].subscriptionState = 'SUBSCRIPTION_STATE_ON_HOLD';
  assert.equal((await push(subNote('tok-aaaa-1111', 5))).status, 204);
  assert.equal((await planOf(session)).name, 'free');
  // Back, then revoked (a refund): Google says EXPIRED.
  google.subs['tok-aaaa-1111'].subscriptionState = 'SUBSCRIPTION_STATE_ACTIVE';
  assert.equal((await push(subNote('tok-aaaa-1111', 1))).status, 204);
  assert.equal((await planOf(session)).name, 'plus');
  google.subs['tok-aaaa-1111'].subscriptionState = 'SUBSCRIPTION_STATE_EXPIRED';
  assert.equal((await push({ voidedPurchaseNotification: { purchaseToken: 'tok-aaaa-1111', orderId: 'GPA.1', productType: 1, refundType: 1 } })).status, 204);
  assert.equal((await planOf(session)).name, 'free');
  // An old copy of the app posting the token again changes nothing: Google is asked, not the app.
  assert.equal((await link(session, 'tok-aaaa-1111')).status, 200);
  assert.equal((await planOf(session)).name, 'free');
});

test('notifications must be Pub/Sub’s, for this endpoint, from the named service account', async () => {
  const session = await browser(A);
  google.subs['tok-aaaa-1111'] = playSub(A);
  assert.equal((await push(subNote('tok-aaaa-1111'), { token: null })).status, 401);
  assert.equal((await push(subNote('tok-aaaa-1111'), { claims: { email: 'someone@else.iam.gserviceaccount.com' } })).status, 401);
  assert.equal((await push(subNote('tok-aaaa-1111'), { claims: { aud: 'https://evil.example/x' } })).status, 401);
  assert.equal((await push(subNote('tok-aaaa-1111'), { claims: { iss: 'https://evil.example' } })).status, 401);
  assert.equal((await push(subNote('tok-aaaa-1111'), { claims: { exp: Math.floor(Date.now() / 1000) - 3600 } })).status, 401);
  const forged = (await oidc()).slice(0, -6) + 'AAAAAA';
  assert.equal((await push(subNote('tok-aaaa-1111'), { token: forged })).status, 401);
  assert.equal((await planOf(session)).name, 'free', 'nothing applied');
  // The right one: the account gets Plus (bought while the app was closed) and Google gets its acknowledgement.
  assert.equal((await push(subNote('tok-aaaa-1111', 4))).status, 204);
  assert.equal((await planOf(session)).name, 'plus');
  assert.equal(google.acks.length, 1);
  // A test notification, another app, an unknown token, nobody's token: 204 (Pub/Sub needn't retry).
  assert.equal((await push({ testNotification: { version: '1.0' } })).status, 204);
  assert.equal((await push({ ...subNote('tok-aaaa-1111'), packageName: 'com.other' })).status, 204);
  assert.equal((await push(subNote('tok-none-9999'))).status, 204);
  google.subs['tok-nobody-0000'] = playSub(null);
  assert.equal((await push(subNote('tok-nobody-0000'))).status, 204);
  // Not set up (no pusher named): 503.
  delete env.GOOGLE_PLAY_RTDN_EMAIL;
  assert.equal((await push(subNote('tok-aaaa-1111'))).status, 503);
});

test('a test purchase (license tester) is Plus with the Sandbox allowance', async () => {
  const session = await browser(A);
  google.subs['tok-test-1234'] = playSub(A, { testPurchase: {} });
  const body = await (await link(session, 'tok-test-1234')).json();
  assert.equal(body.plan.environment, 'Sandbox');
  assert.equal(body.usage.budget_usd, 0.5);
  assert.equal((await usageOf(session)).budget_usd, 0.5);
});

test('Google Play beside the other plans: "both" with a paid one, alone over a promo code', () => {
  const now = Date.now();
  const play = playFacts(playSub(A), 'tok-aaaa-1111', now);
  assert.deepEqual(PLAY_PLUS_PRODUCTS, ['com.askeden.eden.plus.monthly', 'com.askeden.eden.plus.yearly']);
  assert.equal(play.account, A);
  assert.equal(play.base_plan, 'monthly');
  assert.equal(playActive(play, now), true);
  assert.equal(playActive({ ...play, state: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', expires: now - DAY }, now), true, 'Google retrying the card');
  assert.equal(playActive({ ...play, state: 'SUBSCRIPTION_STATE_PAUSED' }, now), false);
  assert.equal(playActive({ ...play, state: 'SUBSCRIPTION_STATE_CANCELED', expires: now - 1 }, now), false);
  const free = combinePlans({}, null, now);
  assert.equal(withPlayPlan(free, null, now), free, 'no Play plan: unchanged');
  const alone = withPlayPlan(free, play, now);
  assert.equal(alone.source, 'google_play');
  assert.equal(alone.active, true);
  const apple = combinePlans({ product_id: 'com.askeden.eden.plus.monthly', expires: now + 10 * DAY }, null, now);
  const both = withPlayPlan(apple, play, now);
  assert.equal(both.source, 'both');
  assert.equal(both.expires, play.expires, 'the later end shows');
  const promo = combinePlans({}, null, now, { until: now + 5 * DAY });
  assert.equal(withPlayPlan(promo, play, now).source, 'google_play');
  const gone = withPlayPlan(free, { ...play, state: 'SUBSCRIPTION_STATE_EXPIRED' }, now);
  assert.equal(gone.active, false);
  assert.equal(gone.manage.google_play, null);
});

test('the allowance with Google Play: never the legacy $20 from "both", the larger of two', async () => {
  const caps = { plus: 6, sandbox: 0.5, legacy: 20, unlimited: 1000 };
  const now = Date.now();
  const play = playFacts(playSub(A), 't0000000001', now);
  const inner = async (base) => (base.source === 'stripe' ? 20 : base.source === 'app_store' ? 6 : 0);
  assert.equal(await playCap(withPlayPlan(combinePlans({}, null, now), play, now), caps, inner), 6);
  const stripeLegacy = { ...combinePlans({}, null, now), active: true, source: 'stripe', expires: now + DAY };
  assert.equal(await playCap(withPlayPlan(stripeLegacy, play, now), caps, inner), 20, 'a grandfathered Stripe plan keeps its own');
  assert.equal(await playCap({ ...withPlayPlan(combinePlans({}, null, now), { ...play, test: true }, now) }, caps, inner), 0.5);
  assert.equal(await playCap({ ...withPlayPlan(combinePlans({}, null, now), play, now), unlimited: true }, caps, inner), 1000);
});
