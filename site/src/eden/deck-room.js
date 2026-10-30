// Eden Slides, editing together across devices (askeden research_notes/slides-collab-design.md): one Durable Object per
// shared deck, which keeps the deck's versions and comments and relays presence between the people who have it open.
// Everything a person wrote is sealed in their browser with the share's key (askeden web/chat/deck-room.js), so this
// object stores and passes on ciphertext it can't read: only a version's id and time, and who is connected, are plain.
//
// The room is a shared chat (accounts/shared-chats.js) in "collaborate" mode: its id is the share's id, its owner the
// share's owner, and its seats the share's collaborator seats. Built 2026-10-24, NOT deployed (DEPLOY_FREEZE).
//
//   GET /api/chat/deck-room/<shareId>   WebSocket, protocol "eden-deck.v1" (and "seat.<token>" for a collaborator link)
//     owner: the signed-in owner of the share (session cookie) → may edit
//     a seat: its token, hashed, matches a seat → "collaborator" may edit, "viewer" may only watch
//   The Worker checks all of that, then hands the socket to the room with the role in internal headers.
//
// Wire, JSON text frames (→ from a browser, ← from the room):
//   → { t: 'hello', since: [versionIds] }      ← { t: 'welcome', me, role, ids } then each missing version, then comments
//   → { t: 'version', id, at, enc }            ← { t: 'version', id, at, enc, from }    one deck edit, sealed
//   → { t: 'comments', at, enc }               ← { t: 'comments', at, enc, from }       the sender's whole merged list, sealed
//   → { t: 'presence', enc }                   ← { t: 'presence', enc, from }           not stored
//                                              ← { t: 'left', from }                    a connection closed
//                                              ← { t: 'error', code, error }            bad_request, forbidden, too_big, rate, gone

import { ApiError, b64url, sha256, sameText, json } from '../accounts/util.js';

export const ROOM = {
  maxMessage: 450_000, // a sealed version: askeden sync-model.js MAX_JSON plus its sealing
  sockets: 20, // SHARED.collaborators
  versions: 40, // askeden deck-model.js MAX_VERSIONS
  perSecond: 60, // messages a connection may send each second (a browser sends ~12 with presence; up to 41 catching a new room up)
  dropAfter: 400, // in one second: the connection is closed
  idleMs: 30 * 864e5, // a room nobody has written to for 30 days is emptied
  protocol: 'eden-deck.v1',
};
const SHARE_ID = /^[A-Za-z0-9_-]{22}$/;
const SEAT_TOKEN = /^[A-Za-z0-9_-]{22,43}$/;
const VERSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SEALED = /^[A-Za-z0-9_\-{}":,]+$/; // a sealed envelope: { "v": 1, "iv": "…", "ct": "…" } in base64url, nothing else
const ROLES = new Set(['owner', 'collaborator', 'commenter', 'viewer']);
const canWrite = (role) => role === 'owner' || role === 'collaborator';
const canComment = (role) => canWrite(role) || role === 'commenter'; // a "can comment" link: comments, never edits
const pad = (n) => String(Math.max(0, Math.floor(n))).padStart(16, '0');

// ── the Worker's side ──

async function ask(env, name, op, body = {}) {
  const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName(name));
  const response = await stub.fetch(`https://account/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = await response.json().catch(() => ({}));
  if (response.status >= 400) throw new ApiError(response.status, out.code || 'error', out.error || 'Something went wrong.');
  return out;
}

/** The protocols a browser asked for: ['eden-deck.v1', 'seat.<token>'] → { ok, token }. */
export function readProtocols(header) {
  const list = String(header || '').split(',').map((s) => s.trim()).filter(Boolean);
  const seat = list.find((p) => p.startsWith('seat.'));
  const token = seat ? seat.slice(5) : '';
  return { ok: list.includes(ROOM.protocol), token: SEAT_TOKEN.test(token) ? token : '' };
}

/**
 * Who may join room `id`, and as what: { role, seat, expires } or an ApiError. `session` is the signed-in browser's
 * ({ account } or null); `token` a collaborator seat's token.
 */
export async function admit(env, id, { session = null, token = '' } = {}) {
  if (!SHARE_ID.test(String(id))) throw new ApiError(404, 'not_found', 'No such room.');
  let owner;
  try { ({ account: owner } = await ask(env, `shr:${id}`, 'share-index-get')); } catch (error) {
    if (error instanceof ApiError && error.status === 404) throw new ApiError(404, 'not_found', 'This deck isn’t shared any more.');
    throw error;
  }
  const share = await ask(env, owner, 'share-seats', { id }); // { seats, mode, expires } (404 once revoked or expired)
  if (share.mode !== 'collaborate') throw new ApiError(403, 'forbidden', 'This share isn’t open for editing together.');
  if (session && session.account === owner) return { role: 'owner', seat: 'owner', expires: share.expires ?? null, owner };
  if (token) {
    const hash = b64url(await sha256(token));
    const seat = (share.seats || []).find((s) => sameText(s.tokenHash, hash));
    if (!seat || !ROLES.has(seat.role)) throw new ApiError(403, 'forbidden', 'This link was revoked or isn’t valid.');
    if (seat.expires && seat.expires <= Date.now()) throw new ApiError(403, 'forbidden', 'This link has expired. Ask for a new one.');
    if (seat.people) { // an invitation for one Eden account: the first to open it keeps it (shared-chats.js seatAccess)
      const account = session && session.account;
      if (!account) throw new ApiError(401, 'signed_out', 'Sign in to Eden to open this invitation.');
      if (seat.account ? seat.account !== account : !(await ask(env, owner, 'share-claim', { id, token, account })).seat) throw new ApiError(403, 'forbidden', 'This invitation was opened by another Eden account.');
    }
    return { role: seat.role, seat: seat.id, expires: share.expires ?? null, seatExpires: seat.expires || null, owner };
  }
  throw new ApiError(401, 'signed_out', 'Sign in as the deck’s owner, or open the collaborator link you were sent.');
}

/**
 * GET /api/chat/deck-room/<id> (chat.js): checks the request and who it is, then hands the socket to the room.
 * `deps`: { currentSession, limited } (injected so the tests can run it alone).
 */
export async function deckRoomApi(request, env, path, { currentSession, limited }) {
  try {
    const id = path.slice('/api/chat/deck-room/'.length);
    if (request.method !== 'GET') throw new ApiError(405, 'bad_request', 'GET (a WebSocket) only.');
    if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') throw new ApiError(426, 'bad_request', 'The deck room speaks WebSocket.');
    // a WebSocket has no CORS: only askeden.com's own page may open one (cross-site WebSocket hijacking)
    const origin = request.headers.get('origin');
    if (!origin || origin !== new URL(request.url).origin || (request.headers.get('sec-fetch-site') || '') === 'cross-site') throw new ApiError(403, 'forbidden', 'Not from another site.');
    if (!env.DECK_ROOMS || !env.ACCOUNTS) throw new ApiError(503, 'not_set_up', 'Editing together isn’t set up here yet.');
    const { ok, token } = readProtocols(request.headers.get('sec-websocket-protocol'));
    if (!ok) throw new ApiError(400, 'bad_request', `Ask for the ${ROOM.protocol} protocol.`);
    await limited(env, 'API_RATE', `room:${request.headers.get('cf-connecting-ip') || 'unknown'}`);
    const { session } = await currentSession(request, env); // the owner, or the account an invitation is for
    const who = await admit(env, id, { session, token });
    const room = env.DECK_ROOMS.get(env.DECK_ROOMS.idFromName(id));
    // a fresh request: nothing the browser sent reaches the room except the upgrade itself
    return await room.fetch('https://deck-room/connect', { headers: { upgrade: 'websocket', 'x-room': id, 'x-role': who.role, 'x-seat': who.seat, 'x-expires': String(who.expires || ''), 'x-seat-expires': String(who.seatExpires || '') } });
  } catch (error) {
    if (error instanceof ApiError) return error.response();
    throw error;
  }
}

/** A share was revoked (close: true) or its seats changed: the room closes the sockets that may no longer be there. */
export async function deckRoomSeats(env, id, { close = false, seats = [] } = {}) {
  if (!env.DECK_ROOMS || !SHARE_ID.test(String(id))) return;
  const room = env.DECK_ROOMS.get(env.DECK_ROOMS.idFromName(id));
  await room.fetch(`https://deck-room/${close ? 'close' : 'seats'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seats: seats.map((s) => s.id) }) });
}

// ── the room ──

export class DeckRoom {
  constructor(ctx, env, { now = () => Date.now() } = {}) {
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;
    this.now = now;
    this.rate = new Map(); // connection → { second, n } (lost when the object sleeps, which is fine)
  }

  // Overridable in tests: a WebSocket pair, the server end accepted with these tags.
  upgrade(tags) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, tags);
    return { response: new Response(null, { status: 101, webSocket: client, headers: { 'sec-websocket-protocol': ROOM.protocol } }), server };
  }

  sockets() { return this.ctx.getWebSockets(); }
  tagsOf(ws) { return this.ctx.getTags ? this.ctx.getTags(ws) : []; }
  info(ws) {
    const tags = this.tagsOf(ws);
    const get = (p) => (tags.find((t) => t.startsWith(p)) || '').slice(p.length);
    return { role: get('role:'), seat: get('seat:'), id: get('c:'), ends: Number(get('e:')) || 0 };
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/connect') return await this.connect(request);
      if (url.pathname === '/close' && request.method === 'POST') {
        this.closeAll(4403, 'revoked');
        await this.storage.deleteAll();
        return json({ closed: true });
      }
      if (url.pathname === '/seats' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const keep = new Set(Array.isArray(body.seats) ? body.seats.map(String) : []);
        for (const ws of this.sockets()) { const { seat } = this.info(ws); if (seat !== 'owner' && !keep.has(seat)) this.closeOne(ws, 4403, 'revoked'); }
        return json({ ok: true });
      }
      throw new ApiError(404, 'not_found', 'No such thing.');
    } catch (error) {
      if (error instanceof ApiError) return error.response();
      throw error;
    }
  }

  async connect(request) {
    const role = request.headers.get('x-role') || '';
    const seat = request.headers.get('x-seat') || '';
    if (!ROLES.has(role) || !/^[A-Za-z0-9_-]{1,40}$/.test(seat)) throw new ApiError(400, 'bad_request', 'Bad room request.');
    if (this.sockets().length >= ROOM.sockets) throw new ApiError(429, 'slow_down', `A deck can have at most ${ROOM.sockets} people in it at once.`);
    const expires = Number(request.headers.get('x-expires')) || null;
    const meta = (await this.storage.get('meta')) || { room: request.headers.get('x-room') || '', created: this.now() };
    await this.storage.put('meta', { ...meta, expires, at: meta.at || this.now() });
    await this.storage.setAlarm(this.now() + ROOM.idleMs);
    const conn = b64url(crypto.getRandomValues(new Uint8Array(9)));
    const seatEnds = Number(request.headers.get('x-seat-expires')) || 0; // this link alone stops then
    return this.upgrade([`role:${role}`, `seat:${seat}`, `c:${conn}`, ...(seatEnds > 0 ? [`e:${seatEnds}`] : [])]).response;
  }

  send(ws, m) { try { ws.send(JSON.stringify(m)); } catch { /* gone */ } }
  broadcast(from, m) { const t = this.now(); for (const ws of this.sockets()) { if (ws === from) continue; const { ends } = this.info(ws); if (ends && ends <= t) this.closeOne(ws, 4404, 'expired'); else this.send(ws, m); } } // a link whose time is up hears nothing more
  closeOne(ws, code, reason) { try { ws.close(code, reason); } catch { /* gone */ } }
  closeAll(code, reason) { for (const ws of this.sockets()) this.closeOne(ws, code, reason); }
  error(ws, code, error) { this.send(ws, { t: 'error', code, error }); }

  /** Too many messages this second: true (and the connection is closed past `dropAfter`). */
  limited(ws, id) {
    const second = Math.floor(this.now() / 1000);
    const r = this.rate.get(id);
    const n = r && r.second === second ? r.n + 1 : 1;
    this.rate.set(id, { second, n });
    if (n > ROOM.dropAfter) { this.closeOne(ws, 1008, 'too many messages'); return true; }
    return n > ROOM.perSecond;
  }

  async webSocketMessage(ws, message) {
    const me = this.info(ws);
    if (typeof message !== 'string') return this.error(ws, 'bad_request', 'Text frames only.');
    if (message.length > ROOM.maxMessage) return this.error(ws, 'too_big', 'That change is too big to send.');
    if (this.limited(ws, me.id)) return this.error(ws, 'rate', 'Slow down.');
    const meta = (await this.storage.get('meta')) || {};
    if (meta.expires && meta.expires <= this.now()) { this.closeAll(4404, 'expired'); await this.storage.deleteAll(); return undefined; }
    if (me.ends && me.ends <= this.now()) { this.closeOne(ws, 4404, 'expired'); return undefined; } // this link's own time is up
    let m;
    try { m = JSON.parse(message); } catch { return this.error(ws, 'bad_request', 'Send JSON.'); }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return this.error(ws, 'bad_request', 'Send a JSON object.');
    const sealed = (x) => typeof x === 'string' && x.length > 0 && x.length <= ROOM.maxMessage && SEALED.test(x);
    switch (m.t) {
      case 'hello': {
        const since = new Set(Array.isArray(m.since) ? m.since.slice(0, 200).filter((x) => typeof x === 'string' && VERSION_ID.test(x)) : []);
        const versions = [...(await this.storage.list({ prefix: 'v:' })).values()];
        const missing = versions.filter((v) => !since.has(v.id));
        this.send(ws, { t: 'welcome', me: me.id, role: me.role, ids: versions.map((v) => v.id), people: this.sockets().length });
        for (const v of missing) this.send(ws, { t: 'version', id: v.id, at: v.at, enc: v.enc, from: 'room' }); // one frame each: 40 × 450 KB never goes as one
        const cm = await this.storage.get('cm');
        if (cm) this.send(ws, { t: 'comments', at: cm.at, enc: cm.enc, from: 'room' });
        return undefined;
      }
      case 'version': {
        if (!canWrite(me.role)) return this.error(ws, 'forbidden', 'This link can only watch.');
        if (typeof m.id !== 'string' || !VERSION_ID.test(m.id) || !Number.isFinite(m.at) || m.at <= 0 || !sealed(m.enc)) return this.error(ws, 'bad_request', 'Bad version.');
        const known = await this.storage.get(`vi:${m.id}`);
        if (!known) {
          const key = `v:${pad(m.at)}:${m.id}`;
          await this.storage.put({ [key]: { id: m.id, at: m.at, enc: m.enc }, [`vi:${m.id}`]: key });
          const all = [...(await this.storage.list({ prefix: 'v:' })).entries()];
          const old = all.slice(0, Math.max(0, all.length - ROOM.versions));
          if (old.length) await this.storage.delete(old.flatMap(([k, v]) => [k, `vi:${v.id}`]));
        }
        await this.touch(meta);
        this.broadcast(ws, { t: 'version', id: m.id, at: m.at, enc: m.enc, from: me.id });
        return undefined;
      }
      case 'comments': {
        if (!canComment(me.role)) return this.error(ws, 'forbidden', 'This link can only watch.');
        if (!Number.isFinite(m.at) || !sealed(m.enc)) return this.error(ws, 'bad_request', 'Bad comments.');
        await this.storage.put('cm', { at: m.at, enc: m.enc }); // sealed, so it can't be merged here: each browser merges what it gets and sends its result back when that differs
        await this.touch(meta);
        this.broadcast(ws, { t: 'comments', at: m.at, enc: m.enc, from: me.id });
        return undefined;
      }
      case 'presence':
        if (!sealed(m.enc) || m.enc.length > 4096) return this.error(ws, 'bad_request', 'Bad presence.');
        this.broadcast(ws, { t: 'presence', enc: m.enc, from: me.id });
        return undefined;
      default:
        return this.error(ws, 'bad_request', 'Unknown message.');
    }
  }

  async touch(meta) {
    await this.storage.put('meta', { ...meta, at: this.now() });
    await this.storage.setAlarm(this.now() + ROOM.idleMs);
  }

  async webSocketClose(ws) {
    const { id } = this.info(ws);
    this.rate.delete(id);
    this.broadcast(ws, { t: 'left', from: id });
    this.closeOne(ws, 1000, 'bye');
  }

  async webSocketError(ws) { await this.webSocketClose(ws); }

  async alarm() {
    const meta = (await this.storage.get('meta')) || {};
    const now = this.now();
    if ((meta.expires && meta.expires <= now) || now - (meta.at || 0) >= ROOM.idleMs) {
      this.closeAll(4404, 'gone');
      await this.storage.deleteAll();
    } else {
      await this.storage.setAlarm((meta.at || now) + ROOM.idleMs);
    }
  }
}
