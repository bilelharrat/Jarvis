// Updates for the J.A.R.V.I.S. people download: Electron's autoUpdater (Squirrel.Mac) with
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
// ten minutes, the window isn't in front and JARVIS has nothing going (no turn, meeting notes
// or task: /health's busy). The app comes back as it was, hidden if it was hidden. The
// window's Restart still installs it at once; quitting installs it too (Squirrel).
'use strict';

const fs = require('fs');
const path = require('path');
const { cleanFeedUrl, parseFeed, newerRelease, MAX_FEED } = require('../update-feed');

const FIRST_CHECK = 60 * 1000;
const CHECK_EVERY = 60 * 60 * 1000;
const QUIET_IDLE = 10 * 60; // seconds the Mac has gone untouched before an update installs itself
const QUIET_EVERY = 60 * 1000;
const FETCH_TIMEOUT = 20 * 1000;
const CH = 'feature:updates:';

// What the window shows for each problem (it has the Chinese); the detail goes to the log.
const WORDS = {
  offline: 'Couldn’t reach the update server.',
  feed: 'The update feed isn’t one J.A.R.V.I.S. can read.',
  install: 'The update couldn’t be downloaded or installed.',
  move: 'Move J.A.R.V.I.S. to your Applications folder to get updates.',
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
  isQuiet = async () => false, beforeInstall = () => {},
}) {
  let state = feed ? { state: 'idle' } : { state: 'off' };
  let offered = null; // the release being downloaded or ready
  let wired = false;
  let checking = null;

  const set = (next) => {
    state = next;
    onChange(public_());
  };
  const public_ = () => ({ version, enabled: Boolean(feed), ...state });

  function wire() {
    if (wired) return;
    wired = true;
    autoUpdater.on('update-downloaded', () => {
      if (offered) set({ state: 'ready', available: offered.version, name: offered.name, notes: offered.notes });
    });
    autoUpdater.on('update-not-available', () => {
      if (state.state === 'downloading') set({ state: 'current', checked: Date.now() });
    });
    autoUpdater.on('error', (err) => {
      log(`update: ${err && err.message}`);
      if (state.state !== 'ready') set({ state: 'error', error: WORDS.install });
    });
    autoUpdater.setFeedURL({ url: feed, serverType: 'json' });
  }

  async function run() {
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
    // A check now (launch, the timer, or Check for updates). One at a time; none while an
    // update is downloading or waiting to be installed.
    check() {
      if (!feed || ['downloading', 'ready'].includes(state.state)) return Promise.resolve(public_());
      if (!checking) checking = run().finally(() => { checking = null; });
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

// Nobody would notice an update now: the Mac untouched for a while, JARVIS's window not in
// front, and nothing going in JARVIS.
async function quietMoment({ idleSeconds, windowInFront, backendBusy }) {
  if (idleSeconds() < QUIET_IDLE || windowInFront()) return false;
  return !(await backendBusy());
}

function install(ctx) {
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
  });
  ctx.ipcMain.handle(`${CH}state`, (event) => (ctx.fromWindow(event) ? updater.state() : null));
  ctx.ipcMain.handle(`${CH}check`, (event) => (ctx.fromWindow(event) ? updater.check() : null));
  ctx.ipcMain.handle(`${CH}restart`, (event) => (ctx.fromWindow(event) ? updater.restart() : false));
  if (!feed) return;
  ctx.app.whenReady().then(() => {
    setTimeout(() => updater.check(), FIRST_CHECK).unref?.();
    setInterval(() => updater.check(), CHECK_EVERY).unref?.();
    setInterval(() => { updater.quiet(); }, QUIET_EVERY).unref?.();
  });
}

module.exports = { install, createUpdater, feedFrom, fetchFeed, quietMoment, WORDS, CHECK_EVERY, FIRST_CHECK, QUIET_IDLE };
