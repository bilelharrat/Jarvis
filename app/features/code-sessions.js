// Jarvis Code sessions in the app itself: the Dock's badge counts the sessions waiting on
// an answer from you (the window's agent board sends the count).
//
// Other features can badge the Dock too: each keeps its own count in app.jarvisBadges and
// the badge shows their sum, so none overwrites another's.
'use strict';

const BADGE = 'feature:code-sessions:badge';

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
}

module.exports = { install };
