// Pictures in Eden's chat: the model asks with <eden-tool>{"name":"make_image",…}</eden-tool> (askeden
// web/chat/eden-tools.js), the page posts the prompt here (POST /api/chat/image, JSON, signed in as for any
// Eden call) and draws the picture it gets back under the reply. Workers AI makes it (the AI binding in
// wrangler.toml, the one dictation uses): FLUX.2 [klein] 4B, which can also start from up to two small
// pictures (the last one Eden made, or one the user attached). Counted on the account's included AI at
// Cloudflare's price, the way a chat turn is: the allowance asked, the worst case held, what it cost spent,
// the hold let go. Llama Guard reads every prompt first (the page's model is the first gate, but this route
// can be called without it): anything it calls unsafe is refused before a picture is made.
//
// A daily count per account, per network and for everyone (the VoiceQuota object) keeps the day under
// Workers AI's free 10,000 neurons until the Workers Paid plan is on (then raise IMAGES_DAILY_TOTAL).
//
// Prompts and pictures are never stored or logged here; the picture stays in the browser that asked.

import { ApiError, b64ToBytes, json, networkOf } from '../accounts/util.js';

export const IMAGE = {
  model: '@cf/black-forest-labs/flux-2-klein-4b',
  guard: '@cf/meta/llama-guard-3-8b',
  // Cloudflare's prices (developers.cloudflare.com/workers-ai/platform/pricing): per 512×512 tile.
  usdPerOutputTile: 0.000287,
  usdPerInputTile: 0.000059,
  usdGuard: 0.0002, // ~250 prompt tokens at $0.484/M, rounded up
  maxPrompt: 2000,
  maxRefs: 2,
  maxRefBytes: 400_000,
  maxRefSide: 511, // the model wants each starting picture under 512×512
  maxBody: 1_200_000,
};
export const SIZES = { square: [1024, 1024], wide: [1344, 768], tall: [768, 1344] };
// Llama Guard 3's hazard codes that don't apply to a picture (specialized advice, intellectual property, code
// interpreter abuse); every other unsafe verdict refuses it.
const NOT_FOR_PICTURES = new Set(['S6', 'S8', 'S14']);
const DAILY = { perAccount: 40, total: 60, networkFactor: 3 };
const REFUSED = 'Eden won’t make that picture. Ask for something else.';

const tiles = (w, h) => Math.ceil(w / 512) * Math.ceil(h / 512);
/** Dollars for one picture of `size` from `refs` starting pictures, the safety check included, rounded up to a millionth. */
export const imageUSD = (size = 'square', refs = 0) => {
  const [w, h] = SIZES[size] || SIZES.square;
  return Math.ceil((tiles(w, h) * IMAGE.usdPerOutputTile + refs * IMAGE.usdPerInputTile + IMAGE.usdGuard) * 1e6) / 1e6;
};

/** A starting picture's width and height from its JPEG or PNG header, or null for anything else. */
export function pictureSize(bytes) {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { mime: 'image/png', w: v.getUint32(16), h: v.getUint32(20) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      // a start-of-frame marker (not DHT C4, JPG C8, DAC CC) carries the size
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: 'image/jpeg', h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8] };
      }
      if (len < 2) return null;
      i += 2 + len;
    }
  }
  return null;
}

/** The request, checked: { prompt, size, refs: [{ bytes, mime }] }. */
export function parseImageBody(raw) {
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.replace(/\s+/g, ' ').trim() : '';
  if (!prompt) throw new ApiError(400, 'bad_request', 'Say what the picture should show.');
  if (prompt.length > IMAGE.maxPrompt) throw new ApiError(400, 'bad_request', `A picture’s description is ${IMAGE.maxPrompt.toLocaleString('en')} characters at most.`);
  const size = raw.size === undefined || raw.size === null || raw.size === '' ? 'square' : raw.size;
  if (!Object.prototype.hasOwnProperty.call(SIZES, size)) throw new ApiError(400, 'bad_request', 'size is square, wide or tall.');
  const list = raw.refs === undefined || raw.refs === null ? [] : raw.refs;
  if (!Array.isArray(list) || list.length > IMAGE.maxRefs) throw new ApiError(400, 'bad_request', `At most ${IMAGE.maxRefs} starting pictures.`);
  const refs = list.map((r) => {
    let bytes;
    try {
      bytes = b64ToBytes(r && typeof r.data === 'string' ? r.data : '');
    } catch {
      throw new ApiError(400, 'bad_request', 'A starting picture didn’t come through.');
    }
    if (!bytes.length || bytes.length > IMAGE.maxRefBytes) throw new ApiError(413, 'too_big', 'A starting picture is too big.');
    const s = pictureSize(bytes);
    if (!s) throw new ApiError(415, 'bad_request', 'Starting pictures are JPEG or PNG.');
    if (s.w > IMAGE.maxRefSide || s.h > IMAGE.maxRefSide || !s.w || !s.h) throw new ApiError(400, 'bad_request', 'Starting pictures are under 512×512.');
    return { bytes, mime: s.mime };
  });
  return { prompt, size, refs };
}

/** Llama Guard's verdict on a prompt: { safe, categories }. */
export async function checkPrompt(env, prompt) {
  const out = await env.AI.run(IMAGE.guard, {
    messages: [{ role: 'user', content: `Make this picture: ${prompt}` }],
    temperature: 0,
    response_format: { type: 'json_object' },
  });
  const r = out && out.response;
  if (r && typeof r === 'object' && typeof r.safe === 'boolean') {
    const categories = Array.isArray(r.categories) ? r.categories.map(String) : [];
    return { safe: r.safe || (categories.length > 0 && categories.every((c) => NOT_FOR_PICTURES.has(c))), categories };
  }
  // the plain-text form: "safe", or "unsafe\nS1,S4"
  const text = String(r || '').trim();
  if (/^safe\b/i.test(text)) return { safe: true, categories: [] };
  const categories = text.match(/S\d+/g) || [];
  if (/^unsafe\b/i.test(text)) return { safe: categories.length > 0 && categories.every((c) => NOT_FOR_PICTURES.has(c)), categories };
  throw new Error('no verdict');
}

const dailyOf = (env) => ({
  perAccount: Math.max(0, Number(env.IMAGES_DAILY_PER_ACCOUNT) || DAILY.perAccount),
  total: Math.max(0, Number(env.IMAGES_DAILY_TOTAL) || DAILY.total),
});
const resetsAt = () => ({ 'retry-after': String(Math.max(60, Math.ceil((Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) + 86_400_000 - Date.now()) / 1000))) });

/** One picture taken from (or, with `give`, given back to) the day's count. Without the binding (tests of other parts), unlimited. */
async function count(env, account, network, give = false) {
  if (!env.VOICE_QUOTA) return { ok: true };
  const d = dailyOf(env);
  const stub = env.VOICE_QUOTA.get(env.VOICE_QUOTA.idFromName('images'));
  const answer = await stub.fetch(`https://quota/${give ? 'give' : 'take'}`, {
    method: 'POST',
    body: JSON.stringify({ install: `a:${account}`, network, chars: 1, limits: { install: d.perAccount, network: d.perAccount * DAILY.networkFactor, everyone: d.total } }),
  });
  const v = await answer.json();
  return { ok: Boolean(v.ok), which: v.which };
}

/** Workers AI's answer when the account's free daily neurons are used up (Workers Free plan). */
const outOfNeurons = (error) => /\b4006\b|daily free allocation|neurons/i.test(String((error && error.message) || error));

/** POST /api/chat/image (eden/chat.js has checked the session, the Origin and the header). */
export async function imageApi(request, env, who, { call, limited, readBody }) {
  if (request.method !== 'POST') throw new ApiError(405, 'bad_request', 'POST a picture’s description.');
  if (!env.AI) throw new ApiError(503, 'not_set_up', 'Making pictures isn’t set up on askeden.com yet.');
  await limited(env, 'API_RATE', who.account);
  await limited(env, 'EDEN_RATE', `turn:${who.account}`); // as a chat turn
  const { prompt, size, refs } = parseImageBody(await readBody(request, IMAGE.maxBody));
  const allow = await call(env, who.account, 'allow-ai', { eden: true }, who.token);
  if (!allow.ok) throw new ApiError(402, 'no_allowance', allow.why);
  const network = `ip:${networkOf(request.headers.get('cf-connecting-ip') || 'unknown')}`;
  const taken = await count(env, who.account, network);
  if (!taken.ok) {
    throw new ApiError(429, 'image_limit', taken.which === 'everyone'
      ? 'Eden has made all the pictures it can today. Try again after midnight UTC.'
      : `That’s today’s ${dailyOf(env).perAccount} pictures. They start again at midnight UTC.`, resetsAt());
  }
  const worst = imageUSD(size, refs.length);
  let made = false;
  const hold = await call(env, who.account, 'hold-ai', { eden: true, usd: worst }, who.token);
  if (!hold.ok) {
    await count(env, who.account, network, true).catch(() => {});
    throw new ApiError(402, 'no_allowance', hold.why);
  }
  let spent = 0;
  try {
    let verdict;
    try {
      verdict = await checkPrompt(env, prompt);
    } catch (error) {
      console.error('image guard failed', error && error.message);
      throw new ApiError(outOfNeurons(error) ? 503 : 502, outOfNeurons(error) ? 'image_busy' : 'ai_error', outOfNeurons(error) ? 'Eden has made all the pictures it can today. Try again after midnight UTC.' : 'The picture couldn’t be made this time. Try again.');
    }
    spent = IMAGE.usdGuard;
    if (!verdict.safe) throw new ApiError(422, 'refused', REFUSED);
    const [width, height] = SIZES[size];
    const form = new FormData();
    form.append('prompt', prompt);
    form.append('width', String(width));
    form.append('height', String(height));
    refs.forEach((r, i) => form.append(`input_image_${i}`, new Blob([r.bytes], { type: r.mime }), `start-${i}.${r.mime === 'image/png' ? 'png' : 'jpg'}`));
    const body = new Response(form);
    let out;
    try {
      out = await env.AI.run(IMAGE.model, { multipart: { body: body.body, contentType: body.headers.get('content-type') } });
    } catch (error) {
      console.error('image failed', error && error.message);
      if (outOfNeurons(error)) throw new ApiError(503, 'image_busy', 'Eden has made all the pictures it can today. Try again after midnight UTC.');
      throw new ApiError(502, 'ai_error', 'The picture couldn’t be made this time. Try again.');
    }
    const image = out && typeof out.image === 'string' ? out.image : '';
    if (!image) throw new ApiError(502, 'ai_error', 'The picture came back empty. Try again.');
    made = true;
    spent = worst;
    const mime = image.startsWith('iVBOR') ? 'image/png' : image.startsWith('UklGR') ? 'image/webp' : 'image/jpeg';
    return json({ image, mime, width, height, size, costUSD: worst });
  } finally {
    if (spent > 0) await call(env, who.account, 'spend', { usd: spent, bucket: hold.bucket }).catch((error) => console.error('spend failed', error && error.message));
    if (!made) await count(env, who.account, network, true).catch(() => {}); // a refused or failed picture isn't one of the day's
    await call(env, who.account, 'release-ai', { hold: hold.hold }).catch(() => {});
  }
}
