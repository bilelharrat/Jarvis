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
});

test('the app asks with its own words, one sheet at a time, and never round a no', async () => {
  let answer = Promise.resolve();
  const asked = [];
  const prefs = { canPromptTouchID: () => true, promptTouchID: (reason) => { asked.push(reason); return answer; } };
  const h = handlers({ systemPreferences: prefs });
  assert.deepEqual(await h.prompt('bypass', 'en'), { ok: true });
  assert.deepEqual(await h.prompt('approve', 'zh'), { ok: true });
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
  assert.deepEqual(await first, { ok: true });
  const none = handlers({ systemPreferences: { canPromptTouchID: () => false } });
  assert.deepEqual(await none.prompt('bypass', 'en'), { ok: false, unavailable: true });
  assert.equal(handlers({ systemPreferences: { canPromptTouchID: () => { throw new Error('x'); } } }).available(), false);
  for (const words of [...Object.values(REASONS.en), ...Object.values(REASONS.zh)]) assert.ok(!/electron/i.test(words));
});

test('only the window may ask', async () => {
  const on = {};
  const ctx = { ipcMain: { handle: (channel, fn) => { on[channel] = fn; } }, fromWindow: (event) => event === 'window' };
  install(ctx);
  assert.deepEqual(Object.keys(on).sort(), ['feature:touchid:available', 'feature:touchid:prompt']);
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

test('a yes comes with a proof only the app can sign, and a Mac without Touch ID asks with its own dialog', async () => {
  const { signer, PROVED } = require('../../app/features/touchid.js');
  const crypto = require('crypto');
  const key = 'ab'.repeat(32);
  const files = {};
  const sign = signer('/data', { readFile: (p) => { if (!(p in files)) throw new Error('none'); return files[p]; }, now: () => 1_700_000_000_000, random: () => Buffer.alloc(16, 7) });
  assert.equal(sign('bypass'), null);  // no key yet: no proof (the backend refuses then)
  files['/data/touchid.key'] = `${key}\n`;
  const proof = sign('bypass');
  const nonce = '07'.repeat(16);
  assert.deepEqual(proof, { kind: 'bypass', ts: 1_700_000_000, nonce, sig: crypto.createHmac('sha256', Buffer.from(key)).update(`bypass|1700000000|${nonce}`).digest('hex') });
  assert.equal(sign('approve'), null);  // (only what the backend checks)
  assert.deepEqual([...PROVED].sort(), ['bypass', 'bypass-default', 'sandbox-off', 'touchid-off']);
  for (const kind of PROVED) assert.ok(REASONS.en[kind] && REASONS.zh[kind], kind);

  const touch = handlers({ systemPreferences: { canPromptTouchID: () => true, promptTouchID: async () => {} }, sign });
  assert.deepEqual(await touch.prompt('bypass', 'en'), { ok: true, proof: sign('bypass') });
  const asked = [];
  let answer = true;
  const dialog = handlers({ systemPreferences: { canPromptTouchID: () => false }, sign, confirm: async (reason) => { asked.push(reason); return answer; } });
  assert.equal((await dialog.prompt('touchid-off', 'en')).ok, true);
  answer = false;
  assert.deepEqual(await dialog.prompt('bypass', 'en'), { ok: false, cancelled: true });
  assert.deepEqual(asked, [REASONS.en['touchid-off'], REASONS.en.bypass]);
});

test('every string the Touch ID refusals show has its Chinese', () => {
  const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n/code-touchid.json', import.meta.url), 'utf8'));
  const py = readFileSync(new URL('../../src/jarvis/features/code_touchid.py', import.meta.url), 'utf8');
  const said = [...py.matchAll(/^\s+"[a-z-]+": "([^"]+)",$/gm)].map((m) => m[1]);
  assert.equal(said.length, 4);
  for (const text of [...said, 'Turn off Touch ID for Bypass and risky steps?']) assert.ok(text in zh.strings, text);
});
