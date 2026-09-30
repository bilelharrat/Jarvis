// Tools & Accounts › Recent activity (src/jarvis/web/features/connector-activity.js): how a
// connector call reads in the list. node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../../src/jarvis/web/features/connector-activity.js', import.meta.url), 'utf8');

function helpers() {
  let got = null;
  const window = { jarvisFeatures: { el: () => null, send: () => true, on: () => {} }, __connectorActivityTest: (h) => { got = h; } };
  const document = { getElementById: () => null };
  new Function('window', 'document', source)(window, document);
  return got;
}

test('a call says whether it read or changed something', () => {
  const { kindLabel } = helpers();
  assert.equal(kindLabel('read'), 'Read');
  assert.equal(kindLabel('write'), 'Change');
  assert.equal(kindLabel('anything else'), 'Change');  // unknown counts as a change
});

test('only a call that didn’t go through says how it went', () => {
  const { outcomeLabel } = helpers();
  assert.equal(outcomeLabel('done'), '');
  assert.equal(outcomeLabel('failed'), 'Failed');
  assert.equal(outcomeLabel('declined'), 'Declined');
});

test('a time that is not one shows nothing', () => {
  const { when } = helpers();
  assert.equal(when('not a time'), '');
  assert.ok(when('2026-09-30T09:15:00').length > 0);
});

test('with no Tools & Accounts sheet, the script does nothing', () => {
  assert.doesNotThrow(() => helpers());
});
