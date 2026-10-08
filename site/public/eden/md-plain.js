// Markdown → clean text / clean HTML for pasting elsewhere (Gmail, Docs), and the email-draft
// parser behind a reply's "Open in Mail". No imports: util.js uses it, tests load it raw.

const FENCE = /^\s*(```|~~~)/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const HEAD = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)[*+-]\s+(.*)$/;
const NUM = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?/;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const safeHref = (u) => (/^(https?:|mailto:)/i.test(u) ? u : null);

/** One line's inline Markdown as text (html=false) or as escaped HTML. */
function inlineMd(s, html) {
  const keep = [];
  const hold = (v) => `\u0000${keep.push(v) - 1}\u0000`;
  s = String(s).replace(/\\([\\`*_{}[\]()#+\-.!~>|])/g, (_, c) => hold(html ? esc(c) : c));
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, __, code) => hold(html ? `<code>${esc(code.trim())}</code>` : code.trim()));
  s = s.replace(/!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/g, (_, alt) => hold(html ? esc(alt) : alt));
  s = s.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/g, (_, t, u) => {
    if (html) { const h = safeHref(u); return hold(h ? `<a href="${esc(h)}">${inlineMd(t, true)}</a>` : inlineMd(t, true)); }
    const text = inlineMd(t, false);
    return hold(text === u || `mailto:${text}` === u ? text : `${text} (${u})`);
  });
  s = s.replace(/<(https?:\/\/[^>\s]+)>/g, (_, u) => hold(html ? `<a href="${esc(u)}">${esc(u)}</a>` : u));
  if (html) s = esc(s);
  const b = html ? (x) => `<b>${x}</b>` : (x) => x;
  const i = html ? (x) => `<i>${x}</i>` : (x) => x;
  s = s.replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, (_, x) => b(i(x)))
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, (_, x) => b(x))
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, (_, p, x) => p + b(x))
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?!\*)/g, (_, p, x) => p + i(x))
    .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, (_, p, x) => p + i(x))
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, (_, x) => (html ? `<s>${x}</s>` : x));
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => keep[Number(n)]);
}

/** Markdown as plain text: no emphasis marks, "• " bullets, links as "text (url)", code kept. */
export function mdToPlain(md) {
  const out = [];
  let fence = null;
  for (const line of String(md || '').replace(/\r\n?/g, '\n').split('\n')) {
    const f = line.match(FENCE);
    if (fence) { if (f && f[1] === fence) { fence = null; continue; } out.push(line); continue; }
    if (f) { fence = f[1]; continue; }
    if (HR.test(line)) { out.push(''); continue; }
    let m;
    const l = line.replace(QUOTE, '');
    if ((m = l.match(HEAD))) out.push(inlineMd(m[1], false));
    else if ((m = l.match(BULLET))) out.push(`${m[1]}• ${inlineMd(m[2], false)}`);
    else if ((m = l.match(NUM))) out.push(`${m[1]}${m[2]}. ${inlineMd(m[3], false)}`);
    else out.push(inlineMd(l, false).replace(/\s+$/, ''));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Markdown as clean HTML (no classes or styles): <p>, <b>, <i>, <ul>/<ol>, <a>, <pre>, <blockquote>. */
export function mdToHtml(md) {
  const html = [];
  let para = [];
  let list = null; // { tag, items }
  let quote = [];
  const flushPara = () => { if (para.length) html.push(`<p>${para.map((x) => inlineMd(x, true)).join('<br>')}</p>`); para = []; };
  const flushList = () => { if (list) html.push(`<${list.tag}>${list.items.map((x) => `<li>${inlineMd(x, true)}</li>`).join('')}</${list.tag}>`); list = null; };
  const flushQuote = () => { if (quote.length) html.push(`<blockquote>${mdToHtml(quote.join('\n'))}</blockquote>`); quote = []; };
  const flush = () => { flushPara(); flushList(); flushQuote(); };
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    const f = line.match(FENCE);
    if (f) {
      flush();
      const code = [];
      for (k++; k < lines.length && !(lines[k].match(FENCE) && lines[k].match(FENCE)[1] === f[1]); k++) code.push(lines[k]);
      html.push(`<pre>${esc(code.join('\n'))}</pre>`);
      continue;
    }
    if (QUOTE.test(line)) { flushPara(); flushList(); quote.push(line.replace(QUOTE, '')); continue; }
    flushQuote();
    let m;
    if (!line.trim() || HR.test(line)) { flushPara(); flushList(); continue; }
    if ((m = line.match(HEAD))) { flush(); html.push(`<p><b>${inlineMd(m[1], true)}</b></p>`); continue; }
    const bm = line.match(BULLET), nm = line.match(NUM);
    if (bm || nm) {
      const tag = bm ? 'ul' : 'ol';
      flushPara();
      if (list && list.tag !== tag) flushList();
      if (!list) { list = { tag, items: [] }; if (nm && nm[2] !== '1') list.tag = `ol start="${Number(nm[2])}"`; }
      list.items.push(bm ? bm[2] : nm[3]);
      continue;
    }
    if (list && /^\s+\S/.test(line)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
    flushList();
    para.push(line.trim());
  }
  flush();
  return html.join('').replace(/<\/ol start="\d+">/g, '</ol>');
}

const SIGNOFF = /^(best|best wishes|best regards|kind regards|warm regards|warmly|regards|many thanks|thanks|thanks again|thank you|cheers|sincerely|yours sincerely|yours truly|yours|all the best|talk soon|take care|respectfully)[,.!]?$/i;
const GREETING = /^(hi|hello|hey|dear|good (morning|afternoon|evening)|greetings)\b.*[,:!]?$/i;
const HEADER = /^(to|cc|bcc|subject):\s*(.*)$/i;

const addresses = (v) => String(v || '').split(/[,;]/).map((x) => x.trim().replace(/^\[|\]$/g, '')).filter((x) => /\S+@\S+\.\S+/.test(x));

/**
 * The email draft inside an assistant reply, or null. A draft has a "Subject:" line, or a
 * greeting and a sign-off. Returns { to, cc, subject, body } with the body as plain text.
 */
export function parseEmailDraft(md) {
  const src = String(md || '').replace(/\r\n?/g, '\n');
  // a fenced block or a part between horizontal rules that holds the draft wins over the chat around it
  const parts = [];
  src.replace(/^\s*(```|~~~)[^\n]*\n([\s\S]*?)\n\s*\1\s*$/gm, (_, __, body) => { parts.push(body); return ''; });
  parts.push(...src.split(/^\s*([-*_])(?:\s*\1){2,}\s*$/m).filter((_, i) => i % 2 === 0));
  for (const part of parts) {
    const d = draftIn(mdToPlain(part));
    if (d) return d;
  }
  return null;
}

function draftIn(text) {
  const lines = text.split('\n');
  const hdr = { to: [], cc: [], bcc: [], subject: '' };
  let start = -1, k = 0;
  // headers: the first To:/Subject: line and the ones right after it
  const first = lines.findIndex((l) => /^(to|subject):\s*\S/i.test(l.trim()));
  if (first >= 0) {
    for (k = first; k < lines.length; k++) {
      const m = lines[k].trim().match(HEADER);
      if (!m) break;
      const key = m[1].toLowerCase();
      if (key === 'subject') hdr.subject = m[2].trim().replace(/^["“](.*)["”]$/, '$1');
      else hdr[key].push(...addresses(m[2]));
    }
    while (k < lines.length && !lines[k].trim()) k++;
    start = k;
  }
  if (start < 0 || !hdr.subject) {
    const g = lines.findIndex((l, i) => i >= Math.max(start, 0) && GREETING.test(l.trim()) && l.trim().length < 80);
    if (g < 0) return null;
    if (start < 0) start = g;
  }
  // the body ends after the sign-off and the name lines under it
  let end = lines.length;
  let so = -1;
  for (let i = lines.length - 1; i >= start; i--) if (SIGNOFF.test(lines[i].trim())) { so = i; break; }
  if (so >= 0) { end = so + 1; while (end < lines.length && lines[end].trim()) end++; }
  else if (!hdr.subject) return null;
  const body = lines.slice(start, end).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!body) return null;
  return { to: hdr.to, cc: hdr.cc, subject: hdr.subject, body };
}
