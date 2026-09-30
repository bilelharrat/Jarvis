// The built-in browser's everyday features, window side (app/browser-parity.js is the other
// half): what the tab on show waits on (a site's request for the camera, the microphone,
// location, notifications or the clipboard; a site's sign-in; a certificate warning), the
// site's own menu at the start of the address, and Settings › Browser (the search engine,
// each site's permissions). Only in the J.A.R.V.I.S. app, where the built-in browser is.
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

  if (typeof module === 'object' && module.exports) module.exports = { askText, onceFits, KIND_NAMES, CERT_PROBLEMS, certText };
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
    renderSites();
  }

  function buildGroup() {
    const list = F.el('ul', 'bp-sites');
    list.id = 'bp-sites';
    group.append(F.el('h3', '', 'Browser'), engineRow(), F.el('p', 'bp-sub', 'Site permissions'), list);
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
  if (slot) { slot.parentElement.insertBefore(strip, slot); slot.append(certPanel); }
  buildGroup();
  bridge.on(CH + 'ask', (next) => renderAsk(next));
  bridge.on(CH + 'site-state', (site) => renderSite(site));
  bridge.on(CH + 'sites', (sites) => { if (Array.isArray(sites)) { hello.sites = sites; renderSites(); } });
  bridge.on(CH + 'open-settings', () => {
    if (typeof toggleSettings === 'function' && F.$('settings').hidden) toggleSettings(true);
    group.scrollIntoView({ block: 'start' });
  });
  B.onState((st) => { siteBtn.hidden = !/^(https?|file):/.test((st && st.url) || '') || Boolean(st && st.research); });
  // Settings opening reads the list afresh (a site may have asked meanwhile).
  new MutationObserver(() => { if (!F.$('settings').hidden) refresh(); }).observe(F.$('settings'), { attributes: true, attributeFilter: ['hidden'] });
  F.on('prefs', () => setTimeout(sendLabels, 300), { replay: true });
  refresh();
  sendLabels();
})();
