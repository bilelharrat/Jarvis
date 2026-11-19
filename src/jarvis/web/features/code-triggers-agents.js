// Eden Code settings › Eden's agents in Linear (features/code_linear_agents.py), under
// Linear and Slack (code-triggers.js): the named agents ("Eden · Opus", "Eden · Exterminator"),
// each with its model, how it works and its label, whether they may ask questions in Linear
// (the backend asks on a card first), and for each saved agent its Linear app's access token
// and webhook signing secret (password fields, sent once to the Keychain; only whether each
// is set comes back). The steps for both ways an agent is someone in Linear: its own app
// (Linear's agent API: assignable and mentionable) or the bot user and a label.
//
// Names, labels and model names are the owner's words: text only, data-no-i18n. Pure helpers
// are exported for node --test (tests/web/code-triggers-agents.test.mjs).
(function (root) {
  'use strict';

  const STEPS = {
    app: [
      'In Linear’s Settings › API › OAuth applications, create an application for the agent (named as it is here) and turn on webhooks for Agent session events, pointed at the hook’s address in Linear and Slack above.',
      'Install it in your workspace with actor=app and the scopes app:assignable and app:mentionable, then paste its access token and its webhook signing secret below.',
      'Assign a ticket to the agent, or mention it, and it starts; it speaks in the ticket’s agent session.',
    ],
    label: [
      'No app? Make a label in Linear with the agent’s label (below), and give it to a ticket: the agent starts, speaking in comments that begin with its name, as the Linear user whose key is above.',
    ],
  };

  const KINDS = [['code', 'Works on the ticket'], ['exterminator', 'Exterminator: a failing test first, then the fix']];

  // A new agent of a kind, on the strongest model the picker has for it.
  function preset(kind, models) {
    const list = models || [];
    const opus = list.find((m) => /opus/i.test(`${m.ref} ${m.label}`) && !m.needs_key);
    if (kind === 'exterminator') return { id: '', name: 'Eden · Exterminator', label: 'Eden · Exterminator', kind, model: opus ? opus.ref : '' };
    return { id: '', name: opus ? `Eden · ${String(opus.label || 'Opus').replace(/\s*\d.*$/, '') || 'Opus'}` : 'Eden', label: '', kind: 'code', model: opus ? opus.ref : '' };
  }

  // The form's rows from the saved settings (a copy: editing never changes what's shown
  // as saved until it's sent).
  function draftsFrom(config) {
    return ((config && config.agents) || []).map((a) => ({ id: a.id, name: a.name, label: a.label === a.name ? '' : a.label, kind: a.kind, model: a.model }));
  }

  // What Save sends: names trimmed, empty rows left out, a label only when it differs.
  function message(drafts, questions) {
    const agents = (drafts || []).map((d) => ({ id: d.id || '', name: String(d.name || '').trim(), label: String(d.label || '').trim(), kind: d.kind || 'code', model: d.model || '' }))
      .filter((d) => d.name).map((d) => (d.label ? d : { ...d, label: d.name }));
    return { type: 'code_linear_agents_set', agents, questions: !!questions };
  }

  const api = { STEPS, KINDS, preset, draftsFrom, message };
  if (typeof module === 'object' && module.exports) module.exports = api;

  const F = root.jarvisFeatures;
  if (!F || typeof document === 'undefined') return;
  const { el, send, t } = F;
  const keepFocus = (box, drawIt) => (root.jarvisFocus ? root.jarvisFocus.keep(box, drawIt) : drawIt());
  const models = () => (typeof modelList !== 'undefined' ? modelList : []);
  const state = { config: { agents: [], questions: false }, has: {}, on: false, drafts: null, questions: false, saved: '' };
  let group = null;

  function mine(node) { node.dataset.noI18n = ''; return node; }

  function button(label, cls, run, aria) {
    const b = el('button', `jc-btn small ${cls || ''}`.trim(), label);
    b.type = 'button';
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', (e) => { e.preventDefault(); run(); });
    return b;
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
    const box = mine(el('input', 'jcs-input'));
    box.value = value || '';
    if (opts.type) box.type = opts.type;
    if (opts.placeholder) box.placeholder = opts.placeholder;
    box.setAttribute('aria-label', label);
    box.autocomplete = 'off';
    box.addEventListener('input', () => run(box.value));
    return box;
  }

  function select(options, value, label, run) {
    const pick = el('select', 'jcs-select');
    pick.setAttribute('aria-label', label);
    for (const [v, text, own] of options) {
      const o = el('option', '', text);
      if (own) mine(o);
      o.value = v;
      o.selected = v === value;
      pick.append(o);
    }
    pick.addEventListener('change', () => run(pick.value));
    return pick;
  }

  function agentRow(d, n) {
    const box = el('div', 'jcx-agent');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', `${t('Agent')} ${n + 1}`);
    const named = d.name || `${t('Agent')} ${n + 1}`;
    const modelChoices = [['', t('The project’s model'), false], ...models().filter((m) => m.ref).map((m) => [m.ref, m.label || m.ref, true])];
    const tools = el('span', 'jcx-trg-tools');
    tools.append(
      input(d.name, `${t('Name')}: ${named}`, (v) => { d.name = v; }, { placeholder: 'Eden · Opus' }),
      input(d.label, `${t('Label')}: ${named}`, (v) => { d.label = v; }, { placeholder: t('Its name') }),
      select(KINDS.map(([v, text]) => [v, t(text)]), d.kind, `${t('How it works')}: ${named}`, (v) => { d.kind = v; }),
      select(modelChoices, d.model, `${t('Model')}: ${named}`, (v) => { d.model = v; }),
      button('Remove', 'danger', () => { state.drafts.splice(n, 1); draw(); }, `${t('Remove')}: ${named}`),
    );
    box.append(tools);
    return box;
  }

  function secretRow(agent, key, label, has) {
    const r = el('div', 'jcs-row jcx-trg-secret');
    const text = el('span');
    text.append(mine(el('span', '', `${agent.name} · `)), document.createTextNode(t(label)));
    text.append(el('small', '', has ? 'Set: kept in the Keychain.' : 'Not set.'));
    let value = '';
    const box = input('', `${t(label)}: ${agent.name}`, (v) => { value = v; }, { type: 'password', placeholder: has ? '••••••••' : '' });
    const tools = el('span', 'jcx-trg-tools');
    tools.append(box, button('Save', '', () => { if (value.trim()) send({ type: 'code_linear_agent_secret', agent: agent.id, key, value }); box.value = ''; value = ''; }, `${t('Save')} ${t(label)}: ${agent.name}`));
    if (has) tools.append(button('Remove', 'danger', () => send({ type: 'code_linear_agent_secret', agent: agent.id, key, value: '' }), `${t('Remove')} ${t(label)}: ${agent.name}`));
    r.append(text, tools);
    return r;
  }

  function draw() {
    if (!group) return;
    if (!state.drafts) { state.drafts = draftsFrom(state.config); state.questions = !!state.config.questions; }
    const parts = [row('Eden’s agents in Linear', 'Named agents people in Linear can give tickets to, each on its own model. They run exactly as Linear tickets do above: locked down, capped, only for the people listed there.')];
    if (!state.on) parts.push(el('p', 'jc-dim jcx-trg-summary', 'Turn Linear on above first.'));
    const steps = el('ol', 'jcx-trg-steps');
    steps.append(...[...STEPS.app, ...STEPS.label].map((s) => el('li', '', s)));
    parts.push(steps);
    const list = el('div', 'jcx-agents');
    state.drafts.forEach((d, n) => list.append(agentRow(d, n)));
    parts.push(list);
    const adds = el('div', 'jcx-trg-actions');
    adds.append(
      button('Add Eden · Opus', '', () => { state.drafts.push(preset('code', models())); draw(); }),
      button('Add Eden · Exterminator', '', () => { state.drafts.push(preset('exterminator', models())); draw(); }),
    );
    parts.push(adds);
    const sw = el('button', 'jcs-switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(state.questions));
    sw.setAttribute('aria-label', t('They may ask questions in Linear'));
    sw.addEventListener('click', () => { state.questions = !state.questions; draw(); });
    parts.push(row('They may ask questions in Linear', 'One short question at a time, links and markup taken out; answers from your list come back as data. You’re asked first.', sw));
    const save = el('div', 'jcx-trg-actions');
    save.append(el('span', 'jc-spacer'), button('Save agents', 'filled', () => send(message(state.drafts, state.questions))));
    parts.push(save);
    for (const agent of state.config.agents || []) {
      const has = state.has[agent.id] || {};
      parts.push(secretRow(agent, 'token', 'App access token', !!has.token), secretRow(agent, 'secret', 'App webhook signing secret', !!has.secret));
    }
    keepFocus(group, () => group.replaceChildren(...parts));
  }

  (function addSettings() {
    const general = document.getElementById('jcs-general');
    if (!general) return;
    const label = el('p', 'jcs-label', 'Eden’s agents in Linear');
    group = el('div', 'jcs-group jcx-trg jcx-agents-group');
    const foot = general.querySelector('.jcs-foot');
    general.insertBefore(label, foot);
    general.insertBefore(group, foot);
    draw();
  })();

  F.on('hello', () => send({ type: 'code_linear_agents' }), { replay: true });
  F.on('code_linear_agents', (ev) => {
    state.config = ev.config || { agents: [], questions: false };
    state.has = ev.has || {};
    state.on = ev.linear_on === true;
    const saved = JSON.stringify(state.config);
    if (saved !== state.saved) { state.saved = saved; state.drafts = null; }  // (saved: the form shows what's kept; an edit under way stays otherwise)
    draw();
  });
  F.on('code_triggers', () => send({ type: 'code_linear_agents' }));  // (Linear turned on or off)
})(typeof window === 'object' ? window : globalThis);
