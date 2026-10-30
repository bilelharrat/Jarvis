// Free-form elements on a slide (slide.free, deck-model.js normalizeFree): text boxes, shapes, lines, icons and
// pictures placed anywhere, in slide pixels (1280 × 720), drawn on top of the slide's computed layout.
// Pure: the markup and CSS (deck-render.js embeds them), the edits (deck-freeform.js applies them), the PowerPoint
// shapes (deck-pptx.js), and freeEditor, the frame-side editor deck-render.js stringifies into the sandboxed slide
// document (like its viewer). The editor runs only on the web (`progressive`) and only in edit mode.

import { SLIDE_W, SLIDE_H, PX_PER_IN, FREE_MAX, normalizeSlide } from './deck-model.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const n = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : 0); // only digits ever reach the markup

// Icon outlines on a 24-unit grid (simple geometric shapes; star/heart/bolt/cloud/smile after Material Icons, Apache-2.0).
export const ICON_PATHS = {
  star: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z',
  heart: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54z',
  bolt: 'M13 2L3 14h7l-1 8 10-12h-7z',
  sun: 'M12 7a5 5 0 100 10 5 5 0 000-10zM11 1h2v3h-2zm0 19h2v3h-2zM1 11h3v2H1zm19 0h3v2h-3zM4.22 5.64l1.42-1.42 2.12 2.12-1.42 1.42zm12.02 12.02l1.42-1.42 2.12 2.12-1.42 1.42zM4.22 18.36l2.12-2.12 1.42 1.42-2.12 2.12zM16.24 6.34l2.12-2.12 1.42 1.42-2.12 2.12z',
  moon: 'M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z',
  cloud: 'M19.35 10.04A7.49 7.49 0 0012 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 000 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z',
  smile: 'M12 2a10 10 0 100 20 10 10 0 000-20zM8.5 8a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm7 0a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM12 17.5c-2.3 0-4.3-1.4-5.1-3.5h10.2c-.8 2.1-2.8 3.5-5.1 3.5z',
  plus: 'M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z',
};
export const FREE_LABELS = { text: 'Text box', shape: 'Shape', image: 'Picture', icon: 'Icon', line: 'Line', rect: 'Rectangle', rounded: 'Rounded rectangle', ellipse: 'Ellipse', arrow: 'Arrow' };
const PPTX_ICON = { star: 'star5', heart: 'heart', bolt: 'lightningBolt', sun: 'sun', moon: 'moon', cloud: 'cloud', smile: 'smileyFace', plus: 'mathPlus' };
const PPTX_SHAPE = { rect: 'rect', rounded: 'roundRect', ellipse: 'ellipse', arrow: 'rightArrow' };

/** A free color as CSS: a theme variable, a checked hex, or transparent. */
const cssColor = (c) => (c === 'none' || !c ? 'transparent' : /^#[0-9a-f]{6}$/.test(c) ? c : `var(--${c})`);
/** A free color as PowerPoint hex (no #), or '' for none. */
export const pptxColor = (c, t) => (c === 'none' || !c ? '' : (/^#[0-9a-f]{6}$/.test(c) ? c : t.colors[c] || t.colors.text).replace('#', '').toUpperCase());

/** The arrow shape's outline in a w × h box (the canvas and the tests share it). */
export const arrowPath = (w, h) => { const head = Math.min(w * 0.45, h * 0.9); return `M0 ${n(h * 0.3)}H${n(w - head)}V0L${n(w)} ${n(h / 2)}L${n(w - head)} ${n(h)}V${n(h * 0.7)}H0Z`; };

/**
 * How a shape's own text is set: its style with the defaults filled in, the text area inside the outline (slide px,
 * relative to the shape; an ellipse and an arrow keep to their middle like PowerPoint's), and `px`, the size it is
 * drawn at: shrunk until the estimate fits unless `fit` is 'overflow'. The canvas, PDF and PowerPoint share it.
 */
export function shapeText(e) {
  const filled = !['none', 'surface', 'bg'].includes(e.fill);
  const st = { size: e.size ?? 28, bold: !!e.bold, italic: !!e.italic, align: e.align || 'center', valign: e.valign || 'middle', color: e.color || (filled ? 'bg' : 'text'), pad: e.pad ?? 12, fit: e.fit || 'shrink' };
  let l = 0, t = 0, r = 0, b = 0;
  if (e.shape === 'ellipse') { l = r = e.w * 0.146; t = b = e.h * 0.146; }
  else if (e.shape === 'arrow') { r = Math.min(e.w * 0.45, e.h * 0.9) * 0.4; t = b = e.h * 0.28; }
  st.box = { x: l + st.pad, y: t + st.pad, w: Math.max(8, e.w - l - r - 2 * st.pad), h: Math.max(8, e.h - t - b - 2 * st.pad) };
  st.px = st.fit === 'shrink' ? fitSize(e.text || '', st.size, st.box.w, st.box.h, st.bold) : st.size;
  return st;
}
/** The largest size ≤ `size` (down to 10px) at which `str`, wrapped word by word, is estimated to fit a w × h box. */
export function fitSize(str, size, w, h, bold = false) {
  const ch = bold ? 0.6 : 0.56; // average glyph width in em, a little generous
  const W = Math.max(8, w);
  const lines = (px) => String(str).split('\n').reduce((sum, para) => {
    let n = 1, at = 0;
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const ww = word.length * px * ch, gap = at ? px * 0.28 : 0;
      if (at && at + gap + ww > W) { n++; at = 0; }
      if (ww > W) { n += Math.ceil(ww / W) - 1; at = ww % W; } else at += (at ? px * 0.28 : 0) + ww;
    }
    return sum + n;
  }, 0);
  let px = size;
  while (px > 10 && lines(px) * px * 1.2 > h) px = Math.max(10, Math.round(px * 0.92 * 10) / 10);
  return px;
}
const VALIGN = { top: 'flex-start', middle: 'center', bottom: 'flex-end' };
function shapeLabel(e, edit) {
  if (!e.text && !edit) return '';
  const st = shapeText(e);
  return `<div class="fr-st${st.fit === 'overflow' ? ' fr-over' : ''}" style="left:${n(st.box.x)}px;top:${n(st.box.y)}px;width:${n(st.box.w)}px;height:${n(st.box.h)}px;justify-content:${VALIGN[st.valign]};text-align:${st.align};font-size:${n(st.px)}px;color:${cssColor(st.color)}${st.bold ? ';font-weight:700' : ''}${st.italic ? ';font-style:italic' : ''}"><div class="fr-stt">${esc(e.text || '')}</div></div>`;
}

function shapeSvg(e, svg) {
  const sw = e.stroke === 'none' ? 0 : n(e.strokeW), paint = `fill="${cssColor(e.fill)}" stroke="${cssColor(e.stroke)}" stroke-width="${sw}"`;
  if (e.shape === 'ellipse') return svg(`<ellipse cx="${n(e.w / 2)}" cy="${n(e.h / 2)}" rx="${n(Math.max(1, e.w / 2 - sw / 2))}" ry="${n(Math.max(1, e.h / 2 - sw / 2))}" ${paint}/>`);
  if (e.shape === 'arrow') return svg(`<path d="${arrowPath(e.w, e.h)}" ${paint} stroke-linejoin="round"/>`);
  const rx = e.shape === 'rounded' ? Math.min(e.w, e.h) * 0.18 : 0;
  return svg(`<rect x="${n(sw / 2)}" y="${n(sw / 2)}" width="${n(Math.max(1, e.w - sw))}" height="${n(Math.max(1, e.h - sw))}" rx="${n(rx)}" ${paint}/>`);
}
function inner(e, src, edit = false) {
  const svg = (body, vb = `0 0 ${n(e.w)} ${n(e.h)}`) => `<svg viewBox="${vb}" preserveAspectRatio="none" aria-hidden="true" focusable="false">${body}</svg>`;
  if (e.type === 'text') return `<div class="fr-t" style="font-size:${n(e.size)}px;text-align:${e.align === 'center' || e.align === 'right' ? e.align : 'left'};color:${cssColor(e.color)};background:${cssColor(e.fill)}${e.bold ? ';font-weight:700' : ''}${e.italic ? ';font-style:italic' : ''}">${esc(e.text)}</div>`;
  if (e.type === 'shape') return shapeSvg(e, svg) + shapeLabel(e, edit);
  if (e.type === 'line') {
    const ah = e.arrow ? e.strokeW * 3 + 6 : 0, y = e.h / 2, c = cssColor(e.stroke);
    return svg(`<line x1="0" y1="${n(y)}" x2="${n(e.w - ah * 0.8)}" y2="${n(y)}" stroke="${c}" stroke-width="${n(e.strokeW)}" stroke-linecap="round"/>${e.arrow ? `<polygon points="${n(e.w)},${n(y)} ${n(e.w - ah)},${n(y - ah * 0.6)} ${n(e.w - ah)},${n(y + ah * 0.6)}" fill="${c}"/>` : ''}`);
  }
  if (e.type === 'icon') return svg(`<path d="${ICON_PATHS[e.icon] || ICON_PATHS.star}" fill="${cssColor(e.fill)}" fill-rule="evenodd"/>`, '0 0 24 24');
  const data = src(e.image);
  return data ? `<img src="${data}" alt="${esc(e.alt)}" draggable="false">` : `<div class="fr-noimg" role="img" aria-label="${esc(e.alt || 'Picture')}"></div>`;
}

/**
 * The free layer of a slide: after the layout's content in reading order, on top of it on screen. In edit mode the
 * layer is always there (so pictures can be pasted into an empty slide) and carries the elements as JSON for the editor.
 * `src(id)` → a checked data URL or ''.
 */
export function freeHtml(s, { edit = false, src = () => '' } = {}) {
  const list = Array.isArray(s.free) ? s.free : [];
  if (!list.length && !edit) return '';
  const els = list.map((e) => `<div class="fr-el fr-${e.type}" data-fid="${esc(e.id)}" style="left:${n(e.x)}px;top:${n(e.y)}px;width:${n(e.w)}px;height:${n(e.h)}px;z-index:${n(e.z) + 1}${e.rot ? `;transform:rotate(${n(e.rot)}deg)` : ''}${e.opacity < 1 ? `;opacity:${n(e.opacity)}` : ''}"${e.type === 'text' || e.type === 'image' || (e.type === 'shape' && e.text) ? '' : ' aria-hidden="true"'}>${inner(e, src, edit)}</div>`).join('');
  return `<div class="free"${edit ? ` data-free="${esc(JSON.stringify(list))}"` : ''}>${els}</div>`;
}

export const FREE_CSS = `
.free{position:absolute;inset:0;z-index:3;pointer-events:none}
.fr-el{position:absolute;pointer-events:auto;transform-origin:50% 50%;box-sizing:border-box}
.fr-el svg{display:block;width:100%;height:100%;overflow:visible}
.fr-el img{display:block;width:100%;height:100%;object-fit:cover}
.fr-noimg{width:100%;height:100%;background:repeating-linear-gradient(45deg,color-mix(in srgb,var(--muted) 18%,transparent) 0 10px,transparent 10px 20px);border:2px dashed var(--muted)}
.fr-st{position:absolute;display:flex;flex-direction:column;overflow:visible;white-space:pre-wrap;overflow-wrap:break-word;line-height:1.2;font-family:var(--bf);pointer-events:none}
.fr-stt{flex:none;min-height:1.2em;outline:none} /* its own height, so text that runs over keeps its alignment */
.mode-edit #frame .fr-stt.fr-tx{pointer-events:auto}
.fr-t{width:100%;min-height:100%;white-space:pre-wrap;overflow-wrap:break-word;line-height:1.2;font-family:var(--bf);padding:4px 6px;box-sizing:border-box;outline:none}
.mode-edit #frame .fr-el{cursor:move;touch-action:none}
.mode-edit #frame .fr-el:focus{outline:none}
.mode-edit #frame .fr-el:focus-visible,.mode-edit #frame .fr-el.fr-on{outline:calc(2px / var(--s)) solid #2f6df6;outline-offset:calc(2px / var(--s));box-shadow:0 0 0 calc(4px / var(--s)) rgba(255,255,255,.7)}
.mode-edit #frame .fr-tx{cursor:text;outline:calc(2px / var(--s)) dashed #2f6df6}
.fr-box{position:absolute;pointer-events:none;transform-origin:50% 50%;z-index:1000}
.fr-h,.fr-rot{position:absolute;width:calc(14px / var(--s));height:calc(14px / var(--s));margin:calc(-7px / var(--s)) 0 0 calc(-7px / var(--s));background:#fff;border:calc(2px / var(--s)) solid #2f6df6;border-radius:50%;pointer-events:auto;box-sizing:border-box;touch-action:none}
.fr-h[data-c=nw]{left:0;top:0;cursor:nwse-resize}.fr-h[data-c=ne]{left:100%;top:0;cursor:nesw-resize}.fr-h[data-c=sw]{left:0;top:100%;cursor:nesw-resize}.fr-h[data-c=se]{left:100%;top:100%;cursor:nwse-resize}
.fr-rot{left:50%;top:calc(-30px / var(--s));cursor:grab;background:#2f6df6}
.fr-guide{position:absolute;background:#ff2d75;pointer-events:none;z-index:1001}
.fr-guide.v{top:-2000px;bottom:-2000px;width:calc(1px / var(--s))}.fr-guide.h{left:-2000px;right:-2000px;height:calc(1px / var(--s))}
.mode-present .fr-box,.mode-present .fr-guide{display:none}
`;

// ── edits (the page applies them; each is a new version) ──

const clone = (d) => JSON.parse(JSON.stringify(d));
let seq = 0;
export const freeId = () => `f${Date.now().toString(36).slice(-6)}${(seq++ % 1296).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** The deck with slide i's free elements replaced by `list` (cleaned); the deck itself when nothing is usable. */
export function setFree(deck, i, list) {
  if (!deck.slides[i] || !Array.isArray(list)) return deck;
  const d = clone(deck);
  const s = { ...d.slides[i], free: list };
  const again = normalizeSlide(s);
  if (!again) return deck;
  d.slides[i] = again;
  return d;
}
/** Elements added on top of slide i (new ids; at most FREE_MAX on a slide). → { deck, ids } */
export function addFree(deck, i, items, { offset = 0 } = {}) {
  const s = deck.slides[i];
  if (!s || !Array.isArray(items)) return { deck, ids: [] };
  const have = s.free || [];
  const room = Math.max(0, FREE_MAX - have.length);
  const added = items.slice(0, room).map((e, k) => ({ ...e, id: freeId(), x: (Number(e.x) || 0) + offset, y: (Number(e.y) || 0) + offset, z: have.length + k }));
  if (!added.length) return { deck, ids: [] };
  const next = setFree(deck, i, [...have, ...added]);
  const kept = new Set((next.slides[i].free || []).map((e) => e.id));
  return { deck: next, ids: added.map((e) => e.id).filter((id) => kept.has(id)) };
}
/** Style changes on the given elements: { fill, stroke, strokeW, color, size, bold, italic, align, valign, pad, fit, opacity }. */
export function styleFree(deck, i, ids, patch) {
  const s = deck.slides[i];
  if (!s || !s.free) return deck;
  const pick = new Set(ids);
  const keys = ['fill', 'stroke', 'strokeW', 'color', 'size', 'bold', 'italic', 'align', 'valign', 'pad', 'fit', 'opacity', 'arrow'];
  const p = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => keys.includes(k)));
  return setFree(deck, i, s.free.map((e) => (pick.has(e.id) ? { ...e, ...p } : e)));
}
/** Layer order: 'forward' | 'back' | 'front' | 'bottom' for the given elements. */
export function arrangeFree(deck, i, ids, how) {
  const s = deck.slides[i];
  if (!s || !s.free) return deck;
  const pick = new Set(ids);
  let list = s.free.slice();
  if (how === 'front' || how === 'bottom') {
    const mine = list.filter((e) => pick.has(e.id)), rest = list.filter((e) => !pick.has(e.id));
    list = how === 'front' ? [...rest, ...mine] : [...mine, ...rest];
  } else if (how === 'forward') {
    for (let k = list.length - 2; k >= 0; k--) if (pick.has(list[k].id) && !pick.has(list[k + 1].id)) [list[k], list[k + 1]] = [list[k + 1], list[k]];
  } else if (how === 'back') {
    for (let k = 1; k < list.length; k++) if (pick.has(list[k].id) && !pick.has(list[k - 1].id)) [list[k], list[k - 1]] = [list[k - 1], list[k]];
  } else return deck;
  return setFree(deck, i, list.map((e, z) => ({ ...e, z })));
}
export function removeFree(deck, i, ids) {
  const s = deck.slides[i];
  if (!s || !s.free) return deck;
  const pick = new Set(ids);
  const d = setFree(deck, i, s.free.filter((e) => !pick.has(e.id)));
  if (d.slides[i].free && !d.slides[i].free.length) delete d.slides[i].free;
  return d;
}

/** A new element of a kind ('text', 'rect', 'rounded', 'ellipse', 'arrow', 'line', 'icon:<name>'), near the middle. */
export function newFree(kind, k = 0) {
  const o = (k % 6) * 24;
  if (kind === 'text') return { type: 'text', text: 'Your text', x: 400 + o, y: 315 + o, w: 480, h: 90, size: 40, align: 'center', color: 'text', fill: 'none' };
  if (kind === 'line') return { type: 'line', x: 480 + o, y: 348 + o, w: 320, h: 24, stroke: 'text', strokeW: 4 };
  if (kind === 'arrow') return { type: 'shape', shape: 'arrow', x: 510 + o, y: 300 + o, w: 260, h: 120, fill: 'accent', stroke: 'none' };
  if (/^icon:/.test(kind)) return { type: 'icon', icon: kind.slice(5), x: 580 + o, y: 300 + o, w: 120, h: 120, fill: 'accent' };
  if (['rect', 'rounded', 'ellipse'].includes(kind)) return { type: 'shape', shape: kind, x: 520 + o, y: 280 + o, w: 240, h: 160, fill: 'accent', stroke: 'none' };
  return null;
}
/** A picture element sized to its aspect ratio, at most 480 × 360, centred. */
export function newFreeImage(id, alt, w = 0, h = 0, k = 0) {
  const r = w > 0 && h > 0 ? w / h : 4 / 3;
  const W = r >= 4 / 3 ? 480 : Math.round(360 * r), H = Math.round(W / r);
  const o = (k % 6) * 24;
  return { type: 'image', image: id, alt, x: Math.round((SLIDE_W - W) / 2) + o, y: Math.round((SLIDE_H - H) / 2) + o, w: W, h: H };
}

// ── PowerPoint: positioned native shapes, text boxes and pictures, in z-order, with rotation ──

const IN = (px) => Math.round((px / PX_PER_IN) * 1000) / 1000;
const PT = (px) => Math.round(px * 0.75 * 10) / 10;
/** Adds slide `s`'s free elements to a PptxGenJS slide (drawn last, so above the layout). `image(id)` → data URL or ''. */
export function freePptx(pres, slide, s, { theme, image = () => '' }) {
  const t = theme;
  for (const e of s.free || []) {
    const pos = { x: IN(e.x), y: IN(e.y), w: IN(e.w), h: IN(e.h), ...(e.rot ? { rotate: Math.round(((e.rot % 360) + 360) % 360) % 360 } : {}) };
    const tr = e.opacity < 1 ? Math.round((1 - e.opacity) * 100) : 0;
    const fill = (c) => { const hx = pptxColor(c, t); return hx ? { fill: { color: hx, ...(tr ? { transparency: tr } : {}) } } : {}; };
    const line = (c, wpx) => { const hx = pptxColor(c, t); return hx && wpx > 0 ? { line: { color: hx, width: PT(wpx), ...(tr ? { transparency: tr } : {}) } } : { line: { type: 'none' } }; };
    if (e.type === 'text') {
      slide.addText(e.text, { ...pos, ...fill(e.fill), fontFace: t.body.pptx, fontSize: PT(e.size), bold: !!e.bold, italic: !!e.italic, align: e.align || 'left', color: pptxColor(e.color, t) || pptxColor('text', t), valign: 'top', margin: PT(5), ...(tr ? { transparency: tr } : {}) });
    } else if (e.type === 'shape') {
      const look = { ...pos, ...fill(e.fill), ...line(e.stroke, e.strokeW), ...(e.shape === 'rounded' ? { rectRadius: Math.min(e.w, e.h) * 0.18 / PX_PER_IN } : {}) };
      if (e.text) { // one shape with its own text body (PowerPoint keeps an ellipse's or arrow's text in its middle itself)
        const st = shapeText(e);
        slide.addText(e.text, { ...look, shape: PPTX_SHAPE[e.shape] || 'rect', fontFace: t.body.pptx, fontSize: PT(st.px), bold: st.bold, italic: st.italic, align: st.align, valign: st.valign, color: pptxColor(st.color, t) || pptxColor('text', t), margin: PT(st.pad), ...(tr ? { transparency: tr } : {}) });
      } else slide.addShape(PPTX_SHAPE[e.shape] || 'rect', look);
    } else if (e.type === 'icon') {
      slide.addShape(PPTX_ICON[e.icon] || 'star5', { ...pos, ...fill(e.fill), line: { type: 'none' } });
    } else if (e.type === 'line') {
      const hx = pptxColor(e.stroke, t);
      slide.addShape('line', { ...pos, y: IN(e.y + e.h / 2), h: 0, line: { color: hx, width: PT(e.strokeW), ...(tr ? { transparency: tr } : {}), ...(e.arrow ? { endArrowType: 'triangle' } : {}) } });
    } else if (e.type === 'image') {
      const data = image(e.image);
      if (data) slide.addImage({ data: data.replace(/^data:/, ''), ...pos, altText: e.alt || '', ...(tr ? { transparency: tr } : {}) });
    }
  }
}

/* The editor inside the slide document (stringified by deck-render.js; never runs in Eden's page). */
export function freeEditor(cfg) {
  'use strict';
  if (!cfg.progressive) return;
  const body = document.body;
  const post = (m) => { if (cfg.embedded && window.parent !== window) window.parent.postMessage(m, '*'); };
  const editing = () => body.classList.contains('mode-edit') && !body.classList.contains('overview');
  const NAME = { text: 'text box', shape: 'shape', image: 'picture', icon: 'icon', line: 'line' };
  const SHAPE = { rect: 'rectangle', rounded: 'rounded rectangle', ellipse: 'ellipse', arrow: 'arrow' };
  const live = (s) => { const l = document.getElementById('live'); if (l) l.textContent = s; };
  const models = new Map();
  const model = (ly) => { if (!models.has(ly)) { let v = []; try { v = JSON.parse(ly.dataset.free); } catch { /* none */ } models.set(ly, Array.isArray(v) ? v : []); } return models.get(ly); };
  const slideOf = (ly) => ly.closest('.slide');
  const indexOf = (ly) => Number(slideOf(ly).dataset.index);
  const layerOf = (sl) => (sl ? sl.querySelector(':scope > .free[data-free]') : null);
  const curSlide = () => document.querySelector('#frame > .slide.cur');
  const isEl = (t) => !!(t && t.matches && t.matches('#frame > .slide > .free > .fr-el'));
  let layer = null, sel = [], k = 1, endGesture = null;
  const elOf = (id, ly = layer) => (ly ? [...ly.children].find((e) => e.dataset.fid === id) : null);
  const item = (id, ly = layer) => (ly ? model(ly).find((e) => e.id === id) : null);
  const round = (v) => Math.round(v * 10) / 10;
  const hint = document.createElement('p');
  hint.id = 'fr-hint'; hint.className = 'sr-only';
  hint.textContent = 'Arrow keys move it, with Shift 10 pixels. Enter edits its text (a shape too). Delete removes. Control or Command D duplicates; square brackets change the layer order.';
  body.append(hint);
  const describe = (el, it) => {
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-roledescription', NAME[it.type] || 'element');
    el.setAttribute('aria-label', it.type === 'text' ? it.text.slice(0, 120) : it.type === 'image' ? (it.alt || 'picture') : it.type === 'shape' ? `${SHAPE[it.shape] || 'shape'}${it.text ? `: ${it.text.slice(0, 120)}` : ''}` : it.type === 'icon' ? `${it.icon} icon` : it.arrow ? 'arrow line' : 'line');
    el.setAttribute('aria-describedby', 'fr-hint');
    el.removeAttribute('aria-hidden');
  };
  for (const ly of document.querySelectorAll('#frame > .slide > .free[data-free]')) for (const el of ly.children) { const it = item(el.dataset.fid, ly); if (it) describe(el, it); }
  // copies of the slide (thumbnails, overview, presenter view) are pictures only
  new MutationObserver((recs) => {
    for (const r of recs) for (const nd of r.addedNodes) {
      if (!nd.querySelectorAll) continue;
      nd.querySelectorAll('.fr-el[tabindex],.fr-box,.fr-guide,.fr-on').forEach((e) => {
        if (e.closest('#frame')) return;
        if (e.classList.contains('fr-box') || e.classList.contains('fr-guide')) e.remove();
        else { e.removeAttribute('tabindex'); e.removeAttribute('role'); e.classList.remove('fr-on'); e.setAttribute('aria-hidden', 'true'); }
      });
    }
  }).observe(body, { childList: true, subtree: true });
  // leaving the slide (or edit mode) drops the selection
  new MutationObserver(() => { if (layer && (!slideOf(layer).classList.contains('cur') || !editing())) select([], null); }).observe(body, { attributes: true, subtree: true, attributeFilter: ['class'] });

  function place(el, it) {
    el.style.left = `${it.x}px`; el.style.top = `${it.y}px`; el.style.width = `${it.w}px`; el.style.height = `${it.h}px`;
    el.style.transform = it.rot ? `rotate(${it.rot}deg)` : '';
  }
  function handles() {
    document.querySelectorAll('#frame .fr-box').forEach((b) => b.remove());
    if (sel.length !== 1 || !layer) return;
    const it = item(sel[0]);
    if (!it) return;
    const box = document.createElement('div');
    box.className = 'fr-box';
    box.setAttribute('aria-hidden', 'true');
    for (const c of ['nw', 'ne', 'sw', 'se']) { const h = document.createElement('div'); h.className = 'fr-h'; h.dataset.c = c; box.append(h); }
    const r = document.createElement('div'); r.className = 'fr-rot'; box.append(r);
    place(box, it);
    layer.append(box);
  }
  function select(ids, ly, { focus = false, quiet = false } = {}) {
    document.querySelectorAll('#frame .fr-on').forEach((e) => e.classList.remove('fr-on'));
    const was = sel.join();
    layer = ly;
    sel = ly ? [...new Set(ids)].filter((id) => item(id, ly)) : [];
    for (const id of sel) elOf(id).classList.add('fr-on');
    handles();
    if (focus && sel.length) elOf(sel.at(-1)).focus({ preventScroll: true });
    if (sel.join() !== was) {
      if (sel.length > 1) live(`${sel.length} selected`);
      if (!quiet) post({ type: 'deck-free-sel', index: ly ? indexOf(ly) : -1, ids: sel });
    }
  }
  function save({ focus = true } = {}) {
    clearTimeout(save.t);
    if (!layer) return;
    const a = document.activeElement;
    post({ type: 'deck-free', index: indexOf(layer), free: model(layer), sel, focus: focus && !!a && (isEl(a) || a === body || a === document.documentElement) });
  }
  const later = () => { clearTimeout(save.t); save.t = setTimeout(save, 650); }; // nudges: one version after the keys stop

  // ── pointer: select, move, resize, rotate, with snapping ──
  function pt(e) { const r = slideOf(layer).getBoundingClientRect(); k = r.width / 1280 || 1; return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k }; }
  function bbox(it) {
    const a = ((it.rot || 0) * Math.PI) / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    const W = it.w * c + it.h * s, H = it.w * s + it.h * c, cx = it.x + it.w / 2, cy = it.y + it.h / 2;
    return { l: cx - W / 2, r: cx + W / 2, t: cy - H / 2, b: cy + H / 2, cx, cy };
  }
  function guides(lines) {
    layer.querySelectorAll('.fr-guide').forEach((g) => g.remove());
    for (const g of lines) { const d = document.createElement('div'); d.className = `fr-guide ${g.v ? 'v' : 'h'}`; d.style[g.v ? 'left' : 'top'] = `${g.at}px`; layer.append(d); }
  }
  function drag(start, dx, dy, loose) {
    const moved = start.map((s) => ({ ...s, x: s.x + dx, y: s.y + dy }));
    let sx = 0, sy = 0;
    const lines = [];
    if (!loose) {
      const bs = moved.map(bbox);
      const b = { l: Math.min(...bs.map((q) => q.l)), r: Math.max(...bs.map((q) => q.r)), t: Math.min(...bs.map((q) => q.t)), b: Math.max(...bs.map((q) => q.b)) };
      b.cx = (b.l + b.r) / 2; b.cy = (b.t + b.b) / 2;
      const others = model(layer).filter((it) => !sel.includes(it.id)).map(bbox);
      const ex = typeof window.edenSnap === 'function' ? window.edenSnap() : { x: [], y: [] }; // the editor's guides and snap grid (deck-arrange-frame.js)
      const X = [0, 640, 1280, ...others.flatMap((o) => [o.l, o.cx, o.r]), ...ex.x], Y = [0, 360, 720, ...others.flatMap((o) => [o.t, o.cy, o.b]), ...ex.y];
      const snap = Math.max(7 / k, ex.r || 0); // (a snap grid always pulls: half a cell)
      const best = (vals, targets) => { let d = null; for (const v of vals) for (const t of targets) { const dd = t - v; if (Math.abs(dd) <= snap && (!d || Math.abs(dd) < Math.abs(d.d))) d = { d: dd, at: t }; } return d; };
      const bx = best([b.l, b.cx, b.r], X), by = best([b.t, b.cy, b.b], Y);
      if (bx) { sx = bx.d; lines.push({ v: true, at: bx.at }); }
      if (by) { sy = by.d; lines.push({ v: false, at: by.at }); }
    }
    for (const m of moved) { const it = item(m.id); it.x = round(m.x + sx); it.y = round(m.y + sy); }
    guides(lines);
  }
  function resize(s, c, p, keep) {
    const it = item(s.id);
    const a = ((s.rot || 0) * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    const sx = c.includes('e') ? 1 : -1, sy = c.includes('s') ? 1 : -1;
    const cx = s.x + s.w / 2, cy = s.y + s.h / 2, ox = (-sx * s.w) / 2, oy = (-sy * s.h) / 2;
    const fx = cx + ox * cos - oy * sin, fy = cy + ox * sin + oy * cos; // the corner that stays put
    const vx = p.x - fx, vy = p.y - fy;
    let w = Math.max(8, sx * (vx * cos + vy * sin)), h = Math.max(it.type === 'line' ? 2 : 8, sy * (-vx * sin + vy * cos));
    if (keep || it.type === 'image' || it.type === 'icon') { const q = Math.max(w / s.w, h / s.h); w = Math.max(8, s.w * q); h = Math.max(8, s.h * q); }
    const ncx = fx + ((sx * w) / 2) * cos - ((sy * h) / 2) * sin, ncy = fy + ((sx * w) / 2) * sin + ((sy * h) / 2) * cos;
    it.w = round(w); it.h = round(h); it.x = round(ncx - w / 2); it.y = round(ncy - h / 2);
  }
  function rotate(s, p, steps) {
    const it = item(s.id), cx = s.x + s.w / 2, cy = s.y + s.h / 2;
    let deg = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI + 90;
    if (steps) deg = Math.round(deg / 15) * 15; else { const q = Math.round(deg / 90) * 90; if (Math.abs(deg - q) < 4) deg = q; }
    deg = (((deg % 360) + 540) % 360) - 180;
    it.rot = round(deg);
    if (!it.rot) delete it.rot;
  }
  addEventListener('pointerdown', (e) => {
    if (!editing() || e.button !== 0) return;
    const t = e.target;
    if (!t.closest || t.closest('[contenteditable="true"],[contenteditable="plaintext-only"]')) return;
    const h = t.closest('#frame .fr-h, #frame .fr-rot');
    const el = t.closest('#frame > .slide > .free > .fr-el');
    if (!h && !el) { if (sel.length && t.closest('#frame')) select([], null); return; }
    e.preventDefault(); e.stopPropagation(); // not a swipe, not a text edit underneath
    const ly = (h || el).closest('.free');
    if (el) {
      const id = el.dataset.fid;
      if (e.shiftKey) { select(sel.includes(id) && layer === ly ? sel.filter((x) => x !== id) : [...(layer === ly ? sel : []), id], ly); if (!sel.includes(id)) return; }
      else if (!sel.includes(id) || layer !== ly) select([id], ly);
      el.focus({ preventScroll: true });
    }
    const kind = h ? (h.classList.contains('fr-rot') ? 'rot' : h.dataset.c) : 'move';
    const p0 = pt(e), start = sel.map((id) => ({ ...item(id) }));
    const grab = h || el;
    try { grab.setPointerCapture(e.pointerId); } catch { /* old browser */ }
    let moved = false, done = false;
    const move = (ev) => {
      if (ev.buttons === 0) { up(); return; } // the button came up outside the frame
      const p = pt(ev);
      if (!moved && Math.hypot(p.x - p0.x, p.y - p0.y) * k < 3) return;
      moved = true;
      if (kind === 'move') drag(start, p.x - p0.x, p.y - p0.y, ev.altKey);
      else if (kind === 'rot') rotate(start[0], p, ev.shiftKey);
      else resize(start[0], kind, p, ev.shiftKey);
      for (const id of sel) place(elOf(id), item(id));
      const b = layer.querySelector('.fr-box');
      if (b && sel.length === 1) place(b, item(sel[0]));
    };
    const up = () => {
      if (done) return;
      done = true; endGesture = null;
      removeEventListener('pointermove', move, true); removeEventListener('pointerup', up, true); removeEventListener('pointercancel', up, true); removeEventListener('blur', up);
      grab.removeEventListener('lostpointercapture', up);
      if (layer) guides([]);
      if (moved) save();
    };
    addEventListener('pointermove', move, true); addEventListener('pointerup', up, true); addEventListener('pointercancel', up, true); addEventListener('blur', up);
    grab.addEventListener('lostpointercapture', up); // the drag ends wherever the pointer is let go, even outside the frame
    endGesture = up; // (and the page says when the button comes up over it: deck-free-up)
  }, true);
  addEventListener('click', (e) => { if (editing() && e.target.closest && e.target.closest('#frame .fr-el, #frame .fr-box')) e.stopPropagation(); }, true);
  addEventListener('dblclick', (e) => { const el = editing() && e.target.closest && e.target.closest('#frame > .slide > .free > .fr-text, #frame > .slide > .free > .fr-shape'); if (el) { e.stopPropagation(); beginText(el); } }, true);
  addEventListener('focusin', (e) => {
    const el = e.target;
    if (!editing() || !isEl(el)) return;
    const ly = el.parentElement;
    if (!sel.includes(el.dataset.fid) || layer !== ly) select([el.dataset.fid], ly);
  });

  // ── typing in a text box ──
  function beginText(el) {
    const it = item(el.dataset.fid, el.parentElement);
    if (!it || (it.type !== 'text' && it.type !== 'shape')) return;
    if (layer !== el.parentElement || !sel.includes(it.id)) select([it.id], el.parentElement);
    const tx = el.querySelector(it.type === 'shape' ? '.fr-stt' : '.fr-t');
    if (!tx) return;
    tx.dataset.was = tx.textContent;
    tx.classList.add('fr-tx');
    try { tx.contentEditable = 'plaintext-only'; } catch { tx.contentEditable = 'true'; }
    if (!tx.isContentEditable) tx.contentEditable = 'true';
    tx.setAttribute('role', 'textbox'); tx.setAttribute('aria-multiline', 'true'); tx.setAttribute('aria-label', it.type === 'shape' ? 'Text in the shape' : 'Text box');
    tx.focus();
    const r = document.createRange(); r.selectNodeContents(tx); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  function endText(tx, keep) {
    if (!tx.classList.contains('fr-tx')) return;
    tx.classList.remove('fr-tx');
    tx.contentEditable = 'false';
    tx.removeAttribute('role');
    const el = tx.closest('.fr-el'), ly = el.parentElement, it = item(el.dataset.fid, ly);
    const was = tx.dataset.was; delete tx.dataset.was;
    if (!keep || !it) { tx.textContent = was; el.focus(); return; }
    const v = tx.innerText.replace(/\r/g, '').replace(/\n+$/, '');
    if (v === (it.text || '')) { el.focus(); return; }
    layer = ly;
    if (it.type === 'shape') { // a shape keeps its outline when its text is cleared
      if (v.trim()) it.text = v.slice(0, 300); else delete it.text;
      describe(el, it);
      el.focus();
      save();
      return;
    }
    if (!v.trim()) { models.set(ly, model(ly).filter((x) => x !== it)); el.remove(); sel = []; handles(); save({ focus: false }); return; }
    it.text = v.slice(0, 600);
    el.setAttribute('aria-label', it.text.slice(0, 120));
    el.focus();
    save();
  }
  document.addEventListener('focusout', (e) => { if (e.target.classList && e.target.classList.contains('fr-tx')) endText(e.target, true); }, true);
  addEventListener('paste', (e) => {
    const tx = e.target.closest && e.target.closest('.fr-tx');
    if (!tx) return;
    e.preventDefault(); e.stopPropagation();
    document.execCommand('insertText', false, ((e.clipboardData && e.clipboardData.getData('text/plain')) || '').slice(0, 600));
  }, true);

  // ── keys ──
  function reorder(how) {
    const list = model(layer), pick = new Set(sel);
    let out = list.slice();
    if (how === 'front' || how === 'bottom') { const mine = out.filter((e) => pick.has(e.id)), rest = out.filter((e) => !pick.has(e.id)); out = how === 'front' ? [...rest, ...mine] : [...mine, ...rest]; }
    else if (how === 'forward') { for (let i = out.length - 2; i >= 0; i--) if (pick.has(out[i].id) && !pick.has(out[i + 1].id)) [out[i], out[i + 1]] = [out[i + 1], out[i]]; }
    else for (let i = 1; i < out.length; i++) if (pick.has(out[i].id) && !pick.has(out[i - 1].id)) [out[i], out[i - 1]] = [out[i - 1], out[i]];
    out.forEach((e, z) => { e.z = z; elOf(e.id).style.zIndex = String(z + 1); layer.insertBefore(elOf(e.id), layer.querySelector('.fr-box')); }); // the DOM (and Tab) follows the layers
    models.set(layer, out);
    elOf(sel.at(-1)).focus({ preventScroll: true });
    live(how === 'forward' || how === 'front' ? 'Brought forward' : 'Sent back');
    save();
  }
  function duplicate() {
    const list = model(layer);
    if (list.length + sel.length > 40) { live('This slide holds at most 40 elements'); return; }
    const ids = [];
    for (const id of sel) {
      const it = item(id), c = { ...it, id: `${it.id.slice(0, 15)}c${Date.now().toString(36).slice(-4)}${ids.length}`, x: it.x + 20, y: it.y + 20, z: list.length };
      list.push(c); ids.push(c.id);
    }
    sel = ids;
    save();
  }
  addEventListener('keydown', (e) => {
    if (!editing()) return;
    const t = e.target;
    if (t.classList && t.classList.contains('fr-tx')) { // typing: only Escape / ⌘↩ leave; nothing reaches the slide keys
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); endText(t, false); }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); endText(t, true); }
      return;
    }
    const mod = e.metaKey || e.ctrlKey, key = e.key;
    if (mod && (key === 'v' || key === 'V') && !e.shiftKey && !(t.closest && t.closest('[contenteditable="true"],[contenteditable="plaintext-only"],input,textarea,select,button,summary,#strip'))) {
      const ly = layerOf(curSlide());
      if (ly) { e.preventDefault(); e.stopPropagation(); post({ type: 'deck-free-paste', index: indexOf(ly) }); }
      return;
    }
    if (!isEl(t) || !sel.length || t.parentElement !== layer) return;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key];
    if (nudge && !mod && !e.altKey) {
      stop();
      const d = e.shiftKey ? 10 : 1;
      for (const id of sel) { const it = item(id); it.x = round(it.x + nudge[0] * d); it.y = round(it.y + nudge[1] * d); place(elOf(id), it); }
      handles(); later();
      return;
    }
    if (key === 'Delete' || key === 'Backspace') {
      stop();
      const pick = new Set(sel);
      models.set(layer, model(layer).filter((it) => !pick.has(it.id)));
      for (const id of sel) elOf(id).remove();
      live(sel.length > 1 ? `${sel.length} elements deleted` : 'Deleted');
      sel = []; handles(); save({ focus: false });
      body.focus();
      return;
    }
    if ((key === 'Enter' || key === 'F2') && !mod) { stop(); if (sel.length === 1 && (t.classList.contains('fr-text') || t.classList.contains('fr-shape'))) beginText(t); return; }
    if (key === 'Escape') { stop(); select([], null); body.focus(); return; }
    if (mod && (key === 'c' || key === 'C' || key === 'x' || key === 'X')) {
      stop();
      post({ type: 'deck-free-copy', items: sel.map((id) => item(id)) });
      live('Copied');
      if (key === 'x' || key === 'X') { const pick = new Set(sel); models.set(layer, model(layer).filter((it) => !pick.has(it.id))); for (const id of sel) elOf(id).remove(); sel = []; handles(); save({ focus: false }); body.focus(); }
      return;
    }
    if (mod && (key === 'd' || key === 'D')) { stop(); duplicate(); return; }
    if (mod && (key === 'a' || key === 'A')) { stop(); select(model(layer).map((it) => it.id), layer, { focus: true }); return; }
    if (key === ']' || key === '}' || key === '[' || key === '{') { stop(); const up = key === ']' || key === '}'; reorder(e.shiftKey || (mod && e.altKey) ? (up ? 'front' : 'bottom') : (up ? 'forward' : 'back')); return; }
    if (mod) return; // ⌘Z and the rest go on to the slide keys
    if (key === 'Tab') return;
    if (/^[0-9a-z ]$/i.test(key) || key === 'Home' || key === 'End' || key.startsWith('Page')) e.stopPropagation(); // don't jump slides from an element
  }, true);

  // ── the page: restore the selection after a redraw ──
  addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const m = e.data || {};
    if (m.type === 'deck-free-up') { if (endGesture) endGesture(); return; }
    if (m.type !== 'deck-free-select' || !Array.isArray(m.ids)) return;
    const sl = [...document.querySelectorAll('#frame > .slide')].find((s) => Number(s.dataset.index) === m.index && s.dataset.part === '1');
    const ly = layerOf(sl);
    if (!ly || !sl.classList.contains('cur')) return;
    select(m.ids.filter((id) => typeof id === 'string'), ly, { focus: m.focus === true, quiet: true });
  });
}
