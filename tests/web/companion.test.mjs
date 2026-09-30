// The phone companion's Settings script (src/jarvis/web/features/companion.js): the QR
// code it draws from the rows the Mac sends. node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../../src/jarvis/web/features/companion.js', import.meta.url), 'utf8');

function helpers() {
  let got = null;
  const window = { jarvisFeatures: { el: () => null, send: () => true, on: () => {} }, __companionTest: (h) => { got = h; } };
  const document = { getElementById: () => null };
  new Function('window', 'document', source)(window, document);
  return got;
}

test('the QR path draws each run of dark modules once, inside the quiet zone', () => {
  const { qrPath } = helpers();
  assert.equal(qrPath(['101', '011']), 'M4 4h1v1h-1zM6 4h1v1h-1zM5 5h2v1h-2z');
  assert.equal(qrPath(['000']), '');
  const rows = ['1111111', '1000001'];
  assert.equal(qrPath(rows), 'M4 4h7v1h-7zM4 5h1v1h-1zM10 5h1v1h-1z');
});

test('with no Settings group to add to, the script does nothing', () => {
  assert.doesNotThrow(() => helpers());
});
