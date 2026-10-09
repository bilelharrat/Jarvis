// The email accounts page's helpers (src/jarvis/web/features/mail-accounts.js), without a page.
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../../src/jarvis/web/features/mail-accounts.js', import.meta.url), 'utf8');
const window = {};
new Function('window', source)(window);
const M = window.jarvisMailAccounts;

test('only what a person changed from the guessed servers is sent', () => {
  const guess = { imap_host: 'imap.gmail.com', imap_port: 993, imap_security: 'ssl', username: '' };
  assert.deepEqual(M.changed(guess, { imap_host: 'imap.gmail.com', imap_port: '993', imap_security: 'ssl', username: '' }), {});
  assert.deepEqual(M.changed(guess, { imap_host: 'mail.example.com', imap_port: '993', username: 'ann' }), { imap_host: 'mail.example.com', username: 'ann' });
});

test('with no guess, whatever was typed is sent and blanks are not', () => {
  assert.deepEqual(M.changed({}, { imap_host: ' imap.x.example ', imap_port: '', smtp_host: '' }), { imap_host: 'imap.x.example' });
});

test('the list says how many accounts there are', () => {
  assert.equal(M.summary([]), 'No email accounts yet.');
  assert.equal(M.summary([{}]), '1 email account.');
  assert.equal(M.summary([{}, {}]), '2 email accounts.');
});
