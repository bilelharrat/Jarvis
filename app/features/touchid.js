// Touch ID for Eden Code's riskiest moments (web/features/code-touchid.js asks): before a
// session goes into Bypass permissions, new sessions are set to start in it, or a risky step
// is allowed, macOS's own Touch ID sheet. The reason it shows is the app's own wording for
// the kind of moment, never text from the page; only the window may ask (ctx.fromWindow), and
// one sheet at a time.
//
// A yes also gives the window a proof for the backend (audit S30): the window's own word that
// the finger said yes is only as good as the page, so the main process, which saw macOS's
// answer, signs it. "v1.<kind>.<expires ms>.<nonce>.<mac>", the mac an HMAC-SHA256 under the
// backend's token (which the page never needs to sign anything) of
// "eden-touchid|v1|<kind>|<expires>|<nonce>"; it holds for PROOF_MS and once only
// (features/code_touchid.py check_proof). No token yet (no backend): no proof.
'use strict';

const crypto = require('crypto');

const PROOF_MS = 2 * 60 * 1000;

// The proof for kind, under key: '' without a key.
function makeProof(key, kind, { now = Date.now(), nonce = crypto.randomBytes(16).toString('hex') } = {}) {
  if (!key || !/^[a-z-]{1,32}$/.test(String(kind))) return '';
  const expires = now + PROOF_MS;
  const mac = crypto.createHmac('sha256', String(key)).update(`eden-touchid|v1|${kind}|${expires}|${nonce}`).digest('hex');
  return `v1.${kind}.${expires}.${nonce}.${mac}`;
}

const REASONS = {
  en: {
    bypass: 'turn on Bypass permissions in Eden Code',
    'bypass-default': 'start new Eden Code sessions in Bypass permissions',
    approve: 'allow a risky step in Eden Code',
  },
  zh: {
    bypass: '在 Eden Code 中开启绕过权限',
    'bypass-default': '让新的 Eden Code 会话以绕过权限开始',
    approve: '允许 Eden Code 中一个有风险的步骤',
  },
};

function handlers({ systemPreferences, secret = () => '' }) {
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
        const proof = makeProof(secret(), kind);
        return proof ? { ok: true, proof } : { ok: true };
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
  const h = handlers({ systemPreferences, secret: () => (ctx.backendToken ? ctx.backendToken() : '') });
  ctx.ipcMain.handle('feature:touchid:available', (event) => (ctx.fromWindow(event) ? h.available() : false));
  ctx.ipcMain.handle('feature:touchid:prompt', (event, kind, lang) => (ctx.fromWindow(event) ? h.prompt(String(kind), String(lang)) : { ok: false }));
}

module.exports = { install, handlers, makeProof, REASONS, PROOF_MS };
