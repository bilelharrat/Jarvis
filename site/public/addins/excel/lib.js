// Ask Eden for Excel: the pure helpers the task pane (taskpane.js), the cell functions
// (functions.js), the Connect pages (connect.js, connected.js) and the tests
// (site/test/excel-addin.test.js) share. A plain script: it sets globalThis.EdenExcel, so it loads
// with <script> in the pages and with vm under node --test. Nothing here touches Office, Excel or the page.
(function (root) {
  const SITE = 'https://askeden.com';
  const CLIENT = 'excel';
  const CALLBACK = '/addins/excel/connected';
  const START = '/addins/excel/connect.html';
  // The server's limits (src/eden/sheets.js SHEET, and SHEET.apps.excel for one answer): it refuses
  // more, so the pane says so first, or splits a Fill or a Clean into parts that each fit one answer.
  const LIMITS = {
    cells: 5000, chars: 60000, cellChars: 2000, rows: 1000, instruction: 2000, history: 20, historyChars: 8000, cellAnswer: 32767,
    fillRows: 200, // SHEET.apps.excel.fillRows: one Fill request
    cleanTokens: 8000, // SHEET.apps.excel.cleanTokens: one Clean request (cleanTokens() below, the server's formula)
    partChars: 45000, // one part's cell text, leaving room for the instruction and history in SHEET.chars
    parts: 8, // at most this many requests for one Fill or Clean
    inFlight: 2, // the server answers at most 2 asks at once per account
    sampleRows: 6, // Write a formula / Explain on one cell: the header row and 5 rows as a sample
  };
  // What each button sends and what comes back (the contract's ACTIONS).
  const ACTIONS = {
    ask: { out: 'text', instruction: true },
    analyze: { out: 'text', values: true },
    formula: { out: 'formula', instruction: true },
    explain: { out: 'text', formulas: true },
    fill: { out: 'lines', instruction: true, values: true },
    clean: { out: 'table', values: true, formulas: true },
    table: { out: 'table', instruction: true },
    cell: { out: 'cell', instruction: true },
  };
  const TOKEN_KEY = 'eden-excel-token';
  const CACHE_PREFIX = 'eden-fx:';
  const CACHE_INDEX = 'eden-fx-index';
  const CACHE_MAX = 500;
  const CACHE_DAYS = 30;

  // ── connecting (OAuth code + PKCE S256) ──

  const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  /** A PKCE verifier or a state: base64url of random bytes (32 bytes → 43 characters). */
  function randomCode(bytes = 32) {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return b64url(buf);
  }

  /** The S256 challenge for a verifier. */
  async function challengeOf(verifier) {
    return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  }

  const siteOf = (origin) => (/^https?:\/\/[^/]+$/.test(String(origin || '')) ? origin : SITE);

  /** Where the dialog comes back to: the pane's own site (askeden.com, or a preview Worker). */
  const redirectFor = (origin) => `${siteOf(origin)}${CALLBACK}`;

  /** The consent page's address. */
  function connectUrl({ origin, state, challenge }) {
    const site = siteOf(origin);
    const q = new URLSearchParams({ client_id: CLIENT, redirect_uri: redirectFor(site), state, code_challenge: challenge, code_challenge_method: 'S256' });
    return `${site}/eden/connect?${q}`;
  }

  /**
   * Where the Connect dialog opens: the add-in's own start page (connect.html), which loads Office.js
   * first (so the dialog keeps its link to Excel) and then goes on to the consent page.
   */
  function dialogUrl({ origin, state, challenge }) {
    return `${siteOf(origin)}${START}?${new URLSearchParams({ state, code_challenge: challenge })}`;
  }

  /** connect.html's next address, from its own query (state and challenge checked), or null. */
  function startTarget(search, origin) {
    const q = new URLSearchParams(search);
    const state = q.get('state') || '';
    const challenge = q.get('code_challenge') || '';
    if (!/^[A-Za-z0-9_-]{24,128}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return null;
    return connectUrl({ origin, state, challenge });
  }

  /** What came back to /addins/excel/connected: { code } or { error }, checked against our state. */
  function readRedirect(address, state) {
    let url;
    try {
      url = new URL(address);
    } catch {
      return { error: 'bad_redirect' };
    }
    if (url.pathname.replace(/\.html$/, '') !== CALLBACK) return { error: 'bad_redirect' };
    if (!state || url.searchParams.get('state') !== state) return { error: 'bad_state' };
    const error = url.searchParams.get('error');
    if (error) return { error: /^[a-z_]{1,40}$/.test(error) ? error : 'error' };
    const code = url.searchParams.get('code');
    return code ? { code } : { error: 'no_code' };
  }

  /** POST /api/eden/token's body. */
  const tokenBody = ({ code, verifier, origin }) => ({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: CLIENT, redirect_uri: redirectFor(origin) });

  // ── the stored token (localStorage: the pane and the cell functions share one runtime) ──

  const storageOf = (storage) => {
    if (storage) return storage;
    try {
      return root.localStorage || null;
    } catch {
      return null;
    }
  };

  function readToken(storage, now = Date.now()) {
    const s = storageOf(storage);
    if (!s) return null;
    try {
      const saved = JSON.parse(s.getItem(TOKEN_KEY) || 'null');
      if (!saved || typeof saved.token !== 'string' || !saved.token.startsWith('es1.')) return null;
      if (saved.expires && saved.expires < now) return null;
      return saved.token;
    } catch {
      return null;
    }
  }

  function saveToken(storage, answer, now = Date.now()) {
    const s = storageOf(storage);
    if (!answer || typeof answer.access_token !== 'string' || !answer.access_token.startsWith('es1.')) return false;
    const expires = Number(answer.expires_in) > 0 ? now + Number(answer.expires_in) * 1000 : 0;
    try {
      if (s) s.setItem(TOKEN_KEY, JSON.stringify({ token: answer.access_token, expires }));
    } catch {
      // storage full or blocked: the pane keeps it in memory for this session
    }
    return true;
  }

  /** Forget the stored token; with `only`, only when it is that token (a late 401 for an old token keeps a newer one). */
  function forgetToken(storage, only) {
    const s = storageOf(storage);
    try {
      if (!s) return;
      if (only) {
        const saved = JSON.parse(s.getItem(TOKEN_KEY) || 'null');
        if (saved && saved.token !== only) return;
      }
      s.removeItem(TOKEN_KEY);
    } catch {
      // nothing to forget
    }
  }

  // ── cells ──

  const cut = (text, max) => {
    const s = String(text ?? '');
    return s.length > max ? s.slice(0, max) : s;
  };

  // A number shown as a plain number (maybe with a currency sign, separators, a percent sign).
  const PLAIN_NUMBER = /^[\s(]*[-+]?[$€£¥]?\s?[\d\s,.'’]*\d[\d\s,.'’]*\s?[$€£¥%]?[)\s]*$/;

  /**
   * One cell as sent: Excel gives dates and times as serial numbers (45291), so a number shown as
   * something else (a date, a time) goes as its shown text; empty → null; an error (a cell function's
   * input) as its code ("#N/A"); text is capped.
   */
  function cellOf(value, text) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') {
      const shown = typeof text === 'string' ? text.trim() : '';
      if (shown && !/^#+$/.test(shown) && !PLAIN_NUMBER.test(shown)) return cut(shown, LIMITS.cellChars);
      return Number.isFinite(value) ? value : String(value);
    }
    if (typeof value === 'boolean') return value;
    if (typeof value === 'object') return cut(String(value.code || value.errorType || value.message || '#ERROR'), 40);
    return cut(value, LIMITS.cellChars);
  }

  /** A grid of cells (values, and their shown text when Excel gave it). */
  const gridOf = (values, text) => (values || []).map((row, r) => row.map((v, c) => cellOf(v, text && text[r] ? text[r][c] : undefined)));

  /** Each cell's kind as Excel holds it: number (dates too), boolean, text or empty. */
  const kindsOf = (values) => (values || []).map((row) => row.map((v) => (typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : v === '' || v === null || v === undefined ? 'empty' : 'text')));

  /** Whether a cell's formula (Excel's .formulas) is a formula: it starts with "=". */
  const isFormula = (f) => typeof f === 'string' && f.startsWith('=');

  /** Only the formulas (other cells empty), or null when there are none. */
  function formulaGrid(formulas) {
    let any = false;
    const out = (formulas || []).map((row) => row.map((f) => {
      if (isFormula(f)) {
        any = true;
        return cut(f, LIMITS.cellChars);
      }
      return '';
    }));
    return any ? out : null;
  }

  const cellText = (cell) => (cell === null || cell === undefined ? '' : String(cell));
  const charsOf = (grid) => (grid || []).reduce((n, row) => n + row.reduce((m, c) => m + cellText(c).length, 0), 0);
  const countOf = (grid) => (grid || []).reduce((n, row) => n + row.length, 0);
  const hasData = (grid) => (grid || []).some((row) => row.some((c) => cellText(c).trim() !== ''));
  const widthOf = (grid) => (grid || []).reduce((w, row) => Math.max(w, row.length), 0);
  const blankRow = (row) => !row || row.every((c) => cellText(c).trim() === '');

  /** The first cell longer than the server takes for Fill and Clean ([row, col]), or null; never cut, refused. */
  function longCell(values, escaped = false) {
    for (let r = 0; r < (values || []).length; r++) {
      for (let c = 0; c < values[r].length; c++) {
        const v = values[r][c];
        if (typeof v === 'string' && (escaped ? asSent(v) : v).length > LIMITS.cellChars) return [r, c];
      }
    }
    return null;
  }

  /** Whether a selection of rows × columns may be sent for this action: null, or plain words. */
  function sizeProblem(action, rows, columns, t = EN) {
    const cells = rows * columns;
    if (cells > LIMITS.cells) return t('tooManyCells', { n: t.n(cells), max: t.n(LIMITS.cells) });
    if ((action === 'fill' || action === 'clean') && rows > LIMITS.rows) return t('tooManyRows', { max: t.n(LIMITS.rows) });
    return null;
  }

  /**
   * The rows that fit the limits (for context only, e.g. a formula's surroundings): the first rows,
   * as many as fit. { values, rows, trimmed }.
   */
  function fitRows(values, { cells = LIMITS.cells, chars = LIMITS.chars / 2 } = {}) {
    const out = [];
    let n = 0;
    let c = 0;
    for (const row of values || []) {
      const len = row.reduce((m, x) => m + cellText(x).length, 0);
      if (n + row.length > cells || c + len > chars) break;
      out.push(row);
      n += row.length;
      c += len;
    }
    return { values: out, rows: out.length, trimmed: out.length < (values || []).length };
  }

  /**
   * POST /api/eden/sheet's body, within the server's limits: { body } or { error } in plain words.
   * sheet: { name, range, values, formulas } (cells already from cellOf/formulaGrid). History is kept
   * newest first within what's left of the character budget.
   */
  function sheetBody({ action, instruction, sheet, active, history, t = EN }) {
    const how = ACTIONS[action];
    if (!how) return { error: 'Unknown action.' };
    const words = cut(String(instruction || '').trim(), LIMITS.instruction);
    if (action === 'fill' && !words) return { error: t('fillFirst') };
    if (how.instruction && !words) return { error: t('typeFirst') };
    const body = { action, app: 'excel' };
    if (words) body.instruction = words;
    let chars = words.length;
    if (sheet && (sheet.values || sheet.formulas || sheet.range || sheet.name)) {
      const out = {};
      if (sheet.name) out.name = cut(sheet.name, 120);
      if (sheet.range) out.range = cut(sheet.range, 200);
      for (const key of ['values', 'formulas']) {
        const grid = sheet[key];
        if (!grid) continue;
        if (countOf(grid) > LIMITS.cells) return { error: t('tooManyCellsShort', { max: t.n(LIMITS.cells) }) };
        out[key] = grid.map((row) => row.map((c) => (c === undefined ? null : typeof c === 'string' ? cut(c, LIMITS.cellChars) : c)));
        chars += charsOf(out[key]);
      }
      if (chars > LIMITS.chars) return { error: t('tooMuchText', { max: t.n(LIMITS.chars) }) };
      if ((action === 'fill' || action === 'clean') && out.values && out.values.length > LIMITS.rows) return { error: t('tooManyRows', { max: t.n(LIMITS.rows) }) };
      body.sheet = out;
    }
    if (how.values && !(body.sheet && hasData(body.sheet.values))) return { error: action === 'fill' ? t('selectFill') : t('selectData') };
    if (active && (active.address || active.formula || active.value !== undefined)) {
      body.active = {};
      if (active.address) body.active.address = cut(active.address, 200);
      if (active.formula) body.active.formula = cut(active.formula, LIMITS.cellChars);
      if (active.value !== undefined && active.value !== null && active.value !== '') body.active.value = cut(active.value, LIMITS.cellChars);
      chars += cellText(body.active.formula).length + cellText(body.active.value).length;
    }
    if (action === 'explain' && !(body.active && body.active.formula) && !(body.sheet && body.sheet.formulas)) return { error: t('selectFormula') };
    if (history && history.length) {
      let turns = history.filter((x) => x && (x.role === 'user' || x.role === 'eden') && String(x.text || '').trim()).slice(-LIMITS.history).map((x) => ({ role: x.role, text: cut(x.text, LIMITS.historyChars) }));
      // The newest turns that still fit the request's characters.
      let keep = turns.length;
      let room = LIMITS.chars - chars;
      while (keep > 0 && room - turns[keep - 1].text.length >= 0) room -= turns[--keep].text.length;
      turns = turns.slice(keep);
      while (turns.length && turns[0].role !== 'user') turns = turns.slice(1);
      if (turns.length) body.history = turns;
    }
    return { body };
  }

  // ── Fill and Clean in parts (one answer each, as the server sizes them) ──

  const utf8 = (s) => new TextEncoder().encode(s).length;
  /** The server's clean budget (sheets.js cleanTokens): bytes ÷ 2.2, a token per cell, 200. */
  const tokensFor = (bytes, cells) => Math.ceil(bytes / 2.2) + cells + 200;
  const cleanTokens = (rows) => {
    let bytes = 0;
    let cells = 0;
    for (const row of rows) {
      for (const c of row) bytes += utf8(cellText(c));
      cells += Math.max(1, row.length);
    }
    return tokensFor(bytes, cells);
  };

  /**
   * How a Fill or a Clean of `values` splits into requests: [{ start, end }] (rows), each within one
   * answer's size, or { error } when even one row is too big or it would take too many parts.
   */
  function chunksFor(action, values, formulas, t = EN) {
    const parts = [];
    let start = 0;
    let chars = 0;
    let bytes = 0;
    let cells = 0;
    const rowSize = (r) => {
      const row = action === 'clean' ? values[r].map(asSent) : values[r];
      const f = formulas && formulas[r] ? charsOf([formulas[r]]) : 0;
      return { chars: charsOf([row]) + f, bytes: row.reduce((n, c) => n + utf8(cellText(c)), 0), cells: Math.max(1, row.length) };
    };
    const fits = (n, count) => n.chars <= LIMITS.partChars && (action === 'fill' ? count <= LIMITS.fillRows : tokensFor(n.bytes, n.cells) <= LIMITS.cleanTokens - 100);
    for (let r = 0; r < values.length; r++) {
      const s = rowSize(r);
      if (!fits(s, 1)) return { error: t('rowTooBig', { row: r + 1, action: t(action).toLowerCase() }) };
      if (r > start && !fits({ chars: chars + s.chars, bytes: bytes + s.bytes, cells: cells + s.cells }, r + 1 - start)) {
        parts.push({ start, end: r });
        start = r;
        chars = 0;
        bytes = 0;
        cells = 0;
      }
      chars += s.chars;
      bytes += s.bytes;
      cells += s.cells;
    }
    if (values.length > start) parts.push({ start, end: values.length });
    if (parts.length > LIMITS.parts) return { error: t('tooMuchAtOnce', { action: t(action).toLowerCase() }) };
    return parts;
  }

  // Clean: a line break or a tab inside a cell would break the one-row-per-line, tab-separated
  // answer, so those cells go (and come back) escaped: \n, \t and \\. Other cells go as they are.
  // (The server shows these, and U+0085, U+2028 and U+2029, as spaces: sheets.js tsvCell.)
  const BREAKS = /[\t\n\r\u0085\u2028\u2029]/;
  const escapeCell = (s) => String(s).replace(/\\/g, '\\\\').replace(/\r\n?|\n/g, '\\n').replace(/\t/g, '\\t').replace(/[\u0085\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  /** A cell as Clean sends it: escaped when it holds a break or a tab, else as it is. */
  const asSent = (c) => (typeof c === 'string' && BREAKS.test(c) ? escapeCell(c) : c);
  const unescapeCell = (s) => String(s).replace(/\\(\\|n|t|u(?:0085|2028|2029))/g, (_, ch) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === '\\' ? '\\' : String.fromCharCode(parseInt(ch.slice(1), 16))));

  /** The rows as a Clean sends them: { values, escaped } (escaped[r][c] true where the cell was escaped). */
  function cleanSend(rows) {
    return { values: rows.map((row) => row.map(asSent)), escaped: rows.map((row) => row.map((c) => typeof c === 'string' && BREAKS.test(c))) };
  }

  /** A Clean's rows back in cell form (escaped cells turned back). */
  const cleanReceive = (rows, escaped) => rows.map((row, r) => row.map((c, k) => (escaped && escaped[r] && escaped[r][k] ? unescapeCell(c) : c)));

  // ── reading answers ──

  /** The answer without a Markdown code fence around it. */
  function unfence(text) {
    const s = String(text || '').replace(/\r\n?/g, '\n');
    const m = /^\s*```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(s);
    return m ? m[1] : s;
  }

  /** The one formula in a formula answer, or null. A quote that belongs to the formula stays. */
  function formulaOf(text) {
    for (let line of unfence(text).split('\n')) {
      line = line.trim().replace(/^`+|`+$/g, '').trim();
      const wrapped = /^"(=.*)"$/.exec(line) || /^“(=.*)”$/.exec(line);
      if (wrapped) line = wrapped[1].trim();
      if (line.startsWith('=') && line.length > 1) return cut(line, 8192);
    }
    return null;
  }

  /** A fill answer's lines: one per row. Only blank lines past the row count are dropped. */
  function linesOf(text, rows) {
    let lines = unfence(text).split('\n').map((l) => l.replace(/\s+$/, ''));
    while (lines.length > rows && lines.at(-1).trim() === '') lines = lines.slice(0, -1);
    return lines;
  }

  /** A fill answer checked: { lines } when there is exactly one line per row, else { error }. */
  function fillCheck(text, rows, t = EN) {
    const lines = linesOf(text, rows);
    if (lines.length !== rows) return { error: t('fillCount', { n: lines.length, rows }) };
    if (rows > 1 && /:\s*$/.test(lines[0]) && !/:\s*$/.test(lines[1] || '')) return { error: t('fillPreamble') };
    return { lines };
  }

  /** Tab-separated rows (a Markdown table is read too, should one come back). keepBlank: keep blank lines (Clean). */
  function parseTsv(text, { keepBlank = false } = {}) {
    let lines = unfence(text).split('\n');
    if (keepBlank) {
      if (lines.length > 1 && lines.at(-1) === '') lines.pop(); // the last line's own newline
    } else {
      while (lines.length && !lines[0].trim()) lines.shift();
      while (lines.length && !lines.at(-1).trim()) lines.pop();
    }
    const piped = lines.filter((l) => l.trim()).length > 1 && !lines.some((l) => l.includes('\t')) && lines.every((l) => !l.trim() || /^\s*\|.*\|\s*$/.test(l));
    if (piped) {
      return lines
        .filter((l) => !/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l))
        .filter((l) => keepBlank || l.trim())
        .map((l) => (l.trim() ? l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()) : ['']));
    }
    return lines.map((l) => l.split('\t').map((c) => c.trim()));
  }

  /**
   * A clean answer checked against what was sent: the same rows × columns (a missing or extra
   * trailing cell is fine only when it's empty; blank rows at the start or the end may be left out
   * when the sent rows there are blank). { rows } or { error }.
   */
  function cleanCheck(text, sent, t = EN) {
    let got = parseTsv(text, { keepBlank: true });
    const width = widthOf(sent);
    if (got.length !== sent.length) {
      // Line the blank edges up: trim both, then put back the sent blank rows.
      const blank = (row) => row.every((c) => c.trim() === '');
      let a = 0;
      while (a < got.length && blank(got[a])) a++;
      let b = got.length;
      while (b > a && blank(got[b - 1])) b--;
      const core = got.slice(a, b);
      let s0 = 0;
      while (s0 < sent.length && blankRow(sent[s0])) s0++;
      let s1 = sent.length;
      while (s1 > s0 && blankRow(sent[s1 - 1])) s1--;
      if (core.length !== s1 - s0) return { error: t('cleanRows', { n: core.length + s0 + (sent.length - s1), sent: sent.length }) };
      got = [...Array.from({ length: s0 }, () => ['']), ...core, ...Array.from({ length: sent.length - s1 }, () => [''])];
    }
    const rows = [];
    for (let r = 0; r < got.length; r++) {
      const row = got[r].slice();
      while (row.length > width && row.at(-1) === '') row.pop();
      while (row.length < width && cellText(sent[r][row.length]).trim() === '') row.push('');
      if (row.length !== width) return { error: t('cleanRow', { row: r + 1, n: got[r].length, width }) };
      rows.push(row);
    }
    return { rows };
  }

  const BOOL_TRUE = /^(true|vrai|wahr|verdadero|vero|waar|verdadeiro|sant|sand|prawda|igaz|pravda)$/i;
  const BOOL_FALSE = /^(false|faux|falsch|falso|onwaar|falskt|falsk|fałsz|hamis|nepravda)$/i;
  const boolOf = (s) => (BOOL_TRUE.test(String(s).trim()) ? true : BOOL_FALSE.test(String(s).trim()) ? false : null);

  /** Whether a cleaned value is the same as the cell's: booleans by meaning, numbers by value. */
  function sameCell(from, to, kind) {
    if (cellText(from) === to) return true;
    if (kind === 'boolean' || typeof from === 'boolean') return boolOf(to) === (from === true || String(from).toLowerCase() === 'true');
    if (typeof from === 'number' && /^-?\d+(\.\d+)?$/.test(to.trim())) return Number(to) === from;
    return false;
  }

  /**
   * The cells a clean would change: [{ r, c, from, to }], never one that holds a formula, and never
   * one whose value didn't change (a trimmed space counts as a change; TRUE for true doesn't).
   */
  function cleanChanges(sent, cleaned, formulas, { kinds } = {}) {
    const out = [];
    for (let r = 0; r < sent.length; r++) {
      for (let c = 0; c < sent[r].length; c++) {
        if (formulas && isFormula(formulas[r]?.[c])) continue;
        const to = cleaned[r][c] ?? '';
        if (sameCell(sent[r][c], to, kinds && kinds[r] ? kinds[r][c] : undefined)) continue;
        out.push({ r, c, from: cellText(sent[r][c]), to });
      }
    }
    return out;
  }

  /** A table answer checked: { rows } (header first, all padded to one width) or { error }. */
  function tableCheck(text, maxCells = LIMITS.cells, t = EN) {
    const rows = parseTsv(text).filter((r) => r.some((c) => c !== ''));
    if (rows.length < 1) return { error: t('noTable') };
    const width = Math.max(...rows.map((r) => r.length));
    if (width === 1 && rows.some((r) => r[0].length >= 40 && /[.!?]$/.test(r[0]))) return { error: t('noTable') }; // prose, not a table
    if (rows.length > 1 && rows[0].length === 1 && rows.slice(1).every((r) => r.length > 1)) return { error: t('tablePreamble') };
    if (rows.some((r) => r.length > rows[0].length)) return { error: t('tableUneven') };
    if (rows.length * width > maxCells) return { error: t('tableTooBig', { n: t.n(rows.length * width) }) };
    return { rows: rows.map((r) => [...r, ...Array(width - r.length).fill('')]) };
  }

  /**
   * A value Eden wrote, as it goes into a cell: { v, asText }. asText: the cell gets the Text number
   * format ("@") first, so Excel keeps the text as written instead of reading it as a number, a date,
   * a time, a percentage, TRUE/FALSE or an error ("007", "1-2", "5%", "TRUE", "#N/A"). Text Excel would
   * read as a formula (=, +, -, @ at the start) also gets a leading apostrophe. kind: what the cell
   * held (Clean) — text stays text; a number or date cell may be read by Excel; booleans stay booleans;
   * 'auto' (Fill, a table, an empty cell): a plain number becomes a number, the rest stays text.
   */
  function cellWrite(text, kind = 'auto') {
    const s = String(text ?? '');
    if (s === '') return { v: '', asText: false };
    const plain = /^-?(0|[1-9]\d*)(\.\d+)?$/.test(s) && s.replace(/[-.]/g, '').replace(/^0+/, '').length <= 15;
    const formulaLike = /^[=+\-@\t\r]/.test(s);
    if (kind === 'boolean' && boolOf(s) !== null) return { v: boolOf(s), asText: false };
    if (kind !== 'text' && plain && Number.isFinite(Number(s))) return { v: Number(s), asText: false };
    if (kind === 'number') return { v: formulaLike || s.startsWith("'") ? `'${s}` : s, asText: false };
    const parsable = /\d/.test(s) || boolOf(s) !== null || /^\s*#/.test(s) || formulaLike;
    if (s.startsWith("'")) return { v: `'${s}`, asText: false }; // Excel takes one leading apostrophe away
    return { v: formulaLike ? `'${s}` : s, asText: parsable };
  }

  // Functions and references that reach outside the workbook: the internet, other files, other programs.
  const REACH = ['WEBSERVICE', 'IMAGE', 'HYPERLINK', 'RTD', 'CALL', 'REGISTER', 'REGISTER.ID', 'SQL.REQUEST', 'STOCKHISTORY', 'TRANSLATE', 'DETECTLANGUAGE', 'PY', 'COPILOT'];

  /** What in a formula reaches outside the workbook (function names, "external link", "DDE"); [] when nothing. */
  function reachesOut(formula) {
    const f = String(formula || '');
    const bare = f.replace(/"(?:[^"]|"")*"/g, '""'); // string literals out
    const found = [];
    for (const name of REACH) if (new RegExp(`(^|[^A-Za-z0-9_.])(_xlfn\\.)?${name.replace('.', '\\.')}\\s*\\(`, 'i').test(bare)) found.push(name);
    if (/\|/.test(bare)) found.push('DDE');
    if (/\[[^\]]*\.(xl[a-z]{1,2}|csv|ods)\]|'(?:https?:|\\\\|[A-Za-z]:\\)/i.test(bare) || /(^|[^A-Za-z0-9_\]])\[\d+\][^!]*!/.test(bare)) found.push('external link');
    return found;
  }

  /** "Sheet1!B2:D9" / "'My sheet'!B2" → { sheet, cells }. */
  function splitAddress(address) {
    const s = String(address || '');
    const at = s.lastIndexOf('!');
    if (at < 0) return { sheet: '', cells: s };
    let sheet = s.slice(0, at);
    if (/^'.*'$/.test(sheet)) sheet = sheet.slice(1, -1).replace(/''/g, "'");
    return { sheet, cells: s.slice(at + 1) };
  }

  /** "Sheet1!B2:D9" → "B2:D9", for showing. */
  const cellsOf = (address) => splitAddress(address).cells;

  /** The top-left cell of an address: { col (0-based), row (1-based) }. */
  function topLeftOf(address) {
    const m = /\$?([A-Z]{1,3})\$?(\d+)/i.exec(cellsOf(address));
    if (!m) return { col: 0, row: 1 };
    let col = 0;
    for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
    return { col: col - 1, row: Number(m[2]) };
  }
  const colName = (index) => {
    let n = index + 1;
    let letters = '';
    while (n > 0) {
      const k = (n - 1) % 26;
      letters = String.fromCharCode(65 + k) + letters;
      n = Math.floor((n - 1) / 26);
    }
    return letters;
  };
  /** The cell r rows and c columns from a top-left. */
  const cellName = (start, r, c) => `${colName(start.col + c)}${start.row + r}`;
  /** The address of `rows` × `cols` starting `r` rows below a top-left. */
  const rangeName = (start, r, rows, cols) => {
    const a = cellName(start, r, 0);
    const b = cellName(start, r + rows - 1, Math.max(1, cols) - 1);
    return a === b ? a : `${a}:${b}`;
  };

  /** Plain words for an error the server or the network gave. */
  function errorWords(status, code, message, t = EN) {
    const theirs = t.lang === 'en' && message ? message : '';
    if (code === 'not_connected' || status === 401) return { words: t('errConnect'), connect: true };
    if (code === 'no_allowance' || status === 402) return { words: theirs || t('errPlan'), plan: true };
    if (code === 'slow_down' || status === 429) return { words: t('errBusy'), retry: true };
    if (code === 'cut_off') return { words: t('errCutOff') };
    if (code === 'too_long' || status === 413) return { words: theirs || t('errTooLong') };
    if (code === 'not_set_up' || status === 503) return { words: t('errNotReady') };
    if (status === 0) return { words: t('errOffline'), retry: true };
    if (status === 403) return { words: theirs || t('errForbidden') };
    return { words: theirs || t('errGeneric'), retry: status >= 500 };
  }

  /** How long to wait after a 429: its Retry-After (seconds), else a growing wait, with jitter, at most 30 s. */
  function retryWait(header, attempt = 0, random = Math.random) {
    const secs = Number(header);
    const base = Number.isFinite(secs) && secs > 0 ? secs * 1000 : 1500 * 2 ** attempt;
    return Math.min(30_000, base + Math.floor(random() * 750));
  }

  /** A wait that a signal can end early. */
  const sleep = (ms, signal) => new Promise((done) => {
    const timer = setTimeout(done, ms);
    if (signal) signal.addEventListener('abort', () => (clearTimeout(timer), done()), { once: true });
  });

  // ── the cell function's cache ──

  /** A short, stable hash (cyrb53) as hex. */
  function hash(text) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    const s = String(text);
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  }

  /** The cache key for =EDEN.ASK(prompt, range): the prompt and the range's values. */
  function cacheKey(prompt, values) {
    const grid = Array.isArray(values) ? values.map((row) => (Array.isArray(row) ? row.map((c) => (c === undefined ? null : c)) : [row])) : values === undefined || values === null ? null : [[values]];
    return CACHE_PREFIX + hash(JSON.stringify([String(prompt || '').trim(), grid]));
  }

  /** A range without its empty rows and columns at the end (A:A → the rows with data). */
  function trimGrid(grid) {
    if (!Array.isArray(grid)) return grid;
    let rows = grid.length;
    const empty = (c) => c === null || c === undefined || c === '';
    while (rows > 0 && grid[rows - 1].every(empty)) rows--;
    let cols = 0;
    for (let r = 0; r < rows; r++) for (let c = grid[r].length - 1; c >= cols; c--) if (!empty(grid[r][c])) cols = c + 1;
    return grid.slice(0, rows).map((row) => row.slice(0, cols));
  }

  function cacheGet(storage, key, now = Date.now()) {
    const s = storageOf(storage);
    if (!s) return null;
    try {
      const hit = JSON.parse(s.getItem(key) || 'null');
      if (!hit || typeof hit.v !== 'string' || !hit.v.trim()) return null;
      if (now - Number(hit.at || 0) > CACHE_DAYS * 864e5) return null;
      return hit.v;
    } catch {
      return null;
    }
  }

  function cachePut(storage, key, value, now = Date.now()) {
    const s = storageOf(storage);
    if (!s || !String(value ?? '').trim()) return; // a blank answer is never kept
    try {
      const index = JSON.parse(s.getItem(CACHE_INDEX) || '[]').filter((k) => k !== key);
      index.push(key);
      const gone = index.splice(0, Math.max(0, index.length - CACHE_MAX));
      s.setItem(CACHE_INDEX, JSON.stringify(index)); // the index first: it never lists a key that's gone
      for (const k of gone) s.removeItem(k);
      s.setItem(key, JSON.stringify({ v: String(value), at: now }));
    } catch {
      // storage full: the in-memory cache still holds it this session
    }
  }

  /** Forget every saved cell answer; returns how many there were. */
  function cacheClear(storage) {
    const s = storageOf(storage);
    if (!s) return 0;
    let index = [];
    try {
      index = JSON.parse(s.getItem(CACHE_INDEX) || '[]');
    } catch {
      index = [];
    }
    for (const key of index) {
      try {
        s.removeItem(key);
      } catch {
        // gone
      }
    }
    try {
      s.removeItem(CACHE_INDEX);
    } catch {
      // gone
    }
    return index.length;
  }

  const cacheCount = (storage) => {
    const s = storageOf(storage);
    try {
      return s ? JSON.parse(s.getItem(CACHE_INDEX) || '[]').length : 0;
    } catch {
      return 0;
    }
  };

  /** A cell answer as it goes in a cell: one line, within Excel's 32,767 characters. */
  const cellAnswer = (text) => cut(unfence(text).replace(/\s*\n+\s*/g, ' ').trim(), LIMITS.cellAnswer);
  /** The cell's value: a plain number as a number (SUM sees it), anything else as text. */
  const cellResult = (answer) => (/^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(answer) ? Number(answer) : answer);

  // ── light Markdown, as blocks of runs (the page builds DOM nodes; never HTML) ──

  // No lookbehind (older Mac WebKit can't parse it): the character before * or _ is matched and kept.
  function runs(text) {
    const parts = [];
    const re = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`)|(^|[^\w*])(\*[^*\s][^*]*\*)(?!\w)|(^|[^\w])(_[^_\s][^_]*_)(?!\w)/g;
    let last = 0;
    for (const m of text.matchAll(re)) {
      const lead = m[2] ?? m[4] ?? '';
      const s = m[1] || m[3] || m[5];
      const at = m.index + lead.length;
      if (at > last) parts.push({ t: text.slice(last, at) });
      if (s.startsWith('**') || s.startsWith('__')) parts.push({ t: s.slice(2, -2), b: true });
      else if (s.startsWith('`')) parts.push({ t: s.slice(1, -1), code: true });
      else parts.push({ t: s.slice(1, -1), i: true });
      last = at + s.length;
    }
    if (last < text.length) parts.push({ t: text.slice(last) });
    return parts;
  }

  function blocks(text) {
    const out = [];
    for (const raw of String(text || '').split('\n')) {
      const line = raw.replace(/\s+$/, '');
      if (/^\s*```/.test(line)) continue;
      const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
      if (!line.trim()) {
        if (out.length && out.at(-1).type !== 'gap') out.push({ type: 'gap' });
        continue;
      }
      const body = bullet ? bullet[1] : line.replace(/^#{1,6}\s+/, '');
      out.push({ type: bullet ? 'li' : 'p', runs: runs(body) });
    }
    while (out.length && out.at(-1).type === 'gap') out.pop();
    return out;
  }

  // ── words (English; French when Office runs in French) ──

  const STRINGS = {
    en: {
      connectTitle: 'Connect your Eden account',
      connectLead: 'Ask Eden answers questions about the cells you select, writes and explains formulas, and fills or cleans data, on your Eden account’s included AI.',
      connect: 'Connect',
      connecting: 'Connecting…',
      disconnect: 'Disconnect',
      plan: 'See your plan',
      help: 'Help',
      more: 'More',
      selection: 'Selection',
      noSelection: 'Select some cells',
      oneBlock: 'Select one block of cells (Ask Eden can’t use a selection made of several areas).',
      ask: 'Ask',
      analyze: 'Analyze',
      formula: 'Write a formula',
      explain: 'Explain formula',
      fill: 'Fill column',
      clean: 'Clean',
      table: 'Make a table',
      placeholder: 'Ask about the selection…',
      inputLabel: 'Ask Eden',
      phFormula: 'What should the formula do? Then press Write a formula.',
      phFill: 'What goes in each row? Then press Fill column.',
      phTable: 'What table do you want? Then press Make a table.',
      empty: 'Select cells, then ask a question or press a button.',
      privacy: 'Nothing is sent until you press a button or use =EDEN.ASK. Then only: the selected cells (values, and formulas where needed), or, for Write a formula and Explain formula on one cell, that cell and the sheet’s header row with its first 5 rows; the sheet name and range; and what you type. askeden.com stores none of it.',
      copy: 'Copy',
      copied: 'Copied',
      again: 'Try again',
      stop: 'Stop',
      clear: 'New chat',
      cellsTitle: '=EDEN.ASK in cells',
      cellsHelp: 'Type =EDEN.ASK("your question", A2:C10) in any cell. Answers are saved, so recalculating doesn’t ask again (or use your included AI again) unless the question or the cells change.',
      cellsCount: 'Cell answers this session: {n} of {cap}.',
      cellsSaved: 'Saved answers: {n}.',
      cellsMore: 'Allow {n} more',
      cellsClear: 'Forget saved answers',
      forgot: 'Saved answers forgotten: {n}.',
      cancelled: 'Connecting was cancelled.',
      connected: 'Connected. Select cells and ask away.',
      disconnected: 'Disconnected from Eden.',
      starting: 'Starting…',
      gettingReady: 'Getting ready… press Connect again in a moment.',
      openInExcel: 'Open Ask Eden inside Excel to use it.',
      openInExcelShort: 'Open in Excel',
      openInExcelConnect: 'Open Ask Eden inside Excel to connect.',
      finishSignIn: 'Finish the sign-in window that’s already open (or close it), then press Connect again.',
      popupBlocked: 'Excel blocked the sign-in window. Allow pop-ups for Ask Eden and press Connect again.',
      cantOpenSignIn: 'Couldn’t open the sign-in window. Press Connect again.',
      cantLoadSignIn: 'Couldn’t load the sign-in page. Check your connection and press Connect again.',
      signInClosed: 'The sign-in window closed. Press Connect again.',
      connectUnfinished: 'Connecting didn’t finish. Press Connect again.',
      connectExpired: 'The sign-in took too long. Press Connect again.',
      cantRead: 'Excel couldn’t read the selection{why}. Try again.',
      cantWrite: 'Excel couldn’t write that{why}. Nothing more was changed.',
      partWritten: 'Excel stopped after {n} of {m} cells{why}. The first {n} were changed; the others weren’t.',
      sheetGone: 'That sheet isn’t there any more. Run the action again.',
      sheetProtected: 'This sheet is protected. Unprotect it (Review › Unprotect Sheet), then press again.',
      stopped: 'Stopped.',
      stoppedNothing: 'Stopped. Nothing was changed.',
      tryAgainShort: 'Try again.',
      tooSlow: 'Eden took too long to answer. Nothing was changed.',
      brokeOff: 'The answer broke off (the connection dropped or the answer was too long). Nothing was changed.',
      answering: 'Eden is answering…',
      answered: 'Eden answered.',
      previewReady: 'Check the preview, then use the button under it to write it into the sheet.',
      progress: 'Working in parts: {done} of {n} done…',
      partOf: 'Part {i} of {n}:',
      hiddenFirst: 'The selection has {n} hidden or filtered rows or columns. They’ll be sent too (and Fill and Clean write to them). Press {button} again to go ahead, or select only what you want.',
      hiddenIncluded: 'Includes {n} hidden or filtered rows or columns.',
      noFormula: 'Eden didn’t answer with a formula. Try again, or say more about what it should do.',
      nothingToClean: 'Nothing to clean: the selection already looks consistent.',
      risky: 'Careful: this formula reaches outside the workbook ({names}). It can send cell data to a website or open another file or program. Insert it only if you expected that.',
      insertIn: 'Insert in {at}',
      insertAnyway: 'Insert anyway in {at}',
      fillAt: 'Fill {at}',
      replaceClean: 'Replace with cleaned data',
      insertTableAt: 'Insert table at {at}',
      insertWord: 'Insert',
      fillWord: 'Fill',
      notEmptyFormula: '{at} isn’t empty. Press Insert again to replace it.',
      notEmpty: '{at} isn’t empty ({n} filled). Press {button} again to replace what’s there.',
      insertedIn: 'Inserted in {at}.',
      insertedAt: 'Inserted at {at}.',
      filled: 'Filled {at}.',
      replaced: 'Cells replaced: {n}.',
      replacedKept: 'Cells replaced: {n} (formulas left as they were).',
      selectionChanged: 'The selection changed. Run Fill column again.',
      rowsChanged: 'The rows changed since Eden read them. Run Fill column again.',
      cellsChanged: 'The cells changed since Eden read them. Press Clean again.',
      valuesFor: '{n} values for {at}:',
      cellsChange: 'Cells that change in {at}: {n}.',
      andMore: '…and {n} more',
      andMoreRows: '…and {n} more rows',
      tableSize: '{r} rows × {c} columns:',
      fillWhere: 'Select the rows with data. Eden writes into the column to their right (or select an empty column next to your data).',
      fillEmptyLeft: 'The rows next to that column are empty. Select the rows with data first.',
      cellTooLong: 'Cell {cell} is too long to {action} (at most {n} characters). Leave it out of the selection.',
      tooManyCells: 'That’s {n} cells. Select at most {max} cells and try again.',
      tooManyCellsShort: 'Select at most {max} cells and try again.',
      tooManyRows: 'Select at most {max} rows for this.',
      tooMuchText: 'That’s too much text to send at once (at most {max} characters). Select fewer cells.',
      tooMuchAtOnce: 'That’s too much to {action} at once. Select fewer rows or columns.',
      rowTooBig: 'Row {row} of the selection is too long to {action} in one go. Select fewer columns.',
      typeFirst: 'Type what you want first.',
      fillFirst: 'Type what to write in each row first (for example “the country of each city”).',
      selectFill: 'Select the rows to fill (cells with data), then try again.',
      selectData: 'Select some cells with data first.',
      selectFormula: 'Select a cell with a formula first.',
      fillCount: 'Eden wrote {n} lines for {rows} rows, so nothing was written. Try again.',
      fillPreamble: 'Eden added a line before the answers, so they didn’t line up with the rows. Nothing was written. Try again.',
      cleanRows: 'Eden gave back {n} rows for {sent}, so nothing was changed. Try again.',
      cleanRow: 'Row {row} came back with {n} cells instead of {width}, so nothing was changed. Try again.',
      noTable: 'Eden didn’t send back a table. Try again, or say more about what it should hold.',
      tablePreamble: 'Eden added a line before the table. Try again.',
      tableUneven: 'The table’s rows don’t line up with its header. Try again.',
      tableTooBig: 'That table is too big to insert ({n} cells).',
      errConnect: 'Connect Ask Eden to your Eden account to continue.',
      errPlan: 'No included AI is left on your Eden account.',
      errBusy: 'Eden is busy with your other asks. Wait a moment and try again.',
      errCutOff: 'The answer was too long and was cut off. Select less and try again.',
      errTooLong: 'That’s too much to send at once. Select fewer cells.',
      errNotReady: 'Ask Eden isn’t ready on askeden.com yet. Try again later.',
      errOffline: 'Can’t reach askeden.com. Check your connection and try again.',
      errForbidden: 'This Eden account can’t use Ask Eden yet.',
      errGeneric: 'Something went wrong. Try again.',
      cfType: 'Type a question first, e.g. =EDEN.ASK("Which month sold most?", A1:B13).',
      cfConnect: 'Connect Ask Eden first: on the Home tab press Ask Eden, then Connect.',
      cfTooBig: 'Use a smaller range: at most {max} cells with data.',
      cfPaused: 'Ask Eden paused after {cap} cell answers this session, to save your included AI. Press “Allow more” in the Ask Eden pane.',
      cfBroke: 'The answer broke off. Edit the cell (or press Ctrl+Alt+F9) to ask again.',
      cfSlow: 'Eden took too long. Edit the cell (or press Ctrl+Alt+F9) to ask again.',
      cfEmpty: 'Eden gave no answer. Try a clearer question.',
      cfPlan: 'See your plan at askeden.com/account.',
      landingConnecting: 'Connecting Ask Eden…',
      landingWait: 'One moment…',
      landingConnected: 'Connected',
      landingBack: 'You can close this window and go back to Excel.',
      landingNot: 'Not connected',
      landingAlmost: 'Almost there',
      landingOpen: 'Go back to Excel. If Ask Eden doesn’t show Connected in a few seconds, press Connect there again. You can close this window.',
      landingBad: 'This sign-in link isn’t complete. In Excel, press Connect in Ask Eden again.',
    },
    fr: {
      connectTitle: 'Connectez votre compte Eden',
      connectLead: 'Ask Eden répond à vos questions sur les cellules sélectionnées, écrit et explique des formules, remplit ou nettoie des données, avec l’IA incluse de votre compte Eden.',
      connect: 'Connecter',
      connecting: 'Connexion…',
      disconnect: 'Déconnecter',
      plan: 'Voir votre forfait',
      help: 'Aide',
      more: 'Plus',
      selection: 'Sélection',
      noSelection: 'Sélectionnez des cellules',
      oneBlock: 'Sélectionnez un seul bloc de cellules (Ask Eden ne peut pas utiliser une sélection en plusieurs zones).',
      ask: 'Demander',
      analyze: 'Analyser',
      formula: 'Écrire une formule',
      explain: 'Expliquer la formule',
      fill: 'Remplir la colonne',
      clean: 'Nettoyer',
      table: 'Créer un tableau',
      placeholder: 'Une question sur la sélection…',
      inputLabel: 'Demander à Eden',
      phFormula: 'Que doit faire la formule ? Puis appuyez sur Écrire une formule.',
      phFill: 'Que mettre dans chaque ligne ? Puis appuyez sur Remplir la colonne.',
      phTable: 'Quel tableau voulez-vous ? Puis appuyez sur Créer un tableau.',
      empty: 'Sélectionnez des cellules, puis posez une question ou appuyez sur un bouton.',
      privacy: 'Rien n’est envoyé avant que vous appuyiez sur un bouton ou utilisiez =EDEN.ASK. Ensuite, seulement : les cellules sélectionnées (valeurs, et formules si nécessaire) ou, pour Écrire une formule et Expliquer la formule sur une seule cellule, cette cellule et la ligne d’en-tête de la feuille avec ses 5 premières lignes ; le nom de la feuille et la plage ; et ce que vous tapez. askeden.com n’en conserve rien.',
      copy: 'Copier',
      copied: 'Copié',
      again: 'Réessayer',
      stop: 'Arrêter',
      clear: 'Nouvelle discussion',
      cellsTitle: '=EDEN.ASK dans les cellules',
      cellsHelp: 'Tapez =EDEN.ASK("votre question"; A2:C10) dans une cellule. Les réponses sont gardées : un recalcul ne redemande pas (et n’utilise pas à nouveau votre IA incluse) sauf si la question ou les cellules changent.',
      cellsCount: 'Réponses de cellules cette session : {n} sur {cap}.',
      cellsSaved: 'Réponses gardées : {n}.',
      cellsMore: 'En autoriser {n} de plus',
      cellsClear: 'Oublier les réponses gardées',
      forgot: 'Réponses gardées oubliées : {n}.',
      cancelled: 'La connexion a été annulée.',
      connected: 'Connecté. Sélectionnez des cellules et posez votre question.',
      disconnected: 'Déconnecté d’Eden.',
      starting: 'Démarrage…',
      gettingReady: 'Préparation… appuyez de nouveau sur Connecter dans un instant.',
      openInExcel: 'Ouvrez Ask Eden dans Excel pour l’utiliser.',
      openInExcelShort: 'Ouvrir dans Excel',
      openInExcelConnect: 'Ouvrez Ask Eden dans Excel pour vous connecter.',
      finishSignIn: 'Terminez la fenêtre de connexion déjà ouverte (ou fermez-la), puis appuyez de nouveau sur Connecter.',
      popupBlocked: 'Excel a bloqué la fenêtre de connexion. Autorisez les fenêtres contextuelles pour Ask Eden et appuyez de nouveau sur Connecter.',
      cantOpenSignIn: 'Impossible d’ouvrir la fenêtre de connexion. Appuyez de nouveau sur Connecter.',
      cantLoadSignIn: 'Impossible de charger la page de connexion. Vérifiez votre connexion et appuyez de nouveau sur Connecter.',
      signInClosed: 'La fenêtre de connexion s’est fermée. Appuyez de nouveau sur Connecter.',
      connectUnfinished: 'La connexion n’a pas abouti. Appuyez de nouveau sur Connecter.',
      connectExpired: 'La connexion a pris trop de temps. Appuyez de nouveau sur Connecter.',
      cantRead: 'Excel n’a pas pu lire la sélection{why}. Réessayez.',
      cantWrite: 'Excel n’a pas pu écrire cela{why}. Rien d’autre n’a été modifié.',
      partWritten: 'Excel s’est arrêté après {n} cellules sur {m}{why}. Les {n} premières ont été modifiées, pas les autres.',
      sheetGone: 'Cette feuille n’existe plus. Relancez l’action.',
      sheetProtected: 'Cette feuille est protégée. Ôtez la protection (Révision › Ôter la protection de la feuille), puis appuyez de nouveau.',
      stopped: 'Arrêté.',
      stoppedNothing: 'Arrêté. Rien n’a été modifié.',
      tryAgainShort: 'Réessayez.',
      tooSlow: 'Eden a mis trop de temps à répondre. Rien n’a été modifié.',
      brokeOff: 'La réponse s’est interrompue (connexion coupée ou réponse trop longue). Rien n’a été modifié.',
      answering: 'Eden répond…',
      answered: 'Eden a répondu.',
      previewReady: 'Vérifiez l’aperçu, puis utilisez le bouton dessous pour l’écrire dans la feuille.',
      progress: 'Travail en plusieurs parties : {done} sur {n} terminées…',
      partOf: 'Partie {i} sur {n} :',
      hiddenFirst: 'La sélection contient {n} lignes ou colonnes masquées ou filtrées. Elles seront envoyées aussi (et Remplir et Nettoyer y écrivent). Appuyez de nouveau sur {button} pour continuer, ou sélectionnez seulement ce que vous voulez.',
      hiddenIncluded: 'Comprend {n} lignes ou colonnes masquées ou filtrées.',
      noFormula: 'Eden n’a pas répondu par une formule. Réessayez, ou précisez ce qu’elle doit faire.',
      nothingToClean: 'Rien à nettoyer : la sélection semble déjà cohérente.',
      risky: 'Attention : cette formule va au-delà du classeur ({names}). Elle peut envoyer des données à un site web ou ouvrir un autre fichier ou programme. Ne l’insérez que si vous vous y attendiez.',
      insertIn: 'Insérer en {at}',
      insertAnyway: 'Insérer quand même en {at}',
      fillAt: 'Remplir {at}',
      replaceClean: 'Remplacer par les données nettoyées',
      insertTableAt: 'Insérer le tableau en {at}',
      insertWord: 'Insérer',
      fillWord: 'Remplir',
      notEmptyFormula: '{at} n’est pas vide. Appuyez de nouveau sur Insérer pour la remplacer.',
      notEmpty: '{at} n’est pas vide ({n} remplies). Appuyez de nouveau sur {button} pour remplacer le contenu.',
      insertedIn: 'Insérée en {at}.',
      insertedAt: 'Inséré en {at}.',
      filled: '{at} rempli.',
      replaced: 'Cellules remplacées : {n}.',
      replacedKept: 'Cellules remplacées : {n} (formules laissées telles quelles).',
      selectionChanged: 'La sélection a changé. Relancez Remplir la colonne.',
      rowsChanged: 'Les lignes ont changé depuis qu’Eden les a lues. Relancez Remplir la colonne.',
      cellsChanged: 'Les cellules ont changé depuis qu’Eden les a lues. Appuyez de nouveau sur Nettoyer.',
      valuesFor: '{n} valeurs pour {at} :',
      cellsChange: 'Cellules modifiées dans {at} : {n}.',
      andMore: '…et {n} de plus',
      andMoreRows: '…et {n} lignes de plus',
      tableSize: '{r} lignes × {c} colonnes :',
      fillWhere: 'Sélectionnez les lignes avec des données. Eden écrit dans la colonne à leur droite (ou sélectionnez une colonne vide à côté de vos données).',
      fillEmptyLeft: 'Les lignes à côté de cette colonne sont vides. Sélectionnez d’abord les lignes avec des données.',
      cellTooLong: 'La cellule {cell} est trop longue pour {action} (au plus {n} caractères). Laissez-la hors de la sélection.',
      tooManyCells: 'Cela fait {n} cellules. Sélectionnez au plus {max} cellules et réessayez.',
      tooManyCellsShort: 'Sélectionnez au plus {max} cellules et réessayez.',
      tooManyRows: 'Sélectionnez au plus {max} lignes pour cela.',
      tooMuchText: 'Trop de texte à envoyer en une fois (au plus {max} caractères). Sélectionnez moins de cellules.',
      tooMuchAtOnce: 'C’est trop pour {action} en une fois. Sélectionnez moins de lignes ou de colonnes.',
      rowTooBig: 'La ligne {row} de la sélection est trop longue pour {action} en une fois. Sélectionnez moins de colonnes.',
      typeFirst: 'Tapez d’abord ce que vous voulez.',
      fillFirst: 'Tapez d’abord quoi écrire dans chaque ligne (par exemple « le pays de chaque ville »).',
      selectFill: 'Sélectionnez les lignes à remplir (des cellules avec des données), puis réessayez.',
      selectData: 'Sélectionnez d’abord des cellules avec des données.',
      selectFormula: 'Sélectionnez d’abord une cellule avec une formule.',
      fillCount: 'Eden a écrit {n} lignes pour {rows} lignes de données : rien n’a été écrit. Réessayez.',
      fillPreamble: 'Eden a ajouté une ligne avant les réponses, qui ne correspondaient donc plus aux lignes. Rien n’a été écrit. Réessayez.',
      cleanRows: 'Eden a rendu {n} lignes pour {sent} : rien n’a été modifié. Réessayez.',
      cleanRow: 'La ligne {row} est revenue avec {n} cellules au lieu de {width} : rien n’a été modifié. Réessayez.',
      noTable: 'Eden n’a pas renvoyé de tableau. Réessayez, ou précisez ce qu’il doit contenir.',
      tablePreamble: 'Eden a ajouté une ligne avant le tableau. Réessayez.',
      tableUneven: 'Les lignes du tableau ne correspondent pas à son en-tête. Réessayez.',
      tableTooBig: 'Ce tableau est trop grand pour être inséré ({n} cellules).',
      errConnect: 'Connectez Ask Eden à votre compte Eden pour continuer.',
      errPlan: 'Il ne reste plus d’IA incluse sur votre compte Eden.',
      errBusy: 'Eden est occupé par vos autres demandes. Patientez un instant et réessayez.',
      errCutOff: 'La réponse était trop longue et a été coupée. Sélectionnez moins et réessayez.',
      errTooLong: 'C’est trop à envoyer en une fois. Sélectionnez moins de cellules.',
      errNotReady: 'Ask Eden n’est pas encore prêt sur askeden.com. Réessayez plus tard.',
      errOffline: 'Impossible de joindre askeden.com. Vérifiez votre connexion et réessayez.',
      errForbidden: 'Ce compte Eden ne peut pas encore utiliser Ask Eden.',
      errGeneric: 'Un problème est survenu. Réessayez.',
      cfType: 'Tapez d’abord une question, par ex. =EDEN.ASK("Quel mois a le plus vendu ?"; A1:B13).',
      cfConnect: 'Connectez d’abord Ask Eden : dans l’onglet Accueil, appuyez sur Ask Eden, puis sur Connecter.',
      cfTooBig: 'Utilisez une plage plus petite : au plus {max} cellules avec des données.',
      cfPaused: 'Ask Eden s’est mis en pause après {cap} réponses de cellules cette session, pour économiser votre IA incluse. Appuyez sur « En autoriser plus » dans le volet Ask Eden.',
      cfBroke: 'La réponse s’est interrompue. Modifiez la cellule (ou appuyez sur Ctrl+Alt+F9) pour redemander.',
      cfSlow: 'Eden a mis trop de temps. Modifiez la cellule (ou appuyez sur Ctrl+Alt+F9) pour redemander.',
      cfEmpty: 'Eden n’a rien répondu. Essayez une question plus claire.',
      cfPlan: 'Voyez votre forfait sur askeden.com/account.',
      landingConnecting: 'Connexion d’Ask Eden…',
      landingWait: 'Un instant…',
      landingConnected: 'Connecté',
      landingBack: 'Vous pouvez fermer cette fenêtre et revenir à Excel.',
      landingNot: 'Non connecté',
      landingAlmost: 'Presque fini',
      landingOpen: 'Revenez à Excel. Si Ask Eden n’affiche pas Connecté dans quelques secondes, appuyez de nouveau sur Connecter. Vous pouvez fermer cette fenêtre.',
      landingBad: 'Ce lien de connexion est incomplet. Dans Excel, appuyez de nouveau sur Connecter dans Ask Eden.',
    },
  };

  /** The words for a language ("fr-FR" → French), English otherwise. t.lang and t.n (numbers) come with it. */
  function wordsFor(language) {
    const lang = String(language || '').toLowerCase().startsWith('fr') ? 'fr' : 'en';
    const table = STRINGS[lang];
    const t = (key, subs) => String(table[key] ?? STRINGS.en[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => (subs && subs[k] !== undefined ? subs[k] : `{${k}}`));
    t.lang = lang;
    t.n = (n) => Number(n).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-US');
    return t;
  }
  const EN = wordsFor('en');

  root.EdenExcel = {
    SITE, CLIENT, CALLBACK, START, LIMITS, ACTIONS, TOKEN_KEY, CACHE_PREFIX, STRINGS,
    randomCode, challengeOf, redirectFor, connectUrl, dialogUrl, startTarget, readRedirect, tokenBody,
    readToken, saveToken, forgetToken,
    cellOf, gridOf, kindsOf, isFormula, formulaGrid, hasData, widthOf, longCell, sizeProblem, fitRows, sheetBody,
    cleanTokens, chunksFor, cleanSend, cleanReceive,
    unfence, formulaOf, linesOf, fillCheck, parseTsv, cleanCheck, cleanChanges, tableCheck, cellWrite, reachesOut,
    splitAddress, cellsOf, topLeftOf, cellName, rangeName,
    errorWords, retryWait, sleep, hash, cacheKey, trimGrid, cacheGet, cachePut, cacheClear, cacheCount, cellAnswer, cellResult,
    blocks, wordsFor,
  };
})(globalThis);
