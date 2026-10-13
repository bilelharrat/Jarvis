// Eden's web relay (docs/accounts.md, "Eden web relay"): hosted Eden at askeden.com reaching
// Eden on the owner's Mac, for what only the Mac has (Eden Secretary, Code mode, its projects).
//
// The Mac (a `mac` device) holds one WebSocket, GET /api/relay/web, tagged `web` and
// `web:<device id>` in the account's Durable Object. Hosted Eden (src/eden/chat.js) never
// lets the browser near it: for a Mac-only route it asks the account's object (op
// `web-forward`, as the signed-in `web` device), which sends the request down that socket as
// frames and answers with the Mac's response as it streams back:
//
//   text frames, JSON:   {t:"req", id, method, path, headers, from, size}   Worker → Mac
//                        {t:"end", id}            the request's body is all there / the answer is done
//                        {t:"cancel", id}         Worker → Mac: the browser stopped (or a cap was hit)
//                        {t:"res", id, status, headers}                      Mac → Worker
//                        {t:"error", id, status, error, code}                Mac → Worker, instead of res
//                        {t:"ack", id, n}         Worker → Mac: n more response bytes delivered
//   binary frames:       the 16 ASCII characters of the id, then up to 64 KiB of body
//
// The Mac may have WEB_RELAY.window bytes of a response in flight before it waits for acks,
// so a slow browser holds the Mac back instead of filling this object's memory. Nothing that
// passes is kept or logged: bodies stream through.

import { ApiError, json, randomBytes, hex, sha256Hex } from './util.js';

export const WEB_RELAY = {
  frame: 64 * 1024, // a binary frame's body, at most, each way
  control: 16 * 1024, // a text frame, at most
  body: 10 * 1024 * 1024, // a request's body (Code mode's images included)
  response: 64 * 1024 * 1024, // a response's body, in all
  streams: 16, // requests in flight per account
  probeStreams: 4, // more, for the short Eden Secretary status checks only (askMacBy's probe never finds the limit reached)
  window: 256 * 1024, // response bytes the Mac may send ahead of acks
  headMs: 130_000, // for the Mac to answer: Eden Secretary may be waiting on its "Let Eden use Eden Secretary?" card (120 s)
  idleMs: 10 * 60_000, // between two pieces of an answer (a Code turn's events)
  // The page's own deadline, `x-eden-wait: <seconds>` (askMacBy): clamped to these, in seconds of `second` ms
  // (tests shorten `second`); then `probeMs` at most to ask the Mac whether Eden Secretary waits on its card.
  clientWaitMin: 5,
  clientWaitMax: 60,
  second: 1000,
  probeMs: 3000,
  // A Eden Secretary call with the page's `x-eden-request-id` (R2C-4): its answer is kept this long, in this object's
  // memory only, for the page's retry after a 202; and at most this big (Eden Secretary answers are small JSON).
  replayMs: 120_000,
  replayMax: 2 * 1024 * 1024,
  replays: 64, // kept answers per account, at most
};

// The one route whose request may get a 202 { approval: "waiting" } (askMacBy) and carries a request id.
export const JARVIS_CALL = '/api/chat/jarvis';
// The page's id for one Eden Secretary call, the same on every retry of it (R2C-4): a UUID fits.
export const REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/;
// Eden Secretary tools that only read (askeden src/chat/jarvis.ts): a 202 is safe for them without a request id,
// as running one twice changes nothing. Any other tool needs the id for a 202 (askMacBy).
export const JARVIS_READS = new Set([
  'search_notes', 'read_note', 'recall', 'calendar', 'mail_accounts', 'mail_search', 'mail_read', 'memory_list',
  'commitments', 'meetings_list', 'meeting_read', 'browser_task_status', 'actions_list', 'files_search', 'file_read',
  'file_summarize', 'screen_context', 'knowledge_list', 'knowledge_search',
]);

// The Mac-only routes hosted Eden forwards (the Mac keeps its own list, src/jarvis/eden_link.py).
// Not here, on purpose: API keys (they stay on the Mac), adding a project folder, the router
// dashboard and the download. Gmail and Google Calendar run on the Worker itself (eden/google-data.js).
export const MAC_ROUTES = new Set([
  'GET /api/chat/jarvis/status',
  'POST /api/chat/jarvis',
  'GET /api/chat/projects',
  // New code session: add a folder, make ~/Eden Projects/<name>, or the Mac's folder picker (Eden's
  // src/chat/code.ts createProject / pickProjectFolder). The owner's own browsers only, as all here.
  'POST /api/chat/projects',
  'POST /api/chat/code',
  'POST /api/chat/code/steer',
  'GET /api/chat/code/changes',
  'POST /api/chat/brief', // the morning brief and meeting prep: reads only (Eden's src/chat/brief.ts)
  // Meetings' action items, the Activity timeline and its Undo (Eden's src/chat/eden-actions.ts);
  // the Mac lets only Eden Secretary's own actions be undone from here, each on the owner's card.
  'POST /api/chat/meetings/actions',
  'GET /api/chat/actions',
  'POST /api/chat/actions/undo',
  'POST /api/chat/mac/send', // a chat turn that reads the Mac's files and project knowledge (Eden's src/chat/mac.ts)
  // Privacy mode (G9): a private turn, answered by a local model on the Mac, never here (eden/chat.js
  // forwards only `privacy: true` turns; the Mac refuses any other), and its local models.
  'POST /api/chat/send',
  'GET /api/chat/local',
  // Chat through the Mac (no ANTHROPIC_API_KEY here, or EDEN_CHAT_VIA_MAC = "1"; eden/chat.js): every
  // turn, the routing preview and the model list come from Eden on the Mac, on its own models
  // and the owner's own subscription. Only the account's owner: never a delegate or a space
  // (refused here in `forward`, in eden/chat.js, and again on the Mac).
  'POST /api/route',
  'GET /api/chat/meta',
]);

export const MAC_OFFLINE =
  'Your Mac is offline. Eden Secretary and Code mode run on your Mac: open Eden Secretary there (with Eden running) and try again.';

const ID = /^[0-9a-f]{16}$/;
const ID_BYTES = 16;
const CONTENT_TYPE = /^[\w.+-]+\/[\w.+-]+(\s*;[\w\s=.+"-]*)?$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const newStreamId = () => hex(randomBytes(8));

/** A binary frame: the stream's id, then the bytes. */
export function frame(id, payload) {
  const out = new Uint8Array(ID_BYTES + payload.byteLength);
  out.set(encoder.encode(id), 0);
  out.set(payload instanceof Uint8Array ? payload : new Uint8Array(payload), ID_BYTES);
  return out;
}

/** { id, payload } of a binary frame; null if it isn't one. */
export function unframe(data) {
  const bytes = data instanceof Uint8Array ? data : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
  if (bytes.byteLength < ID_BYTES) return null;
  const id = decoder.decode(bytes.subarray(0, ID_BYTES));
  return ID.test(id) ? { id, payload: bytes.subarray(ID_BYTES) } : null;
}

/** A route as MAC_ROUTES lists it ("GET /api/chat/projects"), or null for anything else. */
export function macRoute(method, target) {
  const text = String(target || '');
  if (!text.startsWith('/') || text.startsWith('//') || /[\\\s%]|\.\./.test(text.replace(/\?.*$/, ''))) return null;
  const path = text.replace(/\?.*$/, '');
  const route = `${method} ${path}`;
  if (!MAC_ROUTES.has(route)) return null;
  if (text.includes('?') && path !== '/api/chat/code/changes') return null;
  return route;
}

const relayError = (status, code, message) => json({ error: message, code }, status, { 'x-eden-relay': 'error' });

// ── in the Account object ──

const streamsOf = (account) => (account.webStreams ??= new Map());
// R2C-4: browsers waiting on another stream's Eden Secretary call (same page request id), by their own stream id;
// finished Eden Secretary calls' answers by "<browser device> <request id>"; ids the browser stopped before they arrived.
const waitersOf = (account) => (account.webWaiters ??= new Map());
const replaysOf = (account) => (account.webReplays ??= new Map());
const earlyOf = (account) => (account.webEarly ??= new Map());

function prune(map, now, keep) {
  for (const [k, v] of map) if (v.until <= now) map.delete(k);
  while (map.size > keep) map.delete(map.keys().next().value);
}


/** GET /relay/web (a Mac): its web channel; a new one replaces that Mac's older one. */
export function webListen(account, device) {
  if (device.kind !== 'mac') throw new ApiError(403, 'forbidden', 'Only a Mac answers for Eden on the web.');
  for (const old of account.socketsTagged(`web:${device.id}`)) {
    webClosed(account, old);
    try {
      old.close(4000, 'replaced');
    } catch {
      // already closed
    }
  }
  const { response, server } = account.upgrade(['web', `web:${device.id}`]);
  try {
    server.serializeAttachment?.({ mac: device.id, at: account.now() });
  } catch {
    // the newest is still found, a little less surely
  }
  return response;
}

/** The Mac that answers: the newest web channel on the account. */
function macSocket(account) {
  let best = null;
  let bestAt = -1;
  for (const ws of account.socketsTagged('web')) {
    let at = 0;
    try {
      at = Number(ws.deserializeAttachment?.()?.at) || 0;
    } catch {
      // none
    }
    if (at >= bestAt) {
      best = ws;
      bestAt = at;
    }
  }
  return best;
}

async function online(account) {
  if (macSocket(account)) return { online: true, macs: true };
  return { online: false, macs: (await account.devices()).some((d) => d.kind === 'mac') };
}

/** The ops hosted Eden uses (web-forward, web-cancel, web-status), as the browser's `web` device. */
export async function webOp(account, op, request) {
  try {
    const device = await account.authenticate(request);
    if (device.kind !== 'web') throw new ApiError(403, 'forbidden', 'Only Eden on the web asks the Mac this way.');
    // The owner's Mac serves the owner's own browsers only: never a delegate's or a space member's
    // session (their grant's device lives on this account too; grantGuard refuses it first).
    if (device.grant) throw new ApiError(403, 'owner_only', 'Only the account’s owner reaches its Mac.');
    if (op === 'web-status') return json(await online(account));
    if (op === 'web-cancel') {
      const { id, keep } = await request.json().catch(() => ({}));
      cancel(account, String(id || ''), { from: device.id, why: 'stopped', keep: keep === true });
      return json({});
    }
    if (op === 'web-forward') return await forward(account, device, request);
    throw new ApiError(404, 'not_found', 'No such thing.');
  } catch (error) {
    if (error instanceof ApiError) return relayError(error.status, error.code, error.message);
    throw error;
  }
}

async function forward(account, device, request) {
  const id = request.headers.get('x-eden-stream') || '';
  const method = request.headers.get('x-eden-method') || '';
  const target = request.headers.get('x-eden-path') || '';
  if (!ID.test(id)) throw new ApiError(400, 'bad_request', 'A stream id is 16 hex characters.');
  if (!macRoute(method, target)) throw new ApiError(403, 'not_allowed', 'Eden on the web can’t ask your Mac for that.');
  const rid = method === 'POST' && target === JARVIS_CALL ? request.headers.get('x-eden-request-id') : null;
  if (rid !== null && !REQUEST_ID.test(rid)) throw new ApiError(400, 'bad_request', 'x-eden-request-id is 16 to 64 letters, digits, - or _.');
  const streams = streamsOf(account);
  if (streams.has(id) || waitersOf(account).has(id)) throw new ApiError(409, 'conflict', 'That stream id is in use.');
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > WEB_RELAY.body) throw new ApiError(413, 'too_big', 'That request is too big for your Mac’s link.');
  const body = method === 'POST' ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array();
  if (body.byteLength > WEB_RELAY.body) throw new ApiError(413, 'too_big', 'That request is too big for your Mac’s link.');
  const wait = Math.min(WEB_RELAY.headMs, Number(request.headers.get('x-eden-wait')) || WEB_RELAY.headMs);

  // R2C-4: the same Eden Secretary call asked again (the page's retry after a 202): its kept answer, or a wait on the
  // call still running. The Mac isn't asked twice. The same id with another body is the page's mistake.
  const key = rid ? `${device.id} ${rid}` : null;
  // The replay cache keeps the body's SHA-256, not the body (R3C-11): 64 answers of 10 MB would be too much.
  const ask = key ? await sha256Hex(body) : null;
  if (key) {
    const replays = replaysOf(account);
    prune(replays, Date.now(), WEB_RELAY.replays);
    const done = replays.get(key);
    if (done) {
      if (done.ask !== ask) throw new ApiError(409, 'request_id_reused', 'That request id was used for another Eden Secretary call.');
      return keptAnswer(done);
    }
    const live = [...streams.values()].find((x) => x.key === key);
    if (live) {
      if (live.ask !== ask) throw new ApiError(409, 'request_id_reused', 'That request id was used for another Eden Secretary call.');
      return attach(account, live, id, device.id, wait);
    }
  }

  const mac = macSocket(account);
  if (!mac) {
    const { macs } = await online(account);
    throw macs ? new ApiError(503, 'mac_offline', MAC_OFFLINE) : new ApiError(503, 'needs_mac', 'No Mac is linked to this account.');
  }
  // The short Eden Secretary status checks (askMacBy's probe) have room of their own, so a busy account still gets
  // its "waiting on the card" answer (R2C-14b); everything else shares WEB_RELAY.streams.
  const probe = method === 'GET' && target === '/api/chat/jarvis/status';
  const busy = [...streams.values()].filter((x) => !x.probe).length;
  if (probe ? streams.size - busy >= WEB_RELAY.probeStreams : busy >= WEB_RELAY.streams) {
    throw new ApiError(429, 'slow_down', 'Your Mac is answering too many requests at once; try again in a moment.', { 'retry-after': '5' });
  }
  // The browser let go while this was on its way here (R2C-14c): the Mac never hears of it.
  const early = earlyOf(account);
  prune(early, Date.now(), 256);
  const stoppedEarly = early.get(id);
  early.delete(id);
  if (stoppedEarly && !stoppedEarly.keep) throw new ApiError(499, 'stopped', 'Stopped.');
  const headers = {};
  for (const name of ['content-type', 'accept']) {
    const value = request.headers.get(`x-eden-h-${name}`);
    if (value && value.length <= 200) headers[name] = value;
  }
  if (rid) headers['x-eden-request-id'] = rid; // for the Mac, to tell a repeated call (it may ignore it)

  const s = { id, ws: mac, from: device.id, phase: 'head', received: 0, unacked: 0, timer: null, controller: null, resolve: null, probe, key, ask, waiters: [] };
  const head = new Promise((resolve) => {
    s.resolve = resolve;
  });
  streams.set(id, s);
  arm(account, s, wait);
  if (stoppedEarly) detach(account, s);
  try {
    // `owner`: asked by one of the account owner's own browsers (never a grant's): the Mac lets
    // only such a request chat through it (eden_link.py).
    mac.send(JSON.stringify({ t: 'req', id, method, path: target, headers, from: device.id, owner: true, size: body.byteLength }));
    for (let i = 0; i < body.byteLength; i += WEB_RELAY.frame) mac.send(frame(id, body.subarray(i, i + WEB_RELAY.frame)));
    mac.send(JSON.stringify({ t: 'end', id }));
  } catch {
    finish(account, s, { status: 503, code: 'mac_offline', error: MAC_OFFLINE });
  }
  return head;
}

/** A kept Eden Secretary answer, as the Mac gave it (R2C-4); `x-eden-replayed: 1` says it wasn't asked again. */
function keptAnswer(done) {
  return new Response(done.bytes, { status: done.status, headers: { ...done.headers, 'x-eden-replayed': '1' } });
}

/** A browser waits on a Eden Secretary call already running for the same request id (R2C-4), `wait` ms at most. */
function attach(account, s, id, from, wait) {
  return new Promise((resolve) => {
    const w = { id, from, s, resolve, timer: null };
    w.timer = setTimeout(() => {
      dropWaiter(account, w);
      resolve(relayError(504, 'mac_timeout', 'Your Mac didn’t answer in time.'));
    }, wait);
    s.waiters.push(w);
    waitersOf(account).set(id, w);
  });
}

function dropWaiter(account, w) {
  clearTimeout(w.timer);
  waitersOf(account).delete(w.id);
  w.s.waiters = w.s.waiters.filter((x) => x !== w);
}

/**
 * The browser that asked a Eden Secretary call got its 202 and let go, but the call goes on (R2C-4): the Mac
 * isn't told to stop, the call may wait on its card as long as the relay allows (WEB_RELAY.headMs from
 * now), and its answer is kept for the page's retry.
 */
function detach(account, s) {
  if (s.detached) return;
  s.detached = true;
  const first = s.resolve;
  s.resolve = () => {};
  first(relayError(499, 'stopped', 'Stopped.'));
  if (s.phase === 'head') arm(account, s, WEB_RELAY.headMs);
}

/** No word from the Mac for `ms`: the request goes (with a cancel to the Mac). */
function arm(account, s, ms) {
  clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    const words = s.phase === 'head' ? 'Your Mac didn’t answer in time.' : 'Your Mac stopped answering.';
    cancel(account, s.id, { why: 'timeout', status: 504, code: 'mac_timeout', error: words });
  }, ms);
}

/** The stream ends: in full (no error), or with an error (a JSON answer before the head, a broken body after). */
function finish(account, s, error = null) {
  clearTimeout(s.timer);
  const streams = streamsOf(account);
  if (streams.get(s.id) !== s) return;
  streams.delete(s.id);
  if (s.phase === 'head') {
    s.phase = 'done';
    const e = error || { status: 502, code: 'mac_error', error: 'Your Mac sent no answer.' };
    s.resolve(relayError(e.status, e.code, e.error));
    for (const w of [...s.waiters]) {
      dropWaiter(account, w);
      w.resolve(relayError(e.status, e.code, e.error));
    }
    return;
  }
  if (s.buffered) {
    // A Eden Secretary call with a request id (R2C-4): its whole answer, to its browser (if still there), to any
    // waiting on it, and kept for a retry. Only the Mac's own complete answer is kept, never a relay error.
    s.phase = 'done';
    const b = s.buffered;
    let bytes = null;
    if (!error) {
      bytes = new Uint8Array(b.size);
      let at = 0;
      for (const c of b.chunks) {
        bytes.set(c, at);
        at += c.byteLength;
      }
      const replays = replaysOf(account);
      replays.set(s.key, { ask: s.ask, status: b.status, headers: b.headers, bytes, until: Date.now() + WEB_RELAY.replayMs });
      prune(replays, Date.now(), WEB_RELAY.replays);
    }
    const answer = (again) =>
      error ? relayError(error.status || 502, error.code || 'mac_error', error.error) : new Response(bytes, { status: b.status, headers: again ? { ...b.headers, 'x-eden-replayed': '1' } : b.headers });
    s.resolve(answer(false));
    for (const w of [...s.waiters]) {
      dropWaiter(account, w);
      w.resolve(answer(true));
    }
    return;
  }
  s.phase = 'done';
  try {
    if (error) s.controller.error(new Error(error.error));
    else s.controller.close();
  } catch {
    // the browser already let go
  }
}

/** Stop a stream: the Mac is told, the browser's side ends. `from`: only that browser's own. */
export function cancel(account, id, { from = null, why = 'stopped', keep = false, ...error } = {}) {
  const s = streamsOf(account).get(id);
  if (!s) {
    const w = waitersOf(account).get(id);
    if (w) {
      // Only this browser stops waiting; the call it waited on goes on for its own browser.
      if (from && w.from !== from) return;
      dropWaiter(account, w);
      w.resolve(relayError(499, 'stopped', 'Stopped.'));
    } else if (from && ID.test(id)) {
      // Not here yet (R2C-14c): the forward on its way finds this and never reaches the Mac.
      earlyOf(account).set(id, { keep, until: Date.now() + 60_000 });
    }
    return;
  }
  if (from && s.from !== from) return;
  if (keep && s.key) {
    detach(account, s);
    return;
  }
  try {
    s.ws.send(JSON.stringify({ t: 'cancel', id, why }));
  } catch {
    // the Mac is gone anyway
  }
  finish(account, s, error.error ? error : { status: 499, code: 'stopped', error: 'Stopped.' });
}

function ack(s) {
  if (s.unacked <= 0 || s.phase !== 'body') return;
  try {
    s.ws.send(JSON.stringify({ t: 'ack', id: s.id, n: s.unacked }));
    s.unacked = 0;
  } catch {
    // its close ends the stream
  }
}

function startBody(account, s, m) {
  const status = Number.isInteger(m.status) && m.status >= 200 && m.status <= 599 ? m.status : 502;
  const type = m.headers && typeof m.headers['content-type'] === 'string' ? m.headers['content-type'].trim() : '';
  const headers = {
    'content-type': CONTENT_TYPE.test(type) && type.length <= 200 ? type : 'application/octet-stream',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  if (/^text\/event-stream\b/i.test(headers['content-type'])) headers['x-accel-buffering'] = 'no';
  s.phase = 'body';
  if (s.key) {
    // A Eden Secretary call with a request id: gathered whole here (finish), so it can be kept for a retry.
    s.buffered = { status, headers, chunks: [], size: 0 };
    arm(account, s, WEB_RELAY.idleMs);
    return;
  }
  const body = new ReadableStream(
    {
      start(controller) {
        s.controller = controller;
      },
      pull() {
        ack(s); // the browser took some: the Mac may send more
      },
      cancel() {
        cancel(account, s.id, { why: 'stopped' });
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: WEB_RELAY.window }),
  );
  arm(account, s, WEB_RELAY.idleMs);
  s.resolve(new Response(body, { status, headers }));
}

/** A frame from a Mac's web channel. */
export function webMessage(account, ws, message) {
  if (typeof message === 'string') {
    if (message.length > WEB_RELAY.control) {
      ws.close(1009, 'frame too big');
      return;
    }
    let m;
    try {
      m = JSON.parse(message);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    if (m.type === 'ping') {
      try {
        ws.send('{"type":"pong"}');
      } catch {
        // closing
      }
      return;
    }
    const s = streamsOf(account).get(String(m.id || ''));
    if (!s || s.ws !== ws) return; // stopped already, or not this Mac's to answer
    if (m.t === 'res' && s.phase === 'head') startBody(account, s, m);
    else if (m.t === 'end') finish(account, s, s.phase === 'head' ? { status: 502, code: 'mac_error', error: 'Your Mac sent no answer.' } : null);
    else if (m.t === 'error') {
      const status = Number.isInteger(m.status) && m.status >= 400 && m.status <= 599 ? m.status : 502;
      const words = typeof m.error === 'string' && m.error ? m.error.slice(0, 500) : 'Your Mac couldn’t do that.';
      const code = typeof m.code === 'string' && /^[a-z_]{1,40}$/.test(m.code) ? m.code : 'mac_error';
      finish(account, s, { status, code, error: words });
    }
    return;
  }
  const size = message.byteLength;
  if (size > WEB_RELAY.frame + ID_BYTES) {
    ws.close(1009, 'frame too big');
    return;
  }
  const f = unframe(message);
  if (!f) return;
  const s = streamsOf(account).get(f.id);
  if (!s || s.ws !== ws || s.phase !== 'body') return;
  s.received += f.payload.byteLength;
  if (s.received > (s.buffered ? WEB_RELAY.replayMax : WEB_RELAY.response)) {
    cancel(account, s.id, { why: 'too_big', status: 502, code: 'too_big', error: 'Your Mac’s answer was too big.' });
    return;
  }
  if (s.buffered) {
    s.buffered.chunks.push(f.payload.slice());
    s.buffered.size += f.payload.byteLength;
    s.unacked += f.payload.byteLength;
    ack(s); // held here, not by a browser: the Mac may go on
    arm(account, s, WEB_RELAY.idleMs);
    return;
  }
  // A copy: the frame's buffer isn't ours to keep.
  s.controller.enqueue(f.payload.slice());
  s.unacked += f.payload.byteLength;
  if (s.controller.desiredSize > 0) ack(s);
  else if (s.controller.desiredSize < -2 * WEB_RELAY.window) {
    cancel(account, s.id, { why: 'window', status: 502, code: 'mac_error', error: 'Your Mac sent more than it was asked to hold.' });
    return;
  }
  arm(account, s, WEB_RELAY.idleMs);
}

/** A Mac's web channel closed: what it was answering ends, as "offline". */
export function webClosed(account, ws) {
  for (const s of [...streamsOf(account).values()]) {
    if (s.ws === ws) finish(account, s, { status: 503, code: 'mac_offline', error: MAC_OFFLINE });
  }
}

// ── in the Worker: hosted Eden's side (src/eden/chat.js) ──

/**
 * Whether a Mac is answering for this account ({ online, macs }); offline when it can't tell.
 */
export async function macStatus(env, who) {
  try {
    const response = await stub(env, who).fetch('https://account/web-status', { method: 'POST', headers: authHeaders(who), body: '{}' });
    if (response.ok) return await response.json();
  } catch {
    // below
  }
  return { online: false, macs: false };
}

const stub = (env, who) => env.ACCOUNTS.get(env.ACCOUNTS.idFromName(who.account));
const authHeaders = (who) => ({ 'content-type': 'application/json', 'x-jarvis-device': who.token.device, 'x-jarvis-secret': who.token.secret });

async function readCapped(request, cap) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) throw new ApiError(413, 'too_big', 'That request is too big for your Mac’s link.');
  const reader = request.body ? request.body.getReader() : null;
  const parts = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      reader.cancel().catch(() => {});
      throw new ApiError(413, 'too_big', 'That request is too big for your Mac’s link.');
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/**
 * The browser's request, answered by the Mac: its response streams through, and the browser
 * letting go (Stop) cancels it on the Mac. A refusal before the Mac answered (offline, too
 * big, too many) is thrown as an ApiError with its code. `wait`: ms for the Mac to answer;
 * `body`: the bytes to send when the request's own body was read already.
 */
export async function askMac(request, env, ctx, who, target, { wait, body: given, signal } = {}) {
  const method = request.method;
  const rid = requestIdOf(request, target);
  if (given && given.byteLength > WEB_RELAY.body) throw new ApiError(413, 'too_big', 'That request is too big for your Mac’s link.');
  const body = method === 'POST' ? given || (await readCapped(request, WEB_RELAY.body)) : null;
  const id = newStreamId();
  const headers = {
    ...authHeaders(who),
    'content-type': 'application/octet-stream',
    'x-eden-stream': id,
    'x-eden-method': method,
    'x-eden-path': target,
    'x-eden-h-content-type': request.headers.get('content-type') || '',
    'x-eden-h-accept': request.headers.get('accept') || '',
    ...(wait ? { 'x-eden-wait': String(wait) } : {}),
    ...(rid ? { 'x-eden-request-id': rid } : {}),
  };
  const account = stub(env, who);
  let stopped = false;
  // `keep`: the page got its 202 and will ask again with the same request id: the call goes on (R2C-4).
  const stop = (keep = false) => {
    if (stopped) return;
    stopped = true;
    const told = account
      .fetch('https://account/web-cancel', { method: 'POST', headers: authHeaders(who), body: JSON.stringify(keep && rid ? { id, keep: true } : { id }) })
      .then((r) => r.body?.cancel())
      .catch(() => {});
    ctx?.waitUntil?.(told);
  };
  // A browser gone before the Mac answered (where the runtime says so).
  request.signal?.addEventListener?.('abort', () => stop(), { once: true });
  signal?.addEventListener?.('abort', () => stop(signal.reason === KEEP_ON_MAC), { once: true }); // the caller giving up (askMacBy's deadline)
  // Already let go (R2C-14c): the Mac is never asked. (One that lets go while this is on its way is
  // caught by the account's object: its cancel arrives first and is remembered.)
  if (request.signal?.aborted || signal?.aborted) throw new ApiError(499, 'stopped', 'Stopped.');
  const upstream = await account.fetch('https://account/web-forward', { method: 'POST', headers, body });
  if (upstream.headers.get('x-eden-relay') === 'error') {
    const problem = await upstream.json().catch(() => ({}));
    throw new ApiError(upstream.status, problem.code || 'mac_error', problem.error || 'Your Mac couldn’t do that.', upstream.headers.get('retry-after') ? { 'retry-after': upstream.headers.get('retry-after') } : {});
  }
  if (!upstream.body) return upstream;
  const reader = upstream.body.getReader();
  const passed = new ReadableStream(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        reader.cancel(reason).catch(() => {});
        stop();
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(passed, { status: upstream.status, headers: upstream.headers });
}

// ── the page's own deadline (bug sweep 2026-10-09 C1/A1/C4) ──

/**
 * The page's `x-eden-wait: <seconds>`, clamped to WEB_RELAY.clientWaitMin…clientWaitMax, in ms; null
 * without it (or with something that isn't a number): the relay's own WEB_RELAY.headMs then, as before.
 */
export function clientWait(request) {
  const raw = request.headers.get('x-eden-wait');
  if (raw === null || !raw.trim()) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) return null;
  return Math.min(WEB_RELAY.clientWaitMax, Math.max(WEB_RELAY.clientWaitMin, seconds)) * WEB_RELAY.second;
}

export const APPROVAL_WAITING = { approval: 'waiting' };
export const macTooSlow = (seconds) =>
  `Your Mac didn’t answer within ${Math.round(seconds)} seconds. Check that it’s awake and that Eden is running on it, then try again.`;
export const APPROVAL_PENDING =
  'Eden is waiting for you to approve this on your Mac (“Let Eden use Eden Secretary?”). Once you approve it there, it runs; you don’t need to ask again.';
const KEEP_ON_MAC = Symbol('keep on the Mac');

/**
 * The page's `x-eden-request-id` on a Eden Secretary call (POST /api/chat/jarvis): one id per call, the same on
 * every retry of it (R2C-4). null without it or on any other route; a malformed one is a 400.
 */
export function requestIdOf(request, target) {
  if (request.method !== 'POST' || target !== JARVIS_CALL) return null;
  const raw = request.headers.get('x-eden-request-id');
  if (raw === null) return null;
  if (!REQUEST_ID.test(raw)) throw new ApiError(400, 'bad_request', 'x-eden-request-id is 16 to 64 letters, digits, - or _.');
  return raw;
}

/** The tool a Eden Secretary call's body names, when it's one that only reads (JARVIS_READS). */
function readsOnly(bytes) {
  try {
    const { tool } = JSON.parse(new TextDecoder().decode(bytes));
    return typeof tool === 'string' && JARVIS_READS.has(tool);
  } catch {
    return false;
  }
}

/** Whether Eden Secretary on the Mac is waiting on its "Let Eden use Eden Secretary?" card (its status says so); false when it can't tell. */
export async function approvalWaiting(request, env, ctx, who) {
  try {
    const asking = new Request(request.url, { method: 'GET', headers: { accept: 'application/json' } });
    const response = await askMac(asking, env, ctx, who, '/api/chat/jarvis/status', { wait: WEB_RELAY.probeMs });
    const body = await response.json().catch(() => null);
    return Boolean(response.ok && body && body.approval === 'waiting');
  } catch {
    return false;
  }
}

/**
 * askMac, with the page's own deadline when it sends `x-eden-wait` (clientWait). When the Mac hasn't
 * answered by then:
 *  - a Eden Secretary call (POST /api/chat/jarvis, the only route that may get a 202, R2C-5) while Eden Secretary waits
 *    on the owner's "Let Eden use Eden Secretary?" card on the Mac: 202 { approval: "waiting" }. The page polls
 *    GET /api/chat/jarvis/status and, once it's approved, asks again with the same `x-eden-request-id`.
 *    With that id the call isn't cancelled: it goes on on the Mac and its answer is kept for the retry
 *    (forward/detach, R2C-4). Without an id, only a tool that only reads gets the 202 (it's cancelled
 *    here and asked again: harmless); any other gets a 504 `approval_pending` (it runs once approved).
 *  - anything else, or a Mac that's just slow: a 504 `mac_timeout` at once.
 * A real relay error while the status is asked comes back as itself (R2C-14a). Without the header, or
 * when the caller set its own `wait`, it's askMac as it always was (the Mac app, older pages).
 */
export async function askMacBy(request, env, ctx, who, target, opts = {}) {
  const deadline = clientWait(request);
  if (!deadline || opts.wait) return askMac(request, env, ctx, who, target, opts);
  const seconds = deadline / WEB_RELAY.second;
  const tooSlow = () => new ApiError(504, 'mac_timeout', macTooSlow(seconds));
  const jarvis = request.method === 'POST' && target === JARVIS_CALL;
  const rid = requestIdOf(request, target);
  let body = opts.body;
  if (jarvis && !rid && !body) body = await readCapped(request, WEB_RELAY.body); // which tool: for the 202 without an id
  const giveUp = new AbortController();
  let settled = null;
  const answer = askMac(request, env, ctx, who, target, { ...opts, body, wait: deadline + WEB_RELAY.probeMs + WEB_RELAY.second, signal: giveUp.signal });
  answer.then((r) => (settled = { r }), (e) => (settled = { e }));
  let timer;
  const LATE = Symbol('late');
  let first;
  try {
    first = await Promise.race([answer, new Promise((resolve) => (timer = setTimeout(resolve, deadline, LATE)))]);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'mac_timeout') throw tooSlow();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (first !== LATE) return first;
  const letGo = (reason) => {
    giveUp.abort(reason);
    answer.catch(() => {});
  };
  if (!jarvis) {
    // A chat turn, mac/send, undo, a brief…: never a 202 (its empty answer would read as a reply).
    letGo();
    throw tooSlow();
  }
  const waiting = await approvalWaiting(request, env, ctx, who);
  if (settled && settled.r) return settled.r; // the Mac answered while its status was asked
  if (settled && settled.e) {
    if (settled.e instanceof ApiError && settled.e.code === 'mac_timeout') throw tooSlow();
    throw settled.e; // offline, refused…: as it is, not as a timeout
  }
  if (waiting && rid) {
    letGo(KEEP_ON_MAC);
    return json(APPROVAL_WAITING, 202);
  }
  letGo();
  if (waiting && readsOnly(body)) return json(APPROVAL_WAITING, 202);
  if (waiting) throw new ApiError(504, 'approval_pending', APPROVAL_PENDING);
  throw tooSlow();
}
