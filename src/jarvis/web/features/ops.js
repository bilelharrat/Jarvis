// Health & safety (features/ops): Settings' checkup, security review, backups and
// diagnostics file, in one sheet; and first-run Setup, shown by itself on a fresh install
// and from Settings any time. Everything the hub sends is rendered as text; what's the
// owner's own (paths, phone and account names, what the microphone heard, log lines)
// carries data-no-i18n.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, $ } = F;
  const T = (text) => F.t(text);
  const shell = () => (window.jarvisApp && window.jarvisApp.feature ? window.jarvisApp.feature : null);

  const S = {
    prefs: {},
    busy: new Set(),
    doctor: null,
    review: null,
    backups: null,
    setup: null,
    tab: 'checkup',
    confirming: '', // the fix or tighten whose confirmation is open
    toast: { checkup: '', security: '', backups: '' },
    verified: {}, // backup path -> { ok, files, problem }
    verifying: '', // the backup being verified
    openDetails: new Set(), // checks whose details are unfolded (kept across redraws)
    diagSize: 2,
    preview: null, // { path, state: 'loading' | 'ready' | 'staging' | 'staged' | 'failed', data }
    diag: null,
    setupShown: false,
    step: 0,
    perms: null,
    claude: null,
    mic: { state: '', text: '', level: 0 },
    voiceMuted: false,
  };

  const STATE_WORDS = {
    ok: 'Fine', warn: 'Look at this', problem: 'Needs attention', info: 'For your information', unknown: 'Couldn’t tell',
    risk: 'Risk', notice: 'Worth knowing',
  };
  // Notes on a finding's items that are the window's own words, not the owner's data.
  const FIXED_NOTES = new Set(['On', 'Everything runs without asking']);
  const KIND_LABELS = { manual: 'Made by you', daily: 'Daily', safety: 'Before a restore', fix: 'Before a fix' };
  const FILE_NAMES = {
    'prefs.json': 'Settings',
    'memory.json': 'Memory',
    'routines.json': 'Routines',
    'goals.json': 'Goals',
    'permissions.json': 'Jarvis Code rules',
    'providers.json': 'Model providers',
    'connections.json': 'Connected accounts',
    'devices.json': 'Paired phones',
    'transactions.json': 'Purchase log',
    'delegations.json': 'Conversations for you',
    'answering.json': 'Calls to your number',
    'hearing.json': 'Words Jarvis learned',
    'interrupt_learning.json': 'Who matters',
    'interrupts.json': 'Texts and email',
    'suggestions.json': 'Suggestions',
    'documents.json': 'Documents',
    'invoices.json': 'Invoices',
    'brain/index.json': 'Second brain index',
  };

  function data(node) { node.setAttribute('data-no-i18n', ''); return node; }
  function button(label, cls, run) {
    const b = el('button', cls || 'btn', label);
    b.type = 'button';
    if (run) b.addEventListener('click', run);
    return b;
  }
  function when(at) {
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return '';
    const locale = window.jarvisI18n && window.jarvisI18n.lang() === 'zh' ? 'zh-CN' : undefined;
    const today = new Date().toDateString() === d.toDateString();
    return today
      ? d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function size(n) {
    if (!n) return '0 KB';
    return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
  }
  function isBusy(what) { return S.busy.has(what); }

  // ── the Settings group ──

  function settingsGroup() {
    if ($('ops-group')) return;
    const group = el('section', 'group ops-group');
    group.id = 'ops-group';
    group.append(el('h3', '', 'Health & safety'));
    const rows = el('div', 'ops-rows');
    const row = (tab, title, id, fallback) => {
      const b = el('button', 'ops-row');
      b.type = 'button';
      b.dataset.opsTab = tab;
      const text = el('span', 'ops-row-text');
      const line = el('small', '', fallback);
      line.id = id;
      text.append(el('strong', '', title), line);
      b.append(el('i', 'ops-row-dot'), text, el('span', 'ops-chev', '›'));
      b.addEventListener('click', () => openSheet(tab));
      return b;
    };
    rows.append(
      row('checkup', 'Checkup', 'ops-line-checkup', 'Is everything Jarvis needs in place?'),
      row('security', 'Security review', 'ops-line-security', 'What Jarvis may do on its own'),
      row('backups', 'Backups', 'ops-line-backups', 'Your settings and data, kept safe'),
      row('diagnostics', 'Diagnostics file', 'ops-line-diagnostics', 'Recent logs to share when you ask for help'),
    );
    const setup = button('Set up Jarvis again…', 'btn', () => openSetup());
    setup.id = 'ops-setup-open';
    group.append(rows, setup);
    const before = $('open-accounts') && $('open-accounts').closest('section.group');
    if (before) before.before(group); else $('settings').append(group);
    renderLines();
  }

  // A row's line: its parts each translated on their own, joined by a dot.
  function setLine(id, parts, state) {
    const line = $(id);
    if (!line) return;
    const nodes = [];
    for (const part of Array.isArray(parts) ? parts : [parts]) {
      if (nodes.length) nodes.push(document.createTextNode(' · '));
      nodes.push(typeof part === 'string' ? el('span', '', part) : part);
    }
    line.replaceChildren(...nodes);
    const dot = line.closest('.ops-row').querySelector('.ops-row-dot');
    if (state) dot.dataset.state = state; else delete dot.dataset.state;
  }

  function countsLine(counts, words) {
    const parts = [];
    for (const [state, one, many] of words) {
      const n = (counts || {})[state] || 0;
      if (n) parts.push(n === 1 ? one : many.replace('{n}', n));
    }
    return parts;
  }

  function renderLines() {
    const d = S.doctor;
    if (isBusy('doctor')) setLine('ops-line-checkup', 'Checking…', '');
    else if (d && d.counts) {
      const parts = countsLine(d.counts, [['problem', '1 needs attention', '{n} need attention'], ['warn', '1 to look at', '{n} to look at']]);
      setLine('ops-line-checkup', parts.length ? parts : 'Everything’s fine', d.worst === 'warn' || d.worst === 'problem' ? d.worst : 'ok');
    }
    const r = S.review;
    if (r && r.counts) {
      const parts = countsLine(r.counts, [['risk', '1 risk', '{n} risks'], ['notice', '1 worth knowing', '{n} worth knowing']]);
      setLine('ops-line-security', parts.length ? parts : 'Nothing to tighten', r.counts.risk ? 'problem' : r.counts.notice ? 'warn' : 'ok');
    }
    const b = S.backups;
    if (b) {
      if (b.pending) setLine('ops-line-backups', 'A restore is waiting for a restart', 'warn');
      else if (b.error) setLine('ops-line-backups', 'The backup folder isn’t available', 'problem');
      else if (b.newest) setLine('ops-line-backups', [el('span', '', 'Last backup'), data(el('span', '', when(b.newest.created)))], 'ok');
      else setLine('ops-line-backups', 'No backup yet', 'warn');
    }
  }

  // ── the sheet ──

  const TABS = [['checkup', 'Checkup'], ['security', 'Security review'], ['backups', 'Backups'], ['diagnostics', 'Diagnostics']];
  let returnFocus = null;

  function sheet() {
    if ($('ops-layer')) return $('ops-layer');
    const layer = el('div', 'ops-layer');
    layer.id = 'ops-layer';
    layer.hidden = true;
    const scrim = el('div', 'ops-scrim');
    scrim.addEventListener('click', () => closeSheet());
    const pop = el('section', 'ops-pop');
    pop.id = 'ops-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-modal', 'true');
    pop.setAttribute('aria-labelledby', 'ops-title');
    const head = el('header', 'ops-head');
    const title = el('h2', '', 'Health & safety');
    title.id = 'ops-title';
    const close = el('button', 'ops-close');
    close.type = 'button';
    close.id = 'ops-close';
    close.setAttribute('aria-label', 'Close health & safety');
    close.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    close.addEventListener('click', () => closeSheet());
    head.append(title, close);
    const tabs = el('nav', 'ops-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Health & safety');
    for (const [id, label] of TABS) {
      const b = el('button', '', label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.dataset.tab = id;
      b.addEventListener('click', () => selectTab(id));
      tabs.append(b);
    }
    const body = el('div', 'ops-body');
    body.id = 'ops-body';
    for (const [id] of TABS) {
      const panel = el('div', 'ops-panel');
      panel.id = `ops-tab-${id}`;
      panel.setAttribute('role', 'tabpanel');
      body.append(panel);
    }
    pop.append(head, tabs, body);
    pop.addEventListener('keydown', trapTab);
    layer.append(scrim, pop);
    document.body.append(layer);
    return layer;
  }

  function trapTab(e) {
    if (e.key !== 'Tab') return;
    const pop = e.currentTarget;
    const stops = [...pop.querySelectorAll('button:not([disabled]), input, select, [tabindex="0"]')].filter((n) => n.offsetParent !== null);
    if (!stops.length) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function sheetOpen() { const l = $('ops-layer'); return Boolean(l && !l.hidden); }

  function openSheet(tab) {
    const layer = sheet();
    if (!sheetOpen()) returnFocus = document.activeElement;
    layer.hidden = false;
    selectTab(tab || S.tab);
    $('ops-close').focus({ preventScroll: true });
  }

  function closeSheet() {
    const layer = $('ops-layer');
    if (!layer || layer.hidden) return;
    layer.hidden = true;
    S.confirming = '';
    const back = returnFocus;
    returnFocus = null;
    if (back && document.contains(back) && typeof back.focus === 'function') back.focus({ preventScroll: true });
  }

  function selectTab(tab) {
    S.tab = tab;
    S.confirming = '';
    document.querySelectorAll('#ops-pop .ops-tabs [role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    for (const [id] of TABS) $(`ops-tab-${id}`).hidden = id !== tab;
    if (tab === 'checkup' && !S.doctor && !isBusy('doctor')) F.send({ type: 'ops_doctor' });
    if (tab === 'security') F.send({ type: 'ops_security' });
    if (tab === 'backups') F.send({ type: 'ops_backups' });
    render(tab);
  }

  function render(tab) {
    if (!$('ops-layer')) return;
    if (tab === 'checkup') renderCheckup();
    else if (tab === 'security') renderSecurity();
    else if (tab === 'backups') renderBackups();
    else if (tab === 'diagnostics') renderDiagnostics();
  }

  // One confirmation open at a time, inline under what it confirms.
  function confirmRow(key, text, label, run) {
    const box = el('div', 'ops-confirm');
    box.append(el('p', '', text));
    const actions = el('div', 'ops-actions');
    actions.append(
      button('Cancel', 'btn', () => { S.confirming = ''; render(S.tab); }),
      button(label, 'btn primary', () => { S.confirming = ''; run(); render(S.tab); }),
    );
    box.append(actions);
    box.dataset.confirm = key;
    return box;
  }

  function head(text, action) {
    const top = el('div', 'ops-top');
    const line = el('p', 'ops-top-line');
    if (Array.isArray(text)) line.append(...text); else line.textContent = text;
    top.append(line);
    if (action) top.append(action);
    return top;
  }

  // ── Checkup ──

  function renderCheckup() {
    const panel = $('ops-tab-checkup');
    const d = S.doctor;
    const busy = isBusy('doctor');
    const run = button(busy ? 'Checking…' : d ? 'Check again' : 'Run a checkup', d ? 'btn' : 'btn primary', () => F.send({ type: 'ops_doctor' }));
    run.disabled = busy;
    run.id = 'ops-run-checkup';
    const parts = [];
    if (d && d.at) parts.push(el('span', '', 'Checked'), document.createTextNode(' '), data(el('span', '', when(d.at))));
    else parts.push(el('span', '', busy ? 'Checking Jarvis…' : 'See what’s working and what needs you, with a fix where one is safe.'));
    const nodes = [head(parts, run)];
    if (S.toast.checkup) nodes.push(el('p', 'ops-toast', S.toast.checkup));
    if (d && Array.isArray(d.checks)) {
      const groups = d.groups || {};
      for (const group of ['permissions', 'jarvis', 'data']) {
        const items = d.checks.filter((c) => c.group === group);
        if (!items.length) continue;
        nodes.push(el('h4', 'ops-group-title', groups[group] || group));
        const list = el('ul', 'ops-list');
        items.forEach((c) => list.append(checkItem(c)));
        nodes.push(list);
      }
    }
    panel.replaceChildren(...nodes);
  }

  function checkItem(c) {
    const li = el('li', 'ops-item');
    li.dataset.state = c.state;
    li.dataset.check = c.id;
    const dot = el('i', 'ops-dot');
    dot.title = STATE_WORDS[c.state] || '';
    const text = el('div', 'ops-text');
    const top = el('div', 'ops-line');
    top.append(el('strong', '', c.title), el('span', 'ops-summary', c.summary));
    if (c.meta) top.append(data(el('span', 'ops-meta', c.meta)));
    text.append(top);
    if (c.hint && c.state !== 'ok') text.append(el('p', 'ops-hint', c.hint));
    if (c.command) {
      const cmd = el('div', 'ops-command');
      cmd.append(data(el('code', '', c.command)), button('Copy', 'btn ops-small', () => copy(c.command)));
      text.append(cmd);
    }
    if (c.details && c.details.length) {
      const more = el('details', 'ops-details');
      more.open = S.openDetails.has(c.id);
      more.addEventListener('toggle', () => { if (more.open) S.openDetails.add(c.id); else S.openDetails.delete(c.id); });
      more.append(el('summary', '', c.id === 'logs' ? 'The last ones' : 'Details'));
      const list = c.details_words ? el('ul', '') : data(el('ul', ''));
      c.details.forEach((line) => list.append(el('li', '', line)));
      more.append(list);
      text.append(more);
    }
    li.append(dot, text);
    const actions = el('div', 'ops-actions');
    if (c.pane) actions.append(button('Open System Settings', 'btn ops-small', () => F.send({ type: 'ops_open_settings', pane: c.pane })));
    if (c.fix) {
      const key = `fix:${c.fix.id}`;
      const b = button(isBusy(key) ? 'Working…' : c.fix.label, 'btn ops-small', () => { S.confirming = key; renderCheckup(); });
      b.disabled = isBusy(key);
      actions.append(b);
    }
    if (actions.childElementCount) li.append(actions);
    if (c.fix && S.confirming === `fix:${c.fix.id}`) {
      li.append(confirmRow(S.confirming, c.fix.confirm, c.fix.label, () => {
        S.toast.checkup = '';
        F.send({ type: 'ops_fix', fix: c.fix.id });
      }));
    }
    return li;
  }

  function copy(text) {
    try { navigator.clipboard.writeText(text); } catch (_) { /* no clipboard: the text is on screen to select */ }
  }

  // ── Security review ──

  function renderSecurity() {
    const panel = $('ops-tab-security');
    const r = S.review;
    const again = button('Review again', 'btn', () => F.send({ type: 'ops_security' }));
    const parts = r && r.at
      ? [el('span', '', 'Reviewed'), document.createTextNode(' '), data(el('span', '', when(r.at)))]
      : [el('span', '', 'What Jarvis may do on its own, and a way to tighten each.')];
    const nodes = [head(parts, again)];
    if (S.toast.security) nodes.push(el('p', 'ops-toast', S.toast.security));
    if (r && Array.isArray(r.findings)) {
      const list = el('ul', 'ops-list');
      r.findings.forEach((f) => list.append(findingItem(f)));
      nodes.push(list);
      nodes.push(el('p', 'ops-note', 'Tightening only ever narrows what Jarvis may do; nothing here loosens anything.'));
    }
    panel.replaceChildren(...nodes);
  }

  function tightenButton(a) {
    const key = `tighten:${a.id}:${a.item || ''}`;
    return button(a.label, 'btn ops-small', () => { S.confirming = key; renderSecurity(); });
  }

  function findingItem(f) {
    const li = el('li', 'ops-item');
    li.dataset.state = f.state === 'risk' ? 'problem' : f.state === 'notice' ? 'warn' : 'ok';
    li.dataset.finding = f.id;
    const text = el('div', 'ops-text');
    const top = el('div', 'ops-line');
    top.append(el('strong', '', f.title), el('span', 'ops-summary', f.summary));
    text.append(top);
    if (f.note) text.append(el('p', 'ops-hint', f.note));
    const confirms = [];
    if (f.items && f.items.length) {
      const list = el('ul', 'ops-sublist');
      for (const item of f.items) {
        const row = el('li', '');
        const label = el('span', 'ops-sub-label');
        label.append(data(el('strong', '', item.label)));
        if (item.note) label.append(FIXED_NOTES.has(item.note) ? el('small', '', item.note) : data(el('small', '', item.note)));
        row.append(label);
        for (const a of item.actions || []) {
          row.append(tightenButton(a));
          if (S.confirming === `tighten:${a.id}:${a.item || ''}`) confirms.push([row, a]);
        }
        list.append(row);
      }
      text.append(list);
    }
    li.append(el('i', 'ops-dot'), text);
    if (f.actions && f.actions.length) {
      const actions = el('div', 'ops-actions');
      for (const a of f.actions) {
        actions.append(tightenButton(a));
        if (S.confirming === `tighten:${a.id}:${a.item || ''}`) confirms.push([li, a]);
      }
      li.append(actions);
    }
    for (const [where, a] of confirms) {
      const box = confirmRow(S.confirming, a.confirm, a.label, () => {
        S.toast.security = '';
        F.send({ type: 'ops_tighten', action: a.id, item: a.item || '' });
      });
      if (where === li) li.append(box); else where.after(box);
    }
    return li;
  }

  // ── Backups ──

  function renderBackups() {
    const panel = $('ops-tab-backups');
    const b = S.backups;
    const nodes = [];
    if (!b) {
      panel.replaceChildren(el('p', 'ops-top-line', 'Looking for your backups…'));
      return;
    }
    const busy = isBusy('backup');
    const now = button(busy ? 'Backing up…' : 'Back up now', 'btn primary', () => F.send({ type: 'ops_backup' }));
    now.disabled = busy || isBusy('restore');
    now.id = 'ops-backup-now';
    nodes.push(head('Your settings, memory, routines, goals, rules and other Jarvis data, in one zip with a checksum for every file. Never your passwords and keys (they stay in the Keychain), logs or apps.', now));
    if (S.toast.backups) nodes.push(el('p', 'ops-toast', S.toast.backups));
    if (b.pending) nodes.push(pendingBanner(b.pending));

    const place = el('div', 'ops-card');
    const where = el('div', 'ops-row-line');
    const label = el('span', 'ops-row-text');
    label.append(el('strong', '', 'Kept in'), data(el('small', 'ops-path', b.folder_label || b.folder)));
    const change = button('Change…', 'btn ops-small', pickFolder);
    where.append(label, change);
    if (b.chosen) where.append(button('Use the default', 'btn ops-small', () => F.send({ type: 'feature_prefs', changes: { ops_backup_folder: '' } })));
    place.append(where);
    if (b.error) place.append(el('p', 'ops-hint warn', b.error));
    place.append(
      switchRow('Back up every day', 'Keeps the last 7 daily backups.', b.daily, 'ops_backup_daily'),
      switchRow('Include the second brain’s index', 'Bigger backups; it can also be rebuilt from your notes and files.', b.knowledge, 'ops_backup_knowledge'),
    );
    nodes.push(place);

    const list = el('ul', 'ops-list ops-backups');
    for (const item of b.items || []) list.append(backupItem(item));
    if (!(b.items || []).length) nodes.push(el('p', 'ops-empty', 'No backups yet.'));
    else nodes.push(list);
    nodes.push(button('Restore from a file…', 'btn', pickBackup));
    panel.replaceChildren(...nodes);
  }

  function switchRow(title, note, on, key) {
    const row = el('div', 'ops-row-line');
    const label = el('span', 'ops-row-text');
    label.append(el('strong', '', title), el('small', '', note));
    const sw = el('button', 'switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(Boolean(on)));
    sw.setAttribute('aria-label', title);
    sw.dataset.pref = key;
    sw.addEventListener('click', () => F.send({ type: 'feature_prefs', changes: { [key]: !on } }));
    row.append(label, sw);
    return row;
  }

  function pendingBanner(p) {
    const box = el('div', 'ops-banner');
    const text = el('p', '');
    text.append(el('span', '', 'A restore is ready: the backup from'), document.createTextNode(' '), data(el('span', '', when(p.created) || p.backup)), document.createTextNode(' '), el('span', '', 'goes into place when Jarvis restarts.'));
    const actions = el('div', 'ops-actions');
    if (shell()) actions.append(button('Restart Jarvis now', 'btn primary', restartNow));
    actions.append(button('Cancel the restore', 'btn', () => { S.preview = null; F.send({ type: 'ops_restore_cancel' }); }));
    box.append(text, actions);
    return box;
  }

  function backupItem(item) {
    const li = el('li', 'ops-item ops-backup');
    li.dataset.path = item.path;
    const text = el('div', 'ops-text');
    const top = el('div', 'ops-line');
    top.append(data(el('strong', '', when(item.created) || item.name)), el('span', 'ops-kind', KIND_LABELS[item.kind] || item.kind));
    if (item.size) top.append(data(el('span', 'ops-meta', size(item.size))));
    if (item.files) top.append(el('span', 'ops-meta', item.files === 1 ? '1 file' : `${item.files} files`));
    text.append(top);
    const v = S.verified[item.path];
    if (v) text.append(el('p', v.ok ? 'ops-hint ok' : 'ops-hint warn', v.ok ? (v.files === 1 ? 'Verified: its file matches its checksum.' : `Verified: all ${v.files} files match their checksums.`) : v.problem));
    li.append(text);
    const actions = el('div', 'ops-actions');
    const verifying = isBusy('verify') && S.verifying === item.path;
    const verify = button(verifying ? 'Checking…' : 'Verify', 'btn ops-small', () => { S.verifying = item.path; F.send({ type: 'ops_backup_verify', path: item.path }); });
    verify.disabled = verifying;
    actions.append(
      verify,
      button('Restore…', 'btn ops-small', () => previewRestore(item.path)),
      button('Show in Finder', 'btn ops-small', () => F.send({ type: 'ops_reveal', path: item.path })),
    );
    li.append(actions);
    if (S.preview && S.preview.path === item.path) li.append(previewBox());
    return li;
  }

  function previewRestore(path) {
    S.preview = { path, state: 'loading', data: null };
    F.send({ type: 'ops_restore_preview', path });
    renderBackups();
  }

  function listLine(title, rels) {
    const p = el('p', 'ops-files');
    p.append(el('strong', '', title), document.createTextNode(' '));
    rels.forEach((rel, i) => {
      if (i) p.append(document.createTextNode(', '));
      p.append(FILE_NAMES[rel] ? el('span', '', FILE_NAMES[rel]) : data(el('span', '', rel)));
    });
    return p;
  }

  function previewBox() {
    const box = el('div', 'ops-confirm ops-preview');
    const p = S.preview;
    if (p.state === 'loading') { box.append(el('p', '', 'Checking the backup…')); return box; }
    if (p.state === 'staging') { box.append(el('p', '', 'Making a safety backup of how things are now, then getting the restore ready…')); return box; }
    if (p.state === 'failed') {
      box.append(el('p', 'warn', p.data && p.data.problem ? p.data.problem : 'That didn’t work.'), button('Close', 'btn', () => { S.preview = null; renderBackups(); }));
      return box;
    }
    const d = p.data;
    const intro = el('p', '');
    intro.append(el('span', '', 'Restoring this backup, made'), document.createTextNode(' '), data(el('span', '', when(d.backup.created) || d.backup.name)));
    box.append(intro);
    if (d.replace.length) box.append(listLine('Goes back to how it was:', d.replace));
    if (d.add.length) box.append(listLine('Comes back:', d.add));
    if (d.same.length) box.append(listLine('Already the same:', d.same));
    if (d.keep.length) box.append(listLine('Never rolled back (what was spent today still counts, and a phone you unpaired stays unpaired):', d.keep));
    if (d.left.length) box.append(listLine('Not in this backup, left as they are:', d.left));
    if (!d.replace.length && !d.add.length) {
      box.append(el('p', 'ops-hint', 'Nothing would change: this backup matches your data now.'));
      box.append(button('Close', 'btn', () => { S.preview = null; renderBackups(); }));
      return box;
    }
    box.append(el('p', 'ops-hint', 'First Jarvis makes a safety backup of how things are now. Then it restarts, and the backup goes into place as it starts, before anything reads your data. Anything you change before the restart isn’t kept. After it, the security review shows what the restored settings allow.'));
    const actions = el('div', 'ops-actions');
    actions.append(
      button('Cancel', 'btn', () => { S.preview = null; renderBackups(); }),
      button('Restore and restart', 'btn primary', () => {
        S.preview = { path: p.path, state: 'staging', data: d };
        F.send({ type: 'ops_restore', path: p.path });
        renderBackups();
      }),
    );
    box.append(actions);
    return box;
  }

  async function restartNow() {
    const s = shell();
    if (!s) return;
    let result = null;
    try { result = await s.invoke('feature:ops:restart'); } catch (_) { result = null; }
    S.toast.backups = result && result.ok
      ? 'Jarvis is restarting to finish the restore…'
      : 'Restart Jarvis to finish: quit it and open it again.';
    if (sheetOpen() && S.tab === 'backups') renderBackups();
  }

  async function pickFolder() {
    const s = shell();
    let chosen = null;
    if (s) {
      try { chosen = await s.invoke('feature:ops:pick-folder', S.backups ? S.backups.folder : '', T('Choose where Jarvis keeps its backups')); } catch (_) { chosen = null; }
    } else {
      chosen = window.prompt(T('The full path of the folder for backups:'));
    }
    if (chosen && chosen.trim()) F.send({ type: 'feature_prefs', changes: { ops_backup_folder: chosen.trim() } });
  }

  async function pickBackup() {
    const s = shell();
    let chosen = null;
    if (s) {
      try { chosen = await s.invoke('feature:ops:pick-backup', S.backups ? S.backups.folder : '', T('Choose a Jarvis backup to restore')); } catch (_) { chosen = null; }
    } else {
      chosen = window.prompt(T('The full path of the backup (a .zip):'));
    }
    if (!chosen || !chosen.trim()) return;
    const path = chosen.trim();
    if (S.backups && !(S.backups.items || []).some((b) => b.path === path)) {
      S.backups.items = [{ name: path.split('/').pop(), path, created: '', kind: 'manual', files: 0, size: 0 }, ...(S.backups.items || [])];
    }
    previewRestore(path);
  }

  // ── Diagnostics ──

  function renderDiagnostics() {
    const panel = $('ops-tab-diagnostics');
    const busy = isBusy('diagnostics');
    const nodes = [];
    nodes.push(el('p', 'ops-top-line', 'A zip of Jarvis’s recent logs, versions and a fresh checkup, to share when you ask for help. Tokens, keys, passwords, email addresses and phone numbers are masked, and none of your data (memory, messages, files) is in it. Nothing is sent anywhere: you choose who gets it.'));
    const row = el('div', 'ops-row-line');
    const label = el('label', 'ops-row-text');
    label.htmlFor = 'ops-diag-size';
    label.append(el('strong', '', 'How much of the logs'), el('small', '', 'The newest part, masked'));
    const select = el('select', '');
    select.id = 'ops-diag-size';
    for (const mb of [1, 2, 5, 10]) {
      const o = el('option', '', `${mb} MB`);
      o.value = String(mb);
      o.selected = mb === S.diagSize;
      select.append(o);
    }
    select.addEventListener('change', () => { S.diagSize = Number(select.value); });
    row.append(label, select);
    const make = button(busy ? 'Making it…' : 'Make a diagnostics file', 'btn primary', () => {
      S.diag = null;
      F.send({ type: 'ops_diagnostics', megabytes: S.diagSize });
    });
    make.disabled = busy;
    make.id = 'ops-diag-make';
    const card = el('div', 'ops-card');
    card.append(row);
    nodes.push(card, make);
    if (S.diag) {
      if (S.diag.ok) {
        const done = el('div', 'ops-banner ok');
        const p = el('p', '');
        p.append(el('span', '', 'Saved in Documents › Jarvis › Diagnostics:'), document.createTextNode(' '), data(el('strong', '', S.diag.name)));
        done.append(p, button('Show in Finder', 'btn', () => F.send({ type: 'ops_reveal', path: S.diag.path })));
        nodes.push(done);
      } else {
        nodes.push(el('p', 'ops-hint warn', S.diag.text || 'That didn’t work.'));
      }
    }
    panel.replaceChildren(...nodes);
  }

  // ── Escape: the open sheet closes, and only it ──

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (setupOpen()) { e.preventDefault(); e.stopPropagation(); closeSetup(); return; }
    if (sheetOpen()) {
      e.preventDefault();
      e.stopPropagation();
      if (S.confirming) { S.confirming = ''; render(S.tab); } else closeSheet();
    }
  }, true);

  // ── first-run Setup ──

  const STEPS = [
    ['language', 'Language'],
    ['voice', 'Voice'],
    ['permissions', 'Permissions'],
    ['claude', 'Claude'],
    ['habits', 'Hands-free'],
    ['phone', 'iPhone & Watch'],
  ];
  let permsTimer = null;
  let setupReturn = null;

  function setupLayer() {
    if ($('ops-setup')) return $('ops-setup');
    const layer = el('div', 'ops-layer ops-setup');
    layer.id = 'ops-setup';
    layer.hidden = true;
    const pop = el('section', 'ops-pop ops-setup-pop');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-modal', 'true');
    pop.setAttribute('aria-labelledby', 'ops-setup-title');
    const top = el('header', 'ops-head');
    const title = el('h2', '', 'Welcome to Jarvis');
    title.id = 'ops-setup-title';
    const skip = button('Skip setup', 'ops-skip', () => { F.send({ type: 'ops_setup', state: 'skipped' }); closeSetup(); });
    skip.id = 'ops-setup-skip';
    top.append(title, skip);
    const dots = el('ol', 'ops-steps');
    dots.id = 'ops-steps';
    dots.setAttribute('aria-label', 'Steps');
    const body = el('div', 'ops-body ops-setup-body');
    body.id = 'ops-setup-body';
    const foot = el('footer', 'ops-foot');
    const back = button('Go back', 'btn', () => goStep(S.step - 1));
    back.id = 'ops-setup-back';
    const next = button('Continue', 'btn primary', () => (S.step >= STEPS.length - 1 ? finishSetup() : goStep(S.step + 1)));
    next.id = 'ops-setup-next';
    foot.append(back, next);
    pop.append(top, dots, body, foot);
    pop.addEventListener('keydown', trapTab);
    layer.append(el('div', 'ops-scrim'), pop);
    document.body.append(layer);
    return layer;
  }

  function setupOpen() { const l = $('ops-setup'); return Boolean(l && !l.hidden); }

  function openSetup() {
    const layer = setupLayer();
    if (!setupOpen()) setupReturn = document.activeElement;
    if (sheetOpen()) closeSheet();
    if (!$('settings').hidden && typeof toggleSettings === 'function') toggleSettings(false);
    layer.hidden = false;
    S.setupShown = true;
    goStep(0);
    $('ops-setup-next').focus({ preventScroll: true });
  }

  function closeSetup() {
    const layer = $('ops-setup');
    if (!layer || layer.hidden) return;
    layer.hidden = true;
    stopPermsTimer();
    const back = setupReturn;
    setupReturn = null;
    if (back && document.contains(back) && typeof back.focus === 'function') back.focus({ preventScroll: true });
  }

  function finishSetup() {
    F.send({ type: 'ops_setup', state: 'done' });
    closeSetup();
  }

  function goStep(n) {
    S.step = Math.max(0, Math.min(STEPS.length - 1, n));
    const dots = $('ops-steps');
    dots.replaceChildren(...STEPS.map(([id, label], i) => {
      const li = el('li', i === S.step ? 'on' : i < S.step ? 'done' : '');
      li.dataset.step = id;
      li.append(el('span', 'ops-step-dot'), el('span', 'ops-step-name', label));
      if (i === S.step) li.setAttribute('aria-current', 'step');
      return li;
    }));
    $('ops-setup-back').hidden = S.step === 0;
    $('ops-setup-next').textContent = S.step === STEPS.length - 1 ? 'Done' : 'Continue';
    stopPermsTimer();
    const id = STEPS[S.step][0];
    if (id === 'permissions') {
      F.send({ type: 'ops_permissions' });
      permsTimer = setInterval(() => { if (document.hasFocus()) F.send({ type: 'ops_permissions' }); }, 4000);
    }
    if (id === 'claude') F.send({ type: 'ops_claude' });
    renderStep();
  }

  function stopPermsTimer() { if (permsTimer) { clearInterval(permsTimer); permsTimer = null; } }

  function renderStep() {
    const body = $('ops-setup-body');
    if (!body || !setupOpen()) return;
    const id = STEPS[S.step][0];
    const nodes = [];
    const p = S.prefs || {};
    if (id === 'language') {
      nodes.push(el('h3', '', 'Which language?'), el('p', 'ops-lead', 'Jarvis shows, speaks and listens in the language you pick. You can change it any time in Settings.'));
      const seg = el('div', 'segmented ops-lang');
      seg.setAttribute('role', 'radiogroup');
      seg.setAttribute('aria-label', 'Language');
      for (const [code, name] of [['en', 'English'], ['zh', '中文']]) {
        const b = data(el('button', '', name));
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.dataset.lang = code;
        b.setAttribute('aria-checked', String((p.language || 'en') === code));
        b.addEventListener('click', () => F.send({ type: 'set_prefs', changes: { language: code } }));
        seg.append(b);
      }
      nodes.push(seg);
    } else if (id === 'voice') {
      nodes.push(el('h3', '', 'Can you hear each other?'), el('p', 'ops-lead', 'Play a sample of Jarvis’s voice, then check it hears you.'));
      const row = el('div', 'ops-actions');
      row.append(button('Play a sample', 'btn', () => F.send({ type: 'ops_voice_test' })));
      const mic = button(S.mic.state === 'listening' || S.mic.state === 'transcribing' ? 'Listening…' : 'Test the microphone', 'btn', () => { S.mic = { state: 'starting', text: '', level: 0 }; F.send({ type: 'ops_mic_test' }); renderStep(); });
      mic.disabled = S.mic.state === 'listening' || S.mic.state === 'transcribing' || S.mic.state === 'starting';
      mic.id = 'ops-mic-test';
      row.append(mic);
      nodes.push(row);
      if (S.voiceMuted) {
        const muted = el('div', 'ops-banner');
        muted.append(el('p', '', 'Spoken replies are off, so Jarvis stays quiet.'), button('Turn spoken replies on', 'btn', () => { S.voiceMuted = false; F.send({ type: 'mute', value: false }); F.send({ type: 'ops_voice_test' }); renderStep(); }));
        nodes.push(muted);
      }
      nodes.push(micStatus());
    } else if (id === 'permissions') {
      nodes.push(el('h3', '', 'What Jarvis may use on this Mac'), el('p', 'ops-lead', 'macOS asks for most of these the first time Jarvis needs them. You can allow them now; this list updates as you do.'));
      const list = el('ul', 'ops-list ops-perms');
      const rows = S.perms ? S.perms.rows : null;
      if (!rows) nodes.push(el('p', 'ops-empty', 'Checking…'));
      else {
        for (const r of rows) {
          const li = el('li', 'ops-item');
          li.dataset.state = r.state === 'granted' ? 'ok' : ['denied', 'off', 'restricted'].includes(r.state) ? 'problem' : r.state === 'unknown' || r.state === 'not_running' ? 'unknown' : 'warn';
          li.dataset.perm = r.id;
          const text = el('div', 'ops-text');
          const top = el('div', 'ops-line');
          top.append(el('strong', '', r.title), el('span', 'ops-summary', r.label));
          text.append(top, el('p', 'ops-hint', r.why));
          if (r.apps && r.apps.length) {
            const apps = el('p', 'ops-hint');
            r.apps.forEach((a, i) => { if (i) apps.append(document.createTextNode(' · ')); apps.append(el('span', '', a.app), document.createTextNode(': '), el('span', '', a.label)); });
            text.append(apps);
          }
          li.append(el('i', 'ops-dot'), text);
          if (r.state !== 'granted') {
            const actions = el('div', 'ops-actions');
            actions.append(button('Open System Settings', 'btn ops-small', () => F.send({ type: 'ops_open_settings', pane: r.pane })));
            li.append(actions);
          }
          list.append(li);
        }
        nodes.push(list);
        if (S.perms.error) nodes.push(el('p', 'ops-hint warn', S.perms.error));
      }
    } else if (id === 'claude') {
      nodes.push(el('h3', '', 'Jarvis thinks with Claude'), el('p', 'ops-lead', 'It needs a Claude account signed in on this Mac.'));
      const c = S.claude;
      if (!c) nodes.push(el('p', 'ops-empty', 'Checking…'));
      else {
        const box = el('div', 'ops-card');
        const line = el('div', 'ops-line');
        line.dataset.state = c.state;
        line.append(el('i', 'ops-dot'), el('strong', '', c.summary));
        if (c.meta) line.append(data(el('span', 'ops-meta', c.meta)));
        box.append(line);
        if (c.hint && c.state !== 'ok') box.append(el('p', 'ops-hint', c.hint));
        if (c.command) {
          const cmd = el('div', 'ops-command');
          cmd.append(data(el('code', '', c.command)), button('Copy', 'btn ops-small', () => copy(c.command)));
          box.append(cmd);
        }
        nodes.push(box);
      }
      nodes.push(button('Check again', 'btn', () => { S.claude = null; F.send({ type: 'ops_claude' }); renderStep(); }));
    } else if (id === 'habits') {
      nodes.push(el('h3', '', 'How you’d like to talk'));
      const card = el('div', 'ops-card');
      card.append(prefSwitch('Hands-free', 'Say “Jarvis” to talk, and talk over it to interrupt. Keeps the microphone on. Off: press ⌥ Space or tap the orb.', p.hands_free, 'hands_free'));
      card.append(prefSwitch('Morning briefing', 'Your day, the weather and the markets, when Jarvis is running at that time.', p.briefing_enabled, 'briefing_enabled'));
      const time = el('label', 'ops-row-line');
      time.htmlFor = 'ops-briefing-time';
      const tl = el('span', 'ops-row-text');
      tl.append(el('strong', '', 'Briefing time'));
      const input = el('input', '');
      input.type = 'time';
      input.id = 'ops-briefing-time';
      input.value = p.briefing_time || '08:00';
      input.addEventListener('change', () => { if (/^\d\d:\d\d$/.test(input.value)) F.send({ type: 'set_prefs', changes: { briefing_time: input.value } }); });
      time.append(tl, input);
      card.append(time);
      nodes.push(card);
    } else if (id === 'phone') {
      nodes.push(el('h3', '', 'Jarvis on your iPhone and Apple Watch'), el('p', 'ops-lead', 'Ask Jarvis from your phone or your wrist: turn on the companion in Settings › iPhone & Watch, then pair your phone with the code it shows. It’s optional, and you can do it any time.'));
      nodes.push(button('Open iPhone & Watch settings', 'btn', () => {
        closeSetup();
        if (typeof toggleSettings === 'function') toggleSettings(true);
        const sw = $('sw-remote');
        if (sw) { sw.scrollIntoView({ block: 'center' }); sw.focus({ preventScroll: true }); }
      }));
      nodes.push(el('p', 'ops-hint', 'That’s everything. Settings › Health & safety has a checkup, a security review and backups whenever you want them.'));
    }
    body.replaceChildren(...nodes);
  }

  function prefSwitch(title, note, on, key) {
    const row = el('div', 'ops-row-line');
    const label = el('span', 'ops-row-text');
    label.append(el('strong', '', title), el('small', '', note));
    const sw = el('button', 'switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(Boolean(on)));
    sw.setAttribute('aria-label', title);
    sw.dataset.pref = key;
    sw.addEventListener('click', () => F.send({ type: 'set_prefs', changes: { [key]: !on } }));
    row.append(label, sw);
    return row;
  }

  function micStatus() {
    const box = el('div', 'ops-mic');
    const m = S.mic;
    if (!m.state) return box;
    const line = el('p', '');
    if (m.state === 'starting' || m.state === 'listening') {
      line.textContent = 'Listening… say something.';
      const meter = el('span', 'ops-meter');
      const fill = el('i', '');
      fill.style.width = `${Math.round((m.level || 0) * 100)}%`;
      meter.append(fill);
      box.append(line, meter);
      return box;
    }
    if (m.state === 'transcribing') line.textContent = 'One moment…';
    else if (m.state === 'heard' && m.text) {
      line.append(el('span', '', 'Jarvis heard:'), document.createTextNode(' '), data(el('q', '', m.text)));
    } else if (m.state === 'heard' || m.state === 'silent') line.textContent = 'Jarvis didn’t hear anything. Check the microphone in Settings › Voice, then try again.';
    else if (m.state === 'hands_free') line.textContent = 'Hands-free is listening already: say “Jarvis, what time is it?” to try it.';
    else if (m.state === 'busy') line.textContent = 'Jarvis is busy. Try again in a moment.';
    else if (m.state === 'error') line.textContent = m.text || 'Jarvis couldn’t use the microphone.';
    box.append(line);
    return box;
  }

  // ── the hub's events ──

  F.on('hello', (ev) => {
    if (ev.prefs) S.prefs = ev.prefs;
    settingsGroup();
    F.send({ type: 'ops_state' });
  }, { replay: true });

  F.on('prefs', (ev) => {
    S.prefs = ev;
    if (S.backups) {
      const f = ev.features || {};
      if ('ops_backup_daily' in f) S.backups.daily = Boolean(f.ops_backup_daily);
      if ('ops_backup_knowledge' in f) S.backups.knowledge = Boolean(f.ops_backup_knowledge);
      if (S.backups.chosen !== Boolean(f.ops_backup_folder) || (f.ops_backup_folder && f.ops_backup_folder !== S.backups.folder)) F.send({ type: 'ops_backups' });
      if (sheetOpen() && S.tab === 'backups') renderBackups();
    }
    if (setupOpen()) renderStep();
  });

  F.on('ops_state', (ev) => {
    S.setup = ev.setup || null;
    if (ev.backups) S.backups = ev.backups;
    S.busy = new Set(ev.busy || []);
    renderLines();
    if (sheetOpen()) render(S.tab);
    if (ev.restored && typeof notice === 'function') {
      const r = ev.restored;
      if (r.ok) notice('Backups', 'Restored', r.files === 1 ? '1 file went back to how it was in the backup.' : `${r.files} files went back to how they were in the backup.`, 0);
      else notice('Backups', 'The restore didn’t finish', r.problem || '', 0);
    }
    if (S.setup && S.setup.show && !S.setupShown) openSetup();
  });

  F.on('ops_busy', (ev) => {
    S.busy = new Set(ev.items || []);
    renderLines();
    if (sheetOpen()) render(S.tab);
  });

  F.on('ops_doctor', (ev) => {
    S.doctor = ev;
    renderLines();
    if (sheetOpen() && S.tab === 'checkup') renderCheckup();
  });

  F.on('ops_fixed', (ev) => {
    S.toast.checkup = ev.text || '';
    if (sheetOpen() && S.tab === 'checkup') renderCheckup();
  });

  F.on('ops_security', (ev) => {
    S.review = ev;
    renderLines();
    if (sheetOpen() && S.tab === 'security') renderSecurity();
  });

  F.on('ops_tightened', (ev) => {
    S.toast.security = ev.text || '';
    if (sheetOpen() && S.tab === 'security') renderSecurity();
  });

  F.on('ops_backups', (ev) => {
    S.backups = ev;
    renderLines();
    if (sheetOpen() && S.tab === 'backups') renderBackups();
  });

  F.on('ops_backup_done', (ev) => {
    S.toast.backups = ev.ok ? 'Backed up.' : (ev.text || 'That didn’t work.');
    if (sheetOpen() && S.tab === 'backups') renderBackups();
  });

  F.on('ops_verified', (ev) => {
    S.verified[ev.path] = { ok: ev.ok, files: ev.files, problem: ev.problem };
    if (sheetOpen() && S.tab === 'backups') renderBackups();
  });

  F.on('ops_restore_preview', (ev) => {
    if (!S.preview || S.preview.path !== ev.path) return;
    S.preview = { path: ev.path, state: ev.ok ? 'ready' : 'failed', data: ev };
    if (sheetOpen() && S.tab === 'backups') renderBackups();
  });

  F.on('ops_restore_staged', (ev) => {
    if (!ev.ok) {
      S.preview = { path: S.preview ? S.preview.path : '', state: 'failed', data: { problem: ev.text } };
      if (sheetOpen() && S.tab === 'backups') renderBackups();
      return;
    }
    // Ready: the banner says so (ops_backups follows), and Jarvis restarts to finish.
    S.preview = null;
    S.toast.backups = 'Restart Jarvis to finish: quit it and open it again.';
    if (sheetOpen() && S.tab === 'backups') renderBackups();
    if (shell()) restartNow();
  });

  F.on('ops_diagnostics', (ev) => {
    S.diag = ev;
    if (sheetOpen() && S.tab === 'diagnostics') renderDiagnostics();
  });

  F.on('ops_permissions', (ev) => {
    S.perms = ev;
    if (setupOpen()) renderStep();
  });

  F.on('ops_claude', (ev) => {
    S.claude = ev;
    if (setupOpen()) renderStep();
  });

  F.on('ops_voice', (ev) => {
    S.voiceMuted = Boolean(ev.muted);
    if (setupOpen()) renderStep();
  });

  F.on('ops_mic', (ev) => {
    if (ev.state === 'level') {
      S.mic.level = ev.level || 0;
      const fill = document.querySelector('#ops-setup .ops-meter i');
      if (fill) fill.style.width = `${Math.round(S.mic.level * 100)}%`;
      return;
    }
    S.mic = { state: ev.state, text: ev.text || '', level: 0 };
    if (setupOpen()) renderStep();
  });

  window.addEventListener('focus', () => {
    if (setupOpen() && STEPS[S.step][0] === 'permissions') F.send({ type: 'ops_permissions' });
    if (setupOpen() && STEPS[S.step][0] === 'claude') F.send({ type: 'ops_claude' });
  });

  settingsGroup();
})();
