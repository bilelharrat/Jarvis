// Signing in on Eden Travel's own address (askedentravel.com, TRAVEL_HOST) with the askeden.com sign-in: one account,
// signed in once, and no second passkey, Apple or Google set-up for the other name.
//
//   1. <travel>/api/web/site-handoff/start: a random state in this browser's cookie there (__Host-eden-hand, Lax, ten
//      minutes), and on to askeden.com/hand?s=<its SHA-256>.
//   2. askeden.com/hand: reached from another site, a page carries no Strict cookie, so it first moves on to itself
//      (then it's same-site). Signed out: /signin, and back here. Signed in: a one-time code (32 random bytes, a
//      minute, taken once, kept server-side with the account and the state's hash), sent on to …/finish?code=….
//   3. <travel>/api/web/site-handoff/finish: the code taken, its state's hash checked against this browser's cookie
//      (so another site can't sign this browser in to an account of its choosing: a login CSRF), a new browser device
//      for the account, its session cookie set on the travel address.
//
// The other address is only ever TRAVEL_HOST from the Worker's config, never a name from the request; local dev can
// name both origins (MAIN_ORIGIN, TRAVEL_ORIGIN) since both are localhost there.

import { call, callLink, clientIp, limited } from '../accounts/index.js';
import { WEB_SESSION_DAYS } from '../accounts/account.js';
import { ApiError, b64url, randomBytes, sha256Hex, webAllowed } from '../accounts/util.js';
import { SESSION_COOKIE, SIGNIN_CSP, clearCookie, cookie, cookies, page } from './web.js';
import { browserName, currentSession } from './session.js';

export const HAND_COOKIE = '__Host-eden-hand';
const THEN_COOKIE = '__Host-eden-then'; // where the sign-in goes on to: only a trip invite (/join/<code>)
const THEN = /^\/join\/[a-z0-9]{12}$/;
const HAND_SECONDS = 600;
const CODE_SECONDS = 60;
const CODE = /^[A-Za-z0-9_-]{43}$/;

const go = (location) => new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
export const travelHost = (env) => String(env.TRAVEL_HOST || '').toLowerCase();
export const onTravelHost = (request, env) => Boolean(travelHost(env)) && new URL(request.url).hostname === travelHost(env);
// https only, except a local dev origin (http://localhost, http://*.localhost)
const origin = (v, fallback) => { const o = String(v || fallback); return /^https:\/\/|^http:\/\/([a-z0-9-]+\.)?localhost(:\d+)?$/.test(o) ? o : fallback; };
const mainOrigin = (env) => origin(env.MAIN_ORIGIN, 'https://askeden.com');
const travelOrigin = (env) => origin(env.TRAVEL_ORIGIN, `https://${travelHost(env)}`);

export function note(title, text, link, label) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${link && !label ? `<meta http-equiv="refresh" content="0; url=${link}">` : ''}<title>Eden Travel</title><link rel="stylesheet" href="/signin/signin.css"></head>
<body><main class="card"><h1>${title}</h1>${text ? `<p>${text}</p>` : ''}${link ? `<p><a class="button" href="${link}">${label || 'Continue'}</a></p>` : ''}</main></body></html>`;
  return page(new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer' } }), SIGNIN_CSP);
}

/** 1. On the travel address: the state in this browser, then askeden.com. */
export async function handStart(request, env) {
  if (!onTravelHost(request, env)) throw new ApiError(404, 'not_found', 'No such thing here.');
  // only a load this site's own page or the app starts: another site looping a popup through here would make a new
  // browser sign-in each time and push the account's real browsers out (an account keeps 10)
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return note('Open Eden Travel', 'Sign in from Eden Travel itself.', '/', 'Go to Eden Travel');
  const state = b64url(randomBytes(32));
  const res = go(`${mainOrigin(env)}/hand?s=${await sha256Hex(state)}`);
  res.headers.append('set-cookie', cookie(HAND_COOKIE, state, { maxAge: HAND_SECONDS, sameSite: 'Lax' }));
  const then = new URL(request.url).searchParams.get('then') || '';
  if (THEN.test(then)) res.headers.append('set-cookie', cookie(THEN_COOKIE, then.slice(6), { maxAge: HAND_SECONDS, sameSite: 'Lax' }));
  return res;
}

/** 2. On askeden.com: the signed-in account's one-time code, sent to the travel address. */
export async function handPage(request, env) {
  const host = travelHost(env);
  const url = new URL(request.url);
  const s = url.searchParams.get('s') || '';
  if (!host || onTravelHost(request, env) || !/^[0-9a-f]{64}$/.test(s)) return go('/');
  const self = `/hand?s=${s}&on=1`;
  // from another site: no Strict cookie on this load; the same page again, from here, has it
  if ((request.headers.get('sec-fetch-site') || '') === 'cross-site' && url.searchParams.get('on') !== '1') return note('Opening Eden Travel…', '', self);
  const { session } = await currentSession(request, env);
  if (!session) return go(`/signin?return=${encodeURIComponent(self)}`);
  if (!webAllowed(env, session.account)) return go('/');
  await limited(env, 'AUTH_RATE', `hand:${session.account}`);
  const code = b64url(randomBytes(32));
  await callLink(env, `handoff:site:${code}`, 'stash', { value: { account_id: session.account, s, host }, seconds: CODE_SECONDS });
  return go(`${travelOrigin(env)}/api/web/site-handoff/finish?code=${code}`);
}

const nextOf = (request) => { const c = String(cookies(request)[THEN_COOKIE] || ''); return /^[a-z0-9]{12}$/.test(c) ? `/join/${c}` : '/'; };

/** 3. Back on the travel address: the code for this browser's own state, and its session. */
export async function handFinish(request, env) {
  if (!onTravelHost(request, env)) throw new ApiError(404, 'not_found', 'No such thing here.');
  const code = new URL(request.url).searchParams.get('code') || '';
  const state = cookies(request)[HAND_COOKIE] || '';
  const again = '/api/web/site-handoff/start';
  try {
    await limited(env, 'AUTH_RATE', `handoff:${clientIp(request)}`);
    if (!CODE.test(code) || !CODE.test(state)) throw new ApiError(400, 'state', 'That sign-in was started in another browser, or ran out.');
    let kept;
    try { kept = (await callLink(env, `handoff:site:${code}`, 'take')).body.value; } catch (e) { if (!(e instanceof ApiError)) throw e; throw new ApiError(400, 'expired', 'That sign-in ran out or was already used.'); }
    if (kept.host !== travelHost(env) || kept.s !== (await sha256Hex(state))) throw new ApiError(400, 'state', 'That sign-in was started in another browser.');
    if (!webAllowed(env, kept.account_id)) throw new ApiError(403, 'not_allowed', "Eden on the web isn't open to this account yet.");
    // this browser already signed in here to the same account: no second browser device
    const here = await currentSession(request, env).catch(() => ({ session: null }));
    if (here.session && here.session.account === kept.account_id) {
      const same = note('Opening Eden Travel…', '', nextOf(request));
      same.headers.append('set-cookie', clearCookie(HAND_COOKIE, 'Lax'));
      return same;
    }
    const made = await call(env, kept.account_id, 'web-signin', { account_id: kept.account_id, device: { name: browserName(request), app_version: `${travelHost(env)} (askeden.com sign-in)` } });
    // a page that moves on, not a redirect: this load came from another site, and a browser holds a Strict cookie back
    // from the rest of a chain that started there (the next load, started here, has it)
    const res = note('Opening Eden Travel…', '', nextOf(request));
    res.headers.append('set-cookie', clearCookie(THEN_COOKIE, 'Lax'));
    res.headers.append('set-cookie', cookie(SESSION_COOKIE, made.token, { maxAge: WEB_SESSION_DAYS * 86400 }));
    res.headers.append('set-cookie', clearCookie(HAND_COOKIE, 'Lax'));
    return res;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const res = note('Eden Travel couldn’t sign you in', `${error.message} Try again.`, again, 'Sign in again');
    res.headers.append('set-cookie', clearCookie(HAND_COOKIE, 'Lax'));
    return res;
  }
}
