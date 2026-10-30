// "Money back for a delay" on the Eden Travel page (site travel/compensation.js, ops trip-claims and trip-claim-letter):
// for each flight on the trip that has flown, whether EU261, UK261, Canada's APPR or the US refund rules likely give
// money back, how much, why, and what would make them not apply, each with its official source and the day it was
// read. "Likely eligible", never "owed". The letter view has the claim ready to copy and the airline's own claim page
// when Eden knows it; the person sends it themselves (Eden never contacts the airline). A Plus perk; no partner.
//
// travel.js hands it its state and helpers through init, like travel-more.js: { S, paint }.

import { el, ico, toast } from './util.js';
import { tripPost } from './trip-ui.js';

let C = null;
export function init(ctx) { C = ctx; }

const err = (e) => toast(String((e && e.message) || e));
const SYM = { EUR: '€', GBP: '£', CAD: 'CA$' };
const cash = (cur, v) => `${SYM[cur] || `${cur} `}${Number(v).toLocaleString()}`;
const VERDICT = { likely: 'Likely eligible', check: 'Worth checking', unlikely: 'Unlikely', not_covered: 'Not covered', too_early: 'Not landed yet' };

/** The amount line for one law: "€400 (or €200 if …)", a range, or the refund. */
export function amountText(l) {
  if (!l) return '';
  if (l.kind === 'refund') return 'A refund of the fare, taxes and fees';
  const a = l.amount;
  if (!a) return '';
  if (a.value) return `${cash(a.currency, a.value)} a passenger${a.half ? ` (${cash(a.currency, a.half)} if ${a.half_if})` : ''}`;
  if (a.range) return `${cash(a.currency, a.range[0])} to ${cash(a.currency, a.range[1])} a passenger${a.why ? `: ${a.why}` : ''}`;
  return '';
}

function state() {
  const S = C.S;
  if (!S.claims || S.claims.id !== S.id) S.claims = { id: S.id, data: null, facts: {}, open: null, letter: null, names: '' };
  return S.claims;
}

function load(force = false) {
  const K = state();
  if (K.data && !force) return;
  K.data = { loading: true };
  tripPost('claims', { id: C.S.id, facts: K.facts }).then((r) => { K.data = r; C.paint(); }, (e) => { K.data = { error: String(e.message || e) }; C.paint(); });
}

/** The trip view's card: shown once a flight on the trip has flown (null otherwise, and for people on a shared trip). */
export function claimsCard() {
  const S = C.S;
  if (S.member || !S.id || S.offline) return null;
  const K = state();
  if (K.letter) return letterView();
  load();
  const r = K.data;
  if (r && !r.loading && !r.error && (!Array.isArray(r.claims) || !r.claims.length)) return null;
  return el('section', { class: 'tv-disc glass-card', 'aria-label': 'Money back for a delay' },
    el('div', 'tv-card-head', el('span', 'tv-kicker', 'Money back for a delay'), r && r.claims ? el('span', 'tv-fine', `Rules read ${r.checked}`) : null),
    !r || r.loading ? el('p', 'tv-note', 'Looking…')
      : r.error ? el('p', 'tv-note warn', r.error)
      : el('ul', 'tv-disc-list', ...(r.claims || []).map((c, i) => row(c, i))),
    r && r.note ? el('p', 'tv-fine', r.note) : null);
}

function row(c, i) {
  const K = state();
  const a = c.assessment;
  const title = `${c.ident} · ${new Date(`${c.date}T00:00:00Z`).toLocaleDateString([], { day: 'numeric', month: 'short', timeZone: 'UTC' })}`;
  if (!a) return el('li', { class: 'tv-place', style: { '--i': Math.min(i, 9) } }, el('div', 'tv-place-main', el('b', '', title), el('span', 'tv-meta', c.why || 'No flight status for it.')));
  const best = a.laws[0];
  const open = K.open === c.stop;
  const route = [a.route.from, a.route.to].filter(Boolean).join(' → ');
  const sub = [route, a.distance_km ? `${a.distance_km.toLocaleString()} km` : null, a.arrival_delay_min ? `${Math.floor(a.arrival_delay_min / 60)} h ${a.arrival_delay_min % 60} min late` : a.what === 'cancelled' ? 'cancelled' : null].filter(Boolean).join(' · ');
  return el('li', { class: 'tv-place', style: { '--i': Math.min(i, 9) } },
    el('div', 'tv-place-main',
      el('b', '', title), el('span', 'tv-meta', `${VERDICT[a.verdict] || a.verdict}${sub ? ` · ${sub}` : ''}`),
      el('p', '', a.headline),
      best && amountText(best) ? el('small', '', amountText(best)) : null,
      a.data ? el('small', 'tv-fine', `${a.data.source}, ${a.data.checked_at ? new Date(a.data.checked_at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}`) : null,
      el('div', 'tv-acts',
        el('button', { type: 'button', class: 'tv-btn', 'aria-expanded': String(open), 'data-k': `claim-why:${c.stop}`, onclick: () => { K.open = open ? null : c.stop; C.paint(); } }, open ? 'Hide why' : 'Why'),
        best && best.verdict !== 'unlikely' && best.verdict !== 'not_covered' ? el('button', { type: 'button', class: 'tv-btn primary', 'data-k': `claim-letter:${c.stop}`, onclick: () => { K.letter = { stop: c.stop, ident: c.ident, out: null }; C.paint(); } }, 'Prepare the claim') : null),
      open ? details(c, a) : null));
}

function details(c, a) {
  const K = state();
  const f = K.facts[c.stop] || (K.facts[c.stop] = {});
  const ask = a.laws.map((l) => l.ask).find(Boolean);
  const redo = () => { load(true); C.paint(); };
  return el('div', 'tv-claim-why',
    ...a.laws.map((l) => el('div', '',
      el('span', 'tv-kicker', `${l.name}: ${VERDICT[l.verdict] || l.verdict}`),
      el('ul', '', ...l.why.map((w) => el('li', '', w))),
      l.not_if && l.not_if.length ? el('details', '', el('summary', '', 'What would make it not apply'), el('ul', '', ...l.not_if.map((w) => el('li', '', w)))) : null,
      el('small', 'tv-fine', ...l.sources.flatMap((s, i) => [i ? ' · ' : '', el('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.title)]), ` (read ${l.sources[0] ? l.sources[0].checked : ''})`))),
    ...(a.notes || []).map((n) => el('p', 'tv-note', n)),
    a.distance_how ? el('small', 'tv-fine', a.distance_how) : null,
    el('div', 'tv-claim-facts',
      ask ? el('p', 'tv-note', ask) : null,
      a.what === 'cancelled' ? el('label', 'tv-fine', 'Days before departure the airline told you ', el('input', { type: 'number', min: '0', max: '365', class: 'tv-input small', value: f.notice_days ?? '', onchange: (e) => { f.notice_days = e.target.value === '' ? undefined : Number(e.target.value); redo(); } })) : null,
      el('label', 'tv-fine', el('input', { type: 'checkbox', ...(f.denied_boarding ? { checked: '' } : {}), onchange: (e) => { f.denied_boarding = e.target.checked || undefined; redo(); } }), ' I was denied boarding (not as a volunteer)')));
}

/** The letter view: names in, the letter out, ready to copy; the airline's claim page when Eden knows it. */
export function letterView() {
  const K = state();
  const L = K.letter;
  const close = el('button', { type: 'button', class: 'tv-x', 'aria-label': 'Close the claim', 'data-k': 'close:claim', onclick: () => { K.letter = null; C.paint(); } }, ico('x', 14));
  const names = el('input', { class: 'tv-input', placeholder: 'Passenger names, as on the booking, separated by commas', value: K.names, 'aria-label': 'Passenger names' });
  const ref = el('input', { class: 'tv-input small', placeholder: 'Booking reference (optional)', value: L.ref || '', 'aria-label': 'Booking reference' });
  const make = async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    K.names = names.value; L.ref = ref.value.trim();
    try {
      L.out = await tripPost('claim-letter', { id: C.S.id, stop: L.stop, passengers: names.value.split(',').map((s) => s.trim()).filter(Boolean), booking_ref: L.ref || undefined, facts: K.facts[L.stop] || {} });
    } catch (e2) { err(e2); }
    btn.disabled = false;
    C.paint();
  };
  const o = L.out;
  return el('section', { class: 'tv-disc glass-card', 'aria-label': `Claim for ${L.ident}` },
    el('div', 'tv-card-head', el('span', 'tv-kicker', `Claim for ${L.ident}`), close),
    el('div', 'tv-claim-form', names, ref, el('button', { type: 'button', class: 'tv-btn primary', onclick: make }, o ? 'Write it again' : 'Write the letter')),
    o ? el('div', '',
      el('p', 'tv-note', `${o.law}${o.amount && o.amount.value ? `: ${cash(o.amount.currency, o.amount.value)} a passenger` : ''}. ${o.sends}`),
      el('textarea', { class: 'tv-input tv-claim-letter', readonly: '', rows: '16', 'aria-label': 'The claim letter' }, o.letter),
      el('div', 'tv-acts',
        el('button', { type: 'button', class: 'tv-btn', onclick: () => navigator.clipboard.writeText(`${o.subject}\n\n${o.letter}`).then(() => toast('Letter copied'), () => toast('Couldn’t copy')) }, ico('copy', 12), 'Copy'),
        o.to.form_url ? el('a', { class: 'tv-btn primary', href: o.to.form_url, target: '_blank', rel: 'noopener' }, ico('ext', 12), `Open ${o.to.airline}’s claim page`) : null),
      el('small', 'tv-fine', o.to.form_source)) : null);
}
