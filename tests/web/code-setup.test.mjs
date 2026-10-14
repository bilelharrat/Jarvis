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
