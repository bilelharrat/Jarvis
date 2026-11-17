// Creative rooms (docs/creative-rooms.md): editing one Creative Suite project together. One Durable
// Object per shared project (`CreativeRoom`, binding CREATIVE_ROOMS, migration creative-rooms-v1),
// named `room:<id>` (16 random bytes, base64url). The same class serves the index objects
// `idx:acct:<account>` and `idx:mail:<SHA-256 hex of the lower-cased email>`, which list the rooms an
// account has, or an email was invited to.
//
// The room never runs or reads the project's commands: it puts them in one order, keeps the log, the
// latest snapshot for late joiners, the people, the comments and the activity, and relays presence.
// A room keeps:
//
//   meta                 { id, name, owner, created, head (the last seq), cum (bytes of every op ever
//                          ordered), snap: { gen, seq, hash, bytes, chunks, cum } | null, settings:
//                          { invite }, members: { key → member }, nextSlot, nextComment, comments
//                          (comments and replies kept), actN, overQuota }
//   op:<seq, 16 digits>  an ordered command: { seq, id, by, name, slot, at, base, label, via, note, op,
//                        cum } (`op` stays the app's string: never parsed here, so its ids keep their
//                        precision; `cum` is meta.cum after it, so the log's bytes past any seq are known)
//   oid:<key>:<n|s><id>  the seq of that author's op id: a re-send answers with the entry it already has
//   chk:<seq>            the editors' project hashes at seq, [[member key, hash], …] in order, from `check`
//
// A member is { key, pk, account, name, email, role, slot, status, at }. `key` is the account id, or
// `mail:<hash>` for a pending invite, and never leaves the room: members, frames and the listing name
// people by `pk`, a random key of this room's (`m_` and 12 base64url characters), so an account id is
// never shown to anyone else.
//   snap:<gen>:<i>       the snapshot, in 1 MiB chunks; a new upload writes a new generation, then meta,
//                        then deletes the old one (and the log up to it)
//   cm:<id>              a comment and its replies
//   act:<n>              the activity feed, trimmed to the last 1000
//
// An index object keeps `r:<room id>` → { id, name, role, owner, ownerName, status, at }. Only rooms
// write them (the Worker never forwards a path that reaches them).
//
// Identity comes from the Worker as x-eden-account, x-eden-name and x-eden-email (name and email
// percent-encoded), set from the verified token (rooms-auth.js); a Durable Object can only be reached
// through the Worker, which passes on only the headers a room needs, never one of these from outside.

import { ApiError, b64url, cleanName, hex, json, randomBytes, readJson, safeDecode, sha256Hex } from '../accounts/util.js';
import { verifyCreativeToken } from './rooms-auth.js';

export const ROOMS = {
  people: 20, // members and pending invites
  owned: 50, // rooms one account owns
  indexed: 1000, // rooms one index object lists
  opBytes: 256 * 1024,
  logBytes: 32 * 1024 * 1024, // the log past the snapshot, in bytes of ops: then ops wait for a snapshot
  accountBytes: 1024 * 1024 * 1024, // what the rooms an account owns may keep (logs and snapshots) together
  usageStep: 1024 * 1024, // a room tells its owner's index its size each time it grows past another step
  ops: 120, // per socket per opWindow
  opWindow: 10_000,
  presence: 10, // per socket a second; the rest is dropped
  hellos: 2, // per socket per helloWindow
  helloWindow: 10_000,
  replayOps: 2000, // a hello further behind than this, or than replayBytes, starts again from the snapshot
  replayBytes: 4 * 1024 * 1024,
  frames: 60, // hello, comment, check and note frames per socket per frameWindow
  frameWindow: 10_000,
  frame: 800_000, // the longest text frame read (a 256 KiB op, JSON-escaped)
  invitesPerDay: 50, // invites one account sends, across its rooms
  invitesPerEmailDay: 10, // new rooms one email address is invited to
  reverify: 5 * 60_000, // an open socket's token is checked again this often
  socketLife: 12 * 3600_000, // then the socket closes (4005) and the app opens a new one
  commentChars: 4000,
  comments: 2000, // comments and replies a room keeps
  replies: 200, // a comment's replies
  mentions: 20,
  noteChars: 1000,
  labelChars: 200,
  selection: 64,
  snapshotWanted: 500, // ops past the snapshot before the editors' apps are asked for one
  logMax: 20_000, // ops past the snapshot: then ops are refused until one is uploaded
  snapshotBytes: 64 * 1024 * 1024,
  chunk: 1024 * 1024,
  activityKept: 1000,
  activityWelcome: 200,
  activityPage: 100,
  socketsPerMember: 5,
  welcomeBudget: 900_000, // characters of ops (and of comments) in a welcome; the rest follow as frames
};

const BASE = '/api/creative/rooms';
const ROOM_ID = /^[A-Za-z0-9_-]{22}$/;
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAIL_KEY = /^mail:[0-9a-f]{64}$/;
// What the members of a room know each other by: a key of this room's own, never an account id (which elsewhere on
// askeden.com names the account) or an email's hash.
const PK = /^m_[A-Za-z0-9_-]{12}$/;
const newPk = () => `m_${b64url(randomBytes(9))}`;
const OP_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const HASH = /^[A-Za-z0-9_.:+/=-]{1,128}$/;
const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:".]+(\.[^\s@<>()[\]\\,;:".]+)+$/;
const RANK = { view: 0, comment: 1, edit: 2, owner: 3 };
const GIVEN = new Set(['edit', 'comment', 'view']);
const INVITE = new Set(['owner', 'editors']);
const OPEN = 1;

const bad = (message, code = 'bad_request') => new ApiError(400, code, message);
const notFound = () => new ApiError(404, 'not_found', 'That room isn’t one you’re in.');
const ownerOnly = (what = 'do that') => new ApiError(403, 'forbidden', `Only the room’s owner can ${what}.`);

const pad = (n, width = 16) => String(n).padStart(width, '0');
const opKey = (seq) => `op:${pad(seq)}`;
const chkKey = (seq) => `chk:${pad(seq)}`;
/** The editors' checks at a seq, in the order they came: [[member key, hash], …]. */
const checksOf = (stored) => (Array.isArray(stored) ? stored : []);
const cmKey = (id) => `cm:${pad(id)}`;
const actKey = (n) => `act:${pad(n)}`;
const chunkKey = (gen, i) => `snap:${gen}:${pad(i, 6)}`;
const oidKey = (key, id) => `oid:${key}:${typeof id === 'number' ? 'n' : 's'}${id}`;

// ── what comes in: every field is checked as if hostile ──

export function cleanEmail(value) {
  if (typeof value !== 'string') return '';
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : '';
}

const validAccount = (account) => typeof account === 'string' && ACCOUNT.test(account) && account !== 'me';

/** The verified identity, cleaned: { account, name, email } or null. */
export function cleanWho(who) {
  if (!who || typeof who !== 'object' || !validAccount(who.account)) return null;
  const email = cleanEmail(who.email);
  return { account: who.account, name: cleanName(who.name, email ? email.split('@')[0] : 'Someone'), email };
}

function line(value, max, what) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw bad(`${what} must be text.`);
  const text = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').trim();
  if (text.length > max) throw new ApiError(413, 'too_big', `${what} is at most ${max} characters.`);
  return text;
}

function words(value, max, what) {
  if (typeof value !== 'string') throw bad(`${what} must be text.`);
  const text = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (!text) throw bad(`${what} is empty.`);
  if (text.length > max) throw new ApiError(413, 'too_big', `${what} is at most ${max} characters.`);
  return text;
}

// Ids (sequences, clips, comments) are safe integers, 0 or more; times are the engine's ticks.
function anId(value, what, { nullable = false } = {}) {
  if (nullable && (value === undefined || value === null)) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw bad(`${what} must be a whole number (a safe integer, 0 or more).`);
  return value;
}

function ticks(value, what, { nullable = false } = {}) {
  if (nullable && (value === undefined || value === null)) return null;
  if (!Number.isSafeInteger(value)) throw bad(`${what} must be a whole number of ticks (a safe integer).`);
  return value;
}

/** An app's own id for an op or a comment: a safe integer, or up to 64 of A–Z a–z 0–9 _ . : - */
function appId(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && OP_ID.test(value)) return value;
  return null;
}

function utf8Length(text) {
  if (text.length * 3 <= ROOMS.opBytes) return text.length; // short enough whatever it holds
  return new TextEncoder().encode(text).length;
}

function presenceOf(msg, role) {
  const editing = RANK[role] >= RANK.edit;
  if (msg.doing !== undefined && msg.doing !== null && msg.doing !== 'editing' && msg.doing !== 'viewing') throw bad('doing is "editing" or "viewing".');
  let selection = [];
  if (msg.selection !== undefined && msg.selection !== null) {
    if (!Array.isArray(msg.selection) || msg.selection.length > ROOMS.selection) throw bad(`selection is a list of at most ${ROOMS.selection} clip ids.`);
    selection = [...new Set(msg.selection.map((id) => anId(id, 'A selected clip id')))];
  }
  const lock = anId(msg.lock, 'lock', { nullable: true });
  return {
    sequence: anId(msg.sequence, 'sequence', { nullable: true }),
    playhead: ticks(msg.playhead, 'playhead', { nullable: true }),
    selection,
    lock: editing ? lock : null,
    doing: editing && msg.doing === 'editing' ? 'editing' : 'viewing',
  };
}

function mentionsOf(value, meta) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > ROOMS.mentions) throw bad(`mentions is a list of at most ${ROOMS.mentions} member keys.`);
  for (const key of value) {
    const m = memberByPk(meta, key);
    if (!m || m.status !== 'in') throw bad('A mention must be someone in the room.', 'bad_mention');
  }
  return [...new Set(value)];
}

/** The member a room-scoped key names, or null. */
function memberByPk(meta, pk) {
  if (typeof pk !== 'string' || !PK.test(pk)) return null;
  return Object.values(meta.members).find((m) => m.pk === pk) || null;
}

// ── what goes out ──

// Members see each other's room keys, names and emails (to invite and to tell people apart), never an account id.
const memberView = (m, here) => ({ key: m.pk, name: m.name, email: m.email, role: m.role, slot: m.slot, status: m.status, here: here.has(m.key) });
const membersOf = (meta, here) => Object.values(meta.members).sort((a, b) => a.slot - b.slot).map((m) => memberView(m, here));
const snapshotView = (snap) => (snap ? { seq: snap.seq, hash: snap.hash, bytes: snap.bytes } : null);
const indexName = (m) => (m.status === 'in' ? `idx:acct:${m.account}` : `idx:mail:${m.key.slice(5)}`);
const entryOf = (meta, m) => ({ id: meta.id, name: meta.name, role: m.role, owner: meta.owner, ownerName: (meta.members[meta.owner] || {}).name || '', status: m.status, at: m.at });
/** An op as it goes out: without `cum`, the room's own bookkeeping. */
const opFrame = ({ cum: _cum, ...entry }, framed = true) => (framed ? { t: 'op', ...entry } : entry);
const ownerPk = (meta) => (meta.members[meta.owner] || {}).pk || null;
/** The log past the snapshot, in bytes of ops (`cum` counts every op's bytes since the room began). */
const logBytesOf = (meta) => (meta.cum || 0) - ((meta.snap && meta.snap.cum) || 0);
const roomBytesOf = (meta) => logBytesOf(meta) + ((meta.snap && meta.snap.bytes) || 0);

export class CreativeRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.storage = ctx.storage;
    this.env = env || {};
    this.now = () => Date.now();
    this.chain = Promise.resolve(); // one change at a time, whatever it waits on
    this.rates = new Map(); // socket id → its counters (lost on hibernation, which only comes when quiet)
    this.attachments = new WeakMap(); // where a socket's attachment lives when the runtime has no serializeAttachment
    this.replaying = new Map(); // socket id → frames held for it while a hello's catch-up goes out (in order after it)
    this.verify = (request) => verifyCreativeToken(request, this.env); // an open socket's token, checked again
    if (ctx.setWebSocketAutoResponse && globalThis.WebSocketRequestResponsePair) {
      ctx.setWebSocketAutoResponse(new globalThis.WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    }
  }

  serial(fn) {
    const run = this.chain.then(() => fn());
    this.chain = run.then(() => {}, () => {});
    return run;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean).map(safeDecode);
    const method = request.method;
    try {
      if (parts[0] === 'idx') return await this.indexOp(parts[1] || '', request);
      // An account being deleted (forgetAccount): only the Worker's own code calls this, never a request from outside.
      if (parts[0] === 'forget' && method === 'POST') return json(await this.forget(await readJson(request, 16_384)));
      const who = identityFrom(request.headers);
      if (!who) throw new ApiError(401, 'not_connected', 'Link this app to your Eden account again.');
      const [what = '', key] = parts;
      if (what === 'create' && method === 'POST') return json(await this.create(who, await readJson(request, 16_384)), 201);
      if (what === '' && method === 'GET') return json(await this.locked(who, (meta, me) => ({ room: this.view(meta, me) })));
      if (what === '' && method === 'PATCH') return json(await this.update(who, await readJson(request, 16_384)));
      if (what === '' && method === 'DELETE') return json(await this.destroy(who));
      if (what === 'invite' && method === 'POST') return json(await this.invite(who, await readJson(request, 16_384)), 201);
      if (what === 'members' && key && method === 'PATCH') return json(await this.changeRole(who, key, await readJson(request, 16_384)));
      if (what === 'members' && key && method === 'DELETE') return json(await this.removeMember(who, key));
      if (what === 'snapshot' && method === 'PUT') return json(await this.putSnapshot(request, who));
      if (what === 'snapshot' && method === 'GET') return await this.getSnapshot(who);
      if (what === 'activity' && method === 'GET') return json(await this.olderActivity(who, url.searchParams.get('before')));
      if (what === 'socket' && method === 'GET') return await this.socket(request, who);
      throw new ApiError(404, 'not_found', 'No such thing.');
    } catch (error) {
      if (error instanceof ApiError) return error.response();
      throw error;
    }
  }

  // ── sockets ──

  // Overridable in tests: a WebSocket pair, the server end accepted with these tags.
  upgrade(tags) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, tags);
    return { response: new Response(null, { status: 101, webSocket: client }), server };
  }

  sockets(tag) {
    const all = this.ctx.getWebSockets ? this.ctx.getWebSockets(tag) : [];
    return all.filter((ws) => ws.readyState === undefined || ws.readyState === OPEN);
  }

  attachmentOf(ws) {
    if (typeof ws.deserializeAttachment === 'function') return ws.deserializeAttachment() || null;
    return this.attachments.get(ws) || null;
  }

  attach(ws, value) {
    if (typeof ws.serializeAttachment === 'function') ws.serializeAttachment(value);
    else this.attachments.set(ws, value);
  }

  hereKeys() {
    const keys = new Set();
    for (const ws of this.sockets()) {
      const att = this.attachmentOf(ws);
      if (att) keys.add(att.key);
    }
    return keys;
  }

  tell(ws, frame) {
    try {
      ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
    } catch {
      // gone
    }
  }

  drop(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  broadcast(frame, exceptSid = null) {
    const text = JSON.stringify(frame);
    for (const ws of this.sockets()) {
      const sid = (this.attachmentOf(ws) || {}).sid;
      if (exceptSid && sid === exceptSid) continue;
      const held = this.replaying.get(sid);
      if (held) held.push(text);
      else this.tell(ws, text);
    }
  }

  broadcastMembers(meta) {
    this.broadcast({ t: 'members', members: membersOf(meta, this.hereKeys()) });
  }

  rateOf(sid) {
    if (!this.rates.has(sid)) this.rates.set(sid, { op: [0, 0], presence: [0, 0], frames: [0, 0], hello: [0, 0] });
    return this.rates.get(sid);
  }

  allow(rate, kind, limit, window) {
    const now = this.now();
    const r = rate[kind];
    if (now - r[0] >= window) {
      r[0] = now;
      r[1] = 0;
    }
    r[1] += 1;
    return r[1] <= limit;
  }

  async socket(request, who) {
    if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') throw new ApiError(426, 'bad_request', 'The live line speaks WebSocket.');
    // The token the socket opened with, and the address it came to, so it can be checked again while the socket is
    // open (`reverify`): the Worker hands them over for the socket route only. They live in the socket's
    // attachment, never in the room's storage.
    const token = request.headers.get('x-eden-token') || '';
    const origin = request.headers.get('x-eden-origin') || '';
    return this.locked(who, async (meta, me) => {
      if (this.sockets(`k:${me.key}`).length >= ROOMS.socketsPerMember) throw new ApiError(429, 'too_many', `At most ${ROOMS.socketsPerMember} of your apps can be in a room at once.`);
      const { response, server } = this.upgrade([`k:${me.key}`]);
      const now = this.now();
      this.attach(server, { sid: hex(randomBytes(8)), key: me.key, pk: me.pk, at: now, verified: now, token, origin, presence: null, pat: 0 });
      await this.armAlarm();
      return response;
    });
  }

  async webSocketMessage(ws, message) {
    // A socket whose token is due to be checked again is checked first, outside the room's queue (it waits on the
    // account's own object).
    if (!(await this.stillValid(ws))) return;
    const then = await this.serial(() => this.onMessage(ws, message));
    // A hello's catch-up goes out after the queue moves on (frames meanwhile are held for that socket, in order).
    if (typeof then === 'function') {
      await then().catch((error) => {
        console.error('creative room: a catch-up failed', error && error.message);
        this.drop(ws, 1011, 'try again');
      });
    }
  }

  /** Whether a socket may go on: its token checked again every `reverify` (4003 when it no longer verifies, as when
   *  it's revoked), and at most `socketLife` old (4005: the app opens a new one). */
  async stillValid(ws, now = this.now()) {
    const att = this.attachmentOf(ws);
    if (!att) return true; // onMessage drops it
    if (now - att.at >= ROOMS.socketLife) {
      this.tell(ws, { t: 'error', code: 'expired', message: 'Reconnecting to the room.' });
      this.drop(ws, 4005, 'expired');
      return false;
    }
    if (now - (att.verified || att.at) < ROOMS.reverify) return true;
    let who = null;
    try {
      if (att.token && att.origin) who = cleanWho(await this.verify(new Request(att.origin, { headers: { authorization: `Bearer ${att.token}` } })));
    } catch (error) {
      if (!(error instanceof ApiError) || error.status >= 500) return true; // the accounts side is down: try again later
    }
    if (!who || who.account !== att.key) {
      this.tell(ws, { t: 'error', code: 'not_connected', message: 'Link this app to your Eden account again.' });
      this.drop(ws, 4003, 'not connected');
      return false;
    }
    this.attach(ws, { ...(this.attachmentOf(ws) || att), verified: now });
    return true;
  }

  /** While sockets are open, the room wakes every `reverify` to check them, quiet ones included. */
  async armAlarm() {
    if (typeof this.storage.setAlarm !== 'function') return;
    const at = typeof this.storage.getAlarm === 'function' ? await this.storage.getAlarm() : null;
    if (!at) await this.storage.setAlarm(this.now() + ROOMS.reverify);
  }

  async alarm() {
    if (!(await this.storage.get('meta'))) return; // an index object, or a deleted room
    const now = this.now();
    for (const ws of this.sockets()) await this.stillValid(ws, now);
    if (this.sockets().length && typeof this.storage.setAlarm === 'function') await this.storage.setAlarm(now + ROOMS.reverify);
  }

  async webSocketClose(ws) {
    return this.serial(() => this.onClose(ws));
  }

  async webSocketError(ws) {
    return this.webSocketClose(ws);
  }

  async onClose(ws) {
    this.drop(ws, 1000, 'bye');
    const att = this.attachmentOf(ws);
    if (!att) return;
    this.rates.delete(att.sid);
    this.replaying.delete(att.sid);
    const still = this.sockets(`k:${att.key}`).some((o) => o !== ws && (this.attachmentOf(o) || {}).sid !== att.sid);
    if (!still) this.broadcast({ t: 'left', key: att.pk }, att.sid);
  }

  async onMessage(ws, message) {
    const att = this.attachmentOf(ws);
    if (!att) return this.drop(ws, 1011, 'unknown socket');
    if (typeof message !== 'string') return this.tell(ws, { t: 'error', code: 'bad_request', message: 'Send JSON text frames.' });
    if (message.length > ROOMS.frame) return this.tell(ws, { t: 'error', code: 'too_big', message: 'That message is too big.' });
    let msg = null;
    try {
      msg = JSON.parse(message);
    } catch {
      // below
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return this.tell(ws, { t: 'error', code: 'bad_request', message: 'Send a JSON object with its "t".' });
    const meta = await this.storage.get('meta');
    if (!meta) {
      this.tell(ws, { t: 'deleted' });
      return this.drop(ws, 4002, 'deleted');
    }
    const me = Object.hasOwn(meta.members, att.key) ? meta.members[att.key] : null;
    if (!me || me.status !== 'in') {
      this.tell(ws, { t: 'removed' });
      return this.drop(ws, 4001, 'removed');
    }
    const rate = this.rateOf(att.sid);
    const about = msg.t === 'op' && appId(msg.id) !== null ? { id: appId(msg.id) } : msg.t === 'comment' && appId(msg.cid) !== null ? { cid: appId(msg.cid) } : {};
    try {
      if (msg.t === 'presence') return this.onPresence(ws, att, me, msg, rate);
      if (msg.t === 'op') return await this.onOp(ws, meta, me, msg, rate);
      if (!['hello', 'comment', 'check', 'note'].includes(msg.t)) throw bad('That message isn’t one the room knows.');
      if (!this.allow(rate, 'frames', ROOMS.frames, ROOMS.frameWindow)) throw new ApiError(429, 'slow_down', 'Too many messages at once; wait a few seconds.');
      if (msg.t === 'hello' && !this.allow(rate, 'hello', ROOMS.hellos, ROOMS.helloWindow)) throw new ApiError(429, 'slow_down', 'The room is catching you up already; wait a few seconds.');
      if (msg.t === 'hello') return await this.onHello(ws, att, meta, me, msg);
      if (msg.t === 'comment') return await this.onComment(meta, me, msg);
      if (msg.t === 'check') return await this.onCheck(ws, meta, me, msg);
      return this.onNote(ws, meta, me, msg);
    } catch (error) {
      if (!(error instanceof ApiError)) console.error('creative room: a message failed', error && error.message);
      const known = error instanceof ApiError;
      return this.tell(ws, { t: 'error', code: known ? error.code : 'server', message: known ? error.message : 'Something broke in the room. Try again.', ...(known ? error.extra : {}), ...about });
    }
  }

  onPresence(ws, att, me, msg, rate) {
    if (!this.allow(rate, 'presence', ROOMS.presence, 1000)) return; // over the rate: dropped, silently
    const presence = presenceOf(msg, me.role);
    this.attach(ws, { ...att, presence, pat: this.now() });
    this.broadcast({ t: 'presence', key: me.pk, name: me.name, slot: me.slot, ...presence }, att.sid);
  }

  async onOp(ws, meta, me, msg, rate) {
    const id = appId(msg.id);
    if (id === null) throw bad('An op needs its id: a safe integer, or up to 64 of A–Z a–z 0–9 _ . : -');
    if (RANK[me.role] < RANK.edit) throw new ApiError(403, 'forbidden', me.role === 'comment' ? 'You can comment in this room, not edit.' : 'You can watch this room, not edit it.');
    if (!this.allow(rate, 'op', ROOMS.ops, ROOMS.opWindow)) throw new ApiError(429, 'slow_down', 'Too many changes at once; wait a few seconds.');
    const base = anId(msg.base, 'base');
    if (msg.via !== undefined && msg.via !== null && msg.via !== 'eden') throw bad('via is "eden" or null.');
    const via = msg.via === 'eden' ? 'eden' : null;
    const label = line(msg.label, ROOMS.labelChars, 'An op’s label');
    const note = msg.note === undefined || msg.note === null ? null : line(msg.note, ROOMS.noteChars, 'An op’s note') || null;
    if (typeof msg.op !== 'string' || !msg.op) throw bad('op is the command, as a string.');
    const bytes = utf8Length(msg.op);
    if (bytes > ROOMS.opBytes) throw new ApiError(413, 'too_big', `A change is at most ${ROOMS.opBytes / 1024} KiB.`);
    // The same op again (a reconnect re-sends what wasn't confirmed): its entry, to this socket only.
    const known = await this.storage.get(oidKey(me.key, id));
    if (known !== undefined) {
      const entry = await this.storage.get(opKey(known));
      if (entry) return this.tell(ws, opFrame(entry));
      throw new ApiError(409, 'in_snapshot', 'That change is already in the room’s snapshot.', {}, { seq: known });
    }
    if (base > meta.head) throw new ApiError(409, 'bad_base', 'That change was made on a newer version than the room has.');
    const low = meta.snap ? meta.snap.seq : 0;
    if (meta.head - low >= ROOMS.logMax || logBytesOf(meta) + bytes > ROOMS.logBytes) {
      this.wantSnapshot(meta);
      throw new ApiError(409, 'log_full', 'The room’s log is full: an editor’s app saves a snapshot first.');
    }
    if (meta.overQuota) throw new ApiError(409, 'quota', 'The owner’s shared projects are using all the room they have. Delete one, or wait for a snapshot to make room.');
    const seq = meta.head + 1;
    const step = Math.floor(roomBytesOf(meta) / ROOMS.usageStep);
    meta.cum = (meta.cum || 0) + bytes;
    const entry = { seq, id, by: me.pk, name: me.name, slot: me.slot, at: this.now(), base, label, via, note, op: msg.op };
    meta.head = seq;
    const act = this.newActivity(meta, me, 'op', via === 'eden' ? `asked Eden: ${label || 'a change'}` : label || 'made a change', { seq, via });
    // `cum` (every op's bytes so far) is kept with the entry, so a snapshot at this seq knows the log's size up to it
    await this.save(meta, { [opKey(seq)]: { ...entry, cum: meta.cum }, [oidKey(me.key, id)]: seq }, [act]);
    this.broadcast({ t: 'op', ...entry });
    this.broadcast({ t: 'activity', activity: act });
    const length = seq - low;
    if (length >= ROOMS.snapshotWanted && length % ROOMS.snapshotWanted === 0) this.wantSnapshot(meta);
    if (Math.floor(roomBytesOf(meta) / ROOMS.usageStep) !== step) await this.reportUsage(meta);
  }

  /** Tells the owner's index how much this room keeps; over the account's quota, the room takes no more ops (and no
   *  bigger snapshot) until it's under again. */
  async reportUsage(meta, bytes = roomBytesOf(meta)) {
    let total = 0;
    try {
      ({ total = 0 } = await this.askIndex(`idx:acct:${meta.owner}`, 'usage', { id: meta.id, bytes }));
    } catch (error) {
      console.error('creative room: usage report failed', error && error.message);
      return;
    }
    const over = total > ROOMS.accountBytes;
    if (Boolean(meta.overQuota) !== over) {
      meta.overQuota = over;
      await this.storage.put('meta', meta);
    }
  }

  wantSnapshot(meta, only = null) {
    for (const ws of only ? [only] : this.sockets()) {
      const m = meta.members[(this.attachmentOf(ws) || {}).key];
      if (m && RANK[m.role] >= RANK.edit) this.tell(ws, { t: 'snapshot_wanted', seq: meta.head });
    }
  }

  /** The welcome, then the catch-up. In the room's queue only the decision is made (where the app is, and whether it
   *  starts again from the snapshot); the reading and sending happen after, in the returned function, while frames
   *  for this socket are held and sent after it, in order. */
  async onHello(ws, att, meta, me, msg) {
    const since = msg.since === undefined || msg.since === null ? 0 : msg.since;
    if (!Number.isSafeInteger(since) || since < 0) throw bad('since is the last seq the app has (a safe integer).');
    const low = meta.snap ? meta.snap.seq : 0;
    const to = meta.head;
    let resync = since < low || since > to || to - since > ROOMS.replayOps;
    if (!resync && since < to) {
      // too many bytes behind: the snapshot is quicker for everyone
      const from = since > 0 ? await this.storage.get(opKey(since)) : null;
      const before = from ? from.cum || 0 : (meta.snap && meta.snap.cum) || 0;
      resync = (meta.cum || 0) - before > ROOMS.replayBytes;
    }
    const here = this.hereKeys();
    const welcome = { t: 'welcome', you: memberView(me, here), room: this.view(meta, me, here), presence: this.presenceOthers(att.sid, meta) };
    const wantSnapshot = to - low >= ROOMS.snapshotWanted;
    const held = [];
    this.replaying.set(att.sid, held);
    return async () => {
      try {
        let next = null; // the seq the ops go on from, after the welcome
        if (resync) welcome.resync = true;
        else {
          welcome.ops = [];
          let budget = ROOMS.welcomeBudget;
          for await (const entry of this.log(since + 1, to)) {
            const size = entry.op.length + 300;
            if (welcome.ops.length && size > budget) {
              next = entry.seq;
              break;
            }
            budget -= size;
            welcome.ops.push(opFrame(entry, false));
          }
        }
        welcome.comments = [];
        let commentsFrom = null;
        let budget = ROOMS.welcomeBudget;
        for await (const comment of this.allComments()) {
          const size = JSON.stringify(comment).length;
          if (welcome.comments.length && size > budget) {
            commentsFrom = comment.id;
            break;
          }
          budget -= size;
          welcome.comments.push(comment);
        }
        welcome.activity = [...(await this.storage.list({ prefix: 'act:', reverse: true, limit: ROOMS.activityWelcome })).values()];
        if (next !== null || commentsFrom !== null) welcome.more = true;
        this.tell(ws, welcome);
        // Too much for one frame: the rest at once, in order, as the frames that would have brought them.
        if (next !== null) for await (const entry of this.log(next, to)) this.tell(ws, opFrame(entry));
        if (commentsFrom !== null) for await (const comment of this.allComments(commentsFrom)) this.tell(ws, { t: 'comment', comment });
      } finally {
        // what happened meanwhile, in the order it happened
        if (this.replaying.get(att.sid) === held) this.replaying.delete(att.sid);
        for (const text of held) this.tell(ws, text);
      }
      const now = wantSnapshot ? await this.storage.get('meta') : null;
      if (now) this.wantSnapshot(now, ws);
    };
  }

  async *log(from, to) {
    let next = from;
    while (next <= to) {
      const page = await this.storage.list({ prefix: 'op:', start: opKey(next), end: opKey(to + 1), limit: 64 });
      if (!page.size) return;
      for (const entry of page.values()) {
        yield entry;
        next = entry.seq + 1;
      }
    }
  }

  async *allComments(from = 0) {
    let start = cmKey(from);
    for (;;) {
      const page = await this.storage.list({ prefix: 'cm:', start, limit: 64 });
      if (!page.size) return;
      for (const comment of page.values()) {
        yield comment;
        start = cmKey(comment.id + 1);
      }
      if (page.size < 64) return;
    }
  }

  presenceOthers(sid, meta) {
    const latest = new Map();
    for (const ws of this.sockets()) {
      const att = this.attachmentOf(ws);
      if (!att || att.sid === sid || !att.presence) continue;
      const m = meta.members[att.key];
      if (!m) continue;
      const had = latest.get(att.key);
      if (!had || had.pat < att.pat) latest.set(att.key, { pat: att.pat, value: { key: m.pk, name: m.name, slot: m.slot, ...att.presence } });
    }
    return [...latest.values()].map((p) => p.value);
  }

  async onComment(meta, me, msg) {
    if (RANK[me.role] < RANK.comment) throw new ApiError(403, 'forbidden', 'You can watch this room, not comment.');
    const cid = appId(msg.cid);
    const extra = cid !== null ? { cid } : {};
    if (msg.op === 'add') {
      if (meta.comments >= ROOMS.comments) throw new ApiError(409, 'too_many', `A room keeps at most ${ROOMS.comments} comments.`);
      const comment = {
        id: 0,
        by: me.pk,
        name: me.name,
        at: this.now(),
        sequence: anId(msg.sequence, 'sequence'),
        clip: anId(msg.clip, 'clip', { nullable: true }),
        offset: ticks(msg.offset ?? 0, 'offset'),
        time: ticks(msg.time ?? 0, 'time'),
        text: words(msg.text, ROOMS.commentChars, 'A comment'),
        mentions: mentionsOf(msg.mentions, meta),
        replies: [],
        resolved: false,
        resolvedBy: null,
      };
      comment.id = meta.nextComment += 1;
      meta.comments += 1;
      const act = this.newActivity(meta, me, 'comment', comment.text.slice(0, 140));
      await this.save(meta, { [cmKey(comment.id)]: comment }, [act]);
      this.broadcast({ t: 'comment', comment, ...extra });
      return this.broadcast({ t: 'activity', activity: act });
    }
    if (!['reply', 'resolve', 'delete'].includes(msg.op)) throw bad('A comment’s op is "add", "reply", "resolve" or "delete".');
    const id = anId(msg.comment, 'comment');
    const comment = await this.storage.get(cmKey(id));
    if (!comment) throw new ApiError(404, 'not_found', 'That comment is gone.');
    if (msg.op === 'delete') {
      if (comment.by !== me.pk && me.role !== 'owner') throw new ApiError(403, 'forbidden', 'Only who wrote it, or the room’s owner, can delete a comment.');
      meta.comments = Math.max(0, meta.comments - 1 - comment.replies.length);
      await this.storage.put('meta', meta);
      await this.storage.delete(cmKey(id));
      return this.broadcast({ t: 'comment', comment: { id, deleted: true }, ...extra });
    }
    let act;
    if (msg.op === 'reply') {
      if (meta.comments >= ROOMS.comments) throw new ApiError(409, 'too_many', `A room keeps at most ${ROOMS.comments} comments.`);
      if (comment.replies.length >= ROOMS.replies) throw new ApiError(409, 'too_many', `A comment has at most ${ROOMS.replies} replies.`);
      const reply = { id: 0, by: me.pk, name: me.name, at: this.now(), text: words(msg.text, ROOMS.commentChars, 'A reply'), mentions: mentionsOf(msg.mentions, meta) };
      reply.id = meta.nextComment += 1;
      meta.comments += 1;
      comment.replies.push(reply);
      act = this.newActivity(meta, me, 'reply', reply.text.slice(0, 140));
    } else {
      if (typeof msg.resolved !== 'boolean') throw bad('resolved is true or false.');
      comment.resolved = msg.resolved;
      comment.resolvedBy = msg.resolved ? me.pk : null;
      act = this.newActivity(meta, me, 'resolve', msg.resolved ? 'resolved a comment' : 'reopened a comment');
    }
    await this.save(meta, { [cmKey(id)]: comment }, [act]);
    this.broadcast({ t: 'comment', comment, ...extra });
    this.broadcast({ t: 'activity', activity: act });
  }

  /** An app says what its project's hash is at a seq, and is told `diverged` when that differs from the room's snapshot
   *  at that seq, or else from the first editor's check there. Only editors' checks are kept (one per editor), so a
   *  viewer or commenter can be told about their own copy but never sway anyone else's; and a check holds back only
   *  that editor's own snapshot at that seq (snapshotAllowed), never another's. */
  async onCheck(ws, meta, me, msg) {
    const seq = anId(msg.seq, 'seq');
    if (typeof msg.hash !== 'string' || !HASH.test(msg.hash)) throw bad('hash is the project’s hash: up to 128 of A–Z a–z 0–9 _ . : + / = -');
    if (seq > meta.head) throw bad('That seq isn’t in the room yet.');
    const low = meta.snap ? meta.snap.seq : 0;
    if (seq < low) return; // already behind the snapshot: nothing to compare
    if (meta.snap && seq === meta.snap.seq) {
      if (msg.hash !== meta.snap.hash) this.tell(ws, { t: 'diverged', seq });
      return;
    }
    const checks = checksOf(await this.storage.get(chkKey(seq)));
    const first = checks.find(([key]) => key !== me.key);
    if (first && first[1] !== msg.hash) this.tell(ws, { t: 'diverged', seq });
    if (RANK[me.role] < RANK.edit) return;
    const mine = checks.find(([key]) => key === me.key);
    if (mine ? mine[1] === msg.hash : checks.length >= ROOMS.people) return;
    if (mine) mine[1] = msg.hash;
    else checks.push([me.key, msg.hash]);
    await this.storage.put(chkKey(seq), checks);
  }

  onNote(ws, meta, me, msg) {
    if (RANK[me.role] < RANK.comment) throw new ApiError(403, 'forbidden', 'You can watch this room, not send notes.');
    const to = memberByPk(meta, msg.to);
    if (!to || to.status !== 'in') throw new ApiError(404, 'not_found', 'That person isn’t in this room.');
    const frame = { t: 'note', from: me.pk, name: me.name, text: words(msg.text, ROOMS.noteChars, 'A note'), clip: anId(msg.clip, 'clip', { nullable: true }) };
    const targets = this.sockets(`k:${to.key}`);
    if (!targets.length) throw new ApiError(409, 'not_here', `${to.name} isn’t in the room right now.`);
    for (const target of targets) this.tell(target, frame);
  }

  // ── storage ──

  newActivity(meta, me, kind, text, { seq = null, via = null } = {}) {
    meta.actN += 1;
    return { n: meta.actN, at: this.now(), by: me.pk, name: me.name, kind, text, seq, via };
  }

  async save(meta, puts = {}, acts = []) {
    const batch = { meta, ...puts };
    for (const a of acts) batch[actKey(a.n)] = a;
    await this.storage.put(batch);
    if (acts.length && meta.actN > ROOMS.activityKept) {
      // everything older than the last activityKept (a few at a time, so a smaller limit catches up)
      const old = await this.storage.list({ prefix: 'act:', end: actKey(meta.actN - ROOMS.activityKept + 1), limit: 16 });
      if (old.size) await this.storage.delete([...old.keys()]);
    }
  }

  async deleteKeys(keys) {
    for (let i = 0; i < keys.length; i += 128) await this.storage.delete(keys.slice(i, i + 128));
  }

  async dropChunks(gen, count) {
    const keys = [];
    for (let i = 0; i < count; i++) keys.push(chunkKey(gen, i));
    await this.deleteKeys(keys);
  }

  // The log up to a new snapshot goes, and the checks before it. Op ids stay one snapshot longer, so a
  // re-send of an op the snapshot already holds is told so (`in_snapshot`), not ordered again.
  async compact(oldSeq, seq) {
    const ops = [];
    for (let s = oldSeq + 1; s <= seq; s++) ops.push(opKey(s));
    await this.deleteKeys(ops);
    await this.deleteKeys([...(await this.storage.list({ prefix: 'chk:', end: chkKey(seq + 1) })).keys()]);
    const ids = [];
    let startAfter;
    for (;;) {
      const page = await this.storage.list({ prefix: 'oid:', ...(startAfter ? { startAfter } : {}), limit: 1000 });
      for (const [key, at] of page) if (at <= oldSeq) ids.push(key);
      if (page.size < 1000) break;
      startAfter = [...page.keys()].pop();
    }
    await this.deleteKeys(ids);
  }

  // ── people ──

  /** Who's asking, in this room: their member, and a pending invite to their email becomes theirs. */
  async resolve(meta, who, convert, jobs) {
    const m = Object.hasOwn(meta.members, who.account) ? meta.members[who.account] : null;
    if (m) {
      if (m.name !== who.name || (who.email && m.email !== who.email)) {
        m.name = who.name;
        if (who.email) m.email = who.email;
        await this.storage.put('meta', meta);
      }
      return m;
    }
    if (!who.email) throw notFound();
    const pendingKey = `mail:${await sha256Hex(who.email)}`;
    const p = Object.hasOwn(meta.members, pendingKey) ? meta.members[pendingKey] : null;
    if (!p || p.status !== 'pending') throw notFound();
    if (!convert) return p;
    delete meta.members[pendingKey];
    const joined = { ...p, key: who.account, account: who.account, name: who.name, email: who.email, status: 'in', at: this.now() };
    meta.members[who.account] = joined;
    const act = this.newActivity(meta, joined, 'member', 'joined');
    await this.save(meta, {}, [act]);
    this.broadcastMembers(meta);
    this.broadcast({ t: 'activity', activity: act });
    jobs.push(() => this.askIndex(`idx:mail:${pendingKey.slice(5)}`, 'drop', { id: meta.id }));
    jobs.push(() => this.askIndex(`idx:acct:${who.account}`, 'put', { entry: entryOf(meta, joined) }));
    return joined;
  }

  /** fn(meta, me, jobs) with the room's state to itself; then the index updates it asked for. */
  async locked(who, fn, { convert = true } = {}) {
    const jobs = [];
    const out = await this.serial(async () => {
      const meta = await this.storage.get('meta');
      if (!meta) throw notFound();
      const me = await this.resolve(meta, who, convert, jobs);
      return fn(meta, me, jobs);
    });
    for (const job of jobs) await job().catch((e) => console.error('creative room: an index update failed', e && e.message));
    return out;
  }

  view(meta, me, here = this.hereKeys()) {
    return { id: meta.id, name: meta.name, owner: ownerPk(meta), head: meta.head, snapshot: snapshotView(meta.snap), settings: { ...meta.settings }, you: memberView(me, here), members: membersOf(meta, here) };
  }

  async create(who, { id, name }) {
    if (!ROOM_ID.test(String(id))) throw bad('A room needs its id.');
    return this.serial(async () => {
      if (await this.storage.get('meta')) throw new ApiError(409, 'taken', 'That room id is taken.');
      if ((await this.storage.list({ prefix: 'r:', limit: 1 })).size) throw bad('That is an index, not a room.');
      const now = this.now();
      const owner = { key: who.account, pk: newPk(), account: who.account, name: who.name, email: who.email, role: 'owner', slot: 0, status: 'in', at: now };
      const meta = { v: 1, id, name: roomName(name), owner: who.account, created: now, head: 0, cum: 0, snap: null, settings: { invite: 'owner' }, members: { [who.account]: owner }, nextSlot: 1, nextComment: 0, comments: 0, actN: 0 };
      await this.askIndex(`idx:acct:${who.account}`, 'claim', { entry: entryOf(meta, owner) });
      await this.save(meta, {}, [this.newActivity(meta, owner, 'room', 'made the room')]);
      return { room: this.view(meta, owner, new Set()) };
    });
  }

  async update(who, body) {
    const { name, settings } = body;
    if (name === undefined && settings === undefined) throw bad('Send name or settings.');
    if (name !== undefined && typeof name !== 'string') throw bad('name must be text.');
    if (settings !== undefined) {
      if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).some((k) => k !== 'invite')) throw bad('settings is { invite: "owner" | "editors" }.');
      if (settings.invite !== undefined && !INVITE.has(settings.invite)) throw bad('settings.invite is "owner" or "editors".');
    }
    return this.locked(who, async (meta, me, jobs) => {
      if (me.role !== 'owner') throw ownerOnly('change the room');
      const acts = [];
      let renamed = false;
      if (name !== undefined && roomName(name) !== meta.name) {
        meta.name = roomName(name);
        renamed = true;
        acts.push(this.newActivity(meta, me, 'room', `renamed the room ${meta.name}`));
      }
      if (settings && settings.invite !== undefined && settings.invite !== meta.settings.invite) {
        meta.settings.invite = settings.invite;
        acts.push(this.newActivity(meta, me, 'room', settings.invite === 'editors' ? 'let editors invite people' : 'let only the owner invite people'));
      }
      if (acts.length) {
        await this.save(meta, {}, acts);
        this.broadcast({ t: 'room', name: meta.name, settings: { ...meta.settings } });
        for (const act of acts) this.broadcast({ t: 'activity', activity: act });
      }
      if (renamed) for (const m of Object.values(meta.members)) jobs.push(() => this.askIndex(indexName(m), 'put', { entry: entryOf(meta, m) }));
      return { room: this.view(meta, me) };
    });
  }

  async destroy(who) {
    return this.locked(who, async (meta, me, jobs) => {
      if (me.role !== 'owner') throw ownerOnly('delete the room');
      for (const ws of this.sockets()) {
        this.tell(ws, { t: 'deleted' });
        this.drop(ws, 4002, 'deleted');
      }
      await this.storage.deleteAll();
      if (typeof this.storage.deleteAlarm === 'function') await this.storage.deleteAlarm();
      this.rates.clear();
      for (const m of Object.values(meta.members)) jobs.push(() => this.askIndex(indexName(m), 'drop', { id: meta.id }));
      return { deleted: meta.id };
    });
  }

  async invite(who, body) {
    const email = cleanEmail(body.email);
    if (!email) throw bad('That isn’t an email address.');
    const role = body.role === undefined ? 'edit' : body.role;
    if (!GIVEN.has(role)) throw bad('role is "edit", "comment" or "view".');
    const pendingKey = `mail:${await sha256Hex(email)}`;
    return this.locked(who, async (meta, me) => {
      if (!(me.role === 'owner' || (me.role === 'edit' && meta.settings.invite === 'editors'))) {
        throw new ApiError(403, 'forbidden', meta.settings.invite === 'editors' ? 'Only editors and the owner can invite people.' : 'Only the room’s owner can invite people.');
      }
      if (Object.hasOwn(meta.members, pendingKey) || Object.values(meta.members).some((m) => m.email === email)) throw new ApiError(409, 'already', 'That person is already in this room, or invited.');
      if (Object.keys(meta.members).length >= ROOMS.people) throw new ApiError(409, 'too_many', `A room has at most ${ROOMS.people} people.`);
      const member = { key: pendingKey, pk: newPk(), account: null, name: email, email, role, slot: meta.nextSlot, status: 'pending', at: this.now(), by: me.key };
      // invites a day: per sender, across their rooms; and per email, in its index's `put` (a new room only)
      await this.askIndex(`idx:acct:${me.account}`, 'charge', { kind: 'invite', limit: ROOMS.invitesPerDay });
      await this.askIndex(indexName(member), 'put', { entry: entryOf(meta, member), invite: true });
      meta.nextSlot += 1;
      meta.members[pendingKey] = member;
      const act = this.newActivity(meta, me, 'member', `invited ${email}`);
      await this.save(meta, {}, [act]);
      this.broadcastMembers(meta);
      this.broadcast({ t: 'activity', activity: act });
      return { member: memberView(member, new Set()) };
    });
  }

  async changeRole(who, key, { role }) {
    if (!GIVEN.has(role)) throw bad('role is "edit", "comment" or "view".');
    return this.locked(who, async (meta, me, jobs) => {
      if (me.role !== 'owner') throw ownerOnly('change who can do what');
      const target = key === 'me' ? me : memberByPk(meta, key);
      if (!target) throw new ApiError(404, 'not_found', 'That person isn’t in this room.');
      if (target.role === 'owner') throw new ApiError(409, 'owner', 'The owner stays the owner.');
      if (target.role !== role) {
        target.role = role;
        const act = this.newActivity(meta, me, 'member', `made ${target.name} ${role === 'edit' ? 'an editor' : role === 'comment' ? 'a commenter' : 'a viewer'}`);
        await this.save(meta, {}, [act]);
        this.broadcastMembers(meta);
        this.broadcast({ t: 'activity', activity: act });
        jobs.push(() => this.askIndex(indexName(target), 'put', { entry: entryOf(meta, target) }));
      }
      return { member: memberView(target, this.hereKeys()) };
    });
  }

  async removeMember(who, key) {
    return this.locked(
      who,
      async (meta, me, jobs) => {
        let target = me;
        if (key !== 'me' && key !== me.pk) {
          if (me.role !== 'owner') throw ownerOnly('remove people');
          target = memberByPk(meta, key);
          if (!target) throw new ApiError(404, 'not_found', 'That person isn’t in this room.');
        }
        if (target.role === 'owner') throw new ApiError(409, 'owner', target === me ? 'The owner can’t leave the room; delete it instead.' : 'The owner can’t be removed.');
        delete meta.members[target.key];
        const self = target === me;
        const text = self ? (target.status === 'pending' ? 'turned down the invitation' : 'left') : target.status === 'pending' ? `cancelled the invitation to ${target.email}` : `removed ${target.name}`;
        const act = this.newActivity(meta, me, 'member', text);
        await this.save(meta, {}, [act]);
        for (const ws of this.sockets(`k:${target.key}`)) {
          this.tell(ws, { t: 'removed' });
          this.drop(ws, 4001, 'removed');
        }
        this.broadcastMembers(meta);
        this.broadcast({ t: 'activity', activity: act });
        jobs.push(() => this.askIndex(indexName(target), 'drop', { id: meta.id }));
        return { removed: target.pk };
      },
      { convert: key !== 'me' },
    );
  }

  // ── snapshots ──

  /** Who may save the room's copy at a seq: an editor, between the snapshot and the head. Only the editor's own check
   *  at that seq can hold it back (that Mac said something else before); another member's never does. */
  async snapshotAllowed(meta, me, seq, hash) {
    if (RANK[me.role] < RANK.edit) throw new ApiError(403, 'forbidden', 'Only editors and the owner save the room’s snapshot.');
    const low = meta.snap ? meta.snap.seq : 0;
    if (seq < low || seq > meta.head) throw new ApiError(409, 'bad_seq', `x-seq must be between the room’s snapshot (${low}) and its head (${meta.head}).`);
    const mine = checksOf(await this.storage.get(chkKey(seq))).find(([key]) => key === me.key);
    if (mine && mine[1] !== hash) throw new ApiError(409, 'diverged', 'This Mac said its project was different at that point; it can’t replace the room’s copy.');
  }

  async putSnapshot(request, who) {
    const seqText = request.headers.get('x-seq') || '';
    const seq = /^\d{1,16}$/.test(seqText) ? Number(seqText) : NaN;
    if (!Number.isSafeInteger(seq)) throw bad('x-seq is the seq the snapshot is at.');
    const hash = request.headers.get('x-hash') || '';
    if (!HASH.test(hash)) throw bad('x-hash is the project’s hash at x-seq.');
    const declared = Number(request.headers.get('content-length'));
    if (declared > ROOMS.snapshotBytes) throw new ApiError(413, 'too_big', `A snapshot is at most ${ROOMS.snapshotBytes / 1048576} MiB.`);
    await this.locked(who, async (meta, me) => {
      await this.snapshotAllowed(meta, me, seq, hash); // before taking the bytes
      // the owner's quota, counting this room as it would be with the new snapshot
      if (Number.isSafeInteger(declared) && declared > 0) {
        const { total = 0 } = await this.askIndex(`idx:acct:${meta.owner}`, 'usage', { id: meta.id, bytes: roomBytesOf(meta), peek: declared - ((meta.snap && meta.snap.bytes) || 0) });
        if (total > ROOMS.accountBytes) throw new ApiError(413, 'quota', 'The owner’s shared projects are using all the room they have. Delete one first.');
      }
    });
    if (!request.body) throw bad('Send the snapshot’s bytes.');
    const gen = hex(randomBytes(6));
    let chunks = 0;
    let bytes = 0;
    let committed = false; // once meta names the new generation, its chunks are the room's
    try {
      const reader = request.body.getReader();
      let buffer = new Uint8Array(ROOMS.chunk);
      let fill = 0;
      const flush = async () => {
        await this.storage.put(chunkKey(gen, chunks), fill === buffer.length ? buffer : buffer.slice(0, fill));
        chunks += 1;
        buffer = new Uint8Array(ROOMS.chunk);
        fill = 0;
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const part = value instanceof Uint8Array ? value : new Uint8Array(value);
        bytes += part.length;
        if (bytes > ROOMS.snapshotBytes) {
          reader.cancel().catch(() => {});
          throw new ApiError(413, 'too_big', `A snapshot is at most ${ROOMS.snapshotBytes / 1048576} MiB.`);
        }
        for (let at = 0; at < part.length; ) {
          const n = Math.min(buffer.length - fill, part.length - at);
          buffer.set(part.subarray(at, at + n), fill);
          fill += n;
          at += n;
          if (fill === buffer.length) await flush();
        }
      }
      if (fill) await flush();
      if (!bytes) throw bad('Send the snapshot’s bytes.');
      return await this.locked(who, async (meta, me) => {
        await this.snapshotAllowed(meta, me, seq, hash); // again: the room may have moved on meanwhile
        const old = meta.snap;
        const at = seq === meta.head ? { cum: meta.cum || 0 } : (await this.storage.get(opKey(seq))) || { cum: (old && old.cum) || 0 };
        meta.snap = { gen, seq, hash, bytes, chunks, cum: at.cum || 0, at: this.now(), by: me.key };
        await this.storage.put('meta', meta);
        committed = true;
        if (old) await this.dropChunks(old.gen, old.chunks);
        await this.compact(old ? old.seq : 0, seq);
        await this.reportUsage(meta);
        return { snapshot: snapshotView(meta.snap) };
      });
    } catch (error) {
      if (!committed) await this.dropChunks(gen, chunks).catch(() => {});
      throw error;
    }
  }

  async getSnapshot(who) {
    const { snap } = await this.locked(who, (meta) => ({ snap: meta.snap }));
    if (!snap) throw new ApiError(404, 'not_found', 'This room has no snapshot yet.');
    const storage = this.storage;
    let i = 0;
    const body = new ReadableStream({
      async pull(controller) {
        if (i >= snap.chunks) return controller.close();
        const part = await storage.get(chunkKey(snap.gen, i++));
        if (!part) return controller.error(new Error('The room’s snapshot changed; fetch it again.'));
        controller.enqueue(part instanceof Uint8Array ? part : new Uint8Array(part));
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-seq': String(snap.seq), 'x-hash': snap.hash, 'x-bytes': String(snap.bytes) } });
  }

  async olderActivity(who, before) {
    let end;
    if (before !== null) {
      if (!/^\d{1,16}$/.test(before) || !Number.isSafeInteger(Number(before))) throw bad('before is an activity number.');
      end = actKey(Number(before));
    }
    await this.locked(who, () => null);
    const rows = await this.storage.list({ prefix: 'act:', ...(end ? { end } : {}), reverse: true, limit: ROOMS.activityPage });
    return { activity: [...rows.values()] };
  }

  // ── index objects: idx:acct:<account>, idx:mail:<hash> ──

  async askIndex(name, op, body) {
    const ns = this.env.CREATIVE_ROOMS;
    if (!ns) throw new ApiError(503, 'not_set_up', 'Editing together isn’t set up here yet.');
    const response = await ns.get(ns.idFromName(name)).fetch(`https://room/idx/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const out = await response.json().catch(() => ({}));
    if (response.status >= 400) throw new ApiError(response.status, out.code || 'error', out.error || 'Something went wrong.');
    return out;
  }

  async indexOp(op, request) {
    const body = await readJson(request, 16_384);
    return json(
      await this.serial(async () => {
        if (await this.storage.get('meta')) throw bad('That is a room, not an index.');
        if (op === 'list') return { rooms: [...(await this.storage.list({ prefix: 'r:' })).values()] };
        if (op === 'drop') {
          if (ROOM_ID.test(String(body.id))) await this.storage.delete([`r:${body.id}`, `u:${body.id}`]);
          return {};
        }
        if (op === 'wipe') {
          // the account (or email) is being deleted: its index goes, counters and all
          await this.storage.deleteAll();
          return {};
        }
        if (op === 'usage') {
          // a room the account owns says what it keeps; the answer is all its rooms together (`peek`: as it would be
          // with that many more bytes, without saving it)
          if (!ROOM_ID.test(String(body.id)) || !Number.isSafeInteger(body.bytes) || body.bytes < 0) throw bad('That isn’t a usage report.');
          const peek = Number.isSafeInteger(body.peek) ? body.peek : null;
          if (peek === null) await this.storage.put(`u:${body.id}`, body.bytes);
          let total = peek === null ? 0 : body.bytes + peek;
          for (const [key, bytes] of await this.storage.list({ prefix: 'u:' })) if (peek === null || key !== `u:${body.id}`) total += bytes;
          return { total };
        }
        if (op === 'charge') {
          // what an account does across its rooms, counted a day at a time (invites)
          if (body.kind !== 'invite' || !Number.isSafeInteger(body.limit)) throw bad('That isn’t a charge.');
          await this.chargeDay(`rate:${body.kind}`, body.limit, 'You’ve sent a lot of invites today; try again tomorrow.');
          return {};
        }
        if (op !== 'put' && op !== 'claim') throw new ApiError(404, 'not_found', 'No such thing.');
        const e = body.entry || {};
        if (!ROOM_ID.test(String(e.id)) || !Object.hasOwn(RANK, e.role) || !validAccount(e.owner) || !['in', 'pending'].includes(e.status)) throw bad('That isn’t a room entry.');
        const entry = { id: e.id, name: cleanName(e.name, 'Untitled project'), role: e.role, owner: e.owner, ownerName: cleanName(e.ownerName, ''), status: e.status, at: Number.isSafeInteger(e.at) ? e.at : 0 };
        if (!(await this.storage.get(`r:${entry.id}`))) {
          const all = [...(await this.storage.list({ prefix: 'r:' })).values()];
          if (all.length >= ROOMS.indexed) throw new ApiError(409, 'too_many', 'That person is in, or invited to, too many rooms.');
          if (op === 'claim' && all.filter((r) => r.role === 'owner').length >= ROOMS.owned) throw new ApiError(409, 'too_many', `You can own at most ${ROOMS.owned} rooms. Delete one first.`);
          if (body.invite === true) await this.chargeDay('rate:invited', ROOMS.invitesPerEmailDay, 'That email has been invited to a lot of projects today; try again tomorrow.');
        }
        await this.storage.put(`r:${entry.id}`, entry);
        return {};
      }),
    );
  }

  /** One more of something an index counts per day (UTC); over `limit`, 429. */
  async chargeDay(key, limit, message) {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const had = (await this.storage.get(key)) || {};
    const n = had.day === day ? had.n : 0;
    if (n >= limit) throw new ApiError(429, 'slow_down', message);
    await this.storage.put(key, { day, n: n + 1 });
  }

  // ── an account being deleted (forgetAccount) ──

  /** In this room: the account's own room goes (as its owner deleting it would); anywhere else they're taken out,
   *  joined or invited (`mailKeys`: their emails' pending keys). */
  async forget(body) {
    const account = validAccount(body.account) ? body.account : null;
    const mailKeys = Array.isArray(body.mailKeys) ? body.mailKeys.filter((k) => typeof k === 'string' && MAIL_KEY.test(k)) : [];
    const jobs = [];
    const out = await this.serial(async () => {
      const meta = await this.storage.get('meta');
      if (!meta) return { gone: true };
      if (account && meta.owner === account) {
        for (const ws of this.sockets()) {
          this.tell(ws, { t: 'deleted' });
          this.drop(ws, 4002, 'deleted');
        }
        await this.storage.deleteAll();
        if (typeof this.storage.deleteAlarm === 'function') await this.storage.deleteAlarm();
        this.rates.clear();
        for (const m of Object.values(meta.members)) if (m.account !== account) jobs.push(() => this.askIndex(indexName(m), 'drop', { id: meta.id }));
        return { deleted: meta.id };
      }
      const gone = Object.values(meta.members).filter((m) => (account && m.key === account) || mailKeys.includes(m.key));
      if (!gone.length) return {};
      for (const m of gone) {
        delete meta.members[m.key];
        for (const ws of this.sockets(`k:${m.key}`)) {
          this.tell(ws, { t: 'removed' });
          this.drop(ws, 4001, 'removed');
        }
      }
      await this.storage.put('meta', meta);
      this.broadcastMembers(meta);
      return { removed: gone.length };
    });
    for (const job of jobs) await job().catch((e) => console.error('creative room: an index update failed', e && e.message));
    return out;
  }
}

/**
 * An Eden account is being deleted (accounts/index.js eraseAccount): the rooms it owns are deleted, it leaves every
 * other room it's in or invited to (by each of its emails), and its index objects go. Best effort, room by room.
 */
export async function forgetAccount(env, account, emails = []) {
  if (!env.CREATIVE_ROOMS || !validAccount(account)) return;
  const ask = (name, path, body) => roomStub(env, name).fetch(`https://room/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const mails = [...new Set(emails.map(cleanEmail).filter(Boolean))];
  const mailKeys = await Promise.all(mails.map(async (e) => `mail:${await sha256Hex(e)}`));
  const indexes = [`idx:acct:${account}`, ...mailKeys.map((k) => `idx:mail:${k.slice(5)}`)];
  const rooms = new Set();
  for (const name of indexes) {
    const listed = await ask(name, 'idx/list', {}).then((r) => r.json()).catch(() => ({}));
    for (const r of listed.rooms || []) if (ROOM_ID.test(String(r.id))) rooms.add(r.id);
  }
  for (const id of rooms) {
    await ask(`room:${id}`, 'forget', { account, mailKeys }).catch((e) => console.error('creative rooms: forgetting an account failed', e && e.message));
  }
  for (const name of indexes) await ask(name, 'idx/wipe', {}).catch(() => {});
}

const roomName = (name) => cleanName(name, 'Untitled project');

function identityFrom(headers) {
  return cleanWho({ account: headers.get('x-eden-account') || '', name: safeDecode(headers.get('x-eden-name') || ''), email: safeDecode(headers.get('x-eden-email') || '') });
}

// ── the Worker's side: /api/creative/rooms… ──

// What a room's routes take, and the request headers that go on to the room (everything else stays).
const ROUTES = { '': ['GET', 'PATCH', 'DELETE'], invite: ['POST'], members: ['PATCH', 'DELETE'], snapshot: ['GET', 'PUT'], activity: ['GET'], socket: ['GET'] };
const PASSED = ['content-type', 'content-length', 'x-seq', 'x-hash', 'upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions'];

const roomStub = (env, name) => env.CREATIVE_ROOMS.get(env.CREATIVE_ROOMS.idFromName(name));

function toRoom(env, who, id, sub, request, body) {
  const headers = new Headers();
  if (body === undefined) {
    for (const name of PASSED) if (request.headers.has(name)) headers.set(name, request.headers.get(name));
  } else {
    headers.set('content-type', 'application/json');
  }
  headers.set('x-eden-account', who.account);
  headers.set('x-eden-name', encodeURIComponent(who.name));
  headers.set('x-eden-email', encodeURIComponent(who.email));
  if (sub === '/socket') {
    // so the room can check the token again while the socket stays open (CreativeRoom.stillValid)
    const auth = /^Bearer\s+(\S{1,400})$/i.exec(request.headers.get('authorization') || '');
    if (auth) headers.set('x-eden-token', auth[1]);
    headers.set('x-eden-origin', request.url);
  }
  const init = { method: request.method, headers };
  if (body !== undefined) init.body = body;
  else if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
    init.body = request.body;
    init.duplex = 'half';
  }
  return roomStub(env, `room:${id}`).fetch(new Request(`https://room${sub}`, init));
}

async function listRooms(env, who) {
  const list = (name) => roomStub(env, name).fetch('https://room/idx/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json()).then((o) => o.rooms || []);
  const [mine, invited] = await Promise.all([list(`idx:acct:${who.account}`), who.email ? sha256Hex(who.email).then((h) => list(`idx:mail:${h}`)) : []]);
  const rooms = new Map();
  for (const r of invited) rooms.set(r.id, r);
  for (const r of mine) rooms.set(r.id, r);
  // never the owner's account id: their name only
  return [...rooms.values()].sort((a, b) => b.at - a.at).map(({ id, name, role, ownerName, status }) => ({ id, name, role, ownerName, status }));
}

/** /api/creative/rooms[/…] (docs/creative-rooms.md). `deps.verify` stands in for the token check in tests. */
export async function roomsApi(request, env, ctx, path, deps = {}) {
  try {
    // The apps send no Origin; a browser always does: no page may call these, reads included (no CORS), as creative/api.js.
    if (request.headers.get('origin') !== null || request.method === 'OPTIONS') throw new ApiError(403, 'forbidden', 'Not from a browser: rooms are for the Creative Suite’s apps.');
    if (!env.CREATIVE_ROOMS) throw new ApiError(503, 'not_set_up', 'Editing together isn’t set up here yet.');
    // The network first, then the token, and only then the account's own count: a token that doesn't verify never
    // charges the account it names (so knowing someone's account id can't rate-limit them out).
    const slow = () => new ApiError(429, 'slow_down', 'Too many requests; wait a minute.', { 'retry-after': '60' });
    if (env.API_RATE && !(await env.API_RATE.limit({ key: `creative-ip:${request.headers.get('cf-connecting-ip') || 'unknown'}` })).success) throw slow();
    const who = cleanWho(await (deps.verify || verifyCreativeToken)(request, env));
    if (!who) throw new ApiError(401, 'not_connected', 'Link this app to your Eden account again.');
    if (env.API_RATE && !(await env.API_RATE.limit({ key: `creative:${who.account}` })).success) throw slow();
    const parts = path.slice(BASE.length).split('/').filter(Boolean);
    const method = request.method;
    if (!parts.length) {
      if (method === 'GET') return json({ rooms: await listRooms(env, who) });
      if (method !== 'POST') throw new ApiError(405, 'bad_request', 'GET or POST it.');
      const body = await readJson(request, 16_384);
      const id = b64url(randomBytes(16));
      return await toRoom(env, who, id, '/create', request, JSON.stringify({ id, name: body.name }));
    }
    const [id, what = '', key, extra] = parts;
    if (!ROOM_ID.test(id) || !Object.hasOwn(ROUTES, what) || extra !== undefined || (what === 'members') !== (key !== undefined)) throw new ApiError(404, 'not_found', 'No such thing.');
    if (!ROUTES[what].includes(method)) throw new ApiError(405, 'bad_request', `${ROUTES[what].join(' or ')} it.`);
    let sub = what ? `/${what}` : '/';
    if (what === 'members') {
      const member = safeDecode(key);
      if (!(member === 'me' || PK.test(member))) throw new ApiError(404, 'not_found', 'That person isn’t in this room.');
      sub += `/${encodeURIComponent(member)}`;
    }
    if (what === 'activity') sub += new URL(request.url).search;
    return await toRoom(env, who, id, sub, request);
  } catch (error) {
    if (error instanceof ApiError) return error.response();
    throw error;
  }
}
