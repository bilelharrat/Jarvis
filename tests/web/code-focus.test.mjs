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
  return { document, body, fire, sent, all };
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
  // (Round 2, U9: not Resume, which would spend again on the next Space; a harmless control
  // in the same card.)
  const now = w.document.activeElement;
  assert.notEqual(now.textContent, 'Resume', 'never the spending control in Stop’s place');
  assert.ok(w.body.contains(now) && now !== w.body, 'still in the pane');
  assert.ok(now.closest('.jcx-bf-run'), 'in the run’s own card');
});

// Round 2, U1: two cards each with a Stop; after Stop on the first, the keys stay in the first
// card, never on the second card's Stop (scratchpad ui2/focus-repro.mjs).
function cards(document, box, list) {
  const el = elFor(document);
  box.replaceChildren(...list.map(([name, labels]) => {
    const s = el('section', 'card');
    s.setAttribute('aria-label', `Exterminator Mode: ${name}`);
    s.append(...labels.map((l) => {
      const [word, spends] = Array.isArray(l) ? l : [l, false];
      const b = el('button', 'jc-btn', word);
      b.type = 'button';
      if (spends) b.dataset.spends = '';
      return b;
    }));
    return s;
  }));
}

test('keep: after Stop on one card the focus stays in that card, not on another card’s Stop', () => {
  const document = makeDocument();
  const box = document.createElement('div');
  document.body.append(box);
  cards(document, box, [['alpha', ['Show session', 'Stop', 'Findings']], ['beta', ['Show session', 'Stop', 'Findings']]]);
  box.children[0].children[1].focus();
  focus.keep(box, () => cards(document, box, [['alpha', ['Show session', 'Resume', 'Findings']], ['beta', ['Show session', 'Stop', 'Findings']]]));
  const a = document.activeElement;
  assert.equal(a.parentNode.getAttribute('aria-label'), 'Exterminator Mode: alpha', 'the same card');
  // The second card's Stop, redrawn the same: stays on it (the nth alike inside its own card).
  box.children[1].children[1].focus();
  focus.keep(box, () => cards(document, box, [['alpha', ['Show session', 'Resume', 'Findings']], ['beta', ['Show session', 'Stop', 'Findings']]]));
  assert.ok(document.activeElement === box.children[1].children[1]);
});

test('keep: a spending control (data-spends) never takes a gone one’s place; the card does when nothing else is left', () => {
  const document = makeDocument();
  const box = document.createElement('div');
  document.body.append(box);
  cards(document, box, [['alpha', ['Show session', 'Stop']]]);
  box.children[0].children[1].focus();
  focus.keep(box, () => cards(document, box, [['alpha', ['Show session', ['Resume', true]]]]));
  assert.equal(document.activeElement.textContent, 'Show session', 'a harmless control in the same card');
  cards(document, box, [['alpha', ['Stop']]]);
  box.children[0].children[0].focus();
  focus.keep(box, () => cards(document, box, [['alpha', [['Resume', true]]]]));
  assert.ok(document.activeElement === box.children[0], 'the card itself, not Resume');
  assert.equal(box.children[0].getAttribute('tabindex'), '-1');
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

// Round 2, U2: the sessions list arrives many times a second while a session works; the
// Exterminator pane drew itself anew on each one (the focused Stop replaced 10 times a second,
// a screen reader saying "Stop, button" each time). Unchanged lists leave the pane alone; a
// change it shows (the run's session appearing: Show session) still redraws it.
test('Exterminator Mode: an unchanged sessions list doesn’t redraw the pane', () => {
  const w = standPane('code_bugfix.js', 'bugfix');
  const run = { id: 'r1', project: 'api', state: 'running', round: 1, step: 'sweep', spent: 1, spend_cap: 10, findings: [], folder: '/f', slug: 's', task_id: 9 };
  w.fire('code_bugfix', { runs: [run], active: {} });
  const stop = w.body.querySelectorAll('button').find((b) => b.textContent === 'Stop');
  const wrap = w.body.children[0];
  stop.focus();
  for (let i = 0; i < 10; i++) w.fire('tasks', {});
  assert.ok(w.body.children[0] === wrap, 'the same drawing');
  assert.ok(w.document.activeElement === stop, 'the same Stop, never replaced');
  w.all.ccTasks.push({ id: 9, kind: 'code' });
  w.fire('tasks', {});
  assert.ok(w.body.children[0] !== wrap, 'its session appeared: drawn again');
  assert.ok(w.body.querySelectorAll('button').some((b) => b.textContent === 'Show session'));
  assert.equal(w.document.activeElement.textContent, 'Stop', 'the keys kept on Stop through it');
});

// Efficiency pass 2: the pane asks for the state as it opens (and on hello), so the same runs
// came back and the whole pane was drawn again for nothing; a state it already shows leaves the
// drawing alone, a changed one draws it.
test('Exterminator Mode: the same runs again don’t redraw the pane', () => {
  const w = standPane('code_bugfix.js', 'bugfix');
  const run = { id: 'r1', project: 'api', state: 'running', round: 1, step: 'sweep', spent: 1, spend_cap: 10, findings: [], folder: '/f', slug: 's' };
  w.fire('code_bugfix', { runs: [run], active: {} });
  const wrap = w.body.children[0];
  w.fire('code_bugfix', { runs: [{ ...run }], active: {} });
  assert.ok(w.body.children[0] === wrap, 'the same drawing');
  w.fire('code_bugfix', { runs: [{ ...run, spent: 2 }], active: {} });
  assert.ok(w.body.children[0] !== wrap, 'what it spent changed: drawn again');
});

// Round 2, U5: the panes G5 didn't reach lost the focus after their own buttons (Without you's
// Stop and refused-steps toggle, pairing, the isolated copy, multi-repo, setup, Git, the PR,
// sharing): each draws through keep too.
test('Without you: the refused-steps toggle and Stop leave the keys in the pane', () => {
  const w = standPane('code_unattended.js', 'unattended');
  const run = { id: 'u1', title: 'Night run', project: 'api', state: 'running', spend_cap: 5, hours: 2, started: 1000, denied: ['rm -rf build', 'git push'] };
  w.fire('code_runs', { runs: [run], jobs: [], active: {} });
  const toggle = w.body.querySelectorAll('button').find((b) => b.textContent === '2 steps refused');
  toggle.focus();
  toggle.click();
  assert.equal(w.document.activeElement.textContent, 'Hide what it was refused', 'the toggle, in its new words');
  const stop = w.body.querySelectorAll('button').find((b) => b.textContent === 'Stop');
  stop.focus();
  stop.click();
  w.fire('code_runs', { runs: [{ ...run, state: 'done', why: 'owner', ended: 2000, cost: 1, files: 0 }], jobs: [], active: {} });
  const now = w.document.activeElement;
  assert.ok(w.body.contains(now) && now !== w.body, `still in the pane (${now.tagName})`);
});

test('every pane the round-2 audit found losing the focus draws through keep', () => {
  for (const name of ['code_unattended.js', 'code-pairing.js', 'code_isolation.js', 'code-multirepo.js', 'code-setup.js', 'code_git.js', 'code_pr.js', 'code_share.js']) {
    const text = source(name);
    assert.match(text, /const keepFocus = \(box, drawIt\) => \((root|window)\.jarvisFocus \? \1\.jarvisFocus\.keep\(box, drawIt\) : drawIt\(\)\);/, name);
    assert.ok(!/^\s+(target|body)\.replaceChildren\(wrap\);/m.test(text), `${name}: no bare redraw of the pane`);
  }
});
