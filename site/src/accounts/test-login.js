// The shared TEST account (owner's request, 2026-10-28): typing test@askeden.com and the test password on /signin
// signs straight into one fixed account with Eden Plus, so testers can try it. OFF unless the Worker var
// TEST_LOGIN = "on" AND the secret TEST_LOGIN_PASSWORD is set: off, /api/web/test-login is the same 404 as any
// unknown path, /api/web/config doesn't mention it, and every test session there was stops working at once.
//
// Everything is enforced here, server-side:
//   - the password: SHA-256 digests compared in constant time; any failure is one generic answer;
//   - per network (a hash of the IP): 10 sign-in tries an hour, and 10 failures lock the test login for an hour
//     (a counter object of its own, RATE_OBJECT, so the daily wipe doesn't reset it);
//   - Plus as a promo-style grant (`promo_plan`, never billed, never Stripe or the App Store), capped at
//     TEST_LOGIN_DAILY_USD (default $2) of AI a UTC day, then the normal "allowance used" answer;
//   - sessions of 24 hours, bound to the current password (changing the secret also ends them);
//   - everything of the account (chats, files, memory, devices) wiped at the first use of each new UTC day;
//   - only an allow-list of routes (testGuard): no Gmail/Calendar, no Mac or Eden Secretary link, no API keys,
//     no billing or credits, no publishing or sharing, no email, no delegates or spaces, no admin or owner tools;
//     the account's object refuses the same ops again (TEST_BLOCKED_OPS).

import { ApiError, json, makeToken, newDevice, sameText, sha256Hex } from './util.js';

export const TEST_EMAIL = 'test@askeden.com';
export const TEST_ACCOUNT_ID = 'e0e0e0e0-7e57-4e57-8e57-7e577e577e57';
export const TEST_RATE_OBJECT = 'test-login-rate:v1';
export const TEST_SESSION_SECONDS = 86400;
export const TEST_TRIES_PER_HOUR = 10;
export const TEST_FAILS_TO_LOCK = 10;
const HOUR = 3600_000;
const TEST_SESSIONS = 50; // browsers signed in to the test account at once (the oldest goes first)
export const TEST_BANNER = 'Test account: shared and reset daily. Don’t enter personal information.';
export const TEST_FAILED = 'Couldn’t sign in. Check the email and password and try again.';
export const TEST_BLOCKED = 'This isn’t available on the shared test account.';
export const TEST_ALLOWANCE_USED = "Today's AI allowance for the test account is used up. It starts again at midnight UTC.";

/** Whether the test login is on: TEST_LOGIN = "on" and the secret TEST_LOGIN_PASSWORD set. */
export function testLoginOn(env = {}) {
  return String(env.TEST_LOGIN || '').trim().toLowerCase() === 'on' && typeof env.TEST_LOGIN_PASSWORD === 'string' && env.TEST_LOGIN_PASSWORD.length > 0;
}

export const isTestAccount = (id) => String(id || '').toLowerCase() === TEST_ACCOUNT_ID;

/** The day's AI cap in dollars of provider cost (TEST_LOGIN_DAILY_USD, default 2). */
export function testDailyUsd(env = {}) {
  const raw = env.TEST_LOGIN_DAILY_USD;
  const n = raw === undefined || raw === null || String(raw).trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 2;
}

const day = (now) => new Date(now).toISOString().slice(0, 10);
const nextMidnight = (now) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

/** The email and password typed on /signin, checked: the email exactly, the password by digest, in constant time. */
export async function testCredentialsOk(env, email, password) {
  if (!testLoginOn(env)) return false;
  const emailOk = String(email || '').trim().toLowerCase() === TEST_EMAIL;
  const given = await sha256Hex(`test-login:${typeof password === 'string' ? password : ''}`);
  const want = await sha256Hex(`test-login:${env.TEST_LOGIN_PASSWORD}`);
  const passOk = sameText(given, want);
  return emailOk && passOk;
}

/** What a test session is bound to: the password now (a hash of a hash; never the password). */
const sessionKey = async (env) => (await sha256Hex(`test-session:${await sha256Hex(String(env.TEST_LOGIN_PASSWORD || ''))}`)).slice(0, 32);

// ── the Worker: which routes a test session may use ──

// Read-mostly app routes and chat: everything else (Gmail/Calendar connect and use, the Mac, keys, billing, publishing,
// sharing, email, delegates, spaces, courses, tasks, the cloud browser and runner, admin, Messenger's @Eden) is refused.
const ALLOWED_EXACT = new Set([
  'GET /api/web/config',
  'GET /api/web/session',
  'GET /api/web/account',
  'POST /api/web/signout',
  'POST /api/web/test-login',
  'POST /api/route',
  'GET /api/chat/meta',
  'GET /api/chat/spend',
  'POST /api/chat/send',
  'POST /api/chat/compare',
  'POST /api/chat/compare/estimate',
  'POST /api/chat/compare/stop',
  'POST /api/chat/eves',
  'POST /api/chat/eves/estimate',
  'POST /api/chat/eves/stop',
  'GET /api/chat/memory',
  'POST /api/chat/memory',
  'POST /api/chat/transcribe',
  'GET /api/chat/webimage',
  'GET /api/chat/media/search',
  'GET /api/chat/media/file',
  'POST /api/chat/embed',
  'POST /api/chat/artifact', // kept in the account (wiped daily), served only to its own sessions
  'POST /api/chat/video',
  'GET /api/chat/google/status', // says "not connected" (connecting is refused)
  'GET /api/chat/gcal/status',
  'GET /api/chat/jarvis/status', // says no Mac
  'GET /api/chat/local',
  'POST /api/voice',
  'POST /api/chat/voice',
  'POST /api/stats/error',
  'POST /api/stats/event',
]);
// Chats and essays on every device (sealed in the account, wiped daily), Help and News.
const ALLOWED_PREFIX = [/^\/api\/web\/(csync|esync|essays)(\/[a-z-]+)?$/, /^\/api\/help(\/.*)?$/, /^\/api\/news(\/.*)?$/];

export function testRouteAllowed(method, path) {
  const m = method === 'HEAD' ? 'GET' : method;
  if (ALLOWED_EXACT.has(`${m} ${path}`)) return true;
  return ALLOWED_PREFIX.some((re) => re.test(path));
}

// ── the account's object: ops a test account never does (again, behind the Worker's allow-list) ──

const BLOCKED_PREFIX = ['scoped-', 'ukeys-', 'pub-', 'share-', 'deleg-', 'stripe-', 'play-', 'mailup-', 'edu-', 'approve-', 'mail-', 'ad-', 'rcpt-', 'task-', 'cmerge-'];
const BLOCKED_OPS = new Set(['google-save', 'add-device', 'promo-grant', 'subscription', 'subscription-eden', 'delete', 'browsers-signout', 'identity-unlink', 'identity-link', 'hold-proxy', 'signin', 'web-signin', 'sync-put', 'sync-delete', 'sync-wipe', 'push-check']);
export const testOpBlocked = (op) => BLOCKED_OPS.has(op) || BLOCKED_PREFIX.some((p) => op.startsWith(p));

// ── the account's object: sign-in, the daily wipe, the day's AI ──

/** Whether this account's object is the test account's (cached once it exists). */
export async function isTestObject(account) {
  if (account._isTest !== undefined) return account._isTest;
  const me = await account.storage.get('account');
  if (!me) return false;
  account._isTest = isTestAccount(me.id);
  return account._isTest;
}

/** Everything of the test account goes at the first use of a new UTC day (chats, files, memory, sessions). → wiped? */
export async function testDailyWipe(account) {
  const today = day(account.now());
  if ((await account.storage.get('test_day')) === today) return false;
  account.closeSockets?.(['listen', 'web', 'phone', 'mac'], 4001, 'test account reset');
  account.holds?.clear();
  await account.storage.deleteAll();
  await Promise.resolve(account.storage.deleteAlarm?.()).catch(() => {});
  await account.storage.put('test_day', today);
  return true;
}

/** A test session's device, checked: the switch on, today's account, the password it was made under. */
export async function testAuthenticate(account, device) {
  if (!testLoginOn(account.env)) {
    for (const key of (await account.storage.list({ prefix: 'dev:' })).keys()) await account.storage.delete(key);
    return false;
  }
  if (await testDailyWipe(account)) return false;
  return Boolean(device.test) && device.test_key === (await sessionKey(account.env));
}

/** The day's AI for the test account, as allowAi answers: what's left of TEST_LOGIN_DAILY_USD, never credits. */
export async function testAllow(account) {
  const cap = testDailyUsd(account.env);
  const spent = await testSpentToday(account);
  const left = cap - spent - account.held('plus') - account.held('trial') - account.held('credits');
  if (!(left > 0)) return { ok: false, why: TEST_ALLOWANCE_USED };
  const r = Math.round(left * 1e6) / 1e6;
  return { ok: true, bucket: 'plus', left: r, allowance_left: r, budget: cap, markup: 1, credits_usd: 0 };
}

export async function testSpentToday(account) {
  const s = (await account.storage.get('test_spend')) || {};
  return s.day === day(account.now()) ? Number(s.usd) || 0 : 0;
}

export async function testSpend(account, usd) {
  const today = day(account.now());
  const s = (await account.storage.get('test_spend')) || {};
  const before = s.day === today ? Number(s.usd) || 0 : 0;
  await account.storage.put('test_spend', { day: today, usd: Math.round((before + usd) * 1e6) / 1e6 });
}

/** What the account page and the chat's meter show for the test account: the day's cap, not a month's Plus. */
export async function testView(account, view) {
  const cap = testDailyUsd(account.env);
  const spent = await testSpentToday(account);
  view.plan.test = true;
  view.test = { banner: TEST_BANNER, daily_usd: cap, resets: nextMidnight(account.now()) };
  Object.assign(view.usage, { budget_usd: cap, spent_usd: spent, left_usd: Math.max(0, Math.round((cap - spent) * 1e6) / 1e6), plus_usd: cap, period_end: nextMidnight(account.now()) });
  view.identities = [];
  return view;
}

/** The ops of the test account's object (the Worker's only): `test-signin`, and on the rate object `test-rate`. */
export async function testOp(account, op, request) {
  const body = await request.json().catch(() => ({}));
  try {
    if (op === 'test-rate') return json(await testRate(account, body));
    if (op === 'test-signin') return json(await testSignIn(account, body));
    throw new ApiError(404, 'not_found', 'No such thing.');
  } catch (error) {
    if (error instanceof ApiError) return error.response();
    throw error;
  }
}

async function testSignIn(account, { account_id }) {
  if (!testLoginOn(account.env) || !isTestAccount(account_id)) throw new ApiError(403, 'forbidden', TEST_FAILED);
  const existing = await account.storage.get('account');
  if (existing && !isTestAccount(existing.id)) throw new ApiError(403, 'forbidden', TEST_FAILED); // never any other account's object
  await testDailyWipe(account);
  const now = account.now();
  if (!(await account.storage.get('account'))) {
    await account.storage.put('account', { id: TEST_ACCOUNT_ID, created: now, origin: 'test', test: true });
    await account.storage.put('identities', []);
  }
  account._isTest = true;
  // Plus as a promo-style grant until the next reset: never billed, no Stripe, no App Store.
  await account.storage.put('promo_plan', { until: nextMidnight(now), codes: [], test: true });
  // At most TEST_SESSIONS browsers: expired ones go, then the oldest.
  const devices = [...(await account.storage.list({ prefix: 'dev:' })).values()];
  const live = [];
  for (const d of devices) {
    if (!d.test || (d.expires && d.expires <= now)) await account.storage.delete(`dev:${d.id}`);
    else live.push(d);
  }
  live.sort((a, b) => (a.created || 0) - (b.created || 0));
  for (const d of live.slice(0, Math.max(0, live.length - (TEST_SESSIONS - 1)))) await account.storage.delete(`dev:${d.id}`);
  const { id, secret } = newDevice();
  const device = {
    id,
    kind: 'web',
    name: 'Test session', // no browser or city: testers see each other's sessions in the account page
    app_version: 'askeden.com (test)',
    created: now,
    last_seen: now,
    secret_hash: await sha256Hex(secret),
    apns_token: null,
    apns_env: null,
    expires: now + TEST_SESSION_SECONDS * 1000,
    test: true,
    test_key: await sessionKey(account.env),
  };
  await account.storage.put(`dev:${id}`, device);
  return { token: makeToken(TEST_ACCOUNT_ID, id, secret), account_id: TEST_ACCOUNT_ID, expires: device.expires };
}

// Per network (`ip`: a hash, never the address): `try` counts a sign-in attempt (10 an hour) and refuses while
// locked; `fail` counts a failure (10 in an hour lock the test login for an hour from the 10th).
async function testRate(account, { ip, action }) {
  if (!/^[0-9a-f]{64}$/.test(String(ip || ''))) throw new ApiError(400, 'bad_request', 'No network.');
  const now = account.now();
  const key = `ip:${ip}`;
  const rec = (await account.storage.get(key)) || { tries: [], fails: [], locked: 0 };
  rec.tries = rec.tries.filter((t) => t > now - HOUR);
  rec.fails = rec.fails.filter((t) => t > now - HOUR);
  const slow = () => new ApiError(429, 'slow_down', 'Too many tries from this network. Try again in an hour.', { 'retry-after': '3600' });
  if (action === 'try') {
    if (rec.locked > now || rec.tries.length >= TEST_TRIES_PER_HOUR) {
      await account.storage.put(key, rec);
      throw slow();
    }
    rec.tries.push(now);
  } else if (action === 'fail') {
    rec.fails.push(now);
    if (rec.fails.length >= TEST_FAILS_TO_LOCK) rec.locked = now + HOUR;
  } else throw new ApiError(400, 'bad_request', 'try or fail');
  await account.storage.put(key, rec);
  // Now and then, networks not seen for a day go.
  if (Math.random() < 0.02) {
    for (const [k, v] of await account.storage.list({ prefix: 'ip:', limit: 500 })) {
      if (Math.max(0, ...v.tries, ...v.fails, v.locked || 0) < now - 24 * HOUR) await account.storage.delete(k);
    }
  }
  return { ok: true };
}

export const testIpKey = (ip) => sha256Hex(`test-login-ip:${ip}`);
