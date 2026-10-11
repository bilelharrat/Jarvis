// Eden Code's split view, its window helpers (web/features/code-split.js), what the right
// pane leaves to the main window (app.js), and its Chinese. node --test tests/web/
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sv = require('../../src/jarvis/web/features/code-split.js');
const WEB = fileURLToPath(new URL('../../src/jarvis/web/', import.meta.url));

test('the panes take a grid by their count: 1; 2 side by side; 3 in a row; 2×2; 3×2', () => {
  const big = [1800, 1000];
  assert.deepEqual(sv.gridFor(1, ...big), { cols: 1, rows: 1, one: false });
  assert.deepEqual(sv.gridFor(2, ...big), { cols: 2, rows: 1, one: false });
  assert.deepEqual(sv.gridFor(3, ...big), { cols: 3, rows: 1, one: false });
  assert.deepEqual(sv.gridFor(4, ...big), { cols: 2, rows: 2, one: false });
  assert.deepEqual(sv.gridFor(5, ...big), { cols: 3, rows: 2, one: false });
  assert.deepEqual(sv.gridFor(6, ...big), { cols: 3, rows: 2, one: false });
  // Never more than six; nothing to go by: one.
  assert.deepEqual(sv.gridFor(9, ...big), { cols: 3, rows: 2, one: false });
  assert.deepEqual(sv.gridFor(Number.NaN, ...big), { cols: 1, rows: 1, one: false });
});

test('a window too small for the grid takes fewer columns, then one pane at a time', () => {
  const { MIN_PANE: w, MIN_PANE_H: h, GAP: g } = sv;
  // Three columns need 3 × 380 + 2 gaps.
  assert.equal(sv.gridFor(3, 3 * w + 2 * g, 800).cols, 3);
  assert.deepEqual(sv.gridFor(3, 3 * w + 2 * g - 1, 800), { cols: 2, rows: 2, one: false });
  assert.deepEqual(sv.gridFor(6, 1000, 3 * h + 2 * g), { cols: 2, rows: 3, one: false });
  assert.deepEqual(sv.gridFor(6, 1000, 3 * h + 2 * g - 1), { cols: 1, rows: 1, one: true });
  // Two side by side, else one above the other, else one at a time.
  assert.deepEqual(sv.gridFor(2, 2 * w + g, 400), { cols: 2, rows: 1, one: false });
  assert.deepEqual(sv.gridFor(2, 2 * w + g - 1, 2 * h + g), { cols: 1, rows: 2, one: false });
  assert.deepEqual(sv.gridFor(2, 700, 2 * h + g - 1), { cols: 1, rows: 1, one: true });
  assert.deepEqual(sv.gridFor(4, 2 * w + g, 2 * h + g), { cols: 2, rows: 2, one: false });
  assert.deepEqual(sv.gridFor(4, 0, 0), { cols: 1, rows: 1, one: true });
  assert.equal(sv.gridFor(1, 10, 10).one, false);  // one pane is never "one at a time"
});

test('each pane gets its box; a fifth pane is wide, never a hole', () => {
  assert.deepEqual(sv.cells(5, 3), [
    { row: 0, col: 0, span: 1 }, { row: 0, col: 1, span: 1 }, { row: 0, col: 2, span: 1 },
    { row: 1, col: 0, span: 1 }, { row: 1, col: 1, span: 2 },
  ]);
  assert.deepEqual(sv.cells(3, 2).map((c) => c.span), [1, 1, 2]);
  assert.deepEqual(sv.cells(4, 2).map((c) => c.span), [1, 1, 1, 1]);
  const grid = sv.gridFor(5, 1300, 700);
  const boxes = sv.rects(5, grid, [], [], 1300, 700);
  assert.deepEqual(boxes[0], { x: 0, y: 0, w: 428, h: 346 });
  assert.deepEqual(boxes[2], { x: 872, y: 0, w: 428, h: 346 });
  assert.deepEqual(boxes[4], { x: 436, y: 354, w: 864, h: 346 });
  // Dragged shares; one pane at a time: every pane over the whole room.
  const two = sv.rects(2, sv.gridFor(2, 1008, 600), [0.25, 0.75], [], 1008, 600);
  assert.deepEqual(two.map((b) => [b.x, b.w]), [[0, 250], [258, 750]]);
  assert.deepEqual(sv.rects(3, { cols: 1, rows: 1, one: true }, [], [], 500, 400), Array(3).fill({ x: 0, y: 0, w: 500, h: 400 }));
});

test('the dividers: between columns as far down as panes meet, and between rows', () => {
  const d = sv.dividers(5, sv.gridFor(5, 1300, 700), [], [], 1300, 700);
  assert.deepEqual(d.map((x) => [x.kind, x.index, x.x, x.h]), [['col', 1, 428, 700], ['col', 2, 864, 346], ['row', 1, 0, 8]]);
  assert.deepEqual(sv.dividers(2, sv.gridFor(2, 1000, 600), [], [], 1000, 600).map((x) => x.kind), ['col']);
  assert.deepEqual(sv.dividers(4, sv.gridFor(4, 1000, 700), [], [], 1000, 700).map((x) => x.kind), ['col', 'row']);
  assert.deepEqual(sv.dividers(3, { cols: 1, rows: 1, one: true }, [], [], 500, 400), []);
  assert.deepEqual(sv.dividers(1, sv.gridFor(1, 500, 400), [], [], 500, 400), []);
});

test('sizes: kept shares add up to 1, each part keeps its room, a drag moves only its two', () => {
  assert.deepEqual(sv.cleanFracs([1, 3], 2), [0.25, 0.75]);
  assert.deepEqual(sv.cleanFracs([0.5, 0.5], 3), [1 / 3, 1 / 3, 1 / 3]);  // kept for another grid
  assert.deepEqual(sv.cleanFracs([0.5, -1], 2), [0.5, 0.5]);
  assert.deepEqual(sv.cleanFracs('0.4', 2), [0.5, 0.5]);
  // 1200 px for two: each at least 380 of the 1192.
  const [a, b] = sv.clampFracs([0.1, 0.9], 1200);
  assert.ok(Math.abs(a - 380 / 1192) < 1e-9 && Math.abs(a + b - 1) < 1e-9);
  assert.deepEqual(sv.clampFracs([0.3, 0.7], 500), [0.5, 0.5]);  // can't: equal
  assert.deepEqual(sv.clampFracs([0.5, 0.5], 1200), [0.5, 0.5]);
  const three = sv.clampFracs([0.02, 0.49, 0.49], 3000);
  assert.ok(three[0] * (3000 - 16) >= 379.99 && Math.abs(three.reduce((s, f) => s + f, 0) - 1) < 1e-9);
  // The divider before column 1 dragged to 600 px of 1008: the first takes 596/1000.
  const dragged = sv.dragFracs([0.5, 0.5], 1, 600, 1008);
  assert.ok(Math.abs(dragged[0] - 0.596) < 1e-9 && Math.abs(dragged[1] - 0.404) < 1e-9);
  assert.deepEqual(sv.dragFracs([0.5, 0.5], 1, 5, 1008).map((f) => Math.round(f * 1000)), [380, 620]);  // kept at 380 px
  const mid = sv.dragFracs([1 / 3, 1 / 3, 1 / 3], 2, 2000, 3016);
  assert.equal(mid[0], 1 / 3);  // the first column stays
  assert.deepEqual(sv.dragFracs([0.5, 0.5], 0, 600, 1008), [0.5, 0.5]);
});

test('a session dragged over lands on a pane, or by an edge in a new one', () => {
  const boxes = [{ x: 0, y: 0, w: 500, h: 400 }, { x: 508, y: 0, w: 500, h: 400 }];
  assert.deepEqual(sv.dropTarget(250, 200, boxes), { replace: 0 });
  assert.deepEqual(sv.dropTarget(20, 200, boxes), { add: 0, box: 0, side: 'left' });
  assert.deepEqual(sv.dropTarget(480, 200, boxes), { add: 1, box: 0, side: 'right' });
  assert.deepEqual(sv.dropTarget(990, 200, boxes), { add: 2, box: 1, side: 'right' });
  assert.equal(sv.dropTarget(504, 200, boxes), null);  // the divider
  assert.equal(sv.dropTarget(250, 500, boxes), null);
  // Six already: the edges show it there too.
  assert.deepEqual(sv.dropTarget(20, 200, boxes, 2), { replace: 0 });
  // No split yet: the left half opens it here, the right half beside.
  const one = [{ x: 0, y: 0, w: 1000, h: 400 }];
  assert.deepEqual(sv.dropTarget(400, 10, one), { replace: 0 });
  assert.deepEqual(sv.dropTarget(600, 10, one), { add: 1, box: 0, side: 'right' });
  assert.equal(sv.dropTarget(600, 10, null), null);
  assert.equal(sv.dropTarget(600, 10, [{ x: 0, y: 0, w: 0, h: 10 }]), null);
});

test('⌘⌥ and an arrow move the focus to the pane that way; one at a time, round', () => {
  const boxes = sv.rects(5, sv.gridFor(5, 1300, 700), [], [], 1300, 700);
  // 0 1 2
  // 3 [4 wide]
  assert.equal(sv.neighbor(boxes, 0, 'right'), 1);
  assert.equal(sv.neighbor(boxes, 1, 'right'), 2);
  assert.equal(sv.neighbor(boxes, 2, 'right'), 2);  // the edge: it stays
  assert.equal(sv.neighbor(boxes, 0, 'down'), 3);
  assert.equal(sv.neighbor(boxes, 2, 'down'), 4);
  assert.equal(sv.neighbor(boxes, 1, 'down'), 4);
  assert.equal(sv.neighbor(boxes, 4, 'up'), 1);  // the nearest above it
  assert.equal(sv.neighbor(boxes, 4, 'left'), 3);
  assert.equal(sv.neighbor(boxes, 3, 'up'), 0);
  assert.equal(sv.neighbor(boxes, 0, 'up'), 0);
  const flat = Array(3).fill({ x: 0, y: 0, w: 500, h: 400 });
  assert.equal(sv.neighbor(flat, 2, 'right', true), 0);
  assert.equal(sv.neighbor(flat, 0, 'left', true), 2);
  assert.equal(sv.neighbor(flat, 1, 'down', true), 2);
  assert.equal(sv.neighbor([boxes[0]], 0, 'right'), 0);
  assert.equal(sv.neighbor(boxes, 9, 'right'), 9);
});

test('what prefs kept is made safe, and the two-pane split of before comes in as its panes', () => {
  assert.deepEqual(sv.cleanState(undefined), { on: false, panes: [], own: 0, focus: 0, cols: [], rows: [], hub: '' });
  const now = { on: true, panes: [{ id: 3, key: 'k3' }, { id: 9, key: 'k9' }, { id: 4, key: 'k4' }], own: 1, focus: 2, cols: [0.2, 0.3, 0.5], rows: [1], hub: 'h1' };
  assert.deepEqual(sv.cleanState(now), now);
  // The old shape: { left, right, ratio, focus: 'left' | 'right' }.
  assert.deepEqual(sv.cleanState({ on: true, ratio: 0.66, focus: 'right', left: { id: 3, key: 'k3' }, right: { id: 9, key: 'k9' }, hub: 'h1' }),
    { on: true, panes: [{ id: 3, key: 'k3' }, { id: 9, key: 'k9' }], own: 0, focus: 1, cols: [0.66, 0.34], rows: [], hub: 'h1' });
  assert.deepEqual(sv.cleanState({ on: false, ratio: 0.3 }), { on: false, panes: [], own: 0, focus: 0, cols: [0.3, 0.7], rows: [], hub: '' });
  assert.deepEqual(sv.cleanState({ ratio: 9, left: { id: 1 } }).cols, [0.8, 0.2]);
  // Odd values.
  const odd = sv.cleanState({ on: 'yes', panes: [{ id: 1.5, key: 4 }, { id: -2, key: 'x'.repeat(65) }, 'x', { id: 2 ** 31, key: 'a\nb' }], own: 7, focus: -1, cols: [0.5, 'x'], rows: [Infinity], hub: 7 });
  assert.deepEqual(odd, { on: false, panes: Array(4).fill({ id: null, key: '' }), own: 0, focus: 0, cols: [], rows: [], hub: '' });
  // At most six panes; on needs two; shares at least 5% each, adding up to 1.
  const many = sv.cleanState({ on: true, panes: Array.from({ length: 9 }, (_, i) => ({ id: i + 1 })), focus: 5, own: 6 });
  assert.equal(many.panes.length, 6);
  assert.equal(many.focus, 5);
  assert.equal(many.own, 0);
  assert.equal(sv.cleanState({ on: true, panes: [{ id: 1 }] }).on, false);
  assert.deepEqual(sv.cleanState({ panes: [], cols: [0.01, 0.99] }).cols, [0.0481, 0.9519]);
  assert.deepEqual(sv.cleanState({ panes: [], cols: [0.2, 0.2, 0.2, 0.4] }).cols, []);  // three columns at most
  assert.equal(sv.cleanState([1, 2]).on, false);
});

test('a kept pane finds its session again: by its key, or by its number on the same backend', () => {
  const keys = { 4: 'aaa', 5: 'bbb' };
  const keyOf = (id) => keys[id] || '';
  assert.equal(sv.resolveSide({ id: 1, key: 'bbb' }, false, [4, 5], keyOf), 5);  // a restart numbered it anew
  assert.equal(sv.resolveSide({ id: 4, key: '' }, true, [4, 5], keyOf), 4);
  assert.equal(sv.resolveSide({ id: 4, key: '' }, false, [4, 5], keyOf), null);  // another backend's 4
  assert.equal(sv.resolveSide({ id: 4, key: 'gone' }, true, [4, 5], keyOf), 4);
  assert.equal(sv.resolveSide({ id: 8, key: 'gone' }, true, [4, 5], keyOf), null);
  assert.equal(sv.resolveSide(null, true, [4], keyOf), null);
});

test('the split is put back with the sessions still there, never one twice', () => {
  const live = new Set([1, 2, 3, 4]);
  const resolve = (p) => (live.has(p.id) ? p.id : null);
  const state = (panes, extra = {}) => sv.cleanState({ on: true, panes: panes.map((id) => ({ id })), ...extra });
  assert.deepEqual(sv.restorePanes(state([1, 2, 3], { own: 1, focus: 2 }), resolve, 9),
    { ok: true, panes: [{ id: 1, own: false }, { id: 2, own: true }, { id: 3, own: false }], focus: 2 });
  // A gone one is left out (the focus follows its pane), a gone own pane keeps the window's.
  assert.deepEqual(sv.restorePanes(state([1, 7, 3], { focus: 2 }), resolve, 9),
    { ok: true, panes: [{ id: 1, own: true }, { id: 3, own: false }], focus: 1 });
  assert.deepEqual(sv.restorePanes(state([7, 2], { own: 0 }), resolve, 4),
    { ok: true, panes: [{ id: 4, own: true }, { id: 2, own: false }], focus: 0 });
  // The window's session kept for another pane, or one kept twice: once.
  assert.deepEqual(sv.restorePanes(state([7, 2, 2, 3]), resolve, 2).panes, [{ id: 2, own: true }, { id: 3, own: false }]);
  // Fewer than two left, or kept off: no split.
  assert.deepEqual(sv.restorePanes(state([1, 7]), resolve, 1), { ok: false, panes: [], focus: 0 });
  assert.equal(sv.restorePanes(sv.cleanState({ on: false, panes: [{ id: 1 }, { id: 2 }] }), resolve, 1).ok, false);
});

test('/split reads its words', () => {
  assert.deepEqual(sv.splitCommand(''), { action: 'open' });
  assert.deepEqual(sv.splitCommand('  Close '), { action: 'close' });
  assert.deepEqual(sv.splitCommand('off'), { action: 'off' });
  assert.deepEqual(sv.splitCommand('exit'), { action: 'off' });
  assert.deepEqual(sv.splitCommand('swap'), { action: 'swap' });
  assert.deepEqual(sv.splitCommand('new'), { action: 'new' });
  assert.deepEqual(sv.splitCommand('auth refactor'), { action: 'find', query: 'auth refactor' });
});

test('/split <words> finds the session meant', () => {
  const tasks = [
    { id: 2, title: 'Fix the login page' },
    { id: 5, title: '', prompt: 'Add dark mode' },
    { id: 7, title: 'Login tests' },
    { id: 9, title: 'Docs' },
  ];
  assert.equal(sv.findSession(tasks, '#5'), 5);
  assert.equal(sv.findSession(tasks, '7'), 7);
  assert.equal(sv.findSession(tasks, 'docs'), 9);
  assert.equal(sv.findSession(tasks, 'login'), 7);  // the newest with it in its name
  assert.equal(sv.findSession(tasks, 'login', [7]), 2);
  assert.equal(sv.findSession(tasks, 'dark'), 5);
  assert.equal(sv.findSession(tasks, 'nothing like it'), null);
  assert.equal(sv.findSession(tasks, '   '), null);
});

test('an empty pane offers the latest sessions, not another pane’s nor archived ones', () => {
  const meta = { 1: { updated: '2026-10-01T10:00:00' }, 2: { updated: '2026-10-03T09:00:00' }, 3: { archived: true, updated: '2026-10-03T12:00:00' }, 4: {} };
  const metaOf = (id) => meta[id];
  const tasks = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
  assert.deepEqual(sv.pickable(tasks, 2, metaOf).map((t) => t.id), [1, 5, 4]);
  assert.deepEqual(sv.pickable(tasks, [2, 5], metaOf).map((t) => t.id), [1, 4]);
  assert.deepEqual(sv.pickable(tasks, null, metaOf).map((t) => t.id), [2, 1, 5, 4]);
});

test('a session asked for goes to the pane with the focus, and is never in two', () => {
  const ids = [3, 8, null, 5];  // the window's own pane is the first
  assert.deepEqual(sv.route(ids, 0, 0, 8), { focus: 1 });  // on show already: that pane takes the focus
  assert.equal(sv.route(ids, 0, 1, 3), null);  // the window's own: as without a split
  assert.equal(sv.route(ids, 0, 0, 6), null);
  assert.deepEqual(sv.route(ids, 0, 1, 6), { show: 1 });
  assert.deepEqual(sv.route(ids, 0, 2, 6), { show: 2 });  // the empty pane's pick
  assert.deepEqual(sv.route([8, 3], 1, 0, 6), { show: 0 });  // the window's own needn't be first
  assert.equal(sv.route(ids, 0, 1, null), null);
});

test('a pane that went by itself to another pane’s session: nothing shown twice', () => {
  const ids = [3, 8, 5];
  assert.equal(sv.afterChange(ids, 0, 1, 4, 8), null);
  assert.equal(sv.afterChange(ids, 0, 0, null, 3), null);
  // A frame goes back to the one it had, and the pane with it takes the focus.
  assert.deepEqual(sv.afterChange([3, 3, 5], 0, 1, 3, 8), { pane: 1, show: 8, focus: 0 });
  assert.deepEqual(sv.afterChange([3, 5, 5], 0, 1, 5, null), { close: 1, focus: 2 });
  // The window's own pane keeps it; the other pane gets the one it had, or closes.
  assert.deepEqual(sv.afterChange([8, 8, 5], 0, 0, 8, 3), { pane: 1, show: 3 });
  assert.deepEqual(sv.afterChange([8, 8, 5], 0, 0, 8, 5), { close: 1 });  // (5 is on show already)
  assert.deepEqual(sv.afterChange([5, 8, 5], 2, 2, 5, null), { close: 0 });
});

test('the pane without the focus says what’s waiting there', () => {
  assert.equal(sv.paneMark(1, true), 'needs');
  assert.equal(sv.paneMark(0, true), 'new');
  assert.equal(sv.paneMark(0, false), '');
});

test('the split’s keys: ⌘⇧\ adds a pane, ⌘⌥ and an arrow move, ⌘1…⌘6 pick; ⌘\ stays the sidebar’s', () => {
  assert.equal(sv.keyAction({ metaKey: true, shiftKey: true, key: '|', code: 'Backslash' }), 'split');
  assert.equal(sv.keyAction({ metaKey: true, shiftKey: true, key: '\\', code: 'IntlBackslash' }), 'split');
  assert.equal(sv.keyAction({ metaKey: true, key: '\\', code: 'Backslash' }), 'side');
  assert.equal(sv.keyAction({ metaKey: true, ctrlKey: true, key: '\\', code: 'Backslash' }), null);
  assert.equal(sv.keyAction({ metaKey: true, altKey: true, key: '\\', code: 'Backslash' }), null);  // Logbook's margin
  assert.equal(sv.keyAction({ shiftKey: true, key: '|', code: 'Backslash' }), null);
  assert.equal(sv.keyAction({ metaKey: true, shiftKey: true, key: 'b', code: 'KeyB' }), null);
  assert.equal(sv.keyAction({ metaKey: true, altKey: true, key: 'ArrowLeft' }), 'move-left');
  assert.equal(sv.keyAction({ metaKey: true, altKey: true, key: 'ArrowDown' }), 'move-down');
  assert.equal(sv.keyAction({ metaKey: true, key: 'ArrowLeft' }), null);  // the line's start, in a field
  assert.equal(sv.keyAction({ metaKey: true, altKey: true, shiftKey: true, key: 'ArrowUp' }), null);
  assert.equal(sv.keyAction({ metaKey: true, key: '3', code: 'Digit3' }), 'pane-3');
  assert.equal(sv.keyAction({ metaKey: true, key: '6', code: 'Numpad6' }), 'pane-6');
  assert.equal(sv.keyAction({ metaKey: true, key: '7', code: 'Digit7' }), null);
  assert.equal(sv.keyAction({ metaKey: true, shiftKey: true, key: '#', code: 'Digit3' }), null);
  assert.equal(sv.keyAction({ key: '3', code: 'Digit3' }), null);
});

// A frame pane is the same window in a frame: everything the hub asks of a window, the main
// window answers. A reply the pane could send (from app.js or an Eden Code module, the only ones
// it loads) would race the main window's, so each is held back there.
test('a frame pane never answers what the hub asks of the window', () => {
  const app = readFileSync(`${WEB}/app.js`, 'utf8');
  const set = (name) => new Set([...app.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]`))[1].matchAll(/'([\w-]+)'/g)].map((m) => m[1]));
  const quiet = set('SPLIT_PANE_QUIET');
  const skips = set('SPLIT_PANE_SKIPS');
  const paneScripts = readdirSync(`${WEB}/features`).filter((f) => /^(code[-_][\w-]*|loops)\.js$/.test(f));
  const sources = [app, ...paneScripts.map((f) => readFileSync(`${WEB}/features/${f}`, 'utf8'))].join('\n');
  const replies = [...sources.matchAll(/send\(\{ type: '(\w+_result|location_fix|code_voice_pointed|code_voice_hand)'/g)].map((m) => m[1]);
  assert.ok(replies.length >= 6);
  assert.deepEqual([...new Set(replies)].filter((type) => !quiet.has(type)), []);
  for (const ask of ['browser_cmd', 'research_cmd', 'pdf_cmd', 'location_request', 'cv_page_check', 'dm_render', 'vp_capture', 'code_voice_point', 'show_session', 'ui', 'alert']) {
    assert.ok(skips.has(ask), ask);
  }
  // And the frame loads only Eden Code's modules.
  const loader = readFileSync(`${WEB}/features.js`, 'utf8');
  assert.match(loader, /inSplitPane/);
});

test('every sentence split view shows has its Chinese', () => {
  const base = JSON.parse(readFileSync(`${WEB}/i18n-zh.json`, 'utf8'));
  const merged = { strings: { ...base.strings }, patterns: [...base.patterns] };
  for (const name of readdirSync(`${WEB}/i18n`).filter((f) => f.endsWith('.json')).sort()) {
    const data = JSON.parse(readFileSync(`${WEB}/i18n/${name}`, 'utf8'));
    Object.assign(merged.strings, data.strings || {});
    merged.patterns.push(...(data.patterns || []));
  }
  const patterns = merged.patterns.map(([p, r]) => [new RegExp(p), r]);
  const chinese = (text) => merged.strings[text] !== undefined || patterns.some(([re]) => re.test(text));
  const source = [`${WEB}/features/code-split.js`, `${WEB}/features/code-split/window.js`].map((f) => readFileSync(f, 'utf8')).join('\n');
  const shown = new Set([
    ...[...source.matchAll(/el\('[\w-]+', '[^']*', '([^']+)'\)/g)].map((m) => m[1]),
    ...[...source.matchAll(/(?:label|note|title|help): '([^']+)'/g)].map((m) => m[1]),
    ...[...source.matchAll(/jcNote\('([^']+)'\)/g)].map((m) => m[1]),
    ...[...source.matchAll(/'aria-label', '([^']+)'/g)].map((m) => m[1]),
    ...[...source.matchAll(/\.title = '([^']+)'/g)].map((m) => m[1]),
    ...[...source.matchAll(/button\('[\w-]+', '([^']+)'/g)].map((m) => m[1]),
    ...[...source.matchAll(/\? '([A-Z][^']+)' : '([A-Z][^']+)'/g)].flatMap((m) => [m[1], m[2]]),
    ...[...source.matchAll(/\[KEY, '([^']+)'\]|\['⌘[^']*', '([^']+)'\]/g)].map((m) => m[1] || m[2]),
    source.match(/const HELP = '([^']+)'/)[1],
    'Split view: add a pane', 'Split view: move between panes', 'Split view: go to a pane', 'New reply', 'Needs you',
    'Pick a session', 'No session open', 'No session matches “auth”.', 'Add a pane here', 'Show here', 'Open here', 'Open beside',
    'Split view holds up to 6 sessions.', 'Swap sides', 'Swap with the next pane', 'Panes', 'Split view pane',
  ]);
  assert.ok(shown.size > 35);
  assert.deepEqual([...shown].filter((s) => !chinese(s)), []);
  // Its fragment never changes a Chinese string the window already had.
  const own = JSON.parse(readFileSync(`${WEB}/i18n/code-split.json`, 'utf8')).strings;
  const before = { ...base.strings };
  for (const name of readdirSync(`${WEB}/i18n`).filter((f) => f.endsWith('.json') && f !== 'code-split.json')) Object.assign(before, JSON.parse(readFileSync(`${WEB}/i18n/${name}`, 'utf8')).strings || {});
  assert.deepEqual(Object.keys(own).filter((k) => k in before && before[k] !== own[k]), []);
});

test('a frame pane loads only what a pane needs: Eden Code’s modules and their stylesheets', () => {
  const loader = readFileSync(`${WEB}/features.js`, 'utf8');
  // (the stylesheets of modules that don't run in a pane are left out there)
  assert.match(loader, /skipped = new Set\(paneOnly \?/);
  assert.match(loader, /styles\.filter\(\(h\) => !skipped\.has\(stem\(h\)\)\)/);
  // The window's frames ask for Eden Code's own page when the window is Eden Code's.
  const machinery = readFileSync(`${WEB}/features/code-split/window.js`, 'utf8');
  assert.match(machinery, /params\.app = 'code'/);
  assert.match(machinery, /pane: 'code', bridge: '1'/);
});

test('one pane carries none of the machinery: it loads on the first split', () => {
  const doorway = readFileSync(`${WEB}/features/code-split.js`, 'utf8');
  const machinery = readFileSync(`${WEB}/features/code-split/window.js`, 'utf8');
  assert.match(doorway, /window\.js/);
  assert.match(doorway, /window\.css/);
  for (const part of ['makePane', 'drawDividers', 'renderTabs', "el('iframe'"]) {
    assert.ok(machinery.includes(part), part);
    assert.ok(!doorway.includes(part), part);
  }
  // (features/*.js only: the folder is never listed by /features.json)
  assert.ok(!readdirSync(`${WEB}/features`).includes('window.js'));
  assert.ok(doorway.length < 30000, `${doorway.length} bytes`);
});

test('split view is on for everyone: not a Lab', () => {
  const labs = readFileSync(`${WEB}/features/labs.js`, 'utf8');
  assert.ok(!labs.includes("'code_split'"));
  assert.match(labs, /features\.labs\.filter/);  // (a kept "code_split" is ignored)
  const zh = JSON.parse(readFileSync(`${WEB}/i18n/labs.json`, 'utf8')).strings;
  assert.ok(!Object.keys(zh).some((k) => k.startsWith('Two live sessions')));
});
