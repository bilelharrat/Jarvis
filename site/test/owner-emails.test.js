// Owner sign-ins (accounts/owner-emails.js): unlimited Plus and the EVES reviewers go to exact addresses only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Account } from '../src/accounts/account.js';
import { OWNER_EMAILS, isOwnerEmail } from '../src/accounts/owner-emails.js';
import { isBilelAccount, setBilelAccount } from '../public/eden/state.js';

const unlimited = (emails, env = {}) =>
  Account.prototype.unlimitedEmail.call({ env, identities: async () => emails.map((email) => ({ email })) });

test('owner addresses match exactly (case and spaces aside)', () => {
  for (const e of OWNER_EMAILS) assert.equal(isOwnerEmail(e), true, e);
  assert.equal(isOwnerEmail('  Bilel@AskEden.com '), true);
  for (const e of ['bilel.anything@gmail.com', 'bilel@evil.com', 'xbilel@askeden.com', 'bilel@askeden.com.evil.com', 'harratmalik25@gmail.com.evil', '', null, undefined, 42]) {
    assert.equal(isOwnerEmail(e), false, String(e));
  }
});

test('a sign-in with "bilel" in it is not unlimited unless it is an owner address', async () => {
  assert.equal(await unlimited(['bilel.stranger@gmail.com']), false);
  assert.equal(await unlimited(['bilel@harrat.org']), true);
  assert.equal(await unlimited(['someone@example.com', 'Bilel.Harrat36@gmail.com']), true);
  // UNLIMITED_EMAILS (the family) still works beside them
  assert.equal(await unlimited(['brother@example.com'], { UNLIMITED_EMAILS: 'brother@example.com' }), true);
  assert.equal(await unlimited(['brother@example.com']), false);
});

test('no loose bilel pattern is left in the server gates', () => {
  for (const f of ['../src/accounts/account.js', '../src/eden/eves.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /\/\\?b?bilel\/i/, f);
    assert.match(src, /isOwnerEmail/, f);
  }
});

test('the chat page shows owner tools only when the server says unlimited, never by email', () => {
  setBilelAccount({ identities: [{ email: 'bilel.stranger@gmail.com' }], plan: { source: 'stripe' } });
  assert.equal(isBilelAccount(), false);
  setBilelAccount({ identities: [{ email: 'bilel@askeden.com' }], plan: { source: 'app_store', unlimited: true } });
  assert.equal(isBilelAccount(), true);
  setBilelAccount({ plan: { source: 'unlimited' } });
  assert.equal(isBilelAccount(), true);
  setBilelAccount({ plan: { source: null } });
  assert.equal(isBilelAccount(), false);
  const page = readFileSync(new URL('../public/eden/state.js', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /bilel\/i|harratmalik/i, 'no owner address or pattern in a public script');
});
