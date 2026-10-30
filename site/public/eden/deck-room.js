// Editing a deck together across devices (web only, OFF by default): the browser's side of a deck room on askeden.com
// (JARVIS V1/site/src/eden/deck-room.js, built 2026-10-24, not deployed). Design: research_notes/slides-collab-design.md.
// `roomEnabled()` is false unless localStorage 'eden.collab.room' = '1'. The tests use MockRoom, which follows the same
// rules as the real room.
//
// The room is a shared chat in "collaborate" mode: its id is the share's id and its key the share's key (only ever in
// the link's #fragment). Every version, comment list and presence message is sealed here with that key (AES-256-GCM,
// a fresh IV each time, bound to its kind and version id), so the server keeps and passes on ciphertext it can't read.
//
// Wire (JSON over one WebSocket, GET /api/chat/deck-room/<id>, protocols "eden-deck.v1" and, with a collaborator
// link, "seat.<token>"):
//   → { t: 'hello', since: [versionIds] }      ← { t: 'welcome', me, role, ids } then each missing version, then comments
//   → { t: 'version', id, at, enc }            ← { t: 'version', id, at, enc, from }
//   → { t: 'comments', at, enc }               ← { t: 'comments', at, enc, from }
//   → { t: 'presence', enc }                   ← { t: 'presence', enc, from }        ← { t: 'left', from }
//   ← { t: 'error', code, error }
// Versions only ever get added (sync-model.js mergeVersions) and comments merge by id (mergeComments), so the order
// messages arrive in never matters. The room can't merge sealed comments, so a browser that gets a list different
// from its own merged result sends its result back; that settles after one round.

import { mergeVersions, foldComments, mergeComments } from './sync-model.js';
import { normalizeDeck } from './deck-model.js';

export const PROTOCOL = 'eden-deck.v1';
export const MAX_MESSAGE = 450_000; // the room's ROOM.maxMessage
export const ROOM_ID = /^[A-Za-z0-9_-]{22}$/;
export const ROOM_KEY = /^[A-Za-z0-9_-]{43}$/;
export const SEAT_TOKEN = /^[A-Za-z0-9_-]{22,43}$/;
const VERSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const roomEnabled = () => { try { return Boolean(globalThis.localStorage) && localStorage.getItem('eden.collab.room') === '1'; } catch { return false; } };

// ── sealing (the same AES-GCM as share-model.js, its own additional data) ──

const b64u = (bytes) => { let s = ''; const b = new Uint8Array(bytes); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = (s) => { const t = String(s).replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4)); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const aad = (kind, id = '') => new TextEncoder().encode(`eden-deck-room-v1:${kind}:${id}`);
const keys = new Map();
async function cryptoKey(keyText) {
  if (!ROOM_KEY.test(String(keyText || ''))) throw new Error('This link is missing its key.');
  if (!keys.has(keyText)) keys.set(keyText, globalThis.crypto.subtle.importKey('raw', unb64u(keyText), 'AES-GCM', false, ['encrypt', 'decrypt']));
  return keys.get(keyText);
}
/** `value` sealed for the room: '{"v":1,"iv":…,"ct":…}'. `kind` 'version' (with its id), 'comments' or 'presence'. */
export async function seal(value, keyText, kind, id = '') {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(kind, id) }, await cryptoKey(keyText), new TextEncoder().encode(JSON.stringify(value)));
  return JSON.stringify({ v: 1, iv: b64u(iv), ct: b64u(ct) });
}
/** What `seal` sealed, or null when it doesn't open (another key, another kind or id, tampered with). */
export async function unseal(enc, keyText, kind, id = '') {
  try {
    const e = JSON.parse(enc);
    if (!e || e.v !== 1 || typeof e.iv !== 'string' || typeof e.ct !== 'string') return null;
    const plain = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(e.iv), additionalData: aad(kind, id) }, await cryptoKey(keyText), unb64u(e.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch { return null; }
}

/** A version from the room, checked: { id, at, kind: 'room', deck } (the deck cleaned), or null. */
export function cleanVersion(v, id) {
  if (!v || typeof v !== 'object' || v.id !== id || !VERSION_ID.test(id) || !Number.isFinite(v.at) || v.at <= 0) return null;
  const r = normalizeDeck(v.deck);
  return r.deck ? { id, at: Math.floor(v.at), kind: 'room', deck: r.deck } : null;
}

/** A conversation with what a room message brought (versions and comments merged in). → true when it changed. */
export function applyRoomMessage(c, m) {
  if (!c || !m || typeof m !== 'object') return false;
  const before = JSON.stringify([c.deckVersions || [], (c.deckVersions || []).at(-1)?.deck?.comments || []]);
  if (m.t === 'version' && m.version && typeof m.version === 'object' && m.version.deck) c.deckVersions = foldComments(mergeVersions(c.deckVersions, [m.version]), [c.deckVersions]);
  if (m.t === 'comments' && Array.isArray(m.comments) && Array.isArray(c.deckVersions) && c.deckVersions.length) {
    const last = c.deckVersions.at(-1);
    c.deckVersions = [...c.deckVersions.slice(0, -1), { ...last, deck: { ...last.deck, comments: mergeComments(last.deck.comments, m.comments) } }];
  }
  return JSON.stringify([c.deckVersions || [], (c.deckVersions || []).at(-1)?.deck?.comments || []]) !== before;
}

const commentsOfConv = (c) => ((c && Array.isArray(c.deckVersions) ? c.deckVersions.at(-1)?.deck?.comments : null) || []);

/**
 * One device's link to a room. `connect()` → a new socket (a WebSocket, or a MockRoom connection: send/close,
 * onopen/onmessage/onclose, readyState). `key` the share's key. `getConv()` the conversation the deck is in (null while
 * there's none); `onChange(c)` after a message changed it; `onStatus(status, detail)` with 'connecting', 'open',
 * 'offline' (it tries again, waiting longer each time), 'closed' (revoked, expired: no more tries) or 'error'.
 * `channel` carries presence (deck-presence.js Presence talks to it as to a BroadcastChannel).
 */
export class RoomClient {
  constructor({ connect, key, getConv, onChange = () => {}, onStatus = () => {}, timers = globalThis }) {
    this.connectFn = connect; this.key = key; this.getConv = getConv; this.onChange = onChange; this.onStatus = onStatus; this.timers = timers;
    this.handlers = new Set();
    this.peers = new Map(); // connection → the presence id it last sent (for 'left')
    this.has = new Set(); // version ids the room has
    this.role = '';
    this.tries = 0;
    this.queue = Promise.resolve(); // messages are opened one at a time, in order
    this.channel = {
      postMessage: (m) => { if (this.open) seal(m, this.key, 'presence').then((enc) => this.send({ t: 'presence', enc }), () => {}); },
      addEventListener: (_, fn) => this.handlers.add(fn),
      removeEventListener: (_, fn) => this.handlers.delete(fn),
    };
    this.dial();
  }
  dial() {
    if (this.closed) return;
    this.onStatus('connecting');
    let s;
    try { s = this.connectFn(); } catch { this.retry(); return; }
    this.socket = s;
    s.onopen = () => { this.tries = 0; this.send({ t: 'hello', since: ((this.getConv() || {}).deckVersions || []).map((v) => v.id).filter(Boolean).slice(-200) }); };
    s.onmessage = (e) => { const raw = typeof e.data === 'string' ? e.data : ''; this.queue = this.queue.then(() => this.receive(raw)).catch(() => {}); };
    s.onclose = (e) => {
      if (this.socket !== s) return;
      this.open = false;
      for (const id of this.peers.values()) this.toPresence({ v: 1, type: 'bye', deck: this.deckKey(), id });
      this.peers.clear();
      if (e && (e.code === 4403 || e.code === 4404)) { this.closed = true; this.onStatus('closed', e.code === 4403 ? 'revoked' : 'expired'); return; }
      this.retry();
    };
    if (s.readyState === 1 && s.onopen) s.onopen();
  }
  retry() {
    if (this.closed) return;
    this.onStatus('offline');
    const wait = Math.min(30_000, 1000 * 2 ** Math.min(5, this.tries++)) * (0.75 + Math.random() * 0.5);
    this.timer = this.timers.setTimeout(() => this.dial(), wait);
  }
  deckKey() { const c = this.getConv(); return (c && c.deckRoom && c.deckRoom.id) || (c && c.id) || ''; }
  send(m) {
    const s = JSON.stringify(m);
    if (s.length > MAX_MESSAGE) { this.onStatus('error', 'too_big'); return false; }
    try { this.socket.send(s); return true; } catch { return false; }
  }
  toPresence(m) { for (const fn of this.handlers) fn({ data: m }); }
  async receive(raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const c = this.getConv();
    switch (m.t) {
      case 'welcome':
        this.open = true;
        this.role = m.role === 'viewer' || m.role === 'commenter' || m.role === 'collaborator' ? m.role : 'owner'; // commenter: comments, never edits (deck-share.js)
        this.has = new Set(Array.isArray(m.ids) ? m.ids.filter((x) => typeof x === 'string') : []);
        this.commentsSent = '';
        this.onStatus('open', this.role);
        if (c) await this.push(c); // what this device made while it was away
        return;
      case 'version': {
        if (typeof m.id !== 'string' || typeof m.enc !== 'string') return;
        this.has.add(m.id);
        const v = cleanVersion(await unseal(m.enc, this.key, 'version', m.id), m.id);
        if (v && c && applyRoomMessage(c, { t: 'version', version: v })) this.onChange(c);
        return;
      }
      case 'comments': {
        const list = await unseal(m.enc, this.key, 'comments');
        if (!Array.isArray(list) || !c) return;
        const changed = applyRoomMessage(c, { t: 'comments', comments: list });
        if (changed) this.onChange(c);
        const mine = commentsOfConv(c);
        this.commentsSent = JSON.stringify(list);
        if (JSON.stringify(mine) !== this.commentsSent) await this.pushComments(c); // the room keeps the latest list only: send back what it lacks
        return;
      }
      case 'presence': {
        const p = await unseal(m.enc, this.key, 'presence');
        if (!p || typeof p !== 'object') return;
        if (typeof m.from === 'string' && typeof p.id === 'string') this.peers.set(m.from, p.id);
        this.toPresence(p);
        return;
      }
      case 'left': { const id = this.peers.get(m.from); this.peers.delete(m.from); if (id) this.toPresence({ v: 1, type: 'bye', deck: this.deckKey(), id }); return; }
      case 'error': this.onStatus('error', typeof m.code === 'string' ? m.code : 'error'); return;
      default:
    }
  }
  /** After a local save: the versions the room doesn't have, and the comments when they changed. A viewer sends neither. */
  async push(c) {
    if (!this.open || this.role === 'viewer' || !c) return;
    if (this.role !== 'commenter') for (const v of c.deckVersions || []) {
      if (!v.id || this.has.has(v.id) || !VERSION_ID.test(v.id)) continue;
      this.has.add(v.id);
      const enc = await seal({ id: v.id, at: v.at, deck: v.deck }, this.key, 'version', v.id);
      this.send({ t: 'version', id: v.id, at: v.at || Date.now(), enc });
    }
    await this.pushComments(c);
  }
  async pushComments(c) {
    if (!this.open || this.role === 'viewer') return;
    const list = commentsOfConv(c);
    const text = JSON.stringify(list);
    if (!list.length || text === this.commentsSent) return;
    this.commentsSent = text;
    this.send({ t: 'comments', at: Date.now(), enc: await seal(list, this.key, 'comments') });
  }
  close() { this.closed = true; this.open = false; this.timers.clearTimeout(this.timer); try { this.socket.close(1000, 'bye'); } catch { /* gone */ } }
}

/** The room for a conversation's deck (`c.deckRoom` { id, key, token? }) on this site, or null when it can't be opened. */
export function openRoom(c, { getConv, onChange, onStatus, WS = globalThis.WebSocket, origin = globalThis.location && globalThis.location.origin } = {}) {
  const r = c && c.deckRoom;
  if (!r || !ROOM_ID.test(r.id || '') || !ROOM_KEY.test(r.key || '') || typeof WS !== 'function' || !origin) return null;
  const url = `${origin.replace(/^http/, 'ws')}/api/chat/deck-room/${r.id}`;
  const protocols = [PROTOCOL, ...(r.token && SEAT_TOKEN.test(r.token) ? [`seat.${r.token}`] : [])]; // the token in a header, never in the address
  return new RoomClient({ connect: () => new WS(url, protocols), key: r.key, getConv, onChange, onStatus });
}

/** A link that opens the deck room: the editor's address, then the room, the key and (for someone else) a seat token, after #. */
export function roomLink(origin, { id, key, token = '' }) {
  const p = new URLSearchParams({ room: id, key, ...(token ? { seat: token } : {}) });
  return `${String(origin).replace(/\/+$/, '')}/chat/#deck-room&${p}`;
}
/** The room in a link's #fragment, checked: { id, key, token } or null. */
export function readRoomLink(hash) {
  const m = /^#deck-room&(.*)$/.exec(String(hash || ''));
  if (!m) return null;
  const p = new URLSearchParams(m[1]);
  const id = p.get('room') || '', key = p.get('key') || '', token = p.get('seat') || '';
  return ROOM_ID.test(id) && ROOM_KEY.test(key) && (!token || SEAT_TOKEN.test(token)) ? { id, key, ...(token ? { token } : {}) } : null;
}

/**
 * The room's rules in memory (the tests; askeden.com's DeckRoom follows the same ones): versions kept by id (the newest
 * 40), the latest comment list, presence passed on, a newcomer welcomed with what it lacks. `roleOf(token)` stands in
 * for the account and share check: 'owner', 'collaborator', 'viewer' or null (refused).
 */
export class MockRoom {
  constructor({ roleOf = () => 'owner' } = {}) { this.roleOf = roleOf; this.conns = new Set(); this.versions = new Map(); this.cm = null; this.n = 0; }
  connect(token = '') {
    const room = this;
    const role = this.roleOf(token);
    const conn = {
      readyState: 0, onopen: null, onmessage: null, onclose: null, id: `c${++this.n}`, role,
      send(s) { if (conn.readyState === 1) room.receive(conn, s); },
      close(code = 1000) { if (conn.readyState === 3) return; conn.readyState = 3; room.conns.delete(conn); for (const o of room.conns) o.deliver({ t: 'left', from: conn.id }); queueMicrotask(() => conn.onclose && conn.onclose({ code })); },
      deliver(m) { if (conn.readyState === 1 && conn.onmessage) { const data = JSON.stringify(m); queueMicrotask(() => conn.onmessage({ data })); } },
    };
    queueMicrotask(() => {
      if (!role) { conn.readyState = 3; if (conn.onclose) conn.onclose({ code: 4403 }); return; }
      conn.readyState = 1; room.conns.add(conn); if (conn.onopen) conn.onopen();
    });
    return conn;
  }
  /** Every connection closed with `code` (4403: the share was revoked). */
  kick(code = 4403) { for (const c of [...this.conns]) c.close(code); }
  receive(from, s) {
    if (typeof s !== 'string' || s.length > MAX_MESSAGE) { from.deliver({ t: 'error', code: 'too_big' }); return; }
    let m; try { m = JSON.parse(s); } catch { from.deliver({ t: 'error', code: 'bad_request' }); return; }
    const write = from.role === 'owner' || from.role === 'collaborator';
    if (m.t === 'hello') {
      const since = new Set(Array.isArray(m.since) ? m.since : []);
      from.deliver({ t: 'welcome', me: from.id, role: from.role, ids: [...this.versions.keys()] });
      for (const v of [...this.versions.values()].sort((a, b) => a.at - b.at)) if (!since.has(v.id)) from.deliver({ t: 'version', ...v, from: 'room' });
      if (this.cm) from.deliver({ t: 'comments', ...this.cm, from: 'room' });
      return;
    }
    if ((m.t === 'version' && !write) || (m.t === 'comments' && !write && from.role !== 'commenter')) { from.deliver({ t: 'error', code: 'forbidden' }); return; }
    if (m.t === 'version') {
      if (!this.versions.has(m.id)) this.versions.set(m.id, { id: m.id, at: m.at, enc: m.enc });
      const all = [...this.versions.values()].sort((a, b) => a.at - b.at);
      for (const v of all.slice(0, Math.max(0, all.length - 40))) this.versions.delete(v.id);
      for (const c of this.conns) if (c !== from) c.deliver({ t: 'version', id: m.id, at: m.at, enc: m.enc, from: from.id });
    } else if (m.t === 'comments') {
      this.cm = { at: m.at, enc: m.enc };
      for (const c of this.conns) if (c !== from) c.deliver({ t: 'comments', at: m.at, enc: m.enc, from: from.id });
    } else if (m.t === 'presence') {
      for (const c of this.conns) if (c !== from) c.deliver({ t: 'presence', enc: m.enc, from: from.id });
    } else from.deliver({ t: 'error', code: 'bad_request' });
  }
}

const random = (n) => b64u(globalThis.crypto.getRandomValues(new Uint8Array(n)));
/**
 * The owner opens a deck for editing together: a shared chat in "collaborate" mode (askeden.com keeps only ciphertext)
 * with two seats, one that may edit and one that may only watch. `post(path, body)` sends JSON to Eden (api.js
 * postJSON). → `c.deckRoom` { id, key, owner: true, links: { edit, view } } (the conversation is changed; save it).
 */
export async function startRoom(c, { post, origin = globalThis.location && globalThis.location.origin }) {
  const key = random(32);
  const seats = [{ id: random(6), role: 'collaborator', token: random(24) }, { id: random(6), role: 'viewer', token: random(24) }];
  const blob = await seal({ kind: 'deck-room', title: String((c.deckVersions || []).at(-1)?.deck?.title || c.title || 'Slides').slice(0, 160) }, key, 'share');
  const res = await post('/api/chat/share', { blob, expires: null, mode: 'collaborate', collaborators: seats });
  if (!res || !ROOM_ID.test(res.id || '')) throw new Error('Eden couldn’t open the deck for editing together.');
  c.deckRoom = { id: res.id, key, owner: true, seats: seats.map((x) => ({ ...x, created: Date.now(), label: x.role === 'viewer' ? 'View link' : 'Edit link' })), links: { edit: roomLink(origin, { id: res.id, key, token: seats[0].token }), view: roomLink(origin, { id: res.id, key, token: seats[1].token }) } };
  return c.deckRoom;
}
/** The owner stops editing together: the share is revoked (the room closes and forgets everything). */
export async function stopRoom(c, { post }) {
  if (!c || !c.deckRoom || !c.deckRoom.owner) return;
  await post('/api/chat/shares/revoke', { id: c.deckRoom.id });
  delete c.deckRoom;
}
