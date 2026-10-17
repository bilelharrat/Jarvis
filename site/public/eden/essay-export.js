// The essay as files (essay.js's Export menu): Word (.docx, with the docx library, essay-docx.min.mjs,
// loaded on first use) and PDF (the browser's print, from a page laid out with print CSS). Both
// follow the style the essay is in (essay-model.js): page setup, running header with page numbers
// (Word paginates for real; in a PDF the numbers need a browser that draws @page margin boxes,
// Chrome and Edge, else they're left out), the heading block or title page, headings, block quotes,
// footnotes (Word: real footnotes; PDF: notes before the reference page) and the reference page,
// sorted, with hanging indents where the style has them.

import { setupOf, frontMatter, titleLine, headerText, lastName, essayFileName } from './essay-model.js';
import { formatReference, sortReferences, inText, plainText } from './essay-cite.js';

/** A citation node's words (essay.js draws the same): its source in the style, or a note that it's gone. */
function citeSegs(essay, attrs) {
  const src = (essay.sources || []).find((x) => x.id === (attrs && attrs.sid));
  return src ? inText(setupOf(essay).id, src, attrs.page ? { page: attrs.page } : {}) : [{ t: '(source removed)' }];
}

const TWIP = 1440; // per inch
const line = (spacing) => Math.round(240 * spacing); // Word's "auto" line rule: 240 = single

// ── Word ──

/** The essay as a .docx Blob. */
export async function essayDocx(essay) {
  const D = await import('./essay-docx.min.mjs');
  const doc = docxDocument(essay, D);
  return D.Packer.toBlob(doc);
}

/** The docx Document for an essay (exported for the tests, which pass the library in). */
export function docxDocument(essay, D) {
  const s = setupOf(essay);
  const notes = {};
  let noteN = 0;
  const font = s.font, size = s.size * 2;
  const runsOf = (nodes = [], base = {}) => {
    const out = [];
    for (const n of nodes) {
      if (n.type === 'text') {
        const m = new Set((n.marks || []).map((x) => x.type));
        out.push(new D.TextRun({ text: n.text, bold: base.bold || m.has('bold') || undefined, italics: base.italics || m.has('italic') || undefined, underline: m.has('underline') ? {} : undefined, strike: m.has('strike') || undefined }));
      } else if (n.type === 'hardBreak') out.push(new D.TextRun({ break: 1 }));
      else if (n.type === 'footnote' || (n.type === 'cite' && s.notes)) {
        noteN += 1;
        const segs = n.type === 'cite' ? citeSegs(essay, n.attrs) : [{ t: String((n.attrs && n.attrs.text) || '') }];
        notes[noteN] = { children: [new D.Paragraph({ children: segs.map((g) => new D.TextRun({ text: g.t, italics: g.i || undefined, size: 20 })) })] };
        out.push(new D.FootnoteReferenceRun(noteN));
      } else if (n.type === 'cite') out.push(...citeSegs(essay, n.attrs).map((g) => new D.TextRun({ text: g.t, italics: base.italics || g.i || undefined, bold: base.bold || undefined }))); else if (n.content) out.push(...runsOf(n.content, base));
    }
    return out;
  };
  const ALIGN = { left: D.AlignmentType.LEFT, center: D.AlignmentType.CENTER, right: D.AlignmentType.RIGHT, justify: D.AlignmentType.JUSTIFIED };
  const para = (n, extra = {}) => new D.Paragraph({
    alignment: ALIGN[(n.attrs && n.attrs.textAlign) || 'left'],
    spacing: { line: line(s.spacing), before: 0, after: s.gap ? 240 : 0 },
    indent: s.indent ? { firstLine: TWIP / 2 } : undefined,
    children: runsOf(n.content),
    ...extra,
  });
  const body = [];
  const block = (n, ctx = {}) => {
    if (n.type === 'paragraph') {
      if (ctx.quote) body.push(para(n, { indent: { left: TWIP / 2 }, spacing: { line: line(s.quote.spacing), before: s.quote.spacing === 1 ? 240 : 0, after: s.quote.spacing === 1 || s.gap ? 240 : 0 } }));
      else if (ctx.list) body.push(para(n, { indent: undefined, ...(ctx.list === 'bullet' ? { bullet: { level: ctx.level } } : { numbering: { reference: 'essay-numbers', level: ctx.level, instance: ctx.instance } }) }));
      else body.push(para(n));
    } else if (n.type === 'heading') {
      const h = s.headings[(n.attrs && n.attrs.level) || 1] || s.headings[3];
      body.push(new D.Paragraph({
        heading: [D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_2, D.HeadingLevel.HEADING_3][((n.attrs && n.attrs.level) || 1) - 1],
        alignment: ALIGN[h.align], keepNext: true,
        spacing: { line: line(s.spacing), before: s.gap ? 240 : 0, after: s.gap ? 120 : 0 },
        children: runsOf(n.content, { bold: !!h.bold, italics: !!h.italic }),
      }));
    } else if (n.type === 'blockquote') for (const c of n.content || []) block(c, { ...ctx, quote: true });
    else if (n.type === 'bulletList' || n.type === 'orderedList') {
      const instance = n.type === 'orderedList' ? (block.lists = (block.lists || 0) + 1) : 0;
      for (const li of n.content || []) for (const c of li.content || []) {
        if (c.type === 'bulletList' || c.type === 'orderedList') block(c, { ...ctx, level: (ctx.level || 0) + 1 });
        else block(c, { ...ctx, list: n.type === 'bulletList' ? 'bullet' : 'number', level: ctx.level || 0, instance: instance || ctx.instance });
      }
    } else if (n.type === 'codeBlock') body.push(para({ content: n.content }, { indent: undefined }));
    else if (n.content) for (const c of n.content) block(c, ctx);
  };

  // page 1: MLA's heading block and title, or the title page (its own section, so its header can differ)
  const fm = frontMatter(essay);
  const plain = (l, extra = {}) => new D.Paragraph({
    alignment: ALIGN[l.align], spacing: { line: line(2), before: (l.space || 0) * line(2), after: 0 },
    children: [new D.TextRun({ text: l.placeholder ? '' : l.text, bold: l.bold || undefined })], ...extra,
  });
  const lead = [];
  if (fm.kind === 'heading') lead.push(...fm.lines.map((l) => plain(l)));
  const t = titleLine(essay);
  if (t && !t.placeholder) lead.push(new D.Paragraph({ alignment: D.AlignmentType.CENTER, spacing: { line: line(s.spacing), after: s.gap ? 240 : 0 }, children: [new D.TextRun({ text: t.text, bold: t.bold || undefined })] }));
  for (const n of (essay.doc && essay.doc.content) || []) block(n);

  // the reference page
  const refs = sortReferences(s.id, (essay.sources || []).filter(Boolean));
  const refBlock = [];
  if (refs.length) {
    refBlock.push(new D.Paragraph({
      pageBreakBefore: true, alignment: ALIGN[s.refs.align], spacing: { line: line(s.refs.spacing), after: s.refs.gap ? 480 : 0 },
      children: [new D.TextRun({ text: s.refs.title, bold: s.refs.bold || undefined })],
    }));
    for (const src of refs) {
      refBlock.push(new D.Paragraph({
        spacing: { line: line(s.refs.spacing), after: s.refs.gap ? 240 : 0 },
        indent: s.refs.hanging ? { left: TWIP / 2, hanging: TWIP / 2 } : undefined,
        children: formatReference(s.id, src).map((g) => new D.TextRun({ text: g.t, italics: g.i || undefined })),
      }));
    }
  }

  const pageNo = (text) => new D.Paragraph({ alignment: D.AlignmentType.RIGHT, children: [...(text ? [new D.TextRun(`${text} `)] : []), new D.TextRun({ children: [D.PageNumber.CURRENT] })] });
  const headerLabel = s.header === 'name' ? lastName(essay.details && essay.details.name) : '';
  const runningHeader = new D.Header({ children: [pageNo(headerLabel)] });
  const props = { page: { size: { width: TWIP * 8.5, height: TWIP * 11 }, margin: { top: TWIP, bottom: TWIP, left: TWIP, right: TWIP, header: TWIP / 2 } } };
  const sections = [];
  if (fm.kind === 'titlepage') {
    sections.push({
      properties: props,
      headers: s.numberTitlePage ? { default: runningHeader } : { default: new D.Header({ children: [new D.Paragraph('')] }) },
      children: fm.lines.map((l) => plain(l)),
    });
    sections.push({ properties: { ...props, page: { ...props.page, pageNumbers: { start: 2 } } }, headers: { default: runningHeader }, children: [...lead, ...body, ...refBlock] });
  } else sections.push({ properties: props, headers: { default: runningHeader }, children: [...lead, ...body, ...refBlock] });

  const rf = { font, size };
  return new D.Document({
    creator: (essay.details && essay.details.name) || 'Eden',
    title: (essay.details && essay.details.title) || 'Essay',
    styles: {
      default: {
        document: { run: rf },
        heading1: { run: { ...rf, color: '000000' } }, heading2: { run: { ...rf, color: '000000' } }, heading3: { run: { ...rf, color: '000000' } },
      },
      paragraphStyles: [{ id: 'FootnoteText', name: 'footnote text', basedOn: 'Normal', run: { font, size: 20 } }],
    },
    numbering: { config: [{ reference: 'essay-numbers', levels: [0, 1, 2].map((level) => ({ level, format: D.LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: D.AlignmentType.START, style: { paragraph: { indent: { left: TWIP / 2 * (level + 1), hanging: TWIP / 4 } } } })) }] },
    footnotes: notes,
    sections,
  });
}

// ── PDF (print) ──

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The essay as one printable HTML page (letter, 1-inch margins, the style's header in the top-right margin box). */
export function printHtml(essay) {
  const s = setupOf(essay);
  const notes = [];
  const inline = (nodes = []) => nodes.map((n) => {
    if (n.type === 'text') {
      let h = esc(n.text);
      for (const m of n.marks || []) h = { bold: `<b>${h}</b>`, italic: `<i>${h}</i>`, underline: `<u>${h}</u>`, strike: `<s>${h}</s>` }[m.type] || h;
      return h;
    }
    if (n.type === 'hardBreak') return '<br>';
    if (n.type === 'footnote') { notes.push(esc((n.attrs && n.attrs.text) || '')); return `<sup>${notes.length}</sup>`; }
    if (n.type === 'cite') {
      const html = citeSegs(essay, n.attrs).map((g) => (g.i ? `<i>${esc(g.t)}</i>` : esc(g.t))).join('');
      if (s.notes) { notes.push(html); return `<sup>${notes.length}</sup>`; }
      return html;
    }
    return inline(n.content);
  }).join('');
  const al = (n) => (n.attrs && n.attrs.textAlign && n.attrs.textAlign !== 'left' ? ` style="text-align:${n.attrs.textAlign}"` : '');
  const block = (n) => {
    switch (n.type) {
      case 'paragraph': return `<p${al(n)}>${inline(n.content) || '<br>'}</p>`;
      case 'heading': return `<h${n.attrs.level}${al(n)}>${inline(n.content)}</h${n.attrs.level}>`;
      case 'blockquote': return `<blockquote>${(n.content || []).map(block).join('')}</blockquote>`;
      case 'bulletList': return `<ul>${(n.content || []).map((li) => `<li>${(li.content || []).map(block).join('')}</li>`).join('')}</ul>`;
      case 'orderedList': return `<ol>${(n.content || []).map((li) => `<li>${(li.content || []).map(block).join('')}</li>`).join('')}</ol>`;
      case 'codeBlock': return `<p>${inline(n.content)}</p>`;
      default: return n.content ? n.content.map(block).join('') : '';
    }
  };
  const fm = frontMatter(essay);
  const lines = (l) => `<p class="fm" style="text-align:${l.align};${l.space ? `margin-top:${l.space * 2}em;` : ''}${l.bold ? 'font-weight:bold;' : ''}">${l.placeholder ? '' : esc(l.text)}</p>`;
  const t = titleLine(essay);
  const body = ((essay.doc && essay.doc.content) || []).map(block).join('');
  const refs = sortReferences(s.id, essay.sources || []);
  const h = (lv) => s.headings[lv] || s.headings[3];
  const hcss = [1, 2, 3].map((lv) => `h${lv}{font-size:1em;margin:${s.gap ? '1em' : '0'} 0 ${s.gap ? '.5em' : '0'};text-align:${h(lv).align};font-weight:${h(lv).bold ? 'bold' : 'normal'};font-style:${h(lv).italic ? 'italic' : 'normal'};break-after:avoid}`).join('');
  const label = s.header === 'name' ? `"${lastName(essay.details && essay.details.name).replace(/["\\]/g, '')} " counter(page)` : 'counter(page)';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(essayFileName(essay, 'pdf').replace(/\.pdf$/, ''))}</title><style>
@page{size:letter;margin:1in;@top-right{content:${label};font:${s.size}pt "${s.font}",${/Arial|Calibri/.test(s.font) ? 'sans-serif' : 'serif'}}}
${fm.kind === 'titlepage' && !s.numberTitlePage ? '@page:first{@top-right{content:none}}' : ''}
html{font:${s.size}pt/${(1.15 * s.spacing).toFixed(2)} "${s.font}",${/Arial|Calibri/.test(s.font) ? 'sans-serif' : 'serif'};color:#000;background:#fff}
body{margin:0}p{margin:0 0 ${s.gap ? '1em' : '0'};text-indent:${s.indent ? '.5in' : '0'}}
p.fm,h1,h2,h3,.title,.refs-t{text-indent:0}.fm{margin:0;line-height:${(1.15 * 2).toFixed(2)}}
${hcss}
blockquote{margin:${s.quote.spacing === 1 ? '1em' : '0'} 0 ${s.quote.spacing === 1 ? '1em' : '0'} .5in;line-height:${(1.15 * s.quote.spacing).toFixed(2)}}blockquote p{text-indent:0}
ul,ol{margin:0;padding-left:.5in}li p{text-indent:0}
.title{text-align:center;${t && t.bold ? 'font-weight:bold;' : ''}margin:0 0 ${s.gap ? '1em' : '0'}}
.titlepage{break-after:page}
.notes{break-before:page}.notes h2,.refs-t{text-align:center;font-weight:normal;margin:0 0 ${s.refs.gap ? '2em' : '0'}}
.notes ol{padding-left:.5in;line-height:${(1.15 * s.refs.spacing).toFixed(2)}}.notes li{margin-bottom:${s.refs.gap ? '1em' : '0'}}
.refs{break-before:page}.refs-t{text-align:${s.refs.align};font-weight:${s.refs.bold ? 'bold' : 'normal'}}
.ref{line-height:${(1.15 * s.refs.spacing).toFixed(2)};margin:0 0 ${s.refs.gap ? '1em' : '0'};${s.refs.hanging ? 'padding-left:.5in;text-indent:-.5in' : 'text-indent:0'}}
</style></head><body>
${fm.kind === 'titlepage' ? `<section class="titlepage">${fm.lines.map(lines).join('')}</section>` : fm.lines.map(lines).join('')}
${t && !t.placeholder ? `<p class="title">${esc(t.text)}</p>` : ''}
${body}
${notes.length ? `<section class="notes"><h2>Notes</h2><ol>${notes.map((x) => `<li>${x}</li>`).join('')}</ol></section>` : ''}
${refs.length ? `<section class="refs"><p class="refs-t">${esc(s.refs.title)}</p>${refs.map((src) => `<p class="ref">${formatReference(s.id, src).map((g) => (g.i ? `<i>${esc(g.t)}</i>` : esc(g.t))).join('')}</p>`).join('')}</section>` : ''}
</body></html>`;
}

/** Opens the print dialog for the essay (Save as PDF there). */
export function printEssay(essay) {
  const f = document.createElement('iframe');
  f.setAttribute('aria-hidden', 'true');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  f.srcdoc = printHtml(essay);
  f.onload = () => {
    try { f.contentWindow.focus(); f.contentWindow.print(); } finally { setTimeout(() => f.remove(), 60_000); }
  };
  document.body.append(f);
}

export { headerText };
