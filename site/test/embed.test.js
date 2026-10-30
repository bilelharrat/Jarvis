// Eden Mail's embeddings on askeden.com (src/eden/embed.js): Gemini first, 256-d, in order; the cost estimate.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkTexts, embedTexts, embedUSD, EMBED_DIMS } from '../src/eden/embed.js';

test('embed: Gemini batch with the key in a header, 256-d, rounded; OpenAI put back in order; limits; cost', async () => {
  const seen = [];
  const f = async (url, init) => {
    seen.push({ url, init });
    const body = JSON.parse(init.body);
    if (url.includes('googleapis')) return Response.json({ embeddings: body.requests.map((_, i) => ({ values: [i, 0.333333] })) });
    return Response.json({ data: body.input.map((_, i) => ({ index: body.input.length - 1 - i, embedding: [body.input.length - 1 - i] })) });
  };
  assert.deepEqual(await embedTexts('gemini', 'gk', ['a', 'b'], f), [[0, 0.3333], [1, 0.3333]]);
  assert.equal(seen[0].init.headers['x-goog-api-key'], 'gk');
  assert.ok(!seen[0].url.includes('gk'), 'the key never goes in the URL');
  assert.equal(JSON.parse(seen[0].init.body).requests[0].outputDimensionality, EMBED_DIMS);
  assert.deepEqual(await embedTexts('openai', 'ok', ['a', 'b', 'c'], f), [[0], [1], [2]]);
  await assert.rejects(embedTexts('gemini', 'gk', ['a'], async () => new Response('no', { status: 429 })), /answered 429/);
  assert.throws(() => checkTexts('x'), /texts/);
  assert.equal(checkTexts(['z'.repeat(3000)])[0].length, 2000);
  assert.ok(Math.abs(embedUSD('gemini', ['x'.repeat(3_000_000)]) - 0.15) < 1e-9, '1M tokens of Gemini embeddings: $0.15');
  // Scoped deduplication: identical email examples in the same session aren't embedded or billed twice.
  seen.length = 0;
  assert.deepEqual(await embedTexts('gemini', 'gk', ['email-1', 'email-2'], f, { scope: 's1' }), [[0, 0.3333], [1, 0.3333]]);
  assert.equal(seen.length, 1);
  assert.equal(embedUSD('gemini', ['email-1', 'email-3'], { scope: 's1' }), embedUSD('gemini', ['email-3']));
  assert.deepEqual(await embedTexts('gemini', 'gk', ['email-1', 'email-3'], f, { scope: 's1' }), [[0, 0.3333], [0, 0.3333]]);
  assert.equal(seen.length, 2);
  assert.equal(JSON.parse(seen[1].init.body).requests.length, 1, 'only the uncached text was sent to Gemini');
});
