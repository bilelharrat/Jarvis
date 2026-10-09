// Logbook (web/features/code-logbook.js and .css), Eden Code under the Obsidian look, in a real
// Chromium: the runs of ledger rows it marks as each frame is drawn (lb-after, lb-end) say
// exactly what the sibling selectors they stand in for say, however the transcript changes; a
// row is drawn again when its entry changes, and numbered again when one before it goes; all of
// it goes with the look; and what the Changes pane fetched for a session (code_changes.js, which
// the margin reads) goes with the session, or with its backend, while what the owner made there
// (a comment not sent yet, the view) stays with it. No backend: Node serves the
// window's files on 127.0.0.1, events go to the window's own heard(), and nothing is shown.
//
//   app/node_modules/.bin/electron tests/web/code-logbook.e2e.cjs      (about 10 s; exit 1 on a failure)
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const WEB = path.join(__dirname, '..', '..', 'src', 'jarvis', 'web');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const USER_DATA = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jarvis-logbook-test-'));
app.setPath('userData', USER_DATA);
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');

function serve() {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    // (no /features.json: the test puts in the one module it means to, as features.js would)
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
let base;
const js = (code) => win.webContents.executeJavaScript(code, true);
const frames = (n = 3) => js(`new Promise((r) => { let k = ${n}; const f = () => (--k ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); })`);
const heard = (ev) => js(`heard(${JSON.stringify(ev)}); true`);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(cond, message) { if (!cond) throw new Error(message); }

const at = (s) => `2026-10-03T15:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const tool = (id, name, extra = {}) => ({ role: 'tool', tool: name, tool_id: id, text: `${name} src/${id}.py`, detail: `src/${id}.py`, status: 'done', output: 'a\nb', at: at(id.length * 7), ...extra });
const TRANSCRIPT = [
  { role: 'user', text: 'fix the bug', at: at(1) },
  tool('t1', 'Read'),
  tool('t2', 'Grep', { text: 'Searching for bug' }),
  { role: 'assistant', text: 'Found it.', at: at(20) },
  tool('t3', 'Edit', { detail: 'src/a.py\n- old\n+ new' }),
  tool('t4', 'Bash', { detail: '$ make test', status: 'running', output: '' }),
  { role: 'user', text: 'and the docs', at: at(40) },
  tool('t5', 'Read'),
];

// A fresh window in the Obsidian look, Eden Code open on session 3, Logbook put in as
// features.js would put it in (its stylesheet first).
async function fresh() {
  await win.loadURL(`${base}/?token=test`);
  await js(`
    window.__sent = [];
    send = (m) => { __sent.push(m); return true; };
    heard({ type: 'hello', hub_id: 'hub-a', seq: 1, state: 'idle', muted: true, status: {}, activity: [], tasks: [],
      prefs: { look: 'obsidian', language: 'en', models: [], personas: [], humor: 50, features: {} }, brain: {}, approvals: [], history: [] });
    new Promise((resolve) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/static/features/code-logbook.css';
      link.onload = resolve;
      document.head.append(link);
    });
  `);
  await js(`${fs.readFileSync(path.join(WEB, 'features', 'code-logbook.js'), 'utf8')}\n;true`);
  await js(`
    window.__task = { id: 3, kind: 'code', folder: 'alpha', label: 'Eden Code · alpha', title: 'Session 3', prompt: 'Session 3',
      mode: 'ask', busy: true, status: 'running', files_changed: [], todos: [], background: [], queue: [], last_action: '', add_dirs: [], plugins: [] };
    deckProjects = [{ name: 'alpha', branch: 'main' }]; deckProject = 'alpha'; openProjects.add('alpha');
    heard({ type: 'tasks', items: [__task] });
    toggleCC(true);
    selectTask(3);
    // What each of the list's children is, by the classes Logbook keeps and by the selectors
    // they stand in for (matches() asks the browser itself; no stylesheet has them now).
    window.__runs = () => [...$('deck-timeline').children].map((li) => ({
      row: li.classList.contains('lb-row'),
      after: li.classList.contains('lb-after'), end: li.classList.contains('lb-end'),
      wantAfter: li.matches('.jc-log > .lb-row + .lb-row'), wantEnd: li.matches('.jc-log > .lb-row:not(:has(+ .lb-row))'),
      margin: getComputedStyle(li).marginTop, rule: getComputedStyle(li).borderBottomWidth,
      // an edit's target, brighter: by the kind beside it, as .lb-row:has(.lb-kind.edit) said
      bright: li.matches('.lb-row:has(.lb-kind.edit)'),
      target: li.querySelector('.lb-target') ? getComputedStyle(li.querySelector('.lb-target')).color : null,
    }));
    window.__ink = (() => { const probe = document.createElement('span'); probe.style.color = 'var(--ink)'; $('deck-timeline').append(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; })();
    window.__numbers = () => [...$('deck-timeline').querySelectorAll(':scope > .lb-row .lb-n')].map((n) => n.textContent);
    true;
  `);
  await heard({ type: 'task_transcript', id: 3, entries: TRANSCRIPT });
  await frames();
}

// Every child of the list: marked as the selectors say, and drawn so (the margin and the rule).
async function runsAgree(when) {
  const runs = await js('__runs()');
  const ink = await js('__ink');
  runs.forEach((r, i) => {
    assert(r.after === r.wantAfter && r.end === r.wantEnd, `${when}: child ${i}: ${JSON.stringify(r)}`);
    if (r.after) assert(r.margin === '-22px', `${when}: child ${i} isn't drawn tight to the row before: ${r.margin}`);
    if (r.end) assert(r.rule === '1px', `${when}: child ${i} has no closing rule: ${r.rule}`);
    if (r.target !== null) assert((r.target === ink) === r.bright, `${when}: child ${i}'s target is ${r.target} (ink: ${ink})`);
  });
  return runs;
}

test('The runs of rows are marked as the sibling selectors said, however the list changes', async () => {
  let runs = await runsAgree('drawn');
  assert(runs.filter((r) => r.row).length === 5, JSON.stringify(runs));
  assert(runs.some((r) => r.after) && runs.filter((r) => r.end).length === 3, JSON.stringify(runs));
  // New steps at the end: the run goes on, its rule moves down.
  await heard({ type: 'task_log', id: 3, seq: 20, entry: tool('t6', 'Bash', { detail: '$ ls' }) });
  await heard({ type: 'task_log', id: 3, seq: 21, entry: tool('t7', 'Glob', { text: 'Searching for *.md' }) });
  await frames();
  runs = await runsAgree('two steps added');
  assert(runs[runs.length - 1].end && runs[runs.length - 1].after, JSON.stringify(runs.slice(-3)));
  // Claude's words between steps, an approval at the end, live words.
  await heard({ type: 'task_log', id: 3, seq: 22, entry: { role: 'assistant', text: 'Now the docs.', at: at(50) } });
  await heard({ type: 'task_log', id: 3, seq: 23, entry: tool('t8', 'Write', { detail: 'docs/a.md (new contents)' }) });
  await heard({ type: 'approval', id: 'a1', task_id: 3, tool: 'Bash', question: 'Run this command?', detail: '$ rm -rf build',
    choices: [{ id: 'allow', label: 'Yes' }, { id: 'deny', label: 'No' }] });
  await heard({ type: 'task_stream', id: 3, part: 'text', text: 'Thinking about it' });
  await frames();
  await runsAgree('words, an approval and live words');
  // A row from the middle of a run gone (as the list is trimmed), then the first one.
  await js('[...$("deck-timeline").children].filter((li) => li.classList.contains("lb-row"))[1].remove(); true');
  await frames();
  await runsAgree('a row taken from the middle');
  await js('$("deck-timeline").firstElementChild.remove(); $("deck-timeline").querySelector(":scope > .lb-row").remove(); true');
  await frames();
  await runsAgree('the first rows taken');
  await heard({ type: 'approval_resolved', id: 'a1' });
  await frames();
  await runsAgree('the approval answered');
});

test('A row is drawn again when its entry changes, and numbered again when one before it goes', async () => {
  const result = (id) => js(`(() => { const li = $("deck-timeline").querySelector('[data-tool-id="${id}"]'); return li ? li.querySelector(".lb-result").textContent : null; })()`);
  assert(await result('t4') === '…', `a running step: ${await result('t4')}`);
  await heard({ type: 'task_log_update', id: 3, tool_id: 't4', status: 'done', output: '12 passed' });
  await frames();
  assert(await result('t4') === '12 ✓', `the step that finished: ${await result('t4')}`);
  await heard({ type: 'task_log_update', id: 3, tool_id: 't4', status: 'failed', output: '2 failed, 10 passed' });
  await frames();
  assert(await result('t4') === '2 ✗', `the step that failed: ${await result('t4')}`);
  assert(JSON.stringify(await js('__numbers()')) === JSON.stringify(['№ 01', '№ 02', '№ 03', '№ 04', '№ 05']), JSON.stringify(await js('__numbers()')));
  await js('$("deck-timeline").querySelector(\'[data-tool-id="t2"]\').remove(); true');
  await frames();
  assert(JSON.stringify(await js('__numbers()')) === JSON.stringify(['№ 01', '№ 02', '№ 03', '№ 04']), JSON.stringify(await js('__numbers()')));
  const kinds = await js('[...$("deck-timeline").querySelectorAll(":scope > .lb-row .lb-kind")].map((n) => n.textContent)');
  assert(JSON.stringify(kinds) === JSON.stringify(['READ', 'EDIT', 'RUN', 'READ']), JSON.stringify(kinds));
});

test('Each of Claude’s and your messages keeps one gutter, its time redrawn in place', async () => {
  const gutters = () => js('[...$("deck-timeline").children].map((li) => li.querySelectorAll(":scope > .lb-gut").length).join("")');
  const before = await gutters();
  assert(before === '10010010', before);  // the two of yours and Claude's words
  await heard({ type: 'task_log', id: 3, seq: 30, entry: tool('t9', 'Read') });
  await frames();
  assert(await gutters() === `${before}0`, await gutters());
  const you = await js('[...$("deck-timeline").querySelectorAll(":scope > .jc-user > .lb-gut")].map((g) => g.textContent)');
  assert(JSON.stringify(you) === JSON.stringify(['00:00YOU', '00:39YOU']), JSON.stringify(you));
});

test('Another look takes the runs away with the rows; Obsidian again puts them back', async () => {
  await js(`heard({ type: 'prefs', look: 'glass', language: 'en', models: [], personas: [], humor: 50, features: {} }); true`);
  await frames();
  const left = await js('$("deck-timeline").querySelectorAll(".lb-row, .lb-after, .lb-end, .lb-gut").length');
  assert(left === 0, `${left} of Logbook's marks left in another look`);
  await js(`heard({ type: 'prefs', look: 'obsidian', language: 'en', models: [], personas: [], humor: 50, features: {} }); true`);
  await frames();
  const runs = await runsAgree('back in Obsidian');
  assert(runs.filter((r) => r.row).length === 5 && runs.filter((r) => r.end).length === 3, JSON.stringify(runs));
  assert(JSON.stringify(await js('__numbers()')) === JSON.stringify(['№ 01', '№ 02', '№ 03', '№ 04', '№ 05']), JSON.stringify(await js('__numbers()')));
});

// A session's changes as the hub sends them (code_changes.js): one file, in the view asked for.
const changes = (id, view = 'session') => ({ type: 'code_changes', id, view, git: true, workspace: {}, conflicts: [], totals: { files: 1, added: 2, removed: 1, hunks: 0 },
  files: [{ path: `src/only${id}.py`, old_path: '', status: 'M', binary: false, sensitive: false, added: 2, removed: 1, omitted: false, hunks: [] }] });
const helloFrom = (hub, tasks, seq = 1) => ({ type: 'hello', hub_id: hub, seq, state: 'idle', muted: true, status: {}, activity: [], tasks,
  prefs: { look: 'obsidian', language: 'en', models: [], personas: [], humor: 50, features: {} }, brain: {}, approvals: [], history: [] });

test('Changes kept for a session go when it leaves the list, and all of them with another backend', async () => {
  await js(`${fs.readFileSync(path.join(WEB, 'features', 'code_changes.js'), 'utf8')}\n;true`);
  const kept = () => js('[...JarvisChanges.store.data.keys()].sort().join(" ")');
  const touched = () => js('[...document.querySelectorAll(".lb-margin .lb-file-name")].map((n) => n.textContent).join(" ")');
  await heard({ type: 'tasks', items: [await js('__task'), { ...(await js('__task')), id: 4, title: 'Session 4' }] });
  // The margin asks for session 3's files first (it asks again at most every 20 s, except
  // after a hello: below, another backend's must be asked for at once).
  await frames();
  assert((await js('__sent.filter((m) => m.type === "code_changes" && m.id === 3).length')) >= 1, 'the margin never asked');
  await heard(changes(3));
  await heard(changes(4));
  await frames();
  assert(await kept() === '3:session 4:session', await kept());
  assert(await touched() === 'only3.py', `the margin: ${await touched()}`);
  // Session 4 leaves the list: what was kept for it goes; session 3's stays.
  await heard({ type: 'tasks', items: [await js('__task')] });
  await frames();
  assert(await kept() === '3:session', await kept());
  assert(await touched() === 'only3.py', `the margin: ${await touched()}`);
  // The same backend again (a reconnect): nothing goes.
  await heard({ type: 'hello', hub_id: 'hub-a', seq: 2, state: 'idle', muted: true, status: {}, activity: [], tasks: [await js('__task')],
    prefs: { look: 'obsidian', language: 'en', models: [], personas: [], humor: 50, features: {} }, brain: {}, approvals: [], history: [], replay: true });
  assert(await kept() === '3:session', await kept());
  // Another backend: its session 3 isn't the one these changes were of.
  await heard({ type: 'hello', hub_id: 'hub-b', seq: 1, state: 'idle', muted: true, status: {}, activity: [], tasks: [await js('__task')],
    prefs: { look: 'obsidian', language: 'en', models: [], personas: [], humor: 50, features: {} }, brain: {}, approvals: [], history: [] });
  assert(await kept() === '', await kept());
  await js('__sent.length = 0; selectTask(3); true');
  await frames();
  assert(await touched() === '', `the old backend's file is in the margin: ${await touched()}`);
  assert((await js('__sent.filter((m) => m.type === "code_changes" && m.id === 3).length')) >= 1, 'the new session 3’s changes were never asked for');
});

test('What the owner made in the Changes pane outlasts a restart, and a session let go and reopened', async () => {
  await js(`${fs.readFileSync(path.join(WEB, 'features', 'code_changes.js'), 'utf8')}\n;true`);
  const task = { ...(await js('__task')), session_id: 'abc' };
  const pane = () => js(`({
    bar: (document.querySelector('#jc-pane-body .jcx-sendbar') || {}).textContent || '',
    view: (document.querySelector('#jc-pane-body .jcx-seg-btn.on') || {}).textContent || '',
    files: [...document.querySelectorAll('#jc-pane-body .jcx-path')].map((n) => n.textContent).join(' '),
  })`);
  const asked = () => js('__sent.filter((m) => m.type === "code_changes" && m.id === 3 && !m.path).map((m) => m.view)');
  await heard({ type: 'tasks', items: [task] });
  await js('openPane("diff"); true');
  await heard(changes(3));
  // Whole branch, chosen in the pane, and a comment not sent yet (as the line's editor keeps it).
  await js('[...document.querySelectorAll("#jc-pane-body .jcx-seg-btn")].find((b) => b.textContent === "Whole branch").click(); true');
  await heard(changes(3, 'branch'));
  await js(`JarvisChanges.store.comments.set(3, [{ path: 'src/only3.py', line: 12, side: 'n', text: 'rename this', excerpt: '' }]); JarvisChanges.render(); true`);
  let p = await pane();
  assert(p.bar.includes('1 comment') && p.view === 'Whole branch' && p.files === 'src/only3.py', JSON.stringify(p));
  // Let go from the list (past the ended ones it shows), then reopened from the history: back
  // under its own id, its comment and view with it; its changes asked for again. (In one go:
  // a frame between would let the margin ask first.)
  await js(`heard({ type: 'tasks', items: [] }); heard({ type: 'tasks', items: [${JSON.stringify(task)}] });
    __sent.length = 0; selectTask(3); true`);
  p = await pane();
  assert(p.bar.includes('1 comment') && p.view === 'Whole branch', `reopened: ${JSON.stringify(p)}`);
  const again = await asked();
  assert(again.length && again.every((v) => v === 'branch'), `reopened, asked for: ${JSON.stringify(again)}`);
  await heard(changes(3, 'branch'));
  // The backend restarts: the kept session rests under its own id, and the window opens it
  // again by its Claude session. The comment and the view are still there; the old backend's
  // changes aren't shown, and the new one's are asked for.
  await js('__sent.length = 0; true');
  await heard(helloFrom('hub-b', [{ ...task, status: 'resting', busy: false }]));
  await frames();
  p = await pane();
  assert(p.bar.includes('1 comment') && p.view === 'Whole branch', `after a restart: ${JSON.stringify(p)}`);
  assert(p.files === '', `the old backend’s changes are still shown: ${p.files}`);
  const anew = await asked();
  assert(anew.length && anew.every((v) => v === 'branch'), `after a restart, asked for: ${JSON.stringify(anew)}`);
  await heard(changes(3, 'branch'));
  assert((await pane()).files === 'src/only3.py', JSON.stringify(await pane()));
});

// The cards' places that hang on what Eden Code is showing (a :has() on the body's own child
// #cc, so a change anywhere else in the page never has it asked again): at the right with the
// index a rail; at the top of split view's right pane; as before once Eden Code is hidden.
test('With the index a rail the window’s cards sit at the right, and at the top of a split pane', async () => {
  const cards = () => js('(() => { const s = getComputedStyle($("cards")); return { right: s.right, bottom: s.bottom, top: s.top, width: s.width }; })()');
  const before = await cards();
  assert(before.right !== '22px', `the cards are at the right before the index is a rail: ${JSON.stringify(before)}`);
  await js('$("cc").classList.add("sv-on", "lb-folded"); true');
  let now = await cards();
  assert(now.right === '22px' && now.bottom === '96px', `with the index a rail: ${JSON.stringify(now)}`);
  await js('$("cc").hidden = true; true');
  now = await cards();
  assert(now.right !== '22px' && now.bottom !== '96px', `Eden Code hidden: ${JSON.stringify(now)}`);
  await js('$("cc").hidden = false; $("cc").classList.remove("sv-on", "lb-folded"); true');
  assert(JSON.stringify(await cards()) === JSON.stringify(before), JSON.stringify(await cards()));
  // Split view's right pane (its own page: body.jc-split-pane), with code-split.css.
  await js(`new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/static/features/code-split.css';
    link.onload = resolve;
    document.head.append(link);
  })`);
  await js('document.body.classList.add("jc-split-pane"); true');
  now = await cards();
  assert(now.top === '64px' && now.right === '14px', `in a split pane: ${JSON.stringify(now)}`);
  await js('$("cc").hidden = true; true');
  now = await cards();
  assert(now.top !== '64px', `in a split pane with Eden Code hidden: ${JSON.stringify(now)}`);
  await js('$("cc").hidden = false; document.body.classList.remove("jc-split-pane"); true');
});

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const server = await serve();
  base = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({ show: false, width: 1280, height: 840, webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true } });
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error' && !/Failed to load resource|WebSocket|ERR_NAME_NOT_RESOLVED|fonts\./.test(e.message)) errors.push(e.message); });
  let failed = 0;
  for (const t of tests) {
    errors.length = 0;
    try {
      await win.loadURL('about:blank');
      await win.webContents.session.clearStorageData({ storages: ['localstorage'] });
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
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) { /* best effort: the run's own profile */ }
  app.exit(failed ? 1 : 0);
});
