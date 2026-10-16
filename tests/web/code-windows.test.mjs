// Eden Code on Windows (item 49), checked on a Mac: the "On this PC" list (web/features/
// code-windows.js), Windows Hello in the app's Touch ID handlers (app/features/touchid.js:
// a fake PowerShell, never a real one), and the Rules pane's sandbox line where there's no
// sandbox (web/features/code-rules.js). node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const cw = require('../../src/jarvis/web/features/code-windows.js');
const { handlers, helloAnswer, windowsHello, windowsPowerShell, HELLO_SCRIPT } = require('../../app/features/touchid.js');
const { sandboxLine } = require('../../src/jarvis/web/features/code-rules.js');

const KEY = '5e'.repeat(32);

test('the On this PC list shows on Windows only, each row with its state and why', () => {
  const ev = {
    os: 'windows',
    features: [
      { id: 'sandbox', name: 'Sandbox for Bypass and unattended sessions', state: 'mac', why: 'No sandbox.' },
      { id: 'touchid', name: 'Touch ID', state: 'another', why: 'Windows Hello.' },
      { id: 'odd', name: 'Odd', state: 'unknown', why: 'x' },  // a state it doesn't know: left out
      null,
    ],
  };
  const rows = cw.rows(ev);
  assert.deepEqual(rows.map((r) => [r.id, r.label]), [['sandbox', 'Mac only'], ['touchid', 'Works another way']]);
  assert.equal(rows[0].why, 'No sandbox.');
  assert.deepEqual(cw.rows({ os: 'mac', features: ev.features }), []);
  assert.deepEqual(cw.rows(null), []);
});

test('what Windows Hello said, in the handlers\' words', () => {
  assert.equal(helloAnswer('result:Verified\r\n'), 'ok');
  assert.equal(helloAnswer('noise\r\nresult:Canceled'), 'cancelled');
  assert.equal(helloAnswer('result:RetriesExhausted'), 'cancelled');
  for (const absent of ['result:DeviceNotPresent', 'result:NotConfiguredForUser', 'result:DisabledByPolicy',
    'unavailable:NotConfiguredForUser', 'unavailable:error', '', 'garbage']) {
    assert.equal(helloAnswer(absent), 'unavailable', absent);
  }
});

test('Windows Hello runs System32\'s Windows PowerShell with the reason in its environment', async () => {
  assert.equal(windowsPowerShell({ SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.match(HELLO_SCRIPT, /UserConsentVerifier/);
  assert.doesNotMatch(HELLO_SCRIPT, /turn on Bypass/);  // (the reason is never in the script)
  const calls = [];
  const execFile = (file, args, opts, done) => { calls.push({ file, args, opts }); done(null, 'result:Verified\r\n'); };
  const hello = windowsHello({ execFile, env: { SystemRoot: 'D:\\Win' } });
  assert.equal(hello.available, true);
  assert.equal(await hello.verify('turn on Bypass permissions in Eden Code'), 'ok');
  const [{ file, args, opts }] = calls;
  assert.equal(file, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(args.slice(0, 5), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
  assert.equal(opts.env.EDEN_HELLO_REASON, 'Eden Code: turn on Bypass permissions in Eden Code');
  assert.ok(opts.windowsHide && opts.timeout > 0);
  // Not set up: said once, and from then on it isn't offered.
  const absent = windowsHello({ execFile: (f, a, o, done) => done(null, 'unavailable:NotConfiguredForUser'), env: {} });
  assert.equal(await absent.verify('x'), 'unavailable');
  assert.equal(absent.available, false);
  // Timed out (killed): a no, never a yes.
  const slow = windowsHello({ execFile: (f, a, o, done) => done(Object.assign(new Error('t'), { killed: true }), ''), env: {} });
  assert.equal(await slow.verify('x'), 'cancelled');
});

function fakeHello(said) {
  const asked = [];
  return { asked, available: true, verify: async (reason) => { asked.push(reason); return said; } };
}
const noTouchId = { canPromptTouchID: () => false, promptTouchID: async () => { throw new Error('no'); } };

test('on Windows a yes from Windows Hello is signed as Touch ID\'s is', async () => {
  const hello = fakeHello('ok');
  const h = handlers({ systemPreferences: noTouchId, secret: () => KEY, hello });
  assert.equal(h.available(), true);
  const got = await h.prompt('bypass', 'en', '12');
  assert.ok(got.ok && got.proof.startsWith('v2.bypass.12.'));
  assert.deepEqual(hello.asked, ['turn on Bypass permissions in Eden Code']);  // the app's own words
  assert.deepEqual(await h.confirm('bypass', 'en'), { ok: false, unsupported: true });  // (Hello asks)
  const no = handlers({ systemPreferences: noTouchId, secret: () => KEY, hello: fakeHello('cancelled') });
  assert.deepEqual(await no.prompt('approve', 'en', 'a1'), { ok: false, cancelled: true });
});

test('on Windows without Windows Hello set up, the app\'s own dialog asks and its yes is signed', async () => {
  const shown = [];
  const dialog = { showMessageBox: async (opts) => { shown.push(opts); return { response: 0 }; } };
  const h = handlers({ systemPreferences: {}, secret: () => KEY, dialog, hello: fakeHello('unavailable') });
  const got = await h.prompt('approve', 'zh', 'card-7');
  assert.ok(got.ok && got.proof.startsWith('v2.approve.card-7.'));
  assert.equal(shown.length, 1);
  assert.match(shown[0].message, /允许 Eden Code 中一个有风险的步骤/);
  const cancel = { showMessageBox: async () => ({ response: 1 }) };
  const no = handlers({ systemPreferences: {}, secret: () => KEY, dialog: cancel, hello: fakeHello('unavailable') });
  assert.deepEqual(await no.prompt('approve', 'en', 'x'), { ok: false, cancelled: true });
  // No key (the other app's backend): relayed, as on a Mac; Hello isn't asked.
  const relay = fakeHello('ok');
  assert.deepEqual(await handlers({ systemPreferences: {}, hello: relay }).prompt('bypass', 'en'), { ok: false, relay: true });
  assert.deepEqual(relay.asked, []);
});

test('the Rules pane says there is no sandbox on Windows, and what that means', () => {
  const base = { available: false, why: 'x', live: false };
  assert.match(sandboxLine({ ...base, on: true }), /no sandbox on Windows, so each of its commands asks you first/);
  assert.match(sandboxLine({ ...base, on: false }), /as its mode lets them/);
  assert.equal(sandboxLine({ on: true, live: true }), 'Its commands run in the sandbox.');  // a Mac's, as before
});
