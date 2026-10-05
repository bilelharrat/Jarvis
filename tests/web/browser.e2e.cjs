// The browser agent (app/browser-agent.js over the DevTools protocol, with app/page-preload.js
// in each tab) against a local test page, in a real Chromium: snapshots across frames and
// shadow DOM, acting by ref with real input, waits, stale refs, a covered button, a tab
// behind the one on show. No window is ever shown (a hidden one holds the tabs, which is
// also how a covered J.A.R.V.I.S. window looks to Chromium); nothing leaves 127.0.0.1.
//
//   app/node_modules/.bin/electron tests/web/browser.e2e.cjs      (about 20 s; exit 1 on a failure)
'use strict';

const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createAgent } = require('../../app/browser-agent');

app.setPath('userData', fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jarvis-browser-test-')));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGES = {
  '/shop.html': `<!doctype html><html><head><title>Test shop</title>
<style>.hidebox{position:absolute;opacity:0;width:0;height:0} .fake{display:inline-block;width:14px;height:14px;border:1px solid #333}
#cover{position:fixed;left:0;top:0;right:0;height:220px;background:#eee;z-index:9} body{padding-top:130px}</style></head><body>
<div id="cover" hidden>Cookies! <button id="ok">Accept all</button></div>
<header><nav><a href="/other.html">Other page</a></nav></header>
<main><h1>Checkout</h1>
<form id="f"><label for="em">Email address</label> <input id="em" name="email" required>
<fieldset><legend>Shipping</legend><label><input type="radio" name="ship" value="std" checked> Standard</label>
<label><input type="radio" name="ship" value="exp"> Express</label></fieldset>
<select id="qty" aria-label="Quantity"><option>1</option><option selected>2</option><option>3</option></select>
<input type="checkbox" id="gift" class="hidebox"><label for="gift"><span class="fake"></span> Gift wrap</label>
<button type="submit">Place order</button></form>
<button id="count" onclick="this.dataset.n=(+this.dataset.n||0)+1;this.textContent='Clicked '+this.dataset.n">Count me</button>
<button id="later" onclick="setTimeout(()=>{const p=document.createElement('p');p.id='done';p.textContent='Saved at last';document.querySelector('main').append(p)},500)">Save slowly</button>
<button id="top" onclick="document.getElementById('cover').hidden=false">Show banner</button>
<my-comp></my-comp>
<iframe id="same" src="/frame.html" title="Same frame" style="width:300px;height:80px"></iframe>
<iframe id="cross" src="http://localhost:PORT/frame2.html" title="Cross frame" style="width:300px;height:80px"></iframe>
<div style="height:1500px"></div><button id="far" onclick="this.textContent='Far clicked'">Far away</button>
</main>
<aside><h2>Summary</h2><p>Order total: $56.26</p></aside>
<script>customElements.define('my-comp', class extends HTMLElement { connectedCallback() {
  const r = this.attachShadow({ mode: 'closed' }); r.innerHTML = '<button>Shadow button</button>'; r.querySelector('button').onclick = () => { document.title = 'shadow clicked'; }; } });
document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); document.title = 'Submitted ' + new FormData(e.target).get('email'); });
addEventListener('click', (e) => { window.trusted = e.isTrusted; }, true);
</script></body></html>`,
  '/frame.html': '<!doctype html><body><button onclick="this.textContent=\'frame clicked\'">Frame button</button></body>',
  '/frame2.html': '<!doctype html><body><label>Card holder <input id="ch"></label><button onclick="this.textContent=\'cross clicked\'">Cross button</button></body>',
  '/logs.html': `<!doctype html><title>Logs</title><body><h1>Logs</h1><script>
console.error('boom at load'); fetch('/missing.json').catch(() => {}); setTimeout(() => { throw new Error('kaput'); }, 0);
</script></body>`,
  '/ask.html': `<!doctype html><title>Ask</title><body><main>
<button onclick="document.title = 'answer ' + confirm('Delete 3 files?')">Delete files</button>
<button onclick="alert('Hi there')">Say hi</button>
<button onclick="document.title = 'named ' + prompt('Your name?', 'Bob')">Name it</button>
<input type="file" id="f" style="display:none"><button onclick="document.getElementById('f').click()">Choose file</button>
</main></body>`,
  '/other.html': '<!doctype html><title>Other</title><body><h1>Another page</h1><a href="/shop.html">Back to shop</a></body>',
  // Bands of colour a picture's middle tells apart: which one shows says whether it scrolled.
  '/tall.html': `<!doctype html><title>Tall</title><style>html,body{margin:0}</style><body>${Array.from({ length: 40 },
    (_, i) => `<div style="height:100px;background:rgb(${(i * 40) % 256},${(i * 90) % 256},${(i * 150) % 256})"></div>`).join('')}</body>`,
  '/form.html': `<!doctype html><title>Form</title><body>
<div id="banner" style="position:fixed;bottom:0;left:0;right:0;background:#fee">We use cookies. <button>Accept</button></div>
<div role="dialog" aria-labelledby="dt" style="position:fixed;top:20px;left:20px;background:#fff"><h2 id="dt">Sign in</h2><p>Welcome back</p></div>
<div role="status">Saved your draft</div>
<main><h1>Details</h1>
<label for="em">Email address</label><input id="em" type="email" value="not-an-email" aria-invalid="true" aria-errormessage="emerr"><span id="emerr">Enter a valid email</span>
<span id="nm">Full name</span><input aria-labelledby="nm" value="Ada Lovelace">
<input type="password" id="pw" aria-label="Password" value="hunter2">
<fieldset><legend>Shipping</legend><label><input type="radio" name="s" checked> Express</label></fieldset>
<select aria-label="Country"><option>Chile</option><option selected>Peru</option></select>
<p>${'Lorem ipsum dolor sit amet. '.repeat(1800)}</p>
</main>
<aside><h2>Summary</h2><p>Order total: $56.26</p></aside></body>`,
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const page = PAGES[new URL(req.url, 'http://x').pathname];
      if (!page) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page.replace(/PORT/g, String(server.address().port)));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

let win;
let base;
const picks = []; // what the user 'picks' in the open panel, one list per upload
const upfile = path.join(app.getPath('temp'), `jarvis-upload-${process.pid}`, 'upload.txt');
let agent;
const tabs = [];
let shown = null;
const newTab = (partition = 'browser-test') => {
  const view = new WebContentsView({ webPreferences: { partition, preload: path.join(__dirname, '..', '..', 'app', 'page-preload.js'), sandbox: true, contextIsolation: true } });
  view.setBounds({ x: 0, y: 0, width: 1000, height: 700 });
  tabs.push(view);
  return view;
};
const page = (view, code) => view.webContents.executeJavaScript(code, true);
const run = (action, args = {}) => agent.run(action, args);
const refOf = (snap, re) => {
  const line = String(snap.text || '').split('\n').find((l) => re.test(l));
  if (!line) throw new Error(`no line matching ${re} in:\n${snap.text}`);
  return line.match(/\[(e\d+)\]/)[1];
};

// main.js's pageCall: a command to the tab's page-preload.js, its answer by IPC.
const answers = new Map();
ipcMain.on('page:result', (_event, message) => { const done = answers.get(message && message.id); if (done) { answers.delete(message.id); done(message.result); } });
ipcMain.on('page:dialog', (event, question) => agent.onPageDialog(event, question)); // as main.js does
const pageCall = (view, action, args = {}) => new Promise((resolve) => {
  const id = `c${Math.random()}`;
  answers.set(id, resolve);
  view.webContents.send('jarvis:command', { id, action, args });
  setTimeout(() => { if (answers.delete(id)) resolve({ timeout: true }); }, 5000);
});

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(cond, message) { if (!cond) throw new Error(message); }

async function fresh(view = shown) {
  await view.webContents.loadURL(`${base}/shop.html`);
  await sleep(150);
  return run('snapshot', { tab: view.webContents.id });
}

test('A snapshot lists the page across frames and shadow DOM, with refs and states', async () => {
  const snap = await fresh();
  assert(snap.ok && snap.first, JSON.stringify(snap).slice(0, 300));
  for (const re of [/\[e\d+\] textbox "Email address" \(required/, /\[e\d+\] radio "Standard" \(checked/, /\[e\d+\] combobox "Quantity" = "2"/,
    /\[e\d+\] checkbox "Gift wrap" \(unchecked/, /\[e\d+\] button "Shadow button"/, /iframe "Same frame"[^\n]*\n\s+\[e\d+\] button "Frame button"/,
    /iframe "Cross frame"[^\n]*\n(.*\n)*?\s+\[e\d+\] textbox "Card holder"/, /"Order total: \$56\.26"/]) {
    assert(re.test(snap.text), `missing ${re}:\n${snap.text}`);
  }
  assert(/button "Place order" \(in view\)/.test(snap.text) && /button "Far away"\n/.test(snap.text), 'in-view marks are wrong');
});

test('Clicks, typing, select and check land by ref, in every frame', async () => {
  const snap = await fresh();
  for (const [re, args] of [[/button "Count me"/, {}], [/button "Shadow button"/, {}], [/button "Frame button"/, {}], [/button "Cross button"/, {}], [/button "Far away"/, {}]]) {
    const r = await run('act', { kind: 'click', ref: refOf(snap, re), ...args });
    assert(r.ok, `${re}: ${r.message}`);
    assert(!/own click/.test(r.message), `real input didn't reach the hidden page: ${r.message}`);
  }
  assert((await page(shown, 'window.trusted')) === true, 'the click was not real input');
  let r = await run('act', { kind: 'type', ref: refOf(snap, /textbox "Email address"/), text: 'ada@example.com' });
  assert(r.ok, r.message);
  r = await run('act', { kind: 'type', ref: refOf(snap, /textbox "Card holder"/), text: 'Ada Lovelace' });
  assert(r.ok, r.message);
  r = await run('act', { kind: 'select', ref: refOf(snap, /combobox "Quantity"/), values: ['3'] });
  assert(r.ok, r.message);
  r = await run('act', { kind: 'check', ref: refOf(snap, /checkbox "Gift wrap"/) });
  assert(r.ok, r.message);
  const state = await page(shown, `({ count: document.getElementById('count').textContent, title: document.title, email: document.getElementById('em').value,
    qty: document.getElementById('qty').value, gift: document.getElementById('gift').checked, far: document.getElementById('far').textContent,
    frame: document.getElementById('same').contentDocument.body.innerText })`);
  assert(state.count === 'Clicked 1' && state.title === 'shadow clicked' && state.email === 'ada@example.com' && state.qty === '3'
    && state.gift && state.far === 'Far clicked' && state.frame === 'frame clicked', JSON.stringify(state));
  const again = await run('snapshot', { tab: shown.webContents.id, interactive: true });
  assert(/^~\s+\[e\d+\] button "Clicked 1"|^\+\s+\[e\d+\] button "Clicked 1"/m.test(again.text) || /"Clicked 1"/.test(again.text), again.text);
  assert(/^~\s+\[e\d+\] textbox "Email address" = "ada@example.com"/m.test(again.text), `no change mark:\n${again.text}`);
});

test('A press that submits waits for the user; forced, it goes', async () => {
  const snap = await fresh();
  await run('act', { kind: 'type', ref: refOf(snap, /textbox "Email address"/), text: 'cy@example.com' });
  const ref = refOf(snap, /button "Place order"/);
  const r = await run('act', { kind: 'click', ref });
  assert(!r.ok && r.needsConfirm && r.label === 'Place order', JSON.stringify(r));
  assert(!/Submitted/.test(await page(shown, 'document.title')), 'it submitted without an OK');
  const forced = await run('act', { kind: 'click', ref, force: true });
  assert(forced.ok, forced.message);
  assert((await page(shown, 'document.title')) === 'Submitted cy@example.com', 'forced press did not submit');
});

test('Enter types and submits; unknown keys are refused', async () => {
  const snap = await fresh();
  await run('act', { kind: 'type', ref: refOf(snap, /textbox "Email address"/), text: 'bob@example.com' });
  const bad = await run('act', { kind: 'press', key: 'Hyper+Q' });
  assert(!bad.ok && /isn't a key/.test(bad.message), bad.message);
  await page(shown, "window.__log = []; for (const t of ['keydown','keypress','submit','focusin','focusout']) addEventListener(t, (e) => __log.push(t + ':' + (e.key || (e.target && e.target.id) || '')), true); true");
  const r = await run('act', { kind: 'press', key: 'Enter', force: true });
  assert(r.ok, r.message);
  const title = await page(shown, 'document.title');
  assert(title === 'Submitted bob@example.com', `${title} ${r.message} ${JSON.stringify(await page(shown, '({ log: window.__log, active: document.activeElement && document.activeElement.id, focus: document.hasFocus() })'))}`);
});

test('Something over an element is named, not clicked through', async () => {
  const snap = await fresh();
  await page(shown, 'document.getElementById("cover").hidden = false; scrollTo(0, 0); true');
  const r = await run('act', { kind: 'click', ref: refOf(snap, /link "Other page"/) });
  assert(!r.ok && /covered by <div#cover>/.test(r.message), r.message);
});

test('Waiting for text, and refs going stale on a new page', async () => {
  const snap = await fresh();
  const later = await run('act', { kind: 'click', ref: refOf(snap, /button "Save slowly"/) });
  assert(later.ok, later.message);
  const waited = await run('wait', { text: 'Saved at last', ms: 5000 });
  assert(waited.ok, waited.message);
  const nope = await run('wait', { text: 'never appears', ms: 400 });
  assert(!nope.ok && /Still not/.test(nope.message), nope.message);
  const count = refOf(snap, /button "Count me"/);
  const nav = await run('act', { kind: 'click', ref: refOf(snap, /link "Other page"/) });
  assert(nav.ok && nav.navigated, JSON.stringify(nav));
  const stale = await run('act', { kind: 'click', ref: count });
  assert(!stale.ok && /earlier snapshot/.test(stale.message), stale.message);
  const url = await run('wait', { url: '**/other.html', ms: 2000 });
  assert(url.ok, url.message);
});

test('Waiting for an element reads the page’s words only when they’re waited on', async () => {
  const snap = await fresh();
  // What the waits ask the page, as the agent sends it.
  const tab = agent.state.get(shown.webContents.id);
  const asked = [];
  const send = tab.cdp.send.bind(tab.cdp);
  tab.cdp.send = (method, params, opts) => {
    if (method === 'Runtime.evaluate') asked.push(String(params.expression || ''));
    return send(method, params, opts);
  };
  try {
    const later = await run('act', { kind: 'click', ref: refOf(snap, /button "Save slowly"/) });
    assert(later.ok, later.message);
    const shows = await run('wait', { selector: '#done', ms: 5000 });
    assert(shows.ok && /#done showing/.test(shows.message), shows.message);
    const checks = asked.filter((e) => e.includes('querySelector("#done")'));
    assert(checks.length && checks.every((e) => !e.includes('innerText')), 'a wait for an element read the whole page’s text');
    const nope = await run('wait', { selector: '#nowhere', ms: 400 });
    assert(!nope.ok && /Still not #nowhere showing/.test(nope.message), nope.message);
    const bad = await run('wait', { selector: 'p[', ms: 400 });
    assert(!bad.ok && /isn't a valid CSS selector/.test(bad.message), bad.message);
    asked.length = 0;
    const both = await run('wait', { selector: '#done', text: 'saved at LAST', ms: 2000 });
    assert(both.ok, both.message);
    const gone = await run('wait', { gone: 'Count me', ms: 400 });
    assert(!gone.ok && /Still not “Count me” gone/.test(gone.message), gone.message);
    assert(asked.some((e) => e.includes('innerText') && e.includes('querySelector("#done")')), 'a wait for words didn’t read them');
  } finally {
    delete tab.cdp.send; // its own again
  }
});

test('A tab behind the one on show takes snapshots and clicks, and refs stay with their tab', async () => {
  const onShow = await fresh();
  const behind = newTab();
  await behind.webContents.loadURL(`${base}/shop.html`);
  const snap = await run('snapshot', { tab: behind.webContents.id, interactive: true });
  assert(snap.ok && snap.shown === false, JSON.stringify(snap).slice(0, 200));
  const r = await run('act', { tab: behind.webContents.id, kind: 'click', ref: refOf(snap, /button "Count me"/) });
  assert(r.ok, r.message);
  assert((await page(behind, 'document.getElementById("count").textContent')) === 'Clicked 1', 'the click did not land behind');
  const wrong = await run('act', { tab: behind.webContents.id, kind: 'click', ref: refOf(onShow, /button "Count me"/) });
  assert(!wrong.ok && /belongs to tab/.test(wrong.message), wrong.message);
  const closed = await run('snapshot', { tab: 99999 });
  assert(!closed.ok && /closed/.test(closed.message), closed.message);
});

test('The fuller read has dialogs, alerts, banners and sidebars, real labels, values and errors, and reads on', async () => {
  await shown.webContents.loadURL(`${base}/form.html`);
  await sleep(150);
  const plain = await pageCall(shown, 'read', {});
  assert(!/Order total/.test(plain.text) && plain.text.length <= 14000, 'the plain read changed');
  const r = await pageCall(shown, 'read', { rich: true });
  assert(r.text.startsWith('[Dialog: Sign in]\nSign in Welcome back'), r.text.slice(0, 200));
  for (const want of ['[Alert]\nSaved your draft', '[Sidebar: Summary]\nSummary Order total: $56.26', '[Banner]\nWe use cookies. Accept', '[Main content]\nDetails']) {
    assert(r.text.includes(want), `missing ${JSON.stringify(want)} in ${r.text.slice(0, 400)}`);
  }
  assert(r.total > 40000 && r.more && r.text.length === 20000 && r.offset === 0, JSON.stringify({ total: r.total, more: r.more, len: r.text.length }));
  const next = await pageCall(shown, 'read', { rich: true, offset: 19950, limit: 1000 });
  assert(next.offset === 19950 && next.text.slice(0, 50) === r.text.slice(19950) && next.text.length === 1000, 'reading on from an offset');
  const byLabel = Object.fromEntries(r.fields.map((f) => [f.label, f]));
  assert(byLabel['Email address'] && byLabel['Email address'].value === 'not-an-email' && byLabel['Email address'].error === 'Enter a valid email', JSON.stringify(r.fields));
  assert(byLabel['Full name'] && byLabel['Full name'].value === 'Ada Lovelace', JSON.stringify(r.fields));
  assert(byLabel.Password && byLabel.Password.value === '(hidden)', 'a password showed');
  assert(byLabel['Shipping: Express'] && byLabel['Shipping: Express'].checked === true, JSON.stringify(r.fields));
  assert(byLabel.Country && byLabel.Country.value === 'Peru' && byLabel.Country.options.join() === 'Chile,Peru', JSON.stringify(r.fields));
  assert(JSON.stringify(r.regions.map((x) => x.kind)) === JSON.stringify(['Dialog', 'Alert', 'Sidebar', 'Banner']), JSON.stringify(r.regions));
});

test('Screenshots: plain, with marks on the refs in view (then gone), and the whole page', async () => {
  const snap = await fresh();
  const plain = await run('screenshot', {});
  assert(plain.ok && plain.pngs.length === 1 && plain.pngs[0].length > 1000, JSON.stringify(plain).slice(0, 200));
  const marked = await run('screenshot', { marks: true });
  assert(marked.ok && marked.legend.length > 5, JSON.stringify(marked.legend));
  const count = refOf(snap, /button "Count me"/);
  assert(marked.legend.some((m) => m.ref === count && m.name === 'Count me'), `no mark for ${count}: ${JSON.stringify(marked.legend)}`);
  assert(marked.pngs[0] !== plain.pngs[0], 'the marks are not in the picture');
  assert((await page(shown, 'document.querySelector("jarvis-marks") === null')) === true, 'the marks stayed on the page');
  const act = await run('act', { kind: 'click', ref: count }); // a mark's ref works
  assert(act.ok, act.message);
  await shown.webContents.loadURL(`${base}/form.html`);
  const full = await run('screenshot', { fullPage: true });
  assert(full.ok && full.fullPage && full.pngs.length >= 2 && !full.cut, JSON.stringify({ n: full.pngs.length, cut: full.cut }));
});

test('A session tab keeps its console and requests from the start; eval runs only on this Mac', async () => {
  const r = await run('open', { url: `${base}/logs.html`, newTab: true, background: true, owner: 'code:1' });
  assert(r.ok, JSON.stringify(r));
  await run('wait', { tab: r.tab, idle: true, ms: 3000 });
  const log = await run('console', { tab: r.tab });
  assert(log.entries.some((m) => m.level === 'error' && /boom at load/.test(m.text)), JSON.stringify(log.entries));
  assert(log.entries.some((m) => m.level === 'error' && /Uncaught.*kaput/.test(m.text)), JSON.stringify(log.entries));
  const errors = await run('console', { tab: r.tab, level: 'error' });
  assert(errors.entries.every((m) => m.level === 'error'), JSON.stringify(errors.entries));
  const net = await run('network', { tab: r.tab, failed: true });
  assert(net.entries.some((q) => q.status === 404 && /missing\.json/.test(q.url)), JSON.stringify(net.entries));
  const value = await run('eval', { tab: r.tab, expression: 'await Promise.resolve(document.title + " " + (6 * 7))' });
  assert(value.ok && value.value === '"Logs 42"', JSON.stringify(value));
  const obj = await run('eval', { tab: r.tab, expression: '({ a: 1, list: [1, 2] })' });
  assert(obj.ok && JSON.parse(obj.value).list.length === 2, JSON.stringify(obj));
  const thrown = await run('eval', { tab: r.tab, expression: 'nope.nothing' });
  assert(!thrown.ok && /ReferenceError/.test(thrown.message), JSON.stringify(thrown));
  await run('open', { url: 'data:text/html,<title>Elsewhere</title>', tab: r.tab, background: true });
  const refused = await run('eval', { tab: r.tab, expression: 'document.title' });
  assert(!refused.ok && /only runs on pages on this Mac/.test(refused.message), JSON.stringify(refused));
  await run('tabs', { op: 'close', id: r.tab });
});

test('A page question during an act waits for browser_dialog; alerts are reported; uploads take only the user\'s pick', async () => {
  await shown.webContents.loadURL(`${base}/ask.html`);
  await sleep(150);
  const snap = await run('snapshot', {});
  const del = await run('act', { kind: 'click', ref: refOf(snap, /button "Delete files"/), force: true }); // the user OK'd the press
  assert(del.ok && /asks \(confirm\): “Delete 3 files\?”/.test(del.message), del.message);
  const blocked = await run('snapshot', {});
  assert(!blocked.ok && /waiting for an answer/.test(blocked.message), blocked.message);
  const status = await run('dialog', { op: 'status' });
  assert(status.dialog && status.dialog.type === 'confirm' && status.dialog.message === 'Delete 3 files?', JSON.stringify(status));
  const answered = await run('dialog', { accept: true });
  assert(answered.ok, answered.message);
  await sleep(100);
  assert((await page(shown, 'document.title')) === 'answer true', await page(shown, 'document.title'));
  const alert = await run('act', { kind: 'click', ref: refOf(snap, /button "Say hi"/) });
  assert(alert.ok && /showed an alert: “Hi there” \(closed\)/.test(alert.message), alert.message);
  const named = await run('act', { kind: 'click', ref: refOf(snap, /button "Name it"/) });
  assert(/asks \(prompt\)/.test(named.message), named.message);
  await run('dialog', { accept: true, text: 'Ada' });
  await sleep(100);
  assert((await page(shown, 'document.title')) === 'named Ada', await page(shown, 'document.title'));
  picks.push([upfile]);
  const up = await run('upload', { ref: refOf(snap, /button "Choose file"/) });
  assert(up.ok && /upload\.txt/.test(up.message), up.message);
  await sleep(100);
  assert((await page(shown, 'document.getElementById("f").files[0].name')) === 'upload.txt', 'the file box is empty');
  picks.push([]);
  const none = await run('upload', { ref: refOf(snap, /button "Choose file"/) });
  assert(!none.ok && /didn't pick/.test(none.message), none.message);
});

test('Opening in a new tab keeps the page on show; tabs list, switch and close', async () => {
  await fresh();
  const before = tabs.length;
  const r = await run('open', { url: `${base}/other.html`, newTab: true, background: true, owner: 'jarvis' });
  assert(r.ok && r.opened === 'new' && r.shown === false && tabs.length === before + 1, JSON.stringify(r));
  assert(/shop\.html$/.test(shown.webContents.getURL()), 'the page on show changed');
  const list = await run('tabs', { op: 'list' });
  const mine = list.tabs.find((t) => t.id === r.tab);
  assert(mine && mine.owner === 'jarvis' && !mine.shown && /other\.html$/.test(mine.url), JSON.stringify(list.tabs));
  const snap = await run('snapshot', { tab: r.tab, interactive: true });
  assert(snap.ok && /link "Back to shop"/.test(snap.text), snap.text);
  const same = await run('open', { url: `${base}/shop.html`, tab: r.tab, background: true });
  assert(same.ok && same.tab === r.tab && same.opened === 'same', JSON.stringify(same));
  const sw = await run('tabs', { op: 'switch', id: r.tab });
  assert(sw.ok && shown.webContents.id === r.tab, JSON.stringify(sw));
  const closed = await run('tabs', { op: 'close', id: r.tab });
  assert(closed.ok && !tabs.some((v) => v.webContents.id === r.tab), JSON.stringify(closed));
  const gone = await run('snapshot', { tab: r.tab });
  assert(!gone.ok && /closed/.test(gone.message), gone.message);
  while (tabs.length > 1) await run('tabs', { op: 'close', id: tabs[tabs.length - 1].webContents.id });
  const last = await run('tabs', { op: 'close', id: tabs[0].webContents.id });
  assert(!last.ok && /only tab/.test(last.message), JSON.stringify(last));
});

test('A page behind the one on show opens its new tab in its own profile (a signed-out tab stays signed out)', async () => {
  const opener = newTab('browser-test-signed-out');
  const before = tabs.length;
  try {
    agent.popup(opener, `${base}/other.html`, { partition: 'browser-test-signed-out' });
    const child = tabs[before];
    assert(tabs.length === before + 1 && child !== shown, 'no new tab behind');
    assert(child.webContents.session === opener.webContents.session, 'the new tab is in another profile than its opener');
    child.webContents.close();
    tabs.splice(tabs.indexOf(child), 1);
  } finally {
    tabs.splice(tabs.indexOf(opener), 1);
    opener.webContents.close();
  }
});

// page-preload.js in a page that draws (an offscreen window: its frames come as pictures).
// The wheel and touch blockers are in place from the page's start, so a lock that comes
// while the page is busy still stops a scroll made before the page caught up; a page main.js
// says can't be locked (told as it navigates, as main.js does) scrolls without waiting for
// its busy scripts, and one told it may be locked again is blocked again.
test('A page that may be locked is blocked from the lock on, even mid-stall; another scrolls at once', async () => {
  const paper = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { offscreen: true, partition: 'browser-test',
    preload: path.join(__dirname, '..', '..', 'app', 'page-preload.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const wc = paper.webContents;
  let lockable = null; // what main.js would tell this page as it navigates (null: nothing)
  wc.on('did-navigate', () => { if (lockable !== null) wc.send('jarvis:lockable', lockable); });
  try {
    wc.setFrameRate(60);
    let frames = [];
    wc.on('paint', (_e, _dirty, image) => {
      const { width, height } = image.getSize();
      const px = image.toBitmap();
      const i = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
      frames.push({ at: Date.now(), colour: `${px[i + 2]},${px[i + 1]},${px[i]}` });
    });
    const wheel = () => { for (let k = 0; k < 3; k++) wc.sendInputEvent({ type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: -120, canScroll: true }); };
    const stall = (ms) => page(paper, `setTimeout(() => { const end = Date.now() + ${ms}; while (Date.now() < end) {} window.busyEnd = Date.now(); }, 0); true`);
    const scrolled = () => page(paper, 'scrollY');

    // A page told nothing: the lock comes 100 ms into a stall, the wheel 200 ms after it.
    await paper.loadURL(`${base}/tall.html`);
    await sleep(400);
    await stall(1500);
    await sleep(100);
    wc.send('jarvis:locked', true);
    await sleep(200);
    wheel();
    await sleep(1800);
    assert((await scrolled()) === 0, `a page locked mid-stall scrolled to ${await scrolled()}`);
    // The lock and the wheel in the same moment, on a page at rest.
    wc.send('jarvis:locked', false);
    await sleep(200);
    wc.send('jarvis:locked', true);
    wheel();
    await sleep(600);
    assert((await scrolled()) === 0, `a page locked as the wheel came scrolled to ${await scrolled()}`);
    wc.send('jarvis:locked', false);
    await sleep(300);
    wheel();
    await sleep(600);
    assert((await scrolled()) > 0, 'the page didn’t scroll once unlocked');

    // A page main.js says can't be locked: its scroll doesn't wait for its busy scripts.
    lockable = false;
    await paper.loadURL(`${base}/tall.html?free`); // (another address: a reload would keep the scroll)
    await sleep(500);
    const top = frames.length ? frames[frames.length - 1].colour : '';
    assert(top, 'the page drew nothing');
    await stall(2500);
    await sleep(200);
    frames = [];
    wheel();
    const busyEnd = await page(paper, 'new Promise((r) => setTimeout(() => r(window.busyEnd), 300))');
    const moved = frames.find((f) => f.colour !== top);
    assert(moved, 'the page never scrolled');
    assert(moved.at < busyEnd, `the scroll waited ${moved.at - busyEnd + 2300} ms for the page's scripts`);

    // Told it may be locked after all: blocked again, mid-stall too.
    wc.send('jarvis:lockable', true);
    await page(paper, 'scrollTo(0, 0); true');
    await sleep(300);
    await stall(1500);
    await sleep(100);
    wc.send('jarvis:locked', true);
    await sleep(200);
    wheel();
    await sleep(1800);
    assert((await scrolled()) === 0, `a page told it may be locked scrolled to ${await scrolled()} under the lock`);
    // A locked page keeps its blockers whatever it's told until it's unlocked.
    wc.send('jarvis:lockable', false);
    await sleep(300);
    wheel();
    await sleep(600);
    assert((await scrolled()) === 0, `a locked page scrolled to ${await scrolled()}`);
  } finally {
    paper.destroy();
  }
});

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const server = await serve();
  base = `http://127.0.0.1:${server.address().port}`;
  fs.mkdirSync(path.dirname(upfile), { recursive: true });
  fs.writeFileSync(upfile, 'hello');
  win = new BrowserWindow({ show: false, width: 1000, height: 700 });
  shown = newTab();
  win.contentView.addChildView(shown);
  const select = (view) => {
    if (view === shown) return;
    win.contentView.removeChildView(shown);
    shown = view;
    win.contentView.addChildView(view);
  };
  agent = createAgent({
    tabs: () => tabs, ensureBrowser: () => shown, isShown: (v) => v === shown, setSynthetic: () => {}, research: () => false,
    addTab: ({ select: show, owner, profile }) => { const v = newTab(profile && profile.partition); v.agentOwner = owner || ''; if (show) select(v); return v; },
    blankTab: () => null,
    select,
    close: (view) => {
      if (tabs.length < 2) return false;
      tabs.splice(tabs.indexOf(view), 1);
      if (view === shown) select(tabs[0]);
      view.webContents.close();
      return true;
    },
    showBrowser: () => {}, markAsked: () => {}, toUrl: (u) => u,
    pageCall: (view, action, args) => pageCall(view, action, args),
    pickFiles: async () => picks.shift() || [],
    askUser: async () => false,
  });
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok     ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`FAILED ${t.name}\n       ${String(err.message).split('\n').join('\n       ')}`);
    }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  server.close();
  app.exit(failed ? 1 : 0);
});
