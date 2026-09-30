// Jarvis Code's Git panel (features/code_git.py): the branch (switch, make one, push, which
// asks first), what's staged and what isn't (a file or one hunk at a time), the commit
// message (written by Claude on request, always editable) and Commit, and the last 50
// commits. It works on the session's folder (its isolated copy, when it has one) or, with
// no session open, the project's.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send, t } = F;
  const diff = () => window.JarvisDiff;  // (code_diff.js loads after this file)
  const state = {
    data: new Map(), // key -> the latest code_git event
    files: new Map(), // `${key}:${staged}:${path}` -> that file's hunks
    open: new Set(), // `${key}:${staged}:${path}` of files shown with their hunks
    drafts: new Map(), // key -> the commit message being written
    notes: new Map(), // key -> a note under the message (why it wasn't written)
    writing: new Set(), // keys whose message Claude is writing
    newBranch: false,
  };
  let body = null;

  const project = () => (typeof deckProject === 'string' ? deckProject : '');
  const keyOf = (task) => (task ? `id:${task.id}` : `dir:${project()}`);
  const where = (task) => (task ? { id: task.id } : { directory: project() });
  const showing = () => body && body.isConnected && body.querySelector('.jcx-git');

  function button(label, cls, run, title) {
    const b = el('button', cls, label);
    b.type = 'button';
    if (title) b.title = t(title);
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); run(b); });
    return b;
  }

  function when(seconds) {
    const ago = Math.max(0, Date.now() / 1000 - seconds);
    if (ago < 90) return 'just now';
    if (ago < 3600) return `${Math.round(ago / 60)} min ago`;
    if (ago < 86400) return `${Math.round(ago / 3600)} h ago`;
    const days = Math.round(ago / 86400);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }

  // ── pieces ──

  function fileRow(task, data, file, staged) {
    const key = keyOf(task);
    const id = `${key}:${staged}:${file.path}`;
    const li = el('li', 'jcx-gfile');
    const head = el('div', 'jcx-gfile-head');
    const code = el('span', `jcx-gcode c-${file.code === '?' ? 'u' : file.code.toLowerCase()}`, file.code === '?' ? 'U' : file.code);
    const name = el('span', 'jcx-gpath', file.path);
    name.dataset.noI18n = '';
    head.append(code, name, button(staged ? 'Unstage' : 'Stage', 'jc-mini', () => send({ type: 'code_git_stage', ...where(task), paths: [file.path], unstage: staged })));
    head.addEventListener('click', () => {
      if (state.open.has(id)) state.open.delete(id);
      else { state.open.add(id); send({ type: 'code_git_file', ...where(task), path: file.path, staged }); }
      render();
    });
    li.append(head);
    if (state.open.has(id)) {
      const found = state.files.get(id);
      if (!found) li.append(el('p', 'jcx-cut', 'Loading…'));
      else if (found.sensitive) li.append(el('p', 'jcx-cut', 'Credentials: changed, but its lines aren’t shown.'));
      else if (found.binary || !(found.hunks || []).length) li.append(el('p', 'jcx-cut', 'Nothing to show line by line.'));
      else {
        for (const hunk of found.hunks) {
          const box = el('div', 'jcx-hunk');
          const bar = el('div', 'jcx-hunk-head');
          bar.append(el('span', 'jcx-where', `line ${hunk.line}${hunk.where ? ` · ${hunk.where}` : ''}`), el('span', 'jc-spacer'),
            button(staged ? 'Unstage this' : 'Stage this', 'jc-mini', () => send({ type: 'code_git_hunk', ...where(task), path: file.path, hunk: hunk.id, staged })));
          box.append(bar);
          if (diff()) {
            const scroll = el('div', 'jcx-scroll');
            scroll.append(diff().buildHunk(document, hunk, { path: file.path, limit: 400 }).el);
            box.append(scroll);
          }
          li.append(box);
        }
      }
    }
    return li;
  }

  function section(task, data, title, files, staged) {
    const wrap = el('div', 'jcx-gsection');
    wrap.dataset.list = staged ? 'staged' : 'unstaged';
    const head = el('div', 'jcx-ghead');
    head.append(el('span', 'jcs-label', `${title} (${files.length})`));
    if (files.length) head.append(button(staged ? 'Unstage all' : 'Stage all', 'jc-mini', () => send({ type: 'code_git_stage', ...where(task), all: true, unstage: staged })));
    wrap.append(head);
    if (!files.length) wrap.append(el('p', 'jc-dim jcx-gnone', staged ? 'Nothing staged.' : 'No other changes.'));
    else {
      const list = el('ul', 'jcx-glist');
      list.append(...files.slice(0, 300).map((f) => fileRow(task, data, f, staged)));
      wrap.append(list);
      if (files.length > 300) wrap.append(el('p', 'jcx-cut', `Showing 300 of ${files.length} files.`));
    }
    return wrap;
  }

  function branchRow(task, data) {
    const row = el('div', 'jcx-gbranch');
    if (data.detached) row.append(el('span', 'jcx-chip warn', 'Detached HEAD'));
    else {
      const pick = el('select', 'jcs-select');
      pick.setAttribute('aria-label', 'Branch');
      for (const name of data.branches.length ? data.branches : [data.branch]) {
        const o = el('option', '', name);
        o.value = name;
        o.selected = name === data.branch;
        pick.append(o);
      }
      pick.dataset.noI18n = '';
      pick.addEventListener('change', () => send({ type: 'code_git_branch', ...where(task), name: pick.value }));
      row.append(pick);
    }
    if (data.upstream) {
      const sync = el('span', 'jc-dim jcx-gsync');
      sync.append(el('span', '', `↑${data.ahead} ↓${data.behind}`));
      sync.title = `Tracking ${data.upstream}`;
      row.append(sync);
    }
    row.append(el('span', 'jc-spacer'),
      button('New branch…', 'jc-mini', () => { state.newBranch = !state.newBranch; render(); }),
      button('Push', 'jc-btn small', () => send({ type: 'code_git_push', ...where(task) }), 'Asks first: where it goes, which commits, and anything that looks like a secret'));
    const box = el('div');
    box.append(row);
    if (state.newBranch) {
      const make = el('form', 'jcx-gnew');
      const name = el('input', 'jc-field');
      name.placeholder = t('New branch name');
      name.dataset.noI18n = '';
      make.append(name, button('Make it', 'jc-btn small filled', () => make.requestSubmit()));
      make.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!name.value.trim()) return;
        send({ type: 'code_git_branch', ...where(task), name: name.value.trim(), create: true });
        state.newBranch = false;
        render();
      });
      box.append(make);
      setTimeout(() => name.focus());
    }
    return box;
  }

  function commitBox(task, data) {
    const key = keyOf(task);
    const box = el('div', 'jcx-gcommit');
    const text = el('textarea', 'jc-field');
    text.rows = 3;
    text.placeholder = t('Commit message');
    text.dataset.noI18n = '';
    text.value = state.drafts.get(key) || '';
    text.addEventListener('input', () => state.drafts.set(key, text.value));
    const actions = el('div', 'jcx-gcommit-actions');
    const writing = state.writing.has(key);
    const write = button(writing ? 'Writing…' : 'Write it', 'jc-btn small', () => {
      state.writing.add(key);
      state.notes.delete(key);
      send({ type: 'code_git_message', ...where(task) });
      render();
    }, 'Claude (Haiku) writes a message from what’s staged; you can edit it');
    write.disabled = writing || !data.staged.length;
    const commit = button(data.merging ? 'Commit the merge' : 'Commit', 'jc-btn small filled', () => {
      send({ type: 'code_git_commit', ...where(task), message: text.value });
    }, 'Checks what’s staged for keys and tokens first');
    commit.disabled = !data.staged.length && !data.merging;
    actions.append(write, el('span', 'jc-spacer'), commit);
    box.append(text, actions);
    const note = state.notes.get(key);
    if (note) box.append(el('p', 'jc-dim', note));
    return box;
  }

  function history(data) {
    const wrap = el('div', 'jcx-gsection');
    wrap.append(el('span', 'jcs-label', 'History'));
    if (!data.log.length) { wrap.append(el('p', 'jc-dim jcx-gnone', 'No commits yet.')); return wrap; }
    const list = el('ul', 'jcx-glog');
    list.append(...data.log.map((c) => {
      const li = el('li');
      const sha = el('code', '', c.sha);
      const subject = el('span', 'jcx-gsubject', c.subject);
      subject.dataset.noI18n = '';
      const by = el('small', '');
      const who = el('span', '', c.author);
      who.dataset.noI18n = '';
      by.append(who, document.createTextNode(' · '), el('span', '', when(c.at)));
      li.append(sha, subject, by);
      return li;
    }));
    wrap.append(list);
    return wrap;
  }

  // ── the pane ──

  function render() {
    if (showing()) draw(body, F.currentTask());
  }

  function draw(target, task) {
    body = target;
    const wrap = el('div', 'jcx-git');
    if (!task && !project()) {
      wrap.append(el('p', 'jc-empty', 'Pick a project first.'));
      target.replaceChildren(wrap);
      return;
    }
    const data = state.data.get(keyOf(task));
    if (!data) wrap.append(el('p', 'jc-empty', 'Loading…'));
    else if (!data.repo) wrap.append(el('p', 'jc-empty', 'This folder isn’t a git repository.'));
    else {
      if (task && task.workspace && task.workspace.branch) {
        wrap.append(el('p', 'jc-dim', 'This session’s isolated copy: its branch, not the main folder’s.'));
      }
      wrap.append(branchRow(task, data));
      if (data.merging) wrap.append(el('p', 'jcx-gmerge', 'A merge is under way: resolve its conflicts, stage them, then commit to finish it.'));
      wrap.append(section(task, data, 'Staged', data.staged, true), commitBox(task, data), section(task, data, 'Changes', data.unstaged, false), history(data));
    }
    target.replaceChildren(wrap);
  }

  F.registerPane('git', {
    title: 'Git',
    render(target, task) {
      draw(target, task);
      send({ type: 'code_git', ...where(task) });
    },
  });
  F.registerMoreItem({ label: 'Git', run: () => F.openPane('git') });

  // A button of its own in the toolbar, beside Changes.
  (function toolbarButton() {
    const capsule = document.querySelector('.jc-capsule');
    if (!capsule) return;
    const b = el('button', 'jc-tool');
    b.type = 'button';
    b.dataset.pane = 'git';
    b.title = t('Git');
    b.setAttribute('aria-label', 'Git');
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="15" r="2"/><circle cx="14" cy="8" r="2"/><path d="M6 7v6M14 10c0 2.5-3 3-6.6 3.8"/></svg>';
    b.addEventListener('click', () => {
      const open = !document.getElementById('jc-pane').hidden && b.getAttribute('aria-pressed') === 'true';
      if (open) document.getElementById('jc-pane-close').click(); else F.openPane('git');
    });
    const diffButton = capsule.querySelector('.jc-tool[data-pane="diff"]');
    capsule.insertBefore(b, diffButton ? diffButton.nextSibling : capsule.firstChild);
  })();

  // ── events ──

  F.on('code_git', (ev) => {
    state.data.set(ev.key, ev);
    // Files that are no longer where they were shown are closed.
    for (const id of [...state.open]) {
      if (!id.startsWith(`${ev.key}:`)) continue;
      const [, , staged, ...rest] = id.split(':');
      const path = rest.join(':');
      const list = staged === 'true' ? ev.staged : ev.unstaged;
      if (!(list || []).some((f) => f.path === path)) state.open.delete(id);
      else send({ type: 'code_git_file', ...(ev.key.startsWith('id:') ? { id: Number(ev.key.slice(3)) } : { directory: ev.key.slice(4) }), path, staged: staged === 'true' });
    }
    if (keyOf(F.currentTask()) === ev.key) render();
  });
  F.on('code_git_file', (ev) => {
    state.files.set(`${ev.key}:${ev.staged}:${ev.path}`, ev.file || { hunks: [] });
    if (keyOf(F.currentTask()) === ev.key) render();
  });
  F.on('code_git_message', (ev) => {
    state.writing.delete(ev.key);
    if (ev.text) state.drafts.set(ev.key, ev.text);
    if (ev.note) state.notes.set(ev.key, ev.note); else state.notes.delete(ev.key);
    if (keyOf(F.currentTask()) === ev.key) render();
  });
  F.on('code_git_committed', (ev) => {
    state.drafts.delete(ev.key);
    state.notes.delete(ev.key);
    if (keyOf(F.currentTask()) === ev.key) render();
  });
  F.on('task_finished', (ev) => {
    const task = F.currentTask();
    if (task && ev.id === task.id && showing()) send({ type: 'code_git', ...where(task) });
  });
})();
