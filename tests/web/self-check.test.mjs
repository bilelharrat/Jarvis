// "Check it yourself": the hidden preview's trust rules (app/self-check-lib.js) and the
// window's transcript entry (web/features/code-selfcheck.js), in plain Node.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const lib = require('../../app/self-check-lib.js');
const view = require('../../src/jarvis/web/features/code-selfcheck.js');

const rules = { origins: ['http://127.0.0.1:5173'], root: '' };

test('only the origins the check was given, all on this Mac', () => {
  assert.ok(lib.allowed('http://127.0.0.1:5173/cart?x=1', rules));
  assert.ok(lib.allowed('about:blank', rules));
  for (const url of ['http://127.0.0.1:5174/', 'http://localhost:5173/', 'https://example.com/', 'http://10.0.0.8:5173/', 'javascript:alert(1)', 'data:text/html,hi', 'nonsense']) {
    assert.ok(!lib.allowed(url, rules), url);
  }
  // Only pages on this Mac can be given at all.
  assert.deepEqual(lib.cleanRules({ origins: ['https://example.com', 'http://localhost:3000/app', 'http://[::1]:8000'], root: 'relative/dir' }), {
    origins: ['http://localhost:3000', 'http://[::1]:8000'], root: '',
  });
});

test('files only inside the project, symlinks followed (S29)', () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-lib-')));
  fs.writeFileSync(path.join(project, 'index.html'), 'hi');
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-out-')));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'no');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(project, 'link.html'));
  const r = { origins: [], root: project };
  const real = (p) => fs.realpathSync(p);
  assert.ok(lib.allowed(pathToFileURL(path.join(project, 'index.html')).href, r, real));
  assert.ok(!lib.allowed(pathToFileURL(path.join(project, 'link.html')).href, r, real), 'a link out of the project');
  assert.ok(!lib.allowed('file:///etc/hosts', r, real));
  assert.ok(!lib.allowed(pathToFileURL(path.join(project, '..', path.basename(outside), 'secret.txt')).href, r, real));
  assert.ok(!lib.allowed(pathToFileURL(path.join(project, 'index.html')).href, { origins: [] }, real), 'no root: no files');
});

test("a press's verdict looks at what it really does, not the label (S31)", () => {
  assert.equal(lib.pressVerdict({ href: 'https://evil.test/' }, null, rules).go, 'refuse');
  assert.equal(lib.pressVerdict({ href: 'http://127.0.0.1:5173/next' }, null, rules).go, 'ok');
  assert.equal(lib.pressVerdict({ href: 'javascript:void 0' }, null, rules).go, 'ok');
  assert.equal(lib.pressVerdict({}, { action: 'https://evil.test/collect' }, rules).go, 'refuse');
  assert.equal(lib.pressVerdict({}, { action: 'http://127.0.0.1:5173/save', payment: true }, rules).go, 'ask');
  assert.equal(lib.pressVerdict({}, { action: '', password: true }, rules).go, 'ask');
  assert.equal(lib.pressVerdict({ risky: true }, { action: 'http://127.0.0.1:5173/delete' }, rules).go, 'ok');
  assert.equal(lib.pressVerdict(null, null, rules).go, 'ok');
});

test("the transcript's compact line", () => {
  assert.equal(view.headline({ steps: 4, shots: 2, console_errors: 0, network_failures: 0 }), 'Checked: 4 steps, 2 screenshots, no console errors');
  assert.equal(view.headline({ steps: 1, shots: 1, console_errors: 3, network_failures: 1 }), 'Checked: 1 step, 1 screenshot, 3 console errors, 1 failed request');
  assert.equal(view.headline({ steps: 6, shots: 0, console_errors: 0, target: 'ios', log_errors: 2 }), 'Checked: 6 steps, 0 screenshots, 2 app log errors');
  assert.equal(view.verdictMark('pass'), '✓');
  assert.equal(view.verdictMark('fail'), '✕');
  assert.equal(view.verdictMark('unfinished'), '–');
  assert.equal(view.jpegSrc('abc+/='), 'data:image/jpeg;base64,abc+/=');
  assert.equal(view.jpegSrc('"><script>'), '');
});

test("the window asks the app (one window does it) and its words have Chinese", () => {
  const appJs = fs.readFileSync(new URL('../../src/jarvis/web/app.js', import.meta.url), 'utf8');
  assert.match(appJs, /WINDOW_DUTIES = new Set\([^)]*'sc_call'/);
  assert.match(appJs, /SPLIT_PANE_QUIET = new Set\(\[[^\]]*'sc_result'/);
  const zh = JSON.parse(fs.readFileSync(new URL('../../src/jarvis/web/i18n/code-selfcheck.json', import.meta.url), 'utf8')).strings;
  for (const s of ['Check it yourself', 'Before saying it’s done: open it, try it, look', 'Passed', 'Found problems', 'Not finished', 'Screenshot', 'What it found', 'Check it yourself · What it did']) {
    assert.ok(zh[s], s);
  }
});
