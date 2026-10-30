// Travellers' papers and each trip's entry checklist (site travel/papers.js, rules in travel/entry-rules.js).
// Papers live in the Travel profile: per traveller a name, the passport's country and expiry date (the issue date if
// they like), and the expiry of any approval they hold (ESTA, eTA, UK ETA, Australia ETA or eVisitor, NZeTA). Never a
// passport or application number. The trip's checklist says, per traveller and country, what is needed and by when,
// each line with its official source and the day the rule was verified; anything Eden has no rule for links the
// official page instead. What still needs doing goes into Decisions left (entryDecisions).
//
// travel.js hands it its state and helpers through init, like travel-account.js: { S, paint, openProfile? }.
//   Travel profile panel: papersBlock() next to the loyalty blocks; loadPapers() with the panel's other loads.
//   The trip: entryChecklist() where the trip's cards are; entryDecisions(trip) spread into decisions()'s list.

import { el, ico, toast } from './util.js';
import { tripPost } from './trip-ui.js';

let C = null;
export function init(ctx) { C = ctx; }

const err = (e) => toast(String((e && e.message) || e));
const fmt = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
let regions = null;
const countryName = (cc) => { try { regions ||= new Intl.DisplayNames([navigator.language || 'en', 'en'], { type: 'region' }); return regions.of(cc) || cc; } catch { return cc; } };
let codes = null;
// every two-letter region the browser can name, by name: the nationality picker
function countryOptions() {
  if (codes) return codes;
  let en; try { en = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return (codes = []); }
  const out = [];
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
    const cc = String.fromCharCode(a, b);
    let n; try { n = en.of(cc); } catch { continue; }
    if (n && n !== cc && !/unknown/i.test(n) && !['EU', 'EZ', 'UN', 'QO', 'XA', 'XB', 'XK'].includes(cc)) out.push([cc, countryName(cc)]);
  }
  return (codes = out.sort((x, y) => x[1].localeCompare(y[1])));
}

/* ---------- Travel profile: the papers ---------- */

const papers = () => (C.S.papers ||= { list: null, kinds: [], verified: null, edit: null });

/** Loads the saved travellers; paints when done. */
export async function loadPapers() {
  const P = papers();
  try { const r = await tripPost('papers', {}); Object.assign(P, { list: r.travellers || [], kinds: r.kinds || [], verified: r.rules_verified }); } catch (e) { err(e); }
  C.paint();
}

function changed() {
  // a trip's checklist depends on the papers: check again next time it shows
  if (C.S.entry) C.S.entry = {};
  C.paint();
}

/** The profile block: each traveller with what Eden keeps, and the form to add or change one. */
export function papersBlock() {
  const P = papers();
  if (C.S.member) return null;
  if (P.list === null) { P.list = []; loadPapers(); }
  const editing = P.edit ? P.list.find((p) => p.id === P.edit) || null : null;
  return el('div', 'tv-prof-block',
    el('h3', '', 'Passports and travel approvals'),
    P.list.length ? el('ul', 'tv-cands', ...P.list.map((p) => el('li', 'tv-cand',
      el('div', '', el('b', '', p.name),
        el('span', 'tv-meta', `${countryName(p.nationality)} passport · expires ${fmt(p.passport_expires)}${p.passport_issued ? ` · issued ${fmt(p.passport_issued)}` : ''}`),
        ...p.auths.map((a) => el('small', '', `${a.name} until ${fmt(a.expires)}`))),
      el('div', 'tv-acts',
        el('button', { type: 'button', class: 'tv-btn quiet', 'aria-label': `Change ${p.name}’s papers`, onclick: () => { P.edit = p.id; C.paint(); } }, 'Change'),
        el('button', { type: 'button', class: 'tv-btn quiet', 'aria-label': `Remove ${p.name}’s papers`, onclick: async () => {
          if (!confirm(`Remove ${p.name}’s passport and approval dates?`)) return;
          try { const r = await tripPost('papers-delete', { id: p.id }); P.list = r.travellers || []; changed(); } catch (x) { err(x); }
        } }, 'Remove'))))) : el('p', 'tv-note', 'None saved yet.'),
    papersForm(P, editing),
    el('p', 'tv-fine', `Only dates and the passport’s country: Eden never keeps passport or approval numbers. Eden uses them to check each trip against rules read on official government sites (last verified ${fmt(P.verified) || 'recently'}).`));
}

function papersForm(P, p) {
  const name = el('input', { type: 'text', placeholder: 'Traveller’s name', 'aria-label': 'Traveller’s name', autocomplete: 'name', maxlength: '60', value: p ? p.name : '' });
  const nat = el('select', { 'aria-label': 'Passport’s country', style: { flex: '1 1 160px', height: '38px', borderRadius: '12px' } },
    el('option', { value: '' }, 'Passport’s country'),
    ...countryOptions().map(([cc, n]) => el('option', { value: cc, ...(p && p.nationality === cc ? { selected: '' } : {}) }, n)));
  const expires = el('input', { type: 'date', 'aria-label': 'Passport expiry date', value: p ? p.passport_expires : '' });
  const issued = el('input', { type: 'date', 'aria-label': 'Passport issue date (optional)', value: p && p.passport_issued ? p.passport_issued : '' });
  const auth = new Map(P.kinds.map((k) => [k.kind, el('input', { type: 'date', 'aria-label': `${k.name} expiry date (optional)`, value: (p && (p.auths.find((a) => a.kind === k.kind) || {}).expires) || '' })]));
  const save = async (e) => {
    e.preventDefault();
    if (!name.value.trim() || !nat.value || !expires.value) return toast('Fill in the name, passport’s country and expiry date');
    const auths = [...auth].filter(([, i]) => i.value).map(([kind, i]) => ({ kind, expires: i.value }));
    try {
      const r = await tripPost('papers-save', { ...(p ? { id: p.id } : {}), name: name.value, nationality: nat.value, passport_expires: expires.value, ...(issued.value ? { passport_issued: issued.value } : {}), auths, confirm: true });
      P.list = r.travellers || [];
      P.edit = null;
      toast('Saved');
      changed();
    } catch (x) { err(x); }
  };
  return el('form', { class: 'tv-form', onsubmit: save, 'aria-label': p ? `Change ${p.name}’s papers` : 'Add a traveller' },
    name, nat,
    el('label', { class: 'tv-fine' }, 'Passport expires ', expires),
    el('label', { class: 'tv-fine' }, 'Issued (optional) ', issued),
    P.kinds.length ? el('details', { style: { flex: '1 1 100%' }, ...(p && p.auths.length ? { open: '' } : {}) },
      el('summary', 'tv-fine', 'Travel approvals held (optional): the date each one ends'),
      el('div', 'tv-form', ...P.kinds.map((k) => el('label', { class: 'tv-fine' }, `${k.name} ends `, auth.get(k.kind))))) : null,
    el('button', { type: 'submit', class: 'tv-btn primary' }, p ? 'Save changes' : 'Save'),
    p ? el('button', { type: 'button', class: 'tv-btn quiet', onclick: () => { P.edit = null; C.paint(); } }, 'Cancel') : null);
}

/* ---------- the trip: entry checklist ---------- */

const entries = () => (C.S.entry ||= {});

/** Loads (or saves, with `set`) the trip's check; paints when done. */
export async function loadEntry(id, set = null) {
  const E = entries();
  E[id] = { ...(E[id] || {}), busy: true };
  try { E[id] = { data: await tripPost('entry-check', { id, ...(set || {}) }) }; } catch (e) { E[id] = { error: String((e && e.message) || e) }; }
  C.paint();
}
function current() {
  const S = C.S;
  if (!S.id || S.member) return null;
  const E = entries();
  if (!E[S.id]) { E[S.id] = { busy: true }; loadEntry(S.id); }
  return E[S.id];
}

const RANK = { problem: 0, todo: 1, check: 2, info: 3, ok: 4 };
const LABEL = { problem: 'Fix', todo: 'To do', check: 'Check', info: 'Note', ok: 'OK' };

function sourceLine(i) {
  const out = [];
  if (i.source) out.push(el('a', { href: i.source.url, target: '_blank', rel: 'noopener', title: i.source.quote || '' }, i.source.by), ` · rule verified ${fmt(i.source.verified)}`);
  for (const l of i.links || []) out.push(out.length ? ' · ' : '', el('a', { href: l.url, target: '_blank', rel: 'noopener' }, l.title));
  return out.length ? el('small', '', 'Source: ', ...out) : null;
}

/** The trip's card: countries, travellers, and each line with its source. */
export function entryChecklist() {
  const r = current();
  if (!r) return null;
  const S = C.S;
  const head = el('div', 'tv-card-head', el('span', 'tv-kicker', ico('globe', 12), 'Passports and entry'));
  const card = (...kids) => el('section', { class: 'glass-card tv-entry', 'aria-label': 'Passports and entry' }, head, ...kids);
  if (r.error) return card(el('p', 'tv-note warn', r.error));
  if (!r.data) return card(el('p', 'tv-note', 'Checking…'));
  const d = r.data;
  if (!d.travellers.length) {
    return card(el('p', 'tv-note', 'Add each traveller’s passport country and expiry date in your Travel profile, and Eden checks this trip against the official entry rules.'),
      C.openProfile ? el('div', 'tv-acts', el('button', { type: 'button', class: 'tv-btn primary', onclick: () => C.openProfile() }, 'Add passports')) : null);
  }
  const codesIn = el('input', { type: 'text', 'aria-label': 'Countries on this trip, as two-letter codes', placeholder: 'PT, ES', value: d.countries.map((c) => c.code).join(', '), autocapitalize: 'characters' });
  const setCountries = async (e) => {
    e.preventDefault();
    const list = codesIn.value.toUpperCase().split(/[^A-Z]+/).filter(Boolean);
    loadEntry(S.id, { countries: list.map((code) => ({ code })) });
  };
  const items = [...d.items].sort((a, b) => RANK[a.status] - RANK[b.status]);
  return card(
    el('p', 'tv-fine', d.countries.length
      ? `${d.countries_derived ? 'From the destination: ' : ''}${d.countries.map((c) => `${c.name} ${fmt(c.from)}–${fmt(c.to)}`).join(' · ')}. Travellers: ${d.travellers.map((t) => t.name).join(', ')}.`
      : 'Which countries does this trip go to? Eden couldn’t tell from the destination.'),
    el('form', { class: 'tv-form', onsubmit: setCountries }, codesIn, el('button', { type: 'submit', class: 'tv-btn' }, d.countries_derived ? 'Confirm countries' : 'Change countries')),
    items.length ? el('ul', 'tv-cands', ...items.map((i) => el('li', { class: `tv-cand tv-entry-${i.status}` },
      el('div', '', el('b', '', `${LABEL[i.status]}: `, i.text),
        i.by_text ? el('span', 'tv-meta', i.by_text) : null,
        i.caveat ? el('small', '', i.caveat) : null,
        sourceLine(i)),
      i.apply_url && (i.status === 'todo' || i.status === 'problem') ? el('div', 'tv-acts', el('a', { class: 'tv-btn', href: i.apply_url, target: '_blank', rel: 'noopener' }, 'Official site')) : null))) : el('p', 'tv-note', 'Nothing to check for these countries.'),
    el('p', 'tv-fine', `Rules from official government sites only, last verified ${fmt(d.rules_verified)}. Where Eden has no rule, it links the official page instead of guessing. Check before you go: rules change.`));
}

/** For travel.js decisions(): [text, label, run] per open item, soonest first. */
export function entryDecisions(trip) {
  const S = C.S;
  if (!trip || S.member) return [];
  const r = entries()[S.id];
  if (!r || !r.data) { current(); return []; }
  const byKey = new Map(r.data.items.map((i) => [i.key, i]));
  return r.data.open.map((k) => byKey.get(k)).filter(Boolean).map((i) => [
    `${i.text}${i.by_text ? ` (${i.by_text})` : ''}`,
    i.apply_url ? 'Official site' : 'Update papers',
    () => (i.apply_url ? window.open(i.apply_url, '_blank', 'noopener') : C.openProfile ? C.openProfile() : null),
  ]);
}
