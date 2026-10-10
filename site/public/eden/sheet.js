// The spreadsheet canvas (ROADMAP Q15): a grid editor in the canvas pane, over sheet-model.mjs.
//
// - Open: an .xlsx/.xls/.csv from this computer, a file on the Mac (through Eden's server), a Google
//   Sheet the person picks (Google Picker, drive.file), or a new blank one.
// - Edit directly: cells, formulas (formula bar), sheets (tabs), bold/italic, number formats, a
//   frozen header, sort, filter, column widths, copy/paste; every change is a version (Undo/Redo,
//   History).
// - Charts from a range (bar, line, pie), drawn as inline SVG (sheet-chart.mjs).
// - Ask Eden (the panel at the bottom): a routed turn like any other (POST /api/chat/send), with the
//   sheet's schema and only the relevant cells as an untrusted context block, and a cost estimate
//   before sending. When Eden proposes a change set, it's previewed as a diff and applied only on
//   Apply; nothing the model writes runs.
// - Save: Export .xlsx/.csv; back to the Mac's file or to Google Sheets after a review of what
//   changes (the server needs confirm: true; the Mac's Activity timeline keeps an Undo); "Save as
//   a new Google Sheet" uploads the .xlsx with conversion.
// It lays itself over the canvas (#artifact) while open; artifact.js's own views come back when a
// code block or page is opened there.

import { $, el, ico, toast, isMobile, debounce, fmtCost, shortModel } from './util.js';
import { api, apiUrl } from './api.js';
import { routeSettings } from './router.js';
import { renderMarkdown } from './markdown.js';
import { closeArtifact } from './artifact.js';
import { t as tx, locale } from './i18n.js';
import * as M from './sheet-model.mjs';
import { chartData, chartSvg } from './sheet-chart.mjs';
import { sheetsCall, macFile, sheetsStatus, connectSheets, takeSheetReturn, pickGoogleFile, sheetIdFrom, bytesToBase64, base64ToBytes, driveUpload } from './sheet-google.js';

const ROW_H = 24, COL_W = 96, HEAD_W = 46, MAX_COLS_SHOWN = 200, VERSIONS_KEPT = 100;
const STASH_KEY = 'eden:sheet-stash';

let fnsP = null, excelP = null, xlsP = null;
const formulaFns = () => (fnsP ??= import('./sheet-formulajs.mjs'));
const excelLib = () => (excelP ??= import('./sheet-exceljs.mjs').then((m) => m.default));
const xlsLib = () => (xlsP ??= import('./sheet-xls.mjs'));
const ioLib = () => import('./sheet-io.mjs');

// ── state ──

const S = {
  versions: [], // [{ wb, label, by: 'you'|'eden'|'file', at, calc }]
  i: -1,
  active: 0,
  sel: { r1: 1, c1: 1, r2: 1, c2: 1, ar: 1, ac: 1 },
  source: { kind: 'new' }, // new | upload | mac { path, mtime, name, from? } | google { id, url, title }
  base: null, // the original .xlsx bytes (writes keep what Eden doesn't model)
  saved: -1, // the version the source holds
  filter: null, // { col, text }
  editing: null,
  ask: { history: [], busy: false, preview: null },
  lastSave: null, // Google: { id, before } for "Undo save"
};
let R = null; // the pane's elements
let fns = null;

const cur = () => S.versions[S.i];
const wb = () => cur().wb;
const sheet = () => wb().sheets[Math.min(S.active, wb().sheets.length - 1)];
function calcOf(v = cur()) {
  if (!v.calc) v.calc = M.recalc(v.wb, fns, {});
  return v.calc;
}

function setWorkbook(next, label, by = 'you') {
  S.versions = S.versions.slice(0, S.i + 1);
  S.versions.push({ wb: next, label, by, at: Date.now() });
  if (S.versions.length > VERSIONS_KEPT) { const drop = S.versions.length - VERSIONS_KEPT; S.versions.splice(0, drop); S.saved -= drop; }
  S.i = S.versions.length - 1;
  if (S.active >= next.sheets.length) S.active = next.sheets.length - 1;
  render();
}

// ── opening ──

async function ready() {
  if (!fns) fns = await formulaFns();
  if (!R) build();
  show();
}

function start(book, source, { base = null, label = 'Opened' } = {}) {
  S.versions = [{ wb: book, label, by: 'file', at: Date.now() }];
  S.i = 0;
  S.saved = source.kind === 'new' || source.kind === 'upload' ? -1 : 0;
  S.source = source;
  S.base = base;
  S.active = 0;
  S.sel = { r1: 1, c1: 1, r2: 1, c2: 1, ar: 1, ac: 1 };
  S.filter = null;
  S.ask = { history: [], busy: false, preview: null };
  S.lastSave = null;
  R.askOut.replaceChildren();
  R.filter.value = '';
  render();
  R.grid.focus({ preventScroll: true });
}

export async function newSheetCanvas() {
  await ready();
  start(M.newWorkbook('Untitled spreadsheet'), { kind: 'new' }, { label: 'New spreadsheet' });
}

/** Bytes of a file → the canvas. */
async function openBytes(bytes, name, source) {
  await ready();
  const io = await ioLib();
  const kind = io.kindOf(name);
  if (!kind) { toast('Eden opens .xlsx, .xls and .csv spreadsheets'); return; }
  setStatus(`Opening ${name}…`);
  try {
    const libs = kind === 'xlsx' ? { ExcelJS: await excelLib() } : kind === 'xls' ? { XLSX: await xlsLib() } : {};
    const book = await io.readWorkbook(bytes, name, libs);
    start(book, source, { base: kind === 'xlsx' ? bytes : null, label: `Opened ${name}` });
    toast(`${name}: ${io.describeWorkbook(book)}`);
  } catch (e) { setStatus(''); toast(e.message); }
}

/** A File (a drop, the composer's attachment, a test) → the canvas. */
export async function openSheetFile(file) {
  await openBytes(new Uint8Array(await file.arrayBuffer()), file.name, { kind: 'upload', name: file.name });
}

export async function openUpload() {
  const input = el('input', { type: 'file', accept: '.xlsx,.xls,.csv,.tsv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv', style: { display: 'none' } });
  input.addEventListener('change', async () => {
    const f = input.files && input.files[0];
    input.remove();
    if (f) await openBytes(new Uint8Array(await f.arrayBuffer()), f.name, { kind: 'upload', name: f.name });
  });
  document.body.append(input);
  input.click();
}

/** A spreadsheet on the Mac (from Files' "Open in the canvas" or the search below). */
export async function openMacSheet(path) {
  await ready();
  setStatus('Reading it on your Mac…');
  try {
    const f = await macFile({ action: 'read', path });
    await openBytes(base64ToBytes(f.data), f.name, { kind: 'mac', path: f.path, name: f.name, mtime: f.mtime });
  } catch (e) { setStatus(''); toast(e.message); }
}

export async function openMacSearch() {
  await ready();
  dialog('Open a spreadsheet from your Mac', (box, close) => {
    const q = el('input', { class: 'sh-in', type: 'search', placeholder: 'Search your Mac: a name or a word inside…', 'aria-label': 'Search your Mac for spreadsheets' });
    const list = el('div', { class: 'sh-list', 'aria-live': 'polite' });
    const run = debounce(async () => {
      const v = q.value.trim();
      if (!v) { list.replaceChildren(el('div', 'muted', 'Type to search .xlsx, .xls and .csv files on your Mac.')); return; }
      list.replaceChildren(el('div', 'muted', 'Asking your Mac…'));
      try {
        const r = await api.jarvis('files_search', { query: v, kind: 'spreadsheet', limit: 20 });
        if (r.is_error) throw new Error(r.text || 'Jarvis said no.');
        const files = (JSON.parse(r.text).files || []).filter((f) => /\.(xlsx|xls|csv|tsv)$/i.test(f.path || f.name || ''));
        list.replaceChildren(...(files.length ? files.map((f) => el('button', { type: 'button', class: 'sh-file', onclick: () => { close(); openMacSheet(f.path); } }, ico('chart', 14), el('span', { 'data-no-i18n': '' }, f.name || f.path), el('small', { 'data-no-i18n': '' }, f.display || f.path))) : [el('div', 'muted', 'No spreadsheets matched.')]));
      } catch (e) { list.replaceChildren(el('div', 'sh-err', e.message)); }
    }, 400);
    q.addEventListener('input', run);
    box.append(q, list);
    setTimeout(() => q.focus(), 30);
    run();
  });
}

/** Google Sheets: drive.file first (one consent), then the Picker. */
export async function openGoogle() {
  await ready();
  const st = await sheetsStatus();
  if (!st.sheets) { askConnect(); return; }
  try {
    const picked = await pickGoogleFile('sheets');
    if (picked) await openGoogleId(picked.id);
  } catch (e) {
    if (e.code === 'not_configured') linkFallback(e.message);
    else if (e.code === 'scope' || e.code === 'not_connected') askConnect();
    else toast(e.message);
  }
}

function askConnect() {
  dialog('Connect Google Sheets', (box, close) => {
    box.append(
      el('p', '', 'Eden asks Google for access to the files you pick or that Eden creates, and nothing else (Google’s “drive.file” permission). Your other Drive files stay out of reach.'),
      el('p', 'muted', S.versions.length ? 'You come back here after Google; this spreadsheet is kept in this tab meanwhile.' : 'You come back here after Google.'),
      el('div', 'sh-acts', el('button', { type: 'button', class: 'btn', onclick: close }, 'Not now'),
        el('button', { type: 'button', class: 'btn primary', onclick: async () => { stash(); try { await connectSheets({ open: 'picker' }); } catch (e) { toast(e.message); } } }, 'Connect Google Sheets')));
  });
}

/** When the Picker isn't set up (no API key yet), a Sheets link still opens a file Eden made. */
function linkFallback(why) {
  dialog('Open a Google Sheet', (box, close) => {
    const inp = el('input', { class: 'sh-in', placeholder: 'Paste the Google Sheets link', 'aria-label': 'Google Sheets link' });
    box.append(el('p', 'muted', why), el('p', '', 'A link works for sheets Eden created. Other sheets need the Google Picker (it’s how you give Eden access to one file).'), inp,
      el('div', 'sh-acts', el('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'),
        el('button', { type: 'button', class: 'btn primary', onclick: () => { const id = sheetIdFrom(inp.value); if (!id) { toast('That isn’t a Google Sheets link'); return; } close(); openGoogleId(id); } }, 'Open')));
  });
}

async function openGoogleId(id) {
  setStatus('Opening it from Google Sheets…');
  try {
    const g = await sheetsCall('open', { id });
    const book = { title: g.title, sheets: g.sheets.map((s) => ({ ...M.newSheet(s.name), orig: s.name, cells: Object.fromEntries(Object.entries(s.cells).map(([k, c]) => [k, Object.freeze({ v: c.v ?? null, ...(c.f ? { f: c.f } : {}), ...(c.z ? { z: c.z } : {}), ...(c.s ? { s: c.s } : {}) })])) })) };
    start(book, { kind: 'google', id: g.id, url: g.url, title: g.title }, { label: `Opened “${g.title}” from Google Sheets` });
    if (g.truncated) toast('A big sheet: Eden opened the first rows and columns only (5,000 rows × 200 columns at most)');
  } catch (e) { setStatus(''); if (e.status === 403 || e.status === 409) askConnect(); else toast(e.message); }
}

/** Back from Google's consent (app.js): bring the stashed sheet back, then the Picker. */
export async function resumeAfterConnect(ok) {
  const ret = takeSheetReturn();
  if (ret && ret.open === 'none') { toast(ok ? 'Google Drive connected' : 'Google sign-in didn’t finish. Try again.'); return; } // another feature asked (driveUpload)
  await ready();
  const st = unstash();
  if (!st) await newSheetCanvas();
  toast(ok ? 'Google Sheets connected' : 'Google sign-in didn’t finish. Try again.');
  if (ok && ret && ret.open === 'picker' && !st) setTimeout(() => openGoogle(), 400);
  else if (ok && st) setStatus('Connected: Save to Google Sheets, or Open › From Google Sheets.');
}

function stash() {
  if (!S.versions.length) return;
  try { sessionStorage.setItem(STASH_KEY, JSON.stringify({ wb: wb(), source: S.source, active: S.active })); } catch { /* too big for this tab's storage: it reopens empty */ }
}
function unstash() {
  try {
    const raw = sessionStorage.getItem(STASH_KEY);
    sessionStorage.removeItem(STASH_KEY);
    if (!raw) return false;
    const j = JSON.parse(raw);
    start(j.wb, j.source || { kind: 'upload' }, { label: 'Kept while you connected Google' });
    S.saved = -1;
    S.active = j.active || 0;
    render();
    return true;
  } catch { return false; }
}

// ── the pane ──

function cssOnce() {
  if (document.querySelector('link[data-sheet-css]')) return;
  document.head.append(el('link', { rel: 'stylesheet', href: apiUrl('/sheet.css'), 'data-sheet-css': '' }));
}

function show() {
  $('split').classList.add('art-open');
  $('split').classList.remove('chat-view');
  document.body.classList.remove('canvas-hidden');
  $('artifact').classList.add('sheet-on');
  R.pane.hidden = false;
}
function hide() {
  $('artifact').classList.remove('sheet-on');
  if (R) R.pane.hidden = true;
}
export const sheetOpen = () => !!R && !R.pane.hidden && $('split').classList.contains('art-open');

function build() {
  cssOnce();
  const tb = (label, icon, onclick, { text, ...extra } = {}) => el('button', { type: 'button', class: 'sh-tb', title: label, 'aria-label': label, onclick, ...extra }, icon ? ico(icon, 15) : null, text ? el('span', '', text) : null);
  const R0 = {};
  R0.title = el('span', { class: 'sh-title', 'data-no-i18n': '' });
  R0.badge = el('span', 'sh-badge');
  R0.ver = el('button', { type: 'button', class: 'sh-ver', title: 'History', onclick: historyMenu });
  R0.undo = el('button', { type: 'button', class: 'sh-tb', title: 'Undo · ⌘Z', 'aria-label': 'Undo', onclick: undo }, '↶');
  R0.redo = el('button', { type: 'button', class: 'sh-tb', title: 'Redo · ⇧⌘Z', 'aria-label': 'Redo', onclick: redo }, '↷');
  R0.save = el('button', { type: 'button', class: 'sh-save', onclick: saveToSource });
  const head = el('div', 'sh-head',
    ico('chart', 16), R0.title, R0.badge, el('span', 'sh-sp'), R0.ver, R0.undo, R0.redo,
    tb('Open', 'folder', (e) => openMenu(e.currentTarget)), tb('Export', 'down', (e) => exportMenu(e.currentTarget)), R0.save,
    el('button', { type: 'button', class: 'iconbtn', title: 'Close · esc', 'aria-label': 'Close the spreadsheet', onclick: closeSheet }, ico('x')));
  R0.fmt = el('select', { class: 'sh-sel', 'aria-label': 'Number format', title: 'Number format', onchange: () => styleSel({ numFmt: R.fmt.value }) },
    ...M.FORMATS.map(([z, label]) => el('option', { value: z }, label)));
  R0.bold = tb('Bold · ⌘B', null, () => styleSel({ bold: !selStyle().b }), { text: 'B', class: 'sh-tb sh-b' });
  R0.italic = tb('Italic · ⌘I', null, () => styleSel({ italic: !selStyle().i }), { text: 'I', class: 'sh-tb sh-i' });
  R0.freeze = tb('Freeze the header row', null, toggleFreeze, { text: 'Freeze', class: 'sh-tb sh-txt' });
  R0.filter = el('input', { class: 'sh-filter', type: 'search', placeholder: 'Filter this column…', 'aria-label': 'Show only rows whose selected column contains', oninput: debounce(() => { const t = R.filter.value.trim(); S.filter = t ? { col: S.sel.ac, text: t.toLowerCase() } : null; renderGrid(); }, 200) });
  const tools = el('div', { class: 'sh-tools', role: 'toolbar', 'aria-label': 'Spreadsheet tools' },
    R0.bold, R0.italic, R0.fmt,
    tb('Sort A→Z by the selected column', 'sort', () => sortSel(false), { text: 'A→Z', class: 'sh-tb sh-txt' }),
    tb('Sort Z→A by the selected column', null, () => sortSel(true), { text: 'Z→A', class: 'sh-tb sh-txt' }),
    R0.freeze, R0.filter,
    tb('Chart the selection', 'chart', (e) => chartMenu(e.currentTarget), { text: 'Chart', class: 'sh-tb sh-txt' }));
  R0.addr = el('span', { class: 'sh-addr', 'aria-live': 'polite' });
  R0.fx = el('input', { class: 'sh-fx', 'aria-label': 'Cell contents or formula', spellcheck: 'false', autocomplete: 'off' });
  R0.fx.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(S.sel.ar, S.sel.ac, R.fx.value); R.grid.focus(); move(1, 0); }
    else if (e.key === 'Escape') { e.preventDefault(); R.fx.value = rawOf(S.sel.ar, S.sel.ac); R.grid.focus(); }
  });
  const fbar = el('div', 'sh-fbar', R0.addr, el('span', 'sh-fxl', 'fx'), R0.fx);
  // the grid: a sticky head (column letters and frozen rows), a body of absolutely placed rows
  R0.headRows = el('div', 'sh-headrows');
  R0.body = el('div', { class: 'sh-body', 'data-no-i18n': '' }); // the cells are the person's
  R0.inner = el('div', 'sh-inner', R0.headRows, R0.body);
  R0.grid = el('div', { class: 'sh-grid', tabindex: '0', role: 'grid', 'aria-label': 'Spreadsheet', 'aria-multiselectable': 'true' }, R0.inner);
  R0.charts = el('div', { class: 'sh-charts', 'aria-label': 'Charts' });
  R0.tabs = el('div', { class: 'sh-tabs', role: 'tablist', 'aria-label': 'Sheets' });
  R0.status = el('div', { class: 'sh-status', 'aria-live': 'polite' });
  R0.askOut = el('div', { class: 'sh-askout', 'aria-live': 'polite' });
  R0.askIn = el('textarea', { class: 'sh-askin', rows: '1', placeholder: 'Ask Eden to change or explain this sheet…', 'aria-label': 'Ask Eden about this spreadsheet' });
  R0.est = el('div', 'sh-est');
  const chips = el('div', 'sh-chips', ...[
    ['Add a margin column', 'Add a column with the margin'],
    ['Clean up dates', 'Clean up the dates in the selected column so they are all real dates in one format'],
    ['Pivot by…', 'Make a pivot by region'],
    ['Chart this', 'Chart the selection'],
    ['Explain this formula', () => `Explain the formula in ${M.a1(S.sel.ar, S.sel.ac)}`],
    ['Find the errors', 'Find the errors in this sheet'],
  ].map(([label, text]) => el('button', { type: 'button', class: 'sh-chip', onclick: () => { R.askIn.value = typeof text === 'function' ? text() : text; R.askIn.focus(); estimate(); } }, label)));
  R0.askSend = el('button', { type: 'button', class: 'btn primary sh-askgo', onclick: askEden }, 'Ask');
  R0.askIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); askEden(); } });
  R0.askIn.addEventListener('input', debounce(estimate, 500));
  const ask = el('div', 'sh-ask', R0.askOut, chips, el('div', 'sh-askrow', R0.askIn, R0.askSend), R0.est);
  R0.pane = el('div', { class: 'sh-pane', id: 'sheetPane', hidden: true }, head, tools, fbar, R0.grid, R0.charts, R0.tabs, R0.status, ask);
  $('artifact').append(R0.pane);
  R = R0;
  wireGrid();
  // artifact.js showing something else in the canvas removes .sheet-on (openArtifact); the pane hides with it
  new MutationObserver(() => { if (!$('artifact').classList.contains('sheet-on')) R.pane.hidden = true; }).observe($('artifact'), { attributes: true, attributeFilter: ['class'] });
}

function closeSheet() {
  if (S.saved !== S.i && S.versions.length > 1 && !confirm('Close the spreadsheet? Changes you haven’t saved or exported are lost.')) return;
  hide();
  closeArtifact();
}

function setStatus(t) { if (R) R.status.textContent = t || ''; }

// ── drawing ──

function render() {
  if (!R || !S.versions.length) return;
  const v = cur();
  calcOf(v);
  const src = S.source;
  R.title.textContent = wb().title;
  R.badge.textContent = src.kind === 'google' ? 'Google Sheets' : src.kind === 'mac' ? 'On your Mac' : src.kind === 'upload' ? (/\.csv$/i.test(src.name || '') ? 'CSV' : 'Excel file') : 'New';
  R.ver.textContent = `v${S.i + 1} of ${S.versions.length}`;
  R.undo.disabled = S.i <= 0;
  R.redo.disabled = S.i >= S.versions.length - 1;
  const dirty = S.saved !== S.i;
  R.save.hidden = src.kind !== 'google' && src.kind !== 'mac';
  R.save.textContent = dirty ? (src.kind === 'google' ? 'Save to Google Sheets' : 'Save to Mac') : 'Saved';
  R.save.disabled = !dirty;
  R.freeze.classList.toggle('on', !!sheet().freeze);
  renderTabs();
  renderGrid();
  renderCharts();
  syncBar();
}

function visibleRows(s) {
  const { rows } = M.extent(s);
  const total = Math.max(rows + 30, 60);
  const frozen = s.freeze || 0;
  const out = [];
  for (let r = frozen + 1; r <= total; r++) {
    if (S.filter && r > frozen) {
      const t = shownText(s, r, S.filter.col).toLowerCase();
      if (!t.includes(S.filter.text)) continue;
    }
    out.push(r);
  }
  return out;
}
const colsShown = (s) => Math.min(MAX_COLS_SHOWN, Math.max(M.extent(s).cols + 4, 12));
const widthOf = (s, c) => s.widths[c] || COL_W;
function shownText(s, r, c) {
  const addr = M.a1(r, c);
  const cell = s.cells[addr];
  if (!cell) return '';
  return M.format(M.valueOf(s, addr, calcOf()), cell.z);
}

function cellNode(s, r, c, x) {
  const addr = M.a1(r, c);
  const cell = s.cells[addr];
  const v = cell ? M.valueOf(s, addr, calcOf()) : null;
  const n = el('div', { class: 'sh-c', role: 'gridcell', 'data-r': r, 'data-c': c, style: { left: `${x}px`, width: `${widthOf(s, c)}px` } });
  if (!cell) return n;
  n.textContent = M.format(v, cell.z);
  const st = cell.s || {};
  if (st.b) n.classList.add('b');
  if (st.i) n.classList.add('i');
  if (st.u) n.classList.add('u');
  if (st.color) n.style.color = st.color;
  if (st.fill) n.style.background = st.fill;
  const num = typeof v === 'number';
  n.style.textAlign = st.align || (num ? 'right' : typeof v === 'boolean' || M.isErr(v) ? 'center' : 'left');
  if (M.isErr(v)) { n.classList.add('err'); n.title = `${cell.f} → ${v.message}`; }
  else if (cell.f) n.title = cell.f;
  return n;
}

function rowNode(s, r, y, cols, xs) {
  const row = el('div', { class: 'sh-r', role: 'row', style: { top: `${y}px`, width: `${xs[cols] + HEAD_W}px` } });
  row.append(el('div', { class: 'sh-rn', 'data-row': r }, String(r)));
  for (let c = 1; c <= cols; c++) row.append(cellNode(s, r, c, HEAD_W + xs[c - 1]));
  return row;
}

let rowsCache = null;
function renderGrid() {
  const s = sheet();
  const cols = colsShown(s);
  const xs = [0];
  for (let c = 1; c <= cols; c++) xs.push(xs[c - 1] + widthOf(s, c));
  const rows = visibleRows(s);
  rowsCache = { rows, xs, cols };
  const width = xs[cols] + HEAD_W;
  R.inner.style.width = `${width}px`;
  // the head: column letters, then the frozen rows
  const letters = el('div', { class: 'sh-r sh-letters', role: 'row', style: { width: `${width}px`, position: 'relative' } }, el('div', { class: 'sh-rn sh-corner', title: 'Select all', onclick: () => { const e = M.extent(s); select(1, 1, Math.max(1, e.rows), Math.max(1, e.cols)); } }));
  for (let c = 1; c <= cols; c++) {
    const h = el('div', { class: 'sh-ch', 'data-col': c, role: 'columnheader', style: { left: `${HEAD_W + xs[c - 1]}px`, width: `${widthOf(s, c)}px` } }, M.colName(c), el('span', { class: 'sh-grip', 'data-grip': c, 'aria-hidden': 'true' }));
    if (S.filter && S.filter.col === c) h.classList.add('filtered');
    letters.append(h);
  }
  const frozen = [];
  for (let r = 1; r <= (s.freeze || 0); r++) { const n = rowNode(s, r, 0, cols, xs); n.style.position = 'relative'; n.classList.add('frozen'); n.setAttribute('data-no-i18n', ''); frozen.push(n); }
  R.headRows.replaceChildren(letters, ...frozen);
  R.body.style.height = `${rows.length * ROW_H}px`;
  paintRows();
  paintSelection();
}

function paintRows() {
  if (!rowsCache) return;
  const { rows, xs, cols } = rowsCache;
  const s = sheet();
  const headH = R.headRows.offsetHeight || ROW_H;
  const top = Math.max(0, R.grid.scrollTop - headH);
  const first = Math.max(0, Math.floor(top / ROW_H) - 10);
  const last = Math.min(rows.length, first + Math.ceil((R.grid.clientHeight || 600) / ROW_H) + 20);
  const frag = document.createDocumentFragment();
  for (let k = first; k < last; k++) frag.append(rowNode(s, rows[k], k * ROW_H, cols, xs));
  R.body.replaceChildren(frag);
  paintSelection();
}

function paintSelection() {
  const { r1, c1, r2, c2, ar, ac } = S.sel;
  R.inner.querySelectorAll('.sh-c.sel, .sh-c.cur').forEach((n) => n.classList.remove('sel', 'cur'));
  R.inner.querySelectorAll('.sh-c').forEach((n) => {
    const r = Number(n.dataset.r), c = Number(n.dataset.c);
    if (r >= r1 && r <= r2 && c >= c1 && c <= c2) n.classList.add('sel');
    if (r === ar && c === ac) { n.classList.add('cur'); n.setAttribute('aria-selected', 'true'); }
  });
  R.inner.querySelectorAll('.sh-ch').forEach((n) => { const c = Number(n.dataset.col); n.classList.toggle('on', c >= c1 && c <= c2); });
  R.inner.querySelectorAll('.sh-rn[data-row]').forEach((n) => { const r = Number(n.dataset.row); n.classList.toggle('on', r >= r1 && r <= r2); });
}

function renderTabs() {
  const tabs = wb().sheets.map((s, i) => {
    const b = el('button', { type: 'button', role: 'tab', class: `sh-tab${i === S.active ? ' on' : ''}`, 'aria-selected': String(i === S.active), title: 'Double-click to rename', onclick: () => { S.active = i; S.filter = null; R.filter.value = ''; S.sel = { r1: 1, c1: 1, r2: 1, c2: 1, ar: 1, ac: 1 }; render(); }, ondblclick: () => renameSheet(i) }, el('span', { 'data-no-i18n': '' }, s.name));
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); sheetMenu(b, i); });
    return b;
  });
  R.tabs.replaceChildren(...tabs, el('button', { type: 'button', class: 'sh-tab add', 'aria-label': 'Add a sheet', title: 'Add a sheet', onclick: () => { let name = ''; setWorkbook(M.edit(wb(), (w) => { name = w.addSheet(`Sheet${wb().sheets.length + 1}`).name; }), `Added ${name}`); S.active = wb().sheets.length - 1; render(); } }, '+'));
}

function renameSheet(i) {
  const s = wb().sheets[i];
  const to = prompt('Rename the sheet', s.name);
  if (!to || to.trim() === s.name) return;
  try { setWorkbook(M.edit(wb(), (w) => w.renameSheet(s.name, to.trim())), `Renamed ${s.name} to ${to.trim()}`); } catch (e) { toast(e.message); }
}
function sheetMenu(anchor, i) {
  const s = wb().sheets[i];
  popMenu(anchor, [
    ['Rename…', () => renameSheet(i)],
    ['Delete this sheet', () => { if (!confirm(`Delete “${s.name}”? (Undo brings it back.)`)) return; try { setWorkbook(M.edit(wb(), (w) => w.removeSheet(s.name)), `Deleted ${s.name}`); } catch (e) { toast(e.message); } }],
  ]);
}

function renderCharts() {
  const s = sheet();
  if (!s.charts.length) { R.charts.replaceChildren(); R.charts.hidden = true; return; }
  R.charts.hidden = false;
  R.charts.replaceChildren(...s.charts.map((ch) => {
    const svg = chartSvg(chartData(s, ch.range, calcOf()), { type: ch.type, title: ch.title || `${s.name} ${ch.range}`, width: 420, height: 250 });
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml'); // text in it is escaped by chartSvg
    const fig = el('figure', 'sh-chart');
    fig.append(document.importNode(doc.documentElement, true));
    fig.append(el('figcaption', '', el('span', { 'data-no-i18n': '' }, `${ch.type} · ${ch.range}`), el('span', 'sh-sp'),
      el('button', { type: 'button', class: 'sh-tb sh-txt', onclick: () => downloadPng(svg, `${(ch.title || 'chart').replace(/[^\w-]+/g, '-')}.png`) }, 'PNG'),
      el('button', { type: 'button', class: 'sh-tb', 'aria-label': 'Remove the chart', title: 'Remove the chart', onclick: () => setWorkbook(M.edit(wb(), (w) => { const t = w.sheet(s.name); t.charts = t.charts.filter((x) => x.id !== ch.id); }), 'Removed a chart') }, ico('x', 13))));
    return fig;
  }));
}

function syncBar() {
  const { r1, c1, r2, c2, ar, ac } = S.sel;
  R.addr.textContent = r1 === r2 && c1 === c2 ? M.a1(ar, ac) : `${M.a1(r1, c1)}:${M.a1(r2, c2)}`;
  if (document.activeElement !== R.fx) R.fx.value = rawOf(ar, ac);
  const st = selStyle();
  R.bold.classList.toggle('on', !!st.b);
  R.italic.classList.toggle('on', !!st.i);
  const z = (sheet().cells[M.a1(ar, ac)] || {}).z || 'General';
  R.fmt.value = M.FORMATS.some(([k]) => k === z) ? z : 'General';
}
const rawOf = (r, c) => { const cell = sheet().cells[M.a1(r, c)]; return !cell ? '' : cell.f ? cell.f : cell.v === null || cell.v === undefined ? '' : cell.z && M.isDateFormat(cell.z) ? M.format(cell.v, 'yyyy-mm-dd') : String(cell.v); };
const selStyle = () => (sheet().cells[M.a1(S.sel.ar, S.sel.ac)] || {}).s || {};

// ── editing ──

function commit(r, c, text) {
  const s = sheet();
  const addr = M.a1(r, c);
  const old = s.cells[addr];
  if ((old ? rawOf(r, c) : '') === text) return;
  const parsed = M.parseInput(text);
  setWorkbook(M.edit(wb(), (w) => w.set(s.name, addr, { ...parsed, z: parsed.z || (old && old.z), s: old && old.s })), `Edited ${addr}`);
}

function startEdit(seed) {
  const { ar, ac } = S.sel;
  const node = R.inner.querySelector(`.sh-c[data-r="${ar}"][data-c="${ac}"]`);
  if (!node) return;
  stopEdit(false);
  const box = node.getBoundingClientRect(), base = R.inner.getBoundingClientRect();
  const inp = el('input', { class: 'sh-edit', spellcheck: 'false', autocomplete: 'off', 'aria-label': `Edit ${M.a1(ar, ac)}`, style: { left: `${box.left - base.left}px`, top: `${box.top - base.top}px`, width: `${Math.max(box.width, 120)}px`, height: `${box.height}px` } });
  inp.value = seed === undefined ? rawOf(ar, ac) : seed;
  S.editing = { r: ar, c: ac, inp };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); stopEdit(true); if (e.key === 'Tab') move(0, e.shiftKey ? -1 : 1); else move(e.shiftKey ? -1 : 1, 0); R.grid.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); stopEdit(false); R.grid.focus(); }
    e.stopPropagation();
  });
  inp.addEventListener('input', () => { R.fx.value = inp.value; });
  inp.addEventListener('blur', () => { if (S.editing && S.editing.inp === inp) stopEdit(true); });
  R.inner.append(inp);
  inp.focus();
  if (seed !== undefined) inp.setSelectionRange(inp.value.length, inp.value.length);
}
function stopEdit(save) {
  const e = S.editing;
  if (!e) return;
  S.editing = null;
  e.inp.remove();
  if (save) commit(e.r, e.c, e.inp.value);
}

function select(r1, c1, r2 = r1, c2 = c1, keepAnchor = false) {
  const ar = keepAnchor ? S.sel.ar : r1, ac = keepAnchor ? S.sel.ac : c1;
  S.sel = { r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2), ar, ac };
  paintSelection();
  syncBar();
}
function move(dr, dc, extend = false) {
  const s = sheet();
  const cols = colsShown(s);
  if (extend) {
    const { ar, ac } = S.sel;
    const r2 = Math.max(1, (S.sel.r1 === ar ? S.sel.r2 : S.sel.r1) + dr), c2 = Math.max(1, Math.min(cols, (S.sel.c1 === ac ? S.sel.c2 : S.sel.c1) + dc));
    select(ar, ac, r2, c2, true);
  } else {
    const rows = rowsCache ? rowsCache.rows : [];
    let r = S.sel.ar;
    if (dr) {
      const all = [...Array.from({ length: s.freeze || 0 }, (_, i) => i + 1), ...rows];
      const k = all.indexOf(r);
      r = all[Math.max(0, Math.min(all.length - 1, (k < 0 ? 0 : k) + dr))] || 1;
    }
    select(r, Math.max(1, Math.min(cols, S.sel.ac + dc)));
  }
  scrollIntoView(S.sel.ar, S.sel.ac);
}
function scrollIntoView(r, c) {
  if (!rowsCache) return;
  const k = rowsCache.rows.indexOf(r);
  const headH = R.headRows.offsetHeight;
  if (k >= 0) {
    const y = headH + k * ROW_H;
    if (y < R.grid.scrollTop + headH) R.grid.scrollTop = y - headH;
    else if (y + ROW_H > R.grid.scrollTop + R.grid.clientHeight) R.grid.scrollTop = y + ROW_H - R.grid.clientHeight;
  }
  const x = rowsCache.xs[c - 1], w = widthOf(sheet(), c);
  if (x < R.grid.scrollLeft) R.grid.scrollLeft = x;
  else if (HEAD_W + x + w > R.grid.scrollLeft + R.grid.clientWidth) R.grid.scrollLeft = HEAD_W + x + w - R.grid.clientWidth;
  paintRows();
}

function clearSel() {
  const { r1, c1, r2, c2 } = S.sel;
  const s = sheet();
  setWorkbook(M.edit(wb(), (w) => { for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) { const old = s.cells[M.a1(r, c)]; if (old) w.set(s.name, M.a1(r, c), { v: null, z: old.z, s: old.s }); } }), `Cleared ${M.rangeText(S.sel)}`);
}
function styleSel(style) {
  const { r1, c1, r2, c2 } = S.sel;
  const s = sheet();
  setWorkbook(M.edit(wb(), (w) => { for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) w.set(s.name, M.a1(r, c), M.styled(s.cells[M.a1(r, c)] || { v: null }, style)); }), `Formatted ${M.rangeText(S.sel)}`);
}
function toggleFreeze() {
  const s = sheet();
  setWorkbook(M.edit(wb(), (w) => { w.sheet(s.name).freeze = s.freeze ? 0 : 1; }), s.freeze ? 'Unfroze the header' : 'Froze the header row');
}
function sortSel(desc) {
  const s = sheet();
  const e = M.extent(s);
  const one = S.sel.r1 === S.sel.r2;
  // one cell or a column picked: sort the whole table by that column, keeping row 1 as the header when it's text
  const range = one || S.sel.c1 === S.sel.c2 ? { r1: 1, c1: 1, r2: e.rows, c2: e.cols } : { ...S.sel };
  const header = range.r1 === 1 && typeof M.valueOf(s, M.a1(1, S.sel.ac), calcOf()) === 'string';
  if (range.r2 <= range.r1) return;
  setWorkbook(M.edit(wb(), (w) => M.sortRange(w, s.name, range, S.sel.ac, { desc, header, calc: calcOf() })), `Sorted by ${M.colName(S.sel.ac)} ${desc ? 'Z→A' : 'A→Z'}`);
}
function undo() { if (S.i > 0) { S.i--; render(); } }
function redo() { if (S.i < S.versions.length - 1) { S.i++; render(); } }

function copySel(e) {
  const { r1, c1, r2, c2 } = S.sel;
  const lines = [];
  for (let r = r1; r <= r2; r++) { const row = []; for (let c = c1; c <= c2; c++) row.push(shownText(sheet(), r, c).replace(/[\t\n]/g, ' ')); lines.push(row.join('\t')); }
  e.clipboardData.setData('text/plain', lines.join('\n'));
  e.preventDefault();
}
function pasteAt(e) {
  const text = e.clipboardData.getData('text/plain');
  if (!text) return;
  e.preventDefault();
  const rows = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map((l) => l.split('\t'));
  const s = sheet();
  const { ar, ac } = S.sel;
  if (rows.length * (rows[0] || []).length > 50_000) { toast('That’s too much to paste at once'); return; }
  setWorkbook(M.edit(wb(), (w) => rows.forEach((row, i) => row.forEach((t, j) => { const addr = M.a1(ar + i, ac + j); const old = s.cells[addr]; const p = M.parseInput(t); w.set(s.name, addr, { ...p, z: p.z || (old && old.z), s: old && old.s }); }))), `Pasted into ${M.a1(ar, ac)}`);
  select(ar, ac, ar + rows.length - 1, ac + (rows[0] || ['']).length - 1, true);
}

function wireGrid() {
  const g = R.grid;
  g.addEventListener('scroll', () => requestAnimationFrame(paintRows), { passive: true });
  let dragging = false, resizing = null;
  const cellAt = (t) => t.closest && t.closest('.sh-c');
  g.addEventListener('mousedown', (e) => {
    const grip = e.target.closest('[data-grip]');
    if (grip) { resizing = { c: Number(grip.dataset.grip), x: e.clientX, w: widthOf(sheet(), Number(grip.dataset.grip)) }; e.preventDefault(); return; }
    const ch = e.target.closest('.sh-ch');
    if (ch) { const c = Number(ch.dataset.col); const n = Math.max(M.extent(sheet()).rows, 1); if (e.shiftKey) select(1, S.sel.ac, n, c, true); else select(1, c, n, c); e.preventDefault(); g.focus(); return; }
    const rn = e.target.closest('.sh-rn[data-row]');
    if (rn) { const r = Number(rn.dataset.row); select(r, 1, r, Math.max(M.extent(sheet()).cols, 1)); e.preventDefault(); g.focus(); return; }
    const c = cellAt(e.target);
    if (!c) return;
    if (S.editing) stopEdit(true);
    const r = Number(c.dataset.r), col = Number(c.dataset.c);
    if (e.shiftKey) select(S.sel.ar, S.sel.ac, r, col, true); else select(r, col);
    dragging = true;
    g.focus({ preventScroll: true });
    e.preventDefault();
  });
  addEventListener('mousemove', (e) => {
    if (resizing) { const w = Math.max(32, Math.min(600, resizing.w + e.clientX - resizing.x)); const col = R.inner.querySelector(`.sh-ch[data-col="${resizing.c}"]`); if (col) col.style.width = `${w}px`; resizing.now = w; return; }
    if (!dragging) return;
    const c = cellAt(document.elementFromPoint(e.clientX, e.clientY) || document.body);
    if (c) select(S.sel.ar, S.sel.ac, Number(c.dataset.r), Number(c.dataset.c), true);
  });
  addEventListener('mouseup', () => {
    dragging = false;
    if (resizing) { const { c, now } = resizing; resizing = null; if (now) setWorkbook(M.edit(wb(), (w) => { w.sheet(sheet().name).widths[c] = Math.round(now); }), `Resized column ${M.colName(c)}`); }
  });
  g.addEventListener('dblclick', (e) => { if (cellAt(e.target)) startEdit(); });
  g.addEventListener('keydown', (e) => {
    if (S.editing || e.target !== g) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key;
    if (mod && k.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && k.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod && k.toLowerCase() === 'b') { e.preventDefault(); styleSel({ bold: !selStyle().b }); return; }
    if (mod && k.toLowerCase() === 'i') { e.preventDefault(); styleSel({ italic: !selStyle().i }); return; }
    if (mod && k.toLowerCase() === 'a') { e.preventDefault(); const x = M.extent(sheet()); select(1, 1, Math.max(1, x.rows), Math.max(1, x.cols)); return; }
    if (mod) return;
    const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[k]) { e.preventDefault(); move(...arrows[k], e.shiftKey); return; }
    if (k === 'Enter' || k === 'F2') { e.preventDefault(); startEdit(); return; }
    if (k === 'Tab') { e.preventDefault(); move(0, e.shiftKey ? -1 : 1); return; }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); clearSel(); return; }
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); if (S.filter) { S.filter = null; R.filter.value = ''; renderGrid(); } else select(S.sel.ar, S.sel.ac); return; } // Esc never closes the sheet by accident (the × does)
    if (k.length === 1 && !e.altKey) { e.preventDefault(); startEdit(k); }
  });
  g.addEventListener('copy', copySel);
  g.addEventListener('paste', pasteAt);
  g.addEventListener('cut', (e) => { copySel(e); clearSel(); });
}

// ── menus and dialogs ──

let openPop = null;
function popMenu(anchor, items) {
  if (openPop) openPop.remove();
  const box = el('div', { class: 'sh-menu glass', role: 'menu' }, ...items.filter(Boolean).map(([label, run, note]) => el('button', { type: 'button', role: 'menuitem', onclick: () => { box.remove(); openPop = null; run(); } }, el('span', '', label), note ? el('small', '', note) : null)));
  document.body.append(box);
  const r = anchor.getBoundingClientRect();
  box.style.top = `${Math.min(innerHeight - box.offsetHeight - 8, r.bottom + 4)}px`;
  box.style.left = `${Math.max(8, Math.min(innerWidth - box.offsetWidth - 8, r.left))}px`;
  openPop = box;
  const off = (e) => { if (!box.contains(e.target)) { box.remove(); openPop = null; removeEventListener('pointerdown', off, true); } };
  setTimeout(() => addEventListener('pointerdown', off, true), 0);
  box.querySelector('button')?.focus();
}

function dialog(title, fill) {
  const back = el('div', { class: 'sh-dlg-back' });
  const box = el('div', { class: 'sh-dlg glass', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, el('h3', '', title));
  const close = () => back.remove();
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  back.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  back.append(box);
  document.body.append(back);
  fill(box, close);
  return { box, close };
}

function openMenu(anchor) {
  popMenu(anchor, [
    ['Upload a file…', openUpload, '.xlsx, .xls, .csv'],
    ['From your Mac…', openMacSearch, 'Excel or CSV'],
    ['From Google Sheets…', openGoogle, 'Google Picker'],
    ['New spreadsheet', newSheetCanvas],
  ]);
}
function exportMenu(anchor) {
  popMenu(anchor, [
    ['Download .xlsx', () => exportXlsx(), 'Excel, all sheets'],
    ['Download .csv', () => exportCsv(), 'this sheet'],
    ['Save as a new Google Sheet…', saveAsGoogle, 'Google Drive'],
    S.source.kind === 'google' ? ['Open in Google Sheets', () => window.open(S.source.url, '_blank', 'noopener')] : null,
  ]);
}
function chartMenu(anchor) {
  const range = S.sel.r1 === S.sel.r2 && S.sel.c1 === S.sel.c2 ? null : M.rangeText(S.sel);
  if (!range) { toast('Select the range to chart first: labels in the first column, numbers next to them'); return; }
  const add = (type) => setWorkbook(M.edit(wb(), (w) => { w.sheet(sheet().name).charts.push({ id: `c${Date.now().toString(36)}`, range, type, title: '' }); }), `Added a ${type} chart of ${range}`);
  popMenu(anchor, [['Bar chart', () => add('bar')], ['Line chart', () => add('line')], ['Pie chart', () => add('pie')]]);
}
function historyMenu(e) {
  popMenu(e.currentTarget, S.versions.map((v, i) => [`${i === S.i ? '● ' : ''}v${i + 1} · ${v.label}`, () => { S.i = i; render(); }, `${v.by === 'eden' ? 'Eden' : v.by === 'file' ? 'opened' : 'you'} · ${new Date(v.at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}${i === S.saved ? ' · saved' : ''}`]).reverse().slice(0, 30));
}

// ── export and saving ──

function saveBlob(name, bytes, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
const fileBase = () => (wb().title || 'spreadsheet').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);

function svgToPng(svg) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width * 2; c.height = img.height * 2;
      const g = c.getContext('2d'); g.scale(2, 2); g.drawImage(img, 0, 0);
      c.toBlob((b) => (b ? b.arrayBuffer().then((x) => resolve(new Uint8Array(x)), reject) : reject(new Error('no PNG'))), 'image/png');
    };
    img.onerror = () => reject(new Error('The chart didn’t render'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}
async function downloadPng(svg, name) { try { saveBlob(name, await svgToPng(svg), 'image/png'); } catch (e) { toast(e.message); } }

/** The Eden charts as pictures for the .xlsx (Excel charts themselves aren't written by ExcelJS). */
async function chartImages(book) {
  const out = [];
  for (const s of book.sheets) {
    const { cols } = M.extent(s);
    for (const [k, ch] of s.charts.entries()) {
      try {
        const png = await svgToPng(chartSvg(chartData(s, ch.range, calcOf()), { type: ch.type, title: ch.title || `${s.name} ${ch.range}`, width: 480, height: 280 }));
        out.push({ sheet: s.name, png, col: cols + 1, row: k * 16, width: 480, height: 280 });
      } catch { /* a chart that won't render stays out */ }
    }
  }
  return out;
}

async function xlsxBytes() {
  const io = await ioLib();
  return io.writeXlsx(wb(), calcOf(), { ExcelJS: await excelLib() }, { base: S.base, images: await chartImages(wb()) });
}
async function exportXlsx() {
  setStatus('Writing the .xlsx…');
  try { saveBlob(`${fileBase()}.xlsx`, await xlsxBytes(), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); setStatus(''); }
  catch (e) { setStatus(''); toast(`Couldn’t write the .xlsx: ${e.message}`); }
}
async function exportCsv() {
  const io = await ioLib();
  saveBlob(`${fileBase()}${wb().sheets.length > 1 ? `-${sheet().name}` : ''}.csv`, io.writeCsv(wb(), calcOf(), S.active), 'text/csv');
}

/** What changed since the version the source holds. */
function pendingDiff() {
  const base = S.saved >= 0 ? S.versions[S.saved].wb : { title: '', sheets: [] };
  return M.diffWorkbooks(base, wb());
}

function diffTable(d, calcAfter, calcBefore, max = 40) {
  const rows = d.cells.slice(0, max).map((x) => {
    const b = x.before ? (x.before.f ? x.before.f : M.cellText(x.before)) : '';
    const aShown = x.after ? (x.after.f ? `${x.after.f}  → ${M.format(valueIn(x.sheet, x.addr, calcAfter), x.after.z)}` : M.cellText(x.after)) : tx('(empty)');
    return el('tr', '', el('td', 'mono', `${d.cells.some((y) => y.sheet !== x.sheet) || x.sheet !== sheet().name ? `${x.sheet}!` : ''}${x.addr}`), el('td', 'old', b), el('td', 'new', aShown));
  });
  return el('div', 'sh-diffwrap', el('table', 'sh-diff', el('thead', '', el('tr', '', el('th', '', 'Cell'), el('th', '', 'Before'), el('th', '', 'After'))), el('tbody', { 'data-no-i18n': '' }, ...rows)),
    d.cells.length > max ? el('p', 'muted', `…and ${(d.cells.length - max).toLocaleString(locale())} more cells.`) : null);
}
const valueIn = (sheetName, addr, calc) => { const m = calc && calc.get(sheetName.toLowerCase()); return m && m.has(addr) ? m.get(addr) : null; };

async function saveToSource() {
  const d = pendingDiff();
  if (S.source.kind === 'google') return saveGoogle(d);
  if (S.source.kind === 'mac') return saveMac(d);
  return null;
}

function saveGoogle(d) {
  const formatsOnly = d.cells.filter((x) => x.before && x.after && x.before.v === x.after.v && x.before.f === x.after.f).length;
  const cells = d.cells.filter((x) => !(x.before && x.after && x.before.v === x.after.v && x.before.f === x.after.f));
  if (!cells.length && !d.sheetsAdded.length) { toast(formatsOnly ? 'Only formatting changed: Google Sheets keeps its own formats (save as a new Google Sheet to take Eden’s)' : 'Nothing to save'); return; }
  const before = S.versions[S.saved].wb;
  const baseMap = {};
  for (const x of cells) if (x.before) baseMap[`${x.sheet}!${x.addr}`] = x.before.f || (x.before.v ?? null);
  const changes = cells.map((x) => (x.after && x.after.f ? { sheet: x.sheet, addr: x.addr, f: x.after.f } : { sheet: x.sheet, addr: x.addr, v: x.after ? x.after.v ?? null : null }));
  dialog(`Save to Google Sheets: “${S.source.title}”?`, (box, close) => {
    const go = el('button', { type: 'button', class: 'btn primary' }, `Write ${changes.length.toLocaleString(locale())} cell${changes.length === 1 ? '' : 's'}`);
    box.append(
      el('p', '', `Eden writes these cells to the Google Sheet${d.sheetsAdded.length ? ` and adds ${d.sheetsAdded.map((n) => `“${n}”`).join(', ')}` : ''}. ${formatsOnly ? `${formatsOnly} formatting-only change${formatsOnly === 1 ? '' : 's'} stay in Eden. ` : ''}${d.sheetsRemoved.length ? `Deleted sheets (${d.sheetsRemoved.join(', ')}) stay in Google: delete them there. ` : ''}${d.charts.length ? 'Charts stay in Eden (Export .xlsx to keep them). ' : ''}`),
      diffTable({ ...d, cells }, calcOf(), M.recalc(before, fns, {})),
      el('p', 'muted', 'What the cells held before is kept: Undo save here, or in Activity on your Mac.'),
      el('div', 'sh-acts', el('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), go));
    const write = async (force) => {
      go.disabled = true; go.textContent = 'Saving…';
      try {
        const r = await sheetsCall('write', { id: S.source.id, changes, base: baseMap, addSheets: d.sheetsAdded, confirm: true, ...(force ? { force: true } : {}) });
        S.saved = S.i;
        S.lastSave = { id: S.source.id, before: r.before };
        close();
        render();
        toast(`Saved ${r.updated} cells to Google Sheets`, { label: 'Undo save', run: undoGoogleSave });
      } catch (e) {
        if (e.status === 409 && !force) { go.disabled = false; go.textContent = 'Save anyway'; go.onclick = () => write(true); box.append(el('p', 'sh-err', e.message)); return; }
        go.disabled = false; go.textContent = 'Try again';
        box.append(el('p', 'sh-err', e.message));
      }
    };
    go.onclick = () => write(false);
  });
}

async function undoGoogleSave() {
  const ls = S.lastSave;
  if (!ls) return;
  try {
    await sheetsCall('write', { id: ls.id, changes: ls.before.map((b) => (b.f ? { sheet: b.sheet, addr: b.addr, f: b.f } : { sheet: b.sheet, addr: b.addr, v: b.v })), confirm: true, force: true });
    S.lastSave = null;
    if (S.saved > 0) S.saved = -1;
    render();
    toast('The Google Sheet is back as it was (Eden’s version stays here)');
  } catch (e) { toast(e.message); }
}

function saveMac(d) {
  const src = S.source;
  const xls = /\.xls$/i.test(src.path);
  const csv = /\.(csv|tsv)$/i.test(src.path);
  const target = xls ? src.path.replace(/\.xls$/i, '.xlsx') : src.path;
  dialog(`Save ${target.split('/').pop()} on your Mac?`, (box, close) => {
    const go = el('button', { type: 'button', class: 'btn primary' }, xls ? 'Save as .xlsx' : 'Save');
    box.append(
      el('p', '', `${M.describeDiff(d)}. ${xls ? 'The old .xls stays as it is; Eden writes a new .xlsx beside it.' : 'Eden keeps the file as it was for 7 days: Undo it in Activity.'}${csv && wb().sheets.length > 1 ? ` A CSV holds one sheet: “${sheet().name}” is saved.` : ''}`),
      diffTable(d, calcOf(), S.saved >= 0 ? M.recalc(S.versions[S.saved].wb, fns, {}) : null),
      el('div', 'sh-acts', el('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), go));
    const write = async (force) => {
      go.disabled = true; go.textContent = 'Saving…';
      try {
        const bytes = csv ? (await ioLib()).writeCsv(wb(), calcOf(), S.active) : await xlsxBytes();
        const r = await macFile({ action: 'save', path: target, data: bytesToBase64(bytes), mtime: src.mtime, confirm: true, ...(xls ? { from: src.path } : {}), ...(force ? { force: true } : {}) });
        S.source = { ...src, path: r.path, name: r.path.split('/').pop(), mtime: r.mtime };
        if (!csv) S.base = bytes;
        S.saved = S.i;
        close();
        render();
        toast(`Saved ${S.source.name} on your Mac`);
      } catch (e) {
        if (e.status === 409 && !force && !xls) { go.disabled = false; go.textContent = 'Save anyway'; go.onclick = () => write(true); box.append(el('p', 'sh-err', e.message)); return; }
        go.disabled = false; go.textContent = 'Try again';
        box.append(el('p', 'sh-err', e.message));
      }
    };
    go.onclick = () => write(false);
  });
}

async function saveAsGoogle() {
  const st = await sheetsStatus();
  if (!st.sheets) { askConnect(); return; }
  dialog('Save as a new Google Sheet?', (box, close) => {
    const go = el('button', { type: 'button', class: 'btn primary' }, 'Save to Google Drive');
    box.append(el('p', '', `Eden uploads “${wb().title}” (all ${wb().sheets.length} sheet${wb().sheets.length === 1 ? '' : 's'}, formulas and formats) to your Google Drive as a new Google Sheet. Eden can then open and change only that file.`),
      el('div', 'sh-acts', el('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), go));
    go.onclick = async () => {
      go.disabled = true; go.textContent = 'Uploading…';
      try {
        const r = await driveUpload({ name: `${fileBase()}.xlsx`, bytes: await xlsxBytes() }, { convertTo: 'sheets' });
        close();
        S.source = { kind: 'google', id: r.id, url: r.url, title: r.name };
        // reopen from Google so the canvas matches what Google made of it (sheet names, values)
        await openGoogleId(r.id);
        toast('Saved as a new Google Sheet', { label: 'Open it', run: () => window.open(r.url, '_blank', 'noopener') });
      } catch (e) {
        if (e.code === 'scope' || e.code === 'not_connected') { close(); askConnect(); return; }
        go.disabled = false; go.textContent = 'Try again'; box.append(el('p', 'sh-err', e.message));
      }
    };
  });
}

// ── Ask Eden (chat edits) ──

function contextFor(question) {
  const sel = S.sel.r1 === S.sel.r2 && S.sel.c1 === S.sel.c2 && S.sel.r1 === 1 && S.sel.c1 === 1 ? null : M.rangeText(S.sel);
  const wantsCheck = /\b(error|errors|wrong|mistake|check|broken|fix|audit)\b/i.test(question);
  return M.sheetContext(wb(), calcOf(), { active: S.active, selection: sel, problems: wantsCheck ? M.findProblems(wb(), calcOf()) : null });
}

let estSeq = 0;
async function estimate() {
  const q = R.askIn.value.trim();
  const my = ++estSeq;
  if (!q || !S.versions.length) { R.est.textContent = ''; return; }
  const ctx = contextFor(q);
  const size = `Sends the sheet’s outline${ctx.ranges.length ? ` and ${ctx.ranges.join(', ')}` : ''} · about ${Math.round(ctx.tokens / 100) / 10}k tokens${ctx.cut ? ' (big sheet: not all cells)' : ''}`;
  R.est.textContent = size;
  try {
    const r = await api.route({ prompt: `${q}\n\n${ctx.text}`, ...routeSettings(), classifier: 'off', eden: true });
    if (my !== estSeq) return;
    const k = r.pick;
    if (k) R.est.textContent = `${size} · ${shortModel(k.name)} · est. ${fmtCost(k.costUSD)}`;
  } catch { /* the size alone */ }
}

async function askEden() {
  const q = R.askIn.value.trim();
  if (!q || S.ask.busy) return;
  S.ask.busy = true;
  R.askSend.disabled = true;
  R.askIn.value = '';
  const ctx = contextFor(q);
  const turn = el('div', 'sh-turn', el('div', { class: 'sh-q', 'data-no-i18n': '' }, q));
  const answer = el('div', { class: 'sh-a md', 'data-no-i18n': '' }, el('span', 'muted', tx('Asking Eden…')));
  const foot = el('div', 'sh-foot');
  turn.append(answer, foot);
  R.askOut.append(turn);
  R.askOut.scrollTop = R.askOut.scrollHeight;
  let out = '', model = '', cost = null, flagged = false, frame = 0;
  const paint = () => { frame = 0; answer.replaceChildren(renderMarkdown(M.proseOf(out) || '…')); };
  const messages = [...S.ask.history.slice(-6), { role: 'user', content: q }];
  try {
    await api.send({
      messages,
      context: [{ title: `Spreadsheet: ${wb().title}`, text: ctx.text, source: 'file' }],
      system: M.SHEET_SYSTEM,
      settings: routeSettings(),
      mode: 'chat',
    }, {
      onEvent: (t, d) => {
        if (t === 'route') model = d.modelName || d.model || '';
        else if (t === 'text') { out += d.text || ''; if (!frame) frame = requestAnimationFrame(paint); }
        else if (t === 'usage' && typeof d.costUSD === 'number') cost = d.costUSD;
        else if (t === 'fallback') out = '';
        else if (t === 'provenance') flagged = (d.sources || []).some((s) => (s.flags || []).length);
        else if (t === 'error') throw new Error(d.message || 'Eden couldn’t answer.');
      },
    });
    if (frame) cancelAnimationFrame(frame);
    paint();
    S.ask.history.push({ role: 'user', content: q }, { role: 'assistant', content: out, untrusted: true });
    foot.append(el('span', '', [model && shortModel(model), cost !== null ? fmtCost(cost) : '', `${Math.round(ctx.tokens / 100) / 10}k tokens of the sheet`].filter(Boolean).join(' · ')));
    if (flagged) foot.append(el('span', 'sh-flag', ico('shield', 12), 'Text in the cells looked like instructions: Eden treated it as data'));
    const raw = M.changeSetIn(out);
    if (raw) previewChange(turn, raw, q);
  } catch (e) {
    answer.replaceChildren(el('span', 'sh-err', tx(`Eden couldn’t answer: ${e.message}`)));
  } finally {
    S.ask.busy = false;
    R.askSend.disabled = false;
    R.est.textContent = '';
    R.askOut.scrollTop = R.askOut.scrollHeight;
  }
}

/** Eden's change set: checked, applied to a copy, shown as a diff; kept only on Apply. */
function previewChange(turn, raw, question) {
  const card = el('div', 'sh-prev');
  turn.append(card);
  const v = raw.invalid ? { ok: false, errors: ['The change set isn’t valid JSON.'] } : M.validateChangeSet(raw, wb());
  if (!v.ok) {
    card.append(el('b', '', 'Eden’s change couldn’t be used'), el('ul', '', ...v.errors.slice(0, 6).map((x) => el('li', '', x))),
      el('div', 'sh-acts', el('button', { type: 'button', class: 'btn', onclick: () => { R.askIn.value = `Your change set was refused: ${v.errors.slice(0, 3).join(' ')} Please send a corrected one for: ${question}`; askEden(); } }, 'Ask Eden to fix it')));
    return;
  }
  let next;
  const baseIndex = S.i;
  try { next = M.applyChangeSet(wb(), v.cs, { calc: calcOf() }); } catch (e) { card.append(el('p', 'sh-err', e.message)); return; }
  const nextCalc = M.recalc(next, fns, {});
  const d = M.diffWorkbooks(wb(), next);
  const errorsAfter = M.findProblems(next, nextCalc).filter((p) => p.kind === 'error' && d.cells.some((x) => x.sheet === p.sheet && x.addr === p.addr));
  card.append(el('b', v.cs.summary ? { 'data-no-i18n': '' } : '', v.cs.summary || 'Eden’s change'), el('div', 'muted', M.describeDiff(d)), diffTable(d, nextCalc, calcOf(), 25));
  if (errorsAfter.length) card.append(el('p', 'sh-err', `${errorsAfter.length} new cell${errorsAfter.length === 1 ? '' : 's'} would show an error (${errorsAfter.slice(0, 3).map((p) => `${p.addr} ${p.note.split(' gives ')[1] || ''}`).join(', ')}).`));
  for (const ch of d.charts) {
    const svg = chartSvg(chartData(M.sheetByName(next, ch.sheet), ch.chart.range, nextCalc), { type: ch.chart.type, title: ch.chart.title, width: 360, height: 220 });
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    card.append(document.importNode(doc.documentElement, true));
  }
  const apply = el('button', { type: 'button', class: 'btn primary' }, 'Apply');
  const discard = el('button', { type: 'button', class: 'btn' }, 'Discard');
  apply.onclick = () => {
    if (S.i !== baseIndex) { // the sheet changed meanwhile: apply onto what's there now
      try { next = M.applyChangeSet(wb(), M.validateChangeSet(raw, wb()).cs, { calc: calcOf() }); } catch (e) { toast(e.message); return; }
    }
    setWorkbook(next, `Eden: ${v.cs.summary || question}`.slice(0, 120), 'eden');
    const added = d.sheetsAdded.find((n) => n !== sheet().name);
    if (added && d.cells.every((x) => x.sheet === added)) { S.active = wb().sheets.findIndex((s) => s.name === added); render(); }
    card.replaceChildren(el('span', 'muted', `Applied as v${S.i + 1}. Undo (⌘Z) takes it back.`));
  };
  discard.onclick = () => card.replaceChildren(el('span', 'muted', 'Discarded.'));
  card.append(el('div', 'sh-acts', discard, apply));
}

addEventListener('resize', () => { if (sheetOpen()) paintRows(); });
export const _test = { S, isMobile };
