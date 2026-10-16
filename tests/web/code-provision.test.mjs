// Eden Code: set up a cloud machine (web/features/code-provision.js). node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const P = require('../../src/jarvis/web/features/code-provision.js');

test('prices: an hour, or free on this Mac', () => {
  assert.equal(P.fmtHourly(0.0218), '$0.022/h');
  assert.equal(P.fmtHourly(0), 'Free');
  assert.equal(P.sizeLabel({ id: 'e2-small', label: '2 shared vCPU, 2 GB', hourly: 0.0218 }), 'e2-small · 2 shared vCPU, 2 GB · $0.022/h');
});

test('a default name: jarvis-cloud first, then one nobody has', () => {
  assert.equal(P.defaultName('gcp', []), 'jarvis-cloud');
  assert.equal(P.defaultName('gcp', ['jarvis-cloud']), 'eden-gcp');
  assert.equal(P.defaultName('aws', ['jarvis-cloud', 'eden-aws']), 'eden-aws-2');
});

test('a machine says what is being done to it, else its state', () => {
  assert.equal(P.machineWord({ state: 'running', busy: 'Stopping…' }), 'Stopping…');
  assert.equal(P.machineWord({ state: 'failed', problem: 'quota exceeded' }), 'Failed: quota exceeded');
  assert.equal(P.machineWord({ state: 'running', problem: 'old' }), 'Running');
});

test('its buttons follow its state; no image where the provider keeps none', () => {
  assert.deepEqual(P.actions({ state: 'running' }, { images: true }), ['stop', 'image', 'delete']);
  assert.deepEqual(P.actions({ state: 'running' }, { images: false }), ['stop', 'delete']);
  assert.deepEqual(P.actions({ state: 'stopped' }, { images: true }), ['start', 'delete']);
  assert.deepEqual(P.actions({ state: 'failed' }, {}), ['delete']);
  assert.deepEqual(P.actions({ state: 'running', busy: 'Creating…' }, {}), []);
});

test('the sign-in check in a line', () => {
  assert.equal(P.checkWord({ signed_in: true, account: 'me@example.com' }), 'Signed in as me@example.com');
  assert.equal(P.checkWord({ signed_in: true }), 'Signed in');
  assert.match(P.checkWord({ problem: "hcloud isn't installed." }), /isn't installed/);
});

test('idle choices include off', () => {
  assert.ok(P.IDLE_CHOICES.some(([v]) => v === 0));
  assert.ok(P.IDLE_CHOICES.some(([v]) => v === 30));
});
