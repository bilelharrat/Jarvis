// "Check with EVES" (docs/eves-product-plan.md section 6), the pure parts: whether the action shows, the
// labels in words AND colour, the checked text cut into plain and marked pieces, the side panel's words.
// No DOM and no imports, so src/__tests__/eves-check-ui.test.ts runs it as it is served; eves-check.js draws.
//
// The result comes from the server and from models: it is data. Every function here returns plain strings,
// numbers and booleans (never markup), caps every length, and keeps only http(s) links without credentials.

/** The five labels. `mark` is the symbol beside the word (never colour alone); `color` the plan's ink. */
export const VERDICTS = {
  supported: { word: 'Supported', mark: '✓', color: '#1f6f4a', tone: 'ok', said: 'EVES found sources that support this claim.' },
  contradicted: { word: 'Contradicted', mark: '✕', color: '#b8432f', tone: 'bad', said: 'EVES found sources that contradict this claim.' },
  unverified: { word: 'Unverified', mark: '?', color: '#6b7380', tone: 'quiet', said: 'EVES couldn’t verify this claim.' },
  evidence_differs: { word: 'Evidence differs', mark: '⇄', color: '#9a6b12', tone: 'warn', said: 'The sources EVES found disagree about this claim.' },
  not_a_claim: { word: 'Not a claim', mark: '–', color: '', tone: 'muted', said: 'This is an opinion or a prediction, not a factual claim.' },
};
export const VERDICT_ORDER = ['contradicted', 'evidence_differs', 'unverified', 'supported', 'not_a_claim'];

/**
 * The action shows only on the website, never inside the iPhone (or Android) app, and only when the
 * server says the switch is on (/api/chat/meta `evesCheck.available`, set by EDEN_EVES_CHECK=1). Off by default.
 */
export function evesCheckOn({ meta, inApp } = {}) {
  if (inApp) return false;
  return Boolean(meta && meta.evesCheck && meta.evesCheck.available === true);
}

/** Text worth checking: some letters, and not just a word or two. */
export function checkable(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  return s.length >= 20 && /\p{L}/u.test(s);
}

/** A user message offers the check only for a pasted text (200+ characters) or an attached document. */
export function userCheckable(node) {
  if (!node) return false;
  const docs = (Array.isArray(node.context) ? node.context : []).some((x) => x && typeof x.text === 'string' && !x.hidden && x.kind !== 'scope' && checkable(x.text));
  const own = typeof node.content === 'string' ? node.content.trim() : '';
  return docs || (own.length >= 200 && checkable(own));
}

/** A user message: its own words plus the documents attached to it (node.context), as one text. */
export function userCheckText(node) {
  if (!node) return '';
  const parts = [typeof node.content === 'string' ? node.content : ''];
  for (const x of Array.isArray(node.context) ? node.context : []) if (x && typeof x.text === 'string' && !x.hidden && x.kind !== 'scope') parts.push(x.text);
  return parts.map((p) => p.trim()).filter(Boolean).join('\n\n');
}

const clip = (s, n) => {
  const t = typeof s === 'string' ? s : '';
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** An http(s) link without credentials, or ''. */
export function safeUrl(u) {
  try {
    const x = new URL(String(u || ''));
    if ((x.protocol !== 'http:' && x.protocol !== 'https:') || x.username || x.password) return '';
    return x.href;
  } catch {
    return '';
  }
}
const siteOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** "How sure": words for the confidence, never a bare number. */
export function sureWords(confidence, verdict) {
  if (verdict === 'not_a_claim') return 'Not checked: an opinion or a prediction';
  const c = Number(confidence);
  if (!Number.isFinite(c)) return 'Not sure';
  const pct = Math.round(Math.max(0, Math.min(1, c)) * 100);
  const word = c >= 0.85 ? 'Very sure' : c >= 0.6 ? 'Fairly sure' : c >= 0.35 ? 'Not very sure' : 'Not sure';
  return `${word} (${pct}%)`;
}

const METHOD_WORDS = { exact: 'Worked out exactly', web: 'Checked against web sources', none: 'Not checked against a source' };

/** The server's result, bounded and plain. Anything malformed is dropped; an unknown verdict reads as unverified. */
export function compactResult(r) {
  if (!r || typeof r !== 'object') return { text: '', claims: [], error: 'EVES sent nothing back.' };
  const text = typeof r.text === 'string' ? r.text.slice(0, 120_000) : '';
  const claims = [];
  for (const c of Array.isArray(r.claims) ? r.claims.slice(0, 80) : []) {
    if (!c || typeof c !== 'object') continue;
    const verdict = Object.hasOwn(VERDICTS, c.verdict) ? c.verdict : 'unverified';
    let span = Array.isArray(c.span) && c.span.length === 2 ? c.span.map(Number) : [-1, -1];
    if (!(Number.isInteger(span[0]) && Number.isInteger(span[1]) && span[0] >= 0 && span[1] > span[0] && span[1] <= text.length)) span = [-1, -1];
    const sources = [];
    for (const s of Array.isArray(c.sources) ? c.sources.slice(0, 6) : []) {
      const url = safeUrl(s && s.url);
      if (!url) continue;
      sources.push({ title: clip(String((s && s.title) || siteOf(url) || url), 160), site: siteOf(url), url, quote: clip(String((s && s.quote) || ''), 400) });
    }
    claims.push({
      id: clip(String(c.id || `c${claims.length + 1}`), 20),
      text: clip(String(c.text || ''), 600),
      span,
      verdict,
      confidence: Number.isFinite(Number(c.confidence)) ? Math.max(0, Math.min(1, Number(c.confidence))) : 0,
      reason: clip(String(c.reason || ''), 600),
      method: Object.hasOwn(METHOD_WORDS, c.method) ? c.method : 'none',
      sources,
    });
  }
  return {
    text,
    claims,
    ...(r.truncated ? { truncated: true } : {}),
    ...(r.timedOut ? { timedOut: true } : {}),
    ...(typeof r.error === 'string' && r.error ? { error: clip(r.error, 300) } : {}),
    ...(Number.isFinite(Number(r.left)) ? { left: Math.max(0, Math.floor(Number(r.left))) } : {}),
  };
}

/**
 * The checked text cut into pieces for drawing: [{ text }] plain, [{ text, claim }] marked. Overlapping spans
 * keep the first; a claim that couldn't be placed is left out here (the summary list still has it).
 */
export function segmentsOf(text, claims) {
  const t = typeof text === 'string' ? text : '';
  const placed = (claims || []).filter((c) => c && c.span && c.span[0] >= 0 && c.span[1] <= t.length && c.span[1] > c.span[0]).slice().sort((a, b) => a.span[0] - b.span[0] || b.span[1] - a.span[1]);
  const out = [];
  let at = 0;
  for (const c of placed) {
    if (c.span[0] < at) continue;
    if (c.span[0] > at) out.push({ text: t.slice(at, c.span[0]) });
    out.push({ text: t.slice(c.span[0], c.span[1]), claim: c });
    at = c.span[1];
  }
  if (at < t.length) out.push({ text: t.slice(at) });
  return out;
}

/** The pill's words and what a screen reader hears for a claim. */
export function pillView(claim) {
  const v = VERDICTS[claim && claim.verdict] || VERDICTS.unverified;
  return { word: v.word, mark: v.mark, color: v.color, tone: v.tone, verdict: claim && Object.hasOwn(VERDICTS, claim.verdict) ? claim.verdict : 'unverified', label: `EVES: ${v.word}. Open details` };
}

/** The side panel for one claim: the claim, the verdict in words, why, how sure, how, the sources. */
export function panelView(claim) {
  const v = VERDICTS[claim.verdict] || VERDICTS.unverified;
  return {
    claim: claim.text,
    verdict: v.word,
    mark: v.mark,
    color: v.color,
    tone: v.tone,
    sentence: v.said,
    reason: claim.reason,
    sure: sureWords(claim.confidence, claim.verdict),
    method: METHOD_WORDS[claim.method] || METHOD_WORDS.none,
    sources: claim.sources || [],
    noSources: (claim.sources || []).length ? '' : claim.verdict === 'not_a_claim' ? '' : 'No sources for this one.',
  };
}

/** The line above the checked text: counts per label, in words, most serious first. */
export function summaryOf(result) {
  const claims = (result && result.claims) || [];
  if (result && result.error && !claims.length) return result.error;
  const facts = claims.filter((c) => c.verdict !== 'not_a_claim');
  if (!facts.length) return claims.length ? 'No factual claims to check: only opinions or predictions.' : 'EVES found no factual claims to check.';
  const n = (k) => claims.filter((c) => c.verdict === k).length;
  const bits = VERDICT_ORDER.filter((k) => k !== 'not_a_claim' && n(k)).map((k) => `${n(k)} ${VERDICTS[k].word.toLowerCase()}`);
  const head = `${facts.length} ${facts.length === 1 ? 'claim' : 'claims'} checked`;
  const tail = [result.truncated ? 'Only the start was checked.' : '', result.timedOut ? 'Ran out of time: the rest is unverified.' : ''].filter(Boolean).join(' ');
  return `${head}: ${bits.join(', ')}.${tail ? ` ${tail}` : ''}`;
}

/** What "report a wrong label" sends (and keeps): the claim, the label shown, what the person says it should be. */
export function reportOf(claim, should, note) {
  return {
    claim: clip(String((claim && claim.text) || ''), 600),
    shown: claim && Object.hasOwn(VERDICTS, claim.verdict) ? claim.verdict : 'unverified',
    should: Object.hasOwn(VERDICTS, should) ? should : 'unsure',
    note: clip(String(note || ''), 600),
    at: Date.now(),
  };
}
