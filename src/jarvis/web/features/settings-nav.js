// Settings as macOS System Settings: a sidebar of categories (each a coloured icon tile)
// with the search field at its top, and one category's sections at a time beside it. The
// sections stay where app.js and the features put them (direct children of #settings, so
// their own insertBefore()s and the search keep working); each gets data-settings-pane
// (index.html's own carry it; the features' are recognised by id or class below) and only
// the chosen pane's are shown. Searching shows every match, whatever its pane. Something
// focused or scrolled to in another pane (the model chip, a feature's "open in Settings")
// switches to that pane first. Below 760px wide the sidebar is a list that pushes the
// pane, with a back button, as on iPhone.
//
// Tools & Accounts is a pane here too (Accounts): #accounts' sections move into #settings,
// and toggleAccounts() (the toolbar button, Jarvis Code's "Open Tools & Accounts", WhatsApp's
// pairing) opens Settings on it. The sidebar's top row is the Jarvis account, when its
// section (features/account.js, #account-group) is there.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, $ } = F;
  const sheet = $('settings');
  if (!sheet || $('settings-nav')) return;

  const ICONS = {
    gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    wave: '<path d="M4 10v4M8 6.5v11M12 4v16M16 7.5v9M20 10.5v3"/>',
    spark: '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
    bell: '<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2H5z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
    book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/>',
    phone: '<path d="M6 3.5h3.5l1.8 4.5-2.3 1.4a10 10 0 0 0 4.6 4.6l1.4-2.3 4.5 1.8v3.5a2 2 0 0 1-2 2A15.5 15.5 0 0 1 4 5.5a2 2 0 0 1 2-2z"/>',
    devices: '<rect x="3.5" y="3" width="9.5" height="18" rx="2.2"/><rect x="15" y="8" width="6" height="8.5" rx="2"/><path d="M7.5 18h1.5"/>',
    bolt: '<path d="M13 2.5L5 13.5h6l-1 8 8-11h-6z"/>',
    code: '<path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5M13.5 5l-3 14"/>',
    globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.5 3.6 5.3 3.6 8.5s-1.2 6-3.6 8.5c-2.4-2.5-3.6-5.3-3.6-8.5s1.2-6 3.6-8.5z"/>',
    chart: '<path d="M5 19.5V12M10 19.5V6M15 19.5v-9M20 19.5V4"/>',
    hand: '<path d="M12 3l7 3v5.5c0 4.3-2.9 8-7 9.5-4.1-1.5-7-5.2-7-9.5V6z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
    at: '<circle cx="12" cy="12" r="3.6"/><path d="M15.6 12v1.4a2.6 2.6 0 0 0 5.2 0V12a8.8 8.8 0 1 0-3.5 7"/>',
    person: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20.5c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
  };
  // [id, label, icon, tile colour]; an empty id is a gap between clusters, as in System Settings.
  const PANES = [
    ['general', 'General', 'gear', 'gray'],
    ['voice', 'Voice & Listening', 'wave', 'purple'],
    ['ai', 'AI & Models', 'spark', 'indigo'],
    ['accounts', 'Accounts', 'at', 'blue'],
    [''],
    ['notifications', 'Notifications', 'bell', 'red'],
    ['briefing', 'Briefing & Travel', 'sun', 'orange'],
    ['memory', 'Memory & Knowledge', 'book', 'pink'],
    [''],
    ['calls', 'Calls & Messages', 'phone', 'green'],
    ['devices', 'iPhone & Watch', 'devices', 'blue'],
    ['automation', 'Automation', 'bolt', 'yellow'],
    [''],
    ['code', 'Jarvis Code', 'code', 'graphite'],
    ['browser', 'Browser', 'globe', 'teal'],
    ['money', 'Markets & Money', 'chart', 'green'],
    [''],
    ['safety', 'Privacy & Safety', 'hand', 'blue'],
  ];
  const LABEL = Object.fromEntries(PANES.filter(([id]) => id).map(([id, label]) => [id, label]));
  // The features' sections, by id or by class (a section without either goes to General).
  const BY_ID = {
    'voice-speaking': 'voice', 'voice-listening': 'voice', 'convo-group': 'general', 'updates-group': 'general',
    'agents-group': 'ai', 'skills-group': 'ai', 'pictures-group': 'ai',
    'travel-group': 'briefing', 'oura-group': 'briefing',
    'meetings-group': 'calls', 'channels-group': 'calls',
    'auto-timers': 'automation', 'auto-checkins': 'automation', 'auto-email': 'automation', 'auto-webhooks': 'automation', 'auto-scripts': 'automation',
    'cv-settings': 'code', 'mcp-group': 'code',
    'bai-settings': 'browser', 'bp-group': 'browser',
    'invoicing-group': 'money', 'orders-group': 'money',
    'ops-group': 'safety',
    'accounts-intro': 'accounts', 'connections-group': 'accounts', 'catalog-group': 'accounts', 'custom-group': 'accounts',
  };
  const BY_CLASS = [
    ['agents-group', 'ai'], ['skills-group', 'ai'], ['pictures-group', 'ai'], ['oura-group', 'briefing'],
    ['channels-group', 'calls'], ['auto-group', 'automation'], ['mcp-group', 'code'], ['bp-group', 'browser'],
    ['wa-group', 'accounts'], ['conn-activity', 'accounts'], ['invoicing-group', 'money'], ['orders-group', 'money'], ['updates-group', 'general'], ['convo-group', 'general'],
  ];
  const STORE = 'jarvis.settings.pane';

  function svg(name) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = ICONS[name] || '';
    return s;
  }
  function tile(icon, tone) {
    const t = el('span', 'sn-tile');
    t.dataset.tone = tone;
    t.append(svg(icon));
    return t;
  }

  function paneOf(group) {
    if (group.dataset.settingsPane) return group.dataset.settingsPane;
    let pane = BY_ID[group.id] || '';
    if (!pane) for (const [cls, p] of BY_CLASS) if (group.classList.contains(cls)) { pane = p; break; }
    group.dataset.settingsPane = pane || 'general';
    return group.dataset.settingsPane;
  }
  const groups = () => [...sheet.querySelectorAll(':scope > section.group')];

  // ── the sidebar ──

  const nav = el('nav', 'sheet settings-nav');
  nav.id = 'settings-nav';
  nav.hidden = true;
  nav.setAttribute('aria-label', 'Settings categories');
  // The list's own head, shown when narrow (the pane's head has the close button otherwise).
  const navHead = el('div', 'sn-head');
  const navClose = el('button', 'icon-btn sn-close');
  navClose.type = 'button';
  navClose.id = 'sn-close';
  navClose.setAttribute('aria-label', 'Close settings');
  navClose.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  navClose.addEventListener('click', () => toggleSettings(false));
  navHead.append(el('h2', '', 'Settings'), navClose);
  nav.append(navHead);
  const search = sheet.querySelector('.settings-search');
  if (search) nav.append(search);  // the field and its listeners move as they are
  const account = el('button', 'sn-account');
  account.type = 'button';
  account.id = 'sn-account';
  account.hidden = true;  // until the Jarvis account's section is there
  const accountText = el('span', 'sn-account-text');
  accountText.append(el('strong', '', 'Jarvis Account'), el('small', '', 'Sign in, Plus and sync'));
  account.append(tile('person', 'blue'), accountText, el('span', 'sn-chev', '›'));
  account.addEventListener('click', () => {
    const g = $('account-group');
    if (!g) return;
    choose(paneOf(g));
    g.scrollIntoView({ block: 'start' });
  });
  const list = el('ul', 'sn-list');
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-orientation', 'vertical');
  for (const [id, label, icon, tone] of PANES) {
    if (!id) { list.append(el('li', 'sn-gap')); continue; }
    const li = el('li');
    const b = el('button', 'sn-item');
    b.type = 'button';
    b.id = `sn-${id}`;
    b.dataset.pane = id;
    b.setAttribute('role', 'tab');
    b.append(tile(icon, tone), el('span', 'sn-label', label));
    b.addEventListener('click', () => choose(id, { focus: true }));
    li.append(b);
    list.append(li);
  }
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...list.querySelectorAll('.sn-item:not([hidden])')];
    const at = items.indexOf(document.activeElement);
    if (at < 0) return;
    e.preventDefault();
    const next = items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    next.focus();
    choose(next.dataset.pane);
  });
  nav.append(account, list);
  document.body.append(nav);

  const scrim = el('div', 'settings-scrim');
  scrim.id = 'settings-scrim';
  scrim.hidden = true;
  scrim.addEventListener('click', () => toggleSettings(false));
  document.body.append(scrim);

  // ── the pane's title, with a back button for the narrow layout ──

  const head = sheet.querySelector('.drawer-head');
  const back = el('button', 'icon-btn sn-back');
  back.type = 'button';
  back.id = 'sn-back';
  back.setAttribute('aria-label', 'All settings');
  back.append(svg('back'));
  back.addEventListener('click', () => { document.body.dataset.settingsView = 'list'; const b = $(`sn-${current}`); if (b) b.focus(); });
  const title = el('h2', 'sn-title');
  title.id = 'sn-title';
  if (head) head.prepend(back, title);
  sheet.setAttribute('aria-labelledby', 'sn-title');

  let current = 'general';
  try { const saved = localStorage.getItem(STORE); if (saved && LABEL[saved]) current = saved; } catch (_) { /* no storage */ }

  function show() {
    const searching = sheet.classList.contains('searching');
    for (const g of groups()) g.classList.toggle('sn-out', !searching && paneOf(g) !== current);
    for (const b of list.querySelectorAll('.sn-item')) {
      const on = !searching && b.dataset.pane === current;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on || (searching && b.dataset.pane === current) ? 0 : -1;
    }
    title.textContent = searching ? 'Search results' : LABEL[current];
    account.hidden = !$('account-group');
  }

  function choose(id, { focus = false } = {}) {
    if (!LABEL[id]) return;
    const search = $('settings-search');
    if (search && search.value) { search.value = ''; filterSettings(''); }
    current = id;
    try { localStorage.setItem(STORE, id); } catch (_) { /* no storage */ }
    document.body.dataset.settingsView = 'pane';
    show();
    sheet.scrollTop = 0;
    if (focus && document.body.dataset.settingsNarrow === 'true') back.focus({ preventScroll: true });
  }

  // A control in another pane asked for (focused, or scrolled to): its pane first.
  function reveal(node) {
    const group = node && node.closest && node.closest('#settings > section.group');
    if (!group || sheet.classList.contains('searching')) return;
    const pane = paneOf(group);
    if (pane !== current) choose(pane);
    else document.body.dataset.settingsView = 'pane';
  }
  sheet.addEventListener('focusin', (e) => reveal(e.target));
  // A hidden pane's control can't take the focus or be scrolled to, so its pane comes first.
  for (const [proto, name] of [[Element.prototype, 'scrollIntoView'], [HTMLElement.prototype, 'focus']]) {
    const original = proto[name];
    proto[name] = function (...args) {
      if (!sheet.hidden && this !== sheet && sheet.contains(this)) reveal(this);
      return original.apply(this, args);
    };
  }

  // New sections (features add theirs as they load) and the search switching on and off.
  new MutationObserver(show).observe(sheet, { childList: true });
  new MutationObserver(show).observe(sheet, { attributes: true, attributeFilter: ['class'] });

  const narrow = window.matchMedia('(max-width: 759px)');
  const fit = () => { document.body.dataset.settingsNarrow = String(narrow.matches); };
  narrow.addEventListener('change', fit);
  fit();

  // Shown and hidden with the sheet; opening starts on the list when narrow.
  new MutationObserver(() => {
    const open = !sheet.hidden;
    nav.hidden = scrim.hidden = !open;
    document.body.classList.toggle('settings-open', open);
    if (open && !document.body.dataset.settingsView) document.body.dataset.settingsView = 'list';
    if (!open) document.body.dataset.settingsView = 'list';
    if (open) show();
  }).observe(sheet, { attributes: true, attributeFilter: ['hidden'] });

  // ── Tools & Accounts, as the Accounts pane ──

  const accounts = $('accounts');
  function adopt() {
    if (!accounts) return;
    for (const child of [...accounts.children]) {
      if (child.classList.contains('drawer-head')) continue;
      if (child.matches('section.group')) {
        child.dataset.settingsPane = 'accounts';
        sheet.append(child);
      } else if (child.matches('.sheet-intro, #accounts-error')) {
        let intro = $('accounts-intro');
        if (!intro) {
          intro = el('section', 'group accounts-intro');
          intro.id = 'accounts-intro';
          intro.dataset.settingsPane = 'accounts';
          intro.dataset.keywords = 'accounts tools connectors mcp sign in';
          const first = sheet.querySelector(':scope > section.group[data-settings-pane="accounts"]');
          sheet.insertBefore(intro, first);
        }
        if (child.classList.contains('sheet-intro')) child.classList.add('group-note');
        intro.append(child);
      }
    }
  }
  if (accounts) {
    adopt();
    new MutationObserver(adopt).observe(accounts, { childList: true });  // WhatsApp, Recent activity…
    accounts.hidden = true;
    // Opening Tools & Accounts, from anywhere, is opening Settings on Accounts.
    window.toggleAccounts = (open) => {
      const btn = $('accounts-btn');
      if (open) {
        if (sheet.hidden) toggleSettings(true);
        choose('accounts');
        send({ type: 'connectors' });
      } else if (!sheet.hidden && current === 'accounts') toggleSettings(false);
      if (btn) btn.setAttribute('aria-expanded', String(Boolean(open)));
    };
    // The toolbar button toggles: a second press closes it (app.js asks #accounts, always hidden now).
    const btn = $('accounts-btn');
    if (btn) btn.addEventListener('click', (e) => {
      e.stopImmediatePropagation();
      window.toggleAccounts(sheet.hidden || current !== 'accounts');
    }, true);
  }

  document.body.dataset.settingsView = 'list';
  sheet.classList.add('with-nav');
  show();

  // For the window's tests and the features: which pane, and switching to one.
  window.jarvisSettingsNav = { pane: () => current, choose, paneOf };
})();
