// A project's setup and container (features/code_setup.py): the "Setup and container" pane
// shows the project's .jarvis/setup.sh (or launch.json's "setup"), the output of its latest
// run in this session's copy (live, read out politely to a screen reader), a Run again
// button, and the project's container switch with the owner's own image.
// helpers is exported for node --test (tests/web/code-setup.test.mjs).
(function (root) {
  'use strict';

  const IMAGE = /^[a-z0-9][a-z0-9._/:@+-]{0,250}$/;
  const helpers = {
    // The setting's project list with this project switched on or off.
    projectsWith(list, name, on) {
      const names = new Set(Array.isArray(list) ? list : []);
      if (on) names.add(name); else names.delete(name);
      return [...names];
    },
    // The owner's images with this project's set ('' clears it); null for one docker wouldn't take.
    imagesWith(map, name, image) {
      const next = { ...(map && typeof map === 'object' ? map : {}) };
      const value = String(image || '').trim();
      if (!value) { delete next[name]; return next; }
      if (!IMAGE.test(value)) return null;
      next[name] = value;
      return next;
    },
    // What the container line says.
    containerLine(c, found) {
      if (!c || !c.on) return 'Off: sessions run their commands on the Mac.';
      if (c.docker) return c.docker;
      if (c.running) return `This session's commands run in ${c.running.name} (${c.running.image}).`;
      if (c.image) return `New copies get a container from ${c.image}.`;
      if (found) return `New copies get a container from the project's devcontainer.json (${found}).`;
      return 'On, but there is no image: pick one, or add .devcontainer/devcontainer.json.';
    },
  };

  if (typeof module === 'object' && module.exports) { module.exports = helpers; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, send, t } = F;
  // Drawn anew with the keyboard kept in its place (code-focus.js): after this pane's own
  // buttons the focus would otherwise fall to the page (round 2, U5).
  const keepFocus = (box, drawIt) => (root.jarvisFocus ? root.jarvisFocus.keep(box, drawIt) : drawIt());
  const state = { features: {}, last: null, body: null, output: [], done: null, out: null, run: null };
  /* global deckProject */
  const project = () => (typeof deckProject === 'string' ? deckProject : '');

  function ask() {
    const task = F.currentTask();
    if (task && task.kind === 'code') send({ type: 'code_setup_state', id: task.id });
    else if (project()) send({ type: 'code_setup_state', directory: project() });
  }

  // Whether the Setup pane is the one showing (the pane's body is every pane's: being on the
  // page isn't enough, or a line of setup output would draw over whatever pane is open).
  /* global currentPane */
  const paneShown = () => state.body && state.body.isConnected && typeof currentPane !== 'undefined' && currentPane === 'setup';

  function render() {
    const body = state.body;
    if (!paneShown()) return;
    const ev = state.last;
    const wrap = el('div', 'jcx-setup');
    if (!ev) {
      wrap.append(el('p', 'jc-dim', project() ? 'Reading the project…' : 'Open a project first.'));
      keepFocus(body, () => body.replaceChildren(wrap));
      return;
    }
    const name = ev.project;
    wrap.append(el('p', 'jc-dim', 'Each new isolated copy runs the project’s setup first, so its session starts ready. It runs as you; a card shows it the first time and whenever it changes.'));
    wrap.append(el('p', 'jcs-label', 'Setup'));
    if (ev.setup) {
      const src = el('p', 'jcx-setup-src');
      const code = el('code', '', ev.setup.source);
      code.dataset.noI18n = '';
      src.append(code);
      const pre = el('pre', 'jcx-setup-script', ev.setup.text);
      pre.dataset.noI18n = '';
      pre.tabIndex = 0;
      pre.setAttribute('aria-label', t('The setup script'));
      wrap.append(src, pre);
    } else {
      wrap.append(el('p', 'jc-empty', ev.problem || 'No setup yet. Add .jarvis/setup.sh (or a "setup" entry in .jarvis/launch.json) to the project.'));
    }
    if (ev.setup && ev.problem) wrap.append(el('p', 'jcx-setup-warn', ev.problem));
    if (ev.copy) {
      const out = el('pre', 'jcx-setup-out', (state.output.length ? state.output : ev.output || []).join('\n') || t('No setup has run in this copy yet.'));
      out.dataset.noI18n = '';
      out.setAttribute('role', 'log');
      out.setAttribute('aria-live', 'polite');
      out.setAttribute('aria-label', t('Setup output'));
      out.tabIndex = 0;
      state.out = out;
      const run = el('button', 'jc-btn small', ev.busy || state.done === false ? 'Running…' : 'Run setup again');
      state.run = run;
      run.type = 'button';
      run.disabled = !ev.setup || !!ev.busy || state.done === false;
      run.addEventListener('click', () => { state.output = []; state.done = false; send({ type: 'code_setup_run', id: F.currentTask().id }); render(); });
      wrap.append(out, run);
    }
    wrap.append(el('p', 'jcs-label', 'Container'));
    const group = el('div', 'jcs-group');
    const c = ev.container || {};
    const row = el('div', 'jcs-row');
    const text = el('span');
    text.append(el('strong', '', 'Run new copies in a container'), el('small', '', helpers.containerLine(c, ev.devcontainer)));
    const sw = el('button', 'jcs-switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(!!c.on));
    sw.setAttribute('aria-label', t('Run new copies in a container'));
    sw.addEventListener('click', () => {
      send({ type: 'feature_prefs', changes: { code_container_projects: helpers.projectsWith(state.features.code_container_projects, name, !c.on) } });
      setTimeout(ask, 150);
    });
    row.append(text, sw);
    group.append(row);
    const imageRow = el('form', 'jcs-row jcx-setup-image');
    const label = el('label', '', 'Image');
    const input = el('input', 'jcs-input');
    input.id = 'jcx-setup-image';
    label.htmlFor = input.id;
    input.value = c.image || '';
    input.placeholder = ev.devcontainer || 'e.g. node:22 or python:3.12';
    input.spellcheck = false;
    input.autocomplete = 'off';
    const save = el('button', 'jc-btn small', 'Save');
    save.type = 'submit';
    const why = el('small', 'jcx-setup-warn');
    why.setAttribute('role', 'status');
    imageRow.addEventListener('submit', (e) => {
      e.preventDefault();
      const next = helpers.imagesWith(state.features.code_container_images, name, input.value);
      if (!next) { why.textContent = t('That isn’t an image name docker takes.'); return; }
      send({ type: 'feature_prefs', changes: { code_container_images: next } });
      setTimeout(ask, 150);
    });
    imageRow.append(label, input, save, why);
    group.append(imageRow);
    if (ev.devcontainer_problem) group.append(el('p', 'jcx-setup-warn', ev.devcontainer_problem));
    wrap.append(group);
    wrap.append(el('p', 'jc-dim', 'Your own image needs no card. One the project’s devcontainer.json names does, the first time and whenever it changes. Without Docker, sessions run on the Mac as usual.'));
    // What's being typed in the image's field outlives a redraw (the backend's answer).
    const typing = document.activeElement && body.contains(document.activeElement) && document.activeElement.id === input.id ? document.activeElement.value : null;
    if (typing !== null) input.value = typing;
    keepFocus(body, () => body.replaceChildren(wrap));
    if (typing !== null) input.focus();
  }

  // Setup's output as it comes: its lines go on the end of the output already shown, so the
  // pane isn't drawn anew for each line (that wiped what was being typed in it, and made the
  // output's live region anew, read from the top); the whole pane is drawn once it's done.
  function addOutput(lines, wasEmpty, trimmed) {
    const out = state.out;
    if (!out || !out.isConnected || !paneShown()) return false;
    if (wasEmpty || trimmed) out.textContent = state.output.join('\n');
    else if (lines.length) out.append(document.createTextNode(`\n${lines.join('\n')}`));
    if (state.run) {
      state.run.textContent = t(state.done === false ? 'Running…' : 'Run setup again');
      state.run.disabled = state.done === false || !(state.last && state.last.setup);
    }
    return true;
  }

  F.registerPane('setup', {
    title: 'Setup and container',
    render(body) { state.body = body; state.last = null; state.output = []; state.done = null; render(); ask(); },
  });
  F.registerMoreItem({ label: 'Setup and container', run: () => F.openPane('setup') });

  const mine = (ev) => {
    const task = F.currentTask();
    return task && ev.id === task.id;
  };
  F.on('code_setup', (ev) => { state.last = ev; if (ev.output && !state.output.length) state.output = [...ev.output]; render(); });
  F.on('code_setup_output', (ev) => {
    if (!mine(ev)) return;
    const lines = ev.lines || [];
    const wasEmpty = !state.output.length;
    const all = [...state.output, ...lines];
    state.output = all.slice(-400);
    if (ev.done) { state.done = true; ask(); } else state.done = false;
    if (!addOutput(lines, wasEmpty, all.length > 400)) render();
  });
  const fromPrefs = (prefs) => { if (prefs && prefs.features) state.features = prefs.features; };
  F.on('hello', (ev) => fromPrefs(ev.prefs), { replay: true });
  F.on('prefs', (ev) => fromPrefs(ev), { replay: true });
})(typeof window !== 'undefined' ? window : globalThis);
