// Which backend the app starts (app/backend-launch.js): the downloadable app its bundled
// Python, clean of the user's PYTHON* settings; the owner's own build uv and the repo, as
// before; JARVIS_HOME always the repo. And its log, kept to its size as it runs.
// node --test tests/web/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { backendCommand, bundledEnv, BackendLog } = require('../../app/backend-launch.js');

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

// ── backend.log ──

function logFolder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-backend-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function ended(log) {
  return new Promise((resolve, reject) => { log.on('finish', resolve); log.on('error', reject); });
}

test('a running backend that prints a lot keeps backend.log near its cap, the newest lines in it', async (t) => {
  const dir = logFolder(t);
  const file = path.join(dir, 'backend.log');
  const log = new BackendLog(file, { max: 64 * 1024 });
  const out = new PassThrough();
  const err = new PassThrough();
  out.pipe(log, { end: false });
  err.pipe(log, { end: false });
  const drained = Promise.all([out, err].map((s) => new Promise((resolve) => s.on('end', resolve))));
  err.write('a warning\n');
  for (let i = 0; i < 2000; i++) out.write(`line ${i} ${'x'.repeat(200)}\n`);
  out.end();
  err.end();
  await drained; // (the backend gone: main.js ends the log once both pipes have)
  const done = ended(log);
  log.end();
  await done;
  const size = fs.statSync(file).size;
  const older = fs.readFileSync(path.join(dir, 'backend.1.log'), 'utf8');
  assert.ok(size <= 64 * 1024 + 300, `backend.log is ${size} bytes`);
  assert.ok(fs.readFileSync(file, 'utf8').trimEnd().endsWith(`line 1999 ${'x'.repeat(200)}`));
  assert.ok(older.length > 60 * 1024 && older.length <= 64 * 1024 + 300);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['backend.1.log', 'backend.log']);
  // Nothing lost, split or out of order between the two (but what's older than both).
  const lines = (older + fs.readFileSync(file, 'utf8')).trimEnd().split('\n');
  const numbers = lines.filter((l) => l.startsWith('line ')).map((l) => Number(l.split(' ')[1]));
  assert.ok(lines.every((l) => l === 'a warning' || /^line \d+ x{200}$/.test(l)));
  assert.deepEqual(numbers, numbers.map((_n, i) => numbers[0] + i));
});

test("a log too big already is put aside when it's opened, as at a start", async (t) => {
  const dir = logFolder(t);
  const file = path.join(dir, 'backend.log');
  fs.writeFileSync(file, 'x'.repeat(2000));
  const log = new BackendLog(file, { max: 1000 });
  const done = ended(log);
  log.end('--- starting\n');
  await done;
  assert.equal(fs.readFileSync(file, 'utf8'), '--- starting\n');
  assert.equal(fs.statSync(path.join(dir, 'backend.1.log')).size, 2000);
});

test('a disk that refuses the log never stops the backend: its lines are dropped, the next go in', async (t) => {
  const dir = logFolder(t);
  const file = path.join(dir, 'backend.log');
  let full = true;
  const fsys = {
    ...fs,
    write: (fd, buf, off, len, pos, cb) => {
      if (full) { setImmediate(() => cb(Object.assign(new Error('no space'), { code: 'ENOSPC' }))); return; }
      fs.write(fd, buf, off, len, pos, cb);
    },
  };
  const log = new BackendLog(file, { max: 1 << 20, fsys });
  await new Promise((resolve) => log.write('lost\n', resolve));
  full = false;
  const done = ended(log);
  log.end('kept\n');
  await done;
  assert.equal(fs.readFileSync(file, 'utf8'), 'kept\n');
});
