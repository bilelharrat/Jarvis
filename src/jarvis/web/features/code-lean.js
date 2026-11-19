// Eden Code for smaller models: lean mode (features/code_lean.py) and the models on this Mac
// (features/local_models.py) as the composer's model menu shows them.
// - localNote(m): a model on this Mac's line in the menu, "4.7 GB · 32k context · Ollama",
//   with "no tool calling" for one whose server says it takes no tools, and "add and use"
//   for one found running but not added yet (app.js modelMenu uses it, as edenLocalNote).
// - The session's "Lean mode" switch in the More menu (lean_state / lean_set): a short
//   prompt and six tools, on by default for a model on this Mac.
// - Settings › General › Smaller models: "Lean mode" Automatic / Every session / Off
//   (prefs.features code_lean_mode).
// Pure helpers are exported for node --test (tests/web/code-lean.test.mjs).
(function (root) {
  'use strict';

  function bytes(n) {
    if (!(Number(n) > 0)) return '';
    const gb = n / 1e9;
    if (gb >= 1) return `${gb >= 10 ? Math.round(gb) : +gb.toFixed(1)} GB`;
    return `${Math.max(1, Math.round(n / 1e6))} MB`;
  }
  function contextWords(n) {
    if (!(Number(n) > 0)) return '';
    if (n >= 1e6) return `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M context`;
    return `${Math.max(1, Math.round(n / 1024))}k context`;
  }
  // The menu's note for a model on this Mac: what it weighs, how much it reads, where it runs.
  function localNote(m) {
    if (!m) return '';
    const bits = [bytes(m.size), contextWords(m.context)];
    if (m.tools === false) bits.push('no tool calling');
    bits.push(m.server || m.provider_name || '');
    if (m.needs_add) bits.push('add and use');
    return bits.filter(Boolean).join(' · ');
  }
  const MODES = [
    ['auto', 'Automatic'],
    ['on', 'Every session'],
    ['off', 'Off'],
  ];
  const modeOf = (features) => (features && MODES.some(([id]) => id === features.code_lean_mode) ? features.code_lean_mode : 'auto');

  const api = { bytes, contextWords, localNote, modeOf, MODES };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  root.edenLocalNote = localNote;

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, t } = F;

  // ── the session's switch ──

  const states = new Map();  // session id -> what lean_state last said
  let askedFor = null;
  function ask() {
    const task = F.currentTask();
    const id = task ? task.id : null;
    if (id === askedFor) return;
    askedFor = id;
    if (id !== null) F.send({ type: 'lean_state', id });
  }
  F.on('tasks', ask);
  F.on('task_transcript', ask);
  F.on('lean_state', (ev) => { states.set(ev.id, ev); });
  const stateOf = (task) => (task ? states.get(task.id) || {} : {});

  F.registerMoreItem({
    label: 'Lean mode',
    get note() {
      const s = stateOf(F.currentTask());
      return s.why || t('A short prompt and six tools, for smaller and local models');
    },
    keepOpen: true,
    get switch() { return !!stateOf(F.currentTask()).on; },
    when: (task) => !!task,
    run: (on) => { const task = F.currentTask(); if (task) F.send({ type: 'lean_set', id: task.id, on: !!on }); },
  });

  // ── Settings › General: the default ──

  let features = {};
  let select = null;
  function build() {
    if (typeof document.getElementById !== 'function') return;  // (a stand-in window)
    const general = document.getElementById('jcs-general');
    if (!general || document.getElementById('lean-mode')) return;
    const label = el('p', 'jcs-label', 'Smaller models');
    const group = el('div', 'jcs-group');
    const row = el('label', 'jcs-row');
    const text = el('span');
    text.append(document.createTextNode(t('Lean mode')), el('small', '', 'A short prompt and six tools instead of Claude Code’s full set: about 2,000 tokens a turn instead of 30,000. Automatic: on for models on this Mac. Each session’s More menu can switch it.'));
    select = el('select', 'jcs-select');
    select.id = 'lean-mode';
    select.setAttribute('aria-label', 'Lean mode');
    for (const [id, words] of MODES) {
      const o = el('option', '', words);
      o.value = id;
      select.append(o);
    }
    select.addEventListener('change', () => {
      features = { ...features, code_lean_mode: select.value };
      F.send({ type: 'feature_prefs', changes: { code_lean_mode: select.value } });
    });
    row.append(text, select);
    group.append(row);
    const foot = general.querySelector('.jcs-foot');
    if (foot) general.insertBefore(label, foot); else general.append(label);
    general.insertBefore(group, label.nextSibling);
    draw();
  }
  function draw() { if (select) select.value = modeOf(features); }
  function onPrefs(p) { if (p && p.features) { features = p.features; draw(); } }
  F.on('hello', (ev) => onPrefs(ev.prefs), { replay: true });
  F.on('prefs', onPrefs);
  build();
})(typeof window === 'object' ? window : globalThis);
