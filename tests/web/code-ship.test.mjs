// Jarvis Code's pull requests, unattended runs, GitHub issues and waiting out Claude's
// limit (web/features/code_pr.js and the others listed below): every sentence each shows
// has its Chinese in its web/i18n fragment or the window's own i18n-zh.json, and every
// fragment is well formed.
// node --test tests/web/
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = process.env.JARVIS_WEB_DIR || fileURLToPath(new URL('../../src/jarvis/web/', import.meta.url));
const SCRIPTS = ['code_pr', 'code_unattended', 'code_limit'].filter((name) => existsSync(`${WEB}/features/${name}.js`));
const core = JSON.parse(readFileSync(`${WEB}/i18n-zh.json`, 'utf8'));

function dictionary(name) {
  const fragment = JSON.parse(readFileSync(`${WEB}/i18n/${name}.json`, 'utf8'));
  const strings = { ...core.strings, ...fragment.strings };
  const patterns = [...core.patterns, ...fragment.patterns].map(([re, rep]) => [new RegExp(re), rep]);
  return {
    fragment,
    chinese(text) {
      const key = text.replace(/\s+/g, ' ').trim();
      if (!key || key in strings) return true;
      return patterns.some(([re]) => re.test(key));
    },
  };
}

// The sentences in a script: quoted text that starts with a capital. Code (selectors, ids,
// event names) doesn't; templates with ${} are checked by hand below.
function sentences(source) {
  const found = new Set();
  for (const m of source.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) {
    const s = m[1];
    if (/^[A-Z(]/.test(s) && /[a-z]/.test(s) && !/^[A-Z_]+$/.test(s) && !s.includes('${')) found.add(s);
  }
  return [...found];
}

for (const name of SCRIPTS) {
  test(`every sentence ${name}.js shows has its Chinese`, () => {
    const { chinese } = dictionary(name);
    const all = sentences(readFileSync(`${WEB}/features/${name}.js`, 'utf8'));
    assert.ok(all.length > 5, `only ${all.length} found`);
    assert.deepEqual(all.filter((s) => !chinese(s)), []);
  });

  test(`${name}'s fragment is well formed`, () => {
    const { fragment } = dictionary(name);
    for (const [en, zh] of Object.entries(fragment.strings)) {
      assert.equal(typeof zh, 'string', en);
      assert.ok(/[一-鿿]/.test(zh), `no Chinese for ${en}`);
    }
    for (const [re, rep] of fragment.patterns) assert.doesNotThrow(() => new RegExp(re), rep);
  });
}

test('the pull request pane’s sentences with numbers in them are covered', () => {
  const { chinese } = dictionary('code_pr');
  for (const s of ['Checks (3)', 'Comments (12)', '1 commit', '4 commits', '1 uncommitted file is committed first',
    '2 uncommitted files are committed first', '1 uncommitted change isn’t in it: commit in the Git panel first',
    '3 uncommitted changes aren’t in it: commit in the Git panel first',
    'Sends the failing logs to the session when it’s idle, at most 3 times (2 left), then pushes its fix behind the push card.']) {
    assert.ok(chinese(s), s);
  }
});
