// Eden Code's shell, round 3 (askeden/docs/bug-sweep/r3-eden-code-shell.md, "Fixes (round 3)"): Esc closes the
// topmost layer first (CH3-2), Settings never opens over the Eden Code settings sheet (CH3-3), commands that need no
// project work before one (CH3-6), the sheet's tabs are a keyboard tablist (CH3-7), the intro's sound card is
// translated (CH3-8), the effort slider shows the keyboard's place (CH3-12), and the page's lighter loads (Settings'
// asks coalesced, galaxy.js left out of Eden Code). The pieces of app.js run on small stand-ins. node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const web = (name) => readFileSync(new URL(`../../src/jarvis/web/${name}`, import.meta.url), 'utf8');
const APP = web('app.js');

// The text from `start` up to (not including) `end`, after `from`.
function slice(text, start, end, from = 0) {
  const a = text.indexOf(start, from);
  const b = text.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `${start} … ${end}`);
  return text.slice(a, b);
}

// ── CH3-2: Esc ──

function escapeBlock() {
  // the global handler's Escape branch, as a function of the key event and what it has worked out
  const body = slice(APP, "  if (e.key === 'Escape') {\n    if (field && !srMode()) e.target.blur();", '  } else if (!typing && galaxyMode');
  return `(function (e, field, typing) {${body}}})`;
}
function escWorld({ settings = false, accounts = false, browser = false, cc = true, busy = false } = {}) {
  const did = [];
  const nodes = { settings: { hidden: !settings }, accounts: { hidden: !accounts }, browser: { hidden: !browser }, cc: { hidden: !cc } };
  const ctx = {
    $: (id) => nodes[id],
    srMode: () => false,
    galaxyMode: 'off',
    state: 'idle',
    toggleAccounts: (on) => did.push(['accounts', on]),
    toggleSettings: (on) => did.push(['settings', on]),
    toggleBrowser: (on) => did.push(['browser', on]),
    toggleCC: (on) => did.push(['cc', on]),
    toggleDrawer: (on) => did.push(['drawer', on]),
    setGalaxyMode: (m) => did.push(['galaxy', m]),
    send: (msg) => did.push(['send', msg.type]),
    // Eden Code's own Esc (jcEscape): it would interrupt a busy session or close the pane
    jcEscape: () => { did.push([busy ? 'task_interrupt' : 'closePane']); return true; },
  };
  const run = vm.runInNewContext(escapeBlock(), ctx);
  return { did, press: (target = { blur() {} }, field = false) => run({ key: 'Escape', target }, field, field) };
}

test('Esc with Settings open over Eden Code closes Settings, and never interrupts the session or closes a pane (CH3-2)', () => {
  const busy = escWorld({ settings: true, cc: true, busy: true });
  busy.press();
  assert.deepEqual(busy.did, [['settings', false]]); // (before: task_interrupt, and Settings stayed open)
  const pane = escWorld({ settings: true, cc: true });
  pane.press({ blur() {} }, true); // from Settings' search field
  assert.deepEqual(pane.did, [['settings', false]]); // (before: the Terminal pane behind it closed)
  const accounts = escWorld({ accounts: true, settings: true, cc: true });
  accounts.press();
  assert.deepEqual(accounts.did, [['accounts', false]]);
  // over the browser too (Settings is modal over everything)
  const browser = escWorld({ settings: true, browser: true, cc: false });
  browser.press();
  assert.deepEqual(browser.did, [['settings', false]]);
  // with nothing over it, Eden Code's own Esc as before
  const plain = escWorld({ cc: true, busy: true });
  plain.press();
  assert.deepEqual(plain.did, [['task_interrupt']]);
});

// ── CH3-3 and Settings' asks ──

function settingsWorld({ sheetOpen = false, online = true } = {}) {
  const sent = [];
  const order = [];
  const node = (extra = {}) => ({ hidden: true, value: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, ...extra });
  const nodes = { settings: node(), 'settings-btn': node(), 'settings-search': node(), 'jc-settings': node({ hidden: !sheetOpen }) };
  let now = 1_000_000;
  const ctx = {
    $: (id) => nodes[id],
    send: (msg) => { sent.push(msg.type); return online; },
    filterSettings: () => {},
    closeJcSettings: () => { order.push(['close sheet', nodes.settings.hidden]); nodes['jc-settings'].hidden = true; },
    Date: { now: () => now },
  };
  const consts = slice(APP, 'const SETTINGS_FRESH_MS', '\n');
  vm.runInNewContext(`${consts}\n${slice(APP, 'function toggleSettings(open) {', '\n// ── search in Settings ──')}; this.toggleSettings = toggleSettings;`, ctx);
  return { nodes, sent, order, toggle: ctx.toggleSettings, later: (ms) => { now += ms; } };
}

test('⌘, (or anything opening Settings) over the Eden Code settings sheet closes the sheet first: never two inert layers (CH3-3)', () => {
  const w = settingsWorld({ sheetOpen: true });
  w.toggle(true);
  assert.deepEqual(w.order, [['close sheet', true]]); // closed (its inert set undone) before Settings shows
  assert.equal(w.nodes['jc-settings'].hidden, true);
  assert.equal(w.nodes.settings.hidden, false);
  // closing Settings never touches the sheet
  const shut = settingsWorld({ sheetOpen: false });
  shut.toggle(false);
  assert.deepEqual(shut.order, []);
  // Eden Code's ⌘, goes through toggleSettings; the sheet's own close undoes its inert set
  assert.match(APP, /if \(cmd\(e\) && !e\.shiftKey && !e\.altKey && e\.key === ','\) \{ e\.preventDefault\(\); toggleSettings\(\$\('settings'\)\.hidden\); \}/);
  assert.match(slice(APP, 'function closeJcSettings() {', '\n}\n'), /jcsModal\(false\);/);
});

test('Settings asks for what it shows once in 30 s, not on every open (and again once a send has failed)', () => {
  const w = settingsWorld();
  w.toggle(true);
  assert.deepEqual(w.sent, ['shortcuts', 'phone_status', 'providers_list']);
  w.toggle(false);
  w.later(5_000);
  w.toggle(true);
  assert.equal(w.sent.length, 3); // (before: three more each time, and two from features: five per open)
  w.later(31_000);
  w.toggle(true);
  assert.equal(w.sent.length, 6);
  const offline = settingsWorld({ online: false });
  offline.toggle(true);
  offline.toggle(true);
  assert.equal(offline.sent.length, 6); // nothing went: asked again next time
  for (const [file, ask] of [['features/companion.js', 'companion'], ['features/account.js', 'account']]) {
    const src = web(file);
    assert.match(src, /Date\.now\(\) - askedAt < 30_000\) return;/, file);
    assert.match(src, new RegExp(`if \\(send\\(\\{ type: '${ask}' \\}\\) !== false\\) askedAt = Date\\.now\\(\\);`), file);
  }
});

// ── CH3-6: / commands before any project ──

function noProject() {
  const block = slice(APP, '    if (!deckProject) {\n', "    if (text.startsWith('/') && !images.length && slashWithoutSession(text)) return true;");
  const did = [];
  const ctx = {
    deckProject: '',
    SLASH_WITHOUT_PROJECT: null,
    slashWithoutSession: (text) => { did.push(['slash', text]); return !text.startsWith('/model '); },
    jcNote: (text) => did.push(['note', text]),
  };
  vm.runInNewContext(`${slice(APP, 'const SLASH_WITHOUT_PROJECT', '\n')}; this.SLASH_WITHOUT_PROJECT = SLASH_WITHOUT_PROJECT; this.run = function (text, images) {\n${block}  return 'on';\n};`, ctx);
  return { did, run: (text, images = []) => ctx.run(text, images) };
}

test('with no project yet, /settings, /help and the like work, and the rest say why nothing happened (CH3-6)', () => {
  for (const text of ['/settings', '/help', '/config', '/effort high', '/ultracode', '/model', '/SETTINGS']) {
    const w = noProject();
    assert.equal(w.run(text), true, text); // handled: the composer clears (before: false, nothing at all)
    assert.deepEqual(w.did, [['slash', text]], text);
  }
  for (const text of ['/files', '/terminal', '/memory', '/plan add a cache', '/model opus']) {
    const w = noProject();
    assert.equal(w.run(text), false, text); // kept in the composer…
    assert.deepEqual(w.did.at(-1), ['note', 'Pick a project first.'], text); // …and said why
  }
  const plain = noProject();
  assert.equal(plain.run('fix the build'), false);
  assert.deepEqual(plain.did, []);
  assert.equal(noProject().run('/settings', [{}]), false); // (with a picture: as before)
  // the note is one Chinese already has
  assert.match(web('i18n-zh.json'), /"Pick a project first\.": "/);
});

// ── CH3-7: the sheet's tabs ──

function tabsWorld() {
  const nodes = {};
  const mk = (id, extra = {}) => (nodes[id] = { id, hidden: false, attrs: {}, tabIndex: 0, setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; }, ...extra });
  const tabs = ['general', 'models', 'limits', 'machines', 'projects', 'snippets'].map((tab) => {
    const panel = mk(`jcs-${tab}`);
    panel.hidden = tab !== 'general';
    const b = { tab, id: '', hidden: false, tabIndex: 0, attrs: {}, dataset: { tab }, setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; } };
    b.click = () => ctx.selectJcsTab(tab);
    b.focus = () => { ctx.focused = b; };
    return b;
  });
  let keydown = null;
  const nav = { querySelectorAll: () => tabs, addEventListener: (ev, fn) => { if (ev === 'keydown') keydown = fn; } };
  const ctx = {
    $: (id) => nodes[id] || null,
    document: { querySelectorAll: () => tabs, querySelector: () => nav },
    checkGeminiOnce: () => {},
    focused: null,
  };
  vm.runInNewContext(`${slice(APP, 'function selectJcsTab(tab) {', '\n// A Gemini key')}; this.selectJcsTab = selectJcsTab;
${slice(APP, "document.querySelector('.jcs-tabs').addEventListener('keydown'", '\n});\n')}\n});`, ctx);
  const press = (target, key) => {
    let prevented = false;
    keydown({ key, target, currentTarget: nav, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  return { tabs, nodes, ctx, press };
}

test('the Eden Code settings sheet’s tabs are a tablist: one Tab stop, the arrow keys, Home and End, each tab and panel naming the other (CH3-7)', () => {
  const { tabs, nodes, ctx, press } = tabsWorld();
  ctx.selectJcsTab('general');
  assert.deepEqual(tabs.map((b) => b.tabIndex), [0, -1, -1, -1, -1, -1]);
  for (const b of tabs) {
    assert.equal(b.attrs['aria-controls'], `jcs-${b.tab}`);
    assert.equal(nodes[`jcs-${b.tab}`].attrs['aria-labelledby'], `jcs-tab-${b.tab}`);
    assert.equal(b.id, `jcs-tab-${b.tab}`);
  }
  assert.equal(press(tabs[0], 'ArrowRight'), true);
  assert.equal(ctx.focused, tabs[1]);
  assert.equal(tabs[1].attrs['aria-selected'], 'true');
  assert.deepEqual(tabs.map((b) => b.tabIndex), [-1, 0, -1, -1, -1, -1]);
  press(tabs[1], 'End');
  assert.equal(ctx.focused, tabs[5]);
  press(tabs[5], 'ArrowRight'); // wraps
  assert.equal(ctx.focused, tabs[0]);
  press(tabs[0], 'ArrowLeft');
  assert.equal(ctx.focused, tabs[5]);
  press(tabs[5], 'Home');
  assert.equal(ctx.focused, tabs[0]);
  assert.equal(press(tabs[0], 'Enter'), false); // other keys are the button's own
  assert.equal(press(tabs[0], 'a'), false);
  // the features' tabs have their panel under the id selectJcsTab ties them by
  assert.match(web('features/code-sessions.js'), /panel\.id = `jcs-\$\{id\}`;/);
  assert.match(web('features/code-usage.js'), /panel\.id = 'jcs-limits';/);
  assert.match(web('features/code-handoff.js'), /panel\.id = 'jcs-machines';/);
  const html = web('index.html');
  assert.match(html, /<nav class="jcs-tabs" role="tablist" aria-label="Settings sections">/);
  assert.match(html, /id="jcs-general" role="tabpanel"/);
  assert.match(html, /id="jcs-models" role="tabpanel"/);
});

// ── CH3-8, CH3-12 ──

test('the intro’s Boot-up sound choices are translated: only the language card’s names stay as written (CH3-8)', () => {
  const intro = web('features/intro.js');
  const card = slice(intro, "if (id === 'sound') {", "if (id === ");
  assert.doesNotMatch(card, /data\(el\(/); // (before: data-no-i18n on On/Off and their lines)
  assert.match(card, /b\.append\(el\('strong', '', name\), el\('small', '', sub\)\);/);
  const zh = JSON.parse(web('i18n/intro.json'));
  const strings = zh.strings || zh;
  for (const s of ['On', 'Off', 'A short sound as the app opens', 'Opens quietly']) assert.ok(strings[s], s);
});

test('the effort slider shows where the keyboard is (CH3-12)', () => {
  assert.match(web('app.css'), /\.jc-slider:has\(input:focus-visible\) \{ outline: 2px solid var\(--action\); outline-offset: 2px; \}/);
});

// ── galaxy.js left out of Eden Code's page ──

test('without galaxy.js (Eden Code’s page) app.js has a stand-in galaxy that does nothing and has no stars', () => {
  const line = slice(APP, 'const galaxy = window.Galaxy ?', '\ngalaxy.onSelect');
  const ctx = { window: {}, $: () => null };
  vm.runInNewContext(`${line}; this.galaxy = galaxy;`, ctx);
  const g = ctx.galaxy;
  assert.deepEqual([g.nodes.length, g.running, g.interactive], [0, false, false]);
  assert.deepEqual({ ...g.counts() }, {});
  for (const call of ['setData', 'highlight', 'flyTo', 'start', 'stop', 'reset', 'resize', 'setVisible', 'select', 'hoverAtClient', 'pickAtClient']) {
    assert.equal(typeof g[call], 'function', call);
    assert.doesNotThrow(() => g[call]([], 1), call);
  }
  g.interactive = true;
  g.onSelect = () => {};
  assert.equal(g.interactive, true);
  // Eden's own page still makes the real one
  const real = { window: { Galaxy: class { constructor(c) { this.canvas = c; this.real = true; } } }, $: () => 'canvas' };
  vm.runInNewContext(`${line}; this.galaxy = galaxy;`, real);
  assert.equal(real.galaxy.real, true);
});
