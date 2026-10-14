// Eden Code settings › Linear and Slack (features/code_triggers.py): the keys and signing
// secrets (pasted into password fields and sent once to the Keychain; never shown again,
// only whether each is set), the tunnel's command (to the hooks' own listener on
// 127.0.0.1 and a port that stays put, code_triggers_port; never the window's own server)
// and whether that port is free, the hook's address to give each service (the tunnel's
// address, the hook's path and its token), the people and channels allowed, and the scope. Turning a service on sends the
// scope to the backend, which puts it on a card first. With nothing set yet, the steps to
// make the Linear webhook and the Slack app.
//
// Ids, names and addresses are data: text only (textContent), marked data-no-i18n. Pure
// helpers are exported for node --test (tests/web/code-triggers.test.mjs).
(function (root) {
  'use strict';

  const STEPS = {
    linear: [
      'In Linear, make a user for Eden (or use your own), and in its Settings › Security & access › Personal API keys, make a key. Paste it below.',
      'Run the tunnel command above in Terminal and leave it running, so Linear can reach this Mac. It prints the tunnel’s address.',
      'In Linear’s Settings › API › Webhooks, add one for Issues to the hook’s address below, with the tunnel’s address in place of <tunnel address>. Paste its signing secret below.',
      'Assign a ticket to Eden’s user, or give it the label, and Eden starts on it.',
    ],
    slack: [
      'At api.slack.com/apps, create an app. Give its bot the scopes app_mentions:read, chat:write and commands, install it, and paste its Bot User OAuth Token (xoxb-…) below.',
      'From the app’s Basic Information, paste its Signing Secret below.',
      'Run the tunnel command above in Terminal and leave it running, so Slack can reach this Mac. It prints the tunnel’s address.',
      'Under Event Subscriptions, set the Request URL to the hook’s address below, with the tunnel’s address in place of <tunnel address>, and subscribe to app_mention. Add the slash command /eden with the same URL.',
      'Invite the app to the channels it may work in, and list them below by their channel ID (in the channel’s details).',
    ],
  };

  // "a, b c\nd" -> ['a', 'b', 'c', 'd'] (ids, emails, commands' lists).
  function listOf(text, sep = /[\s,]+/) {
    return String(text || '').split(sep).map((s) => s.trim()).filter(Boolean).slice(0, 50);
  }

  // "C0123ABCD app, C0999 web" -> [{ id, project }], each id upper-cased.
  function channelsOf(text) {
    return String(text || '').split(/[,\n]+/).map((part) => part.trim().split(/\s+/)).filter((p) => p.length >= 2 && p[0])
      .map(([id, ...rest]) => ({ id: id.replace(/^#/, '').toUpperCase(), project: rest.join(' ') })).slice(0, 20);
  }

  const PORT = 8766; // code_triggers_port unless the owner picks another
  const ROUTES = { linear: 'eden-linear', slack: 'eden-slack' };
  const TUNNEL = 'https://<tunnel address>';

  // An origin and the hook's path, as one address.
  function hookAddress(origin, path) {
    if (!path) return '';
    return `${String(origin || '').replace(/\/+$/, '')}${path}`;
  }

  // What to paste into Linear or Slack: the tunnel's address (a placeholder: cloudflared
  // prints the real one), the hook's path, and its token (a placeholder until there is one).
  function hookShape(service, path) {
    return hookAddress(TUNNEL, path || `/hooks/${ROUTES[service]}?token=<token>`);
  }

  // The tunnel to run: to the hooks' own listener, never the window's server.
  function tunnelCommand(port) {
    const n = Number(port);
    return `cloudflared tunnel --url http://127.0.0.1:${Number.isInteger(n) && n > 0 ? n : PORT}`;
  }

  // Why the tunnel's port can't be saved ('' when it can): said beside it, never a Save that
  // does nothing.
  function portProblem(text) {
    const n = Number(String(text || '').trim());
    if (String(text || '').trim() && Number.isInteger(n) && n >= 1024 && n <= 65535) return '';
    return 'The port is a whole number from 1024 to 65535.';
  }

  const api = { STEPS, listOf, channelsOf, hookAddress, hookShape, tunnelCommand, portProblem };
  if (typeof module === 'object' && module.exports) module.exports = api;

  const F = root.jarvisFeatures;
  if (!F || typeof document === 'undefined') return;
  const { el, send, t } = F;
  // Drawn anew with the keyboard kept in its place (code-focus.js): after Stop, Merge and
  // the like the focus would otherwise fall to the page.
  const keepFocus = (box, drawIt) => (root.jarvisFocus ? root.jarvisFocus.keep(box, drawIt) : drawIt());
  const state = {
    linear: null,
    slack: null,
    listener: null,
    forms: {
      linear: { project: '', label: 'eden', users: '', commands: '', spend: '5', sandbox: true },
      slack: { channels: '', users: '', commands: '', spend: '5', sandbox: true },
    },
  };
  const NAMES = { linear: 'Linear', slack: 'Slack' };
  const SECRETS = {
    linear: [['api_key', 'API key'], ['secret', 'Webhook signing secret']],
    slack: [['bot_token', 'Bot token'], ['secret', 'Signing secret']],
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
    toggle.setAttribute('aria-label', label);
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

  function secretRow(service, key, label, has) {
    const r = el('div', 'jcs-row jcx-trg-secret');
    const text = el('span');
    text.append(document.createTextNode(t(label)));
    text.append(el('small', '', has ? 'Set: kept in the Keychain.' : 'Not set.'));
    let value = '';
    const box = input('', label, (v) => { value = v; }, { type: 'password', placeholder: has ? '••••••••' : '' });
    const save = button('Save', '', () => { if (value.trim()) send({ type: 'code_trigger_secret', service, key, value }); box.value = ''; value = ''; }, `${t('Save')} ${t(label)}`);
    const tools = el('span', 'jcx-trg-tools');
    tools.append(box, save);
    if (has) tools.append(button('Remove', 'danger', () => send({ type: 'code_trigger_secret', service, key, value: '' }), `${t('Remove')} ${t(label)}`));
    r.append(text, tools);
    return r;
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

  function scopeForm(service) {
    const f = state.forms[service];
    const box = el('form', 'jcx-trg-form');
    if (service === 'linear') {
      box.append(
        row('Project', 'Where its tickets are worked on.', projectPick(f)),
        row('Label', 'A ticket with this label starts a session too.', input(f.label, 'Label', (v) => { f.label = v; })),
        row('Who may start one', 'Linear user ids or emails, separated by commas.', input(f.users, 'Who may start one', (v) => { f.users = v; })),
      );
    } else {
      box.append(
        row('Channels', 'Each channel’s ID and its project: C0123ABCD app, C0456EFGH web', input(f.channels, 'Channels', (v) => { f.channels = v; })),
        row('Who may start one', 'Slack member IDs (U…), separated by commas.', input(f.users, 'Who may start one', (v) => { f.users = v; })),
      );
    }
    box.append(
      row('Commands it may run', 'Beyond the read-only ones and the project’s own rules.', input(f.commands, 'Commands it may run', (v) => { f.commands = v; }, { placeholder: 'npm test, uv run pytest' })),
      row('Spending cap ($)', 'For each session; it also stops after an hour.', input(f.spend, 'Spending cap ($)', (v) => { f.spend = v; }, { type: 'number' })),
      row('Commands without network access', 'Its commands run in a sandbox. Turn it off if its tests need the network.', sw('Commands without network access', f.sandbox, (on) => { f.sandbox = on; draw(); })),
    );
    const actions = el('div', 'jcx-trg-actions');
    const go = el('button', 'jc-btn small filled', 'Turn it on…');
    go.type = 'submit';
    actions.append(el('span', 'jc-spacer'), go);
    box.append(actions);
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      const msg = {
        type: 'code_trigger_set', service,
        users: listOf(f.users, /[\s,]+/),
        commands: listOf(f.commands, /,/),
        spend_cap: Number(f.spend) || 5,
        sandbox: !!f.sandbox,
      };
      if (service === 'linear') Object.assign(msg, { project: f.project, label: (f.label || 'eden').trim() });
      else msg.channels = channelsOf(f.channels);
      send(msg);
    });
    return box;
  }

  function serviceBlock(service) {
    const data = state[service] || { config: {}, has: {}, hook: '' };
    const has = data.has || {};
    const on = data.config && Object.keys(data.config).length > 0;
    const box = el('section', 'jcx-trg-service');
    box.setAttribute('aria-label', NAMES[service]);
    const head = el('div', 'jcx-trg-head');
    head.append(mine(NAMES[service], 'strong'), el('span', `jcx-chip ${on ? 'good' : ''}`.trim(), on ? 'On' : 'Off'));
    if (on) head.append(el('span', 'jc-spacer'), button('Turn off', 'danger', () => send({ type: 'code_trigger_off', service }), `${t('Turn off')} ${NAMES[service]}`));
    box.append(head);
    const ready = SECRETS[service].every(([key]) => has[key]);
    if (!ready || !on) {
      const steps = el('ol', 'jcx-trg-steps');
      steps.append(...STEPS[service].map((s) => el('li', '', s)));
      box.append(steps);
    }
    for (const [key, label] of SECRETS[service]) box.append(secretRow(service, key, label, !!has[key]));
    const where = el('div', 'jcs-row jcx-trg-hook');
    const text = el('span');
    text.append(document.createTextNode(t('The hook’s address')));
    text.append(el('small', '', 'Paste this, with the address the tunnel printed in place of <tunnel address>.'));
    where.append(text);
    const tools = el('span', 'jcx-trg-tools');
    tools.append(mine(hookShape(service, data.hook), 'code'));
    tools.append(button(data.hook ? 'New token' : 'Make one', '', () => send({ type: 'code_trigger_hook', service }), `${t('New token')}: ${NAMES[service]}`));
    where.append(tools);
    box.append(where);
    if (on) {
      const c = data.config;
      const summary = service === 'linear'
        ? `${c.project} · “${c.label}” · ${(c.users || []).length}`
        : `${(c.channels || []).map((x) => `${x.id} → ${x.project}`).join(', ')} · ${(c.users || []).length}`;
      box.append(mine(summary, 'p', 'jc-dim jcx-trg-summary'));
    } else {
      box.append(scopeForm(service));
    }
    return box;
  }

  // The tunnel's command, the port it names (the owner may pick another), and whether
  // the listener has that port: a taken one is said here, never swapped for another.
  function tunnelBlock() {
    const lis = state.listener || { port: PORT, on: false, error: '' };
    const box = el('section', 'jcx-trg-service jcx-trg-tunnel');
    box.setAttribute('aria-label', t('The tunnel'));
    const cmd = el('div', 'jcs-row');
    const text = el('span');
    text.append(document.createTextNode(t('The tunnel')));
    text.append(el('small', '', 'Linear and Slack reach this Mac only through it, and only these two hooks: a listener of their own on a port that stays the same, never the window’s pages.'));
    const tools = el('span', 'jcx-trg-tools');
    tools.append(mine(tunnelCommand(lis.port), 'code'));
    cmd.append(text, tools);
    box.append(cmd);
    let port = String(lis.port || PORT);
    const portBox = input(port, 'Port', (v) => { port = v; }, { type: 'number' });
    const portWhy = el('small', 'jcx-trg-error');
    portWhy.setAttribute('role', 'status');
    const save = button('Save', '', () => {
      const problem = portProblem(port);
      portWhy.textContent = problem ? t(problem) : '';
      if (!problem) send({ type: 'feature_prefs', changes: { code_triggers_port: Number(port) } });
    }, `${t('Save')} ${t('Port')}`);
    const portTools = el('span', 'jcx-trg-tools');
    portTools.append(portBox, save, portWhy);
    box.append(row('Port', 'On 127.0.0.1 only. It listens while Linear or Slack is on.', portTools));
    if (lis.error) {
      const warn = mine(lis.error, 'p', 'jcx-trg-error');
      warn.setAttribute('role', 'alert');
      box.append(warn);
    } else if (lis.on) {
      box.append(el('p', 'jc-dim jcx-trg-summary', 'Listening.'));
    }
    return box;
  }

  function draw() {
    if (!group) return;
    keepFocus(group, () => group.replaceChildren(
      row('Tickets and messages for Eden', 'A Linear ticket given to Eden, or @Eden or /eden in an allowed Slack channel, starts a session without you, from the people you list only. Its text is only data, and its pull request waits for your OK.'),
      tunnelBlock(),
      serviceBlock('linear'),
      serviceBlock('slack'),
    ));
  }

  (function addSettings() {
    const general = document.getElementById('jcs-general');
    if (!general) return;
    const label = el('p', 'jcs-label', 'Linear and Slack');
    group = el('div', 'jcs-group jcx-trg');
    const foot = general.querySelector('.jcs-foot');
    general.insertBefore(label, foot);
    general.insertBefore(group, foot);
    draw();
  })();

  F.on('hello', () => send({ type: 'code_triggers' }), { replay: true });
  F.on('code_triggers', (ev) => {
    state.linear = ev.linear || null;
    state.slack = ev.slack || null;
    state.listener = ev.listener || null;
    draw();
  });
  F.on('claude_projects', () => draw());
  root.JarvisTriggers = { state };
})(typeof window === 'object' ? window : globalThis);
