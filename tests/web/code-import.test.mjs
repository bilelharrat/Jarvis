// "Bring over from…" (web/features/code-import.js): the welcome's card only when a tool is found
// that wasn't brought over (and until answered), the Settings › General group (re-homed by
// data-ecs-section), the preview's groups and boxes, and Import sending only what's ticked.
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { elFor, load, makeDocument } from './fixtures/stand-dom.mjs';

const require = createRequire(import.meta.url);
const I = require('../../src/jarvis/web/features/code-import.js');
const SOURCE = readFileSync(new URL('../../src/jarvis/web/features/code-import.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../../src/jarvis/web/features/code-import.css', import.meta.url), 'utf8');

const ITEMS = [
  { id: 'mcp:gh', kind: 'mcp', group: 'MCP servers', title: 'gh', status: 'already', checked: false, can_import: false, why: 'loads' },
  { id: 'project:/a', kind: 'project', group: 'Projects', title: 'alpha', status: 'new', checked: true, can_import: true },
  { id: 'mcp:search', kind: 'mcp', group: 'MCP servers', title: 'search', status: 'new', checked: false, can_import: true, secrets: ['SEARCH_API_KEY'] },
  { id: 'signin', kind: 'signin', group: 'Sign-in', title: 'Claude sign-in', status: 'already', checked: false, can_import: false },
  { id: 'x', kind: 'note', group: 'Odd', title: 'odd', status: 'skip', checked: false, can_import: false },
];

test('the preview groups items in a fixed order, new ones first, and counts them in words', () => {
  const g = I.groups(ITEMS);
  assert.deepEqual(g.map((x) => x.name), ['Sign-in', 'Projects', 'MCP servers', 'Odd']);
  assert.deepEqual(g[2].items.map((i) => i.id), ['mcp:search', 'mcp:gh']);
  assert.equal(I.summary({ new: 2, already: 3, added: 1, manual: 1, skip: 2 }), '2 to bring over · 4 already in Eden Code · 1 need you · 2 can’t move');
  assert.equal(I.summary({}), 'Nothing found to bring over.');
});

test('Import sends the ticked boxes of what can come, the owner’s own ticks first', () => {
  assert.deepEqual(I.chosen(ITEMS, {}), ['project:/a']);  // (a key moves only when ticked)
  assert.deepEqual(I.chosen(ITEMS, { 'mcp:search': true, 'project:/a': false }), ['mcp:search']);
  assert.deepEqual(I.chosen(ITEMS, { 'mcp:gh': true }), ['project:/a']);  // (already works: no box)
});

test('the card shows while a found tool wasn’t brought over, and stops once answered', () => {
  const s = [{ id: 'claude_code', name: 'Claude Code', found: true }, { id: 'zed', name: 'Zed', found: false }];
  assert.deepEqual(I.offer(s, {}).map((x) => x.id), ['claude_code']);
  assert.equal(I.offer(s, { code_import_offered: true }), null);
  assert.equal(I.offer([{ ...s[0], imported: { at: 1 } }], {}), null);
  assert.equal(I.offerTitle([s[0]]), 'Bring over from Claude Code');
  assert.equal(I.offerTitle([s[0], { name: 'Cursor' }]), 'Bring over from Claude Code and more');
  assert.match(I.imported({ imported: { at: 1760000000, projects: 2, mcp: 1 } }), /^Brought over .* \(3\)$/);
});

function stand(features = {}) {
  const document = makeDocument();
  const cc = document.createElement('div');
  cc.id = 'cc';
  const welcome = document.createElement('div');
  welcome.id = 'cc-welcome';
  const past = document.createElement('div');
  past.id = 'cc-past-wrap';
  welcome.append(past);
  const composer = document.createElement('div');
  composer.className = 'jc-composer';
  const general = document.createElement('div');
  general.id = 'jcs-general';
  const foot = document.createElement('p');
  foot.className = 'jcs-foot';
  general.append(foot);
  cc.append(welcome, composer);
  document.body.append(cc, general);
  const sent = [];
  const handlers = {};
  const slash = [];
  const F = {
    el: elFor(document), $: (id) => document.getElementById(id), t: (x) => x,
    send: (m) => { sent.push(m); return true; },
    on: (type, fn) => { (handlers[type] ||= []).push(fn); },
    registerSlash: (c) => slash.push(c),
  };
  const window = { jarvisFeatures: F, document };
  load(SOURCE, { window, document });
  const fire = (type, ev) => { for (const fn of handlers[type] || []) fn(ev); };
  fire('hello', { prefs: { features } });
  return { document, sent, fire, slash, composer, window };
}

const SOURCES = [
  { id: 'claude_code', name: 'Claude Code', blurb: 'b', found: true, paths: ['~/.claude'], imported: {} },
  { id: 'cursor', name: 'Cursor', blurb: 'c', found: false, paths: [], imported: {} },
];

test('the welcome card offers a look, and Not now stops it asking', () => {
  const w = stand();
  assert.deepEqual(w.sent, [{ type: 'cimp_sources' }]);  // (looking only: nothing changes)
  const card = w.document.getElementById('cimp-card');
  assert.ok(card.hidden);
  w.fire('cimp_sources', { sources: SOURCES });
  assert.ok(!card.hidden);
  assert.match(card.textContent, /Bring over from Claude Code/);
  card.querySelectorAll('button').find((b) => b.textContent === 'Not now').click();
  assert.deepEqual(w.sent.at(-1), { type: 'feature_prefs', changes: { code_import_offered: true } });
  assert.ok(card.hidden);
});

test('Settings › General gets its group, marked for the section map, with the switch', () => {
  const w = stand({ code_import_on: false });
  const general = w.document.getElementById('jcs-general');
  const group = general.querySelector('.cimp-setting');
  assert.equal(group.getAttribute('data-ecs-section'), 'general');
  assert.match(general.textContent, /Other coding tools/);
  const sw = w.document.getElementById('cimp-on');
  assert.equal(sw.getAttribute('aria-checked'), 'false');
  sw.click();
  assert.deepEqual(w.sent.at(-1), { type: 'feature_prefs', changes: { code_import_on: true } });
  assert.equal(w.slash[0].name, 'import');
});

test('the sheet: pick a tool, see its preview with boxes, Import sends the ticked ones', () => {
  const w = stand();
  w.fire('cimp_sources', { sources: SOURCES });
  w.window.edenImport.open('claude_code');
  assert.deepEqual(w.sent.at(-1), { type: 'cimp_preview', source: 'claude_code' });
  const dialog = w.document.querySelector('.cimp-dialog');
  assert.ok(dialog.hasAttribute('open'));
  w.fire('cimp_preview', { source: 'claude_code', name: 'Claude Code', items: ITEMS, counts: { new: 2, already: 2, skip: 1 } });
  const boxes = dialog.querySelectorAll('input');
  assert.equal(boxes.length, 2);  // only what can come
  assert.match(dialog.textContent, /2 to bring over/);
  assert.match(dialog.textContent, /Already works/);
  const go = () => dialog.querySelectorAll('button').find((b) => /^Import \d/.test(b.textContent));
  assert.equal(go().textContent, 'Import 1');
  const search = boxes.find((b) => b.getAttribute('aria-label') === 'search');
  search.checked = true;
  search.dispatchEvent(w.document.event('change'));
  go().click();
  assert.deepEqual(w.sent.at(-1), { type: 'cimp_import', source: 'claude_code', items: ['project:/a', 'mcp:search'] });
  w.fire('cimp_done', { source: 'claude_code', added: [{ kind: 'project', title: 'alpha' }], skipped: [], manual: [{ title: 'Default model: x', why: 'Add it' }] });
  assert.match(dialog.textContent, /Brought over/);
  assert.match(dialog.textContent, /Left for you/);
  dialog.querySelectorAll('button').find((b) => b.textContent === 'Undo import').click();
  assert.deepEqual(w.sent.at(-1), { type: 'cimp_undo', source: 'claude_code' });
  assert.equal(w.composer.childNodes.length, 0);  // (the composer is never touched)
});

test('its look: tokens for light and dark, the glass when it’s on, and never the composer', () => {
  assert.doesNotMatch(CSS, /jc-composer|jc-dock/);
  assert.match(CSS, /var\(--glass-fill-strong, rgb\(var\(--c-surface\)\)\)/);
  assert.doesNotMatch(CSS, /#[0-9a-f]{3,6}\b/i);  // (colours only from the tokens)
});
