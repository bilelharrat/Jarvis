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

test('a countdown reads 4:12 or 1:05:00, and never goes below zero', () => {
  assert.equal(A.left(252), '4:12');
  assert.equal(A.left(3900), '1:05:00');
  assert.equal(A.left(59.6), '1:00');
  assert.equal(A.left(-3), '0:00');
  const now = new Date(2026, 8, 29, 15, 30, 0).getTime();
  assert.equal(A.until('2026-09-29T15:34:12', now), 252); // the backend's local time, no zone
  assert.equal(A.until('2026-09-29T15:00:00', now), 0);
  assert.equal(A.until('junk', now), 0);
});

test('a ringing alert names its timer; other heads-ups name none', () => {
  assert.equal(A.ringId('alarm:ab12cd:063000'), 'ab12cd');
  assert.equal(A.ringId('timer:x1:153000'), 'x1');
  assert.equal(A.ringId('reminder:rm1:155000'), '');
  assert.equal(A.ringId('interrupt:mail:4'), '');
  assert.equal(A.ringId(undefined), '');
});

test('an email rule is a routine on the mail trigger', () => {
  assert.equal(A.isEmailRule({ kind: 'event', spec: { trigger: { type: 'mail', from: 'Ann' } } }), true);
  assert.equal(A.isEmailRule({ kind: 'event', spec: { trigger: { type: 'text', from: 'Mom' } } }), false);
  assert.equal(A.isEmailRule({ kind: 'daily', spec: {} }), false);
  assert.equal(A.isEmailRule({ kind: 'event' }), false);
});

test('how a routine runs, in a few of the window’s words', () => {
  assert.deepEqual(A.howItRuns({ own: false, deliver: 'speak' }), ['In the conversation']);
  assert.deepEqual(A.howItRuns({ own: true, model: 'opus', tools: 'normal', deliver: 'forward' }), ['On its own', 'Opus', 'can act', 'to your phone']);
  assert.deepEqual(A.howItRuns({ own: true, model: '', tools: 'none', deliver: 'file' }), ['On its own', 'Haiku', 'no tools', 'to a file']);
});

test('active hours must make a day, and each check-in outcome has words', () => {
  assert.equal(A.hours('09:00', '21:00'), '09:00-21:00');
  assert.equal(A.hours('21:00', '09:00'), '');
  assert.equal(A.hours('9:00', '21:00'), '');
  assert.equal(A.hours('', ''), '');
  assert.equal(A.checkinOutcome('quiet'), 'Nothing needed you');
  assert.equal(A.checkinOutcome('said'), 'Told you');
  assert.equal(A.checkinOutcome('mystery'), 'mystery');
});

test('a webhook’s address and how to call it', () => {
  assert.equal(A.hookUrl('http://127.0.0.1:52011', 'ci'), 'http://127.0.0.1:52011/hooks/ci');
  assert.equal(A.hookUrl('http://127.0.0.1:1', 'a b'), 'http://127.0.0.1:1/hooks/a%20b');
  const example = A.hookExample('http://127.0.0.1:52011', 'ci');
  assert.match(example, /^curl -X POST -H "X-Jarvis-Token: \$JARVIS_TOKEN" --data '.+' http:\/\/127\.0\.0\.1:52011\/hooks\/ci$/);
});
