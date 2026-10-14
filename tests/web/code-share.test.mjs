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

// Round 3, S1b: the owner sees who is watching, each with Stop.
test('each viewer is said by its address (and the name on its suggestions), and since when', () => {
  const now = 10_000;
  assert.equal(pane.watcherText({ address: '10.0.0.7', since: now - 5 }, now), 'A viewer at 10.0.0.7, just now');
  assert.equal(pane.watcherText({ address: '10.0.0.7', since: now - 600, name: 'Alex' }, now), 'Alex at 10.0.0.7, for 10 min');
  const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n/code_share.json', import.meta.url), 'utf8'));
  const said = (text) => zh.patterns.some(([re]) => new RegExp(re).test(text));
  assert.ok(said('A viewer at 10.0.0.7, just now') && said('Alex at 10.0.0.7, for 10 min'));
  for (const s of ['Stop', 'Watching now', 'They can’t watch this link again from that device; everyone else goes on']) assert.ok(zh.strings[s], s);
  const source = readFileSync(new URL('../../src/jarvis/web/features/code_share.js', import.meta.url), 'utf8');
  assert.match(source, /send\(\{ type: 'code_share_kick', share: share\.share, viewer: w\.viewer \}\)/);
  assert.match(readFileSync(new URL('../../src/jarvis/web/share.js', import.meta.url), 'utf8'), /reply\.status === 403\) \{ ended\(\); return; \}/);
});

// Round 3, U3-4: in a stand-in window (tests/web/fixtures/stand-dom.mjs), the keyboard on a
// viewer's Stop. Stop on one viewer used to send the focus to the next viewer's Stop (a second
// Space blocked their address too); the minutes in Stop's name changed it every minute; and
// every task-list event drew the pane anew.
test('Share live: Stop on one viewer never hands the focus to another’s Stop, and a redraw keeps it', async () => {
  const { elFor, load, makeDocument } = await import('./fixtures/stand-dom.mjs');
  const src = (n) => readFileSync(new URL(`../../src/jarvis/web/features/${n}`, import.meta.url), 'utf8');
  const document = makeDocument();
  const body = document.createElement('div');
  document.body.append(body);
  const handlers = {};
  const sent = [];
  let pane = null;
  const F = {
    el: elFor(document), t: (x) => x, send: (m) => { sent.push(m); return true; },
    on: (type, fn) => { (handlers[type] ||= []).push(fn); },
    registerPane: (_id, p) => { pane = p; }, registerMoreItem() {}, openPane() {},
    currentTask: () => ({ id: 7, kind: 'code' }),
  };
  const window = { jarvisFeatures: F };
  for (const n of ['code-focus.js', 'code_share.js']) load(src(n), { window, document });
  const fire = (type, ev) => { for (const fn of handlers[type] || []) fn(ev); };
  pane.render(body);
  const now = Date.now() / 1000;
  const viewer = (v, address, mins) => ({ viewer: v, address, since: now - mins * 60, name: '' });
  const share = (watchers) => ({ id: 7, share: 's1', url: 'https://x/share/s1', expires: now + 3600, viewers: watchers.length, watchers });
  fire('code_share', { shares: [share([viewer('va', '10.0.0.2', 1), viewer('vb', '10.0.0.3', 1)])] });
  const stops = () => [...body.querySelectorAll('.jcx-share-watchers button')];
  assert.deepEqual(stops().map((b) => b.getAttribute('aria-label')), ['Stop: 10.0.0.2', 'Stop: 10.0.0.3'], 'no minutes in the name');
  // A minute on: the focus stays on the same viewer's Stop.
  stops()[1].focus();
  fire('code_share', { shares: [share([viewer('va', '10.0.0.2', 2), viewer('vb', '10.0.0.3', 2)])] });
  assert.equal(document.activeElement.getAttribute('aria-label'), 'Stop: 10.0.0.3');
  // Stop on the first viewer: the focus goes to something harmless, not the other's Stop.
  stops()[0].focus();
  stops()[0].click();
  assert.deepEqual(sent.at(-1), { type: 'code_share_kick', share: 's1', viewer: 'va' });
  fire('code_share', { shares: [share([viewer('vb', '10.0.0.3', 2)])] });
  const at = document.activeElement;
  assert.ok(at && body.contains(at), 'the focus stayed in the pane');
  assert.ok(!('spends' in at.dataset), `the focus went to ${at.getAttribute('aria-label') || at.textContent}`);
  // The task list coming again (the same session open) doesn't draw the pane anew.
  const card = body.querySelector('.jcx-share');
  fire('tasks', { items: [] });
  assert.ok(card.isConnected, 'drawn anew for a task-list event');
});
