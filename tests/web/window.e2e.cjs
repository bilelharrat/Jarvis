// The window (src/jarvis/web) in a real Chromium, with no backend: Node serves the window's
// files on 127.0.0.1, events go to the window's own onEvent(), and keys and clicks are real
// input events (CDP). No window is shown, nothing leaves 127.0.0.1, no shortcut is taken.
//
//   app/node_modules/.bin/electron tests/web/window.e2e.cjs      (about 15 s; exit 1 on a failure)
//
// JARVIS_WEB_DIR points it at another copy of the window's files.
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const WEB = process.env.JARVIS_WEB_DIR || path.join(__dirname, '..', '..', 'src', 'jarvis', 'web');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

app.setPath('userData', fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jarvis-window-test-')));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');

// Widget documents, as the backend serves them on /f/widgets/<id> (features.widgets): the
// widget tests put theirs here.
const WIDGET_DOCS = new Map();

function serve() {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    // A feature module's window files (loaded by a test that wants one: featureScript).
    const feature = pathname.startsWith('/static/features/') ? `features/${path.basename(pathname)}` : '';
    const name = pathname === '/' ? 'index.html' : feature || (pathname.startsWith('/static/') ? path.basename(pathname) : '');
    if (WIDGET_DOCS.has(pathname)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(WIDGET_DOCS.get(pathname));
      return;
    }
    fs.readFile(path.join(WEB, name || '-'), (err, data) => {
      if (err || !name) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(name)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let win;
const js = (code) => win.webContents.executeJavaScript(code, true);
const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = (n = 2) => js(`new Promise((r) => { let k = ${n}; const f = () => (--k ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); })`);

const CODES = { ' ': ['Space', 32] };
async function key(ch, extra = {}) {
  const [code, vk] = CODES[ch] || (/\d/.test(ch) ? [`Digit${ch}`, 48 + Number(ch)] : [`Key${ch.toUpperCase()}`, ch.toUpperCase().charCodeAt(0)]);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, windowsVirtualKeyCode: vk, text: ch, ...extra });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk });
}
async function type(text) { for (const ch of text) await key(ch); }
async function clickAt(selector, between) {
  const { x, y } = await js(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  if (between) await js(between);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

// A fresh window for each test: the hub's hello, and send() recorded instead of sent.
async function fresh() {
  await win.loadURL(`${base}/?token=test`);
  win.webContents.focus();  // keys go to this page
  await js(`
    window.__sent = [];
    send = (m) => __sent.push(m);
    openResearch = () => Promise.resolve({ ok: true });  // never the Research Center
    onEvent({ type: 'hello', hub_id: 'hub-a', state: 'idle', muted: true, status: {}, activity: [], tasks: [],
      prefs: { look: 'orb', language: 'en', models: [], personas: [], humor: 50 }, brain: {}, approvals: [], history: [] });
    window.__task = (id, extra = {}) => ({ id, kind: 'code', folder: 'alpha', label: 'Jarvis Code · alpha', title: 'Session ' + id, prompt: 'Session ' + id,
      mode: 'ask', busy: true, status: 'running', files_changed: [], todos: [], background: [], queue: [], last_action: 'Reading a.py', add_dirs: [], plugins: [], ...extra });
    window.__open = (id) => {  // Jarvis Code open on session id of alpha
      deckProjects = [{ name: 'alpha', branch: 'main' }]; deckProject = 'alpha'; openProjects.add('alpha');
      onEvent({ type: 'tasks', items: [__task(id)] });
      toggleCC(true);
      selectTask(id);
      __sent.length = 0;
    };
    window.__approval = (id, extra = {}) => ({ type: 'approval', id, task_id: 1, tool: 'Bash', question: 'Run this command?', detail: '$ npm test',
      choices: [{ id: 'allow', label: 'Yes' }, { id: 'always', label: 'Yes, and don’t ask again' }, { id: 'deny', label: 'No' }], ...extra });
    true;
  `);
  await sleep(80);  // toggleCC's focus timer and the like
  // Keys reach this page before the test starts (the first ones after a load can be lost).
  await js('window.__keyed = false; document.addEventListener("keydown", () => { __keyed = true; }, { once: true, capture: true }); true');
  for (let i = 0; i < 40 && !(await js('__keyed')); i++) {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
    await sleep(25);
  }
  if (!(await js('__keyed'))) throw new Error('the page never got a key');
}
const sent = () => js('__sent.map((m) => m.type === "approve" ? "approve " + m.id + " " + m.choice : m.type)');
// Jarvis Code open on session id; waits out the composer's focus timer (40 ms).
const open = async (id, then = '') => { await js(`__open(${id}); ${then}`); await sleep(80); };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(cond, message) { if (!cond) throw new Error(message); }

// ── Space: a space where text goes, a press on a control, the microphone only on the page ──

test('Space is a space in the composer, a Settings text box and a title being renamed', async () => {
  await open(1, '$("deck-input").focus()');
  await type('fix the bug');
  assert(await js('$("deck-input").value') === 'fix the bug', `composer: ${await js('$("deck-input").value')}`);
  await js('toggleCC(false); toggleSettings(true); $("invoice-payment").focus()');
  await type('a b');
  assert(await js('$("invoice-payment").value') === 'a b', 'Settings text box lost its space');
  const s = await sent();
  assert(!s.includes('listen') && !s.includes('stop'), `the microphone was switched: ${s}`);
});

test('Space on a control that answers Space (Markets panel, a disclosure row) never talks', async () => {
  await js('$("p-markets").focus()');
  await key(' ');
  await js('toggleSettings(true); window.__sum = document.querySelector("#settings summary"); __sum.focus(); window.__was = __sum.parentElement.open');
  await key(' ');
  const s = await sent();
  assert(!s.includes('listen') && !s.includes('stop'), `Space on a control switched the microphone: ${s}`);
  assert(await js('__sum.parentElement.open !== __was'), 'Space did not toggle the disclosure row');
});

test('Space held down talks once, not on every auto-repeat', async () => {
  await js('document.activeElement.blur()');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  for (let i = 0; i < 5; i++) await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, autoRepeat: true });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  const s = (await sent()).filter((t) => t === 'listen' || t === 'stop');
  assert(s.length === 1 && s[0] === 'listen', `held Space sent ${s}`);
});

// ── the Jarvis Code transcript ──

test('The transcript keeps the hub’s last 400 entries, newest last', async () => {
  await open(1);
  await js('for (let i = 0; i < 1000; i++) onEvent({ type: "task_log", id: 1, entry: { n: i, role: "assistant", text: "step " + i } })');
  const r = await js('({ rows: $("deck-timeline").children.length, first: $("deck-timeline").firstElementChild.textContent, last: $("deck-timeline").lastElementChild.textContent })');
  assert(r.rows === 400, `${r.rows} rows`);
  assert(r.first.startsWith('step 600') && r.last.startsWith('step 999'), `${r.first} … ${r.last}`);
});

test('Opening a session replays at most 400 entries and lands on the newest', async () => {
  await open(1);
  await js('onEvent({ type: "task_transcript", id: 1, entries: Array.from({ length: 2000 }, (_, i) => ({ n: i, role: "assistant", text: "step " + i })) })');
  await frames(3);
  const r = await js('({ rows: $("deck-timeline").children.length, gap: $("cc-scroll").scrollHeight - $("cc-scroll").scrollTop - $("cc-scroll").clientHeight })');
  assert(r.rows === 400, `${r.rows} rows`);
  assert(r.gap < 4, `not at the newest entry (${r.gap}px short)`);
});

test('A reply streaming in is not redrawn while Jarvis Code is closed, and a long one redraws rarely', async () => {
  await open(1);
  await js(`window.__draws = 0; const real = richText; richText = (t) => { __draws++; return real(t); };
    window.__chunk = 'The parser now reads rows lazily and the tests pass. '.repeat(40);
    toggleCC(false);
    for (let i = 0; i < 30; i++) onEvent({ type: 'task_stream', id: 1, part: 'text', text: __chunk });`);
  await frames(10);
  assert(await js('__draws') === 0, `drawn ${await js('__draws')} times while closed`);
  await js(`toggleCC(true); $('deck-timeline').replaceChildren(); live.text = null; __draws = 0;
    for (let i = 0; i < 50; i++) onEvent({ type: 'task_stream', id: 1, part: 'text', text: __chunk });  // ~100 KB`);
  const t0 = Date.now();
  while (Date.now() - t0 < 1000) { await js('onEvent({ type: "task_stream", id: 1, part: "text", text: "more words " })'); await frames(1); }
  const n = await js('__draws');
  assert(n >= 1 && n <= 5, `a 100 KB reply was redrawn ${n} times in a second`);
});

// ── approvals in the transcript ──

test('A new approval keeps the reason being typed for another one', async () => {
  await open(1, 'onEvent(__approval("A"))');
  await js('[...document.querySelectorAll("[data-approval=\\"A\\"] .jc-choices button")].find((b) => b.textContent.endsWith("No")).click()');
  await type('pin it');
  await js('onEvent(__approval("B", { detail: "$ npm run build" }))');
  await type(' 1');
  const r = await js('({ text: (document.querySelector("[data-approval=\\"A\\"] .jc-feedback input") || { value: "(A was answered)" }).value, sent: __sent.filter((m) => m.type === "approve").length })');
  assert(r.text === 'pin it 1', `the reason became "${r.text}"`);
  assert(r.sent === 0, 'a digit typed in the reason answered an approval');
});

test('Number keys answer only from Jarvis Code itself, once per press', async () => {
  await open(1, 'onEvent(__approval("A"))');
  await js('toggleSettings(true); document.querySelector("#settings summary").focus()');
  await key('1');
  assert(!(await sent()).some((s) => s.startsWith('approve')), 'a 1 pressed in Settings answered the approval');
  await js('toggleSettings(false); document.activeElement.blur()');
  await key('1');
  const s = (await sent()).filter((x) => x.startsWith('approve'));
  assert(s.length === 1 && s[0] === 'approve A allow', `sent ${s}`);
});

// ── a reconnect ──

test('A reconnect replaces what is waiting: answered ones go, new ones get a sheet and keys', async () => {
  await open(1, 'onEvent(__approval("old"))');
  await js('onEvent({ type: "hello", hub_id: "hub-a", state: "idle", muted: true, status: {}, activity: [], tasks: [__task(1)], prefs, brain: {}, approvals: [], history: [] })');
  let r = await js('({ sheets: document.querySelectorAll("#deck-timeline .jc-ask").length, waiting: pendingApprovals.size, asked: __sent.filter((m) => m.type === "task_transcript" && m.id === 1).length })');
  assert(r.sheets === 0 && r.waiting === 0, `an answered approval is still up: ${JSON.stringify(r)}`);
  assert(r.asked === 1, 'the open session’s transcript was not asked for again');
  await js('{ const a = __approval("new"); delete a.type; onEvent({ type: "hello", hub_id: "hub-a", state: "idle", muted: true, status: {}, activity: [], tasks: [__task(1)], prefs, brain: {}, approvals: [a], history: [] }); document.activeElement.blur(); }');
  r = await js('({ sheets: [...document.querySelectorAll("#deck-timeline .jc-ask")].map((n) => n.dataset.approval), cards: [...$("cards").querySelectorAll(".needs-ok")].map((n) => n.dataset.approval) })');
  assert(r.sheets.join() === 'new' && r.cards.join() === 'new', `after reconnect: sheets ${r.sheets}, cards ${r.cards}`);
  // The same approval still waiting across another reconnect: its sheet and its card both stay.
  await js('{ const a = __approval("new"); delete a.type; onEvent({ type: "hello", hub_id: "hub-a", state: "idle", muted: true, status: {}, activity: [], tasks: [__task(1)], prefs, brain: {}, approvals: [a], history: [] }); document.activeElement.blur(); }');
  r = await js('({ sheets: document.querySelectorAll("#deck-timeline .jc-ask").length, cards: $("cards").querySelectorAll(".needs-ok").length })');
  assert(r.sheets === 1 && r.cards === 1, `an approval still waiting lost its card or sheet: ${JSON.stringify(r)}`);
  await key('1');
  assert((await sent()).includes('approve new allow'), 'the number key did not answer the approval from the snapshot');
});

test('A different backend (restarted) never shows its session under the old transcript', async () => {
  await open(1);
  await js('for (let i = 0; i < 3; i++) onEvent({ type: "task_log", id: 1, entry: { n: i, role: "assistant", text: "alpha step " + i } })');
  await js('onEvent({ type: "hello", hub_id: "hub-b", state: "idle", muted: true, status: {}, activity: [], tasks: [__task(1, { folder: "beta", title: "Delete the build" })], prefs, brain: {}, approvals: [], history: [] })');
  await js('onEvent({ type: "task_log", id: 1, entry: { n: 1, role: "assistant", text: "beta: deleting build/" } })');
  const r = await js('({ selected: ccSelected, rows: [...$("deck-timeline").children].map((li) => li.textContent) })');
  assert(r.selected === null && r.rows.length === 0, JSON.stringify(r));
});

// ── the lists the hub resends on every step ──

test('A click survives the task list the hub resends in the middle of it', async () => {
  await js('onEvent({ type: "tasks", items: [__task(1), __task(2)] }); toggleDrawer(true)');
  await clickAt('#tasks-list .task .btn', 'onEvent({ type: "tasks", items: [__task(1, { last_action: "Editing b.py" }), __task(2)] })');
  assert((await sent()).includes('task_cancel'), 'Stop was lost');
  await js('toggleDrawer(false)');
  await open(1, 'onEvent({ type: "tasks", items: [__task(1), __task(2)] }); __sent.length = 0');
  await clickAt('#deck-project-list .jc-session[data-task="2"]', 'onEvent({ type: "tasks", items: [__task(1, { last_action: "Editing c.py" }), __task(2)] })');
  assert(await js('ccSelected') === 2, 'the session row click was lost');
  await js('document.querySelector("#deck-project-list .jc-session[data-task=\\"1\\"]").focus(); onEvent({ type: "tasks", items: [__task(1, { last_action: "Editing d.py" }), __task(2)] })');
  assert(await js('document.activeElement.dataset.task') === '1', 'the keyboard focus was lost');
});

test('The Activity drawer lists running work and the last 20, and activity is capped', async () => {
  await js(`onEvent({ type: 'tasks', items: [__task(1), __task(2), ...Array.from({ length: 60 }, (_, i) => __task(10 + i, { busy: false, status: 'closed' }))] });
    for (let i = 0; i < 1000; i++) onEvent({ type: 'tool', id: 't' + i, label: 'Read calendar', status: 'done', at: new Date().toISOString(), ms: 10 });`);
  await frames(2);
  const r = await js('({ boxes: $("tasks-list").children.length, activity: activity.length, rows: $("activity-list").children.length })');
  assert(r.boxes === 22, `${r.boxes} task boxes`);
  assert(r.activity <= 200 && r.rows === 40, JSON.stringify(r));
});

test('A history or activity item without a usable time is shown, not fatal', async () => {
  await js(`onEvent({ type: 'history', items: [{ role: 'user', text: 'no time' }, { role: 'assistant', text: 'bad time', at: 'yesterday-ish' }] });
    onEvent({ type: 'tool', id: 'x', label: 'Read calendar', status: 'done', at: undefined });`);
  await frames(2);
  const r = await js('({ history: $("history").children.length, activity: $("activity-list").children.length })');
  assert(r.history === 2 && r.activity === 1, JSON.stringify(r));
});

test('The answer streaming in changes its own line of the history, not the list', async () => {
  await js(`onEvent({ type: 'history', items: Array.from({ length: 80 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'message ' + i, at: new Date().toISOString() })) });
    onEvent({ type: 'turn', rid: 'r1', user: 'What is on today?' });
    window.__first = $('history').firstElementChild;
    for (let i = 0; i < 20; i++) onEvent({ type: 'reply', rid: 'r1', text: 'Two meetings ' + i });`);
  const r = await js('({ same: $("history").firstElementChild === __first, last: $("history").lastElementChild.firstChild.nodeValue })');
  assert(r.same, 'the history list was rebuilt for a reply');
  assert(r.last === 'Two meetings 19', `the live line reads "${r.last}"`);
});

// ── notices ──

test('Notices never cover the Settings sheet, Tools & Accounts or Jarvis Code’s Changes pane', async () => {
  const covered = (root) => js(`[...document.querySelectorAll(${JSON.stringify(root)})].filter((e) => { const b = e.getBoundingClientRect(); if (!b.width || !e.checkVisibility()) return false; const h = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return h && h.closest('.cards'); }).length`);
  await js('for (let i = 0; i < 6; i++) onEvent({ type: "error", text: "Connector " + i + " failed" })');
  await js('toggleSettings(true); $("settings").scrollTop = 0');
  await frames(2);
  assert(await covered('#settings [role="switch"], #settings select, #settings input, #settings .btn') === 0, 'a Settings control is under a notice');
  await js('toggleSettings(false); toggleAccounts(true)');
  await frames(2);
  assert(await covered('#accounts button, #accounts input, #accounts select') === 0, 'a Tools & Accounts control is under a notice');
  await js('toggleAccounts(false)');
  await open(1);
  await js('openPane("diff"); diffFiles = [{ path: "src/a.py", added: 2, removed: 1, hunks: [{ line: 3, where: "parse", removed: ["x"], added: ["y", "z"] }] }]; renderPaneBody()');
  await frames(2);
  assert(await covered('#jc-pane summary, #jc-pane pre, #jc-pane button, #cc-scroll li') === 0, 'Jarvis Code is under a notice');
});

test('Two or more notices can be dismissed at once; approvals stay', async () => {
  await js('onEvent(__approval("keep", { task_id: undefined })); for (let i = 0; i < 3; i++) onEvent({ type: "toast", title: "Saved", text: "note " + i })');
  const button = await js('!!document.getElementById("cards-clear")');
  assert(button, 'no Dismiss all');
  await js('document.getElementById("cards-clear").click()');
  const r = await js('({ plain: $("cards").querySelectorAll(".card:not(.needs-ok)").length, approvals: $("cards").querySelectorAll(".needs-ok").length, button: !!document.getElementById("cards-clear") })');
  assert(r.plain === 0 && r.approvals === 1 && !r.button, JSON.stringify(r));
});

// ── the galaxy, and 中文 ──

test('A galaxy of 30,000 notes draws a bounded number of stars a frame, the focused one always', async () => {
  const r = await js(`(() => {
    const nodes = Array.from({ length: 30000 }, (_, i) => ({ id: 'n' + i, title: 'Note ' + i, source: 'notes', group: '', p: [Math.cos(i) * 1.2, (i % 7) / 50, Math.sin(i) * 1.2] }));
    galaxy.setData({ nodes, edges: [], clusters: [] });
    galaxy.flyTo('n1');
    galaxy.resize();
    const ctx = galaxy.ctx, real = ctx.drawImage.bind(ctx);
    let calls = 0; ctx.drawImage = (...a) => { calls++; return real(...a); };
    galaxy.frame(performance.now());
    ctx.drawImage = real;
    return { calls };
  })()`);
  assert(r.calls <= 8100, `${r.calls} stars drawn in one frame`);
});

// ── The window's drag area ──

// What can be pressed but sits in the drag area, the way Electron works it out: every box
// that says drag or no-drag, applied in document order (not by what's painted on top).
const BLOCKED = `(() => {
  const boxes = [];
  for (const el of document.querySelectorAll('*')) {
    const region = getComputedStyle(el).webkitAppRegion;
    if (region !== 'drag' && region !== 'no-drag') continue;
    const r = el.getBoundingClientRect();
    if (r.width && r.height) boxes.push([r, region === 'drag']);
  }
  const drag = (x, y) => { let d = false; for (const [r, v] of boxes) if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) d = v; return d; };
  const blocked = [];
  for (const el of document.querySelectorAll('button, a[href], input, select, textarea, summary, [role="button"], [contenteditable], .jc-title')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
    const x = r.left + r.width / 2, y = r.top + r.height / 2, top = document.elementFromPoint(x, y);
    if ((top === el || el.contains(top)) && drag(x, y)) blocked.push(el.id || el.getAttribute('aria-label') || el.className);
  }
  return { blocked, barDrags: drag(innerWidth / 2, 10) };
})()`;

test('Nothing that can be pressed sits in the window’s drag area, over any panel', async () => {
  // A panel open over the top bar (Jarvis Code's header, the galaxy's search) was inside its
  // drag area: a real click on its buttons only moved the window.
  await js('document.body.classList.add("in-app"); true');  // the app's frameless window
  const seen = {};
  seen.dashboard = await js(BLOCKED);
  await open(1);
  seen.jarvisCode = await js(BLOCKED);
  await js('toggleCC(false); setGalaxyMode("open"); true');
  await sleep(80);
  seen.galaxy = await js(BLOCKED);
  await js('setGalaxyMode("off"); toggleSettings(true); true');
  await sleep(80);
  seen.settings = await js(BLOCKED);
  for (const [where, r] of Object.entries(seen)) {
    assert(!r.blocked.length, `${where}: ${r.blocked.join(', ')} can't be clicked (the window drags)`);
    assert(r.barDrags, `${where}: the top bar no longer drags the window`);
  }
});

test('Switching back to English stops translating the window as it changes', async () => {
  await js('window.jarvisI18n.setLang("zh")');
  await js('window.jarvisI18n.setLang("en")');
  assert(await js('typeof window.jarvisI18n.watching === "function" && window.jarvisI18n.watching() === false'), 'still watching every change in English');
});

// ── the composer's Claude Code features: ?, ↑ history, ⌘F, /copy, /rewind, /resume, /memory ──

const MODS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
async function press(name, mods = []) {
  const [code, vk] = { Enter: ['Enter', 13], ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], Escape: ['Escape', 27], f: ['KeyF', 70] }[name];
  const modifiers = mods.reduce((m, k) => m | MODS[k], 0);
  const text = name === 'Enter' && !modifiers ? '\r' : name === 'f' && !modifiers ? 'f' : undefined;
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code, windowsVirtualKeyCode: vk, modifiers });
  if (text) await cdp('Input.dispatchKeyEvent', { type: 'char', key: name, code, text, modifiers });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: vk, modifiers });
}
const typeText = (text) => cdp('Input.insertText', { text });
const said = (id, uuid, text) => `onEvent({ type: "task_log", id: ${id}, entry: { n: ${JSON.stringify(uuid)}, role: "user", text: ${JSON.stringify(text)}, uuid: ${JSON.stringify(uuid)} } })`;

test('? in an empty composer lists the shortcuts, and Enter sends nothing', async () => {
  await open(1, '$("deck-input").focus()');
  await typeText('?');
  const r = await js('({ shown: !$("cc-slash").hidden, rows: [...$("cc-slash").querySelectorAll("strong")].map((n) => n.textContent) })');
  assert(r.shown && r.rows.includes('⌘F') && r.rows.includes('⇧⇥'), JSON.stringify(r));
  await press('Enter');
  assert(await js('$("deck-input").value') === '' && await js('$("cc-slash").hidden'), 'the list stayed up');
  assert(!(await sent()).some((t) => /task_send|code_command|task_new/.test(t)), `sent ${await sent()}`);
});

test('↑ and ↓ step through your earlier messages and back to the draft', async () => {
  await open(1, `${said(1, 'u1', 'first ask')}; ${said(1, 'u2', 'second ask')}; $("deck-input").focus()`);
  await press('ArrowUp');
  assert(await js('$("deck-input").value') === 'second ask', await js('$("deck-input").value'));
  await press('ArrowUp');
  await press('ArrowUp');  // at the oldest: stays
  assert(await js('$("deck-input").value') === 'first ask', await js('$("deck-input").value'));
  await press('ArrowDown');
  await press('ArrowDown');
  assert(await js('$("deck-input").value') === '', 'did not come back to the empty draft');
  await typeText('a draft');
  await press('ArrowUp');  // a draft with text: ↑ moves the caret, never replaces it
  assert(await js('$("deck-input").value') === 'a draft', 'a draft was replaced');
});

test('⌘F finds in the transcript, Enter steps to older matches, Esc closes', async () => {
  await open(1, `${said(1, 'u1', 'fix the login bug')}; onEvent({ type: "task_log", id: 1, entry: { n: 5, role: "assistant", text: "The login form now retries." } }); onEvent({ type: "task_log", id: 1, entry: { n: 6, role: "assistant", text: "Unrelated." } }); $("deck-input").focus()`);
  await press('f', ['meta']);
  assert(!(await js('$("jc-find").hidden')) && await js('document.activeElement.id') === 'jc-find-input', 'find did not open');
  await typeText('LOGIN');
  let r = await js('({ hits: document.querySelectorAll("#deck-timeline .jc-hit").length, now: document.querySelector("#deck-timeline .jc-hit-now").textContent, count: $("jc-find-count").textContent })');
  assert(r.hits === 2 && r.now.includes('retries') && r.count === '2/2', JSON.stringify(r));
  await press('Enter');
  r = await js('({ now: document.querySelector("#deck-timeline .jc-hit-now").textContent, count: $("jc-find-count").textContent })');
  assert(r.now.includes('fix the login bug') && r.count === '1/2', JSON.stringify(r));
  await press('Escape');
  r = await js('({ hidden: $("jc-find").hidden, marks: document.querySelectorAll("#deck-timeline .jc-hit").length, focus: document.activeElement.id })');
  assert(r.hidden && r.marks === 0 && r.focus === 'deck-input', JSON.stringify(r));
  assert(!(await sent()).includes('task_interrupt'), 'Esc in find interrupted the session');
});

test('/copy copies the last reply as written, /memory opens CLAUDE.md', async () => {
  await open(1, 'onEvent({ type: "task_log", id: 1, entry: { n: 2, role: "assistant", text: "Use **pnpm**:\\n```\\npnpm i\\n```" } }); window.__copied = []; navigator.clipboard.writeText = (t) => { __copied.push(t); return Promise.resolve(); }; $("deck-input").focus()');
  await typeText('/copy');
  await press('Enter');
  await sleep(30);
  assert(await js('__copied[0]') === 'Use **pnpm**:\n```\npnpm i\n```', `copied ${await js('JSON.stringify(__copied)')}`);
  await typeText('/memory');
  await press('Enter');
  const r = await js('({ pane: currentPane, read: __sent.filter((m) => m.type === "file_read").map((m) => m.path) })');
  assert(r.pane === 'files' && r.read.join() === 'CLAUDE.md', JSON.stringify(r));
  assert(!(await sent()).some((t) => /task_send|code_command/.test(t)), `sent ${await sent()}`);
});

test('/rewind lists your messages, newest first, and rewinds to the one picked', async () => {
  await open(1, `${said(1, 'u1', 'add a cache')}; ${said(1, 'u2', 'now test it')}; $("deck-input").focus()`);
  await frames(2);  // the entries take their uuids a frame later
  await typeText('/rewind');
  await press('Enter');
  const items = await js('[...$("jc-menu").querySelectorAll(".mi-label")].map((n) => n.textContent)');
  assert(items.join('|') === 'now test it|add a cache', `menu: ${items}`);
  await js('[...$("jc-menu").querySelectorAll("button")][1].click()');
  const r = await js('__sent.filter((m) => m.type === "task_rewind").map((m) => m.uuid)');
  assert(r.join() === 'u1', `rewound to ${r}`);
});

test('/resume lists the project’s past sessions and resumes the one picked', async () => {
  await open(1, 'pastSessions = [{ session_id: "s-old", title: "Retry refactor", last_modified: "2026-09-01T10:00" }]; $("deck-input").focus()');
  await typeText('/resume');
  await press('Enter');
  assert((await js('[...$("jc-menu").querySelectorAll(".mi-label")].map((n) => n.textContent)')).join() === 'Retry refactor', 'no past session listed');
  await js('$("jc-menu").querySelector("button").click()');
  const r = await js('__sent.filter((m) => m.type === "task_new").map((m) => m.session_id + " " + m.directory)');
  assert(r.join() === 's-old alpha', `sent ${r}`);
});

test('/agents, /hooks and /todos go to the hub, not to Claude as text', async () => {
  await open(1, '$("deck-input").focus()');
  for (const c of ['/agents', '/hooks', '/todos']) { await typeText(c); await press('Enter'); }
  const r = await js('__sent.filter((m) => m.type === "code_command" || m.type === "task_send").map((m) => m.type + " " + m.text)');
  assert(r.join('|') === 'code_command /agents|code_command /hooks|code_command /todos', r.join('|'));
});

test('Revert in Changes asks for a second click, and new files have none', async () => {
  await open(1, 'openPane("diff"); onEvent({ type: "task_diff", id: 1, files: [{ path: "a.py", added: 1, removed: 1, new: false, deleted: false, hunks: [] }, { path: "new.py", added: 3, removed: 0, new: true, deleted: false, hunks: [] }] })');
  const buttons = await js('[...document.querySelectorAll("#jc-pane-body .jc-revert")].map((b) => b.closest("details").querySelector("summary span").textContent)');
  assert(buttons.join() === 'a.py', `revert buttons on ${buttons}`);
  const wasOpen = await js('document.querySelector("#jc-pane-body .jc-revert").closest("details").open');
  await clickAt('#jc-pane-body .jc-revert');
  assert(!(await sent()).includes('task_revert'), 'one click reverted');
  await clickAt('#jc-pane-body .jc-revert');
  const r = await js('({ sent: __sent.filter((m) => m.type === "task_revert").map((m) => m.path), open: document.querySelector("#jc-pane-body .jc-revert").closest("details").open })');
  assert(r.sent.join() === 'a.py' && r.open === wasOpen, JSON.stringify(r));
});

test('Slash commands before there is a session: a mode starts one in it, the rest open or start', async () => {
  await js('deckProjects = [{ name: "alpha", branch: "main" }]; deckProject = "alpha"; openProjects.add("alpha"); onEvent({ type: "tasks", items: [] }); toggleCC(true); ccSelected = null; __sent.length = 0');
  await sleep(80);
  await js('$("deck-input").focus()');
  await typeText('/plan add a cache');
  await press('Enter');
  await typeText('/help');
  await press('Enter');  // picks from the palette it opens: nothing is started
  await sleep(20);
  const palette = await js('!$("cc-slash").hidden && $("deck-input").value === "/"');
  await js('$("deck-input").value = ""; $("cc-slash").hidden = true');
  await typeText('/review-pr 3');
  await js('$("cc-slash").hidden = true; $("deck-composer").requestSubmit()');
  const r = await js('__sent.filter((m) => m.type === "task_new").map((m) => `${m.mode || "-"}:${m.prompt}`)');
  assert(r.join('|') === 'plan:add a cache|-:/review-pr 3', r.join('|'));
  assert(palette, '/help did not open the command palette');
});

test('/rename with nothing after it names the session in place', async () => {
  await open(1, '$("deck-input").focus()');
  await typeText('/rename');
  await js('$("cc-slash").hidden = true; $("deck-composer").requestSubmit()');
  assert(await js('$("jc-title").isContentEditable'), 'the title is not being renamed');
  assert(!(await sent()).includes('task_rename'), 'renamed to nothing');
});

// ── what JARVIS learns (suggestions, interruptions, your words), documents and videos ──

const clickText = (root, label) => js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(root)} + ' button')].find((x) => x.textContent === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
const sentOf = (type) => js(`__sent.filter((m) => m.type === ${JSON.stringify(type)})`);

test('A suggestion card tells the hub once which button was pressed, and goes', async () => {
  const card = (key) => `onEvent({ type: 'suggestion', key: '${key}', category: 'habit', title: 'Your usual', text: 'The weather, as most weekdays around now?', request: 'what’s the weather?' })`;
  await js(card('habit:a'));
  assert(await clickText('[data-suggestion="habit:a"]', 'Do it'), 'no Do it');
  await js(card('habit:b'));
  assert(await clickText('[data-suggestion="habit:b"]', 'Don’t suggest this'), 'no Don’t suggest this');
  const r = await sentOf('suggestion_reaction');
  assert(JSON.stringify(r.map((m) => [m.key, m.action])) === JSON.stringify([['habit:a', 'accepted'], ['habit:b', 'never']]), JSON.stringify(r));
  assert(await js('!document.querySelector("[data-suggestion]")'), 'a suggestion card stayed');
});

test('An interruption card has Open; Open and Dismiss teach, other heads-ups have no Open', async () => {
  await js('onEvent({ type: "alert", key: "interrupt:message:5", alert_kind: "message", title: "Bob Chen", text: "Call me asap" })');
  assert(await clickText('#cards .card.plain', 'Dismiss'), 'no Dismiss');
  await js('onEvent({ type: "alert", key: "interrupt:mail:9", alert_kind: "mail", title: "Ann", text: "Contract" })');
  assert(await clickText('#cards .card.plain', 'Open'), 'no Open');
  await js('onEvent({ type: "alert", key: "rain:1", alert_kind: "rain", title: "Rain", text: "Rain at 5" })');
  const r = await js('({ sent: __sent.filter((m) => m.type === "alert_reaction").map((m) => m.key + " " + m.action), opens: [...$("cards").querySelectorAll("button")].filter((b) => b.textContent === "Open").length, cards: $("cards").querySelectorAll(".card.plain").length })');
  assert(JSON.stringify(r.sent) === JSON.stringify(['interrupt:message:5 dismissed', 'interrupt:mail:9 opened']), JSON.stringify(r));
  assert(r.opens === 0 && r.cards === 1, JSON.stringify(r));
});

test('Settings lists what was learned and your documents, each with its button', async () => {
  await js(`
    onEvent({ type: 'hearing', corrections: [{ heard: 'akin', meant: 'Okin', count: 1, at: '' }], words: [{ word: 'Okin', count: 3, why: 'corrected' }] });
    onEvent({ type: 'interrupt_learning', items: [{ who: 'Bob Chen', state: 'muted', why: 'I stopped interrupting you for Bob Chen: you dismissed his last 5.' }] });
    onEvent({ type: 'documents', items: [{ path: '/Users/x/Documents/JARVIS/Memo.docx', title: 'Memo', gist: 'the Q3 plan', format: 'docx', action: 'wrote', at: '' }] });
    onEvent({ type: 'prefs', look: 'orb', language: 'en', models: [], personas: [], humor: 50, learn_speech: true, learn_interruptions: false, suggestions: true, documents_folder: '~/Work' });
    toggleSettings(true); __sent.length = 0; true`);
  const shown = await js('({ hearing: $("hearing-list").textContent, learned: $("interrupt-learning-list").textContent, docs: $("document-list").textContent, speech: $("sw-learn-speech").getAttribute("aria-checked"), interrupts: $("sw-learn-interrupts").getAttribute("aria-checked"), folder: $("documents-folder").value })');
  assert(shown.hearing.includes('akin → Okin') && shown.hearing.includes('Words I listen for: Okin'), JSON.stringify(shown));
  assert(shown.learned.includes('Bob Chen') && shown.docs.includes('Memo — the Q3 plan'), JSON.stringify(shown));
  assert(shown.speech === 'true' && shown.interrupts === 'false' && shown.folder === '~/Work', JSON.stringify(shown));
  await clickText('#hearing-list', 'Forget');
  await clickText('#interrupt-learning-list', 'Undo');
  await clickText('#document-list', 'Open');
  await js('$("sw-learn-interrupts").click(); true');
  const r = await js('__sent.map((m) => [m.type, m.what || m.who || m.path || JSON.stringify(m.changes || "")])');
  assert(JSON.stringify(r) === JSON.stringify([['hearing_forget', 'akin'], ['interrupt_learning_reset', 'Bob Chen'], ['document_open', '/Users/x/Documents/JARVIS/Memo.docx'], ['set_prefs', '{"learn_interruptions":true}']]), JSON.stringify(r));
  await js('onEvent({ type: "hearing", corrections: [], words: [] }); true');
  assert(await js('$("hearing-list").textContent') === 'Nothing learned yet.', 'empty list not said');
});

test('A video card shows progress and Cancel, then the write-up as text, never as HTML', async () => {
  await js('__sent.length = 0; onEvent({ type: "video", job: { id: 3, title: "Q3 review", kind: "file", state: "transcribing", progress: 0.42 } })');
  assert(await js('$("cards").textContent.includes("Transcribing… 42%")'), 'no progress');
  await clickText('#cards .card.plain', 'Cancel');
  await js(`onEvent({ type: 'video_summary', id: 3, title: 'Q3 review', path: '/Users/x/Documents/Jarvis/Videos/Q3 review.md',
    markdown: '## Summary\\nRevenue grew <img src=x onerror="window.__pwned=1">.\\n## Key points\\n- Budget due Friday\\n- [ ] Sarah sends it' })`);
  await frames(2);
  const r = await js('({ imgs: $("cards").querySelectorAll(".video-summary img").length, pwned: !!window.__pwned, text: $("cards").querySelector(".video-summary").textContent, cards: $("cards").querySelectorAll(".card.plain").length })');
  assert(r.imgs === 0 && !r.pwned && r.text.includes('<img src=x') && r.text.includes('• Sarah sends it'), JSON.stringify(r));
  assert(r.cards === 1, 'the write-up should replace the progress card');
  await js('onEvent({ type: "video", job: { id: 3, title: "Q3 review", kind: "file", state: "ready", progress: 1 } })');
  assert(await js('$("cards").querySelector(".video-summary") !== null'), 'progress replaced the write-up');
  await clickText('#cards .card.plain', 'Open');
  const s = await js('__sent.map((m) => m.type + " " + m.id)');
  assert(JSON.stringify(s) === JSON.stringify(['video_cancel 3', 'video_open 3']), JSON.stringify(s));
});

test('A file dropped on the window never replaces it; a video dropped is sent to be summarized', async () => {
  const drop = (name, type) => js(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
    const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
    $('orb').dispatchEvent(ev);
    return ev.defaultPrevented;
  })()`);
  await js('window.jarvisApp = { pathFor: (f) => "/Users/x/Movies/" + f.name }; __sent.length = 0; true');
  assert(await drop('notes.pdf', 'application/pdf'), 'a PDF drop would open the file in the window');
  assert(await drop('talk.mov', 'video/quicktime'), 'the video drop was not taken');
  const r = await js('__sent');
  assert(JSON.stringify(r) === JSON.stringify([{ type: 'video_summarize', path: '/Users/x/Movies/talk.mov' }]), JSON.stringify(r));
});

// ── feature modules (web/features/*.js): loaded into the page as features.js would ──

const loadFeature = (name) => js(`${fs.readFileSync(path.join(WEB, 'features', name), 'utf8')}\n;true`);
// An event as the socket delivers it: to the window, then to the feature modules.
const deliver = (ev) => js(`(() => { const ev = ${JSON.stringify(ev)}; onEvent(ev); featureEvent(ev); return true; })()`);

test('Jarvis Code tells the backend which session the owner looked at, once in a while', async () => {
  await loadFeature('code-voice.js');
  await open(3);
  await js('Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.hasFocus = () => true; true');
  await deliver({ type: 'task_transcript', id: 3, entries: [] });
  await deliver({ type: 'task_finished', id: 3, task_kind: 'code', status: 'done', result: 'ok', files: [] });  // within a moment: once
  await deliver({ type: 'task_transcript', id: 4, entries: [] });  // not the one on screen
  const seen = await js('__sent.filter((m) => m.type === "code_voice_seen").map((m) => m.id)');
  assert(JSON.stringify(seen) === '[3]', JSON.stringify(seen));
  await js('toggleCC(false); __sent.length = 0; true');
  await deliver({ type: 'task_transcript', id: 3, entries: [] });
  assert(!(await sentOf('code_voice_seen')).length, 'reported while Jarvis Code was closed');
});

test('“Read lines 3 to 4 of hub.py” opens it in the Files viewer with those lines marked', async () => {
  await loadFeature('code-voice.js');
  await open(3);
  await deliver({ type: 'code_voice_file', id: 3, directory: '/Users/x/alpha', path: 'src/hub.py', start: 3, end: 4 });
  const asked = await sentOf('file_read');
  assert(JSON.stringify(asked) === JSON.stringify([{ type: 'file_read', directory: '/Users/x/alpha', path: 'src/hub.py' }]), JSON.stringify(asked));
  assert(await js('currentPane === "files"'), 'the Files pane is not open');
  await deliver({ type: 'file_content', directory: '/Users/x/alpha', path: 'src/hub.py', text: 'a\nb\nc\nd\ne', truncated: false });
  const marked = await js('[...document.querySelectorAll("#jc-pane-body .jc-viewer .ln")].map((l) => l.classList.contains("cv-mark"))');
  assert(JSON.stringify(marked) === '[false,false,true,true,false]', JSON.stringify(marked));
});

test('The look-at-this key names the Jarvis Code session in front, and only then', async () => {
  await open(3);
  assert(JSON.stringify(await js('whatsThisMessage()')) === '{"type":"whats_this","session":3}', 'session 3 is in front');
  await js('toggleCC(false); true');
  assert(JSON.stringify(await js('whatsThisMessage()')) === '{"type":"whats_this","session":0}', 'Jarvis Code is closed');
});

test('With hand control on a page, the window says so and says what the hand points at', async () => {
  await loadFeature('code-voice.js');
  await js(`window.jarvisApp = { browser: { command: async (c) => (c.action === 'pointed'
    ? { ok: true, tag: 'button', text: 'Buy now', selector: '#buy', box: { x: 10, y: 20, width: 80, height: 30 }, url: 'http://localhost:5173/', title: 'Shop', png: 'iVBOR' }
    : { ok: false }) } }; true`);
  await js('handsOn = true; browserOpenNow = true; $("hand-panel").hidden = false; true');
  await frames(2);
  const hand = await sentOf('code_voice_hand');
  assert(JSON.stringify(hand.map((m) => m.pointing)) === '[true]', JSON.stringify(hand));
  await deliver({ type: 'code_voice_point', id: 'p1' });
  await frames(2);
  const [answer] = await sentOf('code_voice_pointed');
  assert(answer && answer.id === 'p1' && answer.ref.kind === 'page' && answer.ref.selector === '#buy', JSON.stringify(answer));
  assert(answer.ref.image.media_type === 'image/png' && answer.ref.image.data === 'iVBOR', JSON.stringify(answer.ref.image));
  await js('handsOn = false; $("hand-panel").hidden = true; __sent.length = 0; true');
  await frames(2);
  await deliver({ type: 'code_voice_point', id: 'p2' });
  await frames(2);
  const off = await sentOf('code_voice_pointed');
  assert(off.length === 1 && off[0].ref === null, JSON.stringify(off));  // hands off: nothing pointed at
  assert(JSON.stringify((await sentOf('code_voice_hand')).map((m) => m.pointing)) === '[false]', 'the hand going off was not said');
});

test('“@” at the start of a Jarvis Code message offers the other sessions to send it to', async () => {
  await loadFeature('code-voice.js');
  await open(3);
  await js(`onEvent({ type: 'tasks', items: [__task(3), __task(4, { title: 'Write the docs' })] }); $("deck-input").focus(); true`);
  await type('@wri');
  const offered = await js('[...$("cc-slash").querySelectorAll("button")].map((b) => b.textContent)');
  assert(offered.length >= 1 && offered[0] === '@session-4Write the docs · alpha', JSON.stringify(offered));
  await key('\t');  // Tab picks it
  assert(await js('$("deck-input").value') === '@session-4 ', await js('$("deck-input").value'));
  await js('$("deck-input").value = "fix @wri"; $("deck-input").dispatchEvent(new Event("input")); true');
  const midway = await js('[...$("cc-slash").querySelectorAll("button")].map((b) => b.textContent)');
  assert(!midway.some((t) => t.startsWith('@session')), JSON.stringify(midway));  // only at the start
});

// ── the Mac app's shell (web/features/shell.js), with a stand-in for the app's side ──

// What the page queued runs before this returns (its zero-delay timers, promise callbacks
// and observers): two timer hops in the page itself, however busy the machine is.
const settle = () => js('new Promise((r) => setTimeout(() => setTimeout(r, 0), 0))');

// Loaded as features.js would load it, after app.js, with window.jarvisApp.feature recording
// what goes to the app and keeping the handler for what the app sends.
async function loadShell(hello = { dev: false, notify: true, recovered: false }, answers = '') {
  const source = fs.readFileSync(path.join(WEB, 'features', 'shell.js'), 'utf8');
  const style = fs.readFileSync(path.join(WEB, 'features', 'shell.css'), 'utf8');
  await js(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(style)}; document.head.append(s); })(); true`);
  await js(`
    window.__app = { sent: [], on: {}, invoked: [], hello: ${JSON.stringify(hello)} };
    ${answers}
    window.jarvisApp = { feature: {
      invoke: (channel, ...args) => { __app.invoked.push([channel, ...args]); return Promise.resolve(__app.answer ? __app.answer(channel, ...args) : channel === 'feature:shell:hello' ? __app.hello : null); },
      send: (channel, msg) => __app.sent.push([channel, msg]),
      on: (channel, fn) => { __app.on[channel] = fn; },
    } };
    window.__event = (ev) => { onEvent(ev); featureEvent(ev); };
    true`);
  await js(`${source}\ntrue`);
  await js(`__event({ type: 'hello', hub_id: 'hub-a', state: 'idle', muted: true, status: {}, activity: [], tasks: [],
    prefs: { look: 'orb', language: 'en', models: [], personas: [], humor: 50, hands_free: false, features: {} }, brain: {}, approvals: [], history: [] }); true`);
  await settle();
}
const reports = () => js('__app.sent.filter(([c]) => c === "feature:shell:state").map(([, m]) => m)');

test('The shell tells the app what JARVIS is doing, and adds This Mac to Settings', async () => {
  await loadShell();
  let r = await reports();
  const first = r[r.length - 1];
  assert(first.state === 'idle' && first.muted === true && first.online === true && first.menuBar === true, JSON.stringify(r));
  assert(first.labels.idle === 'Ready' && first.labels.pausedUntil === '', JSON.stringify(first.labels));
  const before = r.length;
  await js('__event({ type: "state", value: "listening" }); __event({ type: "muted", value: false }); true');
  await settle();
  r = await reports();
  assert(r.length === before + 1 && r[before].state === 'listening' && r[before].muted === false, JSON.stringify(r));
  const soon = Date.now() / 1000 + 3600;
  await js(`__event({ type: 'prefs', language: 'en', hands_free: true, features: { shell_pause_until: ${soon}, shell_menu_bar: false } }); true`);
  await settle();
  r = await reports();
  const last = r[r.length - 1];
  assert(last.handsFree === true && last.menuBar === false && Math.abs(last.pausedUntil - soon * 1000) < 1, JSON.stringify(last));
  assert(/^Heads-ups paused until \d/.test(last.labels.pausedUntil), last.labels.pausedUntil);
  // Settings › This Mac, before the last group (Tools & Accounts…), its switch following the setting.
  const g = await js('({ at: [...$("settings").children].indexOf($("shell-group")), accounts: [...$("settings").children].indexOf($("open-accounts").closest("section")), on: $("sw-shell-menubar").getAttribute("aria-checked") })');
  assert(g.at > 0 && g.at === g.accounts - 1 && g.on === 'false', JSON.stringify(g));
  await js('__sent.length = 0; $("sw-shell-menubar").click(); true');
  const s = await js('__sent');
  assert(JSON.stringify(s) === JSON.stringify([{ type: 'feature_prefs', changes: { shell_menu_bar: true } }]), JSON.stringify(s));
  // The connection drops: offline for the menu bar.
  await js('$("offline").hidden = false; true');
  await settle();
  r = await reports();
  assert(r[r.length - 1].online === false, 'still online after the connection dropped');
});

test('The shell carries out the menu bar’s commands over the window’s connection', async () => {
  await loadShell();
  await js('__sent.length = 0; true');
  for (const action of ['mute', 'unmute', 'hands-free', 'pause', 'resume']) await js(`__app.on['feature:shell:command']({ action: '${action}' }); true`);
  const s = await js('__sent');
  assert(JSON.stringify(s) === JSON.stringify([
    { type: 'mute', value: true }, { type: 'mute', value: false }, { type: 'set_prefs', changes: { hands_free: true } },
    { type: 'shell_pause', minutes: 60 }, { type: 'shell_pause', minutes: 0 },
  ]), JSON.stringify(s));
  await js('__app.on["feature:shell:command"]({ action: "open", panel: "settings" }); true');
  assert(await js('!$("settings").hidden'), 'Settings did not open');
  await js('__app.on["feature:shell:command"]({ action: "open", panel: "code" }); true');
  assert(await js('!$("cc").hidden'), 'Jarvis Code did not open');
  await js('__app.on["feature:shell:command"]({ action: "open", panel: "brain" }); true');
  assert(await js('galaxyMode') === 'open', 'the second brain did not open');
  await js('__app.on["feature:shell:command"]({ action: "nonsense" }); __app.on["feature:shell:command"](null); true');
});

test('A heads-up card carries its key; away from the window a feature can raise its notification', async () => {
  await js(`window.__notes = []; window.Notification = function (title, o) { __notes.push([title, o.body]); };
    document.hasFocus = () => false; true`);
  await js('onEvent({ type: "alert", key: "rain:1", alert_kind: "rain", title: "Rain", text: "Rain in an hour." }); true');
  let r = await js('({ key: $("cards").lastElementChild.dataset.alert, notes: __notes })');
  assert(r.key === 'rain:1' && JSON.stringify(r.notes) === JSON.stringify([['Rain', 'Rain in an hour.']]), JSON.stringify(r));
  await js(`window.__taken = []; window.addEventListener('jarvis-notify', (e) => { __taken.push(e.detail.key); e.preventDefault(); }); true`);
  await js('onEvent({ type: "alert", key: "interrupt:m1", alert_kind: "message", title: "Ann", text: "Call me" }); true');
  r = await js('({ key: $("cards").lastElementChild.dataset.alert, notes: __notes.length, taken: __taken })');
  assert(r.key === 'interrupt:m1' && r.notes === 1 && JSON.stringify(r.taken) === '["interrupt:m1"]', JSON.stringify(r));
  await js('document.hasFocus = () => true; onEvent({ type: "alert", key: "rain:2", alert_kind: "rain", title: "Rain", text: "Now." }); true');
  assert(await js('__taken.length === 1 && __notes.length === 1'), 'a heads-up with the window in front went to a notification');
});

test('The shell tells the app which cards wait, and answers one only as its notification asked', async () => {
  await loadShell();
  await js(`__app.sent.length = 0;
    __event({ type: 'approval', id: 'a1', question: 'Send it?', detail: 'to Ann', choices: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Not now' }], rid: '' });
    __event({ type: 'approval', id: 'p1', question: 'Buy it?', detail: '', choices: [{ id: 'allow', label: 'Confirm purchase' }, { id: 'deny', label: 'Cancel' }], ask_kind: 'purchase', task_id: 3 });
    __event({ type: 'approval_resolved', id: 'a1' });
    true`);
  const sent = await js('__app.sent');
  assert(JSON.stringify(sent.map(([c, m]) => [c, m.id, m.askKind, m.task])) === JSON.stringify([
    ['feature:shell:approval', 'a1', '', null], ['feature:shell:approval', 'p1', 'purchase', 3], ['feature:shell:approval-done', 'a1', undefined, undefined],
  ]), JSON.stringify(sent));
  assert(sent[0][1].choices[0].label === 'Allow' && sent[0][1].detail === 'to Ann', JSON.stringify(sent[0][1]));
  await js(`__sent.length = 0;
    __app.on['feature:shell:command']({ action: 'approve', id: 'p1', choice: 'allow' });
    __app.on['feature:shell:command']({ action: 'approve', id: 'a1', choice: 'allow' });
    __app.on['feature:shell:command']({ action: 'approve', id: 'p1', choice: 'always' });
    true`);
  const s = await js('__sent');
  assert(JSON.stringify(s) === JSON.stringify([{ type: 'approve', id: 'p1', choice: 'allow' }]), `only a waiting card, with allow or deny: ${JSON.stringify(s)}`);
});

test('The shell raises heads-ups through the app, and opens JARVIS on the card a notification names', async () => {
  await loadShell();
  await js(`window.__notes = []; window.Notification = function (title) { __notes.push(title); }; document.hasFocus = () => false;
    __app.sent.length = 0;
    __event({ type: 'alert', key: 'rain:1', alert_kind: 'rain', title: 'Rain', text: 'Rain in an hour.' });
    true`);
  const r = await js('({ notes: __notes, sent: __app.sent.filter(([c]) => c === "feature:shell:heads-up").map(([, m]) => m) })');
  assert(r.notes.length === 0 && JSON.stringify(r.sent) === JSON.stringify([{ key: 'rain:1', kind: 'rain', title: 'Rain', text: 'Rain in an hour.' }]), JSON.stringify(r));
  const reveal = (cmd) => js(`__app.on['feature:shell:command'](${JSON.stringify({ action: 'reveal', ...cmd })}); true`);
  await reveal({ what: 'alert', key: 'rain:1', kind: 'rain', title: 'Rain', text: 'Rain in an hour.' });
  assert(await js('$("cards").querySelector("[data-alert=\'rain:1\']").classList.contains("shell-flash")'), 'the card was not brought forward');
  // Its card timed out: it comes back for another minute.
  await js('$("cards").replaceChildren(); true');
  await reveal({ what: 'alert', key: 'leave:1', kind: 'leave', title: 'Time to go', text: 'Leave now.' });
  const back = await js('(() => { const c = $("cards").querySelector("[data-alert=\'leave:1\']"); return c && [c.querySelector(".card-kicker").textContent, c.querySelector(".card-title").textContent]; })()');
  assert(JSON.stringify(back) === JSON.stringify(['Time to go', 'Time to go']), JSON.stringify(back));
  // Jarvis Code's: its session.
  await js('onEvent({ type: "tasks", items: [__task(4)] }); true');
  await reveal({ what: 'alert', key: 'code-ok:4:123', kind: 'task', title: 'Jarvis Code needs you', text: '' });
  assert(await js('!$("cc").hidden && ccSelected === 4'), 'Jarvis Code did not open on the session');
  await js('toggleCC(false); ccSelected = null; true');
  await reveal({ what: 'approval', id: 'x', task: 4 });
  assert(await js('!$("cc").hidden && ccSelected === 4'), 'the approval’s session did not open');
});

test('After the app reloads a crashed page, the window says so once', async () => {
  await loadShell({ dev: false, notify: true, recovered: true });
  const r = await js('[...$("cards").querySelectorAll(".card.plain .card-text")].map((n) => n.textContent)');
  assert(JSON.stringify(r) === JSON.stringify(['The window stopped unexpectedly and was reloaded.']), JSON.stringify(r));
  await js('$("cards").replaceChildren(); true');
  await loadShell();
  assert(await js('$("cards").querySelectorAll(".card.plain").length') === 0, 'a notice without a crash');
});

const SHORTCUTS = { live: true, ask: { accelerator: 'Alt+Space', label: '⌥ Space', error: '' }, whatsThis: { accelerator: 'Alt+Shift+Space', label: '⌥⇧ Space', error: '' } };
const keyEvent = async (code, key, vk, modifiers = 0) => {
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
};

test('Settings records a new shortcut; its keys never reach the rest of the window', async () => {
  await loadShell({ dev: false, notify: true, recovered: false, shortcuts: SHORTCUTS });
  await js(`__app.answer = (channel, msg) => {
      if (channel !== 'feature:shell:shortcut') return null;
      if (msg.accelerator === 'Space') return { ok: false, error: 'modifier', label: 'Space' };
      if (msg.accelerator === 'Command+Alt+K') return { ok: false, error: 'taken', label: '⌥⌘K' };
      return { ok: true, accelerator: msg.accelerator, label: '⌥⌘J' };
    };
    toggleSettings(true); __sent.length = 0; __app.sent.length = 0; __app.invoked.length = 0; true`);
  let r = await js('({ cap: $("shell-key-ask").textContent, hint: $("hint").querySelector("kbd").textContent })');
  assert(r.cap === '⌥ Space' && r.hint === '⌥ Space', JSON.stringify(r));
  const recording = () => js('__app.sent.filter(([c]) => c === "feature:shell:recording").map(([, on]) => on)');
  // Esc: nothing changes.
  await js('$("shell-rec-ask").click(); true');
  assert(await js('$("shell-key-ask").classList.contains("recording") && $("shell-rec-ask").textContent === "Cancel"'), 'not recording');
  await keyEvent('Escape', 'Escape', 27);
  r = await js('({ cap: $("shell-key-ask").textContent, open: !$("settings").hidden, tried: __app.invoked.filter(([c]) => c === "feature:shell:shortcut").length })');
  assert(r.cap === '⌥ Space' && r.open && r.tried === 0, `Esc: ${JSON.stringify(r)}`);
  assert(JSON.stringify(await recording()) === '[true,false]', JSON.stringify(await recording()));
  // Space alone: refused, and never the microphone.
  await js('$("shell-rec-ask").click(); true');
  await keyEvent('Space', ' ', 32);
  r = await js('({ note: $("shell-key-note").textContent, sent: __sent.map((m) => m.type) })');
  assert(r.note === 'Use ⌃ or ⌥, or ⌘ together with ⇧, ⌃ or ⌥.' && !r.sent.includes('listen'), JSON.stringify(r));
  // Taken by another app: said, and the old one stays on show.
  await js('$("shell-rec-ask").click(); true');
  await keyEvent('KeyK', 'k', 75, 1 | 4); // ⌥⌘K
  r = await js('({ note: $("shell-key-note").textContent, cap: $("shell-key-ask").textContent })');
  assert(r.note === '⌥⌘K is taken by another app. Pick another.' && r.cap === '⌥ Space', JSON.stringify(r));
  // ⌥⌘J: kept in the settings, and the hint and the idle line say it.
  await js('$("shell-rec-ask").click(); true');
  await keyEvent('KeyJ', 'j', 74, 1 | 4);
  await settle();
  r = await js(`({ sent: __sent.filter((m) => m.type === 'feature_prefs'), cap: $('shell-key-ask').textContent, hint: $('hint').querySelector('kbd').textContent,
    line: $('state-line').textContent, note: $('shell-key-note').hidden })`);
  assert(JSON.stringify(r.sent) === JSON.stringify([{ type: 'feature_prefs', changes: { shell_shortcut_ask: 'Command+Alt+J' } }]), JSON.stringify(r.sent));
  assert(r.cap === '⌥⌘J' && r.hint === '⌥⌘J' && r.line === 'Tap the orb or press ⌥⌘J' && r.note, JSON.stringify(r));
  const tried = await js('__app.invoked.filter(([c]) => c === "feature:shell:shortcut").map(([, m]) => m.accelerator)');
  assert(JSON.stringify(tried) === JSON.stringify(['Space', 'Command+Alt+K', 'Command+Alt+J']), JSON.stringify(tried));
});

test('A shortcut another app holds is said in Settings; Change… waits for the connection', async () => {
  await loadShell({ dev: false, notify: true, recovered: false, shortcuts: { ...SHORTCUTS, whatsThis: { accelerator: 'Alt+Shift+Space', label: '⌥⇧ Space', error: 'taken' } } });
  const r = await js('({ note: $("shell-key-note").textContent, warn: $("shell-key-note").classList.contains("warn-line"), hidden: $("shell-key-note").hidden })');
  assert(r.note === '⌥⇧ Space is taken by another app. Pick another.' && r.warn && !r.hidden, JSON.stringify(r));
  await js('$("offline").hidden = false; true');
  await settle();
  assert(await js('$("shell-rec-ask").disabled && $("shell-rec-whatsThis").disabled'), 'Change… works offline');
});

test('A jarvis:// link fills in the request box and sends nothing; Return sends it', async () => {
  await loadShell();
  await js('toggleSettings(true); toggleCC(true); __sent.length = 0; true');
  await sleep(80);
  await js('__app.on["feature:shell:command"]({ action: "prefill", text: "Summarize the Q3 memo" }); true');
  let r = await js(`({ value: $('ask-input').value, focused: document.activeElement === $('ask-input'), note: !$('shell-link-note').hidden,
    noteText: $('shell-link-note').textContent, settings: $('settings').hidden, cc: $('cc').hidden, sent: __sent.map((m) => m.type) })`);
  assert(r.value === 'Summarize the Q3 memo' && r.focused && r.note && r.settings && r.cc, JSON.stringify(r));
  assert(r.noteText === 'From a link: read it, then press Return to send it.' && !r.sent.includes('ask'), JSON.stringify(r));
  await sleep(300);
  assert(!(await js('__sent.some((m) => m.type === "ask")')), 'a link’s request was sent by itself');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  r = await js('({ asked: __sent.filter((m) => m.type === "ask").map((m) => m.text), note: $("shell-link-note").hidden })');
  assert(JSON.stringify(r.asked) === JSON.stringify(['Summarize the Q3 memo']) && r.note, JSON.stringify(r));
});

test('A jarvis:// link opens a Jarvis Code project, once the list of projects is in', async () => {
  await loadShell();
  await js('__sent.length = 0; __app.on["feature:shell:command"]({ action: "project", name: "beta" }); true');
  await sleep(80);
  assert(await js('!$("cc").hidden && __sent.some((m) => m.type === "claude_projects")'), 'Jarvis Code did not open for the list');
  await js(`__event({ type: 'claude_projects', items: [{ name: 'alpha', branch: 'main' }, { name: 'beta', branch: 'dev' }] }); true`);
  assert(await js('deckProject') === 'beta', `on ${await js('deckProject')}`);
  await js('__app.on["feature:shell:command"]({ action: "project", name: "zeta" }); true');
  await js(`__event({ type: 'claude_projects', items: [{ name: 'alpha', branch: 'main' }, { name: 'beta', branch: 'dev' }] }); true`);
  const r = await js('({ on: deckProject, said: [...$("cards").querySelectorAll(".card-text")].map((n) => n.textContent) })');
  assert(r.on === 'beta' && r.said.includes('No Jarvis Code project named “zeta”.'), JSON.stringify(r));
});

test('Settings adds “Ask JARVIS” to the Services menu and takes it away; never over one of the owner’s', async () => {
  await loadShell(undefined, `
    window.__service = { available: true, installed: false, taken: false, error: '' };
    __app.answer = (channel, req) => {
      if (channel === 'feature:shell:hello') return __app.hello;
      if (channel !== 'feature:shell:service') return null;
      if (req.action === 'add') __service.installed = true;
      if (req.action === 'remove') __service.installed = false;
      return { ...__service };
    };`);
  await settle();
  const row = () => js('({ hidden: $("shell-service-row").hidden, label: $("shell-service").textContent, disabled: $("shell-service").disabled, note: $("shell-service-note").hidden ? "" : $("shell-service-note").textContent })');
  let r = await row();
  assert(!r.hidden && r.label === 'Add' && !r.note, JSON.stringify(r));
  await js('$("shell-service").click(); true');
  await settle();
  r = await row();
  assert(r.label === 'Remove', JSON.stringify(r));
  await js('$("shell-service").click(); true');
  await settle();
  assert((await row()).label === 'Add', 'not removed');
  const calls = await js('__app.invoked.filter(([c]) => c === "feature:shell:service").map(([, m]) => m.action)');
  assert(JSON.stringify(calls) === JSON.stringify(['status', 'add', 'remove']), JSON.stringify(calls));
  // One of the owner's own by that name: said, and the button can't write over it.
  await js(`__service = { available: true, installed: false, taken: true, error: 'taken' }; $('shell-service').click(); true`);
  await settle();
  r = await row();
  assert(r.disabled && /already a Quick Action named “Ask JARVIS”/.test(r.note), JSON.stringify(r));
  // The test window, or a build from source: no row at all.
  await js(`__service = { available: false, installed: false, taken: false, error: '' }; $('shell-service').disabled = false; $('shell-service').click(); true`);
  await settle();
  r = await row();
  assert(r.hidden && !r.note, JSON.stringify(r));
  assert(await js('getComputedStyle($("shell-service-row")).display') === 'none', 'hidden, but still on show');
});

test('Open at login: offered by the installed app, switched there, and macOS’s wait for an OK said', async () => {
  await loadShell(undefined, `
    window.__login = { available: true, on: false, status: 'not-registered', error: '' };
    window.__approval = false; // macOS holds the login item until the owner approves it
    __app.answer = (channel, req) => {
      if (channel === 'feature:shell:hello') return __app.hello;
      if (channel !== 'feature:shell:login') return null;
      if (typeof req.on === 'boolean') {
        __login = __approval && req.on ? { ...__login, on: false, status: 'requires-approval' }
          : { ...__login, on: req.on, status: req.on ? 'enabled' : 'not-registered' };
      }
      return { ...__login };
    };`);
  await settle();
  const row = () => js('({ hidden: $("sw-shell-login").closest(".row").hidden, on: $("sw-shell-login").getAttribute("aria-checked"), note: $("shell-login-note").hidden ? "" : $("shell-login-note").textContent })');
  let r = await row();
  assert(!r.hidden && r.on === 'false' && !r.note, JSON.stringify(r));
  await js('$("sw-shell-login").click(); true');
  await settle();
  assert((await row()).on === 'true', 'not switched on');
  await js('$("sw-shell-login").click(); true');
  await settle();
  assert((await row()).on === 'false', 'not switched off');
  await js('__approval = true; $("sw-shell-login").click(); true');
  await settle();
  r = await row();
  assert(r.on === 'false' && r.note === 'macOS is waiting for your OK: System Settings › General › Login Items.', JSON.stringify(r));
  const asked = await js('__app.invoked.filter(([c]) => c === "feature:shell:login").map(([, m]) => m)');
  assert(JSON.stringify(asked) === JSON.stringify([{}, { on: true }, { on: false }, { on: true }]), JSON.stringify(asked));
  // History from the app's menu where there's no built-in browser (a plain page): nothing, and no error.
  await js('__app.on["feature:shell:command"]({ action: "library", kind: "history" }); __app.on["feature:shell:command"]({ action: "library", kind: "passwords" }); true');
});

test('Open at login isn’t offered where it can’t work (the test window, a build from source)', async () => {
  await loadShell(undefined, `__app.answer = (channel) => channel === 'feature:shell:hello' ? __app.hello
    : channel === 'feature:shell:login' ? { available: false, on: false, status: '', error: '' } : null;`);
  await settle();
  assert(await js('$("sw-shell-login").closest(".row").hidden && $("shell-login-note").hidden'), 'the row shows where it can’t work');
  assert(await js('getComputedStyle($("sw-shell-login").closest(".row")).display') === 'none', 'hidden, but still on show');
});

test('Scheduled wake: asked for as Settings opens, set and removed only by the buttons', async () => {
  await loadShell();
  await js('__sent.length = 0; toggleSettings(true); true');
  await settle();
  const wakes = () => js('__sent.filter((m) => m.type === "shell_wake").map((m) => m.action)');
  assert(JSON.stringify(await wakes()) === '["status"]', JSON.stringify(await wakes()));
  const show = (ev) => js(`__event(${JSON.stringify({ type: 'shell_wake', time: '07:55', reason: 'briefing', scheduled: null, matches: false, others: [], note: '', busy: false, ...ev })}); true`);
  const rows = () => js(`({ status: $('shell-wake-status').textContent, plan: $('shell-wake-plan').textContent, set: $('shell-wake-set').hidden ? 'hidden' : $('shell-wake-set').disabled ? 'off' : 'on',
    clear: $('shell-wake-clear').hidden ? 'hidden' : $('shell-wake-clear').disabled ? 'off' : 'on', note: $('shell-wake-note').hidden ? '' : $('shell-wake-note').textContent })`);
  await show({});
  let r = await rows();
  assert(r.status === 'This Mac doesn’t wake on a schedule.' && /^Every day at 7:55\sAM, 5 minutes before your briefing\. macOS asks for your password\.$/u.test(r.plan), JSON.stringify(r));
  assert(r.set === 'on' && r.clear === 'hidden' && !r.note, JSON.stringify(r));
  await js('$("shell-wake-set").click(); true');
  r = await rows();
  assert(r.set === 'off' && r.note === 'Waiting for your password in macOS’s window…', `while macOS asks: ${JSON.stringify(r)}`);
  await show({ scheduled: { entry: 'wakepoweron at 7:55AM every day', minutes: 475, days: 'every day' }, matches: true, others: ['shutdown at 11:00PM weekdays only'] });
  r = await rows();
  assert(/^This Mac wakes every day at 7:55\sAM\.$/u.test(r.status) && r.set === 'hidden' && r.clear === 'on', JSON.stringify(r));
  assert(r.note === 'Remove also clears: shutdown at 11:00PM weekdays only.', JSON.stringify(r));
  await js('$("shell-wake-clear").click(); true');
  assert(JSON.stringify(await wakes()) === '["status","set","clear"]', JSON.stringify(await wakes()));
  // The wake-up call is earlier; pmset has something set by hand; a failure is said.
  await show({ time: '06:25', reason: 'wake_call', scheduled: { entry: 'wakepoweron at 9:00AM weekdays only', minutes: 540, days: 'weekdays only' }, note: 'failed' });
  r = await rows();
  assert(r.status === 'This Mac wakes: wakepoweron at 9:00AM weekdays only.' && /before your wake-up call/.test(r.plan), JSON.stringify(r));
  assert(r.set === 'on' && r.clear === 'on' && r.note === 'That didn’t work. Try again.', JSON.stringify(r));
  // The briefing moved while Settings is open: asked again.
  await js(`__event({ type: 'prefs', language: 'en', briefing_enabled: true, briefing_time: '09:00', wake_call: false, wake_call_time: '07:00', features: {} }); true`);
  assert(JSON.stringify(await wakes()) === '["status","set","clear","status"]', JSON.stringify(await wakes()));
});

// ── the MCP servers pane ──

test('The MCP pane says why it lists nothing: no session, not running yet, checking, or none', async () => {
  const body = () => js('$("jc-pane-body").textContent');
  const asked = () => js('__sent.filter((m) => m.type === "task_mcp").map((m) => m.id)');
  await js('deckProjects = [{ name: "alpha", branch: "main" }]; deckProject = "alpha"; onEvent({ type: "tasks", items: [] }); toggleCC(true); ccSelected = null; openPane("mcp"); __sent.length = 0; true');
  assert(await body() === 'Open a session to see its MCP servers.', await body());
  await open(1, 'onEvent({ type: "tasks", items: [__task(1, { status: "closed", busy: false })] }); openPane("mcp")');
  assert(await body() === 'Checking MCP servers…', await body());
  assert(JSON.stringify(await asked()) === '[1]', JSON.stringify(await asked()));
  await js('onEvent({ type: "task_mcp", id: 1, servers: [], connected: false })');
  assert(await body() === 'MCP servers show while the session is running.', await body());
  // It starts running: asked again, once, and the answer is the truth.
  await js('onEvent({ type: "tasks", items: [__task(1, { status: "waiting", busy: false })] })');
  await js('onEvent({ type: "tasks", items: [__task(1, { status: "waiting", busy: false })] })');
  assert(JSON.stringify(await asked()) === '[1,1]', JSON.stringify(await asked()));
  await js('onEvent({ type: "task_mcp", id: 1, servers: [], connected: true })');
  assert(await body() === 'No MCP servers in this project.', await body());
  await js('onEvent({ type: "task_mcp", id: 1, servers: [{ name: "github", status: "connected" }], connected: true })');
  assert((await body()).includes('github'), await body());
});

// ── Health & safety (features/ops.js): its sheet, its confirmations and first-run Setup ──
// The feature's script and style are put in the page as the backend's /features.json
// would; its events arrive through featureEvent(), as a hub's do.

const OPS_JS = fs.readFileSync(path.join(WEB, 'features', 'ops.js'), 'utf8');
const OPS_CSS = fs.readFileSync(path.join(WEB, 'features', 'ops.css'), 'utf8');
async function withOps() {
  await js(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(OPS_CSS)}; document.head.append(s); })(); true`);
  await js(`${OPS_JS}\n;true`);
  await js('__sent.length = 0; true');
}
const opsEvent = (ev) => js(`featureEvent(${JSON.stringify(ev)}); true`);
const opsPress = (key, code, vk) => cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk })
  .then(() => cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk }));
const opsCheck = (id, extra = {}) => ({ id, group: 'jarvis', title: id, state: 'ok', summary: 'Fine', hint: '', meta: '', details: [], fix: null, pane: '', command: '', details_words: false, ...extra });

test('Settings › Health & safety opens its sheet on the tab picked; Escape closes only the sheet', async () => {
  await withOps();
  await js('toggleSettings(true); __sent.length = 0; true');
  const placed = await js('(() => { const g = $("ops-group"); return { there: !!g, beforeAccounts: !!(g && g.nextElementSibling && g.nextElementSibling.querySelector("#open-accounts")) }; })()');
  assert(placed.there && placed.beforeAccounts, JSON.stringify(placed));
  await js('document.querySelector("[data-ops-tab=security]").click(); true');
  const r = await js('({ open: !$("ops-layer").hidden, tab: document.querySelector("#ops-pop [aria-selected=true]").dataset.tab, sent: __sent.map((m) => m.type), focus: document.activeElement && document.activeElement.id })');
  assert(r.open && r.tab === 'security' && r.sent.includes('ops_security') && r.focus === 'ops-close', JSON.stringify(r));
  await opsPress('Escape', 'Escape', 27);
  const after = await js('({ sheet: $("ops-layer").hidden, settings: !$("settings").hidden, sent: __sent.map((m) => m.type) })');
  assert(after.sheet && after.settings, `Escape: ${JSON.stringify(after)}`);
  assert(!after.sent.includes('stop'), 'Escape went on to the window behind');
});

test('A checkup lists what needs you; a fix and System Settings go only after a click, a fix after its confirmation', async () => {
  await withOps();
  await opsEvent({ type: 'ops_doctor', at: new Date().toISOString(), counts: { problem: 2, warn: 1, ok: 1 }, worst: 'problem',
    groups: { permissions: 'Permissions', jarvis: 'Jarvis', data: 'Your data' },
    checks: [
      opsCheck('perm:screen', { group: 'permissions', title: 'Screen Recording', state: 'problem', summary: 'Not allowed yet', hint: 'Turn on J.A.R.V.I.S. in System Settings › Privacy & Security › Screen Recording, then restart Jarvis.', pane: 'screen' }),
      opsCheck('logs', { title: 'Errors in the log', state: 'warn', summary: '2 in the last hour', details: ['2026-09-29 20:00:00,000 ERROR boom <img src=x onerror="window.__pwned=1">'] }),
      opsCheck('file_index', { group: 'data', title: 'File index', state: 'problem', summary: 'Damaged', fix: { id: 'rebuild_file_index', label: 'Rebuild', confirm: 'Rebuild the file index? It starts again from nothing and fills back in, in the background.' } }),
      opsCheck('disk', { group: 'data', title: 'Free disk space', summary: '80 GB free' }),
    ] });
  await js('toggleSettings(true); true');
  const line = await js('$("ops-line-checkup").textContent');
  assert(line === '2 need attention · 1 to look at', line);
  await js('document.querySelector("[data-ops-tab=checkup]").click(); __sent.length = 0; true');
  const shown = await js('({ items: [...document.querySelectorAll("#ops-tab-checkup .ops-item")].map((li) => li.dataset.check + ":" + li.dataset.state), groups: [...document.querySelectorAll("#ops-tab-checkup .ops-group-title")].map((h) => h.textContent), imgs: document.querySelectorAll("#ops-tab-checkup img").length, logData: !!document.querySelector("[data-check=logs] details ul[data-no-i18n]") })');
  assert(JSON.stringify(shown.items) === JSON.stringify(['perm:screen:problem', 'logs:warn', 'file_index:problem', 'disk:ok']), JSON.stringify(shown));
  assert(JSON.stringify(shown.groups) === JSON.stringify(['Permissions', 'Jarvis', 'Your data']) && shown.imgs === 0 && shown.logData, JSON.stringify(shown));
  assert(await clickText('[data-check="perm:screen"]', 'Open System Settings'), 'no Open System Settings');
  assert(await clickText('[data-check="file_index"]', 'Rebuild'), 'no Rebuild');
  let s = await js('__sent');
  assert(JSON.stringify(s) === JSON.stringify([{ type: 'ops_open_settings', pane: 'screen' }]), `a fix went without its confirmation: ${JSON.stringify(s)}`);
  assert(await js('!!document.querySelector("[data-check=file_index] .ops-confirm")'), 'no confirmation');
  await js('document.querySelector("[data-check=file_index] .ops-confirm .btn.primary").click(); true');
  s = await sentOf('ops_fix');
  assert(JSON.stringify(s) === JSON.stringify([{ type: 'ops_fix', fix: 'rebuild_file_index' }]), JSON.stringify(s));
  assert(!(await js('window.__pwned')), 'a log line became markup');
  await opsEvent({ type: 'ops_fixed', fix: 'rebuild_file_index', ok: true, text: 'The file index is rebuilding in the background.' });
  assert((await js('document.querySelector("#ops-tab-checkup .ops-toast").textContent')) === 'The file index is rebuilding in the background.', 'no word of the fix');
});

test('The security review tightens only after its confirmation, and never shows a name as the window’s words', async () => {
  await withOps();
  await opsEvent({ type: 'ops_security', at: new Date().toISOString(), counts: { risk: 1, notice: 1, ok: 0 }, findings: [
    { id: 'connectors', title: 'Connected accounts', state: 'risk', summary: '1 runs everything without asking', note: '', actions: [],
      items: [{ id: 'notion', label: 'Notion', note: 'Everything runs without asking', user: true, actions: [{ id: 'connector_ask', label: 'Ask first', confirm: 'Have Notion ask before anything that changes your data?', item: 'notion' }] }] },
    { id: 'screen', title: 'Screen awareness', state: 'notice', summary: 'On', note: '', items: [], actions: [{ id: 'screen_off', label: 'Turn it off', confirm: 'Turn screen awareness off?', item: '' }] },
  ] });
  await js('toggleSettings(true); true');
  assert((await js('$("ops-line-security").textContent')) === '1 risk · 1 worth knowing', 'the Settings line');
  await js('document.querySelector("[data-ops-tab=security]").click(); __sent.length = 0; true');
  assert(await clickText('[data-finding="connectors"]', 'Ask first'), 'no Ask first');
  assert((await sentOf('ops_tighten')).length === 0, 'tightened before the confirmation');
  const confirm = await js('document.querySelector("[data-finding=connectors] .ops-confirm p").textContent');
  assert(confirm === 'Have Notion ask before anything that changes your data?', confirm);
  await js('document.querySelector("[data-finding=connectors] .ops-confirm .btn.primary").click(); true');
  assert(await clickText('[data-finding="screen"]', 'Turn it off'), 'no Turn it off');
  await opsPress('Escape', 'Escape', 27);  // the confirmation closes, not the sheet
  const r = await js('({ sent: __sent.filter((m) => m.type === "ops_tighten"), sheet: !$("ops-layer").hidden, confirm: !!document.querySelector("[data-finding=screen] .ops-confirm"), name: !!document.querySelector("[data-finding=connectors] .ops-sub-label strong[data-no-i18n]") })');
  assert(JSON.stringify(r.sent) === JSON.stringify([{ type: 'ops_tighten', action: 'connector_ask', item: 'notion' }]), JSON.stringify(r.sent));
  assert(r.sheet && !r.confirm && r.name, JSON.stringify(r));
});

test('A restore shows what changes, then restores and restarts; the waiting restore can be taken back', async () => {
  await withOps();
  const path = '/Users/x/Documents/Jarvis/Backups/Jarvis backup 2026-09-28 at 03.00.00 (daily).zip';
  const backups = { type: 'ops_backups', folder: '/Users/x/Documents/Jarvis/Backups', folder_label: '~/Documents/Jarvis/Backups', chosen: false, daily: true, knowledge: false, error: '', pending: null,
    items: [{ name: 'Jarvis backup 2026-09-28 at 03.00.00 (daily).zip', path, created: '2026-09-28T03:00:00', kind: 'daily', files: 5, size: 20480, knowledge: false }] };
  backups.newest = backups.items[0];
  await opsEvent(backups);
  await js('toggleSettings(true); document.querySelector("[data-ops-tab=backups]").click(); __sent.length = 0; true');
  const row = `.ops-backup[data-path="${path}"]`;
  assert(await clickText(row, 'Verify'), 'no Verify');
  await opsEvent({ type: 'ops_verified', path, ok: true, files: 5, problem: '' });
  assert((await js(`document.querySelector(${JSON.stringify(row)} + " .ops-hint").textContent`)) === 'Verified: all 5 files match their checksums.', 'not verified');
  assert(await clickText(row, 'Restore…'), 'no Restore…');
  await opsEvent({ type: 'ops_restore_preview', path, ok: true, problem: '', backup: backups.items[0], replace: ['memory.json'], add: ['goals.json'], same: ['prefs.json'], keep: ['transactions.json'], left: ['channels.json'] });
  const preview = await js(`document.querySelector(${JSON.stringify(row)} + " .ops-preview").textContent`);
  for (const words of ['Memory', 'Goals', 'Settings', 'Purchase log', 'channels.json', 'safety backup']) assert(preview.includes(words), `preview: ${preview}`);
  assert((await sentOf('ops_restore')).length === 0, 'restored before the confirmation');
  assert(await clickText(row, 'Restore and restart'), 'no Restore and restart');
  await opsEvent({ type: 'ops_restore_staged', ok: true, pending: { backup: backups.items[0].name, created: '2026-09-28T03:00:00', files: 4 }, safety: { name: 'x', kind: 'safety' }, text: '' });
  await opsEvent({ ...backups, pending: { backup: backups.items[0].name, created: '2026-09-28T03:00:00', staged: '', safety: 'x', files: 4 } });
  const r = await js('({ toast: document.querySelector("#ops-tab-backups .ops-toast").textContent, banner: document.querySelector("#ops-tab-backups .ops-banner").textContent, line: $("ops-line-backups").textContent, path: document.querySelector("#ops-tab-backups .ops-path").textContent })');
  assert(r.toast === 'Restart Jarvis to finish: quit it and open it again.', JSON.stringify(r));
  assert(r.banner.includes('A restore is ready') && r.line === 'A restore is waiting for a restart' && r.path === '~/Documents/Jarvis/Backups', JSON.stringify(r));
  assert(await clickText('#ops-tab-backups .ops-banner', 'Cancel the restore'), 'no Cancel the restore');
  await js('document.querySelector("#ops-tab-backups [data-pref=ops_backup_daily]").click(); true');
  const s = await js('__sent.filter((m) => m.type !== "ops_backups")');
  assert(JSON.stringify(s) === JSON.stringify([
    { type: 'ops_backup_verify', path },
    { type: 'ops_restore_preview', path },
    { type: 'ops_restore', path },
    { type: 'ops_restore_cancel' },
    { type: 'feature_prefs', changes: { ops_backup_daily: false } },
  ]), JSON.stringify(s));
});

test('Setup shows by itself on a fresh install, once; its steps set things only when pressed', async () => {
  await withOps();
  await opsEvent({ type: 'ops_state', setup: { state: 'pending', show: true }, backups: null, restored: null, busy: [] });
  assert(await js('!$("ops-setup").hidden'), 'Setup did not show');
  await js('document.querySelector("#ops-setup-body [data-lang=zh]").click(); true');
  await js('$("ops-setup-next").click(); true');  // Voice
  await js('$("ops-mic-test").click(); true');
  await opsEvent({ type: 'ops_mic', state: 'heard', text: 'testing <b>one</b> two' });
  const heard = await js('({ text: document.querySelector("#ops-setup-body .ops-mic q").textContent, data: !!document.querySelector("#ops-setup-body .ops-mic q[data-no-i18n]"), bold: document.querySelectorAll("#ops-setup-body b").length })');
  assert(heard.text === 'testing <b>one</b> two' && heard.data && heard.bold === 0, JSON.stringify(heard));
  await js('$("ops-setup-next").click(); true');  // Permissions
  await opsEvent({ type: 'ops_permissions', at: '', error: '',
    rows: [{ id: 'screen', title: 'Screen Recording', why: 'To look at your screen when you ask what’s on it.', state: 'off', label: 'Not allowed yet', hint: '', apps: [], pane: 'screen' },
      { id: 'microphone', title: 'Microphone', why: 'To hear you.', state: 'granted', label: 'Allowed', hint: '', apps: [], pane: 'microphone' }] });
  const perms = await js('[...document.querySelectorAll("#ops-setup-body .ops-item")].map((li) => li.dataset.perm + ":" + li.dataset.state + ":" + li.querySelectorAll("button").length)');
  assert(JSON.stringify(perms) === JSON.stringify(['screen:problem:1', 'microphone:ok:0']), JSON.stringify(perms));
  assert(await clickText('#ops-setup-body [data-perm="screen"]', 'Open System Settings'), 'no Open System Settings');
  await js('$("ops-setup-next").click(); true');  // Claude
  await opsEvent({ type: 'ops_claude', ...opsCheck('claude', { title: 'Claude sign-in', state: 'problem', summary: 'Not signed in', command: 'claude auth login' }) });
  assert((await js('document.querySelector("#ops-setup-body .ops-command code").textContent')) === 'claude auth login', 'no sign-in command');
  await js('$("ops-setup-next").click(); document.querySelector("#ops-setup-body [data-pref=hands_free]").click(); $("ops-setup-next").click(); true');
  assert((await js('$("ops-setup-next").textContent')) === 'Done', 'not the last step');
  await js('$("ops-setup-next").click(); true');
  const s = await js('__sent.filter((m) => !["ops_permissions"].includes(m.type))');
  assert(JSON.stringify(s) === JSON.stringify([
    { type: 'set_prefs', changes: { language: 'zh' } },
    { type: 'ops_mic_test' },
    { type: 'ops_open_settings', pane: 'screen' },
    { type: 'ops_claude' },
    { type: 'set_prefs', changes: { hands_free: true } },
    { type: 'ops_setup', state: 'done' },
  ]), JSON.stringify(s));
  assert(await js('$("ops-setup").hidden'), 'Setup stayed open');
  await opsEvent({ type: 'ops_state', setup: { state: 'pending', show: true }, backups: null, restored: null, busy: [] });
  assert(await js('$("ops-setup").hidden'), 'Setup came back in the same window');
});

test('In Chinese the sheet reads in Chinese, and a path or a log line stays as it is', async () => {
  await withOps();
  const merged = (() => {
    const base = JSON.parse(fs.readFileSync(path.join(WEB, 'i18n-zh.json'), 'utf8'));
    const ops = JSON.parse(fs.readFileSync(path.join(WEB, 'i18n', 'ops.json'), 'utf8'));
    return { strings: { ...base.strings, ...ops.strings }, patterns: [...base.patterns, ...ops.patterns] };
  })();
  await js(`(() => { const zh = ${JSON.stringify(JSON.stringify(merged))}; const real = window.fetch; window.fetch = (url, o) => (String(url).includes('i18n-zh.json') ? Promise.resolve(new Response(zh)) : real(url, o)); })(); true`);
  await js('window.jarvisI18n.setLang("zh")');
  await opsEvent({ type: 'ops_doctor', at: new Date().toISOString(), counts: { warn: 3 }, worst: 'warn', groups: { permissions: 'Permissions', jarvis: 'Jarvis', data: 'Your data' },
    checks: [opsCheck('logs', { title: 'Errors in the log', state: 'warn', summary: '3 in the last hour', hint: "If something isn't working, make a diagnostics file and share it when you ask for help.", details: ['2026-09-29 20:00:00,000 ERROR the backup folder is gone'] })] });
  await js('toggleSettings(true); document.querySelector("[data-ops-tab=checkup]").click(); true');
  await frames(3);
  const r = await js('({ tabs: [...document.querySelectorAll("#ops-pop .ops-tabs button")].map((b) => b.textContent), summary: document.querySelector("[data-check=logs] .ops-summary").textContent, hint: document.querySelector("[data-check=logs] .ops-hint").textContent, line: document.querySelector("[data-check=logs] details li").textContent, row: $("ops-line-checkup").textContent })');
  assert(JSON.stringify(r.tabs) === JSON.stringify(['体检', '安全检查', '备份', '诊断']), JSON.stringify(r));
  assert(r.summary === '最近一小时 3 个' && r.hint.startsWith('如果有什么不对劲') && r.row === '3 项值得查看', JSON.stringify(r));
  assert(r.line === '2026-09-29 20:00:00,000 ERROR the backup folder is gone', `a log line was translated: ${r.line}`);
});

// ── Jarvis Code's agent board (web/features/code-board.js, put in as features.js would) ──
// ── Jarvis Code sessions: the board, drafts, the sidebar, edit and resend, /btw, /goal,
// snippets (web/features/code-board.js and code-sessions.js, put in as features.js would) ──

const SESSION_FEATURES = ['code-board.js', 'code-sessions.js'].map((f) => fs.readFileSync(path.join(WEB, 'features', f), 'utf8'));
// Jarvis Code open on alpha with these sessions (ids), the first selected, and the features in.
// Events go to the window as its socket hands them over: app.js's onEvent, then the features'.
async function sessions(ids, extra = {}, then = '') {
  await js(`
    window.__ev = (ev) => { onEvent(ev); featureEvent(ev); };
    deckProjects = [{ name: 'alpha', branch: 'main', path: '/Users/x/alpha' }]; deckProject = 'alpha'; openProjects.add('alpha');
    __ev({ type: 'tasks', items: ${JSON.stringify(ids)}.map((id) => __task(id, { busy: false, status: 'waiting', ...(${JSON.stringify(extra)}[id] || {}) })) });
    toggleCC(true); true`);
  for (const src of SESSION_FEATURES) await js(`${src}\ntrue`);
  await js(`selectTask(${ids[0]}); ${then}; __sent.length = 0; true`);
  await sleep(80);
  await frames(2);
}
const sentTypes = () => js('__sent.map((m) => m.type)');

test('The agent board: lanes by where each session stands, answering from a card, Esc to close', async () => {
  await sessions([1, 2, 3, 4], { 1: { busy: true, status: 'running', last_action: 'Editing app.py' }, 3: { status: 'failed' }, 4: { status: 'resting' } });
  await js('__ev({ ...__approval("a2"), task_id: 2 }); document.querySelector(".cs-board-btn").click()');
  await frames(2);
  let r = await js(`({ open: !document.querySelector('.cs-board').hidden, board: __sent.some((m) => m.type === 'code_board'),
    lanes: [...document.querySelectorAll('.cs-lane')].map((l) => [...l.querySelectorAll('.cs-card')].map((c) => Number(c.dataset.task))) })`);
  assert(r.open && r.board && JSON.stringify(r.lanes) === JSON.stringify([[2], [1], [], [3], [4]]), JSON.stringify(r));
  await js('__ev({ type: "code_board", items: { 1: { added: 12, removed: 3, branch: "feature/x", updated: new Date().toISOString() } } })');
  await frames(2);
  r = await js('document.querySelector(\'.cs-card[data-task="1"]\').textContent');
  assert(r.includes('+12') && r.includes('−3') && r.includes('feature/x') && r.includes('Editing app.py') && r.includes('just now'), r);
  await js('[...document.querySelectorAll(\'.cs-card[data-task="2"] button\')].find((b) => b.textContent === "Yes").click()');
  assert((await sent()).includes('approve a2 allow'), `sent ${await sent()}`);
  await press('Escape');
  r = await js('({ hidden: document.querySelector(".cs-board").hidden, cc: !$("cc").hidden })');
  assert(r.hidden && r.cc, JSON.stringify(r));
});

test('Each session keeps its own draft and attachments; a sent one is forgotten', async () => {
  await sessions([1, 2]);
  await js('$("deck-input").focus()');
  await typeText('draft one');
  await js('attachments = [{ kind: "text", type: "text/plain", data: "x", name: "notes.txt", size: 1 }]; renderAttachments(); selectTask(2)');
  let r = await js('({ text: $("deck-input").value, files: attachments.length, saved: __sent.filter((m) => m.type === "code_draft").map((m) => [m.id, m.text]) })');
  assert(r.text === '' && r.files === 0 && JSON.stringify(r.saved) === JSON.stringify([[1, 'draft one']]), JSON.stringify(r));
  await js('selectTask(1); $("deck-input").focus()');
  r = await js('({ text: $("deck-input").value, files: attachments.map((a) => a.name) })');
  assert(r.text === 'draft one' && r.files.join() === 'notes.txt', JSON.stringify(r));
  await js('__sent.length = 0');
  await press('Enter');
  r = await js('({ sent: __sent.map((m) => [m.type, m.text]), text: $("deck-input").value })');
  assert(r.text === '' && JSON.stringify(r.sent) === JSON.stringify([['task_send', 'draft one'], ['code_draft', '']]), JSON.stringify(r));
});

test('A draft kept over a restart comes back, and a resting session reads its history when opened', async () => {
  await sessions([1, 2], { 2: { status: 'resting' } });
  await js('__ev({ type: "code_meta", full: true, items: { 2: { key: "k2", history: false, resting: true, draft: "half a thought" } } }); selectTask(2)');
  const r = await js('({ text: $("deck-input").value, sent: __sent.filter((m) => m.type === "code_session_open").map((m) => m.id) })');
  assert(r.text === 'half a thought' && r.sent.join() === '2', JSON.stringify(r));
});

test('The sidebar: needs-you and unread badges, pinned on top, archived out of sight, a menu per row', async () => {
  await sessions([1, 2, 3, 4]);
  await js(`__ev({ type: 'code_meta', full: true, items: { 2: { pinned: true }, 3: { archived: true }, 4: {} } });
    __ev({ ...__approval('a4'), task_id: 4 });
    __ev({ type: 'task_log', id: 2, entry: { n: 3, role: 'assistant', text: 'Done.' } }); true`);
  await frames(3);
  const row = (id) => `#deck-project-list .jc-session[data-task="${id}"]`;
  let r = await js(`({
    needs: !!document.querySelector('${row(4)} .cs-needs'), unread: !!document.querySelector('${row(2)} .cs-unread'),
    hidden3: document.querySelector('${row(3)}').parentElement.hidden,
    pinned: [...document.querySelectorAll('.cs-pinned-row .cs-pinned-title')].map((n) => n.textContent),
    chips: [...document.querySelectorAll('.cs-filter .cs-chip')].map((n) => n.textContent) })`);
  assert(r.needs && r.unread && r.hidden3 && r.pinned.join() === 'Session 2' && r.chips.join('|') === 'All|Archived (1)', JSON.stringify(r));
  await js('[...document.querySelectorAll(".cs-filter .cs-chip")].pop().click()');
  await frames(2);
  r = await js('[1, 2, 3, 4].map((id) => !document.querySelector(\'#deck-project-list .jc-session[data-task="\' + id + \'"]\').parentElement.hidden)');
  assert(JSON.stringify(r) === JSON.stringify([true, false, true, false]), `archived filter: ${r}`);  // 1 is open: always shown
  await js('document.querySelectorAll(".cs-filter .cs-chip")[0].click(); document.querySelector(\'#deck-project-list .jc-session[data-task="2"]\').parentElement.querySelector(".cs-row-menu").click()');
  const items = await js('[...$("jc-menu").querySelectorAll(".mi-label")].map((n) => n.textContent)');
  assert(items.includes('Unpin') && items.includes('Archive') && items.includes('Move to group'), `menu: ${items}`);
  await js('[...$("jc-menu").querySelectorAll("button")].find((b) => b.textContent.startsWith("Archive")).click()');
  const set = await js('__sent.filter((m) => m.type === "code_meta_set")');
  assert(JSON.stringify(set) === JSON.stringify([{ type: 'code_meta_set', id: 2, archived: true }]), JSON.stringify(set));
  await js('selectTask(2)');
  assert(!(await js(`!!document.querySelector('${row(2)} .cs-unread')`)), 'opening it did not mark it read');
});

test('Edit and resend: back in place or in a fork, and the reason when it can’t', async () => {
  await sessions([1], {}, said(1, 'u1', 'add a cache').replace('onEvent(', '__ev('));
  await frames(2);
  await js('document.querySelector("#deck-timeline .cs-edit-btn").click()');
  let r = await js('({ open: !!document.querySelector(".cs-editor"), text: document.querySelector(".cs-editor-text").value, focus: document.activeElement.className })');
  assert(r.open && r.text === 'add a cache' && r.focus.includes('cs-editor-text'), JSON.stringify(r));
  await typeText(' with a TTL');
  await js('[...document.querySelectorAll(".cs-editor-row button")][0].click()');
  r = await js('__sent.filter((m) => m.type === "code_rewind")');
  assert(JSON.stringify(r) === JSON.stringify([{ type: 'code_rewind', id: 1, uuid: 'u1', text: 'add a cache with a TTL', files: false, fork: false }]), JSON.stringify(r));
  await js('__ev({ type: "code_rewound", id: 1, uuid: "u1", ok: false, text: "It\'s still working. Stop it first, then rewind." })');
  r = await js('({ err: document.querySelector(".cs-editor-err").textContent, enabled: [...document.querySelectorAll(".cs-editor-row button")].every((b) => !b.disabled) })');
  assert(r.err.startsWith('It') && r.enabled, JSON.stringify(r));
  await js('document.querySelector(".cs-editor-files input").click(); [...document.querySelectorAll(".cs-editor-row button")][2].click()');
  await js('__ev({ type: "code_rewound", id: 1, uuid: "u1", ok: true, text: "Rewound." })');
  r = await js('({ editor: !!document.querySelector(".cs-editor"), composer: $("deck-input").value, last: __sent.filter((m) => m.type === "code_rewind").pop() })');
  assert(!r.editor && r.composer === 'add a cache with a TTL' && r.last.files === true && r.last.text === '', JSON.stringify(r));
  await js('document.querySelector("#deck-timeline .cs-edit-btn").click(); [...document.querySelectorAll(".cs-editor-row button")][1].click()');
  r = await js('({ fork: __sent.filter((m) => m.type === "code_rewind").pop().fork, editor: !!document.querySelector(".cs-editor") })');
  assert(r.fork === true && !r.editor, JSON.stringify(r));
});

test('/btw asks on the side: its answer is a card, never a line of the transcript', async () => {
  await sessions([1], {}, '$("deck-input").focus()');
  await typeText('/btw how many retries?');
  await js('$("cc-slash").hidden = true; $("deck-composer").requestSubmit()');
  await frames(2);
  let r = await js('({ sent: __sent.filter((m) => m.type !== "code_draft").map((m) => [m.type, m.question]), card: document.querySelector(".cs-aside") && document.querySelector(".cs-aside").textContent })');
  assert(JSON.stringify(r.sent) === JSON.stringify([['code_btw', 'how many retries?']]) && r.card.includes('Looking into it'), JSON.stringify(r));
  const ref = await js('__sent.find((m) => m.type === "code_btw").ref');
  await js(`__ev({ type: 'code_btw', id: 1, ref: '${ref}', question: 'how many retries?', state: 'done', text: 'Three, in **net.py**.' })`);
  await frames(2);
  r = await js('({ card: document.querySelector(".cs-aside .jc-md").textContent, log: $("deck-timeline").textContent })');
  assert(r.card === 'Three, in net.py.' && !r.log.includes('Three'), JSON.stringify(r));
  await js('document.querySelector(".cs-aside-x").click()');
  await frames(2);
  assert(await js('!document.querySelector(".cs-aside")'), 'the card stayed');
});

test('/goal sets a goal, and its banner pauses, edits and removes it', async () => {
  await sessions([1], {}, '$("deck-input").focus()');
  await typeText('/goal all tests pass');
  await js('$("cc-slash").hidden = true; $("deck-composer").requestSubmit()');
  let r = await js('__sent.filter((m) => m.type === "code_goal")');
  assert(JSON.stringify(r) === JSON.stringify([{ type: 'code_goal', id: 1, action: 'set', text: 'all tests pass' }]), JSON.stringify(r));
  await js('__ev({ type: "code_meta", items: { 1: { goal: { text: "all tests pass", state: "active", native: false, note: "" } } } })');
  await frames(2);
  r = await js('({ shown: !document.querySelector(".cs-goal").hidden, text: document.querySelector(".cs-goal-text").textContent })');
  assert(r.shown && r.text === 'all tests pass', JSON.stringify(r));
  const click = (label) => js(`[...document.querySelectorAll(".cs-goal-acts button")].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);
  await click('Pause');
  await click('Edit');
  await js('document.querySelector(".cs-goal-edit input").value = "all tests pass on CI"; document.querySelector(".cs-goal-edit").requestSubmit()');
  await frames(2);
  await click('Remove');
  r = await js('__sent.filter((m) => m.type === "code_goal").map((m) => m.action + ":" + (m.text || ""))');
  assert(r.join('|') === 'set:all tests pass|pause:|edit:all tests pass on CI|clear:', r.join('|'));
});

test('Snippets: saved prompts in the / palette put their words in the composer, sending nothing', async () => {
  await sessions([1], {}, '$("deck-input").focus()');
  await js('__ev({ type: "prefs", look: "orb", language: "en", models: [], personas: [], humor: 50, features: { code_snippets: [{ name: "review-pr", text: "Review this PR for bugs." }] } }); $("deck-input").focus()');
  await typeText('/review');
  const r = await js('[...$("cc-slash").querySelectorAll("strong")].map((n) => n.textContent)');
  assert(r.includes('/review-pr'), `palette: ${r}`);
  await js('[...$("cc-slash").querySelectorAll("button")].find((b) => b.textContent.startsWith("/review-pr")).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))');
  const after = await js('({ text: $("deck-input").value, sent: __sent.filter((m) => /task_send|code_command/.test(m.type)).length })');
  assert(after.text === 'Review this PR for bugs.' && after.sent === 0, JSON.stringify(after));
});

test('Open folder… sends the folder picked, and the project added opens', async () => {
  await sessions([1]);
  await js('window.prompt = () => "/Users/x/code/tool"; document.querySelector(".cs-open-folder").click()');
  await sleep(20);
  let r = await js('__sent.filter((m) => m.type === "code_project_add")');
  assert(JSON.stringify(r) === JSON.stringify([{ type: 'code_project_add', path: '/Users/x/code/tool', root: false }]), JSON.stringify(r));
  await js('deckProjects.push({ name: "tool", branch: "", path: "/Users/x/code/tool" }); __ev({ type: "code_project_added", name: "tool", path: "/Users/x/code/tool" })');
  r = await js('deckProject');
  assert(r === 'tool', `project ${r}`);
});

test('Settings › Snippets adds one, and a built-in name is refused', async () => {
  await sessions([1]);
  await js('openJcSettings("general"); [...document.querySelectorAll(".jcs-tabs button")].find((b) => b.dataset.tab === "snippets").click()');
  await frames(2);
  const visible = await js('({ mine: !document.querySelector(".cs-jcs .cs-snippet-form").closest(".jcs-body").hidden, general: $("jcs-general").hidden })');
  assert(visible.mine && visible.general, JSON.stringify(visible));
  const add = async (name) => js(`(() => { const f = document.querySelector('.cs-snippet-form'); const [n, t] = f.querySelectorAll('.jcs-input'); n.value = ${JSON.stringify(name)}; t.value = 'Run the tests and fix failures.'; f.requestSubmit(); return f.querySelector('.jcs-help').textContent; })()`);
  const refused = await add('plan');
  assert(refused.includes('built-in'), refused);
  await add('fix-tests');
  const r = await js('__sent.filter((m) => m.type === "feature_prefs").map((m) => m.changes.code_snippets)');
  assert(JSON.stringify(r) === JSON.stringify([[{ name: 'fix-tests', text: 'Run the tests and fix failures.' }]]), JSON.stringify(r));
});

// ── the second brain feature (web/features/brain.js): loaded as features.js loads it ──

const BRAIN_JS = fs.readFileSync(path.join(WEB, 'features', 'brain.js'), 'utf8');
const BRAIN_CSS = fs.readFileSync(path.join(WEB, 'features', 'brain.css'), 'utf8');
// Waits for a condition in the page (a debounced search), up to three seconds.
async function until(cond) {
  for (let i = 0; i < 60; i++) {
    if (await js(cond)) return true;
    await sleep(50);
  }
  return false;
}
async function loadBrain() {
  await js(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(BRAIN_CSS)}; document.head.append(s); })(); true`);
  await js(`${BRAIN_JS}; window.__deliver = (ev) => { onEvent(ev); featureEvent(ev); }; __sent.length = 0; true`);
}
const GALAXY_NODES = `[
  { id: 'n1', title: 'Board prep', source: 'notes', group: '', p: [0.1, 0, 0.1], t: 20720 },
  { id: 'n2', title: 'Groceries', source: 'notes', group: '', p: [0.2, 0, 0.1], t: 20400 },
  { id: 'm1', title: 'Board dinner', source: 'mail', group: '', p: [0.3, 0, 0.2], t: 20718 },
  { id: 'f1', title: 'Deck', source: 'computer', group: '', p: [0.4, 0, 0.1], t: 20600 },
  { id: 'i1', title: 'Screenshot', source: 'images', group: '', p: [0.5, 0, 0.1], t: 20719 },
  { id: 'c1', title: 'Taxes', source: 'conversations', group: '', p: [0.6, 0, 0.1], t: null },
]`;

test('The second brain’s new switches sit under Second brain, keep their defaults and send their own commands', async () => {
  await loadBrain();
  const r = await js(`(() => {
    const group = $('fda-btn').parentElement;
    const ids = [...group.querySelectorAll('.switch')].map((s) => s.id);
    const on = (id) => $(id).getAttribute('aria-checked');
    return { ids, before: ids.indexOf('sw-brain_semantic') > ids.indexOf('sw-messages'),
      semantic: on('sw-brain_semantic'), conversations: on('sw-brain_conversations'), safari: on('sw-brain_safari'),
      research: on('sw-research_local'), last: $('fda-btn').previousElementSibling.querySelector('.switch').id };
  })()`);
  assert(r.before && r.last === 'sw-research_local', JSON.stringify(r));
  assert(r.semantic === 'false' && r.conversations === 'true' && r.safari === 'false' && r.research === 'true', JSON.stringify(r));
  await js(`$('sw-brain_safari').click(); $('sw-brain_semantic').click(); $('sw-research_local').click(); $('sw-brain_conversations').click(); true`);
  const s = await js('__sent');
  assert(JSON.stringify(s) === JSON.stringify([
    { type: 'brain_source', source: 'safari', on: true },
    { type: 'brain_semantic', on: true },
    { type: 'research_local', on: false },
    { type: 'brain_source', source: 'conversations', on: false },
  ]), JSON.stringify(s));
  await js(`__deliver({ type: 'prefs', look: 'orb', language: 'en', models: [], personas: [], humor: 50, features: { brain_safari: false, brain_images: false } }); true`);
  assert(await js(`$('sw-brain_safari').getAttribute('aria-checked') === 'false' && $('sw-brain_images').getAttribute('aria-checked') === 'false' && $('sw-brain_conversations').getAttribute('aria-checked') === 'true'`), 'prefs did not set the switches');
  await js(`__deliver({ type: 'brain_semantic', on: true, state: 'ready', vectors: 1200, wanted: 3000, detail: '' }); true`);
  const status = await js(`({ text: $('brain-semantic-status').textContent, hidden: $('brain-semantic-status').hidden, on: $('sw-brain_semantic').getAttribute('aria-checked') })`);
  assert(!status.hidden && status.on === 'true' && status.text === '1,200 of 3,000 passages searchable by meaning; the rest come as the brain updates.', JSON.stringify(status));
  await js(`__deliver({ type: 'brain_semantic', on: false, state: 'off', vectors: 0, wanted: 0 }); true`);
  assert(await js(`$('brain-semantic-status').hidden`), 'the status stayed while off');
});

test('The galaxy’s search asks the hub, shows its results as text and flies to the best on Enter', async () => {
  await loadBrain();
  await js(`setGalaxyMode('open'); __deliver({ type: 'galaxy', nodes: ${GALAXY_NODES}, edges: [], clusters: [] }); __sent.length = 0; true`);
  await js(`$('galaxy-q').value = 'board'; $('galaxy-q').dispatchEvent(new Event('input')); true`);
  assert(await until(`__sent.some((m) => m.type === 'brain_search')`), 'typing searched nothing');
  const typed = await sentOf('brain_search');
  assert(typed.length === 1 && typed[0].q === 'board' && typed[0].k === 30 && typed[0].seq, JSON.stringify(typed));
  assert(!('sources' in typed[0]) && !('since' in typed[0]), 'no filter was set');
  await js(`__deliver({ type: 'brain_results', seq: 'another-window:1', q: 'board', items: [{ id: 'n2', title: 'Wrong', source: 'notes', group: '', excerpt: '', match: 'words', modified: '' }] }); true`);
  assert(await js(`$('brain-results').hidden || !$('brain-results').textContent.includes('Wrong')`), 'another window’s results were shown');
  await js(`__sent.length = 0; $('galaxy-search').requestSubmit(); true`);
  const [enter] = await sentOf('brain_search');
  const items = `[{ id: 'm1', title: '<img src=x onerror="window.__pwned=1">Board dinner', source: 'mail', group: 'Ann', excerpt: 'Dinner after the <b>board</b> meeting', match: 'meaning', modified: '2026-09-28T19:00:00' },
    { id: 'n1', title: 'Board prep', source: 'notes', group: '', excerpt: 'Revenue slides', match: 'words', modified: '2026-09-29' }]`;
  await js(`__deliver({ type: 'brain_results', seq: ${JSON.stringify(enter.seq)}, q: 'board', items: ${items} }); true`);
  await frames();
  const r = await js(`({ shown: !$('brain-results').hidden, head: document.querySelector('.brain-results-head').textContent,
    titles: [...document.querySelectorAll('#brain-results .brain-hit strong')].map((x) => x.textContent),
    imgs: document.querySelectorAll('#brain-results img, #brain-results b').length, pwned: !!window.__pwned,
    meaning: document.querySelectorAll('#brain-results .brain-by-meaning').length,
    focus: galaxy.focusId, highlights: [...galaxy.highlights], note: __sent.filter((m) => m.type === 'note').map((m) => m.id),
    noI18n: document.querySelector('#brain-results .brain-hit strong').hasAttribute('data-no-i18n') })`);
  assert(r.shown && r.head === '2 results' && r.titles[1] === 'Board prep' && r.imgs === 0 && !r.pwned, JSON.stringify(r));
  assert(r.meaning === 1 && r.focus === 'm1' && r.note[0] === 'm1' && r.highlights.includes('n1') && r.noI18n, JSON.stringify(r));
  await js(`__sent.length = 0; document.querySelectorAll('#brain-results .brain-hit')[1].click(); true`);
  assert(JSON.stringify(await js('__sent')) === JSON.stringify([{ type: 'note', id: 'n1' }]), 'a result click did not open its note');
  assert(await js(`selectedNote === 'n1' && galaxy.focusId === 'n1'`), 'a result click did not fly to its star');
  // Nothing found (a filter, say): the old results and their lit stars go.
  await js(`__sent.length = 0; $('galaxy-search').requestSubmit(); true`);
  const [again] = await sentOf('brain_search');
  await js(`__deliver({ type: 'brain_results', seq: ${JSON.stringify(again.seq)}, q: 'board', items: [] }); true`);
  const none = await js(`({ size: galaxy.highlights.size, empty: document.querySelector('#brain-results .brain-empty') && document.querySelector('#brain-results .brain-empty').textContent, head: document.querySelector('#brain-results .brain-results-head').hidden })`);
  assert(none.size === 0 && none.empty === 'Nothing in your second brain matches that.' && none.head, JSON.stringify(none));
  await js(`$('galaxy-q').value = ''; $('galaxy-q').dispatchEvent(new Event('input')); true`);
  assert(await until(`$('brain-results').hidden && galaxy.highlights.size === 0`), 'clearing the search left results');
});

test('Source chips and the time slider hide stars, narrow the search and are only for the open galaxy', async () => {
  await loadBrain();
  await js(`setGalaxyMode('open'); __deliver({ type: 'galaxy', nodes: ${GALAXY_NODES}, edges: [[0, 2], [1, 3]], clusters: [] }); true`);
  await frames();
  const chips = await js(`[...document.querySelectorAll('.brain-chip')].map((c) => c.dataset.group + ':' + c.querySelector('small').textContent)`);
  assert(JSON.stringify(chips) === JSON.stringify(['notes:2', 'mail:1', 'files:2', 'conversations:1']), JSON.stringify(chips));
  assert(await js(`getComputedStyle($('galaxy-legend')).display === 'none'`), 'the old legend still shows');
  await js(`document.querySelector('.brain-chip[data-group="files"]').click(); true`);
  await frames();
  let r = await js(`({ visible: [...galaxy.visible], count: $('galaxy-count').textContent, pressed: document.querySelector('.brain-chip[data-group="files"]').getAttribute('aria-pressed') })`);
  assert(JSON.stringify(r.visible) === '[1,1,1,0,0,1]' && r.count === '4 of 6 notes shown' && r.pressed === 'false', JSON.stringify(r));
  await js(`__sent.length = 0; $('galaxy-q').value = 'board'; $('galaxy-search').requestSubmit(); true`);
  const [narrow] = await sentOf('brain_search');
  assert(JSON.stringify(narrow.sources.sort()) === JSON.stringify(['conversations', 'mail', 'notes']), JSON.stringify(narrow));
  // The last two weeks: the undated conversation and the older notes go.
  await js(`$('brain-from').value = '20710'; $('brain-from').dispatchEvent(new Event('input')); $('brain-from').dispatchEvent(new Event('change')); true`);
  await frames();
  r = await js(`({ visible: [...galaxy.visible], label: document.querySelector('.brain-time-label').textContent, search: __sent.filter((m) => m.type === 'brain_search').pop() })`);
  assert(JSON.stringify(r.visible) === '[1,0,1,0,0,0]', JSON.stringify(r));
  const day = (t) => new Date(t * 86400000).toISOString().slice(0, 10);
  assert(r.label.startsWith('From') && r.search.since === day(20710) && r.search.until === day(20720), JSON.stringify(r));
  // Closed: every star again (the ambient galaxy shows what Jarvis draws on); open: the filters.
  await js(`setGalaxyMode('off'); true`);
  await frames();
  assert(await js('galaxy.visible === null'), 'the filters stayed on the closed galaxy');
  await js(`setGalaxyMode('open'); true`);
  await frames(3);
  assert(await js('JSON.stringify([...galaxy.visible]) === "[1,0,1,0,0,0]"'), 'the filters did not come back');
});

test('A filtered galaxy of 30,000 notes still draws a bounded number of stars, and every star of a small source', async () => {
  await loadBrain();
  const r = await js(`(() => {
    const nodes = Array.from({ length: 30000 }, (_, i) => ({ id: 'n' + i, title: 'Note ' + i, source: i % 100 === 0 ? 'mail' : 'notes', group: '', p: [Math.cos(i) * 1.2, (i % 7) / 50, Math.sin(i) * 1.2], t: 20000 + (i % 700) }));
    setGalaxyMode('open');
    __deliver({ type: 'galaxy', nodes, edges: [], clusters: [] });
    galaxy.resize();
    const ctx = galaxy.ctx, real = ctx.drawImage.bind(ctx);
    let calls = 0; ctx.drawImage = (...a) => { calls++; return real(...a); };
    const mask = new Uint8Array(30000); for (let i = 0; i < 30000; i += 100) mask[i] = 1;
    galaxy.setVisible(mask);
    galaxy.frame(performance.now());
    const small = calls; calls = 0;
    galaxy.setVisible(new Uint8Array(30000).fill(1));
    const started = performance.now();
    galaxy.frame(performance.now());
    const ms = performance.now() - started;
    ctx.drawImage = real;
    return { small, all: calls, ms };
  })()`);
  assert(r.small >= 250 && r.small <= 320, `a 300-star source drew ${r.small}`);
  assert(r.all <= 8100, `${r.all} stars drawn in one frame`);
});

test('A research report’s note offers a follow-up question and a PDF; other notes don’t', async () => {
  await loadBrain();
  await js(`setGalaxyMode('open'); selectedNote = 'file:/Users/x/Documents/Jarvis/Research/2026-09-20 1000 Lithium.md';
    __deliver({ type: 'note', id: selectedNote, title: 'Lithium supply in 2026', source: 'research', group: 'Research', text: '# Lithium' }); true`);
  assert(await js(`!$('brain-note-extra').hidden`), 'no report controls on a report');
  await js(`__sent.length = 0; $('brain-ask-q').value = 'What were the open questions?'; document.querySelector('.brain-ask').requestSubmit(); true`);
  let s = await js('__sent');
  assert(s.length === 1 && s[0].type === 'ask' && s[0].text === 'About my research report “Lithium supply in 2026”: What were the open questions?', JSON.stringify(s));
  assert(await js(`galaxyMode === 'off'`), 'the galaxy stayed over the answer');
  await js(`setGalaxyMode('open'); selectedNote = 'file:/Users/x/Documents/Jarvis/Research/2026-09-20 1000 Lithium.md';
    __deliver({ type: 'note', id: selectedNote, title: 'Lithium supply in 2026', source: 'research', group: '', text: '' });
    __sent.length = 0; document.querySelector('#brain-note-extra .brain-pdf').click(); true`);
  s = await js('__sent');
  assert(JSON.stringify(s) === JSON.stringify([{ type: 'report_pdf', name: '2026-09-20 1000 Lithium.md' }]), JSON.stringify(s));
  await js(`selectedNote = 'conversation:s1:1'; __deliver({ type: 'note', id: selectedNote, title: 'Taxes', source: 'conversations', group: '', text: 'You: taxes' }); true`);
  assert(await js(`$('brain-note-extra').hidden && $('note-open').hidden`), 'a conversation offered report controls or Open');
  await js(`__deliver({ type: 'report_exported', name: 'x.md', path: '/Users/x/Documents/Jarvis/Research/x.pdf', pdf: true }); true`);
  assert(await js(`[...document.querySelectorAll('#cards .card-title')].some((t) => t.textContent === 'Saved as PDF')`), 'no notice for the PDF');
  await js(`__sent.length = 0; [...document.querySelectorAll('#cards .card button')].find((b) => b.textContent === 'Open').click(); true`);
  s = await js('__sent');
  assert(JSON.stringify(s) === JSON.stringify([{ type: 'report_open', path: '/Users/x/Documents/Jarvis/Research/x.pdf' }]), JSON.stringify(s));
});

// ── the phone companion (web/features/companion.js, loaded as features.js loads it) ──

const COMPANION = fs.readFileSync(path.join(WEB, 'features', 'companion.js'), 'utf8');
const feature = (ev) => js(`(() => { const ev = ${JSON.stringify(ev)}; onEvent(ev); featureEvent(ev); return true; })()`);
const clickSel = async (selector) => {
  await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' }); true`);
  await clickAt(selector);
};

test('Settings shows the pairing QR code and security code, and a new certificate is asked twice', async () => {
  await js(`${COMPANION}; toggleSettings(true); true`);
  const tls = { fingerprint: 'ab'.repeat(32), short: 'abab abab abab abab', expires: '2028-01-01T00:00:00+00:00' };
  await feature({ type: 'remote', running: true, error: '', urls: ['https://mac.local:8765'], devices: [], tls, plain_http: false });
  await feature({ type: 'companion', running: true, tls, plain_http: false, host: 'mac.local',
    devices: [{ id: 'd1', name: 'Bilel’s iPhone', paired: '2026-09-01T09:00:00', last_seen: '2026-09-29T10:00' }],
    audit: [{ at: '2026-09-29T10:00:00', device: 'd1', name: 'Bilel’s iPhone', action: 'paired', label: 'Paired', detail: '' }] });
  await js('__sent.length = 0; true');
  await feature({ type: 'remote_code', code: '123456', seconds: 300, urls: [] });
  assert((await sent()).includes('companion_pairing'), `a new code should ask for its QR code: ${await sent()}`);
  await feature({ type: 'companion_pairing', qr: ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'], short: tls.short, seconds: 300 });
  const qr = await js(`(() => { const box = document.querySelector('.companion-qr'); const svg = box.querySelector('svg');
    return { shown: !box.hidden && box.getBoundingClientRect().height > 100, d: svg.querySelector('path').getAttribute('d'), code: box.textContent.includes('abab abab abab abab') }; })()`);
  assert(qr.shown && qr.d.startsWith('M4 4h7v1h-7z') && qr.code, JSON.stringify(qr));
  const devices = await js(`({ old: getComputedStyle($('remote-devices')).display === 'none', names: [...document.querySelectorAll('.companion-devices strong')].map((n) => n.textContent) })`);
  assert(devices.old && JSON.stringify(devices.names) === '["Bilel’s iPhone"]', JSON.stringify(devices));

  await js('__sent.length = 0; document.querySelector(".companion-security").open = true; true');
  await clickSel('.companion-security .switch');
  const plain = await js('__sent[0]');
  assert(plain && plain.type === 'feature_prefs' && plain.changes.companion_plain_http === true, JSON.stringify(plain));
  await js('__sent.length = 0; true');
  await clickSel('.companion-security > .btn');
  assert((await sent()).length === 0, 'the first click must only ask');
  assert(await js('!document.querySelector(".companion-confirm").hidden'), 'no confirmation shown');
  await clickText('.companion-confirm', 'Make a new certificate');
  assert(JSON.stringify(await sent()) === '["companion_new_certificate"]', `${await sent()}`);
  assert(await js('document.querySelector(".companion-qr").hidden'), 'the old QR code should go with the old certificate');
});

test('Notifications: the key is pasted once, each phone chooses what it is sent, and a test push reports back', async () => {
  await js(`${COMPANION}; toggleSettings(true); true`);
  const tls = { fingerprint: 'ab'.repeat(32), short: 'abab abab abab abab', expires: '2028-01-01T00:00:00+00:00' };
  const phone = { id: 'd1', name: 'Bilel’s iPhone', paired: '2026-09-01T09:00:00', last_seen: '2026-09-29T10:00',
    push: { registered: true, environment: 'production', since: '2026-09-29T09:00', error: '' },
    settings: { approvals: true, headsups: 'urgent', code: true, delegations: true, calls: true } };
  const status = (push) => ({ type: 'companion', running: true, tls, plain_http: false, host: 'mac.local', push, push_when: 'away', devices: [phone], audit: [] });
  await feature({ type: 'remote', running: true, error: '', urls: ['https://mac.local:8765'], devices: [], tls, plain_http: false });
  await feature(status({ known: true, configured: false, error: '' }));
  await js('document.querySelector(".companion-push").open = true; true');
  assert(await js('!document.querySelector(".companion-key-form").hidden'), 'with no key, the form should show');
  await js(`(() => { const form = document.querySelector('.companion-key-form');
    form.querySelector('textarea').value = '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----';
    form.querySelectorAll('input')[0].value = 'ABC123DEFG'; __sent.length = 0; })(); true`);
  await clickText('.companion-key-form', 'Save in the Keychain');
  const saved = await js('__sent[0]');
  assert(saved && saved.type === 'companion_push_key' && saved.key_id === 'ABC123DEFG' && saved.team_id === '9ZSY5R8A5C'
    && saved.bundle_id === 'com.bshventures.jarvis.companion' && saved.key.includes('BEGIN PRIVATE KEY'), JSON.stringify(saved));
  await feature({ type: 'companion_push', saved: true });
  await feature(status({ known: true, configured: true, key_id: 'ABC123DEFG', team_id: '9ZSY5R8A5C', bundle_id: 'com.bshventures.jarvis.companion', error: '' }));
  const shown = await js(`({ form: document.querySelector('.companion-key-form').hidden, key: document.querySelector('.companion-key').value,
    status: document.querySelector('.companion-push .small-status').textContent })`);
  assert(shown.form && shown.key === '' && shown.status.includes('ABC123DEFG'), JSON.stringify(shown));

  await js('__sent.length = 0; document.querySelector(".companion-device-push").open = true; true');
  await clickSel('.companion-device-push .switch');  // Approvals off for this phone
  const change = await js('__sent[0]');
  assert(change && change.type === 'companion_device' && change.id === 'd1' && change.settings.approvals === false, JSON.stringify(change));
  await js(`(() => { const s = document.querySelector('.companion-device-push select'); s.value = 'all'; s.dispatchEvent(new Event('change')); })(); true`);
  assert(JSON.stringify(await js('__sent[1].settings')) === '{"headsups":"all"}', 'the heads-up choice did not go');
  await js('__sent.length = 0; true');
  await clickText('.companion-push', 'Send a test push');
  assert(JSON.stringify(await sent()) === '["companion_push_test"]', `${await sent()}`);
  await feature({ type: 'companion_push_test', results: { d1: 'gone' } });
  const result = await js('document.querySelector(".companion-test").textContent');
  assert(result.includes('Bilel’s iPhone') && result.includes('Open it to turn them back on'), result);
});

// ── Settings › Chats (a feature module: web/features/channels.js, injected here) ──

const CHANNELS_JS = fs.readFileSync(path.join(WEB, 'features', 'channels.js'), 'utf8');
const chatItem = (id, title, extra = {}) => ({ id, title, on: false, ready: false, state: 'off', error: '', bot: '', owner: '', since: '', pairs: id !== 'imessage', code: '', seconds: 0, forward: 'urgent', approvals: true, how: id === 'telegram' ? '/pair' : '!pair', ...extra });
const chatsEvent = (over = {}) => `featureEvent(${JSON.stringify({ type: 'channels', audit: [], items: [
  chatItem('telegram', 'Telegram', over.telegram), chatItem('imessage', 'iMessage', over.imessage),
  chatItem('slack', 'Slack', over.slack), chatItem('discord', 'Discord', over.discord)] })}); true`;
async function chatsOpen(over) {
  await js(`${CHANNELS_JS}; toggleSettings(true); __sent.length = 0; true`);
  await js(chatsEvent(over));
  await js('document.querySelector(\'details.channel[data-channel="telegram"]\').open = true; true');
}

test('Settings › Chats: a pasted token goes one way and the field empties at once', async () => {
  await chatsOpen();
  const placed = await js('(() => { const g = $("channels-group"); return { chats: g.querySelectorAll("details.channel").length, beforeAccounts: !!(g.compareDocumentPosition($("open-accounts")) & Node.DOCUMENT_POSITION_FOLLOWING) }; })()');
  assert(placed.chats === 4 && placed.beforeAccounts, JSON.stringify(placed));
  await js('document.querySelector(\'details.channel[data-channel="telegram"] input[type="password"]\').focus()');
  await type('abc123');
  await clickText('details.channel[data-channel="telegram"]', 'Save to Keychain');
  const r = await js('({ sent: __sent, left: document.querySelector(\'details.channel[data-channel="telegram"] input[type="password"]\').value })');
  assert(JSON.stringify(r.sent) === JSON.stringify([{ type: 'channels_connect', channel: 'telegram', token: 'abc123' }]), JSON.stringify(r.sent));
  assert(r.left === '', 'the token stayed in the field');
});

test('Settings › Chats: pairing shows the code, the owner as text, and the switches send settings', async () => {
  await chatsOpen({ telegram: { ready: true, on: true, state: 'listening', bot: '@jarvis_bot' } });
  await clickText('details.channel[data-channel="telegram"]', 'Pair');
  await js(chatsEvent({ telegram: { ready: true, on: true, state: 'listening', bot: '@jarvis_bot', code: '123456', seconds: 600 } }));
  const code = await js('document.querySelector(".channel-code").textContent');
  assert(code.startsWith('/pair 123456'), code);
  await js(chatsEvent({ telegram: { ready: true, on: true, state: 'listening', bot: '@jarvis_bot', owner: 'Ann <img src=x onerror="window.__pwned=1">' } }));
  await frames(2);
  const shown = await js('(() => { const o = document.querySelector(".channel-owner"); return { text: o.textContent, data: o.hasAttribute("data-no-i18n"), imgs: $("channels-group").querySelectorAll("img").length, pwned: !!window.__pwned, status: document.querySelector(\'details.channel[data-channel="telegram"] .channel-status\').textContent }; })()');
  assert(shown.text.startsWith('Ann <img') && shown.data && shown.imgs === 0 && !shown.pwned, JSON.stringify(shown));
  assert(shown.status === 'On', shown.status);
  await js('document.querySelector(\'details.channel[data-channel="telegram"] .switch\').click(); true');
  await clickText('details.channel[data-channel="telegram"] .segmented', 'All');
  const sent = await js('__sent');
  assert(JSON.stringify(sent) === JSON.stringify([
    { type: 'channels_pair', channel: 'telegram' },
    { type: 'feature_prefs', changes: { channels_telegram_on: false } },
    { type: 'feature_prefs', changes: { channels_telegram_forward: 'all' } },
  ]), JSON.stringify(sent));
});

test('Settings › Chats: a redraw never wipes a token being typed', async () => {
  await chatsOpen({ slack: { state: 'off' } });
  await js('document.querySelector(\'details.channel[data-channel="slack"]\').open = true; document.querySelector(\'details.channel[data-channel="slack"] input\').focus()');
  await type('xapp');
  await js(chatsEvent({ slack: { state: 'needs_setup', error: '' }, telegram: { state: 'needs_setup' } }));
  const kept = await js('document.querySelector(\'details.channel[data-channel="slack"] input\').value');
  assert(kept === 'xapp', `the field was redrawn: "${kept}"`);
});

test('Settings › Chats: iMessage picks a conversation, how Messages is signed in, and whose handles count', async () => {
  await chatsOpen();
  await js('document.querySelector(\'details.channel[data-channel="imessage"]\').open = true; true');
  await clickText('details.channel[data-channel="imessage"]', 'Choose a conversation');
  await js(`featureEvent({ type: 'channels_chats', error: '', items: [
    { id: '+15105550100', guid: 'iMessage;-;+15105550100', name: '+15105550100', group: false, self: true, handles: ['+15105550100'] },
    { id: 'chat77', guid: 'iMessage;+;chat77', name: 'Family', group: true, self: false, handles: ['+15105550100', '+14155550199'] }] }); true`);
  await js(`(() => { const s = document.querySelector('details.channel[data-channel="imessage"] select'); s.value = 'chat77'; s.dispatchEvent(new Event('change')); })(); true`);
  await js('document.querySelector(\'.channel-handle input[value="+15105550100"]\').click(); true');
  await clickText('details.channel[data-channel="imessage"] .segmented', 'Jarvis’s own Apple ID');
  await clickText('details.channel[data-channel="imessage"]', 'Use this conversation');
  const sent = await js('__sent.filter((m) => m.type.startsWith("channels_"))');
  assert(JSON.stringify(sent) === JSON.stringify([
    { type: 'channels_chats' },
    { type: 'channels_imessage', channel: 'imessage', chat: 'chat77', account: 'jarvis', handles: ['+15105550100'], prefix: false },
  ]), JSON.stringify(sent));
});

// ── Jarvis Code's feature modules (web/features): loaded into the page as features.js
// loads them, their styles too ──

// A click on something in a pane that scrolls: brought into view first, and named if missing.
async function clickIn(selector) {
  const found = await js(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; n.scrollIntoView({ block: 'center' }); return true; })()`);
  if (!found) throw new Error(`nothing matches ${selector}`);
  await clickAt(selector);
}

// __ev(event): an event as the socket delivers it, to app.js and to the features' listeners.
// Loaded in name order, as features.js loads them (code_changes.js before code_diff.js).
async function loadFeatures(...names) {
  await js('window.__ev = (ev) => { onEvent(ev); featureEvent(ev); }; true');
  for (const name of [...names].sort()) {
    const file = path.join(WEB, 'features', name);
    if (name.endsWith('.css')) await js(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(fs.readFileSync(file, 'utf8'))}; document.head.append(s); })()`);
    else await js(fs.readFileSync(file, 'utf8'));
  }
}

test('Isolated copy: the switch goes with a new session, and is on when another session is at work', async () => {
  await js('deckProjects = [{ name: "alpha", branch: "main" }]; deckProject = "alpha"; openProjects.add("alpha"); toggleCC(true); ccSelected = null; renderCC([]); __sent.length = 0');
  await loadFeatures('code_isolation.js', 'code_isolation.css');
  await sleep(80);
  const shown = await js('({ hidden: $("jcx-iso-switch").hidden, on: $("jcx-iso-switch").getAttribute("aria-pressed") })');
  assert(!shown.hidden && shown.on === 'false', JSON.stringify(shown));
  await js('$("deck-input").value = "fix the login"; $("deck-composer").requestSubmit()');
  let news = await js('__sent.filter((m) => m.type === "task_new")');
  assert(news.length === 1 && news[0].isolated === false && news[0].prompt === 'fix the login', JSON.stringify(news));
  // Another session at work in the project: the switch is on, and says why.
  await js('__sent.length = 0; __ev({ type: "tasks", items: [__task(7, { folder: "alpha", busy: true })] }); ccSelected = null; renderCC(ccTasks)');
  const offered = await js('({ on: $("jcx-iso-switch").getAttribute("aria-pressed"), title: $("jcx-iso-switch").title })');
  assert(offered.on === 'true' && offered.title.startsWith('Another session is working'), JSON.stringify(offered));
  await js('$("deck-input").value = "second"; $("deck-composer").requestSubmit()');
  news = await js('__sent.filter((m) => m.type === "task_new")');
  assert(news.length === 1 && news[0].isolated === true, JSON.stringify(news));
  // The owner's own choice wins for the next session, then it's back to the default.
  await js('__sent.length = 0');
  await clickIn('#jcx-iso-switch');
  await js('$("cc-start-typed").click()');
  news = await js('__sent.filter((m) => m.type === "task_new")');
  assert(news.length === 1 && news[0].isolated === false, JSON.stringify(news));
  await sleep(20);
  assert(await js('$("jcx-iso-switch").getAttribute("aria-pressed")') === 'true', 'the switch kept a choice for the next session');
  // With a session on screen there's nothing to start: no switch.
  await js('__ev({ type: "tasks", items: [__task(7, { folder: "alpha" })] }); selectTask(7)');
  assert(await js('$("jcx-iso-switch").hidden'), 'the switch shows over an open session');
});

test('Isolated copy: the header names the branch, and the Copies pane lands, discards and brings back', async () => {
  await open(3);
  await loadFeatures('code_isolation.js', 'code_isolation.css');
  await js('__ev({ type: "tasks", items: [__task(3, { workspace: { slug: "fix-login-1a2b", branch: "jarvis/fix-login-1a2b", into: "main" } })] }); selectTask(3); __sent.length = 0');
  await sleep(40);
  const badge = await js('({ hidden: document.querySelector(".jcx-iso-badge").hidden, text: document.querySelector(".jcx-iso-badge").textContent })');
  assert(!badge.hidden && badge.text === 'jarvis/fix-login-1a2b → main', JSON.stringify(badge));
  await clickIn('.jcx-iso-badge');
  assert((await sent()).includes('code_copies'), 'the pane never asked for the copies');
  await js(`__ev({ type: 'code_copies', root: '/tmp/worktrees', copies: [
      { slug: 'fix-login-1a2b', project: 'alpha', branch: 'jarvis/fix-login-1a2b', into: 'main', title: 'fix the <b>login</b>', created: Date.now() / 1000 - 300,
        state: { exists: true, branch: true, dirty: 2, ahead: 1, files: 3, added: 12, removed: 4 }, sessions: [3], live: true, busy: false, leftover: false, conflicts: ['a.py'], resumable: true },
      { slug: 'old-0000', project: 'alpha', branch: 'jarvis/old-0000', into: 'main', title: '', created: 1,
        state: { exists: true, branch: true, dirty: 1, ahead: 0, files: 1, added: 1, removed: 0 }, sessions: [], live: false, busy: false, leftover: true, conflicts: [], resumable: false } ],
    trash: [{ slug: 'gone-1111', project: 'alpha', title: 'an old try', at: Date.now() / 1000 - 90000, into: 'main', restorable: true }] })`);
  const pane = await js(`({ cards: [...document.querySelectorAll('.jcx-copy')].map((c) => c.querySelector('strong').textContent + ' | ' + [...c.querySelectorAll('.jcx-chip')].map((x) => x.textContent).join(',') + ' | ' + c.querySelector('.jcx-copy-stats').textContent),
      bold: document.querySelectorAll('.jcx-copy b').length, root: document.querySelector('.jcx-copies-root').textContent })`);
  assert(pane.cards[0] === 'fix the <b>login</b> | open,conflicts | 3 files +12 −4 · 2 not committed · 1 commit ahead', JSON.stringify(pane));
  assert(pane.cards[1] === 'old-0000 | not landed | 1 file +1 −0 · 1 not committed', JSON.stringify(pane));
  assert(pane.bold === 0 && pane.root === '/tmp/worktrees', 'a title was drawn as HTML');
  await js('__sent.length = 0');
  await clickText('.jcx-copy:first-child', 'Land');
  await clickText('.jcx-copy:first-child', 'Resolve in session');
  await clickText('.jcx-copy:nth-child(2)', 'Discard');
  await clickText('.jcx-copies', 'Bring back');
  const acts = await js('__sent.filter((m) => m.type === "code_copy").map((m) => m.action + " " + m.slug)');
  assert(JSON.stringify(acts) === JSON.stringify(['land fix-login-1a2b', 'resolve fix-login-1a2b', 'discard old-0000', 'restore gone-1111']), JSON.stringify(acts));
  // The project's own options: .env files and linked dependencies, as settings.
  await js('__sent.length = 0');
  await clickIn('.jcx-copies .jcs-switch');
  const prefs = await js('__sent.filter((m) => m.type === "feature_prefs").map((m) => m.changes)');
  assert(JSON.stringify(prefs) === JSON.stringify([{ code_iso_env: ['alpha'] }]), JSON.stringify(prefs));
});

test('Isolated copy: the default is a Jarvis Code setting', async () => {
  await loadFeatures('code_isolation.js');
  await js('toggleCC(true); openJcSettings("general"); __sent.length = 0');
  await clickIn('#jcx-iso-default');
  const changes = await js('__sent.filter((m) => m.type === "feature_prefs").map((m) => m.changes)');
  assert(JSON.stringify(changes) === JSON.stringify([{ code_isolate_default: true }]), JSON.stringify(changes));
  await js('__ev({ type: "prefs", features: { code_isolate_default: true } })');
  assert(await js('$("jcx-iso-default").getAttribute("aria-checked")') === 'true', 'the setting didn’t show');
});

const HUNK_VIEW = (extra = {}) => JSON.stringify({ type: 'code_changes', id: 1, view: 'session', git: true, workspace: {}, conflicts: [],
  totals: { files: 1, added: 1, removed: 1, hunks: 2 },
  files: [{ path: 'src/app.py', old_path: '', status: 'M', binary: false, sensitive: false, added: 2, removed: 2, omitted: false,
    hunks: [
      { id: 'h1', n: 1, old_start: 1, old_count: 4, new_start: 1, new_count: 4, header: 'def run():', where: 'run', line: 2, cut: 0, kept: false,
        lines: [[' ', 'def run():'], ['-', '    return total * count'], ['+', '    return total * quantity'], [' ', ''], [' ', '# done']] },
      { id: 'h2', n: 2, old_start: 40, old_count: 3, new_start: 40, new_count: 3, header: '', where: '', line: 41, cut: 0, kept: false,
        lines: [[' ', 'a = 1'], ['-', 'b = "<b>old</b>"'], ['+', 'b = "<b>new</b>"'], [' ', 'c = 3']] },
    ] }], ...extra });

test('Changes: the session’s hunks, numbered and highlighted, with the words that changed', async () => {
  await open(1);
  await loadFeatures('code_diff.js', 'code_changes.js', 'code_changes.css');
  await js('openPane("diff")');
  const asked = await js('__sent.filter((m) => m.type === "code_changes").map((m) => m.view)');
  assert(JSON.stringify(asked) === JSON.stringify(['session']), JSON.stringify(asked));
  await js(`__ev(${HUNK_VIEW()})`);
  const r = await js(`({
    nums: [...document.querySelectorAll('.jcx-num')].map((n) => n.textContent),
    where: document.querySelector('.jcx-where').textContent,
    kw: [...document.querySelectorAll('.jcx-lines .jcx-k')].map((n) => n.textContent).slice(0, 2),
    marks: [...document.querySelectorAll('mark.jcx-w')].map((n) => n.textContent),
    gap: document.querySelector('.jcx-gap').textContent,
    bold: document.querySelectorAll('#jc-pane-body b').length,
    extra: $('jc-pane-extra').textContent,
  })`);
  assert(JSON.stringify(r.nums) === '["#1","#2"]' && r.where === 'line 2 · run', JSON.stringify(r));
  assert(r.kw[0] === 'def' && r.marks.includes('count') && r.marks.includes('quantity'), JSON.stringify(r));
  assert(r.gap === '⋯ 35 unchanged lines' && r.bold === 0 && r.extra === '+1 −1', JSON.stringify(r));
  // The folded lines, fetched and shown in their place.
  await js('__sent.length = 0');
  await clickIn('.jcx-gap');
  const lines = await js('__sent.filter((m) => m.type === "code_lines")');
  assert(lines.length === 1 && lines[0].start === 5 && lines[0].end === 39 && lines[0].path === 'src/app.py', JSON.stringify(lines));
  await js(`__ev({ type: 'code_lines', id: 1, path: 'src/app.py', start: 5, lines: Array.from({ length: 35 }, (_, i) => 'x' + (i + 5)) })`);
  assert(await js('!document.querySelector(".jcx-gap") && document.querySelectorAll(".jcx-opened .jcx-row").length === 35'), 'the folded lines didn’t open');
});

test('Changes: Keep folds a hunk away, Undo takes two clicks, and the views are asked for', async () => {
  await open(1);
  await loadFeatures('code_diff.js', 'code_changes.js');
  await js(`openPane("diff"); __ev(${HUNK_VIEW()}); __sent.length = 0`);
  await clickText('[data-hunk="h1"]', 'Keep');
  let s = await js('__sent.filter((m) => m.type === "code_hunk").map((m) => m.action + " " + m.hunk)');
  assert(JSON.stringify(s) === '["keep h1"]', JSON.stringify(s));
  assert(await js('document.querySelector(".jcx-hunk").classList.contains("kept") && !document.querySelector(".jcx-hunk").querySelector(".jcx-lines")'), 'a kept hunk still shows its lines');
  const undo = '[data-hunk="h2"] .jcx-undo';
  await clickIn(undo);
  s = await js('__sent.filter((m) => m.type === "code_hunk" && m.action === "undo")');
  assert(!s.length, 'one click undid');
  await clickIn(undo);
  s = await js('__sent.filter((m) => m.type === "code_hunk" && m.action === "undo").map((m) => m.hunk + " " + m.view)');
  assert(JSON.stringify(s) === '["h2 session"]', JSON.stringify(s));
  await js('__sent.length = 0');
  await clickText('.jcx-seg', 'This turn');
  await clickText('.jcx-seg', 'Whole branch');
  s = await js('__sent.filter((m) => m.type === "code_changes").map((m) => m.view)');
  assert(JSON.stringify(s) === '["turn","branch"]', JSON.stringify(s));
  await js(`__ev(${HUNK_VIEW({ view: 'branch', files: [] })})`);
  assert(await js('document.querySelector(".jcx-changes .jc-empty").textContent') === 'No changes on this branch.', 'no empty note');
});

test('Changes: comments on lines go to the session together, and a refresh keeps a draft', async () => {
  await open(1);
  await loadFeatures('code_diff.js', 'code_changes.js');
  await js(`openPane("diff"); __ev(${HUNK_VIEW()}); __sent.length = 0`);
  await clickIn('[data-hunk="h1"] .jcx-row.add .jcx-ln.n');
  await frames(2);
  await typeText('rename it to');
  await js(`__ev(${HUNK_VIEW()})`);  // a refresh while writing
  await frames(2);
  assert(await js('document.querySelector(".jcx-comment.edit textarea").value') === 'rename it to', 'the draft was lost');
  await typeText(' units');
  await press('Enter', ['meta']);
  await clickIn('[data-hunk="h2"] .jcx-row.del .jcx-ln.o');
  await frames(2);
  await typeText('why remove this?');
  await press('Enter', ['meta']);
  const bar = await js('({ bar: document.querySelector(".jcx-sendbar") && document.querySelector(".jcx-sendbar span").textContent, notes: [...document.querySelectorAll(".jcx-comment")].map((n) => n.textContent), editing: !!document.querySelector(".jcx-comment.edit"), active: document.activeElement && document.activeElement.className })');
  assert(bar.bar === '2 comments', `no count: ${JSON.stringify(bar)}`);
  await clickText('.jcx-sendbar', 'Send to the session');
  const msgs = await js('__sent.filter((m) => m.type === "task_send")');
  const want = 'Review comments:\n- src/app.py:2 (`return total * quantity`) — rename it to units\n- src/app.py (removed line 41) (`b = "<b>old</b>"`) — why remove this?';
  assert(msgs.length === 1 && msgs[0].id === 1 && msgs[0].text === want, JSON.stringify(msgs));
  assert(await js('!document.querySelector(".jcx-sendbar") && !document.querySelector(".jcx-comment")'), 'the comments stayed after sending');
});

test('Changes: side by side, an isolated session’s Land, and a folder that isn’t in git', async () => {
  await open(1);
  await loadFeatures('code_diff.js', 'code_changes.js', 'code_changes.css');
  await js(`openPane("diff"); __ev(${HUNK_VIEW({ workspace: { slug: 's-1', branch: 'jarvis/s-1', into: 'main' }, conflicts: ['src/app.py'] })}); __sent.length = 0`);
  await clickText('.jcx-bar', 'Side by side');
  const split = await js('({ on: document.querySelector(".jcx-changes").classList.contains("split"), cells: document.querySelector(".jcx-lines.split .jcx-row.chg").querySelectorAll(".jcx-code").length, wide: $("jc-pane").getBoundingClientRect().width })');
  assert(split.on && split.cells === 2 && split.wide > 600, JSON.stringify(split));
  await clickText('.jcx-strip', 'Land');
  await clickText('.jcx-conflicts', 'Resolve in session');
  const acts = await js('__sent.filter((m) => m.type === "code_copy").map((m) => m.action + " " + m.slug)');
  assert(JSON.stringify(acts) === '["land s-1","resolve s-1"]', JSON.stringify(acts));
  await js(`__ev({ type: 'code_changes', id: 1, view: 'session', git: false, gone: false, workspace: {}, conflicts: [], files: [], touched: ['/p/alpha/a.py'], totals: {} })`);
  assert((await js('document.querySelector(".jcx-changes").textContent')).includes('isn’t a git repository'), 'no note');
  await clickText('.jcx-bar', 'Unified');
});

const GIT_STATE = (extra = {}) => JSON.stringify({ type: 'code_git', key: 'id:1', repo: true, branch: 'main', detached: false, upstream: 'origin/main', ahead: 2, behind: 0,
  staged: [{ path: 'src/a.py', code: 'M' }], unstaged: [{ path: 'b.py', code: 'M' }, { path: 'new <b>x</b>.py', code: '?' }],
  log: [{ sha: 'abc1234', subject: 'Fix the <i>retry</i>', author: 'Ann', at: Date.now() / 1000 - 7200 }], branches: ['main', 'topic'], remotes: ['origin'], merging: false, empty: false, ...extra });

test('Git: the panel stages, writes and commits, switches and makes branches, and pushes', async () => {
  await open(1);
  await loadFeatures('code_diff.js', 'code_git.js', 'code_git.css');
  await clickIn('.jc-tool[data-pane="git"]');
  let s = await js('__sent.filter((m) => m.type === "code_git")');
  assert(s.length === 1 && s[0].id === 1, JSON.stringify(s));
  await js(`__ev(${GIT_STATE()})`);
  const r = await js(`({ labels: [...document.querySelectorAll('.jcx-git .jcs-label')].map((n) => n.textContent),
    files: [...document.querySelectorAll('.jcx-gpath')].map((n) => n.textContent), html: document.querySelectorAll('.jcx-git b, .jcx-git i').length,
    sync: document.querySelector('.jcx-gsync').textContent, pressed: document.querySelector('.jc-tool[data-pane="git"]').getAttribute('aria-pressed') })`);
  assert(JSON.stringify(r.labels) === JSON.stringify(['Staged (1)', 'Changes (2)', 'History']), JSON.stringify(r));
  assert(r.files.join('|') === 'src/a.py|b.py|new <b>x</b>.py' && r.html === 0 && r.sync === '↑2 ↓0' && r.pressed === 'true', JSON.stringify(r));
  await js('__sent.length = 0');
  await clickText('[data-list="staged"] .jcx-gfile:nth-child(1)', 'Unstage');
  await clickText('[data-list="unstaged"] .jcx-gfile:nth-child(2)', 'Stage');
  s = await js('__sent.filter((m) => m.type === "code_git_stage").map((m) => m.paths.join() + " " + m.unstage)');
  assert(JSON.stringify(s) === JSON.stringify(['src/a.py true', 'new <b>x</b>.py false']), JSON.stringify(s));
  // A file's hunks, one at a time.
  await js('__sent.length = 0');
  await clickIn('[data-list="unstaged"] .jcx-gfile:nth-child(1) .jcx-gfile-head');
  s = await js('__sent.filter((m) => m.type === "code_git_file").map((m) => m.path + " " + m.staged)');
  assert(JSON.stringify(s) === '["b.py false"]', JSON.stringify(s));
  await js(`__ev({ type: 'code_git_file', key: 'id:1', path: 'b.py', staged: false, file: { path: 'b.py', hunks: [{ id: 'g1', n: 0, old_start: 1, old_count: 1, new_start: 1, new_count: 1, line: 1, where: '', header: '', lines: [['-', 'b'], ['+', 'b2']], cut: 0 }] } })`);
  await clickText('.jcx-gfile', 'Stage this');
  s = await js('__sent.filter((m) => m.type === "code_git_hunk").map((m) => m.path + " " + m.hunk + " " + m.staged)');
  assert(JSON.stringify(s) === '["b.py g1 false"]', JSON.stringify(s));
  // The message: Claude's, then the owner's edits; Commit sends what's in the box.
  await js('__sent.length = 0');
  await clickText('.jcx-gcommit', 'Write it');
  assert((await js('__sent.map((m) => m.type)')).includes('code_git_message'), 'no message asked for');
  assert(await js('document.querySelector(".jcx-gcommit button").textContent') === 'Writing…', 'no sign it’s writing');
  await js(`__ev({ type: 'code_git_message', key: 'id:1', text: 'Make retries back off', note: '' })`);
  assert(await js('document.querySelector(".jcx-gcommit textarea").value') === 'Make retries back off', 'the message wasn’t put in');
  await js('document.querySelector(".jcx-gcommit textarea").focus()');
  await typeText(' exponentially');
  await clickText('.jcx-gcommit', 'Commit');
  s = await js('__sent.filter((m) => m.type === "code_git_commit").map((m) => m.message)');
  assert(JSON.stringify(s) === '["Make retries back off exponentially"]', JSON.stringify(s));
  await js(`__ev({ type: 'code_git_committed', key: 'id:1', sha: 'def5678' })`);
  assert(await js('document.querySelector(".jcx-gcommit textarea").value') === '', 'the message stayed after the commit');
  // Branches and the push.
  await js('__sent.length = 0; (() => { const menu = document.querySelector(".jcx-gbranch select"); menu.value = "topic"; menu.dispatchEvent(new Event("change")); })()');
  await clickText('.jcx-gbranch', 'New branch…');
  await frames(2);
  await typeText('feature/x');
  await press('Enter');
  await clickText('.jcx-gbranch', 'Push');
  s = await js('__sent.filter((m) => m.type.startsWith("code_git_")).map((m) => m.type + " " + (m.name || "") + " " + (m.create || false))');
  assert(JSON.stringify(s) === JSON.stringify(['code_git_branch topic false', 'code_git_branch feature/x true', 'code_git_push  false']), JSON.stringify(s));
  // A second click on the toolbar button closes the pane.
  await clickIn('.jc-tool[data-pane="git"]');
  assert(await js('$("jc-pane").hidden'), 'the Git button didn’t close its pane');
});

test('Review: findings are listed, pinned under their lines, and handed to the session', async () => {
  await open(1);
  await loadFeatures('code_changes.js', 'code_diff.js', 'code_review.js', 'code_review.css');
  await js(`openPane("diff"); __ev(${HUNK_VIEW()})`);
  let s = await js('__sent.filter((m) => m.type === "code_review_state").map((m) => m.id)');
  assert(JSON.stringify(s) === '[1]', JSON.stringify(s));
  await js('__sent.length = 0');
  await clickText('.jcx-rbar', 'Review');
  await clickText('.jcx-rbar', 'Deep review');
  s = await js('__sent.filter((m) => m.type === "code_review").map((m) => m.deep)');
  assert(JSON.stringify(s) === '[false,true]', JSON.stringify(s));
  await js(`__ev({ type: 'code_review', id: 1, status: 'running', deep: true, findings: [], note: 'Reviewing deeply…' })`);
  assert(await js('[...document.querySelectorAll(".jcx-rbar button")].every((b) => b.disabled)'), 'Review stayed pressable while running');
  await js(`__ev({ type: 'code_review', id: 1, status: 'done', deep: true, note: '2 findings.', findings: [
    { id: 'f1', severity: 'high', file: 'src/app.py', line: 2, title: 'quantity can be <b>None</b>', detail: 'When the cart is empty.', fix: 'Default it to 0.' },
    { id: 'f2', severity: 'low', file: 'src/app.py', line: 0, title: 'A whole-file note', detail: '', fix: '' } ] })`);
  const r = await js(`({ listed: [...document.querySelectorAll('.jcx-flist li .jcx-ftitle')].map((n) => n.textContent),
    pinned: [...document.querySelectorAll('.jcx-finding')].map((n) => n.dataset.finding),
    under: (() => { const row = document.querySelector('[data-hunk="h1"] .jcx-row[data-side="n"][data-line="2"]'); return row && row.nextElementSibling && row.nextElementSibling.dataset.finding; })(),
    html: document.querySelectorAll('.jcx-review b, .jcx-finding b').length, fix: document.querySelector('.jcx-ffix').textContent })`);
  assert(JSON.stringify(r.listed) === JSON.stringify(['quantity can be <b>None</b>', 'A whole-file note']), JSON.stringify(r));
  assert(JSON.stringify(r.pinned) === '["f1"]' && r.under === 'f1' && r.html === 0 && r.fix === 'Suggested fixDefault it to 0.', JSON.stringify(r));
  await js('__sent.length = 0');
  await clickText('.jcx-finding', 'Fix this');
  await clickText('.jcx-rbar', 'Fix all');
  await clickText('.jcx-flist li:nth-child(2)', 'Dismiss');
  s = await js('__sent.filter((m) => m.type.startsWith("code_review_")).map((m) => m.type + " " + (m.finding || "") + " " + (m.all || false))');
  assert(JSON.stringify(s) === JSON.stringify(['code_review_fix f1 false', 'code_review_fix  true', 'code_review_dismiss f2 false']), JSON.stringify(s));
});

test('Best of N: set up two or three variants, compare them, keep one', async () => {
  await open(1);
  await loadFeatures('code_bestof.js', 'code_bestof.css');
  await js('$("deck-input").value = "fix the flaky test"; $("jc-more").click()');
  assert(await clickText('#jc-menu', 'Best of N…'), 'no Best of N in the More menu');
  const form = await js(`({ prompt: document.querySelector('.jcx-bprompt').value,
    picks: [...document.querySelectorAll('.jcx-bvariant select')].map((s) => s.value) })`);
  assert(form.prompt === 'fix the flaky test' && JSON.stringify(form.picks) === '["sonnet","","opus",""]', JSON.stringify(form));
  await clickText('.jcx-bestof', 'Add a third');
  await js(`(() => { const [, , , , model, effort] = document.querySelectorAll('.jcx-bvariant select'); model.value = 'haiku'; model.dispatchEvent(new Event('change')); effort.value = 'max'; effort.dispatchEvent(new Event('change'));
    const tests = document.querySelector('.jcx-bfield input'); tests.value = 'npm test'; tests.dispatchEvent(new Event('input')); })()`);
  await js('__sent.length = 0');
  await clickText('.jcx-bestof', 'Start');
  const started = await js('__sent.filter((m) => m.type === "code_bestof")');
  assert(started.length === 1 && started[0].directory === 'alpha' && started[0].mode === 'edits' && started[0].tests === 'npm test', JSON.stringify(started));
  assert(JSON.stringify(started[0].variants) === JSON.stringify([{ model: 'sonnet', effort: '' }, { model: 'opus', effort: '' }, { model: 'haiku', effort: 'max' }]), JSON.stringify(started[0].variants));
  const group = (status, extra = {}) => JSON.stringify({ type: 'code_bestof', group: 'b1', project: 'alpha', prompt: 'fix the flaky test', tests: 'npm test', status, judge: '', kept: 0, started: 1,
    variants: [{ n: 1, label: 'Sonnet 5.5', task_id: 1, slug: 's1', status: 'working', stats: {}, test: null }, { n: 2, label: 'Opus 5.5', task_id: 2, slug: 's2', status: 'working', stats: {}, test: null }], ...extra });
  await js(`__ev(${group('running')})`);
  assert(await js('document.querySelectorAll(".jcx-bcard").length === 2 && ![...document.querySelectorAll(".jcx-bcard button")].some((b) => b.textContent === "Keep this one")'), 'Keep offered before they finished');
  await js(`__ev(${group('done', { judge: 'Opus <b>wins</b>: its fix is smaller.', variants: [
    { n: 1, label: 'Sonnet 5.5', task_id: 1, slug: 's1', status: 'done', stats: { files: 2, added: 9, removed: 1 }, test: { code: 1, tail: 'FAIL x' } },
    { n: 2, label: 'Opus 5.5', task_id: 2, slug: 's2', status: 'done', stats: { files: 1, added: 3, removed: 1 }, test: { code: 0, tail: 'ok' } }] })})`);
  const shown = await js(`({ judge: document.querySelector('.jcx-bjudge span').textContent, bold: document.querySelectorAll('.jcx-bjudge b').length,
    stats: [...document.querySelectorAll('.jcx-bstats')].map((n) => n.textContent), tests: [...document.querySelectorAll('.jcx-btest .jcx-chip')].map((n) => n.textContent) })`);
  assert(shown.judge === 'Opus <b>wins</b>: its fix is smaller.' && shown.bold === 0, JSON.stringify(shown));
  assert(JSON.stringify(shown.stats) === '["2 files +9 −1","1 file +3 −1"]' && JSON.stringify(shown.tests) === '["tests failed (1)","tests passed"]', JSON.stringify(shown));
  await js('__sent.length = 0');
  await clickText('.jcx-bcard:nth-child(2)', 'Keep this one');
  const kept = await js('__sent.filter((m) => m.type === "code_bestof_keep")');
  assert(kept.length === 1 && kept[0].group === 'b1' && kept[0].n === 2, JSON.stringify(kept));
});

// ── the automation feature (web/features/automation.js), loaded as features.js would ──

const automationJs = fs.readFileSync(path.join(WEB, 'features', 'automation.js'), 'utf8');
const withAutomation = () => js(`${automationJs}; true`);
const ROUTINES = `[
  { id: 'a', name: 'Build', prompt: 'Check the build', kind: 'interval', enabled: true,
    when: 'every 30 minutes, 9 AM to 6 PM', when_zh: '上午9点到晚上6点之间每30分钟',
    next_run: new Date(Date.now() + 3600e3).toISOString() },
  { id: 'b', name: 'Rent <b>now</b>', prompt: 'Pay rent', kind: 'monthly', enabled: false,
    when: 'monthly on the last day at 5 PM', when_zh: '每月最后一天下午5点', next_run: '' },
]`;

test('Routines show their schedule in the window’s language and their next run; buttons send', async () => {
  await withAutomation();
  assert(JSON.stringify(await sentOf('automation_state')) === JSON.stringify([{ type: 'automation_state' }]), 'no state asked for');
  await js(`featureEvent({ type: 'routines', items: ${ROUTINES} })`);
  const rows = await js('[...$("routine-list").children].map((li) => li.textContent)');
  assert(rows.length === 2 && rows[0].includes('Build') && rows[0].includes('every 30 minutes, 9 AM to 6 PM') && rows[0].includes('Next run'), JSON.stringify(rows));
  assert(rows[1].includes('Rent <b>now</b>') && rows[1].includes('paused') && !rows[1].includes('Next run'), rows[1]);
  assert(await js('!$("routine-list").querySelector("b")'), 'a name became markup');
  assert(await clickText('#routine-list li[data-id="a"]', 'Run now'), 'no Run now');
  await js('$("routine-list").querySelector(\'li[data-id="b"] .switch\').click()');
  assert(await clickText('#routine-list li[data-id="b"]', 'Delete'), 'no Delete');
  const s = await js('__sent.filter((m) => m.type.startsWith("routine_"))');
  assert(JSON.stringify(s) === JSON.stringify([{ type: 'routine_run', id: 'a' }, { type: 'routine_toggle', id: 'b', enabled: true }, { type: 'routine_delete', id: 'b' }]), JSON.stringify(s));
  await js(`featureEvent({ type: 'prefs', language: 'zh' })`);
  const zh = await js('[...$("routine-list").querySelectorAll(".auto-when bdi")].map((b) => b.textContent)');
  assert(zh[0] === '上午9点到晚上6点之间每30分钟' && zh.includes('每月最后一天下午5点'), JSON.stringify(zh));
  // A hello from a restarted backend redraws from what it says, and asks for the rest.
  await js(`featureEvent({ type: 'hello', prefs: { language: 'en' }, routines: [] })`);
  assert(await js('$("routine-list").textContent') === 'No routines yet.', 'the old routines stayed');
  assert((await sentOf('automation_state')).length === 2, 'the hello asked for no state');
});

test('Timers & reminders list what’s set with live countdowns; ringing ones stop or snooze', async () => {
  await withAutomation();
  await js('toggleSettings(true)');
  const at = (seconds) => `new Date(Date.now() + ${seconds} * 1000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19)`;
  await js(`featureEvent({ type: 'automation', timers: { ringing: ['al1'], items: [
    { id: 'al1', kind: 'alarm', label: 'wake <i>up</i>', due: ${at(-5)}, ringing: true, when: 'Alarm · 6:30 AM', when_zh: '闹钟 · 早上6:30' },
    { id: 'tm1', kind: 'timer', label: 'pasta', due: ${at(299.5)}, ringing: false, when: '5-minute timer', when_zh: '5分钟计时器' },
    { id: 'rm1', kind: 'reminder', label: 'stretch', due: ${at(1200)}, ringing: false, when: 'Every 20 minutes until 6 PM · next 3:50 PM', when_zh: '' },
  ] } })`);
  const group = await js('!!$("auto-timers") && $("auto-timers").previousElementSibling === $("routine-list").closest("section")');
  assert(group, 'the Timers group is not right after Routines');
  const rows = await js('[...$("auto-timer-list").children].map((li) => li.textContent)');
  assert(rows[0].includes('wake <i>up</i>') && rows[0].includes('Ringing') && rows[0].includes('Snooze') && rows[0].includes('Stop'), rows[0]);
  assert(/5:00|4:59/.test(rows[1]) && rows[1].includes('left') && rows[1].includes('Cancel'), rows[1]);
  assert(rows[2].includes('Every 20 minutes until 6 PM'), rows[2]);
  assert(await js('!$("auto-timer-list").querySelector("i")'), 'a label became markup');
  await sleep(1100);
  assert(/4:5\d/.test(await js('$("auto-timer-list").querySelector(".auto-left").textContent')), 'the countdown did not tick');
  assert(await clickText('#auto-timer-list li[data-id="al1"]', 'Stop'), 'no Stop');
  assert(await clickText('#auto-timer-list li[data-id="tm1"]', 'Cancel'), 'no Cancel');
  await js('$("sw-auto-alarm-phone").click()');
  const s = await js('__sent.filter((m) => m.type === "automation_timer" || m.type === "feature_prefs")');
  assert(JSON.stringify(s) === JSON.stringify([
    { type: 'automation_timer', action: 'stop', id: 'al1' },
    { type: 'automation_timer', action: 'cancel', id: 'tm1' },
    { type: 'feature_prefs', changes: { alarm_phone: true } },
  ]), JSON.stringify(s));
  await js(`featureEvent({ type: 'prefs', features: { alarm_phone: true } })`);
  assert(await js('$("sw-auto-alarm-phone").getAttribute("aria-checked")') === 'true', 'the switch did not follow the setting');
});

test('A ringing alarm’s card has Stop and Snooze; a reminder’s card has neither', async () => {
  await withAutomation();
  const ring = `{ type: 'alert', key: 'alarm:ab12cd:063000', alert_kind: 'alarm', title: 'Alarm', text: 'It’s 6:30 AM.' }`;
  await js(`onEvent(${ring}); featureEvent(${ring})`);
  const card = await js('(() => { const c = $("cards").lastElementChild; return { kicker: c.querySelector(".card-kicker").textContent, buttons: [...c.querySelectorAll("button")].map((b) => b.textContent) }; })()');
  assert(card.kicker === 'Alarm' && JSON.stringify(card.buttons) === JSON.stringify(['Snooze', 'Stop', 'Dismiss']), JSON.stringify(card));
  await clickText('#cards [data-ring="ab12cd"]', 'Stop');
  assert(await js('!$("cards").querySelector("[data-ring]")'), 'the card stayed');
  const note = `{ type: 'alert', key: 'reminder:rm1:155000', alert_kind: 'reminder', title: 'Reminder', text: 'Reminder: stretch.' }`;
  await js(`onEvent(${note}); featureEvent(${note})`);
  const buttons = await js('[...$("cards").lastElementChild.querySelectorAll("button")].map((b) => b.textContent)');
  assert(JSON.stringify(buttons) === JSON.stringify(['Dismiss']), JSON.stringify(buttons));
  const s = await js('__sent.filter((m) => m.type === "automation_timer")');
  assert(JSON.stringify(s) === JSON.stringify([{ type: 'automation_timer', action: 'stop', id: 'ab12cd' }]), JSON.stringify(s));
});

test('A routine’s “How it runs” sets its job, takes back standing orders and shows its runs', async () => {
  await withAutomation();
  await js('toggleSettings(true)');
  const routine = `{ id: 'j1', name: 'Inbox', prompt: 'Check my inbox', kind: 'daily', enabled: true, when: 'every day at 9 AM',
    when_zh: '每天上午9点', next_run: '', own: true, model: 'haiku', tools: 'normal', deliver: 'file',
    may: ['notify', 'message:Ann'], may_words: ['notify you', 'message Ann'], may_words_zh: ['通知你', '给Ann发消息'] }`;
  await js(`featureEvent({ type: 'automation', routines: [${routine}], running: {}, last_runs: { j1: { status: 'failed' } } })`);
  const summary = await js('$("routine-list").querySelector("li[data-id=\\"j1\\"] summary").textContent');
  assert(summary === 'How it runsOn its own · Haiku · can act · to a file', summary);
  assert(await js('$("routine-list").textContent.includes("Last run failed")'), 'no failed last run');
  await js('$("routine-list").querySelector("li[data-id=\\"j1\\"] details").open = true');
  await sleep(50);
  assert((await sentOf('automation_history')).length === 1, 'opening did not ask for the runs');
  await js(`featureEvent({ type: 'automation_history', id: 'j1', runs: [{ at: new Date().toISOString(), cause: 'Scheduled', status: 'failed', output: '', note: 'It broke <b>x</b>' }] })`);
  const runs = await js('$("routine-list").querySelector(".auto-runs").textContent');
  assert(runs.includes('Scheduled') && runs.includes('Failed') && runs.includes('It broke <b>x</b>'), runs);
  await js(`(() => { const s = $("routine-list").querySelector('select[aria-label="Model"]'); s.value = 'sonnet'; s.dispatchEvent(new Event('change')); })()`);
  await js(`$("routine-list").querySelector('.auto-job .switch').click()`);
  await js(`$("routine-list").querySelector('.auto-chip-x[aria-label="Take back: message Ann"]').click()`);
  const s = await js('__sent.filter((m) => m.type === "automation_job" || m.type === "automation_unmay")');
  assert(JSON.stringify(s) === JSON.stringify([
    { type: 'automation_job', id: 'j1', model: 'sonnet' },
    { type: 'automation_job', id: 'j1', own: false },
    { type: 'automation_unmay', id: 'j1', grant: 'message:Ann' },
  ]), JSON.stringify(s));
  // Redrawn (a run began): still open, still showing its runs.
  await js(`featureEvent({ type: 'automation', running: { j1: 'now' } })`);
  const after = await js('({ open: $("routine-list").querySelector("details").open, runs: $("routine-list").querySelector(".auto-runs").textContent, busy: $("routine-list").textContent.includes("Running…") })');
  assert(after.open && after.runs.includes('Scheduled') && after.busy, JSON.stringify(after));
  // In Chinese the standing orders are the backend's Chinese words.
  await js(`featureEvent({ type: 'prefs', language: 'zh' })`);
  assert(await js('$("routine-list").querySelector(".auto-chip span").textContent') === '通知你', 'the standing order stayed in English');
});

test('Email rules: added from Settings, listed by what starts them, after Timers', async () => {
  await withAutomation();
  await js('toggleSettings(true)');
  const order = await js('[...$("settings").querySelectorAll("section.group")].map((g) => (g.querySelector("h3") || {}).textContent).filter((t) => ["Routines", "Timers & reminders", "Email rules"].includes(t))');
  assert(JSON.stringify(order) === JSON.stringify(['Routines', 'Timers & reminders', 'Email rules']), JSON.stringify(order));
  assert(await js('$("auto-email-list").textContent') === 'No email rules yet.', 'no empty line');
  await js(`(() => { const f = $("auto-email").querySelector("form"); const put = (n, v) => { f.querySelector('[name="' + n + '"]').value = v; };
    put('from', ' Ann '); put('then', 'tell me what she needs'); f.querySelector("select").value = 'card'; f.requestSubmit(); return true; })()`);
  await js(`(() => { $("auto-email").querySelector("form").requestSubmit(); return true; })()`);  // nothing said: not sent
  const s = await sentOf('automation_email_rule');
  assert(JSON.stringify(s) === JSON.stringify([{ type: 'automation_email_rule', from: 'Ann', subject: '', then: 'tell me what she needs', deliver: 'card' }]), JSON.stringify(s));
  await js(`featureEvent({ type: 'routines', items: [
    { id: 'e1', name: 'Email from Ann', prompt: 'Tell me what she needs', kind: 'event', enabled: true, when: 'when an email from Ann arrives', when_zh: '收到Ann的邮件时', spec: { trigger: { type: 'mail', from: 'Ann', subject: '' } } },
    { id: 'd1', name: 'Brief', prompt: 'Brief me', kind: 'daily', enabled: true, when: 'every day at 7 AM', when_zh: '每天早上7点', spec: {} } ] })`);
  const rules = await js('[...$("auto-email-list").children].map((li) => li.textContent)');
  assert(rules.length === 1 && rules[0].includes('when an email from Ann arrives') && rules[0].includes('Tell me what she needs'), JSON.stringify(rules));
  assert(await clickText('#auto-email-list li[data-id="e1"]', 'Delete'), 'no Delete');
  assert(JSON.stringify(await sentOf('routine_delete')) === JSON.stringify([{ type: 'routine_delete', id: 'e1' }]), 'Delete sent nothing');
  assert((await js('$("routine-list").children.length')) === 2, 'the rule should be in Routines too');
});

test('Check-ins: on or off, how often, active hours and the checklist go to the settings; what they said shows', async () => {
  await withAutomation();
  await js('toggleSettings(true)');
  await js(`featureEvent({ type: 'prefs', features: { heartbeat_on: false, heartbeat_minutes: 60, heartbeat_hours: '09:00-21:00', heartbeat_checklist: 'Ann’s reply' } })`);
  const shown = await js('({ on: $("sw-auto-checkins").getAttribute("aria-checked"), every: $("auto-checkin-minutes").value, start: $("auto-checkin-start").value, end: $("auto-checkin-end").value, list: $("auto-checklist").value, off: $("auto-checkins").classList.contains("off") })');
  assert(JSON.stringify(shown) === JSON.stringify({ on: 'false', every: '60', start: '09:00', end: '21:00', list: 'Ann’s reply', off: true }), JSON.stringify(shown));
  await js('$("sw-auto-checkins").click()');
  await js(`(() => { const s = $("auto-checkin-minutes"); s.value = '30'; s.dispatchEvent(new Event('change')); return true; })()`);
  await js(`(() => { const e = $("auto-checkin-end"); e.value = '08:00'; e.dispatchEvent(new Event('change')); e.value = '22:30'; e.dispatchEvent(new Event('change')); return true; })()`);
  await js(`(() => { const t = $("auto-checklist"); t.value = 'Ann’s reply\\nthe Acme contract'; t.dispatchEvent(new Event('change')); return true; })()`);
  await clickText('#auto-checkins', 'Check in now');
  const s = await js('__sent.filter((m) => m.type === "feature_prefs" || m.type === "automation_checkin_now")');
  assert(JSON.stringify(s) === JSON.stringify([
    { type: 'feature_prefs', changes: { heartbeat_on: true } },
    { type: 'feature_prefs', changes: { heartbeat_minutes: 30 } },
    { type: 'feature_prefs', changes: { heartbeat_hours: '09:00-22:30' } },  // 09:00-08:00 isn't a day
    { type: 'feature_prefs', changes: { heartbeat_checklist: 'Ann’s reply\nthe Acme contract' } },
    { type: 'automation_checkin_now' },
  ]), JSON.stringify(s));
  const at = new Date().toISOString();
  await js(`featureEvent({ type: 'automation', checkins: { today: 3, cap: 24, running: false, last: [
    { at: '${at}', outcome: 'said', said: 'Ann replied: <b>sign today</b>.' }, { at: '${at}', outcome: 'quiet', said: '' } ] } })`);
  const status = await js('$("auto-checkin-status").textContent');
  assert(status.includes('Last check-in') && status.includes('Told you') && status.includes('3/24'), status);
  const said = await js('[...$("auto-checkin-list").children].map((li) => li.textContent)');
  assert(said.length === 1 && said[0].includes('Ann replied: <b>sign today</b>.'), JSON.stringify(said));
  assert(await js('!$("auto-checkin-list").querySelector("b")'), 'what it said became markup');
});

test('Webhooks: each one’s address, its token to copy, a new token, what it does; tokens never shown', async () => {
  await withAutomation();
  await js('toggleSettings(true)');
  assert((await sentOf('automation_origin'))[0].origin === base, 'the window did not say its address');
  await js(`featureEvent({ type: 'routines', items: [{ id: 'r1', name: 'Deploys', prompt: 'p', kind: 'daily', enabled: true, when: 'every day at 9 AM', spec: {} }] })`);
  await js(`featureEvent({ type: 'automation', webhooks: { url_file: '/Users/x/Library/Application Support/Jarvis/webhooks-address.txt',
    items: [{ name: 'ci', routine: '', note: '', per_hour: 30, calls: [{ at: new Date().toISOString(), status: 'accepted', bytes: 12 }] }] } })`);
  const row = await js('$("auto-hook-list").querySelector("li").textContent');
  assert(row.includes(`${base}/hooks/ci`) && row.includes('Accepted'), row);
  assert((await js('$("auto-hook-where").textContent')).includes('webhooks-address.txt'), 'no address file');
  await clickText('#auto-hook-list', 'Copy token');
  await js(`featureEvent({ type: 'automation_webhook_token', name: 'ci', token: 'tok-123' })`);
  await sleep(50);
  const label = await js('$("auto-hook-list").querySelector("button[data-name=\\"ci\\"]").textContent');
  assert(['Copied', 'Couldn’t copy'].includes(label), label);
  assert(!(await js('document.body.textContent.includes("tok-123")')), 'the token was shown');
  await js(`(() => { const s = $("auto-hook-list").querySelector("select"); s.value = 'r1'; s.dispatchEvent(new Event('change')); return true; })()`);
  await clickText('#auto-hook-list', 'New token');
  await clickText('#auto-hook-list', 'Delete');
  await js(`(() => { const f = $("auto-webhooks").querySelector("form"); f.querySelector("input").value = 'CI builds'; f.requestSubmit(); f.querySelector("input").value = 'no/slash'; f.requestSubmit(); return true; })()`);
  const s = await sentOf('automation_webhook');
  assert(JSON.stringify(s) === JSON.stringify([
    { type: 'automation_webhook', action: 'token', name: 'ci' },
    { type: 'automation_webhook', action: 'update', name: 'ci', routine: 'r1' },
    { type: 'automation_webhook', action: 'regenerate', name: 'ci' },
    { type: 'automation_webhook', action: 'delete', name: 'ci' },
    { type: 'automation_webhook', action: 'add', name: 'ci-builds' },
  ]), JSON.stringify(s));
});

test('Script hooks: what was found and each one’s say, the folder, the last runs', async () => {
  await withAutomation();
  await js('toggleSettings(true)');
  await js(`featureEvent({ type: 'automation', scripts: { folder: '/Users/x/Library/Application Support/Jarvis/hooks', scripts: [
    { path: 'arrive/lights.sh', event: 'arrive', state: 'new', problem: '' },
    { path: 'heads-up/log.sh', event: 'heads-up', state: 'allowed', problem: '' },
    { path: 'wake/x.sh', event: 'wake', state: 'problem', problem: "it isn't executable (chmod +x)" } ],
    runs: [{ at: new Date().toISOString(), path: 'heads-up/log.sh', status: 'exit 3', output: '<b>boom</b>' }] } })`);
  const rows = await js('[...$("auto-script-list").children].map((li) => [li.dataset.path, [...li.querySelectorAll("button")].map((b) => b.textContent)])');
  assert(JSON.stringify(rows) === JSON.stringify([
    ['arrive/lights.sh', ['Allow', 'Don’t']],
    ['heads-up/log.sh', ['Don’t']],
    ['wake/x.sh', []],
  ]), JSON.stringify(rows));
  assert((await js('$("auto-scripts").textContent')).includes('it isn\'t executable'), 'the problem is not said');
  assert((await js('$("auto-script-runs").textContent')).includes('<b>boom</b>') && await js('!$("auto-script-runs").querySelector("b")'), 'output became markup');
  await clickText('#auto-script-list li[data-path="arrive/lights.sh"]', 'Allow');
  await clickText('#auto-script-list li[data-path="heads-up/log.sh"]', 'Don’t');
  await clickText('#auto-scripts', 'Open the folder');
  await clickText('#auto-scripts', 'Look again');
  const s = await sentOf('automation_scripts');
  assert(JSON.stringify(s) === JSON.stringify([
    { type: 'automation_scripts', action: 'allow', path: 'arrive/lights.sh' },
    { type: 'automation_scripts', action: 'deny', path: 'heads-up/log.sh' },
    { type: 'automation_scripts', action: 'open' },
    { type: 'automation_scripts', action: 'scan' },
  ]), JSON.stringify(s));
});

// ── Jarvis Code checks (web/features/code-verify.js) ──

// A feature module's script, loaded into this test's page (features.js has no backend to ask).
const featureScript = (name) => js(`new Promise((resolve, reject) => {
  const s = document.createElement('script');
  s.src = '/static/features/${name}';
  s.onload = () => resolve(true);
  s.onerror = () => reject(new Error('no ${name}'));
  document.body.append(s);
})`);

test('The Preview pane lists dev servers and suggestions as text, and its buttons say what to do', async () => {
  await featureScript('code-verify.js');
  await open(1);
  await clickAt('#jc-more');
  assert(await clickText('#jc-menu', 'Preview and dev servers'), 'no Preview item in the More menu');
  assert(await js('$("jc-pane-title").textContent') === 'Preview', 'the pane did not open');
  let s = await js('__sent');
  assert(s.some((m) => m.type === 'cv_state' && m.id === 1), JSON.stringify(s));
  const path = '/Users/x/Projects/alpha';
  await deliver({ type: 'cv_state', project: 'alpha', path, id: 1, session: { verify: false },
    configs: [{ name: 'web', command: 'npm run dev', port: 5173, url: 'http://localhost:5173/', cwd: '', source: '.claude/launch.json', why: '' },
      { name: '<img src=x onerror="window.__pwned=1">', command: 'uv run app.py', port: null, url: '', cwd: 'api', source: '.claude/launch.json', why: '' }],
    suggestions: [{ name: 'static', command: 'python3 -m http.server 8000 --bind 127.0.0.1', port: 8000, url: 'http://localhost:8000/', cwd: '', source: '', why: 'index.html: a static site' }],
    problems: ['.jarvis/launch.json isn’t valid JSON (line 3).'], servers: [] });
  await deliver({ type: 'devservers', items: [{ key: `${path}::web`, project: path, name: 'web', command: 'npm run dev', status: 'ready', port: 5173, url: 'http://localhost:5173/', message: '', started_by: null, lines: 4 }] });
  const r = await js(`({
    rows: [...document.querySelectorAll('#jc-pane-body .cv-server:not(.cv-suggestion) strong')].map((n) => n.textContent),
    link: (document.querySelector('#jc-pane-body .cv-link') || {}).textContent,
    chips: [...document.querySelectorAll('#jc-pane-body .cv-chip')].map((n) => n.textContent),
    imgs: document.querySelectorAll('#jc-pane-body img').length, pwned: !!window.__pwned,
    text: $('jc-pane-body').textContent })`);
  assert(r.rows.length === 2 && r.rows[1].includes('<img') && r.imgs === 0 && !r.pwned, JSON.stringify(r));
  assert(r.link === 'localhost:5173' && r.chips.join() === 'Running,Not running', JSON.stringify(r));
  assert(r.text.includes('isn’t valid JSON') && r.text.includes('index.html: a static site'), r.text);
  await js('__sent.length = 0; true');
  assert(await clickText('#jc-pane-body .cv-server:nth-child(2)', 'Start'), 'no Start on a stopped server');
  assert(await clickText('#jc-pane-body .cv-server:nth-child(1)', 'Stop'), 'no Stop on a running server');
  assert(await clickText('#jc-pane-body .cv-suggestion', 'Save'), 'no Save on a suggestion');
  s = await js('__sent');
  const want = [{ type: 'cv_server', action: 'start', name: '<img src=x onerror="window.__pwned=1">', id: 1 },
    { type: 'cv_server', action: 'stop', key: `${path}::web` }, { type: 'cv_save', name: 'static', id: 1 }];
  assert(JSON.stringify(s) === JSON.stringify(want), JSON.stringify(s));
});

test('A dev server’s logs show its output as it comes, once each line', async () => {
  await featureScript('code-verify.js');
  await open(1);
  await js('jarvisFeatures.openPane("cv-preview"); true');
  const path = '/Users/x/Projects/alpha';
  const key = `${path}::web`;
  await deliver({ type: 'cv_state', project: 'alpha', path, id: 1, session: null, problems: [], suggestions: [],
    configs: [{ name: 'web', command: 'npm run dev', port: 5173, url: '', cwd: '', source: '.claude/launch.json', why: '' }], servers: [] });
  await deliver({ type: 'devservers', items: [{ key, project: path, name: 'web', command: 'npm run dev', status: 'exited', port: null, url: '', message: 'It exited with code 1.', started_by: null, lines: 2 }] });
  await js('__sent.length = 0; true');
  assert(await clickText('#jc-pane-body .cv-server', 'Logs'), 'no Logs button');
  assert(JSON.stringify(await js('__sent')) === JSON.stringify([{ type: 'cv_logs', key, since: 0 }]), JSON.stringify(await js('__sent')));
  await deliver({ type: 'cv_logs', key, lines: [[1, '$ npm run dev'], [2, 'Error: port 5173 is in use']] });
  await deliver({ type: 'devserver_log', key, lines: [[2, 'Error: port 5173 is in use'], [3, '<b>bold?</b>']] });
  await frames(2);
  const text = await js('$("cv-log").textContent');
  assert(text === '$ npm run dev\nError: port 5173 is in use\n<b>bold?</b>', JSON.stringify(text));
  assert(await js('$("jc-pane-body").textContent.includes("It exited with code 1.")'), 'no exit message');
});

test('The Tests pane shows failures as a tree, runs one test again, and sends the failures on', async () => {
  await featureScript('code-verify.js');
  await open(1);
  await clickAt('#jc-more');
  assert(await clickText('#jc-menu', 'Tests'), 'no Tests item in the More menu');
  const path = '/Users/x/Projects/alpha';
  const run = { project: path, suite: 'pytest', label: 'pytest', target: {}, status: 'failed', started: 1, seconds: 3.4, message: '',
    summary: '1 passed · 1 failed', counts: { passed: 1, failed: 1, skipped: 0 }, complete: true, lines: 3, watch: false,
    tree: [{ file: 'tests/test_math.py', failed: 1, passed: 1, skipped: 0, cases: [
      { file: 'tests/test_math.py', name: 'test_<b>sub</b>', status: 'failed', message: 'assert 2 == 1', line: 5, target: 'tests/test_math.py::test_sub' },
      { file: 'tests/test_math.py', name: 'test_add', status: 'passed', message: '', line: 1, target: 'tests/test_math.py::test_add' }] }],
    output: [[1, '$ python -m pytest'], [2, 'FAILED tests/test_math.py::test_sub']] };
  await deliver({ type: 'cv_tests', project: 'alpha', path, id: 1, files: { 'pytest::': ['tests/test_math.py'] }, watch: null, run,
    suites: [{ key: 'pytest::', id: 'pytest', label: 'pytest', command: 'uv run python -m pytest', cwd: '', ready: true, why: 'pyproject.toml', files: true }] });
  const r = await js(`({ cases: [...document.querySelectorAll('#jc-pane-body .cv-case-name')].map((n) => n.textContent),
    bolds: document.querySelectorAll('#jc-pane-body .cv-case-name b').length,
    line: document.querySelector('#jc-pane-body .cv-runline').textContent, msg: document.querySelector('#jc-pane-body .cv-case-msg').textContent })`);
  assert(r.cases.join() === 'test_<b>sub</b>,test_add' && r.bolds === 0, JSON.stringify(r));
  assert(r.line.includes('1 passed · 1 failed · 3.4 s') && r.msg === 'assert 2 == 1', JSON.stringify(r));
  await js('__sent.length = 0; true');
  assert(await clickText('#jc-pane-body .cv-case.failed', 'Run'), 'no Run on a failed test');
  assert(await clickText('#jc-pane-body .cv-runline', 'Fix failures'), 'no Fix failures');
  const s = await js('__sent');
  assert(JSON.stringify(s) === JSON.stringify([{ type: 'cv_tests', action: 'run', suite: 'pytest::', test: 'tests/test_math.py::test_sub', file: 'tests/test_math.py', id: 1 },
    { type: 'cv_tests', action: 'fix', id: 1 }]), JSON.stringify(s));
  // A new run clears the output shown, which then fills as it comes.
  await deliver({ type: 'cv_tests_run', run: { ...run, status: 'running', started: 2, summary: '', counts: null, tree: [], output: undefined } });
  await deliver({ type: 'cv_tests_out', project: path, lines: [[1, '$ python -m pytest'], [2, 'collected 2 items']] });
  await frames(2);
  assert(await js('$("cv-test-log").textContent') === '$ python -m pytest\ncollected 2 items', await js('$("cv-test-log").textContent'));
  assert(await js('!!document.querySelector("#jc-pane-body .cv-bar button") && document.querySelector("#jc-pane-body .cv-bar button").textContent') === 'Stop', 'no Stop while it runs');
});

test('The Problems pane lists problems by file; one clicked is mentioned in the message', async () => {
  await featureScript('code-verify.js');
  await open(1);
  await js('jarvisFeatures.openPane("cv-problems"); $("deck-input").value = "look at"; true');
  const path = '/Users/x/Projects/alpha';
  await deliver({ type: 'cv_problems_state', project: 'alpha', path, id: 1, after_turn: false,
    checkers: [{ id: 'tsc', label: 'TypeScript', command: 'tsc --noEmit', ready: true, why: '', slow: false },
      { id: 'eslint', label: 'ESLint', command: 'eslint', ready: false, why: 'eslint isn’t installed', slow: false }],
    check: { project: path, status: 'done', started: 1, seconds: 2, errors: 1, after_turn: false,
      checkers: [{ id: 'tsc', label: 'TypeScript', count: 2, error: '' }],
      problems: [{ file: 'src/App.tsx', line: 12, col: 5, severity: 'error', message: 'Type <x> is wrong', source: 'tsc', code: 'TS2322' },
        { file: 'src/App.tsx', line: 30, col: 1, severity: 'warning', message: 'Unused', source: 'tsc', code: '' }] } });
  const r = await js(`({ files: [...document.querySelectorAll('#jc-pane-body .cv-file-name')].map((n) => n.textContent),
    rows: document.querySelectorAll('#jc-pane-body .cv-problem').length, line: document.querySelector('#jc-pane-body .cv-runline').textContent,
    off: [...document.querySelectorAll('#jc-pane-body .cv-checker.off')].map((n) => n.textContent) })`);
  assert(r.files.join() === 'src/App.tsx' && r.rows === 2 && r.line.includes('1 error · 1 warning') && r.off.join() === 'ESLint', JSON.stringify(r));
  await js('document.querySelector("#jc-pane-body .cv-problem").click(); true');
  assert(await js('$("deck-input").value') === 'look at @src/App.tsx#L12 ', await js('$("deck-input").value'));
  await js('__sent.length = 0; true');
  assert(await clickText('#jc-pane-body .cv-runline', 'Fix these'), 'no Fix these');
  await js('document.querySelector("#jc-pane-body .cv-switch .sw").click(); true');
  const s = await js('__sent');
  assert(JSON.stringify(s) === JSON.stringify([{ type: 'cv_problems', action: 'fix', id: 1 }, { type: 'cv_session', id: 1, problems: true }]), JSON.stringify(s));
});

test('The app’s page check reloads the dev server’s page, collects what went wrong and pictures it', async () => {
  const cvApp = require(path.join(__dirname, '..', '..', 'app', 'features', 'code-verify.js'));
  const page = '<!doctype html><title>Shop</title><h1>Shop</h1><script>console.error("TypeError: cart is undefined"); fetch("/api/items");</script>';
  const site = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page); return; }
    if (req.url === '/api/items') { res.writeHead(500); res.end('boom'); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${site.address().port}/`;
  let tab = null;
  try {
    const r = await cvApp.check({ url, settle: 600 });
    const seen = (r.errors || []).map((e) => `${e.kind}: ${e.text}`);
    assert(r.ok && r.source === 'preview' && r.title === 'Shop', JSON.stringify({ ...r, shot: undefined, thumb: undefined }));
    assert(seen.some((x) => x.startsWith('console: TypeError: cart is undefined')), seen.join(' | '));
    assert(seen.some((x) => x === `network: GET ${url}api/items → 500`), seen.join(' | '));
    assert(!seen.some((x) => x.includes('favicon')), 'the favicon’s 404 is noise');
    assert(Buffer.from(r.shot, 'base64').subarray(0, 2).toString('hex') === 'ffd8' && r.thumb, 'no JPEG picture');
    // Off this Mac: never opened.
    assert((await cvApp.check({ url: 'https://example.com/' })).error, 'a page off this Mac was checked');
    // The built-in browser's tab on the dev server: that's the one reloaded.
    tab = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:jarvis-browser', sandbox: true } });
    await tab.loadURL(url);
    const again = await cvApp.check({ url, settle: 600 });
    const inTab = (again.errors || []).map((e) => `${e.kind}: ${e.text}`);
    assert(again.ok && again.source === 'tab', JSON.stringify({ ...again, shot: undefined, thumb: undefined }));
    assert(inTab.some((x) => x.startsWith('console: TypeError: cart is undefined')), inTab.join(' | '));
    assert(again.shot, 'no picture of the tab (or the preview in its place)');
  } finally {
    if (tab) tab.destroy();
    cvApp.closeAll();
    site.close();
  }
});

test('A check in the transcript shows its picture and what it found as text, and opens larger', async () => {
  await featureScript('code-verify.js');
  await open(1);
  const thumb = 'QUJDRA==';
  await deliver({ type: 'task_log', id: 1, entry: { n: 7, role: 'verify', text: 'Preview check: 2 problems.', status: 'problems', url: 'http://localhost:5173/', title: 'Shop',
    thumb, proof: '0123456789abcdef', sent: true, why_not: '', by_owner: false, more: 0,
    findings: [{ kind: 'console', label: 'Page console', text: 'TypeError: <img src=x onerror="window.__pwned=1">', where: 'App.tsx:12' },
      { kind: 'server', label: 'Dev server', text: '[vite] Internal server error', where: '' }],
    tests: { label: 'vitest', summary: '12 passed · 1 failed', failed: 1 } } });
  await frames(2);
  const r = await js(`(() => { const li = document.querySelector('#deck-timeline .cv-check');
    return li && { text: li.textContent, imgs: li.querySelectorAll('img').length, src: li.querySelector('img').getAttribute('src'), pwned: !!window.__pwned, fix: !!li.querySelector('.cv-fix') }; })()`);
  assert(r && r.text.includes('Preview check') && r.text.includes('2 problems') && r.text.includes('<img src=x'), JSON.stringify(r));
  assert(r.imgs === 1 && r.src === `data:image/jpeg;base64,${thumb}` && !r.pwned, JSON.stringify(r));
  assert(r.text.includes('Sent to Jarvis Code to fix.') && r.text.includes('12 passed · 1 failed') && !r.fix, JSON.stringify(r));
  await js('__sent.length = 0; document.querySelector("#deck-timeline .cv-thumb").click(); true');
  assert(await js('!!document.querySelector(".cv-lightbox img")'), 'the picture did not open larger');
  assert(JSON.stringify(await js('__sent')) === JSON.stringify([{ type: 'cv_proof', proof: '0123456789abcdef' }]), JSON.stringify(await js('__sent')));
  await deliver({ type: 'cv_proof', proof: '0123456789abcdef', jpeg: 'RUZHSA==', missing: false });
  assert(await js('document.querySelector(".cv-lightbox img").getAttribute("src")') === 'data:image/jpeg;base64,RUZHSA==', 'the full picture did not replace the thumbnail');
  await js('__sent.length = 0; true');
  await press('Escape');
  assert(await js('!document.querySelector(".cv-lightbox")'), 'Esc did not close the picture');
  assert(!(await sent()).includes('task_interrupt'), 'Esc on the picture interrupted the session');
  // One not sent (a cap, or asked by the owner) offers to ask for the fix; a picture that isn't base64 is never shown.
  await deliver({ type: 'task_log', id: 1, entry: { n: 8, role: 'verify', text: 'Checks: 1 problem.', status: 'problems', url: '', thumb: '"><script>', proof: '',
    sent: false, why_not: 'Not sent: the last 2 checks already asked for fixes. Your next message starts over.', by_owner: false, more: 0,
    findings: [{ kind: 'problem', label: 'Checker', text: 'Type is wrong [TS2322]', where: 'src/a.ts:3' }] } });
  await frames(2);
  const last = await js(`(() => { const li = [...document.querySelectorAll('#deck-timeline .cv-check')].pop(); return { imgs: li.querySelectorAll('img').length, text: li.textContent }; })()`);
  assert(last.imgs === 0 && last.text.includes('Not sent: the last 2 checks') && last.text.includes('Checks'), JSON.stringify(last));
  await js('__sent.length = 0; true');
  assert(await clickText('#deck-timeline .cv-check:last-of-type', 'Ask Jarvis Code to fix these'), 'no Ask to fix');
  assert(JSON.stringify(await js('__sent')) === JSON.stringify([{ type: 'cv_fix_check', id: 1, n: 8 }]), JSON.stringify(await js('__sent')));
});

test('The Preview pane has the session’s check: its switch, Check now, and how the last one went', async () => {
  await featureScript('code-verify.js');
  await open(1);
  await js('jarvisFeatures.openPane("cv-preview"); __sent.length = 0; true');
  const path = '/Users/x/Projects/alpha';
  await deliver({ type: 'cv_state', project: 'alpha', path, id: 1, problems: [], suggestions: [], servers: [], configs: [],
    session: { verify: false, checking: false, last: { status: 'ok', at: 1, text: 'Preview check: no problems.', url: 'http://localhost:5173/', proof: '', thumb: '' } } });
  const text = await js('$("jc-pane-body").textContent');
  assert(text.includes('Check after each turn') && text.includes('Preview check: no problems.'), text);
  await js('document.querySelector("#jc-pane-body .cv-session .sw").click(); true');
  assert(await clickText('#jc-pane-body .cv-session', 'Check now'), 'no Check now');
  const s = await js('__sent');
  assert(JSON.stringify(s) === JSON.stringify([{ type: 'cv_session', id: 1, verify: true }, { type: 'cv_check', id: 1 }]), JSON.stringify(s));
  assert(await js('document.querySelector("#jc-pane-body .cv-session button.jc-btn").disabled'), 'Check now is not held while checking');
  await deliver({ type: 'cv_verify', id: 1, state: 'done', last: { status: 'problems', at: 2, text: 'Preview check: 1 problem.', url: '', proof: '', thumb: '' } });
  assert(await js('$("jc-pane-body").textContent.includes("Preview check: 1 problem.")'), 'the last check did not update');
});

test('Xcode’s tools are a switch in the More menu for a session in an Xcode project', async () => {
  await featureScript('code-verify.js');
  await js('__sent.length = 0; true');
  await open(1);
  // A session on show is asked about once (what its switches are).
  await deliver({ type: 'task_transcript', id: 1, entries: [] });
  await clickAt('#jc-more');
  let items = await js('[...document.querySelectorAll("#jc-menu .mi-label")].map((n) => n.textContent)');
  assert(!items.includes('Xcode’s tools'), 'offered before knowing the project is an Xcode one');
  await js('closeMenu(); true');
  await deliver({ type: 'cv_session', id: 1, verify: false, problems: false, xcode: false, xcode_project: true, mac: false });
  await clickAt('#jc-more');
  items = await js('[...document.querySelectorAll("#jc-menu .mi-label")].map((n) => n.textContent)');
  assert(items.includes('Xcode’s tools'), JSON.stringify(items));
  await js('__sent.length = 0; true');
  assert(await clickText('#jc-menu', await js('[...document.querySelectorAll("#jc-menu button")].find((b) => b.textContent.includes("Xcode’s tools")).textContent')), 'no switch');
  const s = await js('__sent');
  assert(JSON.stringify(s) === JSON.stringify([{ type: 'cv_session', id: 1, xcode: true }]), JSON.stringify(s));
  assert(!(await js('document.getElementById("jc-menu").hidden')), 'a switch closes the menu');
});

test('“Let this session use the Mac” is off until switched on, for the session on show', async () => {
  await featureScript('code-verify.js');
  await open(1);
  await clickAt('#jc-more');
  const row = () => js('(() => { const b = [...document.querySelectorAll("#jc-menu button")].find((x) => x.textContent.includes("Let this session use the Mac")); return b && { checked: b.getAttribute("aria-checked"), text: b.textContent }; })()');
  let mac = await row();
  assert(mac && mac.checked === 'false' && mac.text.includes('Every step asks, except in Bypass permissions.'), JSON.stringify(mac));
  await js('__sent.length = 0; true');
  assert(await clickText('#jc-menu', mac.text), 'no switch');
  assert(JSON.stringify(await js('__sent')) === JSON.stringify([{ type: 'cv_session', id: 1, mac: true }]), JSON.stringify(await js('__sent')));
  await js('closeMenu(); true');
  await deliver({ type: 'cv_session', id: 1, verify: false, problems: false, xcode: false, xcode_project: false, mac: true });
  await clickAt('#jc-more');
  mac = await row();
  assert(mac.checked === 'true', 'the switch does not show it on');
});

test('Settings has the switch for new sessions’ checks, kept as a feature setting', async () => {
  await featureScript('code-verify.js');
  await deliver({ type: 'prefs', look: 'orb', language: 'en', models: [], personas: [], humor: 50, features: { code_verify_new_sessions: true } });
  assert(await js('$("sw-cv-new-sessions").getAttribute("aria-checked")') === 'true', 'the setting is not shown');
  await js('toggleSettings(true); __sent.length = 0; $("sw-cv-new-sessions").click(); true');
  assert(JSON.stringify(await js('__sent')) === JSON.stringify([{ type: 'feature_prefs', changes: { code_verify_new_sessions: false } }]), JSON.stringify(await js('__sent')));
  assert(await js('$("sw-cv-new-sessions").closest("section").previousElementSibling.contains($("sw-code-narrate"))'), 'not beside Voice coding');
});

// ── Settings › Listening (web/features/voice.js) ──

// A feature module's window script, run in the page as features.js would run it (this
// harness serves only the window's top folder), with its stylesheet.
async function loadVoiceFeature(name) {
  const dir = path.join(WEB, 'features');
  const css = fs.existsSync(path.join(dir, `${name}.css`)) ? fs.readFileSync(path.join(dir, `${name}.css`), 'utf8') : '';
  await js(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(css)}; document.head.append(s); return true; })()`);
  await js(fs.readFileSync(path.join(dir, `${name}.js`), 'utf8') + '\n;true');
}

test('Listening sits after Voice, asks for its state and switches the detector', async () => {
  await loadVoiceFeature('voice');
  const place = await js(`(() => { const g = $('voice-listening'); return { after: g.previousElementSibling === $('mic-select').closest('section.group') }; })()`);
  assert(place.after, 'the Listening group is not right after Voice');
  await js('__sent.length = 0; featureEvent({ type: "hello" }); true');
  assert(JSON.stringify(await sent()) === '["voice_status"]', JSON.stringify(await sent()));
  await js('featureEvent({ type: "voice", detector: "neural", threshold: 0.5, neural_ok: true, neural_why: "" }); true');
  const r = await js(`({ checked: $('voice-detector').querySelector('[aria-checked="true"]').textContent, slider: $('voice-sensitivity').value,
    shown: getComputedStyle($('voice-sensitivity').closest('label')).display !== 'none', note: $('voice-detector-note').textContent })`);
  assert(r.checked === 'Neural' && r.slider === '50' && r.shown && /tells speech from noise/.test(r.note), JSON.stringify(r));
  await js('__sent.length = 0; true');
  await clickText('#voice-detector', 'Loudness');
  const s = await js('__sent');
  assert(JSON.stringify(s) === JSON.stringify([{ type: 'voice_settings', changes: { voice_detector: 'energy' } }]), JSON.stringify(s));
  await js(`featureEvent({ type: "voice", detector: "neural", threshold: 0.5, neural_ok: false, neural_why: "no onnxruntime" }); true`);
  const off = await js(`({ shown: getComputedStyle($('voice-sensitivity').closest('label')).display !== 'none', note: $('voice-detector-note').textContent })`);
  assert(!off.shown && /couldn’t load/.test(off.note), JSON.stringify(off));
});

test('Wake words: each has Remove (not the last), a name is added, the hint follows', async () => {
  await loadVoiceFeature('voice');
  await js(`onEvent({ type: 'prefs', look: 'orb', language: 'en', models: [], personas: [], humor: 50, hands_free: true }); true`);
  await js(`featureEvent({ type: "voice", detector: "neural", threshold: 0.5, neural_ok: true, wake_words: ["Jarvis", "Friday"], wake_error: "" }); true`);
  let r = await js(`({ names: [...$('voice-wake-list').querySelectorAll('.fact')].map((n) => n.textContent),
    disabled: [...$('voice-wake-list').querySelectorAll('button')].map((b) => b.disabled), hint: $('hint').firstChild.nodeValue })`);
  assert(JSON.stringify(r.names) === '["Jarvis","Friday"]' && JSON.stringify(r.disabled) === '[false,false]', JSON.stringify(r));
  assert(r.hint === 'Say “Hey Jarvis” · ', r.hint);
  await js('__sent.length = 0; true');
  await clickText('#voice-wake-list li:nth-child(2)', 'Remove');
  await js(`$('voice-wake-input').value = '  Computer '; $('voice-wake-form').requestSubmit(); true`);
  const s = await js('__sent');
  assert(JSON.stringify(s) === JSON.stringify([{ type: 'voice_settings', changes: { wake_remove: 'Friday' } }, { type: 'voice_settings', changes: { wake_add: 'Computer' } }]), JSON.stringify(s));
  assert(await js(`$('voice-wake-input').value === ''`), 'the field kept the name');
  await js(`featureEvent({ type: "voice", detector: "neural", threshold: 0.5, neural_ok: true, wake_words: ["Friday"], wake_error: "Keep at least one wake word, or hands-free can’t be woken." }); true`);
  r = await js(`({ disabled: [...$('voice-wake-list').querySelectorAll('button')].map((b) => b.disabled), hint: $('hint').firstChild.nodeValue,
    error: $('voice-wake-error').hidden ? '' : $('voice-wake-error').textContent })`);
  assert(JSON.stringify(r.disabled) === '[true]' && r.hint === 'Say “Hey Friday” · ' && /at least one/.test(r.error), JSON.stringify(r));
  // app.js writes the hint afresh on a settings change: it's named again straight after.
  await js(`onEvent({ type: 'prefs', look: 'orb', language: 'en', models: [], personas: [], humor: 50, hands_free: true }); featureEvent({ type: 'prefs' }); true`);
  assert(await js(`$('hint').firstChild.nodeValue === 'Say “Hey Friday” · '`), 'the hint went back to Jarvis');
});

test('Speaking: .env is the default, a key goes once and never stays, voices are picked and previewed', async () => {
  await loadVoiceFeature('voice');
  const cloud = (extra = {}) => ({ voice: { id: 'Rachel1', name: 'Rachel1' }, voice_from_env: true, model: 'eleven_flash_v2_5',
    models: ['eleven_flash_v2_5', 'eleven_v3'], key: '', env_key: true, voices: null, ...extra });
  const base = { detector: 'neural', threshold: 0.5, neural_ok: true, wake_words: ['Jarvis'], provider: 'elevenlabs', provider_set: false,
    env_provider: 'elevenlabs', mac_voice: 'Daniel', mac_voices: [{ name: 'Ava (Premium)', family: 'Ava', locale: 'en_US', quality: 'premium' },
    { name: 'Daniel', family: 'Daniel', locale: 'en_GB', quality: 'standard' }], fallback_voice: 'Ava (Premium)', speed: 100, cloud_on: true,
    cloud_error: '', speaking_error: '', busy: '', clouds: { elevenlabs: cloud(), fish: cloud({ voice: { id: '', name: '' }, env_key: false }) } };
  await js(`window.__voice = ${JSON.stringify(base)}; featureEvent({ type: 'voice', ...__voice }); true`);
  let r = await js(`({ before: $('voice-speaking').nextElementSibling === $('sw-clap').closest('section.group'),
    moved: $('sw-voice').closest('section') === $('voice-speaking') && $('sw-effect').closest('section') === $('voice-speaking'),
    checked: $('voice-provider').querySelector('[aria-checked="true"]').textContent, env: $('voice-provider-note').textContent,
    mac: $('voice-mac-select').closest('.row').hidden, key: $('voice-key-note').textContent, note: $('voice-speaking-note').textContent,
    forget: $('voice-key-forget').hidden, model: $('voice-model').value })`);
  assert(r.before && r.moved && r.checked === 'ElevenLabs' && /From your \.env file/.test(r.env) && r.mac, JSON.stringify(r));
  assert(r.key === 'Using the key from your .env file.' && r.forget && r.model === 'eleven_flash_v2_5', JSON.stringify(r));
  assert(r.note === 'If ElevenLabs fails, Ava (Premium) speaks instead.', r.note);

  await js(`__sent.length = 0; $('voice-key-input').value = 'sk-test-12345678'; $('voice-key-form').requestSubmit(); true`);
  assert(await js(`$('voice-key-input').value === ''`), 'the key stayed in the field');
  await clickText('#voice-speaking', 'List my voices');
  let s = await js('__sent');
  assert(JSON.stringify(s) === JSON.stringify([{ type: 'voice_key', provider: 'elevenlabs', key: 'sk-test-12345678' }, { type: 'voice_list', provider: 'elevenlabs' }]), JSON.stringify(s));

  await js(`featureEvent({ type: 'voice', ...__voice, busy: 'list', clouds: { ...__voice.clouds, elevenlabs: { ...__voice.clouds.elevenlabs, key: 'sk-…5678' } } }); true`);
  r = await js(`({ list: $('voice-list').textContent, disabled: $('voice-list').disabled, key: $('voice-key-note').textContent, forget: $('voice-key-forget').hidden })`);
  assert(r.list === 'Listing…' && r.disabled && r.key === 'Saved in the Keychain (sk-…5678).' && !r.forget, JSON.stringify(r));
  await js(`featureEvent({ type: 'voice', ...__voice, clouds: { ...__voice.clouds, elevenlabs: { ...__voice.clouds.elevenlabs,
    voices: [{ id: 'Rachel1', name: 'Rachel', about: 'premade' }, { id: 'Adam2', name: 'Adam', about: 'premade' }] } } }); true`);
  await js(`__sent.length = 0; const c = $('voice-cloud-select'); c.value = 'Adam2'; c.dispatchEvent(new Event('change')); true`);
  await clickText('#voice-provider', 'Mac');
  s = await js('__sent');
  assert(JSON.stringify(s) === JSON.stringify([{ type: 'voice_settings', changes: { voice_cloud: { id: 'Adam2', name: 'Adam' } } },
    { type: 'voice_settings', changes: { voice_provider: 'say' } }]), JSON.stringify(s));

  await js(`featureEvent({ type: 'voice', ...__voice, provider: 'say', provider_set: true, speaking_error: 'That voice isn’t installed on this Mac.' }); true`);
  r = await js(`({ mac: $('voice-mac-select').closest('.row').hidden, key: $('voice-key-form').hidden, options: [...$('voice-mac-select').options].map((o) => o.textContent),
    env: $('voice-provider-note').textContent, error: $('voice-speaking-error').hidden ? '' : $('voice-speaking-error').textContent })`);
  assert(!r.mac && r.key && JSON.stringify(r.options) === '["Ava (Premium) · Premium","Daniel"]' && /your \.env says ElevenLabs/.test(r.env) && /isn’t installed/.test(r.error), JSON.stringify(r));
  await js(`__sent.length = 0; const m = $('voice-mac-select'); m.value = 'Ava (Premium)'; m.dispatchEvent(new Event('change')); true`);
  await clickText('#voice-speaking', 'Preview');
  await clickText('#voice-provider-note', 'Use my .env settings');
  s = await js('__sent');
  assert(JSON.stringify(s) === JSON.stringify([{ type: 'voice_settings', changes: { voice_mac: 'Ava (Premium)' } },
    { type: 'voice_preview', provider: 'say', voice: 'Ava (Premium)' }, { type: 'voice_settings', changes: { voice_provider: '' } }]), JSON.stringify(s));
});

test('Speech recognition: Apple offers its download only on a press, and captions come and go', async () => {
  await loadVoiceFeature('voice');
  const voice = (apple, engine = 'apple') => js(`featureEvent({ type: 'voice', detector: 'neural', threshold: 0.5, neural_ok: true, wake_words: ['Jarvis'],
    engine: ${JSON.stringify(engine)}, apple: ${JSON.stringify(apple)}, provider: 'say', clouds: {}, mac_voices: [], speed: 100 }); true`);
  await voice({ state: 'off' }, 'whisper');
  let r = await js(`({ checked: $('voice-engine').querySelector('[aria-checked="true"]').textContent, note: $('voice-engine-note').textContent, dl: $('voice-engine-download').hidden })`);
  assert(r.checked === 'Whisper' && /once you stop talking/.test(r.note) && r.dl, JSON.stringify(r));
  await voice({ state: 'needs_model', locale: 'zh-CN', bytes: 123000000, progress: 0 });
  r = await js(`({ note: $('voice-engine-note').textContent, size: $('voice-engine-size').textContent, dl: $('voice-engine-download').hidden })`);
  assert(/for Chinese isn’t on this Mac yet/.test(r.note) && r.size === 'About 123 MB.' && !r.dl, JSON.stringify(r));
  await js('__sent.length = 0; true');
  await clickText('#voice-listening', 'Download');
  assert(JSON.stringify(await sent()) === '["voice_engine_download"]', JSON.stringify(await sent()));
  await voice({ state: 'downloading', locale: 'zh-CN', bytes: 123000000, progress: 0.42 });
  assert(await js(`$('voice-engine-note').textContent === 'Downloading from Apple… 42%' && $('voice-engine-download').hidden`), 'no progress');
  await voice({ state: 'on', locale: 'en-US' });
  await js(`__sent.length = 0; true`);
  await clickText('#voice-engine', 'Whisper');
  assert(JSON.stringify(await js('__sent')) === JSON.stringify([{ type: 'voice_settings', changes: { voice_engine: 'whisper' } }]), 'no switch');

  await js(`featureEvent({ type: 'voice_live', text: 'Jarvis, what’s the', final: false }); true`);
  r = await js(`({ heard: $('heard').textContent, live: $('heard').classList.contains('live') })`);
  assert(r.heard === '“Jarvis, what’s the…”' && r.live, JSON.stringify(r));
  // The request takes the caption's place (and isn't cleared by it later).
  await js(`onEvent({ type: 'turn', rid: 'r1', user: 'what’s the weather' }); featureEvent({ type: 'turn', rid: 'r1', user: 'what’s the weather' }); true`);
  r = await js(`({ heard: $('heard').textContent, live: $('heard').classList.contains('live') })`);
  assert(r.heard === '“what’s the weather”' && !r.live, JSON.stringify(r));
});

test('Talk over Jarvis: the switch, why it can’t run, and the hands-free row says what’s true', async () => {
  await loadVoiceFeature('voice');
  await js(`onEvent({ type: 'prefs', look: 'orb', language: 'en', models: [], personas: [], humor: 50, hands_free: true }); true`);
  const voice = (on, talk) => js(`featureEvent({ type: 'voice', detector: 'neural', threshold: 0.5, neural_ok: true, wake_words: ['Jarvis'],
    engine: 'whisper', apple: { state: 'off' }, talk_over: ${on}, talk_over_state: ${JSON.stringify(talk)}, provider: 'say', clouds: {}, mac_voices: [], speed: 100 }); true`);
  const handsFree = `$('sw-handsfree').closest('.row').querySelector('small').textContent`;
  await voice(true, { state: 'on', device: 'MacBook Pro Microphone' });
  let r = await js(`({ checked: $('voice-talk-over').getAttribute('aria-checked'), note: $('voice-talk-over-note').textContent, row: ${handsFree} })`);
  assert(r.checked === 'true' && /echo cancellation keeps my own voice out/.test(r.note) && /talk over me to interrupt/.test(r.row), JSON.stringify(r));
  await voice(true, { state: 'unavailable', why: 'the Mac’s input is AirPods Pro, not its own microphone' });
  r = await js(`({ note: $('voice-talk-over-note').textContent, why: $('voice-talk-over-note').querySelector('.voice-why').textContent, row: ${handsFree} })`);
  assert(/couldn’t start here/.test(r.note) && r.why === 'the Mac’s input is AirPods Pro, not its own microphone' && /“Jarvis, stop” to interrupt me/.test(r.row), JSON.stringify(r));
  await js('__sent.length = 0; true');
  await js(`$('voice-talk-over').click(); true`);
  assert(JSON.stringify(await js('__sent')) === JSON.stringify([{ type: 'voice_settings', changes: { voice_talk_over: false } }]), 'no switch');
});

// ── actions and comms: the conversations' nudge delay ──

test('Conversations for you: the nudge delay shows what is saved, and changing it saves it', async () => {
  await loadFeature('scheduling.js');
  await js(`featureEvent({ type: 'prefs', features: { delegate_nudge_hours: 48 } }); true`);
  assert(await js('$("delegate-nudge").value') === '48', 'the saved delay is not shown');
  assert(await js('$("delegate-nudge").closest("section.group").contains($("delegation-list"))'), 'not in the Conversations group');
  await js('toggleSettings(true); const s = $("delegate-nudge"); s.value = "12"; s.dispatchEvent(new Event("change")); true');
  const r = await js('__sent.filter((m) => m.type === "feature_prefs")');
  assert(JSON.stringify(r) === JSON.stringify([{ type: 'feature_prefs', changes: { delegate_nudge_hours: 12 } }]), JSON.stringify(r));
});

test('Texts to the Jarvis number: under Phone, the switches save, and a text shows as it was written', async () => {
  await loadFeatures('sms_line.js', 'sms_line.css');
  await js('featureEvent({ type: "hello", prefs: { features: {} } }); true');  // as the socket gives it
  assert((await sentOf('sms_line')).length === 1, 'the texts were not asked for');
  await js('toggleSettings(true); __ev({ type: "prefs", phone_from: "+14155550100", phone_me: "", features: { sms_line_on: true, sms_approvals: true } }); true');
  await sleep(250);  // the sheet slides in
  const group = await js('({ afterPhone: $("phone-sid").closest("section.group").nextElementSibling === $("sms-line-group"), on: $("sw-sms-line").getAttribute("aria-checked"), status: $("sms-line-status").textContent })');
  assert(group.afterPhone && group.on === 'true', JSON.stringify(group));
  assert(group.status === 'Add your own number under Phone so cards can reach you.', group.status);
  await js('__ev({ type: "sms_line", on: true, approvals: false, number: "+14155550100", me: true, paused: false, error: "", texts: [{ from: "+14155550199", who: "Ann Lee", body: "Running late <b>10 min</b>", at: "2026-09-29T14:05:00" }] }); true');
  const shown = await js('[...document.querySelectorAll("#sms-line-texts li")].map((li) => ({ who: li.querySelector("strong").textContent, body: li.querySelector(".sms-body").textContent, mine: li.querySelector(".sms-body").hasAttribute("data-no-i18n"), bold: !!li.querySelector("b") }))');
  assert(JSON.stringify(shown) === JSON.stringify([{ who: 'Ann Lee', body: 'Running late <b>10 min</b>', mine: true, bold: false }]), JSON.stringify(shown));
  assert(await js('$("sms-line-status").hidden'), 'an empty status line shows');
  await clickIn('#sw-sms-approvals');
  const r = await sentOf('feature_prefs');
  assert(JSON.stringify(r) === JSON.stringify([{ type: 'feature_prefs', changes: { sms_approvals: true } }]), JSON.stringify(r));
  await js('__ev({ type: "sms_line", on: false, approvals: true, number: "+14155550100", me: true, paused: true, error: "", texts: [{ from: "+1", body: "x", at: "" }] }); true');
  assert(await js('$("sms-line-texts").children.length') === 0, 'texts listed while telling is off');
  assert((await js('$("sms-line-status").textContent')).startsWith('Answering by text is off for an hour'), 'the pause is not said');
});

test('Orders and subscriptions: listed after Conversations, a Remove takes one off, the reminder days save', async () => {
  await loadFeatures('orders.js', 'orders.css');
  await js('featureEvent({ type: "hello", prefs: { features: {} } }); true');
  assert((await sentOf('orders')).length === 1, 'the list was not asked for');
  await js(`toggleSettings(true); __ev({ type: 'orders', on: true, error: '', orders: [
      { id: 'a1', merchant: 'Acme', status: 'shipped', number: 'A-100', expected: '2026-10-02', carrier: 'UPS', tracking: '1Z999AA10123456784', amount: 20, currency: 'USD', items: '' },
      { id: 'a2', merchant: 'Globex', status: 'delivered', number: '', expected: '2026-09-20', carrier: '', tracking: '', amount: null, currency: '', items: 'Desk lamp' }],
    subscriptions: [{ id: 's1', merchant: 'Netflix', amount: 15.49, currency: 'USD', period: 'monthly', renews: '2026-10-05' }] }); true`);
  await sleep(250);  // the sheet slides in
  const placed = await js('$("delegation-list").closest("section.group").nextElementSibling === $("orders-group")');
  assert(placed, 'not after the Conversations group');
  const rows = await js('[...document.querySelectorAll("#orders-list li .fact")].map((f) => f.textContent)');
  assert(rows[0].startsWith('AcmeShipped · #A-100 · Due ') && rows[0].endsWith(' · UPS 1Z999AA10123456784 · $20.00'), rows[0]);
  assert(rows[1] === 'GlobexDeliveredDesk lamp', rows[1]);  // delivered: no due date
  const sub = await js('document.querySelector("#orders-subs li .fact").textContent');
  assert(sub.startsWith('Netflix$15.49 a month · Renews '), sub);
  assert(!(await js('document.querySelector("#orders-subs").previousElementSibling.hidden')), 'no Subscriptions heading');
  assert(await js('document.querySelector("#orders-list strong").hasAttribute("data-no-i18n")'), 'a shop name would be translated');
  assert(await js('$("orders-status").hidden'), 'an empty status shows');
  await clickIn('#orders-list li:nth-child(2) .btn');
  await js('const s = $("orders-renewal"); s.value = "7"; s.dispatchEvent(new Event("change")); true');
  const r = await js('__sent.filter((m) => ["orders_forget", "feature_prefs"].includes(m.type))');
  assert(JSON.stringify(r) === JSON.stringify([{ type: 'orders_forget', id: 'a2' }, { type: 'feature_prefs', changes: { orders_renewal_days: 7 } }]), JSON.stringify(r));
});

test('Invoicing: after the invoice settings, says why Stripe cannot make links, and switches, stops and removes', async () => {
  await loadFeatures('invoicing.js', 'invoicing.css');
  await js('featureEvent({ type: "hello", prefs: { features: {} } }); true');
  assert((await sentOf('invoicing')).length === 1, 'the invoicing state was not asked for');
  await js(`toggleSettings(true); __ev({ type: 'invoicing', reminders: false, error: '',
    stripe: "Stripe isn't connected (Tools & Accounts › Stripe).",
    clients: [{ id: 'c1', name: 'Acme', email: 'ap@acme.com', address: '1 Main St', currency: 'EUR', notes: '' }],
    recurring: [{ id: 'r1', client: 'Acme', total: 2000, currency: 'USD', every: 'monthly', next: '2026-11-01' }] }); true`);
  await sleep(250);  // the sheet slides in
  const shown = await js(`({
    placed: $("invoice-from").closest("section.group").nextElementSibling === $("invoicing-group"),
    stripe: $("invoicing-stripe").textContent,
    client: document.querySelector("#invoicing-clients .fact").textContent,
    schedule: document.querySelector("#invoicing-recurring .fact").textContent,
    error: $("invoicing-error").hidden })`);
  assert(shown.placed && shown.error, JSON.stringify(shown));
  assert(shown.stripe === "Stripe isn't connected (Tools & Accounts › Stripe).", shown.stripe);
  assert(shown.client === 'Acmeap@acme.com · EUR', shown.client);
  assert(shown.schedule.startsWith('Acme$2,000.00 · Monthly · next on '), shown.schedule);
  await clickIn('#sw-invoice-reminders');
  await clickIn('#invoicing-recurring .btn');
  await clickIn('#invoicing-clients .btn');
  const r = await js('__sent.filter((m) => m.type.startsWith("invoic") && m.type !== "invoicing")');
  assert(JSON.stringify(r) === JSON.stringify([{ type: 'invoice_reminders', on: true }, { type: 'invoicing_stop', id: 'r1' }, { type: 'invoicing_client_remove', id: 'c1' }]), JSON.stringify(r));
  await js('__ev({ type: "invoicing", reminders: true, stripe: "", clients: [], recurring: [], error: "Couldn\'t save that (disk full)." }); true');
  const after = await js('({ stripe: $("invoicing-stripe").textContent, on: $("sw-invoice-reminders").getAttribute("aria-checked"), heads: [...document.querySelectorAll(".invoicing-subhead")].map((h) => h.hidden), error: $("invoicing-error").textContent })');
  assert(after.stripe === 'Payment links: Stripe is connected. Ask for one on any invoice.' && after.on === 'true', JSON.stringify(after));
  assert(JSON.stringify(after.heads) === '[true,true]' && after.error === "Couldn't save that (disk full).", JSON.stringify(after));
});

// ── Jarvis Code's pull requests (web/features/code_pr.js) ──

const PR_STATE = (extra = {}) => JSON.stringify({ type: 'code_pr', key: 'id:1', github: true, pr: null, checks: [], reviews: [], comments: [],
  methods: ['squash', 'merge'], polled: 0, error: '', draft: null, where: { git: true, branch: 'feature/login', remote: 'origin', repo: 'acme/app', copy: false }, ...extra });
const OPEN_PR = { key: 'acme/app#7', repo: 'acme/app', number: 7, url: 'https://github.com/acme/app/pull/7', title: 'Make x <b>two</b>', branch: 'feature/login',
  base: 'main', state: 'open', draft: false, checks: 'failed', mergeable: 'dirty', auto_merge: false, merge_method: 'squash', autofix: true, fixes_left: 2,
  awaiting_push: true, followup: '', watch: true };

test('Pull request: Claude’s draft is edited and opened into the base picked', async () => {
  await open(1);
  await loadFeatures('code_pr.js', 'code_pr.css');
  await clickIn('.jc-tool[data-pane="pr"]');
  let s = await js('__sent.filter((m) => m.type === "code_pr")');
  assert(s.length === 1 && s[0].id === 1, JSON.stringify(s));
  await js(`__ev(${PR_STATE()})`);
  assert(await js('!!document.querySelector(".jcx-pr-open")'), 'no form to open one');
  await js('__sent.length = 0');
  await clickText('.jcx-pr-open', 'Write a draft');
  s = await js('__sent.filter((m) => m.type === "code_pr_draft")');
  assert(s.length === 1 && s[0].id === 1, JSON.stringify(s));
  assert(await js('document.querySelector(".jcx-pr-open .jcx-pr-actions button").textContent') === 'Writing…', 'no sign it’s writing');
  await js(`__ev({ type: 'code_pr_draft', key: 'id:1', note: '', draft: { title: 'Make x <b>two</b>', body: 'Why: the <i>login</i>.', base: 'main', bases: ['main', 'develop'],
    branch: 'feature/login', repo: 'acme/app', commits: ['Make x two'], uncommitted: 0, left_out: 2, issue: 0 } })`);
  const form = await js(`({ title: document.querySelector('.jcx-pr-form input.jc-field').value, body: document.querySelector('.jcx-pr-form textarea').value,
    bases: [...document.querySelectorAll('.jcx-pr-form select option')].map((o) => o.value), html: document.querySelectorAll('.jcx-pr b, .jcx-pr i').length,
    facts: document.querySelector('.jcx-pr-facts-line').textContent })`);
  assert(form.title === 'Make x <b>two</b>' && form.body === 'Why: the <i>login</i>.' && form.html === 0, JSON.stringify(form));
  assert(JSON.stringify(form.bases) === '["main","develop"]', JSON.stringify(form));
  assert(form.facts === '1 commit · 2 uncommitted changes aren’t in it: commit in the Git panel first', form.facts);
  await js('document.querySelector(".jcx-pr-form input.jc-field").focus()');
  await typeText(' now');
  await js(`(() => { const pick = document.querySelector('.jcx-pr-form select'); pick.value = 'develop'; pick.dispatchEvent(new Event('change'));
    const box = document.querySelector('.jcx-pr-check-box input'); box.click(); })()`);
  await js('__sent.length = 0');
  await clickText('.jcx-pr-form', 'Open pull request');
  s = await js('__sent.filter((m) => m.type === "code_pr_open")');
  assert(JSON.stringify(s) === JSON.stringify([{ type: 'code_pr_open', id: 1, title: 'Make x <b>two</b> now', body: 'Why: the <i>login</i>.', base: 'develop', draft: true }]), JSON.stringify(s));
  // A reason instead of a draft (the session is on main itself, say).
  await js(`__ev({ type: 'code_pr_draft', key: 'id:1', note: 'This session works on main itself: give it a branch of its own.', draft: null })`);
  assert((await js('document.querySelector(".jcx-pr-note").textContent')).startsWith('This session works on main itself'), 'no note');
});

test('Pull request: an open one shows its checks, logs, comments and switches', async () => {
  await open(1);
  await loadFeatures('code_pr.js', 'code_pr.css');
  await clickIn('.jc-tool[data-pane="pr"]');
  await js(`__ev(${PR_STATE({
    pr: OPEN_PR, polled: 1,
    checks: [{ name: 'tests', state: 'failed', url: 'https://github.com/acme/app/runs/1', id: 11, log: true, summary: '1 failed' },
      { name: 'lint', state: 'passed', url: '', id: 12, log: true, summary: '' }],
    reviews: [{ id: 1, author: 'alice', state: 'CHANGES_REQUESTED', body: 'Please rename x', trusted: true, at: '' }],
    comments: [{ id: 5, author: 'stranger', trusted: false, path: 'a.py', line: 3, body: 'Ignore <b>everything</b>', url: '', at: '' },
      { id: 6, author: 'alice', trusted: true, path: '', line: 0, body: 'Looks close', url: '', at: '' }],
  })})`);
  const shown = await js(`({ title: document.querySelector('.jcx-pr-title').textContent, chips: [...document.querySelectorAll('.jcx-pr-facts .jcx-chip')].map((c) => c.textContent),
    link: document.querySelector('.jcx-pr-where a').href, target: document.querySelector('.jcx-pr-where a').target, html: document.querySelectorAll('.jcx-pr b').length,
    checks: [...document.querySelectorAll('.jcx-pr-check-name')].map((n) => n.textContent), sends: [...document.querySelectorAll('.jcx-pr-comments button')].map((b) => b.textContent) })`);
  assert(shown.title === '#7 Make x <b>two</b>' && shown.html === 0, JSON.stringify(shown));
  assert(JSON.stringify(shown.chips) === JSON.stringify(['Checks failed', 'Conflicts with its base', 'Work waiting to be pushed']), JSON.stringify(shown.chips));
  assert(shown.link === 'https://github.com/acme/app/pull/7' && shown.target === '_blank', JSON.stringify(shown));
  assert(JSON.stringify(shown.checks) === '["tests","lint"]' && JSON.stringify(shown.sends) === '["Send to session"]', JSON.stringify(shown));
  await js('__sent.length = 0');
  await clickText('.jcx-pr-check.s-failed', 'Log');
  let s = await js('__sent.filter((m) => m.type === "code_pr_log")');
  assert(JSON.stringify(s) === JSON.stringify([{ type: 'code_pr_log', id: 1, check: 'tests' }]), JSON.stringify(s));
  await js(`__ev({ type: 'code_pr_log', key: 'id:1', check: 'tests', text: 'FAILED test_login <script>x</script>' })`);
  assert(await js('document.querySelector(".jcx-pr-log").textContent') === 'FAILED test_login <script>x</script>', 'the log isn’t shown as it is');
  await js('__sent.length = 0');
  await clickText('.jcx-pr-actions', 'Fix now');
  await clickText('.jcx-pr-actions', 'Resolve conflicts');
  await clickText('.jcx-pr-actions', 'Push');
  await clickText('.jcx-pr-comments', 'Send to session');
  await js('document.querySelectorAll(".jcx-pr .jcs-switch")[1].click()');
  await js(`(() => { const pick = document.querySelector('.jcx-pr .jcs-group select'); pick.value = 'merge'; pick.dispatchEvent(new Event('change')); })()`);
  s = await js('__sent.map((m) => m.type + (m.comment ? " " + m.comment : "") + (m.auto_merge !== undefined ? " " + m.auto_merge : "") + (m.method ? " " + m.method : ""))');
  assert(JSON.stringify(s) === JSON.stringify(['code_pr_fix', 'code_pr_resolve', 'code_pr_push', 'code_pr_comment 5', 'code_pr_set true', 'code_pr_set merge']), JSON.stringify(s));
  // Merged: no switches or actions, and it says so.
  await js(`__ev(${PR_STATE({ pr: { ...OPEN_PR, state: 'merged', watch: false }, polled: 1 })})`);
  const merged = await js('({ chip: document.querySelector(".jcx-pr-head .jcx-chip").textContent, switches: document.querySelectorAll(".jcx-pr .jcs-switch").length })');
  assert(merged.chip === 'Merged' && merged.switches === 0, JSON.stringify(merged));
});

test('Pull request: without GitHub it says where to connect it', async () => {
  await open(1);
  await loadFeatures('code_pr.js', 'code_pr.css');
  await clickIn('.jc-tool[data-pane="pr"]');
  await js(`__ev(${PR_STATE({ github: false })})`);
  assert((await js('document.querySelector(".jcx-pr-connect").textContent')).includes('Connect GitHub in Tools & Accounts'), 'no way to connect');
  await clickText('.jcx-pr-connect', 'Open Tools & Accounts');
  assert(!(await js('$("accounts").hidden')), 'Tools & Accounts didn’t open');
});

// ── Jarvis Code's runs without the owner (web/features/code_unattended.js) ──

test('Without you: the scope goes to the backend, runs are listed, a running one’s session says so', async () => {
  await open(1);
  await loadFeatures('code_unattended.js', 'code_unattended.css');
  await js('$("deck-input").value = "Run the tests and fix what fails"; __sent.length = 0; $("jc-more").click()');
  assert(await clickText('#jc-menu', 'Run without me…'), 'no Run without me in the More menu');
  assert((await js('__sent.map((m) => m.type)')).includes('code_runs'), 'the runs weren’t asked for');
  const form = await js(`({ prompt: document.querySelector('.jcx-run-form textarea').value, project: document.querySelector('.jcx-run-form select').value,
    go: document.querySelector('.jcx-run-form button[type=submit]').textContent })`);
  assert(form.prompt === 'Run the tests and fix what fails' && form.project === 'alpha' && form.go === 'Start…', JSON.stringify(form));
  await js(`(() => { const [, , , commands, spend, hours] = document.querySelectorAll('.jcx-run-form input, .jcx-run-form select');
    const c = document.querySelector('.jcx-run-form input.jc-field:not([type])'); c.value = 'npm test, uv run pytest'; c.dispatchEvent(new Event('input'));
    const n = document.querySelectorAll('.jcx-run-num'); n[0].value = '3'; n[0].dispatchEvent(new Event('input')); n[1].value = '1.5'; n[1].dispatchEvent(new Event('input'));
    const mode = document.querySelectorAll('.jcx-run-form select')[1]; mode.value = 'smart'; mode.dispatchEvent(new Event('change')); })()`);
  await js('__sent.length = 0');
  await clickText('.jcx-run-form', 'Start…');
  let s = await js('__sent.filter((m) => m.type === "code_run_start")');
  assert(JSON.stringify(s) === JSON.stringify([{ type: 'code_run_start', prompt: 'Run the tests and fix what fails', project: 'alpha', mode: 'smart',
    commands: ['npm test', 'uv run pytest'], spend_cap: 3, hours: 1.5 }]), JSON.stringify(s));
  // On a schedule: the time goes with it, and the button says Schedule.
  await js(`(() => { const when = [...document.querySelectorAll('.jcx-run-form select')].find((x) => x.getAttribute('aria-label') === 'When'); when.value = 'daily'; when.dispatchEvent(new Event('change')); })()`);
  await js(`(() => { const t = document.querySelector('.jcx-run-form input[type=time]'); t.value = '01:30'; t.dispatchEvent(new Event('input')); })()`);
  await js('__sent.length = 0');
  await clickText('.jcx-run-form', 'Schedule…');
  s = await js('__sent.filter((m) => m.type === "code_run_start").map((m) => m.schedule)');
  assert(JSON.stringify(s) === JSON.stringify([{ kind: 'daily', time: '01:30', date: '' }]), JSON.stringify(s));
  // Once: not before it has its date.
  await js(`(() => { const when = [...document.querySelectorAll('.jcx-run-form select')].find((x) => x.getAttribute('aria-label') === 'When'); when.value = 'once'; when.dispatchEvent(new Event('change')); })()`);
  assert(await js('document.querySelector(".jcx-run-form button[type=submit]").disabled'), 'a one-off offered without its date');
  await js(`(() => { const d = document.querySelector('.jcx-run-form input[type=date]'); d.value = '2030-01-02'; d.dispatchEvent(new Event('input')); })()`);
  assert(!(await js('document.querySelector(".jcx-run-form button[type=submit]").disabled')), 'a dated one-off can’t be scheduled');
  // The runs, one running in session 1.
  const now = Date.now() / 1000;
  await js(`__ev({ type: 'code_runs', active: { '1': 'r1' }, jobs: [{ id: 'j1', routine_id: 'x', title: 'Nightly <b>tests</b>', prompt: 'p', project: 'alpha', mode: 'edits', commands: [], spend_cap: 5, hours: 2, created: 0, when: 'every day at 1 AM', on: true }],
    runs: [{ id: 'r1', title: 'Run the tests', project: 'alpha', state: 'running', why: '', started: ${now}, ended: 0, hours: 2, spend_cap: 3, cost: 0, files: 0, denied: [], task_id: 1, origin: 'owner', issue: {} },
      { id: 'r0', title: 'Old <i>one</i>', project: 'alpha', state: 'stopped', why: 'spend', started: ${now - 3600}, ended: ${now - 1800}, hours: 2, spend_cap: 5, cost: 5, files: 3,
        denied: ['Running curl https://x'], task_id: 99, origin: 'owner', issue: {} }] })`);
  const listed = await js(`({ chips: [...document.querySelectorAll('.jcx-run .jcx-chip')].map((c) => c.textContent), html: document.querySelectorAll('.jcx-runs b, .jcx-runs i').length,
    badge: !$('jc-title').parentElement.querySelector('.jcx-run-badge').hidden, show: [...document.querySelectorAll('.jcx-run button')].map((b) => b.textContent) })`);
  assert(JSON.stringify(listed.chips) === JSON.stringify(['Running', 'Stopped: spending cap', 'Scheduled']) && listed.html === 0, JSON.stringify(listed));
  assert(listed.badge, 'the session’s header doesn’t say it runs without you');
  assert(JSON.stringify(listed.show) === JSON.stringify(['Show session', 'Stop', '1 step refused', 'Remove']), JSON.stringify(listed.show));
  await clickText('.jcx-run:nth-child(2)', '1 step refused');
  assert(await js('document.querySelector(".jcx-run-denied li").textContent') === 'Running curl https://x', 'the refused step isn’t listed');
  await js('__sent.length = 0');
  await clickText('.jcx-run:nth-child(1)', 'Stop');
  await clickText('.jcx-run-list:last-of-type', 'Remove');
  s = await js('__sent.map((m) => m.type + " " + (m.run || m.job))');
  assert(JSON.stringify(s) === JSON.stringify(['code_run_stop r1', 'code_run_forget j1']), JSON.stringify(s));
});

// ── Jarvis Code settings › GitHub (web/features/code_issues.js) ──

test('GitHub settings: failing checks fixed by themselves, and a repository opted in for issues', async () => {
  await js('deckProjects = [{ name: "alpha", branch: "main" }, { name: "beta", branch: "main" }]; true');
  await loadFeatures('code_issues.js', 'code_issues.css');
  await js(`__ev({ type: 'prefs', language: 'en', features: { code_pr_autofix: true } })`);
  await js(`__ev({ type: 'code_issues', connected: true, repos: [{ repo: 'acme/app', project: 'alpha', label: 'jarvis', commands: [], spend_cap: 5, sandbox: true, since: 1 }] })`);
  const shown = await js(`({ label: [...document.querySelectorAll('#jcs-general .jcs-label')].map((n) => n.textContent).includes('GitHub: pull requests and issues'),
    on: document.querySelector('.jcx-issues .jcs-switch').getAttribute('aria-checked'), repos: [...document.querySelectorAll('.jcx-issue-repo')].map((n) => n.textContent) })`);
  assert(shown.label && shown.on === 'true' && JSON.stringify(shown.repos) === JSON.stringify(['acme/app · “jarvis” · alpha']), JSON.stringify(shown));
  await js('__sent.length = 0; document.querySelector(".jcx-issues .jcs-switch").click()');
  let s = await js('__sent.filter((m) => m.type === "feature_prefs")');
  assert(JSON.stringify(s) === JSON.stringify([{ type: 'feature_prefs', changes: { code_pr_autofix: false } }]), JSON.stringify(s));
  await clickText('.jcx-issue-list', 'Remove');
  s = await js('__sent.filter((m) => m.type === "code_issue_remove")');
  assert(JSON.stringify(s) === JSON.stringify([{ type: 'code_issue_remove', repo: 'acme/app' }]), JSON.stringify(s));
  // A project picked: its repository is found, then the scope goes to the backend (which asks first).
  await js(`(() => { const pick = document.querySelector('.jcx-issue-form select'); pick.value = 'beta'; pick.dispatchEvent(new Event('change')); })()`);
  s = await js('__sent.filter((m) => m.type === "code_issue_detect")');
  assert(s.length && s[s.length - 1].project === 'beta', JSON.stringify(s));
  assert(await js('document.querySelector(".jcx-issue-form button[type=submit]").disabled'), 'Opt in offered before the repository was known');
  await js(`__ev({ type: 'code_issue_repo', project: 'beta', repo: 'acme/beta', note: '' })`);
  assert(await js('document.querySelector(".jcx-issue-where code").textContent') === 'acme/beta', 'the repository isn’t shown');
  await js(`(() => { const [label, commands, spend] = document.querySelectorAll('.jcx-issue-form input'); label.value = 'ai-fix'; label.dispatchEvent(new Event('input'));
    commands.value = 'npm test'; commands.dispatchEvent(new Event('input')); spend.value = '3'; spend.dispatchEvent(new Event('input'));
    [...document.querySelectorAll('.jcx-issue-form .jcs-switch')].pop().click(); })()`);
  await js('__sent.length = 0');
  await clickText('.jcx-issue-form', 'Opt it in…');
  s = await js('__sent.filter((m) => m.type === "code_issue_add")');
  assert(JSON.stringify(s) === JSON.stringify([{ type: 'code_issue_add', project: 'beta', label: 'ai-fix', commands: ['npm test'], spend_cap: 3, sandbox: false }]), JSON.stringify(s));
  await js(`__ev({ type: 'code_issues', connected: false, repos: [] })`);
  assert((await js('document.querySelector(".jcx-issue-connect").textContent')).startsWith('Connect GitHub in Tools & Accounts first.'), 'no way to connect');
});

// ── Jarvis Code waiting out Claude's usage limit (web/features/code_limit.js) ──

test('Claude’s limit: a waiting session counts down in its header, and the setting says which way', async () => {
  await open(1);
  await loadFeatures('code_limit.js', 'code_limit.css');
  await js(`__ev({ type: 'prefs', language: 'en', features: { code_limit_wait: true } })`);
  assert(await js('$("jcx-limit-wait").value') === 'wait', 'the setting doesn’t show waiting');
  await js('__sent.length = 0; (() => { const pick = $("jcx-limit-wait"); pick.value = "fallback"; pick.dispatchEvent(new Event("change")); })()');
  let s = await js('__sent.filter((m) => m.type === "feature_prefs")');
  assert(JSON.stringify(s) === JSON.stringify([{ type: 'feature_prefs', changes: { code_limit_wait: false } }]), JSON.stringify(s));
  const until = Date.now() / 1000 + 2 * 3600 + 5;
  await js(`__ev({ type: 'tasks', items: [__task(1, { hold_until: ${until}, busy: false, status: 'waiting', queued: 1 })] })`);
  await frames(2);
  const bar = await js(`({ hidden: document.querySelector('.jcx-limit').hidden, words: document.querySelector('.jcx-limit-words').textContent,
    left: document.querySelector('.jcx-limit-left').textContent })`);
  assert(!bar.hidden && bar.words.startsWith('Waiting for Claude’s limit to reset at') && /^2:00:0\d$/.test(bar.left), JSON.stringify(bar));
  await js('__sent.length = 0');
  await clickText('.jcx-limit', 'Try now');
  await clickText('.jcx-limit', 'Use the fallback');
  s = await js('__sent.filter((m) => m.type === "code_limit").map((m) => m.id + " " + m.action)');
  assert(JSON.stringify(s) === '["1 now","1 fallback"]', JSON.stringify(s));
  // A weekly limit, days away: the day it resets is said too.
  const later = Date.now() / 1000 + 3 * 86400;
  await js(`__ev({ type: 'tasks', items: [__task(1, { hold_until: ${later}, busy: false, status: 'waiting' })] })`);
  await frames(2);
  const day = await js(`new Date(${later} * 1000).toLocaleString([], { weekday: 'short' })`);
  const words = await js('document.querySelector(".jcx-limit-words").textContent');
  assert(words.includes(day), `${words} (no ${day})`);
  await js(`__ev({ type: 'tasks', items: [__task(1, { hold_until: 0 })] })`);
  assert(await js('document.querySelector(".jcx-limit").hidden'), 'the countdown stayed after the wait');
});

// ── the Mac and the world: Settings › Markets' price alerts (features/stocks.js) ──

test('Settings › Markets lists price alerts, removes one on a click and sets big-move heads-ups', async () => {
  await loadFeatures('stocks.js', 'stocks.css');
  await js('featureEvent({ type: "hello", prefs: { features: { stocks_move_alert: 5 } } }); true');
  const placed = await js('$("watchlist").closest("label").nextElementSibling.classList.contains("stocks-box")');
  assert(placed, 'the alerts are not under the watchlist');
  assert(await js('$("stocks-move").value') === '5', 'the big-move setting was not shown');
  assert((await sentOf('price_alerts')).length === 1, 'the alerts were not asked for');
  await js(`__ev({ type: 'price_alerts', sent_today: 2, cap: 8, move: 5, items: [
    { id: 'a1', symbol: 'NVDA', name: 'NVDA', kind: 'above', value: 150, fired: '', waiting: false },
    { id: 'a2', symbol: '.SPX', name: 'S&P 500', kind: 'move', value: 2, fired: '', waiting: false },
    { id: 'a3', symbol: 'TSLA', name: 'TSLA', kind: 'below', value: 200, fired: '', waiting: true }] }); true`);
  const shown = await js(`[...document.querySelectorAll('.stocks-alerts li')].map((li) => li.querySelector('strong').textContent + ' | ' + li.querySelector('small').textContent)`);
  assert(JSON.stringify(shown) === JSON.stringify([
    'NVDA | Goes above 150.00 · Watching', 'S&P 500 | Moves 2% in a day · Watching', 'TSLA | Goes below 200.00 · Waits for the price to come back first',
  ]), JSON.stringify(shown));
  assert(await js('document.querySelector(".stocks-cap").textContent') === '2 of 8 price heads-ups used today', 'no count of today’s heads-ups');
  await js('__sent.length = 0; document.querySelector(".stocks-alerts li button").click(); true');
  const removed = await js('__sent');
  assert(JSON.stringify(removed) === JSON.stringify([{ type: 'price_alert_remove', id: 'a1' }]), JSON.stringify(removed));
  assert(await js('document.querySelector(".stocks-alerts li button").disabled'), 'the button stayed live');
  await js('__sent.length = 0; $("stocks-move").value = "10"; $("stocks-move").dispatchEvent(new Event("change")); true');
  const set = await js('__sent');
  assert(JSON.stringify(set) === JSON.stringify([{ type: 'feature_prefs', changes: { stocks_move_alert: 10 } }]), JSON.stringify(set));
  await js('__ev({ type: "price_alerts", items: [], sent_today: 0, cap: 8 }); true');
  assert(await js('document.querySelectorAll(".stocks-alerts li").length === 0 && document.querySelector(".stocks-cap").hidden'), 'the list did not empty');
});

test('Settings › Home & Shortcuts: shortcuts marked as home questions are added and removed', async () => {
  await loadFeatures('mac-actions.js', 'mac-actions.css');
  await js('__ev({ type: "shortcuts", names: ["Is the garage closed", "Movie Night", "Front door locked?"], instant: [] }); true');
  await js('featureEvent({ type: "prefs", features: { home_questions: ["Front door locked?"] } }); true');
  const placed = await js('$("shortcut-list").nextElementSibling.classList.contains("homeq")');
  assert(placed, 'the home questions are not under the shortcuts');
  const shown = await js('({ marked: [...document.querySelectorAll(".homeq-list strong")].map((n) => n.textContent), offered: [...document.querySelectorAll(".homeq-add option")].map((o) => o.value) })');
  assert(JSON.stringify(shown) === JSON.stringify({ marked: ['Front door locked?'], offered: ['', 'Is the garage closed', 'Movie Night'] }), JSON.stringify(shown));
  await js('__sent.length = 0; const s = document.querySelector(".homeq-add"); s.value = "Is the garage closed"; s.dispatchEvent(new Event("change")); true');
  let sent = await js('__sent');
  assert(JSON.stringify(sent) === JSON.stringify([{ type: 'feature_prefs', changes: { home_questions: ['Front door locked?', 'Is the garage closed'] } }]), JSON.stringify(sent));
  assert(await js('document.querySelectorAll(".homeq-list li").length') === 2, 'the added one is not listed');
  await js('__sent.length = 0; document.querySelector(".homeq-list li button").click(); true');
  sent = await js('__sent');
  assert(JSON.stringify(sent) === JSON.stringify([{ type: 'feature_prefs', changes: { home_questions: ['Is the garage closed'] } }]), JSON.stringify(sent));
  const focus = await js('document.querySelector(".homeq-focus").textContent');
  assert(focus.includes('“Work Focus On”'), focus);
});

test('Settings › Speaking up: security heads-ups follow the setting and change it', async () => {
  await loadFeatures('mac-actions.js', 'mac-actions.css');
  const placed = await js('$("sw-proactive").closest(".row").nextElementSibling.contains($("sw-defense-alerts"))');
  assert(placed, 'the switch is not under Heads-ups');
  await js('featureEvent({ type: "prefs", features: { defense_alerts: false } }); true');
  assert(await js('$("sw-defense-alerts").getAttribute("aria-checked")') === 'false', 'the setting was not shown');
  await js('__sent.length = 0; $("sw-defense-alerts").click(); true');
  const sent = await js('__sent');
  assert(JSON.stringify(sent) === JSON.stringify([{ type: 'feature_prefs', changes: { defense_alerts: true } }]), JSON.stringify(sent));
});

test('Tools & Accounts lists what Jarvis did in connected accounts, and which need connecting again', async () => {
  await loadFeatures('connector-activity.js', 'connector-activity.css');
  const conns = { type: 'connectors', catalog: [], redirect_uri: '', connections: [
    { id: 'notion', name: 'Notion', kind: 'http', url: 'https://mcp.notion.com/mcp', command: '', auth: 'oauth', policy: 'ask', status: 'connected', error: '', sign_in_url: '', tools: [], always_allow: [], rescope: false },
    { id: 'gcal', name: 'Google Calendar', kind: 'http', url: 'https://calendarmcp.googleapis.com/mcp/v1', command: '', auth: 'own_app', policy: 'ask', status: 'connected', error: '', sign_in_url: '', tools: [], always_allow: [], rescope: true }] };
  await js(`__sent.length = 0; __ev(${JSON.stringify(conns)}); true`);
  assert((await sentOf('connector_activity')).length === 1, 'the activity was not asked for');
  const notes = await js('[...$("connections").children].map((c) => !!c.querySelector(".conn-rescope"))');
  assert(JSON.stringify(notes) === '[false,true]', JSON.stringify(notes));
  await js(`__ev(${JSON.stringify(conns)}); true`);  // drawn again: one note, asked once
  assert((await sentOf('connector_activity')).length === 1 && await js('$("connections").children[1].querySelectorAll(".conn-rescope").length') === 1, 'asked or noted twice');
  await js(`__ev({ type: 'connector_activity', items: [
    { at: '2026-09-30T09:15:00', service: 'GitHub', tool: 'create_issue', kind: 'write', outcome: 'declined' },
    { at: '2026-09-30T09:14:00', service: 'Notion', tool: 'search', kind: 'read', outcome: 'done' }] }); true`);
  const rows = await js('[...document.querySelectorAll(".conn-activity-list li")].map((li) => [li.querySelector("strong").textContent, li.querySelector(".conn-kind").textContent, (li.querySelector(".conn-outcome") || {}).textContent || ""])');
  assert(JSON.stringify(rows) === JSON.stringify([['GitHub · create_issue', 'Change', 'Declined'], ['Notion · search', 'Read', '']]), JSON.stringify(rows));
  assert(await js('document.querySelector(".conn-activity .empty").hidden'), 'the empty note still shows');
  // A service whose sign-in can be turned down shows the way round in its form (Figma's).
  const figma = { id: 'figma', name: 'Figma', category: 'Design', url: 'https://mcp.figma.com/mcp', auth: 'oauth', blurb: 'Designs.', scope: '',
    help_url: 'https://help.figma.com/hc/en-us/articles/32132100833559', help: 'Or add http://127.0.0.1:3845/mcp under Add any tool.', connected: false };
  await js(`__ev(${JSON.stringify({ ...conns, catalog: [figma] })}); document.querySelector('#catalog .svc').click(); true`);
  const form = await js('({ text: document.querySelector("#catalog .svc-form").textContent, guide: (document.querySelector("#catalog .svc-form a") || {}).href })');
  assert(form.text.includes('127.0.0.1:3845') && form.guide === figma.help_url, JSON.stringify(form));
  await frames();  // the cards drawn again by that click keep their note
  assert(await js('$("connections").children[1].querySelectorAll(".conn-rescope").length') === 1, 'the note went with the redraw');
});

// ── the platform features: models on this Mac, skills, Jarvis for other apps, widgets ──

const HELLO = { type: 'hello', hub_id: 'hub-a', state: 'idle', muted: true, status: {}, activity: [], tasks: [], approvals: [], history: [], brain: {},
  prefs: { look: 'orb', language: 'en', models: [], personas: [], humor: 50, fallback_model: '', fallback_always: false, features: {} } };
const BUILTIN = [{ ref: 'haiku', label: 'Haiku 4.5', name: 'Haiku 4.5', builtin: true }, { ref: 'sonnet', label: 'Sonnet 5.5', name: 'Sonnet 5.5', builtin: true }];

test('Settings › Brain finds a model server on this Mac, adds it, and runs Jarvis offline on it', async () => {
  await loadFeatures('local-models.js', 'local-models.css');
  await js(`__ev(${JSON.stringify({ ...HELLO, providers: { models: BUILTIN, providers: [] } })})`);
  assert((await sentOf('local_models_scan')).length === 1, 'it did not look for servers');
  await js(`__ev({ type: 'local_models', servers: [{ port: 11434, name: 'Ollama', models: ['qwen3', 'llama3.2'], count: 2, added: '' }] })`);
  const line = await js('document.querySelector("#lm-servers .lm-server").textContent');
  assert(line.includes('Ollama') && line.includes('qwen3, llama3.2'), line);
  assert(await js('$("lm-offline").hidden'), 'offline mode shown with no local model added');
  assert(await clickText('#lm-servers', 'Add to Jarvis'), 'no Add to Jarvis');
  assert(JSON.stringify(await sentOf('local_models_add')) === '[{"type":"local_models_add","port":11434}]', 'the add was not asked for');
  const local = { ref: 'custom:m1', provider: 'p1', name: 'qwen3 · Ollama', label: 'qwen3', model: 'qwen3', builtin: false };
  await js(`__ev({ type: 'providers', providers: [{ id: 'p1', kind: 'openai', base_url: 'http://localhost:11434', name: 'Ollama', models: [] }], models: ${JSON.stringify([...BUILTIN, local])} })`);
  assert(!(await js('$("lm-offline").hidden')), 'offline mode not offered for a model on this Mac');
  await js('__sent.length = 0; $("sw-offline").click()');
  const asked = await sentOf('set_prefs');
  assert(JSON.stringify(asked) === '[{"type":"set_prefs","changes":{"fallback_model":"custom:m1","fallback_always":true}}]', JSON.stringify(asked));
  await js(`__ev({ type: 'prefs', ...${JSON.stringify(HELLO.prefs)}, fallback_model: 'custom:m1', fallback_always: true })`);
  const shown = await js('({ on: $("sw-offline").getAttribute("aria-checked"), note: $("lm-offline-note").textContent, own: !!$("lm-offline-note").querySelector("[data-no-i18n]") })');
  assert(shown.on === 'true' && shown.note.includes('qwen3 · Ollama') && shown.own, JSON.stringify(shown));
  const options = await js('[...$("utility-model").options].map((o) => o.value)');
  assert(JSON.stringify(options) === '["haiku","sonnet","custom:m1"]', JSON.stringify(options));
  await js('__sent.length = 0; $("utility-model").value = "sonnet"; $("utility-model").dispatchEvent(new Event("change"))');
  assert(JSON.stringify(await sentOf('feature_prefs')) === '[{"type":"feature_prefs","changes":{"utility_model":"sonnet"}}]', 'the utility model was not set');
});

test('Settings › Skills: switches, previews, installs and the Workshop’s drafts, all as data', async () => {
  await loadFeatures('skills.js', 'skills.css');
  await js(`__ev(${JSON.stringify(HELLO)})`);
  assert((await sentOf('skills_state')).length === 1, 'the skills were not asked for');
  const skills = {
    type: 'skills', offer: true, folder: '/x/skills', note: '', error: '',
    items: [
      { name: 'alpha', description: 'Does <b>it</b>.', on: false, usable: true, problems: [], source: 'git:https://github.com/o/r', allowed_tools: 'Bash', files: 1 },
      { name: 'needs-ffmpeg', description: 'Video.', on: false, usable: false, problems: ['It needs ffmpeg, which this Mac doesn’t have.'], source: '', allowed_tools: '', files: 0 },
    ],
    proposals: [{ id: 'abc123def456', name: 'weekly-report', description: 'Sums up the week.', text: '---\nname: weekly-report\n---\n<img src=x onerror="window.__owned=1">', request: 'Put together my weekly report' }],
  };
  await js(`__ev(${JSON.stringify(skills)})`);
  const shown = await js(`(() => {
    const rows = [...document.querySelectorAll('#skills-list .sk-skill')];
    return { names: rows.map((r) => r.querySelector('.sk-name').textContent), bold: document.querySelectorAll('#skills-group b').length,
      data: rows.every((r) => r.querySelector('.sk-name').closest('[data-no-i18n]')), disabled: rows[1].querySelector('.switch').disabled,
      problem: rows[1].querySelector('.sk-problem').textContent, from: rows[0].querySelector('.sk-source').textContent };
  })()`);
  assert(JSON.stringify(shown.names) === '["alpha","needs-ffmpeg"]' && shown.bold === 0 && shown.data, JSON.stringify(shown));
  assert(shown.disabled && shown.problem.includes('ffmpeg') && shown.from === 'From git: https://github.com/o/r', JSON.stringify(shown));
  await js('__sent.length = 0; document.querySelector("#skills-list .sk-skill .switch").click()');
  assert(JSON.stringify(await sentOf('skills_toggle')) === '[{"type":"skills_toggle","name":"alpha","on":true}]', 'the switch did not ask');
  assert(await clickText('#skills-list .sk-skill:first-child', 'Preview'), 'no Preview');
  assert((await sentOf('skills_preview')).length === 1, 'the preview was not asked for');
  await js(`__ev({ type: 'skills_preview', name: 'alpha', text: '# Alpha\\n<script>window.__owned=1</script>', files: ['reference.md'] })`);
  assert((await js('document.querySelector("#skills-list .sk-text").textContent')).includes('<script>'), 'the preview is not shown as text');
  assert(await clickText('#skills-drafts', 'Read it'), 'no Read it');
  assert(await js('document.querySelector("#skills-drafts .sk-text").textContent.includes("<img")') && !(await js('window.__owned')), 'a draft ran as markup');
  await js('__sent.length = 0');
  assert(await clickText('#skills-drafts', 'Add to my skills'), 'no Add to my skills');
  assert(await clickText('#skills-drafts', 'Discard'), 'no Discard');
  assert(JSON.stringify(await js('__sent.map((m) => m.type + " " + m.id)')) === '["skills_accept abc123def456","skills_discard abc123def456"]', 'the draft buttons');
  await js('__sent.length = 0; $("skills-git").value = "https://github.com/owner/skills"');
  assert(await clickText('#skills-group', 'Install from git'), 'no Install from git');
  await js('window.prompt = () => "/Users/x/Downloads/beta"; window.confirm = () => true; true');
  assert(await clickText('#skills-group', 'Install from a folder…'), 'no Install from a folder');
  await frames(2);
  assert(await clickText('#skills-list .sk-skill:first-child', 'Remove'), 'no Remove');
  const asked = await js('__sent.map((m) => JSON.stringify(m))');
  assert(JSON.stringify(asked) === JSON.stringify([
    '{"type":"skills_install_git","url":"https://github.com/owner/skills"}',
    '{"type":"skills_install_folder","path":"/Users/x/Downloads/beta"}',
    '{"type":"skills_remove","name":"alpha"}']), JSON.stringify(asked));
  await js(`__ev(${JSON.stringify({ ...skills, error: 'That isn’t a folder.' })})`);
  assert(await js('$("skills-status").textContent === "That isn’t a folder." && $("skills-status").classList.contains("bad")'), 'the error is not shown');
});

test('Settings › Brain: the background tasks’ model', async () => {
  await loadFeatures('local-models.js', 'local-models.css');
  await js(`__ev(${JSON.stringify({ ...HELLO, providers: { models: BUILTIN, providers: [] } })})`);
  assert(await js('$("background-model").value') === 'sonnet', 'Sonnet is not the default');
  await js('__sent.length = 0; $("background-model").value = "haiku"; $("background-model").dispatchEvent(new Event("change"))');
  assert(JSON.stringify(await sentOf('feature_prefs')) === '[{"type":"feature_prefs","changes":{"background_model":"haiku"}}]', 'the model was not set');
  await js(`__ev({ type: 'prefs', ...${JSON.stringify(HELLO.prefs)}, features: { background_model: 'opus' } })`);
  assert(await js('$("background-model").value') === 'opus', 'the kept model is not shown');
});

test('Settings › Jarvis in other apps: on and off, asking first, the lines to paste and what apps did', async () => {
  await loadFeatures('jarvis-mcp.js', 'jarvis-mcp.css');
  await js(`__ev(${JSON.stringify(HELLO)})`);
  assert((await sentOf('mcp_state')).length === 1, 'the state was not asked for');
  const off = { type: 'jarvis_mcp', enabled: false, ask: true, running: false, error: '', sessions: [], recent: [], tools: ['search_notes', 'read_note', 'recall', 'calendar', 'notify_me'],
    code_command: "claude mcp add --scope user jarvis -- '/Users/o/Investment agent/jarvis/.venv/bin/jarvis' mcp",
    desktop_json: '{\n  "mcpServers": {\n    "jarvis": {\n      "command": "/Users/o/Investment agent/jarvis/.venv/bin/jarvis",\n      "args": ["mcp"]\n    }\n  }\n}' };
  await js(`__ev(${JSON.stringify(off)})`);
  let shown = await js('({ on: $("sw-mcp").getAttribute("aria-checked"), ask: $("sw-mcp-ask").disabled, setup: $("mcp-setup").hidden, status: $("mcp-status").textContent })');
  assert(shown.on === 'false' && shown.ask && shown.setup && shown.status === 'Off: no app can reach Jarvis.', JSON.stringify(shown));
  await js('__sent.length = 0; $("sw-mcp").click()');
  assert(JSON.stringify(await sentOf('mcp_enable')) === '[{"type":"mcp_enable","on":true}]', 'the switch did not ask');
  const recent = [
    { at: '2026-09-30T09:15:00', app: 'Claude <b>Code</b>', tool: 'search_notes', ok: true },
    { at: '2026-09-30T09:16:00', app: 'Claude Desktop', tool: 'notify_me', ok: false },
  ];
  await js(`__ev(${JSON.stringify({ ...off, enabled: true, running: true, recent })})`);
  shown = await js(`({ on: $("sw-mcp").getAttribute("aria-checked"), setup: $("mcp-setup").hidden, status: $("mcp-status").textContent,
    cli: $("mcp-code-cli").textContent, desktop: JSON.parse($("mcp-code-desktop").textContent).mcpServers.jarvis.args[0],
    data: !!$("mcp-code-cli").closest("[data-no-i18n]"), bold: document.querySelectorAll("#mcp-group b").length,
    rows: [...document.querySelectorAll("#mcp-recent li")].map((li) => [li.querySelector(".mcp-app").textContent, li.lastChild.textContent, li.className]) })`);
  assert(shown.on === 'true' && !shown.setup && shown.status.startsWith('On: ') && shown.cli === off.code_command && shown.desktop === 'mcp' && shown.data, JSON.stringify(shown));
  assert(shown.bold === 0 && JSON.stringify(shown.rows) === JSON.stringify([['Claude <b>Code</b>', 'Searched your second brain', ''], ['Claude Desktop', 'Sent you a heads-up', 'mcp-failed']]), JSON.stringify(shown));
  await js('__sent.length = 0; $("sw-mcp-ask").click()');
  assert(JSON.stringify(await sentOf('mcp_ask')) === '[{"type":"mcp_ask","on":false}]', 'the ask switch did not ask');
  await js(`__ev(${JSON.stringify({ ...off, enabled: true, error: 'It couldn’t start (the socket didn’t open).' })})`);
  assert(await js('$("mcp-status").classList.contains("bad") && $("mcp-status").textContent.includes("couldn’t start")'), 'the error is not shown');
});

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('A picture on a card, opened only by its id; Settings › Pictures', async () => {
  await loadFeatures('pictures.js', 'pictures.css');
  await js(`__ev(${JSON.stringify(HELLO)})`);
  assert((await sentOf('pictures_state')).length === 1, 'the state was not asked for');
  await js(`__ev({ type: 'pictures', key: false, model: 'gemini-2.5-flash-image', default_model: 'gemini-2.5-flash-image', folder: '/Users/o/Documents/Jarvis/Images', cost: 'about 4 cents a picture' })`);
  assert((await js('$("pictures-status").textContent')).startsWith('To make pictures, add a Google Gemini key'), 'no key: not said');
  await js(`__ev({ type: 'pictures', key: true, model: 'gemini-2.5-flash-image', default_model: 'gemini-2.5-flash-image', folder: '/x', cost: 'about 4 cents a picture' })`);
  assert((await js('$("pictures-status").textContent')).startsWith('Ask for a picture'), 'the key is not taken in');
  const made = { type: 'image_made', rid: 'r1', id: 'abc123', name: '2026-09-30 091500 a <b>fox</b>.png', path: '/x/a.png', mime: 'image/png', data: PNG_1PX,
    prompt: 'A fox <img src=x onerror="window.__owned=1">', cost: 'about 4 cents a picture' };
  await js('__sent.length = 0');
  await js(`__ev(${JSON.stringify(made)})`);
  const card = await js(`(() => { const c = document.querySelector('#cards .pic-card'); return { src: c.querySelector('img').src.slice(0, 22), prompt: c.querySelector('.pic-prompt').textContent,
    bold: c.querySelectorAll('b').length, imgs: c.querySelectorAll('img').length, text: c.textContent, data: !!c.querySelector('.pic-prompt').closest('[data-no-i18n]') }; })()`);
  assert(card.src === 'data:image/png;base64,' && card.prompt === made.prompt && card.bold === 0 && card.imgs === 1 && card.data, JSON.stringify(card));
  assert(card.text.includes('a <b>fox</b>.png') && card.text.includes('Billed to your Gemini key: about 4 cents a picture') && !(await js('window.__owned')), JSON.stringify(card));
  assert(await clickText('#cards .pic-card', 'Open') && await clickText('#cards .pic-card', 'Show in Finder'), 'no Open or Show in Finder');
  assert(JSON.stringify(await js('__sent.map((m) => m.type + " " + m.id)')) === '["image_open abc123","image_reveal abc123"]', 'the buttons');
  await js(`__ev(${JSON.stringify({ ...made, id: 'def', mime: 'text/html' })}); __ev(${JSON.stringify({ ...made, id: 'ghi', data: 'x");alert(1);("' })})`);
  assert(await js('[...document.querySelectorAll("#cards .pic-card img")].slice(1).every((i) => !i.getAttribute("src"))'), 'a picture that isn’t one was shown');
  await js('__sent.length = 0; $("image-model").value = "gemini-3-pro-image-preview"; $("image-model").dispatchEvent(new Event("change"))');
  assert(JSON.stringify(await sentOf('feature_prefs')) === '[{"type":"feature_prefs","changes":{"image_model":"gemini-3-pro-image-preview"}}]', 'the model was not set');
  await js('__sent.length = 0');
  assert(await clickText('#pictures-group', 'Show the Images folder') && (await sentOf('pictures_folder')).length === 1, 'the folder was not asked for');
});

// A widget document that tries to reach the window from its sandbox, and says what it got.
const PROBE = `<!doctype html><p>probe</p><script>
  const got = { origin: self.origin, referrer: document.referrer };
  try { got.parent = parent.document.title; } catch (e) { got.parent = 'blocked'; }
  try { got.address = parent.location.href; } catch (e) { got.address = 'blocked'; }
  try { localStorage.setItem('x', '1'); got.storage = 'open'; } catch (e) { got.storage = 'blocked'; }
  try { got.cookie = document.cookie; } catch (e) { got.cookie = 'blocked'; }
  parent.postMessage(got, '*');
</script>`;
const WID = 'Wd9_-Abcdefghijklmnopqrs';

test('A widget: on a card and the dashboard, sealed in its sandbox, pinned and taken off', async () => {
  WIDGET_DOCS.set(`/f/widgets/${WID}`, PROBE);
  WIDGET_DOCS.set('/f/widgets/Quiet-Abcdefghijklmnopq', '<!doctype html><svg width="10" height="10"></svg>');
  await loadFeatures('widgets.js', 'widgets.css');
  await js('window.__probes = []; window.addEventListener("message", (e) => __probes.push(e.data)); true');  // the test's ears, not the window's
  await js(`__ev(${JSON.stringify(HELLO)})`);
  assert((await sentOf('widgets_state')).length === 1, 'the pinned ones were not asked for');
  const widget = { type: 'widget', rid: 'r1', id: WID, title: 'The <b>week</b>', url: `/f/widgets/${WID}`, scripts: true, height: 300, made: '', pinned: false };
  await js(`__ev(${JSON.stringify(widget)})`);
  const frame = await js(`(() => { const f = document.querySelector('#cards .wg-card iframe'); return { sandbox: f.getAttribute('sandbox'), ref: f.getAttribute('referrerpolicy'), src: f.getAttribute('src'),
    height: f.height, title: document.querySelector('#cards .wg-card .card-title').textContent, bold: document.querySelectorAll('#cards b').length }; })()`);
  assert(frame.sandbox === 'allow-scripts' && frame.ref === 'no-referrer' && frame.src === widget.url && frame.height === '300', JSON.stringify(frame));
  assert(frame.title === 'The <b>week</b>' && frame.bold === 0, JSON.stringify(frame));
  for (let i = 0; i < 300 && !(await js('__probes.length')); i++) await sleep(50);  // a busy Mac: up to 15 s
  const [probe] = await js('__probes');
  assert(probe, 'the widget never loaded');
  assert(probe.origin === 'null' && probe.parent === 'blocked' && probe.address === 'blocked' && probe.storage === 'blocked' && probe.referrer === '', JSON.stringify(probe));
  // One without scripts gets no scripts at all (sandbox=""); an address not its own never loads.
  await js(`__ev(${JSON.stringify({ ...widget, id: 'Quiet-Abcdefghijklmnopq', url: '/f/widgets/Quiet-Abcdefghijklmnopq', scripts: false })})`);
  await js(`__ev(${JSON.stringify({ ...widget, id: 'Far-Abcdefghijklmnopqrs', url: 'https://example.com/w' })})`);
  const others = await js('[...document.querySelectorAll("#cards .wg-card iframe")].slice(1).map((f) => [f.getAttribute("sandbox"), f.getAttribute("src")])');
  assert(JSON.stringify(others) === '[["","/f/widgets/Quiet-Abcdefghijklmnopq"],["allow-scripts",null]]', JSON.stringify(others));
  await js('__sent.length = 0');
  assert(await clickText('#cards .wg-card', 'Pin to dashboard'), 'no Pin to dashboard');
  assert(JSON.stringify(await sentOf('widget_pin')) === `[{"type":"widget_pin","id":"${WID}"}]`, 'the pin was not asked for');
  const listed = { id: WID, title: widget.title, url: widget.url, scripts: true, height: 300, made: '', pinned: true };
  await js(`__ev(${JSON.stringify({ type: 'widgets', pinned: [listed], error: '' })})`);
  const board = await js(`({ hidden: $('p-widgets').hidden, titles: [...document.querySelectorAll('#wg-list .wg-title')].map((n) => n.textContent),
    sandbox: document.querySelector('#wg-list iframe').getAttribute('sandbox'), pin: document.querySelector('#cards .wg-card .btn.primary').disabled })`);
  assert(!board.hidden && JSON.stringify(board.titles) === '["The <b>week</b>"]' && board.sandbox === 'allow-scripts' && board.pin, JSON.stringify(board));
  await js('__sent.length = 0; document.querySelector("#wg-list .wg-remove").click()');
  assert(JSON.stringify(await sentOf('widget_remove')) === `[{"type":"widget_remove","id":"${WID}"}]`, 'the remove was not asked for');
  await js(`__ev({ type: 'widgets', pinned: [], error: 'The dashboard holds 12 widgets; remove one first.' })`);
  const after = await js(`({ hidden: $('p-widgets').hidden, pin: document.querySelector('#cards .wg-card .btn.primary').disabled, notice: [...document.querySelectorAll('#cards .card')].some((c) => c.textContent.includes('holds 12 widgets')) })`);
  assert(after.hidden && !after.pin && after.notice, JSON.stringify(after));
  WIDGET_DOCS.clear();
});

// ── Memory (features/memory.js): its rows and sheet, its cards, and "Do it" on an intent ──

const MEM_FACTS = [
  { id: 'a1', text: 'Ann Lee is my co-founder <img src=x onerror="window.__pwned=1">', at: '2026-09-22T10:00:00', category: 'people', confidence: 'high', expires: '', source: 'said', origin: 'remember Ann is my co-founder', learned: '2026-09-22T10:00:00' },
  { id: 'b2', text: 'I am in Tokyo for the conference', at: '2026-09-23T10:00:00', category: 'places', confidence: 'medium', expires: '2099-10-12', source: 'settings', origin: 'Settings', learned: '2026-09-23T10:00:00' },
];
const memState = (extra = {}) => JSON.stringify({ type: 'memory_state', counts: { people: 1, places: 1 }, total: 2, max: 200, suggestions: { pending: [], nights: [] }, about: { about: '', behave: '', max: 4000 }, intents: [], promises: [], people: ['Ann Lee'], journal: { notes: [], folder: '/Users/x/Documents/Jarvis/Journal', time: '21:00' }, left: {}, incognito: false, ...extra });
async function withMemory() {
  await loadFeatures('memory.js', 'memory.css');
  await js(`__ev({ type: 'memory', items: ${JSON.stringify(MEM_FACTS)} }); __ev(${memState()}); __sent.length = 0; true`);
}

test('Settings › Memory opens its sheet on the row picked; the old list gives way; Escape closes only the sheet', async () => {
  await withMemory();
  await js('toggleSettings(true); __sent.length = 0; true');
  const r = await js(`({ rows: [...document.querySelectorAll('#mem-rows .mem-row')].map((b) => b.dataset.memTab), old: getComputedStyle($('memory-list')).display === 'none' && getComputedStyle($('memory-form')).display === 'none', line: $('mem-line-facts').textContent, learning: [...document.querySelectorAll('#mem-learning [role=radio]')].map((b) => b.dataset.mode + ':' + b.getAttribute('aria-checked')) })`);
  assert(JSON.stringify(r.rows) === JSON.stringify(['facts', 'suggested', 'about', 'intents', 'people', 'promises', 'journal', 'import']) && r.old && r.line === '2 facts', JSON.stringify(r));
  assert(JSON.stringify(r.learning) === '["propose:true","silent:false","off:false"]', JSON.stringify(r.learning));
  await js('document.querySelector("[data-mem-tab=intents]").click(); true');
  const open = await js('({ open: !$("mem-layer").hidden, tab: document.querySelector("#mem-pop [aria-selected=true]").dataset.tab, sent: __sent.map((m) => m.type), focus: document.activeElement && document.activeElement.id })');
  assert(open.open && open.tab === 'intents' && open.sent.includes('memory_state') && open.focus === 'mem-close', JSON.stringify(open));
  await opsPress('Escape', 'Escape', 27);
  const after = await js('({ sheet: $("mem-layer").hidden, settings: !$("settings").hidden, sent: __sent.map((m) => m.type) })');
  assert(after.sheet && after.settings && !after.sent.includes('stop'), `Escape: ${JSON.stringify(after)}`);
  await js('document.querySelector("#mem-learning [data-mode=silent]").click(); true');
  const pref = await sentOf('feature_prefs');
  assert(JSON.stringify(pref) === JSON.stringify([{ type: 'feature_prefs', changes: { memory_learning: 'silent' } }]), JSON.stringify(pref));
});

test('Facts show their category, how sure and until when; Why says where; edit and forget send what was chosen', async () => {
  await withMemory();
  await js('toggleSettings(true); document.querySelector("[data-mem-tab=facts]").click(); __sent.length = 0; true');
  const shown = await js(`({ items: [...document.querySelectorAll('#mem-tab-facts .mem-item')].map((li) => li.dataset.fact), data: document.querySelector('[data-fact=a1] .mem-fact').hasAttribute('data-no-i18n'), meta: document.querySelector('[data-fact=b2] .mem-meta').textContent, imgs: document.querySelectorAll('#mem-tab-facts img').length })`);
  assert(JSON.stringify(shown.items) === '["a1","b2"]' && shown.data && shown.imgs === 0, JSON.stringify(shown));
  assert(shown.meta.startsWith('Places · Fairly sure') && shown.meta.includes('Until'), shown.meta);
  assert(await clickText('[data-fact="a1"]', 'Why?'), 'no Why?');
  const why = await js('document.querySelector("[data-fact=a1] .mem-why").textContent');
  assert(why.includes('You told me') && why.includes('remember Ann is my co-founder'), why);
  assert(await clickText('[data-fact="b2"]', 'Why?'), 'no Why? on b2');
  const settingsWhy = await js('({ text: document.querySelector("[data-fact=b2] .mem-why").textContent, quotes: document.querySelectorAll("[data-fact=b2] .mem-why q").length })');
  assert(settingsWhy.text.startsWith('Added in Settings') && settingsWhy.quotes === 0 && !settingsWhy.text.includes('“Settings”'), JSON.stringify(settingsWhy));
  assert(await clickText('[data-fact="b2"]', 'Edit'), 'no Edit');
  await js(`(() => { const f = document.querySelector('[data-fact=b2] form'); f.querySelector('textarea').value = 'I am in Osaka for the conference'; f.querySelectorAll('select')[1].value = 'high'; f.querySelector('input[type=date]').value = ''; f.requestSubmit(); })(); true`);
  const edit = await sentOf('memory_edit');
  assert(JSON.stringify(edit) === JSON.stringify([{ type: 'memory_edit', id: 'b2', text: 'I am in Osaka for the conference', category: 'places', confidence: 'high', expires: 'never' }]), JSON.stringify(edit));
  assert(await clickText('[data-fact="a1"]', 'Forget'), 'no Forget');
  assert(JSON.stringify(await sentOf('memory_forget')) === JSON.stringify([{ type: 'memory_forget', id: 'a1' }]), 'forget');
  await js(`(() => { const f = document.querySelector('#mem-tab-facts .mem-add'); f.querySelector('input').value = 'My sister is Ada'; f.querySelector('select').value = 'people'; f.requestSubmit(); })(); true`);
  assert(JSON.stringify(await sentOf('memory_add')) === JSON.stringify([{ type: 'memory_add', text: 'My sister is Ada', category: 'people' }]), 'add');
  assert(!(await js('window.__pwned')), 'a fact became markup');
  await js(`__ev({ type: 'memory', items: ${JSON.stringify(MEM_FACTS.slice(0, 1))} }); true`);
  const chips = await js('[...document.querySelectorAll("#mem-tab-facts .mem-chip")].map((c) => c.textContent)');
  assert(JSON.stringify(chips) === '["All 1","People 1"]', `counts follow the facts: ${JSON.stringify(chips)}`);
});

test('Forgetting by where it was learned shows the list first, then forgets exactly those', async () => {
  await withMemory();
  await js('toggleSettings(true); document.querySelector("[data-mem-tab=facts]").click(); document.querySelector("#mem-tab-facts .mem-forget").open = true; __sent.length = 0; true');
  await js(`(() => { const box = document.querySelector('#mem-tab-facts .mem-forget'); box.querySelector('select').value = 'chatgpt'; })(); true`);
  assert(await clickText('#mem-tab-facts .mem-forget', 'Show what that is'), 'no Show');
  const asked = await sentOf('memory_forget_where');
  assert(JSON.stringify(asked) === JSON.stringify([{ type: 'memory_forget_where', source: 'chatgpt', day: '' }]), JSON.stringify(asked));
  await js(`__ev({ type: 'memory_forget_preview', count: 7, ids: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], examples: ['One', 'Two', 'Three', 'Four', 'Five'] }); __sent.length = 0; true`);
  const confirm = await js(`({ text: document.querySelector('#mem-tab-facts .mem-confirm p').textContent, items: document.querySelectorAll('#mem-tab-facts .mem-examples li').length })`);
  assert(confirm.text === 'This forgets 7 things:' && confirm.items === 6, JSON.stringify(confirm));
  assert(await clickText('#mem-tab-facts .mem-confirm', 'Forget 7'), 'no Forget 7');
  const done = await sentOf('memory_forget_where');
  assert(JSON.stringify(done) === JSON.stringify([{ type: 'memory_forget_where', source: 'chatgpt', day: '', confirm: true, ids: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }]), JSON.stringify(done));
});

test('Waiting suggestions and the Dream diary get cards; Remember goes to the hub, Later puts them away until something new', async () => {
  await withMemory();
  const talk = { id: 's1', text: 'Your sister Ada is a nurse', category: 'people', confidence: 'high', origin: 'conversation', quote: 'my sister Ada', day: '2026-09-29', batch: 'talk', at: '' };
  const dream = { ...talk, id: 'd1', text: 'You like Chez Panisse', origin: 'dream' };
  const state = (pending) => `__ev(${memState({ suggestions: { pending, nights: [] } })}); true`;
  await js(state([talk, dream]));
  const cards = await js('[...document.querySelectorAll("[data-memory-card]")].map((c) => c.dataset.memoryCard + ":" + c.querySelector(".card-kicker").textContent)');
  assert(JSON.stringify(cards) === '["conversation:Worth remembering?","dream:Dream diary"]', JSON.stringify(cards));
  assert(await js('document.querySelector("[data-memory-card=conversation] .mem-fact").hasAttribute("data-no-i18n")'), 'a suggestion is the owner’s data');
  assert(await clickText('[data-memory-card="conversation"]', 'Remember'), 'no Remember');
  assert(JSON.stringify(await sentOf('memory_suggestion')) === JSON.stringify([{ type: 'memory_suggestion', id: 's1', action: 'keep' }]), 'keep');
  assert(await clickText('[data-memory-card="dream"]', 'Later'), 'no Later');
  assert(await js('!document.querySelector("[data-memory-card=dream]")'), 'Later left the card');
  await js(state([talk, dream]));
  assert(await js('!document.querySelector("[data-memory-card=dream]")'), 'the card came back for the same suggestions');
  await js(state([talk, dream, { ...dream, id: 'd2', text: 'You swim on Fridays' }]));
  assert(await js('!!document.querySelector("[data-memory-card=dream]")'), 'something new brought no card');
  await js(state([]));
  assert(await js('!document.querySelector("[data-memory-card]")'), 'cards stayed with nothing waiting');
});

test('A fired intent that asks for more than a reminder gets Do it, and only that one', async () => {
  await withMemory();
  await js(`__ev({ type: 'alert', key: 'intent:i1:mail:1', alert_kind: 'intent', title: 'Ann emails about the deck', text: 'Ann Lee emailed. You asked me to: draft a reply' });
    __ev({ type: 'memory_intent_fired', key: 'intent:i1:mail:1', id: 'i1', doable: true });
    __ev({ type: 'alert', key: 'intent:i2:message:2', alert_kind: 'intent', title: 'Bob texts', text: 'Bob texted. Reminder: call him' });
    __ev({ type: 'memory_intent_fired', key: 'intent:i2:message:2', id: 'i2', doable: false }); __sent.length = 0; true`);
  const r = await js(`({ kicker: document.querySelector('[data-alert="intent:i1:mail:1"] .card-kicker').textContent, doIt: document.querySelectorAll('.mem-doit').length, second: !!document.querySelector('[data-alert="intent:i2:message:2"] .mem-doit') })`);
  assert(r.kicker === 'Reminder' && r.doIt === 1 && !r.second, JSON.stringify(r));
  assert(await clickText('[data-alert="intent:i1:mail:1"]', 'Do it'), 'no Do it');
  assert(JSON.stringify(await sentOf('memory_intent_run')) === JSON.stringify([{ type: 'memory_intent_run', id: 'i1' }]), 'run');
  assert(await js('!document.querySelector("[data-alert=\'intent:i1:mail:1\']")'), 'the card stayed');
});

test('An import is looked over first: what fits is ticked, and only what stays ticked is saved', async () => {
  await withMemory();
  await js(`__ev({ type: 'memory_import_review', id: 'r1', source: 'chatgpt', origin: 'ChatGPT export (x.zip)', items: [{ id: 'a', text: 'Likes jazz', category: 'preferences' }, { id: 'b', text: 'Has two kids', category: 'people' }, { id: 'c', text: 'Runs on Saturdays', category: 'health' }], about: 'I run a fund.', behave: '', notes: ['1 that looked like a password, key or account number was left out.'], room: 2 }); __sent.length = 0; true`);
  const r = await js(`({ open: !$('mem-layer').hidden, tab: document.querySelector('#mem-pop [aria-selected=true]').dataset.tab, ticked: [...document.querySelectorAll('#mem-tab-import .mem-pick input[type=checkbox]')].map((b) => b.checked), about: !!document.querySelector('#mem-tab-import .mem-pre[data-no-i18n]') })`);
  assert(r.open && r.tab === 'import' && JSON.stringify(r.ticked) === '[true,true,false]' && r.about, JSON.stringify(r));
  await js(`document.querySelectorAll('#mem-tab-import .mem-pick input[type=checkbox]')[1].click(); true`);
  await js(`(() => { const t = document.querySelector('#mem-tab-import .mem-pick input[type=text]'); t.value = 'Loves jazz'; t.dispatchEvent(new Event('input')); })(); true`);
  assert(await clickText('#mem-tab-import', 'Save 1'), 'no Save 1');
  const saved = await sentOf('memory_import_save');
  assert(JSON.stringify(saved) === JSON.stringify([{ type: 'memory_import_save', review: 'r1', items: [{ id: 'a', text: 'Loves jazz', category: 'preferences' }], about: true, behave: false }]), JSON.stringify(saved));
  await js(`__ev({ type: 'memory_import_review', done: true, saved: 1, left: 0 }); true`);
  assert(await js('!document.querySelector("#mem-tab-import .mem-pick")'), 'the review stayed after saving');
});

test('A standing intent and About me are sent as written', async () => {
  await withMemory();
  await js('toggleSettings(true); document.querySelector("[data-mem-tab=intents]").click(); __sent.length = 0; true');
  await js(`(() => { const f = document.querySelector('#mem-tab-intents .mem-form'); const [when, then, people] = f.querySelectorAll('input[type=text]'); when.value = 'Ann emails about the deck'; then.value = 'remind me to send the numbers'; people.value = 'Ann'; f.querySelector('input[type=checkbox][value=mail]').checked = true; f.requestSubmit(); })(); true`);
  const added = await sentOf('memory_intent_add');
  assert(JSON.stringify(added) === JSON.stringify([{ type: 'memory_intent_add', when: 'Ann emails about the deck', then: 'remind me to send the numbers', fuzzy: false, cooldown: 12, people: 'Ann', watch: ['mail'] }]), JSON.stringify(added));
  await js('document.querySelector("#mem-pop [data-tab=about]").click(); true');
  await js(`(() => { const t = document.querySelector('#mem-tab-about textarea'); t.value = 'I run a small fund.'; t.dispatchEvent(new Event('input')); })(); true`);
  const counted = await js('document.querySelector("#mem-tab-about .mem-count").textContent');
  assert(counted === '19 / 4,000', counted);
  assert(await clickText('#mem-tab-about', 'Save'), 'no Save');
  assert(JSON.stringify(await sentOf('memory_about')) === JSON.stringify([{ type: 'memory_about', about: 'I run a small fund.' }]), 'about');
});

// ── Jarvis Code's usage meter and limits (web/features/code-usage.js) ──

// A menu item with a note under its label: its button's text starts with the label.
const clickItem = (root, label) => js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(root)} + ' button')].find((x) => x.textContent.startsWith(${JSON.stringify(label)})); if (!b) return false; b.click(); return true; })()`);
const USAGE_PROJECT = '/Users/x/Projects/<b>alpha</b>';
const usageState = (extra = {}) => ({
  type: 'cu_state',
  windows: [{ kind: 'five_hour', label: '5-hour limit', status: 'allowed_warning', percent: 82, resets_at: Math.round(Date.now() / 1000) + 3600 },
    { kind: 'seven_day', label: 'weekly limit', status: 'allowed', percent: null, resets_at: null }],
  today: 3.5, recent: [{ day: '2026-09-29', total: 1 }, { day: '2026-09-30', total: 3.5 }],
  by_project: [{ project: USAGE_PROJECT, name: '<b>alpha</b>', cost: 3.5 }],
  sessions: { 1: { cost: 1.25, cap: 5, own: false, held: '', project: USAGE_PROJECT } },
  projects: { [USAGE_PROJECT]: { name: '<b>alpha</b>', today: 3.5, cap: 0, own: false } },
  defaults: { session: 5, project: 0, day: 20 }, alerts: true, ...extra,
});

test('The Usage pane shows Claude’s limits and what’s spent, and a limit typed there goes to the session', async () => {
  await featureScript('code-usage.js');
  await open(1);
  await clickAt('#jc-more');
  assert(await clickItem('#jc-menu', 'Usage and limits'), 'no Usage item in the More menu');
  assert(await js('$("jc-pane-title").textContent') === 'Usage', 'the pane did not open');
  assert((await sentOf('cu_state')).length === 1, JSON.stringify(await js('__sent')));
  await deliver(usageState());
  const r = await js(`({ text: $('jc-pane-body').textContent, meters: [...document.querySelectorAll('#jc-pane-body .cu-meter')].map((m) => m.className),
    bold: document.querySelectorAll('#jc-pane-body b').length, names: [...document.querySelectorAll('#jc-pane-body [data-no-i18n]')].map((n) => n.textContent) })`);
  assert(r.text.includes('82% used') && r.text.includes('Near the limit') && r.text.includes('Resets'), r.text);
  assert(r.text.includes('$1.25 of $5') && r.text.includes('$3.50 of $20') && r.bold === 0, r.text);
  assert(r.meters[0].includes('high') && r.names.includes('<b>alpha</b>'), JSON.stringify(r));
  await js('__sent.length = 0; window.__cap = document.querySelector("#jc-pane-body .cu-cap-input"); __cap.value = "lots"; __cap.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); true');
  assert((await sentOf('cu_cap')).length === 0, 'a limit that isn’t an amount went');
  assert((await js('document.querySelector("#jc-pane-body .cu-cap-note").textContent')).includes('like 5 or 12.50'), 'no word on what a limit is');
  await js('__cap.value = "$12.50"; __cap.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); true');
  assert(JSON.stringify(await sentOf('cu_cap')) === JSON.stringify([{ type: 'cu_cap', id: 1, scope: 'session', cap: 12.5 }]), JSON.stringify(await js('__sent')));
  // Held: the pane says why, and the session's own limit can go back to the default. (The
  // pane isn't redrawn under a limit being typed: the field is left first.)
  await js('document.activeElement.blur(); true');
  await deliver(usageState({ sessions: { 1: { cost: 5, cap: 5, own: true, held: 'On hold: this session has spent its $5 limit. Raise it in Usage to go on.', project: USAGE_PROJECT } } }));
  assert(await js('!!document.querySelector("#jc-pane-body .cu-held")'), 'the hold isn’t shown');
  await js('__sent.length = 0; true');
  assert(await clickText('#jc-pane-body', 'Use the default'), 'no way back to the default');
  assert(JSON.stringify(await sentOf('cu_cap')) === JSON.stringify([{ type: 'cu_cap', id: 1, scope: 'session', cap: null }]), JSON.stringify(await js('__sent')));
});

test('Jarvis Code settings has a Limits tab with the default limits and the heads-ups switch', async () => {
  await featureScript('code-usage.js');
  await deliver({ type: 'prefs', look: 'orb', language: 'en', models: [], personas: [], humor: 50, features: { code_budget_session: 5, code_budget_alerts: false } });
  await open(1);
  await js('openJcSettings(); selectJcsTab("limits"); true');
  const r = await js(`({ shown: !$('jcs-limits').hidden, general: $('jcs-general').hidden, session: document.querySelector('[data-key="code_budget_session"]').value,
    day: document.querySelector('[data-key="code_budget_day"]').value, alerts: $('cu-alerts').getAttribute('aria-checked') })`);
  assert(r.shown && r.general && r.session === '5' && r.day === '' && r.alerts === 'false', JSON.stringify(r));
  await js('__sent.length = 0; $("cu-alerts").click(); window.__day = document.querySelector("[data-key=code_budget_day]"); __day.value = "20"; __day.dispatchEvent(new Event("change")); true');
  const sent = await sentOf('feature_prefs');
  assert(JSON.stringify(sent.map((m) => m.changes)) === JSON.stringify([{ code_budget_alerts: true }, { code_budget_day: 20 }]), JSON.stringify(sent));
  await js('selectJcsTab("general"); true');
  assert(await js('$("jcs-limits").hidden && !$("jcs-general").hidden'), 'the Limits tab stayed over General');
});

// ── Subagent lanes (web/features/code-lanes.js) ──

test('The Subagents pane shows each subagent as a tree, and Stop stops just that one', async () => {
  await featureScript('code-lanes.js');
  await open(1);
  await clickAt('#jc-more');
  assert(!(await clickItem('#jc-menu', 'Subagents')), 'a Subagents item before there are any');
  await js('closeMenu(); true');
  const lane = (id, extra) => ({ id, parent: '', agent: 'Explore', description: 'Find the <img src=x onerror="window.__pwned=1"> code', status: 'running', background: false, steps: 3, last: 'Reading auth.py', tokens: 45200, seconds: 63, cost: 0.083, models: [], can_stop: true, ...extra });
  await deliver({ type: 'cl_lanes', id: 1, lanes: [lane('a1'), lane('a2', { parent: 'a1', agent: 'test-runner', status: 'done', can_stop: false, cost: null }), lane('a3', { background: true })] });
  await clickAt('#jc-more');
  assert(await clickItem('#jc-menu', 'Subagents'), 'no Subagents item once there are some');
  assert(await js('$("jc-pane-title").textContent') === 'Subagents', 'the pane did not open');
  const r = await js(`({ rows: [...document.querySelectorAll('#jc-pane-body .cl-lane')].map((li) => li.dataset.lane + (li.classList.contains('nested') ? '>' : '')),
    text: $('jc-pane-body').textContent, imgs: document.querySelectorAll('#jc-pane-body img').length, pwned: !!window.__pwned,
    stops: document.querySelectorAll('#jc-pane-body .cl-stop').length, data: !!document.querySelector('#jc-pane-body .cl-desc[data-no-i18n]') })`);
  assert(r.rows.join() === 'a1,a2>,a3', JSON.stringify(r));
  assert(r.text.includes('45.2k') && r.text.includes('1m 3s') && r.text.includes('≈ $0.08') && r.text.includes('Background'), r.text);
  assert(r.imgs === 0 && !r.pwned && r.data && r.stops === 2, JSON.stringify(r));
  await js('__sent.length = 0; document.querySelector(\'#jc-pane-body [data-lane="a3"] .cl-stop\').click(); true');
  assert(JSON.stringify(await sentOf('cl_stop')) === JSON.stringify([{ type: 'cl_stop', id: 1, lane: 'a3' }]), JSON.stringify(await js('__sent')));
});

// ── Claude Code's questions (web/features/code-ask.js) ──

const askCard = (id, multi, extra = {}) => ({ type: 'approval', id, task_id: 1, tool: 'AskUserQuestion', ask_kind: 'question', question: 'What should run in <b>CI</b>?', detail: '',
  header: 'CI', multi, free_choices: ['pick', 'other'],
  options: [{ label: 'Unit tests', description: 'fast' }, { label: '<img src=x onerror="window.__pwned=1">', description: '' }, { label: 'Linting', description: '' }],
  choices: [{ id: 'opt0', label: 'Unit tests' }, { id: 'opt1', label: 'x' }, { id: 'opt2', label: 'Linting' }, { id: 'skip', label: 'Skip' }], ...extra });
const approves = () => js('__sent.filter((m) => m.type === "approve").map((m) => [m.id, m.choice, m.feedback])');

test('A question that takes several answers: number keys tick them, Answer sends them all', async () => {
  await featureScript('code-ask.js');
  await open(1);
  await deliver(askCard('q1', true));
  const r = await js(`({ sheet: !!document.querySelector('#deck-timeline > .jc-ask.cq-multi[data-approval="q1"]'), ticks: document.querySelectorAll('#deck-timeline .cq-tick').length,
    imgs: document.querySelectorAll('#deck-timeline .jc-ask img, #cards img').length, pwned: !!window.__pwned, bold: document.querySelectorAll('#deck-timeline b').length,
    send: document.querySelector('#deck-timeline .cq-send').disabled })`);
  assert(r.sheet && r.ticks === 3 && r.imgs === 0 && !r.pwned && r.bold === 0 && r.send, JSON.stringify(r));
  await js('document.activeElement.blur(); true');
  await key('1');
  await key('3');
  assert((await approves()).length === 0, 'a number key answered a question that takes several');
  const ticked = await js('[...document.querySelectorAll("#deck-timeline .cq-tick")].map((x) => x.checked)');
  assert(ticked.join() === 'true,false,true', JSON.stringify(ticked));
  await js('window.__o = document.querySelector("#deck-timeline .cq-other-input"); __o.value = "and a smoke test"; __o.dispatchEvent(new Event("input")); true');
  await js('document.querySelector("#deck-timeline .cq-send").click(); true');
  assert(JSON.stringify(await approves()) === JSON.stringify([['q1', 'pick', '{"picked":[0,2],"other":"and a smoke test"}']]), JSON.stringify(await approves()));
  assert(await js('!document.querySelector("[data-approval=q1]")'), 'the sheet and card stayed');
});

test('A question with one answer: a number picks it, or the owner’s own words go instead', async () => {
  await featureScript('code-ask.js');
  await open(1);
  await deliver(askCard('q2', false));
  assert(await js('!!document.querySelector("#deck-timeline > .jc-ask.cq-sheet .cq-choice") && !document.querySelector("#deck-timeline .cq-tick")'), 'no option buttons');
  await js('document.activeElement.blur(); true');
  await key('3');
  assert(JSON.stringify(await approves()) === JSON.stringify([['q2', 'opt2', '']]), JSON.stringify(await approves()));
  await deliver({ type: 'approval_resolved', id: 'q2' });  // (as the hub says once it's answered)
  await js('__sent.length = 0; true');
  await deliver(askCard('q3', false));
  await js('window.__o = document.querySelector("#deck-timeline .cq-other-input"); __o.focus(); true');
  await type('only lint');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  assert(JSON.stringify(await approves()) === JSON.stringify([['q3', 'other', 'only lint']]), JSON.stringify(await approves()));
  await deliver({ type: 'approval_resolved', id: 'q3' });
  // Outside Jarvis Code, its card has the same options.
  await js('__sent.length = 0; toggleCC(false); true');
  await deliver(askCard('q4', false, { task_id: 2 }));
  assert(await js('!!document.querySelector("#cards [data-approval=q4] .cq-card .cq-choice")'), 'the card has no options');
  await js('[...document.querySelectorAll("#cards [data-approval=q4] .cq-skip")][0].click(); true');
  assert(JSON.stringify(await approves()) === JSON.stringify([['q4', 'skip', '']]), JSON.stringify(await approves()));
  // An approval that isn't such a question keeps the usual buttons.
  await deliver({ type: 'approval', id: 'b1', task_id: 2, tool: 'Bash', question: 'Run this command?', detail: '$ npm test', choices: [{ id: 'allow', label: 'Yes' }, { id: 'deny', label: 'No' }] });
  assert(await js('!document.querySelector("#cards [data-approval=b1] .cq") && document.querySelectorAll("#cards [data-approval=b1] .card-actions button").length === 2'), 'an ordinary card changed');
});

// ── Permission rules (web/features/code-rules.js) ──

const rulesState = (extra = {}) => ({ type: 'cr_state', id: 1, project: '/Users/x/<b>alpha</b>', name: '<b>alpha</b>',
  rules: { deny: ['WebFetch(domain:evil.com)'], ask: ['Bash(git push:*)'], allow: ['Read(src/<img src=x onerror="window.__pwned=1">)'] },
  legacy: ['git commit'], claude: { 'settings.json': { allow: ['Bash(npm test:*)'] } }, ...extra });

test('The Permissions pane lists the project’s rules, adds and removes them, and imports and exports them', async () => {
  await featureScript('code-rules.js');
  await open(1);
  await js('openPane("rules"); true');
  assert(await js('$("jc-pane-title").textContent') === 'Permissions', 'the pane did not open');
  assert((await sentOf('cr_state')).length === 1, JSON.stringify(await js('__sent')));
  await deliver(rulesState());
  const r = await js(`({ groups: [...document.querySelectorAll('#jc-pane-body .cr-group')].map((g) => g.className), text: $('jc-pane-body').textContent,
    rules: [...document.querySelectorAll('#jc-pane-body .cr-group code[data-no-i18n]')].map((c) => c.textContent),
    imgs: document.querySelectorAll('#jc-pane-body img, #jc-pane-body b').length, pwned: !!window.__pwned,
    ro: !!document.querySelector('#jc-pane-body .jc-audit-switch .sw') })`);
  assert(r.groups.join() === 'cr-group deny,cr-group ask,cr-group allow', JSON.stringify(r));
  assert(r.rules[0] === 'WebFetch(domain:evil.com)' && r.rules[1] === 'Bash(git push:*)' && r.imgs === 0 && !r.pwned, JSON.stringify(r));
  assert(r.ro && r.text.includes('git commit …') && r.text.includes('Bash(npm test:*)'), r.text);
  await js('__sent.length = 0; document.querySelectorAll("#jc-pane-body .cr-group.ask .cr-remove")[0].click(); true');
  assert(JSON.stringify(await sentOf('cr_remove')) === JSON.stringify([{ type: 'cr_remove', id: 1, behavior: 'ask', rule: 'Bash(git push:*)' }]), JSON.stringify(await js('__sent')));
  // A rule added: allow, typed, Enter.
  await js('document.querySelector("#jc-pane-body .cr-seg-allow").click(); window.__f = document.querySelector("#jc-pane-body .cr-input"); __f.focus(); true');
  await typeText('WebFetch(domain:python.org)');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  assert(JSON.stringify(await sentOf('cr_add')) === JSON.stringify([{ type: 'cr_add', id: 1, behavior: 'allow', rule: 'WebFetch(domain:python.org)' }]), JSON.stringify(await js('__sent')));
  // Not a rule: the reason shows, and what was typed stays; added: the field starts over.
  await deliver(rulesState({ error: 'A WebFetch rule names a domain: WebFetch(domain:example.com).' }));
  assert(await js('document.querySelector("#jc-pane-body .cr-error").textContent.includes("names a domain") && document.querySelector("#jc-pane-body .cr-input").value === "WebFetch(domain:python.org)"'), 'the error or the draft is gone');
  await deliver(rulesState({ added: 'WebFetch(domain:python.org)' }));
  assert(await js('document.querySelector("#jc-pane-body .cr-input").value === "" && document.querySelector("#jc-pane-body .cr-seg-allow").getAttribute("aria-checked") === "true"'), 'the field kept the added rule');
  // Import at once; export only on a second press.
  await js('__sent.length = 0; document.querySelector("#jc-pane-body .cr-import").click(); document.querySelector("#jc-pane-body .cr-export[data-target=local]").click(); true');
  assert(JSON.stringify((await js('__sent')).map((m) => m.type)) === JSON.stringify(['cr_import']), JSON.stringify(await js('__sent')));
  assert(await js('document.querySelector("#jc-pane-body .cr-export[data-target=local]").classList.contains("armed")'), 'the export isn’t armed');
  await js('document.querySelector("#jc-pane-body .cr-export[data-target=local]").click(); true');
  assert(JSON.stringify(await sentOf('cr_export')) === JSON.stringify([{ type: 'cr_export', id: 1, target: 'local' }]), JSON.stringify(await js('__sent')));
  // The "don't ask again" commands and the read-only switch, as before.
  await js('__sent.length = 0; [...document.querySelectorAll("#jc-pane-body .cr-list li")].find((li) => li.textContent.includes("git commit")).querySelector("button").click(); document.querySelector("#jc-pane-body .jc-audit-switch .sw").click(); true');
  const sent = await js('__sent');
  assert(JSON.stringify(sent) === JSON.stringify([{ type: 'task_rules', id: 1, remove: 'git commit' }, { type: 'set_prefs', changes: { code_read_only: false } }]), JSON.stringify(sent));
});

test('The Permissions pane’s Sandbox section: the switch, this session’s own choice, and the project’s domains', async () => {
  await featureScript('code-rules.js');
  await open(1);
  await js('openPane("rules"); true');
  assert((await sentOf('cs_state')).length === 1, JSON.stringify(await js('__sent')));
  await deliver(rulesState());
  await deliver({ type: 'cs_state', id: 1, on: true, own: null, default: true, bypass: true, unattended: false, live: false, project: '/x/alpha', name: 'alpha',
    domains: ['registry.npmjs.org', '<img src=x onerror="window.__pwned=1">'], presets: { npm: ['registry.npmjs.org'], pypi: ['pypi.org'], github: ['github.com'] } });
  const r = await js(`({ sw: document.querySelector('#jc-pane-body .cs-switch').getAttribute('aria-checked'), line: document.querySelector('#jc-pane-body .cs-line').textContent,
    domains: [...document.querySelectorAll('#jc-pane-body .cs-domains code[data-no-i18n]')].map((c) => c.textContent), imgs: document.querySelectorAll('#jc-pane-body img').length,
    pwned: !!window.__pwned, seg: [...document.querySelectorAll('#jc-pane-body .cs-seg button')].map((b) => b.getAttribute('aria-checked')).join() })`);
  assert(r.sw === 'true' && r.line.includes('from its next step') && r.seg === 'true,false,false', JSON.stringify(r));
  assert(r.domains[0] === 'registry.npmjs.org' && r.domains.length === 2 && r.imgs === 0 && !r.pwned, JSON.stringify(r));
  await js('__sent.length = 0; [...document.querySelectorAll("#jc-pane-body .cs-seg button")][2].click(); [...document.querySelectorAll("#jc-pane-body .cs-seg button")][0].click(); true');
  assert(JSON.stringify(await sentOf('cs_session')) === JSON.stringify([{ type: 'cs_session', id: 1, on: false }, { type: 'cs_session', id: 1, on: null }]), JSON.stringify(await js('__sent')));
  await js('__sent.length = 0; window.__d = document.querySelector("#jc-pane-body .cs-input"); __d.focus(); true');
  await typeText('pypi.org, files.pythonhosted.org');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await js('document.querySelector("#jc-pane-body .cs-preset[data-preset=github]").click(); [...document.querySelectorAll("#jc-pane-body .cs-domains li")][0].querySelector("button").click(); true');
  assert(JSON.stringify(await sentOf('cs_domains')) === JSON.stringify([{ type: 'cs_domains', id: 1, add: ['pypi.org', 'files.pythonhosted.org'] },
    { type: 'cs_domains', id: 1, add: 'github' }, { type: 'cs_domains', id: 1, remove: 'registry.npmjs.org' }]), JSON.stringify(await js('__sent')));
  await js('__sent.length = 0; document.querySelector("#jc-pane-body .cs-switch").click(); true');
  assert(JSON.stringify(await sentOf('feature_prefs')) === JSON.stringify([{ type: 'feature_prefs', changes: { code_sandbox_bypass: false } }]), JSON.stringify(await js('__sent')));
});

// ── Touch ID for Bypass and risky steps (web/features/code-touchid.js) ──

// The app's Touch ID, faked: what it was asked, and what the finger says (true, false, or
// null for a Mac without Touch ID).
const fakeTouchId = (answer) => js(`window.__touch = []; window.__finger = ${JSON.stringify(answer)}; window.__confirms = [];
  window.confirm = (q) => { __confirms.push(q); return window.__confirmAnswer !== false; };
  window.jarvisApp = { feature: { invoke: async (channel, kind) => { __touch.push(kind || channel);
    if (channel === 'feature:touchid:available') return __finger !== null; return { ok: __finger === true }; } } }; true`);

test('Bypass and a risky step allowed from its card ask for Touch ID first, or the usual question without it', async () => {
  await featureScript('code-touchid.js');
  await fakeTouchId(true);
  await open(1);
  await js('__sent.length = 0; $("jc-bypass").click(); true');
  await sleep(60);
  assert(JSON.stringify(await sentOf('task_mode')) === JSON.stringify([{ type: 'task_mode', id: 1, mode: 'auto' }]), JSON.stringify(await js('__sent')));
  assert(JSON.stringify(await js('__touch')) === JSON.stringify(['feature:touchid:available', 'bypass']) && (await js('__confirms.length')) === 0, JSON.stringify(await js('__touch')));
  // The finger says no: nothing goes; no Touch ID here: the usual question decides.
  await js('__sent.length = 0; __finger = false; $("jc-bypass").click(); true');
  await sleep(60);
  assert((await sentOf('task_mode')).length === 0, 'Bypass went on without the finger');
  await js('__finger = null; __confirmAnswer = false; $("jc-bypass").click(); true');
  await sleep(60);
  assert((await sentOf('task_mode')).length === 0 && (await js('__confirms.length')) === 1, JSON.stringify(await js('__sent')));
  // A risky step waits for the finger; an ordinary one goes at once.
  await js('__finger = false; __touch.length = 0; true');
  await deliver({ ...(await js('__approval("r1", { detail: "$ rm -rf build" })')), task_id: 1 });
  await js('document.querySelector("#deck-timeline [data-approval=r1] .jc-choices button").click(); true');
  await sleep(60);
  assert((await sentOf('approve')).length === 0 && (await js('!!document.querySelector("#deck-timeline [data-approval=r1]")')), 'a risky step went without the finger');
  await js('__finger = true; document.querySelector("#deck-timeline [data-approval=r1] .jc-choices button").click(); true');
  await sleep(60);
  assert(JSON.stringify((await sentOf('approve')).map((m) => [m.id, m.choice])) === JSON.stringify([['r1', 'allow']]), JSON.stringify(await js('__sent')));
  assert(await js('!document.querySelector("[data-approval=r1]")'), 'the answered sheet stayed');
  await deliver({ ...(await js('__approval("r2", { detail: "$ npm test" })')), task_id: 1 });
  await js('__touch.length = 0; document.querySelector("#deck-timeline [data-approval=r2] .jc-choices button").click(); true');
  assert(JSON.stringify((await sentOf('approve')).map((m) => m.id)) === JSON.stringify(['r1', 'r2']) && (await js('__touch.length')) === 0, 'an ordinary step waited');
});

test('Jarvis Code settings has the Touch ID switch; off, Bypass asks the usual question', async () => {
  await featureScript('code-touchid.js');
  await fakeTouchId(true);
  await open(1);
  await js('openJcSettings(); selectJcsTab("general"); true');
  assert(await js('$("jcs-general").contains($("ct-touchid")) && $("ct-touchid").getAttribute("aria-checked") === "true"'), 'no Touch ID switch in General');
  await js('__sent.length = 0; $("ct-touchid").click(); true');
  assert(JSON.stringify(await sentOf('feature_prefs')) === JSON.stringify([{ type: 'feature_prefs', changes: { code_touchid: false } }]), JSON.stringify(await js('__sent')));
  await deliver({ type: 'prefs', look: 'orb', language: 'en', models: [], personas: [], humor: 50, features: { code_touchid: false } });
  assert(await js('$("ct-touchid").getAttribute("aria-checked") === "false"'), 'the switch didn’t follow the setting');
  await js('closeJcSettings && closeJcSettings(); __sent.length = 0; $("jc-bypass").click(); true');
  await sleep(60);
  assert((await js('__touch.length')) === 0 && (await js('__confirms.length')) === 1, JSON.stringify(await js('__touch')));
  assert(JSON.stringify(await sentOf('task_mode')) === JSON.stringify([{ type: 'task_mode', id: 1, mode: 'auto' }]), JSON.stringify(await js('__sent')));
});

// ── The MCP manager (web/features/code-mcp.js) ──

const mcpState = (extra = {}) => ({ type: 'cm_state', id: 1, folder: '/x/alpha', name: 'alpha', live: true, signing: [], servers: [
  { name: 'github', scope: 'user', kind: 'stdio', target: "npx -y server-github --token 'ghp_…R8'", approved: null, status: 'connected', tools: 3, error: '', off: false, removable: true },
  { name: 'docs', scope: 'local', kind: 'http', target: 'https://docs.example.com/mcp', approved: null, status: 'needs-auth', tools: null, error: '', off: false, removable: true },
  { name: 'new', scope: 'project', kind: 'stdio', target: 'node <img src=x onerror="window.__pwned=1">', approved: null, off: false, removable: true },
  { name: 'jarvis_browser', scope: 'other', kind: '', target: '', approved: null, status: 'connected', tools: 12, off: false, removable: false }],
  connectors: [{ id: 'github', name: 'GitHub', status: 'connected', on: false }, { id: 'linear', name: 'Linear', status: 'error', on: false }], ...extra });

test('The MCP servers pane shows each server and how it’s doing, and adds, signs in, approves, switches and removes', async () => {
  await featureScript('code-mcp.js');
  await open(1);
  await js('openPane("mcp"); true');
  assert(await js('$("jc-pane-title").textContent') === 'MCP servers', 'the pane did not open');
  assert((await sentOf('cm_state')).length === 1, JSON.stringify(await js('__sent')));
  await deliver(mcpState());
  const r = await js(`({ rows: [...document.querySelectorAll('#jc-pane-body .cm-server')].map((li) => li.dataset.name + ':' + (li.querySelector('.cm-status') || {}).textContent),
    imgs: document.querySelectorAll('#jc-pane-body img').length, pwned: !!window.__pwned, shares: [...document.querySelectorAll('#jc-pane-body .cm-share')].map((b) => b.disabled) })`);
  assert(r.rows.join('|') === 'github:Connected · 3 tools|docs:Needs sign-in|new:Waiting for your OK|jarvis_browser:Connected · 12 tools', JSON.stringify(r));
  assert(r.imgs === 0 && !r.pwned && r.shares.join() === 'false,true', JSON.stringify(r));
  const click = (name, cls) => js(`document.querySelector('#jc-pane-body .cm-server[data-name="${name}"] .${cls}').click(); true`);
  await js('__sent.length = 0; true');
  await click('docs', 'cm-signin');
  await click('new', 'cm-approve');
  await click('github', 'cm-switch');
  await click('github', 'cm-remove');
  assert(!(await js('__sent')).some((m) => m.type === 'cm_remove'), 'removed on the first press');
  await click('github', 'cm-remove');
  const sent = (await js('__sent')).filter((m) => m.type !== 'cm_state');
  assert(JSON.stringify(sent) === JSON.stringify([{ type: 'cm_login', id: 1, name: 'docs' }, { type: 'cm_approve', id: 1, name: 'new', approve: true },
    { type: 'task_mcp_toggle', id: 1, name: 'github', enabled: false }, { type: 'cm_remove', id: 1, name: 'github', scope: 'user' }]), JSON.stringify(sent));
  // A server added as an address, for everyone on the project.
  await js(`__sent.length = 0; document.querySelector('#jc-pane-body .cm-add summary').click(); const f = document.querySelector('#jc-pane-body .cm-name-input');
    f.value = 'sentry'; f.dispatchEvent(new Event('input')); document.querySelector('#jc-pane-body .cm-kind [data-kind=url]').click();
    const t = document.querySelector('#jc-pane-body .cm-target-input'); t.value = 'https://mcp.sentry.dev/mcp'; t.dispatchEvent(new Event('input'));
    const s = document.querySelector('#jc-pane-body .cm-scope-select'); s.value = 'project'; s.dispatchEvent(new Event('change'));
    document.querySelector('#jc-pane-body .cm-add-btn').click(); true`);
  assert(JSON.stringify(await sentOf('cm_add')) === JSON.stringify([{ type: 'cm_add', id: 1, name: 'sentry', kind: 'url', target: 'https://mcp.sentry.dev/mcp', transport: 'http', scope: 'project' }]), JSON.stringify(await js('__sent')));
  await deliver(mcpState({ error: 'Claude Code didn’t add it: <b>exists</b>' }));
  assert(await js('document.querySelector("#jc-pane-body .cm-add").open && document.querySelector("#jc-pane-body .cm-name-input").value === "sentry" && !document.querySelector("#jc-pane-body b")'), 'the form or its error changed');
  await deliver(mcpState({ added: 'sentry' }));
  assert(await js('!document.querySelector("#jc-pane-body .cm-add").open'), 'the form stayed open once added');
  await js('__sent.length = 0; document.querySelector("#jc-pane-body .cm-connector[data-connector=github] .cm-share").click(); true');
  assert(JSON.stringify(await sentOf('cm_share')) === JSON.stringify([{ type: 'cm_share', id: 1, connector: 'github', on: true }]), JSON.stringify(await js('__sent')));
  await deliver(mcpState({ signing: ['docs'], live: false }));
  assert(await js('!!document.querySelector("#jc-pane-body .cm-server[data-name=docs] .cm-signing") && document.querySelector("#jc-pane-body .cm-intro").textContent.includes("isn’t running")'), 'no word of the sign-in or of the session not running');
});

// ── Plugins (web/features/code-plugins.js) ──

const pluginState = (extra = {}) => ({ type: 'cx_state', id: 1, folder: '/x/alpha', name: 'alpha',
  installed: [{ id: 'hello@local-mkt', version: '1.0.0', scope: 'user', enabled: true }],
  available: [{ id: 'lint@tools', name: 'lint', description: 'Lints <img src=x onerror="window.__pwned=1">', marketplace: 'tools', version: '2.1' },
    { id: 'pdf@docs', name: 'pdf', description: 'Reads PDF files', marketplace: 'docs', version: '' }],
  marketplaces: [{ name: 'tools', source: 'github', where: 'acme/tools' }],
  files: [{ kind: 'agents', scope: 'project', name: 'reviewer' }, { kind: 'commands', scope: 'user', name: 'git/ship' }], ...extra });

test('The Plugins pane installs, switches and removes plugins, adds marketplaces, and edits .claude files', async () => {
  await featureScript('code-plugins.js');
  await open(1);
  await clickAt('#jc-more');
  assert(await clickItem('#jc-menu', 'Plugins and skills'), 'no Plugins item in the More menu');
  assert(await js('$("jc-pane-title").textContent') === 'Plugins', 'the pane did not open');
  assert((await sentOf('cx_state')).length === 1, JSON.stringify(await js('__sent')));
  await deliver(pluginState());
  const r = await js(`({ installed: [...document.querySelectorAll('#jc-pane-body .cx-list:not(.cx-available) .cx-plugin')].map((li) => li.dataset.plugin),
    available: [...document.querySelectorAll('#jc-pane-body .cx-available .cx-plugin')].map((li) => li.dataset.plugin),
    imgs: document.querySelectorAll('#jc-pane-body img').length, pwned: !!window.__pwned, files: [...document.querySelectorAll('#jc-pane-body .cx-file')].map((li) => li.dataset.file) })`);
  assert(r.installed.join() === 'hello@local-mkt' && r.available.join() === 'lint@tools,pdf@docs' && r.imgs === 0 && !r.pwned, JSON.stringify(r));
  assert(r.files.join() === 'agents:project:reviewer,commands:user:git/ship', JSON.stringify(r));
  // A search narrows the list, and what's typed stays through a redraw.
  await js('window.__q = document.querySelector("#jc-pane-body .cx-search"); __q.focus(); true');
  await typeText('pdf');
  await js('__q.dispatchEvent(new Event("input")); true');
  assert(JSON.stringify(await js('[...document.querySelectorAll("#jc-pane-body .cx-available .cx-plugin")].map((li) => li.dataset.plugin)')) === '["pdf@docs"]', 'the search didn’t narrow the list');
  await deliver(pluginState());
  assert(await js('document.activeElement.classList.contains("cx-search") && document.activeElement.value === "pdf"'), 'the search was lost in a redraw');
  await js(`__sent.length = 0; document.querySelector('#jc-pane-body .cx-plugin[data-plugin="pdf@docs"] .cx-install').click();
    document.querySelector('#jc-pane-body .cx-plugin[data-plugin="hello@local-mkt"] .cx-enable').click();
    document.querySelector('#jc-pane-body .cx-plugin[data-plugin="hello@local-mkt"] .cx-details').click(); true`);
  assert(JSON.stringify(await js('__sent')) === JSON.stringify([{ type: 'cx_install', id: 1, plugin: 'pdf@docs' }, { type: 'cx_enable', id: 1, plugin: 'hello@local-mkt', on: false },
    { type: 'cx_details', id: 1, plugin: 'hello@local-mkt' }]), JSON.stringify(await js('__sent')));
  await deliver({ type: 'cx_details', id: 1, plugin: 'hello@local-mkt', text: 'Component inventory\n  Skills (2)  greet, hi', tokens: 1200 });
  assert(await js('document.querySelector("#jc-pane-body .cx-cost").textContent.includes("~1.2k") && document.querySelector("#jc-pane-body .cx-details-text").textContent.includes("Skills (2)")'), 'no inventory or cost');
  await js('__sent.length = 0; document.querySelector("#jc-pane-body .cx-plugin[data-plugin=\'hello@local-mkt\'] .cx-remove").click(); true');
  assert(!(await js('__sent')).length, 'removed on the first press');
  await js('document.querySelector("#jc-pane-body .cx-plugin[data-plugin=\'hello@local-mkt\'] .cx-remove").click(); true');
  assert(JSON.stringify(await js('__sent')) === JSON.stringify([{ type: 'cx_uninstall', id: 1, plugin: 'hello@local-mkt' }]), JSON.stringify(await js('__sent')));
  // A marketplace added (the card is the backend's).
  await js('__sent.length = 0; window.__m = document.querySelector("#jc-pane-body .cx-market-input"); __m.value = "acme/more"; __m.dispatchEvent(new Event("input")); document.querySelector("#jc-pane-body .cx-market-go").click(); true');
  assert(JSON.stringify(await js('__sent')) === JSON.stringify([{ type: 'cx_market', id: 1, add: 'acme/more' }]), JSON.stringify(await js('__sent')));
  // A file opened, edited and saved over the version opened; a conflict says so.
  await js('__sent.length = 0; document.querySelector("#jc-pane-body .cx-file[data-file=\'agents:project:reviewer\'] .cx-open").click(); true');
  assert(JSON.stringify(await js('__sent')) === JSON.stringify([{ type: 'cx_read', id: 1, kind: 'agents', scope: 'project', name: 'reviewer' }]), JSON.stringify(await js('__sent')));
  await deliver({ type: 'cx_file', id: 1, file_kind: 'agents', scope: 'project', name: 'reviewer', text: '---\nname: reviewer\n---\n<b>Review.</b>\n', stamp: 's1', exists: true });
  assert(await js('document.querySelector("#jc-pane-body .cx-text-area").value.includes("<b>Review.</b>") && !document.querySelector("#jc-pane-body b")'), 'the file isn’t shown as text');
  await js('__sent.length = 0; window.__a = document.querySelector("#jc-pane-body .cx-text-area"); __a.value += "More.\\n"; __a.dispatchEvent(new Event("input")); document.querySelector("#jc-pane-body .cx-save").click(); true');
  const saved = (await sentOf('cx_write'))[0];
  assert(saved && saved.stamp === 's1' && saved.text.endsWith('More.\n') && saved.kind === 'agents', JSON.stringify(await js('__sent')));
  await deliver({ type: 'cx_file', id: 1, file_kind: 'agents', scope: 'project', name: 'reviewer', conflict: 's2', error: 'It changed on disk since you opened it.' });
  assert(await js('!!document.querySelector("#jc-pane-body .cx-conflict") && document.querySelector("#jc-pane-body .cx-text-area").value.endsWith("More.\\n")'), 'no conflict shown, or the edit was lost');
  await js('__sent.length = 0; document.querySelector("#jc-pane-body .cx-force").click(); true');
  assert((await sentOf('cx_write'))[0].stamp === 's2', JSON.stringify(await js('__sent')));
  // A new one from a template, and the context check.
  await js(`__sent.length = 0; const k = document.querySelector('#jc-pane-body .cx-new-kind'); k.value = 'skills'; const n = document.querySelector('#jc-pane-body .cx-new-name');
    n.value = 'bad name'; document.querySelector('#jc-pane-body .cx-make').click(); true`);
  assert(!(await js('__sent')).length && (await js('document.querySelector("#jc-pane-body .cx-new-note").textContent')).includes('letters'), 'a bad name went');
  await js(`document.querySelector('#jc-pane-body .cx-new-name').value = 'pdf'; document.querySelector('#jc-pane-body .cx-make').click();
    document.querySelector('#jc-pane-body .cx-context').click(); true`);
  assert(JSON.stringify(await js('__sent')) === JSON.stringify([{ type: 'cx_read', id: 1, kind: 'skills', scope: 'project', name: 'pdf' }, { type: 'cx_context', id: 1 }]), JSON.stringify(await js('__sent')));
  await deliver({ type: 'cx_context', id: 1, live: true, total: 4200, max: 200000, rows: [{ group: 'MCP servers', name: 'github', source: '', tokens: 1000 }] });
  assert(await js('document.querySelector("#jc-pane-body .cx-total").textContent.includes("4.2k") && document.querySelector("#jc-pane-body .cx-context-list").textContent.includes("github")'), 'no context shown');
});

// ── Other agents over ACP (web/features/code-acp.js) ──

test('The Other agents pane adds an agent, starts a session with it in the project on show, and removes it', async () => {
  await featureScript('code-acp.js');
  await open(1);
  await clickAt('#jc-more');
  assert(await clickItem('#jc-menu', 'Other agents'), 'no Other agents item in the More menu');
  assert(await js('$("jc-pane-title").textContent') === 'Other agents', 'the pane did not open');
  assert((await sentOf('acp_state')).length === 1, JSON.stringify(await js('__sent')));
  await deliver({ type: 'acp_state', agents: [{ id: 'codex', name: 'Codex', command: 'codex-acp <img src=x onerror="window.__pwned=1">' }] });
  assert(await js('!document.querySelector("#jc-pane-body img") && !window.__pwned && document.querySelector("#jc-pane-body .ca-command").textContent.includes("<img")'), 'the command wasn’t shown as text');
  await js('__sent.length = 0; document.querySelector("#jc-pane-body .ca-agent[data-agent=codex] .ca-start").click(); true');
  assert(JSON.stringify(await sentOf('acp_start')) === JSON.stringify([{ type: 'acp_start', agent: 'codex', directory: 'alpha', mode: 'ask' }]), JSON.stringify(await js('__sent')));
  // Once it starts, the new session is the one on show.
  await deliver({ type: 'tasks', items: [await js('__task(1)'), await js('__task(2, { model_label: "Codex" })')] });
  await deliver({ type: 'acp_started', id: 2 });
  assert(await js('ccSelected') === 2, 'the new session isn’t selected');
  // An agent added from an example, and removed on a second press.
  await js('__sent.length = 0; [...document.querySelectorAll("#jc-pane-body .ca-example")][1].click(); document.querySelector("#jc-pane-body .ca-add-btn").click(); true');
  assert(JSON.stringify(await sentOf('acp_add')) === JSON.stringify([{ type: 'acp_add', name: 'Gemini', command: 'gemini --experimental-acp' }]), JSON.stringify(await js('__sent')));
  await deliver({ type: 'acp_state', agents: [{ id: 'codex', name: 'Codex', command: 'codex-acp' }], error: 'That command has a quote that isn’t closed.' });
  assert(await js('document.querySelector("#jc-pane-body .ca-add .cr-error").textContent.includes("quote")'), 'the error isn’t shown');
  await js('__sent.length = 0; document.querySelector("#jc-pane-body .ca-remove").click(); true');
  assert(!(await js('__sent')).length, 'removed on the first press');
  await js('document.querySelector("#jc-pane-body .ca-remove").click(); true');
  assert(JSON.stringify(await js('__sent')) === JSON.stringify([{ type: 'acp_remove', agent: 'codex' }]), JSON.stringify(await js('__sent')));
});

// ── Jarvis Code's workspace (web/features/code-*.js of the code-workspace feature) ──

const TRANSCRIPT_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==';

test('Claude’s words are Markdown: headings, lists, tables, links and code in colour, never markup', async () => {
  await featureScript('code_diff.js');
  await featureScript('code-markdown.js');
  await open(1);
  const text = [
    '## The plan', '', 'Steps:', '1. Read **hub.py**', '2. Fix `retry()`', '   - [x] tests', '   - [ ] docs', '',
    '| File | Lines |', '|:--|--:|', '| a.py | 12 |', '',
    '> a <b>quote</b>', '', 'See [docs](https://example.com/d) or [bad](javascript:window.__pwned=1) and [hub](src/hub.py:7).',
    '<img src=x onerror="window.__pwned=1">', '', '```python', 'def run(x=1):  # go', '    return x', '```', '', '```diff', '-old', '+new', '+more', '```',
  ].join('\n');
  await deliver({ type: 'task_log', id: 1, entry: { n: 1, role: 'assistant', text } });
  await frames(2);
  const r = await js(`(() => {
    const md = document.querySelector('#deck-timeline .jc-say .cw-md');
    const links = [...md.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href'), a.target]);
    return {
      h2: (md.querySelector('h2') || {}).textContent, ol: md.querySelectorAll('ol > li').length,
      nested: md.querySelectorAll('ol ul.cw-tasks .cw-check').length, done: md.querySelectorAll('.cw-check.done').length,
      cells: [...md.querySelectorAll('td')].map((c) => [c.textContent, c.style.textAlign]),
      quote: (md.querySelector('blockquote') || {}).textContent, links,
      imgs: md.querySelectorAll('img, script').length, pwned: !!window.__pwned,
      keywords: [...md.querySelectorAll('pre .jcx-k')].map((n) => n.textContent), copy: !!md.querySelector('pre .jc-copy'),
      code: (md.querySelector('pre code') || {}).textContent, noI18n: md.hasAttribute('data-no-i18n'),
      diff: [...md.querySelectorAll('pre[data-lang="diff"] .cw-line')].map((n) => n.className + ':' + n.textContent),
    };
  })()`);
  assert(r.h2 === 'The plan' && r.ol === 2 && r.nested === 2 && r.done === 1, JSON.stringify(r));
  assert(JSON.stringify(r.cells) === JSON.stringify([['a.py', 'left'], ['12', 'right']]), JSON.stringify(r.cells));
  assert(r.quote === 'a <b>quote</b>' && r.imgs === 0 && !r.pwned, JSON.stringify(r));
  const hrefs = r.links.map((l) => l[1]);
  assert(JSON.stringify(r.links[0]) === JSON.stringify(['docs', 'https://example.com/d', '_blank']), JSON.stringify(r.links));
  assert(!hrefs.some((h) => /javascript/i.test(h || '')) && r.links.some((l) => l[0] === 'hub'), JSON.stringify(r.links));
  assert(r.keywords.join() === 'def,return' && r.copy && r.code === 'def run(x=1):  # go\n    return x' && r.noI18n, JSON.stringify(r));
  assert(r.diff.join('|') === 'cw-line cw-del:-old|cw-line cw-add:+new|cw-line cw-add:+more', JSON.stringify(r.diff));
});

test('A reply streams as Markdown, and a finished one replaces it', async () => {
  await featureScript('code-markdown.js');
  await open(1);
  await deliver({ type: 'task_stream', id: 1, part: 'text', text: '# Head\n\n- one\n- tw' });
  await frames(3);
  assert(await js('!!document.querySelector("#deck-timeline .jc-say.live .cw-md h1") && document.querySelectorAll("#deck-timeline .jc-say.live li").length === 2'), 'the live reply is not Markdown');
  await deliver({ type: 'task_log', id: 1, entry: { n: 2, role: 'assistant', text: '# Head\n\n- one\n- two' } });
  await frames(2);
  assert(await js('document.querySelectorAll("#deck-timeline .jc-say").length === 1 && !document.querySelector(".jc-say.live")'), 'the live reply stayed');
});

test('Pictures with a message and a step are asked for when shown, drawn small, and larger on a click', async () => {
  await featureScript('code-markdown.js');
  await open(1);
  await deliver({ type: 'task_transcript', id: 1, entries: [
    { n: 1, role: 'user', text: 'what is this?', images: 1, uuid: 'u-1', past: true },
    { n: 2, role: 'tool', tool: 'mcp__x__screenshot', text: 'Screenshot', tool_id: 't-1', status: 'done', images: 2, past: true },
  ] });
  let asked = [];
  for (let i = 0; i < 40 && !asked.length; i++) { await frames(2); asked = await sentOf('cw_media'); }
  assert(asked.length === 1 && JSON.stringify(asked[0].keys.sort()) === JSON.stringify(['t-1', 'u-1']) && asked[0].id === 1, JSON.stringify(asked));
  await deliver({ type: 'cw_media', id: 1, keys: ['u-1', 't-1'], items: {
    'u-1': [{ media_type: 'image/png', data: TRANSCRIPT_PNG }],
    't-1': [{ media_type: 'image/png', data: TRANSCRIPT_PNG }, { media_type: 'image/png', too_big: true }],
  } });
  let r = {};
  for (let i = 0; i < 40 && !(r.user && r.tool === 1); i++) {
    await frames(2);
    r = await js(`({ user: document.querySelectorAll('#deck-timeline .jc-user .cw-thumbs img').length,
      tool: document.querySelectorAll('#deck-timeline [data-tool-id="t-1"] .cw-thumbs img').length,
      big: document.querySelectorAll('#deck-timeline [data-tool-id="t-1"] .cw-thumb.none').length,
      src: (document.querySelector('#deck-timeline .cw-thumbs img') || {}).src || '',
      said: (document.querySelector('#deck-timeline .jc-user .jc-pics') || {}).hidden })`);
  }
  assert(r.user === 1 && r.tool === 1 && r.big === 1 && r.src.startsWith('data:image/jpeg') && r.said === true, JSON.stringify(r));
  await js('__sent.length = 0; document.querySelector("#deck-timeline .jc-user .cw-thumb").click(); true');
  const big = await sentOf('cw_media');
  assert(big.length === 1 && big[0].keys[0] === 'u-1' && /^big-/.test(big[0].ref) && await js('!!document.querySelector(".cw-lightbox img")'), JSON.stringify(big));
  await deliver({ type: 'cw_media', id: 1, keys: ['u-1'], ref: big[0].ref, items: { 'u-1': [{ media_type: 'image/png', data: TRANSCRIPT_PNG }] } });
  assert((await js('document.querySelector(".cw-lightbox img").src')).startsWith('data:image/png'), 'the full picture did not come');
  await press('Escape');
  assert(await js('!document.querySelector(".cw-lightbox") && !__sent.some((m) => m.type === "stop" || m.type === "task_interrupt")'), 'Escape did not close it, or went on');
  // Something that isn't a picture is never drawn.
  await deliver({ type: 'task_log', id: 1, entry: { n: 3, role: 'user', text: 'x', images: 1, uuid: 'u-2' } });
  await deliver({ type: 'cw_media', id: 1, keys: ['u-2'], items: { 'u-2': [{ media_type: 'text/html', data: 'PHNjcmlwdD4=' }] } });
  await frames(4);
  assert(await js('!document.querySelector("#deck-timeline .jc-user:last-of-type .cw-thumbs img")'), 'drew a non-picture');
});

// A key with ⌘ (or others) held, by its code: ⌘S, ⌘F, ⌘G.
async function chord(key, mods = ['meta']) {
  const code = /^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : key;
  const vk = /^[a-z]$/.test(key) ? key.toUpperCase().charCodeAt(0) : 0;
  const modifiers = mods.reduce((m, k) => m | MODS[k], 0);
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
}
const VERSION = { mtime_ns: 1, size: 12, sha: 'aaa' };
// Jarvis Code open on session 1 with the editor's Files pane, and a file opened in it.
async function editorWith(text = 'a = 1\nb = 2\n', extra = {}) {
  await js('localStorage.removeItem("jarvis.editor.drafts"); true');  // (a test's kept changes are its own)
  await featureScript('code_diff.js');
  await featureScript('code-editor.js');
  await open(1);
  await js('jarvisFeatures.openPane("files"); true');
  await deliver({ type: 'project_files', directory: 'alpha', files: ['src/app.py', 'README.md', 'src/<b>x</b>.py'] });
  await frames(2);
  await js('__sent.length = 0; [...document.querySelectorAll("#jc-pane-body .ce-files button")].find((b) => b.title === "src/app.py").click(); true');
  const [read] = await sentOf('cw_file_read');
  await deliver({ type: 'cw_file', path: 'src/app.py', ref: read.ref, text, version: VERSION, crlf: false, editable: true, ...extra });
  await frames(2);
  return read;
}
const editorText = () => js('document.querySelector("#jc-pane-body .ce-text").value');
async function typeAtEnd(text) {
  await js('(() => { const ta = document.querySelector("#jc-pane-body .ce-text"); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); return true; })()');
  await typeText(text);
  await frames(1);
}

test('Files open in an editor: typed changes are unsaved until ⌘S saves them over the version they came from', async () => {
  const read = await editorWith();
  assert(read.path === 'src/app.py' && read.id === 1 && read.directory === 'alpha', JSON.stringify(read));
  const shown = await js(`({ names: [...document.querySelectorAll('#jc-pane-body .ce-files button')].map((b) => b.title),
    imgs: document.querySelectorAll('#jc-pane-body img, #jc-pane-body b').length, text: document.querySelector('#jc-pane-body .ce-text').value,
    gutter: document.querySelector('#jc-pane-body .ce-gutter').textContent, tab: document.querySelector('#jc-pane-body .ce-tab.on').textContent,
    noI18n: document.querySelector('#jc-pane-body .ce-text').hasAttribute('data-no-i18n') })`);
  assert(shown.names.includes('src/<b>x</b>.py') && shown.imgs === 0, JSON.stringify(shown));
  assert(shown.text === 'a = 1\nb = 2\n' && shown.gutter === '1\n2\n3\n' && shown.tab.startsWith('app.py') && shown.noI18n, JSON.stringify(shown));
  await typeAtEnd('c = 3');
  assert(await js('!!document.querySelector("#jc-pane-body .ce-tab.on.dirty") && $("jc-pane-body").textContent.includes("Unsaved")'), 'not marked unsaved');
  await js('__sent.length = 0; true');
  await chord('s');
  const [save] = await sentOf('cw_file_save');
  assert(save && save.text === 'a = 1\nb = 2\nc = 3' && JSON.stringify(save.base) === JSON.stringify(VERSION) && save.ref === read.ref && save.force === false, JSON.stringify(save));
  await deliver({ type: 'cw_file_saved', path: 'src/app.py', ref: read.ref, ok: true, version: { mtime_ns: 2, size: 17, sha: 'bbb' } });
  await frames(2);
  assert(await js('!document.querySelector("#jc-pane-body .ce-tab.dirty") && document.querySelector("#jc-pane-body .ce-banner.saved") !== null'), 'still unsaved after the save');
  // The next save goes over the version that one made.
  await typeAtEnd('\n');
  await js('__sent.length = 0; true');
  await chord('s');
  const [again] = await sentOf('cw_file_save');
  assert(again && again.base.sha === 'bbb', JSON.stringify(again));
});

test('A save over a file changed on disk since is a conflict: compare, overwrite, or take what’s on disk', async () => {
  const read = await editorWith();
  await typeAtEnd('mine');
  await chord('s');
  await deliver({ type: 'cw_file_saved', path: 'src/app.py', ref: read.ref, conflict: true, version: { mtime_ns: 3, size: 20, sha: 'ccc' } });
  await frames(2);
  const banner = await js('({ kind: document.querySelector("#jc-pane-body .ce-banner").className, buttons: [...document.querySelectorAll("#jc-pane-body .ce-banner button")].map((b) => b.textContent) })');
  assert(/conflict/.test(banner.kind) && banner.buttons.join() === 'Compare,Use the disk’s,Overwrite', JSON.stringify(banner));
  await js('__sent.length = 0; true');
  assert(await clickText('#jc-pane-body .ce-banner', 'Compare'), 'no Compare');
  const [cmp] = await sentOf('cw_file_compare');
  assert(cmp && cmp.text === 'a = 1\nb = 2\nmine' && cmp.ref === read.ref, JSON.stringify(cmp));
  await deliver({ type: 'cw_file_compare', path: 'src/app.py', ref: read.ref, hunks: [
    { old_start: 3, old_count: 1, new_start: 3, new_count: 1, lines: [['-', 'claude <i>was</i> here'], ['+', 'mine']] }] });
  await frames(2);
  const diff = await js('({ text: document.querySelector("#jc-pane-body .ce-compare").textContent, i: document.querySelectorAll("#jc-pane-body .ce-compare i").length })');
  assert(diff.text.includes('claude <i>was</i> here') && diff.text.includes('mine') && diff.i === 0, JSON.stringify(diff));
  await js('__sent.length = 0; true');
  assert(await clickText('#jc-pane-body .ce-banner', 'Overwrite'), 'no Overwrite');
  const [forced] = await sentOf('cw_file_save');
  assert(forced && forced.force === true && forced.text === 'a = 1\nb = 2\nmine', JSON.stringify(forced));
  // Or what's on disk: the unsaved changes are dropped for it.
  await deliver({ type: 'cw_file_saved', path: 'src/app.py', ref: read.ref, conflict: true });
  await frames(1);
  await js('__sent.length = 0; true');
  assert(await clickText('#jc-pane-body .ce-banner', 'Use the disk’s'), 'no Use the disk’s');
  const [reread] = await sentOf('cw_file_read');
  assert(reread && reread.ref === read.ref, JSON.stringify(await js('__sent')));
  await deliver({ type: 'cw_file', path: 'src/app.py', ref: read.ref, text: 'from disk\n', version: { mtime_ns: 4, size: 10, sha: 'ddd' }, crlf: false, editable: true });
  await frames(2);
  assert(await editorText() === 'from disk\n' && await js('!document.querySelector("#jc-pane-body .ce-tab.dirty")'), 'the disk’s version is not shown');
});

test('A file Claude changes comes back by itself, and says so instead when it has unsaved changes', async () => {
  const read = await editorWith();
  await js('__sent.length = 0; true');
  await deliver({ type: 'task_log_update', id: 1, tool_id: 't-1', status: 'done', output: '' });
  let stat = [];
  for (let i = 0; i < 40 && !stat.length; i++) { await sleep(50); stat = await sentOf('cw_file_stat'); }
  assert(stat.length === 1 && stat[0].base.sha === 'aaa' && stat[0].ref === read.ref, JSON.stringify(stat));
  await js('__sent.length = 0; true');
  await deliver({ type: 'cw_file_stat', path: 'src/app.py', ref: read.ref, changed: true, missing: false });
  const [reread] = await sentOf('cw_file_read');
  assert(reread && reread.ref === read.ref, 'an unchanged file was not read again');
  await deliver({ type: 'cw_file', path: 'src/app.py', ref: read.ref, text: 'a = 1\nb = 2\nclaude = 3\n', version: { mtime_ns: 5, size: 22, sha: 'eee' }, crlf: false, editable: true });
  await frames(2);
  assert(await editorText() === 'a = 1\nb = 2\nclaude = 3\n', 'Claude’s change is not shown');
  // With unsaved changes, it says so and leaves them.
  await typeAtEnd('mine = 4');
  await js('__sent.length = 0; true');
  await deliver({ type: 'cw_file_stat', path: 'src/app.py', ref: read.ref, changed: true, missing: false });
  await frames(2);
  const r = await js('({ sent: __sent.length, banner: document.querySelector("#jc-pane-body .ce-banner.changed") !== null, text: document.querySelector("#jc-pane-body .ce-text").value })');
  assert(r.sent === 0 && r.banner && r.text.endsWith('mine = 4'), JSON.stringify(r));
});

test('Find and replace in a file: text or an expression, a count, and one step to undo', async () => {
  await editorWith('retry = 1\nretry_max = 2\nprint(retry)\n');
  await js('document.querySelector("#jc-pane-body .ce-text").focus(); true');
  await chord('f');
  assert(await js('document.activeElement.classList.contains("ce-find-input")'), 'find did not take the keys');
  await typeText('retry');
  await frames(1);
  assert(await js('document.querySelector("#jc-pane-body .ce-count").textContent') === '1 of 3', await js('document.querySelector("#jc-pane-body .ce-count").textContent'));
  await press('Enter');
  assert(await js('document.querySelector("#jc-pane-body .ce-count").textContent') === '2 of 3', 'Enter did not go to the next');
  // An expression: retry not followed by _ leaves retry_max alone.
  await js('document.querySelector("#jc-pane-body .ce-opt[title=\'Regular expression\']").click(); true');
  assert(await js('document.querySelector("#jc-pane-body .ce-opt[title=\'Regular expression\']").getAttribute("aria-pressed")') === 'true', 'the expression switch did not turn on');
  await js('(() => { const i = document.querySelector("#jc-pane-body .ce-find-input"); i.value = "retry(?!_)"; i.dispatchEvent(new Event("input")); return true; })()');
  await frames(1);
  // (from the match it was on, the one after it: the second)
  assert(await js('document.querySelector("#jc-pane-body .ce-count").textContent') === '2 of 2', 'the expression did not count 2');
  await js('document.querySelector("#jc-pane-body .ce-find button[title=Replace]").click(); true');
  await js('(() => { const r = document.querySelectorAll("#jc-pane-body .ce-find-input")[1]; r.value = "again"; return true; })()');
  assert(await clickText('#jc-pane-body .ce-find', 'All'), 'no Replace all');
  assert(await editorText() === 'again = 1\nretry_max = 2\nprint(again)\n', JSON.stringify(await editorText()));
  assert(await js('!!document.querySelector("#jc-pane-body .ce-tab.dirty")'), 'a replace is not an unsaved change');
  await js('document.querySelector("#jc-pane-body .ce-text").focus(); document.execCommand("undo"); true');
  assert(await editorText() === 'retry = 1\nretry_max = 2\nprint(retry)\n', 'replace all is not one step to undo');
  // A bad expression says so.
  await js('(() => { const i = document.querySelector("#jc-pane-body .ce-find-input"); i.value = "retry("; i.dispatchEvent(new Event("input")); return true; })()');
  assert(await js('document.querySelector("#jc-pane-body .ce-count").textContent') === 'Not a valid expression', 'a bad expression is not said');
});

test('Unsaved changes come back after a reload, still saved only over the version they were edited from', async () => {
  const read = await editorWith();
  await typeAtEnd('kept = 1');
  await sleep(700);  // (kept a moment after the typing stops)
  await fresh();
  await featureScript('code_diff.js');
  await featureScript('code-editor.js');
  await open(1);
  await js('jarvisFeatures.openPane("files"); true');
  const [again] = await sentOf('cw_file_read');
  assert(again && again.path === 'src/app.py' && again.ref === read.ref, JSON.stringify(await js('__sent')));
  // It changed on disk meanwhile: the changes are back, and the save is still checked.
  await deliver({ type: 'cw_file', path: 'src/app.py', ref: read.ref, text: 'a = 1\nb = 2\nclaude = 3\n', version: { mtime_ns: 9, size: 22, sha: 'zzz' }, crlf: false, editable: true });
  await js('[...document.querySelectorAll("#jc-pane-body .ce-tab-name")].find((b) => b.title === "src/app.py").click(); true');
  await frames(2);
  const r = await js('({ text: document.querySelector("#jc-pane-body .ce-text").value, dirty: !!document.querySelector("#jc-pane-body .ce-tab.dirty"), banner: (document.querySelector("#jc-pane-body .ce-banner") || {}).className })');
  assert(r.text === 'a = 1\nb = 2\nkept = 1' && r.dirty && /changed/.test(r.banner), JSON.stringify(r));
  await js('__sent.length = 0; document.querySelector("#jc-pane-body .ce-text").focus(); true');
  await chord('s');
  const [save] = await sentOf('cw_file_save');
  assert(save && save.base.sha === 'aaa', JSON.stringify(save));
  // Saved: the kept copy goes.
  await deliver({ type: 'cw_file_saved', path: 'src/app.py', ref: read.ref, ok: true, version: { mtime_ns: 10, size: 20, sha: 'yyy' } });
  assert(await js('!localStorage.getItem("jarvis.editor.drafts") || !Object.keys(JSON.parse(localStorage.getItem("jarvis.editor.drafts"))).length'), 'the kept copy stayed');
});

test('Read-only files say why; Open in… lists the editors on this Mac and opens the file at its line', async () => {
  const read = await editorWith('[core]\n', { editable: false, why: 'git' });
  const r = await js('({ ro: document.querySelector("#jc-pane-body .ce-text").readOnly, text: $("jc-pane-body").textContent, save: !!document.querySelector("#jc-pane-body .ce-save") })');
  assert(r.ro && r.text.includes('Read-only') && r.text.includes('One of git’s own files') && !r.save, JSON.stringify(r));
  await deliver({ type: 'cw_editors', items: [{ id: 'vscode', name: 'VS Code' }, { id: 'xcode', name: 'Xcode' }] });
  await js('__sent.length = 0; true');
  assert(await clickText('#jc-pane-body .ce-doc-bar', 'Open in…'), 'no Open in…');
  const items = await js('[...document.querySelectorAll("#jc-menu button")].map((b) => b.textContent)');
  assert(items.filter((x) => x === 'VS Code').length === 2 && items.includes('Its own app') && items.includes('Show in Finder'), JSON.stringify(items));
  assert(await clickText('#jc-menu', 'Xcode'), 'no Xcode');
  const [opened] = await sentOf('cw_open_in');
  assert(opened && opened.editor === 'xcode' && opened.path === 'src/app.py' && opened.line === 1 && opened.id === 1, JSON.stringify(opened));
  assert(read.ref, 'no ref');
});

test('/memory opens the project’s CLAUDE.md in the editor', async () => {
  await js('localStorage.removeItem("jarvis.editor.drafts"); true');
  await featureScript('code-editor.js');
  await open(1);
  await js('localSlash("/memory"); true');
  const asked = await sentOf('file_read');
  assert(asked.length === 1 && asked[0].path === 'CLAUDE.md', JSON.stringify(await js('__sent')));
  await js('__sent.length = 0; true');
  await deliver({ type: 'file_content', directory: 'alpha', path: 'CLAUDE.md', text: '# Notes\n', truncated: false });
  const [read] = await sentOf('cw_file_read');
  assert(read && read.path === 'CLAUDE.md', JSON.stringify(await js('__sent')));
  await deliver({ type: 'cw_file', path: 'CLAUDE.md', ref: read.ref, text: '# Notes\n', version: VERSION, crlf: false, editable: true });
  await frames(2);
  assert(await editorText() === '# Notes\n', 'CLAUDE.md is not in the editor');
});

test('Search finds text across the project: matches by file, a match opens at its line, files become @-mentions', async () => {
  await js('localStorage.removeItem("jarvis.editor.drafts"); true');
  await featureScript('code-editor.js');
  await featureScript('code-search.js');
  await open(1);
  await js('jarvisFeatures.openPane("files"); true');
  await deliver({ type: 'project_files', directory: 'alpha', files: ['src/app.py', 'README.md'] });
  await frames(2);
  assert(await clickText('#jc-pane-body .ce-seg', 'Search'), 'no Search beside Files');
  await js('(() => { const i = document.querySelector("#jc-pane-body .cs-input"); i.value = "retry"; i.dispatchEvent(new Event("input")); return true; })()');
  let asked = [];
  for (let i = 0; i < 40 && !asked.length; i++) { await sleep(50); asked = await sentOf('cw_search'); }
  assert(asked.length === 1 && asked[0].text === 'retry' && asked[0].id === 1 && asked[0].regex === false && asked[0].case === false, JSON.stringify(asked));
  // A match as the owner types a longer word: only the newest answer is shown.
  await js('(() => { const i = document.querySelector("#jc-pane-body .cs-input"); i.focus(); i.value = "retry("; i.dispatchEvent(new Event("input")); return true; })()');
  await press('Enter');
  const newest = (await sentOf('cw_search')).pop();
  assert(newest.text === 'retry(' && newest.ref !== asked[0].ref, JSON.stringify(newest));
  await deliver({ type: 'cw_search', ref: asked[0].ref, total: 1, files: [{ path: 'old.py', matches: [{ line: 1, text: 'retry', spans: [[0, 5]] }] }] });
  await deliver({ type: 'cw_search', ref: newest.ref, total: 3, truncated: false, stopped: false, engine: 'git', files: [
    { path: 'src/app.py', matches: [{ line: 1, text: 'def retry(n):', spans: [[4, 10]] }, { line: 2, text: '    <b>retry(</b>', spans: [[7, 13]] }] },
    { path: 'README.md', matches: [{ line: 3, text: 'Call retry()', spans: [[5, 11]] }] }] });
  await frames(2);
  const r = await js(`({ status: document.querySelector('#jc-pane-body .cs-status').textContent,
    files: [...document.querySelectorAll('#jc-pane-body .cs-path')].map((n) => n.title),
    marks: [...document.querySelectorAll('#jc-pane-body .cs-text mark')].map((n) => n.textContent),
    b: document.querySelectorAll('#jc-pane-body .cs-text b').length,
    second: document.querySelectorAll('#jc-pane-body .cs-text')[1].textContent,
    noI18n: document.querySelector('#jc-pane-body .cs-text').closest('[data-no-i18n]') !== null })`);
  assert(r.status === '3 matches in 2 files' && r.files.join() === 'src/app.py,README.md', JSON.stringify(r));
  assert(r.marks.join() === 'retry(,retry(,retry(' && r.b === 0 && r.second === '    <b>retry(</b>' && r.noI18n, JSON.stringify(r));
  // A file mentioned in the composer; all of them.
  await js('document.querySelectorAll("#jc-pane-body .cs-mention")[1].click(); true');
  assert(await js('$("deck-input").value') === '@README.md ', await js('$("deck-input").value'));
  assert(await clickText('#jc-pane-body .cs-bar', 'Mention all'), 'no Mention all');
  assert(await js('$("deck-input").value') === '@README.md @src/app.py @README.md ', await js('$("deck-input").value'));
  // A match opens its file at its line.
  await js('__sent.length = 0; document.querySelectorAll("#jc-pane-body .cs-match")[1].click(); true');
  const [read] = await sentOf('cw_file_read');
  assert(read && read.path === 'src/app.py', JSON.stringify(await js('__sent')));
  await deliver({ type: 'cw_file', path: 'src/app.py', ref: read.ref, text: 'def retry(n):\n    retry(n)\n', version: { mtime_ns: 1, size: 26, sha: 'x' }, crlf: false, editable: true });
  let sel = [];
  for (let i = 0; i < 20 && sel[0] !== 14; i++) { await frames(2); sel = await js('[document.querySelector("#jc-pane-body .ce-text").selectionStart, document.querySelector("#jc-pane-body .ce-text").selectionEnd]'); }
  assert(sel[0] === 14 && sel[1] === 26, JSON.stringify(sel));
});

// xterm.js stands in here as a small fake (the test page has no /xterm files): what it was
// given to show, what the owner typed and selected.
const FAKE_XTERM = `(() => {
  window.__xterms = [];
  window.Terminal = class {
    constructor(o) { this.o = o; this.shown = ''; this.cols = 80; this.rows = 24; this.sel = ''; window.__xterms.push(this); }
    loadAddon() {}
    onData(fn) { this.typed = fn; }
    onSelectionChange(fn) { this.selChanged = fn; }
    open(el) { this.el = el; el.append(Object.assign(document.createElement('div'), { className: 'fake-xterm' })); }
    write(d) { this.shown += typeof d === 'string' ? d : new TextDecoder().decode(d); }
    reset() { this.shown = ''; }
    focus() {}
    dispose() { this.disposed = true; }
    hasSelection() { return !!this.sel; }
    getSelection() { return this.sel; }
  };
  window.FitAddon = { FitAddon: class { fit() {} } };
  return true;
})()`;
const b64 = (s) => Buffer.from(s).toString('base64');
const TERM = (term, title, extra = {}) => ({ term, title, cwd: '/Users/x/alpha', folder: 'alpha', alive: true, created: 1, ...extra });

test('Terminals: tabs of shells that outlive the pane, a split, and closing one asks while it runs', async () => {
  await featureScript('code-terminal.js');
  await open(1);
  await js(FAKE_XTERM);
  await js('jarvisFeatures.openPane("terminal"); true');
  const [listAsk] = await sentOf('cw_terms');
  assert(listAsk && listAsk.id === 1 && listAsk.ref === 'task:1', JSON.stringify(await js('__sent')));
  // None yet: one starts, as the old terminal did.
  await js('__sent.length = 0; true');
  await deliver({ type: 'cw_terms', folder: '/Users/x/alpha', items: [], ref: 'task:1' });
  const [made] = await sentOf('cw_term_new');
  assert(made && made.ref === 'task:1' && made.id === 1, JSON.stringify(await js('__sent')));
  await deliver({ type: 'cw_term_new', ref: 'task:1', ...TERM('t1', 'zsh 1') });
  await deliver({ type: 'cw_terms', folder: '/Users/x/alpha', items: [TERM('t1', 'zsh 1')] });
  for (let i = 0; i < 20 && !(await sentOf('cw_term_attach')).length; i++) await frames(2);
  assert(JSON.stringify(await sentOf('cw_term_attach')) === JSON.stringify([{ type: 'cw_term_attach', term: 't1' }]), JSON.stringify(await js('__sent')));
  // What it printed before comes back; what came before that answer isn't shown twice.
  await deliver({ type: 'cw_term_data', term: 't1', data: b64('early ') });
  await deliver({ type: 'cw_term_replay', term: 't1', data: b64('$ make\r\nbuilt\r\n'), alive: true });
  await deliver({ type: 'cw_term_data', term: 't1', data: b64('$ ') });
  assert(await js('__xterms[0].shown') === '$ make\r\nbuilt\r\n$ ', await js('__xterms[0].shown'));
  await js('__sent.length = 0; __xterms[0].typed("ls\\r"); true');
  assert(JSON.stringify(await sentOf('cw_term_input')) === JSON.stringify([{ type: 'cw_term_input', term: 't1', data: 'ls\r' }]), 'typing did not go');
  // Closing the pane only detaches; opening it again shows the same shell.
  await js('__sent.length = 0; closePane(); true');
  assert(!(await js('__sent.some((m) => /close/.test(m.type))')), JSON.stringify(await js('__sent')));
  await deliver({ type: 'cw_term_data', term: 't1', data: b64('while away\r\n') });
  await js('jarvisFeatures.openPane("terminal"); true');
  await frames(3);
  const back = await js('({ xterms: __xterms.length, shown: __xterms[0].shown, attached: __sent.filter((m) => m.type === "cw_term_attach").length, tab: [...document.querySelectorAll("#jc-pane-body .ct-tab-name")].map((b) => b.textContent) })');
  assert(back.xterms === 1 && back.shown.endsWith('while away\r\n') && back.attached === 0 && back.tab.join() === 'zsh 1', JSON.stringify(back));
  // Split: a second shell below.
  await js('__sent.length = 0; true');
  assert(await clickText('#jc-pane-body .ct-bar', 'Split'), 'no Split');
  const [second] = await sentOf('cw_term_new');
  assert(second && second.ref === 'task:1', JSON.stringify(await js('__sent')));
  await deliver({ type: 'cw_term_new', ref: 'task:1', ...TERM('t2', 'zsh 2') });
  await deliver({ type: 'cw_terms', folder: '/Users/x/alpha', items: [TERM('t1', 'zsh 1'), TERM('t2', 'zsh 2')] });
  await frames(3);
  const split = await js('({ slots: [...document.querySelectorAll("#jc-pane-body .ct-slot")].filter((s) => !s.hidden).length, split: document.querySelector("#jc-pane-body .ct-area").classList.contains("split"), xterms: __xterms.length })');
  assert(split.slots === 2 && split.split && split.xterms === 2, JSON.stringify(split));
  // Closing one where something runs: it asks, and a second click closes it.
  await js('__sent.length = 0; true');
  await js('document.querySelectorAll("#jc-pane-body .ct-tab-x")[1].click(); true');
  assert(JSON.stringify(await sentOf('cw_term_close')) === JSON.stringify([{ type: 'cw_term_close', term: 't2' }]), JSON.stringify(await js('__sent')));
  await deliver({ type: 'cw_term_busy', term: 't2', what: 'npm run <b>dev</b>' });
  await frames(2);
  const note = await js('({ text: document.querySelector("#jc-pane-body .ct-note").textContent, hidden: document.querySelector("#jc-pane-body .ct-note").hidden, b: document.querySelectorAll("#jc-pane-body .ct-note b").length })');
  assert(!note.hidden && note.text.includes('npm run <b>dev</b>') && note.b === 0, JSON.stringify(note));
  await js('__sent.length = 0; document.querySelectorAll("#jc-pane-body .ct-tab-x")[1].click(); true');
  assert(JSON.stringify(await sentOf('cw_term_close')) === JSON.stringify([{ type: 'cw_term_close', term: 't2', force: true }]), JSON.stringify(await js('__sent')));
  await deliver({ type: 'cw_terms', folder: '/Users/x/alpha', items: [TERM('t1', 'zsh 1')] });
  await frames(2);
  assert(await js('__xterms[1].disposed === true && document.querySelectorAll("#jc-pane-body .ct-tab").length === 1'), 'the closed terminal stayed');
});

test('A terminal’s selection goes to Jarvis Code, in a code block', async () => {
  await featureScript('code-terminal.js');
  await open(1);
  await js(FAKE_XTERM);
  await js('jarvisFeatures.openPane("terminal"); true');
  await deliver({ type: 'cw_terms', folder: '/Users/x/alpha', items: [TERM('t1', 'zsh 1')], ref: 'task:1' });
  for (let i = 0; i < 20 && !(await js('__xterms.length')); i++) await frames(2);
  assert(await js('document.querySelector("#jc-pane-body .ct-send").disabled'), 'Send is on with nothing selected');
  await js('__xterms[0].sel = "Error: port 5173 is in use"; __xterms[0].selChanged(); $("deck-input").value = "why?"; true');
  assert(await clickText('#jc-pane-body .ct-bar', 'Send to Jarvis Code'), 'no Send to Jarvis Code');
  assert(await js('$("deck-input").value') === 'why?\nFrom the terminal:\n```\nError: port 5173 is in use\n```\n', JSON.stringify(await js('$("deck-input").value')));
});

test('A "!" command streams its output as it comes, can be cancelled, and ends as before', async () => {
  await featureScript('code-terminal.js');
  await open(1);
  await js('$("deck-input").value = "!npm test"; $("deck-composer").requestSubmit(); true');
  const [bash] = await sentOf('task_bash');
  assert(bash && bash.command === 'npm test', JSON.stringify(await js('__sent')));
  await deliver({ type: 'cw_bang_start', ref: bash.ref });
  // (as a terminal sends it: \r\n line ends, one split between two messages)
  await deliver({ type: 'cw_bang_data', ref: bash.ref, text: 'PASS a.test.js\r\n10%\r50%\r', skipped: 0 });
  await deliver({ type: 'cw_bang_data', ref: bash.ref, text: '\n100%\r\n<b>ok</b>\r\n', skipped: 0 });
  const live = await js('({ text: document.querySelector(".jc-bang .ct-bang-live").textContent, cancel: !!document.querySelector(".jc-bang .ct-bang-cancel"), b: document.querySelectorAll(".jc-bang b").length })');
  assert(live.text === 'PASS a.test.js\n50%\n100%\n<b>ok</b>\n' && live.cancel && live.b === 0, JSON.stringify(live));
  await js('__sent.length = 0; document.querySelector(".jc-bang .ct-bang-cancel").click(); true');
  assert(JSON.stringify(await sentOf('cw_bang_cancel')) === JSON.stringify([{ type: 'cw_bang_cancel', ref: bash.ref }]), JSON.stringify(await js('__sent')));
  await deliver({ type: 'task_bash', ref: bash.ref, command: 'npm test', output: 'PASS a.test.js\n100%\n(cancelled)', code: 130, cancelled: true, seconds: 4.2 });
  const done = await js('({ live: !!document.querySelector(".jc-bang .ct-bang-live"), cancel: !!document.querySelector(".jc-bang .ct-bang-cancel"), state: document.querySelector(".jc-bang .jc-bang-state").textContent, out: document.querySelector(".jc-bang .jc-bang-out").textContent })');
  assert(!done.live && !done.cancel && done.state === 'Cancelled' && done.out.endsWith('(cancelled)'), JSON.stringify(done));
  // What it printed goes with the next message, as it did.
  await js('__sent.length = 0; $("deck-input").value = "fix it"; $("deck-composer").requestSubmit(); true');
  const [msg] = await sentOf('task_send');
  assert(msg && msg.text.includes('$ npm test') && msg.text.includes('(exit 130)') && msg.text.endsWith('fix it'), JSON.stringify(msg));
});

test('@ suggests the terminal, folders, where names are defined and, after the first words, other sessions', async () => {
  await featureScript('code-mentions.js');
  await open(1);
  await deliver({ type: 'tasks', items: [await js('__task(1)'), await js('__task(2, { title: "API work", busy: false, status: "idle" })')] });
  await deliver({ type: 'project_files', directory: 'alpha', files: ['src/app.py', 'src/web/a.js', 'README.md'] });
  const shown = () => js('[...document.querySelectorAll("#cc-slash button")].map((b) => b.textContent)');
  await js('$("deck-input").value = ""; $("deck-input").focus(); true');
  await typeText('@ter');
  assert((await shown()).some((x) => x.startsWith('@terminal') && x.includes('Its last lines go with the message')), JSON.stringify(await shown()));
  await js('$("deck-input").value = ""; true');
  await typeText('@web');
  assert((await shown()).some((x) => x.startsWith('src/web/') && x.includes('Folder')), JSON.stringify(await shown()));
  // Names: asked as they're typed, shown when they come, put in as their file and line.
  await js('$("deck-input").value = ""; __sent.length = 0; true');
  await typeText('fix @retr');
  let asked = [];
  for (let i = 0; i < 40 && !asked.length; i++) { await sleep(25); asked = await sentOf('cw_symbols'); }
  assert(asked.length === 1 && asked[0].query === 'retr' && asked[0].id === 1, JSON.stringify(asked));
  await deliver({ type: 'cw_symbols', ref: asked[0].ref, items: [{ name: 'retry', path: 'src/app.py', line: 12 }] });
  await frames(2);
  const withName = await shown();
  assert(withName.some((x) => x.startsWith('retry') && x.includes('src/app.py:12')), JSON.stringify(withName));
  await js('[...document.querySelectorAll("#cc-slash button")].find((b) => b.textContent.startsWith("retry")).dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); true');
  assert(await js('$("deck-input").value') === 'fix @src/app.py (retry, line 12) ', await js('$("deck-input").value'));
  // Other sessions: after the first words only (at the start, @session-2 sends it there).
  await js('$("deck-input").value = ""; true');
  await typeText('ask @ses');
  assert((await shown()).some((x) => x.startsWith('@session-2') && x.includes('API work')), JSON.stringify(await shown()));
  assert(!(await shown()).some((x) => x.startsWith('@session-1')), 'offered this session itself');
  // A word about a page being read comes as a notice.
  await deliver({ type: 'cw_mentions', id: 1, text: 'Reading https://example.com/x for your message…' });
  assert(await js('document.body.textContent.includes("Reading https://example.com/x for your message…")'), 'no notice');
});

const MEMORY_CHOICES = [{ target: 'project', path: 'CLAUDE.md', exists: true }, { target: 'local', path: 'CLAUDE.local.md', exists: false }, { target: 'user', path: '~/.claude/CLAUDE.md', exists: false }];

test('A "#" note asks where it goes, the last place first; not saved, it goes back in the composer', async () => {
  await featureScript('code-memory.js');
  await open(1);
  await js('$("deck-input").value = "# always use <b>pnpm</b>"; $("deck-composer").requestSubmit(); true');
  const [note] = await sentOf('task_memory');
  assert(note && note.text === 'always use <b>pnpm</b>' && note.id === 1, JSON.stringify(await js('__sent')));
  await deliver({ type: 'cw_memory_ask', ref: 'm1', id: 1, text: 'always use <b>pnpm</b>', choices: MEMORY_CHOICES, last: 'local' });
  await frames(2);
  const card = await js(`({ buttons: [...document.querySelectorAll('#deck-timeline .cm-ask button')].map((b) => b.textContent),
    focused: document.activeElement && document.activeElement.dataset.target, note: document.querySelector('#deck-timeline .cm-note').textContent,
    b: document.querySelectorAll('#deck-timeline .cm-ask b').length })`);
  assert(card.buttons.join('|') === 'Just me, here|Project|Just me, everywhere|Don’t save' && card.focused === 'local', JSON.stringify(card));
  assert(card.note === 'always use <b>pnpm</b>' && card.b === 0, JSON.stringify(card));
  await js('__sent.length = 0; true');
  await press('Enter');
  assert(JSON.stringify(await sentOf('cw_memory_save')) === JSON.stringify([{ type: 'cw_memory_save', ref: 'm1', target: 'local' }]), JSON.stringify(await js('__sent')));
  assert(await js('!document.querySelector("#deck-timeline .cm-ask")'), 'the card stayed');
  // Declined: nothing saved, and the note is back to edit.
  await deliver({ type: 'cw_memory_ask', ref: 'm2', id: 1, text: 'maybe later', choices: MEMORY_CHOICES, last: 'project' });
  await js('__sent.length = 0; $("deck-input").value = ""; true');
  await press('Escape');
  assert(JSON.stringify(await sentOf('cw_memory_save')) === JSON.stringify([{ type: 'cw_memory_save', ref: 'm2', target: null }]), JSON.stringify(await js('__sent')));
  assert(await js('$("deck-input").value') === '# maybe later', await js('$("deck-input").value'));
});

test('The Files pane’s Memory menu opens the three CLAUDE.md files, the owner’s own outside the project', async () => {
  await js('localStorage.removeItem("jarvis.editor.drafts"); true');
  await featureScript('code-editor.js');
  await open(1);
  await js('jarvisFeatures.openPane("files"); true');
  await deliver({ type: 'project_files', directory: 'alpha', files: ['src/app.py'] });
  await frames(2);
  await js('__sent.length = 0; true');
  assert(await clickText('#jc-pane-body .ce-top', 'Memory'), 'no Memory button');
  const items = await js('[...document.querySelectorAll("#jc-menu button")].map((b) => b.textContent)');
  assert(items.some((x) => x.startsWith('Yours: ~/.claude/CLAUDE.md')) && items.some((x) => x.startsWith('Local: CLAUDE.local.md')), JSON.stringify(items));
  await js('[...document.querySelectorAll("#jc-menu button")].find((b) => b.textContent.startsWith("Yours")).click(); true');
  const [read] = await sentOf('cw_file_read');
  assert(read && read.memory === 'user' && read.path === 'CLAUDE.md' && read.id === undefined, JSON.stringify(read));
  await deliver({ type: 'cw_file', path: 'CLAUDE.md', ref: read.ref, error: 'There\'s no such file.', missing: true });
  await frames(2);
  assert(await js('document.querySelector("#jc-pane-body .ce-tab.on .ce-tab-name").title') === '~/.claude/CLAUDE.md', 'not shown as the owner’s own');
  await typeAtEnd('# Me\n');
  await js('__sent.length = 0; true');
  await chord('s');
  const [save] = await sentOf('cw_file_save');
  assert(save && save.memory === 'user' && save.path === 'CLAUDE.md' && save.create === true && save.base === null && save.text === '# Me\n', JSON.stringify(save));
});

test('The Health pane shows the engine, the sign-in with the command that signs in, and reconnects a failed session', async () => {
  await featureScript('code-health.js');
  await open(1);
  await clickAt('#jc-more');
  assert(await clickText('#jc-menu', 'Health'), 'no Health in the More menu');
  const [asked] = await sentOf('cw_health');
  assert(asked && asked.id === 1 && !asked.fresh, JSON.stringify(await js('__sent')));
  await deliver({ type: 'cw_health', id: 1, sdk: '0.9.1',
    engine: { version: '2.1.3', path: '/app/_bundled/claude', bundled: true },
    signin: { state: 'problem', summary: 'Not signed in', hint: 'Sign in once in Terminal with the command below, then check again.', plan: '', command: 'claude auth <b>login</b>' },
    session: { id: 1, status: 'failed', connected: false, busy: false, model: 'Fable', error: 'Claude Code exited: <i>boom</i>', fell_back: false } });
  await frames(2);
  const r = await js(`({ title: $('jc-pane-title').textContent, text: $('jc-pane-body').textContent,
    command: (document.querySelector('#jc-pane-body .ch-command code') || {}).textContent,
    error: (document.querySelector('#jc-pane-body .ch-error') || {}).textContent,
    markup: document.querySelectorAll('#jc-pane-body b, #jc-pane-body i').length })`);
  assert(r.title === 'Health' && r.text.includes('2.1.3') && r.text.includes('Built into Jarvis') && r.text.includes('Not signed in'), JSON.stringify(r));
  assert(r.command === 'claude auth <b>login</b>' && r.error === 'Claude Code exited: <i>boom</i>' && r.markup === 0, JSON.stringify(r));
  assert(r.text.includes('It stopped with an error') && r.text.includes('Not connected'), r.text);
  await js('__sent.length = 0; true');
  assert(await clickText('#jc-pane-body', 'Reconnect'), 'no Reconnect');
  assert(JSON.stringify(await sentOf('cw_reconnect')) === JSON.stringify([{ type: 'cw_reconnect', id: 1 }]), JSON.stringify(await js('__sent')));
  await js('__sent.length = 0; true');
  assert(await clickText('#jc-pane-body', 'Check again'), 'no Check again');
  const [fresh] = await sentOf('cw_health');
  assert(fresh && fresh.fresh === true, JSON.stringify(await js('__sent')));
});

test('Export the whole session: share-safe, paths hidden, as a PDF, then shown in Finder', async () => {
  await featureScript('code-export.js');
  await open(1);
  await clickAt('#jc-more');
  assert(await clickText('#jc-menu', 'Export the whole session…'), 'no Export in the More menu');
  assert(await js('$("jc-pane-title").textContent') === 'Export', 'the pane did not open');
  await js(`(() => {
    const radio = (label) => [...document.querySelectorAll('#jc-pane-body .cx-option')].find((l) => l.textContent.startsWith(label)).querySelector('input');
    radio('Share-safe').click(); radio('A PDF').click();
    document.querySelector('#jc-pane-body .cx-check input').click();
    return true; })()`);
  // The session changing meanwhile doesn't undo what was chosen.
  await deliver({ type: 'tasks', items: [await js('__task(1, { last_action: "Reading b.py" })')] });
  await js('__sent.length = 0; true');
  assert(await clickText('#jc-pane-body', 'Export'), 'no Export button');
  const [asked] = await sentOf('cw_export');
  assert(asked && asked.id === 1 && asked.safe === true && asked.anonymize === true && asked.format === 'pdf', JSON.stringify(asked));
  assert(await js('document.querySelector("#jc-pane-body .cx-go").textContent') === 'Exporting…', 'no sign of exporting');
  await deliver({ type: 'cw_export', ref: asked.ref, ok: true, path: '/Users/x/Documents/Jarvis/Jarvis Code/2026-09-30 0930 Fix (share-safe).pdf', name: '2026-09-30 0930 Fix (share-safe).pdf', entries: 12 });
  await frames(2);
  assert(await js('$("jc-pane-body").textContent.includes("2026-09-30 0930 Fix (share-safe).pdf")'), 'the saved name is not shown');
  await js('__sent.length = 0; true');
  assert(await clickText('#jc-pane-body', 'Show in Finder'), 'no Show in Finder');
  assert(JSON.stringify(await sentOf('cw_export_reveal')) === JSON.stringify([{ type: 'cw_export_reveal', path: '/Users/x/Documents/Jarvis/Jarvis Code/2026-09-30 0930 Fix (share-safe).pdf' }]), JSON.stringify(await js('__sent')));
  // A PDF without the app says why.
  await js('__sent.length = 0; true');
  assert(await clickText('#jc-pane-body', 'Export'), 'no Export button');
  const [again] = await sentOf('cw_export');
  await deliver({ type: 'cw_export', ref: again.ref, error: 'A PDF needs the app\'s window: export the page instead, or try again in the app.' });
  await frames(2);
  assert(await js('document.querySelector("#jc-pane-body .cx-result.bad").textContent').then((t) => t.includes('needs the app’s window') || t.includes('needs the app\'s window')), 'the error is not shown');
});

// ──

let base;
app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const server = await serve();
  base = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({ show: false, width: 1280, height: 840, webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true } });
  win.webContents.debugger.attach('1.3');
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error' && !/Failed to load resource|WebSocket|ERR_NAME_NOT_RESOLVED|fonts\./.test(e.message)) errors.push(e.message); });
  let failed = 0;
  for (const t of tests) {
    errors.length = 0;
    try {
      await fresh();
      await t.fn();
      if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
      console.log(`ok     ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`FAILED ${t.name}\n       ${err.message}`);
    }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  server.close();
  win.destroy();
  app.exit(failed ? 1 : 0);
});
