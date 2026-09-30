// The app's shell on the Mac (main.js loads it from app/features): JARVIS in the menu bar
// with what it's doing, and the quick controls there.
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
  const { Menu, Tray, nativeImage } = electron;
  const now = ctx.now || Date.now;
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
    } else if (name === 'code') {
      showWindow();
      toWindow({ action: 'open', panel: 'code' });
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

  // ── the window's reports ──

  ipcMain.handle(`${CH}hello`, (event) => {
    if (!ctx.fromWindow(event)) return null;
    windowReady = true;
    const waiting = queued.splice(0);
    setTimeout(() => waiting.forEach((c) => ctx.send(`${CH}command`, c)), 0); // after this reply
    return { dev: Boolean(ctx.dev) };
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

  refreshTray();
  return {
    act,
    tray: () => tray,
    state: () => state,
    labels: () => labels,
  };
}

module.exports = { install };
