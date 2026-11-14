// Eden Mail's IMAP mailboxes (iCloud, Yahoo, AOL, other servers: src/eden/mail-imap.js, imap.js, smtp.js,
// mime.js, and their routes in mailboxes.js / google-data.js) against fake IMAP and SMTP servers
// (test/imap-fakes.js) behind env.MAIL_SOCKETS, and a fake Google for the first Gmail. No network.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { approvalHash } from '../src/eden/google-data.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { b64url, bytesToB64 } from '../src/accounts/util.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Link, appleJwk, identityToken, namespace } from './fakes.js';
import { FakeImap, FakeSmtp, fakeConnect, mail } from './imap-fakes.js';
import { parseMessage, snippetOf } from '../src/eden/mime.js';

const ORIGIN = 'https://askeden.com';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const CLIENT_ID = '1234-test.apps.googleusercontent.com';
const GMAIL = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.modify'];
const APP_PASSWORD = 'abcd-efgh-ijkl-mnop';

let env, waits, imap, smtp, pimap, psmtp, opened, googleCalls;
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;
const idToken = (claims) => `${b64url(new TextEncoder().encode('{"alg":"none"}'))}.${b64url(new TextEncoder().encode(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT_ID, ...claims })))}.sig`;

/** The first Gmail (Google sign-in), Apple's keys and Thunderbird's provider list: the only HTTP here. */
async function fakeHttp(url, init = {}) {
  googleCalls.push(url);
  if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
  if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'at-owner', expires_in: 3600, scope: ['openid', ...GMAIL].join(' '), id_token: idToken({ sub: 'g-owner', email: 'owner@gmail.com' }), refresh_token: 'rt-owner' });
  if (url === 'https://oauth2.googleapis.com/revoke') return new Response('{}');
  if (url.startsWith('https://autoconfig.thunderbird.net/v1.1/')) {
    if (url.endsWith('/postbox.io')) {
      return new Response(`<clientConfig><emailProvider id="postbox.io"><displayName>Postbox</displayName>
        <incomingServer type="imap"><hostname>imap.postbox.io</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username></incomingServer>
        <outgoingServer type="smtp"><hostname>smtp.postbox.io</hostname><port>465</port><socketType>SSL</socketType></outgoingServer></emailProvider></clientConfig>`);
    }
    return new Response('not found', { status: 404 });
  }
  // a custom domain hosted at Purelymail: no list entry, found through its MX and the provider's own autoconfig
  if (url === 'https://cloudflare-dns.com/dns-query?name=harrat.ai&type=MX') {
    return Response.json({ Answer: [{ name: 'harrat.ai.', type: 15, data: '50 mailserver.purelymail.com.' }] });
  }
  if (url === 'https://autoconfig.purelymail.com/mail/config-v1.1.xml') {
    return new Response(`<clientConfig version="1.1"><emailProvider id="purelymail.com"><displayName>Purelymail</displayName>
      <incomingServer type="imap"><hostname>imap.purelymail.com</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username></incomingServer>
      <outgoingServer type="smtp"><hostname>smtp.purelymail.com</hostname><port>465</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username></outgoingServer></emailProvider></clientConfig>`);
  }
  throw new Error(`unexpected fetch ${init.method || 'GET'} ${url}`);
}

function makeEnv(extra = {}) {
  const e = { ANTHROPIC_API_KEY: 'sk-test', GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'client-secret', EDEN_TOKEN_KEY: bytesToB64(new Uint8Array(32).fill(7)), MAIL_MULTI: 'on', ...extra };
  e.ACCOUNTS = namespace(Account, e);
  e.LINKS = namespace(Link, e);
  e.ASSETS = { fetch: async () => new Response('asset') };
  e.MAIL_SOCKETS = fakeConnect({ 'imap.mail.me.com:993': imap, 'smtp.mail.me.com:587': smtp, 'imap.postbox.io:993': imap, 'smtp.postbox.io:465': smtp, 'imap.purelymail.com:993': pimap, 'smtp.purelymail.com:465': psmtp }, opened);
  return e;
}

beforeEach(() => {
  waits = [];
  opened = [];
  googleCalls = [];
  forgetAppleKeys();
  forgetSessions();
  // iCloud takes the address's name part for IMAP and the whole address for SMTP (as Apple documents)
  imap = new FakeImap({ users: ['me'], password: APP_PASSWORD });
  smtp = new FakeSmtp({ users: ['me@icloud.com'], password: APP_PASSWORD, starttls: true });
  // Purelymail (a custom domain): the whole address for both
  pimap = new FakeImap({ users: ['newfel@harrat.ai'], password: APP_PASSWORD });
  psmtp = new FakeSmtp({ users: ['newfel@harrat.ai'], password: APP_PASSWORD });
  globalThis.fetch = (input, init) => fakeHttp(typeof input === 'string' ? input : input.url, init);
  env = makeEnv();
});
after(() => { globalThis.fetch = realFetch; });

async function hit(p, { method = 'GET', body, headers = {}, session, cookie, token, approveAs } = {}) {
  if (p === '/api/chat/gmail' && body && ['send', 'schedule'].includes(body.action) && !headers['x-eden-approval']) {
    const as = approveAs === undefined ? body.mailbox : approveAs;
    const hash = await approvalHash('gmail', body.action, body.args || {}, as && as !== 'primary' ? as : null);
    const minted = await hit('/api/chat/approve', { method: 'POST', body: { kind: 'gmail', hash }, session, headers: { 'x-jarvis-chat': '1' } });
    if (minted.status === 200) headers = { ...headers, 'x-eden-approval': (await minted.json()).token };
  }
  const h = { 'user-agent': SAFARI, ...headers };
  if (method !== 'GET') h.origin ??= ORIGIN;
  const jar = [];
  if (session) jar.push(`__Host-eden=${session}`);
  if (cookie) jar.push(cookie);
  if (jar.length) h.cookie = jar.join('; ');
  if (token) h.authorization = `Bearer ${token}`;
  const init = { method, headers: h };
  if (body !== undefined) { init.body = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const response = await worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
  while (waits.length) await Promise.all(waits.splice(0));
  if ((response.headers.get('content-type') || '').startsWith('text/html')) response.__html = await response.clone().text();
  return response;
}
const cookieValue = (response, name) => ((response.headers.getSetCookie() || []).find((c) => c.startsWith(`${name}=`)) || '').slice(name.length + 1).split(';')[0];
async function signedIn({ gmail: withGmail = true } = {}) {
  const r = await hit('/api/account/apple', { method: 'POST', headers: { origin: null }, body: { identity_token: await identityToken({ sub: 'apple-user-1' }), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } } });
  const owner = await r.json();
  const started = await hit('/api/web/link', { method: 'POST', body: {} });
  const link = await started.json();
  await hit(`/api/link/${link.code}/approve`, { method: 'POST', headers: { origin: null }, token: owner.token, body: { sealed_key: null, sender_key: null } });
  const done = await hit('/api/web/link/poll', { method: 'POST', body: {}, cookie: `__Host-eden-link=${cookieValue(started, '__Host-eden-link')}` });
  const session = cookieValue(done, '__Host-eden');
  if (!withGmail) return { owner, session };
  // the first Gmail
  const start = await hit('/api/chat/google/connect?scope=gmail', { session });
  const to = new URL(start.headers.get('location'));
  await hit(`/api/chat/google/callback?state=${to.searchParams.get('state')}&code=good-code`, { cookie: `__Host-eden-gdata=${cookieValue(start, '__Host-eden-gdata')}`, headers: { 'sec-fetch-site': 'cross-site' } });
  return { owner, session };
}
const chat = (p, session, opts = {}) => hit(p, { session, ...opts, headers: { 'x-jarvis-chat': '1', ...(opts.headers || {}) } });
const accountsDo = (session, body) => chat('/api/chat/mail/accounts', session, { method: 'POST', body });
const gmail = (session, mailbox, action, args = {}, opts = {}) => chat('/api/chat/gmail', session, { method: 'POST', body: { action, args, mailbox }, ...opts });
const storedText = () => JSON.stringify([...env.ACCOUNTS.objects.values()].map((o) => [...o.storage.map]));
async function addICloud(session, password = APP_PASSWORD) {
  return accountsDo(session, { action: 'add', provider: 'imap', email: 'me@icloud.com', password });
}
async function iCloudId(session) {
  const list = await (await chat('/api/chat/mail/accounts', session)).json();
  return list.accounts.find((a) => a.kind === 'icloud').id;
}

test('detect: known providers by address, Gmail and Outlook pointed elsewhere, others from Thunderbird’s list', async () => {
  const { session } = await signedIn();
  const icloud = await (await accountsDo(session, { action: 'detect', email: 'me@icloud.com' })).json();
  assert.equal(icloud.kind, 'icloud');
  assert.match(icloud.help, /App-Specific Passwords/);
  assert.deepEqual(icloud.servers, { imap: { host: 'imap.mail.me.com', port: 993 }, smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' } });
  assert.equal((await (await accountsDo(session, { action: 'detect', email: 'x@gmail.com' })).json()).use, 'google');
  assert.equal((await (await accountsDo(session, { action: 'detect', email: 'x@hotmail.co.uk' })).json()).use, 'microsoft');
  const other = await (await accountsDo(session, { action: 'detect', email: 'sam@postbox.io' })).json();
  assert.equal(other.name, 'Postbox');
  assert.deepEqual(other.servers.smtp, { host: 'smtp.postbox.io', port: 465, security: 'tls' });
  assert.ok(googleCalls.includes('https://autoconfig.thunderbird.net/v1.1/postbox.io'), 'only the domain is sent');
  assert.equal((await (await accountsDo(session, { action: 'detect', email: 'sam@nowhere.example' })).json()).need, 'servers');
  const custom = await (await accountsDo(session, { action: 'detect', email: 'newfel@harrat.ai' })).json();
  assert.equal(custom.name, 'Purelymail', 'a custom domain is found through the provider its MX points at');
  assert.deepEqual(custom.servers, { imap: { host: 'imap.purelymail.com', port: 993 }, smtp: { host: 'smtp.purelymail.com', port: 465, security: 'tls' } });
  assert.ok(!googleCalls.some((u) => u.includes('newfel')), 'only domain names are sent, never the address');
  const list = await (await chat('/api/chat/mail/accounts', session)).json();
  assert.ok(list.providers.some((p) => p.kind === 'yahoo' && /app password/i.test(p.help)), 'the page gets the providers and their help');
});

test('adding iCloud: signs in to IMAP and SMTP first; a wrong password saves nothing and is counted', async () => {
  const { session } = await signedIn();
  const wrong = await addICloud(session, 'my-apple-id-password');
  assert.equal(wrong.status, 400);
  const w = await wrong.json();
  assert.equal(w.code, 'signin_failed');
  assert.match(w.error, /iCloud Mail didn’t take that address and password\. Make an app-specific password/);
  assert.ok(!JSON.stringify(w).includes('my-apple-id-password'), 'the password never comes back');
  assert.ok(!storedText().includes('my-apple-id-password'));
  assert.deepEqual(imap.logins, ['me', 'me@icloud.com'], 'the name part first, then the whole address (Apple’s advice)');

  const ok = await addICloud(session);
  assert.equal(ok.status, 200, await ok.clone().text());
  const list = await ok.json();
  const box = list.accounts.find((a) => a.kind === 'icloud');
  assert.deepEqual({ ...box, id: 'x' }, { id: 'x', provider: 'imap', kind: 'icloud', email: 'me@icloud.com', label: '', color: 'teal', primary: false, status: 'ok' });
  assert.ok(!storedText().includes(APP_PASSWORD), 'the app password is stored sealed');
  assert.ok(storedText().includes('Sent Messages'), 'the folder names are kept (no secret)');
  assert.ok(smtp.logins.includes('me@icloud.com'), 'SMTP signed in with the whole address');
  assert.equal(smtp.sent.length, 0, 'nothing was sent to check it');
  assert.ok(opened.every((o) => o.secureTransport === 'on' || (o.port === 587 && o.secureTransport === 'starttls')), 'encrypted connections only');

  // adding the same account again (Reconnect) keeps its id
  const again = await (await addICloud(session)).json();
  assert.equal(again.accounts.filter((a) => a.kind === 'icloud').length, 1);
  assert.equal(again.accounts.find((a) => a.kind === 'icloud').id, box.id);
});

test('five wrong passwords an hour, then Eden stops asking the server', async () => {
  const { session } = await signedIn();
  for (let i = 0; i < 5; i++) assert.equal((await addICloud(session, `wrong-${i}`)).status, 400);
  const logins = imap.logins.length;
  const r = await addICloud(session, 'wrong-6');
  assert.equal(r.status, 429);
  assert.equal(imap.logins.length, logins, 'no sign-in was tried');
});

test('servers entered by hand: public names on encrypted ports only', async () => {
  const { session } = await signedIn();
  const add = (imapS, smtpS) => accountsDo(session, { action: 'add', provider: 'imap', email: 'sam@postbox.io', password: 'pw', imap: imapS, smtp: smtpS });
  assert.equal((await add({ host: '127.0.0.1', port: 993 }, { host: 'smtp.postbox.io', port: 465 })).status, 400);
  assert.equal((await add({ host: 'imap.postbox.io', port: 143 }, { host: 'smtp.postbox.io', port: 465 })).status, 400);
  assert.equal((await add({ host: 'imap.postbox.io', port: 993 }, { host: 'smtp.postbox.io', port: 25 })).status, 400);
  assert.equal((await add({ host: 'mail.corp', port: 993 }, { host: 'smtp.postbox.io', port: 465 })).status, 400);
  assert.equal(opened.length, 0, 'nothing was dialled');
});

test('reading: the inbox list, an email with HTML and an attachment, search, and the account mark', async () => {
  const { session } = await signedIn();
  imap.add('INBOX', mail({ from: 'Ana <ana@example.com>', subject: 'Lunch', body: 'Are you free Friday?' }), { internal: Date.parse('2026-11-06T10:00:00Z') });
  const rich = [
    'From: =?utf-8?B?SsOpcsO0bWU=?= <j@example.fr>', 'To: me@icloud.com', 'Subject: =?utf-8?Q?Caf=C3=A9_menu?=', 'Date: Fri, 6 Nov 2026 11:00:00 +0000', 'Message-ID: <rich@example.fr>',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="M"', '', '--M', 'Content-Type: multipart/alternative; boundary="A"', '', '--A', 'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable', '', 'Le menu du caf=C3=A9 est joint.', '--A', 'Content-Type: text/html; charset=utf-8', '',
    '<p onclick="steal()">Le menu <b>joint</b></p><script>alert(1)</script>', '--A--', '--M', 'Content-Type: application/pdf; name="menu.pdf"', 'Content-Disposition: attachment; filename="menu.pdf"',
    'Content-Transfer-Encoding: base64', '', 'JVBERi0xLjQgbW9jaw==', '--M--', ''].join('\r\n');
  imap.add('INBOX', String.fromCharCode(...new TextEncoder().encode(rich)), { internal: Date.parse('2026-11-06T11:00:00Z') });
  imap.add('Sent Messages', mail({ from: 'me@icloud.com', to: 'Ana <ana@example.com>', subject: 'Re: Lunch', body: 'Yes!' }), { flags: ['\\Seen'] });
  await addICloud(session);
  const id = await iCloudId(session);

  const res = await gmail(session, id, 'search', { mailbox: 'inbox', limit: 30 });
  assert.equal(res.status, 200, await res.clone().text());
  const { messages } = await res.json();
  assert.deepEqual(messages.map((m) => m.subject), ['Café menu', 'Lunch'], 'newest first, encoded subjects decoded');
  assert.equal(messages[0].from, 'Jérôme <j@example.fr>');
  assert.equal(messages[0].snippet, 'Le menu du café est joint.');
  assert.ok(messages.every((m) => m.unread && m.labels.includes('INBOX')));

  const read = await (await gmail(session, id, 'read', { id: messages[0].id })).json();
  assert.equal(read.body.trim(), 'Le menu du café est joint.');
  assert.ok(read.html.includes('<b>joint</b>') && !/script|onclick/i.test(read.html), 'HTML cleaned by Eden’s Gmail code');
  assert.deepEqual(read.attachments.map((a) => [a.name, a.mime]), [['menu.pdf', 'application/pdf']]);
  const att = await (await gmail(session, id, 'attachment', { messageId: messages[0].id, attachmentId: read.attachments[0].attachmentId })).json();
  assert.equal(Buffer.from(att.data, 'base64').toString(), '%PDF-1.4 mock');
  assert.ok(!imap.find('INBOX', (m) => m.raw.includes('rich@')).flags.has('\\Seen'), 'reading isn’t marking read (Eden asks for that itself)');

  const sent = await (await gmail(session, id, 'search', { mailbox: 'sent', limit: 10 })).json();
  assert.deepEqual(sent.messages.map((m) => m.subject), ['Re: Lunch']);
  const found = await (await gmail(session, id, 'search', { query: 'from:ana@example.com OR to:ana@example.com', limit: 8 })).json();
  assert.deepEqual(found.messages.map((m) => m.subject).sort(), ['Lunch', 'Re: Lunch'], 'the sender card searches inbox and sent');
  // a search with accented words goes as a UTF-8 literal (IMAP SEARCH CHARSET UTF-8)
  imap.add('INBOX', String.fromCharCode(...new TextEncoder().encode(mail({ subject: 'Dessert', body: 'Crème brûlée for Friday', id: '<dessert@example.com>' }))));
  const accented = await (await gmail(session, id, 'search', { query: 'brûlée', limit: 5 })).json();
  assert.deepEqual(accented.messages.map((m) => m.subject), ['Dessert']);
  const prof = await (await gmail(session, id, 'profile')).json();
  assert.equal(prof.email, 'me@icloud.com');
  assert.match(prof.historyId, /^\d+$/);
  assert.equal((await (await gmail(session, id, 'history', { startHistoryId: prof.historyId })).json()).changes, 0);
});

test('Done, undo, read, star: flags and the Archive folder', async () => {
  const { session } = await signedIn();
  imap.add('INBOX', mail({ subject: 'Invoice', id: '<inv-1@example.com>' }));
  await addICloud(session);
  const id = await iCloudId(session);
  const [m] = (await (await gmail(session, id, 'search', { mailbox: 'inbox' })).json()).messages;
  const before = (await (await gmail(session, id, 'profile')).json()).historyId;
  assert.equal((await gmail(session, id, 'modify', { ids: [m.id], add: ['STARRED'], remove: ['UNREAD'] })).status, 200);
  const flags = imap.find('INBOX', (x) => x.raw.includes('inv-1')).flags;
  assert.ok(flags.has('\\Seen') && flags.has('\\Flagged'));
  assert.equal((await (await gmail(session, id, 'history', { startHistoryId: before })).json()).changes, 1, 'a change shows in history');

  assert.equal((await gmail(session, id, 'modify', { ids: [m.id], add: [], remove: ['INBOX'] })).status, 200);
  assert.equal(imap.box.INBOX.msgs.length, 0);
  assert.equal(imap.box.Archive.msgs.length, 1, 'Done moves it to Archive');
  // Undo (and a snooze waking) names the inbox id it had: found again by its Message-ID
  assert.equal((await gmail(session, id, 'modify', { ids: [m.id], add: ['INBOX', 'UNREAD'], remove: [] })).status, 200);
  assert.equal(imap.box.Archive.msgs.length, 0);
  assert.equal(imap.box.INBOX.msgs.length, 1);
  assert.ok(!imap.box.INBOX.msgs[0].flags.has('\\Seen'), 'back unread');
});

test('sending: SMTP from the mailbox (Bcc not in what’s sent), a copy in Sent; the approval is for that mailbox', async () => {
  const { session } = await signedIn();
  imap.add('INBOX', mail({ subject: 'Plans', id: '<plans@example.com>', from: 'Ana <ana@example.com>' }));
  await addICloud(session);
  const id = await iCloudId(session);
  const send = { to: ['Ana <ana@example.com>'], cc: ['lee@example.com'], bcc: ['me+copy@example.com'], subject: 'Re: Plans', body: 'Friday works.', inReplyTo: '<plans@example.com>', references: '<plans@example.com>', confirm: true };
  assert.equal((await gmail(session, id, 'send', send, { approveAs: null })).status, 403, 'an approval for the first Gmail doesn’t send from iCloud');
  const r = await gmail(session, id, 'send', send);
  assert.equal(r.status, 200, await r.clone().text());
  const out = await r.json();
  assert.equal(smtp.sent.length, 1);
  assert.equal(smtp.sent[0].from, 'me@icloud.com');
  assert.deepEqual(smtp.sent[0].rcpt.sort(), ['ana@example.com', 'lee@example.com', 'me+copy@example.com']);
  assert.ok(!/^bcc:/im.test(smtp.sent[0].data), 'Bcc isn’t in the message the recipients get');
  assert.match(smtp.sent[0].data, /^From: me@icloud\.com/m);
  assert.match(smtp.sent[0].data, /^In-Reply-To: <plans@example\.com>/m);
  assert.match(smtp.sent[0].data, /^Message-ID: <[0-9a-f]{32}@icloud\.com>/m);
  const filed = imap.box['Sent Messages'].msgs;
  assert.equal(filed.length, 1);
  assert.ok(filed[0].flags.has('\\Seen') && /^Bcc: me\+copy@example\.com/m.test(filed[0].raw), 'the Sent copy keeps the Bcc for you');
  assert.equal(out.threadId, (await (await gmail(session, id, 'search', { mailbox: 'inbox' })).json()).messages[0].threadId, 'the reply is in the email’s thread');
  // follow-ups: the thread, from Sent and the inbox
  const threads = await (await gmail(session, id, 'threads', { ids: [out.threadId] })).json();
  assert.equal(threads.threads[0].messages.length, 2);
  const sched = await gmail(session, id, 'schedule', { ...send, sendAt: Date.now() + 3600_000 });
  assert.equal(sched.status, 400);
});

test('drafts: saved in Drafts, updated in place of the old one, sent from there', async () => {
  const { session } = await signedIn();
  await addICloud(session);
  const id = await iCloudId(session);
  const first = await (await gmail(session, id, 'draft', { to: ['ana@example.com'], subject: 'Idea', body: 'v1' })).json();
  assert.equal(imap.box.Drafts.msgs.length, 1);
  assert.ok(imap.box.Drafts.msgs[0].flags.has('\\Draft'));
  const second = await (await gmail(session, id, 'draft', { draftId: first.id, to: ['ana@example.com'], subject: 'Idea', body: 'v2' })).json();
  assert.equal(imap.box.Drafts.msgs.length, 1, 'the old version is gone');
  assert.notEqual(second.id, first.id);
  const listed = await (await gmail(session, id, 'drafts', {})).json();
  assert.deepEqual(listed.drafts.map((d) => d.draftId), [second.id]);
  const opened = await (await gmail(session, id, 'getDraft', { id: second.id })).json();
  assert.equal(opened.body.trim(), 'v2');
  const r = await gmail(session, id, 'send', { draftId: second.id, to: ['ana@example.com'], subject: 'Idea', body: 'v3', confirm: true });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(imap.box.Drafts.msgs.length, 0, 'sent: no draft left behind');
  assert.equal(snippetOf(parseMessage(smtp.sent[0].data)), 'v3', 'the last version is what went');
});

test('a revoked app password: one refusal, the mailbox asks to sign in again, no more tries', async () => {
  const { session } = await signedIn();
  await addICloud(session);
  const id = await iCloudId(session);
  imap.password = 'revoked';
  const logins = imap.logins.length;
  const r = await gmail(session, id, 'search', { mailbox: 'inbox' });
  assert.equal(r.status, 401);
  const body = await r.json();
  assert.equal(body.code, 'reconnect');
  assert.match(body.error, /me@icloud\.com didn’t accept its app password/);
  assert.equal(imap.logins.length, logins + 1, 'one try');
  const list = await (await chat('/api/chat/mail/accounts', session)).json();
  assert.equal(list.accounts.find((a) => a.id === id).status, 'reconnect');
  assert.equal((await gmail(session, id, 'search', { mailbox: 'inbox' })).status, 409);
  assert.equal(imap.logins.length, logins + 1, 'no more tries until it’s reconnected');
  imap.password = APP_PASSWORD;
  await addICloud(session);
  assert.equal((await gmail(session, id, 'search', { mailbox: 'inbox' })).status, 200, 'Reconnect: the same mailbox works again');
});

test('another provider found by Thunderbird’s list; removing an IMAP mailbox forgets its password', async () => {
  const { session } = await signedIn();
  imap.users = ['sam@postbox.io'];
  smtp = new FakeSmtp({ users: ['sam@postbox.io'], password: APP_PASSWORD });
  env = makeEnv();
  const { session: s2 } = await signedIn();
  const r = await accountsDo(s2, { action: 'add', provider: 'imap', email: 'sam@postbox.io', password: APP_PASSWORD });
  assert.equal(r.status, 200, await r.clone().text());
  const box = (await r.json()).accounts.find((a) => a.kind === 'imap');
  assert.equal(box.email, 'sam@postbox.io');
  const gone = await accountsDo(s2, { action: 'remove', id: box.id });
  assert.equal(gone.status, 200);
  assert.ok(!storedText().includes(box.id));
  assert.ok(session);
});

test('no Gmail at all: an IMAP mailbox is detected, added and used on its own (read, search, send)', async () => {
  const { session } = await signedIn({ gmail: false });
  assert.deepEqual((await (await chat('/api/chat/mail/accounts', session)).json()).accounts, [], 'no first Gmail, nothing yet');
  const found = await (await accountsDo(session, { action: 'detect', email: 'newfel@harrat.ai' })).json();
  assert.equal(found.name, 'Purelymail');
  pimap.add('INBOX', mail({ from: 'Dad <dad@example.com>', to: 'newfel@harrat.ai', subject: 'Dinner', body: 'Sunday at 7?', id: '<dinner@example.com>' }));
  const added = await accountsDo(session, { action: 'add', provider: 'imap', email: 'newfel@harrat.ai', password: APP_PASSWORD });
  assert.equal(added.status, 200, await added.clone().text());
  const { accounts } = await added.json();
  assert.equal(accounts.length, 1, 'the IMAP mailbox is the only one');
  assert.deepEqual({ ...accounts[0], id: 'x' }, { id: 'x', provider: 'imap', kind: 'imap', email: 'newfel@harrat.ai', label: '', color: 'teal', primary: false, status: 'ok' });
  const id = accounts[0].id;

  const list = await (await gmail(session, id, 'search', { mailbox: 'inbox', limit: 30 })).json();
  assert.deepEqual(list.messages.map((m) => m.subject), ['Dinner']);
  assert.equal((await (await gmail(session, id, 'search', { query: 'Sunday' })).json()).messages.length, 1, 'search works');
  const send = { to: ['dad@example.com'], subject: 'Re: Dinner', body: 'See you then.', inReplyTo: '<dinner@example.com>', references: '<dinner@example.com>', confirm: true };
  const sent = await gmail(session, id, 'send', send);
  assert.equal(sent.status, 200, await sent.clone().text());
  assert.equal(psmtp.sent.length, 1);
  assert.equal(psmtp.sent[0].from, 'newfel@harrat.ai');
  assert.ok(psmtp.logins.includes('newfel@harrat.ai'));
  // the Gmail-only parts say so instead of breaking
  assert.equal((await gmail(session, null, 'profile')).status, 409, 'no mailbox named and no Gmail: not connected');
  assert.equal((await gmail(session, id, 'schedule', { ...send, sendAt: Date.now() + 3600_000 })).status, 400);
  assert.equal(googleCalls.filter((u) => u.includes('googleapis')).length, 0, 'Google was never called');
});

test('mime: nested parts, charsets, a truncated body still gives a snippet', () => {
  const raw = 'Content-Type: multipart/alternative; boundary=X\r\n\r\n--X\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nGr=FC=DFe aus K=F6ln, und noch mehr Text der abgeschnitten';
  assert.equal(snippetOf(parseMessage(raw)), 'Grüße aus Köln, und noch mehr Text der abgeschnitten');
});
