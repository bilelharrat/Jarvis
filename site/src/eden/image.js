// Eden makes pictures (askeden.com chat): OpenAI's GPT Image, for the composer's Image mode
// (`image: true`) or a message that plainly asks for one ("draw me…", "make an image of…").
// Off unless EDEN_IMAGES = "on" (wrangler.toml), and only with an OpenAI key (the service's or the
// asker's own: providers.js providerKey).
//
// One call, no streaming: POST /v1/images/generations, or /v1/images/edits when the turn carries a
// picture to work from (one the person attached, or Eden's last one for "now make it blue"). The
// stream is: route, image { mime, data (base64), size, prompt, edit }, usage, done; pings while it
// draws. The picture is never kept here: the page keeps it (web/chat image-store.js).
//
// Money: the included AI holds IMAGE.holdUSD for the call, then spends what OpenAI's usage says it
// cost (IMAGE.prices, per million tokens). Measured 2026-10-14: a 1024² medium picture is ~450
// output tokens, about 1.4¢; high quality several times that.

import { ApiError } from '../accounts/util.js';
import { metered, viaBase } from './providers.js';

export const IMAGE = {
  model: 'gpt-image-2.5-sunburst', // OpenAI's precision tier; gpt-image-2.5-flare is the same price and quicker (EDEN_IMAGE_MODEL)
  prices: { text: 5, imageIn: 8, out: 30 }, // dollars per million tokens (OpenAI, Sept 2026; both 2.5 models)
  holdUSD: 0.35, // the most one picture may cost (high quality, a big edit)
  maxPrompt: 4000,
  maxInputs: 4, // pictures to work from, at most
};

export const imagesOn = (env) => String(env.EDEN_IMAGES || '').trim().toLowerCase() === 'on';

const NOUN = '(?:image|picture|pic|photo|photograph|drawing|illustration|painting|sketch|logo|icon|poster|wallpaper|banner|avatar|portrait|cartoon|render|artwork|art)';
const ASK = new RegExp(String.raw`^\s*(?:(?:hey\s+)?eden[,:]?\s+)?(?:(?:can|could|would|will)\s+you\s+|please\s+|i\s+(?:want|need|would\s+like)\s+(?:you\s+to\s+)?)?(?:(?:generate|create|make|draw|paint|design|render|produce|sketch|illustrate)\s+(?:me\s+|us\s+)?(?:a|an|some|the|\d+)?\s*(?:\w+\s+){0,3}?${NOUN}s?\b|draw\s+(?:me\s+)?(?:a|an)\s+\w+|imagine\s+(?:a|an)\s+\w+.*\b${NOUN}\b)`, 'i');

/** Whether a message plainly asks for a picture ("draw me a fox", "make a logo for…"); never a question about one. */
export function wantsImage(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 2000) return false;
  if (/^\s*(?:what|how|why|where|who|which|is|are|does|do|did|explain|describe|summari[sz]e|analy[sz]e|read|look at)\b/i.test(t)) return false;
  return ASK.test(t);
}

/** A follow-up about the last picture ("make it blue", "now add a hat") rather than a new one. */
export const editsLast = (text) => {
  const t = String(text || '').trim();
  return t.length <= 240 && /^(?:now\s+|ok(?:ay)?[,\s]+|please\s+)?(?:make|change|turn|add|remove|put|give|replace|edit|fix|try|do)\b.*\b(?:it|this|that|him|her|them|the (?:image|picture|photo))\b|^(?:now|again|instead|more|less|same)\b/i.test(t) && !wantsImage(t.replace(/\b(?:it|this|that)\b/gi, ''));
};

/** The shape asked for, in the sizes GPT Image draws. */
export function sizeFor(text) {
  const t = String(text || '');
  if (/\b(?:landscape|wide|widescreen|banner|header|cover|desktop wallpaper|16:9|horizontal|panorama)\b/i.test(t)) return '1536x1024';
  if (/\b(?:portrait|tall|vertical|poster|phone wallpaper|story|stories|9:16|book cover)\b/i.test(t)) return '1024x1536';
  return '1024x1024';
}

export const qualityFor = (text) => (/\b(?:high[- ]quality|detailed|highly detailed|best quality|hd|4k|print|photorealistic|ultra)\b/i.test(String(text || '')) ? 'high' : 'medium');

/** What OpenAI's usage says a picture cost, in dollars. */
export function imageUSD(usage = {}) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const inD = usage.input_tokens_details || {};
  const textIn = inD.text_tokens !== undefined ? n(inD.text_tokens) : n(usage.input_tokens);
  const imageIn = n(inD.image_tokens);
  const usd = (textIn * IMAGE.prices.text + imageIn * IMAGE.prices.imageIn + n(usage.output_tokens) * IMAGE.prices.out) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Why OpenAI said no, in words for the person. */
function refusalWords(status, out) {
  const e = (out && out.error) || {};
  const code = String(e.code || e.type || '');
  if (/moderation|safety|content_policy/i.test(code) || /safety system|moderation/i.test(String(e.message || ''))) {
    return 'OpenAI’s safety rules don’t allow that picture. Try describing it differently.';
  }
  if (status === 429) return 'OpenAI is busy right now. Try again in a minute.';
  if (status === 401 || status === 403) return 'The OpenAI key can’t make pictures (check Settings › Models & API keys).';
  if (/insufficient_quota|billing/i.test(code)) return 'The OpenAI account behind askeden.com is out of credit, so Eden can’t make pictures right now.';
  return `OpenAI couldn’t make the picture (${String(e.message || `HTTP ${status}`).slice(0, 160)}).`;
}

/**
 * The turn: `raw` is /api/chat/send's body (its last message the request; `imageBase` Eden's last
 * picture, base64, for a follow-up). `call` is the money ops' caller (accounts/index.js or a course payer).
 */
export async function imageTurn(request, env, ctx, who, raw, { cfg, call, messageOf }) {
  const key = cfg.keys && cfg.keys.openai;
  if (!key) throw new ApiError(422, 'no_provider', 'Making pictures needs OpenAI, and there’s no OpenAI key on askeden.com for you yet. Add yours in Settings › Models & API keys.');
  const last = messageOf(raw);
  const prompt = String(last.text || '').replace(/^\s*\/(?:image|imagine|draw)\b\s*/i, '').trim().slice(0, IMAGE.maxPrompt);
  if (!prompt) throw new ApiError(400, 'bad_request', 'Say what to draw.');
  const inputs = last.images.slice(0, IMAGE.maxInputs);
  const base = typeof raw.imageBase === 'string' && /^[A-Za-z0-9+/=]+$/.test(raw.imageBase) && raw.imageBase.length < 12_000_000 ? raw.imageBase : null;
  if (!inputs.length && base && editsLast(prompt)) inputs.push({ mime: /^image\/(png|jpeg|webp)$/.test(raw.imageBaseMime || '') ? raw.imageBaseMime : 'image/webp', data: base });
  const own = !metered(cfg.keys, 'openai');
  let hold = null;
  if (!own) {
    hold = await call(env, who.account, 'hold-ai', { eden: true, usd: IMAGE.holdUSD }, who.token);
    if (!hold.ok) throw new ApiError(402, 'no_allowance', hold.why);
  }
  const model = String(env.EDEN_IMAGE_MODEL || '').trim() || IMAGE.model;
  const size = sizeFor(prompt);
  const quality = qualityFor(prompt);
  const encoder = new TextEncoder();
  const abort = new AbortController();
  let controller;
  let open = true;
  const write = (chunk) => {
    if (!open) return;
    try { controller.enqueue(encoder.encode(chunk)); } catch { open = false; }
  };
  const stream = new ReadableStream({
    start(c) { controller = c; },
    cancel() { open = false; abort.abort(); },
  });
  const work = (async () => {
    const ping = setInterval(() => write(': ping\n\n'), 5000);
    const signal = request.signal ? AbortSignal.any([abort.signal, request.signal]) : abort.signal;
    try {
      write(sse('route', {
        model, modelName: 'GPT Image', provider: 'openai', effort: null, effortLabel: '', via: 'api', costUSD: null, quality: null, confidence: null, rated: false, ratedBy: 'rules', ratedLabel: '', complexity: null, candidates: [], fallbacks: [], warnings: [],
        rationale: inputs.length ? 'Image: GPT Image changes the picture.' : 'Image: GPT Image draws it.',
        notes: [`${size.replace('x', '×')}, ${quality} quality`, own ? 'on askeden.com: your own API key (not counted on your included AI)' : 'on askeden.com: your included AI'],
        where: 'OpenAI (United States)', image: true, ...(own ? { ownKey: true } : {}),
      }));
      const common = { model, prompt, size, quality, n: 1, output_format: 'webp', output_compression: 82 };
      let response;
      if (inputs.length) {
        const form = new FormData();
        for (const [k, v] of Object.entries(common)) form.append(k, String(v));
        inputs.forEach((img, i) => form.append('image[]', new Blob([b64ToBytes(img.data)], { type: img.mime }), `input-${i + 1}.${img.mime.split('/')[1]}`));
        response = await fetch(viaBase(cfg.base, 'https://api.openai.com/v1/images/edits'), { method: 'POST', headers: { authorization: `Bearer ${key.key}` }, body: form, signal });
      } else {
        response = await fetch(viaBase(cfg.base, 'https://api.openai.com/v1/images/generations'), { method: 'POST', headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' }, body: JSON.stringify(common), signal });
      }
      const out = await response.json().catch(() => ({}));
      const usd = response.ok ? imageUSD(out.usage) : 0;
      if (hold && usd > 0) {
        await call(env, who.account, 'spend', { usd, bucket: hold.bucket, meta: { feature: inputs.length ? 'image-edit' : 'image', model, tin: (out.usage && out.usage.input_tokens) || 0, tout: (out.usage && out.usage.output_tokens) || 0 } })
          .catch((error) => console.error('image spend failed', error && error.message));
      }
      const pic = response.ok && out.data && out.data[0] && out.data[0].b64_json;
      if (!pic) {
        write(sse('error', { message: response.ok ? 'OpenAI sent no picture back. Try again.' : refusalWords(response.status, out) }));
        write(sse('done', { finish: 'error' }));
        return;
      }
      write(sse('image', { mime: `image/${out.output_format || 'webp'}`, data: pic, size: out.size || size, quality: out.quality || quality, prompt, edit: inputs.length > 0 }));
      write(sse('usage', { inputTokens: (out.usage && out.usage.input_tokens) || 0, outputTokens: (out.usage && out.usage.output_tokens) || 0, reasoningTokens: 0, costUSD: usd, notional: false, ...(own ? { ownKey: true } : {}) }));
      write(sse('done', { finish: 'stop' }));
    } catch (error) {
      if (!abort.signal.aborted) {
        console.error('image turn failed', error && error.message);
        write(sse('error', { message: 'Making the picture failed. Try again.' }));
        write(sse('done', { finish: 'error' }));
      }
    } finally {
      clearInterval(ping);
      if (hold) await call(env, who.account, 'release-ai', { hold: hold.hold }, who.token).catch(() => {});
      if (open) {
        open = false;
        try { controller.close(); } catch {}
      }
    }
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(work);
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no' } });
}
