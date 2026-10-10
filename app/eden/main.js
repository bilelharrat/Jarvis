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

const NAME = 'Ask Eden';
const HOME_URL = 'https://askeden.com/';
const QUICK_KEYS = 'Alt+Space';
const EDEN_PORT = 5174;
const SIGN_IN_HOSTS = new Set(['appleid.apple.com', 'accounts.google.com']);
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

const isEdenSite = (url) => {
  try { const u = new URL(url); return u.protocol === 'https:' && (u.hostname === 'askeden.com' || u.hostname.endsWith('.askeden.com')); } catch { return false; }
};
const staysIn = (url) => {
  if (isEdenSite(url)) return true;
  try { const u = new URL(url); return u.protocol === 'https:' && SIGN_IN_HOSTS.has(u.hostname); } catch { return false; }
};
const openOutside = (url) => { if (/^(https|mailto):/i.test(url)) shell.openExternal(url).catch(() => {}); };

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

function guard(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (isEdenSite(url)) return { action: 'allow' };
    if (staysIn(url)) return { action: 'allow' }; // a sign-in popup
    openOutside(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (staysIn(url)) return;
    event.preventDefault();
    openOutside(url);
  });
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
  win.webContents.on('dom-ready', () => { apply(); fs_(win.isFullScreen()); });
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
  win.on('closed', () => { win = null; });
  win.loadFile(path.join(__dirname, 'loading.html')).catch(() => {});
  pendingUrl = '';
}

function showMain() {
  if (!win || win.isDestroyed()) createMain();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function openDeepLink(link) {
  // askeden://chat/abc?x=1 -> https://askeden.com/chat/abc?x=1
  let target = HOME_URL;
  try { const u = new URL(link); target = new URL(`${u.hostname ? `/${u.hostname}` : ''}${u.pathname === '/' ? '' : u.pathname}${u.search}${u.hash}`, HOME_URL).toString(); } catch { /* home */ }
  if (!isEdenSite(target)) target = HOME_URL; // askeden:////evil.com/x resolves to another host
  if (!win || win.isDestroyed()) { pendingUrl = target; showMain(); return; }
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
ipcMain.on('eden:quick:send', async (e, text) => {
  if (!quick || e.sender !== quick.webContents || !String(text).trim()) return;
  quick.hide();
  await newChat();
  // The page's own composer: the text in, then the form submitted, as typing it would.
  await inPage(`(() => {
    const i = document.getElementById('deck-input'); if (!i) return;
    i.value = ${JSON.stringify(String(text))};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(() => { const f = document.getElementById('deck-composer'); if (f) f.requestSubmit(); }, 60);
  })()`);
});

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
ipcMain.handle('eden:relink', (e) => { if (!fromEden(e)) return false; linkLastAsk = 0; autoLink().catch(() => {}); return true; });
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

function jarvisHome() {
  if (process.env.JARVIS_HOME) return process.env.JARVIS_HOME;
  for (const file of [path.join(__dirname, 'jarvis-home.json'), path.join(__dirname, '..', 'jarvis-home.json')]) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')).path; } catch { /* next */ }
  }
  return path.join(os.homedir(), 'JARVIS V1');
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

async function startEngine() {
  if (process.env.ASK_EDEN_NO_ENGINE === '1') return;
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
  if (child.pid) share.advertise(DATA_DIR, { port, token, pid: child.pid, app: 'ask-eden', launcher: process.pid });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.once('close', () => log.end());
  child.on('error', (err) => console.error(`engine: ${err.message}`));
  child.on('exit', () => {
    share.withdraw(DATA_DIR, process.pid);
    if (engine && engine.child === child) { engine = null; dropApprovalWin(); }
    if (!quitting) setTimeout(startEngine, 3000);
  });
  if (await waitForEngine(port)) watchApprovals();
}

// Eden's own server on this Mac (the Mac link's other end): started when nothing answers.
function edenUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: EDEN_PORT, path: '/', timeout: 800 }, (res) => { res.resume(); resolve(res.statusCode < 500); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}
async function startEdenServer() {
  if (process.env.ASK_EDEN_NO_ENGINE === '1' || await edenUp()) return;
  const candidates = [
    path.join(process.resourcesPath || '', 'eden-server', 'dist', 'ui', 'server.js'),
    process.env.ASKEDEN_HOME && path.join(process.env.ASKEDEN_HOME, 'dist', 'ui', 'server.js'),
    path.join(os.homedir(), 'askeden', 'dist', 'ui', 'server.js'),
  ].filter(Boolean);
  const entry = candidates.find((f) => fs.existsSync(f));
  if (!entry) return;
  eden = spawn(process.execPath, [entry, '--port', String(EDEN_PORT)], {
    cwd: path.dirname(path.dirname(path.dirname(entry))), stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH: [...EXTRA_PATH, process.env.PATH || '/usr/bin:/bin'].join(':') },
  });
  eden.on('exit', () => { eden = null; });
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
  approvalWin.webContents.on('console-message', (_e, _lvl, message) => {
    const a = /^eden-account:(.+)$/.exec(message);
    if (a) { try { onAccount(JSON.parse(a[1])); } catch { /* ignore */ } return; }
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
let linkBusy = false;
let linkOpenedPage = '';
let linkLastAsk = 0;
const sendEngine = (obj) => (approvalWin && !approvalWin.isDestroyed()
  ? approvalWin.webContents.executeJavaScript(`window.__edenWs && window.__edenWs.readyState === 1 && (window.__edenWs.send(${JSON.stringify(JSON.stringify(obj))}), true)`).catch(() => false)
  : Promise.resolve(false));
const webApi = (p, method = 'GET') => {
  if (!win || win.isDestroyed()) return Promise.resolve(null);
  return win.webContents.session.fetch(new URL(p, HOME_URL).toString(), {
    method, credentials: 'include', headers: { accept: 'application/json', 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })).catch(() => null);
};
async function onAccount(acct) {
  if (acct.linked || linkBusy) return;
  if (!(acct.link && acct.link.state === 'waiting') && Date.now() - linkLastAsk > 60_000) {
    linkLastAsk = Date.now();
    await sendEngine({ type: 'account_link' }); // the engine answers with an "account" event holding the code
    return;
  }
  const waiting = acct.link && acct.link.state === 'waiting' && acct.link.code;
  if (!waiting) return;
  linkBusy = true;
  try {
    const ready = await webApi('/api/web/mac-link');
    if (!ready || ready.status !== 200) return; // not signed in here yet: tried again later
    if (ready.body.fresh) {
      const done = await webApi(`/api/web/mac-link/${encodeURIComponent(acct.link.code)}/approve`, 'POST');
      console.log(`mac link: approve -> ${done && done.status}`);
    } else if (linkOpenedPage !== acct.link.code) { // signed in too long ago: one click on the page after signing in again
      linkOpenedPage = acct.link.code;
      if (win && !win.isDestroyed()) win.loadURL(new URL(`/signin?return=${encodeURIComponent('/link#' + acct.link.code)}`, HOME_URL).toString()).catch(() => {});
      showMain();
    }
  } finally { linkBusy = false; }
}
async function autoLink() {
  if (!engine || !approvalWin || !win || win.isDestroyed()) return;
  const ready = await webApi('/api/web/mac-link');
  if (!ready || ready.status !== 200) return;
  await sendEngine({ type: 'account' }); // answered with an "account" event
}
let linkTimer = null;
function startAutoLink() {
  if (linkTimer) return;
  const tick = async () => {
    // Ask for a code only when the engine says it's unlinked and has none waiting (onAccount).
    await autoLink();
  };
  linkTimer = setInterval(tick, 15_000);
  setTimeout(tick, 4000);
}

// ── updates, menu bar, menus ──

function setupUpdates() {
  const feed = feedFrom(process.resourcesPath, app.isPackaged);
  updater = createUpdater({
    version: app.getVersion(), feed, autoUpdater,
    fetchText: (url) => fetchFeed(net, url),
    inApplications: () => app.isInApplicationsFolder(),
    onChange: () => buildTray(),
    log: (line) => console.log(line),
    isQuiet: async () => powerMonitor.getSystemIdleTime() > 120 && !(win && win.isFocused()),
  });
  if (!feed) return;
  setTimeout(() => updater.check(), 60_000).unref?.();
  setInterval(() => updater.check(), 3_600_000).unref?.();
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
    { label: engine ? `Mac engine: ${engine.shared ? 'shared with J.A.R.V.I.S.' : 'running'}` : 'Mac engine: starting…', enabled: false },
    { type: 'separator' },
    { label: 'Quit Ask Eden', accelerator: 'CommandOrControl+Q', click: () => { quitting = true; app.quit(); } },
  ]));
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: NAME, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { label: 'Quit Ask Eden', accelerator: 'Command+Q', click: () => { quitting = true; app.quit(); } }] },
    { label: 'File', submenu: [{ label: 'New chat', accelerator: 'Command+N', click: () => newChat() }, { label: 'Quick ask', click: () => toggleQuick() }, { role: 'close' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }] },
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
  buildMenu();
  createMain();
  buildTray();
  if (!globalShortcut.register(QUICK_KEYS, toggleQuick)) console.warn(`${QUICK_KEYS} is taken`); else console.log('quick ask on', QUICK_KEYS);
  setupUpdates();
  await startEdenServer();
  await startEngine();
  buildTray();
  startAutoLink();
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
