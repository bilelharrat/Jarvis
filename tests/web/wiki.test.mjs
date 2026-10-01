// The memory wiki's window side (web/features/wiki.js): every sentence it writes has its
// Chinese, its counts turn into Chinese, it never says "Claude Code"; and its people map's
// layout settles, stays bounded and fast at 2,000 people, and picks the node under a point.
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = process.env.JARVIS_WEB_DIR || fileURLToPath(new URL('../../src/jarvis/web/', import.meta.url));
const source = readFileSync(`${WEB}/features/wiki.js`, 'utf8');
const base = JSON.parse(readFileSync(`${WEB}/i18n-zh.json`, 'utf8'));
const ours = JSON.parse(readFileSync(`${WEB}/i18n/wiki.json`, 'utf8'));
const strings = { ...base.strings, ...ours.strings };
const patterns = [...base.patterns, ...ours.patterns].map(([p, r]) => [new RegExp(p), r]);

function chinese(text) {
  const key = text.replace(/\s+/g, ' ').trim();
  if (strings[key] !== undefined) return strings[key];
  for (const [re, rep] of patterns) if (re.test(key)) return key.replace(re, rep);
  return null;
}

// Every quoted text in the script, read as a script is (comments, regular expressions and
// template literals' ${…} parts skipped).
function literals(code) {
  const out = [];
  let i = 0;
  let prev = '';
  while (i < code.length) {
    const c = code[i];
    if (c === '/' && code[i + 1] === '/') { i = code.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && code[i + 1] === '*') { i = code.indexOf('*/', i) + 2; continue; }
    if (c === '/' && /[(,=:!&|?{};\n]/.test(prev)) {
      let j = i + 1;
      let inClass = false;
      while (j < code.length && (code[j] !== '/' || inClass)) {
        if (code[j] === '\\') j++;
        else if (code[j] === '[') inClass = true;
        else if (code[j] === ']') inClass = false;
        j++;
      }
      i = j + 1;
      prev = '/';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      let text = '';
      while (j < code.length && code[j] !== c) {
        if (code[j] === '\\') { text += code[j + 1]; j += 2; continue; }
        if (c === '`' && code[j] === '$' && code[j + 1] === '{') {
          let depth = 1;
          j += 2;
          while (j < code.length && depth) { if (code[j] === '{') depth++; else if (code[j] === '}') depth--; j++; }
          text += '\u0000';
          continue;
        }
        text += code[j];
        j++;
      }
      out.push(text);
      i = j + 1;
      prev = c;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

const NOT_WORDS = /^(?:[A-Z]+$|#|\.|\[|<|wiki-|mem-|btn|aria-|data-|feature:|button:|Escape$|Tab$|rgba?\(|\d)/;
function sentences() {
  const found = new Set();
  for (const text of literals(source)) {
    if (text.includes('\u0000') || NOT_WORDS.test(text) || !/[A-Za-z]{2}/.test(text)) continue;
    if (/\.json$|^[a-z_:.-]+$/.test(text) || /^[a-z]+(?: [a-z-]+)+$/.test(text)) continue;  // names and class lists
    if (/Instrument Sans|^\d+ \d+ \d+$/.test(text)) continue;  // a font, a colour
    if (/^[A-Z]/.test(text) || / [a-z]/.test(text)) found.add(text.replace('{n}', '2'));
  }
  return [...found];
}

function helpers() {
  let got = null;
  const window = { jarvisFeatures: { el: () => null, send: () => true, on: () => {}, t: (s) => s, $: () => null }, __wikiTest: (h) => { got = h; }, addEventListener: () => {} };
  const document = { getElementById: () => null, querySelectorAll: () => [] };
  new Function('window', 'document', source)(window, document);
  return got;
}

test('every sentence the wiki writes has its Chinese', () => {
  const all = sentences();
  assert.ok(all.length > 60, `only ${all.length} found: the scan has gone wrong`);
  assert.deepEqual(all.filter((s) => chinese(s) === null), []);
});

test('the pieces put together with the owner’s words have their Chinese too', () => {
  const pieces = [...source.matchAll(/\bT\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(pieces.length > 8);
  assert.deepEqual(pieces.filter((p) => chinese(p) === null), []);
});

test('its counts turn into Chinese', () => {
  assert.equal(chinese('12 texts in the last 90 days'), '最近 90 天有 12 条短信');
  assert.equal(chinese('3 emails in the last 90 days'), '最近 90 天有 3 封邮件');
  assert.equal(chinese('Showing 300 of 2100. Search to narrow it down.'), '显示 2100 页中的 300 页。搜索可以缩小范围。');
  assert.equal(chinese('1999 people and organisations'), '1999 个人和机构');
  assert.equal(chinese('4 possible conflicts to look at'), '有 4 处可能的矛盾待查看');
  assert.equal(chinese('501 more not shown'), '另有 501 个未显示');
});

test('the fragment never changes a Chinese string the window already had', () => {
  for (const [key, value] of Object.entries(ours.strings)) {
    if (key in base.strings) assert.equal(value, base.strings[key], key);
  }
});

test('the owner never reads “Claude Code” in it', () => {
  assert.deepEqual(literals(source).filter((t) => /Claude Code/.test(t)), []);
  assert.ok(!Object.keys(ours.strings).some((k) => /Claude Code/.test(k)));
});

test('the map settles, stays in bounds and keeps the owner in the middle', () => {
  const { createSim, stepSim } = helpers();
  const edges = [[0, 1, 'works'], [1, 2, 'family'], [0, 3, 'texts'], [3, 4, 'met']];
  const sim = createSim(5, edges);
  let steps = 0;
  while (stepSim(sim)) steps++;
  assert.ok(steps > 50 && steps < 1000, `${steps} steps`);
  assert.equal(sim.x[0], 0);
  assert.equal(sim.y[0], 0);
  for (let i = 0; i < 5; i++) assert.ok(Number.isFinite(sim.x[i]) && Math.abs(sim.x[i]) < 2000);
  const d = (a, b) => Math.hypot(sim.x[a] - sim.x[b], sim.y[a] - sim.y[b]);
  assert.ok(d(1, 2) < 150, `linked nodes stay near: ${d(1, 2)}`);
  assert.ok(d(1, 2) > 5, 'nodes never sit on each other');
});

test('a step at 2,000 people stays cheap: the repulsion is bucketed, not all pairs', () => {
  const { createSim, stepSim } = helpers();
  const n = 2000;
  const edges = [];
  for (let i = 1; i < n; i++) edges.push([i % 50 === 0 ? 0 : i - (i % 50), i, 'knows']);
  const sim = createSim(n, edges);
  const started = performance.now();
  for (let k = 0; k < 20; k++) stepSim(sim);
  const each = (performance.now() - started) / 20;
  assert.ok(each < 25, `a step took ${each.toFixed(1)} ms`);
  for (let i = 0; i < n; i++) assert.ok(Number.isFinite(sim.x[i]) && Number.isFinite(sim.y[i]));
});

test('the node under a point is picked, within its radius only', () => {
  const { createSim, nearest } = helpers();
  const sim = createSim(3, []);
  sim.x.set([0, 100, -80]);
  sim.y.set([0, 0, 40]);
  assert.equal(nearest(sim, 98, 3, 14), 1);
  assert.equal(nearest(sim, -79, 38, 14), 2);
  assert.equal(nearest(sim, 50, 50, 14), -1);
});

test('the list groups pages by kind and shows at most so many', () => {
  const { grouped } = helpers();
  const pages = [
    { id: 'place:oakland', kind: 'place', title: 'Oakland' },
    { id: 'person:ann', kind: 'person', title: 'Ann' },
    { id: 'person:bob', kind: 'person', title: 'Bob' },
    { id: 'org:bsh', kind: 'org', title: 'BSH' },
  ];
  const { groups, shown, total } = grouped(pages, 3);
  assert.deepEqual(groups.map((g) => [g.kind, g.items.map((p) => p.title)]), [['person', ['Ann', 'Bob']], ['org', ['BSH']]]);
  assert.equal(shown, 3);
  assert.equal(total, 4);
});

test('each statement says where it came from', () => {
  const { sourceOf, activityText } = helpers();
  assert.deepEqual(sourceOf({ kind: 'fact', source: { how: 'said', origin: 'remember Ann', learned: '2026-09-22T10:00:00' } }), { label: 'You told me', when: '2026-09-22T10:00:00', quote: 'remember Ann', changed: '' });
  assert.equal(sourceOf({ kind: 'fact', source: { how: 'settings', origin: 'Settings' } }).quote, '');
  assert.equal(sourceOf({ kind: 'promise', source: { how: 'mail', at: '2026-09-20', quote: 'I will send it' } }).label, 'An email you sent');
  assert.equal(sourceOf({ kind: 'journal', source: { day: '2026-09-28' } }).when, '2026-09-28');
  assert.equal(sourceOf({ kind: 'conversation', source: { title: 'Deck', at: '2026-09-01T09:00' } }).title, 'Deck');
  assert.equal(activityText({ what: 'texts', count: 12, source: { days: 90 } }), '12 texts in the last 90 days');
});
