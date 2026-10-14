// Automated pull request reviews, the window's helpers (web/features/code-pr-review.js).
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const prr = require('../../src/jarvis/web/features/code-pr-review.js');

test('a review’s row says what became of it', () => {
  assert.equal(prr.statusLine({ status: 'done', findings: [{}] }), '1 finding posted on GitHub');
  assert.equal(prr.statusLine({ status: 'done', findings: [{}, {}] }), '2 findings posted on GitHub');
  assert.equal(prr.statusLine({ status: 'clean' }), 'Nothing found');
  assert.equal(prr.statusLine({ status: 'failed' }), 'The review didn’t finish');
  assert.equal(prr.statusLine(null), '');
  assert.equal(prr.findingWhere({ file: 'a.py', line: 3 }), 'a.py:3');
  assert.equal(prr.findingWhere({ file: 'a.py', line: 0 }), 'a.py');
});

test('a pull request to review now is read from what the owner types', () => {
  assert.deepEqual(prr.parsePull('acme/app#12'), { repo: 'acme/app', number: 12 });
  assert.deepEqual(prr.parsePull(' #12 ', 'acme/app'), { repo: 'acme/app', number: 12 });
  assert.deepEqual(prr.parsePull('https://github.com/acme/app/pull/9'), { repo: 'acme/app', number: 9 });
  assert.equal(prr.parsePull('12'), null); // (no repository to read it in)
  assert.equal(prr.parsePull('acme/app#x'), null);
  assert.equal(prr.parsePull(''), null);
});

test('every string the review settings and pane show has its Chinese', () => {
  const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n/code-pr-review.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('../../src/jarvis/web/features/code-pr-review.js', import.meta.url), 'utf8');
  const shown = [
    ...[...source.matchAll(/(?<!mine\()el\('[a-z0-9]+', '[^']*', '([^']+)'\)/g)].map((m) => m[1]),
    ...[...source.matchAll(/row\('([^']+)', '([^']*)'/g)].flatMap((m) => [m[1], m[2]]).filter(Boolean),
    ...[...source.matchAll(/button\('([^']+)'/g)].map((m) => m[1]),
    ...Object.values(prr.STATUS),
  ];
  assert.deepEqual(shown.filter((s) => !(s in zh.strings)), []);
  for (const [re, to] of zh.patterns) assert.match('3 findings posted on GitHub'.replace(new RegExp(re), to), /3/);
});
