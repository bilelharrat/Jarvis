// EVES web search when Google's quota runs out (askeden.com only; SEARCH_FALLBACK = off (default) | on).
//
// Google (Gemini grounding) stays the default for every EVES search call: the anchor, the evidence checks and the
// flag repair's searches. Only when Gemini answers 429 / RESOURCE_EXHAUSTED / a quota error is that same call retried
// once with Claude's web search tool, then GPT's web_search (the keys this account may use: Claude is bring-your-own-key
// unless askeden.com has its own). The trip lasts until the next midnight in America/Los_Angeles (Google's quotas reset
// on Pacific time); meanwhile Google is tried first again at most once an hour. If Claude and GPT both fail, the call
// goes on exactly as today. The iPhone and Edu apps (UA EdenApp/ or EdenEdu/) never use any of this.
//
// State is per Worker isolate (isolates share no memory): another isolate learns the trip from its own first 429.

import { canSearch, modelOf } from './providers.js';

const APP_UA = /^(?!.*\bEdenBeta\/).*\b(?:EdenApp|EdenEdu)\//; // not a TestFlight beta (EdenBeta/): that gets the website's features
const PROBE_EVERY_MS = 60 * 60 * 1000;
const QUOTA_RE = /RESOURCE_EXHAUSTED|\bquota\b/i;
// The fallbacks' search models, best first (each must be on this site's list and the account must have the key)
const CLAUDE_SEARCH = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5'];
const GPT_SEARCH = ['gpt-6-sol', 'gpt-6.1-sol'];
const FALLBACK_EFFORTS = ['low', 'minimal', 'medium', 'none'];

const trip = { until: 0, lastProbe: 0 };
export function resetSearchFallback() {
  trip.until = 0;
  trip.lastProbe = 0;
}
export const searchFallbackState = () => ({ ...trip });

/** On for this request: SEARCH_FALLBACK=on and not the iPhone/Edu app. */
export function searchFallbackOn(env, request) {
  if (request && APP_UA.test(request.headers.get('user-agent') || '')) return false;
  return String((env && env.SEARCH_FALLBACK) ?? 'off').trim().toLowerCase() === 'on';
}

const LA = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const laParts = (t) => Object.fromEntries(LA.formatToParts(new Date(t)).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
/** Pacific local time minus UTC at instant t, in ms (−7 h in summer, −8 h in winter). */
const laOffset = (t) => {
  const p = laParts(t);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
};
/** The next midnight in America/Los_Angeles after t, as a UTC timestamp (DST days included). */
export function nextPacificMidnight(t = Date.now()) {
  const p = laParts(t);
  const local = Date.UTC(p.year, p.month - 1, p.day + 1, 0, 0, 0);
  const guess = local - laOffset(t);
  return local - laOffset(guess);
}

/** A Gemini failure that means its quota is spent: HTTP 429, or a quota / RESOURCE_EXHAUSTED message. */
export function isQuotaError(e) {
  if (!e) return false;
  if (e.status === 429) return true;
  return QUOTA_RE.test(String(e.message || e));
}

const pickOf = (cfgModels, keys, provider, ids) => {
  if (!keys || !keys[provider]) return null;
  for (const id of ids) {
    const m = (cfgModels || []).find((x) => x.id === id) || null;
    if (m && m.provider === provider && canSearch(m)) {
      const efforts = (m.efforts || (modelOf(m.id) || {}).efforts || []).map((e) => (e && typeof e === 'object' ? e.level : e));
      const effort = FALLBACK_EFFORTS.find((e) => efforts.includes(e)) || efforts[0];
      return { model: m, ...(effort ? { effort } : {}) };
    }
  }
  return null;
};

/**
 * The fallback plan for one hostedAsk: null when it is off. log(provider, reason) writes one "search_fallback" line.
 * models: the site's model list (cfg.models), keys: the account's keys (cfg.keys).
 */
export function searchFallback({ models, keys, turnId }) {
  const chain = [pickOf(models, keys, 'anthropic', CLAUDE_SEARCH), pickOf(models, keys, 'openai', GPT_SEARCH)].filter(Boolean);
  const log = (provider, reason) => console.log(JSON.stringify({ evt: 'search_fallback', provider, reason, turn: turnId || null }));
  return {
    chain,
    /** Skip Google for this call? (tripped today, and not the hourly re-probe) */
    skipGoogle(now = Date.now()) {
      if (now >= trip.until) {
        trip.until = 0;
        return false;
      }
      if (now - trip.lastProbe >= PROBE_EVERY_MS) {
        trip.lastProbe = now;
        return false; // the hourly probe: Google first
      }
      return true;
    },
    tripped(now = Date.now()) {
      if (!trip.until) trip.lastProbe = now;
      trip.until = nextPacificMidnight(now);
    },
    recovered() {
      if (!trip.until) return;
      trip.until = 0;
      log('gemini', 'recovered');
    },
    log,
  };
}
