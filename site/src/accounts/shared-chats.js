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

import { ApiError, b64url, json, randomBytes } from './util.js';
import { page as pageHeaders, withHeaders } from '../eden/web.js';

export const SHARED = { max: 100, blobChars: 3_000_000, chunk: 60_000, maxAgeMs: 366 * 864e5 };
const ID = /^[A-Za-z0-9_-]{22}$/;
export const newSharedId = () => b64url(randomBytes(16));
export const validSharedId = (id) => ID.test(String(id));

// The read-only page: its own script and stylesheet from here, its data from here, nothing else; never framed.
export const SHARED_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// What /s/ may serve of Eden's files (share.html's modules and their imports; askeden's
// src/__tests__/share.test.ts checks the list against the imports). Public: no secrets in them.
export const SHARED_FILES = new Set(['share.css', 'share-view.js', 'share-render.js', 'share-model.js', 'markdown.js', 'util.js', 'md-plain.js', 'privacy-rules.js', 'i18n.js', 'i18n-fr.js']);
const NOINDEX = { 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' };

const view = (h) => ({ id: h.id, url: `/s/${h.id}`, created: h.created, expires: h.expires ?? null, bytes: h.bytes });

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
    if (op === 'share-read') return json(await read(account, body.id)); // the Worker, for /s/<id>/data
    await account.authenticate(request);
    if (op === 'share-put') return json(await put(account, body));
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
async function put(account, { id, blob, expires }) {
  if (!validSharedId(id)) throw new ApiError(400, 'bad_request', 'A share id is 22 base64url characters.');
  const text = checkBlob(blob);
  const now = account.now();
  const exp = checkExpires(expires, now);
  const storage = account.storage;
  if (await storage.get(`shrh:${id}`)) throw new ApiError(409, 'taken', 'That id is taken.');
  if ((await heads(account)).length >= SHARED.max) throw new ApiError(409, 'too_many', `You have ${SHARED.max} shared links, the most an account keeps. Revoke one first.`);
  const parts = Math.ceil(text.length / SHARED.chunk);
  const entries = [];
  for (let i = 0; i < parts; i++) entries.push([`shrc:${id}:${i}`, text.slice(i * SHARED.chunk, (i + 1) * SHARED.chunk)]);
  const h = { id, created: now, expires: exp, bytes: new TextEncoder().encode(text).length, parts };
  entries.push([`shrh:${id}`, h]);
  for (let i = 0; i < entries.length; i += 100) await storage.put(Object.fromEntries(entries.slice(i, i + 100)));
  return view(h);
}

async function read(account, id) {
  const h = await head(account, id);
  const keys = Array.from({ length: h.parts }, (_, i) => `shrc:${h.id}:${i}`);
  let blob = '';
  for (let i = 0; i < keys.length; i += 100) {
    const got = await account.storage.get(keys.slice(i, i + 100));
    for (const key of keys.slice(i, i + 100)) blob += got.get(key) ?? '';
  }
  return { blob, created: h.created, expires: h.expires ?? null };
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
      return json(await ask(env, who.account, 'share-put', { id, blob: body.blob, expires: body.expires ?? null }, who.token));
    } catch (error) {
      await ask(env, `shr:${id}`, 'share-index-drop', { account: who.account }).catch(() => {});
      throw error;
    }
  }
  if (route === 'POST /api/chat/shares/revoke') {
    const done = await ask(env, who.account, 'share-delete', { id: body.id }, who.token);
    await ask(env, `shr:${done.id}`, 'share-index-drop', { account: who.account }).catch(() => {});
    return json(done);
  }
  throw new ApiError(404, 'not_found', 'No such thing.');
}

const asset = (env, request, path) => env.ASSETS.fetch(new Request(new URL(path, request.url), request));
const gone = () => withHeaders(json({ error: 'This shared chat isn’t here: it was revoked, it expired, or the link is wrong.', code: 'not_found' }, 404), NOINDEX);

/**
 * GET /s/<id>, /s/<id>/data and /s/<file>: anyone (no sign-in). The response, or null when the
 * path isn't one of these.
 */
export async function sharedChatPage(request, env, path) {
  const m = /^\/s\/([^/]+)(\/data)?\/?$/.exec(path);
  if (!m) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('GET only', { status: 405, headers: { allow: 'GET, HEAD' } });
  const [, name, data] = m;
  if (validSharedId(name)) {
    if (!data) {
      // The same page whether or not the share exists: it asks for the data and says what happened.
      return withHeaders(pageHeaders(await asset(env, request, '/eden/share'), SHARED_CSP), NOINDEX);
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
        return withHeaders(json(await ask(env, account, 'share-read', { id: name })), NOINDEX);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) await ask(env, `shr:${name}`, 'share-index-drop', { account }).catch(() => {}); // expired: its index goes too
        throw error;
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return gone();
      throw error;
    }
  }
  if (data || !SHARED_FILES.has(name)) return null;
  return withHeaders(await asset(env, request, `/eden/${name}`), { 'cache-control': 'public, no-cache', 'x-content-type-options': 'nosniff' });
}
