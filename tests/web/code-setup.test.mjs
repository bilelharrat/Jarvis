// A project's setup and container (web/features/code-setup.js). node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { projectsWith, imagesWith, containerLine } = require('../../src/jarvis/web/features/code-setup.js');

test('the container switch adds or takes away only this project', () => {
  assert.deepEqual(projectsWith(['a'], 'b', true), ['a', 'b']);
  assert.deepEqual(projectsWith(['a', 'b'], 'a', false), ['b']);
  assert.deepEqual(projectsWith(undefined, 'a', true), ['a']);
  assert.deepEqual(projectsWith(['a'], 'a', true), ['a']);
});

test('the owner’s image is checked before it is saved, and empty clears it', () => {
  assert.deepEqual(imagesWith({ a: 'node:22' }, 'b', ' python:3.12 '), { a: 'node:22', b: 'python:3.12' });
  assert.deepEqual(imagesWith({ a: 'node:22' }, 'a', ''), {});
  assert.equal(imagesWith({}, 'a', '--privileged'), null);
  assert.equal(imagesWith({}, 'a', 'node 22'), null);
});

test('the container line says where commands run, or why not', () => {
  assert.match(containerLine(null), /run their commands on the Mac/);
  assert.match(containerLine({ on: true, docker: 'Docker isn’t on this Mac…' }), /isn’t on this Mac/);
  assert.equal(containerLine({ on: true, running: { name: 'eden-x', image: 'node:22' } }), "This session's commands run in eden-x (node:22).");
  assert.equal(containerLine({ on: true, image: 'node:22' }), 'New copies get a container from node:22.');
  assert.match(containerLine({ on: true }, 'python:3.12'), /devcontainer\.json \(python:3\.12\)/);
  assert.match(containerLine({ on: true }), /there is no image/);
});

// Round 2, U6: once 400 lines were shown, every new line wrote the whole log into the output
// again (its live region read out some 400 lines a line). Now each line is its own text node,
// new ones go on the end and the oldest are taken off.
test('setup output: a line past the last 400 adds one node and drops the oldest, nothing rewritten', async () => {
  const { readFileSync } = await import('node:fs');
  const { elFor, load, makeDocument } = await import('./fixtures/stand-dom.mjs');
  const document = makeDocument();
  const body = document.createElement('div');
  document.body.append(body);
  const panes = new Map();
  const handlers = {};
  const F = {
    el: elFor(document), t: (x) => x, send: () => true,
    on: (type, fn) => { (handlers[type] ||= []).push(fn); },
    registerPane: (id, pane) => panes.set(id, pane), registerMoreItem() {}, openPane() {},
    currentTask: () => ({ id: 7, kind: 'code', folder: 'api' }),
  };
  const scope = { window: { jarvisFeatures: F }, document, deckProject: 'api', currentPane: 'setup' };
  load(readFileSync(new URL('../../src/jarvis/web/features/code-setup.js', import.meta.url), 'utf8'), scope);
  const fire = (type, ev) => { for (const fn of handlers[type] || []) fn(ev); };
  panes.get('setup').render(body);
  fire('code_setup', { id: 7, copy: '/c', setup: 'npm ci', source: '.jarvis/setup.sh', container: {} });
  const out = body.querySelector('.jcx-setup-out');
  assert.ok(out, 'the output is shown');
  fire('code_setup_output', { id: 7, lines: Array.from({ length: 400 }, (_, i) => `line ${i}`) });
  assert.equal(out.childNodes.length, 400);
  const kept = out.childNodes.slice(1);
  fire('code_setup_output', { id: 7, lines: ['line 400'] });
  assert.ok(body.querySelector('.jcx-setup-out') === out, 'the same output, not drawn anew');
  assert.equal(out.childNodes.length, 400);
  assert.ok(kept.every((node, at) => out.childNodes[at] === node), 'the 399 lines kept are the same nodes');
  assert.equal(out.textContent.split('\n')[0], 'line 1');
  assert.equal(out.textContent.split('\n').at(-1), 'line 400');
  assert.equal(out.textContent.split('\n').length, 400);
});
