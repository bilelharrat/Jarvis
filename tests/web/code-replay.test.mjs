// The step-by-step replay's window side (web/features/code-replay.js): how a diff is drawn,
// the turns and their checkpoints, the scrubber's position and bounds, and Settings'
// OpenTelemetry line and address check (the backend's own rule, code_otel.endpoints).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const rp = require('../../src/jarvis/web/features/code-replay.js');

const steps = [
  { n: 0, kind: 'user', uuid: 'u1', turn: 'u1' },
  { n: 1, kind: 'tool', turn: 'u1', path: 'a.py' },
  { n: 2, kind: 'assistant', turn: 'u1' },
  { n: 3, kind: 'user', uuid: 'u2', turn: 'u2' },
  { n: 4, kind: 'assistant', turn: 'u2' },
];

test('a diff is drawn line by line: files, hunks, added, removed, context and the cut', () => {
  const lines = rp.diffLines('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same\n… (3 more lines)\n');
  assert.deepEqual(lines.map((l) => l.cls), ['file', 'file', 'hunk', 'del', 'add', 'ctx', 'more']);
  assert.deepEqual(rp.diffLines(''), []);
  assert.deepEqual(rp.diffLines(null), []);
});

test('turns are the owner’s messages, each with its checkpoint when there is one', () => {
  const turns = rp.turnsOf(steps, [{ uuid: 'u2', files: [] }]);
  assert.deepEqual(turns.map((t) => [t.n, t.number, !!t.checkpoint]), [[0, 1, false], [3, 2, true]]);
  assert.deepEqual(rp.turnsOf('nope'), []);
});

test('a step’s files are its turn’s checkpoint', () => {
  const cps = [{ uuid: 'u1', files: [{ path: '/p/a.py', name: 'a.py' }] }];
  assert.equal(rp.checkpointFor(steps, cps, 2).uuid, 'u1');
  assert.equal(rp.checkpointFor(steps, cps, 4), null);
  assert.equal(rp.checkpointFor(steps, cps, 99), null);
  assert.equal(rp.checkpointFor([{ n: 0, kind: 'note', turn: '' }], cps, 0), null);  // (before any message)
});

test('the scrubber says where it is and never goes past either end', () => {
  assert.equal(rp.position(steps, 0), 'Step 1 of 5 · turn 1');
  assert.equal(rp.position(steps, 4), 'Step 5 of 5 · turn 2');
  assert.equal(rp.position([], 0), 'No steps');
  assert.equal(rp.position([{ n: 0, kind: 'note' }], 0), 'Step 1 of 1');
  assert.equal(rp.clamp(-3, steps), 0);
  assert.equal(rp.clamp(12, steps), 4);
  assert.equal(rp.clamp(NaN, steps), 0);
  assert.equal(rp.clamp(2, []), 0);
});

test('Settings’ OpenTelemetry line: off, a bad address, an error with what waits, what went', () => {
  assert.equal(rp.otelLine(null), 'Off. Nothing is sent.');
  assert.equal(rp.otelLine({ enabled: false }), 'Off. Nothing is sent.');
  assert.match(rp.otelLine({ enabled: true, endpoint_ok: false }), /can’t be used/);
  assert.equal(rp.otelLine({ enabled: true, endpoint_ok: true, error: 'Couldn’t reach the collector: refused', waiting: 4 }), 'Couldn’t reach the collector: refused 4 waiting to go.');
  assert.equal(rp.otelLine({ enabled: true, endpoint_ok: true, sent: 12 }), 'On. 12 sent.');
  assert.match(rp.otelLine({ enabled: true, endpoint_ok: true, sent: 0 }), /Nothing sent yet/);
});

test('a collector’s address: https anywhere, plain http only on this Mac or its network', () => {
  for (const ok of ['', 'http://localhost:4318', 'http://127.0.0.1:4318', 'http://[::1]:4318', 'http://192.168.1.4:4318', 'http://10.0.0.2', 'http://collector.local:4318', 'https://otel.example.com/v1/traces']) {
    assert.equal(rp.endpointOk(ok), true, ok);
  }
  for (const bad of ['http://otel.example.com', 'http://8.8.8.8:4318', 'ftp://localhost', 'https://u:p@otel.example.com', 'otel.example.com', 'http://172.32.0.1']) {
    assert.equal(rp.endpointOk(bad), false, bad);
  }
});
