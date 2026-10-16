// "Check it yourself" in the app itself (features/code_selfcheck.py asks for it through the
// window, as the Preview check does): an Eden Code session opens its own app's page in a
// hidden preview of its own, reads it as an accessibility tree whose elements carry refs
// ([e12]), clicks, types and scrolls by those refs, reads the page's console errors and the
// requests that failed, and takes pictures of it, before it says its work is done.
//
// - Where: one hidden preview per session (offscreen, sandboxed, a partition of its own that
//   keeps nothing between runs, no permissions, no downloads, no popups), closed when the
//   check ends or after IDLE_CLOSE_MS unused. The owner's browser tabs are never touched.
// - What it may show (self-check-lib.js, checked here in the main process, never by the
//   page): only the pages the backend named for this check (the project's own dev servers
//   and the page opened, all on this Mac), or a file inside the project's own folder. A
//   page that tries to go anywhere else (a link, a redirect, a form, a frame) is stopped,
//   and the stop is said in the check's findings. Eden's own pages (its windows' backend,
//   which is on this Mac too) are never among them: a check can't press Eden's own buttons.
// - Its hands are the browser agent's (browser-agent.js: the same snapshot, refs and real
//   input as a session's own browser tab), with the S31 rule on every press: what the click
//   really does (the link, the form it sends) is checked here, not just the page's label.
// - What a page says goes back as the page's words: the backend marks it as outside text.
'use strict';

const fs = require('fs');
const { BrowserWindow, session, nativeImage } = require('electron');
const { createAgent } = require('../browser-agent');
const { CdpError } = require('../browser-cdp');
const lib = require('../self-check-lib');

const PARTITION = 'jarvis-self-check'; // not persist: nothing kept between runs
const IDLE_CLOSE_MS = 10 * 60 * 1000;
const PREVIEWS_MAX = 4; // sessions checking at once; the longest unused closes for a fifth
const LOAD_MS = 20000;
const SHOT_WIDTH = 1280;
const THUMB_WIDTH = 360;
const BLOCKED_KEPT = 20;
const PRESSES = new Set(['click', 'dblclick', 'rightclick', 'check', 'uncheck']);

const real = (p) => fs.realpathSync(p);
const previews = new Map(); // session key -> { win, view, rules, timer, blocked: [] }
let previewSession = null;

function entryFor(wcId) {
  for (const entry of previews.values()) {
    if (!entry.win.isDestroyed() && entry.win.webContents.id === wcId) return entry;
  }
  return null;
}

function noteBlocked(entry, url) {
  if (!entry) return;
  entry.blocked.push(String(url).slice(0, 300));
  if (entry.blocked.length > BLOCKED_KEPT) entry.blocked.shift();
}

function ensureSession() {
  if (previewSession) return previewSession;
  const ses = session.fromPartition(PARTITION);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (event) => event.preventDefault());
  // A page (or a frame in it) going anywhere the check wasn't given is stopped here, in the
  // main process: whatever the page's own script does to get there.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const type = details.resourceType;
    if (type !== 'mainFrame' && type !== 'subFrame') { callback({}); return; }
    const entry = entryFor(details.webContentsId);
    if (!entry) { callback({ cancel: true }); return; }
    if (lib.allowed(details.url, entry.rules, real)) { callback({}); return; }
    noteBlocked(entry, details.url);
    callback({ cancel: true });
  });
  previewSession = ses;
  return ses;
}

// The browser agent over the hidden previews only: its "tabs" are theirs.
const agent = createAgent({
  tabs: () => [...previews.values()].filter((e) => !e.win.isDestroyed()).map((e) => e.view),
  ensureBrowser: () => { throw new CdpError('Open the page first (check_open).', 'closed'); },
  isShown: () => true, // offscreen previews draw: input, hovering and pictures all work
  setSynthetic: () => {},
  addTab: () => { throw new CdpError('The check has one page; it opens no tabs.', 'closed'); },
  blankTab: () => null,
  select: () => {},
  close: () => false,
  showBrowser: () => {},
  markAsked: () => {},
  toUrl: (url) => String(url || ''),
  research: () => false,
  pageCall: async () => ({ ok: false, message: 'Not in the hidden preview.' }),
  pickFiles: async () => [], // no uploads: a file is only ever one the owner picks
  askUser: async () => false, // a page's question nobody answered: Cancel
});

function closeOne(key) {
  const entry = previews.get(key);
  if (!entry) return false;
  previews.delete(key);
  clearTimeout(entry.timer);
  if (!entry.win.isDestroyed()) entry.win.destroy();
  return true;
}

function closeAll() {
  for (const key of [...previews.keys()]) closeOne(key);
}

function touch(key, entry) {
  clearTimeout(entry.timer);
  entry.used = Date.now();
  entry.timer = setTimeout(() => closeOne(key), IDLE_CLOSE_MS);
  if (entry.timer.unref) entry.timer.unref();
}

function preview(key, width, height) {
  let entry = previews.get(key);
  if (entry && !entry.win.isDestroyed()) {
    entry.win.setContentSize(width, height);
    return entry;
  }
  if (previews.size >= PREVIEWS_MAX) {
    const oldest = [...previews.entries()].sort((a, b) => a[1].used - b[1].used)[0];
    if (oldest) closeOne(oldest[0]);
  }
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: {
      offscreen: true,
      session: ensureSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const wc = win.webContents;
  wc.setAudioMuted(true);
  wc.setWindowOpenHandler(({ url }) => { noteBlocked(entryFor(wc.id), url); return { action: 'deny' }; });
  entry = { win, view: { webContents: wc, agentOwner: `selfcheck:${key}` }, rules: { origins: [], root: '' }, timer: null, used: Date.now(), blocked: [] };
  const stay = (event, url) => {
    if (!lib.allowed(url, entry.rules, real)) { event.preventDefault(); noteBlocked(entry, url); }
  };
  wc.on('will-navigate', stay);
  wc.on('will-redirect', stay);
  wc.on('will-frame-navigate', (event) => { if (!lib.allowed(event.url, entry.rules, real)) { event.preventDefault(); noteBlocked(entry, event.url); } });
  win.on('closed', () => { if (previews.get(key) === entry) previews.delete(key); });
  previews.set(key, entry);
  return entry;
}

function loaded(wc, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; clearTimeout(timer); resolve(ok); } };
    const timer = setTimeout(() => finish(false), ms);
    wc.once('did-stop-loading', () => finish(true));
  });
}

function where(entry) {
  const wc = entry.win.webContents;
  return { tab: wc.id, url: wc.getURL(), title: wc.getTitle(), blocked: entry.blocked.slice() };
}

// The origins Eden's own windows are on (the backend's page): never a check's to open.
function appOrigins() {
  const out = new Set();
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || w.webContents.isOffscreen()) continue;
    const o = lib.originOf(w.webContents.getURL());
    if (o && o !== 'null') out.add(o);
  }
  return out;
}

// ── one call ──

async function open(key, args) {
  const rules = lib.cleanRules(args.rules || {});
  const own = appOrigins();
  rules.origins = rules.origins.filter((o) => !own.has(o));
  const url = String(args.url || '');
  if (own.has(lib.originOf(url))) return { ok: false, message: 'That is Eden’s own page, not the project’s app.' };
  if (!lib.allowed(url, rules, real)) {
    return { ok: false, message: 'Only the project’s own app is checked: a page on this Mac from its dev server, or a file inside the project.' };
  }
  const width = Math.max(320, Math.min(1920, Number(args.width) || 1280));
  const height = Math.max(320, Math.min(1400, Number(args.height) || 800));
  const entry = preview(key, width, height);
  entry.rules = rules;
  entry.blocked = [];
  touch(key, entry);
  const wc = entry.win.webContents;
  // Watched from before its page loads: all of its console messages and requests are kept.
  const tab = agent.tab(entry.view);
  tab.keep = true;
  if (!wc.getURL()) await wc.loadURL('about:blank').catch(() => {});
  await tab.cdp.ensure().catch(() => {});
  const done = loaded(wc, LOAD_MS);
  wc.loadURL(url).catch(() => {});
  const finished = await done;
  return { ok: true, loaded: finished, ...where(entry) };
}

// A press goes ahead only if what it really does stays in the project's own app (S31).
async function pressCheck(entry, args) {
  const kind = String(args.kind || 'click').toLowerCase();
  const pressing = PRESSES.has(kind) || (kind === 'press' && /^(enter|return|space| )$/i.test(String(args.key || '').trim()));
  if (!pressing || !args.ref) return { go: 'ok', why: '' };
  const tab = agent.tab(entry.view);
  await tab.cdp.ensure();
  agent.sync(tab);
  let ref;
  try { ref = agent.entry(tab, args.ref); } catch (err) { return { go: 'ok', why: '' }; } // stale: act says so
  const described = await agent.describe(entry.view, { refs: [args.ref] }).catch(() => null);
  const info = described && described.refs ? Object.values(described.refs)[0] : null;
  const form = await tab.cdp.onNode(ref, lib.FORM_INFO).catch(() => null);
  return lib.pressVerdict(info, form, entry.rules, real);
}

async function picture(entry, args) {
  const r = await agent.run('screenshot', { tab: entry.win.webContents.id, fullPage: Boolean(args.fullPage) });
  if (!r || !r.ok) return r || { ok: false, message: 'No picture.' };
  const image = nativeImage.createFromBuffer(Buffer.from(r.png, 'base64'));
  if (image.isEmpty()) return { ok: false, message: 'The page drew nothing to picture.' };
  const { width } = image.getSize();
  const full = width > SHOT_WIDTH ? image.resize({ width: SHOT_WIDTH, quality: 'good' }) : image;
  const thumb = image.resize({ width: THUMB_WIDTH, quality: 'good' });
  const size = full.getSize();
  return {
    ok: true, ...where(entry),
    jpeg: full.toJPEG(78).toString('base64'), thumb: thumb.toJPEG(70).toString('base64'), size: [size.width, size.height],
  };
}

async function call({ session: key, action, args = {} } = {}) {
  key = String(key || '');
  if (!/^[\w:-]{1,40}$/.test(key)) return { error: 'Which session’s check is it?' };
  if (action === 'open') return open(key, args);
  if (action === 'close') return { ok: closeOne(key) };
  const entry = previews.get(key);
  if (!entry || entry.win.isDestroyed()) return { ok: false, message: 'The check’s page isn’t open: open it with check_open.' };
  touch(key, entry);
  const wc = entry.win.webContents;
  // The page on show must still be one the check may be on (it can't have left, but a
  // redirect the guard missed would stop here).
  if (!lib.allowed(wc.getURL(), entry.rules, real)) return { ok: false, message: 'The page left the project’s own app; open it again with check_open.', ...where(entry) };
  const tab = { tab: wc.id };
  try {
    switch (action) {
      case 'snapshot':
        return { ...(await agent.run('snapshot', { ...tab, interactive: Boolean(args.interactive), offset: Number(args.offset) || 0 })), blocked: entry.blocked.slice() };
      case 'act': {
        const verdict = await pressCheck(entry, args);
        if (verdict.go === 'refuse') return { ok: false, refused: true, message: verdict.why, ...where(entry) };
        if (verdict.go === 'ask' && !args.confirmed) return { ok: false, needsConfirm: true, label: verdict.why, message: `That press needs the owner's OK first (${verdict.why}).`, ...where(entry) };
        // The project's own page: a press its label calls risky goes ahead (as a session's
        // own tab on a page on this Mac does); one that leaves it was refused above.
        const r = await agent.run('act', { ...args, ...tab, force: true });
        return { ...r, blocked: entry.blocked.slice() };
      }
      case 'scroll': {
        const amount = Math.max(-20, Math.min(20, Number(args.amount) || 1));
        await wc.executeJavaScript(`window.scrollBy(0, window.innerHeight * ${amount} * 0.9); [window.scrollY, document.documentElement.scrollHeight]`).catch(() => null);
        return { ok: true, message: `Scrolled ${amount > 0 ? 'down' : 'up'} ${Math.abs(amount)} screen${Math.abs(amount) === 1 ? '' : 's'}.`, ...where(entry) };
      }
      case 'wait':
        return agent.run('wait', { ...tab, text: args.text ? String(args.text).slice(0, 500) : undefined, ms: Math.max(100, Math.min(10000, Number(args.ms) || 1000)) });
      case 'dialog':
        return agent.run('dialog', { ...tab, accept: Boolean(args.accept), text: args.text });
      case 'console':
        return agent.run('console', { ...tab, level: args.level || 'all', limit: Number(args.limit) || 50 });
      case 'network':
        return agent.run('network', { ...tab, failed: Boolean(args.failed), limit: Number(args.limit) || 50 });
      case 'screenshot':
        return picture(entry, args);
      default:
        return { error: `Unknown check action ${action}` };
    }
  } catch (err) {
    return { ok: false, message: `The check didn’t work: ${err && err.message ? err.message : err}`, ...where(entry) };
  }
}

// A look at a session's hidden preview, for Eden Code's Browser pane to show while the check
// runs ("Eden is checking its work": web/features/code-browser.js): the page's address and a
// small picture of it as it is now. Read only: it neither keeps the preview open longer nor
// counts as a step of the check.
const PEEK_WIDTH = 640;
async function peek(key) {
  const entry = previews.get(String(key || ''));
  if (!entry || entry.win.isDestroyed()) return { ok: false };
  const wc = entry.win.webContents;
  let jpeg = '';
  try {
    const image = await wc.capturePage();
    if (image && !image.isEmpty()) jpeg = (image.getSize().width > PEEK_WIDTH ? image.resize({ width: PEEK_WIDTH, quality: 'good' }) : image).toJPEG(70).toString('base64');
  } catch { /* mid-load: the address alone */ }
  return { ok: true, url: wc.getURL(), title: wc.getTitle(), jpeg };
}

module.exports = {
  install(ctx) {
    ctx.ipcMain.handle('feature:self-check:peek', (event, msg) => {
      if (!ctx.fromWindow(event)) return { ok: false };
      return peek(msg && msg.session);
    });
    ctx.ipcMain.handle('feature:self-check:call', (event, msg) => {
      if (!ctx.fromWindow(event)) return { error: 'not allowed' };
      return call(msg || {});
    });
    ctx.app.on('before-quit', closeAll);
  },
  // For the tests (tests/web/self-check.e2e.cjs).
  call,
  peek,
  closeAll,
  previews,
};
