// Eden's voice (worker.js voice(), Fish Audio): the audio of FIXED phrases only is kept in Cloudflare's cache, so
// saying the same built-in sentence again costs no new Fish call (askeden docs/spend-guard.md).
//
//   VOICE_PHRASE_CACHE   off (default) | on
//
// Only the sentences below, which are written in Eden's own code and spoken whole, ever reach the cache: never a
// person's text, never a model's reply. Everything else streams from Fish exactly as before. The audio is the same
// voice, model and format either way, so nothing a person hears changes; their daily voice allowance is counted as
// before (worker.js takes it before this is asked).
//
// Fixed phrases found in the code (2026-11-10): the study tutor's "lost that" line (public/eden/tutor.js, English and
// its French from i18n-fr-edu.js). The tutor's greeting has the course's name in it and Travel's spoken answers come
// from the trip, so neither is fixed. Add a phrase here only if the page sends exactly that text.

export const FIXED_VOICE_PHRASES = Object.freeze(new Set([
  'Sorry, I lost that. Could you say it again?',
  'Désolé, je n’ai pas suivi. Pourriez-vous répéter ?',
]));

const CACHE_HOST = 'https://voice-cache.askeden.invalid'; // a cache key only, never fetched
const KEEP_S = 30 * 86_400;

export const phraseCacheOn = (env) => String((env && env.VOICE_PHRASE_CACHE) ?? '').trim().toLowerCase() === 'on';
const defaultSpeed = (speed) => !(Number.isFinite(Number(speed)) && Math.abs(Number(speed) - 1) >= 0.01);
const store = () => (typeof caches !== 'undefined' && caches && caches.default ? caches.default : null);

/** The cache key for a fixed phrase at the default speed (voice and model in it), or null: not cacheable. */
export async function phraseKey(env, { text, format, speed, voiceId }) {
  if (!phraseCacheOn(env) || !FIXED_VOICE_PHRASES.has(String(text)) || !defaultSpeed(speed)) return null;
  const id = `${voiceId || ''}|${(env && env.FISH_MODEL) || 's2.1-pro'}|${format}|${text}`;
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
  const hex = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${CACHE_HOST}/v1/${hex}`;
}

const headersFor = (format, extra = {}) => ({ 'content-type': format === 'wav' ? 'audio/wav' : 'application/octet-stream', 'cache-control': 'no-store', ...extra });

/** A fixed phrase's audio from the cache, or null (off, not fixed, not there, or the cache failed). Never throws. */
export async function voiceCached(env, { text, format, speed, voiceId, cache = store() }) {
  try {
    if (!cache) return null;
    const key = await phraseKey(env, { text, format, speed, voiceId });
    if (!key) return null;
    const hit = await cache.match(key);
    if (!hit || !hit.ok) return null;
    return new Response(hit.body, { status: 200, headers: headersFor(format, { 'x-eden-voice': 'cached' }) });
  } catch {
    return null;
  }
}

/**
 * Fish's answer for a fixed phrase, kept in the cache and handed back whole: a new Response (the phrase is one short
 * sentence, so reading it whole first costs nothing a person notices). Anything else: null, and the caller streams
 * Fish's answer as before. Never throws once it has read the body (a cache that fails: the audio still goes back).
 */
export async function voiceToCache(env, fish, { text, format, speed, voiceId, cache = store() }) {
  let key;
  try {
    if (!cache || !fish || !fish.ok || !fish.body) return null;
    key = await phraseKey(env, { text, format, speed, voiceId });
    if (!key) return null;
  } catch {
    return null;
  }
  const audio = await fish.arrayBuffer();
  try {
    await cache.put(key, new Response(audio.slice(0), { headers: { 'content-type': headersFor(format)['content-type'], 'cache-control': `public, max-age=${KEEP_S}` } }));
  } catch {
    // the cache is only a saving
  }
  return new Response(audio, { status: 200, headers: headersFor(format) });
}
