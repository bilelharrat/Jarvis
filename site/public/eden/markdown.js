// A small, safe Markdown renderer that builds DOM nodes directly (text always goes in as
// text nodes, so no HTML in a reply can run). Headings, lists (nested), bold/italic/strike,
// links (http/https only, rel=noopener), inline code, fenced code with a header (language,
// Copy, Open in canvas / code view), tables, blockquotes, rules, [n] citations.
// Images never load here (they're drawn as links; the page CSP blocks other sites' images too).
// With opts.untrusted (a reply that read content from outside: guard.js), each link also shows
// its full destination and an image becomes a click-to-load placeholder (button.g-img).

import { el, ico } from './util.js';

// a fence opener: ``` or ~~~ then an info string (a backtick fence's has no backticks).
// Parsed in two steps, not one regex with overlapping quantifiers: a long line with a stray
// backtick made that backtrack quadratically (about a second per render at 50k characters).
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE = {
  exec(line) {
    const m = FENCE_OPEN.exec(line);
    if (!m || (m[1][0] === '`' && m[2].includes('`'))) return null;
    return [m[0], m[1], m[2].trim().split(/\s+/, 1)[0] || ''];
  },
  test(line) { return this.exec(line) !== null; },
};
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
/** A heading's text without its optional closing #s (a loop, not a backtracking regex). */
function headingText(s) {
  const t = s.trimEnd();
  let end = t.length;
  while (end > 0 && t[end - 1] === '#') end--;
  return end < t.length && (end === 0 || t[end - 1] === ' ' || t[end - 1] === '\t') ? t.slice(0, end).trimEnd() : t;
}
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
export const CANVAS_LANGS = new Set(['html', 'svg', 'artifact', 'htm', 'xhtml']);

export function renderMarkdown(src, opts = {}) {
  const frag = document.createDocumentFragment();
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  blocks(lines, frag, opts);
  return frag;
}

function indentOf(s) { const m = /^\s*/.exec(s); return m ? m[0].replace(/\t/g, '    ').length : 0; }
function isBlockStart(line, next) {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST.test(line)
    || (line.includes('|') && next !== undefined && TABLE_SEP.test(next) && next.includes('-'));
}

function blocks(lines, out, opts) {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = FENCE.exec(line))) {
      const fence = m[1];
      const lang = (m[2] || '').toLowerCase();
      const body = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim().startsWith(fence[0].repeat(fence.length)) && l.trim().replace(new RegExp(`^\\${fence[0]}+`), '').trim() === '') { closed = true; i++; break; }
        body.push(l);
        i++;
      }
      out.append(codeBlock(lang, body.join('\n'), opts, closed));
      continue;
    }
    if ((m = HEADING.exec(line))) {
      const h = el(`h${m[1].length}`);
      inline(headingText(m[2]), h, opts);
      out.append(h);
      i++;
      continue;
    }
    if (HR.test(line) && !LIST.test(line.replace(/^(\s*)([-*])\s+\2/, ''))) { out.append(el('hr')); i++; continue; }
    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) { inner.push(QUOTE.exec(lines[i])[1]); i++; }
      const bq = el('blockquote');
      blocks(inner, bq, opts);
      out.append(bq);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      i = table(lines, i, out, opts);
      continue;
    }
    if (LIST.test(line)) { i = list(lines, i, out, opts); continue; }
    // paragraph
    const para = [];
    while (i < lines.length && lines[i].trim() && !(para.length && isBlockStart(lines[i], lines[i + 1]))) { para.push(lines[i]); i++; }
    const p = el('p');
    inline(para.join('\n'), p, opts);
    out.append(p);
  }
}

function list(lines, i, out, opts) {
  const first = LIST.exec(lines[i]);
  const base = indentOf(first[1]);
  const ordered = /\d/.test(first[2]);
  const node = el(ordered ? 'ol' : 'ul');
  if (ordered) { const start = parseInt(first[2], 10); if (start !== 1) node.setAttribute('start', String(start)); }
  let loose = false;
  while (i < lines.length) {
    const m = LIST.exec(lines[i]);
    if (!m || indentOf(m[1]) !== base || /\d/.test(m[2]) !== ordered) break;
    const width = m[1].length + m[2].length + 1;
    const content = [m[3]];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        // the whole run of blank lines at once (a scan per blank line was quadratic)
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        const next = lines[j];
        if (next !== undefined && indentOf(next) > base) { for (; i < j; i++) content.push(''); loose = loose || !LIST.test(next); continue; }
        break;
      }
      const lm = LIST.exec(l);
      if (lm && indentOf(lm[1]) <= base) break;
      if (indentOf(l) <= base && (isBlockStart(l, lines[i + 1]) && !lm)) break;
      content.push(indentOf(l) >= width ? l.slice(Math.min(width, l.length - l.trimStart().length)) : l.trimStart());
      i++;
    }
    const li = el('li');
    const tmp = document.createDocumentFragment();
    blocks(content, tmp, opts);
    // a tight item: its paragraph's words sit straight in the <li>
    if (!loose && tmp.firstChild && tmp.firstChild.nodeName === 'P') {
      const p = tmp.firstChild;
      while (p.firstChild) li.append(p.firstChild);
      p.remove();
    }
    li.append(tmp);
    node.append(li);
  }
  out.append(node);
  return i;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '', code = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue; }
    if (c === '`') code = !code;
    if (c === '|' && !code) { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function table(lines, i, out, opts) {
  const head = splitRow(lines[i]);
  const aligns = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
  i += 2;
  const t = el('table');
  const thead = el('thead');
  const tr = el('tr');
  head.forEach((c, k) => { const th = el('th'); if (aligns[k]) th.style.textAlign = aligns[k]; inline(c, th, opts); tr.append(th); });
  thead.append(tr);
  t.append(thead);
  const tbody = el('tbody');
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
    const row = el('tr');
    const cells = splitRow(lines[i]);
    for (let k = 0; k < head.length; k++) { const td = el('td'); if (aligns[k]) td.style.textAlign = aligns[k]; inline(cells[k] || '', td, opts); row.append(td); }
    tbody.append(row);
    i++;
  }
  t.append(tbody);
  out.append(t);
  return i;
}

function codeBlock(lang, code, opts, closed) {
  const blk = el('div', 'cblock');
  blk._code = code;
  blk._lang = lang;
  blk.dataset.lang = lang;
  const head = el('div', 'cb-head');
  head.append(el('span', 'lang', lang || 'text'));
  if (!opts.noCanvas) {
    if (CANVAS_LANGS.has(lang)) head.append(el('button', { type: 'button', class: 'canvas', 'data-act': 'canvas', title: 'Open in canvas' }, ico('art'), 'Open in canvas'));
    else if (code.split('\n').length > 3) head.append(el('button', { type: 'button', 'data-act': 'codeview', title: 'Open in code view' }, ico('code'), 'Code view'));
  }
  head.append(el('button', { type: 'button', 'data-act': 'copy-code', title: 'Copy code', 'aria-label': `Copy ${lang || ''} code` }, ico('copy'), 'Copy'));
  const pre = el('pre');
  const c = el('code', lang ? `language-${lang.replace(/[^\w-]/g, '')}` : '');
  c.textContent = code;
  pre.append(c);
  blk.append(head, pre);
  if (!closed) blk.dataset.open = '1';
  return blk;
}

const INLINE = new RegExp([
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.source, // 1,2 code
  /!?\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.source, // 3,4 link (images shown as links)
  /<(https?:\/\/[^>\s]+)>/.source, // 5 autolink
  /(https?:\/\/[^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*[^\s<>().,:;"'!?\]])/.source, // 6 bare url
  /\*\*(?=\S)([\s\S]*?\S)\*\*/.source, // 7 bold
  /__(?=\S)([\s\S]*?\S)__(?!\w)/.source, // 8 bold
  /~~(?=\S)([\s\S]*?\S)~~/.source, // 9 strike
  /\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/.source, // 10 italic
  /(?<![\w\\])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\w])/.source, // 11 italic
  /\[(\d{1,2})\](?!\()/.source, // 12 citation
  /\\([\\`*_{}[\]()#+\-.!~|>])/.source, // 13 escape
  /( {2,}|\\)\n|\n/.source, // 14 line break
].join('|'), 'g');

export function safeUrl(u) {
  try {
    const url = new URL(u, location.href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

function link(href, kids, out, opts = {}, image = false) {
  const safe = safeUrl(href);
  if (!safe) { out.append(...kids); return; }
  if (opts.untrusted && image) { out.append(heldImage(kids, safe)); return; }
  const a = el('a', { href: safe, target: '_blank', rel: 'noopener noreferrer', ...(opts.untrusted ? { referrerpolicy: 'no-referrer', title: safe } : {}) });
  a.append(...kids);
  out.append(a);
  // A link in a reply that read untrusted content says where it really goes.
  const shown = a.textContent.trim();
  if (opts.untrusted && shown !== safe && shown !== href) out.append(el('span', 'g-dest', `(${safe})`));
}

/** An image from a reply that read untrusted content: not loaded; a click shows where it is (guard.js). */
function heldImage(kids, url) {
  const alt = kids.map((k) => k.textContent).join('').trim() || 'Image';
  let host = url;
  try { host = new URL(url).hostname; } catch { /* keep the URL */ }
  return el('button', { type: 'button', class: 'g-img', 'data-url': url, title: url, 'aria-expanded': 'false', 'aria-label': `Image “${alt}” from ${host}, not loaded. Show where it is.` },
    ico('art', 14), el('span', 'g-img-t', alt), el('span', 'g-img-h', `${host} · not loaded`));
}

export function inline(text, out, opts = {}) {
  let last = 0;
  // A regex of its own per call: bold, links and the rest recurse into inline(), and a shared
  // /g regex would have its lastIndex reset to 0 by the inner call, so the outer loop matched
  // the same span forever (the page froze on the first **bold** of a reply).
  const re = new RegExp(INLINE.source, 'g');
  let m;
  const s = String(text);
  while ((m = re.exec(s))) {
    if (m.index > last) out.append(document.createTextNode(s.slice(last, m.index)));
    last = re.lastIndex;
    if (m[0] === '') { re.lastIndex++; continue; } // never loop on an empty match
    if (m[1] !== undefined) {
      let code = m[2];
      if (/^ .* $/.test(code)) code = code.slice(1, -1);
      out.append(el('code', '', code));
    } else if (m[3] !== undefined) {
      const tmp = document.createDocumentFragment();
      inline(m[3], tmp, opts);
      link(m[4], [...tmp.childNodes], out, opts, m[0][0] === '!');
    } else if (m[5] !== undefined) link(m[5], [document.createTextNode(m[5])], out, opts);
    else if (m[6] !== undefined) link(m[6], [document.createTextNode(m[6])], out, opts);
    else if (m[7] !== undefined || m[8] !== undefined) { const b = el('strong'); inline(m[7] ?? m[8], b, opts); out.append(b); }
    else if (m[9] !== undefined) { const d = el('del'); inline(m[9], d, opts); out.append(d); }
    else if (m[10] !== undefined || m[11] !== undefined) { const e = el('em'); inline(m[10] ?? m[11], e, opts); out.append(e); }
    else if (m[12] !== undefined) {
      const n = Number(m[12]);
      const src = opts.sources && opts.sources[n - 1];
      if (src) out.append(el('sup', { class: 'cite', tabindex: '0', role: 'button', 'data-cite': String(n), 'aria-label': `Source ${n}: ${src.title || src.url}` }, String(n)));
      else out.append(document.createTextNode(m[0]));
    } else if (m[13] !== undefined) out.append(document.createTextNode(m[13]));
    else out.append(el('br'));
  }
  if (last < s.length) out.append(document.createTextNode(s.slice(last)));
}

/** Plain text of some Markdown (for titles, search). */
export function plain(src) {
  return String(src || '').replace(/```[\s\S]*?(```|$)/g, ' ').replace(/[#>*_`~[\]()|-]+/g, ' ').replace(/\s+/g, ' ').trim();
}
