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

function serve() {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    // A feature module's window files (loaded by a test that wants one: featureScript).
    const feature = pathname.startsWith('/static/features/') ? `features/${path.basename(pathname)}` : '';
    const name = pathname === '/' ? 'index.html' : feature || (pathname.startsWith('/static/') ? path.basename(pathname) : '');
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
