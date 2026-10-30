// "Handouts and notes…" in the File menu (web only): pick notes pages, 2 / 3 with lines / 6 slides a page or the
// outline, and the paper; it prints through deck.js exportPdf (the script-free static copy, "Save as PDF") with
// deck-handouts.js laying the pages out. The iPhone app's PDF path (appPdf) is never used for these.

import { el } from './util.js';
import { t as tx } from './i18n.js';
import { IN_APP } from './native.js';
import { registerContextMenu, context, kit } from './deck-shell.js';
import { HANDOUT_LAYOUTS, handoutDocument, paperFor } from './deck-handouts.js';
import { featureCss } from './deck-find.js';

const store = { get(k, d) { try { const v = localStorage.getItem(`eden-slides:handout:${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(`eden-slides:handout:${k}`, JSON.stringify(v)); } catch { /* private window */ } } };

// a tiny picture of each page layout (decorative)
const thumb = (id) => {
  const i = (h, w = '100%') => el('i', { style: { height: `${h}px`, width: w } });
  const u = () => el('u');
  const kids = id === 'notes' ? [i(22), u(), u(), u(), u(), u()]
    : id === '2' ? [i(24), i(24)]
      : id === '3' ? [0, 1, 2].map(() => el('span', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px' } }, i(13), el('span', { style: { display: 'grid', gap: '3px', alignContent: 'center' } }, u(), u(), u())))
        : id === '6' ? [el('span', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px' } }, ...Array.from({ length: 6 }, () => i(12)))]
          : [el('i', { style: { height: '4px', width: '70%' } }), u(), u(), u(), el('i', { style: { height: '3px', width: '50%' } }), u(), u()];
  return el('span', { class: 'dho-thumb', 'aria-hidden': 'true' }, ...kids);
};

/** The handout document for the current deck (the static print copy, re-laid out). */
export function handoutFor({ layout, paper, notes }) {
  return (html, deck) => handoutDocument(html, deck, { layout, paper, notes, labels: { slide: tx('Slide'), page: tx('Page'), of: tx('of'), notes: tx('Speaker notes'), noNotes: tx('No notes for this slide.'), outline: tx('Outline'), slides: tx('slides'), field: (s) => tx(s) } });
}

export function openHandouts(ctx = context()) {
  if (IN_APP || !ctx.currentDeck()) return;
  featureCss();
  let layout = store.get('layout', 'notes');
  if (!HANDOUT_LAYOUTS.some((x) => x[0] === layout)) layout = 'notes';
  const paperSel = el('select', { 'aria-label': tx('Paper') }, el('option', { value: 'letter' }, tx('US Letter')), el('option', { value: 'a4' }, 'A4'));
  paperSel.value = store.get('paper', paperFor(typeof navigator !== 'undefined' ? navigator.language : ''));
  const notesBox = el('input', { type: 'checkbox', id: 'dhoNotes' });
  notesBox.checked = store.get('notes', true);
  const notesRow = el('label', { for: 'dhoNotes', style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } }, notesBox, tx('Include speaker notes'));
  const picks = el('div', { class: 'dho-grid', role: 'radiogroup', 'aria-label': tx('Page layout') });
  const show = () => {
    picks.querySelectorAll('.dho-pick').forEach((b) => { const on = b.dataset.v === layout; b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    notesRow.hidden = layout !== 'outline';
  };
  for (const [id, label, detail] of HANDOUT_LAYOUTS) {
    picks.append(el('button', { type: 'button', role: 'radio', class: 'dho-pick', 'data-v': id, onclick: () => { layout = id; show(); } }, thumb(id), el('b', '', tx(label)), el('span', '', tx(detail))));
  }
  picks.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const all = [...picks.querySelectorAll('.dho-pick')];
    const n = all[(all.indexOf(document.activeElement) + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length];
    if (n) { e.preventDefault(); n.click(); n.focus(); }
  });
  show();
  const print = () => {
    store.set('layout', layout); store.set('paper', paperSel.value); store.set('notes', notesBox.checked);
    close();
    const run = ctx.actions && ctx.actions.exportPdf;
    if (run) run({ handout: handoutFor({ layout, paper: paperSel.value, notes: notesBox.checked }) });
  };
  const { close } = kit.sheet({ title: tx('Handouts and notes'), wide: true,
    content: el('div', '', picks, el('div', { class: 'dho-opts' }, el('label', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } }, tx('Paper'), paperSel), notesRow),
      el('p', { class: 'dspell-note', style: { marginTop: '10px' } }, tx('Opens the print dialog: choose “Save as PDF” to keep a file.'))),
    actions: [kit.button({ label: tx('Cancel'), onClick: () => close() }), kit.button({ label: tx('Print or save PDF…'), primary: true, icon: 'download', onClick: print })] });
}

if (!IN_APP && typeof addEventListener === 'function') {
  registerContextMenu({ id: 'handouts', target: 'file', order: 60, items: (ctx) => [{ label: tx('Handouts and notes…'), icon: 'notes', run: () => openHandouts(ctx) }] });
}
