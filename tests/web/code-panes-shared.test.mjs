// The workbench pane's body (#jc-pane-body) is every pane's: Pairing, Setup, Multi-repo and
// the Copies pane each draw into it only while they're the pane open, so an event for one
// (a sync, a line of setup output, the task list) never draws over another (audit G1). In
// a stand-in window (tests/web/fixtures/stand-dom.mjs). node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { elFor, load, makeDocument } from './fixtures/stand-dom.mjs';

const source = (name) => readFileSync(new URL(`../../src/jarvis/web/features/${name}`, import.meta.url), 'utf8');

function stand(names) {
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
    registerMoreItem() {}, registerSessionOption() {},
    currentTask: () => ({ id: 7, kind: 'code', title: 'x' }),
  };
  const window = { jarvisFeatures: F };
  const scope = {
    window, document, CSS: { escape: (s) => String(s) },
    currentPane: null, deckProject: 'api', deckProjects: [{ name: 'api' }, { name: 'web' }],
  };
  F.openPane = (id) => { scope.currentPane = id; panes.get(id).render(body); };
  for (const name of names) load(source(name), scope);
  const fire = (type, ev) => { for (const fn of handlers[type] || []) fn(ev); };
  return { document, body, fire, open: F.openPane, sent };
}

test('an event for a pane that isn’t open never draws over the one that is', () => {
  const w = stand(['code_isolation.js', 'code-multirepo.js', 'code-pairing.js', 'code-setup.js']);
  w.open('multirepo');
  assert.ok(w.body.querySelector('.jcx-multis'), 'the Multi-repo pane shows');
  w.fire('code_pair', { id: 7, copy: true, on: true, folder: '/x' });
  w.fire('cw_editors', { items: [] });
  w.fire('code_setup', { project: 'api', setup: null });
  w.fire('code_setup_output', { id: 7, lines: ['npm install'] });
  w.fire('code_copies', { copies: [], trash: [], root: '/copies' });
  assert.ok(w.body.querySelector('.jcx-multis'), 'still the Multi-repo pane');
  assert.equal(w.body.querySelector('.jcx-pair'), null);
  assert.equal(w.body.querySelector('.jcx-setup'), null);
  assert.equal(w.body.querySelector('.jcx-copies'), null, 'the Copies pane didn’t take it for its own');

  w.open('pairing');
  w.fire('code_multis', { groups: [], most: 8 });
  w.fire('code_setup', { project: 'api', setup: null });
  assert.ok(w.body.querySelector('.jcx-pair'), 'still the Pairing pane');
  w.open('setup');
  w.fire('code_pair', { id: 7, copy: true, on: false });
  w.fire('code_multis', { groups: [], most: 8 });
  assert.ok(w.body.querySelector('.jcx-setup'), 'still the Setup pane');
  w.open('copies');
  w.fire('code_multis', { groups: [], most: 8 });
  w.fire('code_pair', { id: 7, copy: true, on: false });
  assert.ok(w.body.querySelector('.jcx-copies'), 'still the Copies pane');
  // Its own events still draw it.
  w.fire('code_copies', { copies: [], trash: [], root: '/copies-2' });
  assert.match(w.body.textContent, /\/copies-2/);
});

// Audit G4: setup's output as it comes goes on the end of the output shown; the pane isn't
// drawn anew for each line (that wiped what was being typed and made the live region anew).
test('Setup: each line of output is added to the output shown, and typing in the pane survives', () => {
  const w = stand(['code-setup.js']);
  w.open('setup');
  w.fire('code_setup', { id: 7, project: 'api', copy: true, setup: { source: '.jarvis/setup.sh', text: 'npm ci' }, container: {} });
  assert.match(w.body.querySelector('.jcx-setup-out').textContent, /No setup has run/);
  w.body.querySelector('.jcx-setup-out').nextSibling.click();  // Run setup again
  const out = w.body.querySelector('.jcx-setup-out');
  const input = w.body.querySelector('#jcx-setup-image');
  input.focus();
  input.value = 'node:2';
  w.fire('code_setup_output', { id: 7, lines: ['npm ci', 'added 12 packages'] });
  w.fire('code_setup_output', { id: 7, lines: ['done in 3s'] });
  assert.ok(out.isConnected, 'the same output, not a new one');
  assert.equal(out.textContent, 'npm ci\nadded 12 packages\ndone in 3s');
  assert.ok(input.isConnected && input.value === 'node:2', 'what was typed is still there');
  assert.equal(w.document.activeElement.id, 'jcx-setup-image', 'and the keys are still in it');
  assert.equal(w.body.querySelector('.jcx-setup-out').nextSibling.textContent, 'Running…');
  // Done: the pane asks again, and the answer draws it; what's typed still survives.
  w.fire('code_setup_output', { id: 7, lines: [], done: true });
  assert.deepEqual(w.sent.at(-1), { type: 'code_setup_state', id: 7 });
  w.fire('code_setup', { id: 7, project: 'api', copy: true, setup: { source: '.jarvis/setup.sh', text: 'npm ci' }, container: {} });
  const again = w.body.querySelector('#jcx-setup-image');
  assert.equal(again.value, 'node:2');
  assert.equal(w.document.activeElement.id, 'jcx-setup-image');
  assert.match(w.body.querySelector('.jcx-setup-out').textContent, /done in 3s/);
});

// Audit G6: the picks and the request stay until the backend says the task started; the
// form waits (no second start) meanwhile, and a refusal is said under it.
test('Multi-repo: the form keeps what was picked until the task starts, and waits meanwhile', () => {
  const w = stand(['code-multirepo.js']);
  w.open('multirepo');
  const boxes = () => w.body.querySelectorAll('.jcx-multi-pick input');
  boxes().forEach((b) => { b.checked = true; b.listeners.change[0](); });
  const prompt = w.body.querySelector('#jcx-multi-prompt');
  prompt.value = 'add the field';
  prompt.listeners.input[0]();
  const submit = () => w.body.querySelector('.jcx-multi-start').dispatchEvent(w.document.event('submit'));
  submit();
  assert.deepEqual(w.sent.at(-1), { type: 'code_multi_start', projects: ['api', 'web'], prompt: 'add the field' });
  const go = w.body.querySelector('.jcx-multi-start button');
  assert.equal(go.disabled, true, 'no second start while the first is out');
  submit();
  assert.equal(w.sent.filter((m) => m.type === 'code_multi_start').length, 1);
  // The task list arrives meanwhile: still waiting, nothing lost.
  w.fire('code_multis', { groups: [], most: 8 });
  assert.equal(w.body.querySelector('.jcx-multi-start button').disabled, true);
  assert.equal(w.body.querySelector('#jcx-multi-prompt').value, 'add the field');
  // Refused: said, and everything is still there to try again.
  w.fire('code_multi_started', { ok: false, text: 'There are already 20 isolated copies; land or discard some.' });
  assert.equal(w.body.querySelector('.jcx-multi-start button').disabled, false);
  assert.match(w.body.querySelector('.jcx-multi-why').textContent, /already 20 isolated copies/);
  assert.equal(w.body.querySelector('#jcx-multi-prompt').value, 'add the field');
  assert.deepEqual(boxes().map((b) => b.checked), [true, true]);
  // Started: the form is fresh.
  submit();
  w.fire('code_multi_started', { ok: true, text: '' });
  assert.equal(w.body.querySelector('#jcx-multi-prompt').value, '');
  assert.deepEqual(boxes().map((b) => b.checked), [false, false]);
  assert.equal(w.body.querySelector('.jcx-multi-why').textContent, '');
});

test('Multi-repo: a repository’s line translates Eden’s words, never the branch', () => {
  const w = stand(['code-multirepo.js']);
  w.open('multirepo');
  w.fire('code_multis', { most: 8, groups: [{ slug: 'g', title: 'T', repos: [{ project: 'api', branch: 'jarvis/x', into: 'main', state: {} }] }] });
  const spans = w.body.querySelectorAll('.jcx-multi-repos li span').filter((s) => s.parentNode.tagName === 'SPAN');
  assert.deepEqual(spans.map((s) => [s.textContent, s.hasAttribute('data-no-i18n')]), [['jarvis/x → main', true], ['no changes yet', false]]);
});
