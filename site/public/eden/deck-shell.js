// Eden Slides editor shell (web only, 2026-10-24): a Keynote-style layout around the slide frame. A slim toolbar of
// labelled icon buttons on top, the navigator and canvas in the middle (drawn inside the frame: deck-render.js +
// deck-shell-frame.js), and an Inspector on the right whose Format / Animate / Document tabs follow the selection.
// Feature modules plug in through the registries below; the contract is research_notes/slides-redesign/inspector-api.md
// (SHELL_VERSION). deck.js builds the shell only when !IN_APP; the iPhone app keeps its own bar.

import { el, svgEl, toast } from './util.js';
import { t as tx } from './i18n.js';

export const SHELL_VERSION = '1.1';

// ── registries ──────────────────────────────────────────────────────────────────────────────────────────────────

const reg = { tabs: [], sections: [], tools: [], menus: [], shortcuts: [] };
const byOrder = (a, b) => (a.order ?? 100) - (b.order ?? 100);
const add = (list, item) => {
  const old = list.findIndex((x) => x.id === item.id);
  if (old >= 0) list.splice(old, 1, item); else list.push(item); // registering the same id again replaces it (hot reloads, redraws)
  list.sort(byOrder);
  requestRefresh();
  return () => { const i = list.indexOf(item); if (i >= 0) { list.splice(i, 1); requestRefresh(); } };
};

/** An Inspector tab (Format, Animate and Document are built in; Comments is registered by deck.js). */
export function registerInspectorTab({ id, title, icon = 'doc', order = 100, when }) {
  return add(reg.tabs, { id, title, icon, order, when });
}
/** A section of an Inspector tab. `when(selection, ctx)` decides whether it shows; `render(ctx)` returns a Node. */
export function registerInspector({ id, tab = 'format', title = '', icon = '', order = 100, when, render, collapsible = true }) {
  if (typeof render !== 'function') throw new Error(`registerInspector ${id}: render(ctx) is required`);
  return add(reg.sections, { id, tab, title, icon, order, when, render, collapsible });
}
/** A toolbar button. `run(ctx, button)` for an action, `popover(ctx, close)` to open an anchored popover, or
 *  `menu(ctx)` for a menu of items. Groups, left to right: view, slide, insert, collab, inspector. */
export function registerTool({ id, label, icon, group = 'insert', order = 100, shortcut = '', title = '', when, run, popover, menu, pressed, primary = false, domId = '' }) {
  return add(reg.tools, { id, label, icon, group, order, shortcut, title, when, run, popover, menu, pressed, primary, domId });
}
/** Items for a right-click menu. target: 'slide' | 'text' | 'element' | 'thumb', or a toolbar menu: 'file' (File),
 *  'play' (Play), 'view' (View), 'share' (the Collaborate popover's extra rows). */
export const MENU_TARGETS = ['slide', 'text', 'element', 'thumb', 'file', 'play', 'view', 'share'];
export function registerContextMenu({ id, target, order = 100, items }) {
  if (!MENU_TARGETS.includes(target)) throw new Error(`registerContextMenu ${id}: bad target ${target}`);
  return add(reg.menus, { id, target, order, items });
}
/** A keyboard shortcut. keys: 'Mod+Shift+N' (Mod is ⌘ on a Mac, Ctrl elsewhere; then Alt, Shift, and a key). */
export function registerShortcut({ id, keys, label = '', run, when, order = 100 }) {
  const combo = normCombo(keys);
  return add(reg.shortcuts, { id, keys: combo, label, run, when, order });
}
export const registry = reg; // read-only view for tests and the contract checker

// ── selection ───────────────────────────────────────────────────────────────────────────────────────────────────

/** What is selected. kind: 'slide' (nothing on it), 'text' (a title, bullet or the notes), 'element' (free-form
 *  boxes, shapes, pictures). slides: the navigator's multi-selection (always includes `slide`). */
const sel = { slide: 0, slides: [0], kind: 'slide', textPath: null, editing: false, elementIds: [], at: 0 };
const selFns = new Set();
export const selection = () => ({ ...sel, slides: [...sel.slides], elementIds: [...sel.elementIds] });
export function onSelection(fn) { selFns.add(fn); return () => selFns.delete(fn); }
/** Change the selection (features: a multi-select in the sorter, a picked element). Unknown keys are ignored. */
export function select(patch = {}) {
  const before = JSON.stringify(sel);
  if (Number.isInteger(patch.slide) && patch.slide >= 0 && patch.slide !== sel.slide) { sel.slide = patch.slide; if (!patch.slides) sel.slides = [patch.slide]; if (!('textPath' in patch)) sel.textPath = null; if (!patch.elementIds) sel.elementIds = []; }
  if (Array.isArray(patch.slides)) { const s = [...new Set(patch.slides.filter((x) => Number.isInteger(x) && x >= 0))].slice(0, 500); sel.slides = s.includes(sel.slide) ? s : [sel.slide, ...s]; }
  if ('textPath' in patch) { sel.textPath = typeof patch.textPath === 'string' ? patch.textPath : null; sel.editing = !!patch.editing; }
  if (Array.isArray(patch.elementIds)) sel.elementIds = patch.elementIds.filter((x) => typeof x === 'string').slice(0, 40);
  if (Number.isInteger(patch.at)) sel.at = patch.at;
  sel.kind = sel.elementIds.length ? 'element' : sel.textPath ? 'text' : 'slide';
  if (JSON.stringify(sel) === before) return;
  for (const fn of selFns) { try { fn(selection()); } catch (e) { console.error(e); } }
  refreshInspector();
}

// ── keyboard ────────────────────────────────────────────────────────────────────────────────────────────────────

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
function normCombo(keys) {
  const parts = String(keys || '').split('+').map((s) => s.trim()).filter(Boolean);
  const key = parts.pop() || '';
  const has = (m) => parts.some((p) => p.toLowerCase() === m);
  return `${has('mod') || has('cmd') || has('ctrl') ? 'Mod+' : ''}${has('alt') || has('option') ? 'Alt+' : ''}${has('shift') ? 'Shift+' : ''}${key.length === 1 ? key.toUpperCase() : key}`;
}
export function comboOf(e) {
  const k = e.key && e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return `${e.metaKey || e.ctrlKey ? 'Mod+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.code && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : e.code && /^Digit\d$/.test(e.code) ? e.code.slice(5) : k}`;
}
const GLYPH = { Mod: IS_MAC ? '⌘' : 'Ctrl+', Alt: IS_MAC ? '⌥' : 'Alt+', Shift: IS_MAC ? '⇧' : 'Shift+', Backspace: '⌫', Delete: '⌦', Enter: '↩', Escape: 'esc', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
/** 'Mod+Alt+P' → '⌥⌘P' on a Mac (Apple's order: ⌃⌥⇧⌘), 'Ctrl+Alt+P' elsewhere. */
export function formatKeys(keys) {
  if (!keys) return '';
  const c = normCombo(keys).split('+');
  const key = c.pop();
  const mods = IS_MAC ? ['Alt', 'Shift', 'Mod'].filter((m) => c.includes(m)) : ['Mod', 'Alt', 'Shift'].filter((m) => c.includes(m));
  return mods.map((m) => GLYPH[m]).join('') + (GLYPH[key] || key);
}
function runShortcut(combo, e) {
  const s = reg.shortcuts.find((x) => x.keys === combo && (!x.when || x.when(selection(), ctxNow())));
  if (!s) return false;
  if (e) { e.preventDefault(); e.stopPropagation(); }
  s.run(ctxNow(), e);
  return true;
}
const altGr = (e) => !IS_MAC && e.ctrlKey && e.altKey && !!(e.getModifierState && e.getModifierState('AltGraph')); // Polish ń, German € …: typed, never a shortcut
const typingIn = (n) => n && (n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName));
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if (!shell.root || !shell.root.isConnected || e.defaultPrevented) return;
    const combo = comboOf(e);
    if (typingIn(e.target) && (!combo.startsWith('Mod+') || altGr(e))) return; // letters typed in a field stay text
    if (!combo.includes('+') && !shell.root.contains(e.target)) return; // a bare key only inside the editor
    runShortcut(combo, e);
  });
}
/** The frame's half: the shortcuts it should hand to the page (sent on each deck-ready). */
export const frameKeys = () => reg.shortcuts.map((s) => s.keys).filter((k) => k.startsWith('Mod+') || k.startsWith('Alt+'));

// ── icons: drawn for Eden in the SF Symbols manner (24px grid, 1.6 stroke, round joins); no Apple artwork ──────────

const P = {
  'add-slide': 'M4 6.5A1.5 1.5 0 015.5 5h13A1.5 1.5 0 0120 6.5v8a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 14.5zM12 8v5M9.5 10.5h5M8 19h8',
  play: 'M8 5.5v13l10.5-6.5z',
  table: 'M4 6.5A1.5 1.5 0 015.5 5h13A1.5 1.5 0 0120 6.5v11a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 17.5zM4 10h16M4 14.5h16M10 10v9',
  chart: 'M5 19V12M10 19V7M15 19v-5M20 19V4M3.5 19.5h17',
  text: 'M5 7V5h14v2M12 5v14M9 19h6',
  shape: 'M4 4h9v9H4zM15.5 20a4.5 4.5 0 100-9 4.5 4.5 0 000 9z',
  media: 'M4 6.5A1.5 1.5 0 015.5 5h13A1.5 1.5 0 0120 6.5v11a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 17.5zM4.5 16l4.5-4.5 3.5 3.5 2.5-2.5 4.5 4.5M15.5 9.5a1 1 0 100-.01',
  comment: 'M5 5.5h14a1.5 1.5 0 011.5 1.5v8a1.5 1.5 0 01-1.5 1.5h-7l-4.5 3.5v-3.5H5A1.5 1.5 0 013.5 15V7A1.5 1.5 0 015 5.5z',
  collaborate: 'M9 11a3 3 0 100-6 3 3 0 000 6zM3.5 19c.5-3 2.7-5 5.5-5s5 2 5.5 5M16 11a2.5 2.5 0 100-5M17 14c2 .4 3.3 2.2 3.6 4.5',
  share: 'M12 4v11M8 7.5L12 4l4 3.5M7 11H6a1.5 1.5 0 00-1.5 1.5v6A1.5 1.5 0 006 20h12a1.5 1.5 0 001.5-1.5v-6A1.5 1.5 0 0018 11h-1',
  format: 'M14.5 4.5l5 5-8.5 8.5-5 1 1-5zM12.5 6.5l5 5',
  animate: 'M12 3.5l8.5 8.5-8.5 8.5L3.5 12zM12 8l4 4-4 4',
  document: 'M7 3.5h7l4.5 4.5v11A1.5 1.5 0 0117 20.5H7A1.5 1.5 0 015.5 19V5A1.5 1.5 0 017 3.5zM14 3.5V8h4.5M8.5 12.5h7M8.5 16h7',
  sidebar: 'M4 6.5A1.5 1.5 0 015.5 5h13A1.5 1.5 0 0120 6.5v11a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 17.5zM9.5 5v14M6 8.5h1.5M6 11h1.5',
  grid: 'M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z',
  list: 'M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01',
  chevron: 'M7 10l5 5 5-5',
  'chevron-r': 'M10 7l5 5-5 5',
  close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  more: 'M4.6 12a1.4 1.4 0 102.8 0 1.4 1.4 0 10-2.8 0zM10.6 12a1.4 1.4 0 102.8 0 1.4 1.4 0 10-2.8 0zM16.6 12a1.4 1.4 0 102.8 0 1.4 1.4 0 10-2.8 0z',
  trash: 'M5 7h14M10 4h4M7 7l.8 12a1.5 1.5 0 001.5 1.4h5.4a1.5 1.5 0 001.5-1.4L17 7M10 11v6M14 11v6',
  duplicate: 'M8 8V5.5A1.5 1.5 0 019.5 4h9A1.5 1.5 0 0120 5.5v9a1.5 1.5 0 01-1.5 1.5H16M4 9.5A1.5 1.5 0 015.5 8h9A1.5 1.5 0 0116 9.5v9a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 014 18.5z',
  up: 'M12 19V5M6.5 10.5L12 5l5.5 5.5',
  down: 'M12 5v14M6.5 13.5L12 19l5.5-5.5',
  wand: 'M4 20L15 9M13 7l4 4M17 3v3M15.5 4.5h3M20 8v2M19 9h2M9 3.5v2M8 4.5h2',
  globe: 'M12 20.5a8.5 8.5 0 100-17 8.5 8.5 0 000 17zM3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5z',
  resize: 'M4 9V5.5A1.5 1.5 0 015.5 4H9M15 4h3.5A1.5 1.5 0 0120 5.5V9M20 15v3.5a1.5 1.5 0 01-1.5 1.5H15M9 20H5.5A1.5 1.5 0 014 18.5V15',
  download: 'M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14',
  templates: 'M7 4.5h12A1.5 1.5 0 0120.5 6v8M4.5 8h12A1.5 1.5 0 0118 9.5v8a1.5 1.5 0 01-1.5 1.5h-12A1.5 1.5 0 013 17.5v-8A1.5 1.5 0 014.5 8z',
  record: 'M12 20a8 8 0 100-16 8 8 0 000 16zM12 15a3 3 0 100-6 3 3 0 000 6z',
  presenter: 'M3.5 5.5h17v10h-17zM8 19.5h8M12 15.5v4M6.5 9h5M6.5 12h3',
  search: 'M10.5 17a6.5 6.5 0 100-13 6.5 6.5 0 000 13zM15.5 15.5L20 20',
  zoom: 'M10.5 17a6.5 6.5 0 100-13 6.5 6.5 0 000 13zM15.5 15.5L20 20M10.5 8v5M8 10.5h5',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  sparkles: 'M10 3.5l1.6 4.4L16 9.5l-4.4 1.6L10 15.5l-1.6-4.4L4 9.5l4.4-1.6zM17.5 14l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z',
  info: 'M12 20.5a8.5 8.5 0 100-17 8.5 8.5 0 000 17zM12 11v5.5M12 7.5h.01',
  photo: 'M4 6.5A1.5 1.5 0 015.5 5h13A1.5 1.5 0 0120 6.5v11a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 17.5zM4.5 16l4.5-4.5 3.5 3.5 2.5-2.5 4.5 4.5M15.5 9.5a1 1 0 100-.01',
  video: 'M3.5 7.5A1.5 1.5 0 015 6h9a1.5 1.5 0 011.5 1.5v9A1.5 1.5 0 0114 18H5a1.5 1.5 0 01-1.5-1.5zM15.5 10.5l5-3v9l-5-3',
  audio: 'M9 18V6l10-2v12M9 18a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zM19 16a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z',
  folder: 'M3.5 7A1.5 1.5 0 015 5.5h4l2 2h8A1.5 1.5 0 0120.5 9v8.5A1.5 1.5 0 0119 19H5a1.5 1.5 0 01-1.5-1.5z',
  import: 'M12 15V4M7.5 8.5L12 4l4.5 4.5M5 19.5h14',
  chat: 'M12 4c4.7 0 8.5 3.1 8.5 7s-3.8 7-8.5 7c-1 0-2-.1-2.9-.4L5 19.5l1.2-3.4C4.5 14.8 3.5 13 3.5 11c0-3.9 3.8-7 8.5-7z',
  layout: 'M4.5 5h15v14h-15zM4.5 10h15M10.5 10v9',
  theme: 'M12 3.5a8.5 8.5 0 100 17c1 0 1.5-.7 1.5-1.4 0-.9-.6-1.2-.6-2 0-.8.6-1.4 1.5-1.4h1.8a4.3 4.3 0 004.3-4.3c0-4.3-3.8-7.9-8.5-7.9zM7.5 11.5h.01M10 7.5h.01M14.5 7.5h.01',
  notes: 'M5 4.5h14v15H5zM8 8.5h8M8 12h8M8 15.5h5',
  undo: 'M9 14L4.5 9.5 9 5M5 9.5h9a5 5 0 010 10h-2',
  redo: 'M15 14l4.5-4.5L15 5M19 9.5h-9a5 5 0 000 10h2',
  bold: 'M7 5h6a3.5 3.5 0 010 7H7zM7 12h7a3.5 3.5 0 010 7H7z',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
};
const FILLED = new Set(['play', 'more']);
/** An inline SVG icon (aria-hidden). Unknown names draw a dot, never break. */
export function icon(name, size = 18) {
  if (name === 'eden') { // Eden's own mark (the logo's two shapes), in the text colour
    const m = svgEl('svg', { class: 'dsh-ic dsh-ic-eden', viewBox: '30 70 436 444', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' });
    for (const pts of ['211,93 314,90 444,236 343,353 249,352 333,251', '252,235 160,346 282,491 186,494 52,350 151,234']) m.append(svgEl('polygon', { points: pts, fill: 'currentColor', stroke: 'currentColor', 'stroke-width': '18', 'stroke-linejoin': 'round' }));
    return m;
  }
  const s = svgEl('svg', { class: `dsh-ic dsh-ic-${name}`, viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' });
  s.append(svgEl('path', { d: P[name] || 'M12 12h.01', fill: FILLED.has(name) ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  return s;
}
export const ICON_NAMES = [...Object.keys(P), 'eden'];

// ── the component kit ───────────────────────────────────────────────────────────────────────────────────────────

const tip = (label, shortcut) => (shortcut ? `${label} (${formatKeys(shortcut)})` : label);
/** A labelled button. key: data-key, kept focused across the redraw an edit causes (ctx.keepFocus). */
export function button({ label, icon: ic, onClick, primary = false, quiet = false, shortcut = '', title = '', key = '', pressed, disabled = false, small = false } = {}) {
  return el('button', { type: 'button', class: `dsh-btn${primary ? ' primary' : ''}${quiet ? ' quiet' : ''}${small ? ' small' : ''}`, 'data-key': key || null, title: title || (shortcut ? tip(label, shortcut) : null), 'aria-pressed': pressed === undefined ? null : String(!!pressed), 'aria-keyshortcuts': shortcut ? ariaKeys(shortcut) : null, disabled: disabled || null, onclick: (e) => { if (key && shell.keepFocus) shell.keepFocus(key); if (onClick) onClick(e); } },
    ic ? icon(ic, 16) : null, label ? el('span', '', label) : null);
}
/** An icon-only button: its label is its accessible name and its tooltip (with the shortcut). */
export function iconButton({ icon: ic, label, onClick, shortcut = '', key = '', pressed, disabled = false } = {}) {
  return el('button', { type: 'button', class: 'dsh-iconbtn', 'aria-label': label, title: tip(label, shortcut), 'data-key': key || null, 'aria-pressed': pressed === undefined ? null : String(!!pressed), 'aria-keyshortcuts': shortcut ? ariaKeys(shortcut) : null, disabled: disabled || null, onclick: (e) => { if (key && shell.keepFocus) shell.keepFocus(key); if (onClick) onClick(e); } }, icon(ic, 18));
}
const ariaKeys = (k) => normCombo(k).replace('Mod', IS_MAC ? 'Meta' : 'Control');
/** A segmented control (radio group, ← → move). options: [{ value, label, icon }] */
export function segmented({ label, options, value, onChange, key = '', iconsOnly = false }) {
  const g = el('div', { class: 'dsh-seg', role: 'radiogroup', 'aria-label': label });
  const pick = (v, focus) => {
    g.querySelectorAll('[role="radio"]').forEach((b) => { const on = b.dataset.value === String(v); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; if (on && focus) b.focus(); });
  };
  for (const o of options) {
    g.append(el('button', { type: 'button', role: 'radio', 'data-value': String(o.value), 'data-key': key ? `${key}:${o.value}` : null, 'aria-checked': String(o.value === value), tabindex: o.value === value ? '0' : '-1', title: o.title || (iconsOnly ? o.label : null), 'aria-label': iconsOnly ? o.label : null, onclick: () => { if (key && shell.keepFocus) shell.keepFocus(`${key}:${o.value}`); pick(o.value); if (onChange) onChange(o.value); } },
      o.icon ? icon(o.icon, 16) : null, iconsOnly ? null : el('span', '', o.label)));
  }
  if (!options.some((o) => o.value === value) && g.firstChild) g.firstChild.tabIndex = 0;
  g.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const all = [...g.querySelectorAll('[role="radio"]')];
    const i = all.indexOf(document.activeElement);
    const n = all[(i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length];
    if (n) { e.preventDefault(); n.click(); n.focus(); }
  });
  return g;
}
/** An Inspector section: a 13px semibold title with a disclosure chevron (Keynote's), then its controls. */
export function section({ title, id = '', collapsible = true, open = true, children = [] }) {
  const body = el('div', { class: 'dsh-sec-body', id: id ? `dsh-sec-${id}` : null }, ...children);
  if (!title) return el('section', { class: 'dsh-sec' }, body);
  const key = `sec:${id || title}`;
  const isOpen = shell.collapsed.has(key) ? false : open;
  body.hidden = !isOpen;
  const head = collapsible
    ? el('button', { type: 'button', class: 'dsh-sec-head', 'aria-expanded': String(isOpen), 'aria-controls': body.id || null, onclick: () => { const o = head.getAttribute('aria-expanded') !== 'true'; head.setAttribute('aria-expanded', String(o)); body.hidden = !o; if (o) shell.collapsed.delete(key); else shell.collapsed.add(key); } }, el('span', '', title), icon('chevron', 14))
    : el('h3', { class: 'dsh-sec-head static' }, title);
  return el('section', { class: 'dsh-sec', 'aria-label': title }, head, body);
}
/** A row: label left, control right (Keynote's inspector rows). */
export const row = (label, ...controls) => el('div', { class: 'dsh-row' }, el('span', { class: 'dsh-row-l' }, label), el('div', { class: 'dsh-row-c' }, ...controls));
/** A list row: icon, label, detail, an accessory (a chevron, a check). */
export function listRow({ label, detail = '', icon: ic, onClick, selected = false, accessory = onClick ? 'chevron-r' : '', key = '' }) {
  const kids = [ic ? icon(ic, 18) : null, el('span', { class: 'dsh-lr-t' }, el('span', '', label), detail ? el('small', '', detail) : null), accessory ? icon(accessory, 14) : null];
  return onClick
    ? el('button', { type: 'button', class: `dsh-lr${selected ? ' on' : ''}`, 'data-key': key || null, 'aria-current': selected ? 'true' : null, onclick: (e) => { if (key && shell.keepFocus) shell.keepFocus(key); onClick(e); } }, ...kids)
    : el('div', { class: 'dsh-lr' }, ...kids);
}
/** A number with − and + (Keynote's stepper). */
export function stepper({ label, value = 0, min = -Infinity, max = Infinity, step = 1, unit = '', onChange, key = '' }) {
  const clamp = (v) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  const input = el('input', { type: 'number', class: 'dsh-num', value: String(value), min: Number.isFinite(min) ? min : null, max: Number.isFinite(max) ? max : null, step, 'aria-label': label, 'data-key': key || null, onchange: () => set(Number(input.value)) });
  const set = (v) => { if (!Number.isFinite(v)) return; const c = clamp(v); input.value = String(c); if (onChange) onChange(c); };
  return el('div', { class: 'dsh-stepper' }, input, unit ? el('span', { class: 'dsh-unit', 'aria-hidden': 'true' }, unit) : null,
    el('button', { type: 'button', class: 'dsh-step', 'aria-label': `${tx('Decrease')} ${label}`, onclick: () => set(Number(input.value) - step) }, icon('minus', 12)),
    el('button', { type: 'button', class: 'dsh-step', 'aria-label': `${tx('Increase')} ${label}`, onclick: () => set(Number(input.value) + step) }, icon('plus', 12)));
}
/** A slider with its value shown. onChange fires when the thumb is let go (one version, not one per pixel). */
export function slider({ label, value = 0, min = 0, max = 100, step = 1, format = (v) => String(v), onInput, onChange, key = '' }) {
  const out = el('output', { class: 'dsh-slider-v' }, format(value));
  const input = el('input', { type: 'range', class: 'dsh-slider', min, max, step, value: String(value), 'aria-label': label, 'aria-valuetext': format(value), 'data-key': key || null,
    oninput: () => { out.textContent = format(Number(input.value)); input.setAttribute('aria-valuetext', out.textContent); if (onInput) onInput(Number(input.value)); },
    onchange: () => { if (onChange) onChange(Number(input.value)); } });
  return el('div', { class: 'dsh-slider-w' }, input, out);
}
/** A colour well: a round swatch that opens swatches (theme colours first) and the system picker. */
export function colorWell({ label, value = '', swatches = [], onChange, allowNone = false, key = '' }) {
  const well = el('button', { type: 'button', class: 'dsh-well', 'aria-label': `${label}: ${value || tx('none')}`, title: label, 'data-key': key || null, style: { '--well': value || 'transparent' } });
  well.addEventListener('click', () => {
    const native = el('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(value) ? value : '#0a84ff', 'aria-label': `${label}: ${tx('custom colour')}`, onchange: () => { onChange(native.value); close(); } });
    const pickRow = el('div', { class: 'dsh-swatches', role: 'group', 'aria-label': label },
      ...swatches.map((s) => { const v = typeof s === 'string' ? s : s.value; const n = typeof s === 'string' ? s : s.label; return el('button', { type: 'button', class: 'dsh-swatch', style: { '--well': v }, 'aria-label': n, title: n, 'aria-pressed': String(v === value), onclick: () => { onChange(v); close(); } }); }),
      allowNone ? el('button', { type: 'button', class: 'dsh-swatch none', 'aria-label': tx('None'), title: tx('None'), 'aria-pressed': String(!value), onclick: () => { onChange(''); close(); } }) : null);
    const close = popover(well, el('div', { class: 'dsh-wellpop' }, el('p', { class: 'dsh-pop-title' }, label), pickRow, el('label', { class: 'dsh-row' }, el('span', { class: 'dsh-row-l' }, tx('Custom')), native)), { label });
  });
  return well;
}
/** A helpful empty state: an icon, a title, a line of text and up to two actions. */
export function emptyState({ icon: ic = 'info', title, text = '', actions = [] }) {
  return el('div', { class: 'dsh-empty' }, el('div', { class: 'dsh-empty-ic' }, icon(ic, 28)), el('h3', '', title), text ? el('p', '', text) : null, actions.length ? el('div', { class: 'dsh-empty-acts' }, ...actions) : null);
}

// popovers, menus and sheets: one popover at a time; Escape and a click outside close it; focus returns to the anchor
let openPop = null;
export function closePopover() { if (openPop) openPop.close(); }
/** A popover anchored under (or above, when there is no room) its button. Returns close(). */
export function popover(anchor, content, { label = '', onClose, role = 'dialog', className = '' } = {}) {
  closePopover();
  const pop = el('div', { class: `dsh-pop ${className}`.trim(), role, 'aria-label': label || null, tabindex: '-1' }, content);
  document.body.append(pop); // at window level, fixed: never clipped by the side canvas's edge (it hides its overflow)
  const place = () => {
    const a = anchor.getBoundingClientRect();
    const w = pop.offsetWidth, ht = pop.offsetHeight;
    const vw = innerWidth, vh = innerHeight;
    // a menu hangs from its button's left edge (the Mac's way), a popover is centred under it; both stay in the window
    let x = Math.min(Math.max(8, role === 'menu' ? a.left : a.left + a.width / 2 - w / 2), vw - w - 8);
    let y = a.bottom + 6;
    if (y + ht > vh - 8 && a.top - ht - 6 > 8) { y = a.top - ht - 6; pop.dataset.side = 'top'; }
    pop.style.left = `${Math.max(8, x)}px`;
    pop.style.top = `${Math.max(8, y)}px`;
    pop.style.setProperty('--arrow', `${a.left + a.width / 2 - x}px`);
  };
  place();
  if (anchor.setAttribute) anchor.setAttribute('aria-expanded', 'true');
  const outside = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); if (anchor.focus) anchor.focus(); } };
  const close = () => {
    if (!pop.isConnected) return;
    pop.remove();
    document.removeEventListener('pointerdown', outside, true);
    removeEventListener('resize', place);
    if (anchor.setAttribute) anchor.setAttribute('aria-expanded', 'false');
    if (openPop && openPop.pop === pop) openPop = null;
    if (pop.contains(document.activeElement) && anchor.focus) anchor.focus();
    if (onClose) onClose();
  };
  pop.addEventListener('keydown', esc);
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  addEventListener('resize', place);
  openPop = { pop, close, anchor };
  requestAnimationFrame(() => { const f = pop.querySelector('[autofocus],input,select,textarea,button:not([disabled]),[tabindex="0"]'); (f || pop).focus({ preventScroll: true }); });
  return close;
}
/** A menu (role=menu): items { label, icon, shortcut, run, disabled, checked, danger } or { separator: true } or
 *  { heading: 'Text' }. Opens at an anchor element or at { x, y } (a right-click). ↑ ↓ Home End move; Enter picks. */
export function menu(at, items, { label = tx('Menu') } = {}) {
  const list = (items || []).filter(Boolean);
  const box = el('div', { class: 'dsh-menu-list' });
  let lastSep = true;
  for (const it of list) {
    if (it.separator) { if (!lastSep) box.append(el('div', { class: 'dsh-menu-sep', role: 'separator' })); lastSep = true; continue; }
    lastSep = false;
    if (it.heading) { box.append(el('div', { class: 'dsh-menu-h', role: 'presentation' }, it.heading)); continue; }
    box.append(el('button', { type: 'button', role: it.checked === undefined ? 'menuitem' : 'menuitemcheckbox', class: `dsh-mi${it.danger ? ' danger' : ''}`, 'aria-checked': it.checked === undefined ? null : String(!!it.checked), disabled: it.disabled || null, 'aria-keyshortcuts': it.shortcut ? ariaKeys(it.shortcut) : null, tabindex: '-1',
      onclick: () => { close(); if (it.run) it.run(ctxNow()); } },
    el('span', { class: 'dsh-mi-ic' }, it.checked ? icon('check', 14) : it.icon ? icon(it.icon, 16) : null), el('span', { class: 'dsh-mi-l' }, it.label), it.shortcut ? el('kbd', '', formatKeys(it.shortcut)) : null));
  }
  if (box.lastChild && box.lastChild.classList.contains('dsh-menu-sep')) box.lastChild.remove();
  let anchor = at;
  if (!(at instanceof Element)) { // a point: a zero-size anchor there
    anchor = el('span', { class: 'dsh-point', style: { left: `${at.x}px`, top: `${at.y}px` } });
    document.body.append(anchor);
  }
  const close = popover(anchor, box, { label, role: 'menu', className: 'dsh-menu', onClose: () => { if (!(at instanceof Element)) { anchor.remove(); if (at.returnFocus && at.returnFocus.focus) at.returnFocus.focus(); } } });
  box.addEventListener('keydown', (e) => {
    const all = [...box.querySelectorAll('.dsh-mi:not([disabled])')];
    const i = all.indexOf(document.activeElement);
    const go = (n) => { e.preventDefault(); if (all[n]) all[n].focus(); };
    if (e.key === 'ArrowDown') go((i + 1) % all.length); else if (e.key === 'ArrowUp') go((i - 1 + all.length) % all.length);
    else if (e.key === 'Home') go(0); else if (e.key === 'End') go(all.length - 1);
    else if (e.key === 'Tab') { e.preventDefault(); close(); }
  });
  requestAnimationFrame(() => { const f = box.querySelector('.dsh-mi:not([disabled])'); if (f) f.focus(); });
  return close;
}
/** A sheet: a modal card for a multi-step task (<dialog>, Escape closes, focus returns). actions: Nodes for the foot. */
export function sheet({ title, content, actions = [], onClose, wide = false, label = '' }) {
  const ret = document.activeElement;
  const d = el('dialog', { class: `dsh-sheet${wide ? ' wide' : ''}`, 'aria-label': label || title });
  const close = () => { if (d.open) d.close(); };
  d.append(el('header', { class: 'dsh-sheet-head' }, el('h2', '', title), iconButton({ icon: 'close', label: tx('Close'), onClick: close })),
    el('div', { class: 'dsh-sheet-body' }, content), actions.length ? el('footer', { class: 'dsh-sheet-foot' }, ...actions) : null);
  d.addEventListener('close', () => { d.remove(); if (ret && ret.isConnected && ret.focus) ret.focus(); if (onClose) onClose(); });
  d.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.stopPropagation(); }); // only the sheet closes, not the canvas
  d.addEventListener('click', (e) => { if (e.target === d) close(); }); // a click on the backdrop
  document.body.append(d);
  d.showModal();
  return { dialog: d, close };
}
export const kit = { button, iconButton, segmented, section, row, listRow, stepper, slider, colorWell, emptyState, popover, menu, sheet, closePopover, icon };

// ── the shell itself ────────────────────────────────────────────────────────────────────────────────────────────

const store = { get(k, d) { try { const v = localStorage.getItem(`eden-slides:${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(`eden-slides:${k}`, JSON.stringify(v)); } catch { /* private window */ } } };
const shell = {
  root: null, host: null, inspector: null, tabs: null,
  tab: store.get('tab', 'format'), open: store.get('inspector', true), nav: store.get('nav', 'list'), notes: store.get('notes', true),
  collapsed: new Set(store.get('collapsed', [])), keepFocus: null, scroll: {}, refreshQueued: false,
};
export const ui = { get tab() { return shell.tab; }, get open() { return shell.open; }, get nav() { return shell.nav; }, get notes() { return shell.notes; } };
const BUILT_IN_TABS = [{ id: 'format', title: 'Format', icon: 'format', order: 10 }, { id: 'animate', title: 'Animate', icon: 'animate', order: 20 }, { id: 'document', title: 'Document', icon: 'document', order: 30 }];
const allTabs = () => [...BUILT_IN_TABS, ...reg.tabs].sort(byOrder).filter((t) => !t.when || t.when(selection(), ctxNow()));

/** The ctx every render, run and items call gets. deck.js supplies `host` (its functions); the rest is the shell's. */
function ctxNow() {
  const h = shell.host || {};
  return {
    version: SHELL_VERSION,
    get deck() { return h.currentDeck ? h.currentDeck() : null; },
    get conv() { return h.cur ? h.cur() : null; },
    get selection() { return selection(); },
    currentDeck: () => (h.currentDeck ? h.currentDeck() : null),
    commit: (deck, o) => h.commit && h.commit(deck, o),
    select, frame: () => (h.frame ? h.frame() : null),
    post: (m) => { const f = h.frame && h.frame(); if (f && f.contentWindow) f.contentWindow.postMessage(m, '*'); },
    storeImage: (...a) => h.storeImage && h.storeImage(...a),
    keepFocus: (k) => h.keepFocus && h.keepFocus(k),
    notice: (t, kids) => h.notice && h.notice(t, kids),
    toast, tx, ui: kit, kit, icon,
    openInspector, closeInspector: () => setInspector(false), refresh: refreshInspector,
    actions: h.actions || {},
  };
}
export const context = ctxNow;

let refreshT = 0;
function requestRefresh() { if (!shell.root || shell.refreshQueued) return; shell.refreshQueued = true; clearTimeout(refreshT); refreshT = setTimeout(() => { shell.refreshQueued = false; drawToolbar(); refreshInspector(); }, 0); }

/** Open the Inspector on a tab (Format, Animate, Document, or a registered one); a second click on its button closes it. */
export function openInspector(tab = shell.tab, { toggle = false } = {}) {
  if (toggle && shell.open && shell.tab === tab) { setInspector(false); return; }
  shell.tab = tab; store.set('tab', tab);
  setInspector(true);
}
const canvasWidth = () => { const n = shell.root && shell.root.isConnected ? shell.root : document.getElementById('artifact'); return n && n.getBoundingClientRect().width || innerWidth; };
const narrowNow = () => typeof innerWidth !== 'undefined' && (innerWidth <= 640 || canvasWidth() <= 900);
const openKey = () => (narrowNow() ? 'inspector-narrow' : 'inspector'); // a narrow canvas starts with the Inspector closed (it floats over the slide)
function setInspector(on) {
  shell.open = on; store.set(openKey(), on);
  if (shell.root) { shell.root.classList.toggle('dsh-insp-open', on); drawToolbar(); refreshInspector(); }
}
export function setNavigator(mode) {
  if (!['list', 'grid', 'hidden'].includes(mode)) return;
  shell.nav = mode; store.set('nav', mode);
  ctxNow().post({ type: 'deck-nav', mode });
  drawToolbar();
}
export function setNotes(show) { shell.notes = !!show; store.set('notes', shell.notes); ctxNow().post({ type: 'deck-notes', show: shell.notes }); drawToolbar(); }

/** Draw the shell around the slide stage. host: { currentDeck, cur, commit, frame, storeImage, keepFocus, notice, actions }.
 *  Returns the root (.dsh); deck.js puts it in the canvas in place of the old toolbar and trays. */
export function mountShell({ stage, panel, extra = [], trailing = [], host }) {
  shell.host = host;
  shell.trailing = trailing;
  shell.keepFocus = host.keepFocus;
  if (shell.inspector) for (const b of shell.inspector.querySelectorAll('.dsh-insp-body')) shell.scroll[b.dataset.tab] = b.scrollTop; // kept across the redraw
  const toolbar = el('div', { class: 'dsh-toolbar', role: 'toolbar', 'aria-label': tx('Slide editor'), 'aria-orientation': 'horizontal' });
  const inspector = el('aside', { class: 'dsh-inspector', id: 'deckInspector', 'aria-label': tx('Inspector') });
  const root = el('div', { class: `dsh${shell.open ? ' dsh-insp-open' : ''}` },
    toolbar, panel, el('div', { class: 'dsh-body' }, el('div', { class: 'dsh-canvas' }, stage), inspector), ...extra);
  shell.root = root; shell.toolbar = toolbar; shell.inspector = inspector;
  shell.open = store.get(openKey(), !narrowNow()); // before it's in the page: the window decides
  root.classList.toggle('dsh-insp-open', shell.open);
  toolbar.addEventListener('keydown', (e) => { // a toolbar is one Tab stop in spirit, but every button stays tabbable for clarity; ← → also move
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const all = [...toolbar.querySelectorAll('button:not([disabled])')];
    const i = all.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    all[(i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length].focus();
  });
  drawToolbar();
  refreshInspector();
  return root;
}
/** After deck-ready: tell the frame the navigator view, notes and shortcut keys. */
export function frameReady() {
  const c = ctxNow();
  c.post({ type: 'deck-nav', mode: shell.nav });
  if (!shell.notes) c.post({ type: 'deck-notes', show: false });
  c.post({ type: 'deck-keys', keys: frameKeys() });
}
/** Messages from the frame that belong to the shell (deck.js forwards them after checking the source). */
export function frameMessage(m, deck) {
  const n = deck && Array.isArray(deck.slides) ? deck.slides.length : 0;
  const ok = (i) => Number.isInteger(i) && i >= 0 && i < n;
  if (m.type === 'deck-sel') { if (m.path === null) select({ textPath: null }); else if (typeof m.path === 'string' && m.path.length < 80) select({ ...(ok(m.index) ? { slide: m.index } : {}), textPath: m.path, editing: m.editing === true, elementIds: [] }); }
  else if (m.type === 'deck-free-sel') select({ elementIds: Array.isArray(m.ids) && ok(m.index) ? m.ids.filter((x) => typeof x === 'string' && x.length <= 24) : [], textPath: null });
  else if (m.type === 'deck-key' && typeof m.combo === 'string') runShortcut(m.combo, null);
  else if (m.type === 'deck-nav' && ['list', 'grid', 'hidden'].includes(m.mode)) { shell.nav = m.mode; store.set('nav', m.mode); drawToolbar(); }
  else if (m.type === 'deck-context' && ['slide', 'text', 'element', 'thumb'].includes(m.target)) {
    if (ok(m.index) && m.index !== sel.slide && m.target !== 'thumb') select({ slide: m.index });
    if (m.target === 'element' && typeof m.id === 'string' && !sel.elementIds.includes(m.id)) select({ elementIds: [m.id] });
    const f = shell.host && shell.host.frame && shell.host.frame();
    const r = f ? f.getBoundingClientRect() : { left: 0, top: 0 };
    const x = Number(m.x) || 0, y = Number(m.y) || 0;
    openContextMenu(m.target, { x: r.left + x, y: r.top + y, returnFocus: f }, { index: ok(m.index) ? m.index : sel.slide, path: m.path, id: m.id, k: m.k });
  }
}
/** Every registered provider's items for a target, separated by provider (base: items that come first). */
export function menuItems(target, info = {}, base = []) {
  const c = { ...ctxNow(), target, ...info };
  const items = [...base];
  for (const p of reg.menus.filter((x) => x.target === target)) {
    let got = [];
    try { got = (p.items(c) || []).filter(Boolean); } catch (e) { console.error(e); }
    if (got.length) { if (items.length) items.push({ separator: true }); items.push(...(RIGHT_CLICK.includes(target) ? folded(got) : got)); }
  }
  return items;
}
const RIGHT_CLICK = ['slide', 'text', 'element', 'thumb'];
/** A right-click menu stays short: a titled group (a heading up to the next separator: Ask Eden, Zoom…) becomes one
 *  submenu ("Ask Eden ›") instead of a column of items down the whole window. */
function folded(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (!it.heading) { out.push(it); continue; }
    const sub = [];
    while (i + 1 < list.length && !list[i + 1].separator && !list[i + 1].heading) sub.push(list[++i]);
    if (sub.length) out.push({ label: it.heading, icon: /eden/i.test(it.heading) ? 'sparkles' : /zoom/i.test(it.heading) ? 'zoom' : undefined, items: sub });
  }
  return out;
}
/** The right-click menu for a target. */
export function openContextMenu(target, at, info = {}) {
  const items = menuItems(target, info);
  if (!items.length) return null;
  return menu(at, items, { label: tx('Actions') });
}

const GROUPS = ['view', 'slide', 'insert', 'collab', 'inspector'];
/** Redraw the toolbar (a tool's `when` or `pressed` changed outside an edit). */
export const refreshToolbar = () => drawToolbar();
function drawToolbar() {
  const bar = shell.toolbar;
  if (!bar || !bar.isConnected && !shell.root) return;
  const c = ctxNow();
  const kids = [];
  for (const g of GROUPS) {
    const tools = reg.tools.filter((t) => t.group === g && (!t.when || t.when(c)));
    if (!tools.length) continue;
    const box = el('div', { class: `dsh-group dsh-g-${g}`, role: 'group', 'aria-label': tx(g === 'view' ? 'View' : g === 'slide' ? 'Slide' : g === 'insert' ? 'Insert' : g === 'collab' ? 'Share' : 'Inspector') });
    for (const t of tools) box.append(toolButton(t, c));
    if (g === 'collab' && shell.trailing) box.prepend(...shell.trailing.filter(Boolean)); // who else is here, beside Collaborate
    kids.push(box);
    if (g === 'slide' || g === 'insert') kids.push(el('span', { class: 'dsh-flex', 'aria-hidden': 'true' }));
  }
  bar.replaceChildren(...kids);
  fitToolbar();
  if (!fitObs && typeof ResizeObserver !== 'undefined') fitObs = new ResizeObserver(() => { clearTimeout(fitObs.t); fitObs.t = setTimeout(fitToolbar, 60); });
  if (fitObs) { fitObs.disconnect(); fitObs.observe(bar); }
}
function toolButton(t, c) {
  const pressed = t.pressed ? !!t.pressed(c) : undefined;
  const b = el('button', { type: 'button', class: `dsh-tool${t.primary ? ' primary' : ''}`, id: t.domId || null, 'data-tool': t.id, 'data-key': `tool:${t.id}`, title: tip(t.title || t.label, t.shortcut), 'aria-keyshortcuts': t.shortcut ? ariaKeys(t.shortcut) : null, 'aria-pressed': pressed === undefined ? null : String(pressed), 'aria-haspopup': t.popover ? 'dialog' : t.menu ? 'menu' : null, 'aria-expanded': t.popover || t.menu ? 'false' : null },
    el('span', { class: 'dsh-tool-ic' }, icon(t.icon, 20)), el('span', { class: 'dsh-tool-l' }, t.label));
  b.addEventListener('click', () => {
    if (openPop && openPop.anchor === b) { closePopover(); return; }
    useTool(t, b);
  });
  return b;
}
function useTool(t, anchor) {
  const cc = ctxNow();
  if (t.menu) menu(anchor, t.menu(cc), { label: t.label });
  else if (t.popover) { let close = () => {}; const content = t.popover(cc, () => close()); if (content) close = popover(anchor, content, { label: t.label, className: 'dsh-toolpop' }); }
  else if (t.run) { if (shell.keepFocus) shell.keepFocus(`tool:${t.id}`); t.run(cc, anchor); }
}
/** The toolbar fits its width: when it's too narrow (the canvas beside the chat), the least-needed tools move into a
 *  More menu (⋯), last first. Add Slide, Play, the insert tools and the Inspector buttons go last. */
const DROP_FIRST = ['zoom', 'find', 'redo', 'undo', 'collaborate', 'view', 'file', 'chart', 'table', 'comment', 'shape', 'media', 'text', 'chat', 'eden', 'document', 'animate'];
const dropRank = (id) => { const i = DROP_FIRST.indexOf(id); return i < 0 ? -1 : DROP_FIRST.length - i; }; // higher drops sooner; unknown (feature) tools drop first of all
function fitToolbar() {
  const bar = shell.toolbar;
  if (!bar || !bar.isConnected) return;
  const old = bar.querySelector('.dsh-more');
  if (old) old.remove();
  const btns = [...bar.querySelectorAll('.dsh-tool[data-tool]')];
  btns.forEach((b) => { b.hidden = false; });
  if (bar.scrollWidth <= bar.clientWidth + 1) return;
  const order = btns.filter((b) => !['add-slide', 'play', 'format'].includes(b.dataset.tool)).sort((a, b) => {
    const ra = dropRank(a.dataset.tool), rb = dropRank(b.dataset.tool);
    return (ra < 0 ? 1e3 : ra) > (rb < 0 ? 1e3 : rb) ? -1 : 1;
  });
  const more = el('button', { type: 'button', class: 'dsh-tool dsh-more', 'data-key': 'tool:more', title: tx('More tools'), 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, el('span', { class: 'dsh-tool-ic' }, icon('more', 20)), el('span', { class: 'dsh-tool-l' }, tx('More')));
  const last = bar.querySelector('.dsh-g-inspector') || bar.lastElementChild;
  bar.insertBefore(more, last);
  const hidden = [];
  for (const b of order) { if (bar.scrollWidth <= bar.clientWidth + 1) break; b.hidden = true; hidden.push(b.dataset.tool); }
  more.addEventListener('click', () => {
    if (openPop && openPop.anchor === more) { closePopover(); return; }
    const c = ctxNow();
    const tools = reg.tools.filter((t) => hidden.includes(t.id));
    menu(more, tools.sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || byOrder(a, b)).map((t) => ({ label: t.label + (t.menu || t.popover ? '…' : ''), icon: t.icon, shortcut: t.shortcut, checked: t.pressed ? !!t.pressed(c) : undefined, run: () => setTimeout(() => useTool(t, more), 0) })), { label: tx('More tools') });
  });
}
let fitObs = null;

/** Redraw the Inspector for the current selection (cheap: only the open tab is built). */
export function refreshInspector() {
  const box = shell.inspector;
  if (!box || !shell.root) return;
  const c = ctxNow();
  const s = selection();
  const tabs = allTabs();
  if (!tabs.some((t) => t.id === shell.tab)) shell.tab = 'format';
  const active = document.activeElement;
  const focusKey = active && box.contains(active) ? active.dataset.key || '' : '';
  const old = box.querySelector('.dsh-insp-body');
  if (old) shell.scroll[old.dataset.tab] = old.scrollTop;
  const head = el('div', { class: 'dsh-insp-tabs' }, segmented({ label: tx('Inspector'), key: 'insp-tab', value: shell.tab, options: tabs.map((t) => ({ value: t.id, label: tx(t.title) })), onChange: (v) => openInspector(v) }));
  const sections = reg.sections.filter((x) => x.tab === shell.tab && (!x.when || safe(() => x.when(s, c), false)));
  const kids = [];
  for (const x of sections) {
    let node = null;
    try { node = x.render(c); } catch (e) { console.error(`inspector ${x.id}`, e); node = el('p', { class: 'dsh-hint' }, tx('This section couldn’t draw.')); }
    if (!node) continue;
    kids.push(x.title ? section({ title: tx(x.title), id: x.id, collapsible: x.collapsible, children: [node] }) : el('section', { class: 'dsh-sec', 'data-sec': x.id }, node));
  }
  if (!kids.length) kids.push(emptyState({ icon: 'info', title: tx('Nothing to change here'), text: tx('Select a slide, some text or an element on the canvas.') }));
  const body = el('div', { class: 'dsh-insp-body', 'data-tab': shell.tab, role: 'region', 'aria-label': `${tx(tabs.find((t) => t.id === shell.tab)?.title || '')} ${tx('inspector')}` }, el('p', { class: 'dsh-insp-sel', 'aria-live': 'polite' }, selLabel(s, c)), ...kids);
  box.replaceChildren(head, body);
  body.scrollTop = shell.scroll[shell.tab] || 0;
  if (focusKey) { const back = [...box.querySelectorAll('[data-key]')].find((n) => n.dataset.key === focusKey); if (back) back.focus({ preventScroll: true }); }
  if (shell.root) store.set('collapsed', [...shell.collapsed]);
}
const safe = (f, d) => { try { return f(); } catch { return d; } };
function selLabel(s, c) {
  const d = c.deck;
  const n = d && d.slides ? d.slides.length : 0;
  if (s.kind === 'element') return `${tx('Slide')} ${s.slide + 1} · ${s.elementIds.length === 1 ? tx('1 element selected') : `${s.elementIds.length} ${tx('elements selected')}`}`;
  if (s.kind === 'text') return `${tx('Slide')} ${s.slide + 1} · ${s.textPath === 'notes' ? tx('Presenter notes') : s.textPath === 'title' ? tx('Title') : tx('Text')}`;
  if (s.slides.length > 1) return `${s.slides.length} ${tx('slides selected')}`;
  return n ? `${tx('Slide')} ${s.slide + 1} ${tx('of')} ${n}` : '';
}

// first-run hints: shown once each, in the inspector's place, dismissed with Got it
export function hint(id, text) {
  if (store.get(`hint:${id}`, false)) return null;
  const box = el('div', { class: 'dsh-hint-card', role: 'note' }, icon('sparkles', 16), el('p', '', text),
    el('button', { type: 'button', class: 'dsh-btn small quiet', onclick: () => { store.set(`hint:${id}`, true); box.remove(); } }, tx('Got it')));
  return box;
}
