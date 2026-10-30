// Free-form canvas, the page side (web only: deck.js builds this tray only when !IN_APP). The Insert tray adds text
// boxes, shapes, lines, icons and pictures on top of the selected slide; its style bar changes the selection. The
// slide frame (deck-freeform-draw.js freeEditor) moves, resizes, rotates, layers, copies and deletes elements and
// posts each change here as a message, checked below and saved like every edit: one undoable version each.

import { el, toast } from './util.js';
import { t as tx } from './i18n.js';
import { themeOf, normalizeFree, FREE_ICONS, FREE_COLORS } from './deck-model.js';
import { shapeText, setFree, addFree, styleFree, arrangeFree, removeFree, newFree, newFreeImage, ICON_PATHS, FREE_LABELS } from './deck-freeform-draw.js';

let ctx = null; // { currentDeck, cur, slideAt, storeImage, commit, keepFocus, frame, shrinkPicture }
const fs = { index: -1, ids: [], focus: false, clip: [], pic: null }; // the selection (kept across the redraw each edit causes)
const COLOR_NAME = { accent: 'Accent', accent2: 'Second accent', text: 'Text', muted: 'Muted', surface: 'Surface', bg: 'Background', none: 'None' };

const selected = (deck) => {
  const s = deck && deck.slides[fs.index];
  if (!s || fs.index !== ctx.slideAt()) return [];
  const pick = new Set(fs.ids);
  return (s.free || []).filter((e) => pick.has(e.id));
};
function save(next, { ids = fs.ids, focus = false, toastText = '' } = {}) {
  const deck = ctx.currentDeck();
  if (!next || next === deck) return;
  fs.ids = ids; fs.focus = focus;
  ctx.commit(next, { toastText });
}

/** The selected elements (the editor shell's selection follows them after each redraw). */
export const freeSelection = () => ({ index: fs.index, ids: [...fs.ids] });

// ── messages from the slide frame ──
addEventListener('message', (e) => {
  const f = ctx && ctx.frame();
  if (!f || e.source !== f.contentWindow) return;
  const m = e.data && typeof e.data === 'object' ? e.data : {};
  if (typeof m.type !== 'string' || !m.type.startsWith('deck-')) return;
  const deck = ctx.currentDeck();
  if (!deck) return;
  const idx = Number.isInteger(m.index) && m.index >= 0 && m.index < deck.slides.length ? m.index : -1;
  const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length <= 24).slice(0, 40) : []);
  switch (m.type) {
    case 'deck-ready':
      if (fs.ids.length && fs.index === ctx.slideAt()) {
        if (fs.focus) f.focus();
        f.contentWindow.postMessage({ type: 'deck-free-select', index: fs.index, ids: fs.ids, focus: fs.focus }, '*');
      }
      fs.focus = false;
      drawStyle();
      break;
    case 'deck-at':
      if (idx !== fs.index) { fs.index = idx; fs.ids = []; drawStyle(); }
      break;
    case 'deck-free-sel':
      fs.index = idx >= 0 ? idx : ctx.slideAt(); fs.ids = idx >= 0 ? ids(m.ids) : [];
      drawStyle();
      break;
    case 'deck-free': { // the slide's whole list after a move, resize, rotation, text edit, delete, duplicate or reorder
      if (idx < 0 || !Array.isArray(m.free) || m.free.length > 60) return;
      let size = 0;
      try { size = JSON.stringify(m.free).length; } catch { return; }
      if (size > 200_000) return;
      fs.index = idx;
      const next = setFree(deck, idx, m.free);
      const kept = new Set((next.slides[idx].free || []).map((x) => x.id));
      save(next, { ids: ids(m.sel).filter((id) => kept.has(id)), focus: m.focus === true });
      break;
    }
    case 'deck-free-copy':
      fs.clip = normalizeFree(Array.isArray(m.items) ? m.items.slice(0, 40) : []);
      break;
    case 'deck-free-paste': {
      if (idx < 0 || !fs.clip.length) return;
      const r = addFree(deck, idx, fs.clip, { offset: 20 });
      if (!r.ids.length) { toast(tx('This slide holds at most 40 elements')); return; }
      fs.index = idx;
      save(r.deck, { ids: r.ids, focus: true });
      break;
    }
    default: break;
  }
});

// a drag that leaves the slide frame ends when the button comes up over the page
addEventListener('pointerup', () => { const f = ctx && ctx.frame(); if (f && f.contentWindow) f.contentWindow.postMessage({ type: 'deck-free-up' }, '*'); }, true);

// ── the Insert tray ──
function svgIcon(d, vb = '0 0 24 24') {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', vb); s.setAttribute('aria-hidden', 'true'); s.setAttribute('width', '18'); s.setAttribute('height', '18');
  const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); p.setAttribute('fill', 'currentColor'); p.setAttribute('fill-rule', 'evenodd');
  s.append(p);
  return s;
}
const SHAPE_ICON = { rect: 'M3 6h18v12H3z', rounded: 'M7 6h10a4 4 0 014 4v4a4 4 0 01-4 4H7a4 4 0 01-4-4v-4a4 4 0 014-4z', ellipse: 'M12 6c5 0 9 2.7 9 6s-4 6-9 6-9-2.7-9-6 4-6 9-6z', arrow: 'M2 9h12V4l8 8-8 8v-5H2z', line: 'M3 11h18v2H3z', text: 'M5 4h14v3h-2V6h-4v12h2v2H9v-2h2V6H7v1H5z' };

/** Add a text box or shape to the selected slide (the toolbar's Text button calls this directly). */
export function insert(kind) {
  const deck = ctx.currentDeck(), i = ctx.slideAt();
  if (!deck || !deck.slides[i]) return;
  const e = newFree(kind, (deck.slides[i].free || []).length);
  if (!e) return;
  const r = addFree(deck, i, [e]);
  if (!r.ids.length) { toast(tx('This slide holds at most 40 elements')); return; }
  fs.index = i;
  save(r.deck, { ids: r.ids, focus: true, toastText: kind === 'text' ? tx('Text box added — double-click it, or press Enter, to type') : '' });
}
function insertPicture(id, alt, w, h) {
  const deck = ctx.currentDeck(), i = ctx.slideAt();
  if (!deck || !deck.slides[i]) return;
  const r = addFree(deck, i, [newFreeImage(id, alt, w, h, (deck.slides[i].free || []).length)]);
  if (!r.ids.length) { toast(tx('This slide holds at most 40 elements')); return; }
  fs.index = i; fs.pic = null;
  save(r.deck, { ids: r.ids, focus: true });
}

let root = null, styleRoot = null;
/** The free-form controls (deck.js, the web editor shell): part 'insert' (the toolbar's Text and Shape popovers: add
 *  boxes, shapes, icons, pictures), 'style' (the Format inspector for selected elements), or 'all' (both). */
export function freeformPanel(c, { part = 'all' } = {}) {
  ctx = c;
  addCss();
  if (part === 'style') {
    styleRoot = el('div', { class: 'deck-free' }, el('div', { class: 'deck-free-style', id: 'deckFreeStyle', role: 'group', 'aria-label': tx('Selected element') }));
    drawStyle(styleRoot.querySelector('#deckFreeStyle')); // not in the page yet: drawn into it directly
    return styleRoot;
  }
  const btn = (key, label, run, icon) => el('button', { type: 'button', class: 'cap deck-free-btn', 'data-key': `free:${key}`, onclick: () => { ctx.keepFocus(`free:${key}`); run(); } }, icon || null, tx(label));
  const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true, onchange: () => { const f = file.files[0]; file.value = ''; if (f) pickFile(f); } });
  const deck = ctx.currentDeck();
  const conv = ctx.cur();
  const known = conv && conv.deckImages ? Object.entries(conv.deckImages).filter(([, im]) => im && /^data:image\/(png|jpeg|gif|webp);base64,/.test(im.data || '')).slice(-12) : [];
  const altOf = (id) => { for (const s of (deck && deck.slides) || []) { if (s.image === id && s.alt) return s.alt; for (const f of s.free || []) if (f.image === id && f.alt) return f.alt; } return ''; };
  root = el('div', { class: 'deck-free' },
    el('p', '', tx('Adds to the selected slide. Drag to move, corner handles resize (Shift keeps the shape), the round handle rotates. Tab reaches each element; arrow keys move it.')),
    el('div', { class: 'deck-free-row', role: 'group', 'aria-label': tx('Insert') },
      btn('text', 'Text box', () => insert('text'), svgIcon(SHAPE_ICON.text)),
      ...['rect', 'rounded', 'ellipse', 'arrow', 'line'].map((k) => btn(k, k === 'rect' ? 'Rectangle' : k === 'rounded' ? 'Rounded' : FREE_LABELS[k], () => insert(k), svgIcon(SHAPE_ICON[k]))),
      btn('picture', 'Picture…', () => file.click())),
    el('div', { class: 'deck-free-row', role: 'group', 'aria-label': tx('Icons') },
      ...FREE_ICONS.map((k) => el('button', { type: 'button', class: 'cap deck-free-icon', 'data-key': `free:icon:${k}`, 'aria-label': tx(`${k[0].toUpperCase()}${k.slice(1)} icon`), title: tx(`${k[0].toUpperCase()}${k.slice(1)} icon`), onclick: () => { ctx.keepFocus(`free:icon:${k}`); insert(`icon:${k}`); } }, svgIcon(ICON_PATHS[k])))),
    known.length ? el('div', { class: 'deck-free-row', role: 'group', 'aria-label': tx('Pictures in this deck') }, el('h4', '', tx('Pictures in this deck')),
      ...known.map(([id, im]) => el('button', { type: 'button', class: 'deck-free-pic', 'data-key': `free:pic:${id}`, 'aria-label': `${tx('Add picture')}: ${altOf(id) || tx('no description yet')}`, onclick: () => { const alt = altOf(id); if (alt) insertPicture(id, alt, im.w, im.h); else { fs.pic = { id, data: im.data, w: im.w, h: im.h }; drawAlt(); } } }, el('img', { src: im.data, alt: '' })))) : null,
    el('div', { class: 'deck-free-alt', id: 'deckFreeAlt' }),
    part === 'insert' ? null : el('div', { class: 'deck-free-style', id: 'deckFreeStyle', role: 'group', 'aria-label': tx('Selected element') }),
    file);
  drawAlt();
  drawStyle();
  return root;
}

function pickFile(f) {
  if (!ctx.shrinkPicture) return;
  ctx.shrinkPicture(f).then((pic) => { fs.pic = { id: '', data: pic.data, w: pic.w, h: pic.h }; drawAlt(); }, () => toast(tx('That picture couldn’t be read')));
}
/** A picture needs a description before it goes on the slide (screen readers, PowerPoint's alt text). */
function drawAlt() {
  const box = root && root.querySelector('#deckFreeAlt');
  if (!box) return;
  if (!fs.pic) { box.replaceChildren(); return; }
  const alt = el('input', { type: 'text', maxlength: 300, required: true, 'data-key': 'free:alt', placeholder: tx('What does the picture show?'), 'aria-label': tx('Alt text: what the picture shows, for people who can’t see it') });
  box.replaceChildren(el('form', { class: 'deck-alt', onsubmit: (e) => {
    e.preventDefault();
    if (!alt.value.trim()) { alt.focus(); return; }
    const p = fs.pic, c = ctx.cur();
    if (!p || !c) return;
    let id = p.id;
    if (!id) { id = `i${Date.now().toString(36)}`; ctx.storeImage(c, id, p.data, p.w, p.h); }
    insertPicture(id, alt.value, p.w, p.h);
  } }, el('img', { src: pSrc(), alt: '', class: 'deck-free-preview' }), el('label', '', tx('Describe the picture'), alt), el('button', { type: 'submit', class: 'cap primary' }, tx('Add picture')), el('button', { type: 'button', class: 'cap', onclick: () => { fs.pic = null; drawAlt(); } }, tx('Cancel'))));
  alt.focus();
}
const pSrc = () => (fs.pic && /^data:image\/(png|jpeg|gif|webp);base64,/.test(fs.pic.data) ? fs.pic.data : '');

/** The style bar for the selection: fill, line, text, opacity, order. */
function drawStyle(into = null) {
  const box = into || [styleRoot, root].map((r) => (r && r.isConnected ? r.querySelector('#deckFreeStyle') : null)).find(Boolean) || null;
  if (!box || !ctx) return;
  const deck = ctx.currentDeck();
  const sel = selected(deck);
  if (!sel.length) { box.replaceChildren(el('p', '', tx('Select an element on the slide to style it.'))); return; }
  const t = themeOf(deck);
  const i = fs.index, ids = sel.map((e) => e.id);
  const apply = (key, patch) => { ctx.keepFocus(`free:${key}`); save(styleFree(ctx.currentDeck(), i, ids, patch)); };
  const types = new Set(sel.map((e) => e.type));
  const one = sel.length === 1 ? sel[0] : null;
  const swatches = (label, prop, list) => el('div', { class: 'deck-free-sw', role: 'group', 'aria-label': tx(label) }, el('span', { class: 'deck-free-l' }, tx(label)),
    ...list.map((c) => el('button', { type: 'button', class: 'deck-free-swatch', 'data-key': `free:${prop}:${c}`, 'aria-label': `${tx(label)}: ${tx(COLOR_NAME[c])}`, title: tx(COLOR_NAME[c]), 'aria-pressed': String(sel.every((e) => e[prop] === c)), style: { background: c === 'none' ? 'transparent' : t.colors[c] }, onclick: () => apply(`${prop}:${c}`, { [prop]: c }) }, c === 'none' ? '⌀' : '')));
  const name = one ? (one.type === 'shape' ? FREE_LABELS[one.shape] : FREE_LABELS[one.type]) : `${sel.length} ${tx('elements')}`;
  const parts = [el('h4', '', `${tx('Selected')}: ${tx(name)}`)];
  if (types.has('shape') || types.has('icon') || types.has('text')) parts.push(swatches(types.size === 1 && types.has('text') ? 'Background' : 'Fill', 'fill', types.has('icon') && !types.has('shape') && !types.has('text') ? FREE_COLORS.filter((c) => c !== 'none') : FREE_COLORS));
  if (types.has('shape') || types.has('line')) parts.push(swatches('Line', 'stroke', types.has('line') && !types.has('shape') ? FREE_COLORS.filter((c) => c !== 'none') : FREE_COLORS));
  const texty = sel.filter((e) => e.type === 'text' || e.type === 'shape'); // a shape holds text too
  const look = (e) => (e.type === 'shape' ? shapeText(e) : e);
  if (texty.length) {
    if (types.has('shape')) parts.push(el('p', '', tx('Double-click a shape, or press Enter on it, to type in it.')));
    parts.push(swatches('Text color', 'color', FREE_COLORS.filter((c) => c !== 'none')));
    const size = one && texty.includes(one) ? look(one).size : 0;
    const sizes = [14, 18, 24, 32, 40, 48, 64, 80, 96, 120];
    parts.push(el('label', { class: 'deck-free-l' }, tx('Size'), el('select', { class: 'deck-theme', 'data-key': 'free:size', onchange: (e) => apply('size', { size: Number(e.target.value) }) },
      ...(size && !sizes.includes(size) ? [size, ...sizes].sort((a, b) => a - b) : sizes).map((v) => el('option', { value: v, selected: v === size ? true : null }, String(v))), size ? null : el('option', { value: '', selected: true, disabled: true }, '—'))));
    const bold = texty.every((e) => e.bold);
    parts.push(el('button', { type: 'button', class: 'cap', 'data-key': 'free:bold', 'aria-pressed': String(bold), onclick: () => apply('bold', { bold: !bold }) }, el('b', '', 'B'), el('span', 'sr-only', tx('Bold'))));
    for (const a of ['left', 'center', 'right']) parts.push(el('button', { type: 'button', class: 'cap', 'data-key': `free:align:${a}`, 'aria-pressed': String(texty.every((e) => look(e).align === a)), onclick: () => apply(`align:${a}`, { align: a }) }, tx(a === 'left' ? 'Left' : a === 'center' ? 'Center' : 'Right')));
    const shapes = texty.filter((e) => e.type === 'shape');
    if (shapes.length) {
      for (const v of ['top', 'middle', 'bottom']) parts.push(el('button', { type: 'button', class: 'cap', 'data-key': `free:valign:${v}`, 'aria-pressed': String(shapes.every((e) => look(e).valign === v)), onclick: () => apply(`valign:${v}`, { valign: v }) }, tx(v === 'top' ? 'Top' : v === 'middle' ? 'Middle' : 'Bottom')));
      const pad = shapes.length === 1 ? look(shapes[0]).pad : -1;
      parts.push(el('label', { class: 'deck-free-l' }, tx('Padding'), el('select', { class: 'deck-theme', 'data-key': 'free:pad', onchange: (e) => apply('pad', { pad: Number(e.target.value) }) },
        ...[0, 8, 12, 24, 40].map((v) => el('option', { value: v, selected: v === pad ? true : null }, String(v))), [0, 8, 12, 24, 40].includes(pad) ? null : el('option', { value: '', selected: true, disabled: true }, pad >= 0 ? String(pad) : '—'))));
      const over = shapes.every((e) => e.fit === 'overflow');
      parts.push(el('button', { type: 'button', class: 'cap', 'data-key': 'free:fit', 'aria-pressed': String(!over), title: tx('Shrink the text to fit the shape, or let it run over'), onclick: () => apply('fit', { fit: over ? 'shrink' : 'overflow' }) }, tx('Shrink to fit')));
    }
  }
  if (types.has('line')) { const arrow = sel.filter((e) => e.type === 'line').every((e) => e.arrow); parts.push(el('button', { type: 'button', class: 'cap', 'data-key': 'free:arrow', 'aria-pressed': String(arrow), onclick: () => apply('arrow', { arrow: !arrow }) }, tx('Arrowhead'))); }
  const op = one ? one.opacity ?? 1 : 0;
  parts.push(el('label', { class: 'deck-free-l' }, tx('Opacity'), el('select', { class: 'deck-theme', 'data-key': 'free:opacity', onchange: (e) => apply('opacity', { opacity: Number(e.target.value) }) },
    ...[1, 0.75, 0.5, 0.25].map((v) => el('option', { value: v, selected: v === op ? true : null }, `${Math.round(v * 100)}%`)), [1, 0.75, 0.5, 0.25].includes(op) ? null : el('option', { value: '', selected: true, disabled: true }, op ? `${Math.round(op * 100)}%` : '—'))));
  const order = (key, label, how) => el('button', { type: 'button', class: 'cap', 'data-key': `free:${key}`, onclick: () => { ctx.keepFocus(`free:${key}`); save(arrangeFree(ctx.currentDeck(), i, ids, how)); } }, tx(label));
  parts.push(el('span', { class: 'deck-free-l' }, tx('Order')), order('forward', 'Bring forward', 'forward'), order('back', 'Send back', 'back'), order('front', 'To front', 'front'), order('bottom', 'To back', 'bottom'));
  parts.push(el('button', { type: 'button', class: 'cap', 'data-key': 'free:dup', onclick: () => { const d = ctx.currentDeck(); const r = addFree(d, i, sel, { offset: 20 }); if (r.ids.length) { ctx.keepFocus('free:dup'); save(r.deck, { ids: r.ids }); } } }, tx('Duplicate')),
    el('button', { type: 'button', class: 'cap', 'data-key': 'free:delete', onclick: () => { ctx.keepFocus('free:delete'); save(removeFree(ctx.currentDeck(), i, ids), { ids: [], toastText: tx(sel.length > 1 ? 'Elements deleted' : 'Element deleted') }); } }, tx('Delete')));
  box.replaceChildren(...parts);
}

let cssDone = false;
function addCss() {
  if (cssDone || typeof document === 'undefined') return;
  cssDone = true;
  document.head.append(el('style', { id: 'deck-free-css' }, `
.deck-free{display:flex;flex-direction:column;gap:6px;width:100%}
.deck-free-row,.deck-free-style,.deck-free-sw{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.deck-free-row h4{flex-basis:100%}
.deck-free-btn{display:inline-flex;align-items:center;gap:6px}
.deck-free-icon{width:40px;justify-content:center;display:inline-flex;align-items:center;color:var(--accent)}
.deck-free-pic{width:64px;height:40px;padding:0;border:1px solid var(--hairline);border-radius:8px;overflow:hidden;background:var(--content);cursor:pointer}
.deck-free-pic img{width:100%;height:100%;object-fit:cover;display:block}
.deck-free-preview{width:64px;height:40px;object-fit:cover;border-radius:6px}
.deck-free-style{padding-top:6px;border-top:1px solid var(--hairline)}
.deck-free-style h4{flex-basis:100%}
.deck-free-l{font-size:12px;color:var(--text2);display:inline-flex;align-items:center;gap:6px}
.deck-free-swatch{width:28px;height:28px;min-height:28px!important;padding:0;border-radius:50%;border:1px solid var(--hairline);cursor:pointer;color:var(--text2);font-size:14px;line-height:1}
.deck-free-swatch[aria-pressed="true"]{outline:2px solid var(--accent);outline-offset:2px}
.deck-free [aria-pressed="true"].cap{border-color:var(--accent)}
`));
}
