// Keep it green in the PR pane (web/features/code_pr.js, features/code_pr_green.py): its
// switch, Stop, caps, pushing without asking, the tunnel and the log, each labelled, and
// every string it shows in Chinese.
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../../src/jarvis/web/features/code_pr.js', import.meta.url), 'utf8');
const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n/code_pr.json', import.meta.url), 'utf8')).strings;
const green = source.slice(source.indexOf('// ── Keep it green'), source.indexOf('// ── opening one ──'));

test('the section sends its own commands, and Stop is a button of its own', () => {
  assert.match(green, /type: 'code_pr_green', id: task\.id, on,/);
  assert.match(green, /type: 'code_pr_green_stop', id: task\.id/);
  assert.match(green, /push_unasked: on/);
  assert.match(green, /tunnel: f\.tunnel\.trim\(\)/);
  assert.match(source, /wrap\.append\(greenView\(task, data\)\)/);
});

test('its inputs and its log are labelled for a screen reader, and the log is the backend’s words', () => {
  assert.match(green, /box\.setAttribute\('aria-label', 'Keep it green'\)/);
  assert.match(green, /status\.setAttribute\('role', 'status'\)/);
  assert.match(green, /list\.setAttribute\('aria-label', t\('What it did'\)\)/);
  assert.match(green, /box\.setAttribute\('aria-label', label\)/);
  assert.match(green, /mine\(e\.text\)/); // (translated by the backend; never translated twice)
});

test('every string the section shows has its Chinese', () => {
  const shown = [
    ...[...green.matchAll(/sw\('([^']+)', '([^']+)'/g)].flatMap((m) => [m[1], m[2]]),
    ...[...green.matchAll(/el\('[a-z]+', '[^']*', '([^']+)'\)/g)].map((m) => m[1]),
    ...[...green.matchAll(/button\('([^']+)', '[^']*', \(\) => [^,]+(?:, '([^']+)')?/g)].flatMap((m) => [m[1], m[2]]).filter(Boolean),
    ...[...green.matchAll(/chip\('([^']+)'/g)].map((m) => m[1]),
    ...[...green.matchAll(/t\('([^']+)'\)/g)].map((m) => m[1]),
    'Stopped: you pressed Stop.', 'Stopped: its rounds were used.', 'Stopped: it reached its spending ceiling.',
    'A round is under way', 'On', 'Off', 'Stopped.',
  ];
  assert.ok(shown.length > 15);
  assert.deepEqual([...new Set(shown)].filter((s) => !(s in zh)), []);
});
