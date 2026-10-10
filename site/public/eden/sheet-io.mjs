// Spreadsheet files in and out of the canvas (ROADMAP Q15): .xlsx read and written with ExcelJS
// (sheet-exceljs.mjs, MIT), legacy .xls read with SheetJS CE (sheet-xls.mjs, Apache-2.0), .csv/.tsv
// by sheet-model.mjs. The libraries are passed in (`libs`), so the page loads them only when a file
// is opened and the tests use the same files.
//
// What survives a round trip: sheets (names, order), values, formulas (with their last values),
// number formats, bold/italic/underline, font and fill colours, horizontal alignment, column widths,
// frozen header rows. When the original file's bytes are given (`base`), Eden writes its changes into
// that workbook, so what ExcelJS keeps but the canvas doesn't model (merged cells, borders, fonts,
// data validation, conditional formats, defined names, other sheets' settings) stays too. Lost either
// way: Excel's own charts, pivot tables, macros and images (ExcelJS doesn't carry them); charts made in
// Eden are added as pictures when the page passes their PNGs.

import { a1, parseA1, newSheet, newWorkbook, sheetFromCsv, sheetToCsv, extent, valueOf, isDateFormat } from './sheet-model.mjs';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const KINDS = { xlsx: 'xlsx', xlsm: 'xlsx', xls: 'xls', csv: 'csv', tsv: 'csv', txt: 'csv' };
export const kindOf = (name) => KINDS[String(name || '').toLowerCase().split('.').pop()] || null;

const EPOCH = Date.UTC(1899, 11, 30);
const dateSerial = (d) => (d.getTime() - EPOCH) / 864e5; // ExcelJS and SheetJS dates are UTC
const argb = (c) => (c && typeof c.argb === 'string' && /^[0-9A-F]{8}$/i.test(c.argb) ? `#${c.argb.slice(2).toLowerCase()}` : undefined);
const toArgb = (hex) => ({ argb: `FF${hex.slice(1).toUpperCase()}` });
const PX_PER_CHAR = 7;

/** Bytes (ArrayBuffer/Uint8Array) of `name` → a workbook. libs: { ExcelJS, XLSX }. */
export async function readWorkbook(bytes, name, libs) {
  const kind = kindOf(name);
  if (!kind) throw new Error('Eden opens .xlsx, .xls and .csv spreadsheets.');
  const size = bytes.byteLength ?? bytes.length;
  if (size > MAX_FILE_BYTES) throw new Error(`That file is over ${MAX_FILE_BYTES / 1048576} MB.`);
  const title = String(name).replace(/\.[^.]+$/, '') || 'Spreadsheet';
  if (kind === 'csv') {
    const text = new TextDecoder().decode(bytes);
    return { title, sheets: [sheetFromCsv(text, title.slice(0, 31) || 'Sheet1')], format: 'csv' };
  }
  if (kind === 'xls') return { ...readXls(bytes, libs.XLSX), title, format: 'xls' };
  return { ...(await readXlsx(bytes, libs.ExcelJS)), title, format: 'xlsx' };
}

async function readXlsx(bytes, ExcelJS) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); }
  catch (e) { throw new Error(`That doesn’t open as an Excel workbook (${String(e.message || e).slice(0, 80)}).`); }
  const sheets = [];
  wb.eachSheet((ws) => {
    if (ws.state === 'veryHidden') return;
    const s = newSheet(ws.name);
    s.orig = ws.name;
    if (ws.state === 'hidden') s.hidden = true;
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      row.eachCell({ includeEmpty: false }, (cell, c) => {
        const out = cellFromExcel(cell, ExcelJS);
        if (out) s.cells[a1(r, c)] = Object.freeze(out);
      });
    });
    for (let c = 1; c <= Math.min(ws.columnCount || 0, 200); c++) {
      const w = ws.getColumn(c).width;
      if (w && Math.abs(w - 9.140625) > 0.5 && Math.abs(w - 8.43) > 0.5) s.widths[c] = Math.round(w * PX_PER_CHAR + 5);
    }
    const v = (ws.views || [])[0];
    if (v && v.state === 'frozen' && v.ySplit) s.freeze = Math.min(10, v.ySplit);
    sheets.push(s);
  });
  if (!sheets.length) sheets.push(newSheet('Sheet1'));
  return { sheets };
}

function cellFromExcel(cell, ExcelJS) {
  const T = ExcelJS.ValueType;
  const out = { v: null };
  let v = cell.value;
  if (cell.type === T.Formula || (v && typeof v === 'object' && ('formula' in v || 'sharedFormula' in v))) {
    const f = cell.formula || (v && v.formula);
    if (f) out.f = `=${f}`;
    v = cell.result !== undefined ? cell.result : v && v.result;
  }
  if (v instanceof Date) v = dateSerial(v);
  else if (v && typeof v === 'object') {
    if (Array.isArray(v.richText)) v = v.richText.map((x) => x.text).join('');
    else if ('text' in v) v = typeof v.text === 'string' ? v.text : Array.isArray(v.text && v.text.richText) ? v.text.richText.map((x) => x.text).join('') : String(v.text ?? '');
    else if ('error' in v) v = String(v.error);
    else v = null;
  }
  if (v !== undefined && v !== null && v !== '') out.v = v;
  const z = cell.numFmt;
  if (z && z !== 'General') out.z = z;
  const s = {};
  const font = cell.font || {};
  if (font.bold) s.b = true;
  if (font.italic) s.i = true;
  if (font.underline) s.u = true;
  const color = argb(font.color);
  if (color && color !== '#000000') s.color = color;
  const fill = cell.fill;
  if (fill && fill.type === 'pattern' && fill.pattern === 'solid') { const fc = argb(fill.fgColor); if (fc && fc !== '#ffffff') s.fill = fc; }
  const h = cell.alignment && cell.alignment.horizontal;
  if (h === 'left' || h === 'center' || h === 'right') s.align = h;
  if (Object.keys(s).length) out.s = s;
  if (out.v === null && !out.f && !out.z && !out.s) return null;
  return out;
}

function readXls(bytes, XLSX) {
  let book;
  try { book = XLSX.read(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), { type: 'array', cellFormula: true, cellNF: true, cellDates: false, cellStyles: false, dense: false }); }
  catch (e) { throw new Error(`That doesn’t open as an Excel workbook (${String(e.message || e).slice(0, 80)}).`); }
  const sheets = [];
  for (const name of book.SheetNames) {
    const ws = book.Sheets[name];
    const s = newSheet(name.slice(0, 31));
    s.orig = name;
    for (const [addr, c] of Object.entries(ws)) {
      if (addr.startsWith('!') || !parseA1(addr)) continue;
      const out = { v: c.t === 'e' ? c.w || '#VALUE!' : c.t === 'd' ? dateSerial(c.v) : c.v ?? null };
      if (c.f) out.f = `=${c.f}`;
      if (c.z && c.z !== 'General') out.z = String(c.z);
      if (out.v === '' ) out.v = null;
      if (out.v !== null || out.f) s.cells[addr] = Object.freeze(out);
    }
    for (const [i, col] of (ws['!cols'] || []).entries()) if (col && col.wpx) s.widths[i + 1] = Math.round(col.wpx);
    sheets.push(s);
  }
  if (!sheets.length) sheets.push(newSheet('Sheet1'));
  return { sheets };
}

/**
 * The workbook as .xlsx bytes (Uint8Array). calc: recalc()'s values (written as each formula's
 * last value, so Excel and previews show them before recalculating). opts.base: the original
 * file's bytes (changes are written into it). opts.images: [{ sheet, png: Uint8Array|base64, col, row, width, height }].
 */
export async function writeXlsx(wb, calc, libs, opts = {}) {
  const ExcelJS = libs.ExcelJS;
  const book = new ExcelJS.Workbook();
  if (opts.base) {
    try { await book.xlsx.load(opts.base instanceof ArrayBuffer ? opts.base : opts.base.buffer.slice(opts.base.byteOffset, opts.base.byteOffset + opts.base.byteLength)); } catch { /* not a workbook: start fresh */ }
  }
  book.creator = book.creator || 'Eden';
  book.modified = opts.now ? opts.now() : new Date();
  // sheets: keep (and rename) the ones still here, drop the rest, add new ones, in the canvas's order
  const keep = new Map();
  for (const s of wb.sheets) {
    const ws = s.orig ? book.getWorksheet(s.orig) : null;
    if (ws) keep.set(s, ws);
  }
  for (const ws of book.worksheets.slice()) if (![...keep.values()].includes(ws)) book.removeWorksheet(ws.id);
  wb.sheets.forEach((s, i) => {
    let ws = keep.get(s);
    if (!ws) { ws = book.addWorksheet(s.name); keep.set(s, ws); }
    else if (ws.name !== s.name) ws.name = s.name;
    ws.orderNo = i;
    writeSheet(ws, s, calc);
  });
  for (const img of opts.images || []) {
    const ws = keep.get(wb.sheets.find((s) => s.name === img.sheet));
    if (!ws) continue;
    const id = book.addImage(typeof img.png === 'string' ? { base64: img.png, extension: 'png' } : { buffer: img.png, extension: 'png' });
    ws.addImage(id, { tl: { col: img.col, row: img.row }, ext: { width: img.width, height: img.height } });
  }
  const out = await book.xlsx.writeBuffer();
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}

function writeSheet(ws, s, calc) {
  // clear what the canvas no longer has
  const seen = new Set(Object.keys(s.cells));
  ws.eachRow({ includeEmpty: false }, (row, r) => row.eachCell({ includeEmpty: false }, (cell, c) => {
    if (!seen.has(a1(r, c))) { cell.value = null; if (cell.numFmt) cell.numFmt = undefined; }
  }));
  for (const [addr, cell] of Object.entries(s.cells)) {
    const p = parseA1(addr);
    const xc = ws.getCell(p.row, p.col);
    if (cell.f) {
      const res = valueOf(s, addr, calc);
      const result = res instanceof Error ? (res.message === '#CIRC!' ? 0 : { error: res.message }) : res === null ? undefined : res;
      xc.value = { formula: cell.f.replace(/^=/, ''), ...(result !== undefined ? { result } : {}) };
    } else xc.value = cell.v === undefined ? null : cell.v;
    if (cell.z) xc.numFmt = cell.z;
    else if (xc.numFmt && xc.numFmt !== 'General') xc.numFmt = 'General';
    const st = cell.s || {};
    const font = { ...(xc.font || {}) };
    let changed = false;
    for (const [k, key] of [['b', 'bold'], ['i', 'italic'], ['u', 'underline']]) {
      const want = !!st[k];
      if (!!font[key] !== want) { if (want) font[key] = true; else delete font[key]; changed = true; }
    }
    const fc = argb(font.color);
    if ((st.color || undefined) !== (fc && fc !== '#000000' ? fc : undefined)) { if (st.color) font.color = toArgb(st.color); else delete font.color; changed = true; }
    if (changed) xc.font = font;
    const fill = xc.fill && xc.fill.type === 'pattern' && xc.fill.pattern === 'solid' ? argb(xc.fill.fgColor) : undefined;
    if ((st.fill || undefined) !== (fill && fill !== '#ffffff' ? fill : undefined)) xc.fill = st.fill ? { type: 'pattern', pattern: 'solid', fgColor: toArgb(st.fill) } : { type: 'pattern', pattern: 'none' };
    const h = xc.alignment && xc.alignment.horizontal;
    if ((st.align || undefined) !== (['left', 'center', 'right'].includes(h) ? h : undefined)) xc.alignment = { ...(xc.alignment || {}), horizontal: st.align || undefined };
  }
  for (const [c, px] of Object.entries(s.widths || {})) ws.getColumn(Number(c)).width = Math.max(2, Math.round(((px - 5) / PX_PER_CHAR) * 100) / 100);
  if (s.freeze) ws.views = [{ state: 'frozen', ySplit: s.freeze, xSplit: 0, topLeftCell: a1(s.freeze + 1, 1) }];
  else if ((ws.views || []).some((v) => v.state === 'frozen')) ws.views = [{ state: 'normal' }];
}

/** The active sheet as CSV bytes. */
export function writeCsv(wb, calc, active = 0) {
  return new TextEncoder().encode(sheetToCsv(wb.sheets[active] || wb.sheets[0], calc));
}

/** A one-line description of what a file holds, for the open toast. */
export function describeWorkbook(wb) {
  let cells = 0, formulas = 0;
  for (const s of wb.sheets) for (const c of Object.values(s.cells)) { cells++; if (c.f) formulas++; }
  const dates = wb.sheets.some((s) => Object.values(s.cells).some((c) => c.z && isDateFormat(c.z)));
  return `${wb.sheets.length} sheet${wb.sheets.length === 1 ? '' : 's'} · ${cells.toLocaleString('en')} cells · ${formulas.toLocaleString('en')} formula${formulas === 1 ? '' : 's'}${dates ? ' · dates' : ''}`;
}

export { newWorkbook, extent };
