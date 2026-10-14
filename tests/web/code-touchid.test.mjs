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
  const extra = ['Touch ID for Bypass and risky steps', 'This step can’t easily be undone, or reaches past this Mac. Allow it?'];
  assert.deepEqual([...shown, ...extra].filter((s) => !(s in zh.strings)), []);
});

test('a yes gives the window a proof the backend can check, signed in the main process under the proof key (S30, A1)', async () => {
  const prefs = { canPromptTouchID: () => true, promptTouchID: async () => {} };
  const token = 'ab'.repeat(24);
  const got = await handlers({ systemPreferences: prefs, secret: () => token }).prompt('bypass', 'en');
  assert.equal(got.ok, true);
  const [v, kind, expires, nonce, mac] = got.proof.split('.');
  assert.deepEqual([v, kind], ['v1', 'bypass']);
  assert.ok(Number(expires) > Date.now() && Number(expires) <= Date.now() + 2 * 60 * 1000 + 50);
  assert.match(nonce, /^[0-9a-f]{32}$/);
  const crypto = await import('node:crypto');
  assert.equal(mac, crypto.createHmac('sha256', token).update(`eden-touchid|v1|bypass|${expires}|${nonce}`).digest('hex'));
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
  assert.match(got.proof, /^v1\.bypass\.\d{13}\.[0-9a-f]{32}\.[0-9a-f]{64}$/);
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
  pipe.attach(child, keys, (kind, lang) => h.ask(kind, lang));
  assert.deepEqual(written, [`${keys.key} ${keys.tag}\n`], 'the first line: key and tag');
  // An ask comes split across chunks; one without this backend's tag (a child's stray output) is no ask.
  child.stdout.emit('data', Buffer.from(`log line\n${'0'.repeat(32)} ask bypass en\n${keys.tag} ask by`));
  child.stdout.emit('data', Buffer.from('pass zh\n'));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(asked, [REASONS.zh.bypass]);
  const [, kind, proof] = written[1].trim().split(' ');
  assert.equal(kind, 'bypass');
  const [, , expires, nonce, mac] = proof.split('.');
  const crypto = await import('node:crypto');
  assert.equal(mac, crypto.createHmac('sha256', keys.key).update(`eden-touchid|v1|bypass|${expires}|${nonce}`).digest('hex'));
  assert.equal(pipe.answer('bypass', ''), 'no bypass\n');
  assert.equal(pipe.answer('bypass', 'a b'), 'no bypass\n', 'never a line of its own');
  assert.equal(pipe.answer('<x>', 'p'), '');
  // main.js: the environment carries only that there is a pipe; the key goes on stdin.
  const main = readFileSync(new URL('../../app/main.js', import.meta.url), 'utf8');
  assert.match(main, /how\.env\[proofPipe\.ENV\] = '1';/);
  assert.match(main, /stdio: \['pipe', 'pipe', 'pipe'\]/);
  assert.match(main, /proofPipe\.attach\(backend, keys,/);
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
  const node = () => ({ append() {}, setAttribute() {}, addEventListener(type, fn) { if (type === 'click') click = fn; } });
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
  const going = w.check('bypass', { text: 'Switch?' });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(w.sent, [{ type: 'code_touchid_ask', kind: 'bypass', lang: 'en' }]);
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
