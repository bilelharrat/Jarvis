// Which backend the app starts (app/backend-launch.js): the downloadable app its bundled
// Python, clean of the user's PYTHON* settings; the owner's own build uv and the repo, as
// before; JARVIS_HOME always the repo. node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { backendCommand, bundledEnv } = require('../../app/backend-launch.js');

const RES = '/Applications/J.A.R.V.I.S.app/Contents/Resources';
const PY = `${RES}/backend/python/bin/python3`;
const EXTRA = ['/opt/homebrew/bin', '/usr/local/bin'];

function launch({ packaged = true, env = {}, have = [PY] } = {}) {
  const asked = [];
  const how = backendCommand({
    packaged,
    resourcesPath: RES,
    env: { PATH: '/usr/bin:/bin', HOME: '/Users/someone', ...env },
    port: 51234,
    token: 'tok',
    extraPath: EXTRA,
    uv: () => { asked.push('uv'); return '/opt/homebrew/bin/uv'; },
    home: () => { asked.push('home'); return '/Users/owner/jarvis'; },
    dataDir: '/Users/someone/Library/Application Support/Jarvis',
    exists: (p) => have.includes(p),
  });
  return { how, asked };
}

test('the downloadable app runs its bundled Python, never uv or a repo', () => {
  const { how, asked } = launch();
  assert.equal(how.bundled, true);
  assert.equal(how.command, PY);
  assert.deepEqual(how.args, ['-m', 'jarvis', 'serve', '--port', '51234']);
  assert.equal(how.cwd, '/Users/someone/Library/Application Support/Jarvis');
  assert.deepEqual(asked, []); // no uv looked for, no baked repo path read
  const env = how.env;
  assert.equal(env.JARVIS_TOKEN, 'tok');
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(env.PYTHONNOUSERSITE, '1');
  assert.equal(env.PYTHONUNBUFFERED, '1');
  assert.equal(env.JARVIS_HELPERS_DIR, `${RES}/helpers`);
  assert.equal(env.JARVIS_APP_DIR, `${RES}/app.asar.unpacked`); // what Python can read of the app
  assert.equal(env.DISABLE_AUTOUPDATER, '1');
  assert.equal(env.PATH, '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
  assert.equal(env.HOME, '/Users/someone');
});

test("the user's own Python settings never reach the bundled backend", () => {
  const env = bundledEnv(
    { PYTHONPATH: '/tmp/evil', PYTHONHOME: '/tmp/other', PYTHONSTARTUP: '/tmp/x.py', PYTHONWARNINGS: 'error', LANG: 'en_US.UTF-8' },
    { resourcesPath: RES, token: 't', extraPath: [] },
  );
  for (const key of ['PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONWARNINGS']) assert.equal(key in env, false, key);
  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.equal(env.PATH, '/usr/bin:/bin');
});

test("the owner's own build (no bundled backend) runs uv from the repo, as before", () => {
  const { how, asked } = launch({ have: [] });
  assert.equal(how.bundled, false);
  assert.equal(how.command, '/opt/homebrew/bin/uv');
  assert.deepEqual(how.args, ['run', '--directory', '/Users/owner/jarvis', 'jarvis', 'serve', '--port', '51234']);
  assert.deepEqual(asked, ['uv', 'home']);
  assert.equal(how.cwd, undefined);
  assert.equal(how.env.JARVIS_TOKEN, 'tok');
  assert.equal(how.env.PYTHONUNBUFFERED, '1');
  assert.equal(how.env.PATH, '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
  assert.equal('JARVIS_HELPERS_DIR' in how.env, false);
});

test('npm start (not packaged) and JARVIS_HOME use uv even beside a bundled backend', () => {
  assert.equal(launch({ packaged: false }).how.bundled, false);
  const { how } = launch({ env: { JARVIS_HOME: '/Users/owner/jarvis' } });
  assert.equal(how.bundled, false);
  assert.equal(how.args[0], 'run');
});
