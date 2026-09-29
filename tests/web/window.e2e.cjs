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
    const name = pathname === '/' ? 'index.html' : pathname.startsWith('/static/') ? path.basename(pathname) : '';
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
