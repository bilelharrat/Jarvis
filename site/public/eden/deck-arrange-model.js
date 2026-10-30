// Arranging and history, the pure part (web editor only: deck-arrange.js draws it). Version history (names, pins,
// restore, compare), the slide sorter's edits on many slides at once (move, delete, duplicate, hide, sections),
// the slide clipboard (JSON with its pictures, or plain text from PowerPoint/Keynote), and the editor's zoom steps.
// No DOM here: tests load it in Node.

import { normalizeSlide, imageId, imagesUsed, LIMITS, capVersions } from './deck-model.js';

const clone = (v) => JSON.parse(JSON.stringify(v));
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const sortedSet = (deck, indices) => [...new Set((Array.isArray(indices) ? indices : []).filter((i) => Number.isInteger(i) && i >= 0 && i < deck.slides.length))].sort((a, b) => a - b);

// ── version history (c.deckVersions: { id, at, kind, src?, nodeId?, deck, name?, pinned? }) ──

export const VERSION_NAME_MAX = 60;
/** What made a version, for the History list: 'eden' (a reply), 'edit', 'import', 'template' or 'restore'. */
export function versionKind(v) {
  if (!v) return 'edit';
  if (v.kind === 'model') return 'eden';
  if (v.kind === 'import') return 'import';
  if (v.src === 'template' || v.src === 'restore' || v.src === 'import') return v.src;
  return 'edit';
}
export const KIND_LABEL = { eden: 'Eden', edit: 'Your edit', import: 'Import', template: 'Template', restore: 'Restored' };

export { capVersions }; // (deck-model.js: addVersion keeps named versions past MAX_VERSIONS)

/** Name (and pin) a version; an empty name unpins it. → the new list (the same list when nothing changed). */
export function nameVersion(versions, id, name) {
  if (!Array.isArray(versions)) return versions;
  const k = versions.findIndex((v) => v && v.id === id);
  if (k < 0) return versions;
  const clean = String(name ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, VERSION_NAME_MAX);
  const v = { ...versions[k] };
  if (clean) { v.name = clean; v.pinned = true; } else { delete v.name; delete v.pinned; }
  const out = versions.slice();
  out[k] = v;
  return out;
}

/** The deck to restore (a copy: restoring adds it as a new version, never rewriting history). */
export function restoreDeck(versions, id) {
  const v = Array.isArray(versions) ? versions.find((x) => x && x.id === id) : null;
  return v && isObj(v.deck) && Array.isArray(v.deck.slides) ? clone(v.deck) : null;
}

const slideKey = (s) => JSON.stringify(s);
const slideName = (s) => (s && (s.title || s.quote || s.kicker || s.subtitle)) || '';
/**
 * What changed from deck `a` (older) to `b`: { title, theme, rows: [{ status: 'same'|'changed'|'added'|'removed'|'moved', a, b, name }] }.
 * Slides are matched by content (longest common run), then a removed and an added slide at the same place count as one changed slide.
 */
export function compareDecks(a, b) {
  const A = (a && a.slides) || [], B = (b && b.slides) || [];
  const ka = A.map(slideKey), kb = B.map(slideKey);
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = ka[i] === kb[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const raw = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && ka[i] === kb[j]) { raw.push({ status: 'same', a: i, b: j }); i++; j++; }
    else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) { raw.push({ status: 'added', a: -1, b: j }); j++; }
    else { raw.push({ status: 'removed', a: i, b: -1 }); i++; }
  }
  // a slide removed in one place and the same slide added in another: moved
  const rows = [];
  for (const r of raw) {
    if (r.status === 'added') { const k = rows.findIndex((x) => x.status === 'removed' && ka[x.a] === kb[r.b]); if (k >= 0) { rows[k] = { status: 'moved', a: rows[k].a, b: r.b }; continue; } }
    if (r.status === 'removed') { const k = rows.findIndex((x) => x.status === 'added' && kb[x.b] === ka[r.a]); if (k >= 0) { rows[k] = { status: 'moved', a: r.a, b: rows[k].b }; continue; } }
    rows.push(r);
  }
  // removed then added next to each other (either order): one changed slide
  const out = [];
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k], nx = rows[k + 1];
    if (nx && ((r.status === 'removed' && nx.status === 'added') || (r.status === 'added' && nx.status === 'removed'))) {
      const ra = r.status === 'removed' ? r : nx, rb = r.status === 'added' ? r : nx;
      out.push({ status: 'changed', a: ra.a, b: rb.b }); k++;
    } else out.push(r);
  }
  for (const r of out) r.name = slideName(r.b >= 0 ? B[r.b] : A[r.a]);
  return {
    title: (a && a.title) !== (b && b.title) ? { a: (a && a.title) || '', b: (b && b.title) || '' } : null,
    theme: JSON.stringify((a && a.theme) || {}) !== JSON.stringify((b && b.theme) || {}),
    rows: out,
    changes: out.filter((r) => r.status !== 'same').length,
  };
}

// ── many slides at once (the sorter's selection) ──

/** The selected slides moved together so the first lands at `to` (an index in the deck as it is now). */
export function moveSlides(deck, indices, to) {
  const pick = sortedSet(deck, indices);
  if (!pick.length) return deck;
  const set = new Set(pick);
  const moving = pick.map((i) => deck.slides[i]);
  const rest = deck.slides.filter((_, i) => !set.has(i));
  const before = deck.slides.slice(0, Math.max(0, Math.min(deck.slides.length, to))).filter((_, i) => !set.has(i)).length; // slots before the target, not counting the moved ones
  const slides = [...rest.slice(0, before), ...moving, ...rest.slice(before)];
  if (slides.every((s, i) => s === deck.slides[i])) return deck;
  return { ...clone(deck), slides: clone(slides) };
}
/** The selected slides deleted (a deck keeps at least one slide: then nothing changes). */
export function deleteSlides(deck, indices) {
  const set = new Set(sortedSet(deck, indices));
  if (!set.size || set.size >= deck.slides.length) return deck;
  return { ...clone(deck), slides: clone(deck.slides.filter((_, i) => !set.has(i))) };
}
/** Each selected slide copied, all the copies after the last selected one. → { deck, indices } (the copies). */
export function duplicateSlides(deck, indices) {
  const pick = sortedSet(deck, indices);
  if (!pick.length || deck.slides.length + pick.length > LIMITS.slides) return { deck, indices: [] };
  const d = clone(deck);
  const at = pick.at(-1) + 1;
  d.slides.splice(at, 0, ...pick.map((i) => clone(deck.slides[i])));
  return { deck: d, indices: pick.map((_, k) => at + k) };
}
/** Hide or show the selected slides (hidden slides are skipped when presenting and in exports). */
export function setHidden(deck, indices, hidden) {
  const pick = sortedSet(deck, indices);
  if (!pick.length) return deck;
  const d = clone(deck);
  for (const i of pick) { if (hidden) d.slides[i].hidden = true; else delete d.slides[i].hidden; }
  return JSON.stringify(d.slides) === JSON.stringify(deck.slides) ? deck : d;
}
export const hiddenCount = (deck) => (deck && deck.slides ? deck.slides.filter((s) => s.hidden).length : 0);
/** The deck as exported: hidden slides left out (unless `includeHidden`), and the `hidden` marks dropped. Null when every slide is hidden. */
export function forExport(deck, { includeHidden = false } = {}) {
  if (!deck || !Array.isArray(deck.slides)) return deck;
  if (!deck.slides.some((s) => s.hidden || s.section)) return deck;
  const slides = deck.slides.filter((s) => includeHidden || !s.hidden).map(({ hidden, ...s }) => s);
  if (!slides.length) return null;
  return { ...deck, slides };
}

// sections: a slide's `section` names the group it's in; a group is a run of slides with the same name
export const SECTION_MAX = 40;
export const cleanSection = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SECTION_MAX);
/** The deck's sections in order: [{ name, start, end }] (end inclusive); slides before the first named one are { name: '' }. */
export function sectionsOf(deck) {
  const out = [];
  (deck && deck.slides || []).forEach((s, i) => {
    const name = s.section || '';
    const last = out.at(-1);
    if (last && last.name === name) last.end = i;
    else out.push({ name, start: i, end: i });
  });
  return out;
}
export const sectionNames = (deck) => [...new Set(sectionsOf(deck).map((s) => s.name).filter(Boolean))];
/** The selected slides moved into section `name` (to the end of its first run; a new name starts a new section where the first selected slide is). */
export function moveToSection(deck, indices, name) {
  const pick = sortedSet(deck, indices);
  const clean = cleanSection(name);
  if (!pick.length) return deck;
  const run = clean ? sectionsOf(deck).find((s) => s.name === clean) : null;
  let d = clone(deck);
  for (const i of pick) { if (clean) d.slides[i].section = clean; else delete d.slides[i].section; }
  if (run) d = moveSlides(d, pick, run.end + 1);
  return JSON.stringify(d.slides) === JSON.stringify(deck.slides) ? deck : d;
}
/** A section renamed everywhere ('' removes the name: its slides join no section). */
export function renameSection(deck, from, to) {
  const a = cleanSection(from), b = cleanSection(to);
  if (!a || a === b) return deck;
  const d = clone(deck);
  for (const s of d.slides) if (s.section === a) { if (b) s.section = b; else delete s.section; }
  return d;
}

// ── the slide clipboard ──

export const CLIP_KIND = 'eden-slides';
const CLIP_MAX = 12_000_000; // characters of JSON (pictures included)
/** The selected slides as clipboard JSON, with the pictures they use and the deck's theme. */
export function clipSlides(deck, indices, images = {}) {
  const pick = sortedSet(deck, indices);
  const slides = pick.map((i) => clone(deck.slides[i]));
  const used = imagesUsed({ slides });
  const pics = {};
  for (const id of used) { const im = images[id]; if (im && typeof im.data === 'string' && im.data.startsWith('data:image/')) pics[id] = { data: im.data, w: im.w || 0, h: im.h || 0 }; }
  return JSON.stringify({ kind: CLIP_KIND, v: 1, title: deck.title, theme: deck.theme, slides, images: pics });
}
/** Clipboard text → { slides, images } from Eden, { slides } from plain text (PowerPoint, Keynote, an outline), or null. */
export function parseClip(textValue) {
  if (typeof textValue !== 'string' || !textValue.trim() || textValue.length > CLIP_MAX) return null;
  const t = textValue.trim();
  if (t.startsWith('{') && t.includes(CLIP_KIND)) {
    let raw;
    try { raw = JSON.parse(t); } catch { raw = null; }
    if (isObj(raw) && raw.kind === CLIP_KIND && Array.isArray(raw.slides)) {
      const slides = raw.slides.slice(0, LIMITS.slides).map(normalizeSlide).filter(Boolean);
      const images = {};
      if (isObj(raw.images)) for (const [id, im] of Object.entries(raw.images)) {
        if (imageId(id) === id && isObj(im) && typeof im.data === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(im.data)) images[id] = { data: im.data, w: Number(im.w) || 0, h: Number(im.h) || 0 };
      }
      return slides.length ? { slides, images, from: 'eden' } : null;
    }
  }
  const slides = textToSlides(t);
  return slides.length ? { slides, images: {}, from: 'text' } : null;
}
const BULLET = /^[\s ]*(?:[-*•◦▪▫‣⁃–—·o]|\d{1,2}[.)])[\s ]+/;
/**
 * Slides from plain text, as PowerPoint and Keynote put it on the clipboard: blocks split by blank lines (or, in an
 * outline, by lines that aren't indented); a block's first line is the title, the rest its bullets.
 */
export function textToSlides(t) {
  const lines = String(t).replace(/\r\n?/g, '\n').replace(/\u000b/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
  if (!lines.some((l) => l.trim())) return [];
  let blocks;
  if (lines.some((l) => !l.trim())) {
    blocks = [];
    let b = [];
    for (const l of lines) { if (l.trim()) b.push(l); else if (b.length) { blocks.push(b); b = []; } }
    if (b.length) blocks.push(b);
  } else if (lines.some((l) => /^[\t ]/.test(l)) && lines.some((l) => /^\S/.test(l))) { // an outline: titles flush left, points indented
    blocks = [];
    for (const l of lines) { if (/^\S/.test(l) && !BULLET.test(l)) blocks.push([l]); else if (blocks.length) blocks.at(-1).push(l); else blocks.push([l]); }
  } else blocks = [lines.filter((l) => l.trim())];
  const out = [];
  for (const b of blocks.slice(0, LIMITS.slides)) {
    const [head, ...rest] = b.map((l) => l.replace(BULLET, '').trim()).filter(Boolean);
    if (!head) continue;
    const bullets = rest.slice(0, LIMITS.bullets);
    const s = normalizeSlide(bullets.length ? { layout: 'bullets', title: head, bullets } : { layout: 'section', title: head });
    if (s) out.push(s);
  }
  return out;
}
/**
 * The clipboard's slides put in after slide `after` (-1: at the start). Pictures get new ids when this chat already
 * holds a different picture under the same id. → { deck, indices, images (to store), cut (the slides that didn't fit) }.
 */
export function pasteSlides(deck, after, clip, have = {}) {
  if (!clip || !Array.isArray(clip.slides) || !clip.slides.length) return { deck, indices: [], images: {}, cut: 0 };
  const room = Math.max(0, LIMITS.slides - deck.slides.length);
  const take = clip.slides.slice(0, room);
  const rename = {}, images = {};
  for (const [id, im] of Object.entries(clip.images || {})) {
    if (have[id] && have[id].data === im.data) continue; // already here
    let nid = id;
    if (have[id]) nid = `${id.slice(0, 50)}p${Date.now().toString(36).slice(-5)}${Object.keys(images).length}`;
    rename[id] = nid; images[nid] = im;
  }
  const fix = (id) => (id && rename[id] ? rename[id] : id);
  const slides = take.map((s) => {
    const c = clone(s);
    if (c.image) c.image = fix(c.image);
    if (Array.isArray(c.free)) c.free = c.free.map((e) => (e.image ? { ...e, image: fix(e.image) } : e));
    return c;
  });
  if (!slides.length) return { deck, indices: [], images: {}, cut: clip.slides.length };
  const at = Math.max(0, Math.min(deck.slides.length, after + 1));
  const d = clone(deck);
  d.slides.splice(at, 0, ...slides);
  return { deck: d, indices: slides.map((_, k) => at + k), images, cut: clip.slides.length - slides.length };
}

// ── zoom, grid, guides (the editor's view; nothing here is saved in the deck) ──

export const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
/** The next zoom step in or out from `z` (0 = fit to the window, which is `fitScale`). */
export function zoomStep(z, dir, fitScale = 1) {
  const now = z > 0 ? z : fitScale;
  if (dir > 0) return ZOOMS.find((s) => s > now + 1e-3) ?? ZOOMS.at(-1);
  if (dir < 0) return [...ZOOMS].reverse().find((s) => s < now - 1e-3) ?? ZOOMS[0];
  return 0;
}
export const GRID_SIZES = [20, 40, 80];
export const GUIDES_MAX = 20;
/** Guides cleaned: { x: [...], y: [...] }, inside the slide, whole pixels, each once. */
export function cleanGuides(g) {
  const one = (list, max) => [...new Set((Array.isArray(list) ? list : []).filter((v) => Number.isFinite(v) && v >= 0 && v <= max).map((v) => Math.round(v)))].slice(0, GUIDES_MAX);
  return { x: one(g && g.x, 1280), y: one(g && g.y, 720) };
}
