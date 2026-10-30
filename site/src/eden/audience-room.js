// Eden Slides' audience room on askeden.com: while someone presents, phones join through a link or QR code to vote in
// a poll, ask and upvote questions, or follow the slides read-only. Built 2026-10-24, NOT deployed (DEPLOY_FREEZE).
// The Mac's twin: askeden src/chat/audience.ts. The rules: ./audience-core.js, a byte-for-byte copy of askeden's
// web/chat/audience-core.js (test/audience-room.test.js checks they match).
//
// Everything the room carries is sealed in the presenter's and the phones' pages with the key in the link's
// #fragment (askeden web/chat/audience-crypto.js), so this Worker counts votes and upvotes without reading a word:
// the room refuses unsealed bodies (`requireSealed`). No accounts for the audience; a phone gets a voter id.
//
//   POST /api/chat/audience          the presenter, signed in (chat.js) → { id, owner }
//   GET  /a/<id>                     the audience page (Eden's audience.html), noindex, never framed
//   GET  /a/<file>                   its script and styles (AUDIENCE_FILES)
//   POST /a/<id>/join                → { voter }                      limited per network
//   POST /a/<id>/act      x-voter    { t: vote|ask|up|me }            limited per network and per voter (in the room)
//   POST /a/<id>/control  x-room-owner { t: show|lock|reset|hide|answered|deck|close }
//   GET  /a/<id>/events   (x-room-owner)  text/event-stream of `view` events
//   GET  /a/<id>/deck                → { deckV, body }  the sealed follow-along slides
//
// One Durable Object per room (AUDIENCE_ROOMS, id = idFromName(room id)), SQLite-backed: the room's state saved after
// each change; an alarm forgets it a day after the last change, and at once when the presenter ends it.

import { ApiError, b64url, json, randomBytes, sha256 } from '../accounts/util.js';
import { page as pageHeaders, withHeaders } from './web.js';
import { createRoom, AudienceError, AUD, ROOM_ID } from './audience-core.js';

export const AUDIENCE_FILES = new Set(['audience.js', 'audience.css', 'audience-crypto.js', 'deck-live-model.js']);
export const AUDIENCE_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src data:; frame-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const NOINDEX = { 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' };
const newId = () => b64url(randomBytes(16));
const hash = async (t) => b64url(await sha256(String(t)));
const stub = (env, id) => env.AUDIENCE_ROOMS.get(env.AUDIENCE_ROOMS.idFromName(id));

/** POST /api/chat/audience (chat.js, after the sign-in gate): a new room for this presenter. */
export async function audienceCreate(request, env, who, { limited }) {
  if (request.method !== 'POST') throw new ApiError(405, 'bad_request', 'POST only');
  if (!env.AUDIENCE_ROOMS) throw new ApiError(503, 'not_set_up', 'Live polls aren’t set up here yet.');
  await limited(env, 'API_RATE', `aud:${who.account}`);
  const id = newId(), owner = b64url(randomBytes(24));
  const r = await stub(env, id).fetch('https://audience/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, ownerHash: await hash(owner) }) });
  if (!r.ok) throw new ApiError(500, 'error', 'Couldn’t open the audience room.');
  return json({ id, owner, url: `/a/${id}` });
}

const asset = (env, request, p) => env.ASSETS.fetch(new Request(new URL(p, request.url), request));
const edenDir = (request) => (/\b(?:EdenApp|EdenEdu)\//.test(request.headers.get('user-agent') || '') && !/\bEdenBeta\//.test(request.headers.get('user-agent') || '') ? '/eden-ios' : '/eden');

/** /a/…: the page, its files, and the room's routes. The response, or null when the path isn't one of them. */
export async function audiencePage(request, env, path, { limited }) {
  const m = /^\/a\/([^/]+)(\/join|\/act|\/control|\/events|\/deck)?\/?$/.exec(path);
  if (!m) return null;
  const [, name, sub] = m;
  if (!ROOM_ID.test(name)) {
    if (sub || !AUDIENCE_FILES.has(name) || (request.method !== 'GET' && request.method !== 'HEAD')) return null;
    return withHeaders(await asset(env, request, `${edenDir(request)}/${name}`), { 'cache-control': 'public, no-cache', 'x-content-type-options': 'nosniff' });
  }
  if (!sub) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('GET only', { status: 405, headers: { allow: 'GET, HEAD' } });
    return withHeaders(pageHeaders(await asset(env, request, `${edenDir(request)}/audience`), AUDIENCE_CSP), NOINDEX);
  }
  try {
    if (!env.AUDIENCE_ROOMS) throw new ApiError(404, 'not_found', 'This presentation isn’t live.');
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const get = sub === '/events' || sub === '/deck';
    if (get ? request.method !== 'GET' : request.method !== 'POST') throw new ApiError(405, 'bad_request', get ? 'GET only' : 'POST only');
    if (sub === '/join' || sub === '/act') await limited(env, 'API_RATE', `aud:${ip}`);
    let body = '';
    if (!get) {
      if ((request.headers.get('content-type') || '').split(';')[0].trim() !== 'application/json') throw new ApiError(415, 'bad_request', 'POST a JSON body.');
      body = await request.text();
      if (body.length > (sub === '/control' ? AUD.deckChars + 4096 : 64 * 1024)) throw new ApiError(413, 'too_big', 'That is too big.');
    }
    // a fresh request: only what the room needs reaches it
    const headers = { 'content-type': 'application/json', 'x-net': await hash(`net:${ip}`) };
    const owner = request.headers.get('x-room-owner');
    if (owner && /^[A-Za-z0-9_-]{22,43}$/.test(owner)) headers['x-owner-hash'] = await hash(owner);
    const voter = request.headers.get('x-voter');
    if (voter) headers['x-voter'] = voter.slice(0, 64);
    const r = await stub(env, name).fetch(`https://audience${sub}`, { method: get ? 'GET' : 'POST', headers, ...(get ? {} : { body }) });
    return withHeaders(r, NOINDEX);
  } catch (error) {
    if (error instanceof ApiError) return withHeaders(error.response(), NOINDEX);
    throw error;
  }
}

// ── the room ──

export class AudienceRoom {
  constructor(ctx, env, { now = () => Date.now() } = {}) {
    this.ctx = ctx;
    this.storage = ctx.storage;
    this.now = now;
    this.room = null;
    this.streams = new Set(); // { writer, owner }
    this.timer = null;
  }

  async load() {
    if (this.room) return this.room;
    const saved = await this.storage.get('room');
    if (!saved) return null;
    this.room = this.make(saved.meta, saved.state);
    return this.room;
  }
  make(meta, state = null) {
    const room = createRoom({ id: meta.id, ownerHash: meta.ownerHash, now: this.now, newId, requireSealed: true }, state);
    room.on((what) => this.changed(what));
    this.meta = meta;
    return room;
  }
  changed(what) {
    // save (the room is small; the follow-along slides are kept apart so most saves don't rewrite them)
    const { deck, ...state } = this.room.save();
    const writes = { room: { meta: this.meta, state: { ...state, deck: '' } } };
    if (what === 'deck') writes.deck = deck;
    this.saving = Promise.all([this.storage.put(writes), this.storage.setAlarm(this.now() + (this.room.closed ? 1000 : AUD.idleMs))]).catch(() => {});
    if (what === 'closed') { this.push(); return; }
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.push(); }, 120); // at most ~8 a second
  }
  push() {
    const enc = new TextEncoder();
    for (const s of [...this.streams]) {
      const text = `event: view\ndata: ${JSON.stringify(this.room.view({ owner: s.owner }))}\n\n`;
      s.writer.write(enc.encode(text)).catch(() => this.streams.delete(s));
      if (this.room.closed) { s.writer.close().catch(() => {}); this.streams.delete(s); }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/create') {
        const { id, ownerHash } = await request.json();
        if (await this.storage.get('room')) throw new ApiError(409, 'taken', 'That room exists.');
        this.room = this.make({ id, ownerHash });
        this.changed('state');
        await this.saving;
        return json({ ok: true });
      }
      const room = await this.load();
      if (!room || room.closed) throw new ApiError(404, 'not_found', 'This presentation isn’t live: it ended, or the link is wrong.');
      const ownerHash = request.headers.get('x-owner-hash') || '';
      const isOwner = room.owner(ownerHash);
      if (url.pathname === '/events') return this.events(isOwner);
      if (url.pathname === '/deck') {
        let { deckV, body } = room.deck();
        if (!body) body = (await this.storage.get('deck')) || '';
        return json({ deckV, body });
      }
      const body = await request.json().catch(() => null);
      let out;
      if (url.pathname === '/control') {
        if (!isOwner) throw new ApiError(403, 'forbidden', 'Only the presenter can do that.');
        out = room.control(body);
        if (body && body.t === 'close') await this.storage.deleteAll().catch(() => {}); // ended: forgotten now (the alarm is a backstop)
      } else if (url.pathname === '/join') out = room.join(request.headers.get('x-net') || '');
      else if (url.pathname === '/act') out = room.act(request.headers.get('x-voter') || '', body);
      else throw new ApiError(404, 'not_found', 'No such thing.');
      await this.saving;
      return json(out);
    } catch (error) {
      if (error instanceof AudienceError) return json({ error: error.message, code: error.code }, error.status);
      if (error instanceof ApiError) return error.response();
      throw error;
    }
  }

  events(owner) {
    const { readable, writable } = new TransformStream();
    const s = { writer: writable.getWriter(), owner };
    this.streams.add(s);
    s.writer.write(new TextEncoder().encode(`event: view\ndata: ${JSON.stringify(this.room.view({ owner }))}\n\n`)).catch(() => this.streams.delete(s));
    return new Response(readable, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  }

  async alarm() {
    const room = await this.load();
    if (!room || room.closed || room.idle) {
      for (const s of this.streams) s.writer.close().catch(() => {});
      this.streams.clear();
      this.room = null;
      await this.storage.deleteAll();
    } else await this.storage.setAlarm(this.now() + AUD.idleMs);
  }
}
