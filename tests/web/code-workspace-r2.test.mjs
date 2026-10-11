// Round 2 fixes for Eden Code's workspace and split view (askeden/docs/bug-sweep/
// r2-eden-code-workspace.md, CF2-1…CF2-13). node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const WEB = fileURLToPath(new URL('../../src/jarvis/web', import.meta.url));
const B = require('../../src/jarvis/web/features/code-bridge.js');
const E = require('../../src/jarvis/web/features/code-editor.js');
const sv = require('../../src/jarvis/web/features/code-split.js');

// The bridge as the window runs it: a fake jarvisFeatures (its store, its event bus, its
// socket) and frames that record what they're posted.
function windowWithBridge() {
  const listeners = [];
  const sent = [];
  const onMessage = [];
  const ctx = {
    location: { origin: 'http://127.0.0.1:1' },
    addEventListener: (type, fn) => { if (type === 'message') onMessage.push(fn); },
    jarvisFeatures: {
      store: { catchUp: () => [] },
      on: (type, fn) => listeners.push([type, fn]),
      $: () => null,
      send: (msg) => { sent.push(msg); return true; },
    },
  };
  ctx.window = ctx;
  vm.runInNewContext(readFileSync(`${WEB}/features/code-bridge.js`, 'utf8'), ctx);
  const frame = (name) => {
    const got = [];
    const win = { name, postMessage: (data) => got.push(data) };
    ctx.jarvisCodeStore.attachFrame({ contentWindow: win });
    const say = (data) => onMessage.forEach((fn) => fn({ origin: ctx.location.origin, source: win, data }));
    say({ jarvisBridge: 'ready' });
    return { win, got, events: () => got.filter((d) => d.jarvisBridge === 'event').map((d) => d.event), send: (msg) => say({ jarvisBridge: 'send', msg }) };
  };
  const hear = (ev) => { for (const [type, fn] of listeners) if (type === '*' || type === ev.type) fn(ev); };
  return { frame, hear, sent };
}

test('CF2-1: an answer goes to the pane that asked only, with the ref it gave', () => {
  const w = windowWithBridge();
  const a = w.frame('A');
  const b = w.frame('B');
  // Both panes have the same file open: the same editor key.
  const key = 'task:/proj\nshared.txt';
  a.send({ type: 'cw_file_save', path: 'shared.txt', text: 'A', ref: key });
  b.send({ type: 'cw_file_read', path: 'shared.txt', ref: key });
  const [upA, upB] = w.sent;
  assert.notEqual(upA.ref, upB.ref);  // marked with each pane's own number
  assert.ok(upA.ref.endsWith(key) && upB.ref.endsWith(key));
  // The hub answers A's save (to this window: emit_to_caller).
  w.hear({ type: 'cw_file_saved', ref: upA.ref, ok: true, version: { sha: 'new' } });
  assert.deepEqual(a.events().map((e) => [e.type, e.ref]), [['cw_file_saved', key]]);
  assert.deepEqual(b.events(), []);  // B never takes A's "Saved." for its own
  // The window's own answer (an unmarked ref) is no frame's: not copied into each.
  w.hear({ type: 'cw_file', ref: key, text: 'x'.repeat(1000) });
  assert.equal(a.events().length + b.events().length, 1);
  // Everything else still goes to every pane, as before.
  w.hear({ type: 'tasks', items: [] });
  w.hear({ type: 'cw_terms', folder: '/proj', items: [] });  // (a listing for all: no ref)
  assert.deepEqual(b.events().map((e) => e.type), ['tasks', 'cw_terms']);
  assert.deepEqual(a.events().map((e) => e.type), ['cw_file_saved', 'tasks', 'cw_terms']);
});

test('CF2-1: "!" commands, exports and searches come back to their pane; other refs go up as they are', () => {
  const w = windowWithBridge();
  const a = w.frame('A');
  const b = w.frame('B');
  a.send({ type: 'task_bash', id: 1, command: 'echo A', ref: 'pa-b1' });
  b.send({ type: 'task_bash', id: 2, command: 'echo B', ref: 'pa-b1' });
  w.hear({ type: 'cw_bang_start', ref: w.sent[1].ref });
  w.hear({ type: 'task_bash', ref: w.sent[0].ref, output: 'A', code: 0 });
  assert.deepEqual(a.events().map((e) => [e.type, e.ref, e.output]), [['task_bash', 'pa-b1', 'A']]);
  assert.deepEqual(b.events().map((e) => [e.type, e.ref]), [['cw_bang_start', 'pa-b1']]);
  b.send({ type: 'cw_bang_cancel', ref: 'pa-b1' });  // cancels B's own run, not A's
  assert.equal(w.sent[2].ref, w.sent[1].ref);
  // A model's ref, a memory note's ref: not a request id, never marked.
  a.send({ type: 'task_model', id: 1, ref: 'custom:x' });
  a.send({ type: 'cw_memory_save', ref: 'm1', target: 'project' });
  assert.deepEqual(w.sent.slice(3).map((m) => m.ref), ['custom:x', 'm1']);
});

test('CF2-1: the bridge\'s marks, pure', () => {
  assert.deepEqual(B.marked({ type: 'cw_search', ref: 'p-s1' }, 3), { type: 'cw_search', ref: '~sv3~p-s1' });
  assert.deepEqual(B.marked({ type: 'cw_search', ref: '' }, 3), { type: 'cw_search', ref: '' });
  assert.deepEqual(B.routeOf({ type: 'cw_search', ref: '~sv12~p-s1', total: 0 }), { pane: 12, event: { type: 'cw_search', ref: 'p-s1', total: 0 } });
  assert.equal(B.routeOf({ type: 'cw_export', ref: 'p-x1' }), null);
  assert.deepEqual(B.routeOf({ type: 'code_btw', ref: 'b1' }).pane, 0);
  // (a frame's refs fit the hub's caps: 40 characters for "!" commands, exports, searches)
  assert.ok(B.marked({ type: 'task_bash', ref: 'abcdefgh-b123' }, 999).ref.length <= 40);
  for (const ask of B.ASKS) assert.ok(/^(cw_|task_bash$)/.test(ask));
});

test('CF2-1: the editor\'s refs are its page\'s own, like search\'s', () => {
  const key = 'task:/proj\nshared.txt';
  assert.equal(E.keyOfRef('pageA', E.refOf('pageA', key)), key);
  assert.equal(E.keyOfRef('pageB', E.refOf('pageA', key)), null);  // another pane's answer
  assert.equal(E.keyOfRef('pageA', key), null);  // an unmarked one (an older window's)
  assert.equal(E.keyOfRef('pageA', undefined), null);
  const src = readFileSync(`${WEB}/features/code-editor.js`, 'utf8');
  assert.ok(!/ref: doc\.key\b/.test(src), 'every editor command carries the page-marked ref');
});

test('CF2-10: an export\'s ref is its page\'s own', () => {
  const src = readFileSync(`${WEB}/features/code-export.js`, 'utf8');
  assert.match(src, /const ref = `\$\{PAGE\}-x\$\{\+\+refN\}`/);
  assert.match(src, /const PAGE = Math\.random\(\)/);
});

test('CF2-11: the big-file view never cuts an emoji, a flag, a joined emoji or an accent in two', () => {
  const rowsOf = (text, max) => { const r = E.viewRows(text, max); return r.start.map((s, i) => text.slice(s, r.end[i])); };
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const emoji = `${'x'.repeat(1999)}😀${'y'.repeat(10)}`;
  const rows = rowsOf(emoji);
  assert.equal(rows.join(''), emoji);
  assert.ok(rows.every((r) => !lone.test(r)), 'no row starts or ends with half an emoji');
  assert.equal(rows[1].slice(0, 2), '😀');
  const flags = `${'x'.repeat(1997)}🇫🇷🇩🇪`;
  assert.deepEqual(rowsOf(flags).slice(1), ['🇫🇷🇩🇪']);
  const joined = `${'x'.repeat(1998)}\u{1F469}\u200D\u{1F4BB}abc`;
  assert.deepEqual(rowsOf(joined).slice(1), ['\u{1F469}\u200D\u{1F4BB}abc']);
  const accent = `${'x'.repeat(1999)}ézz`;
  assert.equal(rowsOf(accent)[1], 'ézz');
  // A long run of emoji: every cut between two of them, nothing lost.
  const many = '🎉'.repeat(3001);
  const cut = rowsOf(many);
  assert.equal(cut.join(''), many);
  assert.ok(cut.every((r) => !lone.test(r)));
  // Plain text cuts where it always did, and the line count comes with the rows.
  assert.deepEqual(E.viewRows('a'.repeat(4500)).end, [2000, 4000, 4500]);
  assert.equal(E.viewRows('a\nb\nc').lines, 3);
});

test('CF2-7: ⌘1–6 are the browser\'s tabs while it\'s open, from a frame pane too', () => {
  assert.equal(sv.keyTarget('pane-3', false, false), 'pane-3');
  assert.equal(sv.keyTarget('pane-3', true, false), 'browser-tab3');
  assert.equal(sv.keyTarget('pane-3', true, true), null);  // a field keeps them, as in the window's own pane
  assert.equal(sv.keyTarget('move-left', true, false), 'move-left');
  assert.equal(sv.keyTarget('split', true, true), 'split');
  const machinery = readFileSync(`${WEB}/features/code-split/window.js`, 'utf8');
  assert.match(machinery, /key\(m\.key, !!m\.typing\)/);
});

test('split view\'s lazily loaded files carry the doorway\'s ?v= stamp', () => {
  const src = readFileSync(`${WEB}/features/code-split.js`, 'utf8');
  assert.match(src, /\$\{base\}window\.js\$\{stamp\}/);
  assert.match(src, /\$\{base\}window\.css\$\{stamp\}/);
});

// The rules for one selector in a stylesheet, as one string of declarations.
function rulesFor(css, selector) {
  const out = [];
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) if (m[1].trim() === selector) out.push(m[2]);
  return out.join(';');
}

test('CF2-3: Eden Code\'s notice stack sets every side, and its gaps let clicks through', () => {
  const eden = readFileSync(`${WEB}/eden-code.css`, 'utf8');
  const decl = rulesFor(eden, 'body.eden-code:not(.jc-split-pane):has(> #cc:not([hidden])) #cards');
  for (const side of ['top', 'right', 'bottom', 'left', 'width', 'max-height']) assert.match(decl, new RegExp(`(^|;)\\s*${side}:`), side);
  assert.match(decl, /left: auto/);
  assert.match(decl, /bottom: auto/);
  const app = readFileSync(`${WEB}/app.css`, 'utf8');
  assert.match(rulesFor(app, '.cards'), /pointer-events: none/);
  assert.match(rulesFor(app, '.cards > *'), /pointer-events: auto/);
});

test('CF2-6: a switcher tab keeps room for its name; its mark is a dot', () => {
  const css = readFileSync(`${WEB}/features/code-split/window.css`, 'utf8');
  const tab = rulesFor(css, '.sv-tab');
  assert.match(tab, /min-width: 72px/);
  assert.match(tab, /overflow: hidden/);
  assert.match(rulesFor(css, '.sv-tab .sv-mark'), /font-size: 0/);
});
