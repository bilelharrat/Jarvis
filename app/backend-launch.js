// Which backend the app starts, and how (main.js startBackend).
// - The app people download carries its own (Contents/Resources/backend: Python, the jarvis
//   package and its dependencies, see scripts/release): its Python runs `jarvis serve`.
// - Otherwise, as the owner's own install always has, uv runs it from the repo: JARVIS_HOME,
//   else the folder scripts/bake-home.js recorded. JARVIS_HOME also wins over a bundled one.
'use strict';

const path = require('path');

// The bundled Python, relative to the app's Resources folder.
const BUNDLED_PYTHON = path.join('backend', 'python', 'bin', 'python3');

function bundledPython(resourcesPath, exists) {
  if (!resourcesPath) return null;
  const python = path.join(resourcesPath, BUNDLED_PYTHON);
  return exists(python) ? python : null;
}

// The environment for the bundled backend: the app's own, without anything that would
// point its Python elsewhere (PYTHONPATH, PYTHONHOME, any other PYTHON* setting the user's
// shell had), plus what keeps it inside its own bundle and never writing to it.
function bundledEnv(base, { resourcesPath, token, extraPath }) {
  const env = {};
  for (const [key, value] of Object.entries(base || {})) {
    if (!key.startsWith('PYTHON')) env[key] = value;
  }
  return Object.assign(env, {
    JARVIS_TOKEN: token,
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1', // nothing is ever written inside the signed app
    PYTHONNOUSERSITE: '1', // packages the user installed for their own Python stay out
    JARVIS_HELPERS_DIR: path.join(resourcesPath, 'helpers'), // the prebuilt Swift helpers
    // Laid out like the repo's app/: node_modules for the terminal and hand tracking (kept out
    // of app.asar, which Python can't read) and the companion's icon.
    JARVIS_APP_DIR: path.join(resourcesPath, 'app.asar.unpacked'),
    DISABLE_AUTOUPDATER: '1', // the bundled Claude engine never replaces itself in the app
    // Apps opened from Finder don't get the shell's PATH: git and other tools are still
    // looked for where they usually live.
    PATH: [...extraPath, base.PATH || '/usr/bin:/bin'].join(':'),
  });
}

// {command, args, env, cwd, bundled} for spawn(). uv and home are asked only when uv runs it.
function backendCommand({ packaged, resourcesPath, env, port, token, extraPath, uv, home, dataDir, exists }) {
  const python = !env.JARVIS_HOME && packaged ? bundledPython(resourcesPath, exists) : null;
  if (python) {
    return {
      bundled: true,
      command: python,
      args: ['-m', 'jarvis', 'serve', '--port', String(port)],
      env: bundledEnv(env, { resourcesPath, token, extraPath }),
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
      PATH: [...extraPath, env.PATH || '/usr/bin:/bin'].join(':'),
    },
    cwd: undefined,
  };
}

module.exports = { backendCommand, bundledEnv, bundledPython, BUNDLED_PYTHON };
