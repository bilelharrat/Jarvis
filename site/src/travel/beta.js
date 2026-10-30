// Eden Travel's private beta: 10–20 real travellers before the public launch. Three parts, all off the shared paths:
//
// 1. Invites. While TRAVEL_BETA = "1", Eden Travel (askedentravel.com, askeden.com/travel and every /api/chat/travel route)
//    opens only for accounts that redeemed an invite, and for the owner (ADMIN_EMAILS). Anyone else signed in gets a calm
//    page, /travel/beta: "Eden Travel is in private beta", a box for an invite code, and a waitlist email form. The
//    waitlist only stores the address: nothing is sent to it, by Eden or anyone else. The owner makes invites on the
//    dashboard (/admin, stats/admin.js's gate): a code for one email or for anyone, with an expiry and a number of uses.
//    An invite link is /travel/beta?code=<code>.
// 2. "Something's wrong": a button in the Travel bar (web/chat/travel-beta.js) sends what happened, an optional picture
//    the person attaches, and what was on screen (view, trip id, day, the last error codes the page saw, its version);
//    the trip's own details only when they tick the box. Kept for the owner, listed on the dashboard as open or done.
//    No third-party service sees any of it.
// 3. Usage counts: how many times each feature was used a day (FEATURES; no content, no place names, no trip ids), as
//    stats.js events (kind 'tfeature', product 'travel', the scrambled user tag stats.js uses everywhere, `tin` carrying
//    the count), drawn on the dashboard.
//
// Where it lives: one global object in the account namespace, BETA (`tbeta:global`, as pay.js's tpayflags:global and
// accuracy.js's tacc:global), refused in a person's own object. Its keys:
//   bc:<code>  an invite          { code, email, note, expires, max_uses, uses, created, by, revoked }
//   bm:<acct>  a member           { account, email, code, at }
//   bw:<email> the waitlist       { email, at, from }
//   bf:<id>    a report           { id, at, account, email, text, context, consent, trip, image, status, done_at, note }
//   bfi:<id>:<n> its picture, base64 in chunks (a stored value holds 128 KiB at most)
//   bfc:<acct>:<day> reports sent that day (REPORTS_A_DAY)
//
//   GET  /travel/beta                 the private-beta page (anyone; ?code= fills the invite box)
//   POST /travel/beta/waitlist        email=…   → the page again, "You're on the list"
//   POST /travel/beta/redeem          code=…    → /travel, or the page with what was wrong
//   GET  /travel/beta/beta.css        its styles
//   GET  /api/chat/travel/beta        → { on, member }
//   POST /api/chat/travel/beta        { action: redeem | feedback | usage, args }
//   GET  /api/admin/travel-beta       → { on, invites, members, waitlist, feedback, usage } (owner only, else 404)
//   POST /api/admin/travel-beta       { action: invite-create | invite-revoke | member-remove | wait-drop | feedback-status, … }
//   GET  /api/admin/travel-beta/image?id=<report> → its picture (owner only)

import { ApiError, json } from '../accounts/util.js';
import { call } from '../accounts/index.js';
// session.js and admin.js are loaded when needed: both reach accounts/account.js, which loads this file's callers first
const adminSession = async (...a) => (await import('../stats/admin.js')).adminSession(...a);
const currentSession = async (...a) => (await import('../eden/session.js')).currentSession(...a);
import { deviceOf, record, schema, userTag } from '../stats/stats.js';
import { ALPHA, ask, slowDown } from './track.js';

export const BETA = 'tbeta:global';
export const betaOn = (env) => String(env?.TRAVEL_BETA || '') === '1';

export const CODE_LEN = 8;
export const INVITE_MAX_DAYS = 90;
export const INVITE_MAX_USES = 50;
export const REPORTS_A_DAY = 20; // per account
export const REPORTS_KEPT = 1000;
export const WAITLIST_MAX = 2000;
export const IMAGE_MAX = 4 * 1024 * 1024; // the picture's own bytes
const CHUNK = 96_000; // base64 characters a stored value
const TRIP_MAX = 40_000; // the trip's details, as JSON, when the person ticked the box
const DAY = 86400_000;

// What the usage counts may name: the page's views and the things people do. Anything else is dropped.
export const FEATURES = new Set([
  'open', 'view:workspace', 'view:board', 'view:map', 'view:companion', 'view:discover', 'view:group', 'view:memories',
  'plan', 'create', 'sample', 'ask', 'edit', 'apply', 'undo', 'day', 'share', 'invite', 'join', 'calendar', 'print', 'pack', 'leg', 'copy',
  'entry', 'papers', 'esim', 'flight', 'flight-track', 'stays-search', 'stays-book', 'rail', 'ground', 'discover', 'nearby',
  'money', 'expense', 'chat', 'decisions', 'photo-add', 'memories', 'film', 'voice', 'offline', 'live-activity', 'accuracy',
  'check-report', 'promise', 'rewards', 'claims', 'loyalty', 'cards', 'mail-import', 'paste', 'activities', 'feedback',
]);
const FEATURE = /^[a-z][a-z0-9:-]{1,39}$/;

const text = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]+/g, ' ').trim().slice(0, n);
const line = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const EMAIL = /^[^\s@<>()",;]{1,64}@[^\s@<>()",;]{1,190}\.[a-z]{2,24}$/i;
const ACCOUNT_ID = /^[0-9a-f-]{8,64}$/i;
const REPORT_ID = /^\d{13}[a-z0-9]{4}$/;
export const normCode = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
export const showCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;
export const newCode = () => [...crypto.getRandomValues(new Uint8Array(CODE_LEN))].map((b) => ALPHA[b % ALPHA.length]).join('');
// time first, then a counter (two in the same millisecond keep their order), then two random characters
let seq = 0;
const newId = (now) => `${String(now).padStart(13, '0')}${(seq++ % 1296).toString(36).padStart(2, '0')}${[...crypto.getRandomValues(new Uint8Array(2))].map((b) => ALPHA[b % ALPHA.length]).join('')}`;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/* ---------- the global object (account.js: op tbeta-*) ---------- */

/** An invite as the dashboard shows it, with whether it can still be used. */
function inviteView(inv, now) {
  const state = inv.revoked ? 'revoked' : inv.expires <= now ? 'expired' : inv.uses >= inv.max_uses ? 'used' : 'open';
  return { ...inv, shown: showCode(inv.code), state };
}

/** The index's ops. `account` is the object (storage, now); a person's own object refuses them. */
export async function betaIndexOp(account, op, body = {}) {
  if (await account.storage.get('account')) throw new ApiError(404, 'not_found', 'Not found');
  const now = account.now();
  const S = account.storage;
  switch (op) {
    case 'tbeta-invite-create': {
      const email = body.email ? line(body.email, 254).toLowerCase() : null;
      if (email && !EMAIL.test(email)) throw new ApiError(400, 'bad_request', 'That email doesn’t look right.');
      const days = Number(body.days ?? 14);
      const uses = Number(body.max_uses ?? 1);
      if (!Number.isInteger(days) || days < 1 || days > INVITE_MAX_DAYS) throw new ApiError(400, 'bad_request', `days: 1 to ${INVITE_MAX_DAYS}.`);
      if (!Number.isInteger(uses) || uses < 1 || uses > INVITE_MAX_USES) throw new ApiError(400, 'bad_request', `max_uses: 1 to ${INVITE_MAX_USES}.`);
      if (email && uses !== 1) throw new ApiError(400, 'bad_request', 'An invite for one email is used once.');
      let code = null;
      for (let i = 0; i < 5 && !code; i++) { const c = newCode(); if (!(await S.get(`bc:${c}`))) code = c; }
      if (!code) throw new ApiError(503, 'unavailable', 'Couldn’t make a code just now. Try again.');
      const inv = { code, email, note: line(body.note, 120) || null, expires: now + days * DAY, max_uses: uses, uses: 0, used_by: [], created: now, by: line(body.by, 40) || null, revoked: false };
      await S.put(`bc:${code}`, inv);
      return { invite: inviteView(inv, now) };
    }
    case 'tbeta-invite-list':
      return { invites: [...(await S.list({ prefix: 'bc:' })).values()].map((i) => inviteView(i, now)).sort((a, b) => b.created - a.created) };
    case 'tbeta-invite-revoke': {
      const key = `bc:${normCode(body.code)}`;
      const inv = await S.get(key);
      if (!inv) throw new ApiError(404, 'not_found', 'No such invite.');
      inv.revoked = true;
      await S.put(key, inv);
      return { invite: inviteView(inv, now) };
    }
    case 'tbeta-redeem': {
      const acc = String(body.account || '');
      if (!ACCOUNT_ID.test(acc)) throw new ApiError(400, 'bad_request', 'account');
      const was = await S.get(`bm:${acc}`);
      if (was) return { ok: true, already: true };
      const code = normCode(body.code);
      const inv = code.length === CODE_LEN ? await S.get(`bc:${code}`) : null;
      if (!inv || inv.revoked) throw new ApiError(404, 'not_found', 'That invite code isn’t one we know. Check it, or ask for a new one.');
      if (inv.expires <= now) throw new ApiError(410, 'expired', 'That invite has expired. Ask for a new one.');
      if (inv.uses >= inv.max_uses) throw new ApiError(410, 'used_up', 'That invite has already been used.');
      const emails = (Array.isArray(body.emails) ? body.emails : []).map((e) => String(e || '').toLowerCase()).filter(Boolean);
      if (inv.email && !emails.includes(inv.email)) throw new ApiError(403, 'other_email', 'That invite is for another email. Sign in with the account it was sent to.');
      inv.uses += 1;
      inv.used_by = [...(inv.used_by || []), { account: acc, at: now }].slice(-INVITE_MAX_USES);
      await S.put(`bc:${code}`, inv);
      await S.put(`bm:${acc}`, { account: acc, email: inv.email || line(emails[0], 254) || null, code, at: now });
      return { ok: true };
    }
    case 'tbeta-member':
      return { member: Boolean(await S.get(`bm:${String(body.account || '')}`)) };
    case 'tbeta-members':
      return { members: [...(await S.list({ prefix: 'bm:' })).values()].sort((a, b) => a.at - b.at) };
    case 'tbeta-member-remove': {
      const acc = String(body.account || '');
      if (!ACCOUNT_ID.test(acc)) throw new ApiError(400, 'bad_request', 'account');
      await S.delete(`bm:${acc}`);
      return { removed: true };
    }
    case 'tbeta-wait': {
      const email = line(body.email, 254).toLowerCase();
      if (!EMAIL.test(email)) throw new ApiError(400, 'bad_request', 'That email doesn’t look right.');
      if (await S.get(`bw:${email}`)) return { ok: true, already: true };
      if ((await S.list({ prefix: 'bw:', limit: WAITLIST_MAX + 1 })).size >= WAITLIST_MAX) throw new ApiError(503, 'full', 'The waitlist is full for now.');
      await S.put(`bw:${email}`, { email, at: now, from: line(body.from, 60) || null });
      return { ok: true };
    }
    case 'tbeta-waitlist':
      return { waitlist: [...(await S.list({ prefix: 'bw:' })).values()].sort((a, b) => a.at - b.at) };
    case 'tbeta-wait-drop':
      await S.delete(`bw:${line(body.email, 254).toLowerCase()}`);
      return { dropped: true };
    case 'tbeta-feedback-add': return feedbackAdd(account, body, now);
    case 'tbeta-feedback-list': {
      const list = [...(await S.list({ prefix: 'bf:' })).values()].sort((a, b) => b.at - a.at || (b.id < a.id ? -1 : 1)); // newest first; the same millisecond by id (its counter keeps the order)
      return { feedback: list };
    }
    case 'tbeta-feedback-image': {
      const id = String(body.id || '');
      const rep = REPORT_ID.test(id) ? await S.get(`bf:${id}`) : null;
      if (!rep || !rep.image) throw new ApiError(404, 'not_found', 'No picture.');
      const parts = await S.list({ prefix: `bfi:${id}:` });
      const data = [...parts.keys()].sort((a, b) => Number(a.split(':')[2]) - Number(b.split(':')[2])).map((k) => parts.get(k)).join('');
      return { type: rep.image.type, data };
    }
    case 'tbeta-feedback-status': {
      const id = String(body.id || '');
      const rep = REPORT_ID.test(id) ? await S.get(`bf:${id}`) : null;
      if (!rep) throw new ApiError(404, 'not_found', 'No such report.');
      if (!['open', 'done'].includes(body.status)) throw new ApiError(400, 'bad_request', 'status: open or done.');
      rep.status = body.status;
      rep.done_at = body.status === 'done' ? now : null;
      if (body.note !== undefined) rep.note = text(body.note, 500) || null;
      await S.put(`bf:${id}`, rep);
      return { report: rep };
    }
    default:
      throw new ApiError(404, 'not_found', 'Not found');
  }
}

/** A picture's type, from its first bytes (never the name or the type the browser claims). */
export function imageType(bytes) {
  const b = bytes;
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp';
  if (b.length > 12 && String.fromCharCode(...b.slice(4, 8)) === 'ftyp' && /^(heic|heix|mif1|msf1|heim|heis)$/.test(String.fromCharCode(...b.slice(8, 12)))) return 'image/heic';
  return null;
}

/** What was on screen, checked field by field: nothing the page sends lands as is. */
export function cleanContext(c = {}) {
  const o = c && typeof c === 'object' && !Array.isArray(c) ? c : {};
  const day = Number(o.day);
  return {
    view: /^[a-z:-]{1,24}$/.test(String(o.view || '')) ? String(o.view) : null,
    trip: /^[0-9a-f]{16}$/.test(String(o.trip || '')) ? String(o.trip) : null,
    shared: Boolean(o.shared),
    day: Number.isInteger(day) && day >= 0 && day < 120 ? day : null,
    errors: (Array.isArray(o.errors) ? o.errors : []).slice(-10).map((e) => line(e, 160)).filter(Boolean),
    version: line(o.version, 60) || null,
    host: /^[a-z0-9.-]{1,80}$/i.test(String(o.host || '')) ? String(o.host).toLowerCase() : null,
    path: /^\/[\w./-]{0,79}$/.test(String(o.path || '')) ? String(o.path) : null,
    standalone: Boolean(o.standalone),
    offline: Boolean(o.offline),
    viewport: /^\d{2,5}x\d{2,5}$/.test(String(o.viewport || '')) ? String(o.viewport) : null,
  };
}

async function feedbackAdd(account, body, now) {
  const S = account.storage;
  const acc = String(body.account || '');
  if (!ACCOUNT_ID.test(acc)) throw new ApiError(400, 'bad_request', 'account');
  const what = text(body.text, 4000);
  if (what.length < 3) throw new ApiError(400, 'bad_request', 'Say what happened, in a few words.');
  const countKey = `bfc:${acc}:${dayOf(now)}`;
  const sent = (await S.get(countKey)) || 0;
  if (sent >= REPORTS_A_DAY) throw new ApiError(429, 'slow_down', `That’s ${REPORTS_A_DAY} reports today. Thank you; send more tomorrow.`);
  let image = null;
  if (body.image && typeof body.image === 'object') {
    const data = String(body.image.data || '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length > Math.ceil(IMAGE_MAX / 3) * 4) throw new ApiError(413, 'too_large', 'The picture can be 4 MB at most.');
    const head = Uint8Array.from(atob(data.slice(0, 24)), (ch) => ch.charCodeAt(0));
    const type = imageType(head);
    if (!type) throw new ApiError(415, 'bad_type', 'Attach a JPEG, PNG, WebP or HEIC picture.');
    image = { type, bytes: Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0), data };
  }
  let trip = null;
  if (body.consent === true && body.trip && typeof body.trip === 'object') {
    const s = JSON.stringify(body.trip);
    if (s.length > TRIP_MAX) throw new ApiError(413, 'too_large', 'The trip’s details are too long to send.');
    trip = JSON.parse(s);
  }
  const id = newId(now);
  const rep = {
    id, at: now, account: acc, email: body.email ? line(body.email, 254) : null, device: line(body.device, 16) || null,
    text: what, context: cleanContext(body.context), consent: body.consent === true, trip,
    image: image ? { type: image.type, bytes: image.bytes } : null, status: 'open', done_at: null, note: null,
  };
  if (image) {
    for (let i = 0, n = 0; i < image.data.length; i += CHUNK, n++) await S.put(`bfi:${id}:${n}`, image.data.slice(i, i + CHUNK));
  }
  await S.put(`bf:${id}`, rep);
  await S.put(countKey, sent + 1);
  // the oldest done reports go first past REPORTS_KEPT; open ones are never dropped
  const all = await S.list({ prefix: 'bf:' });
  if (all.size > REPORTS_KEPT) {
    const done = [...all.values()].filter((r) => r.status === 'done').sort((a, b) => a.at - b.at).slice(0, all.size - REPORTS_KEPT);
    for (const r of done) { await S.delete(`bf:${r.id}`); for (const k of (await S.list({ prefix: `bfi:${r.id}:` })).keys()) await S.delete(k); }
  }
  return { id };
}

/* ---------- the Worker's side ---------- */

export const askBeta = (env, op, body = {}) => ask(env, BETA, op, body);

// membership, per isolate: a yes for 5 minutes, a no for 20 seconds (so a fresh invite works at once on a retry)
const members = new Map();
export async function isMember(env, accountId, { askIndex = askBeta } = {}) {
  const hit = members.get(accountId);
  if (hit && hit.until > Date.now()) return hit.member;
  const { member } = await askIndex(env, 'tbeta-member', { account: accountId });
  members.set(accountId, { member, until: Date.now() + (member ? 300_000 : 20_000) });
  if (members.size > 2000) members.delete(members.keys().next().value);
  return member;
}
export const forgetMember = (accountId) => (accountId ? members.delete(accountId) : members.clear());

/** Whether this signed-in person may use Eden Travel now: beta off, a member, or the owner. */
export async function mayUse(request, env, accountId, deps = {}) {
  if (!betaOn(env)) return true;
  if (await isMember(env, accountId, deps)) return true;
  return Boolean(await (deps.owner || adminSession)(request, env));
}

/** At the top of travelApi (api.js) and of every /api/chat/travel… route: refused while the person has no invite. */
export async function betaGuard(request, env, who, deps = {}) {
  if (!betaOn(env) || !who || !who.account) return;
  if (await mayUse(request, env, who.account, deps)) return;
  throw new ApiError(403, 'beta_invite', 'Eden Travel is in private beta. Ask for an invite.', {}, { beta: true });
}

/** /travel and askedentravel.com's front (pages.js), signed in: the beta page for someone without an invite, else null. */
export async function travelGate(request, env, session, deps = {}) {
  if (!betaOn(env) || !session) return null;
  if (await mayUse(request, env, session.account, deps)) return null;
  return betaHtml(request, env, { code: new URL(request.url).searchParams.get('code') || '', signedIn: true });
}

/** The person's sign-in emails (Settings › Account), to match an invite made for one. */
async function emailsOf(env, who, deps) {
  const view = await (deps.call || call)(env, who.account, 'get', {}, who.token);
  return (view.identities || []).map((i) => String(i.email || '').toLowerCase()).filter(Boolean);
}

/** GET/POST /api/chat/travel/beta, signed in (eden/chat.js beside travelApi). */
export async function betaApi(request, env, who, { limited, readBody, ...deps } = {}) {
  if (request.method === 'GET') {
    const on = betaOn(env);
    return json({ on, member: on ? await mayUse(request, env, who.account, deps) : true });
  }
  if (request.method !== 'POST') throw new ApiError(405, 'bad_request', 'GET or POST');
  const body = await readBody(request, 6 * 1024 * 1024); // a picture comes as base64 (IMAGE_MAX)
  const args = body.args !== null && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
  const askIndex = deps.askIndex || askBeta;
  if (body.action === 'redeem') {
    await limited(env, 'USER_RATE', `tbeta:${who.account}`);
    const out = await askIndex(env, 'tbeta-redeem', { account: who.account, code: args.code, emails: await emailsOf(env, who, deps) });
    forgetMember(who.account);
    return json(out);
  }
  if (body.action === 'feedback') {
    if (!(await mayUse(request, env, who.account, { ...deps, askIndex }))) throw new ApiError(403, 'beta_invite', 'Eden Travel is in private beta. Ask for an invite.');
    await limited(env, 'USER_RATE', `tbeta:${who.account}`);
    const emails = await emailsOf(env, who, deps).catch(() => []);
    return json(await askIndex(env, 'tbeta-feedback-add', {
      account: who.account, email: emails[0] || null, device: deviceOf(request.headers.get('user-agent')),
      text: args.text, context: args.context, consent: args.consent === true, trip: args.consent === true ? args.trip : null, image: args.image || null,
    }));
  }
  if (body.action === 'usage') return json(await usage(env, who, args.counts, { device: deviceOf(request.headers.get('user-agent')), record: deps.record }));
  throw new ApiError(400, 'bad_request', 'action must be redeem, feedback or usage.');
}

/** Feature counts from the page (at most once a minute), as stats.js events: the feature, how many, the day. */
export async function usage(env, who, counts, { device = null, record: write = record } = {}) {
  const c = counts && typeof counts === 'object' && !Array.isArray(counts) ? counts : {};
  const rows = Object.entries(c).filter(([k, n]) => FEATURE.test(k) && FEATURES.has(k) && Number.isInteger(n) && n > 0).slice(0, 40);
  if (!rows.length) return { counted: 0 };
  const user = await userTag(env, who.account);
  for (const [name, n] of rows) await write(env, { kind: 'tfeature', name, user, product: 'travel', tin: Math.min(n, 200), device });
  return { counted: rows.length };
}

/** The dashboard's usage chart: the last 30 days by feature and by day (stats.js's table). */
export async function betaUsage(env, { days = 30 } = {}) {
  if (!env.STATS) return { ready: false };
  await schema(env);
  const since = Date.now() - days * DAY;
  const [byFeature, byDay] = await env.STATS.batch([
    env.STATS.prepare(`SELECT name, SUM(COALESCE(tin,1)) AS n, COUNT(DISTINCT user) AS people FROM events WHERE kind = 'tfeature' AND ts >= ? GROUP BY name ORDER BY n DESC`).bind(since),
    env.STATS.prepare(`SELECT CAST(ts / 86400000 AS INTEGER) AS day, SUM(COALESCE(tin,1)) AS n, COUNT(DISTINCT user) AS people FROM events WHERE kind = 'tfeature' AND ts >= ? GROUP BY day ORDER BY day`).bind(since),
  ]);
  return { ready: true, by_feature: byFeature.results || [], by_day: (byDay.results || []).map((d) => ({ ...d, day: d.day * DAY })) };
}

/* ---------- the owner's dashboard ---------- */

const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

/** /api/admin/travel-beta and …/image. 404 for anyone but the owner. */
export async function adminTravelBeta(request, env, path = new URL(request.url).pathname, deps = {}) {
  const session = await (deps.owner || adminSession)(request, env);
  if (!session) return notFound();
  const askIndex = deps.askIndex || askBeta;
  try {
    if (path === '/api/admin/travel-beta/image') {
      const got = await askIndex(env, 'tbeta-feedback-image', { id: new URL(request.url).searchParams.get('id') || '' });
      const bytes = Uint8Array.from(atob(got.data), (ch) => ch.charCodeAt(0));
      return new Response(bytes, { headers: { 'content-type': got.type, 'content-disposition': 'inline', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
    }
    if (request.method === 'GET') {
      const [invites, mem, wait, fb, use] = await Promise.all([
        askIndex(env, 'tbeta-invite-list'), askIndex(env, 'tbeta-members'), askIndex(env, 'tbeta-waitlist'), askIndex(env, 'tbeta-feedback-list'),
        (deps.usage || betaUsage)(env).catch((e) => ({ ready: false, error: String(e && e.message).slice(0, 200) })),
      ]);
      return json({ on: betaOn(env), link: inviteBase(env, request), invites: invites.invites, members: mem.members, waitlist: wait.waitlist, feedback: fb.feedback, usage: use });
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const body = await request.json().catch(() => ({}));
    const by = `owner (${String(session.account || '').slice(0, 8)})`;
    switch (body.action) {
      case 'invite-create': {
        const out = await askIndex(env, 'tbeta-invite-create', { email: body.email || null, days: body.days, max_uses: body.max_uses, note: body.note, by });
        return json({ ...out, url: `${inviteBase(env, request)}?code=${out.invite.code}` });
      }
      case 'invite-revoke': return json(await askIndex(env, 'tbeta-invite-revoke', { code: body.code }));
      case 'member-remove': { const out = await askIndex(env, 'tbeta-member-remove', { account: body.account }); forgetMember(String(body.account || '')); return json(out); }
      case 'wait-drop': return json(await askIndex(env, 'tbeta-wait-drop', { email: body.email }));
      case 'feedback-status': return json(await askIndex(env, 'tbeta-feedback-status', { id: body.id, status: body.status, note: body.note }));
      default: return json({ error: 'action' }, 400);
    }
  } catch (e) {
    if (e instanceof ApiError) return e.response();
    return json({ error: String((e && e.message) || 'Failed').slice(0, 200) }, 502);
  }
}

/** Where an invite link points: the travel address when it's live, else askeden.com. */
function inviteBase(env, request) {
  const host = String(env.TRAVEL_HOST || '').toLowerCase();
  return host ? `https://${host}/travel/beta` : `${new URL(request.url).origin}/travel/beta`;
}

/* ---------- the private-beta page (no script: two plain forms) ---------- */

export const BETA_CSP = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const BETA_HEADERS = { 'content-security-policy': BETA_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'private, no-store' };

const WORDS = {
  en: {
    title: 'Eden Travel is in private beta', lede: 'A small group of travellers is trying it before it opens to everyone. If you have an invite, enter its code. If not, leave your email and we’ll keep a place for you.',
    code: 'Invite code', use: 'Use invite', signin: 'Sign in to use an invite', email: 'Your email', wait: 'Join the waitlist',
    waitNote: 'We only keep your address for the invite. Nothing is sent to it now, and nobody else sees it.',
    onList: 'You’re on the list. Thank you.', badEmail: 'That email doesn’t look right.', home: 'Back to Eden',
  },
  fr: {
    title: 'Eden Travel est en bêta privée', lede: 'Un petit groupe de voyageurs l’essaie avant son ouverture à tous. Si vous avez une invitation, saisissez son code. Sinon, laissez votre e-mail et nous vous garderons une place.',
    code: 'Code d’invitation', use: 'Utiliser l’invitation', signin: 'Connectez-vous pour utiliser une invitation', email: 'Votre e-mail', wait: 'Rejoindre la liste d’attente',
    waitNote: 'Nous gardons votre adresse uniquement pour l’invitation. Rien ne vous est envoyé maintenant, et personne d’autre ne la voit.',
    onList: 'Vous êtes sur la liste. Merci.', badEmail: 'Cet e-mail ne semble pas correct.', home: 'Retour à Eden',
  },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const langOf = (request) => (/^fr\b/i.test(request.headers.get('accept-language') || '') ? 'fr' : 'en');

/** The page itself. `note`: a line under the title (what happened); `bad`: it's an error. */
export function betaHtml(request, env, { code = '', signedIn = false, note = '', bad = false, status = 200 } = {}) {
  const lang = langOf(request);
  const w = WORDS[lang];
  const shown = normCode(code).length === CODE_LEN ? showCode(normCode(code)) : '';
  const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex, nofollow">
<title>${esc(w.title)}</title>
<link rel="stylesheet" href="/travel/beta/beta.css">
</head>
<body>
<main class="b-card">
<img class="b-logo" src="/jarvis/eden-logo.svg" alt="" width="40" height="40">
<h1>${esc(w.title)}</h1>
<p class="b-lede">${esc(w.lede)}</p>
${note ? `<p class="b-note${bad ? ' b-bad' : ''}" role="${bad ? 'alert' : 'status'}">${esc(note)}</p>` : ''}
${signedIn ? `<form class="b-form" method="post" action="/travel/beta/redeem">
<label for="code">${esc(w.code)}</label>
<div class="b-row"><input id="code" name="code" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="24" required value="${esc(shown)}" placeholder="abcd-efgh"><button type="submit">${esc(w.use)}</button></div>
</form>` : `<p><a class="b-btn" href="/signin?return=${encodeURIComponent(`/travel/beta${shown ? `?code=${normCode(code)}` : ''}`)}">${esc(w.signin)}</a></p>`}
<form class="b-form" method="post" action="/travel/beta/waitlist">
<label for="email">${esc(w.email)}</label>
<div class="b-row"><input id="email" name="email" type="email" autocomplete="email" maxlength="254" required><button type="submit">${esc(w.wait)}</button></div>
<p class="b-fine">${esc(w.waitNote)}</p>
</form>
<p class="b-fine"><a href="https://askeden.com/">${esc(w.home)}</a></p>
</main>
</body>
</html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...BETA_HEADERS } });
}

export const BETA_CSS = `:root{--bg:#f6f4ef;--card:#fff;--text:#1d1d1f;--text2:#5c5c62;--line:rgba(0,0,0,.12);--accent:#0a66d9;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#0b111b;--card:#141b27;--text:#f2f2f5;--text2:#a8acb6;--line:rgba(255,255,255,.14);--accent:#5aa2ff;--bad:#ff8a80}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,"SF Pro Text",system-ui,sans-serif}
.b-card{width:min(520px,100%);background:var(--card);border:1px solid var(--line);border-radius:20px;padding:28px 24px;display:flex;flex-direction:column;gap:14px}
.b-logo{width:40px;height:40px}
h1{margin:0;font:700 26px/1.2 -apple-system,"SF Pro Display",system-ui,sans-serif}
p{margin:0}.b-lede{color:var(--text2)}
.b-note{padding:10px 12px;border-radius:12px;background:rgba(10,102,217,.1)}.b-bad{background:rgba(179,38,30,.1);color:var(--bad)}
.b-form{display:flex;flex-direction:column;gap:6px;padding-top:6px;border-top:1px solid var(--line)}
label{font-weight:600;font-size:14px}
.b-row{display:flex;gap:8px;flex-wrap:wrap}
input{flex:1 1 200px;min-height:44px;padding:0 12px;border:1px solid var(--line);border-radius:12px;background:transparent;color:inherit;font:inherit}
button,.b-btn{min-height:44px;padding:0 16px;border:0;border-radius:999px;background:var(--accent);color:#fff;font:600 15px/44px inherit;text-decoration:none;display:inline-block;cursor:pointer}
a{color:var(--accent)}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.b-fine{font-size:13px;color:var(--text2)}
`;

/** /travel/beta…: the page, its styles and its two forms. null: not ours. (worker.js routes it before the GET-only rule.) */
export async function betaPage(request, env, path, deps = {}) {
  if (path !== '/travel/beta' && !path.startsWith('/travel/beta/')) return null;
  if (!betaOn(env) && path !== '/travel/beta/beta.css') return Response.redirect(new URL('/travel', request.url).toString(), 302);
  if (path === '/travel/beta/beta.css') return new Response(BETA_CSS, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' } });
  const { session } = await (deps.currentSession || currentSession)(request, env);
  const askIndex = deps.askIndex || askBeta;
  if (path === '/travel/beta') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET' } });
    const code = new URL(request.url).searchParams.get('code') || '';
    if (session && (await mayUse(request, env, session.account, { ...deps, askIndex }))) return Response.redirect(new URL('/travel', request.url).toString(), 302);
    return betaHtml(request, env, { code, signedIn: Boolean(session) });
  }
  if (request.method !== 'POST' || !['/travel/beta/waitlist', '/travel/beta/redeem'].includes(path)) return new Response('Not found', { status: 404 });
  // a form from this very page only
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return new Response('Forbidden', { status: 403 });
  const form = await request.formData().catch(() => null);
  const field = (k) => (form ? String(form.get(k) || '') : '');
  const w = WORDS[langOf(request)];
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  try {
    if (path === '/travel/beta/waitlist') {
      await (deps.slowDown || slowDown)(env, 'API_RATE', `tbeta-wait:${ip}`);
      const email = line(field('email'), 254);
      if (!EMAIL.test(email)) return betaHtml(request, env, { signedIn: Boolean(session), note: w.badEmail, bad: true, status: 400 });
      await askIndex(env, 'tbeta-wait', { email, from: new URL(request.url).hostname });
      return betaHtml(request, env, { signedIn: Boolean(session), note: w.onList });
    }
    if (!session) return Response.redirect(new URL('/signin?return=%2Ftravel%2Fbeta', request.url).toString(), 303);
    await (deps.slowDown || slowDown)(env, 'API_RATE', `tbeta-code:${ip}`);
    const emails = await emailsOf(env, { account: session.account, token: session.token }, deps).catch(() => []);
    await askIndex(env, 'tbeta-redeem', { account: session.account, code: field('code'), emails });
    forgetMember(session.account);
    return Response.redirect(new URL('/travel', request.url).toString(), 303);
  } catch (e) {
    if (e instanceof ApiError) return betaHtml(request, env, { code: field('code'), signedIn: Boolean(session), note: e.message, bad: true, status: e.status === 429 ? 429 : 400 });
    throw e;
  }
}
