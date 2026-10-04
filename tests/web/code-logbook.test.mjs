// Logbook, Jarvis Code under the Obsidian look: its window helpers (web/features/code-logbook.js),
// that it stays inside that look, and its Chinese. node --test tests/web/
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const lb = require('../../src/jarvis/web/features/code-logbook.js');
const WEB = fileURLToPath(new URL('../../src/jarvis/web/', import.meta.url));

test('each entry is the kind of step it is', () => {
  const tool = (name) => ({ role: 'tool', tool: name });
  assert.equal(lb.stepKind(tool('Read')), 'read');
  assert.equal(lb.stepKind(tool('WebFetch')), 'read');
  assert.equal(lb.stepKind(tool('Grep')), 'search');
  assert.equal(lb.stepKind(tool('Glob')), 'search');
  assert.equal(lb.stepKind(tool('Edit')), 'edit');
  assert.equal(lb.stepKind(tool('MultiEdit')), 'edit');
  assert.equal(lb.stepKind(tool('Write')), 'edit');
  assert.equal(lb.stepKind(tool('Bash')), 'run');
  assert.equal(lb.stepKind(tool('Agent')), 'agent');
  assert.equal(lb.stepKind(tool('AskUserQuestion')), 'wait');
  assert.equal(lb.stepKind(tool('mcp__github__create_issue')), 'tool');
  assert.equal(lb.stepKind({ role: 'user' }), 'you');
  assert.equal(lb.stepKind({ approval: true, tool: 'Bash' }), 'wait');
  for (const role of ['assistant', 'thinking', 'plan', 'live']) assert.equal(lb.stepKind({ role }), 'text');
  for (const role of ['turn', 'note', 'subtool', 'todos']) assert.equal(lb.stepKind({ role }), null);
  assert.equal(lb.stepKind(null), null);
  // the words and colours they're shown in
  assert.equal(lb.kindWord(tool('Write')), 'WRITE');
  assert.equal(lb.kindWord(tool('WebFetch')), 'FETCH');
  assert.equal(lb.kindWord(tool('Grep')), 'SEARCH');
  assert.equal(lb.kindWord(tool('Bash')), 'RUN');
  assert.deepEqual(['read', 'search', 'tool', 'edit', 'run', 'agent', 'you', 'wait', 'text'].map(lb.kindClass),
    ['read', 'read', 'read', 'edit', 'run', 'run', 'you', 'you', 'text']);
});

test('the head’s line sets its numbers in mono, its words not', () => {
  const parts = lb.metaParts('main · opus 5.5 · high · 82k tok · 9m 52s');
  assert.deepEqual(parts.filter((p) => p.num).map((p) => p.text), ['5.5', '82k', '9m', '52s']);
  assert.equal(parts.map((p) => p.text).join(''), 'main · opus 5.5 · high · 82k tok · 9m 52s');
  assert.deepEqual(lb.metaParts('jarvis/split-view'), [{ text: 'jarvis/split-view', num: false }]);
  assert.deepEqual(lb.metaParts(''), []);
  assert.equal(lb.entryTime({ at: '2026-10-03T10:00:00' }), Date.parse('2026-10-03T10:00:00'));
  assert.equal(lb.entryTime({}), null);
});

test('a ledger row says what the step acted on and what came of it', () => {
  const edit = { role: 'tool', tool: 'Edit', status: 'done', detail: 'src/session.py\n- a\n+ b\n+ c' };
  assert.equal(lb.stepTarget(edit), 'src/session.py');
  assert.deepEqual(lb.diffStats(edit.detail), { added: 2, removed: 1 });
  assert.deepEqual(lb.ledgerResult(edit), [{ text: '+2', tone: 'add' }, { text: '−1', tone: 'del' }]);
  const write = { role: 'tool', tool: 'Write', status: 'done', detail: 'tests/t.py (new contents)\n+ x' };
  assert.equal(lb.stepTarget(write), 'tests/t.py');
  assert.deepEqual(lb.ledgerResult(write), [{ text: '+1', tone: 'add' }]);
  assert.deepEqual(lb.ledgerResult({ ...write, detail: 'empty.txt (new contents)' }), [{ text: 'new', tone: 'muted' }]);
  const run = (output, status = 'done') => lb.ledgerResult({ role: 'tool', tool: 'Bash', detail: '$ uv run pytest -q', status, output });
  assert.equal(lb.stepTarget({ role: 'tool', tool: 'Bash', detail: '$ node --test tests/web/' }), 'node --test tests/web/');
  assert.deepEqual(run('....\n4 passed in 0.31s'), [{ text: '4 ✓', tone: 'ok' }]);
  assert.deepEqual(run('# tests 572\n# pass 572\n# fail 0'), [{ text: '572 ✓', tone: 'ok' }]);
  assert.deepEqual(run('3 failed, 10 passed', 'failed'), [{ text: '3 ✗', tone: 'bad' }]);
  assert.deepEqual(run('done'), [{ text: '✓', tone: 'ok' }]);
  assert.deepEqual(run('boom', 'failed'), [{ text: '✗', tone: 'bad' }]);
  assert.deepEqual(run('', 'running'), [{ text: '…', tone: 'live' }]);
  const read = { role: 'tool', tool: 'Read', text: 'Reading auth.py', status: 'done', output: '1→a\n2→b\n3→c\n' };
  assert.equal(lb.stepTarget(read), 'auth.py');
  assert.deepEqual(lb.ledgerResult(read), [{ text: '3 ln', tone: 'muted' }]);
  assert.deepEqual(lb.ledgerResult({ ...read, output: 'x\n'.repeat(1000) }), [{ text: '1000+ ln', tone: 'muted' }]);  // cut short
  const grep = { role: 'tool', tool: 'Grep', text: 'Searching for set_cookie', status: 'done', output: 'a.py:1\nb.py:2\n' };
  assert.equal(lb.stepTarget(grep), 'set_cookie');
  assert.deepEqual(lb.ledgerResult(grep), [{ text: '2 found', tone: 'muted' }]);
  assert.deepEqual(lb.ledgerResult({ ...edit, status: 'failed' }), [{ text: '+2', tone: 'add' }, { text: '−1', tone: 'del' }, { text: '✗', tone: 'bad' }]);
  assert.equal(lb.stepTarget({ role: 'tool', tool: 'Agent', text: 'Agent: find the cookie' }), 'find the cookie');
});

test('the files touched, with their lines, the biggest first', () => {
  const entries = [
    { role: 'tool', tool: 'Edit', status: 'done', detail: 'src/a.py\n- x\n+ y\n+ z' },
    { role: 'tool', tool: 'Edit', status: 'done', detail: 'src/a.py\n+ w' },
    { role: 'tool', tool: 'Write', status: 'done', detail: 'b.md (new contents)\n+ 1' },
    { role: 'tool', tool: 'Edit', status: 'failed', detail: 'c.py\n+ nope' },
    { role: 'tool', tool: 'Read', status: 'done', detail: 'Read d.py' },
  ];
  const files = lb.touchStats(entries);
  assert.deepEqual(files.map((f) => [f.path, f.name, f.added, f.removed, f.delta, f.add, f.del]), [
    ['src/a.py', 'a.py', 3, 1, '+3 −1', 75, 25],
    ['b.md', 'b.md', 1, 0, '+1', 25, 0],
  ]);
  // The Changes view's own numbers when it has them.
  const changed = [{ path: 'web/app.js', added: 38, removed: 9 }, { path: 'web/x.css', added: 61, removed: 0 }];
  assert.deepEqual(lb.touchStats(entries, changed).map((f) => [f.name, f.delta, f.add, f.del]), [['x.css', '+61', 100, 0], ['app.js', '+38 −9', 62, 15]]);
  assert.deepEqual(lb.touchStats([]), []);
  assert.equal(lb.touchStats([], [{ path: 'same.txt', added: 0, removed: 0 }])[0].delta, '±0');
});

test('times as the log and the index say them', () => {
  assert.deepEqual([0, 6, 252, 3723].map(lb.clock), ['00:00', '00:06', '04:12', '1:02:03']);
  assert.deepEqual([4, 252, 3780].map(lb.span), ['4s', '4m 12s', '1h 3m']);
  assert.deepEqual([0, 812, 31200, 1_250_000].map(lb.tokensText), ['', '812 tok', '31.2k tok', '1.3M tok']);
  const now = new Date(2026, 9, 3, 15, 0).getTime();
  assert.equal(lb.ago(now - 20000, now), 'now');
  assert.equal(lb.ago(now - 4 * 60000, now), '4m');
  assert.equal(lb.ago(now - 5 * 3600000, now), '5h');
  assert.equal(lb.ago(Number.NaN, now), '');
  assert.equal(lb.dayKey(now - 3600000, now), 'today');
  assert.equal(lb.dayKey(now - 24 * 3600000, now), 'yesterday');
  assert.equal(lb.dayKey(new Date(2026, 8, 20, 9).getTime(), now), '2026-09-20');
  assert.equal(lb.dayKey(Number.NaN, now), 'earlier');
});

test('the context bar and the index’s glyphs', () => {
  const ctx = { tokens: 82000, max: 200000, categories: [{ name: 'System', tokens: 18000 }, { name: 'Messages', tokens: 48000 }, { name: 'Empty', tokens: 0 }] };
  assert.deepEqual(lb.contextSegments(ctx), [{ name: 'System', pct: 9 }, { name: 'Messages', pct: 24 }]);
  assert.deepEqual(lb.contextSegments(null), []);
  assert.equal(lb.rowState({ busy: true }, 1), 'needs');
  assert.equal(lb.rowState({ busy: true }, 0), 'running');
  assert.equal(lb.rowState({ status: 'failed' }, 0), 'failed');
  assert.equal(lb.rowState({ status: 'waiting' }, 0), 'done');
  assert.equal(lb.rowState(null, 0), 'done');
});

test('it stays inside the Obsidian look, with tokens for colours', () => {
  const css = readFileSync(`${WEB}/features/code-logbook.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = css.split('}').map((r) => r.trim()).filter((r) => r.includes('{') && !r.startsWith('@'));
  for (const rule of rules) {
    const selectors = rule.slice(0, rule.indexOf('{')).replace(/^@[^{]*\{\s*/, '').trim();
    if (!selectors || /^(from|to|\d+%)/.test(selectors)) continue;  // keyframes
    if (selectors === '.lb-meta, .lb-margin, .lb-fold, .lb-margin-btn, .lb-ic, .lb-stop, .lb-tip, .lb-hint') continue;  // hidden everywhere else
    for (const sel of selectors.split(/,(?![^(]*\))/)) assert.match(sel.trim(), /data-skin="obsidian"/, sel);
  }
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'no hardcoded colours: obsidian.css tokens only');
  assert.doesNotMatch(css, /rgba?\(\s*\d/, 'no hardcoded colours: obsidian.css tokens only');
});

test('every word Logbook shows has its Chinese', () => {
  const base = JSON.parse(readFileSync(`${WEB}/i18n-zh.json`, 'utf8'));
  const merged = { ...base.strings };
  for (const name of readdirSync(`${WEB}/i18n`).filter((f) => f.endsWith('.json')).sort()) Object.assign(merged, JSON.parse(readFileSync(`${WEB}/i18n/${name}`, 'utf8')).strings || {});
  const source = readFileSync(`${WEB}/features/code-logbook.js`, 'utf8');
  const shown = new Set([
    ...[...source.matchAll(/(?:el|extra)\('[\w-]+', '[^']*', '([^']+)'\)/g)].map((m) => m[1]),
    ...[...source.matchAll(/'aria-label', '([^']+)'\)/g)].map((m) => m[1]),
    ...['READ', 'SEARCH', 'FETCH', 'EDIT', 'WRITE', 'RUN', 'AGENT', 'TOOL', 'ASK', 'TODAY', 'YESTERDAY', 'you', 'swap', 'alone', 'close'],
    ...['RUN THIS?', 'CREATE THIS?', 'EDIT THIS?', 'READY TO CODE?', 'QUESTION', 'ALLOW THIS?', 'Unfold the index', 'Fold the index to a rail', 'Hide the margin', 'Show the margin'],
  ].filter((s) => !/^[\d№·⌥⏎≡…✓✗+−\s:]+$/.test(s)));
  assert.ok(shown.size > 25);
  assert.doesNotMatch(source, /lb-score|lb-tick|barHeight/, 'the score is gone');
  assert.deepEqual([...shown].filter((s) => merged[s] === undefined), []);
  // Its fragment never changes a Chinese string the window already had.
  const own = JSON.parse(readFileSync(`${WEB}/i18n/code-logbook.json`, 'utf8')).strings;
  const before = { ...base.strings };
  for (const name of readdirSync(`${WEB}/i18n`).filter((f) => f.endsWith('.json') && f !== 'code-logbook.json')) Object.assign(before, JSON.parse(readFileSync(`${WEB}/i18n/${name}`, 'utf8')).strings || {});
  assert.deepEqual(Object.keys(own).filter((k) => k in before && before[k] !== own[k]), []);
});
