// Eden Cloud tokens (accounts/cloud-token.js): a linked Mac trades its device token for a
// ten-minute token Eden Cloud checks with askeden.com's public key; nothing else gets one.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { CLOUD_TOKEN_SECONDS, mintCloudToken } from '../src/accounts/cloud-token.js';
import { b64ToBytes, bytesToB64 } from '../src/accounts/util.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const A = '11111111-1111-4111-8111-111111111111';
const ctx = { waitUntil: () => {} };
let env;
let pair;

const fromB64url = (text) => b64ToBytes(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));

beforeEach(async () => {
  forgetSessions();
  pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  env = { TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '6', EDEN_CLOUD_SIGNING_KEY: bytesToB64(pkcs8), API_RATE: rateLimiter(), AUTH_RATE: rateLimiter(), LINK_RATE: rateLimiter(), EDEN_RATE: rateLimiter() };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.IDENTITIES = namespace(Identity, env);
  env.ASSETS = { fetch: async () => new Response('asset') };
});

const mac = (plan = { name: 'plus', active: true }) => ({ id: A, plan, devices: [{ id: 'abcdef0123456789', kind: 'mac', this: true }, { id: '0000000000000000', kind: 'iphone' }] });

test('a Mac gets a signed ten-minute token for Eden Cloud alone', async () => {
  const now = 1_790_000_000_000;
  const { token, expires_in, plan } = await mintCloudToken(env, mac(), now);
  assert.equal(expires_in, CLOUD_TOKEN_SECONDS);
  assert.equal(plan, 'plus');
  const [head, body, sig] = token.split('.');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(fromB64url(head))), { alg: 'EdDSA', typ: 'JWT' });
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(body)));
  assert.equal(claims.aud, 'eden-cloud');
  assert.equal(claims.iss, 'askeden.com');
  assert.equal(claims.sub, A);
  assert.equal(claims.dev, 'abcdef0123456789');
  assert.equal(claims.kind, 'mac');
  assert.equal(claims.exp - claims.iat, 600);
  assert.equal(claims.iat, now / 1000);
  assert.match(claims.jti, /^[0-9a-f]{16}$/);
  assert.deepEqual(Object.keys(claims).sort(), ['aud', 'dev', 'exp', 'iat', 'iss', 'jti', 'kind', 'plan', 'sub']);
  const ok = await crypto.subtle.verify({ name: 'Ed25519' }, pair.publicKey, fromB64url(sig), new TextEncoder().encode(`${head}.${body}`));
  assert.equal(ok, true);
  assert.equal((await mintCloudToken(env, mac({ name: 'free', active: false }))).plan, 'free');
  assert.equal((await mintCloudToken(env, mac({ name: 'plus', active: false }))).plan, 'free');
});

test('only a Mac, and only once the owner set the key', async () => {
  const phone = { id: A, plan: {}, devices: [{ id: '0000000000000000', kind: 'iphone', this: true }] };
  await assert.rejects(mintCloudToken(env, phone), (e) => e.status === 403);
  await assert.rejects(mintCloudToken(env, { id: A, devices: [] }), (e) => e.status === 403);
  env.EDEN_CLOUD_SIGNING_KEY = '';
  await assert.rejects(mintCloudToken(env, mac()), (e) => e.status === 503 && e.code === 'not_set_up');
  env.EDEN_CLOUD_SIGNING_KEY = 'bm90IGEga2V5';
  await assert.rejects(mintCloudToken(env, mac()), (e) => e.status === 503);
});

test('the route: signed-in devices only, and an iPhone is turned away', async () => {
  const post = (token) => worker.fetch(new Request(`${ORIGIN}/api/cloud/token`, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} }), env, ctx);
  assert.equal((await post('')).status, 401);
  const { token } = await call(env, A, 'signin', { account_id: A, device: { name: 'iPhone', kind: 'iphone' } });
  const refused = await post(token);
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).code, 'forbidden');
});
