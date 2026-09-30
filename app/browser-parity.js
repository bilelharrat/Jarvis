// Chrome's everyday behaviour in the built-in browser, beside main.js (which owns the tabs, the
// dock and the page's own commands): per-site permission prompts, sign-in and payment popups,
// the leave-page question, HTTP sign-in, certificate warnings, the user agent Google's sign-in
// accepts, and Settings › Browser. main.js hands it what it needs as hooks (createParity) and
// calls it where a tab or a session is made.
//
// What the window shows comes over the app feature channels ('feature:browser:…', which
// preload.js passes through): what the tab on show waits on (a permission, a sign-in, a
// certificate warning), the site's menu, the Settings group. Nothing here is reachable from a
// page: every handler checks it's the window. JARVIS's own hands (the DevTools layer) reach
// tabs only, so a popup, a sign-in box or "Continue anyway" is always the user's to answer.
'use strict';

const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, screen, session } = require('electron');
const path = require('path');
const { SitePermissions, KINDS, originOf, hostOfOrigin } = require('./site-permissions');
const { BrowserStore } = require('./browser-store');
const lib = require('./browser-lib');
const { ENGINES, setSearchEngine, searchEngine, homeUrl } = require('./url-input');

const PARTITION = 'persist:jarvis-browser';
const CH = 'feature:browser:';
const GESTURE_MS = 5000; // a click or key this recent opened it (Chrome's user activation)
const POPUPS_MAX = 6; // popup windows open at once
const POPUP_BURST = 3; // popups one page may open in POPUP_BURST_MS
const POPUP_BURST_MS = 10000;
const AUTH_MAX = 3; // sign-in requests one tab may have waiting; more are cancelled at once

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
    app.whenReady().then(() => this.setupSession(session.fromPartition(PARTITION)));
    app.on('will-quit', () => { if (this.store) this.store.flushPending(); }); // a change a moment ago is kept
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
    this.wire(view.webContents);
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
    this.cover(wc, false);
    if (changed) this.refreshAsk();
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
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, disableBlinkFeatures: 'WebBluetooth' },
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
      this.cover(wc, true);
      this.refreshAsk();
    } else {
      this.certInBox(wc, warning);
    }
  }

  // The tab's page hides while its warning shows in the window (the page is a native view
  // over the dock's slot, whatever the window draws there).
  cover(wc, on) {
    const view = this.viewOf(wc);
    if (view && view.webContents && typeof view.setVisible === 'function') view.setVisible(!on);
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
    this.cover(wc, false);
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

  // The tab on show changed (main.js's selectTab): what it waits on is what's shown.
  selected() {
    this.refreshAsk();
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
    items.push({ label: this.label('siteSettings'), click: () => this.send('open-settings', { origin }) });
    this.popupAt(items, x, y);
    return true;
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
    return this.hello();
  }

  hello() {
    this.state();
    return {
      engine: searchEngine().id,
      engines: Object.entries(ENGINES).map(([id, e]) => ({ id, name: e.name })),
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
