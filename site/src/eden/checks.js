// Hosted Eden's two fact checks (askeden ROADMAP N19; on the Mac: src/chat/turn.ts, src/verify/ask.ts), on askeden.com:
//
//   before the answer   the assumption check (askeden src/verify/presupposition.ts): only for a question the free
//                       pre-filter says rests on a factual premise ("why did X win…"); one cheap call lists what it takes
//                       for granted, at most two doubtful premises are searched; a premise a CITED search finds false
//                       becomes Eden's own system note telling the answering model to correct it. At most 10 s, fail soft.
//   after the answer    the web check (falsification.ts): only for a factual answer that came WITHOUT search (risk elevated/high, a factual premise, or a date/year/count
//                       lookup: isFactualLookup); a cheap
//                       counter-claim and one search for it. At FALSIFY_THRESHOLD (0.85) Eden answers once more with
//                       search and swaps that in (`verification.repaired.text`, "Checked on the web: corrected") only
//                       when that search cites sources; otherwise the answer is flagged, never rewritten. Its own time: 18 s for the
//                       counter-claim and its search, 25 s for the answer again, 45 s in all (the Mac's, measured 2026-10-09).
//
// The checks themselves are the Mac's own code, bundled by scripts/sync-eden.mjs as vendor/verify.js; this file is the
// glue: the AskModel on this site's providers (providers.js streamCall, the same metering as a reply), which models it
// uses, what a check may cost at most (held on the allowance with the turn), and the time caps.
//
//   cheap tier   the cheapest model the asker may use with reasoning ≥ 85 (by list price; normally Gemini 3.8 Flash), at its lowest effort
//   search       Gemini grounding at medium effort (Gemini 3.8 Flash when available): at low effort it answers from
//                memory without searching (askeden eves-config.ts SEARCH_EFFORT_ATTEMPTS, measured 2026-10-09)
//
// Billing: every call is counted like a reply's (chat.js charge → the account's `spend`, at list price, the credits'
// markup applied there), and its worst case is held with the turn's own hold before anything runs, so the checks
// count toward the allowance, the trial and the two-turns-at-once cap. Without room for them they don't run.
// Typical cost, provider list price: the assumption check ≈ $0.015–0.03 when it searches (most of it Gemini's
// $0.014 per grounding query), ≈ $0.0001 when nothing is doubtful; the web check ≈ $0.015–0.02, plus ≈ $0.02 when it
// answers again. The most one may cost (what is held): about $0.09 each (WORST_* below, tested).

import { canSearch, capRequest, fitCall, metered, ratesOf, streamCall } from './providers.js';
import { withMaxOutputTokens } from './vendor/providers.js';
import {
  FALSIFY_MAX_CALLS,
  FALSIFY_THRESHOLD,
  PREMISE_MAX_SEARCHES,
  StreamInspectorGate,
  assessAnswerClaimRisk,
  assessRisk,
  auditPresuppositions,
  buildVerification,
  checkArithmetic,
  checkInspector,
  crossFamilyAuditClaims,
  falsifyAnswer,
  hasFactualPremise,
  hasSycophancyChallenge,
  isFactualLookup,
  premiseNote,
  reanswerWithSearch,
  sycophancyGuardNote,
  worthSending,
} from './vendor/verify.js';

export { FALSIFY_THRESHOLD, StreamInspectorGate, assessAnswerClaimRisk, hasFactualPremise, hasSycophancyChallenge, isFactualLookup, sycophancyGuardNote };

/** The assumption check may hold the first word this long (the Mac's PREMISE_CHECK_MS). */
export const PREMISE_CHECK_MS = 10_000;
/** After the reply: the web check's own cap, the re-answer's, and the whole after-reply budget (the Mac's). */
export const ANSWER_CHECK_MS = 18_000;
export const REANSWER_MS = 25_000;
export const REANSWER_MIN_MS = 2_000;
export const AFTER_REPLY_MS = 45_000;
/** The search model, and its effort. */
export const SEARCH_MODEL = 'gemini-3.8-flash';
export const SEARCH_EFFORTS = ['medium', 'low', 'minimal', 'none'];
/** Hard per-call timeout on check/judge/search transport calls so a hung stream never stalls EVES. */
export const CHECK_CALL_TIMEOUT_MS = 20_000;
/** A check call's output cap, thinking included: the cheap steps write a short JSON, a search a paragraph and a JSON line. */
export const CALL_CAP = { cheap: 1_500, strong: 4_000, search: 4_000, answer: 6_000 };
/** Gemini 3 grounding bills per query: a search call's worst case counts this many. */
export const QUERIES_HELD = 2;
/** The question and the answer as the checks read them, at most (the prompts clip at 6,000 characters each). */
const CLIP = 6_000;
const UNFINISHED = 'Some checks didn’t finish.';

const oneLine = (s, max = 200) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const tokensOf = (chars) => Math.ceil(chars / 3) + 200; // a token per 3 characters, the prompt's own words
const errorFinding = (check, detail) => ({ check, status: 'error', subject: check, detail });

/** Runs `run` with a time limit; a failure or a timeout is a value, never an exception (the Mac's soft()). */
export async function soft(ms, parent, run) {
  const ctrl = new AbortController();
  const stop = () => ctrl.abort();
  if (parent.aborted) return { ok: false, why: 'it was stopped' };
  parent.addEventListener('abort', stop, { once: true });
  let timer;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        ctrl.abort();
        resolve({ ok: false, why: 'it ran out of time' });
      }, Math.max(1, ms));
    });
    const done = (async () => run(ctrl.signal))().then(
      (value) => ({ ok: true, value }),
      (e) => ({ ok: false, why: oneLine((e && e.message) || 'it failed', 120) }),
    );
    return await Promise.race([done, timeout]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', stop);
  }
}

// ── the models ──

const blended = (m) => {
  const [i, o] = ratesOf(m);
  return i + o;
};
const lowest = (m, order) => {
  const have = m.efforts.map((e) => e.level);
  return order.find((e) => have.includes(e)) || have[0];
};

/**
 * The checks' models for this asker: `cheap` the cheapest model they may use, `strong` the strongest/judge model
 * (prefers Gemini 3.8 Flash by default, or the user's `evesModel` setting), `search` a Gemini that grounds, each
 * { model, effort }; null where there is none. `providers`: the page's provider switches (settings.providers).
 */
export function checkModels(models, providers, evesModel) {
  const pool = models.filter((m) => !Array.isArray(providers) || providers.includes(m.provider));
  // A check that catches mistakes can't run on a model that makes more of them: the cheapest at or above the reasoning
  // floor (GPT-6 Luna's level, retired 2026-10-13); the cheapest of all only when nothing reaches it.
  const able = pool.filter(trustworthy);
  const cheapest = [...(able.length ? able : pool)].sort((a, b) => blended(a) - blended(b))[0];
  const strongRank = (a, b) =>
    ((b.capabilities && b.capabilities.reasoning) || 0) - ((a.capabilities && a.capabilities.reasoning) || 0) || blended(a) - blended(b);
  const prefId = typeof evesModel === 'string' && evesModel && evesModel !== 'auto' ? evesModel : SEARCH_MODEL;
  const preferred = (able.length ? able : pool).find((m) => m.id === prefId);
  const strongOrdered = [
    ...(preferred ? [preferred] : []),
    ...[...(able.length ? able : pool)].filter((m) => m !== preferred && (m.id !== 'gemini-4-argon' || prefId === 'gemini-4-argon')).sort(strongRank),
  ];
  const strongest = strongOrdered[0];
  const strongFallback = strongOrdered.find((m) => m !== strongest);
  const gemini = pool.filter((m) => m.provider === 'gemini' && canSearch(m));
  const search = (prefId !== 'gemini-4-argon' && gemini.find((m) => m.id === prefId)) || gemini.find((m) => m.id === SEARCH_MODEL) || [...gemini].sort((a, b) => blended(a) - blended(b))[0];
  const searchFallback = gemini.filter((m) => m !== search && trustworthy(m)).sort((a, b) => blended(a) - blended(b))[0];
  return {
    cheap: cheapest ? { model: cheapest, effort: lowest(cheapest, ['none', 'minimal', 'low', 'medium']) } : null,
    strong: strongest ? { model: strongest, effort: lowest(strongest, ['low', 'medium', 'high']) } : null,
    strongFallback: strongFallback ? { model: strongFallback, effort: lowest(strongFallback, ['low', 'medium', 'high']) } : null,
    search: search ? { model: search, effort: lowest(search, SEARCH_EFFORTS) } : null,
    searchFallback: searchFallback ? { model: searchFallback, effort: lowest(searchFallback, SEARCH_EFFORTS) } : null,
  };
}

/** Good enough to check or summarise others' work: reasoning at or above GPT-6 Luna's 85 (retired 2026-10-13). */
export const MIN_UTILITY_REASONING = 85;
export const trustworthy = (m) => !m || !m.capabilities || typeof m.capabilities.reasoning !== 'number' || m.capabilities.reasoning >= MIN_UTILITY_REASONING;

/** A check call's request with exactly `cap` output tokens (thinking included, its budget kept under it). */
const sized = (request, cap) => capRequest(withMaxOutputTokens(request, cap), cap);

/** One call's worst case at list price (its output cap, its input, Gemini's queries). */
function callWorst(pick, request, inputTokens, cap, search) {
  const f = fitCall(pick.model, request, { leftUSD: Infinity, inputTokens, searches: search ? QUERIES_HELD : 0, maxTokens: cap, minReply: 1 });
  return f.worstUSD || 0;
}

/**
 * What the checks this turn may run can cost at most, on the included AI (calls on the asker's own keys hold nothing):
 * { premise, answer } in dollars. `requestFor(pick, prompt)` builds a call's request (chat.js: the router's own).
 */
export function checksWorst({ picks, keys, question, premise, answer, requestFor }) {
  const held = (pick) => pick && metered(keys, pick.model.provider);
  const q = Math.min(String(question || '').length, CLIP);
  const one = (pick, chars, cap, search) => (held(pick) ? callWorst(pick, sized(requestFor(pick, 'x'), cap), tokensOf(chars), cap, search) : 0);
  const out = { premise: 0, answer: 0 };
  if (premise) out.premise = round6(one(picks.cheap, q, CALL_CAP.cheap, false) + PREMISE_MAX_SEARCHES * one(picks.search, 1_000, CALL_CAP.search, true));
  if (answer) {
    out.answer = round6(
      one(picks.cheap, q + CLIP, CALL_CAP.cheap, false) + // the counter-claim
        one(picks.search, q + 1_000, CALL_CAP.search, true) + // its search
        one(picks.search, q + 4_000 + 1_000, CALL_CAP.answer, true), // the answer again, with search
    );
  }
  return out;
}

/**
 * The AskModel (askeden src/verify/types.ts) on this site's providers: `cheap` → picks.cheap, `search: true` → picks.search
 * with Gemini grounding. Each call streams like a reply (nothing is shown), is charged with `charge(provider, usd)` however
 * it ended, and is tallied with `tally(usdAtUsersPrice)`. Rejects on a failure, an empty reply or a stop.
 */
export function hostedAsk({ picks, keys, base = null, requestFor, charge, tally, factor = () => 1, timeoutMs = CHECK_CALL_TIMEOUT_MS }) {
  const runOne = async (pick, req, signal) => {
    const model = pick.model;
    const k = keys[model.provider];
    if (!k) throw new Error(`No ${model.provider} key for this check.`);
    const tierCap = req.search ? (req.purpose === 'web answer' || req.purpose === 'anchor' ? CALL_CAP.answer : CALL_CAP.search) : req.tier === 'strong' ? CALL_CAP.strong : CALL_CAP.cheap;
    const cap =
      req.purpose === 'anchor'
        ? Math.max(req.maxTokens || 16_384, CALL_CAP.answer)
        : req.purpose === 'web answer'
          ? CALL_CAP.answer
          : typeof req.maxTokens === 'number' && req.maxTokens > 0
            ? Math.min(tierCap, req.maxTokens + (req.search ? 600 : 350))
            : tierCap;
    const prompt = `${req.system}\n\n${req.user}`;
    const effectivePick = req.purpose === 'anchor' && pick.model.id === 'gemini-3.8-flash' ? { ...pick, effort: 'low' } : pick;
    const request = sized(requestFor(effectivePick, prompt), cap);
    const effectiveSystem =
      req.purpose === 'evidence' && model.provider === 'gemini'
        ? `${req.system}\nFirst write 1 short sentence naming the source from your Google Search, then on a new line write the JSON.`
        : req.system;
    if (signal.aborted) throw new Error('it was stopped');
    const callCtrl = new AbortController();
    const onAbort = () => callCtrl.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const actualTimeout = req.purpose === 'anchor' || req.purpose === 'web answer' ? Math.max(timeoutMs, 60_000) : timeoutMs;
    const timer = actualTimeout > 0 ? setTimeout(() => callCtrl.abort(), actualTimeout) : undefined;
    let r;
    let seenText = '';
    try {
      r = await streamCall(
        { model, request, messages: [{ role: 'user', content: req.user, ...(Array.isArray(req.attachments) && req.attachments.length ? { attachments: req.attachments } : {}) }], system: effectiveSystem, search: Boolean(req.search), uses: req.search ? 1 : 0, key: k.key, base, inputTokens: tokensOf(prompt.length) },
        {
          signal: callCtrl.signal,
          emit: (e, d) => {
            if (e === 'text' && d && d.text) {
              seenText += d.text;
              if (req.onText) {
                try {
                  req.onText(seenText);
                } catch {
                  // listener error never breaks the call
                }
              }
            }
          },
        },
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
    if (r.usage) {
      charge(model.provider, r.costUSD); // counted however it ended, as a reply's call is
      tally(r.costUSD * (metered(keys, model.provider) ? factor() : 1));
    }
    if (signal.aborted) throw new Error('it was stopped');
    if (r.stopped && callCtrl.signal.aborted) throw new Error(`${model.name} timed out after ${Math.round(timeoutMs / 1000)}s.`);
    if (r.stopped) throw new Error('it was stopped');
    if (r.failure) throw new Error(r.failure);
    if (!String(r.text || '').trim()) throw new Error(`${model.name} sent an empty reply.`);
    return { text: r.text, model: model.id, costUSD: r.costUSD, ...(r.citations.length ? { citations: r.citations } : {}) };
  };
  return async (req) => {
    const primary = req.search ? picks.search : req.tier === 'strong' && picks.strong ? picks.strong : picks.cheap;
    if (!primary) throw new Error(req.search ? 'No model here can search the web for this check.' : 'No model for this check.');
    const signal = req.signal || new AbortController().signal;
    if (signal.aborted) throw new Error('it was stopped');
    try {
      return await runOne(primary, req, signal);
    } catch (e) {
      if (signal.aborted) throw e;
      const fallback = req.search
        ? picks.searchFallback
        : req.tier === 'strong'
          ? picks.strongFallback || (picks.cheap && picks.cheap.model.id !== primary.model.id ? picks.cheap : null)
          : null;
      if (!fallback || !keys[fallback.model.provider]) throw e;
      return await runOne(fallback, req, signal);
    }
  };
}

// ── what a turn may run ──

/**
 * The risk class of the question (askeden src/verify/risk.ts, as the Mac's assessTurn): the person's own words only.
 */
export function riskOfTurn(body) {
  const last = body.messages[body.messages.length - 1];
  return assessRisk(last.content, {
    hasSources: false,
    hasAttachments: Boolean(last.attachments && last.attachments.length),
    mode: body.mode === 'chat' ? 'chat' : 'search',
    history: body.messages.slice(-7, -1).map((m) => ({ role: m.role, content: m.content })),
  });
}

/**
 * Which checks this turn may run, before anything is held. Never for research, a course, the person's attachments or
 * context blocks (notes, mail, files: the premise is about their material, which the web can't see), a video or an
 * image, a delegate's narrowed pool, or when the person turned the check off; the web check only for a chat-mode turn
 * (an answer with search needs no web check), and only for a factual question (risk elevated/high, or the pre-filter).
 */
export function checksFor({ body, raw, risk, question, inCourse, grounding, picks }) {
  const last = body.messages[body.messages.length - 1];
  const history = body.messages.slice(-7, -1).map((m) => ({ role: m.role, content: m.content }));
  const hasNonImageAtts = Boolean(last.attachments && last.attachments.some((a) => a.kind !== 'image'));
  const plain = !inCourse && !grounding && !hasNonImageAtts && !(body.context && body.context.length) && raw.privacy !== true;
  const searchable = Boolean(picks.search && picks.cheap);
  const premise =
    plain && searchable && (body.mode === 'chat' || body.mode === 'search') && body.settings.premiseCheck !== false && !risk.reasons.includes('user_data') && hasFactualPremise(question, history);
  const factual = risk.level !== 'low' || hasFactualPremise(question, history) || isFactualLookup(question);
  const answer = plain && searchable && body.mode === 'chat' && body.settings.answerCheck !== false && factual;
  return { premise, answer };
}

// ── before the answer ──

/**
 * The assumption check for one turn, counted, with its own time cap. Never throws: → { checked, why?, corrected?, note?,
 * calls, latencyMs } (`note`: Eden's trusted system text when a premise a cited search found false).
 */
export async function premiseAudit(ask, question, signal, ms = PREMISE_CHECK_MS) {
  const t0 = Date.now();
  let calls = 0;
  const counted = async (req) => {
    calls++;
    return ask(req);
  };
  const out = await soft(ms, signal, (s) => auditPresuppositions(counted, question, { signal: s }));
  const facts = { calls, latencyMs: Date.now() - t0 };
  if (!out.ok) return { ...facts, checked: false, why: out.why };
  if (out.value.error) return { ...facts, checked: false, why: oneLine(out.value.error, 120) };
  const p = out.value.falsePremise;
  return { ...facts, checked: true, ...(p ? { corrected: p, note: premiseNote(p) } : {}) };
}

/** The route event's `premiseCheck` (the Mac's): what the audit did, and what it found false. */
export const premiseRoute = (r) =>
  r ? { checked: r.checked, ...(r.corrected ? { falsePremise: { text: r.corrected.text, reason: r.corrected.reason, sources: (r.corrected.sources || []).slice(0, 5) } } : {}), ...(r.why ? { unfinished: r.why } : {}) } : undefined;

export const premiseRouteNote = (p) => `Checked the question’s assumptions: a web search found that “${oneLine(p.text, 160)}” is false, so the answer corrects that first.`;

// ── after the answer ──

/**
 * The web check of an answer that came without search, then (when it fires) one answer again with search. Never throws.
 * → { answerCheck?, findings, repaired?, unfinished, calls }.
 */
export async function answerCheck(ask, question, answer, signal, { budgetMs = AFTER_REPLY_MS } = {}) {
  const t0 = Date.now();
  const left = () => Math.max(0, budgetMs - (Date.now() - t0));
  const findings = [];
  let unfinished = false;
  let calls = 0;
  const counted = async (req) => {
    calls++;
    return ask(req);
  };
  const out = await soft(Math.min(ANSWER_CHECK_MS, left()), signal, (s) => falsifyAnswer(counted, question, answer, { signal: s, maxCalls: FALSIFY_MAX_CALLS }));
  if (signal.aborted) return { findings, unfinished, calls, stopped: true };
  if (!out.ok) {
    // Zero-Drop Hedged Verification Race: if web falsification failed (non-timeout) and time remains, fall back to fast cross-family claim audit
    if (!/time/.test(out.why) && left() >= 800 && typeof crossFamilyAuditClaims === 'function') {
      const fallbackAudit = await soft(Math.min(2_500, left()), signal, (s) => crossFamilyAuditClaims(counted, question, answer, { signal: s }));
      if (fallbackAudit.ok && fallbackAudit.value.ok) {
        for (const d of fallbackAudit.value.disputed || []) {
          findings.push({ check: 'claim', status: 'fail', subject: oneLine(d.claim, 160), detail: oneLine(d.why, 300), ...(d.sentence ? { sentence: d.sentence } : {}) });
        }
        return { answerCheck: { ran: true, fired: (fallbackAudit.value.disputed || []).length > 0, corrected: false }, findings, unfinished: false, calls };
      }
    }
    findings.push(errorFinding('web', `Eden’s web check of this answer did not finish (${out.why}).`));
    if (/time/.test(out.why)) unfinished = true;
    return { findings, unfinished, calls };
  }
  if (out.value.score === null) {
    findings.push(errorFinding('web', `Eden’s web check of this answer could not run (${oneLine(out.value.error || 'it failed', 120)}).`));
    return { findings, unfinished, calls };
  }
  if (out.value.score < FALSIFY_THRESHOLD) {
    return {
      answerCheck: { ran: true, fired: false, corrected: false, sources: out.value.sources, evidence: out.value.evidence },
      findings,
      unfinished,
      calls,
    };
  }
  const fz = out.value;
  findings.push({ check: 'web', status: 'fail', subject: oneLine(fz.counterClaim, 160), detail: oneLine(`A web search found credible evidence for this instead of the answer${fz.evidence ? `: ${fz.evidence}` : ''}`, 400) });
  let re;
  if (left() >= REANSWER_MIN_MS) {
    const r = await soft(Math.min(REANSWER_MS, left()), signal, (s) => reanswerWithSearch(counted, question, answer, fz, { signal: s }));
    if (signal.aborted) return { findings, unfinished, calls, stopped: true };
    if (r.ok) re = r.value;
    else if (/time/.test(r.why)) unfinished = true;
  }
  if (re && re.confirmed) {
    return { answerCheck: { ran: true, fired: true, corrected: true, evidence: fz.evidence, sources: re.citations }, repaired: { struck: [], regenerated: true, text: re.text, replaced: [], remaining: [] }, findings, unfinished, calls };
  }
  return { answerCheck: { ran: true, fired: true, corrected: false, evidence: fz.evidence, sources: fz.sources }, findings, unfinished, calls };
}

/**
 * The `verification` event for a turn on which a check ran (labels.ts, as the Mac builds it), or null when there is
 * nothing to say. `added.costUSD` is at the user's price, like the turn's `usage`.
 */
export function verificationFor({ risk, searched, citations, premise, after, costUSD, latencyMs, answerText, thinking, historyMessages, memories, sources }) {
  const findings = after ? [...after.findings] : [];
  const checkedText = after && after.repaired && after.repaired.text ? after.repaired.text : String(answerText || '');
  if (checkedText.trim()) {
    if (typeof checkArithmetic === 'function') {
      try {
        const arith = checkArithmetic(checkedText);
        if (Array.isArray(arith)) findings.push(...arith);
      } catch {
        // non-blocking arithmetic check
      }
    }
    if (typeof checkInspector === 'function') {
      try {
        // Only pass full-text sources (never URL-title-only citations) so checkInspector doesn't treat a short webpage title as the entire source body
        const allSources = Array.isArray(sources) ? sources : [];
        if (allSources.length || (historyMessages && historyMessages.length) || thinking || (memories && memories.length)) {
          const inspFindings = checkInspector(checkedText, {
            sources: allSources,
            thinking,
            historyMessages,
            memories,
          });
          if (Array.isArray(inspFindings)) findings.push(...inspFindings);
        }
      } catch {
        // non-blocking deterministic inspector
      }
    }
  }
  const calls = (premise ? premise.calls : 0) + (after ? after.calls : 0);
  const ev = buildVerification({
    risk: { level: risk.level, reasons: risk.reasons, action: risk.action },
    findings,
    hasSources: false,
    searched,
    citations,
    repaired: after && after.repaired,
    toolGrounded: false,
    eves: { suggested: false },
    premise: premise && premise.corrected ? { corrected: true, text: premise.corrected.text } : undefined,
    answerCheck: after && after.answerCheck,
    added: { costUSD, latencyMs, calls },
  });
  const unfinished = Boolean(after && after.unfinished) || Boolean(premise && premise.why && /time/.test(premise.why));
  if (!unfinished && after && after.answerCheck && after.answerCheck.ran && !after.answerCheck.fired && (ev.label.kind === 'model_memory' || ev.label.kind === 'not_checked')) {
    const premText = premise && premise.corrected ? `Corrected a false assumption in the question${premise.corrected.text ? ` (it assumed: ${oneLine(premise.corrected.text, 160)})` : ''}. ` : '';
    ev.label = {
      kind: 'checked_on_web',
      text: 'Checked on the web',
      detail: oneLine(`${premText}Eden checked this answer against web sources and confirmed its claims hold up.`, 600),
      severity: 'info',
    };
  }
  if (unfinished) {
    ev.label = { ...ev.label, detail: oneLine(`${UNFINISHED} ${ev.label.detail ?? ''}`, 600), ...(ev.label.severity === 'ok' ? { severity: 'info' } : {}) };
    if (!ev.findings.some((x) => x.status === 'error')) ev.findings.push(errorFinding('time', `${UNFINISHED} Eden stopped them so the reply isn’t held up.`));
  }
  return worthSending(ev) ? ev : null;
}

/** Not enough of the included AI left for the checks: the turn goes on without them, and says so. */
export const CHECKS_SKIPPED = 'Eden’s fact checks were skipped: not enough of your included AI is left for them.';
