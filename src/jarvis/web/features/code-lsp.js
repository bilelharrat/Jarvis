// Eden Code's language servers in the window (features/code_lsp.py): what they say about
// the files sessions edit, live, as a section of the Problems pane under the checkers'
// (web/features/code-verify.js draws the pane and asks each source in edenProblemSources);
// which server each of the project's languages has, and for one that isn't installed, the
// command that installs it (Eden Code never installs one); and the Settings switches.
//
// Everything shown from the backend is data: text only (textContent), user data marked
// data-no-i18n. Pure helpers are exported for node --test (tests/web/code-lsp.test.mjs).
(function (root) {
  'use strict';

  const KEPT = 20;  // projects whose latest lsp_problems is kept

  // A server as its chip says it: [text, its class].
  function serverChip(s) {
    if (!s) return ['', 'off'];
    if (s.status === 'ready' || s.status === 'starting') return [`${s.label} · ${s.name}`, s.status === 'starting' ? 'busy' : ''];
    if (s.status === 'installed') return [`${s.label} · ${s.name}`, 'idle'];
    return [s.label, 'off'];
  }

  // The servers the section says something about: those not installed (with how), and
  // those held off (with why).
  function notes(servers) {
    return (servers || []).filter((s) => s.status === 'missing' || s.status === 'held');
  }

  // The latest state of each project, the oldest let go past `kept`.
  function remember(map, ev, kept = KEPT) {
    if (!ev || !ev.path) return map;
    map.delete(ev.path);
    map.set(ev.path, ev);
    while (map.size > kept) map.delete(map.keys().next().value);
    return map;
  }

  // Counts as the run line says them.
  function summary(problems) {
    const errors = (problems || []).filter((p) => p.severity === 'error').length;
    const warnings = (problems || []).length - errors;
    if (!errors && !warnings) return ['No problems'];
    return [`${errors} error${errors === 1 ? '' : 's'}`, `${warnings} warning${warnings === 1 ? '' : 's'}`];
  }

  const api = { serverChip, notes, remember, summary };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, t } = F;
  const states = new Map();  // path -> its latest lsp_problems

  function section(info, h) {
    const st = states.get(info.path);
    if (!st || !st.on || (!st.servers.length && !st.problems.length)) return null;
    const box = el('section', 'lsp-section');
    const bar = el('div', 'cv-bar');
    const chips = el('span', 'cv-checkers');
    for (const s of st.servers) {
      const [text, cls] = serverChip(s);
      const chip = h.mine(el('span', `cv-checker lsp-chip${cls ? ` ${cls}` : ''}`, text));
      chip.title = s.why || (s.status === 'installed' ? t('Starts when a session first needs it') : s.status === 'ready' ? t('Running') : '');
      chips.append(chip);
    }
    bar.append(el('strong', 'lsp-head', 'Language servers'), chips);
    box.append(bar);
    for (const s of notes(st.servers)) {
      const p = el('p', 'lsp-note');
      if (s.status === 'held') p.append(h.mine(el('span', '', s.why)));
      else {
        p.append(h.mine(el('strong', '', s.label)), el('span', '', ': not installed. Eden Code never installs one; to use it, run'), document.createTextNode(' '), h.mine(el('code', '', s.install)));
      }
      box.append(p);
    }
    const running = st.servers.some((s) => s.status === 'ready' || s.status === 'starting');
    if (running || st.problems.length) {
      const errors = st.problems.filter((p) => p.severity === 'error').length;
      const status = st.problems.length ? (errors ? 'failed' : 'passed') : 'passed';
      const line = el('div', `cv-runline ${status}`);
      line.append(h.mark(`cv-mark ${status}`, status, errors ? '✕' : '✓'), h.pieces('', summary(st.problems)), el('span', 'jc-spacer'));
      if (st.problems.length && info.id && F.currentTask()) line.append(h.button('Fix these', 'jc-btn small tinted', () => h.send({ type: 'lsp_fix' }, info)));
      box.append(line);
    }
    if (!st.live) box.append(el('p', 'lsp-note', 'Live problems after each edit are off in Settings.'));
    for (const [file, items] of h.byFile(st.problems)) {
      const det = el('details', 'jc-card cv-file');
      det.open = true;
      const sum = el('summary');
      sum.append(h.mine(el('span', 'cv-file-name', file || t('(no file)'))), el('span', 'jc-spacer'), el('small', 'jc-dim', String(items.length)));
      const ul = el('ul', 'cv-problems');
      ul.append(...items.map(h.problemRow));
      det.append(sum, ul);
      box.append(det);
    }
    return box;
  }

  const sources = root.edenProblemSources = root.edenProblemSources || [];
  sources.push({ ask: (where) => F.send({ type: 'lsp_state', ...where }), section });
  F.on('lsp_problems', (ev) => {
    remember(states, ev);
    if (root.edenProblemsRedraw) root.edenProblemsRedraw();
  });

  // ── Settings ──

  const SWITCHES = [
    ['sw-lsp-on', 'code_lsp', 'Language servers for sessions',
      'Sessions can ask the project’s language server where a symbol is defined, everywhere it’s used, its type, how to rename it, and a file’s errors. Only servers you installed are used; Eden Code never installs one.'],
    ['sw-lsp-live', 'code_lsp_live', 'Live problems after each edit',
      'When a session edits a file, its language server checks it and what it finds shows in the Problems pane.'],
  ];

  function settingsGroup() {
    const settings = F.$('settings');
    if (!settings || F.$('lsp-settings')) return;
    const group = el('section', 'group');
    group.id = 'lsp-settings';
    group.append(el('h3', '', 'Language servers'));
    for (const [id, key, label, note] of SWITCHES) {
      const row = el('div', 'row');
      const text = el('span');
      text.append(el('strong', '', label), el('small', '', note));
      const sw = el('button', 'switch');
      sw.type = 'button';
      sw.id = id;
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', 'true');
      sw.setAttribute('aria-label', t(label));
      sw.addEventListener('click', () => {
        const on = sw.getAttribute('aria-checked') !== 'true';
        sw.setAttribute('aria-checked', String(on));
        F.send({ type: 'feature_prefs', changes: { [key]: on } });
      });
      row.append(text, sw);
      group.append(row);
    }
    const after = F.$('sw-code-narrate') && F.$('sw-code-narrate').closest('section');
    if (after) after.after(group); else settings.append(group);
  }
  function showSettings(features) {
    if (!features) return;
    for (const [id, key] of SWITCHES) {
      const sw = F.$(id);
      if (sw && key in features) sw.setAttribute('aria-checked', String(features[key] !== false));
    }
  }
  settingsGroup();
  F.on('prefs', (ev) => showSettings(ev.features));
  F.on('hello', (ev) => showSettings(ev.prefs && ev.prefs.features), { replay: true });
})(typeof window === 'object' ? window : globalThis);
