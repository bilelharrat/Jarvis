// The code interpreter's runs in the window (web/features/code-interpreter.js). node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const h = require('../../src/jarvis/web/features/code-interpreter.js');

test('a chart shows only as plain base64 PNG', () => {
  assert.equal(h.chartSrc({ data: 'iVBORw0KGgo=' }), 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(h.chartSrc({ data: '"><script>' }), '');
  assert.equal(h.chartSrc(null), '');
});

test('the title says what the run did', () => {
  assert.equal(h.title({ error: 'Traceback' }), 'The code hit an error');
  assert.equal(h.title({ charts: [{}] }), 'Made a chart');
  assert.equal(h.title({ charts: [{}, {}] }), 'Made 2 charts');
  assert.equal(h.title({ output: '42' }), 'Ran Python');
});

test('long output folds to its first lines', () => {
  const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
  const clipped = h.clip(long, 40);
  assert.equal(clipped.more, 10);
  assert.equal(clipped.text.split('\n').length, 40);
  assert.deepEqual(h.clip('42\n\n'), { text: '42', more: 0 });
});
