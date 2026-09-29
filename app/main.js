// Jarvis desktop app: starts the Python backend, shows its window, owns the ⌥Space shortcut.

const { app, BrowserWindow, WebContentsView, dialog, globalShortcut, ipcMain, nativeTheme, shell } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

app.setName('J.A.R.V.I.S.');

const TOKEN = crypto.randomBytes(24).toString('hex');
const SHORTCUT = 'Alt+Space';
const WHATS_THIS = 'Alt+Shift+Space'; // explain whatever is in front of you
const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'Jarvis');
// Development only: show a backend that's already running (no microphone of its own)
// instead of starting one, with a profile of its own and without the global shortcuts,
// so it can run beside the installed app.
const DEV_URL = process.env.JARVIS_BACKEND_URL || '';
if (DEV_URL) app.setPath('userData', path.join(os.tmpdir(), 'jarvis-dev-profile'));

let win = null;
let backend = null;
let port = 0;
let quitting = false;

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

function startBackend() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const log = fs.createWriteStream(path.join(LOG_DIR, 'backend.log'), { flags: 'a' });
  log.write(`\n--- ${new Date().toISOString()} starting on port ${port}\n`);
  backend = spawn(findUv(), ['run', '--directory', jarvisHome(), 'jarvis', 'serve', '--port', String(port)], {
    env: {
      ...process.env,
      JARVIS_TOKEN: TOKEN,
      PYTHONUNBUFFERED: '1',
      PATH: [...EXTRA_PATH, process.env.PATH || '/usr/bin:/bin'].join(':'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  if (restarts.length >= 3) {
    showProblem(`The backend stopped (exit ${code}) three times in five minutes. Details are in ~/Library/Logs/Jarvis/backend.log.`);
    return;
  }
  restarts.push(now);
  showProblem(`The backend stopped (exit ${code}). Starting it again…`);
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
let browserView = null;
let browserShown = false;
let browserLocked = false;
let browserSynthetic = false; // true only while Jarvis itself sends input
let browserZoom = 1; // this session's zoom; Chromium would otherwise keep one per host forever
let researchBase = '';
const pageCalls = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function researchOrigin() {
  try { return new URL(researchBase).origin; } catch { return ''; }
}

function onResearch(url) {
  try { return Boolean(researchBase) && new URL(url).origin === researchOrigin(); } catch { return false; }
}

function sendBrowserState(extra = {}) {
  if (!browserView || !win) return;
  const wc = browserView.webContents;
  const url = wc.getURL();
  win.webContents.send('browser:state', {
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
  let pathname = '/';
  try { pathname = new URL(wc.getURL()).pathname; } catch {}
  browserLocked = onResearch(wc.getURL()) && !RESEARCH_AUTH.test(pathname);
  wc.send('jarvis:locked', browserLocked);
  sendBrowserState();
}

function ensureBrowser() {
  if (browserView) return browserView;
  browserView = new WebContentsView({
    webPreferences: {
      partition: 'persist:jarvis-browser',
      preload: path.join(__dirname, 'page-preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const wc = browserView.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) wc.loadURL(url);
    return { action: 'deny' };
  });
  wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  // On the Research Center, direct input never reaches the page (Jarvis's own does).
  wc.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && win) win.webContents.send('browser:escape');
    if (browserLocked && !browserSynthetic) event.preventDefault();
  });
  wc.on('before-mouse-event', (event) => { if (browserLocked && !browserSynthetic) event.preventDefault(); });
  for (const event of ['did-navigate', 'did-navigate-in-page']) wc.on(event, updateLock);
  wc.on('did-finish-load', () => wc.setZoomFactor(browserZoom));
  for (const event of ['page-title-updated', 'did-start-loading', 'did-stop-loading']) wc.on(event, () => sendBrowserState());
  wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      const where = onResearch(url) || (researchBase && url.startsWith(researchBase)) ? `The Research Center at ${researchOrigin()}` : url || 'The page';
      sendBrowserState({ error: `${where} isn't answering (${description}).` });
    }
  });
  wc.on('render-process-gone', () => sendBrowserState({ error: 'The page stopped. Reload it.' }));
  return browserView;
}

function toUrl(input) {
  const text = String(input || '').trim();
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(text)) return `https://${text}`;
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
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
      el = [...document.querySelectorAll('input, textarea, [contenteditable=true]')].filter(visible)
        .find((e) => ((e.getAttribute('aria-label') || '') + ' ' + (e.placeholder || '') + ' ' + (e.name || '')).toLowerCase().includes(want));
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

function browserInput(fn) {
  browserSynthetic = true;
  try { fn(browserView.webContents); } finally { browserSynthetic = false; }
}

function clickAt(x, y) {
  browserInput((wc) => {
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  });
}

function pageCall(action, args = {}, ms = 6000) {
  return new Promise((resolve) => {
    const id = crypto.randomBytes(6).toString('hex');
    const timer = setTimeout(() => {
      pageCalls.delete(id);
      resolve({ ok: false, message: 'The page did not answer.' });
    }, ms);
    pageCalls.set(id, (result) => { clearTimeout(timer); resolve(result || {}); });
    browserView.webContents.send('jarvis:command', { id, action, args });
  });
}

// The Research Center: the app's own router moves within it; a first visit loads it.
async function researchOpen(pathname) {
  const wc = ensureBrowser().webContents;
  const target = `${researchBase.replace(/\/+$/, '')}${typeof pathname === 'string' && pathname.startsWith('/') ? pathname : '/markets'}`;
  if (onResearch(wc.getURL()) && !wc.isLoading()) {
    const moved = await pageCall('navigate', { path: new URL(target).pathname }, 3000);
    if (moved.ok) return;
  }
  await wc.loadURL(target).catch(() => {});
}

const fromPage = (event) => browserView && event.sender === browserView.webContents;
const fromWindow = (event) => win && event.sender === win.webContents;

ipcMain.on('page:result', (event, message) => {
  if (!fromPage(event) || !message) return;
  const done = pageCalls.get(message.id);
  if (done) {
    pageCalls.delete(message.id);
    done(message.result);
  }
});
ipcMain.on('page:hover', (event, hover) => { if (fromPage(event)) win.webContents.send('browser:hover', hover); });
ipcMain.on('page:note', (event, note) => { if (fromPage(event)) win.webContents.send('browser:note', note); });
ipcMain.on('page:pointer', (event, p) => {
  if (!fromPage(event) || !p) return;
  browserInput((wc) => wc.sendInputEvent({ type: 'mouseMove', x: Number(p.x) || 0, y: Number(p.y) || 0 }));
});
ipcMain.on('page:click', (event, p) => {
  if (fromPage(event) && p) clickAt(Number(p.x) || 0, Number(p.y) || 0);
});

async function runBrowserCommand({ action, args = {} }) {
  const view = ensureBrowser();
  const wc = view.webContents;
  const where = () => ({ url: wc.getURL(), title: wc.getTitle() });
  const signIn = onResearch(wc.getURL()) && !browserLocked;
  if (signIn && ['click', 'type', 'search'].includes(action)) {
    return { error: 'The Research Center is on its sign-in page. The user signs in themselves; after that I can drive it.' };
  }
  switch (action) {
    case 'open':
      win.webContents.send('browser:open');
      await wc.loadURL(toUrl(args.url)).catch(() => {});
      await waitForLoad(wc);
      return { url: wc.getURL(), title: wc.getTitle() };
    case 'research':
      win.webContents.send('browser:open');
      if (/^https?:\/\//.test(String(args.base || ''))) researchBase = args.base;
      if (!researchBase) return { error: 'No Research Center address is set.' };
      await researchOpen(String(args.path || '/markets'));
      await waitForLoad(wc, 15000);
      return { ok: true, ...where() };
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
      return { ...(await pageCall('read')), locked: browserLocked };
    case 'click': {
      const found = await pageCall('locate', { text: String(args.text || ''), selector: String(args.selector || '') });
      if (!found.ok) return found;
      if (found.risky && !args.force) {
        return { ok: false, needsConfirm: true, label: found.label, message: `“${found.label}” needs the user's OK first.` };
      }
      clickAt(found.x, found.y);
      await waitForLoad(wc, 8000);
      return { ok: true, message: `Clicked “${found.label}”`, ...where() };
    }
    case 'type': {
      const focused = await wc.executeJavaScript(focusScript({ selector: args.selector || '', field: args.field || '', replace: true }));
      if (!focused) return { ok: false, message: 'No text field to type into.' };
      await wc.insertText(String(args.text || ''));
      if (args.submit) {
        browserInput((view2) => {
          view2.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
          view2.sendInputEvent({ type: 'char', keyCode: '\r' });
          view2.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
        });
        await waitForLoad(wc, 10000);
      }
      return { ok: true, ...where() };
    }
    case 'search': {
      const query = String(args.query || '').slice(0, 80);
      let done = await pageCall('search', { query });
      if (!done.ok && researchBase) {
        await researchOpen('/market-radar'); // the Research Center's market desk has the search box
        await waitForLoad(wc, 15000);
        await sleep(700);
        done = await pageCall('search', { query });
      }
      if (!done.ok) return done;
      await waitForLoad(wc, 8000);
      return { ok: true, message: `Searched for ${query}`, ...where() };
    }
    case 'scroll': {
      const direction = args.direction || (Number(args.amount) < 0 ? 'up' : 'down');
      const amount = Math.abs(Number(args.amount || 1)) || 1;
      return { ...(await pageCall('scroll', { direction, amount })), ...where() };
    }
    case 'zoom': {
      const now = wc.getZoomFactor();
      const next = args.direction === 'in' ? now * 1.15 : args.direction === 'out' ? now / 1.15 : 1;
      browserZoom = Math.min(1.8, Math.max(0.6, next));
      wc.setZoomFactor(browserZoom);
      sendBrowserState();
      return { ok: true, zoom: Math.round(browserZoom * 100) };
    }
    case 'screenshot': {
      const image = await wc.capturePage();
      const size = image.getSize();
      const scaled = size.width > 1280 ? image.resize({ width: 1280 }) : image;
      return { png: scaled.toPNG().toString('base64'), ...where() };
    }
    default:
      return { error: `Unknown browser action ${action}` };
  }
}

function fitBounds(b) {
  return { x: Math.round(b.x), y: Math.round(b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)) };
}

ipcMain.handle('browser:show', (event, bounds) => {
  if (!fromWindow(event)) return;
  const view = ensureBrowser();
  if (!browserShown) {
    win.contentView.addChildView(view);
    browserShown = true;
  }
  view.setBounds(fitBounds(bounds));
  if (!view.webContents.getURL()) view.webContents.loadURL('https://www.google.com');
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
  if (fromWindow(event) && browserView && browserShown) browserView.setBounds(fitBounds(bounds));
});
ipcMain.handle('browser:nav', async (event, { action, url }) => {
  if (!fromWindow(event)) return;
  const wc = ensureBrowser().webContents;
  if (action === 'go') wc.loadURL(toUrl(url)).catch(() => {});
  if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  if (action === 'reload') wc.reload();
  if (action === 'stop') wc.stop();
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

app.whenReady().then(async () => {
  createWindow();
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
app.on('before-quit', () => {
  quitting = true;
  globalShortcut.unregisterAll();
  if (backend) backend.kill('SIGTERM');
});
app.on('window-all-closed', () => {});
