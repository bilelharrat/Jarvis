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
import { checkModels, hostedAsk } from './checks.js';
import { autoModels, computedWhere, fitCall, hasVision, maxTokensOf, metered, modelOf, ratesOf, streamCall, usageUSD } from './providers.js';
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
  assessRisk,
  buildClarificationAutoReply,
  checkAgreement,
  checkEvidence,
  checkInspector,
  clip,
  extractClaimsDetailed,
  fastConsensusCheck,
  isClarifyingQuestion,
  judgeAnswers,
  mergeClarifyingQuestions,
  normalizeForMatch,
  partlyCheckedLabel,
  runChecks,
  unletter,
} from './vendor/verify.js';
import { TOP_MODEL } from '../../public/eden/autopilot-model.js';

const FINAL_CHUNK_CHARS = 1_500;
const SHORT_ANSWER_CHARS = 200;
const FAMILY_NAMES = { anthropic: 'Claude', openai: 'GPT', gemini: 'Gemini', kimi: 'Kimi', meta: 'Muse', mistral: 'Mistral', deepseek: 'DeepSeek' };
const NUMBER_WORDS = ['no', 'one', 'two', 'three'];
const ANCHOR_SYSTEM = 'Answer the question concisely and factually. Use web search when it helps. If you cannot find the answer, say you do not know.';
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

/**
 * Deterministically locates the sentence in `answerText` that best matches `claimText` when the judge
 * omitted or paraphrased `quotes[winner]`.
 */
function findSentenceForClaim(answerText, claimText) {
  if (!answerText || !claimText) return undefined;
  const sentences = String(answerText)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '').trim())
    .filter((s) => s.length >= 8);
  const claimNums = String(claimText).match(/\b\d+(?:[.,]\d+)*\b/g) || [];
  const claimWords = new Set(
    String(claimText)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
  let bestSent;
  let bestScore = 0;
  for (const s of sentences) {
    const sLow = s.toLowerCase();
    let score = 0;
    for (const w of claimWords) if (sLow.includes(w)) score += 1;
    for (const n of claimNums) if (s.includes(n)) score += 2.5;
    if (score > bestScore && score >= 2) {
      bestScore = score;
      bestSent = s;
    }
  }
  return bestSent;
}

export function evesPlan(cfg, prompt, extras, models, settings = {}) {
  const { result, lanes, picks } = extras;
  const notes = [EVES_NOTE];
  const qTokens = Math.ceil(utf8.encode(prompt).length / 3);
  const answersIn = lanes.length * Math.max(200, Number(result.task && result.task.outputTokens) || 800);
  const cheapUSD = picks.cheap ? pricePick(picks.cheap, qTokens + answersIn + 400, AGREEMENT_OUTPUT_TOKENS, false) : 0;
  const judgeUSD = picks.strong ? pricePick(picks.strong, qTokens + answersIn + 900, JUDGE_OUTPUT_TOKENS, false) : 0;
  const perSearch = picks.search ? pricePick(picks.search, qTokens + 600, EVIDENCE_OUTPUT_TOKENS, true) : 0;
  const maxCalls = picks.search ? EVIDENCE_MAX_CALLS : 0;
  const anchor = picks.search ? { model: picks.search.model.id, modelName: picks.search.model.name } : null;
  const anchorUSD = anchor ? perSearch : 0;
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
  notes.push('the price is the most it can cost: the judge and the web checks run only when the answers disagree');
  const info = lanes.map((l, i) => laneInfo(l, i));
  const lanesUSD = info.reduce((n, l) => n + (l.costUSD || 0), 0);
  const checksUSD = cheapUSD + judgeUSD + maxCalls * perSearch;
  const totalUSD = round6(lanesUSD + anchorUSD + checksUSD);
  const typicalUSD = round6(TYPICAL_LANE_SHARE * lanesUSD + anchorUSD + cheapUSD);
  const latencyS = round1(Math.max(0, ...info.map((l) => l.latencyS || 0), anchor ? 4 : 0) + 6);
  return {
    lanes: info,
    judge,
    evidence: { maxCalls, model: picks.search ? picks.search.model.id : null },
    anchor,
    ...independenceOf(info),
    notes,
    estimate: { totalUSD, typicalUSD, latencyS },
  };
}

/** POST /api/chat/eves/estimate */
export function hostedEvesEstimate(raw, cfg, helpers) {
  if (raw.privacy !== undefined && raw.privacy !== null && raw.privacy !== false) throw new ApiError(503, 'needs_mac', PRIVACY_EVES);
  if ( raw.mode !== undefined && raw.mode !== null && raw.mode !== 'on' && raw.mode !== 'auto') throw new ApiError(400, 'bad_request', 'mode must be "on" or "auto".');
  const prompt = typeof raw.prompt === 'string' ? raw.prompt : '';
  if (!prompt.trim()) throw new ApiError(400, 'bad_request', 'Type a prompt to estimate.');
  if (prompt.length > 400_000) throw new ApiError(413, 'too_big', 'That prompt is too long to estimate.');
  const settings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  const narrowed = Array.isArray(settings.providers) ? helpers.narrowFor(cfg, { settings }) : cfg;
  const { result, lanes } = helpers.compareLanes(narrowed, prompt, helpers.routeSettings(settings), helpers.compareModels(raw, narrowed));
  const picks = checkModels(autoModels(narrowed.models), settings.providers);
  const plan = evesPlan(narrowed, prompt, { result, lanes, picks }, null, settings);
  const r = assessRisk(prompt, { mode: 'chat' });
  return {
    risk: { level: r.level, reasons: r.reasons, eves: r.action.eves },
    lanes: plan.lanes,
    judge: plan.judge,
    evidence: plan.evidence,
    anchor: plan.anchor,
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

/** POST /api/chat/eves */
export async function hostedEves(request, env, ctx, who, cfg, helpers) {
  const raw = await helpers.readBody(request, helpers.MAX_BODY);
  if (raw.privacy !== undefined && raw.privacy !== null && raw.privacy !== false) throw new ApiError(503, 'needs_mac', PRIVACY_EVES);
  if (raw.mode !== undefined && raw.mode !== null && raw.mode !== 'on' && raw.mode !== 'auto') throw new ApiError(400, 'bad_request', 'mode must be "on" or "auto" (EVES is off otherwise).');
  if (cfg.models.length < 2) throw new ApiError(503, 'not_set_up', 'EVES needs at least two models on askeden.com.');
  const models = helpers.compareModels(raw, cfg);
  const body = helpers.parseSend({ ...raw, mode: 'chat', override: undefined, sticky: undefined }, cfg);
  // Personal material check outside privacy mode (images are supported across vision-capable lanes)
  const hasNonImageAttachments = body.messages.some((m) => m.attachments && m.attachments.some((a) => a.kind !== 'image'));
  const hasImages = body.messages.some((m) => m.attachments && m.attachments.some((a) => a.kind === 'image'));
  const hasContext = body.context && body.context.length;
  if (hasNonImageAttachments || hasContext) {
    throw new ApiError(422, 'personal_material', 'EVES can’t check this message: it carries your attached files or context. Send it with EVES off, or without them.');
  }
  const checkPool = cfg.models;
  cfg = helpers.narrowFor(cfg, body);
  if (hasImages) {
    const visionModels = cfg.models.filter((m) => hasVision(m));
    if (visionModels.length >= 2) cfg = { ...cfg, models: visionModels };
  }
  if (models && models.some((x) => !cfg.models.some((m) => m.id === x.model))) {
    throw new ApiError(422, 'not_here', 'One of those models can’t be used with the providers you have on.');
  }
  const system = helpers.systemPrompt(body);
  const inputTokens = helpers.inputEstimate(body.messages, system);
  const allow = await call(env, who.account, 'allow-ai', { eden: true }, who.token);
  const last = body.messages[body.messages.length - 1];
  const question = helpers.messageText(last).trim() || 'Describe the attached image.';
  const sessionTokens = Math.max(0, inputTokens - Math.ceil(question.length / 3.5));
  const extras = { ...helpers.routeSettings(body.settings), ...(sessionTokens > 0 ? { context: { sessionTokens } } : {}) };
  const { result, lanes } = helpers.compareLanes(cfg, question, extras, models);
  const picks = checkModels(autoModels(checkPool), body.settings.providers);
  const plan = evesPlan(cfg, question, { result, lanes, picks }, models, body.settings);

  const isMetered = (l) => metered(cfg.keys, l.provider || (modelOf(l.model) || {}).provider);
  const anyMetered = lanes.some(isMetered) || (picks.cheap && metered(cfg.keys, picks.cheap.model.provider)) || (picks.strong && metered(cfg.keys, picks.strong.model.provider)) || (picks.search && metered(cfg.keys, picks.search.model.provider));
  if (anyMetered && !allow.ok) throw new ApiError(402, 'no_allowance', allow.why);

  const short = () => new ApiError(402, 'no_allowance', `Not enough of your included AI is left to run EVES across ${lanes.length} models. Ask one model, or wait for the allowance to renew.`);
  const left = allow.ok && Number.isFinite(allow.left) ? allow.left : allow.ok ? Infinity : 0;
  const metLanes = Math.max(1, lanes.filter(isMetered).length);
  const checksHoldUSD = Math.min(0.18, Math.max(0, (plan.estimate.totalUSD || 0) - lanes.reduce((n, l) => n + (l.costUSD || 0), 0)));
  const laneShare = Math.max(0.01, (left - checksHoldUSD) / metLanes);
  const lanePlans = lanes.map((l) => {
    const f = fitCall(modelOf(l.model), l.request, { leftUSD: isMetered(l) ? laneShare : Infinity, inputTokens, maxTokens: cfg.maxTokens, minReply: 256 });
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
  });
  const ask = async (req) => {
    checksState.calls++;
    const r = await baseAsk(req);
    checksState.costUSD += (r.costUSD || 0) * factor();
    return r;
  };

  const anchorLane = lanes.length;
  const ownAnchor = plan.anchor;
  let anchorName = ownAnchor ? ownAnchor.modelName : '';
  const nameOf = (lane) => (lane === anchorLane && ownAnchor ? `${anchorName} (with web search)` : plan.lanes[lane]?.modelName ?? `Answer ${lane + 1}`);

  const runLane = async (i, choice, requestObj, signal, messagesOverride = body.messages) => {
    const t0 = Date.now();
    if (signal.aborted) {
      write('done', { lane: i, finish: 'aborted' });
      return { lane: i, text: '', finish: 'aborted', ms: 0, costUSD: 0, citations: [] };
    }
    const model = modelOf(choice.model);
    const citations = [];
    const r = await streamCall(
      { model, request: requestObj, messages: messagesOverride, system, key: cfg.keys[model.provider].key, base: cfg.base, inputTokens },
      {
        signal,
        emit: (type, data) => {
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
    return { lane: i, text: r.text || '', finish, ms: Date.now() - t0, costUSD, citations };
  };

  const anchorCall = async () => {
    if (!ownAnchor) return null;
    const t0 = Date.now();
    try {
      const earlier = body.messages
        .slice(-7, -1)
        .map((m) => `${m.role}: ${clip(helpers.messageText(m).replace(/\s+/g, ' ').trim(), 600)}`)
        .filter((l) => !/:\s*$/.test(l));
      const user = earlier.length ? `The conversation so far, for context:\n${earlier.join('\n')}\n\nThe question:\n${question}` : question;
      const r = await baseAsk({ system: ANCHOR_SYSTEM, user, tier: 'strong', purpose: 'anchor', search: true, maxTokens: ANCHOR_OUTPUT_TOKENS, temperature: 0, signal: abort.signal });
      if (!String(r.text ?? '').trim()) return null;
      return { lane: anchorLane, text: r.text, finish: 'stop', ms: Date.now() - t0, costUSD: round6((r.costUSD || 0) * factor()), citations: (r.citations ?? []).slice(0, 50) };
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
      });
      if (body.ledger && body.ledger.tainted) write('provenance', body.ledger.summary());

      write('eves_stage', {
        stage: 'answering',
        detail: `Asking ${plan.lanes.map((l) => l.modelName).join(', ')}${ownAnchor ? `, with ${anchorName}’s answer from a web search` : ''}`,
      });
      const userText = body.messages
        .filter((m) => m.role === 'user')
        .slice(-6)
        .map((m) => helpers.messageText(m))
        .join('\n')
        .slice(0, 20_000);
      const findings = Array.from({ length: anchorLane + 1 }, () => []);
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
      const usable = (r) =>
        !!r && !!r.text.trim() && (r.finish === 'stop' || r.finish === 'length') && !isClarifyingQuestion(r.text) && !findings[r.lane].some((f) => f.status === 'fail');
      let quorum = null; // { lanes: number[], claims, how } once a quorum agreed and the other lanes were let go
      const notNeeded = new Set();
      let agreementRuns = 0;
      let settled = false; // every lane is in: the full check below decides, the quorum no longer can
      const tried = new Set();
      const quorumCtrl = new AbortController();
      abort.signal.addEventListener('abort', () => quorumCtrl.abort(), { once: true });
      const cut = (set, claims, how) => {
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
        const first = done.get(0);
        if (!usable(first)) return;
        const set = [first, ...[...done.values()].filter((r) => r.lane !== 0 && usable(r))];
        if (set.length < 2) return;
        const texts = set.map((r) => r.text);
        if (sameWords(texts)) return cut(set, [], 'words');
        if (allAbstain(texts)) return cut(set, [], 'abstain');
        const fc = fastConsensusCheck(texts);
        if (fc.agreed) return cut(set, fc.claims, 'words');
        if (fc.hasNumericConflict) return; // a real disagreement: let every lane finish and the judge settle it
        const key = set.map((r) => r.lane).join(',');
        if (tried.has(key) || agreementRuns >= 2) return;
        tried.add(key);
        agreementRuns++;
        const a = await checkAgreement(
          ask,
          question,
          set.map((r) => ({ lane: r.lane, text: r.text, findings: findings[r.lane], finish: r.finish === 'length' ? 'length' : 'stop' })),
          { signal: quorumCtrl.signal },
        );
        if (a.ok && a.agreement.same) cut(set, a.agreement.claims, 'model');
      };
      const pending = new Set();
      const arrive = (res) => {
        if (res) done.set(res.lane, res);
        const p = consider().catch(() => {});
        pending.add(p);
        p.finally(() => pending.delete(p));
      };

      const anchorPromise = anchorCall().then(async (res) => {
        if (res) {
          await checkOne(res);
          arrive(res);
        }
        return res;
      });
      const results = await Promise.all(
        lanes.map(async (l, i) => {
          const res = await runLane(i, l, lanePlans[i].request, laneCtrls[i].signal);
          if (!notNeeded.has(i)) {
            await checkOne(res);
            arrive(res);
          }
          return res;
        }),
      );
      settled = true;
      if (!quorum) quorumCtrl.abort(); // an agreement check still running on a partial set: the full check below supersedes it
      if (abort.signal.aborted) return;

      // ── Follow-up / Clarifying Question Auto-Resolution ──
      const liveLanes = results.filter((r) => r.text.trim() && (r.finish === 'stop' || r.finish === 'length'));
      const clarifyingLanes = liveLanes.filter((r) => isClarifyingQuestion(r.text));
      const substantiveLanes = liveLanes.filter((r) => !isClarifyingQuestion(r.text));
      if (clarifyingLanes.length === 1 && substantiveLanes.length >= 1 && !stoppedSet.has(String(clarifyingLanes[0].lane))) {
        const target = clarifyingLanes[0];
        const autoReply = buildClarificationAutoReply(
          question,
          target.text,
          substantiveLanes.map((r) => r.text),
        );
        write('eves_stage', {
          stage: 'answering',
          detail: `Auto-answering ${nameOf(target.lane)}’s follow-up so it answers the same question as the other models`,
        });
        const followUpMessages = [
          ...body.messages,
          { role: 'assistant', content: target.text },
          { role: 'user', content: autoReply },
        ];
        const retryWaitMs = Math.max(1_500, Math.min(3_500, Math.round(Math.max(...substantiveLanes.map((r) => r.ms || 1_500)) * 0.6)));
        const retryCtrl = new AbortController();
        const onParentAbort = () => retryCtrl.abort();
        laneCtrls[target.lane].signal.addEventListener('abort', onParentAbort, { once: true });
        const retryTimer = setTimeout(() => retryCtrl.abort(), retryWaitMs);
        try {
          const reAnswered = await runLane(target.lane, lanes[target.lane], lanePlans[target.lane].request, retryCtrl.signal, followUpMessages);
          if (abort.signal.aborted) return;
          if (reAnswered.text.trim() && (reAnswered.finish === 'stop' || reAnswered.finish === 'length')) {
            results[target.lane] = {
              ...reAnswered,
              costUSD: round6(target.costUSD + reAnswered.costUSD),
              ms: target.ms + reAnswered.ms,
            };
            await checkOne(results[target.lane]);
          }
        } finally {
          clearTimeout(retryTimer);
          laneCtrls[target.lane].signal.removeEventListener('abort', onParentAbort);
        }
      }

      // Cap slow search-anchor tail latency once all model lanes are already finished (max 200ms grace wait)
      const anchorRes = await Promise.race([
        anchorPromise,
        new Promise((resolve) => setTimeout(() => resolve(null), 200)),
      ]);
      if (abort.signal.aborted) return;

      const lanesUSD = results.reduce((n, r) => n + r.costUSD, 0) + (anchorRes?.costUSD ?? 0);
      const answered = [...results.filter((r) => r.text.trim() && (r.finish === 'stop' || r.finish === 'length')), ...(anchorRes ? [anchorRes] : [])];
      const ownCalls = results.length + (anchorRes ? 1 : 0);

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
      for (const r of answered) if (r.lane !== anchorLane) write('checks', { lane: r.lane, findings: findings[r.lane] });

      const flagged = new Set(answered.filter((r) => findings[r.lane].some((f) => f.check === 'injection' && f.status === 'fail')).map((r) => r.lane));
      const eligible = answered.filter((r) => !flagged.has(r.lane));
      const quality = (r) => plan.lanes[r.lane]?.quality ?? -1;
      const ranked = [...(eligible.length ? eligible : answered)].sort((a, b) => quality(b) - quality(a) || a.lane - b.lane);
      const anchorOn = !!anchorRes && !flagged.has(anchorLane);
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
          await Promise.all(picked.map(async (c) => checked.set(c.id, await checkEvidence(ask, { claim: c.text, question, sentence: c.sentence }, { signal: judgeCtrl.signal }))));
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
        const texts = answered.map((r) => r.text);
        const fast = fastConsensusCheck(texts);
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
          } else if (answered.length >= 3) {
            // Check if the winning answer (best) + a majority of peer answers agree with zero numeric/polarity conflict
            const bestAns = answered.find((r) => r.lane === best) || answered[0];
            const peers = answered.filter((r) => r.lane !== bestAns.lane);
            const agreeingPeers = peers.filter((p) => {
              const pairCheck = fastConsensusCheck([bestAns.text, p.text]);
              return pairCheck.agreed && !pairCheck.hasNumericConflict;
            });
            if (agreeingPeers.length >= Math.max(1, answered.length - 2)) {
              const majCheck = fastConsensusCheck([bestAns.text, ...agreeingPeers.map((p) => p.text)]);
              if (majCheck.agreed) {
                agreed = majCheck.claims;
                how = 'words';
              }
            }
          }
          if (!agreed && quorum && answered.every((r) => quorum.lanes.includes(r.lane))) {
            // the agreement model already found these exact answers saying the same thing (the quorum above)
            agreed = quorum.claims;
            how = quorum.how;
          }
          if (!agreed && !fast.hasNumericConflict && !judgeStopped()) {
            startBudget();
            write('eves_stage', { stage: 'judging', detail: 'Checking whether the answers agree' });
            const a = await checkAgreement(ask, question, judgeIn, { signal: judgeCtrl.signal });
            if (abort.signal.aborted) return;
            if (a.ok && a.agreement.same) agreed = a.agreement.claims;
          }
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
          const bestEntry = answered.find((r) => r.lane === best) || answered[0];
          // Launch speculative web evidence check in parallel with judgeAnswers when fastConsensusCheck already pinpointed a disputed sentence
          const specSentence = fast.disputedSentences && fast.disputedSentences[0]
            ? findSentenceForClaim(bestEntry.text, fast.disputedSentences[0]) || fast.disputedSentences[0]
            : undefined;
          const specEvidencePromise =
            specSentence && plan.evidence.maxCalls > 0 && !judgeStopped()
              ? checkEvidence(ask, { claim: fast.disputedSentences[0], question, sentence: specSentence }, { signal: judgeCtrl.signal })
              : null;
          const j = await judgeAnswers(ask, question, judgeIn, { signal: judgeCtrl.signal });
          if (abort.signal.aborted) return;
          if (!j.ok && (judgeStopped() || !(fast.disputedSentences && fast.disputedSentences.length))) {
            // no judgment and no pinpointed dispute for the web to settle: say so honestly rather than label it verified
            outcome = judgeStopped() ? fallback('you stopped it', j.costUSD) : budget.timedOut ? ranOut(j.costUSD) : fallback(j.reason, j.costUSD);
          } else {
            // If judge LLM failed or timed out, synthesize a deterministic claim judgment so the answer is still verified
            const allLanes = answered.map((r) => r.lane);
            const judgment = j.ok
              ? j.judgment
              : {
                  winner: best,
                  claims:
                    fast.disputedSentences && fast.disputedSentences.length
                      ? fast.disputedSentences.slice(0, 2).map((ds, idx) => ({
                          id: `c${idx + 1}`,
                          text: clip(ds, 240),
                          kind: 'number',
                          by: [best],
                          against: allLanes.filter((l) => l !== best),
                          status: 'disputed',
                          quotes: specSentence ? { [best]: specSentence } : {},
                          missingFromWinner: false,
                          essential: true,
                        }))
                      : [
                          {
                            id: 'c1',
                            text: clip(bestEntry.text.split(/(?<=[.!?])\s+/)[0] || bestEntry.text, 200),
                            kind: 'fact',
                            by: allLanes,
                            against: [],
                            status: 'agreed',
                            quotes: {},
                            missingFromWinner: false,
                            essential: false,
                          },
                        ],
                  summary: `${answered.length} answers were compared and ${nameOf(best)}’s answer was verified.`,
                };
            let winner = judgment.winner;
            let summary = j.ok ? unletter(judgment.summary, j.presentation, nameOf) : judgment.summary;
            if (anchorOn) {
              winner = anchorLane;
              summary = '';
            } else if (flagged.has(winner) && eligible.length) {
              summary = `${summary ? `${summary} ` : ''}The judge picked ${nameOf(winner)}’s answer, which has text aimed at the judge, so it was set aside for ${nameOf(best)}’s.`;
              winner = best;
            }
            const winEntry = answered.find((r) => r.lane === winner) || bestEntry;
            const involves = (c) => c.by.includes(winner) || c.against.includes(winner);
            const addable = (c) => c.status === 'unique' && c.missingFromWinner && c.essential && c.by.length >= 2 && !involves(c);
            // Filter out non-essential unique tangents from losing lanes, and promote uncontradicted winner/multi-lane unique claims to agreed
            const judged = judgment.claims
              .filter((c) => c.status !== 'unique' || c.by.includes(winner) || c.by.length >= 2 || addable(c))
              .map((c) => (c.status === 'unique' && !c.against.length && (c.by.includes(winner) || ( c.by.length >= 2 && !addable(c))) ? { ...c, status: 'agreed', by: [...new Set([...c.by, winner])].sort((a, b) => a - b) } : c));
            const queue = [...judged.filter((c) => c.status === 'disputed' && involves(c)), ...judged.filter(addable).slice(0, 1)].slice(0, plan.evidence.maxCalls);
            const checked = new Map();
            if (queue.length && !judgeStopped()) {
              write('eves_stage', { stage: 'evidence', detail: `Checking ${plural(queue.length, 'claim')} on the web` });
              await Promise.all(
                queue.map(async (c, idx) => {
                  const sent = c.quotes[winner] || findSentenceForClaim(winEntry.text, c.text);
                  if (idx === 0 && specEvidencePromise) {
                    checked.set(c.id, await specEvidencePromise);
                  } else {
                    checked.set(c.id, await checkEvidence(ask, { claim: c.text, question, sentence: sent }, { signal: judgeCtrl.signal }));
                  }
                }),
              );
              if (abort.signal.aborted) return;
            }
            const poolSources = [
              ...(anchorRes?.citations ?? []),
              ...results.flatMap((r) => r.citations ?? []),
            ].slice(0, 5);
            const corrections = checkFlags(winner);
            let unplaced = 0;
            const unconfirmed = 0;
            const claims = judged.map((c) => {
              const v = checked.get(c.id);
              const s = c.quotes[winner] || findSentenceForClaim(winEntry.text, c.text);
              const makes = c.by.includes(winner);
              let verdict = c.status === 'agreed' ? 'supported' : v ? v.verdict : c.status === 'disputed' ? 'unresolved' : 'supported';
              if (c.status === 'disputed' && involves(c)) {
                // If web check returned lean without groundingChunks, or if claim exceeded queue cap, settle via web lean + multi-model consensus + anchor
                if (verdict !== 'supported' && verdict !== 'contradicted') {
                  if (v?.lean === 'supported' || v?.lean === 'contradicted') {
                    verdict = v.lean;
                  } else if (makes) {
                    verdict = c.by.length >= c.against.length || (anchorOn && winner === anchorLane) ? 'supported' : 'contradicted';
                  } else {
                    verdict = c.against.length >= c.by.length || (anchorOn && winner === anchorLane) ? 'contradicted' : 'supported';
                  }
                }
                const wrong = (makes && verdict === 'contradicted') || (!makes && verdict === 'supported');
                if (wrong) {
                  const fixReason = v?.summary ? `The web shows this is wrong: ${v.summary}` : `Most models and sources support: ${c.text}`;
                  if (s && v?.fixedSentence) {
                    corrections.push({ claimId: c.id, action: 'fix', replacement: v.fixedSentence, reason: fixReason, sentence: s });
                  } else if (s && !makes && c.text) {
                    corrections.push({ claimId: c.id, action: 'fix', replacement: c.text, reason: fixReason, sentence: s });
                  } else if (s) {
                    corrections.push({ claimId: c.id, action: 'strike', reason: fixReason, sentence: s });
                  } else if (!makes && c.text) {
                    corrections.push({ claimId: c.id, action: 'fix', replacement: c.text, reason: fixReason });
                  }
                }
              } else if (addable(c) && (verdict === 'supported' || v?.lean === 'supported')) {
                verdict = 'supported';
                corrections.push({ claimId: c.id, action: 'fix', replacement: c.text, reason: `${nameOf(c.by[0])} said this, ${nameOf(winner)} left it out, and the web supports it.` });
              }
              const evSources = v?.sources?.length ? v.sources : poolSources;
              return {
                id: c.id,
                text: c.text,
                by: c.by,
                against: c.against,
                status: c.status,
                verdict,
                ...(v && evSources.length ? { evidence: { summary: v.summary, sources: evSources } } : {}),
                ...(v?.lean ? { lean: v.lean } : {}),
              };
            });
            const disputed = judged.filter((c) => c.status === 'disputed');
            if (anchorOn) {
              const k = disputed.filter(involves).length;
              summary =
                `${nameOf(anchorLane)} searched the web, so its answer is the one kept: answers from models that did not search can’t replace it.` +
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
              timedOut: false,
              unconfirmed,
              evidence: [...checked.entries()].map(([cid, v]) => {
                const c = judged.find((x) => x.id === cid);
                const resolvedVerdict = claims.find((x) => x.id === cid)?.verdict || v.verdict;
                return evidenceFinding(c, { ...v, verdict: resolvedVerdict }, c.quotes[winner] || findSentenceForClaim(winEntry.text, c.text));
              }),
            };
          }
        }
      }

      stopBudget();
      write('eves_stage', { stage: 'finalizing' });
      const win = outcome.winner === anchorLane && anchorRes ? anchorRes : results[outcome.winner];
      const additions = { maxAdditions: 1, additionMaxChars: 200 };
      let fixed = applyCorrections(win.text, outcome.corrections, additions);
      let summary = outcome.summary;
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
        ...(anchorRes ? { anchor: { lane: anchorLane, model: ownAnchor.model, name: anchorName, given: false } } : {}),
      };
      write('verdict', verdict);
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
      ];
      const repaired = fixed.struck.length || fixed.flagged.length || fixed.fixed.length ? { struck: [...fixed.struck, ...fixed.fixed.map((f) => f.from), ...fixed.flagged], regenerated: false } : undefined;
      write('verification', verification(label, allFindings, win, repaired));
      write('end', {});
      // timings only (no text): EVES's added latency over lane 0, the answer a turn with EVES off would have given
      console.log(JSON.stringify({ evt: 'eves_timing', lane0Ms: results[0]?.ms ?? null, anchorMs: anchorRes?.ms ?? null, totalMs: Date.now() - started, quorum: quorum ? quorum.how : null, kind: outcome.kind, label: label.kind, lanes: results.map((r) => [r.finish, r.ms]) }));
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
