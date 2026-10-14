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
  assert.equal(spawned[0][1][1], plat.outliveScript(4242, 8));
  assert.equal(spawned[0][2].detached, true);
  assert.deepEqual(spawned[0][2].env, { PATH: '/bin:/usr/bin' }, 'the system’s own ps, whatever the app’s PATH');
  assert.equal(spawned[1], 'unref');
  plat.killTree({ pid: 0, kill() { throw new Error('never'); } }, { outlive: true, spawn });
  assert.equal(spawned.length, 2, 'no process: nothing to watch');
});

// Round 1 A7: a pid alone isn't the process. The real script, run by sh on a real process,
// with a stand-in ps that answers as the system's would: the same process (start time and
// command) is killed; a pid handed on to another process meanwhile is left alone.
test('the watcher kills the pid only while it is still the same process (start time and command)', { skip: plat.WIN }, async () => {
  const { spawn, spawnSync } = await import('node:child_process');
  const fsm = await import('node:fs');
  const osm = await import('node:os');
  const pathm = await import('node:path');
  const dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'outlive-'));
  const run = async (answers) => {
    const victim = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    const ended = new Promise((resolve) => victim.once('exit', (_code, signal) => resolve(signal)));
    const count = pathm.join(dir, `n-${victim.pid}`);
    // ps: its first answer, then its second (each a line), as the system's ps -o lstart= -o command= -p.
    fsm.writeFileSync(pathm.join(dir, 'ps'), `#!/bin/sh\nif [ -f ${count} ]; then echo '${answers[1]}'; else : > ${count}; echo '${answers[0]}'; fi\n`, { mode: 0o755 });
    spawnSync('/bin/sh', ['-c', plat.outliveScript(victim.pid, 0)], { env: { PATH: `${dir}:/bin:/usr/bin` } });
    const signal = await Promise.race([ended, new Promise((resolve) => setTimeout(() => resolve('alive'), 300))]);
    victim.kill('SIGKILL');
    return signal === 'alive';
  };
  assert.equal(await run(['Mon Oct 13 10:00:00 2026 jarvis serve', 'Mon Oct 13 10:00:00 2026 jarvis serve']), false, 'the same process: killed');
  assert.equal(await run(['Mon Oct 13 10:00:00 2026 jarvis serve', 'Mon Oct 13 10:00:07 2026 /Applications/Notes']), true, 'its pid reused: left alone');
  assert.equal(await run(['', 'Mon Oct 13 10:00:07 2026 /Applications/Notes']), true, 'gone before it was looked at: nothing killed');
});
