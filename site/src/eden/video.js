// Video understanding on askeden.com: the page posts a video (mp4, mov, webm) to POST /api/chat/video,
// which streams it on to the Gemini Files API (a resumable upload, with the asker's own Gemini key
// when they saved one, else the service's), waits for the file to be ACTIVE and answers
// { file, uri, mime, size, seconds, estimate }. The turn then names it as an attachment
// { kind: 'video', file, uri, mime, name, seconds }; only Gemini reads it (the cheapest capable model
// first, whatever the router or a pick said), as a file_data part. The file is deleted after the
// turn (Google deletes it after 48 hours anyway); Eden itself never stores it.
//
// Limits: 100 MB a video (Workers Paid takes request bodies up to 100 MB); 20 minutes on Free,
// 60 on Plus, checked here by Gemini's own videoMetadata (or, without it, by the size). A video
// counts ~300 input tokens a second (frames + audio at the default resolution); past 45 minutes
// it's sent at low resolution (~100 a second) to fit the context window. What the turn costs is
// Gemini's usageMetadata, charged as any turn.

import { ApiError, json } from '../accounts/util.js';
import { hasVision } from './vendor/providers.js';

export const VIDEO = {
  maxBytes: 100 * 1024 * 1024,
  freeSeconds: 20 * 60,
  plusSeconds: 60 * 60,
  confirmSeconds: 3 * 60,
  tokensPerSecond: 300,
  lowTokensPerSecond: 100,
  lowAfterSeconds: 45 * 60,
  waitMs: 120_000,
};
export const VIDEO_MIMES = ['video/mp4', 'video/quicktime', 'video/webm'];
const GEMINI = 'https://generativelanguage.googleapis.com';
const FILE_NAME = /^files\/[a-z0-9-]{1,64}$/;
const FILE_URI = /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/[a-z0-9-]{1,64}$/;

export const NO_GEMINI = 'Videos are read by Google Gemini, and Gemini isn’t available to you on askeden.com right now. Add your own Gemini key in Settings › Keys (or wait for your included AI to renew), then try again. Nothing was sent.';
const mb = (n) => `${Math.round(n / 1024 / 1024)} MB`;
const minutes = (s) => `${Math.round(s / 60)} minutes`;

/** The longest video this plan may send, in seconds (`bucket`: allow-ai's). */
export const videoCapSeconds = (bucket) => (bucket === 'plus' ? VIDEO.plusSeconds : VIDEO.freeSeconds);

/** A video's mime, size and length against the limits: null when fine, else why not. */
export function videoProblem({ mime, size, seconds }, capSeconds = VIDEO.freeSeconds) {
  const type = String(mime || '').toLowerCase().split(';')[0].trim();
  if (!VIDEO_MIMES.includes(type)) return 'Send the video as MP4, MOV or WebM.';
  if (!(Number(size) > 0)) return 'The video was empty.';
  if (Number(size) > VIDEO.maxBytes) return `That video is ${mb(size)}; askeden.com takes videos up to ${mb(VIDEO.maxBytes)}.`;
  if (Number(seconds) > capSeconds + 1) return `That video is ${minutes(seconds)} long; your plan takes videos up to ${minutes(capSeconds)}${capSeconds < VIDEO.plusSeconds ? ` (${minutes(VIDEO.plusSeconds)} on Plus)` : ''}.`;
  return null;
}

/** Whether a video this long is sent at low resolution. */
export const lowResolution = (seconds) => Number(seconds) > VIDEO.lowAfterSeconds;
/** The input tokens a video counts for, roughly. */
export const videoTokens = (seconds) => Math.ceil(Math.max(0, Number(seconds) || 0) * (lowResolution(seconds) ? VIDEO.lowTokensPerSecond : VIDEO.tokensPerSecond));
/** The video's input cost on a model, at list price: tokens × its input price. */
export const videoEstimateUSD = (seconds, model) => Math.round(videoTokens(seconds) * (model.pricing.inputPer1M / 1e6) * 1e6) / 1e6;

/** Gemini's "123.4s" → 123.4 (null when absent). */
export function parseDuration(d) {
  const m = /^(\d+(?:\.\d+)?)s$/.exec(String(d ?? ''));
  return m ? Number(m[1]) : null;
}

/** The models that may read a video, cheapest first: Gemini Flash-Lite, then Flash (Pro only when nothing else). */
export function videoModels(models) {
  const g = models.filter((m) => m.provider === 'gemini' && hasVision(m)).sort((a, b) => a.pricing.inputPer1M - b.pricing.inputPer1M);
  const cheap = g.filter((m) => !/-pro\b/.test(m.id));
  return cheap.length ? cheap : g;
}

/** The videos in a message. */
export const videosOf = (m) => (m && m.attachments ? m.attachments.filter((a) => a.kind === 'video') : []);

/** A video attachment of the turn, checked (400s through `bad`). */
export function videoAttachment(a, name, bad) {
  const mime = String(a.mime || '').toLowerCase();
  if (!VIDEO_MIMES.includes(mime)) bad(`video ${name}: mime must be video/mp4, video/quicktime or video/webm`);
  if (typeof a.file !== 'string' || !FILE_NAME.test(a.file)) bad(`video ${name}: file must be the name /api/chat/video gave`);
  if (typeof a.uri !== 'string' || !FILE_URI.test(a.uri) || !a.uri.endsWith(`/${a.file}`)) bad(`video ${name}: uri must be the one /api/chat/video gave`);
  const seconds = Number(a.seconds);
  return { kind: 'video', name, mime, file: a.file, uri: a.uri, ...(Number.isFinite(seconds) && seconds > 0 ? { seconds } : {}) };
}

/** Adds a turn's videos to a built Gemini request: file_data parts first in the last user message. */
export function withVideoParts(body, videos) {
  if (!videos.length) return body;
  const contents = body.contents || [];
  const last = contents[contents.length - 1];
  if (!last) return body;
  last.parts = [...videos.map((v) => ({ file_data: { file_uri: v.uri, mime_type: v.mime } })), ...(last.parts || [])];
  if (videos.some((v) => lowResolution(v.seconds))) body.generationConfig = { ...(body.generationConfig || {}), mediaResolution: 'MEDIA_RESOLUTION_LOW' };
  return body;
}

// ── the Files API ──

const url = (base, path) => (base ? `${base}/generativelanguage.googleapis.com${path}` : `${GEMINI}${path}`);

async function failed(response, what) {
  let detail = '';
  try {
    const j = await response.json();
    detail = (j.error && j.error.message) || '';
  } catch {
    // none
  }
  return new ApiError(502, 'ai_error', `Google couldn’t ${what} (${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}).`);
}

/** The file's metadata (null: gone). */
export async function getFile(key, name, base = null) {
  const r = await fetch(url(base, `/v1beta/${name}`), { headers: { 'x-goog-api-key': key } });
  if (r.status === 404 || r.status === 403) return null;
  if (!r.ok) throw await failed(r, 'read the video');
  return r.json();
}

/** Deletes the file at Google (best effort). */
export async function deleteFile(key, name, base = null) {
  try {
    await fetch(url(base, `/v1beta/${name}`), { method: 'DELETE', headers: { 'x-goog-api-key': key } });
  } catch {
    // it expires in 48 hours anyway
  }
}

/** Waits until Google has processed the file (ACTIVE), or throws. */
export async function waitActive(key, file, base = null, { waitMs = VIDEO.waitMs, everyMs = 1500 } = {}) {
  const until = Date.now() + waitMs;
  let f = file;
  while (f && f.state === 'PROCESSING') {
    if (Date.now() > until) throw new ApiError(504, 'ai_error', 'Google is taking too long to process the video. Try a shorter one.');
    await new Promise((r) => setTimeout(r, everyMs));
    f = await getFile(key, f.name, base);
  }
  if (!f || f.state !== 'ACTIVE') throw new ApiError(422, 'ai_error', 'Google couldn’t process that video. Try another file.');
  return f;
}

/** The video's length, by Gemini's metadata; without it, at least what its size says (~2 Mbit/s). */
export function fileSeconds(f, said = 0) {
  const meta = parseDuration(f && f.videoMetadata && f.videoMetadata.videoDuration);
  if (meta !== null) return meta;
  return Math.max(Number(said) || 0, (Number(f && f.sizeBytes) || 0) / 250_000);
}

/**
 * POST /api/chat/video: the body is the video; headers x-eden-name, x-eden-seconds (the page's
 * reading, checked again by Google's). `who` is gated; `ctx` { cfg, call }.
 */
export async function videoApi(request, env, who, { cfg, call, limited }) {
  if (request.method !== 'POST') throw new ApiError(405, 'bad_request', 'POST a video.');
  await limited(env, 'API_RATE', who.account);
  const mime = String(request.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
  const size = Number(request.headers.get('content-length'));
  const said = Number(request.headers.get('x-eden-seconds')) || 0;
  const allow = await call(env, who.account, 'allow-ai', { eden: true }, who.token);
  const cap = videoCapSeconds(allow.bucket);
  const why = videoProblem({ mime, size: size || 1, seconds: said }, cap);
  if (why) throw new ApiError(why.startsWith('Send') ? 415 : 413, 'too_big', why);
  if (!size) throw new ApiError(411, 'bad_request', 'Send the video with its length (content-length).');
  const gk = cfg.keys.gemini;
  const pool = videoModels(cfg.models.filter((m) => allow.ok || (gk && gk.source !== 'service')));
  if (!gk || !pool.length) throw new ApiError(422, 'no_provider', NO_GEMINI);
  const name = String(request.headers.get('x-eden-name') || 'video').replace(/[^\w .()-]/g, '').slice(0, 120) || 'video';
  // 1. Start a resumable upload.
  const start = await fetch(url(cfg.base, '/upload/v1beta/files'), {
    method: 'POST',
    headers: { 'x-goog-api-key': gk.key, 'x-goog-upload-protocol': 'resumable', 'x-goog-upload-command': 'start', 'x-goog-upload-header-content-length': String(size), 'x-goog-upload-header-content-type': mime, 'content-type': 'application/json' },
    body: JSON.stringify({ file: { display_name: name } }),
  });
  const upload = start.ok && start.headers.get('x-goog-upload-url');
  if (!upload) throw await failed(start, 'take the video');
  // 2. Stream the body on (a FixedLengthStream in the Worker, so nothing is buffered here).
  let body = request.body;
  if (typeof FixedLengthStream === 'function') {
    const fixed = new FixedLengthStream(size);
    request.body.pipeTo(fixed.writable).catch(() => {});
    body = fixed.readable;
  } else body = await request.arrayBuffer();
  const sent = await fetch(url(cfg.base, new URL(upload).pathname + new URL(upload).search), {
    method: 'POST',
    headers: { 'content-length': String(size), 'x-goog-upload-offset': '0', 'x-goog-upload-command': 'upload, finalize' },
    body,
  });
  if (!sent.ok) throw await failed(sent, 'take the video');
  const { file } = await sent.json();
  // 3. Processed, and within the plan's length by Google's own reading.
  const f = await waitActive(gk.key, file, cfg.base).catch(async (e) => {
    await deleteFile(gk.key, file.name, cfg.base);
    throw e;
  });
  const seconds = fileSeconds(f, said);
  const over = videoProblem({ mime, size, seconds }, cap);
  if (over) {
    await deleteFile(gk.key, f.name, cfg.base);
    throw new ApiError(413, 'too_big', over);
  }
  const model = pool[0];
  return json({
    file: f.name,
    uri: f.uri,
    mime,
    size,
    seconds: Math.round(seconds * 10) / 10,
    estimate: { model: model.id, name: model.name, tokens: videoTokens(seconds), usd: videoEstimateUSD(seconds, model), confirm: seconds > VIDEO.confirmSeconds },
  });
}
