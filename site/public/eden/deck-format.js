// Everyday editing panels for Eden Slides (web only): Format › Chart and Format › Table when such a slide is shown,
// Document › Background and Document › Slide numbers & footer. They plug into the editor shell (deck-shell.js; the
// contract is research_notes/slides-redesign/inspector-api.md) and change the deck only through ctx.commit, so each
// change is one version (undo = the version arrows). The model is deck-format-model.js, the drawing deck-format-draw.js.
// Grids are inputs: Tab and Shift+Tab move between cells, Enter moves down, and a paste of several cells from Excel,
// Numbers or Google Sheets (tab-separated) fills the grid from that cell.

import { el, addStylesheet } from './util.js';
import { t as tx } from './i18n.js';
import { IN_APP } from './native.js';
import { themeOf, CHART_TYPES, LIMITS } from './deck-model.js';
import * as F from './deck-format-model.js';
import { showLegend, showValues } from './deck-format-draw.js';
import { registerInspector, registerContextMenu, kit } from './deck-shell.js';

const PIE = (c) => c.type === 'pie' || c.type === 'doughnut';
const live = (ctx) => (ctx.currentDeck && ctx.currentDeck()) || ctx.deck;
const at = (ctx) => { const d = ctx.deck, i = ctx.selection ? ctx.selection.slide : -1; return d && d.slides[i] ? { d, i, s: d.slides[i] } : null; };
const isLayout = (layout) => (sel, ctx) => { const d = ctx.deck; return !!(d && d.slides[sel.slide] && d.slides[sel.slide].layout === layout && d.slides[sel.slide][layout]); };

/**
 * Save an edit once the browser has moved focus (a Tab or Enter fires `change` first): the control that now has the
 * focus gets it back after the redraw.
 */
function save(ctx, make, toastText = '') {
  setTimeout(() => {
    const a = document.activeElement;
    if (a && a.dataset && a.dataset.key && ctx.keepFocus) ctx.keepFocus(a.dataset.key);
    const d = live(ctx);
    if (!d) return;
    const next = make(d);
    if (next && next !== d) ctx.commit(next, toastText ? { toastText } : {});
  }, 0);
}

/** Several cells in the clipboard (a tab or a line break): rows, else null (a plain paste). */
const pastedRows = (e) => { const s = e.clipboardData ? e.clipboardData.getData('text/plain') : ''; return s && /[\t\n]/.test(s.replace(/\r?\n$/, '')) ? F.parseTsv(s) : null; };

/** One grid cell. Enter moves to the cell below (Shift+Enter above); Tab is the browser's own. */
function cell({ value, key, label, row, col, numeric = false, placeholder = '', onChange, onPaste }) {
  const i = el('input', { type: 'text', class: `fmt-cell${numeric ? ' num' : ''}`, value: value ?? '', 'aria-label': label, 'data-key': key, 'data-row': String(row), 'data-col': String(col), inputmode: numeric ? 'decimal' : null, spellcheck: 'false', autocomplete: 'off', placeholder: placeholder || null });
  i.addEventListener('change', () => onChange(i.value));
  i.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const g = i.closest('table');
    const to = g && g.querySelector(`input[data-row="${row + (e.shiftKey ? -1 : 1)}"][data-col="${col}"]`);
    if (to) { to.focus(); to.select(); } else i.blur();
  });
  i.addEventListener('paste', (e) => { const rows = pastedRows(e); if (rows && onPaste) { e.preventDefault(); onPaste(rows); } });
  return i;
}
const select = ({ label, value, options, onChange, key }) => el('select', { class: 'fmt-select', 'aria-label': label, 'data-key': key, onchange: (e) => onChange(e.target.value) },
  ...options.map(([v, l]) => el('option', { value: v, selected: v === value || null }, l)));
const textField = ({ label, value, key, max = 60, placeholder = '', onChange }) => el('input', { type: 'text', class: 'fmt-text', value: value || '', maxlength: String(max), placeholder: placeholder || null, 'aria-label': label, 'data-key': key, onchange: (e) => onChange(e.target.value) });
const check = ({ label, checked, key, onChange }) => el('label', { class: 'fmt-check' }, el('input', { type: 'checkbox', checked: checked || null, 'data-key': key, onchange: (e) => onChange(e.target.checked) }), el('span', '', label));
const hint = (s) => el('p', { class: 'fmt-hint' }, s);
const onOff = (label, on, key, onChange) => kit.row(label, kit.segmented({ label, key, value: on ? 'on' : 'off', options: [{ value: 'on', label: tx('On') }, { value: 'off', label: tx('Off') }], onChange: (v) => onChange(v === 'on') }));
const swatchesOf = (deck) => { const c = themeOf(deck).colors; return [c.accent, c.accent2, '#f5a524', '#17a673', '#e5484d', '#8e8e93', c.text, c.bg].map((v, k) => ({ value: v, label: [tx('Accent'), tx('Accent 2'), tx('Amber'), tx('Green'), tx('Red'), tx('Grey'), tx('Text'), tx('Background')][k] })); };

// ── Format › Chart ──

function chartSection(ctx) {
  const x = at(ctx);
  if (!x || !x.s.chart) return null;
  const c = x.s.chart, i = x.i;
  const set = (f, toastText) => save(ctx, (d) => (d.slides[i] && d.slides[i].chart ? F.setChart(d, i, f(d.slides[i].chart)) : d), toastText);
  const pie = PIE(c);
  // the data grid: series across, labels down; the corner takes a whole pasted table
  const head = el('tr', '', el('th', { scope: 'col' }, cell({ value: '', key: 'chart:corner', label: tx('Paste a whole table here'), row: -1, col: -1, placeholder: tx('Paste'), onChange: () => {}, onPaste: (rows) => set((ch) => F.chartPaste(ch, rows, -1, -1), tx('Chart data pasted')) })),
    ...c.series.map((s, j) => el('th', { scope: 'col' }, cell({ value: s.name, key: `chart:s${j}`, label: `${tx('Series')} ${j + 1} ${tx('name')}`, row: -1, col: j, onChange: (v) => set((ch) => F.chartSetCell(ch, -1, j, v)), onPaste: (rows) => set((ch) => F.chartPaste(ch, rows, -1, j)) }))),
    el('th', { class: 'fmt-tools', 'aria-hidden': 'true' }));
  const tools = c.series.length > 1 ? el('tr', { class: 'fmt-coltools' }, el('td'), ...c.series.map((s, j) => el('td', '', kit.iconButton({ icon: 'trash', label: `${tx('Remove series')} ${s.name || j + 1}`, key: `chart:rms${j}`, onClick: () => set((ch) => F.chartRemoveSeries(ch, j)) }))), el('td')) : null;
  const body = c.labels.map((l, r) => el('tr', '',
    el('th', { scope: 'row' }, cell({ value: l, key: `chart:l${r}`, label: `${tx('Label')} ${r + 1}`, row: r, col: -1, onChange: (v) => set((ch) => F.chartSetCell(ch, r, -1, v)), onPaste: (rows) => set((ch) => F.chartPaste(ch, rows, r, -1)) })),
    ...c.series.map((s, j) => el('td', '', cell({ value: String(s.values[r]), key: `chart:v${r}:${j}`, label: `${l || `${tx('Row')} ${r + 1}`}, ${s.name || `${tx('Series')} ${j + 1}`}`, row: r, col: j, numeric: true, onChange: (v) => set((ch) => F.chartSetCell(ch, r, j, v)), onPaste: (rows) => set((ch) => F.chartPaste(ch, rows, r, j)) }))),
    el('td', { class: 'fmt-tools' }, c.labels.length > 1 ? kit.iconButton({ icon: 'trash', label: `${tx('Remove row')} ${l || r + 1}`, key: `chart:rmr${r}`, onClick: () => set((ch) => F.chartRemoveRow(ch, r)) }) : null)));
  const grid = el('div', { class: 'fmt-gridwrap' }, el('table', { class: 'fmt-grid', 'aria-label': tx('Chart data') }, el('thead', '', head, tools), el('tbody', '', ...body)));
  const adds = el('div', { class: 'fmt-btns' },
    kit.button({ label: tx('Row'), icon: 'plus', small: true, key: 'chart:addrow', disabled: c.labels.length >= LIMITS.labels, onClick: () => set((ch) => F.chartAddRow(ch)) }),
    kit.button({ label: tx('Series'), icon: 'plus', small: true, key: 'chart:addseries', disabled: pie || c.series.length >= LIMITS.series, onClick: () => set((ch) => F.chartAddSeries(ch)) }));
  const tc = themeOf(x.d).colors, drawn = [tc.accent, tc.accent2, '#f5a524', '#17a673', '#e5484d', '#8e8e93']; // deck-render.js palette(): a well shows the colour a series draws with until one is picked
  const names = pie ? c.labels : c.series.map((s, j) => s.name || `${tx('Series')} ${j + 1}`);
  const colours = el('div', { class: 'fmt-wells' }, ...names.slice(0, 12).map((n, j) => el('div', { class: 'fmt-well' }, kit.colorWell({ label: `${tx('Colour of')} ${n}`, key: `chart:color${j}`, value: (c.colors && c.colors[j]) || drawn[j % drawn.length], swatches: swatchesOf(x.d), allowNone: true, onChange: (v) => set((ch) => F.chartSetColor(ch, j, v)) }), el('span', '', n))));
  return el('div', { class: 'fmt-panel' },
    kit.row(tx('Type'), select({ label: tx('Chart type'), key: 'chart:type', value: c.type, options: CHART_TYPES.map((t) => [t, tx(F.CHART_LABELS[t])]), onChange: (v) => set((ch) => F.chartSetType(ch, v), pie && !PIE({ type: v }) ? '' : !pie && PIE({ type: v }) && c.series.length > 1 ? tx('A pie shows the first series (undo brings the others back)') : '') })),
    grid, adds,
    hint(tx('Paste from Excel, Numbers or Google Sheets into any cell. Tab moves between cells.')),
    el('h4', { class: 'fmt-sub' }, pie ? tx('Slice colours') : tx('Series colours')), colours,
    pie ? null : kit.row(tx('Value axis'), textField({ label: tx('Value axis title'), key: 'chart:axis', value: c.axisTitle, placeholder: tx('Title'), onChange: (v) => set((ch) => ({ ...ch, axisTitle: v })) })),
    pie ? null : kit.row(tx('Category axis'), textField({ label: tx('Category axis title'), key: 'chart:cat', value: c.catTitle, placeholder: tx('Title'), onChange: (v) => set((ch) => ({ ...ch, catTitle: v })) })),
    kit.row(tx('Unit'), textField({ label: tx('Unit'), key: 'chart:unit', value: c.unit, max: 12, placeholder: '%, $, kg…', onChange: (v) => set((ch) => ({ ...ch, unit: v })) })),
    onOff(tx('Legend'), showLegend(c), 'chart:legend', (on) => set((ch) => ({ ...ch, legend: on }))),
    onOff(pie ? tx('Percentages') : tx('Values'), pie ? c.dataLabels !== false : showValues(c), 'chart:values', (on) => set((ch) => ({ ...ch, dataLabels: on }))));
}

// ── Format › Table ──

const ALIGN_OPTS = () => [{ value: 'left', label: tx('Left'), title: tx('Align left') }, { value: 'center', label: tx('Centre'), title: tx('Centre') }, { value: 'right', label: tx('Right'), title: tx('Align right') }];

function tableSection(ctx) {
  const x = at(ctx);
  if (!x || !x.s.table) return null;
  const t = x.s.table, i = x.i;
  const set = (f, toastText) => save(ctx, (d) => (d.slides[i] && d.slides[i].table ? F.setTable(d, i, f(d.slides[i].table)) : d), toastText);
  const n = Math.max(t.header.length, ...t.rows.map((r) => r.length), 1);
  const colName = (c) => (t.header[c] || `${tx('Column')} ${c + 1}`);
  const paste = (r, c) => (rows) => set((tb) => { const p = F.tablePaste(tb, rows, r, c); if (p.dropped) setTimeout(() => ctx.toast && ctx.toast(tx(`${p.dropped} cells didn’t fit (a table holds ${LIMITS.rows} rows and ${LIMITS.cols} columns)`)), 0); return p.table; });
  const head = t.header.length ? el('tr', '', ...t.header.map((h, c) => el('th', { scope: 'col' }, cell({ value: h, key: `table:h${c}`, label: `${tx('Header')} ${c + 1}`, row: -1, col: c, onChange: (v) => set((tb) => F.tableSetCell(tb, -1, c, v)), onPaste: paste(-1, c) }))), el('th', { class: 'fmt-tools', 'aria-hidden': 'true' })) : null;
  const body = t.rows.map((row, r) => el('tr', '',
    ...Array.from({ length: n }, (_, c) => el('td', '', cell({ value: row[c] || '', key: `table:c${r}:${c}`, label: `${tx('Row')} ${r + 1}, ${colName(c)}`, row: r, col: c, onChange: (v) => set((tb) => F.tableSetCell(tb, r, c, v)), onPaste: paste(r, c) }))),
    el('td', { class: 'fmt-tools' },
      kit.iconButton({ icon: 'up', label: `${tx('Move row up')} ${r + 1}`, key: `table:up${r}`, disabled: r === 0, onClick: () => set((tb) => F.tableMoveRow(tb, r, r - 1)) }),
      kit.iconButton({ icon: 'down', label: `${tx('Move row down')} ${r + 1}`, key: `table:dn${r}`, disabled: r === t.rows.length - 1, onClick: () => set((tb) => F.tableMoveRow(tb, r, r + 1)) }),
      kit.iconButton({ icon: 'trash', label: `${tx('Remove row')} ${r + 1}`, key: `table:rm${r}`, disabled: t.rows.length + (t.header.length ? 1 : 0) <= 1, onClick: () => set((tb) => F.tableRemoveRow(tb, r)) }))));
  const grid = el('div', { class: 'fmt-gridwrap' }, el('table', { class: 'fmt-grid', 'aria-label': tx('Table cells') }, head ? el('thead', '', head) : null, el('tbody', '', ...body)));
  const columns = el('div', { class: 'fmt-cols' }, ...Array.from({ length: n }, (_, c) => el('div', { class: 'fmt-colrow' },
    el('span', { class: 'fmt-colname', title: colName(c) }, colName(c)),
    kit.segmented({ label: `${tx('Alignment of')} ${colName(c)}`, key: `table:al${c}`, value: (t.align && t.align[c]) || 'left', options: ALIGN_OPTS(), onChange: (v) => set((tb) => F.tableSetAlign(tb, c, v)) }),
    kit.button({ label: '←', small: true, quiet: true, title: `${tx('Move column left')}: ${colName(c)}`, key: `table:cl${c}`, disabled: c === 0, onClick: () => set((tb) => F.tableMoveCol(tb, c, c - 1)) }),
    kit.button({ label: '→', small: true, quiet: true, title: `${tx('Move column right')}: ${colName(c)}`, key: `table:cr${c}`, disabled: c === n - 1, onClick: () => set((tb) => F.tableMoveCol(tb, c, c + 1)) }),
    kit.iconButton({ icon: 'trash', label: `${tx('Remove column')} ${colName(c)}`, key: `table:rc${c}`, disabled: n <= 1, onClick: () => set((tb) => F.tableRemoveCol(tb, c)) }))));
  return el('div', { class: 'fmt-panel' },
    kit.row(tx('Style'), select({ label: tx('Table style'), key: 'table:style', value: t.style || 'theme', options: F.TABLE_STYLES.map((s) => [s, tx(F.TABLE_STYLE_LABELS[s])]), onChange: (v) => set((tb) => F.tableSetStyle(tb, v)) })),
    onOff(tx('Header row'), t.header.length > 0, 'table:header', (on) => set((tb) => F.tableSetHeader(tb, on))),
    grid,
    el('div', { class: 'fmt-btns' },
      kit.button({ label: tx('Row'), icon: 'plus', small: true, key: 'table:addrow', disabled: t.rows.length >= LIMITS.rows, onClick: () => set((tb) => F.tableAddRow(tb)) }),
      kit.button({ label: tx('Column'), icon: 'plus', small: true, key: 'table:addcol', disabled: n >= LIMITS.cols, onClick: () => set((tb) => F.tableAddCol(tb)) })),
    hint(tx('Click a cell on the slide to type in place; Tab moves to the next cell. Paste from a spreadsheet into any cell here.')),
    el('h4', { class: 'fmt-sub' }, tx('Columns')), columns);
}

// ── Document › Background ──

const BG_LABEL = { theme: 'Theme', color: 'Colour', gradient: 'Gradient', image: 'Picture' };
const newId = () => `bg${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** A picture file as a JPEG data URL at most 1920 px wide (backgrounds needn't be bigger) → { data, w, h }. */
async function readPicture(file) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error(tx('Choose a PNG, JPEG, GIF or WebP picture.'));
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, 1920 / img.naturalWidth, 1080 / img.naturalHeight), w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
    const cv = el('canvas', { width: String(w), height: String(h) });
    cv.getContext('2d').drawImage(img, 0, 0, w, h);
    return { data: cv.toDataURL('image/jpeg', 0.86), w, h };
  } finally { URL.revokeObjectURL(url); }
}

function backgroundSection(ctx) {
  const x = at(ctx);
  if (!x) return null;
  const i = x.i, b = x.s.background || null, kind = b ? b.kind : 'theme', th = themeOf(x.d).colors;
  const put = (bg, opts = {}, toastText = '') => save(ctx, (d) => F.setBackground(d, i, bg, opts), toastText);
  const pick = () => {
    const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true });
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      input.remove();
      if (!f) return;
      try {
        const p = await readPicture(f), id = newId();
        ctx.storeImage(id, p.data, p.w, p.h);
        put({ kind: 'image', image: id, dim: b && b.kind === 'image' ? b.dim : 0.2, blur: b && b.kind === 'image' ? b.blur : 0 }, {}, tx('Background picture added'));
      } catch (e) { if (ctx.toast) ctx.toast(e.message || tx('That picture couldn’t be read.')); }
    });
    document.body.append(input);
    input.click();
  };
  const choose = (k) => {
    if (k === kind) return;
    if (k === 'theme') put(null);
    else if (k === 'color') put({ kind: 'color', color: th.surface === th.bg ? th.accent : th.surface });
    else if (k === 'gradient') put({ kind: 'gradient', from: th.accent, to: th.accent2, angle: 135 });
    else if (k === 'image') pick();
  };
  const kids = [
    hint(`${tx('Slide')} ${i + 1}`),
    kit.segmented({ label: tx('Background'), key: 'bg:kind', value: kind, options: F.BG_KINDS.map((k) => ({ value: k, label: tx(BG_LABEL[k]) })), onChange: choose }),
  ];
  if (b && b.kind === 'color') kids.push(kit.row(tx('Colour'), kit.colorWell({ label: tx('Background colour'), key: 'bg:color', value: b.color, swatches: swatchesOf(x.d), onChange: (v) => put({ ...b, color: v }) })));
  if (b && b.kind === 'gradient') kids.push(
    kit.row(tx('From'), kit.colorWell({ label: tx('Gradient start'), key: 'bg:from', value: b.from, swatches: swatchesOf(x.d), onChange: (v) => put({ ...b, from: v }) })),
    kit.row(tx('To'), kit.colorWell({ label: tx('Gradient end'), key: 'bg:to', value: b.to, swatches: swatchesOf(x.d), onChange: (v) => put({ ...b, to: v }) })),
    kit.row(tx('Angle'), kit.stepper({ label: tx('Gradient angle'), key: 'bg:angle', value: b.angle, min: 0, max: 359, step: 15, unit: '°', onChange: (v) => put({ ...b, angle: v }) })));
  if (b && b.kind === 'image') kids.push(
    kit.button({ label: tx('Choose another picture…'), icon: 'photo', small: true, key: 'bg:pick', onClick: pick }),
    kit.row(tx('Dim'), kit.slider({ label: tx('Dim the picture'), key: 'bg:dim', value: Math.round(b.dim * 100), min: 0, max: F.BG_MAX_DIM * 100, step: 5, format: (v) => `${v}%`, onChange: (v) => put({ ...b, dim: v / 100 }) })),
    kit.row(tx('Blur'), kit.slider({ label: tx('Blur the picture'), key: 'bg:blur', value: b.blur, min: 0, max: F.BG_MAX_BLUR, step: 1, format: (v) => `${v} px`, onChange: (v) => put({ ...b, blur: v }) })));
  kids.push(el('div', { class: 'fmt-btns' },
    kit.button({ label: tx('Apply to all slides'), small: true, key: 'bg:all', onClick: () => put(b, { all: true }, tx(b ? 'Background applied to every slide' : 'Every slide uses the theme background')) }),
    x.d.slides.some((s) => s.background) ? kit.button({ label: tx('Reset all to theme'), small: true, quiet: true, key: 'bg:reset', onClick: () => put(null, { all: true }, tx('Every slide uses the theme background')) }) : null));
  return el('div', { class: 'fmt-panel' }, ...kids);
}

// ── Document › Slide numbers & footer ──

function footerSection(ctx) {
  const d = ctx.deck;
  if (!d) return null;
  const f = d.footer || { number: true, text: d.title, hideOnTitle: true }; // Eden's usual foot, as settings
  const put = (patch) => save(ctx, (dd) => F.setFooter(dd, { ...(dd.footer || { number: true, text: dd.title, hideOnTitle: true }), ...patch }));
  const today = F.footerDate(d.lang);
  return el('div', { class: 'fmt-panel' },
    check({ label: tx('Slide numbers'), key: 'ft:number', checked: !!f.number, onChange: (v) => put({ number: v }) }),
    check({ label: tx('Footer'), key: 'ft:on', checked: !!f.text, onChange: (v) => put({ text: v ? f.text || d.title : '' }) }),
    f.text ? textField({ label: tx('Footer text'), key: 'ft:text', value: f.text, max: 120, onChange: (v) => put({ text: v }) }) : null,
    check({ label: tx('Date'), key: 'ft:date', checked: !!f.date, onChange: (v) => put({ date: v }) }),
    f.date ? textField({ label: tx('Date text (empty: today’s date)'), key: 'ft:datetext', value: f.dateText || '', max: 40, placeholder: today, onChange: (v) => put({ dateText: v }) }) : null,
    check({ label: tx('Hide on title slide'), key: 'ft:hide', checked: !!f.hideOnTitle, onChange: (v) => put({ hideOnTitle: v }) }),
    d.footer ? kit.button({ label: tx('Use Eden’s usual footer'), small: true, quiet: true, key: 'ft:reset', onClick: () => save(ctx, (dd) => F.resetFooter(dd)) }) : null);
}

// ── registration (web only) ──

if (!IN_APP && typeof document !== 'undefined') {
  addStylesheet(new URL('./deck-format.css', import.meta.url).href, 'deck-format');
  registerInspector({ id: 'format-chart', tab: 'format', title: tx('Chart'), icon: 'chart', order: 25, when: isLayout('chart'), render: chartSection });
  registerInspector({ id: 'format-table', tab: 'format', title: tx('Table'), icon: 'table', order: 25, when: isLayout('table'), render: tableSection });
  registerInspector({ id: 'document-background', tab: 'document', title: tx('Background'), icon: 'photo', order: 15, when: (sel, ctx) => !!(ctx.deck && ctx.deck.slides[sel.slide]), render: backgroundSection });
  registerInspector({ id: 'document-footer', tab: 'document', title: tx('Slide numbers & footer'), icon: 'notes', order: 25, render: footerSection });
  registerContextMenu({ id: 'format-slide', target: 'slide', order: 40, items: (ctx) => {
    const d = ctx.deck, s = d && d.slides[ctx.index];
    if (!s) return [];
    const out = [];
    if (s.layout === 'chart' && s.chart) out.push({ label: tx('Edit chart data…'), icon: 'chart', run: () => ctx.openInspector('format') });
    if (s.layout === 'table' && s.table) out.push(
      { label: tx('Add row'), icon: 'plus', run: () => ctx.commit(F.setTable(live(ctx), ctx.index, F.tableAddRow(s.table))) },
      { label: tx('Add column'), icon: 'plus', run: () => ctx.commit(F.setTable(live(ctx), ctx.index, F.tableAddCol(s.table))) });
    out.push({ label: tx('Background…'), icon: 'photo', run: () => ctx.openInspector('document') });
    return out;
  } });
}

export { chartSection, tableSection, backgroundSection, footerSection }; // for the tests and a host without the shell
