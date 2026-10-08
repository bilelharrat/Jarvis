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

export const PROVIDER_IDS = ['anthropic', 'openai', 'gemini', 'kimi'];
export const KEY_VARS = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', kimi: 'MOONSHOT_API_KEY' };
export const SWITCH_VARS = { anthropic: 'EDEN_ANTHROPIC', openai: 'EDEN_OPENAI', gemini: 'EDEN_GEMINI', kimi: 'EDEN_KIMI' };

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

/** Claude for everyone on the included AI: an ANTHROPIC_API_KEY is set (and ANTHROPIC not switched off). Without it, Claude stays bring-your-own-key. */
export const serviceClaude = (env) => Boolean(String(env.ANTHROPIC_API_KEY || '').trim()) && !switchedOff(env, 'anthropic');

/** The key a provider's calls use for this asker, and whose it is; null: none. Stable contract (top of file). */
export async function providerKey(env, who, provider) {
  if (!PROVIDER_IDS.includes(provider) || switchedOff(env, provider)) return null;
  const own = await userKeyFor(env, who, provider); // the owner's own key first (accounts/user-keys.js)
  if (own) return own;
  if (BYOK_ONLY.includes(provider) && !serviceClaudeForTests && !serviceClaude(env)) return null; // Claude: own key only, unless the service has an Anthropic key (serviceClaude)
  const key = String(env[KEY_VARS[provider]] || '').trim();
  return key ? { key, source: 'service' } : null;
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
  const pool = cfg.models.filter((m) => !BYOK_ONLY.includes(m.provider));
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
  return PROVIDER_IDS.map((id) => {
    const name = PROVIDER_NAMES[id];
    const k = keys[id];
    const some = cfg.models.some((m) => m.provider === id);
    if (k && some) return { id, name, available: true, via: k.source === 'user' ? 'your API key' : 'your Jarvis account', reason: null };
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

/** A call's cost at list price: { inputTokens, outputTokens, reasoningTokens, webSearches }. */
export function usageUSD(model, u) {
  const tokens = { inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0, reasoningTokens: u.reasoningTokens || 0 };
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

const PROVIDER_HOSTS = /^https:\/\/(api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|api\.moonshot\.ai)\//;
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
  const router = createLocalRouter({
    models: cfg.models.map((m) => m.id),
    efforts,
    apiKey: k.key,
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
export async function streamCall({ model, request, messages, system, search = false, uses = 0, key, base = null, inputTokens = 0, videos = [] }, { signal, emit }) {
  const provider = model.provider;
  const http = buildStreamRequest({ request, model, messages, system, search: (provider === 'gemini' || provider === 'openai') && search }, key);
  if (provider === 'gemini') withVideoParts(http.body, videos); // video.js: file_data parts
  if (provider === 'anthropic' && uses > 0) http.body.tools = [searchTool(model.apiId || model.id, uses)];
  if (provider === 'openai' && search && uses > 0) http.body.max_tool_calls = uses; // the Responses API's cap on searches
  const clean = (s) => redact(String(s), key);
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
  try {
    upstream = await fetch(viaBase(base, http.url), { method: 'POST', headers: http.headers, body: JSON.stringify(http.body), signal });
  } catch (error) {
    if (signal.aborted) return result({ stopped: true });
    return { ...result({ failure: clean(`Couldn't reach ${PROVIDER_NAMES[provider]}: ${error.message}`) }), usage: null, costUSD: 0 };
  }
  if (!upstream.ok || !upstream.body) {
    const body = await upstream.text().catch(() => '');
    let detail = body.trim();
    try {
      const j = JSON.parse(body);
      detail = (j.error && j.error.message) || j.message || detail;
    } catch {
      // the raw text
    }
    detail = clean(String(detail).replace(/\s+/g, ' ')).slice(0, 300);
    const busy = upstream.status === 429 || upstream.status === 529 || upstream.status === 503;
    const failure = busy ? `${PROVIDER_NAMES[provider]} is busy right now (HTTP ${upstream.status}). Try again in a moment.` : `${PROVIDER_NAMES[provider]} HTTP ${upstream.status}${detail ? `: ${detail}` : ''}`;
    return { ...result({ failure, status: upstream.status }), usage: null, costUSD: 0 };
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
        reported = { inputTokens: e.inputTokens, outputTokens: e.outputTokens, reasoningTokens: e.reasoningTokens };
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
