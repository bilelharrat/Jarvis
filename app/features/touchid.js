// Touch ID for Eden Code's riskiest moments (web/features/code-touchid.js asks): before a
// session goes into Bypass permissions, new sessions are set to start in it, Touch ID itself
// is switched off, a Bypass session is taken out of the sandbox, or a risky step is allowed,
// macOS's own Touch ID sheet. The reason it shows is the app's own wording for the kind of
// moment, never text from the page; only the window may ask (ctx.fromWindow), and one sheet
// at a time. On a Mac without Touch ID the app asks with a dialog of its own instead (one the
// page can't answer for it).
//
// A yes comes with a proof the backend checks before it lets the step happen
// (src/jarvis/features/code_touchid.py): "<kind>|<ts>|<nonce>" signed (HMAC-SHA256) with the
// key in the data folder's touchid.key, which only this process and the backend read. A page
// or anything else that can reach the backend's socket has no key, so it can't make one.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REASONS = {
  en: {
    bypass: 'turn on Bypass permissions in Eden Code',
    'bypass-default': 'start new Eden Code sessions in Bypass permissions',
    'touchid-off': 'turn off Touch ID for Eden Code',
    'sandbox-off': 'take an Eden Code session in Bypass permissions out of the sandbox',
    approve: 'allow a risky step in Eden Code',
  },
  zh: {
    bypass: '在 Eden Code 中开启绕过权限',
    'bypass-default': '让新的 Eden Code 会话以绕过权限开始',
    'touchid-off': '关闭 Eden Code 的触控 ID',
    'sandbox-off': '让一个绕过权限的 Eden Code 会话离开沙盒',
    approve: '允许 Eden Code 中一个有风险的步骤',
  },
};
// The kinds the backend checks a proof for (code_touchid.KINDS).
const PROVED = new Set(['bypass', 'bypass-default', 'touchid-off', 'sandbox-off']);
const KEY_FILE = 'touchid.key';

// sign(kind) -> { kind, ts, nonce, sig }, or null when there's no key to sign with.
function signer(dataDir, { readFile = fs.readFileSync, now = Date.now, random = crypto.randomBytes } = {}) {
  return (kind) => {
    if (!PROVED.has(kind)) return null;
    let key = '';
    try { key = String(readFile(path.join(dataDir, KEY_FILE), 'ascii')).trim(); } catch { return null; }
    if (!/^[0-9a-f]{64}$/.test(key)) return null;
    const ts = Math.floor(now() / 1000);
    const nonce = random(16).toString('hex');
    const sig = crypto.createHmac('sha256', Buffer.from(key, 'ascii')).update(`${kind}|${ts}|${nonce}`).digest('hex');
    return { kind, ts, nonce, sig };
  };
}

function handlers({ systemPreferences, sign = null, confirm = null }) {
  let busy = false;
  const available = () => {
    try { return Boolean(systemPreferences && systemPreferences.canPromptTouchID()); } catch { return false; }
  };
  const yes = (kind) => {
    const proof = sign ? sign(kind) : null;
    return proof ? { ok: true, proof } : { ok: true };
  };
  return {
    available,
    // { ok, proof? } once the owner's finger (or, without Touch ID, the app's own dialog)
    // says yes; { unavailable } where neither can ask (the window asks its usual question
    // then), { busy } while another sheet is up, and { cancelled } for a no, a cancel or a
    // lockout (never a way round it).
    async prompt(kind, lang) {
      const reason = (REASONS[lang] || REASONS.en)[kind];
      if (!reason) return { ok: false, error: 'unknown' };
      const touch = available();
      if (!touch && !confirm) return { ok: false, unavailable: true };
      if (busy) return { ok: false, busy: true };
      busy = true;
      try {
        if (touch) await systemPreferences.promptTouchID(reason);
        else if (!(await confirm(reason, lang))) return { ok: false, cancelled: true };
        return yes(kind);
      } catch {
        return { ok: false, cancelled: true };
      } finally {
        busy = false;
      }
    },
  };
}

function install(ctx) {
  const { systemPreferences, dialog } = require('electron');
  let dataDir = '';
  try { dataDir = require('../platform-paths').dataDir(); } catch { dataDir = ''; }
  const confirm = dialog && typeof dialog.showMessageBox === 'function'
    ? async (reason, lang) => {
      const zh = lang === 'zh';
      const win = ctx.getWindow && ctx.getWindow();
      const options = {
        type: 'question',
        message: zh ? `Eden 想要${reason}。` : `Eden wants to ${reason}.`,
        buttons: zh ? ['允许', '取消'] : ['Allow', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      };
      const asked = win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
      return (await asked).response === 0;
    }
    : null;
  const h = handlers({ systemPreferences, sign: dataDir ? signer(dataDir) : null, confirm });
  ctx.ipcMain.handle('feature:touchid:available', (event) => (ctx.fromWindow(event) ? h.available() : false));
  ctx.ipcMain.handle('feature:touchid:prompt', (event, kind, lang) => (ctx.fromWindow(event) ? h.prompt(String(kind), String(lang)) : { ok: false }));
}

module.exports = { install, handlers, signer, REASONS, PROVED, KEY_FILE };
