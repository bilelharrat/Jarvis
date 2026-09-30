// Home questions in Settings › Home & Shortcuts (src/jarvis/web/features/mac-actions.js):
// what the Add menu offers. node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../../src/jarvis/web/features/mac-actions.js', import.meta.url), 'utf8');

function helpers() {
  let got = null;
  const window = { jarvisFeatures: { el: () => null, send: () => true, on: () => {} }, __macActionsTest: (h) => { got = h; } };
  const document = { getElementById: () => null };
  new Function('window', 'document', source)(window, document);
  return got;
}

test('the Add menu offers the shortcuts not yet marked, in the Mac’s order', () => {
  const { addable } = helpers();
  assert.deepEqual(addable(['Movie Night', 'Is the garage closed', 'Lights Off'], ['Is the garage closed']), ['Movie Night', 'Lights Off']);
  assert.deepEqual(addable(null, []), []);
  assert.deepEqual(addable(['', 3, 'Ok'], []), ['Ok']);
});

test('removing a question keeps the others', () => {
  const { without } = helpers();
  assert.deepEqual(without(['A', 'B', 'C'], 'B'), ['A', 'C']);
});

test('with no Home group to add to, the script does nothing', () => {
  assert.doesNotThrow(() => helpers());
});
