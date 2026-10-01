// The main chat in Markdown with its reply buttons (web/features/rich-chat.js). node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const rich = require('../../src/jarvis/web/features/rich-chat.js');
const WEB = process.env.JARVIS_WEB_DIR || fileURLToPath(new URL('../../src/jarvis/web/', import.meta.url));

test('Markdown is drawn only when the reply uses it', () => {
  assert.equal(rich.looksMarked('It’s 18 degrees and clear.'), false);
  assert.equal(rich.looksMarked('## Plan\nFirst this.'), true);
  assert.equal(rich.looksMarked('Use **bold** here'), true);
  assert.equal(rich.looksMarked('- one\n- two'), true);
  assert.equal(rich.looksMarked('1. first'), true);
  assert.equal(rich.looksMarked('```js\nx\n```'), true);
  assert.equal(rich.looksMarked('| a | b |'), true);
  assert.equal(rich.looksMarked('See [the docs](https://example.com)'), true);
  assert.equal(rich.looksMarked(''), false);
});

test('a reply gets its buttons once it is written', () => {
  assert.deepEqual(rich.actionsFor('Done.', 'idle'), ['copy', 'read', 'again', 'good', 'bad']);
  assert.deepEqual(rich.actionsFor('Done.', 'speaking'), ['copy', 'read', 'again', 'good', 'bad']);
  assert.deepEqual(rich.actionsFor('Half a rep', 'thinking'), []);
  assert.deepEqual(rich.actionsFor('', 'idle'), []);
  assert.equal(rich.TRY_AGAIN, 'Give me a different answer.'); // conversation_branch's TRY_AGAIN says it
});

test('every word on the buttons has its Chinese', () => {
  const zh = JSON.parse(readFileSync(`${WEB}/i18n/rich-chat.json`, 'utf8')).strings;
  for (const line of ['Copy', 'Copied', 'Read Aloud', 'Try Again', 'Good Response', 'Bad Response', 'What was wrong? (optional)', 'Save', 'Cancel']) {
    assert.ok(zh[line], line);
  }
});
