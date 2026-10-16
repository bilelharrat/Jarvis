// Eden Code settings as macOS System Settings (web/features/code-settings.js): which section
// each feature's group lands in (today's groups, the ones other branches are adding, a group
// that says where it belongs, and the fallback), the search's matching and its plan grouped by
// section, the look's scope (Eden Code's window only, never the composer) and Apple's controls,
// and every word shown has its Chinese. node --test tests/web/
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const S = require('../../src/jarvis/web/features/code-settings.js');
const web = (path) => readFileSync(new URL(`../../src/jarvis/web/${path}`, import.meta.url), 'utf8');
const where = (heading, more = {}) => S.sectionOf({ heading, ...more }).section;

test('the sidebar is the mockup’s eleven sections, in its order and colours', () => {
  assert.deepEqual(S.SECTIONS.map((s) => s.label), [
    'General', 'Models & Router', 'Limits & Spending', 'Permissions & Sandbox', 'Rules & Guardrails',
    'Receipts & Checks', 'Secrets & Security', 'Voice', 'iPhone', 'Git & Integrations', 'Labs',
  ]);
  assert.deepEqual(S.SECTIONS.map((s) => s.color), [
    '#8E8E93', '#5E5CE6', '#34C759', '#0A84FF', '#FF9500', '#30B0C7', '#FF3B30', '#AF52DE', '#1C1C1E', '#636366', '#FF2D55',
  ]);
  for (const s of S.SECTIONS) {
    assert.ok(s.title && s.text && s.glyph, s.id);
    assert.doesNotMatch(s.glyph, /<script|on\w+=/i, s.id);
  }
  const ids = new Set(S.SECTIONS.map((s) => s.id));
  for (const [section, matcher] of S.PLACES) assert.ok(ids.has(section), `${matcher} → ${section}`);
  assert.ok(ids.has(S.FALLBACK));
});

test('today’s groups land in their sections', () => {
  const today = {
    'New sessions start with': 'general', 'While it works': 'general', 'Exterminator Mode': 'general',
    'Model Router': 'models',
    'Spending limits': 'limits', 'Forecast and queue': 'limits',
    'Safety': 'permissions', 'Isolated copies': 'permissions',
    'Guardrails': 'rules', 'Assumptions': 'rules',
    'Receipts': 'receipts',
    'Security scanning': 'security',
    'Voice coding': 'voice',
    'Production alerts': 'git', 'Control from code': 'git', 'GitHub: reviewing pull requests': 'git',
    'GitHub: pull requests and issues': 'git', 'Eden’s agents in Linear': 'git', 'Linear and Slack': 'git',
    'Labs': 'labs',
  };
  for (const [heading, section] of Object.entries(today)) assert.equal(where(heading), section, heading);
  // groups known by id or class, and tabs' panels by their tab
  assert.equal(S.sectionOf({ id: 'cr-fallbacks' }).section, 'models');
  assert.equal(S.sectionOf({ id: 'labs-group' }).section, 'labs');
  assert.equal(S.sectionOf({ classes: ['jcs-foot'] }).section, 'general');
  assert.equal(S.sectionOf({ id: 'jcs-more-row', classes: ['jcs-actions'] }).section, 'general');
  for (const [tab, section] of [['models', 'models'], ['limits', 'limits'], ['machines', 'git'], ['projects', 'general'], ['snippets', 'general']]) {
    assert.equal(S.sectionOf({ tab }).section, section, tab);
  }
});

test('a group with no label of its own gets the table’s heading', () => {
  assert.deepEqual(S.sectionOf({ id: 'jcs-radar', classes: ['jcs-group'] }), { section: 'models', rule: S.PLACES.findIndex(([, m]) => m === '#jcs-radar'), heading: 'Engine' });
  assert.equal(S.sectionOf({ id: 'jcs-ledger' }).section, 'limits');
  assert.equal(S.sectionOf({ id: 'jcs-ledger' }).heading, 'Productivity ledger');
});

test('groups other branches are adding land where they belong', () => {
  const coming = {
    'While you’re busy': 'general', 'Delegation': 'general', 'Debugger': 'general', 'Teams': 'general',
    'Engine radar': 'models', 'Local models': 'models', 'Other coding agents': 'models', 'Evals': 'models',
    'Cost forecast': 'limits', 'Productivity ledger': 'limits', 'Cloud budget': 'limits',
    'Sandbox': 'permissions', 'Permissions': 'permissions',
    'Rules': 'rules',
    'Test integrity': 'receipts', 'Provenance': 'receipts', 'LSP': 'receipts', 'Language servers': 'receipts',
    'Secrets': 'security', 'Dependencies': 'security',
    'GitLab': 'git', 'Jira': 'git', 'Hosts: GitLab and Jira': 'git', 'Cloud runs': 'git', 'Rollouts': 'git',
  };
  for (const [heading, section] of Object.entries(coming)) assert.equal(where(heading), section, heading);
});

test('a group can say where it goes; one nobody knows goes to General, after the known ones', () => {
  assert.equal(S.sectionOf({ explicit: 'voice', heading: 'Guardrails' }).section, 'voice');
  assert.equal(S.sectionOf({ explicit: 'nonsense', heading: 'Guardrails' }).section, 'rules');  // (an unknown id is ignored)
  const lost = S.sectionOf({ heading: 'Something brand new', id: 'x-new', classes: ['jcs-group'] });
  assert.deepEqual(lost, { section: 'general', rule: S.PLACES.length, heading: '' });
  assert.equal(S.sectionOf({}).section, 'general');
  assert.equal(S.sectionOf(null).section, 'general');
});

test('a heading shown in Chinese still finds its section (a whole heading the dictionary knows)', () => {
  const zh = { Guardrails: '护栏', Receipts: '收据' };
  const t = (s) => zh[s] || s;
  assert.equal(S.sectionOf({ heading: '护栏' }, t).section, 'rules');
  assert.equal(S.sectionOf({ heading: ' 收据 ' }, t).section, 'receipts');
  assert.equal(S.sectionOf({ heading: '未知' }, t).section, 'general');
});

test('search matches every word, in any order, any case, and marks each one', () => {
  assert.deepEqual(S.words('  Touch   ID '), ['touch', 'id']);
  assert.deepEqual(S.matchRanges('Touch ID for Bypass', 'touch'), [[0, 5]]);
  assert.deepEqual(S.matchRanges('Touch ID for Bypass', 'bypass TOUCH'), [[0, 5], [13, 19]]);
  assert.equal(S.matchRanges('Touch ID for Bypass', 'touch face'), null);
  assert.equal(S.matchRanges('anything', ''), null);
  assert.equal(S.matchRanges('', 'x'), null);
  // every place, overlapping ones merged
  assert.deepEqual(S.matchRanges('limit, limits and Limit', 'limit'), [[0, 5], [7, 12], [18, 23]]);
  assert.deepEqual(S.occurrences('spending limits', 'limit limits'), [[9, 15]]);
  // a row's text with only some of the words still has those marked (the words are across a row)
  assert.deepEqual(S.occurrences('Heads-up', 'heads limit'), [[0, 5]]);
});

test('the search’s plan: hits grouped by section in sidebar order; a heading hit shows its whole group', () => {
  const blocks = [
    { section: 'git', heading: 'Production alerts', rows: ['Alerts that start a fix', 'The tunnel'] },
    { section: 'limits', heading: 'Spending limits', rows: ['Each session', 'Heads-ups'] },
    { section: 'general', heading: 'While it works', rows: ['Queue follow-ups', 'When Claude’s usage limit is reached'] },
    { section: 'models', heading: 'Model Router', rows: ['Fall back when a model fails'] },
    { section: 'general', heading: '', rows: [], text: 'Shortcuts: mode, model, effort' },
    { section: 'mystery', heading: 'Odd', rows: ['A limit somewhere'] },
  ];
  const plan = S.searchPlan(blocks, 'limit');
  assert.deepEqual(plan.map((p) => p.section), ['general', 'limits']);
  assert.deepEqual(plan[0].blocks, [{ index: 2, all: false, rows: [1] }, { index: 5, all: false, rows: [0] }]);  // (an unknown section searches as General)
  assert.deepEqual(plan[1].blocks, [{ index: 1, all: true, rows: [0, 1] }]);
  // a block without rows is found by its own words
  assert.deepEqual(S.searchPlan(blocks, 'shortcuts'), [{ section: 'general', blocks: [{ index: 4, all: true, rows: [] }] }]);
  // two words must both be in one row (or the heading)
  assert.deepEqual(S.searchPlan(blocks, 'model fails').map((p) => p.blocks), [[{ index: 3, all: false, rows: [0] }]]);
  assert.deepEqual(S.searchPlan(blocks, 'tunnel queue'), []);
  assert.deepEqual(S.searchPlan(blocks, '   '), []);
  assert.deepEqual(S.searchPlan(null, 'x'), []);
});

test('only Eden Code’s window, never the composer; the old tabs and head hidden, not removed', () => {
  const js = web('features/code-settings.js');
  const css = web('features/code-settings.css');
  assert.match(js, /doc\.body\.dataset\.app !== 'eden-code'/);
  assert.match(js, /F\.splitPane/);
  for (const forbidden of ['jc-composer', 'jc-dock']) {
    assert.ok(!js.includes(forbidden), `js mentions ${forbidden}`);
    assert.ok(!css.includes(forbidden), `css mentions ${forbidden}`);
  }
  // every rule is scoped to the restructured sheet (or its own helpers)
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]+\{/g, '').match(/[^{}]+(?=\{)/g).map((s) => s.trim()).filter(Boolean);
  for (const sel of selectors.flatMap((s) => s.split(/,(?![^(]*\))/).map((x) => x.trim()))) {  // (not the commas inside :is(…))
    assert.ok(/\.ecs\b|\.ecs-|body\.eden-code|^::highlight\(ecs-hit\)$/.test(sel), `unscoped: ${sel}`);
  }
  assert.match(css, /\.jcs-card\.ecs > \.jcs-head, body\.eden-code \.jcs-card\.ecs > \.jcs-tabs \{ display: none; \}/);
});

test('Apple’s controls: 38×22 switches green when on, grey pop-ups, segmented controls; light and dark', () => {
  const css = web('features/code-settings.css');
  const rule = (sel) => { const at = css.indexOf(`${sel} {`); assert.ok(at >= 0, sel); return css.slice(at, css.indexOf('}', at)); };
  assert.match(rule('.jcs-card.ecs .jcs-switch'), /width: 38px; height: 22px;[^}]*border-radius: 11px/);
  assert.match(rule('.jcs-card.ecs .jcs-switch[aria-checked="true"]'), /var\(--ecs-green\)/);
  assert.match(rule('.jcs-card.ecs .jcs-switch::after'), /width: 18px; height: 18px/);
  assert.match(css, /--ecs-green: #34c759/);
  assert.match(css, /\.jcs-card\.ecs \.jcs-group input\[type="checkbox"\]:checked/);
  assert.match(css, /\.jcs-card\.ecs \.jcs-kind\[aria-checked="true"\]/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /@media \(max-width: 759px\)[\s\S]*data-ecs-view="list"/);
  // the mockup's measures
  assert.match(rule('.jcs-card.ecs .ecs-tile'), /width: 22px; height: 22px;[^}]*border-radius: 6px/);
  assert.match(rule('.jcs-card.ecs .ecs-col'), /max-width: 640px/);
  assert.match(rule('.jcs-card.ecs .ecs-hero-tile'), /width: 52px; height: 52px;[^}]*border-radius: 13px/);
  assert.match(rule('body.eden-code .jcs-card.ecs'), /gap: 8px; padding: 8px; border-radius: 26px/);
});

test('every word the sections show has its Chinese, and no English has two', () => {
  const dir = new URL('../../src/jarvis/web/i18n/', import.meta.url);
  const files = ['../i18n-zh.json', ...readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f)];
  const strings = {};
  for (const f of files) Object.assign(strings, JSON.parse(readFileSync(new URL(f, dir), 'utf8')).strings || {});
  const mine = JSON.parse(readFileSync(new URL('code-settings.json', dir), 'utf8')).strings;
  for (const s of S.SECTIONS) for (const words of [s.label, s.title, s.text]) assert.ok(strings[words], words);
  for (const words of ['Open on my phone and QR code', 'Pair the Eden Code app', 'Pair…', 'Eden Code on your phone', 'Show…', 'Voice coding', 'Narrate progress', 'Reply length', 'Search results', 'No settings match your search.', 'Productivity ledger', 'Engine']) {
    assert.ok(strings[words], words);
  }
  for (const f of files.filter((x) => x !== 'code-settings.json')) {
    const other = JSON.parse(readFileSync(new URL(f, dir), 'utf8')).strings || {};
    for (const [en, zh] of Object.entries(mine)) if (other[en] !== undefined) assert.equal(other[en], zh, `${en} in ${f}`);
  }
});

// Every settings group the Eden Code branches added (2026-10-16 merge), in its section: its
// heading, or its id/tab where that's how it's found. A new group: add it here and to PLACES.
test('every merged feature’s settings group lands in its section', () => {
  const S = require('../../src/jarvis/web/features/code-settings.js');
  const where = (d) => S.sectionOf(d).section;
  const expected = [
    [{ heading: 'New sessions start with' }, 'general'], [{ heading: 'While it works' }, 'general'],
    [{ heading: 'While you’re busy', id: 'dlg-group' }, 'general'], [{ heading: 'Exterminator Mode' }, 'general'],
    [{ heading: 'Debugger' }, 'general'], [{ heading: 'When it opens' }, 'general'],
    [{ heading: 'On this PC', id: 'cw-parity' }, 'general'],
    [{ heading: 'Model Router', id: 'cr-fallbacks' }, 'models'], [{ id: 'jcs-radar' }, 'models'],
    [{ heading: 'Evals' }, 'models'], [{ heading: 'Smaller models' }, 'models'],
    [{ heading: 'Coding agents', id: 'graduated-group' }, 'models'],
    [{ heading: 'Spending limits', tab: 'limits' }, 'limits'], [{ heading: 'Forecast and queue', tab: 'limits' }, 'limits'],
    [{ id: 'jcs-ledger' }, 'limits'],
    [{ heading: 'Safety' }, 'permissions'], [{ heading: 'Isolated copies' }, 'permissions'],
    [{ heading: 'Your context' }, 'permissions'],
    [{ heading: 'Guardrails' }, 'rules'], [{ heading: 'Assumptions' }, 'rules'],
    [{ heading: 'Receipts' }, 'receipts'], [{ heading: 'Provenance' }, 'receipts'],
    [{ heading: 'Security scanning' }, 'security'], [{ heading: 'Dependency upgrades' }, 'security'],
    [{ heading: 'Control from code' }, 'git'], [{ heading: 'Production alerts' }, 'git'],
    [{ heading: 'Git hosts and Jira' }, 'git'], [{ heading: 'GitHub: reviewing pull requests' }, 'git'],
    [{ heading: 'GitHub: pull requests and issues' }, 'git'], [{ heading: 'Linear and Slack' }, 'git'],
    [{ heading: 'Eden’s agents in Linear' }, 'git'], [{ heading: 'Merge queue' }, 'git'],
    [{ heading: 'Watching after a merge' }, 'git'], [{ heading: 'OpenTelemetry' }, 'git'],
    [{ id: 'jcs-eden-cloud', tab: 'eden-cloud' }, 'git'], [{ id: 'jcs-machines', tab: 'machines' }, 'git'],
    [{ heading: 'Labs', id: 'labs-group' }, 'labs'],
  ];
  for (const [d, section] of expected) assert.equal(where(d), section, JSON.stringify(d));
});

test('Settings has only a close button, an X in a rounded square: no yellow or green dots', () => {
  const js = readFileSync(new URL('../../src/jarvis/web/features/code-settings.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../../src/jarvis/web/features/code-settings.css', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /ecs-light (yellow|green)/);
  assert.match(js, /close\.classList\.add\('ecs-close'\)/);
  assert.match(css, /\.ecs-close, body\.eden-code \.jc-settings \.jcs-card\.ecs \.ecs-close:hover \{[^}]*border-radius: 8px;/);
});
