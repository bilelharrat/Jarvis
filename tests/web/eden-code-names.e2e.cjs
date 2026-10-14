// Eden Code's own window (the page marked data-app="eden-code", as server.eden_code_page
// serves it) in a real Chromium, with no backend: what shows names Eden Code, never Jarvis,
// Eden Secretary or "Bug Fix", in English and in Chinese, on the welcome, its Settings, a
// session, every pane, the More menu and every card of its Setup (round 3, U3-1, U3-6). And
// what the backend alone can't do isn't offered: no voice switch or Dictate mic while the
// backend listens to no one (profile "code", U3-14), no Browser button for a dock that isn't
// there (U3-10), and the gear opens the sheet ⌘, opens (U3-9). Nothing leaves 127.0.0.1;
// the profile is a temp folder of its own.
//
//   app/node_modules/.bin/electron tests/web/eden-code-names.e2e.cjs      (about 10 s; exit 1 on a failure)
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const WEB = process.env.JARVIS_WEB_DIR || path.join(__dirname, '..', '..', 'src', 'jarvis', 'web');
const USER_DATA = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'eden-code-names-'));
app.setPath('userData', USER_DATA);
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');

// The window's features as /features.json lists them, less the Labs ones (off by default).
const LABS = new Set(['code-acp', 'code-plugins', 'code-spec', 'code-split', 'code_share']);
const feats = fs.readdirSync(path.join(WEB, 'features')).filter((f) => /\.js$/.test(f) && !LABS.has(f.replace(/\.js$/, ''))).sort();
const styles = fs.readdirSync(path.join(WEB, 'features')).filter((f) => /\.css$/.test(f)).sort();
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const NAMES = /Jarvis|JARVIS|J\.A\.R\.V\.I\.S|Eden Secretary|Bug Fix/;

function serve() {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/features.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ scripts: feats.map((f) => `/static/features/${f}`), styles: styles.map((f) => `/static/features/${f}`) }));
      return;
    }
    if (pathname === '/i18n-zh.json' || pathname === '/static/i18n-zh.json') {  // as server.py merges the fragments
      const dict = JSON.parse(fs.readFileSync(path.join(WEB, 'i18n-zh.json'), 'utf8'));
      const strings = { ...(dict.strings || dict) };
      const patterns = [...(dict.patterns || [])];
      for (const f of fs.readdirSync(path.join(WEB, 'i18n')).sort()) {
        const j = JSON.parse(fs.readFileSync(path.join(WEB, 'i18n', f), 'utf8'));
        Object.assign(strings, j.strings || {});
        patterns.push(...(j.patterns || []));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ strings, patterns }));
      return;
    }
    let file;
    if (pathname === '/') file = 'index.html';
    else if (pathname.startsWith('/static/features/')) file = path.join('features', ...pathname.slice('/static/features/'.length).split('/'));
    else if (pathname.startsWith('/static/')) file = pathname.slice(8);
    else file = pathname.slice(1);
    if (file.split(/[\\/]/).includes('..')) { res.writeHead(404); res.end(); return; }
    fs.readFile(path.join(WEB, file), (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      let body = data;
      if (file === 'index.html') body = String(data).replace('<title>Eden Secretary</title>', '<title>Eden Code</title>').replace('<body ', '<body data-app="eden-code" class="eden-code" ');
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What shows (text, and the names controls are read by) that names the wrong app; in Chinese,
// also what's left in English (two English words and no Chinese, U3-13), less names.
const NAMED_AS_IS = /^(?:@[a-z-]+: )?(?:Model Router|Eden Code|~\/Eden Pairing\/…)$/;
const AUDIT = (zh) => `(() => {
  const shown = (n) => { for (let e = n; e && e.nodeType === 1; e = e.parentElement) { if (e.hidden) return false; }
    const s = getComputedStyle(n); if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const out = [];
  const english = (s) => ${zh} && /[A-Za-z]{3,} [A-Za-z]{2,}/.test(s) && !/[\\u4e00-\\u9fff]/.test(s);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t; (t = walker.nextNode());) {
    const p = t.parentElement; if (!p || !shown(p) || p.closest('script,style,[data-no-i18n],code,pre,kbd')) continue;
    const s = t.textContent.replace(/\\s+/g, ' ').trim(); if (s && (${NAMES}.test(s) || english(s))) out.push(s.slice(0, 160));
  }
  for (const n of document.querySelectorAll('[title],[aria-label],[placeholder]')) {
    if (!shown(n) || n.closest('[data-no-i18n]')) continue;
    for (const a of ['title', 'aria-label', 'placeholder']) { const v = n.getAttribute(a); if (v && (${NAMES}.test(v) || english(v))) out.push('@' + a + ': ' + v.slice(0, 160)); }
  }
  return [...new Set(out)].filter((s) => !${NAMED_AS_IS}.test(s));
})()`;

let failed = 0;
function check(ok, what) {
  if (ok) return;
  failed++;
  console.error(`not ok - ${what}`);
}

async function run(port, lang) {
  const win = new BrowserWindow({ show: false, width: 1300, height: 900, webPreferences: { contextIsolation: true, partition: `names-${lang}` } });  // (each language its own storage)
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 3) errors.push(msg); });
  await win.loadURL(`http://127.0.0.1:${port}/?token=test&app=eden-code`);
  await js(`new Promise((r) => { if (window.__ready) r(); window.addEventListener('jarvis-features-ready', () => r(), { once: true }); setTimeout(r, 4000); })`);
  await js(`
    window.__sent = []; send = (m) => { __sent.push(m); return true; };
    heard({ type: 'hello', hub_id: 'hub-a', state: 'idle', muted: true, status: {}, activity: [], tasks: [], app_windows: {}, profile: 'code',
      prefs: { look: 'orb', language: '${lang}', models: [], personas: [], humor: 50, features: {} }, brain: {}, approvals: [], history: [] });
    true;`);
  await sleep(600);
  const where = (view, names) => check(!names.length, `${lang} ${view}: ${JSON.stringify(names)}`);
  const visible = (id) => js(`(() => { const n = document.getElementById(${JSON.stringify(id)}); if (!n) return false; for (let e = n; e; e = e.parentElement) if (e.hidden) return false; const r = n.getBoundingClientRect(); return getComputedStyle(n).display !== 'none' && r.width > 0; })()`);

  where('welcome, no project', await js(AUDIT(lang === 'zh')));
  // The backend alone listens to no one: no voice switch, no Dictate; no Browser button.
  check(!(await visible('cc-voice-head')), `${lang}: the voice switch shows while the backend can't listen`);
  check(!(await visible('jc-dictate')), `${lang}: Dictate shows while the backend can't listen`);
  check(!(await visible('jc-browser')), `${lang}: a Browser button with no browser dock`);
  await js(`deckProjects = [{ name: 'alpha', branch: 'main' }]; selectProject('alpha'); renderProjects(deckProjects); true`);
  await sleep(200);
  where('welcome', await js(AUDIT(lang === 'zh')));
  // Settings: the gear opens Eden Code's own sheet (⌘,'s), whose last line opens the shared one.
  await js(`document.getElementById('jc-eden-settings').click(); true`);
  await sleep(200);
  const opened = await js(`({ code: !document.getElementById('jc-settings').hidden, shared: !document.getElementById('settings').hidden })`);
  check(opened.code && !opened.shared, `${lang}: the gear opened ${JSON.stringify(opened)}`);
  where('Settings', await js(AUDIT(lang === 'zh')));
  check(await visible('jcs-more'), `${lang}: no way from Eden Code's Settings to the rest`);
  await js(`document.getElementById('jcs-more').click(); true`);
  await sleep(200);
  check(await js(`!document.getElementById('settings').hidden && document.getElementById('jc-settings').hidden`), `${lang}: More settings didn't open the shared sheet`);
  where('the shared Settings', await js(AUDIT(lang === 'zh')));
  await js(`toggleSettings(false); true`);
  // A session, every pane, the More menu.
  await js(`onEvent({ type: 'tasks', items: [{ id: 1, kind: 'code', folder: 'alpha', cwd: '/tmp/alpha', label: 'Eden Code · alpha', title: 'Session 1', prompt: 'x', mode: 'ask', busy: false, status: 'idle', files_changed: [], todos: [], background: [], queue: [], last_action: '', add_dirs: [], plugins: [] }] }); selectTask(1); true`);
  await sleep(200);
  where('a session', await js(AUDIT(lang === 'zh')));
  const panes = await js(`[...featurePanes.keys(), ...Object.keys(PANE_TITLES)].filter((v, i, a) => a.indexOf(v) === i)`);
  for (const p of panes) {
    try { await js(`openPane(${JSON.stringify(p)}); true`); } catch (e) { check(false, `${lang} pane ${p}: ${e}`); continue; }
    await sleep(80);
    where(`pane ${p}`, await js(AUDIT(lang === 'zh')));
  }
  await js(`closePane && closePane(); true`).catch(() => {});
  await js(`document.getElementById('jc-more').click(); true`);
  await sleep(150);
  where('the More menu', await js(AUDIT(lang === 'zh')));
  await js(`closeMenu(); true`);
  // Setup, every card.
  await js(`window.jarvisIntro.open(); true`);
  await sleep(150);
  const seen = [];
  for (let i = 0; i < 10; i++) {
    const card = await js('window.jarvisIntro.card()');
    seen.push(card);
    where(`Setup › ${card}`, await js(AUDIT(lang === 'zh')));
    if (card === 'done') break;
    await js(`document.getElementById('intro-next').click(); true`);
    await sleep(120);
  }
  check(seen.at(-1) === 'done', `${lang}: Setup never reached its last card (${seen})`);
  await js(`window.jarvisIntro.close(); true`);
  // An Eden Secretary window joins: the backend listens, and the voice switch comes back.
  await js(`heard({ type: 'app_windows', windows: { jarvis: 1, 'eden-code': 1 }, profile: 'full' }); true`);
  await sleep(100);
  check(await visible('cc-voice-head'), `${lang}: the voice switch stayed hidden once the backend listens`);
  check(await visible('jc-dictate'), `${lang}: Dictate stayed hidden once the backend listens`);
  check(!errors.length, `${lang}: page errors ${JSON.stringify(errors.slice(0, 5))}`);
  return win;  // (closed at the end: one destroyed here made the next window's load fail)
}

app.whenReady().then(async () => {
  const server = await serve();
  const { port } = server.address();
  try {
    const wins = [];
    for (const lang of (process.env.LANGS || 'en,zh').split(',')) wins.push(await run(port, lang));
    for (const w of wins) w.destroy();
  } catch (err) {
    failed++;
    console.error('not ok -', err && err.stack ? err.stack : err);
  }
  server.close();
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) { /* Chromium still holds it */ }
  console.log(failed ? `${failed} failed` : 'ok - Eden Code names itself, in English and Chinese');
  app.exit(failed ? 1 : 0);
});
