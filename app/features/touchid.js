// Touch ID for Eden Code's riskiest moments (web/features/code-touchid.js asks): before a
// session goes into Bypass permissions, new sessions are set to start in it, or a risky step
// is allowed, macOS's own Touch ID sheet. The reason it shows is the app's own wording for
// the kind of moment, never text from the page; only the window may ask (ctx.fromWindow), and
// one sheet at a time.
//
// A yes also gives the window a proof for the backend (audit S30): the window's own word that
// the finger said yes is only as good as the page, so the main process, which saw macOS's
// answer, signs it. "v2.<kind>.<subject>.<expires ms>.<nonce>.<mac>", the mac an HMAC-SHA256
// under the proof key of "eden-touchid|v2|<kind>|<subject>|<expires>|<nonce>"; it holds for
// PROOF_MS, once only, and only for its subject (features/code_touchid.py check_proof): the
// card a risky step's yes is for (its approval id), the session Bypass is for (its id, or
// 'new'), '' for the kinds with no one thing to name (round 3, R2-12: a yes for one card was
// good for any other of its kind that came up within the two minutes). The key is one this app gave the backend it started
// on its stdin (proof-pipe.js, ctx.proofKey), never the backend's token: the page has the
// token, so a script in the window could sign with it (round 1 A1).
//
// No key (the window is on the other app's backend, backend-share.js): no sheet here, the
// answer is { relay } and the window asks the backend, which asks the app that started it
// (code_touchid_ask); that app's ask() shows its sheet and signs (ctx.onProofAsk).
//
// On a Mac without Touch ID (or with it turned off), confirm() asks with the app's own dialog
// instead (the same fixed words, never the page's), and signs that yes the same way: the
// page alone still can't make a proof.
//
// On Windows (item 49), Windows Hello asks instead (windowsHello below: the face, fingerprint
// or PIN sheet of Windows' own UserConsentVerifier, through Windows PowerShell 5.1, which is
// on every Windows 10 and 11 and knows WinRT types; PowerShell 7 doesn't). Its reason is the
// same fixed words. A PC without Windows Hello set up (or with it turned off by policy) says
// so, and the app's own dialog asks then, signed the same: prompt() falls back to confirm()'s
// dialog itself, so the window's question never changes.
'use strict';

const crypto = require('crypto');
const path = require('path');

const PROOF_MS = 2 * 60 * 1000;

const SUBJECT = /^[A-Za-z0-9_-]{0,40}$/;

// The proof for kind and subject, under key: '' without a key (or with a subject that isn't one).
function makeProof(key, kind, { subject = '', now = Date.now(), nonce = crypto.randomBytes(16).toString('hex') } = {}) {
  subject = String(subject || '');
  if (!key || !/^[a-z-]{1,32}$/.test(String(kind)) || !SUBJECT.test(subject)) return '';
  const expires = now + PROOF_MS;
  const mac = crypto.createHmac('sha256', String(key)).update(`eden-touchid|v2|${kind}|${subject}|${expires}|${nonce}`).digest('hex');
  return `v2.${kind}.${subject}.${expires}.${nonce}.${mac}`;
}

const REASONS = {
  en: {
    bypass: 'turn on Bypass permissions in Eden Code',
    'bypass-default': 'start new Eden Code sessions in Bypass permissions',
    approve: 'allow a risky step in Eden Code',
    'touchid-off': 'turn off Touch ID for Bypass and risky steps in Eden Code',
    rules: 'let Eden Code do much more without asking you',
  },
  zh: {
    bypass: '在 Eden Code 中开启绕过权限',
    'bypass-default': '让新的 Eden Code 会话以绕过权限开始',
    approve: '允许 Eden Code 中一个有风险的步骤',
    'touchid-off': '关闭 Eden Code 中绕过权限和有风险步骤的触控 ID',
    rules: '让 Eden Code 不经询问就做更多的事',
  },
};

const CONFIRM = {
  en: { allow: 'Allow', cancel: 'Cancel', detail: 'Eden Code needs your OK for this.' },
  zh: { allow: '允许', cancel: '取消', detail: 'Eden Code 需要你的确认。' },
};

// Windows Hello through Windows PowerShell: one line out, 'result:<UserConsentVerificationResult>'
// or 'unavailable:<why>'. The reason comes in an environment variable, never on the command
// line, so no quoting of it can go wrong (and it's the app's fixed words anyway).
const HELLO_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '  $null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]',
  "  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1",
  '  function Wait-Op($op, [Type]$type) { $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $null = $task.Wait(-1); $task.Result }',
  '  $have = Wait-Op ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])',
  "  if ([string]$have -ne 'Available') { Write-Output ('unavailable:' + $have); exit 0 }",
  '  $said = Wait-Op ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync($env:EDEN_HELLO_REASON)) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])',
  "  Write-Output ('result:' + $said)",
  "} catch { Write-Output 'unavailable:error' }",
].join('\n');
const HELLO_MS = 3 * 60 * 1000;  // the sheet waits for the owner; then it's a no
// What Windows Hello's answer means here: 'ok', 'cancelled' (a no, a cancel, too many tries,
// busy), or 'unavailable' (not set up, no device, turned off by policy: the dialog asks then).
function helloAnswer(out) {
  const line = String(out || '').trim().split(/\r?\n/).pop() || '';
  if (line === 'result:Verified') return 'ok';
  if (/^unavailable:/.test(line) || /^result:(DeviceNotPresent|NotConfiguredForUser|DisabledByPolicy)$/.test(line)) return 'unavailable';
  if (/^result:/.test(line)) return 'cancelled';
  return 'unavailable';  // (PowerShell missing or broken: nothing said yes; the dialog asks)
}
// The Windows PowerShell of this PC, by its full path (System32's: never one found on the PATH).
function windowsPowerShell(env = process.env) {
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
function windowsHello({ execFile = require('child_process').execFile, env = process.env } = {}) {
  let absent = false;  // Windows Hello said it isn't set up: the dialog from then on
  return {
    get available() { return !absent; },
    verify(reason) {
      return new Promise((resolve) => {
        execFile(windowsPowerShell(env), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', HELLO_SCRIPT],
          { env: { ...env, EDEN_HELLO_REASON: `Eden Code: ${reason}` }, windowsHide: true, timeout: HELLO_MS },
          (error, stdout) => {
            const said = error && !stdout ? 'unavailable' : helloAnswer(stdout);
            if (said === 'unavailable') absent = true;
            resolve(error && error.killed ? 'cancelled' : said);
          });
      });
    },
  };
}

function handlers({ systemPreferences, secret = () => '', dialog = null, parent = () => null, hello = null }) {
  let busy = false;
  const touchId = () => {
    try { return Boolean(systemPreferences && systemPreferences.canPromptTouchID && systemPreferences.canPromptTouchID()); } catch { return false; }
  };
  const available = () => touchId() || Boolean(hello && hello.available);
  // The app's own dialog (the same fixed words), its Allow signed: { ok, proof } or { cancelled }.
  async function askDialog(kind, lang, subject) {
    if (!dialog) return { ok: false, cancelled: true };
    const words = REASONS[lang] ? lang : 'en';
    const reason = REASONS[words][kind];
    const c = CONFIRM[words];
    const options = {
      type: 'warning', buttons: [c.allow, c.cancel], defaultId: 1, cancelId: 1, noLink: true,
      message: reason.charAt(0).toUpperCase() + reason.slice(1) + '?', detail: c.detail,
    };
    const win = parent();
    const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (response !== 0) return { ok: false, cancelled: true };
    const proof = makeProof(secret(), kind, { subject });
    return proof ? { ok: true, proof } : { ok: true };
  }
  return {
    available,
    // { ok } once the owner's finger says yes; { unavailable } where there's no Touch ID (the
    // window asks its usual question then), { busy } while another sheet is up, and
    // { cancelled } for a no, a cancel or a lockout (never a way round it).
    async prompt(kind, lang, subject = '') {
      const reason = (REASONS[lang] || REASONS.en)[kind];
      if (!reason) return { ok: false, error: 'unknown' };
      if (!secret()) return { ok: false, relay: true }; // (the app that started the backend asks)
      if (!available()) return { ok: false, unavailable: true };
      if (busy) return { ok: false, busy: true };
      busy = true;
      try {
        if (!touchId() && hello) {  // Windows Hello, or the dialog where it isn't set up
          const said = await hello.verify(reason);
          if (said === 'unavailable') return await askDialog(kind, lang, subject);
          if (said !== 'ok') return { ok: false, cancelled: true };
        } else {
          await systemPreferences.promptTouchID(reason);
        }
        const proof = makeProof(secret(), kind, { subject });
        return proof ? { ok: true, proof } : { ok: true };
      } catch {
        return { ok: false, cancelled: true };
      } finally {
        busy = false;
      }
    },
    // Without Touch ID: the app's own dialog, { ok, proof } for its Allow; { unsupported }
    // with no dialog to ask with, or while Touch ID could ask (prompt is the way then).
    async confirm(kind, lang, subject = '') {
      const words = REASONS[lang] ? lang : 'en';
      const reason = REASONS[words][kind];
      if (!reason) return { ok: false, error: 'unknown' };
      if (!secret()) return { ok: false, relay: true };
      if (!dialog || available()) return { ok: false, unsupported: true };
      if (busy) return { ok: false, busy: true };
      busy = true;
      try {
        return await askDialog(kind, words, subject);
      } catch {
        return { ok: false, cancelled: true };
      } finally {
        busy = false;
      }
    },
    // The backend this app started, asking for the other app's window (proof-pipe.js): this
    // app's sheet, or its own dialog without Touch ID; the proof, or '' for anything else.
    async ask(kind, lang, subject = '') {
      const got = available() ? await this.prompt(kind, lang, subject) : await this.confirm(kind, lang, subject);
      return got && got.ok && got.proof ? got.proof : '';
    },
  };
}

function install(ctx) {
  const { systemPreferences, dialog, BrowserWindow } = require('electron');
  const h = handlers({
    systemPreferences, dialog, secret: () => (ctx.proofKey ? ctx.proofKey() : ''),
    hello: process.platform === 'win32' ? windowsHello() : null,
    parent: () => (BrowserWindow && BrowserWindow.getFocusedWindow ? BrowserWindow.getFocusedWindow() : null),
  });
  ctx.ipcMain.handle('feature:touchid:available', (event) => (ctx.fromWindow(event) ? h.available() : false));
  const subj = (subject) => String(subject == null ? '' : subject);
  ctx.ipcMain.handle('feature:touchid:prompt', (event, kind, lang, subject) => (ctx.fromWindow(event) ? h.prompt(String(kind), String(lang), subj(subject)) : { ok: false }));
  ctx.ipcMain.handle('feature:touchid:confirm', (event, kind, lang, subject) => (ctx.fromWindow(event) ? h.confirm(String(kind), String(lang), subj(subject)) : { ok: false }));
  if (ctx.onProofAsk) ctx.onProofAsk((kind, lang, subject) => h.ask(String(kind), String(lang), subj(subject)));
}

module.exports = { install, handlers, makeProof, windowsHello, helloAnswer, windowsPowerShell, HELLO_SCRIPT, REASONS, CONFIRM, PROOF_MS };
