// Jarvis Code's workspace (web/features/code-*.js of features/code_workspace.py): every word
// its window scripts show has its Chinese, in the core dictionary or the feature's own
// (web/i18n/code-workspace.json). node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB = path.join(ROOT, 'src/jarvis/web');
const SCRIPTS = ['code-markdown.js', 'code-editor.js', 'code-search.js', 'code-terminal.js', 'code-mentions.js'];
// Words that stay as they are in Chinese too.
const AS_IS = new Set(['CRLF', 'LF', 'UTF-8', 'Aa', '.*']);

function dictionary() {
  const zh = JSON.parse(readFileSync(path.join(WEB, 'i18n-zh.json'), 'utf8'));
  const mine = JSON.parse(readFileSync(path.join(WEB, 'i18n', 'code-workspace.json'), 'utf8'));
  return {
    strings: { ...zh.strings, ...mine.strings },
    patterns: [...zh.patterns, ...mine.patterns].map(([re, rep]) => [new RegExp(re), rep]),
    mine,
  };
}

function covered(dict, text) {
  const key = text.replace(/\s+/g, ' ').trim();
  return key in dict.strings || dict.patterns.some(([re]) => re.test(key));
}

// The window's own words in a script: labels, titles, placeholders, menu items, notes.
function wordsOf(source) {
  const found = new Set();
  const q = "'((?:[^'\\\\]|\\\\.)+)'";
  const forms = [
    new RegExp(`\\bel\\('[\\w-]+', '[^']*', ${q}\\)`, 'g'),
    new RegExp(`\\bbutton\\(${q}`, 'g'),
    new RegExp(`\\.(?:textContent|title|placeholder) = ${q}`, 'g'),
    new RegExp(`setAttribute\\('aria-label', ${q}\\)`, 'g'),
    new RegExp(`\\b(?:label|heading|text): ${q}`, 'g'),
    new RegExp(`(?:^|[^\\w.])t\\(${q}\\)`, 'g'),
    new RegExp(`^\\s+\\w+: ${q},?$`, 'gm'),  // a table of notes: { too_big: '…', … }
    new RegExp(`, ${q}\\)`, 'g'),  // a call's last word: a button's title
    new RegExp(`\\btoggle\\('[^']*', ${q}`, 'g'),
  ];
  for (const re of forms) for (const m of source.matchAll(re)) found.add(m[1].replace(/\\'/g, "'"));
  // (A phrase, or a capitalized word: 'conflict' or 'unified' is a value, not a word shown.)
  const classes = (s) => s.split(/\s+/).every((w) => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(w));  // 'jc-field ce-filter'
  return [...found].filter((s) => /\p{L}/u.test(s) && !AS_IS.has(s) && !classes(s) && (/\s/.test(s) || /^\p{Lu}/u.test(s)));
}

test('every word the workspace’s window scripts show has its Chinese', () => {
  const dict = dictionary();
  const missing = [];
  let total = 0;
  for (const name of SCRIPTS) {
    const words = wordsOf(readFileSync(path.join(WEB, 'features', name), 'utf8'));
    total += words.length;
    missing.push(...words.filter((w) => !AS_IS.has(w) && !covered(dict, w)).map((w) => `${name}: ${w}`));
  }
  assert.ok(total > 40, `found only ${total}`);
  assert.deepEqual(missing, []);
});

// What the backend says about a file, shown in the Files pane as it comes.
test('the editor’s answers from the backend have their Chinese too', () => {
  const dict = dictionary();
  const source = readFileSync(path.join(ROOT, 'src/jarvis/code_editor.py'), 'utf8');
  const said = new Set();
  for (const m of source.matchAll(/(?:"error": |EditorError\()"((?:[^"\\]|\\.)+)"/g)) said.add(m[1]);
  assert.ok(said.size >= 8, [...said].join(' | '));
  assert.deepEqual([...said].filter((w) => !covered(dict, w)), []);
});

test('the words made with numbers and names in them have patterns', () => {
  const dict = dictionary();
  for (const shown of ['12 matches in 3 files', '1 match in 1 file', '7 matches in 1 file', '2000 matches in 9 files (the first ones only)',
    'That isn\'t a regular expression here: missing ), unterminated subpattern at position 0', 'Ln 12, Col 4', 'Ln 1, Col 1 (23 selected)', '3 of 17', '3 of 10000+', 'Indent: 2 spaces', 'Indent: tabs',
    'Close hub.py', 'Contents of src/jarvis/hub.py', 'Couldn\'t read it: Permission denied',
    'Couldn\'t save it: No space left on device']) {
    assert.ok(covered(dict, shown), shown);
  }
});

test('the feature’s own dictionary is well formed and never repeats the core’s', () => {
  const { mine } = dictionary();
  const core = JSON.parse(readFileSync(path.join(WEB, 'i18n-zh.json'), 'utf8')).strings;
  for (const [en, zh] of Object.entries(mine.strings)) {
    assert.equal(typeof zh, 'string', en);
    assert.ok(zh && zh !== en, en);
    assert.ok(!(en in core), `${en} is in the core dictionary already`);
  }
  for (const [re, rep] of mine.patterns) {
    assert.doesNotThrow(() => new RegExp(re), re);
    assert.ok(re.startsWith('^') && re.endsWith('$') && typeof rep === 'string', re);
  }
});
