// Ask Eden's own browser on this computer: the page's browser panel (askeden web/chat/browser-pane.js,
// "app" mode through window.jarvisBrowser) draws the tabs, the address bar and the buttons; each tab is a
// WebContentsView laid over the panel's slot, as Eden Secretary's browser is in its Eden window.
// Why (owner, 2026-11-10): Eden's cloud browser runs from Cloudflare's addresses, which Google and many
// other sites challenge or turn away; this one browses from the person's own connection, so Google just
// works (askeden ROADMAP, Browser panel). The cloud browser stays for askeden.com in a tab and for Eden
// browsing by itself.
//
// Ask Eden for Mac (eden/main.js) and Ask Eden for Windows (Eden Windows/ask-eden/main.js, a copy of this
// file kept identical) install it with install(). Its own profile (persist:eden-browser): sign-ins and
// cookies stay between launches, apart from askeden.com's. Only http, https and about:blank load in a tab;
// pages get no Node, no preload, a sandbox, and no camera, microphone, location or notifications.
// Tests: JARVIS V1/tests/web/ask-eden-browser.test.mjs.
'use strict';

const fs = require('fs');

const PARTITION = 'persist:eden-browser';
const MAX_TABS = 20;
const TEXT_MAX = 60000;
const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);
const CH = 'eden:browser:';

/** What's typed in the address bar: an address, or words for Google. '' when it can't be either. */
function toUrl(text) {
  const t = String(text || '').trim().slice(0, 2000);
  if (!t) return '';
  if (/^about:blank$/i.test(t)) return 'about:blank';
  const ok = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) && x.hostname ? x.toString() : ''; } catch { return ''; } };
  if (/^https?:\/\//i.test(t)) return ok(t);
  if (!/\s/.test(t)) {
    if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#].*)?$/i.test(t)) return ok(`http://${t}`);
    if (/^([a-z0-9-]+\.)+[a-z][a-z0-9-]{1,62}(:\d+)?([/?#].*)?$/i.test(t)) return ok(`https://${t}`);
    if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return ''; // another scheme (javascript:, file:…)
  }
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

/** Whether a tab may go there: the web, or a blank page. */
const allowed = (url) => /^(https?:\/\/|about:blank$)/i.test(String(url || ''));

/** A browser's user agent, without Electron's and the app's own tokens (sites treat those as a bot or an old browser). */
const cleanUa = (ua) => String(ua || '').replace(/\s(Electron|Ask Eden|ask-eden-app|eden-windows|jarvis-app)\/\S+/gi, '');

/** A rectangle from the page (CSS pixels), in the window's pixels: the page may be zoomed. */
function rect(b, zoom = 1) {
  if (!b || typeof b !== 'object') return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v) * zoom)) : 0);
  const r = { x: n(b.x), y: n(b.y), width: n(b.width), height: n(b.height) };
  return r.width > 0 && r.height > 0 ? r : null;
}

function nextZoom(now, step) {
  if (!step) return 1;
  const i = ZOOMS.findIndex((z) => z >= now - 0.001);
  const at = i < 0 ? ZOOMS.length - 1 : i;
  return ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, at + (step > 0 ? 1 : -1)))];
}

/** Why a page didn't open, in words, from Chromium's error code (did-fail-load). */
function failure(code, url) {
  const site = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'the site'; } })();
  if (code === -105 || code === -137) return `Can’t find ${site}. Check the address.`;
  if (code === -106) return 'You’re offline. Check your connection.';
  if (code === -102 || code === -109 || code === -118 || code === -7) return `${site} isn’t answering.`;
  if (code <= -200 && code > -300) return `${site}’s security certificate isn’t valid, so the page wasn’t opened.`;
  return `Can’t open ${site}.`;
}

/**
 * The browser. deps: { WebContentsView, session, Menu, shell, clipboard } (Electron's), isMac (which
 * key is ⌘), and recentFile: where the new tab page's recent sites are kept (a JSON file in the app's
 * folder; none: only while the app runs). Hosted by one window at a time (show/bounds/hide name it).
 */
function createLocalBrowser(deps) {
  const { WebContentsView, session, Menu, shell, clipboard } = deps;
  const isMac = deps.isMac !== false;
  const tabs = [];
  let active = 0;
  let nextId = 1;
  let host = null; // the BrowserWindow the panel is in
  let box = null; // the panel's slot, in the window's pixels
  let shown = false;
  let ses = null;
  let pending = null;
  let find = null; // { requestId, done }

  // The new tab page's recent sites (newest first, one per site, with its logo).
  const siteOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  let recent = [];
  try { const kept = JSON.parse(fs.readFileSync(deps.recentFile, 'utf8')); if (Array.isArray(kept)) recent = kept.filter((r) => r && allowed(r.url) && r.site).slice(0, 24); } catch { /* none yet */ }
  let saveTimer = null;
  function visited(t) {
    const site = siteOf(t.url);
    if (!site || !/^https?:/i.test(t.url) || t.error) return;
    const was = recent.find((r) => r.site === site);
    recent = [{ site, url: t.url, title: String(t.title || site).slice(0, 120), icon: t.icon || (was && was.icon) || '' }, ...recent.filter((r) => r.site !== site)].slice(0, 24);
    if (!deps.recentFile || saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; fs.promises.writeFile(deps.recentFile, JSON.stringify(recent)).catch(() => {}); }, 1000);
  }

  const live = (w) => Boolean(w && !w.isDestroyed());
  const tab = (id) => tabs.find((t) => t.id === id) || null;
  const current = () => tab(active);
  const send = (what, payload) => { if (live(host)) host.webContents.send(`${CH}${what}`, payload); };
  const outside = (url) => { if (/^(https?|mailto):/i.test(String(url || ''))) shell.openExternal(String(url)).catch(() => {}); };

  function profile() {
    if (ses) return ses;
    ses = session.fromPartition(PARTITION);
    ses.setUserAgent(cleanUa(ses.getUserAgent()));
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(PERMISSIONS.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => PERMISSIONS.has(permission));
    return ses;
  }

  function state() {
    const t = current();
    const h = t && t.view.webContents.navigationHistory;
    return {
      local: true,
      url: t ? t.url : '',
      title: t ? t.title : '',
      loading: Boolean(t && t.loading),
      canBack: Boolean(h && (h.canGoBack() || (t.error && /^https?:/i.test(t.view.webContents.getURL())))),
      canForward: Boolean(h && h.canGoForward()),
      zoom: t ? t.zoom : 1,
      error: t && t.error ? { url: t.error.url, message: t.error.message } : null,
      tabs: tabs.map((x) => ({ id: x.id, title: x.title, url: x.url, icon: x.icon, loading: x.loading, active: x.id === active })),
      shields: { ready: false },
      recent: t && !t.url ? recent.slice(0, 8).map(({ site, url, title, icon }) => ({ site, url, title, icon })) : [],
    };
  }
  function changed() {
    if (pending) return;
    pending = setTimeout(() => { pending = null; place(); send('state', state()); }, 16);
  }

  /** The tab on show goes over the slot, when the panel shows it and it has a page; every other view comes off. */
  function place() {
    const t = current();
    const want = Boolean(live(host) && shown && box && t && t.url && !t.error);
    for (const x of tabs) {
      if (x.on && (x !== t || !want || x.on !== host)) { if (live(x.on)) x.on.contentView.removeChildView(x.view); x.on = null; }
    }
    if (!want) return;
    if (!t.on) { host.contentView.addChildView(t.view); t.on = host; }
    t.view.setBounds(box);
  }

  function makeTab(url = '') {
    if (tabs.length >= MAX_TABS) return null;
    const view = new WebContentsView({
      webPreferences: { session: profile(), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, safeDialogs: true, spellcheck: true },
    });
    const t = { id: nextId++, view, url: '', title: '', icon: '', loading: false, zoom: 1, error: null, on: null };
    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url: to, disposition }) => {
      if (allowed(to) && !/^about:/i.test(to)) {
        const n = makeTab(to);
        if (n && disposition !== 'background-tab') active = n.id;
        changed();
      } else outside(to);
      return { action: 'deny' };
    });
    const guard = (e, to) => { if (!allowed(to)) { e.preventDefault(); outside(to); } };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.on('did-start-loading', () => { t.loading = true; changed(); });
    wc.on('did-stop-loading', () => { t.loading = false; visited(t); changed(); });
    wc.on('did-start-navigation', (d) => { if (d && d.isMainFrame && !d.isSameDocument) { t.error = null; changed(); } });
    wc.on('did-navigate', (_e, to) => { t.url = to; t.error = null; changed(); });
    wc.on('did-navigate-in-page', (_e, to, isMain) => { if (isMain) { t.url = to; changed(); } });
    wc.on('page-title-updated', (_e, title) => { t.title = String(title || '').slice(0, 300); changed(); });
    wc.on('page-favicon-updated', (_e, icons) => { iconFor(t, (Array.isArray(icons) ? icons : []).find((u) => /^https:\/\//i.test(u)) || ''); });
    wc.on('did-fail-load', (_e, code, _desc, to, isMain) => {
      if (!isMain || code === -3) return; // -3: stopped, or replaced by another load
      t.error = { url: to, message: failure(code, to) };
      t.url = to;
      t.title = '';
      t.icon = '';
      t.loading = false;
      changed();
    });
    wc.on('render-process-gone', () => { t.loading = false; t.error = { url: t.url, message: 'This page stopped working.' }; changed(); });
    wc.on('before-input-event', (e, input) => keys(e, input, t));
    wc.on('context-menu', (_e, p) => pageMenu(t, p));
    wc.on('found-in-page', (_e, r) => { if (find && r && r.requestId === find.requestId && r.finalUpdate) { find.done({ n: r.matches || 0, i: r.activeMatchOrdinal || 0 }); find = null; } });
    tabs.push(t);
    if (url) load(t, url);
    return t;
  }

  // A site's icon, for the tab strip: the panel shows only pictures it's handed (data: URLs), so it's
  // fetched here (this browser's own profile), once per address while the app runs.
  const icons = new Map();
  async function iconFor(t, url) {
    if (!url) return;
    if (!icons.has(url)) {
      icons.set(url, '');
      try {
        const r = await profile().fetch(url);
        const type = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const body = Buffer.from(await r.arrayBuffer());
        if (r.ok && /^image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|jpeg|gif|webp|avif)$/.test(type) && body.length && body.length < 48000) icons.set(url, `data:${type};base64,${body.toString('base64')}`);
      } catch { /* no icon: the globe */ }
    }
    t.icon = icons.get(url) || '';
    if (t.icon) visited(t);
    changed();
  }

  function load(t, url) {
    if (!allowed(url)) return;
    t.url = url;
    t.error = null;
    t.view.webContents.loadURL(url).catch(() => {}); // a failure shows as t.error (did-fail-load)
    changed();
  }

  function close(id) {
    const t = tab(id);
    if (!t) return;
    const i = tabs.indexOf(t);
    if (t.on && live(t.on)) t.on.contentView.removeChildView(t.view);
    t.on = null;
    tabs.splice(i, 1);
    try { t.view.webContents.close(); } catch { /* gone */ }
    if (active === id) { const next = tabs[Math.min(i, tabs.length - 1)]; active = next ? next.id : 0; }
    if (!tabs.length) active = makeTab().id; // never no tab: a new one, as a browser does
    changed();
  }

  // ⌘ (Ctrl on Windows) keys while the page has the keyboard: the browser's own, else the panel's
  // (the page runs its shortcut as if typed there: ⌘⇧B, ⌘K…). Editing keys stay with the page.
  function keys(e, input, t) {
    if (!input || input.type !== 'keyDown') return;
    const cmd = isMac ? input.meta : input.control;
    if (!cmd || input.alt) return;
    const k = String(input.key || '').toLowerCase();
    if (!input.shift && ['c', 'v', 'x', 'a', 'z', 'y'].includes(k)) return;
    if (input.shift && k === 'z') return;
    if (['q', 'h', 'm', 'n', '`', ','].includes(k)) return; // the app's menu: Quit, Hide, Minimize, New chat…
    const wc = t.view.webContents;
    const h = wc.navigationHistory;
    const run = {
      l: () => send('command', { t: 'address' }),
      t: () => { const n = makeTab(); if (n) { active = n.id; changed(); send('command', { t: 'address' }); } },
      w: () => close(t.id),
      r: () => (input.shift ? wc.reloadIgnoringCache() : wc.reload()),
      '[': () => { if (h.canGoBack()) h.goBack(); },
      ']': () => { if (h.canGoForward()) h.goForward(); },
      f: () => send('command', { t: 'find' }),
      '=': () => zoom(1), '+': () => zoom(1), '-': () => zoom(-1), '0': () => zoom(0),
    }[input.shift && !['r', '+'].includes(k) ? '' : k];
    e.preventDefault();
    if (run) run();
    else send('command', { t: 'key', key: input.key, code: input.code, shift: Boolean(input.shift) });
  }

  function pageMenu(t, p) {
    if (!Menu || !live(host)) return;
    const wc = t.view.webContents;
    const h = wc.navigationHistory;
    const sel = String(p.selectionText || '').trim();
    const items = [];
    const sep = () => { if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' }); };
    if (p.linkURL && allowed(p.linkURL)) {
      items.push(
        { label: 'Open Link in New Tab', click: () => { makeTab(p.linkURL); changed(); } },
        { label: 'Open Link in Your Browser', click: () => outside(p.linkURL) },
        { label: 'Copy Link Address', click: () => clipboard.writeText(p.linkURL) },
      );
      sep();
    }
    if (p.mediaType === 'image' && /^https?:/i.test(p.srcURL || '')) {
      items.push({ label: 'Open Image in New Tab', click: () => { makeTab(p.srcURL); changed(); } }, { label: 'Copy Image Address', click: () => clipboard.writeText(p.srcURL) });
      sep();
    }
    if (p.isEditable) items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    else if (sel) items.push({ role: 'copy' });
    if (sel) {
      sep();
      items.push(
        { label: 'Ask Eden About the Selection', click: () => send('command', { t: 'ask', text: sel.slice(0, TEXT_MAX), url: t.url, title: t.title }) },
        { label: `Search Google for “${sel.length > 24 ? `${sel.slice(0, 23)}…` : sel}”`, click: () => { const n = makeTab(toUrl(sel)); if (n) active = n.id; changed(); } },
      );
    }
    sep();
    items.push(
      { label: 'Back', enabled: h.canGoBack(), click: () => h.goBack() },
      { label: 'Forward', enabled: h.canGoForward(), click: () => h.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Ask Eden About This Page', click: () => send('command', { t: 'ask-page' }) },
    );
    Menu.buildFromTemplate(items).popup({ window: host });
  }

  function zoom(step) {
    const t = current();
    if (!t || !t.url) return;
    t.zoom = nextZoom(t.zoom, step);
    t.view.webContents.setZoomFactor(t.zoom);
    changed();
  }

  return {
    PARTITION,
    open(win, on) {
      if (on === false) { this.hide(win); return; }
      host = win;
      if (!tabs.length) active = makeTab().id;
      changed();
    },
    show(win, b) { host = win; box = rect(b, live(win) ? win.webContents.getZoomFactor() : 1); shown = Boolean(box); if (!tabs.length) active = makeTab().id; place(); send('state', state()); },
    bounds(win, b) { if (win !== host) return; const r = rect(b, live(win) ? win.webContents.getZoomFactor() : 1); if (r) { box = r; place(); } },
    /** Something of Eden's over the slot: the view steps off, leaving a picture of the page under it (no blank). */
    async hide(win) {
      if (win && win !== host) return;
      const t = current();
      if (shown && t && t.on && live(host)) {
        const shot = await Promise.race([t.view.webContents.capturePage().catch(() => null), new Promise((r) => setTimeout(() => r(null), 150))]);
        if (shot && !shot.isEmpty()) send('command', { t: 'snapshot', url: `data:image/jpeg;base64,${shot.toJPEG(80).toString('base64')}` });
      }
      shown = false;
      place();
    },
    nav(action, url) {
      let t = current();
      if (!t) { t = makeTab(); if (!t) return; active = t.id; }
      const wc = t.view.webContents;
      const h = wc.navigationHistory;
      if (action === 'go') { const to = toUrl(url); if (to) load(t, to); }
      if (action === 'back' && t.error && allowed(wc.getURL()) && wc.getURL() !== 'about:blank') { t.error = null; t.url = wc.getURL(); t.title = wc.getTitle(); changed(); return; }
      if (action === 'back' && h.canGoBack()) h.goBack();
      if (action === 'forward' && h.canGoForward()) h.goForward();
      if (action === 'reload') { if (t.error && t.error.url) load(t, t.error.url); else wc.reload(); }
      if (action === 'stop') wc.stop();
    },
    tab(action, id) {
      if (action === 'new') { const n = makeTab(); if (n) active = n.id; }
      if (action === 'select' && tab(id)) active = id;
      if (action === 'close') close(id || active);
      changed();
    },
    state() { send('state', state()); return state(); },
    /** The page's words for Eden (read in a world of its own, so the page's scripts can't change what's read). */
    async pageText() {
      const t = current();
      if (!t || !t.url || t.error) return { error: 'Open a page first.' };
      try {
        const text = await t.view.webContents.executeJavaScriptInIsolatedWorld(1012, [{ code: `(document.body ? document.body.innerText : '').slice(0, ${TEXT_MAX})` }]);
        return { url: t.url, title: t.title, text: String(text || '').slice(0, TEXT_MAX) };
      } catch { return { error: 'Couldn’t read this page.' }; }
    },
    async selection() {
      const t = current();
      if (!t || !t.url) return '';
      try { return String(await t.view.webContents.executeJavaScriptInIsolatedWorld(1012, [{ code: 'String(getSelection())' }]) || '').slice(0, TEXT_MAX); } catch { return ''; }
    },
    find(q, dir = 1, fresh = false) {
      const t = current();
      if (!t || !t.url) return Promise.resolve({ n: 0, i: 0 });
      const wc = t.view.webContents;
      if (find) { find.done({ n: 0, i: 0 }); find = null; }
      if (!String(q || '')) { wc.stopFindInPage('clearSelection'); return Promise.resolve({ n: 0, i: 0 }); }
      return new Promise((resolve) => {
        const timer = setTimeout(() => { if (find && find.done === done) find = null; resolve({ n: 0, i: 0 }); }, 1500);
        const done = (r) => { clearTimeout(timer); resolve(r); };
        find = { requestId: wc.findInPage(String(q).slice(0, 200), { forward: dir >= 0, findNext: Boolean(fresh) }), done };
      });
    },
    zoom,
    outside() { const t = current(); if (t && t.url) outside(t.url); },
    async clear() {
      const s = profile();
      await s.clearStorageData().catch(() => {});
      await s.clearCache().catch(() => {});
      recent = [];
      if (deps.recentFile) await fs.promises.rm(deps.recentFile, { force: true }).catch(() => {});
      for (const t of tabs) { try { t.view.webContents.navigationHistory.clear(); } catch { /* gone */ } }
      changed();
    },
    /** The window closed: its views come off (the tabs stay for the next window). */
    detach(win) { if (win !== host) return; shown = false; place(); host = null; },
    _tabs: () => tabs,
  };
}

/**
 * The page's requests (preload's window.jarvisBrowser, 'eden:browser:…' channels), only from the app's own
 * page: fromPage(event) checks the sender is the main window on askeden.com. host() is that window.
 */
function install({ ipcMain, browser, fromPage, host }) {
  const on = (name, fn) => ipcMain.handle(`${CH}${name}`, (event, ...args) => (fromPage(event) ? fn(...args) : null));
  on('open', (want) => browser.open(host(), want !== false));
  on('show', (b) => browser.show(host(), b));
  on('hide', () => browser.hide(host()));
  on('bounds', (b) => browser.bounds(host(), b));
  on('nav', (action, url) => { if (['go', 'back', 'forward', 'reload', 'stop'].includes(action)) browser.nav(action, typeof url === 'string' ? url : ''); });
  on('tab', (action, id) => { if (['new', 'select', 'close'].includes(action)) browser.tab(action, Number(id) || 0); });
  on('state', () => browser.state());
  on('pagetext', () => browser.pageText());
  on('selection', () => browser.selection());
  on('find', (q, dir, fresh) => browser.find(typeof q === 'string' ? q : '', Number(dir) < 0 ? -1 : 1, Boolean(fresh)));
  on('zoom', (step) => browser.zoom(Math.sign(Number(step) || 0)));
  on('outside', () => browser.outside());
  on('clear', () => browser.clear());
}

module.exports = { createLocalBrowser, install, toUrl, allowed, cleanUa, rect, nextZoom, failure, PARTITION, CH };
