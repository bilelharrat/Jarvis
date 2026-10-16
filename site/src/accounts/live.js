// Eden Code's Share live through askeden.com (JARVIS V1 docs/eden-code-shared-sessions.md, phase
// 3): a teammate anywhere watches a session the owner shares from their Mac, at
// askeden.com/live/<id>#k=<key>. The Mac seals everything with that key before it leaves
// (src/jarvis/share_seal.py), and the key is only in the link's #fragment, which browsers never
// send: this Worker relays and keeps ciphertext it can't read, and never has the key. (Not /s/:
// that is hosted Eden's shared chats, shared-chats.js.)
//
// Who does what:
//   POST   /api/live            { share, expires, max_viewers, up }   the owner's Mac (a `mac` device token)
//   DELETE /api/live/<id>                                               the same Mac: revoke
//   GET    /api/live/<id>/watch  a WebSocket, anyone with the link (the page at /live/<id>)
//   the Mac's relay control line (account.js listen socket):
//     Mac → here   {type: "share_push", share, seq, kind: "full"|"delta", part, parts, blob}
//     here → Mac   {type: "share_viewers", share, count} · {type: "share_up", share, id, blob}
//                  {type: "share_resync", share} · {type: "share_ended", share}
//   here → a viewer   {type: "hello", expires, up} · {type: "frame", seq, kind, part, parts, blob}
//                     {type: "ended"}
//   a viewer → here   {type: "up", id, blob}   a sealed suggestion or request, passed to the Mac
//
// Where it lives: the account's object keeps which shares are its own (`live:<id>` → { device,
// expires }, at most LIVE.shares); each share is one LiveRoom object (binding LIVE_ROOMS,
// migration v8), named by its id, holding who owns it, its viewers' sockets and the sealed frames
// a new viewer needs (the last full snapshot and the deltas after it, at most LIVE.history
// bytes: past that it asks the Mac for a new full one). It deletes everything when the share
// ends: revoked, or expired (an alarm; a day at most), leaving only a tombstone so the id can't be
// taken over.
//
// Who may: only the Mac that registered a share pushes to it or revokes it (the room checks the
// account and the device on every push); a viewer only watches, and sends up at most LIVE.upPerMinute
// messages a minute (and the room LIVE.roomUpPerMinute), which the Mac opens and judges (roles are
// the Mac's: code_share_drive.py; this Worker can't read who is asking). A share lasts a day at most.
//
// What this Worker still sees: that a share exists, when, its frames' sizes, whether a push is a
// full one, how many watch and from which addresses. Never the session or what viewers send.

import { ApiError, json, randomBytes, hex, sha256Hex } from './util.js';

export const LIVE = {
  shares: 10, // live at once per account
  viewers: 20, // watching one share, at most
  dayMs: 24 * 3600_000,
  history: 1_500_000, // sealed characters kept for a new viewer
  part: 48 * 1024, // one frame's blob, at most
  parts: 64,
  up: 16 * 1024, // a viewer's sealed message, at most
  upPerMinute: 6, // per viewer socket
  roomUpPerMinute: 30,
  connectsPerMinute: 30, // new viewer sockets per network address (LIVE_RATE, else in memory)
};

const SHARE_ID = /^[0-9a-f]{32}$/;
const MESSAGE_ID = /^[0-9a-f]{16,32}$/;
const B64 = /^[A-Za-z0-9+/=]*$/;
export const validLiveId = (id) => SHARE_ID.test(String(id));

const roomStub = (env, id) => env.LIVE_ROOMS.get(env.LIVE_ROOMS.idFromName(id));

async function roomCall(env, id, op, body) {
  const response = await roomStub(env, id).fetch(`https://live/${op}`, { method: 'POST', body: JSON.stringify(body) });
  const out = await response.json().catch(() => ({}));
  if (response.status >= 400) throw new ApiError(response.status, out.code || 'error', out.error || 'Something went wrong.');
  return out;
}

// ── the account's object (account.js routes `live-` ops and the listen line's text here) ──

/** The owner's Mac registers a share, or revokes one. */
export async function liveAccountOp(account, op, request) {
  const device = await account.authenticate(request);
  if (device.kind !== 'mac') throw new ApiError(403, 'forbidden', 'Only a Mac shares live sessions.');
  const body = await request.json().catch(() => ({}));
  const id = String(body.share || '');
  if (!validLiveId(id)) throw new ApiError(400, 'bad_request', 'That isn’t a share id.');
  const now = account.now();
  const accountId = (await account.storage.get('account')).id;
  if (op === 'live-register') {
    const expires = Number(body.expires) * 1000;
    if (!Number.isFinite(expires) || expires <= now) throw new ApiError(400, 'bad_request', 'That share has ended already.');
    const mine = await account.storage.list({ prefix: 'live:' });
    const stale = [...mine].filter(([, v]) => v.expires <= now).map(([k]) => k);
    if (stale.length) await account.storage.delete(stale);
    if (mine.has(`live:${id}`)) throw new ApiError(409, 'conflict', 'That share is registered already.');
    if (mine.size - stale.length >= LIVE.shares) throw new ApiError(429, 'slow_down', `At most ${LIVE.shares} live shares at once.`);
    const entry = {
      device: device.id,
      expires: Math.min(expires, now + LIVE.dayMs),
      max_viewers: Math.max(1, Math.min(LIVE.viewers, Math.floor(Number(body.max_viewers) || LIVE.viewers))),
      up: body.up === true,
    };
    // The room first: one already someone else's (a guessed id) refuses, and nothing is kept here.
    await roomCall(account.env, id, 'init', { account: accountId, share: id, ...entry });
    await account.storage.put(`live:${id}`, entry);
    return json({ share: id, expires: Math.floor(entry.expires / 1000), max_viewers: entry.max_viewers });
  }
  if (op === 'live-revoke') {
    const entry = await account.storage.get(`live:${id}`);
    if (!entry || entry.device !== device.id) throw new ApiError(404, 'not_found', 'No such share.');
    await account.storage.delete(`live:${id}`);
    await roomCall(account.env, id, 'end', { account: accountId, device: device.id }).catch(() => {});
    return new Response(null, { status: 204 });
  }
  throw new ApiError(404, 'not_found', 'No such thing.');
}

/** A text frame on a Mac's relay control line: a share's push goes to its room (others: left). */
export async function liveControl(account, ws, message) {
  if (typeof message !== 'string' || message.length > 64 * 1024 || !message.includes('share_push')) return;
  let m;
  try {
    m = JSON.parse(message);
  } catch {
    return;
  }
  if (!m || m.type !== 'share_push' || !validLiveId(m.share)) return;
  const device = (account.tagsOf(ws).find((t) => t.startsWith('listen:')) || '').slice('listen:'.length);
  const entry = await account.storage.get(`live:${m.share}`);
  if (!entry || entry.device !== device || entry.expires <= account.now()) return; // not this Mac's share
  const accountId = (await account.storage.get('account')).id;
  await roomCall(account.env, m.share, 'push', { account: accountId, device, frame: m }).catch(() => {});
}

/** The room's word to its owner's Mac, on that Mac's control line (op `live-to-mac`). */
export async function liveToMac(account, request) {
  const { device, share, message } = await request.json().catch(() => ({}));
  const entry = await account.storage.get(`live:${share}`);
  if (!entry || entry.device !== device) return json({ sent: false });
  if (message && message.type === 'share_ended') await account.storage.delete(`live:${share}`);
  const line = account.socketsTagged(`listen:${device}`)[0];
  if (!line) return json({ sent: false });
  try {
    line.send(JSON.stringify({ ...message, share }));
  } catch {
    return json({ sent: false });
  }
  return json({ sent: true });
}

// ── the Worker's routes ──

/** /api/live…: the Mac's register and revoke (its token), a viewer's watch (no sign-in). */
export async function liveApi(request, env, path, { auth, call, limited }) {
  if (!env.LIVE_ROOMS) throw new ApiError(503, 'not_set_up', 'Live shares are not set up here yet.');
  const method = request.method;
  if (path === '/live' && method === 'POST') {
    const token = auth(request);
    return json(await call(env, token.account, 'live-register', await request.json().catch(() => ({})), token));
  }
  const one = /^\/live\/([0-9a-f]{32})(\/watch)?$/.exec(path);
  if (!one) throw new ApiError(404, 'not_found', 'No such thing.');
  if (!one[2] && method === 'DELETE') {
    const token = auth(request);
    await call(env, token.account, 'live-revoke', { share: one[1] }, token);
    return new Response(null, { status: 204 });
  }
  if (one[2] && method === 'GET') {
    if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') throw new ApiError(426, 'bad_request', 'Watching is a WebSocket.');
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    await limited(env, 'LIVE_RATE', `live:${ip}`);
    const headers = new Headers({ upgrade: 'websocket', 'x-live-ip': await sha256Hex(`live-ip:${ip}`) });
    return roomStub(env, one[1]).fetch(new Request('https://live/watch', { method: 'GET', headers }));
  }
  throw new ApiError(405, 'bad_request', 'Not like that.');
}

// ── the room: one share ──

export class LiveRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.storage = ctx.storage;
    this.env = env || {};
    this.now = () => Date.now();
    this.ups = new Map(); // a viewer socket's tag -> its recent up times (ms)
    this.roomUps = [];
    this.asked = false; // a full snapshot asked of the Mac and not come yet
  }

  async fetch(request) {
    const url = new URL(request.url);
    const op = url.pathname.slice(1);
    try {
      if (op === 'watch') return await this.watch(request);
      const body = await request.json().catch(() => ({}));
      if (op === 'init') return json(await this.init(body));
      if (op === 'push') return json(await this.push(body));
      if (op === 'end') return json(await this.end(body, 'revoked'));
      throw new ApiError(404, 'not_found', 'No such thing.');
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message, code: error.code }, error.status);
      throw error;
    }
  }

  async meta() {
    const meta = await this.storage.get('meta');
    if (!meta || meta.ended) return null;
    if (meta.expires <= this.now()) {
      await this.finish('expired');
      return null;
    }
    return meta;
  }

  async init({ account, share, device, expires, max_viewers, up }) {
    const old = await this.storage.get('meta');
    if (old && old.account !== account) throw new ApiError(409, 'conflict', 'That share id is taken.');
    if (old && old.ended) throw new ApiError(410, 'expired', 'That share has ended.');
    const meta = { account, device, expires, max_viewers, up: up === true, share, ended: false, bytes: 0 };
    await this.storage.put('meta', meta);
    await this.storage.setAlarm(expires);
    return { ok: true };
  }

  async push({ account, device, frame }) {
    const meta = await this.meta();
    if (!meta || meta.account !== account || meta.device !== device) throw new ApiError(403, 'forbidden', 'Not your share.');
    const { seq, part, parts, kind, blob } = frame || {};
    const ok = Number.isInteger(seq) && seq > 0 && Number.isInteger(parts) && parts > 0 && parts <= LIVE.parts
      && Number.isInteger(part) && part >= 0 && part < parts && (kind === 'full' || kind === 'delta')
      && typeof blob === 'string' && blob.length <= LIVE.part && B64.test(blob);
    if (!ok) throw new ApiError(400, 'bad_request', 'That isn’t a frame.');
    const out = { type: 'frame', seq, kind, part, parts, blob };
    const key = `f:${String(seq).padStart(10, '0')}:${String(part).padStart(3, '0')}`;
    if (kind === 'full' && part === 0) {
      // A new full snapshot: what a new viewer needs starts again from it.
      const old = [...(await this.storage.list({ prefix: 'f:' })).keys()];
      for (let i = 0; i < old.length; i += 128) await this.storage.delete(old.slice(i, i + 128));
      meta.bytes = 0;
      meta.full = seq;
      this.asked = false;
    }
    if (meta.full && meta.full <= seq && meta.bytes + blob.length <= LIVE.history) {
      await this.storage.put(key, out);
      meta.bytes += blob.length;
    } else if (!this.asked) {
      this.asked = true; // too long since the last full one: the Mac sends a new one
      await this.toMac(meta, { type: 'share_resync' });
    }
    await this.storage.put('meta', meta);
    const text = JSON.stringify(out);
    for (const ws of this.viewers()) this.sendTo(ws, text);
    return { ok: true };
  }

  async end({ account, device }, why) {
    const meta = await this.storage.get('meta');
    if (!meta || meta.account !== account || meta.device !== device) throw new ApiError(403, 'forbidden', 'Not your share.');
    await this.finish(why, { tell: false });
    return { ok: true };
  }

  async alarm() {
    const meta = await this.storage.get('meta');
    if (meta && !meta.ended) await this.finish('expired');
  }

  /** The share is over: viewers told and closed, every frame gone, the Mac told (unless it asked). */
  async finish(why, { tell = true } = {}) {
    const meta = await this.storage.get('meta');
    for (const ws of this.viewers()) {
      this.sendTo(ws, JSON.stringify({ type: 'ended', why }));
      try {
        ws.close(4004, 'ended');
      } catch {
        // already closed
      }
    }
    await this.storage.deleteAll();
    if (meta) {
      // A tombstone (no frames, no owner's device) so the id can't be taken over until it would have ended.
      await this.storage.put('meta', { account: meta.account, ended: true, expires: meta.expires });
      if (tell) await this.toMac(meta, { type: 'share_ended' });
    }
  }

  viewers() {
    return this.ctx.getWebSockets ? this.ctx.getWebSockets('viewer') : [];
  }

  sendTo(ws, text) {
    try {
      ws.send(text);
    } catch {
      // gone: its close comes
    }
  }

  async toMac(meta, message) {
    if (!this.env.ACCOUNTS || !meta.share) return;
    const stub = this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName(meta.account));
    await stub.fetch('https://account/live-to-mac', { method: 'POST', body: JSON.stringify({ device: meta.device, share: meta.share, message }) }).catch(() => {});
  }

  // Overridable in tests: a WebSocket pair, the server end accepted with these tags.
  upgrade(tags) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, tags);
    return { response: new Response(null, { status: 101, webSocket: client }), server };
  }

  async watch(request) {
    const meta = await this.meta();
    if (!meta) throw new ApiError(404, 'not_found', 'This share isn’t live: it ended, was revoked, or never was.');
    if (this.viewers().length >= meta.max_viewers) throw new ApiError(429, 'slow_down', 'This share has as many viewers as it takes.');
    const ip = request.headers.get('x-live-ip') || '';
    const tag = `v:${hex(randomBytes(8))}`;
    const { response, server } = this.upgrade(['viewer', tag, `ip:${ip.slice(0, 16)}`]);
    this.sendTo(server, JSON.stringify({ type: 'hello', expires: Math.floor(meta.expires / 1000), up: meta.up }));
    for (const frame of (await this.storage.list({ prefix: 'f:' })).values()) this.sendTo(server, JSON.stringify(frame));
    await this.toMac(meta, { type: 'share_viewers', count: this.viewers().length });
    return response;
  }

  async webSocketMessage(ws, message) {
    const meta = await this.meta();
    if (!meta) return;
    if (typeof message !== 'string' || message.length > LIVE.up + 256) {
      ws.close(1009, 'too big');
      return;
    }
    let m;
    try {
      m = JSON.parse(message);
    } catch {
      return;
    }
    if (!m || m.type !== 'up' || !meta.up || !MESSAGE_ID.test(String(m.id)) || typeof m.blob !== 'string' || !B64.test(m.blob)) return;
    const now = this.now();
    const tag = (this.ctx.getTags ? this.ctx.getTags(ws) : []).find((t) => t.startsWith('v:')) || '';
    const mine = (this.ups.get(tag) || []).filter((at) => now - at < 60_000);
    this.roomUps = this.roomUps.filter((at) => now - at < 60_000);
    if (mine.length >= LIVE.upPerMinute || this.roomUps.length >= LIVE.roomUpPerMinute) {
      this.sendTo(ws, JSON.stringify({ type: 'slow_down' }));
      return;
    }
    mine.push(now);
    this.ups.set(tag, mine);
    this.roomUps.push(now);
    await this.toMac(meta, { type: 'share_up', id: m.id, blob: m.blob });
  }

  async webSocketClose(ws) {
    const tag = (this.ctx.getTags ? this.ctx.getTags(ws) : []).find((t) => t.startsWith('v:'));
    if (tag) this.ups.delete(tag);
    const meta = await this.meta();
    if (meta) await this.toMac(meta, { type: 'share_viewers', count: this.viewers().filter((v) => v !== ws).length });
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }
}
