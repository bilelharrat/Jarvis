// Stopping the backend (app/platform-paths.js killTree, audit W28): asked first, killed if it
// hangs, also when the app itself is quitting. Stand-in processes: nothing is signalled.
// node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const plat = require('../../app/platform-paths.js');

function child() {
  return { pid: 4242, exitCode: null, signalCode: null, signals: [], kill(sig) { this.signals.push(sig); } };
}

test('a backend that ignores SIGTERM is killed after the grace time; one that went is left alone', { skip: plat.WIN }, () => {
  const timers = [];
  const setTimer = (fn, ms) => { timers.push([fn, ms]); return { unref() {} }; };
  const hung = child();
  plat.killTree(hung, { setTimer });
  assert.deepEqual(hung.signals, ['SIGTERM']);
  assert.equal(timers[0][1], plat.KILL_AFTER);
  timers[0][0]();
  assert.deepEqual(hung.signals, ['SIGTERM', 'SIGKILL']);
  const polite = child();
  plat.killTree(polite, { setTimer });
  polite.signalCode = 'SIGTERM';
  timers[1][0]();
  assert.deepEqual(polite.signals, ['SIGTERM'], 'gone already: no SIGKILL');
});

test('while the app quits, a detached watcher outlives it and kills only that pid, only if it’s still there', { skip: plat.WIN }, () => {
  const spawned = [];
  const spawn = (cmd, args, opts) => { spawned.push([cmd, args, opts]); return { unref() { spawned.push('unref'); } }; };
  const c = child();
  plat.killTree(c, { outlive: true, spawn });
  assert.deepEqual(c.signals, ['SIGTERM']);
  assert.equal(spawned[0][0], '/bin/sh');
  assert.equal(spawned[0][1][1], 'sleep 8; kill -0 4242 2>/dev/null && kill -9 4242');
  assert.equal(spawned[0][2].detached, true);
  assert.equal(spawned[1], 'unref');
  plat.killTree({ pid: 0, kill() { throw new Error('never'); } }, { outlive: true, spawn });
  assert.equal(spawned.length, 2, 'no process: nothing to watch');
});
