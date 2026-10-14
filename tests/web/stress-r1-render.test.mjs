// Stress, round 1: the window's renderers of untrusted text (web/features/rich-chat.js and
// code-markdown.js) against hostile input: nothing becomes a link that isn't a web address,
// no markup survives as markup, and a long hostile reply renders in linear time (the main
// chat runs looksMarked and the renderer again on every streamed word). node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const rich = require('../../src/jarvis/web/features/rich-chat.js');
const M = require('../../src/jarvis/web/features/code-markdown.js');

// Linear, not fast: run(n) once to warm up (compiling it was counted, and a busy Mac went
// past a fixed 500 ms), then at n and 2n. Twice the input in about twice the time passes; a
// quadratic pass takes four times as long, and the versions that were took 2 to 9 seconds
// at N alone, far past CAP_MS at 2N. Each time is the best of three; SLACK_MS is the noise a
// few-millisecond pass still has on a busy Mac.
const N = 60_000;
const CAP_MS = 4000;
const SLACK_MS = 50;

function quick(what, run) {
  run(N);
  const timed = (n) => {
    let best = Infinity; // (the best of three: a garbage collection mid-run isn't the pass)
    for (let k = 0; k < 3; k += 1) {
      const t0 = process.hrtime.bigint();
      run(n);
      best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
      if (best > CAP_MS) break;
    }
    return best;
  };
  const once = timed(N);
  const twice = timed(2 * N);
  const said = `${what}: ${once.toFixed(0)} ms, then ${twice.toFixed(0)} ms for twice as much`;
  assert.ok(twice < 3 * once + SLACK_MS, said);
  assert.ok(twice < CAP_MS, said);
}

// Every token, however deep.
function* walk(tokens) {
  for (const tok of tokens) {
    yield tok;
    if (tok.c) yield* walk(tok.c);
  }
}

function* blockTokens(blocks) {
  for (const b of blocks) {
    if (b.type === 'para' || b.type === 'heading') yield* walk(M.inline(b.text));
    if (b.type === 'quote') yield* blockTokens(b.blocks);
    if (b.type === 'list') for (const item of b.items) yield* blockTokens(item.blocks);
    if (b.type === 'table') for (const cell of [...b.head, ...b.rows.flat()]) yield* walk(M.inline(cell));
  }
}

test('looksMarked stays linear on runs of unclosed links', () => {
  quick('a run of [', (n) => assert.equal(rich.looksMarked('['.repeat(n)), false));
  quick('a run of [a](', (n) => assert.equal(rich.looksMarked('[a]('.repeat(n / 4)), false));
  quick('a run of [a]', (n) => assert.equal(rich.looksMarked('[a] '.repeat(n / 4)), false));
  // and still finds a link wherever it is
  assert.equal(rich.looksMarked(`${'['.repeat(1000)}a](b)`), true);
  assert.equal(rich.looksMarked('see [x](\ny)'), true);
  assert.equal(rich.looksMarked('[](b) and [a]() and [a](b'), false);
});

test('a heading with a long run of spaces in it parses in linear time', () => {
  let b;
  quick('heading', (n) => { b = M.parse(`# a${' '.repeat(n)}b`); });
  assert.equal(b[0].type, 'heading');
  quick('heading, tabs', (n) => M.parse(`## x${' \t'.repeat(n / 2)}y ##`));
  assert.deepEqual(M.parse('# Title ##'), [{ type: 'heading', level: 1, text: 'Title' }]);
  assert.deepEqual(M.parse('# Title#'), [{ type: 'heading', level: 1, text: 'Title#' }]);
});

test('a line break after a long run of spaces mid-line is linear', () => {
  quick('spaces then a break', (n) => M.inline(`a${' '.repeat(n)}b\nc`));
  assert.deepEqual(M.inline('a  \nb').map((t) => t.t), ['text', 'br', 'text']);
  assert.equal(M.inline('a  \nb')[0].v, 'a');
});

test('a long code span with a space at its start is linear', () => {
  let out;
  quick('code span', (n) => { out = M.inline(`\` ${'a'.repeat(n)}\``); });
  assert.equal(out[0].t, 'code');
  assert.equal(M.inline('` a `')[0].v, 'a');
  assert.equal(M.inline('`   `')[0].v, '   ');
});

test('bare addresses ending in long runs of ) or dots stay linear', () => {
  quick('closing parens', (n) => M.inline(`http://a${')'.repeat(1990)} `.repeat(n / 2000)));
  quick('dots mid-address', (n) => M.inline(`http://a${'.'.repeat(1990)}a `.repeat(n / 2000)));
  assert.equal(M.trimUrl('https://e.com/a_(b))).'), 'https://e.com/a_(b)');
  assert.equal(M.trimUrl('https://e.com/x...'), 'https://e.com/x');
});

test('a link title after a long run of spaces is linear', () => {
  quick('titles', (n) => M.inline(`[a](a${' '.repeat(1985)}"x"b) `.repeat(n / 2000)));
  const [link] = M.inline('[a](https://e.com/x  "the title")');
  assert.equal(link.href, 'https://e.com/x');
});

test('script, handlers and odd schemes never become links or markup', () => {
  const hostile = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[click](javascript:alert(1))',
    '[click](JaVaScRiPt:alert(1))',
    '[click]( javascript:alert(1) )',
    '[click](<javascript:alert(1)>)',
    '[click](java\tscript:alert(1))',
    '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    '[click](vbscript:msgbox(1))',
    '[click](file:///etc/passwd)',
    '[click](//evil.example/x)',
    '![x](javascript:alert(1))',
    '![x](data:image/svg+xml,<svg onload=alert(1)>)',
    '<javascript:alert(1)>',
    '&#106;avascript:alert(1)',
    '[a](&#106;avascript:alert(1))',
    '[a](https://e.com/" onmouseover="alert(1))',
    '[a](../../../../etc/passwd)',
    '[a](~/.ssh/id_rsa)',
    '`<b>bold</b>`',
    '**<i onclick=x>**',
    '| <b>x</b> | y |\n|---|---|\n| [z](javascript:1) | <svg/onload=1> |',
    '> [q](javascript:1)\n> - [l](data:x)',
    `${'['.repeat(50)}x](javascript:1)${']'.repeat(50)}`,
  ];
  for (const text of hostile) {
    for (const tok of blockTokens(M.parse(text))) {
      if (tok.t === 'link') assert.match(tok.href, /^https?:\/\/[^\s]+$/i, `${text} -> ${tok.href}`);
      if (tok.t === 'path') {
        assert.ok(!tok.path.includes('..') && !tok.path.startsWith('~') && !/^[a-z][a-z0-9+.-]*:/i.test(tok.path), `${text} -> ${tok.path}`);
      }
      assert.ok(['text', 'br', 'code', 'link', 'path', 'em', 'strong', 'both', 'del'].includes(tok.t), tok.t);
    }
  }
});

test('deep nesting and huge input stay bounded', () => {
  quick('nested quotes', (n) => M.parse('>'.repeat(n)));
  quick('nested lists', (n) => M.parse(Array.from({ length: 2000 }, (_, k) => `${'  '.repeat(k)}- a`).join('\n')));
  quick('nested emphasis', (n) => M.inline(`${'*_~~'.repeat(n / 8)}x${'~~_*'.repeat(n / 8)}`));
  quick('unclosed backticks', (n) => M.inline('`a'.repeat(n / 2)));
  quick('an unclosed fence', (n) => M.parse(`\`\`\`\n${'x\n'.repeat(n / 2)}`));
  quick('a wide table', (n) => M.parse(`${'|a'.repeat(n / 4)}|\n${'|-'.repeat(n / 4)}|\n${'|x'.repeat(n / 4)}|`));
});
