// Eden Mail with several Gmail accounts (src/eden/mailboxes.js, src/accounts/mailboxes.js, the
// mailbox parts of src/eden/google-data.js) against a fake Google in globalThis.fetch below.
// Nothing here reaches the real Google.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { approvalHash } from '../src/eden/google-data.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { MBOX_ID, nextColor, openMailbox, sealMailbox } from '../src/accounts/mailboxes.js';
import { mailboxMax, pickMailbox } from '../src/eden/mailboxes.js';
import { b64url, bytesToB64 } from '../src/accounts/util.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Link, appleJwk, identityToken, namespace } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const CLIENT_ID = '1234-test.apps.googleusercontent.com';
const GMAIL = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.modify'];

let env;
let waits;
let google;
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;

const idToken = (claims) => `${b64url(new TextEncoder().encode('{"alg":"none"}'))}.${b64url(new TextEncoder().encode(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT_ID, ...claims })))}.sig`;
const OWNER = { sub: 'g-owner', email: 'owner@gmail.com', refresh: 'rt-owner' };
const WORK = { sub: 'g-work', email: 'work@gmail.com', refresh: 'rt-work' };
const SIDE = { sub: 'g-side', email: 'side@gmail.com', refresh: 'rt-side' };

/** A fake Google that knows whose access token is whose, so a call shows which account it reached. */
function fakeGoogle() {
  const g = {
    grant: { ...OWNER, scopes: ['openid', ...GMAIL], expires: 3600 },
    access: 0,
    owner: new Map(), // access token → email
    refreshOwner: new Map([[OWNER.refresh, OWNER.email], [WORK.refresh, WORK.email], [SIDE.refresh, SIDE.email]]),
    refreshes: 0,
    refreshFails: false,
    revoked: [],
    sent: [],
    calls: [],
  };
  g.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const auth = String((init.headers || {}).authorization || '');
    g.calls.push({ url, method, auth });
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    if (url === 'https://oauth2.googleapis.com/revoke') {
      g.revoked.push(new URLSearchParams(init.body).get('token'));
      return new Response('{}', { status: 200 });
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(init.body);
      if (form.get('grant_type') === 'authorization_code') {
        if (form.get('code') !== 'good-code') return Response.json({ error: 'invalid_grant' }, { status: 400 });
        const t = g.grant;
        const at = `at-${++g.access}`;
        g.owner.set(at, t.email);
        return Response.json({ access_token: at, expires_in: t.expires, scope: t.scopes.join(' '), id_token: idToken({ sub: t.sub, email: t.email }), ...(t.refresh ? { refresh_token: t.refresh } : {}) });
      }
      if (form.get('grant_type') === 'refresh_token') {
        g.refreshes++;
        if (g.refreshFails) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        const at = `at-${++g.access}`;
        g.owner.set(at, g.refreshOwner.get(form.get('refresh_token')));
        return Response.json({ access_token: at, expires_in: 3600, scope: GMAIL.join(' ') });
      }
    }
    if (u.host === 'gmail.googleapis.com') {
      const who = g.owner.get(auth.replace(/^Bearer /, ''));
      if (!who) return new Response('{"error":{"code":401}}', { status: 401 });
      const p = u.pathname.replace('/gmail/v1/users/me', '');
      if (p === '/profile') return Response.json({ emailAddress: who, messagesTotal: 1, threadsTotal: 1, historyId: '7' });
      if (p === '/messages' && method === 'GET') return Response.json({ messages: [{ id: who.startsWith('work') ? '19aa01' : '18c0a1' }], resultSizeEstimate: 1 });
      if (/^\/messages\/[0-9a-f]+$/.test(p)) {
        const id = p.slice('/messages/'.length);
        return Response.json({ id, threadId: id, snippet: 'Hi', labelIds: ['INBOX'], internalDate: '1759700000000', payload: { headers: [{ name: 'From', value: 'Ana <ana@example.com>' }, { name: 'Subject', value: `To ${who}` }, { name: 'To', value: who }] } });
      }
      if (p === '/messages/send' && method === 'POST') {
        g.sent.push({ who, raw: Buffer.from(JSON.parse(init.body).raw, 'base64url').toString() });
        return Response.json({ id: '18c0b2', threadId: '18c0b2' });
      }
      if (p === '/messages/batchModify' && method === 'POST') return new Response(null, { status: 204 });
      if (p === '/settings/sendAs') return Response.json({ sendAs: [{ sendAsEmail: who, isPrimary: true, isDefault: true }] });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  return g;
}

function makeEnv(extra = {}) {
  const e = { ANTHROPIC_API_KEY: 'sk-test', GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'client-secret', EDEN_TOKEN_KEY: bytesToB64(new Uint8Array(32).fill(7)), MAIL_MULTI: 'on', ...extra };
  e.ACCOUNTS = namespace(Account, e);
  e.LINKS = namespace(Link, e);
  e.ASSETS = { fetch: async () => new Response('asset') };
  return e;
}

beforeEach(() => {
  waits = [];
  forgetAppleKeys();
  forgetSessions();
  google = fakeGoogle();
  globalThis.fetch = (input, init) => google.fetch(typeof input === 'string' ? input : input.url, init);
  env = makeEnv();
});
after(() => {
  globalThis.fetch = realFetch;
});

async function hit(p, { method = 'GET', body, headers = {}, session, cookie, token, approve = true, approveAs } = {}) {
  // The page mints an approval for a send as part of the click (web/chat/api.js), with its mailbox.
  if (approve && p === '/api/chat/gmail' && body && ['send', 'schedule'].includes(body.action) && !headers['x-eden-approval']) {
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
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  const response = await worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
  while (waits.length) await Promise.all(waits.splice(0));
  if ((response.headers.get('content-type') || '').startsWith('text/html')) response.__html = await response.clone().text();
  return response;
}
const setCookie = (response, name) => (response.headers.getSetCookie() || []).find((c) => c.startsWith(`${name}=`));
const cookieValue = (response, name) => (setCookie(response, name) || '').slice(name.length + 1).split(';')[0];

async function phone(sub = 'apple-user-1') {
  const response = await hit('/api/account/apple', { method: 'POST', headers: { origin: null }, body: { identity_token: await identityToken({ sub }), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } } });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function signedInBrowser(owner) {
  const started = await hit('/api/web/link', { method: 'POST', body: {} });
  const link = await started.json();
  const linkCookie = `__Host-eden-link=${cookieValue(started, '__Host-eden-link')}`;
  assert.equal((await hit(`/api/link/${link.code}/approve`, { method: 'POST', headers: { origin: null }, token: owner.token, body: { sealed_key: null, sender_key: null } })).status, 200);
  const done = await hit('/api/web/link/poll', { method: 'POST', body: {}, cookie: linkCookie });
  assert.equal(done.status, 200);
  return cookieValue(done, '__Host-eden');
}
const chat = (p, session, opts = {}) => hit(p, { session, ...opts, headers: { 'x-jarvis-chat': '1', ...(opts.headers || {}) } });
const gmail = (session, action, args = {}, mailbox, opts = {}) => chat('/api/chat/gmail', session, { method: 'POST', body: { action, args, ...(mailbox ? { mailbox } : {}) }, ...opts });
const accounts = async (session) => chat('/api/chat/mail/accounts', session);
const accountsDo = (session, body) => chat('/api/chat/mail/accounts', session, { method: 'POST', body });
const landing = (r) => (r.__html === undefined ? undefined : (/http-equiv="refresh" content="0; url=([^"]+)"/.exec(r.__html) || [])[1]);

/** The consent round trip; `url` is where the page goes (Connect Gmail, or Add an account's url). */
async function consent(session, url, grant) {
  google.grant = { scopes: ['openid', ...GMAIL], expires: 3600, ...grant };
  const start = await hit(url, { session });
  assert.equal(start.status, 302, await start.clone().text());
  const to = new URL(start.headers.get('location'));
  const done = await hit(`/api/chat/google/callback?state=${to.searchParams.get('state')}&code=good-code&scope=x`, { cookie: `__Host-eden-gdata=${cookieValue(start, '__Host-eden-gdata')}`, headers: { 'sec-fetch-site': 'cross-site' } });
  return { to, done };
}
const connectFirst = (session) => consent(session, '/api/chat/google/connect?scope=gmail', OWNER);
async function addAccount(session, grant) {
  const r = await accountsDo(session, { action: 'add', provider: 'gmail' });
  assert.equal(r.status, 200, await r.clone().text());
  const { url } = await r.json();
  assert.equal(url, '/api/chat/google/connect?scope=gmail&add=1');
  return consent(session, url, grant);
}
const storedText = () => JSON.stringify([...env.ACCOUNTS.objects.values()].map((o) => [...o.storage.map]));

test('MAIL_MULTI off: no accounts route, no mailbox param, and add=1 is an ordinary connect', async () => {
  env = makeEnv({ MAIL_MULTI: '' });
  const session = await signedInBrowser(await phone());
  await connectFirst(session);
  assert.equal((await accounts(session)).status, 404);
  assert.equal((await accountsDo(session, { action: 'add' })).status, 404);
  const r = await gmail(session, 'profile', {}, 'm0123456789ab');
  assert.equal(r.status, 404);
  assert.equal((await gmail(session, 'profile', {}, 'primary')).status, 200, "'primary' is the first Gmail either way");
  const { to } = await consent(session, '/api/chat/google/connect?scope=gmail&add=1', WORK);
  assert.notEqual(to.searchParams.get('prompt'), 'select_account consent');
  assert.equal((await (await chat('/api/chat/google/status', session)).json()).email, 'work@gmail.com', 'without the switch a second account replaces the first, as before');
});

test('the list: the first Gmail as "primary", then added mailboxes; no secrets, ids and colours', async () => {
  const session = await signedInBrowser(await phone());
  const before = await (await accounts(session)).json();
  assert.deepEqual({ ...before, providers: before.providers.map((x) => x.kind) }, { multi: true, max: 10, accounts: [], providers: ['icloud', 'yahoo', 'aol', 'fastmail', 'zoho', 'gmx'], outlook: false }, 'nothing connected yet; the password providers offered');
  const first = await accountsDo(session, { action: 'add' });
  assert.equal(first.status, 200, 'no Gmail needed first: Add offers the consent (it becomes the first Gmail)');
  assert.equal((await first.json()).url, '/api/chat/google/connect?scope=gmail&add=1');
  await connectFirst(session);
  const { to, done } = await addAccount(session, WORK);
  assert.equal(to.searchParams.get('prompt'), 'select_account consent', 'the account chooser, and a refresh token');
  assert.equal(to.searchParams.get('login_hint'), null);
  assert.equal(landing(done), '/#gmail=connected');
  const list = await (await accounts(session)).json();
  assert.equal(list.accounts.length, 2);
  assert.deepEqual(list.accounts[0], { id: 'primary', provider: 'gmail', kind: 'gmail', email: 'owner@gmail.com', label: '', color: 'indigo', primary: true, status: 'ok' });
  const work = list.accounts[1];
  assert.match(work.id, MBOX_ID);
  assert.deepEqual({ ...work, id: 'x' }, { id: 'x', provider: 'gmail', kind: 'gmail', email: 'work@gmail.com', label: '', color: 'teal', primary: false, status: 'ok' });
  assert.ok(!JSON.stringify(list).includes('g-work'), 'no Google sub in the page');
  assert.equal(google.revoked.length, 0, 'adding never revokes the first Gmail');
  assert.equal((await (await chat('/api/chat/google/status', session)).json()).email, 'owner@gmail.com', 'the first Gmail stays');
  const stored = storedText();
  for (const secret of ['rt-owner', 'rt-work', 'at-1', 'at-2']) assert.ok(!stored.includes(secret), `${secret} is stored sealed`);

  // The same account again refreshes its mailbox; the first Gmail through Add stays the first.
  await addAccount(session, WORK);
  await addAccount(session, OWNER);
  const again = await (await accounts(session)).json();
  assert.deepEqual(again.accounts.map((a) => a.email), ['owner@gmail.com', 'work@gmail.com']);
  assert.equal(again.accounts[1].id, work.id);
});

test('Gmail actions go to the mailbox named; sends need an approval for that mailbox', async () => {
  const session = await signedInBrowser(await phone());
  await connectFirst(session);
  await addAccount(session, WORK);
  const id = (await (await accounts(session)).json()).accounts[1].id;
  assert.equal((await (await gmail(session, 'profile')).json()).email, 'owner@gmail.com');
  assert.equal((await (await gmail(session, 'profile', {}, id)).json()).email, 'work@gmail.com');
  const found = await (await gmail(session, 'search', { mailbox: 'inbox', limit: 5 }, id)).json();
  assert.equal(found.messages[0].id, '19aa01');
  const mod = await gmail(session, 'modify', { ids: ['19aa01'], add: [], remove: ['UNREAD'] }, id);
  assert.equal(mod.status, 200, await mod.clone().text());
  assert.equal((await gmail(session, 'profile', {}, 'mffffffffffff')).status, 409, 'not one of yours');
  assert.equal((await gmail(session, 'profile', {}, '../x')).status, 400);

  const send = { to: ['ana@example.com'], subject: 'Hi', body: 'Hello', confirm: true };
  const wrong = await gmail(session, 'send', send, id, { approveAs: null });
  assert.equal(wrong.status, 403, "an approval for the first Gmail doesn't send from another");
  assert.equal(google.sent.length, 0);
  const ok = await gmail(session, 'send', send, id);
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal(google.sent.at(-1).who, 'work@gmail.com');
  assert.match(google.sent.at(-1).raw, /^From: work@gmail\.com/m);
  assert.equal((await gmail(session, 'send', send)).status, 200);
  assert.equal(google.sent.at(-1).who, 'owner@gmail.com');
  const sched = await gmail(session, 'schedule', { ...send, sendAt: Date.now() + 3600_000 }, id);
  assert.equal(sched.status, 400);
  assert.match((await sched.json()).error, /first Gmail/);
});

test('names, colours and removing a mailbox (its grant revoked at Google)', async () => {
  const session = await signedInBrowser(await phone());
  await connectFirst(session);
  await addAccount(session, WORK);
  const id = (await (await accounts(session)).json()).accounts[1].id;
  let r = await accountsDo(session, { action: 'edit', id, label: '  Work\n mail ', color: 'pink' });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).accounts.map((a) => [a.label, a.color]), [['', 'indigo'], ['Work mail', 'pink']]);
  r = await accountsDo(session, { action: 'edit', id: 'primary', label: 'Personal' });
  assert.equal((await r.json()).accounts[0].label, 'Personal');
  assert.equal((await accountsDo(session, { action: 'edit', id, color: 'neon' })).status, 400);
  assert.equal((await accountsDo(session, { action: 'edit', id, label: 'x'.repeat(41) })).status, 400);
  assert.equal((await accountsDo(session, { action: 'remove', id: 'primary' })).status, 400, 'the first Gmail is disconnected in Settings');
  r = await accountsDo(session, { action: 'remove', id });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).accounts.map((a) => a.id), ['primary']);
  assert.deepEqual(google.revoked, ['rt-work']);
  assert.equal((await gmail(session, 'profile', {}, id)).status, 409);
  assert.ok(!storedText().includes(id), 'nothing of it is kept');
});

test('refreshes save to that mailbox; a refused refresh token marks it for reconnecting', async () => {
  const session = await signedInBrowser(await phone());
  await connectFirst(session);
  await addAccount(session, { ...WORK, expires: 30 }); // inside the 60 s margin
  const id = (await (await accounts(session)).json()).accounts[1].id;
  assert.equal((await (await gmail(session, 'profile', {}, id)).json()).email, 'work@gmail.com');
  assert.equal(google.refreshes, 1);
  assert.equal((await gmail(session, 'profile', {}, id)).status, 200);
  assert.equal(google.refreshes, 1, 'the refreshed token was kept for the next call');
  assert.equal((await (await gmail(session, 'profile')).json()).email, 'owner@gmail.com', "the first Gmail's token is its own");

  google.owner.clear(); // every access token now refused…
  google.refreshFails = true; // …and the refresh token too
  const r = await gmail(session, 'profile', {}, id);
  assert.equal(r.status, 401);
  assert.equal((await r.json()).code, 'reconnect');
  const list = await (await accounts(session)).json();
  assert.equal(list.accounts[1].status, 'reconnect');
  const again = await gmail(session, 'profile', {}, id);
  assert.equal(again.status, 409);
  assert.equal((await again.json()).code, 'reconnect');
  google.refreshFails = false;
  await addAccount(session, WORK);
  assert.equal((await (await accounts(session)).json()).accounts[1].status, 'ok', 'adding it again reconnects it');
});

test('at most MAIL_MULTI_MAX mailboxes; a grant past the limit is revoked, not kept', async () => {
  env = makeEnv({ MAIL_MULTI_MAX: '2' });
  const session = await signedInBrowser(await phone());
  await connectFirst(session);
  await addAccount(session, WORK);
  const r = await accountsDo(session, { action: 'add' });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'too_many');
  // A consent started before the limit was reached (another tab): refused at the callback, and revoked.
  const { done } = await consent(session, '/api/chat/google/connect?scope=gmail&add=1', SIDE);
  assert.equal(landing(done), '/#gmail=error');
  assert.deepEqual(google.revoked, ['rt-side']);
  assert.equal((await (await accounts(session)).json()).accounts.length, 2);
  assert.equal(mailboxMax({}), 10);
  assert.equal(mailboxMax({ MAIL_MULTI_MAX: '1' }), 10, 'out of range: the default');
  assert.equal(mailboxMax({ MAIL_MULTI_MAX: '25' }), 25);
});

test('a sealed mailbox opens only for its own account and mailbox', async () => {
  const sealed = await sealMailbox(env, 'acct-1', 'm0000000000aa', { refresh: 'r' });
  assert.deepEqual(await openMailbox(env, 'acct-1', 'm0000000000aa', sealed), { refresh: 'r' });
  assert.equal(await openMailbox(env, 'acct-1', 'm0000000000bb', sealed), null);
  assert.equal(await openMailbox(env, 'acct-2', 'm0000000000aa', sealed), null);
  assert.equal(nextColor(['indigo', 'teal']), 'pink');
  assert.equal(pickMailbox(env, 'primary'), null);
  assert.equal(pickMailbox(env, undefined), null);
  assert.throws(() => pickMailbox(env, 'primary2'));
});

test('deleting the Eden account revokes every mailbox at Google', async () => {
  const owner = await phone();
  const session = await signedInBrowser(owner);
  await connectFirst(session);
  await addAccount(session, WORK);
  await addAccount(session, SIDE);
  const r = await hit('/api/account', { method: 'DELETE', token: owner.token, headers: { origin: null } });
  assert.equal(r.status, 204, await r.clone().text());
  assert.deepEqual(google.revoked.sort(), ['rt-owner', 'rt-side', 'rt-work']);
});
