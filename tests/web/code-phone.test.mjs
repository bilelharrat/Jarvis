// Eden Code on the phone: the page's helpers (web/code-phone.js) and the Mac's Phone pane's
// (web/features/code_phone.js), and what the page never does (markup from a session, a token
// in an address, Bypass in its menus).
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const page = require('../../src/jarvis/web/code-phone.js');
const pane = require('../../src/jarvis/web/features/code_phone.js');
const SOURCE = readFileSync(new URL('../../src/jarvis/web/code-phone.js', import.meta.url), 'utf8');
const PANE = readFileSync(new URL('../../src/jarvis/web/features/code_phone.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../../src/jarvis/web/code-phone.html', import.meta.url), 'utf8');

test('new entries are added and changed ones put in their place, in order', () => {
  const have = [{ i: 1, text: 'fix it' }, { i: 2, text: 'Bash make test' }];
  const merged = page.mergeEntries(have, [{ i: 3, text: 'Done.' }], [{ i: 2, text: 'Bash make test\n3 passed' }]);
  assert.deepEqual(merged.map((e) => e.i), [1, 2, 3]);
  assert.equal(merged[1].text, 'Bash make test\n3 passed');
  assert.deepEqual(page.mergeEntries([], undefined, undefined), []);
});

test('the mode menu offers Manual and Accept edits, and shows a Mac-set mode without offering it', () => {
  const t = page.words('en');
  const modes = [{ id: 'ask', name: 'Manual' }, { id: 'edits', name: 'Accept edits' }];
  assert.deepEqual(page.modeChoices({ id: 'ask', name: 'Manual' }, modes, t).map((m) => m.id), ['ask', 'edits']);
  const bypass = page.modeChoices({ id: 'auto', name: 'Bypass permissions' }, modes, t);
  assert.deepEqual(bypass.map((m) => [m.id, m.disabled]), [['ask', false], ['edits', false], ['auto', true]]);
  assert.match(bypass[2].name, /set on the Mac/);
});

test('a Mac-only card takes only a no from the phone', () => {
  const card = { mac_only: true, choices: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Not now' }] };
  assert.equal(page.canSayYes(card), false);
  assert.equal(page.noChoice(card).id, 'deny');
  assert.equal(page.canSayYes({ mac_only: false }), true);
  assert.equal(page.noChoice({ choices: [{ id: 'allow' }] }), null);
});

test('a handoff opens once, and the address says which view', () => {
  assert.equal(page.handoffToOpen({ id: 5, at: 200 }, '100'), 5);
  assert.equal(page.handoffToOpen({ id: 5, at: 200 }, '200'), 0);
  assert.equal(page.handoffToOpen(null, ''), 0);
  assert.deepEqual(page.parseHash('#s=12'), { view: 'session', id: 12 });
  assert.deepEqual(page.parseHash('#new'), { view: 'new', id: 0 });
  assert.deepEqual(page.parseHash('#s=<img>'), { view: 'home', id: 0 });
  assert.deepEqual(page.parseHash(''), { view: 'home', id: 0 });
});

test('retries back off, and Exterminator runs read in one line, in Chinese too', () => {
  assert.deepEqual([1, 2, 3, 6, 9].map(page.backoff), [1, 2, 4, 30, 30]);
  const run = { project: 'alpha', round: 2, rounds: 3, step: 'fix', state: 'running', found: 4, fixed: 1, spent: 1.5, spend_cap: 10 };
  assert.equal(page.runLine(run, page.words('en')), 'alpha · Round 2 of 3 · fix · running · 4 found, 1 fixed · $1.50 of $10.00');
  assert.match(page.runLine(run, page.words('zh-CN')), /第 2\/3 轮/);
  assert.equal(page.statusKey('needs_you'), 'needs_you_status');
  assert.equal(page.statusKey('<b>'), 'idle');
});

test('code fences are split out, and stay text', () => {
  assert.deepEqual(page.blocks('Run:\n```sh\nmake test\n```\nThen <b>this</b>'), [
    { code: false, text: 'Run:' }, { code: true, text: 'make test' }, { code: false, text: 'Then <b>this</b>' },
  ]);
});

test('outside text never goes in as markup, and the token never goes in an address', () => {
  for (const src of [SOURCE, PANE]) {
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  }
  assert.doesNotMatch(SOURCE, /[?&]token=|token=\$\{/);
  assert.match(SOURCE, /Authorization: `Bearer \$\{token\}`/);
  assert.doesNotMatch(HTML, /<script>|on(click|load|error)=/i);  // (the CSP allows its own file only)
  assert.doesNotMatch(HTML + SOURCE, /Jarvis|Eden Secretary/);
  assert.doesNotMatch(HTML, /value="auto"|Bypass permissions<\/option>/);
});

test('the pane draws the QR code and says what is pinned', () => {
  assert.equal(pane.qrPath(['101', '011']), 'M4 4h1v1h-1zM6 4h1v1h-1zM5 5h2v1h-2z');
  assert.equal(pane.pinnedText(null), 'Nothing pinned for your phone.');
  assert.equal(pane.pinnedText({ id: 5, title: 'Login fix' }), 'On your phone: Login fix');
  assert.equal(pane.PREF, 'code_phone_web');
});

test('the pane strings have their Chinese', () => {
  const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n/code_phone.json', import.meta.url), 'utf8'));
  for (const s of ['Open on my phone', 'On your phone', 'Opens this session on your phone', 'Open this session on your phone', 'Pair the Eden Code app', 'New code', 'Expires in', 'Or open Eden Code in the phone’s browser', 'Nothing pinned for your phone.']) {
    assert.ok(zh.strings[s], s);
  }
  assert.ok(zh.patterns.some(([re]) => new RegExp(re).test('On your phone: Login fix')));
});

// ── Pair the Eden Code app (features/code_phone_pair.py) ──

test('the pairing code counts down in m:ss and reads as two groups of three', () => {
  assert.equal(pane.countdown(300), '5:00');
  assert.equal(pane.countdown(61.9), '1:01');
  assert.equal(pane.countdown(9), '0:09');
  assert.equal(pane.countdown(0), '');
  assert.equal(pane.countdown(-5), '');
  assert.equal(pane.countdown(undefined), '');
  assert.equal(pane.spaced('042917'), '042 917');
  assert.equal(pane.spaced('12345'), '');
  assert.equal(pane.spaced(''), '');
});

test('the pairing section shows the code only while it lives and the companion runs', () => {
  assert.equal(pane.pairView(null, 0), 'ask');
  assert.equal(pane.pairView({ running: false, code: '123456' }, 200), 'off');
  assert.equal(pane.pairView({ running: true, error: 'No QR code: x.', code: '' }, 0), 'error');
  assert.equal(pane.pairView({ running: true, code: '123456', qr: ['1'] }, 200), 'code');
  assert.equal(pane.pairView({ running: true, code: '123456', qr: ['1'] }, 0), 'ask');
  assert.equal(pane.pairView({ running: true, code: '' }, 200), 'ask');
});

test('the pane asks for the app’s QR code, keeps the page’s labelled for the browser, and puts no code in markup', () => {
  assert.match(PANE, /Pair the Eden Code app/);
  assert.match(PANE, /type: 'code_phone_pair', peek: true/);
  assert.match(PANE, /type: 'code_phone_pair', fresh: fresh === true/);
  assert.match(PANE, /Or open Eden Code in the phone’s browser/);
  assert.match(PANE, /New code/);
  assert.doesNotMatch(PANE, /innerHTML/);
  // the Mac's name and the error come from outside the window's words: never translated
  assert.match(PANE, /mine\(el\('p', 'jcx-phone-warn', pair\.error\)\)/);
  const SETTINGS = readFileSync(new URL('../../src/jarvis/web/features/code-settings.js', import.meta.url), 'utf8');
  assert.match(SETTINGS, /Pair the Eden Code app/);
  assert.match(SETTINGS, /edenCodePair\.open\(\)/);
});
