// Hosted Gmail's attachments uploaded ahead: the Worker's half (the account object keeps the
// files: accounts/mail-uploads.js). The compose window (askeden web/chat/compose.js) speaks
// what it speaks to Eden's server on the Mac (docs/chat-api.md "Gmail"): uploadStart,
// uploadChunk, uploadFromGmail and uploadDelete, then { uploadId } in draft, send and schedule,
// and 410 upload_missing when an upload is gone (the page uploads it again).
//
// A draft, send or schedule naming uploads: Eden's Gmail core (vendor/google.js) builds the
// message as on the Mac, but with a short stand-in for each uploaded file's base64, so nothing
// big passes through it; its Gmail calls go through this file's fetch, which puts each file
// back where its stand-in is:
//   - a message whose JSON request stays under 5 MB (MEDIA_UPLOAD_THRESHOLD) is joined in memory
//     and goes as `raw`, as before;
//   - a bigger one goes through Gmail's resumable upload: the start request with its exact size,
//     then PUTs of 8 MiB with Content-Range, streamed from the account object, so the Worker
//     holds one 8 MiB piece at a time however big the attachments (Workers have 128 MB).
// uploadFromGmail (reopened drafts, forwards) copies an attachment already in Gmail the same
// way: Gmail's JSON answer is read as a stream, its base64 handed on chunk by chunk.
// Upload ids are never logged; the account object only knows its own.

import { call } from '../accounts/index.js';
import { ApiError, b64ToBytes, b64url, randomBytes } from '../accounts/util.js';
import {
  GMAIL_API,
  GMAIL_UPLOAD_API,
  GoogleError,
  MAX_ATTACHMENT_BYTES,
  MEDIA_UPLOAD_THRESHOLD,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_ID,
  googleHttpError,
  missing,
} from './vendor/google.js';

export const UPLOAD_ACTIONS = new Set(['uploadStart', 'uploadChunk', 'uploadFromGmail', 'uploadDelete']);
const OUTGOING = new Set(['draft', 'send', 'schedule']);
/** Each PUT of a resumable upload: a multiple of 256 KiB, as Google asks. */
export const PUT_BYTES = 8 * 1024 * 1024;
const PUT_TIMEOUT_MS = 120_000;
const CHUNK_CHARS = (UPLOAD_CHUNK_BYTES / 3) * 4;
const MAX_REFS = 50;
const GMAIL_ID = /^[0-9A-Za-z_-]{1,128}$/;
const ATTACHMENT_ID = /^[0-9A-Za-z_-]{1,4096}$/;
const MESSAGE_PATH = /^\/(?:drafts(?:\/[0-9A-Za-z_-]{1,128})?|messages\/send)$/;
const GOOGLEAPIS = /^https:\/\/([a-z0-9-]+\.)*googleapis\.com\//i;

const bad = (message) => new GoogleError(message, 'bad_request', 400);
const upstream = (message) => new GoogleError(message, 'upstream', 502);
const hex = (n) => [...randomBytes(n)].map((b) => b.toString(16).padStart(2, '0')).join('');
const timeout = (ms) => (typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined);
const refsIn = (args) => [args.attachments, args.inline].flatMap((v) => (Array.isArray(v) ? v : [])).filter((x) => x && typeof x === 'object' && !Array.isArray(x));

/** uploadStart, uploadChunk, uploadFromGmail, uploadDelete. `gmail` is { token, fetch } for the account's Gmail. */
export async function uploadAction(env, who, action, args, gmail) {
  const op = (name, body) => call(env, who.account, `mailup-${name}`, body, who.token);
  switch (action) {
    case 'uploadStart':
      return op('start', { name: args.name, mime: args.mime, size: args.size });
    case 'uploadChunk':
      return op('chunk', { uploadId: args.uploadId, offset: args.offset, data: args.data });
    case 'uploadDelete':
      return { deleted: typeof args.uploadId === 'string' && UPLOAD_ID.test(args.uploadId) && (await op('delete', { ids: [args.uploadId] })).deleted > 0 };
    case 'uploadFromGmail':
      return fromGmail(op, args, gmail);
    default:
      throw bad('Not an upload action.');
  }
}

// ── uploadFromGmail ──

/** A Gmail GET with the account's token: once more with a fresh token on a 401. */
async function gmailGet(f, token, url) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await f(url, { method: 'GET', headers: { authorization: `Bearer ${await token(attempt > 0)}`, accept: 'application/json' }, signal: timeout(PUT_TIMEOUT_MS) });
    } catch (e) {
      if (e instanceof GoogleError) throw e;
      throw upstream('Could not reach Google (network error)');
    }
    if (res.status >= 200 && res.status < 300) return res;
    const text = await res.text();
    if (res.status === 401 && attempt === 0) continue;
    throw googleHttpError(res, text);
  }
}

/** Hands the base64url of an attachment's JSON (`{ size, data }`) to `each` in UPLOAD_CHUNK_BYTES chunks, as it streams in. */
export async function streamAttachmentData(res, each) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let head = '';
  let pending = '';
  let inData = false;
  for (;;) {
    const { done, value } = await reader.read();
    let text = done ? decoder.decode() : decoder.decode(value, { stream: true });
    if (!inData) {
      head += text;
      const m = /"data"\s*:\s*"/.exec(head);
      if (!m) {
        if (done || head.length > 65536) throw upstream('Gmail sent no attachment data.');
        continue;
      }
      text = head.slice(m.index + m[0].length);
      head = '';
      inData = true;
    }
    const end = text.indexOf('"');
    pending += end < 0 ? text : text.slice(0, end);
    while (pending.length >= CHUNK_CHARS) {
      await each(pending.slice(0, CHUNK_CHARS));
      pending = pending.slice(CHUNK_CHARS);
    }
    if (end >= 0) {
      if (pending) await each(pending);
      reader.cancel().catch(() => undefined);
      return;
    }
    if (done) throw upstream('Gmail’s answer ended early.');
  }
}

async function fromGmail(op, args, { token, fetch: f }) {
  if (typeof args.messageId !== 'string' || !GMAIL_ID.test(args.messageId)) throw bad('messageId must be a Gmail id.');
  if (typeof args.attachmentId !== 'string' || !ATTACHMENT_ID.test(args.attachmentId)) throw bad('attachmentId must be a Gmail id.');
  const url = `${GMAIL_API}/messages/${args.messageId}/attachments/${args.attachmentId}`;
  // Its size first (the upload is reserved by it), then the data, never whole in memory.
  const sized = await (await gmailGet(f, token, `${url}?fields=size`)).json().catch(() => ({}));
  if (!Number.isInteger(sized.size) || sized.size < 0) throw upstream('Gmail didn’t say how big the attachment is.');
  let info = await op('start', { name: typeof args.name === 'string' ? args.name : 'attachment', mime: typeof args.mime === 'string' ? args.mime : 'application/octet-stream', size: sized.size });
  try {
    if (!info.complete) {
      await streamAttachmentData(await gmailGet(f, token, url), async (data) => {
        info = await op('chunk', { uploadId: info.uploadId, offset: info.received, data });
      });
    }
    if (!info.complete) throw upstream('Gmail sent less of the attachment than it said.');
    const { chunkBytes: _c, ...done } = info;
    return done;
  } catch (e) {
    await op('delete', { ids: [info.uploadId] }).catch(() => undefined);
    throw e;
  }
}

// ── draft, send and schedule naming uploads ──

/**
 * For draft, send and schedule when they name uploads: { store (the core's UploadStore, with
 * stand-ins), fetch(f, token) (the core's Gmail fetch), free() (drops them), error (what really
 * went wrong in that fetch: the core reports any fetch failure as "could not reach Google") }.
 * null when nothing uploaded is named. 410 when an upload is gone, 409 when one isn't finished.
 */
export async function outgoingUploads(env, who, action, args) {
  if (!OUTGOING.has(action)) return null;
  const named = refsIn(args).filter((x) => x.uploadId !== undefined && x.data === undefined);
  if (!named.length) return null;
  const ids = [...new Set(named.map((x) => x.uploadId))];
  if (named.length > MAX_REFS || !ids.every((id) => typeof id === 'string' && UPLOAD_ID.test(id))) throw bad('uploadId must be an id from uploadStart.');
  const { uploads } = await call(env, who.account, 'mailup-meta', { ids }, who.token);
  const byId = new Map(uploads.map((u) => [u.uploadId, u]));
  // The core counts the stand-ins, so the 25 MB is counted here, with the real sizes.
  const total = named.reduce((n, x) => n + byId.get(x.uploadId).size, 0) + refsIn(args).reduce((n, x) => n + (typeof x.data === 'string' ? Math.floor((x.data.length * 3) / 4) : 0), 0);
  if (total > MAX_ATTACHMENT_BYTES) {
    throw bad(`Attachments come to ${(total / 1048576).toFixed(1)} MB; Gmail sends at most ${MAX_ATTACHMENT_BYTES / 1048576} MB. Share the big files from Google Drive and paste the link instead.`);
  }

  // A stand-in: valid base64 (the core checks it), a multiple of 4, under one 76-column line,
  // with a random part no message text can hold by chance.
  const nonce = hex(12);
  uploads.forEach((u, i) => {
    u.standIn = `Eden${nonce}${String(i).padStart(4, '0')}`;
  });
  const STAND_IN = new RegExp(`Eden${nonce}(\\d{4})`, 'g');
  const LATER = `https://gmail.googleapis.com/eden-upload/${nonce}`;
  const state = { error: null };
  const gone = () => {
    throw missing();
  };
  const store = {
    get(id) {
      const u = byId.get(id);
      if (!u) gone();
      return { name: u.name, mime: u.mime, b64: u.standIn, size: u.size };
    },
    start: gone,
    chunk: gone,
    put: gone,
    info: gone,
    remove: () => false,
    held: () => 0,
  };

  /** One upload's wrapped base64, streamed from the account object (410 when it went meanwhile). */
  async function* bytesOf(u) {
    const res = await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(who.account)).fetch('https://account/mailup-read', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jarvis-device': who.token.device, 'x-jarvis-secret': who.token.secret },
      body: JSON.stringify({ uploadId: u.uploadId }),
    });
    if (res.status >= 400) {
      const j = await res.json().catch(() => ({}));
      throw new ApiError(res.status, j.code || 'error', j.error || 'Something went wrong.');
    }
    const reader = res.body.getReader();
    let n = 0;
    for (;;) {
      let step;
      try {
        step = await reader.read();
      } catch {
        throw new ApiError(410, 'upload_missing', missing().message);
      }
      if (step.done) break;
      n += step.value.length;
      yield step.value;
    }
    if (n !== u.chars) throw new ApiError(410, 'upload_missing', missing().message);
  }

  /** The message: its text around the stand-ins as bytes, and the uploads, in order; its size. */
  function split(mime) {
    const encoder = new TextEncoder();
    const parts = [];
    let at = 0;
    for (const m of mime.matchAll(STAND_IN)) {
      parts.push(encoder.encode(mime.slice(at, m.index)), uploads[Number(m[1])]);
      at = m.index + m[0].length;
    }
    parts.push(encoder.encode(mime.slice(at)));
    return { parts, size: parts.reduce((n, p) => n + (p instanceof Uint8Array ? p.length : p.chars), 0) };
  }

  /** Gmail's resumable upload of the message, PUT_BYTES at a time. Its last answer is Gmail's (the draft, the sent message). */
  async function resumable(f, token, { method, path, meta, parts, size, auth }) {
    const begin = (authorization) =>
      f(`${GMAIL_UPLOAD_API}${path}?uploadType=resumable`, {
        method,
        headers: { authorization, accept: 'application/json', 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'message/rfc822', 'x-upload-content-length': String(size) },
        body: JSON.stringify(meta),
      });
    let started = await begin(auth);
    if (started.status === 401) {
      auth = `Bearer ${await token(true)}`;
      started = await begin(auth);
    }
    if (started.status < 200 || started.status >= 300) return started;
    const session = started.headers.get('location') || '';
    if (!GOOGLEAPIS.test(session)) throw upstream('Gmail didn’t start the upload.');
    let sent = 0;
    let fill = 0;
    let buf = new Uint8Array(Math.min(PUT_BYTES, size));
    const put = () =>
      f(session, { method: 'PUT', headers: { authorization: auth, 'content-range': `bytes ${sent}-${sent + fill - 1}/${size}` }, body: buf.subarray(0, fill), redirect: 'manual', signal: timeout(PUT_TIMEOUT_MS) });
    for (const p of parts) {
      for await (const bytes of p instanceof Uint8Array ? [p] : bytesOf(p)) {
        for (let i = 0; i < bytes.length; ) {
          const n = Math.min(buf.length - fill, bytes.length - i);
          if (n === 0) throw upstream('The message grew while it was being sent.');
          buf.set(bytes.subarray(i, i + n), fill);
          fill += n;
          i += n;
          if (fill === buf.length && sent + fill < size) {
            const res = await put();
            if (res.status >= 200 && res.status < 300) throw upstream('Gmail ended the upload early.');
            if (res.status !== 308) return res; // Gmail's error: the core reports it
            if ((res.headers.get('range') || '') !== `bytes=0-${sent + fill - 1}`) throw upstream('Gmail didn’t take the whole upload; try again.');
            sent += fill;
            fill = 0;
            buf = new Uint8Array(Math.min(PUT_BYTES, size - sent));
          }
        }
      }
    }
    if (sent + fill !== size) throw upstream('The message shrank while it was being sent.');
    return put();
  }

  /** The real message for one of the core's Gmail calls (`meta` is its JSON without `raw`). */
  async function deliver(f, token, msg) {
    const { parts, size } = split(msg.mime);
    if (Math.ceil((size * 4) / 3) + 256 > MEDIA_UPLOAD_THRESHOLD) return resumable(f, token, { ...msg, parts, size });
    // Small enough for a JSON `raw`: joined in memory (a few MB at most).
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      for await (const b of p instanceof Uint8Array ? [p] : bytesOf(p)) {
        if (at + b.length > size) throw upstream('The message grew while it was being sent.');
        bytes.set(b, at);
        at += b.length;
      }
    }
    const meta = msg.meta;
    const holder = msg.path.startsWith('/drafts') ? (meta.message ??= {}) : meta;
    holder.raw = b64url(bytes);
    return f(`${GMAIL_API}${msg.path}`, { method: msg.method, headers: { authorization: msg.auth, accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(meta) });
  }

  let later = null; // the core's own resumable start (a message big even with stand-ins), until its PUT
  async function route(f, token, url, init) {
    const method = init.method || 'GET';
    const auth = (init.headers || {}).authorization;
    // drafts.create / drafts.update / messages.send with `raw` (the core's usual way)
    if ((method === 'POST' || method === 'PUT') && url.startsWith(`${GMAIL_API}/`) && MESSAGE_PATH.test(url.slice(GMAIL_API.length)) && typeof init.body === 'string') {
      const meta = JSON.parse(init.body);
      const holder = meta.message && typeof meta.message === 'object' ? meta.message : meta;
      if (typeof holder.raw !== 'string') return f(url, init);
      const mime = new TextDecoder().decode(b64ToBytes(holder.raw));
      if (!mime.includes(`Eden${nonce}`)) return f(url, init);
      delete holder.raw;
      return deliver(f, token, { method, path: url.slice(GMAIL_API.length), meta, mime, auth });
    }
    // The core's own resumable upload: answered here, and done for real at its PUT (with the real size).
    if (url.startsWith(`${GMAIL_UPLOAD_API}/`) && /[?&]uploadType=resumable(&|$)/.test(url)) {
      const path = url.slice(GMAIL_UPLOAD_API.length).replace(/\?.*$/, '');
      if (MESSAGE_PATH.test(path)) {
        later = { method, path, meta: JSON.parse(init.body || '{}'), auth };
        return new Response('{}', { status: 200, headers: { location: LATER, 'content-type': 'application/json' } });
      }
    }
    if (url === LATER && later && typeof init.body === 'string') {
      const msg = { ...later, mime: init.body };
      later = null;
      return deliver(f, token, msg);
    }
    return f(url, init);
  }

  return {
    store,
    get error() {
      return state.error;
    },
    fetch: (f, token) => async (url, init = {}) => {
      try {
        return await route(f, token, url, init);
      } catch (e) {
        if (e instanceof GoogleError || e instanceof ApiError) state.error ??= e;
        throw e;
      }
    },
    free: () => call(env, who.account, 'mailup-delete', { ids }, who.token).catch(() => undefined),
  };
}
