// JARVIS's own conversation (the conversation feature, jarvis.features.conversation):
// Settings › Conversation; the note under the reply when a conversation carries on (after a
// restart, or one reopened); and Conversations (a dock app): this conversation (how full its
// context is, what it has cost, Compact now), and the past ones, searched, read back and
// carried on after a card; and incognito (a banner at the top while nothing is kept, with
// Leave; the switch in Conversations and Settings). What the conversations hold (titles,
// what was said) is the owner's data: shown as text, with data-no-i18n.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, $, send } = F;
  const T = (text) => F.t(text);

  const S = {
    convo: { resume: true, resumed: null, session_id: '', title: '', cost: 0, incognito: false },
    features: {},
    list: null, // the past conversations shown ({ q, items }), once asked for
    seq: 0, // the newest search sent: an older answer never replaces a newer one
    reading: null, // the past conversation open read-only ({ session_id, title, at, cost, entries })
    searchTimer: 0,
    context: null, // how full this conversation is, as the hub last said ({ percent, tokens, … })
  };
  const CX = 6; // the context bar's colours (conversation.css: --convo-cx-1 … 6)

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

  function tokenText(n) {
    if (!n) return '0';
    if (n >= 1e6) return `${+(n / 1e6).toFixed(n % 1e6 ? 2 : 0)}M`;
    if (n >= 1e3) return `${+(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`;
    return String(n);
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
    group.append(thinkingRow());
    const actions = el('div', 'row-actions');
    actions.append(button('Past conversations…', 'btn', () => { if (typeof toggleSettings === 'function') toggleSettings(false); openSheet(); }));
    const secret = button('Start an incognito conversation', 'btn', () => {
      if (typeof toggleSettings === 'function') toggleSettings(false);
      incognito(!S.convo.incognito);
    });
    secret.id = 'convo-settings-incognito';
    actions.append(secret);
    group.append(actions);
    const before = $('open-accounts') && $('open-accounts').closest('section.group');
    if (before) before.before(group); else settings.append(group);
    return group;
  }

  // How much Jarvis thinks before an everyday answer (a request can still ask to think hard).
  function thinkingRow() {
    const row = el('label', 'row');
    row.htmlFor = 'convo-thinking';
    const words = el('span');
    words.append(el('strong', '', 'Think before answering'),
      el('small', '', 'Off answers fastest. Say “think hard about…” or “take your time” to have one request thought through.'));
    const select = el('select');
    select.id = 'convo-thinking';
    [['off', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']].forEach(([value, label]) => {
      const option = el('option', '', label);
      option.value = value;
      select.append(option);
    });
    select.addEventListener('change', () => send({ type: 'conversation_thinking', level: select.value }));
    row.append(words, select);
    return row;
  }

  function renderSettings() {
    if (!settingsGroup()) return;
    const secret = $('convo-settings-incognito');
    if (secret) secret.textContent = S.convo.incognito ? 'Leave incognito' : 'Start an incognito conversation';
    $('sw-convo-resume').setAttribute('aria-checked', String(!!featurePref('conversation_resume', true)));
    const select = $('convo-thinking');
    if (select && document.activeElement !== select) select.value = featurePref('conversation_thinking', 'off');
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

  // ── incognito: a banner at the top while nothing is kept ──

  function incognito(on) {
    send({ type: 'conversation_incognito', on });
  }

  function renderIncognito() {
    let banner = $('convo-incognito');
    if (!banner) {
      const greeting = $('greeting');
      if (!greeting) return;
      banner = el('div', 'convo-incognito');
      banner.id = 'convo-incognito';
      banner.setAttribute('role', 'status');
      banner.hidden = true;
      const mark = el('span', 'convo-incognito-mark');
      mark.setAttribute('aria-hidden', 'true');
      mark.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10h18"/><path d="M5.5 10l1.6-5.2a1 1 0 011.3-.6L12 5.5l3.6-1.3a1 1 0 011.3.6L18.5 10"/><circle cx="7.5" cy="15.5" r="2.7"/><circle cx="16.5" cy="15.5" r="2.7"/><path d="M10.2 15.2c1.1-.7 2.5-.7 3.6 0"/></svg>';
      const words = el('span', 'convo-incognito-text');
      words.append(el('strong', '', 'Incognito'), el('span', '', 'Nothing from this conversation is kept'));
      const leave = button('Leave', 'convo-incognito-btn', () => incognito(false));
      leave.id = 'convo-incognito-leave';
      leave.setAttribute('aria-label', 'Leave incognito');
      banner.append(mark, words, leave);
      greeting.before(banner);
    }
    banner.hidden = !S.convo.incognito;
    document.body.toggleAttribute('data-incognito', !!S.convo.incognito);
  }

  // ── under the reply: a request being thought through ──

  function renderThink() {
    let line = $('convo-think');
    if (!line) {
      const reply = $('reply');
      if (!reply) return;
      line = el('p', 'convo-think', 'Thinking it through…');
      line.id = 'convo-think';
      line.hidden = true;
      reply.before(line);
    }
    line.hidden = !S.convo.thinking_hard;
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
    badge.setAttribute('aria-hidden', 'true');
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
    send({ type: 'conversation_context' });
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
    if (!c.title) { title.removeAttribute('data-no-i18n'); title.textContent = c.incognito ? 'Incognito conversation' : c.session_id ? 'Untitled' : 'Nothing said yet'; }
    box.append(title);
    const meter = meterBlock();
    if (meter) box.append(meter);
    else {
      const cost = costText(c.cost || 0);
      if (cost) box.append(mine(el('div', 'convo-now-meta', cost)));
    }
    const actions = el('div', 'convo-actions');
    const ctx = S.context || {};
    const compact = button(ctx.compacting ? 'Compacting…' : 'Compact now', 'btn', () => {
      compact.disabled = true;
      compact.textContent = 'Compacting…';
      send({ type: 'conversation_compact' });
    });
    compact.id = 'convo-compact';
    compact.disabled = !ctx.available || !!ctx.compacting || !c.session_id;
    compact.title = 'Sum the conversation up now, to make room';
    const secret = button(c.incognito ? 'Leave incognito' : 'Go incognito', 'btn', () => { incognito(!c.incognito); closeSheet(); });
    secret.id = 'convo-incognito-switch';
    secret.title = c.incognito ? 'Back to the conversation from before' : 'A conversation nothing is kept of';
    actions.append(compact, button('New conversation', 'btn', () => { send({ type: 'reset' }); closeSheet(); }), secret);
    box.append(actions);
    return box;
  }

  // How full the conversation's context is: a ring, the tokens, what fills it, the cost.
  function meterBlock() {
    const c = S.context;
    if (!c || !c.available) return null;
    const box = el('div', 'convo-meter');
    const ring = el('span', 'convo-ring');
    ring.innerHTML = '<svg viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15" class="track"/><circle cx="18" cy="18" r="15" class="fill"/></svg>';
    const fill = ring.querySelector('.fill');
    const percent = Math.max(0, Math.min(100, Number(c.percent) || 0));
    fill.style.strokeDashoffset = String(94.25 * (1 - percent / 100));
    if (percent >= 80) ring.classList.add('high');
    ring.append(el('b', '', `${percent}%`));
    const words = el('div', 'convo-meter-words');
    words.append(el('div', 'convo-meter-line', `${percent}% of the context used`));
    if (c.max) words.append(el('div', 'convo-now-meta', `${tokenText(c.tokens)} of ${tokenText(c.max)} tokens`));
    const cost = costText(c.cost || 0);
    if (cost) words.append(el('div', 'convo-now-meta', `${cost} so far`));
    box.append(ring, words);
    const cats = (c.categories || []).filter((cat) => cat.tokens > 0);
    const wrap = el('div', 'convo-cx');
    if (c.max && cats.length) {
      const bar = el('div', 'convo-cx-bar');
      cats.forEach((cat, i) => {
        const seg = el('i');
        seg.style.width = `${(100 * cat.tokens) / c.max}%`;
        seg.dataset.cx = String((i % CX) + 1);
        bar.append(seg);
      });
      if (c.compact_at) {
        const mark = el('b', 'convo-cx-mark');
        mark.style.left = `${c.compact_at}%`;
        bar.append(mark);
      }
      const legend = el('ul', 'convo-cx-legend');
      cats.forEach((cat, i) => {
        const li = el('li');
        const dot = el('i');
        dot.dataset.cx = String((i % CX) + 1);
        li.append(dot, el('span', '', cat.name), el('b', '', tokenText(cat.tokens)));
        legend.append(li);
      });
      wrap.append(bar, legend);
    }
    wrap.append(el('p', 'convo-cx-note', c.autocompact
      ? (c.compact_at ? `Compacts on its own at ${c.compact_at}% (the mark).` : 'Compacts on its own when it fills up.')
      : 'Auto-compact is off: compact or clear before it fills up.'));
    const outer = el('div', 'convo-meter-box');
    outer.append(box, wrap);
    return outer;
  }

  function renderBadge() {
    const badge = $('convo-badge');
    if (!badge) return;
    const percent = S.context && S.context.available ? Number(S.context.percent) || 0 : 0;
    badge.textContent = percent >= 60 ? `${percent}%` : '';
    const btn = $('convo-btn');
    if (btn) btn.title = percent ? `Conversations · ${percent}% of the context used` : 'Conversations';
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
      go.disabled = !!S.convo.incognito;
      actions.append(go);
      if (S.convo.incognito) actions.append(el('span', 'convo-now-meta', 'Leave incognito to carry on a past conversation.'));
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
    const wasIncognito = !!S.convo.incognito;
    S.convo = { ...S.convo, ...ev };
    if (sheetOpen() && S.reading && wasIncognito !== !!S.convo.incognito) renderSheet();
    renderCaption();
    renderThink();
    renderIncognito();
    renderSettings();
    if (sheetOpen() && !S.reading) {
      const box = document.querySelector('#convo-body .convo-now');
      if (box) box.replaceWith(currentBlock());
    }
  }, { replay: true });
  F.on('conversation_context', (ev) => {
    S.context = ev;
    renderBadge();
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
  F.on('hello', () => { send({ type: 'conversation_state' }); send({ type: 'conversation_context' }); }, { replay: true });
  F.on('turn', (ev) => { if (ev.user && S.convo.resumed) { S.convo.resumed = null; renderCaption(); } });

  dockButton();
  renderSettings();
  renderCaption();
  renderThink();
  renderIncognito();
})();
