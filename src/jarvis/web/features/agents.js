// The owner's agents (the backend is jarvis.features.agents): Settings › Agents, after
// Personality, lists them (Use, Edit, Delete) with the everyday Jarvis first, and an editor
// for a new one or a change: its name (and in Chinese), its persona, the tools it may use
// and the chats that reach it. The orb shows the agent in use (nothing while it's the
// everyday Jarvis). Names, places and accounts the owner typed are data: data-no-i18n.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, $, send } = F;
  const T = (text) => F.t(text);

  const S = { items: [], active: 'main', personas: [], tools: [], channels: [], max: 6, editing: null, confirm: '', confirmTimer: 0 };
  const CHANNEL_NAMES = { telegram: 'Telegram', imessage: 'iMessage', slack: 'Slack', discord: 'Discord' };

  function mine(node) {
    node.setAttribute('data-no-i18n', '');
    return node;
  }

  function button(label, cls, run) {
    const b = el('button', cls || 'btn', label);
    b.type = 'button';
    if (run) b.addEventListener('click', run);
    return b;
  }

  function field(id, label, input) {
    const row = el('label', 'row stack agent-field');
    row.htmlFor = id;
    const words = el('span');
    words.append(el('strong', '', label));
    input.id = id;
    row.append(words, input);
    return row;
  }

  function personaName(id) {
    const p = S.personas.find((x) => x.id === id);
    return p ? p.name : id;
  }

  // ── the orb's badge ──

  function badge() {
    let b = $('agent-badge');
    if (!b) {
      const orb = $('orb');
      if (!orb) return null;
      b = mine(el('p', 'agent-badge'));
      b.id = 'agent-badge';
      b.setAttribute('aria-live', 'polite');
      orb.after(b);
    }
    const agent = S.items.find((a) => a.id === S.active);
    b.hidden = !agent;
    const zh = window.jarvisI18n && window.jarvisI18n.lang() === 'zh';
    b.textContent = agent ? (zh && agent.zh_name ? agent.zh_name : agent.name) : '';
    if (agent) b.title = T('The agent in use');
    return b;
  }

  // ── Settings › Agents ──

  function build() {
    if ($('agents-group')) return $('agents-group');
    const settings = $('settings');
    const personality = $('persona-group');
    if (!settings || !personality) return null;
    const section = el('section', 'group agents-group');
    section.id = 'agents-group';
    const intro = el('p', 'small-status', 'One Jarvis does everything until you make another agent. Each agent has its own persona, memory and tools, and answers to its persona’s name.');
    const list = el('ul', 'agent-list');
    list.id = 'agent-list';
    const add = button('New agent…', 'btn', () => edit(null));
    add.id = 'agent-new';
    const form = el('form', 'agent-form');
    form.id = 'agent-form';
    form.hidden = true;
    form.setAttribute('aria-label', 'An agent');
    const name = mine(el('input'));
    name.maxLength = 32;
    name.placeholder = 'e.g. Work Jarvis';
    const zhName = mine(el('input'));
    zhName.maxLength = 32;
    const persona = el('select');
    const tools = el('div', 'agent-tools');
    tools.id = 'agent-tools';
    tools.setAttribute('role', 'group');
    tools.setAttribute('aria-label', 'Tools it can use');
    const toolsRow = el('div', 'row stack agent-field');
    const toolsHead = el('span');
    toolsHead.append(el('strong', '', 'Tools it can use'), el('small', '', 'Memory is always there. Everything you leave unticked is out of its reach; your approval cards ask as always.'));
    const allNone = el('div', 'agent-allnone');
    allNone.append(
      button('All', 'btn small', () => { for (const c of tools.querySelectorAll('input')) c.checked = true; }),
      button('None', 'btn small', () => { for (const c of tools.querySelectorAll('input')) c.checked = false; }),
    );
    toolsRow.append(toolsHead, allNone, tools);
    const routes = el('div', 'agent-routes');
    routes.id = 'agent-routes';
    const routesRow = el('div', 'row stack agent-field');
    const routesHead = el('span');
    routesHead.append(el('strong', '', 'Chats that reach it'), el('small', '', 'A message to Jarvis from one of these goes to this agent. Optionally one Slack workspace or one chat, by its ID.'));
    routesRow.append(routesHead, routes, button('Add a chat', 'btn small', () => routes.append(routeRow({ channel: S.channels[0] || 'slack', place: '' }))));
    const error = el('p', 'agent-error');
    error.id = 'agent-error';
    error.hidden = true;
    const actions = el('div', 'row-actions');
    const save = el('button', 'btn primary', 'Save agent');
    save.type = 'submit';
    save.id = 'agent-save';
    actions.append(save, button('Cancel', 'btn', () => close()));
    form.append(
      field('agent-name', 'Name', name),
      field('agent-zh-name', 'Name in Chinese (optional)', zhName),
      field('agent-persona', 'Persona', persona),
      toolsRow, routesRow, error, actions,
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const agent = {
        name: name.value.trim(),
        zh_name: zhName.value.trim(),
        persona: persona.value,
        servers: [...tools.querySelectorAll('input:checked')].map((c) => c.value),
        routes: [...routes.querySelectorAll('.agent-route')].map((r) => ({
          channel: r.querySelector('select').value,
          place: r.querySelector('input').value.trim(),
        })),
      };
      if (S.editing && S.editing.id) agent.id = S.editing.id;
      save.disabled = true;
      S.saving = true;
      send({ type: 'agent_save', agent });
    });
    section.append(el('h3', '', 'Agents'), intro, list, add, form);
    personality.closest('section').after(section);
    return section;
  }

  function routeRow(route) {
    const row = el('div', 'agent-route');
    const pick = el('select');
    pick.setAttribute('aria-label', 'Chat app');
    for (const c of S.channels) {
      const opt = mine(el('option', '', CHANNEL_NAMES[c] || c));
      opt.value = c;
      pick.append(opt);
    }
    pick.value = route.channel;
    const place = mine(el('input'));
    place.maxLength = 80;
    place.placeholder = T('Any chat');
    place.setAttribute('aria-label', 'Workspace or chat (optional)');
    place.value = route.place || '';
    row.append(pick, place, button('Remove', 'btn small', () => row.remove()));
    return row;
  }

  function drawTools(chosen) {
    const box = $('agent-tools');
    const known = new Set(S.tools.map((t) => t.name));
    const items = [...S.tools, ...chosen.filter((n) => !known.has(n)).map((n) => ({ name: n, label: '', account: '' }))];
    box.replaceChildren(...items.map((t) => {
      const row = el('label', 'agent-tool');
      const box = el('input');
      box.type = 'checkbox';
      box.value = t.name;
      box.checked = chosen.includes(t.name);
      const words = t.account ? mine(el('span', '', t.account)) : t.label ? el('span', '', t.label) : mine(el('span', '', t.name));
      row.append(box, words);
      return row;
    }));
  }

  function edit(agent) {
    if (!build()) return;
    S.editing = agent || { id: '' };
    const a = agent || { name: '', zh_name: '', persona: 'jarvis', servers: [], routes: [] };
    $('agent-name').value = a.name;
    $('agent-zh-name').value = a.zh_name || '';
    const pick = $('agent-persona');
    pick.replaceChildren(...S.personas.map((p) => {
      const opt = mine(el('option', '', p.name));
      opt.value = p.id;
      return opt;
    }));
    pick.value = a.persona;
    drawTools(a.servers || []);
    $('agent-routes').replaceChildren(...(a.routes || []).map(routeRow));
    $('agent-error').hidden = true;
    $('agent-save').disabled = false;
    $('agent-form').hidden = false;
    $('agent-new').hidden = true;
    $('agent-name').focus({ preventScroll: true });
  }

  function close() {
    S.editing = null;
    if ($('agent-form')) $('agent-form').hidden = true;
    render();
  }

  function remove(agent, b) {
    if (S.confirm !== agent.id) {  // a second press within a few seconds deletes it
      S.confirm = agent.id;
      b.textContent = T('Delete it?');
      clearTimeout(S.confirmTimer);
      S.confirmTimer = setTimeout(() => { S.confirm = ''; render(); }, 4000);
      return;
    }
    S.confirm = '';
    clearTimeout(S.confirmTimer);
    send({ type: 'agent_delete', id: agent.id });
  }

  function row(agent) {
    const li = el('li', 'agent-item');
    li.dataset.agent = agent.id;
    const words = el('span', 'agent-words');
    if (agent.id === 'main') {
      words.append(el('strong', '', 'Jarvis'), el('small', '', 'The everyday Jarvis, with every tool'));
    } else {
      const tools = (agent.servers || []).length;
      const count = tools === 1 ? T('1 tool') : T(`${tools} tools`);
      words.append(mine(el('strong', '', agent.name)), mine(el('small', '', `${personaName(agent.persona)} · ${count}`)));
    }
    const buttons = el('span', 'agent-buttons');
    if (S.active === agent.id) buttons.append(el('span', 'agent-in-use', 'In use'));
    else buttons.append(button('Use', 'btn', () => send({ type: 'agent_use', id: agent.id })));
    if (agent.id !== 'main') {
      buttons.append(button('Edit', 'btn', () => edit(agent)));
      const del = button(S.confirm === agent.id ? 'Delete it?' : 'Delete', 'btn', () => remove(agent, del));
      buttons.append(del);
    }
    li.append(words, buttons);
    return li;
  }

  function render() {
    badge();
    if (!build()) return;
    $('agent-list').replaceChildren(row({ id: 'main' }), ...S.items.map(row));
    const add = $('agent-new');
    const full = S.items.length >= S.max;
    add.hidden = !!S.editing;
    add.disabled = full;
    add.title = full ? T('There’s no room for another agent.') : '';
  }

  F.on('agents', (ev) => {
    Object.assign(S, {
      items: ev.items || [], active: ev.active || 'main', personas: ev.personas || [],
      tools: ev.tools || [], channels: ev.channels || [], max: ev.max || 6,
    });
    const form = $('agent-form');
    const saved = S.saving;
    S.saving = false;
    if (ev.error && form && !form.hidden) {
      $('agent-error').textContent = T(ev.error);
      $('agent-error').hidden = false;
      $('agent-save').disabled = false;
      render();
      return;
    }
    if (saved && form && !form.hidden) close();
    else render();
  }, { replay: true });
  F.on('hello', () => send({ type: 'agents_state' }), { replay: true });
  F.on('personas_custom', () => send({ type: 'agents_state' }));  // a persona made or renamed
  F.on('tools_reloaded', () => send({ type: 'agents_state' }));  // an account connected
  F.on('prefs', () => badge());  // the language: the name in Chinese, when it has one
})();
