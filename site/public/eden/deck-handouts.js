// Handouts and notes pages (web only): the deck's script-free print copy (deck-render.js deckDocument mode
// 'static') laid out on portrait paper, then printed through deck.js exportPdf ("Save as PDF").
//   notes  — one slide a page with its speaker notes under it
//   2, 6   — two or six slides a page
//   3      — three slides a page, with lines beside each for the audience's own notes
//   outline— the deck's words as a text document (titles, points, tables, notes)
// Pure: strings in, a string out (src/__tests__/deck-find.test.ts). The iPhone app never shows these.

import { deckFields } from './deck-find-model.js';

export const HANDOUT_LAYOUTS = [
  ['notes', 'Notes pages', 'One slide a page with its speaker notes'],
  ['2', '2 slides a page', 'Large, for reading along'],
  ['3', '3 slides with lines', 'Room to write beside each slide'],
  ['6', '6 slides a page', 'A compact overview'],
  ['outline', 'Outline', 'The words only, as a document'],
];
// paper in CSS px (96 a inch), less a half-inch margin all round
export const PAPER = { letter: { css: 'letter portrait', w: 720, h: 960 }, a4: { css: 'A4 portrait', w: 698, h: 1027 } };
/** Letter where it's the custom (US, Canada, Mexico, the Philippines…), else A4. */
export const paperFor = (locale) => (/^[a-z]{2,3}-(US|CA|MX|PH|CL|CO|VE|GT|PR)\b/i.test(String(locale || '')) ? 'letter' : 'a4');

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const n = (v) => Math.round(v * 1000) / 1000;

/** The pieces of a static deck document: { head, bodyClass, slides: [{ html, notes, k }] } (notes as escaped HTML). */
export function staticParts(html) {
  const s = String(html);
  const bodyAt = s.indexOf('<body');
  const open = /<body class="([^"]*)">/.exec(s.slice(bodyAt));
  const end = s.lastIndexOf('</body>');
  if (bodyAt < 0 || !open || end < 0) throw new Error('not a slide document');
  const inner = s.slice(bodyAt + open[0].length, end);
  const slides = inner.split(/\n(?=<section[^>]*class="slide )/).filter((x) => /^<section/.test(x.trim())).map((x) => {
    const notes = /<aside class="notes" hidden[^>]*>([\s\S]*?)<\/aside><\/section>\s*$/.exec(x);
    const k = /data-k="(\d+)"/.exec(x);
    return { html: notes ? x.slice(0, notes.index) + x.slice(notes.index + notes[0].length - '</section>'.length) : x, notes: notes ? notes[1] : '', k: k ? Number(k[1]) : 0 };
  });
  return { head: s.slice(0, bodyAt), bodyClass: open[1], slides };
}

const CSS = (paper) => `
@page{size:${paper.css};margin:.5in}
html,body{height:auto!important;overflow:visible!important;background:#fff!important}
body.ho{margin:0;color:#1d1d1f;font:12pt/1.45 -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif}
.ho .slide,.mode-static.ho .slide{break-after:auto!important;page-break-after:auto!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.ho-page{width:${paper.w}px;box-sizing:border-box;break-after:page;page-break-after:always;break-inside:avoid-page}
.ho-page:last-child{break-after:auto;page-break-after:auto}
.ho-head{display:flex;justify-content:space-between;gap:12px;font-size:9pt;color:#6e6e73;border-bottom:1px solid #d2d2d7;padding-bottom:6px;margin-bottom:14px}
.ho-head b{font-weight:600;color:#1d1d1f;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ho-slot{position:relative;overflow:hidden;contain:paint;clip-path:inset(0 round 6px);border:1px solid #d2d2d7;border-radius:6px;flex:none}
.ho-slot>.ho-scale{position:relative;width:1280px;height:720px} /* scaled with zoom, not transform: its layout box is its drawn size, so print never splits it */
.ho-slot .slide{position:absolute;left:0;top:0;transform:none}
.ho-n{font-size:9pt;color:#6e6e73;margin:4px 0 0}
.ho-notes{margin-top:18px;white-space:pre-wrap;font-size:12pt}
.ho-notes h3,.ho-out h2{font-size:10pt;text-transform:uppercase;letter-spacing:.06em;color:#6e6e73;margin:0 0 6px;font-weight:600}
.ho-none{color:#86868b;font-style:italic}
.ho-grid{display:grid;gap:22px 24px;justify-content:center}
.ho-row{display:grid;grid-template-columns:auto 1fr;gap:20px;align-items:start;margin-bottom:22px}
.ho-lines{display:grid;gap:0}.ho-lines span{display:block;height:27px;border-bottom:1px solid #c7c7cc}
.ho-out{width:${paper.w}px}
.ho-out h1{font-size:20pt;margin:0 0 4px}.ho-out .ho-sub{color:#6e6e73;margin:0 0 18px}
.ho-out section{break-inside:avoid-page;margin:0 0 16px;padding-top:10px;border-top:1px solid #e5e5ea}
.ho-out h2{font-size:13pt;text-transform:none;letter-spacing:0;color:#1d1d1f;margin:0 0 6px}
.ho-out table{border-collapse:collapse;margin:6px 0 0;font-size:10.5pt}.ho-out th,.ho-out td{border:1px solid #d2d2d7;padding:3px 8px;text-align:left}.ho-out th{background:#f5f5f7}
.ho-out ul{margin:4px 0 0 1.2em;padding:0}.ho-out li{margin:2px 0}
.ho-out .ho-notes{margin-top:8px;padding:8px 10px;background:#f5f5f7;border-radius:6px;font-size:11pt;-webkit-print-color-adjust:exact;print-color-adjust:exact}
`;

const slot = (sl, w) => {
  const s = w / 1280;
  return `<div class="ho-slot" style="width:${n(w)}px;height:${n(720 * s)}px"><div class="ho-scale" style="zoom:${n(s)}">${sl.html}</div></div>`;
};
const head = (title, right) => `<header class="ho-head"><b>${esc(title)}</b><span>${esc(right)}</span></header>`;
const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

/**
 * A handout document from the deck's static print copy. layout: 'notes' | '2' | '3' | '6' | 'outline';
 * paper: 'letter' | 'a4'; labels: { slide, page, notes, noNotes, of } (translated by the caller).
 */
export function handoutDocument(staticHtml, deck, { layout = 'notes', paper = 'letter', labels = {}, notes = true } = {}) {
  const L = { slide: 'Slide', page: 'Page', of: 'of', notes: 'Speaker notes', noNotes: 'No notes for this slide.', outline: 'Outline', slides: 'slides', ...labels };
  const P = PAPER[paper] || PAPER.letter;
  const parts = staticParts(staticHtml);
  const title = (deck && deck.title) || '';
  const lang = deck && deck.lang ? ` lang="${esc(deck.lang)}"` : '';
  let pages = '';
  if (layout === 'outline') pages = outlineHtml(deck, { notes, L });
  else if (layout === 'notes') {
    pages = parts.slides.map((sl, i) => `<div class="ho-page">${head(title, `${L.slide} ${i + 1} ${L.of} ${parts.slides.length}`)}${slot(sl, P.w)}<div class="ho-notes"${lang}><h3>${esc(L.notes)}</h3>${sl.notes ? sl.notes : `<span class="ho-none">${esc(L.noNotes)}</span>`}</div></div>`).join('');
  } else {
    const per = layout === '2' ? 2 : layout === '3' ? 3 : 6;
    const pageCount = Math.ceil(parts.slides.length / per);
    pages = chunks(parts.slides, per).map((group, p) => {
      const top = p * per;
      const right = `${L.page} ${p + 1} ${L.of} ${pageCount}`;
      if (per === 3) {
        const rowH = (P.h - 50 - 3 * 22) / 3; // three rows fill the page
        const w = Math.min(P.w * 0.55, (rowH - 22) * 16 / 9);
        const lines = Math.max(4, Math.floor(rowH / 27));
        return `<div class="ho-page">${head(title, right)}${group.map((sl, i) => `<div class="ho-row"><div>${slot(sl, w)}<p class="ho-n">${esc(L.slide)} ${top + i + 1}</p></div><div class="ho-lines" aria-hidden="true">${'<span></span>'.repeat(lines)}</div></div>`).join('')}</div>`;
      }
      const cols = per === 2 ? 1 : 2, rows = per === 2 ? 2 : 3;
      const w = Math.min(per === 2 ? P.w * 0.86 : (P.w - 24) / 2, ((P.h - 60 - (rows - 1) * 22) / rows - 22) * 16 / 9);
      return `<div class="ho-page">${head(title, right)}<div class="ho-grid" style="grid-template-columns:repeat(${cols},${n(w)}px)">${group.map((sl, i) => `<div>${slot(sl, w)}<p class="ho-n">${esc(L.slide)} ${top + i + 1}</p></div>`).join('')}</div></div>`;
    }).join('');
  }
  const style = `<style>${CSS(P)}</style>`;
  const headHtml = parts.head.replace(/<\/head>\s*$/, `${style}</head>`).replace(/<title>[^<]*<\/title>/, `<title>${esc(`${title} — ${(HANDOUT_LAYOUTS.find((x) => x[0] === layout) || HANDOUT_LAYOUTS[0])[1]}`)}</title>`);
  return `${headHtml}<body class="${esc(parts.bodyClass)} ho">${pages}</body></html>`;
}

/** The deck's words as an outline document: each slide's title, its points (sub-points nested), then its notes. */
export function outlineHtml(deck, { notes = true, L = {} } = {}) {
  const fields = deckFields(deck, { notes, alt: false });
  const lang = deck && deck.lang ? ` lang="${esc(deck.lang)}"` : '';
  const out = [`<article class="ho-out"${lang}><h1>${esc(deck.title)}</h1><p class="ho-sub">${esc(L.outline || 'Outline')} · ${deck.slides.length} ${esc(L.slides || 'slides')}</p>`];
  deck.slides.forEach((s, i) => {
    const own = fields.filter((f) => f.slide === i);
    const head = own.find((f) => f.keys[0] === 'title') || own.find((f) => f.keys[0] === 'quote');
    const body = own.filter((f) => f !== head && f.keys[0] !== 'notes' && f.keys[0] !== 'table');
    const tb = s.table && (s.table.header.length || s.table.rows.length) ? `<table>${s.table.header.length ? `<tr>${s.table.header.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>` : ''}${s.table.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>` : '';
    const note = own.find((f) => f.keys[0] === 'notes');
    const items = body.map((f) => `<li${f.keys.includes('sub') ? ' style="margin-left:1.2em"' : ''}>${f.label === 'Bullet' || f.label === 'Card text' || f.label === 'Text box' || f.label === 'Shape text' ? '' : `<b>${esc((L.field || ((x) => x))(f.label))}:</b> `}${esc(f.text)}</li>`).join('');
    out.push(`<section><h2>${i + 1}. ${esc(head ? head.text : s.layout)}</h2>${items ? `<ul>${items}</ul>` : ''}${tb}${note ? `<div class="ho-notes"><h3>${esc(L.notes || 'Speaker notes')}</h3>${esc(note.text)}</div>` : ''}</section>`);
  });
  out.push('</article>');
  return out.join('');
}
