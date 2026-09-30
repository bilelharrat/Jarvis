// Health & safety's part of the app itself: pick the folder backups go to, pick a backup
// file to restore from, and restart Jarvis after a restore (the next start puts the backup
// in place before anything reads the data). Only the window may ask (ctx.fromWindow).
'use strict';

const os = require('os');
const path = require('path');

// The window says what the dialog asks, in its own language (a short line of text only).
function words(text, fallback) {
  return typeof text === 'string' && text.trim() && text.length <= 200 ? text : fallback;
}

function handlers({ dialog, app, getWindow, dev }) {
  const parent = () => { const w = getWindow(); return w && !w.isDestroyed() ? w : undefined; };
  const start = (current, fallback) => (typeof current === 'string' && path.isAbsolute(current) ? current : fallback);
  return {
    async pickFolder(current, message) {
      const said = words(message, 'Choose where Jarvis keeps its backups');
      const result = await dialog.showOpenDialog(parent(), {
        title: said,
        message: said,
        defaultPath: start(current, path.join(os.homedir(), 'Documents')),
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
    },
    async pickBackup(current, message) {
      const said = words(message, 'Choose a Jarvis backup to restore');
      const result = await dialog.showOpenDialog(parent(), {
        title: said,
        message: said,
        defaultPath: start(current, path.join(os.homedir(), 'Documents')),
        properties: ['openFile'],
        filters: [{ name: 'Jarvis backup', extensions: ['zip'] }],
      });
      return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
    },
    // The development window doesn't own its backend: it can't restart it.
    restart() {
      if (dev) return { ok: false, dev: true };
      app.relaunch();
      app.quit();
      return { ok: true };
    },
  };
}

function install(ctx) {
  const { dialog } = require('electron');
  const h = handlers({ dialog, app: ctx.app, getWindow: ctx.getWindow, dev: ctx.dev });
  ctx.ipcMain.handle('feature:ops:pick-folder', (event, current, message) => (ctx.fromWindow(event) ? h.pickFolder(current, message) : null));
  ctx.ipcMain.handle('feature:ops:pick-backup', (event, current, message) => (ctx.fromWindow(event) ? h.pickBackup(current, message) : null));
  ctx.ipcMain.handle('feature:ops:restart', (event) => (ctx.fromWindow(event) ? h.restart() : { ok: false }));
}

module.exports = { install, handlers };
