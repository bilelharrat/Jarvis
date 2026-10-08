// Ask Eden for Mac's download and update feed: GitHub release assets behind askeden.com routes.
import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { askEdenAssets } from '../src/worker.js';

test('/download/mac redirects to the release zip', async () => {
  const res = await worker.fetch(new Request('https://askeden.com/download/mac'), {}, {});
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://github.com/bilelharrat/Jarvis/releases/download/ask-eden-v0.1.0/Ask-Eden-0.1.0-arm64-mac.zip');
});

test('ASK_EDEN_TAG picks another release, and only a well-formed one', () => {
  assert.equal(askEdenAssets({ ASK_EDEN_TAG: 'ask-eden-v0.2.1' }).version, '0.2.1');
  assert.equal(askEdenAssets({ ASK_EDEN_TAG: '../evil' }).version, '0.1.0');
});

test('the update feed is read from the same release', async () => {
  const real = globalThis.fetch;
  let asked = '';
  globalThis.fetch = async (url) => { asked = String(url); return new Response('{"currentRelease":"0.1.0"}', { status: 200 }); };
  try {
    const res = await worker.fetch(new Request('https://askeden.com/downloads/ask-eden/release.json'), {}, {});
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /json/);
    assert.equal(asked, askEdenAssets().feed);
    assert.equal((await res.json()).currentRelease, '0.1.0');
  } finally { globalThis.fetch = real; }
});
