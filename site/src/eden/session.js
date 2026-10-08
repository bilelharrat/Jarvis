// Signing a browser in to Eden at askeden.com (/api/web/*). The contract is docs/web-auth.md.
//
//   - A code the J.A.R.V.I.S. app approves (POST /api/web/link): a link of kind `web`, the same
//     kind of link a Mac makes (accounts/link.js), without a key pair. The page shows the code
//     and its QR code (jarvis-link://XXXX-XXXX); the code's poll secret goes into an HttpOnly
//     cookie, never to the page's script. Approved on the iPhone or a linked Mac; the page polls
//     (POST /api/web/link/poll) and the device's token becomes the session cookie.
//   - Sign in with Apple (a Services ID, WEB_APPLE_SERVICES_ID) and Sign in with Google
//     (GOOGLE_CLIENT_ID + the secret GOOGLE_CLIENT_SECRET; eden/google.js): the identity opens
//     its account (accounts/index.js accountForIdentity), a new one for a first-time sign-in.
//     `?link=1` from a signed-in browser adds the identity to that browser's account instead.
//   - A passkey (WebAuthn; accounts/webauthn.js): POST /api/web/passkey/options, then
//     /api/web/passkey/verify. Sign in with one, make an account with one (sign-up), or add one to
//     a signed-in browser's account (`add`). The RP ID is this request's host; each challenge is
//     kept server-side (`pk:<challenge>`, five minutes, taken once). The passkey is an identity
//     like Apple and Google (`passkey:<hash of its credential id>`), opening the same account.
//   - A new account made on the web (first Apple or Google sign-in, passkey sign-up) needs a passed
//     Turnstile check from /signin (accounts/turnstile.js), when TURNSTILE_SITE_KEY and _SECRET are set.
//   - The Eden iOS app: Sign in with Apple natively (POST /api/web/native/apple), then a
//     one-time handoff code its web view redeems (GET /api/web/handoff?code=…) for the cookie.
//
// Whatever way in, the browser is a `web` device: restricted (account.js WEB_FORBIDDEN), ending
// after 30 days, listed in the apps like any device. The session is the device's token in the
// cookie __Host-eden: HttpOnly, Secure, SameSite=Strict. No page ever sees it.

import { EDEN_APP_ID, verifyIdentityToken } from '../accounts/apple.js';
import { accountForIdentity, call, callIdentity, callLink, clientIp, eraseAccount, limited, linkIdentity, nativeNewAccount, subHashOf, unlinkIdentity } from '../accounts/index.js';
import { ALGS, verifyAssertion, verifyRegistration } from '../accounts/webauthn.js';
import { HUMAN_SECONDS, checkHuman, checkSignups, signupsOpen, turnstileOn, turnstileSiteKey } from '../accounts/turnstile.js';
import { WEB_LINK_MAC_MS, WEB_LINK_MAC_STALE, WEB_SESSION_DAYS } from '../accounts/account.js';
import { cleanCode, newCode } from '../accounts/link.js';
import { ApiError, b64ToBytes, b64url, b64urlText, cleanName, parseToken, randomBytes, readJson, sameText, sha256Hex, webAllowed } from '../accounts/util.js';
import { SIGN_IN_SCOPES, buildAuthUrl, exchangeCode, googleReady, pkcePair, verifyIdToken } from './google.js';
import { qrRows } from './qr.js';
import { edenSyncApi } from '../accounts/eden-sync.js';
import { chatSyncApi } from '../accounts/chat-sync.js';
import { actingSession, actingView, delegatesApi, endActing } from '../accounts/delegates.js';
import { spacesApi } from '../accounts/space.js';
import { billingApi, billingConfig, billingReturn, plusOffer } from './billing.js';
import { safeReturn } from '../../public/signin/return.js';
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
const STATE_SECONDS = 600; // a provider sign-in has ten minutes to come back
const HANDOFF_SECONDS = 60;
const APPLE = 'https://appleid.apple.com';
export const APPLE_CALLBACK = '/api/web/apple/callback';
export const GOOGLE_CALLBACK = '/api/web/google/callback';
// Google comes back with a top-level GET from its own site: SameSite=Lax is enough (and the
// least this cookie can be). Apple's form_post needs None (web.js APPLE_COOKIE).
export const GOOGLE_COOKIE = '__Host-eden-google';

// ── who's signed in ──

// Sessions this copy of the Worker has checked lately (token → { until, who }): a page load
// asks for ~20 files, and each needn't wake the account. The API's own calls always check.
const recent = new Map();
const RECENT_MS = 30_000;

/** Forgets this isolate's checked sessions: one account's (a sign-out), or all of them. */
export function forgetSessions(accountId = null) {
  if (!accountId) return recent.clear();
  for (const key of [...recent.keys()]) if (key.startsWith(`${accountId}.`)) recent.delete(key);
}

/** The session cookie's token, parsed; null if absent or malformed. */
export function sessionToken(request) {
  const raw = cookies(request)[SESSION_COOKIE];
  return raw ? parseToken(raw) : null;
}

/**
 * The signed-in browser: { token, account, device: <its public device> }, or null. `stale`
 * is true when a cookie was there but no longer works (signed out from the app, ran out).
 * `acting`: hosted Eden's chat asks for the delegate's or space member's session this browser
 * holds beside its own (accounts/delegates.js), when there is one and it's still this person's.
 */
export async function currentSession(request, env, { fresh = false, acting = false } = {}) {
  if (acting) {
    const own = await currentSession(request, env, { fresh });
    if (!own.session) return own;
    const as = await actingSession(request, env, own.session);
    if (as && as.ended) return { ...own, ended: true }; // hosted Eden refuses rather than spend this person's own allowance
    return as ? { session: as, stale: false } : own;
  }
  const token = sessionToken(request);
  if (!token || !env.ACCOUNTS) return { session: null, stale: Boolean(cookies(request)[SESSION_COOKIE]) };
  const key = `${token.account}.${token.device}.${token.secret}`;
  const hit = recent.get(key);
  if (!fresh && hit && hit.until > Date.now()) return { session: { token, ...hit.who }, stale: false };
  try {
    const { account_id: account, device } = await call(env, token.account, 'whoami', {}, token);
    if (device.kind !== 'web' || device.grant || !webAllowed(env, account)) return { session: null, stale: true };
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

const DEVICE_SIGNOUT = /^\/api\/web\/devices\/([0-9a-f]{16})\/signout$/;
const APP_REVOKE = /^\/api\/web\/apps\/([0-9a-f]{16})\/revoke$/;
const UNLINK = /^\/api\/web\/identities\/(apple|google|passkey)\/unlink$/;
const MAC_LINK = /^\/api\/web\/mac-link\/([^/]+)(?:\/(approve|deny))?$/;

export async function web(request, env, ctx, path) {
  const method = request.method;
  try {
    if (!env.ACCOUNTS || !env.LINKS) throw new ApiError(503, 'not_set_up', 'Jarvis accounts are not set up here yet.');
    if (path === '/api/web/config' && method === 'GET') return json({ apple: appleReady(env), google: googleReady(env), passkey: Boolean(env.IDENTITIES), turnstile: turnstileSiteKey(env), signups: signupsOpen(env) ? 'open' : 'closed', code: true, ...billingConfig(env) });
    if (path === '/api/web/passkey/options' && method === 'POST') return await passkeyOptions(request, env);
    if (path === '/api/web/passkey/verify' && method === 'POST') return await passkeyVerify(request, env);
    // The Eden iOS app's own passkey sheet (no web view): the same ceremony, ending in a handoff code.
    if (path === '/api/web/native/passkey/options' && method === 'POST') return await passkeyOptions(request, env, { native: true });
    if (path === '/api/web/native/passkey/verify' && method === 'POST') return await passkeyVerify(request, env, { native: true });
    if (path === '/api/web/link' && method === 'POST') return await linkStart(request, env);
    if (path === '/api/web/link/poll' && method === 'POST') return await linkPoll(request, env);
    if (path === '/api/web/session' && method === 'GET') return await session(request, env);
    if (path === '/api/web/account' && method === 'GET') return await accountView(request, env);
    if (path === '/api/web/account/delete' && method === 'POST') return await deleteWebAccount(request, env);
    if (path === '/api/web/signout' && method === 'POST') return await signOut(request, env);
    if (path === '/api/web/signout-everywhere' && method === 'POST') return await signOutBrowsers(request, env, { all: true });
    const device = DEVICE_SIGNOUT.exec(path);
    if (device && method === 'POST') return await signOutBrowsers(request, env, { id: device[1] });
    const unlink = UNLINK.exec(path);
    if (unlink && method === 'POST') return await unlinkMethod(request, env, unlink[1]);
    // Linking a Mac from this browser (askeden.com/link): see what's waiting, approve or deny it.
    const macLink = MAC_LINK.exec(path);
    if (macLink && (method === 'GET' ? !macLink[2] : method === 'POST' && macLink[2])) return await linkMac(request, env, macLink[1], macLink[2] || '');
    if (path === '/api/web/mac-link' && method === 'GET') return await linkMacReady(request, env);
    // Connected apps (Eden Messenger's @Eden, accounts/scoped.js): list them, revoke one.
    if (path === '/api/web/apps' && method === 'GET') return await connectedApps(request, env);
    const revoke = APP_REVOKE.exec(path);
    if (revoke && method === 'POST') return await revokeApp(request, env, revoke[1]);
    // GET: a plain link (the account page's "Add"); POST: /signin's buttons, with the Turnstile token.
    if (path === '/api/web/apple' && (method === 'GET' || method === 'POST')) return await appleStart(request, env);
    if (path === APPLE_CALLBACK && method === 'POST') return await appleCallback(request, env);
    if (path === '/api/web/google' && (method === 'GET' || method === 'POST')) return await googleStart(request, env);
    if (path === GOOGLE_CALLBACK && method === 'GET') return await googleCallback(request, env);
    if (path === '/api/web/native/apple' && method === 'POST') return await nativeApple(request, env);
    if (path === '/api/web/handoff' && method === 'GET') return await handoff(request, env);
    // Back from Stripe (another site, so no Strict cookie yet): a page that moves on (billing.js).
    if (path === '/api/web/billing/return' && method === 'GET') return billingReturn(request);
    // Eden sync (H1), delegates (H14), team spaces (G8): the browser's own session, never a delegate's.
    const extra = /^\/api\/web\/(esync|csync|deleg|space|billing)(?:\/([a-z-]+))?$/.exec(path); // billing: Plus with Stripe, F15 (billing.js)
    if (extra) return await accountExtras(request, env, extra[1], extra[2] || '');
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

const noContent = () => new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });

// ── a code the app approves ──

async function linkStart(request, env) {
  await limited(env, 'LINK_RATE', `web:${clientIp(request)}`);
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

// ── the signed-in browser's own account ──

/** The signed-in browser, checked with its account now; a 401 (and the cookie cleared) otherwise. */
async function signedIn(request, env) {
  const { session: who, stale } = await currentSession(request, env, { fresh: true });
  if (who) return who;
  const error = new ApiError(401, 'signed_out', 'This browser is signed out of Eden.');
  if (stale) error.headers = { 'set-cookie': clearCookie(SESSION_COOKIE) };
  throw error;
}

async function session(request, env) {
  const who = await signedIn(request, env);
  const account = await call(env, who.account, 'get', {}, who.token);
  // Acting for someone (a delegate, a space): what's left is that grant's, not this account's.
  const found = await actingSession(request, env, who);
  const as = found && !found.ended ? found : null;
  const grant = as ? await call(env, as.account, 'get', {}, as.token).catch(() => null) : null;
  return json({
    signed_in: true,
    account_id: who.account,
    device: { id: who.device.id, name: who.device.name, expires: who.device.expires || null },
    plan: grant ? grant.plan : account.plan,
    usage: grant ? grant.usage : account.usage,
    identities: account.identities || [],
    acting: as && grant ? actingView(as) : null,
    acting_ended: Boolean(found && found.ended),
  });
}

async function accountView(request, env) {
  const who = await signedIn(request, env);
  const account = await call(env, who.account, 'get', {}, who.token);
  const as = await actingSession(request, env, who);
  return json({
    account_id: who.account,
    acting: as && !as.ended ? actingView(as) : null,
    acting_ended: Boolean(as && as.ended),
    plan: account.plan,
    usage: account.usage,
    credits: account.credits || null, // pay-as-you-go (accounts/credits.js)
    devices: account.devices.map((d) => ({
      id: d.id,
      name: d.name,
      kind: d.kind,
      created: d.created,
      last_seen: d.last_seen,
      ...(d.expires ? { expires: d.expires } : {}),
      this: d.this,
    })),
    identities: account.identities || [],
    plus: plusOffer(env), // the iPhone app's App Store, and on the web with Stripe once it's set up (billing.js)
  });
}

// Delete account, from the account page: the person types DELETE, within 10 minutes of signing in. Everything goes (eraseAccount:
// every device signed out, the account's data, its sign-ins and passkeys, published pages, a web
// Plus subscription cancelled at Stripe), and this browser's cookie with it.
const DELETE_STALE = 'To delete your account, sign in again first: Eden deletes an account only within 10 minutes of signing in.';

async function deleteWebAccount(request, env) {
  ownPage(request);
  const who = await signedIn(request, env);
  const body = await readJson(request, 4096);
  if (body.confirm !== 'DELETE') throw new ApiError(400, 'confirm', 'Type DELETE to delete your Eden account.');
  // A fresh sign-in only (as for linking a Mac): an old or stolen session can't delete the account.
  if (Date.now() - (who.device.created || 0) > WEB_LINK_MAC_MS) throw new ApiError(403, 'sign_in_again', DELETE_STALE);
  await limited(env, 'AUTH_RATE', `delete:${who.account}`);
  await eraseAccount(env, who.account, who.token, { confirm: body.confirm });
  forgetSessions(who.account);
  return withCookies(noContent(), clearCookie(SESSION_COOKIE));
}

async function signOut(request, env) {
  const token = sessionToken(request);
  if (token) {
    forgetSessions(token.account);
    await call(env, token.account, 'device-delete', { id: 'me' }, token).catch(() => {});
  }
  return withCookies(noContent(), clearCookie(SESSION_COOKIE), await endActing(request, env)); // and any delegate's session it held
}

// /api/web/esync, /api/web/deleg, /api/web/space (accounts/eden-sync.js, delegates.js,
// space.js): a fresh check of this browser's own session; the acting one only to report it.
async function accountExtras(request, env, area, op) {
  const who = await signedIn(request, env);
  const origin = new URL(request.url).origin;
  if (area === 'esync') return edenSyncApi(request, env, who, op);
  if (area === 'csync') return chatSyncApi(request, env, who, op);
  const found = await actingSession(request, env, who);
  const acting = found && !found.ended ? found : null;
  if (area === 'deleg') return delegatesApi(request, env, who, op, { acting, origin });
  if (area === 'billing') return billingApi(request, env, who, op, { acting, origin });
  return spacesApi(request, env, who, op, { acting, origin });
}

// One browser of this account (`id`), or every one (`all`), this one included. This isolate
// forgets them at once; others within RECENT_MS (their pages' next API call checks anyway).
async function signOutBrowsers(request, env, which) {
  const who = await signedIn(request, env);
  const { me } = await call(env, who.account, 'browsers-signout', which, who.token);
  forgetSessions(who.account);
  return me ? withCookies(noContent(), clearCookie(SESSION_COOKIE)) : noContent();
}

// Connected apps: the scoped tokens other Eden apps hold (accounts/scoped.js), as the account
// page lists them ({ id, client, name, scope, created, expires, last_used }). This browser's own
// session, never a delegate's; revoking stops the app's token at once (it must connect again).
async function connectedApps(request, env) {
  const who = await signedIn(request, env);
  const { connections } = await call(env, who.account, 'scoped-list', {}, who.token);
  return json({ connections });
}

async function revokeApp(request, env, id) {
  const who = await signedIn(request, env);
  const { revoked } = await call(env, who.account, 'scoped-revoke', { id }, who.token);
  if (!revoked) throw new ApiError(404, 'not_found', 'That app isn’t connected any more.');
  return json({ revoked: true });
}

// ── linking a Mac from the browser (askeden.com/link; docs/web-auth.md) ──
//
// The Mac shows a code (POST /api/link/start, as for the iPhone); the owner's browser, signed in
// within WEB_LINK_MAC_MS, sees the Mac's name and approves. Its own session only (never a
// delegate's: signedIn is the browser's own account), a code of kind `mac` only, and the account's
// object checks the session's age again (account.js addLinkedDevice). The Mac gets a token and no
// sync key: a browser has none to seal.

/** GET /api/web/mac-link: whether this browser may approve a Mac now, and for how much longer. */
async function linkMacReady(request, env) {
  const who = await signedIn(request, env);
  const left = WEB_LINK_MAC_MS - (Date.now() - (who.device.created || 0));
  return json({ fresh: left > 0, seconds: Math.max(0, Math.floor(left / 1000)) });
}

async function linkMac(request, env, rawCode, action) {
  const who = await signedIn(request, env);
  await limited(env, 'LINK_RATE', `look:${who.account}`);
  const code = cleanCode(decodeURIComponent(rawCode));
  if (!code) throw new ApiError(404, 'not_found', 'That isn’t a code from J.A.R.V.I.S. on your Mac. It has eight letters and numbers, like K7QM-4ZTR.');
  const link = (await callLink(env, code, 'peek')).body;
  if (link.kind !== 'mac') throw new ApiError(403, 'not_a_mac', 'That code is for a browser’s sign-in, not a Mac. Approve it in the J.A.R.V.I.S. app.');
  if (action === 'deny') {
    await callLink(env, code, 'deny');
    return noContent();
  }
  const left = WEB_LINK_MAC_MS - (Date.now() - (who.device.created || 0));
  if (!action) return json({ code, name: link.name, kind: 'mac', expires_in: link.expires_in, fresh: left > 0 });
  if (left <= 0) throw new ApiError(403, 'sign_in_again', WEB_LINK_MAC_STALE);
  const made = await call(env, who.account, 'add-device', { name: link.name, kind: 'mac', app_version: link.app_version }, who.token);
  try {
    await callLink(env, code, 'approve', { result: { token: made.token, account_id: made.account_id, device_id: made.device_id, sealed_key: null, sender_key: null } });
  } catch (error) {
    // The code ran out (or was used) in between: the device made for it goes again (as itself:
    // a browser removes no other device).
    await call(env, who.account, 'device-delete', { id: 'me' }, parseToken(made.token)).catch(() => {});
    throw error;
  }
  return json({ device_id: made.device_id, name: made.name });
}

async function unlinkMethod(request, env, provider) {
  const who = await signedIn(request, env);
  await unlinkIdentity(env, who.token, provider);
  const account = await call(env, who.account, 'get', {}, who.token);
  return json({ identities: account.identities || [] });
}

// ── Sign in with Apple and with Google ──

export const appleReady = (env) => /^[A-Za-z0-9.-]{3,}$/.test(String(env.WEB_APPLE_SERVICES_ID || ''));
const PROVIDERS = new Set(['apple', 'google']);

// Where a sign-in ends (docs/web-auth.md "Where a sign-in ends"). This site's own fixed paths,
// or the place it was started from (`?return=` on /signin and on the provider's start, checked
// by public/signin/return.js and kept in the attempt's own cookie: never an address taken from
// the provider's callback). Failures carry one of these codes:
export const ERROR_CODES = new Set(['cancelled', 'access_denied', 'expired', 'state', 'taken', 'identity_taken', 'not_allowed', 'not_set_up', 'rate_limited', 'email', 'signed_out', 'verify', 'signups_closed', 'server']);

/** The checked return address a provider's start was given (`?return=`), "/" by default. */
const returnOf = (request) => safeReturn(new URL(request.url).searchParams.get('return'));

// The return address rides in the attempt's cookie as a last field, base64url (the fields are
// split on "."); none for "/", so the cookie is as it always was.
const withReturn = (value, back) => (back && back !== '/' ? `${value}.${b64urlText(back)}` : value);
function unpackReturn(packed) {
  if (!packed || !/^[A-Za-z0-9_-]{1,1400}$/.test(packed)) return '/';
  try {
    return safeReturn(new TextDecoder('utf-8', { fatal: true }).decode(b64ToBytes(packed)));
  } catch {
    return '/';
  }
}

/** An ApiError from any step of a provider sign-in, as one of ERROR_CODES. */
export function errorCode(error) {
  if (!(error instanceof ApiError)) return 'server';
  if (error.status === 429) return 'rate_limited';
  const byCode = { identity_taken: 'identity_taken', already_linked: 'taken', not_allowed: 'not_allowed', not_set_up: 'not_set_up', signed_out: 'signed_out', expired: 'expired', not_found: 'expired', google_email: 'email', apple_refused: 'state', google_refused: 'state', turnstile: 'verify', signups_closed: 'signups_closed' };
  return byCode[error.code] || 'server';
}

function target({ link = false, error = '', provider = '', back = '/' } = {}) {
  const query = new URLSearchParams();
  if (error) query.set('error', ERROR_CODES.has(error) ? error : 'server');
  if (error && PROVIDERS.has(provider)) query.set('provider', provider);
  const to = safeReturn(back);
  if (error && !link && to !== '/') query.set('return', to); // trying again still comes back there
  const q = query.toString();
  if (link) return `/#account${q ? `?${q}` : ''}`;
  return error ? `/signin?${q}` : to;
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// The provider's callback is a navigation from Apple's or Google's site: a redirect from it
// would load the next page without the SameSite=Strict session cookie. So a sign-in that
// worked, and anything ending in link mode (Eden's own #account), ends on this small page of
// ours that moves on at once (a meta refresh: started by this site, so the cookie comes along).
function onward(to) {
  const href = escapeHtml(to);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0; url=${href}"><title>Eden</title><link rel="stylesheet" href="/signin/signin.css"></head>
<body><main class="card"><h1>Opening Eden…</h1><p><a class="button" href="${href}">Continue to Eden</a></p></main></body></html>`;
  return page(new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }), SIGNIN_CSP);
}

const seeOther = (location) => new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });

/** The end of a provider sign-in or link: `/` (or its return address), `/signin?error=…`, or `/#account[?error=…]`. */
function ending({ link = false, error = '', provider = '', back = '/' } = {}) {
  const to = target({ link, error, provider, back });
  return error && !link ? seeOther(to) : onward(to);
}

const failed = (error, mode) => {
  if (!(error instanceof ApiError)) console.error('web sign-in failed', error && error.stack);
  return ending({ ...mode, error: errorCode(error) });
};

/**
 * The start of a provider sign-in: this attempt's state, nonce (and for Google the PKCE
 * verifier) in a cookie of its own. Link mode (`?link=1`) needs a signed-in browser here, and
 * remembers which browser server-side (`oauth:<state>`, ten minutes, once): the callback comes
 * from the provider's site, so the SameSite=Strict session cookie isn't sent with it.
 */
async function providerAttempt(request, env, form = null) {
  await limited(env, 'AUTH_RATE', `start:${clientIp(request)}`);
  const link = new URL(request.url).searchParams.get('link') === '1';
  // /signin's buttons post the Turnstile token: checked now, and remembered for this attempt
  // (`human:<state>`) so its callback may make a new account (accounts/turnstile.js).
  const human = Boolean(form) && !link && turnstileOn(env) && (await checkHuman(env, form.get('cf-turnstile-response'), clientIp(request), { host: new URL(request.url).hostname }));
  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(24));
  if (link) {
    const { session: who } = await currentSession(request, env, { fresh: true });
    if (!who) throw new ApiError(401, 'signed_out', 'Sign in to Eden in this browser first, then add another way in.');
    await callLink(env, `oauth:${state}`, 'stash', { value: { account: who.account, device: who.device.id }, seconds: STATE_SECONDS });
  }
  if (human) await callLink(env, `human:${state}`, 'stash', { value: { ok: true }, seconds: HUMAN_SECONDS });
  return { state, nonce, link, back: link ? '/' : form ? safeReturn(form.get('return')) : returnOf(request) };
}

/** Before a provider sign-in makes a new account: this attempt passed Turnstile at its start (when it's on). */
async function humanFor(env, state) {
  if (!turnstileOn(env)) return checkHuman(env, '', null); // off: passes (and says so once)
  try {
    await callLink(env, `human:${state}`, 'take');
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    throw new ApiError(403, 'turnstile', 'Finish the check on the sign-in page, then continue.');
  }
  return true;
}

/** A /signin form post's fields (the Turnstile token, where to go back to); null for a GET. */
async function startForm(request) {
  if (request.method !== 'POST') return null;
  try {
    return new URLSearchParams((await request.text()).slice(0, 8192));
  } catch {
    return new URLSearchParams();
  }
}

/** A provider's verified sign-in, finished: the session cookie (and on to `back`), or (link mode) the identity added. */
async function finish(request, env, { provider, sub, email, state, link, back = '/' }) {
  if (link) {
    let pending;
    try {
      pending = (await callLink(env, `oauth:${state}`, 'take')).body.value;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      throw new ApiError(400, 'expired', 'That took too long. Open your account in Eden and try again.');
    }
    await linkIdentity(env, { provider, sub, email, account_id: pending.account, device_id: pending.device });
    return ending({ link: true });
  }
  const made = await signInBrowser(request, env, { provider, sub, email, beforeCreate: () => humanFor(env, state) });
  return withCookies(ending({ back }), cookie(SESSION_COOKIE, made.token, { maxAge: SESSION_SECONDS }));
}

const PROVIDER_NAME = { apple: 'Apple', google: 'Google', passkey: 'passkey' };

/** A browser device on the account this identity opens (made now if it's the first time). */
async function signInBrowser(request, env, { provider, sub, email, label = PROVIDER_NAME[provider], cred = null, beforeCreate = null }) {
  const { account_id } = await accountForIdentity(env, { provider, sub, email, ip: clientIp(request), cred, beforeCreate });
  if (!webAllowed(env, account_id)) throw new ApiError(403, 'not_allowed', "Eden on the web isn't open to this account yet.");
  return call(env, account_id, 'web-signin', {
    account_id,
    create: true,
    identity: { provider, sub_hash: await subHashOf(provider, sub), email },
    device: { name: browserName(request), app_version: `askeden.com (${label})` },
  });
}

const redirect = (location) => new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });
const linkMode = (request) => new URL(request.url).searchParams.get('link') === '1';

// Apple: a Services ID (docs/web-auth.md "Owner steps"), response_mode form_post. No scope is
// asked for, so no name or email ever comes back: Apple's sign-in keeps no email here.
async function appleStart(request, env) {
  const form = await startForm(request);
  const mode = { provider: 'apple', link: linkMode(request), back: form ? safeReturn(form.get('return')) : returnOf(request) };
  if (!appleReady(env)) return ending({ ...mode, error: 'not_set_up' });
  let attempt;
  try {
    attempt = await providerAttempt(request, env, form);
  } catch (error) {
    return failed(error, error.code === 'signed_out' ? { provider: 'apple' } : mode);
  }
  const { state, nonce, link, back } = attempt;
  const to = new URL(`${APPLE}/auth/authorize`);
  to.search = new URLSearchParams({
    client_id: env.WEB_APPLE_SERVICES_ID,
    redirect_uri: `${new URL(request.url).origin}${APPLE_CALLBACK}`,
    response_type: 'code id_token',
    response_mode: 'form_post',
    state,
    nonce: await sha256Hex(nonce),
  }).toString();
  // Apple posts back from its own site: this one cookie has to come along (SameSite=None),
  // and it holds nothing but this attempt's state, nonce, mode and where to go back to.
  return withCookies(redirect(to.toString()), cookie(APPLE_COOKIE, withReturn(`${state}.${nonce}.${link ? 'l' : 's'}`, back), { maxAge: STATE_SECONDS, sameSite: 'None' }));
}

async function appleCallback(request, env) {
  const clear = clearCookie(APPLE_COOKIE, 'None');
  const [state = '', nonce = '', flag = 's', packed = ''] = String(cookies(request)[APPLE_COOKIE] || '').split('.');
  const mode = { provider: 'apple', link: flag === 'l', back: flag === 'l' ? '/' : unpackReturn(packed) };
  if (!appleReady(env)) return withCookies(ending({ ...mode, error: 'not_set_up' }), clear);
  let form;
  try {
    form = new URLSearchParams(await request.text());
  } catch {
    form = new URLSearchParams();
  }
  if (form.get('error')) return withCookies(ending({ ...mode, error: 'cancelled' }), clear); // user_cancelled_authorize
  if (!state || !nonce || !sameText(form.get('state') || '', state)) return withCookies(ending({ ...mode, error: 'state' }), clear);
  try {
    await limited(env, 'AUTH_RATE', `cb:${clientIp(request)}`);
    const claims = await verifyIdentityToken(form.get('id_token'), nonce, { audience: env.WEB_APPLE_SERVICES_ID, now: Date.now() / 1000 });
    return withCookies(await finish(request, env, { provider: 'apple', sub: claims.sub, email: null, state, link: mode.link, back: mode.back }), clear);
  } catch (error) {
    return withCookies(failed(error, mode), clear);
  }
}

// Google: authorization code + PKCE (S256), state and nonce; `openid email profile` only.
async function googleStart(request, env) {
  const form = await startForm(request);
  const mode = { provider: 'google', link: linkMode(request), back: form ? safeReturn(form.get('return')) : returnOf(request) };
  if (!googleReady(env) || !env.IDENTITIES) return ending({ ...mode, error: 'not_set_up' });
  let attempt;
  try {
    attempt = await providerAttempt(request, env, form);
  } catch (error) {
    return failed(error, error.code === 'signed_out' ? { provider: 'google' } : mode);
  }
  const { state, nonce, link, back } = attempt;
  // The Eden iOS app (`?app=1`, a GET from its ASWebAuthenticationSession): Google refuses
  // sign-in inside an app's web view, so the app opens this in Apple's web sign-in sheet; the
  // callback ends on the app's own URL scheme with a one-time handoff code (as native Apple's).
  const app = !link && request.method === 'GET' && new URL(request.url).searchParams.get('app') === '1';
  const { verifier, challenge } = await pkcePair();
  const to = buildAuthUrl(env, {
    redirectUri: `${new URL(request.url).origin}${GOOGLE_CALLBACK}`,
    state,
    nonce,
    challenge,
    scopes: SIGN_IN_SCOPES,
    prompt: 'select_account',
  });
  return withCookies(redirect(to), cookie(GOOGLE_COOKIE, withReturn(`${state}.${nonce}.${verifier}.${link ? 'l' : app ? 'a' : 's'}`, back), { maxAge: STATE_SECONDS, sameSite: 'Lax' }));
}

async function googleCallback(request, env) {
  const clear = clearCookie(GOOGLE_COOKIE, 'Lax');
  const url = new URL(request.url);
  const [state = '', nonce = '', verifier = '', flag = 's', packed = ''] = String(cookies(request)[GOOGLE_COOKIE] || '').split('.');
  const mode = { provider: 'google', link: flag === 'l', back: flag === 'l' ? '/' : unpackReturn(packed) };
  if (!googleReady(env) || !env.IDENTITIES) return withCookies(ending({ ...mode, error: 'not_set_up' }), clear);
  const refusal = url.searchParams.get('error');
  if (refusal) return withCookies(flag === 'a' ? toApp({ error: 'cancelled' }) : ending({ ...mode, error: refusal === 'access_denied' ? 'access_denied' : 'cancelled' }), clear);
  if (!state || !nonce || !verifier || !sameText(url.searchParams.get('state') || '', state)) return withCookies(flag === 'a' ? toApp({ error: 'state' }) : ending({ ...mode, error: 'state' }), clear);
  try {
    await limited(env, 'AUTH_RATE', `cb:${clientIp(request)}`);
    const redirectUri = `${url.origin}${GOOGLE_CALLBACK}`;
    const tokens = await exchangeCode(env, { code: url.searchParams.get('code'), verifier, redirectUri });
    const claims = await verifyIdToken(tokens.id_token, { audience: env.GOOGLE_CLIENT_ID, nonce, now: Date.now() / 1000 });
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase().slice(0, 200) : null;
    if (flag === 'a') return withCookies(await appHandoff(request, env, { provider: 'google', sub: claims.sub, email }), clear);
    return withCookies(await finish(request, env, { provider: 'google', sub: claims.sub, email, state, link: mode.link, back: mode.back }), clear);
  } catch (error) {
    if (flag === 'a') return withCookies(toApp({ error: errorCode(error) }), clear);
    return withCookies(failed(error, mode), clear);
  }
}

// ── passkeys (WebAuthn; accounts/webauthn.js) ──
//
// options → the browser's navigator.credentials call → verify. The RP ID is this request's host
// (askeden.com, preview.askeden.com, www.askeden.com each their own); the challenge is kept here,
// never trusted from the browser: verify reads it from clientDataJSON and takes `pk:<challenge>`
// (once, five minutes), which says what it was for and, for `add`, which browser asked.

const PASSKEY_SECONDS = 300;
const PASSKEY_TIMEOUT_MS = 120_000;
const PASSKEY_MODES = new Set(['signin', 'signup', 'add']);
const PASSKEY_PARAMS = ALGS.map((alg) => ({ type: 'public-key', alg }));

/** Browsers only, from this site's own page: a passkey sign-in can't be posted from elsewhere. */
function ownPage(request) {
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin) throw new ApiError(403, 'forbidden', 'Only askeden.com’s own page may do that.');
}

/** The app only (a plain URLSession call): never a page, which always sends its Origin. */
function noPage(request) {
  if (request.headers.get('origin')) throw new ApiError(403, 'forbidden', 'Only the Eden app may do that.');
}

async function passkeyOptions(request, env, { native = false } = {}) {
  if (native) noPage(request);
  else ownPage(request);
  if (!env.IDENTITIES) throw new ApiError(503, 'not_set_up', 'Passkeys aren’t set up here yet.');
  await limited(env, 'AUTH_RATE', `pk:${clientIp(request)}`);
  const body = await readJson(request, 8 * 1024);
  const mode = PASSKEY_MODES.has(body.mode) && !(native && body.mode === 'add') ? body.mode : null;
  if (!mode) throw new ApiError(400, 'bad_request', 'mode must be signin, signup or add');
  const url = new URL(request.url);
  const rpId = url.hostname;
  const value = { mode, rpId, origin: url.origin, native };
  let who = null;
  if (mode === 'add') {
    who = await signedIn(request, env);
    if (who.grant) throw new ApiError(403, 'owner_only', 'Only the account’s owner can add a passkey.');
    const account = await call(env, who.account, 'get', {}, who.token);
    if ((account.identities || []).some((i) => i.provider === 'passkey')) throw new ApiError(409, 'already_linked', 'This Eden account already has a passkey. Remove it first to add another.');
    Object.assign(value, { account: who.account, device: who.device.id });
  }
  // A new account: sign-ups open, and the person check now, before the device makes a passkey for nothing.
  if (mode === 'signup') {
    checkSignups(env);
    // The app has no Turnstile: its new accounts cost more of AUTH_RATE instead (stashHandoff).
    if (!native) await checkHuman(env, body.turnstile, clientIp(request), { host: new URL(request.url).hostname });
  }
  const challenge = b64url(randomBytes(32));
  await callLink(env, `pk:${challenge}`, 'stash', { value, seconds: PASSKEY_SECONDS });
  if (mode === 'signin') {
    return json({ mode, publicKey: { challenge, rpId, timeout: PASSKEY_TIMEOUT_MS, userVerification: 'required', allowCredentials: [] } });
  }
  return json({
    mode,
    publicKey: {
      challenge,
      rp: { id: rpId, name: 'Eden' },
      // A fresh random handle: Eden finds the account by the credential id, never by this.
      user: { id: b64url(randomBytes(16)), name: 'Eden account', displayName: 'Eden' },
      pubKeyCredParams: PASSKEY_PARAMS,
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      attestation: 'none',
      timeout: PASSKEY_TIMEOUT_MS,
    },
  });
}

/** The challenge clientDataJSON names, before anything else is trusted. */
function challengeOf(credential) {
  try {
    const client = JSON.parse(new TextDecoder().decode(b64ToBytes(credential.response.clientDataJSON)));
    if (typeof client.challenge === 'string' && /^[A-Za-z0-9_-]{43}$/.test(client.challenge)) return client.challenge;
  } catch {
    // below
  }
  throw new ApiError(400, 'passkey', 'That passkey answer can’t be read.');
}

async function passkeyVerify(request, env, { native = false } = {}) {
  if (native) noPage(request);
  else ownPage(request);
  if (!env.IDENTITIES) throw new ApiError(503, 'not_set_up', 'Passkeys aren’t set up here yet.');
  await limited(env, 'AUTH_RATE', `pkv:${clientIp(request)}`);
  const body = await readJson(request, 64 * 1024);
  const credential = body.credential;
  const challenge = challengeOf(credential);
  let issued;
  try {
    issued = (await callLink(env, `pk:${challenge}`, 'take')).body.value;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    throw new ApiError(400, 'expired', 'That passkey request ran out or was already used. Try again.');
  }
  const url = new URL(request.url);
  if (issued.rpId !== url.hostname || issued.origin !== url.origin) throw new ApiError(400, 'passkey', 'That passkey request was for another site.');
  if (Boolean(issued.native) !== native) throw new ApiError(400, 'expired', 'That passkey request was started elsewhere. Try again.');
  const where = { challenge, origin: url.origin, rpId: url.hostname };
  const back = safeReturn(body.return);

  if (issued.mode === 'signin') {
    const id = String(credential.rawId || credential.id || '');
    if (!/^[A-Za-z0-9_-]{16,1400}$/.test(id)) throw new ApiError(400, 'passkey', 'That passkey answer has no id.');
    const subHash = await subHashOf('passkey', id);
    const found = await callIdentity(env, 'passkey', subHash, 'passkey');
    if (found.state !== 'linked' || !found.cred) throw new ApiError(404, 'unknown_passkey', 'This passkey isn’t on an Eden account (it may have been removed). Sign in another way, or make an account with it.');
    const { count } = await verifyAssertion({ credential, ...where, stored: found.cred });
    await callIdentity(env, 'passkey', subHash, 'passkey-count', { count });
    if (!webAllowed(env, found.account_id)) throw new ApiError(403, 'not_allowed', "Eden on the web isn't open to this account yet.");
    if (native) return json({ handoff: await stashCode(env, { account_id: found.account_id, provider: 'passkey', sub_hash: subHash, email: null }), expires_in: HANDOFF_SECONDS });
    const made = await call(env, found.account_id, 'web-signin', {
      account_id: found.account_id,
      identity: { provider: 'passkey', sub_hash: subHash, email: null },
      device: { name: browserName(request), app_version: 'askeden.com (passkey)' },
    });
    return withCookies(json({ signed_in: true, to: back }), cookie(SESSION_COOKIE, made.token, { maxAge: SESSION_SECONDS }));
  }

  const made = await verifyRegistration({ credential, ...where });
  const cred = { alg: made.alg, jwk: made.jwk, count: made.count };
  if (issued.mode === 'add') {
    const who = await signedIn(request, env);
    if (who.account !== issued.account || who.device.id !== issued.device) throw new ApiError(400, 'expired', 'That passkey request was started in another window. Try again.');
    await linkIdentity(env, { provider: 'passkey', sub: made.id, cred, account_id: who.account, device_id: who.device.id });
    const account = await call(env, who.account, 'get', {}, who.token);
    return json({ identities: account.identities || [] });
  }
  // signup: Turnstile passed when this challenge was issued (passkeyOptions).
  const subHash = await subHashOf('passkey', made.id);
  if ((await callIdentity(env, 'passkey', subHash, 'get')).state !== 'none') throw new ApiError(409, 'identity_taken', 'This passkey is already used by an Eden account. Sign in with it instead.');
  if (native) return json({ handoff: await stashHandoff(request, env, { provider: 'passkey', sub: made.id, email: null, cred }), created: true, expires_in: HANDOFF_SECONDS });
  const opened = await signInBrowser(request, env, { provider: 'passkey', sub: made.id, email: null, cred });
  return withCookies(json({ signed_in: true, created: true, to: back }), cookie(SESSION_COOKIE, opened.token, { maxAge: SESSION_SECONDS }));
}

// ── the Eden iOS app: native Sign in with Apple, handed to its web view ──
//
// The app signs in with Apple itself (audience com.askeden.eden, a nonce of its own), posts
// the identity token here (no Origin: it's not a browser) and gets a one-time code; its web view
// opens /api/web/handoff?code=… within a minute, which makes the browser device and sets the
// cookie. The code is 32 random bytes, kept server-side (`handoff:<code>`), taken once.

async function nativeApple(request, env) {
  await limited(env, 'AUTH_RATE', `native:${clientIp(request)}`);
  const body = await readJson(request, 64 * 1024);
  const claims = await verifyIdentityToken(body.identity_token, body.nonce, { audience: EDEN_APP_ID, now: Date.now() / 1000 });
  const code = await stashHandoff(request, env, { provider: 'apple', sub: claims.sub, email: null });
  return json({ handoff: code, expires_in: HANDOFF_SECONDS });
}

/** The account a sign-in in the app opens (no Turnstile in an app: a tighter rate), as a one-time handoff code. */
async function stashHandoff(request, env, { provider, sub, email, cred = null }) {
  const ip = clientIp(request);
  const { account_id } = await accountForIdentity(env, { provider, sub, email, ip, cred, beforeCreate: () => nativeNewAccount(env, ip) });
  if (!webAllowed(env, account_id)) throw new ApiError(403, 'not_allowed', "Eden on the web isn't open to this account yet.");
  return stashCode(env, { account_id, provider, sub_hash: await subHashOf(provider, sub), email });
}

/** A one-time handoff code (32 random bytes, a minute, taken once) for this account and identity. */
async function stashCode(env, value) {
  const code = b64url(randomBytes(32));
  await callLink(env, `handoff:${code}`, 'stash', { value, seconds: HANDOFF_SECONDS });
  return code;
}

// Where a sign-in started by the app in Apple's web sheet ends: the app's own scheme, which
// only closes that sheet (ASWebAuthenticationSession), with a handoff code or an error code.
export const APP_CALLBACK = 'com.askeden.eden://signin';
const toApp = (fields) => redirect(`${APP_CALLBACK}?${new URLSearchParams(fields)}`);

async function appHandoff(request, env, identity) {
  return toApp({ code: await stashHandoff(request, env, identity) });
}

async function handoff(request, env) {
  // Only a load the web view itself starts: another site can't sign this browser in to
  // someone else's account by linking here (a login CSRF).
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'none' && site !== 'same-origin') return ending({ error: 'state' });
  const code = new URL(request.url).searchParams.get('code') || '';
  try {
    await limited(env, 'AUTH_RATE', `handoff:${clientIp(request)}`);
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new ApiError(404, 'expired', 'That sign-in is gone. Try again from the app.');
    const kept = (await callLink(env, `handoff:${code}`, 'take')).body.value;
    const made = await call(env, kept.account_id, 'web-signin', {
      account_id: kept.account_id,
      create: true,
      identity: { provider: kept.provider || 'apple', sub_hash: kept.sub_hash, email: kept.email || null },
      device: { name: cleanName(`Eden app: ${browserName(request).replace(/^Eden on the web: /, '')}`, 'Eden app'), app_version: 'askeden.com (Eden app)' },
    });
    // The web view started this load itself (no other site in the chain): a plain redirect
    // carries the new cookie.
    return withCookies(redirect('/'), cookie(SESSION_COOKIE, made.token, { maxAge: SESSION_SECONDS }));
  } catch (error) {
    return failed(error, { provider: 'apple' });
  }
}
