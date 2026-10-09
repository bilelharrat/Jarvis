// Stress test of the Eden Code window: long transcripts, floods of events, and switching
// sessions many times, with every feature module loaded as features.js loads them. Like the
// window tests: a hidden window, the window's files served on 127.0.0.1, events handed to the
// window's own onEvent() and featureEvent(), send() recorded instead of sent. No backend, no
// model, nothing leaves 127.0.0.1.
//
//   app/node_modules/.bin/electron scripts/stress_code_ui.cjs      (about a minute)
//
// It prints what it measured (times, DOM nodes, JavaScript heap after a garbage collection,
// listeners on document and window) and exits 1 when something grew without bound.
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const WEB = path.join(__dirname, '..', 'src', 'jarvis', 'web');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
app.setPath('userData', fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jarvis-stress-')));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
app.commandLine.appendSwitch('js-flags', '--expose-gc');

const FEATURES = fs.readdirSync(path.join(WEB, 'features')).sort();
function serve() {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    let file = '';
    if (pathname === '/') file = 'index.html';
    else if (pathname === '/features.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ scripts: FEATURES.filter((f) => f.endsWith('.js')).map((f) => `/static/features/${f}`), styles: FEATURES.filter((f) => f.endsWith('.css')).map((f) => `/static/features/${f}`) }));
      return;
    } else if (pathname.startsWith('/static/features/')) file = `features/${path.basename(pathname)}`;
    else if (pathname.startsWith('/static/')) file = path.basename(pathname);
    fs.readFile(path.join(WEB, file || '-'), (err, data) => {
      if (err || !file) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let win;
const js = (code) => win.webContents.executeJavaScript(code, true);
const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params);
const out = {};
const problems = [];

async function heapMB() {
  await cdp('HeapProfiler.collectGarbage');
  const { usedSize } = await cdp('Runtime.getHeapUsage');
  return Math.round(usedSize / 104857.6) / 10;
}
async function listeners() {
  const count = async (expr) => {
    const { result } = await cdp('Runtime.evaluate', { expression: expr });
    const { listeners: l } = await cdp('DOMDebugger.getEventListeners', { objectId: result.objectId });
    return l.length;
  };
  return { document: await count('document'), window: await count('window') };
}
const nodes = () => js('document.getElementsByTagName("*").length');

// A session's transcript entry of each kind the window draws, Markdown and all.
const ENTRY = `(i) => {
  const k = i % 6;
  if (k === 0) return { n: i, role: 'user', text: 'Step ' + i + ': make hello return ' + i, uuid: 'u-' + i };
  if (k === 1) return { n: i, role: 'tool', tool: 'Edit', tool_id: 'e-' + i, text: 'Editing app.py', detail: 'app.py\\n-    return 1\\n+    return ' + i, status: 'done' };
  if (k === 2) return { n: i, role: 'tool', tool: 'Bash', tool_id: 'b-' + i, text: 'Running pytest', detail: '$ pytest -q', output: '.....\\n5 passed in 0.12s', status: 'done' };
  if (k === 3) return { n: i, role: 'thinking', text: 'The helper reads rows lazily; ' + i };
  if (k === 4) return { n: i, role: 'assistant', text: '## Step ' + i + '\\n\\n- \`app.py\`: \`hello()\` returns **' + i + '**\\n- a [link](https://example.com/' + i + ')\\n\\n| a | b |\\n|---|---|\\n| 1 | 2 |\\n\\n\`\`\`python\\ndef hello():\\n    return ' + i + '\\n\`\`\`\\n' };
  return { n: i, role: 'turn', seconds: 3, tokens: 1200, cost: 0.01 };
}`;

async function transcript() {
  await js(`__open(1); true`);
  const before = { nodes: await nodes(), heap: await heapMB() };
  // 5,000 entries as they come during a session: 50 at a time, a frame between.
  const t0 = Date.now();
  const batches = [];
  for (let b = 0; b < 100; b++) {
    batches.push(await js(`new Promise((resolve) => { const entry = ${ENTRY}; const s = performance.now();
      for (let i = ${b * 50}; i < ${b * 50 + 50}; i++) { const ev = { type: 'task_log', id: 1, entry: entry(i) }; onEvent(ev); featureEvent(ev); }
      requestAnimationFrame(() => resolve(performance.now() - s)); })`));
  }
  batches.sort((a, b) => a - b);
  const appended = { ms: Date.now() - t0, batchMedian: Math.round(batches[50]), batchMax: Math.round(batches[99]), rows: await js('$("deck-timeline").children.length'), nodes: await nodes(), heap: await heapMB() };
  // A session opened with 5,000 entries at once.
  const replayMs = await js(`new Promise((resolve) => { const entry = ${ENTRY}; const entries = Array.from({ length: 5000 }, (_, i) => entry(i));
    const s = performance.now(); const ev = { type: 'task_transcript', id: 1, entries }; onEvent(ev); featureEvent(ev);
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(Math.round(performance.now() - s)))); })`);
  // Scrolling from the newest entry to the oldest, 40 px a frame.
  const scroll = await js(`new Promise((resolve) => {
    const box = $('cc-scroll'); box.scrollTop = box.scrollHeight;
    const times = []; let last = performance.now();
    const step = () => { const now = performance.now(); times.push(now - last); last = now;
      if (box.scrollTop <= 0 || times.length > 1200) { times.shift(); times.sort((a, b) => a - b);
        resolve({ frames: times.length, median: Math.round(times[times.length >> 1] * 10) / 10, p95: Math.round(times[Math.floor(times.length * 0.95)] * 10) / 10, max: Math.round(times[times.length - 1]), over50ms: times.filter((t) => t > 50).length }); return; }
      box.scrollTop -= 40; requestAnimationFrame(step); };
    requestAnimationFrame(step); })`);
  out.transcript = { before, appended, replayMs, afterReplay: { rows: await js('$("deck-timeline").children.length'), nodes: await nodes() }, scroll };
  if (appended.rows > 400) problems.push(`the transcript kept ${appended.rows} rows`);
}

// 1,000 of each event a working session sends, with the panes that draw them open.
async function floods() {
  await js(`__open(1); true`);
  const kinds = {
    task_log: `(i) => ({ type: 'task_log', id: 1, entry: { n: 90000 + i, role: 'assistant', text: 'Reply **' + i + '**' } })`,
    task_stream: `(i) => ({ type: 'task_stream', id: 1, part: i % 7 ? 'text' : 'thinking', text: 'more words ' + i + ' ' })`,
    tasks: `(i) => ({ type: 'tasks', items: [__task(1, { last_action: 'Editing ' + i + '.py', cost_usd: i / 100, files_changed: ['a.py'] }), __task(2, { busy: false, status: 'waiting' })] })`,
    approvals: `(i) => (i % 2 ? { type: 'approval_resolved', id: 'ap' + (i - 1) } : { ...__approval('ap' + i), task_id: 1 })`,
    task_context: `(i) => ({ type: 'task_context', id: 1, percent: i % 100, tokens: 1000 * i, max: 200000, categories: [] })`,
    notices: `(i) => ({ type: 'toast', title: 'Saved', text: 'note ' + i })`,
    devserver_log: `(i) => ({ type: 'devserver_log', key: 'alpha:web', lines: [[i + 1, 'GET /api/' + i + ' 200 3ms']] })`,
    cv_tests_out: `(i) => ({ type: 'cv_tests_out', project: '/Users/x/alpha', lines: [[i + 1, 'test_' + i + ' PASSED']] })`,
    code_meta: `(i) => ({ type: 'code_meta', items: { 1: { draft: 'draft ' + i }, 2: { pinned: i % 2 === 0 } } })`,
    cl_lanes: `(i) => ({ type: 'cl_lanes', id: 1, lanes: [{ id: 'l' + (i % 5), name: 'Explore', state: i % 3 ? 'working' : 'done', tokens: i, cost: i / 1000, started: Date.now() / 1000 - 5, parent: '' }] })`,
  };
  out.floods = {};
  await js(`jarvisFeatures.openPane('lanes'); true`);
  for (const [name, make] of Object.entries(kinds)) {
    const before = await nodes();
    const t0 = Date.now();
    await js(`new Promise((resolve) => { const make = ${make}; let i = 0;
      const burst = () => { for (let k = 0; k < 50 && i < 1000; k++, i++) { const ev = make(i); onEvent(ev); featureEvent(ev); }
        if (i < 1000) requestAnimationFrame(burst); else requestAnimationFrame(() => resolve()); };
      burst(); })`);
    const after = await nodes();
    out.floods[name] = { ms: Date.now() - t0, nodesBefore: before, nodesAfter: after, grew: after - before };
    if (after - before > 2000) problems.push(`${name}: 1,000 events left ${after - before} more nodes`);
  }
  await js('closePane(); document.querySelectorAll("#cards .card.plain").forEach((n) => n.remove()); true');
}

// Switching between 12 sessions of 3 projects 1,000 times, a different pane open every 100,
// each session's transcript arriving as it opens.
async function switching() {
  await js(`deckProjects = ['alpha', 'beta', 'gamma'].map((name) => ({ name, branch: 'main' })); ['alpha', 'beta', 'gamma'].forEach((p) => openProjects.add(p));
    onEvent({ type: 'tasks', items: Array.from({ length: 12 }, (_, i) => __task(i + 1, { folder: ['alpha', 'beta', 'gamma'][i % 3], busy: i % 4 === 0, status: i % 4 ? 'waiting' : 'running' })) });
    toggleCC(true); true`);
  const panes = ['files', 'diff', 'git', 'cv-preview', 'cv-tests', 'cv-problems', 'usage', 'lanes', 'rules', 'mcp', 'audit', 'pr'];
  const samples = [];
  for (let round = 0; round <= 10; round++) {
    if (round) {
      await js(`new Promise((resolve) => { const entry = ${ENTRY}; let k = 0;
        jarvisFeatures.openPane(${JSON.stringify(panes[round % panes.length])});
        const next = () => { for (let j = 0; j < 10 && k < 100; j++, k++) {
            const id = (k % 12) + 1; selectTask(id);
            const ev = { type: 'task_transcript', id, entries: Array.from({ length: 60 }, (_, i) => entry(i)) }; onEvent(ev); featureEvent(ev);
            if (k % 2) { $('deck-input').value = 'draft for ' + id; $('deck-input').dispatchEvent(new Event('input')); }  // (a draft of its own)
          }
          if (k < 100) requestAnimationFrame(next); else requestAnimationFrame(() => resolve()); };
        next(); })`);
    }
    if (round % 2 === 0) samples.push({ switches: round * 100, nodes: await nodes(), heapMB: await heapMB(), ...(await listeners()), sent: await js('__sent.length') });
    await js('__sent.length = 0; true');
  }
  out.switching = samples;
  const first = samples[1] || samples[0];
  const last = samples[samples.length - 1];
  if (last.document - first.document > 20 || last.window - first.window > 20) problems.push(`listeners grew: document ${first.document}→${last.document}, window ${first.window}→${last.window}`);
  if (last.heapMB > first.heapMB * 1.5 + 5) problems.push(`the heap grew: ${first.heapMB} MB → ${last.heapMB} MB`);
  if (last.nodes > first.nodes * 1.5 + 2000) problems.push(`the DOM grew: ${first.nodes} → ${last.nodes} nodes`);
}

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({ show: false, width: 1280, height: 840, webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true } });
  win.webContents.debugger.attach('1.3');
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error' && !/Failed to load resource|WebSocket|ERR_NAME_NOT_RESOLVED|fonts\./.test(e.message)) errors.push(e.message); });
  await win.loadURL(`${base}/?token=stress`);
  // features.js puts the scripts in one after another: all of them in, and the last one run.
  const want = FEATURES.filter((f) => f.endsWith('.js')).length;
  for (let i = 0; i < 200 && (await js('document.querySelectorAll(\'script[src^="/static/features/"]\').length')) < want; i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 500));
  await js(`
    window.__sent = [];
    send = (m) => { __sent.push(m); return true; };
    onEvent({ type: 'hello', hub_id: 'hub-stress', state: 'idle', muted: true, status: {}, activity: [], tasks: [],
      prefs: { look: 'orb', language: 'en', models: [], personas: [], humor: 50, features: {} }, brain: {}, approvals: [], history: [] });
    window.__task = (id, extra = {}) => ({ id, kind: 'code', folder: 'alpha', label: 'Eden Code · alpha', title: 'Session ' + id, prompt: 'Session ' + id,
      mode: 'ask', busy: true, status: 'running', files_changed: [], todos: [], background: [], queue: [], last_action: 'Reading a.py', add_dirs: [], plugins: [], ...extra });
    window.__approval = (id, extra = {}) => ({ type: 'approval', id, task_id: 1, tool: 'Bash', question: 'Run this command?', detail: '$ npm test',
      choices: [{ id: 'allow', label: 'Yes' }, { id: 'deny', label: 'No' }], ...extra });
    window.__open = (id) => { deckProjects = [{ name: 'alpha', branch: 'main' }]; deckProject = 'alpha'; openProjects.add('alpha');
      onEvent({ type: 'tasks', items: [__task(id), __task(2, { busy: false, status: 'waiting' })] }); toggleCC(true); selectTask(id); };
    true`);
  out.loaded = { features: FEATURES.filter((f) => f.endsWith('.js')).length, nodes: await nodes(), heapMB: await heapMB(), ...(await listeners()) };
  for (const step of [transcript, floods, switching]) {
    try { await step(); } catch (err) { problems.push(`${step.name}: ${err.message}`); }
  }
  console.log(JSON.stringify(out, null, 1));
  if (errors.length) problems.push(`page errors: ${[...new Set(errors)].slice(0, 5).join(' | ')}`);
  console.log(problems.length ? `\nPROBLEMS:\n- ${problems.join('\n- ')}` : '\nnothing grew without bound');
  server.close();
  win.destroy();
  app.exit(problems.length ? 1 : 0);
});
