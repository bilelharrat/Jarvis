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
//   meta                 { id, name, owner, created, head (the last seq), snap: { gen, seq, hash,
//                          bytes, chunks } | null, settings: { invite }, members: { key → member },
//                          nextSlot, nextComment, comments (comments and replies kept), actN }
//   op:<seq, 16 digits>  an ordered command: { seq, id, by, name, slot, at, base, label, via, note, op }
//                        (`op` stays the app's string: never parsed here, so its ids keep their precision)
//   oid:<key>:<n|s><id>  the seq of that author's op id: a re-send answers with the entry it already has
//   chk:<seq>            the first Mac's project hash at seq ({ hash, by }), from `check`
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
  owned: 100, // rooms one account owns
  indexed: 1000, // rooms one index object lists
  opBytes: 512 * 1024,
  ops: 120, // per socket per opWindow
  opWindow: 10_000,
  presence: 30, // per socket a second; the rest is dropped
  frames: 60, // hello, comment, check and note frames per socket per frameWindow
  frameWindow: 10_000,
  frame: 1_600_000, // the longest text frame read (a 512 KiB op, JSON-escaped)
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
    const m = typeof key === 'string' ? meta.members[key] : null;
    if (!m || m.status !== 'in' || !Object.hasOwn(meta.members, key)) throw bad('A mention must be someone in the room.', 'bad_mention');
  }
  return [...new Set(value)];
}

// ── what goes out ──

const memberView = (m, here) => ({ key: m.key, account: m.account, name: m.name, email: m.email, role: m.role, slot: m.slot, status: m.status, here: here.has(m.key) });
const membersOf = (meta, here) => Object.values(meta.members).sort((a, b) => a.slot - b.slot).map((m) => memberView(m, here));
const snapshotView = (snap) => (snap ? { seq: snap.seq, hash: snap.hash, bytes: snap.bytes } : null);
const indexName = (m) => (m.status === 'in' ? `idx:acct:${m.account}` : `idx:mail:${m.key.slice(5)}`);
const entryOf = (meta, m) => ({ id: meta.id, name: meta.name, role: m.role, owner: meta.owner, ownerName: (meta.members[meta.owner] || {}).name || '', status: m.status, at: m.at });

export class CreativeRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.storage = ctx.storage;
    this.env = env || {};
    this.now = () => Date.now();
    this.chain = Promise.resolve(); // one change at a time, whatever it waits on
    this.rates = new Map(); // socket id → its counters (lost on hibernation, which only comes when quiet)
    this.attachments = new WeakMap(); // where a socket's attachment lives when the runtime has no serializeAttachment
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
      if (exceptSid && (this.attachmentOf(ws) || {}).sid === exceptSid) continue;
      this.tell(ws, text);
    }
  }

  broadcastMembers(meta) {
    this.broadcast({ t: 'members', members: membersOf(meta, this.hereKeys()) });
  }

  rateOf(sid) {
    if (!this.rates.has(sid)) this.rates.set(sid, { op: [0, 0], presence: [0, 0], frames: [0, 0] });
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
    return this.locked(who, (meta, me) => {
      if (this.sockets(`k:${me.key}`).length >= ROOMS.socketsPerMember) throw new ApiError(429, 'too_many', `At most ${ROOMS.socketsPerMember} of your apps can be in a room at once.`);
      const { response, server } = this.upgrade([`k:${me.key}`]);
      this.attach(server, { sid: hex(randomBytes(8)), key: me.key, at: this.now(), presence: null, pat: 0 });
      return response;
    });
  }

  async webSocketMessage(ws, message) {
    return this.serial(() => this.onMessage(ws, message));
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
    const still = this.sockets(`k:${att.key}`).some((o) => o !== ws && (this.attachmentOf(o) || {}).sid !== att.sid);
    if (!still) this.broadcast({ t: 'left', key: att.key }, att.sid);
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
    this.broadcast({ t: 'presence', key: me.key, name: me.name, slot: me.slot, ...presence }, att.sid);
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
    if (utf8Length(msg.op) > ROOMS.opBytes) throw new ApiError(413, 'too_big', `A change is at most ${ROOMS.opBytes / 1024} KiB.`);
    // The same op again (a reconnect re-sends what wasn't confirmed): its entry, to this socket only.
    const known = await this.storage.get(oidKey(me.key, id));
    if (known !== undefined) {
      const entry = await this.storage.get(opKey(known));
      if (entry) return this.tell(ws, { t: 'op', ...entry });
      throw new ApiError(409, 'in_snapshot', 'That change is already in the room’s snapshot.', {}, { seq: known });
    }
    if (base > meta.head) throw new ApiError(409, 'bad_base', 'That change was made on a newer version than the room has.');
    const low = meta.snap ? meta.snap.seq : 0;
    if (meta.head - low >= ROOMS.logMax) throw new ApiError(409, 'log_full', 'The room’s log is full: an editor’s app saves a snapshot first.');
    const seq = meta.head + 1;
    const entry = { seq, id, by: me.key, name: me.name, slot: me.slot, at: this.now(), base, label, via, note, op: msg.op };
    meta.head = seq;
    const act = this.newActivity(meta, me, 'op', via === 'eden' ? `asked Eden: ${label || 'a change'}` : label || 'made a change', { seq, via });
    await this.save(meta, { [opKey(seq)]: entry, [oidKey(me.key, id)]: seq }, [act]);
    this.broadcast({ t: 'op', ...entry });
    this.broadcast({ t: 'activity', activity: act });
    const length = seq - low;
    if (length >= ROOMS.snapshotWanted && length % ROOMS.snapshotWanted === 0) this.wantSnapshot(meta);
  }

  wantSnapshot(meta, only = null) {
    for (const ws of only ? [only] : this.sockets()) {
      const m = meta.members[(this.attachmentOf(ws) || {}).key];
      if (m && RANK[m.role] >= RANK.edit) this.tell(ws, { t: 'snapshot_wanted', seq: meta.head });
    }
  }

  async onHello(ws, att, meta, me, msg) {
    const since = msg.since === undefined || msg.since === null ? 0 : msg.since;
    if (!Number.isSafeInteger(since) || since < 0) throw bad('since is the last seq the app has (a safe integer).');
    const low = meta.snap ? meta.snap.seq : 0;
    const resync = since < low || since > meta.head;
    const here = this.hereKeys();
    const welcome = { t: 'welcome', you: memberView(me, here), room: this.view(meta, me, here), presence: this.presenceOthers(att.sid, meta) };
    let next = null; // the seq the ops go on from, after the welcome
    if (resync) welcome.resync = true;
    else {
      welcome.ops = [];
      let budget = ROOMS.welcomeBudget;
      for await (const entry of this.log(since + 1, meta.head)) {
        const size = entry.op.length + 300;
        if (welcome.ops.length && size > budget) {
          next = entry.seq;
          break;
        }
        budget -= size;
        welcome.ops.push(entry);
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
    if (next !== null) for await (const entry of this.log(next, meta.head)) this.tell(ws, { t: 'op', ...entry });
    if (commentsFrom !== null) for await (const comment of this.allComments(commentsFrom)) this.tell(ws, { t: 'comment', comment });
    if (meta.head - low >= ROOMS.snapshotWanted) this.wantSnapshot(meta, ws);
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
      if (!had || had.pat < att.pat) latest.set(att.key, { pat: att.pat, value: { key: m.key, name: m.name, slot: m.slot, ...att.presence } });
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
        by: me.key,
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
      if (comment.by !== me.key && me.role !== 'owner') throw new ApiError(403, 'forbidden', 'Only who wrote it, or the room’s owner, can delete a comment.');
      meta.comments = Math.max(0, meta.comments - 1 - comment.replies.length);
      await this.storage.put('meta', meta);
      await this.storage.delete(cmKey(id));
      return this.broadcast({ t: 'comment', comment: { id, deleted: true }, ...extra });
    }
    let act;
    if (msg.op === 'reply') {
      if (meta.comments >= ROOMS.comments) throw new ApiError(409, 'too_many', `A room keeps at most ${ROOMS.comments} comments.`);
      if (comment.replies.length >= ROOMS.replies) throw new ApiError(409, 'too_many', `A comment has at most ${ROOMS.replies} replies.`);
      const reply = { id: 0, by: me.key, name: me.name, at: this.now(), text: words(msg.text, ROOMS.commentChars, 'A reply'), mentions: mentionsOf(msg.mentions, meta) };
      reply.id = meta.nextComment += 1;
      meta.comments += 1;
      comment.replies.push(reply);
      act = this.newActivity(meta, me, 'reply', reply.text.slice(0, 140));
    } else {
      if (typeof msg.resolved !== 'boolean') throw bad('resolved is true or false.');
      comment.resolved = msg.resolved;
      comment.resolvedBy = msg.resolved ? me.key : null;
      act = this.newActivity(meta, me, 'resolve', msg.resolved ? 'resolved a comment' : 'reopened a comment');
    }
    await this.save(meta, { [cmKey(id)]: comment }, [act]);
    this.broadcast({ t: 'comment', comment, ...extra });
    this.broadcast({ t: 'activity', activity: act });
  }

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
    const had = await this.storage.get(chkKey(seq));
    if (!had) await this.storage.put(chkKey(seq), { hash: msg.hash, by: me.key });
    else if (had.hash !== msg.hash) this.tell(ws, { t: 'diverged', seq });
  }

  onNote(ws, meta, me, msg) {
    if (RANK[me.role] < RANK.comment) throw new ApiError(403, 'forbidden', 'You can watch this room, not send notes.');
    const to = typeof msg.to === 'string' && Object.hasOwn(meta.members, msg.to) ? meta.members[msg.to] : null;
    if (!to || to.status !== 'in') throw new ApiError(404, 'not_found', 'That person isn’t in this room.');
    const frame = { t: 'note', from: me.key, name: me.name, text: words(msg.text, ROOMS.noteChars, 'A note'), clip: anId(msg.clip, 'clip', { nullable: true }) };
    const targets = this.sockets(`k:${to.key}`);
    if (!targets.length) throw new ApiError(409, 'not_here', `${to.name} isn’t in the room right now.`);
    for (const target of targets) this.tell(target, frame);
  }

  // ── storage ──

  newActivity(meta, me, kind, text, { seq = null, via = null } = {}) {
    meta.actN += 1;
    return { n: meta.actN, at: this.now(), by: me.key, name: me.name, kind, text, seq, via };
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
    return { id: meta.id, name: meta.name, owner: meta.owner, head: meta.head, snapshot: snapshotView(meta.snap), settings: { ...meta.settings }, you: memberView(me, here), members: membersOf(meta, here) };
  }

  async create(who, { id, name }) {
    if (!ROOM_ID.test(String(id))) throw bad('A room needs its id.');
    return this.serial(async () => {
      if (await this.storage.get('meta')) throw new ApiError(409, 'taken', 'That room id is taken.');
      if ((await this.storage.list({ prefix: 'r:', limit: 1 })).size) throw bad('That is an index, not a room.');
      const now = this.now();
      const owner = { key: who.account, account: who.account, name: who.name, email: who.email, role: 'owner', slot: 0, status: 'in', at: now };
      const meta = { v: 1, id, name: roomName(name), owner: who.account, created: now, head: 0, snap: null, settings: { invite: 'owner' }, members: { [who.account]: owner }, nextSlot: 1, nextComment: 0, comments: 0, actN: 0 };
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
      const member = { key: pendingKey, account: null, name: email, email, role, slot: meta.nextSlot, status: 'pending', at: this.now(), by: me.key };
      await this.askIndex(indexName(member), 'put', { entry: entryOf(meta, member) });
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
      const target = key !== 'me' && Object.hasOwn(meta.members, key) ? meta.members[key] : key === 'me' ? me : null;
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
        if (key !== 'me' && key !== me.key) {
          if (me.role !== 'owner') throw ownerOnly('remove people');
          target = Object.hasOwn(meta.members, key) ? meta.members[key] : null;
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
        return { removed: target.key };
      },
      { convert: key !== 'me' },
    );
  }

  // ── snapshots ──

  async snapshotAllowed(meta, me, seq, hash) {
    if (RANK[me.role] < RANK.edit) throw new ApiError(403, 'forbidden', 'Only editors and the owner save the room’s snapshot.');
    const low = meta.snap ? meta.snap.seq : 0;
    if (seq < low || seq > meta.head) throw new ApiError(409, 'bad_seq', `x-seq must be between the room’s snapshot (${low}) and its head (${meta.head}).`);
    const known = meta.snap && meta.snap.seq === seq ? meta.snap.hash : ((await this.storage.get(chkKey(seq))) || {}).hash;
    if (known !== undefined && known !== hash) throw new ApiError(409, 'diverged', 'This Mac’s project differs from the room’s at that point; it can’t replace the room’s copy.');
  }

  async putSnapshot(request, who) {
    const seqText = request.headers.get('x-seq') || '';
    const seq = /^\d{1,16}$/.test(seqText) ? Number(seqText) : NaN;
    if (!Number.isSafeInteger(seq)) throw bad('x-seq is the seq the snapshot is at.');
    const hash = request.headers.get('x-hash') || '';
    if (!HASH.test(hash)) throw bad('x-hash is the project’s hash at x-seq.');
    const declared = Number(request.headers.get('content-length'));
    if (declared > ROOMS.snapshotBytes) throw new ApiError(413, 'too_big', `A snapshot is at most ${ROOMS.snapshotBytes / 1048576} MiB.`);
    await this.locked(who, (meta, me) => this.snapshotAllowed(meta, me, seq, hash)); // before taking the bytes
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
        meta.snap = { gen, seq, hash, bytes, chunks, at: this.now(), by: me.key };
        await this.storage.put('meta', meta);
        committed = true;
        if (old) await this.dropChunks(old.gen, old.chunks);
        await this.compact(old ? old.seq : 0, seq);
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
          if (ROOM_ID.test(String(body.id))) await this.storage.delete(`r:${body.id}`);
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
        }
        await this.storage.put(`r:${entry.id}`, entry);
        return {};
      }),
    );
  }
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
  return [...rooms.values()].sort((a, b) => b.at - a.at).map(({ id, name, role, owner, ownerName, status }) => ({ id, name, role, owner, ownerName, status }));
}

/** /api/creative/rooms[/…] (docs/creative-rooms.md). `deps.verify` stands in for the token check in tests. */
export async function roomsApi(request, env, ctx, path, deps = {}) {
  try {
    // The apps send no Origin; a browser always does: no page may call these, reads included (no CORS), as creative/api.js.
    if (request.headers.get('origin') !== null || request.method === 'OPTIONS') throw new ApiError(403, 'forbidden', 'Not from a browser: rooms are for the Creative Suite’s apps.');
    if (!env.CREATIVE_ROOMS) throw new ApiError(503, 'not_set_up', 'Editing together isn’t set up here yet.');
    const who = cleanWho(await (deps.verify || verifyCreativeToken)(request, env));
    if (!who) throw new ApiError(401, 'not_connected', 'Link this app to your Eden account again.');
    if (env.API_RATE) {
      // every Creative Suite route counts here per account (docs/creative-api.md "Rate limits")
      const { success } = await env.API_RATE.limit({ key: who.account });
      if (!success) throw new ApiError(429, 'slow_down', 'Too many requests; wait a minute.', { 'retry-after': '60' });
    }
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
      if (!(member === 'me' || validAccount(member) || MAIL_KEY.test(member))) throw new ApiError(404, 'not_found', 'That person isn’t in this room.');
      sub += `/${encodeURIComponent(member)}`;
    }
    if (what === 'activity') sub += new URL(request.url).search;
    return await toRoom(env, who, id, sub, request);
  } catch (error) {
    if (error instanceof ApiError) return error.response();
    throw error;
  }
}
