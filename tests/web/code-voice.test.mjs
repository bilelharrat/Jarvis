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

test('a point on the simulator is a spot in fractions of its picture, kept on it', () => {
  const rect = { left: 100, top: 50, right: 500, bottom: 850, width: 400, height: 800 };
  assert.deepEqual(cv.spotOn({ x: 300, y: 450 }, rect), { x: 0.5, y: 0.5 });
  assert.deepEqual(cv.spotOn({ x: 20, y: 2000 }, rect), { x: 0, y: 1 });
  assert.equal(cv.inside({ x: 300, y: 450 }, rect), true);
  assert.equal(cv.inside({ x: 99, y: 450 }, rect), false);
});

test('the picture sent is a square around the spot, never off the screen', () => {
  assert.deepEqual(cv.cropBox({ x: 0.5, y: 0.5 }, 1000, 2000), { sx: 300, sy: 800, sw: 400, sh: 400 });
  assert.deepEqual(cv.cropBox({ x: 0, y: 0 }, 1000, 2000), { sx: 0, sy: 0, sw: 400, sh: 400 });
  assert.deepEqual(cv.cropBox({ x: 1, y: 1 }, 1000, 2000), { sx: 600, sy: 1600, sw: 400, sh: 400 });
});
