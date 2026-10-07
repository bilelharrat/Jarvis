// Coming back after signing in (/signin?return=…; docs/web-auth.md "Where a sign-in ends"):
// the open-redirect rules of public/signin/return.js, and the return address carried through
// Sign in with Apple and with Google in the attempt's own cookie, never read from the callback.
// Apple's and Google's keys are WebCrypto RSA keys made here (fakes.js), as in auth.test.js.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { b64urlText } from '../src/accounts/util.js';
import { forgetGoogleKeys } from '../src/eden/google.js';
import { forgetSessions } from '../src/eden/session.js';
import { RETURN_MAX, safeReturn } from '../public/signin/return.js';
import { Account, GOOGLE_CLIENT, Identity, Link, appleJwk, google, googleIdToken, identityToken, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const SERVICES_ID = 'com.askeden.eden.web';
const CONNECT = '/eden/connect?client_id=messenger&redirect_uri=https%3A%2F%2Fmessenger.askeden.com%2Feden%2Fconnected&state=state-1234567890&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256';
const ctx = { waitUntil: () => {} };
const realFetch = globalThis.fetch;
let env;
let nextGoogle;

// Everything a return address must never become, whatever the encoding.
const HOSTILE = [
  '//evil.example',
  '///evil.example',
  '/\\evil.example',
  '/\\/evil.example',
  '\\\\evil.example',
  '\\/evil.example',
  'https://evil.example/',
  'http:evil.example',
  'HTTPS://evil.example',
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:x',
  'evil.example',
  ' /x',
  '/\t/evil.example',
  '/\n/evil.example',
  '/\r\nSet-Cookie: x=1',
  '/ /evil.example',
  '/\u00a0/evil.example',
  '/\u2028/evil.example',
  '/%2F%2Fevil.example',
  '/%2f/evil.example',
  '/%5Cevil.example',
  '/%5c%5cevil.example',
  '/%0a/evil.example',
  '/%E0%A4%A',
  '/api/web/handoff?code=' + 'A'.repeat(43),
  '/API/web/signout',
  '/api',
  '/%61pi/web/handoff?code=x',
  '/./api/web/handoff',
  '/eden/../api/web/handoff',
  '/x"onmouseover="alert(1)',
  "/x'><script>alert(1)</script>",
  '/<script>',
  '/`x`',
  '',
  `/${'a'.repeat(RETURN_MAX)}`,
];

test('safeReturn: only a path of this site comes back; every trick is "/"', () => {
  for (const raw of HOSTILE) assert.equal(safeReturn(raw), '/', JSON.stringify(raw));
  for (const raw of [undefined, null, 42, ['/x'], { toString: () => '/x' }]) assert.equal(safeReturn(raw), '/', String(raw));
  // What's allowed comes back as a URL parser writes it.
  assert.equal(safeReturn('/'), '/');
  assert.equal(safeReturn('/#account'), '/#account');
  assert.equal(safeReturn('/#tasks'), '/#tasks');
  assert.equal(safeReturn('/#delegate=ABCD-EFGH-JKLM'), '/#delegate=ABCD-EFGH-JKLM');
  assert.equal(safeReturn('/#account?error=taken&provider=google'), '/#account?error=taken&provider=google');
  assert.equal(safeReturn(CONNECT), CONNECT);
  assert.equal(safeReturn('/download'), '/download');
  assert.equal(safeReturn('/@evil.example'), '/@evil.example', 'a path on this site, not a host');
  assert.equal(safeReturn('/eden/./connect'), '/eden/connect');
  assert.equal(safeReturn('/signin?return=//evil.example'), '/signin?return=//evil.example', 'checked again when that one is used');
  assert.equal(safeReturn(`/${'a'.repeat(RETURN_MAX - 1)}`).length, RETURN_MAX);
  // Whatever comes out is safe to put back in: the same rule says the same.
  for (const raw of ['/#tasks', CONNECT, '/eden/./connect']) assert.equal(safeReturn(safeReturn(raw)), safeReturn(raw));
});

// ── the sign-in flows ──

function makeEnv() {
  const e = {
    TRIAL_BUDGET_USD: '1',
    PLUS_BUDGET_USD: '20',
    WEB_APPLE_SERVICES_ID: SERVICES_ID,
    GOOGLE_CLIENT_ID: GOOGLE_CLIENT,
    GOOGLE_CLIENT_SECRET: 'test-secret',
    AUTH_RATE: rateLimiter(),
    LINK_RATE: rateLimiter(),
    EDEN_RATE: rateLimiter(),
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
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'ya29.x', expires_in: 3599, id_token: await googleIdToken(nextGoogle) });
    throw new Error(`unexpected fetch ${url}`);
  };
  env = makeEnv();
});

after(() => {
  globalThis.fetch = realFetch;
});

function hit(p, { method = 'GET', body, headers = {}, session } = {}) {
  const h = { 'cf-connecting-ip': '198.51.100.9', 'user-agent': 'Mozilla/5.0 (Macintosh) Safari/605.1.15', ...headers };
  if (method !== 'GET' && method !== 'HEAD') h.origin ??= ORIGIN;
  if (session) h.cookie = [`__Host-eden=${session}`, h.cookie].filter(Boolean).join('; ');
  return worker.fetch(new Request(`${ORIGIN}${p}`, { method, headers: h, ...(body !== undefined ? { body } : {}) }), env, ctx);
}

const cookieValue = (response, name) => {
  const found = response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1).split(';')[0] : undefined;
};

/** Where a finished sign-in sends the browser: a redirect's Location, or the onward page's refresh. */
async function landing(response) {
  if (response.status === 303 || response.status === 302) return response.headers.get('location');
  assert.equal(response.status, 200, `status ${response.status}`);
  const html = await response.clone().text();
  const m = /http-equiv="refresh" content="0; url=([^"]+)"/.exec(html);
  assert.ok(m, 'an onward page');
  const link = /<a class="button" href="([^"]+)"/.exec(html);
  assert.equal(link[1], m[1], 'the link says the same');
  return m[1].replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const q = (back) => (back === undefined ? '' : `?return=${encodeURIComponent(back)}`);

/** Sign in with Google: start (with `back`), Google's consent (faked), the callback (`callbackExtra` added to its query). */
async function googleFlow({ back, callbackExtra = '', cookie } = {}) {
  const start = await hit(`/api/web/google${q(back)}`);
  if (start.status !== 302) return { start, response: start };
  const to = new URL(start.headers.get('location'));
  const attempt = cookieValue(start, '__Host-eden-google');
  nextGoogle = { ...nextGoogle, nonce: to.searchParams.get('nonce') };
  const jar = cookie ? cookie(attempt) : attempt;
  const response = await hit(`/api/web/google/callback?state=${to.searchParams.get('state')}&code=4%2Fcode${callbackExtra}`, { headers: { cookie: `__Host-eden-google=${jar}` } });
  return { start, attempt, response, session: cookieValue(response, '__Host-eden') };
}

/** Sign in with Apple on the web (form_post back), started with `back`. */
async function appleFlow({ back, sub = 'apple-user-1', formExtra = {} } = {}) {
  const start = await hit(`/api/web/apple${q(back)}`);
  if (start.status !== 302) return { start, response: start };
  const attempt = cookieValue(start, '__Host-eden-apple');
  const [state, nonce] = attempt.split('.');
  const response = await hit('/api/web/apple/callback', {
    method: 'POST',
    body: new URLSearchParams({ state, id_token: await identityToken({ sub, nonce, aud: SERVICES_ID }), ...formExtra }).toString(),
    headers: { origin: 'https://appleid.apple.com', 'content-type': 'application/x-www-form-urlencoded', cookie: `__Host-eden-apple=${attempt}` },
  });
  return { start, attempt, response, session: cookieValue(response, '__Host-eden') };
}

test('Google: the return address rides in the state cookie and the sign-in ends there', async () => {
  for (const back of ['/#tasks', '/#account', CONNECT]) {
    const { attempt, response, session } = await googleFlow({ back });
    const parts = attempt.split('.');
    assert.equal(parts.length, 5);
    assert.equal(parts[3], 's');
    assert.equal(parts[4], b64urlText(back));
    assert.ok(session, 'signed in');
    assert.equal(await landing(response), back);
    const refresh = /content="0; url=([^"]*)"/.exec(await response.clone().text())[1];
    assert.doesNotMatch(refresh, /[<>'"]/, 'escaped for the attribute');
  }
  // No return address: home, and the cookie is as it always was (four fields).
  const plain = await googleFlow();
  assert.equal(plain.attempt.split('.').length, 4);
  assert.equal(await landing(plain.response), '/');
});

test('Apple: the same, through its form_post (a SameSite=None cookie)', async () => {
  const { attempt, response, session } = await appleFlow({ back: CONNECT });
  assert.equal(attempt.split('.')[3], b64urlText(CONNECT));
  assert.ok(session);
  assert.equal(await landing(response), CONNECT);
  const home = await appleFlow({ sub: 'apple-user-2' });
  assert.equal(await landing(home.response), '/');
});

test('a hostile return address is never stored, and the sign-in ends at home', async () => {
  for (const back of HOSTILE) {
    const g = await googleFlow({ back });
    assert.equal(g.attempt.split('.').length, 4, JSON.stringify(back));
    assert.equal(await landing(g.response), '/', JSON.stringify(back));
    const a = await appleFlow({ back });
    assert.equal(a.attempt.split('.').length, 3, JSON.stringify(back));
    assert.equal(await landing(a.response), '/', JSON.stringify(back));
  }
});

test('the callback’s own query or form can’t choose where it ends', async () => {
  const g = await googleFlow({ callbackExtra: `&return=${encodeURIComponent('https://evil.example/')}&redirect_uri=https%3A%2F%2Fevil.example` });
  assert.equal(await landing(g.response), '/');
  const g2 = await googleFlow({ back: '/#tasks', callbackExtra: `&return=${encodeURIComponent('//evil.example')}` });
  assert.equal(await landing(g2.response), '/#tasks');
  const a = await appleFlow({ back: '/#account', formExtra: { return: '//evil.example', redirect_uri: 'https://evil.example/' } });
  assert.equal(await landing(a.response), '/#account');
});

test('a state cookie carrying a hostile address (forged, or from an older rule) still ends at home', async () => {
  for (const evil of ['//evil.example', 'https://evil.example/', '/\\evil.example', '/api/web/handoff?code=x', 'not base64 !', '%%%']) {
    const forged = (attempt) => {
      const parts = attempt.split('.');
      parts[4] = /^[A-Za-z0-9_-]+$/.test(evil) ? evil : b64urlText(evil);
      return parts.join('.');
    };
    const { response } = await googleFlow({ back: '/#tasks', cookie: forged });
    assert.equal(await landing(response), '/', evil);
  }
});

test('a sign-in that fails goes back to /signin with the same return address, so trying again still comes back', async () => {
  // Google says no.
  const start = await hit(`/api/web/google${q('/#tasks')}`);
  const to = new URL(start.headers.get('location'));
  const denied = await hit(`/api/web/google/callback?state=${to.searchParams.get('state')}&error=access_denied`, { headers: { cookie: `__Host-eden-google=${cookieValue(start, '__Host-eden-google')}` } });
  assert.equal(denied.status, 303);
  assert.equal(denied.headers.get('location'), `/signin?error=access_denied&provider=google&return=${encodeURIComponent('/#tasks')}`);
  // Not set up: refused at the start, with the (checked) return address.
  env.WEB_APPLE_SERVICES_ID = '';
  const off = await hit(`/api/web/apple${q(CONNECT)}`);
  assert.equal(off.status, 303);
  const loc = new URL(off.headers.get('location'), ORIGIN);
  assert.equal(loc.pathname, '/signin');
  assert.equal(loc.searchParams.get('error'), 'not_set_up');
  assert.equal(loc.searchParams.get('return'), CONNECT);
  // A hostile one isn't passed on.
  const evil = await hit(`/api/web/apple${q('//evil.example')}`);
  assert.equal(evil.headers.get('location'), '/signin?error=not_set_up&provider=apple');
});

test('link mode (adding a sign-in method) always ends on the account page', async () => {
  const { session } = await googleFlow();
  const start = await hit(`/api/web/apple?link=1&return=${encodeURIComponent('/#tasks')}`, { session });
  assert.equal(start.status, 302);
  const attempt = cookieValue(start, '__Host-eden-apple');
  assert.equal(attempt.split('.')[2], 'l');
  assert.equal(attempt.split('.').length, 3, 'not kept');
  const [state, nonce] = attempt.split('.');
  const back = await hit('/api/web/apple/callback', {
    method: 'POST',
    body: new URLSearchParams({ state, id_token: await identityToken({ sub: 'apple-linked', nonce, aud: SERVICES_ID }) }).toString(),
    headers: { origin: 'https://appleid.apple.com', 'content-type': 'application/x-www-form-urlencoded', cookie: `__Host-eden-apple=${attempt}` },
  });
  assert.equal(await landing(back), '/#account');
});

test('/signin when already signed in goes to the return address (if safe); signed out it shows the page', async () => {
  const { session } = await googleFlow();
  const go = async (back) => (await hit(`/signin${q(back)}`, { session })).headers.get('location');
  assert.equal(await go(), '/');
  assert.equal(await go('/#tasks'), '/#tasks');
  assert.equal(await go(CONNECT), CONNECT);
  for (const back of HOSTILE) assert.equal(await go(back), '/', JSON.stringify(back));
  const page = await hit(`/signin${q('/#tasks')}`);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), 'asset /signin/');
  // The page's own copy of the rule is served beside it.
  const rule = await hit('/signin/return.js');
  assert.equal(rule.status, 200);
  assert.equal(await rule.text(), 'asset /signin/return.js');
});

test('the code the iPhone approves: the page itself goes back (signin.js uses the same rule)', async () => {
  const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('../public/signin/signin.js', import.meta.url), 'utf8'));
  assert.match(source, /import \{ safeReturn \} from '\.\/return\.js';/);
  assert.match(source, /location\.replace\(back\)/);
  assert.doesNotMatch(source, /location\.replace\('\/'\)/);
});
