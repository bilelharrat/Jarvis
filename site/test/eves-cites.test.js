// EVES's final answer cites like Eden's other answers (owner, 2026-11-11): GPT's inline "([site](url))" links become
// marks, and the page puts "[n]" right after the words each source backs (public/eden/cite-marks.js placeMarks).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inlineCitations } from '../src/eden/eves.js';
import { placeMarks } from '../public/eden/cite-marks.js';

test('GPT inline source links become in-text numbers and leave the text', () => {
  const answer = 'The Chargers rank **28th** in points allowed. ([dash.football](https://dash.football/teams/chargers/stats/?utm_source=openai))\n\n- McCarthy was traded on **September 28, 2026**. ([vikings.com](https://www.vikings.com/news/trade?utm_source=openai)) ([giants.com](https://www.giants.com/news/x))';
  const r = inlineCitations(answer);
  assert.doesNotMatch(r.text, /\]\(https?:/, 'no inline link left');
  assert.deepEqual(r.sources.map((s) => s.url), ['https://dash.football/teams/chargers/stats/', 'https://www.vikings.com/news/trade', 'https://www.giants.com/news/x']);
  assert.equal(r.marks.length, 2, 'two places; the second backed by two sources');
  const parts = [{ type: 'text', text: r.text }];
  placeMarks(parts, r.marks, r.sources);
  assert.match(parts[0].text, /points allowed\.\[1\]/);
  assert.match(parts[0].text, /2026\*\*\.\[2\]\[3\]/);
});

test('an answer without inline links is left alone', () => {
  const r = inlineCitations('The Eiffel Tower was completed on March 31, 1889. See [the official site](https://www.toureiffel.paris) for more.');
  assert.equal(r.marks.length, 0);
  assert.match(r.text, /\[the official site\]\(https:\/\/www\.toureiffel\.paris\)/);
});
