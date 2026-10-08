// Delegated access (ROADMAP H14; docs/accounts.md "Delegates"), and the grants team spaces
// use too (space.js): someone signs in with their own Eden account and uses part of another
// account, within limits the owner set and the server enforces.
//
// A delegation, in the owner's account object (`dlg:<id>`): { id, name (the delegate, as the
// owner calls them), from (the owner, as the delegate sees them), features ('chat', and
// 'mail' / 'calendar' only when granted), cap_usd (a month, out of the owner's allowance),
// expires, status 'invited' | 'active', invite_hash, invite_expires, delegate (their account
// id once accepted) }. An invitation is a code (XXXX-XXXX-XXXX, 60 random bits, also sent as
// a link the owner shares themselves: askeden.com never emails). To find the owner from the
// code alone, an object of its own in the ACCOUNTS namespace, named `dinv:<SHA-256 of the
// code>`, holds { account, id, expires } and nothing else (as published.js does for /p/).
//
// A grant: a `web` device on the owner's account carrying `grant: { type: 'delegate' |
// 'space', id, account (the person using it), features, label }`. The delegate's browser
// keeps its token in its own cookie (__Host-eden-as) beside its own session; eden/session.js
// uses it only for hosted Eden's chat (chat.js) and only while the person's own session is
// valid and is that grant's account. Everything a grant may do is decided here, in the
// owner's object: chat turns and artifacts, Gmail and Calendar only when granted, never the
// account, its devices, sign-in methods, sync, delegates, spaces, the Mac or the voice.
//
// Money: a grant's turns spend the owner's allowance and a pool's (`pool:<type>:<id>`
// { cap, month, spent, by }): the hold names it in its bucket ("plus|dlg:<id>|<by>"), so
// account.js spend() counts it where it belongs even if the hold itself is forgotten.

import { ApiError, cleanName, json, parseToken, randomBytes, sameText, sha256Hex, validAccountId } from './util.js';
import { cookie, clearCookie, cookies } from '../eden/web.js';

export const DELEGATES = { max: 10, inviteDays: 7, days: [7, 30, 90, 365], maxCap: 500, sessionDays: 30 };
export const FEATURES = ['chat', 'mail', 'calendar'];
export const ACTING_COOKIE = '__Host-eden-as';
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const month = (now) => new Date(now).toISOString().slice(0, 7);
const round = (usd) => Math.round(usd * 1e6) / 1e6;
const bad = (message) => new ApiError(400, 'bad_request', message);

export function newInviteCode() {
  const raw = [...randomBytes(12)].map((b) => ALPHABET[b & 31]).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

/** What a person typed (or a link carried) as an invite code; null if it can't be one. */
export function cleanInviteCode(text) {
  let raw = String(text || '').trim().toUpperCase().replace(/^.*#(DELEGATE|SPACE)=/, '');
  raw = raw.replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (raw.length !== 12 || [...raw].some((c) => !ALPHABET.includes(c))) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

function cap(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > DELEGATES.maxCap) throw bad(`The monthly limit is $0–$${DELEGATES.maxCap}.`);
  return Math.round(n * 100) / 100;
}

function features(list) {
  const wanted = Array.isArray(list) ? list : [];
  return FEATURES.filter((f) => f === 'chat' || wanted.includes(f));
}

function days(value) {
  const n = Number(value);
  if (!DELEGATES.days.includes(n)) throw bad(`Access lasts ${DELEGATES.days.join(', ')} days.`);
  return n;
}

// ── grants: what a grant's device may do (account.js asks on every authenticated op) ──

const GRANT_OPS = new Set(['whoami', 'get', 'allow-ai', 'hold-ai', 'artifact-put', 'artifact-get', 'device-delete']);

/** Throws 403 unless a grant's device may run `op` on the owner's account. */
export function grantGuard(device, op) {
  const grant = device.grant;
  if (!grant) return;
  if (GRANT_OPS.has(op)) return;
  const f = grant.features || [];
  if ((op === 'google-get' || op === 'google-touch') && (f.includes('mail') || f.includes('calendar'))) return;
  if (op.startsWith('approve-') && (f.includes('mail') || f.includes('calendar'))) return; // a delegate's own click approves a send or an event
  if (op.startsWith('mailup-') && f.includes('mail')) return; // Gmail attachments uploaded ahead (mail-uploads.js), as the owner's Gmail
  throw new ApiError(403, 'grant_forbidden', grant.type === 'space' ? 'A team space is for chat. That stays with the space’s owner.' : 'As a delegate you can’t do that. It stays with the account’s owner.');
}

// Hosted Eden's routes a grant may use (chat.js gate asks, before anything runs).
const CHAT_ROUTES = new Set([
  'GET /api/chat/meta', 'POST /api/route', 'POST /api/chat/send', 'POST /api/chat/artifact', 'GET /api/chat/jarvis/status',
  'POST /api/chat/compare', 'POST /api/chat/compare/estimate', 'POST /api/chat/compare/stop', 'POST /api/chat/browser/steer',
]);
const MAIL_ROUTES = new Set(['POST /api/chat/gmail', 'POST /api/chat/approve', 'GET /api/chat/google/status']);
const CALENDAR_ROUTES = new Set(['POST /api/chat/approve', 'GET /api/chat/gcal/status', 'POST /api/chat/gcal', 'GET /api/chat/google/status']);

/** Whether an acting session (a delegate, a space member) may use this hosted Eden route. */
export function grantAllows(grant, method, path) {
  if (!grant) return true;
  const route = `${method} ${path}`;
  if (CHAT_ROUTES.has(route)) return true;
  const f = grant.features || [];
  return (f.includes('mail') && MAIL_ROUTES.has(route)) || (f.includes('calendar') && CALENDAR_ROUTES.has(route));
}

/** The person's own things, even while acting for someone: their published pages (G10). */
export const ownRoute = (path) => path === '/api/chat/publish' || path.startsWith('/api/chat/published');

export const grantRefusal = (grant) =>
  new ApiError(403, 'grant_forbidden', grant.type === 'space' ? 'In a team space Eden is chat only.' : 'Your delegated access doesn’t include that. Ask the account’s owner.');

const poolKey = (grant) => `pool:${grant.type === 'space' ? 'spc' : 'dlg'}:${grant.id}`;
const byOf = (grant) => String(grant.member || grant.account || '').slice(0, 16);

async function pool(account, key) {
  const now = account.now();
  const p = (await account.storage.get(key)) || { cap: 0, month: month(now), spent: 0, by: {} };
  if (p.month !== month(now)) Object.assign(p, { month: month(now), spent: 0, by: {} });
  return p;
}

/**
 * What a grant may still spend: the owner's allowance (`base`, account.js allowAi) narrowed to
 * the grant's pool, less its turns in flight. The bucket names the pool, for spend().
 */
export async function grantAllow(account, device, base, plan) {
  const grant = device.grant;
  if (!base.ok) return base;
  if (grant.type === 'space' && !plan.active) return { ok: false, why: 'This space’s owner doesn’t have Plus right now, so its shared AI is paused.' };
  const key = poolKey(grant);
  if (grant.type === 'delegate') {
    const d = await account.storage.get(`dlg:${grant.id}`);
    if (!d || d.status !== 'active') return { ok: false, why: 'This delegated access has ended.' };
  }
  const p = await pool(account, key);
  const held = account.heldIn(key);
  const left = round(Math.max(0, Math.min(base.left, p.cap - p.spent - held)));
  if (left <= 0) {
    return { ok: false, why: grant.type === 'space' ? 'This space’s shared AI budget is used up this month.' : 'Your delegated AI limit is used up this month. It starts again on the 1st.' };
  }
  return { ok: true, bucket: `${base.bucket}|${key.slice(5)}|${byOf(grant)}`, left, pool: key };
}

/** spend() of a bucket naming a pool: counted there too, and by whom. */
export async function poolSpend(account, poolName, by, usd) {
  const key = `pool:${poolName}`;
  if (!/^pool:(dlg|spc):[A-Za-z0-9_-]{1,40}$/.test(key)) return;
  const p = await pool(account, key);
  p.spent = round(p.spent + usd);
  if (by) p.by[by] = round((p.by[by] || 0) + usd);
  await account.storage.put(key, p);
}

/** What a grant's device sees as "the account": its own limit and nothing of the owner's. */
export async function grantView(account, device) {
  const grant = device.grant;
  const p = await pool(account, poolKey(grant));
  const plan = await account.planNow();
  const left = round(Math.max(0, p.cap - p.spent));
  return {
    id: (await account.storage.get('account')).id,
    grant: { type: grant.type, id: grant.id, label: grant.label, features: grant.features, expires: device.expires || null },
    plan: { name: grant.type, active: grant.type === 'space' ? plan.active : true, product_id: null, expires: null, renews: null, environment: null },
    usage: { spent_usd: round(p.spent), budget_usd: p.cap, left_usd: left, trial_left_usd: left, trial_usd: p.cap, plus_usd: p.cap, period_start: null, period_end: null, voice_today: 0, voice_daily: 0 },
    devices: [],
    identities: [],
    sync: { rev: 0, items: 0 },
  };
}

// ── the Durable Object's side: `deleg-` ops (account.js dispatches them here) ──

/**
 * Owner's ops (a device of the account, never a grant's): deleg-list, deleg-invite, deleg-update,
 * deleg-revoke, deleg-mine (what this account may use elsewhere). The Worker's own (no device):
 * deleg-accept, deleg-session, deleg-quit, deleg-mine-add, deleg-mine-drop, deleg-pool-set,
 * deleg-pool-get, deleg-grant-drop, and the invite index's deleg-index-*.
 */
export async function delegateOp(account, op, request) {
  try {
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const storage = account.storage;
    if (op.startsWith('deleg-index-')) return json(await indexOp(account, op, body));
    const internal = {
      'deleg-accept': () => accept(account, body),
      'deleg-session': () => grantSession(account, body),
      'deleg-quit': () => quit(account, body),
      'deleg-mine-add': () => mineAdd(account, body),
      'deleg-mine-drop': () => mineDrop(account, body),
      'deleg-pool-set': () => poolSet(account, body),
      'deleg-pool-get': () => poolGet(account, body),
      'deleg-grant-drop': () => grantDrop(account, body),
    }[op];
    if (internal) {
      if (!(await storage.get('account'))) throw new ApiError(404, 'not_found', 'No such account.');
      return json(await internal());
    }
    const device = await account.authenticate(request);
    if (device.grant) throw new ApiError(403, 'grant_forbidden', 'As a delegate you can’t do that.');
    switch (op) {
      case 'deleg-list': return json({ delegates: await list(account), max: DELEGATES.max });
      case 'deleg-invite': return json(await invite(account, body));
      case 'deleg-update': return json(await update(account, body));
      case 'deleg-revoke': return json(await revoke(account, body));
      case 'deleg-mine': return json({ grants: await mine(account) });
      case 'deleg-erase-info': return json({ delegations: (await records(account)).map((d) => ({ id: d.id, delegate: d.delegate || null, invite_hash: d.status === 'invited' ? d.invite_hash || null : null })) });
      default: throw new ApiError(404, 'not_found', 'No such thing.');
    }
  } catch (error) {
    if (error instanceof ApiError) return error.response();
    throw error;
  }
}

// The invite index: `dinv:<hash>` objects of the ACCOUNTS namespace, never a real account's.
async function indexOp(account, op, body) {
  const storage = account.storage;
  if (await storage.get('account')) throw bad('That is an account, not an invitation.');
  const entry = await storage.get('dinv');
  if (op === 'deleg-index-get') {
    if (!entry || entry.expires <= account.now()) {
      if (entry) await storage.deleteAll();
      throw new ApiError(404, 'not_found', 'That invitation isn’t one we know, or it ran out. Ask for a new one.');
    }
    return { account: entry.account, id: entry.id };
  }
  if (op === 'deleg-index-claim') {
    if (entry && entry.expires > account.now()) throw new ApiError(409, 'taken', 'That code is taken.');
    if (!validAccountId(body.account) || typeof body.id !== 'string') throw bad('account and id are required');
    const expires = account.now() + DELEGATES.inviteDays * 86400_000;
    await storage.put('dinv', { account: body.account, id: body.id, expires });
    if (storage.setAlarm) await storage.setAlarm(expires + 1000);
    return {};
  }
  if (op === 'deleg-index-drop') {
    if (entry && entry.account === body.account) await storage.deleteAll();
    return {};
  }
  throw new ApiError(404, 'not_found', 'No such thing.');
}

async function records(account) {
  return [...(await account.storage.list({ prefix: 'dlg:' })).values()].sort((a, b) => a.created - b.created);
}

async function list(account) {
  const now = account.now();
  const out = [];
  for (const d of await records(account)) {
    const p = await pool(account, `pool:dlg:${d.id}`);
    const status = d.status === 'invited' ? (d.invite_expires <= now ? 'invite_expired' : 'invited') : d.expires <= now ? 'expired' : 'active';
    out.push({ id: d.id, name: d.name, from: d.from, features: d.features, cap_usd: d.cap_usd, spent_usd: round(p.spent), expires: d.expires, status, created: d.created, accepted: d.accepted || null });
  }
  return out;
}

async function invite(account, { name, from, cap_usd, features: f, days: d }) {
  const all = await records(account);
  if (all.length >= DELEGATES.max) throw new ApiError(409, 'too_many', `An account has at most ${DELEGATES.max} delegates. Remove one first.`);
  const now = account.now();
  const id = [...randomBytes(6)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const code = newInviteCode();
  const record = {
    id,
    name: cleanName(name, 'Delegate').slice(0, 40),
    from: cleanName(from, 'the account’s owner').slice(0, 40),
    features: features(f),
    cap_usd: cap(cap_usd ?? 5),
    expires: now + days(d ?? 30) * 86400_000,
    status: 'invited',
    invite_hash: await sha256Hex(code),
    invite_expires: now + DELEGATES.inviteDays * 86400_000,
    created: now,
    delegate: null,
  };
  await account.storage.put({ [`dlg:${id}`]: record, [`pool:dlg:${id}`]: { cap: record.cap_usd, month: month(now), spent: 0, by: {} } });
  return { delegate: (await list(account)).find((x) => x.id === id), code };
}

async function update(account, { id, cap_usd, features: f, days: d }) {
  const record = await account.storage.get(`dlg:${String(id)}`);
  if (!record) throw new ApiError(404, 'not_found', 'That delegate is gone.');
  if (cap_usd !== undefined) record.cap_usd = cap(cap_usd);
  if (f !== undefined) record.features = features(f);
  if (d !== undefined) record.expires = account.now() + days(d) * 86400_000;
  const p = await pool(account, `pool:dlg:${record.id}`);
  p.cap = record.cap_usd;
  await account.storage.put({ [`dlg:${record.id}`]: record, [`pool:dlg:${record.id}`]: p });
  // Its open sessions take the new limits at once.
  for (const dev of await account.devices()) {
    if (dev.grant && dev.grant.type === 'delegate' && dev.grant.id === record.id) {
      dev.grant.features = record.features;
      dev.expires = Math.min(record.expires, dev.expires || record.expires);
      await account.storage.put(`dev:${dev.id}`, dev);
    }
  }
  return (await list(account)).find((x) => x.id === record.id);
}

async function dropDevices(account, test) {
  for (const dev of await account.devices()) {
    if (dev.grant && test(dev.grant)) await account.storage.delete(`dev:${dev.id}`);
  }
}

async function revoke(account, { id }) {
  const record = await account.storage.get(`dlg:${String(id)}`);
  if (!record) throw new ApiError(404, 'not_found', 'That delegate is already gone.');
  await dropDevices(account, (g) => g.type === 'delegate' && g.id === record.id);
  await account.storage.delete([`dlg:${record.id}`, `pool:dlg:${record.id}`]);
  return { id: record.id, delegate: record.delegate, invited: record.status === 'invited', invite_hash: record.invite_hash };
}

async function accept(account, { id, code, delegate }) {
  const record = await account.storage.get(`dlg:${String(id)}`);
  const now = account.now();
  if (!record || record.status !== 'invited' || !sameText(record.invite_hash, await sha256Hex(String(code || '')))) {
    throw new ApiError(404, 'not_found', 'That invitation isn’t one we know, or it was used. Ask for a new one.');
  }
  if (record.invite_expires <= now) throw new ApiError(410, 'expired', 'That invitation ran out. Ask for a new one.');
  if (!validAccountId(delegate)) throw bad('delegate must be an account id');
  if (delegate === (await account.storage.get('account')).id) throw new ApiError(409, 'own_account', 'That’s an invitation to your own account. Send it to the person you want to help you.');
  Object.assign(record, { status: 'active', delegate, accepted: now, invite_hash: null });
  await account.storage.put(`dlg:${record.id}`, record);
  return { id: record.id, from: record.from, name: record.name, features: record.features, cap_usd: record.cap_usd, expires: record.expires };
}

// A device for the person using a grant (`account`): one per grant, made again on each use.
async function grantSession(account, { type, id, account: who, label, features: f, cap: c, member }) {
  const now = account.now();
  let grant;
  let expires = now + DELEGATES.sessionDays * 86400_000;
  if (type === 'delegate') {
    const record = await account.storage.get(`dlg:${String(id)}`);
    if (!record || record.status !== 'active' || record.delegate !== who) throw new ApiError(404, 'not_found', 'That delegated access has ended.');
    if (record.expires <= now) throw new ApiError(410, 'expired', 'That delegated access ran out. Ask the owner to renew it.');
    expires = Math.min(expires, record.expires);
    grant = { type, id: record.id, account: who, features: record.features, label: record.from };
  } else if (type === 'space') {
    if (!/^[A-Za-z0-9_-]{22}$/.test(String(id)) || !validAccountId(who)) throw bad('A space grant needs the space and the member.');
    const p = await pool(account, `pool:spc:${id}`);
    p.cap = cap(c);
    await account.storage.put(`pool:spc:${id}`, p);
    grant = { type, id, account: who, member: String(member || '').slice(0, 16), features: ['chat'], label: cleanName(label, 'Team space').slice(0, 60) };
  } else {
    throw bad('type must be "delegate" or "space".');
  }
  await dropDevices(account, (g) => g.type === grant.type && g.id === grant.id && g.account === who);
  const made = await account.makeDevice((await account.storage.get('account')).id, { name: `${type === 'space' ? 'Space' : 'Delegate'}: ${grant.label}`, kind: 'web', app_version: 'askeden.com (grant)' });
  made.device.grant = grant;
  made.device.expires = expires;
  await account.storage.put(`dev:${made.device.id}`, made.device);
  return { token: made.token, grant: { type: grant.type, id: grant.id, label: grant.label, features: grant.features }, expires };
}

// The delegate gives it up (their side asked): the owner's record goes too.
async function quit(account, { id, account: who }) {
  const record = await account.storage.get(`dlg:${String(id)}`);
  if (!record || record.delegate !== who) return { quit: false };
  await dropDevices(account, (g) => g.type === 'delegate' && g.id === record.id);
  await account.storage.delete([`dlg:${record.id}`, `pool:dlg:${record.id}`]);
  return { quit: true };
}

// What this account may use elsewhere: `grant-in:<type>:<id>` { type, id, owner, label, added }.
async function mine(account) {
  return [...(await account.storage.list({ prefix: 'grant-in:' })).values()].sort((a, b) => a.added - b.added);
}

async function mineAdd(account, { type, id, owner, label }) {
  if (!['delegate', 'space'].includes(type) || typeof id !== 'string' || !id) throw bad('type and id are required');
  if ((await mine(account)).length >= 40) throw new ApiError(409, 'too_many', 'You’re in too many accounts and spaces already.');
  await account.storage.put(`grant-in:${type}:${id}`, { type, id, owner: String(owner || ''), label: cleanName(label, type === 'space' ? 'Team space' : 'An account').slice(0, 60), added: account.now() });
  return {};
}

async function mineDrop(account, { type, id }) {
  await account.storage.delete(`grant-in:${type}:${id}`);
  return {};
}

async function poolSet(account, { type, id, cap: c }) {
  const key = `pool:${type === 'space' ? 'spc' : 'dlg'}:${id}`;
  const p = await pool(account, key);
  p.cap = cap(c);
  await account.storage.put(key, p);
  return { cap: p.cap };
}

async function poolGet(account, { type, id }) {
  const p = await pool(account, `pool:${type === 'space' ? 'spc' : 'dlg'}:${id}`);
  return { cap: p.cap, spent: round(p.spent), by: p.by, month: p.month };
}

// A space member removed, or a space deleted: its sessions here end now.
async function grantDrop(account, { type, id, account: who = null }) {
  await dropDevices(account, (g) => g.type === type && g.id === id && (!who || g.account === who));
  if (!who) await account.storage.delete(`pool:${type === 'space' ? 'spc' : 'dlg'}:${id}`);
  return {};
}

// ── the Worker's side ──

/** One op on an object of the ACCOUNTS namespace; its JSON, or its refusal as an ApiError. */
export async function ask(env, name, op, body = {}, auth = null) {
  const headers = { 'content-type': 'application/json' };
  if (auth) {
    headers['x-jarvis-device'] = auth.device;
    headers['x-jarvis-secret'] = auth.secret;
  }
  const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName(name));
  const response = await stub.fetch(`https://account/${op}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const out = await response.json().catch(() => ({}));
  if (response.status >= 400) {
    const { error, code, ...extra } = out;
    throw new ApiError(response.status, code || 'error', error || 'Something went wrong.', {}, extra);
  }
  return out;
}

export async function slowDown(env, binding, key) {
  const limiter = env[binding];
  if (!limiter) return;
  const { success } = await limiter.limit({ key });
  if (!success) throw new ApiError(429, 'slow_down', 'Too many tries; wait a minute.', { 'retry-after': '60' });
}

export async function readBody(request, max = 64 * 1024) {
  const text = await request.text();
  if (text.length > max) throw new ApiError(413, 'too_big', 'That request is too big.');
  try {
    const value = JSON.parse(text || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // below
  }
  throw bad('Send a JSON object.');
}

const respond = (body, ...setCookies) => {
  const r = json(body);
  for (const c of setCookies) r.headers.append('set-cookie', c);
  return r;
};

// Acting sessions are checked with the owner's account on every request (never cached): a
// revoked delegate stops at once, and never falls back to their own allowance unawares.
/**
 * The acting session (a delegate, a space member) this browser holds beside its own session
 * `own` ({ account, token, device }): { token, account (the owner's), device (with its grant),
 * grant, own }; null when there's none; { ended: true } when its cookie is there but the grant
 * ended (revoked, expired, removed) or isn't this person's.
 */
export async function actingSession(request, env, own) {
  const raw = cookies(request)[ACTING_COOKIE];
  if (!raw || !own) return null;
  const token = parseToken(raw);
  if (!token) return { ended: true };
  try {
    const { account_id: account, device } = await ask(env, token.account, 'whoami', {}, token);
    if (!device.grant || device.grant.account !== own.account) return { ended: true };
    return { token, account, device, grant: device.grant, own: { account: own.account, token: own.token, device: own.device } };
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) return { ended: true };
    throw error;
  }
}

export const ENDED = 'Your delegated access ended, or the space is gone. Switch back to your own account (Account › Switch back).';

/** The acting session's token from its cookie (to end it), or null. */
export const actingToken = (request) => {
  const raw = cookies(request)[ACTING_COOKIE];
  return raw ? parseToken(raw) : null;
};

/** Ends the acting session this browser holds (its device on the owner's account goes). */
export async function endActing(request, env) {
  const token = actingToken(request);
  if (token) await ask(env, token.account, 'device-delete', { id: 'me' }, token).catch(() => {});
  return clearCookie(ACTING_COOKIE);
}

/** Starts acting with a token a grant session made: the cookie that holds it. */
export const actingCookie = (token, expires) => cookie(ACTING_COOKIE, token, { maxAge: Math.max(60, Math.floor((expires - Date.now()) / 1000)) });

/**
 * /api/web/deleg[/<op>] for a signed-in browser. `who` is its own session ({ account, token,
 * device }), never an acting one; `acting` the acting session it holds, if any; `origin` this
 * site, for invitation links.
 */
export async function delegatesApi(request, env, who, op, { acting = null, origin = '' } = {}) {
  await slowDown(env, 'API_RATE', who.account);
  if (!op) {
    if (request.method !== 'GET') throw new ApiError(405, 'bad_request', 'GET it.');
    const [owned, mineList] = await Promise.all([ask(env, who.account, 'deleg-list', {}, who.token), ask(env, who.account, 'deleg-mine', {}, who.token)]);
    return json({ ...owned, mine: mineList.grants, acting: acting ? actingView(acting) : null, features: FEATURES, days: DELEGATES.days, max_cap: DELEGATES.maxCap });
  }
  if (request.method !== 'POST') throw new ApiError(405, 'bad_request', 'POST it.');
  const body = await readBody(request);
  switch (op) {
    case 'invite': {
      await slowDown(env, 'LINK_RATE', `deleg:${who.account}`);
      const made = await ask(env, who.account, 'deleg-invite', body, who.token);
      try {
        await ask(env, `dinv:${await sha256Hex(made.code)}`, 'deleg-index-claim', { account: who.account, id: made.delegate.id });
      } catch (error) {
        await ask(env, who.account, 'deleg-revoke', { id: made.delegate.id }, who.token).catch(() => {});
        throw error;
      }
      return json({ delegate: made.delegate, code: made.code, link: `${origin}/#delegate=${made.code}` });
    }
    case 'update':
      return json({ delegate: await ask(env, who.account, 'deleg-update', body, who.token) });
    case 'revoke': {
      const gone = await ask(env, who.account, 'deleg-revoke', { id: body.id }, who.token);
      if (gone.delegate) await ask(env, gone.delegate, 'deleg-mine-drop', { type: 'delegate', id: `${who.account}.${gone.id}` }).catch(() => {});
      if (gone.invited && gone.invite_hash) await ask(env, `dinv:${gone.invite_hash}`, 'deleg-index-drop', { account: who.account }).catch(() => {});
      return json({ revoked: gone.id });
    }
    case 'accept': {
      await slowDown(env, 'LINK_RATE', `deleg:${who.account}`);
      const code = cleanInviteCode(body.code);
      if (!code) throw new ApiError(404, 'not_found', 'That isn’t an invitation code. It looks like XXXX-XXXX-XXXX.');
      const index = `dinv:${await sha256Hex(code)}`;
      const found = await ask(env, index, 'deleg-index-get');
      if (found.account === who.account) throw new ApiError(409, 'own_account', 'That’s an invitation to your own account. Send it to the person you want to help you.');
      const got = await ask(env, found.account, 'deleg-accept', { id: found.id, code, delegate: who.account });
      await ask(env, who.account, 'deleg-mine-add', { type: 'delegate', id: `${found.account}.${got.id}`, owner: found.account, label: got.from });
      await ask(env, index, 'deleg-index-drop', { account: found.account }).catch(() => {});
      return json({ accepted: { owner: found.account, id: got.id, from: got.from, features: got.features, cap_usd: got.cap_usd, expires: got.expires } });
    }
    case 'use': {
      // body.id: "<owner account>.<delegation id>" as listed in `mine`.
      const [owner, id] = String(body.id || '').split('.');
      if (!validAccountId(owner) || !/^[0-9a-f]{12}$/.test(String(id))) throw new ApiError(404, 'not_found', 'That delegated access isn’t one you have.');
      const made = await ask(env, owner, 'deleg-session', { type: 'delegate', id, account: who.account });
      if (acting) await endActing(request, env);
      return respond({ acting: { type: 'delegate', id, label: made.grant.label, features: made.grant.features, expires: made.expires } }, actingCookie(made.token, made.expires));
    }
    case 'leave':
      return respond({ acting: null }, await endActing(request, env));
    case 'quit': {
      const [owner, id] = String(body.id || '').split('.');
      if (validAccountId(owner)) await ask(env, owner, 'deleg-quit', { id, account: who.account }).catch(() => {});
      await ask(env, who.account, 'deleg-mine-drop', { type: 'delegate', id: String(body.id || '') });
      const cookies = acting && acting.grant.type === 'delegate' && acting.account === owner ? [await endActing(request, env)] : [];
      return respond({ quit: true }, ...cookies);
    }
    default:
      throw new ApiError(404, 'not_found', 'No such thing.');
  }
}

/** What the page shows about an acting session. */
export function actingView(acting) {
  const g = acting.grant;
  return { type: g.type, id: g.id, label: g.label, features: g.features, expires: acting.device.expires || null };
}
