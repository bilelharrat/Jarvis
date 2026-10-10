// Ask Eden for Excel: the =EDEN.ASK(prompt, [range]) cell function. It runs in the add-in's shared
// runtime (the task pane's page, manifest.xml), so it uses the token the pane saved and the pane can
// show how many answers it asked for. Answers are cached by (prompt + the range's values), in memory
// and in localStorage, so a recalculation doesn't ask (or bill the included AI) again; a blank answer
// or an error is never kept, and Disconnect forgets them all. At most PARALLEL asks run at once (the
// server answers 2 at a time per account), the rest wait their turn; "busy" (429) waits its
// Retry-After; an ask that takes too long ends with an error and frees its place. At most `cap`
// answers per session until the person allows more in the pane; an ask that fails gives its place back.
(function (root) {
  const X = root.EdenExcel;
  const PARALLEL = 2;
  const SESSION_CAP = 100;
  const RETRIES = 3; // after "busy" (429) or a network hiccup (0, 502)
  const timing = { timeoutMs: 90_000, readMs: 3000 }; // one try, request to last byte; reading the range's shown text (tests shorten them)

  const memory = new Map(); // cache key → answer
  const inFlight = new Map(); // cache key → promise (the same cell asked twice while waiting)
  const waiting = [];
  const listeners = new Set();
  let running = 0;
  let used = 0;
  let cap = SESSION_CAP;
  let paused = 0; // asks refused at the cap since the last "Allow more"
  let needConnect = 0; // asks that failed for want of a connection (the pane recalculates them after Connect)

  const words = () => X.wordsFor((root.Office && root.Office.context && root.Office.context.displayLanguage) || (root.navigator && root.navigator.language));
  const state = () => ({ used, cap, paused, needConnect, saved: X.cacheCount(), running, queued: waiting.length });
  const changed = () => {
    for (const fn of listeners) {
      try {
        fn(state());
      } catch {
        // a listener's own problem
      }
    }
  };

  /** An error Excel shows in the cell (#N/A, #VALUE!), with its message on hover. */
  function fail(message, kind = 'notAvailable') {
    const CF = root.CustomFunctions;
    if (CF && CF.Error && CF.ErrorCode) return new CF.Error(CF.ErrorCode[kind] || CF.ErrorCode.notAvailable, String(message).slice(0, 255));
    return new Error(message);
  }

  async function slot(job) {
    if (running >= PARALLEL) await new Promise((go) => waiting.push(go));
    running += 1;
    try {
      return await job();
    } finally {
      running -= 1;
      const next = waiting.shift();
      if (next) next();
    }
  }

  /** One ask, retried after "busy" (its Retry-After) or a hiccup; each try within timing.timeoutMs. → { text } or { status, info } or { broken } / { timeout }. */
  async function post(token, body) {
    for (let attempt = 0; ; attempt++) {
      const abort = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, timing.timeoutMs);
      try {
        let res;
        try {
          res = await fetch('/api/eden/sheet', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-eden-buffer': '1' }, body: JSON.stringify(body), signal: abort.signal });
        } catch {
          if (timedOut) return { timeout: true };
          res = null;
        }
        const status = res ? res.status : 0;
        if ((status === 0 || status === 429 || status === 502) && attempt < RETRIES) {
          clearTimeout(timer);
          await X.sleep(X.retryWait(res && res.headers.get('retry-after'), attempt));
          continue;
        }
        if (!res) return { status: 0, info: {} };
        if (!res.ok) {
          let info = {};
          try {
            info = await res.json();
          } catch {
            info = {};
          }
          return { status, info };
        }
        try {
          // Buffered (x-eden-buffer): the whole answer once it's complete, or a JSON error (413 cut_off, 504 too_slow).
          return { text: await res.text(), cut: res.headers.get('x-eden-answer') === 'cut' };
        } catch {
          // the stream errored: cut off, or the connection dropped (never a partial answer)
          return timedOut ? { timeout: true } : { broken: true };
        }
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /**
   * The range as sent: its trailing empty rows and columns trimmed (A:A → the rows with data); dates
   * as they're shown when Excel can say (the cell's address and its text), else as Excel's serials.
   */
  async function rangeCells(grid, address) {
    if (!address || !root.Excel || typeof root.Excel.run !== 'function') return grid;
    let timer = 0;
    try {
      const read = root.Excel.run(async (context) => {
        const { sheet, cells } = X.splitAddress(address);
        const ws = sheet ? context.workbook.worksheets.getItem(sheet) : context.workbook.worksheets.getActiveWorksheet();
        const part = ws.getRange(cells).getCell(0, 0).getResizedRange(grid.length - 1, Math.max(1, X.widthOf(grid)) - 1);
        part.load('values,text');
        await context.sync();
        return X.gridOf(part.values, part.text);
      });
      // Excel busy calculating: don't hold the cell up; the values (dates as serials) will do.
      const late = new Promise((done) => (timer = setTimeout(done, timing.readMs, null)));
      const shown = await Promise.race([read, late]);
      return Array.isArray(shown) && shown.length === grid.length ? shown : grid;
    } catch {
      return grid;
    } finally {
      clearTimeout(timer);
    }
  }

  /** =EDEN.ASK(prompt, [range]): Eden's short answer (a number when it's a plain number), in one cell. */
  async function ask(prompt, range, invocation) {
    const t = words();
    const one = (value) => [[value]]; // the function's result is a 1 × 1 matrix (functions.json)
    const question = String(prompt ?? '').trim();
    if (!question) throw fail(t('cfType'), 'invalidValue');
    const raw = Array.isArray(range) && range.length ? X.trimGrid(range.map((row) => (Array.isArray(row) ? row : [row]))) : null;
    const grid = raw && raw.length ? raw.map((row) => row.map((v) => X.cellOf(v))) : null;
    if (grid && grid.reduce((n, row) => n + row.length, 0) > X.LIMITS.cells) throw fail(t('cfTooBig', { max: t.n(X.LIMITS.cells) }), 'invalidValue');
    const values = grid && X.hasData(grid) ? grid : null;
    const key = X.cacheKey(question, values);
    if (memory.has(key)) return one(X.cellResult(memory.get(key)));
    const saved = X.cacheGet(undefined, key);
    if (saved !== null) {
      memory.set(key, saved);
      return one(X.cellResult(saved));
    }
    if (inFlight.has(key)) return one(X.cellResult(await inFlight.get(key)));

    const token = (root.EdenPane && root.EdenPane.token && root.EdenPane.token()) || X.readToken();
    if (!token) {
      needConnect += 1;
      changed();
      throw fail(t('cfConnect'));
    }
    if (used >= cap) {
      paused += 1;
      changed();
      throw fail(t('cfPaused', { cap: t.n(cap) }));
    }
    used += 1; // held now so a burst can't pass the cap; given back if no answer comes
    changed();

    const address = invocation && Array.isArray(invocation.parameterAddresses) ? invocation.parameterAddresses[1] : null;
    const job = slot(async () => {
      const sent = values ? await rangeCells(values, address) : null;
      const built = X.sheetBody({ action: 'cell', instruction: question, sheet: sent ? { values: sent } : null, t });
      if (built.error) throw fail(built.error, 'invalidValue');
      const got = await post(token, built.body);
      if (got.timeout || got.status === 504) throw fail(t('cfSlow'));
      if (got.broken) throw fail(t('cfBroke'));
      if (got.status !== undefined) {
        const err = X.errorWords(got.status, got.info.code, got.info.error, t);
        if (err.connect) {
          needConnect += 1;
          if (root.EdenPane && root.EdenPane.signedOut) root.EdenPane.signedOut(token);
          else X.forgetToken(undefined, token);
        }
        throw fail(err.plan ? `${err.words} ${t('cfPlan')}` : err.words);
      }
      const answer = X.cellAnswer(got.text);
      if (!answer) throw fail(t('cfEmpty'));
      if (got.cut) throw fail(t('cfBroke')); // never a cut answer in a cell
      memory.set(key, answer);
      X.cachePut(undefined, key, answer);
      return answer;
    });
    inFlight.set(key, job);
    try {
      return one(X.cellResult(await job));
    } catch (error) {
      used = Math.max(0, used - 1); // no answer: it doesn't count against the cap
      throw error;
    } finally {
      inFlight.delete(key);
      changed();
    }
  }

  root.EdenCells = {
    ask,
    state,
    timing,
    onChange: (fn) => listeners.add(fn),
    /** More answers this session; the cells paused at the cap are worked out again. */
    allowMore(n = SESSION_CAP) {
      cap = used + n;
      const again = paused > 0;
      paused = 0;
      changed();
      if (again && root.EdenPane && root.EdenPane.recalc) root.EdenPane.recalc();
      return again;
    },
    clearSaved() {
      memory.clear();
      const n = X.cacheClear();
      changed();
      return n;
    },
    /** Called after Connect: how many cells were waiting for it (and resets the count). */
    takeNeedConnect() {
      const n = needConnect;
      needConnect = 0;
      return n;
    },
  };

  try {
    if (root.CustomFunctions && typeof root.CustomFunctions.associate === 'function') root.CustomFunctions.associate('ASK', ask);
  } catch {
    // not in Excel (a browser preview): the pane still works
  }
})(globalThis);
