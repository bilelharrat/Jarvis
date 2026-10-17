// Which Eden account a browser is in (docs/web-auth.md "Which account this browser was in"): every sign-in in a
// browser remembers how and which account (__Host-eden-last), /signin is told, the account page gets a short
// account code that is the same on every device, and a first-time Apple or Google sign-in in a browser that was
// in another account asks before it makes a second one (session.js newAccountChoice). A browser that never
// signed in here (App Review's, a new person's) and the apps' own sign-ins go straight on, as before.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { accountCode, accountIdFor } from '../src/accounts/util.js';
import { callIdentity, subHashOf } from '../src/accounts/index.js';
import { SITEVERIFY } from '../src/accounts/turnstile.js';
import { forgetGoogleKeys } from '../src/eden/google.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, GOOGLE_CLIENT, Identity, Link, appleJwk, google, googleIdToken, identityToken, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const SERVICES_ID = 'com.askeden.eden.web';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const CODE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/;

let env;
let nextGoogle;
const ctx = { waitUntil: () => {} };
const realFetch = globalThis.fetch;

function makeEnv(extra = {}) {
  const e = {
    TRIAL_BUDGET_USD: '1',
    PLUS_BUDGET_USD: '20',
    WEB_APPLE_SERVICES_ID: SERVICES_ID,
    GOOGLE_CLIENT_ID: GOOGLE_CLIENT,
    GOOGLE_CLIENT_SECRET: 'test-secret',
    EDEN_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'), // the merge token's seal
    AUTH_RATE: rateLimiter(),
    LINK_RATE: rateLimiter(),
    EDEN_RATE: rateLimiter(),
    API_RATE: rateLimiter(),
    EDEN_SIGNIN_CHOICE: 'on', // held by default (wrangler.toml); the last test checks it off
    ...extra,
  };
  e.ACCOUNTS = namespace(Account, e);
  e.LINKS = namespace(Link, e);
  e.IDENTITIES = namespace(Identity, e);
  e.ASSETS = { fetch: async (req) => new Response(`asset ${new URL(req.url).pathname}`, { headers: { 'content-type': 'text/html' } }) };
  return e;
}

beforeEach(() => {
  forgetAppleKeys();
  forgetGoogleKeys();
  forgetSessions();
  nextGoogle = { sub: 'google-user-1', email: 'person@example.com' };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [google.jwk] });
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'ya29.x', expires_in: 3599, id_token: await googleIdToken({ ...nextGoogle }) });
    if (url === SITEVERIFY) return Response.json({ success: new URLSearchParams(init.body).get('response') === 'good-token', hostname: 'askeden.com' });
    throw new Error(`unexpected fetch ${url}`);
  };
  env = makeEnv();
});

after(() => {
  globalThis.fetch = realFetch;
});

async function hit(p, { method = 'GET', body, headers = {}, browser = true, session, cookie, token, ip = '198.51.100.7' } = {}) {
  const h = { 'cf-connecting-ip': ip, ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (browser) {
    h['user-agent'] ??= SAFARI;
    if (method !== 'GET' && method !== 'HEAD') h.origin ??= ORIGIN;
  }
  const jar = [session ? `__Host-eden=${session}` : '', cookie || ''].filter(Boolean);
  if (jar.length) h.cookie = jar.join('; ');
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    h['content-type'] ??= 'application/json';
  }
  return worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
}

const setCookies = (response) => response.headers.getSetCookie();
const setCookie = (response, name) => setCookies(response).find((c) => c.startsWith(`${name}=`));
const cookieValue = (response, name) => {
  const found = setCookie(response, name);
  return found ? found.slice(name.length + 1).split(';')[0] : undefined;
};
const cleared = (response, name) => setCookies(response).some((c) => c.startsWith(`${name}=;`) && c.includes('Max-Age=0'));
const lastOf = (response) => {
  const v = cookieValue(response, '__Host-eden-last');
  return v ? `__Host-eden-last=${v}` : '';
};

async function landing(response) {
  if (response.status === 303 || response.status === 302) return response.headers.get('location');
  assert.equal(response.status, 200, `status ${response.status}`);
  const m = /http-equiv="refresh" content="0; url=([^"]+)"/.exec(await response.clone().text());
  assert.ok(m, 'an onward page');
  return m[1].replace(/&amp;/g, '&');
}

/** A whole Sign in with Google from this browser (`cookie`: what it holds, e.g. its last sign-in). */
async function googleFlow({ sub = 'google-user-1', email = 'person@example.com', link = false, session, cookie, start: how = {} } = {}) {
  const start = await hit(`/api/web/google${link ? '?link=1' : ''}`, { session, cookie, ...how });
  if (start.status !== 302) return { response: start };
  const to = new URL(start.headers.get('location'));
  const attempt = cookieValue(start, '__Host-eden-google');
  nextGoogle = { sub, email, nonce: to.searchParams.get('nonce') };
  // Google's callback: a cross-site GET, which brings the Lax cookies (the last sign-in's too), never the Strict session.
  const response = await hit(`/api/web/google/callback?state=${to.searchParams.get('state')}&code=4%2Fcode`, { cookie: [`__Host-eden-google=${attempt}`, cookie].filter(Boolean).join('; ') });
  return { response, session: cookieValue(response, '__Host-eden'), last: lastOf(response) };
}

/** A whole Sign in with Apple on the web: Apple's form_post is a cross-site POST, which brings only its own SameSite=None cookie. */
async function appleFlow({ sub = 'apple-user-1', link = false, session, cookie } = {}) {
  const start = await hit(`/api/web/apple${link ? '?link=1' : ''}`, { session, cookie });
  if (start.status !== 302) return { response: start };
  const attempt = cookieValue(start, '__Host-eden-apple');
  const [state, nonce] = attempt.split('.');
  const response = await hit('/api/web/apple/callback', {
    method: 'POST',
    body: new URLSearchParams({ state, id_token: await identityToken({ sub, nonce, aud: SERVICES_ID }) }).toString(),
    headers: { origin: 'https://appleid.apple.com', 'content-type': 'application/x-www-form-urlencoded', cookie: `__Host-eden-apple=${attempt}` },
  });
  return { response, session: cookieValue(response, '__Host-eden'), last: lastOf(response) };
}

const account = async (session) => {
  const response = await hit('/api/web/account', { session });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};

/** "Create a new Eden account" on the choice page: its form's POST, with the cookie that page set. */
const create = (choice, extra = {}) => hit('/api/web/signin/create', { method: 'POST', body: '', headers: { 'content-type': 'application/x-www-form-urlencoded' }, cookie: `__Host-eden-new=${cookieValue(choice, '__Host-eden-new')}`, ...extra });
const accounts = () => [...env.ACCOUNTS.objects.values()].filter((o) => o.storage.map.has('account')).length;

test('account codes: six letters and digits from a hash of the id, the same every time, different between accounts', async () => {
  const a = await accountCode('11111111-1111-4111-8111-111111111111');
  assert.match(a, CODE);
  assert.equal(await accountCode('11111111-1111-4111-8111-111111111111'), a);
  assert.notEqual(await accountCode('22222222-2222-4222-8222-222222222222'), a);
  assert.ok(!a.replace('-', '').includes('1111'), 'nothing of the id shows');
});

test('every sign-in in a browser remembers how and which account; the account page, the session and /signin say so', async () => {
  // A browser that never signed in here: a first-time Google sign-in makes its account at once, as before.
  const first = await googleFlow({ sub: 'google-a' });
  assert.equal(await landing(first.response), '/');
  assert.ok(first.session);
  const view = await account(first.session);
  assert.match(view.account_code, CODE);
  assert.equal(view.account_code, await accountCode(view.account_id));
  assert.equal((await (await hit('/api/web/session', { session: first.session })).json()).account_code, view.account_code);
  // The cookie: method and code (no dash), a long-lived Lax cookie no script reads; no email, no account id.
  const set = setCookie(first.response, '__Host-eden-last');
  assert.equal(set, `__Host-eden-last=google.${view.account_code.replace('-', '')}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=34560000`);
  assert.ok(!set.includes(view.account_id) && !set.includes('example.com'));
  // Another device (another browser) of the same account shows the same code.
  assert.equal((await account((await googleFlow({ sub: 'google-a' })).session)).account_code, view.account_code);
  // /signin's config: `last` only with the cookie (the reply is never cached), and a forged value is ignored.
  const plain = await (await hit('/api/web/config')).json();
  assert.equal('last' in plain, false);
  assert.deepEqual((await (await hit('/api/web/config', { cookie: first.last })).json()).last, { method: 'google', code: view.account_code });
  assert.equal('last' in (await (await hit('/api/web/config', { cookie: '__Host-eden-last=google.<script>' })).json()), false);
  // Apple on the web too; signing out keeps it (that's the point), deleting the account clears it.
  const apple = await appleFlow({ sub: 'apple-a' });
  assert.equal(apple.last, `__Host-eden-last=apple.${(await accountCode(await accountIdFor('apple-a'))).replace('-', '')}`);
  const out = await hit('/api/web/signout', { method: 'POST', body: {}, session: apple.session });
  assert.equal(setCookie(out, '__Host-eden-last'), undefined);
  const del = await hit('/api/web/account/delete', { method: 'POST', session: first.session, body: { confirm: 'DELETE' } });
  assert.equal(del.status, 204, await del.clone().text());
  assert.ok(cleared(del, '__Host-eden-last'));
});

test('a browser the Eden app approved with a code remembers that too', async () => {
  const phone = await (await hit('/api/account/apple', { method: 'POST', browser: false, body: { identity_token: await identityToken({ sub: 'apple-approver' }), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } } })).json();
  const start = await hit('/api/web/link', { method: 'POST', body: {} });
  const { code } = await start.json();
  const approved = await hit(`/api/link/${code}/approve`, { method: 'POST', browser: false, token: phone.token, body: {} });
  assert.equal(approved.status, 200, await approved.clone().text());
  const done = await hit('/api/web/link/poll', { method: 'POST', body: {}, cookie: `__Host-eden-link=${cookieValue(start, '__Host-eden-link')}` });
  assert.equal((await done.json()).status, 'signed_in');
  assert.equal(lastOf(done), `__Host-eden-last=code.${(await accountCode(phone.account.id)).replace('-', '')}`);
  assert.deepEqual((await (await hit('/api/web/config', { cookie: lastOf(done) })).json()).last, { method: 'code', code: await accountCode(phone.account.id) });
});

test('the Eden app’s own sign-ins set no last-sign-in cookie and never ask, whatever the web view holds', async () => {
  const before = await appleFlow({ sub: 'apple-web' });
  // Native Apple → handoff in the app's web view: as before, a 302 with the session only.
  const made = await (await hit('/api/web/native/apple', { method: 'POST', browser: false, body: { identity_token: await identityToken({ sub: 'apple-native-new', nonce: 'n', aud: 'com.askeden.eden' }), nonce: 'n' } })).json();
  const handoff = await hit(`/api/web/handoff?code=${made.handoff}`, { headers: { 'sec-fetch-site': 'none' }, cookie: before.last });
  assert.equal(handoff.status, 302);
  assert.equal(handoff.headers.get('location'), '/');
  assert.equal(setCookie(handoff, '__Host-eden-last'), undefined);
  assert.equal((await account(cookieValue(handoff, '__Host-eden'))).account_id, await accountIdFor('apple-native-new'));
  // Google in Apple's web sheet (?app=1): a brand-new Google account still ends on the app's scheme with a code.
  const start = await hit('/api/web/google?app=1', { cookie: before.last });
  const to = new URL(start.headers.get('location'));
  nextGoogle = { sub: 'google-app-new', nonce: to.searchParams.get('nonce') };
  const back = await hit(`/api/web/google/callback?state=${to.searchParams.get('state')}&code=x`, { cookie: `__Host-eden-google=${cookieValue(start, '__Host-eden-google')}; ${before.last}` });
  assert.equal(back.status, 302);
  assert.match(back.headers.get('location'), /^com\.askeden\.eden:\/\/signin\?code=[A-Za-z0-9_-]{43}$/);
});

test('a first-time Google sign-in in a browser last in an Apple account asks first; nothing is made until Create', async () => {
  const apple = await appleFlow({ sub: 'apple-old' });
  const appleId = await accountIdFor('apple-old');
  const code = await accountCode(appleId);
  const made = accounts();
  const asked = await googleFlow({ sub: 'google-new', email: 'new@example.com', cookie: apple.last });
  assert.equal(asked.response.status, 200);
  assert.equal(asked.session, undefined, 'not signed in yet');
  assert.equal(accounts(), made, 'no account made');
  assert.equal((await callIdentity(env, 'google', await subHashOf('google', 'google-new'), 'get')).state, 'none', 'the Google account isn’t tied to anything yet');
  const html = await asked.response.text();
  assert.match(html, /This Google account isn’t connected to an Eden account/);
  assert.match(html, new RegExp(`You last signed in here with Apple \\(account ${code}\\)\\.`));
  assert.match(html, /<a class="button" id="instead" href="\/api\/web\/apple">Sign in with Apple instead<\/a>/);
  assert.match(html, /<form method="post" action="\/api\/web\/signin\/create">/);
  assert.match(html, /Account › Ways to sign in/);
  assert.ok(!html.includes('google-new') && !html.includes('new@example.com'), 'nothing of the identity on the page');
  assert.match(asked.response.headers.get('content-security-policy'), /form-action 'self'/);
  assert.match(asked.response.headers.get('content-security-policy'), /default-src 'none'/);
  // The browser holds only a random key; the sign-in waits server-side by its hash, never its raw id.
  const key = cookieValue(asked.response, '__Host-eden-new');
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.match(setCookie(asked.response, '__Host-eden-new'), /HttpOnly; SameSite=Strict; Max-Age=600$/);
  assert.ok(cleared(asked.response, '__Host-eden-google'), 'the attempt’s own cookie goes as always');
  const kept = JSON.stringify([...env.LINKS.objects.get(`newacct:${key}`).storage.map]);
  assert.ok(!kept.includes('google-new'), 'no raw Google id is kept');

  // "Sign in with Apple instead": the old account, as ever.
  const instead = await appleFlow({ sub: 'apple-old', cookie: apple.last });
  assert.equal((await account(instead.session)).account_id, appleId);

  // "Create a new Eden account": only this site's page may post it.
  assert.equal((await create(asked.response, { headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' } })).status, 403);
  assert.equal((await create(asked.response, { browser: false })).status, 403, 'no Origin: not a page of this site');
  const done = await create(asked.response);
  assert.equal(await landing(done), '/');
  assert.ok(cleared(done, '__Host-eden-new'));
  const view = await account(cookieValue(done, '__Host-eden'));
  assert.notEqual(view.account_id, appleId);
  assert.deepEqual(view.identities.map(({ provider, email }) => ({ provider, email })), [{ provider: 'google', email: 'new@example.com' }]);
  assert.equal(lastOf(done), `__Host-eden-last=google.${view.account_code.replace('-', '')}`);
  assert.equal(accounts(), made + 1);
  // Once only: the same key again is too late, and makes nothing.
  assert.equal(await landing(await create(asked.response)), '/signin?error=expired');
  assert.equal(await landing(await hit('/api/web/signin/create', { method: 'POST', body: '' })), '/signin?error=expired');
  // Next time that Google account just opens its account, with no question, even in a browser last in another one.
  const again = await googleFlow({ sub: 'google-new', cookie: apple.last });
  assert.equal((await account(again.session)).account_id, view.account_id);
});

test('a first-time Apple ID in a browser last in a Google account asks too; Create makes the account its id derives from', async () => {
  const g = await googleFlow({ sub: 'google-first' });
  const asked = await appleFlow({ sub: 'apple-brand-new', cookie: g.last });
  const html = await asked.response.text();
  assert.match(html, /This Apple ID isn’t connected to an Eden account/);
  assert.match(html, /You last signed in here with Google \(account [0-9A-Z]{3}-[0-9A-Z]{3}\)\./);
  assert.match(html, /href="\/api\/web\/google">Sign in with Google instead</);
  const done = await create(asked.response);
  assert.equal((await account(cookieValue(done, '__Host-eden'))).account_id, await accountIdFor('apple-brand-new'), 'the account the iPhone app opens too');
  // An Apple ID the iPhone app already made an account for never asks: it isn't new.
  await hit('/api/account/apple', { method: 'POST', browser: false, body: { identity_token: await identityToken({ sub: 'apple-phone' }), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } } });
  const phone = await appleFlow({ sub: 'apple-phone', cookie: g.last });
  assert.equal((await account(phone.session)).account_id, await accountIdFor('apple-phone'));
});

test('the question names the way used before: another Google account, a passkey, a code; and keeps where to go back to', async () => {
  const g = await googleFlow({ sub: 'google-mine' });
  const other = await googleFlow({ sub: 'google-other', cookie: g.last, start: { headers: {} } });
  const html = await other.response.text();
  assert.match(html, /You last signed in here with another Google account \(account /);
  assert.match(html, />Use another Google account</);
  for (const [method, words, button] of [['passkey', 'a passkey', 'Sign in with a passkey instead'], ['code', 'a code from the Eden app', 'Sign in with a code instead']]) {
    const start = await hit('/api/web/apple?return=%2F%23tasks', { cookie: `__Host-eden-last=${method}.K7QM4Z` });
    const attempt = cookieValue(start, '__Host-eden-apple');
    const [state, nonce] = attempt.split('.');
    const back = await hit('/api/web/apple/callback', { method: 'POST', body: new URLSearchParams({ state, id_token: await identityToken({ sub: `apple-${method}`, nonce, aud: SERVICES_ID }) }).toString(), headers: { origin: 'https://appleid.apple.com', 'content-type': 'application/x-www-form-urlencoded', cookie: `__Host-eden-apple=${attempt}` } });
    const page = await back.text();
    assert.match(page, new RegExp(`You last signed in here with ${words} \\(account K7Q-M4Z\\)\\.`));
    assert.match(page, new RegExp(`href="/signin\\?return=%2F%23tasks">${button}<`));
    assert.equal(await landing(await create(back)), '/#tasks', 'Create still ends where the sign-in was going');
  }
});

test('the question is never a way around the person check, sign-ups closed, or link mode', async () => {
  env = makeEnv({ TURNSTILE_SITE_KEY: '0x4AAAAAAAtest', TURNSTILE_SECRET: '0x4AAAAAAAsecret' });
  const last = `__Host-eden-last=apple.${(await accountCode(await accountIdFor('someone'))).replace('-', '')}`;
  // No person check at the start (a plain link): refused as before, before any question.
  assert.equal(await landing((await googleFlow({ sub: 'google-bot', cookie: last })).response), '/signin?error=verify&provider=google');
  // /signin's button with a passing check: the question, then Create needs no second check.
  const asked = await googleFlow({ sub: 'google-person', cookie: last, start: { method: 'POST', body: new URLSearchParams({ 'cf-turnstile-response': 'good-token' }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } } });
  assert.equal(asked.response.status, 200);
  assert.match(await asked.response.text(), /Create a new Eden account/);
  assert.equal(await landing(await create(asked.response)), '/');
  // Sign-ups closed while the question was open: Create is refused, nothing is made.
  const asked2 = await googleFlow({ sub: 'google-late', cookie: last, start: { method: 'POST', body: new URLSearchParams({ 'cf-turnstile-response': 'good-token' }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } } });
  env.SIGNUPS = 'owner';
  const n = accounts();
  assert.equal(await landing(await create(asked2.response)), '/signin?error=signups_closed&provider=google');
  assert.equal(accounts(), n);
  // Link mode never asks: a taken Google account is the link's own question (bring in chats).
  delete env.SIGNUPS;
  env.TURNSTILE_SECRET = '';
  const mine = await appleFlow({ sub: 'apple-mine' });
  const theirs = await googleFlow({ sub: 'google-theirs' });
  const linked = await googleFlow({ sub: 'google-theirs', link: true, session: mine.session, cookie: mine.last });
  const to = await landing(linked.response);
  assert.match(to, /^\/#account\?merge=[^&]+&provider=google$/);
  // The bring-in-chats card learns which account that Google account opens (its code), from the merge preview.
  const [iv, ct] = decodeURIComponent(new URLSearchParams(to.split('?')[1]).get('merge')).split('.');
  const preview = await hit('/api/web/merge/preview', { method: 'POST', session: mine.session, body: { token: { iv, ct } }, headers: { 'x-jarvis-chat': '1' } });
  assert.equal(preview.status, 200, await preview.clone().text());
  assert.equal((await preview.json()).account_code, (await account(theirs.session)).account_code);
});

test('held (EDEN_SIGNIN_CHOICE not on, as deployed until App Review passes): no hint on /signin and no question, the cookie still set', async () => {
  env = makeEnv({ EDEN_SIGNIN_CHOICE: '' });
  const apple = await appleFlow({ sub: 'apple-held' });
  assert.match(apple.last, /^__Host-eden-last=apple\./, 'the cookie is set, ready for when it is turned on');
  assert.equal('last' in (await (await hit('/api/web/config', { cookie: apple.last })).json()), false);
  const made = accounts();
  const google = await googleFlow({ sub: 'google-held', cookie: apple.last });
  assert.equal(await landing(google.response), '/', 'straight on, as before');
  assert.ok(google.session, 'signed in at once');
  assert.equal(accounts(), made + 1);
  assert.equal(setCookie(google.response, '__Host-eden-new'), undefined, 'no question was kept');
});
