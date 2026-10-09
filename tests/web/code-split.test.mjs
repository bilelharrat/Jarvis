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

test('the divider keeps each pane wide enough, and half and half when it can’t', () => {
  assert.equal(sv.clampRatio(0.5, 1200), 0.5);
  // 1200 px: a pane needs 380 of the 1192 between the sidebar and the edge.
  assert.equal(sv.clampRatio(0.1, 1200), 380 / 1192);
  assert.equal(sv.clampRatio(0.95, 1200), 1 - 380 / 1192);
  // Wide: the share never goes past 20%–80%.
  assert.equal(sv.clampRatio(0.05, 4000), sv.RATIO_MIN);
  assert.equal(sv.clampRatio(0.99, 4000), sv.RATIO_MAX);
  // Too narrow for two, or nothing to go by.
  assert.equal(sv.clampRatio(0.3, 500), 0.5);
  assert.equal(sv.clampRatio(Number.NaN, 1200), 0.5);
  assert.equal(sv.clampRatio('0.4', 1200), 0.4);
  assert.equal(sv.clampRatio(0.7, Number.NaN), 0.7);
});

test('a window too narrow for two shows one pane at a time', () => {
  assert.equal(sv.narrow(2 * sv.MIN_PANE + sv.GAP), false);
  assert.equal(sv.narrow(2 * sv.MIN_PANE + sv.GAP - 1), true);
  assert.equal(sv.narrow(0), true);
  assert.equal(sv.narrow(Number.NaN), true);
});

test('the divider follows the pointer, and a dragged session lands in a half', () => {
  assert.equal(sv.ratioAt(284 + 4 + 500, 284, 1008), 0.5);
  assert.equal(sv.ratioAt(284 + 4, 284, 1008), 0);
  assert.equal(sv.ratioAt(10, 0, 0), 0.5);
  const box = { left: 284, top: 0, width: 1000, height: 800 };
  assert.equal(sv.dropSide(300, 400, box), 'left');
  assert.equal(sv.dropSide(783, 400, box), 'left');
  assert.equal(sv.dropSide(784, 400, box), 'right');
  assert.equal(sv.dropSide(1284, 10, box), 'right');
  assert.equal(sv.dropSide(200, 400, box), null);  // over the sidebar
  assert.equal(sv.dropSide(900, 900, box), null);
  assert.equal(sv.dropSide(900, 10, null), null);
  assert.equal(sv.dropSide(900, 10, { left: 0, top: 0, width: 0, height: 10 }), null);
});

test('what prefs kept is made safe before it’s used', () => {
  assert.deepEqual(sv.cleanState(undefined), { on: false, ratio: 0.5, focus: 'left', left: { id: null, key: '' }, right: { id: null, key: '' }, hub: '' });
  assert.deepEqual(sv.cleanState({ on: true, ratio: 0.66, focus: 'right', left: { id: 3, key: 'k3' }, right: { id: 9, key: 'k9' }, hub: 'h1' }),
    { on: true, ratio: 0.66, focus: 'right', left: { id: 3, key: 'k3' }, right: { id: 9, key: 'k9' }, hub: 'h1' });
  const odd = sv.cleanState({ on: 'yes', ratio: 9, focus: 'up', left: { id: 1.5, key: 4 }, right: { id: -2, key: 'x'.repeat(65) }, hub: 7 });
  assert.deepEqual(odd, { on: false, ratio: sv.RATIO_MAX, focus: 'left', left: { id: null, key: '' }, right: { id: null, key: '' }, hub: '' });
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

test('/split reads its words', () => {
  assert.deepEqual(sv.splitCommand(''), { action: 'open' });
  assert.deepEqual(sv.splitCommand('  Close '), { action: 'close' });
  assert.deepEqual(sv.splitCommand('off'), { action: 'close' });
  assert.deepEqual(sv.splitCommand('swap'), { action: 'swap' });
  assert.deepEqual(sv.splitCommand('new'), { action: 'new' });
  assert.deepEqual(sv.splitCommand('auth refactor'), { action: 'find', query: 'auth refactor' });
});

test('/split <words> finds the session meant, never one already in a pane', () => {
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

test('an empty pane offers the latest sessions, not the other pane’s nor archived ones', () => {
  const meta = { 1: { updated: '2026-10-01T10:00:00' }, 2: { updated: '2026-10-03T09:00:00' }, 3: { archived: true, updated: '2026-10-03T12:00:00' }, 4: {} };
  const metaOf = (id) => meta[id];
  const tasks = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
  assert.deepEqual(sv.pickable(tasks, 2, metaOf).map((t) => t.id), [1, 5, 4]);
  assert.deepEqual(sv.pickable(tasks, null, metaOf).map((t) => t.id), [2, 1, 5, 4]);
});

test('a session asked for goes to the pane with the focus, and is never in both', () => {
  const s = { left: 3, right: 8, focus: 'left' };
  assert.equal(sv.route(s, 8), 'focus-right');  // already beside: that pane takes the focus
  assert.equal(sv.route(s, 3), 'left');
  assert.equal(sv.route(s, 5), 'left');
  assert.equal(sv.route({ ...s, focus: 'right' }, 5), 'right');
  assert.equal(sv.route({ ...s, focus: 'right' }, 3), 'left');
  assert.equal(sv.route({ ...s, right: null, focus: 'right' }, 5), 'right');  // the empty pane's pick
  assert.equal(sv.route(s, null), 'left');
  // A pane that went by itself to the other pane's session goes back, or the split closes.
  assert.equal(sv.afterChange({ left: 3, right: 8 }, 'right', 4, 8), null);
  assert.deepEqual(sv.afterChange({ left: 3, right: 8 }, 'right', 3, 8), { side: 'right', show: 8 });
  assert.deepEqual(sv.afterChange({ left: 3, right: 8 }, 'left', 8, 3), { side: 'left', show: 3 });
  assert.deepEqual(sv.afterChange({ left: 3, right: 8 }, 'right', 3, null), { close: true });
  assert.equal(sv.afterChange({ left: 3, right: null }, 'left', null, 3), null);
});

test('the pane without the focus says what’s waiting there', () => {
  assert.equal(sv.paneMark(1, true), 'needs');
  assert.equal(sv.paneMark(0, true), 'new');
  assert.equal(sv.paneMark(0, false), '');
});

test('⌘⇧\\ is the split’s, ⌘\\ stays the sidebar’s', () => {
  assert.equal(sv.keyAction({ metaKey: true, shiftKey: true, key: '|', code: 'Backslash' }), 'split');
  assert.equal(sv.keyAction({ metaKey: true, shiftKey: true, key: '\\', code: 'IntlBackslash' }), 'split');
  assert.equal(sv.keyAction({ metaKey: true, key: '\\', code: 'Backslash' }), 'side');
  assert.equal(sv.keyAction({ metaKey: true, ctrlKey: true, key: '\\', code: 'Backslash' }), null);
  assert.equal(sv.keyAction({ shiftKey: true, key: '|', code: 'Backslash' }), null);
  assert.equal(sv.keyAction({ metaKey: true, shiftKey: true, key: 'b', code: 'KeyB' }), null);
});

// The right pane is the same window in a frame: everything the hub asks of a window, the main
// window answers. A reply the pane could send (from app.js or an Eden Code module, the only ones
// it loads) would race the main window's, so each is held back there.
test('the right pane never answers what the hub asks of the window', () => {
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
  const source = readFileSync(`${WEB}/features/code-split.js`, 'utf8');
  const shown = new Set([
    ...[...source.matchAll(/el\('[\w-]+', '[^']*', '([^']+)'\)/g)].map((m) => m[1]),
    ...[...source.matchAll(/(?:label|note|title|help): '([^']+)'/g)].map((m) => m[1]),
    ...[...source.matchAll(/jcNote\('([^']+)'\)/g)].map((m) => m[1]),
    ...[...source.matchAll(/'aria-label', '([^']+)'/g)].map((m) => m[1]),
    ...[...source.matchAll(/\.title = '([^']+)'/g)].map((m) => m[1]),
    ...[...source.matchAll(/button\('[\w-]+', '([^']+)'/g)].map((m) => m[1]),
    ...[...source.matchAll(/\? '([A-Z][^']+)' : '([A-Z][^']+)'/g)].flatMap((m) => [m[1], m[2]]),
    source.match(/const HELP = '([^']+)'/)[1],
    'Split view: open or close', 'New reply', 'Pick a session', 'No session open', 'No session matches “auth”.',
  ]);
  assert.ok(shown.size > 20);
  assert.deepEqual([...shown].filter((s) => !chinese(s)), []);
  // Its fragment never changes a Chinese string the window already had.
  const own = JSON.parse(readFileSync(`${WEB}/i18n/code-split.json`, 'utf8')).strings;
  const before = { ...base.strings };
  for (const name of readdirSync(`${WEB}/i18n`).filter((f) => f.endsWith('.json') && f !== 'code-split.json')) Object.assign(before, JSON.parse(readFileSync(`${WEB}/i18n/${name}`, 'utf8')).strings || {});
  assert.deepEqual(Object.keys(own).filter((k) => k in before && before[k] !== own[k]), []);
});
