// Share live: the owner's pane helpers (web/features/code_share.js) and the viewer page's
// (web/share.js).
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const pane = require('../../src/jarvis/web/features/code_share.js');
const viewer = require('../../src/jarvis/web/share.js');

test('the owner sees how many watch and when the link ends', () => {
  assert.equal(pane.watchingText(0), 'Nobody watching');
  assert.equal(pane.watchingText(1), '1 watching');
  assert.equal(pane.watchingText(3), '3 watching');
  assert.equal(pane.endsText(1000, 1000), 'Ended');
  assert.equal(pane.endsText(1000 + 20, 1000), 'Ends in 1 min');
  assert.equal(pane.endsText(1000 + 45 * 60, 1000), 'Ends in 45 min');
  assert.equal(pane.endsText(1000 + 4 * 3600, 1000), 'Ends in 4 h');
  assert.deepEqual(pane.MINUTES.map(([m]) => m), [15, 60, 240, 1440]);  // = code_share.MINUTES
});

test('a suggestion taken up goes into the composer as the owner’s own words to edit', () => {
  assert.equal(pane.composerText({ name: 'Alex', text: 'try the cache' }), 'Suggestion from Alex: try the cache');
  assert.equal(pane.composerText({ name: '', text: 'x' }), 'Suggestion from a viewer: x');
});

test('the viewer page asks for its share’s state with its own random id', () => {
  const random = { getRandomValues: (b) => { b.fill(171); return b; } };
  const id = viewer.viewerId(random);
  assert.match(id, /^[A-Za-z0-9_-]{8,40}$/);  // what the Mac accepts (code_share._VIEWER)
  assert.equal(id, 'ab'.repeat(12));
  assert.equal(viewer.stateUrl('/share/tok/', id, 7, 'k1'), `/share/tok/state?v=${id}&since=7&ck=k1`);
  assert.equal(viewer.stateUrl('/share/tok', id, 0, ''), `/share/tok/state?v=${id}&since=0&ck=`);
  assert.equal(viewer.leftText(10, 10), 'ended');
  assert.equal(viewer.leftText(10 + 7200, 10), 'ends in 2 h');
});

test('a step sent again (its outcome came in) takes its own place, and the list is capped', () => {
  // A list of the tests' own: what placeEntries uses of an <ol>.
  const list = {
    kids: [],
    appendChild(n) { n.parentNode = this; this.kids.push(n); },
    replaceChild(n, old) { const i = this.kids.indexOf(old); n.parentNode = this; old.parentNode = null; this.kids[i] = n; },
    removeChild(n) { this.kids.splice(this.kids.indexOf(n), 1); n.parentNode = null; },
  };
  const make = (e) => (e.role === 'turn' ? null : { text: `${e.n}:${e.status || ''}` });
  const shown = new Map();
  viewer.placeEntries(list, shown, [{ n: 1, role: 'user' }, { n: 2, role: 'tool', status: '' }, { n: 3, role: 'turn' }], make);
  assert.deepEqual(list.kids.map((k) => k.text), ['1:', '2:']);
  viewer.placeEntries(list, shown, [{ n: 2, role: 'tool', status: 'done' }, { n: 4, role: 'assistant' }], make);
  assert.deepEqual(list.kids.map((k) => k.text), ['1:', '2:done', '4:']);  // in place, not added again
  viewer.placeEntries(list, shown, [{ n: 5, role: 'user' }, { n: 6, role: 'user' }], make, 3);
  assert.deepEqual(list.kids.map((k) => k.text), ['4:', '5:', '6:']);  // the oldest went
  assert.equal(shown.size, 3);
  assert.equal(viewer.KEPT, 1000);
  assert.equal(viewer.stateUrl('/share/tok', 'v'.repeat(8), 9, 'k', 77), '/share/tok/state?v=vvvvvvvv&since=9&ck=k&u=77');
});

test('the viewer page never reads the session as HTML', () => {
  const source = readFileSync(new URL('../../src/jarvis/web/share.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  const page = readFileSync(new URL('../../src/jarvis/web/share.html', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /<script>(?!<)/);  // no inline script: the page's CSP allows only its own file
});

test('every string the Share pane shows has its Chinese', () => {
  const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n/code_share.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('../../src/jarvis/web/features/code_share.js', import.meta.url), 'utf8');
  const shown = [...source.matchAll(/(?<!mine\()el\('[a-z0-9]+', '[^']*', '([^'$]+)'\)/g)].map((m) => m[1]);
  const buttons = [...source.matchAll(/button\('([^']+)'/g)].map((m) => m[1]);
  const extra = ['Share live…', 'A read-only live view for a teammate', 'Live share', 'Share link', 'Copied', 'How long the link works',
    ...pane.MINUTES.map(([, label]) => label), 'Share another link', 'Nobody watching', 'Ended'];
  assert.deepEqual([...shown, ...buttons, ...extra].filter((s) => !(s in zh.strings)), []);
  const match = (text) => zh.patterns.some(([re]) => new RegExp(re).test(text));
  assert.ok(['3 watching', '1 watching', 'Ends in 5 min', 'Ends in 2 h', 'Suggestion from Alex'].every(match));
});
