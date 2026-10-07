// Dictation where the browser has no speech recognition (ROADMAP G7.2: Firefox has none): Eden's
// page records with MediaRecorder and posts the recording to POST /api/chat/transcribe (the audio
// itself as the body, its media type as the content type, signed in as for any Eden call) and
// gets { text } back. Here Workers AI's Whisper hears it (the AI binding in wrangler.toml), counted
// on the account's included AI at Cloudflare's price, the way a chat turn is: the allowance asked,
// the worst case held, what it cost spent, the hold let go. On the Mac, Eden's server asks
// J.A.R.V.I.S.'s own Whisper instead (askeden src/chat/transcribe.ts), with the same limits.
//
// The recording is never stored or logged, nor are its words.

import { ApiError, bytesToB64, json } from '../accounts/util.js';

export const TRANSCRIBE = {
  model: '@cf/openai/whisper-large-v3-turbo',
  // Cloudflare's price for that model (developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo).
  usdPerMinute: 0.000513,
  maxBytes: 25 * 1024 * 1024,
  maxSeconds: 120, // the page stops there; a few seconds more pass (slackSeconds)
  slackSeconds: 5,
};
const TYPES = new Set(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac', 'audio/mpeg', 'audio/wav', 'audio/wave', 'audio/x-wav']);
const TOO_BIG = 'That recording is too big (25 MB at most).';
const TOO_LONG = 'Recordings are 2 minutes at most.';

/** The recording's media type without parameters ("audio/webm;codecs=opus" → "audio/webm"), or null. */
export function audioType(value) {
  const base = String(value || '').split(';')[0].trim().toLowerCase();
  return TYPES.has(base) ? base : null;
}

/** Dollars for `seconds` of audio, rounded up to a millionth (the account counts in those). */
export const transcribeUSD = (seconds) => Math.ceil(((Math.max(0, seconds) / 60) * TRANSCRIBE.usdPerMinute) * 1e6) / 1e6;

async function readAudio(request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > TRANSCRIBE.maxBytes) throw new ApiError(413, 'too_big', TOO_BIG);
  const reader = request.body ? request.body.getReader() : null;
  const parts = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > TRANSCRIBE.maxBytes) {
      reader.cancel().catch(() => {});
      throw new ApiError(413, 'too_big', TOO_BIG);
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

/** POST /api/chat/transcribe (eden/chat.js has checked the session, the Origin and the header). */
export async function transcribeApi(request, env, who, { call, limited }) {
  if (request.method !== 'POST') throw new ApiError(405, 'bad_request', 'POST a recording.');
  if (!env.AI) throw new ApiError(503, 'not_set_up', 'Dictation by recording isn’t set up on askeden.com yet. Dictate in Chrome, Edge or Safari, which hear it themselves.');
  await limited(env, 'API_RATE', who.account);
  await limited(env, 'EDEN_RATE', `turn:${who.account}`); // as a chat turn
  const limit = TRANSCRIBE.maxSeconds + TRANSCRIBE.slackSeconds;
  const said = Number(request.headers.get('x-eden-seconds'));
  if (Number.isFinite(said) && said > limit) throw new ApiError(413, 'too_long', TOO_LONG);
  const audio = await readAudio(request);
  if (!audio.byteLength) throw new ApiError(400, 'bad_request', 'The recording was empty.');
  const allow = await call(env, who.account, 'allow-ai', { eden: true }, who.token);
  if (!allow.ok) throw new ApiError(402, 'no_allowance', allow.why);
  const hold = await call(env, who.account, 'hold-ai', { eden: true, usd: transcribeUSD(limit) }, who.token);
  if (!hold.ok) throw new ApiError(402, 'no_allowance', hold.why);
  try {
    const lang = /^([a-z]{2})(?:[-_]|$)/i.exec(String(request.headers.get('x-eden-lang') || ''));
    let out;
    try {
      out = await env.AI.run(TRANSCRIBE.model, { audio: bytesToB64(audio), task: 'transcribe', vad_filter: true, ...(lang ? { language: lang[1].toLowerCase() } : {}) });
    } catch (error) {
      console.error('transcribe failed', error && error.message);
      throw new ApiError(502, 'ai_error', 'Dictation didn’t work this time. Try again.');
    }
    // What Cloudflare counts: the recording's length (unknown: the worst case).
    const duration = Number(out && out.transcription_info && out.transcription_info.duration);
    const seconds = Number.isFinite(duration) && duration > 0 ? duration : limit;
    const usd = transcribeUSD(seconds);
    if (usd > 0) await call(env, who.account, 'spend', { usd, bucket: hold.bucket }).catch((error) => console.error('spend failed', error && error.message));
    if (seconds > limit) throw new ApiError(413, 'too_long', TOO_LONG);
    return json({ text: String((out && out.text) || '').trim(), seconds: Math.round(seconds * 10) / 10, costUSD: usd });
  } finally {
    await call(env, who.account, 'release-ai', { hold: hold.hold }).catch(() => {});
  }
}
