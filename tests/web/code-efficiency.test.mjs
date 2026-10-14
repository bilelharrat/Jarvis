// Eden Code's window doing less work for the same result (the bug protocol's efficiency
// pass): panes and the board drawn again only where what they show has changed, in a
// stand-in window (tests/web/fixtures/stand-dom.mjs). node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { elFor, load, makeDocument } from './fixtures/stand-dom.mjs';

const source = (name) => readFileSync(new URL(`../../src/jarvis/web/features/${name}`, import.meta.url), 'utf8');

// ── "Without you" (features/code_unattended.js) ──

function standUnattended() {
  const document = makeDocument();
  const el = elFor(document);
  const handlers = {};
  const panes = {};
  const sent = [];
  const F = {
    el, t: (x) => x, send: (m) => { sent.push(m); return true; },
    on: (type, fn) => { (handlers[type] ||= []).push(fn); },
    registerPane: (id, pane) => { panes[id] = pane; }, registerMoreItem() {},
    currentTask: () => null, selectTask() {}, openPane() {},
  };
  const scope = {
    window: { jarvisFeatures: F }, document, el,
    deckProjects: [{ name: 'api' }], deckProject: 'api', ccTasks: [],
    MutationObserver: class { observe() {} },
  };
  load(source('code_unattended.js'), scope);
  const fire = (type, ev = {}) => { for (const fn of handlers[type] || []) fn(ev); };
  const body = el('div');
  document.body.append(body);
  return { document, scope, fire, panes, body };
}

test('the Without you pane keeps its form, and the focus in it, while the task list streams in', () => {
  const { document, scope, fire, panes, body } = standUnattended();
  fire('code_runs', { runs: [{ id: 'r1', task_id: 7, title: 'Fix the tests', project: 'api', state: 'running', started: 0, hours: 2, spend_cap: 5 }], jobs: [], active: {} });
  panes.unattended.render(body);
  const box = body.querySelector('textarea');
  box.focus();
  for (let n = 0; n < 5; n += 1) fire('tasks', { items: [] });  // (a busy session's steps)
  assert.ok(body.querySelector('textarea') === box, 'the form was built again under the typing');
  assert.ok(document.activeElement === box, 'the focus left the form');
  // What it shows of the list does change: the run's session is listed, so Show session is.
  scope.ccTasks = [{ id: 7, kind: 'code' }];
  fire('tasks', { items: scope.ccTasks });
  assert.ok(body.textContent.includes('Show session'), body.textContent);
});

// ── the agent board (features/code-board.js) ──

function standBoard(tasks) {
  const document = makeDocument();
  const el = elFor(document);
  const cc = el('div', 'jc');
  cc.id = 'cc';
  const side = el('div');
  side.id = 'jc-side';
  side.append(el('div', 'jc-side-foot'));
  const menu = el('div');
  menu.id = 'jc-menu';
  menu.hidden = true;
  cc.append(side, el('div', 'jc-main'));
  document.body.append(cc, menu);
  const handlers = {};
  const frames = [];
  const F = {
    el, t: (x) => x, send: () => true, $: (id) => document.getElementById(id),
    on: (type, fn) => { (handlers[type] ||= []).push(fn); },
    registerMoreItem() {}, registerPane() {}, currentTask: () => null, selectTask() {},
  };
  const scope = {
    window: { jarvisFeatures: F }, document, el, $: F.$, CSS: { escape: (s) => String(s) },
    ccTasks: tasks, pendingApprovals: new Map(), toggleCC() {}, answerApproval() {},
    uiLocale: () => 'en', app: null,
    statusOf: (x) => (x.busy ? 'busy' : x.status === 'failed' ? 'failed' : x.status === 'waiting' ? 'waiting' : 'idle'),
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    mine: (node) => { node.setAttribute('data-no-i18n', ''); return node; },
    setInterval: () => 0, clearInterval() {},
  };
  load(source('code-board.js'), scope);
  const fire = (type, ev = {}) => { for (const fn of handlers[type] || []) fn(ev); };
  const flush = () => { while (frames.length) frames.shift()(); };
  return { document, scope, F, fire, flush, board: F.codeBoard.board };
}

const session = (id, extra = {}) => ({ id, kind: 'code', title: `Session ${id}`, folder: 'api', status: 'waiting', busy: false, files_changed: [], ...extra });

test('the board builds again only the cards whose session changed', () => {
  const tasks = [session(1, { busy: true, status: 'running', last_action: 'Reading a.py' }), session(2), session(3)];
  const w = standBoard(tasks);
  w.F.codeBoard.open();
  w.flush();
  const card = (id) => w.board.querySelector(`.cs-card[data-task="${id}"]`);
  const [one, two, three] = [card(1), card(2), card(3)];
  assert.ok(one && two && three, 'three cards');
  // The busy session takes a step: only its card is new.
  w.scope.ccTasks = [{ ...tasks[0], last_action: 'Editing b.py' }, tasks[1], tasks[2]];
  w.fire('tasks');
  w.flush();
  assert.ok(card(1) !== one, 'the busy session’s card shows its step');
  assert.ok(card(1).textContent.includes('Editing b.py'));
  assert.ok(card(2) === two && card(3) === three, 'the cards that didn’t change were built again');
  // One moves lane (it starts working): its card is drawn for its new lane.
  w.scope.ccTasks = [w.scope.ccTasks[0], { ...tasks[1], busy: true, status: 'running' }, tasks[2]];
  w.fire('tasks');
  w.flush();
  assert.ok(card(2) !== two && card(2).classList.contains('working'));
  assert.ok(card(3) === three);
  // Exactly one card in the Tab order still, on a kept card as on a new one.
  assert.equal(w.board.querySelectorAll('.cs-card[tabindex="0"]').length, 1);
  // A session gone takes its card with it.
  w.scope.ccTasks = [w.scope.ccTasks[0], w.scope.ccTasks[1]];
  w.fire('tasks');
  w.flush();
  assert.equal(card(3), null);
  // One head and one set of lanes, however often it's drawn.
  assert.equal(w.board.children.length, 2);
  assert.equal(w.board.querySelectorAll('.cs-lane').length, 5);
  assert.equal(w.board.querySelector('.cs-lane.done .cs-lane-count').textContent, '0');
  assert.ok(w.board.querySelector('.cs-lane.done .cs-lane-empty'), 'an empty lane says so');
  assert.equal(w.board.querySelector('.cs-lane.working .cs-lane-empty'), null);
});
