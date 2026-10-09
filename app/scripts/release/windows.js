// The Windows builds of Eden Code, J.A.R.V.I.S. and J.A.R.V.I.S. Daredevil: installer + zip, built from any OS.
//   node scripts/release/windows.js [--eden-code | --jarvis | --daredevil] [--engine-only]
// 1. The engine for Windows (dist/win/backend/python): python-build-standalone's CPython 3.12
//    for x64, the locked dependencies as Windows wheels (uv pip install --python-platform
//    x86_64-pc-windows-msvc: nothing runs on the build machine), and the jarvis package.
//    Windows on ARM runs it under Windows' own x64 emulation.
// 2. electron-builder wraps the Electron app, flavor.json baked, the engine in resources/backend.
// Unsigned unless WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD are set (a code-signing certificate).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const APP = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(APP, '..');
const OUT = path.join(APP, 'dist', 'win');
const PY_VERSION = '3.12';
const UV = process.env.UV || 'uv';
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: REPO, ...opts });

async function download(url, file) {
  const res = await fetch(url, { headers: { 'user-agent': 'eden-windows-build' } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

// The Python the engine is bundled with, when the newest release can't be asked (GitHub refuses
// the list to a machine that has asked too often without a token): the one known to have it.
const PINNED_PYTHON = { tag: '20261003', name: 'cpython-3.12.15+20261003-x86_64-pc-windows-msvc-install_only_stripped.tar.gz' };

async function pythonDist() { // the newest CPython 3.12 x64 Windows build
  const cached = path.join(OUT, '.cache');
  fs.mkdirSync(cached, { recursive: true });
  let asset = null;
  try {
    const res = await fetch('https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest', { headers: { 'user-agent': 'eden-windows-build', ...(process.env.RELEASE_LOOKUP_TOKEN ? { authorization: `Bearer ${process.env.RELEASE_LOOKUP_TOKEN}` } : {}) } });
    const rel = await res.json();
    asset = (rel.assets || []).find((a) => new RegExp(`^cpython-${PY_VERSION.replace('.', '\\.')}\\.\\d+\\+\\d+-x86_64-pc-windows-msvc-install_only_stripped\\.tar\\.gz$`).test(a.name));
    if (!asset) console.log(`the release list has no CPython ${PY_VERSION} for Windows (${res.status} ${rel.message || ''}): using ${PINNED_PYTHON.name}`);
  } catch (err) {
    console.log(`the release list couldn't be read (${err && err.message}): using ${PINNED_PYTHON.name}`);
  }
  const name = asset ? asset.name : PINNED_PYTHON.name;
  const url = asset ? asset.browser_download_url : `https://github.com/astral-sh/python-build-standalone/releases/download/${PINNED_PYTHON.tag}/${encodeURIComponent(PINNED_PYTHON.name)}`;
  const file = path.join(cached, name);
  if (!fs.existsSync(file)) { console.log(`downloading ${name}`); await download(url, file); }
  return file;
}

async function buildEngine() {
  const backend = path.join(OUT, 'backend');
  fs.rmSync(backend, { recursive: true, force: true });
  fs.mkdirSync(backend, { recursive: true });
  sh('tar', ['-xzf', await pythonDist(), '-C', backend]); // -> backend/python/{python.exe,Lib,DLLs,...}
  const py = path.join(backend, 'python');
  const site = path.join(py, 'Lib', 'site-packages');
  const req = path.join(OUT, 'requirements.txt');
  fs.writeFileSync(req, execFileSync(UV, ['export', '--no-hashes', '--no-dev', '--no-emit-project', '--quiet'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 }));
  sh(UV, ['pip', 'install', '--quiet', '--python-platform', 'x86_64-pc-windows-msvc', '--python-version', PY_VERSION,
    '--target', site, '--only-binary', ':all:', '-r', req]);
  // The jarvis package, from the files git tracks (nothing untracked ever ships).
  const tracked = execFileSync('git', ['ls-files', '-z', 'src/jarvis'], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const f of tracked) {
    if (/\.(swift|plist)$/.test(f)) continue; // Mac helpers
    const to = path.join(site, f.replace(/^src\//, ''));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(REPO, f), to);
  }
  // Never imported by the app: tests, pip, Tk, and the bytecode caches uv left.
  for (const drop of ['Lib/test', 'Lib/idlelib', 'Lib/tkinter', 'Lib/turtledemo', 'tcl', 'include']) fs.rmSync(path.join(py, drop), { recursive: true, force: true });
  for (const p of fs.readdirSync(site)) if (/^pip(-|$)/.test(p)) fs.rmSync(path.join(site, p), { recursive: true, force: true });
  // Bytecode, made here with the same Python (3.12): a start then reads it instead of compiling thousands of files from
  // source, the slowest part of a first start on a PC. "unchecked-hash": always used, whatever the files' dates become.
  // (An installed app never writes bytecode itself, as below.) A file that won't compile is just left as source.
  try {
    execFileSync(UV, ['run', '--python', PY_VERSION, '--no-project', 'python', '-m', 'compileall', '-q', '-j', '0',
      '--invalidation-mode', 'unchecked-hash', path.join(py, 'Lib')], { cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'] });
  } catch (err) {
    console.log(`bytecode: some files did not compile and stay as source (${err.status || err.message})`);
  }
  const compiled = Number(execFileSync('sh', ['-c', `find "${py}/Lib" -name '*.pyc' | wc -l`], { encoding: 'utf8' }).trim());
  console.log(`bytecode: ${compiled} files`);
  if (compiled < 1000) throw new Error('the engine was not compiled to bytecode');
  fs.writeFileSync(path.join(site, 'sitecustomize.py'), 'import sys\nsys.dont_write_bytecode = True\n');
  console.log(`engine: ${(Number(execFileSync('du', ['-sk', backend]).toString().split('\t')[0]) / 1024).toFixed(0)} MB`);
  return backend;
}

// A 7-Zip, wherever electron-builder keeps its own (or SEVEN_ZIP): it opens an installer the way a person opening it in
// an archive manager would, so a file that is not an NSIS installer at all (a build that stopped half way) is caught here.
// (It reads "BadCmd=13" for NSIS 3.12's own, working installers too: that is not a fault. What proves an installer is
// installing and opening it on Windows, which launch-check does: windows-launch-check, see README.)
function sevenZip() {
  if (process.env.SEVEN_ZIP) return process.env.SEVEN_ZIP;
  const caches = [process.env.ELECTRON_BUILDER_CACHE, path.join(os.homedir(), 'Library', 'Caches', 'electron-builder'),
    path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache'), path.join(os.homedir(), '.cache', 'electron-builder')].filter(Boolean);
  const find = (dir, depth = 0) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) if (e.isFile() && /^7z[az]?(\.exe)?$/.test(e.name)) return path.join(dir, e.name);
    if (depth < 3) {
      for (const e of entries) {
        const found = e.isDirectory() ? find(path.join(dir, e.name), depth + 1) : null;
        if (found) return found;
      }
    }
    return null;
  };
  for (const cache of caches) {
    let own = [];
    try { own = fs.readdirSync(cache).filter((n) => /^7zip/.test(n)); } catch { continue; }
    for (const n of own) {
      const found = find(path.join(cache, n));
      if (found) return found;
    }
  }
  return null;
}

function checkInstaller(file) {
  const tool = sevenZip();
  if (!tool) { console.log(`not checked (no 7-Zip found): ${path.basename(file)}`); return; }
  const listing = execFileSync(tool, ['l', '-slt', file], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const type = (listing.match(/^SubType = (.*)$/m) || [])[1] || '';
  if (!/NSIS/.test(type)) throw new Error(`${path.basename(file)} is not an NSIS installer (7-Zip reads it as "${type}"): not shipping it`);
  console.log(`installer checked: ${path.basename(file)} reads as "${type}"`);
}

// The program's own icon and name in its .exe: Explorer, the taskbar, the Start menu, Alt+Tab and Task Manager show
// them, and Narrator says the name. electron-builder would do it with rcedit, a Windows program (so Wine on a Mac);
// resedit edits the resources in JavaScript, the way @electron/packager does. Run after electron-builder's own edit of
// the .exe (the asar integrity it writes is kept: only the icon and the version strings change).
async function brandExecutable(appOutDir, { name, icon, version }) {
  const { NtExecutable, NtExecutableResource, Resource, Data } = await import('resedit');
  const exes = fs.readdirSync(appOutDir).filter((f) => f.toLowerCase().endsWith('.exe'));
  if (exes.length !== 1) throw new Error(`expected one program in ${appOutDir}, found: ${exes.join(', ')}`);
  const file = path.join(appOutDir, exes[0]);
  const exe = NtExecutable.from(fs.readFileSync(file));
  const res = NtExecutableResource.from(exe);
  const groups = Resource.IconGroupEntry.fromEntries(res.entries);
  if (groups.length !== 1) throw new Error(`${exes[0]}: ${groups.length} icon groups`);
  const ico = Data.IconFile.from(fs.readFileSync(icon));
  Resource.IconGroupEntry.replaceIconsForResource(res.entries, groups[0].id, groups[0].lang, ico.icons.map((i) => i.data));
  const [info] = Resource.VersionInfo.fromEntries(res.entries);
  const parts = String(version).split('.').map((n) => parseInt(n, 10) || 0);
  while (parts.length < 4) parts.push(0);
  info.setFileVersion(...parts);
  info.setProductVersion(...parts);
  const [lang] = info.getAllLanguagesForStringValues();
  info.setStringValues(lang, {
    ProductName: name, FileDescription: name, CompanyName: 'Eden', InternalName: name,
    OriginalFilename: exes[0], FileVersion: version, ProductVersion: version, LegalCopyright: `© ${new Date().getFullYear()} Eden`,
  });
  info.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(file, Buffer.from(exe.generate()));
  console.log(`branded ${exes[0]}: ${name} ${version}, ${ico.icons.length} icon sizes`);
}

async function main() {
  const argv = process.argv;
  const flavor = argv.includes('--eden-code') ? 'eden-code' : argv.includes('--daredevil') ? 'daredevil' : argv.includes('--jarvis') ? 'jarvis' : 'eden-code';
  const edenCode = flavor === 'eden-code';
  const engine = await buildEngine();
  if (argv.includes('--engine-only')) return;
  const builder = require('electron-builder');
  // (J.A.R.V.I.S. Daredevil is J.A.R.V.I.S.'s own program under its own name: the same appId, so one replaces the other.)
  const name = { 'eden-code': 'Eden Code', jarvis: 'J.A.R.V.I.S.', daredevil: 'J.A.R.V.I.S. Daredevil' }[flavor];
  const icons = { 'eden-code': 'build/eden-code', jarvis: 'build', daredevil: 'build/daredevil' }[flavor];
  const flavorFile = path.join(APP, 'flavor.json');
  fs.writeFileSync(flavorFile, JSON.stringify({ flavor }));
  const signed = !!process.env.WIN_CSC_LINK;
  try {
    const made = await builder.build({
      projectDir: APP,
      targets: builder.Platform.WINDOWS.createTarget(['nsis', 'zip'], builder.Arch.x64),
      publish: 'never',
      config: {
        appId: require('../../flavor').FLAVORS[flavor].appUserModelId,
        // WIN_BUILD_VERSION=0.1.9 names a build apart from an earlier one of the same app (the Windows installers count on their own).
        ...(process.env.WIN_BUILD_VERSION ? { extraMetadata: { version: process.env.WIN_BUILD_VERSION } } : {}),
        productName: name,
        executableName: name,
        afterSign: (context) => brandExecutable(context.appOutDir, {
          name, icon: path.join(APP, icons, 'icon.ico'), version: context.packager.appInfo.version,
        }),
        directories: { output: path.join('dist', 'win', flavor) },
        files: ['*.js', '*.html', '*.css', 'features/**', 'flavor.json', `${icons}/*.png`, 'package.json',
          '!jarvis-home.json', '!dist/**', '!scripts/**', '!eden/**'],
        asarUnpack: ['node_modules/@xterm/**', 'node_modules/@mediapipe/**'],
        extraResources: [{ from: engine, to: 'backend' }],
        protocols: [{ name, schemes: [edenCode ? 'edencode' : 'jarvis'] }],
        win: {
          icon: `${icons}/icon-1024.png`,
          signAndEditExecutable: signed,
          ...(signed ? { certificateFile: process.env.WIN_CSC_LINK, certificatePassword: process.env.WIN_CSC_KEY_PASSWORD } : {}),
        },
        // electron-builder's own NSIS 3.12: the compiler, its stubs and its plugins come from one bundle (a native makensis for
        // Apple silicon too). A compiler of one NSIS release over the stubs of another makes an installer that crashes as it
        // starts: 0.1.9 to 0.1.12 were built that way, with Homebrew's makensis, and nobody could install them.
        toolsets: { nsis: '1.2.1' },
        // (No shortcut key on the installed shortcuts: Windows would hold Ctrl+Alt+J itself, and the running app, which
        // starts with Windows and waits in the tray, could not have it. app/features/shell.js takes the key.)
        nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true },
        artifactName: `${name.replace(/[^A-Za-z]+/g, '-')}-Setup-\${version}-\${arch}.\${ext}`,
      },
    });
    for (const file of made.filter((f) => /Setup.*\.exe$/.test(f))) checkInstaller(file);
  } finally {
    fs.rmSync(flavorFile, { force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
