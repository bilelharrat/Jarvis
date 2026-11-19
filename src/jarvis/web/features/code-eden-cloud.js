// Eden Cloud (features/code_eden_cloud.py): hosted Eden Code runs. The Eden Cloud tab of Eden
// Code settings (the switch, off until set up; the service's address; a run's default budget,
// time limit and how the code goes; a check; the runs, with Cancel, Diff, Bring back, Forget),
// the session's More menu (Run in Eden Cloud…, Cancel in Eden Cloud) and, while a session's
// run is there, a bar in its header: how it's doing and what it has cost of its budget, on the
// owner's own Anthropic key. The composer is untouched.
//
// Everything from the backend is data: text only (textContent); titles, branches, costs and
// diffs are marked data-no-i18n. Pure helpers are exported for node --test
// (tests/web/code-eden-cloud.test.mjs).
(function (root) {
  'use strict';

  const LIVE = ['uploading', 'queued', 'starting', 'running'];
  const WORDS = {
    uploading: 'Sending the code…',
    queued: 'Waiting for a machine',
    starting: 'Starting a machine',
    running: 'Working in Eden Cloud',
    done: 'Finished in Eden Cloud',
    failed: 'Failed in Eden Cloud',
    cancelled: 'Cancelled in Eden Cloud',
    timed_out: 'Ran out of time in Eden Cloud',
    over_budget: 'Reached its budget in Eden Cloud',
    gone: 'No longer in Eden Cloud',
  };

  function isLive(run) { return !!run && LIVE.includes(run.state); }

  // How a run is doing, in a few words (a dropped connection says so first).
  function stateWord(run) {
    if (!run) return '';
    if (run.lost && isLive(run)) return 'Reconnecting…';
    return WORDS[run.state] || 'No longer in Eden Cloud';
  }

  function money(value) { return `$${Math.max(0, Number(value) || 0).toFixed(2)}`; }

  // "$0.12 of $5.00": what its Claude Code reported, of the run's budget.
  function spent(run) { return run ? `${money(run.cost)} of ${money(run.budget)}` : ''; }

  // A session's run: its live one, else its latest (by its number in this launch).
  function runFor(runs, taskId) {
    if (!taskId) return null;
    const mine = (runs || []).filter((r) => r.task_id === taskId);
    return mine.filter(isLive).pop() || mine.pop() || null;
  }

  // The address as Settings takes it: https://, or http:// on this Mac only; null otherwise.
  function cleanUrl(text) {
    const value = String(text || '').trim().replace(/\/+$/, '');
    if (!value) return '';
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.username || url.password || url.search || url.hash) return null;
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return url.protocol === 'https:' || (url.protocol === 'http:' && local) ? value : null;
  }

  // Whether Run in Eden Cloud… applies to a session, and why not.
  function canRun(state, task) {
    if (!task || task.kind !== 'code') return { ok: false, why: '' };
    if (!state || !state.configured) return { ok: false, why: 'Set it up in Eden Code settings › Eden Cloud' };
    if (!(task.workspace && task.workspace.slug)) return { ok: false, why: 'Needs an isolated copy' };
    if (task.busy) return { ok: false, why: 'Wait for its step to finish' };
    if (isLive(runFor(state.runs, task.id))) return { ok: false, why: 'Already in Eden Cloud' };
    return { ok: true, why: 'A machine of its own, on your Anthropic key' };
  }

  const api = { isLive, stateWord, money, spent, runFor, cleanUrl, canRun, WORDS };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, send, t } = F;
  let state = { enabled: false, configured: false, server: '', runs: [], limits: {}, usage: {}, problem: '' };
  let features = {};
  const noI18n = (node) => { node.dataset.noI18n = ''; return node; };
  function button(label, run, cls = 'btn') {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', run);
    return b;
  }
  const setPref = (changes) => send({ type: 'feature_prefs', changes });

  // ── Eden Code settings › Eden Cloud ──

  function tab() {
    const existing = document.getElementById('jcs-eden-cloud');
    if (existing) return existing;
    const tabs = document.querySelector('.jcs-tabs');
    const card = document.querySelector('.jcs-card');
    if (!tabs || !card) return null;
    const button2 = el('button', '', 'Eden Cloud');
    button2.type = 'button';
    button2.setAttribute('role', 'tab');
    button2.setAttribute('aria-selected', 'false');
    button2.dataset.tab = 'eden-cloud';
    tabs.append(button2);
    const panel = el('div', 'jcs-body ecl-panel');
    panel.id = 'jcs-eden-cloud';
    panel.setAttribute('role', 'tabpanel');
    panel.hidden = true;
    card.append(panel);
    button2.addEventListener('click', () => { if (typeof selectJcsTab === 'function') selectJcsTab('eden-cloud'); });
    new MutationObserver(() => {
      panel.hidden = button2.getAttribute('aria-selected') !== 'true';
      if (!panel.hidden) send({ type: 'code_eden_cloud_state' });
    }).observe(button2, { attributes: true, attributeFilter: ['aria-selected'] });
    return panel;
  }

  const panel = tab();
  const sw = el('button', 'jcs-switch');
  const address = el('input', 'jcs-input ecl-url');
  const budget = el('input', 'jcs-input ecl-num');
  const minutes = el('input', 'jcs-input ecl-num');
  const source = el('select', 'jcs-select');
  const status = el('p', 'jcs-help ecl-status');
  const list = el('ul', 'ecl-list');
  const listLabel = el('p', 'jcs-label', 'Runs');
  const diffBox = el('div', 'ecl-diff');
  const diffText = noI18n(el('pre', 'ecl-diff-text'));
  diffBox.hidden = true;

  function row(label, help, control) {
    const r = el('label', 'jcs-row');
    const words = el('span');
    words.append(document.createTextNode(t(label)));
    if (help) words.append(el('small', '', t(help)));
    r.append(words, control);
    return r;
  }

  if (panel) {
    panel.append(el('p', 'jcs-intro', 'Run a session on a hosted machine of its own, like a cloud agent: it keeps working while your Mac sleeps, and its branch comes back here to review and land. It runs on your own Anthropic API key.'));
    const group = el('div', 'jcs-group');
    sw.type = 'button';
    sw.id = 'ecl-on';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', 'false');
    sw.setAttribute('aria-label', t('Eden Cloud'));
    sw.addEventListener('click', () => setPref({ code_eden_cloud: sw.getAttribute('aria-checked') !== 'true' }));
    const first = el('div', 'jcs-row');
    const words = el('span');
    words.append(document.createTextNode(t('Eden Cloud')), el('small', '', t('Off until it’s set up. Every run asks first, on a card that says what leaves your Mac.')));
    first.append(words, sw);
    address.type = 'url';
    address.placeholder = 'https://…';
    address.spellcheck = false;
    address.setAttribute('aria-label', t('Address'));
    address.addEventListener('change', () => {
      const value = cleanUrl(address.value);
      if (value === null) { status.textContent = t('Use an https:// address (http:// only for one on this Mac).'); return; }
      setPref({ code_eden_cloud_url: value });
    });
    budget.type = 'number';
    budget.min = '0.5';
    budget.max = '100';
    budget.step = '0.5';
    budget.addEventListener('change', () => { const v = Number(budget.value); if (v > 0) setPref({ code_eden_cloud_budget: v }); });
    minutes.type = 'number';
    minutes.min = '1';
    minutes.max = '240';
    minutes.addEventListener('change', () => { const v = Math.round(Number(minutes.value)); if (v > 0) setPref({ code_eden_cloud_minutes: v }); });
    for (const [value, label] of [['snapshot', 'Snapshot (a git bundle)'], ['remote', 'Git remote (public https only)']]) {
      const o = el('option', '', t(label));
      o.value = value;
      source.append(o);
    }
    source.addEventListener('change', () => setPref({ code_eden_cloud_source: source.value }));
    group.append(
      first,
      row('Address', 'The Eden Cloud service. None yet: its hosting isn’t chosen.', address),
      row('Budget per run', 'Dollars on your Anthropic key; Claude Code stops there.', budget),
      row('Time limit', 'Minutes per run.', minutes),
      row('The code goes as', 'A snapshot works for any repository; a remote only for one anyone can clone.', source),
    );
    const check = button('Check', () => { status.textContent = t('Checking…'); send({ type: 'code_eden_cloud_test' }); });
    const checkRow = el('div', 'ecl-check');
    checkRow.append(check, status);
    panel.append(group, checkRow, listLabel, list, diffBox);
    diffBox.append(el('p', 'jcs-label', 'Diff'), diffText, button('Close', () => { diffBox.hidden = true; }));
    panel.append(el('p', 'jcs-foot', 'Your Eden account signs you in (askeden.com gives a ten-minute token: your Mac’s own never leaves). Runs use Bypass permissions on their own machine, which is deleted when they end. A change to a file that can run code on this Mac comes back unmerged.'));
  }

  function runItem(r) {
    const li = el('li', 'jcs-provider ecl-run');
    const head = el('div', 'jcs-p-head');
    const title = el('span', 'jcs-p-title');
    title.append(noI18n(el('strong', '', r.title || r.branch)));
    const where = el('small', `ecl-state ${isLive(r) ? 'live' : r.state === 'done' ? 'ok' : 'bad'}`);
    where.append(el('span', '', stateWord(r)), document.createTextNode(' · '), noI18n(el('span', '', spent(r))));
    title.append(where);
    if (r.error && !isLive(r)) title.append(noI18n(el('small', 'ecl-note', r.error)));
    if (r.landed) title.append(noI18n(el('small', 'ecl-note', r.landed)));
    head.append(title);
    if (r.task_id) head.append(button('Open', () => F.selectTask(r.task_id)));
    if (isLive(r)) head.append(button('Cancel', () => send({ type: 'code_eden_cloud_cancel', run: r.id })));
    if (r.has_diff) head.append(button('Diff', () => { diffText.textContent = t('Loading…'); diffBox.hidden = false; send({ type: 'code_eden_cloud_diff', run: r.id }); }));
    if (r.has_result && !r.landed && !isLive(r)) head.append(button('Bring it back', () => send({ type: 'code_eden_cloud_land', run: r.id })));
    if (!isLive(r)) head.append(button('Forget', () => send({ type: 'code_eden_cloud_forget', run: r.id })));
    li.append(head);
    return li;
  }

  function drawPanel() {
    if (!panel) return;
    sw.setAttribute('aria-checked', String(features.code_eden_cloud === true));
    if (document.activeElement !== address) address.value = features.code_eden_cloud_url || '';
    if (document.activeElement !== budget) budget.value = String(features.code_eden_cloud_budget ?? 5);
    if (document.activeElement !== minutes) minutes.value = String(features.code_eden_cloud_minutes ?? 30);
    source.value = features.code_eden_cloud_source === 'remote' ? 'remote' : 'snapshot';
    if (state.problem) status.textContent = state.problem;
    list.replaceChildren(...state.runs.slice().reverse().map(runItem));
    list.hidden = listLabel.hidden = !state.runs.length;
  }

  // ── the session's More menu ──

  const current = () => { const task = F.currentTask(); return task && task.kind === 'code' ? task : null; };
  const mine = () => { const task = current(); return task ? runFor(state.runs, task.id) : null; };

  F.registerMoreItem({
    label: 'Run in Eden Cloud…',
    when: (task) => !!task && task.kind === 'code' && !!state.enabled && !isLive(runFor(state.runs, task.id)),
    get note() { return canRun(state, current()).why; },
    get disabled() { return !canRun(state, current()).ok; },
    run: () => {
      const task = current();
      if (!task || !canRun(state, task).ok) return;
      const brief = typeof prompt === 'function' ? prompt(t('What should it do there? (Empty: carry on with this session.)'), '') : '';
      if (brief === null) return;
      send({ type: 'code_eden_cloud_submit', id: task.id, brief });
    },
  });
  F.registerMoreItem({
    label: 'Cancel in Eden Cloud',
    when: (task) => !!task && isLive(runFor(state.runs, task.id)),
    run: () => { const r = mine(); if (r) send({ type: 'code_eden_cloud_cancel', run: r.id }); },
  });

  // ── the header's bar ──

  const bar = el('div', 'ecl-bar');
  bar.hidden = true;
  const how = el('span', 'ecl-bar-state');
  const cost = noI18n(el('span', 'ecl-bar-cost'));
  const billed = el('span', 'ecl-bar-billed', 'on your Anthropic key');
  const stop = button('Cancel', () => { const r = mine(); if (r) send({ type: 'code_eden_cloud_cancel', run: r.id }); }, 'ecl-bar-btn');
  bar.append(el('span', 'ecl-bar-dot'), how, cost, billed, stop);

  function drawBar() {
    const titles = document.querySelector('.jc-titles');
    if (titles && !bar.isConnected) titles.append(bar);
    const r = mine();
    bar.hidden = !isLive(r);
    if (bar.hidden) return;
    bar.classList.toggle('lost', !!r.lost);
    how.textContent = t(stateWord(r));
    cost.textContent = spent(r);
  }

  function draw() { drawPanel(); drawBar(); }

  const title = document.getElementById('jc-title');
  if (title) new MutationObserver(drawBar).observe(title, { childList: true, characterData: true, subtree: true });

  F.on('code_eden_cloud', (ev) => {
    state = { ...state, ...ev, runs: Array.isArray(ev.runs) ? ev.runs : [] };
    draw();
  }, { replay: true });
  F.on('code_eden_cloud_diff', (ev) => {
    diffBox.hidden = false;
    diffText.textContent = ev.problem ? ev.problem : (ev.diff || t('No changes.')) + (ev.cut ? `\n… ${t('(cut: the rest is in the bundle)')}` : '');
  });
  const take = (f) => { features = f || {}; draw(); };
  F.on('prefs', (ev) => take(ev.features), { replay: true });
  F.on('hello', (ev) => { take(ev.prefs && ev.prefs.features); send({ type: 'code_eden_cloud_state' }); }, { replay: true });
  F.on('tasks', () => drawBar(), { replay: true });
  draw();
})(typeof window === 'object' ? window : globalThis);
