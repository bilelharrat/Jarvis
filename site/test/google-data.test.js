// Hosted Gmail and Google Calendar (src/eden/google-data.js, src/accounts/tokens.js) against a
// fake Google: its token, revoke, Gmail and Calendar endpoints live in globalThis.fetch below.
// Nothing here reaches the real Google.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { b64url, bytesToB64, sha256 } from '../src/accounts/util.js';
import { fakeBase, hasGmailScopes } from '../src/eden/google-data.js';
import { streamAttachmentData } from '../src/eden/gmail-uploads.js';
import { wrapFrom } from '../src/accounts/mail-uploads.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Link, appleJwk, identityToken, namespace } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const CLIENT_ID = '1234-test.apps.googleusercontent.com'; // googleReady wants this shape
const GMAIL = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'];
const CAL = ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'];

let env;
let waits;
let google; // the fake Google's state
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;

const idToken = (claims) => `${b64url(new TextEncoder().encode('{"alg":"none"}'))}.${b64url(new TextEncoder().encode(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT_ID, ...claims })))}.sig`;

function fakeGoogle() {
  const g = {
    calls: [],
    revoked: [],
    // what the next authorization code gives
    grant: { sub: 'g-sub-1', email: 'owner@gmail.com', scopes: ['openid', 'https://www.googleapis.com/auth/userinfo.email', ...GMAIL], refresh: 'rt-1', expires: 3600 },
    refreshes: 0,
    refreshFails: false,
    access: 0,
    sent: [],
    events: [],
    drafts: new Map(), // draft id → its MIME text
    sessions: [], // resumable uploads: { path, method, meta, length, puts: [{ range, bytes }], mime }
    attachments: {}, // attachment id → Buffer (messages.attachments.get)
  };
  // What Gmail does with a message, however it came (raw JSON or a resumable upload).
  const take = (p, method, meta, mime) => {
    if (p === '/messages/send') {
      g.sent.push({ ...meta, mime });
      return Response.json({ id: `18c0b${g.sent.length + 1}`, threadId: '18c0b2' });
    }
    const id = method === 'PUT' ? p.slice('/drafts/'.length) : `r${g.drafts.size + 1}`;
    if (method === 'PUT' && !g.drafts.has(id)) return Response.json({ error: { code: 404, message: 'Not Found' } }, { status: 404 });
    g.drafts.set(id, mime);
    return Response.json({ id, message: { id: `m${id}`, threadId: 't1' } });
  };
  g.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const auth = (init.headers || {}).authorization || '';
    g.calls.push({ url, method, auth, body: init.body });
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    if (url === 'https://oauth2.googleapis.com/revoke') {
      g.revoked.push(new URLSearchParams(init.body).get('token'));
      return new Response('{}', { status: 200 });
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(init.body);
      if (form.get('client_secret') !== 'client-secret') return Response.json({ error: 'invalid_client' }, { status: 401 });
      if (form.get('grant_type') === 'authorization_code') {
        if (form.get('code') !== 'good-code') return Response.json({ error: 'invalid_grant' }, { status: 400 });
        g.verifier = form.get('code_verifier');
        g.redirect = form.get('redirect_uri');
        const t = g.grant;
        return Response.json({
          access_token: `at-${++g.access}`,
          expires_in: t.expires,
          scope: t.scopes.join(' '),
          id_token: idToken({ sub: t.sub, email: t.email }),
          ...(t.refresh ? { refresh_token: t.refresh } : {}),
        });
      }
      if (form.get('grant_type') === 'refresh_token') {
        g.refreshes++;
        if (g.refreshFails) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        g.lastRefresh = form.get('refresh_token');
        return Response.json({ access_token: `at-${++g.access}`, expires_in: 3600, scope: g.grant.scopes.join(' ') });
      }
    }
    if (u.host === 'gmail.googleapis.com') {
      const p = u.pathname.replace('/gmail/v1/users/me', '');
      if (p === '/profile') return Response.json({ emailAddress: 'owner@gmail.com', messagesTotal: 2, threadsTotal: 2 });
      if (p === '/messages' && method === 'GET') return Response.json({ messages: [{ id: '18c0a1' }], resultSizeEstimate: 1 });
      if (p === '/messages/18c0a1') {
        return Response.json({ id: '18c0a1', threadId: '18c0a1', snippet: 'Hello', labelIds: ['INBOX'], internalDate: '1759700000000', payload: { headers: [{ name: 'From', value: 'Ana <ana@example.com>' }, { name: 'Subject', value: 'Lunch' }, { name: 'To', value: 'owner@gmail.com' }] } });
      }
      if (p === '/messages/send' && method === 'POST') {
        g.sent.push(JSON.parse(init.body));
        return Response.json({ id: '18c0b2', threadId: '18c0b2' });
      }
      // Drafts, Gmail's resumable upload (start, then PUTs with Content-Range) and attachments, for uploads ahead.
      if ((p === '/drafts' && method === 'POST') || (/^\/drafts\/r\d+$/.test(p) && method === 'PUT')) {
        const j = JSON.parse(init.body);
        return take(p, method, j, Buffer.from(j.message.raw, 'base64url').toString());
      }
      if (p === '/drafts/send' && method === 'POST') {
        const { id } = JSON.parse(init.body);
        if (!g.drafts.has(id)) return Response.json({ error: { code: 404, message: 'Not Found' } }, { status: 404 });
        g.sent.push({ draft: id, mime: g.drafts.get(id) });
        g.drafts.delete(id);
        return Response.json({ id: '18c0b9', threadId: 't1' });
      }
      const upload = /^\/upload(\/(?:drafts(?:\/r\d+)?|messages\/send))$/.exec(p);
      if (upload && u.searchParams.get('uploadType') === 'resumable' && !u.searchParams.has('upload_id')) {
        g.sessions.push({ path: upload[1], method, meta: JSON.parse(init.body), length: Number(init.headers['x-upload-content-length']), type: init.headers['x-upload-content-type'], puts: [] });
        return new Response('{}', { status: 200, headers: { location: `${url}&upload_id=u${g.sessions.length}` } });
      }
      if (upload && method === 'PUT' && u.searchParams.has('upload_id')) {
        const s = g.sessions[Number(u.searchParams.get('upload_id').slice(1)) - 1];
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(init.headers['content-range'] || '');
        const have = s.puts.reduce((n, x) => n + x.bytes.length, 0);
        const bytes = Buffer.from(init.body);
        if (!range || Number(range[1]) !== have || Number(range[2]) !== have + bytes.length - 1 || Number(range[3]) !== s.length) return new Response('bad range', { status: 400 });
        s.puts.push({ range: init.headers['content-range'], bytes });
        if (have + bytes.length < s.length) return new Response(null, { status: 308, headers: { range: `bytes=0-${have + bytes.length - 1}` } });
        s.mime = Buffer.concat(s.puts.map((x) => x.bytes)).toString();
        return take(s.path, s.method, s.meta, s.mime);
      }
      const att = /^\/messages\/[0-9a-z]+\/attachments\/([A-Za-z0-9_-]+)$/.exec(p);
      if (att && method === 'GET') {
        const a = g.attachments[att[1]];
        if (!a) return Response.json({ error: { code: 404, message: 'Not Found' } }, { status: 404 });
        return Response.json(u.searchParams.get('fields') === 'size' ? { size: a.length } : { size: a.length, data: a.toString('base64url') });
      }
    }
    if (u.host === 'www.googleapis.com' && u.pathname.startsWith('/calendar/v3')) {
      const p = u.pathname.replace('/calendar/v3', '');
      if (p === '/users/me/calendarList') return Response.json({ items: [{ id: 'primary@gmail.com', summary: 'Owner', primary: true, accessRole: 'owner', selected: true, backgroundColor: '#4285f4', timeZone: 'Europe/Paris' }] });
      if (p.endsWith('/events') && method === 'GET') return Response.json({ items: g.events });
      if (p.endsWith('/events') && method === 'POST') {
        const e = { id: `ev${g.events.length + 1}`, status: 'confirmed', ...JSON.parse(init.body) };
        g.events.push(e);
        return Response.json(e);
      }
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  return g;
}

function makeEnv(extra = {}) {
  const e = {
    ANTHROPIC_API_KEY: 'sk-test',
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: 'client-secret',
    EDEN_TOKEN_KEY: bytesToB64(new Uint8Array(32).fill(7)),
    ...extra,
  };
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

async function hit(p, { method = 'GET', body, headers = {}, session, cookie, token, origin = ORIGIN } = {}) {
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
  const response = await worker.fetch(new Request(`${origin}${p}`, init), env, ctx);
  while (waits.length) await Promise.all(waits.splice(0));
  if ((response.headers.get('content-type') || '').startsWith('text/html')) response.__html = await response.clone().text();
  return response;
}

const setCookie = (response, name) => (response.headers.getSetCookie() || []).find((c) => c.startsWith(`${name}=`));
const cookieValue = (response, name) => (setCookie(response, name) || '').slice(name.length + 1).split(';')[0];

async function phone(sub = 'apple-user-1') {
  const response = await hit('/api/account/apple', { method: 'POST', origin: ORIGIN, headers: { origin: null }, body: { identity_token: await identityToken({ sub }), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } } });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

async function signedInBrowser(owner) {
  const started = await hit('/api/web/link', { method: 'POST', body: {} });
  const link = await started.json();
  const linkCookie = `__Host-eden-link=${cookieValue(started, '__Host-eden-link')}`;
  const approved = await hit(`/api/link/${link.code}/approve`, { method: 'POST', headers: { origin: null }, token: owner.token, body: { sealed_key: null, sender_key: null } });
  assert.equal(approved.status, 200, await approved.clone().text());
  const done = await hit('/api/web/link/poll', { method: 'POST', body: {}, cookie: linkCookie });
  assert.equal(done.status, 200, await done.clone().text());
  return cookieValue(done, '__Host-eden');
}

const chat = (p, session, opts = {}) => hit(p, { session, ...opts, headers: { 'x-jarvis-chat': '1', ...(opts.headers || {}) } });
const gmail = (session, action, args = {}) => chat('/api/chat/gmail', session, { method: 'POST', body: { action, args } });
const gcal = (session, action, args = {}) => chat('/api/chat/gcal', session, { method: 'POST', body: { action, args } });

/** The whole consent round trip for `scope`: { start (the 302 to Google), done (the callback's answer) }. */
async function connect(session, scope, { code = 'good-code', state, mangle } = {}) {
  const { url } = await (await chat('/api/chat/google/connect', session, { method: 'POST', body: { scope } })).json();
  assert.equal(url, `/api/chat/google/connect?scope=${scope}`);
  const start = await hit(url, { session }); // a top-level navigation: no X-Jarvis-Chat
  assert.equal(start.status, 302, await start.clone().text());
  const to = new URL(start.headers.get('location'));
  let value = cookieValue(start, '__Host-eden-gdata');
  if (mangle) value = mangle(value);
  // Google's redirect back is cross-site: the SameSite=Strict session cookie doesn't come.
  const done = await hit(`/api/chat/google/callback?state=${state ?? to.searchParams.get('state')}&code=${code}&scope=x`, { cookie: `__Host-eden-gdata=${value}`, headers: { 'sec-fetch-site': 'cross-site' } });
  return { start, to, done };
}

/** Where the callback's page moves on to (its meta refresh). */
const landing = (response) => {
  const html = response.__html;
  return html === undefined ? undefined : (/http-equiv="refresh" content="0; url=([^"]+)"/.exec(html) || [])[1];
};

const storedText = () => JSON.stringify([...env.ACCOUNTS.objects.values()].map((o) => [...o.storage.map]));

test('Google data stays "needs your Mac" until the client and EDEN_TOKEN_KEY are set', async () => {
  env = makeEnv({ EDEN_TOKEN_KEY: '' });
  const session = await signedInBrowser(await phone());
  const r = await chat('/api/chat/google/status', session);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).code, 'needs_mac');
  env.EDEN_TOKEN_KEY = bytesToB64(new Uint8Array(32).fill(7));
  assert.deepEqual(await (await chat('/api/chat/google/status', session)).json(), { configured: true, connected: false, email: null, gmail: false, calendar: false, hosted: true });
  assert.deepEqual(await (await chat('/api/chat/gcal/status', session)).json(), { configured: true, connected: false, email: null, calendar: false, hosted: true });
  assert.equal((await gmail(session, 'search')).status, 409);
  assert.equal((await chat('/api/chat/google/config', session, { method: 'POST', body: { clientId: 'x', clientSecret: 'y' } })).status, 400);
  assert.equal((await hit('/api/chat/google/status', { headers: { 'x-jarvis-chat': '1' } })).status, 401, 'signed out');
});

test('Connect Gmail: its own consent (PKCE, offline, incremental), sealed state cookie, tokens sealed in the account', async () => {
  const session = await signedInBrowser(await phone());
  const { start, to, done } = await connect(session, 'gmail');
  assert.equal(to.origin + to.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const q = to.searchParams;
  assert.deepEqual(q.get('scope').split(' '), ['openid', 'email', ...GMAIL], 'Gmail only: no calendar, no gmail.send (compose covers it)');
  assert.equal(q.get('client_id'), CLIENT_ID);
  assert.equal(q.get('redirect_uri'), `${ORIGIN}/api/chat/google/callback`);
  assert.equal(q.get('access_type'), 'offline');
  assert.equal(q.get('include_granted_scopes'), 'true');
  assert.equal(q.get('prompt'), 'consent', 'no refresh token yet');
  assert.equal(q.get('code_challenge_method'), 'S256');
  const gdata = setCookie(start, '__Host-eden-gdata');
  assert.match(gdata, /HttpOnly/);
  assert.match(gdata, /Secure/);
  assert.match(gdata, /SameSite=Lax/);
  assert.match(gdata, /Max-Age=600/);
  assert.ok(!gdata.includes(q.get('state')), 'the state is sealed, not readable in the cookie');
  assert.equal(start.headers.get('referrer-policy'), 'no-referrer');

  assert.equal(done.status, 200, 'a page of ours, so the Strict session cookie comes along on the way back');
  assert.match(done.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(landing(done), '/#gmail=connected');
  assert.match(setCookie(done, '__Host-eden-gdata'), /Max-Age=0/);
  assert.equal(google.redirect, `${ORIGIN}/api/chat/google/callback`);
  assert.equal(b64url(await sha256(google.verifier)), q.get('code_challenge'), 'the verifier matches the challenge');

  assert.deepEqual(await (await chat('/api/chat/google/status', session)).json(), { configured: true, connected: true, email: 'owner@gmail.com', gmail: true, calendar: false, hosted: true });
  assert.equal((await (await chat('/api/chat/gcal/status', session)).json()).connected, false, 'Calendar is a separate consent');
  const stored = storedText();
  for (const secret of ['rt-1', 'at-1', 'owner@gmail.com', 'g-sub-1']) assert.ok(!stored.includes(secret), `${secret} is sealed`);
});

test('the callback refuses a wrong state, a tampered, missing or old cookie, a refusal, a bad code, or a signed-out browser', async () => {
  const owner = await phone();
  const session = await signedInBrowser(owner);
  const bad = async (opts) => {
    const { done } = await connect(session, 'gmail', opts);
    assert.equal(landing(done), '/#gmail=error', JSON.stringify(Object.keys(opts)));
  };
  await bad({ state: 'not-the-state' });
  await bad({ mangle: (v) => `${v.slice(0, -4)}AAAA` });
  await bad({ mangle: () => '' });
  await bad({ code: 'bad-code' });
  // Google's refusal (?error=access_denied)
  const start = await hit('/api/chat/google/connect?scope=gmail', { session });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const denied = await hit(`/api/chat/google/callback?state=${state}&error=access_denied`, { cookie: `__Host-eden-gdata=${cookieValue(start, '__Host-eden-gdata')}` });
  assert.equal(landing(denied), '/#gmail=error');
  // An old attempt (over 10 minutes)
  const realNow = Date.now;
  try {
    const s2 = await hit('/api/chat/google/connect?scope=gmail', { session });
    Date.now = () => realNow() + 11 * 60_000;
    const late = await hit(`/api/chat/google/callback?state=${new URL(s2.headers.get('location')).searchParams.get('state')}&code=good-code`, { cookie: `__Host-eden-gdata=${cookieValue(s2, '__Host-eden-gdata')}` });
    assert.equal(landing(late), '/#gmail=error');
  } finally {
    Date.now = realNow;
  }
  // The browser is signed out between the connect and Google's answer.
  const s3 = await hit('/api/chat/google/connect?scope=gmail', { session });
  await hit('/api/web/signout', { method: 'POST', session, body: {}, headers: { 'x-jarvis-chat': '1' } });
  const after = await hit(`/api/chat/google/callback?state=${new URL(s3.headers.get('location')).searchParams.get('state')}&code=good-code`, { cookie: `__Host-eden-gdata=${cookieValue(s3, '__Host-eden-gdata')}` });
  assert.equal(landing(after), '/#gmail=error');
  assert.ok(!storedText().includes('google_data'), 'nothing was stored');
  // The connect start itself needs the signed-in browser.
  assert.equal((await hit('/api/chat/google/connect?scope=gmail')).status, 401);
  assert.equal((await hit('/api/chat/google/connect?scope=drive', { session: await signedInBrowser(owner) })).status, 400);
});

test('Gmail runs on the Worker: search, the confirm guard on send, an empty schedule, tokens never to the page', async () => {
  const session = await signedInBrowser(await phone());
  await connect(session, 'gmail');
  const found = await (await gmail(session, 'search', { mailbox: 'inbox' })).json();
  assert.equal(found.messages[0].subject, 'Lunch');
  assert.ok(google.calls.filter((c) => c.url.startsWith('https://gmail.googleapis.com')).every((c) => c.auth === 'Bearer at-1'));
  assert.equal(google.refreshes, 0, 'the access token from the consent is used while good');

  const before = google.calls.length;
  const unconfirmed = await gmail(session, 'send', { to: ['ana@example.com'], subject: 'Hi', body: 'Hello' });
  assert.equal(unconfirmed.status, 400);
  assert.equal(google.calls.length, before, 'refused before Google is called');
  const sent = await gmail(session, 'send', { to: ['ana@example.com'], subject: 'Hi', body: 'Hello', confirm: true });
  assert.equal(sent.status, 200, await sent.clone().text());
  assert.equal(google.sent.length, 1);

  // Scheduled send runs on askeden.com too (accounts/schedule.js): see tasks.test.js.
  assert.deepEqual(await (await gmail(session, 'scheduled')).json(), { jobs: [] });
  assert.equal((await gmail(session, 'uploadStart', { name: 'a.pdf', mime: 'application/pdf', size: 10 })).status, 200, 'uploads ahead: below');
  assert.equal((await gmail(session, 'nope')).status, 400);

  for (const p of ['/api/chat/google/status', '/api/chat/gcal/status']) {
    const text = await (await chat(p, session)).text();
    assert.ok(!/rt-1|at-1/.test(text), p);
  }
  // Not the page's: no X-Jarvis-Chat, another site.
  assert.equal((await hit('/api/chat/gmail', { method: 'POST', session, body: { action: 'search' } })).status, 403);
  assert.equal((await chat('/api/chat/gmail', session, { method: 'POST', body: { action: 'search' }, headers: { origin: 'https://evil.example' } })).status, 403);
});

test('access tokens refresh on demand and are kept; a refused refresh token removes the grant', async () => {
  const session = await signedInBrowser(await phone());
  google.grant.expires = 30; // inside the 60 s margin: the next call refreshes
  await connect(session, 'gmail');
  assert.equal((await gmail(session, 'profile')).status, 200);
  assert.equal(google.refreshes, 1);
  assert.equal(google.lastRefresh, 'rt-1');
  assert.equal((await gmail(session, 'profile')).status, 200);
  assert.equal(google.refreshes, 1, 'the refreshed token was saved for the next request');
  assert.equal(google.calls.at(-1).auth, 'Bearer at-2');

  // A 401 from Gmail: one fresh token, then the call again.
  const realFetch2 = globalThis.fetch;
  let once = true;
  globalThis.fetch = async (input, init) => {
    if (once && String(input).includes('/profile')) {
      once = false;
      return new Response('{"error":{"code":401}}', { status: 401 });
    }
    return realFetch2(input, init);
  };
  assert.equal((await gmail(session, 'profile')).status, 200);
  assert.equal(google.refreshes, 2);
  globalThis.fetch = realFetch2;

  google.refreshFails = true;
  globalThis.fetch = async (input, init) => (String(input).includes('/profile') ? new Response('{}', { status: 401 }) : realFetch2(input, init));
  const r = await gmail(session, 'profile');
  assert.equal(r.status, 401);
  assert.equal((await r.json()).code, 'reconnect');
  globalThis.fetch = realFetch2;
  assert.equal((await (await chat('/api/chat/google/status', session)).json()).connected, false, 'Connect Gmail again');
});

test('Connect Google Calendar adds to the same grant; writes need confirm and email no one', async () => {
  const session = await signedInBrowser(await phone());
  await connect(session, 'gmail');
  google.grant = { ...google.grant, refresh: null, scopes: [...google.grant.scopes, ...CAL] }; // Google sends no new refresh token
  const { to, done } = await connect(session, 'calendar');
  assert.deepEqual(to.searchParams.get('scope').split(' '), ['openid', 'email', ...CAL]);
  assert.equal(to.searchParams.get('prompt'), null, 'a refresh token is already held');
  assert.equal(to.searchParams.get('login_hint'), 'owner@gmail.com');
  assert.equal(landing(done), '/#gmail=connected');
  assert.deepEqual(await (await chat('/api/chat/gcal/status', session)).json(), { configured: true, connected: true, email: 'owner@gmail.com', calendar: true, hosted: true });
  assert.equal((await (await chat('/api/chat/google/status', session)).json()).gmail, true, 'Gmail still there');

  const events = await (await gcal(session, 'events', { start: '2026-10-05T00:00:00+02:00', end: '2026-10-12T00:00:00+02:00' })).json();
  assert.equal(events.calendars[0].id, 'primary@gmail.com');
  const event = { title: 'Dentist', start: '2026-10-07T09:00:00.000Z', end: '2026-10-07T10:00:00.000Z', allDay: false };
  const before = google.calls.length;
  assert.equal((await gcal(session, 'create', { calendarId: 'primary@gmail.com', event })).status, 400);
  assert.equal(google.calls.length, before, 'refused before Google');
  const made = await gcal(session, 'create', { calendarId: 'primary@gmail.com', event, confirm: true });
  assert.equal(made.status, 200, await made.clone().text());
  assert.match(google.calls.at(-1).url, /sendUpdates=none/);
  // Refreshes still use the first refresh token.
  google.grant.expires = 1;
});

test('a Calendar-only connection: Mail still says Connect Gmail; a refused calendar scope is an error', async () => {
  const session = await signedInBrowser(await phone());
  google.grant.scopes = ['openid', ...CAL];
  await connect(session, 'calendar');
  assert.equal((await (await chat('/api/chat/google/status', session)).json()).connected, false);
  assert.equal((await (await chat('/api/chat/gcal/status', session)).json()).connected, true);
  assert.equal((await gmail(session, 'search')).status, 409);
  // Granular consent: the owner unticked the calendar.
  const other = await signedInBrowser(await phone('apple-user-2'));
  google.grant.scopes = ['openid'];
  const { done } = await connect(other, 'calendar');
  assert.equal(landing(done), '/#gmail=error');
  assert.equal((await gcal(other, 'calendars')).status, 403);
});

test('Disconnect revokes at Google and forgets; another Google account replaces (and revokes) the first', async () => {
  const session = await signedInBrowser(await phone());
  await connect(session, 'gmail');
  google.grant = { ...google.grant, sub: 'g-sub-2', email: 'work@example.com', refresh: 'rt-2' };
  await connect(session, 'gmail');
  assert.deepEqual(google.revoked, ['rt-1']);
  assert.equal((await (await chat('/api/chat/google/status', session)).json()).email, 'work@example.com');

  const off = await chat('/api/chat/google/disconnect', session, { method: 'POST', body: {} });
  assert.equal(off.status, 200);
  assert.equal((await off.json()).connected, false);
  assert.deepEqual(google.revoked, ['rt-1', 'rt-2']);
  assert.ok(!storedText().includes('google_data'));
  // A different Google account that granted before (no refresh token without prompt=consent): Connect again.
  google.grant = { ...google.grant, sub: 'g-sub-3', refresh: null };
  await connect(session, 'gmail');
  google.grant = { ...google.grant, sub: 'g-sub-1', email: 'owner@gmail.com', refresh: 'rt-1' };
  await connect(session, 'gmail');
  google.grant = { ...google.grant, sub: 'g-sub-3', refresh: null };
  const { done } = await connect(session, 'gmail');
  assert.equal(landing(done), '/#gmail=error');
  assert.equal((await (await chat('/api/chat/google/status', session)).json()).email, 'owner@gmail.com', 'the first stays');
});

test('deleting the account revokes the Google grant; tokens are bound to their account', async () => {
  const owner = await phone();
  const session = await signedInBrowser(owner);
  await connect(session, 'gmail');
  // Another account's sealed record can't be opened as this one (associated data: the account id).
  const otherSession = await signedInBrowser(await phone('apple-user-2'));
  const objects = [...env.ACCOUNTS.objects.values()];
  const mine = objects.find((o) => o.storage.map.has('google_data'));
  const theirs = objects.find((o) => o !== mine && o.storage.map.has('account'));
  theirs.storage.map.set('google_data', structuredClone(mine.storage.map.get('google_data')));
  assert.equal((await (await chat('/api/chat/google/status', otherSession)).json()).connected, false);

  const del = await hit('/api/account', { method: 'DELETE', token: owner.token, headers: { origin: null } });
  assert.equal(del.status, 204);
  assert.ok(google.revoked.includes('rt-1'));
});

test('Gmail and Calendar calls count against API_RATE per account, not the AI allowance', async () => {
  const session = await signedInBrowser(await phone());
  await connect(session, 'gmail');
  let left = 1;
  env.API_RATE = { limit: async () => ({ success: left-- > 0 }) };
  assert.equal((await gmail(session, 'profile')).status, 200);
  const slow = await gmail(session, 'profile');
  assert.equal(slow.status, 429);
  assert.ok(!google.calls.some((c) => c.url.includes('anthropic')));
});

test('the scopes Gmail needs; a fake Google only for a local wrangler dev', () => {
  assert.equal(hasGmailScopes(GMAIL), true);
  assert.equal(hasGmailScopes([GMAIL[0]]), false);
  assert.equal(hasGmailScopes(['https://mail.google.com/']), true);
  const req = (url) => new Request(url);
  assert.equal(fakeBase({ GOOGLE_FAKE_BASE: 'http://127.0.0.1:8799' }, req('http://localhost:8783/api/chat/gmail')), 'http://127.0.0.1:8799');
  assert.equal(fakeBase({ GOOGLE_FAKE_BASE: 'http://127.0.0.1:8799' }, req('https://askeden.com/api/chat/gmail')), null);
  assert.equal(fakeBase({ GOOGLE_FAKE_BASE: 'https://evil.example' }, req('http://localhost:8783/')), null);
  assert.equal(fakeBase({}, req('http://localhost:8783/')), null);
});

// ── attachments uploaded ahead (src/eden/gmail-uploads.js, src/accounts/mail-uploads.js) ──

/** Bytes that look like a file (a fixed sequence per seed, so a mix-up shows). */
function fileBytes(n, seed = 1) {
  const b = Buffer.alloc(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
}

/** Uploads `data` as compose.js does: uploadStart, then uploadChunk at each offset (`step`: the server's chunkBytes unless given). */
async function uploadFile(session, data, { name = 'report.pdf', mime = 'application/pdf', step, cookie } = {}) {
  const post = (action, args) => chat('/api/chat/gmail', session, { method: 'POST', body: { action, args }, cookie });
  const r = await post('uploadStart', { name, mime, size: data.length });
  assert.equal(r.status, 200, await r.clone().text());
  const s = await r.json();
  assert.match(s.uploadId, /^up_[0-9a-f]{32}$/);
  assert.equal(s.chunkBytes, 3 * 1048576);
  let info = s;
  for (let off = 0; off < data.length; off += step || s.chunkBytes) {
    const c = await post('uploadChunk', { uploadId: s.uploadId, offset: off, data: data.subarray(off, off + (step || s.chunkBytes)).toString('base64') });
    assert.equal(c.status, 200, await c.clone().text());
    info = await c.json();
  }
  assert.equal(info.complete, true);
  return s.uploadId;
}

/** The files in a MIME message: [{ name, bytes, wrapped (in 76-column base64 lines) }]. */
function filesIn(mime) {
  const out = [];
  for (const m of mime.matchAll(/Content-Disposition: (?:attachment|inline); filename="([^"]+)"[^]*?\r\n\r\n([A-Za-z0-9+/=\r\n]*?)\r\n--/g)) {
    const lines = m[2].split('\r\n');
    out.push({ name: m[1], bytes: Buffer.from(m[2].replace(/\r\n/g, ''), 'base64'), wrapped: lines.slice(0, -1).every((l) => l.length === 76) && lines.at(-1).length <= 76 });
  }
  return out;
}
const mimeOf = (sent) => sent.mime ?? Buffer.from(sent.raw, 'base64url').toString();
const uploadKeys = (id = '') => [...env.ACCOUNTS.objects.values()].flatMap((o) => [...o.storage.map.keys()].filter((k) => k.startsWith('mup') && k.includes(id)));
const holder = () => [...env.ACCOUNTS.objects.values()].find((o) => [...o.storage.map.keys()].some((k) => k.startsWith('mup:')));
const STAND_IN = /Eden[0-9a-f]{24}\d{4}/;

test('uploads ahead: base64 lines run on across chunks (wrapFrom matches whole-file wrapping)', () => {
  const b64 = fileBytes(5000).toString('base64');
  const whole = b64.match(/.{1,76}/g).join('\r\n');
  for (const cut of [[0, 1200, 2400, b64.length], [0, 76, 152, b64.length], [0, 4, 80, 6000, b64.length]]) {
    let joined = '';
    for (let i = 0; i + 1 < cut.length; i++) joined += wrapFrom(b64.slice(cut[i], cut[i + 1]), cut[i]);
    assert.equal(joined, whole, cut.join(','));
  }
});

test('uploads ahead: uploaded once in chunks, autosaves and the send name it by id, the send drops it; ids never logged', async () => {
  const session = await signedInBrowser(await phone());
  await connect(session, 'gmail');
  const logged = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(real)) console[k] = (...a) => logged.push(a.join(' '));
  let id;
  try {
    const data = fileBytes(1_000_000);
    id = await uploadFile(session, data, { step: 300_000 }); // 400 000 characters a chunk: lines run across them
    assert.equal((await gmail(session, 'uploadChunk', { uploadId: id, offset: 0, data: data.subarray(0, 300_000).toString('base64') })).status, 200, 'a retry');
    for (const [k, v] of holder().storage.map) if (k.startsWith('mupc:')) assert.ok(v.length <= 100_000, 'every piece fits a Durable Object value');

    const mail = { to: ['ana@example.com'], subject: 'The report', body: 'Attached.', attachments: [{ uploadId: id }] };
    const saved = await gmail(session, 'draft', mail);
    assert.equal(saved.status, 200, await saved.clone().text());
    const draftId = (await saved.json()).id;
    const files = filesIn(google.drafts.get(draftId));
    assert.deepEqual(files.map((f) => [f.name, f.bytes.equals(data), f.wrapped]), [['report.pdf', true, true]]);
    assert.match(google.drafts.get(draftId), /Content-Type: application\/pdf; name="report.pdf"/);
    // The next autosave names it again (the page sends the id only): rebuilt from what's held.
    const again = await gmail(session, 'draft', { ...mail, body: 'Attached, v2.', draftId });
    assert.equal(again.status, 200, await again.clone().text());
    assert.ok(filesIn(google.drafts.get(draftId))[0].bytes.equals(data));
    assert.ok(uploadKeys(id).length > 1, 'still held for the next autosave');

    // The send: the draft becomes what was reviewed, then goes; the upload is dropped.
    const sent = await gmail(session, 'send', { ...mail, draftId, confirm: true });
    assert.equal(sent.status, 200, await sent.clone().text());
    assert.equal(google.sent.at(-1).draft, draftId);
    assert.ok(filesIn(mimeOf(google.sent.at(-1)))[0].bytes.equals(data));
    assert.ok(!STAND_IN.test(mimeOf(google.sent.at(-1))), 'no stand-in left');
    assert.deepEqual(uploadKeys(id), [], 'dropped after the send');
    assert.deepEqual(await (await gmail(session, 'uploadDelete', { uploadId: id })).json(), { deleted: false });
    assert.ok(!google.calls.some((c) => c.url.includes('/upload/')), 'small: a JSON raw request, as before');
  } finally {
    Object.assign(console, real);
  }
  assert.ok(!logged.some((l) => l.includes(id)), 'upload ids are never logged');
});

test('uploads ahead: a big message streams to Gmail’s resumable upload in 8 MiB PUTs (the exact size up front)', async () => {
  const session = await signedInBrowser(await phone());
  await connect(session, 'gmail');
  const big = fileBytes(7_000_000, 2);
  const logo = fileBytes(5000, 3);
  const bigId = await uploadFile(session, big, { name: 'film.mov', mime: 'video/quicktime' });
  const logoId = await uploadFile(session, logo, { name: 'logo.png', mime: 'image/png' });
  const r = await gmail(session, 'send', {
    to: ['ana@example.com'],
    subject: 'Big',
    html: '<p>Our logo: <img src="cid:logo1@eden" alt="logo"></p>',
    attachments: [{ uploadId: bigId }],
    inline: [{ uploadId: logoId, contentId: 'logo1@eden' }],
    confirm: true,
  });
  assert.equal(r.status, 200, await r.clone().text());
  const s = google.sessions.at(-1);
  assert.equal(s.path, '/messages/send');
  assert.equal(s.type, 'message/rfc822');
  assert.equal(Buffer.byteLength(s.mime), s.length, 'the size given at the start is exact');
  assert.deepEqual(s.puts.map((p) => p.range), [`bytes 0-${8 * 1048576 - 1}/${s.length}`, `bytes ${8 * 1048576}-${s.length - 1}/${s.length}`]);
  const files = filesIn(s.mime);
  assert.deepEqual(files.map((f) => [f.name, f.wrapped]), [['logo.png', true], ['film.mov', true]]);
  assert.ok(files[0].bytes.equals(logo) && files[1].bytes.equals(big));
  assert.match(s.mime, /Content-ID: <logo1@eden>/);
  assert.ok(!STAND_IN.test(s.mime));
  assert.ok(!google.calls.some((c) => c.method === 'POST' && c.url.endsWith('/messages/send')), 'not as one JSON request');
  assert.deepEqual(uploadKeys(), []);
});

test('uploads ahead: a message big even without its files (the core’s own resumable upload) still gets them', async () => {
  const session = await signedInBrowser(await phone());
  await connect(session, 'gmail');
  const data = fileBytes(100_000, 5);
  const id = await uploadFile(session, data);
  const r = await gmail(session, 'draft', { to: ['ana@example.com'], subject: 'Long', body: 'x'.repeat(1_000_000), html: `<p>${'y'.repeat(2_000_000)}</p>`, attachments: [{ uploadId: id }] });
  assert.equal(r.status, 200, await r.clone().text());
  const s = google.sessions.at(-1);
  assert.equal(s.path, '/drafts');
  assert.equal(Buffer.byteLength(s.mime), s.length);
  assert.ok(filesIn(s.mime)[0].bytes.equals(data));
  assert.equal(google.drafts.get((await r.json()).id), s.mime);
  assert.ok(!google.calls.some((c) => c.url.includes('/eden-upload/')), 'the stand-in session never leaves the Worker');
  assert.equal(uploadKeys(id).length > 0, true, 'a draft keeps it');
});

test('uploads ahead: uploadFromGmail copies a Gmail attachment chunk by chunk', async () => {
  const session = await signedInBrowser(await phone());
  await connect(session, 'gmail');
  google.attachments.ATT1 = fileBytes(4_000_000, 4);
  const r = await gmail(session, 'uploadFromGmail', { messageId: '18c0a1', attachmentId: 'ATT1', name: 'scan.pdf', mime: 'application/pdf' });
  assert.equal(r.status, 200, await r.clone().text());
  const { uploadId, ...info } = await r.json();
  assert.deepEqual(info, { name: 'scan.pdf', mime: 'application/pdf', size: 4_000_000, received: 4_000_000, complete: true });
  assert.deepEqual(google.calls.filter((c) => c.url.includes('/attachments/ATT1')).map((c) => new URL(c.url).search), ['?fields=size', '']);
  const sent = await gmail(session, 'send', { to: ['ana@example.com'], subject: 'Fwd: scan', body: 'See attached.', attachments: [{ uploadId }], confirm: true });
  assert.equal(sent.status, 200, await sent.clone().text());
  assert.ok(filesIn(google.sessions.at(-1).mime)[0].bytes.equals(google.attachments.ATT1));
  const gone = await gmail(session, 'uploadFromGmail', { messageId: '18c0a1', attachmentId: 'NOPE', name: 'x.pdf' });
  assert.equal(gone.status, 404);
  assert.deepEqual(uploadKeys(), [], 'nothing kept');

  // The stream reader: UPLOAD_CHUNK_BYTES of base64 at a time, whatever pieces Gmail's answer comes in.
  const text = JSON.stringify({ size: 7_000_000, data: fileBytes(7_000_000, 6).toString('base64url') });
  const body = new ReadableStream({
    start(c) {
      for (let i = 0; i < text.length; i += 65_537) c.enqueue(new TextEncoder().encode(text.slice(i, i + 65_537)));
      c.close();
    },
  });
  const got = [];
  await streamAttachmentData(new Response(body), async (b64) => got.push(b64.length));
  assert.deepEqual(got, [4 * 1048576, 4 * 1048576, Math.ceil((7_000_000 * 4) / 3) - 8 * 1048576]);
});

test('uploads ahead: kept 6 hours after their last use, then gone (when asked for, and from the alarm); 410 has the page upload again', async () => {
  const session = await signedInBrowser(await phone());
  await connect(session, 'gmail');
  const data = fileBytes(1000);
  const id = await uploadFile(session, data);
  const obj = holder();
  assert.ok(obj.storage.map.get('alarmq').some((j) => j.key === 'uploads'), 'the sweep is queued');
  const t0 = Date.now();
  const mail = { to: ['ana@example.com'], subject: 'Later', body: 'x', attachments: [{ uploadId: id }] };
  obj.now = () => t0 + 5 * 3600_000;
  assert.equal((await gmail(session, 'draft', mail)).status, 200, 'used 5 h later');
  obj.now = () => t0 + 10 * 3600_000;
  assert.equal((await gmail(session, 'draft', mail)).status, 200, '5 h after that use: still kept');
  obj.now = () => t0 + 16.5 * 3600_000;
  const late = await gmail(session, 'draft', mail);
  assert.equal(late.status, 410);
  assert.equal((await late.json()).code, 'upload_missing');
  assert.deepEqual(uploadKeys(), [], 'dropped when asked for');

  obj.now = () => Date.now();
  const id2 = await uploadFile(session, data);
  obj.now = () => Date.now() + 5 * 3600_000;
  await obj.alarm();
  assert.equal(uploadKeys(id2).length > 0, true, 'not yet');
  obj.now = () => Date.now() + 7 * 3600_000;
  await obj.alarm();
  assert.deepEqual(uploadKeys(), [], 'the alarm dropped it');
  assert.ok(!(obj.storage.map.get('alarmq') || []).some((j) => j.key === 'uploads'), 'nothing left to sweep');
});

test('uploads ahead: 25 MB a file, 100 MB and 100 uploads an account, Gmail’s blocked types; unfinished ones can’t be sent', async () => {
  const session = await signedInBrowser(await phone());
  await connect(session, 'gmail');
  const start = (args) => gmail(session, 'uploadStart', args);
  const MB25 = 25 * 1048576;
  assert.equal((await start({ name: 'huge.zip', mime: 'application/zip', size: MB25 + 1 })).status, 400);
  assert.match((await (await start({ name: 'setup.exe', size: 10 })).json()).error, /\.exe/);
  assert.equal((await start({ name: 'a.txt', mime: 'not a type', size: 10 })).status, 400);
  const held = [];
  for (let i = 0; i < 4; i++) held.push((await (await start({ name: `part${i}.zip`, size: MB25 })).json()).uploadId);
  assert.equal((await start({ name: 'one-more.txt', size: 1 })).status, 413, '100 MB held (reserved by size)');
  assert.deepEqual(await (await gmail(session, 'uploadDelete', { uploadId: held.shift() })).json(), { deleted: true });
  assert.equal((await start({ name: 'one-more.txt', size: 1 })).status, 200);

  const unfinished = await gmail(session, 'draft', { to: ['ana@example.com'], subject: 'x', attachments: [{ uploadId: held[0] }] });
  assert.equal(unfinished.status, 409);
  assert.equal((await gmail(session, 'uploadChunk', { uploadId: held[0], offset: 3, data: 'AAAA' })).status, 400, 'out of order');
  assert.equal((await gmail(session, 'uploadChunk', { uploadId: held[0], offset: 0, data: 'AAAAAA==' })).status, 400, 'not whole 3-byte groups');
  assert.equal((await gmail(session, 'uploadChunk', { uploadId: held[0], offset: 0, data: 'A'.repeat(4 * 1048576 + 4) })).status, 400, 'over 3 MiB');
  assert.equal((await gmail(session, 'uploadChunk', { uploadId: 'up_nope', offset: 0, data: 'AAAA' })).status, 400);
  for (const id of held) await gmail(session, 'uploadDelete', { uploadId: id });

  for (let i = 1; i < 100; i++) assert.equal((await start({ name: `n${i}.txt`, size: 0 })).status, 200);
  assert.equal((await start({ name: 'n100.txt', size: 0 })).status, 413, '100 uploads at once');
});

test('uploads ahead: an account’s own; another account can’t send, add to or delete them; deleting the account drops them', async () => {
  const owner = await phone();
  const mine = await signedInBrowser(owner);
  await connect(mine, 'gmail');
  const other = await signedInBrowser(await phone('apple-user-2'));
  await connect(other, 'gmail');
  const id = await uploadFile(mine, fileBytes(3000));
  const theirs = await gmail(other, 'send', { to: ['ana@example.com'], subject: 'x', body: 'y', attachments: [{ uploadId: id }], confirm: true });
  assert.equal(theirs.status, 410);
  assert.equal((await gmail(other, 'uploadChunk', { uploadId: id, offset: 3000, data: 'AAAA' })).status, 410);
  assert.deepEqual(await (await gmail(other, 'uploadDelete', { uploadId: id })).json(), { deleted: false });
  assert.equal(google.sent.length, 0);
  assert.equal((await gmail(mine, 'draft', { to: ['ana@example.com'], subject: 'x', attachments: [{ uploadId: id }] })).status, 200, 'still the owner’s');
  assert.equal((await gmail(mine, 'draft', { to: ['ana@example.com'], subject: 'x', attachments: [{ uploadId: '../mup:x' }] })).status, 400);

  const del = await hit('/api/account', { method: 'DELETE', token: owner.token, headers: { origin: null } });
  assert.equal(del.status, 204);
  assert.deepEqual(uploadKeys(), []);
});

test('uploads ahead: a delegate with mail uploads into the owner’s account; one without mail can’t', async () => {
  const owner = await signedInBrowser(await phone());
  await connect(owner, 'gmail');
  const delegate = async (sub, features) => {
    const inv = await (await chat('/api/web/deleg/invite', owner, { method: 'POST', body: { name: 'Sam', from: 'Bilel', cap_usd: 1, features, days: 30 } })).json();
    const sam = await signedInBrowser(await phone(sub));
    assert.equal((await chat('/api/web/deleg/accept', sam, { method: 'POST', body: { code: inv.code } })).status, 200);
    const { mine } = await (await chat('/api/web/deleg', sam)).json();
    const use = await chat('/api/web/deleg/use', sam, { method: 'POST', body: { id: mine[0].id } });
    return { sam, cookie: `__Host-eden-as=${cookieValue(use, '__Host-eden-as')}` };
  };
  const withMail = await delegate('apple-sam-1', ['chat', 'mail']);
  const id = await uploadFile(withMail.sam, fileBytes(2000), { cookie: withMail.cookie });
  assert.ok(holder().storage.map.has('google_data'), 'held in the owner’s account, beside the owner’s Gmail');
  const saved = await chat('/api/chat/gmail', withMail.sam, { method: 'POST', cookie: withMail.cookie, body: { action: 'draft', args: { to: ['ana@example.com'], subject: 'For Bilel', attachments: [{ uploadId: id }] } } });
  assert.equal(saved.status, 200, await saved.clone().text());
  const chatOnly = await delegate('apple-sam-2', ['chat']);
  const refused = await chat('/api/chat/gmail', chatOnly.sam, { method: 'POST', cookie: chatOnly.cookie, body: { action: 'uploadStart', args: { name: 'a.pdf', size: 10 } } });
  assert.equal(refused.status, 403);
});
