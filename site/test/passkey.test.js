// Passkeys on askeden.com (accounts/webauthn.js, eden/session.js "passkeys") and Turnstile on sign-up
// (accounts/turnstile.js): the small CBOR/COSE reader, a fake authenticator (ES256 and RS256) going
// through sign-up, sign-in and "add a passkey", every check that must refuse (challenge, origin,
// rpIdHash, UV, attestation, signCount), and the person check before any new account.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetSessions } from '../src/eden/session.js';
import { forgetGoogleKeys } from '../src/eden/google.js';
import { b64ToBytes, b64url, sha256 } from '../src/accounts/util.js';
import { coseToJwk, decodeCbor, parseAuthData, verifyAssertion, verifyRegistration } from '../src/accounts/webauthn.js';
import { SITEVERIFY, forgetTurnstileNote } from '../src/accounts/turnstile.js';
import { Account, GOOGLE_CLIENT, Identity, Link, google, googleIdToken, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const enc = new TextEncoder();

// ── a small CBOR writer and a fake authenticator ──

function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return [(major << 5) | n];
    if (n < 256) return [(major << 5) | 24, n];
    if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
    return [(major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const parts = [];
  const put = (x) => {
    if (x === false) parts.push(Uint8Array.of(0xf4));
    else if (x === true) parts.push(Uint8Array.of(0xf5));
    else if (x === null) parts.push(Uint8Array.of(0xf6));
    else if (typeof x === 'number') parts.push(Uint8Array.from(x >= 0 ? head(0, x) : head(1, -1 - x)));
    else if (x instanceof Uint8Array) parts.push(Uint8Array.from(head(2, x.length)), x);
    else if (typeof x === 'string') {
      const b = enc.encode(x);
      parts.push(Uint8Array.from(head(3, b.length)), b);
    } else if (Array.isArray(x)) {
      parts.push(Uint8Array.from(head(4, x.length)));
      x.forEach(put);
    } else {
      const entries = x instanceof Map ? [...x] : Object.entries(x);
      parts.push(Uint8Array.from(head(5, entries.length)));
      for (const [k, val] of entries) (put(k), put(val));
    }
  };
  put(v);
  return concat(...parts);
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}

const u32 = (n) => Uint8Array.of((n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255);

/** WebCrypto's raw r‖s as DER, as authenticators send it. */
function rawToDer(raw) {
  const int = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    b = b.subarray(i);
    if (b[0] & 0x80) b = concat(Uint8Array.of(0), b);
    return concat(Uint8Array.of(0x02, b.length), b);
  };
  const body = concat(int(raw.subarray(0, 32)), int(raw.subarray(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

async function authenticator({ alg = -7 } = {}) {
  const pair =
    alg === -7
      ? await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
      : await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const cose = alg === -7 ? new Map([[1, 2], [3, -7], [-1, 1], [-2, b64ToBytes(jwk.x)], [-3, b64ToBytes(jwk.y)]]) : new Map([[1, 3], [3, -257], [-1, b64ToBytes(jwk.n)], [-2, b64ToBytes(jwk.e)]]);
  const rawId = crypto.getRandomValues(new Uint8Array(32));
  const id = b64url(rawId);
  let count = 0;
  const client = (type, challenge, origin) => enc.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id,
    count: () => count,
    async create(publicKey, { origin = ORIGIN, flags = 0x45, fmt = 'none', rpId = publicKey.rp.id, startCount = 0, challenge = publicKey.challenge } = {}) {
      count = startCount;
      const authData = concat(await sha256(rpId), Uint8Array.of(flags), u32(count), new Uint8Array(16), Uint8Array.of(0, rawId.length), rawId, cbor(cose));
      const attStmt = fmt === 'none' ? new Map() : new Map([['alg', -7], ['sig', new Uint8Array(8)]]);
      const att = cbor(new Map([['fmt', fmt], ['attStmt', attStmt], ['authData', authData]]));
      return { id, rawId: id, type: 'public-key', response: { clientDataJSON: b64url(client('webauthn.create', challenge, origin)), attestationObject: b64url(att) } };
    },
    async get(publicKey, { origin = ORIGIN, flags = 0x05, rpId = publicKey.rpId, step = 1, challenge = publicKey.challenge } = {}) {
      count += step;
      const authData = concat(await sha256(rpId), Uint8Array.of(flags), u32(count));
      const clientData = client('webauthn.get', challenge, origin);
      const signed = concat(authData, await sha256(clientData));
      let sig = new Uint8Array(alg === -7 ? await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, signed) : await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, pair.privateKey, signed));
      if (alg === -7) sig = rawToDer(sig);
      return { id, rawId: id, type: 'public-key', response: { clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(sig), userHandle: null } };
    },
  };
}

// ── the Worker with fakes ──

let env;
let calls;
let siteverify; // (form) => body
let nextGoogle;
const ctx = { waitUntil: () => {} };
const realFetch = globalThis.fetch;

function makeEnv(extra = {}) {
  const e = { TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20', GOOGLE_CLIENT_ID: GOOGLE_CLIENT, GOOGLE_CLIENT_SECRET: 'test-secret', AUTH_RATE: rateLimiter(), LINK_RATE: rateLimiter(), EDEN_RATE: rateLimiter(), ...extra };
  e.ACCOUNTS = namespace(Account, e);
  e.LINKS = namespace(Link, e);
  e.IDENTITIES = namespace(Identity, e);
  e.ASSETS = { fetch: async (req) => new Response(`asset ${new URL(req.url).pathname}`, { headers: { 'content-type': 'text/html' } }) };
  return e;
}

beforeEach(() => {
  calls = [];
  forgetSessions();
  forgetGoogleKeys();
  forgetTurnstileNote();
  siteverify = (form) => ({ success: ['good-token', 'elsewhere-token'].includes(form.get('response')), hostname: form.get('response') === 'elsewhere-token' ? 'evil.example' : 'askeden.com' });
  nextGoogle = { sub: 'google-user-1', email: 'person@example.com' };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    if (url === SITEVERIFY) return Response.json(siteverify(new URLSearchParams(init.body)));
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [google.jwk] });
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'ya29.x', expires_in: 3599, id_token: await googleIdToken({ ...nextGoogle }) });
    throw new Error(`unexpected fetch ${url}`);
  };
  env = makeEnv();
});

after(() => {
  globalThis.fetch = realFetch;
});

async function hit(p, { method = 'GET', body, headers = {}, session, origin = ORIGIN, host = ORIGIN, form = false } = {}) {
  const h = { 'cf-connecting-ip': '198.51.100.7', 'user-agent': SAFARI, ...headers };
  if (method !== 'GET') h.origin ??= origin;
  if (session) h.cookie = [`__Host-eden=${session}`, h.cookie].filter(Boolean).join('; ');
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = form ? new URLSearchParams(body).toString() : JSON.stringify(body);
    h['content-type'] ??= form ? 'application/x-www-form-urlencoded' : 'application/json';
  }
  return worker.fetch(new Request(`${host}${p}`, init), env, ctx);
}

const cookieValue = (response, name) => {
  const found = response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1).split(';')[0] : undefined;
};

async function options(mode, extra = {}, opts = {}) {
  const r = await hit('/api/web/passkey/options', { method: 'POST', body: { mode, ...extra }, ...opts });
  return { status: r.status, body: await r.json() };
}
const verify = (credential, opts = {}) => hit('/api/web/passkey/verify', { method: 'POST', body: { credential, return: opts.return }, ...opts });

async function signUp(key, opts = {}) {
  const o = await options('signup', opts.turnstile ? { turnstile: opts.turnstile } : {}, opts);
  assert.equal(o.status, 200, JSON.stringify(o.body));
  const r = await verify(await key.create(o.body.publicKey, opts), opts);
  return { response: r, body: await r.clone().json(), session: cookieValue(r, '__Host-eden') };
}

async function signIn(key, how = {}, opts = {}) {
  const o = await options('signin', {}, opts);
  assert.equal(o.status, 200);
  const r = await verify(await key.get(o.body.publicKey, how), opts);
  return { response: r, body: await r.clone().json(), session: cookieValue(r, '__Host-eden') };
}

const accountOf = async (session) => (await (await hit('/api/web/session', { session })).json());

// ── the reader ──

test('CBOR: the WebAuthn subset decodes; anything cut short, too deep or unknown is refused', () => {
  const v = new Map([['fmt', 'none'], [1, -7], [-2, Uint8Array.of(1, 2)], ['list', [true, false, null, 500, 70000]]]);
  const { value, end } = decodeCbor(cbor(v));
  assert.equal(value.get('fmt'), 'none');
  assert.equal(value.get(1), -7);
  assert.deepEqual([...value.get(-2)], [1, 2]);
  assert.deepEqual(value.get('list'), [true, false, null, 500, 70000]);
  assert.equal(end, cbor(v).length);
  assert.throws(() => decodeCbor(cbor('hello').subarray(0, 3)), { code: 'passkey' });
  assert.throws(() => decodeCbor(Uint8Array.of(0xfb, 0, 0, 0, 0, 0, 0, 0, 0)), { code: 'passkey' }); // a float
  assert.throws(() => decodeCbor(Uint8Array.of(0x5f)), { code: 'passkey' }); // indefinite length
  let deep = cbor(1);
  for (let i = 0; i < 20; i++) deep = concat(Uint8Array.of(0x81), deep);
  assert.throws(() => decodeCbor(deep), { code: 'passkey' });
});

test('COSE: ES256 on P-256 and RS256 become JWKs; other keys are refused', () => {
  const x = new Uint8Array(32).fill(1);
  assert.deepEqual(coseToJwk(new Map([[1, 2], [3, -7], [-1, 1], [-2, x], [-3, x]])), { alg: -7, jwk: { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(x) } });
  assert.equal(coseToJwk(new Map([[1, 3], [3, -257], [-1, new Uint8Array(256).fill(9)], [-2, Uint8Array.of(1, 0, 1)]])).jwk.kty, 'RSA');
  assert.throws(() => coseToJwk(new Map([[1, 1], [3, -8], [-1, 6], [-2, x]])), { code: 'passkey' }); // Ed25519
  assert.throws(() => coseToJwk(new Map([[1, 2], [3, -7], [-1, 2], [-2, x], [-3, x]])), { code: 'passkey' }); // P-384
  assert.throws(() => coseToJwk(new Map([[1, 3], [3, -257], [-1, new Uint8Array(128)], [-2, Uint8Array.of(3)]])), { code: 'passkey' }); // RSA-1024
  assert.throws(() => parseAuthData(new Uint8Array(36)), { code: 'passkey' });
  assert.throws(() => parseAuthData(concat(new Uint8Array(37), Uint8Array.of(1))), { code: 'passkey' }); // bytes left over
});

test('registration and assertion checks, ES256 and RS256: challenge, origin, rpIdHash, UP, UV, attestation, signCount', async () => {
  for (const alg of [-7, -257]) {
    const key = await authenticator({ alg });
    const pk = { challenge: 'c'.repeat(43), rp: { id: 'askeden.com' } };
    const where = { challenge: pk.challenge, origin: ORIGIN, rpId: 'askeden.com' };
    const made = await verifyRegistration({ credential: await key.create(pk), ...where });
    assert.equal(made.alg, alg);
    assert.equal(made.id, key.id);
    const bad = async (how, words) => assert.rejects(verifyRegistration({ credential: await key.create(pk, how), ...where }), (e) => e.code === 'passkey' && words.test(e.message));
    await bad({ challenge: 'd'.repeat(43) }, /another sign-in/);
    await bad({ origin: 'https://evil.example' }, /another site/);
    await bad({ rpId: 'evil.example' }, /another site/);
    await bad({ flags: 0x44 }, /confirm you were there/);
    await bad({ flags: 0x41 }, /didn’t verify you/);
    await bad({ fmt: 'packed' }, /no attestation/);
    const stored = { alg: made.alg, jwk: made.jwk, count: made.count };
    const req = { challenge: 'e'.repeat(43), rpId: 'askeden.com' };
    const w2 = { ...where, challenge: req.challenge, stored };
    assert.deepEqual(await verifyAssertion({ credential: await key.get(req), ...w2 }), { count: 1 });
    await assert.rejects(verifyAssertion({ credential: await key.get(req, { flags: 0x01 }), ...w2 }), /didn’t verify you/);
    await assert.rejects(verifyAssertion({ credential: await key.get(req), ...w2, stored: { ...stored, count: 50 } }), /copied/);
    const other = await authenticator({ alg });
    await other.create(pk);
    await assert.rejects(verifyAssertion({ credential: await other.get(req), ...w2 }), /signature/);
    const swapped = await key.get(req);
    swapped.response.clientDataJSON = b64url(enc.encode(JSON.stringify({ type: 'webauthn.get', challenge: req.challenge, origin: ORIGIN, extra: 1 })));
    await assert.rejects(verifyAssertion({ credential: swapped, ...w2 }), /signature/);
  }
});

// ── the endpoints ──

test('sign up with a passkey (Turnstile off): a new account, signed in; then sign in with it to the same account', async () => {
  const key = await authenticator();
  const up = await signUp(key, { return: '/#tasks' });
  assert.equal(up.response.status, 200, JSON.stringify(up.body));
  assert.deepEqual(up.body, { signed_in: true, created: true, to: '/#tasks' });
  assert.ok(up.session);
  const first = await accountOf(up.session);
  assert.deepEqual(first.identities.map((i) => i.provider), ['passkey']);
  const again = await signIn(key);
  assert.equal(again.response.status, 200, JSON.stringify(again.body));
  assert.equal((await accountOf(again.session)).account_id, first.account_id);
  // The passkey's options: our RP, attestation none, UV required, ES256 and RS256.
  const o = await options('signup');
  assert.equal(o.body.publicKey.rp.id, 'askeden.com');
  assert.equal(o.body.publicKey.attestation, 'none');
  assert.equal(o.body.publicKey.authenticatorSelection.userVerification, 'required');
  assert.deepEqual(o.body.publicKey.pubKeyCredParams.map((p) => p.alg), [-7, -257]);
});

test('a challenge is single use, expires, belongs to its host, and the page must be this site', async () => {
  const key = await authenticator({ alg: -257 });
  await signUp(key);
  const o = await options('signin');
  const answer = await key.get(o.body.publicKey);
  assert.equal((await verify(answer)).status, 200);
  const replay = await verify(answer);
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).code, 'expired');
  // Made for askeden.com, posted to preview.askeden.com: refused.
  const o2 = await options('signin');
  const r = await verify(await key.get(o2.body.publicKey), { host: 'https://preview.askeden.com', origin: 'https://preview.askeden.com' });
  assert.equal(r.status, 400);
  // preview.askeden.com is its own RP.
  const p = await options('signup', {}, { host: 'https://preview.askeden.com', origin: 'https://preview.askeden.com' });
  assert.equal(p.body.publicKey.rp.id, 'preview.askeden.com');
  // Another site's page can't ask.
  assert.equal((await hit('/api/web/passkey/options', { method: 'POST', body: { mode: 'signin' }, origin: 'https://evil.example' })).status, 403);
  assert.equal((await hit('/api/web/passkey/options', { method: 'POST', body: { mode: 'nope' } })).status, 400);
});

test('a signature counter that doesn’t go up is refused (a copied passkey); an unknown passkey says so', async () => {
  const key = await authenticator();
  await signUp(key);
  assert.equal((await signIn(key)).response.status, 200);
  const stale = await signIn(key, { step: 0 });
  assert.equal(stale.response.status, 400);
  assert.match(stale.body.error, /copied/);
  const stranger = await authenticator();
  await stranger.create({ challenge: 'x'.repeat(43), rp: { id: 'askeden.com' } });
  const unknown = await signIn(stranger);
  assert.equal(unknown.response.status, 404);
  assert.equal(unknown.body.code, 'unknown_passkey');
});

test('add a passkey from the account page: it opens the same account as Google; one per account; unlink, then it no longer signs in', async () => {
  const start = await hit('/api/web/google');
  const to = new URL(start.headers.get('location'));
  nextGoogle = { sub: 'google-user-1', email: 'person@example.com', nonce: to.searchParams.get('nonce') };
  const back = await hit(`/api/web/google/callback?state=${to.searchParams.get('state')}&code=4%2Fcode`, { headers: { cookie: `__Host-eden-google=${cookieValue(start, '__Host-eden-google')}` } });
  const session = cookieValue(back, '__Host-eden');
  assert.ok(session);
  const before = await accountOf(session);
  assert.equal((await options('add')).status, 401, 'signed in only');
  const key = await authenticator();
  const o = await options('add', {}, { session });
  assert.equal(o.status, 200);
  const added = await verify(await key.create(o.body.publicKey), { session });
  assert.equal(added.status, 200);
  assert.deepEqual((await added.json()).identities.map((i) => i.provider).sort(), ['google', 'passkey']);
  const viaKey = await signIn(key);
  assert.equal((await accountOf(viaKey.session)).account_id, before.account_id);
  assert.equal((await options('add', {}, { session })).status, 409);
  // A passkey made for "add" can't be turned into a sign-up.
  const o3 = await options('add', {}, { session: viaKey.session });
  assert.equal(o3.status, 409);
  const un = await hit('/api/web/identities/passkey/unlink', { method: 'POST', session, headers: { 'x-jarvis-chat': '1' } });
  assert.equal(un.status, 200, await un.clone().text());
  assert.equal((await signIn(key)).response.status, 404);
});

test('Turnstile: off without its keys (logged once); on, a passkey sign-up needs a passing token checked with siteverify and the IP', async () => {
  const logs = [];
  const log = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    await signUp(await authenticator());
    await signUp(await authenticator());
  } finally {
    console.log = log;
  }
  assert.equal(logs.filter((l) => /Turnstile is off/.test(l)).length, 1);
  assert.deepEqual(await (await hit('/api/web/config')).json().then((c) => [c.passkey, c.turnstile]), [true, null]);

  env = makeEnv({ TURNSTILE_SITE_KEY: '0x4AAAAAAAtest', TURNSTILE_SECRET: '0x4AAAAAAAsecret' });
  assert.equal((await (await hit('/api/web/config')).json()).turnstile, '0x4AAAAAAAtest');
  const none = await options('signup');
  assert.equal(none.status, 403);
  assert.equal(none.body.code, 'turnstile');
  assert.equal((await options('signup', { turnstile: 'bad-token' })).status, 403);
  // A passed check from another site's widget: its hostname isn't this request's.
  assert.equal((await options('signup', { turnstile: 'elsewhere-token' })).status, 403);
  const ok = await signUp(await authenticator(), { turnstile: 'good-token' });
  assert.equal(ok.response.status, 200);
  const asked = calls.filter((c) => c.url === SITEVERIFY).map((c) => new URLSearchParams(c.init.body));
  assert.equal(asked.at(-1).get('secret'), '0x4AAAAAAAsecret');
  assert.equal(asked.at(-1).get('remoteip'), '198.51.100.7');
  // Signing in needs no check.
  assert.equal((await options('signin')).status, 200);
});

test('Turnstile on Google: a first sign-in needs the /signin form post with a token; an existing account signs in either way', async () => {
  env = makeEnv({ TURNSTILE_SITE_KEY: '0x4AAAAAAAtest', TURNSTILE_SECRET: '0x4AAAAAAAsecret' });
  const flow = async (start) => {
    const to = new URL(start.headers.get('location'));
    nextGoogle = { sub: 'google-new', email: 'new@example.com', nonce: to.searchParams.get('nonce') };
    return hit(`/api/web/google/callback?state=${to.searchParams.get('state')}&code=4%2Fcode`, { headers: { cookie: `__Host-eden-google=${cookieValue(start, '__Host-eden-google')}` } });
  };
  // A plain link: no check passed, so no new account.
  const plain = await flow(await hit('/api/web/google'));
  assert.equal(plain.status, 303);
  assert.equal(plain.headers.get('location'), '/signin?error=verify&provider=google');
  // The form post with a bad token goes back to /signin at once.
  const refused = await hit('/api/web/google', { method: 'POST', form: true, body: { 'cf-turnstile-response': 'bad-token' } });
  assert.equal(refused.headers.get('location'), '/signin?error=verify&provider=google');
  // With a good one: the account is made.
  const made = await flow(await hit('/api/web/google', { method: 'POST', form: true, body: { 'cf-turnstile-response': 'good-token', return: '/#tasks' } }));
  assert.ok(cookieValue(made, '__Host-eden'));
  // Now it exists: a plain link signs it in.
  assert.ok(cookieValue(await flow(await hit('/api/web/google')), '__Host-eden'));
});

test('the sign-in page allows Turnstile’s script and frame; other pages don’t', async () => {
  const signin = await hit('/signin');
  const csp = signin.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
  assert.match(csp, /frame-src https:\/\/challenges\.cloudflare\.com/);
  assert.match(csp, /form-action 'self'/);
  const link = await hit('/download');
  assert.doesNotMatch(link.headers.get('content-security-policy'), /challenges\.cloudflare\.com/);
});
