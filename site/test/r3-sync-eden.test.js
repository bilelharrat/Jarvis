// Bug sweep round 3 (askeden docs/bug-sweep/r3-ask-eden-site-edu.md): scripts/sync-eden.mjs, run for real on a
// throwaway copy of the site and a small fake askeden (stub bundles, the site's own esbuild).
// AW3-2 a failed sync leaves the tree as it was; AW3-3 hand edits in public/help are refused like public/eden's;
// AW3-9 web/chat's package.json (a dev file) is never an Eden file.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isWebFile, pageFiles } from '../scripts/sync-eden.mjs';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;

/** A copy of what the sync needs of the site, and a fake askeden: { site, eden, run(args, env) }. */
function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eden-r3-sync-'));
  const site = path.join(root, 'site');
  const eden = path.join(root, 'askeden');
  for (const f of ['scripts/sync-eden.mjs', 'scripts/eden-versions.mjs', 'src/eden/build-stamp.js', 'web/hosted.js']) {
    fs.mkdirSync(path.dirname(path.join(site, f)), { recursive: true });
    fs.copyFileSync(path.join(SITE, f), path.join(site, f));
  }
  const put = (f, text) => { fs.mkdirSync(path.dirname(path.join(eden, f)), { recursive: true }); fs.writeFileSync(path.join(eden, f), text); };
  put('package.json', '{"name":"askeden","version":"0.0.0-test"}');
  fs.symlinkSync(path.join(SITE, 'node_modules'), path.join(eden, 'node_modules')); // the site's own esbuild
  put('web/chat/index.html', '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="app.css"><script type="module" src="app.js"></script></head><body></body></html>');
  put('web/chat/edu.html', '<!doctype html><html><head><meta charset="utf-8"><script type="module" src="edu-app.js"></script></head><body></body></html>');
  put('web/chat/app.js', 'export const v = 1;');
  put('web/chat/edu-app.js', "import './app.js';");
  put('web/chat/app.css', 'body{}');
  put('web/chat/package.json', '{"type":"module"}');
  put('web/help/faq.json', JSON.stringify({ categories: [], entries: [] }));
  put('web/help/help-core.js', 'export const buildIndex = (faq) => ({ N: faq.entries.length });');
  put('web/help/help.css', '.h{}');
  put('web/help/index.html', '<!doctype html><title>Help</title>');
  put('web/help/package.json', '{"type":"module"}');
  // every module the sync bundles, as stubs exporting the names it asks for (read from the script itself)
  const script = fs.readFileSync(path.join(SITE, 'scripts/sync-eden.mjs'), 'utf8');
  const stubs = new Map();
  for (const [, file, names] of script.matchAll(/'(src\/[\w/.-]+\.ts)': \[([^\]]*)\]/g)) {
    const list = [...names.matchAll(/'(\w+)'/g)].map((m) => m[1]);
    stubs.set(file, [...(stubs.get(file) || []), ...list]);
  }
  for (const [file, names] of stubs) put(file, names.map((n) => `export const ${n} = 1;`).join('\n'));
  put('src/browser.ts', 'export const router = 1;');
  const run = (args = [], env = {}) => spawnSync(NODE, [path.join(site, 'scripts/sync-eden.mjs'), '--eden', eden, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { root, site, eden, put, run };
}

/** Every file under dir, as { relative path: bytes as text }. */
function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}
/** What a sync writes: public/ and src/eden/ (manifest, vendor bundles). */
const generated = (site) => ({ ...tree(path.join(site, 'public')), ...tree(path.join(site, 'src', 'eden')) });

test('AW3-9: a folder’s dev files are never page files (package.json stays out of public/eden and the manifest)', () => {
  assert.equal(isWebFile('package.json'), false);
  assert.equal(isWebFile('tsconfig.json'), false);
  assert.equal(isWebFile('app.test.js'), false);
  assert.equal(isWebFile('faq.json'), true);
  assert.equal(isWebFile('app.js'), true);
  const s = scratch();
  const { files, skipped } = pageFiles(path.join(s.eden, 'web/chat'));
  assert.ok(!files.some((f) => f.name === 'package.json'));
  assert.ok(skipped.includes('package.json'), 'named as left out');
  fs.rmSync(s.root, { recursive: true, force: true });
});

test('AW3-2: a sync is all or nothing: a failure while building or while swapping leaves public/eden, public/help, the bundles and the manifest as they were', () => {
  const s = scratch();
  try {
    const first = s.run();
    assert.equal(first.status, 0, first.stderr);
    const manifest = fs.readFileSync(path.join(s.site, 'src/eden/manifest.js'), 'utf8');
    assert.doesNotMatch(manifest, /package\.json/, 'AW3-9: not in the manifest');
    assert.ok(!fs.existsSync(path.join(s.site, 'public/eden/package.json')));
    assert.ok(!fs.existsSync(path.join(s.site, 'public/help/package.json')));
    assert.match(manifest, /^export const EDEN_HELP_HASHES = \{.*"help\.css".*\};$/m, 'AW3-3: public/help’s hashes recorded');
    const before = generated(s.site);

    // web/chat and web/help moved on, then the router's bundle fails (its source is gone)
    s.put('web/chat/app.js', 'export const v = 2;');
    s.put('web/help/help.css', '.h{color:red}');
    fs.rmSync(path.join(s.eden, 'src/browser.ts'));
    const broken = s.run();
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /No router source/);
    assert.deepEqual(generated(s.site), before, 'nothing changed: the page, Help, bundles and manifest stay in step');

    // the bundles build, but a step of the swap fails (each one in turn): everything goes back
    s.put('src/browser.ts', 'export const router = 2;');
    for (const at of [1, 2, 4, 8]) {
      const mid = s.run([], { SYNC_EDEN_FAIL_AT: String(at) });
      assert.equal(mid.status, 1, `step ${at}`);
      assert.match(mid.stderr, /failed on purpose/);
      assert.deepEqual(generated(s.site), before, `step ${at}: rolled back, nothing staged left behind`);
    }

    // and a sync that works brings it all in together
    const ok = s.run();
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(fs.readFileSync(path.join(s.site, 'public/eden/app.js'), 'utf8'), 'export const v = 2;');
    assert.equal(fs.readFileSync(path.join(s.site, 'public/help/help.css'), 'utf8'), '.h{color:red}');
    const after = fs.readFileSync(path.join(s.site, 'src/eden/manifest.js'), 'utf8');
    const meta = /<meta name="eden-build" content="([0-9a-f]{16})">/.exec(fs.readFileSync(path.join(s.site, 'public/eden/index.html'), 'utf8'))[1];
    assert.equal(/^export const EDEN_BUILD = "([0-9a-f]{16})";$/m.exec(after)[1], meta, 'the page and the manifest from the same sync');
    assert.ok(!Object.keys(generated(s.site)).some((n) => /\.(new|old)$/.test(n) || /\.(new|old)\//.test(n)), 'no staged or old copies left');
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('AW3-3: a hand edit (or added file) in public/help is refused by the sync and by --check, like public/eden’s', () => {
  const s = scratch();
  try {
    assert.equal(s.run().status, 0);
    fs.appendFileSync(path.join(s.site, 'public/help/help.css'), '\n.mine{}');
    s.put('web/help/help.css', '.h{color:blue}'); // upstream changed it too: the sync would lose the edit
    const r = s.run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /public\/help has hand edits/);
    assert.match(r.stderr, /help\/help\.css/);
    assert.match(r.stderr, /\.mine\{\}/);
    assert.match(fs.readFileSync(path.join(s.site, 'public/help/help.css'), 'utf8'), /\.mine/, 'kept');
    assert.equal(s.run(['--check']).status, 1);
    assert.equal(s.run(['--ported', 'help/help.css']).status, 0, 'ported to web/help: the sync goes ahead');
    assert.equal(fs.readFileSync(path.join(s.site, 'public/help/help.css'), 'utf8'), '.h{color:blue}');

    fs.writeFileSync(path.join(s.site, 'public/help/extra.css'), '.x{}');
    const added = s.run();
    assert.equal(added.status, 1);
    assert.match(added.stderr, /help\/extra\.css/);
    assert.equal(s.run(['--force']).status, 0);
    assert.ok(!fs.existsSync(path.join(s.site, 'public/help/extra.css')));
    assert.equal(s.run(['--check']).status, 0, 'in step again');
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('the sync script runs only as a script: importing it (as these tests do) writes nothing', () => {
  const out = execFileSync(NODE, ['--input-type=module', '-e', `await import(${JSON.stringify(path.join(SITE, 'scripts/sync-eden.mjs'))}); console.log('imported');`], { encoding: 'utf8' });
  assert.equal(out.trim(), 'imported');
});
