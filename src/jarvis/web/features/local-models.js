// Settings › Brain, more rows (the backend is jarvis.features.local_models): the utility model
// Jarvis uses for its own quick jobs, model servers found running on this Mac (Ollama, LM
// Studio) added in one click, and offline mode: Jarvis thinking with a model on this Mac all
// the time. Model names come from the owner's own lists and servers: shown as data.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;

  let prefs = null;
  let providers = { models: [], providers: [] };
  let servers = null; // null until the first look
  let looking = false;
  let rows = null;

  function mine(node) {
    node.setAttribute('data-no-i18n', '');
    return node;
  }

  function button(label, onClick, cls = 'btn') {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;
  function localModels() {
    const local = new Set(providers.providers.filter((p) => p.kind === 'openai' && LOCAL.test(p.base_url || '')).map((p) => p.id));
    return providers.models.filter((m) => !m.builtin && local.has(m.provider));
  }

  function build() {
    if (rows) return rows;
    const anchor = F.$('fallback-add');
    const group = anchor ? anchor.closest('section.group') : null;
    if (!group) return null;
    rows = el('div', 'lm-rows');
    rows.id = 'local-models';

    const utility = el('label', 'row');
    utility.htmlFor = 'utility-model';
    const words = el('span');
    words.append(el('strong', '', 'Utility model'), el('small', '', 'For Jarvis’s own quick jobs in the background, like deciding whether a long task is worth keeping as a skill. Haiku costs least.'));
    const select = el('select');
    select.id = 'utility-model';
    select.addEventListener('change', () => send({ type: 'feature_prefs', changes: { utility_model: select.value } }));
    utility.append(words, select);

    const local = el('div', 'row stack lm-local');
    const localWords = el('span');
    localWords.append(el('strong', '', 'Models on this Mac'), el('small', '', 'Ollama or LM Studio, found running here. Added, a model can be the fallback, or run Jarvis all the time with nothing sent to Claude.'));
    const list = el('div', 'lm-servers');
    list.id = 'lm-servers';
    local.append(localWords, list);

    const offline = el('div', 'row lm-offline');
    offline.id = 'lm-offline';
    const offWords = el('span');
    const offNote = el('small', '', '');
    offNote.id = 'lm-offline-note';
    offWords.append(el('strong', '', 'Offline mode'), offNote);
    const sw = el('button', 'switch');
    sw.type = 'button';
    sw.id = 'sw-offline';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', 'Offline mode');
    sw.addEventListener('click', toggleOffline);
    offline.append(offWords, sw);

    const background = el('label', 'row');
    background.htmlFor = 'background-model';
    const bgWords = el('span');
    bgWords.append(el('strong', '', 'Background tasks’ model'), el('small', '', 'What does the work when you ask for something in the background. Each task stops at $1.00.'));
    const bgSelect = el('select');
    bgSelect.id = 'background-model';
    bgSelect.append(option('sonnet', 'Sonnet 5.5'), option('haiku', 'Haiku 4.5'), option('opus', 'Opus 5.5'));
    bgSelect.addEventListener('change', () => send({ type: 'feature_prefs', changes: { background_model: bgSelect.value } }));
    background.append(bgWords, bgSelect);

    rows.append(utility, background, local, offline);
    anchor.after(rows);
    return rows;
  }

  function option(value, label, own = false) {
    const o = el('option', '', label);
    o.value = value;
    if (own) mine(o);
    return o;
  }

  function renderUtility() {
    const select = F.$('utility-model');
    if (!select || !prefs) return;
    const chosen = (prefs.features && prefs.features.utility_model) || 'haiku';
    const builtin = providers.models.filter((m) => m.builtin);
    const added = providers.models.filter((m) => !m.builtin);
    const opts = builtin.length ? builtin.map((m) => option(m.ref, m.label || m.name)) : [option('haiku', 'Haiku 4.5')];
    opts.push(...added.map((m) => option(m.ref, m.name || m.label || m.model, true)));
    if (!opts.some((o) => o.value === chosen)) opts.push(option(chosen, 'A model since removed (Haiku is used)'));
    select.replaceChildren(...opts);
    select.value = chosen;
    const background = F.$('background-model');
    if (background) background.value = (prefs.features && prefs.features.background_model) || 'sonnet';
  }

  function renderServers() {
    const list = F.$('lm-servers');
    if (!list) return;
    const parts = [];
    if (servers === null || looking) {
      parts.push(el('p', 'small-status', 'Looking on this Mac…'));
    } else if (!servers.length) {
      parts.push(el('p', 'small-status', 'No model server is running on this Mac. Start Ollama or LM Studio, then look again.'));
    } else {
      for (const s of servers) {
        const line = el('div', 'lm-server');
        const text = el('span', 'lm-server-text');
        text.append(el('b', '', s.name), document.createTextNode(' '));
        const names = mine(el('span', 'lm-models', s.models.join(', ') + (s.count > s.models.length ? ', …' : '')));
        text.append(names);
        line.append(text);
        if (s.added) line.append(el('span', 'lm-added', 'Added'));
        else if (s.count) line.append(button('Add to Jarvis', () => { looking = true; renderServers(); send({ type: 'local_models_add', port: s.port }); }, 'btn primary'));
        else line.append(el('span', 'lm-added', 'No models yet'));
        parts.push(line);
      }
    }
    parts.push(button('Look again', () => { looking = true; renderServers(); send({ type: 'local_models_scan' }); }));
    list.replaceChildren(...parts);
  }

  function offlineState() {
    const local = localModels();
    const fallback = prefs ? prefs.fallback_model : '';
    const current = local.find((m) => m.ref === fallback);
    return { local, current, on: !!(prefs && prefs.fallback_always && current) };
  }

  function renderOffline() {
    const row = F.$('lm-offline');
    if (!row || !prefs) return;
    const { local, current, on } = offlineState();
    row.hidden = !local.length;
    F.$('sw-offline').setAttribute('aria-checked', String(on));
    const note = F.$('lm-offline-note');
    note.replaceChildren();
    if (on) {
      note.append(document.createTextNode(F.t('Jarvis thinks with this model on this Mac instead of Claude:') + ' '), mine(el('b', '', current.name || current.model)), document.createTextNode('. ' + F.t('Web searches and connected accounts still use the internet.')));
    } else {
      note.textContent = F.t('Run Jarvis on a model on this Mac all the time, instead of Claude. It’s slower, and web searches and connected accounts still use the internet.');
    }
  }

  function toggleOffline() {
    const { local, current, on } = offlineState();
    if (on) { send({ type: 'set_prefs', changes: { fallback_always: false } }); return; }
    const model = current || local[0];
    if (model) send({ type: 'set_prefs', changes: { fallback_model: model.ref, fallback_always: true } });
  }

  function render() {
    if (!build()) return;
    renderUtility();
    renderServers();
    renderOffline();
  }

  F.on('hello', (ev) => {
    prefs = ev.prefs || prefs;
    if (ev.providers) providers = { models: ev.providers.models || [], providers: ev.providers.providers || [] };
    render();
    send({ type: 'local_models_scan' });
  }, { replay: true });
  F.on('prefs', (ev) => { prefs = ev; render(); });
  F.on('providers', (ev) => { providers = { models: ev.models || [], providers: ev.providers || [] }; render(); });
  F.on('providers_error', () => { if (looking) { looking = false; renderServers(); } });
  F.on('local_models', (ev) => { servers = ev.servers || []; looking = false; renderServers(); });
})();
