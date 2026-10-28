// Loyalty numbers and travellers' papers sealed at rest (security review L11): with EDEN_TOKEN_KEY the account object
// holds only ciphertext bound to the account and the list; lists kept before sealing still read; without the key
// (a local setup) they stay plain. Another account's object can't open them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loyaltyOp } from '../src/travel/loyalty.js';
import { papersOp } from '../src/travel/papers.js';
import { readSealed } from '../src/travel/sealed.js';
import { b64url } from '../src/accounts/util.js';
import { Storage } from './fakes.js';

const KEY = b64url(new Uint8Array(32).fill(3));
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
async function account(id = A, env = { EDEN_TOKEN_KEY: KEY }) {
  const storage = new Storage();
  await storage.put('account', { id });
  return { storage, env, now: () => Date.parse('2026-10-28T12:00:00Z') };
}

test('loyalty numbers: sealed in the object, read back whole for bookings, masked for the page', async () => {
  const a = await account();
  const r = await loyaltyOp(a, 'trip-loyalty-save', { confirm: true, given_name: 'Alicia', family_name: 'Q', airline: 'BA', number: '12901014' });
  assert.equal(r.accounts[0].number, '•••• 1014');
  await loyaltyOp(a, 'trip-loyalty-save', { confirm: true, given_name: 'Alicia', family_name: 'Q', programme: 'marriott_bonvoy', number: 'MB998877' });
  for (const k of ['tloyal', 'tloyalh']) {
    const raw = await a.storage.get(k);
    assert.ok(raw.sealed && raw.sealed.ct, `${k} sealed`);
    assert.doesNotMatch(JSON.stringify(raw), /12901014|MB998877|Alicia/);
  }
  assert.equal((await readSealed(a, 'tloyal'))[0].number, '12901014');
  assert.equal((await loyaltyOp(a, 'trip-loyalty', {})).hotel_accounts.length, 1);
  // another account's object, the same bytes: nothing opens
  const b = await account(B);
  await b.storage.put('tloyal', await a.storage.get('tloyal'));
  assert.deepEqual(await readSealed(b, 'tloyal'), []);
});

test('papers: passport dates sealed; a list kept before sealing still reads, and seals on the next save', async () => {
  const a = await account();
  await a.storage.put('tpapers', [{ id: 'p-0000000001', name: 'Old', nationality: 'GB', passport_expires: '2029-01-01', auths: [], added: 0 }]);
  let r = await papersOp(a, 'trip-papers', {});
  assert.equal(r.travellers.length, 1);
  r = await papersOp(a, 'trip-papers-save', { name: 'Bilel', nationality: 'GB', passport_expires: '2030-01-01', confirm: true });
  assert.equal(r.travellers.length, 2);
  assert.doesNotMatch(JSON.stringify(await a.storage.get('tpapers')), /2030-01-01|2029-01-01|Bilel/);
});

test('no EDEN_TOKEN_KEY (a local setup): plain, as before', async () => {
  const a = await account(A, {});
  await loyaltyOp(a, 'trip-loyalty-save', { confirm: true, given_name: 'A', family_name: 'B', airline: 'BA', number: '12345678' });
  assert.equal((await a.storage.get('tloyal'))[0].number, '12345678');
});
