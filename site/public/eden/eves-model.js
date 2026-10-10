// The pure parts of EVES on the page (Eden Verification & Evaluation System, ROADMAP N13,
// docs/verify/ui.md): the setting, the composer chip's words and price, the events of
// POST /api/chat/eves accumulated into one state object (node.eves, kept with the reply so a
// reload shows the badge), the progress line, the badge and its detail. No DOM and no imports, so
// src/__tests__/eves-ui.test.ts runs it as it is (eves.js draws with it, chat.js runs the stream).
//
// The events are the contract in docs/verify/README.md and src/verify/types.ts. Everything in them
// comes from the server and from models, so it is data: strings are cleaned to one line of plain
// text and capped, links are http(s) only, and nothing here returns markup. The few rules shared with
// verify-model.js (clean, safeLink, chipSeverity) are copied here because each file is loaded alone;
// the tests check the two copies agree.

/* ---------- the setting ---------- */

export const EVES_MODES = ['off', 'on', 'auto'];
export const EVES_COST_NOTE = 'Costs about 4–5× a normal reply.';
/** What the switch says it does, in plain words (tooltip and Settings). */
export const EVES_HELP = `Eden asks several models, checks the facts they disagree on, and gives you one answer. ${EVES_COST_NOTE}`;
export const MODE_INFO = {
  off: { label: 'Off', note: 'Replies are answered as usual.' },
  on: { label: 'On', note: 'Every reply is checked.' },
  auto: { label: 'Auto', note: 'Checked only when a wrong fact would matter: news and prices, health, law, money, exact figures.' },
};
export const normalizeMode = (v) => (v === 'on' || v === 'auto' ? v : 'off');
/**
 * Does this server run EVES? GET /api/chat/meta says `eves: true` on the Mac server (src/chat/turn.ts chatMeta); a server that
 * doesn't offer it (the hosted site) leaves it out, and the page then shows no EVES switch, no EVES setting, and never sends
 * a message to /api/chat/eves. Until the meta has arrived (or when it failed) EVES is not offered. Only a literal true counts.
 */
export const evesOffered = (meta) => !!meta && typeof meta === 'object' && meta.eves === true;

/**
 * Can this message be answered by EVES at all? Plain Chat only: not a Code session, Search, Research or
 * Compare, and not a turn that uses the Mac's files, the cloud browser or a course. Not a turn that carries
 * the person's own material either (`material`, from personalMaterial: an attached file, an email, notes…),
 * because EVES would send it to every model it asks; in privacy mode only this Mac's models answer, so it may.
 * → { ok, why }.
 */
export function evesApplies({ kind = 'chat', chatMode = 'chat', mac = false, browser = false, course = false, material = '', privacy = false } = {}) {
  const no = (why) => ({ ok: false, why });
  if (kind === 'code') return no('EVES works in chats, not in Code sessions.');
  if (chatMode === 'compare') return no('Compare already asks several models. EVES checks one reply.');
  if (chatMode !== 'chat') return no('EVES checks plain Chat replies. Switch the mode to Chat to use it.');
  if (mac) return no('EVES doesn’t read your Mac’s files yet, so this reply is answered as usual.');
  if (browser) return no('Browser tasks aren’t checked by EVES.');
  if (course) return no('Course answers already check their quotes against your materials.');
  if (material && !privacy) return no(`EVES doesn’t send ${material} to other models, so this reply is answered as usual.`);
  return { ok: true, why: '' };
}

/**
 * What of the person's own material a message would carry to EVES's models, in words ('' when none): attached
 * files and images, and context blocks (email, calendar, notes, files, pages) on the message or earlier in the chat.
 * The person's saved memories don't count. `attachments` and `context` are lists as chat.js keeps them.
 */
export function personalMaterial({ attachments = [], context = [] } = {}) {
  const atts = (Array.isArray(attachments) ? attachments : []).filter((a) => a && typeof a === 'object');
  const ctx = (Array.isArray(context) ? context : []).filter((x) => x && typeof x === 'object' && String(x.source || x.kind || '').toLowerCase() !== 'memory' && !/^memory\b/i.test(String(x.title || '')));
  if (!atts.length && !ctx.length) return '';
  const words = [];
  if (atts.some((a) => a.kind === 'image')) words.push('your images');
  if (atts.some((a) => a.kind !== 'image')) words.push('your attached files');
  if (ctx.length) words.push('your email, calendar, notes or files');
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} or ${words.at(-1)}` : words[0];
}

// Auto's own cheap rule (the server's risk class has the final say): a question where a wrong fact
// would matter. Together with autosearch-rules.js's needsCurrentInfo (news, prices, "latest"), which
// eves.js passes in as `factual`. Nothing is sent anywhere to decide.
const RISK_RULES = [
  ['health', /\b(dose|dosage|dosing|mg|milligrams?|side effects?|symptoms?|diagnos\w*|medicat\w*|medicine|prescri\w*|drug interactions?|overdose|pregnan\w*|allerg\w*|cancer|diabet\w*|blood pressure|vaccin\w*|treatment)\b/i],
  ['legal', /\b(legal|illegal|lawsuit|sue|liable|liability|statute|court|attorney|lawyer|visa|immigration|tenant|landlord|custody|copyright|trademark|gdpr|terms of service)\b/i],
  ['money', /\b(invest\w*|stocks?|etfs?|crypto\w*|mortgage|loans?|interest rates?|retirement|401k|ira|capital gains|taxes|tax|deduct\w*|audit|bankruptcy)\b/i],
  ['exact', /\b(how many|how much|what year|which year|exact\w*|precise\w*|statistics?|percent(?:age)?|population of|citations?|cite|source for|who said|isbn|doi|quote from)\b|\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?\s?%/i],
  ['true', /\b(is (?:it|this|that) true|really true|fact[- ]?check|is (?:it|this|that) correct|verify|debunk\w*|myth)\b/i],
];
const MAKES = /^\s*(?:please\s+|can\s+you\s+|could\s+you\s+)?(?:write|draft|compose|rewrite|rephrase|translate|proofread|edit|fix|refactor|debug|summari[sz]e|paraphrase|generate|create|make|code|implement)\b/i;

/** Why a question looks risky to get wrong: a list of 'health' | 'legal' | 'money' | 'exact' | 'true' (empty: routine). */
export function riskReasons(text) {
  const t = String(text || '').replace(/```[\s\S]*?```/g, ' ').trim();
  if (t.length < 4 || t.length > 600 || MAKES.test(t)) return [];
  return RISK_RULES.filter(([, re]) => re.test(t)).map(([id]) => id);
}

/**
 * Which mode this message goes in: 'on' | 'auto' for POST /api/chat/eves, or null (answered as usual).
 * 'auto' goes only when the page's rule says so: `factual(text)` (autosearch-rules.js), riskReasons, or the
 * server's risk class for this very text (`risk`, from POST /api/chat/eves/estimate: { eves: 'auto' }). This is the
 * only place Auto starts EVES (POST /api/chat/send never does), so the chip has shown the price first.
 */
export function wantsEves({ mode, applies = { ok: true }, text = '', factual = () => false, risk = null } = {}) {
  const m = normalizeMode(mode);
  if (m === 'off' || !applies.ok) return null;
  if (m === 'on') return 'on';
  return riskReasons(text).length > 0 || !!factual(text) || !!(risk && risk.eves === 'auto') ? 'auto' : null;
}

/* ---------- a normal reply's stream (chat.js runChat) ---------- */

/**
 * What chat.js does with one event of a normal reply's stream (POST /api/chat/send). `phase` is 'reply' until the
 * reply's `done`, then 'after' (the turn is over for the person; the server may still send the label). →
 *   'eves'          an EVES stream came instead (an `eves` event): hand it to the EVES handler
 *   'ignore'        not for the reply: a lane's own event (lane 0..2, the work behind EVES), or, after `done`, anything
 *                   but the label, a late note and the end
 *   'done'          the reply is complete: end the turn now (composer, queue, approvals)
 *   'verification'  the label under the reply (before or after `done`)
 *   'note'          after `done`: a note about the finished reply that a server may send late (memory, grounding)
 *   'end'           the stream's last event
 *   'apply'         a reply event (route, text, usage, …), including EVES's final answer (lane "final")
 */
const LATE_NOTES = ['memory', 'grounding', 'refusal', 'research_report']; // research_report: the checked research report's title and sources (Q2)
export function turnStreamStep(phase, type, data) {
  const d = data && typeof data === 'object' ? data : {};
  if (type === 'verification') return 'verification';
  if (type === 'end') return 'end';
  if (phase === 'after') return LATE_NOTES.includes(type) && (d.lane === undefined || d.lane === null) ? 'note' : 'ignore';
  if (type === 'eves') return 'eves';
  if (d.lane !== undefined && d.lane !== null && d.lane !== 'final') return 'ignore';
  if (type === 'done') return 'done';
  return 'apply';
}

/* ---------- words ---------- */

/** Dollars the way the page writes them ($0.004, $0.12, $3). */
export function usd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  if (n === 0) return '$0';
  if (n < 0.001) return '<$0.001';
  if (n < 0.1) return `$${n.toFixed(3)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n)}`;
}
/** An estimated cost: "~$0.045"; '' when unknown. */
export function costWords(n) {
  const s = usd(n);
  return !s ? '' : s.startsWith('<') ? s : `~${s}`;
}
/** Seconds as a quiet estimate: "~4 s", "~40 s", "~2 min"; '' when unknown. */
export function secondsWords(s) {
  if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0) return '';
  if (s < 9.5) return `~${Math.max(1, Math.round(s))} s`;
  if (s < 55) return `~${Math.round(s / 5) * 5} s`;
  return `~${Math.max(1, Math.round(s / 60))} min`;
}
/** A measured time: "820 ms", "8.2 s", "1 min 4 s"; '' when unknown. */
export function tookWords(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}
export const shortModel = (name) => String(name || '').replace(/^Claude /, '').replace(/ \(preview\)$/, '');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Why the checks are weaker when the answers don't come from enough different providers. Plain
 * words, in the page's own wording (the server's note is not shown). null when there is nothing to say.
 */
export function independenceNote(independence, { privacy = false } = {}) {
  if (privacy && (independence === 'none' || independence === 'partial')) return 'Only models on this Mac answer in privacy mode, so checks are weaker.';
  if (independence === 'none') return 'All answers come from one provider, so checks are weaker. Add another provider’s key in Settings.';
  if (independence === 'partial') return 'Two providers answer, so checks are a little weaker than with three. Add another provider’s key in Settings.';
  return null;
}

/* ---------- cleaning (copies of verify-model.js's, kept in step by a test) ---------- */

const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​‎‏‪-‮⁠⁦-⁩﻿]/g;
export function clean(v, max = 400) {
  const raw = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
  const s = raw.replace(HIDDEN, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…` : s;
}
export const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export function safeLink(u) {
  if (typeof u !== 'string') return null;
  const s = u.trim();
  if (!s || s.length > 2000 || /[\s\u0000-\u001F\u007F-\u009F]/.test(s)) return null;
  let url;
  try { url = new URL(s); } catch { return null; }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) return null;
  return { href: url.href, host: url.hostname.replace(/^www\./, '') };
}
const GREEN_KINDS = ['from_sources', 'eves_verified'];
const RANK = { ok: 0, info: 1, warn: 2, bad: 3 };
const worse = (a, b) => (RANK[a] >= RANK[b] ? a : b);
/** What a screen reader hears before a badge's words, so colour is never the only signal. */
export const severityWord = (severity) => (severity === 'ok' ? 'Verified: ' : severity === 'warn' ? 'Caution: ' : severity === 'bad' ? 'Problem: ' : 'Note: ');
/** Same rule as verify-model.js: green only for the two kinds that earned it; a doubt is never softer than warn. */
export function chipSeverity(kind, severity) {
  const defaults = { from_sources: 'ok', eves_verified: 'ok', checked_on_web: 'info', model_memory: 'info', eves_disputed: 'warn', issues_found: 'warn' };
  let s = RANK[severity] !== undefined ? severity : defaults[kind] || 'info';
  if (s === 'ok' && !GREEN_KINDS.includes(kind)) s = 'info';
  return kind === 'eves_disputed' || kind === 'issues_found' ? worse(s, 'warn') : s;
}

/* ---------- the run: events → state ---------- */

export const STAGES = ['answering', 'checking', 'judging', 'evidence', 'finalizing'];
const TERMINAL = ['done', 'stopped', 'error'];
const MAX_LANES = 3;
const MAX_LANE_CHARS = 12000; // what a lane's answer keeps in the conversation (the work, not the reply)
const MAX_CLAIMS = 40;
const MAX_CHECKS = 60;
const VERDICTS = ['supported', 'contradicted', 'unsupported', 'unverifiable', 'unresolved'];

const laneIndex = (v) => (Number.isInteger(v) && v >= 0 && v < MAX_LANES ? v : null);
const indexes = (a) => (Array.isArray(a) ? a : []).filter((i) => laneIndex(i) !== null).slice(0, MAX_LANES);

function cleanSources(list) {
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || typeof s !== 'object') continue;
    const link = safeLink(s.url);
    const title = clean(s.title, 140);
    if (!link && !title) continue;
    out.push({ title, url: link ? link.href : '' });
    if (out.length >= 8) break;
  }
  return out;
}
function cleanFinding(f) {
  if (!f || typeof f !== 'object') return null;
  const status = ['pass', 'fail', 'skipped', 'error'].includes(f.status) ? f.status : 'error';
  const out = { check: clean(f.check, 24).toLowerCase(), status, subject: clean(f.subject, 200), detail: clean(f.detail, 400) };
  const sentence = clean(f.sentence, 500);
  if (sentence) out.sentence = sentence;
  return out.check || out.subject || out.detail ? out : null;
}
function cleanVerdict(d) {
  if (!d || typeof d !== 'object' || !(Array.isArray(d.claims) || ['unanimous', 'majority', 'split', 'single'].includes(d.agreement))) return null; // not a verdict
  const claims = [];
  (Array.isArray(d.claims) ? d.claims : []).slice(0, MAX_CLAIMS).forEach((c, i) => {
    if (!c || typeof c !== 'object') return;
    const ev = c.evidence && typeof c.evidence === 'object' ? { summary: clean(c.evidence.summary, 600), sources: cleanSources(c.evidence.sources) } : null;
    claims.push({
      id: clean(c.id, 24) || `c${i + 1}`,
      text: clean(c.text, 400),
      by: indexes(c.by),
      against: indexes(c.against),
      status: ['agreed', 'disputed', 'unique'].includes(c.status) ? c.status : 'unique',
      verdict: VERDICTS.includes(c.verdict) ? c.verdict : 'unverifiable', // a missing verdict is never "supported"
      evidence: ev && (ev.summary || ev.sources.length) ? ev : null,
    });
  });
  const corrections = [];
  for (const c of (Array.isArray(d.corrections) ? d.corrections : []).slice(0, 20)) {
    if (!c || typeof c !== 'object') continue;
    corrections.push({
      claimId: clean(c.claimId, 24),
      action: ['strike', 'flag', 'fix'].includes(c.action) ? c.action : 'flag',
      replacement: clean(c.replacement, 600),
      reason: clean(c.reason, 300),
    });
  }
  return {
    winner: laneIndex(d.winner),
    agreement: ['unanimous', 'majority', 'split', 'single'].includes(d.agreement) ? d.agreement : null,
    claims,
    corrections,
    skippedJudge: d.skippedJudge === true,
    summary: clean(d.summary, 600),
    judgeCostUSD: num(d.judgeCostUSD),
    totalCostUSD: num(d.totalCostUSD),
    timedOut: d.timedOut === true, // the checking ran out of time: the answer is partly checked
    notes: (Array.isArray(d.notes) ? d.notes : []).filter((x) => typeof x === 'string').slice(0, 5).map((x) => clean(x, 300)).filter(Boolean), // e.g. a model that failed and the one that took over
  };
}
function cleanVerification(d) {
  if (!d || typeof d !== 'object' || !d.label || typeof d.label !== 'object') return null;
  const l = d.label;
  const kind = clean(l.kind, 40);
  if (!kind) return null;
  const out = { label: { kind, text: clean(l.text, 160), detail: clean(l.detail, 600), ...(RANK[l.severity] !== undefined ? { severity: l.severity } : {}) }, findings: [] };
  for (const f of Array.isArray(d.findings) ? d.findings : []) {
    const v = cleanFinding(f);
    if (v) out.findings.push(v);
    if (out.findings.length >= 40) break;
  }
  if (d.repaired && typeof d.repaired === 'object') {
    out.repaired = { struck: (Array.isArray(d.repaired.struck) ? d.repaired.struck : []).slice(0, 10).map((x) => clean(x, 500)).filter(Boolean), regenerated: d.repaired.regenerated === true };
    if (d.repaired.replaced === true || (typeof d.repaired.text === 'string' && d.repaired.text.trim())) out.repaired.replaced = true; // as verify-model.js: the text is not kept here
  }
  if (d.added && typeof d.added === 'object') out.added = { costUSD: num(d.added.costUSD) ?? 0, latencyMs: num(d.added.latencyMs) ?? 0, calls: num(d.added.calls) ?? 0 };
  return out;
}
function cleanUsage(d) {
  const u = {};
  for (const k of ['costUSD', 'inputTokens', 'outputTokens', 'reasoningTokens']) if (num(d && d[k]) !== null) u[k] = d[k];
  u.notional = !!(d && d.notional === true);
  if (u.costUSD === undefined) u.costUSD = 0;
  return u;
}
function newLane(info, i, now) {
  const x = info && typeof info === 'object' ? info : {};
  return {
    i,
    model: clean(x.model, 80), modelName: clean(x.modelName, 80), provider: clean(x.provider, 24).toLowerCase(),
    effort: clean(x.effort, 16), effortLabel: clean(x.effortLabel, 32), via: clean(x.via, 24),
    costUSD: num(x.costUSD), quality: num(x.quality), latencyS: num(x.latencyS),
    status: 'waiting', text: '', truncated: false, cut: false, citations: [], usage: null, finish: null, error: null, startedAt: now, doneAt: null,
  };
}

/** A new run: the state kept with the reply as `node.eves`. */
export function newState(mode, now = Date.now()) {
  return {
    v: 1, id: null, mode: mode === 'auto' ? 'auto' : 'on', phase: 'starting', stage: null, stageDetail: '', seen: [],
    plan: null, lanes: [], checks: [], verdict: null, verification: null,
    final: { status: 'idle', chars: 0, usage: null, finish: null },
    skipped: false, error: null, startedAt: now, doneAt: null,
  };
}

const isLive = (l) => l.status === 'waiting' || l.status === 'thinking' || l.status === 'writing';
function closeLane(l, status, now, error) {
  l.status = status;
  l.doneAt = l.doneAt ?? now;
  if (error && !l.error) l.error = error;
}

/**
 * Takes one event of the stream into the state (in place; returns the state). `type` and `d` are the SSE
 * event name and its parsed data; unknown events and malformed data are ignored. `now`: ms (tests pass it).
 */
export function applyEvent(s, type, d, now = Date.now()) {
  const data = d && typeof d === 'object' ? d : {};
  if (TERMINAL.includes(s.phase) && type !== 'verification' && type !== 'end') return s;
  switch (type) {
    case 'eves': {
      s.id = clean(data.id, 80) || s.id;
      if (data.mode === 'on' || data.mode === 'auto') s.mode = data.mode;
      const independence = ['full', 'partial', 'none'].includes(data.independence) ? data.independence : null;
      s.plan = {
        privacy: data.privacy === true,
        independence,
        judge: data.judge && typeof data.judge === 'object' ? newLane(data.judge, -1, now) : null,
        estimateUSD: num(data.estimate && data.estimate.totalUSD),
        estimateS: num(data.estimate && data.estimate.latencyS),
        notes: (Array.isArray(data.notes) ? data.notes : []).slice(0, 5).map((x) => clean(x, 200)).filter(Boolean),
      };
      s.lanes = (Array.isArray(data.lanes) ? data.lanes : []).slice(0, MAX_LANES).map((x, i) => newLane(x, i, now));
      s.skipped = s.lanes.length === 0; // the server decided nothing needed checking: a normal reply follows
      if (s.phase === 'starting') {
        s.phase = 'answering';
        if (!s.skipped) { s.stage = 'answering'; if (!s.seen.includes('answering')) s.seen.push('answering'); }
      }
      return s;
    }
    case 'eves_stage': {
      const st = STAGES.includes(data.stage) ? data.stage : null;
      if (!st) return s;
      s.stage = st;
      s.phase = st;
      s.stageDetail = clean(data.detail, 160);
      if (!s.seen.includes(st)) s.seen.push(st);
      return s;
    }
    case 'checks': {
      const lane = laneIndex(data.lane);
      for (const f of Array.isArray(data.findings) ? data.findings : []) {
        const v = cleanFinding(f);
        if (v && s.checks.length < MAX_CHECKS) s.checks.push(lane === null ? v : { ...v, lane });
      }
      return s;
    }
    case 'verdict':
      s.verdict = cleanVerdict(data) || s.verdict;
      return s;
    case 'verification':
      s.verification = cleanVerification(data) || s.verification;
      return s;
    case 'end':
      return finish(s, now);
    case 'text': case 'thinking': case 'citations': case 'usage': case 'done': case 'error':
      break;
    default:
      return s; // provenance, fallback, … belong to the turn, not to EVES
  }
  // lane-tagged events
  if (data.lane === 'final') {
    const f = s.final;
    if (type === 'text') { f.chars += String(data.text || '').length; f.status = 'writing'; if (s.phase !== 'finalizing') { s.phase = 'finalizing'; if (!s.seen.includes('finalizing')) s.seen.push('finalizing'); s.stage = 'finalizing'; } }
    else if (type === 'usage') f.usage = cleanUsage(data);
    else if (type === 'done') { f.finish = clean(data.finish, 20) || 'stop'; f.status = f.finish === 'aborted' ? 'aborted' : 'done'; }
    else if (type === 'error') { f.status = 'error'; s.error = clean(data.message, 300) || 'The answer could not be written.'; s.phase = 'error'; s.doneAt = s.doneAt ?? now; for (const l of s.lanes) if (isLive(l)) closeLane(l, 'stopped', now); }
    return s;
  }
  const i = laneIndex(data.lane);
  if (i === null) {
    if (type === 'error') return fail(s, clean(data.message, 300) || 'EVES failed.', now); // the whole run failed
    return s;
  }
  while (s.lanes.length <= i) s.lanes.push(newLane({}, s.lanes.length, now)); // a model the plan did not list: made when its events come first
  const l = s.lanes[i];
  if (!isLive(l)) return s; // a lane that ended says nothing more
  switch (type) {
    case 'text': {
      const t = String(data.text || '');
      const room = MAX_LANE_CHARS - l.text.length;
      l.status = 'writing';
      if (room > 0) l.text += t.slice(0, room);
      if (t.length > room) l.truncated = true;
      return s;
    }
    case 'thinking':
      if (l.status === 'waiting') l.status = 'thinking';
      return s;
    case 'citations': {
      const seen = new Set(l.citations.map((c) => c.url));
      for (const c of cleanSources(data.sources)) if (c.url && !seen.has(c.url) && l.citations.length < 30) { l.citations.push(c); seen.add(c.url); }
      return s;
    }
    case 'usage':
      l.usage = cleanUsage(data);
      return s;
    case 'done': {
      l.finish = clean(data.finish, 20) || 'stop';
      if (l.finish === 'aborted' || l.finish === 'skipped') closeLane(l, 'stopped', now);
      else if (l.finish === 'error') closeLane(l, 'failed', now, 'This model failed.');
      else if (!l.text.trim()) closeLane(l, 'failed', now, 'The model sent an empty reply.');
      else { closeLane(l, 'done', now); l.cut = l.finish === 'length'; }
      return s;
    }
    case 'error':
      closeLane(l, 'failed', now, clean(data.message, 300) || 'This model failed.');
      return s;
    default:
      return s;
  }
}

function fail(s, message, now) {
  s.error = message;
  s.phase = 'error';
  s.doneAt = s.doneAt ?? now;
  for (const l of s.lanes) if (isLive(l)) closeLane(l, 'stopped', now);
  if (s.final.status === 'writing') s.final.status = 'aborted';
  return s;
}
/** The stream ended: whatever was still open is closed, and the run is done. */
export function finish(s, now = Date.now()) {
  if (TERMINAL.includes(s.phase)) { s.doneAt = s.doneAt ?? now; return s; }
  for (const l of s.lanes) if (isLive(l)) closeLane(l, 'stopped', now);
  if (s.final.status === 'writing') s.final.status = s.final.finish ? 'done' : 'aborted';
  s.phase = 'done';
  s.doneAt = s.doneAt ?? now;
  return s;
}
/** The person pressed Stop (or the connection was closed from this end). */
export function markStopped(s, now = Date.now()) {
  if (TERMINAL.includes(s.phase)) { s.doneAt = s.doneAt ?? now; return s; }
  for (const l of s.lanes) if (isLive(l)) closeLane(l, 'stopped', now);
  if (s.final.status === 'writing') s.final.status = 'aborted';
  s.phase = 'stopped';
  s.doneAt = s.doneAt ?? now;
  return s;
}
/** The request failed (network, a refusal, a 4xx): the person sees `message`. */
export function markError(s, message, now = Date.now()) {
  return TERMINAL.includes(s.phase) && s.phase !== 'done' ? s : fail(s, clean(message, 300) || 'EVES failed.', now);
}

/**
 * The state as a reload finds it: the same data, cleaned again (it may come from another device or
 * version), and a run that was still going when the page closed is "stopped". null when it isn't ours.
 */
export function reviveState(blob) {
  if (!blob || typeof blob !== 'object' || blob.v !== 1 || !Array.isArray(blob.lanes)) return null;
  const s = newState(blob.mode, num(blob.startedAt) ?? 0);
  s.id = clean(blob.id, 80) || null;
  s.phase = TERMINAL.includes(blob.phase) ? blob.phase : 'stopped';
  s.stage = STAGES.includes(blob.stage) ? blob.stage : null;
  s.seen = (Array.isArray(blob.seen) ? blob.seen : []).filter((x) => STAGES.includes(x));
  s.skipped = blob.skipped === true;
  s.error = clean(blob.error, 300) || null;
  s.doneAt = num(blob.doneAt);
  if (blob.plan && typeof blob.plan === 'object') {
    const p = blob.plan;
    s.plan = { privacy: p.privacy === true, independence: ['full', 'partial', 'none'].includes(p.independence) ? p.independence : null, judge: p.judge ? newLane(p.judge, -1, 0) : null, estimateUSD: num(p.estimateUSD), estimateS: num(p.estimateS), notes: (Array.isArray(p.notes) ? p.notes : []).slice(0, 5).map((x) => clean(x, 200)).filter(Boolean) };
  }
  s.lanes = blob.lanes.slice(0, MAX_LANES).map((x, i) => {
    const l = newLane(x, i, num(x && x.startedAt) ?? 0);
    const st = x && x.status;
    l.status = ['done', 'stopped', 'failed'].includes(st) ? st : 'stopped';
    l.text = String((x && x.text) || '').slice(0, MAX_LANE_CHARS);
    l.truncated = !!(x && x.truncated);
    l.cut = !!(x && x.cut);
    l.citations = cleanSources(x && x.citations).filter((c) => c.url);
    l.usage = x && x.usage ? cleanUsage(x.usage) : null;
    l.finish = clean(x && x.finish, 20) || null;
    l.error = clean(x && x.error, 300) || null;
    l.doneAt = num(x && x.doneAt);
    return l;
  });
  for (const f of Array.isArray(blob.checks) ? blob.checks : []) {
    const v = cleanFinding(f);
    if (v && s.checks.length < MAX_CHECKS) s.checks.push(laneIndex(f.lane) === null ? v : { ...v, lane: f.lane });
  }
  s.verdict = cleanVerdict(blob.verdict);
  s.verification = cleanVerification(blob.verification);
  if (blob.final && typeof blob.final === 'object') s.final = { status: ['done', 'aborted', 'error'].includes(blob.final.status) ? blob.final.status : 'idle', chars: num(blob.final.chars) ?? 0, usage: blob.final.usage ? cleanUsage(blob.final.usage) : null, finish: clean(blob.final.finish, 20) || null };
  return s;
}

/* ---------- progress ---------- */

/** One stage in the words of the progress line. `n`: how many models are asked. */
export function stageText(stage, n = 3) {
  switch (stage) {
    case 'answering': return `Asking ${plural(Math.max(1, n), 'model', 'models')}…`;
    case 'checking': return 'Checking facts…';
    case 'judging': return 'Comparing answers…';
    case 'evidence': return 'Checking disputed claims…';
    case 'finalizing': return 'Writing the answer';
    default: return '';
  }
}
/** The running phase while the stream is open; a saved run whose page closed is stopped. */
export function phaseOf(s, live) {
  if (!s) return 'stopped';
  if (TERMINAL.includes(s.phase)) return s.phase;
  return live ? s.phase : 'stopped';
}
/**
 * The progress line: [{ id, text, status }] with status 'done' | 'active' | 'pending' | 'skipped' | 'stopped'.
 * A stage the server never announced but a later one did (no judge needed, nothing disputed) is 'skipped';
 * the step a Stop or an error interrupted is 'stopped'.
 */
export function stageSteps(s, live = true) {
  const phase = phaseOf(s, live);
  const n = s.lanes.length || 3;
  const over = TERMINAL.includes(phase);
  const seen = s.seen.length || over ? s.seen : ['answering']; // before the plan arrives, the first step is under way
  const last = Math.max(-1, ...seen.map((x) => STAGES.indexOf(x)));
  return STAGES.map((id, i) => {
    let status;
    if (seen.includes(id)) status = i < last || (over && phase === 'done') ? 'done' : over ? 'stopped' : 'active';
    else if (i < last || (over && phase === 'done' && last >= 0)) status = 'skipped';
    else status = 'pending';
    return { id, text: stageText(id, n), status };
  });
}
/** What the progress line says now (one phrase, for the live region). */
export function liveText(s, live = true) {
  const phase = phaseOf(s, live);
  if (phase === 'stopped') return 'Stopped.';
  if (phase === 'error') return s.error || 'EVES failed.';
  if (phase === 'done') return 'Finished.';
  if (phase === 'starting') return 'Starting…';
  return stageText(s.stage || 'answering', s.lanes.length || 3);
}

/** Whether the answer was written while any lane was still running (the lanes' dots). */
const LANE_WORDS = { waiting: 'Waiting…', thinking: 'Thinking…', writing: 'Writing…', done: 'Done', stopped: 'Stopped', failed: 'Failed' };
/** A lane as the work panel and the progress dots show it. */
export function laneView(l, now = Date.now()) {
  const running = isLive(l);
  const end = l.doneAt ?? (running ? now : null);
  const took = end !== null && l.startedAt ? tookWords(Math.max(0, end - l.startedAt)) : '';
  const cost = l.usage ? (l.usage.notional ? 'subscription' : usd(l.usage.costUSD)) : '';
  const name = shortModel(l.modelName || l.model) || `Model ${l.i + 1}`;
  const effort = l.effortLabel || l.effort;
  const statusText = l.status === 'done' && l.cut ? 'Done · cut off at the output limit' : l.status === 'failed' && l.error ? `Failed: ${l.error}` : LANE_WORDS[l.status] || '';
  return {
    i: l.i, name, provider: l.provider, running, status: l.status, statusText, word: LANE_WORDS[l.status] || '',
    meta: [effort, took, cost].filter(Boolean).join(' · '),
    short: `${name} · ${LANE_WORDS[l.status] || ''}`,
    hasText: !!l.text.trim(),
  };
}
const answered = (s) => s.lanes.filter((l) => l.status === 'done' && l.text.trim());

/* ---------- cost and time of the whole run ---------- */

/** What the run cost: { totalUSD (null when unknown), notionalUSD (Claude through the subscription: counted, not billed) }. */
export function runCost(s) {
  let billed = 0;
  let notional = 0;
  let known = false;
  const add = (u) => { if (u) { known = true; if (u.notional) notional += u.costUSD; else billed += u.costUSD; } };
  for (const l of s.lanes) add(l.usage);
  add(s.final.usage);
  let total = billed + notional;
  const t = s.verdict ? s.verdict.totalCostUSD : null;
  if (t !== null && t >= total) { total = t; known = true; }
  return { totalUSD: known ? total : null, notionalUSD: notional };
}
/** What the reply's `usage` is (the session cost line adds it up): null until something is known. */
export function usageOf(s) {
  const c = runCost(s);
  return c.totalUSD === null ? null : { costUSD: c.totalUSD, notional: c.notionalUSD > 0 };
}
export function costLine(s) {
  const c = runCost(s);
  if (c.totalUSD === null) return '';
  const billed = Math.max(0, c.totalUSD - c.notionalUSD);
  if (c.notionalUSD > 0 && billed < 0.0005) return 'subscription';
  return c.notionalUSD > 0 ? `${usd(billed)} + subscription` : usd(c.totalUSD);
}
export const elapsedMs = (s, now = Date.now()) => Math.max(0, (s.doneAt ?? now) - (s.startedAt || now));

/* ---------- the badge ---------- */

const AGREEMENT = {
  unanimous: (n) => (n > 1 ? `All ${n} models agreed.` : 'The models agreed.'),
  majority: (n) => (n > 2 ? `Most of the ${n} models agreed. They differed on some claims.` : 'The models mostly agreed. They differed on some claims.'),
  split: (n) => (n > 2 ? `The ${n} models split, with no clear majority.` : 'The models split, with no clear majority.'),
  single: () => 'Only one model answered, so there was nothing to compare.',
};
const NOT_VERIFIED = 'The check could not be completed — this answer is not verified.';
const PARTLY_CHECKED = 'Partly checked: ran out of time';

/**
 * The judge could not be used: no verdict, or a verdict that compared nothing (the server's answer when the judge
 * fails, garbles or is stopped is `split` with no claims). A real split always has the claims it split on.
 */
export const judgeFailed = (v) => !v || (v.claims.length === 0 && (v.agreement === 'split' || v.agreement === 'majority'));

/** A claim the winner neither made nor contradicted: a fix to it is something the web added to the answer. */
const leftOut = (claim, winner) => winner !== null && !claim.by.includes(winner) && !claim.against.includes(winner);

/**
 * What happened to each claim: 'agreed' | 'confirmed' | 'corrected' | 'added' | 'removed' | 'flagged' | 'contradicted'
 * | 'unverified'.
 */
export function claimOutcome(claim, corrections, winner = null) {
  const c = (corrections || []).find((x) => x.claimId === claim.id);
  if (c) return c.action === 'fix' ? (leftOut(claim, winner) ? 'added' : 'corrected') : c.action === 'strike' ? 'removed' : 'flagged';
  if (claim.verdict === 'contradicted') return 'contradicted';
  if (claim.status === 'agreed') return 'agreed';
  return claim.verdict === 'supported' ? 'confirmed' : 'unverified';
}
function tally(v) {
  const n = { agreed: 0, confirmed: 0, corrected: 0, added: 0, removed: 0, flagged: 0, contradicted: 0, unverified: 0 };
  for (const c of v ? v.claims : []) n[claimOutcome(c, v.corrections, v.winner)]++;
  return n;
}

/**
 * The badge under the final answer. → { show, text, parts, kind, severity, icon, srPrefix, failed, counts, models }.
 * `show` is false while the run is going, when the server decided nothing needed checking, and when
 * there is no answer to badge (an error box says what went wrong). `live`: the stream is still open.
 * The severity is the label's (never green unless it is eves_verified), and never green when the page's
 * own count shows an unverified claim, a failed check, or a single model.
 */
export function badgeView(s, live = false) {
  const none = { show: false, text: '', parts: [], kind: '', severity: 'info', icon: 'info', srPrefix: '', failed: false, counts: tally(null), models: { answered: 0, total: 0 } };
  if (!s || s.skipped) return none;
  const phase = phaseOf(s, live);
  if (!TERMINAL.includes(phase)) return none;
  const hasAnswer = s.final.chars > 0;
  const total = s.lanes.length;
  const got = answered(s).length;
  const models = { answered: got, total };
  const v = s.verdict;
  const make = (text, parts, kind, severity, extra = {}) => ({
    show: true, text, parts, kind, severity, icon: severity === 'ok' ? 'shield' : severity === 'bad' ? 'bad' : severity === 'warn' ? 'warn' : 'info',
    srPrefix: severityWord(severity), failed: false, counts: tally(v), models, ...extra,
  });
  if (!hasAnswer) return none;
  if (phase === 'stopped') return make('Stopped before the checks finished — this answer is not verified.', [], 'stopped', 'warn', { failed: true });
  // The checking ran out of time (the server's deadline) and nothing was changed: partly checked, said so, never green. A run that did correct
  // something keeps the normal badge below (its label is "Corrected after checking").
  const one = s.verification && s.verification.label;
  if (phase !== 'error' && v && v.timedOut && !(one && one.kind === 'issues_found') && v.agreement !== 'single') return make(PARTLY_CHECKED, [PARTLY_CHECKED], 'eves_partial', 'info', { failed: false });
  if (phase === 'error' || judgeFailed(v)) return make(NOT_VERIFIED, [], 'failed', 'warn', { failed: true });
  if (v.winner === null && got === 0) return make('No model gave a usable answer.', [], 'failed', 'bad', { failed: true });

  const counts = tally(v);
  const open = counts.flagged + counts.unverified;
  const parts = [];
  if (v.agreement === 'single' || got < 2) {
    const text = got === 1 && total > 1 ? 'Only one of the models answered · not cross-checked' : 'Answered by one model · not cross-checked';
    if (counts.corrected) parts.push(`${counts.corrected} corrected`);
    if (counts.added) parts.push(`${counts.added} added from the web`);
    if (counts.removed) parts.push(`${counts.removed} removed`);
    if (open) parts.push(plural(open, 'claim', 'claims') + ' unverified');
    if (counts.contradicted) parts.push(`${counts.contradicted} contradicted`);
    let sev = worse(one ? chipSeverity(one.kind, one.severity) : 'info', 'info'); // one answer is never "verified"
    if (open) sev = worse(sev, 'warn');
    if (counts.contradicted) sev = worse(sev, 'bad');
    return make([text, ...parts].join(' · '), [text, ...parts], 'eves_single', sev);
  }
  const lead = got === total ? `Checked by ${plural(got, 'model', 'models')}` : `Checked by ${got} of ${total} models`;
  parts.push(lead);
  if (counts.agreed) parts.push(`${counts.agreed} agreed`);
  if (counts.confirmed) parts.push(`${counts.confirmed} confirmed by sources`);
  if (counts.corrected) parts.push(`${counts.corrected} corrected`);
  if (counts.added) parts.push(`${counts.added} added from the web`);
  if (counts.removed) parts.push(`${counts.removed} removed`);
  if (open) parts.push(`${plural(open, 'claim', 'claims')} unverified`);
  if (counts.contradicted) parts.push(`${counts.contradicted} contradicted`);
  const l = s.verification && s.verification.label;
  const kind = l && l.kind ? l.kind : open || counts.contradicted ? 'eves_disputed' : 'eves_verified';
  let severity = chipSeverity(kind, l && l.severity);
  if (open) severity = worse(severity, 'warn');
  if (counts.contradicted) severity = worse(severity, 'bad');
  return make(parts.join(' · '), parts, kind, severity);
}

/** The sentences a repair took out, except the ones a correction above already shows as its original. */
function struckOnly(struck, corrections) {
  const norm = (t) => clean(t, 600).toLowerCase().replace(/[\s.,;:!?"'’“”]+$/g, '');
  const origs = corrections.map((c) => norm(c.original)).filter(Boolean);
  return struck.filter((t) => { const n = norm(t); return !origs.some((o) => n === o || n.includes(o) || (n && o.includes(n))); });
}

/**
 * The expanded badge: plain-words sections for the DOM to draw as text.
 * → { notVerified, note, agreement, summary, winner, claims, corrections, struck, checks, models, judge, total, notes, added }
 */
export function detailView(s, live = false, now = Date.now()) {
  const v = s.verdict;
  const phase = phaseOf(s, live);
  const names = s.lanes.map((l) => shortModel(l.modelName || l.model) || `Model ${l.i + 1}`);
  const nameList = (idx) => idx.map((i) => names[i]).filter(Boolean);
  const timedOut = !!(v && v.timedOut);
  const failed = judgeFailed(v) && !timedOut && s.final.chars > 0 && TERMINAL.includes(phase);
  const claims = (v ? v.claims : []).map((c) => {
    const outcome = claimOutcome(c, v.corrections, v.winner);
    const corr = v.corrections.find((x) => x.claimId === c.id) || null;
    return {
      id: c.id, text: c.text, status: c.status, outcome,
      statusText: c.status === 'agreed' ? 'All models agreed' : c.status === 'disputed' ? 'The models disagreed' : 'Only one model said this',
      verdict: c.verdict,
      verdictText: { supported: 'Backed by sources', contradicted: 'Contradicted by sources', unsupported: 'No source backs it', unverifiable: 'Couldn’t be checked', unresolved: 'Left unresolved' }[c.verdict] || '',
      tone: { agreed: 'ok', confirmed: 'ok', corrected: 'ok', added: 'ok', removed: 'info', flagged: 'warn', unverified: 'warn', contradicted: 'bad' }[outcome],
      by: nameList(c.by), against: nameList(c.against),
      evidence: c.evidence ? { summary: c.evidence.summary, sources: c.evidence.sources.map((x) => { const k = safeLink(x.url); return { title: x.title || (k ? k.host : ''), href: k ? k.href : null, host: k ? k.host : '' }; }).filter((x) => x.title) } : null,
      correction: corr ? { action: corr.action, reason: corr.reason, replacement: corr.replacement } : null,
    };
  });
  const corrections = (v ? v.corrections : []).map((c) => {
    const claim = (v.claims || []).find((x) => x.id === c.claimId);
    const added = c.action === 'fix' && !!claim && leftOut(claim, v.winner);
    return {
      claimId: c.claimId, action: c.action, added,
      verb: added ? 'Added' : c.action === 'fix' ? 'Corrected' : c.action === 'strike' ? 'Removed' : 'Marked unverified',
      original: claim ? claim.text : '', replacement: c.replacement, reason: c.reason,
    };
  });
  const checks = [...s.checks, ...(s.verification ? s.verification.findings : [])];
  const judge = !v ? '' : v.skippedJudge ? 'No judge was needed: every claim was agreed by all models.' : s.plan && s.plan.judge && (s.plan.judge.modelName || s.plan.judge.model) ? `Compared by ${shortModel(s.plan.judge.modelName || s.plan.judge.model)}.` : '';
  const c = runCost(s);
  const total = [c.totalUSD === null ? '' : `Total ${costLine(s)}`, tookWords(elapsedMs(s, now))].filter(Boolean).join(' · ');
  const got = answered(s).length;
  const notes = [];
  const ind = s.plan && independenceNote(s.plan.independence, { privacy: s.plan.privacy });
  if (ind) notes.push(ind);
  if (s.plan && s.plan.privacy) notes.push('Privacy mode: only models on this Mac answered, and nothing was looked up on the web. Claims that disagreed stay unresolved.');
  for (const n of (s.plan && s.plan.notes) || []) notes.push(n);
  for (const n of (v && v.notes) || []) if (!notes.includes(n)) notes.push(n);
  return {
    notVerified: failed ? NOT_VERIFIED : timedOut ? 'Time ran out before every claim was checked, so this answer is only partly checked.' : '',
    note: s.verification ? s.verification.label.detail : '',
    agreement: v && v.agreement && !judgeFailed(v) ? { id: v.agreement, text: AGREEMENT[v.agreement](Math.max(got, 1)) } : null,
    summary: v ? v.summary : '',
    winner: v && v.winner !== null && names[v.winner] ? `The answer above is ${names[v.winner]}’s${corrections.length ? ', with the changes below' : ''}.` : '',
    claims, corrections,
    struck: struckOnly(s.verification && s.verification.repaired ? s.verification.repaired.struck : [], corrections),
    checks,
    models: s.lanes.map((l) => laneView(l, now)),
    judge, total, notes,
    added: addedLine(s.verification && s.verification.added),
  };
}

/** What EVES added to just asking the winner (the server's `added`): "Over one model alone: 4 more model calls · $0.052 · 4.2 s". */
function addedLine(a) {
  if (!a) return '';
  const calls = num(a.calls);
  const cost = num(a.costUSD);
  const ms = num(a.latencyMs);
  const bits = [];
  if (calls) bits.push(`${calls} more model call${calls === 1 ? '' : 's'}`);
  if (cost) bits.push(usd(cost));
  if (ms) bits.push(tookWords(ms));
  return bits.length ? `Compared with one model alone: ${bits.join(' · ')}.` : '';
}

/* ---------- the composer chip ---------- */

/**
 * The estimate from POST /api/chat/eves/estimate as the chip says it.
 * → { price, typical, time, models, independence, note, weak, pins } or null (no estimate, or it failed).
 * `price` is "~$0.05", "subscription", or "~$0.04 + subscription"; '' when unknown. It is the most the check can cost;
 * `typical` ("~$0.02", or '') is what it usually costs when the models agree.
 */
export function estimateView(est, { privacy = false } = {}) {
  if (!est || typeof est !== 'object' || est.error || !Array.isArray(est.lanes)) return null;
  const sub = (l) => !!l && l.via === 'claude-cli';
  const parts = [...est.lanes, ...(est.judge ? [est.judge] : [])];
  const total = num(est.totalUSD);
  let price = '';
  if (parts.length && parts.every(sub)) price = 'subscription';
  else if (total !== null) {
    const subUSD = parts.filter(sub).reduce((n, l) => n + (num(l.costUSD) ?? 0), 0);
    price = subUSD > 0 ? `${costWords(Math.max(0, total - subUSD))} + subscription` : costWords(total);
  }
  const independence = ['full', 'partial', 'none'].includes(est.independence) ? est.independence : null;
  // What it usually costs, when the models agree and the judge and the web checks don't run (typicalUSD); `price` is the most it can cost.
  // Said only for a plain dollar price that is clearly higher than the typical one.
  const typicalN = num(est.typicalUSD);
  const typical = price && !price.includes('subscription') && typicalN !== null && total !== null && typicalN > 0 && typicalN < total * 0.9 ? costWords(typicalN) : '';
  return {
    price, typical, time: secondsWords(num(est.latencyS)), models: est.lanes.length, independence,
    note: independenceNote(independence, { privacy }), weak: independence === 'partial' || independence === 'none',
    pins: est.lanes.filter((l) => l && l.model).map((l) => ({ model: String(l.model), ...(l.effort ? { effort: String(l.effort) } : {}) })),
  };
}

/**
 * The composer's EVES chip. `mode`; `applies` ({ ok, why }); `wouldRun` (Auto: the page's rule says this
 * draft is risky); `est` (the estimate response, or { error }); `loading`; `hasText`.
 * → { label: 'EVES', sub, tone ('off'|'on'|'auto'|'na'), weak, price, title, ariaLabel }.
 * A price that failed to load is simply missing: it never blocks sending.
 */
export function chipView({ mode, applies = { ok: true, why: '' }, wouldRun = true, est = null, loading = false, hasText = false } = {}) {
  const m = normalizeMode(mode);
  const ev = estimateView(est);
  const pricing = m !== 'off' && applies.ok && hasText && (m === 'on' || wouldRun);
  const price = pricing && ev ? ev.price : '';
  let sub = MODE_INFO[m].label;
  let tone = m;
  if (m !== 'off' && !applies.ok) { sub = 'Not here'; tone = 'na'; }
  else if (pricing && loading && !price) sub = 'Pricing…';
  else if (price) sub = price;
  const weak = pricing && !!ev && ev.weak;
  const bits = [tone === 'na' ? `EVES is ${MODE_INFO[m].label.toLowerCase()}, but not for this message.` : `EVES is ${MODE_INFO[m].label.toLowerCase()}.`, EVES_HELP];
  if (tone === 'na') bits.push(applies.why);
  else if (m === 'auto' && hasText && !wouldRun) bits.push('This message looks routine, so it will be answered as usual.');
  else if (price) bits.push(ev.typical ? `Estimated ${ev.typical} when the models agree, up to ${price} if they disagree${ev.time ? `, ${ev.time}` : ''}.` : `Estimated ${price}${ev.time ? `, ${ev.time}` : ''}.`);
  if (weak && ev.note) bits.push(ev.note);
  const title = bits.join(' ');
  return {
    label: 'EVES', sub, tone, weak, price, title,
    ariaLabel: `EVES, ${tone === 'na' ? 'not for this message' : MODE_INFO[m].label.toLowerCase()}${price ? `, estimated ${price}` : ''}${weak ? ', checks are weaker' : ''}. Choose how EVES is used`,
  };
}

/* ---------- the request ---------- */

/**
 * The body of POST /api/chat/eves from the body a normal reply would send (messages, settings, system,
 * context, privacy): a compare-shaped body plus `mode`. Nothing else of a chat body goes (no override,
 * sticky, Mac files, browser or course): EVES asks its own models. `models`: the lanes the estimate
 * priced, so what was priced is what runs (not in privacy mode, where the models on this Mac answer).
 */
export function evesBody(base, { mode, models } = {}) {
  const b = base && typeof base === 'object' ? base : {};
  const m = mode === 'auto' ? 'auto' : 'on';
  const out = {};
  for (const k of ['messages', 'system', 'context', 'privacy', 'localModel']) if (b[k] !== undefined) out[k] = b[k];
  out.settings = { ...(b.settings && typeof b.settings === 'object' ? b.settings : {}), eves: m };
  out.mode = m;
  if (Array.isArray(models) && models.length && b.privacy !== true) out.models = models.map((x) => ({ model: x.model, ...(x.effort ? { effort: x.effort } : {}) }));
  return out;
}
