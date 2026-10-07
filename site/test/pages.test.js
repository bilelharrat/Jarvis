// askeden.com's pages by who's signed in (src/eden/pages.js): the landing page with "Sign in
// to Eden" at / signed out, the sign-in page at /signin (and back to / once signed in), Eden at
// / signed in; and the sign-in page's files staying inside its strict CSP.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Link, appleJwk, identityToken, namespace } from './fakes.js';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://askeden.com';
const read = (p) => fs.readFileSync(path.join(SITE, p), 'utf8');

let env;
const realFetch = globalThis.fetch;

beforeEach(() => {
  forgetAppleKeys();
  forgetSessions();
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    throw new Error(`unexpected fetch ${url}`);
  };
  env = { TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20' };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.assets = [];
  env.ASSETS = {
    fetch: async (req) => {
      const p = new URL(req.url).pathname;
      env.assets.push(p);
      return new Response(`asset ${p}`, { headers: { 'content-type': 'text/html', 'cache-control': 'public, max-age=0, must-revalidate' } });
    },
  };
});

after(() => {
  globalThis.fetch = realFetch;
});

function hit(p, { method = 'GET', body, session, token, headers = {} } = {}) {
  const h = { 'user-agent': 'Mozilla/5.0 (Macintosh) Safari/605.1.15', ...headers };
  if (method !== 'GET' && token === undefined) h.origin = ORIGIN;
  if (session) h.cookie = `__Host-eden=${session}`;
  if (token) h.authorization = `Bearer ${token}`;
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  return worker.fetch(new Request(`${ORIGIN}${p}`, init), env, { waitUntil() {} });
}

const setCookies = (r) => r.headers.getSetCookie();

/** An iPhone's account, and a browser it approved: that browser's session cookie value. */
async function signedIn() {
  const made = await (await hit('/api/account/apple', {
    method: 'POST',
    token: null,
    body: { identity_token: await identityToken({ sub: 'pages-user' }), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } },
  })).json();
  const start = await hit('/api/web/link', { method: 'POST', body: {} });
  const link = await start.json();
  const linkCookie = setCookies(start).find((c) => c.startsWith('__Host-eden-link=')).split(';')[0];
  const approved = await hit(`/api/link/${link.code}/approve`, { method: 'POST', token: made.token, body: { sealed_key: null, sender_key: null } });
  assert.equal(approved.status, 200, await approved.clone().text());
  const done = await hit('/api/web/link/poll', { method: 'POST', body: {}, headers: { cookie: linkCookie } });
  return setCookies(done).find((c) => c.startsWith('__Host-eden=')).split(';')[0].slice('__Host-eden='.length);
}

const LANDING = /fonts\.googleapis\.com/;
// /signin adds only Turnstile's script and frame (accounts/turnstile.js) and its own form posts.
const SIGNIN = /^default-src 'none'; script-src 'self' https:\/\/challenges\.cloudflare\.com; frame-src https:\/\/challenges\.cloudflare\.com; style-src 'self'; img-src 'self' data:;/;

test('signed out, / is the landing page (its own CSP), never cached, varying by cookie', async () => {
  const home = await hit('/');
  assert.equal(home.status, 200);
  assert.deepEqual(env.assets, ['/jarvis/']);
  assert.match(home.headers.get('content-security-policy'), LANDING);
  assert.equal(home.headers.get('cache-control'), 'no-store');
  assert.equal(home.headers.get('vary'), 'cookie');
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.deepEqual(setCookies(home), [], 'no cookie, nothing to clear');
  // /download and /jarvis are the same page, cacheable as before.
  const download = await hit('/download');
  assert.equal(env.assets.at(-1), '/jarvis/');
  assert.notEqual(download.headers.get('cache-control'), 'no-store');
  // Eden's own files stay closed.
  assert.equal((await hit('/app.js')).status, 401);
  assert.equal((await hit('/index.html')).status, 200);
  assert.equal(env.assets.at(-1), '/jarvis/');
});

test('a session cookie that no longer works is cleared at / and at /signin', async () => {
  for (const p of ['/', '/signin']) {
    const res = await hit(p, { session: 'jv1.not-a-real.session' });
    assert.equal(res.status, 200, p);
    assert.ok(setCookies(res).some((c) => /^__Host-eden=; .*Max-Age=0/.test(c)), p);
  }
});

test('/signin is the sign-in page with its strict CSP; its files are served, nothing else under it', async () => {
  for (const p of ['/signin', '/signin/']) {
    env.assets.length = 0;
    const res = await hit(p);
    assert.equal(res.status, 200, p);
    assert.deepEqual(env.assets, ['/signin/']);
    assert.match(res.headers.get('content-security-policy'), SIGNIN);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('vary'), 'cookie');
  }
  assert.equal((await hit('/signin/signin.js')).status, 200);
  assert.equal((await hit('/signin/signin.css')).status, 200);
  assert.equal((await hit('/signin/other.js')).status, 302);
});

test('a sign-in that came back to / with ?error= is shown on the sign-in page', async () => {
  const res = await hit('/?error=cancelled&provider=google');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/signin?error=cancelled&provider=google');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('signed in, / is Eden and /signin goes back to /', async () => {
  const session = await signedIn();
  env.assets.length = 0;
  const eden = await hit('/', { session });
  assert.equal(eden.status, 200);
  assert.deepEqual(env.assets, ['/eden/']);
  assert.match(eden.headers.get('content-security-policy'), /^default-src 'self'; script-src 'self';/);
  assert.equal(eden.headers.get('vary'), 'cookie');
  assert.equal(eden.headers.get('cache-control'), 'no-store');
  const signin = await hit('/signin', { session });
  assert.equal(signin.status, 302);
  assert.equal(signin.headers.get('location'), '/');
  assert.equal(signin.headers.get('vary'), 'cookie');
  assert.equal((await hit('/?error=cancelled', { session })).status, 200, 'signed in: Eden, whatever the query');
  assert.equal((await hit('/app.js', { session })).status, 200);
});

test('the sign-in page keeps to its CSP: no inline script or style, nothing from elsewhere', () => {
  const html = read('public/signin/index.html');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'no inline <script>');
  assert.doesNotMatch(html, /<style|\sstyle=/i, 'no inline styles (style-src self)');
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'no on…= handlers');
  assert.doesNotMatch(html, /(src|href)="(https?:)?\/\//i, 'nothing from another origin');
  // The three ways in.
  assert.match(html, /href="\/api\/web\/apple"[^>]*>[\s\S]*?Continue with Apple/);
  assert.match(html, /href="\/api\/web\/google"[^>]*>[\s\S]*?Continue with Google/);
  assert.match(html, /Approve from your iPhone/);
  const js = read('public/signin/signin.js');
  for (const call of ['/api/web/config', '/api/web/link', '/api/web/link/poll']) assert.ok(js.includes(`'${call}'`), call);
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|document\.write/, 'text only');
});

test('the landing page has "Sign in to Eden" for the sign-in page', () => {
  const html = read('public/jarvis/index.html');
  assert.ok((html.match(/href="\/signin"[^>]*>Sign in to Eden</g) || []).length >= 1);
});

test('/privacy and /terms: everyone, static, their own strict CSP; linked from the landing page and /signin', async () => {
  for (const p of ['/privacy', '/terms']) {
    env.assets.length = 0;
    const res = await hit(p);
    assert.equal(res.status, 200, p);
    assert.deepEqual(env.assets, [`${p}/`]);
    assert.match(res.headers.get('content-security-policy'), /^default-src 'none'; style-src 'self';/);
    assert.doesNotMatch(res.headers.get('content-security-policy'), /script-src/);
  }
  const pub = (f) => read(`public/${f}`);
  for (const f of ['jarvis/index.html', 'signin/index.html']) assert.match(pub(f), /href="\/privacy"[\s\S]*href="\/terms"/, f);
  const privacy = pub('privacy/index.html');
  for (const must of ['Harrat Global Holdings, Inc.', 'support@askeden.com', 'October 7, 2026', 'Limited Use', 'Stripe', 'Cloudflare', 'Moonshot', 'don’t sell']) assert.ok(privacy.includes(must), must);
  assert.match(pub('terms/index.html'), /Delaware/);
});
