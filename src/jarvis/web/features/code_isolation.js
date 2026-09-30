// Jarvis Code's isolated copies (features/code_isolation.py): the composer's "Isolated
// copy" switch for a new session (on by default when Settings says so, and offered, on,
// when another session is at work in the project), the badge on an isolated session's
// header, the Copies pane (land, discard, open, bring back; each project's .env and
// dependency options) and the default in Jarvis Code's settings.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send, t } = F;
  const byId = (id) => document.getElementById(id);
  const state = {
    features: {}, // prefs.features
    tasks: [], // the Jarvis Code sessions, as the hub lists them
    copies: [],
    trash: [],
    root: '',
    touched: null, // the switch as the owner set it for the next session (null: the default)
    paneBody: null, // the Copies pane's body while it shows
  };

  const project = () => (typeof deckProject === 'string' ? deckProject : '');
  const busyHere = (name) => state.tasks.some((x) => x.kind === 'code' && x.busy && x.folder === name && !(x.workspace && x.workspace.branch));
  const byDefault = () => !!state.features.code_isolate_default;
  const switchOn = () => (state.touched !== null ? state.touched : byDefault() || busyHere(project()));

  // ── the composer's switch ──

  const pill = el('button', 'jc-pill jcx-iso-switch');
  pill.type = 'button';
  pill.id = 'jcx-iso-switch';
  pill.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="6" r="1.6"/><path d="M4.5 5.1v5.8M11.5 7.6c0 2.2-2 2.8-5 3.4"/></svg>';
  const pillLabel = el('span', '', 'Isolated copy');
  pill.append(pillLabel);
  pill.addEventListener('click', () => { state.touched = !switchOn(); drawSwitch(); });

  function drawSwitch() {
    const row = document.querySelector('#deck-composer .jc-composer-row');
    if (row && !pill.isConnected) row.insertBefore(pill, row.querySelector('.jc-spacer'));
    const starting = !F.currentTask() && !!project();
    pill.hidden = !starting;
    const on = switchOn();
    pill.setAttribute('aria-pressed', String(on));
    pill.classList.toggle('on', on);
    const offered = on && state.touched === null && !byDefault() && busyHere(project());
    pill.title = t(offered
      ? 'Another session is working in this project, so this one gets a copy of its own. Click to share the folder instead.'
      : on ? 'This session gets its own copy of the project, on a branch of its own, until you land it.'
        : 'This session works in the project folder itself. Click for a copy of its own.');
  }

  F.registerSessionOption(() => {
    if (pill.hidden) return {};
    const on = switchOn();
    setTimeout(() => { state.touched = null; drawSwitch(); });  // the next session starts from the default
    return { isolated: on };
  });

  // ── the header's badge ──

  const badge = el('button', 'jcx-iso-badge');
  badge.type = 'button';
  badge.hidden = true;
  badge.addEventListener('click', () => F.openPane('copies'));

  function drawBadge() {
    const titles = document.querySelector('.jc-titles');
    if (titles && !badge.isConnected) titles.append(badge);
    const task = F.currentTask();
    const ws = task && task.workspace;
    badge.hidden = !(ws && ws.branch);
    if (badge.hidden) return;
    badge.replaceChildren(el('span', 'jcx-iso-dot'), el('span', '', `${ws.branch} → ${ws.into}`));
    badge.dataset.noI18n = '';
    badge.title = t('Isolated copy: this session works on a branch of its own. Open the Copies pane to land or discard it.');
  }

  function redraw() { drawSwitch(); drawBadge(); }
  const title = byId('jc-title');
  if (title) new MutationObserver(redraw).observe(title, { childList: true, characterData: true, subtree: true });

  // ── the Copies pane ──

  function when(seconds) {
    if (!seconds) return '';
    const ago = Math.max(0, Date.now() / 1000 - seconds);
    if (ago < 90) return 'just now';
    if (ago < 3600) return `${Math.round(ago / 60)} min ago`;
    if (ago < 86400) return `${Math.round(ago / 3600)} h ago`;
    const days = Math.round(ago / 86400);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }

  function button(label, cls, run) {
    const b = el('button', `jc-btn small ${cls || ''}`.trim(), label);
    b.type = 'button';
    b.addEventListener('click', run);
    return b;
  }

  function projectSwitch(key, label, note) {
    const name = project();
    const on = (state.features[key] || []).includes(name);
    const row = el('div', 'jcs-row');
    const text = el('span');
    text.append(el('strong', '', label), el('small', '', note));
    const sw = el('button', 'jcs-switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(on));
    sw.setAttribute('aria-label', label);
    sw.addEventListener('click', () => {
      const names = new Set(state.features[key] || []);
      if (on) names.delete(name); else names.add(name);
      send({ type: 'feature_prefs', changes: { [key]: [...names] } });
    });
    row.append(text, sw);
    return row;
  }

  function copyCard(c) {
    const card = el('li', 'jcx-copy');
    const head = el('div', 'jcx-copy-head');
    const name = el('strong', '', c.title || c.slug);
    name.dataset.noI18n = '';
    head.append(name);
    if (c.busy) head.append(el('span', 'jcx-chip busy', 'working'));
    else if (c.live) head.append(el('span', 'jcx-chip', 'open'));
    if (c.leftover) head.append(el('span', 'jcx-chip warn', 'not landed'));
    if (c.conflicts && c.conflicts.length) head.append(el('span', 'jcx-chip bad', 'conflicts'));
    const where = el('p', 'jcx-copy-where');
    const branch = el('code', '', `${c.branch} → ${c.into}`);
    branch.dataset.noI18n = '';
    const proj = el('span', '', c.project);
    proj.dataset.noI18n = '';
    where.append(proj, document.createTextNode(' · '), branch, document.createTextNode(' · '), el('span', '', when(c.created)));
    const s = c.state || {};
    const facts = [];
    if (s.files) facts.push(`${s.files} file${s.files === 1 ? '' : 's'} +${s.added || 0} −${s.removed || 0}`);
    if (s.dirty) facts.push(`${s.dirty} not committed`);
    if (s.ahead) facts.push(`${s.ahead} commit${s.ahead === 1 ? '' : 's'} ahead`);
    if (!s.exists && s.branch) facts.push('folder gone, branch kept');
    if (!facts.length) facts.push('no changes yet');
    const stats = el('p', 'jcx-copy-stats');
    facts.forEach((fact, k) => { if (k) stats.append(document.createTextNode(' · ')); stats.append(el('span', '', fact)); });
    card.append(head, where, stats);
    if (c.conflicts && c.conflicts.length) {
      const warn = el('p', 'jcx-copy-conflicts', `Landing hit conflicts in ${c.conflicts.slice(0, 5).join(', ')}${c.conflicts.length > 5 ? '…' : '.'}`);
      card.append(warn);
    }
    const actions = el('div', 'jcx-copy-actions');
    if (s.exists) actions.append(button(c.live ? 'Show' : c.resumable ? 'Resume' : 'Open', '', () => send({ type: 'code_copy', slug: c.slug, action: 'resume' })));
    if (c.conflicts && c.conflicts.length) actions.append(button('Resolve in session', 'tinted', () => send({ type: 'code_copy', slug: c.slug, action: 'resolve' })));
    actions.append(
      button('Land', 'filled', () => send({ type: 'code_copy', slug: c.slug, action: 'land' })),
      button('Discard', 'danger', () => send({ type: 'code_copy', slug: c.slug, action: 'discard' })),
    );
    card.append(actions);
    return card;
  }

  function renderCopies(body) {
    state.paneBody = body;
    const wrap = el('div', 'jcx-copies');
    wrap.append(el('p', 'jc-dim', 'Each isolated copy is the project on a branch of its own, outside the project folder. Land it to merge its work back; discard it to throw it away (kept 30 days).'));
    if (project()) {
      wrap.append(el('p', 'jcs-label', `New copies of ${project()}`));
      const group = el('div', 'jcs-group');
      group.append(
        projectSwitch('code_iso_env', 'Copy .env files', 'Only files git ignores, so a copy can never commit them.'),
        projectSwitch('code_iso_link', 'Link node_modules and .venv', 'Nothing to install again, but shared with the main folder: installing or upgrading a package in the copy changes the main folder’s too.'),
      );
      wrap.append(group);
    }
    wrap.append(el('p', 'jcs-label', 'Copies'));
    if (!state.copies.length) wrap.append(el('p', 'jc-empty', 'No isolated copies. Turn on “Isolated copy” when you start a session to give it one.'));
    else {
      const list = el('ul', 'jcx-copy-list');
      list.append(...state.copies.map(copyCard));
      wrap.append(list);
    }
    if (state.trash.length) {
      wrap.append(el('p', 'jcs-label', 'Recently discarded'));
      const list = el('ul', 'jc-list');
      list.append(...state.trash.map((item) => {
        const li = el('li');
        const name = el('span', '', item.title || item.slug);
        name.dataset.noI18n = '';
        li.append(name, el('small', '', when(item.at)));
        if (item.restorable) li.append(button('Bring back', '', () => send({ type: 'code_copy', slug: item.slug, action: 'restore' })));
        return li;
      }));
      wrap.append(list);
    }
    if (state.root) {
      const where = el('p', 'jc-dim jcx-copies-root', state.root);
      where.dataset.noI18n = '';
      wrap.append(where);
    }
    body.replaceChildren(wrap);
  }

  F.registerPane('copies', {
    title: 'Isolated copies',
    render(body) {
      renderCopies(body);
      send({ type: 'code_copies' });
    },
  });
  F.registerMoreItem({ label: 'Isolated copies', run: () => F.openPane('copies') });

  // ── Jarvis Code settings: the default ──

  const settingsSwitch = el('button', 'jcs-switch');
  settingsSwitch.type = 'button';
  settingsSwitch.id = 'jcx-iso-default';
  settingsSwitch.setAttribute('role', 'switch');
  settingsSwitch.setAttribute('aria-label', 'Isolated copy for new sessions');
  settingsSwitch.addEventListener('click', () => send({ type: 'feature_prefs', changes: { code_isolate_default: !byDefault() } }));
  (function addSetting() {
    const general = byId('jcs-general');
    if (!general) return;
    const label = el('p', 'jcs-label', 'Isolated copies');
    const group = el('div', 'jcs-group');
    const row = el('div', 'jcs-row');
    const text = el('span');
    text.append(document.createTextNode(t('Isolated copy for new sessions')), el('small', '', 'Each new session works on a branch of its own, in a copy of the project, until you land it. The composer’s switch still decides for each one.'));
    row.append(text, settingsSwitch);
    group.append(row);
    const foot = general.querySelector('.jcs-foot');
    general.insertBefore(label, foot);
    general.insertBefore(group, foot);
  })();

  function drawSettings() { settingsSwitch.setAttribute('aria-checked', String(byDefault())); }

  // ── events ──

  function prefsFrom(prefs) {
    if (prefs && prefs.features) state.features = prefs.features;
    drawSettings();
    redraw();
    if (state.paneBody && state.paneBody.isConnected && state.paneBody.querySelector('.jcx-copies')) renderCopies(state.paneBody);
  }
  F.on('hello', (ev) => { state.tasks = ev.tasks || []; prefsFrom(ev.prefs); }, { replay: true });
  F.on('prefs', (ev) => prefsFrom(ev), { replay: true });
  F.on('tasks', (ev) => { state.tasks = ev.items || []; redraw(); }, { replay: true });
  F.on('code_copies', (ev) => {
    state.copies = ev.copies || [];
    state.trash = ev.trash || [];
    state.root = ev.root || '';
    if (state.paneBody && state.paneBody.isConnected && state.paneBody.querySelector('.jcx-copies')) renderCopies(state.paneBody);
  });
  redraw();
  drawSettings();

  window.JarvisCopies = { switchOn, state };
})();
