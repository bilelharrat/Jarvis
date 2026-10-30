// Eden makes pictures and videos (src/eden/image.js): Model Router media routing across
// Google Imagen 4 (Fast / Standard / Ultra), Gemini Flash Image (edits), Cloudflare FLUX.2 klein,
// OpenAI GPT Image, and Google Veo 3 Fast / Veo 3 for video generation.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { parseToken } from '../src/accounts/util.js';
import { forgetSessions } from '../src/eden/session.js';
import { animatesLast, editsLast, imageUSD, qualityFor, routeImage, routeVideo, sizeFor, videoDurationFor, videoSizeFor, videoUSD, wantsImage, wantsVideo } from '../src/eden/image.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const A = '11111111-1111-4111-8111-111111111111';
const PIXEL = 'UklGRhYAAABXRUJQVlA4TAoAAAAvAAAAAEX/I/of'; // a 1×1 webp
const MP4_B64 = 'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE='; // minimal mp4 header bytes in base64
let env;
let waits;
let calls;
let openai;
let gemini;
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;

beforeEach(() => {
  forgetSessions();
  waits = [];
  calls = [];
  openai = () => Response.json({ created: 1, output_format: 'webp', quality: 'medium', size: '1024x1024', data: [{ b64_json: PIXEL }], usage: { input_tokens: 15, input_tokens_details: { text_tokens: 15, image_tokens: 0 }, output_tokens: 439 } });
  gemini = (url) => {
    if (url.includes(':predictLongRunning')) {
      return Response.json({ name: 'models/veo-3.0-fast-generate-001/operations/op-123', done: false });
    }
    if (url.includes('/operations/op-123')) {
      return Response.json({
        name: 'models/veo-3.0-fast-generate-001/operations/op-123',
        done: true,
        response: { generateVideoResponse: { generatedSamples: [{ video: { bytesBase64Encoded: MP4_B64, mimeType: 'video/mp4' } }] } },
      });
    }
    if (url.includes(':predict')) {
      return Response.json({ predictions: [{ bytesBase64Encoded: PIXEL, mimeType: 'image/webp' }] });
    }
    if (url.includes(':generateContent')) {
      return Response.json({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/webp', data: PIXEL } }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 1290 },
      });
    }
    return new Response('{}', { status: 404 });
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    if (url.startsWith('https://api.openai.com/v1/images/')) return openai(url, init);
    if (url.startsWith('https://generativelanguage.googleapis.com/')) return gemini(url, init);
    throw new Error(`unexpected fetch ${url}`);
  };
  env = { OPENAI_API_KEY: 'sk-openai-test', EDEN_IMAGES: 'on', EDEN_VIDEOS: 'on', EDEN_VIDEO_POLL_MS: '5', TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '6', LINK_RATE: rateLimiter(), API_RATE: rateLimiter(), EDEN_RATE: rateLimiter(), AUTH_RATE: rateLimiter() };
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

test('a message that asks for a picture or video, and one that doesn’t', () => {
  for (const yes of ['draw me a fox in the snow', 'Make an image of a red bicycle', 'can you generate a logo for my bakery', 'create a watercolor painting of Paris', 'Please design a poster for a jazz night', 'eden, draw a cat']) assert.ok(wantsImage(yes), yes);
  for (const no of ['what is in this image?', 'describe the picture I sent', 'how do I make an image smaller in CSS', 'make a list of groceries', 'explain how diffusion models draw images', 'is this photo real?', 'make a video of a fox', 'generate me a slide show with images on tom bradys offensive system and favorite plays as well', 'create a presentation with pictures about solar power']) assert.ok(!wantsImage(no), no);
  for (const vYes of ['make a video of a fox in the snow', 'generate a short clip of ocean waves', 'can you create an animation of a rocket launching', 'animate a cat playing piano', '/video a drone shot of mountains']) assert.ok(wantsVideo(vYes), vYes);
  for (const vNo of ['what is in this video?', 'summarize this video', 'how do I edit a video?', 'draw me a fox']) assert.ok(!wantsVideo(vNo), vNo);
  assert.ok(animatesLast('now animate it'));
  assert.ok(animatesLast('make it move'));
  assert.ok(animatesLast('turn this picture into a video'));
  assert.ok(!editsLast('now animate it'));
  assert.ok(editsLast('now make it blue'));
  assert.ok(editsLast('add a hat to him'));
  assert.ok(!editsLast('draw a dog on a skateboard'));
  assert.equal(sizeFor('a wide banner for my site'), '1536x1024');
  assert.equal(sizeFor('a phone wallpaper of the moon'), '1024x1536');
  assert.equal(sizeFor('a cat'), '1024x1024');
  assert.equal(qualityFor('a highly detailed castle'), 'high');
  assert.equal(videoSizeFor('a vertical story video of a waterfall'), '720x1280');
  assert.equal(videoSizeFor('a drone shot of mountains'), '1280x720');
  assert.equal(videoDurationFor('an 8 second video of rain'), 8);
  assert.equal(videoDurationFor('a cat yawning'), 5);
  assert.equal(imageUSD({ input_tokens: 15, input_tokens_details: { text_tokens: 15 }, output_tokens: 439 }), 0.013245);
  assert.equal(videoUSD('veo-3.0-fast-generate-001', 5), 0.75);
});

test('Model Router media routing: Imagen 4 Fast / Standard / Ultra, Gemini Flash Image for edits, Veo 3 Fast / Veo 3 for video', () => {
  const keys = { gemini: { key: 'g', source: 'service' }, openai: { key: 'o', source: 'service' } };
  // Level 1-2 -> Imagen 4 Fast ($0.02)
  const fast = routeImage({ prompt: 'a red apple', settings: { level: 1 }, keys, hasCloudflare: true });
  assert.equal(fast.chosen.id, 'imagen-4.0-fast-generate-001');
  assert.equal(fast.chosen.costUSD, 0.02);
  // Level 3 (default) -> Imagen 4 Standard ($0.04)
  const std = routeImage({ prompt: 'a red apple', settings: { level: 3 }, keys, hasCloudflare: true });
  assert.equal(std.chosen.id, 'imagen-4.0-generate-001');
  assert.equal(std.chosen.costUSD, 0.04);
  // Level 5 or high-detail prompt -> Imagen 4 Ultra ($0.06)
  const ultra = routeImage({ prompt: 'a photorealistic 4k portrait of an astronaut', settings: { level: 3 }, keys, hasCloudflare: true });
  assert.equal(ultra.chosen.id, 'imagen-4.0-ultra-generate-001');
  assert.equal(ultra.chosen.costUSD, 0.06);
  // Edit with reference image -> Gemini Flash Image
  const edit = routeImage({ prompt: 'now make it blue', edit: true, settings: { level: 3 }, keys, hasCloudflare: true });
  assert.equal(edit.chosen.id, 'gemini-2.5-flash-image');
  assert.deepEqual(edit.fallbacks.map((f) => f.id), ['@cf/black-forest-labs/flux-2-klein-4b', 'gpt-image-2.5-sunburst']);
  // Video routing: Veo 3 Fast default, Veo 3 at Level 5 / cinematic
  const vFast = routeVideo({ prompt: 'ocean waves at sunset', seconds: 5, settings: { level: 3 }, keys });
  assert.equal(vFast.chosen.id, 'veo-3.0-fast-generate-001');
  assert.equal(vFast.costUSD, 0.75);
  const vCinema = routeVideo({ prompt: 'a cinematic 4k film shot of a neon city', seconds: 5, settings: { level: 5 }, keys });
  assert.equal(vCinema.chosen.id, 'veo-3.0-generate-001');
  assert.equal(vCinema.costUSD, 2);
});

test('Google Imagen 4 draws new pictures first when GEMINI_API_KEY is set, and Gemini Flash Image edits the last picture', async () => {
  env.GEMINI_API_KEY = 'AIza-gemini-test';
  const token = await browser();
  const r = await send(token, { messages: [{ role: 'user', content: 'draw me a watercolor fox under an oak tree' }] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.events.map((e) => e.type), ['route', 'image', 'usage', 'done']);
  assert.equal(r.events[0].data.model, 'imagen-4.0-generate-001');
  assert.equal(r.events[0].data.provider, 'gemini');
  assert.ok(calls[0].url.includes('/v1beta/models/imagen-4.0-generate-001:predict'));
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'AIza-gemini-test');
  const img = r.events.find((e) => e.type === 'image').data;
  assert.equal(img.modelName, 'Imagen 4');
  assert.equal(img.edit, false);

  // Follow-up edit ("now make it snowy") routes to Gemini Flash Image (:generateContent)
  const again = await send(token, {
    messages: [
      { role: 'user', content: 'draw me a watercolor fox under an oak tree' },
      { role: 'assistant', content: '[Eden made a picture: “draw me a watercolor fox under an oak tree”]' },
      { role: 'user', content: 'now make it snowy' },
    ],
    imageBase: PIXEL,
    imageBaseMime: 'image/webp',
  });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.events[0].data.model, 'gemini-2.5-flash-image');
  assert.ok(calls.at(-1).url.includes('/v1beta/models/gemini-2.5-flash-image:generateContent'));
  const editBody = JSON.parse(calls.at(-1).init.body);
  assert.equal(editBody.contents[0].parts[0].inlineData.data, PIXEL);
  assert.equal(again.events.find((e) => e.type === 'image').data.edit, true);
  assert.equal(again.events.find((e) => e.type === 'image').data.modelName, 'Gemini Flash Image');
});

test('Google Veo generates a video clip and animates the last picture on follow-up', async () => {
  env.GEMINI_API_KEY = 'AIza-gemini-test';
  env.TRIAL_BUDGET_USD = '5';
  const token = await browser();
  const r = await send(token, { messages: [{ role: 'user', content: 'make a video of a red fox running through snow' }] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.events.map((e) => e.type), ['route', 'video', 'usage', 'done']);
  assert.equal(r.events[0].data.video, true);
  assert.equal(r.events[0].data.model, 'veo-3.0-fast-generate-001');
  const vid = r.events.find((e) => e.type === 'video').data;
  assert.deepEqual([vid.mime, vid.data, vid.size, vid.seconds, vid.fromImage], ['video/mp4', MP4_B64, '1280x720', 5, false]);

  // Follow-up ("now animate it") with imageBase sends the starting frame to Veo
  const anim = await send(token, {
    messages: [
      { role: 'user', content: 'draw me a lighthouse' },
      { role: 'assistant', content: '[Eden made a picture: “draw me a lighthouse”]' },
      { role: 'user', content: 'now animate it' },
    ],
    imageBase: PIXEL,
    imageBaseMime: 'image/webp',
  });
  assert.equal(anim.status, 200, anim.text);
  const animVideo = anim.events.find((e) => e.type === 'video').data;
  assert.equal(animVideo.fromImage, true);
  const startCall = calls.find((c) => c.url.includes(':predictLongRunning') && c !== calls[0]);
  const startReq = JSON.parse(startCall.init.body);
  assert.equal(startReq.instances[0].image.bytesBase64Encoded, PIXEL);
});

test('Image mode draws, streams the picture and charges the included AI (OpenAI when no Gemini key)', async () => {
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
  delete env.EDEN_VIDEOS;
  const token = await browser();
  const meta = await worker.fetch(new Request(`${ORIGIN}/api/chat/meta`, { headers: { 'x-jarvis-chat': '1', cookie: `__Host-eden=${token}`, 'user-agent': 'Mozilla/5.0 Safari/605' }, }), env, ctx);
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
