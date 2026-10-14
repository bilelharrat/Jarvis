// Touch ID for Eden Code's riskiest moments (web/features/code-touchid.js asks): before a
// session goes into Bypass permissions, new sessions are set to start in it, or a risky step
// is allowed, macOS's own Touch ID sheet. The reason it shows is the app's own wording for
// the kind of moment, never text from the page; only the window may ask (ctx.fromWindow), and
// one sheet at a time.
//
// A yes also gives the window a proof for the backend (audit S30): the window's own word that
// the finger said yes is only as good as the page, so the main process, which saw macOS's
// answer, signs it. "v1.<kind>.<expires ms>.<nonce>.<mac>", the mac an HMAC-SHA256 under the
// proof key of "eden-touchid|v1|<kind>|<expires>|<nonce>"; it holds for PROOF_MS and once only
// (features/code_touchid.py check_proof). The key is one this app gave the backend it started
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
    'touchid-off': 'turn off Touch ID for Bypass and risky steps in Eden Code',
  },
  zh: {
    bypass: '在 Eden Code 中开启绕过权限',
    'bypass-default': '让新的 Eden Code 会话以绕过权限开始',
    approve: '允许 Eden Code 中一个有风险的步骤',
    'touchid-off': '关闭 Eden Code 中绕过权限和有风险步骤的触控 ID',
  },
};

const CONFIRM = {
  en: { allow: 'Allow', cancel: 'Cancel', detail: 'Eden Code needs your OK for this.' },
  zh: { allow: '允许', cancel: '取消', detail: 'Eden Code 需要你的确认。' },
};

function handlers({ systemPreferences, secret = () => '', dialog = null, parent = () => null }) {
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
      if (!secret()) return { ok: false, relay: true }; // (the app that started the backend asks)
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
    // Without Touch ID: the app's own dialog, { ok, proof } for its Allow; { unsupported }
    // with no dialog to ask with, or while Touch ID could ask (prompt is the way then).
    async confirm(kind, lang) {
      const words = REASONS[lang] ? lang : 'en';
      const reason = REASONS[words][kind];
      if (!reason) return { ok: false, error: 'unknown' };
      if (!secret()) return { ok: false, relay: true };
      if (!dialog || available()) return { ok: false, unsupported: true };
      if (busy) return { ok: false, busy: true };
      busy = true;
      try {
        const c = CONFIRM[words];
        const options = {
          type: 'warning', buttons: [c.allow, c.cancel], defaultId: 1, cancelId: 1, noLink: true,
          message: reason.charAt(0).toUpperCase() + reason.slice(1) + '?', detail: c.detail,
        };
        const win = parent();
        const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
        if (response !== 0) return { ok: false, cancelled: true };
        const proof = makeProof(secret(), kind);
        return proof ? { ok: true, proof } : { ok: true };
      } catch {
        return { ok: false, cancelled: true };
      } finally {
        busy = false;
      }
    },
    // The backend this app started, asking for the other app's window (proof-pipe.js): this
    // app's sheet, or its own dialog without Touch ID; the proof, or '' for anything else.
    async ask(kind, lang) {
      const got = available() ? await this.prompt(kind, lang) : await this.confirm(kind, lang);
      return got && got.ok && got.proof ? got.proof : '';
    },
  };
}

function install(ctx) {
  const { systemPreferences, dialog, BrowserWindow } = require('electron');
  const h = handlers({
    systemPreferences, dialog, secret: () => (ctx.proofKey ? ctx.proofKey() : ''),
    parent: () => (BrowserWindow && BrowserWindow.getFocusedWindow ? BrowserWindow.getFocusedWindow() : null),
  });
  ctx.ipcMain.handle('feature:touchid:available', (event) => (ctx.fromWindow(event) ? h.available() : false));
  ctx.ipcMain.handle('feature:touchid:prompt', (event, kind, lang) => (ctx.fromWindow(event) ? h.prompt(String(kind), String(lang)) : { ok: false }));
  ctx.ipcMain.handle('feature:touchid:confirm', (event, kind, lang) => (ctx.fromWindow(event) ? h.confirm(String(kind), String(lang)) : { ok: false }));
  if (ctx.onProofAsk) ctx.onProofAsk((kind, lang) => h.ask(String(kind), String(lang)));
}

module.exports = { install, handlers, makeProof, REASONS, CONFIRM, PROOF_MS };
