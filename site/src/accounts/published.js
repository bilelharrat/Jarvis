// Published pages (ROADMAP G10, "turn a chat into an app"; docs/accounts.md "Published pages"):
// an Eden artifact kept as a live page at askeden.com/p/<id>, until its owner takes it down.
//
// Where it lives: the page itself (its HTML in pieces, its title and who may see it) in the
// owner's account object, beside the artifacts, so the per-account cap and taking it down are
// one object's business. The id is 16 random bytes (22 base64url characters); to find the
// account from the link alone, an object of its own in the same namespace, named `pub:<id>`,
// holds `{ account }` and nothing else. The link never carries the account id.
//
//   account object (as one of its devices)   pub-put, pub-list, pub-access, pub-delete
//   account object (the Worker, for /p/)     pub-read → { html, title, access }
//   `pub:<id>` object                        pub-index-claim { account }, pub-index-get, pub-index-drop { account }
//
// Who may see one: `private` ("only me"): a browser signed in to the owner's account;
// `link` ("anyone with the link"): anyone who has the address. Either way it's served under
// the artifacts' sandbox CSP: its own inline scripts run in an opaque origin, with no network,
// no cookies, no forms and no way to askeden.com. Never cached, so taking one down (or making
// it private) holds at once.
//
// The Worker's side (hosted Eden, src/eden/chat.js and pages.js call these):
//   POST /api/chat/publish             { html, title?, access? } → the page
//   GET  /api/chat/published           → { pages: [page], max, bytes }
//   POST /api/chat/published/access    { id, access } → the page
//   POST /api/chat/published/revoke    { id } → { id, revoked: true }
//   GET  /p/<id>                       the page (or a short "private" / "not here" page)
// A page: { id, url: "/p/<id>", title, access: "private" | "link", bytes, created, updated }.
//
// This module imports nothing from accounts/index.js or eden/session.js (they import the
// account object, which imports this): the Worker's callers hand in who's signed in.

import { ApiError, b64url, json, randomBytes } from './util.js';
import { ARTIFACT_CSP, page as pageHeaders, withHeaders } from '../eden/web.js';

export const PUBLISHED = { max: 20, bytes: 2 * 1024 * 1024, chunk: 60_000, title: 120 };
export const ACCESS = ['private', 'link'];
const ID = /^[A-Za-z0-9_-]{22}$/;
const encoder = new TextEncoder();

export const newPublishedId = () => b64url(randomBytes(16));
export const validPublishedId = (id) => ID.test(String(id));

const view = (h) => ({ id: h.id, url: `/p/${h.id}`, title: h.title, access: h.access, bytes: h.bytes, created: h.created, updated: h.updated });

function cleanTitle(title) {
  const text = typeof title === 'string' ? title.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return text.slice(0, PUBLISHED.title) || 'Untitled page';
}

function checkAccess(access) {
  if (!ACCESS.includes(access)) throw new ApiError(400, 'bad_request', 'access must be "private" (only you) or "link" (anyone with the link).');
  return access;
}

// ── the Durable Object's side (account.js dispatches every `pub-` op here) ──

export async function publishedOp(account, op, request) {
  try {
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const storage = account.storage;
    // The index objects: `pub:<id>` → its account. Never a real account's object.
    if (op.startsWith('pub-index-')) {
      if (await storage.get('account')) throw new ApiError(400, 'bad_request', 'That is an account, not a published page.');
      const entry = await storage.get('pubindex');
      if (op === 'pub-index-get') {
        if (!entry) throw new ApiError(404, 'not_found', 'No such page.');
        return json({ account: entry.account });
      }
      if (op === 'pub-index-claim') {
        if (entry) throw new ApiError(409, 'taken', 'That id is taken.');
        if (typeof body.account !== 'string' || !body.account) throw new ApiError(400, 'bad_request', 'account is required');
        await storage.put('pubindex', { account: body.account, at: account.now() });
        return json({});
      }
      if (op === 'pub-index-drop') {
        if (entry && entry.account === body.account) await storage.deleteAll();
        return json({});
      }
      throw new ApiError(404, 'not_found', 'No such thing.');
    }
    // The Worker reading one for /p/<id> (it decides who may see it).
    if (op === 'pub-read') return json(await read(storage, body.id));
    await account.authenticate(request);
    if (op === 'pub-put') return json(await put(account, body));
    if (op === 'pub-list') return json({ pages: (await heads(storage)).map(view), max: PUBLISHED.max, bytes: PUBLISHED.bytes });
    if (op === 'pub-access') return json(await setAccess(account, body));
    if (op === 'pub-delete') return json(await remove(storage, body.id));
    throw new ApiError(404, 'not_found', 'No such thing.');
  } catch (error) {
    if (error instanceof ApiError) return error.response();
    throw error;
  }
}

async function heads(storage) {
  return [...(await storage.list({ prefix: 'pubh:' })).values()].sort((a, b) => b.created - a.created);
}

async function head(storage, id) {
  const h = validPublishedId(id) ? await storage.get(`pubh:${id}`) : undefined;
  if (!h) throw new ApiError(404, 'not_found', 'That page isn’t published (any more).');
  return h;
}

// pubh:<id> → the head, pubc:<id>:<n> → a piece of the HTML (the head written last, so a
// half-written page is never found).
async function put(account, { id, html, title, access = 'private' }) {
  if (!validPublishedId(id)) throw new ApiError(400, 'bad_request', 'A page id is 22 base64url characters.');
  if (typeof html !== 'string' || !html) throw new ApiError(400, 'bad_request', 'html must be a non-empty string');
  const bytes = encoder.encode(html).length;
  if (bytes > PUBLISHED.bytes) throw new ApiError(413, 'too_big', 'A published page is at most 2 MB.');
  checkAccess(access);
  const storage = account.storage;
  if (await storage.get(`pubh:${id}`)) throw new ApiError(409, 'taken', 'That id is taken.');
  if ((await heads(storage)).length >= PUBLISHED.max) {
    throw new ApiError(409, 'too_many', `You have ${PUBLISHED.max} published pages, the most an account keeps. Take one down first (Published, in your account).`);
  }
  const now = account.now();
  const parts = Math.ceil(html.length / PUBLISHED.chunk);
  const entries = [];
  for (let i = 0; i < parts; i++) entries.push([`pubc:${id}:${i}`, html.slice(i * PUBLISHED.chunk, (i + 1) * PUBLISHED.chunk)]);
  const h = { id, title: cleanTitle(title), access, bytes, parts, created: now, updated: now };
  entries.push([`pubh:${id}`, h]);
  for (let i = 0; i < entries.length; i += 100) await storage.put(Object.fromEntries(entries.slice(i, i + 100)));
  return view(h);
}

async function read(storage, id) {
  const h = await head(storage, id);
  const keys = Array.from({ length: h.parts }, (_, i) => `pubc:${h.id}:${i}`);
  let html = '';
  for (let i = 0; i < keys.length; i += 100) {
    const got = await storage.get(keys.slice(i, i + 100));
    for (const key of keys.slice(i, i + 100)) html += got.get(key) ?? '';
  }
  return { html, title: h.title, access: h.access };
}

async function setAccess(account, { id, access }) {
  const h = await head(account.storage, id);
  h.access = checkAccess(access);
  h.updated = account.now();
  await account.storage.put(`pubh:${h.id}`, h);
  return view(h);
}

async function remove(storage, id) {
  const h = await head(storage, id);
  const keys = [`pubh:${h.id}`, ...Array.from({ length: h.parts }, (_, i) => `pubc:${h.id}:${i}`)];
  for (let i = 0; i < keys.length; i += 128) await storage.delete(keys.slice(i, i + 128));
  return { id: h.id, revoked: true };
}

// ── the Worker's side ──

/** One op on an object of the ACCOUNTS namespace; its JSON, or its refusal as an ApiError. */
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

async function readBody(request, cap) {
  const text = await request.text();
  if (text.length > cap) throw new ApiError(413, 'too_big', 'A published page is at most 2 MB.');
  try {
    const value = JSON.parse(text || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // below
  }
  throw new ApiError(400, 'bad_request', 'Send a JSON object.');
}

/**
 * /api/chat/publish and /api/chat/published/* for a signed-in browser (`who` from hosted
 * Eden's gate: { account, token }). Throws ApiError; chat.js turns it into its error shape.
 */
export async function publishedApi(request, env, who, path) {
  const route = `${request.method} ${path}`;
  await slowDown(env, who.account);
  if (route === 'GET /api/chat/published') return json(await ask(env, who.account, 'pub-list', {}, who.token));
  if (request.method !== 'POST') throw new ApiError(405, 'bad_request', 'GET or POST');
  const body = await readBody(request, 3 * PUBLISHED.bytes);
  if (route === 'POST /api/chat/publish') {
    if (typeof body.html !== 'string' || !body.html) throw new ApiError(400, 'bad_request', 'html must be a non-empty string');
    if (encoder.encode(body.html).length > PUBLISHED.bytes) throw new ApiError(413, 'too_big', 'A published page is at most 2 MB.');
    const access = checkAccess(body.access ?? 'private');
    let id = newPublishedId();
    try {
      await ask(env, `pub:${id}`, 'pub-index-claim', { account: who.account });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error;
      id = newPublishedId(); // 128 random bits: a second try is only for form's sake
      await ask(env, `pub:${id}`, 'pub-index-claim', { account: who.account });
    }
    try {
      return json(await ask(env, who.account, 'pub-put', { id, html: body.html, title: body.title, access }, who.token));
    } catch (error) {
      await ask(env, `pub:${id}`, 'pub-index-drop', { account: who.account }).catch(() => {});
      throw error;
    }
  }
  if (route === 'POST /api/chat/published/access') {
    return json(await ask(env, who.account, 'pub-access', { id: body.id, access: body.access }, who.token));
  }
  if (route === 'POST /api/chat/published/revoke') {
    const done = await ask(env, who.account, 'pub-delete', { id: body.id }, who.token);
    await ask(env, `pub:${done.id}`, 'pub-index-drop', { account: who.account }).catch(() => {});
    return json(done);
  }
  throw new ApiError(404, 'not_found', 'No such thing.');
}

// What /p/ says when there's no page to show: short, styled, nothing to run.
const NOTE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function note(status, title, words, link = null) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f5f7;color:#1d1d1f;font:400 16px/1.5 -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif;text-align:center;padding:24px;box-sizing:border-box}
h1{margin:0 0 8px;font-size:22px;font-weight:600}p{margin:0 auto 20px;max-width:380px;color:#6e6e73}a{color:#0a84ff;font-weight:600;text-decoration:none}
@media (prefers-color-scheme:dark){body{background:#161618;color:#f5f5f7}p{color:#98989d}}</style>
</head><body><main><h1>${title}</h1><p>${words}</p>${link ? `<a href="${link.href}">${link.text}</a>` : ''}</main></body></html>`;
  const response = new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' } });
  return pageHeaders(response, NOTE_CSP);
}

const notHere = () => note(404, 'This page isn’t here', 'It was taken down, or the link is wrong. Ask whoever shared it for a new one.', { href: '/', text: 'askeden.com' });

/**
 * GET /p/<id>. `session()` resolves to eden/session.js currentSession's { session } (asked
 * only for a private page).
 */
export async function publishedPage(request, env, id, session) {
  if (!validPublishedId(id) || !env.ACCOUNTS) return notHere();
  try {
    await slowDown(env, `p:${request.headers.get('cf-connecting-ip') || 'unknown'}`);
  } catch {
    return note(429, 'Slow down', 'Too many pages from this network in a minute. Wait a moment, then reload.');
  }
  let page;
  let owner;
  try {
    ({ account: owner } = await ask(env, `pub:${id}`, 'pub-index-get'));
    page = await ask(env, owner, 'pub-read', { id });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return notHere();
    throw error;
  }
  const headers = {
    'content-security-policy': ARTIFACT_CSP,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  };
  if (page.access === 'private') {
    const { session: who } = (await session()) || {};
    if (!who) {
      return withHeaders(note(401, 'This page is private', 'Only the person who published it can see it. If that’s you, sign in to Eden first.', { href: '/signin', text: 'Sign in to Eden' }), { vary: 'cookie' });
    }
    if (who.account !== owner) return withHeaders(notHere(), { vary: 'cookie' });
    headers.vary = 'cookie';
  }
  return withHeaders(new Response(page.html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }), headers);
}
