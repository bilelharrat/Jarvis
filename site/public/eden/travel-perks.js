// Eden Plus perks on the Eden Travel page (site travel/companions.js, yearinreview.js, cardperk.js):
//   "What Plus covers"   for the organiser, what the people on their trip get because of their Plus (and who turned
//                        flight alerts on); for a member, the same list as it stands for them, with the switch for
//                        flight changes on their own phone.
//   "Your year in travel" the year's trips, days away, places, straight-line distance, nights, flights, money per
//                        currency, price drops found, Eden's checks, points; each figure with what it's based on. A card
//                        drawn on the device (canvas → PNG). Private by default: places and money stay off the picture
//                        until the person ticks them, and nothing is uploaded.
//   "Best card for each booking" the per-trip summary (which card for each priced stop, the estimated points with the
//                        rate's source and date, the total), and the one line the pay step shows (bookingCardNote).
//
// travel.js hands it its state and helpers through init, like travel-more.js: { S, paint, money }.

import { el, toast } from './util.js';
import { tripPost } from './trip-ui.js';

let C = null;
export function init(ctx) { C = ctx; }

const err = (e) => String((e && e.message) || e);
const num = (n) => Number(n || 0).toLocaleString('en-GB');
const cash = (n, cur) => { try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n); } catch { return `${cur} ${Math.round(n)}`; } };
const cash2 = (n, cur) => { try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur }).format(n); } catch { return `${cur} ${Number(n).toFixed(2)}`; } };
const st = () => C.S.perks || (C.S.perks = { covers: null, coversKey: null, year: null, yearOf: null, card: null, cardKey: null, places: false, cash: false });

/* ---------- What Plus covers ---------- */

const MARK = { yes: 'Included', shared: 'While the organiser shares it', opt_in: 'When you turn it on', own: 'Needs your own Plus', no: 'Organiser only' };
/** The short label for how a feature is covered (organiser's view: as it is for the members). */
export const coverLabel = (c, member) => (member && c.covered === 'shared' ? (c.on ? 'Included: shared now' : 'Not shared now') : member && c.covered === 'opt_in' ? (c.on ? 'On' : 'Off') : MARK[c.covered] || c.covered);

export function coversPanel() {
  const S = C.S, P = st();
  if (!S.data) return null;
  const key = S.member ? `s:${S.member.owner}:${S.member.trip}` : `t:${S.id}`;
  if (P.coversKey !== key) {
    P.coversKey = key; P.covers = null;
    (S.member ? tripPost('shared-plus-covers', { owner: S.member.owner, trip: S.member.trip }) : tripPost('plus-covers', { id: S.id }))
      .then((r) => { if (P.coversKey === key) P.covers = r; }, (e) => { if (P.coversKey === key) P.covers = { error: err(e) }; }).then(() => C.paint());
  }
  const r = P.covers;
  const head = [el('span', 'tv-kicker', 'What Plus covers'),
    el('p', 'tv-note', S.member ? 'The organiser’s Eden Plus covers you on this trip. You don’t need Plus of your own for these.' : 'Your Eden Plus covers the people on this trip. They plan with you on their own Eden accounts, without Plus of their own.')];
  const box = (...kids) => el('section', { class: 'tv-perks glass-card', 'aria-label': 'What Plus covers', 'data-k': 'perks-covers' }, ...head, ...kids);
  if (!r) return box(el('p', 'tv-note', 'Loading…'));
  if (r.error) return box(el('p', 'tv-note', r.error));
  const rows = el('ul', { class: 'tv-perk-list', style: { listStyle: 'none', padding: '0', margin: '6px 0', display: 'grid', gap: '6px' } },
    ...r.covers.map((c) => el('li', { class: `tv-check ${c.covered === 'yes' || c.on ? 'ok' : c.gap ? 'warn' : 'look'}`, 'data-k': `cover:${c.key}` },
      el('i', ''),
      el('span', '', el('b', '', c.name), ` · ${coverLabel(c, Boolean(S.member))}`),
      el('small', '', c.how),
      S.member && c.key === 'alerts' ? alertsSwitch(Boolean(r.alerts)) : null)));
  const who = !S.member && (r.members || []).length
    ? el('p', 'tv-fine', `On this trip: ${r.members.map((m) => `${m.name}${m.alerts ? ' (flight alerts on)' : ''}`).join(', ')}.`)
    : !S.member ? el('p', 'tv-fine', 'Nobody has joined yet. Share an invite from Group.') : null;
  return box(rows, who, el('p', 'tv-fine', 'Members never see your cards, booking references or your other trips.'));
}

function alertsSwitch(on) {
  const S = C.S, P = st();
  const id = 'tvPerkAlerts';
  const sw = el('input', { type: 'checkbox', role: 'switch', id, ...(on ? { checked: '' } : {}), onchange: async (e) => {
    const want = e.target.checked;
    e.target.disabled = true;
    try {
      await tripPost('shared-alerts', { owner: S.member.owner, trip: S.member.trip, on: want });
      P.coversKey = null; // read again
      toast(want ? 'Flight changes on this trip will come to your phone.' : 'Flight alerts off for this trip.');
    } catch (x) { e.target.checked = !want; toast(err(x)); }
    e.target.disabled = false;
    C.paint();
  } });
  return el('label', { class: 'tv-fine', for: id, style: { gridColumn: '2', display: 'flex', gap: '6px', alignItems: 'center' } }, sw, 'Flight changes on my phone');
}

/* ---------- Your year in travel ---------- */

/**
 * The lines on the shareable card, private by default: counts only, unless `places` (city and country names) or `money`
 * (totals) are ticked. Each line { big, small }.
 */
export function yearLines(y, { places = false, money = false } = {}) {
  const s = y.stats;
  const out = [
    { big: num(s.trips), small: s.trips === 1 ? 'trip' : 'trips' },
    { big: num(s.days_away), small: 'days away' },
    { big: num(s.nights), small: 'nights' },
  ];
  if (s.countries.length) out.push({ big: num(s.countries.length), small: s.countries.length === 1 ? 'country' : 'countries' });
  if (s.cities.length) out.push({ big: num(s.cities.length), small: s.cities.length === 1 ? 'place' : 'places' });
  if (s.km > 0) out.push({ big: `${num(Math.round(s.km))} km`, small: 'between stops, straight lines' });
  if (s.flights) out.push({ big: num(s.flights), small: s.flights === 1 ? 'flight' : 'flights' });
  if (y.checks && y.checks.shown) out.push({ big: num(y.checks.shown), small: 'checks by Eden' });
  if (places) {
    const names = [...s.countries.map((c) => c.name), ...s.cities.map((c) => c.name)];
    if (names.length) out.push({ big: '', small: names.slice(0, 8).join(' · ') + (names.length > 8 ? ` +${names.length - 8}` : '') });
  }
  if (money && y.money) {
    const m = y.money.converted;
    if (m) out.push({ big: cash(m.total, m.currency), small: `spent, at ECB rates of ${m.date}` });
    else for (const c of y.money.currencies.slice(0, 3)) out.push({ big: cash(c.total, c.currency), small: 'spent' });
  }
  return out;
}

/** Draws the card on a 1080×1350 canvas context: navy, the year, the lines; the small print says what km means. */
export function drawYearCard(g, y, opts = {}) {
  const W = 1080, H = 1350;
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#0E2747'); grad.addColorStop(1, '#060d18');
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(216,180,90,.55)'; g.lineWidth = 3; g.strokeRect(36, 36, W - 72, H - 72); // the passport's gold frame
  g.fillStyle = '#fbf7ee';
  g.textBaseline = 'alphabetic';
  g.font = '600 34px "Instrument Sans", system-ui, sans-serif';
  g.fillText('Ask Eden Travel', 96, 140);
  g.font = '500 150px Fraunces, Georgia, serif';
  g.fillText(String(y.year), 96, 300);
  g.font = '400 40px "Instrument Sans", system-ui, sans-serif';
  g.fillStyle = '#ef7b6c';
  g.fillText('My year in travel', 96, 360);
  const lines = yearLines(y, opts);
  let yy = 470;
  for (const l of lines) {
    if (yy > H - 170) break;
    g.fillStyle = '#fbf7ee';
    if (l.big) {
      g.font = '600 64px Fraunces, Georgia, serif';
      g.fillText(l.big, 96, yy);
      const w = g.measureText(l.big).width;
      g.font = '400 34px "Instrument Sans", system-ui, sans-serif';
      g.fillStyle = 'rgba(251,247,238,.75)';
      g.fillText(l.small, 96 + w + 22, yy);
      yy += 92;
    } else {
      g.font = '400 32px "Instrument Sans", system-ui, sans-serif';
      g.fillStyle = 'rgba(251,247,238,.85)';
      g.fillText(fit(g, l.small, W - 192), 96, yy);
      yy += 70;
    }
  }
  g.font = '400 24px "Instrument Sans", system-ui, sans-serif';
  g.fillStyle = 'rgba(251,247,238,.6)';
  g.fillText('Distances are straight lines between planned stops. From Eden Travel.', 96, H - 96);
  return lines;
}
const fit = (g, s, w) => { let t = s; while (t.length > 4 && g.measureText(t).width > w) t = `${t.slice(0, -2)}…`; return t; };

export function yearPanel() {
  const P = st();
  const now = new Date().getFullYear();
  const year = P.yearOf || now;
  if (!P.year || P.year.year !== year) {
    if (!P.year || !P.year.loading) {
      P.year = { year, loading: true };
      tripPost('year', { year }).then((r) => { P.year = r; }, (e) => { P.year = { year, error: err(e) }; }).then(() => C.paint());
    }
  }
  const y = P.year;
  const pick = el('select', { class: 'tv-input', 'aria-label': 'Year', 'data-k': 'year-pick', onchange: (e) => { P.yearOf = Number(e.target.value); C.paint(); } },
    ...[now, now - 1, now - 2].map((v) => el('option', { value: String(v), ...(v === year ? { selected: '' } : {}) }, String(v))));
  const box = (...kids) => el('section', { class: 'tv-perks glass-card', 'aria-label': 'Your year in travel', 'data-k': 'perks-year' },
    el('div', 'tv-cards-head', el('span', 'tv-kicker', 'Your year in travel'), pick), ...kids);
  if (!y || y.loading) return box(el('p', 'tv-note', 'Loading…'));
  if (y.error) return box(el('p', 'tv-note', y.error));
  const s = y.stats;
  if (!s.trips) return box(el('p', 'tv-note', y.upcoming.length ? `No trips finished in ${y.year} yet. Still to come: ${y.upcoming.map((t) => t.title).join(', ')}.` : `No trips in ${y.year}.`));
  const fact = (label, value, basis) => el('li', '', el('b', '', value), ` ${label}`, basis ? el('small', { class: 'tv-fine', style: { display: 'block' } }, basis) : null);
  const money = y.money.converted
    ? fact('spent in all', `${cash(y.money.converted.total, y.money.converted.currency)}${y.money.converted.yours != null ? ` (your share ${cash(y.money.converted.yours, y.money.converted.currency)})` : ''}`, y.money.converted.note)
    : y.money.currencies.length ? fact('spent', y.money.currencies.map((c) => `${cash(c.total, c.currency)}${c.yours_known ? ` (yours ${cash(c.yours, c.currency)})` : ''}`).join(' · '), y.money.currencies.length > 1 ? 'Kept apart by currency: the exchange rates didn’t load.' : y.money.note) : null;
  const drops = y.savings.saved.length
    ? fact('saved on rebookings', y.savings.saved.map((x) => cash2(x.amount, x.currency)).join(' · '), 'Recorded when a cheaper rebooking went through.')
    : y.savings.drops_found.length ? fact('in cheaper prices found', y.savings.drops_found.map((x) => cash2(x.amount, x.currency)).join(' · '), y.savings.note) : null;
  const points = y.points && Array.isArray(y.points.points) && y.points.points.length
    ? fact('points earned', y.points.points.map((p) => `${num(p.amount)} ${p.unit}`).join(' · '), y.points.source ? `From ${y.points.source}.` : null)
    : y.card_estimate && y.card_estimate.totals.length ? fact('points, estimated', y.card_estimate.totals.map((t) => `≈ ${num(t.points)} ${t.unit}`).join(' · '), y.card_estimate.note) : null;
  const list = el('ul', { class: 'tv-year', style: { listStyle: 'none', padding: '0', margin: '6px 0', display: 'grid', gap: '8px' } },
    fact(s.trips === 1 ? 'trip' : 'trips', num(s.trips), s.shared_trips ? `${s.shared_trips} shared with you by the organiser.` : null),
    fact('days away', num(s.days_away), s.days_note),
    fact('nights', num(s.nights), null),
    s.countries.length ? fact(s.countries.length === 1 ? 'country' : 'countries', s.countries.map((c) => c.name).join(', '), s.countries_from) : null,
    s.cities.length ? fact(s.cities.length === 1 ? 'place' : 'places', s.cities.map((c) => c.name).join(', '), s.cities_from) : null,
    s.km > 0 ? fact('km between stops', num(Math.round(s.km)), s.km_note) : null,
    s.flights ? fact(s.flights === 1 ? 'flight' : 'flights', `${num(s.flights)}${s.flights_booked ? ` (${num(s.flights_booked)} booked)` : ''}`, s.flights_note) : null,
    money, drops,
    y.checks.shown ? fact('checks by Eden', `${num(y.checks.shown)}${y.checks.flagged ? `, ${num(y.checks.flagged)} flagged something` : ''}`, `${y.checks.note}${y.checks.reported_wrong ? ` You reported ${y.checks.reported_wrong} as wrong.` : ''}`) : null,
    points);

  // the shareable card: drawn here, saved by the person; places and money only when ticked
  const canvas = el('canvas', { width: '1080', height: '1350', class: 'tv-year-card', 'aria-label': `Your ${y.year} in travel, as a picture`, style: { width: '100%', maxWidth: '360px', borderRadius: '14px', display: 'block' } });
  const draw = () => { try { drawYearCard(canvas.getContext('2d'), y, { places: P.places, money: P.cash }); } catch { /* no canvas: the list above is the year */ } };
  draw();
  const tick = (key, label) => el('label', { class: 'tv-fine', style: { display: 'flex', gap: '6px', alignItems: 'center' } },
    el('input', { type: 'checkbox', 'data-k': `year:${key}`, ...(P[key] ? { checked: '' } : {}), onchange: (e) => { P[key] = e.target.checked; draw(); } }), label);
  const save = el('button', { type: 'button', class: 'tv-btn primary', 'data-k': 'year-save', onclick: () => {
    canvas.toBlob((b) => {
      if (!b) return toast('Couldn’t make the picture here.');
      const a = el('a', { href: URL.createObjectURL(b), download: `eden-travel-${y.year}.png` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    }, 'image/png');
  } }, 'Save picture');
  return box(list,
    y.upcoming.length ? el('p', 'tv-fine', `Still to come in ${y.year}: ${y.upcoming.map((t) => t.title).join(', ')} (not counted above).`) : null,
    y.unavailable_shared ? el('p', 'tv-fine', `${y.unavailable_shared} shared ${y.unavailable_shared === 1 ? 'trip isn’t' : 'trips aren’t'} available now, so ${y.unavailable_shared === 1 ? 'it isn’t' : 'they aren’t'} counted.`) : null,
    canvas,
    el('div', 'tv-acts', tick('places', 'Show places'), tick('cash', 'Show money'), save),
    el('p', 'tv-fine', 'Only you see this. The picture is made on this device and isn’t shared unless you send it.'));
}

/* ---------- Best card for each booking ---------- */

/** One booking's line: "Pay with Chase Sapphire Reserve: 4x, ≈ 1,500 points" and where the rate is from. */
export function perkLine(i) {
  const earn = i.points != null ? `≈ ${num(i.points)} ${i.unit}` : i.why;
  const conv = i.converted ? ` ${i.cost.currency} turned into US$${num(i.usd)} at the ECB rate of ${i.converted.date}.` : '';
  return {
    head: `${i.card}: ${i.rate}x on ${i.category}${i.guessed ? ' (guessed from the name)' : ''}`,
    earn: `${earn}${i.back != null ? ` (about US$${i.back.toFixed(2)} back ${i.back_how || ''})`.replace(' )', ')') : ''}`,
    basis: `Rate from the issuer’s page, checked ${i.checked}${i.stale ? ' (more than 90 days ago: may have changed)' : ''}.${conv}`,
    portal: i.portal ? `${i.portal.site} would earn ${i.portal.rate}x: ${i.portal.what}. That means booking there instead.` : null,
  };
}

export function cardPerkPanel() {
  const S = C.S, P = st();
  if (!S.data || S.member) return null; // a member never sees the organiser's cards
  const key = `${S.id}:${S.data.trip.rev}`;
  if (P.cardKey !== key) {
    P.cardKey = key; P.card = null;
    tripPost('card-perk', { id: S.id }).then((r) => { if (P.cardKey === key) P.card = r; }, (e) => { if (P.cardKey === key) P.card = { error: err(e) }; }).then(() => C.paint());
  }
  const r = P.card;
  const box = (...kids) => el('section', { class: 'tv-perks glass-card', 'aria-label': 'Best card for each booking', 'data-k': 'perks-cards' }, el('span', 'tv-kicker', 'Best card for each booking'), ...kids);
  if (!r) return box(el('p', 'tv-note', 'Loading…'));
  if (r.error) return box(el('p', 'tv-note', r.error));
  if (!r.cards) return box(el('p', 'tv-note', 'Add your cards (names only) under Pay with to see which one earns most on each booking.'));
  if (!r.items.length && !r.none.length) return box(el('p', 'tv-note', 'No priced stops on this trip yet.'));
  const rows = r.items.map((i) => {
    const l = perkLine(i);
    return el('li', { class: 'tv-cardrow', 'data-k': `perk:${i.stop}` },
      el('div', '', el('b', '', i.name), i.booked ? el('small', 'tv-fine', ' · booked') : null, el('div', 'tv-note', `${cash2(i.cost.amount, i.cost.currency)} · ${l.head}`), el('div', 'tv-note', l.earn), el('small', 'tv-fine', l.basis), l.portal ? el('small', { class: 'tv-fine', style: { display: 'block' } }, l.portal) : null));
  });
  const total = r.totals.length ? el('p', '', el('b', '', 'Total: '), r.totals.map((t) => `≈ ${num(t.points)} ${t.unit}`).join(' · '), r.value ? ` (about US$${num(Math.round(r.value.amount))} back where the issuer states a value)` : '') : null;
  return box(el('ul', { style: { listStyle: 'none', padding: '0', margin: '6px 0', display: 'grid', gap: '8px' } }, ...rows), total,
    r.none.length ? el('p', 'tv-note', `No checked rates for your cards on: ${r.none.map((x) => x.name).join(', ')}.`) : null,
    el('p', 'tv-fine', r.note));
}

/**
 * The pay step's line (trip-ui.js booking cards, before payFirst): which saved card to pay this stop with and what it
 * should earn, at `cost` (the quote's { amount, currency }) when given, else the plan's price. Resolves to an element, or null when there's nothing to say (no cards, no price, a member's trip).
 */
export async function bookingCardNote({ id, stop, cost = null }) {
  if (!id || !stop) return null;
  let r;
  try { r = await tripPost('card-perk', { id, stop, ...(cost ? { cost } : {}) }); } catch { return null; }
  const i = r && r.items && r.items[0];
  if (!i) return null;
  const l = perkLine(i);
  return el('div', { class: 'tv-perk-pay', 'data-k': `perkpay:${stop}`, role: 'note' },
    el('b', '', `Pay with ${i.card}`), el('div', 'tv-note', `${l.earn}. ${i.rate}x on ${i.category}.`), el('small', 'tv-fine', l.basis), l.portal ? el('small', { class: 'tv-fine', style: { display: 'block' } }, l.portal) : null);
}
