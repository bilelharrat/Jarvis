// Eden Mail's Outlook mailboxes (src/eden/mail-graph.js, and their routes in mailboxes.js / google-data.js)
// against a fake Microsoft sign-in and Graph (test/graph-fakes.js) behind env.MS_FETCH, and a fake Google
// for the first Gmail. No network.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { approvalHash } from '../src/eden/google-data.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { openMailbox } from '../src/accounts/mailboxes.js';
import { b64url, bytesToB64 } from '../src/accounts/util.js';
import { forgetSessions } from '../src/eden/session.js';
import { createGraphGmail, edenIdOf, graphIdOf, hasOutlookScopes, msIdClaims, toGraphQuery } from '../src/eden/mail-graph.js';
import { Account, Link, appleJwk, identityToken, namespace } from './fakes.js';
import { FakeMicrosoft, MS_CLIENT_ID, TENANT, msMail } from './graph-fakes.js';
import { parseMessage, snippetOf } from '../src/eden/mime.js';

const ORIGIN = 'https://askeden.com';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const CLIENT_ID = '1234-test.apps.googleusercontent.com';
const GMAIL = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.modify'];

let env, waits, ms, googleCalls;
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;
const idToken = (claims) => `${b64url(new TextEncoder().encode('{"alg":"none"}'))}.${b64url(new TextEncoder().encode(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT_ID, ...claims })))}.sig`;

/** The first Gmail (Google sign-in) and Apple's keys: the only other HTTP here. */
async function fakeHttp(url, init = {}) {
  googleCalls.push({ url, body: init.body });
  if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
  if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'at-owner', expires_in: 3600, scope: ['openid', ...GMAIL].join(' '), id_token: idToken({ sub: 'g-owner', email: 'owner@gmail.com' }), refresh_token: 'rt-owner' });
  if (url === 'https://oauth2.googleapis.com/revoke') return new Response('{}');
  throw new Error(`unexpected fetch ${init.method || 'GET'} ${url}`);
}

function makeEnv(extra = {}) {
  const e = { ANTHROPIC_API_KEY: 'sk-test', GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'client-secret', EDEN_TOKEN_KEY: bytesToB64(new Uint8Array(32).fill(7)), MAIL_MULTI: 'on', MICROSOFT_CLIENT_ID: MS_CLIENT_ID, MICROSOFT_CLIENT_SECRET: 'ms-secret', ...extra };
  e.ACCOUNTS = namespace(Account, e);
  e.LINKS = namespace(Link, e);
  e.ASSETS = { fetch: async () => new Response('asset') };
  e.MS_FETCH = (url, init) => ms.fetch(url, init);
  return e;
}

beforeEach(() => {
  waits = [];
  googleCalls = [];
  forgetAppleKeys();
  forgetSessions();
  ms = new FakeMicrosoft();
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
const landing = (r) => (r.__html === undefined ? undefined : (/http-equiv="refresh" content="0; url=([^"]+)"/.exec(r.__html) || [])[1]);
async function signedIn({ gmail: withGmail = true, sub = 'apple-user-1' } = {}) {
  const r = await hit('/api/account/apple', { method: 'POST', headers: { origin: null }, body: { identity_token: await identityToken({ sub }), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } } });
  const owner = await r.json();
  const started = await hit('/api/web/link', { method: 'POST', body: {} });
  const link = await started.json();
  await hit(`/api/link/${link.code}/approve`, { method: 'POST', headers: { origin: null }, token: owner.token, body: { sealed_key: null, sender_key: null } });
  const done = await hit('/api/web/link/poll', { method: 'POST', body: {}, cookie: `__Host-eden-link=${cookieValue(started, '__Host-eden-link')}` });
  const session = cookieValue(done, '__Host-eden');
  if (withGmail) {
    const start = await hit('/api/chat/google/connect?scope=gmail', { session });
    const to = new URL(start.headers.get('location'));
    await hit(`/api/chat/google/callback?state=${to.searchParams.get('state')}&code=good-code`, { cookie: `__Host-eden-gdata=${cookieValue(start, '__Host-eden-gdata')}`, headers: { 'sec-fetch-site': 'cross-site' } });
  }
  return { owner, session };
}
const chat = (p, session, opts = {}) => hit(p, { session, ...opts, headers: { 'x-jarvis-chat': '1', ...(opts.headers || {}) } });
const accounts = async (session) => (await chat('/api/chat/mail/accounts', session)).json();
const accountsDo = (session, body) => chat('/api/chat/mail/accounts', session, { method: 'POST', body });
const gmail = (session, mailbox, action, args = {}, opts = {}) => chat('/api/chat/gmail', session, { method: 'POST', body: { action, args, mailbox }, ...opts });
const storedText = () => JSON.stringify([...env.ACCOUNTS.objects.values()].map((o) => [...o.storage.map]));

/** Add an account › Outlook: Microsoft's sign-in round trip. Returns { to, done, id }. */
async function addOutlook(session, { code = 'ms-code', state } = {}) {
  const r = await accountsDo(session, { action: 'add', provider: 'outlook' });
  assert.equal(r.status, 200, await r.clone().text());
  const { url } = await r.json();
  assert.equal(url, '/api/chat/microsoft/connect');
  const start = await hit(url, { session });
  assert.equal(start.status, 302, await start.clone().text());
  const to = new URL(start.headers.get('location'));
  const done = await hit(`/api/chat/microsoft/callback?state=${state || to.searchParams.get('state')}&code=${code}&session_state=x`, { cookie: `__Host-eden-ms=${cookieValue(start, '__Host-eden-ms')}`, headers: { 'sec-fetch-site': 'cross-site' } });
  const list = await accounts(session);
  const box = list.accounts.find((a) => a.provider === 'outlook');
  return { to, done, id: box ? box.id : null, start };
}

test('off until the Microsoft client is set: the list says so, and nothing starts', async () => {
  env = makeEnv({ MICROSOFT_CLIENT_ID: '', MICROSOFT_CLIENT_SECRET: '' });
  const { session } = await signedIn();
  const list = await accounts(session);
  assert.equal(list.outlook, false);
  const r = await accountsDo(session, { action: 'add', provider: 'outlook' });
  assert.equal(r.status, 400);
  assert.match(JSON.stringify(await r.json()), /isn’t set up/);
  assert.equal((await hit('/api/chat/microsoft/connect', { session })).status, 404);
});

test('adding Outlook: Microsoft sign-in with PKCE and mail-only scopes; the mailbox in the list, no secrets', async () => {
  const { session } = await signedIn();
  const { to, done, id, start } = await addOutlook(session);
  assert.equal(to.origin + to.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  assert.equal(to.searchParams.get('client_id'), MS_CLIENT_ID);
  assert.equal(to.searchParams.get('redirect_uri'), 'https://askeden.com/api/chat/microsoft/callback');
  assert.equal(to.searchParams.get('response_mode'), 'query');
  assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(to.searchParams.get('prompt'), 'select_account');
  assert.deepEqual(to.searchParams.get('scope').split(' ').sort(), ['email', 'https://graph.microsoft.com/Mail.ReadWrite', 'https://graph.microsoft.com/Mail.Send', 'https://graph.microsoft.com/User.Read', 'offline_access', 'openid', 'profile'], 'mail only: no calendar, no files');
  assert.match(start.headers.getSetCookie().join(';'), /__Host-eden-ms=[^;]+;.*SameSite=Lax/i);
  assert.equal(landing(done), '/#outlook=connected');
  const code = ms.tokenCalls.find((c) => c.grant_type === 'authorization_code');
  assert.ok(code.code_verifier && code.redirect_uri === 'https://askeden.com/api/chat/microsoft/callback');
  const list = await accounts(session);
  assert.equal(list.outlook, true);
  const box = list.accounts.find((a) => a.id === id);
  assert.deepEqual({ provider: box.provider, kind: box.kind, email: box.email, status: box.status }, { provider: 'outlook', kind: 'outlook', email: 'me@outlook.com', status: 'ok' });
  assert.ok(!JSON.stringify(list).includes('ms-rt') && !JSON.stringify(list).includes('ms-at'), 'no token in what the page gets');
  assert.ok(!storedText().includes('ms-rt-1') && !storedText().includes('ms-at-1'), 'tokens stored sealed');
  // the same Microsoft account again (Reconnect) is the same mailbox
  const again = await addOutlook(session);
  assert.equal(again.id, id);
  assert.equal((await accounts(session)).accounts.filter((a) => a.provider === 'outlook').length, 1);
});

test('the sign-in refuses: a wrong state, a refused code, mail not granted; no first Gmail needed', async () => {
  const { session } = await signedIn();
  assert.equal(landing((await addOutlook(session, { state: 'forged' })).done), '/#outlook=error');
  assert.equal(landing((await addOutlook(session, { code: 'bad-code' })).done), '/#outlook=error');
  ms.scopes = 'https://graph.microsoft.com/User.Read openid profile email'; // unticked mail on the consent screen
  assert.equal(landing((await addOutlook(session)).done), '/#outlook=error');
  assert.equal((await accounts(session)).accounts.filter((a) => a.provider === 'outlook').length, 0, 'nothing kept');
  const other = await signedIn({ gmail: false, sub: 'apple-user-2' });
  ms.scopes = 'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read openid profile email';
  const alone = await addOutlook(other.session);
  assert.equal(landing(alone.done), '/#outlook=connected', 'no Gmail needed first');
  assert.deepEqual((await accounts(other.session)).accounts.map((a) => a.provider), ['outlook'], 'Outlook as the only mailbox');
});

test('the iPhone app adds Outlook or Gmail in a web sheet with no cookie: a ticket in the link, back to the app at the end', async () => {
  const { session } = await signedIn();
  const r = await accountsDo(session, { action: 'add', provider: 'outlook', app: true });
  const { url } = await r.json();
  assert.match(url, /^\/api\/chat\/microsoft\/connect\?t=[\w-]+\.[\w-]+$/);
  const start = await hit(url, {}); // the sheet: no askeden.com session cookie
  assert.equal(start.status, 302, await start.clone().text());
  const to = new URL(start.headers.get('location'));
  assert.equal(to.searchParams.get('redirect_uri'), 'https://askeden.com/api/chat/microsoft/callback');
  const done = await hit(`/api/chat/microsoft/callback?state=${to.searchParams.get('state')}&code=ms-code`, { cookie: `__Host-eden-ms=${cookieValue(start, '__Host-eden-ms')}`, headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(done.status, 302);
  assert.equal(done.headers.get('location'), 'com.askeden.eden://mail-added?ok=1', 'the sheet closes on the app’s scheme');
  assert.equal((await accounts(session)).accounts.filter((a) => a.provider === 'outlook').length, 1);
  // a refused sign-in also goes back to the app, saying so
  const r2 = await (await accountsDo(session, { action: 'add', provider: 'outlook', app: true })).json();
  const s2 = await hit(r2.url, {});
  const bad = await hit(`/api/chat/microsoft/callback?state=forged&code=ms-code`, { cookie: `__Host-eden-ms=${cookieValue(s2, '__Host-eden-ms')}`, headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(bad.headers.get('location'), 'com.askeden.eden://mail-added?ok=0');
  // the browser's own Add an account is unchanged: no ticket, back to the web app
  assert.equal((await (await accountsDo(session, { action: 'add', provider: 'outlook' })).json()).url, '/api/chat/microsoft/connect');
  // a forged or missing ticket starts nothing; a Gmail ticket only adds an account
  assert.equal((await hit('/api/chat/microsoft/connect?t=abc.def', {})).status, 401);
  assert.equal((await hit('/api/chat/microsoft/connect', {})).status, 401);
  const g = await (await accountsDo(session, { action: 'add', provider: 'gmail', app: true })).json();
  assert.match(g.url, /^\/api\/chat\/google\/connect\?scope=gmail&add=1&t=[\w-]+\.[\w-]+$/);
  assert.equal((await hit(g.url.replace('&add=1', ''), {})).status, 400);
  const gs = await hit(g.url, {});
  assert.equal(gs.status, 302, await gs.clone().text());
  const gto = new URL(gs.headers.get('location'));
  const gd = await hit(`/api/chat/google/callback?state=${gto.searchParams.get('state')}&code=forged-code`, { cookie: `__Host-eden-gdata=${cookieValue(gs, '__Host-eden-gdata')}`, headers: { 'sec-fetch-site': 'cross-site' } });
  assert.match(gd.headers.get('location') || '', /^com\.askeden\.eden:\/\/mail-added\?ok=[01]$/, 'Gmail’s ends on the app too');
});

test('reading: the inbox, a full email from its MIME (HTML cleaned, attachment), search, profile and history', async () => {
  const { session } = await signedIn();
  ms.add(msMail({ subject: 'Lunch', body: 'Are you free Friday?', id: '<lunch@example.com>' }), { received: Date.parse('2026-11-06T10:00:00Z') });
  const rich = [
    'From: =?utf-8?B?SsOpcsO0bWU=?= <j@example.fr>', 'To: me@outlook.com', 'Subject: =?utf-8?Q?Caf=C3=A9_menu?=', 'Date: Fri, 6 Nov 2026 11:00:00 +0000', 'Message-ID: <rich@example.fr>',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="M"', '', '--M', 'Content-Type: multipart/alternative; boundary="A"', '', '--A', 'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable', '', 'Le menu du caf=C3=A9 est joint.', '--A', 'Content-Type: text/html; charset=utf-8', '',
    '<p onclick="steal()">Le menu <b>joint</b></p><script>alert(1)</script>', '--A--', '--M', 'Content-Type: application/pdf; name="menu.pdf"', 'Content-Disposition: attachment; filename="menu.pdf"',
    'Content-Transfer-Encoding: base64', '', 'JVBERi0xLjQgbW9jaw==', '--M--', ''].join('\r\n');
  ms.add(rich, { received: Date.parse('2026-11-06T11:00:00Z') });
  ms.add(msMail({ from: 'me@outlook.com', to: 'Ana <ana@example.com>', subject: 'Re: Lunch', body: 'Yes!', inReplyTo: '<lunch@example.com>' }), { folder: 'sentitems', isRead: true, received: Date.parse('2026-11-06T12:00:00Z') });
  ms.add(msMail({ subject: 'Win a prize', body: 'spam' }), { folder: 'junkemail' });
  const { id } = await addOutlook(session);

  const res = await gmail(session, id, 'search', { mailbox: 'inbox', limit: 30 });
  assert.equal(res.status, 200, await res.clone().text());
  const { messages } = await res.json();
  assert.deepEqual(messages.map((m) => m.subject), ['Café menu', 'Lunch'], 'newest first, encoded subjects decoded');
  assert.equal(messages[0].from, 'Jérôme <j@example.fr>');
  assert.ok(messages.every((m) => m.unread && m.labels.includes('INBOX')));
  assert.ok(messages.every((m) => /^[A-Za-z0-9_-]{1,128}$/.test(m.id) && !m.id.includes('=')), 'Gmail-shaped ids');
  assert.ok(ms.calls.filter((c) => c.url.includes('/messages')).every((c) => c.prefer === 'IdType="ImmutableId"'), 'immutable ids asked for on every message call');

  const read = await (await gmail(session, id, 'read', { id: messages[0].id })).json();
  assert.equal(read.body.trim(), 'Le menu du café est joint.');
  assert.ok(read.html.includes('<b>joint</b>') && !/script|onclick/i.test(read.html), 'HTML cleaned by Eden’s Gmail code');
  assert.deepEqual(read.attachments.map((a) => [a.name, a.mime]), [['menu.pdf', 'application/pdf']]);
  const att = await (await gmail(session, id, 'attachment', { messageId: messages[0].id, attachmentId: read.attachments[0].attachmentId })).json();
  assert.equal(Buffer.from(att.data, 'base64').toString(), '%PDF-1.4 mock');
  assert.equal(ms.find((m) => m.subject === 'Café menu').isRead, false, 'reading isn’t marking read (Eden asks for that itself)');

  const sent = await (await gmail(session, id, 'search', { mailbox: 'sent', limit: 10 })).json();
  assert.deepEqual(sent.messages.map((m) => m.subject), ['Re: Lunch']);
  const found = await (await gmail(session, id, 'search', { query: 'from:ana@example.com OR to:ana@example.com', limit: 8 })).json();
  assert.deepEqual(found.messages.map((m) => m.subject).sort(), ['Lunch', 'Re: Lunch'], 'the sender card searches inbox and sent; spam left out');
  const unread = await (await gmail(session, id, 'search', { query: 'is:unread menu', limit: 8 })).json();
  assert.deepEqual(unread.messages.map((m) => m.subject), ['Café menu'], 'words and is:unread together (checked after Graph’s search)');
  const attached = await (await gmail(session, id, 'search', { query: 'has:attachment', limit: 8 })).json();
  assert.deepEqual(attached.messages.map((m) => m.subject), ['Café menu']);
  const prof = await (await gmail(session, id, 'profile')).json();
  assert.equal(prof.email, 'me@outlook.com');
  assert.match(prof.historyId, /^\d+$/);
  assert.equal((await (await gmail(session, id, 'history', { startHistoryId: prof.historyId })).json()).changes, 0);
  ms.add(msMail({ subject: 'New one' }));
  assert.equal((await (await gmail(session, id, 'history', { startHistoryId: prof.historyId })).json()).changes, 1, 'new mail shows in history');
});

test('paging and size: short page tokens Graph’s $skip; a message too big for Graph is refused before anything is made', async () => {
  for (let i = 0; i < 7; i++) ms.add(msMail({ subject: `Note ${i}` }), { received: Date.parse('2026-11-01T00:00:00Z') + i * 60_000 });
  const g = ms.grant();
  const shim = createGraphGmail({ fetch: ms.fetch, token: async () => g.access_token, email: 'me@outlook.com' });
  const base = 'https://gmail.googleapis.com/gmail/v1/users/me';
  const first = await (await shim.fetch(`${base}/messages?labelIds=INBOX&maxResults=5`)).json();
  assert.equal(first.messages.length, 5);
  assert.match(first.nextPageToken, /^[\w-]{1,200}$/, 'fits Gmail’s page token');
  const second = await (await shim.fetch(`${base}/messages?labelIds=INBOX&maxResults=5&pageToken=${first.nextPageToken}`)).json();
  assert.equal(second.messages.length, 2);
  assert.equal(second.nextPageToken, undefined);
  const raw = Buffer.from(`From: me@outlook.com\r\nTo: a@example.com\r\nSubject: big\r\n\r\n${'x'.repeat(3_000_000)}`).toString('base64url');
  const big = await shim.fetch(`${base}/messages/send`, { method: 'POST', body: JSON.stringify({ raw }) });
  assert.equal(big.status, 413);
  assert.match(shim.error.message, /about 3 MB/);
  assert.equal(ms.in('drafts').length + ms.in('sentitems').length, 0, 'nothing made or sent');
});

test('Done, undo, read, star: Outlook’s flags and the Archive folder', async () => {
  const { session } = await signedIn();
  ms.add(msMail({ subject: 'Invoice', id: '<inv-1@example.com>' }));
  const { id } = await addOutlook(session);
  const [m] = (await (await gmail(session, id, 'search', { mailbox: 'inbox' })).json()).messages;
  const before = (await (await gmail(session, id, 'profile')).json()).historyId;
  assert.equal((await gmail(session, id, 'modify', { ids: [m.id], add: ['STARRED'], remove: ['UNREAD'] })).status, 200);
  const x = ms.find((y) => y.subject === 'Invoice');
  assert.ok(x.isRead && x.flag.flagStatus === 'flagged');
  assert.equal((await (await gmail(session, id, 'history', { startHistoryId: before })).json()).changes, 1, 'a change shows in history');

  assert.equal((await gmail(session, id, 'modify', { ids: [m.id], add: [], remove: ['INBOX'] })).status, 200);
  assert.equal(ms.in('inbox').length, 0);
  assert.equal(ms.in('archive').length, 1, 'Done moves it to Archive');
  assert.equal((await gmail(session, id, 'modify', { ids: [m.id], add: [], remove: ['INBOX'] })).status, 200, 'Done twice is harmless');
  // Undo (and a snooze waking) names the same id: immutable, so it's found where it went
  assert.equal((await gmail(session, id, 'modify', { ids: [m.id], add: ['INBOX', 'UNREAD'], remove: [] })).status, 200);
  assert.equal(ms.in('archive').length, 0);
  assert.equal(ms.in('inbox').length, 1);
  assert.equal(x.isRead, false, 'back unread');
});

test('sending: a draft from the MIME Eden built, then sent; the approval is for that mailbox; a reply stays in its thread', async () => {
  const { session } = await signedIn();
  ms.add(msMail({ subject: 'Plans', id: '<plans@example.com>', from: 'Ana <ana@example.com>' }));
  const { id } = await addOutlook(session);
  const [orig] = (await (await gmail(session, id, 'search', { mailbox: 'inbox' })).json()).messages;
  const send = { to: ['Ana <ana@example.com>'], cc: ['lee@example.com'], bcc: ['me+copy@example.com'], subject: 'Re: Plans', body: 'Friday works.', inReplyTo: '<plans@example.com>', references: '<plans@example.com>', confirm: true };
  assert.equal((await gmail(session, id, 'send', send, { approveAs: null })).status, 403, 'an approval for the first Gmail doesn’t send from Outlook');
  const r = await gmail(session, id, 'send', send);
  assert.equal(r.status, 200, await r.clone().text());
  const out = await r.json();
  assert.equal(ms.sent.length, 1);
  assert.deepEqual(ms.sent[0].bcc.map((b) => b.emailAddress.address), ['me+copy@example.com'], 'Bcc handed to Outlook, which keeps it off what the others get');
  assert.match(ms.sent[0].raw, /^From: .*me@outlook\.com/m);
  assert.match(ms.sent[0].raw, /^In-Reply-To: <plans@example\.com>/m);
  assert.equal(ms.in('sentitems').length, 1, 'Outlook files it in Sent Items');
  assert.equal(ms.in('drafts').length, 0, 'no draft left behind');
  assert.equal(out.threadId, orig.threadId, 'the reply is in the email’s thread');
  const threads = await (await gmail(session, id, 'threads', { ids: [out.threadId] })).json();
  assert.equal(threads.threads[0].messages.length, 2);
  assert.equal((await gmail(session, id, 'schedule', { ...send, sendAt: Date.now() + 3600_000 })).status, 400, 'scheduled send stays on the first Gmail');
});

test('drafts: saved in Drafts, replaced on update, listed, opened, sent from there', async () => {
  const { session } = await signedIn();
  const { id } = await addOutlook(session);
  const first = await (await gmail(session, id, 'draft', { to: ['ana@example.com'], subject: 'Idea', body: 'v1' })).json();
  assert.equal(ms.in('drafts').length, 1);
  const second = await (await gmail(session, id, 'draft', { draftId: first.id, to: ['ana@example.com'], subject: 'Idea', body: 'v2' })).json();
  assert.equal(ms.in('drafts').length, 1, 'the old version is gone (not in Deleted Items either)');
  assert.equal(ms.in('deleteditems').length, 0);
  assert.notEqual(second.id, first.id);
  const listed = await (await gmail(session, id, 'drafts', {})).json();
  assert.deepEqual(listed.drafts.map((d) => d.draftId), [second.id]);
  const opened = await (await gmail(session, id, 'getDraft', { id: second.id })).json();
  assert.equal(opened.body.trim(), 'v2');
  const r = await gmail(session, id, 'send', { draftId: second.id, to: ['ana@example.com'], subject: 'Idea', body: 'v3', confirm: true });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(ms.in('drafts').length, 0, 'sent: no draft left behind');
  assert.equal(snippetOf(parseMessage(ms.sent[0].raw)), 'v3', 'the last version is what went');
});

test('tokens: refreshed when expired (the rotated refresh token kept); a revoked grant asks to sign in again', async () => {
  const { session } = await signedIn();
  ms.add(msMail({ subject: 'Hello' }));
  const { id } = await addOutlook(session);
  ms.access.clear(); // every access token expired
  const r = await gmail(session, id, 'search', { mailbox: 'inbox' });
  assert.equal(r.status, 200, await r.clone().text());
  const refreshes = ms.tokenCalls.filter((c) => c.grant_type === 'refresh_token');
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].refresh_token, 'ms-rt-1');
  const [accountId, account] = [...env.ACCOUNTS.objects.entries()].find(([, o]) => o.storage.map.has(`mbox:key:${id}`));
  const tokens = await openMailbox(env, accountId, id, account.storage.map.get(`mbox:key:${id}`));
  assert.equal(tokens.refresh, 'ms-rt-2', 'Microsoft’s new refresh token replaced the old one');
  assert.equal(tokens.provider, 'outlook');

  ms.access.clear();
  ms.refresh.clear(); // the person removed Eden from their Microsoft account
  const gone = await gmail(session, id, 'search', { mailbox: 'inbox' });
  assert.ok([401, 409].includes(gone.status), String(gone.status));
  const box = (await accounts(session)).accounts.find((a) => a.id === id);
  assert.equal(box.status, 'reconnect');
  const calls = ms.tokenCalls.length;
  assert.equal((await gmail(session, id, 'search', { mailbox: 'inbox' })).status, 409, 'no more tries until Reconnect');
  assert.equal(ms.tokenCalls.length, calls);
  // Reconnect: Microsoft's sign-in again puts it back
  await addOutlook(session);
  assert.equal((await accounts(session)).accounts.find((a) => a.id === id).status, 'ok');
});

test('removing an Outlook mailbox forgets its grant; Google is never sent Microsoft’s token', async () => {
  const { session } = await signedIn();
  const { id } = await addOutlook(session);
  const r = await accountsDo(session, { action: 'remove', id });
  assert.equal(r.status, 200, await r.clone().text());
  assert.ok(!(await r.json()).accounts.some((a) => a.id === id));
  assert.ok(!storedText().includes(`mbox:key:${id}`));
  assert.ok(!googleCalls.some((c) => c.url === 'https://oauth2.googleapis.com/revoke' && String(c.body || '').includes('ms-rt')));
});

test('Gmail searches as Graph: words as KQL, the rest as $filter or checked after', () => {
  const now = Date.parse('2026-11-08T00:00:00Z');
  const inbox = toGraphQuery('in:inbox is:unread', now);
  assert.deepEqual([inbox.folder, inbox.search, inbox.filter], ['inbox', null, ['isRead eq false']]);
  assert.equal(toGraphQuery('from:ana@example.com OR to:ana@example.com').search, 'from:ana@example.com OR to:ana@example.com');
  assert.equal(toGraphQuery('subject:"quarterly report" -from:bob').search, 'subject:\\"quarterly report\\" NOT from:bob');
  assert.equal(toGraphQuery('category:primary in:anywhere').folder, 'any');
  assert.equal(toGraphQuery('category:primary').search, null, 'Gmail’s tabs are left out');
  const q = toGraphQuery('newer_than:7d is:starred has:attachment', now);
  assert.deepEqual(q.filter, ['receivedDateTime ge 2026-11-01T00:00:00Z', "flag/flagStatus eq 'flagged'", 'hasAttachments eq true']);
  assert.equal(q.keep({ receivedDateTime: '2026-11-05T00:00:00Z', flag: { flagStatus: 'flagged' }, hasAttachments: true }), true);
  assert.equal(q.keep({ receivedDateTime: '2026-10-05T00:00:00Z', flag: { flagStatus: 'flagged' }, hasAttachments: true }), false);
  assert.deepEqual(toGraphQuery('-is:unread').filter, ['isRead eq true']);
  assert.equal(toGraphQuery('OR lunch OR').search, 'lunch', 'dangling ORs dropped');
});

test('ids, scopes and the id_token', () => {
  const gid = 'AAkAAAAAAB2EAxFqZhHNm8gAqgAvhFoN-_9tc2ctMQ==';
  assert.equal(edenIdOf(gid), 'AAkAAAAAAB2EAxFqZhHNm8gAqgAvhFoN-_9tc2ctMQ');
  assert.equal(graphIdOf(edenIdOf(gid)), gid);
  assert.equal(edenIdOf('a/b+c='), null, 'not Gmail’s characters');
  assert.equal(edenIdOf('A'.repeat(129)), null, 'too long for a Gmail id');
  assert.ok(hasOutlookScopes(['Mail.ReadWrite', 'Mail.Send']));
  assert.ok(hasOutlookScopes(['https://graph.microsoft.com/Mail.ReadWrite', 'https://graph.microsoft.com/mail.send']));
  assert.ok(!hasOutlookScopes(['https://graph.microsoft.com/Mail.Read', 'https://graph.microsoft.com/Mail.Send']));
  const tok = (c) => `e30.${b64url(new TextEncoder().encode(JSON.stringify(c)))}.sig`;
  const good = { iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: MS_CLIENT_ID, tid: TENANT, oid: 'o1', preferred_username: 'x@outlook.com', name: 'X' };
  assert.deepEqual(msIdClaims(tok(good), MS_CLIENT_ID), { sub: `ms:${TENANT}:o1`, email: 'x@outlook.com', name: 'X' });
  assert.equal(msIdClaims(tok({ ...good, aud: 'someone-else' }), MS_CLIENT_ID), null);
  assert.equal(msIdClaims(tok({ ...good, iss: 'https://evil.example/v2.0' }), MS_CLIENT_ID), null);
  assert.equal(msIdClaims('garbage', MS_CLIENT_ID), null);
});
