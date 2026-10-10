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
  let live = null; // { abort, turn } while an answer streams
  let inExcel = false;

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

  function startConnect() {
    const ui = globalThis.Office && Office.context && Office.context.ui;
    if (!ui || !ui.displayDialogAsync) return note('Open Ask Eden inside Excel to connect.', { kind: 'warn' });
    if (!pkce) return note('Getting ready… press Connect again in a moment.');
    const mine = pkce;
    pkce = null;
    freshPkce();
    $('connectBtn').disabled = true;
    $('connectBtn').textContent = t('connecting');
    const reset = () => {
      $('connectBtn').disabled = false;
      $('connectBtn').textContent = t('connect');
    };
    ui.displayDialogAsync(X.connectUrl({ origin: location.origin, state: mine.state, challenge: mine.challenge }), { height: 70, width: 40 }, (opened) => {
      if (opened.status !== Office.AsyncResultStatus.Succeeded) {
        reset();
        const blocked = opened.error && opened.error.code === 12009;
        return note(blocked ? 'Excel blocked the sign-in window. Allow pop-ups for Ask Eden and press Connect again.' : 'Couldn’t open the sign-in window. Press Connect again.', { kind: 'warn' });
      }
      const dialog = opened.value;
      dialog.addEventHandler(Office.EventType.DialogMessageReceived, async (arg) => {
        if (arg.origin && arg.origin !== location.origin) return;
        dialog.close();
        let message = null;
        try {
          message = JSON.parse(arg.message);
        } catch {
          message = null;
        }
        const back = X.readRedirect(message && message.url, mine.state);
        if (back.error) {
          reset();
          return note(back.error === 'access_denied' ? t('cancelled') : 'Connecting didn’t finish. Press Connect again.', { kind: 'warn' });
        }
        await redeem(back.code, mine.verifier);
        reset();
      });
      dialog.addEventHandler(Office.EventType.DialogEventReceived, (arg) => {
        reset();
        note(arg.error === 12006 ? t('cancelled') : 'The sign-in window closed. Press Connect again.', { kind: 'warn' });
      });
    });
  }

  async function redeem(code, verifier) {
    let res;
    try {
      res = await fetch('/api/eden/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(X.tokenBody({ code, verifier, origin: location.origin })) });
    } catch {
      return note(X.errorWords(0).words, { kind: 'warn' });
    }
    let answer = {};
    try {
      answer = await res.json();
    } catch {
      answer = {};
    }
    if (!res.ok || !X.saveToken(undefined, answer)) return note(answer.error || 'Connecting didn’t finish. Press Connect again.', { kind: 'warn' });
    token = answer.access_token;
    setConnected(true);
    note(t('connected'), { kind: 'ok' });
    // Cells that asked before the connection: work them out again (answers already saved stay saved).
    if (globalThis.EdenCells && EdenCells.takeNeedConnect() > 0 && inExcel) {
      Excel.run(async (context) => {
        context.application.calculate(Excel.CalculationType.full);
        await context.sync();
      }).catch(() => {});
    }
  }

  async function disconnect() {
    $('menu').open = false;
    const old = token;
    token = null;
    X.forgetToken();
    setConnected(false);
    note(t('disconnected'));
    if (old) await fetch('/api/eden/disconnect', { method: 'POST', headers: { authorization: `Bearer ${old}` } }).catch(() => {});
  }

  function signedOut() {
    token = null;
    X.forgetToken();
    setConnected(false);
  }

  globalThis.EdenPane = { token: () => token, signedOut };

  // ── the selection ──

  let selTimer = 0;
  function watchSelection() {
    clearTimeout(selTimer);
    selTimer = setTimeout(showSelection, 120);
  }

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
        $('selSize').textContent = n > 1 ? `${range.rowCount.toLocaleString()} × ${range.columnCount.toLocaleString()}` : '';
      });
    } catch {
      $('selAddr').textContent = t('noSelection');
      $('selSize').textContent = '';
    }
  }

  // ── reading what an action needs (only that) ──

  /** Clip a huge selection (whole columns or rows) to the part of the sheet that has data. */
  async function clipped(context, sheet, sel) {
    sel.load('address,rowCount,columnCount,rowIndex,columnIndex');
    await context.sync();
    if (sel.rowCount * sel.columnCount <= X.LIMITS.cells) return sel;
    const used = sheet.getUsedRangeOrNullObject(true);
    used.load('rowIndex,columnIndex,rowCount,columnCount');
    await context.sync();
    if (used.isNullObject) return sel;
    const r0 = Math.max(sel.rowIndex, used.rowIndex);
    const r1 = Math.min(sel.rowIndex + sel.rowCount, used.rowIndex + used.rowCount);
    let c0 = Math.max(sel.columnIndex, used.columnIndex);
    let c1 = Math.min(sel.columnIndex + sel.columnCount, used.columnIndex + used.columnCount);
    if (c1 <= c0) {
      // empty columns (a column to fill): keep the selected columns, on the rows with data
      c0 = sel.columnIndex;
      c1 = sel.columnIndex + sel.columnCount;
    }
    if (r1 <= r0) return sel;
    const part = sheet.getRangeByIndexes(r0, c0, r1 - r0, c1 - c0);
    part.load('address,rowCount,columnCount,rowIndex,columnIndex');
    await context.sync();
    return part;
  }

  /**
   * What the action sends and what applying it needs. { sheet, active, job } or { error }.
   * `job` remembers where the answer goes (addresses, what was sent) for Insert / Fill / Replace.
   */
  function readFor(action) {
    return Excel.run(async (context) => {
      const ws = context.workbook.worksheets.getActiveWorksheet();
      ws.load('name');
      const activeCell = context.workbook.getActiveCell();
      activeCell.load('address,formulas,values');
      const sel = context.workbook.getSelectedRange();
      await context.sync();
      const name = ws.name;
      const active = { address: X.cellsOf(activeCell.address) };

      if (action === 'table') return { sheet: { name }, active, job: { sheet: name, at: X.cellsOf(activeCell.address) } };

      let range = await clipped(context, ws, sel);
      const tooBig = X.sizeProblem(action, range.rowCount, range.columnCount);
      if (tooBig && action !== 'formula' && action !== 'explain') return { error: tooBig };

      if (action === 'formula' || action === 'explain') {
        // Context only: a single cell borrows the sheet's data around it; a big selection is trimmed.
        if (range.rowCount * range.columnCount === 1) {
          const used = ws.getUsedRangeOrNullObject(true);
          used.load('address,rowCount,columnCount');
          await context.sync();
          if (!used.isNullObject && used.rowCount * used.columnCount > 1) range = used;
        }
        const width = Math.max(1, range.columnCount);
        const rows = Math.max(1, Math.min(range.rowCount, Math.floor(X.LIMITS.cells / width)));
        const part = range.getResizedRange(rows - range.rowCount, 0);
        part.load(action === 'explain' ? 'values,text,formulas' : 'values,text');
        await context.sync();
        const fit = X.fitRows(X.gridOf(part.values, part.text));
        const sheet = { name, range: X.cellsOf(range.address), values: fit.values };
        if (action === 'explain') {
          const f = X.formulaGrid(part.formulas.slice(0, fit.rows));
          if (f) sheet.formulas = f;
          const own = activeCell.formulas[0][0];
          if (typeof own === 'string' && own.startsWith('=')) active.formula = own;
          active.value = String(activeCell.values[0][0] ?? '');
        }
        return { sheet: X.hasData(sheet.values) || sheet.formulas ? sheet : { name }, active, job: { sheet: name, at: active.address } };
      }

      range.load(action === 'clean' ? 'values,text,formulas' : 'values,text');
      await context.sync();
      let values = X.gridOf(range.values, range.text);
      let address = X.cellsOf(range.address);
      const job = { sheet: name, source: address, rows: range.rowCount };

      if (action === 'fill') {
        if (range.columnCount === 1 && !X.hasData(values)) {
          // One empty column selected: fill it from the columns to its left, on the same rows.
          const used = ws.getUsedRangeOrNullObject(true);
          used.load('columnIndex');
          await context.sync();
          if (used.isNullObject || used.columnIndex >= range.columnIndex) return { error: 'Select the rows with data. Eden writes into the column to their right (or select an empty column next to your data).' };
          const left = ws.getRangeByIndexes(range.rowIndex, used.columnIndex, range.rowCount, range.columnIndex - used.columnIndex);
          left.load('address,values,text');
          await context.sync();
          values = X.gridOf(left.values, left.text);
          job.target = address;
          address = X.cellsOf(left.address);
          job.source = address;
          if (!X.hasData(values)) return { error: 'The rows next to that column are empty. Select the rows with data first.' };
        } else {
          const target = range.getLastColumn().getOffsetRange(0, 1);
          target.load('address');
          await context.sync();
          job.target = X.cellsOf(target.address);
        }
      }
      if (action === 'clean') {
        job.sent = values;
        job.formulas = range.formulas;
      }
      const sheet = { name, range: address, values };
      if (action === 'clean') {
        const f = X.formulaGrid(range.formulas);
        if (f) sheet.formulas = f;
      }
      if (action === 'ask' && !X.hasData(values)) return { sheet: { name, range: address }, active, job };
      return { sheet, active, job };
    });
  }

  // ── asking ──

  const LABEL = { ask: 'ask', analyze: 'analyze', formula: 'formula', explain: 'explain', fill: 'fill', clean: 'clean', table: 'table' };
  const PROMPT = { formula: 'phFormula', fill: 'phFill', table: 'phTable' };

  function busy(on) {
    document.body.classList.toggle('busy', on);
    for (const b of document.querySelectorAll('#actions .chip')) b.disabled = on;
    $('send').textContent = on ? '■' : '↑';
    $('send').setAttribute('aria-label', on ? t('stop') : t('ask'));
    $('send').title = on ? t('stop') : t('ask');
  }

  async function run(action, { instruction, again } = {}) {
    if (live) return;
    if (!token) {
      setConnected(false);
      return note(X.errorWords(401).words, { connect: true });
    }
    const words = instruction !== undefined ? instruction : $('input').value.trim();
    if (X.ACTIONS[action].instruction && !words) {
      $('input').placeholder = t(PROMPT[action] || 'placeholder');
      $('input').focus();
      return note(t(PROMPT[action] || 'placeholder'));
    }
    if (!inExcel) return note('Open Ask Eden inside Excel to use it.', { kind: 'warn' });
    note('');
    let read;
    try {
      read = await readFor(action);
    } catch (error) {
      return note(`Excel couldn’t read the selection${error && error.message ? ` (${error.message})` : ''}. Try again.`, { kind: 'warn' });
    }
    if (read.error) return note(read.error, { kind: 'warn' });
    const history = turns.filter((x) => !x.failed).map((x) => ({ role: x.role, text: x.text }));
    let built = X.sheetBody({ action, instruction: words, sheet: read.sheet, active: read.active, history });
    // A formula's surroundings are only context: when they're too much, send the active cell alone.
    if (built.error && (action === 'formula' || action === 'explain') && read.sheet && read.sheet.values) {
      built = X.sheetBody({ action, instruction: words, sheet: { name: read.sheet.name }, active: read.active, history });
    }
    if (built.error) return note(built.error, { kind: 'warn' });
    if (!again) {
      $('input').value = '';
      $('input').placeholder = t('placeholder');
      grow();
    }
    const user = { role: 'user', text: words || t(LABEL[action]), action, instruction: words };
    const reply = { role: 'eden', text: '', action, job: read.job, streaming: true };
    turns.push(user, reply);
    render();
    await stream(built.body, reply, user);
  }

  async function stream(body, reply, user) {
    const abort = new AbortController();
    live = { abort, turn: reply };
    busy(true);
    let res;
    try {
      res = await fetch('/api/eden/sheet', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: abort.signal });
    } catch {
      res = null;
    }
    if (!res || !res.ok) {
      let info = {};
      if (res) {
        try {
          info = await res.json();
        } catch {
          info = {};
        }
      }
      const err = abort.signal.aborted ? { words: '' } : X.errorWords(res ? res.status : 0, info.code, info.error);
      turns = turns.filter((x) => x !== reply && x !== user);
      if (!$('input').value) $('input').value = user.instruction || '';
      grow();
      live = null;
      busy(false);
      render();
      if (err.connect) signedOut();
      return note(err.words, { connect: err.connect, plan: err.plan, kind: 'warn' });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let frame = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        reply.text += decoder.decode(value, { stream: true });
        if (!frame) {
          frame = requestAnimationFrame(() => {
            frame = 0;
            drawLive();
          });
        }
      }
      reply.text += decoder.decode();
    } catch (error) {
      if (abort.signal.aborted) reply.stopped = true;
      else reply.broken = (error && error.message) || 'The answer broke off.';
    }
    cancelAnimationFrame(frame);
    reply.streaming = false;
    live = null;
    busy(false);
    finish(reply);
    render();
  }

  /** What an answer means for the sheet, once it's complete. */
  function finish(reply) {
    if (reply.stopped || reply.broken) {
      reply.result = { warn: reply.stopped ? 'Stopped. Nothing was changed.' : `${reply.broken} Try again.` };
      return;
    }
    const job = reply.job || {};
    if (reply.action === 'formula') {
      const formula = X.formulaOf(reply.text);
      reply.result = formula ? { formula } : { warn: 'Eden didn’t answer with a formula. Try again, or say more about what it should do.' };
    } else if (reply.action === 'fill') {
      const check = X.fillCheck(reply.text, job.rows);
      reply.result = check.error ? { warn: check.error } : { lines: check.lines };
    } else if (reply.action === 'clean') {
      const check = X.cleanCheck(reply.text, job.sent);
      if (check.error) reply.result = { warn: check.error };
      else {
        const changes = X.cleanChanges(job.sent, check.rows, job.formulas);
        reply.result = changes.length ? { changes } : { done: 'Nothing to clean: the selection already looks consistent.' };
      }
    } else if (reply.action === 'table') {
      const check = X.tableCheck(reply.text);
      reply.result = check.error ? { warn: check.error } : { table: check.rows };
    } else {
      reply.result = {};
    }
  }

  // ── applying (always shown first; nothing is written without a press) ──

  const filled = (values, formulas) => values.reduce((n, row, r) => n + row.filter((v, c) => v !== '' && v !== null || (formulas && typeof formulas[r][c] === 'string' && formulas[r][c].startsWith('='))).length, 0);

  async function apply(reply) {
    const res = reply.result;
    const job = reply.job;
    try {
      await Excel.run(async (context) => {
        const ws = context.workbook.worksheets.getItem(job.sheet);
        if (reply.action === 'formula' || reply.action === 'table') {
          let target = ws.getRange(job.at);
          if (reply.action === 'table') target = target.getResizedRange(res.table.length - 1, res.table[0].length - 1);
          target.load('address,values,formulas');
          await context.sync();
          const n = filled(target.values, target.formulas);
          if (n && !res.confirm) {
            res.confirm = reply.action === 'formula' ? `${X.cellsOf(target.address)} isn’t empty. Press Insert again to replace it.` : `${X.cellsOf(target.address)} has ${n} filled ${n === 1 ? 'cell' : 'cells'}. Press Insert again to replace ${n === 1 ? 'it' : 'them'}.`;
            return;
          }
          if (reply.action === 'formula') target.formulas = [[res.formula]];
          else {
            target.values = res.table.map((row) => row.map(X.safeCell));
            target.getRow(0).format.font.bold = true;
            target.format.autofitColumns();
          }
          target.select();
          await context.sync();
          res.confirm = '';
          res.done = reply.action === 'formula' ? `Inserted in ${X.cellsOf(target.address)}.` : `Inserted at ${X.cellsOf(target.address)}.`;
        } else if (reply.action === 'fill') {
          const target = ws.getRange(job.target);
          target.load('address,values,formulas,rowCount');
          await context.sync();
          if (target.rowCount !== res.lines.length) {
            res.warn = 'The selection changed. Run Fill column again.';
            return;
          }
          const n = filled(target.values, target.formulas);
          if (n && !res.confirm) {
            res.confirm = `${X.cellsOf(target.address)} has ${n} filled ${n === 1 ? 'cell' : 'cells'}. Press Fill again to replace ${n === 1 ? 'it' : 'them'}.`;
            return;
          }
          target.values = res.lines.map((line) => [X.safeCell(line)]);
          target.select();
          await context.sync();
          res.confirm = '';
          res.done = `Filled ${X.cellsOf(target.address)}.`;
        } else if (reply.action === 'clean') {
          const source = ws.getRange(job.source);
          source.load('values,text,formulas');
          await context.sync();
          // The cells must still be what Eden saw.
          const now = X.gridOf(source.values, source.text);
          if (JSON.stringify(now) !== JSON.stringify(job.sent)) {
            res.warn = 'The cells changed since Eden read them. Press Clean again.';
            return;
          }
          for (const ch of res.changes) {
            const f = source.formulas[ch.r][ch.c];
            if (typeof f === 'string' && f.startsWith('=')) continue; // never a formula
            source.getCell(ch.r, ch.c).values = [[X.safeCell(ch.to)]];
          }
          await context.sync();
          res.done = `Replaced ${res.changes.length} ${res.changes.length === 1 ? 'cell' : 'cells'}${job.formulas && X.formulaGrid(job.formulas) ? ' (formulas left as they were)' : ''}.`;
        }
      });
    } catch (error) {
      res.warn = `Excel couldn’t write that${error && error.message ? ` (${error.message})` : ''}.`;
    }
    render();
  }

  // ── drawing the conversation ──

  function render() {
    const log = $('log');
    log.replaceChildren(...turns.map((turn, i) => turnNode(turn, i === turns.length - 1)));
    if (!turns.length) log.append(el('p', 'empty', t('empty')));
    $('clear').hidden = !turns.length;
    log.scrollTop = log.scrollHeight;
  }

  function drawLive() {
    const box = document.querySelector('.turn.eden:last-child .body');
    if (!box || !live) return;
    paintBody(box, live.turn);
    $('log').scrollTop = $('log').scrollHeight;
  }

  const fillIn = (node, ...kids) => node.replaceChildren(...kids.filter(Boolean));

  function paintBody(body, turn) {
    const out = X.ACTIONS[turn.action] ? X.ACTIONS[turn.action].out : 'text';
    if (turn.streaming && !turn.text) return fillIn(body, el('div', 'thinking', el('i'), el('i'), el('i')));
    if (out === 'text') return drawText(body, turn.text);
    const res = turn.result || {};
    if (turn.streaming || (!res.formula && !res.lines && !res.changes && !res.table)) return fillIn(body, el('pre', 'raw', turn.text.trim()));
    if (res.formula) return fillIn(body, el('code', 'formula', res.formula));
    if (res.lines) {
      const at = topLeftOf(turn.job.target);
      const rows = res.lines.slice(0, 8).map((line, i) => el('tr', '', el('th', '', cellName(at, i, 0)), el('td', '', line || '—')));
      const more = res.lines.length > 8 ? el('p', 'muted', `…and ${res.lines.length - 8} more`) : null;
      return fillIn(body, el('p', '', `${res.lines.length} ${res.lines.length === 1 ? 'value' : 'values'} for ${turn.job.target}:`), el('div', 'grid', el('table', '', el('tbody', '', rows))), more);
    }
    if (res.changes) {
      const start = topLeftOf(turn.job.source);
      const rows = res.changes.slice(0, 10).map((ch) => el('tr', '', el('th', '', cellName(start, ch.r, ch.c)), el('td', '', el('span', 'from', ch.from || '—'), el('span', 'arrow', ' → '), ch.to || '—')));
      const more = res.changes.length > 10 ? el('p', 'muted', `…and ${res.changes.length - 10} more`) : null;
      return fillIn(body, el('p', '', `${res.changes.length} ${res.changes.length === 1 ? 'cell changes' : 'cells change'} in ${turn.job.source}:`), el('div', 'grid', el('table', 'diff', el('tbody', '', rows))), more);
    }
    if (res.table) {
      const [head, ...rest] = res.table;
      const tbl = el('table', '', el('thead', '', el('tr', '', head.map((h) => el('th', '', h)))), el('tbody', '', rest.slice(0, 8).map((row) => el('tr', '', row.map((c) => el('td', '', c))))));
      const more = rest.length > 8 ? el('p', 'muted', `…and ${rest.length - 8} more rows`) : null;
      return fillIn(body, el('p', '', `${res.table.length} rows × ${head.length} columns:`), el('div', 'grid', tbl), more);
    }
    return null;
  }

  function topLeftOf(cells) {
    const m = /\$?([A-Z]{1,3})\$?(\d+)/i.exec(String(cells || ''));
    if (!m) return { col: 0, row: 1 };
    let col = 0;
    for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
    return { col: col - 1, row: Number(m[2]) };
  }
  function cellName(start, r, c) {
    let n = start.col + c + 1;
    let letters = '';
    while (n > 0) {
      const k = (n - 1) % 26;
      letters = String.fromCharCode(65 + k) + letters;
      n = Math.floor((n - 1) / 26);
    }
    return `${letters}${start.row + r}`;
  }

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
    if (res.warn) box.append(el('p', 'warn', res.warn));
    if (res.confirm) box.append(el('p', 'warn', res.confirm));
    if (res.done) box.append(el('p', 'ok', res.done));
    const tools = el('div', 'tools');
    if (!res.done && !res.warn) {
      if (res.formula) tools.append(button('btn small', `Insert in ${turn.job.at}`, () => apply(turn)));
      if (res.lines) tools.append(button('btn small', `Fill ${turn.job.target}`, () => apply(turn)));
      if (res.changes) tools.append(button('btn small', 'Replace with cleaned data', () => apply(turn)));
      if (res.table) tools.append(button('btn small', `Insert table at ${turn.job.at}`, () => apply(turn)));
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
    turns = turns.slice(0, i - 1);
    render();
    run(user.action, { instruction: user.instruction || '', again: true });
  }

  // ── the cell function's counter ──

  function showCells(state) {
    const s = state || (globalThis.EdenCells ? EdenCells.state() : { used: 0, cap: 0, saved: 0 });
    $('cellsCount').textContent = t('cellsCount', { n: s.used, cap: s.cap });
    $('cellsSaved').textContent = t('cellsSaved', { n: s.saved });
    $('cellsMore').textContent = t('cellsMore', { n: 100 });
    $('cellsMore').hidden = s.used < s.cap;
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
    for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.placeholder = t(node.dataset.i18nPlaceholder);
  }

  function wire() {
    $('form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (live) return live.abort.abort();
      run('ask');
    });
    $('input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        $('form').requestSubmit();
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
    });
    $('cellsMore').addEventListener('click', () => EdenCells.allowMore(100));
    $('cellsClear').addEventListener('click', () => {
      const n = EdenCells.clearSaved();
      note(`Forgot ${n} saved ${n === 1 ? 'answer' : 'answers'}.`);
    });
    $('cells').addEventListener('toggle', () => showCells());
    if (globalThis.EdenCells) EdenCells.onChange(showCells);
    // Links open in the browser, not inside the pane.
    document.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[target="_blank"]');
      const ui = globalThis.Office && Office.context && Office.context.ui;
      if (a && ui && typeof ui.openBrowserWindow === 'function') {
        e.preventDefault();
        ui.openBrowserWindow(a.href);
      }
    });
  }

  function start(info) {
    inExcel = Boolean(info && globalThis.Office && info.host === Office.HostType.Excel);
    const lang = (globalThis.Office && Office.context && Office.context.displayLanguage) || navigator.language;
    t = X.wordsFor(lang);
    document.documentElement.lang = String(lang || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en';
    translate();
    token = X.readToken();
    setConnected(Boolean(token));
    freshPkce();
    wire();
    render();
    showCells();
    if (inExcel) {
      showSelection();
      Excel.run(async (context) => {
        context.workbook.onSelectionChanged.add(watchSelection);
        try {
          context.workbook.worksheets.onActivated.add(watchSelection);
        } catch {
          // older Excel: the selection event covers most of it
        }
        await context.sync();
      }).catch(() => {});
    } else {
      $('selAddr').textContent = 'Open in Excel';
    }
  }

  if (globalThis.Office && typeof Office.onReady === 'function') Office.onReady(start);
  else start(null);
})();
