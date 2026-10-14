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
