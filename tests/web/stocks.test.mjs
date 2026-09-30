// Price alerts in Settings › Markets (src/jarvis/web/features/stocks.js): how an alert reads
// in the list. node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../../src/jarvis/web/features/stocks.js', import.meta.url), 'utf8');

function helpers() {
  let got = null;
  const window = { jarvisFeatures: { el: () => null, send: () => true, on: () => {} }, __stocksTest: (h) => { got = h; } };
  const document = { getElementById: () => null };
  new Function('window', 'document', source)(window, document);
  return got;
}

test('an alert says what it watches for', () => {
  const { what } = helpers();
  assert.equal(what({ kind: 'above', value: 150 }), 'Goes above 150.00');
  assert.equal(what({ kind: 'below', value: 61234.5 }), 'Goes below 61,235');
  assert.equal(what({ kind: 'move', value: 2.5 }), 'Moves 2.5% in a day');
});

test('an alert says where it stands', () => {
  const { state } = helpers();
  assert.equal(state({ fired: '2026-09-29T10:00:00' }), 'Went off today');
  assert.equal(state({ waiting: true }), 'Waits for the price to come back first');
  assert.equal(state({}), 'Watching');
});

test('a price that is not a number shows nothing', () => {
  const { price } = helpers();
  assert.equal(price('lots'), '');
  assert.equal(price(1234), '1,234');
});

test('with no Markets group to add to, the script does nothing', () => {
  assert.doesNotThrow(() => helpers());
});
