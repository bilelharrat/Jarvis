// Hosted EVES (Eden Verification & Evaluation System, ROADMAP N7/N13, docs/verify/eves.md) on askeden.com:
//
//   POST /api/chat/eves/estimate   { prompt, settings, models?, mode? } → { risk, lanes, judge, evidence, anchor, totalUSD, typicalUSD, latencyS, independence, independenceNote, notes }
//   POST /api/chat/eves            SSE: eves, eves_stage…, lane-tagged text/thinking/citations/usage/done/error for lanes 0..2,
//                                  checks, verdict, the answer as lane "final" (text…, usage, done), verification, end
//   POST /api/chat/eves/stop       { id, lane: 0..2 | 'judge' }
//
// Runs the Mac's own verification core (vendor/verify.js: checkAgreement, judgeAnswers, checkEvidence, applyCorrections,
// runChecks, checkInspector, allAbstain, aimedAtJudge, unletter) on askeden.com's hosted providers, metered and held on
// the account's allowance just like Compare and checks.js.

import { call } from '../accounts/index.js';
import { ApiError } from '../accounts/util.js';
import { isOwnerEmail } from '../accounts/owner-emails.js';
import { gemmaSession, shadowSampled, withGemmaVerdict } from './gemma-judge.js';
import { gemmaTextSession } from './gemma-text.js';
import { searchFallback, searchFallbackOn } from './search-fallback.js';
import { lookupEvesVault, putEvesFlag, putEvesVault, seedEvesVault } from '../news/store.js';
import { record as recordStat } from '../stats/stats.js';
import { EVIDENCE_RETRY_MS, PREMISE_EVIDENCE_MAX, PREMISE_SYSTEM, STRONG_ANCHOR_USES, STRONG_SECOND_USES, alreadyRejectsPremise, checkModels, evesAnchorMode, evesEvidenceSearchMode, evesStrongFixes, evesStrongMode, hostedAsk, parsePremises, perplexitySearchAsk, premisePrompt, premiseTurn, strongSecondPick } from './checks.js';
import { OPENAI_SEARCH_USD, autoModels, computedWhere, fitCall, hasVision, maxTokensOf, metered, modelOf, ratesOf, streamCall, usageUSD } from './providers.js';
import { withMaxOutputTokens } from './vendor/providers.js';
import { effortLabel } from './vendor/model-router.js';
import {
  ADDED_LEAD,
  AGREEMENT_OUTPUT_TOKENS,
  ALL_CHECKS,
  ANCHOR_OUTPUT_TOKENS,
  EVIDENCE_MAX_CALLS,
  EVIDENCE_OUTPUT_TOKENS,
  EVES_TIME_BUDGET_MS,
  JUDGE_OUTPUT_TOKENS,
  TYPICAL_LANE_SHARE,
  aimedAtJudge,
  allAbstain,
  applyCorrections,
  assessQueryImmutability,
  assessRisk,
  buildClarificationAutoReply,
  buildSeedVaultEntries,
  checkAgreement,
  checkEvidence,
  checkInspector,
  clip,
  extractClaimsDetailed,
  falsifyAnswer,
  fastConsensusCheck,
  findSentenceForClaim,
  findVerifiedVaultMatch,
  fingerprintQuestion,
  isClarifyingQuestion,
  isEligibleForVaultStorage,
  judgeAnswers,
  mergeClarifyingQuestions,
  MemoryVaultStore,
  normalizeForMatch,
  packQuantizedVector,
  partlyCheckedLabel,
  premiseNote,
  reanswerWithSearch,
  runChecks,
  unletter,
} from './vendor/verify.js';
import { TOP_MODEL } from '../../public/eden/autopilot-model.js';

const FINAL_CHUNK_CHARS = 1_500;
const SHORT_ANSWER_CHARS = 200;
const VAULT_EMBED_MODEL = '@cf/baai/bge-small-en-v1.5';
const isNodeTest = typeof process !== 'undefined' && Boolean(process?.env?.NODE_TEST_CONTEXT);
let cachedSeedEntries = null;
function getSeedEntries() {
  if (!cachedSeedEntries) cachedSeedEntries = buildSeedVaultEntries();
  return cachedSeedEntries;
}
const hostedMemoryVaults = new WeakMap();
let fallbackMemoryVault = null;

function getMemoryVault(env) {
  if (!env || typeof env !== 'object') {
    if (!fallbackMemoryVault) {
      fallbackMemoryVault = new MemoryVaultStore({ maxEntries: 25000, initialEntries: !isNodeTest ? getSeedEntries() : undefined });
    }
    return fallbackMemoryVault;
  }
  let v = hostedMemoryVaults.get(env);
  if (!v) {
    const shouldSeed = env.EDEN_VAULT_SEED === '1' || (!isNodeTest && env.EDEN_VAULT_SEED !== 'off');
    const initialEntries = shouldSeed ? getSeedEntries() : undefined;
    v = new MemoryVaultStore({ maxEntries: 25000, initialEntries });
    hostedMemoryVaults.set(env, v);
    if (shouldSeed && env.NEWS && !env.EVES_VAULT_DB) {
      void seedEvesVault(env, initialEntries.slice(0, 500)).catch(() => {});
    }
  }
  return v;
}

export function clearHostedEvesVault(env) {
  if (env && typeof env === 'object') hostedMemoryVaults.delete(env);
  if (fallbackMemoryVault) fallbackMemoryVault.clear();
}

export function hasHostedExactVaultHit(env, question, { messageCount = 1, hasAttachments = false, hasSources = false, privacy = false, vault = true } = {}) {
  const vaultEnabled = vault !== false && env?.EDEN_EVES_VAULT !== 'off';
  if (!vaultEnabled) return false;
  const vaultQueryImm = assessQueryImmutability(question, {
    messageCount,
    hasAttachments,
    hasSources,
    privacy,
    allowStandaloneInMultiTurn: true,
  });
  if (!vaultQueryImm.immutable) return false;
  const memVault = getMemoryVault(env);
  const qFp = fingerprintQuestion(question);
  return typeof memVault.hasExactHash === 'function' ? memVault.hasExactHash(qFp) : false;
}

export async function lookupHostedVaultMatch(env, question, { messageCount = 1, hasAttachments = false, hasSources = false, privacy = false, vault = true, ask = undefined, signal = undefined } = {}) {
  const vaultEnabled = vault !== false && env?.EDEN_EVES_VAULT !== 'off';
  const vaultQueryImm = vaultEnabled
    ? assessQueryImmutability(question, {
        messageCount,
        hasAttachments,
        hasSources,
        privacy,
        allowStandaloneInMultiTurn: true,
      })
    : { immutable: false, reason: 'vault_disabled' };
  if (!vaultQueryImm.immutable) return null;

  const memVault = getMemoryVault(env);
  const qFp = fingerprintQuestion(question);
  const l1Candidates = await memVault.lookupCandidates(qFp).catch(() => []);
  const exactInL1 = l1Candidates.some((c) => c.canonicalHash === qFp.canonicalHash);
  const l2Candidates = !exactInL1 ? await lookupEvesVault(env, qFp.canonicalHash, qFp).catch(() => []) : [];
  const seenHashes = new Set();
  const candidates = [];
  for (const c of [...l1Candidates, ...l2Candidates]) {
    if (c && c.canonicalHash && !seenHashes.has(c.canonicalHash)) {
      seenHashes.add(c.canonicalHash);
      candidates.push(c);
    }
  }
  if (!candidates.length || (signal && signal.aborted)) return null;
  const exactCanonical = candidates.some((c) => c.canonicalHash === qFp.canonicalHash);
  const queryVectorB64 = !exactCanonical ? await embedVaultQuestion(env, question) : null;
  const match = await findVerifiedVaultMatch(question, candidates, {
    queryVectorB64,
    ask,
    signal,
  });
  if (!match.hit || !match.entry || (signal && signal.aborted)) return null;
  void memVault.putEntry(match.entry).catch(() => {});
  return match;
}

async function embedVaultQuestion(env, question) {
  if (!env || !env.AI) return null;
  try {
    const r = await env.AI.run(VAULT_EMBED_MODEL, { text: [String(question || '').slice(0, 1000)] });
    const v = r && Array.isArray(r.data) ? r.data[0] : null;
    return Array.isArray(v) && v.length ? packQuantizedVector(v) : null;
  } catch {
    return null;
  }
}
const FAMILY_NAMES = { anthropic: 'Claude', openai: 'GPT', gemini: 'Gemini', kimi: 'Kimi', meta: 'Muse', mistral: 'Mistral', deepseek: 'DeepSeek' };
const NUMBER_WORDS = ['no', 'one', 'two', 'three'];
const ANCHOR_SYSTEM = 'Answer the question concisely and factually in at most 200 words (or a compact bullet list). Use web search when it helps. If you cannot find the answer, say you do not know.';
/** EVES_STRONG: a searched answer's priced output (the anchor at medium effort thinks more than at low). */
const STRONG_ANSWER_OUT = 4_000;
const ownerOf = async (env, who) => {
  const me = await call(env, who.account, 'get', {}, who.token);
  return Array.isArray(me && me.identities) && me.identities.some((i) => i && isOwnerEmail(i.email));
};
/**
 * EVES_STRONG for this request (checks.js evesStrongMode): on, or owner mode and an owner account; false otherwise.
 * When active, the anchor it runs with (EVES_ANCHOR, checks.js evesAnchorMode): 'gemini' | 'gpt'; with any of its fixes
 * on (checks.js evesStrongFixes), { anchor, premise, noEarlyCut, hedge, cross } instead.
 */
export async function evesStrongOn(request, env, who) {
  const mode = evesStrongMode(env, request);
  const on = mode === 'on' || (mode === 'owner' && !!who && (await ownerOf(env, who).catch(() => false)));
  if (!on) return false;
  const fixes = evesStrongFixes(env);
  return fixes.premise || fixes.noEarlyCut || fixes.hedge || fixes.cross ? { anchor: evesAnchorMode(env), ...fixes } : evesAnchorMode(env);
}
const PRIVACY_EVES = 'EVES in privacy mode runs only in Eden on your Mac, with its local models. Nothing was sent. Turn privacy off for this chat to use EVES here.';
const EVES_NOTE = 'on askeden.com: each lane and check on its provider, counted on your Eden Secretary account’s included AI (your own keys aren’t)';

const round1 = (x) => Math.round(x * 10) / 10;
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const utf8 = new TextEncoder();
const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const evesRuns = new Map(); // id → { account, lanes, stop(lane) }

export function independenceOf(lanes) {
  const fams = lanes.map((l) => l.provider || (modelOf(l.model) || {}).provider || l.model);
  const distinct = [...new Set(fams)];
  const all = lanes.length === 2 ? 'Both answers' : `All ${NUMBER_WORDS[lanes.length] ?? lanes.length} answers`;
  const fname = (f) => FAMILY_NAMES[f] || f;
  if (distinct.length >= 3) return { independence: 'full', independenceNote: null };
  if (distinct.length <= 1) {
    return {
      independence: 'none',
      independenceNote: `${all} come from ${fname(distinct[0] ?? '')} models, which tend to make the same mistakes; add another provider’s key for independent checks.`,
    };
  }
  if (lanes.length === 2) {
    return {
      independence: 'partial',
      independenceNote: `The answers come from two makers (${distinct.map(fname).join(' and ')}); add a third provider’s key for a fully independent check.`,
    };
  }
  const twice = distinct.find((f) => fams.filter((x) => x === f).length > 1) ?? distinct[0];
  return {
    independence: 'partial',
    independenceNote: `Two of the three answers come from ${fname(twice)} models, which tend to make the same mistakes; add another provider’s key for a fully independent check.`,
  };
}

const laneInfo = (l, lane) => {
  const provider = l.provider || (modelOf(l.model) || {}).provider || 'gemini';
  return {
    lane,
    model: l.model,
    modelName: l.name,
    provider,
    effort: l.effort,
    effortLabel: effortLabel(l.effort),
    via: 'api',
    where: computedWhere(provider),
    costUSD: typeof l.costUSD === 'number' ? l.costUSD : null,
    quality: typeof l.quality === 'number' ? round1(l.quality) : null,
    latencyS: l.latencyS ?? null,
  };
};

function pricePick(pick, inTokens, outTokens, search = false) {
  if (!pick || !pick.model) return 0;
  const [inRate, outRate] = ratesOf(pick.model);
  const queryUSD = search && pick.model.provider === 'gemini' ? 0.014 : 0;
  return round6((inTokens * inRate + outTokens * outRate) / 1e6 + queryUSD);
}

function sameWords(texts) {
  const norm = texts.map((t) => normalizeForMatch(t).replace(/[\s.!?;:,]+$/, ''));
  return norm.every((n) => n.length > 0 && n.length <= SHORT_ANSWER_CHARS && n === norm[0]);
}

function chunks(text) {
  const out = [];
  for (const para of text.split(/(?<=\n\n)/)) {
    if (out.length && out[out.length - 1].length + para.length <= FINAL_CHUNK_CHARS) out[out.length - 1] += para;
    else out.push(para);
  }
  return out.filter((c) => c.length);
}

const evidenceFinding = (c, v, sentence) => ({
  check: 'evidence',
  status: v.verdict === 'supported' ? 'pass' : v.verdict === 'contradicted' ? 'fail' : v.verdict === 'unresolved' ? 'error' : 'skipped',
  subject: clip(c.text, 120),
  detail: v.summary,
  ...(sentence ? { sentence } : {}),
});

const VALID_STATUS = new Set(['pass', 'fail', 'skipped', 'error']);
const validFinding = (f) =>
  !!f && typeof f === 'object' && typeof f.check === 'string' && VALID_STATUS.has(f.status) && typeof f.subject === 'string' && typeof f.detail === 'string';

export function evesPlan(cfg, prompt, extras, models, settings = {}) {
  const { result, lanes, picks, strong = false, second = null, anchorGpt = false, fixes = null } = extras;
  const notes = [EVES_NOTE];
  const qTokens = Math.ceil(utf8.encode(prompt).length / 3);
  const answersIn = lanes.length * Math.max(200, Number(result.task && result.task.outputTokens) || 800);
  const cheapUSD = picks.cheap ? pricePick(picks.cheap, qTokens + answersIn + 400, AGREEMENT_OUTPUT_TOKENS, false) : 0;
  const judgeUSD = picks.strong ? pricePick(picks.strong, qTokens + answersIn + 900, JUDGE_OUTPUT_TOKENS, false) : 0;
  const perSearch = picks.search ? pricePick(picks.search, qTokens + 600, EVIDENCE_OUTPUT_TOKENS, true) : 0;
  const maxCalls = picks.search ? EVIDENCE_MAX_CALLS : 0;
  // EVES_STRONG + EVES_ANCHOR=gpt: GPT's web-search answer is the anchor and Gemini's the second answer
  const gptFirst = strong && anchorGpt && !!second;
  const anchorPick = gptFirst ? second : picks.search;
  const secondPick = gptFirst ? picks.search : second;
  const anchor = anchorPick ? { model: anchorPick.model.id, modelName: anchorPick.model.name } : null;
  // a searched answer: Gemini's grounding queries, or GPT's web_search calls with each search's pages read as input
  const searchedUSD = (pick) =>
    pick.model.provider === 'gemini' ? pricePick(pick, qTokens + 600, STRONG_ANSWER_OUT, true) : round6(pricePick(pick, qTokens + 600 + STRONG_SECOND_USES * 10_000, STRONG_ANSWER_OUT, false) + STRONG_SECOND_USES * OPENAI_SEARCH_USD);
  const anchorUSD = anchor ? (strong ? searchedUSD(anchorPick) : perSearch) : 0;
  // EVES_STRONG: a second answer with web search from another provider, beside the anchor
  const secondPlan = strong && anchor && secondPick ? { model: secondPick.model.id, modelName: secondPick.model.name, ...(secondPick.effort ? { effort: secondPick.effort } : {}) } : null;
  const secondUSD = secondPlan ? searchedUSD(secondPick) : 0;
  const judge = picks.strong
    ? {
        ...laneInfo(
          {
            model: picks.strong.model.id,
            name: picks.strong.model.name,
            provider: picks.strong.model.provider,
            effort: picks.strong.effort,
            costUSD: judgeUSD,
            quality: null,
            latencyS: 4,
          },
          'judge',
        ),
      }
    : null;
  if (!picks.strong) notes.push('no strong model is available to judge: when the answers differ, the top-ranked one is shown, not verified');
  else if (lanes.some((l) => (l.provider || (modelOf(l.model) || {}).provider) === picks.strong.model.provider)) {
    notes.push(`the judge, ${picks.strong.model.name}, comes from the same provider as one of the answers; it sees them shuffled and unnamed, to limit self-preference`);
  }
  if (!picks.search) notes.push('no model here can search the web, so claims the models dispute stay unresolved');
  if (anchor) notes.push(`${anchor.modelName} also answers with a web search; that answer is kept unless the web shows a claim in it is wrong (the other models can only send its disputed claims to the web)`);
  if (secondPlan) notes.push(`${secondPlan.modelName} also answers with its own web search; where it and ${anchor.modelName} disagree, the claim is checked on the web`);
  notes.push('the price is the most it can cost: the judge and the web checks run only when the answers disagree');
  const info = lanes.map((l, i) => laneInfo(l, i));
  const lanesUSD = info.reduce((n, l) => n + (l.costUSD || 0), 0);
  // EVES_STRONG's fixes: the premise check (a cheap extraction and its web checks), the evidence retries
  const premiseUSD = strong && fixes && fixes.premise && picks.cheap && picks.search && premiseTurn(prompt) ? round6(pricePick(picks.cheap, qTokens + 500, 500, false) + PREMISE_EVIDENCE_MAX * perSearch) : 0;
  const retryUSD = strong && fixes && fixes.hedge ? round6(maxCalls * perSearch) : 0;
  if (premiseUSD) notes.push('the question’s premises and the things it names are checked on the web; a false one is corrected in the answer');
  // EVES_EVIDENCE_CROSS: every web check (the disputed claims', the premises') can run once more on GPT's web search
  const crossUSD = strong && fixes && fixes.cross && secondPick ? round6((maxCalls + (premiseUSD ? PREMISE_EVIDENCE_MAX : 0)) * pricePick(secondPick, qTokens + 600, EVIDENCE_OUTPUT_TOKENS, true)) : 0;
  if (crossUSD) notes.push('a claim the web check settles is checked again with a second, independent web search; if the two disagree it is not stated as fact');
  if (retryUSD) notes.push('a disputed claim the web check can’t settle gets one more try, then is marked as not verified rather than stated as fact');
  const checksUSD = cheapUSD + judgeUSD + maxCalls * perSearch + premiseUSD + retryUSD + crossUSD;
  const totalUSD = round6(lanesUSD + anchorUSD + secondUSD + checksUSD);
  const typicalUSD = round6(TYPICAL_LANE_SHARE * lanesUSD + anchorUSD + secondUSD + cheapUSD + (premiseUSD ? pricePick(picks.cheap, qTokens + 500, 500, false) : 0));
  const latencyS = round1(Math.max(0, ...info.map((l) => l.latencyS || 0), anchor ? 4 : 0, secondPlan ? 8 : 0) + 6);
  return {
    lanes: info,
    judge,
    evidence: { maxCalls, model: picks.search ? picks.search.model.id : null },
    anchor,
    ...(secondPlan ? { second: secondPlan } : {}),
    ...(gptFirst ? { anchorGpt: true } : {}),
    ...(strong && fixes && (fixes.premise || fixes.noEarlyCut || fixes.hedge || fixes.cross) ? { fixes: { premise: !!fixes.premise, noEarlyCut: !!fixes.noEarlyCut, hedge: !!fixes.hedge, cross: !!(fixes.cross && secondPick) } } : {}),
    ...independenceOf(info),
    notes,
    estimate: { totalUSD, typicalUSD, latencyS },
  };
}

function shapeEvesPool(cfg, evesModel) {
  const want = typeof evesModel === 'string' && evesModel.trim() ? evesModel.trim() : 'gemini-3.8-flash';
  let models = cfg.models;
  // Promote gpt-6-sol (~1.88s at low effort) into the EVES pool when OpenAI is available so the OpenAI cross-check lane doesn't wait 5.6s for gpt-6.1-sol
  if ((!cfg.keys || cfg.keys.openai) && !models.some((m) => m.id === 'gpt-6-sol')) {
    const gpt6Sol = modelOf('gpt-6-sol');
    if (gpt6Sol) models = [...models, gpt6Sol];
  }
  if (want !== 'gemini-4-argon') {
    const withoutArgon = models.filter((m) => m.id !== 'gemini-4-argon');
    if (withoutArgon.length >= 2) models = withoutArgon;
  }
  if (want !== 'kimi-k3') {
    const withoutKimi = models.filter((m) => m.id !== 'kimi-k3');
    if (withoutKimi.length >= 2) models = withoutKimi;
  }
  return models === cfg.models ? cfg : { ...cfg, models };
}

function shapeEvesPins(pins, evesModel) {
  if (!Array.isArray(pins)) return undefined;
  const want = typeof evesModel === 'string' && evesModel.trim() ? evesModel.trim() : 'gemini-3.8-flash';
  if (want !== 'gemini-4-argon' && pins.some((p) => p && p.model === 'gemini-4-argon')) {
    return undefined;
  }
  if (want === 'gemini-4-argon' && !pins.some((p) => p && p.model === 'gemini-4-argon')) {
    return undefined;
  }
  return pins;
}

function compareEvesLanes(helpers, cfg, prompt, extras, pins, evesModel) {
  let current = helpers.compareLanes(cfg, prompt, extras, pins);
  const want = typeof evesModel === 'string' && evesModel.trim() ? evesModel.trim() : 'gemini-3.8-flash';
  if (!pins && current.lanes.length >= 2) {
    let nextWanted = current.lanes.map((l) => ({ model: l.model, effort: l.effort }));
    let changed = false;
    if (cfg.models.some((m) => m.id === want) && !nextWanted.some((l) => l.model === want)) {
      const wantModel = cfg.models.find((m) => m.id === want);
      let replaceIdx = -1;
      for (let i = nextWanted.length - 1; i >= 0; i--) {
        const lm = cfg.models.find((m) => m.id === nextWanted[i].model);
        if (lm && wantModel && lm.provider === wantModel.provider) {
          replaceIdx = i;
          break;
        }
      }
      if (replaceIdx < 0) replaceIdx = nextWanted.length - 1;
      nextWanted[replaceIdx] = { model: want };
      changed = true;
    }
    // Assemble the recommended fast 3-provider trio when available:
    // 1) gemini-3.8-flash (low)  2) claude-sonnet-5-5 (none, ~2.2s)  3) gpt-6-sol (low, ~1.88s CoT) instead of slow gpt-6.1-sol (~5.6s)
    const hasSonnet = cfg.models.some((m) => m.id === 'claude-sonnet-5-5');
    const hasGpt6Sol = cfg.models.some((m) => m.id === 'gpt-6-sol');
    const sol61Idx = nextWanted.findIndex((l) => l.model === 'gpt-6.1-sol');
    if (sol61Idx >= 0 && want !== 'gpt-6.1-sol') {
      if (hasSonnet && !nextWanted.some((l) => l.model === 'claude-sonnet-5-5')) {
        nextWanted[sol61Idx] = { model: 'claude-sonnet-5-5', effort: 'none' };
        if (hasGpt6Sol && nextWanted.length < 3 && !nextWanted.some((l) => l.model === 'gpt-6-sol')) {
          nextWanted.push({ model: 'gpt-6-sol', effort: 'low' });
        }
        changed = true;
      } else if (hasGpt6Sol && !nextWanted.some((l) => l.model === 'gpt-6-sol')) {
        nextWanted[sol61Idx] = { model: 'gpt-6-sol', effort: 'low' };
        changed = true;
      }
    }
    // Ensure claude-sonnet-5-5 runs at effort: 'none' (~2.2s) and gpt-6-sol runs at effort: 'low' (~1.88s with CoT)
    for (let i = 0; i < nextWanted.length; i++) {
      if (nextWanted[i].model === 'claude-sonnet-5-5' && nextWanted[i].effort !== 'none' && want !== 'claude-sonnet-5-5') {
        nextWanted[i] = { model: 'claude-sonnet-5-5', effort: 'none' };
        changed = true;
      }
      if (nextWanted[i].model === 'gpt-6-sol' && nextWanted[i].effort !== 'low') {
        nextWanted[i] = { model: 'gpt-6-sol', effort: 'low' };
        changed = true;
      }
    }
    // Guarantee the 3-provider fast trio (Google + Anthropic + OpenAI) when available:
    // if claude-sonnet-5-5 or gpt-6-sol is missing because a second model from the same provider (e.g. gemini-3.5-flash-lite) took its slot, swap it in
    if (hasSonnet && !nextWanted.some((l) => l.model === 'claude-sonnet-5-5')) {
      const dupIdx = nextWanted.findIndex((l, idx) => idx > 0 && l.model !== want && l.model !== 'gpt-6-sol');
      if (dupIdx >= 0) {
        nextWanted[dupIdx] = { model: 'claude-sonnet-5-5', effort: 'none' };
        changed = true;
      } else if (nextWanted.length < 3) {
        nextWanted.push({ model: 'claude-sonnet-5-5', effort: 'none' });
        changed = true;
      }
    }
    if (hasGpt6Sol && !nextWanted.some((l) => l.model === 'gpt-6-sol')) {
      const dupIdx = nextWanted.findIndex((l, idx) => idx > 0 && l.model !== want && l.model !== 'claude-sonnet-5-5');
      if (dupIdx >= 0) {
        nextWanted[dupIdx] = { model: 'gpt-6-sol', effort: 'low' };
        changed = true;
      } else if (nextWanted.length < 3) {
        nextWanted.push({ model: 'gpt-6-sol', effort: 'low' });
        changed = true;
      }
    }
    if (changed) current = helpers.compareLanes(cfg, prompt, extras, nextWanted.slice(0, 3));
  }
  return current;
}

/** POST /api/chat/eves/estimate */
export function hostedEvesEstimate(raw, cfg, helpers) {
  if (raw.privacy !== undefined && raw.privacy !== null && raw.privacy !== false) throw new ApiError(503, 'needs_mac', PRIVACY_EVES);
  if ( raw.mode !== undefined && raw.mode !== null && raw.mode !== 'on' && raw.mode !== 'auto') throw new ApiError(400, 'bad_request', 'mode must be "on" or "auto".');
  const prompt = typeof raw.prompt === 'string' ? raw.prompt : '';
  if (!prompt.trim()) throw new ApiError(400, 'bad_request', 'Type a prompt to estimate.');
  if (prompt.length > 400_000) throw new ApiError(413, 'too_big', 'That prompt is too long to estimate.');
  const settings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  const shaped = shapeEvesPool(cfg, settings.evesModel);
  const narrowed = shapeEvesPool(Array.isArray(settings.providers) ? helpers.narrowFor(shaped, { settings }) : shaped, settings.evesModel);
  const pins = shapeEvesPins(helpers.compareModels(raw, shaped), settings.evesModel);
  const { result, lanes } = compareEvesLanes(helpers, narrowed, prompt, helpers.routeSettings(settings), pins, settings.evesModel);
  const picks = checkModels(autoModels(narrowed.models), settings.providers, settings.evesModel);
  const st = helpers.strong; // EVES_STRONG for this request (chat.js: evesStrongOn)
  const strong = st === true || st === 'gemini' || st === 'gpt' || (!!st && typeof st === 'object');
  const stFixes = st && typeof st === 'object' ? { fixes: st } : {};
  const plan = evesPlan(narrowed, prompt, { result, lanes, picks, ...(strong ? { strong, second: strongSecondPick(cfg.models, cfg.keys, settings.providers), anchorGpt: st === 'gpt' || (!!st && st.anchor === 'gpt'), ...stFixes } : {}) }, null, settings);
  const r = assessRisk(prompt, { mode: 'chat' });
  return {
    risk: { level: r.level, reasons: r.reasons, eves: r.action.eves },
    lanes: plan.lanes,
    judge: plan.judge,
    evidence: plan.evidence,
    anchor: plan.anchor,
    ...(plan.second ? { second: plan.second } : {}),
    ...(plan.fixes ? { fixes: plan.fixes } : {}),
    totalUSD: plan.estimate.totalUSD,
    typicalUSD: plan.estimate.typicalUSD,
    latencyS: plan.estimate.latencyS,
    independence: plan.independence,
    independenceNote: plan.independenceNote,
    notes: plan.notes,
  };
}

/** POST /api/chat/eves/stop */
export function stopHostedEves(raw, who) {
  if (typeof raw.id !== 'string' || !/^[0-9a-f]{24}$/.test(raw.id)) throw new ApiError(400, 'bad_request', 'id must be the id from the eves event');
  const lane = typeof raw.lane === 'number' ? String(raw.lane) : raw.lane;
  if (typeof lane !== 'string' || !(lane === 'judge' || /^[0-2]$/.test(lane))) throw new ApiError(400, 'bad_request', 'lane must be 0, 1, 2 or "judge"');
  const run = evesRuns.get(raw.id);
  if (!run || run.account !== who.account || !run.stop(lane)) throw new ApiError(404, 'not_running', 'That check has finished.');
  return { ok: true };
}

const SERVER_SLIDE_ASK_RE =
  /\b(?:make|create|build|generate|design|write|draft|prepare|put together|give me|can you make|could you make|i need|we need|show me)\b[\s\S]{0,80}?\b(?:slide\s*deck|slides|slide\s*show|slideshow|slide\s*set|slideset|presentation|power\s*point|pptx|pitch\s*deck|keynote)\b|\b(?:in|as a|into a)\s+(?:power\s*point|pptx|slide\s*deck|slide\s*show|slideshow|presentation|slideset)\b|\b(?:power\s*point|slide\s*deck|slide\s*show|slideshow|slideset)\s+(?:format|on|about|for)\b|\b(\d{1,2})[\s-]*(?:slides?|pages?)\s+(?:deck|presentation|slide\s*show|slideshow|on|about|for)\b/i;
const SERVER_SLIDE_CODE_RE = /\b(?:python|python-pptx|matplotlib|javascript|typescript|react|script|code|function)\b/i;

function evesWantsSlides(prompt) {
  const s = String(prompt || '').trim();
  if (!s || s.length > 4000) return false;
  if (SERVER_SLIDE_CODE_RE.test(s) && !/\b(?:power\s*point\s+format|build\s+the\s+slide\s+deck)\b/i.test(s)) return false;
  return SERVER_SLIDE_ASK_RE.test(s);
}

const EVES_DECK_PROMPT = [
  'You are building an industry-leading, state-of-the-art presentation deck in Eden (Canva Pro + Gamma + Apple Keynote executive quality). Eden renders your JSON into an interactive 16:9 canvas with native charts, vector diagrams, Bento card grids, real photography, AI illustrations, and 1-click PowerPoint (.pptx) export.',
  'NEVER say you cannot generate or download images or slide files, and NEVER write Python code (`python-pptx`, `matplotlib`) or a plain Markdown outline.',
  'Reply with one short introductory sentence, then the complete deck in one fenced block whose language is deck:\n```deck\n{ …JSON… }\n```',
  'JSON schema:\n{\n  "title": "Deck title",\n  "theme": { "base": "executive|glass|pitch-studio|paper|ocean|sunset|canva-aurora|editorial-luxe|glass-dark|midnight|forest" },\n  "sources": [{ "n": 1, "title": "Source title", "url": "https://…" }],\n  "slides": [\n    { "layout": "title", "kicker": "EXECUTIVE BRIEFING", "title": "…", "subtitle": "…", "imageQuery": "1-3 word Wikipedia/Wikimedia photo query", "notes": "…" },\n    { "layout": "grid", "kicker": "CORE ARCHITECTURE", "title": "…", "cards": [{ "badge": "01 · SYSTEM", "heading": "…", "bullets": ["…"] }, { "badge": "02 · EXECUTION", "heading": "…", "bullets": ["…"] }], "takeaway": "1-sentence executive takeaway", "notes": "…" },\n    { "layout": "diagram", "kicker": "TACTICAL PROGRESSION", "title": "…", "diagram": { "type": "flow|cycle|timeline|pyramid|funnel|matrix|hierarchy", "items": [{ "label": "…", "detail": "…" }] }, "takeaway": "…", "notes": "…" },\n    { "layout": "image", "kicker": "SIGNATURE PLAY", "title": "…", "imageQuery": "1-3 word Wikipedia/Wikimedia photo query for real people/teams/places", "imageGen": "vivid AI illustration prompt when a custom tactical diagram or concept art is needed", "alt": "what the picture shows", "bullets": ["…"], "takeaway": "…", "notes": "…" },\n    { "layout": "stats", "kicker": "BY THE NUMBERS", "title": "…", "stats": [{ "value": "…", "label": "…", "delta": "…" }], "bullets": ["…"], "notes": "…" },\n    { "layout": "two-column", "kicker": "COMPARISON", "title": "…", "left": { "heading": "…", "bullets": ["…"] }, "right": { "heading": "…", "bullets": ["…"] }, "takeaway": "…", "notes": "…" }\n  ]\n}',
  'Rules: Build 8–11 rich slides with varied layouts (title, grid, diagram, image, stats, two-column, chart/table, quote) using a clean professional light theme (`executive`, `glass`, `pitch-studio`, or `paper`) unless a dark theme was explicitly requested. Include `imageQuery` (1–3 English words for real people, teams, stadiums, companies, or places) or `imageGen` (for custom tactical diagrams or conceptual visuals) on the title slide and at least 3–5 content slides so the presentation is visually rich!',
].join('\n');

/** POST /api/chat/eves */
export async function hostedEves(request, env, ctx, who, cfg, helpers) {
  const raw = await helpers.readBody(request, helpers.MAX_BODY);
  if (raw.privacy !== undefined && raw.privacy !== null && raw.privacy !== false) throw new ApiError(503, 'needs_mac', PRIVACY_EVES);
  if (raw.mode !== undefined && raw.mode !== null && raw.mode !== 'on' && raw.mode !== 'auto') throw new ApiError(400, 'bad_request', 'mode must be "on" or "auto" (EVES is off otherwise).');
  if (cfg.models.length < 2) throw new ApiError(503, 'not_set_up', 'EVES needs at least two models on askeden.com.');
  const body = helpers.parseSend({ ...raw, mode: 'chat', override: undefined, sticky: undefined }, cfg);
  const lastInBody = body.messages[body.messages.length - 1];
  const isSlideDeckTurn = Boolean(raw.deck) || Boolean(lastInBody && evesWantsSlides(lastInBody.content));
  if (isSlideDeckTurn && (!body.system || !body.system.includes('```deck'))) {
    body.system = [body.system, EVES_DECK_PROMPT].filter(Boolean).join('\n\n');
  }
  const models = helpers.compareModels(raw, shapeEvesPool(cfg, body.settings.evesModel));
  // Personal material check outside privacy mode (images are supported across vision-capable lanes)
  const hasNonImageAttachments = body.messages.some((m) => m.attachments && m.attachments.some((a) => a.kind !== 'image'));
  const hasImages = body.messages.some((m) => m.attachments && m.attachments.some((a) => a.kind === 'image'));
  const hasContext = body.context && body.context.length;
  if (hasNonImageAttachments || hasContext) {
    throw new ApiError(422, 'personal_material', 'EVES can’t check this message: it carries your attached files or context. Send it with EVES off, or without them.');
  }
  const checkPool = cfg.models;
  cfg = shapeEvesPool(helpers.narrowFor(cfg, body), body.settings.evesModel);
  if (hasImages) {
    const visionModels = cfg.models.filter((m) => hasVision(m));
    if (visionModels.length >= 2) cfg = { ...cfg, models: visionModels };
  }
  let validModels = shapeEvesPins(models, body.settings.evesModel);
  if (validModels && hasImages) {
    const visionPins = validModels.filter((x) => cfg.models.some((m) => m.id === x.model && hasVision(m)));
    validModels = visionPins.length >= 2 ? visionPins : undefined;
  }
  if (validModels && validModels.some((x) => !cfg.models.some((m) => m.id === x.model))) {
    throw new ApiError(422, 'not_here', 'One of those models can’t be used with the providers you have on.');
  }
  const system = helpers.systemPrompt(body);
  const inputTokens = helpers.inputEstimate(body.messages, system);
  const allow = await call(env, who.account, 'allow-ai', { eden: true }, who.token);
  const last = body.messages[body.messages.length - 1];
  const question = helpers.messageText(last).trim() || 'Describe the attached image.';
  const sessionTokens = Math.max(0, inputTokens - Math.ceil(question.length / 3.5));
  const extras = { ...helpers.routeSettings(body.settings), ...(sessionTokens > 0 ? { context: { sessionTokens } } : {}) };
  const { result, lanes } = compareEvesLanes(helpers, cfg, question, extras, validModels, body.settings.evesModel);
  const picks = checkModels(autoModels(checkPool), body.settings.providers, body.settings.evesModel);
  // EVES_STRONG (checks.js evesStrongMode): on, or owner mode and an owner account; never the iPhone/Edu app or a deck
  const strongMode = isSlideDeckTurn ? 'off' : evesStrongMode(env, request);
  const strongOwner = strongMode === 'owner' ? ownerOf(env, who) : null;
  const strong = strongMode === 'on' || (strongOwner !== null && (await strongOwner.catch(() => false)));
  const strongExtras = strong ? { strong, second: strongSecondPick(checkPool, cfg.keys, body.settings.providers), anchorGpt: evesAnchorMode(env) === 'gpt', fixes: evesStrongFixes(env) } : {};
  const plan = evesPlan(cfg, question, { result, lanes, picks, ...strongExtras }, validModels, body.settings);

  const isMetered = (l) => metered(cfg.keys, l.provider || (modelOf(l.model) || {}).provider);
  const anyMetered = lanes.some(isMetered) || (picks.cheap && metered(cfg.keys, picks.cheap.model.provider)) || (picks.strong && metered(cfg.keys, picks.strong.model.provider)) || (picks.search && metered(cfg.keys, picks.search.model.provider));
  if (anyMetered && !allow.ok) throw new ApiError(402, 'no_allowance', allow.why);

  const short = () => new ApiError(402, 'no_allowance', `Not enough of your included AI is left to run EVES across ${lanes.length} models. Ask one model, or wait for the allowance to renew.`);
  const left = allow.ok && Number.isFinite(allow.left) ? allow.left : allow.ok ? Infinity : 0;
  const metLanes = Math.max(1, lanes.filter(isMetered).length);
  const checksHoldUSD = Math.min(0.18, Math.max(0, (plan.estimate.totalUSD || 0) - lanes.reduce((n, l) => n + (l.costUSD || 0), 0)));
  const laneShare = Math.max(0.01, (left - checksHoldUSD) / metLanes);
  const lanePlans = lanes.map((l) => {
    const m = modelOf(l.model);
    const fullMax = Math.min(cfg.maxTokens, m.provider === 'kimi' ? 32_768 : m.maxOutputTokens || cfg.maxTokens);
    const fullReq = maxTokensOf(l.request) < fullMax ? withMaxOutputTokens(l.request, fullMax) : l.request;
    const f = fitCall(m, fullReq, { leftUSD: isMetered(l) ? laneShare : Infinity, inputTokens, maxTokens: cfg.maxTokens, minReply: 1024 });
    if (f.short) throw short();
    return { ...f, worstUSD: isMetered(l) ? f.worstUSD : 0, maxTokens: maxTokensOf(f.request) };
  });
  const worst = round6(lanePlans.reduce((n, p) => n + p.worstUSD, 0) + (anyMetered ? checksHoldUSD : 0));
  if (worst > left) throw short();
  let hold = null;
  if (worst > 0) {
    hold = await call(env, who.account, 'hold-ai', { eden: true, usd: worst }, who.token);
    if (!hold.ok) throw new ApiError(402, 'no_allowance', hold.why);
  }

  // The Gemma claim judge (gemma-judge.js): null unless GEMMA_JUDGE_MODE is shadow/owner and this is not the iPhone/Edu app
  let ownerOnce = strongOwner; // asked once per turn, by whichever judge needs it first (or EVES_STRONG's owner mode)
  const isOwner = () =>
    (ownerOnce ??= (async () => {
      const me = await call(env, who.account, 'get', {}, who.token);
      return Array.isArray(me && me.identities) && me.identities.some((i) => i && isOwnerEmail(i.email));
    })());
  // Shadow runs on a sample of website turns (GEMMA_SHADOW_SHARE, default all) to keep the judge's GPU bill small
  const shadowTurn = shadowSampled(env);
  const gemma = gemmaSession(request, env, ctx, isOwner, { shadow: shadowTurn });
  // The same judge on the cited pages' raw text, before EVES's web check (gemma-text.js): null unless GEMMA_TEXT_MODE is
  // shadow/owner and this is not the iPhone/Edu app
  const gemmaText = shadowTurn || String(env.GEMMA_TEXT_MODE ?? '').trim().toLowerCase() === 'owner' ? gemmaTextSession(request, env, ctx, isOwner) : null;
  const seenCitations = (citations) => {
    if (gemmaText && citations && citations.length) gemmaText.addSources(citations);
  };
  /** checkEvidence for one claim, or (owner accounts, GEMMA_TEXT_MODE=owner) the judge's verdict when it settles it first. */
  const evidenceFor = (claim, kind, sentence, signal, asker = evidenceAsk) => {
    const run = () => checkEvidence(asker, { claim, question, sentence }, { signal });
    return gemmaText ? gemmaText.check({ claim, kind, sentence, signal }, run) : run();
  };
  const gemmaPass = async (items) => {
    if (!gemma || !items.length) return;
    const settled = await gemma.settle(items, { signal: judgeCtrl.signal });
    for (const [cid, g] of settled) items.checked.set(cid, withGemmaVerdict(items.checked.get(cid), g));
  };
  const gemmaItems = (list, checked) => Object.assign(list.filter((c) => checked.has(c.id) && !checked.get(c.id).gemmaText).map((c) => ({ id: c.id, claim: c.text, kind: c.kind, v: checked.get(c.id) })), { checked });

  const id = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const encoder = new TextEncoder();
  const abort = new AbortController();
  const laneCtrls = lanes.map(() => new AbortController());
  const judgeCtrl = new AbortController();
  const stoppedSet = new Set();
  for (const c of [...laneCtrls, judgeCtrl]) abort.signal.addEventListener('abort', () => c.abort(), { once: true });
  if (request.signal) {
    if (request.signal.aborted) abort.abort();
    else request.signal.addEventListener('abort', () => abort.abort(), { once: true });
  }
  let controller;
  let open = true;
  const write = (type, data) => {
    if (!open || abort.signal.aborted) return;
    try {
      controller.enqueue(encoder.encode(sse(type, data)));
    } catch {
      open = false;
    }
  };
  const stream = new ReadableStream({
    start(c) {
      controller = c;
    },
    cancel() {
      open = false;
      abort.abort();
    },
  });
  evesRuns.set(id, {
    account: who.account,
    lanes: lanes.length,
    stop(lane) {
      if (lane === 'judge') {
        stoppedSet.add('judge');
        judgeCtrl.abort();
        return true;
      }
      if (/^\d$/.test(lane) && Number(lane) < lanes.length) {
        stoppedSet.add(lane);
        laneCtrls[Number(lane)].abort();
        return true;
      }
      return false;
    },
  });

  let counted = Promise.resolve();
  const charge = (provider, usd, meta = { feature: 'eves' }) => {
    if (hold && metered(cfg.keys, provider) && usd > 0) {
      counted = counted.then(() => call(env, who.account, 'spend', { usd, bucket: hold.bucket, meta })).catch((error) => console.error('spend failed', error && error.message));
    }
  };
  const top = modelOf(TOP_MODEL);
  const factor = () => (metered(cfg.keys, 'gemini') ? helpers.creditFactor(hold || allow) : 1);

  const checksState = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUSD: 0, notional: false, calls: 0 };
  const requestFor = (pick, text) => helpers.routed(cfg, text, {}, { model: pick.model.id, effort: pick.effort }).pick.request;
  const baseAsk = hostedAsk({
    picks,
    keys: cfg.keys,
    base: cfg.base,
    requestFor,
    charge: (provider, usd) => charge(provider, usd, { feature: 'eves-check' }),
    tally: () => {},
    factor,
    ...(searchFallbackOn(env, request) ? { searchFallback: searchFallback({ models: checkPool, keys: cfg.keys, turnId: id }) } : {}),
    ...(strong ? { anchorEffort: 'medium' } : {}),
  });
  // EVES_STRONG: GPT's web-search answer has its own AskModel (no Gemini quota fallback, no other model): the second
  // answer, or with EVES_ANCHOR=gpt the anchor (and Gemini's, through baseAsk, the second)
  const gptFactor = () => (strongExtras.second && metered(cfg.keys, strongExtras.second.model.provider) ? helpers.creditFactor(hold || allow) : 1);
  const gptAsk = strongExtras.second && (plan.second || plan.anchorGpt)
    ? hostedAsk({ picks: { search: strongExtras.second }, keys: cfg.keys, base: cfg.base, requestFor, charge: (provider, usd) => charge(provider, usd, { feature: 'eves-check' }), tally: () => {}, factor: gptFactor })
    : null;
  const anchorAsk = plan.anchorGpt ? gptAsk : baseAsk;
  const anchorFactor = plan.anchorGpt ? gptFactor : factor;
  const secondAsk = plan.second ? (plan.anchorGpt ? baseAsk : gptAsk) : null;
  const secondFactor = plan.anchorGpt ? factor : gptFactor;
  const ask = async (req) => {
    checksState.calls++;
    const r = await baseAsk(req);
    checksState.costUSD += (r.costUSD || 0) * factor();
    return r;
  };
  // EVES_STRONG's fixes (checks.js evesStrongFixes), each on its own switch; the premise ones only on a turn with a
  // checkable premise or named thing (checks.js premiseTurn)
  const fixes = strong ? strongExtras.fixes : {};
  const premiseOn = !!fixes.premise && !!picks.cheap && !!picks.search && premiseTurn(question);
  const noEarlyCut = !!fixes.noEarlyCut && premiseTurn(question);
  const hedgeOn = !!fixes.hedge;
  // EVES_HEDGE_UNRESOLVED: the evidence retry's AskModel, as `ask` with a longer per-call timeout
  const longAsk = hedgeOn
    ? hostedAsk({ picks, keys: cfg.keys, base: cfg.base, requestFor, charge: (provider, usd) => charge(provider, usd, { feature: 'eves-check' }), tally: () => {}, factor, timeoutMs: EVIDENCE_RETRY_MS, ...(searchFallbackOn(env, request) ? { searchFallback: searchFallback({ models: checkPool, keys: cfg.keys, turnId: id }) } : {}) })
    : null;
  // EVES_EVIDENCE_CROSS: a settled web check (supported/contradicted) is checked again on GPT's web search; when the two
  // settle opposite ways the claim is unresolved (so EVES_HEDGE_UNRESOLVED, if on, keeps it from being stated as fact).
  // GPT unresolved or failing leaves the first check's verdict.
  const crossOn = !!fixes.cross && !!gptAsk;
  const crossAsk = async (req) => {
    checksState.calls++;
    const r = await gptAsk(req);
    checksState.costUSD += (r.costUSD || 0) * gptFactor();
    return r;
  };
  const askLonger = async (req) => {
    checksState.calls++;
    const r = await longAsk(req);
    checksState.costUSD += (r.costUSD || 0) * factor();
    return r;
  };
  // EVES_EVIDENCE_SEARCH: move web evidence and premise checks onto Perplexity (/v1/responses, pro-search) or OpenAI so
  // Google's 1,500/day grounding quota isn't burned on 3–6 checks per turn. Falls back to the default ask on any error.
  const evSearchMode = evesEvidenceSearchMode(env, request);
  const pplxRaw = perplexitySearchAsk(env, { charge: (provider, usd) => charge(provider, usd, { feature: 'eves-check' }) });
  const pplxLongRaw = hedgeOn ? perplexitySearchAsk(env, { timeoutMs: EVIDENCE_RETRY_MS, charge: (provider, usd) => charge(provider, usd, { feature: 'eves-check' }) }) : null;
  const pplxAsk = pplxRaw
    ? async (req) => {
        checksState.calls++;
        const r = await pplxRaw(req);
        checksState.costUSD += r.costUSD || 0;
        return r;
      }
    : null;
  const pplxLongAsk = pplxLongRaw
    ? async (req) => {
        checksState.calls++;
        const r = await pplxLongRaw(req);
        checksState.costUSD += r.costUSD || 0;
        return r;
      }
    : null;
  const evidenceAsk = async (req) => {
    const primary = evSearchMode === 'perplexity' && pplxAsk ? pplxAsk : evSearchMode === 'openai' && gptAsk ? crossAsk : null;
    if (primary) {
      try {
        return await primary(req);
      } catch (e) {
        if (req.signal && req.signal.aborted) throw e;
      }
    }
    return ask(req);
  };
  const evidenceLongAsk = async (req) => {
    const primary = evSearchMode === 'perplexity' && pplxLongAsk ? pplxLongAsk : evSearchMode === 'openai' && gptAsk ? crossAsk : null;
    if (primary) {
      try {
        return await primary(req);
      } catch (e) {
        if (req.signal && req.signal.aborted) throw e;
      }
    }
    return askLonger(req);
  };
  const crossCheckAsk = evSearchMode === 'perplexity' ? ask : evSearchMode === 'openai' ? (pplxAsk || ask) : crossAsk;
  const crossChecked = async (claim, sentence, v, signal) => {
    if (!crossOn || !v || (v.verdict !== 'supported' && v.verdict !== 'contradicted')) return v;
    if (v.verdict === 'supported' && /\bcontradicts the claim\b/i.test(v.summary || '')) {
      v = { ...v, verdict: 'contradicted' };
    }
    const w = await checkEvidence(crossCheckAsk, { claim, question }, { signal }).catch(() => null);
    if (!w || (w.verdict !== 'supported' && w.verdict !== 'contradicted') || w.verdict === v.verdict) return v;
    const { fixedSentence, lean, ...rest } = v;
    const sources = [...(v.sources || []), ...(w.sources || []).filter((x) => !(v.sources || []).some((y) => y.url === x.url))];
    console.log(JSON.stringify({ evt: 'eves_cross', first: v.verdict, second: w.verdict }));
    return { ...rest, verdict: 'unresolved', sources, summary: `Two web checks disagree. ${v.summary || ''} ${w.summary || ''}`.trim(), crossDisagreed: true };
  };

  const anchorLane = lanes.length;
  const ownAnchor = isSlideDeckTurn ? null : plan.anchor;
  let anchorName = ownAnchor ? ownAnchor.modelName : '';
  const secondLane = anchorLane + 1;
  const nameOf = (lane) => (lane === anchorLane && ownAnchor ? `${anchorName} (with web search)` : lane === secondLane && secondAsk ? `${plan.second.modelName} (with web search)` : plan.lanes[lane]?.modelName ?? `Answer ${lane + 1}`);
  const partial = Array.from({ length: lanes.length }, () => '');

  const runLane = async (i, choice, requestObj, signal, messagesOverride = body.messages) => {
    const t0 = Date.now();
    if (signal.aborted) {
      write('done', { lane: i, finish: 'aborted' });
      return { lane: i, text: '', finish: 'aborted', ms: 0, costUSD: 0, citations: [] };
    }
    const model = modelOf(choice.model);
    const citations = [];
    const r = await streamCall(
      { model, request: requestObj, messages: messagesOverride, system, key: cfg.keys[model.provider].key, fallbackKeys: cfg.keys[model.provider].fallbackKeys, base: cfg.base, inputTokens },
      {
        signal,
        emit: (type, data) => {
          if (type === 'text' && data && data.text) partial[i] = (partial[i] || '') + data.text;
          if (type === 'citations' && Array.isArray(data.sources)) {
            for (const c of data.sources) if (c && typeof c.url === 'string' && citations.length < 50) citations.push({ title: String(c.title ?? ''), url: c.url });
          }
          write(type, { lane: i, ...data });
        },
      },
    );
    if (r.usage) charge(model.provider, r.costUSD, { feature: 'eves', model: model.id || model.name, tin: r.usage.inputTokens, tout: r.usage.outputTokens });
    const f = metered(cfg.keys, model.provider) ? helpers.creditFactor(hold || allow) : 1;
    const costUSD = round6((r.costUSD || 0) * f);
    if (r.failure && !r.stopped) {
      write('error', { lane: i, message: r.failure });
      return { lane: i, text: r.text || '', finish: 'error', ms: Date.now() - t0, costUSD, citations };
    }
    if (r.citations && r.citations.length) {
      for (const c of r.citations) if (c && typeof c.url === 'string' && citations.length < 50) citations.push({ title: String(c.title ?? ''), url: c.url });
      write('citations', { lane: i, sources: r.citations });
    }
    if (r.usage && !r.stopped) {
      const u = r.usage;
      write('usage', {
        lane: i,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        reasoningTokens: u.reasoningTokens,
        costUSD,
        notional: false,
        ...(metered(cfg.keys, model.provider) ? {} : { ownKey: true }),
        ...(top ? { topUSD: round6(usageUSD(top, u) * f) } : {}),
      });
    }
    const finish = r.stopped ? 'aborted' : r.finish || 'stop';
    write('done', { lane: i, finish });
    if (finish === 'stop' || finish === 'length') seenCitations(citations);
    return { lane: i, text: r.text || '', finish, ms: Date.now() - t0, costUSD, citations };
  };

  const searchedUser = () => {
    const earlier = body.messages
      .slice(-7, -1)
      .map((m) => `${m.role}: ${clip(helpers.messageText(m).replace(/\s+/g, ' ').trim(), 600)}`)
      .filter((l) => !/:\s*$/.test(l));
    return earlier.length ? `The conversation so far, for context:\n${earlier.join('\n')}\n\nThe question:\n${question}` : question;
  };
  const anchorCall = async () => {
    if (!ownAnchor) return null;
    const t0 = Date.now();
    try {
      const user = searchedUser();
      const imgAtts = (last.attachments || []).filter((a) => a.kind === 'image');
      const anchorUses = fixes.noEarlyCut && premiseTurn(question) ? STRONG_ANCHOR_USES : STRONG_SECOND_USES;
    const r = await anchorAsk({ system: ANCHOR_SYSTEM, user, tier: 'strong', purpose: 'anchor', search: true, ...(plan.anchorGpt ? { uses: anchorUses } : {}), maxTokens: Math.max(32_768, ANCHOR_OUTPUT_TOKENS), temperature: 0, ...(imgAtts.length ? { attachments: imgAtts } : {}), signal: abort.signal });
      if (!String(r.text ?? '').trim()) return null;
      seenCitations(r.citations);
      return { lane: anchorLane, text: r.text, finish: 'stop', ms: Date.now() - t0, costUSD: round6((r.costUSD || 0) * anchorFactor()), citations: (r.citations ?? []).slice(0, 50) };
    } catch {
      return null;
    }
  };
  // EVES_STRONG: the second searched answer, same prompt and context as the anchor; a failure or a timeout is null (today's turn)
  const secondCall = async () => {
    if (!secondAsk || !ownAnchor) return null;
    const t0 = Date.now();
    const log = (ok, extra = {}) => console.log(JSON.stringify({ evt: 'eves_second', model: plan.second.model, ok, ms: Date.now() - t0, turn: id, ...extra }));
    try {
      const imgAtts = (last.attachments || []).filter((a) => a.kind === 'image');
      const r = await secondAsk({ system: ANCHOR_SYSTEM, user: searchedUser(), tier: 'strong', purpose: 'anchor', search: true, uses: STRONG_SECOND_USES, maxTokens: Math.max(32_768, ANCHOR_OUTPUT_TOKENS), temperature: 0, ...(imgAtts.length ? { attachments: imgAtts } : {}), signal: abort.signal });
      if (!String(r.text ?? '').trim()) return (log(false, { why: 'empty' }), null);
      seenCitations(r.citations);
      log(true, { citations: (r.citations ?? []).length, usd: round6(r.costUSD || 0) });
      return { lane: secondLane, text: r.text, finish: 'stop', ms: Date.now() - t0, costUSD: round6((r.costUSD || 0) * secondFactor()), citations: (r.citations ?? []).slice(0, 50) };
    } catch (e) {
      log(false, { why: clip((e && e.message) || 'failed', 120) });
      return null;
    }
  };

  // EVES_PREMISE: what the question takes for granted (one cheap call), each through the web evidence check
  const premiseCheck = async () => {
    const r = await ask({ system: PREMISE_SYSTEM, user: premisePrompt(question), tier: 'cheap', purpose: 'premise', maxTokens: 500, temperature: 0, signal: abort.signal });
    const claims = parsePremises(r.text).slice(0, PREMISE_EVIDENCE_MAX);
    return Promise.all(claims.map(async (c, i) => ({ id: `premise:${i + 1}`, text: c.text, kind: c.kind, v: await evidenceFor(c.text, c.kind, undefined, abort.signal).then((v) => crossChecked(c.text, undefined, v, abort.signal)).catch(() => null) })));
  };
  /** EVES_PREMISE: the kept answer written again by its own model, with Eden's note that a premise is false; null on a failure. */
  const rewriteAnchor = async (bad, prev, promoted) => {
    const t0 = Date.now();
    try {
      const note = premiseNote({ text: bad.text, reason: bad.v.summary, sources: bad.v.sources });
      const viaGpt = plan.anchorGpt && !promoted;
      const r = await (viaGpt ? anchorAsk : baseAsk)({ system: `${ANCHOR_SYSTEM}\n\n${note}`, user: searchedUser(), tier: 'strong', purpose: 'anchor', search: true, ...(viaGpt ? { uses: STRONG_SECOND_USES } : {}), maxTokens: Math.max(32_768, ANCHOR_OUTPUT_TOKENS), temperature: 0, signal: abort.signal });
      if (!String(r.text ?? '').trim()) return null;
      seenCitations(r.citations);
      const cites = [...(r.citations ?? []), ...(prev.citations ?? [])].filter((c, i, all) => all.findIndex((x) => x.url === c.url) === i);
      return { ...prev, text: r.text, ms: prev.ms + Date.now() - t0, costUSD: round6(prev.costUSD + (r.costUSD || 0) * (viaGpt ? anchorFactor : factor)()), citations: cites.slice(0, 50) };
    } catch {
      return null;
    }
  };

  const run = async () => {
    const started = Date.now();
    const ping = setInterval(() => {
      if (open) {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          open = false;
        }
      }
    }, 15_000);
    const budget = { timedOut: false, timer: undefined };
    const startBudget = () => {
      if (budget.timer) return;
      budget.timer = setTimeout(() => {
        if (judgeCtrl.signal.aborted) return;
        budget.timedOut = true;
        judgeCtrl.abort();
      }, EVES_TIME_BUDGET_MS);
    };
    const stopBudget = () => {
      if (budget.timer) clearTimeout(budget.timer);
      budget.timer = undefined;
    };

    try {
      const turnId = body.ledger ? body.ledger.turnId : id;
      write('eves', {
        id,
        mode: raw.mode === 'auto' ? 'auto' : 'on',
        lanes: plan.lanes.map((l) => ({ ...l, turnId })),
        judge: plan.judge,
        independence: plan.independence,
        independenceNote: plan.independenceNote,
        estimate: plan.estimate,
        privacy: false,
        notes: plan.notes,
        turnId,
        ...(ownAnchor ? { anchor: { lane: anchorLane, model: ownAnchor.model, name: anchorName, given: false } } : {}),
        ...(secondAsk && ownAnchor ? { second: { lane: secondLane, model: plan.second.model, name: plan.second.modelName } } : {}),
      });
      if (body.ledger && body.ledger.tainted) write('provenance', body.ledger.summary());

      // ── Immutable Verified Vault (2-Tier + 3-Gate exact/vector lookup before spawning lanes) ──
      const hasAttachments = Array.isArray(last?.attachments) && last.attachments.length > 0;
      const vaultEnabled = raw.vault !== false && env?.EDEN_EVES_VAULT !== 'off';
      const vaultQueryImm = vaultEnabled
        ? assessQueryImmutability(question, {
            messageCount: body.messages.length,
            hasAttachments,
            hasSources: Boolean(body.sources && body.sources.length),
            privacy: false,
            allowStandaloneInMultiTurn: true,
          })
        : { immutable: false, reason: 'vault_disabled' };
      const match = vaultQueryImm.immutable
        ? await lookupHostedVaultMatch(env, question, {
            messageCount: body.messages.length,
            hasAttachments,
            hasSources: Boolean(body.sources && body.sources.length),
            privacy: false,
            vault: raw.vault,
            ask,
            signal: abort.signal,
          })
        : null;
      if (match && match.hit && match.entry && !abort.signal.aborted) {
        const hit = match.entry;
        const vaultVerdict = {
          ...hit.verdict,
          judgeCostUSD: 0,
          totalCostUSD: round6(checksState.costUSD),
          summary: `${hit.verdict.summary} (Served from the EVES Verified Vault — timeless verified fact.)`,
        };
        write('eves_stage', { stage: 'finalizing', detail: 'Verified answer found in the EVES Vault' });
        write('verdict', vaultVerdict);
        if (Array.isArray(hit.citations) && hit.citations.length) {
          write('citations', { lane: 'final', sources: hit.citations });
        }
        for (const text of chunks(hit.answerText)) write('text', { lane: 'final', text });
        write('usage', {
          lane: 'final',
          inputTokens: checksState.inputTokens,
          outputTokens: checksState.outputTokens,
          reasoningTokens: checksState.reasoningTokens,
          costUSD: round6(checksState.costUSD),
          notional: checksState.notional,
          calls: checksState.calls,
        });
        write('done', { lane: 'final', finish: 'stop' });
        write('verification', {
          label: {
            ...hit.verification.label,
            kind: 'eves_verified',
            text: 'Verified by EVES Vault',
            severity: 'ok',
          },
          findings: hit.verification.findings,
          added: {
            costUSD: round6(checksState.costUSD),
            latencyMs: Math.max(0, Date.now() - started),
            calls: checksState.calls,
          },
        });
        write('end', {});
        console.log(JSON.stringify({ evt: 'eves_timing', vaultHit: match.tier, cosine: match.cosine, totalMs: Date.now() - started, label: 'eves_verified' }));
        return;
      }

      write('eves_stage', {
        stage: 'answering',
        detail: `Asking ${plan.lanes.map((l) => l.modelName).join(', ')}${ownAnchor ? `, with ${anchorName}’s answer from a web search` : ''}`,
      });
      const premiseP = premiseOn ? premiseCheck().catch(() => []) : null; // EVES_PREMISE, alongside the answers
      const userText = body.messages
        .filter((m) => m.role === 'user')
        .slice(-6)
        .map((m) => helpers.messageText(m))
        .join('\n')
        .slice(0, 20_000);
      const findings = Array.from({ length: anchorLane + (secondAsk ? 2 : 1) }, () => []);
      const checkOne = async (r) => {
        if (!r || !r.text.trim() || (r.finish !== 'stop' && r.finish !== 'length')) return;
        const out = [];
        const aimed = aimedAtJudge(r.text);
        if (aimed) out.push({ check: 'injection', status: 'fail', subject: aimed, detail: 'This answer has text aimed at the AI checking it. That text is ignored, and this answer can’t be picked while another one can.' });
        try {
          const det = await runChecks(r.text, { checks: ALL_CHECKS, userText, citations: r.citations, signal: abort.signal }, {});
          out.push(...det.filter(validFinding));
          if (r.sources && r.sources.length) {
            const insp = checkInspector(r.text, { sources: r.sources, userText });
            if (Array.isArray(insp)) out.push(...insp.filter(validFinding));
          }
        } catch (e) {
          out.push({ check: 'checks', status: 'error', subject: 'checks', detail: `The checks couldn’t run (${clip((e && e.message) || String(e), 160)}).` });
        }
        findings[r.lane] = out;
      };

      // ── Verified quorum (latency without touching the routed models or their efforts) ──
      // Lane 0 is the router's own pick: the model and effort a turn with EVES off would use, streamed live to the reply.
      // The other lanes are slower models; waiting on all of them made EVES 3-4x slower than EVES off. Instead, as soon as
      // lane 0 and at least one independent answer (the web-searched anchor, or another lane) are in, they are compared:
      // when they agree with no numeric/polarity conflict and no failed check (by the deterministic consensus check, or by
      // the agreement model when the wording differs), the answer is verified and the remaining lanes aren't needed. On
      // any disagreement nothing is cut: every lane finishes and the judge + web evidence settle it as before.
      const done = new Map(); // lane -> result, for answers (lanes + anchor) that have finished
      // EVES_STRONG: the agreement check and the judge compare at most 4 answers, so with three lanes, the anchor and the
      // second answer one lane sits out: the one from the second answer's provider (it adds the least), else the last
      const MAX_COMPARED = 4;
      const providerOf = (lane) => (lanes[lane] ? lanes[lane].provider || (modelOf(lanes[lane].model) || {}).provider : null);
      const capCompared = (list) => {
        if (!secondAsk || list.length <= MAX_COMPARED) return list;
        const out = list.slice();
        while (out.length > MAX_COMPARED) {
          const spare = out.filter((r) => r.lane !== 0 && r.lane !== anchorLane && r.lane !== secondLane);
          if (!spare.length) break;
          const drop = spare.find((r) => providerOf(r.lane) === strongExtras.second.model.provider) || spare[spare.length - 1];
          out.splice(out.indexOf(drop), 1);
        }
        return out;
      };
      const usable = (r) =>
        !!r && !!r.text.trim() && (r.finish === 'stop' || r.finish === 'length') && !isClarifyingQuestion(r.text) && !findings[r.lane].some((f) => f.status === 'fail');
      let quorum = null; // { lanes: number[], claims, how } once a quorum agreed and the other lanes were let go
      const notNeeded = new Set();
      let agreementRuns = 0;
      let settled = false; // every lane is in: the full check below decides, the quorum no longer can
      const tried = new Set();
      const inFlightAgreements = new Map(); // key -> Promise<AgreementOutcome>
      const checkedDisagreements = new Set();
      const quorumCtrl = new AbortController();
      abort.signal.addEventListener('abort', () => quorumCtrl.abort(), { once: true });
      const cut = (set, claims, how) => {
        if (noEarlyCut) return; // EVES_NO_EARLY_CUT: every lane is waited for on a premise/named-thing turn
        if (quorum || settled || abort.signal.aborted) return;
        quorum = { lanes: set.map((r) => r.lane), claims, how };
        for (let k = 0; k < laneCtrls.length; k++) {
          if (!done.has(k) && !laneCtrls[k].signal.aborted) {
            notNeeded.add(k);
            laneCtrls[k].abort();
          }
        }
      };
      const consider = async () => {
        if (quorum || settled || lanes.length < 2 || abort.signal.aborted) return;
        // When a web-search anchor is configured, never declare quorum before the web-searched anchor has arrived
        // so unsearched models agreeing from stale training memory can never bypass web search.
        if (ownAnchor && !done.has(anchorLane) && !anchorSettled) return;
        // EVES_STRONG: never before the second searched answer has arrived or failed either
        if (secondAsk && !done.has(secondLane) && !secondSettled) return;
        const first = done.get(0);
        // Quorum requires either Lane 0 + at least 1 other usable answer, OR (when Lane 0 is a slow straggler)
        // the web-searched anchor + at least 2 independent usable lanes.
        const others = [...done.values()].filter((r) => r.lane !== 0 && usable(r));
        const set = capCompared(usable(first) ? [first, ...others] : others.length >= 2 && others.some((r) => r.lane === anchorLane) ? others : []);
        if (set.length < 2) return;
        if (ownAnchor && usable(done.get(anchorLane)) && !set.some((r) => r.lane === anchorLane)) return;
        if (secondAsk && usable(done.get(secondLane)) && !set.some((r) => r.lane === secondLane)) return;
        const texts = set.map((r) => r.text);
        if (sameWords(texts)) return cut(set, [], 'words');
        if (allAbstain(texts)) return cut(set, [], 'abstain');
        const fc = fastConsensusCheck(texts);
        if (fc.agreed) return cut(set, fc.claims, 'words');
        const key = set.map((r) => r.lane).sort((a, b) => a - b).join(',');
        if (tried.has(key) || agreementRuns >= 2) return;
        tried.add(key);
        agreementRuns++;
        const pAgree = checkAgreement(
          ask,
          question,
          set.map((r) => ({ lane: r.lane, text: r.text, findings: findings[r.lane], finish: r.finish === 'length' ? 'length' : 'stop' })),
          { signal: quorumCtrl.signal },
        );
        inFlightAgreements.set(key, pAgree);
        const a = await pAgree;
        if (a.ok && a.agreement.same) cut(set, a.agreement.claims, 'model');
        else if (a.ok && !a.agreement.same) checkedDisagreements.add(key);
      };
      const pending = new Set();
      const arrive = (res) => {
        if (res) done.set(res.lane, res);
        const p = consider().catch(() => {});
        pending.add(p);
        p.finally(() => pending.delete(p));
      };

      let anchorSettled = false;
      let anchorText = '';
      const phaseOneDone = new Set();
      let substantiveDoneCount = 0;
      const doneTexts = [];
      let stragglerTimer;
      const maybeScheduleStragglerCutover = () => {
        const elapsed = Date.now() - started;
        if (substantiveDoneCount >= 2 && lanes.length > 1 && elapsed >= 400 && !stragglerTimer) {
          const graceMs = Math.min(400, Math.max(150, Math.round(elapsed * 0.15)));
          const cutStragglers = () => {
            if (settled || abort.signal.aborted || noEarlyCut) return;
            // Never cut a straggler unless the web-searched anchor has arrived and agrees with zero numeric conflicts.
            if (ownAnchor && (!anchorText || !usable(done.get(anchorLane)))) return;
            // EVES_STRONG: nor before the second searched answer is in (a dissent there keeps every lane)
            if (secondAsk && !secondSettled) return void secondPromise.then(() => !abort.signal.aborted && cutStragglers());
            const inTexts = anchorText ? [...doneTexts, anchorText] : doneTexts.slice();
            if (secondText) inTexts.push(secondText);
            if (fastConsensusCheck(inTexts).hasNumericConflict && !quorum) return;
            for (let k = 0; k < laneCtrls.length; k++) {
              if (phaseOneDone.has(k) || laneCtrls[k].signal.aborted) continue;
              const sofar = partial[k]?.trim();
              if (sofar && !quorum && fastConsensusCheck([...inTexts, sofar]).hasNumericConflict) continue; // a new dissenter: waited for
              notNeeded.add(k);
              laneCtrls[k].abort();
            }
          };
          stragglerTimer = setTimeout(() => (anchorSettled ? cutStragglers() : void anchorPromise.then(() => !abort.signal.aborted && cutStragglers())), graceMs);
        }
      };

      const anchorPromise = anchorCall().then(async (res) => {
        if (res) {
          await checkOne(res);
          if (res.text.trim() && !isClarifyingQuestion(res.text)) anchorText = res.text;
          arrive(res);
        }
        anchorSettled = true;
        return res;
      });
      let secondSettled = false;
      let secondText = '';
      const secondPromise = secondAsk
        ? secondCall().then(async (res) => {
            if (res) {
              await checkOne(res);
              if (res.text.trim() && !isClarifyingQuestion(res.text)) secondText = res.text;
            }
            secondSettled = true;
            arrive(res); // a failure too: the quorum it held back is considered again, as today's turn would
            return res;
          })
        : null;
      const live = (r) => !!r && r.text.trim() !== '' && (r.finish === 'stop' || r.finish === 'length');
      const lanePromises = lanes.map(async (l, i) => {
        const res = await runLane(i, l, lanePlans[i].request, laneCtrls[i].signal);
        phaseOneDone.add(i);
        if (!notNeeded.has(i)) {
          await checkOne(res);
          if (live(res) && !isClarifyingQuestion(res.text)) {
            substantiveDoneCount++;
            doneTexts.push(res.text);
            maybeScheduleStragglerCutover();
          }
          arrive(res);
        }
        return res;
      });

      // ── Follow-up / Clarifying Question Auto-Resolution (speculative: starts as soon as a peer framing is in) ──
      const autoReplyFor = async (target) => {
        const peers = [];
        const bare = buildClarificationAutoReply(question, target.text, []);
        for (const p of lanePromises) {
          const r = await p;
          if (!live(r) || isClarifyingQuestion(r.text)) continue;
          peers.push(r.text);
          const reply = buildClarificationAutoReply(question, target.text, peers);
          if (reply !== bare) return reply;
        }
        return buildClarificationAutoReply(question, target.text, peers);
      };
      const droppedReAsk = new Set();
      let earlyReAskCtrl = null;
      const dropReAsk = (lane) => {
        droppedReAsk.add(lane);
        earlyReAskCtrl?.abort();
      };
      const reAsk = async (target) => {
        const autoReply = await autoReplyFor(target);
        if (abort.signal.aborted || droppedReAsk.has(target.lane) || stoppedSet.has(String(target.lane))) return null;
        write('eves_stage', {
          stage: 'answering',
          detail: `Auto-answering ${nameOf(target.lane)}’s follow-up so it answers the same question as the other models`,
        });
        const followUpMessages = [
          ...body.messages,
          { role: 'assistant', content: target.text },
          { role: 'user', content: autoReply },
        ];
        const retryCtrl = new AbortController();
        earlyReAskCtrl = retryCtrl;
        const onParentAbort = () => retryCtrl.abort();
        laneCtrls[target.lane].signal.addEventListener('abort', onParentAbort, { once: true });
        const retryTimer = setTimeout(() => retryCtrl.abort(), 3_500);
        try {
          return await runLane(target.lane, lanes[target.lane], lanePlans[target.lane].request, retryCtrl.signal, followUpMessages);
        } finally {
          clearTimeout(retryTimer);
          laneCtrls[target.lane].signal.removeEventListener('abort', onParentAbort);
        }
      };
      let earlyReAsk = null;
      let clarifiersSeen = 0;
      lanePromises.forEach((p) => {
        void p.then((res) => {
          if (!live(res) || !isClarifyingQuestion(res.text)) return;
          clarifiersSeen++;
          if (clarifiersSeen === 1 && !abort.signal.aborted && !stoppedSet.has(String(res.lane))) {
            earlyReAsk = { lane: res.lane, done: reAsk(res) };
          } else if (earlyReAsk) {
            dropReAsk(earlyReAsk.lane);
          }
        });
      });

      const results = await Promise.all(lanePromises);
      if (stragglerTimer) clearTimeout(stragglerTimer);
      if (abort.signal.aborted) return;

      const liveLanes = results.filter(live);
      const clarifyingLanes = liveLanes.filter((r) => isClarifyingQuestion(r.text));
      const substantiveLanes = liveLanes.filter((r) => !isClarifyingQuestion(r.text));
      if (clarifyingLanes.length === 1 && substantiveLanes.length >= 1 && !stoppedSet.has(String(clarifyingLanes[0].lane))) {
        const target = clarifyingLanes[0];
        const reAnswered = earlyReAsk && earlyReAsk.lane === target.lane ? await earlyReAsk.done : await reAsk(target);
        if (abort.signal.aborted) return;
        if (reAnswered && live(reAnswered)) {
          results[target.lane] = {
            ...reAnswered,
            costUSD: round6(target.costUSD + reAnswered.costUSD),
            ms: target.ms + reAnswered.ms,
          };
          await checkOne(results[target.lane]);
        }
      } else if (earlyReAsk) {
        dropReAsk(earlyReAsk.lane);
        await earlyReAsk.done;
      }

      // The search anchor is the default winner (the only answer made with web search): always waited for, never dropped after 200ms.
      let anchorRes = await anchorPromise;
      let secondRes = secondPromise ? await secondPromise : null; // EVES_STRONG: waited for like the anchor
      let anchorModel = ownAnchor ? ownAnchor.model : null;
      if (plan.anchorGpt && !anchorRes && secondRes) {
        // EVES_ANCHOR=gpt and GPT's answer failed: Gemini's searched answer is the anchor (never a turn without one)
        anchorRes = { ...secondRes, lane: anchorLane };
        findings[anchorLane] = findings[secondLane];
        anchorName = plan.second.modelName;
        anchorModel = plan.second.model;
        secondRes = null;
      }
      if (pending.size) await Promise.allSettled([...pending]);
      settled = true;
      if (abort.signal.aborted) return;
      // EVES_PREMISE: a premise the web shows false (with sources): the kept answer is written again to correct it (or,
      // if that fails, the correction is added to it); the earlier agreements were about the old answer
      let premiseRows = [];
      let premiseAddition = null;
      let premiseRewritten = false;
      if (premiseP) {
        premiseRows = await premiseP;
        if (abort.signal.aborted) return;
        const bad = premiseRows.find((x) => x.v && x.v.verdict === 'contradicted' && Array.isArray(x.v.sources) && x.v.sources.length);
        if (bad && anchorRes && !alreadyRejectsPremise(anchorRes.text)) {
          write('eves_stage', { stage: 'answering', detail: `The web shows a premise of the question is false: ${anchorName} answers again` });
          const re = await rewriteAnchor(bad, anchorRes, ownAnchor && anchorModel !== ownAnchor.model);
          if (abort.signal.aborted) return;
          if (re) {
            anchorRes = re;
            premiseRewritten = true;
            await checkOne(anchorRes);
            quorum = null;
            inFlightAgreements.clear();
            checkedDisagreements.clear();
          } else {
            premiseAddition = { claimId: bad.id, action: 'fix', replacement: `The question’s premise looks false: ${clip(bad.v.summary, 180)}`, reason: `The web shows the question’s premise is wrong: ${bad.v.summary}` };
          }
        }
      }

      const lanesUSD = results.reduce((n, r) => n + r.costUSD, 0) + (anchorRes?.costUSD ?? 0) + (secondRes?.costUSD ?? 0);
      const allAnswered = [...results.filter((r) => r.text.trim() && (r.finish === 'stop' || r.finish === 'length')), ...(anchorRes ? [anchorRes] : []), ...(secondRes ? [secondRes] : [])];
      const answered = capCompared(allAnswered);
      const ownCalls = results.length + (anchorRes ? 1 : 0) + (secondRes ? 1 : 0);

      const verification = (label, findingsList, winner, repaired) => ({
        label,
        findings: findingsList,
        ...(repaired ? { repaired } : {}),
        added: {
          costUSD: round6(lanesUSD + checksState.costUSD - (winner?.costUSD ?? 0)),
          latencyMs: Math.max(0, Date.now() - started - (winner?.ms ?? 0)),
          calls: ownCalls - (winner ? 1 : 0) + checksState.calls,
        },
      });

      if (!answered.length) {
        const why = results.map((r) => `${nameOf(r.lane)} ${r.finish === 'aborted' ? 'was stopped' : r.finish === 'error' ? 'failed' : 'gave no answer'}`).join(', ');
        const verdict = { winner: null, agreement: 'single', claims: [], corrections: [], skippedJudge: false, summary: `No model answered (${why}), so there was nothing to check.`, judgeCostUSD: 0, totalCostUSD: round6(lanesUSD) };
        write('eves_stage', { stage: 'finalizing' });
        write('verdict', verdict);
        write('error', { lane: 'final', message: `None of the models answered (${why}). Nothing was checked; try again, or pick other models.` });
        write('verification', verification({ kind: 'not_checked', text: 'Not checked: no model answered', detail: verdict.summary, severity: 'bad' }, [], null));
        write('end', {});
        return;
      }

      // If 2 or more models asked a clarifying follow-up question, ask the user to clarify immediately (0ms judge wait)
      const remainingClarifiers = results.filter((r) => r.text.trim() && (r.finish === 'stop' || r.finish === 'length') && isClarifyingQuestion(r.text));
      if (remainingClarifiers.length >= 2) {
        const clarifyWinner = remainingClarifiers[0];
        const mergedQuestion = mergeClarifyingQuestions(remainingClarifiers.map((r) => r.text));
        const clarifyNames = remainingClarifiers.map((r) => nameOf(r.lane)).join(' and ');
        const summary = `${clarifyNames} asked a clarifying question before answering — please clarify what you mean so Eden can check the exact facts.`;
        const verdict = {
          winner: clarifyWinner.lane,
          agreement: 'unanimous',
          claims: [],
          corrections: [],
          skippedJudge: true,
          summary,
          judgeCostUSD: 0,
          totalCostUSD: round6(lanesUSD),
        };
        write('eves_stage', { stage: 'finalizing' });
        write('verdict', verdict);
        for (const text of chunks(mergedQuestion)) write('text', { lane: 'final', text });
        write('usage', { lane: 'final', inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUSD: 0, notional: false, calls: 0 });
        write('done', { lane: 'final', finish: 'stop' });
        write(
          'verification',
          verification(
            {
              kind: 'eves_verified',
              text: `${remainingClarifiers.length} models asked you to clarify`,
              detail: summary,
              severity: 'info',
            },
            [],
            clarifyWinner,
          ),
        );
        write('end', {});
        return;
      }

      // Deterministic checks + INSPECTOR on every answer (already pipelined per-lane as each finished)
      write('eves_stage', { stage: 'checking', detail: `Checking ${plural(answered.length, 'answer')}` });
      for (const r of allAnswered) if (r.lane !== anchorLane && !(secondRes && r.lane === secondLane)) write('checks', { lane: r.lane, findings: findings[r.lane] });

      const flagged = new Set(answered.filter((r) => findings[r.lane].some((f) => f.check === 'injection' && f.status === 'fail')).map((r) => r.lane));
      const eligible = answered.filter((r) => !flagged.has(r.lane));
      const hasDeckFence = (r) => /```(?:deck|deck-patch|slides)\b/i.test(r.text);
      const quality = (r) => (isSlideDeckTurn && hasDeckFence(r) ? 1000 : 0) + (plan.lanes[r.lane]?.quality ?? -1);
      const ranked = [...(eligible.length ? eligible : answered)].sort((a, b) => quality(b) - quality(a) || a.lane - b.lane);
      const anchorOn = !!anchorRes && !flagged.has(anchorLane) && (!isSlideDeckTurn || hasDeckFence(anchorRes));
      const best = anchorOn ? anchorLane : (ranked.find((r) => r.lane !== anchorLane) ?? ranked[0]).lane;
      const checkFlags = (lane) =>
        findings[lane]
          .filter((f) => f.status === 'fail' && f.check !== 'injection' && f.sentence)
          .map((f, i) => ({ claimId: `check:${f.check}:${i + 1}`, action: 'flag', reason: f.detail, sentence: f.sentence }));
      const judgeStopped = () => judgeCtrl.signal.aborted && !budget.timedOut;

      let outcome;
      if (answered.length === 1) {
        const only = answered[0];
        const others = results.filter((r) => r !== only).map((r) => `${nameOf(r.lane)} ${r.finish === 'aborted' ? 'was stopped' : r.finish === 'error' ? 'failed' : 'gave no answer'}`);
        let summary = `Only ${nameOf(only.lane)} answered (${others.join(', ')}), so there was nothing to compare it with.`;
        const claims = [];
        const corrections = checkFlags(only.lane);
        let unplaced = 0;
        const checked = new Map();
        let singleClaims = [];
        if (plan.evidence.maxCalls > 0 && !judgeStopped()) {
          startBudget();
          write('eves_stage', { stage: 'evidence', detail: 'Checking its claims on the web' });
          const ex = await extractClaimsDetailed(ask, only.text, { question, max: 8, signal: judgeCtrl.signal });
          if (abort.signal.aborted) return;
          singleClaims = ex.claims;
          const order = ['number', 'date', 'quote', 'url', 'fact', 'code', 'action', 'other'];
          const picked = [...ex.claims].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).slice(0, plan.evidence.maxCalls);
          await Promise.all(picked.map(async (c) => checked.set(c.id, await evidenceFor(c.text, c.kind, c.sentence, judgeCtrl.signal))));
          if (abort.signal.aborted) return;
          await gemmaPass(gemmaItems(picked, checked));
          if (abort.signal.aborted) return;
          for (const c of ex.claims) {
            const v = checked.get(c.id);
            claims.push({ id: c.id, text: c.text, by: [only.lane], against: [], status: 'unique', verdict: v ? v.verdict : 'unverifiable', ...(v && v.sources.length ? { evidence: { summary: v.summary, sources: v.sources } } : {}), ...(v?.lean ? { lean: v.lean } : {}) });
            if (v?.verdict === 'contradicted') {
              if (!c.sentence) unplaced++;
              else if (v.fixedSentence) corrections.push({ claimId: c.id, action: 'fix', replacement: v.fixedSentence, reason: `The web shows this is wrong: ${v.summary}`, sentence: c.sentence });
              else corrections.push({ claimId: c.id, action: only.lane === anchorLane ? 'flag' : 'strike', reason: `The web shows this is wrong: ${v.summary}`, sentence: c.sentence });
            }
          }
          const ok = [...checked.values()].filter((v) => v.verdict === 'supported').length;
          const bad = [...checked.values()].filter((v) => v.verdict === 'contradicted').length;
          if (picked.length) summary += ` ${plural(picked.length, 'of its claims was', 'of its claims were')} checked on the web: ${ok} confirmed, ${bad} wrong, ${picked.length - ok - bad} not settled.`;
        }
        const evidence = [...checked.entries()].map(([cid, v]) => {
          const c = singleClaims.find((x) => x.id === cid);
          return evidenceFinding(c, v, c.sentence);
        });
        stopBudget();
        outcome = { kind: 'single', winner: only.lane, agreement: 'single', claims, corrections, skippedJudge: false, summary, judgeCostUSD: 0, unplaced, timedOut: budget.timedOut, evidence };
      } else {
        const judgeIn = answered.map((r) => ({ lane: r.lane, text: r.text, findings: findings[r.lane], finish: r.finish === 'length' ? 'length' : 'stop' }));
        const anyFail = answered.some((r) => findings[r.lane].some((f) => f.status === 'fail'));
        const names = answered.map((r) => nameOf(r.lane));
        const fallback = (reason, judgeCostUSD = 0) => ({
          kind: 'fallback',
          winner: best,
          agreement: 'split',
          claims: [],
          corrections: checkFlags(best),
          skippedJudge: false,
          summary: `The check could not be completed (${reason}), so this is ${nameOf(best)}’s answer as it came, not verified.`,
          judgeCostUSD,
          unplaced: 0,
          timedOut: false,
          evidence: [],
        });
        const ranOut = (judgeCostUSD = 0) => ({
          ...fallback('', judgeCostUSD),
          summary: `The checking ran out of time (${round1(EVES_TIME_BUDGET_MS / 1000)} s), so this is ${nameOf(best)}’s answer as it came, partly checked.`,
          timedOut: true,
        });

        let agreed = null;
        let how = 'model';
        let earlyJudge = null;
        const evKey = (claim, sentence) => `${claim}\u0000${sentence ?? ''}`;
        const earlyEvidence = new Map();
        const winnerOf = (w) => (anchorOn ? anchorLane : flagged.has(w) && eligible.length ? best : w);
        const textOfLane = (lane) => (answered.find((r) => r.lane === lane) || answered[0]).text;
        const sentenceFor = (c, winner) => c.quotes[winner] || findSentenceForClaim(textOfLane(winner), c.text);
        let holdEvidence = false;
        let lastPartial = null;
        const spawnEarlyEvidence = (claimText, sent, room, kind) => {
          const k = evKey(claimText, sent);
          if (earlyEvidence.has(k) || earlyEvidence.size >= room) return;
          const ctrl = new AbortController();
          const stop = () => ctrl.abort();
          judgeCtrl.signal.addEventListener('abort', stop, { once: true });
          const done = evidenceFor(claimText, kind, sent, ctrl.signal);
          void done.finally(() => judgeCtrl.signal.removeEventListener('abort', stop)).catch(() => undefined);
          earlyEvidence.set(k, { ctrl, done, claimText, sentence: sent });
        };
        const startEarlyEvidence = (partial) => {
          if (judgeCtrl.signal.aborted || (!anchorOn && partial.winner === null)) return;
          const winner = winnerOf(partial.winner ?? anchorLane);
          const sure = partial.claims.length;
          const pendingSent = partial.pending ? sentenceFor(partial.pending, winner) : undefined;
          const seen = partial.pending && pendingSent ? [...partial.claims, partial.pending] : partial.claims;
          const disputed = seen.filter((c) => c.status === 'disputed' && (c.by.includes(winner) || c.against.includes(winner)));
          const room = plan.evidence.maxCalls + (seen.length > sure ? 0 : 1);
          for (const c of disputed.slice(0, plan.evidence.maxCalls)) {
            const sent = sentenceFor(c, winner);
            spawnEarlyEvidence(c.text, sent, room, c.kind);
          }
        };
        // Reused only for the exact claim and sentence it checked: a check of another claim that quotes the same sentence
        // answers a different question (H1, askeden/docs/verify/latency-plan-2026-10-24.md).
        const findEarlyEvidence = (claimText, sent) => earlyEvidence.get(evKey(claimText, sent));
        const onClaims =
          plan.evidence.maxCalls > 0
            ? (partial) => {
                lastPartial = partial;
                if (!holdEvidence) startEarlyEvidence(partial);
              }
            : undefined;
        const stopEarlyEvidence = () => {
          for (const e of earlyEvidence.values()) e.ctrl.abort();
        };

        const texts = answered.map((r) => r.text);
        const fast = fastConsensusCheck(texts);
        // No web checks of the answers' raw disputed sentences before the judge (removed 2026-10-24): under the exact-key
        // rule above they are reused only when the judge copies a sentence word for word, so they mostly cost paid searches
        // and took the early slots the judge's own claims need (askeden/docs/verify/latency-plan-2026-10-24.md).
        if (!anyFail) {
          if (sameWords(texts)) {
            agreed = [];
            how = 'words';
          } else if (allAbstain(texts)) {
            agreed = [];
            how = 'abstain';
          } else if (fast.agreed) {
            agreed = fast.claims;
            how = 'words';
          }
          if (!agreed && quorum && answered.every((r) => quorum.lanes.includes(r.lane))) {
            // the agreement model already found these exact answers saying the same thing (the quorum above)
            agreed = quorum.claims;
            how = quorum.how;
          }
          const answeredKey = answered.map((r) => r.lane).sort((a, b) => a - b).join(',');
          const reusableQuorumAgree = !quorum ? inFlightAgreements.get(answeredKey) : null;
          for (const [k, _p] of inFlightAgreements) {
            if (k !== answeredKey && !quorum) quorumCtrl.abort();
          }
          if (!agreed && (!fast.hasNumericConflict || reusableQuorumAgree) && !checkedDisagreements.has(answeredKey) && !judgeStopped()) {
            startBudget();
            write('eves_stage', { stage: 'judging', detail: 'Checking whether the answers agree' });
            const pendingAgree = reusableQuorumAgree || checkAgreement(ask, question, judgeIn, { signal: judgeCtrl.signal });
            const spec = new AbortController();
            const stopSpec = () => spec.abort();
            judgeCtrl.signal.addEventListener('abort', stopSpec, { once: true });
            holdEvidence = true;
            earlyJudge = judgeAnswers(ask, question, judgeIn, { signal: spec.signal, ...(onClaims ? { onClaims } : {}) });
            void earlyJudge.finally(() => judgeCtrl.signal.removeEventListener('abort', stopSpec)).catch(() => undefined);
            const a = await pendingAgree;
            if (abort.signal.aborted) return;
            if (a.ok && a.agreement.same) {
              agreed = a.agreement.claims;
              spec.abort();
              earlyJudge = null;
              stopEarlyEvidence();
            } else {
              holdEvidence = false;
              if (lastPartial) startEarlyEvidence(lastPartial);
            }
          }
        } else {
          quorumCtrl.abort();
        }

        if (agreed) {
          const by = answered.map((r) => r.lane);
          outcome = {
            kind: 'agreed',
            winner: best,
            agreement: 'unanimous',
            claims: agreed.map((c, i) => ({ id: `c${i + 1}`, text: c.text, by, against: [], status: 'agreed', verdict: 'supported' })),
            corrections: [],
            skippedJudge: true,
            summary:
              how === 'abstain'
                ? `${answered.length} models agreed (${names.join(', ')}): none of them found anything to confirm, or said it doesn’t exist, so no further check was needed. This is ${nameOf(best)}’s answer.`
                : `${answered.length} models agreed (${names.join(', ')}), so the judge wasn’t needed. This is ${nameOf(best)}’s answer.${notNeeded.size ? ` ${[...notNeeded].map(nameOf).join(' and ')} ${notNeeded.size === 1 ? 'wasn’t' : 'weren’t'} waited for once they agreed.` : ''}`,
            judgeCostUSD: 0,
            unplaced: 0,
            timedOut: false,
            evidence: [],
          };
        } else if (budget.timedOut) {
          outcome = ranOut();
        } else if (judgeStopped()) {
          outcome = fallback('you stopped it');
        } else {
          startBudget();
          write('eves_stage', { stage: 'judging', detail: `${plan.judge?.modelName ?? 'A strong model'} is comparing the answers claim by claim` });
          holdEvidence = false;
          let j = await (earlyJudge ?? judgeAnswers(ask, question, judgeIn, { signal: judgeCtrl.signal, ...(onClaims ? { onClaims } : {}) }));
          if (abort.signal.aborted) return;
          // EVES_HEDGE_UNRESOLVED: a judge reply that couldn't be read gets one more try instead of an unchecked answer
          if (!j.ok && hedgeOn && !judgeStopped() && !budget.timedOut && /JSON|list of claims|could be read|pick one of the answers/.test(String(j.reason || ''))) {
            const spent = j.costUSD || 0;
            const again = await judgeAnswers(ask, question, judgeIn, { signal: judgeCtrl.signal });
            if (abort.signal.aborted) return;
            j = { ...again, costUSD: (again.costUSD || 0) + spent };
          }
          if (!j.ok) {
            stopEarlyEvidence();
            outcome = judgeStopped() ? fallback('you stopped it', j.costUSD) : budget.timedOut ? ranOut(j.costUSD) : fallback(j.reason, j.costUSD);
          } else {
            const judgment = j.judgment;
            let winner = judgment.winner;
            let summary = unletter(judgment.summary, j.presentation, nameOf);
            const winnerEntry = answered.find((r) => r.lane === winner);
            if (isSlideDeckTurn && (!winnerEntry || !hasDeckFence(winnerEntry)) && hasDeckFence(answered.find((r) => r.lane === best) || answered[0])) {
              winner = best;
            } else if (anchorOn) {
              winner = anchorLane;
              summary = '';
            } else if (flagged.has(winner) && eligible.length) {
              summary = `${summary ? `${summary} ` : ''}The judge picked ${nameOf(winner)}’s answer, which has text aimed at the judge, so it was set aside for ${nameOf(best)}’s.`;
              winner = best;
            }
            const winEntry = answered.find((r) => r.lane === winner) || answered[0];
            const judged = judgment.claims;
            const involves = (c) => c.by.includes(winner) || c.against.includes(winner);
            const addable = (c) => c.status === 'unique' && c.missingFromWinner && c.essential && c.by.length >= 2 && !involves(c);
            const queue = [...judged.filter((c) => c.status === 'disputed' && involves(c)), ...judged.filter(addable).slice(0, 1)].slice(0, plan.evidence.maxCalls);
            const matchedEarly = new Map();
            const reusedEntries = new Set();
            for (const c of queue) {
              const sent = sentenceFor(c, winner);
              const found = findEarlyEvidence(c.text, sent);
              if (found && !reusedEntries.has(found)) {
                matchedEarly.set(c.id, found);
                reusedEntries.add(found);
              }
            }
            for (const e of earlyEvidence.values()) if (!reusedEntries.has(e)) e.ctrl.abort();
            const checked = new Map();
            if (queue.length && !judgeStopped()) {
              write('eves_stage', { stage: 'evidence', detail: `Checking ${plural(queue.length, 'claim')} on the web` });
              await Promise.all(
                queue.map(async (c) => {
                  const sent = sentenceFor(c, winner);
                  const early = matchedEarly.get(c.id);
                  checked.set(c.id, await (early ? early.done : evidenceFor(c.text, c.kind, sent, judgeCtrl.signal)));
                }),
              );
              if (abort.signal.aborted) return;
              if (hedgeOn) {
                // EVES_HEDGE_UNRESOLVED: a disputed claim the web check didn't settle gets one more try, with a longer timeout
                const again = queue.filter((c) => c.status === 'disputed' && (!checked.get(c.id) || checked.get(c.id).verdict === 'unresolved'));
                await Promise.all(again.map(async (c) => checked.set(c.id, await evidenceFor(c.text, c.kind, sentenceFor(c, winner), abort.signal, evidenceLongAsk).catch(() => checked.get(c.id)))));
                if (abort.signal.aborted) return;
              }
              if (crossOn) {
                await Promise.all(queue.map(async (c) => checked.set(c.id, await crossChecked(c.text, sentenceFor(c, winner), checked.get(c.id), judgeCtrl.signal))));
                if (abort.signal.aborted) return;
              }
              await gemmaPass(gemmaItems(queue, checked));
              if (abort.signal.aborted) return;
            } else stopEarlyEvidence();
            if (hedgeOn && anchorOn && secondRes && winner === anchorLane && !flagged.has(secondLane)) {
              const anchorEntry = answered.find((r) => r.lane === anchorLane);
              const secondEntry = answered.find((r) => r.lane === secondLane);
              if (
                anchorEntry &&
                secondEntry &&
                (!isSlideDeckTurn || hasDeckFence(secondEntry)) &&
                /[.!?]\s+\S/.test((anchorEntry.text || '').trim())
              ) {
                const disputed0 = judged.filter((c) => c.status === 'disputed');
                let secondWins = 0, anchorWins = 0, secondWrong = 0;
                for (const c of disputed0) {
                  const vd = checked.get(c.id)?.verdict;
                  const by = c.by || [], ag = c.against || [];
                  if ((by.includes(secondLane) && ag.includes(anchorLane) && vd === 'supported') || (by.includes(anchorLane) && ag.includes(secondLane) && vd === 'contradicted')) secondWins++;
                  if ((by.includes(anchorLane) && vd === 'supported') || (ag.includes(anchorLane) && vd === 'contradicted')) anchorWins++;
                  if ((by.includes(secondLane) && vd !== 'supported') || (ag.includes(secondLane) && vd === 'supported')) secondWrong++;
                }
                if (secondWins > 0 && anchorWins === 0 && secondWrong === 0) winner = secondLane;
              }
            }
            const corrections = checkFlags(winner);
            let unplaced = 0;
            const leaning = [];
            let unconfirmed = 0;
            const claims = judged.map((c) => {
              const v = checked.get(c.id);
              const verdict = c.status === 'agreed' ? 'supported' : v ? v.verdict : c.status === 'disputed' ? 'unresolved' : 'unverifiable';
              const s = sentenceFor(c, winner);
              if (c.status === 'disputed' && involves(c)) {
                const makes = c.by.includes(winner);
                const wrong = (makes && verdict === 'contradicted') || (!makes && verdict === 'supported');
                const right = (makes && verdict === 'supported') || (!makes && verdict === 'contradicted');
                if (wrong && v) {
                  if (!s) unplaced++;
                  else if (v.fixedSentence) corrections.push({ claimId: c.id, action: 'fix', replacement: v.fixedSentence, reason: `The web shows this is wrong: ${v.summary}`, sentence: s });
                  else if (anchorOn) corrections.push({ claimId: c.id, action: 'flag', reason: `The web shows this is wrong (${v.summary}) and there was no safe one-sentence fix, so it is marked.`, sentence: s });
                  else corrections.push({ claimId: c.id, action: 'strike', reason: `The web shows this is wrong (${v.summary}) and there was no safe one-sentence fix.`, sentence: s });
                } else if (!right && s) {
                  const cutShort = budget.timedOut && (!v || v.verdict === 'unresolved');
                  const why = !plan.evidence.maxCalls ? 'it couldn’t be checked on the web' : v ? 'the web check didn’t settle it' : 'it wasn’t checked on the web';
                  if (hedgeOn) {
                    // EVES_HEDGE_UNRESOLVED: a disputed claim the web couldn't settle (timed out or unresolved) is not stated as fact
                    corrections.push({ claimId: c.id, action: 'fix', replacement: `I couldn’t verify this on the web: ${s.trim()}`, reason: `Another model disputes this and ${why}, so it is not stated as fact.`, sentence: s });
                  } else if (cutShort) {
                    // left as it came
                  } else if (anchorOn) {
                    const otherSide = (makes ? c.against : c.by).some((l) => l !== anchorLane);
                    const leansAgainst = makes ? v?.lean === 'contradicted' : v?.lean === 'supported';
                    if (otherSide && leansAgainst) leaning.push({ claimId: c.id, action: 'flag', reason: 'Another model disputes this and the web check leaned against it without naming sources, so it is marked.', sentence: s });
                    else unconfirmed++;
                  } else corrections.push({ claimId: c.id, action: 'flag', reason: `The models disagree on this and ${why}.`, sentence: s });
                }
              } else if (addable(c) && verdict === 'supported' && v) {
                corrections.push({ claimId: c.id, action: 'fix', replacement: c.text, reason: `${nameOf(c.by[0])} said this, ${nameOf(winner)} left it out, and the web supports it.` });
              }
              return {
                id: c.id,
                text: c.text,
                by: c.by,
                against: c.against,
                status: c.status,
                verdict,
                ...(v && v.sources.length ? { evidence: { summary: v.summary, sources: v.sources } } : {}),
                ...(v?.lean ? { lean: v.lean } : {}),
              };
            });
            if (leaning.length) {
              const marked = corrections.some((x) => x.sentence);
              if (!marked) corrections.push(leaning[0]);
              unconfirmed += leaning.length - (marked ? 0 : 1);
            }
            const disputed = judged.filter((c) => c.status === 'disputed');
            if (anchorOn) {
              const k = disputed.filter(involves).length;
              summary =
                winner === secondLane
                  ? `${nameOf(secondLane)} also searched the web, and the web check confirmed its disputed claim against ${nameOf(anchorLane)}’s answer, so ${nameOf(secondLane)}’s answer is the one kept.`
                  : `${nameOf(anchorLane)} searched the web, so its answer is the one kept: answers from models that did not search can’t replace it.` +
                    (k ? ` The other models disputed ${plural(k, 'claim')} in it${queue.length ? `; ${queue.length === k ? (k === 1 ? 'it was' : 'they were') : `${queue.length} of them ${queue.length === 1 ? 'was' : 'were'}`} checked on the web` : ''}.` : ' The other models disputed none of its claims.');
            }
            const majority = disputed.every((c) => Math.max(c.by.length, c.against.length) >= 2 && c.by.length !== c.against.length);
            outcome = {
              kind: 'judged',
              winner,
              agreement: !disputed.length ? 'unanimous' : majority ? 'majority' : 'split',
              claims,
              corrections,
              skippedJudge: false,
              summary: summary || `${plan.judge?.modelName ?? 'The judge'} compared ${answered.length} answers claim by claim and picked ${nameOf(winner)}’s.`,
              judgeCostUSD: j.costUSD,
              unplaced,
              timedOut: budget.timedOut && queue.some((c) => { const v = checked.get(c.id); return !v || v.verdict === 'unresolved'; }),
              unconfirmed,
              evidence: [...checked.entries()].map(([cid, v]) => {
                const c = judged.find((x) => x.id === cid);
                return evidenceFinding(c, v, sentenceFor(c, winner));
              }),
            };
          }
          stopEarlyEvidence();
        }
      }

      stopBudget();
      write('eves_stage', { stage: 'finalizing' });
      const win = outcome.winner === anchorLane && anchorRes ? anchorRes : secondRes && outcome.winner === secondLane ? secondRes : results[outcome.winner];
      const additions = { maxAdditions: 1, additionMaxChars: 200 };
      if (premiseAddition && win === anchorRes) outcome.corrections.push(premiseAddition);
      let fixed = applyCorrections(win.text, outcome.corrections, additions);
      let summary = outcome.summary;
      if (premiseRewritten) summary += ' The web showed a premise of the question to be false, so the answer was written again to correct it.';
      const answerPart = (t) => (fixed.added.length ? t.slice(0, Math.max(0, t.lastIndexOf(`\n\n*${ADDED_LEAD}*`))) : t);
      let keptWhole = 0;
      if (fixed.struck.length && !/[\p{L}\p{N}]/u.test(answerPart(fixed.text))) {
        const asFlags = outcome.corrections.map((c) => (c.action === 'strike' ? { ...c, action: 'flag', reason: `${c.reason} Removing it would have left no answer, so it is marked instead.` } : c));
        fixed = applyCorrections(win.text, asFlags, additions);
        keptWhole = outcome.corrections.filter((c) => c.action === 'strike').length;
        summary += ' Removing the wrong sentences would have left no answer, so they are kept and marked unverified instead.';
      }
      const corrected = fixed.applied.filter((c) => c.action !== 'flag' || c.claimId.startsWith('check:'));
      const unresolved = outcome.claims.filter((c) => c.status === 'disputed' && (c.by.includes(outcome.winner) || c.against.includes(outcome.winner)) && c.verdict !== 'supported' && c.verdict !== 'contradicted');
      const refusedFixes = fixed.rejected.filter((c) => c.sentence && !fixed.notFound.includes(c)).length;
      const unplaced = outcome.unplaced + fixed.notFound.filter((c) => c.action !== 'flag').length + refusedFixes + keptWhole;
      if (unplaced) summary += ` ${plural(unplaced, 'claim')} the web shows to be wrong couldn’t be corrected in place; read it with care.`;
      const verdict = {
        winner: outcome.winner,
        agreement: outcome.agreement,
        claims: outcome.claims,
        corrections: fixed.applied.map(({ sentence: _s, ...c }) => c),
        skippedJudge: outcome.skippedJudge,
        summary,
        judgeCostUSD: round6(outcome.judgeCostUSD),
        totalCostUSD: round6(lanesUSD + checksState.costUSD),
        ...(outcome.timedOut ? { timedOut: true } : {}),
        ...(anchorRes ? { anchor: { lane: anchorLane, model: anchorModel, name: anchorName, given: false } } : {}),
        ...(secondRes ? { second: { lane: secondLane, model: plan.second.model, name: plan.second.modelName } } : {}),
        ...(premiseRows.length
          ? {
              premises: premiseRows.map((x) => ({ id: x.id, text: x.text, verdict: x.v ? x.v.verdict : 'unresolved', ...(x.v && x.v.sources && x.v.sources.length ? { evidence: { summary: x.v.summary, sources: x.v.sources } } : {}) })),
              ...(premiseRewritten ? { premiseCorrected: true } : {}),
            }
          : {}),
      };
      write('verdict', verdict);
      const citeSeen = new Set();
      const finalCitations = [];
      const addCites = (list) => {
        for (const c of list || []) {
          if (c && typeof c.url === 'string' && c.url && !citeSeen.has(c.url) && finalCitations.length < 50) {
            citeSeen.add(c.url);
            finalCitations.push({ title: String(c.title ?? ''), url: c.url });
          }
        }
      };
      addCites(win?.citations);
      if (anchorRes && anchorRes !== win) addCites(anchorRes.citations);
      for (const c of outcome.claims || []) addCites(c.evidence?.sources);
      if (finalCitations.length) write('citations', { lane: 'final', sources: finalCitations });
      for (const text of chunks(fixed.text)) write('text', { lane: 'final', text });
      write('usage', {
        lane: 'final',
        inputTokens: checksState.inputTokens,
        outputTokens: checksState.outputTokens,
        reasoningTokens: checksState.reasoningTokens,
        costUSD: round6(checksState.costUSD),
        notional: checksState.notional,
        calls: checksState.calls,
      });
      write('done', { lane: 'final', finish: win.finish });

      const n = answered.length;
      const caveat = plan.independence === 'none' && plan.independenceNote ? ` ${plan.independenceNote}` : '';
      let label;
      const late = outcome.timedOut ? ' Time ran out before every claim was checked.' : '';
      if (corrected.length) {
        const parts = [
          fixed.fixed.length && `${plural(fixed.fixed.length, 'sentence')} fixed`,
          fixed.struck.length && `${plural(fixed.struck.length, 'sentence')} removed`,
          fixed.added.length && `${plural(fixed.added.length, 'missing claim')} added`,
          fixed.flagged.length && `${plural(fixed.flagged.length, 'sentence')} marked unverified`,
        ].filter(Boolean);
        label = {
          kind: 'issues_found',
          text: `Corrected after checking: ${plural(corrected.length, 'claim')}`,
          detail: `${parts.join(', ')}. ${summary}${late}${outcome.unconfirmed ? ' Some other details could not be confirmed on the web; they are not marked in the text.' : ''}`,
          severity: 'warn',
        };
      } else if (outcome.kind === 'single') {
        label = { kind: 'eves_disputed', text: 'Not cross-checked: only 1 model answered', detail: `${summary}${late}`, severity: 'warn' };
      } else if (outcome.timedOut) {
        label = partlyCheckedLabel(summary);
      } else if (outcome.kind === 'fallback') {
        label = { kind: 'eves_disputed', text: 'Not verified: the check could not be completed', detail: summary, severity: 'warn' };
      } else if (unresolved.length || unplaced) {
        const u = unresolved.length + unplaced;
        const quiet = outcome.unconfirmed ? ' Some details could not be confirmed on the web; they are not marked in the text.' : '';
        label = {
          kind: 'eves_disputed',
          text: `${plural(u, 'disputed claim')} not settled`,
          detail: `${summary}${fixed.flagged.length ? ` ${plural(fixed.flagged.length, 'sentence')} marked unverified.` : ''}${quiet}`,
          severity: 'warn',
        };
      } else {
        label = {
          kind: 'eves_verified',
          text: outcome.skippedJudge ? `${n} models agreed` : `Checked by ${n} models${outcome.evidence.length ? ' and the web' : ''}`,
          detail: `${summary}${caveat}`,
          severity: plan.independence === 'none' ? 'info' : 'ok',
        };
      }
      const allFindings = [
        ...findings[outcome.winner],
        ...answered.filter((r) => r.lane !== outcome.winner).flatMap((r) => findings[r.lane].filter((f) => f.check === 'injection')),
        ...outcome.evidence,
        ...premiseRows.filter((x) => x.v).map((x) => evidenceFinding(x, x.v)),
      ];
      const repaired = fixed.struck.length || fixed.flagged.length || fixed.fixed.length ? { struck: [...fixed.struck, ...fixed.fixed.map((f) => f.from), ...fixed.flagged], regenerated: false } : undefined;
      const verificationEvent = verification(label, allFindings, win, repaired);
      if (
        vaultQueryImm.immutable &&
        isEligibleForVaultStorage({
          question,
          messageCount: body.messages.length,
          hasAttachments,
          hasSources: Boolean(body.sources && body.sources.length),
          privacy: false,
          answerText: fixed.text,
          verdict,
          verification: verificationEvent,
        })
      ) {
        const qFp = fingerprintQuestion(question);
        const vectorB64 = await embedVaultQuestion(env, question);
        const vaultEntry = {
          canonicalHash: qFp.canonicalHash,
          question,
          fingerprint: qFp,
          vectorB64,
          answerText: fixed.text,
          citations: finalCitations,
          verdict,
          verification: verificationEvent,
          createdAt: Date.now(),
        };
        await getMemoryVault(env).putEntry(vaultEntry).catch(() => {});
        void putEvesVault(env, vaultEntry).catch(() => {});
      }
      write('verification', verificationEvent);
      write('end', {});

      // timings only (no text): EVES's added latency over lane 0, the answer a turn with EVES off would have given
      console.log(JSON.stringify({ evt: 'eves_timing', lane0Ms: results[0]?.ms ?? null, anchorMs: anchorRes?.ms ?? null, ...(secondAsk ? { secondMs: secondRes?.ms ?? null } : {}), totalMs: Date.now() - started, quorum: quorum ? quorum.how : null, kind: outcome.kind, label: label.kind, lanes: results.map((r) => [r.finish, r.ms]) }));
    } catch (error) {
      write('error', { message: error instanceof ApiError ? error.message : 'Something went wrong on the server.' });
      write('end', {});
      if (!(error instanceof ApiError)) console.error('hosted eves failed', error && error.stack);
    } finally {
      clearInterval(ping);
      stopBudget();
      evesRuns.delete(id);
      if (open) {
        open = false;
        try {
          controller.close();
        } catch {
          // already gone
        }
      }
      await counted;
      if (hold) await call(env, who.account, 'release-ai', { hold: hold.hold }).catch(() => {});
    }
  };
  ctx.waitUntil(run());
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no' },
  });
}

function isAuthorizedEvesReviewer(me) {
  const ids = Array.isArray(me && me.identities) ? me.identities : [];
  const byEmail = ids.some((i) => i && isOwnerEmail(i.email));
  const byPlan = Boolean(me && me.plan && (me.plan.unlimited || me.plan.source === 'unlimited'));
  return Boolean(byEmail || byPlan);
}

/**
 * POST /api/chat/eves/flag
 * Restricted to Bilel & Malik (`isAuthorizedEvesReviewer`).
 * Logs EVES thumbs-up / hallucination flags in the cloud (works 24/7 even when the owner's laptop is closed),
 * runs an autonomous Gemini 4 Argon + web search repair pass on flagged hallucinations, and updates the
 * EVES Immutable Verified Vault so the corrected answer is remembered.
 */
export async function hostedEvesFlag(request, env, ctx, who, cfg, helpers) {
  const me = await call(env, who.account, 'get', {}, who.token);
  if (!isAuthorizedEvesReviewer(me)) {
    throw new ApiError(403, 'forbidden', 'EVES hallucination flagging is restricted to authorized reviewers.');
  }
  const raw = await helpers.readBody(request, 256 * 1024);
  const rating = raw.rating === 'up' ? 'up' : 'down';
  const question = typeof raw.question === 'string' ? raw.question.trim().slice(0, 12_000) : '';
  const answer = typeof raw.answer === 'string' ? raw.answer.trim().slice(0, 24_000) : '';
  const model = typeof raw.model === 'string' ? raw.model.trim().slice(0, 80) : 'eves';
  if (!answer) throw new ApiError(400, 'bad_request', 'answer is required.');

  const reviewerEmail =
    ((me.identities || []).find((i) => i && i.email) || {}).email || who.account;
  const flagId = `${Date.now()}-${[...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

  if (rating === 'up') {
    let vaultUpdated = false;
    const imm = question ? assessQueryImmutability(question, { messageCount: 1, hasAttachments: false, hasSources: false, privacy: false, allowStandaloneInMultiTurn: true }) : { immutable: false };
    if (question && imm.immutable) {
      const qFp = fingerprintQuestion(question);
      const vectorB64 = await embedVaultQuestion(env, question);
      const vaultEntry = {
        canonicalHash: qFp.canonicalHash,
        question,
        fingerprint: qFp,
        vectorB64,
        answerText: answer,
        citations: Array.isArray(raw.citations) ? raw.citations.slice(0, 10) : [],
        verdict: (raw.eves && raw.eves.verdict) || { winner: 0, agreement: 'all', claims: [], corrections: [], skippedJudge: true, summary: 'Verified accurate by reviewer.' },
        verification: {
          label: { kind: 'eves_verified', text: 'Confirmed accurate · EVES Vault', detail: 'Verified by owner/reviewer and stored in the EVES Vault.', severity: 'ok' },
          findings: [],
        },
        createdAt: Date.now(),
      };
      await getMemoryVault(env).putEntry(vaultEntry).catch(() => {});
      await putEvesVault(env, vaultEntry).catch(() => {});
      vaultUpdated = true;
    }
    const flagRecord = {
      id: flagId,
      at: Date.now(),
      rating: 'up',
      reviewer: reviewerEmail,
      model,
      question: question.slice(0, 1000),
      answer: answer.slice(0, 2000),
      vaultUpdated,
    };
    ctx.waitUntil(putEvesFlag(env, flagRecord));
    ctx.waitUntil(recordStat(env, { kind: 'action', name: 'eves_rate_up', product: 'eden', model, detail: `vault:${vaultUpdated ? 1 : 0}` }));
    return {
      ok: true,
      id: flagId,
      rating: 'up',
      logged: true,
      vaultUpdated,
      summary: vaultUpdated ? 'Confirmed accurate and stored in the EVES Vault.' : 'Confirmed accurate and logged.',
    };
  }

  // Thumbs down: autonomous cloud hallucination verification & repair with Gemini 4 Argon + web search
  const picks = checkModels(autoModels(cfg.models), undefined, 'gemini-4-argon');
  const requestFor = (pick, text) => helpers.routed(cfg, text, {}, { model: pick.model.id, effort: pick.effort }).pick.request;
  let repairCostUSD = 0;
  const charge = (provider, usd, meta = { feature: 'eves_repair' }) => {
    if (!usd || !metered(cfg.keys, provider)) return;
    repairCostUSD += usd;
    ctx.waitUntil(call(env, who.account, 'spend', { usd, bucket: 'allowance', meta }).catch(() => {}));
  };
  const ask = hostedAsk({
    picks,
    keys: cfg.keys,
    base: cfg.base,
    requestFor,
    charge,
    tally: () => {},
    ...(searchFallbackOn(env, request) ? { searchFallback: searchFallback({ models: cfg.models, keys: cfg.keys, turnId: typeof raw.turnId === 'string' ? raw.turnId.slice(0, 64) : 'flag' }) } : {}),
  });

  let repaired = false;
  let fixedAnswer = '';
  let citations = [];
  let counterClaim = '';
  let summary = '';
  let vaultUpdated = false;

  if (question && (picks.search || picks.strong)) {
    const falsified = await falsifyAnswer(ask, question, answer, { maxCalls: 2 });
    counterClaim = falsified.counterClaim || `The earlier answer for "${clip(question, 120)}" contained a hallucinated or inaccurate claim.`;
    const evidenceHint = falsified.evidence || 'Reviewer flagged this answer as a hallucination; verify every factual claim against live web sources and correct any errors.';
    const reans = await reanswerWithSearch(ask, question, answer, {
      counterClaim,
      evidence: evidenceHint,
    });
    if (reans.confirmed && reans.text.trim()) {
      repaired = true;
      fixedAnswer = reans.text.trim();
      citations = reans.citations || [];
      summary = falsified.evidence
        ? `Web check found: ${falsified.evidence} Rewritten with verified sources.`
        : 'Verified against live web sources with Gemini 4 Argon and corrected automatically.';
    } else if (picks.strong || picks.cheap) {
      // Fallback surgical repair if search citations weren't returned
      try {
        const fallbackPick = await ask({
          system:
            'You are EVES Autonomous Hallucination Repair. A human reviewer flagged the earlier answer as containing a hallucination or factual inaccuracy. Search the web or verify carefully, correct the inaccurate claim(s), keep what is true, and reply with the corrected answer only.',
          user: `Question:\n${question}\n\nFlagged answer:\n${answer}\n\n${falsified.evidence ? `Web evidence:\n${falsified.evidence}\n\n` : ''}Write the corrected, factually accurate answer:`,
          tier: 'strong',
          search: Boolean(picks.search),
          purpose: 'web answer',
          maxTokens: 1500,
          temperature: 0,
        });
        if (fallbackPick && String(fallbackPick.text || '').trim()) {
          repaired = true;
          fixedAnswer = String(fallbackPick.text).trim();
          citations = fallbackPick.citations || falsified.sources || [];
          summary = 'Corrected automatically by EVES using Gemini 4 Argon + web grounding.';
        }
      } catch {
        // leave repaired = false if provider call failed
      }
    }
  }

  if (repaired && fixedAnswer && question) {
    const qFp = fingerprintQuestion(question);
    const vectorB64 = await embedVaultQuestion(env, question);
    const vaultEntry = {
      canonicalHash: qFp.canonicalHash,
      question,
      fingerprint: qFp,
      vectorB64,
      answerText: fixedAnswer,
      citations,
      verdict: {
        winner: 0,
        agreement: 'majority',
        claims: [],
        corrections: [
          {
            claimId: `flag-${flagId}`,
            action: 'fix',
            replacement: fixedAnswer.slice(0, 300),
            reason: summary,
          },
        ],
        skippedJudge: false,
        summary,
      },
      verification: {
        label: {
          kind: 'eves_verified',
          text: 'Hallucination auto-fixed · EVES Vault',
          detail: summary,
          severity: 'ok',
        },
        findings: [
          {
            check: 'evidence',
            status: 'pass',
            subject: 'Autonomous hallucination repair',
            detail: summary,
          },
        ],
        repaired: { struck: [answer.slice(0, 200)], regenerated: true },
      },
      createdAt: Date.now(),
    };
    await getMemoryVault(env).putEntry(vaultEntry).catch(() => {});
    await putEvesVault(env, vaultEntry).catch(() => {});
    vaultUpdated = true;
  }

  const flagRecord = {
    id: flagId,
    at: Date.now(),
    rating: 'down',
    reviewer: reviewerEmail,
    model,
    question: question.slice(0, 1500),
    hallucinatedAnswer: answer.slice(0, 3000),
    repaired,
    fixedAnswer: fixedAnswer.slice(0, 3000),
    counterClaim,
    summary: summary || 'Logged for EVES review.',
    citations,
    vaultUpdated,
    costUSD: round6(repairCostUSD),
  };
  ctx.waitUntil(putEvesFlag(env, flagRecord));
  ctx.waitUntil(
    recordStat(env, {
      kind: 'action',
      name: 'eves_hallucination_flag',
      product: 'eden',
      model,
      usd: round6(repairCostUSD),
      detail: `repaired:${repaired ? 1 : 0} vault:${vaultUpdated ? 1 : 0}`,
    }),
  );

  return {
    ok: true,
    id: flagId,
    rating: 'down',
    logged: true,
    repaired,
    fixedAnswer: repaired ? fixedAnswer : null,
    citations,
    counterClaim,
    vaultUpdated,
    summary: summary || 'Hallucination logged in cloud store.',
  };
}
