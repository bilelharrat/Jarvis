// Shared chats (askeden ROADMAP Q3): a read-only link to messages an Eden owner picked from one of
// their chats, at askeden.com/s/<id>#<key>. Eden's chats are end-to-end encrypted (H1), so a share
// is a separate snapshot the owner makes on purpose, encrypted in their browser with a fresh key
// that lives only in the link's #fragment (browsers never send it). This Worker stores and serves
// ciphertext it can't read; revoking deletes it, which kills every copy of the link. The design and
// its tradeoffs are written down in askeden's web/chat/share-model.js. The Mac's server has the
// same routes (askeden src/chat/shares.ts).
//
// Where it lives: like published pages (published.js): the share (its ciphertext in pieces, when it
// was made, when it expires) in the owner's account object; to find the account from the link
// alone, an object of its own named `shr:<id>` holds `{ account }` and nothing else.
//
//   account object (as one of its devices)   share-put, share-list, share-delete
//   account object (the Worker, for /s/)     share-read → { blob, created, expires }
//   `shr:<id>` object                        share-index-claim { account }, share-index-get, share-index-drop { account }
//
// The Worker's side (hosted Eden, eden/chat.js and eden/pages.js call these):
//   POST /api/chat/share          { blob, expires } → { id, url: "/s/<id>", created, expires, bytes }
//   GET  /api/chat/shares         → { shares: [share], max }
//   POST /api/chat/shares/revoke  { id } → { id, revoked: true }
//   GET  /s/<id>                  the read-only page (Eden's share.html): anyone, no sign-in, noindex
//   GET  /s/<id>/data             { blob, created, expires }, or 404 when revoked, expired or unknown
//   GET  /s/<file>                the page's own script and styles (SHARED_FILES), anyone
//
// This module imports nothing from accounts/index.js or eden/session.js (they import the account
// object, which imports this).

import { ApiError, b64url, json, randomBytes, sameText, sha256 } from './util.js';
import { page as pageHeaders, withHeaders } from '../eden/web.js';
import { deckRoomSeats } from '../eden/deck-room.js'; // Eden Slides editing together: a share's deck room follows its seats

export const SHARED = { max: 100, blobChars: 3_000_000, chunk: 60_000, maxAgeMs: 366 * 864e5, collaborators: 20, replies: 100, replyChars: 60_000 };
const ID = /^[A-Za-z0-9_-]{22}$/;
const SEAT_ID = /^[A-Za-z0-9_-]{8,16}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{22,43}$/;
const HASH_RE = /^[A-Za-z0-9_-]{43}$/;
export const newSharedId = () => b64url(randomBytes(16));
export const validSharedId = (id) => ID.test(String(id));

// The read-only page: its own script and stylesheet from here, its data from here, nothing else; never framed.
export const SHARED_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// What /s/ may serve of Eden's files (share.html's modules and their imports; askeden's
// src/__tests__/share.test.ts checks the list against the imports). Public: no secrets in them.
export const SHARED_FILES = new Set(['share.css', 'share-view.js', 'app-lock.js', 'share-render.js', 'share-model.js', 'markdown.js', 'util.js', 'md-plain.js', 'privacy-rules.js', 'i18n.js', 'i18n-fr.js']);
const NOINDEX = { 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' };

const view = (h) => ({
  id: h.id,
  url: `/s/${h.id}`,
  created: h.created,
  expires: h.expires ?? null,
  bytes: h.bytes,
  ...(h.mode === 'collaborate' ? { mode: 'collaborate' } : {}),
  ...(h.access === 'seat' ? { access: 'seat' } : {}),
  ...(h.replyList && h.replyList.length ? { replies: h.replyList.length } : {}),
});

const hashToken = async (token) => b64url(await sha256(String(token)));

// A seat is one link with its own token. Roles: viewer, commenter (comments and replies, no edits), collaborator.
// `expires` ends that link alone; `people`: only the first Eden account that opens it may use it (`account` once
// claimed; the owner can't set it). The Mac's twin (askeden src/chat/shares.ts seatAccess) has the same rules.
export const SEAT_ROLES = ['viewer', 'commenter', 'collaborator'];
async function checkSeats(raw, now = Date.now(), prev = []) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ApiError(400, 'bad_request', 'collaborators must be an array.');
  if (raw.length > SHARED.collaborators) throw new ApiError(400, 'bad_request', `A shared chat can have at most ${SHARED.collaborators} collaborators.`);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object') throw new ApiError(400, 'bad_request', 'Invalid collaborator seat.');
    const id = typeof item.id === 'string' && SEAT_ID.test(item.id) ? item.id : '';
    const role = SEAT_ROLES.includes(item.role) ? item.role : '';
    const tokenHash = typeof item.tokenHash === 'string' && HASH_RE.test(item.tokenHash)
      ? item.tokenHash
      : typeof item.token === 'string' && TOKEN_RE.test(item.token)
        ? await hashToken(item.token)
        : '';
    if (!id || !role || !tokenHash || seen.has(id)) throw new ApiError(400, 'bad_request', 'Invalid collaborator seat.');
    seen.add(id);
    const old = prev.find((p) => p.id === id && p.tokenHash === tokenHash);
    let expires = null;
    if (item.expires !== undefined && item.expires !== null && item.expires !== 0) {
      // a seat sent back unchanged keeps its time even once it has passed; a new time must be in the coming year
      if (typeof item.expires !== 'number' || !Number.isFinite(item.expires) || item.expires > now + SHARED.maxAgeMs || (item.expires <= now && !(old && old.expires === item.expires))) throw new ApiError(400, 'bad_request', 'A link’s expiry must be a time within a year.');
      expires = Math.floor(item.expires);
    }
    const people = item.people === true;
    const label = typeof item.label === 'string' ? item.label.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) : '';
    out.push({ id, role, tokenHash, ...(expires ? { expires } : {}), ...(people ? { people: true } : {}), ...(people && old && old.people && old.account ? { account: old.account } : {}), ...(label ? { label } : {}) });
  }
  return out;
}

/**
 * Who a request is for share head `h`: { seat } for a seat's token, { seat: null } for the plain link, or an ApiError
 * (revoked, expired, someone else's invitation, a seat-only share without a seat). `account`: the signed-in Eden
 * account or null. An unclaimed people seat is claimed (`claimed`: the caller saves `h`).
 */
export async function seatAccess(h, token, account, now) {
  const t = typeof token === 'string' ? token : '';
  if (!t) {
    if (h.access === 'seat') throw new ApiError(403, 'forbidden', 'This link only opens with the invitation you were sent.');
    return { seat: null };
  }
  if (!TOKEN_RE.test(t)) throw new ApiError(403, 'forbidden', 'This link was revoked or isn’t valid.');
  const th = await hashToken(t);
  const seat = (h.collaborators || []).find((c) => sameText(c.tokenHash, th));
  if (!seat) throw new ApiError(403, 'forbidden', 'This link was revoked or isn’t valid.');
  if (seat.expires && seat.expires <= now) throw new ApiError(403, 'forbidden', 'This link has expired. Ask for a new one.');
  if (seat.people) {
    if (!account) throw new ApiError(401, 'signed_out', 'Sign in to Eden to open this invitation.');
    if (seat.account && seat.account !== account) throw new ApiError(403, 'forbidden', 'This invitation was opened by another Eden account.');
    if (!seat.account) { seat.account = account; return { seat, claimed: true }; }
  }
  return { seat };
}
export const canReply = (role) => role === 'collaborator' || role === 'commenter';
const liveSeats = (h, now) => (h.collaborators || []).filter((c) => !c.expires || c.expires > now);

/** The page's envelope ({ v: 1, iv, ct } as JSON text): its shape only; it can't be read here. */
function checkBlob(blob) {
  if (typeof blob !== 'string' || !blob) throw new ApiError(400, 'bad_request', 'blob must be the encrypted chat (a JSON string).');
  if (blob.length > SHARED.blobChars) throw new ApiError(413, 'too_big', 'A shared chat is at most about 2 MB. Pick fewer messages.');
  let env = null;
  try { env = JSON.parse(blob); } catch { /* below */ }
  if (!env || typeof env !== 'object' || env.v !== 1 || typeof env.iv !== 'string' || typeof env.ct !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(env.iv) || !/^[A-Za-z0-9_-]+$/.test(env.ct)) {
    throw new ApiError(400, 'bad_request', 'blob must be an encrypted share ({ v: 1, iv, ct }).');
  }
  return blob;
}

function checkExpires(expires, now) {
  if (expires === null || expires === undefined || expires === 0) return null;
  if (typeof expires !== 'number' || !Number.isFinite(expires) || expires <= now || expires > now + SHARED.maxAgeMs) {
    throw new ApiError(400, 'bad_request', 'expires must be null (never) or a time within a year.');
  }
  return Math.floor(expires);
}

// ── the Durable Object's side (account.js dispatches every `share-` op here) ──

export async function sharedChatsOp(account, op, request) {
  try {
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const storage = account.storage;
    if (op.startsWith('share-index-')) {
      if (await storage.get('account')) throw new ApiError(400, 'bad_request', 'That is an account, not a shared chat.');
      const entry = await storage.get('shrindex');
      if (op === 'share-index-get') {
        if (!entry) throw new ApiError(404, 'not_found', 'No such shared chat.');
        return json({ account: entry.account });
      }
      if (op === 'share-index-claim') {
        if (entry) throw new ApiError(409, 'taken', 'That id is taken.');
        if (typeof body.account !== 'string' || !body.account) throw new ApiError(400, 'bad_request', 'account is required');
        await storage.put('shrindex', { account: body.account, at: account.now() });
        return json({});
      }
      if (op === 'share-index-drop') {
        if (entry && entry.account === body.account) await storage.deleteAll();
        return json({});
      }
      throw new ApiError(404, 'not_found', 'No such thing.');
    }
    if (op === 'share-read') return json(await read(account, body.id, body)); // the Worker, for /s/<id>/data
    if (op === 'share-seats') { const h = await head(account, body.id); return json({ mode: h.mode || null, access: h.access || null, expires: h.expires ?? null, seats: (h.collaborators || []).map((c) => ({ id: c.id, role: c.role, tokenHash: c.tokenHash, ...(c.expires ? { expires: c.expires } : {}), ...(c.people ? { people: true } : {}), ...(c.account ? { account: c.account } : {}) })) }); } // the Worker, for a deck room (eden/deck-room.js): no ciphertext
    if (op === 'share-claim') { // the Worker, for a deck room: the first account to open a people seat keeps it
      const h = await head(account, body.id);
      const { seat, claimed } = await seatAccess(h, body.token, typeof body.account === 'string' && body.account ? body.account : null, account.now());
      if (claimed) await account.storage.put(`shrh:${h.id}`, h);
      return json({ seat: seat ? { id: seat.id, role: seat.role, expires: seat.expires ?? null } : null });
    }
    if (op === 'share-reply') return json(await reply(account, body)); // the Worker, for /s/<id>/reply
    await account.authenticate(request);
    if (op === 'share-put') return json(await put(account, body));
    if (op === 'share-update') return json(await update(account, body));
    if (op === 'share-list') return json({ shares: (await heads(account)).map(view), max: SHARED.max });
    if (op === 'share-delete') return json(await remove(account.storage, (await head(account, body.id)).id));
    throw new ApiError(404, 'not_found', 'No such thing.');
  } catch (error) {
    if (error instanceof ApiError) return error.response();
    throw error;
  }
}

/** The live shares (an expired one is deleted on the way, its index left for the Worker's next read to drop). */
async function heads(account) {
  const now = account.now();
  const out = [];
  for (const h of (await account.storage.list({ prefix: 'shrh:' })).values()) {
    if (h.expires && h.expires <= now) await remove(account.storage, h.id);
    else out.push(h);
  }
  return out.sort((a, b) => b.created - a.created);
}

async function head(account, id) {
  const h = validSharedId(id) ? await account.storage.get(`shrh:${id}`) : undefined;
  if (!h) throw new ApiError(404, 'not_found', 'That link isn’t shared (any more).');
  if (h.expires && h.expires <= account.now()) {
    await remove(account.storage, h.id);
    throw new ApiError(404, 'not_found', 'That link isn’t shared (any more).');
  }
  return h;
}

// shrh:<id> → the head, shrc:<id>:<n> → a piece of the ciphertext (the head written last, so a half-written share is never found).
async function put(account, { id, blob, expires, mode, collaborators, access }) {
  if (!validSharedId(id)) throw new ApiError(400, 'bad_request', 'A share id is 22 base64url characters.');
  const text = checkBlob(blob);
  const now = account.now();
  const exp = checkExpires(expires, now);
  const seats = await checkSeats(collaborators, now);
  const storage = account.storage;
  if (await storage.get(`shrh:${id}`)) throw new ApiError(409, 'taken', 'That id is taken.');
  if ((await heads(account)).length >= SHARED.max) throw new ApiError(409, 'too_many', `You have ${SHARED.max} shared links, the most an account keeps. Revoke one first.`);
  const parts = Math.ceil(text.length / SHARED.chunk);
  const entries = [];
  for (let i = 0; i < parts; i++) entries.push([`shrc:${id}:${i}`, text.slice(i * SHARED.chunk, (i + 1) * SHARED.chunk)]);
  const h = {
    id,
    created: now,
    expires: exp,
    bytes: new TextEncoder().encode(text).length,
    parts,
    ...(mode === 'collaborate' ? { mode: 'collaborate' } : {}),
    ...(access === 'seat' ? { access: 'seat' } : {}),
    ...(seats.length ? { collaborators: seats } : {}),
  };
  entries.push([`shrh:${id}`, h]);
  for (let i = 0; i < entries.length; i += 100) await storage.put(Object.fromEntries(entries.slice(i, i + 100)));
  return view(h);
}

async function update(account, { id, blob, mode, collaborators, access }) {
  const h = await head(account, id);
  const storage = account.storage;
  const entries = [];
  if (blob !== undefined) {
    const text = checkBlob(blob);
    const oldParts = h.parts || 0;
    const parts = Math.ceil(text.length / SHARED.chunk);
    for (let i = 0; i < parts; i++) entries.push([`shrc:${h.id}:${i}`, text.slice(i * SHARED.chunk, (i + 1) * SHARED.chunk)]);
    if (oldParts > parts) {
      const dropKeys = Array.from({ length: oldParts - parts }, (_, i) => `shrc:${h.id}:${parts + i}`);
      await storage.delete(dropKeys);
    }
    h.parts = parts;
    h.bytes = new TextEncoder().encode(text).length;
  }
  if (mode !== undefined) {
    if (mode === 'collaborate') h.mode = 'collaborate';
    else delete h.mode;
  }
  if (access !== undefined) {
    if (access === 'seat') h.access = 'seat';
    else delete h.access;
  }
  if (collaborators !== undefined) {
    const seats = await checkSeats(collaborators, account.now(), h.collaborators || []);
    if (seats.length) h.collaborators = seats;
    else delete h.collaborators;
  }
  entries.push([`shrh:${h.id}`, h]);
  for (let i = 0; i < entries.length; i += 100) await storage.put(Object.fromEntries(entries.slice(i, i + 100)));
  return view(h);
}

async function reply(account, { id, blob, token, viewer = null }) {
  const h = await head(account, id);
  const text = checkBlob(blob);
  if (text.length > SHARED.replyChars) throw new ApiError(413, 'too_big', 'That reply is too long.');
  let seatId;
  const { seat } = await seatAccess(h, token, viewer, account.now());
  if (seat) {
    if (!canReply(seat.role)) throw new ApiError(403, 'forbidden', 'This link is view-only and cannot add messages.');
    seatId = seat.id;
  } else if (h.mode !== 'collaborate') {
    throw new ApiError(403, 'forbidden', 'This shared chat is read-only. Ask the owner for a collaborator link.');
  }
  const list = Array.isArray(h.replyList) ? h.replyList : [];
  if (list.length >= SHARED.replies) throw new ApiError(409, 'too_many', `This shared chat already has ${SHARED.replies} collaborator replies.`);
  const item = {
    id: b64url(randomBytes(9)),
    blob: text,
    at: account.now(),
    ...(seatId ? { seat: seatId } : {}),
  };
  h.replyList = [...list, item];
  await account.storage.put(`shrh:${h.id}`, h);
  return { reply: item };
}

async function read(account, id, { token = '', viewer = null } = {}) {
  const h = await head(account, id);
  const now = account.now();
  const { seat: me, claimed } = await seatAccess(h, token, viewer, now);
  if (claimed) await account.storage.put(`shrh:${h.id}`, h);
  const live = liveSeats(h, now);
  const keys = Array.from({ length: h.parts }, (_, i) => `shrc:${h.id}:${i}`);
  let blob = '';
  for (let i = 0; i < keys.length; i += 100) {
    const got = await account.storage.get(keys.slice(i, i + 100));
    for (const key of keys.slice(i, i + 100)) blob += got.get(key) ?? '';
  }
  return {
    blob,
    created: h.created,
    expires: h.expires ?? null,
    ...(h.mode === 'collaborate' ? { mode: 'collaborate' } : {}),
    ...(me ? { me: { id: me.id, role: me.role, ...(me.expires ? { expires: me.expires } : {}) } } : {}),
    // the seats' hashes, so an older page can tell its own role (a seat-only share shows none of them)
    ...(h.access !== 'seat' && live.length ? { seats: live.map((c) => ({ id: c.id, role: c.role, tokenHash: c.tokenHash })) } : {}),
    ...(h.replyList && h.replyList.length ? { replies: h.replyList } : {}),
  };
}

async function remove(storage, id) {
  const h = await storage.get(`shrh:${id}`);
  const keys = [`shrh:${id}`, ...Array.from({ length: (h && h.parts) || 0 }, (_, i) => `shrc:${id}:${i}`)];
  for (let i = 0; i < keys.length; i += 128) await storage.delete(keys.slice(i, i + 128));
  return { id, revoked: true };
}

/** The ids of an account's shares (account deletion drops their `shr:` index objects). */
export async function sharedIds(storage) {
  return [...(await storage.list({ prefix: 'shrh:' })).keys()].map((k) => k.slice(5));
}

// ── the Worker's side ──

async function ask(env, name, op, body = {}, auth = null) {
  const headers = { 'content-type': 'application/json' };
  if (auth) {
    headers['x-jarvis-device'] = auth.device;
    headers['x-jarvis-secret'] = auth.secret;
  }
  const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName(name));
  const response = await stub.fetch(`https://account/${op}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const out = await response.json().catch(() => ({}));
  if (response.status >= 400) throw new ApiError(response.status, out.code || 'error', out.error || 'Something went wrong.');
  return out;
}

async function slowDown(env, key) {
  const limiter = env.API_RATE;
  if (!limiter) return;
  const { success } = await limiter.limit({ key });
  if (!success) throw new ApiError(429, 'slow_down', 'Too many tries; wait a minute.', { 'retry-after': '60' });
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > SHARED.blobChars + 4096) throw new ApiError(413, 'too_big', 'A shared chat is at most about 2 MB. Pick fewer messages.');
  try {
    const value = JSON.parse(text || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // below
  }
  throw new ApiError(400, 'bad_request', 'Send a JSON object.');
}

/** Whether a path is one of the owner's share routes. */
export const sharedRoute = (path) => path === '/api/chat/share' || path === '/api/chat/shares' || path.startsWith('/api/chat/shares/');

/**
 * /api/chat/share and /api/chat/shares* for a signed-in browser (`who` from hosted Eden's gate:
 * { account, token }). Throws ApiError; chat.js turns it into its error shape.
 */
export async function sharedChatsApi(request, env, who, path) {
  const route = `${request.method} ${path}`;
  await slowDown(env, who.account);
  if (route === 'GET /api/chat/shares') return json(await ask(env, who.account, 'share-list', {}, who.token));
  if (request.method !== 'POST') throw new ApiError(405, 'bad_request', 'GET or POST');
  const body = await readBody(request);
  if (route === 'POST /api/chat/share') {
    checkBlob(body.blob);
    let id = newSharedId();
    try {
      await ask(env, `shr:${id}`, 'share-index-claim', { account: who.account });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error;
      id = newSharedId();
      await ask(env, `shr:${id}`, 'share-index-claim', { account: who.account });
    }
    try {
      return json(await ask(env, who.account, 'share-put', { id, blob: body.blob, expires: body.expires ?? null, mode: body.mode, collaborators: body.collaborators, access: body.access }, who.token));
    } catch (error) {
      await ask(env, `shr:${id}`, 'share-index-drop', { account: who.account }).catch(() => {});
      throw error;
    }
  }
  if (route === 'POST /api/chat/shares/update') {
    const updated = await ask(env, who.account, 'share-update', { id: body.id, blob: body.blob, mode: body.mode, collaborators: body.collaborators, access: body.access }, who.token);
    if (env.DECK_ROOMS) await ask(env, who.account, 'share-seats', { id: updated.id }).then((s) => deckRoomSeats(env, updated.id, s.mode === 'collaborate' ? { seats: s.seats } : { close: true })).catch(() => {}); // a removed seat leaves the deck room
    return json(updated);
  }
  if (route === 'POST /api/chat/shares/revoke') {
    const done = await ask(env, who.account, 'share-delete', { id: body.id }, who.token);
    await ask(env, `shr:${done.id}`, 'share-index-drop', { account: who.account }).catch(() => {});
    await deckRoomSeats(env, done.id, { close: true }).catch(() => {}); // a deck room on it closes and forgets everything
    return json(done);
  }
  throw new ApiError(404, 'not_found', 'No such thing.');
}

const asset = (env, request, path) => env.ASSETS.fetch(new Request(new URL(path, request.url), request));
const edenDir = (request) => (/\b(?:EdenApp|EdenEdu)\//.test(request.headers.get('user-agent') || '') && !/\bEdenBeta\//.test(request.headers.get('user-agent') || '') ? '/eden-ios' : '/eden');
const gone = () => withHeaders(json({ error: 'This shared chat isn’t here: it was revoked, it expired, or the link is wrong.', code: 'not_found' }, 404), NOINDEX);

/**
 * GET /s/<id>, /s/<id>/data, POST /s/<id>/reply and GET /s/<file>: anyone (no sign-in). The response, or null when the
 * path isn't one of these.
 */
export async function sharedChatPage(request, env, path, { viewer = async () => null } = {}) {
  const m = /^\/s\/([^/]+)(\/data|\/reply)?\/?$/.exec(path);
  if (!m) return null;
  const [, name, sub] = m;
  if (sub === '/reply') {
    if (request.method !== 'POST') return new Response('POST only', { status: 405, headers: { allow: 'POST' } });
    if (!validSharedId(name) || !env.ACCOUNTS) return gone();
    try {
      await slowDown(env, `s:${request.headers.get('cf-connecting-ip') || 'unknown'}`);
      const body = await readBody(request);
      const { account } = await ask(env, `shr:${name}`, 'share-index-get');
      const out = await ask(env, account, 'share-reply', { id: name, blob: body.blob, token: body.token, viewer: body.token ? await viewer() : null });
      return withHeaders(json(out), NOINDEX);
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 404) return gone();
        return withHeaders(error.response(), NOINDEX);
      }
      throw error;
    }
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('GET only', { status: 405, headers: { allow: 'GET, HEAD' } });
  const dir = edenDir(request);
  if (validSharedId(name)) {
    if (!sub) {
      // The same page whether or not the share exists: it asks for the data and says what happened.
      return withHeaders(pageHeaders(await asset(env, request, `${dir}/share`), SHARED_CSP), NOINDEX);
    }
    if (!env.ACCOUNTS) return gone();
    try {
      await slowDown(env, `s:${request.headers.get('cf-connecting-ip') || 'unknown'}`);
    } catch (error) {
      return error.response();
    }
    try {
      const { account } = await ask(env, `shr:${name}`, 'share-index-get');
      try {
        const token = request.headers.get('x-seat') || '';
        return withHeaders(json(await ask(env, account, 'share-read', { id: name, token, viewer: token ? await viewer() : null })), NOINDEX);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) await ask(env, `shr:${name}`, 'share-index-drop', { account }).catch(() => {}); // expired: its index goes too
        throw error;
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return gone();
      if (error instanceof ApiError) return withHeaders(error.response(), NOINDEX); // a seat that may not (expired, someone else's, sign in)
      throw error;
    }
  }
  if (sub || !SHARED_FILES.has(name)) return null;
  return withHeaders(await asset(env, request, `${dir}/${name}`), { 'cache-control': 'public, no-cache', 'x-content-type-options': 'nosniff' });
}
