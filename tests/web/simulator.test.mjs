// The simulator pane's pure helpers: pointer to picture fractions, the device frame's
// fit, keys to HID usages. node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { keyUsage, toFraction, mirror, fitDevice, fps } = require('../../src/jarvis/web/simulator.js');

test('a pointer is aimed in fractions of the picture, kept on it', () => {
  const rect = { left: 100, top: 50, width: 400, height: 800 };
  assert.deepEqual(toFraction(300, 450, rect), { x: 0.5, y: 0.5 });
  assert.deepEqual(toFraction(100, 50, rect), { x: 0, y: 0 });
  // Dragged past the edge while held: it stays on the screen's edge.
  assert.deepEqual(toFraction(20, 2000, rect), { x: 0, y: 1 });
  assert.deepEqual(toFraction(5, 5, { left: 0, top: 0, width: 0, height: 0 }), { x: 0, y: 0 });
});

test('⌥ pinches mirror the second finger through the centre', () => {
  assert.deepEqual(mirror({ x: 0.25, y: 0.75 }), { x: 0.75, y: 0.25 });
});

test('the device frame fits its box and keeps the picture’s shape', () => {
  for (const [boxW, boxH, fw, fh] of [[520, 700, 1206, 2622], [520, 700, 2622, 1206], [300, 1200, 1206, 2622], [900, 300, 2048, 2732]]) {
    const fit = fitDevice(boxW, boxH, fw, fh, 'iPhone');
    assert.ok(fit.width <= boxW + 0.5 && fit.height <= boxH + 0.5, `${boxW}x${boxH}: ${fit.width}x${fit.height}`);
    assert.ok(Math.abs(fit.screenW / fit.screenH - fw / fh) < 0.01);
    assert.equal(fit.width, fit.screenW + 2 * fit.bezel);
    assert.ok(fit.bezel >= 6);
  }
  const phone = fitDevice(520, 700, 1206, 2622, 'iPhone');
  // Height-bound: it uses the box's height, not its width.
  assert.ok(phone.height > 690);
  assert.equal(phone.radius, Math.round(phone.screenW * 0.137));
  const pad = fitDevice(520, 700, 2048, 2732, 'iPad');
  assert.ok(pad.radius < phone.radius);
  assert.equal(fitDevice(0, 700, 1206, 2622), null);
  assert.equal(fitDevice(10, 10, 1206, 2622), null); // no room for a screen inside the bezel
});

test('keys map by physical key to HID keyboard usages', () => {
  assert.equal(keyUsage('KeyA'), 4);
  assert.equal(keyUsage('KeyZ'), 29);
  assert.equal(keyUsage('Digit1'), 30);
  assert.equal(keyUsage('Digit0'), 39);
  assert.equal(keyUsage('Enter'), 40);
  assert.equal(keyUsage('Backspace'), 42);
  assert.equal(keyUsage('ArrowUp'), 82);
  assert.equal(keyUsage('ShiftLeft'), 225);
  assert.equal(keyUsage('MetaRight'), 231);
  assert.equal(keyUsage('F12'), 69);
  assert.equal(keyUsage('MediaPlayPause'), 0);
  assert.equal(keyUsage(''), 0);
});

test('fps counts the frames of the last second', () => {
  assert.equal(fps([0, 100, 1000, 1500, 1990], 2000), 3);
  assert.equal(fps([], 2000), 0);
});
