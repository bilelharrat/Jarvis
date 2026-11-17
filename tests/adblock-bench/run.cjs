// The ad-block benchmark: our browser's blocker against Brave Shields (at its default) and
// against no blocker, on public ad-test pages, YouTube and popular news and recipe sites.
// Read-only: pages are loaded, left to settle, scrolled and measured; nothing is clicked,
// signed into or submitted. See README.md.
//
//   app/node_modules/.bin/electron tests/adblock-bench/run.cjs [--set tests,youtube,real] [--arms none,ours,brave]
//                                                               [--only cnn,d3ward] [--legacy] [--label before]
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const APP = path.join(__dirname, '..', '..', 'app');
module.paths.unshift(path.join(APP, 'node_modules'));
const { app, BrowserWindow, session } = require('electron');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
  const [k, v] = a.slice(2).split('=');
  return [k, v === undefined ? true : v];
}));
const SETS = String(args.set || 'tests,youtube,real').split(',');
const ARMS = String(args.arms || 'none,ours,brave').split(',');
const ONLY = args.only ? new Set(String(args.only).split(',')) : null;
const LEGACY = Boolean(args.legacy); // the blocker as it was before the 2026-11 changes (Ghostery's fullLists)
const LABEL = args.label || (LEGACY ? 'legacy' : 'current');
// --app=<dir>: the blocker's files from another copy (e.g. a snapshot of an older version).
const BLOCKER = args.app ? path.resolve(String(args.app)) : APP;
const BRAVE = args.brave || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CACHE = path.join(os.tmpdir(), 'eden-adblock-bench');
const OUT = path.join(__dirname, 'results', `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${LABEL}`);
// One user agent for every arm (Brave's own, not a headless one), so sites serve them alike.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const W = 1280;
const H = 900;

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'eden-adblock-bench-app-')));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.on('window-all-closed', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── The oracle: which hosts are ads and trackers. Disconnect's list (what Firefox's
// tracking protection uses), so the judge is not the lists either blocker runs. Fetched
// at run time into a temp cache; never shipped (it is CC BY-NC-SA). ──
async function oracle() {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, 'disconnect-services.json');
  let text;
  try { text = await (await fetch('https://raw.githubusercontent.com/disconnectme/disconnect-tracking-protection/master/services.json')).text(); fs.writeFileSync(file, text); } catch { text = fs.readFileSync(file, 'utf8'); }
  const hosts = new Set();
  const { categories } = JSON.parse(text);
  for (const cat of ['Advertising', 'Analytics', 'FingerprintingInvasive', 'Cryptomining']) {
    for (const entity of categories[cat] || []) for (const sites of Object.values(entity)) for (const list of Object.values(sites)) {
      if (Array.isArray(list)) for (const h of list) hosts.add(h.toLowerCase());
    }
  }
  return (host) => {
    host = String(host || '').toLowerCase();
    for (let h = host; h.includes('.'); h = h.slice(h.indexOf('.') + 1)) if (hosts.has(h)) return true;
    return false;
  };
}
let isTracker = () => false;
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
const siteOf = (h) => h.split('.').slice(-2).join('.');

// ── CDP, the same way into both browsers: Electron's webContents.debugger, or Brave's
// DevTools socket. Frames in other processes (most ad frames) are attached as they start,
// so their requests are counted too. ──
class Cdp {
  constructor(send, subscribe) { this.raw = send; this.handlers = new Set(); subscribe((method, params, sessionId) => this.dispatch(method, params, sessionId)); }
  send(method, params = {}, sessionId) { return this.raw(method, params, sessionId); }
  on(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }
  dispatch(method, params, sessionId) {
    if (method === 'Target.attachedToTarget') {
      const sid = params.sessionId;
      const kind = params.targetInfo.type;
      (async () => {
        if (kind === 'iframe' || kind === 'page') {
          await this.send('Network.enable', {}, sid).catch(() => {});
          await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid).catch(() => {});
        }
        await this.send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
      })();
    }
    for (const fn of this.handlers) fn(method, params, sessionId);
  }
  async init() {
    await this.send('Page.enable');
    await this.send('Network.enable');
    await this.send('Runtime.enable');
    await this.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false }).catch(() => {});
    await this.send('Network.setUserAgentOverride', { userAgent: UA }).catch(() => {});
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }
}

function electronCdp(wc) {
  wc.debugger.attach('1.3');
  return new Cdp(
    (method, params, sessionId) => wc.debugger.sendCommand(method, params, sessionId),
    (fn) => wc.debugger.on('message', (_e, method, params, sessionId) => fn(method, params, sessionId)),
  );
}

async function socketCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  let listener = () => {};
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    } else if (msg.method) listener(msg.method, msg.params, msg.sessionId);
  };
  return new Cdp(
    (method, params, sessionId) => new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify(sessionId ? { id: n, method, params, sessionId } : { id: n, method, params }));
    }),
    (fn) => { listener = fn; },
  );
}

// ── The arms ──
async function electronArm(name, setup) {
  const partition = `bench-${name}`;
  const ses = session.fromPartition(partition);
  ses.setUserAgent(UA);
  if (setup) await setup(ses);
  const win = new BrowserWindow({ show: false, paintWhenInitiallyHidden: true, width: W, height: H, webPreferences: {
    partition, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, backgroundThrottling: false } });
  win.webContents.setAudioMuted(true);
  await win.loadURL('about:blank'); // CDP's Page domain waits for a renderer
  const cdp = electronCdp(win.webContents);
  await cdp.init();
  return { name, cdp, close: () => win.destroy() };
}

// Ours, wired as the app wires it (app/main.js's readyAdblock).
async function setupOurs(ses) {
  const adblock = require(path.join(BLOCKER, 'adblock.js'));
  let engine = null;
  const pageOf = (details) => {
    if (details.resourceType === 'mainFrame') return details.url;
    try { if (details.webContents && !details.webContents.isDestroyed()) return details.webContents.getURL(); } catch {}
    return details.referrer || '';
  };
  if (!LEGACY && typeof adblock.network === 'function') {
    const dir = path.join(CACHE, 'ours');
    engine = await adblock.load({ dir, log: (...a) => log('ours:', ...a) });
    if (!engine) throw new Error('no engine: the lists could not be fetched');
    adblock.network(ses, { engine: () => engine, shielded: () => true, pageOf, onBlocked: () => {} });
  } else {
    const { ElectronBlocker, fullLists } = require('@ghostery/adblocker-electron');
    engine = await ElectronBlocker.fromLists(fetch, fullLists, { enableCompression: true, loadExtendedSelectors: true, guessRequestTypeFromUrl: true });
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => engine.onBeforeRequest(details, cb));
    ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'], types: ['mainFrame', 'subFrame'] }, (details, cb) => engine.onHeadersReceived(details, cb));
  }
  adblock.attach(ses, { engine: () => engine, shielded: () => true });
  log('ours: engine ready', LEGACY ? '(legacy lists)' : '');
}

async function braveArm() {
  if (!fs.existsSync(BRAVE)) throw new Error(`Brave isn't installed at ${BRAVE}`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'eden-bench-brave-'));
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(BRAVE, [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--mute-audio', `--window-size=${W},${H}`, `--user-agent=${UA}`, '--autoplay-policy=no-user-gesture-required', 'about:blank',
  ], { stdio: 'ignore' });
  let version = null;
  for (let i = 0; i < 60 && !version; i++) { await sleep(500); try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch {} }
  if (!version) throw new Error('Brave did not start');
  // A fresh profile fetches Shields' lists and resources as components: wait for them.
  const ready = () => {
    let lists = 0;
    let resources = false;
    for (const dir of fs.readdirSync(profile)) {
      const p = path.join(profile, dir);
      try {
        for (const sub of [p, ...fs.readdirSync(p).map((s) => path.join(p, s))]) {
          if (fs.existsSync(path.join(sub, 'list.txt'))) lists += 1;
          if (fs.existsSync(path.join(sub, 'resources.json')) && fs.statSync(path.join(sub, 'resources.json')).size > 100000) resources = true;
        }
      } catch {}
    }
    return { lists, resources };
  };
  let state = ready();
  for (let i = 0; i < 240 && !(state.lists >= 6 && state.resources); i++) { await sleep(1000); state = ready(); }
  log(`brave ${version.Browser}: ${state.lists} lists, resources ${state.resources}`);
  await sleep(10000); // the engines load from the components
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const cdp = await socketCdp(page.webSocketDebuggerUrl);
  await cdp.init();
  return { name: 'brave', version: version.Browser, cdp, close: () => { try { proc.kill(); } catch {} setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 1500); } };
}

// ── What a page is measured for ──
const AD_SELECTORS = [
  'ins.adsbygoogle', '[id^="div-gpt-ad"]', '[id^="google_ads_iframe"]', '[id^="google_ads_"]', '[data-google-query-id]',
  'iframe[src*="doubleclick.net"]', 'iframe[src*="googlesyndication.com"]', 'iframe[src*="amazon-adsystem.com"]', 'iframe[name^="google_ads"]',
  '[id^="taboola-"]', '.trc_rbox_container', '.OUTBRAIN', '[data-widget-id][class*="outbrain"]', '[class*="taboola"]',
  '[data-ad-slot]', '[data-ad-unit]', '[data-adunit]', '[data-ad]', '[aria-label="Advertisement"]', '[aria-label="advertisement"]',
  '.ad', '.ads', '.advert', '.advertisement', '.ad-container', '.ad-wrapper', '.ad-slot', '.ad-unit', '.adsbox', '.adunit', '.ad-banner',
  '[class*="AdSlot"]', '[class*="ad-slot"]', '[class*="adSlot"]', '[class*="adslot"]', '[id*="ad-slot"]', '[id*="adslot"]', '[class*="ad-container"]',
  '[class*="dfp-ad"]', '[class*="gpt-ad"]', '[id*="gpt-ad"]', '[class*="sponsored-content"]', '[class*="native-ad"]', '[class*="ad-placeholder"]',
  '[class*="mrec"]', '[class*="leaderboard-ad"]', '[class*="ad-leaderboard"]', '[class*="ad_box"]', '[class*="adBox"]',
];
function domProbe(selectors) {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 30 || r.height < 30) return null;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null;
    return { w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top + scrollY) };
  };
  const ads = [];
  const seen = new Set();
  for (const sel of selectors) {
    let list = [];
    try { list = document.querySelectorAll(sel); } catch { continue; }
    for (const el of list) {
      if (seen.has(el)) continue;
      seen.add(el);
      const v = vis(el);
      if (!v) continue;
      // Count what shows something: an empty slot (no frame, image, link or text) isn't an ad.
      const filled = el.querySelector('iframe,img,video,a[href],canvas,object,embed') || el.tagName === 'IFRAME' || el.tagName === 'INS' || (el.innerText || '').trim().length > 10;
      if (!filled) continue;
      ads.push({ el, sel, ...v });
    }
  }
  const outer = ads.filter((a) => !ads.some((b) => b !== a && b.el.contains(a.el)));
  // Ad slots: the same selectors, shown, filled or not (an empty grey box is still ad space).
  const slotEls = [];
  for (const sel of selectors) { try { for (const el of document.querySelectorAll(sel)) if (vis(el)) slotEls.push(el); } catch {} }
  const slots = new Set(slotEls.filter((a) => !slotEls.some((b) => b !== a && b.contains(a)))).size;
  // Overlays: something fixed on top that covers a third of the window (cookie walls, sign-up nags).
  let overlays = 0;
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height > innerWidth * innerHeight / 3 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.1 && (el.innerText || '').trim().length > 20) overlays += 1;
  }
  const frames = [];
  for (const f of document.querySelectorAll('iframe')) {
    const v = vis(f);
    if (v) frames.push({ src: f.src || '', ...v });
  }
  return {
    url: location.href,
    title: document.title,
    ads: outer.map(({ sel, w, h, y }) => ({ sel, w, h, y })),
    slots,
    overlays,
    frames,
    textLength: (document.body && document.body.innerText || '').length,
    images: [...document.images].filter((i) => i.naturalWidth > 50 && i.getBoundingClientRect().width > 50).length,
    height: document.documentElement.scrollHeight,
    text: (document.body && document.body.innerText || '').slice(0, 4000),
  };
}

async function evaluate(cdp, expression, timeout = 15000) {
  const r = await Promise.race([
    cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
    sleep(timeout).then(() => ({ result: { value: null } })),
  ]);
  return r && r.result ? r.result.value : null;
}

async function measure(arm, page, kind) {
  const { cdp } = arm;
  const reqs = new Map();
  const failures = [];
  let exceptions = 0;
  let loaded = false;
  const off = cdp.on((method, p, sid) => {
    const key = `${sid || ''}:${p && p.requestId}`;
    if (method === 'Network.requestWillBeSent') {
      if (p.redirectResponse && reqs.has(key)) {
        const prev = reqs.get(key);
        if (/^data:/.test(p.request.url)) prev.blocked = 'redirect'; // a surrogate (noop.js, a 1x1 gif…)
        else prev.status = p.redirectResponse.status;
        if (/^data:/.test(p.request.url)) return;
      }
      if (/^(data|blob|chrome-extension|about):/.test(p.request.url)) return;
      reqs.set(key, { url: p.request.url, type: p.type, blocked: null, status: 0 });
    } else if (method === 'Network.responseReceived') {
      const r = reqs.get(key); if (r) r.status = p.response.status;
    } else if (method === 'Network.loadingFailed') {
      const r = reqs.get(key);
      if (!r) return;
      if (/BLOCKED_BY_CLIENT/.test(p.errorText || '') || p.blockedReason === 'inspector' || p.blockedReason === 'other') r.blocked = 'cancel';
      else if (!p.canceled) failures.push(p.errorText);
    } else if (method === 'Runtime.exceptionThrown' && !sid) exceptions += 1;
    else if (method === 'Page.loadEventFired' && !sid) loaded = true;
  });
  const began = Date.now();
  let navError = null;
  try {
    const nav = await cdp.send('Page.navigate', { url: page.url });
    if (nav && nav.errorText) navError = nav.errorText;
  } catch (err) { navError = err.message; }
  for (let i = 0; i < 300 && !loaded; i++) await sleep(100);
  const loadMs = Date.now() - began;
  let youtube = null;
  if (kind === 'youtube') {
    youtube = await youtubeProbe(cdp);
  } else {
    await sleep(page.settle || 6000);
    // Read down the page as a reader would (ads load lazily), then back to the top.
    await evaluate(cdp, `(async () => { for (let i = 0; i < 12 && innerHeight + scrollY < document.documentElement.scrollHeight; i++) { scrollBy(0, innerHeight * 0.9); await new Promise((r) => setTimeout(r, 450)); } scrollTo(0, 0); })()`, 20000);
    await sleep(3000);
  }
  // Ads are counted down the whole page: render it all at once for the probe.
  const dom = await evaluate(cdp, `(${domProbe.toString()})(${JSON.stringify(AD_SELECTORS)})`, 40000) || {};
  let score = null;
  if (page.score) {
    score = await evaluate(cdp, `(() => { const s = ${JSON.stringify(page.score)}; const el = s.selector ? document.querySelector(s.selector) : document.body; const t = el ? el.innerText : ''; const m = t.match(new RegExp(s.regex)); return m ? Number(m[1]) : null; })()`);
  }
  let shot = null;
  try {
    const { data } = await Promise.race([cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 45 }), sleep(15000).then(() => ({}))]);
    if (data) { shot = `${arm.name}-${page.name}.jpg`; fs.writeFileSync(path.join(OUT, 'shots', shot), Buffer.from(data, 'base64')); }
  } catch {}
  off();
  // Stop whatever the page still runs before the next one.
  await cdp.send('Page.navigate', { url: 'about:blank' }).catch(() => {});
  await sleep(500);

  const all = [...reqs.values()];
  const tracker = all.filter((r) => isTracker(hostOf(r.url)) && siteOf(hostOf(r.url)) !== siteOf(hostOf(page.url)));
  const adFrames = (dom.frames || []).filter((f) => isTracker(hostOf(f.src)));
  return {
    page: page.name, url: page.url, arm: arm.name, loadMs, loaded, navError,
    requests: all.length,
    blocked: all.filter((r) => r.blocked).length,
    trackerRequests: tracker.length,
    trackerBlocked: tracker.filter((r) => r.blocked).length,
    trackerLeaked: tracker.filter((r) => !r.blocked && r.status > 0).length,
    leakedHosts: [...new Set(tracker.filter((r) => !r.blocked && r.status > 0).map((r) => hostOf(r.url)))].slice(0, 40),
    adElements: (dom.ads || []).length,
    adArea: (dom.ads || []).reduce((s, a) => s + a.w * a.h, 0),
    adSamples: (dom.ads || []).slice(0, 8),
    adFrames: adFrames.length,
    adSlots: dom.slots || 0,
    overlays: dom.overlays || 0,
    textLength: dom.textLength || 0,
    images: dom.images || 0,
    title: dom.title || '',
    finalUrl: dom.url || '',
    exceptions,
    score,
    youtube,
    shot,
    text: kind === 'tests' ? dom.text : undefined,
  };
}

// YouTube, signed out: is an ad shown before the video? The player is started muted (a
// reader pressing play), never an ad clicked. Up to 25 s are watched.
async function youtubeProbe(cdp) {
  await sleep(4000);
  const code = `(async () => {
    const out = { consent: /consent\\./.test(location.host), adShowing: false, adSeen: 0, played: 0, placements: null };
    try { const pr = window.ytInitialPlayerResponse; out.placements = pr ? ((pr.adPlacements || []).length + (pr.playerAds || []).length) : null; } catch {}
    for (let i = 0; i < 25; i++) {
      const v = document.querySelector('video');
      if (v) { v.muted = true; if (v.paused) v.play().catch(() => {}); }
      const p = document.querySelector('#movie_player');
      const ad = !!(p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'))) || !!document.querySelector('.ytp-ad-player-overlay, .ytp-ad-player-overlay-layout, .ytp-ad-text, .video-ads .ytp-ad-module *');
      if (ad) { out.adShowing = true; out.adSeen += 1; }
      if (v && !ad && v.currentTime > 1) out.played = Math.round(v.currentTime);
      await new Promise((r) => setTimeout(r, 1000));
    }
    return out;
  })()`;
  return evaluate(cdp, code, 40000);
}

// ── The report ──
// Per page and arm: leaked (ad/tracker requests answered), ads (filled ad elements shown),
// slots (ad slots shown, filled or empty), overlays (cookie walls and nags covering the page).
function report(results, arms, meta) {
  const by = (page, arm) => results.find((r) => r.page === page && r.arm === arm);
  const pages = [...new Set(results.map((r) => r.page))];
  const lines = [`# Ad-block benchmark, ${meta.date} (${meta.label})`, '', `Arms: ${arms.join(', ')}${meta.brave ? ` (Brave: ${meta.brave})` : ''}.`, ''];
  lines.push('Each cell: leaked / ads / slots / overlays. Leaked = requests to known ad and tracker hosts (Disconnect) that got an answer; ads = filled ad elements shown after load and a scroll; slots = ad slots shown, filled or empty; overlays = fixed boxes over a third of the window (cookie walls, nags). Broken (!) = under 60% of the text the page has with no blocker, or it failed to load.', '');
  const head = ['page', ...arms, 'page\'s own score / YouTube'];
  lines.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`);
  const totals = {};
  for (const page of pages) {
    const base = by(page, 'none');
    const cells = [page];
    const notes = [];
    for (const a of arms) {
      const r = by(page, a);
      if (!r) { cells.push('–'); continue; }
      const broken = a !== 'none' && (Boolean(r.navError) || (base && base.textLength > 500 && r.textLength < 0.6 * base.textLength));
      r.broken = broken;
      const t = (totals[`${r.kind}|${a}`] ||= { pages: 0, leaked: 0, ads: 0, slots: 0, overlays: 0, broken: 0, ytAds: 0 });
      t.pages += 1; t.leaked += r.trackerLeaked || 0; t.ads += r.adElements || 0; t.slots += r.adSlots || 0; t.overlays += r.overlays || 0; t.broken += broken ? 1 : 0;
      if (r.youtube && r.youtube.adShowing) t.ytAds += 1;
      cells.push(`${r.trackerLeaked} / ${r.adElements} / ${r.adSlots || 0} / ${r.overlays || 0}${broken ? ' !' : ''}`);
      if (r.score !== null && r.score !== undefined) notes.push(`${a} ${r.score}`);
      if (r.youtube) notes.push(`${a}: ${r.youtube.consent ? 'consent wall' : r.youtube.adShowing ? `AD (${r.youtube.adSeen}s)` : `no ad, played ${r.youtube.played}s`}`);
    }
    cells.push(notes.join('; '));
    lines.push(`| ${cells.join(' | ')} |`);
  }
  lines.push('', '## Totals', '', '| set | arm | pages | leaked | ads | slots | overlays | broken | YouTube ads |', '|---|---|---|---|---|---|---|---|---|');
  for (const [k, t] of Object.entries(totals)) { const [set, a] = k.split('|'); lines.push(`| ${set} | ${a} | ${t.pages} | ${t.leaked} | ${t.ads} | ${t.slots} | ${t.overlays} | ${t.broken} | ${set === 'youtube' ? t.ytAds : ''} |`); }
  return lines.join('\n') + '\n';
}

app.whenReady().then(async () => {
  fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });
  isTracker = await oracle();
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'pages.json'), 'utf8'));
  const arms = [];
  const skipped = [];
  for (const name of ARMS) {
    try {
      if (name === 'none') arms.push(await electronArm('none'));
      else if (name === 'ours') arms.push(await electronArm('ours', setupOurs));
      else if (name === 'brave') arms.push(await braveArm());
    } catch (err) { skipped.push(`${name}: ${err.message}`); log(`arm ${name} skipped: ${err.message}`); }
  }
  const results = [];
  for (const set of SETS) {
    for (const page of spec[set] || []) {
      if (ONLY && !ONLY.has(page.name)) continue;
      log(`${set}/${page.name}`);
      // Every arm reads the page at the same time: the same ads are on offer to each.
      const got = await Promise.all(arms.map((arm) => measure(arm, page, set).catch((err) => ({ page: page.name, arm: arm.name, navError: err.message, trackerLeaked: 0, adElements: 0, textLength: 0 }))));
      for (const r of got) { r.kind = set; results.push(r); log(`  ${r.arm.padEnd(5)} leaked ${r.trackerLeaked} ads ${r.adElements} text ${r.textLength}${r.score != null ? ` score ${r.score}` : ''}${r.youtube ? ` yt ${JSON.stringify(r.youtube)}` : ''}${r.navError ? ` ERR ${r.navError}` : ''}`); }
      fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ label: LABEL, skipped, results }, null, 2));
    }
  }
  const meta = { date: new Date().toISOString().slice(0, 16), label: LABEL, brave: (arms.find((a) => a.name === 'brave') || {}).version };
  const md = report(results, arms.map((a) => a.name), meta) + (skipped.length ? `\nSkipped arms: ${skipped.join('; ')}\n` : '');
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ label: LABEL, skipped, meta, results }, null, 2));
  fs.writeFileSync(path.join(OUT, 'report.md'), md);
  console.log(`\n${md}\n${OUT}`);
  for (const a of arms) a.close();
  setTimeout(() => { fs.rmSync(app.getPath('userData'), { recursive: true, force: true }); app.exit(0); }, 2000);
});
