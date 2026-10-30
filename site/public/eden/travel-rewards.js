// Eden Rewards (site travel/rewards.js): points with no cash value, for Eden things only. The panel shows the balance and
// what expires soon, the status (Explorer, Voyager, Navigator) with its progress and benefits, the catalogue (each item
// says why it can't be had yet), what's active now, the ledger a page at a time, and the terms. Redeeming asks first;
// a redemption can be undone within 24 hours while unused (the server decides; the page only offers it).
//
// travel.js hands it its state and helpers through init, like travel-account.js: { S, paint }.

import { el, ico, toast } from './util.js';
import { tripPost } from './trip-ui.js';

let C = null;
export function init(ctx) { C = ctx; }

const err = (e) => toast(String((e && e.message) || e));
const n = (x) => Number(x || 0).toLocaleString();
const date = (iso) => (iso ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const st = () => (C.S.rewards ||= { open: false, data: null, busy: false, ask: null, page: 0, terms: false });

/** A ledger line in words: "Trip: Lisbon (4 days)", "Booking: flight", "Redeemed: A month of Eden Plus". */
export function entryText(e) {
  const m = e.meta || {};
  if (e.kind === 'earn') {
    if (e.reason === 'trip') return `Trip: ${m.title || 'a trip'} (${m.days} ${m.days === 1 ? 'day' : 'days'})`;
    if (e.reason === 'booking') return `Booking through Eden: ${m.kind || 'travel'}`;
    if (e.reason === 'share') return 'Memories shared with the people on the trip';
    if (e.reason === 'referral') return 'Someone you invited joined Plus';
    if (e.reason === 'accuracy') return 'A report that helped Eden’s checks';
    return 'Points earned';
  }
  if (e.kind === 'undo') return `Undone: ${ITEM[e.reason] || e.reason}`;
  if (e.kind === 'clawback') return `Booking cancelled or refunded: ${m.kind || 'travel'}`;
  return `Redeemed: ${ITEM[e.reason] || e.reason}`;
}
const ITEM = { plus_month: 'a month of Eden Plus', ai_extra: 'extra AI', priority_recheck: 'hourly re-checks', early_access: 'early access' };

/** Progress to the next status as 0–1: the better of trips and days. */
export function progressShare(p) {
  if (!p || !p.next) return 1;
  const t = p.trips.need ? p.trips.have / p.trips.need : 0;
  const d = p.days.need ? p.days.have / p.days.need : 0;
  return Math.max(0, Math.min(1, Math.max(t, d)));
}

/** Loads the panel's data (page: the ledger page); paints when done. */
export async function loadRewards(page = 0) {
  const R = st();
  R.busy = true;
  try { R.data = await tripPost('rewards', { page }); R.page = page; } catch (e) { err(e); }
  R.busy = false;
  C.paint();
}

/** Opens (and loads) the panel; travel.js calls it from its menu. */
export function openRewards() {
  const R = st();
  R.open = true;
  C.paint();
  loadRewards(0);
}

async function redeem(item, extra = {}) {
  const R = st();
  try {
    await tripPost('rewards-redeem', { item, ...extra, confirm: true });
    R.ask = null;
    toast(item === 'plus_month' ? 'Plus month added' : 'Redeemed. You can undo it for 24 hours if you haven’t used it.');
    await loadRewards(R.page);
  } catch (e) { err(e); }
}

async function undo(ref) {
  try { await tripPost('rewards-undo', { redemption: ref }); toast('Undone. The points are back.'); await loadRewards(st().page); } catch (e) { err(e); }
}

/** The panel, or null while closed. */
export function rewardsPanel() {
  const S = C.S, R = st();
  if (!R.open || S.member) return null;
  const d = R.data;
  return el('section', { class: 'glass-card tv-sheet tv-rewards', 'aria-label': 'Eden Rewards' },
    el('div', 'tv-card-head', el('span', 'tv-kicker accent', ico('spark', 12), 'Eden Rewards'),
      el('button', { type: 'button', class: 'tv-x', 'aria-label': 'Close Eden Rewards', 'data-k': 'close:rewards', onclick: () => { R.open = false; C.paint(); } }, ico('x', 14))),
    !d ? el('p', 'tv-note', R.busy ? 'Loading…' : 'Rewards didn’t load. Try again.') : null,
    d ? balanceBlock(d) : null,
    d ? tierBlock(d) : null,
    d ? activeBlock(d) : null,
    d ? catalogueBlock(d, R) : null,
    d ? earnBlock(d) : null,
    d ? ledgerBlock(d, R) : null,
    d ? termsBlock(d, R) : null);
}

function balanceBlock(d) {
  return el('div', { class: 'tv-rw-balance', style: { display: 'grid', gap: '4px', margin: '6px 0 12px' } },
    el('b', { style: { fontSize: '28px' } }, `${n(d.balance)} points`),
    el('small', 'tv-fine', 'No cash value. For Eden things only.'),
    ...(d.expiring || []).map((x) => el('small', 'tv-fine', `${n(x.points)} points expire on ${date(x.on)}. The oldest points are used first.`)),
    d.expired ? el('small', 'tv-fine', `${n(d.expired)} points have expired.`) : null);
}

function tierBlock(d) {
  const p = d.progress || {};
  const share = progressShare(p);
  return el('div', { class: 'tv-rw-tier', style: { display: 'grid', gap: '6px', margin: '0 0 12px' } },
    el('span', 'tv-kicker', 'Your status'),
    el('b', '', d.tier.name),
    el('small', 'tv-fine', `From ${d.tier.trips} ${d.tier.trips === 1 ? 'trip' : 'trips'} and ${d.tier.days} travel days that ended in the last 12 months.`),
    p.next ? el('div', { role: 'progressbar', 'aria-label': `Progress to ${p.next_name}`, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(share * 100)), style: { height: '6px', borderRadius: '3px', background: 'var(--line, rgba(127,127,127,.25))', overflow: 'hidden' } },
      el('div', { style: { width: `${Math.round(share * 100)}%`, height: '100%', background: 'var(--accent, currentColor)' } })) : null,
    el('small', 'tv-fine', p.text || ''),
    el('ul', { style: { margin: '0', paddingLeft: '18px' } }, ...(d.tier.benefits || []).map((b) => el('li', 'tv-fine', b))));
}

function activeBlock(d) {
  const a = d.active || {};
  const rows = [];
  if (a.plus_bonus && a.plus_bonus.running_until) rows.push(`Plus from points until ${date(a.plus_bonus.running_until)}.`);
  if (a.plus_bonus && a.plus_bonus.banked_days > 0) rows.push(`${a.plus_bonus.banked_days} days of Plus waiting. They start when your paid Plus ends.`);
  if (a.ai_extra_usd > 0) rows.push(`$${a.ai_extra_usd} of extra AI until ${date(a.ai_extra_until)}.`);
  for (const p of a.priority || []) rows.push(`Hourly re-checks for a trip, ${when(p.from)} to ${when(p.until)}.`);
  for (const f of a.early || []) rows.push(`Early access: ${f}.`);
  if (!rows.length) return null;
  return el('div', { style: { display: 'grid', gap: '4px', margin: '0 0 12px' } }, el('span', 'tv-kicker', 'Active now'), ...rows.map((r) => el('small', '', r)));
}

function catalogueBlock(d, R) {
  const S = C.S;
  return el('div', { style: { display: 'grid', gap: '8px', margin: '0 0 12px' } },
    el('span', 'tv-kicker', 'Use your points'),
    ...(d.catalogue || []).map((c) => {
      const asking = R.ask === c.item;
      // a trip for hourly re-checks: the one open now; a feature: the first listed
      const extra = c.item === 'priority_recheck' ? { trip: S.id || null } : c.item === 'early_access' && c.flags && c.flags[0] ? { flag: c.flags[0].flag } : {};
      const blocked = c.item === 'priority_recheck' && !S.id ? 'Open the trip first.' : null;
      return el('div', { class: 'tv-check', 'data-k': `rw:${c.item}`, style: { display: 'grid', gap: '4px' } },
        el('b', '', `${c.name} · ${n(c.points)} points`),
        el('small', 'tv-fine', c.about),
        c.why || blocked ? el('small', 'tv-fine', c.why || blocked) : null,
        !asking
          ? el('button', { type: 'button', class: 'tv-btn', disabled: !c.can || Boolean(blocked), onclick: () => { R.ask = c.item; C.paint(); } }, 'Redeem')
          : el('div', 'tv-acts',
            el('small', '', `Use ${n(c.points)} points for this? You can undo it within 24 hours if you haven’t used it.`),
            el('button', { type: 'button', class: 'tv-btn primary', onclick: () => redeem(c.item, extra) }, 'Yes, redeem'),
            el('button', { type: 'button', class: 'tv-btn quiet', onclick: () => { R.ask = null; C.paint(); } }, 'Cancel')));
    }));
}

function earnBlock(d) {
  const e = d.earn || {};
  const b = e.booking || {};
  return el('details', { style: { margin: '0 0 12px' } },
    el('summary', '', 'How you earn'),
    el('ul', { style: { margin: '4px 0', paddingLeft: '18px' } },
      el('li', 'tv-fine', `${e.tripDay} points a day for each trip you take with Eden, once it ends.`),
      el('li', 'tv-fine', `A booking through Eden: flight ${b.flight}, stay ${b.stay}, train or bus ${b.rail}, activity ${b.activity}. The same for any price.`),
      el('li', 'tv-fine', `Sharing a trip’s memories with the people on it: ${e.share}, once a trip.`),
      el('li', 'tv-fine', `Someone you invited to a trip joins Plus: ${e.referral}.`)),
    el('small', 'tv-fine', 'Voyager and Navigator earn more on trips and bookings.'));
}

function ledgerBlock(d, R) {
  const L = d.ledger || { entries: [] };
  return el('div', { style: { display: 'grid', gap: '6px', margin: '0 0 12px' } },
    el('span', 'tv-kicker', 'History'),
    !L.entries.length ? el('p', 'tv-note', 'Nothing yet. Points come once a trip ends, and with each booking made through Eden.') : null,
    ...L.entries.map((e) => el('div', { class: 'tv-check', style: { display: 'grid', gridTemplateColumns: '1fr auto', gap: '2px 8px' } },
      el('span', '', entryText(e)),
      el('b', '', `${e.amount > 0 ? '+' : ''}${n(e.amount)}`),
      el('small', 'tv-fine', `${when(e.at)}${e.expires ? ` · expires ${date(e.expires)}` : ''}${e.undone ? ' · undone' : ''}`),
      e.kind === 'redeem' && !e.undone && e.undo_until && Date.parse(e.undo_until) > Date.now()
        ? el('button', { type: 'button', class: 'tv-btn quiet', 'data-k': `rwundo:${e.ref}`, onclick: () => undo(e.ref) }, 'Undo') : null)),
    el('div', 'tv-acts',
      R.page > 0 ? el('button', { type: 'button', class: 'tv-btn quiet', onclick: () => loadRewards(R.page - 1) }, 'Newer') : null,
      L.more ? el('button', { type: 'button', class: 'tv-btn quiet', onclick: () => loadRewards(R.page + 1) }, 'Older') : null));
}

function termsBlock(d, R) {
  const T = d.terms || { points: [] };
  return el('details', { open: R.terms || undefined, ontoggle: (e) => { R.terms = e.target.open; } },
    el('summary', '', T.title || 'Eden Rewards terms'),
    el('small', 'tv-fine', T.status || ''),
    el('ul', { style: { margin: '4px 0', paddingLeft: '18px' } }, ...T.points.map((p) => el('li', 'tv-fine', p))));
}
