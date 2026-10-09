// Jarvis desktop app: starts the Python backend, shows its window, owns the ⌥Space shortcut.
// The same file is Eden Code, the coding app split out of Jarvis (flavor.js): Eden Code alone
// in its own window, sharing the backend Jarvis runs or starting one without a microphone.

const { app, BrowserWindow, Menu, WebContentsView, clipboard, dialog, globalShortcut, ipcMain, nativeTheme, powerSaveBlocker, screen, session, shell, systemPreferences } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { toUrl, homeUrl, searchEngine, searchUrl } = require('./url-input'); // what the address bar makes of what's typed
const { createAgent } = require('./browser-agent');
const { backendCommand, BackendLog } = require('./backend-launch'); // the bundled backend, else uv and the repo; its log
const { createParity } = require('./browser-parity'); // per-site permissions, popups, sign-in, Settings › Browser
const { isCertError } = require('./browser-lib');
const { resolveFlavor } = require('./flavor'); // J.A.R.V.I.S. or Eden Code
const share = require('./backend-share'); // one backend for both apps
const { createTrace, createTail } = require('./startup-log'); // app.log: how this start went
const { waitForHealth, SLOW_WORDS } = require('./wait-backend'); // the engine's first answer, and what is said until then

const FLAVOR = resolveFlavor();
const EDEN_CODE = FLAVOR.id === 'eden-code';
app.setName(FLAVOR.name);
// Windows shows a toast (a timer, an alert, "needs your OK") only for an app whose ID matches the
// Start menu shortcut the installer makes from its appId (scripts/release/windows.js).
if (process.platform === 'win32') app.setAppUserModelId(FLAVOR.appUserModelId);
// Eden Code keeps its own profile (window place, single-instance lock, browser data), so it
// runs beside J.A.R.V.I.S.; the backend's data folder (DATA_DIR) is the one they share.
if (EDEN_CODE) app.setPath('userData', path.join(app.getPath('appData'), 'Eden Code'));
// J.A.R.V.I.S. Daredevil is the same program as J.A.R.V.I.S. (flavor.js): one profile, so one lock, and never two at once.
if (FLAVOR.userDataName) app.setPath('userData', path.join(app.getPath('appData'), FLAVOR.userDataName));

// This app's backend's token, or the one it shares (backend-share.js: another app started it).
let TOKEN = crypto.randomBytes(24).toString('hex');
const SHORTCUT = process.platform === 'win32' ? 'Ctrl+Alt+J' : 'Alt+Space'; // (Alt+Space is Windows' window menu; J is the key a finger finds by touch)
const WHATS_THIS = 'Alt+Shift+Space'; // explain whatever is in front of you
const plat = require('./platform-paths');
const LOG_DIR = plat.logDir(FLAVOR.logName);
const LOG_LABEL = plat.logLabel(FLAVOR.logName);
const DATA_DIR = plat.dataDir(); // the backend's (prefs.APP_SUPPORT)
// app.log: what the app did on the way up and what went wrong, for a start that shows nothing (startup-log.js).
const trace = createTrace(path.join(LOG_DIR, 'app.log'));
const APP_LOG_LABEL = LOG_LABEL.replace(/backend\.log$/, 'app.log');
trace.write(`${FLAVOR.name} ${app.getVersion()} (electron ${process.versions.electron}, ${process.platform} ${process.arch}, ${os.release()}) ${app.isPackaged ? 'installed' : 'from source'}: ${process.execPath} ${JSON.stringify(process.argv.slice(1))}`);
// Development only: show a backend that's already running (no microphone of its own)
// instead of starting one, with a profile of its own and without the global shortcuts,
// so it can run beside the installed app.
const DEV_URL = process.env.JARVIS_BACKEND_URL || '';
if (DEV_URL) {
  app.setPath('userData', path.join(os.tmpdir(), `${FLAVOR.id}-dev-profile`));
  // …and downloads of its own: testing never writes into the real Downloads folder
  app.setPath('downloads', path.join(os.tmpdir(), `${FLAVOR.id}-dev-downloads`));
  fs.mkdirSync(app.getPath('downloads'), { recursive: true });
}

let win = null;
let backend = null;
let port = 0;
let quitting = false;
let backendFromRepo = false; // uv runs it from the repo (the owner's own install), not the bundle
let quietRestart = false; // the backend is being restarted on purpose (app/features/follow-repo.js)
let sharedFrom = ''; // the app whose backend this window is on, when it isn't this one's
let stopWatching = null; // stops watching that backend (backend-share.js watch)

// One Jarvis at a time: a second launch (npm start twice, a dev build beside the installed
// app) brings the running one forward instead of starting a second backend on the same
// files. Asked after the dev profile is set above, so the test window, with a profile of
// its own, never collides with the installed app.
const gotLock = app.requestSingleInstanceLock();
trace.write(gotLock ? 'the only copy running: starting' : 'another copy is already running: this one quits and brings that one forward');
if (!gotLock) app.quit();
app.on('second-instance', () => {
  trace.write(`started again while running${win && !win.isDestroyed() ? ': bringing the window forward' : ' (no window yet)'}`);
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (DEV_URL) {
    win.showInactive(); // the test window never takes focus
  } else {
    win.show();
    win.focus();
  }
});

// jarvis:// links (app/features/shell.js opens them). One that launches the app arrives
// before the features load, so it waits here until one takes them.
const earlyLinks = [];
let openLink = null;
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (openLink) openLink(url);
  else if (earlyLinks.length < 10) earlyLinks.push(url);
});

// An error nobody caught: written to app.log and, once a minute at most, shown (Electron's own box says nothing of
// where to look, and a start that fails before any window has nothing else to show).
let lastErrorBox = 0;
process.on('uncaughtException', (err) => {
  trace.write(`UNCAUGHT ERROR: ${(err && err.stack) || err}`);
  if (Date.now() - lastErrorBox < 60000) return;
  lastErrorBox = Date.now();
  try {
    dialog.showErrorBox(`${FLAVOR.name} hit a problem`, `${(err && err.message) || err}\n\nWhat it did is written in ${APP_LOG_LABEL}`);
  } catch { /* no box to show */ }
});
process.on('unhandledRejection', (reason) => {
  trace.write(`unhandled rejection: ${(reason && reason.stack) || reason}`);
});
app.on('child-process-gone', (_event, details) => {
  trace.write(`a ${details.type} process went (${details.reason}, exit ${details.exitCode}${details.name ? `, ${details.name}` : ''})`);
});
app.on('render-process-gone', (_event, _contents, details) => {
  trace.write(`a page's process went (${details.reason}, exit ${details.exitCode})`);
});

function jarvisHome() {
  if (process.env.JARVIS_HOME) return process.env.JARVIS_HOME;
  const baked = path.join(__dirname, 'jarvis-home.json');
  if (fs.existsSync(baked)) return JSON.parse(fs.readFileSync(baked, 'utf8')).path;
  return path.resolve(__dirname, '..');
}

// Apps opened from Finder don't inherit the shell's PATH, so look where uv usually lives.
const EXTRA_PATH = plat.extraPath();

function findUv() {
  for (const dir of EXTRA_PATH) {
    const candidate = path.join(dir, plat.exe('uv'));
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'uv';
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port: p } = srv.address();
      srv.close(() => resolve(p));
    });
  });
}

// backend.log keeps the last few starts: past 5 MB it becomes backend.1.log (replacing
// the one before), at a start and as the backend runs (backend-launch.js), so a crash loop
// or a noisy backend can't fill the disk.
const BACKEND_LOG_MAX = 5 * 1024 * 1024;

function openBackendLog() {
  return new BackendLog(path.join(LOG_DIR, 'backend.log'), { max: BACKEND_LOG_MAX });
}

// The microphone is asked for here, by the app itself, before the backend first opens it. On a
// fresh install the backend would otherwise trigger the prompt with a stream already open,
// and a stream opened before access was granted hears only silence. (listen.py also reopens
// a microphone that sends nothing but zeros.) At most 60 s: an unanswered prompt never
// keeps JARVIS from starting.
async function askForMicrophone() {
  if (process.platform !== 'darwin' || DEV_URL || EDEN_CODE) return; // Eden Code never listens
  try {
    if (systemPreferences.getMediaAccessStatus('microphone') !== 'not-determined') return;
    await Promise.race([
      systemPreferences.askForMediaAccess('microphone'),
      new Promise((resolve) => setTimeout(resolve, 60000)),
    ]);
  } catch (_) { /* no prompt to show: the backend's own asking still applies */ }
}

// What the backend printed last, for the window to say when it stops (a ModuleNotFoundError, a port in use).
const backendTail = createTail();

function startBackend() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const log = openBackendLog();
  const how = backendCommand({
    packaged: app.isPackaged, resourcesPath: process.resourcesPath, env: process.env, port, token: TOKEN,
    extraPath: EXTRA_PATH, uv: findUv, home: jarvisHome, dataDir: DATA_DIR, exists: fs.existsSync,
  });
  if (how.cwd) fs.mkdirSync(how.cwd, { recursive: true });
  if (app.isPackaged && !how.bundled && !process.env.JARVIS_HOME) {
    // An installed app with no engine of its own: its files were removed (security software does that) or the install was cut short.
    trace.write(`the engine is missing: no ${path.join(process.resourcesPath, 'backend', 'python')}`);
    showProblem(`${FLAVOR.name}'s engine files are missing (${path.join(process.resourcesPath, 'backend')}). Windows Security or another antivirus may have removed them. Install ${FLAVOR.name} again, and allow it in Windows Security if it asks.`);
    log.end();
    return;
  }
  // This .app, so a paired iPhone can open it after it's quit (jarvis/companion_wake.py).
  if (app.isPackaged && plat.MAC) how.env.JARVIS_APP_BUNDLE = path.resolve(process.execPath, '..', '..', '..');
  // Who the backend watches, so it goes when we do (jarvis/launcher_watch.py). Packaged or
  // from the repo, because without it the backend guessed — and could take one of Electron's
  // helper processes for the app. A helper quits while the app runs, and the backend went
  // with it mid-session, taking the chats, the session list and the steer button.
  how.env.JARVIS_LAUNCHER_PID = String(process.pid);
  how.env.JARVIS_PROFILE = FLAVOR.profile; // Eden Code's: no microphone until Jarvis joins (hub.window_joined)
  how.env.JARVIS_EDITION = FLAVOR.edition || ''; // 'daredevil': screen-reader mode is the default (accessibility.py)
  log.write(`\n--- ${new Date().toISOString()} starting on port ${port}${how.bundled ? ' (bundled backend)' : ''} for ${FLAVOR.name}\n`);
  backendFromRepo = !how.bundled;
  trace.write(`starting the engine on port ${port}: ${how.command} ${how.args.join(' ')}${how.bundled ? '' : ' (not the bundled one)'}`);
  backendTail.reset();
  backendTail.add(`--- ${new Date().toISOString()}\n`);
  backend = spawn(how.command, how.args, { env: how.env, cwd: how.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); // (windowsHide: no console window for the engine)
  trace.write(`engine process ${backend.pid || 'not started'}`);
  backend.stdout.on('data', (chunk) => backendTail.add(chunk));
  backend.stderr.on('data', (chunk) => backendTail.add(chunk));
  // Where it is, for the other app (Jarvis or Eden Code) to open its window on it too.
  if (!DEV_URL && backend.pid) share.advertise(DATA_DIR, { port, token: TOKEN, pid: backend.pid, app: FLAVOR.id, launcher: process.pid });
  // Both into the one log, which ends once both have (the backend gone, its pipes closed).
  backend.stdout.pipe(log, { end: false });
  backend.stderr.pipe(log, { end: false });
  backend.once('close', () => log.end());
  backend.on('error', (err) => {
    trace.write(`the engine could not be started: ${err.message}`);
    showProblem(`Couldn't start the backend: ${err.message}`, backendTail.last());
  });
  backend.on('exit', (code, signal) => {
    trace.write(`the engine stopped (exit ${code}${signal ? `, ${signal}` : ''}); it last said:\n${backendTail.last(12, 1800)}`);
    backend = null;
    share.withdraw(DATA_DIR, process.pid);
    if (quitting) return;
    if (quietRestart) {
      quietRestart = false;
      reopenBackend();
      return;
    }
    restartBackend(code, signal);
  });
}

// Back up after a restart on purpose: the window reloads with whatever is new.
async function reopenBackend() {
  startBackend();
  try {
    await waitForBackend();
    loadApp();
  } catch (err) {
    if (!err.exited) showProblem(`${FLAVOR.name} couldn't start again: ${err.message}. Details are in ${LOG_LABEL}.`);
  }
}

// Restarts the backend (onto the repo's newest code); false when there's none running.
function restartBackendQuietly() {
  if (!backend) return false;
  quietRestart = true;
  plat.killTree(backend);
  return true;
}

// Whether the backend has something going that a restart would cut off (/health's busy).
// Unsure (no answer) counts as busy: nothing is restarted on a guess.
function backendBusy() {
  return new Promise((resolve) => {
    if (!backend || !port) return resolve(true);
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 3000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body).busy !== false); } catch { resolve(true); }
      });
    });
    req.on('error', () => resolve(true));
    req.on('timeout', () => { req.destroy(); resolve(true); });
  });
}

// A quiet update or rebuild reopens the app as it was: hidden when its window was hidden.
const HIDDEN_MARK = () => path.join(app.getPath('userData'), 'reopen-hidden');
function relaunchAsItWas() {
  try {
    if (win && !win.isDestroyed() && win.isVisible()) fs.rmSync(HIDDEN_MARK(), { force: true });
    else fs.writeFileSync(HIDDEN_MARK(), String(Date.now()));
  } catch { /* it just opens as usual */ }
}
function reopenHidden() {
  try {
    const at = Number(fs.readFileSync(HIDDEN_MARK(), 'utf8'));
    fs.rmSync(HIDDEN_MARK(), { force: true });
    return Date.now() - at < 15 * 60_000; // only right after a quiet update
  } catch {
    return false;
  }
}

// A backend that stops on its own is started again (a few times, a little later each
// time), so a crash never leaves Jarvis dead; the log keeps what happened. One ended by a
// signal (macOS's memory pressure, Force Quit, a crash) has no exit code: the signal is named.
let restarts = [];
function restartBackend(code, signal) {
  const now = Date.now();
  restarts = restarts.filter((t) => now - t < 5 * 60_000);
  // 75: another backend holds the data folder (server.serve): one still quitting, or a
  // `jarvis serve` started in a terminal.
  const taken = code === 75;
  const how = signal ? `was stopped (${signal})` : `stopped (exit ${code})`;
  if (restarts.length >= 3) {
    showProblem(taken
      ? 'Another JARVIS backend is still using your data (a `jarvis serve` in a terminal, or one that hasn’t finished quitting). Quit it, then open Jarvis again.'
      : `The backend ${how} three times in five minutes. Details are in ${LOG_LABEL}.`, taken ? '' : backendTail.last());
    return;
  }
  restarts.push(now);
  showProblem(taken ? 'Another JARVIS backend is still using your data. Waiting for it to finish…' : `The backend ${how}. Starting it again…`);
  setTimeout(async () => {
    if (quitting || backend) return;
    // The other app's backend has the data folder (both started at once): share it instead.
    if (taken && (await shareBackend())) { restarts = []; return; }
    startBackend();
    try {
      await waitForBackend();
      loadApp();
    } catch (err) {
      // Another exit comes back to restartBackend, which says what happens next.
      if (!err.exited) showProblem(`${FLAVOR.name} couldn't start again: ${err.message}. Details are in ${LOG_LABEL}.`);
    }
  }, 1500 * restarts.length);
}

// Waits for the engine (wait-backend.js): ten minutes on a PC, where a first start is slow; elsewhere 90 seconds is plenty.
function waitForBackend(timeoutMs = plat.WIN ? 600000 : 90000) {
  return waitForHealth({
    port: () => port,
    running: () => Boolean(backend),
    timeoutMs,
    words: SLOW_WORDS.map(([after, text]) => [after, text.replace('%LOG%', APP_LOG_LABEL)]),
    say: sayWhileWaiting,
    note: (text) => trace.write(text),
  });
}

// A line under the "Waking up…" the window already shows (not an error: nothing is reloaded).
function sayWhileWaiting(text) {
  if (!win || win.isDestroyed() || !win.webContents.getURL().startsWith('file:')) return;
  win.webContents.executeJavaScript(`window.sayWhileWaiting && window.sayWhileWaiting(${JSON.stringify(text)})`).catch(() => {});
}

function showProblem(message, detail = '') {
  trace.write(`the window says: ${message}${detail ? `\n${detail}` : ''}`);
  if (win && !win.isDestroyed()) win.loadFile(path.join(__dirname, 'loading.html'), { query: { error: message, ...(detail ? { detail } : {}), app: FLAVOR.id } });
}

function appUrl() {
  return `http://127.0.0.1:${port}/`;
}

// The window on the backend: Jarvis's page, or Eden Code's (?app=code: server.eden_code_page), or Daredevil's.
function loadApp() {
  trace.write('opening the app in the window');
  if (win && !win.isDestroyed()) win.loadURL(`${appUrl()}?token=${TOKEN}${FLAVOR.query ? `&${FLAVOR.query}` : ''}`);
}

// Starts this app's own backend and opens the window on it.
async function startOwnBackend() {
  port = await freePort();
  startBackend();
  try {
    await waitForBackend();
    loadApp();
  } catch (err) {
    // A backend that exited is restartBackend's: it has already said what's happening (for
    // exit 75, waiting for a backend that's still quitting), starts it again and loads the
    // window once it's up. Saying "couldn't start" over that read as final when it wasn't.
    if (!err.exited) showProblem(`${FLAVOR.name} couldn't start: ${err.message}. Details are in ${LOG_LABEL}.`);
  }
}

// The window on the backend the other app (Jarvis or Eden Code) is running, when there is one;
// else this app's own. Shared, it's watched: once it goes (that app quit), this app starts its
// own and the window reloads on it, sessions and all (they're in the shared data folder).
async function openOnBackend() {
  if (!(await shareBackend())) await startOwnBackend();
}

// Opens the window on the other app's running backend: false when there's none to share.
async function shareBackend() {
  const found = DEV_URL ? null : await share.discover(DATA_DIR);
  if (!found) return false;
  port = found.port;
  TOKEN = found.token;
  sharedFrom = found.app;
  console.log(`${FLAVOR.name}: sharing the backend ${found.app || 'another app'} started (port ${port})`);
  loadApp();
  stopWatching = share.watch(port, () => {
    stopWatching = null;
    sharedFrom = '';
    if (quitting) return;
    TOKEN = crypto.randomBytes(24).toString('hex');
    showProblem(`${found.app === 'eden-code' ? 'Eden Code' : 'J.A.R.V.I.S.'} quit, so ${FLAVOR.name} is starting its own backend…`);
    startOwnBackend();
  });
  return true;
}

function createWindow() {
  win = new BrowserWindow({
    ...FLAVOR.size,
    show: false,
    title: FLAVOR.title,
    ...(plat.MAC ? { titleBarStyle: 'hiddenInset' } : { autoHideMenuBar: true }),
    backgroundColor: nativeTheme.shouldUseDarkColors ? FLAVOR.background.dark : FLAVOR.background.light,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required', // (J.A.R.V.I.S. Daredevil's opening sound, loading.js)
    },
  });
  // (a quiet update's, or the sign-in's: asked once, as the mark is used up)
  const hidden = !DEV_URL && (reopenHidden() || process.argv.includes('--hidden'));
  if (DEV_URL) {
    // A test window: labelled, never takes focus, and clicks pass through it.
    win.setTitle(`${FLAVOR.title} (test)`);
    win.once('ready-to-show', () => { win.showInactive(); win.setIgnoreMouseEvents(true); });
  } else {
    let shown = false;
    const show = (why) => {
      if (shown || !win || win.isDestroyed()) return;
      shown = true;
      trace.write(hidden ? `the window is ready and stays hidden (${why})` : `window shown (${why})`);
      if (!hidden) win.show();
    };
    win.once('ready-to-show', () => show('painted'));
    // A page that never paints (a graphics driver that won't draw) must not leave the app with no window at all.
    setTimeout(() => show('not painted after 4 s: showing it anyway'), 4000);
  }
  const seen = (url) => String(url || '').replace(/token=[0-9a-f]+/g, 'token=…');
  win.webContents.on('did-finish-load', () => trace.write(`page loaded: ${seen(win.webContents.getURL())}`));
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) trace.write(`page failed to load: ${description} (${code}) ${seen(url)}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    trace.write(`the window's page crashed (${details.reason}, exit ${details.exitCode})`);
    if (details.reason !== 'clean-exit' && !quitting && port) setTimeout(() => { if (win && !win.isDestroyed()) loadApp(); }, 1000);
  });
  win.on('unresponsive', () => trace.write('the window is not responding'));
  win.on('responsive', () => trace.write('the window responds again'));
  win.loadFile(path.join(__dirname, 'loading.html'), { query: { app: FLAVOR.id, ...(hidden || DEV_URL ? { quiet: '1' } : {}) } });

  // The window only ever shows Jarvis; any other link opens in the browser.
  const external = (url) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(appUrl())) shell.openExternal(url);
  };
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(appUrl()) && !url.startsWith('file://')) {
      event.preventDefault();
      external(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: 'deny' };
  });

  // Closing the window hides it; Jarvis keeps running for ⌥Space. ⌘Q quits.
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
}

function summon() {
  if (!win) return;
  win.show();
  win.focus();
  app.focus({ steal: true });
  win.webContents.send('jarvis:summon');
}

// Screen-reader mode (web/features/accessibility.js): Electron knows when assistive technology is
// in use (NVDA, JAWS, Narrator, VoiceOver); the page asks, and hears when that changes.
ipcMain.handle('a11y:supported', () => app.isAccessibilitySupportEnabled());
app.on('accessibility-support-changed', (_event, enabled) => {
  if (win && !win.isDestroyed()) win.webContents.send('a11y:changed', enabled);
});

ipcMain.handle('jarvis:pick-folder', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Add a folder to the second brain',
    defaultPath: path.join(os.homedir(), 'Documents'),
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// ── The built-in browser ──
// A sandboxed page in its own storage partition, docked beside Jarvis. No Node, no access
// to the app: page-preload.js runs in an isolated world as Jarvis's hand in the page (the
// cursor, lighting up what it aims at, clicking, scrolling, reading). On the BSH Research
// Center's own pages the user's mouse and keyboard work as on any page, and Jarvis drives
// it too, by voice and by hand. The lock badge in the address bar switches it to Jarvis
// only (researchLock in browser.json): then the mouse and keyboard don't reach the page,
// except on its sign-in pages, so the user signs in themselves.

const RESEARCH_AUTH = /^\/(login|reset|terms|account\/password)(\/|$)/;
let browserView = null; // the tab on show; the others keep loading behind it
const tabs = [];
const closedTabs = []; // ⌘⇧T reopens these
let lastBounds = null;
let browserShown = false;
let browserLocked = false;
let browserSynthetic = false; // true only while Jarvis itself sends input
let agentInput = false; // true while the browser agent's own keys and clicks go in (browser-agent.js)
let browserZoom = 1; // the zoom last set (each site keeps its own: browser-parity.js)
let researchBase = '';
let browserAsked = false; // a page was asked for: showing the view must not load the start page over it
// The window the dock is in: Jarvis's own, or the Ask Eden window's browser panel while it's
// open there (features/eden-window.js, through featureContext.browserDock). Jarvis's window
// gets it back when that panel closes, as it was (mainWants, mainBounds).
let dockWin = null;
let mainWants = false;
let mainBounds = null;
const dockHost = () => (dockWin && !dockWin.isDestroyed() ? dockWin : win);
const pageCalls = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function researchOrigin() {
  try { return new URL(researchBase).origin; } catch { return ''; }
}

function onResearch(url) {
  try { return Boolean(researchBase) && new URL(url).origin === researchOrigin(); } catch { return false; }
}

// A page's path inside the Research Center: the hosted one lives under /research, so its
// sign-in page is /research/login, which is /login to the app.
function researchPath(url) {
  let pathname = '/';
  try { pathname = new URL(url).pathname; } catch { return pathname; }
  let base = '';
  try { base = new URL(researchBase).pathname.replace(/\/+$/, ''); } catch {}
  if (base && (pathname === base || pathname.startsWith(`${base}/`))) return pathname.slice(base.length) || '/';
  return pathname;
}

function tabList() {
  return tabs.map((view) => {
    const wc = view.webContents;
    return { id: wc.id, title: wc.getTitle(), url: wc.getURL(), loading: wc.isLoading(), research: onResearch(wc.getURL()), active: view === browserView, favicon: view.favicon || '', ...parity.tabInfo(view) };
  });
}

function sendBrowserState(extra = {}) {
  if (!browserView || !win) return;
  const wc = browserView.webContents;
  const url = wc.getURL();
  const guard = shields();
  const payload = {
    tabs: tabList(),
    shields: { on: guard.adblock && Boolean(blocker), ready: Boolean(blocker), site: hostOf(url), allowed: guard.allow.includes(hostOf(url)), research: onResearch(url), blocked: blockedOn.get(wc.id) || 0, total: blockedTotal },
    url,
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canBack: wc.navigationHistory.canGoBack(),
    canForward: wc.navigationHistory.canGoForward(),
    locked: browserLocked,
    lockWanted: browserStore().researchLock,
    research: onResearch(url),
    zoom: Math.round(wc.getZoomFactor() * 100),
    ...extra,
  };
  win.webContents.send('browser:state', payload);
  const eden = dockWin && !dockWin.isDestroyed() ? dockWin : null;
  if (eden) eden.webContents.send('feature:eden:browser:state', { ...payload, docked: browserShown });
}

function updateLock() {
  const wc = browserView.webContents;
  browserLocked = browserStore().researchLock && onResearch(wc.getURL()) && !RESEARCH_AUTH.test(researchPath(wc.getURL()));
  wc.send('jarvis:locked', browserLocked);
  sendBrowserState();
}

// Whether a page may ever be locked: any on the Research Center (its sign-in pages too, since
// it moves on from them without loading again), or, while its address isn't known yet, any
// page at all when the lock is wanted. page-preload.js takes the wheel and touch blockers away
// from the others, so their scroll never waits for their scripts; a page keeps them until it's
// told, so a page that may be locked always has them in place before the lock comes.
function mayLock(url) {
  return researchBase ? onResearch(url) : browserStore().researchLock;
}

function tellLockable(wc) {
  if (wc && !wc.isDestroyed()) wc.send('jarvis:lockable', mayLock(wc.getURL()));
}

// The lock badge: Jarvis only on the Research Center, or the user's mouse and keyboard too.
function setResearchLock(on) {
  const store = browserStore();
  store.researchLock = Boolean(on);
  saveBrowserStore();
  for (const view of tabs) tellLockable(view.webContents);
  if (browserView) updateLock();
  return store.researchLock;
}

function ensureBrowser() {
  readyDownloads();
  readyAdblock();
  if (!browserView && !parity.restore()) { // last time's tabs, when the owner keeps them (browser-parity.js)
    browserView = createTab();
    tabs.push(browserView);
  }
  return browserView;
}

// Show another tab in the dock's slot (the page's lock and state follow it).
function selectTab(view) {
  if (!view || view === browserView) return;
  if (parity.poppedOut(view)) { parity.focusPopout(view); return; } // a tab in a window of its own
  if (browserShown && browserView) dockHost().contentView.removeChildView(browserView);
  browserView = view;
  parity.selected(view);
  if (browserShown) {
    dockHost().contentView.addChildView(view);
    if (lastBounds) view.setBounds(lastBounds);
  }
  view.webContents.setZoomFactor(parity.zoomFor(view.webContents)); // the site's own zoom
  updateLock();
}

function newTab(url, opts) {
  const view = createTab(opts); // opts.partition: a private tab's (browser-parity.js)
  tabs.push(view);
  selectTab(view);
  browserAsked = true;
  view.webContents.loadURL(url ? toUrl(url) : homeUrl()).catch(() => {}); // the search engine's page
  return view;
}

// The last tab never closes: the dock does (the window's close button).
// owner: the owner's own close (⌘W, a tab's ×, its menu). A page holding unsaved work asks
// first (browser-parity.js's leave question), and Stay keeps the tab; JARVIS's and the
// agent's closes never wait on a page.
function closeTab(view, { owner = false } = {}) {
  if (tabs.indexOf(view) < 0 || tabs.length < 2) return false;
  const wc = view.webContents;
  if (owner && !wc.isDestroyed()) {
    const url = wc.getURL();
    wc.once('destroyed', () => dropTab(view, url));
    wc.close({ waitForBeforeUnload: true });
    return true;
  }
  return dropTab(view, wc.getURL(), true);
}

function dropTab(view, url, close = false) {
  const at = tabs.indexOf(view);
  if (at < 0) return false; // (already gone: a close asked twice)
  tabs.splice(at, 1);
  if (/^https?:/.test(url) && !view.private) closedTabs.push(url); // a private tab's page isn't kept
  if (closedTabs.length > 25) closedTabs.shift();
  if (view === browserView) { const next = parity.nextDocked(at); if (next) selectTab(next); else newTab(); } // (never one popped out)
  if (close) view.webContents.close();
  sendBrowserState();
  return true;
}

// ── Chrome's everyday features: shortcuts, history, bookmarks, find, the page's menu,
// downloads (always asked first: Jarvis can click in this browser too) ──

// A tab's icon, as data (the window only shows local and data: images). Only an icon's worth
// is ever read: one bigger than FAVICON_MAX, by its Content-Length or as it arrives, is
// dropped there and then, so a page pointing its icon at something huge costs the app
// nothing. '' when there's no icon to show; null when it couldn't be read (stopped, timed
// out, the network), which is tried again next time.
const FAVICON_MAX = 64000;
async function faviconData(ses, url, signal) {
  const stop = new AbortController();
  const quit = () => stop.abort();
  const timer = setTimeout(quit, 5000);
  if (signal) signal.addEventListener('abort', quit, { once: true });
  try {
    const res = await ses.fetch(url, { signal: stop.signal });
    const type = res.headers.get('content-type') || 'image/x-icon';
    const fits = /^image\//.test(type) && !(Number(res.headers.get('content-length')) > FAVICON_MAX);
    if (!res.ok || !fits) {
      quit();
      return res.ok ? '' : null;
    }
    const parts = [];
    let size = 0;
    const reader = res.body ? res.body.getReader() : null;
    for (;;) {
      const { done, value } = reader ? await reader.read() : { done: true };
      if (done) break;
      size += value.byteLength;
      if (size > FAVICON_MAX) {
        quit();
        reader.cancel().catch(() => {});
        return '';
      }
      parts.push(Buffer.from(value));
    }
    return `data:${type.split(';')[0]};base64,${Buffer.concat(parts).toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', quit);
  }
}

// The icons read lately, by profile, so a page swapping between a few (a badge for unread
// mail) reads each once. A private tab's are kept nowhere.
const ICONS_KEPT = 64;
const iconsKept = new WeakMap(); // session -> Map(icon address -> data: URL or ''), the latest used last
async function tabIcon(wc, url, signal) {
  const ses = wc.session;
  let kept = null;
  if (!parity.isPrivate(wc)) {
    kept = iconsKept.get(ses);
    if (!kept) iconsKept.set(ses, (kept = new Map()));
    if (kept.has(url)) {
      const icon = kept.get(url);
      kept.delete(url);
      kept.set(url, icon);
      return icon;
    }
  }
  const icon = await faviconData(ses, url, signal);
  if (icon === null) return '';
  if (kept) {
    kept.set(url, icon);
    if (kept.size > ICONS_KEPT) kept.delete(kept.keys().next().value);
  }
  return icon;
}

function browserShortcut(input) {
  const key = String(input.key || '').toLowerCase();
  const cmd = input.meta, shift = input.shift, alt = input.alt, ctrl = input.control;
  const wc = browserView && browserView.webContents;
  const ui = (action) => { if (win) win.webContents.send('browser:shortcut', action); return true; };
  if (ctrl && key === 'tab') return stepTab(shift ? -1 : 1);
  if (!cmd) return false;
  if (alt && key === 'i') { wc && wc.openDevTools({ mode: 'detach' }); return true; }
  if (alt) return false;
  if (shift) {
    if (key === 't') { reopenTab(); return true; }
    if (key === 'a') return ui('tab-search'); // search the open tabs (browser.js)
    if (key === 'n') return ui('private-tab'); // a new private tab (browser.js)
    if (key === '[' || key === '{') return stepTab(-1);
    if (key === ']' || key === '}') return stepTab(1);
    return false;
  }
  if (key === 't') { newTab(); sendBrowserState(); return ui('address'); }
  if (key === 'w') { if (tabs.length > 1) closeTab(browserView, { owner: true }); else ui('close'); return true; }
  if (key === 'l') return ui('address');
  if (ctrl && key === 'f') return ui('full');
  if (key === 'f') return ui('find');
  if (key === 'd') return ui('bookmark');
  if (key === 'y') return ui('history');
  if (key === 'r' && wc) { wc.reload(); return true; }
  if (key === '[' && wc && wc.navigationHistory.canGoBack()) { wc.navigationHistory.goBack(); return true; }
  if (key === ']' && wc && wc.navigationHistory.canGoForward()) { wc.navigationHistory.goForward(); return true; }
  if (key === 'p' && wc) { wc.print(); return true; }
  if ((key === '=' || key === '+') && wc) return zoomBy(1.1);
  if (key === '-' && wc) return zoomBy(1 / 1.1);
  if (key === '0' && wc) return zoomBy(0);
  if (/^[1-9]$/.test(key)) { selectTab(key === '9' ? tabs[tabs.length - 1] : tabs[Number(key) - 1]); sendBrowserState(); return true; }
  return false;
}

function stepTab(by) {
  const at = tabs.indexOf(browserView);
  if (at >= 0 && tabs.length > 1) { selectTab(tabs[(at + by + tabs.length) % tabs.length]); sendBrowserState(); }
  return true;
}

function reopenTab() {
  const url = closedTabs.pop();
  if (url) { newTab(url); sendBrowserState(); }
}

function zoomBy(factor) {
  const wc = browserView.webContents;
  browserZoom = factor ? Math.min(3, Math.max(0.33, wc.getZoomFactor() * factor)) : 1;
  wc.setZoomFactor(browserZoom);
  parity.zoomed(wc, browserZoom); // kept for the site
  sendBrowserState();
  return true;
}

// History and bookmarks, kept beside the app's other data (never the Research Center's
// sign-in pages: their addresses can carry a reset token).
let browserData = null;
let browserSave = null;
let browserWritten = ''; // the text last written: an unchanged store isn't written again
let browserWriting = Promise.resolve(); // the write under way (they take turns: one .tmp file)
const browserFile = () => path.join(app.getPath('userData'), 'browser.json');
function browserStore() {
  if (browserData) return browserData;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(browserFile(), 'utf8')) || {}; } catch {}
  browserData = {
    history: Array.isArray(raw.history) ? raw.history.filter((h) => h && typeof h.url === 'string').slice(-2000) : [],
    bookmarks: Array.isArray(raw.bookmarks) ? raw.bookmarks.filter((b) => b && typeof b.url === 'string') : [],
    adblock: raw.adblock !== false,
    researchLock: raw.researchLock === true, // Jarvis only on the Research Center (off unless asked)
    allow: Array.isArray(raw.allow) ? raw.allow.filter((h) => typeof h === 'string').slice(0, 500) : [],
  };
  return browserData;
}
// Written off the main thread (a sync write of a long history held up every tab's input and
// IPC while the disk was busy), a moment after the last change.
function saveBrowserStore() {
  clearTimeout(browserSave);
  browserSave = setTimeout(() => {
    let text;
    try { text = JSON.stringify(browserData); } catch { return; }
    if (text === browserWritten) return;
    browserWritten = text;
    const file = browserFile();
    const tmp = `${file}.tmp`;
    browserWriting = browserWriting
      .then(() => fs.promises.writeFile(tmp, text))
      .then(() => fs.promises.rename(tmp, file))
      .catch(() => { if (browserWritten === text) browserWritten = ''; }); // tried again at the next change
  }, 400);
}
// A page a tab went on to by itself (a redirect by script, location.replace, a meta refresh:
// no click or address of the owner's behind it) shares one row of the history with the rest
// of that run, kept up to date and moved last as it goes. A page sending itself somewhere new
// again and again is one row, never thousands pushing the owner's own visits out.
const pagesByItself = new Map(); // webContents id -> the history row its page's own run writes into
function rememberVisit(url, wc) {
  const byItself = parity.wentByItself(wc);
  if (!byItself) pagesByItself.delete(wc.id); // the owner's: a run of the page's own ends
  if (!/^https?:/.test(url) || (onResearch(url) && RESEARCH_AUTH.test(researchPath(url)))) return;
  if (parity.isPrivate(wc)) return; // a private tab's visits are kept nowhere
  const store = browserStore();
  const run = byItself ? pagesByItself.get(wc.id) : null;
  const at = run ? store.history.lastIndexOf(run) : -1;
  if (at >= 0) {
    if (at < store.history.length - 1) { store.history.splice(at, 1); store.history.push(run); }
    run.url = url;
    run.title = wc.getTitle() || '';
    run.at = Date.now();
    saveBrowserStore();
    return;
  }
  const last = store.history[store.history.length - 1];
  if (last && last.url === url) return;
  const row = { url, title: wc.getTitle() || '', at: Date.now() };
  store.history.push(row);
  if (byItself) pagesByItself.set(wc.id, row);
  if (store.history.length > 2000) store.history.splice(0, store.history.length - 2000);
  saveBrowserStore();
}
function retitleVisit(url, title) {
  const store = browserStore();
  const last = store.history[store.history.length - 1];
  if (last && last.url === url && title && last.title !== title) { last.title = title; saveBrowserStore(); }
}

// The page's own menu, as in Chrome. App features add to it (menu(fn): fn(items, view, p)).
const pageMenuExtras = [];
function pageMenu(view, p) {
  const wc = view.webContents;
  const items = [];
  const sep = () => { if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' }); };
  if (p.linkURL && /^https?:/.test(p.linkURL)) {
    items.push({ label: 'Open Link in New Tab', click: () => { newTab(p.linkURL, parity.profileOf(wc)); sendBrowserState(); } }); // (a private tab's link stays private)
    items.push({ label: 'Copy Link Address', click: () => clipboard.writeText(p.linkURL) });
    sep();
  }
  if (p.mediaType === 'image' && p.srcURL) {
    if (/^https?:/.test(p.srcURL)) items.push({ label: 'Open Image in New Tab', click: () => { newTab(p.srcURL, parity.profileOf(wc)); sendBrowserState(); } });
    items.push({ label: 'Save Image As…', click: () => { parity.acted(wc); wc.downloadURL(p.srcURL); } }); // (the user's, however long the menu was up)
    items.push({ label: 'Copy Image', click: () => wc.copyImageAt(p.x, p.y) });
    sep();
  }
  if (p.isEditable) {
    items.push({ role: 'undo', label: 'Undo' }, { role: 'redo', label: 'Redo' }, { type: 'separator' },
      { role: 'cut', label: 'Cut' }, { role: 'copy', label: 'Copy' }, { role: 'paste', label: 'Paste' }, { role: 'selectAll', label: 'Select All' });
    sep();
  } else if (p.selectionText) {
    const text = p.selectionText.trim().slice(0, 60);
    items.push({ role: 'copy', label: 'Copy' });
    items.push({ label: `Search ${searchEngine().name} for “${text}${p.selectionText.trim().length > 60 ? '…' : ''}”`, click: () => { newTab(searchUrl(p.selectionText), parity.profileOf(wc)); sendBrowserState(); } });
    sep();
  }
  if (!p.linkURL && !p.isEditable && !p.selectionText && p.mediaType === 'none') {
    items.push({ label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() });
    items.push({ label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() });
    items.push({ label: 'Reload', click: () => wc.reload() });
    sep();
    items.push({ label: 'Print…', click: () => wc.print() });
    sep();
  }
  for (const extra of pageMenuExtras) {
    try { extra(items, view, p); } catch (err) { console.error('page menu:', err && err.message); }
  }
  sep();
  items.push({ label: 'Inspect', click: () => { wc.inspectElement(p.x, p.y); } });
  Menu.buildFromTemplate(items).popup({ window: parity.windowOf(view) || win }); // a popped-out tab's in its own window
}

// Downloads: each one lands in a private staging folder first, and only the user's Save in
// the window moves it into Downloads (a small file finishes before anyone could pause it,
// so pausing alone isn't enough). Cancel deletes the staged copy.
const downloads = new Map();
let downloadIds = 0;
let downloadsReady = false;
const stagingDir = () => path.join(app.getPath('userData'), 'download-staging');

// Which downloads are staged at all. One the user asked for (a click or key in the page a
// moment ago, JARVIS's own, the page menu's Save Image As…) goes ahead. As in Chrome, a page
// may start one more by itself, and the rest are refused until the user next acts in it or
// goes to another page (Chrome asks about "multiple files" there; a page's own a.click() in a
// loop would otherwise fill the disk with files nobody wanted). However they start, no more
// than DOWNLOADS_WAITING_MAX wait for Save at once.
const DOWNLOADS_WAITING_MAX = 10;
const unaskedDownload = new WeakMap(); // webContents -> the user's last act in it when its page last started one by itself
let downloadNoted = 0;
function mayDownload(item, wc) {
  const page = wc && !wc.isDestroyed() ? wc : null;
  let waiting = 0;
  for (const d of downloads.values()) if (!d.saved && !d.failed) waiting += 1;
  if (waiting >= DOWNLOADS_WAITING_MAX) return refuseDownload(page, 'Downloads are waiting for Save or Cancel. Answer them first, then download again.');
  if (!page || parity.gesture(page) || item.hasUserGesture()) return true;
  const since = parity.lastAct(page);
  if (unaskedDownload.has(page) && unaskedDownload.get(page) === since) {
    return refuseDownload(page, `${hostOf(page.getURL()) || 'The page'} tried to download more files by itself. Click its link to download one.`);
  }
  unaskedDownload.set(page, since);
  return true;
}
// Said in the browser's status line for the tab on show, now and then (a page refused in a
// loop says it once).
function refuseDownload(page, text) {
  const shown = !page || (browserView && page === browserView.webContents);
  if (shown && win && !win.isDestroyed() && Date.now() - downloadNoted > 3000) {
    downloadNoted = Date.now();
    win.webContents.send('browser:note', { text });
  }
  return false;
}

function downloadTarget(name) {
  const dir = app.getPath('downloads');
  const ext = path.extname(name);
  let target = path.join(dir, name);
  for (let n = 1; fs.existsSync(target) && n < 1000; n++) target = path.join(dir, `${path.basename(name, ext)} (${n})${ext}`);
  return target;
}

function sendDownload(id) {
  const d = downloads.get(id);
  if (!d || !win) return;
  const item = d.item;
  const state = d.saved ? (d.finished ? 'completed' : d.failed ? d.failed : 'progressing') : d.failed ? d.failed : 'asking';
  win.webContents.send('browser:download', {
    id, name: d.name, state, received: item.getReceivedBytes(), total: item.getTotalBytes() || item.getReceivedBytes(), from: d.from,
  });
}

function placeDownload(d) {
  try {
    d.path = downloadTarget(d.name);
    fs.renameSync(d.staged, d.path);
    d.finished = true;
  } catch {
    d.failed = 'interrupted';
  }
}

function readyDownloads() {
  if (downloadsReady) return;
  downloadsReady = true;
  fs.rmSync(stagingDir(), { recursive: true, force: true }); // left by a quit mid-download
  const staging = (event, item, wc) => {
    if (!mayDownload(item, wc)) { event.preventDefault(); return; } // refused before a byte is written
    const id = ++downloadIds;
    const name = path.basename(item.getFilename() || 'download').replace(/^\.+/, '') || 'download';
    fs.mkdirSync(stagingDir(), { recursive: true });
    const staged = path.join(stagingDir(), `${id}-${Date.now()}`);
    item.setSavePath(staged);
    let from = '';
    try { from = new URL(item.getURL()).host; } catch {}
    const d = { item, name, staged, from, saved: false, done: false, finished: false, failed: '', path: '' };
    downloads.set(id, d);
    item.on('updated', () => sendDownload(id));
    item.once('done', (_e, state) => {
      d.done = true;
      if (state !== 'completed') { d.failed = state === 'cancelled' ? 'cancelled' : 'interrupted'; fs.rm(staged, { force: true }, () => {}); }
      else if (d.saved) placeDownload(d);
      sendDownload(id);
    });
    sendDownload(id);
  };
  // Every profile's (the owner's, private tabs', JARVIS's own): each download waits for Save.
  for (const partition of parity.partitions()) session.fromPartition(partition).on('will-download', staging);
}

// ── Ad and tracker blocking: Ghostery's engine with EasyList, EasyPrivacy, uBlock Origin's
// filters, privacy, badware, quick fixes and unbreak lists, and the cookie-banner and
// annoyance lists. Requests are blocked here; inside the page, adblock.js runs uBlock's
// scriptlets (which beat in-page ads like YouTube's) before the page's own scripts, hides
// ads before the first paint and as they appear, applies procedural rules, and does it in
// frames too. The compiled engine is cached and rebuilt from fresh lists daily (an old
// copy is kept if the lists can't be fetched). Never on the Research Center, or a site the
// user allowed. ──
const ADBLOCK_DAY = 24 * 60 * 60 * 1000;
let blocker = null;
let adblockReady = false;
const blockedOn = new Map(); // webContents id -> blocked on its current page
let blockedTotal = 0;
let blockedTimer = null;
const adblockFile = () => path.join(app.getPath('userData'), 'adblock-engine.bin');

function shields() {
  const store = browserStore();
  if (typeof store.adblock !== 'boolean') store.adblock = true;
  if (!Array.isArray(store.allow)) store.allow = [];
  return store;
}
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }
function shielded(pageUrl) {
  const s = shields();
  return Boolean(blocker) && s.adblock && /^https?:/.test(pageUrl || '') && !onResearch(pageUrl) && !s.allow.includes(hostOf(pageUrl));
}
function pageOf(details) {
  if (details.resourceType === 'mainFrame') return details.url;
  try { if (details.webContents && !details.webContents.isDestroyed()) return details.webContents.getURL(); } catch {}
  return details.referrer || '';
}
// Some players retry a blocked ad request in a tight loop (CNN's, thousands a second). The
// same request blocked again and again on a tab gets its refusal 2 s late: the loop crawls
// instead of spinning the CPU, and it counts once.
const repeats = new Map();
function retrying(details) {
  const id = details.webContents && !details.webContents.isDestroyed() ? details.webContents.id : 0;
  const key = `${id}|${details.url.split('?')[0]}`;
  const now = Date.now();
  let seen = repeats.get(key);
  if (!seen || now - seen.since > 3000) {
    seen = { n: 0, since: now };
    repeats.set(key, seen);
    if (repeats.size > 5000) repeats.clear();
  }
  seen.n += 1;
  return seen.n > 5;
}
function countBlocked(details) {
  blockedTotal += 1;
  const id = details.webContents && !details.webContents.isDestroyed() ? details.webContents.id : 0;
  if (id) blockedOn.set(id, (blockedOn.get(id) || 0) + 1);
  if (!blockedTimer) blockedTimer = setTimeout(() => { blockedTimer = null; sendBrowserState(); }, 400);
}

async function buildBlocker() {
  const { ElectronBlocker, fullLists } = require('@ghostery/adblocker-electron');
  const file = adblockFile();
  const cached = () => { try { return ElectronBlocker.deserialize(new Uint8Array(fs.readFileSync(file))); } catch { return null; } };
  let age = Infinity;
  try { age = Date.now() - fs.statSync(file).mtimeMs; } catch {}
  if (age < ADBLOCK_DAY) { const engine = cached(); if (engine) return engine; }
  try {
    const engine = await ElectronBlocker.fromLists(fetch, fullLists, {
      enableCompression: true, loadExtendedSelectors: true, guessRequestTypeFromUrl: true,
    });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, engine.serialize());
    fs.renameSync(tmp, file);
    return engine;
  } catch (err) {
    console.error('adblock: lists unavailable, using the last copy', err && err.message);
    return cached();
  }
}

function readyAdblock() {
  if (adblockReady) return;
  adblockReady = true;
  const ses = session.fromPartition('persist:jarvis-browser');
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    if (!shielded(pageOf(details))) { callback({}); return; }
    blocker.onBeforeRequest(details, (response) => {
      if (!(response && (response.cancel || response.redirectURL))) { callback(response); return; }
      if (retrying(details)) { setTimeout(() => callback(response), 2000); return; } // a retry loop, slowed
      countBlocked(details);
      callback(response);
    });
  });
  // Only a page's or a frame's own headers are ever changed here (their CSP, for $csp filters):
  // the engine answers every other response with no change, so a page's pictures, scripts and
  // the rest don't wait for this thread on their way in (tests/web/adblock-network.test.mjs).
  ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'], types: ['mainFrame', 'subFrame'] }, (details, callback) => {
    if (!shielded(pageOf(details))) { callback({}); return; }
    blocker.onHeadersReceived(details, callback);
  });
  // Inside the page (every frame, before its scripts): adblock.js.
  require('./adblock').attach(ses, { engine: () => blocker, shielded });
  const refresh = async () => {
    const engine = await buildBlocker();
    if (engine) { blocker = engine; sendBrowserState(); }
  };
  refresh();
  setInterval(refresh, ADBLOCK_DAY).unref();
}

function tabById(id) { return tabs.find((view) => view.webContents.id === Number(id)); }

function createTab(opts = {}) {
  const view = new WebContentsView({
    webPreferences: {
      partition: opts.partition || 'persist:jarvis-browser', // or a private tab's, or JARVIS's signed-out one (browser-parity.js)
      disableBlinkFeatures: 'WebBluetooth', // a page asking for a device would have macOS ask about Bluetooth
      plugins: true, // Chromium's PDF viewer
      preload: path.join(__dirname, 'page-preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Preloads run in frames too (still sandboxed, still no Node): the ad blocker's
      // reaches ads inside them; page-preload.js acts in the top frame only.
      nodeIntegrationInSubFrames: true,
    },
  });
  const wc = view.webContents;
  const active = () => view === browserView;
  wc.setWindowOpenHandler((details) => {
    const popup = parity.windowOpen(wc, details); // a sign-in or payment popup: a real window (browser-parity.js)
    if (popup) return popup;
    const { url } = details;
    if (!/^https?:\/\//.test(url)) return { action: 'deny' };
    // a link that wants a new window, clicked a moment ago (by the user, or JARVIS) on a page
    // on show (the tab on show, one beside it or in a window of its own, a private tab): a new
    // tab in front, in the page's profile, one per click. Anything else (a tab behind's link, a
    // page opening windows by itself as it loads) is a tab behind, and none past
    // browser-agent.js's TABS_MAX: a page opening one more as each loads would otherwise open
    // tabs without end, each the tab on show.
    const shown = view === browserView || view.private || parity.shownElsewhere(view);
    if (shown && parity.gesture(wc, { spend: true })) newTab(url, parity.profileOf(wc));
    else browserAgent.popup(view, url, parity.profileOf(wc) || {});
    return { action: 'deny' };
  });
  parity.wireTab(view); // per-site permission prompts (browser-parity.js)
  // On the Research Center, direct input never reaches the page (Jarvis's own does).
  wc.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && win && !agentInput) win.webContents.send('browser:escape');
    // Chrome's shortcuts work with the page focused too (they're the browser's, not the page's).
    if (input.type === 'keyDown' && !browserSynthetic && !agentInput && !parity.poppedOut(view) && browserShortcut(input)) { event.preventDefault(); return; }
    if (active() && browserLocked && !browserSynthetic) event.preventDefault();
  });
  // The window only shows local and data: images, so the icon comes over as data. One read
  // at a time per tab: a newer icon stops the one on its way, and only the latest is shown
  // (an older, slower one never lands over it).
  wc.on('page-favicon-updated', async (_event, icons) => {
    const url = (icons || []).find((u) => /^(https?:|data:image\/)/.test(u));
    if (!url || (url === view.faviconWant && view.faviconStop)) return; // (that one's on its way)
    if (view.faviconStop) view.faviconStop.abort();
    view.faviconStop = null;
    view.faviconWant = url;
    let icon = url.slice(0, 90000);
    if (!url.startsWith('data:')) {
      const stop = new AbortController();
      view.faviconStop = stop;
      icon = await tabIcon(wc, url, stop.signal);
      if (stop.signal.aborted) return; // a newer icon, or the tab closed
      view.faviconStop = null;
    }
    view.favicon = icon;
    sendBrowserState();
  });
  wc.on('did-navigate', (_event, url) => { blockedOn.set(wc.id, 0); rememberVisit(url, wc); tellLockable(wc); });
  const id = wc.id;
  wc.once('destroyed', () => { // a closed tab's count, icon read and own run of pages go with it
    blockedOn.delete(id);
    if (view.faviconStop) view.faviconStop.abort();
    pagesByItself.delete(id);
  });
  wc.on('page-title-updated', () => retitleVisit(wc.getURL(), wc.getTitle()));
  wc.on('enter-html-full-screen', () => { if (active() && win) win.webContents.send('browser:page-fullscreen', true); });
  wc.on('leave-html-full-screen', () => { if (win) win.webContents.send('browser:page-fullscreen', false); });
  wc.on('context-menu', (_event, params) => { if (!(active() && browserLocked)) pageMenu(view, params); });
  wc.on('before-mouse-event', (event) => { if (active() && browserLocked && !browserSynthetic) event.preventDefault(); });
  for (const event of ['did-navigate', 'did-navigate-in-page']) wc.on(event, () => (active() ? updateLock() : sendBrowserState()));
  wc.on('did-finish-load', () => wc.setZoomFactor(parity.zoomFor(wc))); // the site's own zoom
  for (const event of ['page-title-updated', 'did-start-loading', 'did-stop-loading']) wc.on(event, () => sendBrowserState());
  wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && active() && !isCertError(code)) { // a certificate's: browser-parity.js warns
      const where = onResearch(url) || (researchBase && url.startsWith(researchBase)) ? `The Research Center at ${researchOrigin()}` : url || 'The page';
      sendBrowserState({ error: `${where} isn't answering (${description}).` });
    }
  });
  wc.on('render-process-gone', () => (active() ? sendBrowserState({ error: 'The page stopped. Reload it.' }) : sendBrowserState()));
  return view;
}

function waitForLoad(wc, ms = 20000) {
  return new Promise((resolve) => {
    if (!wc.isLoading()) return setTimeout(resolve, 300);
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, ms);
    wc.once('did-stop-loading', done);
  });
}

function focusScript(target) {
  return `(() => {
    const t = ${JSON.stringify(target)};
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    let el = null;
    if (t.selector) { try { el = document.querySelector(t.selector); } catch (e) {} }
    if (!el && t.field) {
      const want = t.field.toLowerCase();
      // its words as the page read gives them to the purchase guard: its labels, placeholder, name and id
      const text = (id) => { const n = document.getElementById(id); return n ? n.innerText : ''; };
      const words = (e) => [(e.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(text).join(' '),
        e.getAttribute('aria-label'), e.labels ? [...e.labels].map((l) => l.innerText).join(' ') : '', e.title,
        e.placeholder, e.name, e.id].filter(Boolean).join(' ').toLowerCase();
      el = [...document.querySelectorAll('input, textarea, [contenteditable=true]')].filter(visible)
        .find((e) => words(e).includes(want));
    }
    if (!el && document.activeElement && document.activeElement !== document.body) el = document.activeElement;
    if (!el) el = [...document.querySelectorAll('input[type=text], input[type=search], input:not([type]), textarea')].find(visible);
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    if ('value' in el && t.replace) el.value = '';
    return true;
  })()`;
}

function browserInput(fn, view = browserView) {
  browserSynthetic = true;
  try { fn(view.webContents); } finally { browserSynthetic = false; }
}

function clickAt(x, y, view = browserView) {
  browserInput((wc) => {
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  }, view);
}

function pageCall(action, args = {}, ms = 6000, view = browserView) {
  return new Promise((resolve) => {
    const id = crypto.randomBytes(6).toString('hex');
    const timer = setTimeout(() => {
      pageCalls.delete(id);
      resolve({ ok: false, message: 'The page did not answer.' });
    }, ms);
    pageCalls.set(id, (result) => { clearTimeout(timer); resolve(result || {}); });
    view.webContents.send('jarvis:command', { id, action, args });
  });
}

// The Research Center: the app's own router moves within it; a first visit loads it.
async function researchOpen(pathname) {
  ensureBrowser();
  // Its own tab: the one it's already on, else a new one (never over the page you're reading).
  if (!onResearch(browserView.webContents.getURL())) {
    const open = tabs.find((view) => onResearch(view.webContents.getURL()));
    if (open) selectTab(open);
    else if (browserView.webContents.getURL() || browserView.webContents.isLoading()) {
      const view = createTab();
      tabs.push(view);
      selectTab(view);
    }
  }
  const wc = browserView.webContents;
  const target = `${researchBase.replace(/\/+$/, '')}${typeof pathname === 'string' && pathname.startsWith('/') ? pathname : '/markets'}`;
  browserAsked = true;
  if (onResearch(wc.getURL()) && !wc.isLoading()) {
    const moved = await pageCall('navigate', { path: new URL(target).pathname }, 3000);
    if (moved.ok) return;
  }
  await wc.loadURL(target).catch(() => {});
}

const fromPage = (event) => browserView && event.sender === browserView.webContents;
const fromWindow = (event) => win && event.sender === win.webContents;
const fromTab = (event) => tabs.some((view) => event.sender === view.webContents); // any tab's answer

ipcMain.on('page:result', (event, message) => {
  if (!fromTab(event) || !message) return;
  const done = pageCalls.get(message.id);
  if (done) {
    pageCalls.delete(message.id);
    done(message.result);
  }
});
ipcMain.on('page:hover', (event, hover) => { if (fromPage(event)) win.webContents.send('browser:hover', hover); });
// A tab's page asking alert, confirm or prompt while the browser agent acts in it (page-preload.js).
ipcMain.on('page:dialog', (event, dialogArgs) => {
  if (!fromTab(event)) { event.returnValue = null; return; }
  browserAgent.onPageDialog(event, dialogArgs);
});
ipcMain.on('page:note', (event, note) => { if (fromPage(event)) win.webContents.send('browser:note', note); });
ipcMain.on('page:pointer', (event, p) => {
  if (!fromPage(event) || !p) return;
  browserInput((wc) => wc.sendInputEvent({ type: 'mouseMove', x: Number(p.x) || 0, y: Number(p.y) || 0 }));
});
ipcMain.on('page:click', (event, p) => {
  if (fromPage(event) && p) clickAt(Number(p.x) || 0, Number(p.y) || 0);
});

// JARVIS's and Eden Code's hands over the DevTools protocol: snapshots with element refs,
// actions by ref, waits (browser-agent.js). It works on any tab, the one on show or not.
const browserAgent = createAgent({
  tabs: () => tabs,
  ensureBrowser,
  isShown: (view) => Boolean(view && view === browserView && browserShown),
  setSynthetic: (on) => { agentInput = on; },
  addTab: ({ select, owner, profile }) => {
    // a popup's: its opener's profile; else JARVIS's own, when it browses signed out
    const view = createTab(profile || parity.agentTab(owner));
    view.agentOwner = owner || ''; // who opened it: 'jarvis', 'code:<session>'
    tabs.push(view);
    view.setBounds(lastBounds || { x: 0, y: 0, width: 1280, height: 800 }); // its page lays out at the dock's size
    if (select) selectTab(view);
    sendBrowserState();
    return view;
  },
  blankTab: () => (browserView && !browserView.webContents.getURL() && !browserView.webContents.isLoading() ? browserView : null),
  select: (view) => { selectTab(view); sendBrowserState(); },
  close: (view) => closeTab(view),
  showBrowser: () => { if (win && !win.isDestroyed()) win.webContents.send('browser:open'); },
  markAsked: () => { browserAsked = true; },
  toUrl,
  research: (view) => onResearch(view.webContents.getURL()),
  // The page's own-command channel (page-preload.js), for a tab.
  pageCall: (view, action, args, ms) => pageCall(action, args, ms, view),
  // Files only the user picks, in the Mac's own open panel, for an upload the agent started.
  pickFiles: async ({ multiple, title }) => {
    const options = { title, buttonLabel: 'Upload', properties: ['openFile', ...(multiple ? ['multiSelections'] : [])] };
    const result = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths.slice(0, 20);
  },
  // A page's question the agent didn't answer in time: the user answers it in the Mac's box.
  askUser: ({ type, message, host, signal }) => {
    const options = {
      type: type === 'confirm' ? 'question' : 'info', message: message || ' ', detail: host ? `From ${host}` : '',
      buttons: type === 'confirm' ? ['OK', 'Cancel'] : ['OK'], defaultId: 0, cancelId: type === 'confirm' ? 1 : 0, signal,
    };
    const asked = win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
    return asked.then((r) => r.response === 0);
  },
});

// Chrome's everyday behaviour beside the tabs (browser-parity.js): per-site permissions and
// their prompt, sign-in and payment popups, the leave-page question, HTTP sign-in, certificate
// warnings, the user agent, Settings › Browser.
const parity = createParity({
  window: () => (win && !win.isDestroyed() ? win : null),
  tabs: () => tabs,
  active: () => browserView,
  send: (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); },
  fromWindow,
  dev: Boolean(DEV_URL),
  // A popup's link for a new window, or a new private tab: a tab in the dock.
  openTab: (url, opts) => { ensureBrowser(); newTab(url, opts); sendBrowserState(); if (win && !win.isDestroyed()) win.webContents.send('browser:open'); },
  // One a popup opens by itself: a tab behind the one on show, kept to TABS_MAX as a tab's are.
  openTabBehind: (url, opts) => { ensureBrowser(); browserAgent.popup({}, url, opts || {}); },
  // The tabs put back from last time: each an empty tab its page is loaded into.
  restoreTab: () => { const view = createTab(); tabs.push(view); browserAsked = true; return view; },
  select: (view) => { selectTab(view); sendBrowserState(); },
  closeTab: (view) => closeTab(view, { owner: true }), // (the tab's menu: the owner's)
  changed: () => sendBrowserState(),
  // Never kept for next time: the Research Center's sign-in pages (their addresses can carry a reset token).
  keep: (url) => !(onResearch(url) && RESEARCH_AUTH.test(researchPath(url))),
  browserData: () => browserStore(), // history and bookmarks: the address bar's suggestions, folders, imports
  saveBrowserData: () => saveBrowserStore(),
  isResearch: (view) => onResearch(view.webContents.getURL()), // it stays in the dock (only JARVIS drives it)
});

async function runBrowserCommand({ action, args = {} }) {
  if (browserAgent.handles(action)) return browserAgent.run(action, args);
  let view;
  try { view = browserAgent.target(args); } catch (err) { return { ok: false, message: err.message }; } // args.tab, else the tab on show
  const waiting = browserAgent.waiting(view); // a page waiting on its dialog answers nothing else
  if (waiting) return waiting;
  const wc = view.webContents;
  const where = () => ({ url: wc.getURL(), title: wc.getTitle(), tab: wc.id });
  const signIn = onResearch(wc.getURL()) && RESEARCH_AUTH.test(researchPath(wc.getURL()));
  const lockedHere = onResearch(wc.getURL()) && !signIn;
  if (signIn && ['click', 'type', 'search'].includes(action)) {
    return { error: 'The Research Center is on its sign-in page. The user signs in themselves; after that I can drive it.' };
  }
  switch (action) {
    case 'research':
      win.webContents.send('browser:open');
      if (/^https?:\/\//.test(String(args.base || '')) && args.base !== researchBase) {
        researchBase = args.base;
        for (const view of tabs) tellLockable(view.webContents); // before any lock on its pages
      }
      if (!researchBase) return { error: 'No Research Center address is set.' };
      await researchOpen(String(args.path || '/markets')); // (may switch to the tab it's on)
      await waitForLoad(browserView.webContents, 15000);
      return { ok: true, url: browserView.webContents.getURL(), title: browserView.webContents.getTitle() };
    case 'back':
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      await waitForLoad(wc);
      return { ok: true, ...where() };
    case 'forward':
      if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
      await waitForLoad(wc);
      return { ok: true, ...where() };
    case 'read': {
      if (!wc.getURL()) return { error: 'The browser is empty. Open a page first.' };
      const pdf = await parity.pdfRead(view, args); // a PDF on show: the file, for the backend to read (browser-parity.js)
      if (pdf) return { ...pdf, locked: lockedHere };
      // rich: dialogs, banners and sidebars too, real field labels and values, read on from offset
      return { ...(await pageCall('read', { rich: Boolean(args.rich), offset: Number(args.offset) || 0, limit: Number(args.limit) || 0 }, 6000, view)), locked: lockedHere, tab: wc.id };
    }
    case 'click': {
      const found = await pageCall('locate', { text: String(args.text || ''), selector: String(args.selector || '') }, 6000, view);
      if (!found.ok) return found;
      if (found.risky && !args.force) {
        return { ok: false, needsConfirm: true, label: found.label, message: `“${found.label}” needs the user's OK first.`, ...where() };
      }
      // behind other tabs or apps, the press goes in over the DevTools protocol
      if (!(await browserAgent.pressHidden(view, { x: found.x, y: found.y }).catch(() => false))) clickAt(found.x, found.y, view);
      await waitForLoad(wc, 8000);
      return { ok: true, message: `Clicked “${found.label}”`, ...where() };
    }
    case 'type': {
      const focused = await wc.executeJavaScript(focusScript({ selector: args.selector || '', field: args.field || '', replace: true }));
      if (!focused) return { ok: false, message: 'No text field to type into.' };
      await wc.insertText(String(args.text || ''));
      if (args.submit) {
        if (!(await browserAgent.pressHidden(view, { key: 'Enter' }).catch(() => false))) {
          browserInput((view2) => {
            view2.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
            view2.sendInputEvent({ type: 'char', keyCode: '\r' });
            view2.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
          }, view);
        }
        await waitForLoad(wc, 10000);
      }
      return { ok: true, ...where() };
    }
    case 'search': {
      const query = String(args.query || '').slice(0, 80);
      let done = await pageCall('search', { query });
      if (!done.ok && researchBase) {
        await researchOpen('/market-radar'); // the Research Center's market desk has the search box
        await waitForLoad(browserView.webContents, 15000);
        await sleep(700);
        done = await pageCall('search', { query });
      }
      if (!done.ok) return done;
      await waitForLoad(browserView.webContents, 8000);
      return { ok: true, message: `Searched for ${query}`, url: browserView.webContents.getURL(), title: browserView.webContents.getTitle() };
    }
    case 'scroll': {
      const direction = args.direction || (Number(args.amount) < 0 ? 'up' : 'down');
      const amount = Math.abs(Number(args.amount || 1)) || 1;
      return { ...(await pageCall('scroll', { direction, amount }, 6000, view)), ...where() };
    }
    case 'zoom': {
      const now = wc.getZoomFactor();
      const next = args.direction === 'in' ? now * 1.15 : args.direction === 'out' ? now / 1.15 : 1;
      browserZoom = Math.min(1.8, Math.max(0.6, next));
      wc.setZoomFactor(browserZoom);
      parity.zoomed(wc, browserZoom); // kept for the site
      sendBrowserState();
      return { ok: true, zoom: Math.round(browserZoom * 100) };
    }
    case 'pointed': { // Eden Code's point and speak: what the hand is on, and a picture of it
      if (!wc.getURL()) return { ok: false, message: 'The browser is empty.' };
      const found = await pageCall('pointed');
      if (!found.ok || !found.box) return found;
      const z = wc.getZoomFactor();
      const shown = view.getBounds();
      const pad = 12;
      const x = Math.min(Math.max(0, Math.floor((found.box.x - pad) * z)), Math.max(0, shown.width - 1));
      const y = Math.min(Math.max(0, Math.floor((found.box.y - pad) * z)), Math.max(0, shown.height - 1));
      const width = Math.max(1, Math.min(shown.width - x, Math.ceil((found.box.width + pad * 2) * z)));
      const height = Math.max(1, Math.min(shown.height - y, Math.ceil((found.box.height + pad * 2) * z)));
      const image = await wc.capturePage({ x, y, width, height });
      const scaled = image.getSize().width > 800 ? image.resize({ width: 800 }) : image;
      return { ...found, ...where(), png: image.isEmpty() ? '' : scaled.toPNG().toString('base64') };
    }
    default:
      return { error: `Unknown browser action ${action}` };
  }
}

// The slot's place in the window's CSS pixels, as the view's bounds: the same unless the
// window's page is zoomed.
function fitBounds(b, host = win) {
  const z = host && !host.isDestroyed() ? host.webContents.getZoomFactor() || 1 : 1;
  const x = Math.round(b.x * z);
  const y = Math.round(b.y * z);
  return { x, y, width: Math.max(0, Math.round((b.x + b.width) * z) - x), height: Math.max(0, Math.round((b.y + b.height) * z) - y) };
}

ipcMain.handle('browser:show', (event, bounds) => {
  if (!fromWindow(event)) return;
  mainWants = true;
  mainBounds = bounds;
  if (dockWin) undock(dockWin, { back: false }); // Jarvis's window takes it back
  const view = ensureBrowser();
  if (!browserShown) {
    win.contentView.addChildView(view);
    browserShown = true;
  }
  lastBounds = fitBounds(bounds);
  view.setBounds(lastBounds);
  // The start page only for an empty view: a page asked for a moment ago (the hosted Research
  // Center takes a network round trip) has no address yet, and would be replaced by it.
  if (!view.webContents.getURL() && !view.webContents.isLoading() && !browserAsked) view.webContents.loadURL(homeUrl());
  sendBrowserState();
});
ipcMain.handle('browser:hide', (event) => {
  if (!fromWindow(event)) return;
  mainWants = false;
  if (dockWin) return; // it's in the Ask Eden window just now
  if (browserView && browserShown) {
    win.contentView.removeChildView(browserView);
    browserShown = false;
  }
});
ipcMain.handle('browser:bounds', (event, bounds) => {
  if (!fromWindow(event)) return;
  mainBounds = bounds;
  if (dockWin) return;
  lastBounds = fitBounds(bounds);
  if (browserView && browserShown) browserView.setBounds(lastBounds);
});
ipcMain.handle('browser:nav', async (event, { action, url }) => {
  if (!fromWindow(event)) return;
  const wc = ensureBrowser().webContents;
  if (action === 'go') { browserAsked = true; wc.loadURL(toUrl(url, { typed: true })).catch(() => {}); }
  if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  if (action === 'reload') wc.reload();
  if (action === 'stop') wc.stop();
});
ipcMain.handle('browser:find', async (event, { text, forward = true, stop = false } = {}) => {
  if (!fromWindow(event) || !browserView) return;
  // In the page (page-preload.js): it answers whether or not the window has the focus.
  const r = await pageCall('find', { text: String(text || ''), forward, stop: stop || !text }, 3000);
  if (win && !stop && text) win.webContents.send('browser:found', { matches: r.matches || 0, active: r.active || 0 });
  return r;
});
ipcMain.handle('browser:research-lock', (event, on) => {
  if (!fromWindow(event)) return false;
  return setResearchLock(on);
});
ipcMain.handle('browser:shields', (event, { action } = {}) => {
  if (!fromWindow(event) || !browserView) return;
  const guard = shields();
  const host = hostOf(browserView.webContents.getURL());
  if (action === 'site' && host) {
    guard.allow = guard.allow.includes(host) ? guard.allow.filter((h) => h !== host) : [...guard.allow, host];
    browserView.webContents.reload();
  }
  if (action === 'toggle') { guard.adblock = !guard.adblock; browserView.webContents.reload(); }
  saveBrowserStore();
  sendBrowserState();
});
ipcMain.handle('browser:data', (event, { action, url, title } = {}) => {
  if (!fromWindow(event)) return null;
  const store = browserStore();
  if (action === 'bookmark' && /^https?:/.test(String(url || ''))) {
    const at = store.bookmarks.findIndex((b) => b.url === url);
    if (at >= 0) store.bookmarks.splice(at, 1);
    else store.bookmarks.push({ url, title: String(title || url).slice(0, 200) });
    saveBrowserStore();
  }
  if (action === 'clear-history') { store.history = []; saveBrowserStore(); }
  return { bookmarks: store.bookmarks.slice(), history: store.history.slice(-400).reverse() };
});
ipcMain.handle('browser:download', (event, { id, action } = {}) => {
  if (!fromWindow(event)) return;
  const d = downloads.get(Number(id));
  if (!d) return;
  if (action === 'save' && !d.saved && !d.failed) {
    d.saved = true;
    if (d.done) placeDownload(d); // it had already finished into staging
    sendDownload(Number(id));
  }
  if (action === 'cancel') {
    if (!d.done) d.item.cancel();
    fs.rm(d.staged, { force: true }, () => {});
    downloads.delete(Number(id));
  }
  if (action === 'show' && d.finished) shell.showItemInFolder(d.path);
});
ipcMain.handle('browser:shortcut', (event, action) => {
  if (!fromWindow(event)) return false;
  ensureBrowser();
  if (action === 'reopen') { reopenTab(); return true; }
  if (action === 'next') return stepTab(1);
  if (action === 'previous') return stepTab(-1);
  if (action === 'zoom-in') return zoomBy(1.1);
  if (action === 'zoom-out') return zoomBy(1 / 1.1);
  if (action === 'zoom-reset') return zoomBy(0);
  if (action === 'print') { browserView.webContents.print(); return true; }
  if (action === 'devtools') { browserView.webContents.openDevTools({ mode: 'detach' }); return true; }
  if (/^tab[1-9]$/.test(String(action))) { const n = Number(action.slice(3)); selectTab(n === 9 ? tabs[tabs.length - 1] : tabs[n - 1]); sendBrowserState(); return true; }
  return false;
});
ipcMain.handle('browser:tab', (event, { action, id, url } = {}) => {
  if (!fromWindow(event)) return;
  ensureBrowser();
  if (action === 'new') newTab(url);
  if (action === 'select') selectTab(tabById(id));
  if (action === 'close') closeTab(tabById(id) || browserView, { owner: true });
  sendBrowserState();
});
ipcMain.handle('browser:command', async (event, command) => {
  if (!fromWindow(event)) return { error: 'not allowed' };
  try {
    return await runBrowserCommand(command || {});
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) };
  }
});
ipcMain.on('browser:hand', (event, message) => {
  if (!fromWindow(event) || !browserView || !browserShown || !message) return;
  if (message.t === 'zoom') {
    const wc = browserView.webContents;
    browserZoom = Math.min(1.8, Math.max(0.6, wc.getZoomFactor() * (Number(message.f) || 1)));
    wc.setZoomFactor(browserZoom);
    parity.zoomed(wc, browserZoom); // kept for the site
    sendBrowserState();
    return;
  }
  browserView.webContents.send('jarvis:hand', message);
});

// Invoices and other documents: an offscreen, script-free page printed to PDF.
ipcMain.handle('jarvis:pdf', async (event, page) => {
  if (!win || event.sender !== win.webContents || typeof page !== 'string' || page.length > 2_000_000) return '';
  const paper = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false, offscreen: true } });
  try {
    await paper.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
    const pdf = await paper.webContents.printToPDF({ pageSize: 'Letter', printBackground: true, margins: { marginType: 'none' } });
    return pdf.toString('base64');
  } catch (err) {
    console.warn('pdf failed', err);
    return '';
  } finally {
    paper.destroy();
  }
});

ipcMain.on('jarvis:attention', () => {
  if (win && !win.isFocused()) app.dock?.bounce('informational');
});

// ── the dock in another window: the Ask Eden window's browser panel (features/eden-window.js) ──
// The same tabs, adblock and gates as in Jarvis's window: only where the tab on show is drawn
// changes. That window's page draws the address bar and buttons around it.
function dockIn(host, bounds) {
  if (!host || host.isDestroyed()) return;
  const view = ensureBrowser();
  if (browserShown && dockHost() !== host) dockHost().contentView.removeChildView(view);
  if (!browserShown || dockWin !== host) {
    dockWin = host === win ? null : host;
    host.contentView.addChildView(view);
    browserShown = true;
  }
  lastBounds = fitBounds(bounds, host);
  view.setBounds(lastBounds);
  if (!view.webContents.getURL() && !view.webContents.isLoading() && !browserAsked) view.webContents.loadURL(homeUrl());
  sendBrowserState();
}
// Out of that window; back in Jarvis's when its own dock was open there (back: true).
function undock(host, { back = true } = {}) {
  if (!dockWin || dockWin !== host) return;
  if (browserView && browserShown && !host.isDestroyed()) host.contentView.removeChildView(browserView);
  browserShown = false;
  dockWin = null;
  if (back && mainWants && mainBounds && win && !win.isDestroyed()) {
    win.contentView.addChildView(ensureBrowser());
    browserShown = true;
    lastBounds = fitBounds(mainBounds);
    browserView.setBounds(lastBounds);
    sendBrowserState();
  }
}
const browserDock = {
  show: (host, bounds) => dockIn(host, bounds),
  hide: (host) => undock(host),
  bounds: (host, bounds) => {
    if (dockWin !== host || !browserView || !browserShown) return;
    lastBounds = fitBounds(bounds, host);
    browserView.setBounds(lastBounds);
  },
  nav: (action, url) => {
    const wc = ensureBrowser().webContents;
    if (action === 'go' && url) { browserAsked = true; wc.loadURL(toUrl(String(url).slice(0, 2000))).catch(() => {}); }
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    if (action === 'reload') wc.reload();
    if (action === 'stop') wc.stop();
  },
  tab: (action, id) => {
    ensureBrowser();
    if (action === 'new') newTab();
    if (action === 'select') selectTab(tabById(id));
    if (action === 'close') closeTab(tabById(id) || browserView, { owner: true });
    sendBrowserState();
  },
  shields: () => {
    if (!browserView) return;
    const guard = shields();
    guard.adblock = !guard.adblock;
    browserView.webContents.reload();
    saveBrowserStore();
    sendBrowserState();
  },
  state: () => { if (browserView) sendBrowserState(); },
};

// ── feature modules for the app itself: app/features/*.js, each exporting install(ctx), in
// name order. A feature adds its own IPC ('feature:<name>:…', which preload.js passes
// through for the window), menus or windows; one that throws is logged and skipped. ──
const featureContext = {
  app,
  ipcMain,
  getWindow: () => win,
  send: (channel, ...args) => { if (win && !win.isDestroyed()) win.webContents.send(channel, ...args); },
  fromWindow: (event) => Boolean(win && !win.isDestroyed() && event && event.sender === win.webContents),
  dev: Boolean(DEV_URL),
  flavor: FLAVOR, // which app this is (flavor.js): J.A.R.V.I.S. or Eden Code
  sharedFrom: () => sharedFrom, // the app whose backend the window is on, when not this one's
  logDir: LOG_DIR,
  summon: () => summon(), // ⌥Space's show-and-listen (app/features/shell.js: the menu bar's Ask…)
  ownsShortcuts: false, // set by a feature that registers the global shortcuts itself (shell.js: the user's)
  onOpenUrl: (fn) => { openLink = fn; earlyLinks.splice(0).forEach((url) => fn(url)); }, // jarvis:// links
  backend: () => backend, // the running `jarvis serve` (shell.js waits for it to stop when quitting)
  backendBusy, // whether a restart now would cut something off (updates.js, follow-repo.js)
  relaunchAsItWas, // before a quiet update: reopen hidden if the window is hidden
  backendFromRepo: () => backendFromRepo,
  restartBackendQuietly,
  repoHome: () => jarvisHome(),
  extraPath: EXTRA_PATH,
  // The built-in browser's tabs, for features that work with them (browser-ai.js): the
  // tabs, the one on show while the dock is open, and the page's own menu.
  browser: {
    partition: 'persist:jarvis-browser',
    partitions: () => parity.partitions(), // every profile a tab can be in: the owner's, private, JARVIS's own
    tabs: () => tabs.slice(),
    shown: () => (browserShown && browserView ? browserView : null),
    byId: (id) => tabById(id) || null,
    focused: () => Boolean(win && !win.isDestroyed() && win.isFocused()),
    menu: (fn) => { pageMenuExtras.push(fn); },
  },
  browserDock, // the dock in the Ask Eden window (eden-window.js)
};
function loadAppFeatures() {
  const dir = path.join(__dirname, 'features');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort(); } catch { return; }
  if (FLAVOR.features) files = files.filter((f) => FLAVOR.features.has(f)); // Eden Code: its own only
  for (const file of files) {
    try {
      const feature = require(path.join(dir, file));
      if (feature && typeof feature.install === 'function') feature.install(featureContext);
    } catch (err) {
      console.error(`app feature ${file} didn't load: ${err && err.message}`);
    }
  }
}

app.whenReady().then(async () => {
  if (!gotLock) return; // quitting: the Jarvis already running has been brought forward
  trace.write('ready: opening the window');
  createWindow();
  loadAppFeatures();
  if (DEV_URL) {
    port = Number(new URL(DEV_URL).port);
    win.loadURL(DEV_URL);
    return;
  }
  await askForMicrophone();
  if (EDEN_CODE && app.dock) {
    const icon = path.join(__dirname, 'build', 'eden-code', 'icon-1024.png');
    if (fs.existsSync(icon)) app.dock.setIcon(icon); // run from J.A.R.V.I.S.'s bundle (eden-code.js), still Eden's icon
  }
  await openOnBackend();
  if (EDEN_CODE) return; // Eden Code takes no global shortcuts: ⌥Space is Jarvis's
  if (featureContext.ownsShortcuts) return; // app/features/shell.js registered the ones chosen in Settings
  if (!globalShortcut.register(SHORTCUT, summon)) {
    console.warn(`${SHORTCUT} is taken by another app; use the Dock icon instead.`);
  }
  // Deliberately doesn't bring the window forward: Jarvis needs to see what you're
  // looking at, and answers out loud.
  if (!globalShortcut.register(WHATS_THIS, () => win && win.webContents.send('jarvis:whats-this'))) {
    console.warn(`${WHATS_THIS} is taken by another app.`);
  }
});

app.on('activate', () => win && win.show());
// ── Hands steering the whole Mac: a small always-on-top indicator (never focused, clicks go
// through it), and the window keeps getting camera frames while it's behind other apps ──
let hud = null;
let napBlock = null;
function showHandHud(on) {
  if (!on) { if (hud && !hud.isDestroyed()) hud.destroy(); hud = null; return; }
  if (hud && !hud.isDestroyed()) return;
  const { workArea } = screen.getPrimaryDisplay();
  const width = 360, height = 40;
  hud = new BrowserWindow({
    width, height, x: Math.round(workArea.x + (workArea.width - width) / 2), y: workArea.y + workArea.height - height - 8,
    frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true,
    hasShadow: false, show: false, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'hud-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  hud.setAlwaysOnTop(true, 'screen-saver');
  hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hud.setIgnoreMouseEvents(true);
  hud.loadFile(path.join(__dirname, 'hand-hud.html'));
  hud.once('ready-to-show', () => hud && hud.showInactive());
}
ipcMain.on('jarvis:desktop-hands', (event, on) => {
  if (!win || event.sender !== win.webContents) return;
  win.webContents.setBackgroundThrottling(!on); // camera frames keep coming behind other apps
  if (on && napBlock === null) napBlock = powerSaveBlocker.start('prevent-app-suspension'); // no App Nap
  if (!on && napBlock !== null) { powerSaveBlocker.stop(napBlock); napBlock = null; }
  showHandHud(!!on);
});
ipcMain.on('jarvis:hand-hud', (event, update) => {
  if (!win || event.sender !== win.webContents) return;
  if (hud && !hud.isDestroyed()) hud.webContents.send('hand-hud:update', update);
});

app.on('before-quit', () => {
  quitting = true;
  if (stopWatching) stopWatching();
  share.withdraw(DATA_DIR, process.pid);
  showHandHud(false);
  globalShortcut.unregisterAll();
  if (backend) plat.killTree(backend);
});
app.on('window-all-closed', () => {});
