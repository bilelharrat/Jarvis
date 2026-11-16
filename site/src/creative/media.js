// Generated media for the Eden Creative Suite (docs/creative-api.md §7): what may be made, its price, and the calls to
// the providers askeden.com already uses. The account object runs the jobs (ops.js); the Worker parses and prices
// (api.js).
//
//   video    B-roll, a shot extended, a gap filled: from a prompt, or from a frame of the person's footage. The models
//            are VIDEO_MODELS (below): what Google serves today, priced per second from its price list, on the Plus AI
//            allowance, charged on success only and exactly the quote (never more).
//   speech   lines read in the Eden voice (Fish Audio, the voice askeden.com reads aloud with: worker.js voice()), on the
//            daily voice allowance in characters (account.js voice) and the site's daily ceiling (VOICE_QUOTA).
//   the rest "not yet" (NOT_YET): no fake results.

import { ApiError, sha256Hex } from '../accounts/util.js';
import { VIDEO_GEN, extractVeoVideo, refusalWords } from '../eden/image.js';
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
  videoDeadlineMs: 8 * 60_000, // a clip that isn't back by then has failed
  videoExpectMs: 90_000, // what a clip usually takes, for `progress`
  speechLines: 100,
  speechChars: 20_000,
  lineChars: VOICE_LIMITS.text, // 600: the most the voice reads at once (worker.js voice)
  imageBytes: 4 * 1024 * 1024,
  promptChars: VIDEO_GEN.maxPrompt,
  imageChunk: 100_000, // a start frame kept for the job in pieces too
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

// ── the video models ──
//
// Checked 2026-11-16 against Google's own pages: Google shut down every Veo model on the Gemini API and Vertex AI
// (Veo 2 and Veo 3.0 on June 30, 2026; the Veo 3.1 previews on October 22, 2026; aistudio.google.com/docs/deprecations).
// The Gemini API's video model is now Gemini Omni Flash (the Interactions API, aistudio.google.com/docs/omni): 3–15 s,
// 16:9 or 9:16, 360p / 720p / 1080p (upscaled), native audio, a SynthID watermark, a start frame as an input image.
// Its price (aistudio.google.com/docs/pricing): $12 per million output tokens, 5,792 tokens a second of 720p
// ($0.069504/s); about $0.023/s at 360p and $0.104/s at 1080p. The retired Veo models stay listed, unavailable, so an
// app that asks for one gets a plain answer, never a fake clip. Higgsfield isn't here: docs/creative-api.md §7.
export const VIDEO_MODELS = [
  {
    id: 'gemini-omni-1.2-flash',
    name: 'Gemini Omni Flash',
    provider: 'google',
    seconds: { min: 3, max: 15, default: 8 },
    aspects: ['16:9', '9:16'],
    resolutions: { '360p': 0.023, '720p': 0.069504, '1080p': 0.104 }, // dollars a second, Google's list price
    resolution: '720p',
    audio: true,
    start_image: true,
  },
  { id: 'veo-3.0-fast-generate-001', name: 'Veo 3 Fast', provider: 'google', retired: 'Google shut Veo 3 Fast down on June 30, 2026.' },
  { id: 'veo-3.0-generate-001', name: 'Veo 3', provider: 'google', retired: 'Google shut Veo 3 down on June 30, 2026.' },
  { id: 'veo-2.0-generate-001', name: 'Veo 2', provider: 'google', retired: 'Google shut Veo 2 down on June 30, 2026, on the Gemini API and on Vertex AI.' },
];
const videoModel = (id) => VIDEO_MODELS.find((m) => m.id === id) || null;

const on = (v) => String(v || '').trim().toLowerCase() === 'on';
const videosHere = (env) => Boolean(String(env.GEMINI_API_KEY || '').trim()) && !/^(off|0|false|no)$/i.test(String(env.EDEN_GEMINI ?? '').trim()) && (on(env.EDEN_VIDEOS) || (!env.EDEN_VIDEOS && on(env.EDEN_IMAGES)));

/** The video models as `quote` and `me` list them: each with its prices and limits, or why it can't be used. */
export function videoCatalog(env) {
  const here = videosHere(env);
  return VIDEO_MODELS.map((m) => {
    if (m.retired) return { id: m.id, name: m.name, provider: m.provider, available: false, why: m.retired };
    return {
      id: m.id,
      name: m.name,
      provider: m.provider,
      available: here,
      ...(here ? {} : { why: 'Generated video isn’t switched on at askeden.com yet.' }),
      seconds: m.seconds,
      aspects: m.aspects,
      resolutions: Object.entries(m.resolutions).map(([resolution, usd]) => ({ resolution, usd_per_second: usd })),
      default_resolution: m.resolution,
      audio: m.audio,
      start_image: m.start_image,
    };
  });
}

/** The model a video spec uses: the one asked for (it must be live here), else the first live one (the default). */
export function pickVideo(env, asked) {
  const live = videoCatalog(env).filter((m) => m.available);
  if (asked !== undefined && asked !== null) {
    const m = videoModel(asked);
    if (!m) bad(`model is one of ${VIDEO_MODELS.map((x) => x.id).join(', ')}`);
    if (m.retired) throw new ApiError(422, 'model_unavailable', `${m.retired} askeden.com can’t make clips with it.`);
    if (!live.some((x) => x.id === m.id)) throw new ApiError(503, 'not_set_up', 'Generated video isn’t switched on at askeden.com yet.');
    return m;
  }
  if (!live.length) throw new ApiError(503, 'not_set_up', 'Generated video isn’t switched on at askeden.com yet.');
  return videoModel(live[0].id);
}
/** Whether each kind can be made here now (the app shows the rest as "Not yet"). */
export function generationStatus(env) {
  const out = {};
  out.video = videosHere(env) ? { available: true, models: videoCatalog(env).filter((m) => m.available).map((m) => m.id) } : { available: false, why: 'Generated video isn’t switched on at askeden.com yet.' };
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
export function parseMedia(body, extra = [], env = null) {
  if (!isObj(body)) bad('Send a JSON object.');
  if (body.app !== undefined && !SUITE_APPS.includes(body.app)) bad(`app is one of ${SUITE_APPS.join(', ')}`);
  const kind = body.kind;
  if (typeof kind !== 'string' || !kind) bad('kind is needed');
  if (Object.hasOwn(NOT_YET, kind)) throw new ApiError(422, 'not_yet', NOT_YET[kind]);
  if (!KINDS.includes(kind)) bad(`kind is one of ${[...KINDS, ...Object.keys(NOT_YET)].join(', ')}`);
  if (kind === 'video') {
    known(body, ['app', 'kind', 'model', 'prompt', 'seconds', 'aspect', 'resolution', 'start_image', ...extra], 'video');
    // the model first: its own limits decide the rest (env: the Worker's, to know what's live here)
    const m = env ? pickVideo(env, body.model) : videoModel(body.model ?? VIDEO_MODELS[0].id);
    if (!m || m.retired) throw new ApiError(422, 'model_unavailable', m ? m.retired : 'No such video model.');
    if (typeof body.prompt !== 'string' || !body.prompt.trim()) bad('prompt must say what the clip shows');
    if (body.prompt.length > MEDIA.promptChars) throw new ApiError(413, 'too_long', `A prompt is at most ${MEDIA.promptChars} characters.`);
    const seconds = body.seconds === undefined ? m.seconds.default : body.seconds;
    if (!Number.isInteger(seconds) || seconds < m.seconds.min || seconds > m.seconds.max) bad(`seconds is a whole number from ${m.seconds.min} to ${m.seconds.max} for ${m.name}`);
    const aspect = body.aspect === undefined ? m.aspects[0] : body.aspect;
    if (!m.aspects.includes(aspect)) bad(`aspect is ${m.aspects.join(' or ')} for ${m.name}`);
    const resolution = body.resolution === undefined ? m.resolution : body.resolution;
    if (!Object.hasOwn(m.resolutions, resolution)) bad(`resolution is ${Object.keys(m.resolutions).join(', ')} for ${m.name}`);
    let image = null;
    if (body.start_image !== undefined && body.start_image !== null) {
      const st = body.start_image;
      if (!m.start_image) bad(`${m.name} can’t start from a frame`);
      if (!isObj(st)) bad('start_image is { media_type, data }');
      known(st, ['media_type', 'data'], 'start_image');
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(st.media_type)) bad('start_image.media_type is image/png, image/jpeg or image/webp');
      if (typeof st.data !== 'string' || !st.data || !B64.test(st.data)) bad('start_image.data is base64');
      if (Math.floor((st.data.length * 3) / 4) > MEDIA.imageBytes) throw new ApiError(413, 'too_big', 'A start frame is at most 4 MiB.');
      image = { media_type: st.media_type, data: st.data };
    }
    return { kind, model: m.id, prompt: clean(body.prompt).trim(), seconds, aspect, resolution, ...(image ? { start_image: image } : {}) };
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

/** What a spec costs and is made with: { kind, model, model_name, seconds, resolution?, usd, chars, models? }. */
export function priceFor(env, spec) {
  const status = generationStatus(env)[spec.kind];
  if (!status || !status.available) throw new ApiError(503, 'not_set_up', status ? status.why : 'Not set up here.');
  if (spec.kind === 'speech') {
    const chars = spec.lines.reduce((n, l) => n + l.text.length, 0);
    return { kind: 'speech', model: 'eden-voice', model_name: 'The Eden voice', seconds: null, usd: 0, chars };
  }
  const m = pickVideo(env, spec.model);
  const usd = Math.round(spec.seconds * m.resolutions[spec.resolution] * 1e6) / 1e6;
  return { kind: 'video', model: m.id, model_name: m.name, seconds: spec.seconds, resolution: spec.resolution, usd, chars: 0, models: videoCatalog(env) };
}

// ── Gemini Omni Flash (the Interactions API), run on the account object's alarm ──

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'canceled']);
const sleep = (ms, signal) => new Promise((res) => {
  const t = setTimeout(res, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
});

/**
 * One clip, start to finish: → { ok: true, clip: { mime, data } } or { ok: false, message }. One synchronous call, as
 * Google's docs advise (background, store and stream off); an answer still in progress is polled until `signal` ends.
 */
export async function omniGenerate(env, spec, { signal, pollMs = 3000 } = {}) {
  const key = String(env.GEMINI_API_KEY || '').trim();
  const input = spec.start_image
    ? [{ type: 'image', data: spec.start_image.data, mime_type: spec.start_image.media_type }, { type: 'text', text: spec.prompt }]
    : spec.prompt;
  let res;
  try {
    res = await fetch(`${GEMINI_BASE}/v1beta/interactions`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ model: spec.model, input, response_format: { duration: `${spec.seconds}s`, aspect_ratio: spec.aspect, resolution: spec.resolution }, background: false, store: false, stream: false }),
      signal,
    });
  } catch {
    return { ok: false, message: signal && signal.aborted ? 'Google took too long to make the clip.' : 'Google Gemini couldn’t be reached.' };
  }
  let op = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, message: refusalWords('gemini', res.status, op) };
  while (op && op.id && op.status && !TERMINAL.has(op.status) && !(signal && signal.aborted)) {
    await sleep(pollMs, signal);
    if (signal && signal.aborted) break;
    let poll;
    try {
      poll = await fetch(`${GEMINI_BASE}/v1beta/interactions/${encodeURIComponent(op.id)}`, { headers: { 'x-goog-api-key': key }, signal });
    } catch {
      break;
    }
    if (!poll.ok) return { ok: false, message: refusalWords('gemini', poll.status, await poll.json().catch(() => ({}))) };
    op = await poll.json().catch(() => ({}));
  }
  if (signal && signal.aborted) return { ok: false, message: 'Google took too long to make the clip.' };
  if (op && op.status && op.status !== 'completed') return { ok: false, message: refusalWords('gemini', 400, op) };
  const clip = await extractVeoVideo(null, key, op, signal); // the site's own reader: `steps` content, inline or a uri
  if (!clip || !clip.data) return { ok: false, message: 'Google sent no video back, or its safety rules didn’t allow this clip. Try describing it differently.' };
  return { ok: true, clip: { mime: clip.mime || 'video/mp4', data: clip.data } };
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

