// The backend inside the app people download (Contents/Resources/backend/python):
// - uv's own CPython 3.12 (python-build-standalone) from uv's local store;
// - the runtime dependencies uv.lock pins (no dev group), installed from uv's cache;
// - the jarvis package itself, non-editable, built from the files git tracks (so nothing
//   untracked, a stray .env or a cache, ever ships), with all its data files.
// Nothing is downloaded: uv runs offline and only installs wheels; anything that isn't
// cached stops the build and says so.
//
// Nothing may ever write inside the signed app (a written file breaks its seal and macOS
// then calls it damaged), so every .py is precompiled here as unchecked-hash .pyc, the
// launcher sets PYTHONDONTWRITEBYTECODE, and sitecustomize turns bytecode writing off even
// for runs that ignore the environment (-I, the Keychain helper Claude Code calls).
// What never runs is left out: tests, pip, Tk and IDLE, headers, and the scripts uv writes
// with this Mac's paths in them.
//
//   node scripts/release/backend.js <out folder>
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { BuildError, run, say, sha256Text, sizeOf, megabytes } = require('./util');
const macho = require('./macho');

const REPO = path.resolve(__dirname, '..', '..', '..');
const PY = 'python3.12';

// What in the Python install never runs in the app (paths under its root).
const DROP_ROOT = [
  'include', 'share', 'lib/pkgconfig', 'lib/libpython3.12.dylib',
  `lib/${PY}/idlelib`, `lib/${PY}/tkinter`, `lib/${PY}/turtledemo`, `lib/${PY}/turtle.py`,
  `lib/${PY}/ensurepip`, `lib/${PY}/test`, `lib/${PY}/EXTERNALLY-MANAGED`,
];
const DROP_ROOT_PATTERNS = [/^lib\/(itcl|tcl|tk|thread)[\d.]*$/, /^lib\/lib(tcl|tk)[\w.]*\.dylib$/, new RegExp(`^lib/${PY}/lib-dynload/_tkinter\\.`)];
const KEEP_BIN = new Set(['python', 'python3', PY]);
// Packages in site-packages that are for installing or testing, never imported by Jarvis.
const DROP_PACKAGES = [/^pip$/, /^pip-[\d.]+\.dist-info$/, /^PyObjCTest$/];
const TEST_DIRS = new Set(['tests']);
const SITECUSTOMIZE = `# The app's own Python never writes inside the signed app (a written file breaks its seal):
# no bytecode, however it's started. Everything it runs was compiled when the app was built.
import sys

sys.dont_write_bytecode = True
`;

function uv(args, opts = {}) {
  const env = { ...process.env, UV_OFFLINE: '1', UV_NO_PROGRESS: '1', UV_PYTHON_DOWNLOADS: 'never' };
  delete env.VIRTUAL_ENV; // the build's own venv must not become the target
  return run(process.env.UV || 'uv', args, { ...opts, env });
}

// The uv-managed CPython 3.12 install: its root folder (and the path uv found it by, a
// symlink per minor version) and version.
function managedPython() {
  const found = uv(['python', 'find', '--managed-python', '--no-project', '--offline', '3.12'], { cwd: os.tmpdir() }).stdout.trim();
  if (!found) throw new BuildError('uv has no managed CPython 3.12 (uv python find --managed-python 3.12)');
  const exe = fs.realpathSync(found);
  const root = path.dirname(path.dirname(exe));
  if (!fs.existsSync(path.join(root, 'lib', PY))) throw new BuildError(`${root} isn't a CPython 3.12 install`);
  const version = run(exe, ['-c', 'import sys; print(sys.version.split()[0])']).stdout.trim();
  return { root, aliases: [root, path.dirname(path.dirname(found))], version };
}

// uv writes its install folder (in this Mac's home) into the build settings Python keeps
// for compiling extensions; the app gets python-build-standalone's own neutral /install
// back. Nothing at run time reads them: sys.prefix comes from where python3 is.
function neutralizePaths(target, aliases) {
  const lib = path.join(target, 'lib', PY);
  for (const name of fs.readdirSync(lib).filter((n) => /^_sysconfigdata_.*\.py$/.test(n))) {
    const file = path.join(lib, name);
    let text = fs.readFileSync(file, 'utf8');
    for (const alias of [...new Set(aliases)].sort((a, b) => b.length - a.length)) text = text.split(alias).join('/install');
    fs.writeFileSync(file, text);
  }
}

// The files git tracks for the package, copied as they are now in the working tree.
function trackedPackageFiles() {
  const listed = run('git', ['-C', REPO, 'ls-files', '-z', '--', 'src/jarvis', 'pyproject.toml'], { quiet: true }).stdout;
  return listed.split('\0').filter(Boolean);
}

function stagePackage(stage) {
  fs.rmSync(stage, { recursive: true, force: true });
  const files = trackedPackageFiles();
  for (const rel of files) {
    const from = path.join(REPO, rel);
    if (!fs.existsSync(from)) continue; // deleted in the working tree, not yet committed
    const to = path.join(stage, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  return files.filter((rel) => rel.startsWith('src/jarvis/') && fs.existsSync(path.join(REPO, rel)));
}

function drop(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function prunePython(root) {
  const dropped = [];
  for (const rel of DROP_ROOT) {
    if (fs.existsSync(path.join(root, rel))) { drop(path.join(root, rel)); dropped.push(rel); }
  }
  for (const dir of ['lib', `lib/${PY}/lib-dynload`]) {
    for (const name of fs.readdirSync(path.join(root, dir))) {
      const rel = `${dir}/${name}`;
      if (DROP_ROOT_PATTERNS.some((re) => re.test(rel))) { drop(path.join(root, rel)); dropped.push(rel); }
    }
  }
  return dropped;
}

// Entry-point scripts (uv writes this Mac's path into their #! line), pip, test folders.
function pruneInstalled(root) {
  const dropped = [];
  for (const name of fs.readdirSync(path.join(root, 'bin'))) {
    if (!KEEP_BIN.has(name)) { drop(path.join(root, 'bin', name)); dropped.push(`bin/${name}`); }
  }
  const site = path.join(root, 'lib', PY, 'site-packages');
  for (const name of fs.readdirSync(site)) {
    if (DROP_PACKAGES.some((re) => re.test(name))) { drop(path.join(site, name)); dropped.push(`site-packages/${name}`); }
  }
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (TEST_DIRS.has(entry.name) && fs.existsSync(path.join(dir, '__init__.py'))) {
        drop(full);
        dropped.push(path.relative(site, full));
      } else walk(full);
    }
  };
  walk(site);
  // Where a local wheel came from: a path on the build Mac.
  for (const name of fs.readdirSync(site).filter((n) => n.endsWith('.dist-info'))) {
    const direct = path.join(site, name, 'direct_url.json');
    if (fs.existsSync(direct)) { fs.rmSync(direct); dropped.push(`site-packages/${name}/direct_url.json`); }
  }
  return dropped;
}

// .pyc for every .py, checked against nothing at run time (unchecked-hash): Python never
// needs to write a fresher one. Their embedded paths are relative (no build Mac paths).
function compileAll(root) {
  const lib = path.join(root, 'lib', PY);
  const python = path.join(root, 'bin', PY);
  const done = run(python, ['-I', '-m', 'compileall', '-q', '-f', '-j', '0', '--invalidation-mode', 'unchecked-hash', '-s', root, lib], { allowFail: true });
  // Leftovers: bytecode for other optimization levels or versions, or whose source is gone.
  let removed = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name === '__pycache__') {
        for (const pyc of fs.readdirSync(full)) {
          const m = /^(.+)\.cpython-312\.pyc$/.exec(pyc);
          if (!m || !fs.existsSync(path.join(dir, `${m[1]}.py`))) { fs.rmSync(path.join(full, pyc)); removed += 1; }
        }
      } else if (entry.isDirectory()) walk(full);
    }
  };
  walk(lib);
  return { status: done.status, output: `${done.stdout}${done.stderr}`, removed };
}

// Every .py without its unchecked-hash .pyc (a file that doesn't compile can't be imported
// either, so it's reported, not fatal, unless it's Jarvis's own).
function uncompiled(root) {
  const lib = path.join(root, 'lib', PY);
  const missing = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== '__pycache__') walk(full); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.py')) continue;
      const pyc = path.join(dir, '__pycache__', `${entry.name.slice(0, -3)}.cpython-312.pyc`);
      let ok = false;
      try {
        const head = Buffer.alloc(8);
        const fd = fs.openSync(pyc, 'r');
        fs.readSync(fd, head, 0, 8, 0);
        fs.closeSync(fd);
        ok = head.readUInt32LE(4) === 1; // flags: hash-based, source never checked
      } catch { ok = false; }
      if (!ok) missing.push(path.relative(lib, full));
    }
  };
  walk(lib);
  return missing;
}

// Imports every top-level module of every installed distribution and every module of the
// jarvis package, and loads the `jarvis` console entry point, with the bundled Python in
// isolated mode. Returns what failed.
const IMPORT_CHECK = String.raw`
import importlib, importlib.metadata as md, json, pkgutil, sys
skip = set(sys.argv[1].split(",")) if len(sys.argv) > 1 and sys.argv[1] else set()
tops = set()
for dist in md.distributions():
    names = (dist.read_text("top_level.txt") or "").split()
    if not names:
        for f in dist.files or []:
            part = f.parts[0]
            if part.endswith((".dist-info", ".data")) or part in ("..", "__pycache__"):
                continue
            if part.endswith(".py"):
                names.append(part[:-3])
            elif part.endswith(".so"):
                names.append(part.split(".")[0])
            elif "." not in part:
                names.append(part)
    tops.update(n.replace("/", ".") for n in names if n and not n.startswith("_distutils"))
failures = []
for name in sorted(tops - skip):
    try:
        importlib.import_module(name)
    except Exception as exc:
        failures.append(f"{name}: {type(exc).__name__}: {exc}"[:300])
import jarvis
modules = 0
for info in pkgutil.walk_packages(jarvis.__path__, "jarvis."):
    if info.name.rsplit(".", 1)[-1] == "__main__":
        continue
    modules += 1
    try:
        importlib.import_module(info.name)
    except Exception as exc:
        failures.append(f"{info.name}: {type(exc).__name__}: {exc}"[:300])
entry = [e for e in md.entry_points(group="console_scripts") if e.name == "jarvis"]
if not entry or not callable(entry[0].load()):
    failures.append("the jarvis console entry point doesn't load")
from claude_agent_sdk._internal.transport.subprocess_cli import SubprocessCLITransport
cli = SubprocessCLITransport._find_bundled_cli(object.__new__(SubprocessCLITransport))
print(json.dumps({"tops": len(tops - skip), "jarvis_modules": modules, "failures": failures, "cli": cli}))
`;

function importCheck(root, skip) {
  const python = path.join(root, 'bin', 'python3');
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', JARVIS_HELPERS_DIR: '' };
  for (const k of Object.keys(env)) if (k.startsWith('PYTHON') && !['PYTHONDONTWRITEBYTECODE', 'PYTHONNOUSERSITE'].includes(k)) delete env[k];
  const done = run(python, ['-P', '-c', IMPORT_CHECK, [...skip].join(',')], { env, cwd: os.tmpdir(), allowFail: true });
  const line = done.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  if (!line) throw new BuildError(`the bundled Python couldn't check its imports:\n${done.stderr.slice(-1500)}`);
  return JSON.parse(line);
}

// Every tracked file of the package is in the installed copy (uv_build puts everything under
// src/jarvis in the wheel; this proves it).
function packageGaps(root, tracked) {
  const site = path.join(root, 'lib', PY, 'site-packages');
  return tracked.filter((rel) => !fs.existsSync(path.join(site, rel.replace(/^src\//, ''))));
}

function buildBackend({ out }) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const target = path.join(out, 'python');
  const { root, aliases, version } = managedPython();
  say(`  CPython ${version} from ${root}`);
  run('/usr/bin/ditto', [root, target]);
  neutralizePaths(target, aliases);
  const dropped = prunePython(target);
  fs.writeFileSync(path.join(target, 'lib', PY, 'site-packages', 'sitecustomize.py'), SITECUSTOMIZE);

  // The locked runtime dependencies, from uv's cache only.
  const requirements = path.join(out, 'requirements.txt');
  uv(['export', '--frozen', '--no-dev', '--no-emit-project', '--no-header', '--format', 'requirements-txt', '--output-file', requirements], { cwd: REPO });
  const python = path.join(target, 'bin', 'python3');
  uv(['pip', 'install', '--python', python, '--offline', '--no-build', '--no-deps', '--require-hashes', '--link-mode', 'copy', '--break-system-packages', '--no-config', '-r', requirements], { cwd: out });

  // The jarvis package: a wheel of the tracked files, installed like any other.
  const stage = path.join(out, 'stage');
  const tracked = stagePackage(stage);
  const wheels = path.join(out, 'wheel');
  uv(['build', '--wheel', '--offline', '--no-config', '--out-dir', wheels, stage], { cwd: stage });
  const wheel = fs.readdirSync(wheels).find((n) => n.endsWith('.whl'));
  if (!wheel) throw new BuildError('uv build made no wheel');
  uv(['pip', 'install', '--python', python, '--offline', '--no-deps', '--link-mode', 'copy', '--break-system-packages', '--no-config', path.join(wheels, wheel)], { cwd: out });
  const gaps = packageGaps(target, tracked);
  if (gaps.length) throw new BuildError(`the jarvis package is missing tracked files: ${gaps.slice(0, 10).join(', ')}`);
  drop(stage);

  dropped.push(...pruneInstalled(target));
  const compiled = compileAll(target);
  const missing = uncompiled(target);
  const ownMissing = missing.filter((rel) => rel.startsWith('site-packages/jarvis/'));
  if (ownMissing.length) throw new BuildError(`jarvis files that don't compile: ${ownMissing.join(', ')}`);

  const checked = importCheck(target, new Set(['PyObjCTest', 'pip']));
  if (checked.failures.length) {
    const untracked = run('git', ['-C', REPO, 'ls-files', '--others', '--exclude-standard', '--', 'src/jarvis'], { quiet: true }).stdout.trim();
    const hint = untracked ? `\n(only files git tracks are built in; not yet added: ${untracked.split('\n').join(', ')})` : '';
    throw new BuildError(`the bundled backend can't import:\n  ${checked.failures.join('\n  ')}${hint}`);
  }
  const expectedCli = path.join(target, 'lib', PY, 'site-packages', 'claude_agent_sdk', '_bundled', 'claude');
  if (!checked.cli || fs.realpathSync(checked.cli) !== fs.realpathSync(expectedCli)) {
    throw new BuildError(`the Agent SDK didn't find its bundled Claude engine (found ${checked.cli})`);
  }
  const help = run(python, ['-P', '-m', 'jarvis', '--help'], { cwd: os.tmpdir(), env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  if (!/serve/.test(help.stdout)) throw new BuildError('`python -m jarvis --help` doesn\'t offer serve');

  const machos = macho.scan(target);
  const minos = macho.maxVersion(machos.map((m) => m.minos));
  const report = {
    python: version,
    lock: sha256Text(fs.readFileSync(path.join(REPO, 'uv.lock'))),
    commit: run('git', ['-C', REPO, 'rev-parse', 'HEAD'], { quiet: true }).stdout.trim(),
    dirty: run('git', ['-C', REPO, 'status', '--porcelain', '--', 'src', 'pyproject.toml', 'uv.lock'], { quiet: true }).stdout.trim() !== '',
    wheel,
    size: sizeOf(target),
    dropped,
    uncompiled: missing,
    compile_status: compiled.status,
    imports: { top_level: checked.tops, jarvis_modules: checked.jarvis_modules },
    macho: machos.length,
    minos,
    // What sets that minimum (a few of the files that need it).
    needs: machos.filter((m) => m.minos === minos).slice(0, 8).map((m) => path.relative(target, m.file)),
  };
  fs.writeFileSync(path.join(out, 'build.json'), `${JSON.stringify(report, null, 2)}\n`);
  say(`  backend: ${megabytes(report.size)}, ${report.macho} Mach-O files, needs macOS ${report.minos}; imports ${checked.tops} packages and ${checked.jarvis_modules} jarvis modules`);
  if (report.dirty) say('  note: src/, pyproject.toml or uv.lock have uncommitted changes; they are in this build');
  return report;
}

module.exports = { buildBackend, managedPython, neutralizePaths, prunePython, pruneInstalled, uncompiled, packageGaps, trackedPackageFiles, SITECUSTOMIZE, PY };

if (require.main === module) {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: node scripts/release/backend.js <out folder>');
    process.exit(2);
  }
  try {
    buildBackend({ out: path.resolve(out) });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
