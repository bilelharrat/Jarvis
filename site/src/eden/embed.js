// Text embeddings for Eden Mail on askeden.com (askeden src/chat/embed.ts is the Mac's): the
// owner's past emails matched to the one being written by meaning. Gemini (gemini-embedding-001)
// first, else OpenAI (text-embedding-3-small), 256 dimensions. The owner's own key first
// (providers.js providerKey); on the service's key it counts on the included AI, at cost.
//
//   POST /api/chat/embed  { texts: string[] }  → { vectors, provider, model }

import { ApiError } from '../accounts/util.js';

export const EMBED_DIMS = 256;
export const MAX_EMBED_TEXTS = 100;
export const MAX_EMBED_CHARS = 2000;
export const EMBED_MODELS = { gemini: 'gemini-embedding-001', openai: 'text-embedding-3-small' };
export const EMBED_USD_PER_MTOK = { gemini: 0.15, openai: 0.02 }; // published prices, per million input tokens
const CHARS_PER_TOKEN = 3;
const EMBED_CACHE_MAX = 500;
const embedCache = new Map();

function cacheGet(scope, provider, text) {
  const k = `${scope}:${provider}:${text}`;
  const v = embedCache.get(k);
  if (v) {
    embedCache.delete(k);
    embedCache.set(k, v);
  }
  return v;
}

function cacheSet(scope, provider, text, vec) {
  const k = `${scope}:${provider}:${text}`;
  embedCache.set(k, vec);
  if (embedCache.size > EMBED_CACHE_MAX) embedCache.delete(embedCache.keys().next().value);
}

/** Clear the in-memory embedding cache (for tests). */
export const clearEmbedCache = () => embedCache.clear();

export function checkTexts(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_EMBED_TEXTS || !raw.every((t) => typeof t === 'string')) {
    throw new ApiError(400, 'bad_request', `texts must be 1 to ${MAX_EMBED_TEXTS} strings.`);
  }
  return raw.map((t) => t.slice(0, MAX_EMBED_CHARS) || ' ');
}

/** What embedding `texts` costs, in dollars (an estimate from their length; cached texts in `scope` are free). */
export const embedUSD = (provider, texts, { scope = '' } = {}) => {
  const billable = scope ? texts.filter((t) => !embedCache.has(`${scope}:${provider}:${t}`)) : texts;
  return (billable.reduce((n, t) => n + t.length, 0) / CHARS_PER_TOKEN / 1e6) * EMBED_USD_PER_MTOK[provider];
};

const round = (v) => v.map((x) => Math.round(x * 1e4) / 1e4);

export async function embedTexts(provider, key, texts, f = fetch, { scope = '' } = {}) {
  if (scope) {
    const out = new Array(texts.length);
    const missing = [];
    const missingIdx = [];
    for (let i = 0; i < texts.length; i++) {
      const hit = cacheGet(scope, provider, texts[i]);
      if (hit) out[i] = hit;
      else {
        missing.push(texts[i]);
        missingIdx.push(i);
      }
    }
    if (!missing.length) return out;
    const fetched = await fetchEmbeddings(provider, key, missing, f);
    for (let j = 0; j < missing.length; j++) {
      cacheSet(scope, provider, missing[j], fetched[j]);
      out[missingIdx[j]] = fetched[j];
    }
    return out;
  }
  return fetchEmbeddings(provider, key, texts, f);
}

async function fetchEmbeddings(provider, key, texts, f = fetch) {
  const signal = AbortSignal.timeout ? AbortSignal.timeout(30_000) : undefined;
  if (provider === 'gemini') {
    const model = EMBED_MODELS.gemini;
    const res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ requests: texts.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] }, taskType: 'SEMANTIC_SIMILARITY', outputDimensionality: EMBED_DIMS })) }),
    });
    if (!res.ok) throw new ApiError(502, 'upstream', `Gemini embeddings answered ${res.status}.`);
    const list = (await res.json()).embeddings || [];
    if (list.length !== texts.length || !list.every((e) => Array.isArray(e.values))) throw new ApiError(502, 'upstream', 'Gemini sent embeddings Eden can’t read.');
    return list.map((e) => round(e.values));
  }
  const res = await f('https://api.openai.com/v1/embeddings', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: EMBED_MODELS.openai, input: texts, dimensions: EMBED_DIMS }),
  });
  if (!res.ok) throw new ApiError(502, 'upstream', `OpenAI embeddings answered ${res.status}.`);
  const data = (await res.json()).data || [];
  if (data.length !== texts.length || !data.every((d) => Array.isArray(d.embedding))) throw new ApiError(502, 'upstream', 'OpenAI sent embeddings Eden can’t read.');
  return data.sort((a, b) => a.index - b.index).map((d) => round(d.embedding));
}
