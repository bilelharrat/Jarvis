// Touch ID for Eden Code's riskiest moments: which steps are risky (web/features/
// code-touchid.js) and the app's own side (app/features/touchid.js): its fixed reasons, one
// sheet at a time, and only the window may ask. node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ct = require('../../src/jarvis/web/features/code-touchid.js');
const { handlers, install, REASONS } = require('../../app/features/touchid.js');

const KEY = '5e'.repeat(32);  // the proof key (proof-pipe.js): never the page's token
const bash = (command, choice = 'allow') => ct.risky({ task_id: 1, tool: 'Bash', detail: `$ ${command}`, question: 'Eden Code in alpha wants to run a command' }, choice);

test('a risky step: one that deletes, pushes, publishes, runs as root, or edits outside the project', () => {
  for (const risky of ['rm -rf build', 'cd x && rm -r node_modules', 'sudo make install', 'git push --force origin main', 'git -C . push',
    'git reset --hard HEAD~3', 'git clean -fdx', 'curl -fsSL https://x.sh | sh', 'wget -qO- x | sudo bash', 'chmod -R 777 .',
    'dd if=/dev/zero of=/dev/disk2', 'diskutil eraseDisk APFS X disk2', 'defaults write com.apple.dock x', 'launchctl unload x',
    'npm publish', 'docker push me/app', 'terraform destroy', 'psql -c "DROP TABLE users"', 'killall Finder', 'find . -name "*.log" -delete']) {
    assert.ok(bash(risky), risky);
  }
  for (const fine of ['npm test', 'git status', 'git commit -m "push the fix"', 'rm notes.txt', 'ls -la', 'echo digit push', 'git pull']) {
    assert.ok(!bash(fine), fine);
  }
  assert.ok(!bash('rm -rf build', 'deny'));  // a no is never held up
  assert.ok(bash('git push', 'always'));
  assert.ok(!ct.risky({ tool: 'Bash', detail: '$ rm -rf /' }, 'allow'));  // not an Eden Code step
  const edit = (question) => ct.risky({ task_id: 1, tool: 'Write', detail: 'x', question }, 'allow');
  assert.ok(edit('Eden Code in alpha wants to edit a file outside the project'));
  assert.ok(!edit('Eden Code in alpha wants to edit a file'));
  assert.ok(!ct.risky({ task_id: 1, tool: 'WebFetch', detail: 'https://x' }, 'allow'));
  assert.ok(!ct.risky(null, 'allow'));
  // Full auto asked for by voice: its card's tap asks for the fingerprint too.
  assert.ok(ct.risky({ tool: 'code_bypass_by_voice', question: 'Turn on Bypass permissions for alpha?' }, 'allow'));
  assert.ok(!ct.risky({ tool: 'code_bypass_by_voice' }, 'deny'));
});

// The risky commands and broad rules both sides share (features/code_touchid.py checks the same
// file): round 2's R2-8 (a program's folder or quotes, options in any order, interpreter
// one-liners that delete) and G3 (an allow rule that's Bypass for a kind of step).
test('the shared table: risky commands, and allow rules that are Bypass for a kind of step', () => {
  const table = JSON.parse(readFileSync(new URL('../fixtures/risky_commands.json', import.meta.url), 'utf8'));
  assert.deepEqual(table.risky.filter((c) => !ct.riskyCommand(c)), []);
  assert.deepEqual(table.fine.filter((c) => ct.riskyCommand(c)), []);
  assert.deepEqual(table.broad_rules.filter((r) => !ct.broadRule(r)), []);
  assert.deepEqual(table.narrow_rules.filter((r) => ct.broadRule(r)), []);
});

test('a Permissions pane change asks for the fingerprint only when it lets a lot more by', () => {
  const have = { deny: ['Bash(curl:*)'], ask: [], allow: [] };
  assert.ok(ct.loosensRules({ behavior: 'allow', rule: 'Bash', have }));
  assert.ok(ct.loosensRules({ behavior: 'allow', rule: 'Write(//**)', have }));
  assert.ok(!ct.loosensRules({ behavior: 'allow', rule: 'Bash(npm test)', have }));
  assert.ok(!ct.loosensRules({ behavior: 'deny', rule: 'Bash', have }));  // stricter: never held up
  assert.ok(ct.loosensRules({ behavior: 'deny', rule: 'Bash(curl:*)', have, removing: true }));
  assert.ok(ct.loosensRules({ behavior: 'ask', rule: 'Bash(curl:*)', have }));  // out of deny
  assert.ok(!ct.loosensRules({ behavior: 'ask', rule: 'Bash(x)', have, removing: true }));
  assert.ok(ct.loosensRules({ exporting: true, allows: 2 }));
  assert.ok(!ct.loosensRules({ exporting: true, allows: 0 }));
  assert.ok(REASONS.en.rules && REASONS.zh.rules);
});

test('the app asks with its own words, one sheet at a time, and never round a no', async () => {
  let answer = Promise.resolve();
  const asked = [];
  const prefs = { canPromptTouchID: () => true, promptTouchID: (reason) => { asked.push(reason); return answer; } };
  const h = handlers({ systemPreferences: prefs, secret: () => KEY });
  assert.equal((await h.prompt('bypass', 'en')).ok, true);
  assert.equal((await h.prompt('approve', 'zh')).ok, true);
  assert.deepEqual(asked, [REASONS.en.bypass, REASONS.zh.approve]);
  assert.deepEqual(await h.prompt('<b>whatever the page says</b>', 'en'), { ok: false, error: 'unknown' });
  answer = Promise.reject(new Error('cancelled'));
  answer.catch(() => {});
  assert.deepEqual(await h.prompt('bypass', 'en'), { ok: false, cancelled: true });
  let finish;
  answer = new Promise((resolve) => { finish = resolve; });
  const first = h.prompt('bypass', 'en');
  assert.deepEqual(await h.prompt('bypass', 'en'), { ok: false, busy: true });
  finish();
  assert.equal((await first).ok, true);
  const none = handlers({ systemPreferences: { canPromptTouchID: () => false }, secret: () => KEY });
  assert.deepEqual(await none.prompt('bypass', 'en'), { ok: false, unavailable: true });
  assert.equal(handlers({ systemPreferences: { canPromptTouchID: () => { throw new Error('x'); } } }).available(), false);
  for (const words of [...Object.values(REASONS.en), ...Object.values(REASONS.zh)]) assert.ok(!/electron/i.test(words));
});

test('only the window may ask', async () => {
  const on = {};
  const ctx = { ipcMain: { handle: (channel, fn) => { on[channel] = fn; } }, fromWindow: (event) => event === 'window' };
  install(ctx);
  assert.deepEqual(Object.keys(on).sort(), ['feature:touchid:available', 'feature:touchid:confirm', 'feature:touchid:prompt']);
  assert.deepEqual(await on['feature:touchid:confirm']('page', 'bypass', 'en'), { ok: false });
  assert.equal(on['feature:touchid:available']('page'), false);
  assert.deepEqual(await on['feature:touchid:prompt']('page', 'bypass', 'en'), { ok: false });
});

test('every string the Touch ID switch and question show has its Chinese', () => {
  const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n/code-touchid.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('../../src/jarvis/web/features/code-touchid.js', import.meta.url), 'utf8');
  const shown = [...source.matchAll(/el\('[a-z0-9]+', '[^']*', '([^']+)'\)/g)].map((m) => m[1]);
  const extra = ['Touch ID for Bypass and risky steps', 'This step can’t easily be undone, or reaches past this Mac. Allow it?',
    'This rule lets Eden Code do much more without asking you. Change it?'];
  assert.deepEqual([...shown, ...extra].filter((s) => !(s in zh.strings)), []);
});

test('a yes gives the window a proof the backend can check, signed in the main process under the proof key (S30, A1)', async () => {
  const prefs = { canPromptTouchID: () => true, promptTouchID: async () => {} };
  const token = 'ab'.repeat(24);
  const got = await handlers({ systemPreferences: prefs, secret: () => token }).prompt('bypass', 'en', '7');
  assert.equal(got.ok, true);
  const [v, kind, subject, expires, nonce, mac] = got.proof.split('.');
  assert.deepEqual([v, kind, subject], ['v2', 'bypass', '7']);
  assert.ok(Number(expires) > Date.now() && Number(expires) <= Date.now() + 2 * 60 * 1000 + 50);
  assert.match(nonce, /^[0-9a-f]{32}$/);
  const crypto = await import('node:crypto');
  assert.equal(mac, crypto.createHmac('sha256', token).update(`eden-touchid|v2|bypass|7|${expires}|${nonce}`).digest('hex'));
  const fixed = await import('node:module').then(({ createRequire: r }) => r(import.meta.url)('../../app/features/touchid.js'));
  assert.equal(fixed.makeProof('', 'bypass'), '', 'no key: no proof');
  const no = { canPromptTouchID: () => true, promptTouchID: async () => { throw new Error('cancelled'); } };
  assert.equal((await handlers({ systemPreferences: no, secret: () => token }).prompt('bypass', 'en')).proof, undefined, 'a no gives none');
  // The key is this app's own, given to its backend on stdin: never the token the page has.
  const main = readFileSync(new URL('../../app/main.js', import.meta.url), 'utf8');
  assert.match(main, /proofKey: \(\) => PROOF_KEY,/);
  assert.doesNotMatch(main, /backendToken/);
  assert.doesNotMatch(main, /PROOF_KEY[^\n]*(loadURL|advertise)|(loadURL|advertise)[^\n]*PROOF_KEY/);
});

test('without Touch ID the app asks with its own dialog, and signs that yes the same way (S30)', async () => {
  const token = 'ab'.repeat(24);
  const asked = [];
  let response = 0;
  const dialog = { showMessageBox: async (...args) => { asked.push(args.at(-1)); return { response }; } };
  const none = { canPromptTouchID: () => false };
  const h = handlers({ systemPreferences: none, secret: () => token, dialog });
  const got = await h.confirm('bypass', 'en');
  assert.equal(got.ok, true);
  assert.match(got.proof, /^v2\.bypass\.\.\d{13}\.[0-9a-f]{32}\.[0-9a-f]{64}$/);
  assert.match((await h.confirm('approve', 'en', 'a1')).proof, /^v2\.approve\.a1\.\d{13}\./, 'its card');
  asked.pop();
  assert.equal(asked[0].message, 'Turn on Bypass permissions in Eden Code?', 'the app’s own words');
  assert.equal(asked[0].cancelId, 1);
  assert.equal(asked[0].defaultId, 1, 'Cancel is the default: Return never allows it');
  await h.confirm('approve', 'zh');
  assert.ok(asked[1].message.startsWith(REASONS.zh.approve));
  response = 1;
  assert.deepEqual(await h.confirm('bypass', 'en'), { ok: false, cancelled: true });
  assert.deepEqual(await h.confirm('<b>the page’s words</b>', 'en'), { ok: false, error: 'unknown' });
  const touch = handlers({ systemPreferences: { canPromptTouchID: () => true }, secret: () => token, dialog });
  assert.deepEqual(await touch.confirm('bypass', 'en'), { ok: false, unsupported: true }, 'Touch ID asks then');
  assert.deepEqual(await handlers({ systemPreferences: none, secret: () => token }).confirm('bypass', 'en'), { ok: false, unsupported: true });
});

test('the window sends the signed yes to the backend just before what it is for', async () => {
  const source = readFileSync(new URL('../../src/jarvis/web/features/code-touchid.js', import.meta.url), 'utf8');
  const sent = [];
  let check = null;
  const answers = { 'feature:touchid:available': false, 'feature:touchid:confirm': { ok: true, proof: 'v1.bypass.1.a.b' } };
  const window = {
    jarvisFeatures: { el: () => ({ append() {}, setAttribute() {}, addEventListener() {} }), t: (x) => x, send: (m) => { sent.push(m); return true; }, on: () => {}, registerCheck: (fn) => { check = fn; } },
    jarvisApp: { feature: { invoke: async (channel) => answers[channel] } },
    jarvisI18n: { lang: () => 'en' },
    confirm: () => { throw new Error('the page’s own question is never the gate inside the app'); },
  };
  const document = { getElementById: () => null };
  new Function('window', 'document', source.replace(/typeof window === 'object' \? window : globalThis/, 'window'))(window, document);
  assert.equal(await check('bypass', { text: 'Switch?' }), true);
  assert.deepEqual(sent, [{ type: 'code_touchid_proof', kind: 'bypass', proof: 'v1.bypass.1.a.b' }]);
  answers['feature:touchid:confirm'] = { ok: false, cancelled: true };
  assert.equal(await check('bypass', { text: 'Switch?' }), false);
  assert.equal(sent.length, 1, 'a no sends nothing');
});

// ── round 1 A1: the proof key is the app's own, on the backend's stdin (app/proof-pipe.js) ──

const pipe = require('../../app/proof-pipe.js');
const { EventEmitter } = require('node:events');

function fakeChild() {
  const written = [];
  const child = { stdout: new EventEmitter(), stdin: new EventEmitter() };
  child.stdin.writable = true;
  child.stdin.write = (line) => { written.push(line); return true; };
  return { child, written };
}

test('the key goes to the backend it started on its stdin, and asks with its tag are answered there', async () => {
  const keys = pipe.fresh();
  assert.match(keys.key, /^[0-9a-f]{64}$/);
  assert.match(keys.tag, /^[0-9a-f]{32}$/);
  assert.notEqual(pipe.fresh().key, keys.key);
  const { child, written } = fakeChild();
  const asked = [];
  const h = handlers({ systemPreferences: { canPromptTouchID: () => true, promptTouchID: async (r) => { asked.push(r); } }, secret: () => keys.key });
  pipe.attach(child, keys, (kind, lang, subject) => h.ask(kind, lang, subject));
  assert.deepEqual(written, [`${keys.key} ${keys.tag}\n`], 'the first line: key and tag');
  // An ask comes split across chunks; one without this backend's tag (a child's stray output) is no ask.
  child.stdout.emit('data', Buffer.from(`log line\n${'0'.repeat(32)} ask bypass en\n${keys.tag} ask by`));
  child.stdout.emit('data', Buffer.from('pass zh\n'));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(asked, [REASONS.zh.bypass]);
  const [, kind, proof] = written[1].trim().split(' ');
  assert.equal(kind, 'bypass');
  const [, , subject, expires, nonce, mac] = proof.split('.');
  assert.equal(subject, '', 'an ask that names nothing is signed for nothing');
  const crypto = await import('node:crypto');
  assert.equal(mac, crypto.createHmac('sha256', keys.key).update(`eden-touchid|v2|bypass||${expires}|${nonce}`).digest('hex'));
  // An ask that names its card (R2-12) is signed for that card.
  child.stdout.emit('data', Buffer.from(`${keys.tag} ask approve en c0ffee12ab34\n`));
  await new Promise((r) => setTimeout(r, 10));
  const [, kind2, proof2] = written[2].trim().split(' ');
  assert.equal(kind2, 'approve');
  assert.equal(proof2.split('.')[2], 'c0ffee12ab34');
  assert.equal(pipe.answer('bypass', ''), 'no bypass\n');
  assert.equal(pipe.answer('bypass', 'a b'), 'no bypass\n', 'never a line of its own');
  assert.equal(pipe.answer('<x>', 'p'), '');
  // main.js: the environment carries only that there is a pipe; the key goes on stdin.
  const main = readFileSync(new URL('../../app/main.js', import.meta.url), 'utf8');
  assert.match(main, /how\.env\[proofPipe\.ENV\] = proofPipe\.ENV_VALUE;/);
  assert.match(main, /stdio: proofPipe\.STDIO/);
  assert.match(main, /proofPipe\.attach\(backend, keys,/);
  const eden = readFileSync(new URL('../../app/eden/main.js', import.meta.url), 'utf8');
  assert.match(eden, /how\.env\[proofPipe\.ENV\] = proofPipe\.ENV_VALUE;/);
  assert.match(eden, /stdio: proofPipe\.STDIO/);
});

// Round 2 R2-16: the asks come on the backend's fd 3, a pipe of their own, so the log (its
// stdout and stderr) never has the tag; Windows keeps stdout (fd 3 can't go to a non-Node child).
test('the asks come on a pipe of their own, never the stdout that goes to the log', async () => {
  if (process.platform !== 'win32') {
    assert.equal(pipe.ENV_VALUE, '3');
    assert.deepEqual(pipe.STDIO, ['pipe', 'pipe', 'pipe', 'pipe']);
  }
  const keys = pipe.fresh();
  const { child, written } = fakeChild();
  child.stdio = [child.stdin, child.stdout, new EventEmitter(), new EventEmitter()];
  pipe.attach(child, keys, async () => 'v1.bypass.1.2.3');
  child.stdout.emit('data', Buffer.from(`${keys.tag} ask bypass en\n`));  // (stdout: not an ask now)
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(written.length, 1, 'only the hello');
  child.stdio[3].emit('data', Buffer.from(`${keys.tag} ask bypass en\n`));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(written.slice(1), ['proof bypass v1.bypass.1.2.3\n']);
});

test('without a key of its own (the other app’s backend) the app shows no sheet: the window asks through the backend', async () => {
  let shown = 0;
  const h = handlers({ systemPreferences: { canPromptTouchID: () => true, promptTouchID: async () => { shown += 1; } }, secret: () => '' });
  assert.deepEqual(await h.prompt('bypass', 'en'), { ok: false, relay: true });
  assert.deepEqual(await h.confirm('bypass', 'en'), { ok: false, relay: true });
  assert.equal(shown, 0);
  const on = {};
  let asker = null;
  install({ ipcMain: { handle: (channel, fn) => { on[channel] = fn; } }, fromWindow: () => true, onProofAsk: (fn) => { asker = fn; } });
  assert.equal(typeof asker, 'function', 'the app that started the backend answers its asks');
});

function windowWith(answers) {
  const source = readFileSync(new URL('../../src/jarvis/web/features/code-touchid.js', import.meta.url), 'utf8');
  const sent = [];
  const listeners = {};
  let check = null;
  let click = null;
  const node = () => ({ append() {}, setAttribute() {}, removeAttribute() {}, addEventListener(type, fn) { if (type === 'click') click = fn; } });
  const window = {
    jarvisFeatures: { el: node, t: (x) => x, send: (m) => { sent.push(m); return true; }, on: (type, fn) => { listeners[type] = fn; }, registerCheck: (fn) => { check = fn; } },
    jarvisApp: { feature: { invoke: async (channel) => answers[channel] } },
    jarvisI18n: { lang: () => 'en' },
    confirm: () => { throw new Error('not inside the app'); },
  };
  const general = { querySelector: () => null, append() {}, insertBefore() {} };
  const document = { getElementById: (id) => (id === 'jcs-general' ? general : null), createTextNode: () => ({}) };
  new Function('window', 'document', 'setTimeout', 'clearTimeout', source.replace(/typeof window === 'object' \? window : globalThis/, 'window'))(window, document, setTimeout, clearTimeout);
  return { sent, listeners, check: (...a) => check(...a), click: () => click() };
}

test('the window asks the backend for the other app’s sheet, and goes ahead on its answer', async () => {
  const w = windowWith({ 'feature:touchid:available': true, 'feature:touchid:prompt': { ok: false, relay: true } });
  const going = w.check('bypass', { text: 'Switch?', subject: '7' });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(w.sent, [{ type: 'code_touchid_ask', kind: 'bypass', lang: 'en', subject: '7' }]);
  w.listeners.code_touchid_answer({ proof_kind: 'approve', ok: true });  // (another kind's: not this one's)
  w.listeners.code_touchid_answer({ proof_kind: 'bypass', ok: true });
  assert.equal(await going, true);
  const no = w.check('bypass', { text: 'Switch?' });
  await new Promise((r) => setTimeout(r, 0));
  w.listeners.code_touchid_answer({ proof_kind: 'bypass', ok: false });
  assert.equal(await no, false);
});

test('turning the Touch ID switch off asks for the fingerprint first (A3)', async () => {
  const w = windowWith({ 'feature:touchid:available': true, 'feature:touchid:prompt': { ok: true, proof: 'v1.touchid-off.1.a.b' } });
  w.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(w.sent, [
    { type: 'code_touchid_proof', kind: 'touchid-off', proof: 'v1.touchid-off.1.a.b' },
    { type: 'feature_prefs', changes: { code_touchid: false } },
  ]);
  const n = windowWith({ 'feature:touchid:available': true, 'feature:touchid:prompt': { ok: false, cancelled: true } });
  n.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(n.sent, [], 'a no leaves it on');
  assert.ok(REASONS.en['touchid-off'] && REASONS.zh['touchid-off']);
});

// Round 2 U12: the switch in Eden Code settings › General, in a stand-in window: a second
// press while the fingerprint is asked for asks nothing more, and the switch says it's busy.
test('the Touch ID switch asks once at a time and is busy while it asks', async () => {
  const fs = await import('node:fs');
  const vm = await import('node:vm');
  const source = fs.readFileSync(new URL('../../src/jarvis/web/features/code-touchid.js', import.meta.url), 'utf8');
  const node = () => ({
    attrs: {}, listeners: {}, disabled: false, children: [],
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null },
    removeAttribute(k) { delete this.attrs[k]; }, addEventListener(type, fn) { this.listeners[type] = fn; },
    append(...xs) { this.children.push(...xs); }, insertBefore() {}, querySelector: () => null,
    click() { this.listeners.click && this.listeners.click(); },
  });
  const made = [];
  const sent = [];
  const F = {
    el: () => { const n = node(); made.push(n); return n; }, t: (s) => s, send: (m) => { sent.push(m); return true; },
    registerCheck() {}, on() {},
  };
  const general = node();
  const document = { getElementById: (id) => (id === 'jcs-general' ? general : null), createTextNode: (s) => s };
  let finish;
  const asked = [];
  const feature = {
    invoke: (channel, kind) => {
      asked.push([channel, kind]);
      if (channel === 'feature:touchid:available') return Promise.resolve(true);
      return new Promise((resolve) => { finish = () => resolve({ ok: true, proof: 'v1.touchid-off.1.2.3' }); });
    },
  };
  vm.runInNewContext(source, { window: { jarvisFeatures: F, jarvisApp: { feature }, confirm: () => false }, document });
  const sw = made.find((n) => n.attrs.role === 'switch');
  sw.click();
  await new Promise((r) => setTimeout(r, 5));
  sw.click();  // a second press while the sheet is up
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(asked.filter(([c]) => c === 'feature:touchid:prompt').length, 1, 'asked once');
  assert.equal(sw.getAttribute('aria-busy'), 'true');
  // Round 3, U3-8: never disabled while it asks (a disabled button drops the focus to the page,
  // Electron 44): aria-disabled says it, and the press does nothing.
  assert.equal(sw.disabled, false, 'disabled: the focus would fall to the page');
  assert.equal(sw.getAttribute('aria-disabled'), 'true');
  finish();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sw.getAttribute('aria-busy'), null);
  assert.equal(sw.getAttribute('aria-disabled'), null);
  assert.equal(sw.disabled, false);
  assert.deepEqual(sent.map((m) => m.type), ['code_touchid_proof', 'feature_prefs']);
});

// Round 3, R2-12: what a yes is for goes into its proof, so it's good for that one card or
// session only: a risky step's names its card, Bypass its session ('new' for one to start).
test('a proof names the card or session its yes is for', async () => {
  const ct = await import('node:module').then(({ createRequire: r }) => r(import.meta.url)('../../src/jarvis/web/features/code-touchid.js'));
  assert.equal(ct.subject('approve', { approval: { id: 'c0ffee12ab34' }, choice: 'allow' }), 'c0ffee12ab34');
  assert.equal(ct.subject('bypass', { text: 'Switch?', subject: '7' }), '7');
  assert.equal(ct.subject('bypass', { text: 'Switch?', subject: 'new' }), 'new');
  assert.equal(ct.subject('bypass-default', { subject: '7' }), '', 'a kind with no one thing to name');
  assert.equal(ct.subject('approve', { approval: { id: 'a.b c' } }), '', 'never a subject that could break the proof');
  const t = await import('node:module').then(({ createRequire: r }) => r(import.meta.url)('../../app/features/touchid.js'));
  assert.equal(t.makeProof('k', 'approve', { subject: 'x.y' }), '', 'a subject that isn\'t one: no proof');
  const a = t.makeProof('k', 'approve', { subject: 'a1', now: 1, nonce: '0'.repeat(32) });
  const b = t.makeProof('k', 'approve', { subject: 'a2', now: 1, nonce: '0'.repeat(32) });
  assert.notEqual(a.split('.').pop(), b.split('.').pop(), 'the subject is under the mac');
  // The window names it: app.js passes the session (or 'new') to confirmBypass.
  const app = readFileSync(new URL('../../src/jarvis/web/app.js', import.meta.url), 'utf8');
  assert.match(app, /confirmBypass\('bypass', [^\n]*, go, null, target !== null \? target : 'new'\)/);
  assert.match(app, /confirmBypass\('bypass', [^\n]*, start, null, 'new'\)/);
});
