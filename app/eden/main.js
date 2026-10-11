// Ask Eden for Mac: askeden.com's Eden, as it is in a browser, in a Mac window, with
// J.A.R.V.I.S.'s Mac engine built in. Its own app (bundle id com.askeden.eden.mac, its own
// userData folder and update feed); it reuses J.A.R.V.I.S.'s pieces, not its window:
//   - backend-launch.js / backend-share.js: the engine (`jarvis serve`), headless. When
//     J.A.R.V.I.S. (or Eden Code) already runs it, that one is used; never two engines.
//   - update-feed.js / features/updates.js: Squirrel.Mac updates from a feed of its own.
// The page is untouched. Only macOS window chrome is added: the title bar's drag region (a
// desktop-only class, html.eden-desktop, injected from here) and the traffic lights' place.
//
// "Your Mac" lights up through the engine, as in J.A.R.V.I.S.'s Eden window: the engine holds
// the Mac link to askeden.com (jarvis/eden_link.py) and passes the web's Mac requests to
// Eden's server on this Mac (model-router-ui, 127.0.0.1:5174), which this app starts when it
// isn't running.
'use strict';

const {
  app, BrowserWindow, Menu, Notification, Tray, autoUpdater, globalShortcut, ipcMain, nativeImage, net, powerMonitor, screen, shell,
} = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { backendCommand, BackendLog } = require('../backend-launch');
const share = require('../backend-share');
const { createUpdater, fetchFeed, feedFrom } = require('../features/updates');
const policy = require('./mac-policy');

const NAME = 'Ask Eden';
const HOME_URL = 'https://askeden.com/';
const QUICK_KEYS = 'Alt+Space';
const EDEN_PORT = 5174;
// A browser's user agent, as the website sees one (without Electron's and this app's tokens:
// sign-in providers refuse an embedded browser).
app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|Ask Eden|ask-eden-app)\/\S+/gi, '');

app.setName(NAME);
app.setPath('userData', path.join(app.getPath('appData'), NAME));
const DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Jarvis'); // the engine's (prefs.APP_SUPPORT)
const OWN_DIR = path.join(os.homedir(), 'Library', 'Application Support', NAME); // this app's own folder (the bundled engine runs from it)
const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', NAME);
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.cargo', 'bin')];

let win = null;
let quick = null;
let tray = null;
let quitting = false;
let engine = null; // { port, token, shared, child }
let stopWatching = null;
let eden = null; // Eden's server on this Mac, when this app started it
let updater = null;
let pendingUrl = '';
let approvalWin = null;
let lastApprovals = 0;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_e, argv) => {
  const deep = argv.find((a) => a.startsWith('askeden://'));
  if (deep) openDeepLink(deep); else showMain();
});

// ── the web page in a window ──

const { isEdenSite } = policy;
// AJ3-10: web pages (http too) in the user's browser; mailto:, tel:, webcal:, FaceTime and meeting links in their apps
const openOutside = (url) => { if (policy.outsideAllowed(url)) shell.openExternal(url).catch(() => {}); };

// The window chrome the page needs on a Mac, and nothing of the page's own look.
const DESKTOP_CSS = `
  html.eden-desktop #titlebar { -webkit-app-region: drag; }
  html.eden-desktop #titlebar button, html.eden-desktop #titlebar a, html.eden-desktop #titlebar input,
  html.eden-desktop #titlebar [contenteditable], html.eden-desktop #titlebar .tb-title { -webkit-app-region: no-drag; }
  html.eden-desktop:not(.eden-fullscreen) body { padding-top: 28px; box-sizing: border-box; }
  html.eden-desktop:not(.eden-fullscreen) #app { height: calc(100dvh - 28px); }
  html.eden-desktop:not(.eden-fullscreen) body::before { content: ''; position: fixed; top: 0; left: 0; right: 0; height: 28px; -webkit-app-region: drag; z-index: 2147483647; }
  html.eden-desktop.eden-fullscreen body::before { content: ''; position: fixed; top: 0; left: 84px; right: 0; height: 12px; -webkit-app-region: drag; pointer-events: none; }
`;

// The windows stay on askeden.com; a sign-in started there may pass through Google's, Apple's and a
// company's hosts until it's back (AJ2-8, AJ3-2, AJ3-12); askeden.com's download links download in the
// app (AJ3-3). Pop-ups get the same guard. window-policy.js, shared with Ask Eden for Windows.
const guard = policy.createGuard({ openOutside });

// askeden.com can't be reached (offline at launch, a Wi-Fi change): a page that says so and tries
// again (5 s, 10 s… every minute, at once on a wake or Reload), never a blank window (AJ3-9)
const offline = policy.createOfflineRetry({
  show: (url, ms) => { if (win && !win.isDestroyed()) win.loadURL(policy.offlinePageUrl({ name: NAME, url, seconds: ms / 1000 })).catch(() => {}); },
  retry: (url) => { if (win && !win.isDestroyed()) win.loadURL(url).catch(() => {}); },
});
function reloadFocused() { // View › Reload: on the offline page, askeden.com again, not the offline page
  const w = BrowserWindow.getFocusedWindow() || win;
  if (!w || w.isDestroyed()) return;
  if (w === win && offline.retryNow()) return;
  w.webContents.reload();
}

function createMain() {
  win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 760, minHeight: 560, title: NAME,
    titleBarStyle: 'hiddenInset',
    // Centered in the 28px strip above the page (DESKTOP_CSS).
    trafficLightPosition: { x: 18, y: 7 },
    backgroundColor: require('electron').nativeTheme.shouldUseDarkColors ? '#161618' : '#f5f5f7',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  guard(win.webContents);
  const apply = () => {
    win.webContents.insertCSS(DESKTOP_CSS).catch(() => {});
    win.webContents.executeJavaScript("document.documentElement.classList.add('eden-desktop')").catch(() => {});
  };
  const fs_ = (on) => win && !win.isDestroyed() && win.webContents.executeJavaScript(`document.documentElement.classList.toggle('eden-fullscreen', ${on})`).catch(() => {});
  win.webContents.on('dom-ready', () => { apply(); fs_(win.isFullScreen()); if (isEdenSite(win.webContents.getURL())) quickRetry(); });
  // AJ2-5: askeden.com loaded after a sign-in: linking looks again soon. AJ3-11: another page, or the window
  // brought forward, at most every 30 minutes. AJ3-1: the sign-in page on screen counts as someone looking.
  let mainUrl = '';
  win.webContents.on('did-navigate', (_e, url) => {
    const prev = mainUrl;
    mainUrl = String(url || '');
    if (isEdenSite(mainUrl)) offline.loaded();
    const nudge = policy.linkNudgeFor(prev, mainUrl);
    if (nudge === 'signed-in') autoLink.nudge(); else if (nudge === 'focus') autoLink.focused();
    if (isEdenSite(mainUrl) && /^\/signin(\/|$)/.test(new URL(mainUrl).pathname)) autoLink.signInShown();
  });
  win.on('focus', () => autoLink.focused());
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    const again = policy.offlineTarget(url, { code, isMainFrame });
    if (again && !quitting) offline.failed(again);
  });
  // AJ2-10: a crashed page (memory, on a very long chat) loads again instead of a blank window; a
  // page that keeps crashing waits longer each time (3 s, 6 s… 5 min)
  win.webContents.on('render-process-gone', (_e, details) => {
    const reason = details && details.reason;
    console.warn(`page gone: ${reason}`);
    if (reason === 'clean-exit' || quitting) return;
    const wait = crashBackoff.next();
    setTimeout(() => {
      if (!win || win.isDestroyed() || quitting) return;
      crashBackoff.started();
      const at = win.webContents.getURL();
      win.loadURL(isEdenSite(at) ? at : HOME_URL).catch(() => {});
    }, wait);
  });
  win.on('enter-full-screen', () => fs_(true));
  win.on('leave-full-screen', () => fs_(false));
  win.once('ready-to-show', () => win.show());
  // The boot-up sound once the "Opening Ask Eden…" window (loading.html) is on screen, then askeden.com.
  const first = pendingUrl || HOME_URL;
  win.once('show', () => {
    playBootSound();
    // (unless a link or the sign-in has already taken the window elsewhere)
    if (win && !win.isDestroyed() && win.webContents.getURL().startsWith('file:')) win.loadURL(first).catch(() => {});
  });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } }); // stays in the menu bar
  win.on('closed', () => { win = null; autoLink.stop(); }); // no window, nothing to link with
  win.loadFile(path.join(__dirname, 'loading.html')).catch(() => {});
  pendingUrl = '';
}

const crashBackoff = policy.createBackoff({ min: 1000 }); // AJ2-10

function showMain() {
  if (!win || win.isDestroyed()) createMain();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function openDeepLink(link) {
  // askeden://chat/abc?x=1 -> https://askeden.com/chat/abc?x=1 (anything else: home)
  const target = policy.deepLinkTarget(link);
  const action = policy.deepLinkAction({ ready: app.isReady(), hasWindow: Boolean(win && !win.isDestroyed()) });
  if (action === 'wait') { pendingUrl = target; return; } // a cold launch by a link: createMain opens it (AJ7)
  if (action === 'open') { pendingUrl = target; showMain(); return; }
  win.loadURL(target).catch(() => {});
  showMain();
}
app.on('open-url', (event, link) => { event.preventDefault(); openDeepLink(link); });
app.setAsDefaultProtocolClient('askeden');

// What the page does through its own controls, driven from the menu and the quick ask.
const inPage = (js) => (win && !win.isDestroyed() ? win.webContents.executeJavaScript(js).catch(() => {}) : Promise.resolve());
async function newChat() {
  showMain();
  await inPage("(() => { const b = document.getElementById('btnNew'); if (b) b.click(); const i = document.getElementById('deck-input'); if (i) i.focus(); })()");
}

// ── quick ask (⌥Space): a small window; Enter sends it to Eden's main chat ──

function createQuick() {
  quick = new BrowserWindow({
    width: 640, height: 76, show: false, frame: false, transparent: true, resizable: false, alwaysOnTop: true,
    skipTaskbar: true, fullscreenable: false, hasShadow: true,
    webPreferences: { preload: path.join(__dirname, 'quick-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  quick.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  quick.loadFile(path.join(__dirname, 'quick.html'));
  let focused = false;
  quick.on('focus', () => { focused = true; });
  quick.on('show', () => { focused = false; });
  quick.on('blur', () => { if (focused && quick && !quick.isDestroyed()) quick.hide(); });
  quick.on('closed', () => { quick = null; });
}

function toggleQuick() {
  console.log('quick ask toggled');
  if (quick && !quick.isDestroyed() && quick.isVisible()) { quick.hide(); return; }
  if (!quick || quick.isDestroyed()) createQuick();
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const [w] = quick.getSize();
  quick.setPosition(Math.round(area.x + (area.width - w) / 2), Math.round(area.y + area.height / 4));
  quick.show();
  quick.focus();
  if (app.focus) app.focus({ steal: true });
}

ipcMain.on('eden:quick:close', (e) => { if (quick && e.sender === quick.webContents) quick.hide(); });
const quickGate = policy.createGate({ gapMs: 1000 }); // F11: one send a second at most
let quickPending = null; // { text, at }: a quick ask the page couldn't take yet (loading, signed out: AJ15)
async function sendQuick(text, at = Date.now()) {
  await newChat();
  // The page's own composer: the text in, then the form submitted, as typing it would.
  const took = await inPage(policy.quickAskScript(text, HOME_URL)); // AJ2-9: 'not-ready' before the page's chat is
  const first = !quickPending;
  quickPending = took === true ? null : { text: String(text), at };
  if (quickPending && first && Notification.isSupported()) new Notification({ title: NAME, body: 'Eden will ask that once the chat is open (sign in first if it asks).' }).show();
  // AJ2-9: the page is there but its chat isn't ready yet: try again shortly (no new page load will)
  if (took === 'not-ready' && quickPending) quickAgain(quickPending);
}
function quickAgain(q) {
  if (q.again) return;
  q.again = true;
  setTimeout(() => { q.again = false; if (quickPending === q && Date.now() - q.at < 120_000) sendQuick(q.text, q.at); }, 1500);
}
ipcMain.on('eden:quick:send', async (e, text) => {
  if (!quick || e.sender !== quick.webContents || !String(text).trim()) return;
  if (!quickGate()) return;
  quick.hide();
  await sendQuick(String(text).slice(0, 20_000));
});
function quickRetry() { // the chat page loaded: a quick ask kept for it (2 minutes at most) goes now
  const q = quickPending;
  if (!q || q.retrying) return;
  q.retrying = true;
  if (Date.now() - q.at >= 120_000) { quickPending = null; return; }
  setTimeout(() => { if (quickPending === q) sendQuick(q.text, q.at); }, 800);
}

// ── bridge: Dock badge and notifications ──

const fromEden = (e) => Boolean(win && !win.isDestroyed() && e.sender === win.webContents && isEdenSite(e.sender.getURL()));
const setBadge = (n) => { if (app.dock) app.dock.setBadge(n > 0 ? String(n) : ''); };
ipcMain.on('eden:badge', (e, n) => { if (fromEden(e)) setBadge(Number(n) || 0); });
ipcMain.on('eden:notify', (e, title, body) => {
  if (!fromEden(e) || !Notification.isSupported()) return;
  const n = new Notification({ title: String(title || NAME).slice(0, 120), body: String(body || '').slice(0, 300) });
  n.on('click', showMain);
  n.show();
});
ipcMain.handle('eden:relink', (e) => { if (!fromEden(e)) return false; autoLink.relink(); return true; }); // at most once every 10 s (F12)
ipcMain.handle('eden:boot-sound', (e, on) => {
  if (!fromEden(e)) return null;
  if (typeof on === 'boolean') { try { fs.writeFileSync(BOOT_SOUND_FILE(), `${JSON.stringify({ on })}\n`); } catch { /* read-only: stays as it was */ } }
  return bootSoundOn();
});
ipcMain.handle('eden:engine', (e) => (fromEden(e) ? { running: Boolean(engine), shared: Boolean(engine && engine.shared) } : null));

// ── the Mac engine ──

const freePort = () => new Promise((resolve, reject) => {
  const srv = require('net').createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

function jarvisHome() { // a baked folder that no longer exists is skipped (AJ10)
  return policy.jarvisHome({
    env: process.env, files: [path.join(__dirname, 'jarvis-home.json'), path.join(__dirname, '..', 'jarvis-home.json')],
    read: (f) => fs.readFileSync(f, 'utf8'), exists: fs.existsSync, edenDir: __dirname,
  });
}
function findUv() {
  for (const dir of EXTRA_PATH) { const c = path.join(dir, 'uv'); if (fs.existsSync(c)) return c; }
  return 'uv';
}

async function waitForEngine(port, tries = 120) {
  for (let i = 0; i < tries; i += 1) {
    if (await share.healthy(port, 1000)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const engineBackoff = policy.createBackoff(); // F3: 3 s, 6 s… 5 min between restarts; 3 s again after a minute up
async function startEngine() {
  if (process.env.ASK_EDEN_NO_ENGINE === '1' || quitting) return;
  const found = await share.discover(DATA_DIR);
  if (found) { // J.A.R.V.I.S. or Eden Code runs it already: one engine per Mac
    engine = { port: found.port, token: found.token, shared: true };
    stopWatching = share.watch(found.port, () => { engine = null; dropApprovalWin(); if (!quitting) startEngine(); });
    watchApprovals();
    return;
  }
  const port = await freePort();
  const token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const log = new BackendLog(path.join(LOG_DIR, 'backend.log'), { max: 5 * 1024 * 1024 });
  const how = backendCommand({
    packaged: app.isPackaged, resourcesPath: process.resourcesPath, env: process.env, port, token,
    extraPath: EXTRA_PATH, uv: findUv, home: jarvisHome, dataDir: OWN_DIR, exists: fs.existsSync,
  });
  if (how.cwd) fs.mkdirSync(how.cwd, { recursive: true });
  how.env.JARVIS_LAUNCHER_PID = String(process.pid);
  how.env.JARVIS_PROFILE = 'code'; // headless: no microphone until a J.A.R.V.I.S. window joins
  log.write(`\n--- ${new Date().toISOString()} starting on port ${port} for ${NAME}\n`);
  const child = spawn(how.command, how.args, { env: how.env, cwd: how.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  engine = { port, token, shared: false, child };
  engineBackoff.started();
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.once('close', () => log.end());
  child.on('error', (err) => console.error(`engine: ${err.message}`));
  child.on('exit', () => {
    share.withdraw(DATA_DIR, process.pid);
    if (engine && engine.child === child) { engine = null; dropApprovalWin(); }
    if (!quitting) {
      const wait = engineBackoff.next();
      log.write(`--- engine stopped; starting again in ${Math.round(wait / 1000)} s\n`);
      setTimeout(startEngine, wait);
    }
  });
  if (await waitForEngine(port) && engine && engine.child === child) {
    // F2: told to the other apps only once it answers (it holds the data folder by then)
    if (child.pid && child.exitCode === null) share.advertise(DATA_DIR, { port, token, pid: child.pid, app: 'ask-eden', launcher: process.pid });
    watchApprovals();
  }
}

// Eden's own server on this Mac (the Mac link's other end): started when nothing answers.
function edenUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: EDEN_PORT, path: '/', timeout: 800 }, (res) => { res.resume(); resolve(res.statusCode < 500); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}
const edenBackoff = policy.createBackoff();
async function startEdenServer() {
  if (process.env.ASK_EDEN_NO_ENGINE === '1' || quitting || await edenUp()) return;
  // the app's own copy, ASKEDEN_HOME, the askeden repo next to this one (never ~/askeden, an old copy: AJ10)
  const entry = policy.edenServerCandidates({ resourcesPath: process.resourcesPath, env: process.env, edenDir: __dirname }).find((f) => fs.existsSync(f));
  if (!entry) return;
  let out = 'ignore';
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); out = fs.openSync(path.join(LOG_DIR, 'eden-server.log'), 'a'); } catch { /* no log */ }
  const child = spawn(process.execPath, [entry, '--port', String(EDEN_PORT)], {
    cwd: path.dirname(path.dirname(path.dirname(entry))), stdio: ['ignore', out, out],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH: [...EXTRA_PATH, process.env.PATH || '/usr/bin:/bin'].join(':') },
  });
  if (typeof out === 'number') fs.close(out, () => {});
  eden = child;
  edenBackoff.started();
  child.on('error', () => {});
  // AJ17: a crash no longer leaves "Eden isn't running on your Mac" until the app restarts
  child.on('exit', () => { if (eden === child) eden = null; if (!quitting) setTimeout(() => startEdenServer().catch(() => {}), edenBackoff.next()); });
}

// Pending approvals on the Dock icon: the engine's socket, read from a hidden page on the
// engine's own origin (the socket accepts only that origin).
function dropApprovalWin() { // it holds the old engine's port and token: the next engine gets a fresh one
  if (approvalWin && !approvalWin.isDestroyed()) approvalWin.destroy();
  approvalWin = null;
}
function watchApprovals() {
  if (!engine || approvalWin) return;
  const { port, token } = engine;
  approvalWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  approvalWin.webContents.on('console-message', (e) => { // one argument: the positional ones are deprecated (AJ16)
    const { message } = e;
    if (typeof message !== 'string') return;
    const a = /^eden-account:(.+)$/.exec(message);
    if (a) { try { autoLink.onAccount(JSON.parse(a[1])).catch(() => {}); } catch { /* ignore */ } return; }
    const m = /^eden-approvals:(\d+)$/.exec(message);
    if (!m) return;
    const n = Number(m[1]);
    setBadge(n);
    if (n > lastApprovals && Notification.isSupported() && !(win && win.isFocused())) {
      const note = new Notification({ title: NAME, body: n === 1 ? 'Eden is waiting for your approval.' : `Eden is waiting on ${n} approvals.` });
      note.on('click', showMain);
      note.show();
    }
    lastApprovals = n;
  });
  approvalWin.on('closed', () => { approvalWin = null; });
  approvalWin.loadURL(`http://127.0.0.1:${port}/health`).then(() => approvalWin.webContents.executeJavaScript(`
    (function open() {
      const ws = new WebSocket('ws://127.0.0.1:${port}/ws?token=${token}');
      window.__edenWs = ws;
      ws.onmessage = (m) => { try { const d = JSON.parse(m.data); if (Array.isArray(d.approvals)) console.log('eden-approvals:' + d.approvals.length);
        if (d.type === 'account') console.log('eden-account:' + JSON.stringify({ linked: d.linked === true, server: d.server || '', link: d.link ? { state: d.link.state, code: d.link.code } : null })); } catch (e) {} };
      ws.onclose = () => setTimeout(open, 3000);
    })();`)).catch(() => {});
}

// ── linking this Mac to the signed-in account, automatically ──
// The engine's own "account_link" command makes the code (as Settings › Account › Link this Mac
// does); this window's askeden.com session approves it at /api/web/mac-link (as askeden.com/link
// does), which the server only allows within 10 minutes of the sign-in.
const sendEngine = (obj) => (approvalWin && !approvalWin.isDestroyed()
  ? approvalWin.webContents.executeJavaScript(`window.__edenWs && window.__edenWs.readyState === 1 && (window.__edenWs.send(${JSON.stringify(JSON.stringify(obj))}), true)`).catch(() => false)
  : Promise.resolve(false));
const webApi = (p, method = 'GET') => {
  if (!win || win.isDestroyed()) return Promise.resolve(null);
  return win.webContents.session.fetch(new URL(p, HOME_URL).toString(), {
    method, credentials: 'include', headers: { accept: 'application/json', 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}),
    signal: AbortSignal.timeout(policy.LINK_REQUEST_MS), // AJ2-4: a stalled request ends
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })).catch(() => null);
};
// Every 15 s while unlinked, every 15 minutes once linked (F5/AJ13); the sign-in page once per run (AJ9);
// signed out, or waiting for a sign-in, less and less often (AJ2-5); a stalled request ends at 15 s (AJ2-4).
const autoLink = policy.createAutoLink({
  sendEngine, webApi,
  canRun: () => Boolean(engine && approvalWin && win && !win.isDestroyed()),
  isLooking: () => Boolean(win && !win.isDestroyed() && win.isVisible() && win.isFocused()), // AJ3-1
  onLinked: () => inPage("dispatchEvent(new Event('eden:mac-linked'))"), // AJ3-14: "Your Mac" looks again now
  openSignIn: (code) => {
    if (win && !win.isDestroyed()) win.loadURL(new URL(`/signin?return=${encodeURIComponent('/link#' + code)}`, HOME_URL).toString()).catch(() => {});
    showMain();
  },
  log: (line) => console.log(line),
});

// ── updates, menu bar, menus ──

function setupUpdates() {
  const feed = feedFrom(process.resourcesPath, app.isPackaged);
  updater = createUpdater({
    version: app.getVersion(), feed, autoUpdater,
    fetchText: (url) => fetchFeed(net, url),
    inApplications: () => app.isInApplicationsFolder(),
    onChange: (s) => { buildTray(); if (s && s.state === 'ready') updateReady(s); },
    log: (line) => console.log(line),
    isQuiet: async () => powerMonitor.getSystemIdleTime() > 120 && !(win && win.isFocused()),
    beforeInstall: () => { quitting = true; },
  });
  if (!feed) return;
  setTimeout(() => updater.check(), 60_000).unref?.();
  setInterval(() => updater.check(), 3_600_000).unref?.();
  setInterval(() => { updater.quiet().catch(() => {}); }, 60_000).unref?.(); // AJ17: a ready update installs itself when the Mac is idle
}
let updateTold = '';
function updateReady(s) { // once per version: where to find it, if it doesn't install itself first
  const v = String(s.version || '');
  if (updateTold === v || !Notification.isSupported()) return;
  updateTold = v;
  const n = new Notification({ title: NAME, body: 'An update is ready. It installs when your Mac is idle, or now from the menu bar: Restart to update.' });
  n.on('click', showMain);
  n.show();
}

function buildTray() {
  if (!tray) {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'trayTemplate.png')); // @2x beside it
    icon.setTemplateImage(true); // monochrome: macOS tints it for light, dark and a selected menu bar
    tray = new Tray(icon);
    tray.setToolTip(NAME);
  }
  const u = updater ? updater.state() : { state: 'off' };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'New chat', accelerator: 'CommandOrControl+N', click: () => newChat() },
    { label: 'Quick ask', accelerator: 'Alt+Space', click: () => toggleQuick() },
    { label: 'Open Ask Eden', click: () => showMain() },
    { type: 'separator' },
    ...(u.state === 'ready' ? [{ label: 'Restart to update', click: () => updater.restart() }] : []),
    { label: engine ? `Mac engine: ${engine.shared ? 'shared with the Eden app' : 'running'}` : 'Mac engine: starting…', enabled: false },
    { type: 'separator' },
    { label: 'Quit Ask Eden', accelerator: 'CommandOrControl+Q', click: () => { quitting = true; app.quit(); } },
  ]));
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: NAME, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { label: 'Quit Ask Eden', accelerator: 'Command+Q', click: () => { quitting = true; app.quit(); } }] },
    { label: 'File', submenu: [{ label: 'New chat', accelerator: 'Command+N', click: () => newChat() }, { label: 'Quick ask', click: () => toggleQuick() }, { role: 'close' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ label: 'Reload', accelerator: 'CommandOrControl+R', click: reloadFocused }, { role: 'togglefullscreen' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }] },
    { role: 'windowMenu' },
  ]));
}

// The boot-up sound, the owner's choice ("C'est, c'est, c'est énergétique !"), once per launch, as the
// window first shows (createMain). The window goes on to askeden.com, which would cut a sound played
// in the page, so macOS's own player plays it (from a copy: it can't read inside app.asar).
// Whether it plays: Settings › Appearance or the welcome sheet on the page (askeden web/chat/boot-sound.js)
// keeps the choice here, in the app's own folder, to be read before the page loads.
const BOOT_SOUND_FILE = () => path.join(app.getPath('userData'), 'boot-sound.json');
function bootSoundOn() {
  try { return JSON.parse(fs.readFileSync(BOOT_SOUND_FILE(), 'utf8')).on !== false; } catch { return true; }
}
let bootSoundPlayed = false;
function playBootSound() {
  if (bootSoundPlayed || !bootSoundOn()) return;
  bootSoundPlayed = true;
  try {
    const file = path.join(app.getPath('temp'), 'ask-eden-boot-sound.wav');
    fs.copyFileSync(path.join(__dirname, 'build', 'boot-sound.wav'), file);
    require('child_process').spawn('/usr/bin/afplay', [file], { stdio: 'ignore', detached: true })
      .on('error', () => {}).unref(); // (no sound device: nothing to say)
  } catch { /* nothing to say */ }
}

app.whenReady().then(async () => {
  if (app.dock) app.dock.setIcon(path.join(__dirname, 'build', 'icon-1024.png'));
  // AJ8 (F9): Electron grants every permission by default. askeden.com gets what its page uses
  // (the microphone, notifications, copy and paste, full screen); nothing else, and no other page.
  const { session } = require('electron');
  // AJ2-3: by the asking frame's origin too: a sandboxed artifact frame or page on askeden.com
  // (an opaque origin, "null") gets nothing, whatever its URL.
  policy.setPermissions(session.defaultSession); // (window-policy.js: the same in Ask Eden for Windows)
  buildMenu();
  createMain();
  buildTray();
  if (!globalShortcut.register(QUICK_KEYS, toggleQuick)) console.warn(`${QUICK_KEYS} is taken`); else console.log('quick ask on', QUICK_KEYS);
  setupUpdates();
  await startEdenServer();
  await startEngine();
  buildTray();
  autoLink.start();
  powerMonitor.on('resume', () => { autoLink.wake(); offline.retryNow(); });
});

app.on('activate', showMain);
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* stays in the menu bar */ });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (stopWatching) stopWatching();
  if (engine && engine.child) { try { engine.child.kill('SIGTERM'); } catch { /* gone */ } }
  if (eden) { try { eden.kill('SIGTERM'); } catch { /* gone */ } }
  share.withdraw(DATA_DIR, process.pid);
});
