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
const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'Jarvis');

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
    if (!quitting) showProblem(`The backend stopped (exit ${code}). Details are in ~/Library/Logs/Jarvis/backend.log.`);
  });
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
  win.once('ready-to-show', () => win.show());
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
// A sandboxed page in its own storage partition: no preload, no Node, no access to the
// app. It sits over a slot in the Jarvis window, and Jarvis can drive it.

let browserView = null;
let browserShown = false;

function sendBrowserState() {
  if (!browserView || !win) return;
  const wc = browserView.webContents;
  win.webContents.send('browser:state', {
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canBack: wc.navigationHistory.canGoBack(),
    canForward: wc.navigationHistory.canGoForward(),
  });
}

function ensureBrowser() {
  if (browserView) return browserView;
  browserView = new WebContentsView({
    webPreferences: { partition: 'persist:jarvis-browser', sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const wc = browserView.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) wc.loadURL(url);
    return { action: 'deny' };
  });
  wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  for (const event of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']) {
    wc.on(event, sendBrowserState);
  }
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

const READ_PAGE = `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const links = [...document.querySelectorAll('a[href]')].filter(visible).slice(0, 40)
    .map((a) => ({ text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 80), href: a.href }))
    .filter((l) => l.text);
  const fields = [...document.querySelectorAll('input, textarea, select, button')].filter(visible).slice(0, 30)
    .map((el) => ({ tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', label: (el.getAttribute('aria-label') || el.placeholder || el.innerText || el.value || '').trim().slice(0, 60) }));
  return { title: document.title, url: location.href, text: (document.body ? document.body.innerText : '').slice(0, 15000), links, fields };
})()`;

function clickScript(target) {
  return `(() => {
    const t = ${JSON.stringify(target)};
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    let el = null;
    if (t.selector) { try { el = document.querySelector(t.selector); } catch (e) {} }
    if (!el && t.text) {
      const want = t.text.trim().toLowerCase();
      const pool = [...document.querySelectorAll('a, button, [role=button], input[type=submit], input[type=button], summary, label, [onclick]')].filter(visible);
      el = pool.find((e) => (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().toLowerCase() === want)
        || pool.find((e) => (e.innerText || e.value || e.getAttribute('aria-label') || '').toLowerCase().includes(want));
    }
    if (!el) return { ok: false, message: 'Nothing on the page matches that.' };
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { ok: true, message: 'Clicked ' + (el.innerText || el.value || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 80) };
  })()`;
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

async function runBrowserCommand({ action, args = {} }) {
  const view = ensureBrowser();
  const wc = view.webContents;
  switch (action) {
    case 'open':
      win.webContents.send('browser:open');
      await wc.loadURL(toUrl(args.url)).catch(() => {});
      await waitForLoad(wc);
      return { url: wc.getURL(), title: wc.getTitle() };
    case 'back':
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      await waitForLoad(wc);
      return { url: wc.getURL(), title: wc.getTitle() };
    case 'read':
      if (!wc.getURL()) return { error: 'The browser is empty. Open a page first.' };
      return wc.executeJavaScript(READ_PAGE);
    case 'click': {
      const result = await wc.executeJavaScript(clickScript({ text: args.text || '', selector: args.selector || '' }));
      await waitForLoad(wc, 8000);
      return { ...result, url: wc.getURL(), title: wc.getTitle() };
    }
    case 'type': {
      const focused = await wc.executeJavaScript(focusScript({ selector: args.selector || '', field: args.field || '', replace: true }));
      if (!focused) return { ok: false, message: 'No text field to type into.' };
      await wc.insertText(String(args.text || ''));
      if (args.submit) {
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
        wc.sendInputEvent({ type: 'char', keyCode: '\r' });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
        await waitForLoad(wc, 10000);
      }
      return { ok: true, url: wc.getURL(), title: wc.getTitle() };
    }
    case 'scroll':
      await wc.executeJavaScript(`window.scrollBy(0, ${Number(args.amount || 5) * 120})`);
      return { ok: true };
    case 'screenshot': {
      const image = await wc.capturePage();
      const size = image.getSize();
      const scaled = size.width > 1280 ? image.resize({ width: 1280 }) : image;
      return { png: scaled.toPNG().toString('base64'), url: wc.getURL(), title: wc.getTitle() };
    }
    default:
      return { error: `Unknown browser action ${action}` };
  }
}

function fitBounds(b) {
  return { x: Math.round(b.x), y: Math.round(b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)) };
}

ipcMain.handle('browser:show', (_event, bounds) => {
  const view = ensureBrowser();
  if (!browserShown) {
    win.contentView.addChildView(view);
    browserShown = true;
  }
  view.setBounds(fitBounds(bounds));
  if (!view.webContents.getURL()) view.webContents.loadURL('https://www.google.com');
  sendBrowserState();
});
ipcMain.handle('browser:hide', () => {
  if (browserView && browserShown) {
    win.contentView.removeChildView(browserView);
    browserShown = false;
  }
});
ipcMain.handle('browser:bounds', (_event, bounds) => browserView && browserView.setBounds(fitBounds(bounds)));
ipcMain.handle('browser:nav', async (_event, { action, url }) => {
  const wc = ensureBrowser().webContents;
  if (action === 'go') wc.loadURL(toUrl(url)).catch(() => {});
  if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  if (action === 'reload') wc.reload();
});
ipcMain.handle('browser:command', async (_event, command) => {
  try {
    return await runBrowserCommand(command);
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.on('jarvis:attention', () => {
  if (win && !win.isFocused()) app.dock?.bounce('informational');
});

app.whenReady().then(async () => {
  createWindow();
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
});

app.on('activate', () => win && win.show());
app.on('before-quit', () => {
  quitting = true;
  globalShortcut.unregisterAll();
  if (backend) backend.kill('SIGTERM');
});
app.on('window-all-closed', () => {});
