// Eden Code on the phone (web/code-phone.html, .js, .css), in a real Chromium at an iPhone's
// size (390 × 844): pairing, the sessions with what waits on the owner, a handed-off session
// opening by itself, its live transcript (streamed words, then the step whose outcome came in
// after it was sent), a session's words shown as text (never markup), a Mac-only card with
// only its no, the mode menu without Bypass, a message and a no sent with the device token in
// its header (never in an address), and nothing wider than the screen. No backend: Node serves
// the page's files and a fake of the /api/code/phone/* calls (what code_phone.py answers) on
// 127.0.0.1, and nothing is shown.
//
//   app/node_modules/.bin/electron tests/web/code-phone.e2e.cjs      (about 10 s; exit 1 on a failure)
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const WEB = path.join(__dirname, '..', '..', 'src', 'jarvis', 'web');
const FILES = {
  '/code/': ['code-phone.html', 'text/html'],
  '/code/phone.js': ['code-phone.js', 'text/javascript'],
  '/code/phone.css': ['code-phone.css', 'text/css'],
  '/code/sw.js': ['code-phone-sw.js', 'text/javascript'],
};
const TOKEN = 'device-token-abc';

const USER_DATA = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'eden-code-phone-test-'));
app.setPath('userData', USER_DATA);
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');

// The fake Mac: one session (5), handed off; its transcript moves on each long poll.
const mac = { requests: [], posts: [], stage: 0 };
const HOSTILE = 'Look: <img src=x onerror="window.pwned=1"> done';

function sessionView() {
  const base = {
    id: 5, title: 'Login fix', project: 'alpha', status: 'working', doing: 'Running tests', mode: 'ask', mode_label: 'Manual',
    model: 'sonnet', model_label: 'Sonnet 5.5', todos: [{ text: 'Fix the bug', done: false }],
    copy: { branch: 'eden/login', into: 'main', busy: true }, more: false,
    cards: [{ id: 'c1', question: 'Run rm -rf build?', detail: '$ rm -rf ~/work', choices: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Not now' }], source: 'code', task_id: 5, mac_only: true }],
  };
  const s = mac.stage;
  if (s === 0) return { ...base, entries: [{ i: 1, role: 'user', text: HOSTILE }, { i: 2, role: 'tool', text: 'Bash make test' }], changed: [], live: '', next: 2, seen: 0, v: 'v0' };
  if (s === 1) return { ...base, entries: [], changed: [], live: 'Looking at the ', next: 2, seen: 0, v: 'v1' };
  if (s === 2) return { ...base, entries: [], changed: [{ i: 2, role: 'tool', text: 'Bash make test\n3 passed' }], live: 'Looking at the login code', next: 2, seen: 9, v: 'v2' };
  return { ...base, entries: [{ i: 3, role: 'assistant', text: 'Fixed it.' }], changed: [], live: '', next: 3, seen: 9, status: 'done', v: 'v3' };
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    mac.requests.push({ url: req.url, auth: req.headers.authorization || '' });
    const file = FILES[url.pathname];
    if (file) {
      res.writeHead(200, { 'content-type': file[1] });
      res.end(fs.readFileSync(path.join(WEB, file[0])));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const data = body ? JSON.parse(body) : {};
      if (url.pathname === '/api/pair') {
        if (data.code !== '123456') { json(res, 403, { error: 'That code is wrong.' }); return; }
        json(res, 200, { token: TOKEN });
        return;
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { json(res, 401, { error: 'Pair this device first.' }); return; }
      if (req.method === 'POST') mac.posts.push({ path: url.pathname, data });
      switch (url.pathname) {
        case '/api/code/phone/home':
          json(res, 200, {
            sessions: [{ id: 5, title: 'Login fix', project: 'alpha', status: 'working', mode: 'ask', mode_label: 'Manual', model: 'Sonnet 5.5' }],
            attention: [], pinned: { id: 5, title: 'Login fix', at: 1700 },
            exterminator: [{ id: 'r1', project: 'beta', state: 'running', round: 1, rounds: 3, step: 'sweep', found: 2, fixed: 0, spent: 0.5, spend_cap: 10, task_id: null }],
          });
          return;
        case '/api/code/phone/options':
          json(res, 200, {
            models: [{ ref: 'opus', name: 'Claude Opus 5.5', needs_key: false }, { ref: 'sonnet', name: 'Claude Sonnet 5.5', needs_key: false }, { ref: 'eden:kimi-k3', name: 'Kimi K3', needs_key: true }],
            modes: [{ id: 'ask', name: 'Manual' }, { id: 'edits', name: 'Accept edits' }], projects: [{ name: 'alpha', branch: 'main' }], defaults: { mode: 'ask' },
          });
          return;
        case '/api/code/phone/session': {
          const known = url.searchParams.get('v');
          if (known && mac.stage < 3) mac.stage += 1;
          setTimeout(() => json(res, 200, sessionView()), known && mac.stage >= 3 ? 400 : 60);
          return;
        }
        case '/api/code/phone/send': case '/api/code/phone/stop': case '/api/code/phone/answer':
          json(res, 200, { ok: true });
          return;
        default:
          json(res, 404, { error: 'no' });
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let win;
const js = (code) => win.webContents.executeJavaScript(code, true);
const until = async (code, what, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await js(code)) return;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`timed out waiting for ${what}`);
};
function assert(cond, message) { if (!cond) throw new Error(message); }

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('pairs, then opens the session the Mac handed off', async () => {
  await until(`!document.getElementById('pair').hidden`, 'the pairing view');
  await js(`document.getElementById('pair-code').value = '111111'; document.getElementById('pair-form').requestSubmit(); true`);
  await until(`document.getElementById('pair-error').textContent.includes('wrong')`, 'a wrong code said');
  await js(`document.getElementById('pair-code').value = '123456'; document.getElementById('pair-form').requestSubmit(); true`);
  await until(`location.hash === '#s=5' && !document.getElementById('session').hidden`, 'the handed-off session');
  await until(`document.getElementById('s-title').textContent === 'Login fix'`, 'its title');
});

test('the transcript streams, then the step whose outcome came later is replaced', async () => {
  await until(`[...document.querySelectorAll('#s-log li')].some((li) => li.textContent.includes('3 passed'))`, 'the changed step');
  await until(`[...document.querySelectorAll('#s-log li.entry')].some((li) => li.textContent.includes('Fixed it.')) && !document.querySelector('#s-log li.live')`, 'the reply replacing its live words');
  const steps = await js(`[...document.querySelectorAll('#s-log li.entry')].filter((li) => li.dataset.i === '2').length`);
  assert(steps === 1, `the changed step is shown ${steps} times`);
  assert(await js(`document.getElementById('s-log').getAttribute('role') === 'log'`), 'the transcript is a log');
});

test("a session's words are text, never markup", async () => {
  await until(`document.querySelector('#s-log li[data-i="1"]')`, 'the first entry');
  assert(await js(`document.querySelector('#s-log img') === null && !window.pwned`), 'an <img> from the session became markup');
  assert(await js(`document.querySelector('#s-log li[data-i="1"]').textContent.includes('<img src=x')`), 'the words are shown as they are');
});

test('a Mac-only card offers only its no; the mode menu never Bypass', async () => {
  await until(`document.querySelector('#s-cards .card')`, 'the card');
  const labels = await js(`[...document.querySelectorAll('#s-cards .card button')].map((b) => b.textContent)`);
  assert(JSON.stringify(labels) === JSON.stringify(['Not now']), `card buttons: ${labels}`);
  assert(await js(`document.querySelector('#s-cards .card').textContent.includes('Touch ID')`), 'it says to answer on the Mac');
  const modes = await js(`[...document.getElementById('s-mode').options].map((o) => o.value)`);
  assert(!modes.includes('auto') && modes.includes('edits'), `modes: ${modes}`);
  const keyless = await js(`[...document.getElementById('s-model').options].find((o) => o.value === 'eden:kimi-k3').disabled`);
  assert(keyless, 'a model needing a key can be picked');
});

test('a message and a no go with the token in a header, never in an address', async () => {
  await js(`document.getElementById('s-text').value = 'and the docs'; document.getElementById('s-form').requestSubmit(); true`);
  await until(`document.getElementById('s-text').value === ''`, 'the message sent');
  await js(`document.querySelector('#s-cards .card button').click(); true`);
  const end = Date.now() + 4000;
  while (!mac.posts.some((p) => p.path === '/api/code/phone/answer') && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  await until(`!document.querySelector('#s-cards .card')`, 'the card taken down once answered');
  const sent = mac.posts.find((p) => p.path === '/api/code/phone/send');
  assert(sent && sent.data.id === 5 && sent.data.text === 'and the docs', 'the message reached the Mac');
  const answered = mac.posts.find((p) => p.path === '/api/code/phone/answer');
  assert(answered && answered.data.choice === 'deny', 'the no reached the Mac');
  assert(!mac.requests.some((r) => r.url.includes(TOKEN)), 'the token was in an address');
  assert(mac.requests.filter((r) => r.url.startsWith('/api/code/')).every((r) => r.auth === `Bearer ${TOKEN}`), 'a call went without its token');
});

test('the sessions view lists sessions and Exterminator runs, within the screen', async () => {
  await js(`document.getElementById('back').click(); true`);
  await until(`!document.getElementById('home').hidden && document.querySelectorAll('#session-list li').length === 1`, 'the sessions');
  assert(await js(`document.getElementById('ext-list').textContent.includes('Round 1 of 3')`), 'the Exterminator run');
  const wide = await js(`document.documentElement.scrollWidth - window.innerWidth`);
  assert(wide <= 0, `the page is ${wide}px wider than the phone`);
  const unnamed = await js(`[...document.querySelectorAll('button:not([hidden])')].filter((b) => b.offsetParent && !b.textContent.trim() && !b.getAttribute('aria-label')).length`);
  assert(unnamed === 0, `${unnamed} buttons have no name`);
});

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({ show: false, width: 390, height: 844, webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true } });
  win.webContents.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error' && !/Failed to load resource/.test(e.message)) errors.push(e.message); });
  await win.loadURL(`${base}/code/`);
  let failed = 0;
  for (const t of tests) {
    errors.length = 0;
    try {
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
