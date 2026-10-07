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

test('a sign-in code is read as typed, and a browser sign-in says how it went', () => {
  const { codeOf, approvalLine } = helpers();
  assert.equal(codeOf('k7qm4ztr'), 'K7QM-4ZTR');
  assert.equal(codeOf(' K7QM-4ZTR '), 'K7QM-4ZTR');
  assert.equal(codeOf('jarvis-link://K7QM-4ZTR'), 'K7QM-4ZTR');
  assert.equal(codeOf('K7QM-4ZTU'), null);
  assert.equal(codeOf('hello'), null);
  assert.match(approvalLine({ state: 'approved' }), /signed in to Eden/);
  assert.match(approvalLine({ state: 'denied' }), /isn’t signed in/);
  assert.equal(approvalLine({ state: 'error', error: 'That code expired.' }), 'That code expired.');
  assert.equal(approvalLine({ state: 'asking' }), '');
});

test('Eden sync on this Mac says where it stands and what to do next', () => {
  const { esyncLine } = helpers();
  assert.match(esyncLine(null), /Checking/);
  assert.equal(esyncLine({ state: 'unknown', error: 'Couldn’t reach askeden.com.' }), 'Couldn’t reach askeden.com.');
  assert.match(esyncLine({ state: 'off' }), /isn’t on for your account/);
  assert.match(esyncLine({ state: 'locked' }), /recovery passphrase/);
  assert.match(esyncLine({ state: 'asking' }), /same code/);
  assert.match(esyncLine({ state: 'on', requests: [] }), /No browser is waiting/);
  assert.match(esyncLine({ state: 'on', requests: [{}] }), /^A device is waiting/);
  assert.match(esyncLine({ state: 'on', requests: [{}, {}] }), /^2 devices are waiting/);
});

test('Eden on the web reaching this Mac says whether its line is up, and why not', () => {
  const { edenLinkLine } = helpers();
  assert.deepEqual(edenLinkLine({ on: false, state: 'off' }), ['Off: Eden at askeden.com can’t reach Jarvis, Code mode or privacy mode on this Mac.', false]);
  assert.equal(edenLinkLine(null)[0].startsWith('Off'), true);
  assert.deepEqual(edenLinkLine({ on: true, state: 'open', error: '' }), ['Connected: Eden at askeden.com reaches Jarvis, Code mode and privacy mode here.', false]);
  assert.deepEqual(edenLinkLine({ on: true, state: 'waiting', error: 'Couldn’t reach askeden.com.' }), ['Offline: Couldn’t reach askeden.com. Trying again…', true]);
  assert.deepEqual(edenLinkLine({ on: true, state: 'waiting', error: '' }), ['Offline. Trying again…', true]);
  assert.deepEqual(edenLinkLine({ on: true, state: 'connecting' }), ['Connecting to askeden.com…', false]);
  assert.deepEqual(edenLinkLine({ on: true, state: 'off' }), ['Connecting to askeden.com…', false]);
});
