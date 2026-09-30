// Jarvis Code checks its work (features/code_verify.py): the Preview pane (the project's
// dev servers, their logs), with the More menu's way in.
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

  const api = { serverState, shortUrl, isLocal, mergeLines };
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
    if (s.live && server.url) {
      const link = button(shortUrl(server.url), 'cv-link', () => openAddress(server.url));
      link.title = t('Open in the browser');
      mine(link);
      head.append(link);
    }
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
    li.append(head, cmd);
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
})(typeof window === 'object' ? window : globalThis);
