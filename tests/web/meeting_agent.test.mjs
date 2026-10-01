// The call side panel's helpers (src/jarvis/web/features/meeting_agent.js). node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ma = require('../../src/jarvis/web/features/meeting_agent.js');

test('who spoke reads as You, Them or Jarvis, and nothing else', () => {
  assert.equal(ma.speakerLabel('You'), 'You');
  assert.equal(ma.speakerLabel('Them'), 'Them');
  assert.equal(ma.speakerLabel('Jarvis'), 'Jarvis');
  assert.equal(ma.speakerLabel('<img src=x>'), '');
  assert.equal(ma.speakerLabel(''), '');
});

test('a reply about to be spoken counts down its cancel', () => {
  assert.equal(ma.secondsLeft(3, 1000, 1000), 3);
  assert.equal(ma.secondsLeft(3, 1000, 2100), 2);
  assert.equal(ma.secondsLeft(3, 1000, 4000), 0);
  assert.equal(ma.secondsLeft(0, 1000, 1000), 0);
  assert.equal(ma.sayLabel('pending'), 'About to say');
  assert.equal(ma.sayLabel('spoken'), 'Said into the call');
  assert.equal(ma.sayLabel('anything else'), 'About to say');
});

test('an action item’s Calendar time starts at the next 9:00', () => {
  assert.equal(ma.nextMorning(new Date(2026, 8, 30, 8, 15)), '2026-09-30T09:00');
  assert.equal(ma.nextMorning(new Date(2026, 8, 30, 9, 0)), '2026-10-01T09:00');
  assert.equal(ma.nextMorning(new Date(2026, 11, 31, 17, 0)), '2027-01-01T09:00');
});

test('boxes send one trimmed line, never empty', () => {
  assert.equal(ma.words('  what   about\npricing ', 500), 'what about pricing');
  assert.equal(ma.words('   ', 500), '');
  assert.equal(ma.words('x'.repeat(400), 300).length, 300);
});

test('Settings lists Off, the virtual devices, and a chosen one that isn’t connected', () => {
  assert.deepEqual(ma.routeOptions(['BlackHole 2ch'], ''), [['', 'Off'], ['BlackHole 2ch', 'BlackHole 2ch']]);
  assert.deepEqual(ma.routeOptions([], 'Loopback Audio'), [['', 'Off'], ['Loopback Audio', 'Loopback Audio']]);
  assert.deepEqual(ma.routeOptions(null, ''), [['', 'Off']]);
  assert.deepEqual(ma.routeOptions(['A', 7, ''], 'A'), [['', 'Off'], ['A', 'A']]);
});
