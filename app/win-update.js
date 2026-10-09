// Updates on Windows: the installers people download are GitHub pre-releases behind askeden.com,
// and https://askeden.com/windows/latest.json says each one's version, size and file name
// ({ jarvis: {version, size, file}, daredevil: {…}, … }). This checks it (a while after launch,
// then once a day, and when the owner asks), and when this app's own flavor (flavor.js:
// J.A.R.V.I.S. or J.A.R.V.I.S. Daredevil) has a newer version it tells the owner, and waits.
// Only after their yes (the window's Install now) it downloads that installer into Downloads,
// checks it is the size latest.json said, runs it silently (it closes the app, replaces it and
// opens it again: electron-builder's NSIS /S with --force-run) and quits so nothing holds the files.
//
// Pure: the network, the disk, the process and the notification are passed in (app/features/
// updates.js gives Electron's; the tests give stand-ins).
'use strict';

const path = require('path');
const { compareVersions, parseVersion } = require('./update-feed');

const LATEST_URL = 'https://askeden.com/windows/latest.json';
const DOWNLOAD_URL = { jarvis: 'https://askeden.com/jarvis/windows', daredevil: 'https://askeden.com/daredevil/windows' };
// Where the download may come from: askeden.com's route sends it on to the GitHub release.
const HOSTS = new Set(['askeden.com', 'www.askeden.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const FILE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,119}-x64\.exe$/;
const MAX_SIZE = 2 * 1024 * 1024 * 1024;
const MAX_LATEST = 64 * 1024;
const INSTALLER_ARGS = ['/S', '--force-run'];
const FIRST_CHECK = 2 * 60 * 1000;
const CHECK_EVERY = 24 * 60 * 60 * 1000;

const WORDS = {
  offline: 'Couldn’t reach askeden.com to check for updates.',
  latest: 'The update list on askeden.com isn’t one J.A.R.V.I.S. can read.',
  download: 'The update couldn’t be downloaded.',
  size: 'The download wasn’t the size it should be, so it wasn’t run.',
  run: 'The installer couldn’t be started.',
};

// This flavor's entry of latest.json: {version, size, file}, or throws in words for the log.
function entryFor(text, flavor) {
  if (typeof text !== 'string' || text.length > MAX_LATEST) throw new Error('latest.json is too big');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("latest.json isn't JSON"); }
  const entry = data && typeof data === 'object' ? data[flavor] : null;
  if (!entry || typeof entry !== 'object') throw new Error(`latest.json has no ${flavor}`);
  const version = String(entry.version || '');
  const file = String(entry.file || '');
  const size = Number(entry.size);
  if (!parseVersion(version)) throw new Error(`latest.json's ${flavor} version isn't one`);
  if (!FILE.test(file)) throw new Error(`latest.json's ${flavor} file isn't an installer's name`);
  if (!Number.isInteger(size) || size <= 0 || size > MAX_SIZE) throw new Error(`latest.json's ${flavor} size isn't one`);
  return { version, file, size };
}

// Whether an address the download went through may serve it.
function allowedUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && HOSTS.has(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
}

function createWinUpdater({
  version, flavor, name = 'J.A.R.V.I.S.', fetchText, download, runInstaller, downloadsDir,
  onChange = () => {}, log = () => {}, tell = () => {}, quit = () => {},
}) {
  const key = flavor === 'daredevil' ? 'daredevil' : 'jarvis';
  let state = { state: 'idle' };
  let offered = null; // {version, file, size} while one is available or being installed
  let checking = null;
  let installing = null;
  let told = ''; // the version the owner was last told about (once each)

  const public_ = () => ({ version, name, enabled: true, platform: 'win32', ...state });
  const set = (next) => { state = next; onChange(public_()); };

  async function run() {
    set({ state: 'checking' });
    let text;
    try {
      text = await fetchText(LATEST_URL);
    } catch (err) {
      log(`update: latest.json didn't answer (${err && err.message})`);
      set({ state: 'error', error: WORDS.offline });
      return;
    }
    let entry;
    try {
      entry = entryFor(text, key);
    } catch (err) {
      log(`update: ${err.message}`);
      set({ state: 'error', error: WORDS.latest });
      return;
    }
    if (compareVersions(entry.version, version) <= 0) {
      offered = null;
      set({ state: 'current', checked: Date.now() });
      return;
    }
    offered = entry;
    set({ state: 'available', available: entry.version, size: entry.size, file: entry.file });
    if (told !== entry.version) {
      told = entry.version;
      tell(`${name} ${entry.version} is available. Open ${name} and choose Install now to update.`);
    }
  }

  async function install() {
    const entry = offered;
    set({ state: 'downloading', available: entry.version, size: entry.size, received: 0 });
    const target = path.join(downloadsDir(), entry.file);
    try {
      const got = await download(DOWNLOAD_URL[key], target, {
        size: entry.size,
        allowed: allowedUrl,
        progress: (received) => {
          if (state.state !== 'downloading') return;
          // The window hears every tenth of the way (a screen reader isn't read every chunk).
          const tenth = Math.floor((10 * received) / entry.size);
          const before = Math.floor((10 * (state.received || 0)) / entry.size);
          if (tenth > before) set({ ...state, received });
          else state = { ...state, received };
        },
      });
      if (got !== entry.size) {
        log(`update: ${entry.file} came to ${got} bytes, not ${entry.size}`);
        set({ state: 'error', error: WORDS.size, available: entry.version });
        return false;
      }
    } catch (err) {
      log(`update: the download failed (${err && err.message})`);
      set({ state: 'error', error: WORDS.download, available: entry.version });
      return false;
    }
    set({ state: 'installing', available: entry.version, path: target });
    try {
      await runInstaller(target, INSTALLER_ARGS);
    } catch (err) {
      log(`update: the installer didn't start (${err && err.message})`);
      set({ state: 'error', error: WORDS.run, available: entry.version, path: target });
      return false;
    }
    quit(); // the installer replaces the app's files: nothing of it may hold them open
    return true;
  }

  return {
    state: public_,
    // A check now (a while after launch, the daily timer, or Check for updates). One at a time;
    // none while an update downloads or installs.
    check() {
      if (['downloading', 'installing'].includes(state.state)) return Promise.resolve(public_());
      if (!checking) checking = run().finally(() => { checking = null; });
      return checking.then(public_);
    },
    // The owner's yes: download and run the installer of the version offered. Nothing else
    // ever starts it.
    install() {
      if (!offered || !['available', 'error'].includes(state.state)) return Promise.resolve(false);
      if (!installing) installing = install().finally(() => { installing = null; });
      return installing;
    },
  };
}

// The installer, saved at target as it comes (a .part file, put in place once it is whole):
// over Electron's network stack, following askeden.com's redirect to GitHub, refusing any other
// host and anything bigger than said. Gives the bytes written.
async function downloadTo(net, fs, url, target, { size, allowed, progress = () => {} }) {
  const response = await net.fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!allowed(response.url || url)) throw new Error(`the download came from ${response.url}`);
  const partial = `${target}.part`;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const out = fs.createWriteStream(partial);
  let received = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > size) throw new Error('bigger than said');
      if (!out.write(Buffer.from(value))) await new Promise((resolve) => out.once('drain', resolve));
      progress(received);
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    await fs.promises.rm(partial, { force: true });
    throw err;
  }
  if (received === size) await fs.promises.rename(partial, target);
  else await fs.promises.rm(partial, { force: true });
  return received;
}

// The installer started on its own (it outlives this app, which it closes).
function startInstaller(spawn, file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

module.exports = {
  createWinUpdater, entryFor, allowedUrl, downloadTo, startInstaller,
  LATEST_URL, DOWNLOAD_URL, INSTALLER_ARGS, WORDS, FIRST_CHECK, CHECK_EVERY,
};
