// The second brain, grown (jarvis.features.brain): the Settings row for search by meaning,
// and the galaxy's search (the hub's search by words and meaning, not only titles), its
// source filters and time slider. Everything shown that came from the owner's data carries
// data-no-i18n.
(() => {
  'use strict';

  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, $, send } = F;

  // As jarvis.brain_sources.SEMANTIC keeps it (the prefs event carries only what's been
  // changed from it).
  const SWITCHES = [
    { key: 'brain_semantic', on: false, kind: 'semantic', title: 'Search by meaning',
      small: 'Finds notes about what you ask even when they use other words, with Apple’s on-device language models (English and Chinese). The first time, macOS may download Apple’s model.' },
  ];
  // The galaxy's filters: what each chip shows.
  const GROUPS = [
    ['notes', 'Notes', ['notes']],
    ['mail', 'Mail', ['mail']],
    ['messages', 'Messages', ['messages']],
    ['files', 'Files', ['files', 'computer']],
    ['bsh', 'BSH', ['bsh']],
    ['research', 'Research', ['research']],
    ['meetings', 'Meetings', ['meetings']],
    ['videos', 'Videos', ['videos']],
    ['photos', 'Photos', ['photos']],
  ];
  const SEARCH_WAIT = 250;
  const RESULTS = 30;
  const LIT = 8;  // results lit up (and labelled) in the galaxy: the rest are in the list
  const DAY = 86400000;
  const windowId = Math.random().toString(36).slice(2, 8);

  let features = {};
  const count = (n) => Number(n || 0).toLocaleString('en-US');
  const locale = () => (typeof uiLocale === 'function' ? uiLocale() : undefined);
  const color = (source) => (window.GALAXY_SOURCES && window.GALAXY_SOURCES.colors[source]) || '#9fb3c8';
  const sourceName = (source) => (window.GALAXY_SOURCES && window.GALAXY_SOURCES.names[source]) || source;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };
  const button = (cls, text) => { const b = el('button', cls, text); b.type = 'button'; return b; };
  const dayText = (t) => new Date(t * DAY).toLocaleDateString(locale(), { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });

  // ── Settings ──

  function current(s) {
    return Object.prototype.hasOwnProperty.call(features, s.key) ? features[s.key] === true : s.on;
  }

  function buildSettings() {
    const anchor = $('fda-btn');
    if (!anchor || $('sw-brain_semantic')) return;
    const group = anchor.parentElement;
    for (const s of SWITCHES) {
      const row = el('div', 'row');
      const label = el('span');
      label.append(el('strong', '', s.title));
      if (s.small) label.append(el('small', '', s.small));
      const sw = button('switch');
      sw.id = `sw-${s.key}`;
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-label', s.title);
      sw.addEventListener('click', () => toggle(s));
      row.append(label, sw);
      group.insertBefore(row, anchor);
      if (s.kind === 'semantic') {
        const status = el('p', 'small-status brain-semantic-status');
        status.id = 'brain-semantic-status';
        status.hidden = true;
        group.insertBefore(status, anchor);
      }
    }
    renderSwitches();
  }

  function renderSwitches() {
    for (const s of SWITCHES) {
      const sw = $(`sw-${s.key}`);
      if (sw) sw.setAttribute('aria-checked', String(current(s)));
    }
  }

  function toggle(s) {
    const on = !current(s);
    features = { ...features, [s.key]: on };  // shown now; the prefs event confirms it
    renderSwitches();
    send({ type: 'brain_semantic', on });
  }

  function applyPrefs(p) {
    if (!p) return;
    features = { ...(p.features || {}) };
    renderSwitches();
  }

  function semanticText(ev) {
    const part = `${count(ev.vectors)} of ${count(ev.wanted)} passages searchable by meaning; the rest come as the brain updates.`;
    switch (ev.state) {
      case 'preparing': return 'Getting search by meaning ready…';
      case 'downloading': return 'macOS is downloading Apple’s language model (once). This can take a few minutes.';
      case 'building': return 'Making vectors in the background…';
      case 'waiting': return ev.wanted ? part : 'Vectors come with the next update of the brain.';
      case 'ready': return ev.wanted > ev.vectors ? part : `Ready: ${count(ev.vectors)} passages searchable by meaning.`;
      case 'unavailable': return 'Apple’s language model isn’t on this Mac yet. Turn this off and on again to download it.';
      case 'error':
        if (ev.detail === 'helper') return 'Search by meaning needs Xcode’s command line tools to build its helper.';
        if (String(ev.detail || '').startsWith('the helper stopped')) return 'Search by meaning’s helper stopped; it tries again at the next update.';
        return 'Search by meaning couldn’t start this time; it tries again at the next update.';
      default: return '';
    }
  }

  function renderSemantic(ev) {
    features = { ...features, brain_semantic: !!ev.on };
    renderSwitches();
    const box = $('brain-semantic-status');
    if (!box) return;
    const text = semanticText(ev);
    box.hidden = !text;
    box.textContent = text;
  }

  // ── the galaxy ──

  const filter = { off: new Set(), from: null, to: null, min: 0, max: 0, dated: 0 };
  const search = { q: '', seq: 0, wanted: '', fly: '', items: [] };
  let ui = null;

  function buildGalaxy() {
    const root = $('galaxy');
    if (!root || ui) return;
    root.classList.add('brain-filters-on');
    const q = $('galaxy-q');
    if (q) q.placeholder = 'Search your second brain…';
    const results = el('section', 'brain-results');
    results.id = 'brain-results';
    results.hidden = true;
    results.setAttribute('aria-label', 'Search results');
    const head = el('p', 'brain-results-head');
    const list = el('ol', 'brain-hits');
    results.append(head, list);
    const bar = el('div', 'brain-filters');
    const chips = el('div', 'brain-chips');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'Sources');
    const time = el('div', 'brain-time');
    const label = el('p', 'brain-time-label');
    const from = el('input');
    from.type = 'range';
    from.id = 'brain-from';
    from.setAttribute('aria-label', 'From');
    const to = el('input');
    to.type = 'range';
    to.id = 'brain-to';
    to.setAttribute('aria-label', 'Until');
    const sliders = el('div', 'brain-sliders');
    sliders.append(from, to);
    time.append(label, sliders);
    bar.append(chips, time);
    root.append(results, bar);
    ui = { root, results, head, list, chips, time, label, from, to };
    for (const input of [from, to]) {
      input.addEventListener('input', () => {
        let a = Number(from.value), b = Number(to.value);
        if (a > b) { if (input === from) b = a; else a = b; from.value = String(a); to.value = String(b); }
        filter.from = a;
        filter.to = b;
        renderTime();
        applyFilters();
      });
      input.addEventListener('change', () => { if (search.q) runSearch(false); });
    }
    if (q) q.addEventListener('input', () => { clearTimeout(search.timer); search.timer = setTimeout(() => runSearch(false), SEARCH_WAIT); });
    // The galaxy's own search matched titles; this one asks the hub (words and meaning).
    document.addEventListener('submit', (e) => {
      if (!e.target || e.target.id !== 'galaxy-search') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      clearTimeout(search.timer);
      runSearch(true);
    }, true);
    // Filters are for the open galaxy: the ambient one (Jarvis showing what it draws on)
    // shows every star.
    new MutationObserver(() => {
      if (ui.root.hidden) galaxy.setVisible(null);
      else { applyFilters(); highlightResults(); }
    }).observe(root, { attributes: true, attributeFilter: ['hidden'] });
    renderGalaxyData();
  }

  function renderGalaxyData() {
    if (!ui) return;
    const nodes = galaxy.nodes || [];
    const counts = {};
    let min = Infinity, max = -Infinity, dated = 0;
    for (const n of nodes) {
      counts[n.source] = (counts[n.source] || 0) + 1;
      if (Number.isFinite(n.t)) { dated++; if (n.t < min) min = n.t; if (n.t > max) max = n.t; }
    }
    const known = new Set(GROUPS.flatMap((g) => g[2]));
    const groups = GROUPS.map(([id, name, sources]) => [id, name, sources, sources.reduce((a, s) => a + (counts[s] || 0), 0)]);
    const other = Object.keys(counts).filter((s) => !known.has(s));
    if (other.length) groups.push(['other', 'Other', other, other.reduce((a, s) => a + counts[s], 0)]);
    ui.groups = groups.filter((g) => g[3] > 0);
    ui.chips.replaceChildren(...ui.groups.map(([id, name, sources, n]) => {
      const chip = button('brain-chip');
      chip.dataset.group = id;
      chip.setAttribute('aria-pressed', String(!filter.off.has(id)));
      const dot = el('i');
      dot.style.background = color(sources[0]);
      chip.append(dot, el('span', '', name), mine(el('small', '', count(n))));
      chip.addEventListener('click', () => {
        if (filter.off.has(id)) filter.off.delete(id); else filter.off.add(id);
        chip.setAttribute('aria-pressed', String(!filter.off.has(id)));
        applyFilters();
        if (search.q) runSearch(false);
      });
      return chip;
    }));
    const wasFull = filter.from === null || (filter.from <= filter.min && filter.to >= filter.max);
    filter.dated = dated;
    filter.min = dated ? min : 0;
    filter.max = dated ? max : 0;
    if (wasFull) { filter.from = filter.min; filter.to = filter.max; }
    filter.from = Math.min(Math.max(filter.from, filter.min), filter.max);
    filter.to = Math.max(Math.min(filter.to, filter.max), filter.from);
    for (const input of [ui.from, ui.to]) { input.min = String(filter.min); input.max = String(filter.max); }
    ui.from.value = String(filter.from);
    ui.to.value = String(filter.to);
    ui.time.hidden = dated < 2 || filter.min === filter.max;
    renderTime();
    applyFilters();
  }

  function timeLimited() {
    return filter.dated > 1 && (filter.from > filter.min || filter.to < filter.max);
  }

  function renderTime() {
    if (!ui) return;
    const span = Math.max(1, filter.max - filter.min);
    ui.time.style.setProperty('--from', `${((filter.from - filter.min) / span) * 100}%`);
    ui.time.style.setProperty('--to', `${((filter.to - filter.min) / span) * 100}%`);
    if (!timeLimited()) {
      ui.label.replaceChildren(el('span', '', 'All time'));
      return;
    }
    ui.label.replaceChildren(el('span', '', 'From'), mine(el('time', '', dayText(filter.from))),
      el('span', '', 'to'), mine(el('time', '', dayText(filter.to))));
  }

  function hiddenSources() {
    const off = new Set();
    for (const g of ui.groups || []) if (filter.off.has(g[0])) g[2].forEach((s) => off.add(s));
    return off;
  }

  // Which stars show: those of the sources switched on, changed within the time chosen
  // (the undated only while it's all time). null: every star.
  function mask() {
    const off = hiddenSources();
    const timed = timeLimited();
    if (!off.size && !timed) return null;
    const nodes = galaxy.nodes;
    const shown = new Uint8Array(nodes.length);
    let n = 0;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (off.has(node.source)) continue;
      if (timed && !(Number.isFinite(node.t) && node.t >= filter.from && node.t <= filter.to)) continue;
      shown[i] = 1;
      n++;
    }
    return { shown, n };
  }

  let applying = 0;
  function applyFilters() {
    if (applying) return;
    applying = requestAnimationFrame(() => {
      applying = 0;
      if (!ui || ui.root.hidden) return;
      const m = mask();
      galaxy.setVisible(m ? m.shown : null);
      const total = (galaxy.nodes || []).length;
      const line = $('galaxy-count');
      if (line && total) line.textContent = m ? `${count(m.n)} of ${count(total)} notes shown` : `${total} notes`;
    });
  }

  function searchFilters() {
    const out = {};
    const off = hiddenSources();
    if (off.size) {
      out.sources = [...new Set((galaxy.nodes || []).map((n) => n.source))].filter((s) => !off.has(s));
      if (!out.sources.length) out.sources = ['none'];
    }
    if (timeLimited()) {
      out.since = new Date(filter.from * DAY).toISOString().slice(0, 10);
      out.until = new Date(filter.to * DAY).toISOString().slice(0, 10);
    }
    return out;
  }

  function runSearch(fly) {
    const q = ($('galaxy-q') ? $('galaxy-q').value : '').trim();
    search.q = q;
    if (!q) {
      search.items = [];
      search.wanted = '';
      renderResults();
      galaxy.highlight([]);
      return;
    }
    const seq = `${windowId}:${++search.seq}`;
    search.wanted = seq;
    search.fly = fly ? seq : '';
    send({ type: 'brain_search', q, k: RESULTS, seq, ...searchFilters() });
  }

  function onResults(ev) {
    if (!ui || ev.seq !== search.wanted) return;  // another window's, or an older one
    search.items = ev.items || [];
    renderResults();
    highlightResults();
    if (search.fly === ev.seq && search.items.length) {
      search.fly = '';
      openNote(search.items[0].id);
    }
  }

  function highlightResults() {
    if (search.q) galaxy.highlight(search.items.slice(0, LIT).map((h) => h.id));
  }

  function openNote(id) {
    if (typeof setGalaxyMode === 'function' && galaxyMode !== 'open') setGalaxyMode('open');
    galaxy.flyTo(id);
    selectedNote = id;
    send({ type: 'note', id });
  }

  function hitRow(h) {
    const b = button('brain-hit');
    const dot = el('i');
    dot.style.background = color(h.source);
    const title = mine(el('strong', '', h.title.length > 90 ? `${h.title.slice(0, 89)}…` : h.title));
    const meta = el('small', 'brain-hit-meta');
    meta.append(el('span', '', sourceName(h.source)));
    const day = /^\d{4}-\d{2}-\d{2}/.test(h.modified || '') ? new Date(`${h.modified.slice(0, 10)}T00:00:00Z`) : null;
    if (day && !Number.isNaN(day.getTime())) meta.append(mine(el('span', '', day.toLocaleDateString(locale(), { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }))));
    if (h.match === 'meaning') meta.append(el('span', 'brain-by-meaning', 'by meaning'));
    const head = el('span', 'brain-hit-head');
    head.append(dot, title);
    b.append(head, meta);
    if (h.excerpt) b.append(mine(el('span', 'brain-excerpt', h.excerpt)));
    b.addEventListener('click', () => openNote(h.id));
    const li = el('li');
    li.append(b);
    return li;
  }

  function renderResults() {
    if (!ui) return;
    ui.results.hidden = !search.q;
    if (!search.q) return;
    const n = search.items.length;
    ui.head.hidden = !n;
    ui.head.textContent = n === 1 ? '1 result' : `${n} results`;
    ui.list.replaceChildren(...(n ? search.items.map(hitRow) : [el('li', 'brain-empty', 'Nothing in your second brain matches that.')]));
  }

  // ── wiring ──

  F.on('hello', (ev) => { applyPrefs(ev.prefs); send({ type: 'brain_semantic_status' }); }, { replay: true });
  F.on('prefs', applyPrefs, { replay: true });
  F.on('brain_semantic', renderSemantic, { replay: true });
  F.on('brain', (ev) => { if (ev.state !== 'building') send({ type: 'brain_semantic_status' }); });
  F.on('galaxy', () => renderGalaxyData(), { replay: true });
  F.on('brain_results', onResults);
  buildSettings();
  buildGalaxy();
})();
