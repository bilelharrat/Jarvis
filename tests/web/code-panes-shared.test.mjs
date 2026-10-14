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
