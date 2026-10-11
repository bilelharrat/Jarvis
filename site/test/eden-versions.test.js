// The Eden copy's versioned addresses (scripts/eden-versions.mjs, run by sync-eden.mjs; askeden
// docs/bug-sweep/r1-optimize-ask-eden-web.md): index.html and edu.html name every script and
// stylesheet by its content hash, an import map gives every module that address, the map's hash goes
// into the CSP, and the build stamp (src/eden/build.js) follows the files.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handEdits, sha, stampPages, versionPages } from '../scripts/eden-versions.mjs';
import { buildOf, edenBuild, stampOf } from '../src/eden/build.js';
import * as manifest from '../src/eden/manifest.js';

const file = (name, text) => ({ name, bytes: Buffer.from(text) });
const INDEX = `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Eden</title>
<link rel="icon" href="/jarvis/eden-logo.svg">
<link rel="stylesheet" href="app.css">
<link rel="stylesheet" href="mail.css">
<script type="module" src="app.js"></script>
<script type="module" src="deck.js"></script>
<meta name="robots" content="noindex, nofollow">
<script type="module" src="hosted.js"></script>
</head><body></body></html>`;
const files = () => [
  file('index.html', INDEX),
  file('edu.html', '<html><head><meta charset="utf-8"><link rel="stylesheet" href="app.css"><script type="module" src="edu-app.js"></script></head></html>'),
  file('app.css', 'body{}'),
  file('mail.css', '.m{}'),
  file('app.js', "import './util.js';\nimport { x } from './state.js';\nconst lazy = () => import('./mail.js');"),
  file('util.js', 'export const u = 1;'),
  file('state.js', 'export const x = 1;'),
  file('mail.js', "export const m = 1; import('./sheet.mjs');"),
  file('sheet.mjs', 'export default 1;'),
  file('deck.js', 'export const d = 1;'),
  file('artifact.js', "export const show = () => import('./deck.js');"), // deck.js: an entry another module imports too
  file('edu-app.js', "import './util.js';"),
  file('hosted.js', "import './util.js';"),
  file('runner.html', '<script>1</script>'),
];

test('versioned addresses: scripts and stylesheets by content hash, every module in the import map, its hash for the CSP', () => {
  const fs = files();
  const hashes = versionPages(fs);
  const by = Object.fromEntries(fs.map((f) => [f.name, f.bytes.toString('utf8')]));
  const html = by['index.html'];
  const h = (n) => sha(Buffer.from(files().find((f) => f.name === n).bytes));
  assert.match(html, new RegExp(`<script type="module" src="app\\.js\\?v=${h('app.js')}"></script>`));
  assert.match(html, new RegExp(`<script type="module" src="hosted\\.js\\?v=${h('hosted.js')}"></script>`));
  assert.match(html, new RegExp(`<link rel="stylesheet" href="app\\.css\\?v=${h('app.css')}">`));
  assert.match(html, new RegExp(`<link rel="stylesheet" href="mail\\.css\\?v=${h('mail.css')}">`));
  assert.match(html, /<link rel="icon" href="\/jarvis\/eden-logo\.svg">/, 'other links stay');
  // deck.js is imported by artifact.js too: one plain address everywhere (no second copy if the map were ever ignored)
  assert.match(html, /<script type="module" src="deck\.js"><\/script>/);
  const map = /<script type="importmap">([^<]+)<\/script>/.exec(html);
  assert.ok(map, 'an import map');
  assert.ok(html.indexOf('type="importmap"') < html.indexOf('type="module"'), 'before any module');
  assert.ok(html.indexOf('type="importmap"') > html.indexOf('<meta charset="utf-8">'), 'after the charset');
  const { imports } = JSON.parse(map[1]);
  for (const n of ['app.js', 'util.js', 'state.js', 'mail.js', 'sheet.mjs', 'artifact.js', 'edu-app.js', 'hosted.js']) assert.equal(imports[`/${n}`], `/${n}?v=${h(n)}`, n);
  assert.equal(imports['/deck.js'], undefined);
  assert.equal(Object.keys(imports).some((k) => /\.(css|html)$/.test(k)), false);
  // the CSP hash is the map's own
  assert.deepEqual(hashes, [`'sha256-${crypto.createHash('sha256').update(map[1]).digest('base64')}'`]);
  // edu.html: the same map (one hash for both pages), its own entry versioned
  const edu = by['edu.html'];
  assert.ok(edu.includes(map[0]));
  assert.match(edu, new RegExp(`src="edu-app\\.js\\?v=${h('edu-app.js')}"`));
  assert.match(edu, new RegExp(`href="app\\.css\\?v=${h('app.css')}"`));
  // nothing else changed
  for (const n of ['app.js', 'mail.js', 'runner.html', 'app.css']) assert.equal(by[n], files().find((f) => f.name === n).bytes.toString('utf8'));
});

test('versioned addresses: a changed module changes only its own address (and the pages)', () => {
  const a = files();
  versionPages(a);
  const b = files().map((f) => (f.name === 'state.js' ? file('state.js', 'export const x = 2;') : f));
  versionPages(b);
  const mapOf = (fs) => JSON.parse(/<script type="importmap">([^<]+)<\/script>/.exec(fs.find((f) => f.name === 'index.html').bytes.toString('utf8'))[1]).imports;
  const [ma, mb] = [mapOf(a), mapOf(b)];
  const changed = Object.keys(ma).filter((k) => ma[k] !== mb[k]);
  assert.deepEqual(changed, ['/state.js']);
});

test('versioned addresses: a page with its own import map is refused (it would need merging)', () => {
  const fs = files().map((f) => (f.name === 'index.html' ? file('index.html', INDEX.replace('<title>', '<script type="importmap">{"imports":{}}</script><title>')) : f));
  assert.throws(() => versionPages(fs), /its own import map/);
  assert.deepEqual(versionPages([file('a.js', '1')]), [], 'no page: no hash');
});

test('build stamp: the same files, the same stamp in any order; any change, another', () => {
  const h = { 'a.js': '1111', 'b.css': '2222', 'index.html': '3333' };
  assert.match(buildOf(h), /^[0-9a-f]{16}$/);
  assert.equal(buildOf(h), buildOf({ 'index.html': '3333', 'b.css': '2222', 'a.js': '1111' }));
  assert.notEqual(buildOf(h), buildOf({ ...h, 'a.js': '1112' }));
  assert.notEqual(buildOf(h), buildOf({ ...h, 'c.js': '4444' }));
  const { 'b.css': _gone, ...rest } = h;
  assert.notEqual(buildOf(h), buildOf(rest));
  assert.notEqual(stampOf('ab'), stampOf('ba'));
});

// ── bug sweep round 2 (askeden docs/bug-sweep/r2-ask-eden-site-edu.md AW2-1, AW2-2) ──

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDEN = path.join(SITE, 'public', 'eden');

test('AW2-2: every file served from public/eden is the one the manifest names (a hand edit would be served immutable under a stale hash)', () => {
  const on = nodeFs.readdirSync(EDEN).filter((n) => !n.startsWith('.')).sort();
  assert.deepEqual(on, [...manifest.EDEN_FILES].sort(), 'the same files');
  const off = manifest.EDEN_FILES.filter((n) => sha(nodeFs.readFileSync(path.join(EDEN, n))) !== manifest.EDEN_HASHES[n]);
  assert.deepEqual(off, [], `edited after the sync (port the change to askeden web/chat, then sync): ${off.join(', ')}`);
  // the pages' versioned addresses are the files' hashes
  for (const page of ['index.html', 'edu.html'].filter((n) => manifest.EDEN_FILES.includes(n))) {
    const html = nodeFs.readFileSync(path.join(EDEN, page), 'utf8');
    for (const [, name, v] of html.matchAll(/(?:src|href)="([\w.-]+)\?v=([0-9a-f]{16})"/g)) assert.equal(v, manifest.EDEN_HASHES[name], `${page}: ${name}`);
    for (const [, name, v] of html.matchAll(/"\/([\w.-]+)\?v=([0-9a-f]{16})"/g)) assert.equal(v, manifest.EDEN_HASHES[name], `${page} import map: ${name}`);
    // AW2-1: a page from a sync that writes the build stamp carries the Worker's own
    if (typeof manifest.EDEN_BUILD === 'string') {
      assert.equal(/<meta name="eden-build" content="([0-9a-f]{16})">/.exec(html)?.[1], edenBuild(), `${page}: its build stamp`);
    }
  }
  if (typeof manifest.EDEN_BUILD === 'string') assert.equal(edenBuild(), manifest.EDEN_BUILD);
});

test('AW2-1: the sync writes the build stamp into the pages: the Worker’s stamp of those files, changed by any file', () => {
  const a = files();
  versionPages(a);
  const hashes = Object.fromEntries(a.map((f) => [f.name, sha(f.bytes)]));
  const build = stampPages(a);
  assert.equal(build, buildOf(hashes), 'over every file, the pages as versioned (before the meta)');
  for (const page of ['index.html', 'edu.html']) {
    const html = a.find((f) => f.name === page).bytes.toString('utf8');
    assert.ok(html.includes(`<meta name="eden-build" content="${build}">`), page);
    assert.ok(html.indexOf('eden-build') > html.indexOf('type="importmap"') && html.indexOf('eden-build') < html.indexOf('type="module"'), 'after the map, before any script');
  }
  assert.ok(!a.find((f) => f.name === 'runner.html').bytes.toString('utf8').includes('eden-build'), 'other pages untouched');
  const b = files().map((f) => (f.name === 'mail.css' ? file('mail.css', '.m{color:red}') : f));
  versionPages(b);
  assert.notEqual(stampPages(b), build, 'a stylesheet changed: another stamp');
  const c = files().map((f) => (f.name === 'sheet.mjs' ? file('sheet.mjs', 'export default 2;') : f));
  versionPages(c);
  assert.notEqual(stampPages(c), build, 'a module only another module imports: another stamp too');
  const twice = files();
  versionPages(twice);
  stampPages(twice);
  assert.throws(() => stampPages(twice), /its own eden-build meta/);
});

test('AW2-2: the sync finds the hand edits in public/eden it would lose (not the files it would write the same)', () => {
  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'eden-hand-'));
  const was = { 'tour.js': 'const a = 1;\nconst b = 2;\n', 'app.js': 'app 1', 'mail.js': 'mail 1', 'deck.js': 'deck 1' };
  for (const [n, t] of Object.entries(was)) nodeFs.writeFileSync(path.join(dir, n), t);
  const hashes = Object.fromEntries(Object.entries(was).map(([n, t]) => [n, sha(Buffer.from(t))]));
  nodeFs.writeFileSync(path.join(dir, 'tour.js'), 'const a = 1;\nconst b = 2;\nif (auto) save({ seen: true });\n'); // edited by hand
  nodeFs.writeFileSync(path.join(dir, 'mail.js'), 'mail 2'); // edited by hand, and ported: the new copy is the same
  const fresh = [file('tour.js', 'const a = 1;\nconst b = 3;\n'), file('app.js', 'app 2'), file('mail.js', 'mail 2'), file('deck.js', 'deck 1')];
  const found = handEdits(dir, hashes, fresh, { fs: nodeFs });
  assert.deepEqual(found, [{ name: 'tour.js', lines: ['const b = 2;', 'if (auto) save({ seen: true });'] }]);
  assert.deepEqual(handEdits(dir, null, fresh, { fs: nodeFs }), [], 'no manifest yet: nothing to compare');
  // sync-eden refuses on them (and names --ported / --force)
  const sync = nodeFs.readFileSync(path.join(SITE, 'scripts', 'sync-eden.mjs'), 'utf8');
  assert.match(sync, /handEdits\(OUT, lastHashes, files, \{ fs \}\)/);
  assert.match(sync, /if \(opts\.check \|\| !opts\.force\) \{\s*console\.error\(what\);\s*process\.exit\(1\);/);
  assert.ok(sync.indexOf('handEdits(OUT') < sync.indexOf('swapIn(swaps);'), 'checked before public/eden is replaced (the swap: AW3-2, run for real in r3-sync-eden.test.js)');
});
