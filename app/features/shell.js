// The app's shell on the Mac (main.js loads it from app/features): JARVIS in the menu bar
// with what it's doing, and the quick controls there; the Dock's menu and its badge (the
// cards waiting for an OK); macOS notifications for those cards, with Allow / Not now when
// the window isn't in front, and for heads-ups, which open JARVIS on their card; the
// window's place, remembered for each set of displays; and a crashed page reloaded.
//
// The window is the go-between: it hears the backend's events and reports JARVIS's state
// here ('feature:shell:state'), and carries out what the menus ask ('feature:shell:command')
// over its own connection. Electron comes from ctx.electron in the tests, else the real one.
'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('./shell-lib.js');
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
  const { Menu, Notification, Tray, nativeImage, screen } = electron;
  const now = ctx.now || Date.now;
  const wait = ctx.delays || { save: 500, displays: 800, reload: 500 }; // the tests' are shorter
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
    } else if (name === 'code' || name === 'browser') {
      showWindow();
      toWindow({ action: 'open', panel: name });
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
    const sign = JSON.stringify([state, labels, paused]);
    if (tray && sign === trayShown) return;
    if (!tray) tray = new Tray(icon(glyph()));
    else tray.setImage(icon(glyph()));
    trayShown = sign;
    tray.setToolTip(`J.A.R.V.I.S. · ${lib.statusLine(state, labels)}`);
    tray.setContextMenu(Menu.buildFromTemplate(lib.trayTemplate(state, labels, act, { now: now(), ask: 'Alt+Space' })));
    // The paused line goes back to "Pause…" by itself when the hour is up.
    clearTimeout(pauseTimer);
    if (paused) {
      pauseTimer = setTimeout(refreshTray, Math.min(state.pausedUntil - now() + 500, 2 ** 31 - 1));
      if (pauseTimer.unref) pauseTimer.unref();
    }
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
      windowReady = false;
      state = { ...state, online: false };
      refreshTray();
      const allowed = lib.allowReload(reloads, now());
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
    const reply = { dev: Boolean(ctx.dev), notify: canNotify, recovered };
    recovered = false; // said once
    return reply;
  });

  ipcMain.on(`${CH}state`, (event, report) => {
    if (!ctx.fromWindow(event) || !report) return;
    state = lib.normalizeState(report);
    labels = lib.mergeLabels(report.labels);
    if (state.menuBar !== store.menuBar) {
      store = { ...store, menuBar: state.menuBar }; // the next launch starts the same way
      saveStore();
    }
    refreshTray();
    refreshDock();
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
      windowReady = false;
      state = { ...state, online: false };
      refreshTray();
    });
  }

  app.on('before-quit', () => {
    quitting = true;
    if (placeTimer) { clearTimeout(placeTimer); placeTimer = null; keepPlace(); } // a move just made
  });

  watchPlace();
  watchCrashes();
  refreshTray();
  refreshDock();
  return {
    act,
    tray: () => tray,
    state: () => state,
    labels: () => labels,
    approvals: () => approvals,
  };
}

module.exports = { install };
