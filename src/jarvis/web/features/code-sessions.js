// Jarvis Code sessions (features/code_sessions.py): drafts and attachments kept per session,
// the sidebar's pins, archive, groups and badges, edit and resend, /btw side questions, the
// /goal banner, snippets in the / palette, Open folder… and Settings › Projects and Snippets.
// It decorates app.js's sidebar and transcript rows (never re-renders them), so it sits
// beside whatever else draws them. Its pure logic is exported for node's tests.
(function codeSessions(root) {
  'use strict';

  // ── pure logic (tests/web/code-sessions.test.mjs) ──

  // Whether a sidebar row shows under the filter ('all' | 'archived' | 'g:<group>'); the open
  // session always does, so the selection never vanishes from under the user.
  function rowShown(meta, filter, selected) {
    if (selected) return true;
    const archived = !!(meta && meta.archived);
    if (filter === 'archived') return archived;
    if (archived) return false;
    if (filter && filter.startsWith('g:')) return !!meta && meta.group === filter.slice(2);
    return true;
  }

  // The goal typed after /goal: a command word, or the goal itself.
  function goalAction(arg, hasGoal) {
    const word = String(arg || '').trim();
    const lower = word.toLowerCase();
    if (!word) return { action: '' };
    if (['clear', 'off', 'remove', 'stop'].includes(lower)) return { action: 'clear' };
    if (lower === 'pause') return { action: 'pause' };
    if (['resume', 'go', 'continue'].includes(lower)) return { action: 'resume' };
    if (['done', 'complete', 'met'].includes(lower)) return { action: 'complete' };
    return { action: hasGoal ? 'edit' : 'set', text: word };
  }

  // Snippets as / commands: [{ name, help, insert }], each named once, never over a built-in.
  function snippetCommands(snippets, taken) {
    const seen = new Set(taken || []);
    const out = [];
    for (const s of Array.isArray(snippets) ? snippets : []) {
      if (!s || typeof s.name !== 'string' || typeof s.text !== 'string' || seen.has(s.name)) continue;
      seen.add(s.name);
      const line = s.text.replace(/\s+/g, ' ').trim();
      out.push({ name: s.name, help: `Snippet · ${line.length > 60 ? `${line.slice(0, 60)}…` : line}`, insert: s.text });
    }
    return out;
  }

  // Where a project's defaults override the global ones, for the composer with no session.
  const DEFAULT_FIELDS = [['code_mode', 'mode'], ['code_model', 'model'], ['code_effort', 'effort'], ['code_ultracode', 'ultracode']];
  function effectiveDefaults(global, own) {
    const out = { ...global };
    for (const [, field] of DEFAULT_FIELDS) if (own && own[field] !== undefined) out[field] = own[field];
    return out;
  }
  // A new-session setting changed in the composer while a project with its own value for it
  // was showing: that project's value follows (so the next session there starts as shown).
  function movedDefaults(before, after, own) {
    const moved = {};
    if (!before || !own) return moved;
    for (const [key, field] of DEFAULT_FIELDS) {
      if (after[key] !== before[key] && own[field] !== undefined) moved[field] = after[key];
    }
    return moved;
  }

  const api = { rowShown, goalAction, snippetCommands, effectiveDefaults, movedDefaults };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  const F = root.jarvisFeatures;
  if (!F) return;

  // ── state ──

  const S = {
    meta: new Map(),  // task id -> { key, pinned, archived, group, goal, resting, history, updated }
    drafts: new Map(),  // task id -> what was typed and not sent
    kept: new Map(),  // task id -> the draft the hub has (sent only when it differs)
    held: new Map(),  // task id -> attachments not sent yet (in memory only)
    unread: new Set(),  // task ids with a reply or an ending not seen yet
    filter: 'all',
    groups: [],
    projects: { main: '', roots: [], folders: [], hidden: [] },
    btw: [],  // side answers: { id, ref, question, state, text }
    defaultsBefore: null,  // the new-session settings at the last prefs event
    project: null,  // the project the composer's defaults were drawn for
  };
  F.codeSessions = S;  // the board (code-board.js) reads it
  const t = (text) => F.t(text);
  const taskOf = (id) => ccTasks.find((x) => x.id === id) || null;
  const metaOf = (id) => S.meta.get(id) || {};
  const needsYou = (id) => [...pendingApprovals.values()].filter((a) => a.task_id === id);
  S.needsYou = needsYou;

  F.on('code_meta', (ev) => {
    const items = ev.items || {};
    if (ev.full) S.meta.clear();
    for (const [id, item] of Object.entries(items)) {
      S.meta.set(Number(id), item);
      if (ev.full) S.kept.set(Number(id), item.draft || '');
      if (ev.full && item.draft && !S.drafts.has(Number(id))) S.drafts.set(Number(id), item.draft);
    }
    const now = currentTask();
    const input = $('deck-input');
    if (ev.full && now && !input.value && S.drafts.get(now.id)) setComposer(S.drafts.get(now.id));
    if (ev.full && now && metaOf(now.id).history === false) F.send({ type: 'code_session_open', id: now.id });
    if (ev.projects) S.projects = ev.projects;
    refresh();
  });
  F.on('code_projects', (ev) => { S.projects = { ...S.projects, ...ev }; if (settingsOpen('projects')) renderProjectsTab(); });
  F.on('code_note', (ev) => jcNote(ev.text || ''));
  F.on('tasks', () => { forgetGone(); refresh(); });
  F.on('approval', () => refresh());
  F.on('approval_resolved', () => refresh());
  F.on('task_log', (ev) => {
    const role = ev.entry && ev.entry.role;
    if (['assistant', 'plan'].includes(role) && !seeing(ev.id)) { S.unread.add(ev.id); refresh(); }
  });
  F.on('task_finished', (ev) => { if (ev.task_kind === 'code' && !seeing(ev.id)) { S.unread.add(ev.id); refresh(); } });
  F.on('claude_projects', () => { if (settingsOpen('projects')) renderProjectsTab(); });
  F.on('code_project_added', (ev) => { openProjects.add(ev.name); selectProject(ev.name); toggleCC(true); });

  function seeing(id) { return id === ccSelected && !$('cc').hidden && !document.hidden && !boardOpen(); }
  document.addEventListener('visibilitychange', () => refresh());
  function boardOpen() { return $('cc').classList.contains('cs-board-on'); }
  function forgetGone() {
    const live = new Set(ccTasks.map((x) => x.id));
    for (const map of [S.drafts, S.held, S.kept]) for (const id of [...map.keys()]) if (!live.has(id)) map.delete(id);
    for (const id of [...S.unread]) if (!live.has(id)) S.unread.delete(id);
  }

  let frame = 0;
  function refresh() {  // one redraw a frame, however many events came
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      decorate();
      renderGoal();
      renderBtw();
      applyProjectDefaults();
      if (typeof S.onChange === 'function') S.onChange();
    });
  }

  // ── the composer: a draft and attachments of its own per session ──

  let draftTimer = 0;

  function setComposer(text) {
    const input = $('deck-input');
    input.value = text || '';
    input.style.height = 'auto';
    input.style.height = `${Math.min(220, input.scrollHeight)}px`;
  }

  // The hub keeps a draft only when it's changed since it last heard it.
  function keepDraft(id) {
    const text = S.drafts.get(id) || '';
    if ((S.kept.get(id) || '') === text || !taskOf(id)) return;
    if (F.send({ type: 'code_draft', id, text })) S.kept.set(id, text);
  }
  F.on('jc_select', ({ id, previous }) => {
    const input = $('deck-input');
    clearTimeout(draftTimer);
    if (previous != null && previous !== id) {
      S.drafts.set(previous, input.value);
      keepDraft(previous);
      if (attachments.length) S.held.set(previous, attachments); else S.held.delete(previous);
    }
    if (previous !== id) {
      const draft = S.drafts.get(id) || '';
      // With no session open before, what was typed stays, after this one's draft (words that
      // go on from that draft, typed after a restart, aren't doubled).
      const typed = previous == null ? input.value : '';
      if (previous != null || draft) setComposer(!typed ? draft : typed.startsWith(draft) ? typed : `${draft}\n${typed}`);
      attachments = S.held.get(id) || (previous != null ? [] : attachments);
      S.held.delete(id);
      renderAttachments();
    }
    S.unread.delete(id);
    if (metaOf(id).history === false) F.send({ type: 'code_session_open', id });
    refresh();
  });

  $('deck-input').addEventListener('input', () => {
    const now = currentTask();
    if (!now) return;
    S.drafts.set(now.id, $('deck-input').value);
    clearTimeout(draftTimer);
    const id = now.id;
    draftTimer = setTimeout(() => keepDraft(id), 700);
  });
  // After app.js's own submit: a message that went leaves nothing to keep.
  $('deck-composer').addEventListener('submit', () => {
    const now = currentTask();
    if (now && !$('deck-input').value) {
      clearTimeout(draftTimer);
      S.drafts.set(now.id, '');
      keepDraft(now.id);
    }
  });

  // ── the sidebar: badges, pins, archive, groups ──

  const side = $('jc-side');
  const wrap = side.querySelector('.jc-projects-wrap');
  const filterBar = el('div', 'cs-filter');
  filterBar.setAttribute('role', 'tablist');
  filterBar.setAttribute('aria-label', 'Show sessions');
  filterBar.hidden = true;
  const pinned = el('div', 'cs-pinned');
  pinned.hidden = true;
  wrap.before(filterBar, pinned);

  new MutationObserver(() => decorate()).observe($('deck-project-list'), { childList: true });

  let inView = null;  // the open session, while it's seen
  function decorate() {
    const list = $('deck-project-list');
    // Read as it comes (back) into view, not at every redraw while it's there: one marked
    // unread by hand stays so until it's looked at again.
    const seen = ccSelected != null && seeing(ccSelected) ? ccSelected : null;
    if (seen != null && seen !== inView) S.unread.delete(seen);
    inView = seen;
    // The filter first: one with nothing left in it (the last archived session unarchived)
    // goes back to All before the rows are shown by it.
    renderFilter();
    for (const row of list.querySelectorAll('.jc-session[data-task]')) {
      const id = Number(row.dataset.task);
      const meta = metaOf(id);
      const li = row.parentElement;
      li.classList.add('cs-row');
      li.hidden = !rowShown(meta, S.filter, id === ccSelected);
      let badges = row.querySelector('.cs-badges');
      if (!badges) { badges = el('span', 'cs-badges'); row.append(badges); }
      const asks = needsYou(id).length;
      const shown = [asks ? 'needs' : S.unread.has(id) ? 'unread' : '', meta.pinned ? 'pin' : '', meta.goal && meta.goal.state === 'active' ? 'goal' : ''].filter(Boolean);
      if (badges.dataset.key !== shown.join()) {
        badges.dataset.key = shown.join();
        badges.replaceChildren(...shown.map(badge));
      }
      row.classList.toggle('cs-with-badges', shown.length > 0);
      if (!row.dataset.csMenu) {
        row.dataset.csMenu = '1';
        row.addEventListener('contextmenu', (e) => { e.preventDefault(); rowMenu(row, id); });
      }
      if (!li.querySelector('.cs-row-menu')) {
        const more = el('button', 'cs-row-menu', '⋯');
        more.type = 'button';
        more.setAttribute('aria-haspopup', 'menu');
        more.setAttribute('aria-label', 'Session options');
        more.title = 'Session options';
        more.addEventListener('click', (e) => { e.stopPropagation(); rowMenu(more, id); });
        li.append(more);
      }
    }
    // Filtered to a group or the archive: history rows and "+ New session" step aside,
    // and so does a project with nothing to show.
    const filtered = S.filter !== 'all';
    for (const li of list.querySelectorAll(':scope > li')) {
      const rows = [...li.querySelectorAll('.jc-sessions > li')];
      for (const r of rows) if (!r.classList.contains('cs-row')) r.hidden = filtered;
      li.hidden = filtered && !rows.some((r) => r.classList.contains('cs-row') && !r.hidden);
    }
    renderPinned();
    if (typeof moveGlider === 'function') moveGlider();
    if (S.project !== deckProject) { S.project = deckProject; applyProjectDefaults(); }
  }

  const PIN = '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.4 1.9l3.7 3.7-2.3 1-2.5 2.5.2 2.7-1.2 1.2L4 8.7l1.2-1.2 2.7.2 2.5-2.5z"/><path d="M6.1 9.9L2 14"/></svg>';
  S.pinIcon = PIN;
  function badge(kind) {
    const [cls, text, title] = {
      needs: ['cs-needs', '!', 'Needs you'],
      unread: ['cs-unread', '', 'New since you looked'],
      pin: ['cs-pin', '', 'Pinned'],
      goal: ['cs-goal-dot', '◎', 'Working toward a goal'],
    }[kind];
    const b = el('span', cls, text);
    if (kind === 'pin') b.insertAdjacentHTML('beforeend', PIN);
    b.title = t(title);
    b.setAttribute('aria-label', t(title));
    return b;
  }

  function renderFilter() {
    const archived = ccTasks.filter((x) => metaOf(x.id).archived).length;
    const groups = S.groups.filter((g) => ccTasks.some((x) => metaOf(x.id).group === g) || S.filter === `g:${g}`);
    if (S.filter.startsWith('g:') && !S.groups.includes(S.filter.slice(2))) S.filter = 'all';
    if (S.filter === 'archived' && !archived) S.filter = 'all';
    const chips = [['all', 'All'], ...groups.map((g) => [`g:${g}`, g]), ...(archived ? [['archived', `Archived (${archived})`]] : [])];
    filterBar.hidden = chips.length < 2;
    const key = JSON.stringify([chips, S.filter]);
    if (filterBar.dataset.key === key) return;
    filterBar.dataset.key = key;
    filterBar.replaceChildren(...chips.map(([id, label]) => {
      const b = el('button', 'cs-chip', label);
      if (id.startsWith('g:')) mine(b);  // a group's name is the user's
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(S.filter === id));
      b.addEventListener('click', () => filterTo(id));
      if (id.startsWith('g:')) b.addEventListener('contextmenu', (e) => { e.preventDefault(); groupMenu(b, id.slice(2)); });
      return b;
    }));
  }

  // A group or the archive shows in every project with sessions in it, folded or not.
  function filterTo(id) {
    S.filter = id;
    if (id !== 'all') for (const x of ccTasks) if (rowShown(metaOf(x.id), id, false)) openProjects.add(x.folder);
    renderProjects(deckProjects);
    decorate();
  }

  function renderPinned() {
    const items = ccTasks.filter((x) => metaOf(x.id).pinned && !metaOf(x.id).archived);
    pinned.hidden = !items.length;
    const key = JSON.stringify([items.map((x) => [x.id, x.title || x.prompt, x.folder, statusOf(x), needsYou(x.id).length, S.unread.has(x.id)]), ccSelected]);
    if (pinned.dataset.key === key) return;
    pinned.dataset.key = key;
    const head = el('p', 'cs-pinned-head', 'Pinned');
    pinned.replaceChildren(head, ...items.map((x) => {
      const b = el('button', 'cs-pinned-row');
      b.type = 'button';
      b.setAttribute('aria-current', String(x.id === ccSelected));
      b.append(el('span', `jc-dot ${needsYou(x.id).length ? 'needs' : statusOf(x)}`), mine(el('span', 'cs-pinned-title', x.title || x.prompt || 'New session')), mine(el('small', '', x.folder)));
      b.addEventListener('click', () => F.selectTask(x.id));
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); rowMenu(b, x.id); });
      return b;
    }));
  }

  function rowMenu(anchor, id) {
    const meta = metaOf(id);
    const task = taskOf(id);
    const live = task && !['stopped', 'failed'].includes(task.status);
    openMenu(anchor, [
      { label: meta.pinned ? 'Unpin' : 'Pin to the top', run: () => F.send({ type: 'code_meta_set', id, pinned: !meta.pinned }) },
      { label: 'Move to group', note: meta.group || '', sub: () => groupItems(id), subKind: 'groups' },
      { label: meta.archived ? 'Unarchive' : 'Archive', note: meta.archived ? '' : 'Hidden from the list; kept', run: () => F.send({ type: 'code_meta_set', id, archived: !meta.archived }) },
      { label: S.unread.has(id) ? 'Mark as read' : 'Mark as unread', run: () => { if (S.unread.has(id)) S.unread.delete(id); else S.unread.add(id); refresh(); } },
      ...(live ? ['-', { label: 'End session', run: () => F.send({ type: 'task_cancel', id }) }] : []),
    ]);
  }

  function groupItems(id) {
    const meta = metaOf(id);
    return [
      ...S.groups.map((g) => ({ label: g, checked: meta.group === g, run: () => F.send({ type: 'code_meta_set', id, group: g }) })),
      ...(meta.group ? [{ label: 'No group', run: () => F.send({ type: 'code_meta_set', id, group: '' }) }] : []),
      ...(S.groups.length || meta.group ? ['-'] : []),
      { label: 'New group…', run: () => askText(document.querySelector(`#deck-project-list .jc-session[data-task="${id}"]`) || $('deck-filter'), 'New group', '', (name) => F.send({ type: 'code_meta_set', id, group: name })) },
    ];
  }

  function groupMenu(anchor, name) {
    openMenu(anchor, [
      { label: 'Rename group…', run: () => askText(anchor, 'Rename group', name, (to) => F.send({ type: 'code_group', action: 'rename', name, to })) },
      { label: 'Remove group', note: 'Its sessions stay, in no group', run: () => F.send({ type: 'code_group', action: 'remove', name }) },
    ]);
  }

  // A one-line question in a small glass popover (window.prompt isn't there in the app).
  function askText(anchor, title, value, done) {
    document.querySelectorAll('.cs-ask').forEach((n) => n.remove());
    const pop = el('form', 'cs-ask jc-effort-pop');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', title);
    const input = el('input', 'jc-field');
    input.value = value || '';
    input.maxLength = 40;
    input.placeholder = t('Name');
    const ok = el('button', 'jc-btn small filled', 'Save');
    ok.type = 'submit';
    pop.append(el('p', 'cs-ask-title', title), input, ok);
    const close = () => { pop.remove(); document.removeEventListener('mousedown', outside, true); };
    const outside = (e) => { if (!pop.contains(e.target)) close(); };
    pop.addEventListener('submit', (e) => { e.preventDefault(); const v = input.value.replace(/\s+/g, ' ').trim(); close(); if (v && v !== value) done(v); });
    pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    $('cc').append(pop);
    pop.hidden = false;
    placePopup(pop, anchor, 'auto');
    setTimeout(() => document.addEventListener('mousedown', outside, true));
    input.focus();
    input.select();
  }

  // Open folder…: any folder in the home folder as a project (the hub says no, with the
  // reason, to one too broad or private). With a picker of its own in the app; the second
  // brain's otherwise, or a typed path in a browser.
  async function pickFolder(root) {
    if (app && app.feature) {
      try { return await app.feature.invoke('feature:code-sessions:pick-folder', root ? 'root' : 'project'); } catch (_) { /* an app built before this: its own picker */ }
    }
    if (app && app.pickFolder) return app.pickFolder();
    const typed = prompt(t('The full path of the folder:'));
    return typed ? typed.trim() : null;
  }
  async function openFolder(root = false) {
    const path = await pickFolder(root);
    if (path) F.send({ type: 'code_project_add', path, root });
  }
  const folderBtn = el('button', 'jc-icon cs-foot-btn cs-open-folder');
  folderBtn.type = 'button';
  folderBtn.setAttribute('aria-label', 'Open folder…');
  folderBtn.title = 'Open folder… (any folder as a project)';
  folderBtn.append(icon('folder', 16));
  folderBtn.addEventListener('click', () => openFolder(false));
  side.querySelector('.jc-side-foot').append(folderBtn);
  S.openFolder = openFolder;

  // ── edit and resend a message of yours; rewind the conversation in place ──

  const PENCIL = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 13l.8-3 6.9-6.9a1.4 1.4 0 0 1 2 2L5.9 12.2z"/><path d="M9.8 4.1l2 2"/></svg>';
  function addEdit(li) {
    const actions = li.querySelector('.jc-user-actions');
    if (!actions || actions.querySelector('.cs-edit-btn')) return;
    const b = el('button', 'jc-act cs-edit-btn');
    b.type = 'button';
    b.dataset.title = 'Edit this message and send it again, or go back to before it';
    b.insertAdjacentHTML('beforeend', PENCIL);
    b.append(el('span', 'jc-act-label', 'Edit'));
    b.disabled = !li.dataset.uuid;
    b.addEventListener('click', () => openEditor(li));
    actions.append(b);
  }
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1 && n.classList.contains('jc-user')) addEdit(n);
  }).observe($('deck-timeline'), { childList: true });

  const editing = new Map();  // uuid -> { text, rewindOnly } awaiting the hub's answer
  function openEditor(li) {
    const uuid = li.dataset.uuid;
    const task = currentTask();
    if (!uuid || !task || li.querySelector('.cs-editor')) return;
    const said = (li.querySelector('.jc-user-text') || li).textContent;
    const box = el('div', 'cs-editor');
    const area = mine(el('textarea', 'cs-editor-text'));
    area.value = said;
    area.rows = Math.min(8, Math.max(2, said.split('\n').length));
    area.setAttribute('aria-label', 'Your message, to send again');
    const files = el('label', 'cs-editor-files');
    const tick = el('input');
    tick.type = 'checkbox';
    files.append(tick, el('span', '', 'Also put the files back as they were before it'));
    const err = el('p', 'cs-editor-err');
    err.hidden = true;
    const row = el('div', 'cs-editor-row');
    const button = (label, cls, run) => { const b = el('button', `jc-btn small ${cls}`, label); b.type = 'button'; b.addEventListener('click', run); return b; };
    const close = () => { box.remove(); li.classList.remove('cs-editing'); editing.delete(uuid); };
    const go = (fork, withText) => {
      const text = area.value.trim();
      if (withText && !text) { area.focus(); return; }
      editing.set(uuid, { text, rewindOnly: !withText, close, err, box });
      row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      if (!F.send({ type: 'code_rewind', id: task.id, uuid, text: withText ? text : '', files: !fork && tick.checked, fork })) {
        editing.delete(uuid);
        row.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        return;
      }
      if (fork) close();  // the fork opens by itself; this one stays as it was
    };
    row.append(
      button('Resend', 'filled', () => go(false, true)),
      button('Resend in a fork', '', () => go(true, true)),
      button('Rewind to here', '', () => go(false, false)),
      button('Cancel', '', close),
    );
    row.firstChild.title = t('Go back to before this message and send it as edited (⌘⏎)');
    row.children[1].title = t('A new session from before this message, with the edited words; this one stays as it is');
    row.children[2].title = t('Go back to before this message and put it in the composer, unsent');
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(false, true); }
    });
    box.append(area, files, err, row, el('p', 'cs-editor-hint', 'Going back leaves out this message and everything after it.'));
    li.classList.add('cs-editing');
    li.append(box);
    area.focus();
    area.selectionStart = area.selectionEnd = area.value.length;
  }
  F.on('code_rewound', (ev) => {
    const pending = editing.get(ev.uuid);
    if (!pending) return;
    editing.delete(ev.uuid);
    if (!ev.ok) {
      pending.err.textContent = ev.text || '';
      pending.err.hidden = false;
      pending.box.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      return;
    }
    pending.close();
    if (pending.rewindOnly && ev.id === ccSelected) { setComposer(pending.text); S.drafts.set(ev.id, pending.text); $('deck-input').focus(); }
  });
  F.registerMoreItem({ label: 'Rewind the conversation…', when: (task) => !!task, run: rewindMenu });
  function rewindMenu() {
    const said = [...$('deck-timeline').querySelectorAll(':scope > .jc-user[data-uuid]')].reverse().slice(0, 12);
    if (!said.length) { jcNote(t('Nothing to go back to yet: send a message first.')); return; }
    openMenu($('jc-more'), [
      { heading: 'Go back to before…' },
      ...said.map((li) => ({
        label: (li.querySelector('.jc-user-text') || li).textContent.slice(0, 70),
        run: () => { li.scrollIntoView({ block: 'center' }); openEditor(li); },
      })),
    ]);
  }

  // ── /btw: a side question, answered beside the session, never in it ──

  const asides = el('div', 'cs-asides');
  asides.setAttribute('aria-live', 'polite');
  const goalBox = el('div', 'cs-goal');
  goalBox.hidden = true;
  $('jc-bg').before(goalBox, asides);
  let btwRef = 0;
  F.registerSlash({
    name: 'btw',
    help: 'Ask on the side: it doesn’t join the conversation',
    needsArg: true,
    withoutSession: true,
    run(arg, task) {
      if (!task) { jcNote(t('Open a session first: a side question is about one.')); return true; }
      if (!arg) { jcNote(t('Ask it like this: /btw what does this change touch?')); return true; }
      const ref = `b${++btwRef}`;
      S.btw = [...S.btw, { id: task.id, ref, question: arg, state: 'working', text: '' }];
      trimBtw(task.id);
      F.send({ type: 'code_btw', id: task.id, question: arg, ref });
      refresh();
      return true;
    },
  });
  function trimBtw(id) {
    const mineNow = S.btw.filter((b) => b.id === id);
    if (mineNow.length > 3) { const gone = new Set(mineNow.slice(0, mineNow.length - 3)); S.btw = S.btw.filter((b) => !gone.has(b)); }
  }
  F.on('code_btw', (ev) => {
    let card = S.btw.find((b) => b.ref === ev.ref && b.id === ev.id);
    if (!card) { card = { id: ev.id, ref: ev.ref, question: ev.question || '' }; S.btw.push(card); trimBtw(ev.id); }
    Object.assign(card, { state: ev.state, text: ev.text || '' });
    refresh();
  });
  function renderBtw() {
    const now = currentTask();
    const cards = now ? S.btw.filter((b) => b.id === now.id) : [];
    const key = JSON.stringify(cards);
    if (asides.dataset.key === key) return;
    asides.dataset.key = key;
    asides.replaceChildren(...cards.map((b) => {
      const card = el('div', `cs-aside ${b.state}`);
      const top = el('div', 'cs-aside-head');
      top.append(el('span', 'cs-aside-kicker', 'By the way'), mine(el('span', 'cs-aside-q', b.question)));
      const x = el('button', 'cs-aside-x', '✕');
      x.type = 'button';
      x.setAttribute('aria-label', 'Close');
      x.addEventListener('click', () => { S.btw = S.btw.filter((c) => c !== b); refresh(); });
      top.append(x);
      card.append(top);
      if (b.state === 'working') card.append(el('p', 'jc-sheen cs-aside-wait', 'Looking into it…'));
      else if (b.state === 'error') card.append(el('p', 'cs-aside-err', b.text));
      else card.append(richText(b.text), copyButton(() => b.text));
      return card;
    }));
  }

  // ── /goal: a goal the session keeps working toward ──

  F.registerSlash({
    name: 'goal',
    help: 'A goal it keeps working toward: /goal all tests pass',
    needsArg: true,
    withoutSession: true,
    run(arg, task) {
      const goal = task ? metaOf(task.id).goal : null;
      const { action, text } = goalAction(arg, !!goal);
      if (!action) { jcNote(t('Say what the goal is, like this: /goal all tests pass')); return true; }
      if (!task) {
        if (action !== 'set' || !deckProject) { jcNote(t('Open a session first.')); return true; }
        F.send({ type: 'code_goal_new', directory: deckProject, text });
        return true;
      }
      if (action !== 'set' && action !== 'edit' && !goal) { jcNote(t('This session has no goal.')); return true; }
      F.send({ type: 'code_goal', id: task.id, action, text: text || '' });
      return true;
    },
  });
  const GOAL_STATE = { active: 'Working toward it', paused: 'Paused', met: 'Met' };
  function renderGoal() {
    const now = currentTask();
    const goal = now ? metaOf(now.id).goal : null;
    goalBox.hidden = !goal;
    if (!goal) { goalBox.dataset.key = ''; return; }
    const key = JSON.stringify([now.id, goal]);
    // A goal being edited stays as its goal changes, but never under another session's banner.
    if (goalBox.dataset.key === key || (goalBox.querySelector('.cs-goal-edit') && goalBox.dataset.id === String(now.id))) return;
    goalBox.dataset.key = key;
    goalBox.dataset.id = now.id;
    goalBox.className = `cs-goal ${goal.state}`;
    const head = el('div', 'cs-goal-head');
    head.append(el('span', 'cs-goal-mark', goal.state === 'met' ? '✓' : '◎'), el('span', 'cs-goal-kicker', 'Goal'), el('span', `cs-goal-state ${goal.state}`, GOAL_STATE[goal.state] || goal.state));
    if (goal.native) head.append(el('span', 'cs-goal-native', 'kept by Jarvis Code itself'));
    const text = mine(el('p', 'cs-goal-text', goal.text));
    const acts = el('div', 'cs-goal-acts');
    const act = (label, action, cls = '') => { const b = el('button', `jc-mini ${cls}`, label); b.type = 'button'; b.addEventListener('click', () => F.send({ type: 'code_goal', id: now.id, action })); return b; };
    if (goal.state === 'active') acts.append(act('Pause', 'pause'));
    else acts.append(act(goal.state === 'met' ? 'Work on it again' : 'Resume', 'resume'));
    const edit = el('button', 'jc-mini', 'Edit');
    edit.type = 'button';
    edit.addEventListener('click', () => editGoal(now.id, goal.text));
    acts.append(edit);
    if (goal.state !== 'met') acts.append(act('Done', 'complete'));
    acts.append(act('Remove', 'clear', 'cs-goal-remove'));
    goalBox.replaceChildren(head, text, ...(goal.note ? [el('p', 'cs-goal-note', goal.note)] : []), acts);
  }
  function editGoal(id, text) {
    const form = el('form', 'cs-goal-edit');
    const input = mine(el('input', 'jc-field'));
    input.value = text;
    input.setAttribute('aria-label', 'The goal');
    const save = el('button', 'jc-btn small filled', 'Save');
    save.type = 'submit';
    const cancel = el('button', 'jc-btn small', 'Cancel');
    cancel.type = 'button';
    const done = () => { goalBox.dataset.key = ''; renderGoal(); };
    cancel.addEventListener('click', done);
    form.addEventListener('submit', (e) => { e.preventDefault(); const v = input.value.trim(); if (v && v !== text) F.send({ type: 'code_goal', id, action: 'edit', text: v }); form.remove(); done(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); form.remove(); done(); } });
    form.append(input, save, cancel);
    goalBox.querySelector('.cs-goal-text').replaceWith(form);
    input.focus();
  }

  // ── snippets: saved prompts, in the / palette ──

  let snippetsOn = [];  // the snippets' commands, as registered here
  // Names a snippet can't have: the built-in commands and their other names (/ask, /config),
  // and every feature's own (/btw, /usage…), whichever loaded first.
  function commandNames() {
    const features = [...featureSlash].filter(([, c]) => !snippetsOn.includes(c)).map(([name]) => name);
    return [...SLASH_COMMANDS.map(([n]) => n), ...Object.keys(SLASH_MODE_IDS), ...SLASH_WITHOUT_SESSION, ...features];
  }
  function applySnippets(list) {
    // Only its own go: a feature loaded after this one keeps a name it took from a snippet.
    snippetsOn.forEach((c) => { if (featureSlash.get(c.name) === c) F.unregisterSlash(c.name); });
    snippetsOn = snippetCommands(list, commandNames());
    snippetsOn.forEach((c) => F.registerSlash(c));
  }

  // ── projects' own defaults, as the composer shows them with no session open ──

  function projectPath(name) { const p = deckProjects.find((x) => x.name === name); return p ? p.path : ''; }
  function ownDefaults(name) {
    const all = (prefs && prefs.features && prefs.features.code_project_defaults) || {};
    return all[projectPath(name)] || null;
  }
  function globalDefaults(p) { return { code_mode: p.code_mode || 'ask', code_model: p.code_model || '', code_effort: p.code_effort || '', code_ultracode: !!p.code_ultracode }; }
  function applyProjectDefaults() {
    if (!prefs || currentTask()) return;
    const own = deckProject ? ownDefaults(deckProject) : null;
    const g = globalDefaults(prefs);
    const shown = effectiveDefaults({ mode: g.code_mode, model: g.code_model, effort: g.code_effort, ultracode: g.code_ultracode }, own);
    if (JSON.stringify(shown) === JSON.stringify(codeDefaults)) return;
    codeDefaults = shown;
    renderComposer();
  }
  function onPrefs(p) {
    S.groups = (p.features && p.features.code_groups) || [];
    applySnippets((p.features && p.features.code_snippets) || []);
    const now = globalDefaults(p);
    const own = deckProject ? ownDefaults(deckProject) : null;
    const moved = !currentTask() && $('jc-settings').hidden ? movedDefaults(S.defaultsBefore, now, own) : {};
    S.defaultsBefore = now;
    if (Object.keys(moved).length) setProjectDefaults(projectPath(deckProject), { ...own, ...moved });
    if (settingsOpen('snippets')) renderSnippetsTab();
    if (settingsOpen('projects')) renderProjectsTab();
    refresh();
  }
  function setProjectDefaults(path, fields) {
    if (!path) return;
    const all = { ...((prefs && prefs.features && prefs.features.code_project_defaults) || {}) };
    const clean = Object.fromEntries(Object.entries(fields || {}).filter(([, v]) => v !== '' && v !== null && v !== undefined));
    if (Object.keys(clean).length) all[path] = clean; else delete all[path];
    F.send({ type: 'feature_prefs', changes: { code_project_defaults: all } });
  }

  // ── Settings › Projects and Snippets (tabs of Jarvis Code settings) ──

  const tabs = document.querySelector('.jcs-tabs');
  const card = document.querySelector('.jcs-card');
  const panels = {};
  for (const [id, label] of [['projects', 'Projects'], ['snippets', 'Snippets']]) {
    const tab = el('button', '', label);
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.dataset.tab = id;
    tabs.append(tab);
    const panel = el('div', 'jcs-body cs-jcs');
    panel.setAttribute('role', 'tabpanel');
    panel.hidden = true;
    card.append(panel);
    panels[id] = panel;
    tab.addEventListener('click', () => selectJcsTab(id));
    // app.js marks every tab selected or not: this one's panel follows.
    new MutationObserver(() => {
      const on = tab.getAttribute('aria-selected') === 'true';
      if (on === !panel.hidden) return;
      panel.hidden = !on;
      if (on && id === 'projects') { F.send({ type: 'code_meta_get' }); renderProjectsTab(); }
      if (on && id === 'snippets') renderSnippetsTab();
    }).observe(tab, { attributes: true, attributeFilter: ['aria-selected'] });
  }
  function settingsOpen(id) { return !$('jc-settings').hidden && panels[id] && !panels[id].hidden; }

  function folderList(paths, root, empty) {
    const ul = el('ul', 'jcs-providers cs-folders');
    if (!paths.length) { ul.append(el('li', 'cs-empty', empty)); return ul; }
    ul.append(...paths.map((path) => {
      const li = el('li', 'cs-folder');
      li.append(mine(el('code', '', path)));
      const rm = el('button', 'jc-btn small danger', 'Remove');
      rm.type = 'button';
      rm.addEventListener('click', () => F.send({ type: 'code_project_remove', path, root }));
      li.append(rm);
      return li;
    }));
    return ul;
  }
  function select(options, value, onChange, label) {
    const s = el('select', 'jcs-select');
    s.setAttribute('aria-label', label);
    s.append(...options.map(([v, text]) => option(v, text, v === value)));
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }
  let defaultsFor = '';
  function renderProjectsTab() {
    const panel = panels.projects;
    const p = S.projects;
    const add = (label, root) => { const b = el('button', 'jc-btn', label); b.type = 'button'; b.addEventListener('click', () => openFolder(root)); return b; };
    const main = el('p', 'jcs-intro');
    main.append(document.createTextNode(t('Every folder in your projects folder is a project:') + ' '), mine(el('code', '', p.main || '')));
    const hidden = p.hidden && p.hidden.length ? [el('p', 'jcs-intro cs-hidden', 'Not listed, since another project has the same name:'), folderList(p.hidden, null, '')] : [];
    hidden.forEach((n) => n.querySelectorAll && n.querySelectorAll('button').forEach((b) => b.remove()));
    // A project's own defaults for new sessions there.
    const names = deckProjects.map((x) => x.name);
    if (!names.includes(defaultsFor)) defaultsFor = deckProject && names.includes(deckProject) ? deckProject : names[0] || '';
    const own = ownDefaults(defaultsFor) || {};
    const path = projectPath(defaultsFor);
    const set = (field, value) => setProjectDefaults(path, { ...own, [field]: value });
    const models = [['', 'Jarvis Code’s default'], ...modelList.map((m) => [m.ref, m.builtin ? m.label : `${m.label} · ${m.provider_name}`])];
    const rows = el('div', 'jcs-group');
    const row = (label, control) => { const r = el('label', 'jcs-row'); r.append(el('span', '', label), control); return r; };
    // Bypass for the new sessions here is asked about first (Touch ID, or the usual question),
    // as it is for everyone's in General; a no puts back what was saved.
    const mode = select([['', 'Jarvis Code’s default'], ...JC_MODES.map((m) => [m.id, m.label])], own.mode || '', (v) => {
      if (v === 'auto') confirmBypass('bypass-default', 'New sessions in this project would run any command and change any file without asking. Start them in Bypass permissions?', () => set('mode', v), () => { mode.value = own.mode || ''; });
      else set('mode', v);
    }, 'Permission mode');
    rows.append(
      row('Project', select(names.map((n) => [n, n]), defaultsFor, (v) => { defaultsFor = v; renderProjectsTab(); }, 'Project')),
      row('Permission mode', mode),
      row('Model', select(models, own.model || '', (v) => set('model', v), 'Model')),
      row('Effort', select([['', 'Jarvis Code’s default'], ...EFFORTS.map((e) => [e, EFFORT_NAMES[e]])], own.effort || '', (v) => set('effort', v), 'Effort')),
      row('Ultracode', select([['', 'Jarvis Code’s default'], ['on', 'On'], ['off', 'Off']], own.ultracode === undefined ? '' : own.ultracode ? 'on' : 'off', (v) => set('ultracode', v === '' ? undefined : v === 'on'), 'Ultracode')),
    );
    rows.querySelectorAll('select').forEach((s, i) => { if (i && !path) s.disabled = true; });
    if (names.length) rows.firstChild.querySelector('select').querySelectorAll('option').forEach(mine);
    panel.replaceChildren(
      el('p', 'jcs-label', 'Folders of projects'),
      main,
      folderList(p.roots || [], true, 'No other folders of projects yet.'),
      add('Add a folder of projects…', true),
      el('p', 'jcs-label', 'Folders opened one by one'),
      folderList(p.folders || [], false, 'None yet: Open folder… adds any folder in your home folder.'),
      add('Open folder…', false),
      ...hidden,
      el('p', 'jcs-label', 'New sessions in a project start with'),
      ...(names.length ? [rows] : [el('p', 'cs-empty', 'No projects yet.')]),
    );
  }

  let editingSnippet = null;
  function renderSnippetsTab() {
    const panel = panels.snippets;
    const list = (prefs && prefs.features && prefs.features.code_snippets) || [];
    const save = (next) => F.send({ type: 'feature_prefs', changes: { code_snippets: next } });
    const ul = el('ul', 'jcs-providers cs-snippets');
    ul.append(...(list.length ? list.map((s) => {
      const li = el('li', 'cs-snippet');
      const top = el('div', 'jcs-p-head');
      const name = el('div', 'jcs-p-title');
      name.append(mine(el('strong', '', `/${s.name}`)), mine(el('small', '', s.text.length > 140 ? `${s.text.slice(0, 140)}…` : s.text)));
      const edit = el('button', 'jc-btn small', 'Edit');
      edit.type = 'button';
      edit.addEventListener('click', () => { editingSnippet = s.name; renderSnippetsTab(); });
      const rm = el('button', 'jc-btn small danger', 'Remove');
      rm.type = 'button';
      rm.addEventListener('click', () => save(list.filter((x) => x.name !== s.name)));
      top.append(name, edit, rm);
      li.append(top);
      return li;
    }) : [el('li', 'cs-empty', 'No snippets yet.')]));
    const editing = list.find((s) => s.name === editingSnippet) || null;
    const form = el('form', 'jcs-group jcs-add cs-snippet-form');
    const nameIn = mine(el('input', 'jcs-input'));
    nameIn.placeholder = 'review-pr';
    nameIn.maxLength = 40;
    nameIn.value = editing ? editing.name : '';
    const textIn = mine(el('textarea', 'jcs-input cs-snippet-text'));
    textIn.rows = 4;
    textIn.placeholder = t('The prompt it puts in the composer');
    textIn.value = editing ? editing.text : '';
    const help = el('p', 'jcs-help');
    const go = el('button', 'jc-btn filled', editing ? 'Save snippet' : 'Add snippet');
    go.type = 'submit';
    const labelled = (label, control) => { const r = el('label', 'jcs-row'); r.append(el('span', '', label), control); return r; };
    form.append(el('p', 'jcs-label in', editing ? 'Edit the snippet' : 'Add a snippet'), labelled('Name', nameIn), labelled('Prompt', textIn), help, go);
    if (editing) {
      const cancel = el('button', 'jc-btn', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', () => { editingSnippet = null; renderSnippetsTab(); });
      form.append(cancel);
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = nameIn.value.trim().toLowerCase();
      const text = textIn.value;
      help.classList.add('bad');
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) { help.textContent = t('Name it with letters, digits and dashes, like review-pr.'); return; }
      if (commandNames().includes(name)) { help.textContent = t('That name is a built-in command: pick another.'); return; }
      if (!text.trim()) { help.textContent = t('Write the prompt it puts in the composer.'); return; }
      // Another's name, new or renamed onto it: the hub keeps only the first of two.
      if (list.some((s) => s.name === name && s !== editing)) { help.textContent = t('There’s a snippet with that name already.'); return; }
      const rest = list.filter((s) => s.name !== (editing ? editing.name : name));
      editingSnippet = null;
      save([...rest, { name, text }]);
    });
    panel.replaceChildren(el('p', 'jcs-intro', 'Saved prompts: type / and the name to put one in the composer, to edit and send.'), ul, form);
  }

  // Last, with what came before this loaded: a window's settings come with the hub's hello,
  // and a restarted hub numbers its sessions anew, so their state is asked for again.
  F.on('hello', (ev) => {
    S.btw = [];
    if (ev.prefs) onPrefs(ev.prefs);
    F.send({ type: 'code_meta_get' });
  }, { replay: true });
  F.on('prefs', (p) => onPrefs(p), { replay: true });
  refresh();
})(typeof window === 'object' ? window : globalThis);
