// Eden Router API, private beta (owner, 2026-10-16: "the lean version, it's only for one client right now").
// On edenrouter.com (worker.js, ROUTER_HOST), server to server, OpenAI-compatible:
//
//   POST /v1/chat/completions   model "eden-router" or "eden-router:level-1".."level-5" (+ optional
//                               x_eden { efficiency, performance, providers, classifier }): the Model Router picks a
//                               model and effort among the providers the client sent a key for, Eden calls it (the
//                               site's own provider code, eden/providers.js) and answers in OpenAI's shape, streamed
//                               (SSE) or not, with an x_eden block: the pick, effort, estimated and actual cost, why.
//                               A provider error before any text: one retry on the router's next pick.
//   POST /v1/route              the decision only, no provider call
//   GET  /v1/models             eden-router and its five levels
//   GET  /v1/usage              the client's own usage lines and daily totals
//   GET|POST /api/admin/router  the owner's server call (Bearer ROUTER_ADMIN_TOKEN, as /api/admin/lti): create a
//                               client and its key (shown once), list, update limits, revoke, read usage
//
// Auth: "Authorization: Bearer sk-eden-…", one key per client, kept only as its SHA-256 (store.js).
// Provider keys: the client's own, per request (x-openai-key, x-anthropic-key, x-gemini-key, x-moonshot-key);
// the Worker's keys only for a client created with service_keys: true (off by default).
// Limits: requests a minute and a daily spend cap per key (store.js). No CORS: a request with an Origin is refused.
// Never logged or stored: API keys, provider keys, prompts or answers (the usage log holds numbers only).

import { ApiError, b64url, hex, json, randomBytes, sameText, sha256Hex } from '../accounts/util.js';
import { OPTIMIZATION_LEVELS, createLocalRouter, effortLabel } from '../eden/vendor/model-router.js';
import { requestMaxOutputTokens, withMaxOutputTokens } from '../eden/vendor/providers.js';
import { KEY_VARS, PROVIDER_NAMES, autoModels, capRequest, devProviderBase, modelOf, ratingRouter, streamCall } from '../eden/providers.js';
import { effortsFor, hostedConfig } from '../eden/chat.js';

export const API_PROVIDERS = ['openai', 'anthropic', 'gemini', 'kimi'];
export const KEY_HEADERS = { openai: 'x-openai-key', anthropic: 'x-anthropic-key', gemini: 'x-gemini-key', kimi: 'x-moonshot-key' };
const PROVIDER_ALIASES = { openai: 'openai', anthropic: 'anthropic', claude: 'anthropic', gemini: 'gemini', google: 'gemini', moonshot: 'kimi', kimi: 'kimi' };
const LEVEL_NAMES = Object.fromEntries(OPTIMIZATION_LEVELS.map((l) => [l.name, l.level]));
export const MAX_BODY = 4 * 1024 * 1024;
const MAX_MESSAGES = 1000;
const KIMI_OUTPUT_TOKENS = 32_768; // as chat.js
const CHARS_PER_TOKEN = 3.5;
const KEY_RE = /^sk-eden-[A-Za-z0-9_-]{43}$/;
const STORE = 'clients';
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// ── errors, OpenAI's shape ──

const TYPES = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 405: 'invalid_request_error', 413: 'invalid_request_error', 422: 'invalid_request_error', 429: 'rate_limit_error' };
const fail = (status, code, message, headers = {}, extra = {}) => new ApiError(status, code, message, headers, extra);
const bad = (message, param = null) => fail(400, 'invalid_request', message, {}, { param });

/** { error: { message, type, param, code } }, as OpenAI's SDKs read it. */
export function errorResponse(error) {
  const status = error.status || 500;
  const type = status === 429 && error.code === 'daily_spend_cap' ? 'insufficient_quota' : TYPES[status] || 'api_error';
  const { param = null, ...rest } = error.extra || {};
  return json({ error: { message: error.message, type, param, code: error.code || null, ...rest } }, status, error.headers || {});
}

// ── the store (store.js) ──

async function store(env, op, body = {}) {
  if (!env.ROUTER_API) throw fail(503, 'not_set_up', 'The Eden Router API isn’t set up here yet.');
  const r = await env.ROUTER_API.get(env.ROUTER_API.idFromName(STORE)).fetch(`https://router-api/${op}`, { method: 'POST', body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) {
    const retry = r.headers.get('retry-after');
    throw fail(r.status, out.code || 'store_error', out.error || 'Something went wrong.', retry ? { 'retry-after': retry } : {});
  }
  return out;
}

/** A new client key: sk-eden- + 32 random bytes (base64url, 43 characters). */
export const newApiKey = () => `sk-eden-${b64url(randomBytes(32))}`;
const keyHint = (key) => `sk-eden-…${key.slice(-4)}`;

// ── the admin call ──

/** GET/POST /api/admin/router: the owner's server call (Bearer ROUTER_ADMIN_TOKEN, no browser). */
export async function routerAdmin(request, env) {
  try {
    const secret = String(env.ROUTER_ADMIN_TOKEN || '');
    if (secret.length < 24 || !env.ROUTER_API) throw fail(503, 'not_set_up', 'The Eden Router API isn’t set up here yet.');
    if (request.headers.get('origin')) throw fail(403, 'forbidden', 'Not from a web page.');
    const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
    if (!bearer || !sameText(bearer[1], secret)) throw fail(401, 'unauthorized', 'No.');
    if (request.method === 'GET') return json(await store(env, 'list'));
    if (request.method !== 'POST') throw fail(405, 'method', 'GET or POST.');
    const body = await request.json().catch(() => ({}));
    if (body.action === 'create') {
      const key = newApiKey();
      const out = await store(env, 'create', { id: hex(randomBytes(8)), hash: await sha256Hex(key), hint: keyHint(key), name: body.name, rpm: body.rpm, daily_usd: body.daily_usd, service_keys: body.service_keys });
      return json({ ...out, api_key: key, note: 'Shown once: Eden keeps only its hash. Hand it to the client over a private channel.' });
    }
    if (body.action === 'update') return json(await store(env, 'update', { id: body.id, name: body.name, rpm: body.rpm, daily_usd: body.daily_usd, service_keys: body.service_keys }));
    if (body.action === 'revoke') return json(await store(env, 'revoke', { id: body.id }));
    if (body.action === 'usage') return json(await store(env, 'usage', { id: body.id, limit: body.limit, days: body.days }));
    throw fail(400, 'bad_request', 'action is "create", "update", "revoke" or "usage".');
  } catch (error) {
    if (error instanceof ApiError) return error.response();
    throw error;
  }
}

// ── the request ──

/** The client's provider keys: its own headers first; the Worker's only when the client may use them. */
export function providerKeys(request, env, client) {
  const keys = {};
  for (const p of API_PROVIDERS) {
    const own = String(request.headers.get(KEY_HEADERS[p]) || '').trim();
    if (own) keys[p] = { key: own, source: 'client' };
    else if (client.service_keys) {
      const k = String(env[KEY_VARS[p]] || '').trim();
      if (k) keys[p] = { key: k, source: 'service' };
    }
  }
  return keys;
}

const textOf = (content, i) => {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (!Array.isArray(content)) throw bad(`messages[${i}].content must be a string or an array of text parts.`, `messages[${i}].content`);
  return content
    .map((part) => {
      if (isObj(part) && part.type === 'text' && typeof part.text === 'string') return part.text;
      throw bad(`messages[${i}]: only text parts are supported in the private beta (no images, audio or files yet).`, `messages[${i}].content`);
    })
    .join('\n');
};

/** The router's settings from the model name and x_eden. */
export function routeSettings(body) {
  const m = /^eden-router(?::(?:level-([1-5])|([a-z-]+)))?$/.exec(String(body.model || ''));
  if (!m || (m[2] && !LEVEL_NAMES[m[2]])) throw fail(404, 'model_not_found', `The model "${String(body.model || '').slice(0, 64)}" doesn't exist here. Use "eden-router" or "eden-router:level-1" … "eden-router:level-5".`, {}, { param: 'model' });
  const x = body.x_eden === undefined ? {} : body.x_eden;
  if (!isObj(x)) throw bad('x_eden must be an object.', 'x_eden');
  const level = m[1] ? Number(m[1]) : m[2] ? LEVEL_NAMES[m[2]] : 3;
  const out = { level };
  for (const k of ['efficiency', 'performance']) {
    if (x[k] === undefined) continue;
    if (!Number.isFinite(x[k]) || x[k] < 0 || x[k] > 100) throw bad(`x_eden.${k} is a number from 0 to 100.`, `x_eden.${k}`);
    out[k] = x[k];
  }
  let providers = null;
  if (x.providers !== undefined) {
    if (!Array.isArray(x.providers) || !x.providers.length) throw bad('x_eden.providers is a list such as ["openai", "gemini"].', 'x_eden.providers');
    providers = x.providers.map((p) => {
      const id = PROVIDER_ALIASES[String(p).toLowerCase()];
      if (!id) throw bad(`x_eden.providers: "${String(p).slice(0, 32)}" isn't one of openai, anthropic, gemini, moonshot.`, 'x_eden.providers');
      return id;
    });
  }
  const classifier = x.classifier === undefined ? 'off' : x.classifier;
  if (!['off', 'auto', 'always'].includes(classifier)) throw bad('x_eden.classifier is "off", "auto" or "always".', 'x_eden.classifier');
  return { settings: out, providers, classifier };
}

/** The conversation: Eden's messages, the system text, the prompt the router reads, sizes. */
export function conversation(body) {
  if (!Array.isArray(body.messages) || !body.messages.length) throw bad('messages must be a non-empty list.', 'messages');
  if (body.messages.length > MAX_MESSAGES) throw bad(`At most ${MAX_MESSAGES} messages.`, 'messages');
  if ((Array.isArray(body.tools) && body.tools.length) || (Array.isArray(body.functions) && body.functions.length)) throw bad('Tools and function calling aren’t supported in the private beta yet.', 'tools');
  if (body.n !== undefined && body.n !== 1) throw bad('n must be 1.', 'n');
  const system = [];
  const messages = [];
  body.messages.forEach((m, i) => {
    if (!isObj(m)) throw bad(`messages[${i}] must be an object.`, `messages[${i}]`);
    const text = textOf(m.content, i);
    if (m.role === 'system' || m.role === 'developer') system.push(text);
    else if (m.role === 'user' || m.role === 'assistant') {
      if (m.tool_calls || m.function_call) throw bad('Tool calls aren’t supported in the private beta yet.', `messages[${i}]`);
      messages.push({ role: m.role, content: text });
    } else throw bad(`messages[${i}].role must be system, developer, user or assistant.`, `messages[${i}].role`);
  });
  if (!messages.length || messages[messages.length - 1].role !== 'user') throw bad('The last message must be from the user.', 'messages');
  const prompt = messages[messages.length - 1].content.trim() || '(empty message)';
  const chars = system.join('').length + messages.reduce((n, m) => n + m.content.length, 0);
  const inputTokens = Math.ceil(chars / CHARS_PER_TOKEN);
  const max = body.max_completion_tokens ?? body.max_tokens;
  if (max !== undefined && max !== null && !(Number.isInteger(max) && max > 0)) throw bad('max_tokens must be a positive whole number.', 'max_tokens');
  return { messages, system: system.join('\n\n'), prompt, inputTokens, sessionTokens: Math.max(0, inputTokens - Math.ceil(prompt.length / CHARS_PER_TOKEN)), maxTokens: max || null };
}

// ── routing ──

const routers = new Map();
function routerOver(ids, maxEffort, pin = null) {
  const key = `${ids.join(',')}|${maxEffort}|${pin || ''}`;
  let r = routers.get(key);
  if (!r) {
    r = createLocalRouter({ models: ids, efforts: (m) => (pin ? [pin] : effortsFor(m, maxEffort)) });
    routers.set(key, r);
    if (routers.size > 64) routers.delete(routers.keys().next().value);
  }
  return r;
}

/** The models the router may pick for this request: the site's hosted set, on the providers there are keys for. */
export function poolFor(env, have, wanted) {
  const cfg = hostedConfig(env);
  const models = autoModels(cfg.models).filter((m) => API_PROVIDERS.includes(m.provider) && have.includes(m.provider) && (!wanted || wanted.includes(m.provider)));
  return { ...cfg, models };
}

/** The decision (the router's RouteResult) and the classifier's cost; ApiError 422 when nothing fits. */
async function decide(cfg, conv, route, keys, base) {
  const extras = { ...route.settings, ...(conv.sessionTokens > 0 ? { context: { sessionTokens: conv.sessionTokens } } : {}) };
  let ratingUSD = 0;
  let result = null;
  if (route.classifier !== 'off' && keys.gemini) {
    const rater = ratingRouter(cfg, keys, (m) => effortsFor(m, cfg.maxEffort), base);
    try {
      result = await rater.router.route({ prompt: conv.prompt, ...extras, classifier: route.classifier });
      if (result.classification) ratingUSD = Number(result.classification.costUSD) || 0;
    } catch {
      result = null; // the rules decide
    }
  }
  try {
    result ||= routerOver(cfg.models.map((m) => m.id), cfg.maxEffort).routeSync({ prompt: conv.prompt, ...extras });
  } catch (error) {
    throw fail(422, 'cant_route', String(error.message || error).split('\n')[0]);
  }
  return { result, extras, ratingUSD };
}

/** A pick (model + effort) with its provider request, sized for the reply. */
function candidate(cfg, conv, extras, row, result) {
  const pick = result.pick.model === row.model && result.pick.effort === row.effort ? result.pick : routerOver([row.model], cfg.maxEffort, row.effort).routeSync({ prompt: conv.prompt, ...extras }).pick;
  const model = modelOf(pick.model);
  const ceiling = Math.min(cfg.maxTokens, model.provider === 'kimi' ? KIMI_OUTPUT_TOKENS : model.maxOutputTokens || cfg.maxTokens);
  const cap = Math.min(conv.maxTokens || ceiling, ceiling);
  const request = (requestMaxOutputTokens(pick.request) || 0) === cap ? pick.request : capRequest(withMaxOutputTokens(pick.request, cap), cap);
  return { model, pick, request };
}

const decisionInfo = (result, cfg, route) => ({
  level: result.optimization && result.optimization.level ? result.optimization.level.level : route.settings.level,
  efficiency: result.optimization ? result.optimization.efficiency : null,
  performance: result.optimization ? result.optimization.performance : null,
  task: result.task ? { complexity: result.task.complexity, signals: result.task.signals || [] } : null,
  pool: cfg.models.map((m) => m.id),
});

// ── the handler ──

/** /v1/* on edenrouter.com. */
export async function routerApi(request, env, ctx, path) {
  try {
    if (request.headers.get('origin')) throw fail(403, 'no_browsers', 'The Eden Router API is server to server: requests from a web page (with an Origin) are refused.');
    if (request.method === 'OPTIONS') throw fail(405, 'method', 'No CORS: call the API from a server.');
    const endpoint = { '/v1/chat/completions': 'POST', '/v1/route': 'POST', '/v1/models': 'GET', '/v1/usage': 'GET' }[path];
    if (!endpoint) throw fail(404, 'not_found', `No route ${path.slice(0, 64)}. See https://edenrouter.com for the API.`);
    if (request.method !== endpoint) throw fail(405, 'method', `${path} takes ${endpoint}.`);
    const auth = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') || '');
    if (!auth) throw fail(401, 'missing_api_key', 'Send your Eden Router key as "Authorization: Bearer sk-eden-…".');
    if (!KEY_RE.test(auth[1])) throw fail(401, 'invalid_api_key', 'Invalid API key.');
    const admitted = await store(env, 'admit', { hash: await sha256Hex(auth[1]) });
    const client = admitted.client;
    if (path === '/v1/models') return models();
    if (path === '/v1/usage') {
      const q = new URL(request.url).searchParams;
      const u = await store(env, 'usage', { id: client.id, limit: q.get('limit') || 100, days: q.get('days') || 7 });
      return json({ object: 'eden.usage', client: { id: u.client.id, name: u.client.name }, limits: u.limits, spent_today_usd: u.spent_today_usd, daily: u.daily, data: u.data });
    }
    const kind = path === '/v1/route' ? 'route' : 'chat';
    const started = Date.now();
    const record = (entry) => store(env, 'record', { id: client.id, entry: { kind, latency_ms: Date.now() - started, ...entry } }).catch(() => null);
    try {
      return await (kind === 'route' ? routeOnly(request, env, client, record) : completions(request, env, ctx, client, admitted.spent_today_usd, record));
    } catch (error) {
      if (error instanceof ApiError) await record({ status: error.status });
      throw error;
    }
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error);
    console.error('router-api: failed', error && error.name); // never the message: it could quote a request
    return errorResponse(fail(500, 'server_error', 'Something went wrong on Eden’s side.'));
  }
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw fail(413, 'too_large', `At most ${MAX_BODY / 1024 / 1024} MB a request.`);
  try {
    const body = JSON.parse(text);
    if (!isObj(body)) throw new Error('not an object');
    return body;
  } catch {
    throw bad('The body must be a JSON object.');
  }
}

function models() {
  const created = 1792108800; // 2026-10-16
  const data = [
    { id: 'eden-router', object: 'model', created, owned_by: 'eden', x_eden: { level: 3, description: 'The Model Router at its default level (balanced).' } },
    ...OPTIMIZATION_LEVELS.map((l) => ({ id: `eden-router:level-${l.level}`, object: 'model', created, owned_by: 'eden', x_eden: { level: l.level, name: l.name, efficiency: l.efficiency, performance: l.performance, description: l.description } })),
  ];
  return json({ object: 'list', data });
}

/** POST /v1/route: the decision only. Providers: those with a key sent, else x_eden.providers, else all four. */
async function routeOnly(request, env, client, record) {
  const body = await readBody(request);
  const route = routeSettings(body);
  const conv = conversation(body);
  const keys = providerKeys(request, env, client);
  const have = Object.keys(keys).length ? Object.keys(keys) : route.providers || API_PROVIDERS;
  const cfg = poolFor(env, have, route.providers);
  if (!cfg.models.length) throw bad('None of the providers in x_eden.providers has a key here.', 'x_eden.providers');
  const { result, extras, ratingUSD } = await decide(cfg, conv, route, keys, devProviderBase(env, request));
  const first = candidate(cfg, conv, extras, result.pick, result);
  await record({ model: first.model.id, provider: first.model.provider, effort: first.pick.effort, cost_usd: ratingUSD, estimated_usd: first.pick.costUSD, status: 200 });
  return json({
    object: 'eden.route',
    model: 'eden-router',
    x_eden: {
      ...pickInfo(first),
      estimated_cost_usd: round6(first.pick.costUSD),
      quality: first.pick.quality,
      rationale: first.pick.rationale || '',
      warnings: first.pick.warnings || [],
      request: first.request,
      fallbacks: (result.fallbacks || []).slice(0, 3).map((f) => ({ model: f.model, provider: f.provider, effort: f.effort, estimated_cost_usd: round6(f.costUSD), quality: f.quality })),
      classifier: { mode: route.classifier, used: Boolean(result.classification && result.classification.used), cost_usd: round6(ratingUSD) },
      ...decisionInfo(result, cfg, route),
    },
  });
}

const pickInfo = (c) => ({ model: c.model.id, name: c.model.name, provider: c.model.provider, provider_name: PROVIDER_NAMES[c.model.provider], effort: c.pick.effort, effort_label: effortLabel(c.pick.effort) });

/** POST /v1/chat/completions. */
async function completions(request, env, ctx, client, spentToday, record) {
  const body = await readBody(request);
  const route = routeSettings(body);
  const conv = conversation(body);
  const stream = body.stream === true;
  const includeUsage = Boolean(isObj(body.stream_options) && body.stream_options.include_usage);
  const keys = providerKeys(request, env, client);
  if (!Object.keys(keys).length) throw bad(`Send at least one provider key: ${Object.values(KEY_HEADERS).join(', ')}. The router picks only among providers you send a key for.`);
  const cfg = poolFor(env, Object.keys(keys), route.providers);
  if (!cfg.models.length) throw bad('None of the providers in x_eden.providers has a key in this request.', 'x_eden.providers');
  const base = devProviderBase(env, request);
  const { result, extras, ratingUSD } = await decide(cfg, conv, route, keys, base);
  const first = candidate(cfg, conv, extras, result.pick, result);
  if (spentToday + first.pick.costUSD + ratingUSD > client.daily_usd) {
    throw fail(429, 'daily_spend_cap', `Daily spend cap reached: $${client.daily_usd} a day (spent $${round6(spentToday)} today, UTC). Ask Eden to raise it, or try again tomorrow.`);
  }
  const next = (result.fallbacks || []).find((f) => f.model !== first.model.id && cfg.models.some((m) => m.id === f.model));
  const id = `chatcmpl-${b64url(randomBytes(18))}`;
  const t0 = Date.now();
  const created = Math.floor(t0 / 1000);
  const abort = new AbortController();
  if (request.signal) request.signal.addEventListener('abort', () => abort.abort(), { once: true });

  // Runs the pick, then (a provider error before any text) the router's next pick, once.
  const run = async (emitText) => {
    let sent = 0;
    const call = (c) => streamCall({ model: c.model, request: c.request, messages: conv.messages, system: conv.system, key: keys[c.model.provider].key, base, inputTokens: conv.inputTokens }, { signal: abort.signal, emit: (type, data) => { if (type === 'text' && data.text) { sent += data.text.length; emitText(c, data.text); } } });
    let used = first;
    let r = await call(first);
    let fallback = null;
    let spent = r.costUSD || 0;
    if (r.failure && !r.stopped && !sent && next) {
      fallback = { from: first.model.id, reason: r.failure };
      used = candidate(cfg, conv, extras, next, result);
      r = await call(used);
      spent += r.costUSD || 0;
    }
    return { r, used, fallback, spent: round6(spent + ratingUSD) };
  };

  const xEden = ({ used, fallback, spent }, latency) => ({
    ...pickInfo(used),
    estimated_cost_usd: round6(used.pick.costUSD + ratingUSD),
    actual_cost_usd: spent,
    rationale: used.pick.rationale || (used === first ? '' : `Fell back to the router's next pick, ${used.model.name}.`),
    warnings: used.pick.warnings || [],
    fallback,
    classifier: { mode: route.classifier, used: Boolean(result.classification && result.classification.used), cost_usd: round6(ratingUSD) },
    key_source: keys[used.model.provider].source,
    latency_ms: latency,
    ...decisionInfo(result, cfg, route),
  });
  const usageOf = (r) => {
    const u = r.usage || { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    const out = (u.outputTokens || 0) + (u.reasoningTokens || 0);
    return { prompt_tokens: u.inputTokens || 0, completion_tokens: out, total_tokens: (u.inputTokens || 0) + out, completion_tokens_details: { reasoning_tokens: u.reasoningTokens || 0 }, ...(u.estimated ? { x_eden_estimated: true } : {}) };
  };
  const finishOf = (r) => (r.finish === 'length' ? 'length' : 'stop');
  const upstream = (r) => fail(r.status === 429 || r.status === 529 || r.status === 503 ? 503 : 502, 'provider_error', r.failure, {}, { upstream_status: r.status || null });
  const entry = (out, status) => {
    const u = out.r.usage || {};
    return { model: out.used.model.id, provider: out.used.model.provider, effort: out.used.pick.effort, tokens_in: u.inputTokens, tokens_out: u.outputTokens, reasoning_tokens: u.reasoningTokens, cost_usd: out.spent, estimated_usd: out.used.pick.costUSD + ratingUSD, status, stream, fallback: out.fallback ? out.fallback.from : null };
  };

  if (!stream) {
    const out = await run(() => {});
    if (out.r.failure) {
      await record({ ...entry(out, 502), status: upstream(out.r).status });
      throw upstream(out.r);
    }
    const latency = Date.now() - t0;
    await record(entry(out, 200));
    return json({
      id,
      object: 'chat.completion',
      created,
      model: out.used.model.id,
      choices: [{ index: 0, message: { role: 'assistant', content: out.r.text, refusal: null }, logprobs: null, finish_reason: finishOf(out.r) }],
      usage: usageOf(out.r),
      system_fingerprint: null,
      x_eden: xEden(out, latency),
    });
  }

  // Streamed: the headers wait for the first text, so an error before any (after the fallback) is a plain error.
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let open = true;
  const send = (obj) => {
    if (!open) return;
    writer.write(enc.encode(`data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`)).catch(() => {
      open = false;
      abort.abort(); // the client went away
    });
  };
  const chunk = (model, delta, finish = null, extra = {}) => ({ id, object: 'chat.completion.chunk', created, model, system_fingerprint: null, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }], ...extra });
  let began = false;
  let firstText;
  const ready = new Promise((resolve) => (firstText = resolve));
  const task = (async () => {
    const out = await run((c, text) => {
      if (!began) {
        began = true;
        firstText(null);
        send(chunk(c.model.id, { role: 'assistant', content: '' }));
      }
      send(chunk(c.model.id, { content: text }));
    });
    const latency = Date.now() - t0;
    if (!began) {
      // nothing was sent: the whole answer is an error (or an empty answer)
      if (out.r.failure) {
        await record({ ...entry(out, 502), status: upstream(out.r).status });
        firstText(upstream(out.r));
        return;
      }
      began = true;
      firstText(null);
      send(chunk(out.used.model.id, { role: 'assistant', content: '' }));
    }
    if (out.r.failure && !out.r.stopped) {
      send({ error: { message: out.r.failure, type: 'api_error', param: null, code: 'provider_error' } });
      await record(entry(out, 502));
    } else {
      send(chunk(out.used.model.id, {}, finishOf(out.r), { x_eden: xEden(out, latency) }));
      if (includeUsage) send({ id, object: 'chat.completion.chunk', created, model: out.used.model.id, system_fingerprint: null, choices: [], usage: usageOf(out.r) });
      send('[DONE]');
      await record(entry(out, out.r.stopped ? 499 : 200));
    }
    open = false;
    await writer.close().catch(() => {});
  })().catch(async () => {
    firstText(fail(500, 'server_error', 'Something went wrong on Eden’s side.'));
    open = false;
    await writer.abort().catch(() => {});
  });
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(task);
  const failed = await ready;
  if (failed) {
    await writer.abort().catch(() => {});
    throw failed;
  }
  return new Response(readable, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
}
