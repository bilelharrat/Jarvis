// Jarvis Code's Changes pane, drawn by the diff view (code_diff.js) in place of the old one:
// what this session changed (in a shared folder, only the hunks its own edits made; in its
// isolated copy, everything since the copy began), as this turn, this session or the whole
// branch; each hunk numbered as voice counts them ("undo change 3"), with Keep and Undo;
// comments on any line, sent to the session together; unified or side by side.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  // The diff view's helpers (code_diff.js), which load after this file (name order): taken
  // when the pane is first drawn.
  const diff = () => window.JarvisDiff;
  const { el, send, t } = F;
  const VIEWS = [['turn', 'This turn'], ['session', 'This session'], ['branch', 'Whole branch']];
  const FIRST_ROWS = 400; // a long hunk's rows drawn at first; the rest on request
  const OPEN_FILES = 6; // files open at first (the rest open on a click)

  const store = {
    views: new Map(), // session id -> the view it's on
    data: new Map(), // `${id}:${view}` -> the latest code_changes event
    kept: new Map(), // session id -> Set of hunk ids kept
    comments: new Map(), // session id -> [{ path, line, side, text, excerpt }]
    extra: new Map(), // `${id}:${path}:${start}` -> lines fetched to open a collapsed stretch
    opened: new Map(), // `${id}:${view}` -> Set of paths the owner opened or closed
    more: new Set(), // hunk ids drawn in full
  };
  let mode = 'unified';
  try { mode = localStorage.getItem('jcx-diff-mode') === 'split' ? 'split' : 'unified'; } catch (_) { /* no storage */ }
  // Other features' parts of the pane (code_review.js): top(task, data) adds a section under
  // the bar; after(task, path, side, line) adds rows under a line.
  const extensions = [];
  let body = null; // the pane's body while this pane shows
  let editing = null; // { path, line, side, excerpt, draft } of the comment being written
  let refreshTimer = 0;
  const asked = new Map(); // `${id}:${view}` -> when its view was last asked for

  const viewOf = (task) => store.views.get(task.id) || 'session';
  const keyOf = (task, view = viewOf(task)) => `${task.id}:${view}`;
  const showing = () => body && body.isConnected && body.querySelector('.jcx-changes');

  function request(task, extra = {}) {
    if (!extra.path) asked.set(keyOf(task), Date.now());
    send({ type: 'code_changes', id: task.id, view: viewOf(task), ...extra });
  }

  function refreshSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      const task = F.currentTask();
      if (task && showing()) request(task);
    }, 900);
  }

  // ── pieces ──

  function button(label, cls, run, title) {
    const b = el('button', cls, label);
    b.type = 'button';
    if (title) b.title = t(title);
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); run(b); });
    return b;
  }

  function refreshButton(run) {
    const b = button('', 'jc-icon jcx-refresh', run, 'Refresh');
    b.setAttribute('aria-label', 'Refresh');
    b.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3.2h-3.2"/></svg>';
    return b;
  }

  // A click that asks for a second one within a few seconds (Undo can't be taken back here).
  function twoClick(label, armedLabel, run, title) {
    let armed = 0;
    return button(label, 'jc-mini jcx-undo', (b) => {
      if (!armed) {
        b.textContent = t(armedLabel);
        b.classList.add('armed');
        armed = setTimeout(() => { armed = 0; b.textContent = t(label); b.classList.remove('armed'); }, 3500);
        return;
      }
      clearTimeout(armed);
      armed = 0;
      run();
    }, title);
  }

  function comments(task) {
    if (!store.comments.has(task.id)) store.comments.set(task.id, []);
    return store.comments.get(task.id);
  }

  function commentRow(task, c) {
    const row = el('div', 'jcx-comment');
    const text = el('span', 'jcx-comment-text', c.text);
    text.dataset.noI18n = '';
    row.append(el('span', 'jcx-comment-mark', '💬'), text, button('Remove', 'jc-mini', () => {
      const list = comments(task);
      list.splice(list.indexOf(c), 1);
      render();
    }));
    return row;
  }

  function editorRow(task, spot) {
    const row = el('div', 'jcx-comment edit');
    const box = el('textarea', 'jc-field');
    box.rows = 2;
    box.placeholder = t('Comment on this line (sent to the session with the others)');
    box.dataset.noI18n = '';
    box.value = spot.draft || '';  // (a refresh while writing keeps what's written)
    box.addEventListener('input', () => { if (editing) editing.draft = box.value; });
    const add = () => {
      const text = box.value.trim();
      const { draft, ...where } = spot;
      if (text) comments(task).push({ ...where, text });
      editing = null;
      render();
    };
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add(); }
      if (e.key === 'Escape') { e.preventDefault(); editing = null; render(); }
    });
    const actions = el('div', 'jcx-comment-actions');
    actions.append(button('Add comment', 'jc-btn small filled', add), button('Cancel', 'jc-btn small', () => { editing = null; render(); }));
    row.append(box, actions);
    return row;
  }

  // Comments (and the one being written) under their lines, after what other features pin.
  function placeComments(task, path, lines) {
    const mine = comments(task).filter((c) => c.path === path);
    for (const row of lines.querySelectorAll('.jcx-row')) {
      const side = row.dataset.side, line = Number(row.dataset.line);
      const here = mine.filter((c) => c.side === side && c.line === line);
      let after = row;
      for (const ext of extensions) {
        if (!ext.after) continue;
        try {
          for (const node of ext.after(task, path, side, line) || []) { after.after(node); after = node; }
        } catch (err) { console.error('changes extension', err); }
      }
      for (const c of here) { const n = commentRow(task, c); after.after(n); after = n; }
      if (editing && editing.path === path && editing.side === side && editing.line === line) after.after(editorRow(task, editing));
    }
  }

  function startComment(task, path, row) {
    const side = row.dataset.side, line = Number(row.dataset.line);
    if (!side || !line) return;
    const code = row.querySelector(side === 'o' ? '.jcx-code.del, .jcx-code' : '.jcx-code.add, .jcx-code:last-child');
    editing = { path, side, line, excerpt: (code ? code.textContent : '').trim().slice(0, 80) };
    render();
  }

  // The unchanged lines between two hunks: collapsed, with how many; a click fetches them.
  function gapRow(task, file, start, count) {
    const key = `${task.id}:${file.path}:${start}`;
    const fetched = store.extra.get(key);
    if (fetched) {
      const block = el('div', 'jcx-opened');
      const lines = el('div', `jcx-lines ${mode}`);
      fetched.forEach((text, k) => {
        const hunk = { old_start: 0, new_start: start + k, lines: [[' ', text]] };
        const built = diff().buildHunk(document, hunk, { mode, path: file.path });
        for (const row of built.el.querySelectorAll('.jcx-row')) {
          row.querySelectorAll('.jcx-ln.o').forEach((n) => { n.textContent = ''; });
          lines.append(row);
        }
      });
      const wrap = el('div', 'jcx-scroll');
      wrap.append(lines);
      block.append(wrap);
      // A long stretch opens 200 lines at a time: what's left stays folded after them.
      if (fetched.length && fetched.length < count) block.append(gapRow(task, file, start + fetched.length, count - fetched.length));
      return block;
    }
    const gap = button(`⋯ ${count} unchanged line${count === 1 ? '' : 's'}`, 'jcx-gap', () => {
      send({ type: 'code_lines', id: task.id, path: file.path, start, end: start + Math.min(count, 200) - 1 });
    }, 'Show them');
    return gap;
  }

  const isNew = (file) => file.status === 'A' || file.status === '?';

  function hunkBlock(task, file, hunk, view) {
    const box = el('div', 'jcx-hunk');
    box.dataset.hunk = hunk.id;
    const kept = (store.kept.get(task.id) || new Set()).has(hunk.id);
    box.classList.toggle('kept', kept);
    const head = el('div', 'jcx-hunk-head');
    if (hunk.n) head.append(el('span', 'jcx-num', `#${hunk.n}`));
    const where = el('span', 'jcx-where', `line ${hunk.line}${hunk.where ? ` · ${hunk.where}` : ''}`);
    head.append(where, el('span', 'jc-spacer'));
    if (kept) head.append(el('span', 'jcx-kept', '✓ Kept'));
    head.append(button(kept ? 'Unkeep' : 'Keep', 'jc-mini', () => {
      const set = store.kept.get(task.id) || new Set();
      if (kept) set.delete(hunk.id); else set.add(hunk.id);
      store.kept.set(task.id, set);
      send({ type: 'code_hunk', id: task.id, hunk: hunk.id, action: kept ? 'unkeep' : 'keep', view });
      render();
    }, kept ? 'Show it with the changes still to review' : 'Mark it reviewed and fold it away'));
    if (!isNew(file)) {
      head.append(twoClick('Undo', 'Click to undo', () => send({ type: 'code_hunk', id: task.id, hunk: hunk.id, action: 'undo', view }), 'Put just this change back as it was'));
    }
    head.append(button('Comment', 'jc-mini', () => {
      editing = { path: file.path, side: 'n', line: hunk.line, excerpt: '' };
      render();
    }, 'Comment on this change'));
    box.append(head);
    if (kept) return box;
    const full = store.more.has(hunk.id);
    const built = diff().buildHunk(document, hunk, { mode, path: file.path, limit: full ? Infinity : FIRST_ROWS });
    built.el.addEventListener('click', (e) => {
      const number = e.target.closest('.jcx-ln');
      if (number && number.dataset.line) startComment(task, file.path, number.closest('.jcx-row'));
    });
    placeComments(task, file.path, built.el);
    const scroll = el('div', 'jcx-scroll');
    scroll.append(built.el);
    box.append(scroll);
    if (built.left) box.append(button(`Show ${built.left} more lines`, 'jcx-more', () => { store.more.add(hunk.id); render(); }));
    else if (hunk.cut) box.append(el('p', 'jcx-cut', `${hunk.cut} more lines aren’t shown.`));
    return box;
  }

  function fileBlock(task, file, index, view, openSet) {
    const det = el('details', 'jcx-file');
    const wanted = openSet.has(file.path) ? openSet.get(file.path) : index < OPEN_FILES && !file.omitted;
    det.open = wanted;
    const sum = el('summary');
    const name = el('span', 'jcx-path', file.old_path ? `${file.old_path} → ${file.path}` : file.path);
    name.dataset.noI18n = '';
    const status = { A: 'new', '?': 'new', D: 'deleted', R: 'renamed' }[file.status];
    sum.append(name);
    if (status) sum.append(el('span', `jcx-chip ${status}`, status));
    sum.append(el('span', 'jc-spacer'), el('span', 'jc-plus', `+${file.added}`), el('span', 'jc-minus', `−${file.removed}`));
    det.append(sum);
    det.addEventListener('toggle', () => {
      openSet.set(file.path, det.open);
      if (det.open && !det.querySelector('.jcx-hunks')) fill();
    });
    const fill = () => {
      const hunks = el('div', 'jcx-hunks');
      if (file.sensitive) hunks.append(el('p', 'jcx-cut', 'Credentials: changed, but its lines aren’t shown.'));
      else if (file.binary) hunks.append(el('p', 'jcx-cut', 'A binary file changed.'));
      else if (file.omitted) {
        hunks.append(button('Show its changes', 'jc-btn small', () => request(task, { path: file.path })));
      }
      let prev = null;
      for (const hunk of file.hunks || []) {
        const count = diff().gap(prev, hunk);
        const start = prev ? prev.new_start + prev.new_count : 1;
        if (count) hunks.append(gapRow(task, file, start, count));
        hunks.append(hunkBlock(task, file, hunk, view));
        prev = hunk;
      }
      det.append(hunks);
    };
    if (det.open) fill();
    return det;
  }

  function isolatedStrip(task, data) {
    const ws = data.workspace || task.workspace || {};
    if (!ws.branch) return null;
    const strip = el('div', 'jcx-strip');
    const label = el('span', 'jcx-strip-label');
    const branch = el('code', '', `${ws.branch} → ${ws.into}`);
    branch.dataset.noI18n = '';
    label.append(el('span', 'jcx-iso-dot'), el('span', '', 'Isolated copy'), branch);
    strip.append(label, el('span', 'jc-spacer'),
      button('Land', 'jc-btn small filled', () => send({ type: 'code_copy', slug: ws.slug, action: 'land' }), 'Merge this copy back and remove it (asks first)'),
      button('Discard', 'jc-btn small danger', () => send({ type: 'code_copy', slug: ws.slug, action: 'discard' }), 'Throw this copy away, kept 30 days (asks first)'));
    return strip;
  }

  function commentsBar(task) {
    const list = comments(task);
    if (!list.length) return null;
    const bar = el('div', 'jcx-sendbar');
    bar.append(el('span', '', `${list.length} comment${list.length === 1 ? '' : 's'}`), el('span', 'jc-spacer'),
      button('Clear', 'jc-btn small', () => { store.comments.set(task.id, []); render(); }),
      button('Send to the session', 'jc-btn small filled', () => {
        send({ type: 'task_send', id: task.id, text: commentMessage(list) });
        store.comments.set(task.id, []);
        render();
      }));
    return bar;
  }

  // All the comments as one message: "Review comments:" then file:line — comment, with the
  // line itself so there's no doubt which.
  function commentMessage(list) {
    const lines = list.map((c) => {
      const where = c.side === 'o' ? `${c.path} (removed line ${c.line})` : `${c.path}:${c.line}`;
      const quote = c.excerpt ? ` (\`${c.excerpt.replace(/`/g, "'")}\`)` : '';
      return `- ${where}${quote} — ${c.text}`;
    });
    return `Review comments:\n${lines.join('\n')}`;
  }

  // ── the pane ──

  function render() {
    if (!showing()) return;
    draw(body, F.currentTask());
  }

  // The comment being written keeps the keyboard, its caret at the end, as soon as it's drawn.
  function focusEditor(target) {
    const box = target.querySelector('.jcx-comment.edit textarea');
    if (!box || document.activeElement === box) return;
    box.focus();
    box.selectionStart = box.selectionEnd = box.value.length;
  }

  function draw(target, task) {
    body = target;
    const wrap = el('div', 'jcx-changes');
    wrap.classList.toggle('split', mode === 'split');
    if (!task) {
      wrap.append(el('p', 'jc-empty', 'Open a session to see its changes.'));
      target.replaceChildren(wrap);
      return;
    }
    const view = viewOf(task);
    const data = store.data.get(keyOf(task));
    const bar = el('div', 'jcx-bar');
    const seg = el('div', 'jcx-seg');
    seg.setAttribute('role', 'tablist');
    for (const [id, label] of VIEWS) {
      const b = button(label, `jcx-seg-btn${id === view ? ' on' : ''}`, () => {
        store.views.set(task.id, id);
        editing = null;
        render();
        request(task);
      });
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(id === view));
      seg.append(b);
    }
    bar.append(seg, el('span', 'jc-spacer'),
      button(mode === 'split' ? 'Unified' : 'Side by side', 'jc-mini', () => {
        mode = mode === 'split' ? 'unified' : 'split';
        try { localStorage.setItem('jcx-diff-mode', mode); } catch (_) { /* no storage */ }
        render();
      }, 'Show the old and new lines one under the other, or side by side'),
      refreshButton(() => request(task)));
    wrap.append(bar);
    if (data) {
      const strip = isolatedStrip(task, data);
      if (strip) wrap.append(strip);
      if (data.conflicts && data.conflicts.length && (data.workspace || {}).slug) {
        const box = el('div', 'jcx-conflicts');
        box.append(el('span', '', `Landing hit conflicts in ${data.conflicts.slice(0, 5).join(', ')}.`),
          button('Resolve in session', 'jc-btn small', () => send({ type: 'code_copy', slug: data.workspace.slug, action: 'resolve' })));
        wrap.append(box);
      }
    }
    const sendBar = commentsBar(task);
    if (sendBar) wrap.append(sendBar);
    for (const ext of extensions) {
      if (!ext.top) continue;
      try { const part = ext.top(task, data); if (part) wrap.append(part); } catch (err) { console.error('changes extension', err); }
    }
    if (!data) {
      wrap.append(el('p', 'jc-empty', 'Loading the changes…'));
      target.replaceChildren(wrap);
      $extra(null);
      return;
    }
    if (!data.git) {
      wrap.append(el('p', 'jc-empty', data.gone ? 'This session’s isolated copy was landed or discarded.' : 'This folder isn’t a git repository, so its changes can’t be shown line by line.'));
      if (data.touched && data.touched.length) {
        const ul = el('ul', 'jc-list');
        const root = task.path || '';
        ul.append(...data.touched.map((p) => { const li = el('li'); const s = el('span', '', root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p); s.dataset.noI18n = ''; li.append(s); return li; }));
        wrap.append(el('p', 'jc-dim', 'Files it changed:'), ul);
      }
      target.replaceChildren(wrap);
      $extra(null);
      return;
    }
    const files = data.files || [];
    if (!files.length) {
      const note = el('p', 'jc-empty', {
        turn: 'Nothing changed in its latest turn.',
        session: (data.workspace || {}).branch ? 'Nothing changed in this copy yet.' : 'Nothing from this session yet: its own edits show here.',
        branch: 'No changes on this branch.',
      }[view]);
      wrap.append(note);
      if (view !== 'branch') wrap.append(button('Show the whole branch', 'jc-btn small jcx-center', () => { store.views.set(task.id, 'branch'); render(); request(task); }));
    } else {
      const openSet = store.opened.get(keyOf(task)) || new Map();
      store.opened.set(keyOf(task), openSet);
      const list = el('div', 'jcx-files');
      list.append(...files.map((f, i) => fileBlock(task, f, i, view, openSet)));
      wrap.append(list);
      if (data.truncated) wrap.append(el('p', 'jcx-cut', `Showing ${files.length} of ${data.totals.files} files.`));
    }
    target.replaceChildren(wrap);
    focusEditor(target);
    $extra(data.totals);
  }

  function $extra(totals) {
    const extra = document.getElementById('jc-pane-extra');
    if (!extra) return;
    if (!totals || !totals.files) { extra.replaceChildren(); return; }
    const s = el('span', 'jc-dim');
    s.append(el('span', 'jc-plus', `+${totals.added}`), document.createTextNode(' '), el('span', 'jc-minus', `−${totals.removed}`));
    extra.replaceChildren(s);
  }

  F.registerPane('diff', {
    title: 'Changes',
    render(target, task) {
      draw(target, task);
      // (The pane is drawn again when other things change: its view is asked for at most
      // every couple of seconds from here; Refresh and a finished turn ask at once.)
      if (task && Date.now() - (asked.get(keyOf(task)) || 0) > 2000) request(task);
    },
  });

  // ── events ──

  F.on('code_changes', (ev) => {
    const task = F.currentTask();
    if (ev.path && ev.file) {  // one file's lines, for a file the view had listed only
      const data = store.data.get(`${ev.id}:${ev.view}`);
      if (data) data.files = data.files.map((f) => (f.path === ev.path ? ev.file : f));
    } else {
      store.data.set(`${ev.id}:${ev.view}`, ev);
      const kept = store.kept.get(ev.id) || new Set();  // the hub's word, with code_kept's
      for (const f of ev.files || []) for (const h of f.hunks || []) if (h.kept) kept.add(h.id);
      store.kept.set(ev.id, kept);
    }
    if (task && task.id === ev.id) render();
  });
  F.on('code_kept', (ev) => {
    store.kept.set(ev.id, new Set(ev.kept || []));
    const task = F.currentTask();
    if (task && task.id === ev.id) render();
  });
  F.on('code_lines', (ev) => {
    store.extra.set(`${ev.id}:${ev.path}:${ev.start}`, ev.lines || []);
    render();
  });
  // A turn that ended, or an edit that finished, in the session on screen: look again.
  F.on('task_finished', (ev) => { const task = F.currentTask(); if (task && ev.id === task.id) refreshSoon(); });
  F.on('task_log_update', (ev) => { const task = F.currentTask(); if (task && ev.id === task.id && ev.status === 'done') refreshSoon(); });

  window.JarvisChanges = {
    commentMessage, store, render, request,
    extend(ext) { extensions.push(ext); render(); },
  };
})();
