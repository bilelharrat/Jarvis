// Eden Code's Needs attention inbox (web/features/code-attention.js; the backend's list is
// features/code_attention.py): the count on the sidebar's button and the Dock's badge (which
// it takes over from the agent board), the live line a screen reader hears when the count
// changes, the inbox's items with an approval's answers through the window's own
// answerApproval (its checks still apply), Open, ⌘⇧A, and a seen reply told to the backend.
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';
import { elFor, load, makeDocument } from './fixtures/stand-dom.mjs';

const require = createRequire(import.meta.url);
const pure = require('../../src/jarvis/web/features/code-attention.js');
const source = (name) => readFileSync(new URL(`../../src/jarvis/web/features/${name}`, import.meta.url), 'utf8');

test('an approval’s buttons are its yeses, then Open; never the no that wants a reason', () => {
  const item = { kind: 'approval', choices: [{ id: 'allow', label: 'Allow' }, { id: 'always', label: 'Always' }, { id: 'deny', label: 'Not now' }] };
  assert.deepEqual(pure.actionsOf(item).map((a) => a.label), ['Allow', 'Always', 'Open']);
  assert.deepEqual(pure.actionsOf({ kind: 'failed' }).map((a) => a.label), ['Open']);
});

test('a reply is seen once its session isn’t unread in the sidebar', () => {
  const items = [{ kind: 'reply', task: 3 }, { kind: 'reply', task: 4 }, { kind: 'failed', task: 5 }];
  assert.deepEqual(pure.seenNow(items, new Set([4])), [3]);
});

test('the live line: only a change of the count, never the first one', () => {
  assert.equal(pure.liveLine(null, 3, 'x'), '');
  assert.equal(pure.liveLine(3, 3, 'x'), '');
  assert.equal(pure.liveLine(2, 3, '3 things are waiting for you: a; b; c.'), '3 things are waiting for you: a; b; c.');
  assert.equal(pure.liveLine(1, 0, ''), 'Nothing is waiting for you.');
});

test('⌘⇧A, unless the browser on show has it', () => {
  const e = { metaKey: true, shiftKey: true, altKey: false, ctrlKey: false, key: 'A' };
  assert.ok(pure.isShortcut(e, false));
  assert.ok(!pure.isShortcut(e, true));
  assert.ok(!pure.isShortcut({ ...e, altKey: true }, false));
});

function stand() {
  const document = makeDocument();
  const el = elFor(document);
  const cc = el('div', 'jc');
  cc.id = 'cc';
  const side = el('div');
  side.id = 'jc-side';
  side.append(el('div', 'jc-side-foot'));
  const main = el('div', 'jc-main');
  const menu = el('div');
  menu.id = 'jc-menu';
  menu.hidden = true;
  cc.append(side, main);
  document.body.append(cc, menu);
  const handlers = {};
  const sent = [];
  const badges = [];
  const answered = [];
  const selected = [];
  const panes = [];
  const timers = [];
  const pendingApprovals = new Map();
  const F = {
    el, t: (x) => x, send: (m) => { sent.push(m); return true; },
    $: (id) => document.getElementById(id),
    on: (type, fn) => { (handlers[type] ||= []).push(fn); },
    registerMoreItem() {}, registerPane() {},
    selectTask: (id) => selected.push(id), openPane: (id) => panes.push(id),
    answerApproval: (a, choice) => answered.push([a, choice]),
    codeSessions: { unread: new Set([8]) },
  };
  const scope = {
    window: { jarvisFeatures: F }, document, el, $: F.$, CSS: { escape: (s) => String(s) },
    ccTasks: [], pendingApprovals, toggleCC() {}, answerApproval() {}, uiLocale: () => 'en',
    app: { feature: { send: (channel, n) => badges.push([channel, n]) } },
    statusOf: () => 'idle', mine: (n) => n, confirm: () => true,
    requestAnimationFrame: (fn) => { timers.push(fn); return 1; },
    setInterval: () => 0, clearInterval() {},
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {},
  };
  load(source('code-attention.js'), scope);
  load(source('code-board.js'), scope);
  const fire = (type, ev) => { for (const fn of handlers[type] || []) fn(ev); };
  const flush = () => { for (let n = 0; timers.length && n < 50; n += 1) timers.shift()(); };
  return { document, F, fire, flush, sent, badges, answered, selected, panes, pendingApprovals };
}

const ITEMS = [
  { key: 'approval:a1', kind: 'approval', task: 3, approval: 'a1', project: 'app', text: 'Run npm install?',
    said: 'Session 3 asks: Run npm install?', choices: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Not now' }] },
  { key: 'exterminator:b1', kind: 'exterminator', task: 0, pane: 'bugfix', project: 'app', said: 'Exterminator Mode in app stopped: it failed' },
  { key: 'reply:7', kind: 'reply', task: 7, project: 'app', said: 'Session 7 finished and waits for your reply' },
  { key: 'reply:8', kind: 'reply', task: 8, project: 'app', said: 'Session 8 finished and waits for your reply' },
];

test('the count: on the button, in the Dock (the board leaves the Dock to it), and said when it changes', () => {
  const w = stand();
  w.fire('tasks', {});  // (the board would badge here: it doesn't)
  w.fire('code_attention', { items: ITEMS, count: 4, summary: '4 things are waiting for you: …' });
  const btn = w.document.querySelector('.ca-btn');
  assert.equal(btn.querySelector('.ca-count').textContent, '4');
  assert.equal(btn.getAttribute('aria-label'), 'Needs attention: 4 waiting');
  assert.deepEqual(w.badges.at(-1), ['feature:code-sessions:badge', 4]);
  assert.ok(w.badges.every(([channel]) => channel === 'feature:code-sessions:badge'));
  assert.equal(w.badges.filter(([, n]) => n === 4).length, 1);
  w.flush();
  assert.equal(w.document.getElementById('ca-live').textContent, '');  // (the first count is not news)
  w.fire('code_attention', { items: ITEMS.slice(0, 2), count: 2, summary: '2 things are waiting for you: …' });
  w.flush();
  assert.equal(w.document.getElementById('ca-live').textContent, '2 things are waiting for you: …');
  assert.equal(w.document.getElementById('ca-live').getAttribute('aria-live'), 'polite');
});

test('a reply the sidebar doesn’t show as unread is told to the backend as seen', () => {
  const w = stand();
  w.fire('code_attention', { items: ITEMS, count: 4, summary: '' });
  assert.deepEqual(w.sent.filter((m) => m.type === 'code_attention_seen'), [{ type: 'code_attention_seen', ids: [7] }]);
});

test('the inbox: ⌘⇧A opens it; an approval is answered through answerApproval; Open goes to the pane', () => {
  const w = stand();
  const card = { id: 'a1', task_id: 3, choices: [{ id: 'allow', label: 'Allow' }] };
  w.pendingApprovals.set('a1', card);
  w.fire('code_attention', { items: ITEMS, count: 4, summary: '4 things' });
  const panel = w.document.querySelector('.ca-inbox');
  assert.equal(panel.hidden, true);
  w.document.key('a', { metaKey: true, shiftKey: true });
  assert.equal(panel.hidden, false);
  assert.equal(panel.getAttribute('role'), 'dialog');
  const rows = panel.querySelectorAll('.ca-item');
  assert.equal(rows.length, 4);
  const allow = rows[0].querySelector('button');
  assert.equal(allow.textContent, 'Allow');
  assert.equal(w.document.activeElement, allow);  // (the keyboard starts on the first answer)
  allow.click();
  assert.deepEqual(w.answered, [[card, 'allow']]);
  const open = rows[1].querySelectorAll('button')[0];
  assert.equal(open.textContent, 'Open');
  open.click();
  assert.deepEqual(w.panes, ['bugfix']);
  assert.equal(panel.hidden, true);
  w.document.key('a', { metaKey: true, shiftKey: true });
  panel.querySelectorAll('.ca-item')[2].querySelector('button').click();
  assert.deepEqual(w.selected, [7]);
});

test('Esc closes it and the keyboard goes back to its button', () => {
  const w = stand();
  w.fire('code_attention', { items: [], count: 0, summary: 'Nothing is waiting for you.' });
  w.document.key('a', { metaKey: true, shiftKey: true });
  const panel = w.document.querySelector('.ca-inbox');
  assert.equal(panel.hidden, false);
  assert.equal(panel.querySelector('.ca-empty').hidden, false);
  w.document.key('Escape');
  assert.equal(panel.hidden, true);
  assert.equal(w.document.activeElement, w.document.querySelector('.ca-btn'));
});
