// Round 2's stress pass on the window (src/jarvis/web), in a real Chromium with no backend, as
// tests/web/window.e2e.cjs and scripts/stress_code_ui.cjs drive it: Node serves the window's
// files on 127.0.0.1 with every feature module (as features.json lists them) and the merged
// Chinese strings, events go to the window's own onEvent() and featureEvent(), send() is
// recorded instead of sent. A stand-in for preload.js gives the page a window.jarvisApp whose
// browser events the test raises (as main.js's would arrive). No window is shown; nothing
// leaves 127.0.0.1.
//
//   app/node_modules/.bin/electron tests/web/stress-r2-electron.e2e.cjs      (about a minute; exit 1 on a failure)
//
// STRESS_ONLY=<regex> runs only the tests whose names match. Each test is named after the
// behaviour that should hold; the numbers each one measured are printed at the end.
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const WEB = process.env.JARVIS_WEB_DIR || path.join(__dirname, '..', '..', 'src', 'jarvis', 'web');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
// One folder of its own, emptied at the start and at the end (Chromium may still write a few
// files into it as it quits: the next run clears them).
const ROOT = path.join(process.env.TMPDIR || os.tmpdir(), 'jarvis-stress-r2-window');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
app.setPath('userData', path.join(ROOT, 'userData'));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
app.commandLine.appendSwitch('js-flags', '--expose-gc');
app.commandLine.appendSwitch('use-mock-keychain'); // never the Mac's Keychain

const FEATURES = fs.readdirSync(path.join(WEB, 'features')).sort();
// server.zh_strings: i18n-zh.json with each feature's web/i18n/*.json merged in, in name order.
function zhStrings() {
  const merged = { strings: {}, patterns: [] };
  const dir = path.join(WEB, 'i18n');
  for (const file of [path.join(WEB, 'i18n-zh.json'), ...fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(dir, f))]) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      Object.assign(merged.strings, data.strings || {});
      merged.patterns.push(...(data.patterns || []));
    } catch { /* skipped, as the server does */ }
  }
  return merged;
}

function serve() {
  const zh = JSON.stringify(zhStrings());
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    if (pathname === '/features.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ scripts: FEATURES.filter((f) => f.endsWith('.js')).map((f) => `/static/features/${f}`), styles: FEATURES.filter((f) => f.endsWith('.css')).map((f) => `/static/features/${f}`) }));
      return;
    }
    if (pathname === '/static/i18n-zh.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(zh);
      return;
    }
    const name = pathname === '/' ? 'index.html'
      : pathname.startsWith('/static/features/') ? `features/${path.basename(pathname)}`
        : pathname.startsWith('/static/') ? path.basename(pathname) : '';
    fs.readFile(path.join(WEB, name || '-'), (err, data) => {
      if (err || !name) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(name)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// preload.js's window.jarvisApp, with nothing behind it: its browser events are raised by the
// test (jarvisApp.__emit), and what the page asks of it answers nothing.
const PRELOAD = path.join(ROOT, 'stand-in-preload.js');
fs.writeFileSync(PRELOAD, `
const { contextBridge } = require('electron');
const handlers = {};
const on = (name) => (callback) => { (handlers[name] = handlers[name] || []).push(callback); };
const nothing = () => Promise.resolve(null);
contextBridge.exposeInMainWorld('jarvisApp', {
  onSummon: on('summon'), onWhatsThis: on('whats-this'), attention: () => {}, pickFolder: nothing, pdf: () => Promise.resolve(''),
  desktopHands: () => {}, handHud: () => {}, pathFor: () => '',
  feature: { invoke: () => Promise.resolve(null), send: () => {}, on: (channel, callback) => on('feature ' + channel)(callback) },
  browser: {
    show: nothing, hide: nothing, setBounds: nothing, nav: nothing, command: () => Promise.resolve({ ok: false }), tab: nothing,
    find: () => Promise.resolve({ matches: 0 }), data: () => Promise.resolve({ bookmarks: [], history: [] }), download: nothing,
    shortcut: nothing, shields: nothing, researchLock: () => Promise.resolve(false), hand: () => {},
    onFound: on('found'), onShortcut: on('shortcut'), onDownload: on('download'), onPageFullscreen: on('page-fullscreen'),
    onState: on('state'), onOpen: on('open'), onHover: on('hover'), onNote: on('note'), onEscape: on('escape'),
  },
  __emit: (name, payload) => { for (const callback of handlers[name] || []) callback(payload); return (handlers[name] || []).length; },
});
`);

let win;
let base;
const js = (code) => win.webContents.executeJavaScript(code, true);
const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = (n = 2) => js(`new Promise((r) => { let k = ${n}; const f = () => (--k ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); })`);

async function heapMB() {
  await cdp('HeapProfiler.collectGarbage');
  const { usedSize } = await cdp('Runtime.getHeapUsage');
  return Math.round(usedSize / 104857.6) / 10;
}
// { documents, nodes, jsEventListeners }, after a garbage collection (a page loaded before
// this one, or nodes just let go of, would count otherwise).
async function counters() {
  await cdp('HeapProfiler.collectGarbage');
  await js('window.gc && gc(); true');
  return cdp('Memory.getDOMCounters');
}

// Page errors a test didn't expect fail it (the network's own, with no backend, are expected).
let pageErrors = [];
const NETWORK = /Failed to load resource|WebSocket|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|fonts\.g|net::ERR/;

// A fresh window: every feature module in, the hub's hello, send() recorded instead of sent,
// and watchers for long tasks, CSP violations and the payloads' own marks.
async function fresh(language = 'en') {
  await win.loadURL(`${base}/?token=stress`);
  const want = FEATURES.filter((f) => f.endsWith('.js')).length;
  for (let i = 0; i < 200 && (await js('document.querySelectorAll(\'script[src^="/static/features/"]\').length')) < want; i++) await sleep(50);
  await js('new Promise((r) => (document.readyState === "complete" ? setTimeout(r, 300) : addEventListener("load", () => setTimeout(r, 300))))');
  await js(`
    window.__sent = [];
    send = (m) => { __sent.push(m); return true; };
    window.__ev = (ev) => { onEvent(ev); featureEvent(ev); };
    window.__xss = 0;
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => __csp.push(e.violatedDirective + ' ' + (e.blockedURI || '') + ' ' + (e.sample || '')));
    window.__long = [];
    new PerformanceObserver((list) => { for (const e of list.getEntries()) __long.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] });
    __ev({ type: 'hello', hub_id: 'hub-stress', state: 'idle', muted: true, status: {}, activity: [], tasks: [],
      prefs: { look: 'orb', language: ${JSON.stringify(language)}, models: [], personas: [], humor: 50, features: {} }, brain: {}, approvals: [], history: [] });
    window.__task = (id, extra = {}) => ({ id, kind: 'code', folder: 'alpha', label: 'Jarvis Code · alpha', title: 'Session ' + id, prompt: 'Session ' + id,
      mode: 'ask', busy: true, status: 'running', files_changed: [], todos: [], background: [], queue: [], last_action: 'Reading a.py', add_dirs: [], plugins: [], ...extra });
    window.__open = (id, extra = {}) => { deckProjects = [{ name: 'alpha', branch: 'main' }]; deckProject = 'alpha'; openProjects.add('alpha');
      __ev({ type: 'tasks', items: [__task(id, extra)] }); toggleCC(true); selectTask(id); };
    true`);
  await sleep(100);
  pageErrors = [];
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(cond, message) { if (!cond) throw new Error(message); }
const numbers = [];
const note = (line) => { numbers.push(line); };

// ── what the window renders, with markup and script in every field ──

// Markup, script, links and other schemes, as a page title, an email or a file name could
// carry them. Each marks window.__xss if it ever runs.
const P = [
  '<img src=x onerror="window.__xss=1">', '<script>window.__xss=2</script>', '<svg onload="window.__xss=3"></svg>',
  '[click me](javascript:window.__xss=4)', '<a href="javascript:window.__xss=5">a</a>', '<iframe srcdoc="<script>parent.__xss=6</script>"></iframe>',
  '![pic](javascript:window.__xss=7)', '<javascript:window.__xss=8>', '[d](data:text/html,<script>parent.__xss=9</script>)',
  '[v](vbscript:msgbox)', '<style>body{display:none}</style>', '<details open ontoggle="window.__xss=10">',
  '`<b>code</b>`', '```html\n<img src=x onerror="window.__xss=11">\n```', '**bold** <b onmouseover="window.__xss=12">b</b>', '\u202eRTL',
].join(' ');

async function domVerdict() {
  return js(`(() => {
    const bad = [];
    for (const n of document.querySelectorAll('*')) {
      for (const a of n.attributes) {
        if (/^on/i.test(a.name)) bad.push(n.tagName + ' ' + a.name);
        if (/^(href|src|action|formaction|xlink:href)$/i.test(a.name) && /^\\s*(javascript|vbscript|data:text)/i.test(a.value)) bad.push(n.tagName + ' ' + a.name + '=' + a.value.slice(0, 40));
      }
      if (n.tagName === 'SCRIPT' && !/^\\/static\\//.test(new URL(n.src || 'x:', location.href).pathname) && /__xss/.test(n.textContent)) bad.push('script ' + n.textContent.slice(0, 40));
      if (n.tagName === 'IFRAME' && /__xss/.test(n.getAttribute('srcdoc') || '') && n.getAttribute('sandbox') === null) bad.push('iframe srcdoc');
      if (n.tagName === 'STYLE' && /display:none/.test(n.textContent)) bad.push('style from data');
      if (n.tagName === 'IMG' && n.getAttribute('src') === 'x') bad.push('img src=x');
    }
    return { bad: [...new Set(bad)].slice(0, 12), xss: window.__xss, csp: __csp.slice(0, 5), bodyShown: getComputedStyle(document.body).display !== 'none' };
  })()`);
}

for (const language of ['en', 'zh']) test(`Markup and script in every field the window draws stay text (${language}): nothing runs, nothing is injected`, async () => {
  await fresh(language);
  if (language === 'zh') await sleep(600); // the Chinese strings arrive
  await js(`(() => { const P = ${JSON.stringify(P)};
    __ev({ type: 'prefs', look: 'orb', language: ${JSON.stringify(language)}, models: [{ id: 'm', name: P }], model: 'm', personas: [{ id: 'p', name: P }], persona: 'p', humor: 50, features: {} });
    __ev({ type: 'turn', rid: 'r1', user: P });
    __ev({ type: 'reply', text: P });
    __ev({ type: 'sources', rid: 'r1', items: [{ id: 's1', title: P, source: 'notes' }] });
    __ev({ type: 'files', rid: 'r1', items: [{ name: P, path: '/tmp/' + P, where: P, kind: 'pdf' }] });
    __ev({ type: 'turn_done', rid: 'r1' });
    __ev({ type: 'history', items: [{ role: 'user', text: P, at: new Date().toISOString() }, { role: 'assistant', text: P, at: new Date().toISOString() }] });
    __ev({ type: 'tool', id: 't1', label: P, status: 'done', at: new Date().toISOString(), ms: 20, name: P });
    __ev({ type: 'toast', title: P, text: P });
    __ev({ type: 'suggestion', key: P, title: P, text: P });
    __ev({ type: 'approval', id: 'ap-' + P, task_id: 0, tool: P, question: P, detail: P, choices: [{ id: 'allow', label: P }, { id: 'deny', label: 'No' }] });
    __ev({ type: 'ask_queue', items: [{ id: 'q1', text: P }] });
    __ev({ type: 'video', id: 'v1', title: P, state: 'working', text: P });
    __ev({ type: 'memory', items: [{ id: 'm1', text: P, fact: P, kind: 'fact', at: new Date().toISOString() }] });
    __ev({ type: 'claude_projects', items: [{ name: P, branch: P, path: '/x/' + P }] });
    __open(1, { title: P, prompt: P, label: P, folder: 'alpha', last_action: P, files_changed: [P, 'a/' + P], todos: [{ content: P, status: 'pending' }] });
    __ev({ type: 'task_transcript', id: 1, entries: [
      { n: 0, role: 'user', text: P, uuid: 'u0' },
      { n: 1, role: 'assistant', text: P },
      { n: 2, role: 'tool', tool: P, tool_id: 'x1', text: P, detail: P, output: P, status: 'done' },
      { n: 3, role: 'thinking', text: P },
      { n: 4, role: 'tool', tool: 'Edit', tool_id: 'x2', text: P, detail: P + '\\n-old\\n+new ' + P, status: 'done' },
    ] });
    __ev({ type: 'task_log', id: 1, entry: { n: 5, role: 'assistant', text: '# ' + P + '\\n\\n' + P + '\\n\\n| a | b |\\n|---|---|\\n| ' + P.replace(/\\|/g, '') + ' | x |' } });
    __ev({ type: 'task_stream', id: 1, part: 'text', text: P });
    jarvisApp.__emit('state', { tabs: [{ id: 1, title: P, url: 'https://evil.example/' + encodeURIComponent(P), active: true, loading: false, favicon: 'javascript:window.__xss=13' },
      { id: 2, title: P, url: 'javascript:window.__xss=14', active: false, loading: true, favicon: 'data:image/svg+xml,<svg onload="parent.__xss=15"/>' }],
      url: 'https://evil.example/', title: P, loading: false, canBack: true, canForward: false, locked: false, research: false, zoom: 100,
      shields: { on: true, ready: true, site: P, allowed: false, research: false, blocked: 3, total: 9 } });
    jarvisApp.__emit('download', { id: 1, name: P, state: 'asking', received: 10, total: 100, from: P });
    jarvisApp.__emit('note', { text: P });
    jarvisApp.__emit('hover', { label: P, risky: true });
    return true; })()`);
  await frames(4);
  await sleep(300);
  const v = await domVerdict();
  note(`markup in every field (${language}): ${v.bad.length} injected nodes or attributes, ${v.csp.length} CSP violations, __xss=${v.xss}`);
  assert(!v.xss, `a payload ran (__xss=${v.xss})`);
  assert(!v.bad.length, `injected: ${v.bad.join(' | ')}`);
  assert(!v.csp.length, `the page tried to load or run what a payload put in: ${v.csp.join(' | ')}`);
  assert(v.bodyShown, 'a payload’s style hid the page');
});

// Words with no place to break, a direction override and stacked accents, as a file name, a
// page title or a pasted log line can be.
const LONG = `${'A'.repeat(3000)} https://example.com/${'segment/'.repeat(400)} \u202e${'reversed '.repeat(30)}\u202c ${'Z\u0337\u0327\u031b\u0334\u0335'.repeat(150)}`;

// The window's own controls (its toolbar): where each is, and whether a click at its middle
// reaches it. (The orb's stage scrolls up and down by design: what's below a long reply is
// reached by scrolling it, so only sideways is checked there.)
const CONTROLS = ['settings-btn', 'cc-btn', 'browser-btn', 'activity-btn', 'brain-btn'];
const layout = () => js(`(() => {
  const out = { pageWide: document.documentElement.scrollWidth - innerWidth, bodyWide: document.body.scrollWidth - innerWidth, reachable: [] };
  for (const id of ${JSON.stringify(CONTROLS)}) {
    const n = document.getElementById(id);
    if (!n || !n.getClientRects().length) continue;
    const b = n.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) continue;
    const x = b.left + b.width / 2, y = b.top + b.height / 2;
    const inside = x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight;
    const hit = inside ? document.elementFromPoint(x, y) : null;
    if (inside && hit && (hit === n || n.contains(hit) || hit.contains(n))) out.reachable.push(id);
  }
  return out; })()`);

// How much of an element's box sideways is cut off: by the window's edges, or by an ancestor
// that clips what overflows it.
const cutOff = (id) => js(`(() => {
  const n = document.getElementById(${JSON.stringify(id)});
  if (!n || !n.getClientRects().length) return null;
  const b = n.getBoundingClientRect();
  let left = 0, right = innerWidth, by = 'the window';
  for (let a = n.parentElement; a && a !== document.documentElement; a = a.parentElement) {
    if (getComputedStyle(a).overflowX === 'visible') continue;
    const r = a.getBoundingClientRect();
    if (r.left > left) { left = r.left; by = a.tagName.toLowerCase() + (a.className ? '.' + String(a.className).split(' ')[0] : ''); }
    if (r.right < right) { right = r.right; by = a.tagName.toLowerCase() + (a.className ? '.' + String(a.className).split(' ')[0] : ''); }
  }
  return { cut: Math.round(Math.max(0, left - b.left) + Math.max(0, b.right - right)), width: Math.round(b.width), by };
})()`);

// A link as Claude gives one (directions in Maps): 164 characters with nowhere to break.
const MAPS = 'https://www.google.com/maps/dir/37.7749,-122.4194/37.8044,-122.2712/@37.79,-122.35,12z/data=!3m1!4b1!4m2!4m1!3e0?entry=ttu&g_ep=EgoyMDI1MTAwMS4wIKXMDSoASAFQAw%3D%3D';

for (const look of ['orb', 'obsidian', 'console', 'glass']) {
  test(`In the ${look} look, a request and a reply carrying a long link show all of it inside the window`, async () => {
    await fresh();
    await js(`__ev({ type: 'prefs', look: '${look}', glass_tone: 'dark', language: 'en', models: [], personas: [], humor: 50, features: {} }); true`);
    await frames(2);
    await js(`__ev({ type: 'turn', rid: 'r1', user: 'Open ${MAPS}' }); __ev({ type: 'reply', text: 'Here are the directions: ${MAPS}' }); true`);
    await frames(3);
    const reply = await cutOff('reply');
    const heard = await cutOff('heard');
    const say = (r) => (r ? `${r.width}px wide, ${r.cut}px of it cut off by ${r.by}` : 'not shown in this look');
    note(`${look}: a ${MAPS.length}-character link: the reply ${say(reply)}; the request ${say(heard)}`);
    assert((!reply || reply.cut <= 1) && (!heard || heard.cut <= 1), `the reply: ${say(reply)}; the request: ${say(heard)} (the link's start and end can't be read)`);
  });

  // The Markdown reply (features/rich-chat.js draws it in #reply-rich): a list with bare links
  // wraps, and a line of code or a table, which can't, scrolls sideways inside the reply.
  for (const [kind, text] of [
    ['a list of bare links', `Two ways:\n\n- by car: ${MAPS}\n- on foot: ${MAPS}`],
    ['a long line of code', `Run this:\n\n\`\`\`\ncurl -sSL '${MAPS}' | python3 -m json.tool --sort-keys --indent 4\n\`\`\``],
    ['a table of links', `| place | link |\n|---|---|\n| Oakland | ${MAPS} |\n| San Francisco | ${MAPS} |`],
  ]) {
    test(`In the ${look} look, a Markdown reply with ${kind} keeps both its edges inside the window`, async () => {
      await fresh();
      await js(`__ev({ type: 'prefs', look: '${look}', glass_tone: 'dark', language: 'en', models: [], personas: [], humor: 50, features: {} }); true`);
      await frames(2);
      await js(`__ev({ type: 'turn', rid: 'r1', user: 'How do I get there?' }); __ev({ type: 'reply', text: ${JSON.stringify(text)} }); true`);
      await frames(3);
      const rich = await cutOff('reply-rich');
      const say = rich ? `${rich.width}px wide, ${rich.cut}px of it cut off by ${rich.by}` : 'not shown in this look';
      note(`${look}: a Markdown reply with ${kind}: ${say}`);
      assert(rich || look === 'console', 'the Markdown reply was not shown'); // the console look has no caption
      assert(!rich || rich.cut <= 1, `the Markdown reply: ${say}`);
    });
  }

  test(`In the ${look} look, markup-free words with nowhere to break in every hub field never widen the window or cover its toolbar`, async () => {
    await fresh();
    await js(`__ev({ type: 'prefs', look: '${look}', glass_tone: 'dark', language: 'en', models: [], personas: [], humor: 50, features: {} }); true`);
    await frames(3);
    const before = await layout();
    await longEverywhere();
    const after = await layout();
    const lost = before.reachable.filter((id) => !after.reachable.includes(id));
    note(`${look}: long words in every hub field: page ${after.pageWide}px wider than the window (was ${before.pageWide}), toolbar controls lost: ${lost.join(', ') || 'none'}`);
    assert(after.pageWide <= Math.max(0, before.pageWide) + 1 && after.bodyWide <= Math.max(0, before.bodyWide) + 1, `the page became ${after.pageWide}px wider than the window`);
    assert(!lost.length, `controls covered or pushed out: ${lost.join(', ')}`);
  });
}

async function longEverywhere() {
  await js(`(() => { const P = ${JSON.stringify(LONG)};
    __ev({ type: 'turn', rid: 'r1', user: P });
    __ev({ type: 'reply', text: P });
    __ev({ type: 'sources', rid: 'r1', items: [{ id: 's1', title: P, source: 'notes' }] });
    __ev({ type: 'files', rid: 'r1', items: [{ name: P, path: '/tmp/' + P, where: P, kind: 'pdf' }] });
    __ev({ type: 'turn_done', rid: 'r1' });
    __ev({ type: 'tool', id: 't1', label: P, status: 'running', at: new Date().toISOString() });
    __ev({ type: 'toast', title: P, text: P });
    __ev({ type: 'suggestion', key: 'k', title: P, text: P });
    __ev({ type: 'approval', id: 'ap1', task_id: 0, tool: P, question: P, detail: P, choices: [{ id: 'allow', label: P }, { id: 'deny', label: 'No' }] });
    __ev({ type: 'ask_queue', items: [{ id: 'q1', text: P }] });
    return true; })()`);
  await frames(3);
}

test('In Jarvis Code, a session, its files and its transcript with words that never break keep the window its width', async () => {
  await fresh();
  await js('__open(1); true');
  await frames(3);
  const before = await layout();
  await js(`(() => { const P = ${JSON.stringify(LONG)};
    __ev({ type: 'tasks', items: [__task(1, { title: P, prompt: P, label: P, last_action: P, files_changed: [P, 'src/' + P], todos: [{ content: P, status: 'in_progress' }], queue: [{ id: 'q', text: P }] })] });
    __ev({ type: 'task_transcript', id: 1, entries: [
      { n: 0, role: 'user', text: P, uuid: 'u0' }, { n: 1, role: 'assistant', text: P }, { n: 2, role: 'assistant', text: '| ' + P + ' | b |\\n|---|---|\\n| ' + P + ' | 2 |' },
      { n: 3, role: 'tool', tool: P, tool_id: 'x1', text: P, detail: P, output: P, status: 'done' }, { n: 4, role: 'thinking', text: P },
      { n: 5, role: 'assistant', text: '\`\`\`\\n' + P + '\\n\`\`\`' }] });
    __ev({ type: 'approval', id: 'ap2', task_id: 1, tool: 'Bash', question: P, detail: '$ ' + P, choices: [{ id: 'allow', label: 'Yes' }, { id: 'deny', label: 'No' }] });
    return true; })()`);
  await frames(4);
  const after = await layout();
  const composer = await js('(() => { const b = $("deck-input").getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth + 1 && b.width > 50; })()');
  note(`Jarvis Code with long words everywhere: page ${after.pageWide}px wider (was ${before.pageWide}), composer inside the window: ${composer}`);
  assert(after.pageWide <= Math.max(0, before.pageWide) + 1, `the page became ${after.pageWide}px wider than the window`);
  assert(composer, 'the composer was pushed out of the window');
});

test('A model added with a long name never makes the window wider than itself', async () => {
  await fresh();
  const name = 'openrouter/anthropic/claude-sonnet-4.5-20250929:extended-thinking (work account)';
  await js(`__ev({ type: 'prefs', look: 'orb', language: 'en', models: [{ id: 'm', name: ${JSON.stringify(name)} }], model: 'm', personas: [], humor: 50, features: {} }); true`);
  await frames(3);
  const r = await layout();
  const chip = await cutOff('model-chip');
  note(`an ${name.length}-character model name: page ${r.pageWide}px wider than the window; model chip ${chip ? `${chip.width}px wide` : 'hidden'}`);
  assert(r.pageWide <= 1, `the page is ${r.pageWide}px wider than the window`);
});

// ── huge Markdown ──

test('A 3 MB Markdown reply in Jarvis Code is drawn without freezing the window for seconds', async () => {
  await fresh();
  await js('__open(1); true');
  const md = await js(`(() => { const parts = []; for (let i = 0; parts.join('').length < 3e6; i++) {
    parts.push('## Section ' + i + '\\n\\nSome **bold** and _italic_ words, \`code\`, a [link](https://example.com/' + i + ') and more words to read.\\n\\n- item one\\n- item two\\n\\n| a | b |\\n|---|---|\\n| 1 | 2 |\\n\\n\`\`\`js\\nconst x = ' + i + ';\\n\`\`\`\\n\\n'); }
    window.__md = parts.join(''); return __md.length; })()`);
  await js('__long.length = 0; true');
  const ms = await js(`new Promise((resolve) => { const s = performance.now(); __ev({ type: 'task_log', id: 1, entry: { n: 1, role: 'assistant', text: __md } });
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(Math.round(performance.now() - s)))); })`);
  const long = await js('Math.max(0, ...__long)');
  const nodes = (await counters()).nodes;
  note(`a ${Math.round(md / 1e6 * 10) / 10} MB Markdown reply in Jarvis Code: ${ms} ms to draw, longest task ${long} ms, ${nodes} DOM nodes`);
  assert(ms < 3000, `${ms} ms to draw it`);
});

// ── looks and languages, switched again and again ──

test('Switching the look 200 times leaves no extra listeners, nodes, heap or animation loops behind', async () => {
  await fresh();
  const looks = ['orb', 'obsidian', 'console', 'glass'];
  const rafRate = () => js(`new Promise((resolve) => { const real = window.requestAnimationFrame; let n = 0;
    window.requestAnimationFrame = (f) => { n++; return real.call(window, f); };
    setTimeout(() => { window.requestAnimationFrame = real; resolve(n); }, 1000); })`);
  const prefs = (look, extra = '') => `__ev({ type: 'prefs', look: '${look}', glass_tone: 'dark', language: 'en', models: [], personas: [], humor: 50, features: {} ${extra} });`;
  // Once through every look, so each has made what it makes once.
  for (const look of [...looks, 'orb']) { await js(`${prefs(look)} true`); await frames(3); }
  await sleep(500);
  const before = { ...(await counters()), heap: await heapMB(), raf: await rafRate() };
  for (let round = 0; round < 50; round++) {
    await js(`${looks.map((l) => prefs(l)).join('\n')} true`);
    await frames(1);
  }
  await js(`${prefs('orb')} true`);
  await frames(3);
  await sleep(500);
  const after = { ...(await counters()), heap: await heapMB(), raf: await rafRate() };
  note(`200 look switches: listeners ${before.jsEventListeners} -> ${after.jsEventListeners}, nodes ${before.nodes} -> ${after.nodes}, heap ${before.heap} -> ${after.heap} MB, animation frames asked a second ${before.raf} -> ${after.raf}`);
  assert(after.jsEventListeners - before.jsEventListeners <= 20, `listeners ${before.jsEventListeners} -> ${after.jsEventListeners}`);
  assert(after.nodes - before.nodes <= 500, `nodes ${before.nodes} -> ${after.nodes}`);
  assert(after.raf <= before.raf * 1.5 + 30, `animation frames a second ${before.raf} -> ${after.raf}`);
  assert(after.heap <= before.heap * 1.3 + 3, `heap ${before.heap} -> ${after.heap} MB`);
});

test('Switching between English and Chinese 40 times stays bounded, and the owner’s words stay as written', async () => {
  await fresh();
  const setLang = (lang) => `__ev({ type: 'prefs', look: 'orb', language: '${lang}', models: [], personas: [], humor: 50, features: {} });`;
  await js(`${setLang('zh')} true`);
  await sleep(800); // the Chinese strings arrive
  await js(`${setLang('en')} true`);
  await frames(3);
  const before = { ...(await counters()), heap: await heapMB() };
  for (let i = 0; i < 20; i++) {
    await js(`${setLang('zh')} ${setLang('en')} true`);
    await frames(1);
  }
  await js(`${setLang('zh')} true`);
  await sleep(400);
  await js(`__ev({ type: 'turn', rid: 'z', user: 'Settings and History' }); __ev({ type: 'reply', text: 'Settings' }); __ev({ type: 'turn_done', rid: 'z' }); true`);
  await frames(3);
  const words = await js('[...$("history").children].slice(-2).map((li) => li.firstChild.nodeValue)');
  const settingsLabel = await js('(document.querySelector("#settings h2, #settings-title") || {}).textContent || ""');
  await js(`${setLang('en')} true`);
  await frames(3);
  const after = { ...(await counters()), heap: await heapMB() };
  note(`40 language switches: listeners ${before.jsEventListeners} -> ${after.jsEventListeners}, nodes ${before.nodes} -> ${after.nodes}, heap ${before.heap} -> ${after.heap} MB; in Chinese the owner's words read ${JSON.stringify(words)}, a heading "${settingsLabel}"`);
  assert(JSON.stringify(words) === JSON.stringify(['Settings and History', 'Settings']), `the owner's words were translated: ${JSON.stringify(words)}`);
  assert(after.jsEventListeners - before.jsEventListeners <= 20, `listeners ${before.jsEventListeners} -> ${after.jsEventListeners}`);
  assert(after.nodes - before.nodes <= 500, `nodes ${before.nodes} -> ${after.nodes}`);
  assert(after.heap <= before.heap * 1.3 + 3, `heap ${before.heap} -> ${after.heap} MB`);
});

// ── the built-in browser's tab strip, as main.js floods it ──

test('The tab strip keeps up with a page renaming itself beside a dozen tabs with pictures for icons', async () => {
  await fresh();
  await js('typeof toggleBrowser === "function" && toggleBrowser(true); true');
  // What main.js sent in the main-process test: 13 tabs, 12 with a 90 KB data: icon, the 13th
  // renaming itself; about 92 states a second.
  const icon = `data:image/png;base64,${Buffer.alloc(67000, 3).toString('base64')}`;
  await js(`window.__icon = ${JSON.stringify(icon)}; window.__stateOf = (n) => ({ tabs: [
      ...Array.from({ length: 12 }, (_, i) => ({ id: i + 1, title: 'Icon ' + i, url: 'http://127.0.0.1/bigicon?i=' + i, loading: false, research: false, active: false, favicon: __icon })),
      { id: 13, title: 'T' + n, url: 'http://127.0.0.1/titles', loading: false, research: false, active: true, favicon: '' }],
    shields: { on: true, ready: true, site: '127.0.0.1', allowed: false, research: false, blocked: 0, total: 0 },
    url: 'http://127.0.0.1/titles', title: 'T' + n, loading: false, canBack: false, canForward: false, locked: false, lockWanted: false, research: false, zoom: 100 }); true`);
  await js('__long.length = 0; true');
  const r = await js(`new Promise((resolve) => { let n = 0; let worst = 0; let last = performance.now();
    const tick = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last - 10); last = now; }, 10);
    const t = setInterval(() => { jarvisApp.__emit('state', __stateOf(n++)); if (n >= 184) { clearInterval(t); setTimeout(() => { clearInterval(tick); resolve({ n, worst: Math.round(worst) }); }, 200); } }, 11); })`);
  const long = await js('({ count: __long.length, max: Math.max(0, ...__long), total: __long.reduce((a, b) => a + b, 0) })');
  note(`184 tab-strip states in 2 s (13 tabs, 12 with 90 KB icons): ${long.count} long tasks totalling ${long.total} ms (longest ${long.max} ms), window event loop late by up to ${r.worst} ms`);
  assert(long.total < 1000, `${long.total} ms of long tasks in 2 s of tab-strip updates (longest ${long.max} ms)`);
});

test('Switching between 30 browser tabs 600 times leaves no extra listeners or nodes behind', async () => {
  await fresh();
  await js('typeof toggleBrowser === "function" && toggleBrowser(true); true');
  await js(`window.__tabsState = (active) => ({ tabs: Array.from({ length: 30 }, (_, i) => ({ id: i + 1, title: 'Tab ' + i, url: 'https://site' + i + '.example/', loading: false, research: false, active: i === active, favicon: '' })),
    shields: { on: true, ready: true, site: 'site.example', allowed: false, research: false, blocked: 0, total: 0 },
    url: 'https://site' + active + '.example/', title: 'Tab ' + active, loading: false, canBack: true, canForward: false, locked: false, lockWanted: false, research: false, zoom: 100 }); true`);
  await js('jarvisApp.__emit("state", __tabsState(0)); true');
  await frames(2);
  const before = await counters();
  await js('__long.length = 0; true');
  for (let round = 0; round < 6; round++) {
    await js(`for (let i = 0; i < 100; i++) jarvisApp.__emit('state', __tabsState((i * 7 + ${round}) % 30)); true`);
    await frames(1);
  }
  await js('jarvisApp.__emit("state", __tabsState(0)); true');
  await frames(2);
  const after = await counters();
  const long = await js('({ count: __long.length, max: Math.max(0, ...__long) })');
  note(`600 tab switches among 30 tabs: listeners ${before.jsEventListeners} -> ${after.jsEventListeners}, nodes ${before.nodes} -> ${after.nodes}, ${long.count} long tasks (longest ${long.max} ms)`);
  assert(after.jsEventListeners - before.jsEventListeners <= 20, `listeners ${before.jsEventListeners} -> ${after.jsEventListeners}`);
  assert(after.nodes - before.nodes <= 200, `nodes ${before.nodes} -> ${after.nodes}`);
});

// ── run ──

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const server = await serve();
  base = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({ show: false, width: 1280, height: 840, webPreferences: { preload: PRELOAD, backgroundThrottling: false, contextIsolation: true, sandbox: true } });
  win.webContents.debugger.attach('1.3');
  win.webContents.on('console-message', (e) => { if (e.level === 'error' && !NETWORK.test(e.message)) pageErrors.push(e.message); });
  let passed = 0;
  let failed = 0;
  const only = process.env.STRESS_ONLY ? new RegExp(process.env.STRESS_ONLY, 'i') : null;
  for (const t of tests.filter((x) => !only || only.test(x.name))) {
    try {
      await t.fn();
      if (pageErrors.length) throw new Error(`page errors: ${[...new Set(pageErrors)].slice(0, 4).join(' | ')}`);
      passed += 1;
      console.log(`ok   ${t.name}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL ${t.name}\n     ${String(err && err.message ? err.message : err).split('\n').join('\n     ')}`);
    }
  }
  console.log('\nnumbers:');
  for (const line of numbers) console.log(`  ${line}`);
  console.log(`\n${passed} passed, ${failed} failed`);
  server.close();
  win.destroy();
  app.exit(failed ? 1 : 0);
});
setTimeout(() => { console.error('the stress run took too long'); app.exit(1); }, 300000).unref();
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* gone already */ } });
