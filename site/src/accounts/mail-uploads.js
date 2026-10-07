// Gmail attachments uploaded ahead, for hosted Eden (ROADMAP F "Attachment pre-upload on the
// web"): the compose window uploads each file once, in chunks, and its autosaves and the send
// refer to it by id, as with Eden's server on the Mac (askeden src/chat/gmail-uploads.ts: the
// same actions, ids, chunk rules and limits per file). eden/gmail-uploads.js is the Worker's
// half. They live in the account object's storage, not in memory: the next chunk or the send
// rarely reaches the isolate that took the first.
//
//   mup:<id>       → { name, mime, size, received, chars, pieces, at, used }
//   mupc:<id>:<n>  → piece n of the file as base64 already in 76-column lines (CRLF), the way it
//                    goes into the message, at most PIECE characters (a Durable Object value is
//                    at most 128 KiB). Wrapped as each chunk arrives, so a send only joins pieces.
//
// <id> is the upload id itself (up_ + 32 hex: 128 random bits), the only way to an upload; it is
// never logged. Limits per account: 25 MB a file (Gmail's limit for a whole message), 100 MB
// and 100 uploads at once (reserved at start by the size given; 413 past them). An upload
// unused for 6 hours goes: when it's next asked for, and from the account's alarm queue
// (schedule.js, key 'uploads'). A send or schedule drops the uploads it used (the message is in
// Gmail by then); deleting the account drops everything (storage.deleteAll).
//
// Ops (POST https://account/mailup-<op>, as a device of the account: a browser, or a
// delegate's grant that includes mail, delegates.js grantGuard):
//   start { name, mime, size }        → upload info + chunkBytes
//   chunk { uploadId, offset, data }  → upload info (a chunk already stored is ignored)
//   meta { ids }                      → { uploads: [{ uploadId, name, mime, size, chars }] }:
//                                       complete ones only (410 gone, 409 unfinished); a use
//   read { uploadId }                 → the wrapped base64, streamed (text)
//   delete { ids }                    → { deleted }

import { ApiError, json, randomBytes } from './util.js';
import { queued, scheduleJob } from './schedule.js';
import { GoogleError, UPLOAD_CHUNK_BYTES, UPLOAD_ID, UPLOAD_MAX_BYTES, blockedExtension, missing, normalizeBase64, safeFileName } from '../eden/vendor/google.js';

export const MAIL_UPLOADS = {
  fileBytes: UPLOAD_MAX_BYTES,
  totalBytes: 100 * 1024 * 1024,
  count: 100,
  ttlMs: 6 * 3600_000,
  piece: 100_000,
  touchMs: 5 * 60_000, // a use moves the expiry at most this often (one write)
};
const JOB = 'uploads';
const MAX_IDS = 50; // a message's attachments and inline images (gmail.ts MAX_ATTACHMENTS)
const READ_BATCH = 16; // pieces a read takes from storage at a time (~1.6 MB)
const LINE = 76;
const MIME_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;

const headKey = (id) => `mup:${id}`;
const pieceKey = (id, n) => `mupc:${id}:${n}`;
const bad = (message) => new ApiError(400, 'bad_request', message);
const tooMany = (message) => new ApiError(413, 'bad_request', message);
const gone = () => {
  const e = missing(); // 410 upload_missing: the page uploads the file again
  return new ApiError(e.status, e.code, e.message);
};
const expired = (head, now) => now - head.used > MAIL_UPLOADS.ttlMs;
const info = (id, h) => ({ uploadId: id, name: h.name, mime: h.mime, size: h.size, received: h.received, complete: h.received === h.size });
const validId = (id) => typeof id === 'string' && UPLOAD_ID.test(id);

/** `b64` (standard base64 from character `at` of the whole file's) in lines as wrap76 writes them: CRLF before every 76th character but the first. */
export function wrapFrom(b64, at) {
  if (!b64) return '';
  const col = at % LINE;
  const lines = col === 0 && at > 0 ? [''] : [];
  let i = col ? Math.min(b64.length, LINE - col) : 0;
  if (i) lines.push(b64.slice(0, i));
  for (; i < b64.length; i += LINE) lines.push(b64.slice(i, i + LINE));
  return lines.join('\r\n');
}

/** The account's op (account.js: `if (op.startsWith('mailup-')) …`). */
export async function mailUploadOp(account, op, request) {
  try {
    await account.authenticate(request);
    const body = await request.json().catch(() => ({}));
    switch (op) {
      case 'mailup-start': return json(await start(account, body));
      case 'mailup-chunk': return json(await chunk(account, body));
      case 'mailup-meta': return json(await meta(account, body));
      case 'mailup-read': return await read(account, body);
      case 'mailup-delete': return json(await remove(account, body));
      default: throw new ApiError(404, 'not_found', 'No such thing.');
    }
  } catch (e) {
    if (e instanceof GoogleError) throw new ApiError(e.status, e.code, e.message); // Eden's checks (normalizeBase64)
    throw e;
  }
}

/** The alarm (account.js alarm(), kind 'uploads'): drops what expired; the next run's time, or nothing once none is left. */
export async function uploadsDue(account) {
  const live = await sweep(account, account.now());
  return live.length ? Math.min(...live.map(([, h]) => h.used)) + MAIL_UPLOADS.ttlMs + 1000 : undefined;
}

function checkFile(name, mime) {
  if (typeof name !== 'string' || !name.trim() || name.length > 500) throw bad('Each upload needs a file name.');
  const clean = safeFileName(name);
  const ext = blockedExtension(clean);
  if (ext) throw bad(`Gmail doesn't allow .${ext} attachments (they can carry harmful software).`);
  const m = mime === undefined || mime === null || mime === '' ? 'application/octet-stream' : mime;
  if (typeof m !== 'string' || !MIME_TYPE.test(m)) throw bad(`Attachment ${clean}: not a MIME type.`);
  return { name: clean, mime: m.toLowerCase() };
}

async function drop(account, list) {
  const keys = list.flatMap(([id, h]) => [headKey(id), ...Array.from({ length: h.pieces }, (_, n) => pieceKey(id, n))]);
  for (let i = 0; i < keys.length; i += 128) await account.storage.delete(keys.slice(i, i + 128));
}

/** Drops the expired uploads; the live ones as [[id, head]]. */
async function sweep(account, now) {
  const heads = [...(await account.storage.list({ prefix: 'mup:' })).entries()].map(([key, h]) => [key.slice(4), h]);
  const old = heads.filter(([, h]) => expired(h, now));
  if (old.length) await drop(account, old);
  return heads.filter(([, h]) => !expired(h, now));
}

async function find(account, id, now) {
  if (!validId(id)) throw bad('uploadId must be an id from uploadStart.');
  const h = await account.storage.get(headKey(id));
  if (!h) throw gone();
  if (expired(h, now)) {
    await drop(account, [[id, h]]);
    throw gone();
  }
  return h;
}

async function start(account, { name, mime, size }) {
  const f = checkFile(name, mime);
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) throw bad('size must be the file size in bytes.');
  if (size > MAIL_UPLOADS.fileBytes) throw bad(`${f.name} is ${(size / 1048576).toFixed(1)} MB; Gmail sends at most ${MAIL_UPLOADS.fileBytes / 1048576} MB. Share it from Google Drive and paste the link instead.`);
  const now = account.now();
  const live = await sweep(account, now);
  if (live.length >= MAIL_UPLOADS.count) throw tooMany('Eden holds too many uploads for this account right now; send or discard some drafts first.');
  if (live.reduce((n, [, h]) => n + h.size, 0) + size > MAIL_UPLOADS.totalBytes) throw tooMany('Eden holds too many attachments for this account right now; send or discard some drafts first.');
  const id = `up_${[...randomBytes(16)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  const h = { name: f.name, mime: f.mime, size, received: 0, chars: 0, pieces: 0, at: now, used: now };
  await account.storage.put(headKey(id), h);
  // The sweep keeps its own time once it runs (uploadsDue); it only has to exist.
  if (!(await queued(account)).some((j) => j.key === JOB)) await scheduleJob(account, JOB, JOB, now + MAIL_UPLOADS.ttlMs + 1000);
  return { ...info(id, h), chunkBytes: UPLOAD_CHUNK_BYTES };
}

async function chunk(account, { uploadId, offset, data }) {
  const now = account.now();
  const h = await find(account, uploadId, now);
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) throw bad('offset must be a byte offset.');
  const { b64, bytes } = normalizeBase64(data);
  if (bytes === 0 && h.size !== 0) throw bad('An empty chunk.');
  if (bytes > UPLOAD_CHUNK_BYTES) throw bad(`Chunks are at most ${UPLOAD_CHUNK_BYTES} bytes.`);
  if (offset + bytes <= h.received && offset < h.received) return info(uploadId, h); // a retry of a chunk already stored
  if (offset !== h.received) throw bad(`Expected the chunk at byte ${h.received}.`);
  if (offset + bytes > h.size) throw bad('The chunks pass the size given to uploadStart.');
  const last = offset + bytes === h.size;
  if (!last && (bytes % 3 !== 0 || b64.endsWith('='))) throw bad('Every chunk but the last must be a multiple of 3 bytes.');
  // Every chunk before this one was whole 3-byte groups: this one starts at character offset / 3 × 4.
  const text = wrapFrom(b64, (offset / 3) * 4);
  const entries = {};
  for (let i = 0; i < text.length; i += MAIL_UPLOADS.piece) entries[pieceKey(uploadId, h.pieces++)] = text.slice(i, i + MAIL_UPLOADS.piece);
  Object.assign(h, { received: h.received + bytes, chars: h.chars + text.length, used: now });
  entries[headKey(uploadId)] = h; // one put (a 3 MiB chunk is ~44 pieces): all of it or none
  await account.storage.put(entries);
  return info(uploadId, h);
}

async function meta(account, { ids }) {
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_IDS || !ids.every(validId)) throw bad('uploadId must be an id from uploadStart.');
  const now = account.now();
  const unique = [...new Set(ids)];
  const got = await account.storage.get(unique.map(headKey));
  const uploads = [];
  const touched = {};
  for (const id of unique) {
    const h = got.get(headKey(id));
    if (!h) throw gone();
    if (expired(h, now)) {
      await drop(account, [[id, h]]);
      throw gone();
    }
    if (h.received !== h.size) throw new ApiError(409, 'bad_request', `${h.name} hasn’t finished uploading.`);
    if (now - h.used > MAIL_UPLOADS.touchMs) touched[headKey(id)] = { ...h, used: now };
    uploads.push({ uploadId: id, name: h.name, mime: h.mime, size: h.size, chars: h.chars });
  }
  if (Object.keys(touched).length) await account.storage.put(touched);
  return { uploads };
}

async function read(account, { uploadId }) {
  const h = await find(account, uploadId, account.now());
  if (h.received !== h.size) throw new ApiError(409, 'bad_request', `${h.name} hasn’t finished uploading.`);
  const encoder = new TextEncoder();
  let n = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (n >= h.pieces) {
        controller.close();
        return;
      }
      const keys = Array.from({ length: Math.min(READ_BATCH, h.pieces - n) }, (_, i) => pieceKey(uploadId, n + i));
      const got = await account.storage.get(keys);
      for (const key of keys) {
        const piece = got.get(key);
        if (typeof piece !== 'string') {
          controller.error(new Error('upload removed while read')); // deleted meanwhile: the Worker counts short
          return;
        }
        controller.enqueue(encoder.encode(piece));
      }
      n += keys.length;
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/plain; charset=us-ascii' } });
}

async function remove(account, { ids }) {
  if (!Array.isArray(ids) || ids.length > MAX_IDS) throw bad('ids must be a list of upload ids.');
  const wanted = [...new Set(ids.filter(validId))];
  if (!wanted.length) return { deleted: 0 };
  const got = await account.storage.get(wanted.map(headKey));
  const found = wanted.filter((id) => got.has(headKey(id))).map((id) => [id, got.get(headKey(id))]);
  await drop(account, found);
  return { deleted: found.length };
}
