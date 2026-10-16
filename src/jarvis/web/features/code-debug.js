// Eden Code's Debug pane (features/code_debugger.py, code_dap.py), from the More menu: the
// session's debug run (who has it, where it's stopped, the stack, a frame's variables to
// open, expressions, breakpoints, the program's output), Take over / Hand back, and the
// buttons that move it. With no run: which debuggers are here (how to install a missing one:
// Eden never installs it) and a run of the owner's own to start.
// Settings › Eden Code › General: the Debugger switch (prefs.features.code_debugger).
// Pure helpers are exported for node --test (tests/web/code-debug.test.mjs).
(function (root) {
  'use strict';

  const ASK_AGAIN_MS = 10000;  // a pane shown longer than this asks again when drawn
  const EVALS_KEPT = 12;

  // What a run's state reads as.
  function stateWords(run) {
    if (!run) return '';
    if (run.state === 'starting') return 'Starting';
    if (run.state === 'running') return 'Running';
    if (run.state === 'ended') return run.reason || 'Ended';
    // (whole sentences: the window translates by whole sentences)
    return { breakpoint: 'Stopped at a breakpoint', 'function breakpoint': 'Stopped at a breakpoint', step: 'Stopped after a step', exception: 'Stopped on an exception', pause: 'Paused', entry: 'Stopped at the start' }[run.reason] || 'Stopped';
  }

  // "src/app.py:42" or "app.py:42 if x > 1" -> { file, line, condition }, or null.
  function parseBreakpoint(text) {
    const m = /^\s*(.+?):(\d+)(?:\s+if\s+(.+))?\s*$/.exec(String(text || ''));
    if (!m) return null;
    const line = Number(m[2]);
    if (!Number.isInteger(line) || line < 1) return null;
    return { file: m[1], line, ...(m[3] ? { condition: m[3].trim() } : {}) };
  }

  // A path inside the session's folder, shown relative to it.
  function shortPath(file, folder) {
    const f = String(file || '');
    const r = String(folder || '').replace(/\/+$/, '');
    if (r && f.startsWith(`${r}/`)) return f.slice(r.length + 1);
    if (r && f.startsWith(`/private${r}/`)) return f.slice(r.length + 9);  // (macOS's /tmp is /private/tmp)
    return f;
  }

  // The command in an install hint, to copy ("…Install it with: python3 -m pip install debugpy").
  function installCommand(hint) {
    const m = /(?:with|tools):\s*(.+?)\s*$/.exec(String(hint || ''));
    return m ? m[1] : '';
  }

  // Which buttons a run has: moving ones only when they make sense.
  function controls(run) {
    if (!run || run.state === 'ended') return [];
    const stopped = run.state === 'stopped';
    return [
      ['continue', 'Continue', stopped],
      ['next', 'Step over', stopped],
      ['stepIn', 'Step into', stopped],
      ['stepOut', 'Step out', stopped],
      ['pause', 'Pause', run.state === 'running'],
      ['stop', 'Stop', true],
    ];
  }

  const api = { stateWords, parseBreakpoint, shortPath, installCommand, controls };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el } = F;
  const t = (x) => (F.t ? F.t(x) : x);
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  let state = null;  // the latest dbg_state for the session on show
  let askedAt = 0;
  let askedFor = null;
  let children = new Map();  // variable ref -> its children (dbg_vars)
  let open = new Set();  // refs opened
  let evals = [];  // [{expression, result | error}]
  let error = '';
  let frameShown = null;
  let busy = false;

  function shown() { return typeof currentPane !== 'undefined' && currentPane === 'cw-debug' && F.$ && F.$('jc-pane') && !F.$('jc-pane').hidden; }
  function task() { return F.currentTask ? F.currentTask() : null; }
  function taskId() { const s = task(); return s ? s.id : 0; }
  function folder() { const s = task(); return s ? s.path || '' : ''; }

  function ask() {
    askedAt = Date.now();
    askedFor = taskId();
    if (askedFor) F.send({ type: 'dbg_state', id: askedFor });
  }

  function act(action, extra = {}) {
    error = '';
    busy = action !== 'expand' && action !== 'evaluate';
    F.send({ type: 'dbg_do', id: taskId(), action, ...extra });
    redraw();
  }

  function button(label, cls, run, title) {
    const b = el('button', cls, label);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', run);
    return b;
  }

  // ── a run ──

  function varRows(vars, depth = 0) {
    const ul = el('ul', 'dbg-vars');
    for (const v of vars || []) {
      const li = el('li', 'dbg-var');
      li.style.paddingLeft = `${depth * 14}px`;
      const head = el('div', 'dbg-var-row');
      if (v.ref) {
        const isOpen = open.has(v.ref);
        const tw = button(isOpen ? '▾' : '▸', 'dbg-twist', () => {
          if (open.has(v.ref)) open.delete(v.ref);
          else { open.add(v.ref); if (!children.has(v.ref)) act('expand', { ref: v.ref }); }
          redraw();
        }, isOpen ? 'Close' : 'Open');
        tw.setAttribute('aria-expanded', String(isOpen));
        head.append(tw);
      } else head.append(el('span', 'dbg-twist-gap'));
      head.append(mine(el('span', v.value ? 'dbg-name' : 'dbg-name bare', v.name)));
      if (v.value) head.append(mine(el('span', 'dbg-value', v.value)));
      if (v.type) head.append(mine(el('small', 'dbg-type', v.type)));
      li.append(head);
      if (v.ref && open.has(v.ref)) {
        const kids = children.get(v.ref);
        li.append(kids ? varRows(kids, depth + 1) : el('p', 'jc-dim dbg-loading', 'Loading…'));
      }
      ul.append(li);
    }
    return ul;
  }

  function drawRun(run, parts) {
    const head = el('div', 'dbg-head');
    const pill = el('span', `dbg-state ${run.state}`, stateWords(run));
    head.append(pill, mine(el('small', 'jc-dim dbg-target', `${run.adapter} · ${run.target}`)));
    parts.push(head);
    const who = el('div', 'dbg-who');
    const theirs = run.control === 'user';
    who.append(el('span', '', theirs ? 'You have the debugger' : 'Eden Code has the debugger'));
    if (run.state !== 'ended') {
      who.append(theirs
        ? button('Hand back', 'jc-mini', () => act('release'), 'Let the session drive it again')
        : button('Take over', 'jc-mini', () => act('take'), 'Drive it yourself: the session waits until you hand it back'));
    }
    parts.push(who);
    const bar = el('div', 'dbg-bar');
    for (const [action, label, enabled] of controls(run)) {
      const b = button(label, `jc-btn small${action === 'stop' ? ' danger' : ''}`, () => act(action));
      b.disabled = !enabled || (busy && action !== 'stop');
      bar.append(b);
    }
    if (bar.childNodes.length) parts.push(bar);
    if (run.exception) parts.push(mine(el('pre', 'dbg-exception', run.exception)));
    if (run.state === 'stopped' && (run.frames || []).length) {
      parts.push(el('h3', 'ch-head', 'Stack'));
      const ul = el('ul', 'jc-list dbg-frames');
      run.frames.forEach((f, i) => {
        const li = el('li');
        const b = button('', `dbg-frame${(frameShown == null ? i === 0 : frameShown === f.id) ? ' on' : ''}`, () => { frameShown = f.id; open = new Set(); act('frame', { frame: f.id }); });
        b.append(mine(el('span', 'dbg-fname', f.name)), mine(el('small', 'dbg-floc', `\u200e${shortPath(f.file, folder())}:${f.line}`)));  // (LRM: the path reads left to right in its right-to-left box, code-debug.css)
        b.lastChild.title = `${f.file}:${f.line}`;
        li.append(b);
        ul.append(li);
      });
      parts.push(ul);
    }
    for (const scope of run.scopes || []) {
      parts.push(el('h3', 'ch-head', scope.name));
      if (scope.expensive && !(scope.variables || []).length) {
        parts.push(varRows([{ name: t('(large: open it)'), value: '', ref: scope.ref }]));
      } else parts.push(varRows(scope.variables));
    }
    if (run.state === 'stopped') {
      const form = el('form', 'dbg-eval');
      const input = el('input', 'jc-field');
      input.id = 'dbg-eval-input';
      input.placeholder = t('Evaluate an expression where it’s stopped');
      input.setAttribute('aria-label', t('Expression'));
      form.append(input, button('Evaluate', 'jc-mini', () => {}, ''));
      form.lastChild.type = 'submit';
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const expression = input.value.trim();
        if (!expression) return;
        act('evaluate', { expression, ...(frameShown != null ? { frame: frameShown } : {}) });
        input.value = '';
      });
      parts.push(form);
    }
    if (evals.length) {
      const ul = el('ul', 'dbg-evals');
      for (const e of evals) {
        const li = el('li');
        li.append(mine(el('code', 'dbg-expr', e.expression)), mine(el('span', e.error ? 'dbg-bad' : 'dbg-value', e.error || e.result)));
        ul.append(li);
      }
      parts.push(ul);
    }
    drawBreakpoints(run, parts);
    if ((run.output || []).length) {
      parts.push(el('h3', 'ch-head', 'Output'));
      parts.push(mine(el('pre', 'dbg-output', run.output.join('\n'))));
    }
    const limits = el('p', 'jc-dim dbg-limits');
    limits.textContent = `${t('Steps')} ${run.steps}/${run.steps_max} · ${Math.floor(run.seconds / 60)}/${Math.round(run.seconds_max / 60)} min`;
    parts.push(limits);
  }

  function drawBreakpoints(run, parts) {
    if (run.state === 'ended') return;
    parts.push(el('h3', 'ch-head', 'Breakpoints'));
    const ul = el('ul', 'jc-list dbg-bps');
    for (const [file, bps] of Object.entries(run.breakpoints || {})) {
      for (const bp of bps) {
        const li = el('li');
        const where = mine(el('span', bp.verified === false ? 'dbg-bad' : '', `${shortPath(file, folder())}:${bp.line}${bp.condition ? ` if ${bp.condition}` : ''}`));
        li.append(where);
        if (bp.verified === false && bp.message) li.append(mine(el('small', 'jc-dim', bp.message)));
        li.append(button('Remove', 'jc-mini', () => act('breakpoint', { file, line: bp.line, on: false })));
        ul.append(li);
      }
    }
    if (ul.childNodes.length) parts.push(ul);
    const form = el('form', 'dbg-eval');
    const input = el('input', 'jc-field');
    input.id = 'dbg-bp-input';
    input.placeholder = t('file:line (or file:line if condition)');
    input.setAttribute('aria-label', t('Add a breakpoint'));
    const add = button('Add', 'jc-mini', () => {});
    add.type = 'submit';
    form.append(input, add);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const bp = parseBreakpoint(input.value);
      if (!bp) { error = t('Write it as file:line, e.g. src/app.py:42'); redraw(); return; }
      act('breakpoint', { ...bp, on: true });
      input.value = '';
    });
    parts.push(form);
  }

  // ── no run ──

  function drawStart(parts) {
    const adapters = (state && state.adapters) || [];
    parts.push(el('p', 'jc-dim', 'No debug run in this session. Eden Code starts one itself when it debugs a failing test, or start your own here.'));
    parts.push(el('h3', 'ch-head', 'Debuggers'));
    const ul = el('ul', 'jc-list ch-list');
    for (const a of adapters) {
      const li = el('li', 'ch-row');
      li.append(mine(el('span', 'ch-label', a.name)), el('span', `ch-state ${a.available ? 'ok' : 'unknown'}`, a.available ? 'Ready' : 'Not installed'));
      li.append(mine(el('small', 'jc-dim', a.languages.join(', '))));
      ul.append(li);
      if (!a.available && a.install) {
        const hint = el('li', 'dbg-hint');
        hint.append(mine(el('small', 'jc-dim', a.install)));
        const cmd = installCommand(a.install);
        if (cmd) {
          const copy = button('Copy', 'jc-mini', async () => {
            try { await navigator.clipboard.writeText(cmd); copy.textContent = t('Copied'); } catch (_) { copy.textContent = t('Couldn’t copy'); }
            setTimeout(() => { copy.textContent = t('Copy'); }, 1400);
          }, 'Copy the command (Eden never installs it for you)');
          hint.append(copy);
        }
        ul.append(hint);
      }
    }
    parts.push(ul);
    const ready = adapters.filter((a) => a.available);
    if (!ready.length || !(state && state.on)) {
      if (state && !state.on) parts.push(el('p', 'jc-dim', 'The debugger is off (Settings › Eden Code › General).'));
      return;
    }
    parts.push(el('h3', 'ch-head', 'Start a run'));
    const form = el('form', 'dbg-start');
    const pick = el('select', 'jc-field');
    pick.id = 'dbg-language';
    pick.setAttribute('aria-label', t('Debugger'));
    for (const a of ready) {
      const o = mine(el('option', '', `${a.name} (${a.languages.join(', ')})`));
      o.value = a.id;
      pick.append(o);
    }
    pick.value = ready[0].id;
    const program = el('input', 'jc-field');
    program.id = 'dbg-program';
    program.placeholder = t('Program in the project (or a Python module: -m pytest)');
    program.setAttribute('aria-label', t('Program'));
    const args = el('input', 'jc-field');
    args.id = 'dbg-args';
    args.placeholder = t('Arguments');
    args.setAttribute('aria-label', t('Arguments'));
    const entry = el('label', 'dbg-check');
    const box = el('input');
    box.type = 'checkbox';
    box.id = 'dbg-entry';
    entry.append(box, el('span', '', 'Stop at the start'));
    const go = button('Start', 'jc-btn small', () => {});
    go.type = 'submit';
    form.append(pick, program, args, entry, go);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const what = program.value.trim();
      if (!what) { error = t('Say which program to debug.'); redraw(); return; }
      const m = /^-m\s+(\S+)$/.exec(what);
      act('launch', { language: pick.value, ...(m ? { module: m[1] } : { program: what }), args: args.value, stop_on_entry: box.checked });
    });
    parts.push(form);
  }

  // ── drawing, keeping what's being typed ──

  function draw(body) {
    const typing = {};
    for (const id of ['dbg-eval-input', 'dbg-bp-input', 'dbg-program', 'dbg-args', 'dbg-language']) {
      const node = body.querySelector ? body.querySelector(`#${id}`) : null;
      if (node) typing[id] = { value: node.value, focused: typeof document !== 'undefined' && document.activeElement === node };
    }
    const parts = [];
    if (!task()) parts.push(el('p', 'jc-empty', 'Open a session to debug in.'));
    else if (!state || state.id !== taskId()) parts.push(el('p', 'jc-empty', 'Checking…'));
    else if (state.run) drawRun(state.run, parts);
    else drawStart(parts);
    if (error) parts.push(mine(el('p', 'dbg-bad dbg-error', error)));
    body.replaceChildren(...parts);
    for (const [id, was] of Object.entries(typing)) {
      const node = body.querySelector(`#${id}`);
      if (!node) continue;
      node.value = was.value;
      if (was.focused && node.focus) node.focus();
    }
  }

  function redraw() { if (shown()) draw(F.$('jc-pane-body')); }

  F.registerPane('cw-debug', {
    title: 'Debug',
    render(body) {
      if (!state || askedFor !== taskId() || Date.now() - askedAt > ASK_AGAIN_MS) {
        if (Date.now() - askedAt > 800 || askedFor !== taskId()) ask();
      }
      draw(body);
    },
  });
  if (F.registerMoreItem) F.registerMoreItem({ label: 'Debug', run: () => F.openPane('cw-debug') });

  F.on('dbg_state', (ev) => {
    if (!ev || ev.id !== taskId()) return;
    const was = state && state.id === ev.id ? state : null;
    if (was && was.run && ev.run && JSON.stringify(was.run.frames) !== JSON.stringify(ev.run.frames)) { children = new Map(); open = new Set(); frameShown = null; }
    state = { ...ev, adapters: ev.adapters || (was ? was.adapters : []) };
    if (!ev.run && was && was.run) ask();  // (its run gone: which debuggers there are, again)
    busy = false;
    redraw();
  });
  F.on('dbg_vars', (ev) => {
    if (!ev || ev.id !== taskId()) return;
    children.set(ev.ref, ev.variables || []);
    redraw();
  });
  F.on('dbg_eval', (ev) => {
    if (!ev || ev.id !== taskId()) return;
    evals = [{ expression: ev.expression, result: ev.result, error: ev.error }, ...evals].slice(0, EVALS_KEPT);
    redraw();
  });
  F.on('dbg_error', (ev) => {
    if (!ev || ev.id !== taskId()) return;
    error = ev.error || 'The debugger failed.';
    busy = false;
    redraw();
  });

  // ── Eden Code settings › General › Debugger ──
  let sw = null;
  let on = true;
  function build() {
    const general = typeof document !== 'undefined' && document.getElementById('jcs-general');
    if (!general || document.getElementById('dbg-setting')) return;
    const label = el('p', 'jcs-label', t('Debugger'));
    const group = el('div', 'jcs-group');
    const row = el('div', 'jcs-row');
    const words = el('span');
    words.append(document.createTextNode(t('A real debugger for sessions')),
      el('small', '', t('Sessions can run a program or a failing test under a debugger (breakpoints, stepping, the stack and variables) instead of guessing; you can take over in the Debug pane. Off: no debugger tools.')));
    sw = el('button', 'jcs-switch');
    sw.type = 'button';
    sw.id = 'dbg-setting';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', t('A real debugger for sessions'));
    sw.setAttribute('aria-checked', 'true');
    sw.addEventListener('click', () => {
      on = !on;
      sw.setAttribute('aria-checked', String(on));
      F.send({ type: 'feature_prefs', changes: { code_debugger: on } });
    });
    row.append(words, sw);
    group.append(row);
    const foot = general.querySelector('.jcs-foot');
    if (foot) general.insertBefore(label, foot); else general.append(label);
    general.insertBefore(group, label.nextSibling);
  }
  const take = (features) => {
    on = !features || features.code_debugger !== false;
    if (sw) sw.setAttribute('aria-checked', String(on));
  };
  build();
  F.on('prefs', (ev) => take(ev.features), { replay: true });
  F.on('hello', (ev) => take(ev.prefs && ev.prefs.features), { replay: true });
})(typeof window === 'object' ? window : globalThis);
