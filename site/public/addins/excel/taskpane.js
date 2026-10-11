// Ask Eden for Excel: the task pane. The person selects cells and asks Eden about them, or presses
// Analyze, Write a formula, Explain formula, Fill column, Clean or Make a table; the answer streams
// in, and the ones that change the sheet show what they would do first (Insert, Fill, Replace).
// Nothing is read from the workbook or sent until a button is pressed. Pure logic: lib.js
// (EdenExcel); the cell function: functions.js (EdenCells), in this same page (the shared runtime).
(function () {
  const X = globalThis.EdenExcel;
  const $ = (id) => document.getElementById(id);
  let t = X.wordsFor('en');

  let token = null; // the scoped "ask" token (also in localStorage, for the cell function)
  let pkce = null; // { verifier, state, challenge }, made ahead so Connect opens its dialog at once
  let turns = []; // { role: 'user'|'eden', text, action?, job?, result?, failed? }
  let live = null; // { abort, turn } from the press until the answer is complete (one ask at a time)
  let connecting = null; // the Connect attempt under way (startConnect): { mine, dialog, timer, done, waiting, end, got, poll }
  let pendingHidden = ''; // the selection whose hidden rows the person was told about (press again to send)
  let inExcel = false;
  let ready = false; // Office.onReady has run

  const timing = { idleMs: 75_000 }; // no bytes for this long: the answer is broken (the server gives up at 60 s); tests shorten it
  const RETRIES_429 = 3;

  // ── small DOM helpers (model text only ever becomes text nodes) ──

  const el = (tag, cls, ...kids) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return node;
  };
  const button = (cls, label, onClick) => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };

  function drawText(node, text) {
    const out = [];
    let list = null;
    for (const b of X.blocks(text)) {
      if (b.type === 'gap') {
        list = null;
        continue;
      }
      const line = b.runs.map((r) => (r.b ? el('b', '', r.t) : r.i ? el('i', '', r.t) : r.code ? el('code', '', r.t) : r.t));
      if (b.type === 'li') {
        if (!list) out.push((list = el('ul')));
        list.append(el('li', '', line));
      } else {
        list = null;
        out.push(el('p', '', line));
      }
    }
    node.replaceChildren(...out);
  }

  /** A short note above the input: plain words, and Connect / See your plan when they help. */
  function note(words, { connect, plan, kind } = {}) {
    const box = $('note');
    box.className = `note${kind ? ` ${kind}` : ''}`;
    box.setAttribute('role', kind === 'warn' ? 'alert' : 'status');
    const kids = [];
    if (words) kids.push(el('span', '', words));
    if (connect) kids.push(button('link', t('connect'), startConnect));
    if (plan) {
      const a = el('a', 'link', t('plan'));
      a.href = 'https://askeden.com/account';
      a.target = '_blank';
      a.rel = 'noopener';
      kids.push(a);
    }
    box.replaceChildren(...kids.flatMap((k, i) => (i ? [' ', k] : [k])));
  }
  const warn = (words, more) => note(words, { kind: 'warn', ...more });

  /** One short line for screen readers (the log itself isn't a live region). */
  function announce(words) {
    const box = $('status');
    box.textContent = '';
    setTimeout(() => (box.textContent = words), 50);
  }

  async function copyText(text, btn) {
    const done = () => {
      btn.textContent = t('copied');
      setTimeout(() => (btn.textContent = t('copy')), 1500);
    };
    try {
      await navigator.clipboard.writeText(text);
      return done();
    } catch {
      // Office's web views may not allow the async clipboard: the old way
    }
    const area = el('textarea', 'offscreen');
    area.value = text;
    document.body.append(area);
    area.select();
    try {
      if (document.execCommand('copy')) done();
    } finally {
      area.remove();
      btn.focus();
    }
  }

  // ── connecting ──

  async function freshPkce() {
    const verifier = X.randomCode(48);
    pkce = { verifier, state: X.randomCode(18), challenge: await X.challengeOf(verifier) };
  }

  function setConnected(on) {
    $('connect').hidden = on;
    $('menu').hidden = !on;
    document.body.classList.toggle('signed-out', !on);
  }

  function connectButton(busyNow) {
    $('connectBtn').disabled = busyNow;
    $('connectBtn').textContent = t(busyNow ? 'connecting' : 'connect');
  }

  // Connect's timing: the relay is looked at about every 1.5 s while the window is open; after Office says
  // it closed (12006), more and more slowly (up to every 5 s) for 5 minutes (R2X1). Tests shorten them.
  const connectTiming = { pollMs: 1500, maxPollMs: 5000, waitMs: 5 * 60_000, openMs: 10 * 60_000, lateMs: 10 * 60_000 };
  let late = null; // { mine, until }: an attempt that ran out of time; a code relayed later still connects

  /** The relay's code for a state, or null (nothing yet, offline, busy). */
  async function take(state) {
    try {
      const res = await fetch('/api/eden/relay/take', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state }) });
      if (res.status === 200) {
        const body = await res.json().catch(() => ({}));
        if (typeof body.code === 'string' && body.code) return body.code;
      }
    } catch {
      // offline for a moment: the next poll tries again
    }
    return null;
  }

  /** A note while connecting: the words and a Cancel that ends it (R2X14: a Cancel on the web never reaches the pane). */
  function connectNote(words, kind = '') {
    note(words, { kind });
    const job = connecting;
    if (!job) return;
    if (words) $('note').append(' ');
    $('note').append(button('link', t('cancel'), () => job.end(t('cancelled'), '')));
  }

  /**
   * Connect: one attempt (one PKCE verifier and state) from the press until a code is redeemed, Cancel, or
   * time runs out. The code comes back by Office's messageParent or by askeden.com's relay, whichever comes
   * first. Excel on the web reports the window closed (12006) as soon as it reaches a sign-in page that cuts
   * it off from the pane (cross-origin-opener-policy), though the person is still signing in there: so a
   * closed window doesn't end the attempt; the pane keeps looking at the relay and says so (R2X1). Pressing
   * Connect again meanwhile opens the window again for the same attempt, never a second one racing it.
   */
  function startConnect() {
    if (!ready) return note(t('starting'));
    const ui = globalThis.Office && Office.context && Office.context.ui;
    if (!inExcel || !ui || !ui.displayDialogAsync) return warn(t('openInExcelConnect'));
    if (connecting) {
      if (connecting.dialog) return connectNote(t('finishSignIn'), 'warn');
      return openDialog(connecting, ui);
    }
    if (!pkce) return note(t('gettingReady'));
    const mine = pkce;
    pkce = null;
    freshPkce();
    // An earlier attempt that ran out of time is still looked at for a while: its code may come late.
    const earlier = late && late.until > Date.now() ? late.mine : null;
    late = null;
    const job = { mine, earlier, dialog: null, timer: 0, done: false, delay: connectTiming.pollMs, until: Date.now() + connectTiming.openMs };
    connecting = job;
    job.end = (words, kind = 'warn', { keep = false } = {}) => {
      if (job.done) return;
      job.done = true;
      clearTimeout(job.timer);
      try {
        if (job.dialog) job.dialog.close();
      } catch {
        // already closed
      }
      job.dialog = null;
      if (connecting === job) connecting = null;
      if (keep) late = { mine, until: Date.now() + connectTiming.lateMs };
      connectButton(false);
      note(words || '', { kind: words ? kind : '' });
    };
    job.got = async (code, verifier = mine.verifier) => {
      if (job.done) return;
      job.end('');
      await redeem(code, verifier);
    };
    job.poll = async () => {
      // One look at a time, then one timer: a window opened again during a look sets a timer too.
      if (job.done || job.looking) return;
      job.looking = true;
      try {
        const code = await take(mine.state);
        if (code) return job.got(code);
        if (job.earlier && !job.done) {
          const old = await take(job.earlier.state);
          if (old) return job.got(old, job.earlier.verifier);
        }
      } finally {
        job.looking = false;
      }
      if (job.done) return;
      if (Date.now() > job.until) return job.end(t('connectExpired'), 'warn', { keep: true });
      if (!job.dialog) job.delay = Math.min(connectTiming.maxPollMs, Math.round(job.delay * 1.3));
      clearTimeout(job.timer);
      job.timer = setTimeout(job.poll, job.delay);
    };
    openDialog(job, ui);
  }

  /** Opens (or opens again) the Connect window for an attempt. */
  function openDialog(job, ui) {
    const { mine } = job;
    connectButton(true);
    connectNote('');
    ui.displayDialogAsync(X.dialogUrl({ origin: location.origin, state: mine.state, challenge: mine.challenge }), { height: 70, width: 40 }, (opened) => {
      if (job.done) {
        try {
          if (opened.status === Office.AsyncResultStatus.Succeeded) opened.value.close();
        } catch {
          // gone
        }
        return;
      }
      if (opened.status !== Office.AsyncResultStatus.Succeeded) {
        const code = opened.error && opened.error.code;
        const words = code === 12009 ? t('popupBlocked') : code === 12007 ? t('finishSignIn') : t('cantOpenSignIn');
        // Opened again while waiting: the attempt goes on (its window may still be open somewhere).
        if (job.waiting) {
          connectButton(false);
          return connectNote(`${words} ${t('connectWaiting')}`, 'warn');
        }
        return job.end(words);
      }
      const dialog = opened.value;
      job.dialog = dialog;
      job.waiting = false;
      job.delay = connectTiming.pollMs;
      job.until = Math.max(job.until, Date.now() + connectTiming.openMs);
      clearTimeout(job.timer);
      job.timer = setTimeout(job.poll, job.delay);
      dialog.addEventHandler(Office.EventType.DialogMessageReceived, (arg) => {
        if (job.dialog !== dialog) return;
        if (arg.origin && arg.origin !== location.origin) return job.end(t('connectUnfinished'));
        let message = null;
        try {
          message = JSON.parse(arg.message);
        } catch {
          message = null;
        }
        const back = X.readRedirect(message && message.url, mine.state);
        if (back.error) return job.end(back.error === 'access_denied' ? t('cancelled') : t('connectUnfinished'));
        job.got(back.code);
      });
      dialog.addEventHandler(Office.EventType.DialogEventReceived, async (arg) => {
        if (job.done || job.dialog !== dialog) return;
        job.dialog = null;
        try {
          dialog.close(); // so Office lets Connect open it again
        } catch {
          // already closed
        }
        if (arg.error === 12006) {
          // Closed, or cut off from the pane by a sign-in page: the person may still be signing in there.
          job.waiting = true;
          job.until = Date.now() + connectTiming.waitMs;
          connectButton(false);
          connectNote(t('connectWaiting'));
          announce(t('connectWaiting'));
          return;
        }
        // The page didn't load, or another error: the code may still be on its way (a few more looks).
        clearTimeout(job.timer);
        for (let i = 0; i < 3 && !job.done; i++) {
          const code = await take(mine.state);
          if (code) return job.got(code);
          await X.sleep(connectTiming.pollMs);
        }
        job.end(arg.error === 12002 || arg.error === 12003 ? t('cantLoadSignIn') : t('signInClosed'));
      });
    });
  }

  async function redeem(code, verifier) {
    let res;
    try {
      res = await fetch('/api/eden/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(X.tokenBody({ code, verifier, origin: location.origin })) });
    } catch {
      return warn(X.errorWords(0, '', '', t).words);
    }
    let answer = {};
    try {
      answer = await res.json();
    } catch {
      answer = {};
    }
    if (!res.ok || !X.saveToken(undefined, answer)) return warn(t('connectUnfinished'));
    token = answer.access_token;
    late = null;
    setConnected(true);
    note(t('connected'), { kind: 'ok' });
    // Cells that asked before the connection: work them out again (answers already saved stay saved).
    if (globalThis.EdenCells && EdenCells.takeNeedConnect() > 0) recalcAskCells();
  }

  /** Work out the =EDEN.ASK cells again (only those; the whole workbook only if Excel can't find them). */
  function recalcAskCells() {
    if (!inExcel) return;
    Excel.run(async (context) => {
      const sheets = context.workbook.worksheets;
      sheets.load('items/name');
      await context.sync();
      const used = sheets.items.map((ws) => ws.getUsedRangeOrNullObject());
      for (const u of used) u.load('isNullObject');
      await context.sync();
      const found = used.filter((u) => !u.isNullObject).map((u) => u.getSpecialCellsOrNullObject(Excel.SpecialCellType.formulas));
      for (const f of found) f.load('isNullObject');
      await context.sync();
      const areas = found.filter((f) => !f.isNullObject).map((f) => f.areas);
      for (const a of areas) a.load('items/formulas');
      await context.sync();
      for (const a of areas) for (const r of a.items) if (r.formulas.some((row) => row.some((f) => typeof f === 'string' && /EDEN\.ASK\s*\(/i.test(f)))) r.calculate();
      await context.sync();
    }).catch(() =>
      Excel.run(async (context) => {
        context.application.calculate(Excel.CalculationType.full);
        await context.sync();
      }).catch(() => {}),
    );
  }

  async function disconnect() {
    $('menu').open = false;
    const old = token;
    token = null;
    X.forgetToken();
    // Saved cell answers came from this account's asks: they go with it.
    if (globalThis.EdenCells) EdenCells.clearSaved();
    setConnected(false);
    note(t('disconnected'));
    $('connectBtn').focus();
    if (old) await fetch('/api/eden/disconnect', { method: 'POST', headers: { authorization: `Bearer ${old}` } }).catch(() => {});
  }

  /** A 401 for `used`: sign out, unless a newer token has replaced it since (Connect again, another pane). */
  function signedOut(used) {
    if (used && token && used !== token) return;
    X.forgetToken(undefined, used || token);
    token = null;
    setConnected(false);
  }

  globalThis.EdenPane = { token: () => token, signedOut, recalc: recalcAskCells, timing, connectTiming };

  // ── the selection ──

  let selTimer = 0;
  // Closed (its runtime runs on for =EDEN.ASK), or started in the background by a workbook's =EDEN.ASK cells
  // without being shown (R2X15): no Excel call per click.
  let paneHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  function watchSelection() {
    clearTimeout(selTimer);
    if (!paneHidden) selTimer = setTimeout(showSelection, 120);
  }

  /** The pane shown or hidden: a shown pane catches up with the selection. */
  function shown(on) {
    paneHidden = !on;
    if (paneHidden) clearTimeout(selTimer);
    else showSelection();
  }

  const oneBlock = (error) => Boolean(error && (error.code === 'InvalidSelection' || /selection is invalid|multiple selections/i.test(String(error.message))));

  async function showSelection() {
    if (!inExcel) return;
    try {
      await Excel.run(async (context) => {
        const range = context.workbook.getSelectedRange();
        range.load('address,rowCount,columnCount');
        await context.sync();
        const { sheet, cells } = X.splitAddress(range.address);
        $('selAddr').textContent = sheet ? `${sheet} · ${cells}` : cells;
        $('selAddr').title = range.address;
        const n = range.rowCount * range.columnCount;
        $('selSize').textContent = n > 1 ? `${t.n(range.rowCount)} × ${t.n(range.columnCount)}` : '';
      });
    } catch (error) {
      $('selAddr').textContent = oneBlock(error) ? t('oneBlock') : t('noSelection');
      $('selSize').textContent = '';
    }
  }

  // ── reading what an action needs (only that) ──

  /** A huge selection (whole columns or rows) clipped to the part with data (`used`): { range, dim }; dim, its rows and columns, worked out without a trip. */
  function clipped(sheet, sel, used) {
    if (sel.rowCount * sel.columnCount <= X.LIMITS.cells || used.isNullObject) return { range: sel, dim: sel };
    const r0 = Math.max(sel.rowIndex, used.rowIndex);
    const r1 = Math.min(sel.rowIndex + sel.rowCount, used.rowIndex + used.rowCount);
    let c0 = Math.max(sel.columnIndex, used.columnIndex);
    let c1 = Math.min(sel.columnIndex + sel.columnCount, used.columnIndex + used.columnCount);
    if (c1 <= c0) {
      // empty columns (a column to fill): keep the selected columns, on the rows with data
      c0 = sel.columnIndex;
      c1 = sel.columnIndex + sel.columnCount;
    }
    if (r1 <= r0) return { range: sel, dim: sel };
    const dim = { rowIndex: r0, columnIndex: c0, rowCount: r1 - r0, columnCount: c1 - c0 };
    return { range: sheet.getRangeByIndexes(r0, c0, dim.rowCount, dim.columnCount), dim };
  }

  /** Fill into an empty column: the columns right next to it, on its rows (at most LIMITS.fillColumns; R2X5). */
  function besideOf(ws, dim, used) {
    const width = Math.min(X.LIMITS.fillColumns, dim.columnIndex - used.columnIndex);
    return { width, range: ws.getRangeByIndexes(dim.rowIndex, dim.columnIndex - width, dim.rowCount, width) };
  }

  /**
   * A range's cells in one round trip with how many of its rows (and `columns`) are hidden or filtered,
   * (`right`) the column to its right, and (`beside`, a range on the same rows) its cells and hidden rows.
   * If Excel can't give an extra, the cells are read alone, then the hidden count on its own (0 when Excel
   * can't say); `next` and `besideHidden` are then null.
   */
  async function cellsWith(context, range, fields, rows, columns, right, beside) {
    const viewOf = (r) => {
      const v = r.getVisibleView();
      v.load('rowCount,columnCount');
      return v;
    };
    range.load(fields);
    let view = null;
    let next = null;
    let besideView = null;
    try {
      view = viewOf(range);
      if (right) (next = range.getLastColumn().getOffsetRange(0, 1)).load('address');
      if (beside) besideView = viewOf(beside.load(fields) || beside);
      await context.sync();
    } catch {
      next = null;
      besideView = null;
      range.load(fields);
      await context.sync();
      try {
        view = viewOf(range);
        await context.sync();
      } catch {
        view = null;
      }
    }
    const hiddenIn = (v, cols) => (v ? Math.max(0, rows - v.rowCount) + Math.max(0, cols - v.columnCount) : 0);
    return { hidden: hiddenIn(view, columns), next, besideHidden: besideView ? hiddenIn(besideView, 0) : null };
  }

  const tooLong = (range, at, action) => t('cellTooLong', { cell: X.cellName(X.topLeftOf(range.address), at[0], at[1]), action: t(action).toLowerCase(), n: t.n(X.LIMITS.cellChars) });

  /**
   * What the action sends and what applying it needs. { sheet, active, job, hidden } or { error }.
   * `job` remembers where the answer goes (sheet id, addresses, what was sent) for Insert / Fill / Replace.
   */
  function readFor(action) {
    return Excel.run(async (context) => {
      const ws = context.workbook.worksheets.getActiveWorksheet();
      ws.load('name,id');
      const activeCell = context.workbook.getActiveCell();
      activeCell.load('address,formulas,values');
      const sel = context.workbook.getSelectedRange();
      // One round trip for what every action needs (each sync is a trip to Excel's server on the web), with
      // the data's extent: a whole column is clipped to it, a formula's context and Fill use it.
      if (action !== 'table') sel.load('address,rowCount,columnCount,rowIndex,columnIndex');
      const used = action === 'table' ? null : ws.getUsedRangeOrNullObject(true);
      if (used) used.load('address,rowIndex,columnIndex,rowCount,columnCount');
      await context.sync();
      const name = ws.name;
      const active = { address: X.cellsOf(activeCell.address) };
      const base = { sheet: name, sheetId: ws.id };

      if (action === 'table') return { sheet: { name }, active, job: { ...base, at: X.cellsOf(activeCell.address) } };

      const { range, dim } = clipped(ws, sel, used);
      const tooBig = X.sizeProblem(action, dim.rowCount, dim.columnCount, t);
      if (tooBig && action !== 'formula' && action !== 'explain') return { error: tooBig };

      if (action === 'formula' || action === 'explain') return formulaContext(context, range, dim, activeCell, action, active, base, used);

      // Numbers go as their values, dates as shown: the number formats say which (R2X4). Fill and Clean also
      // load the formulas, to tell a real change from a recalculation before writing (R2X6). Fill into a column
      // right of the data (so empty) reads the columns beside it in the same trip.
      const fields = action === 'clean' || action === 'fill' ? 'address,values,text,formulas,numberFormat' : 'address,values,text,numberFormat';
      const beside = action === 'fill' && dim.columnCount === 1 && !used.isNullObject && dim.columnIndex >= used.columnIndex + used.columnCount ? besideOf(ws, dim, used) : null;
      const got = await cellsWith(context, range, fields, dim.rowCount, dim.columnCount, action === 'fill', beside && beside.range);
      const long = action === 'fill' || action === 'clean' ? X.longCell(range.values, action === 'clean') : null;
      if (long) return { error: tooLong(range, long, action) };
      let values = X.gridOf(range.values, range.text, range.numberFormat);
      let address = X.cellsOf(range.address);
      const job = { ...base, source: address, rows: dim.rowCount };
      let { hidden } = got;

      if (action === 'fill') {
        job.raw = X.rawOf(range.values, range.formulas);
        if (dim.columnCount === 1 && !X.hasData(values)) {
          // One empty column selected: fill it from the filled columns right next to it, on the same rows
          // (at most LIMITS.fillColumns, up to the first empty column), never the whole sheet to its left (R2X5).
          if (used.isNullObject || used.columnIndex >= dim.columnIndex) return { error: t('fillWhere') };
          const read = got.besideHidden !== null;
          const { width, range: near } = read ? beside : besideOf(ws, dim, used);
          const nearHidden = read ? got.besideHidden : (await cellsWith(context, near, fields, dim.rowCount, 0, false)).hidden;
          const grid = X.gridOf(near.values, near.text, near.numberFormat);
          let k = 0; // filled columns next to the selection
          while (k < width && X.hasData(grid.map((row) => [row[width - 1 - k]]))) k++;
          if (!k) return { error: t('fillEmptyLeft') };
          const pick = (g) => g.map((row) => row.slice(width - k));
          const longLeft = X.longCell(pick(near.values));
          const from = X.rangeName({ col: dim.columnIndex - k, row: dim.rowIndex + 1 }, 0, dim.rowCount, k);
          if (longLeft) return { error: tooLong({ address: from }, longLeft, 'fill') };
          values = pick(grid);
          job.raw = X.rawOf(pick(near.values), pick(near.formulas));
          job.target = address;
          address = from;
          job.source = address;
          hidden = nearHidden;
        } else {
          let target = got.next;
          if (!target) {
            target = range.getLastColumn().getOffsetRange(0, 1);
            target.load('address');
            await context.sync();
          }
          job.target = X.cellsOf(target.address);
        }
      }
      const sheet = { name, range: address, values };
      if (action === 'clean') {
        job.sent = values;
        job.raw = X.rawOf(range.values, range.formulas); // Clean checks the cells still hold this before writing
        job.values = range.values;
        job.formats = range.numberFormat;
        job.formulas = range.formulas;
        job.kinds = X.kindsOf(range.values, range.numberFormat);
        const f = X.formulaGrid(range.formulas);
        if (f) sheet.formulas = f;
      }
      if (action === 'ask' && !X.hasData(values)) return { sheet: { name, range: address }, active, job, hidden: 0 };
      job.hidden = hidden;
      return { sheet, active, job, hidden };
    });
  }

  /**
   * Write a formula / Explain formula: what they need and no more. With one cell selected, the sheet's
   * header row and its first few rows (a sample), with the data's whole address so formulas can cover
   * it; with a selection, the selected cells (trimmed to the limits).
   */
  async function formulaContext(context, range, dim, activeCell, action, active, base, used) {
    let part;
    const single = dim.rowCount * dim.columnCount === 1;
    if (single) {
      if (used.isNullObject || used.rowCount * used.columnCount <= 1) part = null;
      else part = used.getRow(0).getResizedRange(Math.min(used.rowCount, X.LIMITS.sampleRows) - 1, 0);
    } else {
      range.load('address'); // a clipped whole column's: with the cells
      const rows = Math.max(1, Math.min(dim.rowCount, Math.floor(X.LIMITS.cells / Math.max(1, dim.columnCount))));
      part = range.getResizedRange(rows - dim.rowCount, 0);
    }
    const sheet = { name: base.sheet };
    if (part) {
      part.load(action === 'explain' && !single ? 'values,text,formulas,numberFormat' : 'values,text,numberFormat');
      await context.sync();
      const address = X.cellsOf(single ? used.address : range.address);
      const fit = X.fitRows(X.gridOf(part.values, part.text, part.numberFormat));
      // A selection: the address of the rows actually sent (R1X49). One cell: the data's whole address on
      // purpose, so a formula can cover all of it; the rows sent are its header and first rows.
      sheet.range = single || !fit.trimmed && fit.rows === dim.rowCount ? address : X.rangeName(X.topLeftOf(address), 0, Math.max(1, fit.rows), dim.columnCount);
      sheet.values = fit.values;
      if (action === 'explain' && !single) {
        const f = X.formulaGrid(part.formulas.slice(0, fit.rows));
        if (f) sheet.formulas = f;
      }
    }
    if (action === 'explain') {
      const own = activeCell.formulas[0][0];
      if (typeof own === 'string' && own.startsWith('=')) active.formula = own;
      // Half a formula explained as if it were whole is worse than none (R2X8).
      if (active.formula && active.formula.length > X.LIMITS.cellChars) return { error: t('formulaTooLong', { n: t.n(X.LIMITS.cellChars) }) };
      active.value = String(activeCell.values[0][0] ?? '');
    }
    return { sheet: X.hasData(sheet.values) || sheet.formulas ? sheet : { name: base.sheet }, active, job: { ...base, at: active.address } };
  }

  // ── asking ──

  const PROMPT = { formula: 'phFormula', fill: 'phFill', table: 'phTable' };

  function busy(on) {
    document.body.classList.toggle('busy', on);
    for (const b of document.querySelectorAll('#actions .chip')) b.disabled = on;
    $('send').textContent = on ? '■' : '↑';
    $('send').setAttribute('aria-label', on ? t('stop') : t('ask'));
    $('send').title = on ? t('stop') : t('ask');
    $('log').setAttribute('aria-busy', on ? 'true' : 'false');
  }

  /** The request bodies for an action: one, or (Fill and Clean beyond one answer's size) several parts. */
  function bodiesFor(action, words, read, history) {
    const one = (sheet) => X.sheetBody({ action, instruction: words, sheet, active: read.active, history, t });
    if ((action === 'fill' || action === 'clean') && read.sheet && read.sheet.values) {
      const { values, formulas, range, name } = read.sheet;
      const parts = X.chunksFor(action, values, formulas, t);
      if (parts.error) return { error: parts.error };
      const start = X.topLeftOf(range);
      const bodies = [];
      for (const p of parts) {
        const rows = values.slice(p.start, p.end);
        const sent = action === 'clean' ? X.cleanSend(rows) : null;
        const sheet = { name, range: X.rangeName(start, p.start, p.end - p.start, X.widthOf(values)), values: sent ? sent.values : rows };
        if (formulas) {
          const f = formulas.slice(p.start, p.end);
          if (f.some((row) => row.some(Boolean))) sheet.formulas = f;
        }
        const built = one(sheet);
        if (built.error) return built;
        bodies.push({ body: built.body, start: p.start, rows: rows.length, sent: sent ? sent.values : rows, escaped: sent ? sent.escaped : null });
      }
      return { bodies };
    }
    let built = one(read.sheet);
    // A formula's surroundings are only context: when they're too much, send the active cell alone.
    if (built.error && (action === 'formula' || action === 'explain') && read.sheet && read.sheet.values) built = one({ name: read.sheet.name });
    return built.error ? built : { bodies: [{ body: built.body, start: 0, rows: 0 }] };
  }

  async function run(action, { instruction, again, replace } = {}) {
    if (live) return;
    if (!ready) return note(t('starting'));
    if (!token) {
      setConnected(false);
      return note(X.errorWords(401, '', '', t).words, { connect: true });
    }
    const words = instruction !== undefined ? instruction : $('input').value.trim();
    if (X.ACTIONS[action].instruction && !words) {
      $('input').placeholder = t(PROMPT[action] || 'placeholder');
      $('input').focus();
      return note(t(PROMPT[action] || 'placeholder'));
    }
    if (!inExcel) return warn(t('openInExcel'));
    // One ask at a time, from the press on: a second press (or Enter) does nothing, Stop works.
    const abort = new AbortController();
    live = { abort, turn: null };
    busy(true);
    note('');
    const quit = (words2, kind = 'warn') => {
      live = null;
      busy(false);
      if (words2) note(words2, { kind });
    };
    let read;
    try {
      read = await readFor(action);
    } catch (error) {
      return quit(oneBlock(error) ? t('oneBlock') : t('cantRead', { why: error && error.message ? ` (${error.message})` : '' }));
    }
    if (abort.signal.aborted) return quit(t('stopped'), '');
    if (read.error) return quit(read.error);
    // Hidden (filtered) rows are sent too, so they line up: say so first, and send on the second press.
    const key = `${action}|${read.job && read.job.sheetId}|${read.sheet && read.sheet.range}|${read.hidden}`;
    if (read.hidden > 0 && pendingHidden !== key) {
      pendingHidden = key;
      return quit(t('hiddenFirst', { n: t.n(read.hidden), button: t(action) }));
    }
    pendingHidden = '';
    const history = turns.filter((x) => !x.failed && !(replace && replace.includes(x))).map((x) => ({ role: x.role, text: x.text }));
    const built = bodiesFor(action, words, read, history);
    if (built.error) return quit(built.error);
    if (replace) turns = turns.filter((x) => !replace.includes(x));
    if (!again) {
      $('input').value = '';
      $('input').placeholder = t('placeholder');
      grow();
    }
    const user = { role: 'user', text: words || t(action), action, instruction: words };
    const reply = { role: 'eden', text: '', action, job: read.job, streaming: true, parts: built.bodies.map(() => ''), chunks: built.bodies };
    if (built.bodies.length > 1) reply.progress = { done: 0, total: built.bodies.length };
    turns.push(user, reply);
    live.turn = reply;
    render();
    announce(t('answering'));
    await stream(reply, user, abort);
  }

  /** One request: retried after "busy" (429, its Retry-After), streamed to onText. Throws { status, info } or { broken } or { timeout }. */
  async function post(body, abort, onText) {
    const used = token;
    for (let attempt = 0; ; attempt++) {
      const mine = new AbortController();
      const stop = () => mine.abort();
      abort.signal.addEventListener('abort', stop);
      let idle = 0;
      let timedOut = false;
      const arm = () => {
        clearTimeout(idle);
        idle = setTimeout(() => {
          timedOut = true;
          mine.abort();
        }, timing.idleMs);
      };
      try {
        arm();
        let res;
        try {
          res = await fetch('/api/eden/sheet', { method: 'POST', headers: { authorization: `Bearer ${used}`, 'content-type': 'application/json', 'x-eden-trailer': '1' }, body: JSON.stringify(body), signal: mine.signal });
        } catch {
          if (abort.signal.aborted) throw { stopped: true };
          throw timedOut ? { timeout: true } : { status: 0, info: {} };
        }
        if (!res.ok) {
          let info = {};
          try {
            info = await res.json();
          } catch {
            info = {};
          }
          if (res.status === 429 && attempt < RETRIES_429 && !abort.signal.aborted) {
            clearTimeout(idle);
            await X.sleep(X.retryWait(res.headers.get('retry-after'), attempt), abort.signal);
            if (abort.signal.aborted) throw { stopped: true };
            continue;
          }
          throw { status: res.status, info, used };
        }
        // With a trailer (x-eden-trailer: 1 back): the answer, then U+0000 and how it ended, as JSON, so a cut-off,
        // a refusal and a dropped connection each get their own words (R2X13). Without one (an older Worker), a
        // clean close is a whole answer and an error is a break.
        const trailed = res.headers.get('x-eden-trailer') === '1';
        let tail = null;
        const feed = (text) => {
          if (tail !== null) return void (tail += text);
          const at = trailed ? text.indexOf(X.TRAILER) : -1;
          if (at < 0) return void (text && onText(text));
          if (at) onText(text.slice(0, at));
          tail = text.slice(at + 1);
        };
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            arm();
            feed(decoder.decode(value, { stream: true }));
          }
          feed(decoder.decode());
        } catch {
          if (abort.signal.aborted) throw { stopped: true };
          throw timedOut ? { timeout: true } : { broken: true };
        }
        if (!trailed) return;
        const end = X.trailerOf(tail);
        if (end.complete) return;
        if (end.timeout) throw { timeout: true };
        if (end.broken) throw { broken: true };
        throw { status: end.status, info: end.info, used };
      } finally {
        clearTimeout(idle);
        abort.signal.removeEventListener('abort', stop);
      }
    }
  }

  async function stream(reply, user, abort) {
    let frame = 0;
    const draw = () => {
      if (!frame) {
        // Each paint re-reads the whole answer: paint less often as it grows (R1X47).
        const size = reply.parts.reduce((n, p) => n + p.length, 0);
        frame = setTimeout(() => {
          frame = 0;
          drawLive();
        }, Math.min(1000, 60 + Math.floor(size / 200)));
      }
    };
    let failure = null;
    let next = 0;
    const worker = async () => {
      while (next < reply.chunks.length && !failure && !abort.signal.aborted) {
        const i = next++;
        try {
          await post(reply.chunks[i].body, abort, (piece) => {
            reply.parts[i] += piece;
            draw();
          });
          if (reply.progress) reply.progress.done += 1;
          draw();
        } catch (error) {
          if (!failure && !error.stopped) {
            failure = error;
            abort.abort(); // the other part stops too: nothing is written unless every part came back
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(X.LIMITS.inFlight, reply.chunks.length) }, worker));
    clearTimeout(frame);
    reply.text = reply.parts.map((p) => p.replace(/\n+$/, '')).join('\n');
    reply.streaming = false;
    if (live && live.turn === reply) live = null;
    busy(false);
    if (failure && failure.status !== undefined) {
      // Nothing usable came back: the question goes back in the box, with plain words.
      const err = X.errorWords(failure.status, failure.info.code, failure.info.error, t);
      turns = turns.filter((x) => x !== reply && x !== user);
      if (!$('input').value) $('input').value = user.instruction || '';
      grow();
      render();
      if (err.connect) signedOut(failure.used);
      announce(err.words);
      return warn(err.words, { connect: err.connect, plan: err.plan });
    }
    if (failure) reply.broken = failure.timeout ? t('tooSlow') : t('brokeOff');
    else if (abort.signal.aborted) reply.stopped = true;
    finish(reply);
    render({ focus: reply });
    announce(summary(reply));
  }

  /** What an answer means for the sheet, once it's complete. */
  function finish(reply) {
    if (reply.stopped || reply.broken) {
      reply.failed = true; // a half answer never goes back as history
      reply.result = { warn: reply.stopped ? t('stoppedNothing') : `${reply.broken} ${t('tryAgainShort')}` };
      return;
    }
    const job = reply.job || {};
    const many = reply.chunks.length > 1;
    const partWords = (i, words) => (many ? `${t('partOf', { i: i + 1, n: reply.chunks.length })} ${words}` : words);
    if (reply.action === 'formula') {
      const formula = X.formulaOf(reply.text);
      reply.result = formula ? { formula, risky: X.reachesOut(formula) } : { warn: t('noFormula') };
    } else if (reply.action === 'fill') {
      const lines = [];
      for (let i = 0; i < reply.chunks.length; i++) {
        const check = X.fillCheck(reply.parts[i], reply.chunks[i].rows, t);
        if (check.error) {
          reply.result = { warn: partWords(i, check.error) };
          break;
        }
        lines.push(...check.lines);
      }
      if (!reply.result) reply.result = { lines };
    } else if (reply.action === 'clean') {
      const rows = [];
      for (let i = 0; i < reply.chunks.length; i++) {
        const c = reply.chunks[i];
        const check = X.cleanCheck(reply.parts[i], c.sent, t);
        if (check.error) {
          reply.result = { warn: partWords(i, check.error) };
          break;
        }
        rows.push(...X.cleanReceive(check.rows, c.escaped));
      }
      if (!reply.result) {
        const changes = X.cleanChanges(job.sent, rows, job.formulas, { kinds: job.kinds, raw: job.values, formats: job.formats, lang: t.lang });
        const kept = changes.kept ? t('keptValues', { n: t.n(changes.kept) }) : '';
        reply.result = changes.length ? { changes, kept } : { done: kept ? `${t('nothingToClean')} ${kept}` : t('nothingToClean') };
      }
    } else if (reply.action === 'table') {
      const check = X.tableCheck(reply.text, X.LIMITS.cells, t);
      reply.result = check.error ? { warn: check.error } : { table: check.rows };
    } else {
      reply.result = {};
    }
    if (reply.result.warn) reply.failed = true;
  }

  /** The line a screen reader hears when an answer is complete. */
  function summary(reply) {
    const res = reply.result || {};
    if (res.warn) return res.warn;
    if (res.formula) return `${t('answered')} ${res.formula}`;
    if (res.lines || res.changes || res.table) return `${t('answered')} ${t('previewReady')}`;
    return `${t('answered')} ${reply.text.slice(0, 300)}`;
  }

  // ── applying (always shown first; nothing is written without a press) ──

  const { isFormula } = X;
  const filled = (values, formulas) => values.reduce((n, row, r) => n + row.filter((v, c) => (v !== '' && v !== null) || (formulas && isFormula(formulas[r][c]))).length, 0);

  /** Writing over filled cells needs a second press (for the same cells and count): true when this press only asks. */
  function overFilled(res, target, at, button) {
    const n = filled(target.values, target.formulas);
    if (!n || res.confirmFor === `${at}|${n}`) return false;
    res.confirmFor = `${at}|${n}`;
    res.confirm = button === 'formula' ? t('notEmptyFormula', { at }) : t('notEmpty', { at, n: t.n(n), button: t(button) });
    return true;
  }

  /** The values and number formats for writing rows of Eden's text: text Excel would change goes in as text ("@"). */
  function writeGrid(rows, formats) {
    const values = [];
    const numberFormat = [];
    rows.forEach((row, r) => {
      values.push([]);
      numberFormat.push([]);
      row.forEach((text, c) => {
        const w = X.cellWrite(text, 'auto', { lang: t.lang });
        const was = formats && formats[r] ? formats[r][c] : 'General';
        const general = was === 'General' || (was === '@' && typeof w.v !== 'string');
        values[r].push(w.v);
        numberFormat[r].push(w.asText ? '@' : general ? w.format || 'General' : was);
      });
    });
    return { values, numberFormat };
  }

  /**
   * The job's sheet by its id (a renamed sheet still works; a deleted one is gone), with what `read(ws)` loads
   * in the same round trip: { got } or { error }. If that trip fails, a gone or protected sheet says so.
   */
  async function sheetFor(context, job, read) {
    const sheets = context.workbook.worksheets;
    const ws = typeof sheets.getItemOrNullObject === 'function' ? sheets.getItemOrNullObject(job.sheetId || job.sheet) : sheets.getItem(job.sheet);
    ws.load('isNullObject');
    let protection = null;
    try {
      protection = ws.protection;
      protection.load('protected');
    } catch {
      protection = null;
    }
    let got = null;
    try {
      got = read ? read(ws) : null;
      await context.sync();
    } catch (error) {
      const found = read ? await sheetFor(context, job).catch(() => null) : null;
      if (found && found.error) return found;
      throw error;
    }
    if (ws.isNullObject) return { error: t('sheetGone') };
    if (protection && protection.protected) return { error: t('sheetProtected') };
    return { got };
  }

  async function apply(reply) {
    const res = reply.result;
    const job = reply.job;
    if (reply.applying || live) return;
    reply.applying = true;
    render({ focus: reply });
    try {
      await Excel.run(async (context) => {
        const found = await sheetFor(context, job, (ws) => {
          const loaded = (range, fields) => (range.load(fields), range);
          if (reply.action === 'fill') return { source: loaded(ws.getRange(job.source), 'values,formulas'), target: loaded(ws.getRange(job.target), 'address,values,formulas,rowCount,numberFormat') };
          if (reply.action === 'clean') return { source: loaded(ws.getRange(job.source), 'values,formulas') };
          const at = ws.getRange(job.at);
          return { target: loaded(reply.action === 'table' ? at.getResizedRange(res.table.length - 1, res.table[0].length - 1) : at, 'address,values,formulas,numberFormat') };
        });
        if (found.error) {
          res.warn = found.error;
          return;
        }
        if (reply.action === 'formula' || reply.action === 'table') {
          const { target } = found.got;
          const at = X.cellsOf(target.address);
          if (overFilled(res, target, at, reply.action === 'formula' ? 'formula' : 'insertWord')) return;
          if (reply.action === 'formula') {
            // A Text-formatted cell ("@") would keep the formula as text (R2X11).
            if (target.numberFormat && target.numberFormat[0][0] === '@') target.numberFormat = [['General']];
            target.formulas = [[res.formula]];
          }
          else {
            const w = writeGrid(res.table, target.numberFormat);
            target.numberFormat = w.numberFormat;
            target.values = w.values;
          }
          target.select();
          await context.sync();
          if (reply.action === 'table') {
            try {
              target.getRow(0).format.font.bold = true;
              target.format.autofitColumns();
              await context.sync();
            } catch {
              // the values are in; the header's look is a detail
            }
          }
          res.confirm = '';
          res.done = reply.action === 'formula' ? t('insertedIn', { at }) : t('insertedAt', { at });
        } else if (reply.action === 'fill') {
          const { source, target } = found.got;
          if (target.rowCount !== res.lines.length) {
            res.warn = t('selectionChanged');
            return;
          }
          // What the cells hold (formulas as formulas): a recalculation or a narrower column isn't a change (R2X6).
          if (JSON.stringify(X.rawOf(source.values, source.formulas)) !== JSON.stringify(job.raw)) {
            res.warn = t('rowsChanged');
            return;
          }
          const at = X.cellsOf(target.address);
          if (overFilled(res, target, at, 'fillWord')) return;
          const w = writeGrid(res.lines.map((line) => [line]), target.numberFormat);
          target.numberFormat = w.numberFormat;
          target.values = w.values;
          target.select();
          await context.sync();
          res.confirm = '';
          res.done = t('filled', { at });
        } else if (reply.action === 'clean') {
          const { source } = found.got;
          // The cells Clean writes must still be what Eden saw: their values (formulas as formulas, so a
          // recalculation doesn't count; nor does how they're shown, R2X6).
          const same = JSON.stringify(X.rawOf(source.values, source.formulas)) === JSON.stringify(job.raw);
          if (!same) {
            res.warn = t('cellsChanged');
            return;
          }
          // Only the changed cells, in batches, so a failure can say how far it got.
          let written = 0;
          const todo = res.changes.filter((ch) => !isFormula(source.formulas[ch.r][ch.c]));
          try {
            for (let i = 0; i < todo.length; i += 200) {
              for (const ch of todo.slice(i, i + 200)) {
                const cell = source.getCell(ch.r, ch.c);
                const w = X.cellWrite(ch.to, job.kinds[ch.r][ch.c], { lang: t.lang });
                if (w.asText) cell.numberFormat = [['@']];
                cell.values = [[w.v]];
              }
              await context.sync();
              written = Math.min(todo.length, i + 200);
            }
          } catch (error) {
            res.warn = t('partWritten', { n: t.n(written), m: t.n(todo.length), why: error && error.message ? ` (${error.message})` : '' });
            return;
          }
          res.done = t(job.formulas && X.formulaGrid(job.formulas) ? 'replacedKept' : 'replaced', { n: t.n(written) });
        }
      });
    } catch (error) {
      res.warn = t('cantWrite', { why: error && error.message ? ` (${error.message})` : '' });
    }
    reply.applying = false;
    render({ focus: reply });
    announce(res.done || res.warn || res.confirm || '');
  }

  // ── drawing the conversation ──

  function render({ focus } = {}) {
    const log = $('log');
    log.replaceChildren(...turns.map((turn, i) => turnNode(turn, i === turns.length - 1)));
    if (!turns.length) log.append(el('p', 'empty', t('empty')));
    $('clear').hidden = !turns.length;
    log.scrollTop = log.scrollHeight;
    if (focus) {
      // Keyboard and screen-reader users land on what just happened, not at the top of the page.
      const i = turns.indexOf(focus);
      const node = i >= 0 ? log.children[i] : null;
      const target = node && (node.querySelector('.tools .btn:not(:disabled)') || node.querySelector('.say') || node.querySelector('.tools button'));
      if (target) target.focus({ preventScroll: false });
    }
  }

  function drawLive() {
    if (!live || !live.turn) return;
    const box = document.querySelector('.turn.eden:last-child .body');
    if (!box) return;
    paintBody(box, live.turn);
    $('log').scrollTop = $('log').scrollHeight;
  }

  const fillIn = (node, ...kids) => node.replaceChildren(...kids.filter(Boolean));

  function paintBody(body, turn) {
    const out = X.ACTIONS[turn.action] ? X.ACTIONS[turn.action].out : 'text';
    const text = turn.streaming ? turn.parts.join('') : turn.text;
    const progress = turn.streaming && turn.progress ? el('p', 'muted', t('progress', { done: turn.progress.done, n: turn.progress.total })) : null;
    if (turn.streaming && !text) return fillIn(body, progress, el('div', 'thinking', el('i'), el('i'), el('i')));
    if (out === 'text') return drawText(body, text);
    const res = turn.result || {};
    if (turn.streaming || (!res.formula && !res.lines && !res.changes && !res.table)) return fillIn(body, progress, el('pre', 'raw', text.trim()));
    if (res.formula) return fillIn(body, el('code', 'formula', res.formula));
    const hidden = turn.job && turn.job.hidden ? el('p', 'muted', t('hiddenIncluded', { n: t.n(turn.job.hidden) })) : null;
    if (res.lines) {
      const at = X.topLeftOf(turn.job.target);
      const rows = res.lines.slice(0, 8).map((line, i) => el('tr', '', el('th', '', X.cellName(at, i, 0)), el('td', '', line || '—')));
      const more = res.lines.length > 8 ? el('p', 'muted', t('andMore', { n: t.n(res.lines.length - 8) })) : null;
      return fillIn(body, el('p', '', t('valuesFor', { n: t.n(res.lines.length), at: turn.job.target }), ' ', el('span', 'muted', t('fillFrom', { at: turn.job.source }))), el('div', 'grid', el('table', '', el('tbody', '', rows))), more, hidden);
    }
    if (res.changes) {
      const start = X.topLeftOf(turn.job.source);
      const rows = res.changes.slice(0, 10).map((ch) => el('tr', '', el('th', '', X.cellName(start, ch.r, ch.c)), el('td', '', el('span', 'from', ch.from || '—'), el('span', 'arrow', ' → '), el('span', 'to', ch.to || '—'))));
      const more = res.changes.length > 10 ? el('p', 'muted', t('andMore', { n: t.n(res.changes.length - 10) })) : null;
      return fillIn(body, el('p', '', t('cellsChange', { n: t.n(res.changes.length), at: turn.job.source })), el('div', 'grid', el('table', 'diff', el('tbody', '', rows))), more, res.kept ? el('p', 'muted', res.kept) : null, hidden);
    }
    if (res.table) {
      const [head, ...rest] = res.table;
      const tbl = el('table', '', el('thead', '', el('tr', '', head.map((h) => el('th', '', h)))), el('tbody', '', rest.slice(0, 8).map((row) => el('tr', '', row.map((c) => el('td', '', c))))));
      const more = rest.length > 8 ? el('p', 'muted', t('andMoreRows', { n: t.n(rest.length - 8) })) : null;
      return fillIn(body, el('p', '', t('tableSize', { r: t.n(res.table.length), c: t.n(head.length) })), el('div', 'grid', tbl), more);
    }
    return null;
  }

  const say = (cls, words) => {
    const p = el('p', `${cls} say`, words);
    p.tabIndex = -1;
    return p;
  };

  function turnNode(turn, last) {
    const box = el('div', `turn ${turn.role}`);
    const body = el('div', 'body');
    if (turn.role === 'user') {
      body.append(el('p', '', turn.text));
      box.append(body);
      return box;
    }
    paintBody(body, turn);
    box.append(body);
    if (turn.streaming) return box;
    const res = turn.result || {};
    if (res.risky && res.risky.length && !res.done) box.append(say('warn', t('risky', { names: res.risky.join(', ') })));
    if (res.warn) box.append(say('warn', res.warn));
    if (res.confirm) box.append(say('warn', res.confirm));
    if (res.done) box.append(say('ok', res.done));
    const tools = el('div', 'tools');
    if (!res.done && !res.warn) {
      let label = '';
      if (res.formula) label = t(res.risky && res.risky.length ? 'insertAnyway' : 'insertIn', { at: turn.job.at });
      if (res.lines) label = t('fillAt', { at: turn.job.target });
      if (res.changes) label = t('replaceClean');
      if (res.table) label = t('insertTableAt', { at: turn.job.at });
      if (label) {
        const b = button('btn small', label, () => apply(turn));
        b.disabled = Boolean(turn.applying);
        tools.append(b);
      }
    }
    if (turn.text.trim()) {
      const copy = button('mini', t('copy'), () => copyText(res.formula || turn.text.trim(), copy));
      tools.append(copy);
    }
    if (last) tools.append(button('mini', t('again'), () => tryAgain(turn)));
    box.append(tools);
    return box;
  }

  function tryAgain(reply) {
    const i = turns.indexOf(reply);
    if (i < 1 || live) return;
    const user = turns[i - 1];
    // The turns go only once the new ask is on its way (a read that fails keeps them).
    run(user.action, { instruction: user.instruction || '', again: true, replace: [user, reply] });
  }

  // ── the cell function's counter ──

  function showCells(state) {
    const s = state || (globalThis.EdenCells ? EdenCells.state() : { used: 0, cap: 0, saved: 0 });
    $('cellsCount').textContent = t('cellsCount', { n: t.n(s.used), cap: t.n(s.cap) });
    $('cellsSaved').textContent = t('cellsSaved', { n: t.n(s.saved) });
    $('cellsMore').textContent = t('cellsMore', { n: 100 });
    $('cellsMore').hidden = !(s.used >= s.cap || s.paused > 0);
  }

  // ── wiring ──

  function grow() {
    const box = $('input');
    box.style.height = 'auto';
    box.style.height = `${Math.min(140, box.scrollHeight)}px`;
  }

  function translate() {
    for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
    for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle);
    for (const node of document.querySelectorAll('[data-i18n-aria]')) node.setAttribute('aria-label', t(node.dataset.i18nAria));
    for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.placeholder = t(node.dataset.i18nPlaceholder);
  }

  function submit() {
    if (live) return live.abort.abort();
    run('ask');
  }

  function wire() {
    $('form').addEventListener('submit', (e) => {
      e.preventDefault();
      submit();
    });
    $('input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!live) submit(); // Enter never stops an answer; the ■ button does
      }
    });
    $('input').addEventListener('input', grow);
    for (const chip of document.querySelectorAll('#actions .chip')) chip.addEventListener('click', () => run(chip.dataset.action));
    $('connectBtn').addEventListener('click', startConnect);
    $('disconnect').addEventListener('click', disconnect);
    $('clear').addEventListener('click', () => {
      if (live) live.abort.abort();
      turns = [];
      note('');
      render();
      $('input').focus();
    });
    $('cellsMore').addEventListener('click', () => {
      if (globalThis.EdenCells) EdenCells.allowMore(100);
    });
    $('cellsClear').addEventListener('click', () => {
      const n = globalThis.EdenCells ? EdenCells.clearSaved() : 0;
      note(t('forgot', { n: t.n(n) }));
    });
    $('cells').addEventListener('toggle', () => showCells());
    if (globalThis.EdenCells) EdenCells.onChange(showCells);
    // The ⋯ menu closes with Escape and with a click elsewhere.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('menu').open) {
        $('menu').open = false;
        $('menu').querySelector('summary').focus();
      }
    });
    document.addEventListener('click', (e) => {
      if ($('menu').open && !$('menu').contains(e.target)) $('menu').open = false;
      // Links open in the browser, not inside the pane.
      const a = e.target.closest && e.target.closest('a[target="_blank"]');
      const ui = globalThis.Office && Office.context && Office.context.ui;
      if (a && ui && typeof ui.openBrowserWindow === 'function') {
        e.preventDefault();
        ui.openBrowserWindow(a.href);
      }
    });
    // Another pane (another workbook) connected or disconnected: follow it.
    addEventListener('storage', (e) => {
      if (e.key !== X.TOKEN_KEY) return;
      const now = X.readToken();
      if (now === token) return;
      token = now;
      if (token && connecting) connecting.end('');
      setConnected(Boolean(token));
    });
  }

  function start(info) {
    inExcel = Boolean(info && globalThis.Office && info.host === Office.HostType.Excel);
    const lang = (globalThis.Office && Office.context && Office.context.displayLanguage) || navigator.language;
    t = X.wordsFor(lang);
    document.documentElement.lang = t.lang;
    translate();
    token = X.readToken();
    setConnected(Boolean(token));
    freshPkce();
    ready = true;
    note('');
    render();
    showCells();
    if (inExcel) {
      if (!paneHidden) showSelection();
      Excel.run(async (context) => {
        context.workbook.onSelectionChanged.add(watchSelection);
        try {
          context.workbook.worksheets.onActivated.add(watchSelection);
        } catch {
          // older Excel: the selection event covers most of it
        }
        await context.sync();
      }).catch(() => {});
      // A closed pane stops following the selection and catches up when shown again.
      try {
        const on = Office.addin && Office.addin.onVisibilityModeChanged((m) => shown(!(m && m.visibilityMode === 'Hidden')));
        if (on && on.catch) on.catch(() => {});
      } catch {
        // older Office: the page's own visibility below
      }
      document.addEventListener('visibilitychange', () => shown(document.visibilityState !== 'hidden'));
    } else {
      $('selAddr').textContent = t('openInExcelShort');
    }
  }

  // Wired at once, so a press before Office is ready says so instead of doing nothing.
  wire();
  $('selAddr').textContent = t('starting');
  if (globalThis.Office && typeof Office.onReady === 'function') Office.onReady(start);
  else start(null);
})();
