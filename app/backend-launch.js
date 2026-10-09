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

module.exports = { backendCommand, bundledEnv, bundledPython, BackendLog, BUNDLED_PYTHON };
