// Chat through the owner's Mac (docs/accounts.md "Chat through the Mac"; docs/web-auth.md).
//
// When askeden.com has no provider key for a turn (or EDEN_CHAT_VIA_MAC = "1"), hosted Eden's
// turns (POST /api/chat/send), routing preview (POST /api/route) and model list (GET
// /api/chat/meta) are Eden's on the owner's Mac, through its web relay (accounts/webrelay.js):
// the Mac's models, on the owner's own keys or Claude subscription. A subscription serves only
// its owner, so this path is the account owner's own browsers only: never a delegate or a team
// space member (refused here, again in the account's object, and again on the Mac, which lets a
// non-private turn through only when the relay marks it `owner`). Nothing is counted on the
// included AI. Streaming and Stop are the relay's, as for privacy mode.
//
// chat.js keeps one decision point per route: `if (viaMacFor(env, who)) → viaMac…`.

import { ApiError } from '../accounts/util.js';
import { MAC_OFFLINE, WEB_RELAY, askMac, macStatus } from '../accounts/webrelay.js';
import { DEFAULT_CLASSIFIER_MODEL } from './vendor/model-router.js';

export const VIA_MAC_LABEL = 'via your Mac (Claude Max)';
export const VIA_MAC_OFFLINE = 'Your Mac is offline. Eden on askeden.com answers through your Mac until an Anthropic API key is added.';
export const VIA_MAC_NEEDS_MAC =
  'No Mac is linked to your account. Eden on askeden.com answers through your Mac until an Anthropic API key is added: in J.A.R.V.I.S. on your Mac, open Settings › Account and link it.';
export const VIA_MAC_OWNER_ONLY =
  'Eden here answers through its owner’s Mac, on their own Claude subscription, which serves only them. Delegates and team spaces need an Anthropic API key on askeden.com.';
export const VIA_MAC_COMPARE = 'Compare needs an Anthropic API key on askeden.com. Until one is added, Eden here answers through your Mac, one model at a time.';
const NEEDS_MAC = 'Needs your Mac. No Mac is linked to your account.';
const ACTING_NO_MAC = 'Not while you’re using someone else’s Eden: their Mac stays theirs. Switch back to use your own.';

const STATUS_WAIT_MS = 8_000; // meta and the preview don't wait long for the Mac
const PROVIDER_IDS = ['anthropic', 'openai', 'gemini', 'kimi'];
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const NO_LOCAL = { available: false, viaMac: true, models: [], servers: [] };
const utf8 = new TextEncoder();
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const capText = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');

/**
 * Whether this asker's chat goes through the Mac: the Worker has no usable provider key for it
 * (`hasKeys`, by default an Anthropic key; the caller may say for the providers it routes among),
 * or EDEN_CHAT_VIA_MAC = "1". Who may then use it (the owner only) and whether the Mac is online
 * are checked by viaMacTurn, viaMacRoute and viaMacMeta, which say why not in words.
 */
export function viaMacFor(env = {}, _who = null, { hasKeys = Boolean(env.ANTHROPIC_API_KEY) } = {}) {
  return env.EDEN_CHAT_VIA_MAC === '1' || !hasKeys;
}

/** POST /api/route through the Mac: its router's preview, passed on. */
export const viaMacRoute = (request, env, ctx, who) => throughMac(request, env, ctx, who, '/api/route', { wait: STATUS_WAIT_MS });

/** The Mac's local models, only what the page shows (no addresses on the Mac). */
function cleanLocal(body) {
  if (!isObj(body) || typeof body.available !== 'boolean') return { ...NO_LOCAL, reason: 'Eden on your Mac couldn’t tell which local models it has.' };
  const list = (v) => (Array.isArray(v) ? v.filter(isObj).slice(0, 50) : []);
  return {
    available: body.available,
    viaMac: true,
    reason: body.available ? null : capText(body.reason) || 'No local model is running on your Mac.',
    models: list(body.models).map((m) => ({ id: capText(m.id), server: capText(m.server, 40), serverName: capText(m.serverName, 80) })).filter((m) => m.id),
    servers: list(body.servers).map((v) => ({ id: capText(v.id, 40), name: capText(v.name, 80), available: v.available === true, models: (Array.isArray(v.models) ? v.models.slice(0, 50) : []).map((x) => capText(x)).filter(Boolean), reason: capText(v.reason) || null })),
  };
}

/** A refusal from the Mac's link, in chat-through-the-Mac words. */
function viaMacError(error) {
  if (error instanceof ApiError && error.code === 'mac_offline') return new ApiError(503, 'mac_offline', VIA_MAC_OFFLINE);
  if (error instanceof ApiError && error.code === 'needs_mac') return new ApiError(503, 'needs_mac', VIA_MAC_NEEDS_MAC);
  return error;
}

/** The request, answered by Eden on the owner's Mac (the owner only); its answer passes through. */
async function throughMac(request, env, ctx, who, target, opts = {}) {
  if (who.grant) throw new ApiError(403, 'owner_only', VIA_MAC_OWNER_ONLY);
  try {
    return await askMac(request, env, ctx, who, target, opts);
  } catch (error) {
    throw viaMacError(error);
  }
}

/**
 * One turn through the Mac: Eden's own POST /api/chat/send there (any model it has, on the owner's
 * keys or Claude subscription), streamed back as it comes; Stop reaches the Mac as for privacy
 * mode. No allowance is asked or spent. Each route event says it ran on the Mac.
 */
export async function viaMacTurn(request, env, ctx, who, raw) {
  if (who.grant) throw new ApiError(403, 'owner_only', VIA_MAC_OWNER_ONLY);
  const body = utf8.encode(JSON.stringify(raw));
  if (body.byteLength > WEB_RELAY.body) throw new ApiError(413, 'too_big', 'This chat is too big to send to your Mac (10 MB at most, attachments included). Start a new chat, or use Eden on your Mac.');
  const response = await throughMac(request, env, ctx, who, '/api/chat/send', { body });
  if (!response.ok || !response.body || !/^text\/event-stream\b/i.test(response.headers.get('content-type') || '')) return response;
  return new Response(response.body.pipeThrough(labelRoutes()), { status: response.status, headers: response.headers });
}

/** A route event as it leaves for the page: where it ran says "via your Mac". */
export function macRouteEvent(route) {
  if (!isObj(route)) return route;
  const cli = route.via === 'claude-cli' || route.via === 'claude-code';
  const where = isObj(route.where) ? route.where : null;
  const place = where && (where.place === 'mac' || where.place === 'phone') ? where.place : 'cloud';
  const label = place === 'mac' ? where.label : cli ? VIA_MAC_LABEL : `${(where && capText(where.label, 60)) || 'Cloud'}, via your Mac`;
  const note = cli ? 'Answered by Eden on your Mac, on your Claude subscription: nothing counted on askeden.com.' : 'Answered by Eden on your Mac: nothing counted on askeden.com.';
  return { ...route, viaMac: VIA_MAC_LABEL, where: { ...(where || {}), place, label }, notes: [...(Array.isArray(route.notes) ? route.notes : []), note] };
}

/** The Mac's server-sent events, with each `route` event labelled (macRouteEvent); the rest as they come. */
export function labelRoutes() {
  const decoder = new TextDecoder();
  let held = '';
  const label = (block) => {
    const lines = block.split('\n');
    if (lines[0] !== 'event: route') return block;
    const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    try {
      return `event: route\ndata: ${JSON.stringify(macRouteEvent(JSON.parse(data)))}`;
    } catch {
      return block;
    }
  };
  return new TransformStream({
    transform(chunk, controller) {
      held += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
      let at;
      let out = '';
      while ((at = held.indexOf('\n\n')) >= 0) {
        out += `${label(held.slice(0, at))}\n\n`;
        held = held.slice(at + 2);
      }
      if (out) controller.enqueue(utf8.encode(out));
    },
    flush(controller) {
      held += decoder.decode();
      if (held) controller.enqueue(utf8.encode(label(held)));
    },
  });
}

const textOr = (v, n = 200) => capText(v, n) || null;

/** The Mac's meta, as hosted Eden passes it on: only what the page shows, nothing of the Mac's paths. */
function cleanMacMeta(body) {
  const list = (v, n = 100) => (Array.isArray(v) ? v.filter(isObj).slice(0, n) : []);
  const providers = list(body.providers, 10)
    .filter((p) => PROVIDER_IDS.includes(p.id))
    .map((p) => ({ id: p.id, name: capText(p.name, 60) || p.id, available: p.available === true, via: textOr(p.via, 40), reason: textOr(p.reason) }));
  const models = list(body.models, 200)
    .map((m) => ({
      id: capText(m.id, 100),
      name: capText(m.name, 100),
      provider: capText(m.provider, 20),
      tier: capText(m.tier, 20),
      efforts: (Array.isArray(m.efforts) ? m.efforts : []).filter((e) => EFFORTS.includes(e)),
      defaultEffort: EFFORTS.includes(m.defaultEffort) ? m.defaultEffort : null,
      available: m.available === true,
      vision: m.vision === true,
    }))
    .filter((m) => m.id && providers.some((p) => p.id === m.provider));
  const flag = (v) => (isObj(v) ? { available: v.available === true, reason: textOr(v.reason), ...(v.approval === 'waiting' ? { approval: 'waiting' } : {}) } : { available: false, reason: 'Eden on your Mac couldn’t tell.' });
  const c = isObj(body.classifier) ? body.classifier : {};
  const search = isObj(body.search) ? body.search : {};
  return {
    providers,
    models,
    classifier: { mode: ['off', 'always', 'auto', 'ambiguous'].includes(c.mode) ? c.mode : 'off', available: c.available === true, reason: textOr(c.reason), model: capText(c.model, 100) || DEFAULT_CLASSIFIER_MODEL },
    search: { available: search.available === true, via: textOr(search.via, 40) },
    jarvis: flag(body.jarvis),
    code: { ...flag(body.code), via: 'your Mac' },
  };
}

/**
 * GET /api/chat/meta through the Mac: the Mac's providers and models (so the model menu is the
 * Mac's), Jarvis, Code and privacy mode's local models as it has them; offline or for anyone but
 * the owner, nothing to pick and why.
 */
export async function viaMacMeta(m, request, env, ctx, who) {
  m.hosted = { ...m.hosted, viaMac: true };
  const none = (reason) => {
    m.providers = m.providers.map((p) => ({ ...p, available: false, via: null, reason }));
    m.models = m.models.map((x) => ({ ...x, available: false }));
    m.search = { available: false, via: null, reason };
    m.scope = reason;
    return m;
  };
  if (who.grant) {
    m.jarvis = m.code = { available: false, reason: ACTING_NO_MAC };
    m.local = { ...NO_LOCAL, reason: ACTING_NO_MAC };
    return none(VIA_MAC_OWNER_ONLY);
  }
  const mac = await macStatus(env, who);
  if (!mac.online) {
    const reason = mac.macs ? VIA_MAC_OFFLINE : VIA_MAC_NEEDS_MAC;
    m.jarvis = m.code = { available: false, reason: mac.macs ? MAC_OFFLINE : NEEDS_MAC };
    m.local = { ...NO_LOCAL, reason };
    return none(reason);
  }
  let body = null;
  let why = 'Eden on your Mac couldn’t tell which models it has.';
  try {
    const response = await askMac(new Request(request.url, { method: 'GET', headers: request.headers }), env, ctx, who, '/api/chat/meta', { wait: STATUS_WAIT_MS });
    body = await response.json().catch(() => null);
    if (!response.ok || !isObj(body)) {
      why = capText(body && body.error) || why;
      body = null;
    }
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    why = viaMacError(error).message;
  }
  if (!body) {
    m.jarvis = m.code = { available: false, reason: why };
    m.local = { ...NO_LOCAL, reason: why };
    return none(why);
  }
  const mine = cleanMacMeta(body);
  const names = mine.models.filter((x) => x.available).map((x) => x.name);
  Object.assign(m, mine, {
    local: cleanLocal(body.local),
    scope: `Eden on your Mac, ${VIA_MAC_LABEL}${names.length ? ` (${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''})` : ''}`,
  });
  return m;
}
