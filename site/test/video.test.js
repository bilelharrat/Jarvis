// Video understanding on askeden.com (eden/video.js): the limits (mime, size, length by plan),
// the estimate, the models that may read a video (cheapest Gemini first), the request's file_data
// part, and the whole flow: upload → Files API (resumable) → ACTIVE → a turn forced to Gemini,
// metered by Gemini's usageMetadata, the file deleted after.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetSessions } from '../src/eden/session.js';
import { hostedConfig, parseSend } from '../src/eden/chat.js';
import { VIDEO, parseDuration, videoEstimateUSD, videoModels, videoProblem, videoTokens, withVideoParts } from '../src/eden/video.js';
import { Account, Link, identityToken, appleJwk, namespace, readEvents } from './fakes.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';

const ORIGIN = 'https://askeden.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const MB = 1024 * 1024;
const realFetch = globalThis.fetch;
let env;
let waits;
let calls;
let gemini; // { duration, state sequence }
const ctx = { waitUntil: (p) => waits.push(p) };
const URI = (name) => `https://generativelanguage.googleapis.com/v1beta/${name}`;

beforeEach(() => {
  waits = [];
  calls = [];
  forgetAppleKeys();
  forgetSessions();
  gemini = { duration: '42.5s', states: ['PROCESSING', 'ACTIVE'], deleted: [] };
  env = { ANTHROPIC_API_KEY: 'sk-test', GEMINI_API_KEY: 'g-test', TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20' };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = init.method || 'GET';
    calls.push({ url, method, init });
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    const file = (state) => ({ name: 'files/abc123', uri: URI('files/abc123'), mimeType: 'video/mp4', sizeBytes: '5000000', state, videoMetadata: { videoDuration: gemini.duration } });
    if (url.endsWith('/upload/v1beta/files')) return new Response('', { headers: { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=u1' } });
    if (url.includes('upload_id=u1')) return Response.json({ file: file(gemini.states.shift()) });
    if (url === URI('files/abc123') && method === 'GET') return Response.json(file(gemini.states.shift() || 'ACTIVE'));
    if (url === URI('files/abc123') && method === 'DELETE') return gemini.deleted.push('files/abc123'), Response.json({});
    if (url.includes(':streamGenerateContent')) {
      const chunk = { candidates: [{ content: { parts: [{ text: 'A cat jumps.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12000, candidatesTokenCount: 20 } };
      return new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
});
after(() => {
  globalThis.fetch = realFetch;
});

async function hit(p, { method = 'GET', body, headers = {}, session } = {}) {
  const h = { 'user-agent': UA, ...headers };
  if (method !== 'GET') h.origin ??= ORIGIN;
  if (session) h.cookie = `__Host-eden=${session}`;
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body);
    h['content-type'] ??= 'application/json';
  }
  const r = await worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
  while (waits.length) await Promise.all(waits.splice(0));
  return r;
}
async function signedIn() {
  const owner = await (await hit('/api/account/apple', { method: 'POST', headers: { origin: undefined }, body: { identity_token: await identityToken(), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } } })).json();
  const link = await hit('/api/web/link', { method: 'POST', body: {} });
  const code = (await link.clone().json()).code;
  const cookie = link.headers.getSetCookie().find((c) => c.startsWith('__Host-eden-link=')).split(';')[0];
  await hit(`/api/link/${code}/approve`, { method: 'POST', headers: { authorization: `Bearer ${owner.token}`, origin: undefined, 'user-agent': undefined }, body: { sealed_key: null, sender_key: null } });
  const done = await hit('/api/web/link/poll', { method: 'POST', body: {}, headers: { cookie } });
  return done.headers.getSetCookie().find((c) => c.startsWith('__Host-eden=')).split(';')[0].slice('__Host-eden='.length);
}
const upload = (session, { type = 'video/mp4', size = 5 * MB, seconds = '42.5' } = {}) =>
  hit('/api/chat/video', { method: 'POST', session, body: new Uint8Array(size), headers: { 'x-jarvis-chat': '1', 'content-type': type, 'content-length': String(size), 'x-eden-name': 'cat.mp4', 'x-eden-seconds': seconds } });

// ── the pure parts ──

test('mime, size and length are checked against the plan', () => {
  assert.equal(videoProblem({ mime: 'video/mp4', size: 10 * MB, seconds: 60 }), null);
  assert.equal(videoProblem({ mime: 'video/quicktime', size: MB, seconds: 60 }), null);
  assert.equal(videoProblem({ mime: 'video/webm', size: MB, seconds: 60 }), null);
  assert.match(videoProblem({ mime: 'video/x-msvideo', size: MB, seconds: 1 }), /MP4, MOV or WebM/);
  assert.match(videoProblem({ mime: 'video/mp4', size: 101 * MB, seconds: 1 }), /up to 100 MB/);
  assert.match(videoProblem({ mime: 'video/mp4', size: 0, seconds: 1 }), /empty/);
  assert.match(videoProblem({ mime: 'video/mp4', size: MB, seconds: 21 * 60 }, VIDEO.freeSeconds), /up to 20 minutes \(60 minutes on Plus\)/);
  assert.equal(videoProblem({ mime: 'video/mp4', size: MB, seconds: 50 * 60 }, VIDEO.plusSeconds), null);
  assert.match(videoProblem({ mime: 'video/mp4', size: MB, seconds: 61 * 60 }, VIDEO.plusSeconds), /up to 60 minutes\./);
  assert.equal(parseDuration('123.5s'), 123.5);
  assert.equal(parseDuration(undefined), null);
});

test('the estimate: ~300 tokens a second × the model’s input price (low resolution past 45 minutes)', () => {
  const lite = { pricing: { inputPer1M: 0.3 } };
  assert.equal(videoTokens(240), 72_000);
  assert.equal(videoEstimateUSD(240, lite), 0.0216); // 4 min: 72k tokens × $0.30/M
  assert.equal(videoTokens(50 * 60), 300_000); // 50 min at ~100 a second
});

test('a video goes to the cheapest Gemini that reads it; the request names it as file_data', () => {
  const cfg = hostedConfig({});
  assert.deepEqual(videoModels(cfg.models).map((m) => m.id), ['gemini-3.5-flash-lite', 'gemini-3.8-flash']);
  assert.deepEqual(videoModels(cfg.models.filter((m) => m.id !== 'gemini-3.5-flash-lite')).map((m) => m.id), ['gemini-3.8-flash']);
  assert.deepEqual(videoModels(cfg.models.filter((m) => m.provider !== 'gemini')), []);
  const body = { contents: [{ role: 'user', parts: [{ text: 'What happens?' }] }], generationConfig: {} };
  withVideoParts(body, [{ uri: URI('files/abc'), mime: 'video/mp4', seconds: 60 }]);
  assert.deepEqual(body.contents[0].parts[0], { file_data: { file_uri: URI('files/abc'), mime_type: 'video/mp4' } });
  assert.equal(body.contents[0].parts[1].text, 'What happens?');
  assert.equal(body.generationConfig.mediaResolution, undefined);
  withVideoParts(body, [{ uri: URI('files/abc'), mime: 'video/mp4', seconds: 50 * 60 }]);
  assert.equal(body.generationConfig.mediaResolution, 'MEDIA_RESOLUTION_LOW');
});

test('the turn checks a video attachment; an earlier one stays as a note', () => {
  const v = { kind: 'video', name: 'cat.mp4', mime: 'video/mp4', file: 'files/abc', uri: URI('files/abc'), seconds: 12 };
  const ok = parseSend({ messages: [{ role: 'user', content: 'Hi', attachments: [v] }] }, hostedConfig({}));
  assert.equal(ok.messages[0].attachments[0].kind, 'video');
  assert.throws(() => parseSend({ messages: [{ role: 'user', content: 'Hi', attachments: [{ ...v, mime: 'video/avi' }] }] }, hostedConfig({})), /mime/);
  assert.throws(() => parseSend({ messages: [{ role: 'user', content: 'Hi', attachments: [{ ...v, uri: 'https://evil.example/files/abc' }] }] }, hostedConfig({})), /uri/);
  const later = parseSend({ messages: [{ role: 'user', content: 'Hi', attachments: [v] }, { role: 'assistant', content: 'A cat.' }, { role: 'user', content: 'More?' }] }, hostedConfig({}));
  assert.equal(later.messages[0].attachments[0].kind, 'text');
});

// ── the flow ──

test('upload → ACTIVE → a turn forced to Gemini Flash-Lite with file_data, metered, the file deleted', async () => {
  const session = await signedIn();
  const r = await upload(session);
  assert.equal(r.status, 200, await r.clone().text());
  const up = await r.json();
  assert.equal(up.file, 'files/abc123');
  assert.equal(up.seconds, 42.5);
  assert.equal(up.estimate.model, 'gemini-3.5-flash-lite');
  assert.equal(up.estimate.confirm, false);
  const start = calls.find((c) => c.url.endsWith('/upload/v1beta/files'));
  assert.equal(start.init.headers['x-goog-upload-protocol'], 'resumable');
  assert.equal(start.init.headers['x-goog-api-key'], 'g-test');

  const send = await hit('/api/chat/send', {
    method: 'POST',
    session,
    headers: { 'x-jarvis-chat': '1' },
    body: { temporary: true, override: { model: 'claude-opus-5-5' }, messages: [{ role: 'user', content: 'What happens?', attachments: [{ kind: 'video', name: 'cat.mp4', mime: 'video/mp4', file: up.file, uri: up.uri, seconds: 42.5 }] }] },
  });
  assert.equal(send.status, 200, await send.clone().text());
  const events = await readEvents(send);
  while (waits.length) await Promise.all(waits.splice(0));
  const route = events.find((e) => e.type === 'route').data;
  assert.equal(route.model, 'gemini-3.5-flash-lite');
  const usage = events.find((e) => e.type === 'usage').data;
  assert.equal(usage.inputTokens, 12000);
  const g = calls.find((c) => c.url.includes(':streamGenerateContent'));
  const sent = JSON.parse(g.init.body);
  assert.deepEqual(sent.contents.at(-1).parts[0], { file_data: { file_uri: URI('files/abc123'), mime_type: 'video/mp4' } });
  assert.deepEqual(gemini.deleted, ['files/abc123']);
});

test('too long for Free by Google’s own reading, too big, or not a video: refused; no Gemini: a clear message', async () => {
  const session = await signedIn();
  gemini.duration = `${25 * 60}s`;
  const long = await upload(session, { seconds: '10' });
  assert.equal(long.status, 413);
  assert.match((await long.json()).error, /up to 20 minutes/);
  assert.deepEqual(gemini.deleted, ['files/abc123']);
  const said = await upload(session, { seconds: String(30 * 60) });
  assert.equal(said.status, 413);
  const avi = await upload(session, { type: 'video/x-msvideo' });
  assert.equal(avi.status, 415);
  delete env.GEMINI_API_KEY;
  const none = await upload(session);
  assert.equal(none.status, 422);
  assert.match((await none.json()).error, /Gemini/);
});
