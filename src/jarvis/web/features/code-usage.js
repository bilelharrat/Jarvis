// Eden Code's usage meter (features/code_usage.py): the Usage pane (Claude's limits as
// Claude Code reports them; this session's, its project's and the day's spending against
// their caps, each cap editable there; the last two weeks; today by project), its More
// item and /usage, and the Limits tab of Eden Code settings (the default caps and the
// heads-ups switch).
//
// Everything shown from the backend is data: text only (textContent), project names marked
// data-no-i18n. Pure helpers are exported for node --test (tests/web/code-usage.test.mjs).
(function (root) {
  'use strict';

  const CAP_MAX = 100000;

  // $20, $20.50, $0.03: as the backend's codeusage.money says an amount.
  function fmtMoney(value) {
    const v = Math.round(Math.max(0, Number(value) || 0) * 100) / 100;
    const whole = Number.isInteger(v);
    return `$${v.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 })}`;
  }

  // How much of a cap is spent, 0-100 (null: no cap).
  function percentOf(spent, cap) {
    return cap > 0 ? Math.min(100, Math.round((100 * (Number(spent) || 0)) / cap)) : null;
  }

  // A meter's colour: calm under half, then warmer, full at the cap.
  function level(percent) {
    if (percent === null || percent === undefined) return 'none';
    return percent >= 100 ? 'full' : percent >= 80 ? 'high' : percent >= 50 ? 'warn' : 'ok';
  }

  // What the owner typed for a cap: null (back to the default), 0 (no cap) or an amount;
  // NaN when it isn't one.
  function parseCap(text) {
    const s = String(text === undefined || text === null ? '' : text).trim().replace(/^\$/, '').replace(/,/g, '');
    if (!s) return null;
    if (/^(none|no limit|off|无|不限)$/i.test(s)) return 0;
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
    const v = Number(s);
    return v <= CAP_MAX ? v : NaN;
  }

  // The last days' bars: each day's share of the busiest one (0-100).
  function barHeights(days) {
    const top = Math.max(0, ...(days || []).map((d) => Number(d.total) || 0));
    return (days || []).map((d) => (top > 0 ? Math.round((100 * (Number(d.total) || 0)) / top) : 0));
  }

  // When a window resets, for its line: a time today, a weekday and time this week, else a date.
  function resetText(epochSec, locale, now = Date.now()) {
    if (!epochSec) return '';
    const when = new Date(epochSec * 1000);
    if (Number.isNaN(when.getTime())) return '';
    const days = Math.floor((new Date(when).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86400000);
    const time = when.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
    if (days <= 0) return time;
    if (days < 7) return `${when.toLocaleDateString(locale, { weekday: 'short' })} ${time}`;
    return when.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  }

  const api = { fmtMoney, percentOf, level, parseCap, barHeights, resetText };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, t } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };
  const locale = () => (root.jarvisI18n && root.jarvisI18n.lang() === 'zh' ? 'zh-CN' : undefined);

  let state = null;  // the latest cu_state
  let features = {};  // prefs.features, for the Limits tab
  let paneBody = null;

  function paneShown() {
    return paneBody && paneBody.isConnected && typeof currentPane !== 'undefined' && currentPane === 'usage';
  }

  // A meter: a bar, with the colour of how full it is.
  function meter(percent) {
    const bar = el('span', `cu-meter ${level(percent)}`);
    const fill = el('span', 'cu-fill');
    fill.style.width = `${percent === null ? 0 : Math.max(2, percent)}%`;
    bar.append(fill);
    bar.setAttribute('role', 'meter');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(percent === null ? 0 : percent));
    return bar;
  }

  function windowRow(w) {
    const li = el('li', 'cu-row');
    const head = el('div', 'cu-row-head');
    head.append(el('strong', '', w.label.charAt(0).toUpperCase() + w.label.slice(1)));
    const status = w.status === 'rejected' ? 'Used up' : w.status === 'allowed_warning' ? 'Near the limit' : '';
    const known = w.percent !== null && w.percent !== undefined;
    if (known) {
      const pct = el('span', 'cu-num');
      pct.append(mine(el('span', '', `${w.percent}%`)), document.createTextNode(' '), el('span', '', 'used'));
      head.append(pct);
    } else head.append(el('span', 'cu-num', status || 'Within the limit'));
    li.append(head);
    // A meter only for a figure Claude Code gave (or a window used up): never an empty bar.
    if (known || w.status === 'rejected') li.append(meter(known ? w.percent : 100));
    const foot = el('div', 'cu-row-foot jc-dim');
    if (status && known) foot.append(el('span', '', status));
    const when = w.reset ? '' : resetText(w.resets_at, locale());
    if (w.reset) foot.append(el('span', '', 'Reset since it was reported'));
    else if (when) { const r = el('span'); r.append(el('span', '', 'Resets'), document.createTextNode(' '), mine(el('span', '', when))); foot.append(r); }
    if (foot.childNodes.length) li.append(foot);
    return li;
  }

  // A spending row: what's spent, the cap's meter, and the cap's own field.
  function spendRow(label, spent, cap, scope, own, task) {
    const li = el('li', 'cu-row');
    const head = el('div', 'cu-row-head');
    head.append(label);
    const num = el('span', 'cu-num');
    num.append(mine(el('span', '', fmtMoney(spent))));
    if (cap > 0) num.append(document.createTextNode(' '), el('span', 'jc-dim', 'of'), document.createTextNode(' '), mine(el('span', 'jc-dim', fmtMoney(cap))));
    head.append(num);
    li.append(head);
    const pct = percentOf(spent, cap);
    if (pct !== null) li.append(meter(pct));
    li.append(capField(scope, cap, own, task));
    return li;
  }

  function capField(scope, cap, own, task) {
    const row = el('label', 'cu-cap');
    row.append(el('span', 'jc-dim', scope === 'day' ? 'Limit a day' : scope === 'project' ? 'Limit today' : 'Limit'));
    const input = el('input', 'jc-field cu-cap-input');
    input.inputMode = 'decimal';
    input.placeholder = 'No limit';
    input.value = cap > 0 ? String(cap) : '';
    input.setAttribute('aria-label', scope === 'day' ? 'Eden Code’s limit a day' : scope === 'project' ? 'This project’s limit a day' : 'This session’s limit');
    const note = el('span', 'cu-cap-note jc-dim');
    const save = () => {
      const value = parseCap(input.value);
      if (Number.isNaN(value)) { note.textContent = t('An amount in dollars, like 5 or 12.50'); input.focus(); return; }
      note.textContent = '';
      if (scope === 'day') F.send({ type: 'feature_prefs', changes: { code_budget_day: value || 0 } });
      else if (task) F.send({ type: 'cu_cap', id: task.id, scope, cap: value === null ? 0 : value });
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
    input.addEventListener('change', save);
    row.append(input);
    if (own && scope !== 'day' && task) {
      const back = el('button', 'jc-btn small cu-default', 'Use the default');
      back.type = 'button';
      back.addEventListener('click', () => F.send({ type: 'cu_cap', id: task.id, scope, cap: null }));
      row.append(back);
    }
    row.append(note);
    return row;
  }

  function section(title, ...nodes) {
    const box = el('section', 'cu-section');
    box.append(el('p', 'jc-label', title), ...nodes);
    return box;
  }

  function renderPane(body, task) {
    paneBody = body;
    if (!state) { body.replaceChildren(el('p', 'jc-empty', 'Reading usage…')); return; }
    const parts = [];
    const windows = el('ul', 'jc-list cu-list');
    windows.append(...(state.windows || []).map(windowRow));
    parts.push(section('Claude’s limits', state.windows && state.windows.length ? windows
      : el('p', 'jc-dim cu-intro', 'Claude Code reports your plan’s limits as sessions run. Nothing reported yet.')));

    const spend = el('ul', 'jc-list cu-list');
    const mineTask = task && state.sessions ? state.sessions[String(task.id)] : null;
    if (task && mineTask) {
      spend.append(spendRow(el('strong', '', 'This session'), mineTask.cost, mineTask.cap, 'session', mineTask.own, task));
      const project = state.projects ? state.projects[mineTask.project] : null;
      if (project) {
        const label = el('strong');
        label.append(mine(el('span', '', project.name)), document.createTextNode(' '), el('span', '', 'today'));
        spend.append(spendRow(label, project.today, project.cap, 'project', project.own, task));
      }
      if (mineTask.held) spend.append(el('li', 'cu-held', mineTask.held));  // (translated by its pattern)
    }
    spend.append(spendRow(el('strong', '', 'All of Eden Code today'), state.today, (state.defaults || {}).day || 0, 'day', false, task));
    parts.push(section('Spending', spend, el('p', 'jc-dim cu-intro', 'Claude Code’s own estimates. A session stops at its limit and waits until you raise it.')));

    const recent = state.recent || [];
    if (recent.some((d) => d.total > 0)) {
      const chart = el('div', 'cu-chart');
      const heights = barHeights(recent);
      recent.forEach((d, i) => {
        const col = el('span', 'cu-bar');
        col.style.height = `${Math.max(heights[i], d.total > 0 ? 4 : 0)}%`;
        col.title = `${d.day}: ${fmtMoney(d.total)}`;
        chart.append(col);
      });
      const total = recent.reduce((n, d) => n + (Number(d.total) || 0), 0);
      const sum = el('p', 'jc-dim cu-intro');
      sum.append(el('span', '', 'Two weeks:'), document.createTextNode(' '), mine(el('span', '', fmtMoney(total))));
      parts.push(section('Last 14 days', chart, sum));
    }

    const byProject = state.by_project || [];
    if (byProject.length) {
      const list = el('ul', 'jc-list cu-list');
      list.append(...byProject.map((p) => {
        const li = el('li');
        li.append(mine(el('span', '', p.name)), mine(el('small', '', fmtMoney(p.cost))));
        return li;
      }));
      parts.push(section('Today by project', list));
    }
    const foot = el('p', 'jc-dim cu-intro');
    foot.append(el('span', '', 'Default limits and heads-ups are in Eden Code settings › Limits.'));
    parts.push(foot);
    body.replaceChildren(...parts);
  }

  F.registerPane('usage', { title: 'Usage', render(body, task) { renderPane(body, task); F.send({ type: 'cu_state' }); } });
  F.registerMoreItem({ label: 'Usage and limits', note: 'What sessions cost, and Claude’s limits', run: () => F.openPane('usage') });
  F.registerSlash({ name: 'usage', help: 'Usage, limits and what sessions cost', withoutSession: true, run() { F.openPane('usage'); return true; } });

  F.on('cu_state', (ev) => {
    state = ev;
    if (paneShown()) {
      const focused = paneBody.contains(document.activeElement);
      if (!focused) renderPane(paneBody, F.currentTask());  // (never under a cap being typed)
    }
    drawLimits();
  });

  // ── Eden Code settings › Limits: the defaults ──

  const LIMITS = [
    ['code_budget_session', 'Each session', 'A session stops there and waits until you raise it.'],
    ['code_budget_project', 'Each project, a day', 'Every session in one project, today.'],
    ['code_budget_day', 'All of Eden Code, a day', 'Every session in every project, today.'],
  ];
  let limitsPanel = null;

  // The Limits tab of Eden Code settings (other features add to it: found or made).
  function limitsTab() {
    const existing = document.getElementById('jcs-limits');
    if (existing) return existing;
    const tabs = document.querySelector('.jcs-tabs');
    const card = document.querySelector('.jcs-card');
    if (!tabs || !card) return null;
    const tab = el('button', '', 'Limits');
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.dataset.tab = 'limits';
    tabs.append(tab);
    const panel = el('div', 'jcs-body');
    panel.id = 'jcs-limits';
    panel.setAttribute('role', 'tabpanel');
    panel.hidden = true;
    card.append(panel);
    tab.addEventListener('click', () => { if (typeof selectJcsTab === 'function') selectJcsTab('limits'); });
    new MutationObserver(() => { panel.hidden = tab.getAttribute('aria-selected') !== 'true'; })
      .observe(tab, { attributes: true, attributeFilter: ['aria-selected'] });
    return panel;
  }

  function buildLimits() {
    const panel = limitsTab();
    if (!panel) return;
    const box = el('div', 'cu-limits');
    box.append(el('p', 'jcs-label in', 'Spending limits'));
    const group = el('div', 'jcs-group');
    for (const [key, label, help] of LIMITS) {
      const row = el('label', 'jcs-row');
      const text = el('span');
      text.append(document.createTextNode(t(label)), el('small', '', help));
      const input = el('input', 'jcs-input cu-default-cap');
      input.dataset.key = key;
      input.inputMode = 'decimal';
      input.placeholder = 'No limit';
      input.setAttribute('aria-label', label);
      const save = () => {
        const value = parseCap(input.value);
        if (Number.isNaN(value)) { input.classList.add('bad'); return; }
        input.classList.remove('bad');
        F.send({ type: 'feature_prefs', changes: { [key]: value || 0 } });
      };
      input.addEventListener('change', save);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
      row.append(text, input);
      group.append(row);
    }
    const row = el('div', 'jcs-row');
    const text = el('span');
    text.append(document.createTextNode(t('Heads-ups at 50, 80 and 100%')), el('small', '', 'Of each limit, and of Claude’s own 5-hour and weekly limits.'));
    const sw = el('button', 'jcs-switch');
    sw.type = 'button';
    sw.id = 'cu-alerts';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', 'Heads-ups at 50, 80 and 100%');
    sw.addEventListener('click', () => F.send({ type: 'feature_prefs', changes: { code_budget_alerts: sw.getAttribute('aria-checked') !== 'true' } }));
    row.append(text, sw);
    group.append(row);
    box.append(group, el('p', 'jcs-foot', 'Costs are Claude Code’s own estimates. Each session and project can have its own limit in its Usage pane.'));
    panel.prepend(box);
    limitsPanel = box;
    drawLimits();
  }

  function drawLimits() {
    if (!limitsPanel) return;
    limitsPanel.querySelectorAll('.cu-default-cap').forEach((input) => {
      if (document.activeElement === input) return;
      const value = Number(features[input.dataset.key]) || 0;
      input.value = value > 0 ? String(value) : '';
    });
    const sw = limitsPanel.querySelector('#cu-alerts');
    if (sw) sw.setAttribute('aria-checked', String(features.code_budget_alerts !== false));
  }

  buildLimits();
  F.on('prefs', (ev) => { features = ev.features || {}; drawLimits(); }, { replay: true });
  F.on('hello', (ev) => { features = (ev.prefs && ev.prefs.features) || {}; drawLimits(); }, { replay: true });
})(typeof window === 'object' ? window : globalThis);
