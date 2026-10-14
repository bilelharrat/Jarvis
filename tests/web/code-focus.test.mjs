// The keyboard's place through a pane's redraw (web/features/code-focus.js, audit G5): the
// same control in the new drawing, else the one in its place; and the panes that use it
// (Exterminator Mode, Best of N, Stacks, Triggers, PR reviews) in a stand-in window
// (tests/web/fixtures/stand-dom.mjs). node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { elFor, load, makeDocument } from './fixtures/stand-dom.mjs';

const require = createRequire(import.meta.url);
const focus = require('../../src/jarvis/web/features/code-focus.js');
const source = (name) => readFileSync(new URL(`../../src/jarvis/web/features/${name}`, import.meta.url), 'utf8');

function buttons(document, box, labels) {
  const el = elFor(document);
  box.replaceChildren(...labels.map((label) => { const b = el('button', 'jc-btn', label); b.type = 'button'; return b; }));
}

test('keep: the same control again after a redraw, the nth of several alike', () => {
  const document = makeDocument();
  const box = document.createElement('div');
  document.body.append(box);
  buttons(document, box, ['Open', 'Stop', 'Open', 'Stop']);
  box.children[3].focus();
  focus.keep(box, () => buttons(document, box, ['Open', 'Stop', 'Open', 'Stop']));
  assert.ok(document.activeElement === box.children[3], 'the second Stop, in the new drawing');
  // Gone (stopped): the control in its place.
  focus.keep(box, () => buttons(document, box, ['Open', 'Stop', 'Open', 'Resume']));
  assert.equal(document.activeElement.textContent, 'Resume');
  // The focus elsewhere: left alone.
  const other = document.createElement('input');
  document.body.append(other);
  other.focus();
  focus.keep(box, () => buttons(document, box, ['Open']));
  assert.ok(document.activeElement === other);
});

test('keep: a data-focus or an id beats the words; disabled and hidden controls are passed over', () => {
  const document = makeDocument();
  const el = elFor(document);
  const box = el('div');
  document.body.append(box);
  const draw = (word, disabled) => {
    const a = el('button', '', word);
    a.dataset.focus = 'run';
    a.disabled = disabled;
    const b = el('input');
    b.id = 'name';
    box.replaceChildren(a, b);
  };
  draw('Start', false);
  box.children[0].focus();
  focus.keep(box, () => draw('Running…', false));
  assert.equal(document.activeElement.dataset.focus, 'run', 'its words changed, its data-focus didn’t');
  focus.keep(box, () => draw('Running…', true));
  assert.equal(document.activeElement.id, 'name', 'disabled now: the next control in its place');
  assert.equal(focus.signature(null), '');
});

function standPane(name, paneId, scope = {}) {
  const document = makeDocument();
  const body = document.createElement('div');
  body.id = 'jc-pane-body';
  document.body.append(body);
  const panes = new Map();
  const handlers = {};
  const sent = [];
  const F = {
    el: elFor(document), t: (x) => x, send: (m) => { sent.push(m); return true; },
    $: (id) => document.getElementById(id),
    on: (type, fn) => { (handlers[type] ||= []).push(fn); },
    registerPane: (id, pane) => panes.set(id, pane),
    registerMoreItem() {}, registerSessionOption() {}, selectTask() {},
    currentTask: () => ({ id: 7, kind: 'code', folder: 'api', title: 'x' }),
  };
  const window = { jarvisFeatures: F };
  const all = { window, document, CSS: { escape: (s) => String(s) }, currentPane: null, deckProject: 'api', ccTasks: [], ...scope };
  load(source('code-focus.js'), all);
  load(source(name), all);
  all.currentPane = paneId;
  panes.get(paneId).render(body, F.currentTask());
  const fire = (type, ev) => { for (const fn of handlers[type] || []) fn(ev); };
  return { document, body, fire, sent };
}

test('Exterminator Mode: after Stop, the keys are on what took its place, not the page', () => {
  const w = standPane('code_bugfix.js', 'bugfix');
  const run = { id: 'r1', project: 'api', state: 'running', round: 1, step: 'sweep', spent: 1, spend_cap: 10, findings: [], folder: '/f', slug: 's' };
  w.fire('code_bugfix', { runs: [run], active: {} });
  const stop = w.body.querySelectorAll('button').find((b) => b.textContent === 'Stop');
  stop.focus();
  stop.click();
  assert.deepEqual(w.sent.at(-1), { type: 'code_bugfix_stop', run: 'r1' });
  w.fire('code_bugfix', { runs: [{ ...run, state: 'stopped' }], active: {} });
  assert.equal(w.document.activeElement.textContent, 'Resume', 'Resume is where Stop was');
});

test('Best of N: removing a variant leaves the keys in the form', () => {
  const w = standPane('code_bestof.js', 'bestof', { modelList: [{ ref: 'a', label: 'A' }, { ref: 'b', label: 'B' }] });
  const add = w.body.querySelectorAll('button').find((b) => b.textContent === 'Add a third');
  add.focus();
  add.click();
  assert.ok(w.body.contains(w.document.activeElement) && w.document.activeElement !== w.body, 'Add a third: still in the pane');
  const remove = w.body.querySelectorAll('button').find((b) => b.textContent === 'Remove');
  remove.focus();
  remove.click();
  assert.ok(w.body.contains(w.document.activeElement) && w.document.activeElement !== w.body, 'Remove: still in the pane');
});

test('every pane the audit found losing the focus draws through keep', () => {
  for (const name of ['code-stack.js', 'code_bestof.js', 'code-triggers.js', 'code-pr-review.js', 'code_bugfix.js']) {
    const text = source(name);
    assert.match(text, /root\.jarvisFocus \? root\.jarvisFocus\.keep\(box, drawIt\) : drawIt\(\)/, name);
    assert.ok(!/^\s+(target|group)\.replaceChildren\((wrap|\.\.\.parts)\);/m.test(text), `${name}: no bare redraw of the pane`);
  }
});

// Audit G12: the composer's Exterminator Mode button opens the run's pane when on, so it's a
// button that says what it does, not a switch; a finding's scenario is read, not only a title.
test('Exterminator Mode: its button says what it does; a finding’s scenario is in its item', () => {
  const w = standPane('code_bugfix.js', 'bugfix');
  const row = w.document.createElement('div');
  row.id = 'deck-composer';
  const inner = w.document.createElement('div');
  inner.className = 'jc-composer-row';
  row.append(inner);
  w.document.body.append(row);
  const run = { id: 'r1', project: 'api', state: 'running', round: 1, step: 'sweep', spent: 1, spend_cap: 10, folder: '/f', slug: 's',
    findings: [{ id: 'B1-1', severity: 'high', title: 'Crash', status: 'fixed', where: 'a.py:3', lane: 'sweep', scenario: 'Open it twice' }] };
  w.fire('code_bugfix', { runs: [], active: {} });
  const pill = w.document.getElementById('jcx-bf-switch');
  assert.equal(pill.getAttribute('role'), null);
  assert.equal(pill.getAttribute('aria-checked'), null);
  assert.equal(pill.getAttribute('aria-label'), 'Exterminator Mode: turn it on for this project…');
  w.fire('code_bugfix', { runs: [run], active: {} });
  assert.equal(pill.getAttribute('aria-label'), 'Exterminator Mode is on: show its progress');
  const item = w.body.querySelector('.jcx-bf-finding');
  assert.match(item.querySelector('.sr-only').textContent, /Open it twice/);
});
