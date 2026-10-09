// Screen-reader mode (src/jarvis/web/features/accessibility.js) in a real Chromium, with no
// backend: Node serves the window's files on 127.0.0.1, the hub's events go to heard(), and keys
// are real input events (CDP). What a screen reader would be given is read from Chromium's own
// accessibility tree. No window is shown, nothing leaves 127.0.0.1, no shortcut is taken.
//
//   app/node_modules/.bin/electron tests/web/accessibility.e2e.cjs      (about 10 s; exit 1 on a failure)
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const WEB = process.env.JARVIS_WEB_DIR || path.join(__dirname, '..', '..', 'src', 'jarvis', 'web');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const USER_DATA = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jarvis-a11y-test-'));
app.setPath('userData', USER_DATA);
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');

function serve() {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
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
let mac = false;
const js = (code) => win.webContents.executeJavaScript(code, true);
const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A key with modifiers: alt 1, ctrl 2, meta 4, shift 8.
async function press(key, code, vk, modifiers = 0) {
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
}
// The screen-reader keys: Alt+Shift on Windows, Command+Shift on a Mac.
const chord = (letter) => press(letter, `Key${letter}`, letter.charCodeAt(0), mac ? 4 | 8 : 1 | 8);

const script = (name) => js(`new Promise((resolve, reject) => {
  const s = document.createElement('script');
  s.src = '/static/features/${name}';
  s.onload = () => resolve(true);
  s.onerror = () => reject(new Error('no ${name}'));
  document.body.append(s);
})`);
const style = (name) => js(`new Promise((resolve) => {
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = '/static/features/${name}';
  l.onload = l.onerror = () => resolve(true);
  document.head.append(l);
})`);

// A fresh window: the hub's hello, send() recorded, the feature loaded, screen-reader mode set.
async function fresh(features = { a11y_mode: 'on', a11y_voice: 'reader' }, { edition = false } = {}) {
  await win.loadURL(`${base}/?token=test`);
  win.webContents.focus();
  // (the app named J.A.R.V.I.S. Daredevil opens the page with ?edition=daredevil, which the server writes on <body>)
  if (edition) await js(`document.body.dataset.edition = 'daredevil'; true`);
  mac = /Mac/.test(await js('navigator.platform'));
  await js(`
    window.__sent = [];
    send = (m) => __sent.push(m);
    heard({ type: 'hello', hub_id: 'hub-a', state: 'idle', muted: true, status: {}, activity: [], tasks: [],
      prefs: { look: 'orb', language: 'en', models: [], personas: [], humor: 50 }, brain: {}, approvals: [], history: [] });
    true;`);
  await style('accessibility.css');
  await style('zz-contrast.css');
  await script('accessibility.js');
  await js(`heard({ type: 'prefs', features: ${JSON.stringify(features)} }); true`);
  await sleep(60);
  // What it said on its own as it started (the tests that follow count only what they cause).
  await js(`window.__welcome = [...document.getElementById('sr-polite').children].map((p) => p.textContent); document.getElementById('sr-polite').replaceChildren(); true`);
}
const said = (region = 'sr-polite') => js(`[...document.getElementById('${region}').children].map((p) => p.textContent)`);
const sent = () => js('__sent.map((m) => m.type === "approve" ? "approve " + m.id + " " + m.choice : m.type === "feature_prefs" ? "prefs " + JSON.stringify(m.changes) : m.type)');
const reply = (rid, text) => js(`heard({ type: 'reply', rid: ${JSON.stringify(rid)}, text: ${JSON.stringify(text)} }); true`);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(cond, message) { if (!cond) throw new Error(message); }

// The page as Chromium gives it to assistive technology: [{ role, name }] in reading order.
async function axTree() {
  await cdp('Accessibility.enable');
  const { nodes } = await cdp('Accessibility.getFullAXTree');
  return nodes.filter((n) => !n.ignored).map((n) => ({ role: n.role && n.role.value, name: n.name && n.name.value, focused: (n.properties || []).some((p) => p.name === 'focused' && p.value.value) }));
}

test('the page is arranged for a screen reader: panels out of the way, a skip link, no streaming live regions', async () => {
  const r = await js(`({
    sr: document.documentElement.dataset.sr,
    panelsHidden: ['p-system', 'p-weather', 'p-markets', 'p-uptime'].every((id) => document.getElementById(id).getAttribute('aria-hidden') === 'true' && document.getElementById(id).tabIndex === -1),
    captionLive: document.querySelector('.caption').getAttribute('aria-live'),
    cardsLive: document.getElementById('cards').getAttribute('aria-live'),
    skip: document.body.firstElementChild.textContent,
    skipHidden: document.body.firstElementChild.hidden,
    settingsRole: document.getElementById('settings').getAttribute('role'),
  })`);
  assert(r.sr === '1', `data-sr ${r.sr}`);
  assert(r.panelsHidden, 'the stats, weather and markets panels are still in the reading order');
  assert(r.captionLive === 'off' && r.cardsLive === 'off', `live regions ${r.captionLive}/${r.cardsLive}`);
  assert(r.skip === 'Skip to the request box' && !r.skipHidden, `skip link: ${r.skip}`);
  assert(r.settingsRole === 'dialog', `Settings role ${r.settingsRole}`);
});

test('Chromium’s accessibility tree has the orb and the request box, and none of the decorative panels', async () => {
  const tree = await axTree();
  const names = tree.map((n) => `${n.role}:${n.name}`);
  assert(names.some((n) => /^button:Talk to Jarvis$/.test(n)), `no orb in ${names.slice(0, 40)}`);
  assert(tree.some((n) => n.role === 'textbox' && /Type a request/.test(n.name || '')), 'no request box');
  assert(tree.some((n) => n.role === 'link' && /Skip to the request box/.test(n.name || '')), 'no skip link');
  assert(!tree.some((n) => /System stats|Markets|Weather/.test(n.name || '')), `a decorative panel is still read: ${names.filter((n) => /System stats|Markets|Weather/.test(n))}`);
  assert(tree.some((n) => n.role === 'status') && tree.some((n) => n.role === 'alert'), 'the two announcers are missing');
});

test('with it off, nothing of that changes', async () => {
  await fresh({ a11y_mode: 'off' });
  const r = await js(`({ sr: document.documentElement.dataset.sr, hidden: document.getElementById('p-markets').hasAttribute('aria-hidden'), tab: document.getElementById('p-markets').tabIndex, live: document.querySelector('.caption').getAttribute('aria-live') })`);
  assert(r.sr === '0' && !r.hidden && r.tab === 0 && r.live === 'polite', JSON.stringify(r));
});

test('Space no longer opens the microphone', async () => {
  await js('document.activeElement.blur(); __sent.length = 0');
  await press(' ', 'Space', 32);
  const s = await sent();
  assert(!s.includes('listen') && !s.includes('stop'), `Space switched the microphone: ${s}`);
});

test('a reply is read once, whole, in plain words, and not while it is still being written', async () => {
  await js(`heard({ type: 'turn', rid: 'r1', user: 'what is on today' }); true`);
  await reply('r1', '## Today');
  await reply('r1', '## Today\n\n- **Meeting** at 3');
  await reply('r1', '## Today\n\n- **Meeting** at 3\n- Call [Ann](https://example.com/ann)');
  await sleep(100);
  assert((await said()).length === 0, `read while streaming: ${await said()}`);
  await js(`heard({ type: 'turn_done', rid: 'r1' }); true`);
  const lines = await said();
  assert(lines.length === 1 && lines[0] === 'Today. Meeting at 3. Call Ann.', `announced ${JSON.stringify(lines)}`);
  await js(`heard({ type: 'turn_done', rid: 'r1' }); true`);
  assert((await said()).length === 1, 'announced twice');
});

test('a reply that never gets a turn_done is read when it has stopped changing', async () => {
  await reply('', 'Welcome back.');
  await sleep(1800);
  const lines = await said();
  assert(lines.length === 1 && lines[0] === 'Welcome back.', `announced ${JSON.stringify(lines)}`);
});

test('R reads the last reply again', async () => {
  await js(`heard({ type: 'turn', rid: 'r2', user: 'hi' }); heard({ type: 'reply', rid: 'r2', text: 'Hello there.' }); heard({ type: 'turn_done', rid: 'r2' }); true`);
  await chord('R');
  const lines = await said();
  assert(lines.length === 2 && lines[1] === 'Hello there.', `announced ${JSON.stringify(lines)}`);
});

test('with Jarvis’s own voice picked, the screen reader is told nothing of the reply', async () => {
  await fresh({ a11y_mode: 'on', a11y_voice: 'jarvis' });
  await js(`heard({ type: 'turn', rid: 'r3', user: 'hi' }); heard({ type: 'reply', rid: 'r3', text: 'Hello there.' }); heard({ type: 'turn_done', rid: 'r3' }); true`);
  assert((await said()).length === 0, `announced ${JSON.stringify(await said())}`);
});

test('a question that needs an answer is announced at once, takes the focus, and Y answers it', async () => {
  await fresh();
  await js(`heard({ type: 'approval', id: 'a1', task_id: 0, tool: 'send', question: 'Send this email to Ann?', detail: 'Subject: Lunch',
    choices: [{ id: 'allow', label: 'Send' }, { id: 'deny', label: 'Don’t send' }] }); true`);
  await sleep(60);
  const urgent = await said('sr-urgent');
  assert(urgent.length === 1 && /^Needs your OK\. Send this email to Ann\?/.test(urgent[0]) && /Choices: 1, Send; 2, Don’t send\./.test(urgent[0]), `announced ${JSON.stringify(urgent)}`);
  const focus = await js('document.activeElement.textContent');
  assert(focus === 'Send', `focus is on ${JSON.stringify(focus)}`);
  await sleep(450);  // an approval answers only once it has been up a moment
  await chord('Y');
  const s = await sent();
  assert(s.includes('approve a1 allow'), `sent ${s}`);
});

test('N answers no, and says so when nothing is waiting', async () => {
  await fresh();
  await chord('N');
  const lines = await said();
  assert(lines.length === 1 && lines[0] === 'Nothing is waiting for an answer.', `announced ${JSON.stringify(lines)}`);
  await js(`heard({ type: 'approval', id: 'a2', task_id: 0, tool: 'send', question: 'Delete the file?', detail: '', choices: [{ id: 'allow', label: 'Delete' }, { id: 'deny', label: 'Keep it' }] }); true`);
  await sleep(450);
  await chord('N');
  assert((await sent()).includes('approve a2 deny'), `sent ${await sent()}`);
});

test('an error is announced at once, as an alert', async () => {
  await fresh();
  await js(`heard({ type: 'error', text: 'The microphone is not available.' }); true`);
  await sleep(60);
  const urgent = await said('sr-urgent');
  assert(urgent.length === 1 && /Something went wrong/.test(urgent[0]) && /microphone/.test(urgent[0]), `announced ${JSON.stringify(urgent)}`);
});

test('Settings opens with the focus inside it, and Escape gives the focus back', async () => {
  await fresh();
  await js('document.getElementById("settings-btn").focus()');
  await js('document.getElementById("settings-btn").click()');
  await sleep(80);
  assert(await js('document.activeElement.id') === 'settings', `focus is on ${await js('document.activeElement.id || document.activeElement.tagName')}`);
  assert((await said()).some((l) => /Settings opened/.test(l)), `announced ${JSON.stringify(await said())}`);
  await press('Escape', 'Escape', 27);
  await sleep(80);
  assert(await js('document.activeElement.id') === 'settings-btn', `focus is on ${await js('document.activeElement.id || document.activeElement.tagName')}`);
});

test('Settings › Accessibility shows what is set, and a choice goes to the backend', async () => {
  await fresh({ a11y_mode: 'on', a11y_verbosity: 'brief' });
  const r = await js(`(() => {
    const g = document.getElementById('a11y-group');
    const checked = (label) => [...g.querySelectorAll('[aria-label="' + label + '"] [role=radio]')].filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.textContent);
    return { first: document.querySelector('#settings .group') === g, mode: checked('Screen-reader mode'), length: checked('How much Jarvis says'), cues: g.querySelector('[role=switch]').getAttribute('aria-checked') };
  })()`);
  assert(r.first, 'the group is not first in Settings');
  assert(r.mode.join() === 'On' && r.length.join() === 'Brief' && r.cues === 'true', JSON.stringify(r));
  await js(`document.querySelector('#a11y-group [aria-label="How much Jarvis says"] [data-value=detailed]').click(); true`);
  assert((await sent()).includes('prefs {"a11y_verbosity":"detailed"}'), `sent ${await sent()}`);
  assert(await js(`document.querySelector('#a11y-group [aria-label="How much Jarvis says"] [data-value=detailed]').getAttribute('aria-checked')`) === 'true', 'the choice did not show');
});

test('the arrow keys move through a group of choices, one tab stop each', async () => {
  await js(`document.getElementById('settings-btn').click(); true`);
  await sleep(60);
  const stops = await js(`[...document.querySelectorAll('#a11y-group [aria-label="Screen-reader mode"] [role=radio]')].map((b) => b.tabIndex)`);
  assert(stops.join() === '-1,0,-1', `tab stops ${stops}`);
  await js(`document.querySelector('#a11y-group [aria-label="Screen-reader mode"] [data-value=on]').focus(); true`);
  await press('ArrowRight', 'ArrowRight', 39);
  assert((await sent()).includes('prefs {"a11y_mode":"off"}'), `sent ${await sent()}`);
});

test('the keys list opens as a dialog, names every key, and Escape closes it', async () => {
  await fresh();
  await js('document.getElementById("ask-input").focus()');
  await chord('H');
  const d = await js(`(() => { const h = document.querySelector('.sr-help'); return h && { role: h.getAttribute('role'), text: h.textContent, focus: document.activeElement.textContent }; })()`);
  assert(d && d.role === 'dialog', 'no dialog');
  for (const k of ['+Y', '+N', '+R', '+S', '+T', '+U', '+H', 'Escape']) assert(d.text.includes(k), `missing ${k} in ${d.text}`);
  assert(d.focus === 'Close', `focus ${d.focus}`);
  await press('Escape', 'Escape', 27);
  assert(!(await js('!!document.querySelector(".sr-help")')), 'still open');
  assert(await js('document.activeElement.id') === 'ask-input', 'focus not returned');
});

test('a sound plays for listening, and none when sounds are off', async () => {
  await fresh();
  await js(`window.__tones = 0; const ctx = new AudioContext(); window.AudioContext = function () { return ctx; };
    const real = ctx.createOscillator.bind(ctx); ctx.createOscillator = () => { __tones++; return real(); }; true`);
  await js(`jarvisAccessibility.cue('listening'); true`);
  await js(`heard({ type: 'state', value: 'listening' }); true`);
  assert(await js('__tones') >= 2, `tones ${await js('__tones')}`);
  await fresh({ a11y_mode: 'on', a11y_cues: false });
  await js(`window.__tones = 0; const ctx = new AudioContext(); window.AudioContext = function () { return ctx; };
    const real = ctx.createOscillator.bind(ctx); ctx.createOscillator = () => { __tones++; return real(); };
    heard({ type: 'state', value: 'listening' }); true`);
  assert(await js('__tones') === 0, 'a sound played with sounds off');
});

test('on Windows the Mac’s key glyphs read as the keys Windows has', async () => {
  if (mac) return;  // (a Mac keeps its own)
  await js(`document.getElementById('state-line').textContent = 'Tap the orb or press ⌥ Space'; true`);
  await sleep(60);
  const r = await js(`({ line: document.getElementById('state-line').textContent, hint: document.getElementById('hint').textContent.replace(/\\s+/g, ' '), key: document.getElementById('settings-btn').getAttribute('aria-keyshortcuts') })`);
  assert(r.line === 'Tap the orb or press Ctrl+Alt+Space', `state line: ${r.line}`);
  assert(/Ctrl\+Alt\+J talk/.test(r.hint) && /Alt\+Shift\+Space what/.test(r.hint), `hint: ${r.hint}`);  // (the page says a PC's keys itself; the rewrite is for what else says ⌥)
  assert(r.key === 'Control+Comma', `keyshortcuts: ${r.key}`);
});

test('U says what Jarvis is doing', async () => {
  await fresh();
  await js(`heard({ type: 'state', value: 'thinking' }); document.getElementById('state-line').textContent = 'Thinking…'; true`);
  await chord('U');
  const lines = await said();
  assert(lines.length === 1 && /Thinking/.test(lines[0]) && /Nothing is waiting for your answer/.test(lines[0]), `announced ${JSON.stringify(lines)}`);
});

test('while it is on the window calls itself J.A.R.V.I.S. Daredevil and says where to start, once', async () => {
  await fresh({ a11y_mode: 'on' });
  const r = await js(`({ title: document.title, mark: document.getElementById('wordmark').textContent, welcome: window.__welcome, home: jarvisAccessibility.homeName() })`);
  // (Daredevil is the Windows edition: a Mac's window keeps its own name, the mode being just screen-reader mode there.)
  const [title, mark, welcomes] = mac ? ['Jarvis', 'Jarvis', 'Screen-reader mode is on. '] : ['J.A.R.V.I.S. Daredevil', 'Jarvis Daredevil', 'J.A.R.V.I.S. Daredevil. '];
  assert(r.title === title && r.mark === mark && r.home === mark, JSON.stringify(r));
  assert(r.welcome.length === 1 && r.welcome[0].startsWith(welcomes) && /T to talk/.test(r.welcome[0]) && /H lists the keys/.test(r.welcome[0]), JSON.stringify(r.welcome));
  await js(`heard({ type: 'prefs', features: { a11y_mode: 'on', a11y_verbosity: 'brief' } }); true`);
  assert((await said()).length === 0, `welcomed twice: ${await said()}`);
  const tree = await axTree();
  if (!mac) assert(tree.some((n) => /J\.A\.R\.V\.I\.S\. Daredevil/.test(n.name || '')), 'the name is not in the accessibility tree');
});

test('with it off the window is just Jarvis again, and it says nothing of its own', async () => {
  await fresh({ a11y_mode: 'on' });
  await js(`heard({ type: 'prefs', features: { a11y_mode: 'off' } }); true`);
  const r = await js(`({ title: document.title, mark: document.getElementById('wordmark').textContent, home: jarvisAccessibility.homeName() })`);
  assert(r.title === 'Jarvis' && r.mark === 'Jarvis' && r.home === 'Jarvis', JSON.stringify(r));
  await fresh({ a11y_mode: 'off' });
  assert((await js('window.__welcome')).length === 0, 'it welcomed with it off');
});

// WCAG's contrast ratio of two colours written as "rgb(r, g, b)".
const contrast = (a, b) => {
  const lum = (c) => c.match(/\d+/g).slice(0, 3).map(Number).map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }).reduce((t, v, i) => t + v * [0.2126, 0.7152, 0.0722][i], 0);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const sheets = () => js(`({ sheets: [...document.styleSheets].map((s) => (s.href || '').replace(/^.*\\//, '') + ':' + (() => { try { return s.cssRules.length; } catch (e) { return 'x'; } })()).filter((t) => /contrast|accessibility/.test(t)), hcbg: getComputedStyle(document.documentElement).getPropertyValue('--hc-bg'), attr: document.documentElement.getAttribute('data-contrast'), scheme: matchMedia('(prefers-color-scheme: dark)').matches, forced: matchMedia('(forced-colors: active)').matches })`);
const paint = async () => { await sleep(60); return js(`({ contrast: document.documentElement.dataset.contrast || '', size: document.documentElement.dataset.textSize || '', bg: getComputedStyle(document.body).backgroundColor, fg: getComputedStyle(document.body).color, zoom: window.__zoom || 0 })`); };

test('Daredevil is yellow on black and larger by default, and each pairing is far above AAA contrast', async () => {
  await fresh({ a11y_mode: 'on', a11y_voice: 'reader' });
  let r = await paint();
  assert(r.contrast === 'yellow' && r.size === 'large' && r.bg === 'rgb(0, 0, 0)' && r.fg === 'rgb(255, 255, 0)', `${JSON.stringify(r)} ${JSON.stringify(await sheets())}`);
  const asked = { yellow: ['rgb(0, 0, 0)', 'rgb(255, 255, 0)'], white: ['rgb(0, 0, 0)', 'rgb(255, 255, 255)'], 'yellow-bg': ['rgb(255, 229, 0)', 'rgb(0, 0, 0)'], 'yellow-blue': ['rgb(0, 22, 77)', 'rgb(255, 255, 0)'] };
  for (const [name, [bg, fg]] of Object.entries(asked)) {
    await js(`heard({ type: 'prefs', features: { a11y_mode: 'on', a11y_colors: '${name}', a11y_text_size: 'normal' } }); true`);
    r = await paint();
    assert(r.contrast === name && r.size === '' && r.bg === bg && r.fg === fg, `${name}: ${JSON.stringify(r)}`);
    assert(contrast(r.bg, r.fg) >= 14, `${name} has a contrast of only ${contrast(r.bg, r.fg).toFixed(1)}`);
  }
  await js(`heard({ type: 'prefs', features: { a11y_mode: 'on', a11y_colors: 'off', a11y_text_size: 'normal' } }); true`);
  r = await paint();
  assert(r.contrast === '' && r.bg !== 'rgb(0, 0, 0)', `colours off: ${JSON.stringify(r)}`);
  await fresh({ a11y_mode: 'off' });
  r = await paint();
  assert(r.contrast === '' && r.size === '', `Daredevil off: ${JSON.stringify(r)}`);
});

test('every panel, button and field has a solid edge and nothing is dimmed, in the colours', async () => {
  await fresh({ a11y_mode: 'on', a11y_voice: 'reader' });
  const r = await js(`(() => {
    const edge = (n) => { const c = getComputedStyle(n); return c.borderTopStyle === 'solid' && parseFloat(c.borderTopWidth) >= 1.5; };  // (2px, which a 125% screen draws as 1.6)
    const panels = ['p-weather', 'p-system', 'p-markets', 'p-uptime'].map((id) => document.getElementById(id)).filter(Boolean);
    const chips = [...document.querySelectorAll('.chips .chip, .chip')].slice(0, 4);
    const field = document.getElementById('ask-input');
    return { panels: panels.length, panelEdges: panels.every(edge), chips: chips.length, chipEdges: chips.every(edge), fieldEdge: edge(field), blur: getComputedStyle(panels[0]).backdropFilter, canvas: getComputedStyle(document.getElementById('galaxy-canvas')).display };
  })()`);
  assert(r.panels >= 2 && r.panelEdges && r.chips >= 1 && r.chipEdges && r.fieldEdge, JSON.stringify(r));
  assert(r.blur === 'none' && r.canvas === 'none', `glass or the galaxy is still there: ${JSON.stringify(r)}`);
});

test('the text size is the window’s own zoom when the app gives it (the layout follows), else the page’s', async () => {
  await fresh({ a11y_mode: 'on', a11y_voice: 'reader', a11y_text_size: 'normal' });
  assert((await paint()).size === '', 'normal is not normal');
  await js(`heard({ type: 'prefs', features: { a11y_mode: 'on', a11y_text_size: 'larger' } }); true`);
  assert((await paint()).size === 'larger', 'no page zoom without the app');
  await js(`window.jarvisApp = { setZoom: (f) => { window.__zoom = f; } }; heard({ type: 'prefs', features: { a11y_mode: 'on', a11y_text_size: 'largest' } }); true`);
  let r = await paint();
  assert(r.zoom === 2 && r.size === '', `the app's zoom: ${JSON.stringify(r)}`);
  await js(`heard({ type: 'prefs', features: { a11y_mode: 'on', a11y_text_size: 'large' } }); true`);
  assert((await paint()).zoom === 1.25, 'large is not 125%');
  await js(`heard({ type: 'prefs', features: { a11y_mode: 'off' } }); true`);
  assert((await paint()).zoom === 1, 'the zoom stays when the edition is off');
});

test('Settings › Accessibility has the colour choices as samples, and picking one goes to the backend', async () => {
  await fresh({ a11y_mode: 'on', a11y_voice: 'reader' });
  await js(`document.getElementById('settings').hidden = false; true`);
  const names = await js(`[...document.querySelectorAll('#a11y-group [aria-label="Colours"] [role="radio"]')].map((b) => b.textContent.replace('Aa', ''))`);
  assert(names.join('|') === 'Auto|Yellow on black|White on black|Black on yellow|Yellow on blue|Off', `choices ${names}`);
  await js(`document.getElementById('settings').hidden = false; document.querySelector('#a11y-group [aria-label="Colours"] [data-value="white"]').click(); true`);
  assert((await sent()).includes('prefs {"a11y_colors":"white"}'), `sent ${await sent()}`);
  assert((await paint()).contrast === 'white', 'the page did not change at once');
  const size = await js(`[...document.querySelectorAll('#a11y-group [aria-label="Text size"] [role="radio"]')].map((b) => b.textContent)`);
  assert(size.join('|') === 'Auto|Normal|Large|Larger|Largest', `sizes ${size}`);
  const voice = await js(`[...document.querySelectorAll('#a11y-group [aria-label="Who reads replies aloud"] [role="radio"]')].map((b) => b.textContent)`);
  assert(voice.join('|') === 'Auto|My screen reader|Jarvis’s voice', `voices ${voice}`);
});

test('Settings has an Accessibility category in its sidebar, which holds this section', async () => {
  await fresh({ a11y_mode: 'on', a11y_voice: 'reader' });
  await script('settings-nav.js');
  await sleep(200);
  const r = await js(`({ item: !!document.querySelector('#settings-nav [data-pane="accessibility"]'), pane: document.getElementById('a11y-group').dataset.settingsPane })`);
  assert(r.item && r.pane === 'accessibility', JSON.stringify(r));
});

test('Settings › Accessibility says what J.A.R.V.I.S. Daredevil is', async () => {
  await fresh({ a11y_mode: 'on' });
  const note = await js(`document.querySelector('#a11y-group .group-note').textContent`);
  assert(new RegExp(`^${mac ? 'Screen-reader mode' : 'J\\.A\\.R\\.V\\.I\\.S\\. Daredevil'} is for people who are blind or have low vision`).test(note), note);
});

// ── Settings › Email accounts ──

const mailPage = async (open = true) => {
  await style('mail-accounts.css');
  await script('mail-accounts.js');
  if (open) await js(`document.getElementById('settings').hidden = false; true`);  // (a hidden sheet can't take the focus)
};
const MAIL = [{ id: 'ann@gmail.com', address: 'ann@gmail.com', label: 'Personal', name: 'Ann', imap_host: 'imap.gmail.com', imap_port: 993, imap_security: 'ssl', smtp_host: 'smtp.gmail.com', smtp_port: 465, smtp_security: 'ssl', username: '', has_password: true }];

test('the email page stays away until the backend has email (a Mac has Mail.app)', async () => {
  await mailPage(false);
  assert(await js(`document.getElementById('mail-group').hidden`), 'the group is showing with no email backend');
  assert((await sent()).includes('mail_status'), `sent ${await sent()}`);
  await js(`heard({ type: 'mail_accounts', accounts: ${JSON.stringify(MAIL)} }); true`);
  assert(!(await js(`document.getElementById('mail-group').hidden`)), 'still hidden');
  assert(await js(`document.getElementById('mail-summary').textContent`) === '1 email account.', 'no count');
  const names = await js(`[...document.querySelectorAll('#mail-list button')].map((b) => b.getAttribute('aria-label'))`);
  assert(names.join('|') === 'Check ann@gmail.com|Change password ann@gmail.com|Remove ann@gmail.com', `buttons ${names}`);
});

test('every field of the email form has a name a screen reader says', async () => {
  await mailPage();
  await js(`heard({ type: 'mail_accounts', accounts: [] }); document.getElementById('settings').hidden = false; true`);
  const tree = await axTree();
  for (const name of ['Email address', 'App password', 'Name on your emails', 'Label']) {
    assert(tree.some((n) => n.role === 'textbox' && (n.name || '').startsWith(name)), `no textbox called ${name} in ${JSON.stringify(tree.filter((n) => n.role === 'textbox').map((n) => n.name))}`);
  }
  assert(tree.some((n) => n.role === 'button' && n.name === 'Check it') && tree.some((n) => n.role === 'button' && n.name === 'Add account'), 'buttons missing');
  const pw = await js(`document.getElementById('mail-password').type + ' ' + document.getElementById('mail-password').getAttribute('aria-describedby')`);
  assert(pw === 'password mail-help', `password field: ${pw}`);
});

test('typing an address asks for its servers and the advice for its password, and says it where it is read', async () => {
  await mailPage();
  await js(`heard({ type: 'mail_accounts', accounts: [] }); const a = document.getElementById('mail-address'); a.value = 'sam@gmail.com'; a.dispatchEvent(new Event('change', { bubbles: true })); true`);
  assert((await sent()).includes('mail_guess'), `sent ${await sent()}`);
  await js(`heard({ type: 'mail_guess', address: 'sam@gmail.com', ok: true, known: true, provider: 'Gmail', help: 'Gmail needs an app password.', account: { imap_host: 'imap.gmail.com', imap_port: 993, imap_security: 'ssl', smtp_host: 'smtp.gmail.com', smtp_port: 465, smtp_security: 'ssl', username: '', name: '' } }); true`);
  assert(await js(`document.getElementById('mail-help').textContent`) === 'Gmail: Gmail needs an app password.', 'no advice');
  assert(await js(`document.getElementById('mail-imap-host').value`) === 'imap.gmail.com', 'servers not filled');
});

test('checking needs the address and the password, and never sends without them', async () => {
  await mailPage();
  await js(`heard({ type: 'mail_accounts', accounts: [] }); true`);
  await js(`document.querySelector('.mail-actions button').click(); true`);
  assert(await js(`document.getElementById('mail-result').textContent`) === 'Type your email address first.', 'no word about the address');
  await js(`document.getElementById('mail-address').value = 'sam@gmail.com'; document.querySelector('.mail-actions button').click(); true`);
  assert(await js(`document.getElementById('mail-result').textContent`) === 'Type the app password first.', 'no word about the password');
  assert(await js(`document.activeElement.id`) === 'mail-password', 'focus not on the password');
  assert(!(await sent()).includes('mail_check'), `sent ${await sent()}`);
});

test('a check goes out with only what was changed, the answer is said, and adding clears the secret', async () => {
  await mailPage();
  await js(`heard({ type: 'mail_accounts', accounts: [] }); true`);
  await js(`const a = document.getElementById('mail-address'); a.value = 'sam@gmail.com'; a.dispatchEvent(new Event('change', { bubbles: true }));
    heard({ type: 'mail_guess', address: 'sam@gmail.com', ok: true, known: true, provider: 'Gmail', help: 'h', account: { imap_host: 'imap.gmail.com', imap_port: 993, imap_security: 'ssl', smtp_host: 'smtp.gmail.com', smtp_port: 465, smtp_security: 'ssl', username: '' } });
    document.getElementById('mail-password').value = 'abcd efgh'; document.querySelector('.mail-actions button').click(); true`);
  const check = await js(`__sent.find((m) => m.type === 'mail_check')`);
  assert(check && check.address === 'sam@gmail.com' && check.password === 'abcd efgh', `sent ${JSON.stringify(check)}`);
  assert(!('imap_host' in check) && !('smtp_port' in check), `server fields sent though unchanged: ${JSON.stringify(check)}`);
  assert(await js(`document.getElementById('mail-result').textContent`) === 'Checking…', 'no sign of waiting');
  await js(`heard({ type: 'mail_check', address: 'sam@gmail.com', ok: true, text: 'Signed in to sam@gmail.com. 2 unread in the inbox. Sending works too.' }); true`);
  assert(await js(`document.getElementById('mail-result').textContent`) === 'Signed in to sam@gmail.com. 2 unread in the inbox. Sending works too.', 'no answer');
  await js(`document.getElementById('mail-form').requestSubmit(); true`);
  assert((await sent()).includes('mail_save'), `sent ${await sent()}`);
  await js(`heard({ type: 'mail_check', address: 'sam@gmail.com', ok: true, saved: true, text: 'Saved.' }); true`);
  assert(await js(`document.getElementById('mail-password').value === '' && document.getElementById('mail-address').value === ''`), 'the secret or the address is still in the form');
  assert(await js(`document.activeElement.id`) === 'mail-address', 'focus not back on the address');
});

test('a refusal is said in words and marked as a problem', async () => {
  await mailPage();
  await js(`heard({ type: 'mail_accounts', accounts: [] }); true`);
  await js(`heard({ type: 'mail_check', address: 'x@y.example', ok: false, text: 'x@y.example refused the password.' }); true`);
  const r = await js(`({ t: document.getElementById('mail-result').textContent, bad: document.getElementById('mail-result').classList.contains('mail-bad'), role: document.getElementById('mail-result').getAttribute('role') })`);
  assert(r.t === 'x@y.example refused the password.' && r.bad && r.role === 'status', JSON.stringify(r));
});

// ── Settings › Calendars ──

const calendarsPage = async (open = true) => {
  await style('calendars.css');
  await script('calendars.js');
  if (open) await js(`document.getElementById('settings').hidden = false; true`);
};
const CALS = [
  { id: 'local', title: 'Jarvis', kind: 'local', writable: true, color: '#1A73E8', source: 'This PC', default: true, error: '', checked: '' },
  { id: 'feed-1', title: 'Brightspace', kind: 'feed', writable: false, color: '#188038', source: 'Calendar link', default: false, error: '', checked: '2026-10-08T09:00:00' },
];

test('the calendars page stays away until the backend has calendars (a Mac has the Calendar app)', async () => {
  await calendarsPage(false);
  assert(await js(`document.getElementById('calendars-group').hidden`), 'the group is showing with no calendar backend');
  assert((await sent()).includes('calendars_status'), `sent ${await sent()}`);
  await js(`heard({ type: 'calendars', calendars: ${JSON.stringify(CALS)} }); true`);
  assert(!(await js(`document.getElementById('calendars-group').hidden`)), 'still hidden');
  assert(await js(`document.getElementById('calendars-summary').textContent`) === 'Jarvis’s own calendar and 1 calendar link.', 'no count');
  const names = await js(`[...document.querySelectorAll('#calendars-list button')].map((b) => b.getAttribute('aria-label'))`);
  assert(names.join('|') === 'Read again Brightspace|Remove Brightspace', `buttons ${names}`);
  const lines = await js(`[...document.querySelectorAll('#calendars-list .cal-name')].map((n) => n.textContent)`);
  assert(/Jarvis, kept on this computer/.test(lines[0]) && /Brightspace, a calendar link, read only, read 2026-10-08 09:00/.test(lines[1]), JSON.stringify(lines));
});

test('every field of the calendar form has a name a screen reader says', async () => {
  await calendarsPage();
  await js(`heard({ type: 'calendars', calendars: [] }); true`);
  const tree = await axTree();
  for (const name of ['Calendar link', 'Name']) {
    assert(tree.some((n) => n.role === 'textbox' && (n.name || '').startsWith(name)), `no textbox called ${name} in ${JSON.stringify(tree.filter((n) => n.role === 'textbox').map((n) => n.name))}`);
  }
  assert(tree.some((n) => n.role === 'button' && n.name === 'Add calendar') && tree.some((n) => n.role === 'button' && n.name === 'Read all again'), 'buttons missing');
});

test('a link is checked on the page, sent once, and not left in the field', async () => {
  await calendarsPage();
  await js(`heard({ type: 'calendars', calendars: [] }); true`);
  await js(`document.getElementById('calendars-form').requestSubmit(); true`);
  assert(await js(`document.getElementById('calendars-result').textContent`) === 'Paste the calendar link first.', 'no word about the link');
  await js(`document.getElementById('calendars-url').value = 'http://nope.example/x.ics'; document.getElementById('calendars-form').requestSubmit(); true`);
  assert(/starts with https/.test(await js(`document.getElementById('calendars-result').textContent`)), 'an insecure link was let through');
  assert(!(await sent()).includes('calendar_add_feed'), `sent ${await sent()}`);
  await js(`document.getElementById('calendars-url').value = 'webcal://brightspace.example/feed.ics'; document.getElementById('calendars-name').value = 'Courses'; document.getElementById('calendars-form').requestSubmit(); true`);
  const add = await js(`__sent.find((m) => m.type === 'calendar_add_feed')`);
  assert(add && add.url === 'webcal://brightspace.example/feed.ics' && add.name === 'Courses', `sent ${JSON.stringify(add)}`);
  assert(await js(`document.getElementById('calendars-url').value`) === '', 'the link is still on the page');
  assert(await js(`document.getElementById('calendars-result').textContent`) === 'Reading the calendar…', 'no sign of waiting');
  await js(`heard({ type: 'calendar_result', ok: true, text: 'Added Courses: 12 events found. It is read-only here.', added: 'feed-2' }); true`);
  const r = await js(`({ t: document.getElementById('calendars-result').textContent, bad: document.getElementById('calendars-result').classList.contains('cal-bad'), role: document.getElementById('calendars-result').getAttribute('role'), focus: document.activeElement.id })`);
  assert(r.t.startsWith('Added Courses') && !r.bad && r.role === 'status' && r.focus === 'calendars-url', JSON.stringify(r));
  await js(`heard({ type: 'calendar_result', ok: false, text: 'The calendar link was refused.' }); true`);
  assert(await js(`document.getElementById('calendars-result').classList.contains('cal-bad')`), 'a refusal is not marked as a problem');
});

test('Outlook has a switch with a name, shown only where Outlook is, and it says what it did', async () => {
  await calendarsPage();
  await js(`heard({ type: 'calendars', calendars: ${JSON.stringify(CALS)}, outlook: { available: false, on: false } }); true`);
  assert(await js(`document.querySelector('.cal-outlook').hidden`), 'the Outlook switch shows where there is no Outlook');
  await js(`heard({ type: 'calendars', calendars: ${JSON.stringify(CALS)}, outlook: { available: true, on: false } }); true`);
  assert(!(await js(`document.querySelector('.cal-outlook').hidden`)), 'no Outlook switch where there is Outlook');
  const tree = await axTree();
  assert(tree.some((n) => (n.role === 'checkbox' || n.role === 'switch') && (n.name || '').startsWith('Read my Outlook calendar')), `no named switch: ${JSON.stringify(tree.filter((n) => n.role === 'checkbox').map((n) => n.name))}`);
  await js(`document.getElementById('calendars-outlook').click(); true`);
  const on = await js(`__sent.find((m) => m.type === 'calendar_outlook')`);
  assert(on && on.on === true, `sent ${JSON.stringify(on)}`);
  assert(await js(`document.getElementById('calendars-result').textContent`) === 'Reading Outlook…', 'no sign of waiting');
  await js(`heard({ type: 'calendars', calendars: ${JSON.stringify([...CALS, { id: 'outlook', title: 'Outlook', kind: 'outlook', writable: false, color: '#D93025', source: 'Outlook on this PC', default: false, error: '', checked: '2026-10-08T09:30:00' }])}, outlook: { available: true, on: true } }); true`);
  assert(await js(`document.getElementById('calendars-outlook').checked`), 'the switch is off though Outlook is on');
  const lines = await js(`[...document.querySelectorAll('#calendars-list .cal-name')].map((n) => n.textContent)`);
  assert(/Outlook on this PC, read only, read 2026-10-08 09:30/.test(lines[2]), JSON.stringify(lines));
  const names = await js(`[...document.querySelectorAll('#calendars-list button')].map((b) => b.getAttribute('aria-label'))`);
  assert(names.join('|') === 'Read again Brightspace|Remove Brightspace|Read again Outlook', `buttons ${names}`);
});

test('removing a calendar asks first, and says what was kept', async () => {
  await calendarsPage();
  await js(`heard({ type: 'calendars', calendars: ${JSON.stringify(CALS)} }); window.__asked = []; window.confirm = (q) => { __asked.push(q); return false; }; document.querySelector('#calendars-list button[aria-label="Remove Brightspace"]').click(); true`);
  assert(!(await sent()).includes('calendar_remove'), 'removed without a yes');
  assert((await js('__asked'))[0] === 'Remove Brightspace? Nothing is deleted from the calendar itself.', JSON.stringify(await js('__asked')));
  await js(`window.confirm = () => true; document.querySelector('#calendars-list button[aria-label="Remove Brightspace"]').click(); true`);
  const gone = await js(`__sent.find((m) => m.type === 'calendar_remove')`);
  assert(gone && gone.id === 'feed-1', `sent ${JSON.stringify(gone)}`);
});

test('Outlook is offered where it is, adds itself with one press, and has no password to change', async () => {
  await mailPage();
  await js(`heard({ type: 'mail_accounts', accounts: [], outlook: { available: false, open: false } }); true`);
  assert(await js(`document.querySelector('.mail-outlook').hidden`), 'the Outlook choice shows where there is no Outlook');
  await js(`heard({ type: 'mail_accounts', accounts: [], outlook: { available: true, open: true } }); true`);
  assert(!(await js(`document.querySelector('.mail-outlook').hidden`)), 'no Outlook choice where there is Outlook');
  const tree = await axTree();
  assert(tree.some((n) => n.role === 'button' && n.name === 'Use my Outlook'), 'the button has no name');
  await js(`document.getElementById('mail-outlook-add').click(); true`);
  const asked = await js(`__sent.find((m) => m.type === 'mail_outlook')`);
  assert(asked && asked.action === 'add', `sent ${JSON.stringify(asked)}`);
  assert(await js(`document.getElementById('mail-result').textContent`) === 'Asking Outlook…', 'no sign of waiting');
  const OUTLOOK = { id: 'outlook', address: 'ann@school.edu', label: 'Outlook', name: 'Ann', kind: 'outlook', has_password: true };
  await js(`heard({ type: 'mail_accounts', accounts: [${JSON.stringify(OUTLOOK)}], outlook: { available: true, open: true } }); true`);
  assert(await js(`document.querySelector('.mail-outlook').hidden`), 'the choice is still offered once Outlook is added');
  const buttons = await js(`[...document.querySelectorAll('#mail-list button')].map((b) => b.getAttribute('aria-label') + (b.hidden ? ' (hidden)' : ''))`);
  assert(buttons.join('|') === 'Check ann@school.edu|Change password ann@school.edu (hidden)|Remove ann@school.edu', `buttons ${buttons}`);
  await js(`document.querySelector('#mail-list button').click(); true`);
  const check = await js(`__sent.filter((m) => m.type === 'mail_outlook').pop()`);
  assert(check && check.action === 'check', `sent ${JSON.stringify(check)}`);
});

test('removing an account asks first and then says so', async () => {
  await mailPage();
  await js(`heard({ type: 'mail_accounts', accounts: ${JSON.stringify(MAIL)} }); window.__asked = []; window.confirm = (q) => { __asked.push(q); return true; }; true`);
  await js(`document.querySelector('#mail-list button[aria-label^="Remove"]').click(); true`);
  assert((await js('__asked'))[0] === 'Remove ann@gmail.com? Your mail stays where it is.', `asked ${await js('__asked')}`);
  assert((await js(`__sent.find((m) => m.type === 'mail_remove').id`)) === 'ann@gmail.com', 'not removed');
});

test('every control in every panel has a name a screen reader says', async () => {
  const dir = process.env.JARVIS_WEB_DIR || path.join(__dirname, '..', '..', 'src', 'jarvis', 'web');
  const files = fs.readdirSync(path.join(dir, 'features')).sort();
  for (const f of files.filter((x) => x.endsWith('.css'))) await style(f);
  for (const f of files.filter((x) => x.endsWith('.js'))) { try { await script(f); } catch (_) { /* one that needs a backend */ } }
  const interactive = new Set(['button', 'link', 'textbox', 'checkbox', 'radio', 'switch', 'combobox', 'slider', 'tab', 'menuitem', 'searchbox', 'spinbutton', 'listbox', 'option']);
  const panels = [
    ['Settings', "document.getElementById('settings').hidden = false"],
    ['Activity', "toggleSettings(false); toggleDrawer(true)"],
    ['Tools & Accounts', "toggleDrawer(false); toggleAccounts(true)"],
    ['Eden Code', "toggleAccounts(false); toggleCC(true)"],
    ['the setup tour', "toggleCC(false); window.jarvisIntro.open()"],
  ];
  const problems = [];
  for (const [label, code] of panels) {
    await js(`${code}; true`);
    await sleep(500);
    const tree = await axTree();
    for (const n of tree.filter((x) => interactive.has(x.role) && !(x.name || '').trim())) problems.push(`${label}: a ${n.role} with no name`);
    if (tree.length < 40) problems.push(`${label}: only ${tree.length} things for a screen reader to read`);
  }
  assert(problems.length === 0, problems.join('; '));
});

test('Settings › Accessibility has the two punctuation choices as they are set, and a choice goes to the backend', async () => {
  await fresh({ a11y_mode: 'on', a11y_dictate_punct: 'spoken', a11y_read_punct: 'some' });
  const r = await js(`(() => {
    const g = document.getElementById('a11y-group');
    const checked = (label) => [...g.querySelectorAll('[aria-label="' + label + '"] [role=radio]')].filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.textContent);
    return { dictate: checked('Dictated punctuation'), read: checked('Reading punctuation') };
  })()`);
  assert(r.dictate.join() === 'I say it' && r.read.join() === 'Main marks', JSON.stringify(r));
  await js(`document.querySelector('#a11y-group [aria-label="Reading punctuation"] [data-value=all]').click(); true`);
  assert((await sent()).includes('prefs {"a11y_read_punct":"all"}'), `sent ${await sent()}`);
  await js(`document.querySelector('#a11y-group [aria-label="Dictated punctuation"] [data-value=auto]').click(); true`);
  assert((await sent()).includes('prefs {"a11y_dictate_punct":"auto"}'), `sent ${await sent()}`);
});

test('with the marks asked for, an approval and a reply are announced with their punctuation said', async () => {
  await fresh({ a11y_mode: 'on', a11y_voice: 'reader', a11y_read_punct: 'some' });
  await script('punctuation.js');
  await js(`heard({ type: 'approval', id: 'p1', task_id: 0, tool: 'send', question: 'Send this email to Ann?', detail: 'Dear Ann, thanks for the draft.',
    choices: [{ id: 'allow', label: 'Send' }, { id: 'deny', label: 'Don’t send' }] }); true`);
  await sleep(60);
  const urgent = await said('sr-urgent');
  assert(urgent.length === 1 && /Dear Ann comma thanks for the draft period/.test(urgent[0]), `announced ${JSON.stringify(urgent)}`);
  await js(`heard({ type: 'turn', rid: 'p2', user: 'hi' }); heard({ type: 'reply', rid: 'p2', text: 'Hello, world.' }); heard({ type: 'turn_done', rid: 'p2' }); true`);
  await sleep(60);
  const lines = await said();
  assert(lines.length === 1 && /Hello comma world period/.test(lines[0]), `announced ${JSON.stringify(lines)}`);
});

test('without the marks asked for, nothing about punctuation is said', async () => {
  await fresh({ a11y_mode: 'on', a11y_voice: 'reader' });
  await script('punctuation.js');
  await js(`heard({ type: 'turn', rid: 'p3', user: 'hi' }); heard({ type: 'reply', rid: 'p3', text: 'Hello, world.' }); heard({ type: 'turn_done', rid: 'p3' }); true`);
  await sleep(60);
  const lines = await said();
  assert(lines.length === 1 && lines[0] === 'Hello, world.', `announced ${JSON.stringify(lines)}`);
});

test('J.A.R.V.I.S. Daredevil: on from the start with no screen reader, in yellow on black; Off still turns it off', async () => {
  await fresh({ a11y_mode: 'auto', a11y_voice: 'auto' }, { edition: true });
  const on = await js(`({
    sr: document.documentElement.dataset.sr,
    contrast: document.documentElement.dataset.contrast,
    title: document.title,
    state: window.jarvisAccessibility.state(),
    welcome: window.__welcome,
    settings: document.getElementById('a11y-group') ? document.getElementById('a11y-group').textContent : '',
  })`);
  assert(on.sr === '1', `the mode is not on: data-sr ${on.sr}`);
  assert(on.contrast === 'yellow', `colours ${on.contrast}`);
  assert(on.state.edition === true && on.state.effective === true && on.state.detected === false, JSON.stringify(on.state));
  assert(on.state.readerSpeaks === false, 'with no screen reader, the replies are Jarvis’s own voice');
  assert(mac || on.title === 'J.A.R.V.I.S. Daredevil', `window title ${on.title}`);
  assert(on.welcome.length === 1 && /T to talk/.test(on.welcome[0]), `welcome ${JSON.stringify(on.welcome)}`);
  assert(/In J\.A\.R\.V\.I\.S\. Daredevil, Auto keeps it on/.test(on.settings), 'the Settings note for Auto does not say what it does here');
  // switched off in Settings, it is off, mark or no mark
  await fresh({ a11y_mode: 'off' }, { edition: true });
  assert((await js('document.documentElement.dataset.sr')) === '0', 'Off did not turn it off');
  // a plain J.A.R.V.I.S.: only a screen reader turns Auto on
  await fresh({ a11y_mode: 'auto' });
  assert((await js('document.documentElement.dataset.sr')) === '0', 'Auto was on with no screen reader and no edition');
});

// ── the first-run setup, switches, stopping, and the backend's short lines ──

// A fresh window with the setup (accessibility_setup.js) loaded too.
async function freshSetup(features = { a11y_mode: 'on', a11y_voice: 'reader' }, opts = {}) {
  await fresh(features, opts);
  await script('accessibility_setup.js');
  await sleep(800); // (it opens a moment after the welcome)
}
const setupState = () => js('jarvisAccessibility.setup.state()');
const sentRaw = () => js('JSON.parse(JSON.stringify(__sent))');

test('the first time, the setup opens as a dialog, takes the focus, is announced, and keeps Tab inside it', async () => {
  await freshSetup();
  const s = await setupState();
  assert(s.open && s.step === 'welcome', JSON.stringify(s));
  const d = await js(`(() => { const d = document.getElementById('a11y-setup'); return { role: d.getAttribute('role'), modal: d.getAttribute('aria-modal'), label: document.getElementById(d.getAttribute('aria-labelledby')).textContent, focus: document.activeElement.id }; })()`);
  assert(d.role === 'dialog' && d.modal === 'true' && /^Step 1 of 8: Welcome$/.test(d.label) && d.focus === 'a11y-setup-title', JSON.stringify(d));
  assert((await said()).some((l) => /^Step 1 of 8\. Welcome\./.test(l) && /say next, back, or skip setup/.test(l)), `announced ${JSON.stringify(await said())}`);
  assert((await sentRaw()).some((m) => m.type === 'a11y_setup' && m.open === true && m.step === 'welcome'), 'the backend was not told it is open');
  for (let i = 0; i < 6; i++) await press('Tab', 'Tab', 9);
  assert(await js(`document.getElementById('a11y-setup').contains(document.activeElement)`), 'Tab left the dialog');
});

test('the setup moves by keyboard and by voice, sets what is chosen, and Escape ends it for good', async () => {
  await freshSetup();
  await js(`[...document.querySelectorAll('#a11y-setup button')].find((b) => b.textContent === 'Next').click(); true`);
  assert((await setupState()).step === 'speed', 'Next did not move on');
  await js(`[...document.querySelectorAll('#a11y-setup button')].find((b) => b.textContent === 'Faster').click(); true`);
  const speed = (await sentRaw()).filter((m) => m.type === 'voice_settings').map((m) => m.changes.voice_speed);
  assert(speed.at(-1) === 120, `speed sent ${speed}`);
  assert((await sentRaw()).some((m) => m.type === 'a11y_setup' && m.sample === true), 'no sample was asked for');
  // "Jarvis, next" (the backend hears it and says so)
  await js(`heard({ type: 'a11y_setup_cmd', action: 'next' }); true`);
  assert((await setupState()).step === 'look', 'the spoken next did not move on');
  await js(`document.querySelector('#a11y-setup [aria-label="Colours"] [data-value="white"]').click(); true`);
  assert((await sent()).includes('prefs {"a11y_colors":"white"}'), `sent ${await sent()}`);
  await js(`heard({ type: 'a11y_setup_cmd', action: 'back' }); true`);
  assert((await setupState()).step === 'speed', 'back did not go back');
  await press('Escape', 'Escape', 27);
  assert(!(await setupState()).open, 'Escape did not close it');
  assert((await sentRaw()).some((m) => m.type === 'a11y_setup' && m.open === false && m.done === true), 'the backend was not told it is done');
  // Done: it doesn't open by itself again, but Alt+Shift+W brings it back.
  await js(`heard({ type: 'prefs', features: { a11y_mode: 'on', a11y_voice: 'reader', a11y_setup_done: true } }); true`);
  await sleep(700);
  assert(!(await setupState()).open, 'it opened again by itself');
  await chord('W');
  assert((await setupState()).open, 'Alt+Shift+W did not open it');
});

test('the setup’s trusted person is checked and saved, and Settings has the same fields and a way back to the setup', async () => {
  await freshSetup();
  await js(`heard({ type: 'a11y_setup_cmd', action: 'open' }); true`);
  for (let i = 0; i < 6; i++) await js(`heard({ type: 'a11y_setup_cmd', action: 'next' }); true`);
  assert((await setupState()).step === 'helper', JSON.stringify(await setupState()));
  await js(`document.getElementById('a11y-setup-helper-name').value = 'Ann Lee'; document.getElementById('a11y-setup-helper-email').value = 'ann@'; true`);
  await js(`heard({ type: 'a11y_setup_cmd', action: 'next' }); true`);
  assert((await setupState()).step === 'helper', 'it moved on with an address that is not complete');
  assert((await said()).some((l) => /not complete/.test(l)), `announced ${JSON.stringify(await said())}`);
  await js(`document.getElementById('a11y-setup-helper-email').value = 'ann@example.com'; true`);
  await js(`heard({ type: 'a11y_setup_cmd', action: 'next' }); true`);
  assert((await setupState()).step === 'done', 'it did not move on');
  assert((await sent()).includes('prefs {"a11y_helper_name":"Ann Lee","a11y_helper_email":"ann@example.com","a11y_helper_phone":""}'), `sent ${await sent()}`);
  await js(`heard({ type: 'a11y_setup_cmd', action: 'finish' }); true`);
  const r = await js(`(() => {
    const names = ['name', 'email', 'phone'].map((id) => document.getElementById('a11y-settings-helper-' + id));
    return { labelled: names.every((n) => n && n.closest('label') && n.closest('label').textContent.trim().length > 3), again: Boolean(document.getElementById('a11y-setup-again')) };
  })()`);
  assert(r.labelled && r.again, JSON.stringify(r));
});

test('with switch control, Space moves through a question’s choices, each said, and a long press chooses', async () => {
  await fresh({ a11y_mode: 'on', a11y_voice: 'reader', a11y_switch: 'one', a11y_switch_hold: 500 });
  await js(`heard({ type: 'approval', id: 's1', task_id: 0, tool: 'send', question: 'Send this email to Ann?', detail: '', choices: [{ id: 'allow', label: 'Send' }, { id: 'deny', label: 'Don’t send' }] }); true`);
  await sleep(60);
  const urgent = await said('sr-urgent');
  assert(urgent.length === 1 && /Press Space to move through the choices, and hold it to choose\./.test(urgent[0]), `announced ${JSON.stringify(urgent)}`);
  await sleep(450);
  await press(' ', 'Space', 32);
  assert(await js('document.activeElement.textContent') === 'Don’t send', `focus on ${await js('document.activeElement.textContent')}`);
  assert((await said('sr-urgent')).some((l) => l === 'Don’t send. 2 of 2.'), `announced ${JSON.stringify(await said('sr-urgent'))}`);
  await press(' ', 'Space', 32);
  assert(await js('document.activeElement.textContent') === 'Send', 'it did not go round to the first choice');
  assert(!(await sent()).some((m) => m.startsWith('approve')), 'a short press answered');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await sleep(650);
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  assert((await sent()).includes('approve s1 allow'), `sent ${await sent()}`);
  assert((await said('sr-urgent')).some((l) => l === 'Chose Send.'), `announced ${JSON.stringify(await said('sr-urgent'))}`);
});

test('with two switches the second one chooses; with no question waiting the keys are the page’s', async () => {
  await fresh({ a11y_mode: 'on', a11y_voice: 'reader', a11y_switch: 'two' });
  await js(`document.getElementById('ask-input').focus(); document.getElementById('ask-input').value = 'what time is it'; true`);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  assert((await sent()).includes('ask'), `Enter in the request box did not send it: ${await sent()}`);
  await js(`heard({ type: 'approval', id: 's2', task_id: 0, tool: 'send', question: 'Delete the file?', detail: '', choices: [{ id: 'allow', label: 'Delete' }, { id: 'deny', label: 'Keep it' }] }); true`);
  await sleep(500);
  await press(' ', 'Space', 32);
  await press('Enter', 'Enter', 13);
  assert((await sent()).includes('approve s2 deny'), `sent ${await sent()}`);
});

test('the Stop talking key (from any program) and Alt+Shift+S stop what is being read, cutting off the screen reader', async () => {
  await fresh();
  await js(`heard({ type: 'turn', rid: 'r9', user: 'read it' }); heard({ type: 'reply', rid: 'r9', text: 'A long letter.' }); heard({ type: 'turn_done', rid: 'r9' }); true`);
  assert((await said()).length === 1, 'the reply was not read');
  await js(`document.dispatchEvent(new Event('jarvis:stop-all')); true`);
  assert((await said()).length === 0, `still waiting to be read: ${await said()}`);
  assert(JSON.stringify(await said('sr-urgent')) === '["Stopped."]', `announced ${JSON.stringify(await said('sr-urgent'))}`);
  await chord('S');
  assert((await sent()).includes('stop'), `sent ${await sent()}`);
});

test('the backend’s short lines are announced: a private window, the screen sent, where the focus went', async () => {
  await fresh();
  await js(`heard({ type: 'a11y_say', text: 'This screen has private information, reading it aloud.', important: true }); heard({ type: 'a11y_say', text: 'Now in Outlook: Inbox.' }); true`);
  assert(JSON.stringify(await said('sr-urgent')) === '["This screen has private information, reading it aloud."]', `urgent ${JSON.stringify(await said('sr-urgent'))}`);
  assert(JSON.stringify(await said()) === '["Now in Outlook: Inbox."]', `polite ${JSON.stringify(await said())}`);
  await fresh({ a11y_mode: 'on', a11y_voice: 'jarvis' });
  await js(`heard({ type: 'a11y_say', text: 'Now in Word.' }); true`);
  assert((await said()).length === 0, 'with Jarvis’s voice the screen reader was told too');
});

test('Settings › Accessibility has reading speed and amount, switch control and the screen choice, and the keys list names the new keys', async () => {
  await fresh({ a11y_mode: 'on', a11y_read_speed: 150 });
  const checked = await js(`[...document.querySelectorAll('#a11y-group [aria-label="Reading speed"] [role=radio]')].filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.textContent)`);
  assert(checked.join() === '150%', `reading speed shows ${checked}`);
  await js(`document.querySelector('#a11y-group [aria-label="How much of a long text to read"] [data-value=summary]').click(); document.querySelector('#a11y-group [aria-label="Send what is on my screen to the AI model"] [data-value=off]').click(); document.querySelector('#a11y-group [aria-label="Switch control for questions"] [data-value=one]').click(); true`);
  const s = await sent();
  for (const want of ['prefs {"a11y_read_verbosity":"summary"}', 'prefs {"a11y_screen_share":"off"}', 'prefs {"a11y_switch":"one"}']) assert(s.includes(want), `sent ${s}`);
  await chord('H');
  const text = await js(`document.querySelector('.sr-help').textContent`);
  assert(/\+W/.test(text) && /Stop talking and reading, from any app/.test(text) && /Switch: move to the next choice/.test(text), text);
});

function chosen() {
  const only = process.env.A11Y_TESTS ? new RegExp(process.env.A11Y_TESTS) : null;
  return tests.filter((t) => !only || only.test(t.name));
}

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const server = await serve();
  base = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({ show: false, width: 1280, height: 840, webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true } });
  win.webContents.debugger.attach('1.3');
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error' && !/Failed to load resource|WebSocket|ERR_NAME_NOT_RESOLVED|fonts\./.test(e.message)) errors.push(e.message); });
  let failed = 0;
  for (const t of chosen()) {
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
  console.log(`\n${chosen().length - failed} passed, ${failed} failed`);
  server.close();
  win.destroy();
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) { /* the OS clears temp */ }
  app.exit(failed ? 1 : 0);
});
