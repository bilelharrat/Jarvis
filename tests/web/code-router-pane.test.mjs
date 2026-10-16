// The Model Router pane in Eden Code (web/features/code-router-pane.js): askeden.com's Route
// tab drawn in the workbench, on the window's own router (code-router.js's view). Its pure
// helpers (the levels' curve, the scatter's layout, the readout, the providers, the recent
// list), then the pane in a stand-in window: what it shows, and that each control goes to
// the view (the settings, the providers, the pin), never to a browser. node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { elFor, load, makeDocument } from './fixtures/stand-dom.mjs';

const require = createRequire(import.meta.url);
const P = require('../../src/jarvis/web/features/code-router-pane.js');
const SOURCE = readFileSync(new URL('../../src/jarvis/web/features/code-router-pane.js', import.meta.url), 'utf8');
const L = P.LEVELS_FALLBACK;

test('the five levels: linked sliders follow their curve, and the level is the nearest one', () => {
  assert.equal(P.interpPerf(L, 80), 30);
  assert.equal(P.interpPerf(L, 50), 50);
  assert.equal(P.interpPerf(L, 55), 45);  // between Efficient and Balanced
  assert.equal(P.interpPerf(L, 0), 90);  // (past the ends: the end's)
  assert.equal(P.interpEff(L, 90), 35);
  assert.equal(P.interpEff(L, 60), 45);
  const exact = P.levelAt(L, 40, 70);
  assert.deepEqual([exact.level, exact.exact], [4, true]);
  assert.equal(P.levelName(exact), 'Level 4 · Performance');
  const custom = P.levelAt(L, 52, 48);
  assert.deepEqual([custom.level, custom.exact], [3, false]);
  assert.equal(P.levelName(custom), 'Custom · nearest Level 3 (Balanced)');
  assert.equal(P.levelsOf({ levels: [] }), L);
  assert.equal(P.levelsOf({ levels: [{ level: 1 }] }).length, 1);
});

test('the scatter: the pick first and ringed, only rows the router takes, cost on a log axis', () => {
  const rows = [
    { model: 'a', effort: 'low', quality: 90, costUSD: 0.1, provider: 'anthropic' },
    { model: 'b', effort: 'none', quality: 80, costUSD: 0.01, provider: 'openai' },
    { model: 'c', effort: 'none', quality: 60, costUSD: 0.001, provider: 'gemini' },
    { model: 'd', effort: 'none', quality: 99, costUSD: 1, provider: 'kimi', eligible: false },
  ];
  const pts = P.candidates(rows, { model: 'b', effort: 'none' });
  assert.deepEqual(pts.map((p) => [p.model, p.chosen]), [['b', true], ['a', false], ['c', false]]);
  assert.equal(P.candidates(rows, null).length, 3);
  const lay = P.scatterLayout(pts, { width: 400, height: 200 });
  const at = Object.fromEntries(lay.dots.map((d) => [d.model, d]));
  // Ten times the cost is the same step each time (log), and higher quality is higher up.
  assert.ok(Math.abs((at.b.cx - at.c.cx) - (at.a.cx - at.b.cx)) < 0.01);
  assert.ok(at.a.cy < at.b.cy && at.b.cy < at.c.cy);
  for (const d of lay.dots) assert.ok(d.cx >= lay.left && d.cx <= 400 - lay.right && d.cy >= 0 && d.cy <= 200 - lay.bottom);
  assert.equal(lay.dots.at(-1).model, 'b');  // (the pick is drawn last: on top)
  assert.match(lay.frontier, /^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+ L[\d.]+ [\d.]+$/);  // c → b → a all buy quality
  assert.equal(P.scatterLayout([]), null);
  assert.equal(P.scatterLayout([{ quality: 1 }]), null);
  // One point (or the same cost) still gets an axis to sit on.
  const one = P.scatterLayout([{ model: 'x', quality: 50, costUSD: 0.02, chosen: true }]);
  assert.ok(Number.isFinite(one.dots[0].cx) && one.costLo < 0.02 && one.costHi > 0.02);
});

test('the readout: the pick, its numbers, why, and whether Gemini rated it', () => {
  const result = {
    pick: { model: 'claude-opus-5-5', name: 'Claude Opus 5.5', provider: 'anthropic', effort: 'low', costUSD: 0.042, quality: 95.4, rationale: 'Because.', warnings: ['w1'] },
    task: { complexity: 'moderate' },
    classification: { used: false },
    optimization: { level: { level: 3, label: 'Balanced' } },
    notes: ['This month’s budget is 85% spent'],
  };
  const r = P.readout(result);
  assert.deepEqual([r.name, r.effort, r.quality, r.complexity, r.rated, r.level, r.why], ['Claude Opus 5.5', 'low', 95, 'moderate', false, 'Level 3 · Balanced', 'Because.']);
  assert.deepEqual(r.notes, ['w1', 'This month’s budget is 85% spent']);
  const rated = P.readout({ ...result, classification: { used: true, model: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', finalComplexity: 'complex' } });
  assert.deepEqual([rated.rated, rated.ratedBy, rated.complexity], [true, 'Gemini 3.6 Flash', 'complex']);
  assert.equal(P.readout({}), null);
  assert.equal(P.readout(null), null);
  assert.equal(P.fmtCost(0.042), '$0.042');
  assert.equal(P.fmtCost(1.5), '$1.50');
  assert.equal(P.fmtCost(0.00031), '$0.00031');
  assert.equal(P.fmtCost(NaN), '—');
  assert.equal(P.shortName('Gemini 3.1 Pro (preview)'), 'Gem. 3.1 Pro');
  assert.equal(P.shortName('Claude Opus 5.5'), 'Opus 5.5');
});

test('the providers: each with its models, and the last one on can’t be switched off', () => {
  const models = [{ model: 'claude-opus-5-5', label: 'Opus' }, { model: 'gpt-6-luna', label: 'Luna' }];
  const providerOf = (id) => (id.startsWith('claude') ? 'anthropic' : id.startsWith('gpt') ? 'openai' : '');
  const rows = P.providerRows(models, providerOf, []);
  assert.deepEqual(rows.map((r) => [r.id, r.available, r.on, r.last]), [
    ['anthropic', true, true, false], ['openai', true, true, false], ['gemini', false, false, false], ['kimi', false, false, false],
  ]);
  assert.deepEqual(P.toggledOff(rows, 'anthropic', false), ['anthropic']);
  const one = P.providerRows(models, providerOf, ['anthropic']);
  assert.equal(one.find((r) => r.id === 'openai').last, true);
  assert.equal(P.toggledOff(one, 'openai', false), null);  // (routing needs one)
  assert.deepEqual(P.toggledOff(one, 'anthropic', true), []);
  assert.equal(P.toggledOff(rows, 'gemini', true), null);  // (no models from it)
});

test('a recent routed message as the list says it: live or Shadow, what it cost or would have saved', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  const nameOf = (id) => ({ 'gpt-6-luna': 'GPT-6 Luna', 'claude-opus-5-5': 'Claude Opus 5.5' }[id] || id);
  const shadow = P.recentLine({ ts: '2026-10-16T11:45:00Z', shadow: true, pick: { model: 'gpt-6-luna', effort: 'low' }, applied: { model: 'claude-opus-5-5' }, wouldSaveUSD: 0.049, complexity: 'simple', signals: ['wrongPick'] }, nameOf, now);
  assert.deepEqual([shadow.head, shadow.kind, shadow.rated, shadow.when], ['GPT-6 Luna · low', 'Shadow', 'rules', '15 min ago']);
  assert.equal(shadow.detail, 'stayed on Claude Opus 5.5 · would have saved $0.049 · simple');
  assert.deepEqual(shadow.signals, ['marked wrong']);
  const more = P.recentLine({ shadow: true, pick: { model: 'gpt-6-luna' }, wouldSaveUSD: -0.2 }, nameOf, now);
  assert.match(more.detail, /would have cost \$0\.200 more/);
  const live = P.recentLine({ ts: '2026-10-15T12:00:00Z', pick: { model: 'claude-opus-5-5', effort: 'none' }, rated: true, costUSD: 0.0143 }, nameOf, now);
  assert.deepEqual([live.head, live.kind, live.rated, live.detail, live.when], ['Claude Opus 5.5', 'Routed', 'rated by Gemini', 'ran $0.014', '1 d ago']);
  assert.equal(P.ago('nope', now), '');
});

// ── the pane in a stand-in window ──

function stand({ on = true, project = null } = {}) {
  const document = makeDocument();
  const el = elFor(document);
  const body = el('div');
  const extra = el('span');
  extra.id = 'jc-pane-extra';
  const draft = el('textarea');
  draft.id = 'deck-input';
  draft.value = 'from the composer';
  document.body.append(body, extra, draft);
  const panes = new Map();
  const more = [];
  const slash = new Map();
  const calls = [];
  const watchers = [];
  let off = [];
  let routing = on;
  let saved = { efficiency: 50, performance: 50, classifier: 'always', subscriptionClaude: true };
  let levels = project;
  const models = [
    { ref: 'opus', model: 'claude-opus-5-5', label: 'Claude Opus 5.5', builtin: true },
    { ref: 'custom:o1', model: 'gpt-6-luna', label: 'GPT-6 Luna', kind: 'openai' },
  ];
  const providerOf = (id) => (id.startsWith('claude') ? 'anthropic' : 'openai');
  const lib = { MODELS: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', provider: 'anthropic' }, { id: 'gpt-6-luna', name: 'GPT-6 Luna', provider: 'openai' }] };
  const view = {
    ready: () => Promise.resolve(),
    lib: () => lib,
    problem: () => '',
    meta: () => ({ levels: P.LEVELS_FALLBACK }),
    preview(text, s) {
      calls.push(['preview', text, s.efficiency, s.performance]);
      const cheap = s.efficiency >= 60;
      const pick = cheap
        ? { model: 'gpt-6-luna', name: 'GPT-6 Luna', provider: 'openai', effort: 'low', costUSD: 0.001, quality: 80, rationale: 'Cheap enough.' }
        : { model: 'claude-opus-5-5', name: 'Claude Opus 5.5', provider: 'anthropic', effort: 'high', costUSD: 0.05, quality: 95, rationale: 'Worth it.' };
      return { pick, rows: [{ ...pick, eligible: true }, { model: cheap ? 'claude-opus-5-5' : 'gpt-6-luna', provider: cheap ? 'anthropic' : 'openai', quality: cheap ? 95 : 80, costUSD: cheap ? 0.05 : 0.001 }], classification: { used: false }, task: { complexity: 'complex' } };
    },
    rated: (text) => { calls.push(['rated', text]); return Promise.resolve({ pick: { model: 'claude-opus-5-5', name: 'Claude Opus 5.5', quality: 96, costUSD: 0.06 }, rows: [], classification: { used: true, name: 'Gemini 3.6 Flash' } }); },
    settings: () => ({ ...saved, ...(levels && Number.isFinite(levels.efficiency) ? levels : {}) }),
    save: (s) => { calls.push(['save', { ...s }]); saved = { ...saved, ...s }; },
    projectDefaults: () => (project ? { project: 'app', ...(levels || {}) } : null),
    setProjectDefaults: (s) => { calls.push(['project', s]); levels = s || {}; },
    isOn: () => routing,
    setOn: (v) => { calls.push(['on', v]); routing = v; },
    shadowOn: () => !routing,
    pin: (ref) => { calls.push(['pin', ref]); routing = false; },
    task: () => ({ id: 7, model: 'claude-opus-5-5', model_ref: 'opus' }),
    models: () => models.filter((m) => !off.includes(providerOf(m.model))),
    allModels: () => models,
    providerOf,
    providersOff: () => off,
    setProvidersOff: (list) => { calls.push(['off', list]); off = list; },
    claudeDown: () => false,
    geminiPaused: () => false,
    budgetNote: () => '',
    call: (op, args) => {
      calls.push(['call', op, args]);
      return Promise.resolve([{ ts: new Date().toISOString(), shadow: true, pick: { model: 'gpt-6-luna', effort: 'low' }, applied: { model: 'claude-opus-5-5' }, wouldSaveUSD: 0.04 }]);
    },
    openDeveloperPage: () => calls.push(['developer page']),
    watch: (fn) => { watchers.push(fn); return () => {}; },
  };
  const F = {
    el, t: (x) => x, $: (id) => document.getElementById(id),
    registerPane: (id, p) => panes.set(id, p),
    registerMoreItem: (item) => more.push(item),
    registerSlash: (c) => slash.set(c.name, c),
    openPane: (id) => calls.push(['openPane', id]),
    codeRouter: { view, draft: null, open: () => calls.push(['open']) },
  };
  const timers = [];
  const scope = { window: { jarvisFeatures: F }, document, setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {} };
  load(SOURCE, scope);
  const flush = async () => { while (timers.length) timers.shift()(); for (let i = 0; i < 3; i++) await Promise.resolve(); };
  return { document, body, extra, panes, more, slash, calls, F, flush, watchers, pane: panes.get('router') };
}

const byText = (root, text) => root.querySelectorAll('button').find((b) => b.textContent === text);
// (the stand-in's selectors split on spaces: an aria-label with words is looked for here)
const byLabel = (root, label) => root.querySelectorAll('button, select').find((b) => b.getAttribute('aria-label') === label);

test('the pane opens from the More menu and /router, and shows each part of the Route tab', async () => {
  const w = stand();
  assert.ok(w.pane && w.pane.title === 'Model Router');
  w.more[0].run();
  assert.equal(w.slash.get('router').withoutSession, true);
  assert.equal(w.slash.get('router').run(), true);
  assert.deepEqual(w.calls.filter((c) => c[0] === 'open'), [['open'], ['open']]);
  w.F.codeRouter.draft = 'refactor the scheduler to use a heap';
  w.pane.render(w.body);
  await w.flush();
  const text = w.body.textContent;
  for (const part of ['Try a prompt', 'Candidates · quality vs cost', 'Optimize for', 'Token efficiency', 'Performance', 'Providers', 'Model', 'Pricing', 'Claude on your plan', 'Rating', 'Recent routed messages']) {
    assert.ok(text.includes(part), part);
  }
  // The draft handed over is routed at once: the pick, why, and the scatter with it ringed.
  assert.equal(w.body.querySelector('.crp-prompt').value, 'refactor the scheduler to use a heap');
  assert.deepEqual(w.calls.find((c) => c[0] === 'preview'), ['preview', 'refactor the scheduler to use a heap', 50, 50]);
  assert.equal(w.body.querySelector('.crp-pick-head strong').textContent, 'Claude Opus 5.5');
  assert.match(w.body.querySelector('.crp-pick').textContent, /Worth it\./);
  assert.equal(w.body.querySelectorAll('.crp-pt').length, 2);
  assert.equal(w.body.querySelectorAll('.crp-pt.chosen').length, 1);
  assert.equal(w.F.codeRouter.draft, null);  // (taken)
  assert.equal(w.extra.textContent, 'Routing live');
  // The recent list from the router's log.
  assert.deepEqual(w.calls.find((c) => c[0] === 'call'), ['call', 'recent', { limit: 20 }]);
  assert.match(w.body.querySelector('.crp-recent').textContent, /GPT-6 Luna · low.*would have saved \$0\.040/);
  // The developer page is a small link at the foot, the only way to the browser.
  byText(w.body, 'Open the developer page in the browser').click();
  assert.deepEqual(w.calls.at(-1), ['developer page']);
});

test('typing previews live; a level or a slider saves the settings and routes again', async () => {
  const w = stand();
  w.pane.render(w.body);
  await w.flush();
  const box = w.body.querySelector('.crp-prompt');
  box.value = 'add a cache';
  box.dispatchEvent(w.document.event('input'));
  await w.flush();
  assert.deepEqual(w.calls.filter((c) => c[0] === 'preview').at(-1), ['preview', 'add a cache', 50, 50]);
  w.body.querySelector('.crp-seg-btn[data-level="1"]').click();
  assert.deepEqual(w.calls.find((c) => c[0] === 'save')[1], { efficiency: 80, performance: 30, classifier: 'always', subscriptionClaude: true });
  assert.equal(w.body.querySelector('.crp-level-name').textContent, 'Level 1 · Max efficiency');
  assert.equal(w.body.querySelector('.crp-pick-head strong').textContent, 'GPT-6 Luna');
  // Linked: moving Performance moves Token efficiency along the levels' curve.
  const perf = w.body.querySelector('#crp-performance');
  perf.value = '70';
  perf.dispatchEvent(w.document.event('input'));
  assert.equal(w.body.querySelector('#crp-efficiency').value, '40');
  assert.equal(w.body.querySelector('.crp-level-name').textContent, 'Level 4 · Performance');
  perf.dispatchEvent(w.document.event('change'));
  assert.deepEqual({ e: w.calls.filter((c) => c[0] === 'save').at(-1)[1].efficiency, p: w.calls.filter((c) => c[0] === 'save').at(-1)[1].performance }, { e: 40, p: 70 });
  // The classifier and Claude on the plan go to the same settings.
  const cls = byLabel(w.body, 'Rating');
  cls.value = 'off';
  cls.dispatchEvent(w.document.event('change'));
  assert.equal(w.calls.filter((c) => c[0] === 'save').at(-1)[1].classifier, 'off');
  byLabel(w.body, 'Claude on your plan').click();
  assert.deepEqual(w.calls.filter((c) => c[0] === 'save').at(-1)[1], { subscriptionClaude: false });
});

test('Rate with Gemini asks once, on a click; the providers and the pin go to the view', async () => {
  const w = stand();
  w.pane.render(w.body);
  const box = w.body.querySelector('.crp-prompt');
  box.value = 'refactor the scheduler to use a heap';
  box.dispatchEvent(w.document.event('input'));
  await w.flush();
  assert.equal(w.calls.filter((c) => c[0] === 'rated').length, 0);  // (typing never asks Gemini)
  byText(w.body, 'Rate with Gemini').click();
  await w.flush();
  assert.deepEqual(w.calls.filter((c) => c[0] === 'rated'), [['rated', 'refactor the scheduler to use a heap']]);
  assert.match(w.body.querySelector('.crp-pick').textContent, /rated by Gemini 3\.6 Flash/);
  // Providers: one off; the last one on can't go.
  const sw = byLabel(w.body, 'Route to OpenAI GPT');
  sw.click();
  await w.flush();
  assert.deepEqual(w.calls.filter((c) => c[0] === 'off').at(-1), ['off', ['openai']]);
  const last = byLabel(w.body, 'Route to Anthropic Claude');
  assert.equal(last.disabled, true);
  assert.equal(byLabel(w.body, 'Route to Google Gemini').disabled, true);  // (no models from it)
  // Pin a model: the menu's own pick (Model Router off); Auto turns it back on.
  const pin = byLabel(w.body, 'Model');
  pin.value = 'custom:o1';
  pin.dispatchEvent(w.document.event('change'));
  assert.deepEqual(w.calls.filter((c) => c[0] === 'pin').at(-1), ['pin', 'custom:o1']);
  await w.flush();
  assert.equal(w.extra.textContent, 'Shadow mode');
  pin.value = '';
  pin.dispatchEvent(w.document.event('change'));
  assert.deepEqual(w.calls.filter((c) => c[0] === 'on').at(-1), ['on', true]);
});

test('Just this project keeps the session’s project on its own levels', async () => {
  const w = stand({ project: {} });
  w.pane.render(w.body);
  await w.flush();
  const sw = byLabel(w.body, 'Just this project');
  assert.equal(sw.getAttribute('aria-checked'), 'false');
  sw.click();
  assert.deepEqual(w.calls.filter((c) => c[0] === 'project').at(-1), ['project', { efficiency: 50, performance: 50 }]);
  assert.equal(sw.getAttribute('aria-checked'), 'true');
  sw.click();
  assert.deepEqual(w.calls.filter((c) => c[0] === 'project').at(-1), ['project', null]);
  // With no project, there's no such switch.
  const none = stand();
  none.pane.render(none.body);
  assert.equal(byLabel(none.body, 'Just this project').parentNode.hidden, true);
});

test('a redraw keeps the prompt box (and its focus); a change elsewhere redraws the pane', async () => {
  const w = stand();
  w.pane.render(w.body);
  const box = w.body.querySelector('.crp-prompt');
  box.focus();
  w.pane.render(w.body);
  assert.equal(w.body.querySelector('.crp-prompt'), box);
  assert.equal(w.document.activeElement, box);
  w.watchers[0]('prefs');
  assert.equal(w.document.activeElement, box);
});
