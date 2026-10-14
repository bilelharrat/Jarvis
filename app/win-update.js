// Updates on Windows: the installers people download are GitHub pre-releases behind askeden.com,
// and https://askeden.com/windows/latest.json says each one's version, size, file name and
// SHA-256. This checks it (a while after launch, then once a day, and when the owner asks), and
// when this app's own flavor (flavor.js: Eden Secretary or Eden Daredevil) has a newer version
// it tells the owner, and waits. Only after their yes (the window's Install now; when Eden
// Secretary is in the middle of something it says so first, since the install stops it) it
// downloads that installer into the app's own data folder (updates/, not Downloads, where
// anything else can write), checks its size and SHA-256 against latest.json, checks its
// Authenticode signature names Eden's publisher, runs it silently (it closes the app, replaces
// it and opens it again: electron-builder's NSIS /S with --force-run) and quits so nothing
// holds the files. A download that stalls (nothing for STALL_MS) is given up, its .part removed.
//
// latest.json is trusted only when it's signed (audit S8): Ed25519, by the key whose public half
// is FEED_PUBLIC_KEY below, over the exact text of its "signed" member, which holds the entries
// ({ "signed": "{\"jarvis\": {version, size, file, sha256}, …}", "signature": "<base64>" }; the
// same entries may also sit at the top level, unsigned, for copies older than this one, and are
// never read from there). scripts/release/sign-feed.js makes it, with the private key from the
// owner's Keychain. Until FEED_PUBLIC_KEY is filled in, nothing is ever installed: each check
// says so in words the owner can act on (WORDS.nokey: updates need the signing key, see
// sign-feed.js), without asking askeden.com for a list it couldn't trust anyway.
//
// Pure: the network, the disk, the process and the notification are passed in (app/features/
// updates.js gives Electron's; the tests give stand-ins).
'use strict';

const crypto = require('crypto');
const path = require('path');
const { compareVersions, parseVersion } = require('./update-feed');

// The feed's public key: Ed25519, its 32 bytes as base64url (sign-feed.js --public prints it).
// Empty until the owner makes the key: then no update is ever offered.
const FEED_PUBLIC_KEY = '';
// The Authenticode publisher the installers must be signed by (the certificate's CN, as
// electron-builder signs with WIN_CSC_LINK). Empty while the installers are unsigned: then the
// signature isn't asked for (the signed feed's SHA-256 still is), and the log says so.
const PUBLISHER = '';
const STALL_MS = 60 * 1000;

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
  latest: 'The update list on askeden.com isn’t one Eden Secretary can read.',
  download: 'The update couldn’t be downloaded.',
  size: 'The download wasn’t the size it should be, so it wasn’t run.',
  run: 'The installer couldn’t be started.',
  signature: 'The update list on askeden.com isn’t signed by Eden, so nothing was installed.',
  // This copy was built before the feed's signing key existed (FEED_PUBLIC_KEY is empty).
  nokey: 'Updates need Eden’s signing key, which isn’t built into this copy yet, so none are installed. '
    + 'Make it with app/scripts/release/sign-feed.js and put its --public half in FEED_PUBLIC_KEY (app/win-update.js).',
  checksum: 'The download isn’t the file Eden published, so it wasn’t run.',
  publisher: 'The installer isn’t signed by Eden, so it wasn’t run.',
};

// The feed's key as Node takes it, or null when there's none (or it isn't one).
function feedKey(publicKey) {
  const x = String(publicKey || '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(x)) return null;
  try { return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' }); } catch { return null; }
}

// The signed entries of latest.json: the text its signature covers, parsed. Throws (code
// 'signature') when there's no key, no signature, or one that doesn't verify.
function signedEntries(data, publicKey) {
  const key = feedKey(publicKey);
  const fail = (why) => Object.assign(new Error(why), { code: 'signature' });
  if (!key) throw fail('no feed key is built into this copy');
  const signed = data && typeof data.signed === 'string' ? data.signed : '';
  const signature = data && typeof data.signature === 'string' ? data.signature : '';
  if (!signed || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw fail("latest.json isn't signed");
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(signed, 'utf8'), key, Buffer.from(signature, 'base64')); } catch { ok = false; }
  if (!ok) throw fail("latest.json's signature doesn't verify");
  try { return JSON.parse(signed); } catch { throw new Error("latest.json's signed part isn't JSON"); }
}

// This flavor's entry of latest.json's signed part: {version, size, file, sha256}, or throws in
// words for the log.
function entryFor(text, flavor, { publicKey = FEED_PUBLIC_KEY } = {}) {
  if (typeof text !== 'string' || text.length > MAX_LATEST) throw new Error('latest.json is too big');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("latest.json isn't JSON"); }
  const entries = signedEntries(data, publicKey);
  const entry = entries && typeof entries === 'object' ? entries[flavor] : null;
  if (!entry || typeof entry !== 'object') throw new Error(`latest.json has no ${flavor}`);
  const version = String(entry.version || '');
  const file = String(entry.file || '');
  const size = Number(entry.size);
  if (!parseVersion(version)) throw new Error(`latest.json's ${flavor} version isn't one`);
  if (!FILE.test(file)) throw new Error(`latest.json's ${flavor} file isn't an installer's name`);
  if (!Number.isInteger(size) || size <= 0 || size > MAX_SIZE) throw new Error(`latest.json's ${flavor} size isn't one`);
  const sha256 = String(entry.sha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`latest.json's ${flavor} has no SHA-256`);
  return { version, file, size, sha256 };
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
  version, flavor, name = 'Eden Secretary', fetchText, download, runInstaller, saveDir,
  hashFile, checkSigner = async () => ({ ok: true, unchecked: true }), busy = async () => false, removeFile = async () => {},
  publicKey = FEED_PUBLIC_KEY, onChange = () => {}, log = () => {}, tell = () => {}, quit = () => {},
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
    if (!feedKey(publicKey)) {
      // No key to check a list with: unsigned lists stay refused, and the owner hears why.
      log('update: no feed key is built into this copy (FEED_PUBLIC_KEY); see sign-feed.js');
      offered = null;
      set({ state: 'error', error: WORDS.nokey, nokey: true });
      return;
    }
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
      entry = entryFor(text, key, { publicKey });
    } catch (err) {
      log(`update: ${err.message}`);
      set({ state: 'error', error: err.code === 'signature' ? WORDS.signature : WORDS.latest });
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

  async function install({ force = false } = {}) {
    const entry = offered;
    // In the middle of something (a turn, meeting notes, a task): said first, installed only on a second yes.
    if (!force && (await busy().catch(() => true))) {
      set({ ...state, busy: true });
      return 'busy';
    }
    set({ state: 'downloading', available: entry.version, size: entry.size, received: 0 });
    const target = path.join(saveDir(), entry.file);
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
    // The very file the signed list names, and (once the installers are signed) Eden's own signature on it.
    const refuse = async (why, words) => {
      log(`update: ${entry.file}: ${why}; removed`);
      await removeFile(target).catch(() => {});
      set({ state: 'error', error: words, available: entry.version });
      return false;
    };
    let sum = '';
    try { sum = String(await hashFile(target)).toLowerCase(); } catch (err) { sum = `unreadable (${err && err.message})`; }
    if (sum !== entry.sha256) return refuse(`SHA-256 ${sum}, not ${entry.sha256}`, WORDS.checksum);
    let signer;
    try { signer = await checkSigner(target); } catch (err) { signer = { ok: false, why: err && err.message }; }
    if (!signer || !signer.ok) return refuse(`not signed by Eden's publisher (${(signer && (signer.why || signer.subject)) || 'no answer'})`, WORDS.publisher);
    if (signer.unchecked) log('update: no Authenticode publisher is set in this copy: only the SHA-256 was checked');
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
    // ever starts it. 'busy' when Eden Secretary is in the middle of something: the window asks,
    // and a second yes says force.
    install({ force = false } = {}) {
      if (!offered || !['available', 'error'].includes(state.state)) return Promise.resolve(false);
      if (!installing) installing = install({ force }).finally(() => { installing = null; });
      return installing;
    },
  };
}

// The installer, saved at target as it comes (a .part file, put in place once it is whole):
// over Electron's network stack, following askeden.com's redirect to GitHub, refusing any other
// host and anything bigger than said. A download that sends nothing for stallMs (the answer,
// or the next piece of it) is given up: aborted, its .part removed (W25). Gives the bytes written.
async function downloadTo(net, fs, url, target, { size, allowed, progress = () => {}, stallMs = STALL_MS }) {
  const controller = new AbortController();
  let timer = null;
  const stalled = new Promise((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error(`the download stalled (nothing for ${Math.round(stallMs / 1000)} s)`)));
  });
  stalled.catch(() => {});
  const poke = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), stallMs); // (cleared once the download ends, either way)
  };
  poke();
  let response;
  try {
    response = await Promise.race([net.fetch(url, { cache: 'no-store', redirect: 'follow', signal: controller.signal }), stalled]);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
  if (!response.ok) { clearTimeout(timer); throw new Error(`HTTP ${response.status}`); }
  if (!allowed(response.url || url)) { clearTimeout(timer); throw new Error(`the download came from ${response.url}`); }
  const partial = `${target}.part`;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const out = fs.createWriteStream(partial);
  let received = 0;
  let reader = null;
  try {
    reader = response.body.getReader();
    for (;;) {
      poke();
      const { done, value } = await Promise.race([reader.read(), stalled]);
      if (done) break;
      received += value.length;
      if (received > size) throw new Error('bigger than said');
      if (!out.write(Buffer.from(value))) await new Promise((resolve) => out.once('drain', resolve));
      progress(received);
    }
    clearTimeout(timer);
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    clearTimeout(timer);
    controller.abort();
    if (reader && reader.cancel) reader.cancel().catch(() => {});
    out.destroy();
    await fs.promises.rm(partial, { force: true });
    throw err;
  }
  if (received === size) await fs.promises.rename(partial, target);
  else await fs.promises.rm(partial, { force: true });
  return received;
}

// A file's SHA-256, as hex, read as a stream.
function sha256Of(fs, file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}

// The installer's Authenticode signature, as Windows itself reads it (Get-AuthenticodeSignature):
// { ok } only for a valid signature whose signer is publisher (its CN). The file's path goes in
// through the environment, never into the command. With no publisher set: { ok, unchecked }.
function authenticode(execFile, file, publisher = PUBLISHER) {
  if (!publisher) return Promise.resolve({ ok: true, unchecked: true });
  const script = "$s = Get-AuthenticodeSignature -LiteralPath $env:EDEN_UPDATE_FILE; [Console]::Out.Write([string]$s.Status + '|' + [string]$s.SignerCertificate.Subject)";
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env: { ...process.env, EDEN_UPDATE_FILE: file }, windowsHide: true, timeout: 60_000 }, (err, stdout) => {
        if (err) { resolve({ ok: false, why: err.message }); return; }
        const [status, subject = ''] = String(stdout || '').trim().split('|');
        const cn = (/(?:^|,\s*)CN=("?)([^,"]+)\1/.exec(subject) || [])[2] || '';
        resolve({ ok: status === 'Valid' && cn === publisher, status, subject });
      });
  });
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
  createWinUpdater, entryFor, signedEntries, feedKey, allowedUrl, downloadTo, startInstaller, sha256Of, authenticode,
  LATEST_URL, DOWNLOAD_URL, INSTALLER_ARGS, WORDS, FIRST_CHECK, CHECK_EVERY, FEED_PUBLIC_KEY, PUBLISHER, STALL_MS,
};
