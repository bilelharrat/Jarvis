// Eden Code's productivity ledger (features/code_ledger.py): the Productivity ledger pane,
// from the More menu, /ledger and the Usage pane's foot. Week by week from the owner's own
// sessions: changes landed and taken back, minutes spent reviewing, what it cost, what the
// Model Router's alternative would have cost, and, with the owner's hourly rate and the
// minutes a change saves them, whether the week paid off (weeks that didn't say so). It
// exports as a spreadsheet or a Markdown page. Its two numbers are also in Eden Code
// settings › General.
//
// It also measures review minutes: while a review pane (the Changes pane, a pull request,
// the reviews, Best of N) is open in a window that's in front, the seconds are counted and
// sent each minute (cw_review_time), for the engine radar's log (features/code_radar.py).
// Pure helpers are exported for node --test (tests/web/code-ledger.test.mjs).
(function (root) {
  'use strict';

  const REVIEW_PANES = ['diff', 'pr', 'pr-reviews', 'bestof'];
  const TICK_MS = 5000;
  const SEND_EVERY_MS = 60000;
  const LONGEST_TICK_MS = 30000;  // a gap longer than this (the Mac asleep) isn't review time

  // $5.50, −$25.50, – for nothing.
  function money(v) {
    if (v == null || !Number.isFinite(Number(v))) return '–';
    const n = Number(v);
    const s = `$${Math.abs(n).toFixed(2)}`;
    return n < 0 ? `−${s}` : s;
  }

  // Review time, counted per pane between sends: tick(now, pane, looking) adds the time since
  // the last tick to that pane while a review pane is in front; take() hands out whole
  // seconds per pane and keeps the rest.
  function reviewClock(panes = REVIEW_PANES) {
    const pending = new Map();
    let last = null;
    let lastPane = null;
    return {
      tick(now, pane, looking) {
        if (last != null && looking && pane && pane === lastPane && panes.includes(pane)) {
          const ms = Math.min(Math.max(0, now - last), LONGEST_TICK_MS);
          pending.set(pane, (pending.get(pane) || 0) + ms / 1000);
        }
        last = now;
        lastPane = looking ? pane : null;
      },
      take() {
        const out = [];
        for (const [pane, s] of pending) {
          const whole = Math.floor(s);
          if (whole >= 1) { out.push({ pane, seconds: whole }); pending.set(pane, s - whole); }
        }
        return out;
      },
    };
  }

  const VERDICT_CLASS = { paid_off: 'good', cost_more: 'bad', mostly_undone: 'bad', no_changes: 'none', unweighed: 'none' };

  const api = { money, reviewClock, VERDICT_CLASS, REVIEW_PANES };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, send, t } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  const state = { ledger: null, features: {}, saved: null };
  let askedAt = 0;

  function shownNow() { return typeof currentPane !== 'undefined' && currentPane === 'cw-ledger' && !F.$('jc-pane').hidden; }
  function ask() { askedAt = Date.now(); send({ type: 'cw_ledger' }); }
  function redraw() { if (shownNow()) draw(F.$('jc-pane-body')); drawSetting(); }

  function button(label, cls, run, title) {
    const b = el('button', cls, label);
    b.type = 'button';
    if (title) b.title = t(title);
    b.addEventListener('click', run);
    return b;
  }

  // "Changes 4" as a label (translated) and its number (the owner's, as it is).
  function fact(label, value, cls = '') {
    const s = el('span', `lg-fact ${cls}`);
    s.append(el('span', 'lg-key', label), document.createTextNode(' '), mine(el('span', 'lg-val', value)));
    return s;
  }

  function weekCard(w, verdicts, totals) {
    const card = el('div', `lg-week ${VERDICT_CLASS[w.verdict] || 'none'}`);
    const head = el('div', 'lg-week-head');
    const when = totals ? el('strong', '', 'All weeks') : mine(el('strong', '', new Date(`${w.week}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })));
    if (!totals) { const lead = el('span', 'jc-dim', 'Week of'); head.append(lead, document.createTextNode(' ')); }
    head.append(when, mine(el('span', `lg-pill ${VERDICT_CLASS[w.verdict] || 'none'}`, (verdicts || {})[w.verdict] || w.verdict)));
    card.append(head);
    const line1 = el('div', 'lg-line');
    line1.append(fact('Changes', String(w.changes)), fact('Landed', String(w.landed)), fact('Taken back', String(w.undone), w.undone ? 'warn' : ''));
    if (w.review_minutes) line1.append(fact('Review minutes', String(w.review_minutes)));
    card.append(line1);
    if (w.cost_usd != null) {
      const line2 = el('div', 'lg-line');
      line2.append(fact('Cost', money(w.cost_usd)), fact('Per landed change', money(w.cost_per_landed)));
      if (w.wasted_usd) line2.append(fact('On changes taken back', money(w.wasted_usd), 'warn'));
      card.append(line2);
    }
    if (w.routed) {
      const line3 = el('div', 'lg-line');
      line3.append(fact('Routed messages', String(w.routed)), fact('They cost', money(w.routed_usd)));
      if (w.alternative_usd != null) line3.append(fact('Router’s alternative (its estimate)', money(w.alternative_usd)));
      card.append(line3);
    }
    if (w.net_usd != null) {
      const line4 = el('div', 'lg-line');
      line4.append(fact('Time saved', money(w.value_usd)), fact('Net', money(w.net_usd), w.net_usd < 0 ? 'bad' : 'good'));
      card.append(line4);
    }
    return card;
  }

  function numberInput(key, label, step, max) {
    const input = el('input', 'jcs-input lg-num');
    input.type = 'number';
    input.min = '0';
    input.max = String(max);
    input.step = String(step);
    input.dataset.key = key;
    input.setAttribute('aria-label', t(label));
    const value = Number((state.features || {})[key] || 0);
    input.value = value ? String(value) : '';
    input.placeholder = '0';
    input.addEventListener('change', () => {
      const n = Number(input.value || 0);
      if (Number.isFinite(n) && n >= 0) send({ type: 'feature_prefs', changes: { [key]: Math.min(n, max) } });
    });
    return input;
  }

  function numbersForm(cls) {
    const box = el('div', cls);
    const rate = el('label', 'lg-field');
    rate.append(el('span', '', 'Your hourly rate (USD)'), numberInput('code_ledger_rate', 'Your hourly rate (USD)', 1, 10000));
    const mins = el('label', 'lg-field');
    mins.append(el('span', '', 'Minutes a landed change saves you'), numberInput('code_ledger_minutes', 'Minutes a landed change saves you', 1, 600));
    box.append(rate, mins);
    return box;
  }

  function draw(body) {
    const l = state.ledger;
    if (!l) { body.replaceChildren(el('p', 'jc-empty', 'Adding up your weeks…')); return; }
    const parts = [el('p', 'jc-dim lg-intro', 'From your own sessions in Eden Code. A change landed when nothing took it back here; cost is Claude Code’s own estimate (on a plan, the API price of what ran, not a bill).')];
    if (l.on === false) parts.push(el('p', 'lg-off', 'The engine radar is off in Eden Code settings, so new weeks aren’t counted.'));
    parts.push(numbersForm('lg-numbers'));
    if (!(l.rate > 0 && l.minutes > 0)) parts.push(el('p', 'jc-dim lg-intro', 'With your hourly rate and the minutes a change saves you, each week says whether it paid off. Without them, no week is called a win.'));
    if (!(l.weeks || []).length) parts.push(el('p', 'jc-dim', 'Nothing counted yet. Each turn of Eden Code’s sessions counts from now on.'));
    else {
      for (const w of l.weeks) parts.push(weekCard(w, l.verdicts));
      if (l.totals && l.weeks.length > 1) parts.push(weekCard(l.totals, l.verdicts, true));
    }
    const foot = el('div', 'lg-foot');
    foot.append(
      button('Export spreadsheet', 'jc-mini', () => send({ type: 'cw_ledger_export', format: 'csv' }), 'A CSV file in Documents › Jarvis › Eden Code'),
      button('Export page', 'jc-mini', () => send({ type: 'cw_ledger_export', format: 'md' }), 'A Markdown page in Documents › Jarvis › Eden Code'),
    );
    if (state.saved) {
      const s = state.saved;
      if (s.error) foot.append(mine(el('small', 'lg-bad', s.error)));
      else {
        foot.append(mine(el('small', 'jc-dim', s.name)), button('Show in Finder', 'jc-mini', () => send({ type: 'cw_export_reveal', path: s.path })));
      }
    }
    parts.push(foot);
    body.replaceChildren(...parts);
  }

  F.registerPane('cw-ledger', {
    title: 'Productivity ledger',
    render(body) {
      if (!state.ledger || Date.now() - askedAt > 10000) ask();
      draw(body);
    },
  });
  F.registerMoreItem({ label: 'Productivity ledger', note: 'Each week: what landed, what it cost, and whether it paid off', run: () => F.openPane('cw-ledger') });
  F.registerSlash({ name: 'ledger', help: 'The productivity ledger: each week, honestly', withoutSession: true, run() { F.openPane('cw-ledger'); return true; } });

  F.on('cw_ledger', (ev) => { state.ledger = ev; redraw(); });
  F.on('cw_ledger_export', (ev) => { state.saved = ev; redraw(); });

  // The Usage pane's foot gets a way here (code-usage.js draws that pane; this only adds).
  function linkFromUsage() {
    if (typeof currentPane === 'undefined' || currentPane !== 'usage') return;
    const body = F.$('jc-pane-body');
    if (!body || body.querySelector('.lg-from-usage')) return;
    const p = el('p', 'jc-dim lg-from-usage');
    p.append(button('Productivity ledger', 'jc-mini', () => F.openPane('cw-ledger'), 'Each week: what landed, what it cost, and whether it paid off'));
    body.append(p);
  }
  const paneBody = F.$('jc-pane-body');
  if (paneBody && typeof MutationObserver === 'function') new MutationObserver(linkFromUsage).observe(paneBody, { childList: true });

  // ── review minutes ──

  const clock = reviewClock();
  let sentAt = Date.now();
  function looking() {
    const pane = typeof currentPane !== 'undefined' ? currentPane : null;
    const open = pane && F.$('jc-pane') && !F.$('jc-pane').hidden;
    const front = document.visibilityState === 'visible' && (typeof document.hasFocus !== 'function' || document.hasFocus());
    return { pane, on: Boolean(open && front) };
  }
  function flush() {
    const task = F.currentTask && F.currentTask();
    for (const part of clock.take()) send({ type: 'cw_review_time', ...part, ...(task ? { id: task.id } : {}) });
    sentAt = Date.now();
  }
  setInterval(() => {
    const now = looking();
    clock.tick(Date.now(), now.pane, now.on);
    if (Date.now() - sentAt >= SEND_EVERY_MS || !REVIEW_PANES.includes(now.pane)) flush();
  }, TICK_MS);
  document.addEventListener('visibilitychange', () => { clock.tick(Date.now(), looking().pane, document.visibilityState === 'visible'); flush(); });

  // ── Eden Code settings › General ──

  (function addSettings() {
    const general = document.getElementById('jcs-general');
    if (!general || document.getElementById('jcs-ledger')) return;
    const group = el('div', 'jcs-group');
    group.id = 'jcs-ledger';
    for (const [key, label, note, step, max] of [
      ['code_ledger_rate', 'Your hourly rate (USD)', 'For the productivity ledger: what an hour of your time is worth. 0: not set.', 1, 10000],
      ['code_ledger_minutes', 'Minutes a landed change saves you', 'For the productivity ledger: your own guess. 0: not set.', 1, 600],
    ]) {
      const row = el('label', 'jcs-row');
      const text = el('span');
      text.append(document.createTextNode(t(label)), el('small', '', note));
      const input = numberInput(key, label, step, max);
      input.classList.add('lg-setting');
      row.append(text, input);
      group.append(row);
    }
    general.append(group);
  })();

  function drawSetting() {
    for (const input of document.querySelectorAll('input.lg-num')) {
      if (document.activeElement === input) continue;
      const v = Number((state.features || {})[input.dataset.key] || 0);
      input.value = v ? String(v) : '';
    }
  }
  function prefsFrom(prefs) {
    if (!prefs || !prefs.features) return;
    const before = JSON.stringify([state.features.code_ledger_rate, state.features.code_ledger_minutes]);
    state.features = prefs.features;
    drawSetting();
    const after = JSON.stringify([state.features.code_ledger_rate, state.features.code_ledger_minutes]);
    if (before !== after && shownNow()) ask();
  }
  F.on('hello', (ev) => prefsFrom(ev.prefs), { replay: true });
  F.on('prefs', (ev) => prefsFrom(ev), { replay: true });
})(typeof window === 'object' ? window : globalThis);
