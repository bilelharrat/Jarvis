// Per-site permissions in the built-in browser, as Chrome has them: the camera, the
// microphone, location, notifications and reading the clipboard are asked for, once per site,
// in a prompt of the window's own (browser-parity.js shows it), and the answer is kept for that
// site (its origin) until it's changed or forgotten in Settings. "Allow this time" lasts while
// the tab stays on that site. Going full screen and writing to the clipboard need no asking
// (page-permissions.js). MIDI, HID, serial, USB and everything else stay refused.
//
// Pure logic, no Electron: browser-parity.js hands it the session's requests and checks.
'use strict';

const { pagePermission } = require('./page-permissions');

const KINDS = ['camera', 'microphone', 'location', 'notifications', 'clipboard'];
const VALUES = new Set(['allow', 'block']);
const ORIGINS_MAX = 500;
const PENDING_MAX = 6; // prompts one tab may have waiting; more are refused at once

// The permission Electron names, as the kinds a person is asked about (null: never asked).
function kindsFor(permission, details = {}) {
  switch (String(permission)) {
    case 'media': {
      const types = Array.isArray(details.mediaTypes) ? details.mediaTypes
        : details.mediaType ? [details.mediaType] : [];
      const kinds = [];
      if (types.includes('video') || types.includes('unknown')) kinds.push('camera');
      if (types.includes('audio') || types.includes('unknown')) kinds.push('microphone');
      return kinds.length ? kinds : null;
    }
    case 'geolocation': return ['location'];
    case 'notifications': return ['notifications'];
    case 'clipboard-read': return ['clipboard'];
    default: return null;
  }
}

// The site a permission belongs to: a web page's origin, or all local files together.
function originOf(url) {
  const text = String(url || '');
  if (/^file:/i.test(text)) return 'file://';
  try {
    const u = new URL(text);
    return /^https?:$/.test(u.protocol) ? u.origin : '';
  } catch {
    return '';
  }
}

function hostOfOrigin(origin) {
  if (origin === 'file://') return 'Files on this Mac';
  try { return new URL(origin).host; } catch { return String(origin || ''); }
}

// A saved { origin: { kind: 'allow' | 'block' } }, read defensively (a hand-edited or damaged
// file keeps what's valid).
function cleanSites(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [origin, kinds] of Object.entries(raw)) {
    if (Object.keys(out).length >= ORIGINS_MAX) break;
    if (originOf(origin) !== origin || !kinds || typeof kinds !== 'object') continue;
    const kept = {};
    for (const kind of KINDS) if (VALUES.has(kinds[kind])) kept[kind] = kinds[kind];
    if (Object.keys(kept).length) out[origin] = kept;
  }
  return out;
}

class SitePermissions {
  // store: { sites } (kept by the caller, saved through onSave); a private window's has none.
  constructor({ sites = {}, onSave = () => {}, onChange = () => {}, remember = true } = {}) {
    this.sites = cleanSites(sites);
    this.onSave = onSave;
    this.onChange = onChange; // the prompts waiting changed
    this.remember = remember;
    this.grants = new Map(); // tab id -> { origin, kinds: Set } (Allow this time)
    this.pending = []; // { id, tab, origin, kinds, at, resolvers }
    this.seq = 0;
  }

  decision(origin, kind) {
    const site = this.sites[origin];
    return (site && site[kind]) || 'ask';
  }

  granted(tab, origin, kind) {
    const g = this.grants.get(tab);
    return Boolean(g && g.origin === origin && g.kinds.has(kind));
  }

  allowed(tab, origin, kind) {
    return this.decision(origin, kind) === 'allow' || this.granted(tab, origin, kind);
  }

  // What a page may know or do without a prompt (navigator.permissions, Notification.permission,
  // device names): notifications only when allowed (a page that's told "granted" shows them
  // without asking); the rest unless blocked, so a page (Meet, Maps) goes on to ask, and the
  // ask is the prompt.
  check({ tab, origin, permission, details = {} }) {
    if (pagePermission(permission)) return true;
    const kinds = kindsFor(permission, details);
    if (!kinds || !origin) return false;
    if (kinds.includes('notifications')) return this.allowed(tab, origin, 'notifications');
    return kinds.every((k) => this.decision(origin, k) !== 'block');
  }

  // A page asking: answered at once when the site's answer is known, otherwise it waits for
  // the person's (a promise of true or false).
  request({ tab, origin, permission, details = {} }) {
    if (pagePermission(permission)) return Promise.resolve(true);
    const kinds = kindsFor(permission, details);
    if (!kinds || !origin) return Promise.resolve(false);
    if (kinds.some((k) => this.decision(origin, k) === 'block')) return Promise.resolve(false);
    const open = kinds.filter((k) => !this.allowed(tab, origin, k));
    if (!open.length) return Promise.resolve(true);
    return new Promise((resolve) => {
      const same = this.pending.find((p) => p.tab === tab && p.origin === origin && sameKinds(p.kinds, open));
      if (same) { same.resolvers.push(resolve); return; }
      if (this.pending.filter((p) => p.tab === tab).length >= PENDING_MAX) { resolve(false); return; }
      this.pending.push({ id: `p${++this.seq}`, tab, origin, kinds: open, at: this.seq, resolvers: [resolve] });
      this.onChange();
    });
  }

  // The person's answer: 'allow' (kept for the site), 'once' (this tab, while it's on the
  // site), 'block' (kept), 'dismiss' (refused this time, nothing kept).
  answer(id, choice) {
    const p = this.pending.find((x) => x.id === id);
    if (!p) return false;
    if (choice === 'allow' || choice === 'block') {
      for (const kind of p.kinds) this.setDecision(p.origin, kind, choice, { save: false });
      this.save();
    } else if (choice === 'once') {
      const g = this.grants.get(p.tab);
      const kinds = g && g.origin === p.origin ? g.kinds : new Set();
      for (const kind of p.kinds) kinds.add(kind);
      this.grants.set(p.tab, { origin: p.origin, kinds });
    }
    this.finish(p, choice === 'allow' || choice === 'once');
    this.resettle(p.origin);
    this.onChange();
    return true;
  }

  // What an answer or a change in Settings decided for the prompts still waiting on that site.
  resettle(origin) {
    let changed = false;
    for (const p of this.pending.slice()) {
      if (p.origin !== origin) continue;
      if (p.kinds.some((k) => this.decision(p.origin, k) === 'block')) { this.finish(p, false); changed = true; }
      else if (p.kinds.every((k) => this.allowed(p.tab, p.origin, k))) { this.finish(p, true); changed = true; }
    }
    return changed;
  }

  finish(p, ok) {
    const at = this.pending.indexOf(p);
    if (at < 0) return;
    this.pending.splice(at, 1);
    for (const resolve of p.resolvers) resolve(ok);
  }

  // The tab showed a new page: what its old page asked goes unanswered (refused), and an
  // Allow this time ends when it leaves that site.
  navigated(tab, origin) {
    let changed = false;
    for (const p of this.pending.slice()) {
      if (p.tab === tab) { this.finish(p, false); changed = true; }
    }
    const g = this.grants.get(tab);
    if (g && g.origin !== origin) this.grants.delete(tab);
    if (changed) this.onChange();
  }

  closed(tab) {
    this.grants.delete(tab);
    this.navigated(tab, '');
  }

  // The first prompt a tab is waiting on (the window shows one at a time).
  waiting(tab) {
    return this.pending.filter((p) => p.tab === tab).sort((a, b) => a.at - b.at)[0] || null;
  }

  // ── Settings ──

  setDecision(origin, kind, value, { save = true } = {}) {
    if (!originOf(origin) || originOf(origin) !== origin || !KINDS.includes(kind)) return false;
    if (VALUES.has(value)) {
      if (!this.sites[origin] && Object.keys(this.sites).length >= ORIGINS_MAX) return false;
      this.sites[origin] = { ...(this.sites[origin] || {}), [kind]: value };
    } else if (this.sites[origin]) {
      delete this.sites[origin][kind];
      if (!Object.keys(this.sites[origin]).length) delete this.sites[origin];
    }
    if (save) {
      this.save();
      if (this.resettle(origin)) this.onChange();
    }
    return true;
  }

  forget(origin) {
    if (!this.sites[origin]) return false;
    delete this.sites[origin];
    for (const [tab, g] of this.grants) if (g.origin === origin) this.grants.delete(tab);
    this.save();
    return true;
  }

  list() {
    return Object.entries(this.sites)
      .map(([origin, kinds]) => ({ origin, host: hostOfOrigin(origin), kinds: { ...kinds } }))
      .sort((a, b) => a.host.localeCompare(b.host));
  }

  save() {
    if (this.remember) this.onSave(this.sites);
  }
}

function sameKinds(a, b) {
  return a.length === b.length && a.every((k) => b.includes(k));
}

module.exports = { SitePermissions, KINDS, kindsFor, originOf, hostOfOrigin, cleanSites };
