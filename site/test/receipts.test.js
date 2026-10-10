// Eden Mail's read receipts (src/accounts/receipts.js): the sealed pixel token, the Worker's /r/
// route (always the pixel, the open logged after), the sender's own first look ignored, coarse
// "via" only, and the limits.
import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/worker.js';
import { PIXEL, RECEIPTS, openVia, readReceiptToken, receiptOp, receiptToken } from '../src/accounts/receipts.js';
import { Account, Storage, namespace } from './fakes.js';
import { bytesToB64 } from '../src/accounts/util.js';

const env = () => {
  const e = { EDEN_TOKEN_KEY: bytesToB64(new Uint8Array(32).fill(9)) };
  e.ACCOUNTS = namespace(Account, e);
  e.LINKS = namespace(Account, e);
  return e;
};
const acct = (now = 1_000_000) => ({ storage: new Storage(), now: () => now });

test('receipts: a token opens to its account and receipt only under the same secret; junk is null', async () => {
  const e = env();
  const t = await receiptToken(e, 'acct-1', 'abcdef012345');
  assert.match(t, /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  assert.ok(!t.includes('acct-1'), 'the token doesn’t show who sent it');
  assert.deepEqual(await readReceiptToken(e, t), { account: 'acct-1', id: 'abcdef012345' });
  assert.equal(await readReceiptToken({ EDEN_TOKEN_KEY: bytesToB64(new Uint8Array(32).fill(1)) }, t), null);
  assert.equal(await readReceiptToken(e, `${t.slice(0, -2)}xx`), null);
  assert.equal(await readReceiptToken(e, 'nope'), null);
});

test('receipts: new, the sender’s own first look ignored, opens logged with a coarse via, capped; list and delete', async () => {
  let now = 5_000_000;
  const a = acct();
  a.now = () => now;
  const { id } = await receiptOp(a, 'rcpt-new', { subject: 'Contract', to: ['priya@example.org'] });
  await receiptOp(a, 'rcpt-sent', { id, thread: '18c2f0a1' });
  now += 5000;
  assert.deepEqual(await receiptOp(a, 'rcpt-open', { id, via: 'gmail' }), { ok: true, ignored: 'self' });
  now += RECEIPTS.selfMs;
  await receiptOp(a, 'rcpt-open', { id, via: 'gmail' });
  await receiptOp(a, 'rcpt-open', { id, via: 'something-else' });
  const { receipts } = await receiptOp(a, 'rcpt-list', {});
  assert.equal(receipts[0].thread, '18c2f0a1');
  assert.deepEqual(receipts[0].opens.map((o) => o.via), ['gmail', 'other']);
  for (let i = 0; i < RECEIPTS.opens + 5; i++) await receiptOp(a, 'rcpt-open', { id, via: 'apple' });
  assert.equal((await receiptOp(a, 'rcpt-list', {})).receipts[0].opens.length, RECEIPTS.opens);
  assert.deepEqual(await receiptOp(a, 'rcpt-open', { id: 'unknown00000' }), { ok: false });
  await receiptOp(a, 'rcpt-delete', { id });
  assert.equal((await receiptOp(a, 'rcpt-list', {})).receipts.length, 0);
  await assert.rejects(receiptOp(a, 'rcpt-delete', { id: '../x' }), /receipt id/);
});

test('receipts: via is a coarse guess, never the user agent itself', () => {
  assert.equal(openVia('Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)'), 'gmail');
  assert.equal(openVia('Mozilla/5.0'), 'apple');
  assert.equal(openVia('Microsoft Outlook 16.0'), 'outlook');
  assert.equal(openVia('curl/8'), 'other');
});

test('/r/<token>.gif: always the pixel, never cached; a real token logs the open after answering', async () => {
  const e = env();
  e.ACCOUNTS.get('acct-1'); // the account's object
  const store = e.ACCOUNTS.objects.get('acct-1').storage;
  await store.put('rc:abcdef012345', { id: 'abcdef012345', subject: 'S', to: [], sent: Date.now() - 60_000, opens: [], thread: null });
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const token = await receiptToken(e, 'acct-1', 'abcdef012345');
  const res = await worker.fetch(new Request(`https://askeden.com/r/${token}.gif`, { headers: { 'user-agent': 'Mozilla/5.0 (via ggpht.com GoogleImageProxy)' } }), e, ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/gif');
  assert.match(res.headers.get('cache-control'), /no-store/);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PIXEL);
  await Promise.all(waits);
  assert.deepEqual((await store.get('rc:abcdef012345')).opens.map((o) => o.via), ['gmail']);
  const junk = await worker.fetch(new Request('https://askeden.com/r/not-a-token.gif'), e, ctx);
  assert.equal(junk.status, 200, 'a bad token still gets the pixel (nothing for a mail app to show)');
});
