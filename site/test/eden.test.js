// Eden at askeden.com: signing a browser in (the link code the J.A.R.V.I.S. app approves,
// Sign in with Apple behind its flag), the session cookie and what a `web` device may not do,
// Origin checks, the pages and their headers, and hosted chat (meta, routing, a streamed turn
// on the included AI with its caps and metering, a stopped turn, artifacts, "needs your Mac").
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { bytesToB64, parseToken } from '../src/accounts/util.js';
import { DEFAULTS, effortsFor, hostedConfig, searchTool } from '../src/eden/chat.js';
import { EDEN_FILES } from '../src/eden/manifest.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Link, appleJwk, claudeAnswer, identityToken, namespace, readEvents, sseBody } from './fakes.js';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://askeden.com';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';

// ── the Worker with fakes ──

let env;
let waits;
let calls;
let anthropic; // () => Response, for api.anthropic.com
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;

function makeEnv(extra = {}) {
  const e = { ANTHROPIC_API_KEY: 'sk-test', TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20', ...extra };
  e.ACCOUNTS = namespace(Account, e);
  e.LINKS = namespace(Link, e);
  e.assets = [];
  e.ASSETS = {
    fetch: async (req) => {
      const p = new URL(req.url).pathname;
      e.assets.push(p);
      const type = p.endsWith('/') || p.endsWith('.html') ? 'text/html' : p.endsWith('.css') ? 'text/css' : 'text/javascript';
      return new Response(`asset ${p}`, { headers: { 'content-type': type, etag: '"a1"' } });
    },
  };
  return e;
}

beforeEach(() => {
  waits = [];
  calls = [];
  forgetAppleKeys();
  forgetSessions();
  anthropic = () => new Response(sseBody(claudeAnswer()), { headers: { 'content-type': 'text/event-stream' } });
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    if (url === 'https://api.anthropic.com/v1/messages') return anthropic(JSON.parse(init.body), init);
    throw new Error(`unexpected fetch ${url}`);
  };
  env = makeEnv();
});

after(() => {
  globalThis.fetch = realFetch;
});

async function settle() {
  while (waits.length) await Promise.all(waits.splice(0));
}

/** A request to the Worker; `browser` adds what a browser on askeden.com sends. */
async function hit(p, { method = 'GET', body, headers = {}, browser = true, session, token, raw = false } = {}) {
  const h = { ...headers };
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
  const response = await worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
  if (!raw) await settle();
  return response;
}

const setCookies = (response) => (response.headers.getSetCookie ? response.headers.getSetCookie() : []);
const cookieValue = (response, name) => {
  const found = setCookies(response).find((c) => c.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1).split(';')[0] : undefined;
};

async function phone(sub = 'apple-user-1', name = "Bilel's iPhone") {
  const response = await hit('/api/account/apple', {
    method: 'POST',
    browser: false,
    body: { identity_token: await identityToken({ sub }), nonce: 'raw-nonce', device: { name, kind: 'iphone' } },
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

/** The sign-in page's part: a code, and the cookie that holds its poll secret. */
async function startWebLink() {
  const response = await hit('/api/web/link', { method: 'POST', body: {} });
  assert.equal(response.status, 200, await response.clone().text());
  const link = await response.json();
  return { ...link, cookie: `__Host-eden-link=${cookieValue(response, '__Host-eden-link')}` };
}

/** A browser signed in through the iPhone: its session cookie value. */
async function signedInBrowser(owner) {
  const link = await startWebLink();
  const approved = await hit(`/api/link/${link.code}/approve`, { method: 'POST', browser: false, token: owner.token, body: { sealed_key: null, sender_key: null } });
  assert.equal(approved.status, 200, await approved.clone().text());
  const done = await hit('/api/web/link/poll', { method: 'POST', body: {}, headers: { cookie: link.cookie } });
  assert.equal(done.status, 200, await done.clone().text());
  return cookieValue(done, '__Host-eden');
}

const chat = (p, session, opts = {}) => hit(p, { session, ...opts, headers: { 'x-jarvis-chat': '1', ...(opts.headers || {}) } });
const turn = (session, body, opts = {}) =>
  chat('/api/chat/send', session, { method: 'POST', ...opts, body: { messages: [{ role: 'user', content: 'Hello there' }], settings: { level: 3 }, ...body } });

// ── signing in with a code ──

test('a browser signs in with a code the iPhone app approves; the session is an HttpOnly cookie', async () => {
  const owner = await phone();
  const link = await startWebLink();
  assert.match(link.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(link.url, `jarvis-link://${link.code}`);
  assert.equal(link.qr.length, 25, 'a version 2 QR code');
  assert.ok(!('poll' in link), 'the poll secret never reaches the page');
  const started = await hit('/api/web/link', { method: 'POST', body: {} });
  const linkCookie = setCookies(started)[0];
  assert.match(linkCookie, /^__Host-eden-link=[0-9A-Z]{8}\.[\w-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=600$/);

  const waiting = await hit('/api/web/link/poll', { method: 'POST', body: {}, headers: { cookie: link.cookie } });
  assert.equal(waiting.status, 202);

  // What the iPhone app sees and sends (AccountView: "Link “…”?"): no key to seal the sync key to.
  const peek = await (await hit(`/api/link/${link.code}`, { browser: false, token: owner.token })).json();
  assert.equal(peek.kind, 'web');
  assert.equal(peek.public_key, null);
  assert.equal(peek.name, 'Eden on the web: Safari on a Mac');
  const approved = await hit(`/api/link/${link.code}/approve`, { method: 'POST', browser: false, token: owner.token, body: { sealed_key: 'c2VhbGVk', sender_key: 'a2V5' } });
  assert.equal(approved.status, 200);

  const done = await hit('/api/web/link/poll', { method: 'POST', body: {}, headers: { cookie: link.cookie } });
  assert.equal(done.status, 200);
  assert.deepEqual(await done.json(), { status: 'signed_in' }, 'no token in the body');
  const session = setCookies(done).find((c) => c.startsWith('__Host-eden='));
  assert.match(session, /^__Host-eden=jv1\.[^;]+; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000$/);
  assert.ok(setCookies(done).some((c) => /^__Host-eden-link=; .*Max-Age=0/.test(c)), 'the link cookie goes');

  const value = cookieValue(done, '__Host-eden');
  const token = parseToken(value);
  const account = env.ACCOUNTS.objects.get(owner.account.id);
  const device = await account.storage.get(`dev:${token.device}`);
  assert.equal(device.kind, 'web');
  assert.ok(device.expires > Date.now() + 29 * 86400_000);
  const pending = await env.LINKS.objects.get(link.code)?.storage.get('link');
  assert.equal(pending, undefined, 'the link is gone, with the token it held');

  const who = await (await hit('/api/web/session', { session: value })).json();
  assert.equal(who.signed_in, true);
  assert.equal(who.account_id, owner.account.id);
  assert.equal(who.usage.trial_left_usd, 1);
  // In the app, the browser is one more device the owner can sign out.
  const listed = await (await hit('/api/account', { browser: false, token: owner.token })).json();
  assert.deepEqual(listed.devices.map((d) => d.kind), ['iphone', 'web']);
});

test('a code can be turned down or run out; a linked Mac may approve a browser, a browser nothing', async () => {
  const owner = await phone();
  const first = await startWebLink();
  assert.equal((await hit(`/api/link/${first.code}/deny`, { method: 'POST', browser: false, token: owner.token })).status, 204);
  const denied = await hit('/api/web/link/poll', { method: 'POST', body: {}, headers: { cookie: first.cookie } });
  assert.equal(denied.status, 410);
  assert.equal((await denied.json()).code, 'denied');
  assert.ok(setCookies(denied).some((c) => c.startsWith('__Host-eden-link=;')));
  assert.equal((await hit('/api/web/link/poll', { method: 'POST', body: {} })).status, 404, 'no link cookie');

  // A Mac linked the usual way may approve a browser's sign-in (never another Mac's link).
  const macLink = await (await hit('/api/link/start', { method: 'POST', browser: false, body: { name: 'MacBook Air', kind: 'mac', public_key: bytesToB64(new Uint8Array(32).fill(7)) } })).json();
  await hit(`/api/link/${macLink.code}/approve`, { method: 'POST', browser: false, token: owner.token, body: {} });
  const mac = await (await hit('/api/link/poll', { method: 'POST', browser: false, body: macLink })).json();
  const second = await startWebLink();
  assert.equal((await hit(`/api/link/${second.code}/approve`, { method: 'POST', browser: false, token: mac.token, body: {} })).status, 200);
  const signedIn = await hit('/api/web/link/poll', { method: 'POST', body: {}, headers: { cookie: second.cookie } });
  const browser = cookieValue(signedIn, '__Host-eden');
  assert.ok(browser);
  const otherMac = await (await hit('/api/link/start', { method: 'POST', browser: false, body: { name: 'iMac', kind: 'mac', public_key: bytesToB64(new Uint8Array(32).fill(9)) } })).json();
  assert.equal((await hit(`/api/link/${otherMac.code}/approve`, { method: 'POST', browser: false, token: mac.token, body: {} })).status, 403, 'a Mac never approves a Mac');
  // The browser's token, however it's sent, approves nothing.
  const third = await startWebLink();
  assert.equal((await hit(`/api/link/${third.code}/approve`, { method: 'POST', browser: false, token: browser, body: {} })).status, 403);
  assert.equal((await hit(`/api/link/${otherMac.code}`, { browser: false, token: browser })).status, 403);

  // Ten minutes on, the code is gone.
  env.LINKS.objects.get(third.code).now = () => Date.now() + 601_000;
  const late = await hit('/api/web/link/poll', { method: 'POST', body: {}, headers: { cookie: third.cookie } });
  assert.equal(late.status, 410);
});

test('a `web` device is restricted: no relay, no other devices, no account deletion, no sync, pushes or plan', async () => {
  const owner = await phone();
  const value = await signedInBrowser(owner);
  const upgrade = { upgrade: 'websocket' };
  for (const [p, opts] of [
    ['/api/relay/listen', { headers: upgrade }],
    [`/api/relay/connect?to=${owner.device_id}`, { headers: upgrade }],
    [`/api/devices/${owner.device_id}`, { method: 'DELETE' }],
    ['/api/account', { method: 'DELETE' }],
    ['/api/devices/me', { method: 'PUT', body: { name: 'x' } }],
    ['/api/sync?since=0', {}],
    ['/api/sync/memory', { method: 'PUT', body: { data: 'AAAA', base_rev: 0 } }],
    ['/api/sync', { method: 'DELETE' }],
    ['/api/push', { method: 'POST', body: { apns_token: 'ab'.repeat(32), push_type: 'alert', payload: { aps: {} } } }],
  ]) {
    const response = await hit(p, { ...opts, browser: false, token: value });
    assert.ok([403, 503].includes(response.status), `${p}: ${response.status}`);
    if (response.status === 503) assert.match(p, /push/); // no APNs key here: refused before the account
  }
  // The raw Anthropic proxy (no caps) is for the apps: a browser's token gets nothing there.
  for (const p of ['/api/anthropic/v1/messages', '/api/anthropic/v1/messages/count_tokens']) {
    const proxied = await hit(p, { method: 'POST', browser: false, token: value, body: { model: 'claude-opus-5-5', max_tokens: 128000, messages: [] } });
    assert.equal(proxied.status, 403, p);
    assert.equal((await proxied.json()).error.type, 'permission_error');
  }
  assert.ok(!calls.some((c) => c.url.startsWith('https://api.anthropic.com')));
  // Even with an APNs key, the account refuses a browser's push.
  const pushed = await env.ACCOUNTS.get(owner.account.id).fetch('https://account/push-check', {
    method: 'POST',
    headers: { 'x-jarvis-device': parseToken(value).device, 'x-jarvis-secret': parseToken(value).secret },
    body: JSON.stringify({ apns_token: 'ab'.repeat(32), push_type: 'alert' }),
  });
  assert.equal(pushed.status, 403);
  assert.equal((await hit('/api/account', { browser: false, token: owner.token })).status, 200, 'the account is still there');
  // It may sign itself out.
  const out = await hit('/api/web/signout', { method: 'POST', body: {}, session: value });
  assert.equal(out.status, 204);
  assert.ok(setCookies(out).some((c) => /^__Host-eden=; .*Max-Age=0/.test(c)));
  assert.equal((await hit('/api/web/session', { session: value })).status, 401);
  const listed = await (await hit('/api/account', { browser: false, token: owner.token })).json();
  assert.deepEqual(listed.devices.map((d) => d.kind), ['iphone']);
});

test('a browser session ends after 30 days, or when the app signs it out', async () => {
  const owner = await phone();
  const value = await signedInBrowser(owner);
  assert.equal((await hit('/', { session: value })).status, 200);
  assert.equal(env.assets.at(-1), '/eden/');
  // Signed out from the iPhone: the next page load is the sign-in page, and the cookie goes.
  await hit(`/api/devices/${parseToken(value).device}`, { method: 'DELETE', browser: false, token: owner.token });
  forgetSessions();
  const page = await hit('/', { session: value });
  assert.equal(env.assets.at(-1), '/signin/');
  assert.ok(setCookies(page).some((c) => c.startsWith('__Host-eden=;')));
  // Thirty days on, a session simply stops working.
  const later = await signedInBrowser(owner);
  env.ACCOUNTS.objects.get(owner.account.id).now = () => Date.now() + 31 * 86400_000;
  forgetSessions();
  assert.equal((await hit('/api/web/session', { session: later })).status, 401);
  const account = env.ACCOUNTS.objects.get(owner.account.id);
  assert.equal(await account.storage.get(`dev:${parseToken(later).device}`), undefined, 'and its device is gone');
});

test('EDEN_ACCOUNTS keeps Eden on the web to the accounts it lists', async () => {
  const owner = await phone();
  env.EDEN_ACCOUNTS = '00000000-0000-8000-8000-000000000000';
  const link = await startWebLink();
  const refused = await hit(`/api/link/${link.code}/approve`, { method: 'POST', browser: false, token: owner.token, body: {} });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).code, 'not_allowed');
  env.EDEN_ACCOUNTS = `${owner.account.id}, someone-else`;
  assert.ok(await signedInBrowser(owner));
});

test('every /api request that changes something refuses a foreign Origin; the apps send none', async () => {
  const owner = await phone();
  const evil = { origin: 'https://evil.example' };
  assert.equal((await hit('/api/web/link', { method: 'POST', body: {}, headers: evil })).status, 403);
  assert.equal((await hit('/api/web/link', { method: 'POST', body: {}, headers: { origin: 'null' } })).status, 403, 'a sandboxed frame');
  assert.equal((await hit('/api/account/apple', { method: 'POST', body: {}, headers: evil })).status, 403);
  assert.equal((await hit('/api/voice', { method: 'POST', body: { text: 'hi' }, headers: evil })).status, 403);
  assert.equal((await hit('/api/anthropic/v1/messages', { method: 'POST', token: owner.token, body: { model: 'claude-opus-5-5' }, headers: evil })).status, 403);
  assert.equal((await hit('/api/relay/listen', { token: owner.token, headers: { ...evil, upgrade: 'websocket' } })).status, 403, 'the relay upgrade too');
  // The apps (no Origin) carry on as before.
  assert.equal((await hit('/api/relay/listen', { browser: false, token: owner.token, headers: { upgrade: 'websocket' } })).status, 403, 'refused by the account (an iPhone never listens), not the Origin check');
  assert.equal((await hit('/api/account', { browser: false, token: owner.token })).status, 200);
  // Plain reads are untouched.
  assert.equal((await hit('/api/account', { browser: false, token: owner.token, headers: evil })).status, 200);
});

// ── Sign in with Apple on the web (behind its flag) ──

test('Sign in with Apple for the web stays off until WEB_APPLE_SERVICES_ID is set', async () => {
  assert.deepEqual(await (await hit('/api/web/config')).json(), { apple: false });
  assert.equal((await hit('/api/web/apple')).status, 404);
  assert.equal((await hit('/api/web/apple/callback', { method: 'POST', body: 'state=x', headers: { origin: 'https://appleid.apple.com', 'content-type': 'application/x-www-form-urlencoded' } })).status, 404);
});

test('Sign in with Apple on the web: state and nonce checked, only into an account the app made', async () => {
  env.WEB_APPLE_SERVICES_ID = 'com.bshventures.eden.web';
  assert.deepEqual(await (await hit('/api/web/config')).json(), { apple: true });
  const go = await hit('/api/web/apple');
  assert.equal(go.status, 302);
  const to = new URL(go.headers.get('location'));
  assert.equal(to.origin + to.pathname, 'https://appleid.apple.com/auth/authorize');
  assert.equal(to.searchParams.get('client_id'), 'com.bshventures.eden.web');
  assert.equal(to.searchParams.get('redirect_uri'), 'https://askeden.com/api/web/apple/callback');
  assert.equal(to.searchParams.get('response_mode'), 'form_post');
  const attempt = setCookies(go)[0];
  assert.match(attempt, /^__Host-eden-apple=[\w-]+\.[\w-]+; Path=\/; Secure; HttpOnly; SameSite=None; Max-Age=600$/);
  const [state, nonce] = cookieValue(go, '__Host-eden-apple').split('.');

  const back = async (fields, cookie = `__Host-eden-apple=${state}.${nonce}`) =>
    hit('/api/web/apple/callback', {
      method: 'POST',
      body: new URLSearchParams(fields).toString(),
      headers: { origin: 'https://appleid.apple.com', 'content-type': 'application/x-www-form-urlencoded', cookie },
    });
  const forApp = await identityToken({ nonce, aud: 'com.bshventures.eden.web' });
  // No account yet: refused (the app makes accounts).
  const none = await back({ id_token: forApp, state });
  assert.equal(none.status, 404);
  assert.match(await none.text(), /iPhone first/);
  const owner = await phone();
  assert.equal((await back({ id_token: forApp, state: 'other' })).status, 400, 'another state');
  assert.equal((await back({ id_token: await identityToken({ nonce: 'other', aud: 'com.bshventures.eden.web' }), state })).status, 401, 'another nonce');
  assert.equal((await back({ id_token: await identityToken({ nonce }), state })).status, 401, 'the app’s audience, not the Services ID');
  const ok = await back({ id_token: forApp, state });
  assert.equal(ok.status, 200);
  const html = await ok.text();
  assert.match(html, /http-equiv="refresh" content="0; url=\/"/);
  assert.match(ok.headers.get('content-security-policy'), /default-src 'none'/);
  const value = cookieValue(ok, '__Host-eden');
  assert.ok(setCookies(ok).some((c) => c.startsWith('__Host-eden=jv1.') && c.includes('SameSite=Strict')));
  const who = await (await hit('/api/web/session', { session: value })).json();
  assert.equal(who.account_id, owner.account.id);
  // Anyone else's page posting here: refused by the Origin check.
  assert.equal((await back({ id_token: forApp, state }, '').then(() => hit('/api/web/apple/callback', { method: 'POST', body: 'a=b', headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' } }))).status, 403);
});

// ── the pages ──

test('/ is the sign-in page signed out and Eden signed in, each with a strict CSP; Eden’s files need the session', async () => {
  const signin = await hit('/');
  assert.equal(signin.status, 200);
  assert.deepEqual(env.assets, ['/signin/']);
  assert.match(signin.headers.get('content-security-policy'), /^default-src 'none'; script-src 'self'; style-src 'self';/);
  assert.equal(signin.headers.get('x-frame-options'), 'DENY');
  assert.equal(signin.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.equal(signin.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(signin.headers.get('cache-control'), 'no-store');
  assert.equal((await hit('/app.js')).status, 401);
  assert.equal((await hit('/signin/signin.js')).status, 200);
  assert.equal((await hit('/signin/secret.txt')).status, 302);
  assert.equal((await hit('/eden/app.js')).status, 302, 'the copy itself is not reachable by its folder');

  const owner = await phone();
  const value = await signedInBrowser(owner);
  env.assets.length = 0;
  const eden = await hit('/', { session: value });
  assert.equal(eden.status, 200);
  assert.deepEqual(env.assets, ['/eden/']);
  const csp = eden.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(eden.headers.get('cross-origin-opener-policy'), 'same-origin');
  const js = await hit('/app.js', { session: value });
  assert.equal(js.status, 200);
  assert.equal(env.assets.at(-1), '/eden/app.js');
  assert.equal(js.headers.get('cache-control'), 'private, no-cache');
  assert.equal((await hit('/hosted.js', { session: value })).status, 200);
  // A cookie that isn't a browser's session (an app's token pasted in) is no session.
  forgetSessions();
  env.assets.length = 0;
  await hit('/', { session: owner.token });
  assert.deepEqual(env.assets, ['/signin/']);
});

test('the landing page, downloads, latest.json and Messenger keep working, the landing page with its own CSP', async () => {
  const landing = await hit('/download');
  assert.equal(landing.status, 200);
  assert.equal(env.assets.at(-1), '/jarvis/');
  assert.match(landing.headers.get('content-security-policy'), /fonts\.googleapis\.com/);
  assert.equal((await hit('/jarvis')).status, 200);
  assert.equal((await hit('/messenger/settings')).headers.get('location'), 'https://messenger.askeden.com/settings');
  assert.match((await hit('/messenger/iphone')).headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await hit('/pricing')).headers.get('location'), 'https://askeden.com/');
});

test('the Eden copy is web/chat plus the hosted script, and stays inside the page CSP', () => {
  assert.ok(EDEN_FILES.includes('index.html') && EDEN_FILES.includes('hosted.js') && EDEN_FILES.includes('app.js'));
  for (const name of EDEN_FILES) assert.ok(fs.existsSync(path.join(SITE, 'public', 'eden', name)), `public/eden/${name}`);
  const html = fs.readFileSync(path.join(SITE, 'public', 'eden', 'index.html'), 'utf8');
  assert.match(html, /<script type="module" src="hosted\.js"><\/script>\n<\/head>/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'no inline <script> (script-src self)');
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'no on…= handlers');
  assert.doesNotMatch(html, /(src|href)="(https?:)?\/\//i, 'nothing from another origin');
  for (const reserved of ['download', 'latest.json', 'jarvis', 'messenger', 'api', 'artifact', 'signin']) assert.ok(!EDEN_FILES.includes(reserved));
});

// ── hosted chat ──

test('meta: Claude on the account, everything else "needs your Mac"; Mac-only routes say so', async () => {
  const value = await signedInBrowser(await phone());
  const meta = await (await chat('/api/chat/meta', value)).json();
  assert.deepEqual(meta.models.map((m) => m.id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5']);
  assert.ok(meta.models.every((m) => m.available && !m.efforts.includes('xhigh') && !m.efforts.includes('max')), 'effort capped at high');
  assert.deepEqual(meta.providers.map((p) => [p.id, p.available]), [['anthropic', true], ['openai', false], ['gemini', false], ['kimi', false]]);
  assert.match(meta.providers[1].reason, /Needs your Mac/);
  assert.equal(meta.classifier.available, false);
  assert.equal(meta.jarvis.available, false);
  assert.equal(meta.code.available, false);
  assert.equal(meta.levels.length, 5);
  assert.deepEqual(await (await chat('/api/chat/jarvis/status', value)).json(), { available: false, reason: meta.jarvis.reason });
  for (const [p, method] of [['/api/chat/jarvis', 'POST'], ['/api/chat/projects', 'GET'], ['/api/chat/code', 'POST'], ['/api/chat/keys', 'GET'], ['/api/chat/keys', 'POST'], ['/api/chat/gmail', 'POST'], ['/api/chat/google/status', 'GET'], ['/api/chat/code/changes', 'GET'], ['/api/chat/gcal/status', 'GET'], ['/api/chat/something-new', 'POST']]) {
    const response = await chat(p, value, { method, ...(method === 'POST' ? { body: {} } : {}) });
    assert.equal(response.status, 503, p);
    const body = await response.json();
    assert.equal(body.code, 'needs_mac');
    assert.match(body.error, /^Needs your Mac/);
  }
  // Fewer models, a different effort cap: Worker vars.
  env.EDEN_MODELS = 'claude-sonnet-5-5, gpt-6-sol, claude-opus-4-1';
  env.EDEN_MAX_EFFORT = 'medium';
  const narrow = await (await chat('/api/chat/meta', value)).json();
  assert.deepEqual(narrow.models.map((m) => [m.id, m.efforts.at(-1)]), [['claude-sonnet-5-5', 'medium']]);
});

test('the chat API: signed in, its header, same-origin JSON POSTs, no CORS', async () => {
  const value = await signedInBrowser(await phone());
  assert.equal((await hit('/api/chat/meta', { headers: { 'x-jarvis-chat': '1' } })).status, 401, 'signed out');
  assert.equal((await hit('/api/chat/meta', { session: value })).status, 403, 'no X-Jarvis-Chat');
  assert.equal((await chat('/api/chat/meta', value, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await chat('/api/chat/meta', value, { method: 'OPTIONS', headers: { origin: ORIGIN } })).status, 403);
  assert.equal((await chat('/api/chat/send', value, { method: 'POST', body: {}, headers: { origin: 'https://evil.example' } })).status, 403);
  const noOrigin = await worker.fetch(new Request(`${ORIGIN}/api/chat/send`, { method: 'POST', headers: { 'x-jarvis-chat': '1', 'content-type': 'application/json', cookie: `__Host-eden=${value}` }, body: '{}' }), env, ctx);
  assert.equal(noOrigin.status, 403, 'a cookie alone never sends a turn');
  assert.equal((await chat('/api/chat/send', value, { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await turn(value, { messages: [] })).status, 400);
  // An app's token can't be used as a cookie session for chat either.
  const owner = await phone('apple-user-2');
  assert.equal((await chat('/api/chat/meta', owner.token)).status, 401);
});

test('POST /api/route: the Model Router picks among the hosted Claude models, rules only', async () => {
  const value = await signedInBrowser(await phone());
  const preview = await (await hit('/api/route', { method: 'POST', session: value, body: { prompt: 'Prove there are infinitely many primes, rigorously.', level: 3, providers: ['anthropic', 'openai'], classifier: 'always' } })).json();
  assert.ok(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'].includes(preview.pick.model));
  assert.ok(!['xhigh', 'max'].includes(preview.pick.effort));
  assert.equal(preview.classification.mode, 'off');
  assert.ok(preview.rows.length >= 1 && preview.rows.every((r) => r.provider === 'anthropic'));
  assert.match(preview.scope, /askeden\.com/);
  assert.equal((await hit('/api/route', { method: 'POST', session: value, body: { prompt: ' ' } })).status, 400);
  assert.equal((await hit('/api/route', { method: 'POST', session: value, body: { prompt: 'hi', providers: ['openai'] } })).status, 422);
  assert.equal((await hit('/api/route', { method: 'POST', body: { prompt: 'hi' } })).status, 401);
});

test('a turn streams route, text, usage and done; Claude on the Worker key with model, max_tokens and tools set here', async () => {
  const owner = await phone();
  const value = await signedInBrowser(owner);
  let sent;
  anthropic = (body, init) => {
    sent = { body, headers: init.headers };
    return new Response(sseBody(claudeAnswer({ model: body.model, input: 20000, output: 3000, thinking: ['Let me think. '] })), { headers: { 'content-type': 'text/event-stream' } });
  };
  const response = await turn(value, {
    messages: [
      { role: 'user', content: 'Hi', attachments: [{ kind: 'text', name: 'notes.md', text: 'some notes' }, { kind: 'image', name: 'a.png', mime: 'image/png', data: 'iVBORw0KGgo=' }] },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'Write me a haiku about autumn.' },
    ],
    // What a page can't decide: these are ignored.
    model: 'claude-fable-5-1',
    max_tokens: 128000,
    tools: [{ type: 'bash_20250124', name: 'bash' }],
    system: 'Be brief.',
    context: [{ title: 'Jarvis note: Trip', text: 'Lyon in May' }],
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const events = await readEvents(response);
  assert.deepEqual(events.map((e) => e.type), ['route', 'thinking', 'text', 'text', 'usage', 'done']);
  const route = events[0].data;
  assert.ok(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'].includes(route.model));
  assert.equal(route.provider, 'anthropic');
  assert.equal(route.ratedBy, 'rules');
  assert.ok(route.candidates.some((c) => c.chosen));
  assert.ok(route.notes.some((n) => /askeden\.com/.test(n)));
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.data.text).join(''), 'Good evening.');
  assert.deepEqual(events.at(-1).data, { finish: 'stop' });
  const usage = events.find((e) => e.type === 'usage').data;
  assert.equal(usage.inputTokens, 20000);
  assert.equal(usage.notional, false);
  assert.ok(usage.costUSD > 0);

  // What went to Anthropic.
  assert.equal(sent.headers['x-api-key'], 'sk-test');
  assert.ok(!JSON.stringify(sent.headers).includes(value), 'the session never goes to Anthropic');
  assert.equal(sent.body.model, route.model);
  assert.ok(sent.body.max_tokens <= DEFAULTS.maxTokens);
  assert.equal(sent.body.tools, undefined);
  assert.equal(sent.body.stream, true);
  assert.match(sent.body.system, /Jarvis note: Trip[\s\S]*Lyon in May[\s\S]*Be brief\./);
  assert.equal(sent.body.messages.length, 3);
  assert.deepEqual(sent.body.messages[0].content.map((b) => b.type), ['image', 'text']);
  assert.match(sent.body.messages[0].content[1].text, /<attachment name="notes.md">\nsome notes/);
  if (sent.body.thinking?.type === 'adaptive') assert.equal(sent.body.thinking.display, 'summarized');
  assert.ok(!['xhigh', 'max'].includes(sent.body.output_config?.effort));

  // It was counted on the account: the trial, at list prices.
  const account = await (await hit('/api/account', { browser: false, token: owner.token })).json();
  assert.equal(account.usage.trial_left_usd, Math.round((1 - usage.costUSD) * 1e6) / 1e6);
});

test('a turn the browser stops is still counted: input in full, output as far as it streamed', async () => {
  const owner = await phone();
  const value = await signedInBrowser(owner);
  let upstream;
  anthropic = (body) => {
    upstream = sseBody(claudeAnswer({ model: 'claude-sonnet-5-5', input: 100000, text: ['x'.repeat(3000)], final: false }), { hold: true });
    return new Response(upstream, { headers: { 'content-type': 'text/event-stream' } });
  };
  const response = await turn(value, { override: { model: 'claude-sonnet-5-5', effort: 'low' } }, { raw: true });
  const reader = response.body.getReader();
  let seen = '';
  while (!seen.includes('event: text')) seen += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel(); // the Stop button
  await settle();
  assert.ok(upstream.wasCancelled(), 'the request to Anthropic is cancelled');
  const account = await (await hit('/api/account', { browser: false, token: owner.token })).json();
  // Sonnet 5.5 at $2 / $10: 100,000 in = $0.20, 3,000 chars ≈ 1,000 out = $0.01.
  assert.equal(account.usage.trial_left_usd, 0.79);
});

test('the included-AI proxy counts a stopped stream too (F9: metering used to run only at the end)', async () => {
  const owner = await phone();
  let upstream;
  anthropic = () => {
    upstream = sseBody(claudeAnswer({ model: 'claude-opus-5-5', input: 20000, text: ['y'.repeat(3000)], final: false }), { hold: true });
    return new Response(upstream, { headers: { 'content-type': 'text/event-stream' } });
  };
  const response = await hit('/api/anthropic/v1/messages', { method: 'POST', browser: false, token: owner.token, body: { model: 'claude-opus-5-5', stream: true, max_tokens: 10, messages: [] } });
  const reader = response.body.getReader();
  let seen = '';
  while (!seen.includes('y"}}\n')) seen += new TextDecoder().decode((await reader.read()).value); // the text so far, shown
  await reader.cancel(); // Claude Code's Esc, the iPhone's Stop
  await settle();
  assert.ok(upstream.wasCancelled());
  const account = await (await hit('/api/account', { browser: false, token: owner.token })).json();
  // Opus 5.5 at $4 / $20: 20,000 in = $0.08, 3,000 chars ≈ 1,000 out = $0.02.
  assert.equal(account.usage.trial_left_usd, 0.9);
});

test('no allowance left: refused before anything is sent; little left: the reply is fitted to it', async () => {
  const owner = await phone();
  const value = await signedInBrowser(owner);
  const account = env.ACCOUNTS.objects.get(owner.account.id);
  await account.storage.put('usage', { month: new Date().toISOString().slice(0, 7), spent: 0, trial_spent: 0.99 });
  let sent;
  anthropic = (body) => {
    sent = body;
    return new Response(sseBody(claudeAnswer({ model: body.model, input: 10, output: 10 })), { headers: { 'content-type': 'text/event-stream' } });
  };
  const ok = await turn(value, { override: { model: 'claude-haiku-4-5', effort: 'none' } });
  assert.equal(ok.status, 200);
  await readEvents(ok);
  assert.ok(sent.max_tokens <= 2000, `fitted to $0.01 at Haiku's $5/M output: ${sent.max_tokens}`);
  await account.storage.put('usage', { month: new Date().toISOString().slice(0, 7), spent: 0, trial_spent: 1 });
  calls.length = 0;
  const refused = await turn(value, {});
  assert.equal(refused.status, 402);
  assert.match((await refused.json()).error, /trial/);
  assert.ok(!calls.some((c) => c.url.includes('anthropic')), 'nothing went to Anthropic');
});

test('turns at once hold their worst case on the allowance: at most two, and never past what is left', async () => {
  const owner = await phone();
  const value = await signedInBrowser(owner);
  const streams = [];
  anthropic = (body) => {
    const held = sseBody(claudeAnswer({ model: body.model, input: 10, text: ['Thinking it over'], final: false }), { hold: true });
    streams.push(held);
    return new Response(held, { headers: { 'content-type': 'text/event-stream' } });
  };
  const pinned = { override: { model: 'claude-sonnet-5-5', effort: 'low' } };
  const one = await turn(value, pinned, { raw: true });
  const two = await turn(value, pinned, { raw: true });
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  const account = env.ACCOUNTS.objects.get(owner.account.id);
  try {
    assert.equal(account.holds.size, 2);
    const worst = [...account.holds.values()].map((h) => h.usd);
    assert.ok(worst.every((usd) => usd > 0));
    assert.equal((await account.allowAi()).left, Math.round((1 - worst[0] - worst[1]) * 1e6) / 1e6, 'what the two may still cost is set aside');
    const three = await turn(value, pinned, { raw: true });
    assert.equal(three.status, 429);
  } finally {
    // Done (here: stopped), they let go.
    for (const r of [one, two]) await r.body.cancel();
    await settle();
  }
  assert.equal(account.holds.size, 0);
  assert.ok((await account.allowAi()).left > 0.99);
  const again = await turn(value, pinned, { raw: true });
  assert.equal(again.status, 200);
  await again.body.cancel();
  await settle();
});

test('a browser sign-in that ran out, or a sixth one, makes room instead of filling the account', async () => {
  const owner = await phone();
  const sessions = [];
  for (let i = 0; i < 6; i++) sessions.push(await signedInBrowser(owner));
  const account = env.ACCOUNTS.objects.get(owner.account.id);
  const kinds = async () => (await account.devices()).map((d) => d.kind).sort();
  assert.deepEqual(await kinds(), ['iphone', 'web', 'web', 'web', 'web', 'web']);
  forgetSessions();
  assert.equal((await hit('/api/web/session', { session: sessions[0] })).status, 401, 'the oldest browser was signed out');
  assert.equal((await hit('/api/web/session', { session: sessions[5] })).status, 200);
  // Thirty days on, the next device made clears the browsers that ran out.
  account.now = () => Date.now() + 31 * 86400_000;
  await phone('apple-user-1', 'iPad');
  assert.deepEqual(await kinds(), ['iphone', 'iphone']);
});

test('a Mac link can’t be named like a browser sign-in; an Anthropic error mid-stream is still counted', async () => {
  const link = await (await hit('/api/link/start', { method: 'POST', browser: false, body: { name: 'Eden on the web: Safari on a Mac', kind: 'mac', public_key: bytesToB64(new Uint8Array(32).fill(7)) } })).json();
  const owner = await phone();
  const peek = await (await hit(`/api/link/${link.code}`, { browser: false, token: owner.token })).json();
  assert.equal(peek.name, 'Mac: Eden on the web: Safari on a Mac');
  assert.equal(peek.kind, 'mac');
  const plain = await (await hit('/api/link/start', { method: 'POST', browser: false, body: { name: "Bilel's MacBook Air", kind: 'mac', public_key: bytesToB64(new Uint8Array(32).fill(7)) } })).json();
  assert.equal((await (await hit(`/api/link/${plain.code}`, { browser: false, token: owner.token })).json()).name, "Bilel's MacBook Air");
  // The proxy: an error event, then the stream closes normally. What streamed is counted.
  anthropic = () => new Response(sseBody([...claudeAnswer({ model: 'claude-opus-5-5', input: 20000, text: ['w'.repeat(3000)], final: false }), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]), { headers: { 'content-type': 'text/event-stream' } });
  const response = await hit('/api/anthropic/v1/messages', { method: 'POST', browser: false, token: owner.token, body: { model: 'claude-opus-5-5', stream: true, max_tokens: 10, messages: [] } });
  await response.text();
  await settle();
  const account = await (await hit('/api/account', { browser: false, token: owner.token })).json();
  assert.equal(account.usage.trial_left_usd, 0.9);
});

test('overrides only among the hosted models; a failure before any text falls back once', async () => {
  const value = await signedInBrowser(await phone());
  const elsewhere = await turn(value, { override: { model: 'gpt-6-sol' } });
  assert.equal(elsewhere.status, 422);
  assert.match((await elsewhere.json()).error, /needs your Mac/);
  const models = [];
  anthropic = (body) => {
    models.push(body.model);
    if (models.length === 1) return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), { status: 529 });
    return new Response(sseBody(claudeAnswer({ model: body.model })), { headers: { 'content-type': 'text/event-stream' } });
  };
  const events = await readEvents(await turn(value, { messages: [{ role: 'user', content: 'Explain how a transformer language model works, in depth.' }] }));
  assert.deepEqual(events.map((e) => e.type).filter((t) => t !== 'text'), ['route', 'fallback', 'route', 'usage', 'done']);
  assert.notEqual(models[0], models[1]);
  assert.match(events[1].data.reason, /busy/);
  assert.match(events[2].data.rationale, /^Fallback:/);
  // An override doesn't fall back: the error is the answer.
  models.length = 0;
  const pinned = await readEvents(await turn(value, { override: { model: 'claude-opus-5-5', effort: 'xhigh' } }));
  assert.deepEqual(pinned.map((e) => e.type), ['route', 'error']);
  assert.equal(pinned[0].data.effort, 'high', 'xhigh is above the cap');
});

test('search and research use Claude’s web search tool, capped here, with citations', async () => {
  const value = await signedInBrowser(await phone());
  let sent;
  anthropic = (body) => {
    sent = body;
    return new Response(sseBody(claudeAnswer({ model: body.model, citations: [{ url: 'https://example.com/a', title: 'Example A' }, { url: 'javascript:alert(1)', title: 'bad' }] })), { headers: { 'content-type': 'text/event-stream' } });
  };
  const events = await readEvents(await turn(value, { mode: 'search', messages: [{ role: 'user', content: 'What happened in the news today?' }] }));
  assert.deepEqual(sent.tools, [searchTool(sent.model, 5)]);
  assert.match(sent.system, /Search the web/);
  assert.deepEqual(events.find((e) => e.type === 'citations').data, { sources: [{ title: 'Example A', url: 'https://example.com/a' }] });
  const research = () => turn(value, { mode: 'research', override: { model: 'claude-sonnet-5-5', effort: 'low' }, messages: [{ role: 'user', content: 'Research heat pumps.' }] });
  // Ten searches' worst case (each re-reads the conversation and the results so far) is more
  // than a $1 trial holds: as many as fit.
  await readEvents(await research());
  assert.ok(sent.tools[0].max_uses < 10 && sent.tools[0].max_uses >= 1, `${sent.tools[0].max_uses}`);
  env.TRIAL_BUDGET_USD = '20';
  await readEvents(await research());
  assert.equal(sent.tools[0].max_uses, 10);
  assert.equal(sent.output_config.effort, 'high', 'research runs at high effort');
  assert.equal(searchTool('claude-haiku-4-5', 3).type, 'web_search_20250305');
  assert.equal(searchTool('claude-opus-5-5', 3).type, 'web_search_20260209');
});

test('artifacts: kept for the account a few hours, served under the sandbox CSP, never to anyone else', async () => {
  const owner = await phone();
  const value = await signedInBrowser(owner);
  const html = `<!doctype html><p>${'é'.repeat(70000)}</p><script>document.title = 'x'</script>`;
  const made = await chat('/api/chat/artifact', value, { method: 'POST', body: { html } });
  assert.equal(made.status, 200);
  const { url } = await made.json();
  assert.match(url, /^\/artifact\/[0-9a-f]{24}$/);
  const shown = await hit(url, { session: value });
  assert.equal(shown.status, 200);
  assert.equal(await shown.text(), html);
  assert.equal(shown.headers.get('content-security-policy'), "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; frame-ancestors 'self'");
  assert.equal((await hit(url)).status, 401, 'signed out');
  const stranger = await signedInBrowser(await phone('apple-user-3'));
  assert.equal((await hit(url, { session: stranger })).status, 404, 'another account');
  assert.equal((await chat('/api/chat/artifact', value, { method: 'POST', body: { html: 'x'.repeat(2 * 1024 * 1024 + 1) } })).status, 413);
  // Six hours on, it's gone (and the alarm clears it).
  const account = env.ACCOUNTS.objects.get(owner.account.id);
  assert.ok(account.storage.alarm > Date.now());
  account.now = () => Date.now() + 7 * 3600_000;
  assert.equal((await hit(url, { session: value })).status, 404);
  await account.alarm();
  assert.equal([...account.storage.map.keys()].filter((k) => k.startsWith('arth:') || k.startsWith('artc:')).length, 0);
  // Saving one never reads the others' pieces: only their heads are listed.
  const listed = [];
  const list = account.storage.list.bind(account.storage);
  account.storage.list = (opts) => (listed.push(opts.prefix), list(opts));
  account.now = () => Date.now();
  await chat('/api/chat/artifact', value, { method: 'POST', body: { html } });
  assert.deepEqual(listed, ['arth:']);
});

test('hosted settings come from Worker vars, with safe defaults', () => {
  const cfg = hostedConfig({});
  assert.deepEqual(cfg.models.map((m) => m.id), DEFAULTS.models.split(','));
  assert.equal(cfg.maxTokens, 16000);
  assert.equal(hostedConfig({ EDEN_MAX_TOKENS: 'lots' }).maxTokens, 16000);
  assert.equal(hostedConfig({ EDEN_MAX_EFFORT: 'ultra' }).maxEffort, 'high');
  const opus48 = hostedConfig({ EDEN_MODELS: 'claude-opus-4-8' }).models[0];
  assert.deepEqual(effortsFor(opus48, 'high'), ['none', 'low', 'medium', 'high']);
});
