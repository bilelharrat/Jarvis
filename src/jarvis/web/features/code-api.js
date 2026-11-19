// Eden Code settings › Control from code (features/code_api.py, code_automate.py): the switch
// for the local API (turning it on puts its scope on a card, with Touch ID), where it listens
// (127.0.0.1 and a port that stays put), the API token (shown only when asked, copied, or
// made anew, which stops the old one at once), the eden-code command's install, and the
// watches and webhooks: their own switch (a card too), each one's scope set up on the runs'
// own card, a webhook's address and its secret (shown when asked).
//
// Tokens, secrets, paths, patterns and names are data: text only (textContent), marked
// data-no-i18n. Pure helpers are exported for node --test (tests/web/code-api.test.mjs).
(function (root) {
  'use strict';

  const PORT = 8767;
  const HOOKS_PORT = 8768;

  // The API's address, as the eden-code command and scripts use it.
  function apiAddress(port) {
    const n = Number(port);
    return `http://127.0.0.1:${Number.isInteger(n) && n > 0 ? n : PORT}`;
  }

  // A webhook's whole address on this Mac (a tunnel's own goes in place of 127.0.0.1:port).
  function hookAddress(port, path) {
    const n = Number(port);
    return `http://127.0.0.1:${Number.isInteger(n) && n > 0 ? n : HOOKS_PORT}${path || ''}`;
  }

  // How to sign a delivery, for the owner to copy into a script (the secret left as a name).
  function curlExample(port, path) {
    return [
      'BODY=\'{"text":"the deploy failed"}\'',
      'TS=$(date +%s)',
      'SIG=$(printf "%s.%s" "$TS" "$BODY" | openssl dgst -sha256 -hmac "$EDEN_HOOK_SECRET" | sed "s/^.* //")',
      `curl -X POST "${hookAddress(port, path)}" -H "X-Eden-Timestamp: $TS" -H "X-Eden-Signature: sha256=$SIG" -d "$BODY"`,
    ].join('\n');
  }

  // "npm test, uv run pytest" -> ['npm test', 'uv run pytest']
  function commandsOf(text) {
    return String(text || '').split(/[,\n]+/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
  }

  // Why a watch's pattern can't be saved ('' when it can), as the backend checks it.
  function patternProblem(text) {
    const p = String(text || '').trim();
    if (!p || p.length > 200 || p.startsWith('/') || p.startsWith('~') || p.includes('\\') || p.split('/').includes('..')) {
      return 'The pattern is a path inside the project, like src/**/*.py.';
    }
    return '';
  }

  const api = { apiAddress, hookAddress, curlExample, commandsOf, patternProblem };
  if (typeof module === 'object' && module.exports) module.exports = api;

  const F = root.jarvisFeatures;
  if (!F || typeof document === 'undefined') return;
  const { el, send, t } = F;
  const keepFocus = (box, drawIt) => (root.jarvisFocus ? root.jarvisFocus.keep(box, drawIt) : drawIt());
  const state = {
    api: null,
    automate: null,
    token: '',
    secrets: {},
    watch: { project: '', glob: '', prompt: '', commands: '', spend: '5' },
    hook: { name: '', project: '', prompt: '', commands: '', spend: '5', network: false },
  };
  const projects = () => (typeof deckProjects !== 'undefined' ? deckProjects.map((p) => p.name) : []);
  let group = null;

  function mine(text, tag = 'span', cls = '') {
    const node = el(tag, cls, text);
    node.dataset.noI18n = '';
    return node;
  }

  function button(label, cls, run, aria) {
    const b = el('button', `jc-btn small ${cls || ''}`.trim(), label);
    b.type = 'button';
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', (e) => { e.preventDefault(); run(b); });
    return b;
  }

  function sw(label, on, run) {
    const toggle = el('button', 'jcs-switch');
    toggle.type = 'button';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(!!on));
    toggle.setAttribute('aria-label', t(label));
    toggle.addEventListener('click', () => run(!on));
    return toggle;
  }

  function row(title, note, control) {
    const r = el('div', 'jcs-row');
    const text = el('span');
    text.append(document.createTextNode(t(title)));
    if (note) text.append(el('small', '', note));
    r.append(text);
    if (control) r.append(control);
    return r;
  }

  function input(value, label, run, opts = {}) {
    const box = el('input', 'jcs-input');
    box.value = value || '';
    if (opts.type) box.type = opts.type;
    if (opts.placeholder) box.placeholder = opts.placeholder;
    box.setAttribute('aria-label', t(label));
    box.dataset.noI18n = '';
    box.autocomplete = 'off';
    box.addEventListener('input', () => run(box.value));
    return box;
  }

  function projectPick(f) {
    const names = projects();
    if (!f.project && names.length) f.project = names[0];
    const pick = el('select', 'jcs-select');
    pick.setAttribute('aria-label', t('Project'));
    pick.dataset.noI18n = '';
    for (const name of names) {
      const o = el('option', '', name);
      o.value = name;
      o.selected = name === f.project;
      pick.append(o);
    }
    pick.addEventListener('change', () => { f.project = pick.value; });
    return pick;
  }

  function tools(...nodes) {
    const box = el('span', 'jcx-api-tools');
    box.append(...nodes);
    return box;
  }

  function copy(text) {
    try { navigator.clipboard.writeText(text); } catch { /* no clipboard: it's shown to copy by hand */ }
  }

  function apiBlock() {
    const s = state.api || { on: false, port: PORT, listening: false, error: '', has_token: false, cli: {} };
    const box = el('section', 'jcx-api-block');
    box.setAttribute('aria-label', t('Programs on this Mac'));
    box.append(row('Programs on this Mac', 'Scripts, CI and other agents with your API token can start sessions (never in Auto or Bypass permissions), send them messages, read them, stop them and add to-do cards. Landing, discarding and Exterminator Mode still ask you here.',
      sw('Programs on this Mac', s.on, (on) => send({ type: 'code_api_turn', on }))));
    if (s.error) {
      const warn = mine(s.error, 'p', 'jcx-api-error');
      warn.setAttribute('role', 'alert');
      box.append(warn);
    } else if (s.on && s.listening) {
      box.append(row('Address', 'On this Mac only.', tools(mine(apiAddress(s.port), 'code'))));
    }
    if (s.on) {
      const shown = state.token ? mine(state.token, 'code', 'jcx-api-token') : el('code', 'jcx-api-token', '••••••••');
      box.append(row('API token', 'Kept in the Keychain. Send it as Authorization: Bearer <token>.', tools(
        shown,
        state.token ? button('Hide', '', () => { state.token = ''; draw(); }) : button('Show', '', () => send({ type: 'code_api_token', action: 'show' }), t('Show the API token')),
        ...(state.token ? [button('Copy', '', () => copy(state.token), t('Copy the API token'))] : []),
        button('Regenerate', 'danger', () => { state.token = ''; send({ type: 'code_api_token', action: 'regenerate' }); }, t('Make a new API token')),
      )));
      let port = String(s.port || PORT);
      box.append(row('Port', 'It stays the same across launches.', tools(
        input(port, 'Port', (v) => { port = v; }, { type: 'number' }),
        button('Save', '', () => { const n = Number(port); if (Number.isInteger(n) && n >= 1024 && n <= 65535) send({ type: 'code_api_port', port: n }); }, t('Save the port')),
      )));
      const cli = s.cli || {};
      box.append(row('The eden-code command', cli.installed ? `Installed: ${cli.path}` : 'Writes ~/.local/bin/eden-code, which runs Eden Code’s own Python. Then: eden-code sessions, eden-code start --project … --prompt …',
        tools(button(cli.installed ? 'Install again' : 'Install', '', () => send({ type: 'code_api_install_cli' }), t('Install the eden-code command')))));
    }
    return box;
  }

  function watchForm() {
    const f = state.watch;
    const form = el('form', 'jcx-api-form');
    const why = el('small', 'jcx-api-error');
    why.setAttribute('role', 'status');
    form.append(
      row('Project', '', projectPick(f)),
      row('Files', 'A pattern in the project; * crosses folders.', input(f.glob, 'Files', (v) => { f.glob = v; }, { placeholder: 'src/**/*.py' })),
      row('What to do', 'Its first message, each time the files change.', input(f.prompt, 'What to do', (v) => { f.prompt = v; }, { placeholder: 'Run the tests and fix what fails' })),
      row('Commands it may run', 'Beyond the read-only ones and the project’s own rules.', input(f.commands, 'Commands it may run', (v) => { f.commands = v; }, { placeholder: 'npm test, uv run pytest' })),
      row('Spending cap ($)', 'For each run.', input(f.spend, 'Spending cap ($)', (v) => { f.spend = v; }, { type: 'number' })),
    );
    const go = el('button', 'jc-btn small filled', 'Add a watch…');
    go.type = 'submit';
    const acts = el('div', 'jcx-api-actions');
    acts.append(why, el('span', 'jc-spacer'), go);
    form.append(acts);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const problem = patternProblem(f.glob) || (f.prompt.trim() ? '' : 'Say what to do first.');
      why.textContent = problem ? t(problem) : '';
      if (problem) return;
      send({ type: 'code_watch_add', project: f.project, glob: f.glob.trim(), prompt: f.prompt.trim(), commands: commandsOf(f.commands), spend_cap: Number(f.spend) || 5 });
    });
    return form;
  }

  function hookForm() {
    const f = state.hook;
    const form = el('form', 'jcx-api-form');
    form.append(
      row('Name', 'Letters, digits, spaces, dots, dashes.', input(f.name, 'Name', (v) => { f.name = v; }, { placeholder: 'deploy-failed' })),
      row('Project', '', projectPick(f)),
      row('What to do', 'What it sends is added to this, as data.', input(f.prompt, 'What to do', (v) => { f.prompt = v; }, { placeholder: 'Find why the deploy failed and fix it' })),
      row('Commands it may run', 'Beyond the read-only ones and the project’s own rules.', input(f.commands, 'Commands it may run', (v) => { f.commands = v; }, { placeholder: 'npm test' })),
      row('Spending cap ($)', 'For each run.', input(f.spend, 'Spending cap ($)', (v) => { f.spend = v; }, { type: 'number' })),
      row('Commands without network access', 'Its commands run in a sandbox. Turn it off if its tests need the network.', sw('Commands without network access', !f.network, (on) => { f.network = !on; draw(); })),
    );
    const go = el('button', 'jc-btn small filled', 'Add a webhook…');
    go.type = 'submit';
    const acts = el('div', 'jcx-api-actions');
    acts.append(el('span', 'jc-spacer'), go);
    form.append(acts);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      send({ type: 'code_hook_add', name: f.name.trim(), project: f.project, prompt: f.prompt.trim(), commands: commandsOf(f.commands), spend_cap: Number(f.spend) || 5, sandbox: !f.network });
    });
    return form;
  }

  function automateBlock() {
    const s = state.automate || { on: false, watches: [], hooks: [], listener: {} };
    const box = el('section', 'jcx-api-block');
    box.setAttribute('aria-label', t('Watches and webhooks'));
    box.append(row('Watches and webhooks', 'Runs without you that start by themselves: when files change, or when another program sends a signed request. Each in an isolated copy, in Accept edits, within the scope you OK on its card.',
      sw('Watches and webhooks', s.on, (on) => send({ type: 'code_automate_turn', on }))));
    if (!s.on) return box;
    const watches = el('ul', 'jcx-api-list');
    watches.setAttribute('aria-label', t('Watches'));
    for (const w of s.watches || []) {
      const li = el('li', 'jcx-api-item');
      li.append(mine(`${w.project} · ${w.glob}`, 'strong'), mine(w.prompt, 'small', 'jc-dim'),
        button('Remove', 'danger', () => send({ type: 'code_watch_remove', id: w.id }), `${t('Remove')} ${w.glob}`));
      watches.append(li);
    }
    box.append(el('p', 'jcs-label', 'Watches'), ...(s.watches || []).length ? [watches] : [el('p', 'jc-dim', 'No watches yet.')], watchForm());
    const lis = s.listener || {};
    const hooks = el('ul', 'jcx-api-list');
    hooks.setAttribute('aria-label', t('Webhooks'));
    for (const h of s.hooks || []) {
      const li = el('li', 'jcx-api-item');
      const secret = state.secrets[h.id];
      li.append(mine(`${h.name} → ${h.project}`, 'strong'), mine(hookAddress(lis.port, h.path), 'code'),
        ...(secret ? [mine(secret, 'code', 'jcx-api-token'), mine(curlExample(lis.port, h.path), 'pre', 'jcx-api-example')] : []),
        tools(
          secret ? button('Hide', '', () => { delete state.secrets[h.id]; draw(); }) : button('Show the secret', '', () => send({ type: 'code_hook_secret', id: h.id }), `${t('Show the secret')}: ${h.name}`),
          button('Remove', 'danger', () => send({ type: 'code_hook_remove', id: h.id }), `${t('Remove')} ${h.name}`),
        ));
      hooks.append(li);
    }
    box.append(el('p', 'jcs-label', 'Webhooks'));
    if (lis.error) {
      const warn = mine(lis.error, 'p', 'jcx-api-error');
      warn.setAttribute('role', 'alert');
      box.append(warn);
    }
    box.append(...(s.hooks || []).length ? [hooks] : [el('p', 'jc-dim', 'No webhooks yet.')], hookForm());
    return box;
  }

  function draw() {
    if (!group) return;
    keepFocus(group, () => group.replaceChildren(
      row('Control Eden Code from code', 'The eden-code command and a local API (docs/eden-code-api.md). Off until you turn it on.'),
      apiBlock(),
      automateBlock(),
    ));
  }

  (function addSettings() {
    const general = document.getElementById('jcs-general');
    if (!general) return;
    const label = el('p', 'jcs-label', 'Control from code');
    group = el('div', 'jcs-group jcx-api');
    const foot = general.querySelector('.jcs-foot');
    general.insertBefore(label, foot);
    general.insertBefore(group, foot);
    draw();
  })();

  F.on('hello', () => { send({ type: 'code_api_state' }); send({ type: 'code_automate_state' }); }, { replay: true });
  F.on('code_api', (ev) => { state.api = ev; if (!ev.on) state.token = ''; draw(); });
  F.on('code_api_token', (ev) => { state.token = String(ev.token || ''); draw(); });
  F.on('code_automate', (ev) => { state.automate = ev; draw(); });
  F.on('code_hook_secret', (ev) => { if (ev.id) { state.secrets[ev.id] = String(ev.secret || ''); draw(); } });
  F.on('claude_projects', () => draw());
})(typeof window === 'object' ? window : globalThis);
