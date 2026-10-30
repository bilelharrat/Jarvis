// Rich text, the page side (web only: deck.js calls initRichText only when !IN_APP). A floating format bar sits over
// the selected slide text (bold, italic, underline, strikethrough, colour, highlight, size, font, alignment, lists,
// indent, link), the Inspector gets a Format › Text section (deck-shell.js contract), and ⌘B ⌘I ⌘U ⌘K also work
// from the page. The slide frame (deck-rich-frame.js) reports the selection and sends the keys; every change is one
// undoable version (deck-rich.js does the formatting), after which the frame redraws and the selection comes back.
// Screen readers hear each change ("Bold on", "Link added") from a polite live region.

import { el } from './util.js';
import { t as tx } from './i18n.js';
import { themeOf, setText, editablePath } from './deck-model.js';
import { formatRange, setAlign, setList, indentBullet, formatAt, textAt, richPath, richLink, listOf, HIGHLIGHTS, ALIGNS } from './deck-rich.js';
import { FREE_FAMILIES } from './deck-fonts.js';

let host = null; // { frame, currentDeck, commit, queue(msg): a message for the next frame once it's ready }
const sel = { index: -1, path: '', start: 0, end: 0, editing: false, rect: null }; // what the frame last reported
let restoring = false; // a redraw we asked for: its frame will put the selection back
let bar = null, live = null, linkPop = null;

const COLORS = [['accent', 'Accent'], ['accent2', 'Second accent'], ['text', 'Text'], ['muted', 'Muted']];
const HL_NAMES = { yellow: 'Yellow', green: 'Green', pink: 'Pink', blue: 'Blue' };
const ALIGN_NAMES = { left: 'Align left', center: 'Centre', right: 'Align right', justify: 'Justify' };
const NAMES = { b: 'Bold', i: 'Italic', u: 'Underline', s: 'Strikethrough' };

export function initRichText(h) {
  host = h;
  injectCss();
  live = el('div', { class: 'sr-only', 'aria-live': 'polite', role: 'status', id: 'richLive' });
  document.body.append(live);
  addEventListener('resize', place);
  addEventListener('scroll', place, true);
  document.addEventListener('pointerdown', (e) => { if (bar && !bar.hidden && !bar.contains(e.target) && !(linkPop && linkPop.contains(e.target)) && !(host.frame() && e.target === host.frame())) hideBar(); }, true);
  registerWithShell();
}

const say = (text) => { if (!live) return; live.textContent = ''; setTimeout(() => { live.textContent = tx(text); }, 30); };
const deckNow = () => (host ? host.currentDeck() : null);
const okSel = (deck) => deck && sel.index >= 0 && sel.index < deck.slides.length && richPath(sel.path) && !!textAt(deck.slides[sel.index], sel.path);

// ── messages from the frame (deck.js forwards the ones it doesn't know, after checking their source) ──

/** True when the message was rich text's. */
export function richMessage(m, deck, idx) {
  if (!host || !m || typeof m.type !== 'string') return false;
  if (m.type === 'deck-rich-sel') {
    if (m.path === null || m.path === undefined) {
      if (m.boot && (restoring || (bar && bar.contains(document.activeElement)) || linkPop)) { restoring = false; return true; } // our own redraw, or the person is using the bar
      hideBar();
      return true;
    }
    if (idx < 0 || !richPath(m.path)) { hideBar(); return true; }
    restoring = false;
    Object.assign(sel, { index: idx, path: m.path, start: Math.max(0, m.start | 0), end: Math.max(0, m.end | 0), editing: m.editing === true, rect: rectOf(m.rect) });
    showBar();
    return true;
  }
  if (m.type === 'deck-open') { const u = richLink(m.url); if (u && u[0] !== '#') window.open(u, '_blank', 'noopener,noreferrer'); return true; }
  if (!/^deck-(fmt|list|indent|link|align|fmt-bar)$/.test(m.type)) return false;
  const at = m.fallback ? { ...sel } : { index: idx, path: m.path, start: Math.max(0, m.start | 0), end: Math.max(0, m.end | 0), editing: m.editing === true };
  if (!m.fallback) Object.assign(sel, at);
  if (at.index < 0 || !richPath(at.path)) return true;
  if (m.type === 'deck-fmt-bar') { showBar(); focusBar(); return true; }
  if (m.type === 'deck-link') { showBar(); openLink(); return true; }
  const value = typeof m.value === 'string' && m.value.length <= 5000 ? m.value : null;
  if (m.type === 'deck-fmt') act(at, value, (d) => formatRange(d, at.index, at.path, at.start, at.end, cleanPatch(m.patch)), (d) => spoken(m.patch, d, at));
  else if (m.type === 'deck-align' && ALIGNS.includes(m.align)) act(at, value, (d) => setAlign(d, at.index, at.path, m.align), () => ALIGN_NAMES[m.align]);
  else if (m.type === 'deck-list') act(at, value, (d) => setList(d, at.index, at.path, m.kind === 'num' ? 'num' : 'bullet'), () => (m.kind === 'num' ? 'Numbered list' : 'Bulleted list'));
  else if (m.type === 'deck-indent') {
    let to = at.path;
    act(at, value, (d) => { const r = indentBullet(d, at.index, at.path, m.dir < 0 ? -1 : 1); if (!r) return d; to = r.path; return r.deck; }, () => (m.dir < 0 ? 'Outdented' : 'Indented'), () => to, 'Can’t move this point that way');
  }
  return true;
}

/** Only what a format change may hold. */
function cleanPatch(p) {
  const out = {};
  if (!p || typeof p !== 'object') return out;
  for (const k of ['b', 'i', 'u', 's']) if (p[k] === 'toggle' || typeof p[k] === 'boolean') out[k] = p[k];
  if (p.size === 'up' || p.size === 'down' || p.size === null) out.size = p.size;
  for (const k of ['color', 'hl', 'font', 'link']) if (Object.prototype.hasOwnProperty.call(p, k) && (p[k] === null || (typeof p[k] === 'string' && p[k].length <= 2000))) out[k] = p[k];
  return out;
}

/** What a screen reader hears after a change. */
function spoken(patch, deck, at) {
  const p = cleanPatch(patch);
  const f = formatAt(deck.slides[at.index], at.path, at.start, at.end);
  for (const k of ['b', 'i', 'u', 's']) if (k in p) return `${NAMES[k]} ${f[k] ? 'on' : 'off'}`;
  if ('size' in p) return p.size === 'up' ? 'Bigger text' : p.size === 'down' ? 'Smaller text' : 'Usual size';
  if ('color' in p) return p.color ? 'Text colour changed' : 'Text colour reset';
  if ('hl' in p) return p.hl ? 'Highlighted' : 'Highlight removed';
  if ('font' in p) return p.font ? `Font: ${p.font}` : 'Theme font';
  if ('link' in p) return p.link ? 'Link added' : 'Link removed';
  return 'Formatted';
}

/**
 * One change: the words typed so far first (they haven't been saved yet), then `f`, one version; the next frame
 * selects the same words again (at `pathAfter()`, for a bullet that moved).
 */
function act(at, value, f, speech, pathAfter = () => at.path, cant = '') {
  let d = deckNow();
  if (!d || !d.slides[at.index]) return;
  if (value !== null && editablePath(at.path) && value.replace(/\s+/g, ' ').trim() !== textAt(d.slides[at.index], at.path)) d = setText(d, at.index, at.path, value);
  const out = f(d);
  if (out === d && d === deckNow()) { if (cant) say(cant); return; }
  host.queue({ type: 'deck-select', index: at.index, path: pathAfter(), start: at.start, end: at.end, edit: at.editing });
  restoring = true;
  sel.path = pathAfter();
  host.commit(out);
  say(speech(out));
}

/** A change from the bar or the Inspector: the frame sends it with the live selection (and unsaved words) when it can. */
function run(action) {
  const f = host && host.frame();
  if (f && f.contentWindow && sel.index >= 0) f.contentWindow.postMessage({ type: 'deck-rich-do', action }, '*');
  else richMessage({ ...action, fallback: true }, deckNow(), sel.index);
}
export const richRun = run; // for other modules (find/replace, inline AI) that want to format the current selection

// ── the floating bar ──

const rectOf = (r) => (r && [r.x, r.y, r.w, r.h].every(Number.isFinite) ? { x: r.x, y: r.y, w: r.w, h: r.h } : null);

function showBar() {
  const deck = deckNow();
  if (!okSel(deck)) { hideBar(); return; }
  const focusKey = bar && bar.contains(document.activeElement) ? document.activeElement.dataset.key : '';
  const next = drawBar(deck);
  if (bar) bar.replaceWith(next); else document.body.append(next);
  bar = next;
  place();
  if (focusKey) { const b = bar.querySelector(`[data-key="${focusKey}"]`); if (b) b.focus(); }
}
function hideBar() { if (bar) bar.hidden = true; closeLink(); }

function place() {
  if (!bar || bar.hidden || !host) return;
  const f = host.frame();
  if (!f || !f.isConnected) { hideBar(); return; }
  const fr = f.getBoundingClientRect();
  const r = sel.rect || { x: fr.width / 2, y: fr.height / 2, w: 0, h: 0 };
  bar.style.left = '0px'; bar.style.top = '0px'; // measured at full width, not squeezed against the edge it was at
  const bw = bar.offsetWidth, bh = bar.offsetHeight;
  let top = fr.top + r.y - bh - 10;
  if (top < Math.max(8, fr.top - bh)) top = fr.top + r.y + r.h + 10;
  const left = Math.max(8, Math.min(innerWidth - bw - 8, fr.left + r.x + r.w / 2 - bw / 2));
  bar.style.top = `${Math.round(Math.max(8, Math.min(innerHeight - bh - 8, top)))}px`;
  bar.style.left = `${Math.round(left)}px`;
}

function focusBar() { const b = bar && bar.querySelector('button,select'); if (b) b.focus(); }

/** Back to the slide text (Escape in the bar): the frame selects it again. */
function backToSlide() {
  const f = host.frame();
  hideBar();
  if (!f) return;
  f.focus();
  f.contentWindow.postMessage({ type: 'deck-select', index: sel.index, path: sel.path, start: sel.start, end: sel.end, edit: sel.editing }, '*');
}

function themeHex(deck, v) { const t = themeOf(deck); return t.colors[v] || v || ''; }

function drawBar(deck) {
  const s = deck.slides[sel.index];
  const f = formatAt(s, sel.path, sel.start, sel.end);
  const list = listOf(sel.path);
  const b = (key, label, text, onClick, pressed) => {
    const x = el('button', { type: 'button', class: `rtb-b rtb-${key}`, 'data-key': `rtb-${key}`, 'aria-label': tx(label), title: tx(label), ...(pressed === undefined ? {} : { 'aria-pressed': String(!!pressed) }), onclick: onClick }, text);
    x.addEventListener('mousedown', (e) => e.preventDefault()); // the slide text keeps focus (and its selection)
    return x;
  };
  const sep = () => el('span', { class: 'rtb-sep', 'aria-hidden': 'true' });
  const fmt = (patch) => () => run({ type: 'deck-fmt', patch });
  const kids = [
    b('b', `Bold (${mod()}B)`, 'B', fmt({ b: 'toggle' }), f.b),
    b('i', `Italic (${mod()}I)`, 'I', fmt({ i: 'toggle' }), f.i),
    b('u', `Underline (${mod()}U)`, 'U', fmt({ u: 'toggle' }), f.u),
    b('s', 'Strikethrough', 'S', fmt({ s: 'toggle' }), f.s),
    sep(),
    colorButton('color', 'Text colour', 'A', f.color ? themeHex(deck, f.color) : '', COLORS.map(([v, n]) => ({ value: v, label: n, hex: themeHex(deck, v) })), (v) => run({ type: 'deck-fmt', patch: { color: v || null } }), true),
    colorButton('hl', 'Highlight', '▍', f.hl || '', Object.entries(HIGHLIGHTS).map(([n, v]) => ({ value: v, label: HL_NAMES[n], hex: v })), (v) => run({ type: 'deck-fmt', patch: { hl: v || null } }), true),
    b('down', 'Smaller text', 'A−', fmt({ size: 'down' })),
    b('up', 'Bigger text', 'A+', fmt({ size: 'up' })),
    fontSelect(f.font, f.mixed.includes('font')),
    sep(),
    alignButton(f.align),
    ...(list ? [
      b('list', f.list === 'num' ? 'Bulleted list' : 'Numbered list', f.list === 'num' ? '1.' : '•', () => run({ type: 'deck-list', kind: f.list === 'num' ? 'bullet' : 'num' }), f.list === 'num'),
      b('out', 'Outdent (Shift+Tab)', '⇤', () => run({ type: 'deck-indent', dir: -1 })),
      b('in', 'Indent (Tab)', '⇥', () => run({ type: 'deck-indent', dir: 1 })),
    ] : []),
    sep(),
    b('link', `${f.link ? 'Edit link' : 'Link'} (${mod()}K)`, '🔗', () => openLink(), !!f.link),
    sep(),
    b('ai', 'Ask Eden about this text', '✦', (e) => dispatchEvent(new CustomEvent('eden:deck-ai-menu', { detail: { anchor: e.currentTarget } }))), // deck-ai.js opens its menu here
  ];
  const t = el('div', { class: 'rtb', role: 'toolbar', 'aria-label': tx('Text format'), 'aria-orientation': 'horizontal' }, ...kids);
  t.addEventListener('keydown', (e) => {
    const items = [...t.querySelectorAll('button,select')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); backToSlide(); }
    else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && i >= 0 && document.activeElement.tagName !== 'SELECT') { e.preventDefault(); items[(i + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length].focus(); }
    else if ((e.metaKey || e.ctrlKey) && /^[biuk]$/i.test(e.key)) { e.preventDefault(); const k = e.key.toLowerCase(); if (k === 'k') openLink(); else run({ type: 'deck-fmt', patch: { [k]: 'toggle' } }); }
  });
  return t;
}
const mod = () => (/Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl+');

/** A colour button: theme colours (or markers) and a custom colour, plus None. */
function colorButton(key, label, glyph, current, swatches, onPick, allowNone) {
  const btn = el('button', { type: 'button', class: `rtb-b rtb-${key}`, 'data-key': `rtb-${key}`, 'aria-label': `${tx(label)}${current ? `: ${current}` : ''}`, title: tx(label), 'aria-haspopup': 'true', 'aria-expanded': 'false' }, el('span', { class: 'rtb-glyph' }, glyph), el('span', { class: 'rtb-swatch-line', style: { background: current || 'transparent' } }));
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    const open = bar && bar.querySelector('.rtb-pop');
    if (open) { const was = open.dataset.for; open.remove(); btn.setAttribute('aria-expanded', 'false'); if (was === key) return; }
    const pop = el('div', { class: 'rtb-pop', role: 'group', 'aria-label': tx(label), 'data-for': key },
      ...swatches.map((s) => { const x = el('button', { type: 'button', class: 'rtb-sw', style: { background: s.hex }, 'aria-label': tx(s.label), title: tx(s.label), onclick: () => onPick(s.value) }); x.addEventListener('mousedown', (e) => e.preventDefault()); return x; }),
      allowNone ? (() => { const x = el('button', { type: 'button', class: 'rtb-sw none', 'aria-label': tx('None'), title: tx('None'), onclick: () => onPick('') }); x.addEventListener('mousedown', (e) => e.preventDefault()); return x; })() : null,
      el('label', { class: 'rtb-custom' }, el('span', { class: 'sr-only' }, tx('Custom colour')), el('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(current) ? current : '#0a84ff', 'aria-label': tx('Custom colour'), onchange: (e) => onPick(e.target.value) })));
    pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); pop.remove(); btn.setAttribute('aria-expanded', 'false'); btn.focus(); } });
    btn.after(pop);
    btn.setAttribute('aria-expanded', 'true');
    const first = pop.querySelector('button'); if (first && document.activeElement === btn) first.focus();
  });
  return btn;
}

function fontSelect(current, mixed = false) {
  const s = el('select', { class: 'rtb-font', 'data-key': 'rtb-font', 'aria-label': tx('Font'), title: tx('Font'), onchange: (e) => run({ type: 'deck-fmt', patch: { font: e.target.value || null } }) },
    el('option', { value: '' }, mixed ? tx('Mixed') : tx('Theme font')),
    ...FREE_FAMILIES.map((f) => el('option', { value: f, selected: f === current }, f)));
  if (!current) s.value = '';
  return s;
}

function alignButton(current) {
  const next = ALIGNS[(ALIGNS.indexOf(current) + 1) % ALIGNS.length];
  const glyph = { left: '⟸', center: '≡', right: '⟹', justify: '☰' }[current] || '≡';
  const x = el('button', { type: 'button', class: 'rtb-b rtb-align', 'data-key': 'rtb-align', 'aria-label': `${tx(ALIGN_NAMES[current] || 'Align left')}. ${tx('Next')}: ${tx(ALIGN_NAMES[next])}`, title: tx(ALIGN_NAMES[current] || 'Align left'), onclick: () => align(next) }, glyph);
  x.addEventListener('mousedown', (e) => e.preventDefault());
  return x;
}
const align = (a) => { if (ALIGNS.includes(a)) run({ type: 'deck-align', align: a }); };

// ── links (⌘K): a web address or "go to slide N" ──

function openLink() {
  const deck = deckNow();
  if (!okSel(deck)) return;
  closeLink();
  const at = { ...sel };
  const cur = formatAt(deck.slides[at.index], at.path, at.start, at.end).link || '';
  const n = deck.slides.length;
  const kind = el('select', { class: 'rtb-font', 'aria-label': tx('Link to') }, el('option', { value: 'url' }, tx('Web address')), el('option', { value: 'slide' }, tx('Slide')));
  const url = el('input', { type: 'url', inputmode: 'url', autocomplete: 'url', spellcheck: 'false', class: 'rtb-url', placeholder: 'https://', 'aria-label': tx('Web address'), value: cur && cur[0] !== '#' ? cur : '' });
  const slide = el('select', { class: 'rtb-font', 'aria-label': tx('Slide') }, ...Array.from({ length: n }, (_, i) => el('option', { value: String(i + 1) }, `${tx('Slide')} ${i + 1}${deck.slides[i].title ? `: ${deck.slides[i].title.slice(0, 40)}` : ''}`)));
  const err = el('p', { class: 'rtb-err', role: 'alert' });
  if (cur[0] === '#') { kind.value = 'slide'; slide.value = cur.slice(1); }
  const sync = () => { url.hidden = kind.value !== 'url'; slide.hidden = kind.value !== 'slide'; };
  kind.addEventListener('change', sync);
  sync();
  const apply = () => {
    const v = kind.value === 'slide' ? `#${slide.value}` : /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(url.value.trim()) ? `https://${url.value.trim()}` : url.value.trim();
    const link = richLink(v);
    if (!link) { err.textContent = tx('Enter a web address that starts with https:// or http://'); url.focus(); return; }
    closeLink();
    act(at, null, (d) => formatRange(d, at.index, at.path, at.start, at.end, { link }), () => 'Link added');
  };
  const remove = () => { closeLink(); act(at, null, (d) => formatRange(d, at.index, at.path, at.start, at.end, { link: null }), () => 'Link removed'); };
  linkPop = el('form', { class: 'rtb-linkbox', novalidate: true, role: 'dialog', 'aria-label': tx('Link'), onsubmit: (e) => { e.preventDefault(); apply(); } },
    el('div', { class: 'rtb-linkbox-row' }, kind, url, slide),
    err,
    el('div', { class: 'rtb-linkbox-row' }, el('button', { type: 'submit', class: 'rtb-btn primary' }, tx(cur ? 'Update' : 'Add link')), cur ? el('button', { type: 'button', class: 'rtb-btn', onclick: remove }, tx('Remove link')) : null, el('button', { type: 'button', class: 'rtb-btn', onclick: () => { closeLink(); backToSlide(); } }, tx('Cancel'))));
  linkPop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeLink(); backToSlide(); } });
  document.body.append(linkPop);
  const br = bar && !bar.hidden ? bar.getBoundingClientRect() : { left: 80, top: 80, bottom: 80 };
  linkPop.style.left = `${Math.round(Math.max(8, Math.min(innerWidth - linkPop.offsetWidth - 8, br.left)))}px`;
  const below = br.bottom + 6, above = br.top - linkPop.offsetHeight - 6; // under the bar, or above it when there's no room: never over it
  linkPop.style.top = `${Math.round(below + linkPop.offsetHeight <= innerHeight - 8 || above < 8 ? Math.min(below, innerHeight - linkPop.offsetHeight - 8) : above)}px`;
  (kind.value === 'url' ? url : slide).focus();
}
function closeLink() { if (linkPop) { linkPop.remove(); linkPop = null; } }

// ── the Inspector's Format › Text section and the page's shortcuts (deck-shell.js contract, when it's there) ──

async function registerWithShell() {
  let S;
  try { S = await import('./deck-shell.js'); } catch { return; } // not built yet: the floating bar is enough
  if (!S || typeof S.registerInspector !== 'function') return;
  S.registerInspector({
    id: 'text-rich', tab: 'format', title: tx('Text Style'), icon: 'text', order: 21,
    when: (s) => s && s.kind === 'text' && richPath(s.textPath),
    render: (ctx) => inspector(ctx, S),
  });
  const cur = (s) => !!(s && s.kind === 'text' && richPath(s.textPath) && s.textPath === sel.path && sel.index >= 0); // only while that text is selected
  for (const [k, keys, label] of [['b', 'Mod+B', 'Bold'], ['i', 'Mod+I', 'Italic'], ['u', 'Mod+U', 'Underline'], ['s', 'Mod+Shift+X', 'Strikethrough']]) {
    S.registerShortcut({ id: `rich-${k}`, keys, label: tx(label), when: cur, run: () => run({ type: 'deck-fmt', patch: { [k]: 'toggle' } }) });
  }
  S.registerShortcut({ id: 'rich-link', keys: 'Mod+K', label: tx('Link'), when: cur, run: () => { showBar(); openLink(); } });
}

function inspector(ctx, S) {
  const deck = ctx.deck;
  const s = ctx.selection;
  if (!deck || !deck.slides[s.slide] || !richPath(s.textPath)) return null;
  if (sel.index !== s.slide || sel.path !== s.textPath) Object.assign(sel, { index: s.slide, path: s.textPath, start: 0, end: 0, editing: !!s.editing });
  const sl = deck.slides[s.slide];
  const f = formatAt(sl, s.textPath, sel.start, sel.end);
  const k = S.kit || ctx.kit;
  const list = listOf(s.textPath);
  const toggle = (key, label) => k.button({ label, small: true, key: `rich-${key}`, pressed: !!f[key], onClick: () => run({ type: 'deck-fmt', patch: { [key]: 'toggle' } }) });
  const fromHex = (v) => { const t = themeOf(deck); return Object.keys(t.colors).find((n) => ['accent', 'accent2', 'text', 'muted'].includes(n) && t.colors[n] === v) || v; };
  return el('div', { class: 'rtb-insp' },
    k.row(tx('Style'), toggle('b', 'B'), toggle('i', 'I'), toggle('u', 'U'), toggle('s', 'S')),
    k.row(tx('Font'), fontSelect(f.font, f.mixed.includes('font'))),
    k.row(tx('Size'), k.button({ label: 'A−', small: true, key: 'rich-down', onClick: () => run({ type: 'deck-fmt', patch: { size: 'down' } }) }), k.button({ label: 'A+', small: true, key: 'rich-up', onClick: () => run({ type: 'deck-fmt', patch: { size: 'up' } }) }), k.button({ label: tx('Reset'), small: true, quiet: true, key: 'rich-size0', onClick: () => run({ type: 'deck-fmt', patch: { size: null } }) })),
    k.row(tx('Colour'), k.colorWell({ label: tx('Text colour'), key: 'rich-color', value: f.color ? themeHex(deck, f.color) : '', swatches: COLORS.map(([v, n]) => ({ value: themeHex(deck, v), label: tx(n) })), allowNone: true, onChange: (v) => run({ type: 'deck-fmt', patch: { color: v ? fromHex(v) : null } }) })),
    k.row(tx('Highlight'), k.colorWell({ label: tx('Highlight'), key: 'rich-hl', value: f.hl || '', swatches: Object.entries(HIGHLIGHTS).map(([n, v]) => ({ value: v, label: tx(HL_NAMES[n]) })), allowNone: true, onChange: (v) => run({ type: 'deck-fmt', patch: { hl: v || null } }) })),
    k.segmented({ label: tx('Alignment'), key: 'rich-align', value: f.align, options: ALIGNS.map((a) => ({ value: a, label: tx(ALIGN_NAMES[a]) })), onChange: (v) => align(v) }),
    list ? k.segmented({ label: tx('List'), key: 'rich-list', value: f.list, options: [{ value: 'bullet', label: tx('Bullets') }, { value: 'num', label: tx('Numbers') }], onChange: (v) => run({ type: 'deck-list', kind: v }) }) : null,
    list ? k.row(tx('Indent'), k.button({ label: tx('Outdent'), small: true, key: 'rich-out', onClick: () => run({ type: 'deck-indent', dir: -1 }) }), k.button({ label: tx('Indent'), small: true, key: 'rich-in', onClick: () => run({ type: 'deck-indent', dir: 1 }) })) : null,
    k.row(tx('Link'), k.button({ label: f.link ? tx('Edit link…') : tx('Add link…'), small: true, key: 'rich-link', onClick: () => { showBar(); openLink(); } })));
}

function injectCss() {
  if (document.getElementById('richCss')) return;
  document.head.append(el('style', { id: 'richCss' }, `
.rtb{position:fixed;z-index:60;display:flex;align-items:center;gap:2px;padding:4px;border-radius:14px;background:var(--glass,rgba(255,255,255,.82));-webkit-backdrop-filter:blur(30px) saturate(180%);backdrop-filter:blur(30px) saturate(180%);border:1px solid var(--hairline,rgba(0,0,0,.12));box-shadow:0 2px 6px rgba(0,0,0,.08),0 24px 64px rgba(0,0,0,.16);color:var(--text,#111);box-sizing:border-box;width:max-content;max-width:min(680px,calc(100vw - 16px));flex-wrap:wrap;row-gap:2px;overflow:visible} /* too wide for the window: the buttons wrap onto a second row, never hide or overlap */
.rtb[hidden]{display:none}
.rtb-b{flex:none;min-width:32px;height:32px;padding:0 7px;border:0;border-radius:9px;background:transparent;color:inherit;font:600 13px/1 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex-direction:column;gap:2px}
.rtb-b:hover{background:color-mix(in srgb,var(--text,#111) 8%,transparent)}
.rtb-b[aria-pressed=true]{box-shadow:inset 0 0 0 1px var(--accent,#0a84ff);color:var(--accent,#0a84ff)}
.rtb-b:focus-visible,.rtb-font:focus-visible,.rtb-sw:focus-visible{outline:2px solid var(--accent,#0a84ff);outline-offset:1px}
.rtb-i{font-style:italic}.rtb-u{text-decoration:underline}.rtb-s{text-decoration:line-through}.rtb-b.rtb-b{font-weight:600}.rtb-b[data-key=rtb-b]{font-weight:800}
.rtb-swatch-line{display:block;width:16px;height:3px;border-radius:2px;border:1px solid var(--hairline,rgba(0,0,0,.12))}
.rtb-sep{width:1px;height:20px;background:var(--hairline,rgba(0,0,0,.12));margin:0 3px}
.rtb-font{height:32px;max-width:116px;flex:none;border:1px solid var(--hairline,rgba(0,0,0,.12));border-radius:9px;background:var(--content,#fff);color:inherit;font:500 13px -apple-system,system-ui,sans-serif;padding:0 6px}
.rtb-pop{display:flex;align-items:center;gap:6px;padding:6px;border-radius:9px;background:var(--content,#fff);border:1px solid var(--hairline,rgba(0,0,0,.12))}
.rtb-sw{width:24px;height:24px;border-radius:50%;border:1px solid var(--hairline,rgba(0,0,0,.18));cursor:pointer;padding:0}
.rtb-sw.none{background:linear-gradient(135deg,transparent 45%,#e5484d 45%,#e5484d 55%,transparent 55%) var(--content,#fff)}
.rtb-custom input{width:28px;height:28px;border:0;padding:0;background:none;cursor:pointer}
.rtb-linkbox{position:fixed;z-index:61;display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:14px;background:var(--content,#fff);color:var(--text,#111);border:1px solid var(--hairline,rgba(0,0,0,.12));box-shadow:0 2px 6px rgba(0,0,0,.08),0 24px 64px rgba(0,0,0,.16);width:min(380px,calc(100vw - 16px))}
.rtb-linkbox-row{display:flex;gap:6px;flex-wrap:wrap}
.rtb-url{flex:1;min-width:160px;height:32px;border:1px solid var(--hairline,rgba(0,0,0,.18));border-radius:9px;padding:0 8px;font:14px -apple-system,system-ui,sans-serif;background:var(--content2,#f7f7f9);color:inherit}
.rtb-url[hidden],.rtb-font[hidden]{display:none}
.rtb-err{margin:0;font-size:12px;color:#c4262e}.rtb-err:empty{display:none}
.rtb-btn{height:32px;padding:0 12px;border-radius:9px;border:1px solid var(--slides-line,rgba(0,0,0,.13));background:var(--content,#fff);color:inherit;font:600 13px -apple-system,system-ui,sans-serif;cursor:pointer}
.rtb-btn.primary{background:var(--accent,#0a84ff);border-color:var(--accent,#0a84ff);color:#fff}
@media (pointer:coarse){.rtb-b,.rtb-font{min-width:44px;height:44px}}
@media (prefers-reduced-motion:no-preference){.rtb{transition:top .12s cubic-bezier(.32,.72,0,1),left .12s cubic-bezier(.32,.72,0,1)}}
`));
}
