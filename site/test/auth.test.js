// Signing in to Eden on the web (docs/web-auth.md): Identity objects, Sign in with Apple and
// with Google making accounts, linking a second method and its refusals, unlinking (never the
// last), the Eden app's one-time handoff, browsers signing browsers out, and the abuse limits.
// Apple's and Google's keys are WebCrypto RSA keys made here (fakes.js).
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetAppleKeys, verifyIdentityToken } from '../src/accounts/apple.js';
import { accountIdFor, b64url, parseToken, sha256 } from '../src/accounts/util.js';
import { forgetGoogleKeys, verifyIdToken } from '../src/eden/google.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, GOOGLE_CLIENT, Identity, Link, appleJwk, google, googleIdToken, identityToken, namespace, rateLimiter, rsaSigner } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const SERVICES_ID = 'com.askeden.eden.web';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';

let env;
let calls;
let googleKeys; // what Google's certs endpoint answers
let tokenAnswer; // (form) => Response, for Google's token endpoint
let nextGoogle; // the person who signs in at Google next: { sub, email, email_verified, aud }
const ctx = { waitUntil: () => {} };
const realFetch = globalThis.fetch;

function makeEnv(extra = {}) {
  const e = {
    TRIAL_BUDGET_USD: '1',
    PLUS_BUDGET_USD: '20',
    WEB_APPLE_SERVICES_ID: SERVICES_ID,
    GOOGLE_CLIENT_ID: GOOGLE_CLIENT,
    GOOGLE_CLIENT_SECRET: 'test-secret',
    AUTH_RATE: rateLimiter(),
    LINK_RATE: rateLimiter(),
    EDEN_RATE: rateLimiter(),
    ...extra,
  };
  e.ACCOUNTS = namespace(Account, e);
  e.LINKS = namespace(Link, e);
  e.IDENTITIES = namespace(Identity, e);
  e.ASSETS = { fetch: async (req) => new Response(`asset ${new URL(req.url).pathname}`, { headers: { 'content-type': 'text/html' } }) };
  return e;
}

beforeEach(() => {
  calls = [];
  forgetAppleKeys();
  forgetGoogleKeys();
  forgetSessions();
  googleKeys = () => [google.jwk];
  nextGoogle = { sub: 'google-user-1', email: 'Person@Example.com' };
  tokenAnswer = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: googleKeys() }, { headers: { 'cache-control': 'public, max-age=20000' } });
    if (url === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(init.body);
      if (tokenAnswer) return tokenAnswer(form);
      return Response.json({ access_token: 'ya29.x', expires_in: 3599, scope: 'openid email profile', id_token: await googleIdToken({ ...nextGoogle, nonce: nextGoogle.nonce }) });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  env = makeEnv();
});

after(() => {
  globalThis.fetch = realFetch;
});

async function hit(p, { method = 'GET', body, headers = {}, browser = true, session, token, ip = '198.51.100.7' } = {}) {
  const h = { 'cf-connecting-ip': ip, ...headers };
  if (browser) {
    h['user-agent'] ??= SAFARI;
    if (method !== 'GET' && method !== 'HEAD') h.origin ??= ORIGIN;
  }
  const jar = [];
  if (session) jar.push(`__Host-eden=${session}`);
  if (h.cookie) jar.push(h.cookie);
  if (jar.length) h.cookie = jar.join('; ');
  if (token) h.authorization = `Bearer ${token}`;
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    h['content-type'] ??= 'application/json';
  }
  return worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
}

const setCookies = (response) => response.headers.getSetCookie();
const cookieValue = (response, name) => {
  const found = setCookies(response).find((c) => c.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1).split(';')[0] : undefined;
};
const cleared = (response, name) => setCookies(response).some((c) => c.startsWith(`${name}=;`) && c.includes('Max-Age=0'));

/** Where a finished sign-in sends the browser: a 303's Location, or the onward page's refresh. */
async function landing(response) {
  if (response.status === 303 || response.status === 302) return response.headers.get('location');
  assert.equal(response.status, 200, `status ${response.status}`);
  const html = await response.clone().text();
  const m = /http-equiv="refresh" content="0; url=([^"]+)"/.exec(html);
  assert.ok(m, 'an onward page');
  return m[1].replace(/&amp;/g, '&');
}

/** A whole Sign in with Google: start, Google's consent (faked), the callback. */
async function googleFlow({ sub = 'google-user-1', email = 'person@example.com', link = false, session, ip, extra = {} } = {}) {
  const start = await hit(`/api/web/google${link ? '?link=1' : ''}`, { session, ip });
  if (start.status !== 302) return { response: start };
  const to = new URL(start.headers.get('location'));
  const attempt = cookieValue(start, '__Host-eden-google');
  nextGoogle = { sub, email, nonce: to.searchParams.get('nonce'), challenge: to.searchParams.get('code_challenge'), ...extra };
  const response = await hit(`/api/web/google/callback?state=${to.searchParams.get('state')}&code=4%2Fcode`, { headers: { cookie: `__Host-eden-google=${attempt}` }, ip });
  return { response, start, to, attempt, session: cookieValue(response, '__Host-eden') };
}

/** A whole Sign in with Apple on the web. */
async function appleFlow({ sub = 'apple-user-1', link = false, session, ip, aud = SERVICES_ID } = {}) {
  const start = await hit(`/api/web/apple${link ? '?link=1' : ''}`, { session, ip });
  if (start.status !== 302) return { response: start };
  const attempt = cookieValue(start, '__Host-eden-apple');
  const [state, nonce] = attempt.split('.');
  const response = await hit('/api/web/apple/callback', {
    method: 'POST',
    body: new URLSearchParams({ state, id_token: await identityToken({ sub, nonce, aud }) }).toString(),
    headers: { origin: 'https://appleid.apple.com', 'content-type': 'application/x-www-form-urlencoded', cookie: `__Host-eden-apple=${attempt}` },
    ip,
  });
  return { response, session: cookieValue(response, '__Host-eden') };
}

/** The J.A.R.V.I.S. iPhone app's own Sign in with Apple. */
async function phone(sub = 'apple-user-1') {
  const response = await hit('/api/account/apple', {
    method: 'POST',
    browser: false,
    body: { identity_token: await identityToken({ sub }), nonce: 'raw-nonce', device: { name: "Bilel's iPhone", kind: 'iphone' } },
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

const account = async (session) => {
  const response = await hit('/api/web/account', { session });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};

// ── Google ──

test('config says which buttons to show; Google needs its client id, secret and the IDENTITIES binding', async () => {
  assert.deepEqual(await (await hit('/api/web/config')).json(), { apple: true, google: true, passkey: true, turnstile: null, signups: 'open', code: true, billing: false, billing_in_app: false });
  env.GOOGLE_CLIENT_SECRET = '';
  assert.deepEqual(await (await hit('/api/web/config')).json(), { apple: true, google: false, passkey: true, turnstile: null, signups: 'open', code: true, billing: false, billing_in_app: false });
  const off = await hit('/api/web/google');
  assert.equal(off.status, 303);
  assert.equal(off.headers.get('location'), '/signin?error=not_set_up&provider=google');
  env.GOOGLE_CLIENT_SECRET = 'test-secret';
  env.GOOGLE_CLIENT_ID = 'not-a-client-id';
  assert.equal((await (await hit('/api/web/config')).json()).google, false);
});

test('Sign in with Google: code + PKCE (S256), state, nonce, openid email profile only, a Lax state cookie', async () => {
  const { to, attempt, response, session } = await googleFlow();
  assert.equal(to.origin + to.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const q = Object.fromEntries(to.searchParams);
  assert.equal(q.client_id, GOOGLE_CLIENT);
  assert.equal(q.redirect_uri, 'https://askeden.com/api/web/google/callback');
  assert.equal(q.response_type, 'code');
  assert.equal(q.scope, 'openid email profile');
  assert.equal(q.code_challenge_method, 'S256');
  assert.equal(q.prompt, 'select_account');
  assert.equal(q.include_granted_scopes, 'true');
  assert.ok(q.state.length >= 32 && q.nonce.length >= 32);
  const [state, nonce, verifier, mode] = attempt.split('.');
  assert.equal(state, q.state);
  assert.equal(nonce, q.nonce);
  assert.equal(mode, 's');
  assert.equal(b64url(await sha256(verifier)), q.code_challenge, 'the challenge is S256 of the verifier, which never leaves the server side');
  // The code was traded server-side, with the secret and the verifier.
  const exchange = new URLSearchParams(calls.find((c) => c.url === 'https://oauth2.googleapis.com/token').init.body);
  assert.equal(exchange.get('client_secret'), 'test-secret');
  assert.equal(exchange.get('code_verifier'), verifier);
  assert.equal(exchange.get('code'), '4/code');
  assert.equal(exchange.get('redirect_uri'), 'https://askeden.com/api/web/google/callback');
  // Signed in: an onward page of this site (the cookie is SameSite=Strict), the state cookie gone.
  assert.equal(await landing(response), '/');
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.ok(setCookies(response).some((c) => /^__Host-eden=jv1\.[^;]+; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000$/.test(c)));
  assert.ok(cleared(response, '__Host-eden-google'));
  assert.ok(session);
});

test('a Google account seen for the first time gets a new account on the trial; the same one opens it again', async () => {
  const first = await googleFlow({ email: 'Person@Example.com' });
  const view = await account(first.session);
  assert.match(view.account_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'a random UUID v4');
  assert.equal(view.plan.name, 'free');
  assert.equal(view.usage.trial_left_usd, 1);
  assert.equal(view.usage.trial_usd, 1);
  assert.equal(view.usage.plus_usd, 20);
  assert.deepEqual(view.identities.map(({ provider, email }) => ({ provider, email })), [{ provider: 'google', email: 'person@example.com' }]);
  assert.deepEqual(view.plus, { web_purchase: false, how: 'ios' });
  assert.deepEqual(Object.keys(view.devices[0]).sort(), ['created', 'expires', 'id', 'kind', 'last_seen', 'name', 'this']);
  assert.equal(view.devices[0].kind, 'web');
  assert.equal(view.devices[0].this, true);
  const again = await googleFlow();
  assert.equal((await account(again.session)).account_id, view.account_id);
  assert.equal((await account(again.session)).devices.length, 2);
  const other = await googleFlow({ sub: 'google-user-2', email: 'other@example.com' });
  assert.notEqual((await account(other.session)).account_id, view.account_id);
  // The session endpoint lists identities too; no raw sub is stored on the account.
  const session = await (await hit('/api/web/session', { session: first.session })).json();
  assert.equal(session.identities[0].provider, 'google');
  const stored = JSON.stringify([...env.ACCOUNTS.objects.get(view.account_id).storage.map]);
  assert.ok(!stored.includes('google-user-1'));
});

test('two sign-ins at once with a new Google account make one account', async () => {
  const starts = await Promise.all([hit('/api/web/google'), hit('/api/web/google')]);
  const back = await Promise.all(starts.map(async (start) => {
    const to = new URL(start.headers.get('location'));
    const nonce = to.searchParams.get('nonce');
    const idToken = await googleIdToken({ sub: 'google-race', nonce });
    return { to, cookie: `__Host-eden-google=${cookieValue(start, '__Host-eden-google')}`, idToken };
  }));
  tokenAnswer = (form) => {
    const one = back.find((b) => form.get('code') === b.to.searchParams.get('state'));
    return Response.json({ id_token: one.idToken });
  };
  const done = await Promise.all(back.map((b) => hit(`/api/web/google/callback?state=${b.to.searchParams.get('state')}&code=${b.to.searchParams.get('state')}`, { headers: { cookie: b.cookie } })));
  const ids = await Promise.all(done.map(async (r) => (await account(cookieValue(r, '__Host-eden'))).account_id));
  assert.equal(ids[0], ids[1]);
});

test('the Google callback refuses: another state, no cookie, cancelled, unverified email, wrong audience, a bad code', async () => {
  const start = await hit('/api/web/google');
  const to = new URL(start.headers.get('location'));
  const cookie = `__Host-eden-google=${cookieValue(start, '__Host-eden-google')}`;
  const state = to.searchParams.get('state');
  const back = (query, c = cookie) => hit(`/api/web/google/callback?${query}`, { headers: { cookie: c } });
  const where = async (query, c) => {
    const response = await back(query, c);
    assert.ok(cleared(response, '__Host-eden-google'), 'the state cookie goes, whatever happened');
    assert.equal(cookieValue(response, '__Host-eden'), undefined);
    return landing(response);
  };
  assert.equal(await where(`state=other&code=x`), '/signin?error=state&provider=google');
  assert.equal(await where(`state=${state}&code=x`, ''), '/signin?error=state&provider=google');
  assert.equal(await where(`error=access_denied&state=${state}`), '/signin?error=access_denied&provider=google');
  nextGoogle = { sub: 'g', nonce: to.searchParams.get('nonce'), email_verified: false };
  assert.equal(await where(`state=${state}&code=x`), '/signin?error=email&provider=google');
  nextGoogle = { sub: 'g', nonce: to.searchParams.get('nonce'), aud: 'someone-else.apps.googleusercontent.com' };
  assert.equal(await where(`state=${state}&code=x`), '/signin?error=state&provider=google');
  nextGoogle = { sub: 'g', nonce: 'another-nonce' };
  assert.equal(await where(`state=${state}&code=x`), '/signin?error=state&provider=google');
  tokenAnswer = () => Response.json({ error: 'invalid_grant' }, { status: 400 });
  assert.equal(await where(`state=${state}&code=x`), '/signin?error=state&provider=google');
  assert.equal(env.ACCOUNTS.objects.size, 0, 'no account was made');
});

test('Google id_token checks: issuer forms, expiry, signature, unknown keys and key rotation', async () => {
  const fetcher = (keys) => {
    let n = 0;
    const f = async () => {
      n += 1;
      return Response.json({ keys: keys(n) });
    };
    f.count = () => n;
    return f;
  };
  const opts = (extra = {}) => ({ audience: GOOGLE_CLIENT, nonce: 'n1', fetcher: fetcher(() => [google.jwk]), ...extra });
  assert.equal((await verifyIdToken(await googleIdToken({ nonce: 'n1', iss: 'accounts.google.com' }), opts())).sub, 'google-user-1');
  await assert.rejects(verifyIdToken(await googleIdToken({ nonce: 'n1', iss: 'https://evil.example' }), opts()), /issuer/);
  forgetGoogleKeys();
  await assert.rejects(verifyIdToken(await googleIdToken({ nonce: 'n1', exp: Date.now() / 1000 - 3600 }), opts()), /expired/);
  forgetGoogleKeys();
  const token = await googleIdToken({ nonce: 'n1' });
  const [h, b, s] = token.split('.');
  const forged = `${h}.${b64url(new TextEncoder().encode(JSON.stringify({ ...JSON.parse(atob(b.replace(/-/g, '+').replace(/_/g, '/'))), sub: 'someone-else' })))}.${s}`;
  await assert.rejects(verifyIdToken(forged, opts()), /signature/);
  forgetGoogleKeys();
  await assert.rejects(verifyIdToken(await googleIdToken({ nonce: 'n1' }), opts({ nonce: '' })), /nonce/);
  // Google rotates its keys: an unknown kid reads them again (once), and the new key works.
  forgetGoogleKeys();
  const rotated = await rsaSigner('GOOGLEKID2');
  const f = fetcher((n) => (n === 1 ? [google.jwk] : [google.jwk, rotated.jwk]));
  assert.equal((await verifyIdToken(await googleIdToken({ nonce: 'n1' }), opts({ fetcher: f }))).sub, 'google-user-1');
  assert.equal(f.count(), 1, 'cached');
  assert.equal((await verifyIdToken(await googleIdToken({ nonce: 'n1', signer: rotated }), opts({ fetcher: f }))).sub, 'google-user-1');
  assert.equal(f.count(), 2);
  // An unknown kid again within the minute doesn't make Google's keys be read again.
  const stranger = await rsaSigner('NOBODY');
  await assert.rejects(verifyIdToken(await googleIdToken({ nonce: 'n1', signer: stranger }), opts({ fetcher: f })), /unknown key/);
  assert.equal(f.count(), 2);
});

// ── Apple ──

test('Apple identity tokens: an unknown kid reads the keys again at most once a minute', async () => {
  forgetAppleKeys();
  let n = 0;
  const f = async () => {
    n += 1;
    return Response.json({ keys: [appleJwk] });
  };
  const opts = { audience: 'com.askeden.jarvis', fetcher: f };
  assert.equal((await verifyIdentityToken(await identityToken(), 'raw-nonce', opts)).sub, 'apple-user-1');
  assert.equal(n, 1);
  const stranger = await rsaSigner('NOBODY');
  const junk = await stranger.sign({ iss: 'https://appleid.apple.com', aud: 'com.askeden.jarvis', exp: Date.now() / 1000 + 600, sub: 'x', nonce: 'y' });
  await assert.rejects(verifyIdentityToken(junk, 'raw-nonce', opts), /unknown key/);
  assert.equal(n, 2, 'read again once (Apple may have rotated)');
  for (let i = 0; i < 5; i++) await assert.rejects(verifyIdentityToken(junk, 'raw-nonce', opts), /unknown key/);
  assert.equal(n, 2, 'junk tokens within the minute read nothing');
  assert.equal((await verifyIdentityToken(await identityToken(), 'raw-nonce', opts)).sub, 'apple-user-1');
  assert.equal(n, 2);
  forgetAppleKeys();
});

test('Sign in with Apple on the web: a new Apple ID gets its account (the one the iPhone app opens too)', async () => {
  const web = await appleFlow({ sub: 'apple-new' });
  assert.equal(await landing(web.response), '/');
  const view = await account(web.session);
  assert.equal(view.account_id, await accountIdFor('apple-new'));
  assert.equal(view.usage.trial_left_usd, 1);
  assert.deepEqual(view.identities.map((i) => [i.provider, i.email]), [['apple', null]], 'Apple’s email is never kept');
  const app = await phone('apple-new');
  assert.equal(app.account.id, view.account_id);
  assert.equal(app.new, false);
});

test('accounts the iPhone app made before identities existed keep working and list Apple', async () => {
  const owner = await phone('apple-old');
  const object = env.ACCOUNTS.objects.get(owner.account.id);
  // As such an account is stored: no origin, no identities.
  const stored = await object.storage.get('account');
  delete stored.origin;
  await object.storage.put('account', stored);
  await object.storage.delete('identities');
  env.IDENTITIES.objects.clear();
  const listed = await (await hit('/api/account', { browser: false, token: owner.token })).json();
  assert.deepEqual(listed.identities.map((i) => i.provider), ['apple']);
  const again = await phone('apple-old');
  assert.equal(again.account.id, owner.account.id);
  const web = await appleFlow({ sub: 'apple-old' });
  assert.equal((await account(web.session)).account_id, owner.account.id);
});

// ── linking ──

test('linking Google to an Apple account: the signed-in browser, fresh proof, then either way in opens it', async () => {
  const apple = await appleFlow({ sub: 'apple-a' });
  const linked = await googleFlow({ sub: 'google-a', email: 'a@example.com', link: true, session: apple.session });
  assert.equal(linked.attempt.split('.')[3], 'l');
  assert.equal(await landing(linked.response), '/#account');
  assert.equal(linked.session, undefined, 'linking sets no new session');
  const view = await account(apple.session);
  assert.deepEqual(view.identities.map((i) => i.provider), ['apple', 'google']);
  const viaGoogle = await googleFlow({ sub: 'google-a' });
  assert.equal((await account(viaGoogle.session)).account_id, view.account_id);
});

test('an Apple ID linked to a Google-first account opens that account in the iPhone app too', async () => {
  const first = await googleFlow({ sub: 'google-b' });
  const id = (await account(first.session)).account_id;
  const linked = await appleFlow({ sub: 'apple-b', link: true, session: first.session });
  assert.equal(await landing(linked.response), '/#account');
  const app = await phone('apple-b');
  assert.equal(app.account.id, id);
  assert.notEqual(id, await accountIdFor('apple-b'));
  assert.deepEqual(app.account.identities.map((i) => i.provider), ['google', 'apple']);
});

test('linking is refused: signed out, an identity that opens another account, a second Google, a replayed callback', async () => {
  // Not signed in (a cross-site navigation wouldn't carry the SameSite=Strict cookie either).
  const anon = await googleFlow({ link: true });
  assert.equal(await landing(anon.response), '/signin?error=signed_out&provider=google');

  const mine = await googleFlow({ sub: 'google-mine' });
  const theirs = await googleFlow({ sub: 'google-theirs' });
  const taken = await googleFlow({ sub: 'google-theirs', link: true, session: mine.session });
  assert.equal(await landing(taken.response), '/#account?error=identity_taken&provider=google');
  // An Apple ID the iPhone app made an account for belongs to that account.
  await phone('apple-app-made');
  const appleTaken = await appleFlow({ sub: 'apple-app-made', link: true, session: mine.session });
  assert.equal(await landing(appleTaken.response), '/#account?error=identity_taken&provider=apple');
  // One Google per account; the refused one is left as it was (its own new account later).
  const second = await googleFlow({ sub: 'google-second', link: true, session: mine.session });
  assert.equal(await landing(second.response), '/#account?error=taken&provider=google');
  const alone = await googleFlow({ sub: 'google-second' });
  const mineId = (await account(mine.session)).account_id;
  assert.notEqual((await account(alone.session)).account_id, mineId);
  assert.notEqual((await account(alone.session)).account_id, (await account(theirs.session)).account_id);
  assert.deepEqual((await account(mine.session)).identities.map((i) => i.provider), ['google']);

  // The attempt is single use: the same callback again is too late.
  const start = await hit('/api/web/apple?link=1', { session: mine.session });
  const attempt = cookieValue(start, '__Host-eden-apple');
  const [state, nonce] = attempt.split('.');
  const post = async () => hit('/api/web/apple/callback', {
    method: 'POST',
    body: new URLSearchParams({ state, id_token: await identityToken({ sub: 'apple-fresh', nonce, aud: SERVICES_ID }) }).toString(),
    headers: { origin: 'https://appleid.apple.com', 'content-type': 'application/x-www-form-urlencoded', cookie: `__Host-eden-apple=${attempt}` },
  });
  assert.equal(await landing(await post()), '/#account');
  assert.equal(await landing(await post()), '/#account?error=expired&provider=apple');

  // The browser signed out between the start and the callback: nothing is linked.
  const other = await googleFlow({ sub: 'google-other' });
  const begin = await hit('/api/web/apple?link=1', { session: other.session });
  await hit('/api/web/signout', { method: 'POST', body: {}, session: other.session });
  const a2 = cookieValue(begin, '__Host-eden-apple');
  const [s2, n2] = a2.split('.');
  const late = await hit('/api/web/apple/callback', {
    method: 'POST',
    body: new URLSearchParams({ state: s2, id_token: await identityToken({ sub: 'apple-late', nonce: n2, aud: SERVICES_ID }) }).toString(),
    headers: { origin: 'https://appleid.apple.com', 'content-type': 'application/x-www-form-urlencoded', cookie: `__Host-eden-apple=${a2}` },
  });
  assert.equal(await landing(late), '/#account?error=signed_out&provider=apple');
  const fresh = await appleFlow({ sub: 'apple-late' });
  assert.equal((await account(fresh.session)).account_id, await accountIdFor('apple-late'), 'apple-late was left unclaimed');
});

// ── unlinking ──

test('unlinking: never the last way in; an unlinked identity opens a new account afterwards', async () => {
  const g = await googleFlow({ sub: 'google-u' });
  const id = (await account(g.session)).account_id;
  const last = await hit('/api/web/identities/google/unlink', { method: 'POST', body: {}, session: g.session });
  assert.equal(last.status, 409);
  assert.equal((await last.json()).code, 'last_method');
  assert.equal((await hit('/api/web/identities/apple/unlink', { method: 'POST', body: {}, session: g.session })).status, 404);
  await appleFlow({ sub: 'apple-u', link: true, session: g.session });
  const done = await hit('/api/web/identities/google/unlink', { method: 'POST', body: {}, session: g.session });
  assert.equal(done.status, 200, await done.clone().text());
  assert.deepEqual((await done.json()).identities.map((i) => i.provider), ['apple']);
  const again = await googleFlow({ sub: 'google-u' });
  assert.notEqual((await account(again.session)).account_id, id, 'that Google account no longer opens it');
  assert.equal((await account((await appleFlow({ sub: 'apple-u' })).session)).account_id, id);
  // Another site can't unlink: a foreign Origin is refused before anything.
  assert.equal((await hit('/api/web/identities/apple/unlink', { method: 'POST', body: {}, session: g.session, headers: { origin: 'https://evil.example' } })).status, 403);
});

test('unlinking the Apple ID an account was made from: Apple sign-in then makes a new account', async () => {
  const owner = await phone('apple-derived');
  const web = await appleFlow({ sub: 'apple-derived' });
  await googleFlow({ sub: 'google-d', link: true, session: web.session });
  const out = await hit('/api/web/identities/apple/unlink', { method: 'POST', body: {}, session: web.session });
  assert.equal(out.status, 200);
  const app = await phone('apple-derived');
  assert.notEqual(app.account.id, owner.account.id, 'not the account its id derives from any more');
  assert.equal(app.new, true);
  assert.equal((await account((await googleFlow({ sub: 'google-d' })).session)).account_id, owner.account.id);
});

test('an account made before identities were kept: Apple is unlinked only after one more Apple sign-in', async () => {
  const owner = await phone('apple-legacy');
  const object = env.ACCOUNTS.objects.get(owner.account.id);
  const stored = await object.storage.get('account');
  delete stored.origin;
  await object.storage.put('account', stored);
  await object.storage.delete('identities');
  env.IDENTITIES.objects.clear();
  // A browser signed in with a code the app approved.
  const link = await (await hit('/api/web/link', { method: 'POST', body: {} })).clone();
  const code = (await link.json()).code;
  await hit(`/api/link/${code}/approve`, { method: 'POST', browser: false, token: owner.token, body: {} });
  const polled = await hit('/api/web/link/poll', { method: 'POST', body: {}, headers: { cookie: `__Host-eden-link=${cookieValue(link, '__Host-eden-link')}` } });
  const session = cookieValue(polled, '__Host-eden');
  await googleFlow({ sub: 'google-l', link: true, session });
  // Apple's sub isn't known here yet (nothing stored it): prove it once more first.
  const early = await hit('/api/web/identities/apple/unlink', { method: 'POST', body: {}, session });
  assert.equal((await early.json()).code, 'needs_proof');
  // Another Apple ID can't take the app's Apple slot.
  const intruder = await appleFlow({ sub: 'apple-intruder', link: true, session });
  assert.equal(await landing(intruder.response), '/#account?error=taken&provider=apple');
  const proof = await appleFlow({ sub: 'apple-legacy', link: true, session });
  assert.equal(await landing(proof.response), '/#account');
  assert.equal((await hit('/api/web/identities/apple/unlink', { method: 'POST', body: {}, session })).status, 200);
});

test('deleting the account lets its identities go: each opens a new account next time', async () => {
  const g = await googleFlow({ sub: 'google-del' });
  const id = (await account(g.session)).account_id;
  await appleFlow({ sub: 'apple-del', link: true, session: g.session });
  const app = await phone('apple-del');
  assert.equal(app.account.id, id);
  assert.equal((await hit('/api/account', { method: 'DELETE', browser: false, token: app.token })).status, 204);
  assert.equal((await hit('/api/web/account', { session: g.session })).status, 401);
  const google2 = await googleFlow({ sub: 'google-del' });
  assert.notEqual((await account(google2.session)).account_id, id);
  assert.equal((await phone('apple-del')).account.id, await accountIdFor('apple-del'));
});

// ── the Eden iOS app's handoff ──

test('the Eden app: native Apple sign-in → a one-time handoff code → the cookie in its web view', async () => {
  const native = (body, headers = {}) => hit('/api/web/native/apple', { method: 'POST', browser: false, body, headers });
  // The J.A.R.V.I.S. app's audience isn't Eden's; the nonce must match.
  assert.equal((await native({ identity_token: await identityToken({ sub: 'apple-eden', nonce: 'n' }), nonce: 'n' })).status, 401);
  assert.equal((await native({ identity_token: await identityToken({ sub: 'apple-eden', nonce: 'n', aud: 'com.askeden.eden' }), nonce: 'other' })).status, 401);
  assert.equal((await native({ identity_token: await identityToken({ sub: 'apple-eden', nonce: 'n', aud: 'com.askeden.eden' }), nonce: 'n' }, { origin: 'https://evil.example' })).status, 403, 'a page elsewhere is refused');
  const made = await native({ identity_token: await identityToken({ sub: 'apple-eden', nonce: 'n', aud: 'com.askeden.eden' }), nonce: 'n' });
  assert.equal(made.status, 200, await made.clone().text());
  const { handoff, expires_in } = await made.json();
  assert.match(handoff, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(expires_in, 60);
  // Another site linking here (a login CSRF) is refused, and doesn't use the code up.
  const csrf = await hit(`/api/web/handoff?code=${handoff}`, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(await landing(csrf), '/signin?error=state');
  const ok = await hit(`/api/web/handoff?code=${handoff}`, { headers: { 'sec-fetch-site': 'none' } });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), '/');
  const session = cookieValue(ok, '__Host-eden');
  assert.ok(setCookies(ok).some((c) => c.startsWith('__Host-eden=jv1.') && c.includes('SameSite=Strict') && c.includes('HttpOnly')));
  const view = await account(session);
  assert.equal(view.account_id, await accountIdFor('apple-eden'), 'the same account as the Apple ID everywhere');
  assert.match(view.devices[0].name, /^Eden app/);
  // Once only.
  assert.equal(await landing(await hit(`/api/web/handoff?code=${handoff}`)), '/signin?error=expired&provider=apple');
  assert.equal(await landing(await hit('/api/web/handoff?code=nonsense')), '/signin?error=expired&provider=apple');
  // A minute only.
  const slow = await (await native({ identity_token: await identityToken({ sub: 'apple-eden', nonce: 'n', aud: 'com.askeden.eden' }), nonce: 'n' })).json();
  env.LINKS.objects.get(`handoff:${slow.handoff}`).now = () => Date.now() + 61_000;
  assert.equal(await landing(await hit(`/api/web/handoff?code=${slow.handoff}`)), '/signin?error=expired&provider=apple');
  assert.equal(env.LINKS.objects.get(`handoff:${slow.handoff}`).storage.map.size, 0, 'and it is gone');
});

// ── browsers signing browsers out ──

test('a browser signs out another browser at once (this isolate’s 30 s cache too), never the apps; or every browser', async () => {
  const owner = await phone('apple-s');
  const a = (await appleFlow({ sub: 'apple-s' })).session;
  const b = (await appleFlow({ sub: 'apple-s' })).session;
  const meta = (session) => hit('/api/chat/meta', { session, headers: { 'x-jarvis-chat': '1' } });
  assert.notEqual((await meta(b)).status, 401, 'B is signed in (and cached)');
  const out = await hit(`/api/web/devices/${parseToken(b).device}/signout`, { method: 'POST', body: {}, session: a });
  assert.equal(out.status, 204);
  assert.ok(!cleared(out, '__Host-eden'), 'A stays signed in');
  assert.equal((await meta(b)).status, 401, 'B is out now, not 30 s from now');
  assert.notEqual((await meta(a)).status, 401);
  const iphone = await hit(`/api/web/devices/${owner.device_id}/signout`, { method: 'POST', body: {}, session: a });
  assert.equal(iphone.status, 403);
  assert.equal((await hit(`/api/web/devices/${parseToken(b).device}/signout`, { method: 'POST', body: {}, session: a })).status, 404);
  assert.equal((await hit(`/api/web/devices/${parseToken(a).device}/signout`, { method: 'POST', body: {}, session: b })).status, 401, 'a signed-out browser signs out nothing');
  // Another site can't sign anyone out.
  assert.equal((await hit('/api/web/signout-everywhere', { method: 'POST', body: {}, session: a, headers: { origin: 'https://evil.example' } })).status, 403);
  const c = (await appleFlow({ sub: 'apple-s' })).session;
  assert.notEqual((await meta(c)).status, 401);
  const all = await hit('/api/web/signout-everywhere', { method: 'POST', body: {}, session: a });
  assert.equal(all.status, 204);
  assert.ok(cleared(all, '__Host-eden'), 'this one too');
  assert.equal((await meta(a)).status, 401);
  assert.equal((await meta(c)).status, 401);
  const listed = await (await hit('/api/account', { browser: false, token: owner.token })).json();
  assert.deepEqual(listed.devices.map((d) => d.kind), ['iphone'], 'the apps stay');
  // Signing itself out by id clears its own cookie.
  const d = (await appleFlow({ sub: 'apple-s' })).session;
  const self = await hit(`/api/web/devices/${parseToken(d).device}/signout`, { method: 'POST', body: {}, session: d });
  assert.ok(cleared(self, '__Host-eden'));
});

// ── abuse limits ──

test('AUTH_RATE: sign-in starts and callbacks per network, and new accounts per network', async () => {
  env.AUTH_RATE.max = 2;
  assert.equal((await hit('/api/web/google', { ip: '203.0.113.1' })).status, 302);
  assert.equal((await hit('/api/web/apple', { ip: '203.0.113.1' })).status, 302);
  const third = await hit('/api/web/google', { ip: '203.0.113.1' });
  assert.equal(await landing(third), '/signin?error=rate_limited&provider=google');
  assert.equal((await hit('/api/web/google', { ip: '203.0.113.2' })).status, 302, 'another network is fine');
  // New accounts: counted per network; a returning sign-in isn't.
  env.AUTH_RATE.max = 1000;
  env.AUTH_RATE.keys.length = 0;
  await googleFlow({ sub: 'google-r1', ip: '203.0.113.9' });
  await googleFlow({ sub: 'google-r1', ip: '203.0.113.9' });
  assert.deepEqual(env.AUTH_RATE.keys.filter((k) => k.startsWith('new:')), ['new:203.0.113.9']);
  assert.ok(env.AUTH_RATE.keys.includes('cb:203.0.113.9') && env.AUTH_RATE.keys.includes('start:203.0.113.9'));
  env.AUTH_RATE.max = 3; // starts and callbacks still fit; two more new accounts fill that count
  await env.AUTH_RATE.limit({ key: 'new:203.0.113.9' });
  await env.AUTH_RATE.limit({ key: 'new:203.0.113.9' });
  const refused = await googleFlow({ sub: 'google-r2', ip: '203.0.113.9' });
  assert.equal(await landing(refused.response), '/signin?error=rate_limited&provider=google');
  // The app's handoff counts too.
  env.AUTH_RATE.max = 0;
  const native = await hit('/api/web/native/apple', { method: 'POST', browser: false, body: {} });
  assert.equal(native.status, 429);
  assert.equal(native.headers.get('retry-after'), '60');
});

test('EDEN_RATE caps chat turns per account; LINK_RATE covers code starts, polls and lookups', async () => {
  const owner = await phone('apple-rate');
  const web = await appleFlow({ sub: 'apple-rate' });
  env.EDEN_RATE.max = 0;
  const send = await hit('/api/chat/send', { method: 'POST', session: web.session, headers: { 'x-jarvis-chat': '1' }, body: { messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(send.status, 429);
  assert.deepEqual(env.EDEN_RATE.keys, [`turn:${owner.account.id}`]);
  const start = await hit('/api/web/link', { method: 'POST', body: {}, ip: '192.0.2.5' });
  const { code } = await start.json();
  await hit('/api/web/link/poll', { method: 'POST', body: {}, headers: { cookie: `__Host-eden-link=${cookieValue(start, '__Host-eden-link')}` } });
  await hit(`/api/link/${code}`, { browser: false, token: owner.token });
  assert.deepEqual(env.LINK_RATE.keys, ['web:192.0.2.5', `poll:${code}`, `look:${owner.account.id}`]);
});

// ── sign-ups (SIGNUPS; accounts/turnstile.js) ──

test('SIGNUPS = "owner": no new account by any way in; existing identities still sign in and link', async () => {
  // Made while sign-ups were open: a Google account, and an Apple ID through the iPhone app.
  const g = await googleFlow({ sub: 'google-old' });
  const id = (await account(g.session)).account_id;
  const app = await phone('apple-old');
  env.SIGNUPS = 'owner';
  assert.equal((await (await hit('/api/web/config')).json()).signups, 'closed');
  // New: refused everywhere, friendly.
  const google = await googleFlow({ sub: 'google-new' });
  assert.equal(await landing(google.response), '/signin?error=signups_closed&provider=google');
  assert.equal(await landing((await appleFlow({ sub: 'apple-new-web' })).response), '/signin?error=signups_closed&provider=apple');
  const native = await hit('/api/web/native/apple', { method: 'POST', browser: false, body: { identity_token: await identityToken({ sub: 'apple-new-eden', nonce: 'n', aud: 'com.askeden.eden' }), nonce: 'n' } });
  assert.equal(native.status, 403);
  assert.deepEqual(await native.json(), { error: 'Eden is opening soon — sign-ups are closed for now. If you already have an Eden account, sign in with the way you used before.', code: 'signups_closed' });
  const jarvis = await hit('/api/account/apple', { method: 'POST', browser: false, body: { identity_token: await identityToken({ sub: 'apple-new-phone' }), nonce: 'raw-nonce', device: {} } });
  assert.equal(jarvis.status, 403);
  const passkey = await hit('/api/web/passkey/options', { method: 'POST', body: { mode: 'signup' } });
  assert.equal((await passkey.json()).code, 'signups_closed');
  assert.equal((await hit('/api/web/passkey/options', { method: 'POST', body: { mode: 'signin' } })).status, 200, 'passkey sign-in still works');
  const looked = env.ACCOUNTS.objects.get(await accountIdFor('apple-new-phone'));
  assert.equal(looked ? await looked.storage.get('account') : undefined, undefined, 'nothing was made');
  // Existing: sign in as always, and add another way in.
  const back = await googleFlow({ sub: 'google-old' });
  assert.equal((await account(back.session)).account_id, id);
  assert.equal((await phone('apple-old')).account.id, app.account.id);
  const web = await appleFlow({ sub: 'apple-old' });
  assert.equal((await account(web.session)).account_id, app.account.id, 'an Apple ID the iPhone app made an account for opens it on the web');
  await appleFlow({ sub: 'apple-link', link: true, session: g.session });
  assert.deepEqual((await account(g.session)).identities.map((i) => i.provider).sort(), ['apple', 'google']);
});

test('SIGNUPS = "open" is fail-closed without Turnstile, unless TURNSTILE_OPTIONAL (the preview)', async () => {
  const { signupsOpen } = await import('../src/accounts/turnstile.js');
  assert.equal(signupsOpen({}), true, 'unset: local dev and tests');
  assert.equal(signupsOpen({ SIGNUPS: 'owner' }), false);
  assert.equal(signupsOpen({ SIGNUPS: 'open' }), false, 'no Turnstile: closed');
  assert.equal(signupsOpen({ SIGNUPS: 'open', TURNSTILE_SITE_KEY: 'k' }), false, 'no secret: closed');
  assert.equal(signupsOpen({ SIGNUPS: 'open', TURNSTILE_SITE_KEY: 'k', TURNSTILE_SECRET: 's' }), true);
  assert.equal(signupsOpen({ SIGNUPS: 'open', TURNSTILE_OPTIONAL: '1' }), true);
  assert.equal(signupsOpen({ SIGNUPS: 'owner', TURNSTILE_OPTIONAL: '1' }), false);
  env.SIGNUPS = 'open';
  assert.equal(await landing((await googleFlow({ sub: 'google-x' })).response), '/signin?error=signups_closed&provider=google');
});

test('a new account from an app’s own Sign in with Apple costs five tries of AUTH_RATE per network', async () => {
  env.AUTH_RATE.max = 10; // two new accounts a minute from one network, then a wait
  const native = async (sub, ip) => hit('/api/web/native/apple', { method: 'POST', browser: false, ip, body: { identity_token: await identityToken({ sub, nonce: 'n', aud: 'com.askeden.eden' }), nonce: 'n' } });
  assert.equal((await native('apple-n1', '203.0.113.20')).status, 200);
  assert.equal((await native('apple-n2', '203.0.113.20')).status, 200);
  assert.equal((await native('apple-n3', '203.0.113.20')).status, 429);
  assert.equal((await native('apple-n1', '203.0.113.20')).status, 200, 'signing in again isn’t a new account');
  assert.equal((await native('apple-n4', '203.0.113.21')).status, 200, 'another network');
  assert.equal(env.AUTH_RATE.keys.filter((k) => k === 'native-new:203.0.113.20').length, 11, 'the third stopped at its first try over');
});

// ── Delete account on the web ──

test('Delete account from the account page: typed DELETE, then every device, sign-in, passkey and page is gone', async () => {
  const g = await googleFlow({ sub: 'google-gone' });
  const id = (await account(g.session)).account_id;
  await appleFlow({ sub: 'apple-gone', link: true, session: g.session });
  const app = await phone('apple-gone'); // the iPhone app on the same account
  assert.equal(app.account.id, id);
  // A published page (accounts/published.js): its `pub:<id>` link, to check it goes too.
  await env.ACCOUNTS.get(env.ACCOUNTS.idFromName('pub:page-1')).fetch(new Request('https://do/pub-index-claim', { method: 'POST', body: JSON.stringify({ account: id }) }));
  await env.ACCOUNTS.objects.get(id).storage.put('pubh:page-1', { id: 'page-1', title: 't', access: 'link', bytes: 1, created: 1, updated: 1 });

  const del = (body, opts = {}) => hit('/api/web/account/delete', { method: 'POST', session: g.session, body, ...opts });
  assert.equal((await del({ confirm: 'delete' })).status, 400, 'exactly DELETE');
  assert.equal((await del({ confirm: 'DELETE' }, { headers: { origin: 'https://evil.example' } })).status, 403, 'only this site’s page');
  assert.equal((await hit('/api/web/account/delete', { method: 'POST', body: { confirm: 'DELETE' } })).status, 401, 'signed in only');
  const done = await del({ confirm: 'DELETE' });
  assert.equal(done.status, 204, await done.clone().text());
  assert.ok(cleared(done, '__Host-eden'));
  assert.equal((await hit('/api/web/account', { session: g.session })).status, 401, 'this browser is signed out');
  assert.equal((await hit('/api/account', { browser: false, token: app.token })).status, 401, 'and the iPhone app');
  assert.equal(env.ACCOUNTS.objects.get(id).storage.map.size, 0, 'the account’s data is gone');
  assert.equal(env.ACCOUNTS.objects.get('pub:page-1').storage.map.size, 0, 'its published page’s link is gone');
  assert.notEqual((await account((await googleFlow({ sub: 'google-gone' })).session)).account_id, id, 'Google opens a new account now');
});

test('a browser can’t delete the account without typing DELETE, even straight at its object', async () => {
  const g = await googleFlow({ sub: 'google-keep' });
  const id = (await account(g.session)).account_id;
  const { call } = await import('../src/accounts/index.js');
  const [, device, secret] = /^jv1\.[^.]+\.([^.]+)\.(.+)$/.exec(decodeURIComponent(g.session));
  await assert.rejects(call(env, id, 'delete', {}, { device, secret }), (e) => e.status === 403);
  await assert.rejects(call(env, id, 'delete', { confirm: 'yes' }, { device, secret }), (e) => e.status === 403);
  assert.equal((await hit('/api/web/account', { session: g.session })).status, 200);
});
