// Jarvis Code sessions in the app itself: the Dock's badge counts the sessions waiting on
// an answer from you (the window's agent board sends the count), and Open folder… has a
// folder picker of its own, titled for what it's for.
//
// Other features can badge the Dock too: each keeps its own count in app.jarvisBadges and
// the badge shows their sum, so none overwrites another's.
'use strict';

const os = require('os');
const { dialog } = require('electron');

const BADGE = 'feature:code-sessions:badge';
const PICK = 'feature:code-sessions:pick-folder';

function showBadge(app) {
  const total = [...app.jarvisBadges.values()].reduce((sum, n) => sum + n, 0);
  if (app.dock) app.dock.setBadge(total > 0 ? String(Math.min(total, 999)) : '');
}

function install(ctx) {
  const { app, ipcMain } = ctx;
  if (!(app.jarvisBadges instanceof Map)) app.jarvisBadges = new Map();
  ipcMain.on(BADGE, (event, count) => {
    if (!ctx.fromWindow(event)) return;
    const n = Number.isFinite(Number(count)) ? Math.max(0, Math.min(999, Math.floor(Number(count)))) : 0;
    if (app.jarvisBadges.get('code-sessions') === n) return;
    app.jarvisBadges.set('code-sessions', n);
    showBadge(app);
  });
  ipcMain.handle(PICK, async (event, kind) => {
    if (!ctx.fromWindow(event)) return null;
    const win = ctx.getWindow();
    const result = await dialog.showOpenDialog(win, {
      title: kind === 'root' ? 'Choose a folder of projects' : 'Open a folder as a project',
      buttonLabel: kind === 'root' ? 'Choose' : 'Open',
      defaultPath: os.homedir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
}

module.exports = { install };
