// Chrome's everyday behaviour in the built-in browser, beside main.js (which owns the tabs, the
// dock and the page's own commands): per-site permission prompts, sign-in and payment popups,
// the leave-page question, HTTP sign-in, certificate warnings, pinned and muted tabs and their
// order, the tabs reopened next time, each site's zoom, the address bar's suggestions,
// bookmark folders and what's imported from another browser, PDFs (read for JARVIS, saved),
// clearing a site's data, the user agent Google's sign-in accepts, and Settings › Browser. main.js hands it what it needs
// as hooks (createParity) and calls it where a tab or a session is made.
//
// What the window shows comes over the app feature channels ('feature:browser:…', which
// preload.js passes through): what the tab on show waits on (a permission, a sign-in, a
// certificate warning), the site's menu, the Settings group. Nothing here is reachable from a
// page: every handler checks it's the window. JARVIS's own hands (the DevTools layer) reach
// tabs only, so a popup, a sign-in box or "Continue anyway" is always the user's to answer.
'use strict';

const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, screen, session, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const { SitePermissions, KINDS, originOf, hostOfOrigin } = require('./site-permissions');
const { BrowserStore } = require('./browser-store');
const lib = require('./browser-lib');
const { ENGINES, setSearchEngine, searchEngine, homeUrl, toUrl } = require('./url-input');

const PARTITION = 'persist:jarvis-browser';
const CH = 'feature:browser:';
const GESTURE_MS = 5000; // a click or key this recent opened it (Chrome's user activation)
const POPUPS_MAX = 6; // popup windows open at once
const POPUP_BURST = 3; // popups one page may open in POPUP_BURST_MS
const POPUP_BURST_MS = 10000;
const AUTH_MAX = 3; // sign-in requests one tab may have waiting; more are cancelled at once
const SESSION_MS = 1000; // the tabs are written down a moment after they change
const PDF_MAX = 25 * 1024 * 1024; // the biggest PDF read for JARVIS (browser_pdf.py takes the same)
const ZOOM_SITES_MAX = 1000;

// English; the window sends them in the owner's language (feature:browser:labels).
const LABELS = {
  camera: 'Camera', microphone: 'Microphone', location: 'Location', notifications: 'Notifications', clipboard: 'Clipboard',
  ask: 'Ask (default)', allow: 'Allow', block: 'Block', dontAllow: "Don't allow",
  siteSettings: 'Site settings…', filesHere: 'Files on this Mac',
  wants: '{host} wants to use your {what}', and: '{a} and {b}',
  leave: 'Leave', stay: 'Stay', leaveTitle: 'Leave {host}?', leaveDetail: 'Changes you made may not be saved.',
  goBack: 'Back to safety', proceed: 'Continue anyway (unsafe)', certTitle: 'Your connection to {host} isn’t private',
  certDetail: 'Someone could be pretending to be this site to steal what you type or see there, like passwords, messages or card numbers.',
  cert_authority: 'Its certificate isn’t from an authority this Mac trusts.', cert_date: 'Its certificate has expired, or isn’t valid yet.',
  cert_name: 'Its certificate is for another site.', cert_revoked: 'Its certificate was withdrawn.',
  cert_weak: 'Its certificate uses weak security.', cert_other: 'Its certificate has a problem.',
  reload: 'Reload', duplicate: 'Duplicate', pinTab: 'Pin tab', unpinTab: 'Unpin tab', muteTab: 'Mute tab',
  unmuteTab: 'Unmute tab', closeTab: 'Close tab', closeOthers: 'Close other tabs',
  savePdf: 'Save as PDF…', openIn: 'Open in {app}', openInBrowser: 'Open in your browser',
  clearSite: 'Clear this site’s data…', clear: 'Clear', cancel: 'Cancel',
  clearSiteTitle: 'Clear the data {host} keeps?', clearSiteDetail: 'Its cookies, cache and stored data go, and you’re signed out of it.',
  clearAllTitle: 'Clear all cookies and site data?', clearAllDetail: 'Every site’s cookies, cache and stored data go, and you’re signed out of sites, the Research Center too.',
};

class BrowserParity {
  constructor(hooks) {
    this.hooks = hooks;
    this.labels = { ...LABELS };
    this.store = null; // browser-state.json, read at first use (app.getPath needs the app ready)
    this.permissions = new Map(); // session -> SitePermissions
    this.sessions = new WeakSet(); // set up already
    this.lastAsk = '';
    this.lastSite = '';
    this.seq = 0;
    this.inputAt = new WeakMap(); // webContents -> the user's last click or key in it
    this.bursts = new WeakMap(); // webContents -> when it opened its last popups
    this.popups = new Set(); // popup windows open
    this.going = new Map(); // tab id -> the address its main frame is going to
    this.auths = new Map(); // tab id -> [sign-in asks]
    this.certs = new Map(); // tab id -> its certificate warning
    this.certOk = new Set(); // "host|fingerprint" the user continued to anyway, this session only
    this.restored = false; // the tabs from last time were put back (or there were none)
    this.quitting = false;
    this.sessionTimer = null;
    this.windowCover = false; // a panel of the window's is over the page (the address bar's list)
    // The Mac's own box, on a window of the browser's (tests hand in their own).
    this.box = hooks.box || ((owner, options) => (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options)));
    this.boxSync = hooks.boxSync || ((owner, options) => dialog.showMessageBoxSync(owner, options));
    // A popup comes to the front (the test window's never take the focus; tests show none).
    this.showPopup = hooks.showPopup || ((child) => { if (hooks.dev) child.showInactive(); else { child.show(); child.focus(); } });
    this.handle('hello', () => this.hello());
    this.handle('labels', (labels) => { this.setLabels(labels); return true; });
    this.handle('answer', (msg) => this.answer(msg || {}));
    this.handle('auth', (msg) => this.authAnswer(msg || {}));
    this.handle('cert', (msg) => this.certAnswer(msg || {}));
    this.handle('site-menu', (msg) => this.siteMenu(msg || {}));
    this.handle('sites', () => this.sitesList());
    this.handle('site', (msg) => this.setSite(msg || {}));
    this.handle('settings', (msg) => this.settings(msg || {}));
    this.handle('tab', (msg) => this.tabAction(msg || {}));
    this.handle('suggest', (msg) => this.suggest(msg || {}));
    this.handle('cover', (msg) => this.setCover(msg || {}));
    this.handle('dock', (msg) => this.dock(msg || {}));
    this.handle('bookmark', (msg) => this.bookmarkEdit(msg || {}));
    this.handle('folder', (msg) => this.folderRename(msg || {}));
    this.handle('import', (msg) => this.importData(msg || {}));
    this.handle('more-menu', (msg) => this.moreMenu(msg || {}));
    this.handle('clear-data', (msg) => this.clearAll(msg || {}));
    this.saveDialog = hooks.saveDialog || ((owner, options) => (owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options)));
    this.openExternal = hooks.openExternal || ((url) => shell.openExternal(url));
    this.pdfCache = null; // the last PDF read: { tab, url, bytes }
    app.whenReady().then(() => this.setupSession(session.fromPartition(PARTITION)));
    // Quitting: the tabs as they are now are the ones to reopen (not the none left as windows
    // close), and a change a moment ago is kept.
    app.on('before-quit', () => { if (!this.quitting && this.restored) this.sessionNow(); this.quitting = true; });
    app.on('will-quit', () => { if (this.store) this.store.flushPending(); });
  }

  handle(name, fn) {
    ipcMain.handle(CH + name, (event, ...args) => (this.hooks.fromWindow(event) ? fn(...args) : null));
  }

  send(name, payload) {
    this.hooks.send(CH + name, payload);
  }

  state() {
    if (!this.store) {
      this.store = new BrowserStore(path.join(app.getPath('userData'), 'browser-state.json'));
      setSearchEngine(this.store.data.engine);
    }
    return this.store.data;
  }

  save() {
    this.state();
    this.store.save();
  }

  setLabels(labels) {
    if (!labels || typeof labels !== 'object') return;
    for (const key of Object.keys(LABELS)) {
      if (typeof labels[key] === 'string' && labels[key].length <= 300) this.labels[key] = labels[key];
    }
  }

  label(key, vars = {}) {
    return String(this.labels[key] || LABELS[key] || key).replace(/\{(\w+)\}/g, (_m, k) => (k in vars ? vars[k] : ''));
  }

  isTab(wc) {
    return Boolean(wc) && this.hooks.tabs().some((v) => v.webContents === wc);
  }

  // The tab on show's page, while it's there (a closed view has no webContents at all).
  activeWc() {
    const view = this.hooks.active();
    const wc = view && view.webContents;
    return wc && !wc.isDestroyed() ? wc : null;
  }

  viewOf(wc) {
    return this.hooks.tabs().find((v) => v.webContents === wc) || null;
  }

  // The window a page is in: the J.A.R.V.I.S. window for a tab, its own for a popup.
  ownerOf(wc) {
    if (this.isTab(wc)) return this.hooks.window();
    const owner = BrowserWindow.fromWebContents(wc);
    return owner && !owner.isDestroyed() ? owner : null;
  }

  // ── sessions: what every browser session gets once ──

  setupSession(ses) {
    if (!ses || this.sessions.has(ses)) return;
    this.sessions.add(ses);
    this.state();
    // Chromium's own user agent, without "Electron/…" and the app's name (Google's sign-in
    // turns such a browser away). Nothing else changes.
    ses.setUserAgent(lib.cleanUserAgent(ses.getUserAgent(), app.getName()));
    const perms = this.permissionsFor(ses);
    ses.setPermissionRequestHandler((wc, permission, callback, details = {}) => {
      this.request(perms, wc, permission, details).then((ok) => callback(Boolean(ok)), () => callback(false));
    });
    ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details = {}) => {
      const origin = originOf(wc && !wc.isDestroyed() ? wc.getURL() : requestingOrigin) || originOf(requestingOrigin);
      return perms.check({ tab: wc ? wc.id : 0, origin, permission, details });
    });
    // Devices a page could reach directly stay out of reach: USB, HID and serial are refused
    // (their pickers never open), and so is Bluetooth (below, per page).
    ses.setDevicePermissionHandler(() => false);
    ses.on('select-hid-device', (event, _details, callback) => { event.preventDefault(); callback(); });
    ses.on('select-serial-port', (event, _ports, _wc, callback) => { event.preventDefault(); callback(''); });
    ses.on('select-usb-device', (event, _details, callback) => { event.preventDefault(); callback(); });
  }

  permissionsFor(ses) {
    let perms = this.permissions.get(ses);
    if (!perms) {
      const data = this.state();
      perms = new SitePermissions({
        sites: data.sites,
        onSave: (sites) => { this.state().sites = sites; this.save(); },
        onChange: () => this.refreshAsk(),
      });
      this.permissions.set(ses, perms);
    }
    return perms;
  }

  // A page asking: a tab of the dock waits for the window's prompt; a page in a window of its
  // own (a sign-in popup) asks in a box on that window, and one in a window nobody sees (Jarvis
  // Code's check of a dev server) is refused.
  request(perms, wc, permission, details) {
    if (!wc || wc.isDestroyed()) return Promise.resolve(false);
    const origin = originOf(details.isMainFrame === false ? wc.getURL() : details.requestingUrl || wc.getURL()) || originOf(wc.getURL());
    const asked = perms.request({ tab: wc.id, origin, permission, details });
    if (!this.isTab(wc)) {
      const waiting = perms.waiting(wc.id);
      if (waiting && !waiting.boxed) {
        waiting.boxed = true; // one box for it, however often the page asks meanwhile
        this.askInBox(perms, wc, waiting);
      }
    }
    return asked;
  }

  askInBox(perms, wc, prompt) {
    const owner = BrowserWindow.fromWebContents(wc);
    if (!owner || owner.isDestroyed() || !owner.isVisible()) { perms.answer(prompt.id, 'dismiss'); return; }
    const what = this.kindsText(prompt.kinds);
    const options = {
      type: 'question', buttons: [this.label('allow'), this.label('dontAllow')], defaultId: 1, cancelId: 1,
      message: this.label('wants', { host: hostOfOrigin(prompt.origin), what }),
    };
    this.box(owner, options)
      .then((r) => perms.answer(prompt.id, r.response === 0 ? 'allow' : 'dismiss'))
      .catch(() => perms.answer(prompt.id, 'dismiss'));
  }

  kindsText(kinds) {
    const names = kinds.map((k) => this.label(k).toLowerCase());
    return names.length > 1 ? this.label('and', { a: names.slice(0, -1).join(', '), b: names[names.length - 1] }) : names[0] || '';
  }

  // ── each page: its tab's or popup's events ──

  wireTab(view) {
    const wc = view.webContents;
    this.wire(wc);
    // A tab's sound shows on it; what it's on is written down for next time.
    wc.on('audio-state-changed', () => this.changed());
    for (const event of ['did-navigate', 'did-navigate-in-page', 'page-title-updated']) wc.on(event, () => this.sessionSoon());
    wc.once('destroyed', () => this.sessionSoon());
    this.sessionSoon();
  }

  changed() {
    if (this.hooks.changed) this.hooks.changed();
  }

  wire(wc) {
    const id = wc.id;
    this.setupSession(wc.session);
    const perms = this.permissionsFor(wc.session);
    // A new page on the way: what the old one waited on goes (a sign-in, a certificate warning).
    wc.on('did-start-navigation', (e, url, inPlace, isMainFrame) => {
      const main = e && typeof e.isMainFrame === 'boolean' ? e.isMainFrame : isMainFrame;
      const same = e && typeof e.isSameDocument === 'boolean' ? e.isSameDocument : inPlace;
      if (main && !same) this.started(wc, (e && e.url) || url);
    });
    wc.on('did-redirect-navigation', (e, url, inPlace, isMainFrame) => {
      const main = e && typeof e.isMainFrame === 'boolean' ? e.isMainFrame : isMainFrame;
      if (main) this.going.set(id, String((e && e.url) || url || ''));
    });
    wc.on('did-navigate', (_e, url) => { perms.navigated(id, originOf(url)); this.refreshAsk(); });
    wc.on('did-navigate-in-page', () => this.refreshAsk());
    wc.on('select-bluetooth-device', (event, _devices, callback) => { event.preventDefault(); callback(''); });
    // A site asking for a client certificate gets none (Electron would send the first one in
    // the keychain, to any site that asks).
    wc.on('select-client-certificate', (event, _url, _list, callback) => { event.preventDefault(); callback(); });
    wc.on('will-prevent-unload', (event) => { if (this.leave(wc)) event.preventDefault(); });
    wc.on('login', (event, details, authInfo, callback) => { event.preventDefault(); this.login(wc, details || {}, authInfo || {}, callback); });
    wc.on('certificate-error', (event, url, error, certificate, callback, isMainFrame) => this.certError(wc, event, { url, error, certificate, isMainFrame }, callback));
    // The user's own clicks and keys: a popup opened right after one is a real window.
    wc.on('before-input-event', (_e, input) => { if (input && (input.type === 'keyDown' || input.type === 'rawKeyDown')) this.inputAt.set(wc, Date.now()); });
    wc.on('before-mouse-event', (_e, mouse) => { if (mouse && mouse.type === 'mouseDown') this.inputAt.set(wc, Date.now()); });
    wc.on('did-create-window', (child) => this.popupMade(child));
    wc.once('destroyed', () => {
      perms.closed(id);
      this.going.delete(id);
      if (this.pdfCache && this.pdfCache.tab === id) this.pdfCache = null;
      this.certs.delete(id);
      for (const a of this.auths.get(id) || []) this.settleAuth(a);
      this.auths.delete(id);
      this.refreshAsk();
    });
  }

  started(wc, url) {
    const id = wc.id;
    this.going.set(id, String(url || ''));
    let changed = this.certs.delete(id);
    for (const a of this.auths.get(id) || []) { this.settleAuth(a); changed = true; }
    this.auths.delete(id);
    if (changed) { this.applyCovers(); this.refreshAsk(); }
  }

  // ── popups: sign-in and payment windows ──

  // A page opening a window: one with window features, right after the user's click or key,
  // is a real window with its opener (a sign-in or payment popup); anything else is left to
  // main.js (a tab), and so is a page opening windows by itself.
  windowOpen(wc, details = {}) {
    if (!lib.isPopup(details)) return null;
    const at = this.inputAt.get(wc) || 0;
    if (Date.now() - at > GESTURE_MS) return null;
    const now = Date.now();
    const burst = (this.bursts.get(wc) || []).filter((t) => now - t < POPUP_BURST_MS);
    if (this.popups.size >= POPUPS_MAX || burst.length >= POPUP_BURST) return { action: 'deny' };
    burst.push(now);
    this.bursts.set(wc, burst);
    return { action: 'allow', overrideBrowserWindowOptions: this.popupOptions(wc, details) };
  }

  popupOptions(wc, details) {
    const owner = this.ownerOf(wc);
    const near = owner ? owner.getBounds() : null;
    const area = (near ? screen.getDisplayMatching(near) : screen.getPrimaryDisplay()).workArea;
    return {
      ...lib.popupBounds(details.features, area, near),
      show: false,
      title: lib.hostOf(details.url) || ' ',
      backgroundColor: '#ffffff',
      minWidth: lib.POPUP_MIN.width,
      minHeight: lib.POPUP_MIN.height,
      fullscreenable: false,
      // The opener's session (Electron keeps it: the popup shares its sign-in); none of
      // JARVIS's hand in the page, no Bluetooth.
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, disableBlinkFeatures: 'WebBluetooth', plugins: true },
    };
  }

  popupMade(child) {
    if (!child || child.isDestroyed()) return;
    this.popups.add(child);
    child.once('closed', () => this.popups.delete(child));
    const wc = child.webContents;
    this.wire(wc);
    // Its own popups are windows too; its links for a new window open tabs in the dock.
    wc.setWindowOpenHandler((details) => this.windowOpen(wc, details) || this.toTab(details));
    // The title bar names the site the popup is really on.
    const title = () => { if (!child.isDestroyed()) child.setTitle(lib.popupTitle(wc.getURL(), wc.getTitle())); };
    child.on('page-title-updated', (event) => { event.preventDefault(); title(); });
    wc.on('did-navigate', title);
    wc.on('did-navigate-in-page', title);
    wc.on('context-menu', (_event, p) => this.popupMenu(child, p));
    title();
    this.showPopup(child);
  }

  toTab({ url }) {
    if (/^https?:\/\//i.test(String(url || '')) && this.hooks.openTab) this.hooks.openTab(url);
    return { action: 'deny' };
  }

  // A popup's menu: the page's editing and moving, as in Chrome's.
  popupMenu(child, p = {}) {
    const wc = child.webContents;
    const items = [];
    if (p.linkURL && /^https?:/i.test(p.linkURL)) items.push({ label: 'Copy Link Address', click: () => clipboard.writeText(p.linkURL) }, { type: 'separator' });
    if (p.isEditable) {
      items.push({ role: 'undo', label: 'Undo' }, { role: 'redo', label: 'Redo' }, { type: 'separator' },
        { role: 'cut', label: 'Cut' }, { role: 'copy', label: 'Copy' }, { role: 'paste', label: 'Paste' }, { role: 'selectAll', label: 'Select All' });
    } else if (p.selectionText) {
      items.push({ role: 'copy', label: 'Copy' });
    } else {
      items.push({ label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Reload', click: () => wc.reload() });
    }
    Menu.buildFromTemplate(items).popup({ window: child });
  }

  // ── the leave-page question: a page with unsaved work asks before it goes ──

  // Answered in the Mac's box on the window the page is in, while someone can see it (the
  // page waits meanwhile, as in Chrome). With nobody to ask (the window hidden, the test
  // window) the page stays: what was typed there is never thrown away unseen.
  leave(wc) {
    const owner = this.ownerOf(wc);
    if (!owner || owner.isDestroyed() || !owner.isVisible() || this.hooks.dev) return false;
    const host = lib.hostOf(wc.getURL()) || this.label('filesHere');
    const choice = this.boxSync(owner, {
      type: 'question', buttons: [this.label('leave'), this.label('stay')], defaultId: 0, cancelId: 1,
      message: this.label('leaveTitle', { host }), detail: this.label('leaveDetail'),
    });
    return choice === 0;
  }

  // ── HTTP sign-in: a site's user name and password prompt ──

  // A tab's waits for the window's prompt (the tab on show's first); a request from another
  // site inside the page, or from a popup, is cancelled (the page shows its "unauthorized").
  login(wc, details, authInfo, callback) {
    const id = wc.id;
    const url = String(details.url || '');
    const allowed = this.isTab(wc)
      && lib.authAllowed({ url, page: wc.getURL(), going: this.going.get(id), proxy: Boolean(authInfo.isProxy) });
    if (!allowed) { callback(); return; }
    const list = this.auths.get(id) || [];
    const same = list.find((a) => a.host === authInfo.host && a.port === authInfo.port && a.realm === String(authInfo.realm || '') && a.proxy === Boolean(authInfo.isProxy));
    if (same) { same.callbacks.push(callback); return; }
    if (list.length >= AUTH_MAX) { callback(); return; }
    list.push({
      id: `a${++this.seq}`, tab: id, url, host: String(authInfo.host || ''), port: authInfo.port,
      realm: String(authInfo.realm || ''), proxy: Boolean(authInfo.isProxy), callbacks: [callback],
    });
    this.auths.set(id, list);
    this.refreshAsk();
  }

  settleAuth(a, username, password) {
    for (const callback of a.callbacks.splice(0)) {
      try { if (username === undefined) callback(); else callback(username, password); } catch { /* the request went */ }
    }
  }

  // The window's answer for the tab on show: a user name and password, or cancel.
  authAnswer({ id, username, password, cancel }) {
    const wc = this.activeWc();
    if (!wc) return false;
    const list = this.auths.get(wc.id) || [];
    const at = list.findIndex((a) => a.id === id);
    if (at < 0) return false;
    const [a] = list.splice(at, 1);
    if (cancel || typeof username !== 'string' || typeof password !== 'string') this.settleAuth(a);
    else this.settleAuth(a, username.slice(0, 1000), password.slice(0, 1000));
    this.refreshAsk();
    return true;
  }

  // ── certificate warnings ──

  // A site whose certificate fails is refused; a tab's page shows the warning in the window
  // (the tab steps aside for it), a popup's in the Mac's box. "Continue anyway" lets that
  // site's certificate through until the app quits, never beyond.
  certError(wc, event, { url, error, certificate, isMainFrame }, callback) {
    const host = lib.hostOf(url);
    const print = (certificate && certificate.fingerprint) || '';
    if (host && print && this.certOk.has(`${host}|${print}`)) {
      event.preventDefault();
      callback(true);
      return;
    }
    callback(false);
    if (!isMainFrame || !host) return;
    const warning = { id: `c${++this.seq}`, tab: wc.id, url: String(url), host, problem: lib.certProblem(error), print };
    if (this.isTab(wc)) {
      this.certs.set(wc.id, warning);
      this.applyCovers();
      this.refreshAsk();
    } else {
      this.certInBox(wc, warning);
    }
  }

  // A tab's page hides while the window shows something in its place (the page is a native
  // view over the dock's slot, whatever the window draws there): its certificate warning, or,
  // for the tab on show, a panel of the window's (the address bar's list).
  applyCovers() {
    const active = this.hooks.active();
    for (const view of this.hooks.tabs()) {
      const wc = view.webContents;
      if (!wc || wc.isDestroyed() || typeof view.setVisible !== 'function') continue;
      view.setVisible(!(this.certs.has(wc.id) || (view === active && this.windowCover)));
    }
  }

  setCover({ on }) {
    this.windowCover = Boolean(on);
    this.applyCovers();
    return true;
  }

  certInBox(wc, warning) {
    const owner = this.ownerOf(wc);
    if (!owner) return;
    const options = {
      type: 'warning', buttons: [this.label('goBack'), this.label('proceed')], defaultId: 0, cancelId: 0,
      message: this.label('certTitle', { host: warning.host }),
      detail: `${this.label(`cert_${warning.problem}`)} ${this.label('certDetail')}`,
    };
    this.box(owner, options).then((r) => {
      if (wc.isDestroyed()) return;
      if (r.response === 1) this.proceed(wc, warning);
      else if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      else if (!owner.isDestroyed()) owner.close();
    }).catch(() => {});
  }

  proceed(wc, warning) {
    if (warning.print) this.certOk.add(`${warning.host}|${warning.print}`);
    wc.loadURL(warning.url).catch(() => {});
  }

  // The window's answer for the tab on show: 'back' or 'proceed'.
  certAnswer({ id, choice }) {
    const wc = this.activeWc();
    if (!wc) return false;
    const warning = this.certs.get(wc.id);
    if (!warning || warning.id !== id) return false;
    this.certs.delete(wc.id);
    this.applyCovers();
    if (choice === 'proceed') this.proceed(wc, warning);
    else if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else wc.loadURL(homeUrl()).catch(() => {});
    this.refreshAsk();
    return true;
  }

  // ── what the tab on show waits on, as the window draws it ──

  // A certificate warning first, then a sign-in, then a site's permission prompt.
  currentAsk() {
    const wc = this.activeWc();
    if (!wc) return null;
    const cert = this.certs.get(wc.id);
    if (cert) return { id: cert.id, type: 'cert', tab: wc.id, host: cert.host, url: cert.url, problem: cert.problem };
    const auth = (this.auths.get(wc.id) || [])[0];
    if (auth) {
      return {
        id: auth.id, type: 'auth', tab: wc.id, host: auth.proxy ? `${auth.host}:${auth.port}` : lib.hostOf(auth.url) || auth.host,
        realm: auth.realm.slice(0, 200), proxy: auth.proxy, insecure: auth.proxy || lib.authInsecure(auth.url),
      };
    }
    const p = this.permissionsFor(wc.session).waiting(wc.id);
    if (!p) return null;
    return { id: p.id, type: 'permission', tab: wc.id, host: hostOfOrigin(p.origin), origin: p.origin, kinds: p.kinds };
  }

  refreshAsk() {
    const ask = this.currentAsk();
    const key = JSON.stringify(ask);
    if (key !== this.lastAsk) {
      this.lastAsk = key;
      this.send('ask', ask);
    }
    const site = this.siteState();
    if (JSON.stringify(site) !== this.lastSite) {
      this.lastSite = JSON.stringify(site);
      this.send('site-state', site);
    }
  }

  // The site's button warns while the tab on show is on a site whose certificate was let through.
  siteState() {
    const wc = this.activeWc();
    const host = wc ? lib.hostOf(wc.getURL()) : '';
    return { unsafe: Boolean(host) && [...this.certOk].some((k) => k.startsWith(`${host}|`)) };
  }

  answer({ id, choice }) {
    const wc = this.activeWc();
    for (const perms of this.permissions.values()) {
      const p = perms.pending.find((x) => x.id === id);
      if (!p) continue;
      // Only the prompt the window was showing: the tab on show's.
      if (!wc || wc.id !== p.tab) return false;
      return perms.answer(id, ['allow', 'once', 'block', 'dismiss'].includes(choice) ? choice : 'dismiss');
    }
    return false;
  }

  // The tab on show changed (main.js's selectTab): what it waits on is what's shown, and a
  // tab put back from last time loads its page now.
  selected(view) {
    if (view && view.lazy) this.wake(view);
    this.applyCovers();
    this.refreshAsk();
    this.sessionSoon();
  }

  // ── tabs: pinned first, their order, their sound, and what the dock's closing stops ──

  urlOf(view) {
    return view.lazy ? view.lazy.url : view.webContents.getURL();
  }

  // What main.js's tab list adds for each tab: pinned, playing sound, muted; a tab not loaded
  // yet (put back from last time) shows the page it will load.
  tabInfo(view) {
    const wc = view.webContents;
    const live = Boolean(wc) && !wc.isDestroyed();
    const info = { pinned: Boolean(view.pinned), audible: live && wc.isCurrentlyAudible(), muted: live && wc.isAudioMuted() };
    return view.lazy ? { ...info, url: view.lazy.url, title: view.lazy.title } : info;
  }

  order(list) {
    const tabs = this.hooks.tabs();
    tabs.splice(0, tabs.length, ...list);
  }

  tabAction({ action, id, to, x, y, labels }) {
    const view = this.hooks.tabs().find((v) => v.webContents && v.webContents.id === Number(id));
    if (!view) return false;
    const wc = view.webContents;
    if (action === 'pin' || action === 'unpin') {
      view.pinned = action === 'pin';
      this.order(lib.pinnedFirst(this.hooks.tabs()));
    } else if (action === 'mute' || action === 'unmute') {
      wc.setAudioMuted(action === 'mute');
    } else if (action === 'move') {
      this.order(lib.moveTab(this.hooks.tabs(), view, to));
    } else if (action === 'menu') {
      this.setLabels(labels);
      this.tabMenu(view, x, y);
      return true;
    } else {
      return false;
    }
    this.changed();
    this.sessionSoon();
    return true;
  }

  // A tab's own menu (right-click on it in the strip), as in Chrome.
  tabMenu(view, x, y) {
    const wc = view.webContents;
    const id = wc.id;
    const many = this.hooks.tabs().length > 1;
    const url = this.urlOf(view);
    const items = [
      { label: this.label('reload'), click: () => (view.lazy ? this.wake(view) : wc.reload()) },
      { label: this.label('duplicate'), enabled: /^https?:/i.test(url) && Boolean(this.hooks.openTab), click: () => this.hooks.openTab(url) },
      { label: this.label(view.pinned ? 'unpinTab' : 'pinTab'), click: () => this.tabAction({ action: view.pinned ? 'unpin' : 'pin', id }) },
      { label: this.label(wc.isAudioMuted() ? 'unmuteTab' : 'muteTab'), click: () => this.tabAction({ action: wc.isAudioMuted() ? 'unmute' : 'mute', id }) },
      { type: 'separator' },
      { label: this.label('closeTab'), enabled: many && Boolean(this.hooks.closeTab), click: () => this.hooks.closeTab(view) },
      { label: this.label('closeOthers'), enabled: many && Boolean(this.hooks.closeTab), click: () => { for (const v of this.hooks.tabs().slice()) if (v !== view && !v.pinned) this.hooks.closeTab(v); } },
    ];
    this.popupAt(items, x, y);
  }

  // The dock closed: every video and sound in the tabs stops (JARVIS's own tabs too).
  dock({ open }) {
    if (open) return true;
    for (const view of this.hooks.tabs()) {
      const wc = view.webContents;
      if (!wc || wc.isDestroyed() || view.lazy) continue;
      try {
        for (const frame of wc.mainFrame.framesInSubtree) frame.executeJavaScript(lib.PAUSE_MEDIA).catch(() => {});
      } catch { /* the page is going */ }
    }
    return true;
  }

  // ── the tabs kept for next time ──

  sessionSoon() {
    if (!this.restored || this.quitting) return;
    clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(() => this.sessionNow(), SESSION_MS);
    if (this.sessionTimer.unref) this.sessionTimer.unref();
  }

  sessionNow() {
    clearTimeout(this.sessionTimer);
    this.sessionTimer = null;
    const tabs = this.hooks.tabs();
    const data = this.state();
    data.session = lib.sessionOf(tabs.map((view) => this.sessionTab(view)), {
      active: tabs.indexOf(this.hooks.active()), keep: this.hooks.keep || (() => true),
    });
    this.save();
  }

  // A tab as it's kept: its page and its back and forward list (addresses and titles only;
  // never what was typed in the page). A private tab and a Jarvis Code session's aren't kept.
  sessionTab(view) {
    const wc = view.webContents;
    if (!wc || wc.isDestroyed() || view.private || String(view.agentOwner || '').startsWith('code:')) return { skip: true };
    if (view.lazy) return { ...view.lazy, pinned: Boolean(view.pinned) };
    const history = wc.navigationHistory;
    return {
      url: wc.getURL(), title: wc.getTitle(), pinned: Boolean(view.pinned),
      entries: history.getAllEntries().map((e) => ({ url: e.url, title: e.title })), index: history.getActiveIndex(),
    };
  }

  // The first time the browser is wanted: last time's tabs, when the owner keeps them. The tab
  // that was on show and the pinned ones load now, the rest when first shown.
  restore() {
    if (this.restored) return false;
    this.restored = true;
    const data = this.state();
    const saved = data.session;
    if (!data.restore || !saved.tabs.length || !this.hooks.restoreTab) return false;
    const views = saved.tabs.map((t, i) => {
      const view = this.hooks.restoreTab();
      view.pinned = t.pinned;
      if (i === saved.active || t.pinned) this.load(view, t);
      else view.lazy = t;
      return view;
    });
    this.order(lib.pinnedFirst(this.hooks.tabs()));
    this.hooks.select(views[saved.active] || views[0]);
    return true;
  }

  load(view, t) {
    const wc = view.webContents;
    if (t.entries && t.entries.length && t.index >= 0) wc.navigationHistory.restore({ entries: t.entries, index: t.index }).catch(() => {});
    else wc.loadURL(t.url).catch(() => {});
  }

  wake(view) {
    const t = view.lazy;
    if (!t) return;
    view.lazy = null;
    this.load(view, t);
  }

  // ── each site's zoom, kept (never a private tab's) ──

  zoomFor(wc) {
    const key = lib.zoomKey(wc.getURL());
    return (key && this.state().zoom[key]) || 1;
  }

  zoomed(wc, factor) {
    const view = this.viewOf(wc);
    const key = lib.zoomKey(wc.getURL());
    if (!key || (view && view.private)) return;
    const zoom = this.state().zoom;
    const f = Number(factor) || 1;
    if (Math.abs(f - 1) < 0.01) delete zoom[key];
    else if (key in zoom || Object.keys(zoom).length < ZOOM_SITES_MAX) zoom[key] = Math.round(f * 1000) / 1000;
    this.save();
  }

  // ── bookmarks: renamed, filed in folders; another browser's brought in ──

  browserData() {
    return this.hooks.browserData ? this.hooks.browserData() : null;
  }

  saved() {
    if (this.hooks.saveBrowserData) this.hooks.saveBrowserData();
  }

  bookmarkEdit({ url, title, folder }) {
    const data = this.browserData();
    if (!data) return null;
    const ok = lib.editBookmark(data.bookmarks, String(url || ''), {
      title: typeof title === 'string' ? title : undefined, folder: typeof folder === 'string' ? folder : undefined,
    });
    if (ok) this.saved();
    return { ok, folders: lib.folders(data.bookmarks) };
  }

  folderRename({ from, to }) {
    const data = this.browserData();
    if (!data || typeof from !== 'string' || typeof to !== 'string') return null;
    const moved = lib.renameFolder(data.bookmarks, from, to);
    if (moved) this.saved();
    return { moved, folders: lib.folders(data.bookmarks) };
  }

  // What the backend read from another browser (features/browser_import.py), merged: its
  // bookmarks under "Imported from <it>" (the window's words for it), its history by date.
  importData({ label, bookmarks, history }) {
    const data = this.browserData();
    if (!data || typeof label !== 'string' || !label.trim() || label.length > 80) return null;
    const added = lib.mergeImport(data, { bookmarks, history }, { label });
    this.saved();
    return added;
  }

  // ── the address bar: what's typed, and the open tabs, bookmarks and history it matches ──

  suggest({ text }) {
    const words = String(text || '').trim().slice(0, 500);
    if (!words) return { typed: null, rows: [] };
    const active = this.hooks.active();
    const tabs = this.hooks.tabs()
      .filter((v) => v.webContents && !v.webContents.isDestroyed())
      .map((v) => ({ id: v.webContents.id, url: this.urlOf(v), title: v.lazy ? v.lazy.title : v.webContents.getTitle(), active: v === active }));
    const data = this.hooks.browserData ? this.hooks.browserData() : {};
    const rows = lib.suggest(words, { tabs, bookmarks: data.bookmarks || [], history: data.history || [], limit: 7 });
    const engine = searchEngine();
    const url = toUrl(words, { typed: true });
    return { typed: { text: words, url, search: url.startsWith(engine.search), engine: engine.name }, rows };
  }

  // ── the site's menu (the button at the address's start): its permissions and data ──

  siteMenu({ x, y, labels }) {
    const wc = this.activeWc();
    const win = this.hooks.window();
    if (!wc || !win) return false;
    this.setLabels(labels);
    const origin = originOf(wc.getURL());
    if (!origin) return false;
    const perms = this.permissionsFor(wc.session);
    const host = origin === 'file://' ? this.label('filesHere') : hostOfOrigin(origin);
    const items = [{ label: host, enabled: false }, { type: 'separator' }];
    for (const kind of KINDS) {
      const now = perms.decision(origin, kind);
      items.push({
        label: `${this.label(kind)}: ${this.label(now === 'ask' ? 'ask' : now)}`,
        submenu: ['ask', 'allow', 'block'].map((value) => ({
          label: this.label(value), type: 'radio', checked: now === value,
          click: () => { perms.setDecision(origin, kind, value); this.send('sites', this.sitesList()); },
        })),
      });
    }
    items.push({ type: 'separator' });
    if (origin !== 'file://') items.push({ label: this.label('clearSite'), click: () => this.clearSite(wc, origin) });
    items.push({ label: this.label('siteSettings'), click: () => this.send('open-settings', { origin }) });
    this.popupAt(items, x, y);
    return true;
  }

  // ── clearing what sites keep: one site's (its menu), or all (Settings), after a yes ──

  async confirm(title, detail) {
    const owner = this.hooks.window();
    const options = { type: 'warning', message: title, detail, buttons: [this.label('clear'), this.label('cancel')], defaultId: 1, cancelId: 1 };
    const r = await this.box(owner, options).catch(() => ({ response: 1 }));
    return r.response === 0;
  }

  async clearSite(wc, origin) {
    const host = hostOfOrigin(origin);
    if (!(await this.confirm(this.label('clearSiteTitle', { host }), this.label('clearSiteDetail')))) return false;
    await wc.session.clearData({ origins: [origin] }).catch(() => {});
    if (!wc.isDestroyed()) wc.reload();
    return true;
  }

  async clearAll({ labels } = {}) {
    this.setLabels(labels);
    if (!(await this.confirm(this.label('clearAllTitle'), this.label('clearAllDetail')))) return { cleared: false };
    const ses = session.fromPartition(PARTITION);
    await ses.clearData().catch(() => {});
    await ses.clearAuthCache().catch(() => {});
    return { cleared: true };
  }

  // ── the page's own menu (the ⋯ at the bar's end): save it as a PDF, open it elsewhere ──

  moreMenu({ x, y, labels }) {
    const wc = this.activeWc();
    if (!wc) return false;
    this.setLabels(labels);
    this.popupAt(this.moreItems(wc), x, y);
    return true;
  }

  moreItems(wc) {
    const url = wc.getURL();
    const web = /^https?:\/\//i.test(url);
    let other = '';
    try { other = web ? app.getApplicationNameForProtocol(url) : ''; } catch { /* no default browser */ }
    if (/J\.?A\.?R\.?V\.?I\.?S/i.test(other) || other === app.getName()) other = ''; // this app itself
    const items = [
      { label: this.label('savePdf'), enabled: /^(https?|file):/i.test(url), click: () => this.savePage(wc) },
      { label: other ? this.label('openIn', { app: other.replace(/\.app$/, '') }) : this.label('openInBrowser'), enabled: web, click: () => this.openExternal(url) },
    ];
    return items;
  }

  // The page as a PDF where the owner says (a PDF itself: a copy of the file).
  async savePage(wc) {
    const url = wc.getURL();
    const pdf = await this.isPdf(wc);
    const name = `${String(wc.getTitle() || lib.hostOf(url) || 'page').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\.pdf$/i, '').trim().slice(0, 100) || 'page'}.pdf`;
    const r = await this.saveDialog(this.hooks.window(), {
      defaultPath: path.join(app.getPath('downloads'), name), filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (!r || r.canceled || !r.filePath) return false;
    let bytes;
    if (pdf) {
      const got = await this.pdfBytes(wc, url);
      if (got.error) return false;
      bytes = got.bytes;
    } else {
      bytes = await wc.printToPDF({ printBackground: true, pageSize: 'Letter' });
    }
    await fs.promises.writeFile(r.filePath, bytes);
    return true;
  }

  // ── a PDF on show, for JARVIS to read (browser_read): its bytes, which the backend reads
  // with pypdf (browser_pdf.py), fetched through the tab's own session so a PDF behind a
  // sign-in reads too; none sent again for one whose text the backend already has ──

  async isPdf(wc) {
    const type = await Promise.race([
      wc.executeJavaScript('document.contentType').catch(() => ''),
      new Promise((resolve) => setTimeout(() => resolve(''), 3000)),
    ]);
    return type === 'application/pdf';
  }

  async pdfBytes(wc, url) {
    const cached = this.pdfCache;
    if (cached && cached.tab === wc.id && cached.url === url) return cached;
    const tooBig = (n) => ({ error: `This PDF is ${Math.round(n / 1048576)} MB; I read PDFs up to ${PDF_MAX / 1048576} MB.` });
    let bytes;
    try {
      if (/^file:/i.test(url)) {
        const file = fileURLToPath(url);
        const size = (await fs.promises.stat(file)).size;
        if (size > PDF_MAX) return tooBig(size);
        bytes = await fs.promises.readFile(file);
      } else {
        const res = await wc.session.fetch(url, { credentials: 'include', signal: AbortSignal.timeout(20000) });
        if (!res.ok) return { error: `The PDF couldn't be fetched (HTTP ${res.status}).` };
        const size = Number(res.headers.get('content-length') || 0);
        if (size > PDF_MAX) return tooBig(size);
        bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.length > PDF_MAX) return tooBig(bytes.length);
      }
    } catch (err) {
      return { error: `The PDF couldn't be fetched (${err && err.message ? err.message : err}).` };
    }
    this.pdfCache = { tab: wc.id, url, bytes };
    return this.pdfCache;
  }

  // Only browser_read's own reads get the file (they say which PDFs the backend has): the
  // gates' reads of where the tab is never carry megabytes along.
  async pdfRead(view, { offset = 0, pdfKnown } = {}) {
    const wc = view.webContents;
    if (!Array.isArray(pdfKnown) || !wc || wc.isDestroyed() || !(await this.isPdf(wc))) return null;
    const url = wc.getURL();
    const where = { url, title: wc.getTitle(), tab: wc.id };
    const got = await this.pdfBytes(wc, url);
    if (got.error) return { ok: false, message: got.error, ...where };
    const sha1 = crypto.createHash('sha1').update(got.bytes).digest('hex');
    const known = pdfKnown.includes(sha1);
    return {
      ok: true, ...where, offset: Math.max(0, Number(offset) || 0),
      pdf: { sha1, size: got.bytes.length, ...(known ? {} : { data: got.bytes.toString('base64') }) },
    };
  }

  // A native menu at a point of the window's page (CSS pixels, as the window measures them).
  popupAt(items, x, y) {
    const win = this.hooks.window();
    if (!win) return;
    const zoom = win.webContents.getZoomFactor() || 1;
    Menu.buildFromTemplate(items).popup({ window: win, x: Math.round((Number(x) || 0) * zoom), y: Math.round((Number(y) || 0) * zoom) });
  }

  // ── Settings › Browser ──

  sitesList() {
    return this.permissionsFor(session.fromPartition(PARTITION)).list();
  }

  setSite({ origin, kind, value, forget }) {
    const perms = this.permissionsFor(session.fromPartition(PARTITION));
    const ok = forget ? perms.forget(String(origin || '')) : perms.setDecision(String(origin || ''), String(kind || ''), String(value || 'ask'));
    return { ok, sites: perms.list() };
  }

  settings(changes) {
    const data = this.state();
    if (typeof changes.engine === 'string' && Object.hasOwn(ENGINES, changes.engine)) {
      data.engine = setSearchEngine(changes.engine);
      this.save();
    }
    if (typeof changes.restore === 'boolean') {
      data.restore = changes.restore;
      this.save();
    }
    return this.hello();
  }

  hello() {
    this.state();
    return {
      engine: searchEngine().id,
      engines: Object.entries(ENGINES).map(([id, e]) => ({ id, name: e.name })),
      restore: this.state().restore,
      sites: this.sitesList(),
      ask: this.currentAsk(),
      site: this.siteState(),
    };
  }
}

function createParity(hooks) {
  return new BrowserParity(hooks);
}

module.exports = { createParity, BrowserParity, PARTITION, LABELS };
