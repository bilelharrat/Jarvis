// Eden Code settings › Production alerts (features/code_alerts.py): Sentry and Datadog
// alerts for the projects the owner links start a fix (reproduced with a failing test
// first) that waits for their OK as a pull request. Here: the tokens and secrets (pasted
// into password fields and sent once to the Keychain; never shown again, only whether each
// is set), the hook's address to give each service (through the same tunnel as Linear and
// Slack, to the hooks' own listener on its fixed port; never the window's own server), the
// links (a Sentry project's slug, or a Datadog service tag, to a project), the scope and
// the day's ceiling, and the fixes lately with how many alerts each took. Turning a service
// on sends the scope to the backend, which puts it on a card first. With nothing set yet,
// the steps to make the Sentry integration and the Datadog webhook.
//
// Slugs, names, addresses and alert names are data: text only (textContent), marked
// data-no-i18n. Pure helpers are exported for node --test (tests/web/code-alerts.test.mjs).
(function (root) {
  'use strict';

  const STEPS = {
    sentry: [
      'In Sentry, Settings › Developer Settings › Custom Integrations, make an internal integration. Give it Issue & Event: Read & Write, turn on its Webhooks with the issue resource, and paste its token below.',
      'Paste the integration’s Client Secret below: it signs each webhook.',
      'Run the tunnel command in Terminal and leave it running, so Sentry can reach this Mac.',
      'Set the integration’s Webhook URL to the hook’s address below, with the tunnel’s address in place of <tunnel address>. For issue alerts, add the integration as an alert rule’s action too.',
      'Link each Sentry project (its slug) to one of your projects, and turn it on.',
    ],
    datadog: [
      'In Datadog, Organization Settings, make an API key and an application key, and paste both below.',
      'Make up a long secret (openssl rand -hex 24 in Terminal makes one) and paste it below.',
      'Run the tunnel command in Terminal and leave it running, so Datadog can reach this Mac.',
      'In Integrations › Webhooks, add one with the hook’s address below (the tunnel’s address in place of <tunnel address>), the payload below, and the custom header below with your secret.',
      'Mention the webhook (@webhook-eden) in the monitors that should start a fix, and link each service tag to one of your projects.',
    ],
  };

  const SITES = ['datadoghq.com', 'us3.datadoghq.com', 'us5.datadoghq.com', 'datadoghq.eu', 'ap1.datadoghq.com', 'ddog-gov.com'];
  const ROUTES = { sentry: 'eden-sentry', datadog: 'eden-datadog' };
  const PORT = 8766;
  const TUNNEL = 'https://<tunnel address>';
  // What Datadog's webhook sends: the fields code_alerts.py reads, in Datadog's variables.
  const PAYLOAD = '{"id": "$ID", "alert_id": "$ALERT_ID", "title": "$EVENT_TITLE", "text": "$EVENT_MSG", "transition": "$ALERT_TRANSITION", "tags": "$TAGS", "date": "$DATE", "link": "$LINK", "aggreg_key": "$AGGREG_KEY"}';
  const HEADER = '{"X-Eden-Secret": "<your secret>"}';

  // "backend app, web-frontend my web" -> [{ name, project }], each name lower-cased.
  function linksOf(text) {
    return String(text || '').split(/[,\n]+/).map((part) => part.trim().split(/\s+/)).filter((p) => p.length >= 2 && p[0])
      .map(([name, ...rest]) => ({ name: name.replace(/^service:/i, '').toLowerCase(), project: rest.join(' ') })).slice(0, 20);
  }

  function listOf(text, sep = /,/) {
    return String(text || '').split(sep).map((s) => s.trim()).filter(Boolean).slice(0, 20);
  }

  function hookShape(service, path) {
    return `${TUNNEL}${path || `/hooks/${ROUTES[service]}?token=<token>`}`;
  }

  function tunnelCommand(port) {
    const n = Number(port);
    return `cloudflared tunnel --url http://127.0.0.1:${Number.isInteger(n) && n > 0 ? n : PORT}`;
  }

  const api = { STEPS, SITES, PAYLOAD, HEADER, linksOf, listOf, hookShape, tunnelCommand };
  if (typeof module === 'object' && module.exports) module.exports = api;

  const F = root.jarvisFeatures;
  if (!F || typeof document === 'undefined') return;
  const { el, send, t } = F;
  const keepFocus = (box, drawIt) => (root.jarvisFocus ? root.jarvisFocus.keep(box, drawIt) : drawIt());
  const NAMES = { sentry: 'Sentry', datadog: 'Datadog' };
  const SECRETS = {
    sentry: [['token', 'Auth token'], ['secret', 'Client secret']],
    datadog: [['api_key', 'API key'], ['app_key', 'Application key'], ['secret', 'Webhook secret']],
  };
  const STATES = { running: 'Being fixed', waiting: 'Waiting for your OK', done: 'Done' };
  const state = {
    sentry: null,
    datadog: null,
    listener: null,
    today: null,
    recent: [],
    forms: {
      sentry: { org: '', base: '', links: '', commands: '', spend: '5', day: '15', sandbox: true },
      datadog: { site: SITES[0], links: '', commands: '', spend: '5', day: '15', sandbox: true },
    },
  };
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
    const r = el('div', 'jcs-row jcx-alr-secret');
    const text = el('span');
    text.append(document.createTextNode(t(label)));
    text.append(el('small', '', has ? 'Set: kept in the Keychain.' : 'Not set.'));
    let value = '';
    const box = input('', label, (v) => { value = v; }, { type: 'password', placeholder: has ? '••••••••' : '' });
    const save = button('Save', '', () => { if (value.trim()) send({ type: 'code_alert_secret', service, key, value }); box.value = ''; value = ''; }, `${t('Save')} ${t(label)}`);
    const tools = el('span', 'jcx-alr-tools');
    tools.append(box, save);
    if (has) tools.append(button('Remove', 'danger', () => send({ type: 'code_alert_secret', service, key, value: '' }), `${t('Remove')} ${t(label)}`));
    r.append(text, tools);
    return r;
  }

  function codeRow(title, note, text) {
    const r = row(title, note);
    const tools = el('span', 'jcx-alr-tools');
    tools.append(mine(text, 'code'));
    r.append(tools);
    return r;
  }

  function scopeForm(service) {
    const f = state.forms[service];
    const box = el('form', 'jcx-alr-form');
    if (service === 'sentry') {
      box.append(
        row('Organization', 'Your Sentry organization’s slug.', input(f.org, 'Organization', (v) => { f.org = v; })),
        row('Sentry address', 'Leave it empty for sentry.io; your own server’s https address otherwise.', input(f.base, 'Sentry address', (v) => { f.base = v; }, { placeholder: 'https://sentry.io' })),
        row('Linked projects', 'Each Sentry project’s slug and your project: backend app, web-frontend web', input(f.links, 'Linked projects', (v) => { f.links = v; })),
      );
    } else {
      const pick = el('select', 'jcs-select');
      pick.setAttribute('aria-label', t('Datadog site'));
      pick.dataset.noI18n = '';
      for (const site of SITES) {
        const o = el('option', '', site);
        o.value = site;
        o.selected = site === f.site;
        pick.append(o);
      }
      pick.addEventListener('change', () => { f.site = pick.value; });
      box.append(
        row('Datadog site', 'Where your Datadog account is: its keys are sent only there.', pick),
        row('Linked services', 'Each service tag and your project: checkout app, web my web', input(f.links, 'Linked services', (v) => { f.links = v; })),
      );
    }
    box.append(
      row('Commands it may run', 'Beyond the read-only ones and the project’s own rules.', input(f.commands, 'Commands it may run', (v) => { f.commands = v; }, { placeholder: 'npm test, uv run pytest' })),
      row('Spending cap ($)', 'For each fix; it also stops after an hour.', input(f.spend, 'Spending cap ($)', (v) => { f.spend = v; }, { type: 'number' })),
      row('Spending a day ($)', 'For every alert fix together, Sentry’s and Datadog’s.', input(f.day, 'Spending a day ($)', (v) => { f.day = v; }, { type: 'number' })),
      row('Commands without network access', 'Its commands run in a sandbox. Turn it off if its tests need the network.', sw('Commands without network access', f.sandbox, (on) => { f.sandbox = on; draw(); })),
    );
    const actions = el('div', 'jcx-alr-actions');
    const go = el('button', 'jc-btn small filled', 'Turn it on…');
    go.type = 'submit';
    actions.append(el('span', 'jc-spacer'), go);
    box.append(actions);
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      const msg = {
        type: 'code_alert_set', service,
        links: linksOf(f.links),
        commands: listOf(f.commands),
        spend_cap: Number(f.spend) || 5,
        day_spend: Number(f.day) || 15,
        sandbox: !!f.sandbox,
      };
      if (service === 'sentry') Object.assign(msg, { org: f.org.trim().toLowerCase(), base: f.base.trim() });
      else msg.site = f.site;
      send(msg);
    });
    return box;
  }

  function serviceBlock(service) {
    const data = state[service] || { config: {}, has: {}, hook: '' };
    const has = data.has || {};
    const on = data.config && Object.keys(data.config).length > 0;
    const box = el('section', 'jcx-alr-service');
    box.setAttribute('aria-label', NAMES[service]);
    const head = el('div', 'jcx-alr-head');
    head.append(mine(NAMES[service], 'strong'), el('span', `jcx-chip ${on ? 'good' : ''}`.trim(), on ? 'On' : 'Off'));
    if (on) head.append(el('span', 'jc-spacer'), button('Turn off', 'danger', () => send({ type: 'code_alert_off', service }), `${t('Turn off')} ${NAMES[service]}`));
    box.append(head);
    const ready = SECRETS[service].every(([key]) => has[key]);
    if (!ready || !on) {
      const steps = el('ol', 'jcx-alr-steps');
      steps.append(...STEPS[service].map((s) => el('li', '', s)));
      box.append(steps);
    }
    for (const [key, label] of SECRETS[service]) box.append(secretRow(service, key, label, !!has[key]));
    const where = el('div', 'jcs-row jcx-alr-hook');
    const text = el('span');
    text.append(document.createTextNode(t('The hook’s address')));
    text.append(el('small', '', 'Paste this, with the address the tunnel printed in place of <tunnel address>.'));
    const tools = el('span', 'jcx-alr-tools');
    tools.append(mine(hookShape(service, data.hook), 'code'));
    tools.append(button(data.hook ? 'New token' : 'Make one', '', () => send({ type: 'code_alert_hook', service }), `${t('New token')}: ${NAMES[service]}`));
    where.append(text, tools);
    box.append(where);
    if (service === 'datadog') {
      box.append(codeRow('The webhook’s payload', 'Paste it as the webhook’s payload, as it is.', PAYLOAD));
      box.append(codeRow('The custom header', 'With your secret in place of <your secret>.', HEADER));
    }
    if (on) {
      const c = data.config;
      const links = (c.links || []).map((x) => `${x.name} → ${x.project}`).join(', ');
      box.append(mine(`${service === 'sentry' ? c.org : c.site} · ${links} · $${Number(c.spend_cap).toFixed(2)} · $${Number(c.day_spend).toFixed(2)}`, 'p', 'jc-dim jcx-alr-summary'));
    } else {
      box.append(scopeForm(service));
    }
    return box;
  }

  function recentBlock() {
    const items = (state.recent || []).slice().reverse();
    const box = el('section', 'jcx-alr-service jcx-alr-recent');
    box.setAttribute('aria-label', t('Fixes lately'));
    const today = state.today || { spent: 0, runs: {} };
    box.append(row('Fixes lately', `Today: $${Number(today.spent || 0).toFixed(2)} spent.`));
    if (!items.length) {
      box.append(el('p', 'jc-dim jcx-alr-summary', 'No alert has started a fix yet.'));
      return box;
    }
    const list = el('ul', 'jcx-alr-list');
    for (const item of items) {
      const li = el('li');
      li.append(mine(`${NAMES[item.service] || ''} ${item.what || ''}`.trim(), 'strong'));
      li.append(el('span', `jcx-chip ${item.state === 'waiting' ? 'warn' : item.state === 'running' ? 'busy' : ''}`.trim(), STATES[item.state] || STATES.done));
      if (item.count > 1) li.append(mine(`×${item.count}`, 'span', 'jc-dim'));
      list.append(li);
    }
    box.append(list);
    return box;
  }

  function draw() {
    if (!group) return;
    const lis = state.listener || { port: PORT, on: false, error: '' };
    const tunnel = codeRow('The tunnel', 'The same one as Linear and Slack: only the hooks’ own listener, never the window’s pages.', tunnelCommand(lis.port));
    const parts = [
      row('Alerts that start a fix', 'A new issue, a regression or a monitor that fires for a project you link starts a fix without you: it reproduces the problem with a failing test first, then fixes it. The alert’s text is only data, the same problem again isn’t started twice, and its pull request waits for your OK.'),
      tunnel,
    ];
    if (lis.error) {
      const warn = mine(lis.error, 'p', 'jcx-alr-error');
      warn.setAttribute('role', 'alert');
      parts.push(warn);
    }
    parts.push(serviceBlock('sentry'), serviceBlock('datadog'), recentBlock());
    keepFocus(group, () => group.replaceChildren(...parts));
  }

  (function addSettings() {
    const general = document.getElementById('jcs-general');
    if (!general) return;
    const label = el('p', 'jcs-label', 'Production alerts');
    group = el('div', 'jcs-group jcx-alr');
    const foot = general.querySelector('.jcs-foot');
    general.insertBefore(label, foot);
    general.insertBefore(group, foot);
    draw();
  })();

  F.on('hello', () => send({ type: 'code_alerts' }), { replay: true });
  F.on('code_alerts', (ev) => {
    state.sentry = ev.sentry || null;
    state.datadog = ev.datadog || null;
    state.listener = ev.listener || null;
    state.today = ev.today || null;
    state.recent = ev.recent || [];
    draw();
  });
  F.on('code_triggers', (ev) => { if (ev.listener) { state.listener = ev.listener; draw(); } });
  F.on('claude_projects', () => draw()); // (drawn again once the words and projects are in)
  root.JarvisAlerts = { state };
})(typeof window === 'object' ? window : globalThis);
