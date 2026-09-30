// The built-in browser's everyday features, window side (app/browser-parity.js is the other
// half): what the tab on show waits on (a site's request for the camera, the microphone,
// location, notifications or the clipboard; a site's sign-in; a certificate warning), the
// site's own menu at the start of the address, pinned and muted tabs dragged into order, tab
// search, the address bar's list (open tabs, bookmarks, history), the library's bookmarks in
// folders, and Settings › Browser (the search engine, reopening tabs, importing from another
// browser, each site's permissions). Only in the J.A.R.V.I.S. app, where the built-in browser
// is.
(() => {
  // ── pure helpers (tests/web/browser-window.test.mjs requires this file for them) ──

  // What a site asks for, as the prompt says it (the site's name goes before it).
  const ASKS = {
    camera: 'wants to use your camera',
    microphone: 'wants to use your microphone',
    'camera microphone': 'wants to use your camera and microphone',
    location: 'wants to know your location',
    notifications: 'wants to show notifications',
    clipboard: 'wants to see what you copy to the clipboard',
  };
  function askText(kinds) {
    const key = [...(kinds || [])].sort().join(' ');
    return ASKS[key] || `wants to use your ${(kinds || []).join(' and ')}`;
  }
  // "Allow this time" for what's used while you're on the page, as Chrome offers it.
  const onceFits = (kinds) => (kinds || []).every((k) => k === 'camera' || k === 'microphone' || k === 'location');

  const KIND_NAMES = { camera: 'Camera', microphone: 'Microphone', location: 'Location', notifications: 'Notifications', clipboard: 'Clipboard' };
  const VALUE_NAMES = { ask: 'Ask', allow: 'Allow', block: 'Block' };

  // What's wrong with a site's certificate (browser-lib.js's certProblem keys).
  const CERT_PROBLEMS = {
    authority: 'Its certificate isn’t from an authority this Mac trusts.',
    date: 'Its certificate has expired, or isn’t valid yet.',
    name: 'Its certificate is for another site.',
    revoked: 'Its certificate was withdrawn.',
    weak: 'Its certificate uses weak security.',
    other: 'Its certificate has a problem.',
  };
  const certText = (problem) => CERT_PROBLEMS[problem] || CERT_PROBLEMS.other;

  // Tab search: every word typed is in the tab's title or address.
  function tabMatches(tab, query) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const hay = `${tab.title || ''} ${String(tab.url || '').replace(/^[a-z]+:\/\/(www\.)?/i, '')}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  }
  // A tab dropped on another's near or far half: where it goes in the list without it.
  const dropIndex = (from, target, after) => target + (after ? 1 : 0) - (from < target ? 1 : 0);

  // Every folder the bookmarks are in, and the folders those are in, sorted ("Work",
  // "Work/Reading"); and how many bookmarks each holds, its subfolders' too.
  function folderTree(bookmarks) {
    const counts = new Map();
    for (const b of bookmarks || []) {
      const parts = String((b && b.folder) || '').split('/').filter(Boolean);
      for (let i = 1; i <= parts.length; i++) {
        const path = parts.slice(0, i).join('/');
        counts.set(path, (counts.get(path) || 0) + 1);
      }
    }
    return [...counts.keys()].sort((a, b) => a.localeCompare(b)).map((path) => ({ path, count: counts.get(path), depth: path.split('/').length - 1 }));
  }

  // What went wrong reading another browser, in words.
  function importError(ev) {
    const name = ev && ev.name;
    switch (ev && ev.error) {
      case 'full_disk_access': return 'Safari keeps its bookmarks and history private. Allow J.A.R.V.I.S. in System Settings › Privacy & Security › Full Disk Access, then import again.';
      case 'not_found': if (name) return `${name} has nothing to import on this Mac.`; break;
      case 'unreadable': if (name) return `${name}’s bookmarks and history couldn’t be read.`; break;
      default: break;
    }
    return 'That browser can’t be imported from.';
  }

  // How much an import brought in.
  function importedText(r, name) {
    if (!Number(r.bookmarks) && !Number(r.history)) return `Nothing new from ${name}: its bookmarks and history are here already.`;
    const count = (x, one, many) => { const k = Number(x || 0); return `${k.toLocaleString('en')} ${k === 1 ? one : many}`; };
    return `Imported ${count(r.bookmarks, 'bookmark', 'bookmarks')} and ${count(r.history, 'page', 'pages')} of history from ${name}.`;
  }

  if (typeof module === 'object' && module.exports) module.exports = { askText, onceFits, KIND_NAMES, CERT_PROBLEMS, certText, tabMatches, dropIndex, folderTree, importError, importedText };
  if (typeof window === 'undefined' || !window.jarvisFeatures) return;

  const F = window.jarvisFeatures;
  const bridge = window.jarvisApp && window.jarvisApp.feature ? window.jarvisApp.feature : null;
  const B = window.jarvisApp && window.jarvisApp.browser ? window.jarvisApp.browser : null;
  if (!bridge || !B) return; // a plain page: there's no built-in browser here
  const CH = 'feature:browser:';
  const invoke = (name, ...args) => Promise.resolve(bridge.invoke(CH + name, ...args)).catch(() => null);
  const svg = (inner, size = 14) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.5');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
    s.innerHTML = inner; // fixed markup of our own, never data
    return s;
  };
  const ICONS = {
    camera: '<rect x="1.8" y="4.2" width="9" height="7.6" rx="1.8"/><path d="M10.8 7l3.4-2v6l-3.4-2"/>',
    microphone: '<rect x="5.5" y="1.8" width="5" height="8" rx="2.5"/><path d="M3.2 7.6a4.8 4.8 0 009.6 0M8 12.4v2"/>',
    location: '<path d="M8 14.2s4.6-4.3 4.6-7.8a4.6 4.6 0 00-9.2 0c0 3.5 4.6 7.8 4.6 7.8z"/><circle cx="8" cy="6.4" r="1.6"/>',
    notifications: '<path d="M4 11.2V7.4a4 4 0 018 0v3.8l1.2 1.4H2.8zM6.6 13.6a1.5 1.5 0 002.8 0"/>',
    clipboard: '<rect x="3.2" y="2.8" width="9.6" height="11.4" rx="1.6"/><path d="M6 2.8V2h4v.8M5.8 7h4.4M5.8 9.8h4.4"/>',
    key: '<circle cx="5.2" cy="10.8" r="2.8"/><path d="M7.2 8.8l6-6M11 5l1.6 1.6M9.4 6.6l1.4 1.4"/>',
    warning: '<path d="M8 2.2l6.2 11H1.8z"/><path d="M8 6.4v3.2M8 11.6v.1"/>',
    site: '<path d="M2.5 5h7M12.5 5h1M2.5 11h1M6.5 11h7"/><circle cx="11" cy="5" r="1.6"/><circle cx="5" cy="11" r="1.6"/>',
    sound: '<path d="M2.5 6.2h2.2L8 3.5v9L4.7 9.8H2.5z"/><path d="M10.5 5.8a3.2 3.2 0 010 4.4M12.3 4.1a5.6 5.6 0 010 7.8"/>',
    muted: '<path d="M2.5 6.2h2.2L8 3.5v9L4.7 9.8H2.5z"/><path d="M10.6 6.3l3.4 3.4M14 6.3l-3.4 3.4"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
    globe: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.7 1.7 2.4 3.8 2.4 6S9.7 12.3 8 14c-1.7-1.7-2.4-3.8-2.4-6S6.3 3.7 8 2z"/>',
    star: '<path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/>',
    clock: '<path d="M2.7 8.6A5.4 5.4 0 104.2 4.2"/><path d="M2.3 2.4v2.8h2.8"/><path d="M8 5.2V8l2 1.3"/>',
    tabs: '<rect x="2" y="4.5" width="12" height="9" rx="1.8"/><path d="M4.5 4.5V3.2A1.2 1.2 0 015.7 2h4.6a1.2 1.2 0 011.2 1.2v1.3"/>',
    folder: '<path d="M2 4.6A1.6 1.6 0 013.6 3h2.6l1.5 1.6h4.7A1.6 1.6 0 0114 6.2v5.2A1.6 1.6 0 0112.4 13H3.6A1.6 1.6 0 012 11.4z"/>',
    chevron: '<path d="M6 4l4 4-4 4"/>',
    pencil: '<path d="M10.8 2.8l2.4 2.4L6 12.4 3 13l.6-3z"/>',
  };
  const button = (label, cls, onClick) => {
    const b = F.el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };

  // The native menus and boxes the app shows speak the owner's language too.
  function labels() {
    const t = F.t;
    return {
      camera: t('Camera'), microphone: t('Microphone'), location: t('Location'), notifications: t('Notifications'), clipboard: t('Clipboard'),
      ask: t('Ask (default)'), allow: t('Allow'), block: t('Block'), dontAllow: t('Don’t allow'),
      siteSettings: t('Site settings…'), filesHere: t('Files on this Mac'),
      wants: t('{host} wants to use your {what}'), and: t('{a} and {b}'),
      leave: t('Leave'), stay: t('Stay'), leaveTitle: t('Leave {host}?'), leaveDetail: t('Changes you made may not be saved.'),
      goBack: t('Back to safety'), proceed: t('Continue anyway (unsafe)'), certTitle: t('Your connection to {host} isn’t private'),
      certDetail: t(CERT_RISK),
      ...Object.fromEntries(Object.entries(CERT_PROBLEMS).map(([k, v]) => [`cert_${k}`, t(v)])),
      reload: t('Reload'), duplicate: t('Duplicate'), pinTab: t('Pin tab'), unpinTab: t('Unpin tab'),
      muteTab: t('Mute tab'), unmuteTab: t('Unmute tab'), closeTab: t('Close tab'), closeOthers: t('Close other tabs'),
    };
  }
  const sendLabels = () => invoke('labels', labels());

  const CERT_RISK = 'Someone could be pretending to be this site to steal what you type or see there, like passwords, messages or card numbers.';

  // ── what the tab on show waits on: a site's request or sign-in as a strip over the page,
  // a certificate warning in the page's place ──

  let ask = null; // the permission or sign-in on show
  let cert = null; // the certificate warning on show
  const strip = F.el('div', 'bd-ask');
  strip.id = 'bd-ask';
  strip.hidden = true;
  strip.setAttribute('role', 'alertdialog');
  strip.setAttribute('aria-live', 'polite');

  function renderAsk(next) {
    const type = next && next.type;
    const shown = ask || cert;
    if (next && shown && next.id === shown.id && type === shown.type) return; // the same ask: what's typed stays
    cert = type === 'cert' ? next : null;
    renderCert();
    ask = type === 'permission' || type === 'auth' ? next : null;
    strip.hidden = !ask;
    strip.classList.toggle('bd-auth', Boolean(ask && ask.type === 'auth'));
    if (!ask) { strip.replaceChildren(); return; }
    if (ask.type === 'auth') { renderAuth(); return; }
    const icons = F.el('span', 'bd-ask-icons');
    for (const kind of ask.kinds) icons.append(svg(ICONS[kind] || ICONS.site, 16));
    const text = F.el('p', 'bd-ask-text');
    const host = F.el('b', '', ask.host);
    host.setAttribute('data-no-i18n', '');
    text.append(host, F.el('span', '', askText(ask.kinds)));
    const acts = F.el('div', 'bd-ask-acts');
    const reply = (choice) => () => { invoke('answer', { id: ask.id, choice }); renderAsk(null); };
    acts.append(button('Don’t allow', 'bd-ask-btn', reply('block')));
    if (onceFits(ask.kinds)) acts.append(button('Allow this time', 'bd-ask-btn', reply('once')));
    acts.append(button('Allow', 'bd-ask-btn primary', reply('allow')));
    const close = button('', 'bd-ask-x', reply('dismiss'));
    close.append(svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>', 12));
    close.setAttribute('aria-label', 'Not now');
    close.title = 'Not now';
    strip.replaceChildren(icons, text, acts, close);
  }

  // A site's sign-in (HTTP authentication): its user name and password go to that site only,
  // straight from these fields; nothing keeps them.
  function renderAuth() {
    const icons = F.el('span', 'bd-ask-icons');
    icons.append(svg(ICONS.key, 16));
    const main = F.el('div', 'bd-auth-main');
    const text = F.el('p', 'bd-ask-text');
    const host = F.el('b', '', ask.host);
    host.setAttribute('data-no-i18n', '');
    text.append(host, F.el('span', '', ask.proxy ? 'is a proxy asking you to sign in' : 'asks you to sign in'));
    main.append(text);
    if (ask.realm) {
      const note = F.el('p', 'bd-auth-note');
      const realm = F.el('q', '', ask.realm);
      realm.setAttribute('data-no-i18n', '');
      note.append(F.el('span', '', 'The site says:'), realm);
      main.append(note);
    }
    if (ask.insecure) main.append(F.el('p', 'bd-auth-note warn', 'This connection isn’t private: the password is sent as it is.'));
    const form = F.el('form', 'bd-auth-form');
    form.autocomplete = 'off';
    const user = F.el('input', 'bd-auth-field');
    user.id = 'bd-auth-user';
    user.placeholder = 'User name';
    user.setAttribute('aria-label', 'User name');
    const pass = F.el('input', 'bd-auth-field');
    pass.id = 'bd-auth-pass';
    pass.type = 'password';
    pass.placeholder = 'Password';
    pass.setAttribute('aria-label', 'Password');
    for (const f of [user, pass]) { f.autocomplete = 'off'; f.spellcheck = false; f.setAttribute('data-no-i18n', ''); }
    const id = ask.id;
    const done = (answer) => { invoke('auth', { id, ...answer }); user.value = ''; pass.value = ''; renderAsk(null); };
    form.addEventListener('submit', (e) => { e.preventDefault(); done({ username: user.value, password: pass.value }); });
    form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done({ cancel: true }); } });
    const signIn = F.el('button', 'bd-ask-btn primary', 'Sign in');
    signIn.type = 'submit';
    form.append(user, pass, button('Cancel', 'bd-ask-btn', () => done({ cancel: true })), signIn);
    main.append(form);
    strip.replaceChildren(icons, main);
    requestAnimationFrame(() => user.focus());
  }

  // A certificate warning, in the page's place (the page steps aside while it shows): Back to safety,
  // or Continue anyway to that site until the app quits.
  const certPanel = F.el('div', 'bd-cert');
  certPanel.id = 'bd-cert';
  certPanel.hidden = true;
  certPanel.setAttribute('role', 'alertdialog');

  function renderCert() {
    certPanel.hidden = !cert;
    if (!cert) { certPanel.replaceChildren(); return; }
    const icon = F.el('span', 'bd-cert-icon');
    icon.append(svg(ICONS.warning, 30));
    const host = F.el('p', 'bd-cert-host', cert.host);
    host.setAttribute('data-no-i18n', '');
    const id = cert.id;
    const back = button('Back to safety', 'bd-ask-btn primary', () => invoke('cert', { id, choice: 'back' }));
    const on = button('Continue anyway (unsafe)', 'bd-cert-on', () => invoke('cert', { id, choice: 'proceed' }));
    const acts = F.el('div', 'bd-cert-acts');
    acts.append(back, on);
    certPanel.replaceChildren(icon, F.el('h2', '', 'Your connection to this site isn’t private'), host,
      F.el('p', '', certText(cert.problem)), F.el('p', '', CERT_RISK), acts);
  }

  // ── the site's menu: a button at the start of the address, for its permissions ──

  const siteBtn = F.el('button', 'bd-site');
  siteBtn.id = 'br-site';
  siteBtn.type = 'button';
  siteBtn.hidden = true;
  siteBtn.title = 'Site settings';
  siteBtn.setAttribute('aria-label', 'Site settings');
  siteBtn.append(svg(ICONS.site, 14));
  siteBtn.addEventListener('click', () => {
    const r = siteBtn.getBoundingClientRect();
    invoke('site-menu', { x: r.left, y: r.bottom + 4, labels: labels() });
  });
  // After Continue anyway, the button warns for as long as the tab is on that site.
  function renderSite(site) {
    const unsafe = Boolean(site && site.unsafe);
    siteBtn.classList.toggle('unsafe', unsafe);
    siteBtn.replaceChildren(svg(unsafe ? ICONS.warning : ICONS.site, 14));
    siteBtn.title = unsafe ? 'Not secure: you continued past a certificate warning here' : 'Site settings';
  }


  // ── the tabs: pinned ones first and small, their sound (a click mutes it), dragged into
  // order, and their own menu (app.js draws the strip; this adds to each tab) ──

  let dragged = null; // the id of the tab being dragged
  const tabEls = () => [...document.querySelectorAll('#bd-tabs .bd-tab')];
  function tabIcon(t) {
    if (/^data:image\//.test(t.favicon || '')) {
      const img = F.el('img', 'bd-tab-icon');
      img.src = t.favicon;
      img.alt = '';
      return img;
    }
    let host = '';
    try { host = new URL(t.url).hostname.replace(/^www\./, ''); } catch (_) { /* no page yet */ }
    const first = host[0] || '';
    const letter = F.el('span', 'bd-tab-letter', /\p{L}/u.test(first) ? first.toUpperCase() : '');
    if (!letter.textContent) letter.append(svg(ICONS.globe, 12)); // an address, not a name
    letter.setAttribute('data-no-i18n', '');
    letter.setAttribute('aria-hidden', 'true');
    return letter;
  }
  function decorateTab(tab, t) {
    tab.classList.toggle('pinned', Boolean(t.pinned));
    if (t.pinned) tab.prepend(tabIcon(t));
    if (t.audible || t.muted) {
      const sound = F.el('button', `bd-tab-sound${t.muted ? ' muted' : ''}`);
      sound.type = 'button';
      sound.append(svg(t.muted ? ICONS.muted : ICONS.sound, 13));
      sound.title = t.muted ? 'Unmute tab' : 'Mute tab';
      sound.setAttribute('aria-label', sound.title);
      sound.addEventListener('click', (e) => { e.stopPropagation(); invoke('tab', { action: t.muted ? 'unmute' : 'mute', id: t.id }); });
      const x = tab.querySelector('.bd-tab-x');
      tab.insertBefore(sound, x);
    }
    tab.draggable = true;
    tab.addEventListener('dragstart', (e) => {
      dragged = t.id;
      tab.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', t.title || t.url || '');
    });
    tab.addEventListener('dragend', () => {
      dragged = null;
      for (const el of tabEls()) el.classList.remove('dragging', 'drop-before', 'drop-after');
    });
    tab.addEventListener('dragover', (e) => {
      if (dragged === null || dragged === t.id) return;
      e.preventDefault();
      const r = tab.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      tab.classList.toggle('drop-after', after);
      tab.classList.toggle('drop-before', !after);
    });
    tab.addEventListener('dragleave', () => tab.classList.remove('drop-before', 'drop-after'));
    tab.addEventListener('drop', (e) => {
      if (dragged === null || dragged === t.id) return;
      e.preventDefault();
      const ids = tabEls().map((el) => Number(el.dataset.tab));
      const after = tab.classList.contains('drop-after');
      const to = dropIndex(ids.indexOf(dragged), ids.indexOf(t.id), after);
      invoke('tab', { action: 'move', id: dragged, to });
      tab.classList.remove('drop-before', 'drop-after');
    });
    tab.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      invoke('tab', { action: 'menu', id: t.id, x: e.clientX, y: e.clientY, labels: labels() });
    });
  }

  // ── panels in the page's place (tab search, the address bar's list): the page steps aside
  // while one shows ──

  const covering = new Set();
  function cover(name, on) {
    const was = covering.size > 0;
    if (on) covering.add(name); else covering.delete(name);
    if (was !== covering.size > 0) invoke('cover', { on: covering.size > 0 });
  }
  function listRow({ icon, title, sub, badge, on, mine = true }) {
    const li = F.el('li', `bd-lib-row bp-row${on ? ' on' : ''}`);
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(Boolean(on)));
    const go = F.el('button', 'bd-lib-go');
    go.type = 'button';
    go.tabIndex = -1;
    const head = F.el('span', 'bp-row-head');
    head.append(svg(icon, 13));
    const name = F.el('span', 'bd-lib-title', title);
    if (mine) name.setAttribute('data-no-i18n', '');
    head.append(name);
    go.append(head);
    if (sub) {
      const line = F.el('span', 'bd-lib-url', sub);
      line.setAttribute('data-no-i18n', '');
      go.append(line);
    }
    if (badge) go.append(F.el('span', 'bp-badge', badge));
    li.append(go);
    // A press keeps the focus where it is (the address or the search field).
    go.addEventListener('mousedown', (e) => e.preventDefault());
    return { li, go };
  }
  const hostOf = (url) => { try { return new URL(url).host || url; } catch (_) { return url; } };

  // Tab search (⌘⇧A, or the tabs button): every open tab, found by its title or address.
  let lastState = {};
  const tabsPanel = F.el('div', 'bd-lib bp-panel');
  tabsPanel.id = 'bp-tabs';
  tabsPanel.hidden = true;
  const tabsHead = F.el('div', 'bd-lib-head');
  const tabsSearch = F.el('input');
  tabsSearch.id = 'bp-tabs-search';
  tabsSearch.placeholder = 'Search tabs';
  tabsSearch.setAttribute('aria-label', 'Search tabs');
  tabsSearch.spellcheck = false;
  tabsSearch.autocomplete = 'off';
  const tabsList = F.el('ul', 'bd-lib-list bp-list');
  tabsList.id = 'bp-tabs-list';
  tabsList.setAttribute('role', 'listbox');
  tabsHead.append(tabsSearch, button('Done', 'bd-find-done', () => closeTabSearch()));
  tabsPanel.append(tabsHead, tabsList);
  let tabsAt = 0;
  let tabsShownList = [];

  function renderTabSearch() {
    const tabs = (lastState.tabs || []).filter((t) => tabMatches(t, tabsSearch.value));
    tabsShownList = tabs;
    tabsAt = Math.min(tabsAt, Math.max(0, tabs.length - 1));
    tabsList.replaceChildren(...(tabs.length ? tabs.map((t, i) => {
      const { li, go } = listRow({ icon: t.audible && !t.muted ? ICONS.sound : ICONS.tabs, title: t.title || hostOf(t.url) || 'New tab', sub: hostOf(t.url), badge: t.active ? 'Current tab' : t.pinned ? 'Pinned tab' : '', on: i === tabsAt });
      go.addEventListener('click', () => pickTab(t));
      if ((lastState.tabs || []).length > 1) {
        const x = F.el('button', 'bd-tab-x', '✕');
        x.type = 'button';
        x.setAttribute('aria-label', 'Close tab');
        x.addEventListener('mousedown', (e) => e.preventDefault());
        x.addEventListener('click', () => B.tab('close', t.id));
        li.append(x);
      }
      return li;
    }) : [F.el('li', 'bd-lib-empty', 'No open tab matches.')]));
    const on = tabsList.querySelector('.bp-row.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }
  function pickTab(t) {
    closeTabSearch();
    B.tab('select', t.id);
  }
  function openTabSearch() {
    if (F.$('browser').hidden) return;
    closeOmni();
    if (typeof closeLibrary === 'function') closeLibrary();
    tabsPanel.hidden = false;
    tabsSearch.value = '';
    tabsAt = Math.max(0, (lastState.tabs || []).findIndex((t) => t.active));
    renderTabSearch();
    cover('tabs', true);
    tabsSearch.focus();
  }
  function closeTabSearch() {
    if (tabsPanel.hidden) return;
    tabsPanel.hidden = true;
    cover('tabs', false);
  }
  tabsSearch.addEventListener('input', () => { tabsAt = 0; renderTabSearch(); });
  tabsSearch.addEventListener('keydown', (e) => {
    const n = tabsShownList.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) { tabsAt = (tabsAt + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; renderTabSearch(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (tabsShownList[tabsAt]) pickTab(tabsShownList[tabsAt]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeTabSearch();
    }
  });
  const tabsBtn = F.el('button', 'bd-icon');
  tabsBtn.id = 'br-tabsearch';
  tabsBtn.type = 'button';
  tabsBtn.title = 'Search tabs (⌘⇧A)';
  tabsBtn.setAttribute('aria-label', 'Search tabs');
  tabsBtn.append(svg(ICONS.tabs, 16));
  tabsBtn.addEventListener('click', () => (tabsPanel.hidden ? openTabSearch() : closeTabSearch()));

  // The address bar's list as you type: what Return does, then the open tabs to switch to,
  // bookmarks and history it matches, best first. ↑↓ pick, Return goes, ⌘Return in a new tab.
  const omniPanel = F.el('div', 'bd-lib bp-panel bp-omni');
  omniPanel.id = 'bp-omni';
  omniPanel.hidden = true;
  const omniList = F.el('ul', 'bd-lib-list bp-list');
  omniList.id = 'bp-omni-list';
  omniList.setAttribute('role', 'listbox');
  omniPanel.append(omniList);
  const omni = { typed: null, rows: [], at: 0, seq: 0, timer: null };

  function renderOmni() {
    const items = [];
    const typed = omni.typed;
    const first = typed.search
      ? listRow({ icon: ICONS.search, title: typed.text, sub: '', badge: `Search ${typed.engine}`, on: omni.at === 0 })
      : listRow({ icon: ICONS.globe, title: typed.url, sub: '', badge: 'Open', on: omni.at === 0 });
    first.go.addEventListener('click', () => goTyped());
    items.push(first.li);
    omni.rows.forEach((row, i) => {
      const icon = row.kind === 'tab' ? ICONS.tabs : row.kind === 'bookmark' ? ICONS.star : ICONS.clock;
      const badge = row.kind === 'tab' ? 'Switch to tab' : row.folder ? row.folder : '';
      const { li, go } = listRow({ icon, title: row.title || hostOf(row.url), sub: row.url.replace(/^https?:\/\/(www\.)?/, ''), badge, on: omni.at === i + 1 });
      if (row.folder && row.kind !== 'tab') go.querySelector('.bp-badge').setAttribute('data-no-i18n', '');
      go.addEventListener('click', (e) => pickRow(row, e.metaKey));
      items.push(li);
    });
    omniList.replaceChildren(...items);
  }
  function openOmni() {
    if (!omniPanel.hidden) return;
    closeTabSearch();
    omniPanel.hidden = false;
    cover('omni', true);
  }
  function closeOmni() {
    clearTimeout(omni.timer);
    omni.seq += 1; // an answer on its way is too late
    if (omniPanel.hidden) return;
    omniPanel.hidden = true;
    cover('omni', false);
  }
  async function suggestNow() {
    const text = url.value;
    if (document.activeElement !== url || !text.trim()) { closeOmni(); return; }
    const seq = ++omni.seq;
    const r = await invoke('suggest', { text });
    if (seq !== omni.seq || document.activeElement !== url) return;
    if (!r || !r.typed || !r.rows.length) { closeOmni(); return; }
    omni.typed = r.typed;
    omni.rows = r.rows;
    omni.at = 0;
    renderOmni();
    openOmni();
  }
  function goTyped() {
    closeOmni();
    B.nav('go', url.value);
    url.blur();
  }
  function pickRow(row, newTab) {
    closeOmni();
    if (row.kind === 'tab') B.tab('select', row.tab);
    else if (newTab) B.tab('new', null, row.url);
    else B.nav('go', row.url);
    url.blur();
  }
  function omniKey(e) {
    if (omniPanel.hidden) return;
    const n = omni.rows.length + 1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      omni.at = (omni.at + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      renderOmni();
    } else if (e.key === 'Enter' && omni.at > 0) {
      // A row picked: it, not the form's own Return (which goes where the words say).
      e.preventDefault();
      e.stopPropagation();
      pickRow(omni.rows[omni.at - 1], e.metaKey);
    } else if (e.key === 'Enter') {
      closeOmni();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeOmni();
      url.value = lastState.url || ''; // the page's own address again, as in Chrome
    }
  }

  // ── the library's Bookmarks (app.js draws History): folders to open and close, and each
  // bookmark or folder renamed or moved in place ──

  const LIB_MAX = 300; // rows drawn at once
  const openFolders = new Set();
  let editing = ''; // the address of the bookmark being edited, or folder: and the path of a folder
  const redraw = () => { if (typeof renderLibrary === 'function') renderLibrary(); };
  // The library's lists read afresh from the app (after a change here).
  const reloadLibrary = () => Promise.resolve().then(() => refreshLibrary()).catch(() => { /* no app bridge */ });
  const pathLabel = (path) => String(path || '').split('/').join(' › ');
  const iconButton = (icon, label, onClick) => {
    const b = F.el('button', 'bp-bm-act');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.append(svg(icon, 13));
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  };
  const indent = (li, depth) => { li.style.setProperty('--bp-depth', String(depth)); return li; };

  function bookmarkRow(b, { depth = 0, folder = false } = {}) {
    if (editing === b.url) return bookmarkEditor(b, depth);
    const li = indent(F.el('li', 'bd-lib-row bp-bm'), depth);
    const go = F.el('button', 'bd-lib-go');
    go.type = 'button';
    const title = F.el('span', 'bd-lib-title', b.title || hostOf(b.url));
    const where = F.el('span', 'bd-lib-url', folder && b.folder ? `${hostOf(b.url)} · ${pathLabel(b.folder)}` : hostOf(b.url));
    title.setAttribute('data-no-i18n', '');
    where.setAttribute('data-no-i18n', '');
    go.append(title, where);
    go.addEventListener('click', (e) => {
      if (e.metaKey) B.tab('new', null, b.url); else B.nav('go', b.url);
      if (typeof closeLibrary === 'function') closeLibrary();
    });
    const x = F.el('button', 'bd-tab-x', '✕');
    x.type = 'button';
    x.setAttribute('aria-label', 'Remove bookmark');
    x.addEventListener('click', () => { Promise.resolve(B.data && B.data('bookmark', b.url)).then(reloadLibrary, () => {}); });
    li.append(go, iconButton(ICONS.pencil, 'Rename or move', () => { editing = b.url; redraw(); }), x);
    return li;
  }

  function bookmarkEditor(b, depth) {
    const li = indent(F.el('li', 'bp-bm-edit'), depth);
    const form = F.el('form', 'bp-bm-form');
    const title = F.el('input', 'bp-bm-field');
    title.value = b.title || '';
    title.placeholder = 'Name';
    title.setAttribute('aria-label', 'Name');
    const folder = F.el('input', 'bp-bm-field');
    folder.value = pathLabel(b.folder || '');
    folder.placeholder = 'Folder (none: the top)';
    folder.setAttribute('aria-label', 'Folder');
    folder.setAttribute('list', 'bp-folders');
    for (const f of [title, folder]) { f.autocomplete = 'off'; f.spellcheck = false; f.setAttribute('data-no-i18n', ''); }
    const done = () => { editing = ''; redraw(); };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await invoke('bookmark', { url: b.url, title: title.value, folder: folder.value.split('›').map((p) => p.trim()).join('/') });
      editing = '';
      reloadLibrary();
      redraw();
    });
    form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); } });
    const save = F.el('button', 'bd-find-done', 'Save');
    save.type = 'submit';
    form.append(title, folder, save, button('Cancel', 'bp-bm-cancel', done));
    li.append(form);
    requestAnimationFrame(() => title.focus());
    return li;
  }

  function folderRow({ path, count, depth }) {
    const name = path.split('/').pop();
    if (editing === `folder:${path}`) {
      const li = indent(F.el('li', 'bp-bm-edit'), depth);
      const form = F.el('form', 'bp-bm-form');
      const input = F.el('input', 'bp-bm-field');
      input.value = pathLabel(path);
      input.setAttribute('aria-label', 'Folder');
      input.setAttribute('data-no-i18n', '');
      input.autocomplete = 'off';
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const to = input.value.split('›').map((p) => p.trim()).join('/');
        await invoke('folder', { from: path, to });
        if (openFolders.delete(path) && to) openFolders.add(to);
        editing = '';
        reloadLibrary();
        redraw();
      });
      form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); editing = ''; redraw(); } });
      const save = F.el('button', 'bd-find-done', 'Save');
      save.type = 'submit';
      form.append(input, save, button('Cancel', 'bp-bm-cancel', () => { editing = ''; redraw(); }));
      li.append(form);
      requestAnimationFrame(() => input.focus());
      return li;
    }
    const open = openFolders.has(path);
    const li = indent(F.el('li', `bd-lib-row bp-folder${open ? ' open' : ''}`), depth);
    const toggle = F.el('button', 'bd-lib-go bp-folder-go');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(open));
    const head = F.el('span', 'bp-row-head');
    const label = F.el('span', 'bd-lib-title', name);
    label.setAttribute('data-no-i18n', '');
    head.append(svg(ICONS.chevron, 11), svg(ICONS.folder, 14), label);
    const n = F.el('span', 'bp-count', String(count));
    n.setAttribute('data-no-i18n', '');
    toggle.append(head, n);
    toggle.addEventListener('click', () => { if (open) openFolders.delete(path); else openFolders.add(path); redraw(); });
    li.append(toggle, iconButton(ICONS.pencil, 'Rename folder', () => { editing = `folder:${path}`; redraw(); }));
    return li;
  }

  function renderBookmarks(list, bookmarks, q) {
    const all = (bookmarks || []).slice().reverse(); // the newest first, as before
    const rows = [];
    const tree = folderTree(all);
    let names = F.$('bp-folders');
    if (!names) {
      names = F.el('datalist');
      names.id = 'bp-folders';
      document.body.append(names);
    }
    names.replaceChildren(...tree.map((f) => { const o = F.el('option'); o.value = pathLabel(f.path); return o; }));
    if (q) {
      for (const b of all) {
        if (rows.length >= LIB_MAX) break;
        if (`${b.title} ${b.url} ${b.folder || ''}`.toLowerCase().includes(q)) rows.push(bookmarkRow(b, { folder: true }));
      }
      list.replaceChildren(...(rows.length ? rows : [F.el('li', 'bd-lib-empty', 'Nothing matches.')]));
      return;
    }
    const inFolder = new Map();
    for (const b of all) {
      const f = b.folder || '';
      if (!inFolder.has(f)) inFolder.set(f, []);
      inFolder.get(f).push(b);
    }
    for (const b of inFolder.get('') || []) {
      if (rows.length >= LIB_MAX) break;
      rows.push(bookmarkRow(b));
    }
    const shown = (path) => path.split('/').every((_, i, parts) => i === parts.length - 1 || openFolders.has(parts.slice(0, i + 1).join('/')));
    for (const f of tree) {
      if (rows.length >= LIB_MAX) break;
      if (!shown(f.path)) continue; // inside a closed folder
      rows.push(folderRow(f));
      if (!openFolders.has(f.path)) continue;
      for (const b of inFolder.get(f.path) || []) {
        if (rows.length >= LIB_MAX) break;
        rows.push(bookmarkRow(b, { depth: f.depth + 1 }));
      }
    }
    list.replaceChildren(...(rows.length ? rows : [F.el('li', 'bd-lib-empty', 'No bookmarks yet. Press ★ in the address bar (⌘D) to add this page, or import them from another browser in Settings › Browser.')]));
  }

  // ── Settings › Browser ──

  let hello = { engine: 'google', engines: [], sites: [] };
  const group = F.el('section', 'group bp-group');
  group.id = 'browser-group';

  function engineRow() {
    const row = F.el('label', 'row');
    row.htmlFor = 'bp-engine';
    const words = F.el('span');
    words.append(F.el('strong', '', 'Search engine'), F.el('small', '', 'What the address bar searches with when you type words'));
    const select = F.el('select');
    select.id = 'bp-engine';
    select.addEventListener('change', async () => {
      const next = await invoke('settings', { engine: select.value });
      if (next) { hello = next; renderGroup(); }
    });
    row.append(words, select);
    return row;
  }

  function restoreRow() {
    const row = F.el('div', 'row');
    const words = F.el('span');
    words.append(F.el('strong', '', 'Reopen your tabs'), F.el('small', '', 'The tabs you had open, pinned ones too, come back the next time you open the browser'));
    const sw = F.el('button', 'switch');
    sw.id = 'sw-bp-restore';
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', 'true');
    sw.setAttribute('aria-label', 'Reopen your tabs');
    sw.addEventListener('click', async () => {
      const on = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', String(on));
      const next = await invoke('settings', { restore: on });
      if (next) { hello = next; renderGroup(); }
    });
    row.append(words, sw);
    return row;
  }

  // Bookmarks and history from another browser on this Mac (features/browser_import.py reads
  // them; the app files them).
  function importRow() {
    const wrap = F.el('div', 'bp-import');
    const row = F.el('div', 'row');
    const words = F.el('span');
    words.append(F.el('strong', '', 'Import bookmarks and history'), F.el('small', '', 'From another browser on this Mac. Nothing leaves the Mac.'));
    const pick = F.el('span', 'bp-import-pick');
    const select = F.el('select');
    select.id = 'bp-import-from';
    select.setAttribute('aria-label', 'Browser to import from');
    const go = button('Import', 'btn bp-import-go', () => {
      if (!select.value) return;
      const name = select.selectedOptions[0] ? select.selectedOptions[0].textContent : select.value;
      go.disabled = true;
      status.textContent = `Reading ${name}’s bookmarks and history…`;
      F.send({ type: 'browser_import', browser: select.value });
    });
    go.id = 'bp-import-go';
    pick.append(select, go);
    row.append(words);
    const status = F.el('p', 'bp-import-status');
    status.id = 'bp-import-status';
    status.setAttribute('aria-live', 'polite');
    wrap.append(row, pick, status);
    return wrap;
  }

  function renderSources(sources) {
    const select = F.$('bp-import-from');
    const go = F.$('bp-import-go');
    if (!select || !go) return;
    const found = (sources || []).filter((s) => s && s.found);
    select.replaceChildren(...(found.length ? found.map((s) => {
      const o = F.el('option', '', s.name);
      o.value = s.id;
      o.setAttribute('data-no-i18n', '');
      return o;
    }) : [F.el('option', '', 'No other browser here')]));
    select.disabled = !found.length;
    go.disabled = !found.length;
  }

  async function imported(ev) {
    const status = F.$('bp-import-status');
    const go = F.$('bp-import-go');
    if (go) go.disabled = false;
    if (!status || !ev) return;
    if (!ev.ok) { status.textContent = importError(ev); return; }
    const r = await invoke('import', { label: F.t(`Imported from ${ev.name}`), bookmarks: ev.bookmarks, history: ev.history });
    if (!r) { status.textContent = importError({ name: ev.name, error: 'unreadable' }); return; }
    status.textContent = importedText(r, ev.name);
    reloadLibrary();
  }

  function siteRow(site) {
    const li = F.el('li', 'bp-site');
    const name = F.el('b', 'bp-site-host', site.host);
    name.setAttribute('data-no-i18n', '');
    const kinds = F.el('div', 'bp-site-kinds');
    for (const [kind, value] of Object.entries(site.kinds)) {
      const label = F.el('label', 'bp-kind');
      const select = F.el('select');
      select.setAttribute('aria-label', `${KIND_NAMES[kind] || kind}: ${site.host}`);
      for (const v of ['ask', 'allow', 'block']) {
        const o = F.el('option', '', VALUE_NAMES[v]);
        o.value = v;
        o.selected = v === value;
        select.append(o);
      }
      select.addEventListener('change', async () => {
        const r = await invoke('site', { origin: site.origin, kind, value: select.value });
        if (r && r.sites) { hello.sites = r.sites; renderSites(); }
      });
      label.append(F.el('span', '', KIND_NAMES[kind] || kind), select);
      kinds.append(label);
    }
    const forget = button('Forget', 'bp-forget', async () => {
      const r = await invoke('site', { origin: site.origin, forget: true });
      if (r && r.sites) { hello.sites = r.sites; renderSites(); }
    });
    forget.setAttribute('aria-label', `Forget ${site.host}`);
    li.append(name, forget, kinds);
    return li;
  }

  function renderSites() {
    const list = F.$('bp-sites');
    if (!list) return;
    const sites = hello.sites || [];
    list.replaceChildren(...(sites.length ? sites.map(siteRow) : [F.el('li', 'bp-empty', 'No site has asked yet. Sites ask before they use your camera, microphone, location, notifications or clipboard; what you answer shows here.')]));
  }

  function renderGroup() {
    const select = F.$('bp-engine');
    if (select) {
      select.replaceChildren(...(hello.engines || []).map((e) => {
        const o = F.el('option', '', e.name);
        o.value = e.id;
        o.selected = e.id === hello.engine;
        o.setAttribute('data-no-i18n', '');
        return o;
      }));
    }
    const sw = F.$('sw-bp-restore');
    if (sw) sw.setAttribute('aria-checked', String(hello.restore !== false));
    renderSites();
  }

  function buildGroup() {
    const list = F.el('ul', 'bp-sites');
    list.id = 'bp-sites';
    group.append(F.el('h3', '', 'Browser'), engineRow(), restoreRow(), importRow(), F.el('p', 'bp-sub', 'Site permissions'), list);
    const settings = F.$('settings');
    const accounts = F.$('open-accounts');
    const last = accounts ? accounts.closest('section.group') : null;
    settings.insertBefore(group, last && last.parentElement === settings ? last : null);
  }

  async function refresh() {
    const next = await invoke('hello');
    if (!next) return;
    hello = next;
    renderGroup();
    renderAsk(next.ask);
    renderSite(next.site);
  }

  // ── start ──

  const url = F.$('br-url');
  if (url) url.parentElement.insertBefore(siteBtn, url.parentElement.firstChild);
  const slot = F.$('browser-slot');
  if (slot) { slot.parentElement.insertBefore(strip, slot); slot.append(certPanel, tabsPanel, omniPanel); }
  const library = F.$('br-library');
  if (library) library.parentElement.insertBefore(tabsBtn, library);
  if (url) {
    url.removeAttribute('list'); // this list in place of the plain one
    url.addEventListener('input', () => { clearTimeout(omni.timer); omni.timer = setTimeout(suggestNow, 60); });
    url.addEventListener('keydown', omniKey, true);
    url.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== url) closeOmni(); }, 120));
  }
  if (typeof F.registerTab === 'function') F.registerTab(decorateTab);
  if (typeof B.onShortcut === 'function') B.onShortcut((action) => { if (action === 'tab-search') openTabSearch(); });
  window.addEventListener('keydown', (e) => {
    if (e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && e.code === 'KeyA' && !F.$('browser').hidden) {
      e.preventDefault();
      openTabSearch();
    }
  });
  // The dock closing: its panels go, and every video and sound in the tabs stops.
  new MutationObserver(() => {
    if (!F.$('browser').hidden) return;
    closeOmni();
    closeTabSearch();
    invoke('dock', { open: false });
  }).observe(F.$('browser'), { attributes: true, attributeFilter: ['hidden'] });
  buildGroup();
  bridge.on(CH + 'ask', (next) => renderAsk(next));
  bridge.on(CH + 'site-state', (site) => renderSite(site));
  bridge.on(CH + 'sites', (sites) => { if (Array.isArray(sites)) { hello.sites = sites; renderSites(); } });
  bridge.on(CH + 'open-settings', () => {
    if (typeof toggleSettings === 'function' && F.$('settings').hidden) toggleSettings(true);
    group.scrollIntoView({ block: 'start' });
  });
  B.onState((st) => {
    lastState = st || {};
    siteBtn.hidden = !/^(https?|file):/.test((st && st.url) || '') || Boolean(st && st.research);
    if (!tabsPanel.hidden) renderTabSearch();
  });
  // Settings opening reads the list afresh (a site may have asked meanwhile), and which
  // browsers there are to import from.
  new MutationObserver(() => {
    if (F.$('settings').hidden) return;
    refresh();
    F.send({ type: 'browser_import_sources' });
  }).observe(F.$('settings'), { attributes: true, attributeFilter: ['hidden'] });
  F.on('browser_import_sources', (ev) => renderSources(ev.sources));
  F.on('browser_import', (ev) => imported(ev));
  if (typeof F.registerBookmarks === 'function') F.registerBookmarks(renderBookmarks);
  F.on('prefs', () => setTimeout(sendLabels, 300), { replay: true });
  refresh();
  sendLabels();
})();
