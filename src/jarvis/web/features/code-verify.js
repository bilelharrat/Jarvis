// Jarvis Code checks its work (features/code_verify.py): the Preview pane (the project's
// dev servers, their logs, the session's check after each turn), each check in the
// transcript (its picture, larger on a click, and what it found), the Tests pane (runs, the
// failures as a tree, watch mode), the Problems pane (the project's own checkers), the
// Settings switch for new sessions, and the More menu's switches for a session's extra
// hands (Xcode's tools, and the Mac itself). The page itself is checked by the app
// (app/features/code-verify.js), asked from here.
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

  // A picture the backend sent, as an image address: plain base64 only.
  function jpegSrc(data) {
    return typeof data === 'string' && data && /^[A-Za-z0-9+/]+={0,2}$/.test(data) ? `data:image/jpeg;base64,${data}` : '';
  }

  // A check's headline: [what, how it went].
  function checkHead(e) {
    const what = e.url ? 'Preview check' : 'Checks';
    const n = (e.findings || []).length + (e.more || 0);
    if (e.status === 'skipped') return [what, 'Nothing to check'];
    return [what, n ? `${n} problem${n === 1 ? '' : 's'}` : 'No problems'];
  }

  // The page's own address out of a finding, for reading ("GET /api/items → 500"); what the
  // session is sent keeps it whole.
  function withoutOrigin(text, url) {
    let origin = '';
    try { origin = new URL(url).origin; } catch (_) { return String(text || ''); }
    return String(text || '').split(origin).join('');
  }

  const api = { serverState, shortUrl, isLocal, mergeLines, mentionFor, countProblems, byFile, runLine, jpegSrc, checkHead, withoutOrigin };
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
    from: 0,  // Clear view: the logs view shows the lines after this one
    follow: true,  // the logs view keeps to the newest line, unless scrolled up
  };

  // A log view that keeps to its newest line while the owner hasn't scrolled up from it.
  function followed(pre, owner) {
    pre.addEventListener('scroll', () => { owner.follow = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40; });
    return pre;
  }

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

  // Whether an answer (cv_state, cv_tests, cv_problems_state) is about what the panes show:
  // the session on show, else the project picked. Answers go to every window and can come
  // late (the Tests and Problems ones are worked out in the background): another's is never
  // drawn.
  function forShown(ev) {
    const task = F.currentTask();
    return task ? ev.id === task.id : !ev.id && ev.project === (typeof deckProject !== 'undefined' ? deckProject : '');
  }

  // What a pane's buttons act on: what it shows (that answer's session, else its project),
  // even when another has been picked since it was drawn.
  function whereOf(info) {
    return info.id ? { id: info.id } : { directory: info.project };
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
      actions.append(button('Start', 'jc-mini', () => F.send({ type: 'cv_server', action: 'start', name: config.name, ...whereOf(state.info) })));
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
      button('Save', 'jc-mini', () => F.send({ type: 'cv_save', name: s.name, ...whereOf(state.info) })));
    li.append(head, mine(el('code', 'cv-cmd', s.command + (s.cwd ? `   (in ${s.cwd}/)` : ''))), mine(el('small', 'cv-note', s.why)));
    return li;
  }

  function showLogs(key) {
    state.logKey = key;
    state.follow = true;
    state.from = 0;
    state.logs.delete(key);  // asked from its start (drawing the view asks)
    clearTimeout(logTimer);
    logTimer = 0;
    renderPreview();
  }

  // The backend sends a server's new output for a minute after it's asked (devservers.watch):
  // while the logs view stays open it asks again before then, from the newest line it has.
  const LOG_ASK_EVERY = 40000;
  let logTimer = 0;
  const lastLine = (key) => { const lines = state.logs.get(key) || []; return lines.length ? lines[lines.length - 1][0] : 0; };
  function askLogs() {
    F.send({ type: 'cv_logs', key: state.logKey, since: lastLine(state.logKey) });
    clearTimeout(logTimer);
    logTimer = setTimeout(() => { logTimer = 0; if (paneShown('cv-preview') && F.$('cv-log')) askLogs(); }, LOG_ASK_EVERY);
  }

  // A server started again (Restart, or Stop then Start) is a new run, its output numbered
  // from 1 again: the logs view starts over with it, asked from its start.
  function newRun(before) {
    const was = before.find((s) => s.key === state.logKey);
    const now = state.servers.find((s) => s.key === state.logKey);
    if (!was || !now || was.started_at === now.started_at) return;
    state.logs.delete(now.key);
    state.from = 0;
    clearTimeout(logTimer);
    logTimer = 0;  // (drawing the view asks)
  }

  function logView() {
    const server = state.servers.find((s) => s.key === state.logKey);
    if (!server) return null;
    // Not asked lately (just opened, or on show again after a while): asked now, so what came
    // meanwhile shows too.
    if (!logTimer) askLogs();
    const box = el('div', 'cv-logs');
    const head = el('div', 'cv-logs-head');
    head.append(el('strong', '', 'Output'), mine(el('span', 'jc-dim', server.name)), el('span', 'jc-spacer'),
      button('Clear view', 'jc-mini', () => { state.from = lastLine(server.key); drawLog(); }));
    const pre = followed(mine(el('pre', 'jc-code cv-log')), state);
    pre.id = 'cv-log';
    box.append(head, pre);
    requestAnimationFrame(drawLog);
    return box;
  }

  function drawLog() {
    const pre = F.$('cv-log');
    if (!pre) return;
    const lines = (state.logs.get(state.logKey) || []).filter(([n]) => n > state.from);
    pre.textContent = lines.map(([, text]) => text).join('\n') || t('Nothing yet.');
    if (state.follow) pre.scrollTop = pre.scrollHeight;
  }

  // The session's own part of the Preview pane: its check after each turn, Check now, and
  // how the latest check went.
  function sessionPart(info) {
    const checks = info.session;
    const box = el('div', 'cv-session');
    const sw = el('div', 'jc-audit-switch cv-switch');
    const label = el('span');
    label.append(el('strong', '', 'Check after each turn'),
      el('small', '', 'When this session changes files: the dev server’s page is reloaded and pictured, and its errors and the server’s are collected. What’s wrong goes back to Jarvis Code, twice in a row at most.'));
    const toggle = el('button', `sw${checks.verify ? ' on' : ''}`);
    toggle.type = 'button';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(!!checks.verify));
    toggle.setAttribute('aria-label', t('Check after each turn'));
    toggle.addEventListener('click', () => {
      checks.verify = !checks.verify;
      F.send({ type: 'cv_session', id: info.id, verify: checks.verify });
      renderPreview();
    });
    sw.append(label, toggle);
    box.append(sw);
    const row = el('div', 'cv-bar');
    const now = button(checks.checking ? 'Checking…' : 'Check now', 'jc-btn small', () => {
      if (checks.checking) return;
      checks.checking = true;
      F.send({ type: 'cv_check', id: info.id });
      renderPreview();
    });
    now.disabled = !!checks.checking;
    row.append(now);
    const last = checks.last;
    if (last) {
      const src = jpegSrc(last.thumb);
      if (src) {
        const pic = el('button', 'cv-mini-thumb');
        pic.type = 'button';
        pic.title = t('See the picture');
        const img = el('img');
        img.src = src;
        img.alt = t('The page as the check saw it');
        pic.append(img);
        pic.addEventListener('click', () => openProof(last.proof, last.thumb));
        row.append(pic);
      }
      const mark = last.status === 'ok' ? 'passed' : last.status === 'problems' ? 'failed' : 'skipped';
      row.append(el('span', `cv-mark ${mark}`, mark === 'passed' ? '✓' : mark === 'failed' ? '✕' : '–'), el('span', 'cv-last', last.text));
    }
    box.append(row);
    return box;
  }

  function renderPreview(body = F.$('jc-pane-body')) {
    if (!paneShown('cv-preview') || !body) return;
    const info = state.info;
    if (!info) { body.replaceChildren(el('p', 'jc-empty', 'Looking at the project…')); return; }
    const parts = [];
    if (info.session && info.id) parts.push(sessionPart(info));
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
    const before = state.servers;
    if (forShown(ev)) state.info = ev;
    if (Array.isArray(ev.servers)) {  // (any project's: they're all kept)
      const others = state.servers.filter((s) => s.project !== ev.path);
      state.servers = others.concat(ev.servers);
    }
    newRun(before);
    renderPreview();
  });
  F.on('devservers', (ev) => {
    const before = state.servers;
    state.servers = ev.items || [];
    newRun(before);
    renderPreview();
  });
  F.on('cv_logs', (ev) => {
    // Asked again from a line on: what came since joins what's there.
    state.logs.set(ev.key, mergeLines(state.logs.get(ev.key) || [], ev.lines || []));
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
  F.on('cv_session', (ev) => {
    if (state.info && state.info.id === ev.id && state.info.session) {
      Object.assign(state.info.session, { verify: ev.verify });
      renderPreview();
    }
  });
  F.on('cv_verify', (ev) => {
    if (!state.info || state.info.id !== ev.id || !state.info.session) return;
    state.info.session.checking = ev.state === 'checking';
    if (ev.last) state.info.session.last = ev.last;
    renderPreview();
  });

  // ── the page check: the app does it, asked through this window ──

  F.on('cv_page_check', async (ev) => {
    const app = root.jarvisApp;
    if (!app || !app.feature) return;  // a window without the app: the app window answers
    let result;
    try {
      result = await app.feature.invoke('feature:code-verify:check', { url: ev.url, reload: ev.reload, width: ev.width, height: ev.height });
    } catch (err) {
      result = { error: String(err && err.message ? err.message : err) };
    }
    F.send({ type: 'cv_page_result', id: ev.id, result });
  });

  // ── a check in the transcript ──

  function verifyEntry(e) {
    const li = el('li', `cv-check ${e.status || ''}`);
    const src = jpegSrc(e.thumb);
    if (src) {
      const pic = el('button', 'cv-thumb');
      pic.type = 'button';
      pic.title = t('See the picture');
      const img = el('img');
      img.src = src;
      img.alt = t('The page as the check saw it');
      pic.append(img);
      pic.addEventListener('click', () => openProof(e.proof, e.thumb));
      li.append(pic);
    }
    const body = el('div', 'cv-check-body');
    const [what, how] = checkHead(e);
    const head = el('div', 'cv-check-head');
    const mark = e.status === 'ok' ? 'passed' : e.status === 'problems' ? 'failed' : 'skipped';
    head.append(el('span', `cv-mark ${mark}`, mark === 'passed' ? '✓' : mark === 'failed' ? '✕' : '–'), el('strong', '', what), el('span', 'cv-chip', how));
    body.append(head);
    const where = [e.url ? shortUrl(e.url) : '', e.title || ''].filter(Boolean).join(' · ');
    if (where) body.append(mine(el('small', 'cv-check-where', where)));
    if (e.page_error) body.append(el('small', 'cv-check-note', e.page_error));
    if (e.findings && e.findings.length) {
      const ul = el('ul', 'cv-findings');
      for (const f of e.findings) {
        const item = el('li');
        item.append(el('span', 'cv-kind', f.label || 'Check'), mine(el('span', 'cv-finding', withoutOrigin(f.text, e.url))));
        if (f.where && !String(f.text).includes(f.where)) item.append(mine(el('small', 'jc-dim', withoutOrigin(f.where, e.url))));
        ul.append(item);
      }
      if (e.more) ul.append(el('li', 'jc-dim', `…and ${e.more} more`));
      body.append(ul);
    }
    if (e.tests) {
      const line = el('div', 'cv-check-line');
      line.append(el('span', 'cv-kind', 'Tests'), mine(el('span', '', e.tests.label)), pieces('', String(e.tests.summary || '').split(' · ')));
      body.append(line);
    }
    if (e.problems) {
      const line = el('div', 'cv-check-line');
      line.append(el('span', 'cv-kind', 'Checkers'), pieces('', [`${e.problems.errors} error${e.problems.errors === 1 ? '' : 's'}`, `${e.problems.warnings} warning${e.problems.warnings === 1 ? '' : 's'}`]));
      body.append(line);
    }
    if (e.sent) body.append(el('small', 'cv-check-note sent', 'Sent to Jarvis Code to fix.'));
    else if (e.why_not) body.append(el('small', 'cv-check-note', e.why_not));
    else if (e.by_owner && e.findings && e.findings.length) body.append(el('small', 'cv-check-note', 'You asked for this check: nothing was sent.'));
    if (!e.sent && e.findings && e.findings.length) {
      body.append(button('Ask Jarvis Code to fix these', 'jc-mini cv-fix', () => {
        const task = F.currentTask();
        if (task) F.send({ type: 'cv_fix_check', id: task.id, n: e.n });
      }));
    }
    li.append(body);
    return li;
  }
  F.registerEntry('verify', verifyEntry);

  // A check's picture, larger: the thumbnail at once, the full one when it comes.
  let lightbox = null;
  function closeProof() {
    if (!lightbox) return;
    lightbox.remove();
    lightbox = null;
    document.removeEventListener('keydown', escProof, true);
  }
  function escProof(ev) {
    if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); closeProof(); }
  }
  function openProof(proof, thumb) {
    closeProof();
    lightbox = el('div', 'cv-lightbox');
    lightbox.setAttribute('role', 'dialog');
    lightbox.setAttribute('aria-modal', 'true');
    lightbox.setAttribute('aria-label', t('The page as the check saw it'));
    lightbox.dataset.proof = proof || '';
    const img = el('img');
    img.src = jpegSrc(thumb);
    img.alt = t('The page as the check saw it');
    const close = el('button', 'jc-icon cv-lightbox-close', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', t('Close'));
    const note = el('p', 'cv-lightbox-note');
    lightbox.append(img, close, note);
    lightbox.addEventListener('click', closeProof);
    document.body.append(lightbox);
    document.addEventListener('keydown', escProof, true);
    close.focus();
    if (proof) F.send({ type: 'cv_proof', proof });
  }
  F.on('cv_proof', (ev) => {
    if (!lightbox || lightbox.dataset.proof !== ev.proof) return;
    const src = jpegSrc(ev.jpeg);
    if (src) lightbox.querySelector('img').src = src;
    else lightbox.querySelector('.cv-lightbox-note').textContent = t('The full picture isn’t kept anymore.');
  });

  // ── Settings: new sessions' switch ──

  function settingsGroup() {
    const settings = F.$('settings');
    if (!settings || F.$('cv-settings')) return;
    const group = el('section', 'group');
    group.id = 'cv-settings';
    group.append(el('h3', '', 'Jarvis Code checks'));
    const row = el('div', 'row');
    const text = el('span');
    text.append(el('strong', '', 'Check new sessions’ work'),
      el('small', '', 'After each turn that changes files: the dev server’s page, reloaded and pictured, and its errors. What’s wrong goes back to the session, twice in a row at most. Each session has its own switch in its Preview pane.'));
    const sw = el('button', 'switch');
    sw.type = 'button';
    sw.id = 'sw-cv-new-sessions';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', 'false');
    sw.setAttribute('aria-label', t('Check new sessions’ work'));
    sw.addEventListener('click', () => {
      const on = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', String(on));
      F.send({ type: 'feature_prefs', changes: { code_verify_new_sessions: on } });
    });
    row.append(text, sw);
    group.append(row);
    const after = F.$('sw-code-narrate') && F.$('sw-code-narrate').closest('section');
    if (after) after.after(group); else settings.append(group);
  }
  function showSetting(features) {
    const sw = F.$('sw-cv-new-sessions');
    if (sw && features) sw.setAttribute('aria-checked', String(!!features.code_verify_new_sessions));
  }
  settingsGroup();
  F.on('prefs', (ev) => showSetting(ev.features));
  F.on('hello', (ev) => showSetting(ev.prefs && ev.prefs.features), { replay: true });

  // ── the Tests pane ──

  const tests = {
    info: null,  // the latest cv_tests: suites, their files, the latest run, the watch
    suite: '',  // the suite chosen (its key)
    output: [],  // the run's output shown, [[n, text], ...]
    follow: true,  // the output keeps to its newest line, unless scrolled up
    openFiles: new Set(),  // result files unfolded
    filter: '',
  };

  function send(msg, info) { F.send({ ...msg, ...whereOf(info) }); }  // (info: what the pane shows)

  function suiteNow() {
    const info = tests.info;
    if (!info || !info.suites.length) return null;
    return info.suites.find((s) => s.key === tests.suite) || info.suites[0];
  }

  function runTarget(target) {
    const suite = suiteNow();
    if (suite) send({ type: 'cv_tests', action: 'run', suite: suite.key, ...target }, tests.info);
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
    const pre = followed(mine(el('pre', 'jc-code cv-log')), tests);
    pre.id = 'cv-test-log';
    det.append(pre);
    requestAnimationFrame(drawTestLog);
    return det;
  }

  function drawTestLog() {
    const pre = F.$('cv-test-log');
    if (!pre) return;
    pre.textContent = tests.output.map(([, text]) => text).join('\n') || t('Nothing yet.');
    if (tests.follow) pre.scrollTop = pre.scrollHeight;
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
      head.append(running ? button('Stop', 'jc-btn small danger', () => send({ type: 'cv_tests', action: 'stop' }, info))
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
      toggle.addEventListener('click', () => send({ type: 'cv_tests', action: 'watch', on: !watching, suite: suite.key }, info));
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
        line.append(button('Fix failures', 'jc-btn small tinted', () => send({ type: 'cv_tests', action: 'fix' }, info)));
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
    if (!forShown(ev)) return;
    tests.info = ev;
    if (!ev.suites.some((s) => s.key === tests.suite)) tests.suite = ev.watch ? ev.watch.suite : '';
    tests.output = ev.run && ev.run.output ? mergeLines([], ev.run.output) : [];
    renderTests();
  });
  F.on('cv_tests_run', (ev) => {
    const info = tests.info;
    if (!info || ev.run.project !== info.path) return;
    const fresh = !info.run || info.run.started !== ev.run.started;
    if (fresh) { tests.output = []; tests.follow = true; }
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
    if (quick.length) bar.append(button(running ? 'Checking…' : 'Check', 'jc-btn small filled', () => { if (!running) send({ type: 'cv_problems', action: 'run' }, info); }));
    if (slow.length) bar.append(button('Build', 'jc-btn small', () => { if (!running) send({ type: 'cv_problems', action: 'run', slow: true }, info); }));
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
      if (!running && check.problems.length && F.currentTask()) line.append(button('Fix these', 'jc-btn small tinted', () => send({ type: 'cv_problems', action: 'fix' }, info)));
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

  F.on('cv_problems_state', (ev) => {
    if (!forShown(ev)) return;
    problems.info = ev;
    renderProblems();
  });
  F.on('cv_problems', (ev) => {
    if (!problems.info || ev.check.project !== problems.info.path) return;
    problems.info.check = ev.check;
    renderProblems();
  });

  // ── a session's extra hands: the More menu's switches ──

  const hands = new Map();  // session id -> what cv_session last said of it
  let handsFor = null;
  function askHands() {  // a session newly on show: what are its switches?
    const task = F.currentTask();
    const id = task ? task.id : null;
    if (id === handsFor) return;
    handsFor = id;
    if (id !== null) F.send({ type: 'cv_session', id });
  }
  F.on('tasks', askHands);
  F.on('task_transcript', askHands);
  F.on('cv_session', (ev) => { hands.set(ev.id, { ...(hands.get(ev.id) || {}), ...ev }); });
  const handsOf = (task) => (task ? hands.get(task.id) || {} : {});

  F.registerMoreItem({
    label: 'Let this session use the Mac',
    note: 'See the screen, click and type. Every step asks, except in Bypass permissions.',
    keepOpen: true,
    get switch() { return !!handsOf(F.currentTask()).mac; },
    when: (task) => !!task,
    run: (on) => { const task = F.currentTask(); if (task) F.send({ type: 'cv_session', id: task.id, mac: !!on }); },
  });
  F.registerMoreItem({
    label: 'Xcode’s tools',
    note: 'Xcode’s own tools for this session, while Xcode is open',
    keepOpen: true,
    get switch() { return !!handsOf(F.currentTask()).xcode; },
    when: (task) => !!handsOf(task).xcode_project,
    run: (on) => { const task = F.currentTask(); if (task) F.send({ type: 'cv_session', id: task.id, xcode: !!on }); },
  });
})(typeof window === 'object' ? window : globalThis);
