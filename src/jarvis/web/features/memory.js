// Memory (features/memory): Settings › Memory grown into a sheet. Facts with a category,
// how sure, a last day and where each was learned (edited in place, forgotten by where or
// when they came from); suggestions after a conversation and the morning's Dream diary;
// About you; standing intents ("When… then…"); People; Promises; the daily Journal; and
// Import. Cards for waiting suggestions and the Dream diary, and "Do it" on a fired intent.
// Everything that's the owner's own (facts, quotes, names, notes, what they typed) carries
// data-no-i18n; the rest has its Chinese in i18n/memory.json.
(() => {
  'use strict';

  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, $, send } = F;

  const CATEGORIES = [['people', 'People'], ['preferences', 'Preferences'], ['work', 'Work'], ['health', 'Health'], ['places', 'Places'], ['other', 'Other']];
  const CONFIDENCE = [['high', 'Sure'], ['medium', 'Fairly sure'], ['low', 'Not sure']];
  const SOURCES = {
    said: 'You told me',
    settings: 'Added in Settings',
    noticed: 'Noticed in a conversation',
    proposed: 'Suggested after a conversation, and you said yes',
    dream: 'From the Dream diary, and you said yes',
    import: 'Imported',
    synced: 'Synced from your iPhone',
    before: 'From before Jarvis kept track',
  };
  // Where the owner's own words are the origin (shown as a quote); an import names its file.
  const QUOTED = new Set(['said', 'noticed', 'proposed', 'dream']);
  const FORGET_SOURCES = [
    ['conversations', 'Conversations'], ['settings', 'Settings'], ['suggestions', 'Suggestions you approved'],
    ['dream diary', 'The Dream diary'], ['chatgpt', 'The ChatGPT import'], ['jarvis code', 'The Jarvis Code import'],
    ['pasted', 'A pasted list'], ['synced', 'Synced from your iPhone'], ['before', 'From before Jarvis kept track'],
  ];
  const TABS = [['facts', 'Facts'], ['suggested', 'Suggested'], ['about', 'About you'], ['intents', 'When… then…'], ['people', 'People'], ['promises', 'Promises'], ['journal', 'Journal'], ['import', 'Import']];
  const WATCH = [['mail', 'Email'], ['message', 'Texts'], ['alert', 'Heads-ups'], ['request', 'What I say']];
  const COOLDOWNS = [[1, 'At most once an hour'], [6, 'At most once in six hours'], [12, 'At most once in twelve hours'], [24, 'At most once a day'], [72, 'At most once in three days'], [168, 'At most once a week']];
  const LEARNING = [['propose', 'Suggest'], ['silent', 'Save quietly'], ['off', 'Off']];

  const S = {
    facts: [],
    state: null,
    features: {},
    tab: 'facts',
    filter: 'all',
    query: '',
    editing: '',
    why: new Set(),
    preview: null,
    forgetSource: '',
    forgetDay: '',
    review: null,
    reviewPicks: new Map(),
    reviewAbout: false,
    reviewBehave: false,
    reviewError: '',
    person: null,
    later: { conversation: '', dream: '' }, // the suggestions a card was put away for
    draftAbout: null,
    draftBehave: null,
    lang: 'en',
  };
  let returnFocus = null;

  const T = (text) => F.t(text);
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };
  const locale = () => (typeof uiLocale === 'function' ? uiLocale() : undefined);
  function button(label, cls, run) {
    const b = el('button', cls || 'btn', label);
    b.type = 'button';
    if (run) b.addEventListener('click', run);
    return b;
  }
  // Today on this Mac's calendar, YYYY-MM-DD (toISOString's date is UTC's: in the evening
  // west of Greenwich it's already tomorrow there).
  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function day(iso) {
    const d = new Date(String(iso || '').length === 10 ? `${iso}T12:00:00` : iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }
  function dayLong(iso) {
    const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
    if (Number.isNaN(d.getTime())) return String(iso || '');
    return d.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' });
  }
  function clock(hhmm) {
    const [h, m] = String(hhmm || '21:00').split(':').map(Number);
    const d = new Date();
    d.setHours(h || 0, m || 0, 0, 0);
    return d.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
  }
  function feature(key, fallback) {
    return Object.prototype.hasOwnProperty.call(S.features, key) ? S.features[key] : fallback;
  }
  function setFeature(key, value) {
    S.features = { ...S.features, [key]: value };
    send({ type: 'feature_prefs', changes: { [key]: value } });
  }
  function switchRow(title, small, on, toggle, id) {
    const row = el('div', 'row');
    const label = el('span');
    label.append(el('strong', '', title));
    if (small) label.append(el('small', '', small));
    const sw = button('', 'switch', () => toggle(sw.getAttribute('aria-checked') !== 'true'));
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(Boolean(on)));
    sw.setAttribute('aria-label', title);
    if (id) sw.id = id;
    row.append(label, sw);
    return row;
  }
  function select(options, value, label) {
    const s = el('select');
    for (const [v, text] of options) {
      const o = el('option', '', text);
      o.value = String(v);
      s.append(o);
    }
    s.value = String(value);
    if (label) s.setAttribute('aria-label', label);
    return s;
  }
  function input(value, placeholder, label, max) {
    const i = el('input');
    i.type = 'text';
    i.value = value || '';
    if (placeholder) i.placeholder = placeholder;
    if (label) i.setAttribute('aria-label', label);
    if (max) i.maxLength = max;
    return i;
  }
  function dateInput(value, label) {
    const i = el('input');
    i.type = 'date';
    i.value = value || '';
    i.min = today();
    if (label) i.setAttribute('aria-label', label);
    return i;
  }
  function section(title) { return el('h4', 'mem-section', title); }
  function hint(text, cls) { return el('p', `mem-hint${cls ? ` ${cls}` : ''}`, text); }

  // ── Settings › Memory ──

  function group() {
    const list = $('memory-list');
    return list ? list.closest('section.group') : null;
  }

  function settingsGroup() {
    const g = group();
    if (!g || $('mem-rows')) return;
    // The sheet has the facts now: the old list and its form stay, hidden, for app.js.
    $('memory-list').hidden = true;
    if ($('memory-form')) $('memory-form').hidden = true;
    const lead = g.querySelector('.small-status');
    if (lead) lead.textContent = 'What Jarvis knows about you, where it learned it, and what it noticed. Say “Jarvis, remember…” or open a row.';
    const rows = el('div', 'mem-rows');
    rows.id = 'mem-rows';
    for (const [tab, title] of TABS) {
      const b = el('button', 'mem-row');
      b.type = 'button';
      b.dataset.memTab = tab;
      const text = el('span', 'mem-row-text');
      const line = el('small', '', '');
      line.id = `mem-line-${tab}`;
      text.append(el('strong', '', title), line);
      b.append(text, el('span', 'mem-chev', '›'));
      b.addEventListener('click', () => openSheet(tab));
      rows.append(b);
    }
    const learning = el('div', 'mem-learning');
    learning.id = 'mem-learning';
    g.append(rows, learning);
    renderLines();
  }

  function learningControl(host) {
    const current = feature('memory_learning', 'propose');
    const wrap = el('div', 'mem-learning-inner');
    const label = el('div', 'row');
    const span = el('span');
    span.append(el('strong', '', 'Suggest things to remember'), el('small', '', 'After a conversation, what you said about yourself: suggested on a card for your OK, saved quietly as “fairly sure”, or not at all. “Remember…” always works.'));
    label.append(span);
    const seg = el('div', 'segmented mem-seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Suggest things to remember');
    for (const [mode, text] of LEARNING) {
      const b = button(text, '', () => { setFeature('memory_learning', mode); renderLearning(); if (sheetOpen()) render(S.tab); });
      b.setAttribute('role', 'radio');
      b.dataset.mode = mode;
      b.setAttribute('aria-checked', String(mode === current));
      seg.append(b);
    }
    wrap.append(label, seg);
    host.replaceChildren(wrap);
  }

  function renderLearning() {
    const host = $('mem-learning');
    if (host) learningControl(host);
  }

  function countLine(n, one, many) { return n === 1 ? one : many.replace('{n}', n); }

  function renderLines() {
    if (!$('mem-rows')) return;
    const st = S.state || {};
    const set = (tab, text) => { const line = $(`mem-line-${tab}`); if (line) line.textContent = text; };
    const n = S.facts.length;
    set('facts', n ? countLine(n, '1 fact', '{n} facts') : 'Nothing yet');
    const waiting = ((st.suggestions || {}).pending || []).length;
    set('suggested', waiting ? countLine(waiting, '1 waiting for you', '{n} waiting for you') : 'Nothing waiting');
    const about = st.about || {};
    set('about', about.about || about.behave ? 'Written' : 'Not written yet');
    const intents = (st.intents || []).length;
    set('intents', intents ? countLine(intents, '1 set', '{n} set') : 'None yet');
    const people = (st.people || []).length;
    set('people', people ? countLine(people, '1 person', '{n} people') : 'Nobody yet');
    const open = (st.promises || []).filter((p) => p.status === 'open').length;
    set('promises', open ? countLine(open, '1 open', '{n} open') : (feature('memory_commitments', false) ? 'Nothing open' : 'Not tracking'));
    set('journal', feature('memory_journal', true) ? 'Every evening' : 'Off');
    set('import', 'From ChatGPT, Jarvis Code or a list');
    renderLearning();
  }

  // ── the sheet ──

  function sheet() {
    if ($('mem-layer')) return $('mem-layer');
    const layer = el('div', 'mem-layer');
    layer.id = 'mem-layer';
    layer.hidden = true;
    const scrim = el('div', 'mem-scrim');
    scrim.addEventListener('click', () => closeSheet());
    const pop = el('section', 'mem-pop');
    pop.id = 'mem-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-modal', 'true');
    pop.setAttribute('aria-labelledby', 'mem-title');
    const head = el('header', 'mem-head');
    const title = el('h2', '', 'Memory');
    title.id = 'mem-title';
    const close = el('button', 'mem-close');
    close.type = 'button';
    close.id = 'mem-close';
    close.setAttribute('aria-label', 'Close memory');
    close.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    close.addEventListener('click', () => closeSheet());
    head.append(title, close);
    const tabs = el('nav', 'mem-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Memory');
    for (const [id, label] of TABS) {
      const b = button(label, '', () => selectTab(id));
      b.setAttribute('role', 'tab');
      b.dataset.tab = id;
      tabs.append(b);
    }
    const body = el('div', 'mem-body');
    body.id = 'mem-body';
    for (const [id] of TABS) {
      const panel = el('div', 'mem-panel');
      panel.id = `mem-tab-${id}`;
      panel.setAttribute('role', 'tabpanel');
      body.append(panel);
    }
    pop.append(head, tabs, body);
    pop.addEventListener('keydown', trapTab);
    layer.append(scrim, pop);
    document.body.append(layer);
    return layer;
  }

  function trapTab(e) {
    if (e.key !== 'Tab') return;
    const stops = [...e.currentTarget.querySelectorAll('button:not([disabled]), input, select, textarea, [tabindex="0"]')].filter((n) => n.offsetParent !== null);
    if (!stops.length) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function sheetOpen() { const l = $('mem-layer'); return Boolean(l && !l.hidden); }

  function openSheet(tab) {
    const layer = sheet();
    if (!sheetOpen()) returnFocus = document.activeElement;
    layer.hidden = false;
    send({ type: 'memory_state' });
    selectTab(tab || S.tab);
    $('mem-close').focus({ preventScroll: true });
  }

  function closeSheet() {
    const layer = $('mem-layer');
    if (!layer || layer.hidden) return;
    layer.hidden = true;
    S.editing = '';
    S.preview = null;
    const back = returnFocus;
    returnFocus = null;
    if (back && document.contains(back) && typeof back.focus === 'function') back.focus({ preventScroll: true });
  }

  function selectTab(tab) {
    S.tab = tab;
    document.querySelectorAll('#mem-pop .mem-tabs [role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    for (const [id] of TABS) $(`mem-tab-${id}`).hidden = id !== tab;
    render(tab);
  }

  function render(tab) {
    if (!sheetOpen()) return;
    const panel = $(`mem-tab-${tab}`);
    if (!panel) return;
    const draw = { facts: drawFacts, suggested: drawSuggested, about: drawAbout, intents: drawIntents, people: drawPeople, promises: drawPromises, journal: drawJournal, import: drawImport }[tab];
    // A text box being typed in keeps its words (and the caret) across a redraw.
    const typing = document.activeElement && panel.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) ? document.activeElement.dataset.key : '';
    const kept = typing ? document.activeElement.value : null;
    panel.replaceChildren(...draw());
    if (typing) {
      const again = panel.querySelector(`[data-key="${CSS.escape(typing)}"]`);
      if (again) { again.value = kept; again.focus({ preventScroll: true }); }
    }
  }

  // ── Facts ──

  function drawFacts() {
    const nodes = [];
    // Counted from the facts shown (the memory event), so a forget never leaves a stale count.
    const counts = {};
    for (const f of S.facts) counts[f.category] = (counts[f.category] || 0) + 1;
    const bar = el('div', 'mem-filter');
    const search = input(S.query, 'Search what Jarvis knows', 'Search what Jarvis knows');
    search.dataset.key = 'fact-search';
    search.addEventListener('input', () => { S.query = search.value; render('facts'); });
    const chips = el('div', 'mem-chips');
    const chip = (key, label, n) => {
      const b = button(n === undefined ? label : `${T(label)} ${n}`, `mem-chip${S.filter === key ? ' on' : ''}`, () => { S.filter = key; render('facts'); });
      b.setAttribute('aria-pressed', String(S.filter === key));
      return b;
    };
    chips.append(chip('all', 'All', S.facts.length));
    for (const [key, label] of CATEGORIES) if (counts[key]) chips.append(chip(key, label, counts[key]));
    bar.append(search, chips);
    nodes.push(bar);
    const words = S.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const shown = S.facts.filter((f) => (S.filter === 'all' || f.category === S.filter) && words.every((w) => f.text.toLowerCase().includes(w)));
    const list = el('ul', 'mem-list');
    if (!shown.length) list.append(el('li', 'mem-empty', S.facts.length ? 'Nothing matches.' : 'Nothing yet. Say “Jarvis, remember…” or add something below.'));
    for (const f of shown) list.append(factItem(f));
    nodes.push(list);
    nodes.push(addForm());
    nodes.push(forgetBox());
    return nodes;
  }

  function factItem(f) {
    const li = el('li', 'mem-item');
    li.dataset.fact = f.id;
    if (S.editing === f.id) {
      li.append(editForm(f));
      return li;
    }
    const text = el('div', 'mem-text');
    text.append(mine(el('span', 'mem-fact', f.text)));
    const meta = el('div', 'mem-meta');
    const bits = [T((CATEGORIES.find(([k]) => k === f.category) || [0, 'Other'])[1])];
    if (f.confidence !== 'high') bits.push(T((CONFIDENCE.find(([k]) => k === f.confidence) || [0, ''])[1]));
    meta.append(el('span', '', bits.join(' · ')));
    if (f.expires) meta.append(el('span', 'mem-until', `${T('Until')} ${day(f.expires)}`));
    text.append(meta);
    if (S.why.has(f.id)) text.append(whyLine(f));
    const actions = el('div', 'mem-actions');
    actions.append(
      button('Edit', 'btn mem-small', () => { S.editing = f.id; render('facts'); }),
      button(S.why.has(f.id) ? 'Hide' : 'Why?', 'btn mem-small', () => { if (S.why.has(f.id)) S.why.delete(f.id); else S.why.add(f.id); render('facts'); }),
      button('Forget', 'btn mem-small', () => send({ type: 'memory_forget', id: f.id })),
    );
    actions.querySelectorAll('button')[0].setAttribute('aria-label', `${T('Edit')}: ${f.text}`);
    actions.querySelectorAll('button')[2].setAttribute('aria-label', `${T('Forget')}: ${f.text}`);
    li.append(text, actions);
    return li;
  }

  function whyLine(f) {
    const line = el('div', 'mem-why');
    const when = day(f.learned || f.at);
    line.append(el('span', '', T(SOURCES[f.source] || SOURCES.before)));
    if (when) line.append(el('span', '', ` · ${when}`));
    // A dream's origin names its note ("daily note of 2026-09-29: …"): the words are enough.
    const words = f.source === 'dream' ? String(f.origin || '').replace(/^daily note of \d{4}-\d{2}-\d{2}:?\s*/, '') : f.origin;
    if (words && (QUOTED.has(f.source) || f.source === 'import')) {
      line.append(el('span', '', ' · '));
      line.append(mine(f.source === 'import' ? el('span', '', words) : el('q', 'mem-quote', words)));
    }
    if (f.at && f.learned && f.at !== f.learned) line.append(el('span', 'mem-changed', ` · ${T('changed')} ${day(f.at)}`));
    return line;
  }

  function editForm(f) {
    const form = el('form', 'mem-edit');
    const text = el('textarea');
    text.value = f.text;
    text.maxLength = 300;
    text.rows = 2;
    text.dataset.key = `edit-${f.id}`;
    text.setAttribute('aria-label', 'What Jarvis knows');
    mine(text);
    const cat = select(CATEGORIES, f.category, 'Category');
    const sure = select(CONFIDENCE, f.confidence, 'How sure');
    const until = dateInput(f.expires, 'Last day it holds');
    const row = el('div', 'mem-edit-row');
    const untilLabel = el('label', 'mem-inline');
    untilLabel.append(el('span', '', 'Until'), until);
    row.append(cat, sure, untilLabel);
    const actions = el('div', 'mem-actions');
    const save = button('Save', 'btn primary mem-small');
    save.type = 'submit';
    actions.append(save, button('Cancel', 'btn mem-small', () => { S.editing = ''; render('facts'); }));
    form.append(text, row, actions);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const words = text.value.trim();
      if (!words) return;
      send({ type: 'memory_edit', id: f.id, text: words, category: cat.value, confidence: sure.value, expires: until.value || 'never' });
      S.editing = '';
      render('facts');
    });
    return form;
  }

  function addForm() {
    const form = el('form', 'mem-add');
    const text = input('', 'e.g. Ann Lee is my co-founder', 'Something to remember', 300);
    text.dataset.key = 'fact-add';
    const cat = select([['', 'Category: guess'], ...CATEGORIES], '', 'Category');
    const add = button('Remember', 'btn');
    add.type = 'submit';
    form.append(text, cat, add);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const words = text.value.trim();
      if (!words) return;
      const msg = { type: 'memory_add', text: words };
      if (cat.value) msg.category = cat.value;
      send(msg);
      text.value = '';
    });
    return form;
  }

  function forgetBox() {
    const box = el('details', 'mem-forget');
    box.open = Boolean(S.preview || S.forgetSource || S.forgetDay);
    box.append(el('summary', '', 'Forget by where or when it was learned'));
    const row = el('div', 'mem-edit-row');
    const src = select([['', 'Anywhere'], ...FORGET_SOURCES], S.forgetSource, 'Learned from');
    const when = el('input');
    when.type = 'date';
    when.value = S.forgetDay;
    when.setAttribute('aria-label', 'Learned on');
    const look = button('Show what that is', 'btn mem-small', () => {
      S.forgetSource = src.value;
      S.forgetDay = when.value;
      if (!S.forgetSource && !S.forgetDay) return;
      send({ type: 'memory_forget_where', source: S.forgetSource, day: S.forgetDay });
    });
    row.append(src, when, look);
    box.append(row);
    if (S.preview) {
      const p = S.preview;
      if (!p.count) box.append(hint('Nothing Jarvis knows came from there.'));
      else {
        const confirm = el('div', 'mem-confirm');
        confirm.append(el('p', '', countLine(p.count, 'This forgets 1 thing:', 'This forgets {n} things:')));
        const ul = el('ul', 'mem-examples');
        for (const text of p.examples || []) ul.append(mine(el('li', '', text)));
        if (p.count > (p.examples || []).length) ul.append(el('li', 'mem-more', countLine(p.count - p.examples.length, '…and 1 more', '…and {n} more')));
        const actions = el('div', 'mem-actions');
        actions.append(
          button(countLine(p.count, 'Forget 1', 'Forget {n}'), 'btn primary mem-small mem-danger', () => {
            send({ type: 'memory_forget_where', source: S.forgetSource, day: S.forgetDay, confirm: true, ids: p.ids });
            S.preview = null;
            S.forgetSource = '';
            S.forgetDay = '';
            render('facts');
          }),
          button('Cancel', 'btn mem-small', () => { S.preview = null; render('facts'); }),
        );
        confirm.append(ul, actions);
        box.append(confirm);
      }
    }
    return box;
  }

  // ── Suggested and the Dream diary ──

  function suggestionItem(p) {
    const li = el('li', 'mem-item');
    li.dataset.suggestion = p.id;
    const text = el('div', 'mem-text');
    text.append(mine(el('span', 'mem-fact', p.text)));
    const meta = el('div', 'mem-meta');
    const from = `${T(p.origin === 'dream' ? 'From your daily note' : 'From what you said')} · ${day(p.day)}`;
    meta.append(el('span', '', from));
    if (p.quote) { meta.append(el('span', '', ' · ')); meta.append(mine(el('q', 'mem-quote', p.quote))); }
    text.append(meta);
    const actions = el('div', 'mem-actions');
    actions.append(
      button('Remember', 'btn primary mem-small', () => send({ type: 'memory_suggestion', id: p.id, action: 'keep' })),
      button('Not this', 'btn mem-small', () => send({ type: 'memory_suggestion', id: p.id, action: 'dismiss' })),
    );
    li.append(text, actions);
    return li;
  }

  function drawSuggested() {
    const st = S.state || {};
    const pending = (st.suggestions || {}).pending || [];
    const nodes = [];
    const talk = pending.filter((p) => p.origin !== 'dream');
    const dreams = pending.filter((p) => p.origin === 'dream');
    nodes.push(section('From your conversations'));
    if (talk.length) {
      const ul = el('ul', 'mem-list');
      talk.forEach((p) => ul.append(suggestionItem(p)));
      const all = el('div', 'mem-actions mem-left');
      all.append(
        button('Remember all', 'btn mem-small', () => send({ type: 'memory_suggestions_all', action: 'keep', origin: 'conversation' })),
        button('None of these', 'btn mem-small', () => send({ type: 'memory_suggestions_all', action: 'dismiss', origin: 'conversation' })),
      );
      nodes.push(ul, all);
    } else nodes.push(hint('Nothing waiting. After a conversation goes quiet, what you said about yourself shows up here for your OK.'));
    nodes.push(section('Dream diary'));
    if (dreams.length) {
      const ul = el('ul', 'mem-list');
      dreams.forEach((p) => ul.append(suggestionItem(p)));
      const all = el('div', 'mem-actions mem-left');
      all.append(
        button('Remember all', 'btn mem-small', () => send({ type: 'memory_suggestions_all', action: 'keep', origin: 'dream' })),
        button('None of these', 'btn mem-small', () => send({ type: 'memory_suggestions_all', action: 'dismiss', origin: 'dream' })),
      );
      nodes.push(ul, all);
    }
    const nights = (st.suggestions || {}).nights || [];
    if (nights.length) {
      const ul = el('ul', 'mem-nights');
      for (const n of nights.slice(0, 7)) {
        const li = el('li');
        li.append(el('strong', '', dayLong(n.night)), el('span', '', ` · ${T(countLine(n.notes.length, 'went over 1 note', 'went over {n} notes'))} · ${T(countLine(n.proposed, 'suggested 1', 'suggested {n}'))} · ${T(countLine(n.kept, 'kept 1', 'kept {n}'))}`));
        ul.append(li);
      }
      nodes.push(ul);
    } else if (!dreams.length) nodes.push(hint('Each night Jarvis goes over the last few daily notes for what’s worth remembering. What it finds waits here, and on a card in the morning.'));
    nodes.push(switchRow('Dream over my daily notes', 'Once a night, at most two small model calls a day. Needs daily notes on.', feature('memory_dreams', true), (on) => { setFeature('memory_dreams', on); render('suggested'); }, 'sw-memory-dreams'));
    return nodes;
  }

  // ── About you ──

  function drawAbout() {
    const about = (S.state && S.state.about) || { about: '', behave: '', max: 4000 };
    const max = about.max || 4000;
    const nodes = [hint('Two short texts in your own words. They go into every conversation. Markdown is fine.')];
    const field = (key, title, small, placeholder, draftKey) => {
      const wrap = el('label', 'mem-field');
      const head = el('span', 'mem-field-head');
      head.append(el('strong', '', title));
      const count = el('small', 'mem-count', '');
      head.append(count);
      const text = el('textarea');
      text.rows = 6;
      text.maxLength = max;
      text.placeholder = placeholder;
      text.dataset.key = key;
      text.value = S[draftKey] !== null ? S[draftKey] : about[key] || '';
      mine(text);
      const counted = () => { count.textContent = `${text.value.length.toLocaleString()} / ${max.toLocaleString()}`; };
      text.addEventListener('input', () => { S[draftKey] = text.value; counted(); });
      counted();
      wrap.append(head, el('small', '', small), text);
      return wrap;
    };
    nodes.push(field('about', 'About me', 'Who you are, what you do, the people and things that matter.', 'e.g. I run a small venture fund in Berkeley. Two kids, Maya and Leo.', 'draftAbout'));
    nodes.push(field('behave', 'How Jarvis should behave', 'Tone, length, habits. It never loosens what Jarvis asks you first.', 'e.g. Keep answers short. Call me Rob. No small talk before 9.', 'draftBehave'));
    const actions = el('div', 'mem-actions mem-left');
    actions.append(button('Save', 'btn primary', () => {
      const msg = { type: 'memory_about' };
      if (S.draftAbout !== null) msg.about = S.draftAbout;
      if (S.draftBehave !== null) msg.behave = S.draftBehave;
      send(msg);
      S.draftAbout = null;
      S.draftBehave = null;
    }));
    nodes.push(actions);
    return nodes;
  }

  // ── When… then… ──

  function drawIntents() {
    const items = (S.state && S.state.intents) || [];
    const nodes = [hint('Standing intents: when something comes up, Jarvis reminds you or offers to do what you asked. Say “Jarvis, when Ann emails about the deck, remind me to send the numbers.” Needs Heads-ups on.')];
    const ul = el('ul', 'mem-list');
    if (!items.length) ul.append(el('li', 'mem-empty', 'None yet.'));
    for (const i of items) {
      const li = el('li', 'mem-item');
      li.dataset.intent = i.id;
      const text = el('div', 'mem-text');
      const line = el('div', 'mem-intent');
      line.append(el('span', 'mem-label', 'When'), mine(el('span', 'mem-fact', i.when)), el('span', 'mem-arrow', '→'), mine(el('span', 'mem-fact', i.then)));
      text.append(line);
      const meta = el('div', 'mem-meta');
      const watch = WATCH.filter(([k]) => (i.watch || []).includes(k)).map(([, t]) => T(t)).join(', ');
      meta.append(el('span', '', `${T('Watching')} ${watch}`));
      const about = [...(i.people || []), ...(i.words || [])].join(', ');
      if (about) { meta.append(el('span', '', ` · ${T('about')} `)); meta.append(mine(el('span', '', about))); }
      if (i.fuzzy) meta.append(el('span', '', ` · ${T('by meaning')}`));
      const often = COOLDOWNS.find(([h]) => h === i.cooldown);
      meta.append(el('span', '', ` · ${often ? T(often[1]) : `${i.cooldown} h`}`));
      if (i.expires) meta.append(el('span', '', ` · ${T('Until')} ${day(i.expires)}`));
      if (i.count) meta.append(el('span', '', ` · ${T(countLine(i.count, 'fired once', 'fired {n} times'))}`));
      if (i.paused) meta.append(el('span', 'mem-paused', ` · ${T('Paused')}`));
      text.append(meta);
      const actions = el('div', 'mem-actions');
      actions.append(
        button(i.paused ? 'Resume' : 'Pause', 'btn mem-small', () => send({ type: 'memory_intent_pause', id: i.id, paused: !i.paused })),
        button('Remove', 'btn mem-small', () => send({ type: 'memory_intent_remove', id: i.id })),
      );
      li.append(text, actions);
      ul.append(li);
    }
    nodes.push(ul, intentForm());
    return nodes;
  }

  function intentForm() {
    const form = el('form', 'mem-form');
    form.append(section('Add one'));
    const when = input('', 'e.g. Ann emails about the deck', 'When', 200);
    when.dataset.key = 'intent-when';
    const then = input('', 'e.g. remind me to send the numbers', 'Then', 200);
    then.dataset.key = 'intent-then';
    const people = input('', 'People (optional, e.g. Ann)', 'People', 200);
    people.dataset.key = 'intent-people';
    const words = input('', 'Words (optional, e.g. deck)', 'Words', 200);
    words.dataset.key = 'intent-words';
    const kinds = el('div', 'mem-checks');
    const boxes = WATCH.map(([key, label]) => {
      const lab = el('label', 'mem-check');
      const box = el('input');
      box.type = 'checkbox';
      box.value = key;
      lab.append(box, el('span', '', label));
      kinds.append(lab);
      return box;
    });
    const fuzzyLab = el('label', 'mem-check');
    const fuzzy = el('input');
    fuzzy.type = 'checkbox';
    fuzzyLab.append(fuzzy, el('span', '', 'Match by meaning (a small model decides, a few times an hour at most)'));
    const cooldown = select(COOLDOWNS, 12, 'How often at most');
    const until = dateInput('', 'Last day');
    const row = el('div', 'mem-edit-row');
    const coolLab = el('label', 'mem-inline');
    coolLab.append(cooldown);
    const untilLab = el('label', 'mem-inline');
    untilLab.append(el('span', '', 'Until'), until);
    row.append(coolLab, untilLab);
    const add = button('Add', 'btn primary mem-small');
    add.type = 'submit';
    const whenRow = el('div', 'mem-pair');
    whenRow.append(el('span', 'mem-label', 'When'), when);
    const thenRow = el('div', 'mem-pair');
    thenRow.append(el('span', 'mem-label', 'Then'), then);
    const partsRow = el('div', 'mem-edit-row');
    partsRow.append(people, words);
    form.append(whenRow, thenRow, partsRow, kinds, fuzzyLab, row, hint('Nothing checked: it watches everything. Without a last day it lasts 90 days.'), add);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!when.value.trim() || !then.value.trim()) return;
      const msg = { type: 'memory_intent_add', when: when.value.trim(), then: then.value.trim(), fuzzy: fuzzy.checked, cooldown: Number(cooldown.value) };
      if (people.value.trim()) msg.people = people.value;
      if (words.value.trim()) msg.words = words.value;
      const watch = boxes.filter((b) => b.checked).map((b) => b.value);
      if (watch.length) msg.watch = watch;
      if (until.value) msg.expires = until.value;
      send(msg);
      form.reset();
    });
    return form;
  }

  // ── People ──

  function drawPeople() {
    const known = (S.state && S.state.people) || [];
    const nodes = [];
    const form = el('form', 'mem-add');
    const who = input('', 'Brief me on…', 'Brief me on', 80);
    who.dataset.key = 'person';
    const go = button('Look up', 'btn');
    go.type = 'submit';
    form.append(who, go);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!who.value.trim()) return;
      S.person = { loading: true, asked: who.value.trim() };
      send({ type: 'memory_person', name: who.value.trim() });
      render('people');
    });
    nodes.push(form);
    if (known.length) {
      const chips = el('div', 'mem-chips');
      for (const name of known) {
        const b = mine(button(name, `mem-chip${S.person && S.person.name === name ? ' on' : ''}`, () => { S.person = { loading: true, asked: name }; send({ type: 'memory_person', name }); render('people'); }));
        chips.append(b);
      }
      nodes.push(chips);
    } else nodes.push(hint('People you tell Jarvis about show up here, with those you’ve made promises to or set intents about.'));
    if (S.person) nodes.push(personCard(S.person));
    return nodes;
  }

  function personCard(card) {
    const box = el('div', 'mem-card');
    if (card.loading) { box.append(el('p', 'mem-hint', 'Putting it together…')); return box; }
    if (card.ambiguous) {
      box.append(el('p', '', 'More than one person fits. Which one?'));
      const chips = el('div', 'mem-chips');
      for (const name of card.ambiguous) chips.append(mine(button(name, 'mem-chip', () => { S.person = { loading: true, asked: name }; send({ type: 'memory_person', name }); render('people'); })));
      box.append(chips);
      return box;
    }
    box.append(mine(el('h4', 'mem-card-name', card.name)));
    const part = (title, rows) => {
      if (!rows.length) return;
      box.append(section(title));
      const ul = el('ul', 'mem-sub');
      rows.forEach((r) => ul.append(r));
      box.append(ul);
    };
    part('What Jarvis knows', (card.facts || []).map((t) => mine(el('li', '', t))));
    part('Promises to them', (card.promises || []).map((p) => {
      const li = el('li');
      li.append(mine(el('span', '', p.text)));
      if (p.due) li.append(el('span', 'mem-meta', ` · ${T('due')} ${day(p.due)}`));
      return li;
    }));
    part('Meetings', (card.meetings || []).map((m) => {
      const li = el('li');
      li.append(el('span', 'mem-meta', `${day(m.at)} `), mine(el('span', '', m.title)));
      return li;
    }));
    const messages = [
      ...(card.texts || []).map((t) => { const li = el('li'); li.append(el('span', 'mem-meta', `${day(t.at)} ${t.mine ? T('You') : ''}${t.mine ? ': ' : ''}`), mine(el('span', '', t.text))); return li; }),
      ...(card.mail || []).map((m) => { const li = el('li'); li.append(el('span', 'mem-meta', `${day(m.at)} ${T('Email')}: `), mine(el('span', '', m.subject))); return li; }),
      ...(card.waiting || []).map((w) => { const li = el('li'); li.append(el('span', 'mem-meta', `${day(w.at)} ${T('Unread')}: `), mine(el('span', '', w.text))); return li; }),
    ];
    part('Texts and email', messages);
    part('In your notes', (card.mentions || []).map((m) => {
      const li = el('li');
      li.append(mine(el('strong', '', m.title)));
      if (m.excerpt) li.append(el('br'), mine(el('small', 'mem-meta', m.excerpt)));
      return li;
    }));
    part('Standing intents about them', (card.intents || []).map((w) => mine(el('li', '', w))));
    if ((card.missing || []).length) box.append(el('p', 'mem-hint warn', `${T('Couldn’t read')}: ${card.missing.map((m) => T(m)).join(', ')}`));
    if (box.children.length === 1) box.append(hint('Nothing about them yet.'));
    return box;
  }

  // ── Promises ──

  function drawPromises() {
    const items = (S.state && S.state.promises) || [];
    const on = feature('memory_commitments', false);
    const nodes = [switchRow('Track my promises', 'Reads only what you send in Mail and Messages, never what others send you. Only messages that sound like a promise go to a small model, a few times an hour at most. Needs Full Disk Access.', on, (v) => { setFeature('memory_commitments', v); render('promises'); }, 'sw-memory-commitments')];
    if (on) {
      const actions = el('div', 'mem-actions mem-left');
      actions.append(button('Check now', 'btn mem-small', () => send({ type: 'memory_promise_scan' })));
      nodes.push(actions);
    }
    const open = items.filter((p) => p.status === 'open');
    const ul = el('ul', 'mem-list');
    if (!open.length) ul.append(el('li', 'mem-empty', 'Nothing open.'));
    for (const p of open) ul.append(promiseItem(p));
    nodes.push(ul, promiseForm());
    const closed = items.filter((p) => p.status !== 'open');
    if (closed.length) {
      const box = el('details', 'mem-closed');
      box.append(el('summary', '', countLine(closed.length, '1 done or dismissed', '{n} done or dismissed')));
      const list = el('ul', 'mem-list');
      closed.slice(0, 50).forEach((p) => list.append(promiseItem(p)));
      box.append(list);
      nodes.push(box);
    }
    return nodes;
  }

  function promiseItem(p) {
    const li = el('li', 'mem-item');
    li.dataset.promise = p.id;
    const text = el('div', 'mem-text');
    text.append(mine(el('span', 'mem-fact', p.text)));
    const meta = el('div', 'mem-meta');
    if (p.to) { meta.append(el('span', '', `${T('To')} `)); meta.append(mine(el('span', '', p.to))); }
    if (p.due) meta.append(el('span', p.due < today() && p.status === 'open' ? 'mem-late' : '', `${p.to ? ' · ' : ''}${T('due')} ${day(p.due)}`));
    if (p.status !== 'open') meta.append(el('span', '', ` · ${T(p.status === 'done' ? 'Done' : 'Dismissed')}`));
    text.append(meta);
    if (p.quote) text.append(mine(el('q', 'mem-quote mem-block', p.quote)));
    const actions = el('div', 'mem-actions');
    if (p.status === 'open') {
      actions.append(
        button('Mark done', 'btn mem-small', () => send({ type: 'memory_promise', id: p.id, status: 'done' })),
        button('Dismiss', 'btn mem-small', () => send({ type: 'memory_promise', id: p.id, status: 'dismissed' })),
      );
    } else actions.append(button('Reopen', 'btn mem-small', () => send({ type: 'memory_promise', id: p.id, status: 'open' })));
    li.append(text, actions);
    return li;
  }

  function promiseForm() {
    const form = el('form', 'mem-add');
    const text = input('', 'e.g. Send Ann the deck', 'A promise', 160);
    text.dataset.key = 'promise-text';
    const to = input('', 'To whom', 'To whom', 80);
    to.dataset.key = 'promise-to';
    const due = dateInput('', 'Due');
    const add = button('Add', 'btn');
    add.type = 'submit';
    form.append(text, to, due, add);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!text.value.trim()) return;
      send({ type: 'memory_promise_add', text: text.value.trim(), to: to.value.trim(), due: due.value });
      form.reset();
    });
    return form;
  }

  // ── Journal ──

  function drawJournal() {
    const j = (S.state && S.state.journal) || { notes: [], folder: '', time: '21:00' };
    const on = feature('memory_journal', true);
    const nodes = [switchRow('Write a daily note', 'What you asked, what Jarvis did, your meetings and routines, with a short summary (one small model call a day). Never in incognito. A note you change is never written over.', on, (v) => { setFeature('memory_journal', v); render('journal'); }, 'sw-memory-journal')];
    const timeRow = el('label', 'row');
    const span = el('span');
    span.append(el('strong', '', 'Time'), el('small', '', 'Or at first use the next day'));
    const time = el('input');
    time.type = 'time';
    time.value = feature('memory_journal_time', '21:00');
    time.setAttribute('aria-label', 'Daily note time');
    time.addEventListener('change', () => { if (/^\d{2}:\d{2}$/.test(time.value)) setFeature('memory_journal_time', time.value); });
    timeRow.append(span, time);
    nodes.push(timeRow);
    nodes.push(switchRow('Search them in the second brain', 'Jarvis finds them when you ask what happened on a day.', feature('brain_journal', true), (v) => { S.features = { ...S.features, brain_journal: v }; send({ type: 'brain_source', source: 'journal', on: v }); render('journal'); }, 'sw-brain-journal'));
    const where = el('p', 'mem-hint');
    where.append(el('span', '', `${T('Kept in')} `), mine(el('code', 'mem-path', j.folder || '~/Documents/Jarvis/Journal')));
    nodes.push(where);
    const actions = el('div', 'mem-actions mem-left');
    actions.append(button('Write today’s note now', 'btn mem-small', () => send({ type: 'memory_journal_write' })));
    nodes.push(actions);
    const ul = el('ul', 'mem-list');
    if (!(j.notes || []).length) ul.append(el('li', 'mem-empty', 'No notes yet.'));
    for (const n of j.notes || []) {
      const li = el('li', 'mem-item');
      const text = el('div', 'mem-text');
      text.append(el('span', 'mem-fact', dayLong(n.day)));
      const meta = el('div', 'mem-meta', `${Math.max(1, Math.round(n.size / 1024))} KB${n.mine ? '' : ` · ${T('Changed by you')}`}`);
      text.append(meta);
      const open = button('Open', 'btn mem-small', () => send({ type: 'memory_journal_open', day: n.day }));
      li.append(text, open);
      ul.append(li);
    }
    nodes.push(ul);
    return nodes;
  }

  // ── Import ──

  function drawImport() {
    const nodes = [];
    if (S.review) {
      nodes.push(...reviewNodes());
      return nodes;
    }
    if (S.reviewError) nodes.push(hint(S.reviewError, 'warn'));
    nodes.push(hint('Nothing is kept until you’ve looked it over and chosen.'));
    const gpt = el('div', 'mem-import');
    gpt.append(el('strong', '', 'ChatGPT'), el('small', '', 'Your data export (the .zip ChatGPT emails you), or a file of memories. Its saved memories and custom instructions come in; its conversations are never read.'));
    const file = el('input');
    file.type = 'file';
    file.accept = '.zip,.json,.txt,.md';
    file.hidden = true;
    file.id = 'mem-import-file';
    file.addEventListener('change', () => {
      const chosen = file.files && file.files[0];
      if (!chosen) return;
      const path = window.jarvisApp && window.jarvisApp.pathFor ? window.jarvisApp.pathFor(chosen) : '';
      if (path) send({ type: 'memory_import', kind: 'chatgpt', path });
      else if (/\.(txt|md)$/i.test(chosen.name) && chosen.size < 1024 * 1024) chosen.text().then((text) => send({ type: 'memory_import', kind: 'paste', text }));
      else { S.reviewError = T('Choose the file in the Jarvis app.'); render('import'); }
      file.value = '';
    });
    gpt.append(file, button('Choose the export…', 'btn mem-small', () => file.click()));
    const claude = el('div', 'mem-import');
    claude.append(el('strong', '', 'Jarvis Code’s memory file'), el('small', '', 'Reads ~/.claude/CLAUDE.md once, now. It’s never changed.'), button('Read it', 'btn mem-small', () => send({ type: 'memory_import', kind: 'claude' })));
    const paste = el('div', 'mem-import');
    const area = el('textarea');
    area.rows = 5;
    area.placeholder = 'One thing per line';
    area.dataset.key = 'paste';
    area.setAttribute('aria-label', 'A list to import');
    mine(area);
    paste.append(el('strong', '', 'A list'), el('small', '', 'Paste things to remember, one per line.'), area, button('Look it over', 'btn mem-small', () => { if (area.value.trim()) send({ type: 'memory_import', kind: 'paste', text: area.value }); }));
    nodes.push(gpt, claude, paste);
    return nodes;
  }

  function reviewNodes() {
    const r = S.review;
    const nodes = [];
    const head = el('div', 'mem-review-head');
    head.append(el('strong', '', 'Look it over'), el('span', '', ' · '), mine(el('span', '', r.origin)));
    nodes.push(head);
    for (const note of r.notes || []) nodes.push(hint(note, 'warn'));
    const picked = [...S.reviewPicks.values()].filter((p) => p.on).length;
    if (r.items.length) {
      nodes.push(hint(countLine(r.room, 'Memory has room for 1 more.', 'Memory has room for {n} more.')));
      const ul = el('ul', 'mem-list');
      for (const item of r.items) {
        const pick = S.reviewPicks.get(item.id);
        const li = el('li', 'mem-item mem-pick');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = pick.on;
        box.setAttribute('aria-label', item.text);
        box.addEventListener('change', () => { pick.on = box.checked; render('import'); });
        const text = input(pick.text, '', 'What to remember', 300);
        text.dataset.key = `review-${item.id}`;
        mine(text);
        text.addEventListener('input', () => { pick.text = text.value; });
        const cat = select(CATEGORIES, pick.category, 'Category');
        cat.addEventListener('change', () => { pick.category = cat.value; });
        li.append(box, text, cat);
        ul.append(li);
      }
      nodes.push(ul);
    }
    const extra = (key, flag, title) => {
      if (!r[key]) return;
      const lab = el('label', 'mem-check mem-block');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = S[flag];
      box.addEventListener('change', () => { S[flag] = box.checked; });
      lab.append(box, el('span', '', title));
      nodes.push(lab, mine(el('pre', 'mem-pre', r[key])));
    };
    extra('about', 'reviewAbout', 'Use this as About me');
    extra('behave', 'reviewBehave', 'Use this as How Jarvis should behave');
    const actions = el('div', 'mem-actions mem-left');
    actions.append(
      button(countLine(picked, 'Save 1', 'Save {n}'), 'btn primary', () => {
        send({
          type: 'memory_import_save',
          review: r.id,
          items: r.items.filter((i) => S.reviewPicks.get(i.id).on).map((i) => {
            const p = S.reviewPicks.get(i.id);
            return { id: i.id, text: p.text.trim() || i.text, category: p.category };
          }),
          about: S.reviewAbout,
          behave: S.reviewBehave,
        });
      }),
      button('Cancel', 'btn', () => { S.review = null; render('import'); }),
    );
    nodes.push(actions);
    return nodes;
  }

  // ── cards: waiting suggestions and the morning's Dream diary ──

  function syncCards(fresh) {
    if (fresh) document.querySelectorAll('[data-memory-card]').forEach((node) => { node.dataset.key = ''; });
    const pending = ((S.state && S.state.suggestions) || {}).pending || [];
    card('conversation', pending.filter((p) => p.origin !== 'dream'));
    card('dream', pending.filter((p) => p.origin === 'dream'));
  }

  function card(origin, items) {
    const cards = $('cards');
    if (!cards) return;
    const key = items.map((p) => p.id).join(',');
    let node = cards.querySelector(`[data-memory-card="${origin}"]`);
    if (!items.length || S.later[origin] === key) {
      if (node) { node.remove(); if (typeof syncDismissAll === 'function') syncDismissAll(); }
      return;
    }
    if (node && node.dataset.key === key) return;
    if (!node) {
      node = el('div', 'card plain mem-cardlet');
      node.dataset.memoryCard = origin;
      cards.append(node);
    }
    node.dataset.key = key;
    const kids = [el('div', 'card-kicker', origin === 'dream' ? 'Dream diary' : 'Worth remembering?')];
    if (origin === 'dream') kids.push(el('div', 'card-text', 'Going over your recent notes, these seemed worth keeping.'));
    const ul = el('ul', 'mem-card-list');
    for (const p of items.slice(0, 5)) {
      const li = el('li');
      li.append(mine(el('span', 'mem-fact', p.text)));
      const keep = button('Remember', 'btn primary mem-small', () => send({ type: 'memory_suggestion', id: p.id, action: 'keep' }));
      const drop = button('Not this', 'btn mem-small', () => send({ type: 'memory_suggestion', id: p.id, action: 'dismiss' }));
      keep.setAttribute('aria-label', `${T('Remember')}: ${p.text}`);
      drop.setAttribute('aria-label', `${T('Not this')}: ${p.text}`);
      const actions = el('span', 'mem-actions');
      actions.append(keep, drop);
      li.append(actions);
      ul.append(li);
    }
    kids.push(ul);
    if (items.length > 5) kids.push(el('div', 'card-text', countLine(items.length - 5, '1 more in Settings › Memory.', '{n} more in Settings › Memory.')));
    const actions = el('div', 'card-actions');
    actions.append(
      button('Remember all', 'btn', () => send({ type: 'memory_suggestions_all', action: 'keep', origin })),
      button('Later', 'btn', () => { S.later[origin] = key; card(origin, items); }),
    );
    kids.push(actions);
    node.replaceChildren(...kids);
    if (typeof syncDismissAll === 'function') syncDismissAll();
  }

  // ── a fired intent's "Do it"; the new kinds of heads-up ──

  if (typeof ALERT_KICKERS === 'object' && ALERT_KICKERS) {
    ALERT_KICKERS.intent = 'Reminder';
    ALERT_KICKERS.commitment = 'Promise';
  }
  if (window.GALAXY_SOURCES) {
    window.GALAXY_SOURCES.colors.journal = '#d9f99d';
    window.GALAXY_SOURCES.names.journal = 'Journal';
  }

  function addDoIt(ev) {
    if (!ev.doable) return;
    const node = $('cards') && $('cards').querySelector(`[data-alert="${CSS.escape(String(ev.key || ''))}"]`);
    if (!node || node.querySelector('.mem-doit')) return;
    const actions = node.querySelector('.card-actions');
    const doIt = button('Do it', 'btn primary mem-doit', () => {
      send({ type: 'memory_intent_run', id: ev.id });
      node.remove();
      if (typeof syncDismissAll === 'function') syncDismissAll();
    });
    if (actions) actions.prepend(doIt);
  }

  // ── Escape: the open sheet closes, and only it ──

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !sheetOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    if (S.editing) { S.editing = ''; render(S.tab); } else if (S.preview) { S.preview = null; render(S.tab); } else closeSheet();
  }, true);

  // ── the hub's events ──

  // Words put together with counts and dates ("People 2", "Until Oct 5") follow the language
  // once its Chinese has loaded: the rows, the cards and the open sheet are drawn again.
  function followLanguage(prefs) {
    const lang = (prefs && prefs.language) === 'zh' ? 'zh' : 'en';
    if (lang === S.lang) return;
    S.lang = lang;
    const again = () => { renderLines(); syncCards(true); if (sheetOpen()) render(S.tab); };
    Promise.resolve(window.jarvisI18n ? window.jarvisI18n.setLang(lang) : null).then(again, again);
  }

  F.on('hello', (ev) => {
    if (ev.prefs) S.features = { ...(ev.prefs.features || {}) };
    if (ev.prefs) followLanguage(ev.prefs);
    if (Array.isArray(ev.memory)) S.facts = ev.memory;
    settingsGroup();
    renderLines();
    send({ type: 'memory_state' });
  }, { replay: true });

  F.on('prefs', (ev) => {
    S.features = { ...(ev.features || {}) };
    renderLines();
    if (sheetOpen()) render(S.tab);
    followLanguage(ev);
  });

  F.on('memory', (ev) => {
    S.facts = ev.items || [];
    if (S.editing && !S.facts.some((f) => f.id === S.editing)) S.editing = '';
    renderLines();
    if (sheetOpen() && S.tab === 'facts') render('facts');
  }, { replay: true });

  F.on('memory_state', (ev) => {
    S.state = ev;
    renderLines();
    syncCards();
    if (sheetOpen()) render(S.tab);
  });

  F.on('memory_forget_preview', (ev) => {
    S.preview = ev;
    if (sheetOpen() && S.tab === 'facts') render('facts');
  });

  F.on('memory_person', (ev) => {
    S.person = ev;
    if (sheetOpen() && S.tab === 'people') render('people');
  });

  F.on('memory_import_review', (ev) => {
    if (ev.error) { S.review = null; S.reviewError = ev.error; }
    else if (ev.done) { S.review = null; S.reviewError = ''; }
    else {
      S.review = ev;
      S.reviewError = '';
      S.reviewPicks = new Map(ev.items.map((i, n) => [i.id, { on: n < (ev.room || 0), text: i.text, category: i.category }]));
      // Ticked only when it wouldn't replace what the owner already wrote.
      const had = (S.state && S.state.about) || {};
      S.reviewAbout = Boolean(ev.about) && !had.about;
      S.reviewBehave = Boolean(ev.behave) && !had.behave;
    }
    if (!sheetOpen()) openSheet('import');
    else if (S.tab !== 'import') selectTab('import');
    else render('import');
  });

  F.on('memory_intent_fired', (ev) => addDoIt(ev));

  window.addEventListener('jarvis-features-ready', () => { settingsGroup(); renderLines(); });
  settingsGroup();
})();
