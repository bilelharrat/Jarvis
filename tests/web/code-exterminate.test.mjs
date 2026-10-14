// Bug fixes go to Exterminator Mode first, the window's side (web/features/code-exterminate.js):
// the composer's own messages carry the mark the backend offers by (features/code_exterminate.py),
// the "Exterminate bugs" starter opens Exterminator Mode's start card for the project in front,
// words handed back land only in the composer they came from, and the strings are in Chinese.
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const cx = require('../../src/jarvis/web/features/code-exterminate.js');
const web = new URL('../../src/jarvis/web/', import.meta.url);
const zh = JSON.parse(readFileSync(new URL('i18n/code-exterminate.json', web), 'utf8')).strings;

test('only a composer message with words carries the offer mark', () => {
  assert.deepEqual(cx.sessionFields('fix the bugs'), { bugfix_offer: true });
  assert.deepEqual(cx.sessionFields('  '), {});
  assert.deepEqual(cx.sendFields({ id: 3 }, 'debug this'), { bugfix_offer: true });
  assert.deepEqual(cx.sendFields(null, 'debug this'), {});
  assert.deepEqual(cx.sendFields({ id: 3 }, ''), {});
});

test('the Exterminate bugs starter opens the start card for the project, and only with one', () => {
  assert.deepEqual(cx.startMessage('calc'), { type: 'code_bugfix_start', project: 'calc' });
  assert.equal(cx.startMessage(''), null);
  const html = readFileSync(new URL('index.html', web), 'utf8');
  const starter = html.match(/<button[^>]*id="jc-starter-exterminate"[^>]*>([^<]*)<\/button>/);
  assert.ok(starter, 'the starter is in the page');
  assert.equal(starter[1], 'Exterminate bugs');
  assert.ok(!/data-say/.test(starter[0]), 'it sends no words of its own');
  assert.ok(!html.includes('>Run the tests and fix failures<'));
  for (const kept of ['Explain this project', 'Review my changes', 'Plan a feature first']) assert.ok(html.includes(`>${kept}<`), kept);
  const app = readFileSync(new URL('app.js', web), 'utf8');
  assert.ok(app.includes("querySelectorAll('.jc-starter[data-say]')"), 'the words starters stay as they were');
});

test('words handed back go only to the composer they came from', () => {
  const ev = { id: 4, directory: 'calc', text: 'fix the bugs' };
  assert.ok(cx.draftFits(ev, { id: 4 }, 'calc'));
  assert.ok(!cx.draftFits(ev, { id: 5 }, 'calc'));
  const fresh = { id: null, directory: 'calc', text: 'fix the bugs' };
  assert.ok(cx.draftFits(fresh, null, 'calc'));
  assert.ok(!cx.draftFits(fresh, null, 'other'));
  assert.ok(!cx.draftFits(fresh, { id: 4 }, 'calc'));
  assert.ok(!cx.draftFits({ ...fresh, text: '' }, null, 'calc'));
});

test('the starter, the setting and its note are in Chinese', () => {
  for (const s of ['Exterminate bugs', cx.LABEL, cx.NOTE]) assert.ok(zh[s] && /[一-鿿]/.test(zh[s]), s);
  const title = readFileSync(new URL('index.html', web), 'utf8').match(/id="jc-starter-exterminate" title="([^"]+)"/)[1];
  assert.ok(zh[title], title);
});
