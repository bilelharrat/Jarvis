// Eden makes pictures (src/eden/image.js): when a message asks for one, what it costs, and the turn itself.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { parseToken } from '../src/accounts/util.js';
import { forgetSessions } from '../src/eden/session.js';
import { editsLast, imageUSD, qualityFor, sizeFor, wantsImage } from '../src/eden/image.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const A = '11111111-1111-4111-8111-111111111111';
const PIXEL = 'UklGRhYAAABXRUJQVlA4TAoAAAAvAAAAAEX/I/of'; // a 1×1 webp
let env;
let waits;
let calls;
let openai;
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;

beforeEach(() => {
  forgetSessions();
  waits = [];
  calls = [];
  openai = () => Response.json({ created: 1, output_format: 'webp', quality: 'medium', size: '1024x1024', data: [{ b64_json: PIXEL }], usage: { input_tokens: 15, input_tokens_details: { text_tokens: 15, image_tokens: 0 }, output_tokens: 439 } });
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    if (url.startsWith('https://api.openai.com/v1/images/')) return openai(url, init);
    throw new Error(`unexpected fetch ${url}`);
  };
  env = { OPENAI_API_KEY: 'sk-openai-test', EDEN_IMAGES: 'on', TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '6', LINK_RATE: rateLimiter(), API_RATE: rateLimiter(), EDEN_RATE: rateLimiter(), AUTH_RATE: rateLimiter() };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.IDENTITIES = namespace(Identity, env);
  env.ASSETS = { fetch: async () => new Response('asset') };
});
after(() => { globalThis.fetch = realFetch; });

const settle = async () => { while (waits.length) await Promise.all(waits.splice(0)); };
const browser = async () => (await call(env, A, 'web-signin', { account_id: A, create: true, identity: { provider: 'google', sub_hash: 'h'.repeat(64), email: 'p@example.com' }, device: { name: 'Eden on the web: Safari on a Mac' } })).token;
async function send(token, body) {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/chat/send`, { method: 'POST', headers: { origin: ORIGIN, 'x-jarvis-chat': '1', 'content-type': 'application/json', cookie: `__Host-eden=${token}`, 'user-agent': 'Mozilla/5.0 Safari/605' }, body: JSON.stringify(body) }), env, ctx);
  const text = await res.text();
  await settle();
  const events = [...text.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map(([, type, data]) => ({ type, data: JSON.parse(data) }));
  return { status: res.status, text, events };
}

test('a message that asks for a picture, and one that doesn’t', () => {
  for (const yes of ['draw me a fox in the snow', 'Make an image of a red bicycle', 'can you generate a logo for my bakery', 'create a watercolor painting of Paris', 'Please design a poster for a jazz night', 'eden, draw a cat']) assert.ok(wantsImage(yes), yes);
  for (const no of ['what is in this image?', 'describe the picture I sent', 'how do I make an image smaller in CSS', 'make a list of groceries', 'explain how diffusion models draw images', 'is this photo real?']) assert.ok(!wantsImage(no), no);
  assert.ok(editsLast('now make it blue'));
  assert.ok(editsLast('add a hat to him'));
  assert.ok(!editsLast('draw a dog on a skateboard'));
  assert.equal(sizeFor('a wide banner for my site'), '1536x1024');
  assert.equal(sizeFor('a phone wallpaper of the moon'), '1024x1536');
  assert.equal(sizeFor('a cat'), '1024x1024');
  assert.equal(qualityFor('a highly detailed castle'), 'high');
  assert.equal(imageUSD({ input_tokens: 15, input_tokens_details: { text_tokens: 15 }, output_tokens: 439 }), 0.013245);
});

test('Image mode draws, streams the picture and charges the included AI', async () => {
  const token = await browser();
  const r = await send(token, { messages: [{ role: 'user', content: 'a small red fox sitting in snow' }], image: true });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.events.map((e) => e.type), ['route', 'image', 'usage', 'done']);
  const img = r.events.find((e) => e.type === 'image').data;
  assert.deepEqual([img.mime, img.data, img.size, img.edit], ['image/webp', PIXEL, '1024x1024', false]);
  assert.equal(r.events[0].data.image, true);
  const req = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/images/generations');
  assert.deepEqual([req.model, req.prompt, req.size, req.quality, req.output_format], ['gpt-image-2.5-sunburst', 'a small red fox sitting in snow', '1024x1024', 'medium', 'webp']);
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-openai-test');
  const allow = await call(env, A, 'allow-ai', { eden: true }, parseToken(token));
  assert.ok(Math.abs(1 - allow.allowance_left - 0.013245) < 1e-6, String(allow.allowance_left)); // the trial dollar, less the picture
});

test('a plain “draw me…” in Chat is a picture too; a follow-up changes the last one', async () => {
  const token = await browser();
  const r = await send(token, { messages: [{ role: 'user', content: 'draw me a lighthouse at dusk' }] });
  assert.equal(r.events[1].type, 'image');
  const again = await send(token, { messages: [{ role: 'user', content: 'draw me a lighthouse at dusk' }, { role: 'assistant', content: '[Eden made a picture: “draw me a lighthouse at dusk”]' }, { role: 'user', content: 'now make it snowy' }], imageBase: PIXEL, imageBaseMime: 'image/webp' });
  assert.equal(again.status, 200, again.text);
  assert.equal(calls.at(-1).url, 'https://api.openai.com/v1/images/edits');
  const form = calls.at(-1).init.body;
  assert.equal(form.get('prompt'), 'now make it snowy');
  assert.equal(form.getAll('image[]').length, 1);
  assert.equal(again.events.find((e) => e.type === 'image').data.edit, true);
});

test('OpenAI’s safety refusal reads plainly, and nothing is charged', async () => {
  const token = await browser();
  openai = () => Response.json({ error: { code: 'moderation_blocked', message: 'Your request was rejected by the safety system.' } }, { status: 400 });
  const r = await send(token, { messages: [{ role: 'user', content: 'x' }], image: true });
  assert.deepEqual(r.events.map((e) => e.type), ['route', 'error', 'done']);
  assert.match(r.events[1].data.message, /safety rules/);
  const allow = await call(env, A, 'allow-ai', { eden: true }, parseToken(token));
  assert.equal(allow.allowance_left, 1);
});

test('switched off: no Image mode, and “draw me…” gets a plain “Eden doesn’t make pictures”, free, never a chat model or OpenAI images', async () => {
  delete env.EDEN_IMAGES;
  const token = await browser();
  const meta = await worker.fetch(new Request(`${ORIGIN}/api/chat/meta`, { headers: { 'x-jarvis-chat': '1', cookie: `__Host-eden=${token}`, 'user-agent': 'Mozilla/5.0 Safari/605' } }), env, ctx);
  assert.equal((await meta.json()).images.available, false);
  globalThis.fetch = async (input) => { calls.push({ url: typeof input === 'string' ? input : input.url }); return new Response('{}', { status: 500 }); };
  const r = await send(token, { messages: [{ role: 'user', content: 'draw me a fox' }], image: true });
  assert.ok(!calls.some((c) => c.url.includes('/v1/images/')));
  assert.equal(calls.length, 0, 'no model call at all');
  assert.equal(r.status, 200);
  assert.deepEqual(r.events.map((e) => e.type), ['text', 'done']);
  assert.match(r.events[0].data.text, /Eden doesn\u2019t make pictures/);
  assert.doesNotMatch(r.events[0].data.text, /\b(?:soon|yet|coming)\b/i, 'never promises a feature during App Review');
});
