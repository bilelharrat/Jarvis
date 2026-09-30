// The app's shell on the Mac (main.js loads it from app/features): JARVIS in the menu bar
// with what it's doing, and the quick controls there; the Dock's menu and its badge (the
// cards waiting for an OK); macOS notifications for those cards, with Allow / Not now when
// the window isn't in front, and for heads-ups, which open JARVIS on their card; the
// global shortcuts for Talk and What's this?, the ones the user chose in Settings;
// jarvis:// links, and the Services menu's "Ask JARVIS" that sends a selection to one; the
// app's menu bar; opening at login; the window's place, remembered for each set of
// displays; a crashed page reloaded; and a quit that lets the backend finish first.
//
// The window is the go-between: it hears the backend's events and reports JARVIS's state
// here ('feature:shell:state'), and carries out what the menus ask ('feature:shell:command')
// over its own connection. Electron comes from ctx.electron in the tests, else the real one.
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./shell-lib.js');
const links = require('./shell-links.js');
const { iconPng } = require('./shell-icon.js');

const CH = 'feature:shell:';

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function writeAtomic(file, text) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, text);
    fs.renameSync(`${file}.tmp`, file);
  } catch (err) {
    console.warn(`shell: couldn't save ${path.basename(file)}: ${err && err.message}`);
  }
}

function install(ctx) {
  const electron = ctx.electron || require('electron');
  const { app, ipcMain } = ctx;
  const { Menu, Notification, Tray, globalShortcut, nativeImage, screen } = electron;
  const now = ctx.now || Date.now;
  const wait = ctx.delays || { save: 500, displays: 800, reload: 500, quit: 5000 }; // the tests' are shorter
  const storeFile = path.join(app.getPath('userData'), 'shell.json');
  let store = lib.readStore(readText(storeFile));
  let state = lib.normalizeState({ menuBar: store.menuBar });
  let labels = lib.mergeLabels();
  let windowReady = false; // the window's page has said hello (not the loading page)
  const queued = []; // commands for a page that isn't there yet
  let tray = null;
  let trayShown = '';
  let pauseTimer = null;
  const icons = new Map();
  const canNotify = !ctx.dev && Boolean(Notification && Notification.isSupported());
  const approvals = new Map(); // id -> the card, as the window reported it
  const approvalNotes = new Map(); // id -> its notification
  const headsUpNotes = []; // the latest few: a notification let go of leaves Notification Center
  let quitting = false;
  let reloads = []; // when a crashed page was last reloaded
  let recovered = false; // the page on show is one reloaded after a crash
  // The global shortcuts: the last ones chosen (kept in shell.json too, so they work before
  // the backend answers), registered unless this is the test window, which takes none.
  const takesShortcuts = !ctx.dev && Boolean(globalShortcut);
  let shortcuts = { ...store.shortcuts };
  const registered = { ask: false, whatsThis: false };
  const shortcutErrors = { ask: '', whatsThis: '' };
  let reportedShortcuts = '';
  let recording = false;
  let recordingTimer = null;
  let linkTimes = []; // when jarvis:// links were last opened
  // The installed app only: the test window (or `npm start`) would register itself as the
  // jarvis:// app, and a Quick Action's link would open that.
  const installed = !ctx.dev && app.isPackaged === true;
  const servicesDir = ctx.servicesDir || path.join(os.homedir(), 'Library', 'Services');
  const run = ctx.run || ((file, args) => execFile(file, args, { timeout: 15_000 }, () => {}));

  const saveStore = () => writeAtomic(storeFile, JSON.stringify(store));

  function windowOf() {
    const win = ctx.getWindow();
    return win && !win.isDestroyed() ? win : null;
  }

  function showWindow() {
    const win = windowOf();
    if (!win) return null;
    if (win.isMinimized()) win.restore();
    if (ctx.dev) {
      win.showInactive(); // the test window never takes the focus
    } else {
      win.show();
      win.focus();
      app.focus({ steal: true });
    }
    return win;
  }

  // A command for the window's page; kept (the last few) until a page is there to take it.
  function toWindow(command) {
    if (windowReady) ctx.send(`${CH}command`, command);
    else {
      queued.push(command);
      if (queued.length > 5) queued.shift();
    }
  }

  function act(name) {
    if (name === 'ask') {
      if (ctx.summon) ctx.summon();
      else { showWindow(); ctx.send('jarvis:summon'); }
    } else if (name === 'open') {
      showWindow();
    } else if (name === 'code' || name === 'browser' || name === 'settings') {
      showWindow();
      toWindow({ action: 'open', panel: name });
    } else if (name === 'history' || name === 'bookmarks') {
      showWindow();
      toWindow({ action: 'library', kind: name });
    } else if (name === 'quit') {
      app.quit();
    } else if (['mute', 'unmute', 'hands-free', 'pause', 'resume'].includes(name)) {
      if (windowReady) ctx.send(`${CH}command`, { action: name }); // never queued: only while connected
    }
  }

  // ── the menu bar icon ──

  function icon(glyph) {
    if (!icons.has(glyph)) {
      const image = nativeImage.createFromBuffer(iconPng(glyph, 1), { scaleFactor: 1 });
      image.addRepresentation({ scaleFactor: 2, buffer: iconPng(glyph, 2) });
      image.setTemplateImage(true);
      icons.set(glyph, image);
    }
    return icons.get(glyph);
  }

  function glyph() {
    if (!state.online) return 'idle';
    return state.state === 'transcribing' ? 'thinking' : state.state;
  }

  function refreshTray() {
    const want = state.menuBar && !ctx.dev;
    if (!want) {
      if (tray) { tray.destroy(); tray = null; trayShown = ''; }
      return;
    }
    const paused = state.pausedUntil > now();
    const sign = JSON.stringify([state, labels, paused, shortcuts.ask]);
    if (tray && sign === trayShown) return;
    if (!tray) tray = new Tray(icon(glyph()));
    else tray.setImage(icon(glyph()));
    trayShown = sign;
    tray.setToolTip(`J.A.R.V.I.S. · ${lib.statusLine(state, labels)}`);
    tray.setContextMenu(Menu.buildFromTemplate(lib.trayTemplate(state, labels, act, { now: now(), ask: shortcuts.ask })));
    // The paused line goes back to "Pause…" by itself when the hour is up.
    clearTimeout(pauseTimer);
    if (paused) {
      pauseTimer = setTimeout(refreshTray, Math.min(state.pausedUntil - now() + 500, 2 ** 31 - 1));
      if (pauseTimer.unref) pauseTimer.unref();
    }
  }

  // ── the app's menu bar (in the window's language once it has said which) ──

  let appMenuShown = '';
  function refreshAppMenu() {
    if (!Menu.setApplicationMenu) return;
    const sign = JSON.stringify(labels);
    if (sign === appMenuShown) return;
    appMenuShown = sign;
    Menu.setApplicationMenu(Menu.buildFromTemplate(lib.appMenuTemplate(labels, act)));
  }

  // ── the Dock: its menu, and a badge counting the cards that wait for an OK ──

  let dockShown = '';
  function refreshDock() {
    if (ctx.dev || !app.dock) return;
    const sign = JSON.stringify([state.muted, state.online, labels]);
    if (sign !== dockShown) {
      dockShown = sign;
      app.dock.setMenu(Menu.buildFromTemplate(lib.dockTemplate(state, labels, act)));
    }
    app.dock.setBadge(approvals.size ? String(approvals.size) : '');
  }

  // ── notifications ──

  function inFront() {
    const win = windowOf();
    return Boolean(win && win.isVisible() && win.isFocused());
  }

  function forgetApproval(id) {
    approvals.delete(id);
    const note = approvalNotes.get(id);
    approvalNotes.delete(id);
    if (note) note.close();
  }

  // A card that went up while the window isn't in front: Allow / Not now on the notification
  // answer it through the window (the backend's approve command, as the card's buttons do);
  // a click opens JARVIS on it.
  function notifyApproval(a) {
    if (!canNotify || inFront() || approvalNotes.has(a.id)) return;
    const n = lib.approvalNotice(a, labels);
    const note = new Notification({
      title: n.title,
      body: n.body,
      silent: true,
      groupId: 'jarvis-approvals',
      actions: n.actions.map((text) => ({ type: 'button', text })),
    });
    note.on('action', (details, index) => {
      const at = details && Number.isInteger(details.actionIndex) ? details.actionIndex : index;
      const choice = n.answers[at];
      approvalNotes.delete(a.id);
      if (choice && approvals.has(a.id)) toWindow({ action: 'approve', id: a.id, choice });
    });
    note.on('click', () => {
      approvalNotes.delete(a.id);
      showWindow();
      toWindow({ action: 'reveal', what: 'approval', id: a.id, task: a.task });
    });
    approvalNotes.set(a.id, note);
    note.show();
  }

  function notifyHeadsUp(h) {
    const note = new Notification({ title: h.title || 'J.A.R.V.I.S.', body: h.text, silent: true, groupId: 'jarvis-heads-ups' });
    note.on('click', () => {
      showWindow();
      toWindow({ action: 'reveal', what: 'alert', key: h.key, kind: h.kind, title: h.title, text: h.text });
    });
    headsUpNotes.push(note);
    if (headsUpNotes.length > 30) headsUpNotes.shift();
    note.show();
  }

  // ── global shortcuts ──

  const SHORTCUT_ACTIONS = {
    ask: () => act('ask'), // show JARVIS and listen
    whatsThis: () => ctx.send('jarvis:whats-this'), // deliberately doesn't bring the window forward
  };

  function unregisterShortcut(slot) {
    if (!registered[slot]) return;
    try { globalShortcut.unregister(shortcuts[slot]); } catch { /* already gone */ }
    registered[slot] = false;
  }

  function registerShortcut(slot) {
    if (!takesShortcuts || recording || registered[slot]) return;
    let ok = false;
    try { ok = globalShortcut.register(shortcuts[slot], SHORTCUT_ACTIONS[slot]); } catch { ok = false; }
    registered[slot] = ok;
    shortcutErrors[slot] = ok ? '' : 'taken';
    if (!ok) console.warn(`shell: ${shortcuts[slot]} is taken by another app`);
  }

  const registerShortcuts = () => Object.keys(SHORTCUT_ACTIONS).forEach(registerShortcut);
  const unregisterShortcuts = () => Object.keys(SHORTCUT_ACTIONS).forEach(unregisterShortcut);

  function shortcutStatus() {
    const status = { live: takesShortcuts };
    for (const slot of Object.keys(SHORTCUT_ACTIONS)) {
      status[slot] = { accelerator: shortcuts[slot], label: lib.shortcutLabel(shortcuts[slot]), error: shortcutErrors[slot] };
    }
    return status;
  }

  function shortcutsChanged() {
    store = { ...store, shortcuts: { ...shortcuts } }; // the next launch starts with them
    saveStore();
    if (windowReady) ctx.send(`${CH}shortcuts`, shortcutStatus());
    refreshTray();
  }

  // The ones in the settings (the window reports them): used when they change there.
  function useShortcuts(next) {
    if (next.ask === shortcuts.ask && next.whatsThis === shortcuts.whatsThis) return;
    unregisterShortcuts();
    shortcuts = next;
    shortcutErrors.ask = '';
    shortcutErrors.whatsThis = '';
    registerShortcuts();
    shortcutsChanged();
  }

  // While Settings records a new one, ours step aside so its keys reach the window (for
  // half a minute at most, in case the page never says it's done).
  function setRecording(on) {
    clearTimeout(recordingTimer);
    recording = Boolean(on) && takesShortcuts;
    if (recording) {
      unregisterShortcuts();
      recordingTimer = setTimeout(() => setRecording(false), 30_000);
      if (recordingTimer.unref) recordingTimer.unref();
    } else {
      registerShortcuts();
    }
  }

  // A new one from Settings (typed there: the recording ends here, whatever comes of it),
  // tried at once, and the old one kept when it's taken.
  function tryShortcut(slot, accelerator) {
    setRecording(false);
    const checked = lib.checkAccelerator(accelerator);
    if (!checked.ok) return { ok: false, error: checked.error, label: lib.shortcutLabel(String(accelerator || '')) };
    const label = lib.shortcutLabel(checked.accelerator);
    const other = slot === 'ask' ? 'whatsThis' : 'ask';
    if (checked.accelerator === shortcuts[other]) return { ok: false, error: 'same', label };
    if (checked.accelerator === shortcuts[slot]) return { ok: true, accelerator: checked.accelerator, label };
    if (takesShortcuts) {
      unregisterShortcut(slot);
      let ok = false;
      try { ok = globalShortcut.register(checked.accelerator, SHORTCUT_ACTIONS[slot]); } catch { ok = false; }
      if (!ok) {
        registerShortcut(slot); // the old one again
        return { ok: false, error: 'taken', label };
      }
      registered[slot] = true;
    }
    shortcuts = { ...shortcuts, [slot]: checked.accelerator };
    shortcutErrors[slot] = '';
    shortcutsChanged();
    return { ok: true, accelerator: checked.accelerator, label };
  }

  ipcMain.handle(`${CH}shortcut`, (event, req) => {
    if (!ctx.fromWindow(event) || !req || !Object.hasOwn(SHORTCUT_ACTIONS, req.which)) return { ok: false, error: 'invalid' };
    return tryShortcut(req.which, req.accelerator);
  });

  ipcMain.on(`${CH}recording`, (event, on) => {
    if (ctx.fromWindow(event)) setRecording(on);
  });

  // ── jarvis:// links ──
  // Any web page can open one, so a link only ever shows JARVIS: the request box filled in
  // (never sent), a panel, a Jarvis Code project. At most five every ten seconds.

  function openLink(raw) {
    const allowed = lib.allowAgain(linkTimes, now(), { max: 5, windowMs: 10_000 });
    linkTimes = allowed.times;
    if (!allowed.ok) { console.warn('shell: jarvis:// links are coming too fast; this one is ignored'); return; }
    const link = links.parseLink(raw);
    if (!link) { console.warn('shell: ignored a jarvis:// link JARVIS doesn\'t open'); return; }
    showWindow();
    if (link.action === 'ask') toWindow({ action: 'prefill', text: link.text });
    else if (link.action === 'open' && link.panel) toWindow({ action: 'open', panel: link.panel });
    else if (link.action === 'code') toWindow({ action: 'project', name: link.project });
  }

  if (ctx.onOpenUrl) ctx.onOpenUrl(openLink);
  else app.on('open-url', (event, url) => { event.preventDefault(); openLink(url); });
  if (installed && !app.isDefaultProtocolClient('jarvis')) app.setAsDefaultProtocolClient('jarvis');

  // ── the Services menu's "Ask JARVIS" ──
  // Written into ~/Library/Services only when the owner clicks Add in Settings; only ours
  // is ever replaced or removed (never a Quick Action of theirs with the same name).

  const serviceDir = path.join(servicesDir, links.SERVICE_BUNDLE);
  const serviceInfo = () => readText(path.join(serviceDir, 'Contents', 'Info.plist'));

  function serviceStatus(error = '') {
    const info = serviceInfo();
    const ours = links.isOurService(info);
    return { available: installed, installed: ours, taken: Boolean(info) && !ours, error };
  }

  function addService() {
    if (serviceInfo() && !links.isOurService(serviceInfo())) return serviceStatus('taken');
    const staging = path.join(servicesDir, `.jarvis-service-${process.pid}`);
    try {
      fs.rmSync(staging, { recursive: true, force: true });
      for (const [rel, text] of Object.entries(links.serviceFiles())) {
        fs.mkdirSync(path.dirname(path.join(staging, rel)), { recursive: true });
        fs.writeFileSync(path.join(staging, rel), text);
      }
      fs.rmSync(serviceDir, { recursive: true, force: true }); // ours, from before
      fs.renameSync(staging, serviceDir);
    } catch (err) {
      fs.rmSync(staging, { recursive: true, force: true });
      console.warn(`shell: couldn't add the Quick Action: ${err && err.message}`);
      return serviceStatus('failed');
    }
    run('/System/Library/CoreServices/pbs', ['-update']); // the Services menu sees it now
    return serviceStatus();
  }

  function removeService() {
    if (!links.isOurService(serviceInfo())) return serviceStatus();
    try {
      fs.rmSync(serviceDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`shell: couldn't remove the Quick Action: ${err && err.message}`);
      return serviceStatus('failed');
    }
    run('/System/Library/CoreServices/pbs', ['-update']);
    return serviceStatus();
  }

  ipcMain.handle(`${CH}service`, (event, req) => {
    if (!ctx.fromWindow(event)) return null;
    const action = req && req.action;
    if (installed && action === 'add') return addService();
    if (installed && action === 'remove') return removeService();
    return serviceStatus();
  });

  // ── opening at login (the installed app only: macOS's Login Items keep the setting) ──

  function loginStatus(error = '') {
    if (!installed) return { available: false, on: false, status: '', error };
    const settings = app.getLoginItemSettings();
    return { available: true, on: Boolean(settings.openAtLogin), status: String(settings.status || ''), error };
  }

  ipcMain.handle(`${CH}login`, (event, req) => {
    if (!ctx.fromWindow(event)) return null;
    if (installed && req && typeof req.on === 'boolean') {
      try {
        app.setLoginItemSettings({ openAtLogin: req.on });
      } catch (err) {
        console.warn(`shell: couldn't change the login item: ${err && err.message}`);
        return loginStatus('failed');
      }
    }
    return loginStatus();
  });

  // ── the window's place, for each set of displays ──

  let displaysKey = '';
  let placeTimer = null;
  let displaysTimer = null;

  function currentKey() {
    return lib.displaySetKey(screen.getAllDisplays());
  }

  // Kept when the user moves or resizes the window, a moment after they stop; never for a
  // move macOS made because a display came or went (the old set's place stays as it was).
  function keepPlace() {
    const win = windowOf();
    if (!win || win.isMinimized() || win.isFullScreen()) return;
    const key = currentKey();
    if (key !== displaysKey) return; // the displays just changed: settled in placeFor()
    store = lib.rememberPlace(store, key, win.getNormalBounds(), now());
    saveStore();
  }
  const keepPlaceSoon = () => {
    clearTimeout(placeTimer);
    placeTimer = setTimeout(keepPlace, wait.save);
  };

  // The window where it was on these displays; else, if it's off every screen now, the
  // middle of the main one.
  function placeFor(displays) {
    const win = windowOf();
    if (!win) return;
    const saved = store.places[displaysKey];
    const place = (saved && lib.placeWindow(saved, displays))
      || lib.placeWindow(win.getNormalBounds(), displays)
      || lib.centerOn(screen.getPrimaryDisplay().workArea, win.getNormalBounds());
    win.setBounds(place);
  }

  function displaysChanged() {
    clearTimeout(displaysTimer);
    displaysTimer = setTimeout(() => {
      const key = currentKey();
      if (key === displaysKey) return; // the visible area moved (the Dock, the menu bar): no matter
      displaysKey = key;
      placeFor(screen.getAllDisplays());
    }, wait.displays);
  }

  function watchPlace() {
    const win = windowOf();
    if (!win || ctx.dev || !screen) return; // the test window opens where it opens
    displaysKey = currentKey();
    const saved = store.places[displaysKey];
    const place = saved && lib.placeWindow(saved, screen.getAllDisplays());
    if (place) win.setBounds(place); // before it's first shown
    win.on('move', keepPlaceSoon);
    win.on('resize', keepPlaceSoon);
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, displaysChanged);
  }

  // ── a crashed page ──
  // Reloaded with a word about it, at most three times in five minutes; past that, the
  // loading page says what happened instead of a crash loop.
  function watchCrashes() {
    const win = windowOf();
    if (!win) return;
    win.webContents.on('render-process-gone', (_event, details) => {
      if (quitting || (details && details.reason === 'clean-exit')) return;
      if (recording) setRecording(false);
      windowReady = false;
      state = { ...state, online: false };
      refreshTray();
      const allowed = lib.allowAgain(reloads, now());
      reloads = allowed.times;
      const w = windowOf();
      if (!w) return;
      if (!allowed.ok) {
        console.error(`shell: the window's page stopped again (${details && details.reason}); not reloading`);
        w.loadFile(path.join(__dirname, '..', 'loading.html'), { query: { error: 'The window stopped several times in a few minutes. Quit J.A.R.V.I.S. and open it again; details are in ~/Library/Logs/Jarvis.' } });
        return;
      }
      console.warn(`shell: the window's page stopped (${details && details.reason}); reloading it`);
      recovered = true;
      setTimeout(() => { const again = windowOf(); if (again) again.webContents.reload(); }, wait.reload);
    });
  }

  // ── the window's reports ──

  ipcMain.handle(`${CH}hello`, (event) => {
    if (!ctx.fromWindow(event)) return null;
    windowReady = true;
    const waiting = queued.splice(0);
    setTimeout(() => waiting.forEach((c) => ctx.send(`${CH}command`, c)), 0); // after this reply
    const reply = { dev: Boolean(ctx.dev), notify: canNotify, recovered, shortcuts: shortcutStatus() };
    recovered = false; // said once
    return reply;
  });

  ipcMain.on(`${CH}state`, (event, report) => {
    if (!ctx.fromWindow(event) || !report) return;
    state = lib.normalizeState(report);
    labels = lib.mergeLabels(report.labels);
    const chosen = JSON.stringify(report.shortcuts || null);
    if (chosen !== reportedShortcuts) { // changed in the settings (or first heard)
      reportedShortcuts = chosen;
      useShortcuts(lib.normalizeShortcuts(report.shortcuts));
    }
    if (state.menuBar !== store.menuBar) {
      store = { ...store, menuBar: state.menuBar }; // the next launch starts the same way
      saveStore();
    }
    refreshTray();
    refreshDock();
    refreshAppMenu();
  });

  // Every card waiting when the window (re)connects: the badge counts them; one that's gone
  // takes its notification with it.
  ipcMain.on(`${CH}approvals`, (event, list) => {
    if (!ctx.fromWindow(event) || !list || !Array.isArray(list.items)) return;
    const waiting = new Map(list.items.slice(0, 50).map(lib.normalizeApproval).filter(Boolean).map((a) => [a.id, a]));
    for (const id of [...approvals.keys()]) if (!waiting.has(id)) forgetApproval(id);
    for (const [id, a] of waiting) approvals.set(id, a);
    refreshDock();
  });

  ipcMain.on(`${CH}approval`, (event, raw) => {
    if (!ctx.fromWindow(event)) return;
    const a = lib.normalizeApproval(raw);
    if (!a || approvals.size >= 50) return;
    approvals.set(a.id, a);
    refreshDock();
    notifyApproval(a);
  });

  ipcMain.on(`${CH}approval-done`, (event, done) => {
    if (!ctx.fromWindow(event) || !done || typeof done.id !== 'string') return;
    forgetApproval(done.id);
    refreshDock();
  });

  ipcMain.on(`${CH}heads-up`, (event, raw) => {
    if (!ctx.fromWindow(event) || !canNotify) return;
    const h = lib.normalizeHeadsUp(raw);
    if (h) notifyHeadsUp(h);
  });

  // A new page in the window (a reload, the backend back after a restart): it says hello
  // again when it's ready, and until then JARVIS counts as offline.
  const win = windowOf();
  if (win) {
    win.webContents.on('did-navigate', () => {
      if (recording) setRecording(false); // the page that was recording is gone
      windowReady = false;
      state = { ...state, online: false };
      refreshTray();
    });
  }

  // Quitting lets the backend finish first: main.js has asked it to stop (SIGTERM, which
  // `uv run` passes on and `jarvis serve` answers by saving and closing), and the app waits
  // up to five seconds for it to be gone, out of sight meanwhile. A Jarvis opened again
  // straight away then finds its data free instead of another backend still holding it.
  let released = false;
  let waiting = false;
  app.on('before-quit', (event) => {
    quitting = true;
    if (placeTimer) { clearTimeout(placeTimer); placeTimer = null; keepPlace(); } // a move just made
    if (released || ctx.dev || !ctx.backend) return;
    const proc = ctx.backend();
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return; // nothing to wait for
    event.preventDefault();
    if (waiting) return;
    waiting = true;
    const win = windowOf();
    if (win) win.hide();
    if (tray) { tray.destroy(); tray = null; trayShown = ''; }
    if (!proc.killed) proc.kill('SIGTERM');
    let timer = null;
    const go = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      app.quit();
    };
    timer = setTimeout(() => {
      console.warn('shell: the backend is still stopping; quitting without it');
      go();
    }, wait.quit);
    proc.once('exit', go);
  });

  if (takesShortcuts) {
    ctx.ownsShortcuts = true; // main.js leaves ⌥Space and ⌥⇧Space to these
    registerShortcuts();
  }
  watchPlace();
  watchCrashes();
  refreshTray();
  refreshDock();
  refreshAppMenu();
  return {
    act,
    tray: () => tray,
    state: () => state,
    labels: () => labels,
    approvals: () => approvals,
  };
}

module.exports = { install };
