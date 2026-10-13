// The owner's own install following the repo (app/features/follow-repo.js): new commits
// restart the backend at a quiet moment; a change to app/ rebuilds the app. node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createFollower, repoState } = require('../../app/features/follow-repo.js');

function follower({ heads, quiet = true, app = false, build = true, restart = true, tree = 'clean', healthy = true }) {
  const calls = [];
  let i = 0;
  const f = createFollower({
    head: async () => (typeof heads === 'function' ? heads() : heads[Math.min(i++, heads.length - 1)]),
    appChanged: async (from, to) => { calls.push(['diff', from, to]); return app; },
    isQuiet: async () => (typeof quiet === 'function' ? quiet() : quiet),
    restartBackend: () => { calls.push(['restart']); return restart; },
    buildApp: async () => { calls.push(['rebuild']); return build ? '/dist/J.A.R.V.I.S.app' : null; },
    swapApp: async (fresh) => { calls.push(['swap', fresh]); return true; },
    treeState: async () => (typeof tree === 'function' ? tree() : tree),
    backendHealthy: async () => (typeof healthy === 'function' ? healthy() : healthy),
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

test('the build takes minutes: a moment gone busy keeps the new copy waiting for the next quiet one (W22)', async () => {
  const answers = [true, false, false, true]; // before the build; after it; the next look; then quiet
  const { f, calls } = follower({ heads: ['aaa1111', 'bbb2222'], app: true, quiet: () => answers.shift() ?? true });
  await f.start();
  assert.equal(await f.tick(), 'built');
  assert.deepEqual(calls.filter((c) => c[0] === 'swap'), [], 'not swapped in while busy');
  assert.equal(await f.tick(), 'waiting');
  assert.equal(await f.tick(), 'rebuilt');
  assert.deepEqual(calls.filter((c) => c[0] === 'rebuild').length, 1, 'built once');
  assert.deepEqual(calls.at(-1), ['swap', '/dist/J.A.R.V.I.S.app']);
});

test('a waiting copy is dropped when newer code lands, and that is built instead', async () => {
  let head = 'bbb2222';
  const quiet = [true, false];
  const { f, calls } = follower({ heads: () => head, app: true, quiet: () => quiet.shift() ?? true });
  await f.start(); // (bbb2222: then aaa… is moved past)
  head = 'ccc3333';
  assert.equal(await f.tick(), 'built');
  head = 'ddd4444';
  assert.equal(await f.tick(), 'rebuilt');
  assert.equal(calls.filter((c) => c[0] === 'rebuild').length, 2);
  assert.deepEqual(calls.filter((c) => c[0] === 'diff').at(-1), ['diff', 'bbb2222', 'ddd4444']);
});

test('nothing is followed mid rebase or merge, or onto uncommitted changes (W23)', async () => {
  let tree = 'busy';
  const { f, calls } = follower({ heads: ['aaa1111', 'bbb2222'], tree: () => tree });
  await f.start();
  assert.equal(await f.tick(), 'unsettled');
  tree = 'dirty';
  assert.equal(await f.tick(), 'unsettled');
  assert.deepEqual(calls, []);
  tree = 'clean';
  assert.equal(await f.tick(), 'restarted');
});

test('a backend that doesn’t come back marks the commit bad, never restarted onto again (W23)', async () => {
  let head = 'bbb2222';
  let healthy = false;
  const { f, calls } = follower({ heads: () => head, healthy: () => healthy });
  await f.start();
  head = 'ccc3333';
  assert.equal(await f.tick(), 'unhealthy');
  assert.equal(await f.tick(), 'bad');
  assert.equal(calls.filter((c) => c[0] === 'restart').length, 1);
  head = 'ddd4444';
  healthy = true;
  assert.equal(await f.tick(), 'restarted', 'a newer commit is followed');
  assert.deepEqual(calls.filter((c) => c[0] === 'diff').at(-1), ['diff', 'bbb2222', 'ddd4444'], 'compared with the last good one');
});

test('the repo’s state: mid rebase or merge is busy, uncommitted changes to what runs are dirty', async () => {
  const git = (answers) => async (_cmd, args) => (args.includes('--absolute-git-dir') ? '/repo/.git' : answers.status);
  assert.equal(await repoState('/repo', git({ status: '' }), (p) => p === '/repo/.git/rebase-merge'), 'busy');
  assert.equal(await repoState('/repo', git({ status: '' }), (p) => p === '/repo/.git/MERGE_HEAD'), 'busy');
  assert.equal(await repoState('/repo', git({ status: ' M src/jarvis/hub.py' }), () => false), 'dirty');
  assert.equal(await repoState('/repo', git({ status: '' }), () => false), 'clean');
  const asked = [];
  await repoState('/repo', async (cmd, args) => { asked.push(args); return args.includes('--absolute-git-dir') ? '/repo/.git' : ''; }, () => false);
  assert.deepEqual(asked[1], ['-C', '/repo', 'status', '--porcelain', '--untracked-files=no', '--', 'app', 'src', 'pyproject.toml', 'uv.lock']);
});

test('main.js waits for a new backend’s /health after a restart on purpose', () => {
  const main = readFileSync(new URL('../../app/main.js', import.meta.url), 'utf8');
  assert.match(main, /restartedFrom = backend\.pid;\s*quietRestart = true;/);
  assert.match(main, /if \(!backend \|\| backend\.pid === restartedFrom \|\| !port\) \{ again\(\); return; \}/);
  assert.match(main, /backendAnswers, \/\/ the restarted backend/);
});
