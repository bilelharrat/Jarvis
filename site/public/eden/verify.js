// The label under a reply (ROADMAP N13, docs/verify/ui.md): what Eden checked, in a small chip. The
// server sends one `verification` event at the end of a turn (src/verify/types.ts VerificationEvent);
// chat.js keeps it on the reply (node.verification) and this file draws it under the bubble:
//   - `not_checked` (everyday chat) shows nothing;
//   - `model_memory` is a quiet "From the model’s memory · unverified" chip;
//   - `issues_found` is a warning chip that opens to the failed checks and what was struck or replaced.
// When a repair changed the text after it had streamed, the server sends the corrected answer
// (`repaired.text`): noteVerification swaps it in as the reply's words (stored with the reply, so copy, read
// aloud and the next turn use it), keeps what the model first wrote (node.repairedFrom), and the warn chip
// has "Show original". A chip that has more to say is a button (aria-expanded); one that doesn't is plain text. It is drawn
// only once the reply has finished streaming, so it never moves the words being read, and what the
// person opened stays open when the reply is drawn again. Everything from the server goes in as text;
// links are http(s) only (verify-model.js). A reply EVES wrote has its own badge (eves.js) instead.
// The words are in verify-model.js (pure, tested).

import { $, el, ico, svgEl } from './util.js';
import { state } from './state.js';
import { renderMarkdown } from './markdown.js';
import { isTainted } from './guard.js';
import { labelView, compactVerification, applyRepair, severityWord, safeLink } from './verify-model.js';
import { glassPill, toneOfLabel, phraseOfLabel } from './glass.js';

/** Chips the person opened, by reply (a reply is drawn again while it streams and after); `${id}:original` for "Show original". */
const opened = new Set();

/** The event as it is kept with the reply (bounded, plain), or null when it isn't usable. */
export function keepVerification(ev) { return compactVerification(ev); }

/**
 * A `verification` event arrived for an ordinary reply (chat.js): keep it, and when it carries the corrected answer
 * (`repaired.text`) swap that in as the reply's words and keep the first version in node.repairedFrom. With no
 * `text` it only keeps the event, as before. → true when the event was usable.
 */
export function noteVerification(node, ev) {
  let kept = compactVerification(ev);
  const swap = applyRepair(node.parts, ev);
  if (swap) { node.parts = swap.parts; node.repairedFrom = swap.original; }
  if (!kept && swap) kept = { label: { kind: 'issues_found', text: '', detail: '' }, findings: [], repaired: { struck: [], regenerated: false, replaced: true } }; // a swap always has a chip
  if (kept) node.verification = kept;
  return !!kept;
}

/** The small icon for a severity: a shield with a check for ok, an i for info, a triangle for a caution, a cross for a problem. */
export function severityIcon(severity, size = 14) {
  if (severity === 'ok') return ico('shield', size, 'vf-ic');
  if (severity === 'info') return ico('info', size, 'vf-ic');
  const s = svgEl('svg', { class: 'ic vf-ic', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  s.style.width = `${size}px`;
  s.style.height = `${size}px`;
  if (severity === 'warn') s.append(svgEl('path', { d: 'M12 4.2l8.4 14.6H3.6L12 4.2z' }), svgEl('path', { d: 'M12 10v4M12 16.8v.2' }));
  else s.append(svgEl('circle', { cx: 12, cy: 12, r: 8.5 }), svgEl('path', { d: 'M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6' }));
  return s;
}

/** An external link: only http(s), opened in a new tab without handing over the page. A bad URL is just its text. */
export function linkEl(url, text, cls) {
  const link = safeLink(url);
  if (!link) return el('span', cls || '', text || '');
  return el('a', { class: cls || '', href: link.href, target: '_blank', rel: 'noopener noreferrer', title: link.href }, text || link.host);
}

function findingRow(f) {
  return el('li', { class: 'vf-f', 'data-tone': f.tone },
    el('span', 'vf-f-st', f.statusText),
    el('span', 'vf-f-t', el('b', '', f.checkName), f.subject ? ' ' : '', f.subject ? el('span', { 'data-no-i18n': '' }, f.subject) : '', f.detail ? ' — ' : '', f.detail ? el('span', { 'data-no-i18n': '' }, f.detail) : ''), // what was checked: the answer's own words
    f.sentence ? el('q', { class: 'vf-f-q', 'data-no-i18n': '' }, f.sentence) : null);
}

function bodyEl(v, id, isOpen) {
  const body = el('div', { class: 'vf-body', id, hidden: !isOpen, role: 'group', 'aria-label': 'What was checked' });
  if (v.text && v.text !== phraseOfLabel(v.kind, v.text)) body.append(el('p', 'vf-detail', v.text)); // the whole sentence the pill shortens
  if (v.detail) body.append(el('p', 'vf-detail', v.detail));
  if (v.changes.length) {
    body.append(el('ul', 'vf-changes', ...v.changes.map((c) => el('li', '', c.kind === 'struck' ? el('b', '', 'Removed: ') : null, c.kind === 'struck' ? el('span', { 'data-no-i18n': '' }, c.text) : c.text))));
  }
  if (v.findings.length) {
    body.append(el('p', 'vf-sub', `Checks run${v.findingSummary ? ` · ${v.findingSummary}` : ''}`), el('ul', 'vf-findings', ...v.findings.map(findingRow)));
  }
  if (v.added) body.append(el('p', 'vf-added', v.added));
  return body;
}

/** What the model first wrote, through the same safe Markdown path as a reply (links shown for what they are after untrusted reads). */
function fillOriginal(panel, node) {
  const md = el('div', 'md');
  md.append(renderMarkdown(node.repairedFrom || '', { untrusted: isTainted(node) }));
  panel.replaceChildren(el('p', 'vf-orig-h', 'The original answer, before the check:'), md);
}

/** The chip for a finished reply, or null when it has no label or says nothing. */
export function verifyChip(node) {
  if (!node || node.role !== 'assistant' || node.streaming || node.eves || !node.verification) return null;
  const v = labelView(node.verification);
  if (!v) return null;
  const id = `vf-${node.id}`;
  const isOpen = v.expandable && opened.has(node.id);
  const box = el('div', { class: `vf vf-sev${v.quiet ? ' quiet' : ''}`, 'data-sev': v.severity, 'data-kind': v.kind, 'data-act': 'vf-chrome' });
  // the glass pill (glass.js): a button when there is more to open, plain text when there isn't
  const pill = (button) => glassPill({ tag: button ? 'button' : 'div', tone: toneOfLabel(v.kind, v.severity), sub: phraseOfLabel(v.kind, v.text), full: v.text, prefix: severityWord(v.severity), className: button ? 'vf-chip' : 'vf-chip static', attrs: button ? { type: 'button', 'data-act': 'vf-toggle', 'aria-expanded': String(isOpen), 'aria-controls': id } : {} });
  const original = typeof node.repairedFrom === 'string' ? node.repairedFrom : '';
  if (!v.expandable && !original) { box.append(pill(false)); return box; }
  const chip = pill(v.expandable);
  const top = el('div', 'vf-top', chip);
  if (original) {
    const showing = opened.has(`${node.id}:original`);
    top.append(el('button', { type: 'button', class: 'vf-orig-btn', 'data-act': 'vf-original', 'aria-expanded': String(showing), 'aria-controls': `${id}-original` }, showing ? 'Hide original' : 'Show original'));
  }
  box.append(top);
  if (v.expandable) box.append(bodyEl(v, id, isOpen));
  if (original) {
    const panel = el('div', { class: 'vf-original', id: `${id}-original`, hidden: !opened.has(`${node.id}:original`), role: 'group', 'aria-label': 'The original answer' });
    if (opened.has(`${node.id}:original`)) fillOriginal(panel, node);
    box.append(panel);
  }
  return box;
}

/** Puts the label under the reply's bubble (app.js calls this for every message it draws). */
export function decorateVerify(m, c, node) {
  const chip = verifyChip(node);
  if (!chip) return m;
  const bubble = m.querySelector(':scope > .bubble');
  if (bubble) bubble.after(chip); else m.append(chip);
  return m;
}

function onClick(e) {
  const o = e.target.closest('[data-act="vf-original"]');
  if (o) {
    const msg = o.closest('.msg');
    const node = state.current && msg ? state.current.nodes[msg.dataset.id] : null;
    if (!node) return;
    const on = o.getAttribute('aria-expanded') !== 'true';
    o.setAttribute('aria-expanded', String(on));
    o.textContent = on ? 'Hide original' : 'Show original';
    if (on) opened.add(`${node.id}:original`); else opened.delete(`${node.id}:original`);
    const panel = document.getElementById(o.getAttribute('aria-controls'));
    if (panel) { panel.hidden = !on; if (on && !panel.childElementCount) fillOriginal(panel, node); }
    e.stopPropagation();
    return;
  }
  const b = e.target.closest('[data-act="vf-toggle"]');
  if (!b) return;
  const msg = b.closest('.msg');
  const id = msg && msg.dataset.id;
  if (!id) return;
  const on = b.getAttribute('aria-expanded') !== 'true';
  b.setAttribute('aria-expanded', String(on));
  const panel = document.getElementById(b.getAttribute('aria-controls'));
  if (panel) panel.hidden = !on;
  if (on) opened.add(id); else opened.delete(id);
  e.stopPropagation();
}

let started = false;
/** Once, from eves.js's init: the chip's click. */
export function initVerify() {
  if (started) return;
  started = true;
  const tr = $('transcript');
  if (tr) tr.addEventListener('click', onClick);
}
