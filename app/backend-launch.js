// Which backend the app starts, and how (main.js startBackend).
// - The app people download carries its own (Contents/Resources/backend: Python, the jarvis
//   package and its dependencies, see scripts/release): its Python runs `jarvis serve`.
// - Otherwise, as the owner's own install always has, uv runs it from the repo: JARVIS_HOME,
//   else the folder scripts/bake-home.js recorded. JARVIS_HOME also wins over a bundled one.
'use strict';

const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');

// Paths and the PATH delimiter as the platform the backend runs on writes them (the host's own
// when it is the same one, which is always so outside the tests).
const pathsFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

// The bundled Python, relative to the app's Resources folder.
const bundledPythonRelative = (platform = process.platform) => (platform === 'win32'
  ? pathsFor(platform).join('backend', 'python', 'python.exe')
  : pathsFor(platform).join('backend', 'python', 'bin', 'python3'));
const BUNDLED_PYTHON = bundledPythonRelative();

function bundledPython(resourcesPath, exists, platform = process.platform) {
  if (!resourcesPath) return null;
  const python = pathsFor(platform).join(resourcesPath, bundledPythonRelative(platform));
  return exists(python) ? python : null;
}

// The environment for the bundled backend: the app's own, without anything that would
// point its Python elsewhere (PYTHONPATH, PYTHONHOME, any other PYTHON* setting the user's
// shell had), plus what keeps it inside its own bundle and never writing to it.
function bundledEnv(base, { resourcesPath, token, extraPath, platform = process.platform }) {
  const P = pathsFor(platform);
  const env = {};
  for (const [key, value] of Object.entries(base || {})) {
    if (!key.startsWith('PYTHON')) env[key] = value;
  }
  return Object.assign(env, {
    JARVIS_TOKEN: token,
    PYTHONUNBUFFERED: '1',
    PYTHONUTF8: '1', // text files are UTF-8 everywhere (Windows' default is the legacy code page)
    PYTHONDONTWRITEBYTECODE: '1', // nothing is ever written inside the signed app
    PYTHONNOUSERSITE: '1', // packages the user installed for their own Python stay out
    JARVIS_HELPERS_DIR: P.join(resourcesPath, 'helpers'), // the prebuilt Swift helpers
    // Laid out like the repo's app/: node_modules for the terminal and hand tracking (kept out
    // of app.asar, which Python can't read) and the companion's icon.
    JARVIS_APP_DIR: P.join(resourcesPath, 'app.asar.unpacked'),
    DISABLE_AUTOUPDATER: '1', // the bundled Claude engine never replaces itself in the app
    // Apps opened from Finder don't get the shell's PATH: git and other tools are still
    // looked for where they usually live.
    PATH: [...extraPath, base.PATH || base.Path || (platform === 'win32' ? '' : '/usr/bin:/bin')].join(P.delimiter),
  });
}

// The repo uv runs the backend from (main.js). JARVIS_HOME wins. Run from source, it is the folder this app is in
// (app/..): a jarvis-home.json left in app/ by an earlier `npm run package` names wherever the repo was then, and
// after a move that folder is gone (every start failed, exit 2). A packaged app reads the path bake-home.js
// recorded, while that folder still exists.
function repoHome({ env = process.env, packaged = false, dir, exists = fs.existsSync, read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  if (env.JARVIS_HOME) return env.JARVIS_HOME;
  const own = path.resolve(dir, '..');
  if (!packaged) return own;
  try {
    const baked = JSON.parse(read(path.join(dir, 'jarvis-home.json'))).path;
    if (typeof baked === 'string' && baked && exists(baked)) return baked;
  } catch { /* none baked, or damaged */ }
  return own;
}

// The repo path a from-repo build recorded (bake-home.js's jarvis-home.json), '' when none.
function bakedHome({ dir, read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  try {
    const baked = JSON.parse(read(path.join(dir, 'jarvis-home.json'))).path;
    return typeof baked === 'string' ? baked : '';
  } catch {
    return '';
  }
}

// Why an installed app can't start its backend, before trying: null when it can. A downloaded app without its
// own engine had its files removed ('engine'). The owner's own build (npm run install-app / install-eden-code)
// runs the backend from the repo it recorded, which is fine unless that folder moved ('moved', CH2-8: uv was
// run in the app's Resources folder instead and failed three times, with no word of why).
function missingBackend({ packaged, bundled, env = process.env, dir, exists = fs.existsSync, read } = {}) {
  if (!packaged || bundled || env.JARVIS_HOME) return null;
  const baked = bakedHome({ dir, read });
  if (!baked) return { kind: 'engine' };
  return exists(baked) ? null : { kind: 'moved', baked };
}

// {command, args, env, cwd, bundled} for spawn(). uv and home are asked only when uv runs it.
function backendCommand({ packaged, resourcesPath, env, port, token, extraPath, uv, home, dataDir, exists, platform = process.platform }) {
  const P = pathsFor(platform);
  const python = !env.JARVIS_HOME && packaged ? bundledPython(resourcesPath, exists, platform) : null;
  if (python) {
    return {
      bundled: true,
      command: python,
      args: ['-m', 'jarvis', 'serve', '--port', String(port)],
      env: bundledEnv(env, { resourcesPath, token, extraPath, platform }),
      // Its own data folder: anything written by a relative path lands there, never in the
      // app, and `python -m` finds jarvis only in the bundle.
      cwd: dataDir,
    };
  }
  return {
    bundled: false,
    command: uv(),
    args: ['run', '--directory', home(), 'jarvis', 'serve', '--port', String(port)],
    env: {
      ...env,
      JARVIS_TOKEN: token,
      PYTHONUNBUFFERED: '1',
      PYTHONUTF8: '1',
      PATH: [...extraPath, env.PATH || env.Path || (platform === 'win32' ? '' : '/usr/bin:/bin')].join(P.delimiter),
    },
    cwd: undefined,
  };
}

// How the backend stopped, for the window: a signal by name and what usually sends it. uv (and a shell) report a
// child killed by a signal as exit 128 + its number, so a SIGKILLed backend read "stopped (exit 137)" (CH2-9).
const SIGNALS = { 1: 'SIGHUP', 2: 'SIGINT', 4: 'SIGILL', 6: 'SIGABRT', 9: 'SIGKILL', 10: 'SIGBUS', 11: 'SIGSEGV', 15: 'SIGTERM' };
function exitWords(code, signal, platform = process.platform) {
  const sig = signal || (platform !== 'win32' && code > 128 && code < 160 ? SIGNALS[code - 128] : '');
  if (!sig) return `stopped (exit ${code})`;
  if (sig === 'SIGKILL') return 'was force-stopped (SIGKILL: macOS does that when memory runs short, and so does Force Quit)';
  if (sig === 'SIGTERM') return 'was asked to stop (SIGTERM)';
  if (['SIGSEGV', 'SIGBUS', 'SIGABRT', 'SIGILL'].includes(sig)) return `crashed (${sig})`;
  return `was stopped (${sig})`;
}

// The backend's last lines for the problem screen: this start's, else (killed before it said anything) the start
// before's. main.js's own "--- <time>" start markers aren't words of the backend's (CH2-9: the detail was only one),
// and nor is serve's "listening on" line: a start that went well says it, so after starts killed before they said
// anything it was the whole detail, an old port under the old name, read as the cause (CH3-4).
const MARKER = /^--- \d{4}-\d\d-\d\dT[^\n]*$/;
const LISTENING = /^(?:JARVIS|Eden) listening on http:\/\/127\.0\.0\.1:\d+\/(?: \(token kept by the app\)|\?token=\S*)?$/;
function lastWords(now, before = '') {
  const words = (text) => String(text || '').split('\n').filter((line) => line.trim() && !MARKER.test(line.trim()) && !LISTENING.test(line.trim())).join('\n');
  return words(now) || words(before);
}

// backend.log, as the backend runs: what it prints (stdout and stderr, piped in) is
// appended, and past `max` bytes the file becomes <name>.1.log (replacing the one before) and
// a new one starts, there and then. Not only at a start: closing the window keeps JARVIS
// running for weeks, and a noisy backend (a retry storm, a traceback over and over) would
// otherwise fill the disk. Writes go one at a time, so a turn of the file never splits or
// reorders them, and the backend waits (its pipes do) while the disk catches up. A write the
// disk refuses (it's full) is dropped: the backend never stops for its log.
class BackendLog extends Writable {
  constructor(file, { max, fsys = fs } = {}) {
    super({ decodeStrings: true });
    this.file = file;
    this.older = path.join(path.dirname(file), `${path.basename(file, '.log')}.1.log`);
    this.max = max;
    this.fs = fsys;
    this.fd = null;
    this.size = 0;
    let size = 0;
    try { size = this.fs.statSync(file).size; } catch { /* none yet */ }
    this.turn(size > max); // the last starts' log, too big already: put aside first
  }

  // The file opened (again), after putting it aside as <name>.1.log when asked to.
  turn(aside) {
    this.closeFile();
    if (aside) {
      try { this.fs.renameSync(this.file, this.older); } catch { /* gone meanwhile: a new one starts */ }
    }
    try {
      this.fd = this.fs.openSync(this.file, 'a', 0o644);
      this.size = this.fs.fstatSync(this.fd).size;
    } catch {
      this.closeFile(); // (no folder or no room just now: the next write tries again)
    }
  }

  closeFile() {
    if (this.fd === null) return;
    try { this.fs.closeSync(this.fd); } catch { /* closed already */ }
    this.fd = null;
  }

  _write(chunk, _encoding, done) {
    const put = (from) => {
      if (this.fd === null) this.turn(false);
      if (this.fd === null) { done(); return; } // dropped: nowhere to put it
      this.fs.write(this.fd, chunk, from, chunk.length - from, null, (err, written) => {
        if (err || !written) { this.closeFile(); done(); return; } // dropped; opened afresh next time
        this.size += written;
        if (from + written < chunk.length) { put(from + written); return; }
        if (this.size > this.max) this.turn(true);
        done();
      });
    };
    put(0);
  }

  _final(done) {
    this.closeFile();
    done();
  }

  _destroy(err, done) {
    this.closeFile();
    done(err);
  }
}

module.exports = { backendCommand, bundledEnv, bundledPython, repoHome, bakedHome, missingBackend, exitWords, lastWords, BackendLog, BUNDLED_PYTHON };
