// Ask Eden for Excel: the pure helpers the task pane (taskpane.js), the cell functions
// (functions.js) and the tests (site/test/excel-addin.test.js) share. A plain script: it sets
// globalThis.EdenExcel, so it loads with <script> in the pane and with vm under node --test.
// Nothing here touches Office, Excel or the page.
(function (root) {
  const SITE = 'https://askeden.com';
  const CLIENT = 'excel';
  const CALLBACK = '/addins/excel/connected';
  // The server's limits (src/eden/sheets.js SHEET): it refuses more, so the pane says so first.
  const LIMITS = { cells: 5000, chars: 60000, cellChars: 2000, rows: 1000, instruction: 2000, history: 20, historyChars: 8000, cellAnswer: 32767 };
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

  /** Where the dialog comes back to: the pane's own site (askeden.com, or a preview Worker). */
  const redirectFor = (origin) => `${/^https?:\/\/[^/]+$/.test(String(origin || '')) ? origin : SITE}${CALLBACK}`;

  /** The consent page's address. */
  function connectUrl({ origin, state, challenge }) {
    const site = /^https?:\/\/[^/]+$/.test(String(origin || '')) ? origin : SITE;
    const q = new URLSearchParams({ client_id: CLIENT, redirect_uri: redirectFor(site), state, code_challenge: challenge, code_challenge_method: 'S256' });
    return `${site}/eden/connect?${q}`;
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

  function forgetToken(storage) {
    const s = storageOf(storage);
    try {
      if (s) s.removeItem(TOKEN_KEY);
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
   * something else (a date, a time) goes as its shown text; empty → null; text is capped.
   */
  function cellOf(value, text) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') {
      const shown = typeof text === 'string' ? text.trim() : '';
      if (shown && !/^#+$/.test(shown) && !PLAIN_NUMBER.test(shown)) return cut(shown, LIMITS.cellChars);
      return Number.isFinite(value) ? value : String(value);
    }
    if (typeof value === 'boolean') return value;
    return cut(value, LIMITS.cellChars);
  }

  /** A grid of cells (values, and their shown text when Excel gave it). */
  const gridOf = (values, text) => (values || []).map((row, r) => row.map((v, c) => cellOf(v, text && text[r] ? text[r][c] : undefined)));

  /** Only the formulas (other cells empty), or null when there are none. */
  function formulaGrid(formulas) {
    let any = false;
    const out = (formulas || []).map((row) => row.map((f) => {
      if (typeof f === 'string' && f.startsWith('=')) {
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
  const fmt = (n) => Number(n).toLocaleString('en-US');

  /** Whether a selection of rows × columns may be sent for this action: null, or plain words. */
  function sizeProblem(action, rows, columns) {
    const cells = rows * columns;
    if (cells > LIMITS.cells) return `That’s ${fmt(cells)} cells. Select at most ${fmt(LIMITS.cells)} cells and try again.`;
    if ((action === 'fill' || action === 'clean') && rows > LIMITS.rows) return `Select at most ${fmt(LIMITS.rows)} rows for this.`;
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
   * sheet: { name, range, values, formulas } (cells already from cellOf/formulaGrid).
   */
  function sheetBody({ action, instruction, sheet, active, history }) {
    const how = ACTIONS[action];
    if (!how) return { error: 'Unknown action.' };
    const words = cut(String(instruction || '').trim(), LIMITS.instruction);
    if (how.instruction && action !== 'fill' && !words) return { error: 'Type what you want first.' };
    if (action === 'fill' && !words) return { error: 'Type what to write in each row first (for example “the country of each city”).' };
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
        if (countOf(grid) > LIMITS.cells) return { error: `Select at most ${fmt(LIMITS.cells)} cells and try again.` };
        out[key] = grid.map((row) => row.map((c) => (c === undefined ? null : typeof c === 'string' ? cut(c, LIMITS.cellChars) : c)));
        chars += charsOf(out[key]);
      }
      if (chars > LIMITS.chars) return { error: `That’s too much text to send at once (at most ${fmt(LIMITS.chars)} characters). Select fewer cells.` };
      if ((action === 'fill' || action === 'clean') && out.values && out.values.length > LIMITS.rows) return { error: `Select at most ${fmt(LIMITS.rows)} rows for this.` };
      body.sheet = out;
    }
    if (how.values && !(body.sheet && hasData(body.sheet.values))) return { error: action === 'fill' ? 'Select the rows to fill (cells with data), then try again.' : 'Select some cells with data first.' };
    if (active && (active.address || active.formula || active.value !== undefined)) {
      body.active = {};
      if (active.address) body.active.address = cut(active.address, 200);
      if (active.formula) body.active.formula = cut(active.formula, LIMITS.cellChars);
      if (active.value !== undefined && active.value !== null && active.value !== '') body.active.value = cut(active.value, LIMITS.cellChars);
    }
    if (action === 'explain' && !(body.active && body.active.formula) && !(body.sheet && body.sheet.formulas)) return { error: 'Select a cell with a formula first.' };
    if (history && history.length) {
      let turns = history.filter((t) => t && (t.role === 'user' || t.role === 'eden') && String(t.text || '').trim()).slice(-LIMITS.history);
      while (turns.length && turns[0].role !== 'user') turns = turns.slice(1);
      if (turns.length) body.history = turns.map((t) => ({ role: t.role, text: cut(t.text, LIMITS.historyChars) }));
    }
    return { body };
  }

  // ── reading answers ──

  /** The answer without a Markdown code fence around it. */
  function unfence(text) {
    const s = String(text || '').replace(/\r\n?/g, '\n');
    const m = /^\s*```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(s);
    return m ? m[1] : s;
  }

  /** The one formula in a formula answer, or null. */
  function formulaOf(text) {
    for (let line of unfence(text).split('\n')) {
      line = line.trim().replace(/^`+|`+$/g, '').replace(/^["“]|["”]$/g, '').trim();
      if (line.startsWith('=') && line.length > 1) return cut(line, 8192);
    }
    return null;
  }

  /** A fill answer's lines: one per row. Trailing blank lines past the row count are dropped. */
  function linesOf(text, rows) {
    let lines = unfence(text).split('\n').map((l) => l.replace(/\s+$/, ''));
    if (lines.length && lines.at(-1) === '') lines = lines.slice(0, -1);
    while (lines.length > rows && lines.at(-1).trim() === '') lines = lines.slice(0, -1);
    return lines;
  }

  /** A fill answer checked: { lines } when there is exactly one line per row, else { error }. */
  function fillCheck(text, rows) {
    const lines = linesOf(text, rows);
    if (lines.length !== rows) return { error: `Eden wrote ${lines.length} ${lines.length === 1 ? 'line' : 'lines'} for ${rows} ${rows === 1 ? 'row' : 'rows'}, so nothing was written. Try again.` };
    return { lines };
  }

  /** Tab-separated rows (a Markdown table is read too, should one come back). */
  function parseTsv(text) {
    let lines = unfence(text).split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    const piped = lines.length > 1 && !lines.some((l) => l.includes('\t')) && lines.every((l) => /^\s*\|.*\|\s*$/.test(l));
    if (piped) {
      return lines
        .filter((l) => !/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l))
        .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
    }
    return lines.map((l) => l.split('\t').map((c) => c.trim()));
  }

  /**
   * A clean answer checked against what was sent: the same rows × columns (a missing or extra
   * trailing cell is fine only when it's empty). { rows } or { error }.
   */
  function cleanCheck(text, sent) {
    const got = parseTsv(text);
    const width = Math.max(0, ...sent.map((r) => r.length));
    if (got.length !== sent.length) return { error: `Eden gave back ${got.length} ${got.length === 1 ? 'row' : 'rows'} for ${sent.length}, so nothing was changed. Try again.` };
    const rows = [];
    for (let r = 0; r < got.length; r++) {
      const row = got[r].slice();
      while (row.length > width && row.at(-1) === '') row.pop();
      while (row.length < width && cellText(sent[r][row.length]).trim() === '') row.push('');
      if (row.length !== width) return { error: `Row ${r + 1} came back with ${got[r].length} cells instead of ${width}, so nothing was changed. Try again.` };
      rows.push(row);
    }
    return { rows };
  }

  /**
   * The cells a clean would change: [{ r, c, from, to }], never one that holds a formula, and never
   * one whose text didn't change (a trimmed space counts as a change).
   */
  function cleanChanges(sent, cleaned, formulas) {
    const out = [];
    for (let r = 0; r < sent.length; r++) {
      for (let c = 0; c < sent[r].length; c++) {
        if (formulas && typeof formulas[r]?.[c] === 'string' && formulas[r][c].startsWith('=')) continue;
        const from = cellText(sent[r][c]);
        const to = cleaned[r][c] ?? '';
        if (from === to) continue; // a trimmed space is a change too
        out.push({ r, c, from, to });
      }
    }
    return out;
  }

  /** A table answer checked: { rows } (header first, all padded to one width) or { error }. */
  function tableCheck(text, maxCells = LIMITS.cells) {
    const rows = parseTsv(text).filter((r) => r.some((c) => c !== ''));
    if (rows.length < 1) return { error: 'Eden didn’t send back a table. Try again, or say more about what it should hold.' };
    const width = Math.max(...rows.map((r) => r.length));
    if (rows.length * width > maxCells) return { error: `That table is too big to insert (${fmt(rows.length * width)} cells).` };
    return { rows: rows.map((r) => [...r, ...Array(width - r.length).fill('')]) };
  }

  /**
   * A value Eden wrote, as it goes into a cell: text that Excel would read as a formula (=, +, -, @
   * at the start, other than a plain number) gets a leading apostrophe, so it stays text; a plain
   * number goes as a number.
   */
  function safeCell(text) {
    const s = String(text ?? '');
    if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s.trim()) && !/^0\d/.test(s.trim()) && s.trim().length < 16) return Number(s.trim());
    if (/^[=+\-@\t\r]/.test(s)) return `'${s}`;
    return s;
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

  /** Plain words for an error the server or the network gave. */
  function errorWords(status, code, message) {
    if (code === 'not_connected' || status === 401) return { words: 'Connect Ask Eden to your Eden account to continue.', connect: true };
    if (code === 'no_allowance' || status === 402) return { words: message || 'No included AI is left on your Eden account.', plan: true };
    if (code === 'slow_down' || status === 429) return { words: 'You’re asking quickly. Wait a moment and try again.', retry: true };
    if (code === 'too_long' || status === 413) return { words: message || 'That’s too much to send at once. Select fewer cells.' };
    if (code === 'not_set_up' || status === 503) return { words: 'Ask Eden isn’t ready on askeden.com yet. Try again later.' };
    if (status === 0) return { words: 'Can’t reach askeden.com. Check your connection and try again.', retry: true };
    if (status === 403) return { words: message || 'This Eden account can’t use Ask Eden yet.' };
    return { words: message || 'Something went wrong. Try again.', retry: status >= 500 };
  }

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

  function cacheGet(storage, key, now = Date.now()) {
    const s = storageOf(storage);
    if (!s) return null;
    try {
      const hit = JSON.parse(s.getItem(key) || 'null');
      if (!hit || typeof hit.v !== 'string') return null;
      if (now - Number(hit.at || 0) > CACHE_DAYS * 864e5) return null;
      return hit.v;
    } catch {
      return null;
    }
  }

  function cachePut(storage, key, value, now = Date.now()) {
    const s = storageOf(storage);
    if (!s) return;
    try {
      const index = JSON.parse(s.getItem(CACHE_INDEX) || '[]').filter((k) => k !== key);
      index.push(key);
      while (index.length > CACHE_MAX) s.removeItem(index.shift());
      s.setItem(key, JSON.stringify({ v: String(value), at: now }));
      s.setItem(CACHE_INDEX, JSON.stringify(index));
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

  // ── light Markdown, as blocks of runs (the page builds DOM nodes; never HTML) ──

  function runs(text) {
    const parts = [];
    const re = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|(?<![\w*])\*[^*\s][^*]*\*(?!\w)|(?<!\w)_[^_\s][^_]*_(?!\w))/g;
    let last = 0;
    for (const m of text.matchAll(re)) {
      if (m.index > last) parts.push({ t: text.slice(last, m.index) });
      const s = m[0];
      if (s.startsWith('**') || s.startsWith('__')) parts.push({ t: s.slice(2, -2), b: true });
      else if (s.startsWith('`')) parts.push({ t: s.slice(1, -1), code: true });
      else parts.push({ t: s.slice(1, -1), i: true });
      last = m.index + s.length;
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
      selection: 'Selection',
      noSelection: 'Select some cells',
      ask: 'Ask',
      analyze: 'Analyze',
      formula: 'Write a formula',
      explain: 'Explain formula',
      fill: 'Fill column',
      clean: 'Clean',
      table: 'Make a table',
      placeholder: 'Ask about the selection…',
      phFormula: 'What should the formula do? Then press Write a formula.',
      phFill: 'What goes in each row? Then press Fill column.',
      phTable: 'What table do you want? Then press Make a table.',
      empty: 'Select cells, then ask a question or press a button.',
      privacy: 'Nothing is sent until you press a button or use =EDEN.ASK. Then only the selected cells (values, and formulas where needed), the sheet name and range, and what you type. askeden.com stores none of it.',
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
      cancelled: 'Connecting was cancelled.',
      connected: 'Connected. Select cells and ask away.',
      disconnected: 'Disconnected from Eden.',
    },
    fr: {
      connectTitle: 'Connectez votre compte Eden',
      connectLead: 'Ask Eden répond à vos questions sur les cellules sélectionnées, écrit et explique des formules, remplit ou nettoie des données, avec l’IA incluse de votre compte Eden.',
      connect: 'Connecter',
      connecting: 'Connexion…',
      disconnect: 'Déconnecter',
      plan: 'Voir votre forfait',
      help: 'Aide',
      selection: 'Sélection',
      noSelection: 'Sélectionnez des cellules',
      ask: 'Demander',
      analyze: 'Analyser',
      formula: 'Écrire une formule',
      explain: 'Expliquer la formule',
      fill: 'Remplir la colonne',
      clean: 'Nettoyer',
      table: 'Créer un tableau',
      placeholder: 'Une question sur la sélection…',
      phFormula: 'Que doit faire la formule ? Puis appuyez sur Écrire une formule.',
      phFill: 'Que mettre dans chaque ligne ? Puis appuyez sur Remplir la colonne.',
      phTable: 'Quel tableau voulez-vous ? Puis appuyez sur Créer un tableau.',
      empty: 'Sélectionnez des cellules, puis posez une question ou appuyez sur un bouton.',
      privacy: 'Rien n’est envoyé avant que vous appuyiez sur un bouton ou utilisiez =EDEN.ASK. Ensuite, seulement les cellules sélectionnées (valeurs, et formules si nécessaire), le nom de la feuille et la plage, et ce que vous tapez. askeden.com n’en conserve rien.',
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
      cancelled: 'La connexion a été annulée.',
      connected: 'Connecté. Sélectionnez des cellules et posez votre question.',
      disconnected: 'Déconnecté d’Eden.',
    },
  };

  /** The words for a language ("fr-FR" → French), English otherwise. */
  function wordsFor(language) {
    const lang = String(language || '').toLowerCase().startsWith('fr') ? 'fr' : 'en';
    const table = STRINGS[lang];
    return (key, subs) => String(table[key] ?? STRINGS.en[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => (subs && subs[k] !== undefined ? subs[k] : `{${k}}`));
  }

  root.EdenExcel = {
    SITE, CLIENT, CALLBACK, LIMITS, ACTIONS, TOKEN_KEY, CACHE_PREFIX, STRINGS,
    randomCode, challengeOf, redirectFor, connectUrl, readRedirect, tokenBody,
    readToken, saveToken, forgetToken,
    cellOf, gridOf, formulaGrid, hasData, sizeProblem, fitRows, sheetBody,
    unfence, formulaOf, linesOf, fillCheck, parseTsv, cleanCheck, cleanChanges, tableCheck, safeCell, splitAddress, cellsOf,
    errorWords, hash, cacheKey, cacheGet, cachePut, cacheClear, cacheCount, cellAnswer,
    blocks, wordsFor,
  };
})(globalThis);
