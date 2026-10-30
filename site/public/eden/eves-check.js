// "Check with EVES" on a reply, a pasted text or a document (docs/eves-product-plan.md section 6). The button
// sits in the message's actions (render.js); a click sends the text to POST /api/chat/eves/check (src/chat/eves-check.ts)
// and the result is drawn under the message: the checked text with each claim underlined and a small label pill
// (words AND colour), and a side panel per claim with the verdict in words, why, how sure, the sources and
// "Report a wrong label".
//
// Hidden inside the iPhone app (IN_APP) and off until the server's switch is on (meta.evesCheck, EDEN_EVES_CHECK=1),
// see eves-check-model.js evesCheckOn. Results are kept in memory for the page (never written into the chat).
// Everything from the server goes in as text; links are http(s) only. The words are in eves-check-model.js.

import { el, ico, toast, store } from './util.js';
import { state } from './state.js';
import { IN_APP } from './native.js';
import { postJSON } from './api.js';
import { routeSettings } from './router.js';
import { compactResult, evesCheckOn, checkable, userCheckable, userCheckText, segmentsOf, pillView, panelView, summaryOf, reportOf, VERDICTS, VERDICT_ORDER } from './eves-check-model.js';

/** By message id: { state: 'running' | 'done' | 'error', result?, error? }. */
const runs = new Map();
const REPORTS_KEY = 'eden:eves-check-reports';

export const evesCheckAvailable = () => evesCheckOn({ meta: state.meta, inApp: IN_APP });

let cssOn = false;
function loadCss() {
  if (cssOn || typeof document === 'undefined') return;
  cssOn = true;
  document.head.append(el('link', { rel: 'stylesheet', href: new URL('./eves-check.css', import.meta.url).href, 'data-eves-check': '' }));
}

/** The text a message offers for checking: a reply's words, or a user message's words and documents. */
function textOf(node, replyText) {
  return node.role === 'user' ? userCheckText(node) : String(replyText || '');
}

/** The action for the message bar (render.js), or null when it doesn't apply. */
export function evesCheckButton(node, replyText) {
  if (!evesCheckAvailable() || !node || node.streaming || !(node.role === 'user' ? userCheckable(node) : checkable(textOf(node, replyText)))) return null;
  loadCss();
  const r = runs.get(node.id);
  const busy = r && r.state === 'running';
  return el('button', {
    type: 'button', class: `iconbtn evc-act${r && r.state === 'done' ? ' on' : ''}`, 'data-act': 'eves-check',
    title: busy ? 'EVES is checking…' : 'Check with EVES', 'aria-label': node.role === 'user' ? 'Check this text with EVES' : 'Check this reply with EVES',
    ...(busy ? { 'aria-busy': 'true' } : {}),
  }, ico('shield'));
}

/** The click (app.js): run the check, or hide/show a result already there. */
export async function runEvesCheck(c, node, replyText, redraw) {
  if (!evesCheckAvailable()) return;
  const prev = runs.get(node.id);
  if (prev && prev.state === 'running') return;
  if (prev && prev.state === 'done') { prev.hidden = !prev.hidden; redraw(); return; }
  const text = textOf(node, replyText);
  if (!checkable(text)) { toast('Nothing to check here.'); return; }
  runs.set(node.id, { state: 'running' });
  redraw();
  try {
    const out = await postJSON('/api/chat/eves/check', { text, settings: routeSettings() }, { timeout: 95_000, late: 'EVES took too long. Try again.' });
    const result = compactResult(out);
    runs.set(node.id, result.error && !result.claims.length ? { state: 'error', error: result.error } : { state: 'done', result });
  } catch (e) {
    runs.set(node.id, { state: 'error', error: (e && e.message) || 'EVES couldn’t check that.' });
  }
  redraw();
}

/** The result under the message (render.js), or null. */
export function evesCheckBlock(node, redraw) {
  const r = runs.get(node.id);
  if (!r || !evesCheckAvailable()) return null;
  loadCss();
  if (r.state === 'running') {
    return el('div', { class: 'evc evc-running', role: 'status', 'aria-live': 'polite' }, el('span', 'evc-dot', ''), 'EVES is checking each claim…');
  }
  if (r.state === 'error') {
    return el('div', { class: 'evc evc-error', role: 'alert' }, ico('info', 14), el('span', '', r.error),
      el('button', { type: 'button', class: 'cap', onclick: () => { runs.delete(node.id); redraw(); } }, 'Dismiss'));
  }
  if (r.hidden) return null;
  const res = r.result;
  const head = el('div', 'evc-head',
    el('span', 'evc-brand', ico('shield', 13), 'EVES check'),
    el('span', { class: 'evc-sum', role: 'status' }, summaryOf(res)),
    el('button', { type: 'button', class: 'cap', 'aria-label': 'Hide the EVES check', onclick: () => { r.hidden = true; redraw(); } }, 'Hide'));
  const body = el('div', { class: 'evc-text', 'data-no-i18n': '' });
  for (const seg of segmentsOf(res.text, res.claims)) {
    if (!seg.claim) { body.append(document.createTextNode(seg.text)); continue; }
    body.append(el('span', { class: `evc-claim v-${pillView(seg.claim).verdict}` }, seg.text), pill(seg.claim));
  }
  const unplaced = res.claims.filter((c) => c.span[0] < 0);
  const more = unplaced.length
    ? el('ul', { class: 'evc-more', 'aria-label': 'Other claims EVES checked' }, ...unplaced.map((c) => el('li', '', el('span', { 'data-no-i18n': '' }, c.text), ' ', pill(c))))
    : null;
  return el('section', { class: 'evc', 'aria-label': 'EVES check' }, head, body, more, legend());
}

function pill(claim) {
  const v = pillView(claim);
  return el('button', {
    type: 'button', class: `evc-pill v-${v.verdict}`, 'aria-haspopup': 'dialog', 'aria-label': v.label, title: v.label,
    onclick: (e) => openPanel(claim, e.currentTarget),
  }, el('span', { class: 'evc-mark', 'aria-hidden': 'true' }, v.mark), v.word);
}

function legend() {
  return el('p', 'evc-legend', ...VERDICT_ORDER.map((k) => el('span', `evc-key v-${k}`, el('span', { class: 'evc-mark', 'aria-hidden': 'true' }, VERDICTS[k].mark), VERDICTS[k].word)));
}

// ─── The side panel ─────────────────────────────────────────────────────────

let panel = null;
let returnTo = null;

function closePanel() {
  if (!panel) return;
  panel.remove();
  panel = null;
  removeEventListener('keydown', onKey, true);
  if (returnTo && returnTo.isConnected) returnTo.focus();
  returnTo = null;
}
function onKey(e) { if (e.key === 'Escape' && panel) { e.stopPropagation(); closePanel(); } }

export function openPanel(claim, from) {
  closePanel();
  loadCss();
  returnTo = from || null;
  const v = panelView(claim);
  const title = el('h2', { id: 'evcPanelTitle', class: 'evc-p-title', tabindex: '-1' },
    el('span', { class: `evc-pill big v-${claim.verdict}` }, el('span', { class: 'evc-mark', 'aria-hidden': 'true' }, v.mark), v.verdict));
  const sources = v.sources.length
    ? el('ol', 'evc-src', ...v.sources.map((s) => el('li', '',
        el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', 'data-no-i18n': '' }, s.title),
        el('span', { class: 'evc-site', 'data-no-i18n': '' }, s.site),
        s.quote ? el('blockquote', { 'data-no-i18n': '' }, s.quote) : null)))
    : (v.noSources ? el('p', 'evc-none', v.noSources) : null);
  panel = el('aside', { class: 'evc-panel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'evcPanelTitle' },
    el('div', 'evc-p-top', el('span', 'evc-brand', ico('shield', 13), 'EVES'),
      el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Close', title: 'Close (Esc)', onclick: closePanel }, ico('x'))),
    title,
    el('p', 'evc-sentence', v.sentence),
    el('blockquote', { class: 'evc-p-claim', 'data-no-i18n': '' }, v.claim),
    v.reason ? el('div', 'evc-row', el('h3', '', 'Why'), el('p', { 'data-no-i18n': '' }, v.reason)) : null,
    el('div', 'evc-row', el('h3', '', 'How sure'), el('p', '', v.sure)),
    el('div', 'evc-row', el('h3', '', 'How'), el('p', '', v.method)),
    v.sources.length || v.noSources ? el('div', 'evc-row', el('h3', '', 'Sources'), sources) : null,
    reportForm(claim));
  document.body.append(panel);
  addEventListener('keydown', onKey, true);
  title.focus();
}

function reportForm(claim) {
  const details = el('details', 'evc-report');
  const sel = el('select', { id: 'evcShould' },
    el('option', { value: 'unsure' }, 'I’m not sure'),
    ...Object.keys(VERDICTS).filter((k) => k !== claim.verdict).map((k) => el('option', { value: k }, VERDICTS[k].word)));
  const note = el('textarea', { id: 'evcNote', rows: '3', maxlength: '600', placeholder: 'What’s wrong with this label? (optional)' });
  const send = el('button', { type: 'button', class: 'btn primary', onclick: async () => {
    const r = reportOf(claim, sel.value, note.value);
    try { const list = store.get(REPORTS_KEY, []); store.set(REPORTS_KEY, [...(Array.isArray(list) ? list : []), r].slice(-50)); } catch { /* private mode */ }
    send.disabled = true;
    try { await postJSON('/api/chat/eves/check/report', r, { timeout: 10_000 }); } catch { /* kept on this device */ }
    details.replaceChildren(el('p', { class: 'evc-thanks', role: 'status' }, 'Thanks. Your report helps EVES get labels right.'));
  } }, 'Send report');
  details.append(el('summary', '', 'Report a wrong label'),
    el('label', { for: 'evcShould' }, 'It should be'), sel,
    el('label', { for: 'evcNote' }, 'Note'), note, send);
  return details;
}

/** Tests and a new chat: forget the results. */
export function clearEvesChecks() { runs.clear(); closePanel(); }
