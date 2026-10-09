// Eden Code, the coding app split out of J.A.R.V.I.S. (flavor.js), opened from Jarvis: the
// Code button in the dock ('feature:eden-code:open') opens it as an app of its own, which
// shares this app's backend (backend-share.js), so its sessions are the ones Jarvis knows.
//
// Which Eden Code: the installed Eden Code.app (beside this app, in /Applications or
// ~/Applications: the J.A.R.V.I.S. disk image carries both), else this app's own code run as
// Eden Code (--eden-code: the same files, Eden's name, window and icon), so Jarvis always has it.
// Only the window may ask (ctx.fromWindow).
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CH = 'feature:eden-code:';
const APP_NAME = 'Eden Code.app';

/** Where an installed Eden Code.app is, else ''. bundle: this app's own .app ('' unpackaged). */
function findInstalled({ bundle = '', home = os.homedir(), exists = fs.existsSync, platform = process.platform } = {}) {
  if (platform === 'win32') { // electron-builder's per-user install, else the folder beside this app
    const exe = 'Eden Code.exe';
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [bundle ? path.join(path.dirname(bundle), '..', 'Eden Code', exe) : '', path.join(local, 'Programs', 'Eden Code', exe)]
      .filter(Boolean).map((p) => path.normalize(p)).find((p) => exists(p)) || '';
  }
  const places = [
    bundle ? path.join(path.dirname(bundle), APP_NAME) : '',
    path.join('/Applications', APP_NAME),
    path.join(home, 'Applications', APP_NAME),
  ].filter(Boolean);
  return places.find((p) => exists(path.join(p, 'Contents', 'Info.plist'))) || '';
}

/** How to start Eden Code: { command, args } — `open` on the installed app, else this app as Eden Code. */
function launchCommand({ installed, packaged, execPath, appPath }) {
  if (installed) return process.platform === 'win32' ? { command: installed, args: [] } : { command: '/usr/bin/open', args: ['-a', installed] };
  // Unpackaged (npm start): Electron runs the app folder; packaged, the app is the binary.
  return { command: execPath, args: packaged ? ['--eden-code'] : [appPath, '--eden-code'] };
}

function install(ctx) {
  const { app, ipcMain } = ctx;
  if (ctx.flavor && ctx.flavor.id === 'eden-code') return; // Eden Code doesn't open itself
  if (ctx.dev) return; // the test window opens Eden Code in itself (app.js), never another app
  const bundle = () => (app.isPackaged ? (process.platform === 'win32' ? path.dirname(process.execPath) : path.resolve(process.execPath, '..', '..', '..')) : '');

  const status = () => {
    const installed = findInstalled({ bundle: bundle() });
    return { installed: Boolean(installed), where: installed };
  };

  ipcMain.handle(`${CH}status`, (event) => (ctx.fromWindow(event) ? status() : null));
  ipcMain.handle(`${CH}open`, (event) => {
    if (!ctx.fromWindow(event)) return { ok: false };
    const installed = findInstalled({ bundle: bundle() });
    const how = launchCommand({ installed, packaged: app.isPackaged, execPath: process.execPath, appPath: app.getAppPath() });
    try {
      const env = { ...process.env };
      delete env.EDEN_CODE;
      delete env.JARVIS_BACKEND_URL; // a test window's dev backend is never Eden Code's
      const child = spawn(how.command, how.args, { detached: true, stdio: 'ignore', env });
      child.on('error', () => {});
      child.unref();
      return { ok: true, installed: Boolean(installed) };
    } catch (err) {
      return { ok: false, error: String(err && err.message) };
    }
  });
}

module.exports = { install, findInstalled, launchCommand };
