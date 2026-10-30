// Eden makes pictures and videos (askeden.com chat), routed through the Model Router's media
// tiers: Google Imagen 4 (Fast / Standard / Ultra) for new pictures, Gemini Flash Image for
// conversational edits and reference photos, Cloudflare Workers AI FLUX.2 [klein] 4B as an
// automatic fallback, and OpenAI GPT Image when only an OpenAI key is present or chosen; plus
// Google Veo 3 Fast / Veo 3 / Veo 2 for video generation and image-to-video animation.
//
// Google models use GEMINI_API_KEY on generativelanguage.googleapis.com/v1beta, so service calls
// draw from the project's GCP credits before touching any cash balance.

import { ApiError } from '../accounts/util.js';
import { metered, viaBase } from './providers.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

export const IMAGE = {
  model: 'gpt-image-2.5-sunburst', // OpenAI tier (used when only an OpenAI key is set or EDEN_IMAGE_MODEL names it)
  geminiModel: 'imagen-4.0-generate-001',
  geminiFastModel: 'imagen-4.0-fast-generate-001',
  geminiUltraModel: 'imagen-4.0-ultra-generate-001',
  geminiEditModel: 'gemini-2.5-flash-image',
  cloudflareModel: '@cf/black-forest-labs/flux-2-klein-4b',
  prices: { text: 5, imageIn: 8, out: 30 }, // OpenAI dollars per million tokens
  geminiPrices: {
    'imagen-4.0-fast-generate-001': 0.02,
    'imagen-4.0-generate-001': 0.04,
    'imagen-4.0-ultra-generate-001': 0.06,
    'gemini-2.5-flash-image': 0.039,
  },
  cloudflareUSD: 0.0014,
  holdUSD: 0.35, // the most one picture may cost
  maxPrompt: 4000,
  maxInputs: 4,
};

export const VIDEO_GEN = {
  model: 'veo-3.0-fast-generate-001',
  cinemaModel: 'veo-3.0-generate-001',
  fallbackModel: 'veo-2.0-generate-001',
  pricePerSec: {
    'veo-3.0-fast-generate-001': 0.15,
    'veo-3.0-generate-001': 0.40,
    'veo-2.0-generate-001': 0.35,
  },
  holdUSD: 2.0, // worst-case 5s Veo 3 clip
  defaultSeconds: 5,
  longSeconds: 8,
  maxPrompt: 4000,
  pollMs: 3000,
  maxWaitMs: 90_000,
};

export const IMAGE_MODELS = [
  { id: 'imagen-4.0-fast-generate-001', name: 'Imagen 4 Fast', provider: 'gemini', tier: 'fast', quality: 86, costUSD: 0.02, edit: false },
  { id: 'imagen-4.0-generate-001', name: 'Imagen 4', provider: 'gemini', tier: 'balanced', quality: 93, costUSD: 0.04, edit: false },
  { id: 'imagen-4.0-ultra-generate-001', name: 'Imagen 4 Ultra', provider: 'gemini', tier: 'frontier', quality: 97, costUSD: 0.06, edit: false },
  { id: 'gemini-2.5-flash-image', name: 'Gemini Flash Image', provider: 'gemini', tier: 'balanced', quality: 91, costUSD: 0.039, edit: true },
  { id: 'gpt-image-2.5-sunburst', name: 'GPT Image', provider: 'openai', tier: 'frontier', quality: 95, costUSD: 0.014, edit: true },
  { id: '@cf/black-forest-labs/flux-2-klein-4b', name: 'FLUX.2 klein', provider: 'cloudflare', tier: 'fast', quality: 78, costUSD: 0.0014, edit: true },
];

export const VIDEO_MODELS = [
  { id: 'veo-3.0-fast-generate-001', name: 'Veo 3 Fast', provider: 'gemini', tier: 'balanced', quality: 91, pricePerSec: 0.15 },
  { id: 'veo-3.0-generate-001', name: 'Veo 3', provider: 'gemini', tier: 'frontier', quality: 97, pricePerSec: 0.40 },
  { id: 'veo-2.0-generate-001', name: 'Veo 2', provider: 'gemini', tier: 'fast', quality: 86, pricePerSec: 0.35 },
];

const inNativeApp = (request) => Boolean(request && typeof request.headers?.get === 'function' && /\bEdenApp\//.test(request.headers.get('user-agent') || '') && !/\bEdenBeta\//.test(request.headers.get('user-agent') || ''));

export const imagesOn = (env, request = null) => {
  if (String(env.EDEN_IMAGES || '').trim().toLowerCase() !== 'on') return false;
  if (inNativeApp(request) && String(env.EDEN_IMAGES_IN_APP || '').trim().toLowerCase() !== 'on') return false;
  return true;
};

export const videosOn = (env, request = null) => {
  const v = String(env.EDEN_VIDEOS || env.EDEN_IMAGES || '').trim().toLowerCase();
  if (v !== 'on') return false;
  if (inNativeApp(request) && String(env.EDEN_IMAGES_IN_APP || '').trim().toLowerCase() !== 'on') return false;
  return true;
};

const NOUN = '(?:image|picture|pic|photo|photograph|drawing|illustration|painting|sketch|logo|icon|poster|wallpaper|banner|avatar|portrait|cartoon|render|artwork|art)';
const ASK = new RegExp(String.raw`^\s*(?:(?:hey\s+)?eden[,:]?\s+)?(?:(?:can|could|would|will)\s+you\s+|please\s+|i\s+(?:want|need|would\s+like)\s+(?:you\s+to\s+)?)?(?:(?:generate|create|make|draw|paint|design|render|produce|sketch|illustrate)\s+(?:me\s+|us\s+)?(?:a|an|some|the|\d+)?\s*(?:\w+\s+){0,3}?${NOUN}s?\b|draw\s+(?:me\s+)?(?:a|an)\s+\w+|imagine\s+(?:a|an)\s+\w+.*\b${NOUN}\b)`, 'i');

const VIDEO_NOUN = '(?:video|clip|animation|movie|film|footage|reel|short|timelapse)';
const VIDEO_ASK = new RegExp(String.raw`^\s*(?:\/video\b|(?:(?:hey\s+)?eden[,:]?\s+)?(?:(?:can|could|would|will)\s+you\s+|please\s+|i\s+(?:want|need|would\s+like)\s+(?:you\s+to\s+)?)?(?:(?:generate|create|make|render|produce|shoot|film|animate)\s+(?:me\s+|us\s+)?(?:a|an|some|the|\d+[- ]second)?\s*(?:\w+\s+){0,3}?${VIDEO_NOUN}s?\b|animate\s+(?:a|an|the|this|my)\s+\w+))`, 'i');

/** Whether a message plainly asks for a picture ("draw me a fox", "make a logo for…"); never a question about one. */
export function wantsImage(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 2000) return false;
  if (/^\s*(?:what|how|why|where|who|which|is|are|does|do|did|explain|describe|summari[sz]e|analy[sz]e|read|look at)\b/i.test(t)) return false;
  if (wantsVideo(t)) return false;
  if (/\b(?:slide\s*show|slideshow|slide\s*deck|slideset|slide\s*set|slides|presentation|power\s*point|pptx|pitch\s*deck|keynote|spreadsheet|workbook|excel|xlsx)\b/i.test(t)) return false;
  return ASK.test(t);
}

/** Whether a message plainly asks for a generated video ("make a video of…", "animate a fox…"); never a question about one. */
export function wantsVideo(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 2000) return false;
  if (/^\s*(?:what|how|why|where|who|which|is|are|does|do|did|explain|describe|summari[sz]e|analy[sz]e|watch|read|look at|transcribe)\b/i.test(t)) return false;
  return VIDEO_ASK.test(t);
}

/** A follow-up that animates the last picture ("now animate it", "make it move", "turn this into a video"). */
export const animatesLast = (text) => {
  const t = String(text || '').trim();
  return t.length <= 240 && /^(?:now\s+|ok(?:ay)?[,\s]+|please\s+)?(?:animate\s+(?:it|this|that|him|her|them|(?:this|that|the)\s+(?:image|picture|photo))|(?:make|turn)\s+(?:it|this|that|(?:this|that|the)\s+(?:image|picture|photo))\s+(?:move|into\s+a\s+(?:video|clip|animation))|bring\s+(?:it|this|that|(?:this|that|the)\s+(?:image|picture|photo))\s+to\s+life)\b/i.test(t);
};

/** A follow-up about the last picture ("make it blue", "now add a hat") rather than a new one. */
export const editsLast = (text) => {
  const t = String(text || '').trim();
  if (animatesLast(t) || wantsVideo(t)) return false;
  return t.length <= 240 && /^(?:now\s+|ok(?:ay)?[,\s]+|please\s+)?(?:make|change|turn|add|remove|put|give|replace|edit|fix|try|do)\b.*\b(?:it|this|that|him|her|them|the (?:image|picture|photo))\b|^(?:now|again|instead|more|less|same)\b/i.test(t) && !wantsImage(t.replace(/\b(?:it|this|that)\b/gi, ''));
};

/** The shape asked for, in the sizes GPT Image / Imagen draw. */
export function sizeFor(text) {
  const t = String(text || '');
  if (/\b(?:landscape|wide|widescreen|banner|header|cover|desktop wallpaper|16:9|horizontal|panorama)\b/i.test(t)) return '1536x1024';
  if (/\b(?:portrait|tall|vertical|poster|phone wallpaper|story|stories|9:16|book cover)\b/i.test(t)) return '1024x1536';
  return '1024x1024';
}

export const aspectFor = (size) => (size === '1536x1024' ? '16:9' : size === '1024x1536' ? '9:16' : '1:1');

export const qualityFor = (text) => (/\b(?:high[- ]quality|detailed|highly detailed|best quality|hd|4k|print|photorealistic|ultra)\b/i.test(String(text || '')) ? 'high' : 'medium');

export const videoAspectFor = (text) => (/\b(?:portrait|tall|vertical|phone|story|stories|9:16|reel|tiktok|shorts?)\b/i.test(String(text || '')) ? '9:16' : '16:9');
export const videoSizeFor = (text) => (videoAspectFor(text) === '9:16' ? '720x1280' : '1280x720');
export const videoDurationFor = (text) => (/\b(?:8\s*s(?:ec(?:ond)?s?)?|longer|long clip|eight[- ]second)\b/i.test(String(text || '')) ? VIDEO_GEN.longSeconds : VIDEO_GEN.defaultSeconds);
export const videoQualityFor = (text) => (/\b(?:cinematic|high[- ]quality|best quality|hd|4k|1080p|film quality|ultra)\b/i.test(String(text || '')) ? 'high' : 'standard');

/** What OpenAI's usage says a picture cost, in dollars. */
export function imageUSD(usage = {}) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const inD = usage.input_tokens_details || {};
  const textIn = inD.text_tokens !== undefined ? n(inD.text_tokens) : n(usage.input_tokens);
  const imageIn = n(inD.image_tokens);
  const usd = (textIn * IMAGE.prices.text + imageIn * IMAGE.prices.imageIn + n(usage.output_tokens) * IMAGE.prices.out) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

/** What Gemini Flash Image's usageMetadata says a picture cost, or its fixed per-image fallback. */
export function geminiImageUSD(model, usage = null) {
  if (model === 'gemini-2.5-flash-image' && usage && Number(usage.candidatesTokenCount) > 0) {
    const tin = Number(usage.promptTokenCount) || 0;
    const tout = Number(usage.candidatesTokenCount) || 0;
    return Math.round(((tin * 0.3 + tout * 30) / 1e6) * 1e6) / 1e6;
  }
  return IMAGE.geminiPrices[model] ?? 0.04;
}

export const videoUSD = (model, seconds = VIDEO_GEN.defaultSeconds) => {
  const rate = VIDEO_GEN.pricePerSec[model] ?? VIDEO_GEN.pricePerSec[VIDEO_GEN.model];
  return Math.round(rate * Number(seconds || VIDEO_GEN.defaultSeconds) * 1e6) / 1e6;
};

/** Effective optimization level 1..5 from router settings. */
export function routerLevel(settings = {}) {
  const lvl = Number(settings && settings.level);
  if (Number.isFinite(lvl) && lvl >= 1 && lvl <= 5) return Math.round(lvl);
  const eff = Number(settings && settings.efficiency);
  const perf = Number(settings && settings.performance);
  if (Number.isFinite(eff) && eff >= 65) return 2;
  if (Number.isFinite(perf) && perf >= 70) return 5;
  return 3;
}

/**
 * Model Router decision for an image turn: picks the best image model and ordered fallbacks
 * based on optimization level (1–5), edit vs new generation, quality keywords, and available keys.
 */
export function routeImage({ prompt = '', edit = false, settings = {}, override = null, envModel = '', keys = {}, hasCloudflare = false } = {}) {
  const level = routerLevel(settings);
  const quality = qualityFor(prompt);
  const hasGemini = Boolean(keys && keys.gemini);
  const hasOpenai = Boolean(keys && keys.openai);
  const forced = String((override && override.model) || envModel || '').trim();

  const available = IMAGE_MODELS.filter((m) => {
    if (edit && !m.edit) return false;
    if (m.provider === 'gemini') return hasGemini;
    if (m.provider === 'openai') return hasOpenai;
    if (m.provider === 'cloudflare') return hasCloudflare;
    return false;
  });

  let chosen = null;
  let rationale = '';

  if (forced) {
    const exact = available.find((m) => m.id === forced);
    if (exact) {
      chosen = exact;
      rationale = `Image: ${exact.name} (selected).`;
    } else if (/^gpt-image/i.test(forced) && hasOpenai) {
      chosen = { ...IMAGE_MODELS.find((m) => m.provider === 'openai'), id: forced };
      rationale = edit ? 'Image: GPT Image changes the picture.' : 'Image: GPT Image draws it.';
    } else if (/^(?:imagen-|gemini-)/i.test(forced) && hasGemini) {
      chosen = { ...(IMAGE_MODELS.find((m) => m.id === forced) || IMAGE_MODELS[1]), id: forced };
      rationale = edit ? `Image: ${chosen.name} changes the picture.` : `Image: ${chosen.name} draws it.`;
    }
  }

  if (!chosen) {
    if (hasGemini) {
      if (edit) {
        chosen = available.find((m) => m.id === IMAGE.geminiEditModel);
        rationale = 'Image edit: Gemini Flash Image modifies the starting picture while keeping its composition.';
      } else if (quality === 'high' || level >= 5) {
        chosen = available.find((m) => m.id === IMAGE.geminiUltraModel);
        rationale = quality === 'high' ? 'Image: Imagen 4 Ultra for high-detail / photorealistic rendering.' : 'Image (Level 5): Imagen 4 Ultra for highest quality.';
      } else if (level <= 2) {
        chosen = available.find((m) => m.id === IMAGE.geminiFastModel);
        rationale = `Image (Level ${level}): Imagen 4 Fast for quick, low-cost generation.`;
      } else {
        chosen = available.find((m) => m.id === IMAGE.geminiModel);
        rationale = 'Image: Imagen 4 draws the picture.';
      }
    } else if (hasOpenai) {
      chosen = available.find((m) => m.provider === 'openai');
      rationale = edit ? 'Image: GPT Image changes the picture.' : 'Image: GPT Image draws it.';
    } else if (hasCloudflare) {
      chosen = available.find((m) => m.provider === 'cloudflare');
      rationale = edit ? 'Image: FLUX.2 klein changes the picture.' : 'Image: FLUX.2 klein draws it.';
    }
  }

  if (!chosen) return null;

  // Ordered fallback chain: Gemini Flash Image -> Cloudflare FLUX.2 klein -> OpenAI GPT Image
  const fallbacks = [];
  if (chosen.provider === 'gemini' && chosen.id !== IMAGE.geminiEditModel && hasGemini) {
    const flash = IMAGE_MODELS.find((m) => m.id === IMAGE.geminiEditModel);
    if (flash) fallbacks.push(flash);
  }
  if (hasCloudflare && chosen.provider !== 'cloudflare') {
    const cf = IMAGE_MODELS.find((m) => m.provider === 'cloudflare');
    if (cf) fallbacks.push(cf);
  }
  if (hasOpenai && chosen.provider !== 'openai') {
    const oa = IMAGE_MODELS.find((m) => m.provider === 'openai');
    if (oa) fallbacks.push(oa);
  }

  const candidates = available.map((m) => ({
    model: m.id,
    name: m.name,
    provider: m.provider,
    effort: null,
    quality: m.quality,
    costUSD: m.costUSD,
    chosen: m.id === chosen.id,
  }));

  return {
    chosen,
    fallbacks,
    candidates,
    rationale,
    level,
    quality,
  };
}

/**
 * Model Router decision for a video turn: routes between Veo 3 Fast, Veo 3, and Veo 2.
 */
export function routeVideo({ prompt = '', fromImage = false, seconds = VIDEO_GEN.defaultSeconds, settings = {}, override = null, envModel = '', keys = {} } = {}) {
  if (!(keys && keys.gemini)) return null;
  const level = routerLevel(settings);
  const vQual = videoQualityFor(prompt);
  const forced = String((override && override.model) || envModel || '').trim();

  let chosen = null;
  let rationale = '';
  if (forced && /^veo-/i.test(forced)) {
    chosen = VIDEO_MODELS.find((m) => m.id === forced) || { id: forced, name: 'Veo', provider: 'gemini', tier: 'frontier', quality: 95, pricePerSec: 0.40 };
    rationale = fromImage ? `Video: ${chosen.name} animates the picture.` : `Video: ${chosen.name} generates the clip.`;
  } else if (vQual === 'high' || level >= 5) {
    chosen = VIDEO_MODELS.find((m) => m.id === VIDEO_GEN.cinemaModel);
    rationale = fromImage ? 'Video: Veo 3 animates the picture in cinema quality.' : 'Video: Veo 3 generates a high-definition clip.';
  } else {
    chosen = VIDEO_MODELS.find((m) => m.id === VIDEO_GEN.model);
    rationale = fromImage ? 'Video: Veo 3 Fast animates the picture.' : 'Video: Veo 3 Fast generates the clip.';
  }

  const fallbacks = VIDEO_MODELS.filter((m) => m.id !== chosen.id);
  const candidates = VIDEO_MODELS.map((m) => ({
    model: m.id,
    name: m.name,
    provider: m.provider,
    effort: null,
    quality: m.quality,
    costUSD: videoUSD(m.id, seconds),
    chosen: m.id === chosen.id,
  }));

  return {
    chosen,
    fallbacks,
    candidates,
    rationale,
    level,
    costUSD: videoUSD(chosen.id, seconds),
  };
}

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToB64 = (bytes) => {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) bin += String.fromCharCode(...u8.subarray(i, i + chunk));
  return btoa(bin);
};

/** Why a provider said no, in words for the person. */
function refusalWords(provider, status, out) {
  const label = provider === 'gemini' ? 'Google Gemini' : provider === 'cloudflare' ? 'Cloudflare AI' : 'OpenAI';
  const e = (out && out.error) || {};
  const code = String(e.code || e.type || e.status || '');
  const msg = String(e.message || out?.promptFeedback?.blockReason || '');
  if (/moderation|safety|content_policy|blocked|prohibited|recitation/i.test(code) || /safety|moderation|blocked|policy/i.test(msg)) {
    return `${label}’s safety rules don’t allow that. Try describing it differently.`;
  }
  if (status === 429) return `${label} is busy right now. Try again in a minute.`;
  if (status === 401 || status === 403) return `The ${label} key couldn’t be used (check Settings › Models & API keys).`;
  if (/insufficient_quota|billing/i.test(code) || /quota|billing/i.test(msg)) return `The ${label} account behind askeden.com is out of credit right now.`;
  return `${label} couldn’t finish that (${String(msg || `HTTP ${status}`).slice(0, 160)}).`;
}

const IMAGEN_TO_GEMINI_IMAGE = {
  'imagen-4.0-fast-generate-001': 'gemini-3.1-flash-lite-image',
  'imagen-4.0-generate-001': 'gemini-3.1-flash-image',
  'imagen-4.0-ultra-generate-001': 'gemini-3-pro-image',
};

/** Call Imagen 4 (:predict) for text-to-image, or Gemini 3.1/3 Image (:generateContent) when :predict is retired on v1beta. */
async function callImagen(base, apiKey, model, prompt, size, signal) {
  const url = viaBase(base, `${GEMINI_BASE}/v1beta/models/${model}:predict`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: {
        sampleCount: 1,
        aspectRatio: aspectFor(size),
        outputOptions: { mimeType: 'image/webp' },
      },
    }),
    signal,
  });
  const out = await res.json().catch(() => ({}));
  if (res.status === 404) {
    const genModel = IMAGEN_TO_GEMINI_IMAGE[model] || 'gemini-3.1-flash-image';
    const viaGen = await callGeminiFlashImage(base, apiKey, genModel, `Generate an image (${aspectFor(size)}): ${prompt}`, [], size, signal);
    if (viaGen.ok) return { ...viaGen, usd: geminiImageUSD(model) };
  }
  const pred = (out.predictions && out.predictions[0]) || (out.generatedImages && out.generatedImages[0] && out.generatedImages[0].image) || null;
  const data = pred && (pred.bytesBase64Encoded || pred.imageBytes || pred.b64_json);
  const mime = (pred && pred.mimeType) || 'image/webp';
  if (!res.ok || !data) {
    const blocked = out?.predictions?.length === 0 || /safety|blocked/i.test(JSON.stringify(out));
    return {
      ok: false,
      status: res.status,
      retryable: !blocked && (res.status === 429 || res.status >= 500 || res.status === 404),
      message: blocked ? 'Google Gemini’s safety rules don’t allow that picture. Try describing it differently.' : refusalWords('gemini', res.status, out),
    };
  }
  return {
    ok: true,
    mime: /^image\/(webp|png|jpeg)$/.test(mime) ? mime : 'image/webp',
    data,
    size,
    usd: geminiImageUSD(model),
    inputTokens: 0,
    outputTokens: 0,
  };
}

/** Call Gemini Flash Image (:generateContent) for image edits or fallback generation. */
async function callGeminiFlashImage(base, apiKey, model, prompt, inputs, size, signal) {
  const url = viaBase(base, `${GEMINI_BASE}/v1beta/models/${model}:generateContent`);
  const parts = [
    ...inputs.map((img) => ({ inlineData: { mimeType: img.mime, data: img.data } })),
    { text: prompt },
  ];
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    }),
    signal,
  });
  const out = await res.json().catch(() => ({}));
  const cand = out.candidates && out.candidates[0];
  const imgPart = cand && cand.content && Array.isArray(cand.content.parts)
    ? cand.content.parts.find((p) => p.inlineData && p.inlineData.data)
    : null;
  if (!res.ok || !imgPart) {
    const finish = cand && cand.finishReason;
    const blocked = /SAFETY|IMAGE_SAFETY|PROHIBITED_CONTENT|BLOCKLIST/i.test(String(finish || out?.promptFeedback?.blockReason || ''));
    return {
      ok: false,
      status: res.status,
      retryable: !blocked && (res.status === 429 || res.status >= 500 || res.status === 404),
      message: blocked ? 'Google Gemini’s safety rules don’t allow that picture. Try describing it differently.' : refusalWords('gemini', res.status, out),
    };
  }
  const mime = imgPart.inlineData.mimeType || 'image/png';
  const usage = out.usageMetadata || {};
  return {
    ok: true,
    mime: /^image\/(webp|png|jpeg)$/.test(mime) ? mime : 'image/png',
    data: imgPart.inlineData.data,
    size,
    usd: geminiImageUSD(model, usage),
    inputTokens: Number(usage.promptTokenCount) || 0,
    outputTokens: Number(usage.candidatesTokenCount) || 0,
  };
}

/** Call OpenAI GPT Image (/v1/images/generations or /v1/images/edits). */
async function callOpenAIImage(base, apiKey, model, prompt, inputs, size, quality, signal) {
  const common = { model, prompt, size, quality, n: 1, output_format: 'webp', output_compression: 82 };
  let response;
  if (inputs.length) {
    const form = new FormData();
    for (const [k, v] of Object.entries(common)) form.append(k, String(v));
    inputs.forEach((img, i) => form.append('image[]', new Blob([b64ToBytes(img.data)], { type: img.mime }), `input-${i + 1}.${img.mime.split('/')[1]}`));
    response = await fetch(viaBase(base, 'https://api.openai.com/v1/images/edits'), { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form, signal });
  } else {
    response = await fetch(viaBase(base, 'https://api.openai.com/v1/images/generations'), { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(common), signal });
  }
  const out = await response.json().catch(() => ({}));
  const pic = response.ok && out.data && out.data[0] && out.data[0].b64_json;
  if (!pic) {
    return {
      ok: false,
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
      message: response.ok ? 'OpenAI sent no picture back. Try again.' : refusalWords('openai', response.status, out),
    };
  }
  const usd = imageUSD(out.usage);
  return {
    ok: true,
    mime: `image/${out.output_format || 'webp'}`,
    data: pic,
    size: out.size || size,
    quality: out.quality || quality,
    usd,
    inputTokens: (out.usage && out.usage.input_tokens) || 0,
    outputTokens: (out.usage && out.usage.output_tokens) || 0,
  };
}

/** Call Cloudflare Workers AI FLUX.2 klein. */
async function callCloudflareImage(ai, model, prompt, size) {
  const [w, h] = size === '1536x1024' ? [1344, 768] : size === '1024x1536' ? [768, 1344] : [1024, 1024];
  const out = await ai.run(model, { prompt, width: w, height: h });
  const data = out && typeof out.image === 'string' ? out.image : null;
  if (!data) return { ok: false, status: 502, retryable: false, message: 'Cloudflare AI sent no picture back. Try again.' };
  const mime = data.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
  return { ok: true, mime, data, size: `${w}x${h}`, usd: IMAGE.cloudflareUSD, inputTokens: 0, outputTokens: 0 };
}

async function runImageCandidate(cand, { base, keys, ai, prompt, inputs, size, quality, signal }) {
  if (cand.provider === 'gemini') {
    const key = keys.gemini && keys.gemini.key;
    if (cand.id === IMAGE.geminiEditModel || inputs.length > 0) {
      return await callGeminiFlashImage(base, key, cand.id, prompt, inputs, size, signal);
    }
    return await callImagen(base, key, cand.id, prompt, size, signal);
  }
  if (cand.provider === 'openai') {
    return await callOpenAIImage(base, keys.openai && keys.openai.key, cand.id, prompt, inputs, size, quality, signal);
  }
  if (cand.provider === 'cloudflare' && ai) {
    return await callCloudflareImage(ai, cand.id, prompt, size);
  }
  return { ok: false, status: 503, retryable: false, message: 'No image model is available.' };
}

/**
 * The image turn: `raw` is /api/chat/send's body (its last message the request; `imageBase` Eden's last
 * picture, base64, for a follow-up). `call` is the money ops' caller (accounts/index.js or a course payer).
 */
export async function imageTurn(request, env, ctx, who, raw, { cfg, call, messageOf }) {
  const keys = (cfg && cfg.keys) || {};
  const hasCloudflare = Boolean(env && env.AI && typeof env.AI.run === 'function');
  if (!keys.gemini && !keys.openai && !hasCloudflare) {
    throw new ApiError(422, 'no_provider', 'Making pictures needs Google Gemini or OpenAI, and there’s no key on askeden.com for you yet. Add yours in Settings › Models & API keys.');
  }
  const last = messageOf(raw);
  const prompt = String(last.text || '').replace(/^\s*\/(?:image|imagine|draw)\b\s*/i, '').trim().slice(0, IMAGE.maxPrompt);
  if (!prompt) throw new ApiError(400, 'bad_request', 'Say what to draw.');
  const inputs = last.images.slice(0, IMAGE.maxInputs);
  const base = typeof raw.imageBase === 'string' && /^[A-Za-z0-9+/=]+$/.test(raw.imageBase) && raw.imageBase.length < 12_000_000 ? raw.imageBase : null;
  if (!inputs.length && base && (editsLast(prompt) || raw.image === true)) {
    if (editsLast(prompt)) inputs.push({ mime: /^image\/(png|jpeg|webp)$/.test(raw.imageBaseMime || '') ? raw.imageBaseMime : 'image/webp', data: base });
  }

  const size = sizeFor(prompt);
  const quality = qualityFor(prompt);
  const decision = routeImage({
    prompt,
    edit: inputs.length > 0,
    settings: raw.settings || {},
    override: raw.override || null,
    envModel: env.EDEN_IMAGE_MODEL || '',
    keys,
    hasCloudflare,
  });
  if (!decision) throw new ApiError(422, 'no_provider', 'No image model is available for your account right now.');

  const primary = decision.chosen;
  const own = primary.provider === 'cloudflare' ? false : !metered(keys, primary.provider);
  let hold = null;
  if (!own) {
    hold = await call(env, who.account, 'hold-ai', { eden: true, usd: IMAGE.holdUSD }, who.token);
    if (!hold.ok) throw new ApiError(402, 'no_allowance', hold.why);
  }

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

  const whereOf = (p) => (p === 'gemini' ? 'Google (United States)' : p === 'cloudflare' ? 'Cloudflare Workers AI' : 'OpenAI (United States)');

  const work = (async () => {
    const ping = setInterval(() => write(': ping\n\n'), 5000);
    const signal = request.signal ? AbortSignal.any([abort.signal, request.signal]) : abort.signal;
    try {
      write(sse('route', {
        model: primary.id,
        modelName: primary.name,
        provider: primary.provider,
        effort: null,
        effortLabel: '',
        via: 'api',
        costUSD: primary.costUSD,
        quality: primary.quality,
        confidence: null,
        rated: false,
        ratedBy: 'rules',
        ratedLabel: '',
        complexity: null,
        candidates: decision.candidates,
        fallbacks: decision.fallbacks.map((f) => ({ model: f.id, name: f.name, provider: f.provider, effort: null })),
        warnings: [],
        rationale: decision.rationale,
        notes: [`${size.replace('x', '×')}, ${quality} quality`, own ? 'on askeden.com: your own API key (not counted on your included AI)' : 'on askeden.com: your included AI'],
        where: whereOf(primary.provider),
        image: true,
        ...(own ? { ownKey: true } : {}),
      }));

      let active = primary;
      let res = await runImageCandidate(primary, { base: cfg.base, keys, ai: env.AI, prompt, inputs, size, quality, signal });
      if (!res.ok && res.retryable && decision.fallbacks.length) {
        for (const fb of decision.fallbacks) {
          const next = await runImageCandidate(fb, { base: cfg.base, keys, ai: env.AI, prompt, inputs, size, quality, signal });
          if (next.ok) {
            write(sse('fallback', { from: active.id, to: fb.id, toName: fb.name, provider: fb.provider, reason: res.message }));
            active = fb;
            res = next;
            break;
          }
        }
      }

      const usd = res.ok ? res.usd : 0;
      const activeOwn = active.provider === 'cloudflare' ? false : !metered(keys, active.provider);
      if (hold && !activeOwn && usd > 0) {
        await call(env, who.account, 'spend', { usd, bucket: hold.bucket, meta: { feature: inputs.length ? 'image-edit' : 'image', model: active.id, tin: res.inputTokens || 0, tout: res.outputTokens || 0 } })
          .catch((error) => console.error('image spend failed', error && error.message));
      }

      if (!res.ok) {
        write(sse('error', { message: res.message }));
        write(sse('done', { finish: 'error' }));
        return;
      }

      write(sse('image', { mime: res.mime, data: res.data, size: res.size || size, quality: res.quality || quality, prompt, edit: inputs.length > 0, model: active.id, modelName: active.name }));
      write(sse('usage', { inputTokens: res.inputTokens || 0, outputTokens: res.outputTokens || 0, reasoningTokens: 0, costUSD: usd, notional: false, ...(activeOwn ? { ownKey: true } : {}) }));
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

const sleep = (ms, signal) => new Promise((res) => {
  const t = setTimeout(res, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
});

/** Extract base64 MP4 or download URI from a completed Veo or Interactions API operation payload. */
async function extractVeoVideo(base, apiKey, op, signal) {
  const resp = (op && op.response) || op || {};
  const stepItems = [
    ...(Array.isArray(resp.outputs) ? resp.outputs : []),
    ...(Array.isArray(resp.steps) ? resp.steps.flatMap((s) => (s && Array.isArray(s.content) ? s.content : [])) : []),
  ];
  const stepVid = stepItems.find((c) => c && (c.type === 'video' || String(c.mime_type || c.mimeType || '').startsWith('video/')));
  const gen = resp.generateVideoResponse || resp;
  const sample = stepVid || (gen.generatedSamples && gen.generatedSamples[0]) || (gen.videos && gen.videos[0]) || (resp.predictions && resp.predictions[0]) || null;
  const video = (sample && sample.video) || sample || null;
  if (!video) return null;
  const inline = video.bytesBase64Encoded || video.videoBytes || video.data || video.b64_json;
  if (typeof inline === 'string' && inline) {
    return { data: inline, mime: video.mimeType || video.mime_type || 'video/mp4' };
  }
  const uri = video.uri || video.url;
  if (typeof uri === 'string' && /^https?:\/\//.test(uri)) {
    const dl = await fetch(viaBase(base, uri), { headers: { 'x-goog-api-key': apiKey }, signal });
    if (!dl.ok) return null;
    const buf = await dl.arrayBuffer();
    return { data: bytesToB64(new Uint8Array(buf)), mime: (dl.headers.get('content-type') || 'video/mp4').split(';')[0].trim() };
  }
  return null;
}

/** Call Gemini Interactions API (/v1beta/interactions) with gemini-omni-1.1-flash for video generation. */
async function callGeminiInteractionsVideo(base, apiKey, costModel, prompt, startImage, aspect, seconds, signal, { pollMs = VIDEO_GEN.pollMs, maxWaitMs = VIDEO_GEN.maxWaitMs } = {}) {
  const url = viaBase(base, `${GEMINI_BASE}/v1beta/interactions`);
  const promptText = /video|clip|animat|movie|film|footage/i.test(prompt)
    ? `${prompt} (${aspect} aspect ratio, ${seconds} seconds)`
    : `Generate a ${seconds}-second video (${aspect}): ${prompt}`;
  const input = startImage
    ? [
        { type: 'image', data: startImage.data, mime_type: startImage.mime },
        { type: 'text', text: promptText },
      ]
    : promptText;
  const omniModels = ['gemini-omni-1.1-flash', 'gemini-omni-flash-preview'];
  let lastErr = null;
  for (const omni of omniModels) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ model: omni, input }),
      signal,
    });
    let op = await res.json().catch(() => ({}));
    if (!res.ok) {
      const blocked = /safety|blocked|policy/i.test(JSON.stringify(op));
      lastErr = {
        ok: false,
        status: res.status,
        retryable: !blocked && (res.status === 429 || res.status >= 500 || res.status === 404),
        message: refusalWords('gemini', res.status, op),
      };
      if (blocked || res.status === 404) continue;
      return lastErr;
    }
    const deadline = Date.now() + maxWaitMs;
    while (op.id && op.status && !['completed', 'failed', 'cancelled'].includes(op.status) && Date.now() < deadline && !signal.aborted) {
      await sleep(pollMs, signal);
      if (signal.aborted) break;
      const pollRes = await fetch(viaBase(base, `${GEMINI_BASE}/v1beta/interactions/${encodeURIComponent(op.id)}`), {
        headers: { 'x-goog-api-key': apiKey },
        signal,
      });
      if (!pollRes.ok) break;
      op = await pollRes.json().catch(() => ({}));
    }
    const clip = await extractVeoVideo(base, apiKey, op, signal);
    if (clip && clip.data) {
      return { ok: true, mime: clip.mime || 'video/mp4', data: clip.data, usd: videoUSD(costModel, seconds) };
    }
    lastErr = { ok: false, status: 502, retryable: true, message: 'Google Gemini sent no video back. Try again.' };
  }
  return lastErr || { ok: false, status: 502, retryable: true, message: 'Google Gemini sent no video back. Try again.' };
}

/** Call Google Veo (:predictLongRunning, or /v1beta/interactions when Veo redirects to Gemini Omni) and poll until the MP4 is ready. */
async function callVeoVideo(base, apiKey, model, prompt, startImage, aspect, seconds, signal, { pollMs = VIDEO_GEN.pollMs, maxWaitMs = VIDEO_GEN.maxWaitMs } = {}) {
  const url = viaBase(base, `${GEMINI_BASE}/v1beta/models/${model}:predictLongRunning`);
  const instance = {
    prompt,
    ...(startImage ? { image: { bytesBase64Encoded: startImage.data, mimeType: startImage.mime } } : {}),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      instances: [instance],
      parameters: { aspectRatio: aspect, durationSeconds: seconds, sampleCount: 1 },
    }),
    signal,
  });
  let op = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 404) {
      const viaOmni = await callGeminiInteractionsVideo(base, apiKey, model, prompt, startImage, aspect, seconds, signal, { pollMs, maxWaitMs });
      if (viaOmni.ok) return viaOmni;
    }
    const blocked = /safety|blocked|policy/i.test(JSON.stringify(op));
    return {
      ok: false,
      status: res.status,
      retryable: !blocked && (res.status === 429 || res.status >= 500 || res.status === 404),
      message: refusalWords('gemini', res.status, op),
    };
  }

  const deadline = Date.now() + maxWaitMs;
  while (!op.done && op.name && Date.now() < deadline && !signal.aborted) {
    await sleep(pollMs, signal);
    if (signal.aborted) break;
    const pollUrl = viaBase(base, `${GEMINI_BASE}/v1beta/${String(op.name).replace(/^\/+/, '')}`);
    const pollRes = await fetch(pollUrl, { headers: { 'x-goog-api-key': apiKey }, signal });
    if (!pollRes.ok) {
      const errOut = await pollRes.json().catch(() => ({}));
      return { ok: false, status: pollRes.status, retryable: pollRes.status >= 500, message: refusalWords('gemini', pollRes.status, errOut) };
    }
    op = await pollRes.json().catch(() => ({}));
  }

  if (op.error) {
    return { ok: false, status: 400, retryable: false, message: refusalWords('gemini', 400, { error: op.error }) };
  }

  const clip = await extractVeoVideo(base, apiKey, op, signal);
  if (!clip || !clip.data) {
    const rai = op?.response?.generateVideoResponse?.raiMediaFilteredReasons;
    if (Array.isArray(rai) && rai.length) {
      return { ok: false, status: 400, retryable: false, message: 'Google Gemini’s safety rules don’t allow that video. Try describing it differently.' };
    }
    return { ok: false, status: 502, retryable: true, message: 'Google Gemini sent no video back. Try again.' };
  }

  return { ok: true, mime: clip.mime || 'video/mp4', data: clip.data, usd: videoUSD(model, seconds) };
}

/**
 * The video turn: generates an MP4 clip (or animates a picture) with Google Veo on GCP credits.
 */
export async function videoTurn(request, env, ctx, who, raw, { cfg, call, messageOf }) {
  const keys = (cfg && cfg.keys) || {};
  if (!keys.gemini) {
    throw new ApiError(422, 'no_provider', 'Making videos needs Google Gemini, and there’s no Gemini key on askeden.com for you yet. Add yours in Settings › Models & API keys.');
  }
  const last = messageOf(raw);
  const prompt = String(last.text || '').replace(/^\s*\/video\b\s*/i, '').trim().slice(0, VIDEO_GEN.maxPrompt);
  if (!prompt) throw new ApiError(400, 'bad_request', 'Say what the video should show.');
  const inputs = last.images.slice(0, 1);
  const base = typeof raw.imageBase === 'string' && /^[A-Za-z0-9+/=]+$/.test(raw.imageBase) && raw.imageBase.length < 12_000_000 ? raw.imageBase : null;
  if (!inputs.length && base && (animatesLast(prompt) || raw.video === true)) {
    inputs.push({ mime: /^image\/(png|jpeg|webp)$/.test(raw.imageBaseMime || '') ? raw.imageBaseMime : 'image/webp', data: base });
  }
  const startImage = inputs[0] || null;
  const aspect = videoAspectFor(prompt);
  const size = videoSizeFor(prompt);
  const seconds = videoDurationFor(prompt);

  const decision = routeVideo({
    prompt,
    fromImage: Boolean(startImage),
    seconds,
    settings: raw.settings || {},
    override: raw.override || null,
    envModel: env.EDEN_VIDEO_MODEL || '',
    keys,
  });
  if (!decision) throw new ApiError(422, 'no_provider', 'No video model is available for your account right now.');

  const primary = decision.chosen;
  const own = !metered(keys, 'gemini');
  let hold = null;
  if (!own) {
    const holdAmt = Math.max(decision.costUSD, VIDEO_GEN.holdUSD);
    hold = await call(env, who.account, 'hold-ai', { eden: true, usd: holdAmt }, who.token);
    if (!hold.ok) throw new ApiError(402, 'no_allowance', hold.why);
  }

  const pollMs = Number(env.EDEN_VIDEO_POLL_MS) > 0 ? Number(env.EDEN_VIDEO_POLL_MS) : VIDEO_GEN.pollMs;
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
        model: primary.id,
        modelName: primary.name,
        provider: 'gemini',
        effort: null,
        effortLabel: '',
        via: 'api',
        costUSD: decision.costUSD,
        quality: primary.quality,
        confidence: null,
        rated: false,
        ratedBy: 'rules',
        ratedLabel: '',
        complexity: null,
        candidates: decision.candidates,
        fallbacks: decision.fallbacks.map((f) => ({ model: f.id, name: f.name, provider: f.provider, effort: null })),
        warnings: [],
        rationale: decision.rationale,
        notes: [`${size.replace('x', '×')}, ${seconds}s clip`, own ? 'on askeden.com: your own API key (not counted on your included AI)' : 'on askeden.com: your included AI'],
        where: 'Google (United States)',
        video: true,
        ...(own ? { ownKey: true } : {}),
      }));

      let active = primary;
      let res = await callVeoVideo(cfg.base, keys.gemini.key, primary.id, prompt, startImage, aspect, seconds, signal, { pollMs });
      if (!res.ok && res.retryable && decision.fallbacks.length) {
        for (const fb of decision.fallbacks) {
          const next = await callVeoVideo(cfg.base, keys.gemini.key, fb.id, prompt, startImage, aspect, seconds, signal, { pollMs });
          if (next.ok) {
            write(sse('fallback', { from: active.id, to: fb.id, toName: fb.name, provider: fb.provider, reason: res.message }));
            active = fb;
            res = next;
            break;
          }
        }
      }

      const usd = res.ok ? res.usd : 0;
      if (hold && usd > 0) {
        await call(env, who.account, 'spend', { usd, bucket: hold.bucket, meta: { feature: startImage ? 'video-animate' : 'video', model: active.id, seconds } })
          .catch((error) => console.error('video spend failed', error && error.message));
      }

      if (!res.ok) {
        write(sse('error', { message: res.message }));
        write(sse('done', { finish: 'error' }));
        return;
      }

      write(sse('video', { mime: res.mime, data: res.data, size, seconds, prompt, fromImage: Boolean(startImage), model: active.id, modelName: active.name }));
      write(sse('usage', { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUSD: usd, notional: false, ...(own ? { ownKey: true } : {}) }));
      write(sse('done', { finish: 'stop' }));
    } catch (error) {
      if (!abort.signal.aborted) {
        console.error('video turn failed', error && error.message);
        write(sse('error', { message: 'Making the video failed. Try again.' }));
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
