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
import { MODELS, OPTIMIZATION_LEVELS, createLocalRouter, effortLabel } from '../eden/vendor/model-router.js';
import { requestMaxOutputTokens, withMaxOutputTokens } from '../eden/vendor/providers.js';
import { assessRisk } from '../eden/vendor/verify.js';
import { KEY_VARS, PROVIDER_NAMES, autoModels, capRequest, devProviderBase, modelOf, ratingRouter, streamCall } from '../eden/providers.js';
import { effortsFor, hostedConfig } from '../eden/chat.js';

const MODEL_RELIABILITY = new Map(
  MODELS.map((m) => [
    m.id,
    Math.round(((m.capabilities.knowledge * 0.7) + (m.capabilities.reasoning * 0.3)) * 10) / 10,
  ]),
);
const reliabilityFor = (id) => MODEL_RELIABILITY.get(id) ?? 75;

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

/** Execute a Router API admin action on behalf of an authenticated admin session or token. */
export async function executeRouterAdminAction(env, body = {}, actor = 'admin') {
  if (!env.ROUTER_API) throw fail(503, 'not_set_up', 'The Eden Router API isn’t set up here yet.');
  const action = body.action || 'dashboard';
  if (action === 'dashboard') {
    const dash = await store(env, 'dashboard');
    const providers = API_PROVIDERS.map((p) => ({
      id: p,
      name: PROVIDER_NAMES[p] || p,
      configured: Boolean(String(env[KEY_VARS[p]] || '').trim()),
    }));
    return { ...dash, providers };
  }
  if (action === 'list') return store(env, 'list');
  if (action === 'create') {
    const key = newApiKey();
    const out = await store(env, 'create', {
      id: hex(randomBytes(8)),
      hash: await sha256Hex(key),
      hint: keyHint(key),
      actor,
      name: body.name,
      rpm: body.rpm,
      daily_usd: body.daily_usd ?? body.dailySpendLimitUSD,
      monthly_usd: body.monthly_usd ?? body.monthlySpendLimitUSD,
      tag: body.tag,
      ip_whitelist: body.ip_whitelist ?? body.ipWhitelist,
      on_cap_breach: body.on_cap_breach ?? body.onCapBreach,
      service_keys: body.service_keys ?? body.serviceKeys,
      max_effort: body.max_effort ?? body.maxEffort,
      providers: body.providers ?? body.allowed_providers ?? body.allowedProviders,
      models: body.models ?? body.allowed_models ?? body.allowedModels,
    });
    return { ...out, api_key: key, note: 'Shown once: Eden keeps only its hash. Hand it to the client over a private channel.' };
  }
  if (action === 'update') {
    return store(env, 'update', {
      id: body.id,
      actor,
      name: body.name,
      rpm: body.rpm,
      daily_usd: body.daily_usd ?? body.dailySpendLimitUSD,
      monthly_usd: body.monthly_usd ?? body.monthlySpendLimitUSD,
      paused: body.paused,
      tag: body.tag,
      ip_whitelist: body.ip_whitelist ?? body.ipWhitelist,
      on_cap_breach: body.on_cap_breach ?? body.onCapBreach,
      service_keys: body.service_keys ?? body.serviceKeys,
      max_effort: body.max_effort ?? body.maxEffort,
      providers: body.providers ?? body.allowed_providers ?? body.allowedProviders,
      models: body.models ?? body.allowed_models ?? body.allowedModels,
    });
  }
  if (action === 'pause') return store(env, 'pause', { id: body.id, actor });
  if (action === 'resume') return store(env, 'resume', { id: body.id, actor });
  if (action === 'revoke') return store(env, 'revoke', { id: body.id, actor });
  if (action === 'rotate') {
    const key = newApiKey();
    const out = await store(env, 'rotate', {
      id: body.id,
      actor,
      hash: await sha256Hex(key),
      hint: keyHint(key),
      grace_period_ms: body.grace_period_ms ?? body.gracePeriodMs,
    });
    return {
      ...out,
      api_key: key,
      note: out.grace_period_ms > 0
        ? `Rotated with ${Math.round(out.grace_period_ms / 1000)}s grace period for the previous key. Shown once.`
        : 'Rotated: old key invalidated immediately. Shown once.',
    };
  }
  if (action === 'usage') return store(env, 'usage', { id: body.id, limit: body.limit, days: body.days });
  if (action === 'policy') return store(env, 'policy', { update: body.policy || body.update || body, actor });
  throw fail(400, 'bad_request', 'action is "create", "update", "revoke", "rotate", "pause", "resume", "policy" or "usage".');
}

// ── the admin call ──

/** GET/POST /api/admin/router: the owner's server call (Bearer ROUTER_ADMIN_TOKEN, no browser). */
export async function routerAdmin(request, env) {
  try {
    const secret = String(env.ROUTER_ADMIN_TOKEN || '');
    if (secret.length < 24 || !env.ROUTER_API) throw fail(503, 'not_set_up', 'The Eden Router API isn’t set up here yet.');
    if (request.headers.get('origin')) throw fail(403, 'forbidden', 'Not from a web page.');
    const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
    if (!bearer || !sameText(bearer[1], secret)) throw fail(401, 'unauthorized', 'No.');
    if (request.method === 'GET') return json(await executeRouterAdminAction(env, { action: 'list' }, 'token'));
    if (request.method !== 'POST') throw fail(405, 'method', 'GET or POST.');
    const body = await request.json().catch(() => ({}));
    return json(await executeRouterAdminAction(env, body, 'token'));
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

const parseContentParts = (content, i) => {
  if (typeof content === 'string') return { text: content, attachments: [], hasVision: false };
  if (content === null || content === undefined) return { text: '', attachments: [], hasVision: false };
  if (!Array.isArray(content)) throw bad(`messages[${i}].content must be a string or an array of content parts.`, `messages[${i}].content`);
  const textParts = [];
  const attachments = [];
  let hasVision = false;
  for (const part of content) {
    if (!isObj(part)) throw bad(`messages[${i}].content parts must be objects.`, `messages[${i}].content`);
    if ((part.type === 'text' || part.type === 'input_text') && typeof part.text === 'string') {
      textParts.push(part.text);
    } else if (part.type === 'image_url' || part.type === 'input_image') {
      const urlVal = typeof part.image_url === 'string' ? part.image_url : isObj(part.image_url) && typeof part.image_url.url === 'string' ? part.image_url.url : '';
      const dataMatch = /^data:([^;]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(urlVal.trim());
      if (dataMatch) {
        attachments.push({ kind: 'image', mime: dataMatch[1].toLowerCase(), data: dataMatch[2].replace(/\s+/g, '') });
        hasVision = true;
      } else {
        throw bad(`messages[${i}]: image_url must be a base64 data:image/... URI.`, `messages[${i}].content`);
      }
    } else if (part.type === 'image' && isObj(part.source) && part.source.type === 'base64' && typeof part.source.data === 'string') {
      attachments.push({ kind: 'image', mime: typeof part.source.media_type === 'string' ? part.source.media_type : 'image/png', data: part.source.data.replace(/\s+/g, '') });
      hasVision = true;
    } else if (part.type === 'file' || part.type === 'document') {
      const f = isObj(part.file) ? part.file : part;
      const text = typeof f.text === 'string' ? f.text : typeof f.content === 'string' ? f.content : '';
      attachments.push({ kind: 'text', name: typeof f.filename === 'string' ? f.filename : typeof f.name === 'string' ? f.name : 'file', text });
    } else {
      throw bad(`messages[${i}]: unsupported content part type "${String(part.type || '')}".`, `messages[${i}].content`);
    }
  }
  return { text: textParts.join('\n'), attachments, hasVision };
};

/** The router's settings from the model name and x_eden. */
export function routeSettings(body) {
  const m = /^eden-router(?::(?:level-([1-5])|([a-z-]+)))?$/.exec(String(body.model || 'eden-router'));
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
  const classifier = x.classifier === undefined ? (body.classifier === undefined ? 'off' : body.classifier) : x.classifier;
  if (!['off', 'auto', 'always'].includes(classifier)) throw bad('x_eden.classifier is "off", "auto" or "always".', 'x_eden.classifier');
  const riskFlag = x.risk_aware !== undefined ? x.risk_aware : x.riskAware !== undefined ? x.riskAware : body.riskAware;
  if (riskFlag !== undefined && typeof riskFlag !== 'boolean') throw bad('x_eden.risk_aware must be a boolean.', 'x_eden.risk_aware');
  if (typeof riskFlag === 'boolean') out.riskAware = riskFlag;
  return { settings: out, providers, classifier };
}

/** The conversation: Eden's messages, the system text, the prompt the router reads, sizes, sampling & tools. */
export function conversation(body) {
  if (!Array.isArray(body.messages) || !body.messages.length) throw bad('messages must be a non-empty list.', 'messages');
  if (body.messages.length > MAX_MESSAGES) throw bad(`At most ${MAX_MESSAGES} messages.`, 'messages');
  if (body.n !== undefined && body.n !== 1) throw bad('n must be 1.', 'n');
  let tools = null;
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw bad('tools must be an array.', 'tools');
    tools = body.tools;
  } else if (Array.isArray(body.functions) && body.functions.length) {
    tools = body.functions.map((fn) => ({ type: 'function', function: fn }));
  }
  const system = [];
  const messages = [];
  let hasVision = false;
  let imageCount = 0;
  body.messages.forEach((m, i) => {
    if (!isObj(m)) throw bad(`messages[${i}] must be an object.`, `messages[${i}]`);
    const parsed = parseContentParts(m.content, i);
    if (parsed.hasVision) {
      hasVision = true;
      imageCount += parsed.attachments.filter((a) => a.kind === 'image').length;
    }
    if (m.role === 'system' || m.role === 'developer') system.push(parsed.text);
    else if (m.role === 'user' || m.role === 'assistant') {
      messages.push({
        role: m.role,
        content: parsed.text,
        ...(parsed.attachments.length ? { attachments: parsed.attachments } : {}),
        ...(Array.isArray(m.tool_calls) ? { tool_calls: m.tool_calls } : {}),
      });
    } else if (m.role === 'tool' || m.role === 'function') {
      messages.push({
        role: 'user',
        content: parsed.text ? `[tool_result ${m.tool_call_id || m.name || 'tool'}]\n${parsed.text}` : `[tool_result ${m.tool_call_id || m.name || 'tool'}]`,
      });
    } else throw bad(`messages[${i}].role must be system, developer, user, assistant, or tool.`, `messages[${i}].role`);
  });
  if (!messages.length || messages[messages.length - 1].role !== 'user') throw bad('The last message must be from the user or a tool result.', 'messages');
  const prompt = messages[messages.length - 1].content.trim() || '(multimodal message)';
  const chars = system.join('').length + messages.reduce((n, m) => n + m.content.length, 0);
  const inputTokens = Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN) + imageCount * 256);
  const max = body.max_completion_tokens ?? body.max_tokens;
  if (max !== undefined && max !== null && !(Number.isInteger(max) && max > 0)) throw bad('max_tokens must be a positive whole number.', 'max_tokens');
  if (body.temperature !== undefined && body.temperature !== null && (!Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) {
    throw bad('temperature must be a number between 0 and 2.', 'temperature');
  }
  if (body.top_p !== undefined && body.top_p !== null && (!Number.isFinite(body.top_p) || body.top_p < 0 || body.top_p > 1)) {
    throw bad('top_p must be a number between 0 and 1.', 'top_p');
  }
  return {
    messages,
    system: system.join('\n\n'),
    prompt,
    inputTokens,
    sessionTokens: Math.max(0, inputTokens - Math.ceil(prompt.length / CHARS_PER_TOKEN)),
    maxTokens: max || null,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    topP: typeof body.top_p === 'number' ? body.top_p : undefined,
    stop: body.stop !== undefined ? body.stop : undefined,
    seed: Number.isInteger(body.seed) ? body.seed : undefined,
    responseFormat: isObj(body.response_format) ? body.response_format : undefined,
    tools: tools && tools.length ? tools : undefined,
    toolChoice: body.tool_choice,
    hasVision,
  };
}

// ── routing ──

const routers = new Map();
function enrichRouteResult(res, req) {
  const withRel = (row) => (row ? { ...row, reliability: row.reliability ?? reliabilityFor(row.model) } : row);
  const rows = (res.rows || []).map(withRel);
  let pick = withRel(res.pick);
  let fallbacks = (res.fallbacks || []).map(withRel);
  const notes = [...(res.notes || [])];
  let risk = res.risk;
  if (req && req.riskAware && !risk && typeof req.prompt === 'string') {
    risk = assessRisk(req.prompt);
    if (risk && risk.action && risk.action.preferReliable) {
      const eligible = rows.filter((r) => r.eligible);
      const better = eligible
        .filter(
          (r) =>
            r.model !== pick.model &&
            r.quality >= pick.quality - 4 &&
            r.costUSD <= Math.max(pick.costUSD * 2.5, 0.005) &&
            r.reliability - pick.reliability >= 3,
        )
        .sort((a, b) => b.reliability - a.reliability || b.quality - a.quality)[0];
      if (better) {
        notes.push(`reliability pick: ${better.model} (${better.reliability}) over ${pick.model} (${pick.reliability}) for ${risk.level} hallucination risk`);
        pick = { ...pick, ...better };
        fallbacks = eligible.filter((r) => r.model !== pick.model).slice(0, 3);
      }
    }
  }
  return { ...res, pick, fallbacks, rows, notes, ...(risk ? { risk } : {}) };
}

function buildRouterWrapper(ids, maxEffort, pin = null) {
  const base = createLocalRouter({ models: ids, efforts: (m) => (pin ? [pin] : effortsFor(m, maxEffort)) });
  const toStage = (row, role, req, res) => {
    const model = modelOf(row.model);
    const request = row.request || (res && res.pick && res.pick.model === row.model ? res.pick.request : base.routeSync({ ...req, prompt: req.prompt }).pick.request);
    return {
      role,
      model,
      provider: model.provider,
      effort: row.effort,
      request,
      row: {
        quality: row.quality,
        reliability: row.reliability ?? reliabilityFor(row.model),
        cost: { total: row.costUSD },
      },
    };
  };
  return {
    ...base,
    routeSync(req) {
      return enrichRouteResult(base.routeSync(req), req);
    },
    async route(req) {
      return enrichRouteResult(await base.route(req), req);
    },
    assessRisk(promptText) {
      return typeof base.assessRisk === 'function' ? base.assessRisk(promptText) : assessRisk(promptText);
    },
    failoverChain(req) {
      if (typeof base.failoverChain === 'function') return base.failoverChain(req);
      const res = this.routeSync(req);
      const seen = new Set([res.pick.provider]);
      const chain = [toStage(res.pick, 'primary', req, res)];
      for (const r of res.rows || []) {
        if (!r.eligible || seen.has(r.provider)) continue;
        seen.add(r.provider);
        chain.push(toStage(r, 'failover', req, res));
      }
      return chain;
    },
    planCascade(req) {
      if (typeof base.planCascade === 'function') return base.planCascade(req);
      const res = this.routeSync(req);
      const primary = res.pick;
      const risk = res.risk || assessRisk(req.prompt);
      const verifierStage = toStage(primary, 'verifier', req, res);
      if (risk && risk.level === 'high') {
        return {
          useCascade: false,
          stages: [verifierStage],
          acceptanceProbability: 1,
          expectedCostUSD: primary.costUSD,
          expectedSavingsFraction: 0,
          rationale: `Direct to ${primary.name}: speculative cascade disabled on high hallucination-risk task (${(risk.reasons || []).join(', ')}).`,
        };
      }
      const eligible = (res.rows || []).filter((r) => r.eligible);
      const drafter = eligible
        .filter((r) => r.model !== primary.model && r.tier !== 'frontier' && r.costUSD <= primary.costUSD * 0.25 && r.quality >= Math.max(60, primary.quality - 18))
        .sort((a, b) => b.quality / Math.max(b.costUSD, 1e-6) - a.quality / Math.max(a.costUSD, 1e-6))[0];
      if (!drafter) {
        return {
          useCascade: false,
          stages: [verifierStage],
          acceptanceProbability: 1,
          expectedCostUSD: primary.costUSD,
          expectedSavingsFraction: 0,
          rationale: `Direct to ${primary.name}: primary pick is already optimal for cost and quality.`,
        };
      }
      const acceptanceProbability = Math.round(Math.min(0.95, Math.max(0.3, (drafter.quality / 100) * (risk && risk.level === 'elevated' ? 0.85 : 1))) * 100) / 100;
      const expectedCostUSD = drafter.costUSD + (1 - acceptanceProbability) * primary.costUSD;
      const expectedSavingsFraction = Math.round(Math.max(0, 1 - expectedCostUSD / Math.max(primary.costUSD, 1e-9)) * 1000) / 1000;
      if (expectedSavingsFraction < 0.25) {
        return {
          useCascade: false,
          stages: [verifierStage],
          acceptanceProbability: 1,
          expectedCostUSD: primary.costUSD,
          expectedSavingsFraction: 0,
          rationale: `Direct to ${primary.name}: drafter saves less than 25% expected cost.`,
        };
      }
      return {
        useCascade: true,
        stages: [toStage(drafter, 'drafter', req, res), verifierStage],
        acceptanceProbability,
        expectedCostUSD,
        expectedSavingsFraction,
        rationale: `Cascade ${drafter.name} → ${primary.name} (~${Math.round(acceptanceProbability * 100)}% acceptance, ${Math.round(expectedSavingsFraction * 100)}% expected savings).`,
      };
    },
    routeBatch(prompts, opts = {}) {
      if (typeof base.routeBatch === 'function') return base.routeBatch(prompts, opts);
      const results = prompts.map((p) => this.routeSync({ prompt: p, ...opts }));
      const picks = results.map((r) => r.pick);
      let totalCostUSD = picks.reduce((s, p) => s + p.costUSD, 0);
      let budgetAdjusted = false;
      if (typeof opts.maxTotalCostUSD === 'number' && totalCostUSD > opts.maxTotalCostUSD) {
        while (totalCostUSD > opts.maxTotalCostUSD + 1e-12) {
          let bestIdx = -1;
          let bestAlt = null;
          let bestRatio = Infinity;
          for (let i = 0; i < results.length; i++) {
            const cur = picks[i];
            for (const alt of (results[i].rows || []).filter((r) => r.eligible && r.costUSD < cur.costUSD - 1e-9)) {
              const ratio = Math.max(0, cur.quality - alt.quality) / (cur.costUSD - alt.costUSD);
              if (ratio < bestRatio) {
                bestRatio = ratio;
                bestIdx = i;
                bestAlt = alt;
              }
            }
          }
          if (bestIdx < 0 || !bestAlt) break;
          totalCostUSD -= picks[bestIdx].costUSD - bestAlt.costUSD;
          picks[bestIdx] = bestAlt;
          budgetAdjusted = true;
        }
      }
      const decisions = picks.map((p, i) => toStage(p, 'primary', { prompt: prompts[i], ...opts }, results[i]));
      const n = decisions.length || 1;
      return {
        decisions,
        totalCostUSD,
        averageQuality: Math.round((decisions.reduce((s, d) => s + d.row.quality, 0) / n) * 10) / 10,
        averageReliability: Math.round((decisions.reduce((s, d) => s + d.row.reliability, 0) / n) * 10) / 10,
        budgetAdjusted,
      };
    },
  };
}

function routerOver(ids, maxEffort, pin = null) {
  const key = `${ids.join(',')}|${maxEffort}|${pin || ''}`;
  let r = routers.get(key);
  if (!r) {
    r = buildRouterWrapper(ids, maxEffort, pin);
    routers.set(key, r);
    if (routers.size > 64) routers.delete(routers.keys().next().value);
  }
  return r;
}

/** The models the router may pick for this request: the site's hosted set, on the providers there are keys for. */
export function poolFor(env, have, wanted, client = null) {
  const cfg = hostedConfig(env);
  const allowedProviders = client && Array.isArray(client.providers) && client.providers.length ? client.providers : null;
  const allowedModels = client && Array.isArray(client.models) && client.models.length ? client.models : null;
  const maxEffort = client && client.max_effort ? client.max_effort : cfg.maxEffort;
  const models = autoModels(cfg.models).filter(
    (m) =>
      API_PROVIDERS.includes(m.provider) &&
      have.includes(m.provider) &&
      (!wanted || wanted.includes(m.provider)) &&
      (!allowedProviders || allowedProviders.includes(m.provider)) &&
      (!allowedModels || allowedModels.includes(m.id)),
  );
  return { ...cfg, maxEffort, models };
}

/** The decision (the router's RouteResult) and the classifier's cost; ApiError 422 when nothing fits. */
async function decide(cfg, conv, route, keys, base) {
  const hints =
    conv.hasVision || conv.tools
      ? {
          ...(conv.hasVision ? { hasVision: true } : {}),
          ...(conv.tools ? { hasToolUse: true } : {}),
        }
      : undefined;
  const extras = {
    ...route.settings,
    ...(conv.sessionTokens > 0 ? { context: { sessionTokens: conv.sessionTokens } } : {}),
    ...(hints ? { hints } : {}),
  };
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
  let request = (requestMaxOutputTokens(pick.request) || 0) === cap ? pick.request : capRequest(withMaxOutputTokens(pick.request, cap), cap);
  if (conv.temperature !== undefined || conv.topP !== undefined || conv.stop !== undefined || conv.seed !== undefined || conv.responseFormat !== undefined || conv.tools !== undefined) {
    const params = { ...(request.params || {}) };
    if (request.provider === 'gemini') {
      const gcfg = { ...(params.config || {}) };
      if (conv.temperature !== undefined) gcfg.temperature = conv.temperature;
      if (conv.topP !== undefined) gcfg.topP = conv.topP;
      if (conv.stop !== undefined) gcfg.stopSequences = Array.isArray(conv.stop) ? conv.stop : [conv.stop];
      if (conv.seed !== undefined) gcfg.seed = conv.seed;
      params.config = gcfg;
    } else if (request.provider === 'anthropic') {
      const hasThinking = Boolean(params.thinking && typeof params.thinking === 'object');
      if (conv.temperature !== undefined && !hasThinking) params.temperature = conv.temperature;
      if (conv.topP !== undefined && !hasThinking) params.top_p = conv.topP;
      if (conv.stop !== undefined) params.stop_sequences = Array.isArray(conv.stop) ? conv.stop : [conv.stop];
    } else {
      const hasReasoning = typeof params.reasoning_effort === 'string' && params.reasoning_effort !== 'none';
      if (conv.temperature !== undefined && (!hasReasoning || request.provider !== 'openai')) params.temperature = conv.temperature;
      if (conv.topP !== undefined && (!hasReasoning || request.provider !== 'openai')) params.top_p = conv.topP;
      if (conv.stop !== undefined) params.stop = conv.stop;
      if (conv.seed !== undefined) params.seed = conv.seed;
      if (conv.responseFormat !== undefined) params.response_format = conv.responseFormat;
      if (conv.tools !== undefined) params.tools = conv.tools;
      if (conv.toolChoice !== undefined) params.tool_choice = conv.toolChoice;
    }
    request = { ...request, params };
  }
  return { model, pick, request };
}

const decisionInfo = (result, cfg, route) => ({
  level: result.optimization && result.optimization.level ? result.optimization.level.level : route.settings.level,
  efficiency: result.optimization ? result.optimization.efficiency : null,
  performance: result.optimization ? result.optimization.performance : null,
  task: result.task ? { complexity: result.task.complexity, signals: result.task.signals || [] } : null,
  ...(result.risk ? { risk: result.risk } : {}),
  pool: cfg.models.map((m) => m.id),
});

// ── the handler ──

/** /v1/* on edenrouter.com. */
export async function routerApi(request, env, ctx, path) {
  try {
    if (request.headers.get('origin')) throw fail(403, 'no_browsers', 'The Eden Router API is server to server: requests from a web page (with an Origin) are refused.');
    if (request.method === 'OPTIONS') throw fail(405, 'method', 'No CORS: call the API from a server.');
    const endpoint = {
      '/v1/health': 'GET',
      '/v1/openapi.json': 'GET',
      '/v1/chat/completions': 'POST',
      '/v1/route': 'POST',
      '/v1/route/failover': 'POST',
      '/v1/route/cascade': 'POST',
      '/v1/route/batch': 'POST',
      '/v1/analyze': 'POST',
      '/v1/risk': 'POST',
      '/v1/models': 'GET',
      '/v1/usage': 'GET',
    }[path];
    if (!endpoint) throw fail(404, 'not_found', `No route ${path.slice(0, 64)}. See https://edenrouter.com for the API.`);
    if (request.method !== endpoint) throw fail(405, 'method', `${path} takes ${endpoint}.`);
    if (path === '/v1/health') {
      return json({
        object: 'eden.health',
        status: 'ok',
        version: '2.0.0',
        active_models: MODELS.length,
        providers: API_PROVIDERS,
      });
    }
    if (path === '/v1/openapi.json') {
      const origin = new URL(request.url).origin;
      return json({
        openapi: '3.1.0',
        info: {
          title: 'Eden Router v2 API',
          version: '2.0.0',
          summary: 'OpenAI-compatible cost-optimal and hallucination-aware LLM router API.',
        },
        servers: [{ url: origin }],
        paths: {
          '/v1/chat/completions': { post: { summary: 'OpenAI-compatible routed chat completions' } },
          '/v1/route': { post: { summary: 'Route a prompt or conversation without calling the provider' } },
          '/v1/route/failover': { post: { summary: 'Provider-diverse failover chain' } },
          '/v1/route/cascade': { post: { summary: 'Two-stage speculative drafter -> verifier cascade plan' } },
          '/v1/route/batch': { post: { summary: 'Budget-constrained batch routing' } },
          '/v1/analyze': { post: { summary: 'Deterministic task analysis and risk assessment' } },
          '/v1/risk': { post: { summary: 'Hallucination risk assessment and reliable model ranking' } },
          '/v1/models': { get: { summary: 'List router model levels' } },
          '/v1/usage': { get: { summary: 'Inspect client usage and daily spend' } },
          '/v1/health': { get: { summary: 'Service health check' } },
        },
      });
    }
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
    const kindMap = {
      '/v1/chat/completions': 'chat',
      '/v1/route': 'route',
      '/v1/route/failover': 'failover',
      '/v1/route/cascade': 'cascade',
      '/v1/route/batch': 'batch',
      '/v1/analyze': 'analyze',
      '/v1/risk': 'risk',
    };
    const kind = kindMap[path] || 'chat';
    const started = Date.now();
    const record = (entry, heldUsd = 0) =>
      store(env, 'record', { id: client.id, held_usd: heldUsd, entry: { kind, latency_ms: Date.now() - started, ...entry } }).catch(() => null);
    try {
      if (path === '/v1/analyze') return await routeAnalyze(request, env, client, record);
      if (path === '/v1/risk') return await routeRisk(request, env, client, record);
      if (path === '/v1/route') return await routeOnly(request, env, client, record);
      if (path === '/v1/route/failover') return await routeFailover(request, env, client, record);
      if (path === '/v1/route/cascade') return await routeCascade(request, env, client, record);
      if (path === '/v1/route/batch') return await routeBatchEndpoint(request, env, client, record);
      return await completions(request, env, ctx, client, admitted.spent_today_usd, record);
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

/** POST /v1/analyze: deterministic task profile and hallucination risk assessment. */
async function routeAnalyze(request, env, client, record) {
  const body = await readBody(request);
  const conv = body.messages ? conversation(body) : { prompt: String(body.prompt || '').trim(), sessionTokens: 0 };
  if (!conv.prompt) throw bad('Provide messages or prompt.', 'prompt');
  const cfg = poolFor(env, API_PROVIDERS, null, client);
  const r = routerOver(cfg.models.map((m) => m.id), cfg.maxEffort);
  const res = r.routeSync({ prompt: conv.prompt, riskAware: true });
  const risk = res.risk || assessRisk(conv.prompt);
  await record({ model: res.pick.model, provider: res.pick.provider, effort: res.pick.effort, tokens_in: Math.ceil(conv.prompt.length / CHARS_PER_TOKEN), cost_usd: 0, estimated_usd: 0, status: 200 });
  return json({
    object: 'eden.analyze',
    task: res.task || null,
    risk,
  });
}

/** POST /v1/risk: hallucination risk assessment and reliable model ranking. */
async function routeRisk(request, env, client, record) {
  const body = await readBody(request);
  const conv = body.messages ? conversation(body) : { prompt: String(body.prompt || '').trim(), sessionTokens: 0 };
  if (!conv.prompt) throw bad('Provide messages or prompt.', 'prompt');
  const risk = assessRisk(conv.prompt, isObj(body.context) ? body.context : undefined);
  const cfg = poolFor(env, API_PROVIDERS, null, client);
  const topReliableModels = [...cfg.models]
    .map((m) => ({ id: m.id, name: m.name, provider: m.provider, reliability: reliabilityFor(m.id) }))
    .sort((a, b) => b.reliability - a.reliability)
    .slice(0, 5);
  await record({ model: topReliableModels[0]?.id || null, provider: topReliableModels[0]?.provider || null, tokens_in: Math.ceil(conv.prompt.length / CHARS_PER_TOKEN), cost_usd: 0, estimated_usd: 0, status: 200 });
  return json({
    object: 'eden.risk',
    risk,
    top_reliable_models: topReliableModels,
    topReliableModels,
  });
}

/** POST /v1/route: the decision only. Providers: those with a key sent, else x_eden.providers, else all four. */
async function routeOnly(request, env, client, record) {
  const body = await readBody(request);
  const route = routeSettings(body);
  const conv = body.messages
    ? conversation(body)
    : (() => {
        const p = String(body.prompt || '').trim();
        if (!p) throw bad('messages must be a non-empty list (or pass prompt).', 'messages');
        const tok = Math.max(1, Math.ceil(p.length / CHARS_PER_TOKEN));
        return { messages: [{ role: 'user', content: p }], system: '', prompt: p, inputTokens: tok, sessionTokens: 0, maxTokens: null };
      })();
  const keys = providerKeys(request, env, client);
  const have = Object.keys(keys).length ? Object.keys(keys) : route.providers || API_PROVIDERS;
  const cfg = poolFor(env, have, route.providers, client);
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
      reliability: first.pick.reliability ?? 75,
      rationale: first.pick.rationale || '',
      warnings: first.pick.warnings || [],
      request: first.request,
      fallbacks: (result.fallbacks || []).slice(0, 3).map((f) => ({ model: f.model, provider: f.provider, effort: f.effort, estimated_cost_usd: round6(f.costUSD), quality: f.quality, reliability: f.reliability ?? 75 })),
      classifier: { mode: route.classifier, used: Boolean(result.classification && result.classification.used), cost_usd: round6(ratingUSD) },
      ...decisionInfo(result, cfg, route),
    },
  });
}

/** POST /v1/route/failover: provider-diverse high-availability failover chain. */
async function routeFailover(request, env, client, record) {
  const body = await readBody(request);
  const route = routeSettings({ model: body.model || 'eden-router', x_eden: body.x_eden });
  const conv = body.messages ? conversation(body) : { prompt: String(body.prompt || '').trim(), sessionTokens: 0 };
  if (!conv.prompt) throw bad('Provide messages or prompt.', 'prompt');
  const keys = providerKeys(request, env, client);
  const have = Object.keys(keys).length ? Object.keys(keys) : route.providers || API_PROVIDERS;
  const cfg = poolFor(env, have, route.providers, client);
  if (!cfg.models.length) throw bad('None of the providers in x_eden.providers has a key here.', 'x_eden.providers');
  const r = routerOver(cfg.models.map((m) => m.id), cfg.maxEffort);
  const chain = r.failoverChain({ prompt: conv.prompt, ...route.settings });
  const top = chain[0];
  if (top) await record({ model: top.model.id, provider: top.model.provider, effort: top.effort, cost_usd: 0, estimated_usd: top.row.cost.total, status: 200 });
  return json({
    object: 'eden.route.failover',
    chain: chain.map((target, idx) => ({
      rank: idx + 1,
      model: target.model.id,
      name: target.model.name,
      provider: target.model.provider,
      effort: target.effort,
      quality: Math.round(target.row.quality * 10) / 10,
      reliability: Math.round((target.row.reliability ?? 75) * 10) / 10,
      estimated_cost_usd: round6(target.row.cost.total),
      request: target.request,
    })),
  });
}

/** POST /v1/route/cascade: 2-stage speculative cascade plan with high-risk safeguard. */
async function routeCascade(request, env, client, record) {
  const body = await readBody(request);
  const route = routeSettings({ model: body.model || 'eden-router', x_eden: body.x_eden });
  const conv = body.messages ? conversation(body) : { prompt: String(body.prompt || '').trim(), sessionTokens: 0 };
  if (!conv.prompt) throw bad('Provide messages or prompt.', 'prompt');
  const keys = providerKeys(request, env, client);
  const have = Object.keys(keys).length ? Object.keys(keys) : route.providers || API_PROVIDERS;
  const cfg = poolFor(env, have, route.providers, client);
  if (!cfg.models.length) throw bad('None of the providers in x_eden.providers has a key here.', 'x_eden.providers');
  const r = routerOver(cfg.models.map((m) => m.id), cfg.maxEffort);
  const plan = r.planCascade({ prompt: conv.prompt, ...route.settings });
  const top = plan.stages[0];
  const verifier = plan.stages[plan.stages.length - 1];
  if (top) await record({ model: top.model.id, provider: top.model.provider, effort: top.effort, cost_usd: 0, estimated_usd: plan.expectedCostUSD, status: 200 });
  return json({
    object: 'eden.route.cascade',
    use_cascade: plan.useCascade,
    acceptance_probability: plan.acceptanceProbability,
    expected_cost_usd: round6(plan.expectedCostUSD),
    direct_cost_usd: round6(verifier ? verifier.row.cost.total : plan.expectedCostUSD),
    expected_savings_pct: Math.round((plan.expectedSavingsFraction || 0) * 1000) / 10,
    rationale: plan.rationale,
    stages: plan.stages.map((s) => ({
      role: s.role,
      model: s.model.id,
      provider: s.model.provider,
      effort: s.effort,
      quality: Math.round(s.row.quality * 10) / 10,
      reliability: Math.round((s.row.reliability ?? 75) * 10) / 10,
      estimated_cost_usd: round6(s.row.cost.total),
      request: s.request,
    })),
  });
}

/** POST /v1/route/batch: budget-constrained batch routing. */
async function routeBatchEndpoint(request, env, client, record) {
  const body = await readBody(request);
  if (!Array.isArray(body.prompts) || !body.prompts.length || body.prompts.length > 256) {
    throw bad('prompts must be an array of 1 to 256 strings.', 'prompts');
  }
  const route = routeSettings({ model: body.model || 'eden-router', x_eden: body.x_eden });
  const keys = providerKeys(request, env, client);
  const have = Object.keys(keys).length ? Object.keys(keys) : route.providers || API_PROVIDERS;
  const cfg = poolFor(env, have, route.providers, client);
  if (!cfg.models.length) throw bad('None of the providers in x_eden.providers has a key here.', 'x_eden.providers');
  const r = routerOver(cfg.models.map((m) => m.id), cfg.maxEffort);
  const maxTotalCostRaw = body.max_total_cost_usd !== undefined ? body.max_total_cost_usd : body.maxTotalCostUSD;
  const maxTotalCostUSD = typeof maxTotalCostRaw === 'number' ? maxTotalCostRaw : undefined;
  const batch = r.routeBatch(body.prompts.map(String), { maxTotalCostUSD, ...route.settings });
  await record({ model: 'batch', provider: 'eden', effort: 'mixed', cost_usd: 0, estimated_usd: round6(batch.totalCostUSD), status: 200 });
  return json({
    object: 'eden.route.batch',
    count: batch.decisions.length,
    total_estimated_cost_usd: round6(batch.totalCostUSD),
    average_quality: batch.averageQuality,
    average_reliability: batch.averageReliability,
    budget_adjusted: batch.budgetAdjusted,
    decisions: batch.decisions.map((d, index) => ({
      index,
      model: d.model.id,
      provider: d.model.provider,
      effort: d.effort,
      quality: Math.round(d.row.quality * 10) / 10,
      reliability: Math.round((d.row.reliability ?? 75) * 10) / 10,
      estimated_cost_usd: round6(d.row.cost.total),
      request: d.request,
    })),
  });
}

const pickInfo = (c) => ({ model: c.model.id, name: c.model.name, provider: c.model.provider, provider_name: PROVIDER_NAMES[c.model.provider], effort: c.pick.effort, effort_label: effortLabel(c.pick.effort), reliability: c.pick.reliability ?? 75 });

/** POST /v1/chat/completions. */
async function completions(request, env, ctx, client, spentToday, record) {
  const body = await readBody(request);
  const route = routeSettings(body);
  const conv = conversation(body);
  const stream = body.stream === true;
  const includeUsage = Boolean(isObj(body.stream_options) && body.stream_options.include_usage);
  const keys = providerKeys(request, env, client);
  if (!Object.keys(keys).length) throw bad(`Send at least one provider key: ${Object.values(KEY_HEADERS).join(', ')}. The router picks only among providers you send a key for.`);
  const cfg = poolFor(env, Object.keys(keys), route.providers, client);
  if (!cfg.models.length) throw bad('None of the providers in x_eden.providers has a key in this request.', 'x_eden.providers');
  const base = devProviderBase(env, request);
  const { result, extras, ratingUSD } = await decide(cfg, conv, route, keys, base);
  const first = candidate(cfg, conv, extras, result.pick, result);
  const estimatedHoldUSD = round6(first.pick.costUSD + ratingUSD);
  if (spentToday + estimatedHoldUSD > client.daily_usd) {
    throw fail(429, 'daily_spend_cap', `Daily spend cap reached: $${client.daily_usd} a day (spent $${round6(spentToday)} today, UTC). Ask Eden to raise it, or try again tomorrow.`);
  }
  await store(env, 'hold', { id: client.id, estimated_usd: estimatedHoldUSD });
  let holdReconciled = false;
  const recordWithHoldRelease = async (entryObj) => {
    holdReconciled = true;
    return record(entryObj, estimatedHoldUSD);
  };
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
    try {
      const out = await run(() => {});
      if (out.r.failure) {
        await recordWithHoldRelease({ ...entry(out, 502), status: upstream(out.r).status });
        throw upstream(out.r);
      }
      const latency = Date.now() - t0;
      await recordWithHoldRelease(entry(out, 200));
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
    } finally {
      if (!holdReconciled) await store(env, 'release', { id: client.id, held_usd: estimatedHoldUSD }).catch(() => null);
    }
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
    try {
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
          await recordWithHoldRelease({ ...entry(out, 502), status: upstream(out.r).status });
          firstText(upstream(out.r));
          return;
        }
        began = true;
        firstText(null);
        send(chunk(out.used.model.id, { role: 'assistant', content: '' }));
      }
      if (out.r.failure && !out.r.stopped) {
        send({ error: { message: out.r.failure, type: 'api_error', param: null, code: 'provider_error' } });
        await recordWithHoldRelease(entry(out, 502));
      } else {
        send(chunk(out.used.model.id, {}, finishOf(out.r), { x_eden: xEden(out, latency) }));
        if (includeUsage) send({ id, object: 'chat.completion.chunk', created, model: out.used.model.id, system_fingerprint: null, choices: [], usage: usageOf(out.r) });
        send('[DONE]');
        await recordWithHoldRelease(entry(out, out.r.stopped ? 499 : 200));
      }
      open = false;
      await writer.close().catch(() => {});
    } finally {
      if (!holdReconciled) await store(env, 'release', { id: client.id, held_usd: estimatedHoldUSD }).catch(() => null);
    }
  })().catch(async () => {
    if (!holdReconciled) await store(env, 'release', { id: client.id, held_usd: estimatedHoldUSD }).catch(() => null);
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
