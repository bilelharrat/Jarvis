// Practice mode (?practice=1, ROADMAP I1): the sandbox the try-it tour runs in. app.js imports
// this first, so it runs before any other module reads storage or the URL:
// - every answer comes from the mock (mock.js; ?mock=1 is added to the address),
// - localStorage and sessionStorage are scoped under "eden:practice:" (the person's real
//   conversations, settings and keys are neither read nor written), IndexedDB is hidden (sync
//   stays off), and the network is limited to the page's own files (tour-model.js),
// - a few sample conversations are there to find, search and pin.
// Leaving removes the practice keys and goes back to the real page, which never changed.

import { installSandbox, purgePractice, snapshot, PRACTICE_PREFIX, TOUR_KEY } from './tour-model.js';

const params = new URLSearchParams(location.search);
export const PRACTICE = params.get('practice') === '1';
/** The mock's switches practice mode turns on (mock.js reads them from the address). */
export const PRACTICE_FLAGS = { mock: '1', gmail: 'on', publish: 'on', acct: 'plus' };

let sandbox = null;
if (PRACTICE) {
  // the mock answers everything; Gmail, publishing and a Plus account are on, so every step has its sample
  let changed = false;
  for (const [k, v] of Object.entries(PRACTICE_FLAGS)) if (!params.has(k)) { params.set(k, v); changed = true; }
  if (changed) history.replaceState(history.state, '', `${location.pathname}?${params}${location.hash}`);
  let theme = 'system';
  try { theme = (JSON.parse(localStorage.getItem('jchat:settings') || '{}') || {}).theme || 'system'; } catch { /* none */ }
  sandbox = installSandbox(window);
  // for QA and the tests in the browser: what was refused, and the real storage's own keys (never their values)
  globalThis.edenPractice = {
    blocked: sandbox.record.blocked, prefix: PRACTICE_PREFIX,
    realKeys: () => Object.keys(snapshot(sandbox.realLocal)).filter((k) => !k.startsWith(PRACTICE_PREFIX)),
    tour: () => { try { return JSON.parse(sandbox.realLocal.getItem(TOUR_KEY) || 'null'); } catch { return null; } },
  };
  seed(theme);
}

/** The real localStorage (the tour's own progress lives there, even in practice). */
export function realStorage() { return sandbox ? sandbox.realLocal : globalThis.localStorage; }

/** This address without the practice flags (and with any other parameters kept). */
export function realUrl(href = location.href) {
  const u = new URL(href);
  for (const k of ['practice', 'tour', 'step', ...Object.keys(PRACTICE_FLAGS)]) u.searchParams.delete(k);
  u.hash = '';
  return `${u.pathname}${u.search}`;
}

/** The practice address for this page: ?practice=1&mock=1, plus where to start. */
export function practiceUrl({ step } = {}, href = location.href) {
  const u = new URL(href);
  u.searchParams.set('practice', '1');
  for (const [k, v] of Object.entries(PRACTICE_FLAGS)) u.searchParams.set(k, v);
  u.searchParams.delete('tour');
  if (step) u.searchParams.set('step', step); else u.searchParams.delete('step');
  u.hash = '';
  return `${u.pathname}${u.search}`;
}

/** Leaves practice: the sample data goes, and the real page loads as it was. */
export function leavePractice({ keep = false, to = null } = {}) {
  if (sandbox && !keep) { purgePractice(sandbox.realLocal); purgePractice(sandbox.realSession); }
  location.replace(to && to.startsWith('/') && !to.startsWith('//') ? to : realUrl());
}

/** Starts practice afresh (no sample data left from last time). */
export function resetPractice(storage = realStorage(), session = sandbox ? sandbox.realSession : globalThis.sessionStorage) {
  purgePractice(storage); purgePractice(session);
}

/* ---------------- sample data ---------------- */

function seed(theme) {
  // practice keys are scoped by now: these writes land under eden:practice:ls:
  if (localStorage.getItem('jchat:index')) return; // resumed: keep what the person did
  const DAY = 86_400_000;
  const now = Date.now();
  const route = (model, modelName, provider, cost, rationale) => ({ model, modelName, provider, effort: 'medium', effortLabel: 'medium effort', via: provider === 'anthropic' ? 'claude-cli' : 'api', costUSD: cost, quality: 88, confidence: 82, rationale, candidates: [], fallbacks: [], warnings: [], notes: [] });
  const conv = (id, title, ago, user, reply, r, extra = {}) => ({
    id, title, titleSet: true, created: now - ago, updated: now - ago, pinned: false, temp: false, kind: 'chat', project: null, sessionId: null, personaId: null, mode: 'chat',
    nodes: {
      [`${id}u`]: { id: `${id}u`, parent: null, children: [`${id}a`], sel: 0, created: now - ago, role: 'user', content: user },
      [`${id}a`]: { id: `${id}a`, parent: `${id}u`, children: [], sel: 0, created: now - ago + 4000, role: 'assistant', parts: [{ type: 'text', text: reply }], route: r, usage: { inputTokens: 420, outputTokens: 380, costUSD: r.costUSD }, citations: [], notes: [], mode: 'chat', finish: 'stop' },
    },
    root: { children: [`${id}u`], sel: 0 }, lastRoute: null, allowTools: [], todos: [], queue: [], status: 'idle', ...extra,
  });
  const convs = [
    conv('cpLisbon', 'Weekend in Lisbon', 2 * 3600_000, 'Plan a relaxed weekend in Lisbon for two: food, a view, one museum.',
      '**Saturday**: pastéis in Belém, the Tile Museum, sunset at Miradouro da Senhora do Monte.\n\n**Sunday**: a slow lunch in Alfama, then the tram 28 back.',
      route('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'anthropic', 0.0042, 'Moderate planning task: Claude Sonnet 5.5 at medium effort.')),
    conv('cpUpdate', 'Quarterly update email', DAY + 3600_000, 'Draft a short quarterly update for the team: revenue up 12%, two hires, launch in May.',
      'Hi team,\n\nA quick look at the quarter: revenue is up **12%**, we welcomed two new people, and the launch is on track for **May**.\n\nThanks for the push.',
      route('gpt-6-sol', 'GPT-6 Sol', 'openai', 0.0018, 'Simple writing task: GPT-6 Sol at medium effort.')),
    conv('cpVector', 'What is a vector database?', 4 * DAY, 'Explain a vector database in three sentences.',
      'A vector database stores items as lists of numbers (embeddings) that capture their meaning. It finds the items whose numbers are closest to a query’s, so “similar” is fast. That’s how search by meaning and chat over your documents work.',
      route('gemini-3.8-flash', 'Gemini 3.8 Flash', 'gemini', 0.0006, 'Simple explanation: Gemini 3.8 Flash.')),
  ];
  for (const c of convs) localStorage.setItem(`jchat:conv:${c.id}`, JSON.stringify(c));
  localStorage.setItem('jchat:index', JSON.stringify(convs.map((c) => c.id)));
  localStorage.setItem('jchat:settings', JSON.stringify({ theme }));
  localStorage.setItem('jchat:personas', JSON.stringify([{ id: 'ppEditor', name: 'Editor', system: 'Tighten my writing. Keep my voice.' }]));
}
