// Hosted Eden's providers: Anthropic, OpenAI, Google Gemini and Moonshot Kimi on askeden.com, with
// the Mac's own stream code (askeden src/chat/stream.ts, bundled as vendor/providers.js by
// scripts/sync-eden.mjs) and the router registry's list prices.
//
// ── The one key lookup (stable; BYOK extends it) ──
//
//   providerKey(env, who, provider) → Promise<{ key, source: 'user' | 'service' } | null>
//
// Every provider key used by hosted chat comes from here. Today: the Worker secret
// (OPENAI_API_KEY, GEMINI_API_KEY, MOONSHOT_API_KEY), source 'service', unless the provider is
// switched off (EDEN_ANTHROPIC / EDEN_OPENAI / EDEN_GEMINI / EDEN_KIMI = "off"). Claude is
// bring-your-own-key only (BYOK_ONLY): ANTHROPIC_API_KEY is never used for hosted chat, so Claude
// runs only on the asker's own Anthropic key, or for the owner through their Mac (via-mac.js);
// elsewhere its models are listed as locked (CLAUDE_NEEDS_KEY, hostedFor's `locked`).
// Bring-your-own-key: the account owner's own key comes first (source 'user', user-keys.js). The candidate set and
// /api/chat/meta are computed per asker from it (hostedFor), and a 'user' key's calls are metered
// for display only: never held or spent on the included AI (metered()).
//
// Billing (docs/accounts.md "Hosted Eden's providers"): every call costs the model's registry list
// price (input; output and reasoning at the output rate; the long-context rate past its threshold)
// plus web search: Claude's server tool $0.01 a search; Gemini grounding $0.014 a query (Gemini 3)
// or $0.035 a grounded answer (Gemini 2.5). A stopped stream counts what the provider reported, and
// where it hadn't reported yet: the input as estimated (a token per 3 bytes, images 1,600), the
// output as a token per 3 streamed characters (text and thinking), and for OpenAI's hidden
// reasoning 100 tokens a second until the first text (capped by the request's output cap).

import { ApiError } from '../accounts/util.js';
import { userKeyFor } from '../accounts/user-keys.js';
import { withVideoParts } from './video.js';
import { MODELS, createLocalRouter } from './vendor/model-router.js';
import { PROVIDER_NAMES, buildStreamRequest, computedWhere, createStreamParser, hasVision, readSse, redact, requestMaxOutputTokens, usageCost, withMaxOutputTokens } from './vendor/providers.js';

export { PROVIDER_NAMES, computedWhere, hasVision };

export const PROVIDER_IDS = ['anthropic', 'openai', 'gemini', 'kimi', 'meta', 'mistral', 'deepseek'];
export const KEY_VARS = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', kimi: 'MOONSHOT_API_KEY', meta: 'META_API_KEY', mistral: 'MISTRAL_API_KEY', deepseek: 'DEEPSEEK_API_KEY' };
export const FALLBACK_KEY_VARS = { anthropic: 'ANTHROPIC_FALLBACK_KEYS', openai: 'OPENAI_FALLBACK_KEYS', gemini: 'GEMINI_FALLBACK_KEYS', kimi: 'MOONSHOT_FALLBACK_KEYS' };
export const DEFAULT_VERTEX_PROJECT = 'gen-lang-client-0068133515'; // GCP project "Jarvis" (billing account 014189-2B1010-766487)
export const DEFAULT_VERTEX_LOCATION = 'global';
export const SWITCH_VARS = { anthropic: 'EDEN_ANTHROPIC', openai: 'EDEN_OPENAI', gemini: 'EDEN_GEMINI', kimi: 'EDEN_KIMI', meta: 'EDEN_META', mistral: 'EDEN_MISTRAL', deepseek: 'EDEN_DEEPSEEK' };
/**
 * Providers used only when the person picks one of their models by name: never by automatic routing, the checks, a
 * compare summary or the default model. DeepSeek processes and stores data in China (its privacy policy, 2026-02-10).
 */
export const OPT_IN_PROVIDERS = ['deepseek'];
/** Added 2026-10-14, switched on after the iPhone app's App Review: shown and keyed only when on the site's model list. */
export const LATER_PROVIDERS = ['meta', 'mistral', 'deepseek'];
/** The models Eden may choose by itself (routing, checks, summaries, the default): everything but the opt-in providers'. */
export const autoModels = (models) => models.filter((m) => !OPT_IN_PROVIDERS.includes(m.provider));

export const CLAUDE_SEARCH_USD = 0.01;
export const OPENAI_SEARCH_USD = 0.01; // OpenAI web_search tool call (published price: $10 per 1,000 calls; the pages it reads are billed as input tokens)
export const GEMINI_QUERY_USD = 0.014; // Gemini 3.x grounding, per search query
export const GEMINI_GROUNDED_USD = 0.035; // Gemini 2.5 grounding, per grounded answer
export const CHARS_PER_TOKEN = 3;
export const HIDDEN_REASONING_TPS = 100;

/** Providers hosted Eden never runs on a service key: only the asker's own (or the owner's Mac). */
export const BYOK_ONLY = ['anthropic'];
export const CLAUDE_NEEDS_KEY = 'Add your Anthropic API key in Settings to use Claude';
/** Where the page links a locked model's words: Settings › Models & API keys. */
export const KEYS_SETTINGS = '/#settings=keys';
/** The model a new account starts on when it picks one: cheap, good, and on the service keys. */
export const DEFAULT_MODEL = 'gemini-3.8-flash';

// Tests only (test/fakes.js): the suites written for Claude on a Worker key keep running it. Never
// set from config or a request: nothing deployed can turn it on.
let serviceClaudeForTests = false;
export const testOnlyServiceClaude = (on) => {
  serviceClaudeForTests = Boolean(on);
};

const switchedOff = (env, p) => /^(off|0|false|no)$/i.test(String(env[SWITCH_VARS[p]] ?? '').trim());

export function vertexCredentialKey(env) {
  if (!env || /^(off|0|false|no)$/i.test(String(env.EDEN_VERTEX ?? '').trim())) return '';
  const cred = String(env.VERTEX_CREDENTIALS || env.VERTEX_ACCESS_TOKEN || '').trim();
  if (!cred) return '';
  const project = String(env.VERTEX_PROJECT || DEFAULT_VERTEX_PROJECT).trim() || DEFAULT_VERTEX_PROJECT;
  const location = String(env.VERTEX_LOCATION || DEFAULT_VERTEX_LOCATION).trim() || DEFAULT_VERTEX_LOCATION;
  return `vertex://${project}/${location}#${cred}`;
}

export const isVertexKey = (k) => typeof k === 'string' && k.startsWith('vertex://');

export function serviceKeyList(env, provider) {
  const seen = new Set(['']);
  const out = [];
  const vKey = provider === 'gemini' ? vertexCredentialKey(env) : '';
  const vertexFirst = !/^(off|0|false|no)$/i.test(String((env && env.VERTEX_FIRST) ?? 'on').trim());
  if (vKey && vertexFirst) {
    seen.add(vKey);
    out.push(vKey);
  }
  for (const raw of [env[KEY_VARS[provider]], env[FALLBACK_KEY_VARS[provider]]]) {
    for (const part of String(raw || '').split(',')) {
      const k = part.trim();
      if (k && !seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
  }
  if (vKey && !seen.has(vKey)) out.push(vKey);
  return out;
}

/** Claude for everyone on the included AI: an ANTHROPIC_API_KEY is set (and ANTHROPIC not switched off). Without it, Claude stays bring-your-own-key. */
export const serviceClaude = (env) => serviceKeyList(env, 'anthropic').length > 0 && !switchedOff(env, 'anthropic');

/** The key a provider's calls use for this asker, and whose it is; null: none. Stable contract (top of file). */
export async function providerKey(env, who, provider) {
  if (!PROVIDER_IDS.includes(provider) || switchedOff(env, provider)) return null;
  const own = await userKeyFor(env, who, provider); // the owner's own key first (accounts/user-keys.js)
  if (own) return own;
  if (BYOK_ONLY.includes(provider) && !serviceClaudeForTests && !serviceClaude(env)) return null; // Claude: own key only, unless the service has an Anthropic key (serviceClaude)
  const list = serviceKeyList(env, provider);
  if (!list.length) return null;
  const [key, ...fallbackKeys] = list;
  return { key, source: 'service', ...(fallbackKeys.length ? { fallbackKeys } : {}) };
}

/** Whether a provider's calls count on the included AI (the service's key), as opposed to the asker's own. */
export const metered = (keys, provider) => Boolean(keys[provider] && keys[provider].source === 'service');

/**
 * The hosted settings for this asker: the models narrowed to the providers they have a key for,
 * plus `keys` (each provider's providerKey), `locked` (the BYOK-only models they have no key for:
 * listed, disabled, with CLAUDE_NEEDS_KEY) and `base` (devProviderBase, dev and tests only).
 */
export async function hostedFor(env, who, cfg, request = null) {
  const keys = {};
  for (const p of PROVIDER_IDS) keys[p] = await providerKey(env, who, p);
  const locked = cfg.models.filter((m) => !keys[m.provider] && BYOK_ONLY.includes(m.provider) && !switchedOff(env, m.provider) && !serviceClaudeForTests && !serviceClaude(env));
  return { ...cfg, models: cfg.models.filter((m) => keys[m.provider]), locked, keys, base: devProviderBase(env, request) };
}

/** The model a new account starts on: DEFAULT_MODEL when the asker has it, else the cheapest non-Claude one; null: none. */
export function defaultModel(cfg) {
  const pool = autoModels(cfg.models).filter((m) => !BYOK_ONLY.includes(m.provider));
  if (pool.some((m) => m.id === DEFAULT_MODEL)) return DEFAULT_MODEL;
  const out = (m) => ratesOf(m)[1];
  return pool.length ? [...pool].sort((a, b) => out(a) - out(b))[0].id : null;
}

const hasImages = (messages) => messages.some((m) => (m.attachments || []).some((a) => a.kind === 'image'));

/**
 * The models one turn may use (a 422 when none): the providers the page has on, the search
 * provider for a search turn, vision models when the conversation has images; a pick of the
 * page's own must be among them.
 */
export function narrowFor(cfg, { settings = {}, mode = 'chat', messages = [], override = null }) {
  const refuse = (message) => {
    throw new ApiError(422, 'no_provider', message);
  };
  let models = cfg.models;
  if (Array.isArray(settings.providers)) {
    models = models.filter((m) => settings.providers.includes(m.provider));
    if (!models.length) refuse(`Pick at least one provider askeden.com has (here: ${[...new Set(cfg.models.map((m) => PROVIDER_NAMES[m.provider]))].join(', ') || 'none'}).`);
  }
  if (mode !== 'chat') {
    // any model that can search (Gemini grounding, GPT's web_search, Claude's search tool) may answer; Gemini first, so a tie goes to it
    models = models.filter(canSearch).sort((a, b) => Number(b.provider === 'gemini') - Number(a.provider === 'gemini'));
    if (!models.length) refuse('Web search on askeden.com needs Gemini, GPT or Claude: turn one on in the providers.');
  }
  if (hasImages(messages)) {
    models = models.filter(hasVision);
    if (!models.length) refuse('None of the models on here can read images. Turn on Claude, GPT or Gemini, or remove the image.');
  }
  if (override && !models.some((m) => m.id === override.model)) {
    const m = modelOf(override.model);
    if ((cfg.locked || []).some((x) => x.id === override.model)) throw new ApiError(422, 'needs_key', `${CLAUDE_NEEDS_KEY}.`);
    const why = mode !== 'chat' ? ' for web search here' : hasImages(messages) && m && !hasVision(m) ? ': it can’t read images' : ' with the providers you have on';
    throw new ApiError(422, 'not_here', `${m ? m.name : override.model} can’t be used${why}.`);
  }
  return { ...cfg, models };
}

/** The providers as /api/chat/meta lists them. */
export function providerStates(keys, cfg) {
  // Meta, Mistral and DeepSeek appear only once one of their models is on this site's list (EDEN_MODELS): until then
  // the page never names them (the iPhone app's privacy wording lists four providers; 2026-10-14).
  return PROVIDER_IDS.filter((id) => !LATER_PROVIDERS.includes(id) || cfg.models.some((m) => m.provider === id)).map((id) => {
    const name = PROVIDER_NAMES[id];
    const k = keys[id];
    const some = cfg.models.some((m) => m.provider === id);
    if (k && some) return { id, name, available: true, via: k.source === 'user' ? 'your API key' : 'your Eden Secretary account', reason: null };
    if (!k && BYOK_ONLY.includes(id)) return { id, name, available: false, via: null, reason: CLAUDE_NEEDS_KEY, needsKey: true, link: KEYS_SETTINGS };
    return { id, name, available: false, via: null, reason: k ? `No ${name} models are set up on askeden.com` : `No ${name.split(' ').pop()} API key on askeden.com` };
  });
}

/** Providers whose models search the web themselves: Gemini grounding, Claude's search tool (own key only), GPT's web_search. */
export const SEARCH_PROVIDERS = ['gemini', 'anthropic', 'openai'];
/** A model can answer a search turn: its own `search` flag, else its provider's (askeden src/chat/provider-info.ts). */
export const canSearch = (m) => (typeof m.search === 'boolean' ? m.search : SEARCH_PROVIDERS.includes(m.provider));

/** The preferred search provider on this page (Gemini, as on the Mac, then Claude, then GPT); null: none. */
export function searchProvider(cfg) {
  return ['gemini', 'anthropic', 'openai'].find((p) => cfg.models.some((m) => m.provider === p && canSearch(m))) || null;
}

export const modelOf = (id) => MODELS.find((m) => m.id === id);

const round6 = (x) => Math.round(x * 1e6) / 1e6;

/** Per-million prices [input, output] for this many input tokens (the long-context rate past its threshold). */
export function ratesOf(model, inputTokens = 0) {
  const p = model.pricing;
  const long = p.longContext && inputTokens > p.longContext.thresholdTokens;
  return long ? [p.longContext.inputPer1M, p.longContext.outputPer1M] : [p.inputPer1M, p.outputPer1M];
}

/** What web searches cost on this model. */
export function searchUSD(model, n) {
  if (!(n > 0)) return 0;
  if (model.provider === 'anthropic') return n * CLAUDE_SEARCH_USD;
  if (model.provider === 'openai') return n * OPENAI_SEARCH_USD;
  if (model.provider === 'gemini') return /gemini-2\./.test(model.id) ? GEMINI_GROUNDED_USD : n * GEMINI_QUERY_USD;
  return 0;
}

/** A call's cost at list price: { inputTokens, outputTokens, reasoningTokens, cachedInputTokens, webSearches }. */
export function usageUSD(model, u) {
  const tokens = {
    inputTokens: u.inputTokens || 0,
    outputTokens: u.outputTokens || 0,
    reasoningTokens: u.reasoningTokens || 0,
    ...(u.cachedInputTokens ? { cachedInputTokens: u.cachedInputTokens } : {}),
  };
  return round6(usageCost(model, tokens) + searchUSD(model, u.webSearches || 0));
}

/**
 * The request with its output cap at most `cap` (visible plus thinking), in the field its
 * provider uses; thinking budgets kept under it (Claude: ≥ 1024 below max_tokens, else off;
 * Gemini 2.5: at most cap − 1024, never turned off where it was on).
 */
export function capRequest(request, cap) {
  const own = requestMaxOutputTokens(request);
  const out = withMaxOutputTokens(request, Math.max(1, Math.min(own || cap, cap)));
  const params = out.params;
  const max = requestMaxOutputTokens(out);
  if (out.provider === 'anthropic' && params.thinking && params.thinking.type === 'enabled') {
    const budget = Math.min(Number(params.thinking.budget_tokens) || 0, max - 1024);
    if (budget >= 1024) params.thinking = { ...params.thinking, budget_tokens: budget };
    else delete params.thinking;
  }
  if (out.provider === 'gemini' && params.config && params.config.thinkingConfig) {
    const t = params.config.thinkingConfig;
    if (typeof t.thinkingBudget === 'number' && t.thinkingBudget > 0 && t.thinkingBudget > max - 1024) {
      params.config = { ...params.config, thinkingConfig: { ...t, thinkingBudget: Math.max(128, max - 1024) } };
    }
  }
  return out;
}

/**
 * What one call may send and cost at most, fitted to `leftUSD`: the output capped (by `maxTokens`
 * and the money), and for a search turn as many searches as fit. Claude's searches each re-read
 * the conversation and its results (up to `resultTokens` each); Gemini's grounding is a fee.
 * → { request, uses, worstUSD }, or null when not even `minReply` tokens of reply fit (with
 * `short: 'search'` when it's the searches that don't).
 */
export function fitCall(model, request, { leftUSD, inputTokens, searches = 0, maxTokens, minReply = 512, resultTokens = 10_000 }) {
  const [inPrice, outPrice] = ratesOf(model, inputTokens);
  const usd = (tokens, price) => (tokens * price) / 1e6;
  const fixed = (n) =>
    model.provider === 'anthropic'
      ? usd(inputTokens * (n + 1) + (resultTokens * n * (n + 1)) / 2, inPrice) + searchUSD(model, n)
      : model.provider === 'openai'
        ? usd(inputTokens + resultTokens * n, inPrice) + searchUSD(model, n) // each search's pages are read once as input
        : usd(inputTokens, inPrice) + searchUSD(model, n);
  const money = Number.isFinite(leftUSD) ? leftUSD : Infinity;
  let uses = searches;
  while (uses > 0 && fixed(uses) + usd(minReply, outPrice) > money) uses--;
  if (searches > 0 && uses === 0) return { short: 'search' };
  const afford = Math.floor(((money - fixed(uses)) / outPrice) * 1e6);
  const cap = Math.min(maxTokens, model.maxOutputTokens, afford);
  if (cap < minReply) return { short: 'money' };
  const capped = capRequest(request, cap);
  const worstUSD = round6(fixed(uses) + usd(requestMaxOutputTokens(capped), outPrice));
  return { request: capped, uses, worstUSD };
}

/** The server-side web search tool for a Claude model (the newer one where it's supported). */
export function searchTool(modelId, uses) {
  const dynamic = /claude-(opus-(4-[678]|5)|sonnet-(4-6|5)|fable)/.test(modelId);
  return { type: dynamic ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', max_uses: uses };
}

// ── dev and tests: fake providers on loopback ──

const PROVIDER_HOSTS = /^https:\/\/(api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com|oauth2\.googleapis\.com|api\.moonshot\.ai|api\.meta\.ai|api\.mistral\.ai|api\.deepseek\.com)\//;
const local = (h) => h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '[::1]';

/**
 * EDEN_FAKE_PROVIDER_BASE (dev and tests only): provider calls go to `<base>/<host>/<path>`
 * instead, and only while this request came to a local host and the base is plain http on
 * loopback. Anywhere else it's ignored.
 */
export function devProviderBase(env, request) {
  const base = String(env.EDEN_FAKE_PROVIDER_BASE || '').replace(/\/+$/, '');
  if (!base || !request) return null;
  let target;
  try {
    target = new URL(base);
  } catch {
    return null;
  }
  return local(new URL(request.url).hostname) && local(target.hostname) && target.protocol === 'http:' ? base : null;
}
export const viaBase = (base, url) => (base ? url.replace(PROVIDER_HOSTS, (_, h) => `${base}/${h}/`) : url);

// ── the Gemini rating ──

/**
 * A router over these models that can ask Gemini to rate the task (the Mac's classifier), or null
 * without a Gemini key. `metered` says whether the rating's cost counts on the included AI.
 */
export function ratingRouter(cfg, keys, efforts, base = null) {
  const k = keys.gemini;
  if (!k || !cfg.models.length) return null;
  const all = [k.key, ...(Array.isArray(k.fallbackKeys) ? k.fallbackKeys : [])];
  const aiStudioKey = all.find((x) => x && !isVertexKey(x)) || k.key;
  const router = createLocalRouter({
    models: cfg.models.map((m) => m.id),
    efforts,
    apiKey: aiStudioKey,
    fetch: (url, init) => fetch(viaBase(base, String(url)), init),
    timeoutMs: 8_000,
  });
  return { router, metered: k.source === 'service' };
}

// ── one streamed call ──

async function* chunks(reader) {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}

/**
 * Streams one call with the Mac's request builder and parser. `emit(type, data)` gets text and
 * thinking as they come. Never throws: → { text, finish ('stop' | 'length' | null), stopped,
 * failure, status, usage { inputTokens, outputTokens, reasoningTokens, webSearches, estimated },
 * costUSD, citations }. A stopped or failed stream's usage is what was reported, else estimated
 * (top of file).
 */
const QUOTA_FAILOVER_RE = /usage limit|rate_limit|rate limit|credit balance|out of credit|quota|exceeded|billing|regain access/i;

function applyAnthropicWorkspaceHeader(provider, rawKey, headers) {
  if (provider !== 'anthropic') return headers;
  const s = String(rawKey || '').trim();
  const idx = s.indexOf('#');
  if (idx > 0 && s.startsWith('sk-ant-')) {
    const apiKey = s.slice(0, idx).trim();
    const workspaceId = s.slice(idx + 1).trim();
    return {
      ...headers,
      'x-api-key': apiKey,
      ...(workspaceId ? { 'anthropic-workspace-id': workspaceId } : {}),
    };
  }
  return headers;
}

const vertexTokenCache = new Map();

function b64url(bytes) {
  let bin = '';
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem) {
  const clean = String(pem || '').replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s+/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function resolveVertexKey(rawKey, base, signal) {
  const m = /^vertex:\/\/([^/]+)\/([^#]+)#([\s\S]+)$/.exec(String(rawKey || ''));
  if (!m) return null;
  const [, project, location, secretRaw] = m;
  const secret = secretRaw.trim();
  const cached = vertexTokenCache.get(secret);
  if (cached && cached.expiresAt > Date.now() + 60_000) return { project, location, token: cached.token };

  let parsed = null;
  if (secret.startsWith('{')) {
    try {
      parsed = JSON.parse(secret);
    } catch {
      parsed = null;
    }
  } else if (!secret.startsWith('ya29.')) {
    try {
      const dec = atob(secret);
      if (dec.trim().startsWith('{')) parsed = JSON.parse(dec);
    } catch {
      parsed = null;
    }
  }
  if (!parsed) return { project, location, token: secret };

  const tokenUrl = viaBase(base, 'https://oauth2.googleapis.com/token');
  let body;
  if (parsed.type === 'authorized_user' || (parsed.client_id && parsed.client_secret && parsed.refresh_token)) {
    body = new URLSearchParams({
      client_id: String(parsed.client_id),
      client_secret: String(parsed.client_secret),
      refresh_token: String(parsed.refresh_token),
      grant_type: 'refresh_token',
    }).toString();
  } else if (parsed.type === 'service_account' && parsed.client_email && parsed.private_key) {
    const now = Math.floor(Date.now() / 1000);
    const enc = new TextEncoder();
    const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const claim = b64url(
      enc.encode(
        JSON.stringify({
          iss: parsed.client_email,
          scope: 'https://www.googleapis.com/auth/cloud-platform',
          aud: 'https://oauth2.googleapis.com/token',
          iat: now,
          exp: now + 3600,
        })
      )
    );
    const signingInput = `${header}.${claim}`;
    const cryptoKey = await crypto.subtle.importKey('pkcs8', pemToDer(parsed.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, enc.encode(signingInput));
    body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${signingInput}.${b64url(sig)}`,
    }).toString();
  } else {
    return null;
  }

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal,
  });
  if (!res.ok) return null;
  const tok = await res.json().catch(() => null);
  if (!tok || typeof tok.access_token !== 'string' || !tok.access_token) return null;
  const ttlMs = (Number(tok.expires_in) > 120 ? Number(tok.expires_in) : 3600) * 1000;
  vertexTokenCache.set(secret, { token: tok.access_token, expiresAt: Date.now() + ttlMs });
  return { project: parsed.project_id || project, location, token: tok.access_token };
}

export async function streamCall({ model, request, messages, system, search = false, uses = 0, key, fallbackKeys = [], base = null, inputTokens = 0, videos = [] }, { signal, emit }) {
  const provider = model.provider;
  const candidates = [key, ...(Array.isArray(fallbackKeys) ? fallbackKeys : [])].filter((k, i, a) => k && a.indexOf(k) === i);
  const buildForKey = async (k) => {
    const h = buildStreamRequest({ request, model, messages, system, search: (provider === 'gemini' || provider === 'openai') && search }, k);
    h.headers = applyAnthropicWorkspaceHeader(provider, k, h.headers);
    if (provider === 'gemini') withVideoParts(h.body, videos); // video.js: file_data parts
    if (provider === 'gemini' && isVertexKey(k)) {
      const v = await resolveVertexKey(k, base, signal);
      if (!v) return null;
      const modelId = String((request && request.params && request.params.model) || model.apiId || model.id);
      const host = v.location === 'global' ? 'aiplatform.googleapis.com' : `${v.location}-aiplatform.googleapis.com`;
      h.url = `https://${host}/v1beta1/projects/${encodeURIComponent(v.project)}/locations/${encodeURIComponent(v.location)}/publishers/google/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
      h.headers = { 'content-type': 'application/json', authorization: `Bearer ${v.token}`, 'x-goog-user-project': v.project };
      if (h.body.systemInstruction && !h.body.systemInstruction.role) {
        h.body.systemInstruction = { role: 'system', ...h.body.systemInstruction };
      }
      if (Array.isArray(h.body.tools)) {
        h.body.tools = h.body.tools.map((t) => (t && 'google_search' in t ? { googleSearch: t.google_search || {} } : t));
      }
    }
    if (provider === 'anthropic' && uses > 0) h.body.tools = [searchTool(model.apiId || model.id, uses)];
    if (provider === 'openai' && search && uses > 0) h.body.max_tool_calls = uses; // the Responses API's cap on searches
    return h;
  };
  const clean = (s) => {
    let out = String(s);
    for (const k of candidates) {
      const raw = String(k || '').split('#', 1)[0].trim();
      const tail = String(k || '').includes('#') ? String(k || '').split('#').slice(1).join('#').trim() : '';
      out = redact(out, k);
      if (raw && raw !== k) out = redact(out, raw);
      if (tail && tail.length >= 8) out = redact(out, tail);
    }
    return out;
  };
  const started = Date.now();
  let firstText = 0;
  let text = '';
  let chars = 0;
  let reported = null;
  const citations = [];
  const parser = createStreamParser(provider, model, { search: provider === 'openai' && search });
  const result = (extra) => {
    const p = parser.progress();
    let usage;
    if (reported) usage = { ...reported, webSearches: p.webSearches, estimated: false };
    else {
      const output = Math.max(p.outputTokens, Math.ceil(chars / CHARS_PER_TOKEN));
      let reasoning = p.reasoningTokens ?? 0;
      const hidden = provider === 'openai' && request.params.reasoning_effort && request.params.reasoning_effort !== 'none';
      if (p.reasoningTokens === undefined && hidden) {
        const seconds = ((firstText || Date.now()) - started) / 1000;
        reasoning = Math.max(0, Math.min((requestMaxOutputTokens(request) || 0) - output, Math.round(seconds * HIDDEN_REASONING_TPS)));
      }
      usage = { inputTokens: p.inputTokens || inputTokens, outputTokens: output, reasoningTokens: reasoning, webSearches: p.webSearches, estimated: true };
    }
    if (search && provider === 'gemini' && !usage.webSearches && citations.length) usage.webSearches = 1;
    return { text, citations, usage, costUSD: usageUSD(model, usage), stopped: false, failure: null, finish: null, status: null, ...extra };
  };
  let upstream;
  let lastErrorBody = '';
  for (let idx = 0; idx < candidates.length; idx++) {
    const hasNext = idx + 1 < candidates.length;
    const isVertex = isVertexKey(candidates[idx]);
    let http;
    try {
      http = await buildForKey(candidates[idx]);
    } catch (error) {
      if (signal.aborted) return result({ stopped: true });
      if (hasNext) continue;
      return { ...result({ failure: clean(`Couldn't reach ${PROVIDER_NAMES[provider]}: ${error.message}`) }), usage: null, costUSD: 0 };
    }
    if (!http) {
      if (hasNext) continue;
      return { ...result({ failure: `${PROVIDER_NAMES[provider]} credentials could not be resolved.` }), usage: null, costUSD: 0 };
    }
    try {
      upstream = await fetch(viaBase(base, http.url), { method: 'POST', headers: http.headers, body: JSON.stringify(http.body), signal });
    } catch (error) {
      if (signal.aborted) return result({ stopped: true });
      if (isVertex && hasNext) continue;
      return { ...result({ failure: clean(`Couldn't reach ${PROVIDER_NAMES[provider]}: ${error.message}`) }), usage: null, costUSD: 0 };
    }
    if (upstream.ok && upstream.body) break;
    lastErrorBody = await upstream.text().catch(() => '');
    const shouldFailover =
      hasNext &&
      (isVertex ||
        upstream.status === 402 ||
        upstream.status === 429 ||
        upstream.status === 529 ||
        ((upstream.status === 400 || upstream.status === 401 || upstream.status === 403) && QUOTA_FAILOVER_RE.test(lastErrorBody)));
    if (!shouldFailover) break;
  }
  if (!upstream || !upstream.ok || !upstream.body) {
    const body = lastErrorBody;
    let detail = body.trim();
    try {
      const j = JSON.parse(body);
      detail = (j.error && j.error.message) || j.message || detail;
    } catch {
      // the raw text
    }
    detail = clean(String(detail).replace(/\s+/g, ' ')).slice(0, 300);
    const status = upstream ? upstream.status : 502;
    const busy = status === 429 || status === 529 || status === 503;
    const failure = busy ? `${PROVIDER_NAMES[provider]} is busy right now (HTTP ${status}). Try again in a moment.` : `${PROVIDER_NAMES[provider]} HTTP ${status}${detail ? `: ${detail}` : ''}`;
    return { ...result({ failure, status }), usage: null, costUSD: 0 };
  }
  const reader = upstream.body.getReader();
  const onAbort = () => reader.cancel().catch(() => {});
  signal.addEventListener('abort', onAbort, { once: true });
  const take = (events) => {
    for (const e of events) {
      if (e.type === 'text') {
        firstText ||= Date.now();
        text += e.text;
        chars += e.text.length;
        emit('text', { text: e.text });
      } else if (e.type === 'thinking') {
        chars += e.text.length;
        emit('thinking', { text: e.text });
      } else if (e.type === 'citations') {
        for (const c of e.sources) if (!citations.some((x) => x.url === c.url)) citations.push(c);
      } else if (e.type === 'usage') {
        reported = {
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
          reasoningTokens: e.reasoningTokens,
          ...(e.cachedInputTokens ? { cachedInputTokens: e.cachedInputTokens } : {}),
        };
      } else if (e.type === 'finish') return e.finish;
    }
    return null;
  };
  try {
    for await (const m of readSse(chunks(reader))) {
      if (signal.aborted) break;
      take(parser.push(m));
    }
    if (signal.aborted) return result({ stopped: true });
    return result({ finish: take(parser.end()) || 'stop' });
  } catch (error) {
    if (signal.aborted) return result({ stopped: true });
    return result({ failure: clean(error && error.message ? error.message : error) });
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** A request's output cap (visible plus thinking), whatever its provider calls it. */
export const maxTokensOf = (request) => requestMaxOutputTokens(request) || 0;
