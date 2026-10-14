// The agent board with its to-do lane in a stand-in window (web/features/code-board.js,
// code-todo.js; tests/web/fixtures/stand-dom.mjs): the keys and the focus. 1 to 4 press a
// session card's own buttons, never a to-do card's (Start is a paid session, Delete a
// delete: audit G8); a redraw while the keys are in the to-do lane keeps them where they
// were (it's redrawn about every second while sessions work: audit G2). node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { elFor, load, makeDocument } from './fixtures/stand-dom.mjs';

const source = (name) => readFileSync(new URL(`../../src/jarvis/web/features/${name}`, import.meta.url), 'utf8');

function standBoard({ tasks = [], cards = [] } = {}) {
  const document = makeDocument();
  const el = elFor(document);
  const cc = el('div', 'jc');
  cc.id = 'cc';
  const main = el('div', 'jc-main');
  const side = el('div');
  side.id = 'jc-side';
  side.append(el('div', 'jc-side-foot'));
  const menu = el('div');
  menu.id = 'jc-menu';
  menu.hidden = true;
  cc.append(side, main);
  document.body.append(cc, menu);
  const handlers = {};
  const sent = [];
  const selected = [];
  const frames = [];
  const F = {
    el, t: (x) => x, send: (m) => { sent.push(m); return true; },
    $: (id) => document.getElementById(id),
    on: (type, fn) => { (handlers[type] ||= []).push(fn); },
    registerMoreItem() {}, registerPane() {},
    currentTask: () => null,
    selectTask: (id) => selected.push(id),
  };
  const window = { jarvisFeatures: F };
  const scope = {
    window, document, el, $: F.$, CSS: { escape: (s) => String(s) },
    ccTasks: tasks, pendingApprovals: new Map(), toggleCC() {}, answerApproval() {},
    uiLocale: () => 'en', app: null, modelList: [],
    statusOf: (x) => (x.busy ? 'busy' : x.status === 'failed' ? 'failed' : x.status === 'waiting' ? 'waiting' : 'idle'),  // (app.js)
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    mine: (node) => { node.setAttribute('data-no-i18n', ''); return node; },  // (app.js)
    confirm: () => true,
    setInterval: () => 0, clearInterval() {},  // (the board's every-15-seconds ask)
    setTimeout: (fn) => { frames.push(fn); return frames.length; }, clearTimeout() {},
  };
  load(source('code-board.js'), scope);
  load(source('code-todo.js'), scope);
  const fire = (type, ev) => { for (const fn of handlers[type] || []) fn(ev); };
  const flush = () => { for (let n = 0; frames.length && n < 50; n += 1) frames.shift()(); };
  fire('claude_projects', { items: [{ name: 'api', path: '/p/api' }] });
  fire('todo_state', { cards, queues: {}, queue: false });
  return { document, F, fire, flush, sent, selected, board: F.codeBoard.board };
}

const CARD = { id: 'c1', folder: '/p/api', title: 'Add a retry', prompt: 'Add a retry', state: 'todo', mode: '', model: '' };
const SESSION = { id: 3, kind: 'code', title: 'Fix login', folder: 'api', status: 'waiting', busy: false, files_changed: [] };

test('1 to 4 on a to-do card press nothing: Start is a paid session and Delete deletes', () => {
  const w = standBoard({ tasks: [SESSION], cards: [{ ...CARD }] });
  w.F.codeBoard.open();
  w.flush();
  const todo = w.board.querySelector('.ct-card');
  assert.ok(todo, 'the to-do card is on the board');
  const start = todo.querySelector('.cs-card-acts button');
  assert.equal(start.textContent, 'Start');
  start.focus();
  for (const key of ['1', '2', '3', '4']) w.document.key(key);
  todo.focus();
  for (const key of ['1', '4', 'Enter', ' ']) w.document.key(key);
  assert.deepEqual(w.sent.filter((m) => m.type.startsWith('todo_')), [], 'no card started, moved or deleted');
  assert.deepEqual(w.selected, [], 'and no session opened');
  // A session's card still answers to them: 1 is its first button (Open).
  const card = w.board.querySelector('.cs-card[data-task="3"]');
  card.focus();
  w.document.key('1');
  assert.deepEqual(w.selected, [3]);
  w.document.key('Enter');
  assert.deepEqual(w.selected, [3, 3]);
});

test('a redraw while the keys are in the to-do lane keeps them where they were', () => {
  const w = standBoard({ tasks: [SESSION], cards: [{ ...CARD }] });
  w.F.codeBoard.open();
  w.flush();
  const add = w.board.querySelector('[data-focus="todo:new"]');
  add.focus();
  assert.ok(w.document.activeElement === add);  // (ok, not equal: an element's too big to print)
  // A session moves on: the board draws itself again.
  SESSION.busy = true;
  w.fire('tasks', {});
  w.flush();
  assert.ok(w.board.querySelector('.cs-card.working'), 'the board was drawn again');
  assert.equal(w.document.activeElement.dataset.focus, 'todo:new', 'the focus stayed on New card');
  // And a card's own button, after the lane itself is drawn again.
  const edit = w.board.querySelector('[data-focus="todo:c1:edit"]');
  edit.focus();
  w.fire('todo_state', { cards: [{ ...CARD }], queues: {}, queue: false });
  SESSION.busy = false;
  w.fire('tasks', {});
  w.flush();
  assert.equal(w.document.activeElement.dataset.focus, 'todo:c1:edit');
});

// Audit G12: a list holds only its items (an empty lane's "None" was a <p> inside it), and
// the to-do lane's cards are a list too (its name was on a plain div).
test('every list on the board holds only list items, the to-do lane’s too', () => {
  const w = standBoard({ tasks: [{ ...SESSION, busy: false }], cards: [{ ...CARD }] });
  w.F.codeBoard.open();
  w.flush();
  const lists = w.board.querySelectorAll('[role="list"]');
  assert.ok(lists.some((l) => l.classList.contains('ct-cards')), 'the to-do cards are a list');
  for (const list of lists) {
    for (const child of list.children) assert.equal(child.getAttribute('role'), 'listitem', `${list.className}: ${child.className}`);
  }
  assert.ok(w.board.querySelectorAll('.cs-lane-empty').length >= 3, 'the empty lanes still say so');
  // An empty to-do lane says so beside its list.
  w.fire('todo_state', { cards: [], queues: {}, queue: false });
  const todo = w.board.querySelector('.ct-cards');
  assert.equal(todo.children.length, 0);
  assert.ok(todo.parentNode.querySelector('.cs-lane-empty'));
});
