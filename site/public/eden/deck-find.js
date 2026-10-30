// Find and replace in Eden Slides (web only). ⌘F opens the find bar, ⌥⌘F opens it with Replace; ⌘G / ⇧⌘G step.
// It searches every slide's words (deck-find-model.js: titles, points, cards, tables, chart labels, captions,
// notes, text boxes and shape text), jumps the canvas to each match and marks it in the frame
// (deck-find-frame.js). Replace and Replace All are each one new version (undo with the version arrows or the
// toast), and keep rich-text styles. Plugs into the editor shell (deck-shell.js, research_notes/slides-redesign/
// inspector-api.md): a toolbar button, shortcuts and a File menu entry. Never loaded by the iPhone app's code paths.

import { el } from './util.js';
import { t as tx } from './i18n.js';
import { IN_APP } from './native.js';
import { registerTool, registerShortcut, registerContextMenu, context, icon, formatKeys } from './deck-shell.js';
import { findMatches, replaceMatches } from './deck-find-model.js';

const ui = { bar: null, q: null, rep: null, count: null, matches: [], cur: -1, opts: { matchCase: false, wholeWord: false }, ctx: null, deckKey: '' };
let cssDone = false;
export function featureCss() { // this feature's own stylesheet (deck-find.css), once
  if (cssDone || typeof document === 'undefined') return;
  cssDone = true;
  document.head.append(el('link', { rel: 'stylesheet', href: new URL('./deck-find.css', import.meta.url).href }));
}
const ctxNow = () => ui.ctx || context();
const deckNow = () => { const c = ctxNow(); return c && c.currentDeck ? c.currentDeck() : null; };
const post = (m) => { const c = ctxNow(); if (c && c.post) c.post(m); };

/** The marks in the frame: every match, the current one brighter (and the canvas sent to it when `go`). */
function mark(go = false) {
  post({ type: 'deck-marks', find: ui.matches.map(slim), cur: ui.cur, go });
}
const slim = (m) => ({ index: m.slide, ...(m.fid ? { fid: m.fid } : { path: m.path }), start: m.start, end: m.end, text: m.text });

function search({ keep = false, go = true } = {}) {
  const d = deckNow();
  const was = ui.matches[ui.cur];
  ui.matches = d && ui.q ? findMatches(d, ui.q.value, ui.opts) : [];
  if (keep && was) { // the same place, or the next match after it
    const at = ui.matches.findIndex((m) => m.slide > was.slide || (m.slide === was.slide && (m.path !== was.path || m.fid !== was.fid || m.start >= was.start)));
    ui.cur = ui.matches.length ? (at < 0 ? 0 : at) : -1;
  } else {
    const here = ctxNow().selection ? ctxNow().selection.slide : 0;
    const at = ui.matches.findIndex((m) => m.slide >= here);
    ui.cur = ui.matches.length ? (at < 0 ? 0 : at) : -1;
  }
  ui.deckKey = d ? JSON.stringify(d.slides) : '';
  status();
  mark(go && ui.cur >= 0);
}
function status() {
  if (!ui.count) return;
  const q = ui.q.value;
  ui.count.textContent = !q ? '' : ui.matches.length ? tx(`${ui.cur + 1} of ${ui.matches.length}`) : tx('Not found');
  ui.bar.classList.toggle('dfind-none', !!q && !ui.matches.length);
  for (const b of ui.bar.querySelectorAll('[data-needs]')) b.disabled = !ui.matches.length;
  const m = ui.matches[ui.cur];
  ui.where.textContent = m ? tx(`Slide ${m.slide + 1} · ${m.label}`) : '';
}
function step(by) {
  if (!ui.matches.length) return;
  ui.cur = (ui.cur + by + ui.matches.length) % ui.matches.length;
  status();
  mark(true);
}

function replaceOne() {
  const d = deckNow(), m = ui.matches[ui.cur];
  if (!d || !m) return;
  const r = replaceMatches(d, ui.q.value, ui.rep.value, ui.opts, m);
  if (!r.count) { search({ keep: true }); return; }
  ui.pendingKeep = true;
  ctxNow().commit(r.deck, { toastText: tx('Replaced 1') });
}
function replaceAll() {
  const d = deckNow();
  if (!d || !ui.q.value) return;
  const r = replaceMatches(d, ui.q.value, ui.rep.value, ui.opts);
  if (!r.count) { ctxNow().toast(tx('Nothing to replace')); return; }
  ui.pendingKeep = true;
  ctxNow().commit(r.deck, { toastText: tx(r.count === 1 ? 'Replaced 1' : `Replaced ${r.count}`) }); // one version: one undo
}

function optionButton(key, label, glyph) {
  const b = el('button', { type: 'button', class: 'dfind-opt', 'aria-pressed': String(ui.opts[key]), title: tx(label), 'aria-label': tx(label), onclick: () => { ui.opts[key] = !ui.opts[key]; b.setAttribute('aria-pressed', String(ui.opts[key])); search(); } }, glyph);
  return b;
}
const iconBtn = (name, label, run, extra = {}) => el('button', { type: 'button', class: 'dfind-ib', title: tx(label), 'aria-label': tx(label), onclick: run, ...extra }, icon(name, 16));

/** Open the find bar (with Replace showing when `replace`), the search box focused with its text selected. */
export function openFind(ctx, { replace = false } = {}) {
  if (IN_APP) return;
  featureCss();
  if (ctx) ui.ctx = ctx;
  if (!ui.bar) build(); else attach();
  ui.bar.classList.toggle('dfind-rep', replace || ui.bar.classList.contains('dfind-rep'));
  ui.repToggle.setAttribute('aria-expanded', String(ui.bar.classList.contains('dfind-rep')));
  ui.q.focus();
  ui.q.select();
  if (ui.q.value) search({ keep: true, go: false });
}
export function closeFind() {
  if (!ui.bar) return;
  ui.keep = { q: ui.q.value, rep: ui.rep.value }; // the next ⌘F starts from the same words (as Keynote does)
  ui.bar.remove();
  ui.bar = null;
  ui.matches = [];
  ui.cur = -1;
  post({ type: 'deck-marks', find: [], cur: -1 });
  const f = ctxNow().frame && ctxNow().frame();
  if (f) f.focus();
}
const isOpen = () => !!ui.bar;
// the bar lives in the editor's stage; the shell rebuilds the stage with each new version, so it is put back (focus too)
function attach() {
  if (!ui.bar) return;
  const host = document.querySelector('.dsh-canvas') || document.querySelector('.dsh') || document.querySelector('#deckStage') || document.body;
  if (ui.bar.parentNode === host) return;
  const lost = !document.activeElement || document.activeElement === document.body;
  host.append(ui.bar);
  if (lost && ui.focus && ui.bar.contains(ui.focus)) ui.focus.focus({ preventScroll: true });
}

function build() {
  ui.q = el('input', { type: 'search', class: 'dfind-q', placeholder: tx('Find in slides'), 'aria-label': tx('Find in slides'), autocomplete: 'off', spellcheck: 'false', 'data-key': 'find-q' });
  ui.rep = el('input', { type: 'text', class: 'dfind-q', placeholder: tx('Replace with'), 'aria-label': tx('Replace with'), autocomplete: 'off', 'data-key': 'find-rep' });
  if (ui.keep) { ui.q.value = ui.keep.q; ui.rep.value = ui.keep.rep; }
  ui.count = el('span', { class: 'dfind-count', role: 'status', 'aria-live': 'polite' });
  ui.where = el('span', { class: 'dfind-where' });
  let t = 0;
  ui.q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => search(), 120); });
  const keys = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (e.target === ui.rep) { if (e.metaKey || e.ctrlKey) replaceAll(); else replaceOne(); } else step(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
  };
  ui.q.addEventListener('keydown', keys);
  ui.rep.addEventListener('keydown', keys);
  ui.repToggle = el('button', { type: 'button', class: 'dfind-ib dfind-rt', 'aria-expanded': 'false', title: tx('Show Replace'), 'aria-label': tx('Show Replace'), onclick: () => { const on = !ui.bar.classList.contains('dfind-rep'); ui.bar.classList.toggle('dfind-rep', on); ui.repToggle.setAttribute('aria-expanded', String(on)); (on ? ui.rep : ui.q).focus(); } }, icon('chevron-r', 14));
  ui.bar = el('div', { class: 'dfind', role: 'search', 'aria-label': tx('Find and replace') },
    el('div', { class: 'dfind-row' }, ui.repToggle, icon('search', 16), ui.q, ui.count,
      optionButton('matchCase', 'Match case', 'Aa'), optionButton('wholeWord', 'Whole words', el('span', { class: 'dfind-ww' }, 'ab')),
      iconBtn('up', `Previous match (${formatKeys('Mod+Shift+G')})`, () => step(-1), { 'data-needs': '' }), iconBtn('down', `Next match (${formatKeys('Mod+G')})`, () => step(1), { 'data-needs': '' }),
      iconBtn('close', 'Close (Escape)', closeFind)),
    el('div', { class: 'dfind-row dfind-reprow' }, el('span', { class: 'dfind-pad' }), ui.rep,
      el('button', { type: 'button', class: 'dfind-btn', 'data-needs': '', onclick: replaceOne }, tx('Replace')),
      el('button', { type: 'button', class: 'dfind-btn', 'data-needs': '', title: tx('Replace every match (one undo)'), onclick: replaceAll }, tx('Replace All'))),
    ui.where);
  ui.bar.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); } });
  ui.bar.addEventListener('focusin', (e) => { ui.focus = e.target; });
  attach();
  status();
}

// the frame: a match's slide row to show, and a redrawn frame (after an edit) to mark again
if (!IN_APP && typeof addEventListener === 'function') {
  addEventListener('message', (e) => {
    const f = ui.bar && ctxNow().frame && ctxNow().frame();
    if (!f || e.source !== f.contentWindow || !e.data) return;
    if (e.data.type === 'deck-mark-at' && Number.isInteger(e.data.k) && e.data.k >= 0) post({ type: 'deck-go', k: e.data.k });
    else if (e.data.type === 'deck-ready') {
      attach();
      const d = deckNow();
      const changed = d && JSON.stringify(d.slides) !== ui.deckKey;
      if (changed || ui.pendingKeep) { const keep = true; ui.pendingKeep = false; search({ keep, go: false }); } else mark(false);
    }
  });
  registerShortcut({ id: 'find', keys: 'Mod+F', label: 'Find', run: (ctx) => openFind(ctx) });
  registerShortcut({ id: 'find-replace', keys: 'Mod+Alt+F', label: 'Find and replace', run: (ctx) => openFind(ctx, { replace: true }) });
  registerShortcut({ id: 'find-next', keys: 'Mod+G', label: 'Find next', when: () => isOpen(), run: () => step(1) });
  registerShortcut({ id: 'find-prev', keys: 'Mod+Shift+G', label: 'Find previous', when: () => isOpen(), run: () => step(-1) });
  registerTool({ id: 'find', label: 'Find', icon: 'search', group: 'view', order: 45, shortcut: 'Mod+F', title: 'Find and replace', run: (ctx) => (isOpen() ? closeFind() : openFind(ctx)), pressed: () => isOpen() });
  registerContextMenu({ id: 'find', target: 'file', order: 15, items: (ctx) => [{ heading: tx('Edit') }, { label: tx('Find…'), icon: 'search', shortcut: 'Mod+F', run: () => openFind(ctx) }, { label: tx('Find and Replace…'), shortcut: 'Mod+Alt+F', run: () => openFind(ctx, { replace: true }) }] });
}
