// The pure parts of the labels under replies (ROADMAP N13, docs/verify/ui.md): the server's
// `verification` event (VerificationEvent, src/verify/types.ts) as the chip and detail the page
// draws under ANY reply. No DOM and no imports, so src/__tests__/eves-ui.test.ts runs it as it is
// (verify.js draws with it; eves-model.js keeps its own copy of the few shared rules).
//
// Everything in the event comes from the server and from models, so it is data: these functions
// return plain strings, numbers and booleans only (never markup), cap every length, and the DOM
// modules put them on the page as text. A link is only ever http(s), without credentials.

export const LABEL_KINDS = ['from_sources', 'checked_on_web', 'eves_verified', 'eves_disputed', 'model_memory', 'issues_found', 'not_checked'];
/** The only labels that may be green: every claim backed by the person's own sources, or EVES agreeing/resolving. */
export const GREEN_KINDS = ['from_sources', 'eves_verified'];

const SEVERITIES = ['ok', 'info', 'warn', 'bad'];
const RANK = { ok: 0, info: 1, warn: 2, bad: 3 };
/** A doubt is never softer than this, whatever severity the server sent. */
const FLOOR = { eves_disputed: 'warn', issues_found: 'warn' };
const DEFAULT_SEVERITY = { from_sources: 'ok', eves_verified: 'ok', checked_on_web: 'info', model_memory: 'info', eves_disputed: 'warn', issues_found: 'warn' };

/** The chip's words when the server sent none (and, for model_memory, always: the page owns that wording). */
export const KIND_TEXT = {
  from_sources: 'From your sources',
  checked_on_web: 'Searched the web · cited',
  eves_verified: 'Checked by EVES',
  eves_disputed: 'Checked by EVES · some claims unverified',
  model_memory: 'From the model’s memory · unverified',
  issues_found: 'Issues found in this answer',
};
const KIND_DETAIL = {
  model_memory: 'This answer comes from the model’s memory. Eden didn’t check it against a source, so double-check anything that matters.',
  checked_on_web: 'Eden searched the web for this answer and cited what it found. Searching is not the same as checking every claim.',
  from_sources: 'Every claim in this answer is cited and backed by the sources you gave Eden.',
  eves_disputed: 'Some claims in this answer could not be confirmed.',
  issues_found: 'A check found a problem in this answer.',
};
const CHECK_NAMES = { url: 'Link', quote: 'Quote', number: 'Number', code: 'Code', exact: 'Exact answer', action: 'Action', date: 'Date', unit: 'Unit', web: 'Web check' };
const STATUS_WORDS = { pass: 'Checked', fail: 'Didn’t check out', skipped: 'Skipped', error: 'Couldn’t run' };
const STATUS_TONE = { pass: 'ok', fail: 'bad', skipped: 'dim', error: 'warn' };
const STATUS_ORDER = { fail: 0, error: 1, skipped: 2, pass: 3 };

const MAX_FINDINGS = 40;
const MAX_STRUCK = 10;

// Controls, zero-width space/word joiner/BOM and the bidi overrides and isolates (text that reads backwards).
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​‎‏‪-‮⁠⁦-⁩﻿]/g;

/** A string from the server as one line of plain text, at most `max` characters; anything that isn't text becomes ''. */
export function clean(v, max = 400) {
  const raw = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
  const s = raw.replace(HIDDEN, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…` : s;
}
/** A finite number, else null. */
export const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * A link the page may draw: http(s) only, no credentials in it, no spaces or control characters.
 * → { href, host } (href is the normalised URL, which is also what the link shows on hover), else null.
 */
export function safeLink(u) {
  if (typeof u !== 'string') return null;
  const s = u.trim();
  if (!s || s.length > 2000 || /[\s\u0000-\u001F\u007F-\u009F]/.test(s)) return null;
  let url;
  try { url = new URL(s); } catch { return null; }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) return null;
  return { href: url.href, host: url.hostname.replace(/^www\./, '') };
}

/** Sources from the server ([{ title, url }]) as rows: { title, href, host }; a row without a safe link keeps its title as text. */
export function sourcesView(list, max = 6) {
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || typeof s !== 'object') continue;
    const link = safeLink(s.url);
    const title = clean(s.title, 140) || (link ? link.host : '');
    if (!title) continue;
    out.push({ title, href: link ? link.href : null, host: link ? link.host : '' });
    if (out.length >= max) break;
  }
  return out;
}

/* ---------- severity ---------- */

export const worse = (a, b) => (RANK[a] >= RANK[b] ? a : b);

/**
 * The severity the page shows for a label: the server's, but never green unless the label is one of
 * GREEN_KINDS, and never softer than a doubt's floor. An unknown kind or severity is 'info'.
 */
export function chipSeverity(kind, severity) {
  let s = SEVERITIES.includes(severity) ? severity : DEFAULT_SEVERITY[kind] || 'info';
  if (s === 'ok' && !GREEN_KINDS.includes(kind)) s = 'info';
  return FLOOR[kind] ? worse(s, FLOOR[kind]) : s;
}

/* ---------- findings ---------- */

/** One deterministic check's outcome as a row. An unknown status is "couldn't run", never a pass. */
export function findingView(f) {
  if (!f || typeof f !== 'object') return null;
  const status = STATUS_WORDS[f.status] ? f.status : 'error';
  const check = clean(f.check, 24).toLowerCase();
  const subject = clean(f.subject, 200);
  const detail = clean(f.detail, 400);
  if (!subject && !detail && !check) return null;
  return {
    check,
    checkName: CHECK_NAMES[check] || (check ? `${check[0].toUpperCase()}${check.slice(1)}` : 'Check'),
    status,
    statusText: STATUS_WORDS[status],
    tone: STATUS_TONE[status],
    subject,
    detail,
    sentence: clean(f.sentence, 500),
  };
}

/** Findings as rows, the ones that need a look first; repeats of the same check on the same thing once. */
export function findingsView(list, max = MAX_FINDINGS) {
  const seen = new Set();
  const rows = [];
  for (const f of Array.isArray(list) ? list : []) {
    const v = findingView(f);
    if (!v) continue;
    const key = `${v.check}\u0000${v.status}\u0000${v.subject}\u0000${v.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(v);
  }
  return rows.map((r, i) => ({ r, i })).sort((a, b) => STATUS_ORDER[a.r.status] - STATUS_ORDER[b.r.status] || a.i - b.i).map((x) => x.r).slice(0, max);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** "2 checks failed · 1 couldn’t run · 5 passed"; '' when there are none. */
export function findingsSummary(rows) {
  const n = { fail: 0, error: 0, skipped: 0, pass: 0 };
  for (const r of rows || []) n[r.status] = (n[r.status] || 0) + 1;
  const bits = [];
  if (n.fail) bits.push(`${plural(n.fail, 'check', 'checks')} failed`);
  if (n.error) bits.push(`${n.error} couldn’t run`);
  if (n.skipped) bits.push(`${n.skipped} skipped`);
  if (n.pass) bits.push(`${n.pass} passed`);
  return bits.join(' · ');
}

/* ---------- repairs and added work ---------- */

/** What a repair changed: [{ kind: 'struck' | 'regenerated', text }]. */
export function changesView(repaired) {
  const out = [];
  if (!repaired || typeof repaired !== 'object') return out;
  for (const s of (Array.isArray(repaired.struck) ? repaired.struck : []).slice(0, MAX_STRUCK)) {
    const text = clean(s, 500);
    if (text) out.push({ kind: 'struck', text });
  }
  if (repaired.regenerated === true) out.push({ kind: 'regenerated', text: 'The answer was written again after a check failed.' });
  if (wasRepaired({ repaired })) out.push({ kind: 'replaced', text: 'The answer above is the corrected version. “Show original” brings back what the model first wrote.' });
  return out;
}

/* ---------- a repaired answer (VerificationEvent.repaired.text) ---------- */

const MAX_REPAIR_CHARS = 60000;
// control characters and bidi overrides, but not the line breaks and tabs a Markdown answer is made of
const BODY_HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * The corrected full answer a `verification` event may carry (`repaired.text`: the checks of an ordinary reply run after
 * it has streamed, so when a repair changed it the server sends the new text). Markdown as it is, capped; '' when
 * there is none (absent, not text, or only white space).
 */
export function repairText(ev) {
  const t = ev && typeof ev === 'object' && ev.repaired && typeof ev.repaired === 'object' ? ev.repaired.text : null;
  if (typeof t !== 'string') return '';
  const body = t.replace(BODY_HIDDEN, '').slice(0, MAX_REPAIR_CHARS);
  return body.trim() ? body : '';
}
/** Whether the reply's body was swapped for a repaired one (the event had the text, or it is already kept as replaced). */
export const wasRepaired = (ev) => !!(ev && typeof ev === 'object' && ev.repaired && typeof ev.repaired === 'object' && (ev.repaired.replaced === true || repairText(ev)));

/**
 * The reply's parts with the repaired text in place of its words: the first text part becomes the corrected answer,
 * the other text parts go, anything else (cards, notes) stays where it was. → { parts, original } (the words it had),
 * or null when there is nothing to swap: no corrected text, or it is the text the reply already has.
 */
export function applyRepair(parts, ev) {
  const text = repairText(ev);
  if (!text) return null;
  const list = Array.isArray(parts) ? parts : [];
  const original = list.filter((p) => p && p.type === 'text').map((p) => String(p.text || '')).join('');
  if (!original.trim() || original === text) return null;
  const out = [];
  let put = false;
  for (const p of list) {
    if (p && p.type === 'text') { if (!put) { out.push({ type: 'text', text }); put = true; } } else out.push(p);
  }
  if (!put) out.push({ type: 'text', text });
  return { parts: out, original };
}

/** "Checking added 2 model calls · $0.003 · 1.2 s"; '' when nothing was added. */
export function addedWords(added) {
  if (!added || typeof added !== 'object') return '';
  const calls = num(added.calls);
  const cost = num(added.costUSD);
  const ms = num(added.latencyMs);
  const bits = [];
  if (calls) bits.push(plural(Math.round(calls), 'model call', 'model calls'));
  if (cost) bits.push(cost < 0.001 ? '<$0.001' : cost < 0.1 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`);
  if (ms) bits.push(ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`);
  return bits.length ? `Checking added ${bits.join(' · ')}` : '';
}

/* ---------- the chip ---------- */

/**
 * The `verification` event as the chip under a reply, or null when there is nothing to show (no
 * event, or `not_checked`: everyday chat wears no label).
 * → { kind, severity, text, srPrefix, quiet, expandable, detail, findings, findingSummary, changes, added, replaced, repairedText }
 * (`repairedText`: the corrected answer a repair sent, when it did: the reply's body is swapped for it, see applyRepair)
 */
export function labelView(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const repaired = wasRepaired(ev);
  const given = ev.label && typeof ev.label === 'object' ? ev.label : null;
  if (!given && !repaired) return null;
  // a reply whose words were swapped always says so, whatever label came with it
  const l = given && clean(given.kind, 40) && clean(given.kind, 40) !== 'not_checked' ? given : repaired ? { kind: 'issues_found', text: 'This answer was corrected after a check', severity: 'warn' } : given;
  const kind = clean(l.kind, 40);
  if (!kind || kind === 'not_checked') return null;
  const known = LABEL_KINDS.includes(kind);
  const text = kind === 'model_memory' ? KIND_TEXT.model_memory : clean(l.text, 160) || KIND_TEXT[kind] || '';
  if (!text) return null;
  const severity = chipSeverity(kind, l.severity);
  const findings = findingsView(ev.findings);
  const changes = changesView(ev.repaired);
  const detail = clean(l.detail, 600) || (known ? KIND_DETAIL[kind] || '' : '');
  const added = addedWords(ev.added);
  // Findings that merely passed don't need the detail to open on their own, but they are listed once it does.
  const expandable = !!(detail || findings.length || changes.length || added);
  return {
    kind,
    severity,
    text,
    srPrefix: severityWord(severity),
    quiet: kind === 'model_memory',
    expandable,
    detail,
    findings,
    findingSummary: findingsSummary(findings),
    changes,
    added,
    replaced: repaired,
    repairedText: repairText(ev),
  };
}

/** What a screen reader hears before the chip's words, so colour is never the only signal. */
export function severityWord(severity) {
  return severity === 'ok' ? 'Verified: ' : severity === 'warn' ? 'Caution: ' : severity === 'bad' ? 'Problem: ' : 'Note: ';
}

/* ---------- what is kept with the reply ---------- */

/**
 * The event as it is kept in the conversation (and synced): bounded, plain, nothing else (a repaired answer's text
 * is not kept here: it is the reply's body). null when it isn't a usable event. labelView() reads this shape as well
 * as the raw event.
 */
export function compactVerification(ev) {
  if (!ev || typeof ev !== 'object' || !ev.label || typeof ev.label !== 'object') return null;
  const l = ev.label;
  const kind = clean(l.kind, 40);
  if (!kind) return null;
  const out = {
    label: { kind, text: clean(l.text, 160), detail: clean(l.detail, 600), ...(SEVERITIES.includes(l.severity) ? { severity: l.severity } : {}) },
    findings: [],
  };
  for (const f of Array.isArray(ev.findings) ? ev.findings : []) {
    const v = findingView(f);
    if (!v) continue;
    out.findings.push({ check: v.check, status: v.status, subject: v.subject, detail: v.detail, ...(v.sentence ? { sentence: v.sentence } : {}) });
    if (out.findings.length >= MAX_FINDINGS) break;
  }
  if (ev.repaired && typeof ev.repaired === 'object') {
    out.repaired = { struck: (Array.isArray(ev.repaired.struck) ? ev.repaired.struck : []).slice(0, MAX_STRUCK).map((s) => clean(s, 500)).filter(Boolean), regenerated: ev.repaired.regenerated === true };
    if (wasRepaired(ev)) out.repaired.replaced = true; // the text itself is the reply's body now (applyRepair), not kept twice
  }
  if (ev.added && typeof ev.added === 'object') {
    out.added = { costUSD: num(ev.added.costUSD) ?? 0, latencyMs: num(ev.added.latencyMs) ?? 0, calls: num(ev.added.calls) ?? 0 };
  }
  return out;
}
