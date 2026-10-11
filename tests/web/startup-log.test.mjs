// What the app writes about how it starts (app/startup-log.js: app.log, the engine's last words) and the waiting
// window that says it (app/loading.html, loading.js, loading.css). node --test tests/web/
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { createTrace, createTail, MAX_BYTES } = require('../../app/startup-log.js');
const appFile = (name) => readFileSync(new URL(`../../app/${name}`, import.meta.url), 'utf8');
const temp = () => mkdtempSync(path.join(tmpdir(), 'startup-'));

test('each step is a line with the time and the seconds since the start, in a folder made as needed', () => {
  const dir = path.join(temp(), 'Logs', 'deeper');
  let clock = Date.parse('2026-10-09T04:00:00.000Z');
  const trace = createTrace(path.join(dir, 'app.log'), { now: () => clock });
  trace.write('started');
  clock += 2500;
  trace.write('the engine answers');
  const lines = readFileSync(path.join(dir, 'app.log'), 'utf8').trim().split('\n');
  assert.deepEqual(lines, ['2026-10-09T04:00:00.000Z +0.0s started', '2026-10-09T04:00:02.500Z +2.5s the engine answers']);
});

test('a step of several lines keeps them together under it', () => {
  const dir = temp();
  const trace = createTrace(path.join(dir, 'app.log'));
  trace.write('the engine stopped; it last said:\nTraceback\nModuleNotFoundError: no module named x');
  const text = readFileSync(path.join(dir, 'app.log'), 'utf8');
  assert.match(text, /it last said:\n    Traceback\n    ModuleNotFoundError/);
});

test('past its size the file turns into app.1.log and a new one starts', () => {
  const dir = temp();
  const file = path.join(dir, 'app.log');
  writeFileSync(file, 'x'.repeat(2048));
  const trace = createTrace(file, { max: 1024 });
  trace.write('fresh');
  assert.equal(readFileSync(path.join(dir, 'app.1.log'), 'utf8'), 'x'.repeat(2048));
  assert.match(readFileSync(file, 'utf8'), /fresh/);
  assert.ok(MAX_BYTES >= 1024 * 1024);
});

test('the trace never throws, whatever the disk does', () => {
  const broken = { mkdirSync() { throw new Error('read-only'); }, statSync() { throw new Error('no'); }, appendFileSync() { throw new Error('full'); }, renameSync() {} };
  const trace = createTrace('/nowhere/app.log', { fsys: broken });
  assert.doesNotThrow(() => trace.write('still fine'));
  assert.match(trace.write('returned all the same'), /returned all the same/);
});

test('the tail keeps what the engine said last, a few lines of it', () => {
  const tail = createTail(200);
  for (let i = 1; i <= 100; i += 1) tail.add(`line ${i}\n`);
  const last = tail.last(3);
  assert.equal(last, 'line 98\nline 99\nline 100');
  assert.ok(tail.last(50, 40).length <= 40);
  assert.equal(createTail().last(), '');
  const none = createTail();
  none.add('\n\n  \n');
  assert.equal(none.last(), '');
  // a new start of the engine forgets the one before
  tail.reset();
  tail.add('fresh start\n');
  assert.equal(tail.last(), 'fresh start');
});

// ── the waiting window ──

function runLoading(search) {
  const nodes = {
    message: { textContent: 'Waking up Eden…', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
    note: { textContent: '' },
    detail: { textContent: '', hidden: true },
  };
  const classes = new Set();
  const document = { title: 'Eden', body: { classList: { add: (c) => classes.add(c) } }, getElementById: (id) => nodes[id] };
  const window = {};
  vm.runInNewContext(appFile('loading.js'), { URLSearchParams, location: { search }, document, window });
  return { nodes, classes, document, window };
}

test('the waiting window is Eden\'s unless an app says otherwise', () => {
  const html = appFile('loading.html');
  assert.match(html, /<title>Eden<\/title>/);
  assert.match(html, />Waking up Eden…<\/p>/);
  const { nodes, classes, document } = runLoading('?app=jarvis');
  assert.equal(nodes.message.textContent, 'Waking up Eden…');
  assert.equal(document.title, 'Eden');
  assert.equal(classes.size, 0);
});

test('Eden Code waits under its own name, and so does J.A.R.V.I.S. Daredevil, in its own colours', () => {
  const eden = runLoading('?app=eden-code');
  assert.deepEqual([...eden.classes], ['eden-code']);
  assert.equal(eden.nodes.message.textContent, 'Opening Eden Code…');
  const dare = runLoading('?app=daredevil');
  assert.deepEqual([...dare.classes], ['daredevil']);
  assert.equal(dare.document.title, 'J.A.R.V.I.S. Daredevil');
  assert.equal(dare.nodes.message.textContent, 'Opening J.A.R.V.I.S. Daredevil…');
});

test('a problem is said at once (to a screen reader too), with what the engine last said', () => {
  const { nodes, classes } = runLoading(`?app=daredevil&error=${encodeURIComponent('The backend stopped (exit 1).')}&detail=${encodeURIComponent('ModuleNotFoundError: x')}`);
  assert.ok(classes.has('error'));
  assert.equal(nodes.message.textContent, 'The backend stopped (exit 1).');
  assert.deepEqual([nodes.message.attrs.role, nodes.message.attrs['aria-live']], ['alert', 'assertive']);
  assert.equal(nodes.detail.textContent, 'ModuleNotFoundError: x');
  assert.equal(nodes.detail.hidden, false);
  const quiet = runLoading('?app=jarvis&error=Oops');
  assert.equal(quiet.nodes.detail.hidden, true);
});

test('the shell can add a line under the waiting message, in place', () => {
  const { nodes, window } = runLoading('?app=jarvis');
  window.sayWhileWaiting('Still starting.');
  assert.equal(nodes.note.textContent, 'Still starting.');
  window.sayWhileWaiting(undefined);
  assert.equal(nodes.note.textContent, '');
});

test('the page announces itself: the message and the note are live regions, and the policy still allows only its own files', () => {
  const html = appFile('loading.html');
  assert.match(html, /<p id="message" role="status" aria-live="polite">/);
  assert.match(html, /<p id="note" role="status" aria-live="polite">/);
  assert.match(html, /default-src 'self'; script-src 'self'; style-src 'self'/);
  assert.doesNotMatch(html, /\sstyle=|<style|javascript:/);
  const css = appFile('loading.css');
  assert.match(css, /body\.daredevil\s*\{[^}]*#000000[^}]*#ffff00/);
});

test('the build ships the new files: every top-level script and page is in the app, the log module included', () => {
  const build = appFile('scripts/release/windows.js');
  assert.match(build, /files: \['\*\.js', '\*\.html', '\*\.css'/);
  assert.ok(existsSync(new URL('../../app/startup-log.js', import.meta.url)));
  // …and the daredevil flavor has its own build, name and icons
  assert.match(build, /--daredevil/);
  assert.match(build, /'J\.A\.R\.V\.I\.S\. Daredevil'/);
  assert.ok(existsSync(new URL('../../app/build/daredevil/icon-1024.png', import.meta.url)));
});

// ── waiting for the engine (app/wait-backend.js) ──

const { waitForHealth, SLOW_WORDS } = require('../../app/wait-backend.js');

// A clock the test moves, and a scheduler that runs what was asked for when its time comes.
function fakeTime() {
  let clock = 0;
  const queue = [];
  return {
    now: () => clock,
    later: (fn, ms) => queue.push({ at: clock + ms, fn }),
    // runs the next due thing, moving the clock to it; false when nothing is waiting
    step() {
      if (!queue.length) return false;
      queue.sort((a, b) => a.at - b.at);
      const next = queue.shift();
      clock = Math.max(clock, next.at);
      next.fn();
      return true;
    },
    advance(ms) { clock += ms; },
  };
}
// http.get stand-in: answers by the clock: refused until `up` ms, then 200 (or `status`).
function fakeGet(time, { up = Infinity, status = 200 } = {}) {
  const calls = [];
  const get = (options, onResponse) => {
    calls.push(options);
    const handlers = {};
    const req = { on: (event, fn) => { handlers[event] = fn; return req; }, destroy: () => {} };
    queueMicrotask(() => {
      if (time.now() >= up) onResponse({ statusCode: status, resume() {} });
      else if (handlers.error) handlers.error(new Error('ECONNREFUSED'));
    });
    return req;
  };
  get.calls = calls;
  return get;
}
async function drain(time, until) { // runs the scheduler (letting promises settle between steps) until `until()` or nothing is left
  for (let i = 0; i < 5000 && !until(); i += 1) {
    await new Promise((r) => setImmediate(r));
    if (until()) break;
    if (!time.step()) await new Promise((r) => setImmediate(r));
  }
}

test('the engine is waited for until it answers, with the words said once each as the wait gets long', async () => {
  const time = fakeTime();
  const said = [];
  const notes = [];
  let settled = null;
  waitForHealth({
    port: () => 51234, running: () => true, timeoutMs: 600000, get: fakeGet(time, { up: 130000 }),
    now: time.now, later: time.later, say: (t) => said.push(t), note: (t) => notes.push(t),
    words: SLOW_WORDS.map(([after, text]) => [after, text.replace('%LOG%', 'app.log')]),
  }).then(() => { settled = 'up'; }, (e) => { settled = e.message; });
  await drain(time, () => settled);
  assert.equal(settled, 'up');
  assert.equal(said.length, 3, JSON.stringify(said));
  assert.match(said[0], /first start after installing takes a minute or two/);
  assert.match(said[2], /app\.log says what it did/);
  assert.ok(notes.some((n) => /the engine answers after 130\.\d s/.test(n)), JSON.stringify(notes));
  assert.equal(notes.filter((n) => /still waiting/.test(n)).length, 3);
});

test('a quick start says nothing', async () => {
  const time = fakeTime();
  const said = [];
  let settled = null;
  waitForHealth({ port: () => 1, running: () => true, timeoutMs: 600000, get: fakeGet(time, { up: 3000 }), now: time.now, later: time.later, say: (t) => said.push(t) })
    .then(() => { settled = 'up'; });
  await drain(time, () => settled);
  assert.equal(settled, 'up');
  assert.deepEqual(said, []);
});

test('an engine that is gone is not waited for: the caller that saw it exit has said what happens next', async () => {
  const time = fakeTime();
  let alive = true;
  let settled = null;
  waitForHealth({ port: () => 1, running: () => alive, timeoutMs: 600000, get: fakeGet(time), now: time.now, later: time.later })
    .catch((e) => { settled = e; });
  await drain(time, () => time.now() >= 2000);
  alive = false;
  await drain(time, () => settled);
  assert.equal(settled.exited, true);
});

test('the time allowed runs out with an error that says so; a reply that is not 200 is not an answer', async () => {
  const time = fakeTime();
  let settled = null;
  waitForHealth({ port: () => 1, running: () => true, timeoutMs: 5000, get: fakeGet(time, { up: 0, status: 503 }), now: time.now, later: time.later })
    .catch((e) => { settled = e; });
  await drain(time, () => settled);
  assert.match(settled.message, /took too long/);
  assert.equal(settled.exited, undefined);
});

test('the port is asked for each time (it changes when the engine is started again)', async () => {
  const time = fakeTime();
  let port = 4000;
  const get = fakeGet(time, { up: 1500 });
  let settled = null;
  waitForHealth({ port: () => port, running: () => true, timeoutMs: 60000, get, now: time.now, later: time.later }).then(() => { settled = true; });
  await drain(time, () => time.now() >= 800);
  port = 4001;
  await drain(time, () => settled);
  const ports = get.calls.map((c) => c.port);
  assert.ok(ports.includes(4000) && ports.includes(4001), JSON.stringify(ports));
  assert.ok(get.calls.every((c) => c.host === '127.0.0.1' && c.path === '/health'));
});

test('on a PC the wait is ten minutes and elsewhere ninety seconds, and what it says names the log the app keeps', () => {
  const main = appFile('main.js');
  assert.match(main, /function waitForBackend\(timeoutMs = plat\.WIN \? 600000 : 90000\)/);
  assert.match(main, /text\.replace\('%LOG%', APP_LOG_LABEL\)/);
  assert.ok(SLOW_WORDS.every(([after, text]) => after > 0 && text.length > 20));
  assert.ok(SLOW_WORDS.some(([, text]) => text.includes('%LOG%')));
});

test('the engine is started with no console window of its own, and the app traces what it does', () => {
  const main = appFile('main.js');
  assert.match(main, /stdio: \['ignore', 'pipe', 'pipe'\], windowsHide: true/);
  for (const what of ['single-instance lock', "uncaughtException", "trace.write('ready: opening the window')", 'window shown', 'the engine stopped', 'the engine answers', 'child-process-gone', 'did-fail-load']) {
    assert.ok(main.includes(what) || main.includes(what.replace('single-instance lock', 'another copy is already running')), what);
  }
  // an engine missing from an installed app is said, not left to a "spawn uv ENOENT"
  assert.match(main, /engine files are missing/);
  // the window is shown even if it never paints
  assert.match(main, /setTimeout\(\(\) => show\('not painted after 4 s: showing it anyway'\), 4000\)/);
});

test('every edition opens with the boot-up sound, once, and never when it starts hidden or reports a problem', () => {
  const played = [];
  const run = (search) => {
    const nodes = { message: { textContent: '', setAttribute() {} }, note: { textContent: '' }, detail: { textContent: '', hidden: true } };
    const document = { title: '', body: { classList: { add() {} } }, getElementById: (id) => nodes[id] };
    class Audio { constructor(src) { this.src = src; } play() { played.push(this.src); return Promise.resolve(); } }
    const window = {};
    const before = played.length;
    vm.runInNewContext(appFile('loading.js'), { URLSearchParams, location: { search }, document, window, Audio });
    assert.deepEqual(played.slice(before), [], 'nothing before the window is on screen');
    window.playBootSound(); // main.js, once the window shows
    window.playBootSound(); // once only
  };
  run('?app=daredevil');
  assert.deepEqual(played, ['daredevil-open.wav']);
  run('?app=daredevil&quiet=1');
  run('?app=daredevil&error=Oops');
  run('?app=jarvis&quiet=1');
  assert.equal(played.length, 1);
  run('?app=jarvis');
  run('?app=eden-code');
  assert.equal(played.length, 3);
  assert.ok(existsSync(new URL('../../app/daredevil-open.wav', import.meta.url)));
  const main = appFile('main.js');
  assert.match(main, /autoplayPolicy: 'no-user-gesture-required'/);
  // main.js plays it as the window shows, and only while boot_sound isn't off in prefs.json
  assert.match(main, /if \(!hidden\) \{ win\.show\(\); playBootSound\(\); \}/);
  assert.match(main, /\.boot_sound !== false/);
  assert.match(main, /hidden \|\| DEV_URL \? \{ quiet: '1' \}/);
  assert.match(appFile('scripts/release/windows.js'), /'\*\.wav'/);
});

test('the backend\'s token never reaches app.log, the problem screen or its URL (CH3)', () => {
  const { redact } = require('../../app/startup-log.js');
  const token = 'ab12'.repeat(12);
  const said = `JARVIS listening on http://127.0.0.1:51234/?token=${token}\nJARVIS_TOKEN=${token} in env\nTraceback: boom`;
  assert.doesNotMatch(redact(said), new RegExp(token));
  assert.match(redact(said), /\?token=…/);
  assert.match(redact(said), /Traceback: boom/);
  // the tail (what the problem screen and its ?detail= show) and the trace (app.log)
  const tail = createTail(200);
  tail.add('x'.repeat(150));
  tail.add(`\nJARVIS listening on http://127.0.0.1:5/?tok`);
  tail.add(`en=${token}\n`);
  assert.doesNotMatch(tail.last(), new RegExp(token));
  // cut off mid-line by the tail's own trimming: a bare token is hidden too
  const cut = createTail(60);
  cut.add(`${'y'.repeat(70)}\nlistening on http://127.0.0.1:5/?token=${token}\n`);
  cut.add('z'.repeat(40));
  assert.doesNotMatch(cut.last(), new RegExp(token.slice(-24)));
  const dir = temp();
  const trace = createTrace(path.join(dir, 'app.log'));
  trace.write(`the engine stopped; it last said:\n${said}`);
  trace.write(`page loaded: http://127.0.0.1:5/?token=${token}&app=code`);
  assert.doesNotMatch(readFileSync(path.join(dir, 'app.log'), 'utf8'), new RegExp(token));
});

test('after three stops the problem screen offers Try again, which asks main for a fresh start (CH7)', () => {
  const sent = [];
  const make = () => {
    const retry = { hidden: true, disabled: false, listeners: {}, addEventListener(ev, fn) { this.listeners[ev] = fn; } };
    const nodes = {
      message: { textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
      note: { textContent: '' }, detail: { textContent: '', hidden: true }, retry,
    };
    const document = { title: 'Eden', body: { classList: { add() {} } }, getElementById: (id) => nodes[id] };
    const window = { jarvisApp: { feature: { send: (ch) => sent.push(ch) } } };
    return { nodes, document, window };
  };
  const run = (search) => {
    const ctx = make();
    vm.runInNewContext(appFile('loading.js'), { URLSearchParams, location: { search }, document: ctx.document, window: ctx.window });
    return ctx.nodes.retry;
  };
  const shown = run(`?app=eden-code&error=${encodeURIComponent('The backend stopped (exit 2) three times in five minutes.')}&retry=1`);
  assert.equal(shown.hidden, false);
  shown.listeners.click();
  assert.deepEqual(sent, ['feature:app:retry']);
  assert.equal(shown.disabled, true);
  assert.equal(run('?app=eden-code&error=Oops').hidden, true); // only where main asks for it
  assert.equal(run('?app=eden-code').hidden, true);
  assert.match(appFile('loading.html'), /<button id="retry" type="button" hidden>Try again<\/button>/);
  const main = appFile('main.js');
  assert.match(main, /ipcMain\.on\('feature:app:retry'/);
  assert.match(main, /\{ retry: true \}\);/);
  // every restart takes a fresh port
  const restart = main.slice(main.indexOf('function restartBackend('), main.indexOf('function waitForBackend('));
  assert.match(restart, /port = await freePort\(\)/);
  assert.match(restart, /The folder it runs from is missing/);
});

test('two copies writing one app.log read apart: each line carries its pid (CH20)', () => {
  const dir = temp();
  const file = path.join(dir, 'app.log');
  let clock = Date.parse('2026-10-09T04:00:00.000Z');
  createTrace(file, { now: () => clock, pid: 4242 }).write('started');
  createTrace(file, { now: () => clock, pid: 4343 }).write('started too');
  assert.deepEqual(readFileSync(file, 'utf8').trim().split('\n'),
    ['2026-10-09T04:00:00.000Z +0.0s [4242] started', '2026-10-09T04:00:00.000Z +0.0s [4343] started too']);
  const main = appFile('main.js');
  assert.match(main, /createTrace\(path\.join\(LOG_DIR, 'app\.log'\), \{ pid: process\.pid \}\)/);
  assert.match(main, /found\.app === FLAVOR\.id \? `The other \$\{FLAVOR\.name\}`/);
});

// CH3-9: a notice of what happens next isn't a problem: it was red and an assertive alert. And the screen is said in
// Chinese when the owner chose it (main.js passes lang=zh), every line main.js shows there included.
test('a notice ("Starting it again…", the other app quit) is said politely, not as a red alert (CH3-9)', () => {
  const info = runLoading(`?app=eden-code&kind=info&error=${encodeURIComponent('The other Eden Code quit, so Eden Code is starting its own backend…')}`);
  assert.equal(info.nodes.message.textContent, 'The other Eden Code quit, so Eden Code is starting its own backend…');
  assert.equal(info.classes.has('error'), false);
  assert.deepEqual(info.nodes.message.attrs, {}); // (loading.html's role=status, aria-live=polite stay)
  const problem = runLoading(`?app=eden-code&error=${encodeURIComponent('The backend crashed (SIGSEGV) three times in five minutes. Details are in backend.log.')}`);
  assert.ok(problem.classes.has('error'));
  assert.equal(problem.nodes.message.attrs.role, 'alert');
  const main = appFile('main.js');
  assert.match(main, /`The backend \$\{how\}\. Starting it again…`, '', \{ info: true \}\);/);
  assert.match(main, /is starting its own backend…`, '', \{ info: true \}\);/);
  assert.match(main, /\.\.\.\(info \? \{ kind: 'info' \} : \{\}\), \.\.\.loadingQuery\(\)/);
});

test('the waiting and problem screen speaks Chinese when the owner chose it, every line main.js says there (CH3-9)', () => {
  const zh = (search) => runLoading(`${search}&lang=zh`);
  assert.equal(zh('?app=eden-code').nodes.message.textContent, '正在打开 Eden Code…');
  assert.equal(zh('?app=jarvis').nodes.message.textContent, '正在唤醒 Eden…');
  const lines = [
    'Eden Code was built from /Users/me/Old/JARVIS V1, which isn’t there any more (moved or renamed?). Build it again from where the folder is now: npm run install-eden-code.',
    "Eden Code's engine files are missing (C:\\Eden Code\\resources\\backend). Windows Security or another antivirus may have removed them. Install Eden Code again, and allow it in Windows Security if it asks.",
    "Eden Code's engine files are missing from the app (/Applications/Eden Code.app/Contents/Resources/backend). Download Eden Code again and replace the copy in Applications.",
    "Couldn't start the backend: spawn uv ENOENT",
    'Another Eden backend is still using your data (a `jarvis serve` in a terminal, or one that hasn’t finished quitting). Quit it, then open Eden again.',
    'Another Eden backend is still using your data. Waiting for it to finish…',
    'The backend was force-stopped (SIGKILL: macOS does that when memory runs short, and so does Force Quit) three times in five minutes. Details are in backend.log.',
    'The backend stopped (exit 1) three times in five minutes. The folder it runs from is missing: /Users/me/JARVIS V1. Details are in backend.log.',
    'The backend crashed (SIGSEGV). Starting it again…',
    'The backend was asked to stop (SIGTERM). Starting it again…',
    'The backend was stopped (SIGHUP). Starting it again…',
    "Eden Code couldn't start again: ETIMEDOUT. Details are in backend.log.",
    "Eden Code couldn't start: ETIMEDOUT. Details are in backend.log.",
    'The other Eden Code quit, so Eden Code is starting its own backend…',
    'Eden quit, so Eden Code is starting its own backend…',
  ];
  for (const line of lines) {
    const said = zh(`?app=eden-code&error=${encodeURIComponent(line)}`).nodes.message.textContent;
    assert.notEqual(said, line, line);
    assert.match(said, /[\u4e00-\u9fff]/, line);
    assert.doesNotMatch(said, /\b(?:the|is|was|again|quit|starting|missing|Details)\b/i, said); // no English left around the names
  }
  // names, paths and the engine's own words stay as they are
  assert.match(zh(`?error=${encodeURIComponent("Couldn't start the backend: spawn uv ENOENT")}`).nodes.message.textContent, /spawn uv ENOENT$/);
  // the notes while it waits
  const { nodes, window } = zh('?app=eden-code');
  for (const text of ['Still starting…', ...SLOW_WORDS.map(([, t]) => t.replace('%LOG%', 'app.log'))]) {
    window.sayWhileWaiting(text);
    assert.match(nodes.note.textContent, /[\u4e00-\u9fff]/, text);
  }
  // English stays English
  assert.equal(runLoading(`?app=eden-code&error=${encodeURIComponent('Eden quit, so Eden Code is starting its own backend…')}`).nodes.message.textContent, 'Eden quit, so Eden Code is starting its own backend…');
  // main.js tells every load of the page the owner's language
  const main = appFile('main.js');
  assert.match(main, /function loadingQuery\(\) \{[\s\S]*?\.language === 'zh' \? 'zh' : ''/);
  assert.equal((main.match(/loadingQuery\(\)/g) || []).length >= 4, true);
  assert.doesNotMatch(main, /query: \{ app: FLAVOR\.id/);
});

test('a Mac says nothing about Windows: the engine-missing screen and the slow-start notes (CH3-11)', () => {
  const main = appFile('main.js');
  assert.match(main, /showProblem\(plat\.WIN\n\s+\? `\$\{FLAVOR\.name\}'s engine files are missing \(\$\{path\.join\(process\.resourcesPath, 'backend'\)\}\)\. Windows Security/);
  assert.match(main, /: `\$\{FLAVOR\.name\}'s engine files are missing from the app \([^`]*\)\. Download \$\{FLAVOR\.name\} again and replace the copy in Applications\.`\);/);
  assert.match(main, /words: \(plat\.WIN \? SLOW_WORDS : \[\[20000, 'Still starting…'\], SLOW_WORDS\.at\(-1\)\]\)/);
  assert.doesNotMatch(SLOW_WORDS.at(-1)[1], /Windows/);
});
