// The pure part of "a router that learns from you" (ROADMAP H2): the personal routing profile's
// math, the same as src/learn/profile.ts (src/__tests__/learned.test.ts keeps the two equal),
// for askeden.com, where the profile stays in the browser and only the derived per-class
// adjustments go with a turn; askeden.com's Worker (site/src/eden/chat.js) imports this file to
// check and apply them. No DOM and no imports. learned.js draws the console card with it.
//
// Per (task class, model) cell, each choice implies Δ capability points with a weight w (EFFECTS):
//   ω = w · 2^(−age/45 days) (none after 180 days or before a reset), at most 3 a conversation;
//   adj = clamp(Σ ω Δ / (Σ ω + k), ±cap), k = 10 (the benchmark prior, D1), cap 4 / 6 / 8 points;
//   applied with ≥ 2.5 of evidence (about three recent choices) and |adj| ≥ 0.5.

export const TASK_CLASSES = ['reasoning', 'coding', 'writing', 'analysis', 'knowledge', 'longContext', 'agentic'];
export const FEEDBACK_KINDS = ['keep', 'override', 'regenerate', 'thumbs', 'stop'];
export const EFFECTS = {
  keep: { model: [8, 1], other: [-8, 1] },
  override: { model: [4, 0.5], other: [-2, 0.5] },
  regenerate: { model: [-4, 1], other: [1, 0.5] },
  thumbs: { model: [5, 1], other: [0, 0] },
  stop: { model: [-2, 0.5], other: [0, 0] },
};
export const PROFILE = { priorWeight: 10, halfLifeDays: 45, maxAgeDays: 180, minEvidence: 2.5, deadband: 0.5, sessionCap: 3, maxEvents: 2000 };
export const CLASS_WORDS = { reasoning: 'reasoning', coding: 'coding', writing: 'writing', analysis: 'analysis', knowledge: 'knowledge questions', longContext: 'long documents', agentic: 'agentic coding' };
const DAY_MS = 86_400_000;
const WELL_SAMPLED_N = 30;

const r1 = (x) => Math.round(x * 10) / 10;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const isClass = (x) => typeof x === 'string' && TASK_CLASSES.includes(x);
const toMs = (ts) => (typeof ts === 'number' ? ts : Date.parse(ts));
const ID = /^[\w.:-]{1,80}$/;

export function profileCap(n) { return n >= WELL_SAMPLED_N ? 8 : n >= 10 ? 6 : 4; }

/** The task's class: the capability it leans on most (ties: the earlier one); null without weights. */
export function taskClass(weights) {
  if (!weights || typeof weights !== 'object') return null;
  let best = null;
  let top = 0;
  for (const c of TASK_CLASSES) {
    const w = Number(weights[c]);
    if (Number.isFinite(w) && w > top) { best = c; top = w; }
  }
  return best;
}

/** A record checked (as the Mac's server checks what the page sends); undefined when it isn't one. */
export function cleanFeedback(raw, known) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if (!FEEDBACK_KINDS.includes(raw.kind) || !isClass(raw.cls)) return undefined;
  const id = (v) => typeof v === 'string' && ID.test(v) && (!known || known.has(v));
  if (!id(raw.model)) return undefined;
  const ts = typeof raw.ts === 'number' || typeof raw.ts === 'string' ? toMs(raw.ts) : NaN;
  const other = Array.isArray(raw.other) ? [...new Set(raw.other.filter(id))].filter((m) => m !== raw.model).slice(0, 4) : [];
  if ((raw.kind === 'keep' || raw.kind === 'override') && !other.length) return undefined;
  if (raw.kind === 'thumbs' && typeof raw.up !== 'boolean' && raw.clear !== true) return undefined;
  const money = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1000 ? Math.round(v * 1e6) / 1e6 : undefined);
  const tag = (v) => (typeof v === 'string' && ID.test(v) ? v : undefined);
  const out = { ts: Number.isFinite(ts) ? new Date(ts).toISOString() : new Date().toISOString(), kind: raw.kind, cls: raw.cls, model: raw.model };
  if (tag(raw.id)) out.id = tag(raw.id);
  if (other.length) out.other = other;
  if (typeof raw.up === 'boolean') out.up = raw.up;
  if (money(raw.costUSD) !== undefined) out.costUSD = money(raw.costUSD);
  if (money(raw.otherCostUSD) !== undefined) out.otherCostUSD = money(raw.otherCostUSD);
  if (tag(raw.session)) out.session = tag(raw.session);
  if (raw.clear === true) out.clear = true;
  return out;
}

/** The events that count: the last record per id (a `clear` drops it), at most maxEvents. */
export function effectiveFeedback(events) {
  const out = [];
  const at = new Map();
  for (const e of events || []) {
    if (!e) continue;
    if (e.id) {
      const i = at.get(e.id);
      if (i !== undefined) out[i] = null;
      if (e.clear) { at.delete(e.id); continue; }
      at.set(e.id, out.length);
    } else if (e.clear) continue;
    out.push(e);
  }
  return out.filter(Boolean).slice(-PROFILE.maxEvents);
}

/** Every (class, model) cell's change: { cells, adjustments: { class: { model: points } }, events, since }. */
export function buildProfile(events, { now = Date.now(), resetAt } = {}) {
  const k = PROFILE.priorWeight;
  const cells = new Map();
  let counted = 0;
  let since;
  for (const e of effectiveFeedback(events)) {
    const t = toMs(e.ts);
    if (!Number.isFinite(t) || (resetAt !== undefined && resetAt !== null && t < resetAt)) continue;
    const age = Math.max(0, now - t) / DAY_MS;
    if (age > PROFILE.maxAgeDays || !isClass(e.cls)) continue;
    const decay = 2 ** (-age / PROFILE.halfLifeDays);
    const fx = EFFECTS[e.kind];
    if (!fx) continue;
    counted++;
    since = since === undefined ? t : Math.min(since, t);
    const session = e.session || e.id || `t${t}`;
    const add = (model, [d, w], cheaper = false) => {
      if (!w || !model) return;
      const key = `${e.cls}|${model}`;
      const c = cells.get(key) || { cls: e.cls, model, parts: [], events: 0, up: 0, down: 0, cheaper: 0 };
      c.parts.push({ w: w * decay, d, session });
      c.events++;
      if (d > 0) c.up++; else if (d < 0) c.down++;
      if (cheaper) c.cheaper++;
      cells.set(key, c);
    };
    const sign = e.kind === 'thumbs' && e.up === false ? -1 : 1;
    const cheaper = e.kind === 'keep' && e.costUSD !== undefined && e.otherCostUSD !== undefined && e.costUSD < e.otherCostUSD;
    add(e.model, [fx.model[0] * sign, fx.model[1]], cheaper);
    for (const o of e.other || []) if (o !== e.model) add(o, fx.other);
  }
  const out = [];
  const adjustments = {};
  for (const c of cells.values()) {
    const bySession = new Map();
    for (const p of c.parts) bySession.set(p.session, (bySession.get(p.session) || 0) + p.w);
    let n = 0;
    let sum = 0;
    for (const p of c.parts) {
      const total = bySession.get(p.session);
      const w = total > PROFILE.sessionCap ? (p.w * PROFILE.sessionCap) / total : p.w;
      n += w;
      sum += w * p.d;
    }
    const raw = sum / (n + k);
    const cap = profileCap(n);
    const value = clamp(raw, -cap, cap);
    const applied = n >= PROFILE.minEvidence && Math.abs(value) >= PROFILE.deadband;
    const cell = { cls: c.cls, model: c.model, adj: applied ? r1(value) : 0, raw: r1(raw), n: r1(n), events: c.events, up: c.up, down: c.down, cheaper: c.cheaper, applied, capped: Math.abs(raw) > cap };
    out.push(cell);
    if (applied) (adjustments[c.cls] ||= {})[c.model] = cell.adj;
  }
  out.sort((a, b) => Math.abs(b.adj) - Math.abs(a.adj) || Math.abs(b.raw) - Math.abs(a.raw) || b.n - a.n || (a.cls + a.model < b.cls + b.model ? -1 : 1));
  return { v: 1, updated: new Date(now).toISOString(), cells: out, adjustments, events: counted, ...(since !== undefined ? { since: new Date(since).toISOString() } : {}) };
}

/** Adjustments as a page sent them, checked: known classes and models, finite, within the largest cap, ≤ 8 a class. */
export function cleanAdjustments(raw, known) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const max = profileCap(Infinity);
  for (const [cls, models] of Object.entries(raw)) {
    if (!isClass(cls) || !models || typeof models !== 'object' || Array.isArray(models)) continue;
    const row = {};
    for (const [id, v] of Object.entries(models).slice(0, 8)) {
      if (!ID.test(id) || (known && !known.has(id)) || typeof v !== 'number' || !Number.isFinite(v)) continue;
      const x = r1(clamp(v, -max, max));
      if (x !== 0) row[id] = x;
    }
    if (Object.keys(row).length) out[cls] = row;
  }
  return out;
}

/**
 * The router's `overrides` for one class (as profileOverrides in src/learn/profile.ts): every
 * capability of each adjusted model shifted by its points, clamped 0-100. `models`: the
 * registry's profiles ({ id, capabilities }); a model without `agentic` uses its coding.
 */
export function capabilityOverrides(adjustments, cls, models) {
  const out = {};
  const row = cls && adjustments ? adjustments[cls] : null;
  if (!row) return out;
  for (const [id, adj] of Object.entries(row)) {
    const m = (models || []).find((x) => x.id === id);
    if (!m || !m.capabilities || !adj) continue;
    const caps = {};
    for (const d of TASK_CLASSES) {
      const base = typeof m.capabilities[d] === 'number' ? m.capabilities[d] : m.capabilities.coding;
      if (typeof base === 'number') caps[d] = r1(clamp(base + adj, 0, 100));
    }
    if (Object.keys(caps).length) out[id] = { capabilities: caps };
  }
  return out;
}

/** A route's `learned` part: the class, whether the profile ran or only watched, and what it changed. */
export function learnedNote(cls, adj, { on, withPick, withoutPick } = {}) {
  if (!cls || !adj || !Object.keys(adj).length) return null;
  const changed = !!(withPick && withoutPick && (withPick.model !== withoutPick.model || withPick.effort !== withoutPick.effort));
  return { cls, on: !!on, changed, ...(changed ? { without: { model: withoutPick.model, effort: withoutPick.effort, ...(withoutPick.name ? { name: withoutPick.name } : {}), ...(typeof withoutPick.costUSD === 'number' ? { costUSD: withoutPick.costUSD } : {}) }, with: { model: withPick.model, effort: withPick.effort, ...(withPick.name ? { name: withPick.name } : {}), ...(typeof withPick.costUSD === 'number' ? { costUSD: withPick.costUSD } : {}) } } : {}) };
}

/**
 * The shadow report from routed replies (newest first is fine): how many picks the profile
 * changed (or, switched off, would have changed), and a few examples.
 * `routes`: [{ learned?: { cls, on, changed, with, without } }]
 */
export function shadowReport(routes, { max = 40 } = {}) {
  const recent = (routes || []).filter((r) => r && r.learned !== undefined).slice(0, max);
  const all = (routes || []).filter(Boolean).slice(0, max);
  const changed = recent.filter((r) => r.learned && r.learned.changed);
  const examples = [];
  for (const r of changed) {
    const l = r.learned;
    const key = `${l.cls}|${l.with && l.with.model}|${l.without && l.without.model}`;
    if (examples.some((x) => x.key === key)) continue;
    examples.push({ key, cls: l.cls, on: l.on, with: l.with, without: l.without });
    if (examples.length >= 3) break;
  }
  return { seen: all.length, tuned: recent.length, changed: changed.length, applied: changed.filter((r) => r.learned.on).length, examples };
}
