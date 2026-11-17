// Eden Mail with several accounts (ROADMAP Y, docs/mail-multi-account/plan.html): the pure parts,
// with no imports (tested in src/__tests__/mail-merge.test.ts). mail-accounts.js draws the accounts;
// mail.js and compose.js use these to merge, key and route.
//
// A mailbox is 'primary' (the first Gmail, askeden.com's `google_data`, as before) or an extra one's
// id ('m' and 12 hex digits). Keys: an email of the first Gmail keeps today's `gmail:<id>` (so Eden's
// saved ranks, summaries, snoozes and drafts stay), another mailbox's is `gmail:<mailbox>:<id>`.

export const PRIMARY = 'primary';
export const MBOX_ID = /^m[0-9a-f]{12}$/;
/** The colours a mailbox can have (the server's MBOX_COLORS), drawn by mail.css `.mbx-<colour>`. */
export const COLORS = ['indigo', 'teal', 'pink', 'purple', 'brown', 'green', 'orange', 'blue'];
export const COLOR_NAMES = { indigo: 'Indigo', teal: 'Teal', pink: 'Pink', purple: 'Purple', brown: 'Brown', green: 'Green', orange: 'Orange', blue: 'Blue' };

export const isExtra = (box) => typeof box === 'string' && MBOX_ID.test(box);
/** The mailbox a call goes to: undefined for the first Gmail (the server's default), else its id. */
export const wireBox = (box) => (isExtra(box) ? box : undefined);

/** Eden's key for an email (caches, snoozes, reminders): the first Gmail's stay as they were. */
export function boxKey(source, box, id) {
  return source === 'gmail' && isExtra(box) ? `gmail:${box}:${id}` : `${source}:${id}`;
}
/** boxKey's parts back: { source, box, id }. */
export function parseBoxKey(key) {
  const s = String(key || '');
  const i = s.indexOf(':');
  if (i < 0) return { source: '', box: PRIMARY, id: s };
  const source = s.slice(0, i), rest = s.slice(i + 1);
  const j = rest.indexOf(':');
  if (source === 'gmail' && j > 0 && isExtra(rest.slice(0, j))) return { source, box: rest.slice(0, j), id: rest.slice(j + 1) };
  return { source, box: PRIMARY, id: rest };
}

/** What a mailbox is called in Mail: its name, else its address. */
export function boxName(b) {
  if (!b) return 'Gmail';
  return (b.label && String(b.label).trim()) || b.email || 'Gmail';
}

const time = (r) => { const t = Date.parse(r && r.date); return Number.isFinite(t) ? t : -Infinity; };
/** One email delivered to two of your mailboxes has the same sender, subject and Date header. */
const dupKey = (r) => (r && r.date ? `${String(r.from || '').toLowerCase()}\n${String(r.subject || '')}\n${r.date}` : null);

/**
 * All inboxes: every mailbox's newest rows, tagged with their mailbox and merged newest first.
 * `lists`: [{ box, rows }] in the sidebar's order; `page`: how many each mailbox was asked for.
 * - A mailbox that filled its page may have older mail not fetched yet, so nothing older than the
 *   newest of those "last fetched" dates is shown (no hole where one account's older mail is missing);
 *   `cut` says how many were held back.
 * - The same email in two mailboxes shows once (the first mailbox's), `alsoIn` naming the others.
 */
export function mergeMailboxes(lists, { page = 30 } = {}) {
  let horizon = -Infinity;
  for (const { rows } of lists) {
    const list = rows || [];
    if (list.length >= page) horizon = Math.max(horizon, Math.min(...list.map(time)));
  }
  const all = [];
  let order = 0;
  for (const { box, rows } of lists) for (const r of rows || []) all.push({ r: { ...r, box }, t: time(r), o: order++ });
  all.sort((a, b) => b.t - a.t || a.o - b.o);
  const seen = new Map();
  const rows = [];
  let cut = 0;
  for (const { r, t } of all) {
    if (t < horizon) { cut++; continue; }
    const k = dupKey(r);
    const first = k ? seen.get(k) : null;
    if (first) {
      if (first.box !== r.box && !(first.alsoIn || []).includes(r.box)) first.alsoIn = [...(first.alsoIn || []), r.box];
      continue;
    }
    if (k) seen.set(k, r);
    rows.push(r);
  }
  return { rows, cut };
}

/** Ids by mailbox (Done, snooze, read on rows from several accounts: one call per mailbox). */
export function groupByBox(ids, boxOf) {
  const out = new Map();
  for (const id of ids) {
    const b = boxOf(id) || PRIMARY;
    if (!out.has(b)) out.set(b, []);
    out.get(b).push(id);
  }
  return out;
}

/** Unread rows per mailbox: { [box]: n }. */
export function unreadByBox(rows) {
  const out = {};
  for (const r of rows || []) if (r && r.unread) out[r.box || PRIMARY] = (out[r.box || PRIMARY] || 0) + 1;
  return out;
}

/**
 * The mailbox a new email is sent from: the one in view; in All inboxes the one last sent from, if
 * it's still there and working; else the first Gmail. A reply's is always the mailbox it came to.
 */
export function sendFrom({ message, current, last, boxes }) {
  const ok = (id) => (boxes || []).some((b) => b.id === id && b.status !== 'reconnect');
  if (message && message.box) return message.box;
  if (current && current !== 'all' && ok(current)) return current;
  if (last && ok(last)) return last;
  const first = (boxes || []).find((b) => b.status !== 'reconnect');
  return first ? first.id : PRIMARY;
}

/**
 * The mailbox Mail uses when nothing names one: the first Gmail when it's connected (or there's nothing
 * else), else (no Gmail at all: IMAP or Outlook only) the first working mailbox, else the first.
 */
export function homeBoxOf({ gmail, boxes }) {
  const list = boxes || [];
  if (gmail || !list.length) return PRIMARY;
  return (list.find((b) => b.status !== 'reconnect') || list[0]).id;
}

/** The mailbox among `boxes` whose address is one of `addresses` (who an email was sent to), or null. */
export function boxForAddress(addresses, boxes) {
  const mine = new Map((boxes || []).filter((b) => b.email).map((b) => [String(b.email).toLowerCase(), b.id]));
  for (const a of addresses || []) {
    const m = /<([^<>]+)>\s*$/.exec(String(a));
    const e = (m ? m[1] : String(a)).trim().toLowerCase();
    if (mine.has(e)) return mine.get(e);
  }
  return null;
}
