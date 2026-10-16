// Eden Code beyond GitHub (features/code_hosts.py): Settings › Git hosts and Jira (each
// host's token, pasted into a password field and sent once to the Keychain, never shown
// again: only whether it's set, and whether the host's CLI is there to lend one; the owner's
// own GitLab servers; Jira's site, email, search, projects and status names), and the
// "Issues to pick up" pane: the open issues of the session's GitLab project and the Jira
// search's, each with Pick up (a session on it, its text as data).
//
// Hosts, keys, titles and names are data: text only (textContent), marked data-no-i18n.
// helpers is exported for node --test (tests/web/code-hosts.test.mjs).
(function (root) {
  'use strict';

  const NAMES = { gitlab: 'GitLab', bitbucket: 'Bitbucket', azure: 'Azure DevOps', jira: 'Jira' };

  const helpers = {
    // "a, b c\nd" -> ['a', 'b', 'c', 'd'] (hosts, project keys, status names).
    listOf(text, sep = /[\s,]+/) {
      return String(text || '').split(sep).map((s) => s.trim()).filter(Boolean).slice(0, 20);
    },
    // What the owner pastes for each host, said beside its field.
    tokenHint(kind) {
      return {
        gitlab: 'A personal access token with the api scope.',
        bitbucket: 'Your username and an app password as username:app-password, or an access token.',
        azure: 'A personal access token with Code (read and write) and Build (read).',
        jira: 'An API token from id.atlassian.com (on Jira Data Center, a personal access token).',
      }[kind] || '';
    },
    // Whether a token is set, or the CLI may lend one ('' for neither).
    tokenState(row) {
      if (row && row.has) return 'Set: kept in the Keychain.';
      if (row && row.cli) return row.kind === 'azure' ? 'Not set: the Azure CLI’s sign-in is used.' : 'Not set: glab’s sign-in is used.';
      return 'Not set.';
    },
    // An issue's line: its key and title (data), then its status and who has it.
    issueLine(item) {
      return [item.key, item.title].filter(Boolean).join(' ');
    },
    // The project a session's issues come from: its folder when it's a project, else the first.
    projectFor(task, names) {
      const list = names || [];
      if (task && list.includes(task.folder)) return task.folder;
      return list[0] || '';
    },
  };

  if (typeof module === 'object' && module.exports) { module.exports = helpers; return; }

  const F = root.jarvisFeatures;
  if (!F || typeof document === 'undefined') return;
  const { el, send, t } = F;
  const keepFocus = (box, drawIt) => (root.jarvisFocus ? root.jarvisFocus.keep(box, drawIt) : drawIt());
  /* global deckProjects */
  const projectNames = () => (typeof deckProjects !== 'undefined' && Array.isArray(deckProjects) ? deckProjects.map((p) => p.name) : []);
  const state = { hosts: [], gitlab_hosts: [], jira: { config: {}, has: false }, issues: null, project: '', body: null, task: null, loading: false };
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

  function input(value, label, opts = {}) {
    const box = el('input', 'jcs-input');
    box.value = value || '';
    if (opts.type) box.type = opts.type;
    if (opts.placeholder) box.placeholder = opts.placeholder;
    box.setAttribute('aria-label', t(label));
    box.dataset.noI18n = '';
    box.autocomplete = 'off';
    return box;
  }

  function row(title, note, control, own) {
    const r = el('div', 'jcs-row');
    const text = el('span');
    text.append(own ? mine(title) : document.createTextNode(t(title)));
    if (note) text.append(el('small', '', note));
    r.append(text);
    if (control) r.append(control);
    return r;
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

  // One host's token: a password field, Save, and Remove once it's set.
  function tokenRow(item) {
    const name = NAMES[item.kind];
    const label = item.kind === 'gitlab' && item.host !== 'gitlab.com' ? `${name} · ${item.host}` : name;
    const box = input('', `${name} token`, { type: 'password', placeholder: item.has ? '••••••••' : '' });
    const tools = el('span', 'jcx-hosts-tools');
    const msg = { type: 'code_host_secret', kind: item.kind, host: item.host };
    tools.append(box, button('Save', '', () => { if (box.value.trim()) send({ ...msg, value: box.value }); box.value = ''; }, `${t('Save')} ${label}`));
    if (item.has) tools.append(button('Remove', 'danger', () => send({ ...msg, value: '' }), `${t('Remove')} ${label}`));
    const r = row(label, '', tools, true);
    const note = r.querySelector('span');
    note.append(el('small', '', helpers.tokenState(item)), el('small', 'jc-dim', helpers.tokenHint(item.kind)));
    return r;
  }

  function gitlabRow() {
    const box = input(state.gitlab_hosts.join(', '), 'Your own GitLab servers', { placeholder: 'gitlab.example.com' });
    const tools = el('span', 'jcx-hosts-tools');
    tools.append(box, button('Save', '', () => send({ type: 'code_host_gitlab', hosts: helpers.listOf(box.value) })));
    return row('Your own GitLab servers', 'Their remotes count as GitLab; each gets a token of its own below.', tools);
  }

  function jiraBlock() {
    const c = state.jira.config || {};
    const form = el('form', 'jcx-hosts-jira');
    const f = {
      site: input(c.site, 'Jira site', { placeholder: 'acme.atlassian.net' }),
      email: input(c.email, 'Email', { placeholder: 'you@example.com' }),
      jql: input(c.jql, 'Search (JQL)'),
      projects: input((c.projects || []).join(', '), 'Projects', { placeholder: 'SHOP, OPS' }),
      start: input((c.start || []).join(', '), 'When a session starts'),
      review: input((c.review || []).join(', '), 'When its pull request opens'),
    };
    const flags = { move: c.move !== false, link: c.link !== false };
    form.append(
      row('Jira site', 'Its address.', f.site),
      row('Email', 'The Atlassian account the token is for (leave it empty on Data Center).', f.email),
      row('Search (JQL)', 'The issues the pane lists to pick up.', f.jql),
      row('Projects', 'A branch or title names an issue of these only (any, when empty).', f.projects),
      row('When a session starts', 'The status a picked-up issue moves to.', f.start),
      row('When its pull request opens', 'The status it moves to, with a link to the pull request.', f.review),
      row('Move issues along', '', sw('Move issues along', flags.move, (on) => { flags.move = on; send(jiraMsg()); })),
      row('Link pull requests', 'A link and a comment on the issue.', sw('Link pull requests', flags.link, (on) => { flags.link = on; send(jiraMsg()); })),
    );
    function jiraMsg() {
      return {
        type: 'code_jira_set', site: f.site.value, email: f.email.value, jql: f.jql.value,
        projects: helpers.listOf(f.projects.value), start: helpers.listOf(f.start.value, /,/), review: helpers.listOf(f.review.value, /,/),
        move: flags.move, link: flags.link,
      };
    }
    const actions = el('div', 'jcx-hosts-actions');
    const save = el('button', 'jc-btn small filled', 'Save');
    save.type = 'submit';
    actions.append(el('span', 'jc-spacer'), save);
    form.append(actions);
    form.addEventListener('submit', (e) => { e.preventDefault(); send(jiraMsg()); });
    return form;
  }

  function drawSettings() {
    if (!group) return;
    const tokens = el('section', 'jcx-hosts-service');
    tokens.setAttribute('aria-label', t('Git hosts'));
    tokens.append(row('Git hosts', 'The pull request pane works on GitLab, Bitbucket and Azure DevOps too: whichever host the project’s remote is on.'));
    tokens.append(...state.hosts.map(tokenRow), gitlabRow());
    const jira = el('section', 'jcx-hosts-service');
    jira.setAttribute('aria-label', 'Jira');
    jira.append(tokenRow({ kind: 'jira', host: '', has: state.jira.has }), jiraBlock());
    keepFocus(group, () => group.replaceChildren(tokens, jira));
  }

  (function addSettings() {
    const general = document.getElementById('jcs-general');
    if (!general) return;
    const label = el('p', 'jcs-label', 'Git hosts and Jira');
    group = el('div', 'jcs-group jcx-hosts');
    const foot = general.querySelector('.jcs-foot');
    general.insertBefore(label, foot);
    general.insertBefore(group, foot);
    drawSettings();
  })();

  // ── the pane ──

  function ask() {
    if (!state.project) return;
    state.loading = true;
    send({ type: 'code_host_issues', project: state.project });
  }

  function drawPane() {
    const body = state.body;
    if (!body) return;
    const wrap = el('div', 'jcx-hosts-pane');
    const names = projectNames();
    if (!state.project) state.project = helpers.projectFor(state.task, names);
    const pick = el('select', 'jcs-select');
    pick.setAttribute('aria-label', t('Project'));
    pick.dataset.noI18n = '';
    for (const name of names) {
      const o = el('option', '', name);
      o.value = name;
      o.selected = name === state.project;
      pick.append(o);
    }
    pick.addEventListener('change', () => { state.project = pick.value; state.issues = null; ask(); drawPane(); });
    const head = el('div', 'jcx-hosts-head');
    head.append(pick, button('Refresh', '', () => ask()));
    wrap.append(head, el('p', 'jc-dim', 'Its GitLab project’s open issues, and your Jira search. Picking one up starts a session on it; its text goes as data, and the session asks before it acts, as yours do.'));
    const data = state.issues && state.issues.project === state.project ? state.issues : null;
    if (!data) wrap.append(el('p', 'jc-empty', state.loading ? 'Loading…' : 'No issues yet.'));
    else {
      if (data.note) wrap.append(mine(data.note, 'p', 'jcx-hosts-error'));
      if (!data.items.length) wrap.append(el('p', 'jc-empty', 'No open issues found.'));
      const list = el('ul', 'jc-list jcx-hosts-issues');
      for (const item of data.items) {
        const li = el('li');
        const text = el('span', 'jcx-hosts-issue');
        const a = mine(helpers.issueLine(item), 'a');
        a.href = item.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        text.append(mine(NAMES[item.source] || item.source, 'span', 'jcx-chip'), a);
        if (item.status) text.append(mine(item.status, 'small', 'jc-dim'));
        li.append(text, button('Pick up', 'tinted', () => send({ type: 'code_host_pickup', project: state.project, source: item.source, key: item.key }), `${t('Pick up')} ${item.key}`));
        list.append(li);
      }
      wrap.append(list);
    }
    keepFocus(body, () => body.replaceChildren(wrap));
  }

  F.registerPane('host-issues', {
    title: 'Issues to pick up',
    render(body, task) { state.body = body; state.task = task || null; drawPane(); ask(); },
  });
  F.registerMoreItem({ label: 'Issues to pick up', run: () => F.openPane('host-issues') });
  F.on('hello', () => send({ type: 'code_hosts' }), { replay: true });
  F.on('code_hosts', (ev) => {
    state.hosts = ev.hosts || [];
    state.gitlab_hosts = ev.gitlab_hosts || [];
    state.jira = ev.jira || { config: {}, has: false };
    drawSettings();
  });
  F.on('code_host_issues', (ev) => { state.loading = false; state.issues = { project: ev.project, items: ev.items || [], note: ev.note || '' }; drawPane(); });
  root.JarvisHosts = { state };
})(typeof window === 'object' ? window : globalThis);
