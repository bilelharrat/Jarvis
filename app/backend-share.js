// One backend for J.A.R.V.I.S. and Eden Code. The backend holds the data folder's lock
// (server.serve), so two can't run on one Mac, and Eden Code's sessions are J.A.R.V.I.S.'s.
// Whichever app starts first starts it and says where it is in backend.json, in the data
// folder: its port, its token and its pid, readable by this user only. The other app finds it
// there, checks it's alive and answering, and opens its window on it.
//
// The app that started the backend owns it: the backend goes when that app quits
// (launcher_watch.py). An app sharing it watches it (watch), and when it stops answering,
// starts one of its own and reloads its window on that.
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const FILE = 'backend.json';

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function healthy(port, timeoutMs = 1500, get = http.get) {
  return new Promise((resolve) => {
    const req = get({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** What's in backend.json when it names a usable backend, else null (checks nothing live). */
function read(dataDir) {
  let info;
  try { info = JSON.parse(fs.readFileSync(path.join(dataDir, FILE), 'utf8')); } catch { return null; }
  if (!info || typeof info !== 'object') return null;
  const port = Number(info.port);
  const pid = Number(info.pid);
  const token = typeof info.token === 'string' ? info.token : '';
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !/^[0-9a-f]{16,128}$/.test(token)) return null;
  return { port, pid, token, app: String(info.app || ''), launcher: Number(info.launcher) || 0 };
}

/** Says where this app's backend is. Written through a temporary file, user-only. */
function advertise(dataDir, { port, token, pid, app, launcher }) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ port, token, pid, app, launcher, at: new Date().toISOString() }), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** Takes backend.json away, only when it still names this app's backend. */
function withdraw(dataDir, launcher) {
  const info = read(dataDir);
  if (!info || info.launcher !== launcher) return;
  try { fs.rmSync(path.join(dataDir, FILE), { force: true }); } catch { /* the next start writes over it */ }
}

/** The running backend another app started, when it's alive and answering: { port, token, app }. */
async function discover(dataDir, { isAlive = alive, isHealthy = healthy } = {}) {
  const info = read(dataDir);
  if (!info) return null;
  if (!isAlive(info.pid) || !isAlive(info.launcher)) return null;
  if (!(await isHealthy(info.port))) return null;
  return info;
}

/** Calls onGone once, after the shared backend stops answering twice in a row. Returns stop(). */
function watch(port, onGone, { every = 2000, isHealthy = healthy } = {}) {
  let misses = 0;
  let stopped = false;
  let timer = null;
  const tick = async () => {
    if (stopped) return;
    misses = (await isHealthy(port)) ? 0 : misses + 1;
    if (stopped) return;
    if (misses >= 2) { stopped = true; onGone(); return; }
    timer = setTimeout(tick, every);
  };
  timer = setTimeout(tick, every);
  return () => { stopped = true; clearTimeout(timer); };
}

module.exports = { FILE, advertise, alive, discover, healthy, read, watch, withdraw };
