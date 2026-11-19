// The owner's rules, enforced (features/code_guardrails.py): the Permissions pane's Guardrails
// section lists the project's lessons and CLAUDE.md / AGENTS.md rules that compiled into checks
// (deny or ask rules in Claude Code's syntax, the test command, text an edit mustn't add), each
// with where it's from, what it checks and its own switch, and the rules that stay as words,
// each with Suggest (one model call, shown here to confirm before it holds). Eden Code settings ›
// General has the switch for all of them (feature pref code_guardrails, on by default).
//
// The section is drawn by code-rules.js's pane (root.jarvisRulesSections), so it sits with the
// project's own rules. Rules and file names are data: text only, marked data-no-i18n.
// Pure helpers are exported for node --test (tests/web/code-guardrails.test.mjs).
(function (root) {
  'use strict';

  const SOURCES = { lesson: 'Your lesson', suggested: 'Confirmed suggestion' };
  const KINDS = { deny: 'Blocks', ask: 'Asks first', tests: 'Test command', check: 'Checks edits' };
  const LABEL = 'Enforce my rules as guardrails';
  const NOTE = 'Lessons and the rules in a project’s CLAUDE.md and AGENTS.md that can be checked hold on every step, Bypass too: they block, ask first or flag an edit, and the turn’s proof says which fired.';

  // Where a guardrail's rule is from, in words (a file's name as it is).
  const sourceLabel = (source) => SOURCES[source] || String(source || '');
  const kindLabel = (kind) => KINDS[kind] || KINDS.check;
  // What it checks, on one line.
  const enforcedLine = (g) => ((g && g.enforced) || []).join(' · ');
  // The section's count line: how many hold, how many are off, how many rules stay as words.
  function summary(state) {
    if (!state) return '';
    const all = state.guardrails || [];
    const off = all.filter((g) => g.on === false).length;
    const prose = Number(state.prose_count) || 0;
    const parts = [`${all.length} ${all.length === 1 ? 'guardrail' : 'guardrails'}`];
    if (off) parts.push(`${off} off`);
    if (prose) parts.push(`${prose} ${prose === 1 ? 'rule stays' : 'rules stay'} as words`);
    return parts.join(' · ');
  }

  const api = { sourceLabel, kindLabel, enforcedLine, summary, LABEL, NOTE, SOURCES, KINDS };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, t, send } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };
  const states = new Map();  // task id -> its latest gr_state
  let asked = { id: null, at: 0 };
  let enabled = true;  // prefs.features.code_guardrails
  const suggesting = new Set();  // rule ids waiting for a suggestion

  function ask(task) {
    const now = Date.now();
    if (asked.id === task.id && now - asked.at < 1500) return;
    asked = { id: task.id, at: now };
    send({ type: 'gr_state', id: task.id });
  }

  function toggle(label, on, aria, onClick) {
    const sw = el('button', `sw${on ? ' on' : ''} gr-switch`);
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(!!on));
    sw.setAttribute('aria-label', aria);
    sw.addEventListener('click', onClick);
    return sw;
  }

  function guardRow(task, g) {
    const row = el('div', `jc-audit-switch gr-row gr-${g.kind}${g.on === false ? ' off' : ''}`);
    const text = el('span');
    const head = el('span', 'gr-line');
    head.append(el('small', `gr-kind gr-k-${g.kind}`, kindLabel(g.kind)), mine(el('strong', 'gr-rule', g.rule)));
    const from = el('small', 'gr-from');
    from.append(el('span', '', sourceLabel(g.source)), document.createTextNode(' · '), mine(el('span', 'gr-what', enforcedLine(g))));
    text.append(head, from);
    if (g.hint) text.append(mine(el('small', 'gr-hint', g.hint)));
    row.append(text);
    if (g.source === 'suggested') {
      const forget = el('button', 'jc-btn small gr-forget', 'Forget');
      forget.type = 'button';
      forget.addEventListener('click', () => send({ type: 'gr_forget', id: task.id, rule: g.id }));
      row.append(forget);
    }
    row.append(toggle(g.rule, g.on !== false, t('This guardrail'), () => send({ type: 'gr_toggle', id: task.id, rule: g.id, on: g.on === false })));
    return row;
  }

  function proseRow(task, p, proposal) {
    const li = el('li', 'gr-prose');
    const text = el('span', 'gr-prose-text');
    text.append(mine(el('span', '', p.rule)), document.createTextNode(' '), el('small', 'gr-from', sourceLabel(p.source)));
    li.append(text);
    if (proposal) {
      const box = el('div', 'gr-proposal');
      box.append(el('small', '', 'Suggested:'), document.createTextNode(' '), mine(el('code', 'gr-what', enforcedLine(proposal))));
      const use = el('button', 'jc-btn small filled gr-use', 'Use it');
      use.type = 'button';
      use.addEventListener('click', () => send({ type: 'gr_confirm', id: task.id, rule: p.id }));
      const no = el('button', 'jc-btn small gr-no', 'No thanks');
      no.type = 'button';
      no.addEventListener('click', () => send({ type: 'gr_forget', id: task.id, rule: p.id }));
      box.append(use, no);
      li.append(box);
      return li;
    }
    const waiting = suggesting.has(p.id);
    const b = el('button', 'jc-mini gr-suggest', waiting ? 'Suggesting…' : 'Suggest a guardrail');
    b.type = 'button';
    b.disabled = waiting;
    b.title = t('One model call: a check for this rule, shown here first');
    b.addEventListener('click', () => {
      suggesting.add(p.id);
      b.disabled = true;
      b.textContent = t('Suggesting…');
      send({ type: 'gr_suggest', id: task.id, rule: p.id });
    });
    li.append(b);
    return li;
  }

  // The Permissions pane's section (code-rules.js draws it).
  function section(task) {
    const parts = [el('p', 'jc-label cr-head gr-head', 'Guardrails from your rules')];
    const state = states.get(task.id);
    parts.push(el('p', 'jc-dim cr-intro', 'Your lessons and this project’s CLAUDE.md and AGENTS.md rules that can be checked hold on every step, Bypass too. They only ever block, ask first or flag an edit.'));
    const master = el('div', 'jc-audit-switch gr-master');
    const words = el('span');
    words.append(el('strong', '', LABEL), el('small', '', 'Off: the rules are only words the session hears.'));
    master.append(words, toggle(LABEL, enabled, t(LABEL), () => send({ type: 'feature_prefs', changes: { code_guardrails: !enabled } })));
    parts.push(master);
    if (!state) {
      ask(task);
      parts.push(el('p', 'jc-dim cr-none', 'Reading the rules…'));
      return parts;
    }
    const guards = state.guardrails || [];
    parts.push(el('p', 'jc-dim gr-summary', summary(state)));
    if (!guards.length) parts.push(el('p', 'jc-dim cr-none', 'None yet. A rule like “use pnpm, not npm” or “never edit generated/” becomes one.'));
    else {
      const list = el('div', `gr-list${enabled ? '' : ' gr-all-off'}`);
      list.append(...guards.map((g) => guardRow(task, g)));
      parts.push(list);
    }
    const prose = state.prose || [];
    if (prose.length) {
      const box = el('details', 'gr-prose-box');
      if (Object.keys(state.proposals || {}).length || suggesting.size) box.open = true;
      box.append(el('summary', '', `${state.prose_count || prose.length} ${(state.prose_count || prose.length) === 1 ? 'rule stays' : 'rules stay'} as words`));
      const ul = el('ul', 'jc-list gr-prose-list');
      ul.append(...prose.map((p) => proseRow(task, p, (state.proposals || {})[p.id])));
      box.append(ul);
      parts.push(box);
    }
    if (state.error) parts.push(el('p', 'cr-error', state.error));
    if (state.note) parts.push(el('p', 'cr-note', state.note));
    return parts;
  }
  (root.jarvisRulesSections = root.jarvisRulesSections || []).push(section);

  F.on('gr_state', (ev) => {
    states.set(ev.id, ev);
    if (typeof ev.on === 'boolean') enabled = ev.on;
    if (ev.suggested) suggesting.delete(ev.suggested);
    if (ev.error || ev.note) suggesting.clear();
    if (root.jarvisRulesRedraw) root.jarvisRulesRedraw(ev.id);
  });

  // ── Eden Code settings › General ──
  let sw = null;
  function build() {
    const general = document.getElementById('jcs-general');
    if (!general || document.getElementById('gr-enforce')) return;
    const label = el('p', 'jcs-label', 'Guardrails');
    const group = el('div', 'jcs-group');
    const row = el('div', 'jcs-row');
    const text = el('span');
    text.append(document.createTextNode(t(LABEL)), el('small', '', NOTE));
    sw = el('button', 'jcs-switch');
    sw.type = 'button';
    sw.id = 'gr-enforce';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', t(LABEL));
    sw.setAttribute('aria-checked', String(enabled));
    sw.addEventListener('click', () => {
      enabled = !enabled;
      sw.setAttribute('aria-checked', String(enabled));
      send({ type: 'feature_prefs', changes: { code_guardrails: enabled } });
    });
    row.append(text, sw);
    group.append(row);
    const foot = general.querySelector('.jcs-foot');
    if (foot) general.insertBefore(label, foot); else general.append(label);
    general.insertBefore(group, label.nextSibling);
  }
  const take = (features) => {
    const before = enabled;
    enabled = !features || features.code_guardrails !== false;
    if (sw) sw.setAttribute('aria-checked', String(enabled));
    const task = F.currentTask();
    if (before !== enabled && task && root.jarvisRulesRedraw) {
      states.delete(task.id);  // (asked again: its list says on or off as it is now)
      asked = { id: null, at: 0 };
      root.jarvisRulesRedraw(task.id);
    }
  };
  build();
  F.on('prefs', (ev) => take(ev.features), { replay: true });
  F.on('hello', (ev) => take(ev.prefs && ev.prefs.features), { replay: true });
})(typeof window === 'object' ? window : globalThis);
