// What one Jarvis Code message may carry: node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { LIMITS, check, cost } = require('../../src/jarvis/web/attach.js');

// The window socket's frame (server.serve) and what the message around the files may add.
const FRAME = 64 * 1024 * 1024;
const TEXT_ROOM = 200_000;

// Every file of a drop, as addFile sees them: one after another, before any is read.
function admit(files) {
  const held = [];
  for (const f of files) if (check(held, f.kind, f.size) === '') held.push(f);
  return held;
}

test('a drop of ten 5.5 MB photos keeps under the limit and the frame', () => {
  const held = admit(Array.from({ length: 10 }, () => ({ kind: 'image', size: 5_500_000 })));
  assert.equal(held.length, 3);
  const chars = held.reduce((n, f) => n + cost(f.kind, f.size), 0);
  assert.ok(chars <= LIMITS.total && chars + TEXT_ROOM < FRAME);
});

test('never more than six files, however small', () => {
  const held = admit(Array.from({ length: 20 }, () => ({ kind: 'text', size: 100 })));
  assert.equal(held.length, LIMITS.files);
  assert.equal(check(held, 'text', 1), 'files');
});

test('the worst mix the limits allow still fits the frame', () => {
  // Base64 is one byte a character; a text file's bytes can grow up to six times as JSON
  // (control characters become \u00XX). The message around them: 20,000 characters, same.
  const worst = (held) => held.reduce((n, f) => n + (f.kind === 'text' ? 6 * f.size : cost(f.kind, f.size)), 0);
  for (const mix of [
    Array.from({ length: 12 }, () => ({ kind: 'pdf', size: LIMITS.binary })),
    Array.from({ length: 12 }, () => ({ kind: 'text', size: LIMITS.text })),
    [...Array.from({ length: 6 }, () => ({ kind: 'text', size: LIMITS.text })),
      ...Array.from({ length: 6 }, () => ({ kind: 'image', size: LIMITS.binary }))],
  ]) {
    const held = admit(mix);
    assert.ok(held.reduce((n, f) => n + cost(f.kind, f.size), 0) <= LIMITS.total);
    assert.ok(worst(held) + 6 * 20_000 + TEXT_ROOM < FRAME);
  }
});

test('one file too big on its own is refused, not counted', () => {
  assert.equal(check([], 'image', LIMITS.binary + 1), 'size');
  assert.equal(check([], 'text', LIMITS.text + 1), 'size');
  assert.equal(check([], 'pdf', LIMITS.binary), '');
});

test('base64 cost matches what FileReader produces', () => {
  assert.equal(cost('image', 6_000_000), 8_000_000); // the backend takes up to 8,000,000
  assert.equal(cost('image', 5_999_998), 8_000_000);
  assert.equal(cost('text', 1234), 1234);
});
