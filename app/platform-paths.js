// Where the app and its Python backend keep things, per OS. The backend's own answer is
// jarvis/osplat.py (app_support, logs_dir): these must stay the same folders.
'use strict';
const os = require('os');
const path = require('path');

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';

function dataDir() { // prefs.APP_SUPPORT
  if (WIN) return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Jarvis');
  if (MAC) return path.join(os.homedir(), 'Library', 'Application Support', 'Jarvis');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'Jarvis');
}

function logDir(logName) {
  if (WIN) return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), logName, 'Logs');
  if (MAC) return path.join(os.homedir(), 'Library', 'Logs', logName);
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), logName, 'logs');
}

// Apps opened from the Dock / Start menu don't inherit the shell's PATH: look where tools live.
function extraPath() {
  const home = os.homedir();
  if (WIN) {
    return [path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin'), path.join(home, 'AppData', 'Roaming', 'npm'),
      'C:\\Program Files\\Git\\cmd', 'C:\\Program Files\\nodejs'];
  }
  return ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin')];
}

const exe = (name) => (WIN ? `${name}.exe` : name);
const logLabel = (logName) => (WIN ? `%LOCALAPPDATA%\\${logName}\\Logs\\backend.log` : MAC ? `~/Library/Logs/${logName}/backend.log` : `${logDir(logName)}/backend.log`);

// Ends a process and everything it started (the backend's terminals, dev servers, Claude sessions).
function killTree(child) {
  if (!child || !child.pid) return;
  if (WIN) {
    try { require('child_process').spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* gone */ }
  } else {
    try { child.kill('SIGTERM'); } catch { /* gone */ }
  }
}

module.exports = { WIN, MAC, dataDir, logDir, extraPath, exe, logLabel, killTree };
