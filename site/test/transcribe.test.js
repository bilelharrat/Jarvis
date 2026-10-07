// Dictation by recording on askeden.com (eden/transcribe.js, ROADMAP G7.2): a browser without
// speech recognition posts its recording; a fake Workers AI binding stands in for Whisper. The
// session, Origin and header rules, the audio type, 25 MB and two minutes, the allowance (held,
// then spent at Cloudflare's price for the recording's length) and AI failing. No network.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { TRANSCRIBE, audioType, transcribeUSD } from '../src/eden/transcribe.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Link, appleJwk, identityToken, namespace } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15.6; rv:143.0) Gecko/20100101 Firefox/143.0';

let env;
let waits;
let ai;
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;

/** Workers AI as the binding answers: what it was asked, and a reply (or a throw). */
function fakeAI() {
  const fake = {
    runs: [],
    reply: { text: ' Book a table for two at eight. ', word_count: 7, transcription_info: { language: 'en', duration: 6.2 } },
    async run(model, input) {
      fake.runs.push({ model, input });
      if (fake.reply instanceof Error) throw fake.reply;
      return fake.reply;
    },
  };
  return fake;
}

beforeEach(() => {
  waits = [];
  forgetAppleKeys();
  forgetSessions();
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    throw new Error(`unexpected fetch ${url}`);
  };
  ai = fakeAI();
  env = { TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20', AI: ai };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.ASSETS = { fetch: async () => new Response('asset') };
});

after(() => {
  globalThis.fetch = realFetch;
});

async function hit(p, { method = 'GET', body, headers = {}, session, token, browser = true } = {}) {
  const h = { ...headers };
  if (browser) {
    h['user-agent'] ??= FIREFOX;
    if (method !== 'GET') h.origin ??= ORIGIN;
  }
  if (session) h.cookie = `__Host-eden=${session}`;
  if (token) h.authorization = `Bearer ${token}`;
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = body instanceof Uint8Array || typeof body === 'string' ? body : JSON.stringify(body);
    h['content-type'] ??= 'application/json';
  }
  const response = await worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
  while (waits.length) await Promise.all(waits.splice(0));
  return response;
}

const cookieValue = (response, name) => (response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) || '').slice(name.length + 1).split(';')[0];

/** An owner's iPhone, and a browser signed in to Eden by its approval. */
async function signedIn() {
  const phone = await (await hit('/api/account/apple', { method: 'POST', browser: false, body: { identity_token: await identityToken(), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } } })).json();
  const started = await hit('/api/web/link', { method: 'POST', body: {} });
  const { code } = await started.json();
  await hit(`/api/link/${code}/approve`, { method: 'POST', browser: false, token: phone.token, body: {} });
  const done = await hit('/api/web/link/poll', { method: 'POST', body: {}, headers: { cookie: `__Host-eden-link=${cookieValue(started, '__Host-eden-link')}` } });
  return { session: cookieValue(done, '__Host-eden'), account: env.ACCOUNTS.objects.get(phone.account.id) };
}

const AUDIO = new Uint8Array(4000).fill(7); // the bytes don't matter to the fake
const record = (session, { body = AUDIO, type = 'audio/webm;codecs=opus', headers = {} } = {}) =>
  hit('/api/chat/transcribe', { method: 'POST', session, body, headers: { 'x-jarvis-chat': '1', 'content-type': type, 'x-eden-seconds': '6', 'x-eden-lang': 'en-GB', ...headers } });

test('a Firefox recording comes back as its words, from Whisper on Workers AI, counted on the allowance', async () => {
  const { session, account } = await signedIn();
  const r = await record(session);
  assert.equal(r.status, 200, await r.clone().text());
  const out = await r.json();
  assert.deepEqual(out, { text: 'Book a table for two at eight.', seconds: 6.2, costUSD: transcribeUSD(6.2) });
  const [run] = ai.runs;
  assert.equal(run.model, '@cf/openai/whisper-large-v3-turbo');
  assert.equal(run.input.audio, Buffer.from(AUDIO).toString('base64'), 'the recording, base64');
  assert.equal(run.input.language, 'en');
  assert.equal(run.input.vad_filter, true);
  // Cloudflare's price for the recording's length, held first and let go after.
  assert.equal(transcribeUSD(60), TRANSCRIBE.usdPerMinute);
  assert.equal(out.costUSD, Math.ceil((6.2 / 60) * 0.000513 * 1e6) / 1e6);
  const usage = await account.storage.get('usage');
  assert.ok(Math.abs(usage.trial_spent - out.costUSD) < 1e-9, JSON.stringify(usage));
  assert.equal(account.holds.size, 0, 'the hold is let go');
});

test('only the signed-in page, with audio of a kind Whisper reads, 25 MB and two minutes at most', async () => {
  const { session, account } = await signedIn();
  assert.equal((await record(null)).status, 401, 'signed out');
  assert.equal((await record(session, { headers: { 'x-jarvis-chat': '' } })).status, 403);
  assert.equal((await record(session, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await record(session, { type: 'application/json', body: '{"audio":"x"}' })).status, 415);
  assert.equal((await record(session, { type: 'video/webm' })).status, 415);
  assert.equal((await record(session, { body: new Uint8Array() })).status, 400);
  const long = await record(session, { headers: { 'x-eden-seconds': '200' } });
  assert.equal(long.status, 413);
  assert.match((await long.json()).error, /2 minutes/);
  const big = await record(session, { body: new Uint8Array(TRANSCRIBE.maxBytes + 1) });
  assert.equal(big.status, 413);
  assert.deepEqual(ai.runs, [], 'none of these reached Workers AI');
  // Whisper saying it was longer than two minutes after all: billed, but no words.
  ai.reply = { text: 'a very long story', transcription_info: { duration: 300 } };
  const after = await record(session);
  assert.equal(after.status, 413);
  assert.ok((await account.storage.get('usage')).trial_spent >= transcribeUSD(300) - 1e-9);
  assert.equal(audioType('audio/mp4'), 'audio/mp4');
  assert.equal(audioType('audio/ogg; codecs=opus'), 'audio/ogg');
  assert.equal(audioType('text/plain'), null);
});

test('no allowance, no AI binding, or Whisper failing: said plainly, and nothing is counted', async () => {
  const { session, account } = await signedIn();
  ai.reply = new Error('AiError: 3010');
  const failed = await record(session);
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: 'Dictation didn’t work this time. Try again.', code: 'ai_error' });
  assert.equal((await account.storage.get('usage'))?.trial_spent || 0, 0);
  assert.equal(account.holds.size, 0);
  await account.storage.put('usage', { ...(await account.storage.get('usage')), month: new Date().toISOString().slice(0, 7), spent: 0, trial_spent: 1 });
  const broke = await record(session);
  assert.equal(broke.status, 402);
  delete env.AI;
  const off = await record(session);
  assert.equal(off.status, 503);
  assert.match((await off.json()).error, /Chrome, Edge or Safari/);
  assert.equal(ai.runs.length, 1);
});
