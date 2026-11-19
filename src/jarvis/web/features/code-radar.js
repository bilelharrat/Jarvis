// Eden Code's engine radar (features/code_radar.py) and its engine pin (features/
// code_engines.py): the Engine radar pane, from the More menu, /radar, the Health pane and
// the radar's heads-up. What changed after each Claude Code or model update (reads per
// edit, edits without a read first, turns stopped, rewound and reverted, tests passed, cost
// per landed change, before and after, with how sure the numbers are), a way back to the
// engine before it (or a pin to the one now), the engines that could run Eden Code's
// sessions, and every engine and model by its numbers. Its settings go in Eden Code
// settings › General. Pure helpers are exported for node --test (tests/web/code-radar.test.mjs).
(function (root) {
  'use strict';

  // A metric's value as the pane shows it: a share in percent, a cost in dollars, a ratio
  // with one decimal.
  function shown(kind, v) {
    if (v == null || !Number.isFinite(Number(v))) return '–';
    if (kind === 'share') return `${Math.round(Number(v) * 100)}%`;
    if (kind === 'cost') return `$${Number(v).toFixed(2)}`;
    return Number(v).toFixed(1);
  }

  // What changed: the engine, the model, or both.
  function changeTitle(c) {
    if (!c) return '';
    const b = c.before || {};
    const a = c.after || {};
    if (c.change === 'model') return `${b.model} → ${a.model}`;
    if (c.change === 'both') return `Claude Code ${b.engine} → ${a.engine} · ${b.model} → ${a.model}`;
    return `Claude Code ${b.engine} → ${a.engine}`;
  }

  // The engine to go back to after an engine update: one that says the version before it,
  // can run, and isn't the one running now.
  function wayBack(c, candidates) {
    if (!c || c.change === 'model') return null;
    const want = (c.before || {}).engine;
    return (candidates || []).find((x) => x.version === want && x.usable && !x.current) || null;
  }

  // The Health pane's line for the radar.
  function healthWords(r) {
    if (!r) return '';
    if (r.on === false) return 'Off';
    if (r.status === 'shift') return r.shifts === 1 ? 'Worse after an update' : 'Worse after updates';
    if (r.status === 'collecting') return 'Watching the latest update';
    if (r.status === 'steady') return 'No change after updates';
    return 'Nothing measured yet';
  }

  const STATUS = { shift: 'Worse after this update', steady: 'No real change', collecting: 'Still measuring' };

  const api = { shown, changeTitle, wayBack, healthWords, STATUS };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, send, t } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  const state = { radar: null, engines: null, scope: '', features: {}, showDismissed: false };
  let askedAt = 0;

  function shownNow() { return typeof currentPane !== 'undefined' && currentPane === 'cw-radar' && !F.$('jc-pane').hidden; }
  function ask(fresh) {
    askedAt = Date.now();
    send({ type: 'cw_radar', ...(fresh ? { fresh: true } : {}) });
    send({ type: 'cw_engines', ...(fresh ? { fresh: true } : {}) });
  }
  function redraw() { if (shownNow()) draw(F.$('jc-pane-body')); drawSetting(); }

  function button(label, cls, run, title) {
    const b = el('button', cls, label);
    b.type = 'button';
    if (title) b.title = t(title);
    b.addEventListener('click', run);
    return b;
  }

  function projectName(hash) {
    const names = (state.radar && state.radar.names) || {};
    return names[hash] || `Project ${hash.slice(0, 6)}`;
  }

  function section(title, ...nodes) {
    const box = el('section', 'rd-section');
    box.append(el('p', 'jc-label', title), ...nodes);
    return box;
  }

  function metricsTable(rows) {
    const table = el('table', 'rd-table');
    const head = el('tr');
    for (const h of ['', 'Before', 'After', 'Sure?']) head.append(el('th', '', h));
    table.append(head);
    for (const r of rows) {
      const tr = el('tr', r.significant ? (r.worse ? 'rd-worse' : 'rd-better') : '');
      tr.append(el('td', '', r.label));
      tr.append(mine(el('td', 'rd-num', shown(r.kind, r.before))), mine(el('td', 'rd-num', shown(r.kind, r.after))));
      const sure = !r.enough ? el('td', 'jc-dim', 'Too few') : (r.significant ? el('td', '', 'Yes') : el('td', 'jc-dim', 'No'));
      sure.title = `p = ${r.p}`;
      tr.append(sure);
      table.append(tr);
    }
    return table;
  }

  function changeCard(c) {
    const engines = state.engines || {};
    const dismissed = (state.radar.dismissed || []).includes(c.key);
    const card = el('div', `rd-change ${c.status}${dismissed ? ' dismissed' : ''}`);
    const head = el('div', 'rd-change-head');
    head.append(mine(el('strong', '', changeTitle(c))), el('span', `rd-pill ${c.status}`, STATUS[c.status] || c.status));
    card.append(head);
    const sub = el('p', 'jc-dim rd-sub');
    sub.append(mine(el('span', '', c.family)), document.createTextNode(' · '),
      c.scope ? mine(el('span', '', projectName(c.scope))) : el('span', '', 'All projects'), document.createTextNode(' · '),
      mine(el('span', '', `${c.before.turns} → ${c.after.turns}`)), document.createTextNode(' '), el('span', '', 'turns'));
    card.append(sub);
    if (c.rows && c.rows.length) card.append(metricsTable(c.rows));
    else if (c.status === 'collecting') card.append(el('p', 'jc-dim rd-sub', 'A comparison needs 25 turns on each side.'));
    const acts = el('div', 'rd-acts');
    if (c.status === 'shift' && c.change !== 'model') {
      const back = wayBack(c, engines.candidates);
      if (back) {
        const go = button('Use the engine before', 'jc-btn small filled', () => { go.disabled = true; send({ type: 'cw_engine_pin', path: back.path }); }, 'Pins Eden Code’s sessions to the engine before this update');
        acts.append(go, mine(el('small', 'jc-dim', back.version)));
      } else {
        card.append(el('p', 'jc-dim rd-sub', 'Eden Code has no copy of the engine before this update. Install that version with Claude Code’s own installer or npm, then choose it under Engine below.'));
      }
      const cur = engines.current || {};
      if (!cur.pinned && cur.path && cur.version === c.after.engine) {
        acts.append(button('Pin this version', 'jc-btn small', () => send({ type: 'cw_engine_pin', path: cur.path }), 'Keeps this engine even after Eden Code updates'));
      }
    }
    if (c.status !== 'collecting') {
      acts.append(button(dismissed ? 'Show again' : 'Dismiss', 'jc-mini', () => send({ type: 'cw_radar_dismiss', key: c.key, ...(dismissed ? { undo: true } : {}) })));
    }
    if (acts.childNodes.length) card.append(acts);
    return card;
  }

  function engineSection() {
    const e = state.engines;
    if (!e) return section('Engine', el('p', 'jc-dim', 'Looking for engines…'));
    const cur = e.current || {};
    const now = el('div', 'rd-engine-now');
    now.append(el('span', '', 'Sessions run'), document.createTextNode(' '), mine(el('strong', '', cur.version ? `Claude Code ${cur.version}` : '?')),
      document.createTextNode(' '), el('span', `rd-pill ${cur.pinned ? 'pinned' : 'steady'}`, cur.pinned ? 'Pinned' : 'Built in'));
    const parts = [now];
    if (cur.pinned) parts.push(button('Use the built-in engine', 'jc-btn small', () => send({ type: 'cw_engine_unpin' }), 'Eden Code’s own engine, updated with Eden Code'));
    const list = el('ul', 'jc-list rd-engines');
    for (const c of e.candidates || []) {
      const li = el('li', `rd-engine${c.current ? ' current' : ''}`);
      const words = el('span', 'rd-engine-words');
      words.append(mine(el('strong', '', c.version || '?')), document.createTextNode(' '),
        el('small', 'jc-dim', { 'built-in': 'Built in', kept: 'Kept copy', installed: 'Installed' }[c.source] || c.source));
      words.append(mine(el('small', 'jc-dim rd-path', c.path)));
      li.append(words);
      if (c.current) li.append(el('small', 'rd-here', 'Running'));
      else if (c.usable) li.append(button('Use this', 'jc-mini', () => send({ type: 'cw_engine_pin', path: c.path }), 'Pins Eden Code’s sessions to this engine'));
      else li.append(el('small', 'jc-dim', 'Too old'));
      list.append(li);
    }
    parts.push(list);
    const own = el('form', 'rd-own');
    const input = el('input', 'jcs-input rd-own-path');
    input.placeholder = t('Another claude file: its full path');
    input.spellcheck = false;
    input.setAttribute('aria-label', t('Another claude file: its full path'));
    own.append(input, button('Use', 'jc-mini', () => {}));
    own.addEventListener('submit', (ev) => { ev.preventDefault(); if (input.value.trim()) send({ type: 'cw_engine_pin', path: input.value.trim() }); });
    own.querySelector('button').type = 'submit';
    parts.push(own);
    const limits = el('ul', 'rd-limits');
    for (const line of e.limits || []) limits.append(mine(el('li', 'jc-dim', line)));  // (said in the owner's language by the backend)
    parts.push(limits);
    return section('Engine', ...parts);
  }

  function breakdownSection() {
    const r = state.radar;
    const pick = el('select', 'jcs-select rd-scope');
    pick.setAttribute('aria-label', t('Projects'));
    const all = el('option', '', 'All projects');
    all.value = '';
    pick.append(all);
    for (const p of r.projects || []) {
      const o = mine(el('option', '', projectName(p.hash)));
      o.value = p.hash;
      pick.append(o);
    }
    pick.value = state.scope;
    pick.addEventListener('change', () => { state.scope = pick.value; redraw(); });
    const rows = (r.breakdown || {})[state.scope] || [];
    if (!rows.length) return section('By engine and model', pick, el('p', 'jc-dim', 'No turns measured yet.'));
    const table = el('table', 'rd-table rd-wide');
    const head = el('tr');
    for (const h of ['Engine', 'Model', 'Turns', 'Reads per edit', 'Edits without a read first', 'Turns you stopped', 'Turns rewound', 'Changes reverted', 'Test runs that passed', 'Cost per landed change']) head.append(el('th', '', h));
    table.append(head);
    for (const row of rows) {
      const tr = el('tr');
      tr.append(mine(el('td', '', row.engine)), mine(el('td', 'rd-model', row.model)), mine(el('td', 'rd-num', String(row.turns))));
      for (const [key, kind] of [['read_ratio', 'mean'], ['blind_edits', 'share'], ['interrupts', 'share'], ['rewinds', 'share'], ['reverts', 'share'], ['tests', 'share'], ['cost', 'cost']]) {
        tr.append(mine(el('td', 'rd-num', shown(kind, row[key]))));
      }
      table.append(tr);
    }
    const wrap = el('div', 'rd-scroll');
    wrap.append(table);
    return section('By engine and model', pick, wrap);
  }

  function draw(body) {
    const r = state.radar;
    if (!r) { body.replaceChildren(el('p', 'jc-empty', 'Reading the radar…')); return; }
    const parts = [el('p', 'jc-dim rd-intro', 'From your own sessions: what Claude Code did, per engine version and model. No prompt text or file names are kept, and no model is asked.')];
    if (r.on === false) parts.push(el('p', 'rd-off', 'The radar is off in Eden Code settings, so new turns aren’t measured.'));
    const changes = (r.changes || []).filter((c) => state.showDismissed || !(r.dismissed || []).includes(c.key));
    const hidden = (r.changes || []).length - changes.length;
    const cards = changes.length ? changes.map(changeCard) : [el('p', 'jc-dim', r.turns ? 'No update to compare yet: each engine and model so far is below.' : 'Nothing measured yet. Each turn of Eden Code’s sessions is counted from now on.')];
    if (hidden) cards.push(button('Show dismissed', 'jc-mini', () => { state.showDismissed = true; redraw(); }));
    parts.push(section('After updates', ...cards));
    parts.push(engineSection());
    parts.push(breakdownSection());
    const foot = el('div', 'rd-foot');
    foot.append(button('Check again', 'jc-mini', () => { ask(true); }));
    if (r.turns) foot.append(mine(el('small', 'jc-dim', `${r.turns}`)), el('small', 'jc-dim', 'turns measured'));
    parts.push(foot);
    body.replaceChildren(...parts);
  }

  F.registerPane('cw-radar', {
    title: 'Engine radar',
    render(body) {
      if (!state.radar || Date.now() - askedAt > 15000) ask(false);
      draw(body);
    },
  });
  F.registerMoreItem({ label: 'Engine radar', note: 'Did an update make Eden Code worse?', run: () => F.openPane('cw-radar') });
  F.registerSlash({ name: 'radar', help: 'The engine radar: Eden Code before and after updates', withoutSession: true, run() { F.openPane('cw-radar'); return true; } });

  F.on('cw_radar', (ev) => { state.radar = ev; redraw(); });
  F.on('cw_engines', (ev) => { state.engines = ev; redraw(); });

  // ── Eden Code settings › General ──

  function switchRow(id, label, note, key) {
    const row = el('div', 'jcs-row');
    const text = el('span');
    text.append(document.createTextNode(t(label)), el('small', '', note));
    const sw = el('button', 'jcs-switch');
    sw.type = 'button';
    sw.id = id;
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', t(label));
    sw.addEventListener('click', () => {
      const on = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', String(on));
      send({ type: 'feature_prefs', changes: { [key]: on } });
    });
    row.append(text, sw);
    return row;
  }

  const engineWords = el('small', '', '');
  (function addSettings() {
    const general = document.getElementById('jcs-general');
    if (!general || document.getElementById('jcs-radar')) return;
    const group = el('div', 'jcs-group');
    group.id = 'jcs-radar';
    group.append(
      switchRow('jcx-radar-on', 'Engine radar', 'Counts what each turn did (reads, edits, stops, undos, tests, cost) per Claude Code version and model, to tell when an update makes Eden Code worse. Kept on this Mac; no prompt text.', 'code_radar_on'),
      switchRow('jcx-radar-alerts', 'Heads-up when an update makes it worse', 'Only when the numbers are clear, once per update.', 'code_radar_alerts'),
      switchRow('jcx-engine-keep', 'Keep a copy of each Claude Code engine', 'So an update can be undone. On this Mac’s disk it takes no extra room.', 'code_engine_keep'),
    );
    const row = el('div', 'jcs-row');
    const text = el('span');
    text.append(document.createTextNode(t('Claude Code engine')), engineWords);
    row.append(text, button('Choose…', 'jc-btn small', () => {
      const close = document.getElementById('jcs-close');
      if (close) close.click();
      F.openPane('cw-radar');
    }));
    group.append(row);
    general.append(group);
  })();

  function drawSetting() {
    const f = state.features || {};
    for (const [id, key] of [['jcx-radar-on', 'code_radar_on'], ['jcx-radar-alerts', 'code_radar_alerts'], ['jcx-engine-keep', 'code_engine_keep']]) {
      const sw = document.getElementById(id);
      if (sw) sw.setAttribute('aria-checked', String(f[key] !== false));
    }
    const pin = f.code_engine_pin;
    engineWords.replaceChildren();
    if (pin && pin.version) engineWords.append(el('span', '', 'Pinned:'), document.createTextNode(' '), mine(el('span', '', pin.version)));
    else engineWords.append(el('span', '', 'Built in, updated with Eden Code'));
  }
  function prefsFrom(prefs) { if (prefs && prefs.features) state.features = prefs.features; drawSetting(); }
  F.on('hello', (ev) => prefsFrom(ev.prefs), { replay: true });
  F.on('prefs', (ev) => { prefsFrom(ev); if (shownNow()) send({ type: 'cw_engines' }); }, { replay: true });
  drawSetting();
})(typeof window === 'object' ? window : globalThis);
