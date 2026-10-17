// Eden for Android's sign-in (eden/android.js, eden/session.js): Apple's web sign-in in the app's Custom Tab
// (`/api/web/apple?app=1`) ending on com.askeden.eden://signin, /.well-known/assetlinks.json, and the native
// passkey verify taking the app's `android:apk-key-hash:` origin (and only there, never from a page).
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { b64ToBytes, b64url, sha256 } from '../src/accounts/util.js';
import { forgetSessions } from '../src/eden/session.js';
import { ANDROID_UPLOAD_CERT, androidOrigins, apkKeyHash } from '../src/eden/android.js';
import { Account, Identity, Link, appleJwk, identityToken, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const SERVICES_ID = 'com.askeden.eden.web';
const CHROME = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36';
const PLAY_CERT = '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00';
const enc = new TextEncoder();
const ctx = { waitUntil: () => {} };
const realFetch = globalThis.fetch;
let env;

function makeEnv(extra = {}) {
  const e = { TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20', WEB_APPLE_SERVICES_ID: SERVICES_ID, AUTH_RATE: rateLimiter(), LINK_RATE: rateLimiter(), EDEN_RATE: rateLimiter(), ...extra };
  e.ACCOUNTS = namespace(Account, e);
  e.LINKS = namespace(Link, e);
  e.IDENTITIES = namespace(Identity, e);
  e.ASSETS = { fetch: async (req) => new Response(`asset ${new URL(req.url).pathname}`, { headers: { 'content-type': 'text/html' } }) };
  return e;
}

beforeEach(() => {
  forgetAppleKeys();
  forgetSessions();
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    throw new Error(`unexpected fetch ${url}`);
  };
  env = makeEnv();
});

after(() => {
  globalThis.fetch = realFetch;
});

async function hit(p, { method = 'GET', body, headers = {}, origin = ORIGIN, host = ORIGIN, form = false } = {}) {
  const h = { 'cf-connecting-ip': '198.51.100.9', 'user-agent': CHROME, ...headers };
  if (method !== 'GET' && origin !== null) h.origin ??= origin; // null: the app (no Origin)
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
const accountOf = async (session) => (await hit('/api/web/session', { headers: { cookie: `__Host-eden=${session}` } })).json();

/** Apple posting its form back (form_post) to this attempt's cookie. */
async function appleBack(attempt, fields) {
  return hit('/api/web/apple/callback', { method: 'POST', body: fields, form: true, origin: 'https://appleid.apple.com', headers: { cookie: `__Host-eden-apple=${attempt}` } });
}

// ── Apple in the Android app's Custom Tab ──

test('the Android app: Apple’s web sign-in (?app=1) ends on the app’s scheme with a handoff code', async () => {
  const start = await hit('/api/web/apple?app=1');
  assert.equal(start.status, 302);
  const to = new URL(start.headers.get('location'));
  assert.equal(to.origin, 'https://appleid.apple.com');
  assert.equal(to.searchParams.get('redirect_uri'), 'https://askeden.com/api/web/apple/callback', 'the return URL Apple already knows');
  const attempt = cookieValue(start, '__Host-eden-apple');
  assert.match(attempt, /^[^.]+\.[^.]+\.a/);
  const [state, nonce] = attempt.split('.');
  const back = await appleBack(attempt, { state, id_token: await identityToken({ sub: 'apple-android-1', nonce, aud: SERVICES_ID }) });
  assert.equal(back.status, 302);
  const end = new URL(back.headers.get('location'));
  assert.equal(`${end.protocol}//${end.host}${end.pathname}`, 'com.askeden.eden://signin');
  assert.ok(!cookieValue(back, '__Host-eden'), 'no session in the Custom Tab: the web view redeems the code');
  const code = end.searchParams.get('code');
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  const opened = await hit(`/api/web/handoff?code=${code}`, { headers: { 'sec-fetch-site': 'none' } });
  assert.equal(opened.headers.get('location'), '/');
  const view = await accountOf(cookieValue(opened, '__Host-eden'));
  assert.deepEqual(view.identities.map((i) => i.provider), ['apple']);

  // The same Apple ID through the web: the same Eden account.
  const web = await hit('/api/web/apple');
  const webAttempt = cookieValue(web, '__Host-eden-apple');
  assert.match(webAttempt, /^[^.]+\.[^.]+\.s/);
  const [s2, n2] = webAttempt.split('.');
  const webBack = await appleBack(webAttempt, { state: s2, id_token: await identityToken({ sub: 'apple-android-1', nonce: n2, aud: SERVICES_ID }) });
  assert.equal((await accountOf(cookieValue(webBack, '__Host-eden'))).account_id, view.account_id);
});

test('the Android app’s Apple sign-in: cancel, bad state, bad token and not set up all end on the app’s scheme', async () => {
  const begin = async () => {
    const attempt = cookieValue(await hit('/api/web/apple?app=1'), '__Host-eden-apple');
    const [state, nonce] = attempt.split('.');
    return { attempt, state, nonce };
  };
  let a = await begin();
  assert.equal((await appleBack(a.attempt, { error: 'user_cancelled_authorize', state: a.state })).headers.get('location'), 'com.askeden.eden://signin?error=cancelled');
  a = await begin();
  assert.equal((await appleBack(a.attempt, { state: 'wrong', id_token: 'x' })).headers.get('location'), 'com.askeden.eden://signin?error=state');
  a = await begin();
  const forged = await appleBack(a.attempt, { state: a.state, id_token: await identityToken({ sub: 'x', nonce: 'another-nonce', aud: SERVICES_ID }) });
  assert.match(forged.headers.get('location'), /^com\.askeden\.eden:\/\/signin\?error=/);
  env = makeEnv({ WEB_APPLE_SERVICES_ID: '' });
  assert.equal((await hit('/api/web/apple?app=1')).headers.get('location'), 'com.askeden.eden://signin?error=not_set_up');
  // The web's own start never becomes app mode: a form post, or link mode.
  env = makeEnv();
  const posted = await hit('/api/web/apple?app=1', { method: 'POST', body: {}, form: true });
  assert.match(cookieValue(posted, '__Host-eden-apple') || '', /^[^.]+\.[^.]+\.s/);
});

// ── Digital Asset Links ──

test('/.well-known/assetlinks.json names com.askeden.eden with the upload key, plus the Play key from ANDROID_CERT_SHA256', async () => {
  const r = await worker.fetch(new Request(`${ORIGIN}/.well-known/assetlinks.json`), env, ctx);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/json');
  const [entry, ...rest] = await r.json();
  assert.equal(rest.length, 0);
  assert.deepEqual(entry.relation, ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds']);
  assert.deepEqual(entry.target, { namespace: 'android_app', package_name: 'com.askeden.eden', sha256_cert_fingerprints: [ANDROID_UPLOAD_CERT] });
  env = makeEnv({ ANDROID_CERT_SHA256: ` ${PLAY_CERT.toLowerCase()}, not-a-fingerprint, ${ANDROID_UPLOAD_CERT}` });
  const both = await (await worker.fetch(new Request(`${ORIGIN}/.well-known/assetlinks.json`), env, ctx)).json();
  assert.deepEqual(both[0].target.sha256_cert_fingerprints, [ANDROID_UPLOAD_CERT, PLAY_CERT]);
  const edu = await worker.fetch(new Request('https://askedenedu.com/.well-known/assetlinks.json'), makeEnv({ EDU_HOST: 'askedenedu.com' }), ctx);
  assert.deepEqual(await edu.json(), []);
});

test('apk-key-hash: base64url of the certificate’s SHA-256 bytes', () => {
  const bytes = ANDROID_UPLOAD_CERT.split(':').map((h) => parseInt(h, 16));
  assert.equal(apkKeyHash(ANDROID_UPLOAD_CERT), `android:apk-key-hash:${b64url(Uint8Array.from(bytes))}`);
  assert.equal(apkKeyHash(ANDROID_UPLOAD_CERT), 'android:apk-key-hash:y6f_XimblnRcN533oZiZJrPAN8fK4JnsM1zslEmbYBg');
  assert.deepEqual(androidOrigins({ ANDROID_CERT_SHA256: PLAY_CERT }), [apkKeyHash(ANDROID_UPLOAD_CERT), apkKeyHash(PLAY_CERT)]);
});

// ── passkeys from Android's Credential Manager ──

function cbor(v) {
  const head = (major, n) => (n < 24 ? [(major << 5) | n] : n < 256 ? [(major << 5) | 24, n] : [(major << 5) | 25, n >> 8, n & 255]);
  const parts = [];
  const put = (x) => {
    if (typeof x === 'number') parts.push(Uint8Array.from(x >= 0 ? head(0, x) : head(1, -1 - x)));
    else if (x instanceof Uint8Array) parts.push(Uint8Array.from(head(2, x.length)), x);
    else if (typeof x === 'string') {
      const b = enc.encode(x);
      parts.push(Uint8Array.from(head(3, b.length)), b);
    } else {
      const entries = [...x];
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

/** A P-256 passkey whose clientDataJSON carries `origin` (Android writes the app's apk-key-hash). */
async function androidKey(origin) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, b64ToBytes(jwk.x)], [-3, b64ToBytes(jwk.y)]]);
  const rawId = crypto.getRandomValues(new Uint8Array(32));
  const id = b64url(rawId);
  let count = 0;
  const client = (type, challenge) => enc.encode(JSON.stringify({ type, challenge, origin, androidPackageName: 'com.askeden.eden' }));
  return {
    async create(pk) {
      const authData = concat(await sha256(pk.rp.id), Uint8Array.of(0x45), u32(0), new Uint8Array(16), Uint8Array.of(0, rawId.length), rawId, cbor(cose));
      const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return { id, rawId: id, type: 'public-key', response: { clientDataJSON: b64url(client('webauthn.create', pk.challenge)), attestationObject: b64url(att) } };
    },
    async get(pk) {
      count += 1;
      const authData = concat(await sha256(pk.rpId), Uint8Array.of(0x05), u32(count));
      const clientData = client('webauthn.get', pk.challenge);
      const sig = rawToDer(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, concat(authData, await sha256(clientData)))));
      return { id, rawId: id, type: 'public-key', response: { clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(sig), userHandle: null } };
    },
  };
}

test('native passkeys accept the Android app’s apk-key-hash origin; the web page’s verify and other keys do not', async () => {
  env = makeEnv({ ANDROID_CERT_SHA256: PLAY_CERT });
  const app = { origin: null };
  const nativeOptions = async (mode) => (await hit('/api/web/native/passkey/options', { method: 'POST', body: { mode }, ...app })).json();
  const nativeVerify = (credential) => hit('/api/web/native/passkey/verify', { method: 'POST', body: { credential }, ...app });

  // Signed with the Play App Signing key: sign up, then sign in, natively.
  const key = await androidKey(apkKeyHash(PLAY_CERT));
  const up = await nativeVerify(await key.create((await nativeOptions('signup')).publicKey));
  const made = await up.json();
  assert.equal(up.status, 200, JSON.stringify(made));
  assert.match(made.handoff, /^[A-Za-z0-9_-]{43}$/);
  const inAgain = await nativeVerify(await key.get((await nativeOptions('signin')).publicKey));
  assert.equal(inAgain.status, 200);
  // The upload key's too (internal testing builds signed by it).
  const upload = await androidKey(apkKeyHash(ANDROID_UPLOAD_CERT));
  assert.equal((await nativeVerify(await upload.create((await nativeOptions('signup')).publicKey))).status, 200);
  // Any other app's key: refused.
  const stranger = await androidKey(apkKeyHash(PLAY_CERT.replace(/^11/, '12')));
  const refused = await nativeVerify(await stranger.create((await nativeOptions('signup')).publicKey));
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /another site/);
  // The page's own ceremony never takes an app origin.
  const pageOptions = await (await hit('/api/web/passkey/options', { method: 'POST', body: { mode: 'signin' } })).json();
  const fromPage = await hit('/api/web/passkey/verify', { method: 'POST', body: { credential: await key.get(pageOptions.publicKey) } });
  assert.equal(fromPage.status, 400);
});
