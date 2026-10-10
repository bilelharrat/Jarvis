// Import from Gemini, the pure part (no DOM, no network). Gemini's history leaves Google through
// Takeout as "My Activity › Gemini Apps": MyActivity.json (or MyActivity.html), one entry per
// prompt with Gemini's answer as HTML. Takeout doesn't say which prompts were one chat, so prompts
// less than SESSION_GAP apart become one conversation (the first prompt names it). The answer's
// HTML is turned into Markdown here, as text: nothing in it is ever put on a page as HTML, and
// Eden renders the result with its own safe Markdown renderer.

export const SOURCE = 'gemini';
export const SESSION_GAP = 30 * 60 * 1000; // a longer pause starts a new conversation
export const SESSION_MAX = 80; // prompts in one conversation at most
const MAX_TEXT = 200_000;

/* ---------- which files ---------- */

const ACTIVITY = /(^|\/)MyActivity\.(json|html?)$/i;
/** The My Activity files in a Takeout zip, Gemini's (or Bard's) first; [] when there are none. */
export function geminiActivityEntries(entries) {
  const all = entries.filter((e) => ACTIVITY.test(e.name));
  const gem = all.filter((e) => /gemini|bard/i.test(e.name));
  const pool = gem.length ? gem : all;
  // the JSON when Takeout made both
  const json = pool.filter((e) => /\.json$/i.test(e.name));
  return json.length ? json : pool;
}

/** One My Activity entry is Gemini's. */
export const isGeminiEntry = (x) => Boolean(x && typeof x === 'object' && (
  /gemini|bard/i.test(String(x.header || '')) || (Array.isArray(x.products) && x.products.some((p) => /gemini|bard/i.test(String(p))))));

/** A JSON value that looks like My Activity (an array of { header, title, time }). */
export const looksLikeActivity = (x) => Boolean(x && typeof x === 'object' && typeof x.title === 'string' && typeof x.time === 'string' && ('header' in x || 'products' in x));

/* ---------- HTML → Markdown (as text; never parsed into a page) ---------- */

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', emsp: ' ', ensp: ' ', thinsp: ' ', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', times: '×', divide: '÷', deg: '°', euro: '€', pound: '£', laquo: '«', raquo: '»' };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

const TOKEN = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|([^<]+)|(<)/g;
const attr = (attrs, name) => { const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs || ''); return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : ''; };
const SKIP = new Set(['script', 'style', 'head', 'title', 'template', 'noscript', 'iframe', 'object', 'svg', 'math', 'button', 'select', 'textarea']);

/**
 * HTML (Gemini's answer) → Markdown text: paragraphs, line breaks, headings, bold/italic, inline and
 * block code, lists (nested), links (http/https only), quotes, rules and simple tables. Scripts,
 * styles and anything unknown contribute only their text.
 */
export function htmlToMarkdown(html) {
  const out = [];
  let line = '';
  const lists = []; // { ordered, n }
  let pre = 0, skip = 0, quote = 0;
  let link = null; // { href, start }
  let table = null; // { rows: [[cell]], row: null, cell: null }
  const prefix = () => '> '.repeat(quote);
  const flush = () => { out.push(line); line = ''; };
  const has = () => line.replace(/^(?:> ?)+/, '').trim() !== ''; // more than a quote's prefix
  const block = () => { if (has()) flush(); else line = ''; if (out.length && out[out.length - 1] !== '') out.push(''); };
  const put = (t) => { if (table && table.cell !== null) table.cell += t; else line += t; };
  const src = String(html || '').slice(0, MAX_TEXT * 2);
  TOKEN.lastIndex = 0;
  for (let m; (m = TOKEN.exec(src));) {
    const [, close, rawTag, attrs, , text, lt] = m;
    if (text !== undefined || lt) {
      if (skip) continue;
      let t = decodeEntities(text ?? '<');
      if (pre) { put(t); continue; }
      t = t.replace(/[ \t\r\n]+/g, ' ');
      if (!line && !(table && table.cell !== null)) t = t.replace(/^ /, '');
      if (!t) continue;
      if (!pre && !(table && table.cell !== null) && !line && quote) line = prefix();
      put(t.replace(/([\\`*_[\]])/g, '\\$1'));
      continue;
    }
    if (!rawTag) continue; // a comment
    const tag = rawTag.toLowerCase();
    if (SKIP.has(tag)) { skip += close ? (skip ? -1 : 0) : 1; continue; }
    if (skip) continue;
    switch (tag) {
      case 'br': if (pre) put('\n'); else if (table && table.cell !== null) put(' '); else { line += '  '; flush(); if (quote) line = prefix(); } break;
      case 'p': case 'div': case 'section': case 'article': case 'header': case 'footer': case 'main': case 'figure': case 'figcaption': case 'dl': case 'dt': case 'dd':
        if (lists.length && !close) { if (has()) flush(); } else block();
        if (!close && quote) line = prefix();
        break;
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        block();
        if (!close) line = `${prefix()}${'#'.repeat(Number(tag[1]))} `;
        break;
      case 'strong': case 'b': put('**'); break;
      case 'em': case 'i': put('*'); break;
      case 's': case 'del': case 'strike': put('~~'); break;
      case 'code':
        if (!pre) put('`');
        else if (!close && /^`{3}$/.test(out[out.length - 1] || '') && !line) { const lang = (attr(attrs, 'class').match(/language-([\w+-]+)/) || [])[1]; if (lang) out[out.length - 1] += lang; }
        break;
      case 'pre':
        if (!close) { block(); const lang = (attr(attrs, 'class').match(/language-([\w+-]+)/) || [])[1] || ''; line = `\`\`\`${lang}`; flush(); pre++; }
        else { pre = Math.max(0, pre - 1); line = line.replace(/\n$/, ''); if (line) flush(); line = '```'; flush(); out.push(''); }
        break;
      case 'ul': case 'ol':
        if (!close) { if (has()) flush(); else if (!lists.length) block(); lists.push({ ordered: tag === 'ol', n: Number(attr(attrs, 'start')) || 1 }); }
        else { lists.pop(); if (has()) flush(); if (!lists.length) out.push(''); }
        break;
      case 'li':
        if (!close) {
          if (has()) flush();
          const l = lists[lists.length - 1] || { ordered: false, n: 1 };
          line = `${prefix()}${'   '.repeat(Math.max(0, lists.length - 1))}${l.ordered ? `${l.n++}.` : '-'} `;
        } else if (has()) flush();
        break;
      case 'blockquote': block(); quote = Math.max(0, quote + (close ? -1 : 1)); if (!close) line = prefix(); break;
      case 'hr': block(); out.push('---', ''); break;
      case 'a':
        if (!close) { const href = attr(attrs, 'href'); link = /^https?:\/\//i.test(href) ? { href, start: (table && table.cell !== null) ? table.cell.length : line.length, inCell: Boolean(table && table.cell !== null) } : null; if (link) put('['); }
        else if (link) { put(`](${link.href.replace(/[()\s]/g, encodeURIComponent)})`); link = null; }
        break;
      case 'img': { const alt = attr(attrs, 'alt'); put(alt ? `*[image: ${alt}]*` : '*[image]*'); break; }
      case 'table': if (!close) { block(); table = { rows: [], row: null, cell: null }; } else if (table) { out.push(...tableMd(table.rows), ''); table = null; } break;
      case 'tr': if (table) { if (!close) table.row = []; else if (table.row) { table.rows.push(table.row); table.row = null; } } break;
      case 'td': case 'th': if (table) { if (!close) table.cell = ''; else if (table.cell !== null) { (table.row || (table.row = [])).push(table.cell.trim()); table.cell = null; } } break;
      default: break; // span, u, sup, sub, font, …: their text only
    }
  }
  if (has()) flush();
  return out.join('\n').replace(/[ \t]+\n/g, (s) => (s.startsWith('  ') ? '  \n' : '\n')).replace(/\n{3,}/g, '\n\n').replace(/\*\*\*\*/g, '').trim().slice(0, MAX_TEXT);
}

function tableMd(rows) {
  const r = rows.filter((x) => x.length);
  if (!r.length) return [];
  const w = Math.max(...r.map((x) => x.length));
  const cell = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const row = (x) => `| ${Array.from({ length: w }, (_, i) => cell(x[i])).join(' | ')} |`;
  return [row(r[0]), `|${' --- |'.repeat(w)}`, ...r.slice(1).map(row)];
}

/* ---------- My Activity → prompts ---------- */

const TZ = { UTC: 0, GMT: 0, Z: 0, PST: -8, PDT: -7, MST: -7, MDT: -6, CST: -6, CDT: -5, EST: -5, EDT: -4, AKST: -9, AKDT: -8, HST: -10, BST: 1, IST: 5.5, WET: 0, WEST: 1, CET: 1, CEST: 2, EET: 2, EEST: 3, MSK: 3, JST: 9, KST: 9, AEST: 10, AEDT: 11, ACST: 9.5, AWST: 8, NZST: 12, NZDT: 13, SGT: 8, HKT: 8 };
/** "Oct 7, 2025, 9:15:02 AM CEST" (My Activity's HTML) or an ISO time → ms since 1970, 0 when unreadable. */
export function parseActivityTime(s) {
  const raw = String(s || '').replace(/[  ]/g, ' ').trim();
  if (!raw) return 0;
  const iso = Date.parse(raw);
  if (/^\d{4}-\d\d-\d\dT/.test(raw) && Number.isFinite(iso)) return iso;
  const m = /^(.*?\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AP]\.?M\.?)?)\s*(?:([A-Z]{1,5})|(?:GMT|UTC)?([+-]\d{1,2}(?::?\d{2})?))?$/i.exec(raw);
  if (!m) return Number.isFinite(iso) ? iso : 0;
  const local = Date.parse(`${m[1].replace(/,\s*(?=\d{1,2}:)/, ' ').replace(/([AP])\.?M\.?$/i, '$1M')} UTC`);
  if (!Number.isFinite(local)) return Number.isFinite(iso) ? iso : 0;
  let off = 0;
  if (m[2] && m[2].toUpperCase() in TZ) off = TZ[m[2].toUpperCase()];
  else if (m[3]) { const [, sign, h, mm = '0'] = /^([+-])(\d{1,2}):?(\d{2})?$/.exec(m[3]) || []; off = (sign === '-' ? -1 : 1) * (Number(h) + Number(mm) / 60); }
  return local - off * 3600_000;
}

const PROMPT_PREFIX = /^(?:Prompted|Asked|Said)\s+/;
/**
 * A My Activity JSON entry → { at, prompt, answer (Markdown), files: [names] } or null when it isn't
 * a prompt (settings changes, feedback, Gems created, …).
 */
export function activityPrompt(x) {
  if (!x || typeof x !== 'object') return null;
  const title = decodeEntities(String(x.title || '')).replace(/\s+/g, ' ').trim();
  const html = Array.isArray(x.safeHtmlItem) ? x.safeHtmlItem.map((h) => (h && typeof h.html === 'string' ? h.html : '')).join('\n') : '';
  const prompted = PROMPT_PREFIX.test(title);
  if (!prompted && !html) return null;
  const prompt = title.replace(PROMPT_PREFIX, '').trim();
  if (!prompt) return null;
  const files = [];
  for (const f of Array.isArray(x.attachedFiles) ? x.attachedFiles : []) files.push(String((f && (f.name || f.fileName || f)) || 'file').slice(0, 120));
  return { at: parseActivityTime(x.time), prompt, answer: htmlToMarkdown(html), files };
}

/**
 * My Activity's HTML page → the same entries as the JSON ({ header, title, time, safeHtmlItem }),
 * read as text with patterns (the page is never loaded as a document).
 */
export function parseActivityHtml(html) {
  const out = [];
  const cells = String(html || '').split(/<div class="outer-cell\b/).slice(1);
  for (const cell of cells) {
    const header = decodeEntities(((/mdl-typography--title"[^>]*>([\s\S]*?)<\/p>/.exec(cell) || [])[1] || '').replace(/<[^>]*>/g, '')).trim();
    const body = /<div class="content-cell[^"]*mdl-typography--body-1"[^>]*>([\s\S]*?)(?=<div class="content-cell|$)/.exec(cell);
    if (!body) continue;
    const content = body[1].replace(/(?:<\/div>\s*)+$/, '');
    const parts = content.split(/<br\s*\/?>/i);
    if (parts.length < 2) continue;
    const title = decodeEntities(parts[0].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    const time = decodeEntities(parts[1].replace(/<[^>]*>/g, '')).trim();
    const answer = parts.slice(2).join('<br>');
    const products = /<b>Products:<\/b>([\s\S]*?)(?:<b>|<\/div>)/.exec(cell);
    out.push({ header, title, time, products: products ? decodeEntities(products[1].replace(/<[^>]*>/g, ' ')).split(/\s{2,}| /).map((s) => s.trim()).filter(Boolean) : [], safeHtmlItem: answer.trim() ? [{ html: answer }] : [] });
  }
  return out;
}

/* ---------- prompts → conversations ---------- */

/** A short, stable hash (FNV-1a, 52 bits) as base36: the same first prompt and time give the same id. */
function hash(s) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0; h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0; }
  return (h1.toString(36) + h2.toString(36)).slice(0, 16);
}

/** Prompts (any order) → groups of prompts, oldest first, split where the pause is longer than `gap`. */
export function groupSessions(prompts, { gap = SESSION_GAP, max = SESSION_MAX } = {}) {
  const list = prompts.filter(Boolean).sort((a, b) => a.at - b.at);
  const groups = [];
  let cur = null;
  for (const p of list) {
    if (!cur || !p.at || !cur[cur.length - 1].at || p.at - cur[cur.length - 1].at > gap || cur.length >= max) { cur = []; groups.push(cur); }
    cur.push(p);
  }
  return groups;
}

/** One group of prompts → { conv, images: [], stats } (the same shape the other imports make). */
export function convertGeminiSession(group, { importedAt = Date.now() } = {}) {
  if (!group || !group.length) return null;
  const nodes = {};
  const root = { children: [], sel: 0 };
  let seq = 0, parent = null, messages = 0;
  for (const p of group) {
    const note = p.files && p.files.length ? `\n\n[${p.files.length === 1 ? 'File' : 'Files'} from Gemini, not in the export: ${p.files.join(', ')}]` : '';
    const at = p.at || importedAt;
    const u = { id: `i${++seq}`, parent, children: [], sel: 0, created: at, role: 'user', content: p.prompt + note, imported: true };
    nodes[u.id] = u;
    (parent ? nodes[parent] : root).children.push(u.id);
    parent = u.id;
    messages++;
    if (p.answer) {
      const a = { id: `i${++seq}`, parent, children: [], sel: 0, created: at, role: 'assistant', parts: [{ type: 'text', text: p.answer }], mode: 'chat', finish: 'stop', imported: true };
      nodes[a.id] = a;
      nodes[parent].children.push(a.id);
      parent = a.id;
      messages++;
    }
  }
  const first = group[0];
  const origId = hash(`${first.at}\n${first.prompt}`);
  const created = first.at || importedAt;
  const updated = group[group.length - 1].at || created;
  const title = first.prompt.replace(/\s+/g, ' ').slice(0, 60) || 'Gemini chat';
  const conv = {
    id: `gem-${origId}`, title, titleSet: true, created, updated, pinned: false, temp: false, kind: 'chat', project: null, sessionId: null, personaId: null,
    mode: 'chat', nodes, root, lastRoute: null, allowTools: [], todos: [], queue: [], status: 'idle',
    source: SOURCE,
    import: { source: SOURCE, id: origId, updated, at: importedAt, nodes: Object.keys(nodes).length },
  };
  return { conv, images: [], stats: { messages } };
}

/** My Activity entries (JSON or parsed HTML) → converted conversations, oldest first. Non-Gemini entries are left out. */
export function convertGeminiActivity(entries, opts = {}) {
  const prompts = (entries || []).filter((x) => isGeminiEntry(x) || !('header' in x)).map(activityPrompt).filter(Boolean);
  return { results: groupSessions(prompts, opts).map((g) => convertGeminiSession(g, opts)).filter(Boolean), prompts: prompts.length };
}
