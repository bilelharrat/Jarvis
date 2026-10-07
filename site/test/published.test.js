// Published pages (G10, accounts/published.js): an artifact kept as a live page at /p/<id>,
// "only me" or "anyone with the link", under the artifacts' sandbox CSP; revoked at once; a
// size cap and a per-account cap; listed for the account page. Also: askeden.com answers a
// privacy-mode turn (G9) with "needs your Mac" and never calls Claude for it.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { PUBLISHED, newPublishedId, validPublishedId } from '../src/accounts/published.js';
import { PRIVACY_NEEDS_MAC } from '../src/eden/chat.js';
import { forgetSessions } from '../src/eden/session.js';
import { ARTIFACT_CSP } from '../src/eden/web.js';
import { Account, Link, appleJwk, claudeAnswer, identityToken, namespace, sseBody } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';

let env;
let waits;
let calls;
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;

function makeEnv() {
  const e = { ANTHROPIC_API_KEY: 'sk-test', TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20' };
  e.ACCOUNTS = namespace(Account, e);
  e.LINKS = namespace(Link, e);
  e.ASSETS = { fetch: async (req) => new Response(`asset ${new URL(req.url).pathname}`, { headers: { 'content-type': 'text/html' } }) };
  return e;
}

beforeEach(() => {
  waits = [];
  calls = [];
  forgetAppleKeys();
  forgetSessions();
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    if (url === 'https://api.anthropic.com/v1/messages') return new Response(sseBody(claudeAnswer()), { headers: { 'content-type': 'text/event-stream' } });
    throw new Error(`unexpected fetch ${url}`);
  };
  env = makeEnv();
});

after(() => {
  globalThis.fetch = realFetch;
});

async function hit(p, { method = 'GET', body, headers = {}, session, token, browser = true } = {}) {
  const h = { ...headers };
  if (browser) {
    h['user-agent'] ??= SAFARI;
    if (method !== 'GET' && method !== 'HEAD') h.origin ??= ORIGIN;
  }
  if (session) h.cookie = `__Host-eden=${session}`;
  if (token) h.authorization = `Bearer ${token}`;
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    h['content-type'] ??= 'application/json';
  }
  const response = await worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
  while (waits.length) await Promise.all(waits.splice(0));
  return response;
}

const cookieValue = (response, name) => {
  const found = (response.headers.getSetCookie ? response.headers.getSetCookie() : []).find((c) => c.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1).split(';')[0] : undefined;
};

async function phone(sub = 'apple-user-1') {
  const response = await hit('/api/account/apple', {
    method: 'POST',
    browser: false,
    body: { identity_token: await identityToken({ sub }), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } },
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

/** A browser signed in through the iPhone app's approval: its session cookie value. */
async function browserOf(owner) {
  const started = await hit('/api/web/link', { method: 'POST', body: {} });
  const link = await started.json();
  const linkCookie = `__Host-eden-link=${cookieValue(started, '__Host-eden-link')}`;
  assert.equal((await hit(`/api/link/${link.code}/approve`, { method: 'POST', browser: false, token: owner.token, body: { sealed_key: null, sender_key: null } })).status, 200);
  const done = await hit('/api/web/link/poll', { method: 'POST', body: {}, headers: { cookie: linkCookie } });
  return cookieValue(done, '__Host-eden');
}

const chat = (p, session, opts = {}) => hit(p, { session, ...opts, headers: { 'x-jarvis-chat': '1', ...(opts.headers || {}) } });
const publish = (session, body) => chat('/api/chat/publish', session, { method: 'POST', body });
const HTML = '<!doctype html><html><head><title>Tip calculator</title></head><body><h1>Tips</h1><script>document.body.dataset.ok = 1</script></body></html>';

test('publish: a private page for its owner only, then shared with the link, under the sandbox CSP; the link hides the account', async () => {
  const owner = await phone();
  const me = await browserOf(owner);
  const made = await publish(me, { html: HTML, title: '  Tip\ncalculator  ' });
  assert.equal(made.status, 200, await made.clone().text());
  const page = await made.json();
  assert.ok(validPublishedId(page.id));
  assert.equal(page.url, `/p/${page.id}`);
  assert.equal(page.title, 'Tip calculator');
  assert.equal(page.access, 'private', 'only me unless asked');
  assert.equal(page.bytes, new TextEncoder().encode(HTML).length);
  assert.ok(!page.url.includes(owner.account.id), 'the link never carries the account id');

  // Only me: the owner's browser sees it; signed out is told to sign in; another account sees nothing.
  const mine = await hit(page.url, { session: me });
  assert.equal(mine.status, 200);
  assert.equal(await mine.text(), HTML);
  assert.equal(mine.headers.get('content-security-policy'), ARTIFACT_CSP);
  assert.equal(mine.headers.get('cache-control'), 'no-store');
  assert.equal(mine.headers.get('vary'), 'cookie');
  assert.match(mine.headers.get('x-robots-tag'), /noindex/);
  const out = await hit(page.url);
  assert.equal(out.status, 401);
  assert.match(await out.text(), /This page is private/);
  assert.match(out.headers.get('content-security-policy'), /default-src 'none'/);
  const stranger = await browserOf(await phone('apple-user-2'));
  assert.equal((await hit(page.url, { session: stranger })).status, 404);

  // Anyone with the link.
  const shared = await chat('/api/chat/published/access', me, { method: 'POST', body: { id: page.id, access: 'link' } });
  assert.equal((await shared.json()).access, 'link');
  const anyone = await hit(page.url);
  assert.equal(anyone.status, 200);
  assert.equal(await anyone.text(), HTML);
  assert.equal(anyone.headers.get('content-security-policy'), ARTIFACT_CSP);
  assert.equal((await hit(page.url, { session: stranger })).status, 200);
  // And back to only me, at once (nothing cached).
  await chat('/api/chat/published/access', me, { method: 'POST', body: { id: page.id, access: 'private' } });
  assert.equal((await hit(page.url)).status, 401);
  assert.equal((await chat('/api/chat/published/access', me, { method: 'POST', body: { id: page.id, access: 'public' } })).status, 400);
  assert.ok(!calls.some((u) => u.includes('anthropic')), 'publishing spends no AI');
});

test('listed for the account page; revoked at once; another account can neither list, change nor revoke it', async () => {
  const owner = await phone();
  const me = await browserOf(owner);
  const a = await (await publish(me, { html: HTML, access: 'link' })).json();
  const b = await (await publish(me, { html: '<p>Second</p>', title: 'Second' })).json();
  const list = await (await chat('/api/chat/published', me)).json();
  assert.deepEqual(Object.keys(list).sort(), ['bytes', 'max', 'pages']);
  assert.equal(list.max, PUBLISHED.max);
  assert.equal(list.bytes, 2 * 1024 * 1024);
  assert.deepEqual(list.pages.map((p) => p.id).sort(), [a.id, b.id].sort());
  assert.deepEqual(Object.keys(list.pages[0]).sort(), ['access', 'bytes', 'created', 'id', 'title', 'updated', 'url']);
  assert.equal(list.pages.find((p) => p.id === a.id).title, 'Untitled page');

  const stranger = await browserOf(await phone('apple-user-2'));
  assert.deepEqual((await (await chat('/api/chat/published', stranger)).json()).pages, []);
  assert.equal((await chat('/api/chat/published/revoke', stranger, { method: 'POST', body: { id: a.id } })).status, 404);
  assert.equal((await chat('/api/chat/published/access', stranger, { method: 'POST', body: { id: a.id, access: 'private' } })).status, 404);
  assert.equal((await hit(a.url)).status, 200);

  const gone = await chat('/api/chat/published/revoke', me, { method: 'POST', body: { id: a.id } });
  assert.deepEqual(await gone.json(), { id: a.id, revoked: true });
  const after = await hit(a.url);
  assert.equal(after.status, 404);
  assert.match(await after.text(), /isn’t here/);
  assert.equal(env.ACCOUNTS.objects.has(`pub:${a.id}`) && (await env.ACCOUNTS.objects.get(`pub:${a.id}`).storage.get('pubindex')), undefined, 'the index entry goes too');
  const account = env.ACCOUNTS.objects.get(owner.account.id);
  assert.equal([...account.storage.map.keys()].filter((k) => k.includes(a.id)).length, 0, 'its pieces go');
  assert.equal((await chat('/api/chat/published/revoke', me, { method: 'POST', body: { id: a.id } })).status, 404);
  assert.deepEqual((await (await chat('/api/chat/published', me)).json()).pages.map((p) => p.id), [b.id]);
});

test('caps: 2 MB a page (in pieces), 20 pages an account; bad ids and paths are "not here"', async () => {
  const owner = await phone();
  const me = await browserOf(owner);
  assert.equal((await publish(me, { html: 'x'.repeat(2 * 1024 * 1024 + 1) })).status, 413);
  assert.equal((await publish(me, { html: 'é'.repeat(1024 * 1024 + 1) })).status, 413, 'counted in bytes');
  assert.equal((await publish(me, { html: '' })).status, 400);
  assert.equal((await publish(me, { html: HTML, access: 'everyone' })).status, 400);
  const big = `<!doctype html><p>${'é'.repeat(500_000)}</p>`;
  const page = await (await publish(me, { html: big, access: 'link' })).json();
  assert.equal(await (await hit(page.url)).text(), big, 'reassembled from its pieces');
  for (let i = 1; i < PUBLISHED.max; i++) assert.equal((await publish(me, { html: `<p>${i}</p>` })).status, 200);
  const full = await publish(me, { html: '<p>one more</p>' });
  assert.equal(full.status, 409);
  assert.equal((await full.json()).code, 'too_many');
  // The refused one left no index entry behind.
  const indexes = [...env.ACCOUNTS.objects.entries()].filter(([k, o]) => k.startsWith('pub:') && o.storage.map.has('pubindex'));
  assert.equal(indexes.length, PUBLISHED.max);

  for (const p of ['/p/short', `/p/${'a'.repeat(23)}`, `/p/${newPublishedId()}`, '/p/..%2f..', '/p/<script>']) {
    const r = await hit(p);
    assert.equal(r.status, 404, p);
  }
  assert.match(newPublishedId(), /^[A-Za-z0-9_-]{22}$/);
});

test('the publish API: signed in, its header, same-origin JSON; a device can’t reach another account’s index', async () => {
  const owner = await phone();
  const me = await browserOf(owner);
  assert.equal((await hit('/api/chat/publish', { method: 'POST', body: { html: HTML }, headers: { 'x-jarvis-chat': '1' } })).status, 401, 'signed out');
  assert.equal((await hit('/api/chat/publish', { method: 'POST', session: me, body: { html: HTML } })).status, 403, 'no X-Jarvis-Chat');
  assert.equal((await hit('/api/chat/publish', { method: 'POST', session: me, body: { html: HTML }, headers: { 'x-jarvis-chat': '1', origin: 'https://evil.example' } })).status, 403);
  assert.equal((await chat('/api/chat/publish', me, { method: 'POST', body: HTML, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await chat('/api/chat/published/nope', me, { method: 'POST', body: {} })).status, 404);
  // The index ops refuse to run on a real account's object.
  const res = await env.ACCOUNTS.get(owner.account.id).fetch('https://account/pub-index-claim', { method: 'POST', body: JSON.stringify({ account: 'x' }) });
  assert.equal(res.status, 400);
  // The owner ops need the device's credentials.
  const bare = await env.ACCOUNTS.get(owner.account.id).fetch('https://account/pub-list', { method: 'POST', body: '{}' });
  assert.equal(bare.status, 401);
});

test('askeden.com answers a privacy-mode turn with "needs your Mac" and never calls Claude for it', async () => {
  const owner = await phone();
  const me = await browserOf(owner);
  for (const privacy of [true, 'yes', 1]) {
    const r = await chat('/api/chat/send', me, { method: 'POST', body: { messages: [{ role: 'user', content: 'my password is hunter2' }], settings: { level: 3 }, privacy } });
    const body = await r.json();
    if (privacy === true) {
      // No Mac linked (webrelay.test.js has the Mac answering it).
      assert.equal(r.status, 503);
      assert.equal(body.code, 'needs_mac');
      assert.equal(body.error, PRIVACY_NEEDS_MAC);
    } else {
      assert.equal(r.status, 400, String(privacy));
    }
  }
  assert.ok(!calls.some((u) => u.includes('anthropic')), 'nothing went to Claude');
  // An ordinary turn still goes.
  const ok = await chat('/api/chat/send', me, { method: 'POST', body: { messages: [{ role: 'user', content: 'hello' }], settings: { level: 3 }, privacy: false } });
  assert.equal(ok.status, 200);
});
