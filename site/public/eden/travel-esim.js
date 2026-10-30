// Mobile data on the Eden Travel page (site travel/esim.js, ops trip-esim, trip-esim-check, trip-esims): travel eSIM
// plans for the trip's countries and dates, each with its data, how many days it lasts, the partner's price, the
// countries it covers and whether that's all of the trip's. Buying one is paid by the traveller's card first
// (trip-ui.js payFirst, pay.js kind 'esim'); without payments on, nothing is bought. A bought eSIM's installation
// details (the code its QR holds, the SM-DP+ address and activation code, Apple's install link) are shown from the
// server and kept in this browser too, so they open on arrival without a connection. With no partner keys, the block
// says which partners would show here and that they're off.
//
// travel.js hands it its state and helpers through init, like travel-activities.js: { S, paint, money2 }.

import { el, ico, toast, copyText } from './util.js';
import { tripPost, payFirst } from './trip-ui.js';

let C = null;
export function init(ctx) { C = ctx; }

const err = (e) => toast(String((e && e.message) || e));
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const day = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString([], { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');
const money = (p) => (C.money2 ? C.money2(p.amount, p.currency) : `${p.currency} ${p.amount}`);
const KEEP = (id) => `eden.trip.esims.${id}`;

/** This browser's copy of a trip's eSIMs (for no connection); never required. */
const kept = {
  get(id) { try { const v = JSON.parse(localStorage.getItem(KEEP(id)) || 'null'); return v && Array.isArray(v.esims) ? v : null; } catch { return null; } },
  set(id, v) { try { localStorage.setItem(KEEP(id), JSON.stringify(v)); } catch { /* storage off or full */ } },
};

function state() {
  const S = C.S;
  return S.esim || (S.esim = { data: new Map(), mine: new Map(), countries: null, edit: false, open: null, busy: null });
}

function load(E, key, args) {
  if (E.data.has(key)) return E.data.get(key);
  E.data.set(key, null);
  tripPost('esim', args).then((r) => { E.data.set(key, r); C.paint(); }, (e) => { E.data.set(key, { error: String(e.message || e), code: e.code }); C.paint(); });
  return null;
}
function mine(E, id) {
  if (E.mine.has(id)) return E.mine.get(id);
  E.mine.set(id, kept.get(id));
  tripPost('esims', { id }).then((r) => { const v = { esims: r.esims || [], at: new Date().toISOString() }; kept.set(id, v); E.mine.set(id, v); C.paint(); }, () => { /* offline: the kept copy */ });
  return E.mine.get(id);
}

/** The trip's "Mobile data" block. Returns null for a member who isn't the organiser. */
export function mobileDataSection() {
  const S = C.S;
  if (S.member) return null;
  const E = state();
  const id = S.id;
  const key = `${id}:${E.countries ? E.countries.join(',') : ''}`;
  const r = load(E, key, { id, ...(E.countries ? { countries: E.countries } : {}) });
  const have = mine(E, id);
  return el('section', { class: 'tv-disc glass-card', 'aria-label': 'Mobile data' },
    el('div', 'tv-card-head', el('span', 'tv-kicker', 'Mobile data'),
      r && r.countries ? el('button', { type: 'button', class: 'tv-btn', 'aria-expanded': String(E.edit), onclick: () => { E.edit = !E.edit; C.paint(); } }, 'Countries') : null),
    have && have.esims.length ? el('div', '', ...have.esims.map((x) => installCard(x, E))) : null,
    E.edit || (r && r.code === 'countries_needed') ? countriesForm(E, r) : null,
    body(r, E));
}

function countriesForm(E, r) {
  const now = (r && r.countries ? r.countries.map((c) => c.code) : E.countries || []).join(', ');
  const input = el('input', { class: 'tv-input small', value: now, placeholder: 'PT, ES', 'aria-label': 'Countries, as two-letter codes', autocapitalize: 'characters' });
  return el('form', { class: 'tv-acts', onsubmit: (e) => {
    e.preventDefault();
    const list = input.value.split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
    if (!list.length || !list.every((x) => /^[A-Z]{2}$/.test(x))) return toast('Two-letter country codes, like PT, ES');
    E.countries = list; E.edit = false; C.paint();
  } }, input, el('button', { type: 'submit', class: 'tv-btn' }, 'Show plans'));
}

function body(r, E) {
  if (r === null || r === undefined) return el('p', 'tv-note', 'Looking…');
  if (r.error) return el('p', 'tv-note warn', r.code === 'countries_needed' ? 'Which countries? Add their two-letter codes.' : r.error);
  const on = r.partners.filter((p) => p.on);
  const off = r.partners.filter((p) => !p.on);
  const out = [];
  const names = r.countries.map((c) => c.name).join(', ');
  out.push(el('p', 'tv-fine', `${names}${r.countries_from === 'destination' ? ' (from the trip’s destination)' : ''} · ${day(r.start)} to ${day(r.end)}${r.days ? `, ${r.days} days` : ''}`));
  if (!on.length) {
    out.push(el('p', 'tv-note', 'Travel eSIM plans will show here, with data, days and price for these countries. They aren’t switched on yet.'));
    return el('div', '', ...out);
  }
  for (const p of on) {
    out.push(el('div', 'tv-card-head', el('span', 'tv-kicker', p.name), el('span', 'tv-fine', `${p.results[0] ? p.results[0].source : p.source} · ${when(p.checked_at)}`)));
    if (p.error) out.push(el('p', 'tv-note warn', p.error));
    else if (!p.results.length) out.push(el('p', 'tv-note', `${p.name} has no plan for these countries.`));
    else out.push(el('ul', 'tv-disc-list', ...p.results.map((x, i) => card(x, i, r, E))));
    if (p.id === 'esimgo' && p.results.length) out.push(el('p', 'tv-fine', 'eSIM Go sells to businesses: its figure is its price to Eden, shown to compare. It isn’t sold here.'));
  }
  if (off.length) out.push(el('p', 'tv-fine', `${off.map((p) => p.name).join(' and ')}: not switched on yet.`));
  out.push(el('p', 'tv-fine', 'Your phone must take eSIMs and be unlocked. Prices are the partner’s, checked again before you pay.'));
  return el('div', '', ...out);
}

function card(x, i, r, E) {
  const all = r.countries.length > 1 ? (x.covers_all ? 'Covers all your countries' : `Covers ${x.covers_trip.join(', ')} only`) : null;
  const sub = [
    x.unlimited ? 'Unlimited data' : x.data_text,
    x.validity_days ? `${x.validity_days} days` : x.duration_text,
    x.price ? money(x.price) : x.cost ? `${money(x.cost)} to Eden` : null,
    all,
    x.lasts_trip === false ? 'Shorter than your trip' : null,
  ].filter(Boolean).join(' · ');
  const notes = [
    x.fair_use,
    x.area !== 'country' && x.area_name ? `${x.area_name} plan, ${x.covers.length} countries` : null,
    x.networks && x.networks.length ? `Networks: ${x.networks.join(', ')}` : null,
    x.roaming ? 'Turn on data roaming for it' : null,
    x.install_within_days ? `Install it within ${x.install_within_days} days of buying` : null,
    x.top_up ? 'Can be topped up' : null,
  ].filter(Boolean).join(' · ');
  const buying = E.busy === x.id;
  return el('li', { class: 'tv-place', style: { '--i': Math.min(i, 9) } },
    el('div', 'tv-place-main', el('b', '', x.operator ? `${x.title} · ${x.operator}` : x.title), sub ? el('span', 'tv-meta', sub) : null,
      x.about ? el('p', '', x.about) : null, notes ? el('small', '', notes) : null,
      x.orderable && x.price ? el('div', 'tv-acts', el('button', { type: 'button', class: 'tv-btn primary', disabled: buying ? '' : null, onclick: () => buy(x, E) }, buying ? 'Checking the price…' : `Buy for ${money(x.price)}`)) : null));
}

/** The price read again at the partner, then the card held at Stripe (pay.js); Eden buys once the hold is in. */
async function buy(x, E) {
  const S = C.S;
  E.busy = x.id; C.paint();
  try {
    const chk = await tripPost('esim-check', { id: S.id, package_id: x.id });
    const same = x.price && chk.price && chk.price.amount === x.price.amount && chk.price.currency === x.price.currency;
    if (!same && !confirm(`The price is now ${money(chk.price)} (was ${money(x.price)}). Continue?`)) return;
    await payFirst('esim', { check_id: chk.check_id, id: S.id }, () => { throw new Error('Buying an eSIM needs card payments, which aren’t switched on here yet.'); });
  } catch (e) { err(e); } finally { E.busy = null; C.paint(); }
}

/** A bought eSIM: how to install it (works from this browser's copy without a connection). */
function installCard(x, E) {
  const s = x.sims && x.sims[0];
  const open = E.open === x.order_id;
  const row = (label, value) => (value ? el('div', 'tv-acts', el('span', 'tv-fine', label), el('code', '', value), el('button', { type: 'button', class: 'tv-btn', 'aria-label': `Copy ${label}`, onclick: () => copyText(value).then(() => toast(`${label} copied`), err) }, ico('copy', 12))) : null);
  return el('div', 'tv-place',
    el('div', 'tv-place-main',
      el('b', '', `${x.title}${x.test ? ' (test eSIM, can’t be installed)' : ''}`),
      el('span', 'tv-meta', [x.data_text, x.validity_days ? `${x.validity_days} days` : null, x.install_by ? `Install by ${day(x.install_by)}` : null, `Order ${x.code || x.order_id}`].filter(Boolean).join(' · ')),
      el('div', 'tv-acts',
        s && s.apple_url && !x.test ? el('a', { class: 'tv-btn primary', href: s.apple_url, target: '_blank', rel: 'noopener' }, 'Install on iPhone') : null,
        el('button', { type: 'button', class: 'tv-btn', 'aria-expanded': String(open), onclick: () => { E.open = open ? null : x.order_id; C.paint(); } }, open ? 'Hide details' : 'Install details')),
      open && s ? el('div', '',
        row('Activation code (what the QR holds)', s.lpa),
        row('SM-DP+ address', s.smdp),
        row('Activation code', s.activation_code),
        row('Confirmation code', s.confirmation_code),
        s.apn ? el('p', 'tv-fine', `Set the APN to ${s.apn} by hand.`) : null,
        s.roaming ? el('p', 'tv-fine', 'Turn on data roaming for this eSIM.') : null,
        x.doc ? el('p', 'tv-fine', 'The QR code is in this trip’s documents.') : null,
        x.steps ? el('p', 'tv-fine', x.steps) : null,
        x.guide_url ? el('a', { href: x.guide_url, target: '_blank', rel: 'noopener', class: 'tv-fine' }, ico('ext', 12), 'Airalo’s install guide') : null,
        el('p', 'tv-fine', `${x.source} · ${when(x.checked_at)}`)) : null));
}
