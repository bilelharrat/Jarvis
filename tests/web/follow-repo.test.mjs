// The owner's own install following the repo (app/features/follow-repo.js): new commits
// restart the backend at a quiet moment; a change to app/ rebuilds the app. node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createFollower } = require('../../app/features/follow-repo.js');

function follower({ heads, quiet = true, app = false, build = true, restart = true }) {
  const calls = [];
  let i = 0;
  const f = createFollower({
    head: async () => heads[Math.min(i++, heads.length - 1)],
    appChanged: async (from, to) => { calls.push(['diff', from, to]); return app; },
    isQuiet: async () => (typeof quiet === 'function' ? quiet() : quiet),
    restartBackend: () => { calls.push(['restart']); return restart; },
    rebuildApp: async () => { calls.push(['rebuild']); return build; },
  });
  return { f, calls };
}

test('the same commit: nothing happens', async () => {
  const { f, calls } = follower({ heads: ['aaa1111', 'aaa1111'] });
  await f.start();
  assert.equal(await f.tick(), 'same');
  assert.deepEqual(calls, []);
});

test('a new commit waits for a quiet moment, then restarts the backend once', async () => {
  let calm = false;
  const { f, calls } = follower({ heads: ['aaa1111', 'bbb2222'], quiet: () => calm });
  await f.start();
  assert.equal(await f.tick(), 'waiting');
  assert.deepEqual(calls, []);
  calm = true;
  assert.equal(await f.tick(), 'restarted');
  assert.deepEqual(calls, [['diff', 'aaa1111', 'bbb2222'], ['restart']]);
  assert.equal(await f.tick(), 'same'); // done: not again
});

test('a change to app/ rebuilds the app; a failed build is tried again later', async () => {
  const { f, calls } = follower({ heads: ['aaa1111', 'bbb2222'], app: true, build: false });
  await f.start();
  assert.equal(await f.tick(), 'failed');
  assert.equal(await f.tick(), 'failed'); // still newer: tried again at the next quiet moment
  assert.deepEqual(calls.filter((c) => c[0] === 'rebuild').length, 2);
  assert.equal(calls.some((c) => c[0] === 'restart'), false);
});

test('without a repo to follow, nothing happens', async () => {
  const { f, calls } = follower({ heads: [null] });
  await f.start();
  assert.equal(await f.tick(), 'none');
  assert.deepEqual(calls, []);
});
