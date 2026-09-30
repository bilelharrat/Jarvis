// Touch ID for Jarvis Code's riskiest moments (web/features/code-touchid.js asks): before a
// session goes into Bypass permissions, new sessions are set to start in it, or a risky step
// is allowed, macOS's own Touch ID sheet. The reason it shows is the app's own wording for
// the kind of moment, never text from the page; only the window may ask (ctx.fromWindow), and
// one sheet at a time.
'use strict';

const REASONS = {
  en: {
    bypass: 'turn on Bypass permissions in Jarvis Code',
    'bypass-default': 'start new Jarvis Code sessions in Bypass permissions',
    approve: 'allow a risky step in Jarvis Code',
  },
  zh: {
    bypass: '在 Jarvis Code 中开启绕过权限',
    'bypass-default': '让新的 Jarvis Code 会话以绕过权限开始',
    approve: '允许 Jarvis Code 中一个有风险的步骤',
  },
};

function handlers({ systemPreferences }) {
  let busy = false;
  const available = () => {
    try { return Boolean(systemPreferences && systemPreferences.canPromptTouchID()); } catch { return false; }
  };
  return {
    available,
    // { ok } once the owner's finger says yes; { unavailable } where there's no Touch ID (the
    // window asks its usual question then), { busy } while another sheet is up, and
    // { cancelled } for a no, a cancel or a lockout (never a way round it).
    async prompt(kind, lang) {
      const reason = (REASONS[lang] || REASONS.en)[kind];
      if (!reason) return { ok: false, error: 'unknown' };
      if (!available()) return { ok: false, unavailable: true };
      if (busy) return { ok: false, busy: true };
      busy = true;
      try {
        await systemPreferences.promptTouchID(reason);
        return { ok: true };
      } catch {
        return { ok: false, cancelled: true };
      } finally {
        busy = false;
      }
    },
  };
}

function install(ctx) {
  const { systemPreferences } = require('electron');
  const h = handlers({ systemPreferences });
  ctx.ipcMain.handle('feature:touchid:available', (event) => (ctx.fromWindow(event) ? h.available() : false));
  ctx.ipcMain.handle('feature:touchid:prompt', (event, kind, lang) => (ctx.fromWindow(event) ? h.prompt(String(kind), String(lang)) : { ok: false }));
}

module.exports = { install, handlers, REASONS };
