// Jarvis desktop app: starts the Python backend, shows its window, owns the ⌥Space shortcut.

const { app, BrowserWindow, dialog, globalShortcut, ipcMain, nativeTheme, shell } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

app.setName('Jarvis');

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
    title: 'Jarvis',
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
