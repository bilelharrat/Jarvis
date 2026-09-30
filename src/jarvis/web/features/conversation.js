// JARVIS's own conversation (the conversation feature, jarvis.features.conversation):
// Settings › Conversation; the note under the reply when a conversation carries on (after a
// restart, or one reopened); and Conversations (a dock app): this conversation, and the past
// ones, searched, read back and carried on after a card. What the conversations hold (titles,
// what was said) is the owner's data: shown as text, with data-no-i18n.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, $, send } = F;
  const T = (text) => F.t(text);

  const S = {
    convo: { resume: true, resumed: null, session_id: '', title: '', cost: 0 },
    features: {},
    list: null, // the past conversations shown ({ q, items }), once asked for
    seq: 0, // the newest search sent: an older answer never replaces a newer one
    reading: null, // the past conversation open read-only ({ session_id, title, at, cost, entries })
    searchTimer: 0,
  };

  function mine(node) {
    node.setAttribute('data-no-i18n', '');
    return node;
  }

  function button(label, cls, run) {
    const b = el('button', cls || 'btn', label);
    b.type = 'button';
    if (run) b.addEventListener('click', run);
    return b;
  }

  function switchRow(id, title, note, onClick) {
    const row = el('div', 'row');
    const words = el('span');
    words.append(el('strong', '', title));
    if (note) words.append(el('small', '', note));
    const sw = el('button', 'switch');
    sw.type = 'button';
    sw.id = id;
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', 'false');
    sw.setAttribute('aria-label', title);
    sw.addEventListener('click', onClick);
    row.append(words, sw);
    return row;
  }

  function featurePref(key, fallback) {
    return key in S.features ? S.features[key] : fallback;
  }

  function locale() { return window.jarvisI18n && window.jarvisI18n.lang() === 'zh' ? 'zh-CN' : undefined; }

  // When a past conversation was last spoken in: the time today, "Yesterday", else the date.
  function whenText(ms) {
    const d = new Date(ms);
    if (!ms || Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
    if (days === 0) return d.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
    if (days === 1) return T('Yesterday');
    const opts = { weekday: 'short', day: 'numeric', month: 'short' };
    if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(locale(), opts);
  }

  function costText(usd) {
    return usd >= 0.01 ? `$${usd.toFixed(2)}` : '';
  }

  // ── Settings › Conversation ──

  function settingsGroup() {
    if ($('convo-group')) return $('convo-group');
    const settings = $('settings');
    if (!settings) return null;
    const group = el('section', 'group convo-group');
    group.id = 'convo-group';
    group.append(el('h3', '', 'Conversation'));
    group.append(switchRow('sw-convo-resume', 'Carry on after a restart',
      'When Jarvis starts again, pick up the conversation where it was. New conversation still starts afresh.',
      () => send({ type: 'feature_prefs', changes: { conversation_resume: !featurePref('conversation_resume', true) } })));
    const actions = el('div', 'row-actions');
    actions.append(button('Past conversations…', 'btn', () => { if (typeof toggleSettings === 'function') toggleSettings(false); openSheet(); }));
    group.append(actions);
    const before = $('open-accounts') && $('open-accounts').closest('section.group');
    if (before) before.before(group); else settings.append(group);
    return group;
  }

  function renderSettings() {
    if (!settingsGroup()) return;
    $('sw-convo-resume').setAttribute('aria-checked', String(!!featurePref('conversation_resume', true)));
  }

  // ── the note under the reply: a conversation carried on ──

  function caption() {
    let note = $('convo-note');
    if (note) return note;
    const reply = $('reply');
    if (!reply) return null;
    note = el('div', 'convo-note');
    note.id = 'convo-note';
    note.hidden = true;
    const words = el('span', 'convo-note-text');
    words.append(el('span', '', 'Carrying on from earlier'));
    const title = mine(el('span', 'convo-note-title'));
    title.id = 'convo-note-title';
    words.append(title);
    note.append(words, button('New conversation', 'convo-note-btn', () => {
      send({ type: 'reset' });
      note.hidden = true;
    }));
    reply.after(note);
    return note;
  }

  function renderCaption() {
    const note = caption();
    if (!note) return;
    const resumed = S.convo.resumed;
    note.hidden = !resumed;
    $('convo-note-title').textContent = resumed && resumed.title ? `“${resumed.title}”` : '';
  }

  // ── Conversations: a dock app and its sheet ──

  function dockButton() {
    if ($('convo-btn')) return $('convo-btn');
    const after = $('activity-btn');
    if (!after) return null;
    const b = el('button', 'pill dock-app');
    b.id = 'convo-btn';
    b.type = 'button';
    b.dataset.app = 'conversations';
    b.setAttribute('aria-label', 'Conversations');
    b.setAttribute('aria-expanded', 'false');
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5h11a2 2 0 012 2v6a2 2 0 01-2 2H9l-4 3v-3H4a2 2 0 01-2-2v-6a2 2 0 012-2z"/><path d="M17 9.5h3a2 2 0 012 2v5a2 2 0 01-2 2h-1v2.5L15.5 18.5H11"/></svg>';
    const name = el('span', 'app-name', 'Conversations');
    const badge = el('span', 'app-badge');
    badge.id = 'convo-badge';
    b.append(badge, name);
    b.addEventListener('click', () => (sheetOpen() ? closeSheet() : openSheet()));
    after.after(b);
    return b;
  }

  let returnFocus = null;

  function sheet() {
    if ($('convo-layer')) return $('convo-layer');
    const layer = el('div', 'convo-layer');
    layer.id = 'convo-layer';
    layer.hidden = true;
    const scrim = el('div', 'convo-scrim');
    scrim.addEventListener('click', () => closeSheet());
    const pop = el('section', 'convo-pop');
    pop.id = 'convo-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-modal', 'true');
    pop.setAttribute('aria-labelledby', 'convo-title');
    const head = el('header', 'convo-head');
    const back = button('‹ Past conversations', 'convo-back', () => { S.reading = null; renderSheet(); });
    back.id = 'convo-back';
    const title = el('h2', '', 'Conversations');
    title.id = 'convo-title';
    const close = el('button', 'convo-close');
    close.type = 'button';
    close.id = 'convo-close';
    close.setAttribute('aria-label', 'Close conversations');
    close.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    close.addEventListener('click', () => closeSheet());
    head.append(back, title, close);
    const body = el('div', 'convo-body');
    body.id = 'convo-body';
    pop.append(head, body);
    pop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); if (S.reading) { S.reading = null; renderSheet(); } else closeSheet(); }
    });
    layer.append(scrim, pop);
    document.body.append(layer);
    return layer;
  }

  function sheetOpen() { const l = $('convo-layer'); return Boolean(l && !l.hidden); }

  function openSheet() {
    const layer = sheet();
    if (!sheetOpen()) returnFocus = document.activeElement;
    layer.hidden = false;
    S.reading = null;
    $('convo-btn') && $('convo-btn').setAttribute('aria-expanded', 'true');
    renderSheet();
    search(S.list ? S.list.q : '');
    const box = $('convo-search');
    if (box) box.focus({ preventScroll: true });
  }

  function closeSheet() {
    const layer = $('convo-layer');
    if (!layer || layer.hidden) return;
    layer.hidden = true;
    $('convo-btn') && $('convo-btn').setAttribute('aria-expanded', 'false');
    const back = returnFocus;
    returnFocus = null;
    if (back && document.contains(back) && typeof back.focus === 'function') back.focus({ preventScroll: true });
  }

  function search(q) {
    S.seq += 1;
    send({ type: 'conversation_list', q, seq: String(S.seq) });
  }

  function currentBlock() {
    const box = el('div', 'convo-now');
    box.append(el('div', 'convo-kicker', 'This conversation'));
    const c = S.convo;
    const title = mine(el('div', 'convo-now-title', c.title ? `“${c.title}”` : ''));
    if (!c.title) { title.removeAttribute('data-no-i18n'); title.textContent = c.session_id ? 'Untitled' : 'Nothing said yet'; }
    box.append(title);
    const cost = costText(c.cost || 0);
    if (cost) box.append(mine(el('div', 'convo-now-meta', cost)));
    const actions = el('div', 'convo-actions');
    actions.append(button('New conversation', 'btn', () => { send({ type: 'reset' }); closeSheet(); }));
    box.append(actions);
    return box;
  }

  function listBlock() {
    const box = el('div', 'convo-past');
    box.append(el('div', 'convo-kicker', 'Past conversations'));
    const field = el('input', 'convo-search');
    field.id = 'convo-search';
    field.type = 'search';
    field.placeholder = 'Search past conversations';
    field.setAttribute('aria-label', 'Search past conversations');
    field.value = S.list ? S.list.q : '';
    field.addEventListener('input', () => {
      clearTimeout(S.searchTimer);
      S.searchTimer = setTimeout(() => search(field.value.trim()), 250);
    });
    box.append(field);
    const list = el('ul', 'convo-list');
    list.id = 'convo-list';
    box.append(list);
    const empty = el('p', 'convo-empty');
    empty.id = 'convo-empty';
    box.append(empty);
    return box;
  }

  function renderList() {
    const list = $('convo-list');
    if (!list) return;
    const items = S.list ? S.list.items : [];
    list.replaceChildren(...items.map((item) => {
      const li = el('li');
      const row = el('button', 'convo-row');
      row.type = 'button';
      row.dataset.session = item.session_id;
      const top = el('span', 'convo-row-top');
      top.append(mine(el('span', 'convo-row-title', item.title || '…')));
      const side = el('span', 'convo-row-when');
      side.append(mine(el('span', '', whenText(item.at))));
      if (item.current) side.append(el('span', 'convo-now-tag', 'Now'));
      top.append(side);
      row.append(top);
      if (item.preview && item.preview !== item.title) row.append(mine(el('span', 'convo-row-preview', item.preview)));
      row.addEventListener('click', () => openPast(item));
      li.append(row);
      return li;
    }));
    const empty = $('convo-empty');
    empty.hidden = !S.list || items.length > 0;
    empty.textContent = S.list && S.list.q ? 'No past conversation matches.' : 'No past conversations yet.';
  }

  function openPast(item) {
    S.reading = { ...item, entries: null };
    renderSheet();
    send({ type: 'conversation_open', session_id: item.session_id });
  }

  function readingBlock() {
    const r = S.reading;
    const box = el('div', 'convo-read');
    box.append(mine(el('h3', 'convo-read-title', r.title || '…')));
    const meta = [whenText(r.at), costText(r.cost || 0)].filter(Boolean).join(' · ');
    if (meta) box.append(mine(el('div', 'convo-now-meta', meta)));
    const actions = el('div', 'convo-actions');
    if (r.current) actions.append(el('span', 'convo-now-tag', 'This is the conversation you’re in'));
    else {
      const go = button('Carry on this conversation', 'btn primary', () => {
        send({ type: 'conversation_resume', session_id: r.session_id });
        closeSheet();
      });
      go.id = 'convo-resume';
      actions.append(go);
    }
    box.append(actions);
    const lines = el('ol', 'convo-lines');
    lines.id = 'convo-lines';
    if (r.entries === null) lines.append(el('li', 'convo-wait', 'Reading…'));
    else if (r.error) lines.append(el('li', 'convo-wait', 'This conversation can’t be read.'));
    else {
      lines.append(...r.entries.map((e) => {
        const li = mine(el('li', e.role === 'user' ? 'user' : 'assistant'));
        li.textContent = e.text;
        return li;
      }));
    }
    box.append(lines);
    return box;
  }

  function renderSheet() {
    if (!sheetOpen()) return;
    const body = $('convo-body');
    const reading = Boolean(S.reading);
    $('convo-back').hidden = !reading;
    $('convo-title').hidden = reading;
    const focused = document.activeElement && document.activeElement.id === 'convo-search';
    if (reading) body.replaceChildren(readingBlock());
    else {
      body.replaceChildren(currentBlock(), listBlock());
      renderList();
      if (focused) $('convo-search').focus({ preventScroll: true });
    }
  }

  // ── events ──

  F.on('conversation', (ev) => {
    S.convo = { ...S.convo, ...ev };
    renderCaption();
    if (sheetOpen() && !S.reading) {
      const box = document.querySelector('#convo-body .convo-now');
      if (box) box.replaceWith(currentBlock());
    }
  }, { replay: true });
  F.on('conversation_list', (ev) => {
    if (String(ev.seq || '') !== String(S.seq) && S.list) return; // an older search
    S.list = { q: ev.q || '', items: ev.items || [] };
    renderList();
  });
  F.on('conversation_transcript', (ev) => {
    if (!S.reading || S.reading.session_id !== ev.session_id) return;
    S.reading = { ...S.reading, entries: ev.entries || [], error: ev.error || '', current: !!ev.current };
    renderSheet();
    const lines = $('convo-lines');
    if (lines) lines.scrollTop = lines.scrollHeight;
  });
  F.on('prefs', (ev) => {
    S.features = ev.features || {};
    renderSettings();
  }, { replay: true });
  F.on('hello', () => send({ type: 'conversation_state' }), { replay: true });
  F.on('turn', (ev) => { if (ev.user && S.convo.resumed) { S.convo.resumed = null; renderCaption(); } });

  dockButton();
  renderSettings();
  renderCaption();
})();
