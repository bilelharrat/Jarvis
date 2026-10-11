// The essay writer (askeden ROADMAP T11–T12): essays laid out on paper in MLA, APA, Chicago or Harvard
// and kept that way as you write. It lives in the canvas column (artifact.js; its own pane, as the
// spreadsheet's does), opened from the sidebar's Essays button or ⌘K. It opens on the side, like the browser panel,
// so the chat stays there to ask Eden things; the expand button (Wide) gives it the whole window.
//
// The rules are essay-model.js (page setup, title page or heading block, running header, headings,
// reference page) and essay-cite.js (sources in each style, in-text citations, Chicago's notes);
// the editor is Tiptap (essay-tiptap.min.mjs) with a footnote node; .docx and PDF are essay-export.js.
// Essays are kept in this browser (IndexedDB "eden-essays"), saved as you type, and on askeden.com they sync
// to the account like chats do (essay-cloud.js).
//
// On screen the text runs down one sheet with a line where each page will end (Word and the PDF
// paginate for real), the running header in the margin at each of those lines.

import { $, el, ico, toast, download, isMobile, relDay } from './util.js';
import { STYLES, STYLE_IDS, FONTS, SPACINGS, FIELD_LABELS, PAGE, styleOf, setupOf, frontMatter, titleLine, headerText, bodyText, countWords, outlineOf, progress, newEssay, essayFileName, feedbackRequest, formatDate, today, textToBlocks, inlineNodes, blocksOf, essayFromReply, TITLE_SYSTEM, cleanTitle, rubricRequest } from './essay-model.js';
import { formatReference, inText, sortReferences, plainText } from './essay-cite.js';
import { closeArtifact, setWide, artifactSend } from './artifact.js';
import { startEssaySync, syncSoon, noteDeleted, syncOn, dirty } from './essay-cloud.js';

// ── storage ──

let dbp = null;
function db() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  dbp ||= new Promise((resolve) => {
    try {
      const r = indexedDB.open('eden-essays', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('essays', { keyPath: 'id' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = r.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}
async function run(mode, fn) {
  const d = await db();
  if (!d) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = d.transaction('essays', mode);
      const req = fn(tx.objectStore('essays'));
      tx.oncomplete = () => resolve(req ? req.result : true);
      tx.onerror = tx.onabort = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}
const MEM = new Map(); // a private window without IndexedDB: this tab only
const listAll = async () => ((await db()) ? (await run('readonly', (s) => s.getAll())) || [] : [...MEM.values()]).sort((a, b) => b.updated - a.updated);
const saveOne = async (e) => { if (await db()) return run('readwrite', (s) => s.put(e)); MEM.set(e.id, e); return true; };
const getOne = async (id) => ((await db()) ? run('readonly', (s) => s.get(id)) : MEM.get(id));
const deleteOne = async (id) => { if (await db()) return run('readwrite', (s) => s.delete(id)); MEM.delete(id); return true; };

// ── the pane ──

const R = { pane: null, essay: null, editor: null, T: null, panel: 'details', saveT: 0, saved: true, view: 'home', srcEdit: null };
const STYLE_BLURB = {
  mla: 'Heading block, “Name 1” headers, Works Cited',
  apa: 'Title page, page numbers, bold headings, References',
  chicago: 'Title page, footnotes, Bibliography',
  harvard: 'Cover page, 1.5 spacing, Reference list',
};

function pane() {
  if (R.pane) return R.pane;
  R.tabTitle = el('span', { class: 'a-t', 'data-no-i18n': '' }, 'Essays');
  R.back = el('button', { type: 'button', class: 'iconbtn', title: 'All essays', 'aria-label': 'All essays', onclick: () => { flush(); showHome(); } }, ico('chevl'));
  R.wide = el('button', { type: 'button', class: 'iconbtn es-wide', title: 'Back to the side', 'aria-label': 'Back to the side', onclick: () => setWide(!$('artifact').classList.contains('full')) }, ico('collapse'));
  const strip = el('div', 'art-strip',
    R.back, el('div', 'art-tab', ico('edit'), R.tabTitle), el('span', 'art-sp'), R.wide,
    el('button', { type: 'button', class: 'iconbtn', title: 'Close · esc', 'aria-label': 'Close the essay', onclick: () => closeArtifact() }, ico('x')));
  R.body = el('div', 'es-view');
  R.pane = el('section', { class: 'es-pane', 'aria-label': 'Essay writer' }, strip, R.body);
  $('artifact').append(R.pane);
  new MutationObserver(canvasClassChanged).observe($('artifact'), { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(() => { if (!$('split').classList.contains('art-open')) flush(); }).observe($('split'), { attributes: true, attributeFilter: ['class'] });
  addEventListener('pagehide', flush);
  // sync with the account (askeden.com): the open essay is the live copy, so its revision stays on it
  syncOn().then((on) => { R.syncOn = on; if (R.view === 'home') showHome(); });
  startEssaySync({
    list: listAll,
    get: async (id) => (R.essay && R.essay.id === id ? R.essay : getOne(id)),
    save: saveOne,
    remove: deleteOne,
    busy: (id) => !!(R.essay && R.essay.id === id && !R.saved),
    onSynced: () => footer(),
    onPulled: (e, how) => {
      if (how === 'list') { if (R.view === 'home') showHome(); return; }
      if (!R.essay || !e || R.essay.id !== e.id) return;
      if (how === 'deleted') { R.essay = null; showHome(); toast('That essay was deleted on another device'); return; }
      R.essay = e; build(); toast('Updated from another device');
    },
  });
  document.addEventListener('click', (ev) => {
    if (R.exportMenu && !R.exportMenu.contains(ev.target)) R.exportMenu.hidden = true;
    if (R.moreWrap && !R.moreWrap.contains(ev.target)) setMore(false);
  });
  R.pane.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && R.extra && R.extra.classList.contains('open')) { ev.stopPropagation(); setMore(false); R.moreBtn.focus(); } });
  return R.pane;
}

// The canvas showing something else (a page, a deck, a spreadsheet) or closing: save, step aside.
// Touches #artifact's class only when it must: classList.remove re-sets the attribute even when the
// token isn't there, which is a new mutation for this same observer (a sheet opened after an essay
// looped here forever, AV2-1), and the button only when its state changes.
function canvasClassChanged() {
  const a = $('artifact');
  if (a.classList.contains('sheet-on') && a.classList.contains('essay-on')) a.classList.remove('essay-on');
  const full = a.classList.contains('full');
  if (R.wideFull !== full) {
    R.wideFull = full;
    R.wide.replaceChildren(ico(full ? 'collapse' : 'expand'));
    R.wide.title = full ? 'Back to the side' : 'Wide';
    R.wide.setAttribute('aria-label', R.wide.title);
  }
  if (!a.classList.contains('essay-on')) flush();
}

function showPane() {
  pane();
  const a = $('artifact');
  a.classList.remove('sheet-on');
  a.classList.add('essay-on');
  $('split').classList.add('art-open');
  $('split').classList.remove('chat-view');
  document.body.classList.remove('canvas-hidden');
}

/** The Essays list (the sidebar's Essays button, ⌘K). */
export async function openEssays() {
  showPane();
  await showHome();
}

/** A new essay in a style, opened. */
export async function newEssayIn(style = lastStyle()) {
  showPane();
  rememberStyle(style);
  const e = newEssay(style);
  await saveOne(e);
  await openEssay(e);
}

/**
 * A saved essay, opened beside the chat (the chat it was written in brings it back: essay-chat.js, c.essayId).
 * false when it's gone (deleted, or not in this browser).
 */
export async function openEssayById(id) {
  if (!id) return false;
  if (R.essay && R.essay.id === id && R.view === 'essay') { showPane(); return true; }
  const e = await getOne(id);
  if (!e) return false;
  await flush(); // the essay on screen keeps its last words
  showPane();
  await openEssay(e);
  return true;
}

async function showHome() {
  R.view = 'home';
  R.essay = null;
  R.pane.dataset.essay = ''; // essay-chat.js: which essay is on screen ('' the list)
  destroyEditor();
  R.tabTitle.textContent = 'Essays';
  R.back.hidden = true;
  const list = await listAll();
  const card = (e) => {
    const p = progress(e);
    return el('div', 'es-card',
      el('button', { type: 'button', class: 'es-card-open', onclick: () => openEssay(e) },
        el('span', { class: 'es-card-t', 'data-no-i18n': '' }, (e.details && e.details.title) || 'Untitled essay'),
        el('span', 'es-card-m', `${styleOf(e.style).label} · ${p.words.toLocaleString()} words · ${relDay(e.updated)}`)),
      el('button', { type: 'button', class: 'iconbtn', title: 'Delete this essay', 'aria-label': 'Delete this essay', onclick: async () => {
        if (!confirm(`Delete “${(e.details && e.details.title) || 'Untitled essay'}”? This can’t be undone.`)) return;
        await deleteOne(e.id); noteDeleted(e); showHome();
      } }, ico('trash')));
  };
  R.body.replaceChildren(el('div', 'es-home',
    el('h2', null, 'Essays'),
    el('p', 'es-lead', 'Pick a style and write: the title page, headers, page numbers, spacing, headings and the sources page are laid out for you, and stay right if you switch style.'),
    el('div', 'es-new', ...STYLE_IDS.map((id) => el('button', { type: 'button', class: 'es-new-b', onclick: () => newEssayIn(id) },
      el('b', null, `New ${STYLES[id].label} essay`), el('span', null, STYLE_BLURB[id])))),
    list.length ? el('h3', null, 'Your essays') : null,
    list.length ? el('div', 'es-list', ...list.map(card)) : el('p', 'es-empty', R.syncOn ? 'Your essays show here, on every device you sign in on.' : 'Your essays show here. They’re kept in this browser.')));
}

// ── one essay ──

async function openEssay(e) {
  R.essay = e;
  R.view = 'essay';
  R.pane.dataset.essay = e.id;
  R.back.hidden = false;
  R.tabTitle.textContent = (e.details && e.details.title) || 'Untitled essay';
  R.body.replaceChildren(el('div', 'art-loading', 'Opening the editor…'));
  try { R.T ||= await import('./essay-tiptap.min.mjs'); }
  catch (err) { R.body.replaceChildren(el('div', 'art-loading', `Couldn’t load the editor: ${err.message}`)); return; }
  if (R.essay !== e) return;
  build();
}

function destroyEditor() {
  if (R.editor) { R.editor.destroy(); R.editor = null; }
  if (R.ro) { R.ro.disconnect(); R.ro = null; }
}

const opt = (value, label, on) => el('option', { value, selected: on || undefined }, label);
const tbtn = (label, title, onclick, cls = '') => el('button', { type: 'button', class: `es-tb ${cls}`.trim(), title, 'aria-label': title, onmousedown: (ev) => ev.preventDefault(), onclick }, label);

function build() {
  destroyEditor();
  const e = R.essay;
  const T = R.T;
  // the footnote: an inline atom carrying its text, numbered by a CSS counter, its text edited in the Notes under the page
  const Footnote = T.Node.create({
    name: 'footnote', group: 'inline', inline: true, atom: true, selectable: true,
    addAttributes: () => ({ text: { default: '' } }),
    parseHTML: () => [{ tag: 'sup[data-footnote]', getAttrs: (d) => ({ text: d.getAttribute('data-text') || '' }) }],
    renderHTML: ({ node }) => ['sup', T.mergeAttributes({ 'data-footnote': '', 'data-text': node.attrs.text, class: 'es-fn', title: node.attrs.text || 'Footnote' })],
  });

  // a citation: the source's id and page; drawn in the essay's style (in the text, or as a numbered note in
  // Chicago), so switching style or editing the source redraws every citation
  const Cite = T.Node.create({
    name: 'cite', group: 'inline', inline: true, atom: true, selectable: true,
    addAttributes: () => ({ sid: { default: '' }, page: { default: '' } }),
    parseHTML: () => [{ tag: 'span[data-cite]', getAttrs: (d) => ({ sid: d.getAttribute('data-cite') || '', page: d.getAttribute('data-page') || '' }) }],
    renderHTML: ({ node }) => ['span', { 'data-cite': node.attrs.sid, 'data-page': node.attrs.page }],
    addNodeView: () => ({ node }) => {
      const view = { dom: document.createElement('span'), node, update(n) { if (n.type.name !== 'cite') return false; view.node = n; drawCite(view); return true; }, destroy() { CITES.delete(view); } };
      CITES.add(view);
      drawCite(view);
      return view;
    },
  });

  // toolbar
  R.styleSel = el('select', { 'aria-label': 'Style', title: 'Style: lays out the whole essay', onchange: () => setStyle(R.styleSel.value) }, ...STYLE_IDS.map((id) => opt(id, STYLES[id].label, id === e.style)));
  R.blockSel = el('select', { 'aria-label': 'Text style', onchange: () => setBlock(R.blockSel.value) },
    opt('p', 'Normal text'), opt('h1', 'Heading 1'), opt('h2', 'Heading 2'), opt('h3', 'Heading 3'), opt('quote', 'Block quote'));
  R.fontSel = el('select', { 'aria-label': 'Font', onchange: () => setFormat('font', R.fontSel.value) });
  R.spaceSel = el('select', { 'aria-label': 'Line spacing', onchange: () => setFormat('spacing', R.spaceSel.value) });
  R.alignSel = el('select', { 'aria-label': 'Alignment', onchange: () => { R.editor.chain().focus().setTextAlign(R.alignSel.value).run(); } },
    opt('left', 'Left'), opt('center', 'Center'), opt('right', 'Right'), opt('justify', 'Justify'));
  const cmd = (f) => () => { f(R.editor.chain().focus()).run(); };
  R.marks = {
    bold: tbtn(el('b', null, 'B'), 'Bold · ⌘B', cmd((c) => c.toggleBold())),
    italic: tbtn(el('i', null, 'I'), 'Italic · ⌘I', cmd((c) => c.toggleItalic())),
    underline: tbtn(el('u', null, 'U'), 'Underline · ⌘U', cmd((c) => c.toggleUnderline())),
  };
  R.lists = {
    bulletList: tbtn('•', 'Bulleted list', cmd((c) => c.toggleBulletList())),
    orderedList: tbtn('1.', 'Numbered list', cmd((c) => c.toggleOrderedList())),
  };
  R.exportMenu = el('div', { class: 'es-menu', hidden: true, role: 'menu' },
    el('button', { type: 'button', role: 'menuitem', onclick: () => { R.exportMenu.hidden = true; exportDocx(); } }, 'Word document (.docx)'),
    el('button', { type: 'button', role: 'menuitem', onclick: () => { R.exportMenu.hidden = true; exportPdf(); } }, 'PDF (print, then Save as PDF)'));
  // One row beside the chat (T20d): the essentials stay in the bar (style, text style, B/I/U, Undo/Redo, the
  // panels, Export, Feedback); font, spacing, alignment, lists and footnote fold into More when the pane is
  // narrow, and the panel, Export and Feedback labels give way to their icons (essay.css container queries).
  const lbl = (t) => el('span', 'es-l', t);
  const exportBtn = el('button', { type: 'button', class: 'cap es-x', title: 'Export: Word or PDF', 'aria-label': 'Export', 'aria-haspopup': 'menu', onclick: (ev) => { ev.stopPropagation(); setMore(false); R.exportMenu.hidden = !R.exportMenu.hidden; } }, ico('down', 12), lbl('Export'));
  const PANELS = { rubric: ['Rubric', 'check'], details: ['Details', 'doc'], sources: ['Sources', 'quote'], outline: ['Outline', 'list'] };
  R.panelBtns = Object.fromEntries(Object.entries(PANELS).map(([k, [t, i]]) => [k, el('button', { type: 'button', class: 'es-pb', title: t, 'aria-label': t, 'aria-pressed': 'false', hidden: k === 'rubric' && !e.rubric, onclick: () => togglePanel(k) }, ico(i, 14), lbl(t))]));
  R.extra = el('div', { class: 'es-extra', role: 'group', 'aria-label': 'More formatting' },
    el('span', 'es-sep'), R.fontSel, R.spaceSel, R.alignSel, R.lists.bulletList, R.lists.orderedList,
    tbtn(el('span', 'es-fn-ico', 'x¹'), 'Footnote', () => { setMore(false); addFootnote(); }));
  R.moreBtn = tbtn(ico('more', 15), 'More formatting: font, spacing, alignment, lists, footnote', (ev) => { ev.stopPropagation(); setMore(!R.extra.classList.contains('open')); }, 'es-more-btn');
  R.moreBtn.setAttribute('aria-expanded', 'false');
  R.moreWrap = el('div', 'es-more-wrap', R.moreBtn, R.extra);
  const bar = el('div', { class: 'es-bar', role: 'toolbar', 'aria-label': 'Formatting' },
    R.styleSel, el('span', 'es-sep'), R.blockSel, el('span', 'es-sep'),
    R.marks.bold, R.marks.italic, R.marks.underline, R.moreWrap, el('span', 'es-sep'),
    tbtn('↶', 'Undo · ⌘Z', cmd((c) => c.undo())), tbtn('↷', 'Redo · ⇧⌘Z', cmd((c) => c.redo())),
    el('span', 'art-sp'),
    R.panelBtns.rubric, R.panelBtns.details, R.panelBtns.sources, R.panelBtns.outline,
    el('div', 'es-menu-wrap', exportBtn, R.exportMenu),
    el('button', { type: 'button', class: 'cap es-ask', title: 'Eden comments on your argument, evidence and structure in the chat; it doesn’t rewrite your essay', 'aria-label': 'Feedback', onclick: askFeedback }, ico('spark', 12), lbl('Feedback')));

  // the paper
  R.zoom = el('div', 'es-zoom');
  R.scroll = el('div', { class: 'es-scroll' }, R.zoom);
  R.side = el('aside', { class: 'es-side', 'aria-label': 'Essay panel' });
  R.foot = el('div', { class: 'es-foot', 'aria-live': 'polite' });
  R.main = el('div', 'es-main', R.scroll, R.side);
  R.flow = null;
  R.body.replaceChildren(bar, R.main, R.foot);

  R.tp = el('div', { class: 'es-sheet es-tp', role: 'button', tabindex: '0', title: 'Edit the title page in Details', onclick: () => openPanel('details'), onkeydown: (ev) => { if (ev.key === 'Enter') openPanel('details'); } });
  R.sheet = el('div', 'es-sheet es-main-sheet');
  R.fm = el('div', { class: 'es-fm', title: 'Edit these in Details', onclick: () => openPanel('details') });
  R.title = el('div', { class: 'es-title', title: 'Edit the title in Details', onclick: () => openPanel('details', 'title') });
  R.bodyEl = el('div', 'es-body');
  R.guides = el('div', { class: 'es-guides', 'aria-hidden': 'true' });
  R.notes = el('div', 'es-notes');
  R.sheet.append(R.guides, R.fm, R.title, R.bodyEl, R.notes);
  R.refs = el('div', 'es-sheet es-refs');
  R.zoom.append(R.tp, R.sheet, R.refs);

  R.editor = new T.Editor({
    element: R.bodyEl,
    extensions: [
      T.StarterKit.configure({ heading: { levels: [1, 2, 3] }, code: false, codeBlock: false, horizontalRule: false }),
      T.Underline, T.TextAlign.configure({ types: ['heading', 'paragraph'] }),
      T.Placeholder.configure({ placeholder: 'Start writing your essay…' }),
      Footnote, Cite,
    ],
    content: e.doc,
    editorProps: {
      attributes: { class: 'es-prose', spellcheck: 'true', 'aria-label': 'Essay text', 'aria-multiline': 'true', role: 'textbox' },
      // ⌘V of a chat reply (Markdown, chatter, a title line, a Works Cited list): cleaned up like "Paste into essay"; other text pastes as usual
      handlePaste: (view, event) => {
        const text = event.clipboardData && event.clipboardData.getData('text/plain');
        if (!text || countWords(text) < 40) return false;
        const r = essayFromReply(text);
        const flat = (x) => x.replace(/\s+/g, ' ').trim();
        if (!(r.title || r.references.length || /^#{1,3}\s|\*\*|^\s*[-*]\s/m.test(text) || flat(r.body) !== flat(text))) return false;
        putReply(r, 'cursor');
        return true;
      },
    },
    onUpdate: () => { changed(); layoutSoon(); },
    onSelectionUpdate: () => { syncBar(); footer(); },
    onTransaction: ({ transaction }) => { mapTracked(transaction); syncBar(); },
  });
  R.bodyEl.addEventListener('click', (ev) => { const sup = ev.target.closest(NOTE_SEL); if (sup) focusNote([...R.bodyEl.querySelectorAll(NOTE_SEL)].indexOf(sup)); });
  notes(true);
  R.ro = new ResizeObserver(() => { fit(); layoutSoon(); });
  R.ro.observe(R.main); // the pane's width (fit() decides the scroll's own: paper or text view, panel beside or above)
  restyle();
  // The panel opens by itself only where it leaves the page readable beside it (Wide, a big screen), and the
  // focus goes to the text (to type or paste at once): the title and heading placeholders on the page open
  // Details, as does the footer's hint. Just made from a rubric: the rubric shows (beside, or above the empty page).
  const fresh = e.rubric && R.panel === 'rubric';
  const pref = R.panelPref === undefined || (R.panelPref === 'rubric' && !e.rubric) ? 'details' : R.panelPref;
  togglePanel(fresh ? 'rubric' : !isMobile() && panelFits() ? pref : null, true);
  syncBar();
  R.editor.commands.focus('end');
}

/** Room for the panel beside a readable page (Wide, a big screen): it opens by itself only then. */
function panelFits() {
  const w = R.main ? R.main.clientWidth : 0;
  if (!w) return false;
  const l = paneLayout(w, { panel: true });
  return !l.drawer && !l.flow;
}

/** The style and this essay's choices as CSS variables on the paper, and the parts made from them. */
function restyle() {
  const e = R.essay, s = setupOf(e);
  const v = R.zoom.style;
  const sans = /Arial|Calibri/.test(s.font);
  v.setProperty('--es-font', `"${s.font}", ${sans ? 'Helvetica, sans-serif' : '"Times New Roman", Times, serif'}`);
  v.setProperty('--es-size', `${(s.size * 4) / 3}px`);
  v.setProperty('--es-line', String(+(1.15 * s.spacing).toFixed(3)));
  v.setProperty('--es-indent', s.indent ? '0.5in' : '0');
  v.setProperty('--es-gap', s.gap ? '1em' : '0');
  v.setProperty('--es-q-line', String(+(1.15 * s.quote.spacing).toFixed(3)));
  v.setProperty('--es-q-gap', s.quote.spacing === 1 ? '1em' : '0');
  for (const lv of [1, 2, 3]) {
    const h = s.headings[lv];
    v.setProperty(`--es-h${lv}-align`, h.align);
    v.setProperty(`--es-h${lv}-weight`, h.bold ? '700' : '400');
    v.setProperty(`--es-h${lv}-style`, h.italic ? 'italic' : 'normal');
  }
  R.zoom.dataset.style = s.id;
  // toolbar: the font and spacing menus say which is the style's own
  R.fontSel.replaceChildren(...[...new Set([styleOf(e.style).font, ...FONTS])].map((f) => opt(f, f === styleOf(e.style).font ? `${f} (${s.label})` : f, f === s.font)));
  const sp = (n) => ({ 1: 'Single', 1.15: '1.15', 1.5: '1.5', 2: 'Double' }[n] || String(n));
  R.spaceSel.replaceChildren(...SPACINGS.map((n) => opt(String(n), n === styleOf(e.style).spacing ? `${sp(n)} (${s.label})` : sp(n), n === s.spacing)));
  R.styleSel.value = s.id;
  front();
  references();
  redrawCites();
  layoutSoon();
}

/** The title page or heading block, and the title line, from the details. */
function front() {
  const e = R.essay, s = setupOf(e);
  const fm = frontMatter(e);
  const lineEl = (l) => el('div', { class: `es-fm-l${l.placeholder ? ' ph' : ''}`, style: { textAlign: l.align, fontWeight: l.bold ? '700' : '400', marginTop: l.space ? `calc(${l.space} * 2 * 1.15em)` : '' }, 'data-no-i18n': l.placeholder ? undefined : '' }, l.text);
  R.tp.hidden = fm.kind !== 'titlepage';
  if (fm.kind === 'titlepage') R.tp.replaceChildren(el('div', 'es-hdr', s.numberTitlePage ? headerText(e, 1) : ''), ...fm.lines.map(lineEl));
  R.fm.hidden = fm.kind !== 'heading';
  R.fm.replaceChildren(...(fm.kind === 'heading' ? fm.lines.map(lineEl) : []));
  if (fm.kind === 'heading' && !fm.lines.length) R.fm.replaceChildren(el('div', 'es-fm-l ph', 'Your name, instructor, course and date go here: add them in Details'));
  const t = titleLine(e);
  R.title.hidden = !t;
  if (t) { R.title.textContent = t.text; R.title.className = `es-title${t.placeholder ? ' ph' : ''}${t.bold ? ' bold' : ''}`; }
  R.tabTitle.textContent = (e.details && e.details.title) || 'Untitled essay';
}

/** The reference page: the sources sorted and formatted in the essay's style. */
function references() {
  const e = R.essay, s = setupOf(e);
  const refs = sortReferences(s.id, e.sources || []);
  R.refs.hidden = !refs.length;
  if (!refs.length) { R.refs.replaceChildren(); return; }
  const pages = pagesBefore();
  R.refs.replaceChildren(
    el('div', 'es-hdr', headerText(e, pages + 1)),
    el('div', { class: 'es-refs-t', style: { textAlign: s.refs.align, fontWeight: s.refs.bold ? '700' : '400', marginBottom: s.refs.gap ? '2em' : '0' } }, s.refs.title),
    ...refs.map((src) => el('p', { class: `es-ref${s.refs.hanging ? ' hang' : ''}`, style: { lineHeight: String(1.15 * s.refs.spacing), marginBottom: s.refs.gap ? '1em' : '0' }, 'data-no-i18n': '' },
      ...formatReference(s.id, src).map((g) => (g.i ? el('i', null, g.t) : g.t)))));
}

// ── page lines (where each page will end) ──

const BODY_H = PAGE.height - 2 * PAGE.margin; // 864 px of text per page
let layoutT = 0;
function layoutSoon() { clearTimeout(layoutT); layoutT = setTimeout(layout, 120); }
function firstBodyPage() { return frontMatter(R.essay).kind === 'titlepage' ? 2 : 1; }
/** The body's pages on paper (offsetHeight ignores the zoom). The text view's are counted by layout() on the paper's width. */
function bodyPages() {
  if (!R.sheet) return 1;
  if (R.flow && !R.measuring) return R.flowPages || 1;
  const h = R.fm.offsetHeight + R.title.offsetHeight + R.bodyEl.offsetHeight + R.notes.offsetHeight;
  return Math.max(1, Math.ceil(h / BODY_H));
}
const pagesBefore = () => firstBodyPage() - 1 + bodyPages();
/**
 * The text view reflows the text to the pane, so its pages are counted on the paper: the view's class comes off
 * for the measure and back on in the same task (nothing is drawn between), the scroll put back as it was.
 */
function measureFlowPages() {
  const top = R.scroll.scrollTop;
  R.measuring = true;
  R.main.classList.remove('es-flow');
  try { R.flowPages = bodyPages(); } finally {
    R.main.classList.add('es-flow');
    R.measuring = false;
    R.scroll.scrollTop = top;
  }
}
function layout() {
  if (!R.essay || !R.sheet) { footer(); return; }
  if (R.flow) {
    // the text view: no page lines or running heads (they'd sit at the wrong places), just the page count
    measureFlowPages();
    R.sheet.style.minHeight = '';
    R.guides.replaceChildren();
    if (R.panel === 'outline') renderPanel();
    footer();
    return;
  }
  const n = bodyPages(), first = firstBodyPage();
  R.sheet.style.minHeight = `${n * BODY_H + 2 * PAGE.margin}px`;
  const marks = [el('div', { class: 'es-hdr', style: { top: '0px' } }, headerText(R.essay, first))];
  for (let k = 1; k < n; k++) {
    // the text runs on without a gap, so the next page's header rides on its line, at the right
    marks.push(el('div', { class: 'es-pgline', style: { top: `${PAGE.margin + k * BODY_H}px` } }, el('span', null, `Page ${first + k}`), el('span', { class: 'r', 'data-no-i18n': '' }, headerText(R.essay, first + k))));
  }
  R.guides.replaceChildren(...marks);
  const rh = R.refs.querySelector('.es-hdr');
  if (rh) rh.textContent = headerText(R.essay, pagesBefore() + 1);
  if (R.panel === 'outline') renderPanel();
  footer();
}

// ── paper or text view, and where the panel goes (T20d) ──

const READABLE = 0.8; // the paper below this zoom is too small to read (12 pt at 0.62 is ≈10 px): the text view instead
const BESIDE_MIN = 460; // the writing beside an open panel needs this much width, else the panel goes above it
const sideWidth = (w) => (w <= 1000 ? 264 : 300); // essay.css .es-side
const paperPad = (w) => (w <= 900 ? 12 : 24); // essay.css .es-scroll's side padding around the paper

/**
 * The paper fits the pane's width `w` (zoom, never above 100%). Where that would make it unreadable (beside the
 * chat on a laptop, a phone) the text view shows instead (`flow`): the same text reflowed at its real size, the
 * pages counted on paper; Wide (`full`) always keeps the paper. An open panel sits beside the writing when
 * there's room, else as a drawer above it (`drawer`): never over the text.
 */
function paneLayout(w, { panel = false, phone = false, full = false } = {}) {
  const side = panel ? sideWidth(w) : 0;
  const drawer = panel && (phone || w - side < BESIDE_MIN);
  const zoom = Math.min(1, Math.max(0.4, (w - (drawer ? 0 : side) - 2 * paperPad(w)) / PAGE.width));
  return { drawer, flow: phone || (!full && zoom < READABLE), zoom };
}

function fit() {
  if (!R.scroll || !R.zoom || !R.main) return;
  const w = R.main.clientWidth;
  if (!w) return; // not on screen
  const { drawer, flow, zoom: z } = paneLayout(w, { panel: !!R.panel, phone: isMobile(), full: $('artifact').classList.contains('full') });
  R.main.classList.toggle('es-drawer', drawer);
  if (flow !== R.flow) {
    R.flow = flow;
    R.main.classList.toggle('es-flow', flow);
    if (flow && R.sheet) measureFlowPages(); else R.flowPages = 0;
    layoutSoon();
    footer();
  }
  R.zoom.style.zoom = flow ? '' : String(z);
}

/** The More menu (font, spacing, alignment, lists, footnote) in a narrow pane. */
function setMore(on) {
  if (!R.extra) return;
  if (on) { const b = R.moreBtn.getBoundingClientRect(), p = R.pane.getBoundingClientRect(); R.extra.classList.toggle('end', b.left + 260 > p.right); } // opens leftwards near the pane's edge
  R.extra.classList.toggle('open', on);
  R.moreBtn.setAttribute('aria-expanded', String(on));
  if (on && R.exportMenu) R.exportMenu.hidden = true;
}

// ── footer: words, goal, pages, saved ──

function footer() {
  if (!R.essay || !R.foot) return;
  const e = R.essay;
  const doc = R.editor ? R.editor.getJSON() : e.doc;
  const words = countWords(bodyText(doc));
  const goal = Number(e.goal) || 0;
  let sel = '';
  if (R.editor) {
    const { from, to } = R.editor.state.selection;
    if (to > from) sel = `${countWords(R.editor.state.doc.textBetween(from, to, ' ', ' ')).toLocaleString()} of `;
  }
  const pages = pagesBefore() + (e.sources && e.sources.length ? 1 : 0);
  const bar = goal ? el('span', { class: 'es-goal', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(goal), 'aria-valuenow': String(words), title: `${words.toLocaleString()} of ${goal.toLocaleString()} words` }, el('i', { style: { width: `${Math.min(100, (words / goal) * 100)}%` } })) : null;
  if (R.rubWords) R.rubWords.textContent = `${words.toLocaleString()} written`; // the Rubric panel's count follows the text (Eden's writing too)
  const untitled = !(e.details && e.details.title);
  R.foot.replaceChildren(...[
    el('span', 'es-wc', `${sel}${words.toLocaleString()} word${words === 1 ? '' : 's'}`),
    goal ? el('span', 'es-goal-n', `goal ${goal.toLocaleString()}`) : null, bar,
    el('span', null, `about ${pages} page${pages === 1 ? '' : 's'}`),
    // a new essay: the way to its title and heading, without a panel over the page
    untitled && R.panel !== 'details' ? el('button', { type: 'button', class: 'es-foot-b', title: 'The title, your name and the course: they fill the heading and the running header', onclick: () => openPanel('details', 'title') }, ico('doc', 11), 'Add the title') : null,
    // the text view: Wide shows it on its pages (running header, page lines)
    R.flow && !isMobile() ? el('button', { type: 'button', class: 'es-foot-b', title: 'Wide: the essay on its pages, with the running header and where each page ends', onclick: () => setWide(true) }, ico('expand', 11), 'See the pages') : null,
    el('span', 'art-sp'),
    el('span', 'es-saved', !R.saved ? 'Saving…' : !R.syncOn ? 'Saved in this browser' : dirty(e) ? 'Saved · syncing…' : 'Saved and synced')].filter(Boolean));
}

// ── editing ──

function changed() {
  R.saved = false;
  clearTimeout(R.saveT);
  R.saveT = setTimeout(flush, 600);
  notes();
}

async function flush() {
  clearTimeout(R.saveT);
  const e = R.essay;
  if (!e) return;
  if (R.editor) e.doc = R.editor.getJSON();
  if (R.saved) return;
  e.updated = Date.now();
  await saveOne(e);
  R.saved = true;
  footer();
  maybeTitle();
  if (R.syncOn) syncSoon();
}
const touch = () => { R.saved = false; clearTimeout(R.saveT); R.saveT = setTimeout(flush, 400); };

function syncBar() {
  const ed = R.editor;
  if (!ed || !R.blockSel) return;
  for (const [k, b] of Object.entries(R.marks)) b.classList.toggle('on', ed.isActive(k));
  for (const [k, b] of Object.entries(R.lists)) b.classList.toggle('on', ed.isActive(k));
  R.blockSel.value = ed.isActive('blockquote') ? 'quote' : ed.isActive('heading', { level: 1 }) ? 'h1' : ed.isActive('heading', { level: 2 }) ? 'h2' : ed.isActive('heading', { level: 3 }) ? 'h3' : 'p';
  R.alignSel.value = ['center', 'right', 'justify'].find((a) => ed.isActive({ textAlign: a })) || 'left';
}

function setBlock(v) {
  const c = R.editor.chain().focus();
  if (R.editor.isActive('blockquote') && v !== 'quote') c.lift('blockquote');
  if (v === 'p') c.setParagraph();
  else if (v === 'quote') { c.setParagraph(); if (!R.editor.isActive('blockquote')) c.setBlockquote(); }
  else c.setHeading({ level: Number(v.slice(1)) });
  c.run();
}

function setStyle(id) {
  const e = R.essay;
  if (!STYLES[id] || e.style === id) return;
  e.style = id;
  rememberStyle(id);
  e.format = {}; // a new style brings its own font and spacing
  touch();
  restyle();
  if (R.panel) renderPanel();
  toast(`Laid out in ${STYLES[id].long}`);
}

function setFormat(k, v) {
  const e = R.essay, s = styleOf(e.style);
  e.format = { ...(e.format || {}) };
  if ((k === 'font' && v === s.font) || (k === 'spacing' && Number(v) === s.spacing)) delete e.format[k];
  else e.format[k] = k === 'spacing' ? Number(v) : v;
  touch();
  restyle();
  R.editor.commands.focus();
}

// ── footnotes ──

const CITES = new Set(); // the citations on screen (their node views)
const NOTE_SEL = 'sup[data-footnote], .es-cite.es-fn';
const sourceOf = (sid) => ((R.essay && R.essay.sources) || []).find((x) => x.id === sid);

function drawCite(v) {
  const s = styleOf(R.essay.style), src = sourceOf(v.node.attrs.sid);
  const segs = src ? inText(s.id, src, v.node.attrs.page ? { page: v.node.attrs.page } : {}) : [];
  if (s.notes) { v.dom.className = 'es-fn es-cite'; v.dom.replaceChildren(); v.dom.title = src ? plainText(segs) : 'A source you removed'; }
  else { v.dom.className = `es-cite${src ? '' : ' gone'}`; v.dom.title = src ? '' : 'A source you removed'; v.dom.replaceChildren(...(src ? segs.map((g) => (g.i ? el('i', null, g.t) : g.t)) : ['(source removed)'])); }
}
const redrawCites = () => { for (const v of CITES) drawCite(v); notes(true); };

/** The notes in order: footnotes (their text, editable) and, in Chicago, citations (made from the source). */
function noteList() {
  const out = [], s = styleOf(R.essay.style);
  R.editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'footnote') out.push({ pos, text: node.attrs.text, edit: true });
    else if (node.type.name === 'cite' && s.notes) { const src = sourceOf(node.attrs.sid); out.push({ pos, text: src ? plainText(inText(s.id, src, node.attrs.page ? { page: node.attrs.page } : {})) : 'A source you removed.', edit: false }); }
    return true;
  });
  return out;
}

function addFootnote() {
  R.editor.chain().focus().insertContent({ type: 'footnote', attrs: { text: '' } }).run();
  const i = [...R.bodyEl.querySelectorAll(NOTE_SEL)].findIndex((s) => s.classList.contains('ProseMirror-selectednode'));
  notes(true);
  focusNote(i >= 0 ? i : noteList().length - 1);
}

function setNote(i, text) {
  const ed = R.editor, n = noteList()[i];
  if (!n || !n.edit) return;
  const node = ed.state.doc.nodeAt(n.pos);
  ed.view.dispatch(ed.state.tr.setNodeMarkup(n.pos, undefined, { ...node.attrs, text }));
}

/** The Notes under the text: a field per footnote (kept while you type in one), a citation's note as text. */
function notes(force = false) {
  if (!R.editor || !R.notes) return;
  const list = noteList();
  const items = [...R.notes.querySelectorAll('li')];
  const same = items.length === list.length && items.every((li, i) => !!li.querySelector('input') === list[i].edit);
  if (!force && same) {
    items.forEach((li, i) => { const f = li.querySelector('input'); if (f) { if (document.activeElement !== f && f.value !== list[i].text) f.value = list[i].text; } else li.firstChild.textContent = list[i].text; });
    return;
  }
  R.notes.hidden = !list.length;
  R.notes.replaceChildren(...(list.length ? [el('div', 'es-notes-t', 'Notes'), el('ol', null, ...list.map((n, i) => el('li', null, n.edit
    ? el('input', { type: 'text', value: n.text, 'aria-label': `Footnote ${i + 1}`, placeholder: 'The note’s text', 'data-no-i18n': '', oninput: (ev) => setNote(i, ev.target.value), onkeydown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); R.editor.commands.focus(); } } })
    : el('span', { class: 'es-note-cite', 'data-no-i18n': '', title: 'Made from the source: edit it in Sources' }, n.text))))] : []));
}
function focusNote(i) { const li = R.notes.querySelectorAll('li')[i]; const f = li && li.querySelector('input'); if (f) { f.focus(); f.select(); } else if (li) li.scrollIntoView({ block: 'nearest' }); }

// ── the side panel: Details, Sources, Outline ──

function openPanel(k, focus) { togglePanel(k, true); R.panelPref = k; if (focus) setTimeout(() => { const f = R.side.querySelector(`[name="${focus}"]`); if (f) f.focus(); }, 30); }
/** `on` true: open k (build, the page's placeholders); else the person's own toggle, which the next essay opens with. */
function togglePanel(k, on) {
  R.panel = on === true ? k : R.panel === k ? null : k;
  if (on !== true) R.panelPref = R.panel;
  for (const [n, b] of Object.entries(R.panelBtns)) b.setAttribute('aria-pressed', String(n === R.panel));
  R.side.hidden = !R.panel;
  renderPanel();
  fit(); // beside the writing or above it, now (no frame with the panel over the page)
  footer();
}

function renderPanel() {
  R.rubWords = null;
  if (!R.panel) return;
  const head = (t) => el('div', 'es-side-h', el('b', null, t), el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Close the panel', title: 'Close the panel', onclick: () => togglePanel(R.panel) }, ico('x', 13)));
  if (R.panel === 'details') R.side.replaceChildren(head('Details'), detailsForm());
  else if (R.panel === 'sources') R.side.replaceChildren(head('Sources'), sourcesPanel());
  else if (R.panel === 'rubric') R.side.replaceChildren(head('Rubric'), rubricPanel());
  else R.side.replaceChildren(head('Outline'), outlinePanel());
}

function rubricPanel() {
  const e = R.essay, r = e.rubric || {};
  const s = styleOf(e.style);
  const words = R.editor ? countWords(bodyText(R.editor.getJSON())) : progress(e).words;
  const range = r.minWords && r.maxWords ? `${r.minWords.toLocaleString()}–${r.maxWords.toLocaleString()} words` : r.maxWords ? `${r.maxWords.toLocaleString()} words` : '';
  return el('div', 'es-side-b',
    el('div', 'es-rub-chips', el('span', 'es-chip', s.label), range ? el('span', 'es-chip', range) : null, R.rubWords = el('span', 'es-chip', `${words.toLocaleString()} written`)),
    el('button', { type: 'button', class: 'cap primary', onclick: checkRubric }, ico('spark', 12), 'Check my essay against the rubric'),
    el('p', 'es-f-n', 'Eden keeps this rubric in mind whenever it writes or edits here.'),
    el('div', { class: 'es-rub-name', 'data-no-i18n': '' }, r.name || 'Assignment'),
    el('div', { class: 'es-rub-text', 'data-no-i18n': '' }, String(r.text || '').replace(/\[(?:Page|Slide|Chapter) \d+\]\n?/g, '')));
}
function checkRubric() {
  const text = bodyText(R.editor.getJSON());
  if (countWords(text) < 30) { toast('Write a little more first: Eden needs a paragraph or two to check'); return; }
  flush();
  const phone = isMobile();
  if (phone) closeArtifact(); else setWide(false);
  // Eden's own prompt: no auto-search on its wording ("score"); beside the chat the essay and rubric aren't sent twice (T20c)
  artifactSend(rubricRequest(R.essay, text, { inline: phone }), { origin: 'essay' });
  toast('Asked Eden to check it against the rubric: it answers in the chat');
}

/** A dropped rubric or assignment sheet: a new essay set up from it (style, word goal), the rubric beside it. */
export async function startFromRubric(r) {
  showPane();
  const e = newEssay(r.style || lastStyle());
  if (r.goal) e.goal = r.goal;
  e.rubric = { name: r.name, text: r.text, minWords: r.minWords, maxWords: r.maxWords };
  await saveOne(e);
  if (r.style) rememberStyle(r.style);
  R.panel = 'rubric';
  await openEssay(e);
  toast(`Opened the essay writer from ${r.name}: ${styleOf(e.style).label}${r.goal ? `, ${r.goal.toLocaleString()} words` : ''}`);
}

function detailsForm() {
  const e = R.essay, s = styleOf(e.style);
  const d = e.details;
  const field = (k) => {
    const isDate = k === 'date';
    const input = el('input', { name: k, type: isDate ? 'date' : 'text', value: d[k] || '', 'data-no-i18n': '', autocomplete: k === 'name' ? 'name' : 'off',
      oninput: () => { d[k] = input.value.trim() ? input.value : ''; touch(); front(); layoutSoon(); } });
    return el('label', 'es-f', el('span', null, FIELD_LABELS[k]), input,
      isDate ? el('span', 'es-f-n', d.date ? formatDate(d.date, s.id) : `Today: ${formatDate(today(), s.id)}`) : null);
  };
  const goal = el('input', { name: 'goal', type: 'number', min: '0', step: '50', value: e.goal ? String(e.goal) : '', placeholder: 'e.g. 1500',
    oninput: () => { e.goal = Math.max(0, Number(goal.value) || 0); touch(); footer(); } });
  return el('div', 'es-side-b es-details',
    el('p', 'es-f-n', `${s.long}. These fill the ${s.front === 'heading' ? 'heading on page 1' : 'title page'} and the running header.`),
    field('title'), ...s.fields.map(field),
    el('label', 'es-f', el('span', null, 'Word goal'), goal));
}

const SRC_FIELDS = {
  book: [['authors', 'Authors'], ['title', 'Title'], ['edition', 'Edition (e.g. 2nd)'], ['publisher', 'Publisher'], ['place', 'Place (Chicago, Harvard)'], ['year', 'Year']],
  article: [['authors', 'Authors'], ['title', 'Article title'], ['container', 'Journal'], ['volume', 'Volume'], ['issue', 'Issue'], ['pages', 'Pages (e.g. 45-67)'], ['year', 'Year'], ['doi', 'DOI'], ['url', 'Link (if no DOI)']],
  website: [['authors', 'Authors'], ['title', 'Page title'], ['container', 'Website'], ['year', 'Year'], ['month', 'Month (1-12)'], ['day', 'Day'], ['url', 'Link'], ['accessed', 'Accessed on']],
  other: [['text', 'The reference, as it should read']],
};
const SRC_TYPES = { book: 'Book', article: 'Journal article', website: 'Web page', other: 'Something else' };

function sourcesPanel() {
  const e = R.essay, s = styleOf(e.style);
  const list = sortReferences(s.id, e.sources || []);
  const row = (src) => {
    const page = el('input', { type: 'text', class: 'es-src-p', placeholder: 'p.', 'aria-label': 'Page for the citation', size: '4' });
    return el('div', 'es-src',
      el('div', { class: 'es-src-t', 'data-no-i18n': '' }, ...formatReference(s.id, src).map((g) => (g.i ? el('i', null, g.t) : g.t))),
      el('div', 'es-src-a',
        page,
        el('button', { type: 'button', class: 'cap primary', title: s.notes ? 'Add a footnote citing this at the cursor' : 'Add the in-text citation at the cursor', onclick: () => cite(src, page.value.trim()) }, s.notes ? 'Cite in a note' : 'Cite'),
        el('button', { type: 'button', class: 'cap', onclick: () => { R.srcEdit = { ...src }; renderPanel(); } }, 'Edit'),
        el('button', { type: 'button', class: 'iconbtn', title: 'Remove this source', 'aria-label': 'Remove this source', onclick: () => { e.sources = e.sources.filter((x) => x.id !== src.id); touch(); references(); redrawCites(); layoutSoon(); renderPanel(); } }, ico('trash', 13))));
  };
  return el('div', 'es-side-b',
    R.srcEdit ? sourceForm() : el('button', { type: 'button', class: 'cap primary es-add', onclick: () => { R.srcEdit = { type: 'book' }; renderPanel(); } }, ico('plus', 12), 'Add a source'),
    list.length ? el('p', 'es-f-n', `${s.refs.title}, in ${s.label}: re-formatted for you when you switch style. Put the cursor where the citation goes, then Cite.`) : el('p', 'es-f-n', `Your sources make the ${s.refs.title} page, in ${s.label}, sorted for you.`),
    ...list.map(row));
}

function sourceForm() {
  const src = R.srcEdit;
  const type = el('select', { 'aria-label': 'Kind of source', onchange: () => { src.type = type.value; renderPanel(); } }, ...Object.entries(SRC_TYPES).map(([k, v]) => opt(k, v, k === src.type)));
  const inputs = SRC_FIELDS[src.type].map(([k, label]) => {
    const multi = k === 'authors' || k === 'text';
    const i = el(multi ? 'textarea' : 'input', { name: k, rows: multi ? '3' : undefined, type: k === 'accessed' ? 'date' : undefined, value: multi ? undefined : (src[k] || ''), 'data-no-i18n': '',
      placeholder: k === 'authors' ? 'Last, First — one per line\nA group: its name as is' : undefined, oninput: () => { src[k] = i.value; } });
    if (multi) i.value = src[k] || '';
    return el('label', 'es-f', el('span', null, label), i);
  });
  const save = () => {
    const e = R.essay;
    const clean = Object.fromEntries(Object.entries(src).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
    if (!(clean.title || clean.text)) { toast('Add a title first'); return; }
    if (!clean.id) clean.id = `src_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    e.sources = [...(e.sources || []).filter((x) => x.id !== clean.id), clean];
    R.srcEdit = null;
    touch(); references(); redrawCites(); layoutSoon(); renderPanel();
  };
  return el('form', { class: 'es-srcform', onsubmit: (ev) => { ev.preventDefault(); save(); } },
    el('label', 'es-f', el('span', null, 'Kind'), type), ...inputs,
    el('div', 'es-src-a', el('button', { type: 'submit', class: 'cap primary' }, src.id ? 'Save' : 'Add'), el('button', { type: 'button', class: 'cap', onclick: () => { R.srcEdit = null; renderPanel(); } }, 'Cancel')));
}

/** The citation at the cursor: in the text (MLA, APA, Harvard) or as a footnote (Chicago). */
function cite(src, page) {
  const s = styleOf(R.essay.style), ed = R.editor;
  const node = { type: 'cite', attrs: { sid: src.id, page: page || '' } };
  const { from } = ed.state.selection;
  const before = from > 1 ? ed.state.doc.textBetween(from - 1, from, ' ', ' ') : ' ';
  ed.chain().focus().insertContent(!s.notes && before && !/\s|\(/.test(before) ? [{ type: 'text', text: ' ' }, node] : [node]).run();
  notes(true);
}

function outlinePanel() {
  const items = outlineOf(R.editor.getJSON());
  if (!items.length) return el('div', 'es-side-b', el('p', 'es-f-n', 'Headings you add (Heading 1–3 in the text style menu) show here.'));
  return el('div', 'es-side-b', el('ol', 'es-outline', ...items.map((h, k) => el('li', { class: `l${h.level}` },
    el('button', { type: 'button', 'data-no-i18n': '', onclick: () => { const n = R.bodyEl.querySelectorAll('h1, h2, h3')[k]; if (n) n.scrollIntoView({ block: 'center', behavior: 'smooth' }); } }, h.text || 'Untitled heading')))));
}

// ── export and Eden ──

async function exportDocx() {
  await flush();
  try {
    const { essayDocx } = await import('./essay-export.js');
    download(essayFileName(R.essay, 'docx'), await essayDocx(R.essay), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  } catch (err) { toast(`Couldn’t make the Word file: ${err.message}`); }
}
async function exportPdf() {
  await flush();
  const { printEssay } = await import('./essay-export.js');
  printEssay(R.essay);
}

function askFeedback() {
  const text = bodyText(R.editor.getJSON());
  if (countWords(text) < 30) { toast('Write a little more first: Eden needs a paragraph or two to comment on'); return; }
  flush();
  const phone = isMobile();
  if (phone) closeArtifact(); else setWide(false);
  // beside the chat, Eden already sees the essay (essayContext): the text isn't sent twice; on a phone the essay closes, so it goes in the message
  artifactSend(feedbackRequest(R.essay, text, { inline: phone }), { origin: 'essay' });
  toast('Asked Eden for feedback: it answers in the chat');
}

// ── Eden writing in the essay (eden-tools.js essay blocks; tools-ui.js calls these) ──

/**
 * Ranges followed through every change to the essay (ROADMAP T19c, T20f): the selection and blocks when a message was
 * sent (Eden's "selection", "after 3" mean the essay as it saw it, even if the person clicks or types while it writes),
 * and each of Eden's changes (so Undo still works after the person types elsewhere). `touched`: the person edited inside.
 */
const TRACKED = new Set();
function track(from, to, extra = {}) { const t = { from, to, touched: false, ...extra }; TRACKED.add(t); return t; }
function untrack(...ts) { for (const t of ts.flat()) if (t) TRACKED.delete(t); }
function mapTracked(tr) {
  if (!tr.docChanged || !TRACKED.size) return;
  for (const t of TRACKED) {
    let { from, to } = t;
    for (const map of tr.mapping.maps) {
      if (!R.applying && !t.touched) map.forEach((os, oe) => { if (os < to && oe > from) t.touched = true; });
      from = map.map(from, 1);
      to = Math.max(from, map.map(to, -1));
    }
    t.from = from; t.to = to;
  }
}

const TURNS = new Map(); // a sent message's key → { essayId, sel, blocks } (tracked), the last few
/**
 * The open essay for Eden's system text, or null when none is on screen. With `turn` (the message's key), the
 * selection and blocks are kept as they are now, for applyEssayCall to use when the reply comes.
 */
export function essayContext({ turn = null } = {}) {
  if (!R.essay || !R.editor || R.view !== 'essay' || !$('artifact').classList.contains('essay-on') || !$('split').classList.contains('art-open')) return null;
  const e = R.essay, s = styleOf(e.style);
  const doc = R.editor.getJSON();
  const { from, to } = R.editor.state.selection;
  const label = (a) => { const src = sourceOf(a.sid); return src ? `citation [@${keyOf(src)}]: ${plainText(inText(s.id, src, a.page ? { page: a.page } : {}))}` : 'citation of a removed source'; };
  let blocks = blocksOf(doc, label);
  // a long essay: the start and the end, and whatever the selection is in
  if (blocks.map((b) => b.text).join('\n').length > 40_000) blocks = [...blocks.slice(0, 40), { n: '…', kind: 'p', text: '(middle left out)' }, ...blocks.slice(-40)];
  const selection = to > from ? R.editor.state.doc.textBetween(from, to, '\n', ' ').slice(0, 4000) : '';
  if (turn) {
    const old = TURNS.get(turn);
    if (old) untrack(old.sel, old.blocks);
    TURNS.set(turn, { essayId: e.id, sel: track(from, to, { text: R.editor.state.doc.textBetween(from, to, '\n', ' ') }), blocks: blockSpans().map((b) => track(b.from, b.to)) });
    for (const k of [...TURNS.keys()].slice(0, -6)) { untrack(TURNS.get(k).sel, TURNS.get(k).blocks); TURNS.delete(k); }
  }
  const sources = sortReferences(s.id, e.sources || []).map((src) => ({ key: keyOf(src), text: plainText(formatReference(s.id, src)).slice(0, 300) }));
  return {
    id: e.id, title: (e.details && e.details.title) || '', style: s.long, rubric: e.rubric ? { name: e.rubric.name, text: String(e.rubric.text || '').slice(0, 8000), minWords: e.rubric.minWords || 0, maxWords: e.rubric.maxWords || 0 } : null, words: countWords(bodyText(doc)), goal: Number(e.goal) || 0,
    selection, blocks, sources,
  };
}

/** A source's key for Eden to cite it by: the one Eden gave it, else its id. */
const keyOf = (src) => src.key || src.id;
/** [@key] → the source's id: its key, its id, or a source added with that key (case aside). */
function sourceIdFor(key) {
  const k = String(key || '').toLowerCase();
  const src = (R.essay.sources || []).find((x) => String(x.key || '').toLowerCase() === k || String(x.id).toLowerCase() === k);
  return src ? src.id : null;
}

/** The positions of the body's top-level blocks: [{ from, to }] in document order. */
function blockSpans() {
  const out = [];
  R.editor.state.doc.forEach((node, offset) => out.push({ from: offset, to: offset + node.nodeSize }));
  return out;
}

/** Where `find` sits in the body (one textblock, atoms skipped): { from, to } or null; `count` how many matches. */
function locate(find) {
  const hits = [];
  const norm = (x) => x.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ');
  const want = norm(find).trim();
  if (!want) return { at: null, count: 0 };
  R.editor.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = '';
    const map = []; // text index → doc position
    node.descendants((child, p) => {
      if (child.isText) for (let k = 0; k < child.text.length; k++) { text += child.text[k]; map.push(pos + 1 + p + k); }
      return true;
    });
    const t = norm(text);
    let i = t.indexOf(want);
    while (i >= 0) { hits.push({ from: map[i], to: map[i + want.length - 1] + 1 }); i = t.indexOf(want, i + 1); }
    return false;
  });
  return { at: hits[0] || null, count: hits.length };
}

/** The open essay as it is now (its id, body and title), to put back with essayRestore; null when none is open. */
export function essaySnapshot() {
  if (!essayContext()) return null;
  return { id: R.essay.id, doc: JSON.stringify(R.editor.getJSON()), title: (R.essay.details && R.essay.details.title) || '', sources: JSON.stringify(R.essay.sources || []) };
}
/** Puts the open essay back as a snapshot had it; '' when done, else why not. */
export function essayRestore(snap) {
  if (!snap || !R.editor || !R.essay || R.essay.id !== snap.id || !essayContext()) return 'The essay isn’t open.';
  R.editor.commands.setContent(JSON.parse(snap.doc), true);
  R.essay.details.title = snap.title;
  if (snap.sources) { R.essay.sources = JSON.parse(snap.sources); references(); redrawCites(); }
  front(); if (R.panel) renderPanel();
  touch(); layoutSoon();
  return '';
}

const CHANGES = new Map(); // Eden's change id → { essayId, range (tracked), slice (what it replaced), source? }
let changeN = 0;
/**
 * Undoes Eden's changes (ids from applyEssayCall), newest first, even after the person has typed elsewhere: each
 * change's text goes back to what it replaced. Where the person edited inside Eden's text, it asks first.
 * '' when done, else why not.
 */
export function essayUndoChanges(ids) {
  const list = ids.map((id) => CHANGES.get(id)).filter(Boolean);
  if (!list.length) return 'This change can’t be undone here any more: use ⌘Z in the essay.';
  if (!R.editor || !R.essay || list.some((c) => c.essayId !== R.essay.id) || !essayContext()) return 'Open that essay to undo this.';
  if (list.some((c) => c.range && c.range.touched) && !confirm('You’ve edited Eden’s text since. Undo Eden’s change anyway? Your edits inside that text go too.')) return 'Kept as it is.';
  R.applying = true;
  try {
    for (const c of list.slice().reverse()) {
      if (c.source) { R.essay.sources = (R.essay.sources || []).filter((x) => x.id !== c.source); continue; }
      const { from, to } = c.range;
      R.editor.view.dispatch(R.editor.state.tr.replace(from, Math.min(to, R.editor.state.doc.content.size), c.slice));
    }
  } finally { R.applying = false; }
  for (const id of ids) { const c = CHANGES.get(id); if (c) untrack(c.range); CHANGES.delete(id); }
  references(); redrawCites(); if (R.panel) renderPanel();
  changed(); layoutSoon();
  return '';
}

/** Runs one change to the body as Eden's: its range is followed, and what it replaced kept for Undo. */
function edenChange(range, apply) {
  const ed = R.editor;
  const size = ed.state.doc.content.size;
  const slice = ed.state.doc.slice(range.from, range.to);
  R.applying = true;
  try { apply(); } finally { R.applying = false; }
  const end = range.to + (ed.state.doc.content.size - size);
  const id = `ch${++changeN}`;
  CHANGES.set(id, { essayId: R.essay.id, range: track(range.from, Math.max(range.from, end)), slice });
  return id;
}

/**
 * Applies one of Eden's essay calls to the open essay: { ok, result, change, added, total } or { ok: false, error }.
 * `turn`: the message's key (essayContext), so "selection", "cursor" and block numbers mean what Eden saw.
 */
export async function applyEssayCall(call, { turn = null } = {}) {
  if (!essayContext()) return { ok: false, error: 'The essay isn’t open. Open it, then press Try again.' };
  const ed = R.editor, e = R.essay;
  const sent = turn && TURNS.get(turn);
  const then = sent && sent.essayId === e.id ? sent : null; // the essay as it was when the message was sent
  let result = '', at = null, change = null, added = 0;
  const notes = []; // said under the result, each on its own line
  const cite = { cite: sourceIdFor };
  if (call.name === 'essay_title') {
    e.details.title = call.args.title;
    touch(); front(); layoutSoon();
    if (R.panel === 'details') renderPanel();
    result = `Titled it “${call.args.title}”.`;
  } else if (call.name === 'essay_source') {
    const { key, ...src } = call.args;
    const same = (e.sources || []).find((x) => (src.url && x.url === src.url) || (String(x.title || '').toLowerCase() === src.title.toLowerCase() && String(x.year || '') === String(src.year || '')));
    if (same) {
      if (key && !same.key) same.key = key;
      result = `“${clip(src.title)}” is already in your sources.`;
    } else {
      const id = `src_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      e.sources = [...(e.sources || []), { ...src, id, ...(key ? { key } : {}), by: 'eden' }];
      change = `ch${++changeN}`;
      CHANGES.set(change, { essayId: e.id, source: id });
      result = `Added “${clip(src.title)}” to your sources${src.url ? '' : ' (no link: check it)'}.`;
    }
    references(); redrawCites(); layoutSoon();
    if (R.panel === 'sources') renderPanel();
    touch();
  } else if (call.name === 'essay_edit') {
    const { at: hit, count } = locate(call.args.find);
    if (!hit) return { ok: false, error: 'Eden’s edit didn’t match the essay’s words (it may have changed). Ask again.' };
    const content = call.args.replace ? inlineNodes(call.args.replace, cite) : [];
    change = edenChange(hit, () => {
      if (content.length) ed.chain().insertContentAt({ from: hit.from, to: hit.to }, content).run();
      else ed.chain().deleteRange({ from: hit.from, to: hit.to }).run();
    });
    at = hit.from;
    result = call.args.replace ? `Edited “${clip(call.args.find)}”${count > 1 ? ' (the first of several)' : ''}.` : `Deleted “${clip(call.args.find)}”.`;
  } else if (call.name === 'essay_write') {
    const blocks = textToBlocks(call.args.text, cite);
    if (!blocks.length) return { ok: false, error: 'Eden’s text was empty.' };
    const spans = then ? then.blocks.map((t) => ({ from: t.from, to: t.to })) : blockSpans();
    const where = call.args.where;
    const m = /^(after|before|replace) (\d+)$/.exec(where);
    const docEnd = ed.state.doc.content.size;
    const onlyEmpty = ed.state.doc.childCount === 1 && !ed.state.doc.firstChild.textContent && ed.state.doc.firstChild.type.name === 'paragraph';
    let range, content = blocks;
    if (where === 'selection' || where === 'cursor') {
      let { from, to } = then ? then.sel : ed.state.selection;
      if (where === 'selection') {
        // the text selected when the message was sent, where it is now (or found again if it moved or was retyped)
        const was = then ? then.sel.text : '';
        if (then && (to <= from || ed.state.doc.textBetween(from, to, '\n', ' ') !== was)) { const f = was ? locate(was).at : null; if (f) ({ from, to } = f); else { from = to = 0; } }
        if (to <= from) return { ok: false, error: then && then.sel.text ? 'The text you selected has changed since you asked. Select it again, then press Try again.' : 'Nothing was selected in the essay. Select the part to change, then ask again.' };
      } else to = from;
      // one paragraph's worth goes in as words; more becomes its own blocks
      if (blocks.length === 1 && blocks[0].type === 'paragraph') content = blocks[0].content || [];
      range = { from, to };
    } else if (m) {
      const span = spans[Number(m[2]) - 1];
      if (!span) return { ok: false, error: `The essay has no block ${m[2]}.` };
      range = m[1] === 'after' ? { from: span.to, to: span.to } : m[1] === 'before' ? { from: span.from, to: span.from } : { from: span.from, to: span.to };
    } else range = onlyEmpty ? { from: 0, to: docEnd } : { from: docEnd, to: docEnd };
    change = edenChange(range, () => ed.chain().insertContentAt(range, content).run());
    at = range.from;
    added = countWords(blocks.map((b) => bodyText(b)).join(' '));
    result = { end: `Added ${added} words at the end.`, cursor: `Added ${added} words at the cursor.`, selection: `Rewrote the selection (${added} words).` }[where]
      || (m ? `${m[1] === 'replace' ? 'Rewrote' : 'Added'} ${m[1] === 'replace' ? `block ${m[2]} (${added} words)` : `${added} words ${m[1]} block ${m[2]}`}.` : `Added ${added} words.`);
    if (call.partial) notes.push('Eden was cut off: this is what it wrote before stopping.');
    const missing = (call.args.text.match(/\[@[\w.-]+[^\]]*\]/g) || []).filter((x) => !sourceIdFor(/\[@([\w.-]+)/.exec(x)[1]));
    if (missing.length) notes.push(`${missing.length} citation${missing.length === 1 ? ' points' : 's point'} to a source that isn’t in your sources: ${clip(missing.join(' '))}`);
  } else return { ok: false, error: 'Unknown essay change.' };
  if (at !== null) { try { ed.commands.setTextSelection(Math.min(at + 1, ed.state.doc.content.size)); ed.commands.scrollIntoView(); } catch { /* the selection can't go there */ } }
  changed(); layoutSoon();
  return { ok: true, result, notes, change, added, total: countWords(bodyText(ed.getJSON())) };
}
const clip = (t) => { const s = String(t).replace(/\s+/g, ' ').trim(); return s.length > 48 ? `${s.slice(0, 46)}…` : s; };

/**
 * Eden's text as it streams in (T19d): at the end of the essay, the words appear on the page as they come (a preview:
 * the real change lands when the reply ends); elsewhere, the place it goes is marked. null clears it.
 */
export function essayPreview(p) {
  if (!R.sheet || !R.editor || !essayContext()) return;
  if (!p || !p.text) { if (R.ghost) R.ghost.remove(); if (R.ghostMark) R.ghostMark.remove(); R.ghostKey = ''; return; }
  const key = `${p.where}|${p.text.length}`;
  if (R.ghostKey === key) return;
  R.ghostKey = key;
  const doc = R.editor.state.doc;
  const empty = doc.childCount === 1 && !doc.firstChild.textContent;
  if (p.where === 'end' || empty) {
    if (R.ghostMark) R.ghostMark.remove();
    if (!R.ghost) R.ghost = el('div', { class: 'es-ghost', 'aria-live': 'off', 'aria-label': 'Eden is writing' });
    if (!R.sheet.contains(R.ghost)) R.bodyEl.after(R.ghost);
    R.ghost.classList.toggle('alone', empty);
    const paras = p.text.split(/\n\s*\n/).filter((x) => x.trim()).map((x) => {
      const h = /^(#{1,3})\s+(.+)$/s.exec(x.trim());
      return h ? el(`h${h[1].length}`, null, h[2].replace(/[*_]/g, '')) : el('p', null, x.replace(/\*\*|\*|_/g, '').replace(/\[@[^\]]+\]/g, '').replace(/\s*\n\s*/g, ' '));
    });
    R.ghost.replaceChildren(...paras);
    if (p.open) R.ghost.lastChild && R.ghost.lastChild.append(el('span', 'es-caret'));
    const box = R.scroll.getBoundingClientRect(), g = R.ghost.getBoundingClientRect();
    if (g.bottom > box.bottom - 40) R.scroll.scrollTop += g.bottom - box.bottom + 80;
    return;
  }
  // elsewhere: a mark over the place it goes
  if (R.ghost) R.ghost.remove();
  const sent = [...TURNS.values()].at(-1);
  const m = /^(after|before|replace) (\d+)$/.exec(p.where);
  let pos = null;
  if (m) { const spans = sent && sent.essayId === R.essay.id ? sent.blocks : blockSpans(); const s = spans[Number(m[2]) - 1]; if (s) pos = { from: s.from, to: m[1] === 'replace' ? s.to : s.from + 1 }; }
  else if (sent && sent.essayId === R.essay.id) pos = { from: sent.sel.from, to: Math.max(sent.sel.to, sent.sel.from + 1) };
  if (!pos) return;
  try {
    const a = R.editor.view.coordsAtPos(Math.min(pos.from + 1, doc.content.size)), b = R.editor.view.coordsAtPos(Math.min(pos.to, doc.content.size));
    const sheet = R.sheet.getBoundingClientRect(), zoom = parseFloat(R.zoom.style.zoom) || 1;
    if (!R.ghostMark) R.ghostMark = el('div', { class: 'es-ghost-mark', 'aria-hidden': 'true' }, el('span', null, 'Eden is writing here…'));
    if (!R.sheet.contains(R.ghostMark)) R.sheet.append(R.ghostMark);
    Object.assign(R.ghostMark.style, { top: `${(Math.min(a.top, b.top) - sheet.top) / zoom - 4}px`, height: `${Math.max(24, (Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top)) / zoom + 8)}px` });
  } catch { /* not on screen */ }
}

// ── titles, and "Paste into essay" ──

const STYLE_KEY = 'eden:essay:style';
function lastStyle() { try { const s = localStorage.getItem(STYLE_KEY); return STYLES[s] ? s : 'mla'; } catch { return 'mla'; } }
function rememberStyle(s) { try { localStorage.setItem(STYLE_KEY, s); } catch { /* private mode */ } }

function setTitle(title, note) {
  R.essay.details.title = title;
  touch(); front(); layoutSoon();
  if (R.panel === 'details') renderPanel();
  if (note) toast(note);
}

/**
 * An essay with no title gets one: a title line at the top of the text (a short all-bold line, as a
 * pasted title comes) moves up into the title, else, once there are 120 words, Eden writes one (once per essay).
 */
let titling = false;
async function maybeTitle() {
  const e = R.essay, ed = R.editor;
  if (!e || !ed || (e.details && e.details.title) || titling) return;
  const doc = ed.state.doc, first = doc.firstChild;
  if (first && doc.childCount > 1) {
    const text = first.textContent.trim();
    const bold = first.type.name === 'paragraph' && first.childCount > 0 && first.content.content.every((n) => n.isText && n.marks.some((m) => m.type.name === 'bold'));
    // a short all-bold line (a pasted title), never a section heading the person made ("Introduction")
    if (bold && text && countWords(text) >= 2 && countWords(text) <= 25 && !/[.!?]$/.test(text) && !/^(introduction|conclusion|background|abstract|summary|works cited|references|bibliography)\b/i.test(text)) {
      ed.chain().deleteRange({ from: 0, to: first.nodeSize }).run();
      setTitle(text.replace(/:\s*$/, ''), `Made “${text}” the title`);
      return;
    }
  }
  const words = countWords(bodyText(ed.getJSON()));
  if (words < 120 || e.titleTried) return;
  e.titleTried = true;
  titling = true;
  try {
    const [{ api }, { routeSettings }] = await Promise.all([import('./api.js'), import('./router.js')]);
    let out = '';
    await api.send({ messages: [{ role: 'user', content: bodyText(ed.getJSON()).slice(0, 12_000) }], system: TITLE_SYSTEM, settings: routeSettings(), mode: 'chat', temporary: true },
      { onEvent: (type, d) => { if (type === 'text') out += d.text || ''; } });
    const t = cleanTitle(out);
    if (t && R.essay === e && !(e.details && e.details.title)) setTitle(t, `Eden titled it “${t}”: change it in Details`);
  } catch { /* no title this time: the placeholder stays, and the person can add one */ } finally { titling = false; touch(); }
}

/** A reply's essay (essayFromReply) into the open essay: its title if there's none, its text at the cursor or the end, its references as sources. */
function putReply(r, where = 'end') {
  const e = R.essay, ed = R.editor;
  const blocks = textToBlocks(r.body);
  if (r.title && !(e.details && e.details.title)) setTitle(r.title);
  if (blocks.length) {
    const doc = ed.state.doc;
    const empty = doc.childCount === 1 && !doc.firstChild.textContent && doc.firstChild.type.name === 'paragraph';
    if (empty) ed.chain().focus().insertContentAt({ from: 0, to: doc.content.size }, blocks).run();
    else if (where === 'cursor') ed.chain().focus().insertContent(blocks).run();
    else ed.chain().focus().insertContentAt(doc.content.size, blocks).run();
  }
  const have = new Set((e.sources || []).map((s) => (s.text || s.title || '').trim()));
  const added = r.references.filter((t) => !have.has(t)).map((text, i) => ({ id: `src_${Date.now().toString(36)}${i}${Math.random().toString(36).slice(2, 5)}`, type: 'other', text }));
  if (added.length) { e.sources = [...(e.sources || []), ...added]; references(); redrawCites(); if (R.panel === 'sources') renderPanel(); }
  changed(); layoutSoon();
  return { words: countWords(r.body), sources: added.length };
}

/** "Paste into essay" on a reply: into the open essay, else a new one in the last style used. */
export async function pasteIntoEssay(md) {
  const r = essayFromReply(md);
  if (!r.body.trim() && !r.references.length) { toast('There’s no essay text in this reply to paste'); return; }
  if (!essayContext()) {
    showPane();
    const e = newEssay(lastStyle());
    await saveOne(e);
    await openEssay(e);
  }
  if (!essayContext()) return;
  const n = putReply(r, 'end');
  const s = styleOf(R.essay.style);
  toast(`Pasted into your ${s.label} essay: ${n.words.toLocaleString()} words${n.sources ? `, ${n.sources} source${n.sources === 1 ? '' : 's'}` : ''}`);
  await flush();
}
