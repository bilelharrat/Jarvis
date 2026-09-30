// The code-voice window feature's pure helpers: node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const cv = require('../../src/jarvis/web/features/code-voice.js');

test('a session counts as looked at only with the window in front and Jarvis Code open', () => {
  const doc = (visibilityState, focused) => ({ visibilityState, hasFocus: () => focused });
  assert.equal(cv.looking(doc('visible', true), false), true);
  assert.equal(cv.looking(doc('visible', true), true), false); // the panel is closed
  assert.equal(cv.looking(doc('hidden', true), false), false); // behind other windows
  assert.equal(cv.looking(doc('visible', false), false), false); // another app is in front
});

test('the lines asked for are marked within the file shown', () => {
  assert.deepEqual(cv.lineSpan(10, 20, 100), [9, 20]);
  assert.deepEqual(cv.lineSpan(7, 7, 100), [6, 7]);
  assert.deepEqual(cv.lineSpan(95, 120, 100), [94, 100]); // past the end: up to it
  assert.deepEqual(cv.lineSpan(150, 160, 100), [100, 100]); // none
  assert.deepEqual(cv.lineSpan(0, 0, 10), [0, 0]);
});
