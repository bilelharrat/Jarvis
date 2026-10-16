// Eden Code's cost forecast (features/code_forecast.py): while a message is being written,
// what it's likely to cost and how much of Claude's 5-hour limit it's likely to take, from
// similar messages in this project, as a few quiet words at the end of the status line
// under the composer (the composer itself is unchanged); the detail is its tooltip. And the
// forecast's switches in Eden Code settings › Limits (the forecast, and big queued cards
// waiting for the night).
//
// Statistics only: no model is asked (the backend counts what earlier turns cost). Asked a
// moment after typing stops, never for an empty box. Pure helpers are exported for
// node --test (tests/web/code-forecast.test.mjs).
(function codeForecast(root) {
  'use strict';

  const WAIT = 450;  // ms after the last key before asking
  const FIVE_MAX = 0.95;  // (codeforecast.FIVE_MAX: past this, a card waits for the reset)

  // $20, $0.35: as the backend's codeusage.money says an amount.
  function money(value) {
    const v = Math.round(Math.max(0, Number(value) || 0) * 100) / 100;
    return Number.isInteger(v) ? `$${v.toLocaleString('en-US')}` : `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function costRange(low, high) {
    const a = money(low), b = money(high);
    return a === b ? a : `${a}–${b}`;
  }

  // A window's share: "<1%", "4%".
  function pct(value) {
    const p = Math.round(100 * Math.max(0, Number(value) || 0));
    return p < 1 ? '<1%' : `${p}%`;
  }

  function shareRange(low, high) {
    const a = pct(low), b = pct(high);
    if (a === b) return a;
    return a === '<1%' ? `<1–${b}` : `${a.replace('%', '')}–${b}`;
  }

  // Whether this message may not fit what's left of the 5-hour window.
  function mayNotFit(f) {
    const share = f && f.windows && f.windows.five_hour;
    const now = f && f.now && f.now.five_hour;
    if (!share || !now || now.used === null || now.used === undefined) return false;
    return Number(now.used) + Number(share.high) > FIVE_MAX;
  }

  // The status line's words for a forecast ('' when there's none): its cost, and its share
  // of the 5-hour limit when that's known.
  function lineText(f) {
    if (!f || !f.n) return '';
    const cost = `≈ ${costRange(f.low, f.high)}`;
    const five = f.windows && f.windows.five_hour;
    return five ? `${cost} · ${shareRange(five.low, five.high)} of the 5-hour limit` : cost;
  }

  // The tooltip's sentences (English; each is one the window's dictionary translates).
  function detail(f) {
    if (!f || !f.n) return [];
    const out = [];
    if (f.scope === 'recent') out.push(`From this project’s ${f.n} latest messages (none much like this one).`);
    else if (f.scope === 'all') out.push(`From ${f.n} similar messages in your projects.`);
    else out.push(`From ${f.n} similar messages in this project.`);
    out.push(`Likely ${costRange(f.low, f.high)}, typically ${money(f.mid)}.`);
    const w = f.windows || {};
    const now = f.now || {};
    const used = (kind) => (now[kind] && now[kind].used !== null && now[kind].used !== undefined ? pct(now[kind].used) : '');
    if (w.five_hour) {
      out.push(used('five_hour') ? `${shareRange(w.five_hour.low, w.five_hour.high)} of Claude’s 5-hour limit (now ${used('five_hour')}).`
        : `${shareRange(w.five_hour.low, w.five_hour.high)} of Claude’s 5-hour limit.`);
    }
    if (w.seven_day) {
      out.push(used('seven_day') ? `${shareRange(w.seven_day.low, w.seven_day.high)} of the weekly limit (now ${used('seven_day')}).`
        : `${shareRange(w.seven_day.low, w.seven_day.high)} of the weekly limit.`);
    }
    if (mayNotFit(f)) out.push('It may not fit what’s left of the 5-hour limit.');
    if (f.confidence === 'rough') out.push('A rough guess: few messages to go by yet.');
    out.push('A forecast from statistics: no model is asked.');
    return out;
  }

  const api = { money, costRange, pct, shareRange, mayNotFit, lineText, detail };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  const F = root.jarvisFeatures;
  if (!F) return;
  const { el } = F;

  let features = {};
  let composer = null;  // the composer's state (task, model) as it was last drawn
  let timer = 0;
  let asked = '';  // the rid of the last question
  let lastKey = '';  // what was last asked (the same again isn't asked again)
  const on = () => features.code_forecast_show !== false;

  // The forecast's place: the end of the status line under the composer (made once).
  function line() {
    let span = document.getElementById('cf-line');
    if (span) return span;
    const status = document.querySelector('.jc-dock .jc-statusline');
    if (!status) return null;
    span = el('span', 'cf-line');
    span.id = 'cf-line';
    span.hidden = true;
    status.append(span);
    return span;
  }

  function hide() {
    const span = line();
    if (span) { span.hidden = true; span.textContent = ''; span.removeAttribute('title'); }
  }

  function draw(f) {
    const span = line();
    if (!span) return;
    const text = lineText(f);
    if (!text) { hide(); return; }
    span.hidden = false;
    span.classList.toggle('warn', mayNotFit(f));
    span.replaceChildren(el('span', 'cf-sep', ' · '), el('span', 'cf-text', text));
    // (the tooltip is put together from translated sentences: the window's own pass would
    // see one long title it has no pattern for)
    span.setAttribute('data-no-i18n', '');
    span.querySelector('.cf-text').textContent = F.t(text);
    span.title = detail(f).map((s) => F.t(s)).join(' ');
  }

  function ask() {
    timer = 0;
    const input = document.getElementById('deck-input');
    const text = input ? input.value : '';
    if (!on() || !text.trim() || text.trim().startsWith('/')) { hide(); lastKey = ''; return; }
    const task = composer && composer.t;
    const route = F.codeRouter && typeof F.codeRouter.pick === 'function' ? F.codeRouter.pick(text) : null;
    const model = (route && route.ref) || (composer && composer.ref) || '';
    const directory = !task && typeof deckProject !== 'undefined' ? deckProject : '';
    const key = `${task ? task.id : directory}|${model}|${text}`;
    if (key === lastKey) return;
    lastKey = key;
    asked = `cf${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const msg = { type: 'cf_forecast', rid: asked, text, model };
    if (task) msg.id = task.id; else msg.directory = directory;
    F.send(msg);
  }

  function soon() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(ask, WAIT);
  }

  const input = document.getElementById('deck-input');
  if (input) input.addEventListener('input', soon);
  F.registerComposerRender((s) => {
    const was = composer;
    composer = s;
    if (!was || (was.t && was.t.id) !== (s.t && s.t.id) || was.ref !== s.ref) soon();
  });
  F.on('cf_forecast', (ev) => {
    if (ev.rid !== asked) return;  // (another window's question, or an older one)
    if (ev.off) { hide(); return; }
    draw(ev);
  });
  // A message sent empties the box: the forecast goes with it.
  F.on('tasks', () => { const i = document.getElementById('deck-input'); if (i && !i.value.trim()) { hide(); lastKey = ''; } });

  // ── Eden Code settings › Limits: the forecast's switches ──

  const SWITCHES = [
    ['code_forecast_show', 'Cost forecast under the composer', 'While you write, what the message is likely to cost and how much of Claude’s 5-hour limit it’s likely to take, from similar messages in the project. Statistics only: no model is asked.'],
    ['code_queue_overnight', 'Big queued cards wait for the night', 'In the routing queue, a card likely to take a quarter of the 5-hour limit or more waits for the night, leaving the day’s limits to you. Start it to run it now.'],
  ];
  let panel = null;

  // The Limits tab of Eden Code settings (code-usage.js adds to it too: found or made).
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
    const body = el('div', 'jcs-body');
    body.id = 'jcs-limits';
    body.setAttribute('role', 'tabpanel');
    body.hidden = true;
    card.append(body);
    tab.addEventListener('click', () => { if (typeof selectJcsTab === 'function') selectJcsTab('limits'); });
    new MutationObserver(() => { body.hidden = tab.getAttribute('aria-selected') !== 'true'; })
      .observe(tab, { attributes: true, attributeFilter: ['aria-selected'] });
    return body;
  }

  function build() {
    const tab = limitsTab();
    if (!tab) return;
    const box = el('div', 'cf-settings');
    box.append(el('p', 'jcs-label in', 'Forecast and queue'));
    const group = el('div', 'jcs-group');
    for (const [key, label, help] of SWITCHES) {
      const row = el('div', 'jcs-row');
      const text = el('span');
      text.append(document.createTextNode(F.t(label)), el('small', '', help));
      const sw = el('button', 'jcs-switch');
      sw.type = 'button';
      sw.dataset.key = key;
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-label', label);
      sw.addEventListener('click', () => F.send({ type: 'feature_prefs', changes: { [key]: sw.getAttribute('aria-checked') !== 'true' } }));
      row.append(text, sw);
      group.append(row);
    }
    box.append(group);
    tab.append(box);
    panel = box;
    drawSwitches();
  }

  function drawSwitches() {
    if (!panel) return;
    for (const sw of panel.querySelectorAll('.jcs-switch')) sw.setAttribute('aria-checked', String(features[sw.dataset.key] !== false));
  }

  build();
  const took = (f) => { features = f || {}; drawSwitches(); if (!on()) hide(); };
  F.on('prefs', (ev) => took(ev.features), { replay: true });
  F.on('hello', (ev) => took(ev.prefs && ev.prefs.features), { replay: true });
})(typeof window === 'object' ? window : globalThis);
