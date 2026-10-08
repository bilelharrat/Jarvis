// askeden.com/api/…: Jarvis accounts (docs/accounts.md). The Worker's side: it reads the
// device token, finds the account's Durable Object, and does the parts that talk to the
// world (Apple's sign-in keys, Apple's push service, Anthropic) itself, so an account's
// object is never kept busy by a stream.

import { exchangeCode, revoke, verifyIdentityToken } from './apple.js';
import { MAX_PAYLOAD, GONE, pushReady, sendPush } from './apns.js';
import { takenWords } from './identity.js';
import { cleanCode, newCode } from './link.js';
import { edenSyncApi } from './eden-sync.js';
import { chatSyncApi } from './chat-sync.js';
import { CHARS_PER_TOKEN, anthropicError, costOf, forward } from './proxy.js';
import { APPLE_ROOT_G3, verifyAppleJws } from './storekit.js';
import { checkSignups } from './turnstile.js';
import { cancelSubscription } from '../eden/billing.js';
import {
  ApiError,
  BUNDLE_ID,
  accountIdFor,
  b64ToBytes,
  b64url,
  cleanName,
  cleanVersion,
  json,
  randomBytes,
  readJson,
  safeDecode,
  sha256Hex,
  signedOut,
  tokenFrom,
  validAccountId,
  webAllowed,
} from './util.js';

export { Account } from './account.js';
export { Link } from './link.js';
export { Identity } from './identity.js';
export { Space } from './space.js';

const accountStub = (env, id) => env.ACCOUNTS.get(env.ACCOUNTS.idFromName(id));
const linkStub = (env, code) => env.LINKS.get(env.LINKS.idFromName(code));
const identityStub = (env, provider, subHash) => env.IDENTITIES.get(env.IDENTITIES.idFromName(`${provider}:${subHash}`));

/** What an identity is known by everywhere here (no raw sub is stored): SHA-256 hex of "<provider>:<sub>". */
export const subHashOf = (provider, sub) => sha256Hex(`${provider}:${sub}`);

// One op on an account's object; its JSON, or its refusal thrown as an ApiError. (Hosted
// Eden, src/eden/, uses these too.)
export async function call(env, accountId, op, body = {}, auth = null) {
  const headers = { 'content-type': 'application/json' };
  if (auth) {
    headers['x-jarvis-device'] = auth.device;
    headers['x-jarvis-secret'] = auth.secret;
  }
  const response = await accountStub(env, accountId).fetch(`https://account/${op}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return unwrap(response);
}

export async function callLink(env, code, op, body = {}) {
  const response = await linkStub(env, code).fetch(`https://link/${op}`, { method: 'POST', body: JSON.stringify(body) });
  return { status: response.status, body: await unwrap(response) };
}

// One op on an identity's object (named `<provider>:<sub hash>`).
export async function callIdentity(env, provider, subHash, op, body = {}) {
  const response = await identityStub(env, provider, subHash).fetch(`https://identity/${op}`, { method: 'POST', body: JSON.stringify({ provider, ...body }) });
  return unwrap(response);
}

async function unwrap(response) {
  const body = await response.json().catch(() => ({}));
  if (response.status >= 400) {
    const { error, code, ...extra } = body;
    throw new ApiError(response.status, code || 'error', error || 'Something went wrong.', retryHeaders(response), extra);
  }
  return body;
}

function retryHeaders(response) {
  const after = response.headers.get('retry-after');
  return after ? { 'retry-after': after } : {};
}

function auth(request, options) {
  const token = tokenFrom(request, options);
  if (!token) throw signedOut();
  return token;
}

export async function limited(env, binding, key) {
  const limiter = env[binding];
  if (!limiter) return;
  const { success } = await limiter.limit({ key });
  if (!success) throw new ApiError(429, 'slow_down', 'Too many tries; wait a minute.', { 'retry-after': '60' });
}

export async function api(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '');
  const method = request.method;
  try {
    if (!env.ACCOUNTS || !env.LINKS) throw new ApiError(503, 'not_set_up', 'Jarvis accounts are not set up here yet.');
    if (path.startsWith('/anthropic/')) return await anthropic(request, env, ctx, path.slice('/anthropic'.length));
    if (path.startsWith('/relay/')) return await relay(request, env, path.slice('/relay/'.length));
    if (path === '/account/apple' && method === 'POST') return json(await signIn(request, env));
    if (path === '/account' && method === 'GET') return json(await callAs(env, request, 'get'));
    if (path === '/account' && method === 'DELETE') return await deleteAccount(request, env);
    if (path === '/devices/me' && method === 'PUT') {
      await callAs(env, request, 'device-update', await readJson(request));
      return new Response(null, { status: 204 });
    }
    const device = /^\/devices\/([0-9a-f]{16}|me)$/.exec(path);
    if (device && method === 'DELETE') {
      await callAs(env, request, 'device-delete', { id: device[1] });
      return new Response(null, { status: 204 });
    }
    if (path === '/link/start' && method === 'POST') return json(await linkStart(request, env));
    if (path === '/link/poll' && method === 'POST') return await linkPoll(request, env);
    const link = /^\/link\/([^/]+)(?:\/(approve|deny))?$/.exec(path);
    if (link) return await linkByCode(request, env, link[1], link[2] || '', method);
    if (path === '/push' && method === 'POST') return json(await push(request, env));
    const approval = /^\/tasks\/approvals\/([0-9a-f]{16})$/.exec(path);
    if (approval && method === 'POST') return json(await taskApproval(request, env, approval[1]));
    if (path === '/subscription' && method === 'POST') return json(await subscription(request, env));
    if (path === '/appstore/notifications' && method === 'POST') return await appStoreNotification(request, env);
    // Eden sync for the apps (docs/accounts.md "Eden sync"): the same ops a browser has, by token.
    const esync = /^\/esync(?:\/([a-z]+))?$/.exec(path);
    if (esync) {
      const token = auth(request);
      return await edenSyncApi(request, env, { account: token.account, token }, esync[1] || '');
    }
    const csync = /^\/csync\/([a-z]+)$/.exec(path);
    if (csync) {
      const token = auth(request);
      return await chatSyncApi(request, env, { account: token.account, token }, csync[1]);
    }
    if (path === '/sync' && method === 'GET') {
      return json(await callAs(env, request, 'sync-get', { since: Number(url.searchParams.get('since')) || 0 }));
    }
    if (path === '/sync' && method === 'DELETE') {
      await callAs(env, request, 'sync-wipe');
      return new Response(null, { status: 204 });
    }
    const item = /^\/sync\/(.+)$/.exec(path);
    if (item && (method === 'PUT' || method === 'DELETE')) {
      const key = safeDecode(item[1]);
      if (!key) throw new ApiError(400, 'bad_request', 'That isn’t a valid key.');
      const body = method === 'PUT' ? await readJson(request, 1 << 20) : { base_rev: Number(url.searchParams.get('base_rev')) || 0 };
      return json(await callAs(env, request, method === 'PUT' ? 'sync-put' : 'sync-delete', { ...body, key }));
    }
    throw new ApiError(404, 'not_found', 'No such thing here.');
  } catch (error) {
    if (error instanceof ApiError) return error.response();
    console.error('api failed', path, error && error.stack);
    return json({ error: 'Something went wrong on the server. Try again.', code: 'server' }, 500);
  }
}

// Approve or Deny a background task's approval from its notification (the iPhone app's actions,
// accounts/tasks.js): the same decision as Eden's Tasks panel, by the app's own device token. Apps
// send no Origin; a page can't make this call (no cookie counts here, and an Origin is refused).
async function taskApproval(request, env, id) {
  if (request.headers.get('origin')) throw new ApiError(403, 'forbidden', 'Only the J.A.R.V.I.S. app answers from a notification.');
  const token = auth(request);
  await limited(env, 'API_RATE', token.account);
  const { decision } = await readJson(request, 4096);
  if (decision !== 'approve' && decision !== 'deny') throw new ApiError(400, 'bad_request', 'decision is approve or deny.');
  const approve = decision === 'approve';
  return call(env, token.account, approve ? 'task-approve' : 'task-deny', { id, from_app: true, ...(approve ? { confirm: true } : {}) }, token);
}

// call(), as the device whose token the request carries.
function callAs(env, request, op, body = {}) {
  const token = auth(request);
  return call(env, token.account, op, body, token);
}

// ── signing in ──

async function signIn(request, env) {
  const body = await readJson(request);
  const claims = await verifyIdentityToken(body.identity_token, body.nonce, { now: Date.now() / 1000 });
  const ip = clientIp(request);
  const { account_id: accountId } = await accountForIdentity(env, { provider: 'apple', sub: claims.sub, ip, beforeCreate: () => nativeNewAccount(env, ip) });
  const refreshToken = await exchangeCode(env, body.authorization_code);
  const device = body.device && typeof body.device === 'object' ? body.device : {};
  return call(env, accountId, 'signin', {
    account_id: accountId,
    refresh_token: refreshToken,
    identity: { provider: 'apple', sub_hash: await subHashOf('apple', claims.sub), email: null },
    device: { name: cleanName(device.name, 'iPhone'), kind: device.kind, app_version: cleanVersion(device.app_version) },
  });
}

async function deleteAccount(request, env) {
  const token = auth(request);
  await eraseAccount(env, token.account, token); // an app's token: a browser's is refused here
  return new Response(null, { status: 204 });
}

/**
 * Deletes an account for good (the iPhone app's Delete Account, the account page's): its object
 * (devices, so every sign-in everywhere; usage, chats kept here, keys, published pages), then
 * what lives elsewhere. `auth`: the device token asking; a browser's only with `confirm: "DELETE"`
 * (the account page's typed confirmation, eden/session.js).
 */
export async function eraseAccount(env, accountId, auth, { confirm = null } = {}) {
  const { apple_grant: grant, identities = [], stripe_subscription: stripeSub, published = [] } = await call(env, accountId, 'delete', confirm ? { confirm } : {}, auth);
  if (grant) await revoke(env, grant);
  // Plus bought on the web stops now (best effort); the App Store's is the person's to cancel.
  if (stripeSub) await cancelSubscription(env, stripeSub);
  // Its published pages' links go too (accounts/published.js `pub:<id>`).
  for (const id of published) await call(env, `pub:${id}`, 'pub-index-drop', { account: accountId }).catch(() => {});
  // The cloud browser's history, bookmarks and agent log live in its own per-account object.
  if (env.BROWSER_SESSIONS) {
    await env.BROWSER_SESSIONS.get(env.BROWSER_SESSIONS.idFromName(accountId)).fetch('https://browser/erase', { method: 'POST' }).catch((e) => console.error('cloud browser cleanup failed', e && e.message));
  }
  // Its sign-ins open nothing now (passkeys included): an Apple ID goes back to the account its
  // id derives from (a new one), a Google account to a new one.
  if (env.IDENTITIES) {
    for (const { provider, sub_hash: subHash } of identities) {
      if (subHash) await callIdentity(env, provider, subHash, 'forget', { account_id: accountId }).catch(() => {});
    }
  }
}

// A new account from an app's own Sign in with Apple (the J.A.R.V.I.S. and Eden iOS apps): no
// Turnstile there (a native sheet, no page), so it costs NATIVE_NEW_WEIGHT tries of AUTH_RATE
// on a counter of its own per network: at most 20 / 5 = 4 new accounts a minute from one network,
// on top of every new account's own `new:` count (docs/web-auth.md "Turnstile").
export const NATIVE_NEW_WEIGHT = 5;
export async function nativeNewAccount(env, ip) {
  for (let i = 0; i < NATIVE_NEW_WEIGHT; i++) await limited(env, 'AUTH_RATE', `native-new:${ip}`);
}

export const clientIp = (request) => request.headers.get('cf-connecting-ip') || 'unknown';

const accountExists = async (env, id) => (await call(env, id, 'exists')).exists === true;

// ── sign-in identities (docs/web-auth.md "One account, many ways in") ──

/**
 * The account a verified sign-in opens: { account_id }. Apple: the account its Identity names,
 * else (every account the iPhone app made) the one its id derives from; an Apple ID unlinked
 * since, or a Google account seen for the first time, gets a new account (random UUID v4).
 * A new account counts against AUTH_RATE per network. Never matched by email.
 */
export async function accountForIdentity(env, { provider, sub, email = null, ip = 'unknown', cred = null, beforeCreate = null }) {
  const derived = provider === 'apple' ? await accountIdFor(sub) : null;
  if (!env.IDENTITIES) {
    // Before the IDENTITIES binding is deployed: Apple as it always was, nothing else.
    if (!derived) throw new ApiError(503, 'not_set_up', 'This sign-in is not set up here yet.');
    if (!(await accountExists(env, derived))) checkSignups(env); // sign-ups closed: existing accounts only
    return { account_id: derived };
  }
  const subHash = await subHashOf(provider, sub);
  const found = await callIdentity(env, provider, subHash, 'get');
  if (found.state === 'linked') return { account_id: found.account_id };
  let proposed = found.state === 'none' ? derived : null;
  if (!proposed || !(await accountExists(env, proposed))) {
    // A new Eden account: open to sign-ups at all (SIGNUPS), the person check (Turnstile,
    // accounts/turnstile.js), then the rate. The owner's verified email (OWNER_DOMAINS) may
    // while sign-ups are closed.
    checkSignups(env, email);
    if (beforeCreate) await beforeCreate();
    await limited(env, 'AUTH_RATE', `new:${ip}`);
    proposed ||= crypto.randomUUID();
  }
  const { account_id } = await callIdentity(env, provider, subHash, 'resolve', { proposed, email, ...(cred ? { cred } : {}) });
  return { account_id };
}

/**
 * Attaches a freshly verified identity to the account of a signed-in browser (`device_id`, a
 * live `web` device of `account_id`). 409 identity_taken when it opens another account.
 */
export async function linkIdentity(env, { provider, sub, email = null, account_id, device_id, cred = null }) {
  if (!env.IDENTITIES) throw new ApiError(503, 'not_set_up', 'Linking sign-ins is not set up here yet.');
  const subHash = await subHashOf(provider, sub);
  const found = await callIdentity(env, provider, subHash, 'get');
  if (found.state === 'linked' && found.account_id !== account_id) throw new ApiError(409, 'identity_taken', takenWords(provider));
  const derived = provider === 'apple' ? await accountIdFor(sub) : null;
  if (found.state === 'none' && derived) {
    // An Apple ID the iPhone app already made an account for belongs to that account.
    if (derived !== account_id && (await accountExists(env, derived))) throw new ApiError(409, 'identity_taken', takenWords(provider));
  }
  const claimed = await callIdentity(env, provider, subHash, 'claim', { account_id, email, ...(cred ? { cred } : {}) });
  try {
    await call(env, account_id, 'identity-link', { device_id, identity: { provider, sub_hash: subHash, email, derived } });
  } catch (error) {
    if (claimed.created) {
      // Put it back the way it was: never seen (Apple falls back to its own account again) or unlinked.
      await callIdentity(env, provider, subHash, found.state === 'none' ? 'forget' : 'release', { account_id }).catch(() => {});
    }
    throw error;
  }
  return { provider, email };
}

/** Takes a sign-in method off the signed-in browser's account (never the last one). */
export async function unlinkIdentity(env, token, provider) {
  const removed = await call(env, token.account, 'identity-unlink', { provider }, token);
  if (env.IDENTITIES && removed.sub_hash) await callIdentity(env, provider, removed.sub_hash, 'release', { account_id: token.account });
  return { provider };
}

// ── linking a Mac ──

// A Mac's name as the iPhone shows it ("Link “…”?"). Whoever starts a link picks it, so it
// may not pass for a browser's sign-in to Eden (which the iPhone approves the same way).
export function macName(name) {
  const clean = cleanName(name, 'Mac');
  return /\b(eden|askeden|web|browser|sign[- ]?in)\b/i.test(clean) ? cleanName(`Mac: ${clean}`, 'Mac') : clean;
}

async function linkStart(request, env) {
  await limited(env, 'LINK_RATE', `start:${request.headers.get('cf-connecting-ip') || 'unknown'}`);
  const body = await readJson(request);
  let key;
  try {
    key = b64ToBytes(body.public_key || '');
  } catch {
    key = new Uint8Array();
  }
  if (key.length !== 32) throw new ApiError(400, 'bad_request', 'The Mac needs to send its 32-byte public key.');
  const poll = b64url(randomBytes(32));
  for (let tries = 0; tries < 5; tries++) {
    const code = newCode();
    try {
      const { body: started } = await callLink(env, code, 'start', {
        name: macName(body.name),
        kind: 'mac', // only Macs link; phones sign in with Apple
        public_key: body.public_key,
        app_version: cleanVersion(body.app_version),
        poll,
      });
      return { code, poll, expires_in: started.expires_in };
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 409)) throw error;
    }
  }
  throw new ApiError(503, 'busy', 'Try again in a moment.');
}

async function linkPoll(request, env) {
  const body = await readJson(request);
  const code = cleanCode(body.code);
  if (!code) throw new ApiError(404, 'not_found', "That code isn't one we know.");
  await limited(env, 'LINK_RATE', `poll:${code}`);
  const { status, body: answer } = await callLink(env, code, 'poll', { poll: body.poll });
  return json(answer, status);
}

async function linkByCode(request, env, rawCode, action, method) {
  const token = auth(request);
  await limited(env, 'LINK_RATE', `look:${token.account}`);
  const code = cleanCode(safeDecode(rawCode));
  if (!code) throw new ApiError(404, 'not_found', "That code isn't one we know. Check it on the Mac.");
  const { device } = await call(env, token.account, 'whoami', {}, token);
  // A browser approves nothing; a Mac approves a browser's sign-in (kind `web`), never a Mac.
  if (device.kind === 'web') throw new ApiError(403, 'forbidden', 'Approve it in the J.A.R.V.I.S. app on your iPhone or Mac.');
  const link = (await callLink(env, code, 'peek')).body;
  const web = link.kind === 'web';
  if (!web && device.kind === 'mac') throw new ApiError(403, 'forbidden', 'Approve a Mac from your iPhone.');
  if (web && !webAllowed(env, token.account) && action !== 'deny') {
    throw new ApiError(403, 'not_allowed', "Eden on the web isn't open to this account yet.");
  }
  if (!action && method === 'GET') return json(link);
  if (method !== 'POST') throw new ApiError(405, 'bad_request', 'POST to approve or deny.');
  if (action === 'deny') {
    await callLink(env, code, 'deny');
    return new Response(null, { status: 204 });
  }
  const body = await readJson(request);
  const made = await call(env, token.account, 'add-device', { name: link.name, kind: link.kind, app_version: link.app_version }, token);
  // A browser gets no sync key: it has no key pair, and askeden.com keeps nothing it could open.
  const sealed = !web && typeof body.sealed_key === 'string' && body.sealed_key ? body.sealed_key : null;
  const sender = !web && typeof body.sender_key === 'string' && body.sender_key ? body.sender_key : null;
  try {
    await callLink(env, code, 'approve', {
      result: { token: made.token, account_id: made.account_id, device_id: made.device_id, sealed_key: sealed, sender_key: sender },
    });
  } catch (error) {
    // The code ran out (or was used) in between: the device made for it goes again.
    await call(env, token.account, 'device-delete', { id: made.device_id }, token).catch(() => {});
    throw error;
  }
  return json({ device_id: made.device_id, name: made.name });
}

// ── pushes ──

async function push(request, env) {
  if (!pushReady(env)) throw new ApiError(503, 'not_set_up', 'Notifications through Jarvis accounts are not set up yet.');
  const token = auth(request);
  const accountId = token.account;
  const body = await readJson(request, 64 * 1024);
  const payload = JSON.stringify(body.payload ?? {});
  if (!body.payload || typeof body.payload !== 'object') throw new ApiError(400, 'bad_request', 'A push needs a payload.');
  if (new TextEncoder().encode(payload).length > MAX_PAYLOAD) throw new ApiError(413, 'too_big', 'A push is at most 4 KB.');
  const checked = await call(env, accountId, 'push-check', { apns_token: body.apns_token, push_type: body.push_type }, token);
  const result = await sendPush(env, {
    apns_token: checked.token,
    apns_env: body.apns_env,
    push_type: body.push_type,
    priority: body.priority,
    collapse_id: body.collapse_id,
    expiration: body.expiration,
    body: payload,
  });
  if (GONE.has(result.reason) || result.status === 410) await call(env, accountId, 'push-gone', { apns_token: checked.token });
  return result;
}

// ── the plan ──

async function subscription(request, env) {
  const body = await readJson(request, 64 * 1024);
  const transaction = await verifyAppleJws(body.signed_transaction, { root: env.APPLE_ROOT_FINGERPRINT || APPLE_ROOT_G3 });
  if (transaction.bundleId !== BUNDLE_ID) throw new ApiError(400, 'bad_transaction', "That purchase isn't for Jarvis.");
  return callAs(env, request, 'subscription', { transaction });
}

async function appStoreNotification(request, env) {
  const body = await readJson(request, 256 * 1024);
  const root = env.APPLE_ROOT_FINGERPRINT || APPLE_ROOT_G3;
  const notice = await verifyAppleJws(body.signedPayload, { root });
  const data = notice.data || {};
  if (data.bundleId && data.bundleId !== BUNDLE_ID) return new Response(null, { status: 200 });
  if (!data.signedTransactionInfo) return new Response(null, { status: 200 }); // a TEST notification, say
  const transaction = await verifyAppleJws(data.signedTransactionInfo, { root });
  const renewal = data.signedRenewalInfo ? await verifyAppleJws(data.signedRenewalInfo, { root }) : null;
  const accountId = String(transaction.appAccountToken || '').toLowerCase();
  if (!validAccountId(accountId) || transaction.bundleId !== BUNDLE_ID) return new Response(null, { status: 200 });
  try {
    await call(env, accountId, 'notification', { transaction, renewal });
  } catch (error) {
    // A deleted account, or someone else's purchase: Apple needn't send it again.
    if (!(error instanceof ApiError && error.status < 500)) throw error;
  }
  return new Response(null, { status: 200 });
}

// ── the relay ──

async function relay(request, env, kind) {
  const token = auth(request);
  if (!['listen', 'connect', 'accept', 'web'].includes(kind)) throw new ApiError(404, 'not_found', 'No such relay door.');
  const url = new URL(request.url);
  const inner = new URL(`https://account/relay/${kind}${url.search}`);
  const headers = new Headers(request.headers);
  headers.delete('authorization');
  headers.set('x-jarvis-device', token.device);
  headers.set('x-jarvis-secret', token.secret);
  return accountStub(env, token.account).fetch(new Request(inner, { method: 'GET', headers }));
}

// ── included AI ──

async function anthropic(request, env, ctx, path) {
  if (request.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(path)) {
    return anthropicError(404, 'not_found_error', 'Only messages are available here.');
  }
  const token = tokenFrom(request, { apiKey: true });
  if (!token) return anthropicError(401, 'authentication_error', 'Sign in to your Jarvis account on this device.');
  let allow;
  try {
    await limited(env, 'API_RATE', token.account);
    // Its worst case held until it's done (account.js holdProxy): parallel requests can't spend past the allowance.
    if (path === '/v1/messages') allow = await call(env, token.account, 'hold-proxy', { usd: await worstCase(request.clone()) }, token);
    else {
      // Counting tokens is free, but only for the account's own apps (the token is checked).
      const { device } = await call(env, token.account, 'whoami', {}, token);
      if (device.kind === 'web') throw new ApiError(403, 'forbidden', "A browser's sign-in is for Eden at askeden.com only.");
      allow = { ok: true, bucket: 'none' };
    }
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.status === 401) return anthropicError(401, 'authentication_error', error.message);
    if (error.status === 403) return anthropicError(403, 'permission_error', error.message);
    if (error.status === 429) return anthropicError(429, 'rate_limit_error', error.message, error.headers);
    throw error;
  }
  if (!allow.ok) return anthropicError(402, 'billing_error', allow.why);
  let held = allow.hold || null;
  const release = async () => {
    if (!held) return;
    const hold = held;
    held = null;
    await call(env, token.account, 'release-ai', { hold }).catch(() => {});
  };
  const record = async (model, usage) => {
    try {
      const usd = costOf(model, usage);
      if (usd > 0 && allow.bucket !== 'none') await call(env, token.account, 'spend', { usd, bucket: allow.bucket });
    } finally {
      await release();
    }
  };
  let response;
  try {
    response = await forward(request, env, ctx, path, record);
  } catch (error) {
    await release();
    throw error;
  }
  if (!response.ok) ctx.waitUntil(release()); // nothing was spent
  return response;
}

/** A request's most it can cost: its body as input (CHARS_PER_TOKEN) and all of max_tokens out. */
async function worstCase(request) {
  const text = await request.text().catch(() => '');
  let body = {};
  try {
    body = JSON.parse(text) || {};
  } catch {
    // forward() refuses it
  }
  const out = Number(body.max_tokens) > 0 ? Number(body.max_tokens) : 4096;
  return costOf(String(body.model || ''), { input_tokens: Math.ceil(text.length / CHARS_PER_TOKEN), output_tokens: out });
}
