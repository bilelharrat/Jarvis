// Eden Code's window opens where it was left, for each set of displays (CH15). J.A.R.V.I.S. has this in shell.js,
// which Eden Code doesn't load (flavor.js); the same rules (shell-lib.js), kept in window.json in Eden Code's own
// profile. Only for the flavors without shell.js; never in the test window, which opens where it opens.
'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('./shell-lib');

const SAVE_AFTER_MS = 600; // a moment after a move or resize stops

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function write(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
    fs.renameSync(`${file}.tmp`, file);
  } catch { /* the place is a nicety: never a reason to fail */ }
}

// The store as shell-lib reads it (only its places are used here).
function load(file) {
  const raw = read(file);
  return { places: lib.readStore(JSON.stringify({ places: raw && raw.places })).places };
}

/** Restores and keeps the place of `win` on `screen`'s displays, in `file`. Returns stop(). */
function keep(win, { screen, file, min, now = Date.now, later = setTimeout, cancel = clearTimeout }) {
  let store = load(file);
  let key = lib.displaySetKey(screen.getAllDisplays());
  const saved = store.places[key];
  const place = saved && lib.placeWindow(saved, screen.getAllDisplays(), min);
  if (place) win.setBounds(place); // before it's first shown
  let timer = null;
  const save = () => {
    timer = null;
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    const current = lib.displaySetKey(screen.getAllDisplays());
    if (current !== key) { key = current; return; } // a move macOS made as displays changed: not the owner's
    store = lib.rememberPlace(store, key, win.getNormalBounds(), now());
    write(file, store);
  };
  const soon = () => { if (timer) cancel(timer); timer = later(save, SAVE_AFTER_MS); };
  win.on('move', soon);
  win.on('resize', soon);
  return () => { if (timer) { cancel(timer); save(); } };
}

module.exports = {
  keep,
  install(ctx) {
    const flavor = ctx.flavor || {};
    if (!flavor.features || flavor.features.has('shell.js') || ctx.dev) return; // J.A.R.V.I.S.: shell.js does it
    const { screen } = require('electron');
    const win = ctx.getWindow();
    if (!win || !screen) return;
    const size = flavor.size || {};
    const min = { width: size.minWidth || lib.MIN_SIZE.width, height: size.minHeight || lib.MIN_SIZE.height };
    const flush = keep(win, { screen, file: path.join(ctx.app.getPath('userData'), 'window.json'), min });
    ctx.app.on('before-quit', flush);
  },
};
