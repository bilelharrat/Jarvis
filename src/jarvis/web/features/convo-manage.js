// Rename, pin and delete in Conversations' list of past conversations, as the Claude, ChatGPT
// and Gemini apps have them (features/conversation_manage.py does the work): a ⋯ button on
// each row opens Rename, Pin or Unpin, and Delete (asked first; never the conversation going
// on now). Pinned ones come first, with a pin. The list conversation.js draws is decorated
// each time it's drawn; after a change the list is asked for again with the same search.
// order is exported for node --test (tests/web/convo-manage.test.mjs).
(function (root) {
  'use strict';

  // The rows' session ids with the pinned ones first, each group in the order it came.
  function order(ids, pins) {
    const pinned = new Set(pins || []);
    return [...ids.filter((id) => pinned.has(id)), ...ids.filter((id) => !pinned.has(id))];
  }

  if (typeof module === 'object' && module.exports) { module.exports = { order }; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const t = (s) => F.t(s);
  let pins = [];
  let last = { q: '', seq: '' };
  let menu = null;

  function relist() {
    F.send({ type: 'conversation_list', q: last.q, seq: last.seq });
  }

  function closeMenu() {
    if (menu) { menu.remove(); menu = null; }
  }

  function item(label, run, danger) {
    const b = F.el('button', `cm-item${danger ? ' danger' : ''}`, t(label));
    b.type = 'button';
    b.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); run(); });
    return b;
  }

  function rename(li, sid) {
    const title = li.querySelector('.convo-row-title');
    if (!title) return;
    const input = F.el('input', 'cm-rename');
    input.type = 'text';
    input.maxLength = 120;
    input.value = title.textContent === '…' ? '' : title.textContent;
    input.setAttribute('aria-label', t('Rename'));
    const done = (save) => {
      const name = input.value.trim();
      input.replaceWith(title);
      if (save && name && name !== title.textContent) {
        title.textContent = name;
        F.send({ type: 'conversation_rename', session_id: sid, title: name });
      }
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
    });
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('blur', () => done(true));
    title.replaceWith(input);
    input.focus();
    input.select();
  }

  function openMenu(btn, li, sid, current) {
    closeMenu();
    menu = F.el('div', 'cm-menu');
    menu.setAttribute('role', 'menu');
    const pinned = pins.includes(sid);
    menu.append(
      item('Rename', () => rename(li, sid)),
      item(pinned ? 'Unpin' : 'Pin', () => F.send({ type: 'conversation_pin', session_id: sid, pinned: !pinned })),
      item('Export as Markdown', () => F.send({ type: 'conversation_export', session_id: sid })),
    );
    if (!current) {
      menu.append(item('Delete', () => {
        if (root.confirm(t('Delete this conversation for good?'))) F.send({ type: 'conversation_delete', session_id: sid });
      }, true));
    }
    // Fixed to the window, beside the button: the list's scrolling box never clips it.
    document.body.append(menu);
    const at = btn.getBoundingClientRect();
    const height = menu.offsetHeight;
    const below = at.bottom + 4 + height <= root.innerHeight;
    menu.style.top = `${below ? at.bottom + 4 : Math.max(8, at.top - 4 - height)}px`;
    menu.style.left = `${Math.max(8, at.right - menu.offsetWidth)}px`;
  }

  function decorate() {
    const list = F.$('convo-list');
    if (!list) return;
    const rows = [...list.children].filter((li) => li.querySelector('.convo-row'));
    const byId = new Map(rows.map((li) => [li.querySelector('.convo-row').dataset.session, li]));
    const wanted = order([...byId.keys()], pins);
    const now = [...byId.keys()];
    if (wanted.join() !== now.join()) {
      for (const id of wanted) list.append(byId.get(id));
      return; // the move calls this again, through the observer
    }
    for (const [sid, li] of byId) {
      li.classList.add('cm-row');
      li.classList.toggle('cm-pinned', pins.includes(sid));
      if (li.querySelector('.cm-more')) continue;
      const current = Boolean(li.querySelector('.convo-now-tag'));
      const more = F.el('button', 'cm-more', '⋯');
      more.type = 'button';
      more.title = t('More');
      more.setAttribute('aria-label', t('More'));
      more.addEventListener('click', (e) => { e.stopPropagation(); menu ? closeMenu() : openMenu(more, li, sid, current); });
      li.append(more);
    }
  }

  function watch() {
    const list = F.$('convo-list');
    if (!list || list.dataset.cmWatched) return;
    list.dataset.cmWatched = '1';
    new MutationObserver(decorate).observe(list, { childList: true });
    decorate();
  }

  F.on('conversation_marks', (ev) => { pins = Array.isArray(ev.pins) ? ev.pins : []; decorate(); relist(); });
  F.on('conversation_list', (ev) => { last = { q: ev.q || '', seq: String(ev.seq || '') }; setTimeout(() => { watch(); decorate(); }); });
  F.on('hello', () => F.send({ type: 'conversation_marks' }), { replay: true });
  document.addEventListener('click', closeMenu);
})(typeof window !== 'undefined' ? window : globalThis);
