// Eden Code's "Needs attention" inbox (features/code_attention.py): one list of everything
// waiting on the owner across every session — approval cards, sessions waiting for a reply,
// failed sessions, Exterminator Mode and other runs that stopped, the queue's failed cards,
// pull requests still failing, hand-offs waiting, pairing conflicts, high-risk guesses a
// session made instead of asking (code-assumptions.js: Keep or Undo) — each with its own way
// in: an approval's answers right there (the window's own answerApproval, so Touch ID and
// the settle time still apply), and Open for the session and the pane that has its buttons.
//
// The sidebar's foot has its button with the count; ⌘⇧A opens it (the browser's tab search
// keeps ⌘⇧A while the browser is on show); the Dock's badge is this count (it takes over the
// agent board's: app/features/code-sessions.js). For a screen reader (Daredevil): the inbox
// is a dialog with a list, one item a line; each change of the count is said in a polite
// live region of its own ("3 things are waiting for you: …", the backend's summary, in the
// owner's language). A session's reply counts until it's been seen: as the sidebar's unread
// dot goes (web/features/code-sessions.js), this tells the backend (code_attention_seen).
// Its pure logic is exported for node's tests (tests/web/code-attention.test.mjs).
(function codeAttention(root) {
  'use strict';

  // The items' kinds, as the inbox names them beside each item.
  const KINDS = {
    approval: 'Approval',
    reply: 'Waiting for your reply',
    failed: 'Failed',
    exterminator: 'Exterminator Mode',
    run: 'Without you',
    queue: 'Queue',
    pr: 'Pull request',
    handoff: 'Another machine',
    conflict: 'Pairing conflict',
    assumption: 'Assumption',
  };

  // The buttons an item has: an approval's answers (never "no", which wants a reason: Open
  // has it, as on the agent board), then Open.
  function actionsOf(item) {
    const out = [];
    if (item && item.kind === 'approval') {
      for (const c of (item.choices || []).slice(0, 3)) {
        if (!c || !c.id || c.id === 'deny' || c.id === 'plan_keep') continue;
        out.push({ label: c.label || c.id, choice: c.id });
      }
    }
    if (item && item.kind === 'assumption' && item.assumption) {
      out.push({ label: 'Keep', choice: 'keep', command: { type: 'code_assume_keep', id: item.assumption } });
      out.push({ label: 'Undo', choice: 'undo', command: { type: 'code_assume_undo', id: item.assumption } });
    }
    out.push({ label: 'Open', open: true });
    return out;
  }

  // The sessions whose reply the owner has seen: a reply item for a session that isn't
  // unread (any more) in the sidebar.
  function seenNow(items, unread) {
    return (items || []).filter((i) => i && i.kind === 'reply' && i.task && !unread.has(i.task)).map((i) => i.task);
  }

  // What the live region says when the count goes from before to now ('' when it says
  // nothing: the same count, or the first count after a window opens).
  function liveLine(before, now, summary) {
    if (before === null || before === now) return '';
    return String(summary || (now ? `${now} things are waiting for you.` : 'Nothing is waiting for you.'));
  }

  // The button's words for a screen reader.
  function buttonLabel(n) {
    return n ? `Needs attention: ${n} waiting` : 'Needs attention: nothing waiting';
  }

  // ⌘⇧A (with no other key), unless the browser on show has it for its tab search.
  function isShortcut(e, browserShown) {
    return !!e && e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && String(e.key).toLowerCase() === 'a' && !browserShown;
  }

  const api = { KINDS, actionsOf, seenNow, liveLine, buttonLabel, isShortcut };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  const F = root.jarvisFeatures;
  if (!F || typeof document === 'undefined' || !document.getElementById('cc')) return;

  const t = (text) => F.t(text);
  const A = { items: [], count: null, summary: '', open: false, sentSeen: '' };
  F.codeAttention = { badges: true, state: A, open: () => open(), close: () => close() };

  // ── the sidebar's button ──

  const btn = el('button', 'jc-icon cs-foot-btn ca-btn');
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');
  btn.title = 'Needs attention (⌘⇧A)';
  btn.insertAdjacentHTML('beforeend', '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M2 9.5l1.6-6A1.4 1.4 0 0 1 5 2.5h6a1.4 1.4 0 0 1 1.4 1l1.6 6"/><path d="M2 9.5h3.4l.9 1.8h3.4l.9-1.8H14V12a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12z"/></svg>');
  const count = el('span', 'ca-count');
  count.hidden = true;
  count.setAttribute('aria-hidden', 'true');
  btn.append(count);
  btn.addEventListener('click', () => (A.open ? close() : open()));
  const foot = $('jc-side') && $('jc-side').querySelector('.jc-side-foot');
  if (foot) foot.append(btn);
  F.registerMoreItem({ label: 'Needs attention', note: 'Everything waiting for you', run: () => open() });

  const live = el('p', 'sr-only');
  live.id = 'ca-live';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  $('cc').append(live);
  let liveTimer = 0;
  function say(text) {
    if (!text) return;
    live.textContent = '';  // (emptied first: the same words twice are read the second time too)
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { live.textContent = text; }, 60);
  }

  // ── the inbox ──

  const panel = el('section', 'ca-inbox glass-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Needs attention');
  panel.hidden = true;
  const head = el('div', 'ca-head');
  const titles = el('div', 'ca-titles');
  const heading = el('h2', 'ca-title', 'Needs attention');
  heading.id = 'ca-title';
  panel.setAttribute('aria-labelledby', 'ca-title');
  const sub = el('p', 'ca-sub');
  sub.dataset.noI18n = '';  // (the backend's sentence, in the owner's language already)
  titles.append(heading, sub);
  const shut = el('button', 'jc-icon ca-close', '×');
  shut.type = 'button';
  shut.setAttribute('aria-label', 'Close');
  shut.title = 'Close (Esc)';
  shut.addEventListener('click', () => close());
  head.append(titles, shut);
  const list = el('ul', 'ca-list');
  list.setAttribute('aria-label', 'Waiting for you');
  const empty = el('p', 'ca-empty', 'Nothing is waiting for you.');
  panel.append(head, list, empty);
  $('cc').append(panel);

  function open() {
    if ($('cc').hidden && typeof toggleCC === 'function') toggleCC(true);
    A.open = true;
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    F.send({ type: 'code_attention' });
    draw();
    const first = list.querySelector('button');
    (first || shut).focus();
  }
  function close() {
    const had = panel.contains(document.activeElement);
    A.open = false;
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (had) btn.focus();
  }

  function go(item) {
    close();
    if (item.task) F.selectTask(item.task);
    if (item.pane === 'board') { if (F.codeBoard) F.codeBoard.open(); return; }
    if (item.pane) {
      if ($('cc').hidden && typeof toggleCC === 'function') toggleCC(true);
      F.openPane(item.pane);
    }
  }

  function answer(item, choice) {
    const a = typeof pendingApprovals !== 'undefined' ? pendingApprovals.get(item.approval) : null;
    if (!a) { go(item); return; }
    F.answerApproval(a, choice);
  }

  let drawn = '';
  function draw() {
    sub.textContent = A.summary || '';
    const key = JSON.stringify([A.items.map((i) => [i.key, i.said, i.text, i.choices]), A.open]);
    if (key === drawn) return;
    drawn = key;
    empty.hidden = A.items.length > 0;
    const had = panel.contains(document.activeElement) ? document.activeElement.dataset.ca : '';
    list.replaceChildren(...A.items.map((item) => {
      const li = el('li', `ca-item ca-${item.kind}`);
      const top = el('p', 'ca-item-top');
      top.append(el('span', `jc-dot ${item.kind === 'approval' ? 'needs' : item.kind === 'reply' ? 'waiting' : 'failed'}`),
        el('span', 'ca-kind', KINDS[item.kind] || item.kind));
      if (item.project) { const p = el('span', 'ca-project', item.project); p.dataset.noI18n = ''; top.append(p); }
      const said = el('p', 'ca-said', item.said || item.text || '');
      said.dataset.noI18n = '';
      li.append(top, said);
      if (item.kind === 'approval' && item.text && item.text !== item.said) {
        const more = el('p', 'ca-detail', item.text);
        more.dataset.noI18n = '';
        li.append(more);
      }
      const acts = el('div', 'ca-acts');
      for (const action of actionsOf(item)) {
        const b = el('button', `jc-btn small ${action.open ? 'tinted' : 'filled'}`, action.label);
        if (!action.open && !action.command) b.dataset.noI18n = '';  // (the card's own words)
        b.type = 'button';
        b.dataset.ca = `${item.key}:${action.open ? 'open' : action.choice}`;
        b.setAttribute('aria-label', `${t(action.label)}: ${item.said || item.text || ''}`);
        b.addEventListener('click', () => (action.open ? go(item) : action.command ? F.send(action.command) : answer(item, action.choice)));
        acts.append(b);
      }
      li.append(acts);
      return li;
    }));
    if (had) {
      const back = list.querySelector(`[data-ca="${CSS.escape(had)}"]`);
      (back || list.querySelector('button') || shut).focus();
    }
  }

  function setCount(n) {
    count.hidden = !n;
    count.textContent = n > 99 ? '99+' : String(n || '');
    btn.setAttribute('aria-label', t(buttonLabel(n)));
    btn.classList.toggle('ca-has', n > 0);
    if (typeof app !== 'undefined' && app && app.feature) app.feature.send('feature:code-sessions:badge', n);
  }

  function tellSeen() {
    const S = F.codeSessions;
    if (!S || !S.unread) return;
    const ids = seenNow(A.items, S.unread);
    const key = ids.join(',');
    if (!ids.length || key === A.sentSeen) return;
    A.sentSeen = key;
    F.send({ type: 'code_attention_seen', ids });
  }

  F.on('code_attention', (ev) => {
    A.items = Array.isArray(ev.items) ? ev.items : [];
    A.summary = ev.summary || '';
    const n = Number(ev.count) || A.items.length;
    const line = liveLine(A.count, n, A.summary);
    A.count = n;
    setCount(n);
    say(line);
    if (A.open) draw();
    tellSeen();
  }, { replay: true });
  F.on('hello', () => { A.sentSeen = ''; F.send({ type: 'code_attention' }); }, { replay: true });
  for (const type of ['approval', 'approval_resolved']) F.on(type, () => { if (A.open) { drawn = ''; draw(); } });
  F.on('jc_select', () => setTimeout(tellSeen, 0));

  document.addEventListener('keydown', (e) => {
    if ($('cc').hidden) return;
    const browser = $('browser');
    if (isShortcut(e, !!browser && !browser.hidden)) { e.preventDefault(); if (A.open) close(); else open(); return; }
    if (e.key === 'Escape' && A.open && panel.contains(document.activeElement)) { e.preventDefault(); e.stopPropagation(); close(); }
  }, true);
  setCount(0);
})(typeof window === 'object' ? window : globalThis);
