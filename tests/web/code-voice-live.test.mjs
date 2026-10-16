// Eden's voice in Eden Code, the window's side (web/features/code-voice-live.js): the Voice
// switch's live state and words, hold right ⌥ to talk, and the microphone's answer.
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const cv = require('../../src/jarvis/web/features/code-voice-live.js');

test('the switch shows what Eden is doing while its ears are on', () => {
  const on = { active: true, listening: true };
  assert.equal(cv.voiceState(null, 'idle', null), 'off');
  assert.equal(cv.voiceState({ active: false }, 'speaking', null), 'off'); // Eden Secretary speaking: not Eden Code's
  assert.equal(cv.voiceState(on, 'idle', null), 'listening'); // hands-free: always hearing
  assert.equal(cv.voiceState({ active: true, listening: false }, 'idle', null), 'ready'); // push-to-talk only
  assert.equal(cv.voiceState(on, 'transcribing', null), 'listening');
  assert.equal(cv.voiceState(on, 'thinking', null), 'thinking');
  assert.equal(cv.voiceState(on, 'idle', { busy: true }), 'thinking'); // the session works
  assert.equal(cv.voiceState(on, 'speaking', { busy: true }), 'speaking');
});

test('its words name the state and the session, and say how to talk', () => {
  assert.equal(cv.pillLabel('off', 'proj'), 'Voice off');
  assert.equal(cv.pillLabel('listening', 'proj'), 'Listening · proj');
  assert.equal(cv.pillLabel('speaking', ''), 'Speaking');
  assert.equal(cv.pillHelp('off', null), 'Turn on Eden’s voice in Eden Code');
  assert.match(cv.pillHelp('listening', { hands_free: true, wake: false }), /^Listening\. Just talk, or hold right ⌥\./);
  assert.match(cv.pillHelp('listening', { hands_free: true, wake: true }), /Say “Eden” and talk/);
  assert.match(cv.pillHelp('ready', { hands_free: false }), /^Voice\. Hold right ⌥ to talk\. Click to turn/);
});

function fakeTimers() {
  const pending = new Map();
  let n = 0;
  return {
    schedule: (fn) => { n += 1; pending.set(n, fn); return n; },
    cancel: (id) => pending.delete(id),
    fire: () => { for (const [id, fn] of [...pending]) { pending.delete(id); fn(); } },
    get count() { return pending.size; },
  };
}
const key = (code, extra = {}) => ({ code, key: code.startsWith('Alt') ? 'Alt' : code, ...extra });

test('holding right ⌥ opens the microphone and letting go sends what was said', () => {
  const sent = [];
  const timers = fakeTimers();
  const ptt = cv.createPtt({ send: (m) => sent.push(m), ...timers });
  assert.equal(ptt.keyDown(key('AltRight')), true);
  assert.deepEqual(sent, []); // not yet: a quick tap or a chord isn't talk
  ptt.keyDown(key('AltRight', { repeat: true })); // the key's repeats change nothing
  assert.equal(timers.count, 1);
  timers.fire();
  assert.deepEqual(sent, [{ down: true }]);
  assert.equal(ptt.keyUp(key('AltRight')), true);
  assert.deepEqual(sent, [{ down: true }, { down: false }]);
  assert.equal(ptt.open, false);
});

test('⌥ used for a character, a tap, the left ⌥ or a shortcut never records', () => {
  const sent = [];
  const timers = fakeTimers();
  const ptt = cv.createPtt({ send: (m) => sent.push(m), ...timers });
  ptt.keyDown(key('AltRight'));
  ptt.keyDown(key('KeyE')); // ⌥E: an accent, typed
  timers.fire();
  ptt.keyUp(key('AltRight'));
  ptt.keyDown(key('AltRight'));
  ptt.keyUp(key('AltRight')); // a tap, let go before the hold
  timers.fire();
  assert.equal(ptt.keyDown(key('AltLeft')), false);
  assert.equal(ptt.keyDown(key('AltRight', { metaKey: true })), false); // ⌘⌥…
  timers.fire();
  assert.deepEqual(sent, []);
});

test('a chord after the microphone opened, or the window losing focus, closes it', () => {
  const sent = [];
  const timers = fakeTimers();
  const ptt = cv.createPtt({ send: (m) => sent.push(m), ...timers });
  ptt.keyDown(key('AltRight'));
  timers.fire();
  ptt.keyDown(key('KeyV'));
  assert.deepEqual(sent, [{ down: true }, { down: false }]);
  ptt.keyDown(key('AltRight'));
  timers.fire();
  ptt.blur();
  assert.deepEqual(sent.at(-1), { down: false });
  assert.equal(ptt.keyUp(key('AltRight')), false); // already closed
});

test('the app’s microphone answers that let Eden listen', () => {
  assert.equal(cv.micAllowed('granted'), true);
  assert.equal(cv.micAllowed('not-determined'), true); // still unanswered: the backend's own asking applies
  assert.equal(cv.micAllowed(undefined), true); // a browser tab: nothing to ask
  assert.equal(cv.micAllowed('denied'), false);
  assert.equal(cv.micAllowed('restricted'), false);
});

test('the composer is left alone, and the indicator has a reduced-motion rule', () => {
  const js = readFileSync(new URL('../../src/jarvis/web/features/code-voice-live.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../../src/jarvis/web/features/code-voice-live.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /jc-composer|jc-dock|jc-dictate/);
  assert.doesNotMatch(js, /jc-composer|jc-dock|classList\.(add|remove|toggle)\([^)]*jc-dictate/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('Eden Code’s app asks for the microphone on demand and declares why', () => {
  const main = readFileSync(new URL('../../app/main.js', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('../../app/preload.js', import.meta.url), 'utf8');
  const plist = readFileSync(new URL('../../app/build/eden-code/extend-info.plist', import.meta.url), 'utf8');
  const ents = readFileSync(new URL('../../app/build/entitlements/app.plist', import.meta.url), 'utf8');
  assert.match(main, /ipcMain\.handle\('jarvis:microphone'/);
  assert.match(preload, /microphone: \(\) => ipcRenderer\.invoke\('jarvis:microphone'\)/);
  assert.match(plist, /NSMicrophoneUsageDescription/);
  assert.match(ents, /com\.apple\.security\.device\.audio-input/);
});
