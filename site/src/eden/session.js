// Signing a browser in to Eden at askeden.com (/api/web/*). Nothing new to set up at Apple:
//
//   1. The sign-in page asks for a code (POST /api/web/link): a link of kind `web`, the same
//      kind of link a Mac makes (accounts/link.js), without a key pair. The page shows the
//      code and its QR code (jarvis-link://XXXX-XXXX); the code's poll secret goes into an
//      HttpOnly cookie, never to the page's script.
//   2. The owner approves it where they're already signed in: the J.A.R.V.I.S. iPhone app's
//      Settings › Account › "Link a Mac" (type or scan the code; it shows "Link “Eden on the
//      web: Safari on a Mac”?"), unchanged; or a linked Mac (the accounts API lets a Mac
//      approve a browser, never another Mac). The account gets a `web` device: restricted
//      (account.js WEB_FORBIDDEN), ending after 30 days, listed in the app like any device.
//   3. The page polls (POST /api/web/link/poll); once approved, the device's token becomes the
//      session cookie: HttpOnly, Secure, SameSite=Strict, __Host-. The page never sees it.
//
// Sign in with Apple on the web is here too, off until the owner makes a Services ID for
// askeden.com and sets WEB_APPLE_SERVICES_ID (below, "Sign in with Apple on the web").

import { verifyIdentityToken } from '../accounts/apple.js';
import { call, callLink, limited } from '../accounts/index.js';
import { WEB_SESSION_DAYS } from '../accounts/account.js';
import { cleanCode, newCode } from '../accounts/link.js';
import { ApiError, accountIdFor, b64url, cleanName, parseToken, randomBytes, sameText, sha256Hex, webAllowed } from '../accounts/util.js';
import { qrRows } from './qr.js';
import {
  APPLE_COOKIE,
  LINK_COOKIE,
  SESSION_COOKIE,
  SIGNIN_CSP,
  clearCookie,
  cookie,
  cookies,
  json,
  page,
  problem,
} from './web.js';

const SESSION_SECONDS = WEB_SESSION_DAYS * 86400;
const LINK_SECONDS = 600;
const APPLE = 'https://appleid.apple.com';
export const APPLE_CALLBACK = '/api/web/apple/callback';

// ── who's signed in ──

// Sessions this copy of the Worker has checked lately (token → { until, who }): a page load
// asks for ~20 files, and each needn't wake the account. The API's own calls always check.
const recent = new Map();
const RECENT_MS = 30_000;

export function forgetSessions() {
  recent.clear();
}

/** The session cookie's token, parsed; null if absent or malformed. */
export function sessionToken(request) {
  const raw = cookies(request)[SESSION_COOKIE];
  return raw ? parseToken(raw) : null;
}

/**
 * The signed-in browser: { token, account, device: <its public device> }, or null. `stale`
 * is true when a cookie was there but no longer works (signed out from the app, ran out).
 */
export async function currentSession(request, env, { fresh = false } = {}) {
  const token = sessionToken(request);
  if (!token || !env.ACCOUNTS) return { session: null, stale: Boolean(cookies(request)[SESSION_COOKIE]) };
  const key = `${token.account}.${token.device}.${token.secret}`;
  const hit = recent.get(key);
  if (!fresh && hit && hit.until > Date.now()) return { session: { token, ...hit.who }, stale: false };
  try {
    const { account_id: account, device } = await call(env, token.account, 'whoami', {}, token);
    if (device.kind !== 'web' || !webAllowed(env, account)) return { session: null, stale: true };
    const who = { account, device };
    recent.set(key, { until: Date.now() + RECENT_MS, who });
    if (recent.size > 1000) recent.delete(recent.keys().next().value);
    return { session: { token, ...who }, stale: false };
  } catch (error) {
    recent.delete(key);
    if (error instanceof ApiError && error.status === 401) return { session: null, stale: true };
    throw error;
  }
}

// ── /api/web/* ──

export async function web(request, env, ctx, path) {
  const method = request.method;
  try {
    if (!env.ACCOUNTS || !env.LINKS) throw new ApiError(503, 'not_set_up', 'Jarvis accounts are not set up here yet.');
    if (path === '/api/web/config' && method === 'GET') return json({ apple: appleReady(env) });
    if (path === '/api/web/link' && method === 'POST') return await linkStart(request, env);
    if (path === '/api/web/link/poll' && method === 'POST') return await linkPoll(request, env);
    if (path === '/api/web/session' && method === 'GET') return await session(request, env);
    if (path === '/api/web/signout' && method === 'POST') return await signOut(request, env);
    if (path === '/api/web/apple' && method === 'GET') return await appleStart(request, env);
    if (path === APPLE_CALLBACK && method === 'POST') return await appleCallback(request, env);
    throw new ApiError(404, 'not_found', 'No such thing here.');
  } catch (error) {
    if (error instanceof ApiError) return error.response();
    console.error('web sign-in failed', path, error && error.stack);
    return problem(500, 'Something went wrong on the server. Try again.', 'server');
  }
}

/** "Eden on the web: Safari on a Mac, near Lyon": what the app shows when asked to approve. */
export function browserName(request) {
  const ua = String(request.headers.get('user-agent') || '');
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'a browser';
  const os = /iPhone/.test(ua) ? 'an iPhone' : /iPad/.test(ua) ? 'an iPad' : /Mac OS X|Macintosh/.test(ua) ? 'a Mac' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const city = request.cf && typeof request.cf.city === 'string' ? request.cf.city.replace(/[^\p{L}\p{N} .'-]/gu, '').slice(0, 30) : '';
  return cleanName(`Eden on the web: ${browser}${os ? ` on ${os}` : ''}${city ? `, near ${city}` : ''}`, 'Eden on the web');
}

const withCookies = (response, ...values) => {
  for (const value of values) response.headers.append('set-cookie', value);
  return response;
};

async function linkStart(request, env) {
  await limited(env, 'LINK_RATE', `web:${request.headers.get('cf-connecting-ip') || 'unknown'}`);
  const poll = b64url(randomBytes(32));
  for (let tries = 0; tries < 5; tries++) {
    const code = newCode();
    try {
      await callLink(env, code, 'start', { name: browserName(request), kind: 'web', public_key: null, app_version: 'askeden.com', poll });
      const answer = json({ code, url: `jarvis-link://${code}`, qr: qrRows(`jarvis-link://${code}`), expires_in: LINK_SECONDS });
      return withCookies(answer, cookie(LINK_COOKIE, `${code.replace('-', '')}.${poll}`, { maxAge: LINK_SECONDS }));
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 409)) throw error;
    }
  }
  throw new ApiError(503, 'busy', 'Try again in a moment.');
}

function pendingLink(request) {
  const [raw = '', poll = ''] = String(cookies(request)[LINK_COOKIE] || '').split('.');
  const code = cleanCode(raw);
  return code && poll ? { code, poll } : null;
}

async function linkPoll(request, env) {
  const link = pendingLink(request);
  if (!link) throw new ApiError(404, 'no_link', 'That sign-in code is gone. Get a new one.');
  await limited(env, 'LINK_RATE', `poll:${link.code}`);
  let answer;
  try {
    answer = await callLink(env, link.code, 'poll', { poll: link.poll });
  } catch (error) {
    if (error instanceof ApiError && error.status !== 429) return withCookies(error.response(), clearCookie(LINK_COOKIE));
    throw error;
  }
  if (answer.status === 202) return json({ status: 'waiting' }, 202);
  const made = answer.body;
  const token = parseToken(made.token);
  if (!token) throw new ApiError(500, 'server', 'The sign-in came back unreadable. Try again.');
  if (!webAllowed(env, token.account)) {
    await call(env, token.account, 'device-delete', { id: 'me' }, token).catch(() => {});
    return withCookies(problem(403, "Eden on the web isn't open to this account yet.", 'not_allowed'), clearCookie(LINK_COOKIE));
  }
  return withCookies(json({ status: 'signed_in' }), cookie(SESSION_COOKIE, made.token, { maxAge: SESSION_SECONDS }), clearCookie(LINK_COOKIE));
}

async function session(request, env) {
  const { session: who, stale } = await currentSession(request, env, { fresh: true });
  if (!who) {
    const answer = problem(401, 'This browser is signed out of Eden.', 'signed_out');
    return stale ? withCookies(answer, clearCookie(SESSION_COOKIE)) : answer;
  }
  const account = await call(env, who.account, 'get', {}, who.token);
  return json({
    signed_in: true,
    account_id: who.account,
    device: { id: who.device.id, name: who.device.name, expires: who.device.expires || null },
    plan: account.plan,
    usage: account.usage,
  });
}

async function signOut(request, env) {
  const token = sessionToken(request);
  if (token) {
    forgetSessions();
    await call(env, token.account, 'device-delete', { id: 'me' }, token).catch(() => {});
  }
  return withCookies(new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } }), clearCookie(SESSION_COOKIE));
}

// ── Sign in with Apple on the web (when set up) ──
//
// The owner, at developer.apple.com: a Services ID (say com.bshventures.eden.web) grouped with
// the app's primary App ID com.bshventures.jarvis.companion (so an Apple ID maps to the same
// account), Sign in with Apple on, domains askeden.com and www.askeden.com, and return URLs
// https://askeden.com/api/web/apple/callback and https://www.askeden.com/api/web/apple/callback.
// Then the Worker var WEB_APPLE_SERVICES_ID = that Services ID. It signs in only to accounts
// the iPhone app made; no key is needed (the identity token comes straight back).

export const appleReady = (env) => /^[A-Za-z0-9.-]{3,}$/.test(String(env.WEB_APPLE_SERVICES_ID || ''));

async function appleStart(request, env) {
  if (!appleReady(env)) throw new ApiError(404, 'not_set_up', 'Sign in with Apple is not set up for the web yet.');
  await limited(env, 'LINK_RATE', `apple:${request.headers.get('cf-connecting-ip') || 'unknown'}`);
  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(24));
  const origin = new URL(request.url).origin;
  const to = new URL(`${APPLE}/auth/authorize`);
  to.search = new URLSearchParams({
    client_id: env.WEB_APPLE_SERVICES_ID,
    redirect_uri: `${origin}${APPLE_CALLBACK}`,
    response_type: 'code id_token',
    response_mode: 'form_post',
    state,
    nonce: await sha256Hex(nonce),
  }).toString();
  // Apple posts back from its own site: this one cookie has to come along (SameSite=None),
  // and it holds nothing but this attempt's state and nonce.
  return withCookies(
    new Response(null, { status: 302, headers: { location: to.toString(), 'cache-control': 'no-store' } }),
    cookie(APPLE_COOKIE, `${state}.${nonce}`, { maxAge: LINK_SECONDS, sameSite: 'None' }),
  );
}

function resultPage(title, words, { status = 200, ok = false } = {}) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${ok ? '<meta http-equiv="refresh" content="0; url=/">' : ''}<title>${esc(title)}</title><link rel="stylesheet" href="/signin/signin.css"></head>
<body><main class="card"><div class="orb" aria-hidden="true"></div><h1>${esc(title)}</h1><p class="lead">${esc(words)}</p><p><a class="button" href="/">${ok ? 'Continue to Eden' : 'Back to sign-in'}</a></p></main></body></html>`;
  return page(new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } }), SIGNIN_CSP);
}

async function appleCallback(request, env) {
  const clear = clearCookie(APPLE_COOKIE, 'None');
  if (!appleReady(env)) return withCookies(resultPage('Not set up', 'Sign in with Apple is not set up for the web yet.', { status: 404 }), clear);
  const [state = '', nonce = ''] = String(cookies(request)[APPLE_COOKIE] || '').split('.');
  let form;
  try {
    form = new URLSearchParams(await request.text());
  } catch {
    form = new URLSearchParams();
  }
  if (form.get('error')) return withCookies(resultPage('Not signed in', 'Sign in with Apple was cancelled.'), clear);
  if (!state || !nonce || !sameText(form.get('state') || '', state)) {
    return withCookies(resultPage('Try again', 'That sign-in had expired or came from somewhere else.', { status: 400 }), clear);
  }
  try {
    const claims = await verifyIdentityToken(form.get('id_token'), nonce, { audience: env.WEB_APPLE_SERVICES_ID, now: Date.now() / 1000 });
    const accountId = await accountIdFor(claims.sub);
    if (!webAllowed(env, accountId)) throw new ApiError(403, 'not_allowed', "Eden on the web isn't open to this account yet.");
    const made = await call(env, accountId, 'web-signin', { account_id: accountId, device: { name: browserName(request), app_version: 'askeden.com (Apple)' } });
    return withCookies(resultPage('Signed in', 'Opening Eden…', { ok: true }), cookie(SESSION_COOKIE, made.token, { maxAge: SESSION_SECONDS }), clear);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return withCookies(resultPage('Not signed in', error.message, { status: error.status }), clear);
  }
}
