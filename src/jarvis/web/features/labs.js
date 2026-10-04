// Labs (features/_labs.py): Jarvis Code surfaces that aren't finished, off until switched on
// here, in Jarvis Code settings › General. A change takes effect at the next start: a Lab
// that's off is neither installed nor loaded in the window.
(function (root) {
  'use strict';
  const F = root.jarvisFeatures;
  if (!F) return;
  const t = (s) => F.t(s);
  const el = F.el;
  const LABS = [
    ['code_acp', 'Other agents (ACP)', 'Run Gemini CLI, Codex and other ACP agents as sessions.'],
    ['code_plugins', 'Plugins', 'Claude Code plugins: their commands, agents and hooks in sessions.'],
    ['code_split', 'Split view', 'Two live sessions side by side (⌘⇧\\ or /split).'],
  ];
  let on = [];
  let atStart = null;  // what was on when the window loaded: a change shows "restart"
  const switches = new Map();
  let note = null;

  function draw() {
    for (const [name, sw] of switches) sw.setAttribute('aria-checked', String(on.includes(name)));
    if (note) note.hidden = atStart === null || [...on].sort().join() === [...atStart].sort().join();
  }

  function build() {
    const general = document.getElementById('jcs-general');
    if (!general || document.getElementById('labs-group')) return;
    const label = el('p', 'jcs-label', t('Labs'));
    const group = el('div', 'jcs-group');
    group.id = 'labs-group';
    for (const [name, title, about] of LABS) {
      const row = el('div', 'jcs-row');
      const text = el('span');
      text.append(document.createTextNode(t(title)), el('small', '', t(about)));
      const sw = el('button', 'jcs-switch');
      sw.type = 'button';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-label', t(title));
      sw.addEventListener('click', () => {
        const next = on.includes(name) ? on.filter((n) => n !== name) : [...on, name];
        F.send({ type: 'feature_prefs', changes: { labs: next } });
      });
      switches.set(name, sw);
      row.append(text, sw);
      group.append(row);
    }
    note = el('small', 'jcs-note', t('Restart Jarvis to apply.'));
    note.hidden = true;
    group.append(note);
    general.append(label, group);
    draw();
  }

  const take = (features) => {
    on = Array.isArray(features && features.labs) ? features.labs : [];
    if (atStart === null) atStart = [...on];
    draw();
  };
  build();
  F.on('prefs', (ev) => take(ev.features), { replay: true });
  F.on('hello', (ev) => take(ev.prefs && ev.prefs.features), { replay: true });
})(typeof window === 'object' ? window : globalThis);
