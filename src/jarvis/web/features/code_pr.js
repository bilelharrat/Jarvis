// Jarvis Code's pull requests (features/code_pr.py): the PR pane for the session in front.
// With no pull request yet, a form to open one: Claude (Haiku) writes a draft on request,
// the owner edits the title and description and picks the base, and Open pushes behind the
// Git panel's card. With one, its state, checks (a failing job's log on request), reviews
// and comments, what it's waiting for, and two switches: fix failing checks, merge when
// green (which asks first). Below, the other pull requests being watched.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send, t } = F;
  const state = {
    data: new Map(), // key -> the latest code_pr event
    forms: new Map(), // key -> the form being edited: { title, body, base, draft }
    drafts: new Map(), // key -> the latest code_pr_draft event
    writing: new Set(), // keys whose draft Claude is writing
    logs: new Map(), // `${key}\n${check}` -> the check's log (null while it loads)
    all: [], // every pull request watched (code_prs)
  };
  let body = null;

  const keyOf = (task) => (task ? `id:${task.id}` : '');
  const showing = () => body && body.isConnected && body.querySelector('.jcx-pr');
  const render = () => { if (showing()) draw(body, F.currentTask()); };

  function button(label, cls, run, title) {
    const b = el('button', `jc-btn small ${cls || ''}`.trim(), label);
    b.type = 'button';
    if (title) b.title = t(title);
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); run(b); });
    return b;
  }

  function mine(text, tag = 'span', cls = '') {
    const node = el(tag, cls, text);
    node.dataset.noI18n = '';
    return node;
  }

  function link(href, label) {
    const a = el('a', 'jcx-pr-link', label);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  function sw(label, note, on, run) {
    const row = el('div', 'jcs-row');
    const text = el('span');
    text.append(el('strong', '', label));
    if (note) text.append(el('small', '', note));
    const toggle = el('button', 'jcs-switch');
    toggle.type = 'button';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(!!on));
    toggle.setAttribute('aria-label', label);
    toggle.addEventListener('click', () => run(!on));
    row.append(text, toggle);
    return row;
  }

  // ── what a pull request is waiting for ──

  const CHECKS = { failed: 'Checks failed', pending: 'Checks running', passed: 'Checks passed', none: 'No checks yet' };
  const MERGEABLE = {
    clean: 'Ready to merge',
    has_hooks: 'Ready to merge',
    dirty: 'Conflicts with its base',
    blocked: 'Waiting for reviews or required checks',
    behind: 'Behind its base',
    unstable: 'Some checks that aren’t required are failing',
    draft: 'A draft: mark it ready on GitHub to merge',
    unknown: 'GitHub is still working out whether it can merge',
  };
  const REVIEW = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', COMMENTED: 'Commented', DISMISSED: 'Dismissed' };
  const METHODS = { squash: 'Squash', merge: 'Merge commit', rebase: 'Rebase' };

  function chip(text, cls) { return el('span', `jcx-chip ${cls || ''}`.trim(), text); }

  function stateChip(pr) {
    if (pr.state === 'merged') return chip('Merged', 'good');
    if (pr.state === 'closed') return chip('Closed without merging', 'bad');
    if (pr.draft) return chip('Draft');
    return chip('Open', 'busy');
  }

  function checkRow(key, task, check) {
    const li = el('li', `jcx-pr-check s-${check.state}`);
    const head = el('div', 'jcx-pr-check-head');
    head.append(el('span', 'jcx-pr-dot'), mine(check.name, 'span', 'jcx-pr-check-name'));
    if (check.summary) head.append(mine(check.summary, 'small', 'jcx-pr-check-sum'));
    head.append(el('span', 'jc-spacer'));
    const id = `${key}\n${check.name}`;
    if (check.state === 'failed') {
      head.append(button(state.logs.has(id) ? 'Hide log' : 'Log', '', () => {
        if (state.logs.has(id)) state.logs.delete(id);
        else { state.logs.set(id, null); send({ type: 'code_pr_log', id: task.id, check: check.name }); }
        render();
      }));
    }
    if (check.url) head.append(link(check.url, 'Details'));
    li.append(head);
    if (state.logs.has(id)) {
      const text = state.logs.get(id);
      if (text === null) li.append(el('p', 'jcx-cut', 'Loading…'));
      else li.append(mine(text || '(no log)', 'pre', 'jcx-pr-log'));
    }
    return li;
  }

  function prView(task, data) {
    const pr = data.pr;
    const key = keyOf(task);
    const wrap = el('div', 'jcx-pr-view');
    const head = el('div', 'jcx-pr-head');
    const title = el('strong', 'jcx-pr-title');
    title.append(mine(`#${pr.number} `), mine(pr.title));
    head.append(title, stateChip(pr));
    wrap.append(head);
    const where = el('p', 'jc-dim jcx-pr-where');
    where.append(mine(`${pr.repo} · ${pr.branch} → ${pr.base}`), document.createTextNode(' · '), link(pr.url, 'View on GitHub'));
    wrap.append(where);
    if (data.error) wrap.append(mine(data.error, 'p', 'jcx-pr-error'));
    if (pr.state === 'open') {
      const facts = el('div', 'jcx-pr-facts');
      facts.append(chip(CHECKS[pr.checks] || CHECKS.none, pr.checks === 'failed' ? 'bad' : pr.checks === 'passed' ? 'good' : pr.checks === 'pending' ? 'busy' : ''));
      if (MERGEABLE[pr.mergeable]) facts.append(chip(MERGEABLE[pr.mergeable], pr.mergeable === 'dirty' ? 'bad' : pr.mergeable === 'clean' ? 'good' : ''));
      if (pr.awaiting_push) facts.append(chip('Work waiting to be pushed', 'warn'));
      if (pr.followup) facts.append(chip('The session is on it', 'busy'));
      if (!pr.watch) facts.append(chip('Not watched'));
      wrap.append(facts);
      const actions = el('div', 'jcx-pr-actions');
      if (pr.checks === 'failed') actions.append(button('Fix now', 'tinted', () => send({ type: 'code_pr_fix', id: task.id }), 'Sends the failing checks’ logs to the session'));
      if (pr.mergeable === 'dirty') actions.append(button('Resolve conflicts', 'tinted', () => send({ type: 'code_pr_resolve', id: task.id }), 'Fetches the base and asks the session to merge it and resolve'));
      if (pr.awaiting_push) actions.append(button('Push', 'filled', () => send({ type: 'code_pr_push', id: task.id }), 'Asks first, as the Git panel does'));
      actions.append(el('span', 'jc-spacer'), button('Refresh', '', () => send({ type: 'code_pr_refresh', id: task.id })));
      if (!pr.draft) actions.append(button('Merge…', '', () => send({ type: 'code_pr_merge', id: task.id }), 'Asks first'));
      wrap.append(actions);
      const group = el('div', 'jcs-group');
      const left = pr.fixes_left;
      group.append(sw('Fix failing checks by itself', `Sends the failing logs to the session when it’s idle, at most 3 times (${left} left), then pushes its fix behind the push card.`, pr.autofix,
        (on) => send({ type: 'code_pr_set', id: task.id, autofix: on })));
      group.append(sw('Merge when green', 'When every check passes and GitHub says it can merge, it’s merged without asking again. Asks once, now.', pr.auto_merge,
        (on) => send({ type: 'code_pr_set', id: task.id, auto_merge: on })));
      const methods = (data.methods || []).length ? data.methods : ['squash', 'merge', 'rebase'];
      const row = el('div', 'jcs-row');
      const pick = el('select', 'jcs-select');
      pick.setAttribute('aria-label', 'How it merges');
      for (const m of methods) {
        const o = el('option', '', METHODS[m] || m);
        o.value = m;
        o.selected = m === pr.merge_method;
        pick.append(o);
      }
      pick.addEventListener('change', () => send({ type: 'code_pr_set', id: task.id, method: pick.value }));
      row.append(el('span', '', 'How it merges'), pick);
      group.append(row);
      wrap.append(group);
    }
    const checks = data.checks || [];
    wrap.append(el('p', 'jcs-label', `Checks (${checks.length})`));
    if (!checks.length) wrap.append(el('p', 'jc-dim jcx-gnone', data.polled ? 'No checks on its latest commit.' : 'Loading…'));
    else {
      const list = el('ul', 'jcx-pr-checks');
      list.append(...checks.map((c) => checkRow(key, task, c)));
      wrap.append(list);
    }
    const reviews = data.reviews || [];
    if (reviews.length) {
      wrap.append(el('p', 'jcs-label', 'Reviews'));
      const list = el('ul', 'jcx-pr-reviews');
      list.append(...reviews.map((r) => {
        const li = el('li');
        li.append(mine(r.author, 'strong'), chip(REVIEW[r.state] || r.state, r.state === 'APPROVED' ? 'good' : r.state === 'CHANGES_REQUESTED' ? 'bad' : ''));
        if (r.body) li.append(mine(r.body.slice(0, 400), 'p', 'jcx-pr-body'));
        return li;
      }));
      wrap.append(list);
    }
    const comments = data.comments || [];
    if (comments.length) {
      wrap.append(el('p', 'jcs-label', `Comments (${comments.length})`));
      const list = el('ul', 'jcx-pr-comments');
      list.append(...comments.slice(-30).map((c) => {
        const li = el('li');
        const top = el('div', 'jcx-pr-comment-head');
        top.append(mine(c.author, 'strong'));
        if (c.path) top.append(mine(c.line ? `${c.path}:${c.line}` : c.path, 'code'));
        if (!c.trusted) top.append(chip('can’t write to the repository'));
        top.append(el('span', 'jc-spacer'));
        if (!c.trusted) top.append(button('Send to session', '', () => send({ type: 'code_pr_comment', id: task.id, comment: c.id }), 'Its words go to the session as a reviewer’s, marked as data'));
        li.append(top, mine(c.body.slice(0, 600), 'p', 'jcx-pr-body'));
        return li;
      }));
      wrap.append(list);
    }
    if (pr.state === 'open' && pr.watch) {
      const foot = el('p', 'jc-dim jcx-pr-foot');
      foot.append(button('Stop watching', 'plain', () => send({ type: 'code_pr_forget', id: task.id })));
      wrap.append(foot);
    }
    return wrap;
  }

  // ── opening one ──

  function formFor(key, data) {
    if (!state.forms.has(key)) {
      const waiting = data && data.draft;
      state.forms.set(key, { title: waiting ? waiting.title : '', body: waiting ? waiting.body : '', base: waiting ? waiting.base : '', draft: false });
    }
    return state.forms.get(key);
  }

  function openView(task, data) {
    const key = keyOf(task);
    const wrap = el('div', 'jcx-pr-open');
    const made = state.drafts.get(key);
    const draft = (made && made.draft) || data.draft || null;
    const form = formFor(key, data);
    const where = data.where || {};
    wrap.append(el('p', 'jc-dim', 'Open a pull request from this session’s branch. Claude writes a draft if you like; you edit it. Pushing asks first, as the Git panel does.'));
    if (data.draft && data.draft.waiting) wrap.append(el('p', 'jcx-pr-waiting', 'Drafted from the issue’s session: it waits for your OK.'));
    if (where.branch) {
      const line = el('p', 'jcx-pr-where');
      line.append(mine(`${where.repo || ''} · ${where.branch}${form.base ? ` → ${form.base}` : ''}`));
      wrap.append(line);
    }
    const writing = state.writing.has(key);
    const bar = el('div', 'jcx-pr-actions');
    bar.append(button(writing ? 'Writing…' : draft ? 'Write it again' : 'Write a draft', '', (b) => {
      b.disabled = true;
      state.writing.add(key);
      send({ type: 'code_pr_draft', id: task.id, base: form.base || '' });
      render();
    }, 'Claude (Haiku) drafts the title and description from the branch’s diff and the session’s summary'));
    bar.lastChild.disabled = writing;
    wrap.append(bar);
    const note = made && made.note;
    if (note) wrap.append(mine(note, 'p', 'jcx-pr-note'));
    const box = el('form', 'jcx-pr-form');
    const title = el('input', 'jc-field');
    title.placeholder = t('Title');
    title.value = form.title;
    title.maxLength = 256;
    title.dataset.noI18n = '';
    title.addEventListener('input', () => { form.title = title.value; submit.disabled = !title.value.trim(); });
    const text = el('textarea', 'jc-field');
    text.rows = 8;
    text.placeholder = t('Description (Markdown)');
    text.value = form.body;
    text.dataset.noI18n = '';
    text.addEventListener('input', () => { form.body = text.value; });
    const row = el('div', 'jcx-pr-row');
    const bases = (draft && draft.bases) || (form.base ? [form.base] : []);
    const pick = el('select', 'jcs-select');
    pick.setAttribute('aria-label', 'Base branch');
    pick.dataset.noI18n = '';
    for (const name of bases.length ? bases : ['main']) {
      const o = el('option', '', name);
      o.value = name;
      o.selected = name === (form.base || bases[0]);
      pick.append(o);
    }
    if (!form.base && bases.length) form.base = bases[0];
    pick.addEventListener('change', () => { form.base = pick.value; });
    const into = el('label', 'jcx-pr-base');
    into.append(el('span', '', 'Into'), pick);
    const asDraft = el('label', 'jcx-pr-check-box');
    const box2 = el('input');
    box2.type = 'checkbox';
    box2.checked = !!form.draft;
    box2.addEventListener('change', () => { form.draft = box2.checked; });
    asDraft.append(box2, el('span', '', 'Open as a draft'));
    row.append(into, asDraft);
    const submit = el('button', 'jc-btn small filled', 'Open pull request');
    submit.type = 'submit';
    submit.disabled = !form.title.trim();
    box.append(title, text, row);
    if (draft) {
      const facts = [];
      if (draft.commits && draft.commits.length) facts.push(`${draft.commits.length} commit${draft.commits.length === 1 ? '' : 's'}`);
      if (draft.uncommitted) facts.push(`${draft.uncommitted} uncommitted file${draft.uncommitted === 1 ? ' is' : 's are'} committed first`);
      if (draft.left_out) facts.push(`${draft.left_out} uncommitted change${draft.left_out === 1 ? ' isn’t' : 's aren’t'} in it: commit in the Git panel first`);
      if (facts.length) {
        const p = el('p', 'jc-dim jcx-pr-facts-line');
        facts.forEach((f, k) => { if (k) p.append(document.createTextNode(' · ')); p.append(el('span', '', f)); });
        box.append(p);
      }
    }
    const actions = el('div', 'jcx-pr-actions');
    if (data.draft && data.draft.waiting) actions.append(button('Not now', '', () => { send({ type: 'code_pr_draft_drop', id: task.id }); state.forms.delete(key); }));
    actions.append(el('span', 'jc-spacer'), submit);
    box.append(actions);
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!form.title.trim()) return;
      send({ type: 'code_pr_open', id: task.id, title: form.title.trim(), body: form.body, base: form.base || pick.value, draft: !!form.draft });
    });
    wrap.append(box);
    return wrap;
  }

  function others(task) {
    const rest = state.all.filter((p) => p.state === 'open' && !(task && p.task_id === task.id));
    if (!rest.length) return null;
    const wrap = el('div', 'jcx-pr-others');
    wrap.append(el('p', 'jcs-label', 'Other pull requests'));
    const list = el('ul', 'jc-list');
    list.append(...rest.slice(0, 20).map((p) => {
      const li = el('li');
      li.append(mine(`${p.repo}#${p.number}`, 'code'), mine(p.title), chip(CHECKS[p.checks] || CHECKS.none, p.checks === 'failed' ? 'bad' : p.checks === 'passed' ? 'good' : ''));
      if (p.task_id) li.append(button('Show', '', () => F.selectTask(p.task_id)));
      return li;
    }));
    wrap.append(list);
    return wrap;
  }

  function draw(target, task) {
    body = target;
    const wrap = el('div', 'jcx-pr');
    const data = task ? state.data.get(keyOf(task)) : null;
    if (!task) wrap.append(el('p', 'jc-empty', 'Open a session to work with its pull request.'));
    else if (!data) wrap.append(el('p', 'jc-empty', 'Loading…'));
    else if (!data.where || !data.where.git) wrap.append(el('p', 'jc-empty', 'This folder isn’t a git repository.'));
    else if (!data.github) {
      const card = el('div', 'jcx-pr-connect');
      card.append(el('p', '', 'Connect GitHub in Tools & Accounts to open and watch pull requests.'),
        button('Open Tools & Accounts', 'filled', () => { if (typeof toggleAccounts === 'function') toggleAccounts(true); }));
      wrap.append(card);
    } else if (data.pr) wrap.append(prView(task, data));
    else wrap.append(openView(task, data));
    const rest = others(task);
    if (rest) wrap.append(rest);
    target.replaceChildren(wrap);
  }

  F.registerPane('pr', {
    title: 'Pull request',
    render(target, task) {
      draw(target, task);
      if (task) send({ type: 'code_pr', id: task.id });
      send({ type: 'code_prs' });
    },
  });
  F.registerMoreItem({ label: 'Pull request', run: () => F.openPane('pr') });

  // A button of its own in the toolbar, beside Git.
  (function toolbarButton() {
    const capsule = document.querySelector('.jc-capsule');
    if (!capsule) return;
    const b = el('button', 'jc-tool');
    b.type = 'button';
    b.dataset.pane = 'pr';
    b.title = t('Pull request');
    b.setAttribute('aria-label', 'Pull request');
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="5.5" cy="4.5" r="1.8"/><circle cx="5.5" cy="15.5" r="1.8"/><circle cx="14.5" cy="15.5" r="1.8"/><path d="M5.5 6.3v7.4M14.5 13.7V8.5c0-1.7-1.2-2.8-3-2.8H9"/><path d="M10.8 3.8L9 5.7l1.8 1.9"/></svg>';
    b.addEventListener('click', () => {
      const open = !document.getElementById('jc-pane').hidden && b.getAttribute('aria-pressed') === 'true';
      if (open) document.getElementById('jc-pane-close').click(); else F.openPane('pr');
    });
    const gitButton = capsule.querySelector('.jc-tool[data-pane="git"]') || capsule.querySelector('.jc-tool[data-pane="diff"]');
    capsule.insertBefore(b, gitButton ? gitButton.nextSibling : capsule.firstChild);
  })();

  // ── events ──

  F.on('code_pr', (ev) => {
    state.data.set(ev.key, ev);
    if (ev.pr) state.writing.delete(ev.key);
    if (keyOf(F.currentTask()) === ev.key) render();
  });
  F.on('code_pr_draft', (ev) => {
    state.writing.delete(ev.key);
    state.drafts.set(ev.key, ev);
    if (ev.draft) {
      const form = formFor(ev.key, null);
      form.title = ev.draft.title || form.title;
      form.body = ev.draft.body || form.body;
      form.base = ev.draft.base || form.base;
    }
    if (keyOf(F.currentTask()) === ev.key) render();
  });
  F.on('code_pr_log', (ev) => {
    const id = `${ev.key}\n${ev.check}`;
    if (state.logs.has(id)) state.logs.set(id, ev.text || '');
    if (keyOf(F.currentTask()) === ev.key) render();
  });
  F.on('code_prs', (ev) => { state.all = ev.items || []; render(); });
  F.on('task_finished', (ev) => {
    const task = F.currentTask();
    if (task && ev.id === task.id && showing()) send({ type: 'code_pr', id: task.id });
  });

  window.JarvisPullRequests = { state };
})();
