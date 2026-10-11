// Mail's own state (mailkit.js) from two places at once — two tabs, the Mac and askeden.com — is
// merged per item, not "the later object wins" (AM7: a snooze from one tab was lost when another
// tab marked something Done). The server on the Mac does the same (src/chat/mailkit.ts
// mergeMailkit, kept in step by a test).
//
// Every change stamps what it touched in `stamps`: `i:<section>:<key>` for one snooze, Done mark,
// rule, follow-up or offered time (added, changed or removed), `s:<section>` for a section kept
// whole (the style, settings, snippets, VIPs, edits, the rules' log). A merge keeps, per item and
// per section, the side that changed it last; an item only one side has and nobody removed stays.
// Stamps (and `at`) from a clock ahead by more than SKEW_MS count as "now + SKEW_MS", so one bad
// clock can't freeze the rest.
//
// Stamps don't pile up (AM2-1, docs/bug-sweep/r2-ask-eden-mail.md): an item's stamp whose item is gone
// from the merged copy (a removal's tombstone) is kept STAMP_DAYS, then dropped, here and in the
// server's merge alike (the union used to bring back what one side pruned, until the store passed the
// server's 20,000 and every save got a 400). At most STAMP_MAX stamps are kept, the newest, gone items first.

export const SKEW_MS = 5 * 60_000;
/** Sections merged item by item: [section, how an item is keyed (null: a map's own keys), most kept]. */
export const ITEM_SECTIONS = [['snoozed', null, 0], ['done', null, 0], ['rules', 'id', 30], ['followups', 'id', 200], ['offers', 'threadId', 50]];
/** Sections kept whole (the later change wins). */
export const WHOLE_SECTIONS = ['voice', 'snippets', 'prefs', 'vips', 'edits', 'ruleLog'];
export const STAMP_DAYS = 31;
export const STAMP_MAX = 5000;

const num = (t) => (typeof t === 'number' && Number.isFinite(t) ? t : 0);
const itemsOf = (v, key) => {
  const out = new Map();
  if (key === null) { if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) out.set(k, x); }
  else if (Array.isArray(v)) for (const x of v) if (x && typeof x === 'object' && x[key] !== undefined && x[key] !== null) out.set(String(x[key]), x);
  return out;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * `stamps` (changed in place, and returned) without the ones that no longer matter: an item's stamp older than
 * STAMP_DAYS whose item `kit` no longer has, then, past STAMP_MAX, the oldest (gone items' first).
 */
export function pruneStamps(stamps, kit, now) {
  const keysOf = new Map();
  const present = (p) => {
    const i = p.indexOf(':', 2);
    const s = p.slice(2, i), sec = ITEM_SECTIONS.find((x) => x[0] === s);
    if (i < 0 || !sec) return false;
    if (!keysOf.has(s)) keysOf.set(s, itemsOf(kit ? kit[s] : undefined, sec[1]));
    return keysOf.get(s).has(p.slice(i + 1));
  };
  for (const [p, t] of Object.entries(stamps)) if (p.startsWith('i:') && now - num(t) > STAMP_DAYS * 86_400_000 && !present(p)) delete stamps[p];
  const n = Object.keys(stamps).length;
  if (n > STAMP_MAX) {
    const items = Object.keys(stamps).filter((p) => p.startsWith('i:')).map((p) => [p, present(p) ? 1 : 0, num(stamps[p])]);
    items.sort((x, y) => x[1] - y[1] || x[2] - y[2] || (x[0] < y[0] ? -1 : 1));
    for (const [p] of items.slice(0, n - STAMP_MAX)) delete stamps[p];
  }
  return stamps;
}

/**
 * The stamps a change from `before` to `after` adds (at `now`), pruned (pruneStamps) against `whole`: the whole
 * copy they go with, when `after` is only part of it (the snoozes and Done marks alone).
 */
export function stampChanges(before, after, now, whole = after) {
  const stamps = { ...((before && before.stamps) || {}) };
  for (const s of WHOLE_SECTIONS) if (!same(before ? before[s] : undefined, after[s])) stamps[`s:${s}`] = now;
  for (const [s, key] of ITEM_SECTIONS) {
    const a = itemsOf(before ? before[s] : undefined, key), b = itemsOf(after[s], key);
    for (const k of new Set([...a.keys(), ...b.keys()])) if (!same(a.get(k), b.get(k))) stamps[`i:${s}:${k}`] = now;
  }
  return pruneStamps(stamps, whole, now);
}

/** Two copies as one (`now`: this clock, for the skew limit). Neither input is changed. */
export function mergeMailkit(a, b, now = Date.now()) {
  a = a && typeof a === 'object' ? a : { at: 0 };
  b = b && typeof b === 'object' ? b : { at: 0 };
  const clamp = (t) => Math.min(num(t), now + SKEW_MS);
  const newer = clamp(b.at) >= clamp(a.at) ? b : a, older = newer === b ? a : b;
  const sa = a.stamps || {}, sb = b.stamps || {};
  const stamp = (side, p) => (Object.prototype.hasOwnProperty.call(side === a ? sa : sb, p) ? clamp((side === a ? sa : sb)[p]) : -1);
  const out = { at: Math.max(clamp(a.at), clamp(b.at)) };
  const stamps = {};
  for (const p of new Set([...Object.keys(sa), ...Object.keys(sb)])) stamps[p] = Math.max(stamp(a, p), stamp(b, p));
  // the later change of a whole section (no stamps on either side: the later object, as before)
  for (const s of WHOLE_SECTIONS) {
    const ta = stamp(a, `s:${s}`), tb = stamp(b, `s:${s}`);
    const win = ta === tb ? newer : ta > tb ? a : b;
    if (win[s] !== undefined) out[s] = win[s];
  }
  for (const [s, key, max] of ITEM_SECTIONS) {
    const ia = itemsOf(a[s], key), ib = itemsOf(b[s], key);
    if (a[s] === undefined && b[s] === undefined) continue;
    const keys = [...new Set([...itemsOf(newer[s], key).keys(), ...itemsOf(older[s], key).keys()])];
    const kept = [];
    for (const k of keys) {
      const ta = stamp(a, `i:${s}:${k}`), tb = stamp(b, `i:${s}:${k}`);
      // the side that touched it last decides; untouched on both sides: whoever has it keeps it
      const win = ta === tb ? (ia.has(k) && ib.has(k) ? newer : ia.has(k) ? a : b) : ta > tb ? a : b;
      const v = (win === a ? ia : ib).get(k);
      if (v !== undefined) kept.push([k, v]);
    }
    if (key === null) out[s] = Object.fromEntries(kept);
    else { const list = kept.map(([, v]) => v); out[s] = max ? list.slice(-max) : list; }
  }
  pruneStamps(stamps, out, now);
  if (Object.keys(stamps).length) out.stamps = stamps;
  return out;
}

/** A copy as text with every object's keys sorted: two copies that hold the same are the same text (AM2-4). */
export function canonical(v) {
  return JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
}

// ── the snoozes and Done marks apart (a Done or a snooze saves those alone, not the whole object; the same split
// as src/chat/mailkit.ts: mailtriage.json on the Mac, the `eden/mailtriage` sync item on askeden.com) ──

export const TRIAGE_SECTIONS = ['snoozed', 'done'];
const triageStamp = (p) => p.startsWith('i:snoozed:') || p.startsWith('i:done:');
const stampsOf = (k, keep) => {
  const st = k && k.stamps && typeof k.stamps === 'object' && !Array.isArray(k.stamps) ? k.stamps : {};
  const out = Object.fromEntries(Object.entries(st).filter(([p]) => keep(p)));
  return Object.keys(out).length ? out : null;
};
/** The snoozes and Done marks of a copy, with their stamps: { at, snoozed?, done?, stamps? }. */
export function triageOf(k) {
  const out = { at: (k && k.at) || 0 };
  for (const s of TRIAGE_SECTIONS) if (k && k[s] !== undefined) out[s] = k[s];
  const st = stampsOf(k, triageStamp);
  if (st) out.stamps = st;
  return out;
}
/** Everything else. */
export function restOf(k) {
  const out = { ...k };
  for (const s of TRIAGE_SECTIONS) delete out[s];
  const st = stampsOf(k, (p) => !triageStamp(p));
  if (st) out.stamps = st; else delete out.stamps;
  return out;
}
/** The two as one copy. */
export function joinKit(rest, triage) {
  const out = { ...restOf(rest), at: Math.max((rest && rest.at) || 0, (triage && triage.at) || 0) };
  delete out.stamps; // last, as the merge puts them
  for (const s of TRIAGE_SECTIONS) if (triage && triage[s] !== undefined) out[s] = triage[s];
  const st = { ...(stampsOf(rest, (p) => !triageStamp(p)) || {}), ...(stampsOf(triage, triageStamp) || {}) };
  if (Object.keys(st).length) out.stamps = st;
  return out;
}
