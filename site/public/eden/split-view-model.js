// Eden Chat's split-view pure layout and state helpers, mirrored from Eden Code
// (src/eden_code/web/features/code-split.js & code-split/window.js): up to ten panes
// laid out in vertical side-by-side columns by default (or a 2×2 / 3×2 / 4×2 / 5×2 grid when switched),
// falling back to fewer columns or one pane at a time when narrow; resizable dividers;
// drag-and-drop drop zones; ⌘⌥+arrow neighbor focus; sidebar toggle placement (sidePane);
// /split command parsing; session lookup; and persisted state sanitization.

export const MAX_PANES = 10;
export const MIN_PANE = 250; // px wide a pane needs
export const MIN_PANE_H = 180; // px tall
export const GAP = 8; // px: a divider
export const FRAC_MIN = 0.05; // a column's or row's share, at the least
export const MAX_COLS = 10;
// The columns each count of panes starts from in grid mode: 1; 2 side by side; 3 in a row; 2×2; 3×2; 4×2; 5×2.
const COLUMNS = [1, 1, 2, 3, 2, 3, 3, 4, 4, 5, 5];

// The grid n panes take in a room width × height px: all n in one row when vertical is on
// (the default), else the grid columns for n, falling back to fewer columns or one pane at a time.
export function gridFor(n, width, height, min = MIN_PANE, minH = MIN_PANE_H, gap = GAP, vertical = true) {
  const count = Math.max(1, Math.min(MAX_PANES, Math.floor(Number(n)) || 1));
  if (count === 1) return { cols: 1, rows: 1, one: false };
  const w = Number(width);
  const h = Number(height);
  for (let cols = vertical ? count : COLUMNS[count]; cols >= 1; cols -= 1) {
    const rows = Math.ceil(count / cols);
    if (w >= cols * min + (cols - 1) * gap && h >= rows * minH + (rows - 1) * gap) return { cols, rows, one: false };
  }
  return { cols: 1, rows: 1, one: true };
}

// Each pane's cell in a grid: row and column in reading order; the last pane takes what's
// left of its row (a fifth pane under three is wide, never a hole).
export function cells(n, cols) {
  const out = [];
  for (let k = 0; k < n; k += 1) {
    const col = k % cols;
    out.push({ row: Math.floor(k / cols), col, span: k === n - 1 ? cols - col : 1 });
  }
  return out;
}

// Shares that add up to 1, one for each of count columns (or rows): equal when what's kept
// isn't for that many.
export function cleanFracs(fracs, count) {
  const equal = Array.from({ length: count }, () => 1 / count);
  if (!Array.isArray(fracs) || fracs.length !== count || !fracs.every((f) => typeof f === 'number' && Number.isFinite(f) && f > 0)) return equal;
  const total = fracs.reduce((s, f) => s + f, 0);
  return fracs.map((f) => f / total);
}

// The shares kept where each part is at least min px of total px (gaps between them): equal
// when even that can't be.
export function clampFracs(fracs, total, min = MIN_PANE, gap = GAP) {
  const count = fracs.length;
  const room = Number(total) - gap * (count - 1);
  if (!(room > 0)) return cleanFracs(fracs, count);
  const lo = Math.max(FRAC_MIN, min / room);
  if (lo * count > 1) return cleanFracs(null, count);
  const out = cleanFracs(fracs, count);
  const fixed = new Set();
  for (let round = 0; round < count; round += 1) {
    const under = out.map((f, i) => i).filter((i) => !fixed.has(i) && out[i] < lo);
    if (!under.length) break;
    for (const i of under) { out[i] = lo; fixed.add(i); }
    const free = out.map((f, i) => i).filter((i) => !fixed.has(i));
    const left = 1 - lo * fixed.size;
    const sum = free.reduce((s, i) => s + out[i], 0);
    for (const i of free) out[i] = sum > 0 ? (out[i] / sum) * left : left / free.length;
  }
  return out;
}

// Each pane's box (x, y, w, h: px from the room's corner) in a room width × height.
export function rects(n, grid, colFracs, rowFracs, width, height, gap = GAP) {
  if (grid.one) return Array.from({ length: n }, () => ({ x: 0, y: 0, w: width, h: height }));
  const cf = cleanFracs(colFracs, grid.cols);
  const rf = cleanFracs(rowFracs, grid.rows);
  const roomW = width - gap * (grid.cols - 1);
  const roomH = height - gap * (grid.rows - 1);
  const at = (fr, room, i) => fr.slice(0, i).reduce((s, f) => s + f, 0) * room + i * gap;
  const r2 = (v) => Math.round(v * 100) / 100;
  return cells(n, grid.cols).map(({ row, col, span }) => ({
    x: r2(at(cf, roomW, col)),
    y: r2(at(rf, roomH, row)),
    w: r2(cf.slice(col, col + span).reduce((s, f) => s + f, 0) * roomW + (span - 1) * gap),
    h: r2(rf[row] * roomH),
  }));
}

// The dividers of a grid: between columns (only as far down as panes meet there) and
// between rows. Each: { kind: 'col' | 'row', index (the column or row after it), x, y, w, h }.
export function dividers(n, grid, colFracs, rowFracs, width, height, gap = GAP) {
  if (grid.one || n < 2) return [];
  const cf = cleanFracs(colFracs, grid.cols);
  const rf = cleanFracs(rowFracs, grid.rows);
  const roomW = width - gap * (grid.cols - 1);
  const roomH = height - gap * (grid.rows - 1);
  const at = (fr, room, i) => fr.slice(0, i).reduce((s, f) => s + f, 0) * room + i * gap;
  const lastRow = n - (grid.rows - 1) * grid.cols; // panes in the last row
  const out = [];
  for (let b = 1; b < grid.cols; b += 1) {
    const rowsDown = b < lastRow ? grid.rows : grid.rows - 1;
    out.push({ kind: 'col', index: b, x: at(cf, roomW, b) - gap, y: 0, w: gap, h: rowsDown >= grid.rows ? height : at(rf, roomH, rowsDown) - gap });
  }
  for (let b = 1; b < grid.rows; b += 1) out.push({ kind: 'row', index: b, x: 0, y: at(rf, roomH, b) - gap, w: width, h: gap });
  return out;
}

// The shares after the divider before part b is dragged to pos px (along the room, from its
// start): only the two parts beside it change, each kept at least min px.
export function dragFracs(fracs, b, pos, total, min = MIN_PANE, gap = GAP) {
  const out = fracs.slice();
  const room = total - gap * (out.length - 1);
  if (!(room > 0) || b < 1 || b >= out.length) return out;
  const lo = Math.max(FRAC_MIN, min / room);
  const before = out.slice(0, b - 1).reduce((s, f) => s + f, 0);
  const pair = out[b - 1] + out[b];
  if (pair < 2 * lo) return out;
  const share = (pos - (b - 1) * gap - gap / 2) / room - before;
  out[b - 1] = Math.min(pair - lo, Math.max(lo, share));
  out[b] = pair - out[b - 1];
  return out;
}

// Where a chat dragged to (x, y) lands: { replace: i } (pane i shows it), { add: i, box,
// side } (a new pane at place i, by the left or right edge of pane box), or null.
export function dropTarget(x, y, boxes, max = MAX_PANES, edge = 0.22) {
  const list = boxes || [];
  for (let i = 0; i < list.length; i += 1) {
    const b = list[i];
    if (!b || !(b.w > 0) || x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) continue;
    const rel = (x - b.x) / b.w;
    if (list.length >= max) return { replace: i };
    if (list.length === 1) return rel >= 0.5 ? { add: 1, box: 0, side: 'right' } : { replace: 0 };
    if (rel < edge) return { add: i, box: i, side: 'left' };
    if (rel > 1 - edge) return { add: i + 1, box: i, side: 'right' };
    return { replace: i };
  }
  return null;
}

// The pane the focus moves to from pane `from`, in a direction (left, right, up, down), by
// where the boxes are; one pane at a time (one): the next or previous, round.
export function neighbor(boxes, from, dir, one = false) {
  const n = (boxes || []).length;
  if (n < 2 || from < 0 || from >= n) return from;
  if (one) return dir === 'right' || dir === 'down' ? (from + 1) % n : (from - 1 + n) % n;
  const c = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const a = boxes[from];
  const ac = c(a);
  let best = from;
  let bestScore = Infinity;
  boxes.forEach((b, i) => {
    if (i === from) return;
    const bc = c(b);
    const dx = bc.x - ac.x;
    const dy = bc.y - ac.y;
    const ahead = { left: -dx, right: dx, up: -dy, down: dy }[dir];
    if (!(ahead > 1)) return;
    const overlap = dir === 'left' || dir === 'right'
      ? Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      : Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    const score = (overlap > 0 ? 0 : 1e6) + ahead + across * 2;
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}

// The pane nearest the sidebar (top left; one at a time: the one on show), whose head carries
// the sidebar's toggle: it follows the pane there when the panes swap (placeSideToggle).
export function sidePane(boxes, focus = 0, one = false) {
  const list = boxes || [];
  if (!list.length) return 0;
  if (one) return focus >= 0 && focus < list.length ? focus : 0;
  let best = 0;
  let score = Infinity;
  list.forEach((b, i) => {
    const s = b ? (Number(b.x) || 0) * 4 + (Number(b.y) || 0) : Infinity; // leftmost, then topmost
    if (s < score) { score = s; best = i; }
  });
  return best;
}

const text = (v) => (typeof v === 'string' && v.length <= 64 && !/[\u0000-\u001f\u007f-\u009f]/.test(v) ? v : '');
const validId = (id) => {
  if (Number.isInteger(id) && id > 0 && id < 2 ** 31) return id;
  if (typeof id === 'string' && id.length > 0 && id.length <= 64 && !/[\u0000-\u001f\u007f-\u009f]/.test(id)) return id;
  return null;
};

export function cleanPane(s) {
  const o = s && typeof s === 'object' ? s : {};
  return {
    id: validId(o.id),
    key: text(o.key),
  };
}

function cleanShares(value, most) {
  if (!Array.isArray(value) || !value.length || value.length > most) return [];
  if (!value.every((f) => typeof f === 'number' && Number.isFinite(f) && f > 0)) return [];
  const kept = value.map((f) => Math.max(FRAC_MIN, Math.min(1, f)));
  const total = kept.reduce((s, f) => s + f, 0);
  return kept.map((f) => Math.round((f / total) * 1e4) / 1e4);
}
const index = (v, n) => (Number.isInteger(v) && v >= 0 && v < n ? v : 0);

// The split as storage keeps it, anything odd made safe. The two-pane split of before
// ({ left, right, ratio, focus: 'left' | 'right' }) comes in as its panes.
export function cleanState(value) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  let panes;
  let cols;
  let focus = v.focus;
  if (Array.isArray(v.panes)) {
    panes = v.panes.slice(0, MAX_PANES).map(cleanPane);
    cols = cleanShares(v.cols, MAX_COLS);
  } else {
    const old = 'left' in v || 'right' in v || 'ratio' in v;
    panes = old && (v.left || v.right) ? [cleanPane(v.left), cleanPane(v.right)] : [];
    const ratio = typeof v.ratio === 'number' && Number.isFinite(v.ratio) ? Math.min(0.8, Math.max(0.2, v.ratio)) : 0.5;
    cols = old ? cleanShares([ratio, 1 - ratio], MAX_COLS) : [];
    focus = v.focus === 'right' ? 1 : 0;
  }
  const n = panes.length;
  return {
    on: v.on === true && n >= 2,
    panes,
    own: index(v.own, n),
    focus: index(focus, n),
    cols,
    rows: cleanShares(v.rows, MAX_PANES),
    vertical: v.vertical !== false,
    hub: text(v.hub),
  };
}

// The chat/session a kept pane means now: the one with its key, else its id.
export function resolveSide(side, sameHub, ids, keyOf = () => '') {
  if (!side) return null;
  if (side.key) for (const id of ids) if (keyOf(id) === side.key) return id;
  return sameHub && side.id != null && ids.includes(side.id) ? side.id : null;
}

// The panes put back: each kept one's chat now (resolve(pane) → id or null); the window's
// own pane keeps its place, with its chat or, gone, the one the window shows (here).
// Panes whose chat is gone, or on show already, are left out; fewer than two: no split.
export function restorePanes(state, resolve, here) {
  const kept = state.panes[state.own];
  const found = kept ? resolve(kept) : null;
  const ownId = found != null ? found : here;
  const list = [];
  const seen = new Set(ownId != null ? [ownId] : []);
  let focus = 0;
  state.panes.forEach((p, i) => {
    const own = i === state.own;
    const empty = !own && p && p.id == null && !p.key;
    const id = own ? ownId : empty ? null : resolve(p);
    if (!own && !empty && (id == null || seen.has(id))) return;
    if (id != null) seen.add(id);
    if (i === state.focus) focus = list.length;
    list.push({ id, own });
  });
  const ok = state.on && list.length >= 2 && list.some((x) => x.own);
  return { ok, panes: ok ? list : [], focus: ok ? focus : 0 };
}

// What /split's words ask for.
export function splitCommand(arg) {
  const word = String(arg || '').trim();
  const lower = word.toLowerCase();
  if (!word) return { action: 'open' };
  if (lower === 'close') return { action: 'close' };
  if (['off', 'stop', 'exit', 'end'].includes(lower)) return { action: 'off' };
  if (lower === 'swap') return { action: 'swap' };
  if (lower === 'new') return { action: 'new' };
  if (['vertical', 'columns', 'cols'].includes(lower)) return { action: 'vertical' };
  if (['grid', 'squares', 'square'].includes(lower)) return { action: 'grid' };
  return { action: 'find', query: word };
}

// The chat /split <words> means: its number (#12) or id, its whole name, then the newest whose
// name has the words in it; never one of `skip`.
export function findSession(tasks, query, skip = []) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  const pool = (tasks || []).filter((t) => !skip.includes(t.id));
  const number = /^#?\d+$/.test(q) ? Number(q.replace('#', '')) : null;
  const byNumber = number != null && pool.find((t) => t.id === number);
  if (byNumber) return byNumber.id;
  const byId = pool.find((t) => String(t.id || '').toLowerCase() === q);
  if (byId) return byId.id;
  const named = (t) => String(t.title || t.prompt || '').trim().toLowerCase();
  const whole = pool.find((t) => named(t) === q);
  if (whole) return whole.id;
  const some = pool.filter((t) => named(t).includes(q)).sort((a, b) => (Number(b.updated) || Number(b.id) || 0) - (Number(a.updated) || Number(a.id) || 0))[0];
  return some ? some.id : null;
}

// The chats offered for an empty pane: not another pane's, not archived or temp; the latest first.
export function pickable(tasks, others, metaOf = () => ({})) {
  const skip = Array.isArray(others) ? others : [others];
  const when = (t) => String((metaOf(t.id) || {}).updated || t.updated || '');
  return (tasks || [])
    .filter((t) => !skip.includes(t.id) && !t.temp && !(metaOf(t.id) || {}).archived)
    .sort((a, b) => {
      if (typeof a.updated === 'number' && typeof b.updated === 'number' && b.updated !== a.updated) return b.updated - a.updated;
      return when(b).localeCompare(when(a)) || (Number(b.id) || 0) - (Number(a.id) || 0);
    });
}

// Where a chat asked for goes while the split shows (a sidebar click, a new chat):
// { focus: i } (pane i has it already: it takes the focus), { show: i }
// (into pane i, the focused one), or null (the window's own pane, as without a split).
export function route(ids, ownAt, focus, id) {
  if (id == null) return null;
  const at = ids.indexOf(id);
  if (at >= 0) return at === ownAt ? null : { focus: at };
  return focus !== ownAt ? { show: focus } : null;
}

// Pane k went by itself to chat id, which pane j shows: nothing is shown twice.
export function afterChange(ids, ownAt, k, id, previous) {
  if (id == null) return null;
  const j = ids.findIndex((x, i) => i !== k && x === id);
  if (j < 0) return null;
  const free = previous != null && previous !== id && !ids.includes(previous);
  if (k === ownAt) return free ? { pane: j, show: previous } : { close: j };
  return free ? { pane: k, show: previous, focus: j } : { close: k, focus: j };
}

// The mark on an unfocused pane's head: an answer it waits for beats news since you looked.
export function paneMark(asks, fresh) {
  return asks > 0 ? 'needs' : fresh ? 'new' : '';
}

// The split's keys: ⌘⇧\ adds a pane ('split'); ⌘\ is the sidebar's ('side');
// ⌘⌥ and an arrow move the focus ('move-left'…); ⌘1…⌘9 and ⌘0 pick a pane ('pane-1'…'pane-10').
export function keyAction(e) {
  if (!e || !e.metaKey || e.ctrlKey) return null;
  if (e.altKey) {
    if (e.shiftKey) return null;
    const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[e.key];
    return dir ? `move-${dir}` : null;
  }
  if (e.code === 'Backslash' || e.key === '\\' || e.key === '|') return e.shiftKey ? 'split' : 'side';
  if (e.shiftKey) return null;
  const digit = /^Digit([0-9])$/.exec(e.code || '') || /^Numpad([0-9])$/.exec(e.code || '') || /^([0-9])$/.exec(e.key || '');
  return digit ? `pane-${digit[1] === '0' ? '10' : digit[1]}` : null;
}

export function keyTarget(act, browserOpen, typing) {
  if (!act || !act.startsWith('pane-') || !browserOpen) return act;
  if (typing) return null;
  const n = act.slice(5);
  return n === '10' ? 'browser-zoom-reset' : `browser-tab${n}`;
}
