// Chrome's everyday behaviour in the built-in browser, beside main.js (which owns the tabs, the
// dock and the page's own commands): per-site permission prompts, the user agent Google's
// sign-in accepts, and Settings › Browser. main.js hands it what it needs as hooks
// (createParity) and calls it where a tab or a session is made.
//
// What the window shows comes over the app feature channels ('feature:browser:…', which
// preload.js passes through): the prompt waiting on the tab on show, the site's menu, the
// Settings group. Nothing here is reachable from a page: every handler checks it's the window.
'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, session } = require('electron');
const path = require('path');
const { SitePermissions, KINDS, originOf, hostOfOrigin } = require('./site-permissions');
const { BrowserStore } = require('./browser-store');
const lib = require('./browser-lib');
const { ENGINES, setSearchEngine, searchEngine } = require('./url-input');

const PARTITION = 'persist:jarvis-browser';
const CH = 'feature:browser:';

// English; the window sends them in the owner's language (feature:browser:labels).
const LABELS = {
  camera: 'Camera', microphone: 'Microphone', location: 'Location', notifications: 'Notifications', clipboard: 'Clipboard',
  ask: 'Ask (default)', allow: 'Allow', block: 'Block', dontAllow: "Don't allow",
  siteSettings: 'Site settings…', filesHere: 'Files on this Mac',
  wants: '{host} wants to use your {what}', and: '{a} and {b}',
};

class BrowserParity {
  constructor(hooks) {
    this.hooks = hooks;
    this.labels = { ...LABELS };
    this.store = null; // browser-state.json, read at first use (app.getPath needs the app ready)
    this.permissions = new Map(); // session -> SitePermissions
    this.sessions = new WeakSet(); // set up already
    this.lastAsk = '';
    // The Mac's own box, on a window of the browser's (tests hand in their own).
    this.box = hooks.box || ((owner, options) => (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options)));
    this.handle('hello', () => this.hello());
    this.handle('labels', (labels) => { this.setLabels(labels); return true; });
    this.handle('answer', (msg) => this.answer(msg || {}));
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
    if (!this.hooks.tabs().some((v) => v.webContents === wc)) {
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

  // ── the prompt on the tab on show ──

  // The first thing the tab on show waits on, as the window draws it.
  currentAsk() {
    const view = this.hooks.active();
    if (!view || view.webContents.isDestroyed()) return null;
    const wc = view.webContents;
    const p = this.permissionsFor(wc.session).waiting(wc.id);
    if (!p) return null;
    return { id: p.id, type: 'permission', tab: wc.id, host: hostOfOrigin(p.origin), origin: p.origin, kinds: p.kinds };
  }

  refreshAsk() {
    const ask = this.currentAsk();
    const key = JSON.stringify(ask);
    if (key === this.lastAsk) return;
    this.lastAsk = key;
    this.send('ask', ask);
  }

  answer({ id, choice }) {
    const view = this.hooks.active();
    for (const perms of this.permissions.values()) {
      const p = perms.pending.find((x) => x.id === id);
      if (!p) continue;
      // Only the prompt the window was showing: the tab on show's.
      if (!view || view.webContents.id !== p.tab) return false;
      return perms.answer(id, ['allow', 'once', 'block', 'dismiss'].includes(choice) ? choice : 'dismiss');
    }
    return false;
  }

  // Each tab: its page's prompts end when it moves on, and Bluetooth devices stay out of reach.
  wireTab(view) {
    const wc = view.webContents;
    this.setupSession(wc.session);
    const perms = this.permissionsFor(wc.session);
    wc.on('did-navigate', (_e, url) => perms.navigated(wc.id, originOf(url)));
    wc.on('select-bluetooth-device', (event, _devices, callback) => { event.preventDefault(); callback(''); });
    wc.once('destroyed', () => perms.closed(wc.id));
  }

  // The tab on show changed (main.js's selectTab): its prompt is the one shown.
  selected() {
    this.refreshAsk();
  }

  // ── the site's menu (the button at the address's start): its permissions and data ──

  siteMenu({ x, y, labels }) {
    const view = this.hooks.active();
    const win = this.hooks.window();
    if (!view || !win) return false;
    this.setLabels(labels);
    const wc = view.webContents;
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
    };
  }
}

function createParity(hooks) {
  return new BrowserParity(hooks);
}

module.exports = { createParity, BrowserParity, PARTITION, LABELS };
