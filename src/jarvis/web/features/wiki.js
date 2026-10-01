// Memory wiki (features/wiki): a page for each person, organisation, project, place and
// topic Jarvis knows about, each line with where and when it was learned; search, links
// both ways, conflicts to settle, and the people map. Opened from Settings › Memory and by
// voice ("open my memory wiki", wiki_show). Statements are edited and forgotten through
// memory's own commands (memory_edit, memory_forget), a promise through memory_promise.
// The map is one canvas (no element per person), laid out with a grid-bucketed force
// simulation a few milliseconds a frame, in the knowledge galaxy's style.
// Everything that's the owner's own (names, facts, quotes, notes) carries data-no-i18n.
(() => {
  'use strict';

  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, $, send } = F;

  const KINDS = [['person', 'People'], ['org', 'Organisations'], ['project', 'Projects'], ['place', 'Places'], ['topic', 'Topics']];
  const KIND_ONE = { person: 'Person', org: 'Organisation', project: 'Project', place: 'Place', topic: 'Topic', me: 'You' };
  const SOURCES = {
    said: 'You told me',
    settings: 'Added in Settings',
    noticed: 'Noticed in a conversation',
    proposed: 'Suggested after a conversation, and you said yes',
    dream: 'From the Dream diary, and you said yes',
    import: 'Imported',
    before: 'From before Jarvis kept track',
  };
  const QUOTED = new Set(['said', 'noticed', 'proposed', 'dream']);
  const PROMISE_FROM = { message: 'A text you sent', mail: 'An email you sent', said: 'You said it' };
  const SECTIONS = [['fact', 'What Jarvis knows'], ['promise', 'Promises'], ['activity', 'How often you’re in touch'], ['journal', 'In your journal'], ['conversation', 'In conversations']];
  // The galaxy's palette, by kind.
  const COLORS = { me: '#ffffff', person: '#a5f3fc', org: '#c9a2ff', project: '#ffcf70', place: '#6ee7b7', topic: '#93c5fd' };
  const EDGE_COLORS = { family: '255, 143, 199', works: '95, 200, 255', met: '110, 231, 183', texts: '255, 207, 112', emails: '255, 138, 101', knows: '160, 180, 205' };
  const EDGE_NAMES = [['works', 'Works with'], ['family', 'Family'], ['met', 'Met at'], ['emails', 'Emails often'], ['texts', 'Texts often'], ['knows', 'Knows']];
  const LIST_MAX = 300; // pages listed at once; search narrows it

  const W = {
    tab: 'pages',
    index: [],
    conflicts: 0,
    missing: [],
    pageId: '',
    page: null,
    q: '',
    seq: 0,
    results: null,
    editing: '',
    reading: null, // a conversation read back: { session, title, entries }
    card: null, // the person card for the page open
    map: null,
    loading: false,
  };
  let returnFocus = null;
  let searchTimer = 0;

  const T = (text) => F.t(text);
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };
  const locale = () => (typeof uiLocale === 'function' ? uiLocale() : undefined);
  function button(label, cls, run) {
    const b = el('button', cls || 'btn', label);
    b.type = 'button';
    if (run) b.addEventListener('click', run);
    return b;
  }
  function day(iso) {
    const text = String(iso || '');
    const d = new Date(text.length === 10 ? `${text}T12:00:00` : text);
    if (!text || Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }
  function count(n, one, many) { return n === 1 ? one : many.replace('{n}', n); }

  // Where a statement came from, as pieces: [label (translated), when, quote (the owner's)].
  function sourceOf(st) {
    const src = st.source || {};
    if (st.kind === 'fact') {
      const words = src.how === 'dream' ? String(src.origin || '').replace(/^daily note of \d{4}-\d{2}-\d{2}:?\s*/, '') : String(src.origin || '');
      return { label: SOURCES[src.how] || SOURCES.before, when: src.learned || '', quote: QUOTED.has(src.how) || src.how === 'import' ? words : '', changed: src.changed || '' };
    }
    if (st.kind === 'promise') return { label: PROMISE_FROM[src.how] || PROMISE_FROM.said, when: src.at || '', quote: src.quote || '' };
    if (st.kind === 'journal') return { label: 'Daily note', when: src.day || '', quote: '' };
    if (st.kind === 'conversation') return { label: 'A conversation with Jarvis', when: src.at || '', quote: '', title: src.title || '' };
    if (st.kind === 'activity') return { label: st.what === 'texts' ? 'Counted in Messages' : 'Counted in Mail', when: '', quote: '' };
    return { label: '', when: '', quote: '' };
  }
  function activityText(st) {
    const days = (st.source && st.source.days) || 90;
    return st.what === 'texts' ? `${st.count} texts in the last ${days} days` : `${st.count} emails in the last ${days} days`;
  }

  // Pages grouped by kind for the list, at most LIST_MAX of them.
  function grouped(pages, max = LIST_MAX) {
    const out = [];
    let shown = 0;
    for (const [kind, title] of KINDS) {
      const items = pages.filter((p) => p.kind === kind);
      if (!items.length) continue;
      const room = Math.max(0, max - shown);
      out.push({ kind, title, items: items.slice(0, room), total: items.length });
      shown += Math.min(room, items.length);
    }
    return { groups: out.filter((g) => g.items.length), shown, total: pages.length };
  }

  // ── Settings › Memory: the way in ──

  function entry() {
    if ($('wiki-entry')) return;
    const rows = $('mem-rows');
    const list = $('memory-list');
    const group = rows ? rows.closest('section.group') : list ? list.closest('section.group') : null;
    if (!group) return;
    const box = el('div', 'mem-rows wiki-entry');
    box.id = 'wiki-entry';
    const b = el('button', 'mem-row');
    b.type = 'button';
    b.id = 'wiki-open-row';
    const text = el('span', 'mem-row-text');
    text.append(el('strong', '', 'Memory wiki'), el('small', '', 'A page for everyone and everything Jarvis knows, and the people map'));
    b.append(text, el('span', 'mem-chev', '›'));
    b.addEventListener('click', () => openWiki({ tab: 'pages' }));
    box.append(b);
    if (rows) rows.after(box); else group.append(box);
  }

  // ── the window ──

  function layer() {
    if ($('wiki-layer')) return $('wiki-layer');
    const root = el('div', 'wiki-layer');
    root.id = 'wiki-layer';
    root.hidden = true;
    const scrim = el('div', 'wiki-scrim');
    scrim.addEventListener('click', () => closeWiki());
    const pop = el('section', 'wiki-pop');
    pop.id = 'wiki-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-modal', 'true');
    pop.setAttribute('aria-labelledby', 'wiki-title');
    const head = el('header', 'wiki-head');
    const title = el('h2', '', 'Memory wiki');
    title.id = 'wiki-title';
    const tabs = el('nav', 'wiki-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Memory wiki');
    for (const [id, label] of [['pages', 'Pages'], ['map', 'People map']]) {
      const b = button(label, '', () => selectTab(id));
      b.setAttribute('role', 'tab');
      b.dataset.tab = id;
      tabs.append(b);
    }
    const close = el('button', 'wiki-close');
    close.type = 'button';
    close.id = 'wiki-close';
    close.setAttribute('aria-label', 'Close the memory wiki');
    close.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    close.addEventListener('click', () => closeWiki());
    head.append(title, tabs, close);

    const pages = el('div', 'wiki-pages');
    pages.id = 'wiki-pages';
    const side = el('aside', 'wiki-side');
    const search = el('input');
    search.type = 'search';
    search.id = 'wiki-search';
    search.placeholder = 'Search pages and what they say';
    search.setAttribute('aria-label', 'Search the memory wiki');
    search.addEventListener('input', () => {
      W.q = search.value.trim();
      clearTimeout(searchTimer);
      if (!W.q) { W.results = null; drawList(); return; }
      searchTimer = setTimeout(() => { W.seq += 1; send({ type: 'wiki_search', q: W.q, seq: String(W.seq) }); }, 180);
    });
    const list = el('nav', 'wiki-list');
    list.id = 'wiki-list';
    list.setAttribute('aria-label', 'Pages');
    side.append(search, list);
    const main = el('article', 'wiki-main');
    main.id = 'wiki-main';
    main.setAttribute('aria-live', 'polite');
    pages.append(side, main);

    const mapView = el('div', 'wiki-map');
    mapView.id = 'wiki-map';
    const canvas = el('canvas', 'wiki-canvas');
    canvas.id = 'wiki-canvas';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'People map');
    const bar = el('div', 'wiki-map-bar');
    const legend = el('div', 'wiki-legend');
    for (const [kind, label] of [['person', 'People'], ['org', 'Organisations'], ['project', 'Projects'], ['place', 'Places']]) {
      const item = el('span', 'wiki-key');
      const dot = el('i', 'wiki-dot');
      dot.style.background = COLORS[kind];
      item.append(dot, el('span', '', label));
      legend.append(item);
    }
    for (const [kind, label] of EDGE_NAMES) {
      const item = el('span', 'wiki-key');
      const line = el('i', 'wiki-line');
      line.style.background = `rgb(${EDGE_COLORS[kind]})`;
      item.append(line, el('span', '', label));
      legend.append(item);
    }
    const status = el('p', 'wiki-map-status');
    status.id = 'wiki-map-status';
    bar.append(legend, status);
    mapView.append(canvas, bar);

    pop.append(head, pages, mapView);
    pop.addEventListener('keydown', trapTab);
    root.append(scrim, pop);
    document.body.append(root);
    peopleMap = new PeopleMap(canvas);
    peopleMap.onSelect = (id) => { if (id && id !== 'me') { selectTab('pages'); openPage(id); } };
    return root;
  }

  function trapTab(e) {
    if (e.key !== 'Tab') return;
    const stops = [...e.currentTarget.querySelectorAll('button:not([disabled]), input, select, textarea, [tabindex="0"]')].filter((n) => n.offsetParent !== null);
    if (!stops.length) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function isOpen() { const l = $('wiki-layer'); return Boolean(l && !l.hidden); }

  function openWiki({ tab, page } = {}) {
    const root = layer();
    if (!isOpen()) returnFocus = document.activeElement;
    root.hidden = false;
    W.loading = true;
    send({ type: 'wiki_open', page: page || '' });
    if (page) { W.pageId = page; W.page = null; W.card = null; W.reading = null; }
    selectTab(tab || W.tab);
    $('wiki-close').focus({ preventScroll: true });
  }

  function closeWiki() {
    const root = $('wiki-layer');
    if (!root || root.hidden) return;
    root.hidden = true;
    W.editing = '';
    if (peopleMap) peopleMap.stop();
    const back = returnFocus;
    returnFocus = null;
    if (back && document.contains(back) && typeof back.focus === 'function') back.focus({ preventScroll: true });
  }

  function selectTab(tab) {
    W.tab = tab;
    document.querySelectorAll('#wiki-pop .wiki-tabs [role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $('wiki-pages').hidden = tab !== 'pages';
    $('wiki-map').hidden = tab !== 'map';
    if (tab === 'map') {
      send({ type: 'wiki_map' });
      peopleMap.start();
      drawMapStatus();
    } else {
      peopleMap.stop();
      drawList();
      drawPage();
    }
  }

  function openPage(id) {
    W.pageId = id;
    W.page = W.page && W.page.id === id ? W.page : null;
    W.editing = '';
    W.reading = null;
    W.card = null;
    send({ type: 'wiki_page', id });
    drawList();
    drawPage();
  }

  // ── the list ──

  function drawList() {
    const list = $('wiki-list');
    if (!list) return;
    const nodes = [];
    if (W.q && W.results) {
      if (!W.results.length) nodes.push(el('p', 'wiki-empty', 'Nothing matches.'));
      const ul = el('ul', 'wiki-items');
      for (const r of W.results) {
        const li = el('li');
        const b = linkButton(r.id, r.title, r.kind);
        if (r.match) b.append(mine(el('small', 'wiki-match', r.match)));
        li.append(b);
        ul.append(li);
      }
      nodes.push(ul);
    } else {
      const { groups, shown, total } = grouped(W.index);
      if (!total) nodes.push(el('p', 'wiki-empty', W.loading ? 'Putting the pages together…' : 'No pages yet. Tell Jarvis about the people and things in your life, and pages appear here.'));
      for (const g of groups) {
        nodes.push(el('h4', 'wiki-group', g.title));
        const ul = el('ul', 'wiki-items');
        for (const p of g.items) {
          const li = el('li');
          const b = linkButton(p.id, p.title, p.kind);
          const meta = el('span', 'wiki-count', String(p.count));
          if (p.conflicts) { b.classList.add('wiki-flagged'); b.setAttribute('aria-label', `${p.title}: ${T('a possible conflict')}`); }
          b.append(meta);
          li.append(b);
          ul.append(li);
        }
        nodes.push(ul);
      }
      if (shown < total) nodes.push(el('p', 'wiki-hint', `Showing ${shown} of ${total}. Search to narrow it down.`));
    }
    list.replaceChildren(...nodes);
  }

  function linkButton(id, title, kind) {
    const b = el('button', `wiki-link${id === W.pageId ? ' on' : ''}`);
    b.type = 'button';
    b.dataset.page = id;
    const dot = el('i', 'wiki-dot');
    dot.style.background = COLORS[kind] || COLORS.topic;
    b.append(dot, mine(el('span', 'wiki-link-title', title)));
    if (id === W.pageId) b.setAttribute('aria-current', 'page');
    b.addEventListener('click', () => openPage(id));
    return b;
  }

  // ── a page ──

  function drawPage() {
    const main = $('wiki-main');
    if (!main) return;
    if (!W.pageId) {
      const intro = el('div', 'wiki-intro');
      intro.append(el('h3', '', 'Everything Jarvis knows, page by page'));
      intro.append(el('p', 'wiki-hint', 'Pick a page or search. Each line says where Jarvis learned it and when; edit or forget it right there. Say “dig deeper on…” to have Jarvis pull it all together.'));
      if (W.conflicts) intro.append(el('p', 'wiki-hint wiki-warn', count(W.conflicts, '1 possible conflict to look at', '{n} possible conflicts to look at')));
      if (W.missing.length) intro.append(el('p', 'wiki-hint', 'Texts and email aren’t counted until Jarvis has Full Disk Access.'));
      main.replaceChildren(intro);
      return;
    }
    const p = W.page;
    if (!p) { main.replaceChildren(el('p', 'wiki-empty', W.missingPage ? 'That page isn’t there any more.' : 'Opening…')); return; }
    const nodes = [];
    const head = el('header', 'wiki-page-head');
    head.append(el('span', 'wiki-kind', KIND_ONE[p.kind] || 'Topic'));
    head.append(mine(el('h3', 'wiki-page-title', p.title)));
    if ((p.aliases || []).length) head.append(mine(el('small', 'wiki-aliases', p.aliases.join(' · '))));
    nodes.push(head);
    if (p.summary) {
      const box = el('div', 'wiki-summary');
      box.append(el('span', 'wiki-label', p.summary_current ? 'Summary' : 'Summary (from before the latest changes)'));
      box.append(mine(el('p', '', p.summary)));
      nodes.push(box);
    }
    for (const c of p.conflicts || []) nodes.push(conflictBox(c));
    for (const [kind, title] of SECTIONS) {
      const items = (p.statements || []).filter((s) => s.kind === kind);
      if (!items.length) continue;
      nodes.push(el('h4', 'wiki-section', title));
      const ul = el('ul', 'wiki-statements');
      for (const st of items) ul.append(statementItem(st));
      nodes.push(ul);
    }
    if (p.kind === 'person') nodes.push(cardBox());
    if ((p.links || []).length) {
      nodes.push(el('h4', 'wiki-section', 'Linked pages'));
      const chips = el('div', 'wiki-chips');
      for (const link of p.links) chips.append(linkButton(link.id, link.title, link.kind));
      nodes.push(chips);
    }
    if (W.reading) nodes.push(readingBox());
    const typing = document.activeElement && main.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA' ? document.activeElement.value : null;
    main.replaceChildren(...nodes);
    if (typing !== null) {
      const again = main.querySelector('textarea');
      if (again) { again.value = typing; again.focus({ preventScroll: true }); }
    }
  }

  function sourceLine(st) {
    const s = sourceOf(st);
    const line = el('div', 'wiki-source');
    if (s.label) line.append(el('span', '', s.label));
    if (s.title) { line.append(el('span', '', ' · ')); line.append(mine(el('span', '', `“${s.title}”`))); }
    const when = day(s.when);
    if (when) line.append(el('span', '', ` · ${when}`));
    if (s.quote) { line.append(el('span', '', ' · ')); line.append(mine(el('q', 'wiki-quote', s.quote))); }
    if (s.changed) line.append(el('span', 'wiki-muted', ` · ${T('changed')} ${day(s.changed)}`));
    if (st.kind === 'promise') {
      if (st.due) line.append(el('span', '', ` · ${T('due')} ${day(st.due)}`));
      if (st.status && st.status !== 'open') line.append(el('span', 'wiki-muted', ` · ${T(st.status === 'done' ? 'Done' : 'Dismissed')}`));
    }
    return line;
  }

  function statementItem(st) {
    const li = el('li', 'wiki-st');
    li.dataset.statement = st.id;
    if (W.editing === st.id && st.kind === 'fact') { li.append(editForm(st)); return li; }
    const body = el('div', 'wiki-st-body');
    if (st.kind === 'activity') body.append(el('span', 'wiki-st-text', activityText(st)));
    else if (st.kind === 'promise') {
      const text = el('span', 'wiki-st-text');
      if (st.to) text.append(el('span', '', `${T('Promised to')} `), mine(el('span', '', st.to)), el('span', '', ': '));
      text.append(mine(el('span', '', st.text)));
      body.append(text);
    } else if (st.kind === 'conversation') {
      const text = el('span', 'wiki-st-text');
      text.append(el('span', '', `${T('You asked')}: `), mine(el('span', '', st.text)));
      body.append(text);
    } else body.append(mine(el('span', 'wiki-st-text', st.text)));
    body.append(sourceLine(st));
    if ((st.pages || []).length) {
      const also = el('div', 'wiki-also');
      for (const link of st.pages) {
        const b = mine(button(link.title, 'wiki-tag', () => openPage(link.id)));
        also.append(b);
      }
      body.append(also);
    }
    const actions = el('div', 'wiki-actions');
    if (st.kind === 'fact') {
      const edit = button('Edit', 'btn wiki-small', () => { W.editing = st.id; drawPage(); });
      edit.setAttribute('aria-label', `${T('Edit')}: ${st.text}`);
      const forget = button('Forget', 'btn wiki-small', () => send({ type: 'memory_forget', id: st.fact }));
      forget.setAttribute('aria-label', `${T('Forget')}: ${st.text}`);
      actions.append(edit, forget);
    } else if (st.kind === 'promise' && st.status === 'open') {
      actions.append(
        button('Done', 'btn wiki-small', () => send({ type: 'memory_promise', id: st.promise, status: 'done' })),
        button('Dismiss', 'btn wiki-small', () => send({ type: 'memory_promise', id: st.promise, status: 'dismissed' })),
      );
    } else if (st.kind === 'journal') {
      actions.append(button('Open note', 'btn wiki-small', () => send({ type: 'memory_journal_open', day: st.day })));
    } else if (st.kind === 'conversation') {
      actions.append(button('Read it', 'btn wiki-small', () => {
        W.reading = { session: st.session, title: (st.source || {}).title || '', entries: null };
        send({ type: 'conversation_open', session_id: st.session });
        drawPage();
      }));
    }
    li.append(body, actions);
    return li;
  }

  function editForm(st) {
    const form = el('form', 'wiki-edit');
    const text = el('textarea');
    text.value = st.text;
    text.maxLength = 300;
    text.rows = 2;
    text.setAttribute('aria-label', 'What Jarvis knows');
    mine(text);
    const actions = el('div', 'wiki-actions');
    const save = button('Save', 'btn primary wiki-small');
    save.type = 'submit';
    actions.append(save, button('Cancel', 'btn wiki-small', () => { W.editing = ''; drawPage(); }));
    form.append(text, actions);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const words = text.value.trim();
      if (!words) return;
      send({ type: 'memory_edit', id: st.fact, text: words });
      W.editing = '';
      drawPage();
    });
    setTimeout(() => { if (document.contains(text)) text.focus({ preventScroll: true }); }, 0);
    return form;
  }

  function conflictBox(c) {
    const box = el('div', 'wiki-conflict');
    box.dataset.conflict = c.key;
    box.append(el('strong', '', 'These may not both be true'));
    if (c.why) box.append(mine(el('p', 'wiki-hint', c.why)));
    const pair = el('ol', 'wiki-pair');
    for (const [letter, st] of [['A', c.first], ['B', c.second]]) {
      const li = el('li');
      li.append(el('span', 'wiki-letter', letter));
      const body = el('div', 'wiki-st-body');
      body.append(mine(el('span', 'wiki-st-text', st.text)), sourceLine(st));
      li.append(body);
      pair.append(li);
    }
    box.append(pair);
    const actions = el('div', 'wiki-actions wiki-left');
    actions.append(
      button('Keep A', 'btn wiki-small', () => send({ type: 'memory_forget', id: c.b })),
      button('Keep B', 'btn wiki-small', () => send({ type: 'memory_forget', id: c.a })),
      button('Both true at different times', 'btn wiki-small', () => send({ type: 'wiki_resolve', key: c.key, choice: 'both', page: W.pageId })),
    );
    box.append(actions);
    return box;
  }

  function cardBox() {
    const box = el('div', 'wiki-card');
    const card = W.card;
    const name = W.page ? W.page.title : '';
    if (!card) {
      box.append(el('h4', 'wiki-section', 'Person card'));
      box.append(el('p', 'wiki-hint', 'Meetings, recent email and texts, and notes about them, read on this Mac.'));
      box.append(button('Show the person card', 'btn wiki-small', () => { W.card = { loading: true, asked: name }; send({ type: 'memory_person', name }); drawPage(); }));
      return box;
    }
    box.append(el('h4', 'wiki-section', 'Person card'));
    if (card.loading) { box.append(el('p', 'wiki-hint', 'Putting it together…')); return box; }
    const part = (title, rows) => {
      if (!rows.length) return;
      box.append(el('span', 'wiki-label', title));
      const ul = el('ul', 'wiki-sub');
      rows.forEach((r) => ul.append(r));
      box.append(ul);
    };
    part('Meetings', (card.meetings || []).map((m) => { const li = el('li'); li.append(el('span', 'wiki-muted', `${day(m.at)} `), mine(el('span', '', m.title))); return li; }));
    part('Texts and email', [
      ...(card.texts || []).map((t) => { const li = el('li'); li.append(el('span', 'wiki-muted', `${day(t.at)} ${t.mine ? `${T('You')}: ` : ''}`), mine(el('span', '', t.text))); return li; }),
      ...(card.mail || []).map((m) => { const li = el('li'); li.append(el('span', 'wiki-muted', `${day(m.at)} ${T('Email')}: `), mine(el('span', '', m.subject))); return li; }),
    ]);
    part('In your notes', (card.mentions || []).map((m) => { const li = el('li'); li.append(mine(el('strong', '', m.title))); if (m.excerpt) li.append(el('br'), mine(el('small', 'wiki-muted', m.excerpt))); return li; }));
    if ((card.missing || []).length) box.append(el('p', 'wiki-hint', `${T('Couldn’t read')}: ${card.missing.map((m) => T(m)).join(', ')}`));
    if (box.children.length === 1) box.append(el('p', 'wiki-hint', 'Nothing more about them in your messages, calendar or notes.'));
    return box;
  }

  function readingBox() {
    const r = W.reading;
    const box = el('div', 'wiki-reading');
    const head = el('div', 'wiki-reading-head');
    head.append(el('h4', 'wiki-section', 'A conversation with Jarvis'), button('Close', 'btn wiki-small', () => { W.reading = null; drawPage(); }));
    box.append(head);
    if (r.title) box.append(mine(el('strong', '', r.title)));
    if (!r.entries) { box.append(el('p', 'wiki-hint', r.error ? 'That conversation can’t be read any more.' : 'Opening…')); return box; }
    const ul = el('ul', 'wiki-lines');
    for (const e of r.entries.slice(-30)) {
      const li = el('li', e.role === 'user' ? 'wiki-you' : 'wiki-jarvis');
      li.append(el('span', 'wiki-label', e.role === 'user' ? 'You' : 'Jarvis'), mine(el('p', '', e.text.length > 600 ? `${e.text.slice(0, 599)}…` : e.text)));
      ul.append(li);
    }
    box.append(ul);
    return box;
  }

  function drawMapStatus() {
    const status = $('wiki-map-status');
    if (!status) return;
    const m = W.map;
    if (!m) { status.textContent = T('Drawing the map…'); return; }
    const n = Math.max(0, m.nodes.length - 1);
    let text = n ? count(n, '1 person or organisation', '{n} people and organisations') : T('Nobody on the map yet.');
    if (m.more) text += ` · ${count(m.more, '1 more not shown', '{n} more not shown')}`;
    if ((m.missing || []).length) text += ` · ${T('Texts and email need Full Disk Access.')}`;
    status.textContent = text;
  }

  // ── the people map: a canvas, a force layout bucketed by a grid ──

  // A simulation over typed arrays: repulsion only between nodes in neighbouring cells of a
  // grid (so a step costs about the same per node at 2,000 as at 20), springs along edges,
  // a pull to the middle, and "me" held there. Positions start on a sunflower spiral.
  function createSim(n, edges, weights) {
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    const vx = new Float32Array(n);
    const vy = new Float32Array(n);
    const golden = Math.PI * (3 - Math.sqrt(5));
    const spread = 18 * Math.sqrt(n + 1);
    for (let i = 1; i < n; i++) {
      const r = spread * Math.sqrt(i / n);
      x[i] = r * Math.cos(i * golden);
      y[i] = r * Math.sin(i * golden);
    }
    const pairs = new Int32Array(edges.length * 2);
    edges.forEach((e, k) => { pairs[2 * k] = e[0]; pairs[2 * k + 1] = e[1]; });
    return { n, x, y, vx, vy, pairs, weights: weights || new Float32Array(n), alpha: 1, cell: 46, steps: 0 };
  }

  function stepSim(sim) {
    const { n, x, y, vx, vy, pairs, cell } = sim;
    if (sim.alpha < 0.004 || n < 2) return false;
    const a = sim.alpha;
    // Bucket the nodes by cell.
    const grid = new Map();
    for (let i = 0; i < n; i++) {
      const key = (Math.floor(x[i] / cell) * 73856093) ^ (Math.floor(y[i] / cell) * 19349663);
      const list = grid.get(key);
      if (list) list.push(i); else grid.set(key, [i]);
    }
    const reach = cell * cell;
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(x[i] / cell);
      const cy = Math.floor(y[i] / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const list = grid.get((gx * 73856093) ^ (gy * 19349663));
          if (!list) continue;
          for (const j of list) {
            if (j <= i) continue;
            let dx = x[i] - x[j];
            let dy = y[i] - y[j];
            let d2 = dx * dx + dy * dy;
            if (d2 > reach) continue;
            if (d2 < 0.01) { dx = (i % 7) - 3 + 0.5; dy = (j % 5) - 2 + 0.5; d2 = dx * dx + dy * dy; }
            const f = (900 * a) / d2;
            vx[i] += dx * f; vy[i] += dy * f;
            vx[j] -= dx * f; vy[j] -= dy * f;
          }
        }
      }
    }
    for (let k = 0; k < pairs.length; k += 2) {
      const i = pairs[k];
      const j = pairs[k + 1];
      const dx = x[j] - x[i];
      const dy = y[j] - y[i];
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = ((d - 60) / d) * 0.06 * a;
      vx[i] += dx * f; vy[i] += dy * f;
      vx[j] -= dx * f; vy[j] -= dy * f;
    }
    for (let i = 0; i < n; i++) {
      vx[i] -= x[i] * 0.004 * a;
      vy[i] -= y[i] * 0.004 * a;
      vx[i] *= 0.6; vy[i] *= 0.6;
      const v2 = vx[i] * vx[i] + vy[i] * vy[i];
      if (v2 > 400) { const s = 20 / Math.sqrt(v2); vx[i] *= s; vy[i] *= s; }
      x[i] += vx[i];
      y[i] += vy[i];
    }
    x[0] = 0; y[0] = 0; vx[0] = 0; vy[0] = 0; // the owner, in the middle
    sim.alpha *= 0.985;
    sim.steps += 1;
    return true;
  }

  // The node nearest a point in world units, within a radius; -1 for none.
  function nearest(sim, wx, wy, radius) {
    let best = -1;
    let bestD = radius * radius;
    for (let i = 0; i < sim.n; i++) {
      const d = (sim.x[i] - wx) ** 2 + (sim.y[i] - wy) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  function sprite(color) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    const n = parseInt(color.slice(1), 16);
    const rgba = (alpha) => `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.16, color);
    grad.addColorStop(0.34, rgba(0.3));
    grad.addColorStop(0.7, rgba(0.05));
    grad.addColorStop(1, rgba(0));
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return c;
  }

  class PeopleMap {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.nodes = [];
      this.edges = [];
      this.sim = null;
      this.scale = 1;
      this.panX = 0;
      this.panY = 0;
      this.hover = -1;
      this.running = false;
      this.dirty = true;
      this.onSelect = null;
      this.sprites = {};
      for (const [kind, color] of Object.entries(COLORS)) this.sprites[kind] = sprite(color);
      this._bind();
    }

    setData(data) {
      this.nodes = data.nodes || [];
      this.edges = (data.edges || []).filter((e) => e[0] < this.nodes.length && e[1] < this.nodes.length);
      const weights = new Float32Array(this.nodes.length);
      this.nodes.forEach((node, i) => { weights[i] = node.weight || 0; });
      this.sim = createSim(this.nodes.length, this.edges, weights);
      this.byKind = {};
      for (const e of this.edges) (this.byKind[e[2]] = this.byKind[e[2]] || []).push(e);
      this.labelled = this.nodes.map((node, i) => [node.weight || 0, i]).sort((p, q) => q[0] - p[0]).slice(0, 24).map((p) => p[1]);
      this.hover = -1;
      this.fit = true;
      this.dirty = true;
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.dirty = true;
      const loop = () => {
        if (!this.running) return;
        const sim = this.sim;
        if (sim) {
          const until = performance.now() + 8; // a few milliseconds a frame, never more
          while (performance.now() < until && stepSim(sim)) this.dirty = true;
        }
        if (this.dirty) this.draw();
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }

    stop() { this.running = false; }

    size() {
      const dpr = window.devicePixelRatio || 1;
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(h * dpr);
      }
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return [w, h];
    }

    toWorld(sx, sy) {
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      return [(sx - w / 2 - this.panX) / this.scale, (sy - h / 2 - this.panY) / this.scale];
    }

    draw() {
      this.dirty = false;
      const [w, h] = this.size();
      const ctx = this.ctx;
      ctx.clearRect(0, 0, w, h);
      const sim = this.sim;
      if (!sim || !sim.n || !w) return;
      const { x, y } = sim;
      if (this.fit && sim.steps > 40) {
        let r = 1;
        for (let i = 0; i < sim.n; i++) r = Math.max(r, Math.abs(x[i]), Math.abs(y[i]));
        this.scale = Math.max(0.12, Math.min(1.6, (Math.min(w, h) / 2 - 30) / r));
      }
      const s = this.scale;
      const ox = w / 2 + this.panX;
      const oy = h / 2 + this.panY;
      ctx.lineWidth = 1;
      for (const [kind, list] of Object.entries(this.byKind || {})) {
        ctx.strokeStyle = `rgba(${EDGE_COLORS[kind] || EDGE_COLORS.knows}, ${kind === 'knows' ? 0.16 : 0.32})`;
        ctx.beginPath();
        for (const e of list) {
          ctx.moveTo(ox + x[e[0]] * s, oy + y[e[0]] * s);
          ctx.lineTo(ox + x[e[1]] * s, oy + y[e[1]] * s);
        }
        ctx.stroke();
      }
      const near = new Set();
      if (this.hover >= 0) {
        near.add(this.hover);
        for (const e of this.edges) { if (e[0] === this.hover) near.add(e[1]); else if (e[1] === this.hover) near.add(e[0]); }
      }
      for (let i = 0; i < sim.n; i++) {
        const node = this.nodes[i];
        const px = ox + x[i] * s;
        const py = oy + y[i] * s;
        if (px < -20 || py < -20 || px > w + 20 || py > h + 20) continue;
        const big = i === 0 ? 30 : Math.min(26, 10 + Math.sqrt(node.weight || 0) * 3);
        const size = Math.max(5, big * Math.min(1.4, Math.max(0.55, s))) * (near.has(i) ? 1.35 : 1);
        ctx.globalAlpha = this.hover >= 0 && !near.has(i) ? 0.45 : 1;
        ctx.drawImage(this.sprites[node.kind] || this.sprites.topic, px - size / 2, py - size / 2, size, size);
      }
      ctx.globalAlpha = 1;
      ctx.font = '500 12px "Instrument Sans", -apple-system, sans-serif';
      ctx.textBaseline = 'middle';
      const placed = [];
      const label = (i, strong) => {
        const node = this.nodes[i];
        const px = ox + x[i] * s;
        const py = oy + y[i] * s;
        const text = node.kind === 'me' ? T('You') : node.title.length > 32 ? `${node.title.slice(0, 31)}…` : node.title;
        const tw = ctx.measureText(text).width + 12;
        const box = { x: px + 10, y: py - 11, w: tw, h: 22 };
        if (!strong && (box.x + box.w > w || placed.some((o) => box.x < o.x + o.w && o.x < box.x + box.w && box.y < o.y + o.h && o.y < box.y + box.h))) return;
        placed.push(box);
        ctx.fillStyle = 'rgba(6, 12, 24, 0.78)';
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(box.x, box.y, box.w, box.h, 7); else ctx.rect(box.x, box.y, box.w, box.h);
        ctx.fill();
        ctx.fillStyle = strong ? '#ffffff' : '#d7e6f5';
        ctx.fillText(text, box.x + 6, py);
      };
      if (this.hover >= 0) label(this.hover, true);
      if (s > 0.35) for (const i of this.labelled) if (i !== this.hover) label(i, false);
    }

    pickAt(clientX, clientY) {
      if (!this.sim) return -1;
      const r = this.canvas.getBoundingClientRect();
      const [wx, wy] = this.toWorld(clientX - r.left, clientY - r.top);
      return nearest(this.sim, wx, wy, 14 / this.scale);
    }

    _bind() {
      let sx = 0;
      let sy = 0;
      let moved = false;
      let dragging = false;
      const c = this.canvas;
      c.addEventListener('pointerdown', (e) => { dragging = true; moved = false; sx = e.clientX; sy = e.clientY; c.setPointerCapture(e.pointerId); });
      c.addEventListener('pointermove', (e) => {
        if (dragging) {
          const dx = e.clientX - sx;
          const dy = e.clientY - sy;
          if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
          if (moved) { this.panX += dx; this.panY += dy; this.fit = false; sx = e.clientX; sy = e.clientY; this.dirty = true; }
          return;
        }
        const i = this.pickAt(e.clientX, e.clientY);
        if (i !== this.hover) {
          this.hover = i;
          c.style.cursor = i > 0 ? 'pointer' : 'grab';
          c.title = i >= 0 ? (i === 0 ? T('You') : this.nodes[i].title) : '';
          this.dirty = true;
        }
      });
      c.addEventListener('pointerup', (e) => {
        dragging = false;
        if (moved) return;
        const i = this.pickAt(e.clientX, e.clientY);
        if (i > 0 && this.onSelect) this.onSelect(this.nodes[i].id);
      });
      c.addEventListener('pointerleave', () => { if (this.hover !== -1) { this.hover = -1; this.dirty = true; } });
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        const r = c.getBoundingClientRect();
        const [wx, wy] = this.toWorld(e.clientX - r.left, e.clientY - r.top);
        this.scale = Math.max(0.08, Math.min(4, this.scale * Math.exp(-e.deltaY * 0.0015)));
        // Zoom about the pointer.
        this.panX = e.clientX - r.left - r.width / 2 - wx * this.scale;
        this.panY = e.clientY - r.top - r.height / 2 - wy * this.scale;
        this.fit = false;
        this.dirty = true;
      }, { passive: false });
    }
  }

  let peopleMap = null;

  // ── Escape: the wiki closes (an edit or a conversation being read first), and only it ──

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !isOpen()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (W.editing) { W.editing = ''; drawPage(); } else if (W.reading) { W.reading = null; drawPage(); } else closeWiki();
  }, true);

  // ── the hub's events ──

  F.on('wiki_show', (ev) => openWiki({ tab: ev.tab === 'map' ? 'map' : 'pages', page: ev.page || '' }));
  F.on('wiki_index', (ev) => {
    W.index = ev.pages || [];
    W.conflicts = ev.conflicts || 0;
    W.missing = ev.missing || [];
    W.loading = false;
    if (isOpen() && W.tab === 'pages') { drawList(); if (!W.pageId) drawPage(); }
  });
  F.on('wiki_page', (ev) => {
    if (ev.id !== W.pageId) return;
    W.page = ev.page || null;
    W.missingPage = Boolean(ev.missing);
    if (W.editing && !(W.page && W.page.statements.some((s) => s.id === W.editing))) W.editing = '';
    if (isOpen()) drawPage();
  });
  F.on('wiki_results', (ev) => {
    if (String(ev.seq) !== String(W.seq) || ev.q !== W.q) return; // an older search
    W.results = ev.items || [];
    if (isOpen()) drawList();
  });
  F.on('wiki_map', (ev) => {
    W.map = ev;
    if (peopleMap) peopleMap.setData(ev);
    drawMapStatus();
  });
  F.on('memory_person', (ev) => {
    if (!W.card || !W.page || !isOpen()) return;
    if (ev.name !== W.page.title && ev.asked !== W.card.asked) return;
    W.card = ev;
    drawPage();
  });
  F.on('conversation_transcript', (ev) => {
    if (!W.reading || W.reading.session !== ev.session_id) return;
    W.reading = { ...W.reading, entries: ev.entries || [], error: ev.error || '' };
    if (isOpen()) drawPage();
  });
  // Facts and promises changed (an edit, a forget, keeping one of a conflict): the page again.
  const again = () => { if (isOpen()) send({ type: 'wiki_open', page: W.pageId }); };
  F.on('memory', again);
  F.on('memory_state', () => { if (isOpen() && W.pageId) send({ type: 'wiki_page', id: W.pageId }); });
  F.on('hello', () => { entry(); if (isOpen()) send({ type: 'wiki_open', page: W.pageId }); }, { replay: true });

  window.addEventListener('jarvis-features-ready', entry);
  entry();

  if (typeof window.__wikiTest === 'function') window.__wikiTest({ createSim, stepSim, nearest, grouped, sourceOf, activityText });
})();
