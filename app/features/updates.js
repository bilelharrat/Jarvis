// Updates for the Eden Secretary people download: Electron's autoUpdater (Squirrel.Mac) with
// the static feed the dist build writes (release.json, serverType 'json'). Squirrel installs
// an update only when its signature satisfies the running app's designated requirement, that
// is, signed by the same Developer ID team; nothing else can replace the app.
//
// The feed's address is baked in when the app is built (JARVIS_UPDATE_URL, into
// Contents/Resources/update.json). Without one (the owner's install-app build, npm start, the
// test window) updates are off and Settings shows only the version.
//
// It checks a minute after launch and then every hour: the feed first (update-feed.js
// decides whether it's newer, so nothing older is ever offered), then Squirrel downloads it
// in the background. Once it's ready it installs itself, quietly: when the Mac has been idle
// ten minutes, the window isn't in front and Eden Secretary has nothing going (no turn, meeting notes
// or task: /health's busy). The app comes back as it was, hidden if it was hidden. The
// window's Restart still installs it at once; quitting installs it too (Squirrel).
//
// An update Squirrel failed on (a build signed by the wrong team, a damaged zip) is remembered
// by its version (update-failure.json beside the app's settings), and the hourly check leaves
// it alone for a while, twice as long after each failure (one hour, two, four … a week at
// most): it would otherwise download ~200 MB every hour, for ever (audit W26). Check for
// updates in Settings still tries at once; a newer version, or one that installs, starts over.
//
// On Windows (installWindows, win-update.js): askeden.com/windows/latest.json, two minutes after
// launch, then daily and on Check for updates; a newer installer of this flavor (Eden Secretary or
// Eden Daredevil) is offered on a card and a Windows notification, and only the owner's
// Install now downloads it into the app's data folder, checks it against the signed list and
// runs it (it closes the app and replaces it). While Eden Secretary is busy the window asks first.
'use strict';

const fs = require('fs');
const path = require('path');
const { cleanFeedUrl, parseFeed, newerRelease, MAX_FEED } = require('../update-feed');

const FIRST_CHECK = 60 * 1000;
const CHECK_EVERY = 60 * 60 * 1000;
const QUIET_IDLE = 10 * 60; // seconds the Mac has gone untouched before an update installs itself
const QUIET_EVERY = 60 * 1000;
const FETCH_TIMEOUT = 20 * 1000;
const BACKOFF_FIRST = 60 * 60 * 1000;
const BACKOFF_MOST = 7 * 24 * 60 * 60 * 1000;

// How long to leave a version alone after its n-th failure.
const backoffFor = (n) => Math.min(BACKOFF_MOST, BACKOFF_FIRST * 2 ** Math.max(0, n - 1));

// The failure memory in a file ({ version, count, until }): {} when there's none.
function failureFile(file) {
  return {
    get() { try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; } },
    set(value) {
      try {
        if (!value || !value.version) { fs.rmSync(file, { force: true }); return; }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(value));
      } catch { /* kept in memory only: the next failure writes it again */ }
    },
  };
}
const inMemory = () => { let v = {}; return { get: () => v, set: (next) => { v = next || {}; } }; };
const CH = 'feature:updates:';

// What the window shows for each problem (it has the Chinese); the detail goes to the log.
const WORDS = {
  offline: 'Couldn’t reach the update server.',
  feed: 'The update feed isn’t one Eden Secretary can read.',
  install: 'The update couldn’t be downloaded or installed.',
  move: 'Move Eden Secretary to your Applications folder to get updates.',
};

// The feed baked into this copy of the app: '' when there is none.
function feedFrom(resourcesPath, packaged, readFile = fs.readFileSync) {
  if (!packaged || !resourcesPath) return '';
  try {
    return cleanFeedUrl(JSON.parse(readFile(path.join(resourcesPath, 'update.json'), 'utf8')).feed);
  } catch {
    return '';
  }
}

// The updater's state and what moves it; Electron's pieces are passed in (tests use stand-ins).
function createUpdater({
  version, feed, autoUpdater, fetchText, inApplications, onChange = () => {}, log = () => {},
  isQuiet = async () => false, beforeInstall = () => {}, follows = false, failures = inMemory(), now = Date.now,
}) {
  let state = feed ? { state: 'idle' } : { state: 'off' };
  let offered = null; // the release being downloaded or ready
  let wired = false;
  let checking = null;

  const set = (next) => {
    state = next;
    onChange(public_());
  };
  // follows: the owner's own install, which has no feed and follows the repo (follow-repo.js).
  const public_ = () => ({ version, enabled: Boolean(feed), ...(!feed && follows ? { follows: true } : {}), ...state });

  function wire() {
    if (wired) return;
    wired = true;
    autoUpdater.on('update-downloaded', () => {
      failures.set({}); // it worked: nothing to hold back
      if (offered) set({ state: 'ready', available: offered.version, name: offered.name, notes: offered.notes });
    });
    autoUpdater.on('update-not-available', () => {
      if (state.state === 'downloading') set({ state: 'current', checked: Date.now() });
    });
    autoUpdater.on('error', (err) => {
      log(`update: ${err && err.message}`);
      if (state.state === 'ready') return;
      if (offered) {
        const before = failures.get();
        const count = before.version === offered.version ? (Number(before.count) || 0) + 1 : 1;
        const until = now() + backoffFor(count);
        failures.set({ version: offered.version, count, until });
        log(`update: ${offered.version} failed ${count} time${count === 1 ? '' : 's'}; the next try is after ${new Date(until).toISOString()}`);
      }
      set({ state: 'error', error: WORDS.install });
    });
    autoUpdater.setFeedURL({ url: feed, serverType: 'json' });
  }

  async function run({ asked = false } = {}) {
    set({ state: 'checking' });
    let text;
    try {
      text = await fetchText(feed);
    } catch (err) {
      log(`update: the feed didn't answer (${err && err.message})`);
      set({ state: 'error', error: WORDS.offline });
      return;
    }
    let release;
    try {
      release = parseFeed(text, feed);
    } catch (err) {
      log(`update: ${err.message}`);
      set({ state: 'error', error: WORDS.feed });
      return;
    }
    const newer = newerRelease(release, version);
    if (!newer) {
      set({ state: 'current', checked: Date.now() });
      return;
    }
    if (!inApplications()) {
      set({ state: 'move', available: newer.version, error: WORDS.move });
      return;
    }
    // A version that failed lately is left alone until its time (unless the owner asked).
    const failed = failures.get();
    if (!asked && failed.version === newer.version && now() < Number(failed.until)) {
      set({ state: 'error', error: WORDS.install, available: newer.version });
      return;
    }
    offered = newer;
    set({ state: 'downloading', available: newer.version });
    try {
      wire();
      autoUpdater.checkForUpdates();
    } catch (err) {
      log(`update: ${err && err.message}`);
      set({ state: 'error', error: WORDS.install });
    }
  }

  return {
    state: public_,
    // A check now (launch, the timer, or Check for updates: asked, which tries a failed version
    // again at once). One at a time; none while an update is downloading or waiting to be installed.
    check({ asked = false } = {}) {
      if (!feed || ['downloading', 'ready'].includes(state.state)) return Promise.resolve(public_());
      if (!checking) checking = run({ asked }).finally(() => { checking = null; });
      return checking.then(public_);
    },
    // At once, when the owner asks (an update that's ready).
    restart() {
      if (state.state !== 'ready') return false;
      autoUpdater.quitAndInstall();
      return true;
    },
    // By itself, when nobody would notice: a ready update, and the moment is quiet.
    async quiet() {
      if (state.state !== 'ready') return false;
      let calm = false;
      try { calm = await isQuiet(); } catch { calm = false; }
      if (!calm || state.state !== 'ready') return false;
      log(`update: installing ${offered && offered.version} quietly`);
      beforeInstall();
      autoUpdater.quitAndInstall();
      return true;
    },
  };
}

// The feed's text, over Electron's network stack (the Mac's proxy settings), capped in size.
async function fetchFeed(net, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await net.fetch(url, { cache: 'no-store', signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_FEED) throw new Error('too big');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// Nobody would notice an update now: the Mac untouched for a while, Eden Secretary's window not in
// front, and nothing going in Eden Secretary.
async function quietMoment({ idleSeconds, windowInFront, backendBusy }) {
  if (idleSeconds() < QUIET_IDLE || windowInFront()) return false;
  return !(await backendBusy());
}

// Windows: a newer installer of this app's flavor, from askeden.com, run after the owner's yes
// (win-update.js). Off where nothing was installed (npm start, the dev window) and for Eden Code,
// whose Windows downloads aren't in latest.json's update path yet.
function installWindows(ctx, deps = {}) {
  const flavor = (ctx.flavor && ctx.flavor.id) || 'jarvis';
  const off = () => ({ version: ctx.app.getVersion(), enabled: false, state: 'off' });
  if (ctx.dev || !ctx.app.isPackaged || !['jarvis', 'daredevil'].includes(flavor)) {
    ctx.ipcMain.handle(`${CH}state`, (event) => (ctx.fromWindow(event) ? off() : null));
    ctx.ipcMain.handle(`${CH}check`, (event) => (ctx.fromWindow(event) ? off() : null));
    ctx.ipcMain.handle(`${CH}restart`, () => false);
    ctx.ipcMain.handle(`${CH}install`, () => false);
    return null;
  }
  const electron = deps.electron || require('electron');
  const fs = deps.fs || require('fs');
  const win = deps.winUpdate || require('../win-update');
  const updater = win.createWinUpdater({
    version: ctx.app.getVersion(),
    flavor,
    name: (ctx.flavor && ctx.flavor.name) || 'Eden Secretary',
    fetchText: (url) => fetchFeed(electron.net, url),
    download: (url, target, opts) => win.downloadTo(electron.net, fs, url, target, opts),
    runInstaller: (file, args) => win.startInstaller(deps.spawn || require('child_process').spawn, file, args),
    saveDir: () => path.join(ctx.app.getPath('userData'), 'updates'), // the app's own, not Downloads (S8)
    hashFile: (file) => win.sha256Of(fs, file),
    checkSigner: (file) => win.authenticode(deps.execFile || require('child_process').execFile, file),
    removeFile: (file) => fs.promises.rm(file, { force: true }),
    busy: async () => Boolean(ctx.backendBusy && (await ctx.backendBusy())), // a running turn: the window warns first (W27)
    onChange: (state) => ctx.send(`${CH}state`, state),
    log: (line) => console.log(line),
    // A Windows notification (screen readers read it), and the window's card says the same.
    tell: (text) => {
      try {
        if (!electron.Notification || !electron.Notification.isSupported()) return;
        const note = new electron.Notification({ title: (ctx.flavor && ctx.flavor.name) || 'Eden Secretary', body: text });
        note.on('click', () => { const w = ctx.getWindow && ctx.getWindow(); if (w && !w.isDestroyed()) { w.show(); w.focus(); } });
        note.show();
      } catch { /* a notification is never worth a failed check */ }
    },
    quit: () => setTimeout(() => ctx.app.quit(), 1500).unref?.(),
  });
  ctx.ipcMain.handle(`${CH}state`, (event) => (ctx.fromWindow(event) ? updater.state() : null));
  ctx.ipcMain.handle(`${CH}check`, (event) => (ctx.fromWindow(event) ? updater.check() : null));
  ctx.ipcMain.handle(`${CH}restart`, () => false);
  ctx.ipcMain.handle(`${CH}install`, (event, force) => (ctx.fromWindow(event) ? updater.install({ force: force === true }) : false));
  ctx.app.whenReady().then(() => {
    setTimeout(() => updater.check(), win.FIRST_CHECK).unref?.();
    setInterval(() => updater.check(), win.CHECK_EVERY).unref?.();
  });
  return updater;
}

function install(ctx) {
  if (process.platform === 'win32') {
    installWindows(ctx);
    return;
  }
  const { autoUpdater, net, powerMonitor } = require('electron');
  const feed = ctx.dev ? '' : feedFrom(process.resourcesPath, ctx.app.isPackaged);
  const updater = createUpdater({
    version: ctx.app.getVersion(),
    feed,
    autoUpdater,
    fetchText: (url) => fetchFeed(net, url),
    inApplications: () => ctx.app.isInApplicationsFolder(),
    onChange: (state) => ctx.send(`${CH}state`, state),
    log: (line) => console.log(line),
    isQuiet: () => quietMoment({
      idleSeconds: () => powerMonitor.getSystemIdleTime(),
      windowInFront: () => { const w = ctx.getWindow(); return Boolean(w && !w.isDestroyed() && w.isVisible() && w.isFocused()); },
      backendBusy: () => ctx.backendBusy(),
    }),
    beforeInstall: () => ctx.relaunchAsItWas(),
    failures: feed ? failureFile(path.join(ctx.app.getPath('userData'), 'update-failure.json')) : undefined,
    follows: !ctx.dev && ctx.app.isPackaged && Boolean(ctx.backendFromRepo && ctx.backendFromRepo()),
  });
  ctx.ipcMain.handle(`${CH}state`, (event) => (ctx.fromWindow(event) ? updater.state() : null));
  ctx.ipcMain.handle(`${CH}check`, (event) => (ctx.fromWindow(event) ? updater.check({ asked: true }) : null));
  ctx.ipcMain.handle(`${CH}restart`, (event) => (ctx.fromWindow(event) ? updater.restart() : false));
  if (!feed) return;
  ctx.app.whenReady().then(() => {
    setTimeout(() => updater.check(), FIRST_CHECK).unref?.();
    setInterval(() => updater.check(), CHECK_EVERY).unref?.();
    setInterval(() => { updater.quiet(); }, QUIET_EVERY).unref?.();
  });
}

module.exports = { install, installWindows, createUpdater, feedFrom, fetchFeed, quietMoment, failureFile, backoffFor, WORDS, CHECK_EVERY, FIRST_CHECK, QUIET_IDLE, BACKOFF_FIRST, BACKOFF_MOST };
