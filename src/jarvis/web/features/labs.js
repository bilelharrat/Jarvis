// Labs (features/_labs.py): Eden Code surfaces that aren't finished, off until switched on
// here, in Eden Code settings › General. A change takes effect at the next start: a Lab
// that's off is neither installed nor loaded in the window.
//
// Above them, the surfaces that left Labs (_labs.GRADUATED), each on its own switch (a
// feature pref, on unless turned off), also applied at the next start. Their switch is
// here, not in their own window file, which isn't loaded while they're off.
(function (root) {
  'use strict';
  const F = root.jarvisFeatures;
  if (!F) return;
  const t = (s) => F.t(s);
  const el = F.el;
  const LABS = [
    ['code_plugins', 'Plugins', 'Claude Code plugins: their commands, agents and hooks in sessions.'],
    ['code_queue', 'Routing queue', "Run a project's to-do cards in the background, each on the cheapest model that passes its checks, within a dollar ceiling."],
    ['code_split', 'Split view', 'Two live sessions side by side (⌘⇧\\ or /split).'],
  ];
  // [feature pref, title, what it is]: on unless the pref is false.
  const GRADUATED = [
    ['code_acp_agents', 'Other agents (ACP)', 'Run Codex, Gemini CLI, OpenCode and other ACP agents as sessions, with Rewind, usage and receipts.'],
  ];
  let on = [];
  let features = {};
  let atStart = null;  // what was on when the window loaded: a change shows "restart"
  const switches = new Map();
  const notes = [];  // [its group's restart note, what's on in that group]

  const labsOn = () => [...on].filter((n) => LABS.some(([name]) => name === n)).sort().join();
  const graduatedOn = () => GRADUATED.filter(([pref]) => features[pref] !== false).map(([pref]) => pref).join();

  function draw() {
    for (const [name, sw] of switches) {
      const graduated = GRADUATED.some(([pref]) => pref === name);
      sw.setAttribute('aria-checked', String(graduated ? features[name] !== false : on.includes(name)));
    }
    for (const [n, now] of notes) n.hidden = atStart === null || now() === atStart.get(now);
  }

  function switchRow(name, title, about, toggle) {
    const row = el('div', 'jcs-row');
    const text = el('span');
    text.append(document.createTextNode(t(title)), el('small', '', t(about)));
    const sw = el('button', 'jcs-switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', t(title));
    sw.addEventListener('click', toggle);
    switches.set(name, sw);
    row.append(text, sw);
    return row;
  }

  const restartNote = (now) => { const n = el('small', 'jcs-note', t('Restart Eden Secretary to apply.')); n.hidden = true; notes.push([n, now]); return n; };

  function build() {
    const general = document.getElementById('jcs-general');
    if (!general || document.getElementById('labs-group')) return;
    const done = el('div', 'jcs-group');
    done.id = 'graduated-group';
    for (const [pref, title, about] of GRADUATED) {
      done.append(switchRow(pref, title, about, () => F.send({ type: 'feature_prefs', changes: { [pref]: features[pref] === false } })));
    }
    done.append(restartNote(graduatedOn));
    const label = el('p', 'jcs-label', t('Labs'));
    const group = el('div', 'jcs-group');
    group.id = 'labs-group';
    for (const [name, title, about] of LABS) {
      // (a name that left Labs stays in the list, untouched: an older build still finds it)
      group.append(switchRow(name, title, about, () => {
        const next = on.includes(name) ? on.filter((n) => n !== name) : [...on, name];
        F.send({ type: 'feature_prefs', changes: { labs: next } });
      }));
    }
    group.append(restartNote(labsOn));
    general.append(el('p', 'jcs-label', t('Coding agents')), done, label, group);
    draw();
  }

  const take = (given) => {
    features = given && typeof given === 'object' ? given : {};
    on = Array.isArray(features.labs) ? features.labs : [];
    if (atStart === null) atStart = new Map([[labsOn, labsOn()], [graduatedOn, graduatedOn()]]);
    draw();
  };
  build();
  F.on('prefs', (ev) => take(ev.features), { replay: true });
  F.on('hello', (ev) => take(ev.prefs && ev.prefs.features), { replay: true });
})(typeof window === 'object' ? window : globalThis);
