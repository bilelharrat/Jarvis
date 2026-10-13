// The owner's own install (npm run install-app) runs its backend from the repo and has no
// update feed: what lands in the repo reaches it by itself. Every five minutes this reads the
// repo's HEAD. When it has moved and nobody would notice (updates.js quietMoment: the Mac idle
// ten minutes, the window not in front, nothing going in Eden Secretary), the backend restarts on the
// new code and the window reloads with the new page. When app/ changed as well, the app
// rebuilds itself (npm run package, as install-app does), swaps the new copy in and reopens
// as it was, hidden if it was hidden. A build that fails leaves the running app as it is.
//
// The build takes minutes, so the moment is asked about again once it's done (audit W22): a
// busy one keeps the new copy waiting, and it's swapped in at the next quiet moment. Nothing
// is followed while the repo is mid rebase, merge or cherry-pick, or while app/, src/ or the
// lock files have uncommitted changes (another session's half-written files, W23): the next
// look tries again. After a restart onto new code the backend must answer /health; one that
// doesn't marks that commit bad (logged, never restarted onto again: only a newer commit is
// followed). Going back to the old code isn't done: the backend runs from the repo's working
// tree, which holds only the new.
'use strict';

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { quietMoment } = require('./updates');

const EVERY = 5 * 60 * 1000;
const BUILD_TIMEOUT = 10 * 60 * 1000;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, ...options }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout).trim());
    });
  });
}

// What it does, given its pieces (tests use stand-ins). buildApp gives the new copy (or null);
// swapApp puts it in place and quits; treeState says 'clean', 'dirty' or 'busy' (mid rebase or
// merge); backendHealthy waits for the restarted backend's /health.
function createFollower({
  head, appChanged, isQuiet, restartBackend, buildApp, swapApp,
  treeState = async () => 'clean', backendHealthy = async () => true, log = () => {},
}) {
  let seen = null;
  let working = false;
  let built = null; // { app, commit }: a new copy, built, waiting for a quiet moment to go in
  const bad = new Set(); // commits whose backend didn't come up
  const quiet = () => isQuiet().catch(() => false);
  return {
    // The commit the running code came from.
    async start() {
      seen = await head().catch(() => null);
      return seen;
    },
    // One look: 'same', 'waiting' (newer code, not a quiet moment), 'unsettled' (mid rebase or
    // merge, or uncommitted changes), 'built' (the new copy waits for a quiet moment),
    // 'restarted', 'rebuilt', 'unhealthy' (the backend didn't come back: the commit is bad),
    // 'bad' (that commit again), 'failed', or 'none' (no repo to follow).
    async tick() {
      if (working) return 'working';
      const now = await head().catch(() => null);
      if (!now) return 'none';
      if (seen === null) { seen = now; return 'same'; }
      if (built && built.commit !== now) built = null; // newer still: built again from that
      if (now === seen) return 'same';
      if (bad.has(now)) return 'bad';
      if (built) {
        if (!(await quiet())) return 'waiting';
        working = true;
        try {
          log(`follow-repo: swapping in the app built from ${now.slice(0, 7)}`);
          if (!(await swapApp(built.app))) return 'failed';
          seen = now;
          built = null;
          return 'rebuilt';
        } finally {
          working = false;
        }
      }
      const tree = await treeState().catch(() => 'busy');
      if (tree !== 'clean') return 'unsettled';
      if (!(await quiet())) return 'waiting';
      working = true;
      try {
        if (await appChanged(seen, now).catch(() => false)) {
          log(`follow-repo: app/ changed (${seen.slice(0, 7)} → ${now.slice(0, 7)}): rebuilding`);
          const app = await buildApp();
          if (!app) return 'failed'; // tried again at the next quiet moment
          // The build took minutes: is it still a quiet moment? (W22)
          if (!(await quiet())) {
            built = { app, commit: now };
            log('follow-repo: built; it goes in at the next quiet moment');
            return 'built';
          }
          if (!(await swapApp(app))) return 'failed';
          seen = now;
          return 'rebuilt';
        }
        log(`follow-repo: ${seen.slice(0, 7)} → ${now.slice(0, 7)}: restarting the backend`);
        if (!restartBackend()) return 'failed';
        if (!(await backendHealthy().catch(() => false))) {
          bad.add(now); // (seen stays: a newer commit is compared with the last good one)
          log(`follow-repo: the backend didn't answer after restarting onto ${now.slice(0, 7)}: that commit is marked bad`);
          return 'unhealthy';
        }
        seen = now;
        return 'restarted';
      } finally {
        working = false;
      }
    },
  };
}

// Whether the repo is settled enough to follow: 'busy' mid rebase, merge, cherry-pick or
// revert; 'dirty' with uncommitted changes to what the app or the backend run from.
async function repoState(home, git = run, exists = fs.existsSync) {
  const gitDir = await git('/usr/bin/git', ['-C', home, 'rev-parse', '--absolute-git-dir']);
  if (['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].some((m) => exists(path.join(gitDir, m)))) return 'busy';
  const changed = await git('/usr/bin/git', ['-C', home, 'status', '--porcelain', '--untracked-files=no', '--', 'app', 'src', 'pyproject.toml', 'uv.lock']);
  return changed ? 'dirty' : 'clean';
}

// Builds the app from the repo: the new copy's path, or null.
async function build(ctx, home, log) {
  const appDir = path.join(home, 'app');
  const env = { ...process.env, PATH: [...ctx.extraPath, process.env.PATH || '/usr/bin:/bin'].join(':') };
  const built = await new Promise((resolve) => {
    const child = spawn('npm', ['run', 'package'], { cwd: appDir, env, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGTERM'), BUILD_TIMEOUT);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
  const fresh = path.join(appDir, 'dist', 'J.A.R.V.I.S-darwin-arm64', 'J.A.R.V.I.S.app');
  if (!built || !fs.existsSync(fresh)) {
    log('follow-repo: the app build failed; the running app stays');
    return null;
  }
  return fresh;
}

// Swaps the new copy in once this copy has quit, and reopens it.
function swap(ctx, fresh) {
  const running = path.resolve(process.execPath, '..', '..', '..');
  const script = path.join(os.tmpdir(), `jarvis-swap-${process.pid}.sh`);
  fs.writeFileSync(script, [
    '#!/bin/sh',
    // Wait for this copy to quit, swap the new one in (the old one back if that fails), reopen.
    `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.5; done`,
    'APP="$1"; NEW="$2"',
    'rm -rf "$APP.previous"',
    'if mv "$APP" "$APP.previous" && cp -R "$NEW" "$APP"; then rm -rf "$APP.previous"; else rm -rf "$APP"; mv "$APP.previous" "$APP"; fi',
    'open -g "$APP"',
    'rm -f "$0"',
  ].join('\n'), { mode: 0o755 });
  spawn('/bin/sh', [script, running, fresh], { detached: true, stdio: 'ignore' }).unref();
  ctx.relaunchAsItWas();
  ctx.app.quit();
  return true;
}

function install(ctx) {
  // Only the owner's packaged install follows the repo (the downloadable app has its feed).
  if (ctx.dev || !ctx.app.isPackaged) return;
  const log = (line) => console.log(line);
  const follower = createFollower({
    head: () => (ctx.backendFromRepo() ? run('/usr/bin/git', ['-C', ctx.repoHome(), 'rev-parse', 'HEAD']) : Promise.resolve(null)),
    appChanged: async (from, to) => {
      const changed = await run('/usr/bin/git', ['-C', ctx.repoHome(), 'diff', '--name-only', from, to, '--', 'app/']);
      return changed.split('\n').some((file) => file && !file.startsWith('app/scripts/release/'));
    },
    isQuiet: () => {
      const { powerMonitor } = require('electron');
      return quietMoment({
        idleSeconds: () => powerMonitor.getSystemIdleTime(),
        windowInFront: () => { const w = ctx.getWindow(); return Boolean(w && !w.isDestroyed() && w.isVisible() && w.isFocused()); },
        backendBusy: () => ctx.backendBusy(),
      });
    },
    restartBackend: () => ctx.restartBackendQuietly(),
    buildApp: () => build(ctx, ctx.repoHome(), log),
    swapApp: async (fresh) => swap(ctx, fresh),
    treeState: () => repoState(ctx.repoHome()),
    backendHealthy: () => (ctx.backendAnswers ? ctx.backendAnswers() : Promise.resolve(true)),
    log,
  });
  ctx.app.whenReady().then(() => {
    // The backend starts just after: the commit it runs is read once it's up.
    setTimeout(() => follower.start(), 30_000).unref?.();
    setInterval(() => { follower.tick(); }, EVERY).unref?.();
  });
}

module.exports = { install, createFollower, repoState };
