// AI photo tools for slide pictures, the pure part (deck-photo-tools.js draws the dialog): a plain-background
// remover, a brush-and-fill eraser, an aspect-ratio expander, and reading text out of a picture into a slide.
// Pictures here are ImageData-shaped { width, height, data: Uint8ClampedArray RGBA }, so Node tests run them.
//
// Everything in this file runs on the device. When the person picks the AI version of a tool, deck-photo-tools.js
// sends the picture (after they confirm, naming the service) and this file finishes the job locally: the AI
// result is pasted back only where the person asked for a change, so the rest of the picture stays theirs.

import { LIMITS, normalizeSlide, setImage } from './deck-model.js';
import { imageData } from './deck-render.js';

export const RATIOS = [['16:9', 16 / 9], ['4:3', 4 / 3], ['1:1', 1], ['3:4', 3 / 4], ['9:16', 9 / 16]];

const blank = (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) });
const copyOf = (img) => ({ width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) });
const dist = (d, i, r, g, b) => { const dr = d[i] - r, dg = d[i + 1] - g, db = d[i + 2] - b; return Math.sqrt(0.3 * dr * dr + 0.59 * dg * dg + 0.11 * db * db); };
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

/** The colour along the picture's edge (per-channel median of the border pixels that aren't already clear). */
export function edgeColor(img) {
  const { width: w, height: h, data: d } = img;
  const r = [], g = [], b = [];
  const take = (x, y) => { const i = (y * w + x) * 4; if (d[i + 3] > 16) { r.push(d[i]); g.push(d[i + 1]); b.push(d[i + 2]); } };
  for (let x = 0; x < w; x++) { take(x, 0); take(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { take(0, y); take(w - 1, y); }
  return [median(r), median(g), median(b)];
}

/**
 * Remove a plain background: flood from the edges through pixels close to the edge colour; those become clear,
 * and the subject's rim fades a little so it doesn't look cut out with scissors. Works for studio shots, logos,
 * screenshots and the AI path's flat green backdrop; a busy photo needs the AI path.
 * Returns { img, removed } (the share of the picture made clear, 0–1).
 */
export function removePlainBackground(img, { tolerance = 30 } = {}) {
  const { width: w, height: h } = img;
  const out = copyOf(img);
  const d = out.data;
  const [r, g, b] = edgeColor(img);
  const bg = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  const near = (p) => d[p * 4 + 3] <= 16 || dist(d, p * 4, r, g, b) <= tolerance;
  const seed = (p) => { if (!bg[p] && near(p)) { bg[p] = 1; queue[tail++] = p; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  // a busy edge (a street, a crowd) is no plain background: clearing its look-alike specks would only make holes
  if (tail < (w + h) * 2 * 0.5) return { img: out, removed: 0, mask: new Uint8Array(w * h), busy: true };
  while (head < tail) {
    const p = queue[head++];
    const x = p % w, y = (p - x) / w;
    if (x > 0) seed(p - 1);
    if (x < w - 1) seed(p + 1);
    if (y > 0) seed(p - w);
    if (y < h - 1) seed(p + w);
  }
  let removed = 0;
  for (let p = 0; p < w * h; p++) {
    if (bg[p]) { d[p * 4 + 3] = 0; removed++; continue; }
    const x = p % w, y = (p - x) / w;
    const rim = (x > 0 && bg[p - 1]) || (x < w - 1 && bg[p + 1]) || (y > 0 && bg[p - w]) || (y < h - 1 && bg[p + w]);
    if (rim) {
      const k = Math.min(1, Math.max(0.35, (dist(d, p * 4, r, g, b) - tolerance * 0.5) / (tolerance * 1.5)));
      d[p * 4 + 3] = Math.round(d[p * 4 + 3] * k);
    }
  }
  return { img: out, removed: removed / (w * h), mask: bg };
}

/** Take the backdrop's colour cast off the subject's soft rim (after keying out a green or coloured backdrop). */
export function despill(img, [r, g, b]) {
  const out = copyOf(img);
  const d = out.data;
  const top = Math.max(r, g, b);
  const ch = top === g ? 1 : top === r ? 0 : 2; // the backdrop's strongest channel
  if (top - Math.min(r, g, b) < 60) return out; // a grey or white backdrop leaves no colour cast
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0 || d[i + 3] === 255) continue;
    const others = [0, 1, 2].filter((c) => c !== ch).map((c) => d[i + c]);
    d[i + ch] = Math.min(d[i + ch], Math.max(...others));
  }
  return out;
}

/** Grow a mask by `r` pixels (the brush's soft edge, and room for the AI result to blend). */
export function dilate(mask, w, h, r = 1) {
  let cur = mask;
  for (let k = 0; k < r; k++) {
    const next = new Uint8Array(cur);
    for (let p = 0; p < w * h; p++) {
      if (cur[p]) continue;
      const x = p % w, y = (p - x) / w;
      if ((x > 0 && cur[p - 1]) || (x < w - 1 && cur[p + 1]) || (y > 0 && cur[p - w]) || (y < h - 1 && cur[p + w])) next[p] = 1;
    }
    cur = next;
  }
  return cur;
}

/**
 * Fill the masked pixels from their surroundings (the on-device Magic Eraser): pixels nearest the known area
 * first, each the distance-weighted average of known pixels within 3 px, then two smoothing passes so the fill
 * has no streaks. Good for removing a small object from sky, wall, grass or a plain table; not for rebuilding a face.
 */
export function inpaint(img, mask) {
  const { width: w, height: h } = img;
  const out = copyOf(img);
  const d = out.data;
  const known = new Uint8Array(w * h);
  const order = new Int32Array(w * h);
  const seen = new Uint8Array(w * h);
  let head = 0, tail = 0, holes = 0;
  for (let p = 0; p < w * h; p++) {
    if (!mask[p]) { known[p] = 1; continue; }
    holes++;
  }
  if (!holes) return out;
  if (holes === w * h) return out; // nothing to fill from
  // the hole's pixels in order of distance from its edge (breadth first from the known pixels around it)
  for (let p = 0; p < w * h; p++) {
    if (!mask[p]) continue;
    const x = p % w, y = (p - x) / w;
    if ((x > 0 && known[p - 1]) || (x < w - 1 && known[p + 1]) || (y > 0 && known[p - w]) || (y < h - 1 && known[p + w])) { seen[p] = 1; order[tail++] = p; }
  }
  while (head < tail) {
    const p = order[head++];
    const x = p % w, y = (p - x) / w;
    for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
      if (q >= 0 && mask[q] && !seen[q]) { seen[q] = 1; order[tail++] = q; }
    }
  }
  const R = 3;
  for (let k = 0; k < tail; k++) {
    const p = order[k];
    const x = p % w, y = (p - x) / w;
    let sr = 0, sg = 0, sb = 0, sa = 0, sw = 0;
    for (let dy = -R; dy <= R; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -R; dx <= R; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w || (!dx && !dy)) continue;
        const q = yy * w + xx;
        if (!known[q]) continue;
        const wt = 1 / (dx * dx + dy * dy);
        sr += d[q * 4] * wt; sg += d[q * 4 + 1] * wt; sb += d[q * 4 + 2] * wt; sa += d[q * 4 + 3] * wt; sw += wt;
      }
    }
    if (sw) { d[p * 4] = sr / sw; d[p * 4 + 1] = sg / sw; d[p * 4 + 2] = sb / sw; d[p * 4 + 3] = sa / sw; }
    known[p] = 1;
  }
  for (let pass = 0; pass < 2; pass++) {
    const src = new Uint8ClampedArray(d);
    for (let k = 0; k < tail; k++) {
      const p = order[k];
      const x = p % w, y = (p - x) / w;
      for (let c = 0; c < 4; c++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          s += src[(yy * w + xx) * 4 + c]; n++;
        }
        d[p * 4 + c] = s / n;
      }
    }
  }
  return out;
}

/**
 * Where a w×h picture sits in a canvas of the target aspect ratio (Magic Expand): the canvas only grows, the
 * picture stays whole and centred, and the canvas is scaled so its long side is at most `maxSide`.
 * Returns { W, H, x, y, w, h } (the picture's box inside the canvas, after scaling) or null when it already fits.
 */
export function expandPlan(w, h, ratio, maxSide = 2048) {
  if (!(w > 0 && h > 0 && ratio > 0)) return null;
  const now = w / h;
  if (Math.abs(now - ratio) / ratio < 0.01) return null;
  let W = w, H = h;
  if (now < ratio) W = h * ratio; else H = w / ratio;
  const k = Math.min(1, maxSide / Math.max(W, H));
  const pw = Math.max(1, Math.round(w * k)), ph = Math.max(1, Math.round(h * k));
  const CW = Math.max(pw, Math.round(W * k)), CH = Math.max(ph, Math.round(H * k));
  return { W: CW, H: CH, x: Math.floor((CW - pw) / 2), y: Math.floor((CH - ph) / 2), w: pw, h: ph };
}

/** Mask (1 = new area) of an expand plan. */
export function expandMask(plan) {
  const m = new Uint8Array(plan.W * plan.H).fill(1);
  for (let y = plan.y; y < plan.y + plan.h; y++) m.fill(0, y * plan.W + plan.x, y * plan.W + plan.x + plan.w);
  return m;
}

const reflect = (v, lo, n) => { // v mirrored into [lo, lo + n)
  if (n <= 1) return lo;
  const period = 2 * (n - 1);
  let t = (v - lo) % period;
  if (t < 0) t += period;
  return lo + (t < n ? t : period - t);
};

/**
 * The on-device Magic Expand: the picture (already scaled to plan.w×plan.h) in the middle of the new canvas,
 * the new area filled with its mirror image, blurred more the further it is from the picture so it reads as
 * out-of-focus surroundings rather than a copy.
 */
export function expandFill(pic, plan) {
  const { W, H } = plan;
  const out = blank(W, H);
  const d = out.data, s = pic.data;
  for (let y = 0; y < H; y++) {
    const sy = reflect(y, plan.y, plan.h) - plan.y;
    for (let x = 0; x < W; x++) {
      const sx = reflect(x, plan.x, plan.w) - plan.x;
      const o = (y * W + x) * 4, i = (sy * pic.width + sx) * 4;
      d[o] = s[i]; d[o + 1] = s[i + 1]; d[o + 2] = s[i + 2]; d[o + 3] = s[i + 3]; // a see-through picture stays see-through
    }
  }
  const mask = expandMask(plan);
  const r = Math.max(3, Math.round(Math.min(W, H) / 40));
  const blurred = boxBlur(boxBlur(out, r), r);
  const b = blurred.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (!mask[p]) continue;
      const far = Math.max(plan.x - x, x - (plan.x + plan.w - 1), plan.y - y, y - (plan.y + plan.h - 1), 0);
      const k = Math.min(1, far / (r * 2));
      for (let c = 0; c < 3; c++) d[p * 4 + c] = d[p * 4 + c] * (1 - k) + b[p * 4 + c] * k;
    }
  }
  return { img: out, mask };
}

/** A separable box blur (RGB; alpha kept). */
export function boxBlur(img, r) {
  const { width: w, height: h } = img;
  const tmp = copyOf(img), out = copyOf(img);
  const pass = (src, dst, horizontal) => {
    const len = horizontal ? w : h, lines = horizontal ? h : w;
    for (let l = 0; l < lines; l++) {
      for (let c = 0; c < 3; c++) {
        let s = 0, n = 0;
        const at = (t) => ((horizontal ? l * w + t : t * w + l) * 4 + c);
        for (let t = 0; t <= Math.min(r, len - 1); t++) { s += src[at(t)]; n++; }
        for (let t = 0; t < len; t++) {
          dst[at(t)] = s / n;
          const add = t + r + 1, drop = t - r;
          if (add < len) { s += src[at(add)]; n++; }
          if (drop >= 0) { s -= src[at(drop)]; n--; }
        }
      }
    }
  };
  pass(img.data, tmp.data, true);
  pass(tmp.data, out.data, false);
  return out;
}

/**
 * Paste `edited` into `base` only where `mask` is set, with a soft edge `feather` px wide: the AI result changes
 * what the person brushed (or the new area of an expand) and nothing else.
 */
export function compositeMasked(base, edited, mask, feather = 2) {
  const { width: w, height: h } = base;
  if (edited.width !== w || edited.height !== h) throw new Error('size mismatch');
  const out = copyOf(base);
  const d = out.data, e = edited.data;
  let grown = mask;
  const weight = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) if (mask[p]) weight[p] = 1;
  for (let k = 1; k <= feather; k++) {
    const next = dilate(grown, w, h, 1);
    for (let p = 0; p < w * h; p++) if (next[p] && !grown[p]) weight[p] = 1 - k / (feather + 1);
    grown = next;
  }
  for (let p = 0; p < w * h; p++) {
    const a = weight[p];
    if (!a) continue;
    for (let c = 0; c < 4; c++) d[p * 4 + c] = d[p * 4 + c] * (1 - a) + e[p * 4 + c] * a;
  }
  return out;
}

/** Paint the masked pixels one flat colour (what the AI eraser is told to remove). */
export function markMask(img, mask, [r, g, b] = [255, 0, 255]) {
  const out = copyOf(img);
  for (let p = 0; p < mask.length; p++) if (mask[p]) { out.data[p * 4] = r; out.data[p * 4 + 1] = g; out.data[p * 4 + 2] = b; out.data[p * 4 + 3] = 255; }
  return out;
}

export const hasTransparency = (img) => { for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < 255) return true; return false; };

// ── what the AI is asked (the picture goes only after the person confirms) ──

export const AI_PROMPTS = {
  background: 'Keep the main subject of this picture exactly as it is (same position, size, pose, colours and edges). Replace everything else, the whole background, with one flat, solid, pure green colour (#00FF00): no shadows, gradients, floor or texture.',
  erase: 'Remove whatever is covered by the solid magenta (#FF00FF) paint in this picture, and fill that area so it matches its surroundings naturally, as if the removed thing had never been there. Leave every other part of the picture exactly as it is. No magenta may remain.',
  expand: 'This picture has been extended: the original photo is in the middle, and the blurred bands around it are only placeholders. Redraw those blurred bands as a natural, sharp continuation of the scene (same lighting, perspective and style). Keep the middle part exactly as it is, and keep the same overall size and shape.',
  text: 'Transcribe all readable text in this picture exactly as written, in reading order (top to bottom, left to right). Reply with JSON only, in the form {"lines": ["first line", "second line"]}: one entry per line or heading, without bullet symbols. If there is no readable text, reply {"lines": []}. Do not describe the picture or add anything that is not written in it.',
};

/** Which service sees the picture for an image edit (the server's routeImage: Gemini Flash Image when Eden has a Gemini key, else GPT Image). */
export function editService(meta) {
  const im = meta && meta.images;
  if (!im || !im.available) return { available: false, reason: (im && im.reason) || 'Needs a Google Gemini or OpenAI API key (Settings › Models & API keys).' };
  return im.via === 'openai' ? { available: true, name: 'GPT Image', company: 'OpenAI' } : { available: true, name: 'Gemini Flash Image', company: 'Google' };
}

const COMPANY = { gemini: 'Google', anthropic: 'Anthropic', openai: 'OpenAI', mistral: 'Mistral', meta: 'Meta', deepseek: 'DeepSeek', deepinfra: 'DeepInfra' };
const VISION_ORDER = ['gemini', 'anthropic', 'openai', 'mistral'];
/**
 * The model that reads text out of a picture: an available cloud model that takes images, preferring Gemini,
 * then Claude, then GPT, and the fast tier within each (reading text needs no deep reasoning).
 */
export function pickVisionModel(meta) {
  const models = (meta && Array.isArray(meta.models) ? meta.models : []).filter((m) => m && m.available && m.vision !== false && VISION_ORDER.includes(m.provider));
  if (!models.length) return { available: false, reason: 'Needs an API key for a model that can see pictures (Google Gemini, Anthropic or OpenAI; Settings › Models & API keys).' };
  const rank = (m) => VISION_ORDER.indexOf(m.provider) * 10 + (m.tier === 'fast' ? 0 : m.tier === 'balanced' ? 1 : 2);
  const m = [...models].sort((a, b) => rank(a) - rank(b))[0];
  return { available: true, id: m.id, name: m.name || m.id, company: COMPANY[m.provider] || m.provider };
}

// ── Grab Text ──

// eslint-disable-next-line no-control-regex
const JUNK = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f￾￿]/g;
/** The text lines in a vision model's reply (JSON {lines}, a JSON list, or plain lines), cleaned and capped. */
export function parseOcrLines(reply) {
  let s = String(reply || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let lines = null;
  const start = s.search(/[[{]/);
  if (start >= 0) {
    try {
      const j = JSON.parse(s.slice(start, Math.max(s.lastIndexOf('}'), s.lastIndexOf(']')) + 1));
      lines = Array.isArray(j) ? j : j && Array.isArray(j.lines) ? j.lines : null;
    } catch { lines = null; }
  }
  if (!lines) {
    if (start >= 0 && /^\s*[[{]/.test(s)) return []; // broken JSON is not text from the picture
    lines = s.split(/\r?\n/);
  }
  const out = [];
  for (const l of lines) {
    if (typeof l !== 'string') continue;
    const t = l.replace(JUNK, '').replace(/^\s*(?:[-•*·▪●]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.text);
    if (t && out.at(-1) !== t) out.push(t);
    if (out.length >= 60) break;
  }
  return out;
}

/** Text the browser's own text detector found (Chrome's Shape Detection API), in reading order. */
export function linesFromDetections(found) {
  const items = (Array.isArray(found) ? found : []).filter((f) => f && typeof f.rawValue === 'string' && f.rawValue.trim())
    .map((f) => ({ t: f.rawValue.trim(), x: (f.boundingBox && f.boundingBox.x) || 0, y: (f.boundingBox && f.boundingBox.y) || 0, h: (f.boundingBox && f.boundingBox.height) || 10 }));
  items.sort((a, b) => (Math.abs(a.y - b.y) < Math.min(a.h, b.h) / 2 ? a.x - b.x : a.y - b.y));
  return parseOcrLines(items.map((i) => i.t).join('\n'));
}

/**
 * A new slide after slide i holding the text: the first line as its title, the rest as points (more than a slide
 * holds goes to the speaker notes). The text came from a picture, so it is only ever slide text, never markup.
 */
export function slideFromText(deck, i, lines) {
  const ls = (Array.isArray(lines) ? lines : []).filter((l) => typeof l === 'string' && l.trim());
  if (!ls.length || !deck || !Array.isArray(deck.slides) || !deck.slides[i] || deck.slides.length >= LIMITS.slides) return deck;
  const [title, ...rest] = ls;
  const bullets = rest.slice(0, LIMITS.bullets);
  const extra = rest.slice(LIMITS.bullets);
  const slide = normalizeSlide(bullets.length
    ? { layout: 'bullets', title, bullets, ...(extra.length ? { notes: `More text from the picture:\n${extra.join('\n')}` } : {}) }
    : { layout: 'section', title });
  if (!slide) return deck;
  const d = JSON.parse(JSON.stringify(deck));
  d.slides.splice(i + 1, 0, slide);
  return d;
}

/**
 * The slide with a new version of its picture: the edited picture (a data URL that passes the renderer's
 * signature check) is stored under a new id, the alt text is kept. Returns { deck, id } or null when the
 * picture isn't one Eden would draw or export.
 */
export function pictureVersion(deck, i, dataUrl, { now = Date.now(), alt } = {}) {
  if (!deck || !deck.slides || !deck.slides[i] || !imageData({ data: dataUrl })) return null;
  const id = `ph${now.toString(36)}${i}`;
  const keep = alt ?? deck.slides[i].alt ?? deck.slides[i].title ?? 'Slide picture';
  const next = setImage(deck, i, id, keep || 'Slide picture');
  return next === deck ? null : { deck: next, id };
}
