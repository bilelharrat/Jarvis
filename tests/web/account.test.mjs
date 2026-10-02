// The Jarvis account's Settings script (src/jarvis/web/features/account.js): the link's QR
// code, its words for how a link is going, the plan and the relay. node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../../src/jarvis/web/features/account.js', import.meta.url), 'utf8');

function helpers() {
  let got = null;
  const window = { jarvisFeatures: { el: () => null, send: () => true, on: () => {} }, __accountTest: (h) => { got = h; } };
  const document = { getElementById: () => null };
  new Function('window', 'document', source)(window, document);
  return got;
}

test('the link QR code draws each run of dark modules once, inside the quiet zone', () => {
  const { qrPath } = helpers();
  assert.equal(qrPath(['101', '011']), 'M4 4h1v1h-1zM6 4h1v1h-1zM5 5h2v1h-2z');
  assert.equal(qrPath(['000']), '');
});

test('a link in progress says how it is going', () => {
  const { linkLine } = helpers();
  assert.equal(linkLine({ state: 'waiting' }), 'Waiting for your iPhone…');
  assert.match(linkLine({ state: 'expired' }), /expired/);
  assert.match(linkLine({ state: 'denied' }), /said no/);
  assert.equal(linkLine({ state: 'error', error: 'The Keychain is locked.' }), 'The Keychain is locked.');
  assert.equal(linkLine(null), '');
});

test('the plan, the money and the relay in words', () => {
  const { dollars, planLine, relayLine } = helpers();
  assert.equal(dollars(0.42), '$0.42');
  assert.equal(dollars('x'), '');
  assert.equal(planLine({ name: 'plus', active: true }), 'Jarvis Plus');
  assert.equal(planLine({ name: 'plus', active: false }), 'Free plan');
  assert.equal(relayLine({ on: false }), 'Off');
  assert.equal(relayLine({ on: true, state: 'listening' }), 'Reachable from anywhere');
  assert.equal(relayLine({ on: true, state: 'off' }), 'Waits for the phone companion to be on');
});

test('with no Settings group to add to, the script does nothing', () => {
  assert.doesNotThrow(() => helpers());
});
