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
