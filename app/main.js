// Jarvis desktop app: starts the Python backend, shows its window, owns the ⌥Space shortcut.

const { app, BrowserWindow, Menu, WebContentsView, clipboard, dialog, globalShortcut, ipcMain, nativeTheme, powerSaveBlocker, screen, session, shell } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { toUrl, homeUrl, searchEngine, searchUrl } = require('./url-input'); // what the address bar makes of what's typed
const { createAgent } = require('./browser-agent');
const { backendCommand } = require('./backend-launch'); // the bundled backend, else uv and the repo
const { createParity } = require('./browser-parity'); // per-site permissions, popups, sign-in, Settings › Browser
const { isCertError } = require('./browser-lib');

app.setName('J.A.R.V.I.S.');

const TOKEN = crypto.randomBytes(24).toString('hex');
const SHORTCUT = 'Alt+Space';
const WHATS_THIS = 'Alt+Shift+Space'; // explain whatever is in front of you
const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'Jarvis');
const DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Jarvis'); // the backend's (prefs.APP_SUPPORT)
// Development only: show a backend that's already running (no microphone of its own)
// instead of starting one, with a profile of its own and without the global shortcuts,
// so it can run beside the installed app.
const DEV_URL = process.env.JARVIS_BACKEND_URL || '';
if (DEV_URL) {
  app.setPath('userData', path.join(os.tmpdir(), 'jarvis-dev-profile'));
  // …and downloads of its own: testing never writes into the real Downloads folder
  app.setPath('downloads', path.join(os.tmpdir(), 'jarvis-dev-downloads'));
  fs.mkdirSync(app.getPath('downloads'), { recursive: true });
}

let win = null;
let backend = null;
let port = 0;
let quitting = false;

// One Jarvis at a time: a second launch (npm start twice, a dev build beside the installed
// app) brings the running one forward instead of starting a second backend on the same
// files. Asked after the dev profile is set above, so the test window, with a profile of
// its own, never collides with the installed app.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => {
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

function jarvisHome() {
  if (process.env.JARVIS_HOME) return process.env.JARVIS_HOME;
  const baked = path.join(__dirname, 'jarvis-home.json');
  if (fs.existsSync(baked)) return JSON.parse(fs.readFileSync(baked, 'utf8')).path;
  return path.resolve(__dirname, '..');
}

// Apps opened from Finder don't inherit the shell's PATH, so look where uv usually lives.
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.cargo', 'bin')];

function findUv() {
  for (const dir of EXTRA_PATH) {
    const candidate = path.join(dir, 'uv');
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
// the one before), so a crash loop or a noisy backend can't fill the disk.
const BACKEND_LOG_MAX = 5 * 1024 * 1024;

function openBackendLog() {
  const file = path.join(LOG_DIR, 'backend.log');
  try {
    if (fs.statSync(file).size > BACKEND_LOG_MAX) fs.renameSync(file, path.join(LOG_DIR, 'backend.1.log'));
  } catch (_) { /* no log yet */ }
  return fs.createWriteStream(file, { flags: 'a' });
}

function startBackend() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const log = openBackendLog();
  const how = backendCommand({
    packaged: app.isPackaged, resourcesPath: process.resourcesPath, env: process.env, port, token: TOKEN,
    extraPath: EXTRA_PATH, uv: findUv, home: jarvisHome, dataDir: DATA_DIR, exists: fs.existsSync,
  });
  if (how.cwd) fs.mkdirSync(how.cwd, { recursive: true });
  log.write(`\n--- ${new Date().toISOString()} starting on port ${port}${how.bundled ? ' (bundled backend)' : ''}\n`);
  backend = spawn(how.command, how.args, { env: how.env, cwd: how.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  backend.stdout.pipe(log);
  backend.stderr.pipe(log);
  backend.on('error', (err) => showProblem(`Couldn't start the backend: ${err.message}`));
  backend.on('exit', (code) => {
    backend = null;
    if (!quitting) restartBackend(code);
  });
}

// A backend that stops on its own is started again (a few times, a little later each
// time), so a crash never leaves Jarvis dead; the log keeps what happened.
let restarts = [];
function restartBackend(code) {
  const now = Date.now();
  restarts = restarts.filter((t) => now - t < 5 * 60_000);
  // 75: another backend holds the data folder (server.serve): one still quitting, or a
  // `jarvis serve` started in a terminal.
  const taken = code === 75;
  if (restarts.length >= 3) {
    showProblem(taken
      ? 'Another JARVIS backend is still using your data (a `jarvis serve` in a terminal, or one that hasn’t finished quitting). Quit it, then open Jarvis again.'
      : `The backend stopped (exit ${code}) three times in five minutes. Details are in ~/Library/Logs/Jarvis/backend.log.`);
    return;
  }
  restarts.push(now);
  showProblem(taken ? 'Another JARVIS backend is still using your data. Waiting for it to finish…' : `The backend stopped (exit ${code}). Starting it again…`);
  setTimeout(async () => {
    if (quitting || backend) return;
    startBackend();
    try {
      await waitForBackend();
      if (win && !win.isDestroyed()) win.loadURL(`${appUrl()}?token=${TOKEN}`);
    } catch (err) {
      showProblem(`Jarvis couldn't start again: ${err.message}. Details are in ~/Library/Logs/Jarvis/backend.log.`);
    }
  }, 1500 * restarts.length);
}

function waitForBackend(timeoutMs = 90000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on('error', retry);
      req.on('timeout', () => req.destroy());
    };
    const retry = () => {
      if (!backend) return reject(new Error('backend exited'));
      if (Date.now() - started > timeoutMs) return reject(new Error('backend took too long to start'));
      setTimeout(attempt, 400);
    };
    attempt();
  });
}

function showProblem(message) {
  if (win && !win.isDestroyed()) win.loadFile(path.join(__dirname, 'loading.html'), { query: { error: message } });
}

function appUrl() {
  return `http://127.0.0.1:${port}/`;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 760,
    minHeight: 620,
    show: false,
    title: 'J.A.R.V.I.S.',
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111317' : '#f4f0e8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  if (DEV_URL) {
    // A test window: labelled, never takes focus, and clicks pass through it.
    win.setTitle('J.A.R.V.I.S. (test)');
    win.once('ready-to-show', () => { win.showInactive(); win.setIgnoreMouseEvents(true); });
  } else win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'loading.html'));

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
// Center's own pages the mouse and keyboard don't reach the page at all: only Jarvis drives
// it, by voice and by hand (its sign-in pages excepted, so the user signs in themselves).

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
  win.webContents.send('browser:state', {
    tabs: tabList(),
    shields: { on: guard.adblock && Boolean(blocker), ready: Boolean(blocker), site: hostOf(url), allowed: guard.allow.includes(hostOf(url)), research: onResearch(url), blocked: blockedOn.get(wc.id) || 0, total: blockedTotal },
    url,
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canBack: wc.navigationHistory.canGoBack(),
    canForward: wc.navigationHistory.canGoForward(),
    locked: browserLocked,
    research: onResearch(url),
    zoom: Math.round(wc.getZoomFactor() * 100),
    ...extra,
  });
}

function updateLock() {
  const wc = browserView.webContents;
  browserLocked = onResearch(wc.getURL()) && !RESEARCH_AUTH.test(researchPath(wc.getURL()));
  wc.send('jarvis:locked', browserLocked);
  sendBrowserState();
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
  if (browserShown && browserView) win.contentView.removeChildView(browserView);
  browserView = view;
  parity.selected(view);
  if (browserShown) {
    win.contentView.addChildView(view);
    if (lastBounds) view.setBounds(lastBounds);
  }
  view.webContents.setZoomFactor(parity.zoomFor(view.webContents)); // the site's own zoom
  updateLock();
}

function newTab(url) {
  const view = createTab();
  tabs.push(view);
  selectTab(view);
  browserAsked = true;
  view.webContents.loadURL(url ? toUrl(url) : homeUrl()).catch(() => {}); // the search engine's page
  return view;
}

// The last tab never closes: the dock does (the window's close button).
function closeTab(view) {
  const at = tabs.indexOf(view);
  if (at < 0 || tabs.length < 2) return false;
  tabs.splice(at, 1);
  const url = view.webContents.getURL();
  if (/^https?:/.test(url)) closedTabs.push(url);
  if (closedTabs.length > 25) closedTabs.shift();
  if (view === browserView) selectTab(tabs[Math.min(at, tabs.length - 1)]);
  view.webContents.close();
  sendBrowserState();
  return true;
}

// ── Chrome's everyday features: shortcuts, history, bookmarks, find, the page's menu,
// downloads (always asked first: Jarvis can click in this browser too) ──

async function faviconData(ses, url) {
  try {
    const res = await ses.fetch(url, { signal: AbortSignal.timeout(5000) });
    const type = res.headers.get('content-type') || 'image/x-icon';
    if (!res.ok || !/^image\//.test(type)) return '';
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.length > 64000 ? '' : `data:${type.split(';')[0]};base64,${bytes.toString('base64')}`;
  } catch {
    return '';
  }
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
    if (key === '[' || key === '{') return stepTab(-1);
    if (key === ']' || key === '}') return stepTab(1);
    return false;
  }
  if (key === 't') { newTab(); sendBrowserState(); return ui('address'); }
  if (key === 'w') { if (tabs.length > 1) closeTab(browserView); else ui('close'); return true; }
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
const browserFile = () => path.join(app.getPath('userData'), 'browser.json');
function browserStore() {
  if (browserData) return browserData;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(browserFile(), 'utf8')) || {}; } catch {}
  browserData = {
    history: Array.isArray(raw.history) ? raw.history.filter((h) => h && typeof h.url === 'string').slice(-2000) : [],
    bookmarks: Array.isArray(raw.bookmarks) ? raw.bookmarks.filter((b) => b && typeof b.url === 'string') : [],
    adblock: raw.adblock !== false,
    allow: Array.isArray(raw.allow) ? raw.allow.filter((h) => typeof h === 'string').slice(0, 500) : [],
  };
  return browserData;
}
function saveBrowserStore() {
  clearTimeout(browserSave);
  browserSave = setTimeout(() => {
    try {
      const tmp = `${browserFile()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(browserData));
      fs.renameSync(tmp, browserFile());
    } catch {}
  }, 400);
}
function rememberVisit(url, wc) {
  if (!/^https?:/.test(url) || (onResearch(url) && RESEARCH_AUTH.test(researchPath(url)))) return;
  const store = browserStore();
  const last = store.history[store.history.length - 1];
  if (last && last.url === url) return;
  store.history.push({ url, title: wc.getTitle() || '', at: Date.now() });
  if (store.history.length > 2000) store.history.splice(0, store.history.length - 2000);
  saveBrowserStore();
}
function retitleVisit(url, title) {
  const store = browserStore();
  const last = store.history[store.history.length - 1];
  if (last && last.url === url && title) { last.title = title; saveBrowserStore(); }
}

// The page's own menu, as in Chrome.
function pageMenu(view, p) {
  const wc = view.webContents;
  const items = [];
  const sep = () => { if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' }); };
  if (p.linkURL && /^https?:/.test(p.linkURL)) {
    items.push({ label: 'Open Link in New Tab', click: () => { newTab(p.linkURL); sendBrowserState(); } });
    items.push({ label: 'Copy Link Address', click: () => clipboard.writeText(p.linkURL) });
    sep();
  }
  if (p.mediaType === 'image' && p.srcURL) {
    if (/^https?:/.test(p.srcURL)) items.push({ label: 'Open Image in New Tab', click: () => { newTab(p.srcURL); sendBrowserState(); } });
    items.push({ label: 'Save Image As…', click: () => wc.downloadURL(p.srcURL) });
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
    items.push({ label: `Search ${searchEngine().name} for “${text}${p.selectionText.trim().length > 60 ? '…' : ''}”`, click: () => { newTab(searchUrl(p.selectionText)); sendBrowserState(); } });
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
  items.push({ label: 'Inspect', click: () => { wc.inspectElement(p.x, p.y); } });
  Menu.buildFromTemplate(items).popup({ window: win });
}

// Downloads: each one lands in a private staging folder first, and only the user's Save in
// the window moves it into Downloads (a small file finishes before anyone could pause it,
// so pausing alone isn't enough). Cancel deletes the staged copy.
const downloads = new Map();
let downloadIds = 0;
let downloadsReady = false;
const stagingDir = () => path.join(app.getPath('userData'), 'download-staging');

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
  session.fromPartition('persist:jarvis-browser').on('will-download', (_event, item) => {
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
  });
}

// ── Ad and tracker blocking: Ghostery's engine with EasyList, EasyPrivacy, uBlock Origin's
// filters, privacy, badware, quick fixes and unbreak lists, and the cookie-banner and
// annoyance lists; uBlock's scriptlets (which beat in-page ads like YouTube's) and cosmetic
// hiding included. The compiled engine is cached and rebuilt from fresh lists daily (an old
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
  ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
    if (!shielded(pageOf(details))) { callback({}); return; }
    blocker.onHeadersReceived(details, callback);
  });
  ses.registerPreloadScript({ type: 'frame', filePath: require.resolve('@ghostery/adblocker-electron-preload') });
  ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (event, url, msg) => {
    let top = url;
    try { top = event.sender.getURL() || url; } catch {}
    return shielded(top) ? blocker.onInjectCosmeticFilters(event, url, msg) : undefined;
  });
  ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', (event) => (blocker ? blocker.onIsMutationObserverEnabled(event) : false));
  const refresh = async () => {
    const engine = await buildBlocker();
    if (engine) { blocker = engine; sendBrowserState(); }
  };
  refresh();
  setInterval(refresh, ADBLOCK_DAY).unref();
}

function tabById(id) { return tabs.find((view) => view.webContents.id === Number(id)); }

function createTab() {
  const view = new WebContentsView({
    webPreferences: {
      partition: 'persist:jarvis-browser',
      disableBlinkFeatures: 'WebBluetooth', // a page asking for a device would have macOS ask about Bluetooth
      preload: path.join(__dirname, 'page-preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const wc = view.webContents;
  const active = () => view === browserView;
  wc.setWindowOpenHandler((details) => {
    const popup = parity.windowOpen(wc, details); // a sign-in or payment popup: a real window (browser-parity.js)
    if (popup) return popup;
    const { url } = details;
    // a link that wants a new window: a new tab (behind, when it came from a tab behind)
    if (/^https?:\/\//.test(url)) { if (view === browserView) newTab(url); else browserAgent.popup(view, url); }
    return { action: 'deny' };
  });
  parity.wireTab(view); // per-site permission prompts (browser-parity.js)
  // On the Research Center, direct input never reaches the page (Jarvis's own does).
  wc.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && win && !agentInput) win.webContents.send('browser:escape');
    // Chrome's shortcuts work with the page focused too (they're the browser's, not the page's).
    if (input.type === 'keyDown' && !browserSynthetic && !agentInput && browserShortcut(input)) { event.preventDefault(); return; }
    if (active() && browserLocked && !browserSynthetic) event.preventDefault();
  });
  // The window only shows local and data: images, so the icon comes over as data.
  wc.on('page-favicon-updated', async (_event, icons) => {
    const url = (icons || []).find((u) => /^(https?:|data:image\/)/.test(u));
    if (!url) return;
    view.favicon = url.startsWith('data:') ? url.slice(0, 90000) : await faviconData(wc.session, url);
    sendBrowserState();
  });
  wc.on('did-navigate', (_event, url) => { blockedOn.set(wc.id, 0); rememberVisit(url, wc); });
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

// JARVIS's and Jarvis Code's hands over the DevTools protocol: snapshots with element refs,
// actions by ref, waits (browser-agent.js). It works on any tab, the one on show or not.
const browserAgent = createAgent({
  tabs: () => tabs,
  ensureBrowser,
  isShown: (view) => Boolean(view && view === browserView && browserShown),
  setSynthetic: (on) => { agentInput = on; },
  addTab: ({ select, owner }) => {
    const view = createTab();
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
  // A popup's link for a new window: a tab in the dock.
  openTab: (url) => { newTab(url); sendBrowserState(); if (win && !win.isDestroyed()) win.webContents.send('browser:open'); },
  // The tabs put back from last time: each an empty tab its page is loaded into.
  restoreTab: () => { const view = createTab(); tabs.push(view); browserAsked = true; return view; },
  select: (view) => { selectTab(view); sendBrowserState(); },
  closeTab: (view) => closeTab(view),
  changed: () => sendBrowserState(),
  // Never kept for next time: the Research Center's sign-in pages (their addresses can carry a reset token).
  keep: (url) => !(onResearch(url) && RESEARCH_AUTH.test(researchPath(url))),
  browserData: () => browserStore(), // history and bookmarks, for the address bar's suggestions
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
      if (/^https?:\/\//.test(String(args.base || ''))) researchBase = args.base;
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
    case 'read':
      if (!wc.getURL()) return { error: 'The browser is empty. Open a page first.' };
      // rich: dialogs, banners and sidebars too, real field labels and values, read on from offset
      return { ...(await pageCall('read', { rich: Boolean(args.rich), offset: Number(args.offset) || 0, limit: Number(args.limit) || 0 }, 6000, view)), locked: lockedHere, tab: wc.id };
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
    case 'pointed': { // Jarvis Code's point and speak: what the hand is on, and a picture of it
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
function fitBounds(b) {
  const z = win && !win.isDestroyed() ? win.webContents.getZoomFactor() || 1 : 1;
  const x = Math.round(b.x * z);
  const y = Math.round(b.y * z);
  return { x, y, width: Math.max(0, Math.round((b.x + b.width) * z) - x), height: Math.max(0, Math.round((b.y + b.height) * z) - y) };
}

ipcMain.handle('browser:show', (event, bounds) => {
  if (!fromWindow(event)) return;
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
  if (browserView && browserShown) {
    win.contentView.removeChildView(browserView);
    browserShown = false;
  }
});
ipcMain.handle('browser:bounds', (event, bounds) => {
  if (!fromWindow(event)) return;
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
  if (action === 'close') closeTab(tabById(id) || browserView);
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
  logDir: LOG_DIR,
  summon: () => summon(), // ⌥Space's show-and-listen (app/features/shell.js: the menu bar's Ask…)
  ownsShortcuts: false, // set by a feature that registers the global shortcuts itself (shell.js: the user's)
  onOpenUrl: (fn) => { openLink = fn; earlyLinks.splice(0).forEach((url) => fn(url)); }, // jarvis:// links
  backend: () => backend, // the running `jarvis serve` (shell.js waits for it to stop when quitting)
};
function loadAppFeatures() {
  const dir = path.join(__dirname, 'features');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort(); } catch { return; }
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
  createWindow();
  loadAppFeatures();
  if (DEV_URL) {
    port = Number(new URL(DEV_URL).port);
    win.loadURL(DEV_URL);
    return;
  }
  port = await freePort();
  startBackend();
  try {
    await waitForBackend();
    win.loadURL(`${appUrl()}?token=${TOKEN}`);
  } catch (err) {
    showProblem(`Jarvis couldn't start: ${err.message}. Details are in ~/Library/Logs/Jarvis/backend.log.`);
  }
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
  showHandHud(false);
  globalShortcut.unregisterAll();
  if (backend) backend.kill('SIGTERM');
});
app.on('window-all-closed', () => {});
