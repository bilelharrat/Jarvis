// Jarvis Code checks its work (features/code_verify.py): the Preview pane (the project's
// dev servers, their logs), the Tests pane (runs, the failures as a tree, watch mode) and
// the Problems pane (the project's own checkers), with the More menu's ways in.
//
// Everything shown from the backend is data: text only (textContent), user data marked
// data-no-i18n. Pure helpers are exported for node --test (tests/web/code-verify.test.mjs).
(function (root) {
  'use strict';

  const LOG_KEPT = 1500;  // lines the logs view keeps (the backend keeps 2000)

  // A server's state as the pane says it.
  const SERVER_STATES = {
    starting: 'Starting…', ready: 'Running', running: 'Running', exited: 'Exited',
    stopped: 'Stopped', failed: 'Didn’t start',
  };
  function serverState(server) {
    if (!server) return { text: 'Not running', dot: 'idle', live: false };
    const live = ['starting', 'ready', 'running'].includes(server.status);
    const dot = server.status === 'ready' || server.status === 'running' ? 'waiting'
      : server.status === 'starting' ? 'busy' : server.status === 'failed' || server.status === 'exited' ? 'failed' : 'idle';
    return { text: SERVER_STATES[server.status] || server.status, dot, live };
  }

  // An address on this Mac, shortened for a button: "localhost:5173".
  function shortUrl(url) {
    try {
      const u = new URL(url);
      return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname && u.pathname !== '/' ? u.pathname : ''}`;
    } catch (_) { return String(url || ''); }
  }

  // Only addresses on this Mac are opened from the pane.
  function isLocal(url) {
    try {
      const u = new URL(url);
      if (!['http:', 'https:'].includes(u.protocol)) return false;
      const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
    } catch (_) { return false; }
  }

  // New log lines onto what's shown, oldest dropped past `kept`; lines already there
  // (by number) aren't added twice.
  function mergeLines(have, lines, kept = LOG_KEPT) {
    const last = have.length ? have[have.length - 1][0] : 0;
    const fresh = lines.filter(([n]) => n > last);
    const out = have.concat(fresh);
    return out.length > kept ? out.slice(out.length - kept) : out;
  }

  // A problem as an @-mention for the composer: the file, and its line.
  function mentionFor(p) {
    if (!p || !p.file) return '';
    return `@${p.file}${p.line ? `#L${p.line}` : ''} `;
  }

  function countProblems(problems) {
    const out = { errors: 0, warnings: 0 };
    for (const p of problems || []) {
      if (p.severity === 'error') out.errors += 1; else out.warnings += 1;
    }
    return out;
  }

  // Problems by file, in the order the files first come.
  function byFile(problems) {
    const files = new Map();
    for (const p of problems || []) {
      const key = p.file || '';
      if (!files.has(key)) files.set(key, []);
      files.get(key).push(p);
    }
    return [...files.entries()];
  }

  // A test run's line, in pieces (each its own text, for its translation): ["Running…",
  // "12 s"], ["40 passed", "2 failed", "3.4 s"].
  function runLine(run) {
    if (!run) return [];
    const secs = `${run.seconds < 10 ? run.seconds.toFixed(1) : Math.round(run.seconds)} s`;
    if (run.status === 'running') return ['Running…', secs];
    if (run.message && !run.summary) return [run.message];
    return [...(run.summary ? run.summary.split(' · ') : ['No results']), secs];
  }

  const api = { serverState, shortUrl, isLocal, mergeLines, mentionFor, countProblems, byFile, runLine };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, t } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  const state = {
    info: null,  // the latest cv_state: this project's configs, suggestions, problems
    servers: [],  // every dev server, across projects
    logKey: '',  // the server whose output the logs view shows
    logs: new Map(),  // key -> [[n, text], ...]
  };

  function paneShown(id) {
    return typeof currentPane !== 'undefined' && currentPane === id && !F.$('jc-pane').hidden;
  }

  // Pieces of a line, each its own text node (so each is translated), joined by " · ".
  function pieces(cls, parts) {
    const span = el('span', cls);
    parts.forEach((part, i) => {
      if (i) span.append(document.createTextNode(' · '));
      span.append(el('span', '', part));
    });
    return span;
  }

  function button(label, cls, run) {
    const b = el('button', cls || 'jc-btn small', label);
    b.type = 'button';
    b.addEventListener('click', run);
    return b;
  }

  function where() {
    const task = F.currentTask();
    return task ? { id: task.id } : { directory: typeof deckProject !== 'undefined' ? deckProject : '' };
  }

  function openAddress(url) {
    if (!isLocal(url)) return;
    const app = root.jarvisApp;
    if (app && app.browser) {
      if (typeof toggleBrowser === 'function') toggleBrowser(true);
      app.browser.nav('go', url);
    } else {
      root.open(url, '_blank', 'noopener');
    }
  }

  // ── the Preview pane: dev servers ──

  function serverRow(config, server) {
    const li = el('li', 'cv-server');
    const s = serverState(server);
    const head = el('div', 'cv-server-head');
    head.append(el('span', `jc-dot ${s.dot}`), mine(el('strong', '', config.name)), el('span', 'cv-chip', s.text));
    const actions = el('div', 'cv-actions');
    if (s.live) {
      actions.append(
        button('Restart', 'jc-mini', () => F.send({ type: 'cv_server', action: 'restart', key: server.key })),
        button('Stop', 'jc-mini', () => F.send({ type: 'cv_server', action: 'stop', key: server.key })),
      );
    } else {
      actions.append(button('Start', 'jc-mini', () => F.send({ type: 'cv_server', action: 'start', name: config.name, ...where() })));
    }
    if (server) {
      const logs = button(state.logKey === server.key ? 'Hide logs' : 'Logs', 'jc-mini', () => showLogs(state.logKey === server.key ? '' : server.key));
      actions.append(logs);
    }
    head.append(el('span', 'jc-spacer'), actions);
    const cmd = mine(el('code', 'cv-cmd', config.command + (config.cwd ? `   (in ${config.cwd}/)` : '')));
    li.append(head);
    if (s.live && server.url) {
      const link = button(shortUrl(server.url), 'cv-link', () => openAddress(server.url));
      link.title = t('Open in the browser');
      mine(link);
      const row = el('div', 'cv-link-row');
      row.append(link);
      li.append(row);
    }
    li.append(cmd);
    const note = server && server.message ? server.message : '';
    if (note) li.append(el('small', 'cv-note', note));
    return li;
  }

  function suggestionRow(s) {
    const li = el('li', 'cv-server cv-suggestion');
    const head = el('div', 'cv-server-head');
    head.append(mine(el('strong', '', s.name)), el('span', 'jc-spacer'),
      button('Save', 'jc-mini', () => F.send({ type: 'cv_save', name: s.name, ...where() })));
    li.append(head, mine(el('code', 'cv-cmd', s.command + (s.cwd ? `   (in ${s.cwd}/)` : ''))), mine(el('small', 'cv-note', s.why)));
    return li;
  }

  function showLogs(key) {
    state.logKey = key;
    if (key) F.send({ type: 'cv_logs', key, since: 0 });
    renderPreview();
  }

  function logView() {
    const server = state.servers.find((s) => s.key === state.logKey);
    if (!server) return null;
    const box = el('div', 'cv-logs');
    const head = el('div', 'cv-logs-head');
    head.append(el('strong', '', 'Output'), mine(el('span', 'jc-dim', server.name)), el('span', 'jc-spacer'),
      button('Clear view', 'jc-mini', () => { state.logs.set(server.key, []); drawLog(); }));
    const pre = mine(el('pre', 'jc-code cv-log'));
    pre.id = 'cv-log';
    box.append(head, pre);
    requestAnimationFrame(drawLog);
    return box;
  }

  function drawLog() {
    const pre = F.$('cv-log');
    if (!pre) return;
    const lines = state.logs.get(state.logKey) || [];
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    pre.textContent = lines.map(([, text]) => text).join('\n') || t('Nothing yet.');
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  }

  function renderPreview(body = F.$('jc-pane-body')) {
    if (!paneShown('cv-preview') || !body) return;
    const info = state.info;
    if (!info) { body.replaceChildren(el('p', 'jc-empty', 'Looking at the project…')); return; }
    const parts = [];
    const ours = state.servers.filter((s) => s.project === info.path);
    const list = el('ul', 'jc-list cv-servers');
    for (const config of info.configs) list.append(serverRow(config, ours.find((s) => s.name === config.name)));
    parts.push(el('p', 'jc-label cv-head', 'Dev servers'));
    if (info.configs.length) parts.push(list);
    else parts.push(el('p', 'jc-dim cv-intro', 'No dev servers yet. Save a suggestion below, or add one to .claude/launch.json.'));
    if (info.problems && info.problems.length) {
      const warn = el('ul', 'cv-problems-list');
      warn.append(...info.problems.map((p) => mine(el('li', '', p))));
      parts.push(warn);
    }
    if (info.suggestions.length) {
      parts.push(el('p', 'jc-label cv-head', 'Suggested'));
      parts.push(el('p', 'jc-dim cv-intro', 'Read from the project. Nothing runs until you save one and start it.'));
      const sug = el('ul', 'jc-list cv-servers');
      sug.append(...info.suggestions.map(suggestionRow));
      parts.push(sug);
    }
    const logs = logView();
    if (logs) parts.push(logs);
    body.replaceChildren(...parts);
  }

  F.registerPane('cv-preview', {
    title: 'Preview',
    render(body) {
      state.info = null;
      renderPreview(body);
      F.send({ type: 'cv_state', ...where() });
    },
  });
  F.registerMoreItem({ label: 'Preview and dev servers', run: () => F.openPane('cv-preview') });

  F.on('cv_state', (ev) => {
    state.info = ev;
    if (Array.isArray(ev.servers)) {
      const others = state.servers.filter((s) => s.project !== ev.path);
      state.servers = others.concat(ev.servers);
    }
    renderPreview();
  });
  F.on('devservers', (ev) => {
    state.servers = ev.items || [];
    renderPreview();
  });
  F.on('cv_logs', (ev) => {
    state.logs.set(ev.key, mergeLines([], ev.lines || []));
    if (ev.key === state.logKey) drawLog();
  });
  F.on('devserver_log', (ev) => {
    if (!state.logs.has(ev.key)) return;  // not being looked at: the backend keeps it
    state.logs.set(ev.key, mergeLines(state.logs.get(ev.key), ev.lines || []));
    if (ev.key === state.logKey) drawLog();
  });
  F.on('cv_error', (ev) => {
    if (typeof jcNote === 'function') jcNote(ev.text);
  });

  // ── the Tests pane ──

  const tests = {
    info: null,  // the latest cv_tests: suites, their files, the latest run, the watch
    suite: '',  // the suite chosen (its key)
    output: [],  // the run's output shown, [[n, text], ...]
    openFiles: new Set(),  // result files unfolded
    filter: '',
  };

  function send(msg) { F.send({ ...msg, ...where() }); }

  function suiteNow() {
    const info = tests.info;
    if (!info || !info.suites.length) return null;
    return info.suites.find((s) => s.key === tests.suite) || info.suites[0];
  }

  function runTarget(target) {
    const suite = suiteNow();
    if (suite) send({ type: 'cv_tests', action: 'run', suite: suite.key, ...target });
  }

  function caseRow(c) {
    const li = el('li', `cv-case ${c.status}`);
    const head = el('div', 'cv-case-head');
    head.append(el('span', `cv-mark ${c.status}`, c.status === 'failed' ? '✕' : c.status === 'passed' ? '✓' : '–'),
      mine(el('span', 'cv-case-name', c.name)));
    if (c.line) head.append(el('small', 'jc-dim', `line ${c.line}`));
    head.append(el('span', 'jc-spacer'));
    if (c.target) {
      const again = button('Run', 'jc-mini', () => runTarget({ test: c.target, file: c.file }));
      again.title = t('Run just this test');
      head.append(again);
    }
    li.append(head);
    if (c.status === 'failed' && c.message) li.append(mine(el('pre', 'jc-code cv-case-msg', c.message)));
    return li;
  }

  function resultsTree(run) {
    const box = el('div', 'cv-tree');
    for (const f of run.tree || []) {
      const det = el('details', 'jc-card cv-file');
      det.open = f.failed > 0 || tests.openFiles.has(f.file);
      det.addEventListener('toggle', () => { if (det.open) tests.openFiles.add(f.file); else tests.openFiles.delete(f.file); });
      const sum = el('summary');
      const counts = [f.failed ? `${f.failed} failed` : '', f.passed ? `${f.passed} passed` : '', f.skipped ? `${f.skipped} skipped` : ''].filter(Boolean);
      sum.append(el('span', `cv-mark ${f.failed ? 'failed' : 'passed'}`, f.failed ? '✕' : '✓'), mine(el('span', 'cv-file-name', f.file)),
        el('span', 'jc-spacer'), pieces('jc-dim cv-counts', counts));
      det.append(sum);
      const ul = el('ul', 'cv-cases');
      ul.append(...f.cases.map(caseRow));
      det.append(ul);
      box.append(det);
    }
    return box;
  }

  function outputView(open) {
    const det = el('details', 'cv-logs cv-output');
    det.open = open;
    const sum = el('summary', 'cv-logs-head');
    sum.append(el('strong', '', 'Output'));
    det.append(sum);
    const pre = mine(el('pre', 'jc-code cv-log'));
    pre.id = 'cv-test-log';
    det.append(pre);
    requestAnimationFrame(drawTestLog);
    return det;
  }

  function drawTestLog() {
    const pre = F.$('cv-test-log');
    if (!pre) return;
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    pre.textContent = tests.output.map(([, text]) => text).join('\n') || t('Nothing yet.');
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  }

  function filesList(suite) {
    const files = (tests.info.files || {})[suite.key] || [];
    if (!files.length) return null;
    const det = el('details', 'cv-files');
    det.append(el('summary', 'jc-label', 'Run one file'));
    const filter = el('input', 'jc-field cv-filter');
    filter.placeholder = t('Filter test files…');
    filter.value = tests.filter;
    const list = el('ul', 'jc-files-list');
    const draw = () => {
      const q = filter.value.trim().toLowerCase();
      tests.filter = filter.value;
      const shown = files.filter((f) => !q || f.toLowerCase().includes(q)).slice(0, 200);
      list.replaceChildren(...shown.map((f) => {
        const li = el('li');
        const b = mine(el('button', '', f));
        b.type = 'button';
        b.title = t('Run this file');
        b.addEventListener('click', () => runTarget({ file: f }));
        li.append(b);
        return li;
      }));
    };
    filter.addEventListener('input', draw);
    draw();
    det.append(filter, list);
    return det;
  }

  function renderTests(body = F.$('jc-pane-body')) {
    if (!paneShown('cv-tests') || !body) return;
    const info = tests.info;
    if (!info) { body.replaceChildren(el('p', 'jc-empty', 'Looking for the project’s tests…')); return; }
    if (!info.suites.length) {
      body.replaceChildren(el('p', 'jc-empty', 'No tests found: pytest, vitest, jest, go test, cargo test, swift test and xcodebuild test are looked for.'));
      return;
    }
    const parts = [];
    const suite = suiteNow();
    if (info.suites.length > 1) {
      const chips = el('div', 'cv-chips');
      for (const s of info.suites) {
        const b = mine(el('button', `cv-suite${s.key === suite.key ? ' on' : ''}`, s.label));
        b.type = 'button';
        b.addEventListener('click', () => { tests.suite = s.key; renderTests(); });
        chips.append(b);
      }
      parts.push(chips);
    }
    const head = el('div', 'cv-bar');
    head.append(mine(el('code', 'cv-cmd cv-bar-cmd', suite.command)), el('span', 'jc-spacer'));
    const run = info.run && info.run.suite === suite.id ? info.run : info.run;
    const running = run && run.status === 'running';
    if (!suite.ready) {
      parts.push(head, el('p', 'cv-problems-list', suite.why));
    } else {
      head.append(running ? button('Stop', 'jc-btn small danger', () => send({ type: 'cv_tests', action: 'stop' }))
        : button('Run all', 'jc-btn small filled', () => runTarget({})));
      parts.push(head);
      const watching = info.watch && info.watch.suite === suite.key;
      const sw = el('div', 'jc-audit-switch cv-switch');
      const label = el('span');
      label.append(el('strong', '', 'Watch'), el('small', '', 'Run again when the project’s files change.'));
      const toggle = el('button', `sw${watching ? ' on' : ''}`);
      toggle.type = 'button';
      toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-checked', String(!!watching));
      toggle.setAttribute('aria-label', t('Watch'));
      toggle.addEventListener('click', () => send({ type: 'cv_tests', action: 'watch', on: !watching, suite: suite.key }));
      sw.append(label, toggle);
      parts.push(sw);
    }
    if (run) {
      const line = el('div', `cv-runline ${run.status}`);
      line.append(el('span', `cv-mark ${run.status === 'passed' ? 'passed' : run.status === 'running' ? 'running' : 'failed'}`,
        run.status === 'passed' ? '✓' : run.status === 'running' ? '' : '✕'), pieces('', runLine(run)));
      if (run.target && (run.target.file || run.target.test)) line.append(mine(el('small', 'jc-dim', run.target.test || run.target.file)));
      line.append(el('span', 'jc-spacer'));
      const failed = run.counts && run.counts.failed;
      if (failed && !running && F.currentTask()) {
        line.append(button('Fix failures', 'jc-btn small tinted', () => send({ type: 'cv_tests', action: 'fix' })));
      }
      parts.push(line);
      if (!run.complete && run.status !== 'running') parts.push(el('p', 'jc-dim cv-intro', 'Read from the output: some results may be missing.'));
      if (run.tree && run.tree.length) parts.push(resultsTree(run));
      parts.push(outputView(running || !run.tree || !run.tree.length));
    }
    const files = suite.ready ? filesList(suite) : null;
    if (files) parts.push(files);
    body.replaceChildren(...parts);
  }

  F.registerPane('cv-tests', {
    title: 'Tests',
    render(body) {
      tests.info = null;
      renderTests(body);
      F.send({ type: 'cv_tests', action: 'state', ...where() });
    },
  });
  F.registerMoreItem({ label: 'Tests', run: () => F.openPane('cv-tests') });

  F.on('cv_tests', (ev) => {
    tests.info = ev;
    if (!ev.suites.some((s) => s.key === tests.suite)) tests.suite = ev.watch ? ev.watch.suite : '';
    tests.output = ev.run && ev.run.output ? mergeLines([], ev.run.output) : [];
    renderTests();
  });
  F.on('cv_tests_run', (ev) => {
    const info = tests.info;
    if (!info || ev.run.project !== info.path) return;
    const fresh = !info.run || info.run.started !== ev.run.started;
    if (fresh) tests.output = [];
    info.run = ev.run;
    renderTests();
  });
  F.on('cv_tests_out', (ev) => {
    const info = tests.info;
    if (!info || ev.project !== info.path) return;
    tests.output = mergeLines(tests.output, ev.lines || [], 3000);
    drawTestLog();
  });

  // ── the Problems pane ──

  const problems = { info: null };

  function insertMention(p) {
    const text = mentionFor(p);
    const input = F.$('deck-input');
    if (!text || !input) return;
    const at = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, at);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    input.value = before + pad + text + input.value.slice(input.selectionEnd ?? at);
    const caret = (before + pad + text).length;
    input.selectionStart = input.selectionEnd = caret;
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function problemRow(p) {
    const li = el('li');
    const b = el('button', `cv-problem ${p.severity}`);
    b.type = 'button';
    b.title = t('Mention this line in the message');
    const where = `${p.line || ''}${p.col ? `:${p.col}` : ''}`;
    b.append(el('span', `cv-sev ${p.severity}`, p.severity === 'error' ? '●' : '▲'), el('span', 'cv-where', where),
      mine(el('span', 'cv-msg', p.message)), mine(el('small', 'jc-dim', [p.code, p.source].filter(Boolean).join(' · '))));
    b.addEventListener('click', () => insertMention(p));
    li.append(b);
    return li;
  }

  function renderProblems(body = F.$('jc-pane-body')) {
    if (!paneShown('cv-problems') || !body) return;
    const info = problems.info;
    if (!info) { body.replaceChildren(el('p', 'jc-empty', 'Looking for the project’s checkers…')); return; }
    const parts = [];
    const quick = info.checkers.filter((c) => !c.slow);
    const slow = info.checkers.filter((c) => c.slow);
    const check = info.check;
    const running = check && check.status === 'running';
    if (!info.checkers.length) {
      body.replaceChildren(el('p', 'jc-empty', 'No checkers found: TypeScript, ESLint, Ruff, Pyright, mypy and Swift builds are looked for.'));
      return;
    }
    const bar = el('div', 'cv-bar');
    const names = el('span', 'cv-checkers');
    for (const c of info.checkers) {
      const chip = mine(el('span', `cv-checker${c.ready ? '' : ' off'}`, c.label));
      chip.title = c.ready ? c.command : c.why;
      names.append(chip);
    }
    bar.append(names, el('span', 'jc-spacer'));
    if (quick.length) bar.append(button(running ? 'Checking…' : 'Check', 'jc-btn small filled', () => { if (!running) send({ type: 'cv_problems', action: 'run' }); }));
    if (slow.length) bar.append(button('Build', 'jc-btn small', () => { if (!running) send({ type: 'cv_problems', action: 'run', slow: true }); }));
    parts.push(bar);
    if (info.after_turn !== null && info.after_turn !== undefined) {
      const sw = el('div', 'jc-audit-switch cv-switch');
      const label = el('span');
      label.append(el('strong', '', 'Check after each turn'), el('small', '', 'When this session changes files. Builds only run when you ask.'));
      const toggle = el('button', `sw${info.after_turn ? ' on' : ''}`);
      toggle.type = 'button';
      toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-checked', String(!!info.after_turn));
      toggle.setAttribute('aria-label', t('Check after each turn'));
      toggle.addEventListener('click', () => {
        info.after_turn = !info.after_turn;
        F.send({ type: 'cv_session', id: info.id, problems: info.after_turn });
        renderProblems();
      });
      sw.append(label, toggle);
      parts.push(sw);
    }
    if (check) {
      const counts = countProblems(check.problems);
      const line = el('div', `cv-runline ${running ? 'running' : counts.errors ? 'failed' : 'passed'}`);
      const text = running ? ['Checking…'] : check.problems.length
        ? [`${counts.errors} error${counts.errors === 1 ? '' : 's'}`, `${counts.warnings} warning${counts.warnings === 1 ? '' : 's'}`]
        : ['No problems'];
      line.append(el('span', `cv-mark ${running ? 'running' : counts.errors ? 'failed' : 'passed'}`, running ? '' : counts.errors ? '✕' : '✓'), pieces('', text), el('span', 'jc-spacer'));
      if (!running && check.problems.length && F.currentTask()) line.append(button('Fix these', 'jc-btn small tinted', () => send({ type: 'cv_problems', action: 'fix' })));
      parts.push(line);
      for (const c of check.checkers || []) {
        if (c.error) parts.push(mine(el('p', 'cv-problems-list', `${c.label}: ${c.error}`)));
      }
      for (const [file, items] of byFile(check.problems)) {
        const det = el('details', 'jc-card cv-file');
        det.open = true;
        const sum = el('summary');
        sum.append(mine(el('span', 'cv-file-name', file || t('(no file)'))), el('span', 'jc-spacer'), el('small', 'jc-dim', String(items.length)));
        const ul = el('ul', 'cv-problems');
        ul.append(...items.map(problemRow));
        det.append(sum, ul);
        parts.push(det);
      }
    }
    body.replaceChildren(...parts);
  }

  F.registerPane('cv-problems', {
    title: 'Problems',
    render(body) {
      problems.info = null;
      renderProblems(body);
      F.send({ type: 'cv_problems', action: 'state', ...where() });
    },
  });
  F.registerMoreItem({ label: 'Problems', run: () => F.openPane('cv-problems') });

  F.on('cv_problems_state', (ev) => { problems.info = ev; renderProblems(); });
  F.on('cv_problems', (ev) => {
    if (!problems.info || ev.check.project !== problems.info.path) return;
    problems.info.check = ev.check;
    renderProblems();
  });
})(typeof window === 'object' ? window : globalThis);
