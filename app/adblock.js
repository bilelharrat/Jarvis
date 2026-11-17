'use strict';
// Ad blocking for the built-in browser, on Ghostery's engine with the lists Brave Shields
// uses by default and a few more (adblock-lists.json, built by adblock-build.js): what
// hides ads inside the page, as uBlock Origin does it (attach), the network side
// (network), and the engine's upkeep (keepFresh). main.js wires them to the session.
//
// Ghostery's own Electron preload asks for a page's rules over async IPC and only in the
// top frame, so its scriptlets ran after the page's scripts (YouTube's player had already
// read its ads), ads showed before they were hidden, frames kept theirs, and procedural
// rules (:has-text, :upward, :xpath…) were never applied. Here, adblock-preload.js asks
// synchronously as each page and frame starts, so every scriptlet runs before the page's
// own scripts and the page's first paint has its hiding rules; procedural rules run in a
// world of their own, and ads added later are caught as they appear.

const fs = require('fs');
const path = require('path');
const { ipcMain } = require('electron');
const { parse } = require('tldts-experimental');

const PRELOAD = path.join(__dirname, 'adblock-preload.js');
// Ghostery's procedural-selector engine as one browser script (MPL-2.0, loaded unchanged).
const EXTENDED_LIB = path.join(
  path.dirname(require.resolve('@ghostery/adblocker-extended-selectors/package.json')),
  'dist', 'adblocker.umd.min.js',
);
let extendedLib = null;
function extendedSource() {
  if (extendedLib === null) {
    try { extendedLib = fs.readFileSync(EXTENDED_LIB, 'utf8'); } catch { extendedLib = ''; }
  }
  return extendedLib;
}

// The page a frame is in: a top frame's own address (the tab's may not have caught up
// with a navigation yet), a subframe's top page.
function pageOf(event, frameUrl) {
  const frame = event.senderFrame;
  if (!frame || frame.parent === null) return frameUrl;
  try { return (frame.top && frame.top.url) || event.sender.getURL(); } catch { return ''; }
}

const strings = (list, max) => (Array.isArray(list) ? list.filter((s) => typeof s === 'string' && s.length < 1000).slice(0, max) : []);

// ses: the browser's session. engine(): the current ElectronBlocker, or null while it's
// loading. shielded(pageUrl): whether blocking is on for that page (off on the Research
// Center, on sites the user allowed, and when switched off).
function attach(ses, { engine, shielded }) {
  ses.registerPreloadScript({ type: 'frame', filePath: PRELOAD });

  const rulesFor = (event, url) => {
    if (event.sender.session !== ses || typeof url !== 'string' || !/^https?:/.test(url)) return null;
    const blocker = engine();
    if (!blocker || !shielded(pageOf(event, url))) return null;
    const { hostname, domain } = parse(url);
    return { blocker, url, hostname: hostname || '', domain: domain || '', callerContext: { frameId: event.frameId, processId: event.processId } };
  };

  // As a page or frame starts: its scriptlets, its stylesheet (generic, the site's own,
  // the procedural rules' hiding attributes), and its procedural rules. (Setting
  // returnValue sends the answer, so it's set once, at the end.)
  const startRules = (event, url) => {
    const at = rulesFor(event, url);
    if (!at) return null;
    const { active, styles, scripts, extended } = at.blocker.getCosmeticsFilters({
      url: at.url, hostname: at.hostname, domain: at.domain, callerContext: at.callerContext,
      getBaseRules: true, getInjectionRules: true, getExtendedRules: true, getRulesFromHostname: true, getRulesFromDOM: false,
    });
    if (active === false) return null; // an exception switches cosmetics off here
    const procedural = extended || [];
    return {
      styles: styles || '',
      scripts: scripts || [],
      extended: procedural,
      lib: procedural.length ? extendedSource() : '',
      observe: at.blocker.config.enableMutationObserver !== false,
    };
  };
  ipcMain.on('jarvis-adblock:start', (event, url) => {
    let answer = null;
    try { answer = startRules(event, url); } catch (err) { console.error('adblock: no cosmetic rules for a page', err && err.message); }
    event.returnValue = answer;
  });

  // Classes, ids and links that appeared in the page: the generic rules that hide them.
  ipcMain.handle('jarvis-adblock:dom', (event, url, features) => {
    try {
      const at = rulesFor(event, url);
      if (!at || !features) return '';
      const { active, styles } = at.blocker.getCosmeticsFilters({
        url: at.url, hostname: at.hostname, domain: at.domain, callerContext: at.callerContext,
        classes: strings(features.classes, 5000), ids: strings(features.ids, 5000), hrefs: strings(features.hrefs, 2000),
        getBaseRules: false, getInjectionRules: false, getExtendedRules: false, getRulesFromHostname: false, getRulesFromDOM: true,
      });
      return active === false ? '' : styles || '';
    } catch (err) {
      console.error('adblock: no rules for new elements', err && err.message);
      return '';
    }
  });
}

// ── The engine: built from adblock-lists.json by adblock-build.js, in a worker thread, and
// kept fresh every few hours (Brave checks its lists every 100 minutes; ours ask with
// ETags, so an unchanged list costs nothing and the engine is only rebuilt on a change). ──
const BUILD = path.join(__dirname, 'adblock-build.js');

async function runBuild(opts) {
  const { gather, compile } = require('./adblock-build');
  const logs = [];
  const { job, lists, missing, error } = await gather({ ...opts, log: (m) => logs.push(m) }).catch((err) => ({ error: err && err.message }));
  if (!job) return { built: false, lists, missing, error, logs };
  const compiled = await new Promise((resolve) => {
    const { Worker } = require('worker_threads');
    let worker;
    try { worker = new Worker(BUILD, { workerData: { adblockCompile: job } }); } catch { resolve(null); return; }
    worker.once('message', resolve);
    worker.once('error', () => resolve(null));
    worker.once('exit', () => resolve(null));
  });
  // No worker here (a packaged app's archive, say): compile on this thread instead.
  let result = compiled && compiled.built ? compiled : null;
  if (!result) { try { result = compile(job); } catch (err) { result = { built: false, error: err && err.message }; } }
  return { ...result, lists, missing, logs };
}

// The built engine from disk, or null. Its page blocker rides along as .pages.
function readEngine(dir, platform = 'desktop') {
  try {
    const { ElectronBlocker } = require('@ghostery/adblocker-electron');
    const { FiltersEngine } = require('@ghostery/adblocker');
    const { envFor } = require('./adblock-build');
    const engine = ElectronBlocker.deserialize(new Uint8Array(fs.readFileSync(path.join(dir, 'engine.bin'))));
    engine.updateEnv(envFor(platform));
    try {
      engine.pages = FiltersEngine.deserialize(new Uint8Array(fs.readFileSync(path.join(dir, 'pages.bin'))));
      engine.pages.updateEnv(envFor(platform));
    } catch { engine.pages = null; }
    return engine;
  } catch { return null; }
}

// Fetch, build if anything changed, and return the engine (null if there are no lists at all).
async function load({ dir, platform = 'desktop', force = false, log = console.log } = {}) {
  const result = await runBuild({ dir, platform, force });
  for (const line of (result && result.logs) || []) log(line);
  if (result && result.built) log(`adblock: engine built from ${result.lists} lists in ${result.ms} ms${result.missing ? ` (${result.missing} unavailable)` : ''}`);
  return readEngine(dir, platform);
}

// The last engine at once, then a fresh one whenever the lists change. onEngine(engine).
function keepFresh({ dir, platform = 'desktop', onEngine, log = console.log }) {
  let current = readEngine(dir, platform);
  if (current) onEngine(current);
  const refresh = async () => {
    const result = await runBuild({ dir, platform });
    for (const line of (result && result.logs) || []) log(line);
    if (current && !(result && result.built)) return;
    const engine = readEngine(dir, platform);
    if (engine) { current = engine; onEngine(engine); }
  };
  refresh();
  setInterval(refresh, (require('./adblock-lists.json').updateMinutes || 240) * 60 * 1000).unref();
}

// ── The network side: every request of a shielded page ──
// Beyond the engine's own Electron handler (which this replaces):
// - $removeparam is applied (the engine works it out; its handler dropped it), on pages too;
// - a page on a malware or scam list (blockPages), or under a $document rule, isn't opened
//   (Brave's domain block);
// - a first-party subdomain that is a CNAME alias of a tracker is blocked when a rule names
//   the tracker's host (Brave's CNAME uncloaking);
// - a blocked image or frame is collapsed, so no empty box is left (as Brave does);
// - a request blocked again and again in a tight loop (CNN's player, thousands a second)
//   gets its answer 2 s late, so the loop crawls and counts once.
const { Request } = require('@ghostery/adblocker');
const COLLAPSE = new Set(['image', 'subFrame', 'object']);

const repeats = new Map();
function retrying(details) {
  const id = details.webContents && !details.webContents.isDestroyed() ? details.webContents.id : 0;
  const key = `${id}|${details.url.split('?')[0]}`;
  const now = Date.now();
  let seen = repeats.get(key);
  if (!seen || now - seen.since > 3000) {
    seen = { n: 0, since: now };
    repeats.set(key, seen);
    if (repeats.size > 5000) repeats.clear();
  }
  seen.n += 1;
  return seen.n > 5;
}

// CNAME chains, looked up once per host and kept ten minutes.
const cnames = new Map();
let resolver = null;
function aliasesOf(host) {
  const hit = cnames.get(host);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.chain;
  if (!resolver) resolver = new (require('dns').promises.Resolver)({ timeout: 1500, tries: 1 });
  const chain = (async () => {
    const out = [];
    for (let h = host; out.length < 4;) {
      let next;
      try { [next] = await resolver.resolveCname(h); } catch { break; }
      if (!next || out.includes(next.toLowerCase())) break;
      out.push(next.toLowerCase());
      h = next;
    }
    return out;
  })();
  if (cnames.size > 2000) cnames.clear();
  cnames.set(host, { at: Date.now(), chain });
  return chain;
}

// Whether a first-party request's host is a CNAME alias of a tracker a rule names. Only a
// rule naming the alias's host counts: a generic third-party rule would otherwise catch
// any site whose subdomain points at its CDN.
async function cloaked(blocker, details, type, sourceUrl, page) {
  const timeout = new Promise((resolve) => setTimeout(() => resolve([]), 1000)); // never hold a request long
  const chain = await Promise.race([aliasesOf(new URL(details.url).hostname), timeout]);
  for (const alias of chain) {
    if (parse(alias).domain === page.domain) continue; // still the site's own
    const aliased = new URL(details.url);
    aliased.hostname = alias;
    const result = blocker.match(Request.fromRawDetails({ url: aliased.href, type, sourceUrl }));
    if (result.match && !result.exception && result.filter && result.filter.isHostnameAnchor() && result.filter.getHostname()) return true;
  }
  return false;
}

// A page's address without the click trackers (fbclid, gclid…) of adblock-lists.json's
// trackingParams, when it is opened from another site (or typed); null if there are none.
// Within a site its own parameters are left alone, as Brave's query filter does.
function withoutTrackingParams(url, referrer) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!u.search || !/^https?:$/.test(u.protocol)) return null;
  const site = parse(u.hostname).domain || u.hostname;
  if (referrer && parse(referrer).domain === site) return null;
  const rules = (require('./adblock-lists.json').trackingParams || {}).rules || [];
  let changed = false;
  for (const rule of rules) {
    if (!rule.sites.includes('*') && !rule.sites.some((s) => u.hostname === s || u.hostname.endsWith(`.${s}`))) continue;
    for (const p of rule.params) if (u.searchParams.has(p)) { u.searchParams.delete(p); changed = true; }
  }
  return changed ? u.href : null;
}

// What to do with one request: {}, { cancel }, { redirectURL }, or a promise of one.
function decide(blocker, details, pageUrl) {
  const type = details.resourceType || 'other';
  const sourceUrl = details.referrer || pageUrl || '';
  const request = Request.fromRawDetails({ requestId: String(details.id), url: details.url, type, sourceUrl, tabId: details.webContentsId });
  if (blocker.config.guessRequestTypeFromUrl && request.type === 'other') request.guessTypeOfRequest();
  const result = blocker.match(request);
  if (request.isMainFrame()) {
    if (!result.exception && blocker.pages && blocker.pages.match(request).match) return { cancel: true, page: true };
    if (result.match && result.filter && result.filter.fromDocument() && !result.filter.fromAny()) return { cancel: true, page: true };
    if (result.rewrite) return { redirectURL: result.rewrite.url, rewrite: true };
    const clean = withoutTrackingParams(details.url, details.referrer);
    return clean ? { redirectURL: clean, rewrite: true } : {};
  }
  if (result.redirect) return { redirectURL: result.redirect.dataUrl };
  if (result.match) return { cancel: true };
  if (result.rewrite) return { redirectURL: result.rewrite.url, rewrite: true };
  if (result.exception || !/^https?:/.test(details.url)) return {};
  const page = parse(pageUrl || '');
  const req = parse(details.url);
  if (page.domain && req.domain === page.domain && req.hostname !== page.hostname) {
    return cloaked(blocker, details, type, sourceUrl, page).then((hit) => (hit ? { cancel: true } : {}), () => ({}));
  }
  return {};
}

// A blocked image or frame: the frame that asked (and its parent, for a frame) collapses it.
function collapse(details) {
  if (!COLLAPSE.has(details.resourceType)) return;
  let frame = null;
  try { frame = details.frame; } catch {}
  if (!frame) return;
  const frames = [frame];
  try { if (frame.parent) frames.push(frame.parent); } catch {}
  for (const f of frames) { try { f.send('jarvis-adblock:collapse', details.url); } catch {} }
}

// ses: the browser's session. engine(), shielded(pageUrl): as for attach(). pageOf(details):
// the page a request is for. onBlocked(details): a request was blocked (for the counter).
function network(ses, { engine, shielded, pageOf: pageFor, onBlocked = () => {} }) {
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const blocker = engine();
    const page = blocker ? pageFor(details) : '';
    if (!blocker || !shielded(page)) { callback({}); return; }
    const finish = (verdict) => {
      if (!verdict || !(verdict.cancel || verdict.redirectURL)) { callback({}); return; }
      const response = verdict.cancel ? { cancel: true } : { redirectURL: verdict.redirectURL };
      if (verdict.rewrite) { callback(response); return; } // an address cleaned of trackers: not a block
      if (!verdict.page && retrying(details)) { setTimeout(() => callback(response), 2000); return; }
      onBlocked(details);
      callback(response);
      if (verdict.cancel) collapse(details);
    };
    let verdict;
    try { verdict = decide(blocker, details, page); } catch { callback({}); return; }
    if (verdict && typeof verdict.then === 'function') verdict.then(finish, () => callback({}));
    else finish(verdict);
  });
  // Only a page's or a frame's own headers are ever changed here (their CSP, for $csp filters):
  // the engine answers every other response with no change, so a page's pictures, scripts and
  // the rest don't wait for this thread on their way in (tests/web/adblock-network.test.mjs).
  ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'], types: ['mainFrame', 'subFrame'] }, (details, callback) => {
    const blocker = engine();
    if (!blocker || !shielded(pageFor(details))) { callback({}); return; }
    blocker.onHeadersReceived(details, callback);
  });
}

module.exports = { attach, pageOf, network, decide, load, keepFresh, readEngine };
