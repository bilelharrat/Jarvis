// Eden Code's Markdown (web/features/code-markdown.js), its pure parser: blocks, inline
// pieces, where links may go and which language a code block is in. node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const M = require('../../src/jarvis/web/features/code-markdown.js');
const D = require('../../src/jarvis/web/features/code_diff.js');

const types = (blocks) => blocks.map((b) => b.type);
// Inline pieces as short strings: text, `code`, *em*, **strong**, [link](href)…
function flat(tokens) {
  return tokens.map((t) => {
    if (t.t === 'text') return t.v;
    if (t.t === 'br') return '⏎';
    if (t.t === 'code') return `\`${t.v}\``;
    if (t.t === 'link') return `[${flat(t.c)}](${t.href})`;
    if (t.t === 'path') return `[${flat(t.c)}](file:${t.path}${t.line ? `#${t.line}` : ''})`;
    return `<${t.t}>${flat(t.c)}</${t.t}>`;
  }).join('');
}

test('blocks: headings, paragraphs, rules, quotes and fenced code', () => {
  const b = M.parse('# Title\n\nSome text\non two lines.\n\n---\n\n> quoted\n> **still**\n\n```python\ndef f():\n    return 1\n```\nafter');
  assert.deepEqual(types(b), ['heading', 'para', 'rule', 'quote', 'code', 'para']);
  assert.equal(b[0].level, 1);
  assert.equal(b[0].text, 'Title');
  assert.equal(b[1].text, 'Some text\non two lines.');
  assert.deepEqual(types(b[3].blocks), ['para']);
  assert.equal(b[4].info, 'python');
  assert.equal(b[4].text, 'def f():\n    return 1');
  assert.equal(b[4].open, false);
  // A fence still being written (a streaming reply) is code to the end.
  const live = M.parse('Here:\n```js\nconst a = 1;');
  assert.deepEqual(types(live), ['para', 'code']);
  assert.equal(live[1].open, true);
  // Tildes, a longer fence holding a shorter one, and an indented fence.
  const nested = M.parse('~~~~md\n```\ninside\n```\n~~~~');
  assert.equal(nested[0].text, '```\ninside\n```');
  assert.equal(M.parse('  ```\n  x\n  ```')[0].text, 'x');
});

test('lists: bullets, numbers from where they start, nesting, to-dos and a list right after a sentence', () => {
  const b = M.parse('Steps:\n1. First\n2. Second\n   - nested a\n   - nested b\n3. Third');
  assert.deepEqual(types(b), ['para', 'list']);
  const list = b[1];
  assert.equal(list.ordered, true);
  assert.equal(list.items.length, 3);
  assert.deepEqual(types(list.items[1].blocks), ['para', 'list']);
  assert.equal(list.items[1].blocks[1].items.length, 2);
  // Two spaces under "1." count as nested too (many write it that way).
  const two = M.parse('1. a\n  - b\n2. c');
  assert.equal(two[0].items.length, 2);
  assert.deepEqual(types(two[0].items[0].blocks), ['para', 'list']);
  // Starts at 3; a change of marker is a new list.
  const start = M.parse('3. three\n4. four\n\n- x\n* y');
  assert.equal(start[0].start, 3);
  assert.deepEqual(types(start), ['list', 'list', 'list']);
  // To-dos.
  const todo = M.parse('- [x] done\n- [ ] open');
  assert.deepEqual(todo[0].items.map((i) => i.task), [true, false]);
  assert.equal(todo[0].items[0].blocks[0].text, 'done');
  // A number mid-paragraph isn't a list; a list item's text can run on.
  assert.deepEqual(types(M.parse('It was built in\n2019. Then it grew.')), ['para']);
  const lazy = M.parse('- one\ncontinued\n- two');
  assert.equal(lazy[0].items[0].blocks[0].text, 'one\ncontinued');
});

test('tables: header, alignment, cells with pipes in code, and rows made even', () => {
  const b = M.parse('| Name | Size | Note |\n|:-----|-----:|:----:|\n| `a|b` | 12 | x \\| y |\n| short |\n\nafter');
  assert.deepEqual(types(b), ['table', 'para']);
  const t = b[0];
  assert.deepEqual(t.head, ['Name', 'Size', 'Note']);
  assert.deepEqual(t.align, ['left', 'right', 'center']);
  assert.deepEqual(t.rows[0], ['`a|b`', '12', 'x | y']);
  assert.deepEqual(t.rows[1], ['short', '', '']);
  // Not a table: the delimiter row doesn't match the header.
  assert.deepEqual(types(M.parse('a | b\n---')), ['para', 'rule']);
});

test('inline: code, emphasis, strike, breaks and escapes', () => {
  assert.equal(flat(M.inline('run `npm test` and **then** *check* ~~this~~')), 'run `npm test` and <strong>then</strong> <em>check</em> <del>this</del>');
  assert.equal(flat(M.inline('``a `tick` inside``')), '`a `tick` inside`');
  assert.equal(flat(M.inline('***both*** and __under__ and _em_')), '<both>both</both> and <strong>under</strong> and <em>em</em>');
  // snake_case and 2 * 3 * 4 stay as they are; an escaped star is a star.
  assert.equal(flat(M.inline('max_retries = 2 * 3 * 4 and \\*not em\\*')), 'max_retries = 2 * 3 * 4 and *not em*');
  assert.equal(flat(M.inline('line one\nline two')), 'line one⏎line two');
  // Emphasis inside a code span isn't emphasis.
  assert.equal(flat(M.inline('`**not bold**`')), '`**not bold**`');
  // Many openers with no closer stay text, quickly (no rescans).
  const stars = '*a '.repeat(5000);
  const began = Date.now();
  assert.equal(flat(M.inline(stars)), stars);
  assert.ok(Date.now() - began < 1000, 'unclosed stars took too long');
});

test('links go to web addresses or project files; anything else is only its words', () => {
  assert.equal(flat(M.inline('see [the docs](https://example.com/a_(b)) now')), 'see [the docs](https://example.com/a_(b)) now');
  assert.equal(flat(M.inline('[x](javascript:alert(1))')), 'x');
  assert.equal(flat(M.inline('[x](data:text/html;base64,PHNjcmlwdD4=)')), 'x');
  assert.equal(flat(M.inline('[x](file:///etc/passwd)')), 'x');
  assert.equal(flat(M.inline('[hub](src/jarvis/hub.py:120)')), '[hub](file:src/jarvis/hub.py#120)');
  assert.equal(flat(M.inline('[hub](./src/hub.py#L7)')), '[hub](file:src/hub.py#7)');
  assert.equal(flat(M.inline('[up](../secret.txt)')), 'up');
  // Bare addresses and <autolinks>, without the sentence's full stop.
  assert.equal(flat(M.inline('Go to https://example.com/x. Or <https://a.dev/y>.')), 'Go to [https://example.com/x](https://example.com/x). Or [https://a.dev/y](https://a.dev/y).');
  // A picture on the web is never loaded: its words, as a link.
  assert.equal(flat(M.inline('![diagram](https://example.com/d.png)')), '[🖼 diagram](https://example.com/d.png)');
  assert.deepEqual(M.linkTarget('HTTPS://EXAMPLE.COM'), { href: 'HTTPS://EXAMPLE.COM' });
  assert.equal(M.linkTarget('vbscript:x'), null);
  assert.equal(M.linkTarget('~/.ssh/id_rsa'), null);
});

test('HTML in Claude’s words is text, never markup', () => {
  const b = M.parse('<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>');
  assert.deepEqual(types(b), ['para', 'para']);
  assert.equal(flat(M.inline(b[0].text)), '<img src=x onerror="alert(1)">');
});

test('a code block’s language, from its fence', () => {
  assert.equal(M.fenceLang('python', D.langFor), 'python');
  assert.equal(M.fenceLang('ts title="x.ts"', D.langFor), 'js');
  assert.equal(M.fenceLang('src/app.swift', D.langFor), 'swift');
  assert.equal(M.fenceLang('kts', D.langFor), 'java');
  assert.equal(M.fenceLang('diff', D.langFor), 'diff');
  assert.equal(M.fenceLang('', D.langFor), '');
  assert.equal(M.fenceLang('mermaid', D.langFor), '');
});

test('a long reply parses in linear time', () => {
  const para = 'Some **bold** text with `code` and a [link](https://example.com) here.\n';
  const text = `${para.repeat(400)}\n\`\`\`js\n${'const x = 1;\n'.repeat(2000)}\`\`\`\n${'- item\n'.repeat(500)}`;
  const began = Date.now();
  const blocks = M.parse(text);
  for (const b of blocks) if (b.type === 'para') M.inline(b.text);
  assert.ok(Date.now() - began < 1500, `took ${Date.now() - began} ms`);
  assert.deepEqual(types(blocks), ['para', 'code', 'list']);
});
