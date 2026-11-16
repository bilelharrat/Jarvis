// Generated media for the Eden Creative Suite (docs/creative-api.md §7): what may be made, its price, and the calls to
// the providers askeden.com already uses. The account object runs the jobs (ops.js); the Worker parses and prices
// (api.js).
//
//   video    B-roll from a prompt (or a start frame): Google Veo, routed as the chat's videos are (eden/image.js
//            routeVideo: Veo 3 Fast, Veo 3 for "high", Veo 2 as fallback), at Veo's per-second list price, on the
//            Plus AI allowance, charged on success only and never above the quote.
//   speech   lines read in the Eden voice (Fish Audio, the voice askeden.com reads aloud with: worker.js voice()), on the
//            daily voice allowance in characters (account.js voice) and the site's daily ceiling (VOICE_QUOTA).
//   the rest "not yet" (NOT_YET): no fake results.

import { ApiError, sha256Hex } from '../accounts/util.js';
import { VIDEO_GEN, extractVeoVideo, refusalWords, routeVideo, videoUSD } from '../eden/image.js';
import { JARVIS_VOICE_ID, LIMITS as VOICE_LIMITS } from '../voice-config.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const SUITE_APPS = ['scorsese', 'ansel', 'davinci', 'houdini', 'lumiere', 'scribe', 'aldus']; // turn.js APPS
const FISH_TTS = 'https://api.fish.audio/v1/tts';

export const MEDIA = {
  quoteMs: 10 * 60_000, // a quote holds this long, once
  keepMs: 24 * 3600_000, // a job and its result are kept this long
  jobs: 20, // kept per account (the oldest finished go first)
  running: 3, // running at once per account
  chunk: 100_000, // base64 characters per stored piece (a Durable Object value is at most 128 KiB)
  videoDeadlineMs: 8 * 60_000, // a Veo clip that isn't back by then has failed
  videoExpectMs: 75_000, // what a clip usually takes, for `progress`
  speechLines: 100,
  speechChars: 20_000,
  lineChars: VOICE_LIMITS.text, // 600: the most the voice reads at once (worker.js voice)
  imageBytes: 4 * 1024 * 1024,
  promptChars: VIDEO_GEN.maxPrompt,
  speechTickMs: 20_000, // lines read per alarm, at most this long
};

export const LABEL = 'Generated';
export const KINDS = ['video', 'speech'];
export const NOT_YET = {
  voice_clone: 'Not yet: dubbing in the speaker’s own voice needs their recorded consent and a voice-cloning service, and askeden.com has neither yet.',
  lipsync: 'Not yet: askeden.com can’t match lips to a new voice yet.',
  music: 'Not yet: askeden.com can’t make music yet.',
  sound_effects: 'Not yet: askeden.com can’t make sound effects yet.',
  image: 'Not yet: askeden.com makes pictures in chat, but not for the Creative Suite yet.',
};

const on = (v) => String(v || '').trim().toLowerCase() === 'on';
/** Whether each kind can be made here now (the app shows the rest as "Not yet"). */
export function generationStatus(env) {
  const out = {};
  const videoOn = Boolean(String(env.GEMINI_API_KEY || '').trim()) && (on(env.EDEN_VIDEOS) || (!env.EDEN_VIDEOS && on(env.EDEN_IMAGES)));
  out.video = videoOn ? { available: true } : { available: false, why: 'Generated video isn’t switched on at askeden.com yet.' };
  out.speech = env.FISH_API_KEY && env.VOICE_QUOTA ? { available: true } : { available: false, why: 'The Eden voice isn’t set up at askeden.com yet.' };
  for (const [kind, why] of Object.entries(NOT_YET)) out[kind] = { available: false, why };
  return out;
}

// ── the request ──

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const bad = (message) => {
  throw new ApiError(400, 'bad_request', message);
};
const clean = (text) => String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
const known = (obj, keys, label) => {
  for (const key of Object.keys(obj)) if (!keys.includes(key)) bad(`${label}: unknown key ${JSON.stringify(key.slice(0, 40))}`);
};
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * A quote's or job's body checked: the canonical spec ({ kind, … }, the same for the same request), or a 400 / 422.
 * `extra`: keys allowed besides the spec's (the job's quote_id).
 */
export function parseMedia(body, extra = []) {
  if (!isObj(body)) bad('Send a JSON object.');
  if (body.app !== undefined && !SUITE_APPS.includes(body.app)) bad(`app is one of ${SUITE_APPS.join(', ')}`);
  const kind = body.kind;
  if (typeof kind !== 'string' || !kind) bad('kind is needed');
  if (Object.hasOwn(NOT_YET, kind)) throw new ApiError(422, 'not_yet', NOT_YET[kind]);
  if (!KINDS.includes(kind)) bad(`kind is one of ${[...KINDS, ...Object.keys(NOT_YET)].join(', ')}`);
  if (kind === 'video') {
    known(body, ['app', 'kind', 'prompt', 'seconds', 'aspect', 'quality', 'start_image', ...extra], 'video');
    if (typeof body.prompt !== 'string' || !body.prompt.trim()) bad('prompt must say what the clip shows');
    if (body.prompt.length > MEDIA.promptChars) throw new ApiError(413, 'too_long', `A prompt is at most ${MEDIA.promptChars} characters.`);
    const seconds = body.seconds === undefined ? VIDEO_GEN.defaultSeconds : body.seconds;
    if (![VIDEO_GEN.defaultSeconds, VIDEO_GEN.longSeconds].includes(seconds)) bad(`seconds is ${VIDEO_GEN.defaultSeconds} or ${VIDEO_GEN.longSeconds}`);
    const aspect = body.aspect === undefined ? '16:9' : body.aspect;
    if (!['16:9', '9:16'].includes(aspect)) bad('aspect is 16:9 or 9:16');
    const quality = body.quality === undefined ? 'standard' : body.quality;
    if (!['standard', 'high'].includes(quality)) bad('quality is standard or high');
    let image = null;
    if (body.start_image !== undefined && body.start_image !== null) {
      const s = body.start_image;
      if (!isObj(s)) bad('start_image is { media_type, data }');
      known(s, ['media_type', 'data'], 'start_image');
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(s.media_type)) bad('start_image.media_type is image/png, image/jpeg or image/webp');
      if (typeof s.data !== 'string' || !s.data || !B64.test(s.data)) bad('start_image.data is base64');
      if (Math.floor((s.data.length * 3) / 4) > MEDIA.imageBytes) throw new ApiError(413, 'too_big', 'A start frame is at most 4 MiB.');
      image = { media_type: s.media_type, data: s.data };
    }
    return { kind, prompt: clean(body.prompt).trim(), seconds, aspect, quality, ...(image ? { start_image: image } : {}) };
  }
  known(body, ['app', 'kind', 'lines', 'language', ...extra], 'speech');
  if (!Array.isArray(body.lines) || !body.lines.length) bad('lines must be a non-empty list of { text }');
  if (body.lines.length > MEDIA.speechLines) bad(`at most ${MEDIA.speechLines} lines a job`);
  let total = 0;
  const lines = body.lines.map((l, i) => {
    if (!isObj(l)) bad(`line ${i + 1} must be { text }`);
    known(l, ['text'], `line ${i + 1}`);
    if (typeof l.text !== 'string' || !l.text.trim()) bad(`line ${i + 1} needs text`);
    const text = clean(l.text).trim();
    if (text.length > MEDIA.lineChars) throw new ApiError(413, 'too_long', `Line ${i + 1} is over ${MEDIA.lineChars} characters: split it.`);
    total += text.length;
    return { text };
  });
  if (total > MEDIA.speechChars) throw new ApiError(413, 'too_long', `At most ${MEDIA.speechChars.toLocaleString('en-US')} characters a job.`);
  if (body.language !== undefined && (typeof body.language !== 'string' || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(body.language))) bad('language is a BCP 47 tag, like es or pt-BR');
  return { kind, lines, ...(body.language ? { language: body.language } : {}) };
}

/** The spec's fingerprint: what a job must match its quote by. */
export const specHash = (spec) => sha256Hex(JSON.stringify(spec));

/** What a spec costs and is made with: { kind, model, model_name, seconds, usd, chars, fallbacks }. */
export function priceFor(env, spec) {
  const status = generationStatus(env)[spec.kind];
  if (!status || !status.available) throw new ApiError(503, 'not_set_up', status ? status.why : 'Not set up here.');
  if (spec.kind === 'speech') {
    const chars = spec.lines.reduce((n, l) => n + l.text.length, 0);
    return { kind: 'speech', model: 'eden-voice', model_name: 'The Eden voice', seconds: null, usd: 0, chars, fallbacks: [] };
  }
  const decision = routeVideo({
    prompt: spec.prompt,
    fromImage: Boolean(spec.start_image),
    seconds: spec.seconds,
    settings: { level: spec.quality === 'high' ? 5 : 3 },
    envModel: env.EDEN_VIDEO_MODEL || '',
    keys: { gemini: { key: 'service', source: 'service' } },
  });
  if (!decision) throw new ApiError(503, 'not_set_up', 'No video model is set up at askeden.com.');
  return {
    kind: 'video',
    model: decision.chosen.id,
    model_name: decision.chosen.name,
    seconds: spec.seconds,
    usd: decision.costUSD,
    chars: 0,
    fallbacks: decision.fallbacks.map((f) => f.id),
  };
}

// ── Google Veo, one step at a time (the account object's alarm polls) ──

/** Starts a clip: → { ok: true, op } or { ok: false, status, retryable, message }. */
export async function veoStart(env, model, spec, { signal } = {}) {
  const instance = {
    prompt: spec.prompt,
    ...(spec.start_image ? { image: { bytesBase64Encoded: spec.start_image.data, mimeType: spec.start_image.media_type } } : {}),
  };
  let res;
  try {
    res = await fetch(`${GEMINI_BASE}/v1beta/models/${model}:predictLongRunning`, {
      method: 'POST',
      headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ instances: [instance], parameters: { aspectRatio: spec.aspect, durationSeconds: spec.seconds, sampleCount: 1 } }),
      signal,
    });
  } catch {
    return { ok: false, status: 502, retryable: true, message: 'Google Gemini couldn’t be reached. Try again.' };
  }
  const op = await res.json().catch(() => ({}));
  if (!res.ok || !op || typeof op.name !== 'string') {
    const blocked = /safety|blocked|policy/i.test(JSON.stringify(op));
    return { ok: false, status: res.ok ? 502 : res.status, retryable: !blocked && (!res.ok ? res.status === 429 || res.status >= 500 || res.status === 404 : true), message: refusalWords('gemini', res.ok ? 502 : res.status, op) };
  }
  return { ok: true, op: op.name };
}

/** One look at a running clip: → { ok, done, clip?: { mime, data }, message?, retryable? }. */
export async function veoPoll(env, name, { signal } = {}) {
  let res;
  try {
    res = await fetch(`${GEMINI_BASE}/v1beta/${String(name).replace(/^\/+/, '')}`, { headers: { 'x-goog-api-key': env.GEMINI_API_KEY }, signal });
  } catch {
    return { ok: false, retryable: true, message: 'Google Gemini couldn’t be reached.' };
  }
  const op = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, retryable: res.status === 429 || res.status >= 500, message: refusalWords('gemini', res.status, op) };
  if (!op.done) return { ok: true, done: false };
  if (op.error) return { ok: false, retryable: false, message: refusalWords('gemini', 400, { error: op.error }) };
  const clip = await extractVeoVideo(null, env.GEMINI_API_KEY, op, signal);
  if (!clip || !clip.data) {
    const rai = op?.response?.generateVideoResponse?.raiMediaFilteredReasons;
    return { ok: false, retryable: false, message: Array.isArray(rai) && rai.length ? 'Google Gemini’s safety rules don’t allow that clip. Try describing it differently.' : 'Google Gemini sent no video back. Try again.' };
  }
  return { ok: true, done: true, clip: { mime: clip.mime || 'video/mp4', data: clip.data } };
}

// ── the Eden voice ──

const bytesToB64 = (bytes) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/** One line read aloud: → { ok: true, mime, data (base64) } or { ok: false, retryable, message }. */
export async function fishSpeech(env, text, { signal } = {}) {
  let res;
  try {
    res = await fetch(FISH_TTS, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.FISH_API_KEY}`, model: env.FISH_MODEL || 's2.1-pro', 'content-type': 'application/json' },
      body: JSON.stringify({ text, reference_id: JARVIS_VOICE_ID, format: 'mp3', mp3_bitrate: 128, latency: 'normal' }),
      signal,
    });
  } catch {
    return { ok: false, retryable: true, message: 'The voice service couldn’t be reached.' };
  }
  if (!res.ok) {
    await res.text().catch(() => '');
    return { ok: false, retryable: res.status === 429 || res.status >= 500, message: `The voice service said ${res.status}.` };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length) return { ok: false, retryable: true, message: 'The voice service sent no audio.' };
  return { ok: true, mime: 'audio/mpeg', data: bytesToB64(bytes) };
}

/** The voice's daily ceiling for everyone, as worker.js voice() counts it (VOICE_DAILY_TOTAL). */
export function voiceCeiling(env) {
  const n = Number(env.VOICE_DAILY_TOTAL);
  return Number.isFinite(n) && n > 0 ? n : VOICE_LIMITS.everyone;
}

export { videoUSD };
