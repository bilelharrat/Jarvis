// The spreadsheet canvas's formula engine (ROADMAP Q15): Eden's own small parser and evaluator for
// Excel formulas, with the worksheet functions from formula.js (sheet-formulajs.mjs, MIT, vendored).
// Nothing here runs code: a formula is parsed into a tree and evaluated by walking it. There are no
// network, file or macro functions (formula.js has none, and IMPORT*/WEBSERVICE/IMAGE don't exist here),
// so a formula someone else wrote (an uploaded file, a model's suggestion) can only compute.
//
// HyperFormula was the obvious engine, but it is GPL-3.0 or a paid licence: not for a closed product.
// fast-formula-parser (MIT) was tried and dropped: MAX, MIN, MATCH, COUNTIFS, SUMIFS… are unimplemented.
//
// Values: number, string, boolean, null (an empty cell), Error (an Excel error: message '#DIV/0!' …),
// and 2-D arrays for ranges. Dates are Excel serial numbers (days since 1899-12-30).
// Not supported (shown as #NAME?): INDIRECT, OFFSET, and functions formula.js lacks; dynamic arrays
// don't spill (a formula shows its top-left value).

export const ERRORS = ['#DIV/0!', '#N/A', '#NAME?', '#NULL!', '#NUM!', '#REF!', '#VALUE!', '#CIRC!', '#SPILL!', '#CALC!'];
export const err = (code) => { const e = new Error(code); e.excel = true; return e; };
export const isErr = (v) => v instanceof Error;

// ── A1 addresses ──

/** 1 → A, 27 → AA (1-based). */
export function colName(c) {
  let s = '';
  for (let n = c; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
/** A → 1, AA → 27 (case-insensitive), 0 when not letters. */
export function colIndex(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) { const k = ch.charCodeAt(0) - 64; if (k < 1 || k > 26) return 0; n = n * 26 + k; }
  return n;
}
export const MAX_ROWS = 1_048_576;
export const MAX_COLS = 16_384;
export const a1 = (row, col) => `${colName(col)}${row}`;
/** "B12" → { row: 12, col: 2 }, or null. */
export function parseA1(s) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(String(s || '').trim());
  if (!m) return null;
  const col = colIndex(m[1]), row = Number(m[2]);
  return row >= 1 && row <= MAX_ROWS && col >= 1 && col <= MAX_COLS ? { row, col } : null;
}
/** "A1:C3" or "B2" → { r1, c1, r2, c2 } (ordered), or null. */
export function parseRange(s) {
  const [a, b] = String(s || '').trim().split(':');
  const p = parseA1(a), q = b === undefined ? p : parseA1(b);
  if (!p || !q) return null;
  return { r1: Math.min(p.row, q.row), c1: Math.min(p.col, q.col), r2: Math.max(p.row, q.row), c2: Math.max(p.col, q.col) };
}
export const rangeText = ({ r1, c1, r2, c2 }) => (r1 === r2 && c1 === c2 ? a1(r1, c1) : `${a1(r1, c1)}:${a1(r2, c2)}`);
/** A sheet name as a formula writes it: quoted when it isn't a plain word. */
export const sheetRef = (name) => (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !parseA1(name) ? name : `'${String(name).replace(/'/g, "''")}'`);

// ── dates ──

const EPOCH = Date.UTC(1899, 11, 30);
/** A JS Date (its local wall time, as formula.js makes them) → an Excel serial number. */
export function dateToSerial(d) {
  const t = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
  return (t - EPOCH) / 864e5;
}
/** An Excel serial → { y, m, d, H, M, S } (UTC parts, no time zone involved). */
export function serialParts(n) {
  const t = new Date(EPOCH + Math.round(n * 864e5));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), H: t.getUTCHours(), M: t.getUTCMinutes(), S: t.getUTCSeconds(), wd: t.getUTCDay() };
}
export const ymdSerial = (y, m, d) => (Date.UTC(y, m - 1, d) - EPOCH) / 864e5;

// ── tokens ──

const ERR_RE = /^#(DIV\/0!|N\/A|NAME\?|NULL!|NUM!|REF!|VALUE!|CIRC!|SPILL!|CALC!)/i;
const SHEET_RE = /^(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!/;
const CELL = '(\\$?)([A-Za-z]{1,3})(\\$?)(\\d{1,7})';
const CELL_RE = new RegExp(`^${CELL}(?::${CELL})?(?![A-Za-z0-9_(.])`);
const COLS_RE = /^(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9_(])/;
const ROWS_RE = /^(\$?)(\d{1,7}):(\$?)(\d{1,7})(?![\d.])/;
const NUM_RE = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i;

function refToken(src, i, sheet) {
  const rest = src.slice(i);
  let m = CELL_RE.exec(rest);
  if (m) {
    const a = { row: Number(m[4]), col: colIndex(m[2]), ar: !!m[3], ac: !!m[1] };
    const b = m[5] !== undefined ? { row: Number(m[8]), col: colIndex(m[6]), ar: !!m[7], ac: !!m[5] } : null;
    if (a.col && a.row >= 1 && (!b || (b.col && b.row >= 1))) return { t: 'ref', sheet, a, b, len: m[0].length };
  }
  m = COLS_RE.exec(rest);
  if (m && colIndex(m[2]) && colIndex(m[4])) return { t: 'ref', sheet, a: { row: 1, col: colIndex(m[2]), ar: true, ac: !!m[1], whole: 'col' }, b: { row: MAX_ROWS, col: colIndex(m[4]), ar: true, ac: !!m[3], whole: 'col' }, len: m[0].length };
  m = ROWS_RE.exec(rest);
  if (m) return { t: 'ref', sheet, a: { row: Number(m[2]), col: 1, ar: !!m[1], ac: true, whole: 'row' }, b: { row: Number(m[4]), col: MAX_COLS, ar: !!m[3], ac: true, whole: 'row' }, len: m[0].length };
  return null;
}

/** The formula (without its "=") as tokens, each with its source span [s, e). Throws on a stray character. */
export function tokenize(src) {
  const out = [];
  let i = 0;
  const s = String(src);
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    const start = i;
    const push = (tok, len) => { out.push({ ...tok, s: start, e: start + len }); i = start + len; };
    if (c === '"') {
      let j = i + 1, v = '';
      for (;;) {
        if (j >= s.length) throw err('#NAME?');
        if (s[j] === '"') { if (s[j + 1] === '"') { v += '"'; j += 2; continue; } break; }
        v += s[j++];
      }
      push({ t: 'str', v }, j + 1 - i); continue;
    }
    if (c === '#') { const m = ERR_RE.exec(s.slice(i)); if (!m) throw err('#NAME?'); push({ t: 'err', v: m[0].toUpperCase() }, m[0].length); continue; }
    // a sheet-qualified reference
    const sm = SHEET_RE.exec(s.slice(i));
    if (sm) {
      const sheet = sm[1] !== undefined ? sm[1].replace(/''/g, "'") : sm[2];
      const r = refToken(s, i + sm[0].length, sheet);
      if (!r) throw err('#REF!');
      push(r, sm[0].length + r.len); continue;
    }
    if (/[A-Za-z$0-9]/.test(c)) {
      const r = refToken(s, i, null);
      // "1:2" is rows, but a plain number is a number
      if (r && !(r.a.whole === 'row' && /[\d.]/.test(s[i + r.len] || ''))) { push(r, r.len); continue; }
    }
    if (/[\d.]/.test(c)) { const m = NUM_RE.exec(s.slice(i)); if (m) { push({ t: 'num', v: Number(m[0]) }, m[0].length); continue; } }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(s.slice(i));
      const word = m[0];
      const after = s.slice(i + word.length).match(/^\s*\(/);
      if (after) { push({ t: 'fn', v: word.toUpperCase() }, word.length); continue; }
      if (/^(TRUE|FALSE)$/i.test(word)) { push({ t: 'bool', v: word.toUpperCase() === 'TRUE' }, word.length); continue; }
      push({ t: 'name', v: word }, word.length); continue;
    }
    const two = s.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>') { push({ t: 'op', v: two }, 2); continue; }
    if ('+-*/^&=<>%'.includes(c)) { push({ t: 'op', v: c }, 1); continue; }
    if ('(),;{}'.includes(c)) { push({ t: c }, 1); continue; }
    throw err('#NAME?');
  }
  return out;
}

// ── the parser: Excel's precedence (: , - % ^ */ +- & comparisons) ──

const CMP = new Set(['=', '<>', '<', '>', '<=', '>=']);
export function parse(src) {
  const toks = tokenize(String(src).replace(/^=/, ''));
  let p = 0;
  const peek = () => toks[p];
  const take = (t, v) => { const k = toks[p]; if (!k || k.t !== t || (v !== undefined && k.v !== v)) throw err('#NAME?'); p++; return k; };
  const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;
  function comparison() {
    let l = concat();
    while (peek() && peek().t === 'op' && CMP.has(peek().v)) { const op = toks[p++].v; l = { k: 'bin', op, l, r: concat() }; }
    return l;
  }
  function concat() { let l = additive(); while (isOp('&')) { p++; l = { k: 'bin', op: '&', l, r: additive() }; } return l; }
  function additive() { let l = mult(); while (isOp('+') || isOp('-')) { const op = toks[p++].v; l = { k: 'bin', op, l, r: mult() }; } return l; }
  function mult() { let l = power(); while (isOp('*') || isOp('/')) { const op = toks[p++].v; l = { k: 'bin', op, l, r: power() }; } return l; }
  function power() { let l = percent(); while (isOp('^')) { p++; l = { k: 'bin', op: '^', l, r: percent() }; } return l; }
  function percent() { let x = unary(); while (isOp('%')) { p++; x = { k: 'pct', x }; } return x; }
  function unary() {
    if (isOp('-')) { p++; return { k: 'neg', x: unary() }; }
    if (isOp('+')) { p++; return unary(); }
    return primary();
  }
  function primary() {
    const k = peek();
    if (!k) throw err('#NAME?');
    p++;
    if (k.t === 'num') return { k: 'val', v: k.v };
    if (k.t === 'str') return { k: 'val', v: k.v };
    if (k.t === 'bool') return { k: 'val', v: k.v };
    if (k.t === 'err') return { k: 'val', v: err(k.v) };
    if (k.t === 'ref') return { k: 'ref', sheet: k.sheet, a: k.a, b: k.b };
    if (k.t === 'name') return { k: 'name', v: k.v };
    if (k.t === '(') { const x = comparison(); take(')'); return x; }
    if (k.t === '{') {
      const rows = [[]];
      for (;;) {
        const x = unary();
        if (x.k !== 'val') throw err('#VALUE!');
        rows.at(-1).push(x.v);
        if (peek() && peek().t === ',') { p++; continue; }
        if (peek() && peek().t === ';') { p++; rows.push([]); continue; }
        take('}'); break;
      }
      return { k: 'val', v: rows };
    }
    if (k.t === 'fn') {
      take('(');
      const args = [];
      if (peek() && peek().t === ')') { p++; return { k: 'fn', name: k.v, args }; }
      for (;;) {
        // an empty argument: IF(A1,,1)
        if (peek() && (peek().t === ',' || peek().t === ')')) args.push({ k: 'val', v: null });
        else args.push(comparison());
        if (peek() && peek().t === ',') { p++; continue; }
        take(')'); break;
      }
      return { k: 'fn', name: k.v, args };
    }
    throw err('#NAME?');
  }
  const tree = comparison();
  if (p !== toks.length) throw err('#NAME?');
  return tree;
}

// ── values ──

const flat = (v) => (Array.isArray(v) ? v.flat(Infinity) : [v]);
export function toNum(v) {
  if (Array.isArray(v)) v = v[0] && Array.isArray(v[0]) ? v[0][0] : v[0];
  if (v instanceof Error) return v;
  if (v === null || v === undefined || v === '') return v === '' ? err('#VALUE!') : 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const s = String(v).trim();
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?%?$/i.test(s)) return s.endsWith('%') ? Number(s.slice(0, -1)) / 100 : Number(s);
  return err('#VALUE!');
}
/** A value as text the way Excel's & joins it. */
export function toText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return generalNumber(v);
  return String(v);
}
export function generalNumber(n) {
  if (!Number.isFinite(n)) return '#NUM!';
  if (Number.isInteger(n)) return String(n);
  const a = Math.abs(n);
  if (a >= 1e11 || a < 1e-9) return n.toExponential(5).replace(/\.?0+e/, 'E').replace('E+', 'E+');
  return String(Number(n.toPrecision(10)));
}
const rank = (v) => (typeof v === 'number' ? 1 : typeof v === 'string' ? 2 : typeof v === 'boolean' ? 3 : 0);
function compare(a, b) {
  if (a === null || a === undefined) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
  if (b === null || b === undefined) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (typeof a === 'string') { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
  return a < b ? -1 : a > b ? 1 : 0;
}
/** Element-wise over arrays (as Excel does inside SUMPRODUCT and array formulas). */
function lift(a, b, f) {
  const A = Array.isArray(a), B = Array.isArray(b);
  if (!A && !B) return f(a, b);
  const rows = Math.max(A ? a.length : 1, B ? b.length : 1);
  const cols = Math.max(A ? a[0].length : 1, B ? b[0].length : 1);
  const at = (x, isA, r, c) => (isA ? (x[r] ?? x[0])[c] ?? (x[r] ?? x[0])[0] : x);
  return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => f(at(a, A, r, c), at(b, B, r, c))));
}
function binary(op, a, b) {
  return lift(a, b, (x, y) => {
    if (op === '&') { if (x instanceof Error) return x; if (y instanceof Error) return y; return toText(x) + toText(y); }
    if (CMP.has(op)) {
      if (x instanceof Error) return x; if (y instanceof Error) return y;
      const c = compare(x, y);
      return op === '=' ? c === 0 : op === '<>' ? c !== 0 : op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
    }
    const m = toNum(x === '' ? 0 : x), n = toNum(y === '' ? 0 : y);
    if (m instanceof Error) return m; if (n instanceof Error) return n;
    let r;
    if (op === '+') r = m + n; else if (op === '-') r = m - n; else if (op === '*') r = m * n;
    else if (op === '/') { if (n === 0) return err('#DIV/0!'); r = m / n; } else r = Math.pow(m, n);
    return Number.isFinite(r) ? r : err('#NUM!');
  });
}

/** What a function result means here: dates become serials, NaN and ±∞ #NUM!, undefined 0. */
function normal(v) {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? dateToSerial(v) : err('#VALUE!');
  if (v instanceof Error) return v.excel ? v : err(ERRORS.includes(v.message) ? v.message : '#VALUE!');
  if (typeof v === 'number') return Number.isFinite(v) ? v : err('#NUM!');
  if (Array.isArray(v)) return v.map((row) => (Array.isArray(row) ? row.map(normal) : normal(row)));
  if (v === undefined) return 0;
  return v;
}

// ── evaluating ──

/**
 * ctx: { sheet: the formula's sheet name, row, col, cell(sheet, row, col) → value,
 *        range(sheet, r1, c1, r2, c2) → 2-D array, fns: formula.js's module, names?: Map }
 */
export function evaluate(node, ctx) {
  switch (node.k) {
    case 'val': return node.v;
    case 'neg': { const v = evaluate(node.x, ctx); return lift(v, null, (x) => { const n = toNum(x); return n instanceof Error ? n : -n; }); }
    case 'pct': { const v = evaluate(node.x, ctx); return lift(v, null, (x) => { const n = toNum(x); return n instanceof Error ? n : n / 100; }); }
    case 'bin': return binary(node.op, evaluate(node.l, ctx), evaluate(node.r, ctx));
    case 'ref': return refValue(node, ctx);
    case 'name': {
      const n = ctx.names && ctx.names.get(node.v.toUpperCase());
      return n ? evaluate(n, ctx) : err('#NAME?');
    }
    case 'fn': return call(node, ctx);
    default: return err('#VALUE!');
  }
}

function refValue(node, ctx) {
  const sheet = node.sheet ?? ctx.sheet;
  if (!node.b) return ctx.cell(sheet, node.a.row, node.a.col);
  return ctx.range(sheet, Math.min(node.a.row, node.b.row), Math.min(node.a.col, node.b.col), Math.max(node.a.row, node.b.row), Math.max(node.a.col, node.b.col));
}

const LAZY = { IF: true, IFERROR: true, IFNA: true, IFS: true };
const NATIVE = {
  ROW: (args, ctx) => (args[0] ? (args[0].k === 'ref' ? args[0].a.row : err('#VALUE!')) : ctx.row),
  COLUMN: (args, ctx) => (args[0] ? (args[0].k === 'ref' ? args[0].a.col : err('#VALUE!')) : ctx.col),
  ROWS: (args, ctx) => { const v = evaluate(args[0], ctx); return Array.isArray(v) ? v.length : 1; },
  COLUMNS: (args, ctx) => { const v = evaluate(args[0], ctx); return Array.isArray(v) ? (v[0] || []).length : 1; },
  IF: (args, ctx) => {
    const c = evaluate(args[0], ctx);
    if (c instanceof Error) return c;
    const t = typeof c === 'string' ? (/^true$/i.test(c) ? true : /^false$/i.test(c) ? false : err('#VALUE!')) : toNum(c);
    if (t instanceof Error) return t;
    return t ? (args[1] ? evaluate(args[1], ctx) : true) : args[2] ? evaluate(args[2], ctx) : false;
  },
  IFERROR: (args, ctx) => { const v = evaluate(args[0], ctx); return v instanceof Error ? evaluate(args[1], ctx) : v; },
  IFNA: (args, ctx) => { const v = evaluate(args[0], ctx); return v instanceof Error && v.message === '#N/A' ? evaluate(args[1], ctx) : v; },
  IFS: (args, ctx) => {
    for (let i = 0; i + 1 < args.length; i += 2) { const c = toNum(evaluate(args[i], ctx)); if (c instanceof Error) return c; if (c) return evaluate(args[i + 1], ctx); }
    return err('#N/A');
  },
  XLOOKUP: (args, ctx) => {
    const [want, look, ret, notFound, mode] = args.map((a) => (a ? evaluate(a, ctx) : undefined));
    const keys = flat(look), vals = Array.isArray(ret) ? ret : [[ret]];
    const exactNext = toNum(mode ?? 0);
    let at = keys.findIndex((k) => compare(k, want) === 0 && !(k instanceof Error));
    if (at < 0 && (exactNext === -1 || exactNext === 1)) {
      let best = -1;
      keys.forEach((k, i) => { if (typeof k !== typeof want) return; const c = compare(k, want); if ((exactNext === -1 && c < 0 && (best < 0 || compare(k, keys[best]) > 0)) || (exactNext === 1 && c > 0 && (best < 0 || compare(k, keys[best]) < 0))) best = i; });
      at = best;
    }
    if (at < 0) return notFound !== undefined && notFound !== null ? notFound : err('#N/A');
    const vertical = Array.isArray(look) && look.length > 1;
    return vertical ? (vals[at] ? (vals[at].length > 1 ? [vals[at]] : vals[at][0]) : err('#REF!')) : vals.length > 1 ? vals.map((r) => [r[at]]) : (vals[0] ?? [])[at] ?? err('#REF!');
  },
  TODAY: (_, ctx) => Math.floor(dateToSerial(ctx.now ? ctx.now() : new Date())),
  NOW: (_, ctx) => dateToSerial(ctx.now ? ctx.now() : new Date()),
  // no references built from text, and nothing that reaches outside the workbook
  INDIRECT: () => err('#NAME?'),
  OFFSET: () => err('#NAME?'),
};

function call(node, ctx) {
  const name = node.name;
  if (NATIVE[name]) return NATIVE[name](node.args, ctx);
  const fn = lookup(ctx.fns, name);
  if (typeof fn !== 'function') return err('#NAME?');
  const args = node.args.map((a) => {
    const v = evaluate(a, ctx);
    return v;
  });
  let out;
  try { out = fn(...args); } catch { return err('#VALUE!'); }
  return normal(out);
}
function lookup(fns, name) {
  if (!fns) return undefined;
  const own = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
  if (!name.includes('.')) return own(fns, name);
  const [a, ...rest] = name.split('.');
  let f = own(fns, a);
  for (const k of rest) f = f && own(f, k);
  return f ?? own(fns, name.replace(/\./g, ''));
}
/** Whether a function name is known (used to flag #NAME? before evaluating). */
export const knownFunction = (fns, name) => !!NATIVE[name] || typeof lookup(fns, name) === 'function';

/** A top-level result: a 2-D array shows its top-left value (no spilling). */
export function scalar(v) {
  while (Array.isArray(v)) v = v.length ? v[0] : null;
  return v === undefined ? null : v;
}

// ── references inside a formula: moving them (fill), listing them, comparing shapes ──

function refText(t, a, b) {
  const one = (x, whole) => (whole === 'col' ? `${x.ac ? '$' : ''}${colName(x.col)}` : whole === 'row' ? `${x.ar ? '$' : ''}${x.row}` : `${x.ac ? '$' : ''}${colName(x.col)}${x.ar ? '$' : ''}${x.row}`);
  const pre = t.sheet !== null && t.sheet !== undefined ? `${sheetRef(t.sheet)}!` : '';
  return pre + one(a, a.whole) + (b ? `:${one(b, b.whole)}` : '');
}

/**
 * The formula with its relative references moved by (dr, dc), as Excel does when a formula is
 * filled or copied. A reference pushed off the sheet becomes #REF!. Strings are left alone.
 */
export function shiftFormula(formula, dr, dc) {
  const f = String(formula);
  const body = f.replace(/^=/, '');
  let toks;
  try { toks = tokenize(body); } catch { return f; }
  let out = '', at = 0;
  for (const t of toks) {
    if (t.t !== 'ref') continue;
    const mv = (x) => ({ ...x, row: x.whole === 'col' || x.ar ? x.row : x.row + dr, col: x.whole === 'row' || x.ac ? x.col : x.col + dc });
    const a = mv(t.a), b = t.b ? mv(t.b) : null;
    const bad = [a, b].some((x) => x && (x.row < 1 || x.col < 1 || x.row > MAX_ROWS || x.col > MAX_COLS));
    out += body.slice(at, t.s) + (bad ? '#REF!' : refText(t, a, b));
    at = t.e;
  }
  return (f.startsWith('=') ? '=' : '') + out + body.slice(at);
}

/** The references a formula reads: [{ sheet|null, r1, c1, r2, c2 }]. */
export function refsIn(formula) {
  let toks;
  try { toks = tokenize(String(formula).replace(/^=/, '')); } catch { return []; }
  return toks.filter((t) => t.t === 'ref').map((t) => {
    const b = t.b || t.a;
    return { sheet: t.sheet, r1: Math.min(t.a.row, b.row), c1: Math.min(t.a.col, b.col), r2: Math.max(t.a.row, b.row), c2: Math.max(t.a.col, b.col) };
  });
}

/** The formula with references written relative to (row, col) (R1C1-like): equal for "the same formula" down a column. */
export function shapeOf(formula, row, col) {
  const body = String(formula).replace(/^=/, '');
  let toks;
  try { toks = tokenize(body); } catch { return body; }
  let out = '', at = 0;
  const one = (x) => `${x.whole === 'col' ? '' : x.ar ? `R${x.row}` : `R[${x.row - row}]`}${x.whole === 'row' ? '' : x.ac ? `C${x.col}` : `C[${x.col - col}]`}`;
  for (const t of toks) {
    if (t.t !== 'ref') continue;
    out += body.slice(at, t.s).toUpperCase() + (t.sheet ? `${t.sheet}!` : '') + one(t.a) + (t.b ? `:${one(t.b)}` : '');
    at = t.e;
  }
  return (out + body.slice(at).toUpperCase()).replace(/\s+/g, '');
}

/** The functions a formula calls (upper case). */
export function functionsIn(formula) {
  try { return tokenize(String(formula).replace(/^=/, '')).filter((t) => t.t === 'fn').map((t) => t.v); } catch { return []; }
}
