// A deck's comments and tasks, with no browser in them (deck-comments.js draws them; the tests load this file).
// They live in the deck as `deck.comments`, so they're versioned and go where the deck goes, and two copies merge
// (sync-model.js mergeComments). They sit outside undo: an edit's undo never takes a comment away (deck-model.js
// addVersion carries every version's comments onto the newest one).
//
// A thread: { id, at, by, text, anchor: { slide, path?, el?, title? }, mentions?, replies?: [{ id, at, by, text,
// mentions?, edited?, deleted? }], resolved?, task?: { to, due?, done? }, edited, deleted? }. `slide` counts from 0;
// `path` is the deck-render.js data-path of a piece (title, bullets.2, chart…); `el` a free element's id; `title` the
// slide's title when the comment was made, to find the slide again after it moves.

import { mergeComments, foldComments } from './sync-model.js';

export { mergeComments, foldComments };
export const LIMITS = { threads: 200, replies: 60, text: 2000, name: 60, path: 40 };
const HIDDEN = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠⁦-⁩﻿]/g;
const NOT_XML = /[￾￿﷐-﷯]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
/** Text kept: no hidden or bidi characters, nothing XML can't hold, at most `max` (never splitting an emoji). */
export function clean(v, max = LIMITS.text, { lines = true } = {}) {
  if (typeof v !== 'string') return '';
  let s = v.replace(HIDDEN, '').replace(NOT_XML, '');
  s = lines ? s.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ');
  s = s.trim();
  if (s.length > max) { s = s.slice(0, max); if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1); }
  return s;
}
export const cleanName = (v) => clean(v, LIMITS.name, { lines: false });
const id = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v) ? v : '');
const time = (v) => (Number.isFinite(v) && v > 0 && v < 8.64e15 ? Math.floor(v) : 0);
const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : '');
const pathOk = (v) => (typeof v === 'string' && v.length <= LIMITS.path && /^[A-Za-z][A-Za-z0-9.]*$/.test(v) ? v : '');
export const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** The names a text @mentions: "@Sam" or "@[Sam Lee]" (once each). */
export function mentionsIn(textValue) {
  const out = [];
  for (const m of String(textValue || '').matchAll(/(?:^|[^\w@])@(?:\[([^\]\n]{1,60})\]|([\p{L}\p{N}][\p{L}\p{N}._-]{0,39}))/gu)) {
    const n = cleanName(m[1] || m[2]).replace(/[._-]+$/, '');
    if (n && !out.some((x) => x.toLowerCase() === n.toLowerCase())) out.push(n);
  }
  return out.slice(0, 20);
}

function anchor(a) {
  const o = isObj(a) ? a : {};
  const slide = Number.isInteger(o.slide) && o.slide >= 0 && o.slide < 1000 ? o.slide : 0;
  const out = { slide };
  const p = pathOk(o.path); if (p) out.path = p;
  const e = id(o.el); if (e) out.el = e;
  const t = clean(o.title, 160, { lines: false }); if (t) out.title = t;
  return out;
}
function reply(r) {
  if (!isObj(r) || !id(r.id)) return null;
  const at = time(r.at);
  if (r.deleted) return { id: r.id, at, edited: time(r.edited) || at, deleted: true };
  const text = clean(r.text);
  if (!text) return null;
  const out = { id: r.id, at, by: cleanName(r.by) || 'Someone', text };
  const ms = mentionsIn(text); if (ms.length) out.mentions = ms;
  if (time(r.edited) > at) out.edited = time(r.edited);
  return out;
}
function task(t) {
  if (!isObj(t)) return null;
  const to = cleanName(t.to);
  if (!to) return null;
  const out = { to };
  const d = day(t.due); if (d) out.due = d;
  if (t.done === true) out.done = true;
  return out;
}
/** One thread, cleaned, or null. */
export function normalizeThread(t) {
  if (!isObj(t) || !id(t.id)) return null;
  const at = time(t.at);
  const edited = Math.max(time(t.edited), at);
  if (t.deleted) return { id: t.id, at, edited, deleted: true };
  const textValue = clean(t.text);
  if (!textValue) return null;
  const out = { id: t.id, at, by: cleanName(t.by) || 'Someone', text: textValue, anchor: anchor(t.anchor) };
  const ms = mentionsIn(textValue); if (ms.length) out.mentions = ms;
  const seen = new Set();
  const replies = (Array.isArray(t.replies) ? t.replies.slice(0, LIMITS.replies) : []).map(reply).filter((r) => r && !seen.has(r.id) && seen.add(r.id));
  if (replies.length) out.replies = replies;
  if (t.resolved === true) out.resolved = true;
  const tk = task(t.task); if (tk) out.task = tk;
  out.edited = edited;
  return out;
}
/** A deck's comments, cleaned (each id once; deleted ones kept as tombstones so a merge never brings them back). */
export function normalizeComments(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = raw.slice(0, LIMITS.threads + 100).map(normalizeThread).filter((t) => t && !seen.has(t.id) && seen.add(t.id));
  return mergeComments([], out);
}

// ── changes: each returns a new list (the thread's `edited` stamped), never touching the old one ──

const stamp = (now) => time(now) || Date.now();
const live = (list) => (Array.isArray(list) ? list : []);
const change = (list, threadId, fn, now) => live(list).map((t) => (t.id === threadId && !t.deleted ? normalizeThread({ ...fn(t), edited: Math.max(stamp(now), (t.edited || 0) + 1) }) || t : t));

/** A new thread on `anchor` (comments past the limit are refused: null). */
export function addComment(list, { by, text: textValue, anchor: a, task: tk = null, now = 0, id: tid = newId() }) {
  if (live(list).filter((t) => !t.deleted).length >= LIMITS.threads) return null;
  const at = stamp(now);
  const t = normalizeThread({ id: tid, at, edited: at, by, text: textValue, anchor: a, ...(tk ? { task: tk } : {}) });
  return t ? [...live(list), t] : null;
}
export function addReply(list, threadId, { by, text: textValue, now = 0, id: rid = newId() }) {
  const at = stamp(now);
  return change(list, threadId, (t) => ({ ...t, resolved: false, replies: [...(t.replies || []), { id: rid, at, by, text: textValue }].slice(-LIMITS.replies) }), now);
}
export const setResolved = (list, threadId, resolved, now = 0) => change(list, threadId, (t) => ({ ...t, resolved: Boolean(resolved) }), now);
export const editComment = (list, threadId, textValue, now = 0) => change(list, threadId, (t) => ({ ...t, text: clean(textValue) || t.text }), now);
/** Assign as a task (`to` a name, `due` YYYY-MM-DD); `to` empty takes the task away. */
export const assignTask = (list, threadId, { to, due = '' } = {}, now = 0) => change(list, threadId, (t) => { const n = { ...t }; if (cleanName(to)) n.task = { to, due, done: false }; else delete n.task; return n; }, now);
export const setTaskDone = (list, threadId, done, now = 0) => change(list, threadId, (t) => (t.task ? { ...t, task: { ...t.task, done: Boolean(done) }, ...(done ? { resolved: true } : {}) } : t), now);
export function deleteComment(list, threadId, now = 0) {
  return live(list).map((t) => (t.id === threadId ? { id: t.id, at: t.at, edited: Math.max(stamp(now), (t.edited || 0) + 1), deleted: true } : t));
}
export function deleteReply(list, threadId, replyId, now = 0) {
  return change(list, threadId, (t) => ({ ...t, replies: (t.replies || []).map((r) => (r.id === replyId ? { id: r.id, at: r.at, edited: stamp(now), deleted: true } : r)) }), now);
}

// ── reading ──

/** The slide a thread is on now: its index while that slide still has the title it had, else the slide with that title. */
export function anchorIndex(deck, t) {
  const slides = (deck && deck.slides) || [];
  const a = (t && t.anchor) || { slide: 0 };
  const titleAt = (i) => String((slides[i] && slides[i].title) || '');
  if (!a.title || titleAt(a.slide) === a.title) return a.slide < slides.length ? a.slide : -1;
  const near = slides.map((s, i) => i).filter((i) => titleAt(i) === a.title).sort((x, y) => Math.abs(x - a.slide) - Math.abs(y - a.slide));
  return near.length ? near[0] : a.slide < slides.length ? a.slide : -1;
}
/** Threads people can see (no tombstones). */
export const visible = (list) => live(list).filter((t) => !t.deleted);
/** Open (not resolved) threads per slide: { index: count }. */
export function countsBySlide(deck, list) {
  const out = {};
  for (const t of visible(list)) { if (t.resolved) continue; const i = anchorIndex(deck, t); if (i >= 0) out[i] = (out[i] || 0) + 1; }
  return out;
}
/** Open threads on a piece of a slide: [{ index, path, n }]. */
export function pins(deck, list) {
  const m = new Map();
  for (const t of visible(list)) {
    if (t.resolved || !t.anchor.path) continue;
    const i = anchorIndex(deck, t);
    if (i < 0) continue;
    const k = `${i}|${t.anchor.path}`;
    m.set(k, { index: i, path: t.anchor.path, n: ((m.get(k) || {}).n || 0) + 1 });
  }
  return [...m.values()];
}
const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
/** The panel's filters: all, open, resolved, mine (tasks for `me` not done), mentions (of `me`), slide (on `slide`). */
export function filterThreads(deck, list, filter = 'open', { me = '', slide = -1 } = {}) {
  const v = visible(list);
  switch (filter) {
    case 'all': return v;
    case 'resolved': return v.filter((t) => t.resolved);
    case 'mine': return v.filter((t) => t.task && !t.task.done && same(t.task.to, me)).sort((a, b) => (a.task.due || '9999').localeCompare(b.task.due || '9999'));
    case 'tasks': return v.filter((t) => t.task);
    case 'mentions': return v.filter((t) => (t.mentions || []).some((n) => same(n, me)) || (t.replies || []).some((r) => (r.mentions || []).some((n) => same(n, me))));
    case 'slide': return v.filter((t) => anchorIndex(deck, t) === slide);
    default: return v.filter((t) => !t.resolved);
  }
}
/** Everyone the panel can suggest for an @mention or a task: authors, assignees, mentioned names and `extra` (people here now). */
export function people(list, extra = []) {
  const out = [];
  const add = (n) => { const c = cleanName(n); if (c && c !== 'Someone' && !out.some((x) => same(x, c))) out.push(c); };
  for (const t of visible(list)) { add(t.by); if (t.task) add(t.task.to); (t.mentions || []).forEach(add); for (const r of t.replies || []) if (!r.deleted) { add(r.by); (r.mentions || []).forEach(add); } }
  extra.forEach(add);
  return out;
}
/** A task's state on `today` (YYYY-MM-DD): 'done', 'overdue', 'today' or 'open'. */
export function taskState(t, today) {
  if (!t || !t.task) return '';
  if (t.task.done) return 'done';
  if (t.task.due && today && t.task.due < today) return 'overdue';
  if (t.task.due && t.task.due === today) return 'today';
  return 'open';
}

// ── PowerPoint: real comments (ppt/comments/commentN.xml, ppt/commentAuthors.xml), replies threaded the way
//    PowerPoint 2013+ writes them (p15:threadingInfo). A resolved thread or a task says so in its text. ──

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const iso = (ms) => new Date(time(ms) || 0).toISOString().replace(/Z$/, '');
const initials = (n) => (String(n).match(/\p{L}/gu) ? String(n).split(/\s+/).map((w) => (w.match(/\p{L}/u) || [''])[0]).join('').slice(0, 3).toUpperCase() : '?');
const REL_COMMENTS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';
const REL_AUTHORS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/commentAuthors';
const CT_COMMENTS = 'application/vnd.openxmlformats-officedocument.presentationml.comments+xml';
const CT_AUTHORS = 'application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const THREAD_URI = '{C676402C-5697-4E1C-873F-D02D1690AC5C}';
const NS_P15 = 'http://schemas.microsoft.com/office/powerpoint/2012/main';

/** The text a thread's first comment carries in PowerPoint (where it points, a task, resolved). */
export function pptxText(t) {
  const bits = [];
  if (t.anchor && t.anchor.path) bits.push(`[${t.anchor.path.replace(/\./g, ' ')}]`);
  if (t.task) bits.push(`[Task for ${t.task.to}${t.task.due ? `, due ${t.task.due}` : ''}${t.task.done ? ', done' : ''}]`);
  if (t.resolved) bits.push('[Resolved]');
  return `${bits.length ? `${bits.join(' ')} ` : ''}${t.text}`;
}

/**
 * The files a .pptx needs for these comments. `slideOf(index)` → the file's slide number (1-based) where a deck
 * slide starts, or 0 when it isn't drawn. → { authors: xml, slides: Map(slideNo → xml) } or null with none to write.
 */
export function pptxCommentFiles(deck, list, slideOf) {
  const threads = visible(list).filter((t) => anchorIndex(deck, t) >= 0 && slideOf(anchorIndex(deck, t)) > 0);
  if (!threads.length) return null;
  const authors = [];
  const author = (n) => { let a = authors.find((x) => x.name === n); if (!a) { a = { id: authors.length, name: n, last: 0 }; authors.push(a); } return a; };
  const bySlide = new Map();
  for (const t of threads) {
    const no = slideOf(anchorIndex(deck, t));
    const a = author(t.by);
    const parent = { authorId: a.id, idx: ++a.last };
    const y = 10 + 140 * (bySlide.get(no) || []).filter((c) => !c.parent).length; // stacked down the left edge
    const cms = bySlide.get(no) || [];
    cms.push({ authorId: a.id, idx: parent.idx, at: t.at, text: pptxText(t), x: 10, y });
    for (const r of t.replies || []) {
      if (r.deleted) continue;
      const ra = author(r.by);
      cms.push({ authorId: ra.id, idx: ++ra.last, at: r.at, text: r.text, x: 10, y, parent });
    }
    bySlide.set(no, cms);
  }
  const slides = new Map();
  for (const [no, cms] of bySlide) {
    slides.set(no, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:cmLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="${NS_P}">${cms.map((c) => `<p:cm authorId="${c.authorId}" dt="${iso(c.at)}" idx="${c.idx}"><p:pos x="${c.x}" y="${c.y}"/><p:text>${xml(c.text)}</p:text>${c.parent ? `<p:extLst><p:ext uri="${THREAD_URI}"><p15:threadingInfo xmlns:p15="${NS_P15}" timeZoneBias="0"><p15:parentCm authorId="${c.parent.authorId}" idx="${c.parent.idx}"/></p15:threadingInfo></p:ext></p:extLst>` : ''}</p:cm>`).join('')}</p:cmLst>`);
  }
  const auth = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:cmAuthorLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="${NS_P}">${authors.map((a) => `<p:cmAuthor id="${a.id}" name="${xml(a.name)}" initials="${xml(initials(a.name))}" lastIdx="${a.last}" clrIdx="${a.id % 8}"/>`).join('')}</p:cmAuthorLst>`;
  return { authors: auth, slides };
}

const nextRid = (rels) => `rId${Math.max(0, ...[...String(rels).matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]))) + 1}`;
const addRel = (rels, type, target) => (rels.includes(`Target="${target}"`) ? rels : rels.replace('</Relationships>', `<Relationship Id="${nextRid(rels)}" Type="${type}" Target="${target}"/></Relationships>`));
const addOverride = (ct, part, type) => (ct.includes(`PartName="${part}"`) ? ct : ct.replace('</Types>', `<Override PartName="${part}" ContentType="${type}"/></Types>`));

/**
 * The .pptx with the deck's comments in it as PowerPoint comments. `JSZip` the class (PptxGenJS bundles it), `bytes` the
 * file, `slideOf` as in pptxCommentFiles. A deck with none: the bytes come back as they were.
 */
export async function withComments(JSZip, bytes, deck, slideOf, { type = 'blob', mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation' } = {}) {
  const files = pptxCommentFiles(deck, deck.comments, slideOf);
  if (!files) return bytes;
  const zip = await JSZip.loadAsync(bytes);
  let ct = await zip.file('[Content_Types].xml').async('string');
  const presRels = 'ppt/_rels/presentation.xml.rels';
  zip.file(presRels, addRel(await zip.file(presRels).async('string'), REL_AUTHORS, 'commentAuthors.xml'));
  zip.file('ppt/commentAuthors.xml', files.authors);
  ct = addOverride(ct, '/ppt/commentAuthors.xml', CT_AUTHORS);
  for (const [no, body] of files.slides) {
    const relPath = `ppt/slides/_rels/slide${no}.xml.rels`;
    const rel = zip.file(relPath);
    if (!zip.file(`ppt/slides/slide${no}.xml`)) continue;
    const rels = rel ? await rel.async('string') : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    zip.file(`ppt/comments/comment${no}.xml`, body);
    zip.file(relPath, addRel(rels, REL_COMMENTS, `../comments/comment${no}.xml`));
    ct = addOverride(ct, `/ppt/comments/comment${no}.xml`, CT_COMMENTS);
  }
  zip.file('[Content_Types].xml', ct);
  return zip.generateAsync({ type, mimeType, compression: 'DEFLATE' });
}

/** A conversation's deck comments: every version's, merged (what the panel shows and the export writes). */
export function commentsOf(c) {
  const vs = foldComments(c && Array.isArray(c.deckVersions) ? c.deckVersions : []);
  const last = vs && vs.length ? vs.at(-1) : null;
  return (last && last.deck && last.deck.comments) || [];
}
