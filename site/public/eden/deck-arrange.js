// Arranging and history in the web slide editor (deck.js calls initArrange only when !IN_APP; the iPhone app is
// unchanged). Everything plugs into the editor shell (deck-shell.js; contract research_notes/slides-redesign/
// inspector-api.md):
// - toolbar: Undo, Redo (the version arrows, ⌘Z ⇧⌘Z), Zoom (fit, 50–400%, rulers, guides, snap grid);
// - right-click items on thumbnails, the slide, text and free elements: Cut, Copy, Paste, Duplicate, Delete, Hide,
//   Move (start, end, a section), layer order, Add comment; they act on the navigator's multi-selection;
// - the History sheet (versions with time, kind and a thumbnail; name one to keep it, restore one as a new version,
//   compare one with now) from File and Document › History;
// - the slide sorter sheet (a grid: drag, click / Shift-click / ⌘-click / ⌘A, Delete, Duplicate, Hide, sections) from
//   View and Format › Arrange;
// - copy and paste of slides between decks (JSON with its pictures; plain text from PowerPoint/Keynote as slides);
// - hidden slides (skipped when presenting and in exports unless chosen) and sections (they fold in the navigator),
//   drawn in the frame by deck-arrange-frame.js with the zoom, rulers, guides and grid.
// The pure logic is deck-arrange-model.js.

import { el, toast } from './util.js';
import { t as tx } from './i18n.js';
import { layoutDeck, setText, normalizeFree, SLIDE_W, SLIDE_H } from './deck-model.js';
import { addFree, removeFree, arrangeFree } from './deck-freeform-draw.js';
import * as S from './deck-shell.js';
import { openContextMenu } from './deck-arrange-menu.js';
import { IN_APP } from './native.js';
import {
  versionKind, KIND_LABEL, nameVersion, restoreDeck, compareDecks, moveSlides, deleteSlides, duplicateSlides, setHidden,
  hiddenCount, forExport, sectionsOf, sectionNames, moveToSection, renameSection, clipSlides, parseClip, pasteSlides,
  zoomStep, ZOOMS, GRID_SIZES, cleanGuides, cleanSection, VERSION_NAME_MAX,
} from './deck-arrange-model.js';

let host = null; // { cur, currentDeck, commit(deck, { toastText, src }), frame(), slideAt(), storeImage(c, id, data, w, h), save(c), deckRender(), commentOn(anchor) }
const KEY = 'eden.slides.view';
const arr = { zoom: 0, rulers: false, grid: false, snap: false, gridSize: 40, includeHidden: false, fit: 1, clip: '', clipKind: '', freeClip: [], anchor: -1 };
try { Object.assign(arr, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* private mode */ }
arr.zoom = ZOOMS.includes(arr.zoom) ? arr.zoom : 0;
const keepView = () => { try { localStorage.setItem(KEY, JSON.stringify({ zoom: arr.zoom, rulers: arr.rulers, grid: arr.grid, snap: arr.snap, gridSize: arr.gridSize })); } catch { /* full or blocked */ } };
const perDeck = (c, what) => `eden.slides.${what}.${c && c.id}`;
const readDeck = (c, what, fallback) => { try { return JSON.parse(localStorage.getItem(perDeck(c, what)) || 'null') ?? fallback; } catch { return fallback; } };
const writeDeck = (c, what, v) => { try { localStorage.setItem(perDeck(c, what), JSON.stringify(v)); } catch { /* full or blocked */ } };
const MOD = S.IS_MAC ? '⌘' : 'Ctrl+';

/** deck.js hands over what arranging needs (once, web only). */
export function initArrange(h) {
  if (host) return;
  host = h;
  register();
}

// ── the frame: settings in, events out ──

const rows = (deck) => layoutDeck(deck); // the frame's thumbnails: one per layout row (a long slide draws as two)
function sendCfg() {
  const f = host && host.frame(), c = host && host.cur(), deck = host && host.currentDeck();
  if (!f || !f.contentWindow || !deck) return;
  f.contentWindow.postMessage({
    type: 'deck-arrange',
    hidden: deck.slides.map((s, i) => (s.hidden ? i : -1)).filter((i) => i >= 0),
    sections: sectionsOf(deck).filter((s) => s.name),
    collapsed: readDeck(c, 'collapsed', []),
    zoom: arr.zoom, rulers: arr.rulers, grid: arr.grid, snap: arr.snap, gridSize: arr.gridSize,
    guides: cleanGuides(readDeck(c, 'guides', {})),
  }, '*');
}
/** The navigator's multi-selection, highlighted in the frame. */
function showSel() {
  const f = host.frame(), deck = host.currentDeck();
  if (!f || !deck) return;
  const s = S.selection().slides;
  const set = new Set(s.length > 1 ? s : []);
  f.contentWindow.postMessage({ type: 'deck-thumbs-sel', ks: rows(deck).map((r, k) => (set.has(r.index) && r.part === 1 ? k : -1)).filter((k) => k >= 0) }, '*');
}
function pickSlides(indices) {
  const deck = host.currentDeck();
  if (!deck) return;
  const list = [...new Set(indices.filter((i) => Number.isInteger(i) && i >= 0 && i < deck.slides.length))];
  if (!list.length) return;
  S.select({ slides: list });
  showSel();
}
const goSlide = (i) => {
  const f = host.frame(), deck = host.currentDeck();
  if (!f || !deck) return;
  const k = rows(deck).findIndex((r) => r.index === i);
  if (k >= 0) f.contentWindow.postMessage({ type: 'deck-go', k }, '*');
};
/** The slides a menu item or key acts on: the multi-selection when the clicked slide is in it, else that slide. */
const targetSlides = (index) => {
  const s = S.selection().slides;
  return index >= 0 && s.length > 1 && s.includes(index) ? [...s].sort((a, b) => a - b) : index >= 0 ? [index] : [];
};

if (typeof addEventListener === 'function') addEventListener('message', (e) => {
  const f = host && host.frame();
  if (!f || e.source !== f.contentWindow) return;
  const m = e.data && typeof e.data === 'object' ? e.data : {};
  if (typeof m.type !== 'string') return;
  const deck = host.currentDeck(), c = host.cur();
  if (!deck || !c) return;
  const idx = Number.isInteger(m.index) && m.index >= 0 && m.index < deck.slides.length ? m.index : -1;
  const kIndex = (k) => { const r = rows(deck)[k]; return r ? r.index : -1; };
  switch (m.type) {
    case 'deck-ready': sendCfg(); if (S.selection().slides.length > 1) showSel(); break;
    case 'deck-fit': if (Number.isFinite(m.s) && m.s > 0 && !arr.zoom) arr.fit = m.s; break;
    case 'deck-guides': writeDeck(c, 'guides', cleanGuides(m.guides)); break;
    case 'deck-section-toggle': if (typeof m.name === 'string') { const s = new Set(readDeck(c, 'collapsed', [])); if (m.collapsed) s.add(m.name); else s.delete(m.name); writeDeck(c, 'collapsed', [...s].slice(0, 200)); } break;
    case 'deck-thumb-pick': { // Shift-click, ⌘-click, Shift+↑↓ and ⌘A in the navigator
      const i = Number.isInteger(m.k) ? kIndex(m.k) : -1;
      const now = S.selection();
      if (m.how === 'all') { pickSlides(deck.slides.map((_, j) => j)); break; }
      if (i < 0) break;
      if (m.how === 'toggle') { const set = new Set(now.slides); if (set.has(i) && set.size > 1) set.delete(i); else set.add(i); arr.anchor = i; pickSlides([...set]); }
      else if (m.how === 'range') { const a = arr.anchor >= 0 && arr.anchor < deck.slides.length ? arr.anchor : now.slide; const out = []; for (let j = Math.min(a, i); j <= Math.max(a, i); j++) out.push(j); pickSlides(out); }
      break;
    }
    case 'deck-at': if (idx >= 0 && S.selection().slides.length <= 1) arr.anchor = idx; break;
    case 'deck-thumbs-key': { // Delete / ⌘C / ⌘X on the navigator (several slides picked, or one)
      const sel = targetSlides(Number.isInteger(m.k) ? kIndex(m.k) : S.selection().slide);
      if (m.key === 'delete') delSlides(sel);
      else if (m.key === 'copy') copySlides(sel);
      else if (m.key === 'cut') { copySlides(sel); cutDone(sel); }
      break;
    }
    case 'deck-ctx': { // a right-click (or Shift+F10) in the frame: the one menu, with every item registered with the shell
      const T = { canvas: 'slide', free: 'element', text: 'text', thumb: 'thumb' }[m.kind];
      if (!T) break;
      const ids = Array.isArray(m.ids) ? m.ids.filter((x) => typeof x === 'string' && x.length <= 24).slice(0, 40) : [];
      if (T !== 'thumb' && idx >= 0 && idx !== S.selection().slide) S.select({ slide: idx });
      if (T === 'element' && ids.length) { S.select({ elementIds: ids }); f.contentWindow.postMessage({ type: 'deck-free-select', index: idx, ids, focus: false }, '*'); }
      const k = Number.isInteger(m.k) ? m.k : undefined;
      const info = { index: idx >= 0 ? idx : S.selection().slide, path: typeof m.path === 'string' && m.path.length < 80 ? m.path : undefined, id: ids[0], k };
      const r = f.getBoundingClientRect();
      openContextMenu(S.menuItems(T, info), r.left + Math.max(0, Math.min(r.width, Number(m.x) || 0)), r.top + Math.max(0, Math.min(r.height, Number(m.y) || 0)),
        { ctx: { ...S.context(), target: T, ...info }, back: f, keyboard: m.keyboard === true });
      break;
    }
    case 'deck-slide-paste': if (typeof m.text === 'string') pasteText(m.text, Number.isInteger(m.k) ? kIndex(m.k) : host.slideAt()); break;
    case 'deck-free-copy': arr.freeClip = normalizeFree(Array.isArray(m.items) ? m.items.slice(0, 40) : []); arr.clipKind = 'free'; break;
    default: break;
  }
});

// ── slides: copy, cut, paste, hide, move, delete, duplicate, sections ──

function copySlides(indices) {
  const deck = host.currentDeck(), c = host.cur();
  if (!deck || !c || !indices.length) return;
  const json = clipSlides(deck, indices, c.deckImages || {});
  arr.clip = json; arr.clipKind = 'slides';
  try { if (navigator.clipboard) navigator.clipboard.writeText(json).catch(() => {}); } catch { /* not allowed here: the copy above still pastes in Eden */ }
  toast(indices.length === 1 ? tx('Slide copied') : tx(`${indices.length} slides copied`));
}
function cutDone(indices) {
  const deck = host.currentDeck();
  if (!deck) return;
  const next = deleteSlides(deck, indices);
  if (next === deck) { toast(tx('A deck keeps at least one slide: copied instead')); return; }
  S.select({ slides: [] });
  host.commit(next, { toastText: indices.length === 1 ? tx('Slide cut') : tx(`${indices.length} slides cut`) });
}
/** Paste clipboard text (Eden slides, or plain text from PowerPoint or Keynote) after slide `after`. → the new indices. */
function pasteText(text, after) {
  const deck = host.currentDeck(), c = host.cur();
  if (!deck || !c) return [];
  const clip = parseClip(text);
  if (!clip) { toast(tx('Nothing on the clipboard to paste as slides')); return []; }
  const r = pasteSlides(deck, after, clip, c.deckImages || {});
  if (!r.indices.length) { toast(tx('This deck has reached its slide limit')); return []; }
  for (const [id, im] of Object.entries(r.images)) host.storeImage(c, id, im.data, im.w, im.h);
  host.commit(r.deck, { toastText: `${r.indices.length === 1 ? tx('Slide pasted') : tx(`${r.indices.length} slides pasted`)}${clip.from === 'text' ? ` ${tx('(from text)')}` : ''}${r.cut ? ` · ${tx(`${r.cut} didn’t fit`)}` : ''}` });
  return r.indices;
}
async function readClip() {
  try { if (navigator.clipboard && navigator.clipboard.readText) { const t = await navigator.clipboard.readText(); if (t) return t; } } catch { /* no permission: Eden's own copy */ }
  return arr.clip;
}
async function pasteSlidesAfter(after) { const t = await readClip(); if (!t) { toast(tx('Copy a slide first')); return []; } return pasteText(t, after); }

const edit = (fn, toastText) => { const d = host.currentDeck(); if (!d) return null; const next = fn(d); if (next && next !== d) { host.commit(next, { toastText }); return next; } return null; };
const hideSlides = (indices, hide) => edit((d) => setHidden(d, indices, hide), hide ? (indices.length === 1 ? tx('Slide hidden: skipped when presenting and exporting') : tx(`${indices.length} slides hidden`)) : tx('Shown again'));
const delSlides = (indices) => { const d = host.currentDeck(); if (d && indices.length >= d.slides.length) { toast(tx('A deck keeps at least one slide')); return null; } S.select({ slides: [] }); return edit((x) => deleteSlides(x, indices), indices.length === 1 ? tx(`Slide ${indices[0] + 1} deleted`) : tx(`${indices.length} slides deleted`)); };
const dupSlides = (indices) => { const d = host.currentDeck(); if (!d) return []; const r = duplicateSlides(d, indices); if (!r.indices.length) { toast(tx('This deck has reached its slide limit')); return []; } host.commit(r.deck, { toastText: tx('Duplicated') }); return r.indices; };
const moveTo = (indices, to) => edit((d) => moveSlides(d, indices, to), tx('Moved'));
const toSection = (indices, name) => edit((d) => moveToSection(d, indices, name), name ? tx(`Moved to “${name}”`) : tx('Taken out of its section'));

/** A one-line question in a small sheet. → the text, or null when cancelled. */
function askText(title, value = '', { max = 60, okLabel = 'OK', label = title } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const input = el('input', { type: 'text', class: 'dk-ask-in', value, maxlength: String(max), 'aria-label': label, autofocus: true });
    const finish = (v) => { if (done) return; done = true; resolve(v); sh.close(); };
    const form = el('form', { class: 'dk-ask', onsubmit: (e) => { e.preventDefault(); finish(input.value); } }, el('label', { class: 'dk-ask-l' }, label, input));
    const sh = S.kit.sheet({ title, content: form, onClose: () => { if (!done) { done = true; resolve(null); } },
      actions: [S.kit.button({ label: tx('Cancel'), onClick: () => finish(null) }), S.kit.button({ label: tx(okLabel), primary: true, onClick: () => finish(input.value) })] });
    sh.dialog.classList.add('dk-ask-sheet');
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}
async function newSection(indices) {
  const name = cleanSection(await askText(tx('New Section'), '', { label: tx('Section name') }));
  if (name) toSection(indices, name);
}
const moveItems = (sel, deck) => {
  const last = deck.slides.length - 1;
  const names = sectionNames(deck);
  return [
    { label: tx('To the Start'), icon: 'up', disabled: Math.min(...sel) === 0 && sel.length === 1, run: () => moveTo(sel, 0) },
    { label: tx('To the End'), icon: 'down', disabled: Math.max(...sel) === last && sel.length === 1, run: () => moveTo(sel, deck.slides.length) },
    ...names.map((n) => ({ label: tx(`To Section “${n}”`), run: () => toSection(sel, n) })),
    { label: tx('To a New Section…'), run: () => newSection(sel) },
    ...(sel.some((i) => deck.slides[i] && deck.slides[i].section) ? [{ label: tx('Out of Its Section'), run: () => toSection(sel, '') }] : []),
  ];
};

// ── the menu items (the shell draws the menus; its own items come first) ──

function thumbItems(ctx) {
  const deck = host.currentDeck();
  const sel = targetSlides(Number.isInteger(ctx.index) ? ctx.index : -1);
  if (!deck || !sel.length) return [];
  const allHidden = sel.every((i) => deck.slides[i] && deck.slides[i].hidden);
  const many = sel.length > 1;
  return [
    many ? { heading: tx(`${sel.length} slides`) } : null,
    { label: tx('Cut'), shortcut: 'Mod+X', disabled: sel.length >= deck.slides.length, run: () => { copySlides(sel); cutDone(sel); } },
    { label: tx('Copy'), shortcut: 'Mod+C', run: () => copySlides(sel) },
    { label: tx('Paste'), shortcut: 'Mod+V', run: () => pasteSlidesAfter(Math.max(...sel)) },
    many ? { label: tx(`Duplicate ${sel.length} Slides`), icon: 'duplicate', run: () => dupSlides(sel) } : null,
    many ? { label: tx(`Delete ${sel.length} Slides`), icon: 'trash', danger: true, disabled: sel.length >= deck.slides.length, run: () => delSlides(sel) } : null,
    { label: allHidden ? tx(many ? 'Show Slides' : 'Show Slide') : tx(many ? 'Hide Slides' : 'Hide Slide'), run: () => hideSlides(sel, !allHidden) },
    { label: tx('Move'), items: moveItems(sel, deck) },
    { separator: true },
    { label: tx('Slide Sorter…'), icon: 'grid', shortcut: 'Mod+Alt+S', sorter: true, run: () => openSorter({ select: sel }) },
    !many && host.commentOn ? { label: tx('Add Comment…'), icon: 'comment', run: () => host.commentOn({ slide: sel[0] }) } : null,
  ].filter(Boolean);
}
function slideItems(ctx) {
  const deck = host.currentDeck();
  const i = Number.isInteger(ctx.index) && ctx.index >= 0 ? ctx.index : host.slideAt();
  if (!deck || !deck.slides[i]) return [];
  const s = deck.slides[i];
  const free = arr.clipKind === 'free' && arr.freeClip.length;
  return [
    { label: free ? tx('Paste') : tx('Paste Slides After This One'), shortcut: 'Mod+V', run: () => (free ? pasteFree(i) : pasteSlidesAfter(i)) },
    { label: tx('Copy Slide'), run: () => copySlides([i]) },
    { label: s.hidden ? tx('Show Slide') : tx('Hide Slide'), run: () => hideSlides([i], !s.hidden) },
    host.commentOn ? { label: tx('Add Comment…'), icon: 'comment', run: () => host.commentOn({ slide: i }) } : null,
    { separator: true }, { heading: tx('Zoom') },
    { label: tx('Zoom In'), shortcut: 'Mod+=', run: () => setZoom(zoomStep(arr.zoom, 1, arr.fit)) },
    { label: tx('Zoom Out'), shortcut: 'Mod+-', run: () => setZoom(zoomStep(arr.zoom, -1, arr.fit)) },
    { label: tx('Fit'), checked: !arr.zoom, shortcut: 'Mod+0', run: () => setZoom(0) },
    { label: tx('Rulers'), checked: arr.rulers, run: () => setView({ rulers: !arr.rulers }) },
    { label: tx('Grid'), checked: arr.grid, run: () => setView({ grid: !arr.grid }) },
    { label: tx('Snap to Grid'), checked: arr.snap, run: () => setView({ snap: !arr.snap }) },
  ].filter(Boolean);
}
/** A slide text's value by its path ('title', 'bullets.2', 'left.bullets.0', 'notes'…). */
function textAt(deck, i, path) {
  let v = deck.slides[i];
  for (const p of path.split('.')) { if (v === null || v === undefined) return ''; v = v[/^\d+$/.test(p) ? Number(p) : p]; }
  if (v && typeof v === 'object' && typeof v.text === 'string') return v.text;
  return typeof v === 'string' ? v : '';
}
function textItems(ctx) {
  const deck = host.currentDeck();
  const i = Number.isInteger(ctx.index) ? ctx.index : -1;
  const path = typeof ctx.path === 'string' ? ctx.path : '';
  if (!deck || i < 0 || !deck.slides[i] || !path) return [];
  const value = textAt(deck, i, path);
  const writeClip = (t) => { arr.clip = t; arr.clipKind = 'text'; try { navigator.clipboard.writeText(t).catch(() => {}); } catch { /* the in-Eden copy still pastes */ } };
  return [
    { label: tx('Cut'), shortcut: 'Mod+X', disabled: !value, run: () => { writeClip(value); const d = host.currentDeck(); const next = setText(d, i, path, ''); if (next && next !== d) host.commit(next, { toastText: tx('Cut') }); } },
    { label: tx('Copy'), shortcut: 'Mod+C', disabled: !value, run: () => { writeClip(value); toast(tx('Copied')); } },
    { label: tx('Paste'), shortcut: 'Mod+V', run: async () => { const t = await readClip(); const f = host.frame(); const clip = t && parseClip(t); if (!t || !f || (clip && clip.from === 'eden')) { toast(tx('Nothing to paste as text')); return; } f.focus(); f.contentWindow.postMessage({ type: 'deck-arrange-insert', index: i, path, text: t }, '*'); } },
    host.commentOn ? { label: tx('Add Comment…'), icon: 'comment', run: () => host.commentOn({ slide: i, path }) } : null,
  ].filter(Boolean);
}
function elementItems(ctx) {
  const deck = host.currentDeck();
  const i = Number.isInteger(ctx.index) && ctx.index >= 0 ? ctx.index : host.slideAt();
  const picked = S.selection().elementIds;
  const ids = picked.length ? picked : typeof ctx.id === 'string' ? [ctx.id] : [];
  if (!deck || !deck.slides[i] || !ids.length) return [];
  const items = () => ((host.currentDeck().slides[i] || {}).free || []).filter((e) => ids.includes(e.id));
  const copy = () => { const list = normalizeFree(items()); arr.freeClip = list; arr.clipKind = 'free'; const f = host.frame(); if (f) dispatchEvent(new MessageEvent('message', { data: { type: 'deck-free-copy', items: list }, source: f.contentWindow })); }; // ⌘V on the slide pastes it too (deck-freeform.js keeps its own copy)
  const save = (next, toastText) => { const d = host.currentDeck(); if (next && next !== d) host.commit(next, { toastText }); };
  return [
    { label: tx('Cut'), shortcut: 'Mod+X', run: () => { copy(); save(removeFree(host.currentDeck(), i, ids), tx('Cut')); } },
    { label: tx('Copy'), shortcut: 'Mod+C', run: () => { copy(); toast(tx('Copied')); } },
    { label: tx('Paste'), shortcut: 'Mod+V', disabled: !arr.freeClip.length, run: () => pasteFree(i) },
    { label: tx('Duplicate'), icon: 'duplicate', run: () => { const r = addFree(host.currentDeck(), i, items(), { offset: 20 }); if (!r.ids.length) toast(tx('This slide holds at most 40 elements')); else save(r.deck, tx('Duplicated')); } },
    { label: tx('Delete'), icon: 'trash', danger: true, shortcut: 'Backspace', run: () => save(removeFree(host.currentDeck(), i, ids), tx('Deleted')) },
    { separator: true }, { heading: tx('Arrange') },
    { label: tx('Bring Forward'), shortcut: ']', run: () => save(arrangeFree(host.currentDeck(), i, ids, 'forward')) },
    { label: tx('Send Backward'), shortcut: '[', run: () => save(arrangeFree(host.currentDeck(), i, ids, 'back')) },
    { label: tx('Bring to Front'), run: () => save(arrangeFree(host.currentDeck(), i, ids, 'front')) },
    { label: tx('Send to Back'), run: () => save(arrangeFree(host.currentDeck(), i, ids, 'bottom')) },
    host.commentOn ? { separator: true } : null,
    host.commentOn ? { label: tx('Add Comment…'), icon: 'comment', run: () => host.commentOn({ slide: i }) } : null,
  ].filter(Boolean);
}
function pasteFree(i) {
  const deck = host.currentDeck();
  if (!deck || !arr.freeClip.length) return;
  const r = addFree(deck, i, arr.freeClip, { offset: 20 });
  if (!r.ids.length) { toast(tx('This slide holds at most 40 elements')); return; }
  host.commit(r.deck, { toastText: tx('Pasted') });
}

// ── registering with the shell ──

const histNav = (id) => { const b = document.getElementById(id); if (b && !b.disabled) b.click(); };
function register() {
  const { registerTool: tool, registerContextMenu: menu, registerShortcut: key, registerInspector: section, kit } = S;
  cssOnce();
  tool({ id: 'undo', group: 'view', order: 40, label: tx('Undo'), icon: 'undo', shortcut: 'Mod+Z', title: tx('Undo: the version before'), domId: 'dkUndo', run: () => histNav('artPrev') });
  tool({ id: 'redo', group: 'view', order: 41, label: tx('Redo'), icon: 'redo', shortcut: 'Mod+Shift+Z', title: tx('Redo: the version after'), domId: 'dkRedo', run: () => histNav('artNext') });
  tool({ id: 'zoom', group: 'view', order: 50, label: tx('Zoom'), icon: 'zoom', title: tx('Zoom, rulers, guides and the grid'), popover: () => viewPanel() });
  menu({ id: 'arrange-thumb', target: 'thumb', order: 20, items: thumbItems });
  menu({ id: 'arrange-slide', target: 'slide', order: 20, items: slideItems });
  menu({ id: 'arrange-text', target: 'text', order: 20, items: textItems });
  menu({ id: 'arrange-element', target: 'element', order: 5, items: elementItems }); // before Format…: the everyday verbs first
  menu({ id: 'arrange-view', target: 'view', order: 20, items: () => [
    { label: tx('Slide Sorter…'), icon: 'grid', shortcut: 'Mod+Alt+S', run: () => openSorter() },
    { separator: true },
    { label: tx('Zoom In'), shortcut: 'Mod+=', run: () => setZoom(zoomStep(arr.zoom, 1, arr.fit)) },
    { label: tx('Zoom Out'), shortcut: 'Mod+-', run: () => setZoom(zoomStep(arr.zoom, -1, arr.fit)) },
    { label: tx('Fit Slide in Window'), checked: !arr.zoom, shortcut: 'Mod+0', run: () => setZoom(0) },
    { label: tx('Rulers'), checked: arr.rulers, run: () => setView({ rulers: !arr.rulers }) },
    { label: tx('Grid'), checked: arr.grid, run: () => setView({ grid: !arr.grid }) },
    { label: tx('Snap to Grid'), checked: arr.snap, run: () => setView({ snap: !arr.snap }) },
  ] });
  menu({ id: 'arrange-file', target: 'file', order: 20, items: () => {
    const n = hiddenCount(host.currentDeck());
    return [{ label: tx('Version History…'), icon: 'record', run: () => openHistory() },
      n ? { label: n === 1 ? tx('Include the Hidden Slide in Exports') : tx(`Include ${n} Hidden Slides in Exports`), checked: arr.includeHidden, run: () => { arr.includeHidden = !arr.includeHidden; } } : null].filter(Boolean);
  } });
  key({ id: 'zoom-in', keys: 'Mod+=', label: tx('Zoom in'), run: () => setZoom(zoomStep(arr.zoom, 1, arr.fit)) });
  key({ id: 'zoom-out', keys: 'Mod+-', label: tx('Zoom out'), run: () => setZoom(zoomStep(arr.zoom, -1, arr.fit)) });
  key({ id: 'zoom-fit', keys: 'Mod+0', label: tx('Fit the slide'), run: () => setZoom(0) });
  key({ id: 'sorter', keys: 'Mod+Alt+S', label: tx('Slide sorter'), run: () => openSorter() });
  // Format › Arrange: hide, section, the sorter; with several slides picked, what to do with all of them
  section({ id: 'slide-arrange', tab: 'format', order: 85, title: 'Arrange', when: (s) => s.kind !== 'element', render: (ctx) => {
    const d = ctx.deck;
    const sel = ctx.selection.slides.length > 1 ? [...ctx.selection.slides].sort((a, b) => a - b) : [ctx.selection.slide];
    if (!d || !sel.every((i) => d.slides[i])) return null;
    const many = sel.length > 1, allHidden = sel.every((i) => d.slides[i].hidden);
    const names = sectionNames(d);
    const cur = many ? '' : d.slides[sel[0]].section || '';
    const secSel = el('select', { class: 'deck-theme', 'data-key': 'arrange:section', 'aria-label': tx('Section'), onchange: (e) => { const v = e.target.value; ctx.keepFocus('arrange:section'); if (v === '__new') { e.target.value = cur; newSection(sel); } else toSection(sel, v); } },
      el('option', { value: '', selected: !cur ? true : null }, tx('None')), ...names.map((n) => el('option', { value: n, selected: n === cur ? true : null }, n)), el('option', { value: '__new' }, tx('New section…')));
    return el('div', { class: 'dsh-sec-body' },
      many ? el('p', { class: 'dk-many', role: 'status' }, tx(`${sel.length} slides selected`)) : null,
      kit.row(tx('In the show'), kit.segmented({ label: tx('Show or hide in the slideshow and exports'), key: 'arrange:hidden', value: allHidden ? 'hide' : 'show', options: [{ value: 'show', label: tx('Shown') }, { value: 'hide', label: tx('Hidden') }], onChange: (v) => hideSlides(sel, v === 'hide') })),
      kit.row(tx('Section'), secSel),
      el('div', { class: 'dsh-btns' },
        many ? kit.button({ icon: 'duplicate', label: tx('Duplicate'), key: 'arrange:dup', onClick: () => dupSlides(sel) }) : null,
        many ? kit.button({ icon: 'trash', label: tx(`Delete ${sel.length}`), key: 'arrange:del', disabled: sel.length >= d.slides.length, onClick: () => delSlides(sel) }) : null,
        kit.button({ label: tx('Copy'), key: 'arrange:copy', onClick: () => copySlides(sel) }),
        kit.button({ label: tx('Paste'), key: 'arrange:paste', onClick: () => pasteSlidesAfter(Math.max(...sel)) }),
        kit.button({ icon: 'grid', label: tx('Slide Sorter…'), key: 'arrange:sorter', shortcut: 'Mod+Alt+S', onClick: () => openSorter({ select: sel }) })),
      hiddenCount(d) ? el('p', { class: 'dsh-hint' }, tx('Hidden slides are skipped when you play the deck and left out of exports (File has a switch to include them).')) : null);
  } });
  // Document › History
  section({ id: 'history', tab: 'document', order: 70, title: 'History', render: (ctx) => {
    const c = ctx.conv;
    const vs = c && Array.isArray(c.deckVersions) ? c.deckVersions : [];
    const named = vs.filter((v) => v.pinned).reverse();
    return el('div', { class: 'dsh-sec-body' },
      el('p', { class: 'dsh-hint' }, tx(`${vs.length} versions${named.length ? `, ${named.length} named` : ''}. Every edit is a version; name one to keep it.`)),
      ...named.slice(0, 5).map((v) => kit.listRow({ icon: 'record', label: v.name, detail: when(v.at), key: `hist:${v.id}`, onClick: () => openHistory() })),
      el('div', { class: 'dsh-btns' }, kit.button({ icon: 'record', label: tx('Version History…'), key: 'btn:history', onClick: () => openHistory() })));
  } });
}

// ── exports: hidden slides left out unless chosen ──

/** The deck to export, or null (told why) when every slide is hidden. */
export function exportDeck(deck) {
  if (!deck || IN_APP) return deck; // the iPhone app exports as it always has
  const d = forExport(deck, { includeHidden: arr.includeHidden });
  if (!d) toast(tx('Every slide is hidden: show one, or choose File › Include Hidden Slides in Exports'));
  return d;
}

// ── zoom, rulers, guides, grid ──

function setZoom(z) { arr.zoom = z > 0 ? z : 0; keepView(); sendCfg(); S.closePopover(); toast(arr.zoom ? `${tx('Zoom')} ${Math.round(arr.zoom * 100)}%` : tx('Fit')); }
function setView(p) { Object.assign(arr, p); keepView(); sendCfg(); }
/** The Zoom popover: fit, 50–400% (also ⌘+ ⌘− ⌘0), rulers, grid, snapping, guides. */
export function viewPanel() {
  const { kit } = S;
  const check = (k, label) => el('label', { class: 'dk-check-l' }, el('input', { type: 'checkbox', 'data-key': `view-${k}`, checked: arr[k] ? true : null, onchange: (e) => setView({ [k]: e.target.checked }) }), tx(label));
  const zoomSel = el('select', { class: 'deck-theme', 'data-key': 'zoom', 'aria-label': tx('Zoom'), onchange: (e) => setZoom(Number(e.target.value)) },
    el('option', { value: '0' }, `${tx('Fit')} (${Math.round(arr.fit * 100)}%)`), ...ZOOMS.map((z) => el('option', { value: String(z) }, `${Math.round(z * 100)}%`)));
  zoomSel.value = String(arr.zoom);
  return el('div', { class: 'dsh-menu-list dk-view' },
    el('p', { class: 'dsh-pop-title' }, tx('Zoom')),
    el('div', { class: 'dk-row' }, kit.iconButton({ icon: 'minus', label: tx('Zoom out'), shortcut: 'Mod+-', key: 'zoom-out', onClick: () => setZoom(zoomStep(arr.zoom, -1, arr.fit)) }), zoomSel,
      kit.iconButton({ icon: 'plus', label: tx('Zoom in'), shortcut: 'Mod+=', key: 'zoom-in', onClick: () => setZoom(zoomStep(arr.zoom, 1, arr.fit)) })),
    el('div', { class: 'dk-col', role: 'group', 'aria-label': tx('Rulers and grid') }, check('rulers', 'Rulers'), check('grid', 'Grid'), check('snap', 'Snap to grid'),
      el('label', { class: 'dk-check-l' }, tx('Grid size'), el('select', { class: 'deck-theme', 'data-key': 'view-gridsize', onchange: (e) => setView({ gridSize: Number(e.target.value) }) },
        ...GRID_SIZES.map((g) => el('option', { value: String(g), selected: g === arr.gridSize ? true : null }, `${g} px`))))),
    el('div', { class: 'dk-row' },
      kit.button({ label: tx('Vertical guide'), icon: 'plus', small: true, key: 'view-guide-v', onClick: () => addGuide('x') }),
      kit.button({ label: tx('Horizontal guide'), icon: 'plus', small: true, key: 'view-guide-h', onClick: () => addGuide('y') }),
      kit.button({ label: tx('Clear guides'), small: true, key: 'view-guides-clear', onClick: () => { writeDeck(host.cur(), 'guides', { x: [], y: [] }); sendCfg(); toast(tx('Guides cleared')); } })),
    el('p', { class: 'dsh-hint' }, tx('Drag from a ruler to add a guide; drag it off the slide to remove it. A focused guide moves with the arrow keys (Shift: 10 px); Delete removes it. Free elements snap to guides, and to the grid when Snap is on.')));
}
function addGuide(axis) {
  const c = host.cur(), g = cleanGuides(readDeck(c, 'guides', {}));
  let v = axis === 'x' ? 640 : 360;
  while (g[axis].includes(v)) v += 20;
  g[axis].push(v);
  writeDeck(c, 'guides', cleanGuides(g));
  arr.rulers = true;
  keepView(); sendCfg();
  toast(tx(axis === 'x' ? `Vertical guide at ${v}` : `Horizontal guide at ${v}`));
}

// ── thumbnails: one script-free slide per frame (like the template gallery), drawn when in view ──

function thumbs() {
  const urls = [];
  let R = null;
  const queue = [];
  const io = new IntersectionObserver((entries) => { for (const en of entries) if (en.isIntersecting) { io.unobserve(en.target); draw(en.target); } }, { rootMargin: '200px' });
  host.deckRender().then((m) => { R = m; queue.splice(0).forEach(draw); }).catch(() => {});
  function draw(box) {
    if (!R) { queue.push(box); return; }
    let html;
    try { html = R.deckDocument(box._deck, { mode: 'static', images: (host.cur() || {}).deckImages || {} }); } catch { box.classList.add('dk-thumb-fail'); return; }
    const u = URL.createObjectURL(new Blob([html], { type: 'text/html; charset=utf-8' }));
    urls.push(u);
    const f = el('iframe', { sandbox: '', src: u, tabindex: '-1', title: '', 'aria-hidden': 'true', referrerpolicy: 'no-referrer', width: String(SLIDE_W), height: String(SLIDE_H) });
    box.append(f);
    const fit = () => { if (box.clientWidth) f.style.transform = `scale(${box.clientWidth / SLIDE_W})`; };
    fit();
    new ResizeObserver(fit).observe(box);
  }
  return {
    of(deck, k) { const box = el('div', { class: 'dk-thumb', 'aria-hidden': 'true' }); const s = deck && deck.slides[k]; if (!s) { box.classList.add('dk-thumb-none'); return box; } box._deck = { ...deck, sources: [], slides: [s] }; io.observe(box); return box; },
    done() { io.disconnect(); urls.forEach((u) => URL.revokeObjectURL(u)); urls.length = 0; },
  };
}
const when = (at) => {
  if (!at) return '';
  const t = new Date(at), now = new Date();
  const time = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return t.toDateString() === now.toDateString() ? time : `${t.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
};

// ── History ──

/** The deck's versions, newest first: name one (it's kept past the 40-version cap), restore one as a new version, compare one with now. */
export function openHistory() {
  const c = host.cur();
  if (!c || !Array.isArray(c.deckVersions) || !c.deckVersions.length) { toast(tx('No versions yet')); return; }
  S.closePopover();
  let th = thumbs();
  const body = el('div', { class: 'dk-body' });
  const sh = S.kit.sheet({ title: tx('Version History'), wide: true, content: body, onClose: () => th.done() });
  sh.dialog.classList.add('dk-history');
  const shownKey = () => { const cur = host.currentDeck(); return cur ? JSON.stringify(cur.slides) : ''; };
  function list(focusKey) {
    th.done(); th = thumbs();
    const vs = c.deckVersions.slice().reverse();
    const nowKey = shownKey();
    const named = vs.filter((v) => v.pinned).length;
    let curShown = false;
    const ul = el('ul', { class: 'dk-versions', 'aria-label': tx('Versions, newest first') });
    vs.forEach((v, k) => {
      const kind = versionKind(v);
      const isCur = !curShown && !!v.deck && JSON.stringify(v.deck.slides) === nowKey;
      if (isCur) curShown = true;
      const label = `${v.name ? `${v.name}, ` : ''}${tx(KIND_LABEL[kind])}, ${when(v.at)}`;
      ul.append(el('li', { class: `dk-ver${isCur ? ' dk-cur' : ''}`, 'aria-label': `${label}${isCur ? `, ${tx('shown now')}` : ''}` },
        th.of(v.deck, 0),
        el('div', { class: 'dk-ver-t' },
          v.name ? el('strong', { class: 'dk-ver-name' }, v.name) : null,
          el('span', { class: `dk-kind dk-k-${kind}` }, tx(KIND_LABEL[kind])),
          el('span', { class: 'dk-when' }, `${when(v.at)} · ${v.deck && v.deck.slides ? tx(`${v.deck.slides.length} slides`) : ''}`),
          isCur ? el('span', { class: 'dk-badge' }, tx('Shown now')) : null,
          v.pinned ? el('span', { class: 'dk-badge dk-pin', title: tx('Named versions are kept however many edits follow') }, tx('Kept')) : null),
        el('div', { class: 'dk-ver-a' },
          S.kit.button({ label: tx('Restore'), small: true, key: `restore-${v.id}`, disabled: k === 0 && isCur, onClick: () => restore(v) }),
          S.kit.button({ label: tx('Compare'), small: true, key: `compare-${v.id}`, onClick: () => compare(v) }),
          S.kit.button({ label: v.name ? tx('Rename…') : tx('Name…'), small: true, key: `name-${v.id}`, onClick: () => rename(v) }))));
    });
    body.replaceChildren(el('p', { class: 'dsh-hint' }, tx(`Eden keeps the last 40 versions, and every named one${named ? ` (${named} named)` : ''}. Restoring adds the old version as the newest, so nothing is lost.`)), ul);
    const f = focusKey && body.querySelector(`[data-key="${focusKey}"]`);
    setTimeout(() => (f || body.querySelector('button:not([disabled])') || body).focus(), 0);
  }
  async function rename(v) {
    const name = await askText(tx('Name This Version'), v.name || '', { max: VERSION_NAME_MAX, okLabel: 'Save', label: tx('Version name (empty removes it)') });
    if (name === null) return;
    c.deckVersions = nameVersion(c.deckVersions, v.id, name);
    host.save(c);
    const clean = name.trim();
    toast(clean ? tx(`Named “${clean.slice(0, VERSION_NAME_MAX)}”: it’s kept however many edits follow`) : tx('Name removed'));
    if (sh.dialog.open) list(`name-${v.id}`);
  }
  function restore(v) {
    const deck = restoreDeck(c.deckVersions, v.id);
    if (!deck) return;
    sh.close();
    host.commit(deck, { src: 'restore', toastText: v.name ? tx(`Restored “${v.name}” as the newest version`) : tx(`Restored the ${when(v.at)} version as the newest`) });
  }
  function compare(v) {
    const now = host.currentDeck();
    if (!now || !v.deck) return;
    th.done(); th = thumbs();
    const r = compareDecks(v.deck, now);
    const STATUS = { same: 'Same', changed: 'Changed', added: 'Added since', removed: 'Removed since', moved: 'Moved' };
    const diff = r.rows.filter((x) => x.status !== 'same');
    const summary = r.changes || r.title || r.theme
      ? [r.changes ? tx(`${r.changes} slide${r.changes === 1 ? '' : 's'} differ`) : '', r.title ? tx(`title “${r.title.a}” → “${r.title.b}”`) : '', r.theme ? tx('a different theme') : ''].filter(Boolean).join(' · ')
      : tx('Same as the current deck');
    const none = () => el('div', { class: 'dk-thumb dk-thumb-none', 'aria-hidden': 'true' });
    body.replaceChildren(
      el('div', { class: 'dsh-btns' }, S.kit.button({ label: `← ${tx('All versions')}`, key: 'hist-back', onClick: () => list(`compare-${v.id}`) }),
        S.kit.button({ label: tx('Restore This Version'), primary: true, key: 'hist-restore', onClick: () => restore(v) })),
      el('h3', { class: 'dk-h3', tabindex: '-1' }, `${v.name || tx(KIND_LABEL[versionKind(v)])} · ${when(v.at)} ${tx('compared with now')}`),
      el('p', { role: 'status' }, summary),
      diff.length ? el('div', { class: 'dk-cmp-head', 'aria-hidden': 'true' }, el('span', '', tx('That version')), el('span', '', tx('Now'))) : null,
      el('ul', { class: 'dk-cmp', 'aria-label': tx('Differences') }, ...diff.map((x) => el('li', { class: `dk-cmp-row dk-s-${x.status}`, 'aria-label': `${tx(STATUS[x.status])}: ${x.name || tx('untitled slide')}${x.a >= 0 ? `, ${tx('was slide')} ${x.a + 1}` : ''}${x.b >= 0 ? `, ${tx('now slide')} ${x.b + 1}` : ''}` },
        x.a >= 0 ? th.of(v.deck, x.a) : none(), x.b >= 0 ? th.of(now, x.b) : none(),
        el('span', { class: 'dk-cmp-t' }, el('span', { class: `dk-kind dk-st-${x.status}` }, tx(STATUS[x.status])), ` ${x.name || ''}`, el('span', { class: 'dk-when' }, `${x.a >= 0 ? `${tx('was')} ${x.a + 1}` : ''}${x.a >= 0 && x.b >= 0 ? ' → ' : ''}${x.b >= 0 ? `${tx('now')} ${x.b + 1}` : ''}`))))));
    body.querySelector('.dk-h3').focus();
  }
  list();
}

// ── the slide sorter ──

/** Every slide in a grid, in its sections: drag to reorder; click, Shift-click, ⌘-click, ⌘A select; act on the selection. */
export function openSorter({ select = null } = {}) {
  const c = host.cur();
  if (!c || !host.currentDeck()) return;
  S.closePopover();
  let th = thumbs();
  const start = select && select.length ? select : S.selection().slides.length > 1 ? S.selection().slides : [host.slideAt()];
  const st = { sel: new Set(start), anchor: start[0], focus: start[0] };
  const count = el('span', { class: 'dk-count', role: 'status' });
  const grid = el('div', { class: 'dk-grid', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': tx('Slides'), 'aria-describedby': 'dkSorterHint' });
  const bar = el('div', { class: 'dsh-btns dk-sorter-bar', role: 'toolbar', 'aria-label': tx('Selected slides') });
  const content = el('div', { class: 'dk-sorter-body' }, el('div', { class: 'dk-sorter-top' }, bar, count),
    el('p', { class: 'dsh-hint', id: 'dkSorterHint' }, tx(`Arrow keys move, Space picks, Shift+arrows pick a run, ${MOD}A all. Alt+arrows move the picked slides; Delete, ${MOD}D duplicate, H hide, ${MOD}C ${MOD}X ${MOD}V. Enter opens a slide. Drag to reorder.`)), grid);
  const deck = () => host.currentDeck();
  const sel = () => { const d = deck(); return d ? [...st.sel].filter((i) => i < d.slides.length).sort((a, b) => a - b) : []; };
  const sh = S.kit.sheet({ title: tx('Slide Sorter'), wide: true, content, onClose: () => { th.done(); const s = sel(); if (s.length > 1) { S.select({ slides: s }); showSel(); } }, actions: [S.kit.button({ label: tx('Done'), primary: true, onClick: () => sh.close() })] });
  sh.dialog.classList.add('dk-sorter');
  const pick = (indices) => { if (indices && indices.length) { st.sel = new Set(indices); st.focus = indices[0]; st.anchor = indices[0]; } };
  const after = () => setTimeout(draw, 0); // each edit redraws the canvas; the sorter redraws from the new deck, keeping the selection and focus
  const act = {
    del: () => { const s = sel(); if (delSlides(s)) pick([Math.min(s[0], deck().slides.length - 1)]); after(); },
    dup: () => { pick(dupSlides(sel())); after(); },
    hide: () => { const s = sel(); hideSlides(s, !s.every((i) => deck().slides[i].hidden)); after(); },
    copy: () => copySlides(sel()),
    cut: () => { const s = sel(); copySlides(s); cutDone(s); pick([Math.max(0, s[0] - 1)]); after(); },
    paste: async (text) => { const d = deck(); const at = sel().length ? Math.max(...sel()) : d.slides.length - 1; const got = text ? pasteText(text, at) : await pasteSlidesAfter(at); pick(got); after(); },
    move: (to) => { const s = sel(); if (moveTo(s, to)) { const before = s.filter((i) => i < to).length; const at = Math.max(0, Math.min(deck().slides.length - s.length, to - before)); pick(s.map((_, k) => at + k)); } after(); },
    section: async (v) => { const s = sel(); if (v === '__new') { const name = cleanSection(await askText(tx('New Section'), '', { label: tx('Section name') })); if (!name) return; toSection(s, name); } else toSection(s, v); after(); },
  };
  function drawBar() {
    const s = sel(), dk = deck();
    const hid = s.length && s.every((i) => dk.slides[i].hidden);
    const names = sectionNames(dk);
    const b = (key, label, fn, dis = false, icon) => S.kit.button({ label: tx(label), icon, small: true, key: `sorter:${key}`, disabled: dis, onClick: fn });
    const secSel = el('select', { class: 'deck-theme', 'data-key': 'sorter:section', 'aria-label': tx('Move to a section'), disabled: s.length ? null : true, onchange: (e) => { const v = e.target.value; e.target.value = ''; if (v !== '') act.section(v === '__none' ? '' : v); } },
      el('option', { value: '' }, tx('Move to section…')), ...names.map((n) => el('option', { value: n }, n)), el('option', { value: '__new' }, tx('New section…')),
      s.some((i) => dk.slides[i].section) ? el('option', { value: '__none' }, tx('No section')) : null);
    bar.replaceChildren(b('delete', s.length > 1 ? `Delete ${s.length}` : 'Delete', act.del, !s.length || s.length >= dk.slides.length, 'trash'), b('duplicate', 'Duplicate', act.dup, !s.length, 'duplicate'), b('hide', hid ? 'Show' : 'Hide', act.hide, !s.length),
      secSel, b('copy', 'Copy', act.copy, !s.length), b('cut', 'Cut', act.cut, !s.length || s.length >= dk.slides.length), b('paste', 'Paste', () => act.paste()));
    count.textContent = s.length > 1 ? tx(`${s.length} of ${dk.slides.length} selected`) : tx(`${dk.slides.length} slides`);
  }
  const collapsed = () => new Set(readDeck(c, 'collapsed', []));
  function draw() {
    const dk = deck();
    if (!dk) { sh.close(); return; }
    if (!sh.dialog.open) return;
    const a = document.activeElement;
    const hadFocus = !!(a && sh.dialog.contains(a) && a.closest('.dk-tile'));
    th.done(); th = thumbs();
    st.sel = new Set(sel());
    st.focus = Math.max(0, Math.min(st.focus, dk.slides.length - 1));
    if (!st.sel.size) st.sel.add(st.focus);
    const fold = collapsed();
    const parts = [];
    for (const sec of sectionsOf(dk)) {
      const tiles = [];
      for (let i = sec.start; i <= sec.end; i++) {
        const s = dk.slides[i], on = st.sel.has(i);
        tiles.push(el('div', { class: `dk-tile${on ? ' dk-on' : ''}${s.hidden ? ' dk-hid' : ''}`, role: 'option', id: `dkTile${i}`, 'data-i': String(i), tabindex: i === st.focus ? '0' : '-1', 'aria-selected': String(on),
          'aria-label': `${tx('Slide')} ${i + 1}: ${s.title || s.quote || tx('untitled')}${s.hidden ? `, ${tx('hidden')}` : ''}` },
        th.of(dk, i), el('span', { class: 'dk-n', 'aria-hidden': 'true' }, String(i + 1)), s.hidden ? el('span', { class: 'dk-hid-b', 'aria-hidden': 'true' }, tx('Hidden')) : null,
        el('span', { class: 'dk-tt', 'aria-hidden': 'true' }, s.title || s.quote || '')));
      }
      if (!sec.name) { parts.push(...tiles); continue; }
      const open = !fold.has(sec.name);
      const head = el('div', { class: 'dk-sec-h' },
        el('button', { type: 'button', class: 'dk-sec-t', 'aria-expanded': String(open), onclick: () => { const f = collapsed(); if (open) f.add(sec.name); else f.delete(sec.name); writeDeck(c, 'collapsed', [...f]); sendCfg(); draw(); } },
          el('span', { class: 'dk-tw', 'aria-hidden': 'true' }, '▾'), sec.name, el('span', { class: 'dk-when' }, ` · ${tx(`${sec.end - sec.start + 1} slides`)}`)),
        S.kit.button({ label: tx('Rename…'), small: true, quiet: true, onClick: async () => { const n = await askText(tx('Rename Section'), sec.name, { label: tx('Section name (empty removes it)') }); if (n !== null) { edit((x) => renameSection(x, sec.name, n), tx('Section renamed')); after(); } } }));
      parts.push(el('div', { class: 'dk-sec', role: 'group', 'aria-label': `${tx('Section')} ${sec.name}` }, head, open ? el('div', { class: 'dk-sec-g' }, ...tiles) : null));
    }
    grid.replaceChildren(...parts);
    drawBar();
    const f = grid.querySelector(`[data-i="${st.focus}"]`) || grid.querySelector('.dk-tile');
    const lost = !document.activeElement || document.activeElement === document.body || document.activeElement === sh.dialog || !sh.dialog.contains(document.activeElement);
    if (f) { f.tabIndex = 0; if (hadFocus || lost) f.focus(); }
  }
  const tiles = () => [...grid.querySelectorAll('.dk-tile')];
  const tileI = (t) => Number(t.dataset.i);
  const focusTile = (i) => { const t = grid.querySelector(`[data-i="${i}"]`); if (!t) return; tiles().forEach((x) => { x.tabIndex = -1; }); t.tabIndex = 0; t.focus(); st.focus = i; };
  const paint = () => { for (const t of tiles()) { const on = st.sel.has(tileI(t)); t.classList.toggle('dk-on', on); t.setAttribute('aria-selected', String(on)); } drawBar(); };
  const range = (a, b) => { const out = []; for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(i); return out; };
  const cols = () => { const ts = tiles(); if (ts.length < 2) return 1; const y = ts[0].offsetTop; let n = 0; for (const t of ts) { if (t.offsetTop !== y) break; n++; } return Math.max(1, n); };
  const drag = { moved: false };
  grid.addEventListener('click', (e) => {
    const t = e.target.closest('.dk-tile');
    if (!t || drag.moved) return;
    const i = tileI(t);
    if (e.shiftKey) st.sel = new Set(range(st.anchor, i));
    else if (e.metaKey || e.ctrlKey) { if (st.sel.has(i) && st.sel.size > 1) st.sel.delete(i); else st.sel.add(i); st.anchor = i; }
    else { st.sel = new Set([i]); st.anchor = i; }
    focusTile(i); paint();
  });
  grid.addEventListener('dblclick', (e) => { const t = e.target.closest('.dk-tile'); if (t) { const i = tileI(t); sh.close(); goSlide(i); } });
  grid.addEventListener('keydown', (e) => {
    const t = e.target.closest && e.target.closest('.dk-tile');
    if (!t) return;
    const i = tileI(t), vis = tiles().map(tileI), at = vis.indexOf(i), mod = e.metaKey || e.ctrlKey;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols(), ArrowUp: -cols() }[e.key];
    if (step && e.altKey) { e.preventDefault(); const s = sel(); act.move(step > 0 ? Math.max(...s) + 1 + step : Math.min(...s) + step); return; }
    if (step || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const j = vis[e.key === 'Home' ? 0 : e.key === 'End' ? vis.length - 1 : Math.max(0, Math.min(vis.length - 1, at + step))];
      if (e.shiftKey) st.sel = new Set(range(st.anchor, j)); else if (!mod) { st.sel = new Set([j]); st.anchor = j; }
      focusTile(j); paint();
    } else if (e.key === ' ') { e.preventDefault(); if (st.sel.has(i) && st.sel.size > 1) st.sel.delete(i); else st.sel.add(i); st.anchor = i; paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); sh.close(); goSlide(i); }
    else if (mod && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); st.sel = new Set(range(0, deck().slides.length - 1)); paint(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); act.del(); }
    else if (mod && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); act.dup(); }
    else if (mod && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); act.copy(); }
    else if (mod && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); act.cut(); }
    else if (!mod && !e.altKey && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); act.hide(); }
    else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') { e.preventDefault(); menuAt(t); }
  });
  grid.addEventListener('contextmenu', (e) => { const t = e.target.closest('.dk-tile'); if (!t) return; e.preventDefault(); menuAt(t, e.clientX, e.clientY); });
  function menuAt(t, x, y) {
    const i = tileI(t);
    if (!st.sel.has(i)) { st.sel = new Set([i]); st.anchor = i; paint(); }
    S.select({ slides: sel() }); // the menu's items act on the sorter's selection
    const r = t.getBoundingClientRect();
    const info = { index: i, k: rows(deck()).findIndex((row) => row.index === i) };
    const items = S.menuItems('thumb', info).filter((it) => !it.sorter)
      .map((it) => (it.run ? { ...it, run: (cx) => { Promise.resolve(it.run(cx)).then(() => { if (sh.dialog.open) after(); }); } } : it));
    openContextMenu(items, x ?? r.left + 24, y ?? r.top + 28, { ctx: { ...S.context(), target: 'thumb', ...info }, back: t, keyboard: x === undefined, label: tx('Slide actions') });
  }
  sh.dialog.addEventListener('paste', (e) => {
    if (e.target.closest && e.target.closest('input,textarea,select')) return;
    const text = e.clipboardData && e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault(); act.paste(text);
  });
  // drag to reorder (mouse, pen or touch); the picked slides move together
  const marker = el('div', { class: 'dk-drop', 'aria-hidden': 'true' });
  grid.addEventListener('pointerdown', (e) => {
    const t = e.target.closest('.dk-tile');
    if (!t || e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey) return;
    const i = tileI(t), x0 = e.clientX, y0 = e.clientY;
    drag.moved = false;
    let to = -1;
    const move = (ev) => {
      if (!drag.moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
      if (!drag.moved) { drag.moved = true; if (!st.sel.has(i)) { st.sel = new Set([i]); st.anchor = i; paint(); } sh.dialog.classList.add('dk-dragging'); }
      ev.preventDefault();
      let best = null; // the gap nearest the pointer: before the tile under it, or after it past its middle
      for (const tl of tiles()) { const r = tl.getBoundingClientRect(); const dist = Math.hypot(ev.clientX - (r.left + r.width / 2), ev.clientY - (r.top + r.height / 2)); if (!best || dist < best.dist) best = { tl, r, dist }; }
      if (!best) return;
      const past = ev.clientX > best.r.left + best.r.width / 2;
      to = tileI(best.tl) + (past ? 1 : 0);
      const gr = grid.getBoundingClientRect();
      Object.assign(marker.style, { left: `${(past ? best.r.right + 4 : best.r.left - 6) - gr.left + grid.scrollLeft}px`, top: `${best.r.top - gr.top + grid.scrollTop}px`, height: `${best.r.height}px` });
      if (!marker.isConnected) grid.append(marker);
      if (ev.clientY < gr.top + 40) grid.scrollTop -= 12; else if (ev.clientY > gr.bottom - 40) grid.scrollTop += 12;
    };
    const up = () => {
      removeEventListener('pointermove', move, true); removeEventListener('pointerup', up, true); removeEventListener('pointercancel', up, true);
      marker.remove(); sh.dialog.classList.remove('dk-dragging');
      if (drag.moved && to >= 0) act.move(to);
      setTimeout(() => { drag.moved = false; }, 0);
    };
    addEventListener('pointermove', move, true); addEventListener('pointerup', up, true); addEventListener('pointercancel', up, true);
  });
  draw();
  setTimeout(() => { const t = grid.querySelector('.dk-tile[tabindex="0"]'); if (t) t.focus(); }, 0); // the sheet focuses its close button first
}

let styled = false;
function cssOnce() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  document.head.append(el('style', { id: 'dk-arrange-css' }, `
.dk-view{display:flex;flex-direction:column;gap:8px;min-width:260px;padding:4px 8px 8px}
.dk-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.dk-col{display:flex;flex-direction:column;gap:2px}
.dk-check-l{display:inline-flex;align-items:center;gap:8px;font-size:13px;min-height:32px;color:var(--text)}
.dk-check-l input{width:16px;height:16px;accent-color:var(--accent)}
@media (pointer:coarse){.dk-check-l{min-height:44px}}
.dk-many{margin:0 0 6px;font-weight:600}
.dk-ask{display:flex;flex-direction:column;gap:10px}
.dk-ask-l{display:flex;flex-direction:column;gap:6px;font-weight:600}
.dk-ask-in{font:inherit;font-weight:400;padding:8px 10px;border-radius:9px;border:.5px solid var(--hairline);background:var(--content2);color:var(--text);min-height:36px}
.dk-ask-sheet{width:min(420px,calc(100vw - 32px))}
.dk-body{display:flex;flex-direction:column;gap:8px}
.dk-h3{font-size:15px;margin:10px 0 2px;outline:none}
.dk-thumb{position:relative;width:160px;aspect-ratio:16/9;flex:none;border-radius:6px;overflow:hidden;background:var(--content2);box-shadow:0 0 0 .5px rgba(0,0,0,.18),0 1px 3px rgba(0,0,0,.12)}
.dk-thumb iframe{position:absolute;left:0;top:0;border:0;transform-origin:0 0;pointer-events:none}
.dk-thumb-none{background:repeating-linear-gradient(45deg,transparent 0 8px,rgba(127,127,127,.12) 8px 16px)}
.dk-versions,.dk-cmp{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.dk-ver{display:flex;align-items:center;gap:12px;padding:8px;border-radius:14px;border:.5px solid var(--hairline)}
.dk-ver.dk-cur{box-shadow:0 0 0 2px var(--accent)}
.dk-ver-t{flex:1;min-width:0;display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.dk-ver-name{flex-basis:100%;font-size:14px}
.dk-ver-a{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}
.dk-kind{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:rgba(127,127,127,.14)}
.dk-k-eden{background:color-mix(in srgb,var(--accent) 16%,transparent)}.dk-k-template{background:rgba(48,209,88,.18)}.dk-k-import{background:rgba(255,159,10,.2)}.dk-k-restore{background:rgba(142,78,198,.18)}
.dk-st-added{background:rgba(48,209,88,.2)}.dk-st-removed{background:rgba(255,69,58,.18)}.dk-st-changed{background:rgba(255,159,10,.2)}.dk-st-moved{background:color-mix(in srgb,var(--accent) 16%,transparent)}
.dk-when{color:var(--text2);font-size:12px}
.dk-badge{font-size:11px;font-weight:600;color:var(--accent)}.dk-pin{color:var(--text2)}
.dk-cmp-head{display:grid;grid-template-columns:160px 160px 1fr;gap:10px;font-size:12px;font-weight:600;color:var(--text2)}
.dk-cmp-row{display:grid;grid-template-columns:160px 160px 1fr;gap:10px;align-items:center}
.dk-cmp-t{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.dk-sorter{height:min(86dvh,800px)}
.dk-sorter-body{display:flex;flex-direction:column;gap:8px;height:100%;min-height:0}
.dk-sorter-top{display:flex;flex-wrap:wrap;align-items:center;gap:8px;justify-content:space-between}
.dk-count{color:var(--text2);font-size:12px}
.dk-grid{position:relative;flex:1;min-height:200px;overflow:auto;padding:4px;display:flex;flex-wrap:wrap;align-content:flex-start;gap:12px;outline:none}
.dk-sec{flex-basis:100%;display:flex;flex-direction:column;gap:8px}
.dk-sec-h{display:flex;align-items:center;gap:8px}
.dk-sec-t{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:4px 10px;border:0;border-radius:9px;background:rgba(127,127,127,.12);color:var(--text);font:inherit;font-weight:600;cursor:pointer}
.dk-sec-t:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.dk-sec-t[aria-expanded="false"] .dk-tw{transform:rotate(-90deg)}.dk-tw{display:inline-block;transition:transform .2s cubic-bezier(.32,.72,0,1)}
.dk-sec-g{display:flex;flex-wrap:wrap;gap:12px}
.dk-tile{position:relative;width:176px;display:flex;flex-direction:column;gap:4px;padding:6px;border-radius:12px;cursor:pointer;user-select:none;-webkit-user-select:none;touch-action:none;outline:none}
.dk-tile .dk-thumb{width:100%}
.dk-tile:hover{background:rgba(0,0,0,.04)}
.dk-tile.dk-on{background:color-mix(in srgb,var(--accent) 14%,transparent)}
.dk-tile.dk-on .dk-thumb{box-shadow:0 0 0 2.5px var(--accent)}
.dk-tile:focus-visible{outline:3px solid var(--accent);outline-offset:1px}
.dk-tile.dk-hid .dk-thumb{opacity:.4}
.dk-n{position:absolute;left:12px;top:12px;font:600 11px -apple-system,system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.55);border-radius:5px;padding:1px 6px}
.dk-hid-b{position:absolute;right:12px;top:12px;font:600 11px -apple-system,system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.65);border-radius:5px;padding:1px 6px}
.dk-tt{font-size:12px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dk-drop{position:absolute;width:3px;border-radius:2px;background:var(--accent);pointer-events:none}
.dk-dragging .dk-tile.dk-on{opacity:.55}
@media (max-width:640px){.dk-tile{width:calc(50% - 6px)}.dk-ver{flex-wrap:wrap}.dk-thumb{width:120px}.dk-cmp-head,.dk-cmp-row{grid-template-columns:1fr 1fr}.dk-cmp-t{grid-column:1/3}}
@media (prefers-reduced-motion:reduce){.dk-tw{transition:none}}`));
}
