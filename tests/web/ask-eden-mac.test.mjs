// Ask Eden for Mac (app/eden): the wrapper's decisions, without Electron (app/eden/mac-policy.js),
// and how main.js and build.js use them. Bug sweep 2026-10-10 r1 (AJ7–AJ10, AJ13, AJ15–AJ17, F2, F3,
// F5, F9, F11, F12). node --test tests/web/
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const EDEN_DIR = path.resolve(here, '..', '..', 'app', 'eden');
const P = require(path.join(EDEN_DIR, 'mac-policy.js'));
const MAIN = readFileSync(path.join(EDEN_DIR, 'main.js'), 'utf8');
const WP = readFileSync(path.join(EDEN_DIR, 'window-policy.js'), 'utf8'); // shared with Ask Eden for Windows
const BUILD = readFileSync(path.join(EDEN_DIR, 'build.js'), 'utf8');

test('AJ8: askeden.com gets the microphone, notifications, clipboard and full screen; nothing else, no other page', () => {
  const eden = 'https://askeden.com/chat/1';
  const o = { origin: 'https://askeden.com' };
  for (const p of ['notifications', 'clipboard-sanitized-write', 'clipboard-read', 'fullscreen', 'keyboardLock']) assert.equal(P.permissionAllowed(p, eden, o), true, p);
  assert.equal(P.permissionAllowed('media', eden, { ...o, mediaTypes: ['audio'] }), true);
  assert.equal(P.permissionAllowed('media', 'https://askeden.com', { ...o, mediaType: 'audio' }), true, 'a check names one type');
  assert.equal(P.permissionAllowed('media', eden, { ...o, mediaTypes: ['audio', 'video'] }), false, 'no camera');
  assert.equal(P.permissionAllowed('media', eden, { ...o, mediaTypes: [] }), false);
  for (const p of ['geolocation', 'midi', 'midiSysex', 'display-capture', 'hid', 'serial', 'usb', 'idle-detection', 'pointerLock', 'unknown']) assert.equal(P.permissionAllowed(p, eden, o), false, p);
  assert.equal(P.permissionAllowed('openExternal', eden, { ...o, externalURL: 'mailto:a@b.c' }), true);
  assert.equal(P.permissionAllowed('openExternal', eden, { ...o, externalURL: 'smb://x/y' }), false);
  assert.equal(P.permissionAllowed('openExternal', eden, { ...o, externalURL: 'tel:+33123456789' }), true, 'AJ3-10: a phone link opens its app');
  assert.equal(P.permissionAllowed('openExternal', eden, { ...o, externalURL: 'file:///etc/passwd' }), false);
  for (const url of ['https://evil.example/', 'http://askeden.com/', 'https://askeden.com.evil.example/', 'https://accounts.google.com/', 'data:text/html,x', '', 'not a url']) {
    assert.equal(P.permissionAllowed('notifications', url, o), false, url);
    assert.equal(P.permissionAllowed('media', url, { ...o, mediaTypes: ['audio'] }), false, url);
  }
  assert.equal(P.permissionAllowed('notifications', 'https://beta.askeden.com/', { origin: 'https://beta.askeden.com' }), true);
  // main.js sets both handlers (window-policy.js setPermissions), and pop-ups get the same navigation guard as the main window
  assert.match(MAIN, /policy\.setPermissions\(session\.defaultSession\)/);
  assert.match(WP, /setPermissionRequestHandler\([\s\S]{0,200}permissionAllowed/);
  assert.match(WP, /setPermissionCheckHandler\([\s\S]{0,200}permissionAllowed/);
  assert.match(WP, /did-create-window', \(child\) => guard\(child\.webContents[,)]/);
  assert.match(WP, /if \(!wc \|\| guarded\.has\(wc\)\) return;/, 'never two will-navigate handlers on one page');
});

test('AJ7: a link before the app is ready waits (no window can be made yet); the target stays on askeden.com', () => {
  assert.equal(P.deepLinkAction({ ready: false, hasWindow: false }), 'wait');
  assert.equal(P.deepLinkAction({ ready: true, hasWindow: false }), 'open');
  assert.equal(P.deepLinkAction({ ready: true, hasWindow: true }), 'load');
  assert.equal(P.deepLinkTarget('askeden://chat/abc?x=1#h'), 'https://askeden.com/chat/abc?x=1#h');
  assert.equal(P.deepLinkTarget('askeden:////evil.com/x'), 'https://askeden.com/');
  assert.equal(P.deepLinkTarget('askeden:///\\evil.com'), 'https://askeden.com/');
  assert.equal(P.deepLinkTarget('nonsense'), 'https://askeden.com/');
  assert.match(MAIN, /if \(action === 'wait'\) \{ pendingUrl = target; return; \}/);
});

test('AJ10: never the stale ~/askeden; a baked J.A.R.V.I.S. folder that is gone is skipped', () => {
  const home = os.homedir();
  const c = P.edenServerCandidates({ resourcesPath: '/R', env: {}, edenDir: '/p/JARVIS V1/app/eden' });
  assert.deepEqual(c, ['/R/eden-server/dist/ui/server.js', '/p/askeden/dist/ui/server.js']);
  assert.ok(!c.some((f) => f.startsWith(path.join(home, 'askeden'))));
  assert.equal(P.askedenHome({ env: { ASKEDEN_HOME: '/x' } }), '/x');
  assert.equal(P.askedenHome({ env: {}, edenDir: '/p/JARVIS V1/app/eden' }), '/p/askeden');
  assert.doesNotMatch(MAIN, /homedir\(\), 'askeden'/);
  assert.doesNotMatch(BUILD, /homedir\(\), 'askeden'/);
  assert.match(BUILD, /'main\.js', 'mac-policy\.js'/, 'the build carries mac-policy.js next to main.js');

  const files = { '/b/jarvis-home.json': JSON.stringify({ path: '/gone/JARVIS V1' }) };
  const read = (f) => { if (!(f in files)) throw new Error('ENOENT'); return files[f]; };
  const there = new Set(['/p/JARVIS V1/pyproject.toml']);
  const exists = (f) => there.has(f);
  assert.equal(P.jarvisHome({ env: {}, files: ['/b/jarvis-home.json'], read, exists, edenDir: '/p/JARVIS V1/app/eden', home: '/h' }), '/p/JARVIS V1', 'the repo the app runs from');
  there.add('/gone/JARVIS V1');
  assert.equal(P.jarvisHome({ env: {}, files: ['/b/jarvis-home.json'], read, exists, edenDir: '/p/JARVIS V1/app/eden', home: '/h' }), '/gone/JARVIS V1', 'a baked folder that exists');
  assert.equal(P.jarvisHome({ env: { JARVIS_HOME: '/j' }, files: [], read, exists, home: '/h' }), '/j');
  assert.equal(P.jarvisHome({ env: {}, files: [], read, exists: () => false, edenDir: '/q/app/eden', home: '/h' }), '/h/JARVIS V1');
});

test('F3 / AJ17: restarts back off (3 s doubling to 5 min) and start over after a minute up', () => {
  let t = 0;
  const b = P.createBackoff({ now: () => t });
  b.started();
  const waits = [];
  for (let i = 0; i < 10; i++) { t += 100; waits.push(b.next()); b.started(); }
  assert.deepEqual(waits, [3000, 6000, 12000, 24000, 48000, 96000, 192000, 300000, 300000, 300000]);
  b.started();
  t += 61_000;
  assert.equal(b.next(), 3000, 'a run that lasted a minute resets it');
  assert.doesNotMatch(MAIN, /setTimeout\(startEngine, 3000\)/);
  assert.match(MAIN, /setTimeout\(startEngine, wait\)/);
  // the Eden server it starts comes back after a crash, and its output is logged
  assert.match(MAIN, /edenBackoff\.next\(\)/);
  assert.match(MAIN, /eden-server\.log/);
  // a ready update installs itself when the Mac is quiet
  assert.match(MAIN, /updater\.quiet\(\)/);
});

test('F2: backend.json is advertised only after the engine answers', () => {
  const at = MAIN.indexOf('share.advertise(');
  assert.ok(at > 0);
  assert.ok(MAIN.lastIndexOf('await waitForEngine(port)', at) > MAIN.lastIndexOf('spawn(how.command', at), 'after waitForEngine, not right after spawn');
});

test('AJ16: console-message reads the event object (the positional arguments are deprecated)', () => {
  assert.match(MAIN, /on\('console-message', \(e\) =>/);
  assert.doesNotMatch(MAIN, /console-message', \(_e, _lvl, message\)/);
});

/** Fake timers: run(ms) moves the clock and fires what's due, awaiting each. */
function clock() {
  let t = 0, seq = 0;
  const due = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; due.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => { due.delete(id); },
    pending: () => due.size,
    async run(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...due.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        due.delete(next[0]);
        t = next[1].at;
        await next[1].fn();
      }
      t = end;
    },
  };
}

test('AJ9 / AJ13 (F5): the sign-in page opens once per run; linked, it looks every 15 minutes, not every 15 s', async () => {
  const c = clock();
  const sent = [], looks = [], opened = [];
  let codes = 0, linked = false;
  let link;
  const autoLink = P.createAutoLink({
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
    webApi: async (p) => { looks.push(p); return { status: 200, body: { fresh: false } }; },
    openSignIn: (code) => opened.push(code),
    sendEngine: async (obj) => {
      sent.push(obj.type);
      // the engine: unlinked, a new code each time one is asked for (valid 600 s)
      if (obj.type === 'account_link') { codes += 1; link = { state: 'waiting', code: `C${codes}`, until: c.now() + 600_000 }; }
      const waiting = link && c.now() < link.until ? link : null;
      await autoLink.onAccount({ linked, link: waiting ? { state: 'waiting', code: waiting.code } : null });
      return true;
    },
  });
  autoLink.start();
  await c.run(30 * 60_000);
  assert.equal(codes, 1, 'AJ2-5: no new codes while nobody can approve them (the sign-in page is out, the sign-in is old)');
  assert.deepEqual(opened, ['C1'], 'the window went to the sign-in page once, not on every new code');

  // linked: one look every 15 minutes
  linked = true;
  await c.run(15 * 60_000); // the next look sees it linked
  const before = looks.length;
  await c.run(60 * 60_000);
  assert.ok(looks.length - before <= 4, `linked: ${looks.length - before} looks in an hour`);
  assert.equal(autoLink.state().linked, true);
  // unlinked again (the engine says so): it looks again soon (then backs off: the sign-in is still old, AJ2-5)
  linked = false;
  await autoLink.onAccount({ linked: false, link: null });
  const unl = looks.length;
  await c.run(16_000);
  assert.equal(looks.length - unl, 1, 'unlinked: a look 15 s later');
  // the window closed: nothing more
  autoLink.stop();
  const stopped = looks.length;
  await c.run(60 * 60_000);
  assert.equal(looks.length, stopped);
  assert.equal(c.pending(), 0);
});

test('AJ9: a fresh sign-in approves the code without opening any page', async () => {
  const c = clock();
  const posts = [], opened = [];
  const autoLink = P.createAutoLink({
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
    webApi: async (p, m = 'GET') => { if (m === 'POST') posts.push(p); return { status: 200, body: { fresh: true } }; },
    openSignIn: (code) => opened.push(code),
    sendEngine: async () => true,
  });
  await autoLink.onAccount({ linked: false, link: { state: 'waiting', code: 'AB12' } });
  assert.deepEqual(posts, ['/api/web/mac-link/AB12/approve']);
  assert.deepEqual(opened, []);
});

test('F12: the page’s "Try again" asks for a new link at most once every 10 s', async () => {
  const c = clock();
  let looks = 0;
  const autoLink = P.createAutoLink({ now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, webApi: async () => { looks += 1; return null; }, openSignIn: () => {}, sendEngine: async () => true });
  const r = [];
  for (let i = 0; i < 20; i++) { r.push(autoLink.relink()); await c.run(500); }
  assert.equal(r.filter(Boolean).length, 1);
  await c.run(10_000);
  assert.equal(autoLink.relink(), true);
  assert.equal(looks, 2);
  assert.match(MAIN, /autoLink\.relink\(\)/);
  assert.doesNotMatch(MAIN, /linkLastAsk = 0/);
});

test('AJ15 / F11: quick ask at most once a second, and kept when the chat page isn’t there', () => {
  let t = 0;
  const gate = P.createGate({ gapMs: 1000, now: () => t });
  assert.equal(gate(), true);
  t = 500; assert.equal(gate(), false);
  t = 1000; assert.equal(gate(), true);
  assert.match(MAIN, /if \(!quickGate\(\)\) return;/);
  assert.match(MAIN, /quickPending = took === true \? null/);
});

// ── Bug sweep 2026-10-10 round 2 (askeden/docs/bug-sweep/r2-ask-eden-voice-mac.md) ──

test('AJ2-3: permissions go by the asking frame’s origin: sandboxed artifacts (opaque, "null") and subframes elsewhere get nothing', () => {
  const eden = 'https://askeden.com/inner';
  assert.equal(P.permissionAllowed('notifications', eden, { origin: 'null' }), false, 'a sandboxed frame or CSP-sandboxed page on askeden.com');
  assert.equal(P.permissionAllowed('clipboard-read', eden, { origin: 'null', isMainFrame: true }), false);
  assert.equal(P.permissionAllowed('notifications', eden, {}), false, 'no origin known: no');
  assert.equal(P.permissionAllowed('notifications', eden, { origin: 'https://evil.example' }), false);
  assert.equal(P.permissionAllowed('notifications', eden, { origin: 'https://askeden.com/' }), false, 'an origin, not a URL');
  assert.equal(P.permissionAllowed('notifications', eden, { origin: 'https://askeden.com' }), true);
  // frameOrigin: the main frame's own origin; a subframe's by its URL; "null" when opaque or unknown
  const main = { origin: 'https://askeden.com', url: 'https://askeden.com/' };
  const sandboxed = { origin: 'null', url: 'https://askeden.com/inner' };
  const same = { origin: 'https://askeden.com', url: 'https://askeden.com/same' };
  main.framesInSubtree = [main, sandboxed, same];
  const wc = { mainFrame: main };
  assert.equal(P.frameOrigin(wc, { isMainFrame: true, requestingUrl: 'https://askeden.com/' }), 'https://askeden.com');
  assert.equal(P.frameOrigin(wc, { isMainFrame: false, requestingUrl: 'https://askeden.com/inner' }), 'null');
  assert.equal(P.frameOrigin(wc, { isMainFrame: false, requestingUrl: 'https://askeden.com/same' }), 'https://askeden.com');
  assert.equal(P.frameOrigin(wc, { isMainFrame: false, requestingUrl: 'https://askeden.com/gone' }), 'null');
  assert.equal(P.frameOrigin({ mainFrame: { ...main, origin: 'null' } }, { isMainFrame: true }), 'null', 'a page under a CSP sandbox');
  assert.equal(P.frameOrigin(null, {}, 'https://askeden.com'), 'https://askeden.com', 'a check with no page: the origin Electron gives');
  assert.equal(P.frameOrigin(null, {}), 'null');
  // both handlers get the frame's origin
  assert.match(WP, /setPermissionRequestHandler\([\s\S]{0,400}origin: frameOrigin\(wc, details\)/);
  assert.match(WP, /setPermissionCheckHandler\([\s\S]{0,400}origin: frameOrigin\(wc, details, origin\)/);
});

/** createAutoLink on the fake clock, with an engine that makes 600 s codes and a web side that can hang. */
function linkSim({ signedIn = true, fresh = false, hang = () => false } = {}) {
  // a clock that fires what's due without awaiting it (a look waits on a request's own 15 s timer)
  const c = (() => {
    let t = 0, seq = 0;
    const due = new Map();
    return {
      now: () => t,
      setTimer: (fn, ms) => { const id = ++seq; due.set(id, { at: t + ms, fn }); return id; },
      clearTimer: (id) => { due.delete(id); },
      async run(ms) {
        const end = t + ms;
        for (;;) {
          const next = [...due.entries()].sort((a, b) => a[1].at - b[1].at)[0];
          if (!next || next[1].at > end) break;
          due.delete(next[0]);
          t = next[1].at;
          Promise.resolve().then(next[1].fn).catch(() => {});
          for (let i = 0; i < 50; i++) await Promise.resolve();
        }
        t = end;
      },
    };
  })();
  const st = { web: 0, approve: 0, codes: 0, signIn: 0 };
  let code = null, linked = false, al;
  const sendEngine = async (o) => {
    if (o.type === 'account_link') { st.codes += 1; code = { code: `C${st.codes}`, until: c.now() + 600_000 }; }
    const live = code && code.until > c.now() ? code : null;
    Promise.resolve().then(() => al.onAccount({ linked, link: live ? { state: 'waiting', code: live.code } : null }).catch(() => {}));
    return true;
  };
  const webApi = (p, method = 'GET') => {
    st.web += 1;
    if (hang(st.web, p, method)) return new Promise(() => {}); // a stalled connection: never answers
    if (!signedIn) return Promise.resolve({ status: 401, body: {} });
    if (method === 'POST') { st.approve += 1; linked = true; code = null; return Promise.resolve({ status: 200, body: { ok: true } }); }
    return Promise.resolve({ status: 200, body: { fresh } });
  };
  al = P.createAutoLink({ sendEngine, webApi, openSignIn: () => { st.signIn += 1; }, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
  return {
    al, st, c,
    async run(ms) { const end = c.now() + ms; while (c.now() < end) { await c.run(Math.min(60_000, end - c.now())); await settle(); } },
    set(k, v) { if (k === 'fresh') fresh = v; if (k === 'signedIn') signedIn = v; },
    linked: () => linked,
  };
}

test('AJ2-4: a request that never answers no longer stops linking (the looks go on; busy clears)', async () => {
  // (a) the first look's request hangs: looking goes on, and a fresh sign-in then links
  const a = linkSim({ fresh: true, hang: (n) => n === 1 });
  a.al.start();
  await a.run(60_000);
  assert.ok(a.st.web > 1, `${a.st.web} requests in a minute after the first one hung`);
  assert.equal(a.linked(), true, 'it linked anyway');
  // (b) the approve step's GET hangs (busy was stuck): the next code is approved
  const b = linkSim({ fresh: true, hang: (n, p, m) => n === 2 && m === 'GET' });
  b.al.start();
  await b.run(10 * 60_000);
  assert.equal(b.linked(), true, 'linked within 10 minutes');
  assert.ok(b.st.approve >= 1);
  b.al.stop();
  // main.js gives each askeden.com request a timeout too
  assert.match(MAIN, /signal: AbortSignal\.timeout\(policy\.LINK_REQUEST_MS\)/);
});

test('AJ2-5: signed out, or unlinked with an old sign-in, links back off (≈100 requests a day, not 5,760–11,660) and make no codes nobody can approve', async () => {
  const out = linkSim({ signedIn: false });
  out.al.start();
  await out.run(24 * 3600_000);
  assert.ok(out.st.web <= 150, `signed out: ${out.st.web} askeden.com requests a day`);
  assert.equal(out.st.codes, 0);
  const old = linkSim({ fresh: false });
  old.al.start();
  await old.run(24 * 3600_000);
  assert.ok(old.st.web + old.st.codes <= 300, `old sign-in: ${old.st.web} requests + ${old.st.codes} codes a day`);
  assert.equal(old.st.codes, 1, 'one code, for the sign-in page');
  assert.equal(old.st.signIn, 1);
  // a sign-in (the window loads askeden.com, or is focused) looks again at once, and links
  old.set('fresh', true);
  old.al.nudge();
  await old.run(10_000);
  assert.equal(old.linked(), true, 'linked seconds after the sign-in');
  // and a wake resets the back-off
  const w = linkSim({ signedIn: false });
  w.al.start();
  await w.run(3 * 3600_000);
  assert.equal(w.al.state().idle > 3, true);
  w.al.wake();
  assert.equal(w.al.state().idle, 0);
  const before = w.st.web;
  await w.run(20_000);
  assert.equal(w.st.web - before, 2, 'looked 4 s after the wake, then 15 s later');
  // a sign-in in the window looks again at once; a focus at most every 30 minutes (AJ3-11)
  assert.match(MAIN, /const nudge = policy\.linkNudgeFor\(prev, mainUrl\);\s*if \(nudge === 'signed-in'\) autoLink\.nudge\(\); else if \(nudge === 'focus'\) autoLink\.focused\(\);/);
  assert.match(MAIN, /win\.on\('focus', \(\) => autoLink\.focused\(\)\)/);
});

test('AJ2-8: server redirects go through the guard (the main window stays on askeden.com)', () => {
  const opened = [];
  const guard = P.createGuard({ openOutside: (u) => opened.push(u) });
  const wc = fakeWc('https://askeden.com/');
  guard(wc);
  assert.equal(wc.go('https://askeden.com/redir', { redirects: ['https://evil.example/landed'] }), 'stopped');
  assert.equal(wc.url, 'https://askeden.com/');
  assert.deepEqual(opened, ['https://evil.example/landed'], 'opened in the browser');
  assert.equal(wc.go('https://askeden.com/a', { redirects: ['https://askeden.com/b'] }), 'https://askeden.com/b');
  assert.equal(P.navigationAction('https://evil.example/', { redirect: true }), 'outside');
  assert.equal(P.navigationAction('http://sso.example-corp.com/saml', { inFlow: true, redirect: true }), 'outside', 'https only, even in a sign-in');
  assert.match(MAIN, /const guard = policy\.createGuard\(\{ openOutside \}\);/);
  assert.match(MAIN, /guard\(win\.webContents\);/);
});

test('AJ2-9: quick ask never submits the form before the page’s chat takes it (no reload to "/?"; the text is kept)', async () => {
  const vm = await import('node:vm');
  const run = (handled) => {
    const form = new EventTarget();
    const input = new EventTarget();
    const win = new EventTarget();
    let navigated = false;
    form.requestSubmit = () => {
      const e = new Event('submit', { cancelable: true });
      form.dispatchEvent(e); // the page's own handler, if it has one
      // the event bubbles on to window (EventTarget doesn't bubble: hand it on, as the DOM would)
      for (const l of win._l || []) l(e);
      if (!e.defaultPrevented) navigated = true; // a native submit: the page reloads, the text is gone
    };
    win.addEventListener = (t, l) => { (win._l ||= []).push(l); };
    win.removeEventListener = (t, l) => { win._l = (win._l || []).filter((x) => x !== l); };
    if (handled) form.addEventListener('submit', (e) => e.preventDefault());
    const ctx = vm.createContext({
      document: { getElementById: (id) => (id === 'deck-input' ? input : id === 'deck-composer' ? form : null) },
      window: win, location: { origin: 'https://askeden.com' }, Event, setTimeout, Promise,
    });
    return vm.runInContext(P.quickAskScript('what’s on today?', 'https://askeden.com/'), ctx).then((took) => ({ took, navigated, value: input.value }));
  };
  assert.deepEqual(await run(false), { took: 'not-ready', navigated: false, value: 'what’s on today?' }, 'not ready: no native submit, the text stays');
  assert.deepEqual(await run(true), { took: true, navigated: false, value: 'what’s on today?' });
  assert.match(MAIN, /if \(took === 'not-ready' && quickPending\) quickAgain\(quickPending\);/);
});

test('AJ2-10: a crashed page loads again, waiting longer each time it keeps crashing', () => {
  assert.match(MAIN, /win\.webContents\.on\('render-process-gone', \(_e, details\) => \{[\s\S]{0,500}crashBackoff\.next\(\)[\s\S]{0,300}win\.loadURL\(/);
  assert.match(MAIN, /const crashBackoff = policy\.createBackoff\(/);
});

// ── Bug sweep 2026-10-10 round 3 (askeden/docs/bug-sweep/r3-ask-eden-voice-mac.md) ──

/** A webContents as the guard sees it: go() reports a navigation as Electron does (will-navigate from the
 * page, did-start-navigation, a will-redirect per hop, did-navigate). */
function fakeWc(url = '') {
  const h = {};
  let openHandler = null;
  const wc = {
    url, downloads: [],
    on(ev, fn) { (h[ev] ||= []).push(fn); return wc; },
    emit(ev, ...a) { for (const fn of h[ev] || []) fn(...a); },
    setWindowOpenHandler(fn) { openHandler = fn; },
    open(u) { return openHandler({ url: u }).action; },
    getURL() { return wc.url; },
    downloadURL(u) { wc.downloads.push(u); },
    count: (ev) => (h[ev] || []).length,
  };
  const ev = (extra) => { const e = { defaultPrevented: false, ...extra }; e.preventDefault = () => { e.defaultPrevented = true; }; return e; };
  wc.go = (target, { redirects = [], fromPage = true } = {}) => {
    if (fromPage) { const e = ev({ url: target }); wc.emit('will-navigate', e, target); if (e.defaultPrevented) return 'blocked'; }
    wc.emit('did-start-navigation', { url: target, isMainFrame: true, isSameDocument: false });
    let at = target;
    for (const r of redirects) { const e = ev({ url: r, isMainFrame: true }); wc.emit('will-redirect', e); if (e.defaultPrevented) return 'stopped'; at = r; }
    wc.url = at;
    wc.emit('did-navigate', {}, at);
    return at;
  };
  return wc;
}

test('AJ3-2: Google and Apple sign-in hops and a company SSO stay in the main window while a sign-in started from askeden.com is going on', () => {
  let t = 0;
  const opened = [];
  const guard = P.createGuard({ openOutside: (u) => opened.push(u), now: () => t });
  const wc = fakeWc('https://askeden.com/signin');
  guard(wc);
  wc.emit('did-navigate', {}, 'https://askeden.com/signin');
  assert.equal(wc.go('https://askeden.com/api/auth/google', { redirects: ['https://accounts.google.com/o/oauth2/v2/auth?x=1'] }), 'https://accounts.google.com/o/oauth2/v2/auth?x=1');
  // the password step, then Google's cookie hop through accounts.youtube.com, a country domain, back to askeden.com
  const back = wc.go('https://accounts.google.com/signin/challenge', { redirects: [
    'https://accounts.youtube.com/accounts/SetSID?continue=x', 'https://accounts.google.fr/accounts/SetSID', 'https://www.google.com/accounts/ServiceLogin?x=1',
    'https://accounts.google.com/o/oauth2/approval', 'https://askeden.com/api/auth/google/callback?code=1', 'https://askeden.com/'] });
  assert.equal(back, 'https://askeden.com/');
  // a Workspace account: Google → the company's SSO (a redirect, then the SSO page's own form), back by Google
  wc.go('https://askeden.com/api/auth/google', { redirects: ['https://accounts.google.com/o/oauth2/v2/auth'] });
  assert.equal(wc.go('https://accounts.google.com/sso', { redirects: ['https://login.example-corp.com/saml?r=1'] }), 'https://login.example-corp.com/saml?r=1');
  assert.equal(wc.go('https://login.example-corp.com/mfa'), 'https://login.example-corp.com/mfa');
  assert.equal(wc.go('https://login.example-corp.com/done', { redirects: ['https://accounts.google.com/samlrp', 'https://askeden.com/api/auth/google/callback', 'https://askeden.com/'] }), 'https://askeden.com/');
  // Apple: appleid.apple.com → idmsa.apple.com → askeden.com
  wc.go('https://askeden.com/api/auth/apple', { redirects: ['https://appleid.apple.com/auth/authorize?x=1'] });
  assert.equal(wc.go('https://idmsa.apple.com/appleauth/auth'), 'https://idmsa.apple.com/appleauth/auth');
  assert.equal(wc.go('https://askeden.com/api/auth/apple/callback', { redirects: ['https://askeden.com/'] }), 'https://askeden.com/');
  assert.deepEqual(opened, [], 'nothing left the app');
  // back on askeden.com: the allowance is over
  assert.equal(wc.go('https://askeden.com/redir', { redirects: ['https://login.example-corp.com/saml'] }), 'stopped');
  assert.equal(wc.go('https://accounts.youtube.com/x'), 'blocked', 'a hop with no sign-in going on');
  // a sign-in left hanging: 15 minutes at most
  wc.go('https://askeden.com/api/auth/google', { redirects: ['https://accounts.google.com/o/oauth2/v2/auth'] });
  t += P.SIGN_IN_FLOW_MS + 1;
  assert.equal(wc.go('https://accounts.google.com/sso', { redirects: ['https://login.example-corp.com/saml'] }), 'stopped');
  // a window that never was on askeden.com starts no sign-in
  const stray = fakeWc('');
  guard(stray);
  stray.go('https://accounts.google.com/x', { fromPage: false });
  assert.equal(stray.go('https://accounts.google.com/y', { redirects: ['https://evil.example/'] }), 'stopped');
});

test('AJ3-12 / AJ3-5: a sign-in pop-up may pass through SSO hosts, only until it is back on askeden.com', () => {
  const opened = [];
  const guard = P.createGuard({ openOutside: (u) => opened.push(u) });
  const main = fakeWc('https://askeden.com/');
  guard(main);
  main.emit('did-navigate', {}, 'https://askeden.com/');
  assert.equal(main.open('https://accounts.google.com/signin'), 'allow');
  const pop = fakeWc('');
  main.emit('did-create-window', { webContents: pop });
  assert.equal(pop.count('will-navigate'), 1, 'the pop-up is guarded');
  pop.go('https://accounts.google.com/signin', { fromPage: false });
  assert.equal(pop.go('https://accounts.google.com/next', { redirects: ['https://accounts.youtube.com/accounts/SetSID', 'https://askeden.com/plain'] }), 'https://askeden.com/plain');
  assert.equal(pop.go('https://askeden.com/redir', { redirects: ['https://evil.example/landed'] }), 'stopped', 'AJ3-12: no longer trusted once back');
  assert.deepEqual(opened, ['https://evil.example/landed']);
  // a pop-up a Google page opened starts nothing
  const gpage = fakeWc('https://accounts.google.com/x');
  guard(gpage);
  gpage.emit('did-navigate', {}, 'https://accounts.google.com/x');
  const pop2 = fakeWc('');
  gpage.emit('did-create-window', { webContents: pop2 });
  pop2.go('https://accounts.google.com/help', { fromPage: false });
  assert.equal(pop2.go('https://accounts.google.com/h', { redirects: ['https://evil.example/'] }), 'stopped');
  // the open handler: askeden.com and the sign-ins open as windows; other links outside; never file:
  opened.length = 0;
  for (const u of ['https://evil.example/', 'http://example.org/page', 'tel:+33123456789', 'webcal://example.org/c.ics', 'zoommtg://zoom.us/join?confno=1', 'file:///etc/passwd', 'javascript:alert(1)']) assert.equal(main.open(u), 'deny', u);
  assert.equal(main.open('https://askeden.com/x'), 'allow');
  // (openOutside filters by outsideAllowed in main.js)
  guard(main);
  assert.equal(main.count('will-navigate'), 1, 'guarding twice adds nothing');
});

test('AJ3-3: askeden.com download links that redirect to a GitHub release download in the app; the window stays put', () => {
  const opened = [];
  const guard = P.createGuard({ openOutside: (u) => opened.push(u) });
  const wc = fakeWc('https://askeden.com/plain');
  guard(wc);
  wc.emit('did-navigate', {}, 'https://askeden.com/plain');
  const rel = 'https://github.com/bilelharrat/Jarvis/releases/download/ask-eden-v0.1.0/Ask-Eden.zip';
  for (const from of ['/download/mac', '/download/windows', '/jarvis/download', '/eden-code/windows', '/daredevil/windows', '/jarvis/daredevil']) {
    assert.equal(wc.go(`https://askeden.com${from}`, { redirects: [rel] }), 'stopped', from);
  }
  assert.equal(wc.go('https://askeden.com/jarvis/download', { redirects: ['https://github.com/bilelharrat/Jarvis/releases/latest/download/J.dmg'] }), 'stopped');
  assert.equal(wc.go('https://askeden.com/download/mac', { redirects: ['https://objects.githubusercontent.com/x'] }), 'stopped');
  assert.equal(wc.go('https://askeden.com/download/mac', { redirects: ['https://release-assets.githubusercontent.com/x'] }), 'stopped');
  assert.equal(wc.downloads.length, 9);
  assert.deepEqual(opened, []);
  assert.equal(wc.url, 'https://askeden.com/plain', 'never navigated off-site');
  // not a download link, or not a release file: the browser
  assert.equal(wc.go('https://askeden.com/redir', { redirects: [rel] }), 'stopped');
  assert.equal(wc.go('https://askeden.com/download/mac', { redirects: ['https://github.com/bilelharrat/Jarvis'] }), 'stopped');
  assert.equal(wc.downloads.length, 9);
  assert.equal(opened.length, 2);
});

test('AJ3-10: web pages (http too) open in the browser, phone, calendar and meeting links in their apps; nothing else', () => {
  for (const u of ['https://example.org/', 'http://example.org/page', 'mailto:a@b.c', 'tel:+33123456789', 'sms:+33123456789', 'facetime:a@b.c', 'webcal://example.org/c.ics', 'zoommtg://zoom.us/join', 'msteams:/l/meetup-join/x']) assert.equal(P.outsideAllowed(u), true, u);
  for (const u of ['file:///etc/passwd', 'smb://x/y', 'javascript:alert(1)', 'data:text/html,x', 'vbscript:x', 'ms-settings:', '', 'nonsense']) assert.equal(P.outsideAllowed(u), false, u);
  assert.match(MAIN, /const openOutside = \(url\) => \{ if \(policy\.outsideAllowed\(url\)\) shell\.openExternal\(url\)/);
});

test('AJ3-9: askeden.com unreachable: an offline page that tries again (5 s, 10 s… a minute), and Reload loads askeden.com', async () => {
  const c = clock();
  const shown = [], loads = [];
  const off = P.createOfflineRetry({ show: (u, ms) => shown.push([u, ms]), retry: (u) => loads.push(u), setTimer: c.setTimer, clearTimer: c.clearTimer });
  off.failed('https://askeden.com/chat/1');
  await c.run(5000);
  assert.deepEqual(loads, ['https://askeden.com/chat/1']);
  off.failed('https://askeden.com/chat/1');
  off.failed('https://askeden.com/chat/1');
  off.failed('https://askeden.com/chat/1');
  off.failed('https://askeden.com/chat/1');
  off.failed('https://askeden.com/chat/1');
  assert.deepEqual(shown.map((x) => x[1]), [5000, 10000, 20000, 40000, 60000, 60000]);
  assert.equal(off.retryNow(), true, 'Reload, or a wake');
  assert.equal(loads.at(-1), 'https://askeden.com/chat/1');
  off.loaded();
  assert.equal(off.retryNow(), false, 'loaded: Reload reloads');
  assert.equal(c.pending(), 0);
  // which failures it handles
  assert.equal(P.offlineTarget('https://askeden.com/x', { code: -106 }), 'https://askeden.com/x');
  assert.equal(P.offlineTarget('https://accounts.youtube.com/x', { code: -105 }), 'https://askeden.com/', 'off-site: home');
  assert.equal(P.offlineTarget('https://askeden.com/x', { code: -3 }), null, 'aborted (a download)');
  assert.equal(P.offlineTarget('https://askeden.com/x', { code: -106, isMainFrame: false }), null);
  assert.equal(P.offlineTarget('data:text/html,x', { code: -106 }), null);
  // the page: says so, has a Try again button that loads askeden.com, and listens for "online"
  const page = decodeURIComponent(P.offlinePageUrl({ name: 'Ask Eden', url: 'https://askeden.com/chat/1?a=</script>', seconds: 5 }).split(',').slice(1).join(','));
  assert.match(page, /Ask Eden can’t reach askeden\.com/);
  assert.match(page, /<button id="again" type="button" autofocus>Try again<\/button>/);
  assert.match(page, /location\.replace\(u\)/);
  assert.match(page, /addEventListener\('online',go\)/);
  assert.doesNotMatch(page, /a=<\/script>/, 'the URL never closes the script');
  // main.js: on a main-frame failure, the offline page; Reload and a wake try again
  assert.match(MAIN, /did-fail-load', \(_e, code, _desc, url, isMainFrame\) => \{[\s\S]{0,200}offline\.failed\(again\)/);
  assert.match(MAIN, /label: 'Reload', accelerator: 'CommandOrControl\+R', click: reloadFocused/);
  assert.doesNotMatch(MAIN, /\{ role: 'reload' \}/);
  assert.match(MAIN, /powerMonitor\.on\('resume', \(\) => \{ autoLink\.wake\(\); offline\.retryNow\(\); \}\)/);
});

/**
 * 24 hours of auto-link with an engine that behaves like the real one (AJ3-1): codes live 600 s and
 * end with an "account" event (state expired), an "account" event every hour besides (a prefs change),
 * and /link/poll every 2 s for the code's whole life, or for a minute only for a {visible: false}
 * code (and a minute more after account_link_watch). Counts every askeden.com request.
 */
function daySim({ signedIn = true, fresh = false, focusEvery = 0, looking = false } = {}) {
  let t = 0, seq = 0;
  const due = new Map();
  const c = {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; due.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => { due.delete(id); },
  };
  const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
  const st = { web: 0, codes: 0, polls: 0, signIn: 0, watch: 0 };
  let code = null, linked = false, al;
  const tell = () => al.onAccount({ linked, link: code ? { state: code.state, code: code.code } : null }).catch(() => {});
  const sendEngine = async (o) => {
    if (o.type === 'account_link') {
      st.codes += 1;
      const mine = { code: `C${st.codes}`, state: 'waiting', made: t, quiet: o.visible === false, approved: false };
      code = mine;
      st.polls += 1 + (o.visible === false ? 30 : 300); // /link/start + its polls
      c.setTimer(() => { if (code === mine && mine.state === 'waiting') { mine.state = 'expired'; tell(); } }, 600_000);
    }
    if (o.type === 'account_link_watch') {
      st.watch += 1;
      if (code && code.state === 'waiting' && code.approved) { st.polls += 1; code.state = 'linked'; linked = true; } // the next poll fetches it
    }
    Promise.resolve().then(tell);
    return true;
  };
  const webApi = (p, method = 'GET') => {
    st.web += 1;
    if (!signedIn) return Promise.resolve({ status: 401, body: {} });
    if (method === 'POST') { // approved: the engine has it at its next poll (a quiet code polls its first minute only)
      if (code) { code.approved = true; if (!code.quiet || t - code.made < 60_000) { code.state = 'linked'; linked = true; } }
      return Promise.resolve({ status: 200, body: { ok: true } });
    }
    return Promise.resolve({ status: 200, body: { fresh } });
  };
  al = P.createAutoLink({ sendEngine, webApi, openSignIn: () => { st.signIn += 1; }, isLooking: () => looking, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  const hourly = () => { tell(); c.setTimer(hourly, 3600_000); };
  c.setTimer(hourly, 3600_000);
  if (focusEvery) { const f = () => { al.focused(); c.setTimer(f, focusEvery); }; c.setTimer(f, focusEvery); }
  return {
    al, st, c,
    total: () => st.web + st.polls,
    set(k, v) { if (k === 'fresh') fresh = v; },
    async run(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...due.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        due.delete(next[0]);
        t = next[1].at;
        Promise.resolve().then(next[1].fn).catch(() => {});
        await settle();
      }
      t = end;
      await settle();
    },
  };
}

test('AJ3-1: with code expiry modelled, every state stays at 300 askeden.com requests a day or fewer, and an expired code makes no new one', async () => {
  const day = 24 * 3600_000;
  const cases = {
    'signed out': { signedIn: false },
    'signed in >10 min ago, unlinked': { fresh: false },
    'signed in >10 min ago, unlinked, focused every 5 min': { fresh: false, focusEvery: 5 * 60_000 },
    'signed out, app switching every 30 s': { signedIn: false, focusEvery: 30_000 },
    'signed in >10 min ago, window in front all day (no sign-in page now)': { fresh: false, looking: true },
    'fresh sign-in: links, then linked all day': { fresh: true },
  };
  for (const [name, o] of Object.entries(cases)) {
    const s = daySim(o);
    s.al.start();
    await s.run(day);
    assert.ok(s.total() <= 300, `${name}: ${s.total()} askeden.com requests a day (${s.st.web} looks, ${s.st.polls} engine)`);
    if (o.signedIn === false) assert.equal(s.st.codes, 0, name);
    else if (o.fresh) assert.equal(s.al.state().linked, true, name);
    else { assert.equal(s.st.codes, 1, `${name}: one code, for the sign-in page`); assert.equal(s.st.signIn, 1, name); }
  }
  // someone looking (the window in front, the sign-in page on screen in the last minute) when the code
  // expires: it is replaced; the same with the window behind: not
  for (const looking of [true, false]) {
    const l = daySim({ fresh: false, looking });
    l.al.start();
    await l.run(9.5 * 60_000); // the first code made and the sign-in page shown
    assert.equal(l.st.codes, 1);
    l.al.signInShown();
    await l.run(90_000); // the code expires at ~10 min
    assert.equal(l.st.codes, looking ? 2 : 1, looking ? 'looking: a new code' : 'nobody looking: none');
  }
  // main.js asks for quiet codes and tells the engine when it approved one
  const POL = readFileSync(path.join(EDEN_DIR, 'mac-policy.js'), 'utf8');
  assert.match(POL, /engine\(\{ type: 'account_link', visible: false \}\)/);
  assert.match(POL, /if \(done\) await engine\(\{ type: 'account_link_watch' \}\)/);
  assert.match(MAIN, /isLooking: \(\) => Boolean\(win && !win\.isDestroyed\(\) && win\.isVisible\(\) && win\.isFocused\(\)\)/);
  assert.match(MAIN, /autoLink\.signInShown\(\)/);
});

test('AJ3-1: after the sign-in page and an expired code, a fresh sign-in still links at once (new code, approved, watched)', async () => {
  const s = daySim({ fresh: false });
  s.al.start();
  await s.run(30 * 60_000);
  assert.equal(s.st.codes, 1);
  assert.equal(s.al.state().pageOpened, true);
  s.set('fresh', true); // signed in again in the window
  const polls = s.st.polls;
  s.al.nudge();
  await s.run(10_000);
  assert.equal(s.al.state().linked, true, 'linked seconds after the sign-in');
  assert.equal(s.st.codes, 2);
  assert.equal(s.st.polls - polls, 1 + 30, 'a quiet code and its minute of polls');
  assert.ok(s.st.watch >= 1, 'the engine was told the code was approved');
});

test('AJ3-11: a focus starts the looks over at most once every 30 minutes, not on every focus', async () => {
  const c = clock();
  let looks = 0;
  const al = P.createAutoLink({ now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, webApi: async () => { looks += 1; return { status: 401, body: {} }; }, openSignIn: () => {}, sendEngine: async () => true });
  al.start();
  await c.run(3 * 3600_000);
  assert.ok(al.state().idle > 3);
  al.focused();
  assert.equal(al.state().idle, 0, 'the first focus resets it');
  await c.run(2 * 60_000);
  const idle = al.state().idle;
  for (let i = 0; i < 20; i++) { al.focused(); await c.run(60_000); }
  assert.ok(al.state().idle >= idle, 'focuses within 30 minutes reset nothing');
  await c.run(30 * 60_000);
  al.focused();
  assert.equal(al.state().idle, 0, 'half an hour on: again');
  // which navigations count as a sign-in
  assert.equal(P.linkNudgeFor('https://accounts.google.com/x', 'https://askeden.com/'), 'signed-in');
  assert.equal(P.linkNudgeFor('https://askeden.com/signin', 'https://askeden.com/'), 'signed-in');
  assert.equal(P.linkNudgeFor('https://askeden.com/', 'https://askeden.com/link'), 'signed-in');
  assert.equal(P.linkNudgeFor('https://askeden.com/chat/1', 'https://askeden.com/chat/2'), 'focus');
  assert.equal(P.linkNudgeFor('https://askeden.com/', 'https://accounts.google.com/'), null);
});

test('AJ3-14: the page hears when this Mac has just been linked', async () => {
  let told = 0;
  const al = P.createAutoLink({ webApi: async () => null, openSignIn: () => {}, sendEngine: async () => true, onLinked: () => { told += 1; } });
  await al.onAccount({ linked: false, link: null });
  await al.onAccount({ linked: true });
  await al.onAccount({ linked: true });
  assert.equal(told, 1);
  assert.match(MAIN, /onLinked: \(\) => inPage\("dispatchEvent\(new Event\('eden:mac-linked'\)\)"\)/);
});

test('AJ3-15: the quick-ask input has a label', () => {
  const quick = readFileSync(path.join(EDEN_DIR, 'quick.html'), 'utf8');
  assert.match(quick, /<input id="q"[^>]*aria-label="Ask Eden"/);
  assert.match(BUILD, /'mac-policy\.js', 'window-policy\.js'/, 'the build carries window-policy.js');
});

test('AJ3-4: Ask Eden for Windows carries the same window-policy.js', { skip: !existsSync(path.resolve(here, '..', '..', '..', 'Eden Windows', 'ask-eden', 'window-policy.js')) }, () => {
  const win = readFileSync(path.resolve(here, '..', '..', '..', 'Eden Windows', 'ask-eden', 'window-policy.js'), 'utf8');
  assert.equal(win, WP, 'the two copies are the same file: change both');
});
