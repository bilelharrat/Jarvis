// The automation feature's window helpers (src/jarvis/web/features/automation.js), run
// without a page: the script sets window.jarvisAutomation and stops where the page begins.
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../../src/jarvis/web/features/automation.js', import.meta.url), 'utf8');
const window = {};
new Function('window', source)(window);
const A = window.jarvisAutomation;

test('a routine shows its schedule in the window’s language', () => {
  const r = { when: 'every 30 minutes, 9 AM to 6 PM', when_zh: '上午9点到晚上6点之间每30分钟' };
  assert.equal(A.schedule(r, 'en'), 'every 30 minutes, 9 AM to 6 PM');
  assert.equal(A.schedule(r, 'zh'), '上午9点到晚上6点之间每30分钟');
  assert.equal(A.schedule({ when: 'every day at 7 AM' }, 'zh'), 'every day at 7 AM'); // an older backend
  assert.equal(A.schedule({}, 'en'), '');
});

test('the next run reads as a time today, a weekday this week, else a date', () => {
  const now = new Date(2026, 8, 29, 10, 7); // Tuesday 29 September 2026
  const today = A.when(new Date(2026, 8, 29, 15, 30).toISOString(), 'en', now);
  assert.match(today, /^3:30\sPM$/);
  assert.match(A.when(new Date(2026, 8, 30, 9, 0).toISOString(), 'en', now), /^Wed,? 9:00\sAM$/);
  assert.match(A.when(new Date(2026, 9, 30, 9, 0).toISOString(), 'en', now), /Oct 30/);
  assert.match(A.when(new Date(2026, 8, 30, 9, 0).toISOString(), 'zh', now), /周三/);
  assert.equal(A.when('', 'en', now), '');
  assert.equal(A.when('not a time', 'en', now), '');
});
