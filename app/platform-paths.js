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
// On the Mac it's asked (SIGTERM: the backend ends its own children), and one that hasn't gone
// KILL_AFTER later is killed (SIGKILL): a hung backend otherwise never goes, the window never
// reopens after a restart, and the next launch finds the data folder still held (exit 75).
// While the app runs that's a timer; when it's quitting (outlive: true) it's a small detached
// sh that outlives the app, looks again and kills it only if that pid is still the same process.
const KILL_AFTER = 8000;

// The detached watcher's script: the pid's start time and command line noted first, and the
// kill only when that pid still has both once the wait is over. A pid on its own isn't enough
// (round 1 A7): the backend may have gone and the system handed its pid to something else of
// the owner's in the meantime, which kill -9 would have ended. Gone before it's looked at
// (nothing noted): nothing to kill.
function outliveScript(pid, seconds) {
  const who = `ps -o lstart= -o command= -p ${pid} 2>/dev/null`;
  return `was=$(${who}); sleep ${seconds}; [ -n "$was" ] && [ "$(${who})" = "$was" ] && kill -9 ${pid}`;
}
function killTree(child, { outlive = false, after = KILL_AFTER, spawn = null, setTimer = setTimeout } = {}) {
  if (!child || !child.pid) return;
  const cp = require('child_process');
  if (WIN) {
    try { cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* gone */ }
    return;
  }
  try { child.kill('SIGTERM'); } catch { /* gone */ }
  const pid = Number(child.pid);
  if (!Number.isInteger(pid) || pid <= 1) return;
  if (outlive) {
    const seconds = Math.max(1, Math.round(after / 1000));
    try {
      (spawn || cp.spawn)('/bin/sh', ['-c', outliveScript(pid, seconds)], { detached: true, stdio: 'ignore', env: { PATH: '/bin:/usr/bin' } }).unref();
    } catch { /* nothing to start it with: SIGTERM is all it gets */ }
    return;
  }
  const timer = setTimer(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }
  }, after);
  if (timer && timer.unref) timer.unref();
}

module.exports = { WIN, MAC, dataDir, logDir, extraPath, exe, logLabel, killTree, outliveScript, KILL_AFTER };
