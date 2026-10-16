// Eden Code settings as macOS System Settings (the owner's mockup "S1 · Settings like System
// Settings"), in Eden Code's own window only (body.eden-code; Eden Secretary's settings and the
// Code panel inside Eden Secretary keep their look). A frosted sidebar with the search field and
// eleven sections, each with its coloured tile; beside it a white panel with the section's title,
// a hero card saying what the section is for, and its groups as inset lists.
//
// Nothing the features draw is rewritten. They go on adding their "p.jcs-label + div.jcs-group"
// pairs to #jcs-general and their tabs (a .jcs-tabs button + a .jcs-body panel) to .jcs-card,
// as they always have; this file re-homes each of those blocks into a section by the PLACES
// table below, and only shows the chosen section's. Their elements stay where their code put
// them (#jcs-general is laid out with display: contents, so its blocks are items of the panel's
// column and CSS order puts them in section order), so their own lookups, listeners and
// insertBefore(.jcs-foot)s keep working. A block the table doesn't know goes to General.
//
// Where a block goes, first match wins:
//   1. data-ecs-section="<section id>" on its label or group (the way for a new feature to say
//      where it belongs without touching this file);
//   2. the PLACES table: a group's '#id' or '.class', a tab's 'tab:<data-tab>', or words its
//      heading contains (case-insensitive; its Chinese too, when the words are a whole heading
//      the dictionary knows). Within a section, blocks come in the table's order;
//   3. FALLBACK (General).
// To add one: put a row in PLACES, e.g. ['limits', 'Cloud budget'] — or, from the feature,
// group.dataset.ecsSection = 'limits'.
//
// Search (the sidebar's field) filters rows (.jcs-row, a provider's card) across every section
// by their words, all of them, shows the hits grouped by section in sidebar order, and marks the
// words found (the CSS Custom Highlight API: no text node is touched, so a feature redrawing its
// row is never broken by it). A heading that matches shows its whole group.
//
// app.js's selectJcsTab and the features' tab observers still run: the tabs row is hidden, and a
// section's panels have their tabs marked selected (so the features that draw on showing, like
// Projects and Machines, draw). openJcSettings('limits') from anywhere opens the section that
// holds that tab. Below 760px wide the sidebar is a list that pushes the section, with Back.
//
// Cost policy: no model calls; window-only layout. Pure helpers (sectionOf, matchRanges,
// searchPlan, SECTIONS, PLACES) are exported for node --test (tests/web/code-settings.test.mjs).
(function (root) {
  'use strict';

  // [id, label, tile colour, glyph (24×24 stroke paths), hero title, hero line]
  const SECTIONS = [
    ['general', 'General', '#8E8E93', '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
      'General', 'How new sessions start, what happens while one works, your projects and snippets.'],
    ['models', 'Models & Router', '#5E5CE6', '<path d="M4 12h5l3-7 3 14 3-7h2"/>',
      'Model Router', 'Picks the model and effort for each message and falls back when one fails. Other companies’ models use your own keys.'],
    ['limits', 'Limits & Spending', '#34C759', '<path d="M12 3v18M7 8h7a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h8"/>',
      'Limits & Spending', 'What sessions may spend, heads-ups before a limit, the forecast and what your time is worth.'],
    ['permissions', 'Permissions & Sandbox', '#0A84FF', '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
      'Permissions & Sandbox', 'What a session may do without asking, Touch ID for risky steps, and isolated copies to work in.'],
    ['rules', 'Rules & Guardrails', '#FF9500', '<path d="M4 6h16M4 12h10M4 18h6"/>',
      'Rules & Guardrails', 'Your rules enforced on every step, and the guesses a session makes instead of asking.'],
    ['receipts', 'Receipts & Checks', '#30B0C7', '<path d="M5 12l4 4 10-10"/>',
      'Receipts & Checks', 'What each turn proves: the tests it ran, that they weren’t weakened, and the checks behind every receipt.'],
    ['security', 'Secrets & Security', '#FF3B30', '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
      'Secrets & Security', 'Scanning changes with your security tools, and keeping keys and secrets out of sessions.'],
    ['voice', 'Voice', '#AF52DE', '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/>',
      'Voice', 'Talking to Eden Code: what it says while it works, and how much of each reply it reads aloud.'],
    ['iphone', 'iPhone', '#1C1C1E', '<rect x="7" y="3" width="10" height="18" rx="2"/>',
      'iPhone', 'Start at the desk and carry on from your phone.'],
    ['git', 'Git & Integrations', '#636366', '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v4a4 4 0 0 0 4 4h6"/>',
      'Git & Integrations', 'GitHub, Linear, Slack, production alerts, other machines and control from code.'],
    ['labs', 'Labs', '#FF2D55', '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/>',
      'Labs', 'Eden Code surfaces that aren’t finished, off until you switch them on. A change takes effect at the next start.'],
  ].map(([id, label, color, glyph, title, text]) => ({ id, label, color, glyph, title, text }));
  const SECTION_IDS = new Set(SECTIONS.map((s) => s.id));
  const FALLBACK = 'general';

  // [section, matcher, heading for a group that has no label of its own (optional)].
  // A matcher is '#id', '.class', 'tab:<data-tab>' or words the heading contains. The order is
  // the order blocks show in within a section. Several rows name what other branches are still
  // building (the coordinator merges them): they land in place on arrival.
  const PLACES = [
    ['general', 'New sessions start with'],
    ['general', 'While it works'],
    ['general', 'While you’re busy'],
    ['general', 'Delegat'],
    ['general', 'Exterminator Mode'],
    ['general', 'tab:projects'],
    ['general', 'tab:snippets'],
    ['general', 'Debugger'],
    ['general', 'Teams'],
    ['general', '#cw-parity', 'On this PC'],  // (Windows: what works on this PC)
    ['general', '.jcs-foot'],
    ['general', '#jcs-more-row'],

    ['models', 'Model Router'],
    ['models', '#cr-fallbacks'],
    ['models', '#jcs-radar', 'Engine'],
    ['models', 'Engine'],
    ['models', 'Radar'],
    ['models', 'Local model'],
    ['models', 'Smaller models'],  // (code-lean: local and small models)
    ['models', 'On this Mac'],
    ['models', 'Other coding agents'],
    ['models', '#graduated-group', 'Coding agents'],  // (labs.js: Other agents' own switch)
    ['models', 'Coding agents'],
    ['models', 'Evals'],
    ['models', 'tab:models'],

    ['limits', 'tab:limits'],
    ['limits', 'Forecast'],
    ['limits', 'Spending'],
    ['limits', 'Limits'],
    ['limits', 'Budget'],
    ['limits', '#jcs-ledger', 'Productivity ledger'],
    ['limits', 'Ledger'],

    ['permissions', 'Safety'],
    ['permissions', 'Touch ID'],
    ['permissions', 'Permission'],
    ['permissions', 'Sandbox'],
    ['permissions', 'Isolated copies'],
    ['permissions', 'Container'],
    ['permissions', 'Your context'],  // (code-getstarted: life context, asked per project)

    ['rules', 'Guardrails'],
    ['rules', 'Assumptions'],
    ['rules', 'Rules'],
    ['rules', 'Lessons'],

    ['receipts', 'Receipts'],
    ['receipts', 'Test integrity'],
    ['receipts', 'Provenance'],
    ['receipts', 'Checks'],
    ['receipts', 'LSP'],
    ['receipts', 'Language server'],
    ['receipts', 'Code intelligence'],

    ['security', 'Security'],
    ['security', 'Secrets'],
    ['security', 'Dependenc'],

    ['voice', '#ecs-voice'],
    ['voice', 'Voice'],

    ['iphone', '#ecs-iphone'],
    ['iphone', 'iPhone'],
    ['iphone', 'phone'],

    ['git', 'GitHub'],
    ['git', 'GitLab'],
    ['git', 'Jira'],
    ['git', 'Linear'],
    ['git', 'Slack'],
    ['git', 'Production alerts'],
    ['git', 'Rollout'],
    ['git', 'Watching after a merge'],  // (code-rollouts)
    ['git', 'Merge queue'],
    ['git', 'OpenTelemetry'],  // (code-replay: the export)
    ['git', 'Cloud'],
    ['git', 'tab:eden-cloud'],  // (code-eden-cloud: its tab)
    ['git', 'tab:machines'],
    ['git', 'Control from code'],
    ['git', 'Hosts'],
    ['git', 'Git'],

    ['labs', '#labs-group'],
    ['labs', 'Labs'],
  ];

  // Where one block goes. d: { explicit, id, classes, tab, heading } (all optional);
  // t(text) gives a heading's Chinese (the window's own dictionary) when there is one.
  // Returns { section, rule, heading }: rule is the PLACES row's index (PLACES.length when
  // the block fell back), heading the made-up heading for a group without a label.
  function sectionOf(d, t) {
    const desc = d || {};
    if (desc.explicit && SECTION_IDS.has(desc.explicit)) return { section: desc.explicit, rule: -1, heading: '' };
    const classes = new Set(desc.classes || []);
    const heading = String(desc.heading || '').replace(/\s+/g, ' ').trim();
    const lower = heading.toLowerCase();
    for (let i = 0; i < PLACES.length; i += 1) {
      const [section, m, made] = PLACES[i];
      let hit = false;
      if (m.startsWith('#')) hit = !!desc.id && desc.id === m.slice(1);
      else if (m.startsWith('.')) hit = classes.has(m.slice(1));
      else if (m.startsWith('tab:')) hit = !!desc.tab && desc.tab === m.slice(4);
      else if (heading) hit = lower.includes(m.toLowerCase()) || (typeof t === 'function' && t(m) !== m && heading === t(m));
      if (hit) return { section, rule: i, heading: made || '' };
    }
    return { section: FALLBACK, rule: PLACES.length, heading: '' };
  }

  // The search's words: lower-case, split on spaces.
  function words(query) {
    return String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  }
  // Every place any of the query's words is in text, as merged [start, end) ranges.
  function occurrences(text, query) {
    const hay = String(text || '').toLowerCase();
    const ranges = [];
    for (const w of words(query)) {
      for (let at = hay.indexOf(w); at >= 0; at = hay.indexOf(w, at + w.length)) ranges.push([at, at + w.length]);
    }
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    return merged;
  }
  // Where the query's words are in text (as occurrences), or null when any word is missing:
  // every word must be there, in any order.
  function matchRanges(text, query) {
    const ws = words(query);
    if (!ws.length) return null;
    const hay = String(text || '').toLowerCase();
    if (!ws.every((w) => hay.includes(w))) return null;
    return occurrences(text, query);
  }
  // What a search shows. blocks: [{ section, heading, rows: [text…] }] in any order. A block
  // shows when its heading has every word (all its rows), or when one of its rows has (those
  // rows), or — a block with no rows — when its own text has. Sections in sidebar order.
  // Returns [{ section, blocks: [{ index, all, rows: [row index…] }] }].
  function searchPlan(blocks, query) {
    if (!words(query).length) return [];
    const by = new Map();
    (blocks || []).forEach((b, index) => {
      const rows = b.rows || [];
      let hit = null;
      if (matchRanges(b.heading, query)) hit = { index, all: true, rows: rows.map((_, i) => i) };
      else if (rows.length) {
        const found = rows.map((r, i) => (matchRanges(r, query) ? i : -1)).filter((i) => i >= 0);
        if (found.length) hit = { index, all: false, rows: found };
      } else if (matchRanges(b.text, query)) hit = { index, all: true, rows: [] };
      if (!hit) return;
      const section = SECTION_IDS.has(b.section) ? b.section : FALLBACK;
      if (!by.has(section)) by.set(section, []);
      by.get(section).push(hit);
    });
    return SECTIONS.filter((s) => by.has(s.id)).map((s) => ({ section: s.id, blocks: by.get(s.id) }));
  }

  const api = { SECTIONS, PLACES, FALLBACK, sectionOf, matchRanges, occurrences, searchPlan, words };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  root.jarvisCodeSettings = api;

  const F = root.jarvisFeatures;
  const doc = root.document;
  if (!F || !doc || !doc.body || doc.body.dataset.app !== 'eden-code' || F.splitPane) return;
  const sheet = doc.getElementById('jc-settings');
  const card = sheet && sheet.querySelector('.jcs-card');
  const tabs = card && card.querySelector('.jcs-tabs');
  const general = doc.getElementById('jcs-general');
  if (!card || !tabs || !general || card.classList.contains('ecs')) return;
  const { el } = F;
  const t = (s) => F.t(s);
  const NS = 'http://www.w3.org/2000/svg';
  const SECTION = Object.fromEntries(SECTIONS.map((s) => [s.id, s]));
  const STORE = 'eden.code.settings.section';

  function glyph(s, size, stroke) {
    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', '#fff');
    svg.setAttribute('stroke-width', String(stroke));
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = s.glyph;
    return svg;
  }
  function tile(s, cls) {
    const span = el('span', cls || 'ecs-tile');
    span.style.background = s.color;
    span.append(glyph(s, cls === 'ecs-hero-tile' ? 28 : cls === 'ecs-head-tile' ? 15 : 13, cls === 'ecs-hero-tile' ? 2 : 2.4));
    return span;
  }

  // ── the frame: the sidebar and the white panel ──

  card.classList.add('ecs');
  sheet.classList.add('ecs-sheet');
  const side = el('nav', 'ecs-side');
  side.setAttribute('aria-label', t('Settings sections'));
  const lights = el('div', 'ecs-lights');
  const close = doc.getElementById('jcs-close');
  // Just the close button, an X in a rounded square: no yellow and green dots, which did nothing.
  if (close) { close.classList.add('ecs-close'); lights.append(close); }
  const title = doc.getElementById('jcs-title');
  if (title) { title.classList.add('ecs-vh'); side.append(title); }
  const search = el('input', 'ecs-search');
  search.type = 'search';
  search.id = 'ecs-search';
  search.placeholder = t('Search');
  search.setAttribute('aria-label', t('Search settings'));
  search.autocomplete = 'off';
  search.spellcheck = false;
  const list = el('ul', 'ecs-list');
  const items = {};
  for (const s of SECTIONS) {
    const li = el('li');
    const b = el('button', 'ecs-item');
    b.type = 'button';
    b.dataset.section = s.id;
    b.append(tile(s), el('span', 'ecs-item-label', s.label));
    b.addEventListener('click', () => choose(s.id, { push: true, focusBack: true }));
    li.append(b);
    list.append(li);
    items[s.id] = b;
  }
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const all = [...list.querySelectorAll('.ecs-item:not([hidden])')];
    const at = all.indexOf(doc.activeElement);
    if (at < 0) return;
    e.preventDefault();
    const next = all[(at + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length];
    next.focus();
    choose(next.dataset.section);
  });
  lights.append(search);  // compact: the close button and the search share one row
  side.append(lights, list);

  const main = el('section', 'ecs-main');
  const head = el('header', 'ecs-head');
  const back = el('button', 'ecs-back', '‹');
  back.type = 'button';
  back.setAttribute('aria-label', t('Back'));
  const heading = el('h1', 'ecs-title');
  heading.id = 'ecs-title';
  // S1b (compact): the section's tile and one-line description sit in the header beside its
  // title; there is no big card at the top of the column.
  const headText = el('div', 'ecs-head-text');
  head.append(back);
  const scroll = el('div', 'ecs-scroll');
  const col = el('div', 'ecs-col');
  const hero = el('section', 'ecs-hero');
  const heroTile = el('span', 'ecs-hero-slot');
  const heroText = el('div', 'ecs-hero-text');
  const heroTitle = el('div', 'ecs-hero-title');
  const heroLine = el('div', 'ecs-hero-line');
  headText.append(heading, heroLine);
  head.append(heroTile, headText);
  heroText.append(heroTitle);
  hero.append(heroText);
  hero.hidden = true;  // (kept for the column's order; the header shows the section now)
  const showHead = (on) => { heroTile.hidden = !on; heroLine.hidden = !on; };
  const none = el('p', 'ecs-none', t('No settings match your search.'));
  none.setAttribute('role', 'status');
  none.hidden = true;
  col.append(hero, none);
  scroll.append(col);
  main.append(head, scroll);
  card.append(side, main);

  // ── Voice and iPhone: Eden Code's own prefs that were only in the shared sheet ──

  function switchRow(id, label, note, onClick) {
    const row = el('div', 'jcs-row');
    const text = el('span');
    text.append(doc.createTextNode(label), el('small', '', note));
    const sw = el('button', 'jcs-switch');
    sw.type = 'button';
    sw.id = id;
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', label);
    sw.setAttribute('aria-checked', 'false');
    sw.addEventListener('click', onClick);
    row.append(text, sw);
    return row;
  }
  const say = (fn) => (typeof root.setPrefs === 'function' ? fn() : undefined);
  let shared = {};
  let features = {};
  const voiceLabel = el('p', 'jcs-label', t('Voice coding'));
  const voice = el('div', 'jcs-group');
  voice.id = 'ecs-voice';
  voiceLabel.dataset.ecsSection = voice.dataset.ecsSection = 'voice';
  const sentences = el('select', 'jcs-select');
  sentences.id = 'ecs-sentences';
  sentences.setAttribute('aria-label', t('Reply length'));
  for (const [v, l] of [['2', 'Short (2)'], ['3', 'Normal (3)'], ['5', 'Long (5)'], ['8', 'Everything (8)']]) {
    const o = el('option', '', l);
    o.value = v;
    sentences.append(o);
  }
  sentences.addEventListener('change', () => say(() => root.setPrefs({ code_sentences: Number(sentences.value) })));
  const lengthRow = el('label', 'jcs-row');
  const lengthText = el('span');
  lengthText.append(doc.createTextNode('Reply length'), el('small', '', 'Sentences read aloud; the rest stays on screen'));
  lengthRow.append(lengthText, sentences);
  voice.append(
    switchRow('ecs-narrate', 'Narrate progress', 'Short notes like “Editing hub dot py” while it works',
      () => say(() => root.setPrefs({ code_narrate: shared.code_narrate === false }))),
    lengthRow,
  );
  const phoneLabel = el('p', 'jcs-label', t('On your phone'));
  const phone = el('div', 'jcs-group');
  phone.id = 'ecs-iphone';
  phoneLabel.dataset.ecsSection = phone.dataset.ecsSection = 'iphone';
  const handoffRow = el('div', 'jcs-row');
  const handoffText = el('span');
  handoffText.append(doc.createTextNode('Hand off and QR code'), el('small', '', 'Pin a session to your phone’s view, and the code to open its page'));
  const open = el('button', 'jc-btn small', 'Show…');
  open.type = 'button';
  open.addEventListener('click', () => { if (close) close.click(); F.openPane('phone'); });
  handoffRow.append(handoffText, open);
  phone.append(
    switchRow('ecs-phone-web', 'Eden Code on your phone', 'A web page on your network for following and answering sessions from the phone',
      () => F.send({ type: 'feature_prefs', changes: { code_phone_web: features.code_phone_web !== true } })),
    handoffRow,
  );
  const foot = general.querySelector('.jcs-foot');
  general.insertBefore(voiceLabel, foot);
  general.insertBefore(voice, foot);
  general.insertBefore(phoneLabel, foot);
  general.insertBefore(phone, foot);
  function drawOwn() {
    const n = doc.getElementById('ecs-narrate');
    if (n) n.setAttribute('aria-checked', String(shared.code_narrate !== false));
    sentences.value = String(shared.code_sentences || 3);
    const p = doc.getElementById('ecs-phone-web');
    if (p) p.setAttribute('aria-checked', String(features.code_phone_web === true));
  }
  const took = (p) => { if (!p) return; shared = p; if (p.features) features = p.features; drawOwn(); };
  F.on('hello', (ev) => took(ev.prefs), { replay: true });
  F.on('prefs', took, { replay: true });

  // ── the blocks: what each label + group pair, and each tab's panel, is ──

  let blocks = [];  // [{ nodes, section, rule, heading (label element or null), panel, tab }]
  const panels = () => [...col.querySelectorAll(':scope > .jcs-body')];
  const tabOf = new WeakMap();  // panel -> its tab's data-tab

  // Panels the features append to the card move into the column, in arrival order; each is
  // paired with its tab (#jcs-<tab> by id, else the first tab with no panel yet).
  function adopt() {
    for (const p of [...card.querySelectorAll(':scope > .jcs-body')]) col.append(p);
    const taken = new Set();
    const ps = panels();
    for (const p of ps) if (tabOf.has(p)) taken.add(tabOf.get(p));
    const tabIds = [...tabs.querySelectorAll('[role="tab"]')].map((b) => b.dataset.tab);
    for (const p of ps) {
      if (tabOf.has(p)) continue;
      let id = tabIds.find((x) => p.id === `jcs-${x}` && !taken.has(x));
      if (!id) id = tabIds.find((x) => !taken.has(x) && !ps.some((q) => q.id === `jcs-${x}`));
      if (id) { tabOf.set(p, id); taken.add(id); }
    }
  }

  function describe(nodes) {
    const label = nodes.find((n) => n.classList.contains('jcs-label')) || null;
    const body = nodes.find((n) => !n.classList.contains('jcs-label')) || null;
    const explicit = nodes.map((n) => n.dataset.ecsSection).find(Boolean) || '';
    return {
      label,
      d: {
        explicit,
        id: body ? body.id : '',
        classes: body ? [...body.classList] : [],
        heading: label ? label.textContent : '',
      },
    };
  }

  function collect() {
    adopt();
    const out = [];
    // #jcs-general: a label starts a block and takes the one element after it; anything else
    // is a block of its own.
    const kids = [...general.children].filter((n) => !n.classList.contains('ecs-made'));
    for (let i = 0; i < kids.length; i += 1) {
      const n = kids[i];
      const nodes = n.classList.contains('jcs-label') && kids[i + 1] && !kids[i + 1].classList.contains('jcs-label') ? [n, kids[++i]] : [n];
      const { label, d } = describe(nodes);
      const at = sectionOf(d, t);
      // A group with no label of its own gets the table's heading (made once, kept).
      let made = null;
      if (!label && at.heading && nodes[0].classList.contains('jcs-group')) {
        made = nodes[0].previousElementSibling && nodes[0].previousElementSibling.classList.contains('ecs-made') ? nodes[0].previousElementSibling : null;
        if (!made) { made = el('p', 'jcs-label ecs-made', at.heading); general.insertBefore(made, nodes[0]); }
      }
      out.push({ nodes: made ? [made, ...nodes] : nodes, section: at.section, rule: at.rule, label: label || made, panel: null });
    }
    for (const p of panels()) {
      if (p === general) continue;
      const tab = tabOf.get(p) || '';
      const at = sectionOf({ explicit: p.dataset.ecsSection, id: p.id, classes: [...p.classList], tab }, t);
      out.push({ nodes: [p], section: at.section, rule: at.rule, label: null, panel: p, tab });
    }
    // CSS order: section, then the table's row, then where the feature put it.
    const rank = Object.fromEntries(SECTIONS.map((s, i) => [s.id, i]));
    out.forEach((b, i) => {
      const base = (rank[b.section] + 1) * 100000 + (b.rule + 1) * 500 + i * 3;
      b.nodes.forEach((n, j) => { n.style.order = String(base + j); n.dataset.ecsIn = b.section; });
    });
    hero.style.order = '0';
    none.style.order = '1';
    blocks = out;
  }

  // ── showing a section ──

  let current = 'general';
  try { const saved = root.localStorage.getItem(STORE); if (saved && SECTION[saved]) current = saved; } catch (_) { /* no storage */ }
  const history = [];
  let mine = false;  // tabs' aria-selected being set by this file, not by app.js
  let hits = [];     // result section heads shown while searching

  // The tabs of the panels shown are marked selected (the features' observers show and draw
  // their panels); every other tab not.
  function markTabs(show) {
    mine = true;
    // Only what changes: a feature's observer may ask the backend again on every mark.
    for (const b of tabs.querySelectorAll('[role="tab"]')) {
      const on = String(show.has(b.dataset.tab));
      if (b.getAttribute('aria-selected') !== on) b.setAttribute('aria-selected', on);
    }
    // The features' own observers show (and draw) their panels as their tabs are marked; a
    // panel nobody shows or hides (app.js's two, or one without an observer) is set after them.
    // Setting a feature's panel first would tell its observer there's nothing to draw.
    Promise.resolve().then(() => {
      mine = false;
      for (const p of panels()) {
        const hide = !show.has(p === general ? 'general' : tabOf.get(p));
        if (p.hidden !== hide) p.hidden = hide;
      }
    });
  }

  function clearHits() {
    for (const h of hits) h.remove();
    hits = [];
    for (const n of col.querySelectorAll('.ecs-miss')) n.classList.remove('ecs-miss');
    if (root.CSS && CSS.highlights) CSS.highlights.delete('ecs-hit');
  }

  function apply() {
    collect();
    const query = search.value.trim();
    clearHits();
    card.classList.toggle('ecs-searching', !!query);
    if (!query) {
      const s = SECTION[current];
      for (const b of blocks) for (const n of b.nodes) n.classList.toggle('ecs-out', b.section !== current);
      const show = new Set(blocks.filter((b) => b.section === current).map((b) => (b.panel ? b.tab : 'general')));
      show.add('general');  // #jcs-general stays (display: contents); its blocks are filtered above
      markTabs(show);
      heroTile.replaceChildren(tile(s, 'ecs-head-tile'));
      heroTitle.textContent = s.title;
      heroLine.textContent = s.text;
      heading.textContent = s.label;
      showHead(true);
      none.hidden = true;
      for (const [id, b] of Object.entries(items)) {
        if (id === current) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      }
      back.disabled = !history.length && !narrow.matches;
      settle();
      return;
    }
    // Searching: every panel shown (so each has its rows drawn), only the hits visible.
    markTabs(new Set(['general', ...blocks.filter((b) => b.panel).map((b) => b.tab)]));
    // What's searched: each heading with the group under it (a panel can hold several), and
    // the rows outside any; each one's rows, or its words when it has no rows.
    const units = blocks.flatMap((b, index) => unitsOf(b).map((u) => ({ ...u, index, section: b.section })));
    const plan = searchPlan(units.map((u) => ({ section: u.section, heading: u.label ? u.label.textContent : '', rows: u.rows.map(rowText), text: u.text })), query);
    const shown = new Map();  // block -> the elements kept in it, each with all inside it
    const ranges = [];
    const rank = Object.fromEntries(SECTIONS.map((s, i) => [s.id, i]));
    for (const { section, blocks: found } of plan) {
      const s = SECTION[section];
      const h = el('button', 'ecs-result-head');
      h.type = 'button';
      h.append(tile(s), el('span', '', s.label));
      h.style.order = String((rank[section] + 1) * 100000);
      h.addEventListener('click', () => { search.value = ''; choose(section, { push: true }); });
      col.append(h);
      hits.push(h);
      for (const f of found) {
        const u = units[f.index];
        const b = blocks[u.index];
        if (!shown.has(b)) shown.set(b, new Set());
        const keep = shown.get(b);
        if (u.label) { keep.add(u.label); ranges.push(...textRanges(u.label, query)); }
        if (f.all) {
          for (const n of u.scope ? [u.scope] : b.nodes) { keep.add(n); if (!u.rows.length) ranges.push(...textRanges(n, query)); }
        }
        for (const i of f.rows) { keep.add(u.rows[i]); ranges.push(...textRanges(u.rows[i], query)); }
      }
    }
    // In a block shown, what isn't kept (nor holds something kept) is hidden.
    const prune = (n, keep) => {
      if (keep.has(n)) return;
      if ([...keep].some((k) => n.contains(k))) { for (const c of n.children) prune(c, keep); return; }
      n.classList.add('ecs-miss');
    };
    for (const [b, keep] of shown) for (const n of b.nodes) prune(n, keep);
    for (const b of blocks) for (const n of b.nodes) n.classList.toggle('ecs-out', !shown.has(b));
    if (root.CSS && CSS.highlights && root.Highlight && ranges.length) CSS.highlights.set('ecs-hit', new Highlight(...ranges));
    showHead(false);
    none.hidden = plan.length > 0;
    heading.textContent = t('Search results');
    for (const b of Object.values(items)) b.removeAttribute('aria-current');
    back.disabled = false;
    settle();
  }
  // This pass's own changes (heads added, tabs marked) aren't news to the observers below.
  function settle() { for (const o of observers) o.takeRecords(); }
  const observers = [];

  // A block's search units: each label inside it with the element after it, then the rows
  // outside any of those. Rows are .jcs-row and a provider's card, unless their owner hid them.
  function unitsOf(b) {
    const rows = b.nodes.flatMap((n) => [...(n.matches('.jcs-row, .jcs-provider') ? [n] : []), ...n.querySelectorAll('.jcs-row, .jcs-provider')]).filter((r) => { const off = r.closest('[hidden]'); return !off || b.nodes.includes(off); });  // (a panel itself is shown for the search)
    const pairs = [];
    if (b.label) pairs.push([b.label, b.nodes.find((n) => n !== b.label) || null]);
    for (const n of b.nodes) {
      for (const l of n.querySelectorAll('.jcs-label')) {
        const next = l.nextElementSibling;
        pairs.push([l, next && !next.classList.contains('jcs-label') ? next : null]);
      }
    }
    const used = new Set();
    const out = pairs.map(([label, scope]) => {
      const mine = rows.filter((r) => scope && scope.contains(r) && !used.has(r));
      mine.forEach((r) => used.add(r));
      return { label, scope, rows: mine, text: scope ? rowText(scope) : '' };
    });
    const rest = rows.filter((r) => !used.has(r));
    if (rest.length || !out.length) out.push({ label: null, scope: null, rows: rest, text: rest.length ? '' : b.nodes.map(rowText).join(' ') });
    return out;
  }

  // A row's words as shown: its text nodes, without a select's options or a field's value.
  function textNodes(node) {
    const out = [];
    const walk = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && n.parentElement.closest('option, select, script, style, .ecs-vh') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walk.nextNode(); n; n = walk.nextNode()) out.push(n);
    return out;
  }
  function rowText(node) { return textNodes(node).map((n) => n.data).join(' '); }
  function textRanges(node, query) {
    const out = [];
    for (const n of textNodes(node)) {
      for (const [a, b] of occurrences(n.data, query)) {
        const r = doc.createRange();
        r.setStart(n, a);
        r.setEnd(n, b);
        out.push(r);
      }
    }
    return out;
  }

  function choose(id, { push = false, focusBack = false } = {}) {
    if (!SECTION[id]) return;
    if (search.value) search.value = '';
    if (push && id !== current) history.push(current);
    current = id;
    try { root.localStorage.setItem(STORE, id); } catch (_) { /* no storage */ }
    card.dataset.ecsView = 'pane';
    apply();
    scroll.scrollTop = 0;
    if (focusBack && narrow.matches) back.focus({ preventScroll: true });
  }

  back.addEventListener('click', () => {
    if (search.value) { search.value = ''; apply(); search.focus(); return; }
    if (narrow.matches) { card.dataset.ecsView = 'list'; if (items[current]) items[current].focus(); return; }
    const prev = history.pop();
    if (prev) { current = prev; apply(); scroll.scrollTop = 0; }
  });
  search.addEventListener('input', () => { card.dataset.ecsView = 'pane'; apply(); scroll.scrollTop = 0; });
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && search.value) { e.stopPropagation(); search.value = ''; apply(); } });

  const narrow = root.matchMedia('(max-width: 759px)');
  narrow.addEventListener('change', () => apply());

  // app.js (or a feature: openJcSettings('limits'), a tab click) selected a tab: the section
  // holding it. Opening on General (the default) keeps the section last shown.
  function selected(tab) {
    if (!tab || tab === 'general') { apply(); return; }
    collect();
    const b = blocks.find((x) => x.tab === tab);
    if (b) choose(b.section); else apply();
  }
  // At once, through app.js's own function (a top-level function of a classic script is the
  // window's: app.js's calls to it come here), so what openJcSettings focuses next (the API
  // key field of Models) is already shown.
  const select = root.selectJcsTab;
  if (typeof select === 'function' && !select.ecs) {
    root.selectJcsTab = Object.assign(function selectJcsTab(tab) { select(tab); mine = false; selected(tab); }, { ecs: true });
  }
  // And for a tab selected some other way.
  const tabWatch = new MutationObserver(() => {
    if (mine) return;
    const on = [...tabs.querySelectorAll('[role="tab"][aria-selected="true"]')].map((b) => b.dataset.tab);
    selected(on.length === 1 ? on[0] : '');
  });
  tabWatch.observe(tabs, { attributes: true, subtree: true, attributeFilter: ['aria-selected'] });
  // New groups and tabs as the features load (and redraw); coalesced to one pass.
  let queued = false;
  const later = () => {
    if (queued) return;
    queued = true;
    Promise.resolve().then(() => { queued = false; apply(); });
  };
  const cardWatch = new MutationObserver((records) => {
    // Only structure changes matter: a feature redrawing a row's text needn't re-plan, unless searching.
    if (records.some((r) => r.target === general || r.target === card || r.target === tabs || r.target === col) || search.value) later();
  });
  cardWatch.observe(card, { childList: true, subtree: true });
  observers.push(tabWatch, cardWatch);
  // Opening: on the list when narrow, the search cleared.
  new MutationObserver(() => {
    if (sheet.hidden) return;
    if (search.value) search.value = '';
    history.length = 0;
    card.dataset.ecsView = narrow.matches ? 'list' : 'pane';
    apply();
  }).observe(sheet, { attributes: true, attributeFilter: ['hidden'] });

  card.dataset.ecsView = 'pane';
  apply();

  // For the window's tests and the features: which section, and opening one.
  root.jarvisCodeSettings = Object.assign(api, { section: () => current, choose, blocks: () => blocks });
})(typeof window === 'object' ? window : globalThis);
