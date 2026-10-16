// "Check it yourself" (features/code_selfcheck.py, app/features/self-check.js): the pure
// rules, kept apart from Electron so plain Node can test them (tests/web/self-check.test.mjs).
//
// - Where the hidden preview may be: a page on this Mac (http or https on localhost,
//   127.x, ::1, *.localhost) whose origin is one the backend named for this check (the
//   project's own dev servers, and the page the session opened), or a file inside the
//   project's own folder. Never another site, never a file outside the project (the S29
//   rule: a file nobody opened on purpose is never read).
// - What a press may do there (the S31 rule, in the main process, never by the page's own
//   labels alone): a link or a form that leaves those pages is refused; a form with a card
//   number or a password in it waits for the owner's yes (the session's approval card);
//   anything else on the project's own page goes ahead, as a session's own browser tab's
//   presses on a page on this Mac do (browser_agent.CodeSession.press_ok).
'use strict';

const path = require('path');
const { fileURLToPath } = require('url');

function isLoopback(url) {
  let u;
  try { u = new URL(String(url || '')); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

function originOf(url) {
  try { return new URL(String(url)).origin; } catch { return ''; }
}

// A file: address's path, or '' for anything else (or one that isn't a plain local file).
function filePath(url) {
  let u;
  try { u = new URL(String(url || '')); } catch { return ''; }
  if (u.protocol !== 'file:' || (u.hostname && u.hostname !== 'localhost')) return '';
  try { return path.resolve(fileURLToPath(u)); } catch { return ''; }
}

function inside(file, root) {
  if (!file || !root) return false;
  const rel = path.relative(path.resolve(root), file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// rules: { origins: ['http://127.0.0.1:5173', …], root: '/the/project' }. real: a path's
// real place (symlinks followed), for a file: one (the app passes fs.realpathSync).
function allowed(url, rules = {}, real = (p) => p) {
  const text = String(url || '');
  if (text === 'about:blank') return true;
  if (isLoopback(text)) {
    const origins = Array.isArray(rules.origins) ? rules.origins.map(String) : [];
    return origins.includes(originOf(text));
  }
  const file = filePath(text);
  if (!file || !rules.root) return false;
  let where;
  try { where = real(file); } catch { return false; }  // not there: nothing to read
  let root;
  try { root = real(path.resolve(String(rules.root))); } catch { return false; }
  return inside(where, root);
}

// What the backend asked for, cleaned: the origins (only pages on this Mac) and the root.
function cleanRules(raw = {}) {
  const origins = [...new Set((Array.isArray(raw.origins) ? raw.origins : [])
    .filter((o) => isLoopback(o)).map(originOf).filter(Boolean))].slice(0, 20);
  const root = typeof raw.root === 'string' && path.isAbsolute(raw.root) ? path.resolve(raw.root) : '';
  return { origins, root };
}

// The press's verdict: { go: 'ok' | 'ask' | 'refuse', why }. info: what the element is
// (browser-agent.js's DESCRIBE: href, submits); form: its form (FORM_INFO), or null.
function pressVerdict(info, form, rules, real) {
  const i = info && typeof info === 'object' ? info : {};
  if (i.href && !/^(javascript:|#)/i.test(i.href) && !allowed(i.href, rules, real)) {
    return { go: 'refuse', why: `That link leaves the project's own app (${String(i.href).slice(0, 200)}).` };
  }
  const f = form && typeof form === 'object' ? form : null;
  if (f && f.action && !allowed(f.action, rules, real)) {
    return { go: 'refuse', why: `That form is sent outside the project's own app (${String(f.action).slice(0, 200)}).` };
  }
  if (f && (f.payment || f.password)) {
    return { go: 'ask', why: f.payment ? 'a form with a card number in it' : 'a form with a password in it' };
  }
  return { go: 'ok', why: '' };
}

// A form's facts, worked out on the element itself in the page (the agent's own world).
const FORM_INFO = `function () {
  const f = this.form || (this.closest && this.closest('form'));
  if (!f) return null;
  const has = (sel) => { try { return Boolean(f.querySelector(sel)); } catch { return false; } };
  return {
    action: f.getAttribute('action') ? String(f.action || '') : '',
    method: String(f.method || 'get').toLowerCase(),
    password: has('input[type=password]'),
    payment: has('[autocomplete^="cc-"], input[name*="card" i], input[name*="cvc" i], input[name*="cvv" i]'),
  };
}`;

module.exports = { isLoopback, originOf, filePath, inside, allowed, cleanRules, pressVerdict, FORM_INFO };
