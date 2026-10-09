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
    message: { textContent: 'Waking up Jarvis…', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
    note: { textContent: '' },
    detail: { textContent: '', hidden: true },
  };
  const classes = new Set();
  const document = { title: 'Jarvis', body: { classList: { add: (c) => classes.add(c) } }, getElementById: (id) => nodes[id] };
  const window = {};
  vm.runInNewContext(appFile('loading.js'), { URLSearchParams, location: { search }, document, window });
  return { nodes, classes, document, window };
}

test('the waiting window is J.A.R.V.I.S.\'s unless an app says otherwise', () => {
  const { nodes, classes, document } = runLoading('?app=jarvis');
  assert.equal(nodes.message.textContent, 'Waking up Jarvis…');
  assert.equal(document.title, 'Jarvis');
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

test('J.A.R.V.I.S. Daredevil opens with its sound, once, and never when it starts hidden or reports a problem', () => {
  const played = [];
  const run = (search) => {
    const nodes = { message: { textContent: '', setAttribute() {} }, note: { textContent: '' }, detail: { textContent: '', hidden: true } };
    const document = { title: '', body: { classList: { add() {} } }, getElementById: (id) => nodes[id] };
    class Audio { constructor(src) { this.src = src; } play() { played.push(this.src); return Promise.resolve(); } }
    vm.runInNewContext(appFile('loading.js'), { URLSearchParams, location: { search }, document, window: {}, Audio });
  };
  run('?app=daredevil');
  assert.deepEqual(played, ['daredevil-open.wav']);
  run('?app=daredevil&quiet=1');
  run('?app=daredevil&error=Oops');
  run('?app=jarvis');
  assert.equal(played.length, 1);
  assert.ok(existsSync(new URL('../../app/daredevil-open.wav', import.meta.url)));
  const main = appFile('main.js');
  assert.match(main, /autoplayPolicy: 'no-user-gesture-required'/);
  assert.match(main, /hidden \|\| DEV_URL \? \{ quiet: '1' \}/);
  assert.match(appFile('scripts/release/windows.js'), /'\*\.wav'/);
});
