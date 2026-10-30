// Pictures with a search answer, ChatGPT-style (src/eden/web-images.js, askeden web/chat/search-images.js): the
// prompt line, the `[images: …]` line taken out of the stream, the Wikipedia lookup, the `webimages` event before
// `done`, and the signed-in picture proxy. Fake fetch: no model, no Wikipedia.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const A = '11111111-1111-4111-8111-111111111111';
const THUMB = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Machu_Picchu.jpg/640px-Machu_Picchu.jpg';
const SEARCH = { query: { pages: [{ index: 1, title: 'Machu Picchu', fullurl: 'https://en.wikipedia.org/wiki/Machu_Picchu', pageimage: 'Machu_Picchu.jpg', thumbnail: { source: `${THUMB}?utm_source=x`, width: 640, height: 427 } }] } };
const IMAGES = { query: { pages: [{ title: 'File:Terraces.jpg', imageinfo: [{ mime: 'image/jpeg', width: 3000, height: 2000, thumbwidth: 640, thumbheight: 427, thumburl: THUMB.replace(/Machu_Picchu/g, 'Terraces'), descriptionurl: 'https://commons.wikimedia.org/wiki/File:Terraces.jpg' }] }] } };

let env;
let waits;
let calls;
let reply;
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;

const responses = (deltas) => [
  ...deltas.map((delta) => ['response.output_text.delta', { type: 'response.output_text.delta', delta }]),
  ['response.output_text.annotation.added', { type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', url: 'https://en.wikipedia.org/wiki/Machu_Picchu', title: 'Machu Picchu' } }],
  ['response.completed', { type: 'response.completed', response: { usage: { input_tokens: 500, output_tokens: 60 } } }],
].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

beforeEach(() => {
  forgetSessions();
  waits = [];
  calls = [];
  reply = ['[images: Machu ', 'Picchu]\n', '\nAn Inca citadel ', 'high in the Andes.'];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    if (url === 'https://api.openai.com/v1/responses') return new Response(responses(reply), { headers: { 'content-type': 'text/event-stream' } });
    if (url.startsWith('https://en.wikipedia.org/w/api.php')) return Response.json(url.includes('generator=search') ? SEARCH : IMAGES);
    if (url.startsWith('https://thumb.wikimedia.org/')) return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } });
    if (url.startsWith('https://upload.wikimedia.org/')) return new Response('<html>', { headers: { 'content-type': 'text/html' } });
    throw new Error(`unexpected fetch ${url}`);
  };
  env = { OPENAI_API_KEY: 'sk-openai-test', TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '6', LINK_RATE: rateLimiter(), API_RATE: rateLimiter(), EDEN_RATE: rateLimiter(), AUTH_RATE: rateLimiter() };
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
  return { status: res.status, text, events, said: events.filter((e) => e.type === 'text').map((e) => e.data.text).join('') };
}
const instructions = () => JSON.parse(calls.find((c) => c.url === 'https://api.openai.com/v1/responses').init.body).instructions || '';

test('a search turn from a page that shows pictures: the line is gone, the pictures arrive (proxied) before done', async () => {
  const token = await browser();
  const r = await send(token, { messages: [{ role: 'user', content: 'What does Machu Picchu look like?' }], mode: 'search', images: true });
  assert.equal(r.status, 200, r.text);
  assert.match(instructions(), /\[images: <a short query/);
  assert.equal(r.said, 'An Inca citadel high in the Andes.');
  const types = r.events.map((e) => e.type);
  const pics = r.events.find((e) => e.type === 'webimages');
  assert.ok(pics, types.join(','));
  assert.ok(types.indexOf('webimages') < types.indexOf('done'));
  assert.equal(pics.data.query, 'Machu Picchu');
  assert.deepEqual(pics.data.images.map((p) => p.title), ['Machu Picchu', 'Terraces']);
  assert.equal(pics.data.images[0].src, `/api/chat/webimage?u=${encodeURIComponent(THUMB)}`);
  const wiki = calls.filter((c) => c.url.startsWith('https://en.wikipedia.org/'));
  assert.equal(wiki.length, 2);
  assert.match(wiki[0].init.headers['user-agent'], /EdenChat/);
});

test('no pictures from a page that didn’t ask (the iPhone app), on a chat turn, or when the model writes no line', async () => {
  const token = await browser();
  reply = ['[images: x]\n', 'Text'];
  const app = await send(token, { messages: [{ role: 'user', content: 'What does Machu Picchu look like?' }], mode: 'search' });
  assert.doesNotMatch(instructions(), /\[images:/);
  assert.equal(app.said, '[images: x]\nText', 'without the prompt nothing is filtered');
  assert.ok(!app.events.some((e) => e.type === 'webimages'));
  calls.length = 0;
  reply = ['An Inca citadel.'];
  const plain = await send(token, { messages: [{ role: 'user', content: 'What does Machu Picchu look like?' }], mode: 'search', images: true });
  assert.equal(plain.said, 'An Inca citadel.');
  assert.ok(!plain.events.some((e) => e.type === 'webimages'));
  assert.ok(!calls.some((c) => c.url.includes('wikipedia')));
});

test('GET /api/chat/webimage: signed in, Wikimedia only, pictures only', async () => {
  const token = await browser();
  const get = (u, cookie = `__Host-eden=${token}`) => worker.fetch(new Request(`${ORIGIN}/api/chat/webimage?u=${encodeURIComponent(u)}`, { headers: { cookie, 'user-agent': 'Mozilla/5.0 Safari/605', 'sec-fetch-site': 'same-origin' } }), env, ctx);
  const ok = await get(THUMB);
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal(ok.headers.get('content-type'), 'image/jpeg');
  assert.match(ok.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await get('https://evil.example/x.jpg')).status, 400);
  assert.equal((await get('https://upload.wikimedia.org/x.html')).status, 502);
  assert.ok([401, 403].includes((await get(THUMB, '')).status), 'signed out');
});
