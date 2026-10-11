// Pictures in Eden's chat on askeden.com (eden/image.js): the page posts a make_image card's prompt; a fake
// Workers AI binding stands in for Llama Guard and FLUX.2 klein. The session, Origin and header rules, the prompt,
// size and starting-picture checks, the safety check refusing before any picture is made, the allowance (held, then
// spent at Cloudflare's price), the day's count (a refused or failed picture given back) and AI failing. No network.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker, { VoiceQuota } from '../src/worker.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { IMAGE, imageUSD, parseImageBody, pictureSize } from '../src/eden/image.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Link, appleJwk, identityToken, namespace } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const PICTURE = Buffer.from('a jpeg made by the fake').toString('base64').replace(/^/, '/9j/');

let env;
let waits;
let ai;
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;

/** Workers AI as the binding answers: Llama Guard's verdict, then the picture (each can be made to throw). */
function fakeAI() {
  const fake = {
    runs: [],
    verdict: { safe: true, categories: [] },
    picture: { image: PICTURE },
    async run(model, input) {
      if (input && input.multipart) {
        const form = await new Response(input.multipart.body, { headers: { 'content-type': input.multipart.contentType } }).formData();
        fake.runs.push({ model, form });
        if (fake.picture instanceof Error) throw fake.picture;
        return fake.picture;
      }
      fake.runs.push({ model, input });
      if (fake.verdict instanceof Error) throw fake.verdict;
      return { response: fake.verdict, usage: { prompt_tokens: 215 } };
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
  env = { TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20', AI: ai, IMAGES_DAILY_PER_ACCOUNT: '3', IMAGES_DAILY_TOTAL: '100' };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.VOICE_QUOTA = namespace(VoiceQuota, env);
  env.ASSETS = { fetch: async () => new Response('asset') };
});

after(() => {
  globalThis.fetch = realFetch;
});

async function hit(p, { method = 'GET', body, headers = {}, session, token, browser = true } = {}) {
  const h = { ...headers };
  if (browser && method !== 'GET') h.origin ??= ORIGIN;
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

const make = (session, body = { prompt: 'A watercolor fox reading under an oak tree' }, headers = {}) =>
  hit('/api/chat/image', { method: 'POST', session, body, headers: { 'x-jarvis-chat': '1', ...headers } });

/** A tiny JPEG header of w×h (enough for pictureSize; the fake model never decodes it). */
function jpeg(w, h) {
  const b = Buffer.alloc(40);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255], 0);
  return b.toString('base64');
}

test('a prompt comes back as a picture from FLUX.2 klein, checked by Llama Guard first, counted on the allowance', async () => {
  const { session, account } = await signedIn();
  const r = await make(session, { prompt: '  A watercolor fox\n reading under an oak tree ', size: 'wide' });
  assert.equal(r.status, 200, await r.clone().text());
  const out = await r.json();
  assert.deepEqual(out, { image: PICTURE, mime: 'image/jpeg', width: 1344, height: 768, size: 'wide', costUSD: imageUSD('wide') });
  const [guard, picture] = ai.runs;
  assert.equal(guard.model, '@cf/meta/llama-guard-3-8b');
  assert.equal(guard.input.messages[0].content, 'Make this picture: A watercolor fox reading under an oak tree');
  assert.equal(picture.model, '@cf/black-forest-labs/flux-2-klein-4b');
  assert.equal(picture.form.get('prompt'), 'A watercolor fox reading under an oak tree');
  assert.equal(picture.form.get('width'), '1344');
  assert.equal(picture.form.get('height'), '768');
  // Cloudflare's price: 3×2 output tiles, plus the safety check
  assert.equal(imageUSD('wide'), Math.ceil((6 * IMAGE.usdPerOutputTile + IMAGE.usdGuard) * 1e6) / 1e6);
  assert.equal(imageUSD('square'), Math.ceil((4 * IMAGE.usdPerOutputTile + IMAGE.usdGuard) * 1e6) / 1e6);
  const usage = await account.storage.get('usage');
  assert.ok(Math.abs(usage.trial_spent - out.costUSD) < 1e-9, JSON.stringify(usage));
  assert.equal(account.holds.size, 0, 'the hold is let go');
});

test('starting pictures go to the model as input_image_0 and _1, JPEG or PNG under 512×512, two at most', async () => {
  const { session } = await signedIn();
  const r = await make(session, { prompt: 'Make the fox blue', refs: [{ data: jpeg(511, 384) }, { data: jpeg(300, 300) }] });
  assert.equal(r.status, 200, await r.clone().text());
  const form = ai.runs[1].form;
  assert.equal(form.get('input_image_0').type, 'image/jpeg');
  assert.equal(form.get('input_image_0').size, 40);
  assert.ok(form.get('input_image_1'));
  assert.equal((await r.json()).costUSD, imageUSD('square', 2));
  assert.equal((await make(session, { prompt: 'x', refs: [{ data: jpeg(512, 100) }] })).status, 400, '512 wide is too big');
  assert.equal((await make(session, { prompt: 'x', refs: [{ data: jpeg(10, 10) }, { data: jpeg(10, 10) }, { data: jpeg(10, 10) }] })).status, 400);
  assert.equal((await make(session, { prompt: 'x', refs: [{ data: Buffer.from('GIF89a........').toString('base64') }] })).status, 415);
  assert.equal(ai.runs.length, 2, 'none of those reached Workers AI');
  // PNG and JPEG headers read right
  const png = Buffer.alloc(33);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0, 0, 0, 0, 200], 0);
  assert.deepEqual(pictureSize(new Uint8Array(png)), { mime: 'image/png', w: 256, h: 200 });
  assert.deepEqual(pictureSize(new Uint8Array(Buffer.from(jpeg(320, 240), 'base64'))), { mime: 'image/jpeg', w: 320, h: 240 });
});

test('only the signed-in page, with a prompt of 2,000 characters at most and a known size', async () => {
  const { session } = await signedIn();
  assert.equal((await make(null)).status, 401, 'signed out');
  assert.equal((await make(session, undefined, { 'x-jarvis-chat': '' })).status, 403);
  assert.equal((await make(session, undefined, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await make(session, '{"prompt":"x"}', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await make(session, { prompt: '   ' })).status, 400);
  assert.equal((await make(session, { prompt: 'x'.repeat(IMAGE.maxPrompt + 1) })).status, 400);
  assert.equal((await make(session, { prompt: 'a cat', size: 'huge' })).status, 400);
  assert.equal(ai.runs.length, 0);
  assert.throws(() => parseImageBody({ prompt: 'a cat', refs: 'nope' }), /starting pictures/);
});

test('a prompt Llama Guard calls unsafe is refused before any picture is made; only the check is spent', async () => {
  const { session, account } = await signedIn();
  ai.verdict = { safe: false, categories: ['S12'] };
  const r = await make(session, { prompt: 'something not for Eden' });
  assert.equal(r.status, 422);
  assert.deepEqual(await r.json(), { error: 'Eden won’t make that picture. Ask for something else.', code: 'refused' });
  assert.deepEqual(ai.runs.map((x) => x.model), ['@cf/meta/llama-guard-3-8b'], 'no picture was made');
  assert.ok(Math.abs((await account.storage.get('usage')).trial_spent - IMAGE.usdGuard) < 1e-9);
  assert.equal(account.holds.size, 0);
  // the plain-text verdict too, and categories that don't apply to a picture (intellectual property) pass
  ai.verdict = 'unsafe\nS1';
  assert.equal((await make(session)).status, 422);
  ai.verdict = { safe: false, categories: ['S8'] };
  assert.equal((await make(session, { prompt: 'Mickey Mouse surfing' })).status, 200);
  ai.verdict = '\n\nsafe';
  assert.equal((await make(session)).status, 200);
});

test('the day’s pictures per account: refused and failed ones are given back; the reset is said', async () => {
  const { session } = await signedIn();
  ai.verdict = { safe: false, categories: ['S10'] };
  for (let i = 0; i < 4; i++) assert.equal((await make(session)).status, 422);
  ai.verdict = { safe: true, categories: [] };
  for (let i = 0; i < 3; i++) assert.equal((await make(session)).status, 200, `picture ${i + 1}`);
  const over = await make(session);
  assert.equal(over.status, 429);
  assert.match((await over.json()).error, /today’s 3 pictures/);
  assert.ok(Number(over.headers.get('retry-after')) >= 60);
  // everyone's total
  env.IMAGES_DAILY_PER_ACCOUNT = '50';
  env.IMAGES_DAILY_TOTAL = '3';
  const all = await make(session);
  assert.equal(all.status, 429);
  assert.match((await all.json()).error, /all the pictures it can today/);
});

test('no allowance, no AI binding, the free neurons gone, or the model failing: said plainly, nothing charged for a picture', async () => {
  const { session, account } = await signedIn();
  ai.picture = new Error('AiError: 3010: model failed');
  const failed = await make(session);
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: 'The picture couldn’t be made this time. Try again.', code: 'ai_error' });
  assert.ok((await account.storage.get('usage')).trial_spent <= IMAGE.usdGuard + 1e-9, 'only the check');
  ai.picture = new Error('4006: you have used up your daily free allocation of 10,000 neurons');
  const busy = await make(session);
  assert.equal(busy.status, 503);
  assert.match((await busy.json()).error, /all the pictures it can today/);
  ai.picture = { image: '' };
  assert.equal((await make(session)).status, 502);
  ai.verdict = new Error('guard down');
  assert.equal((await make(session)).status, 502, 'no verdict, no picture');
  assert.equal(account.holds.size, 0);
  ai.verdict = { safe: true, categories: [] };
  ai.picture = { image: PICTURE };
  assert.equal((await make(session)).status, 200, 'the failures above did not use the day’s 3');
  await account.storage.put('usage', { ...(await account.storage.get('usage')), month: new Date().toISOString().slice(0, 7), spent: 0, trial_spent: 1 });
  const broke = await make(session);
  assert.equal(broke.status, 402);
  delete env.AI;
  const off = await make(session);
  assert.equal(off.status, 503);
  assert.match((await off.json()).error, /isn’t set up/);
});
