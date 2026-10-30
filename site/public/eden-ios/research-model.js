// Verified research reports (ROADMAP Q2): the pure parts the page uses (tested in research-ui.test.ts).
//  - the budget cap the person picks in the estimate line (state.settings.researchBudget), sent as `budgetUSD`;
//  - the estimate (POST /api/chat/research/estimate) in plain words;
//  - the progress steps from the server's `research` events, and the report once it is done;
//  - the report's file name for "Export Markdown".
// The server (src/chat/research.ts, src/verify/research.ts) decides everything; this only keeps and words it.

/** The caps offered in the estimate line's menu, in dollars. */
export const RESEARCH_CAPS = [0.25, 0.5, 1, 2];
export const DEFAULT_CAP = 0.5;

/** The person's cap, within what the server accepts ($0.05 to $5), else the default. */
export function capOf(settings) {
  const n = Number(settings && settings.researchBudget);
  return Number.isFinite(n) && n >= 0.05 && n <= 5 ? Math.round(n * 100) / 100 : DEFAULT_CAP;
}

/** Research on this server is the verified pipeline (meta.research); elsewhere it is one searched answer. */
export const verifiedResearch = (meta) => !!(meta && meta.research === true);

const money = (x) => {
  if (typeof x !== 'number' || !Number.isFinite(x)) return '';
  if (x === 0) return '$0';
  if (x < 0.01) return '<$0.01';
  return `$${x < 1 ? x.toFixed(2) : x.toFixed(2).replace(/\.00$/, '')}`;
};
export const capWords = (cap) => `cap ${money(cap)}`;

function timeWords(s) {
  if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0) return '';
  if (s < 90) return `~${Math.max(10, Math.round(s / 10) * 10)} s`;
  return `~${Math.round(s / 60)} min`;
}

/**
 * The estimate line in research mode: { searches, cost, cap, time, fits, note, title } as short words, or null when
 * there is nothing to say. `subscription`: Claude through the CLI does the expensive work (not billed in dollars).
 */
export function estimateView(est, { cap = DEFAULT_CAP, subscription = false } = {}) {
  if (!est) return null;
  if (est.error) return { error: `Research: ${est.error}` };
  if (est.available === false) return { error: est.reason || 'Research isn’t available here' };
  const n = Number(est.searches) || 0;
  const cost = subscription ? 'subscription' : `about ${money(est.typicalUSD)}`;
  const view = {
    searches: `${n} web search${n === 1 ? '' : 'es'}`,
    cost,
    cap: capWords(cap),
    time: timeWords(est.latencyS),
    fits: est.fits !== false,
    note: est.fits === false ? `Even the smallest research costs about ${money(est.minUSD)} here: raise the cap.` : '',
  };
  const w = est.models && est.models.write;
  const s = est.models && est.models.search;
  view.title = [
    `Plans the questions, runs ${view.searches}${s ? ` with ${s.modelName}` : ''}, reads the sources, then ${w ? `${w.modelName} writes` : 'writes'} a report and Eden checks every claim against its source.`,
    subscription ? '' : `About ${money(est.typicalUSD)}, at most ${money(est.maxUSD)}: Eden never goes over your ${money(cap)} cap (a step that would is skipped).`,
  ].filter(Boolean).join(' ');
  return view;
}

const STEP_ORDER = ['premise', 'plan', 'search', 'read', 'write', 'check', 'repair'];
const STEP_WORDS = { premise: 'Check the question', plan: 'Plan', search: 'Search', read: 'Read the sources', write: 'Write', check: 'Check every claim', repair: 'Fix what didn’t check out' };

/** A fresh progress record for a research reply (node.research). */
export function newResearch() { return { steps: [], spentUSD: 0, budgetUSD: null, questions: [], report: null }; }

const clean = (v, max = 240) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * One `research` event into the record (returns it): a step is keyed by its id (a search by its index too), so its
 * "running" row becomes "done" in place. `research_report` events are kept with applyReport.
 */
export function applyStep(r, d) {
  const rec = r || newResearch();
  if (!d || typeof d !== 'object' || !STEP_ORDER.includes(d.step)) return rec;
  const key = d.step === 'search' && Number.isInteger(d.index) ? `search:${d.index}` : d.step;
  const status = ['running', 'done', 'skipped', 'error'].includes(d.status) ? d.status : 'running';
  const row = { key, step: d.step, status, text: clean(d.text) || STEP_WORDS[d.step] };
  const i = rec.steps.findIndex((s) => s.key === key);
  if (i >= 0) rec.steps[i] = row; else rec.steps.push(row);
  if (typeof d.spentUSD === 'number' && Number.isFinite(d.spentUSD)) rec.spentUSD = d.spentUSD;
  if (typeof d.budgetUSD === 'number' && Number.isFinite(d.budgetUSD)) rec.budgetUSD = d.budgetUSD;
  if (Array.isArray(d.questions)) rec.questions = d.questions.slice(0, 8).map((q) => clean(q, 300));
  return rec;
}

/** The `research_report` event: the report's title and its sources. */
export function applyReport(r, d) {
  const rec = r || newResearch();
  if (!d || typeof d !== 'object') return rec;
  rec.report = {
    title: clean(d.title, 120) || 'Research report',
    sources: (Array.isArray(d.sources) ? d.sources : []).slice(0, 20).map((s) => ({ n: Number(s.n) || 0, title: clean(s.title, 160), url: /^https?:\/\//i.test(String(s.url || '')) ? String(s.url) : '', read: !!s.read })),
  };
  if (typeof d.spentUSD === 'number' && Number.isFinite(d.spentUSD)) rec.spentUSD = d.spentUSD;
  return rec;
}

/**
 * The rows the research card shows, in the pipeline's order (searches in their own order): { key, text, status }.
 * While it runs, `running` rows show a spinner; at the end a "running" row that never finished reads as stopped.
 */
export function stepsView(r, { live = false } = {}) {
  if (!r || !Array.isArray(r.steps)) return [];
  const rank = (s) => STEP_ORDER.indexOf(s.step) * 100 + (s.step === 'search' ? Number(String(s.key).split(':')[1]) || 0 : 0);
  return [...r.steps].sort((a, b) => rank(a) - rank(b)).map((s) => ({ key: s.key, text: s.text, status: !live && s.status === 'running' ? 'stopped' : s.status }));
}

/** "Spent $0.12 of your $0.50 cap", or ''. */
export function spentWords(r) {
  if (!r || typeof r.spentUSD !== 'number') return '';
  return r.budgetUSD ? `Spent ${money(r.spentUSD)} of your ${money(r.budgetUSD)} cap` : `Spent ${money(r.spentUSD)}`;
}

/** The report's file name: its title as a slug, .md. */
export function reportFileName(title) {
  const base = String(title || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${base || 'research-report'}.md`;
}

/** The report's title from its Markdown (its first "# " line), else the fallback. */
export function reportTitle(md, fallback = 'Research report') {
  const m = /^\s*#\s+(.+)$/m.exec(String(md || ''));
  return m ? m[1].replace(/[*_`]/g, '').trim().slice(0, 120) : fallback;
}
