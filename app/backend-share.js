// One backend for every Eden app (Eden Secretary, Eden Daredevil, Eden Code, Ask Eden). The
// backend holds the data folder's lock (server.serve), so two can't run on one Mac, and Eden
// Code's sessions are Eden Secretary's. Whichever app starts first starts it, and the backend
// itself, once it holds the lock, says where it is in backend.json in the data folder
// (share_record.py): its port, its token, its pid, its PROTOCOL and version, its profile and
// which app started it, readable by this user only. Another app finds it there, checks it's
// alive and answering, and opens its window on it (backend-handover.js decides what to do
// when the versions differ). Apps used to write backend.json themselves, as they spawned the
// backend, and two opening at once wrote over each other's: the one whose backend lost the
// lock then had nothing to find ("Another Eden backend is still using your data").
//
// The app that started the backend owns it: the backend goes when that app quits
// (launcher_watch.py), unless another app still has a window on it: then the quitting app
// lets go of it (release) and it stays until the last window has gone. An app sharing it
// watches it (watch), and when it stops answering, starts one of its own and reloads its
// window on that.
//
// A restart on purpose (follow-repo.js's onto new code) leaves backend.json in place, marked
// "restarting" (markRestarting): the backend is gone for a few seconds and comes back on the
// same port. An app watching it waits up to RESTART_GRACE when it sees the mark, instead of
// starting a competing backend (which lost the data folder's lock race, reloaded its windows
// and said the other app had quit).
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const FILE = 'backend.json';
const RESTART_GRACE = 30_000;
// What a window and the backend expect of each other (share_record.PROTOCOL, which it must
// equal: tests/web/backend-handover.test.mjs). A record without one is from a backend from
// before this file was the backend's own: protocol 0.
const PROTOCOL = 1;
// A backend that holds the lock but doesn't answer /health yet is starting (its record is
// written before the server listens): it's waited for, this long after it started at most.
const STARTING_GRACE = 120_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/; // the app's hex, or a terminal's token_urlsafe

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// Whether an Eden backend answers there: a 200 with {"ok": true} (server.health). A bare 200 is
// not enough: a record outliving a crashed backend (its pid reused) names a port another local
// server may hold now, and any dev server answers 200 to /health; the app would then open its
// window, with its bridge, on that server's page.
function healthy(port, timeoutMs = 1500, get = http.get) {
  return new Promise((resolve) => {
    const req = get({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(false); return; }
      let text = '';
      if (res.setEncoding) res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; if (text.length > 4096) { resolve(false); req.destroy(); } });
      res.on('end', () => {
        try { resolve(JSON.parse(text).ok === true); } catch { resolve(false); }
      });
      res.on('error', () => resolve(false));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** Whether the file is this user's alone: it holds the token, so one anyone else could read
 * (or another user wrote) is not trusted. (Windows keeps it in the user's own profile.) */
function private_(stat, { platform = process.platform, uid = process.getuid ? process.getuid() : -1 } = {}) {
  if (platform === 'win32') return true;
  return (stat.mode & 0o077) === 0 && (uid < 0 || stat.uid === uid);
}

/** What's in backend.json when it names a usable backend, else null (checks nothing live). */
function read(dataDir, { statOk = private_ } = {}) {
  let info;
  const file = path.join(dataDir, FILE);
  try {
    if (!statOk(fs.statSync(file))) return null;
    info = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
  if (!info || typeof info !== 'object') return null;
  const port = Number(info.port);
  const pid = Number(info.pid);
  const token = typeof info.token === 'string' ? info.token : '';
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !TOKEN_RE.test(token)) return null;
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  const out = { port, pid, token, app: String(info.app || ''), launcher: n(info.launcher) };
  // What the backend says of itself (share_record.py); none of it from an app-written record.
  if (info.protocol !== undefined) out.protocol = n(info.protocol);
  if (info.version !== undefined) out.version = String(info.version);
  if (info.profile !== undefined) out.profile = info.profile === 'code' ? 'code' : 'full';
  for (const key of ['started', 'released', 'handover', 'restarting']) if (n(info[key])) out[key] = n(info[key]);
  return out;
}

/** Writes a record as an app-written one looked (tests, and nothing else now: the backend
 * writes its own, share_record.py). Written through a temporary file, user-only. */
function advertise(dataDir, { port, token, pid, app, launcher, ...more }) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ port, token, pid, app, launcher, ...more, at: new Date().toISOString() }), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** Marks this app's backend as restarting on purpose (only when backend.json is still its own). */
function markRestarting(dataDir, launcher, now = Date.now()) {
  const info = read(dataDir);
  if (!info || info.launcher !== launcher) return false;
  try {
    const file = path.join(dataDir, FILE);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...raw, restarting: now }), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** Whether backend.json says a restart on purpose began less than RESTART_GRACE ago. */
function restartingNow(dataDir, now = Date.now(), grace = RESTART_GRACE) {
  const info = dataDir ? read(dataDir) : null;
  return Boolean(info && info.restarting && now - info.restarting >= 0 && now - info.restarting < grace);
}

/** Takes backend.json away, only when it still names this app's backend. */
function withdraw(dataDir, launcher) {
  const info = read(dataDir);
  if (!info || info.launcher !== launcher) return;
  try { fs.rmSync(path.join(dataDir, FILE), { force: true }); } catch { /* the next start writes over it */ }
}

/** The running backend backend.json names, when it's alive and answering: its record. One
 * still starting (alive, no answer yet, started less than STARTING_GRACE ago) is waited for,
 * up to waitMs. An app's backend whose app has gone is going too (launcher_watch.py) and
 * isn't one, unless that app let go of it for another app's windows (released). */
async function discover(dataDir, { isAlive = alive, isHealthy = healthy, waitMs = 60_000, every = 500, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const until = now() + waitMs;
  for (;;) {
    const info = read(dataDir);
    if (!info || !isAlive(info.pid)) return null;
    if (info.launcher && !info.released && !isAlive(info.launcher)) return null;
    if (info.handover) return null; // stopping, to hand the data over
    if (await isHealthy(info.port)) return info;
    const starting = info.started && now() - info.started < STARTING_GRACE;
    if (!starting || now() >= until) return null;
    await sleep(every);
  }
}

// Asks the backend something only the app holding its token may (server's app_asks): a POST
// with the token as a bearer and no Origin. Resolves to its JSON, or null.
function ask(port, token, route, body = {}, { timeoutMs = 1500, request = http.request } = {}) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    let req;
    try {
      req = request({
        host: '127.0.0.1', port, path: route, method: 'POST', timeout: timeoutMs,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try { resolve(JSON.parse(text)); } catch { resolve(null); }
        });
      });
    } catch { resolve(null); return; }
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(data);
  });
}

/** This app is quitting: whether its backend stays up for another app's windows (it then
 * outlives this app, and this app must leave it running). False when unsure. */
async function release(port, token, app, opts) {
  const answer = await ask(port, token, '/share/release', { app }, opts);
  return Boolean(answer && answer.staying === true);
}

/** Asks a backend to stop gently and hand the data over (server's /share/shutdown). */
async function shutdown(port, token, opts) {
  const answer = await ask(port, token, '/share/shutdown', {}, opts);
  return Boolean(answer && answer.ok);
}

// What each app is called, for what a window says about another app.
const APP_NAMES = { jarvis: 'Eden Secretary', daredevil: 'Eden Daredevil', 'eden-code': 'Eden Code', 'ask-eden': 'Ask Eden', terminal: 'a `jarvis serve` in a terminal' };
function appName(id) {
  return APP_NAMES[id] || 'another Eden app';
}

/** Calls onGone once, after the shared backend stops answering twice in a row (and, with
 * dataDir, isn't marked as restarting on purpose: then it waits for it). Returns stop(). */
function watch(port, onGone, { every = 2000, isHealthy = healthy, dataDir = '', now = Date.now } = {}) {
  let misses = 0;
  let stopped = false;
  let timer = null;
  const tick = async () => {
    if (stopped) return;
    misses = (await isHealthy(port)) ? 0 : misses + 1;
    if (stopped) return;
    if (misses >= 2 && !restartingNow(dataDir, now())) { stopped = true; onGone(); return; }
    timer = setTimeout(tick, every);
  };
  timer = setTimeout(tick, every);
  return () => { stopped = true; clearTimeout(timer); };
}

module.exports = { FILE, PROTOCOL, RESTART_GRACE, STARTING_GRACE, advertise, alive, appName, ask, discover, healthy, markRestarting, private_, read, release, restartingNow, shutdown, watch, withdraw };
