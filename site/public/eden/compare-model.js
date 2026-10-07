// The pure parts of cost and quality you can see (ROADMAP G1) and of Compare (G6): the
// estimate line's words, the next stronger model, the compare lanes and their sums. No DOM and
// no imports, so src/__tests__/compare.test.ts runs it as it is (compare.js draws with it).

export const COMPARE_MAX = 3;
/** What the Claude Code CLI adds before the first token (it starts a process per message). */
export const CLI_SECONDS = 3;
const TIER_RANK = { fast: 0, balanced: 1, frontier: 2 };
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const PROVIDER_ORDER = ['anthropic', 'openai', 'gemini', 'kimi'];
const rank = (e) => EFFORTS.indexOf(e);

/** Dollars as the page writes them ($0.004, $0.12, $3), the way util.js's fmtCost does. */
export function usd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  if (n === 0) return '$0';
  if (n < 0.001) return '<$0.001';
  if (n < 0.1) return `$${n.toFixed(3)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n)}`;
}

/** An estimated cost: "~$0.004", "subscription" for Claude through the CLI, or '' when unknown. */
export function costWords(costUSD, { subscription = false } = {}) {
  if (subscription) return 'subscription';
  const s = usd(costUSD);
  if (!s) return '';
  return s.startsWith('<') ? s : `~${s}`;
}

/** Seconds as a quiet estimate: "~4 s", "~40 s", "~2 min"; '' when unknown. */
export function secondsWords(s) {
  if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0) return '';
  if (s < 9.5) return `~${Math.max(1, Math.round(s))} s`;
  if (s < 55) return `~${Math.round(s / 5) * 5} s`;
  return `~${Math.max(1, Math.round(s / 60))} min`;
}

/** A measured time: "820 ms", "8.2 s", "1 min 4 s". */
export function tookWords(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

/** Seconds a pick takes as the page sees it: the router's estimate plus the CLI's start-up. */
export function pickSeconds(latencyS, { cli = false } = {}) {
  if (typeof latencyS !== 'number' || !Number.isFinite(latencyS)) return null;
  return latencyS + (cli ? CLI_SECONDS : 0);
}

/**
 * The estimate line's parts for a pick ({ name, effort, costUSD, latencyS }): model, effort,
 * cost ("~$0.004" or "subscription") and time ("~6 s"). `subscription`: Claude through the CLI.
 */
export function estimateParts(pick, { subscription = false, effortName = (e) => e } = {}) {
  if (!pick) return null;
  return {
    model: String(pick.name || pick.modelName || pick.model || '').replace(/^Claude /, '').replace(/ \(preview\)$/, ''),
    effort: pick.effort ? effortName(pick.effort) : '',
    cost: costWords(pick.costUSD, { subscription }),
    time: secondsWords(pickSeconds(pick.latencyS, { cli: subscription })),
  };
}

/** The effort a model runs at for "the same effort": that one, else the nearest it has (higher on a tie). */
export function sameEffort(efforts, want) {
  const list = (efforts || []).filter((e) => rank(e) >= 0);
  if (!list.length) return want;
  if (!want || list.includes(want)) return want || list[0];
  return [...list].sort((a, b) => Math.abs(rank(a) - rank(want)) - Math.abs(rank(b) - rank(want)) || rank(b) - rank(a))[0];
}

/**
 * "Upgrade": the next stronger model at the same effort. `current` { model, effort, quality? };
 * `rows` the router's rows for this text (one per model: { model, quality, costUSD, latencyS,
 * eligible }); `models` the page's model list ({ id, name, provider, tier, efforts, available }).
 * Strength is a row's expected quality on this task where the router rated the model, else
 * its tier. The pick is the smallest step up (same provider first on a tie, then the cheaper);
 * with nothing stronger, the same model one effort up. null when this is already the top.
 * → { model, name, provider, effort, row, sameModel }
 */
export function strongerPick({ current, rows = [], models = [] }) {
  if (!current || !current.model) return null;
  const info = (id) => models.find((m) => m.id === id) || null;
  const rowOf = (id) => rows.find((r) => r.model === id) || null;
  const cur = info(current.model);
  const curRow = rowOf(current.model);
  const curQ = typeof current.quality === 'number' ? current.quality : curRow && typeof curRow.quality === 'number' ? curRow.quality : null;
  const curTier = cur ? TIER_RANK[cur.tier] ?? 1 : 1;
  const strength = (m) => {
    const r = rowOf(m.id);
    if (r && typeof r.quality === 'number' && curQ !== null) return r.quality;
    const tierStep = (TIER_RANK[m.tier] ?? 1) - curTier;
    return (curQ ?? 80) + tierStep * 5;
  };
  const base = curQ ?? 80;
  const up = models
    .filter((m) => m.available !== false && m.id !== current.model && (m.efforts || []).length)
    .map((m) => ({ m, q: strength(m), row: rowOf(m.id) }))
    .filter((x) => x.q > base + 0.5)
    .sort((a, b) => a.q - b.q || Number(b.m.provider === (cur && cur.provider)) - Number(a.m.provider === (cur && cur.provider)) || ((a.row && a.row.costUSD) ?? Infinity) - ((b.row && b.row.costUSD) ?? Infinity));
  if (up.length) {
    const { m, row } = up[0];
    const effort = sameEffort(m.efforts, current.effort);
    return { model: m.id, name: m.name, provider: m.provider, effort, row: row && row.effort === effort ? row : row ? { ...row, effort, approximate: true } : null, sameModel: false };
  }
  if (cur && current.effort) {
    const higher = (cur.efforts || []).filter((e) => rank(e) > rank(current.effort)).sort((a, b) => rank(a) - rank(b));
    if (higher.length) return { model: cur.id, name: cur.name, provider: cur.provider, effort: higher[0], row: null, sameModel: true };
  }
  return null;
}

/**
 * The compare lanes from the router's rows (best first): one per provider in Claude, GPT,
 * Gemini, Kimi order; with a single provider, its best `max` models. The server's
 * chooseLanes (src/chat/compare.ts) is the same rule.
 */
export function chooseLanes(rows, max = COMPARE_MAX) {
  const ordered = [...rows.filter((r) => r.eligible !== false), ...rows.filter((r) => r.eligible === false)];
  const seen = new Set();
  const best = ordered.filter((r) => !seen.has(r.model) && seen.add(r.model));
  const providers = PROVIDER_ORDER.filter((p) => best.some((r) => r.provider === p));
  if (providers.length >= 2) return providers.slice(0, max).map((p) => best.find((r) => r.provider === p));
  return best.slice(0, max);
}

/**
 * A compare estimate's sum, as the line says it: dollars for what's billed by the API,
 * "subscription" for Claude through the CLI, and the time (the slowest lane, then the summary).
 * `isSubscription(lane)` tells which lanes are subscription.
 */
export function compareTotals(estimate, isSubscription = () => false) {
  if (!estimate || !Array.isArray(estimate.lanes)) return null;
  const parts = [...estimate.lanes, ...(estimate.synthesis ? [estimate.synthesis] : [])];
  let dollars = 0;
  let known = true;
  let subscription = 0;
  for (const l of parts) {
    if (isSubscription(l)) subscription++;
    else if (typeof l.costUSD === 'number') dollars += l.costUSD;
    else known = false;
  }
  const secs = (l) => pickSeconds(l.latencyS, { cli: isSubscription(l) }) ?? 0;
  const seconds = Math.max(0, ...estimate.lanes.map(secs)) + (estimate.synthesis ? secs(estimate.synthesis) : 0);
  const billed = parts.length - subscription;
  const cost = !billed ? 'subscription' : `${known ? costWords(dollars) : 'cost unknown'}${subscription ? ' + subscription' : ''}`;
  return { dollars: known ? Math.round(dollars * 1e6) / 1e6 : null, subscription, cost, time: secondsWords(seconds), models: estimate.lanes.length };
}

/** What a finished answer cost and took, from its node: { cost: "$0.012" | "subscription" | "", time: "8.2 s" | "" }. */
export function actualParts(node) {
  const u = node && node.usage;
  const cost = u && typeof u.costUSD === 'number' ? (u.notional ? 'subscription' : usd(u.costUSD)) : '';
  const time = node && node.startedAt && node.doneAt ? tookWords(node.doneAt - node.startedAt) : '';
  return { cost, time };
}
