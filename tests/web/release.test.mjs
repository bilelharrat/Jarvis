// The dist build's own logic (app/scripts/release): reading Mach-O headers, prebuilding the
// Swift helpers with the right target, and trimming the bundled Python. The real build runs
// with `npm run dist -- --adhoc`; these run on made-up files. node --test tests/web/
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const macho = require('../../app/scripts/release/macho.js');
const helpers = require('../../app/scripts/release/helpers.js');
const backend = require('../../app/scripts/release/backend.js');

const temp = () => mkdtempSync(path.join(tmpdir(), 'jarvis-release-'));
const touch = (file, text = '') => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };

// ── Mach-O headers ──

// A thin 64-bit Mach-O: header, then the given load commands.
function thin({ cpu = 0x0100000c, filetype = 2, cmds = [] } = {}) {
  const body = Buffer.concat(cmds);
  const head = Buffer.alloc(32);
  head.writeUInt32LE(0xfeedfacf, 0);
  head.writeUInt32LE(cpu, 4);
  head.writeUInt32LE(filetype, 12);
  head.writeUInt32LE(cmds.length, 16);
  head.writeUInt32LE(body.length, 20);
  return Buffer.concat([head, body]);
}
const packed = (v) => { const [a, b = 0, c = 0] = v.split('.').map(Number); return (a << 16) | (b << 8) | c; };
function buildVersion(minos, platform = 1) {
  const cmd = Buffer.alloc(24);
  cmd.writeUInt32LE(0x32, 0);
  cmd.writeUInt32LE(24, 4);
  cmd.writeUInt32LE(platform, 8);
  cmd.writeUInt32LE(packed(minos), 12);
  cmd.writeUInt32LE(packed('26.0'), 16);
  return cmd;
}
function versionMin(version) {
  const cmd = Buffer.alloc(16);
  cmd.writeUInt32LE(0x24, 0);
  cmd.writeUInt32LE(16, 4);
  cmd.writeUInt32LE(packed(version), 8);
  return cmd;
}
function fat(slices) {
  const header = Buffer.alloc(8 + slices.length * 20);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(slices.length, 4);
  let offset = 4096;
  const parts = [];
  slices.forEach((s, i) => {
    header.writeUInt32BE(s.readUInt32LE(4), 8 + i * 20);
    header.writeUInt32BE(offset, 8 + i * 20 + 8);
    header.writeUInt32BE(s.length, 8 + i * 20 + 12);
    parts.push({ offset, s });
    offset += 4096;
  });
  const out = Buffer.alloc(offset);
  header.copy(out, 0);
  for (const { offset: at, s } of parts) s.copy(out, at);
  return out;
}

test('Mach-O files are told from other files by their first bytes', () => {
  assert.equal(macho.kindOf(thin()), 'thin');
  assert.equal(macho.kindOf(fat([thin()])), 'fat');
  const javaClass = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34]);
  assert.equal(macho.kindOf(javaClass), null);
  assert.equal(macho.kindOf(Buffer.from('#!/bin/sh\necho hi\n')), null);
  assert.equal(macho.kindOf(Buffer.from([0xcf, 0xfa])), null);
});

test('the macOS a file needs is its arm64 slice\'s minos', () => {
  const dir = temp();
  const one = path.join(dir, 'one');
  writeFileSync(one, thin({ cmds: [buildVersion('14.0')] }));
  assert.equal(macho.arm64Minos(macho.inspect(one)), '14.0');
  const old = path.join(dir, 'old');
  writeFileSync(old, thin({ cmds: [versionMin('10.13')] }));
  assert.equal(macho.arm64Minos(macho.inspect(old)), '10.13');
  const ios = path.join(dir, 'ios');
  writeFileSync(ios, thin({ cmds: [buildVersion('17.0', 2)] })); // an iOS build version: not the Mac's
  assert.equal(macho.arm64Minos(macho.inspect(ios)), null);
  const universal = path.join(dir, 'universal');
  writeFileSync(universal, fat([thin({ cpu: 0x01000007, cmds: [buildVersion('10.13')] }), thin({ cmds: [buildVersion('11.0')] })]));
  const info = macho.inspect(universal);
  assert.deepEqual(info.slices.map((s) => s.arch), ['x86_64', 'arm64']);
  assert.equal(macho.arm64Minos(info), '11.0');
  touch(path.join(dir, 'notes.txt'), 'not code');
  assert.deepEqual(macho.scan(dir).map((m) => path.basename(m.file)).sort(), ['ios', 'old', 'one', 'universal']);
  assert.equal(macho.inspect(path.join(dir, 'notes.txt')), null);
});

test('versions compare as numbers, and the highest wins', () => {
  assert.equal(macho.compareVersions('14.0', '13.5'), 1);
  assert.equal(macho.compareVersions('10.13', '10.9'), 1);
  assert.equal(macho.compareVersions('26', '26.0'), 0);
  assert.equal(macho.maxVersion(['11.0', '14.0', null, '13.0']), '14.0');
  assert.equal(macho.maxVersion([]), null);
  assert.equal(macho.unpackVersion(packed('14.2.1')), '14.2.1');
  assert.equal(macho.unpackVersion(packed('26.0')), '26.0');
});

// ── the Swift helpers ──

test('every jarvis-*.swift is found, wherever it lives', () => {
  const root = temp();
  touch(path.join(root, 'player', 'jarvis-player.swift'));
  touch(path.join(root, 'audio', 'deep', 'jarvis-new-thing.swift'));
  touch(path.join(root, 'audio', 'helper.swift'));
  touch(path.join(root, '__pycache__', 'jarvis-stale.swift'));
  assert.deepEqual(helpers.findSources(root).map((f) => path.basename(f)), ['jarvis-new-thing.swift', 'jarvis-player.swift']);
  const real = helpers.findSources().map((f) => path.basename(f, '.swift'));
  for (const name of ['jarvis-player', 'jarvis-look', 'jarvis-axprobe', 'jarvis-duplex', 'jarvis-hear', 'jarvis-ocr', 'jarvis-embed']) {
    assert.ok(real.includes(name), name);
  }
});

test('a helper with @main is compiled as a library, as audio.build does', () => {
  assert.deepEqual(helpers.flagsFor('import Foundation\n@main\nstruct Hear {}'), ['-parse-as-library']);
  assert.deepEqual(helpers.flagsFor('print("hi") // no @main here'), []);
  assert.equal(helpers.targetFor('14.0'), 'arm64-apple-macos14.0');
  assert.equal(helpers.targetFor('26'), 'arm64-apple-macos26.0');
});

test('a helper that opens the microphone is signed to ask for it; the others ask for nothing', () => {
  assert.equal(helpers.entitlementsFor('let input = engine.inputNode\ninput.installTap(onBus: 0)'), 'microphone');
  assert.equal(helpers.entitlementsFor('let player = AVAudioPlayerNode()'), null);
  const real = Object.fromEntries(helpers.findSources().map((f) => [path.basename(f, '.swift'), helpers.entitlementsFor(readFileSync(f, 'utf8'))]));
  assert.equal(real['jarvis-duplex'], 'microphone'); // talk-over: the echo-cancelled microphone
  for (const name of ['jarvis-player', 'jarvis-hear', 'jarvis-look', 'jarvis-axprobe', 'jarvis-ocr', 'jarvis-embed']) assert.equal(real[name], null, name);
});

test("swiftc's availability errors name the macOS a helper needs", () => {
  const said = [
    "hear.swift:67:43: error: 'SpeechTranscriber' is only available in macOS 26 or newer",
    "hear.swift:99:1: error: 'Other' is only available in macOS 15.4 or newer",
  ].join('\n');
  assert.equal(helpers.neededMacos(said), '26.0');
  assert.equal(helpers.neededMacos("x.swift:1:1: error: cannot find 'foo' in scope"), null);
});

function fakeSwiftc(dir) {
  const script = path.join(dir, 'swiftc');
  writeFileSync(script, `#!/bin/sh
out=""; target=""; src=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -target) target="$2"; shift ;;
    *.swift) src="$1" ;;
  esac
  shift
done
echo "$target $*" >> "${dir}/calls"
if grep -q NEEDS26 "$src" && [ "$target" != "arm64-apple-macos26.0" ]; then
  echo "$src:1:1: error: 'SpeechAnalyzer' is only available in macOS 26 or newer" >&2; exit 1
fi
if grep -q BROKEN "$src"; then echo "$src:2:3: error: cannot find 'x' in scope" >&2; exit 1; fi
echo "binary built for $target" > "$out"
`);
  chmodSync(script, 0o755);
  return script;
}

test('helpers are built for the minimum macOS, with their source hash beside them', () => {
  const dir = temp();
  const src = path.join(dir, 'src');
  touch(path.join(src, 'player', 'jarvis-player.swift'), 'print("play")');
  touch(path.join(src, 'audio', 'jarvis-hear.swift'), '@main struct Hear { } // NEEDS26');
  const out = path.join(dir, 'out');
  const manifest = helpers.buildHelpers({ out, minimum: '14.0', sources: helpers.findSources(src), swiftc: [fakeSwiftc(dir)] });
  const player = manifest.helpers['jarvis-player'];
  assert.equal(player.target, '14.0');
  assert.equal(player.optional, false);
  assert.deepEqual(player.flags, []);
  assert.equal(player.entitlements, null);
  const hear = manifest.helpers['jarvis-hear'];
  assert.equal(hear.target, '26.0');
  assert.equal(hear.optional, true);
  assert.deepEqual(hear.flags, ['-parse-as-library']);
  for (const name of ['jarvis-player', 'jarvis-hear']) {
    const binary = path.join(out, name);
    assert.ok(statSync(binary).mode & 0o111, `${name} is executable`);
    const source = readFileSync(path.join(src, name === 'jarvis-hear' ? 'audio' : 'player', `${name}.swift`));
    const digest = crypto.createHash('sha256').update(source).digest('hex');
    assert.equal(readFileSync(`${binary}.sha256`, 'utf8'), `${digest}\n`);
    assert.equal(manifest.helpers[name].sha256, digest);
  }
  assert.match(readFileSync(path.join(out, 'jarvis-hear'), 'utf8'), /macos26\.0/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'helpers.json'), 'utf8')), manifest);
  const calls = readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n');
  assert.equal(calls.length, 3); // the player once; hear tried at 14.0, then at 26
});

test('a helper that fails for any other reason stops the build', () => {
  const dir = temp();
  const src = path.join(dir, 'src');
  touch(path.join(src, 'jarvis-bad.swift'), 'BROKEN');
  assert.throws(
    () => helpers.buildHelpers({ out: path.join(dir, 'out'), minimum: '14.0', sources: helpers.findSources(src), swiftc: [fakeSwiftc(dir)] }),
    /jarvis-bad helper didn't build[\s\S]*cannot find 'x'/,
  );
});

// ── the bundled Python ──

function fakePython(root) {
  for (const rel of ['bin/python3.12', 'bin/pip3', 'bin/idle3', 'bin/python3-config', 'include/python3.12/Python.h', 'share/man/man1/python3.1',
    'lib/pkgconfig/python3.pc', 'lib/libpython3.12.dylib', 'lib/libtcl9.0.dylib', 'lib/tcl9.0/init.tcl', 'lib/tk9.0/tk.tcl',
    'lib/python3.12/os.py', 'lib/python3.12/EXTERNALLY-MANAGED', 'lib/python3.12/tkinter/__init__.py', 'lib/python3.12/idlelib/idle.py',
    'lib/python3.12/ensurepip/__init__.py', 'lib/python3.12/lib-dynload/_tkinter.cpython-312-darwin.so',
    'lib/python3.12/lib-dynload/_crypt.cpython-312-darwin.so']) touch(path.join(root, rel), 'x');
}

test('the parts of Python that never run in the app are left out', () => {
  const root = temp();
  fakePython(root);
  const dropped = backend.prunePython(root);
  for (const gone of ['include', 'share', 'lib/pkgconfig', 'lib/libpython3.12.dylib', 'lib/libtcl9.0.dylib', 'lib/tcl9.0', 'lib/tk9.0',
    'lib/python3.12/tkinter', 'lib/python3.12/idlelib', 'lib/python3.12/ensurepip', 'lib/python3.12/EXTERNALLY-MANAGED',
    'lib/python3.12/lib-dynload/_tkinter.cpython-312-darwin.so']) {
    assert.equal(existsSync(path.join(root, gone)), false, gone);
    assert.ok(dropped.includes(gone), gone);
  }
  for (const kept of ['bin/python3.12', 'lib/python3.12/os.py', 'lib/python3.12/lib-dynload/_crypt.cpython-312-darwin.so']) {
    assert.ok(existsSync(path.join(root, kept)), kept);
  }
});

test("scripts with the build Mac's paths, pip, test folders and static libraries are left out; packages stay whole", () => {
  const root = temp();
  const site = path.join(root, 'lib', 'python3.12', 'site-packages');
  for (const rel of ['bin/python3.12', 'bin/python3', 'bin/python', 'bin/uvicorn', 'bin/jarvis', 'bin/pip']) touch(path.join(root, rel), '#!/Users/me/build/python3\n');
  touch(path.join(site, 'numpy', '__init__.py'));
  touch(path.join(site, 'numpy', 'tests', 'test_a.py'));
  touch(path.join(site, 'numpy', 'testing', '__init__.py'));
  touch(path.join(site, 'numpy', 'linalg', '__init__.py'));
  touch(path.join(site, 'numpy', 'linalg', 'tests', 'test_b.py'));
  touch(path.join(site, 'numpy', '_core', 'lib', 'libnpymath.a'), '!<arch>\n');
  touch(path.join(site, 'tests', 'something.py')); // not inside a package: left alone
  touch(path.join(site, 'pip', '__init__.py'));
  touch(path.join(site, 'pip-26.2.1.dist-info', 'METADATA'));
  touch(path.join(site, 'PyObjCTest', 'test_x.py'));
  touch(path.join(site, 'jarvis-0.1.0.dist-info', 'direct_url.json'), '{"url": "file:///Users/me/app/dist/jarvis.whl"}');
  touch(path.join(site, 'jarvis-0.1.0.dist-info', 'RECORD'));
  backend.pruneInstalled(root);
  assert.deepEqual(['python', 'python3', 'python3.12'].map((n) => existsSync(path.join(root, 'bin', n))), [true, true, true]);
  for (const gone of ['bin/uvicorn', 'bin/jarvis', 'bin/pip']) assert.equal(existsSync(path.join(root, gone)), false, gone);
  for (const gone of ['numpy/tests', 'numpy/linalg/tests', 'numpy/_core/lib/libnpymath.a', 'pip', 'pip-26.2.1.dist-info', 'PyObjCTest', 'jarvis-0.1.0.dist-info/direct_url.json']) {
    assert.equal(existsSync(path.join(site, gone)), false, gone);
  }
  for (const kept of ['numpy/testing/__init__.py', 'numpy/linalg/__init__.py', 'tests/something.py', 'jarvis-0.1.0.dist-info/RECORD']) {
    assert.ok(existsSync(path.join(site, kept)), kept);
  }
});

test('a .py without its unchecked-hash .pyc is found', () => {
  const root = temp();
  const lib = path.join(root, 'lib', 'python3.12');
  const pyc = (flags) => { const b = Buffer.alloc(16); b.writeUInt32LE(0x0a0d0dcb, 0); b.writeUInt32LE(flags, 4); return b; };
  touch(path.join(lib, 'good.py'));
  touch(path.join(lib, '__pycache__', 'good.cpython-312.pyc'), pyc(1));
  touch(path.join(lib, 'stamped.py'));
  touch(path.join(lib, '__pycache__', 'stamped.cpython-312.pyc'), pyc(0)); // checked against the source's time: may be rewritten
  touch(path.join(lib, 'checked.py'));
  touch(path.join(lib, '__pycache__', 'checked.cpython-312.pyc'), pyc(3)); // checked-hash: may be rewritten too
  touch(path.join(lib, 'pkg', 'missing.py'));
  assert.deepEqual(backend.uncompiled(root).sort(), ['checked.py', 'pkg/missing.py', 'stamped.py']);
});

test("uv's install folder is taken out of Python's build settings", () => {
  const root = temp();
  const lib = path.join(root, 'lib', 'python3.12');
  touch(path.join(lib, '_sysconfigdata__darwin_darwin.py'),
    "build_time_vars = {'prefix': '/Users/me/.local/share/uv/python/cpython-3.12.14-macos-aarch64-none', 'LIBDIR': '/Users/me/.local/share/uv/python/cpython-3.12-macos-aarch64-none/lib'}\n");
  backend.neutralizePaths(root, ['/Users/me/.local/share/uv/python/cpython-3.12.14-macos-aarch64-none', '/Users/me/.local/share/uv/python/cpython-3.12-macos-aarch64-none']);
  const text = readFileSync(path.join(lib, '_sysconfigdata__darwin_darwin.py'), 'utf8');
  assert.equal(text.includes('/Users/me'), false);
  assert.match(text, /'prefix': '\/install', 'LIBDIR': '\/install\/lib'/);
});

test('every tracked file of the package must be in the installed copy', () => {
  const root = temp();
  const site = path.join(root, 'lib', 'python3.12', 'site-packages');
  touch(path.join(site, 'jarvis', '__init__.py'));
  touch(path.join(site, 'jarvis', 'web', 'index.html'));
  assert.deepEqual(backend.packageGaps(root, ['src/jarvis/__init__.py', 'src/jarvis/web/index.html', 'src/jarvis/audio/jarvis-hear.swift']), ['src/jarvis/audio/jarvis-hear.swift']);
});
