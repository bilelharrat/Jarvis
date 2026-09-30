// Jarvis Code's terminals (web/features/code-terminal.js), its pure helpers: a "!" command's
// output as it streams in, and a terminal's selection for the composer. node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const T = require('../../src/jarvis/web/features/code-terminal.js');

test('streamed output: lines as they come, a progress bar settled, a backspace taken back', () => {
  const out = T.liveOutput();
  T.applyOutput(out, 'Installing\n10%');
  T.applyOutput(out, '\r50%');
  T.applyOutput(out, '\r100%\nok\n');
  assert.deepEqual(out.lines, ['Installing', '100%', 'ok', '']);
  T.applyOutput(out, 'typo\x08\x08po\n');
  assert.deepEqual(out.lines.slice(-2), ['typo', '']);
  // A line split between two messages is one line.
  T.applyOutput(out, 'hal');
  T.applyOutput(out, 'f a line\n');
  assert.equal(out.lines[out.lines.length - 2], 'half a line');
});

test('a terminal’s \\r\\n ends a line, even split between two messages', () => {
  const out = T.liveOutput();
  T.applyOutput(out, 'step 1\r\nstep 2\r');
  T.applyOutput(out, '\nstep 3\r\n');
  assert.deepEqual(out.lines, ['step 1', 'step 2', 'step 3', '']);
  // A \r that isn't one is still a line written over.
  T.applyOutput(out, '40%\r');
  T.applyOutput(out, '90%\r\n');
  assert.deepEqual(out.lines.slice(-2), ['90%', '']);
});

test('streamed output keeps only the last lines, and says what was skipped', () => {
  const out = T.liveOutput();
  T.applyOutput(out, `${'x\n'.repeat(T.LIVE_LINES + 500)}`);
  assert.equal(out.lines.length, T.LIVE_LINES);
  assert.equal(out.dropped, 501);
  T.applyOutput(out, 'tail\n', 12345);
  assert.ok(out.lines.some((l) => l.includes('12345 characters more')));
  assert.equal(out.lines[out.lines.length - 2], 'tail');
});

test('a selection goes to the composer as a code block its backticks can’t close', () => {
  assert.equal(T.selectionBlock('error: boom  \n'), 'From the terminal:\n```\nerror: boom\n```\n');
  assert.equal(T.selectionBlock('a ``` b', 'look at this'), '\nFrom the terminal:\n````\na ``` b\n````\n');
  assert.equal(T.selectionBlock('x', 'first line\n'), 'From the terminal:\n```\nx\n```\n');
});
