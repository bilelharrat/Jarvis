// Saved workflows' pure part (ROADMAP H9; workflows.js is the page): a conversation turned into
// a reusable recipe, and a recipe filled in for a run. No DOM, no imports: the askeden tests
// load it as it is (src/__tests__/workflows.test.ts).
//
// A workflow: { id, name, template, blanks: [{ key, label, sample, required }], level, model,
// effort, mode, slots: [{ name, kind: 'image'|'text', optional: true }], created, updated,
// source: { title }, deleted? }. The template is the owner's prompt with {blanks} where the
// parts that change from one run to the next were (a quoted phrase, a link, an address, a date,
// a name); the owner edits all of it before saving.

export const BLANK = /\{([a-z][a-z0-9_]{0,30})\}/g;
export const MAX_TEMPLATE = 8000;
export const MAX_BLANKS = 12;
export const MAX_SLOTS = 6;

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';
const DAYS = 'Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday';
// What usually changes between runs, in the order it's looked for (the first match of a span wins).
const FINDERS = [
  { key: 'link', label: 'Link', re: /\bhttps?:\/\/[^\s<>"')\]]+/g },
  { key: 'email', label: 'Email address', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  { key: 'date', label: 'Date', re: new RegExp(`\\b(?:\\d{4}-\\d{2}-\\d{2}|(?:${MONTHS})\\.? \\d{1,2}(?:st|nd|rd|th)?(?:,? \\d{4})?|\\d{1,2}(?:st|nd|rd|th)? (?:${MONTHS})(?: \\d{4})?|(?:next |this )?(?:${DAYS})|today|tomorrow|yesterday)\\b`, 'gi') },
  { key: 'text', label: 'Quoted text', re: /"([^"\n]{2,200})"|“([^”\n]{2,200})”|'([^'\n]{3,200})'/g, inner: true },
  { key: 'name', label: 'Name', re: /\b(?:[A-Z][a-z]+|[A-Z]{2,})(?:\s+(?:[A-Z][a-z]+|[A-Z]{2,})){0,3}\b/g },
];
// Capitalised words that aren't names on their own.
const NOT_NAMES = new Set(['I', 'I’m', 'I\'m', 'OK', 'Please', 'Can', 'Could', 'Would', 'What', 'Write', 'Make', 'Give', 'Tell', 'Summarize', 'Summarise', 'Draft', 'The', 'A', 'An', 'Use', 'List', 'Find', 'Explain', 'Help', 'Translate', 'Then', 'And', 'For', 'In', 'On', 'At', 'Email', 'AI', 'PDF', 'URL', 'FAQ', 'TL', 'DR', 'Eden']);

const clean = (s) => String(s ?? '').replace(/\r\n?/g, '\n');
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'blank';

/** The {keys} a template uses, once each, in order. */
export function blanksIn(template) {
  const out = [];
  for (const m of clean(template).matchAll(BLANK)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/**
 * Spans worth a {blank} in `text`: [{ start, end, value, key, label }], not overlapping, in
 * order. A heuristic: the owner sees and edits every one before saving.
 */
export function findBlanks(text) {
  const s = clean(text);
  const spans = [];
  const taken = (a, b) => spans.some((x) => a < x.end && b > x.start);
  for (const f of FINDERS) {
    f.re.lastIndex = 0;
    for (const m of s.matchAll(f.re)) {
      let value = m[0];
      let start = m.index;
      if (f.inner) {
        value = m[1] ?? m[2] ?? m[3];
        start = m.index + m[0].indexOf(value);
      }
      value = value.replace(/[.,;:!?]+$/, '');
      const end = start + value.length;
      if (!value.trim() || taken(start, end)) continue;
      if (f.key === 'name') {
        const words = value.split(/\s+/);
        if (words.length === 1 && (NOT_NAMES.has(value) || value.length < 3)) continue;
        if (NOT_NAMES.has(words[0]) && words.length === 1) continue;
        // a sentence's first word is a capital anyway: only names past it
        const before = s.slice(Math.max(0, start - 2), start);
        if (start === 0 || /[.!?\n]\s*$/.test(before) || before === '') continue;
      }
      spans.push({ start, end, value, key: f.key, label: f.label });
      if (spans.length >= MAX_BLANKS) break;
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** `text` with each span replaced by a {key} (numbered when a kind repeats); and the blanks. */
export function templateFrom(text, spans = findBlanks(text)) {
  const s = clean(text);
  const blanks = [];
  const used = new Map();
  let out = '';
  let at = 0;
  for (const sp of spans) {
    const same = blanks.find((b) => b.sample === sp.value);
    let key = same ? same.key : sp.key;
    if (!same) {
      const n = (used.get(sp.key) || 0) + 1;
      used.set(sp.key, n);
      key = n === 1 ? sp.key : `${sp.key}_${n}`;
      blanks.push({ key, label: n === 1 ? sp.label : `${sp.label} ${n}`, sample: sp.value, required: true });
    }
    out += `${s.slice(at, sp.start)}{${key}}`;
    at = sp.end;
  }
  out += s.slice(at);
  return { template: out, blanks };
}

/**
 * A conversation as a recipe. `conv`: { title, messages: [{ role, content, attachments?:
 * [{ kind, name }] }], route?: { model, effort }, level?, mode? } (the page passes its path).
 * The first message the owner wrote is the template; its attachments become optional slots.
 */
export function extractWorkflow(conv, { now = Date.now(), id } = {}) {
  const msgs = Array.isArray(conv && conv.messages) ? conv.messages : [];
  const first = msgs.find((m) => m && m.role === 'user' && (String(m.content || '').trim() || (m.attachments || []).length));
  if (!first) return null;
  const { template, blanks } = templateFrom(String(first.content || '').slice(0, MAX_TEMPLATE));
  const slots = (first.attachments || [])
    .filter((a) => a && (a.kind === 'image' || a.kind === 'text'))
    .slice(0, MAX_SLOTS)
    .map((a, i) => ({ name: String(a.name || `${a.kind === 'image' ? 'Picture' : 'File'} ${i + 1}`).slice(0, 80), kind: a.kind, optional: true }));
  const route = conv.route || null;
  return {
    id: id || `wf_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    name: String(conv.title || '').trim().slice(0, 80) || template.split('\n')[0].slice(0, 60) || 'Workflow',
    template,
    blanks,
    level: Number.isInteger(conv.level) && conv.level >= 1 && conv.level <= 5 ? conv.level : 3,
    model: route && typeof route.model === 'string' ? route.model : null,
    effort: route && typeof route.effort === 'string' ? route.effort : null,
    mode: ['chat', 'search', 'research'].includes(conv.mode) ? conv.mode : 'chat',
    slots,
    created: now,
    updated: now,
    source: { title: String(conv.title || '').slice(0, 120) },
  };
}

/** The workflow checked (what the gallery stores); throws an Error with words for a person. */
export function checkWorkflow(w) {
  if (!w || typeof w !== 'object') throw new Error('Not a workflow.');
  const name = String(w.name || '').trim().slice(0, 80);
  if (!name) throw new Error('Give the workflow a name.');
  const template = clean(w.template);
  if (!template.trim()) throw new Error('The prompt can’t be empty.');
  if (template.length > MAX_TEMPLATE) throw new Error('The prompt is at most 8,000 characters.');
  const keys = blanksIn(template);
  if (keys.length > MAX_BLANKS) throw new Error(`At most ${MAX_BLANKS} blanks.`);
  const known = new Map((Array.isArray(w.blanks) ? w.blanks : []).map((b) => [b.key, b]));
  const blanks = keys.map((key) => {
    const b = known.get(key) || {};
    return { key, label: String(b.label || key.replace(/_/g, ' ')).slice(0, 60), sample: String(b.sample ?? '').slice(0, 400), required: b.required !== false };
  });
  const slots = (Array.isArray(w.slots) ? w.slots : []).slice(0, MAX_SLOTS).map((s) => ({ name: String(s.name || 'File').slice(0, 80), kind: s.kind === 'image' ? 'image' : 'text', optional: true }));
  return {
    ...w,
    name,
    template,
    blanks,
    slots,
    level: Number.isInteger(w.level) && w.level >= 1 && w.level <= 5 ? w.level : 3,
    model: typeof w.model === 'string' && w.model ? w.model : null,
    effort: typeof w.effort === 'string' && w.effort ? w.effort : null,
    mode: ['chat', 'search', 'research'].includes(w.mode) ? w.mode : 'chat',
  };
}

/** The prompt for one run: { text, missing: [labels] }. Values are put in as written. */
export function fillTemplate(w, values = {}) {
  const missing = [];
  const byKey = new Map((w.blanks || []).map((b) => [b.key, b]));
  const text = clean(w.template).replace(BLANK, (m, key) => {
    const v = values[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    const b = byKey.get(key);
    if (!b || b.required !== false) missing.push(b ? b.label : key);
    return '';
  });
  return { text: text.replace(/[ \t]{2,}/g, ' ').trim(), missing: [...new Set(missing)] };
}

/** Two copies of the gallery as one: by id, the newer `updated` wins; deletions are kept as tombstones. */
export function mergeWorkflows(mine = [], theirs = []) {
  const out = new Map();
  for (const w of [...mine, ...theirs]) {
    if (!w || typeof w.id !== 'string') continue;
    const had = out.get(w.id);
    if (!had || (w.updated || 0) > (had.updated || 0)) out.set(w.id, w);
  }
  return [...out.values()].sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

/** A slug for a blank the owner names ("Client name" → client_name). */
export const blankKey = (label) => slug(label);
