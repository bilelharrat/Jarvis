// Auto Drafts in the background (src/accounts/autodrafts.js): on/off with the owner's style sealed
// (and deleted when off), one pass over new mail (robots, the owner's own mail, scams and seen ones
// skipped; a reply only when the model says one is needed, in the thread, never sent), the daily
// cap, the budget held and spent, and untouched drafts cleaned up after a week.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AD, autodraftOp, autodraftPass, draftPrompt } from '../src/accounts/autodrafts.js';
import { runLedger } from '../src/accounts/tasks.js';
import { Storage } from './fakes.js';
import { bytesToB64 } from '../src/accounts/util.js';

function account(now = Date.parse('2026-10-09T12:00:00Z')) {
  const storage = new Storage();
  storage.map.set('account', { id: 'acct-1' });
  const spent = [];
  return {
    storage, spent, env: { EDEN_TOKEN_KEY: bytesToB64(new Uint8Array(32).fill(3)) },
    now: () => now,
    allowAi: async () => ({ ok: true, bucket: 'plus', left: 5 }),
    holdAi: async () => ({ ok: true, bucket: 'plus', hold: 'h1' }),
    spend: async (x) => { spent.push(x.usd); },
    release: () => {},
  };
}

const MAILS = {
  m1: { id: 'm1', threadId: 't1', from: 'Priya Shah <priya@example.org>', subject: 'Contract', body: 'Could you confirm the 30-day terms by Wednesday?', messageId: '<a1@x>', attachments: [] },
  m2: { id: 'm2', threadId: 't2', from: 'GitHub <noreply@github.com>', subject: 'CI passed', body: 'All green.', attachments: [] },
  m3: { id: 'm3', threadId: 't3', from: 'PayPal <service@paypa1.com>', subject: 'Account suspended', body: 'Verify your account within 24 hours', attachments: [] },
  m4: { id: 'm4', threadId: 't4', from: 'Sam <sam@example.com>', subject: 'FYI', body: 'Just letting you know the deck is up.', attachments: [] },
  m5: { id: 'm5', threadId: 't5', from: 'Me <me@x.com>', subject: 'Note to self', body: 'x', attachments: [] },
};
function fakeGmail() {
  const drafts = new Map();
  const calls = [];
  const api = {
    search: async () => ({ messages: Object.values(MAILS).map(({ body: _b, ...m }) => ({ ...m, snippet: '' })), nextPageToken: null, estimate: 5 }),
    read: async (id) => ({ ...MAILS[id], to: 'me@x.com', cc: '', replyTo: '', references: null, inReplyTo: null, labelIds: [], bodyType: 'text', truncated: false, html: null, date: null, snippet: '', unread: true }),
    thread: async (id) => ({ id, messages: [] }),
    draft: async (mail) => { calls.push(mail); const id = `r${drafts.size + 1}`; drafts.set(id, `dm${drafts.size + 1}`); return { id, messageId: drafts.get(id), threadId: mail.threadId || null }; },
    getDraft: async (id) => { if (!drafts.has(id)) { const e = new Error('gone'); throw e; } return { draftId: id, id: drafts.get(id) }; },
    deleteDraft: async (id) => { drafts.delete(id); },
    sendAs: async () => [{ email: 'me@x.com', name: 'Me', signature: '<b>Me</b> · Co', isDefault: true, isPrimary: true, verified: true, replyTo: '' }],
  };
  return { google: { email: 'me@x.com', scopes: ['https://www.googleapis.com/auth/gmail.modify'], gmail: () => api }, calls, drafts };
}

test('autodrafts: on with the style sealed (not readable as is), off deletes it; a delegate can’t (account.js)', async () => {
  const a = account();
  const st = await autodraftOp(a, 'ad-set', { on: true, perDay: 99, style: { stats: { words: { median: 12 } }, guide: 'Warm, brief.' } });
  assert.deepEqual([st.on, st.perDay, st.hasStyle], [true, AD.perDayMax, true]);
  const sealed = a.storage.map.get('ad:style');
  assert.ok(sealed.iv && sealed.ct && !JSON.stringify(sealed).includes('Warm'), 'sealed, never stored in the clear');
  assert.ok((a.storage.map.get('alarmq') || []).some((j) => j.key === 'autodraft'), 'the job is on the alarm queue');
  const off = await autodraftOp(a, 'ad-set', { on: false });
  assert.deepEqual([off.on, off.hasStyle], [false, false]);
  assert.ok(!(a.storage.map.get('alarmq') || []).some((j) => j.key === 'autodraft'));
  await assert.rejects(autodraftOp(a, 'ad-set', { on: true, style: { x: 'y'.repeat(AD.styleChars) } }), /at most/);
});

test('autodrafts: a pass drafts only what needs a reply, in the thread, never sends; robots, own mail, scams and seen mail skipped', async () => {
  const a = account();
  await autodraftOp(a, 'ad-set', { on: true, perDay: 10, style: { stats: null } });
  const g = fakeGmail();
  const asked = [];
  const ask = async (_env, { user }) => { asked.push(user); return { ok: true, costUSD: 0.0004, value: /confirm the 30-day/.test(user) ? { needs_reply: true, reason: 'asks you to confirm terms', body: 'Hi Priya,\n\nYes, 30 days works.\n\nBest,\nMe' } : { needs_reply: false, reason: 'FYI', body: null } }; };
  const notes = [];
  const r = await autodraftPass(a, { on: true, perDay: 10 }, a.now(), { google: g.google, ask, notify: async (_a, n) => notes.push(n) });
  assert.deepEqual([r.checked, r.drafted], [2, 1], JSON.stringify(r));
  assert.equal(asked.length, 2, 'Priya and Sam: not GitHub (robot), not PayPal (the shield), not the owner');
  assert.ok(asked.every((u) => /<<<EDEN_UNTRUSTED b=/.test(u)), 'the email goes in as untrusted data');
  assert.deepEqual(g.calls.map((c) => [c.to, c.subject, c.threadId, c.inReplyTo]), [[['Priya Shah <priya@example.org>'], 'Re: Contract', 't1', '<a1@x>']]);
  assert.match(g.calls[0].html, /^<div dir="ltr"><div>Hi Priya,<\/div><div><br><\/div><div>Yes, 30 days works\.<\/div>.*class="gmail_signature".*<b>Me<\/b> · Co/);
  assert.equal(a.spent.length, 2);
  assert.match(notes[0].body, /A reply to Priya Shah is ready to review/);
  const st = await autodraftOp(a, 'ad-get', {});
  assert.deepEqual(st.made.map((x) => [x.msgId, x.draftId]), [['m1', 'r1']]);
  assert.equal(st.today, 1);
  const again = await autodraftPass(a, { on: true, perDay: 10 }, a.now(), { google: g.google, ask, notify: async () => {} });
  assert.deepEqual([again.checked, again.drafted], [0, 0], 'seen mail isn’t checked twice');
});

test('autodrafts: the daily cap, and untouched drafts deleted after a week (edited ones kept)', async () => {
  const a = account();
  const g = fakeGmail();
  const ask = async () => ({ ok: true, costUSD: 0, value: { needs_reply: true, reason: 'r', body: 'Hi,\n\nOk.\n\nMe' } });
  const r = await autodraftPass(a, { on: true, perDay: 1 }, a.now(), { google: g.google, ask, notify: async () => {} });
  assert.equal(r.drafted, 1);
  assert.equal(r.skipped, 'the daily limit');
  // a week later: r1 untouched → deleted; pretend the owner edited another one (its message id changed)
  const made = a.storage.map.get('ad:made');
  made.push({ msgId: 'mx', threadId: 'tx', draftId: 'r9', draftMsgId: 'old', at: a.now() });
  g.drafts.set('r9', 'edited');
  const later = account(a.now() + 8 * 86_400_000);
  later.storage = a.storage;
  await autodraftPass(later, { on: true, perDay: 1 }, later.now(), { google: g.google, ask: async () => ({ ok: true, costUSD: 0, value: { needs_reply: false, reason: '', body: null } }), notify: async () => {} });
  assert.equal(g.drafts.has('r1'), false, 'untouched: deleted');
  assert.equal(g.drafts.has('r9'), true, 'edited: kept');
});

test('autodrafts: the prompt carries the owner’s style and frame; the email is fenced', async () => {
  const style = { stats: { count: 5, words: { median: 12, short: 1, long: 0 }, sentence: { median: 6 }, paragraphs: 1, greetings: [{ text: 'Hey {name},', share: 1 }], noGreeting: 0, signoffs: [{ text: 'Cheers,', share: 1 }], noSignoff: 0, name: 'B', contractions: 1, exclaim: 0, questions: 0, emoji: 0, lowercase: 0, lowercaseI: false, dashes: 0, ellipses: 0, bullets: 0, phrases: [], perPerson: {}, situations: {}, languages: {} }, guide: '- Warm', rules: [{ text: 'Never say reach out.' }], examples: [{ to: ['priya@example.org'], subject: 'Lunch', text: 'Hey Priya,\n\nFree Thursday?\n\nCheers,\nB' }] };
  const p = draftPrompt(style, { ...MAILS.m1 }, [], runLedger());
  assert.match(p.system, /Write exactly the way the owner writes/);
  assert.match(p.system, /Never say reach out/);
  assert.deepEqual(p.frame, { greeting: 'Hey {name},', signoff: 'Cheers,', name: 'B', noGreeting: false });
  assert.match(p.user, /kind=example[\s\S]*Free Thursday[\s\S]*kind=email[\s\S]*confirm the 30-day terms/);
  assert.equal(p.first, 'Priya');
});
