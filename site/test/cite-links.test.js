// Gemini's sources come as Google redirect links that expire; the reply's chips and source popups showed that host
// (owner, 2026-11-06). realLinks (src/eden/chat.js) looks each up once for the page it leads to; the marks (where each
// source's number goes in the reply) follow. No network here: a fake fetch answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { realLinks } from '../src/eden/chat.js';

const R = (id) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${id}`;
const answer = (map, seen = []) => async (url, init) => {
  seen.push({ url, redirect: init.redirect });
  if (map[url] === 'slow') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  if (map[url] === 'fail') throw new TypeError('network');
  return new Response(null, { status: map[url] ? 302 : 404, headers: map[url] ? { location: map[url] } : {} });
};

test('redirect links become the pages they lead to; two to one page become one source; marks follow', async () => {
  const citations = [{ title: 'wikipedia.org', url: R('a') }, { title: 'nrk.no', url: R('b') }, { title: 'wikipedia.org', url: R('c') }, { title: 'x', url: 'https://example.org/already' }];
  const marks = [{ after: 'One.', urls: [R('a'), R('b')] }, { after: 'Two.', urls: [R('c'), R('a')] }];
  const seen = [];
  await realLinks(citations, marks, undefined, answer({ [R('a')]: 'https://en.wikipedia.org/wiki/Ut%C3%B8ya', [R('b')]: 'https://www.nrk.no/x', [R('c')]: 'https://en.wikipedia.org/wiki/Ut%C3%B8ya' }, seen));
  assert.deepEqual(citations.map((c) => c.url), ['https://en.wikipedia.org/wiki/Ut%C3%B8ya', 'https://www.nrk.no/x', 'https://example.org/already']);
  // the Google links the answer's words may still point at stay with each source (markdown.js shows them as its number)
  assert.equal(citations[0].via, R('a'));
  assert.deepEqual(citations[0].aka, [R('c')]);
  assert.equal(citations[1].via, R('b'));
  assert.equal(citations[2].via, undefined);
  assert.deepEqual(marks, [{ after: 'One.', urls: ['https://en.wikipedia.org/wiki/Ut%C3%B8ya', 'https://www.nrk.no/x'] }, { after: 'Two.', urls: ['https://en.wikipedia.org/wiki/Ut%C3%B8ya'] }]);
  assert.ok(seen.every((s) => s.redirect === 'manual'), 'never follows the redirect itself');
  assert.equal(seen.length, 3, 'only the redirect links are looked up');
});

test('a slow, failed or unanswered lookup keeps the redirect link; nothing to look up, no fetch', async () => {
  const citations = [{ title: 'a', url: R('slow') }, { title: 'b', url: R('fail') }, { title: 'c', url: R('none') }];
  const t0 = Date.now();
  await realLinks(citations, [], undefined, answer({ [R('slow')]: 'slow', [R('fail')]: 'fail' }));
  assert.ok(Date.now() - t0 < 3000, 'gives up after about 1.5 s');
  assert.deepEqual(citations.map((c) => c.url), [R('slow'), R('fail'), R('none')]);
  let called = 0;
  await realLinks([{ title: 'x', url: 'https://example.org/' }], [], undefined, async () => { called++; return new Response(null); });
  assert.equal(called, 0);
});
