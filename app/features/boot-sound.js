// Eden Code's boot-up sound, the owner's choice ("C'est, c'est, c'est énergétique !", the same 2.1 s
// file Ask Eden, Eden Messenger and Eden Windows open with: daredevil-open.wav here, byte for byte
// app/eden/build/boot-sound.wav), as Ask Eden plays it (app/eden/main.js playBootSound):
// - once per launch, as Eden Code's window first shows (main.js createWindow's show(), which
//   hands it here through ctx.playsBootSound). Never on a reload, never when the window comes back
//   from the Dock or starts hidden at sign-in (show() doesn't call it then), and only in Eden
//   Code: flavor.js lists this file among Eden Code's features, and install() does nothing in any
//   other flavour, so Eden Secretary keeps its own (loading.js, Settings › General's boot_sound).
// - by the system's own player, not the page: the window goes on from loading.html to the
//   backend's page, which would cut a sound played in the page. On the Mac /usr/bin/afplay,
//   from a copy in a fresh folder of its own in the temp folder (it can't read inside
//   app.asar; removed once played), detached, errors ignored,
//   so it follows the Mac's volume and mute: no sound when someone has their volume off. On
//   Windows, PowerShell's SoundPlayer (the file's path through an environment variable, never
//   in the command), hidden. Anywhere else, nothing.
// - quieter (afplay -v 0.4) when a screen reader is on (Electron's accessibilitySupportEnabled,
//   or the Daredevil edition), so it doesn't talk over VoiceOver; on Windows SoundPlayer has no
//   volume, so then it doesn't play at all.
// Whether it plays: Settings › General › "Play the start-up sound" in Eden Code's window
// (web/features/boot-sound.js), through 'feature:boot-sound' (the window only, S32). It's
// kept in Eden Code's own folder (userData/boot-sound.json), to be read before the page loads;
// with no choice there yet, the backend's boot_sound (prefs.json: the switch Eden Code had
// before), else on. No model is called; nothing is sent anywhere. Pure parts exported for
// node --test (tests/web/eden-code-boot-sound.test.mjs).
'use strict';

const path = require('path');

const SETTINGS = 'boot-sound.json';
const SOUND = path.join(__dirname, '..', 'daredevil-open.wav');
const QUIET = '0.4'; // afplay's volume (1 = as it is) while a screen reader speaks
const WINDOWS_PLAY = '(New-Object System.Media.SoundPlayer $env:EDEN_BOOT_SOUND).PlaySync()';

/**
 * The sound and its switch, from what the app gives it (all injectable for tests):
 * userData and dataDir folders, fs, spawn, the platform, the temp folder, and a11y() saying
 * whether a screen reader is on now.
 */
function createBootSound({ userData, dataDir = '', fs, spawn, platform = process.platform, tmpDir, a11y = () => false, sound = SOUND }) {
  const file = () => path.join(userData, SETTINGS);
  let played = false;

  function on() {
    try { return JSON.parse(fs.readFileSync(file(), 'utf8')).on !== false; } catch { /* no choice here yet */ }
    if (!dataDir) return true;
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'prefs.json'), 'utf8')).boot_sound !== false; } catch { return true; }
  }

  // The window's answer to the switch: true/false sets it (a read-only folder keeps it as it
  // was), anything else only asks. Always says what holds now.
  function set(value) {
    if (typeof value === 'boolean') {
      try { fs.writeFileSync(file(), `${JSON.stringify({ on: value })}\n`); } catch { /* read-only: stays as it was */ }
    }
    return on();
  }

  // Once per launch: what it ran (for the trace and the tests), or '' when it stayed quiet.
  function play() {
    if (played || !on()) return '';
    played = true;
    const quiet = Boolean(a11y());
    if (platform !== 'darwin' && platform !== 'win32') return '';
    if (platform === 'win32' && quiet) return ''; // SoundPlayer can't play it softer: not over the reader
    try {
      // A fresh folder of its own each launch (mkdtemp: made by us, 0700), and the copy made
      // only where nothing is (COPYFILE_EXCL): round 2, B1 — at a fixed name in the temp folder,
      // which a session's commands can write, a link planted there made the copy overwrite the
      // file it pointed to (an owner's ~/.zshrc) with the WAV.
      const dir = fs.mkdtempSync(path.join(tmpDir, 'eden-code-boot-'));
      const copy = path.join(dir, 'eden-code-boot-sound.wav');
      fs.copyFileSync(sound, copy, (fs.constants || require('fs').constants).COPYFILE_EXCL);
      const tidy = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the OS's temp sweep */ } };
      const child = platform === 'darwin'
        ? spawn('/usr/bin/afplay', quiet ? ['-v', QUIET, copy] : [copy], { stdio: 'ignore', detached: true })
        : spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WINDOWS_PLAY], {
          stdio: 'ignore', detached: true, windowsHide: true, env: { ...process.env, EDEN_BOOT_SOUND: copy },
        });
      child.on('error', tidy); // (no sound device, no player: nothing to say)
      child.on('exit', tidy);  // (played: the copy goes with it)
      child.unref();
      return platform === 'darwin' ? 'afplay' : 'powershell';
    } catch {
      return ''; // nothing to say
    }
  }

  return { on, set, play };
}

function install(ctx, { fs = require('fs'), spawn = require('child_process').spawn } = {}) {
  if (!ctx.flavor || ctx.flavor.id !== 'eden-code' || typeof ctx.playsBootSound !== 'function') return null;
  const { app } = ctx;
  const sound = createBootSound({
    userData: app.getPath('userData'),
    dataDir: ctx.dataDir,
    fs,
    spawn,
    tmpDir: app.getPath('temp'),
    a11y: () => Boolean(app.accessibilitySupportEnabled) || ctx.flavor.edition === 'daredevil',
  });
  ctx.playsBootSound(() => sound.play());
  ctx.ipcMain.handle('feature:boot-sound', (event, value) => (ctx.fromWindow(event) ? sound.set(value) : null));
  return sound;
}

module.exports = { install, createBootSound, SETTINGS, SOUND, QUIET };
