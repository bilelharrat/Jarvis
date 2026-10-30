// The essay writer's rules without the page (essay.js draws it, essay-export.js writes .docx and
// PDF, essay-cite.js formats the sources; src/__tests__/essay.test.ts): each style's page setup
// (font, spacing, indents, running header, headings, the reference page), the heading block or
// title page made from the essay's details, dates as each style writes them, word counts, and a
// new essay. "Auto formatting" is this: the person writes, the style decides how it looks, and
// switching style re-lays the whole essay, its title page and its sources.

/**
 * front: 'heading' (MLA's four lines on page 1) or 'titlepage'. header: 'name' ("Smith 3") or
 * 'number'. numberTitlePage: the title page shows its number (APA) or is counted but blank
 * (Chicago, Harvard). titleLine: the title above the text on page 1 ('plain', 'bold' or null).
 * gap: space between paragraphs instead of a first-line indent (Harvard's block style).
 */
export const STYLES = {
  mla: {
    id: 'mla', label: 'MLA', long: 'MLA, 9th edition', font: 'Times New Roman', size: 12, spacing: 2, indent: true, gap: false,
    front: 'heading', header: 'name', numberTitlePage: true, titleLine: 'plain', date: 'dmy',
    headings: { 1: { align: 'left', bold: true }, 2: { align: 'left', italic: true }, 3: { align: 'left', bold: true, italic: true } },
    quote: { spacing: 2 }, notes: false,
    refs: { title: 'Works Cited', bold: false, align: 'center', hanging: true, spacing: 2, gap: false },
    fields: ['name', 'instructor', 'course', 'date'],
  },
  apa: {
    id: 'apa', label: 'APA', long: 'APA, 7th edition (student paper)', font: 'Times New Roman', size: 12, spacing: 2, indent: true, gap: false,
    front: 'titlepage', header: 'number', numberTitlePage: true, titleLine: 'bold', date: 'mdy',
    headings: { 1: { align: 'center', bold: true }, 2: { align: 'left', bold: true }, 3: { align: 'left', bold: true, italic: true } },
    quote: { spacing: 2 }, notes: false,
    refs: { title: 'References', bold: true, align: 'center', hanging: true, spacing: 2, gap: false },
    fields: ['name', 'school', 'course', 'instructor', 'date'],
  },
  chicago: {
    id: 'chicago', label: 'Chicago', long: 'Chicago, 17th edition (notes and bibliography)', font: 'Times New Roman', size: 12, spacing: 2, indent: true, gap: false,
    front: 'titlepage', header: 'number', numberTitlePage: false, titleLine: null, date: 'mdy',
    headings: { 1: { align: 'center', bold: true }, 2: { align: 'center' }, 3: { align: 'left', bold: true } },
    quote: { spacing: 1 }, notes: true,
    refs: { title: 'Bibliography', bold: false, align: 'center', hanging: true, spacing: 1, gap: true },
    fields: ['name', 'course', 'instructor', 'date'],
  },
  harvard: {
    id: 'harvard', label: 'Harvard', long: 'Harvard (Cite Them Right)', font: 'Arial', size: 12, spacing: 1.5, indent: false, gap: true,
    front: 'titlepage', header: 'number', numberTitlePage: false, titleLine: null, date: 'dmy',
    headings: { 1: { align: 'left', bold: true }, 2: { align: 'left', bold: true, italic: true }, 3: { align: 'left', italic: true } },
    quote: { spacing: 1.5 }, notes: false,
    refs: { title: 'Reference list', bold: true, align: 'left', hanging: false, spacing: 1.5, gap: true },
    fields: ['name', 'school', 'course', 'instructor', 'date'],
  },
};
export const STYLE_IDS = Object.keys(STYLES);
export const styleOf = (id) => STYLES[id] || STYLES.mla;

export const FONTS = ['Times New Roman', 'Georgia', 'Arial', 'Calibri', 'Garamond'];
export const SPACINGS = [1, 1.15, 1.5, 2];
/** What each detail is called in the form. */
export const FIELD_LABELS = { title: 'Title', name: 'Your name', school: 'School or department', course: 'Course', instructor: 'Instructor', date: 'Date' };

/** Letter paper at 96 px per inch, 1-inch margins (all four styles). */
export const PAGE = { width: 816, height: 1056, margin: 96 };

/** The style with this essay's own choices (font, size, spacing) laid over it. */
export function setupOf(essay) {
  const s = styleOf(essay && essay.style);
  const o = (essay && essay.format) || {};
  // the font is one of FONTS (it's synced data, and it goes into the print page's CSS): anything else is the style's own
  return { ...s, font: FONTS.includes(o.font) ? o.font : s.font, size: Number(o.size) || s.size, spacing: Number(o.spacing) || s.spacing };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** 'YYYY-MM-DD' as the style writes it ("9 October 2026" or "October 9, 2026"); '' stays ''. */
export function formatDate(iso, style) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return String(iso || '').trim();
  const [y, mo, d] = [Number(m[1]), MONTHS[Number(m[2]) - 1], Number(m[3])];
  if (!mo) return String(iso);
  return styleOf(style).date === 'dmy' ? `${d} ${mo} ${y}` : `${mo} ${d}, ${y}`;
}
/** Today as 'YYYY-MM-DD' in local time. */
export function today(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** The surname for MLA's running header: the name's last word ("Ana María López" → "López"). */
export const lastName = (name) => String(name || '').trim().split(/\s+/).filter(Boolean).at(-1) || '';

/** The running header on page `n` ('' when that page has none, like Chicago's title page). */
export function headerText(essay, n) {
  const s = styleOf(essay.style);
  if (s.front === 'titlepage' && !s.numberTitlePage && n === 1) return '';
  return s.header === 'name' ? `${lastName(essay.details && essay.details.name)} ${n}`.trim() : String(n);
}

/**
 * The essay's front matter from its details: { kind: 'heading' | 'titlepage', lines: [{ text, bold, align, space }] }.
 * space: blank double-spaced lines before this one (the title page's layout). Missing details are left
 * out, except the title, which shows a placeholder in the editor (`placeholder: true`).
 */
export function frontMatter(essay) {
  const s = styleOf(essay.style);
  const d = essay.details || {};
  const date = formatDate(d.date || today(), s.id); // undated: today, following the day until one is set
  const title = String(d.title || '').trim();
  const T = (extra) => ({ text: title || 'Untitled essay', placeholder: !title, align: 'center', ...extra });
  const line = (text, extra = {}) => (String(text || '').trim() ? { text: String(text).trim(), align: 'center', ...extra } : null);
  let lines;
  if (s.front === 'heading') {
    lines = [d.name, d.instructor, d.course, date].map((x) => line(x, { align: 'left' }));
    return { kind: 'heading', lines: lines.filter(Boolean) };
  }
  // two groups, the title and the author's lines, each with the blank lines before it; the gap goes on
  // the group's first line that's there
  const who = s.id === 'chicago' ? [d.name, d.course, d.instructor, date] : [d.name, d.school, d.course, d.instructor, date];
  const [gapTitle, gapWho] = s.id === 'apa' ? [3, 1] : s.id === 'chicago' ? [6, 8] : [6, 2];
  const people = who.map((x) => line(x)).filter(Boolean);
  if (people.length) people[0] = { ...people[0], space: gapWho };
  lines = [T({ bold: s.id !== 'chicago', space: gapTitle }), ...people];
  return { kind: 'titlepage', lines };
}

/** The title above the text on page 1 (MLA plain, APA bold), or null. */
export function titleLine(essay) {
  const s = styleOf(essay.style);
  if (!s.titleLine) return null;
  const title = String((essay.details && essay.details.title) || '').trim();
  return { text: title || 'Untitled essay', placeholder: !title, bold: s.titleLine === 'bold', align: 'center' };
}

// ── the body (Tiptap's JSON document) ──

/** Every text node of the body in order, with footnotes' own text left out. */
export function bodyText(doc) {
  const out = [];
  const walk = (n, inBlock) => {
    if (!n) return;
    if (n.type === 'text') { out.push(n.text || ''); return; }
    if (n.type === 'footnote' || n.type === 'hardBreak') { out.push(' '); return; }
    for (const c of n.content || []) walk(c, true);
    if (inBlock && n.type !== 'text' && n.content) out.push('\n');
  };
  walk(doc, false);
  return out.join('').replace(/\n{2,}/g, '\n').trim();
}

/** Words as a teacher counts them: letters/digits with inner apostrophes and hyphens ("don't", "well-known") as one. */
export const countWords = (text) => (String(text || '').match(/[\p{L}\p{N}]+(?:['’‑-][\p{L}\p{N}]+)*/gu) || []).length;

/** The footnotes' texts in order. */
export function footnotesIn(doc) {
  const out = [];
  const walk = (n) => { if (!n) return; if (n.type === 'footnote') out.push(String((n.attrs && n.attrs.text) || '')); for (const c of n.content || []) walk(c); };
  walk(doc);
  return out;
}

/** The headings, for the outline: [{ level, text, index }] (index: the block's position in the body). */
export function outlineOf(doc) {
  return ((doc && doc.content) || []).map((n, index) => ({ n, index }))
    .filter(({ n }) => n.type === 'heading')
    .map(({ n, index }) => ({ level: (n.attrs && n.attrs.level) || 1, text: bodyText(n), index }));
}

/** An essay's word count and its share of the goal: { words, goal, pct }. */
export function progress(essay) {
  const words = countWords(bodyText(essay.doc));
  const goal = Math.max(0, Number(essay.goal) || 0);
  return { words, goal, pct: goal ? Math.min(100, Math.round((words / goal) * 100)) : 0 };
}

let n = 0;
const newId = () => `es_${Date.now().toString(36)}${(n++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A new, empty essay in a style, dated today (the date follows the day until the person sets one). */
export function newEssay(style = 'mla', details = {}) {
  const now = Date.now();
  return {
    id: newId(), created: now, updated: now, style: STYLES[style] ? style : 'mla',
    details: { title: '', name: '', school: '', course: '', instructor: '', date: '', ...details },
    format: {}, goal: 0, doc: { type: 'doc', content: [{ type: 'paragraph' }] }, sources: [],
  };
}

/** The date the essay shows: the one set, or today. */
export const essayDate = (essay, now) => (essay.details && essay.details.date) || today(now);

/** A file name: the title's words, else "essay". */
export const essayFileName = (essay, ext) => `${String((essay.details && essay.details.title) || '').trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').slice(0, 80) || 'Essay'}.${ext}`;

/** What Eden is asked for feedback: margin-comment style notes on the essay, not a rewrite. */
export function feedbackRequest(essay, text, { inline = true } = {}) {
  const s = styleOf(essay.style);
  const title = String((essay.details && essay.details.title) || '').trim();
  const ask = `Give me feedback on my essay${title ? ` “${title}”` : ''} (${s.long}) as a list of short margin comments: the argument and thesis, evidence, `
    + 'counterarguments, structure and transitions, clarity and tone. Quote the sentence each comment is about. Don’t rewrite the essay for me.';
  // open beside the chat, the essay is already in what Eden sees (eden-tools.js essayOpenSystem): not sent twice (T20c)
  return inline ? `${ask}\n\n\`\`\`text\n${String(text || '').slice(0, 60_000)}\n\`\`\`` : `${ask} It’s the essay open beside this chat.`;
}

// ── Eden writing in the essay (eden-tools.js essay_write / essay_edit, essay.js applies them) ──

/** Inline text with *italic* and **bold** as Tiptap text nodes. */
export function inlineNodes(text, { cite = null } = {}) {
  const out = [];
  // [@key] or [@key, p. 12] (or "pp. 12-14", "12"): a citation of the essay's source with that key (eden-tools.js
  // essayOpenSystem); `cite(key)` gives the source's id, else the marker stays as text, for the person to see
  const re = /(\[@([\w.-]+)(?:\s*[,;]?\s*(?:pp?\.?\s*)?([\w–-]+))?\]|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|_([^_\n]+)_)/g;
  const s = String(text || '');
  let i = 0, m;
  const push = (t, marks) => { if (t) out.push(marks ? { type: 'text', text: t, marks } : { type: 'text', text: t }); };
  while ((m = re.exec(s))) {
    push(s.slice(i, m.index));
    if (m[2]) {
      const sid = cite && cite(m[2]);
      if (sid) {
        // the citation goes right after the word it follows: no space left before it in notes styles' marks
        out.push({ type: 'cite', attrs: { sid, page: (m[3] || '').replace(/-/g, '–') } });
      } else push(m[0]);
    } else if (m[4]) push(m[4], [{ type: 'bold' }]);
    else push(m[5] || m[6], [{ type: 'italic' }]);
    i = m.index + m[0].length;
  }
  push(s.slice(i));
  return out;
}

const inlineAll = (x, opts) => inlineNodes(x, opts);
/** Text as Eden writes it (blank-line paragraphs, "## " headings, "> " quotes, "- " / "1. " lists) as Tiptap blocks; `opts.cite` as inlineNodes. */
export function textToBlocks(text, opts = {}) {
  const inlineNodes = (x) => inlineAll(x, opts);
  const blocks = [];
  for (const chunk of String(text || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const t = chunk.trim();
    if (!t) continue;
    const h = /^(#{1,3})\s+(.+)$/s.exec(t);
    if (h) { blocks.push({ type: 'heading', attrs: { level: h[1].length }, content: inlineNodes(h[2].replace(/\s*\n\s*/g, ' ')) }); continue; }
    const lines = t.split('\n');
    if (lines.every((l) => /^\s*>/.test(l))) {
      blocks.push({ type: 'blockquote', content: [{ type: 'paragraph', content: inlineNodes(lines.map((l) => l.replace(/^\s*>\s?/, '')).join(' ')) }] });
      continue;
    }
    const bullet = lines.every((l) => /^\s*[-*•]\s+/.test(l)), numbered = lines.every((l) => /^\s*\d+[.)]\s+/.test(l));
    if (bullet || numbered) {
      blocks.push({ type: bullet ? 'bulletList' : 'orderedList', content: lines.map((l) => ({ type: 'listItem', content: [{ type: 'paragraph', content: inlineNodes(l.replace(/^\s*([-*•]|\d+[.)])\s+/, '')) }] })) });
      continue;
    }
    blocks.push({ type: 'paragraph', content: inlineNodes(lines.join(' ').replace(/^#+\s*/, '')) });
  }
  return blocks;
}

/** The body's blocks for Eden, numbered from 1: [{ n, kind, text }] (footnotes and citations shown as markers). */
export function blocksOf(doc, citeLabel = () => 'citation') {
  const txt = (n) => {
    if (!n) return '';
    if (n.type === 'text') return n.text || '';
    if (n.type === 'footnote') return `[footnote: ${(n.attrs && n.attrs.text) || ''}]`;
    if (n.type === 'cite') return `[${citeLabel(n.attrs || {})}]`;
    if (n.type === 'hardBreak') return ' ';
    const inner = (n.content || []).map(txt);
    return n.type === 'listItem' ? `- ${inner.join(' ')}` : inner.join(n.type === 'bulletList' || n.type === 'orderedList' || n.type === 'blockquote' ? '\n' : '');
  };
  const kind = (n) => (n.type === 'heading' ? `heading ${(n.attrs && n.attrs.level) || 1}` : n.type === 'blockquote' ? 'block quote' : n.type === 'bulletList' || n.type === 'orderedList' ? 'list' : 'p');
  return ((doc && doc.content) || []).map((n, i) => ({ n: i + 1, kind: kind(n), text: txt(n) })).filter((b) => b.text.trim() || b.kind !== 'p' || b.n === 1);
}

// ── "Paste into essay" (a reply's button, render.js): the essay in a chat reply, without the chat ──

const CHATTER_START = /^(sure|certainly|of course|absolutely|okay|ok|great|alright|no problem|happy to|glad to|here(?:'s|’s| is| are)|below (?:is|are)|i(?:'ve|’ve| have)? (?:written|drafted|put together|revised|rewritten|created|wrote|drafted|put|placed|added|inserted|titled|kept|aimed)|i (?:wrote|drafted|revised)|this (?:essay|draft|version)|as requested|done\b)\b/i;
const CHATTER_END = /^(let me know|i hope|hope this|feel free|would you like|if you(?:'d|’d| would)? like|if you want|want me to|do you want|happy to|i can also|i could also|shall i|need any|any (?:changes|questions)|note:|word count|\(word count|\(?approximately \d+ words|this (?:essay|draft) (?:is|has|comes)|before (?:you )?submit|please (?:check|verify|double-check|review|make sure|confirm)|make sure|remember to|a few (?:notes|things)|things to (?:check|verify)|next steps|tips?:)/i;
// After a reference list: the chat that follows it ("**Before you submit:**", "Please check…"), never a reference
const NOT_A_REF = /^(?:\*\*|__)?\s*(?:before (?:you )?submit|please|note|notes|remember|make sure|check|verify|tips?|next steps|a few|i |i'|i’|let me|if you|feel free|you (?:can|may|should|might)|these|this list|all (?:of )?these|disclaimer|caution|important)\b/i;
const LOOKS_LIKE_REF = /\(\d{4}[a-z]?\)|\b(1[5-9]\d\d|20\d\d)\b|\bn\.d\.|https?:\/\/|\bdoi\b|\b10\.\d{4,}\//i;
const TOOL_BLOCKS = /<eden-(?:tool|essay(?:-[a-z]+)?)\b[\s\S]*?(?:<\/eden-(?:tool|essay(?:-[a-z]+)?)>|$)|<invoke\b[\s\S]*?(?:<\/invoke>|$)|<\/?function_calls>/g;
const REFS_HEAD = /^(?:#{1,6}\s*)?(?:\*\*|__)?\s*(works cited|references?|bibliography|reference list|sources|citations|works consulted)\s*:?\s*(?:\*\*|__)?\s*:?$/i;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const PLACEHOLDER = /^\s*\[[^\]\n]{1,60}\]\s*$/; // "[Your Name]", "[Instructor’s Name]"
const BOLD_LINE = /^\s*(?:\*\*|__)([^*_\n]{1,120})(?:\*\*|__)\s*$/;
const stripMd = (s) => String(s).replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(\*|_)(.+?)\1/g, '$2').replace(/`([^`]+)`/g, '$1').trim();

/**
 * A chat reply as essay material: { title, body, references, words }. Drops the chat around the essay
 * ("Sure, here is a 300-word essay…", "Let me know if…"), rules, placeholder heading lines ("[Your Name]"),
 * and code fences; takes a leading "# Title" / "**Title**" / "Title: …" as the title; moves a Works Cited /
 * References list out of the text (each entry a source); makes bold-only lines headings, the top level "# ".
 */
export function essayFromReply(md) {
  let s = String(md || '').replace(/\r\n?/g, '\n').replace(TOOL_BLOCKS, '');
  s = s.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*$/gm, ''); // fences go, their text stays
  let paras = s.split(/\n\s*\n/).map((p) => p.split('\n').filter((l) => !PLACEHOLDER.test(l) && !RULE.test(l)).join('\n').trim()).filter(Boolean);
  const words = (p) => countWords(stripMd(p));
  while (paras.length > 1 && words(paras[0]) <= 60 && (CHATTER_START.test(stripMd(paras[0])) || (/:\s*$/.test(paras[0]) && !/^#/.test(paras[0]) && words(paras[0]) <= 30))) paras.shift();
  while (paras.length > 1 && words(paras.at(-1)) <= 60 && CHATTER_END.test(stripMd(paras.at(-1)).replace(/^[*_(\s]+/, ''))) paras.pop();
  // the title: the first paragraph, when it is a heading, a bold line or "Title: …"
  let title = '';
  const first = paras[0] || '';
  const tm = /^#{1,2}\s+(.+)$/.exec(first) || BOLD_LINE.exec(first) || /^title\s*:\s*(.+)$/i.exec(first);
  if (tm && !first.includes('\n') && !REFS_HEAD.test(first) && paras.length > 1) { title = stripMd(tm[1]).replace(/[:.]\s*$/, ''); paras.shift(); }
  // the reference list: everything after its heading
  const references = [];
  const ri = paras.findIndex((p) => REFS_HEAD.test(p.split('\n')[0].trim()));
  if (ri >= 0) {
    const [head, ...restOfFirst] = paras[ri].split('\n');
    void head;
    refs: for (const p of [restOfFirst.join('\n'), ...paras.slice(ri + 1)]) {
      const lines = p.split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.length) continue;
      if (NOT_A_REF.test(stripMd(lines[0])) || BOLD_LINE.test(lines[0]) || CHATTER_END.test(stripMd(lines[0]).replace(/^[*_(\s]+/, ''))) break; // the chat after the list
      const listy = lines.length > 1 && lines.every((l) => /^([-*•]|\d+[.)])\s+/.test(l));
      for (const entry of listy || lines.length > 1 && lines.every((l) => /\.\s*$|\d{4}|https?:/.test(l)) ? lines : [lines.join(' ')]) {
        const bare = entry.replace(/^([-*•]|\d+[.)])\s+/, '');
        if (NOT_A_REF.test(stripMd(bare))) break refs;
        // the entry keeps its *italic* title (essay-cite.js sets it in italics); bold, code and links go
        const t = bare.replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_, a, u) => (a === u ? u : `${a} ${u}`)).trim();
        if (t && LOOKS_LIKE_REF.test(t) && countWords(stripMd(t)) >= 3) references.push(t);
      }
    }
    paras = paras.slice(0, ri);
  }
  // a trailing label ("**Before you submit:**", "Notes:") and the list or short lines under it: the chat, not the essay
  for (let i = paras.length - 1; i > 0; i--) {
    const head = stripMd(paras[i].split('\n')[0]).replace(/^[*_(\s]+/, '');
    const label = /:\s*$/.test(head) || BOLD_LINE.test(paras[i].split('\n')[0]);
    if (label && countWords(head) <= 12 && (NOT_A_REF.test(head) || CHATTER_END.test(head)) && paras.slice(i + 1).every((p) => /^\s*([-*•]|\d+[.)])\s+/.test(p) || words(p) <= 60)) { paras = paras.slice(0, i); break; }
  }
  // headings: bold-only lines become headings; the top level used becomes "# "
  paras = paras.map((p) => { const b = BOLD_LINE.exec(p); return b && !p.includes('\n') ? `# ${b[1].replace(/:\s*$/, '')}` : p; });
  const levels = paras.map((p) => (/^(#{1,6})\s/.exec(p) || [])[1]).filter(Boolean).map((h) => h.length);
  const shift = levels.length ? Math.min(...levels) - 1 : 0;
  if (shift) paras = paras.map((p) => p.replace(/^(#{1,6})(\s)/, (m, h, sp) => `${'#'.repeat(Math.max(1, Math.min(3, h.length - shift)))}${sp}`));
  const body = paras.join('\n\n');
  return { title, body, references, words: countWords(stripMd(body)) };
}

/** What a title-only model call is told (essay.js maybeTitle). */
export const TITLE_SYSTEM = 'You title student essays. Reply with one title for the essay the user sends: specific to its argument, at most 12 words, in title case, no quotation marks, no period at the end, and nothing else.';
/** A model's reply as a title: its first line without "Title:", quotes, markdown or a final period ('' when unusable). */
export function cleanTitle(text) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  const t = line.replace(/^title\s*:\s*/i, '').replace(/^(#+\s*|\*\*|__)/, '').replace(/(\*\*|__)$/, '').replace(/^title\s*:\s*/i, '').replace(/^["“'‘]+|["”'’]+$/g, '').replace(/\.\s*$/, '').trim();
  return t.length >= 3 && t.length <= 150 && countWords(t) <= 20 ? t : '';
}

// ── a dropped rubric or assignment sheet (composer.js eden:attached → essay.js startFromRubric) ──

/**
 * Is this file an essay assignment? { style, goal, minWords, maxWords, name, text } or null. It must be
 * about an essay or paper and read like an assignment: a rubric/requirements/criteria/prompt word, a
 * word count, or a citation style. The style is the one it names (MLA, APA, Chicago or Turabian,
 * Harvard); the goal is the word count it asks for (the top of a range).
 */
export function rubricOf(name, text) {
  const t = String(text || '');
  const all = `${name || ''}\n${t}`;
  if (t.trim().length < 80) return null;
  const essayish = /\b(essay|paper|composition|research paper|argumentative|persuasive|thesis)\b/i.test(all);
  // "1,500 words", "1000-1500 words", "between 1,000 and 1,500 words", "a 500-word essay"
  const words = /\b(\d{1,2}[,.]?\d{3}|\d{3,4})\s*(?:(?:-|–|—|to|and)\s*(\d{1,2}[,.]?\d{3}|\d{3,4})\s*)?[-\s]?words?\b/i.exec(t);
  const styleM = /\b(MLA|APA|Chicago|Turabian|Harvard)\b/i.exec(t);
  const assignment = /\b(rubric|assignment|requirements?|criteria|grading|prompt|instructions|guidelines|points|due)\b/i.test(all);
  if (!essayish || !(assignment || words || styleM)) return null;
  const n = (s) => Number(String(s || '').replace(/[,.]/g, '')) || 0;
  const lo = words ? n(words[1]) : 0, hi = words ? n(words[2]) || lo : 0;
  const style = styleM ? ({ mla: 'mla', apa: 'apa', chicago: 'chicago', turabian: 'chicago', harvard: 'harvard' })[styleM[1].toLowerCase()] : '';
  return { name: String(name || 'Assignment'), text: t.slice(0, 20_000), style, goal: hi || 0, minWords: lo && hi && lo !== hi ? lo : 0, maxWords: hi || 0 };
}

/** What Eden is asked by "Check against the rubric": a score per criterion, comments, no rewrite. */
export function rubricRequest(essay, text, { inline = true } = {}) {
  const r = essay.rubric || {};
  const ask = 'Check my essay against the assignment\'s rubric. For each criterion, give a likely score or level and one or two sentences on why, quoting my essay; then the three changes that would raise the grade most. Don’t rewrite the essay.';
  // open beside the chat, the essay and its rubric are already in what Eden sees: not sent twice (T20c)
  if (!inline) return `${ask} It’s the essay open beside this chat, with its rubric.`;
  return `${ask}\n\nThe rubric (${r.name || 'assignment'}):\n\`\`\`text\n${String(r.text || '').slice(0, 20_000)}\n\`\`\`\n\nMy essay:\n\`\`\`text\n${String(text || '').slice(0, 60_000)}\n\`\`\``;
}

// ── how much an essay turn writes (T18b, T19f): sent to the server as `essay.words`, and checked after ──

const NUM = '(\\d{1,2}[,.\\s]?\\d{3}|\\d{2,4})';
const wordNum = (x) => Number(String(x || '').replace(/[,.\s]/g, '')) || 0;
/**
 * What a message to Eden about the open essay asks it to write: { kind, words (to expect), min, max (a length asked
 * for, else 0), whole (a full draft: the essay's own length is what counts) }. `ctx`: { words (the essay now),
 * goal, rubric: { minWords, maxWords }, selection (its text) }.
 */
export function essayAsk(message, ctx = {}) {
  const t = String(message || '');
  const have = Number(ctx.words) || 0;
  if (/\b(feedback|critique|comments?|grade|score|check (?:it|my essay|this)|rubric|what do you think|how (?:is|does) (?:it|my essay))\b/i.test(t) && !/\b(write|draft|rewrite|add|expand)\b/i.test(t)) return { kind: 'feedback', words: 700, min: 0, max: 0, whole: false };
  const range = new RegExp(`${NUM}\\s*(?:-|–|—|to|and)\\s*${NUM}\\s*-?\\s*words?\\b`, 'i').exec(t);
  const one = range ? null : new RegExp(`${NUM}\\s*-?\\s*words?\\b`, 'i').exec(t);
  const pages = range || one ? null : /\b(\d{1,2})\s*-?\s*pages?\b/i.exec(t);
  const whole = /\b(?:write|draft|compose|do|finish)\b[^.?!\n]{0,40}\b(?:the|my|an?|whole|full|entire|complete|first)\b[^.?!\n]{0,20}\b(?:essay|paper|draft|thing)\b|\bdraft it\b|\bwrite it(?: for me)?\b|\b(?:whole|full|entire|complete) (?:essay|paper|draft)\b/i.test(t) || (!have && /\b(essay|paper)\b/i.test(t) && /\b(write|draft)\b/i.test(t));
  const expand = /\b(expand|lengthen|make it longer|longer)\b/i.test(t);
  let min = 0, max = 0;
  if (range) { min = wordNum(range[1]); max = wordNum(range[2]); }
  else if (one) { min = wordNum(one[1]); max = Math.round(min * 1.1); }
  else if (pages) { min = wordNum(pages[1]) * 275; max = Math.round(min * 1.15); } // a double-spaced page
  else if (whole || (expand && have)) {
    const r = ctx.rubric || {};
    min = Number(r.minWords) || Number(ctx.goal) || Number(r.maxWords) || 0;
    max = Number(r.maxWords) || (min ? Math.round(min * 1.1) : 0);
  }
  const asked = Boolean(min);
  // a full draft or "expand it to N": the essay's own length is the target; "add 300 words": what's added
  const isWhole = whole || (expand && asked);
  let words;
  if (asked) words = isWhole ? Math.max(150, max || min) - (whole && !expand ? 0 : have) : max || min;
  else if (whole) words = 1000;
  else if (expand) words = Math.max(300, Math.round(have * 0.5));
  else if (ctx.selection && /\b(this|selection|selected|it|here)\b|^\s*(make|rewrite|rephrase|shorten|fix|improve|tighten|simplify|reword)/i.test(t)) words = Math.max(80, Math.round(countWords(ctx.selection) * 1.3));
  else if (/\b(continue|keep going|go on|next paragraph|another paragraph|one more paragraph)\b/i.test(t)) words = 300;
  else if (/\b(intro(?:duction)?|conclu(?:sion|de)|thesis|hook|topic sentence)\b/i.test(t)) words = 250;
  else words = 400;
  // how the length was asked, for "you asked for …" (tools-ui.js): their own words' number, or where it came from
  const said = !asked ? '' : range ? `${min.toLocaleString('en-US')}–${max.toLocaleString('en-US')}` : one ? min.toLocaleString('en-US') : pages ? `${pages[1]} page${pages[1] === '1' ? '' : 's'} (about ${min.toLocaleString('en-US')} words)`
    : (ctx.rubric || {}).maxWords ? `${(Number(ctx.rubric.minWords) || Number(ctx.rubric.maxWords)).toLocaleString('en-US')}${Number(ctx.rubric.minWords) && Number(ctx.rubric.minWords) !== Number(ctx.rubric.maxWords) ? `–${Number(ctx.rubric.maxWords).toLocaleString('en-US')}` : ''} (the rubric)` : `${min.toLocaleString('en-US')} (your goal)`;
  return { kind: 'write', words: Math.max(30, Math.min(6000, Math.round(words))), min: asked ? min : 0, max: asked ? max : 0, whole: Boolean(isWhole && asked), said };
}
