// The proactive feature's window helpers (src/jarvis/web/features/proactive.js), run
// without a page: the script sets window.jarvisProactive and stops where the page begins.
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../../src/jarvis/web/features/proactive.js', import.meta.url), 'utf8');
const window = {};
new Function('window', source)(window);
const P = window.jarvisProactive;

test('two time boxes make a range only when both are times', () => {
  assert.equal(P.range('23:30', '09:00'), '23:30-09:00');
  assert.equal(P.range('23:30', ''), '');
  assert.equal(P.range('9:00', '10:00'), '');
  assert.equal(P.range('24:00', '10:00'), '');
});

test('a pause shows only while it lasts', () => {
  const now = Date.UTC(2026, 8, 29, 14, 0);
  assert.equal(P.pausedUntil({ shell_pause_until: now / 1000 + 600 }, now), now / 1000 + 600);
  assert.equal(P.pausedUntil({ shell_pause_until: now / 1000 - 1 }, now), 0);
  assert.equal(P.pausedUntil({}, now), 0);
  assert.equal(P.pausedUntil(null, now), 0);
  assert.equal(P.pausedUntil({ shell_pause_until: 'soon' }, now), 0);
});

test('the Focus line says what’s on, or why it can’t see', () => {
  assert.deepEqual(P.focusLine({ follow: true, focus: { state: 'on', name: 'Work' } }), ['A Focus is on now: I’m keeping to cards.', 'Work']);
  assert.match(P.focusLine({ follow: true, focus: { state: 'no_access' } })[0], /Full Disk Access/);
  assert.equal(P.focusLine({ follow: true, focus: { state: 'off' } })[0], 'No Focus is on.');
  assert.deepEqual(P.focusLine({ follow: false, focus: { state: 'on', name: 'Work' } }), ['', '']);  // not followed
  assert.deepEqual(P.focusLine({ follow: true, focus: { state: 'unknown' } }), ['', '']);  // not read yet
  assert.deepEqual(P.focusLine(null), ['', '']);
});

test('a time of day reads in the window’s language', () => {
  const at = new Date(2026, 8, 29, 15, 40).getTime() / 1000;
  assert.match(P.clock(at, 'en'), /^3:40\sPM$/);
  assert.match(P.clock(at, 'zh'), /15:40|3:40/);
  assert.equal(P.clock(0), '');
});

test('the briefing’s sections: the settings’ own, else the backend’s, known ones only', () => {
  const fallback = [{ id: 'calendar', on: true }, { id: 'news', on: false }];
  assert.deepEqual(P.sections({}, fallback), fallback);
  assert.deepEqual(P.sections({ briefing_sections: [{ id: 'news', on: true }, { id: 'nope' }, null] }, fallback), [{ id: 'news', on: true }]);
  assert.deepEqual(P.sections(null, null), []);
  assert.equal(Object.keys(P.SECTIONS).length, 11);
});

test('a section moves one place, and never off either end', () => {
  const s = [{ id: 'calendar', on: true }, { id: 'weather', on: true }, { id: 'mail', on: false }];
  assert.deepEqual(P.move(s, 'weather', -1).map((x) => x.id), ['weather', 'calendar', 'mail']);
  assert.deepEqual(P.move(s, 'weather', 1).map((x) => x.id), ['calendar', 'mail', 'weather']);
  assert.deepEqual(P.move(s, 'calendar', -1).map((x) => x.id), ['calendar', 'weather', 'mail']);
  assert.deepEqual(P.move(s, 'mail', 1).map((x) => x.id), ['calendar', 'weather', 'mail']);
  assert.deepEqual(P.toggled(s, 'mail').map((x) => x.on), [true, true, true]);
  assert.equal(s[2].on, false);  // the list it was given is left as it was
});
