// Eden Code's words in Chinese where the audit found them left in English (G11): Model
// Router's broken-model title, a board card's spoken tail ("branch main. 2 files, 10 lines
// added, 3 removed"), Best of N's merged hunks and a multi-repo repository's line (their
// fixed words were marked as the owner's, data-no-i18n). Translated as the window does
// (web/i18n.js: strings, then patterns in the order server.zh_strings merges them: the base
// file first, then each feature's in name order). node --test tests/web/
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const web = new URL('../../src/jarvis/web/', import.meta.url);
const files = [new URL('i18n-zh.json', web), ...readdirSync(new URL('i18n/', web)).filter((f) => f.endsWith('.json')).sort().map((f) => new URL(`i18n/${f}`, web))];
const strings = {};
const patterns = [];
for (const file of files) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  Object.assign(strings, data.strings || {});
  for (const [p, r] of data.patterns || []) patterns.push([new RegExp(p), r]);
}
// web/i18n.js lookup: the words trimmed, a string first, else the first pattern that fits.
function zh(text) {
  const key = String(text).replace(/\s+/g, ' ').trim();
  if (!key) return String(text);
  let out = strings[key];
  if (out === undefined) {
    const found = patterns.find(([re]) => re.test(key));
    out = found ? key.replace(found[0], found[1]) : null;
  }
  if (out === null) return String(text);
  return String(text).slice(0, String(text).length - String(text).trimStart().length) + out + String(text).slice(String(text).trimEnd().length);
}
const english = (text, words) => words.filter((w) => text.includes(w));

test('Model Router’s broken-model title is Chinese, the model’s name kept', () => {
  const R = require('../../src/jarvis/web/features/code-router.js');
  const look = R.composerLook(true, 'it knows none of your models yet', 'Opus 5.5');
  const said = zh(look.title);
  assert.deepEqual(english(said, ['isn’t working', 'messages go to', 'Choose', 'retry']), [], said);
  assert.match(said, /Opus 5\.5/);
  assert.match(look.title, /^Model Router isn’t working \(it knows none of your models yet\), so messages go to Opus 5\.5\./);
});

test('a board card’s whole line is Chinese but for the session’s own words', () => {
  const { cardSpeech } = require('../../src/jarvis/web/features/code-board.js');
  const task = { id: 3, title: 'Add a retry', folder: 'jarvis', busy: true, last_action: 'Working', files_changed: ['a', 'b'] };
  const said = zh(cardSpeech(task, 'working', null, { branch: 'main', added: 10, removed: 3 }, zh));
  assert.deepEqual(english(said, ['Session', 'working', 'Working', 'branch', 'files', 'lines added', 'removed']), [], said);
  for (const own of ['Add a retry', 'jarvis', 'main']) assert.ok(said.includes(own), own);
  // In English, as before.
  assert.equal(cardSpeech(task, 'working', null, { branch: 'main', added: 10, removed: 3 }),
    'Session 3, Add a retry, working: Working. jarvis, branch main. 2 files, 10 lines added, 3 removed.');
});

test('Best of N’s merged hunk and a multi-repo line: Eden’s words translated, the owner’s kept', () => {
  const { hunkParts, hunkLine } = require('../../src/jarvis/web/features/code_bestof.js');
  const h = { file: 'app.py', line: 12, where: 'login', label: 'Opus', added: 3, removed: 1, why: 'Handles the timeout.' };
  assert.equal(hunkLine(h), 'app.py line 12 in login: from Opus (+3 −1). Handles the timeout.');
  for (const part of hunkParts(h).filter((p) => !p.own)) assert.notEqual(zh(part.text), part.text, part.text);
  assert.deepEqual(hunkParts(h).filter((p) => p.own).map((p) => p.text), ['app.py', 'login', 'Opus', ' (+3 −1)', '. ', 'Handles the timeout.']);
  const { repoParts } = require('../../src/jarvis/web/features/code-multirepo.js');
  for (const r of [{ branch: 'b', into: 'main', state: {} }, { branch: 'b', into: 'main', state: { files: 2, added: 5, removed: 1 }, conflicts: ['a.py'] }]) {
    const parts = repoParts(r);
    assert.deepEqual(parts.filter((p) => p.own).map((p) => p.text), ['b → main']);
    for (const part of parts.filter((p) => !p.own)) assert.notEqual(zh(part.text), part.text, part.text);
  }
});

test('the board’s keys, listed in ? : the same order as the others, Home, End and Space too', () => {
  const app = readFileSync(new URL('app.js', web), 'utf8');
  const keys = app.match(/const JC_KEYS = \[([\s\S]*?)\n\];/)[1];
  assert.ok(!keys.includes('⇧⌘'), 'written ⌘⇧, as ⌘⇧I and ⌘⇧F are');
  assert.match(keys, /\['⌘⇧B', 'Agent board: arrows, Home, End, Enter or Space, 1–4'\]/);
  assert.notEqual(zh('Agent board: arrows, Home, End, Enter or Space, 1–4'), 'Agent board: arrows, Home, End, Enter or Space, 1–4');
});
