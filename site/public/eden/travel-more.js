// Eden Travel v3 on the page (travel.js hands it its state and helpers through init): bookings in (paste a confirmation
// or an .eml, or forward it to your own address), documents on each stop (kept on the device for offline use on
// askedentravel.com), Discover (Wikivoyage travellers' picks and Google's best rated, each with its source) and Near me
// now, the Group view (who paid what, shares, the fewest payments that settle it, the trip's chat and "Decisions so
// far", each quoting the message it rests on), and the planning helpers (the day from the hotel, step-free, a shorter
// order as a proposal, when bookings open). Every figure says where it came from; nothing changes the trip without
// the person's press. Someone the trip is shared with uses Discover and Near me too (on the organiser's account: site
// members.js shared-discover / shared-nearby), and their "Suggest" sends the place to the organiser as a proposal.

import { el, ico, toast } from './util.js';
import { apiUrl } from './api.js';
import { tripPost } from './trip-ui.js';

let C = null; // { S, paint, ask, tripRef, money, hm, dayLong, kicker, chip, loadTrip }
export function init(ctx) { C = ctx; }

const err = (e) => toast(String((e && e.message) || e));
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const DOCS_CACHE = 'eden-travel-docs';
// a member reaches money and chat through the organiser's object (site travel/members.js)
function call(action, args = {}) {
  const S = C.S;
  return S.member ? tripPost(`shared-${action}`, { owner: S.member.owner, trip: S.member.trip, ...args }) : tripPost(action, { id: S.id, ...args });
}

/* ---------- bookings in ---------- */

export function bookingPanel(trip) {
  const S = C.S;
  if (!S.addBooking) return null;
  const B = S.addBooking;
  const tab = (k, label) => el('button', { type: 'button', class: 'tv-seg', 'aria-pressed': String(B.tab === k), 'data-k': `bk:${k}`, onclick: () => { B.tab = k; if (k === 'forward' && !B.address) loadAddress(); if (k === 'inbox') scanInbox(); C.paint(); } }, label);
  const body = B.tab === 'forward' ? forwardBox() : B.tab === 'inbox' ? candidatesBox('inbox') : pasteBox();
  return el('section', { class: 'glass-card tv-bookin', 'aria-label': 'Add a booking' },
    el('div', 'tv-card-head', el('span', 'tv-kicker accent', 'Add a booking'), el('button', { type: 'button', class: 'tv-x', 'aria-label': 'Close add a booking', 'data-k': 'close:bookin', onclick: () => { S.addBooking = null; C.paint(); } }, ico('x', 14))),
    el('div', { class: 'tv-segs', role: 'group', 'aria-label': 'How' }, tab('paste', 'Paste or drop'), tab('forward', 'Forward an email'), tab('inbox', 'Forwarded')),
    body,
    el('p', 'tv-fine', 'Eden reads what the airline, hotel or restaurant put in the email for machines (its booking details), never a guess. Nothing is added until you press Add.'));
}

function pasteBox() {
  const B = C.S.addBooking;
  const box = el('textarea', { class: 'tv-input', rows: '5', placeholder: 'Paste the confirmation email here, or drop the .eml file on this box', 'aria-label': 'Confirmation email', 'data-k': 'f:paste' });
  box.value = B.text || '';
  box.oninput = () => { B.text = box.value; };
  box.ondragover = (e) => { e.preventDefault(); box.classList.add('drop'); };
  box.ondragleave = () => box.classList.remove('drop');
  box.ondrop = async (e) => {
    e.preventDefault(); box.classList.remove('drop');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) { if (f.size > 1_500_000) return toast('That file is too large'); B.text = await f.text(); C.paint(); }
  };
  const file = el('input', { type: 'file', accept: '.eml,message/rfc822,.txt,.html', class: 'sr-only', id: 'tvEml', onchange: async (e) => { const f = e.target.files[0]; if (f) { if (f.size > 1_500_000) return toast('That file is too large'); B.text = await f.text(); C.paint(); } } });
  return el('div', '', box,
    el('div', 'tv-acts',
      el('button', { type: 'button', class: 'tv-btn primary', 'data-k': 'bk:read', disabled: B.busy ? '' : null, onclick: () => readPaste() }, B.busy ? 'Reading…' : 'Read it'),
      el('label', { class: 'tv-btn quiet', for: 'tvEml' }, 'Choose an .eml file'), file),
    candidatesBox('paste'));
}

async function readPaste() {
  const S = C.S, B = S.addBooking;
  if (!String(B.text || '').trim()) return toast('Paste the confirmation first');
  B.busy = true; C.paint();
  try {
    const { paste } = await tripPost('paste', { id: S.id, text: B.text });
    const r = await tripPost('mail-scan', { id: S.id, source: 'paste', message: paste });
    B.candidates = r.candidates || [];
    if (!B.candidates.length) toast('No booking details in that email. Try forwarding the original email instead: forwarded emails keep them.');
  } catch (e) { err(e); }
  B.busy = false; C.paint();
}

async function loadAddress() {
  const B = C.S.addBooking;
  try { B.address = await tripPost('inbox-address', {}); } catch (e) { err(e); }
  C.paint();
}
async function scanInbox() {
  const S = C.S, B = S.addBooking;
  B.inbox = null; C.paint();
  try { B.inbox = (await tripPost('mail-scan', { id: S.id, source: 'inbox' })).candidates || []; } catch (e) { B.inbox = []; err(e); }
  C.paint();
}

function forwardBox() {
  const B = C.S.addBooking;
  if (!B.address) return el('p', 'tv-note', 'Making your address…');
  const a = B.address.address;
  return el('div', '',
    el('p', '', 'Forward any booking email to your own Eden Travel address. It lands under Forwarded, for you to add to the right trip.'),
    el('div', 'tv-share', el('code', '', a),
      el('button', { type: 'button', class: 'tv-pill', onclick: () => navigator.clipboard.writeText(a).then(() => toast('Address copied'), () => toast('Couldn’t copy')) }, ico('copy', 12), 'Copy'),
      el('button', { type: 'button', class: 'tv-pill', onclick: async () => { if (!confirm('Make a new address? The old one stops working.')) return; try { B.address = await tripPost('inbox-reset', { confirm: true }); C.paint(); } catch (e) { err(e); } } }, 'New address')),
    B.address.on ? null : el('p', 'tv-note warn', 'Email to this address isn’t switched on yet. Paste the email for now.'));
}

function candidatesBox(source) {
  const S = C.S, B = S.addBooking;
  const list = source === 'inbox' ? B.inbox : B.candidates;
  if (source === 'inbox' && list === null) return el('p', 'tv-note', 'Looking…');
  if (!list || !list.length) return source === 'inbox' ? el('p', 'tv-note', 'Nothing forwarded yet.') : null;
  const stops = S.data.trip.days.flatMap((d, i) => d.stops.map((s) => ({ s, i })));
  return el('ul', 'tv-cands', ...list.map((c) => {
    const b = c.booking;
    const pick = el('select', { class: 'tv-input small', 'aria-label': 'Which stop' }, el('option', { value: '' }, c.match.action === 'mark' ? 'The stop Eden matched' : c.match.action === 'add' ? `Add to Day ${c.match.day + 1}` : 'Choose a stop…'),
      ...stops.map(({ s, i }) => el('option', { value: s.id }, `Day ${i + 1} · ${s.at} · ${s.place.name}`)));
    const what = c.match.action === 'mark' ? `Marks “${(stops.find((x) => x.s.id === c.match.stop) || { s: { place: { name: '' } } }).s.place.name}” booked` : c.match.action === 'add' ? `Adds it to Day ${c.match.day + 1} at ${c.match.at}` : c.match.why;
    return el('li', 'tv-cand',
      el('div', '', el('b', '', b.title || b.place?.name || c.subject || 'Booking'),
        el('span', 'tv-meta', [b.ref ? `Ref ${b.ref}` : 'No reference', b.date, b.at, b.provider].filter(Boolean).join(' · ')),
        el('small', '', `${c.from || ''} · “${c.subject || ''}”${b.structured === false ? ' · read from the text: check it' : ''}`),
        // a forwarded email from an address that isn't on the account, or not signed by its domain: said, never hidden
        c.sender && (!c.sender.known || (c.sender.auth && c.sender.auth.dkim !== 'pass')) ? el('small', 'tv-note warn', [!c.sender.known ? 'From an address that isn’t on your Eden account.' : null, c.sender.auth && c.sender.auth.dkim !== 'pass' ? 'Not verified by the sender’s domain.' : null].filter(Boolean).join(' ')) : null,
        el('span', 'tv-note', what)),
      el('div', 'tv-acts', pick,
        el('button', { type: 'button', class: 'tv-btn primary', disabled: b.ref ? null : '', title: b.ref ? '' : 'No booking reference in this email', onclick: async () => {
          if (c.match.action === 'none' && !pick.value) return toast('Choose which stop it’s for');
          try { await tripPost('mail-import', { id: S.id, source: c.source || source, message: c.message, index: c.index, ...(pick.value ? { stop: pick.value } : {}), confirm: true }); toast('Added to the trip'); S.addBooking = null; C.loadTrip(S.id, { keepDay: true }); } catch (e) { err(e); }
        } }, 'Add'),
        source === 'inbox' ? el('button', { type: 'button', class: 'tv-btn quiet', onclick: async () => { await tripPost('inbox-drop', { message: c.message }).catch(() => {}); scanInbox(); } }, 'Dismiss') : null));
  }));
}

/* ---------- documents ---------- */

const DOC_TYPES = { 'application/pdf': 'PDF', 'image/png': 'Picture', 'image/jpeg': 'Picture', 'image/webp': 'Picture', 'image/heic': 'Picture', 'application/vnd.apple.pkpass': 'Wallet pass' };
export async function loadDocs() {
  const S = C.S;
  if (S.member || !S.id) { S.docs = []; return; }
  try {
    S.docs = (await tripPost('docs', { id: S.id })).docs || [];
    // kept on the device for no signal (askedentravel.com's offline worker serves them)
    if (self.caches) caches.open(DOCS_CACHE).then(async (c) => { for (const d of S.docs) { const u = docUrl(d); if (!(await c.match(u))) c.add(u).catch(() => {}); } }).catch(() => {});
  } catch { S.docs = S.docs || []; }
}
const docUrl = (d) => apiUrl(`/api/chat/travel/doc?id=${C.S.id}&doc=${d.id}`);

export function docsBlock(s) {
  const S = C.S;
  if (S.member) return null;
  const mine = (S.docs || []).filter((d) => d.stop === s.id);
  const input = el('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg,.webp,.heic,.pkpass,application/pdf,image/*,application/vnd.apple.pkpass', class: 'sr-only', id: `tvDoc-${s.id}`, onchange: (e) => addDoc(s, e.target.files[0]) });
  return el('div', 'tv-docs',
    el('span', 'tv-kicker', 'Documents'),
    mine.length ? el('ul', 'tv-doclist', ...mine.map((d) => el('li', '',
      el('a', { href: docUrl(d), target: '_blank', rel: 'noopener', class: 'tv-doclink' }, ico('doc', 13), d.name),
      el('small', '', `${DOC_TYPES[d.type] || 'File'} · ${Math.max(1, Math.round(d.bytes / 1024))} KB`),
      el('button', { type: 'button', class: 'tv-x', 'aria-label': `Delete ${d.name}`, onclick: async () => { if (!confirm(`Delete “${d.name}”?`)) return; try { await tripPost('doc-delete', { id: S.id, doc: d.id }); await loadDocs(); C.paint(); } catch (e) { err(e); } } }, ico('trash', 12))))) : el('p', 'tv-note', 'Tickets, boarding passes, the hotel’s PDF: keep them here, with you offline.'),
    el('label', { class: 'tv-btn quiet', for: `tvDoc-${s.id}`, 'data-k': `doc:${s.id}` }, ico('clip', 13), S.uploading === s.id ? 'Adding…' : 'Add a document'), input);
}

async function addDoc(s, f) {
  const S = C.S;
  if (!f) return;
  if (f.size > 10 * 1024 * 1024) return toast('A document can be at most 10 MB');
  const type = f.type || (/\.pkpass$/i.test(f.name) ? 'application/vnd.apple.pkpass' : /\.heic$/i.test(f.name) ? 'image/heic' : '');
  if (!DOC_TYPES[type]) return toast('A PDF, a picture or an Apple Wallet pass');
  S.uploading = s.id; C.paint();
  try {
    const buf = new Uint8Array(await f.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192));
    const { postJSON } = await import('./api.js');
    await postJSON('/api/chat/travel?doc=1', { action: 'doc-add', args: { id: S.id, stop: s.id, name: f.name, type, data: btoa(bin) } }, { timeout: 120_000 });
    await loadDocs();
    toast('Document added');
  } catch (e) { err(e); }
  S.uploading = null; C.paint();
}

/* ---------- the day from the hotel, step-free, a shorter order, booking windows ---------- */

const HOW = { walk: 'walk', transit: 'by public transport', drive: 'drive', taxi: 'taxi' };
/** A leg to or from where you sleep (the server's day anchor), as a row in the day's list. */
export function anchorRow(c, dir) {
  const a = c && c.anchor;
  const leg = a && a[dir];
  if (!leg) return null;
  const txt = leg.status === 'unknown' ? leg.text : `${leg.minutes} min ${HOW[leg.mode] || ''}`;
  return el('li', { class: `tv-leg tv-anchor ${leg.status}` },
    el('span', 'tv-leg-line', ico('route', 12)),
    el('span', 'tv-leg-text', dir === 'out' ? `From ${a.stay}: ${txt}` : `Back to ${a.stay}: ${txt}`,
      el('small', '', leg.status === 'sample' ? 'sample time' : leg.checked_at ? `${leg.source} · ${new Date(leg.checked_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '')));
}

/** The day's chip while the trip has step-free checks on (switched in travel.js's Trip tools: toggleStepFree). */
export function stepFreeChip(trip) {
  return trip.access && trip.access.step_free ? el('span', { class: 'tv-chip on', title: 'Every entrance is checked for step-free access, and routes with less walking are preferred' }, ico('check', 11), 'Step-free') : null;
}
/** Step-free checks on or off for the whole trip (the organiser's; the server re-checks every entrance). */
export async function toggleStepFree(trip) {
  const S = C.S;
  const on = Boolean(trip.access && trip.access.step_free);
  if (S.member) return;
  try { await tripPost('update', { id: S.id, access: on ? null : { step_free: true } }); toast(on ? 'Step-free checks off' : 'Step-free checks on: entrances as Google lists them'); } catch (e) { err(e); }
}

export function shorterButton(trip) {
  const S = C.S;
  if (S.member || S.offline) return null;
  return el('button', { type: 'button', class: 'tv-pill', 'data-k': 'shorter', disabled: S.optimizing ? '' : null, title: 'Find a shorter order for this day’s sights, checked against their hours', onclick: async () => {
    S.optimizing = true; C.paint();
    try {
      const r = await tripPost('optimize', { id: S.id, day: S.day });
      if (r.saved_minutes > 0) { toast(`A shorter order saves ${r.saved_minutes} min: see Eden noticed`); await C.loadTrip(S.id, { keepDay: true }); } else toast(r.why || 'Already about as short as it gets');
    } catch (e) { err(e); }
    S.optimizing = false; C.paint();
  } }, ico('route', 13), S.optimizing ? 'Checking…' : 'Shorter order');
}

export function accessLine(b) {
  return b && b.access ? el('div', `tv-check ${b.access.status}`, el('i', ''), el('span', '', `Access: ${b.access.text}`), b.access.source ? el('small', '', b.access.source) : null) : null;
}

export function windowsBlock(trip, s) {
  const S = C.S;
  if (S.member || !['visit', 'activity', 'meal'].includes(s.kind) || s.booked) return null;
  S.windows = S.windows || new Map();
  const w = S.windows.get(s.id);
  if (w === undefined) return el('div', 'tv-acts', el('button', { type: 'button', class: 'tv-btn quiet', 'data-k': `win:${s.id}`, onclick: async () => {
    S.windows.set(s.id, null); C.paint();
    try { S.windows.set(s.id, await tripPost('windows', { id: S.id, stop: s.id })); } catch (e) { S.windows.delete(s.id); err(e); }
    C.paint();
  } }, ico('cal', 13), 'When do bookings open?'));
  if (w === null) return el('p', 'tv-note', 'Reading its website…');
  if (!w.found) return el('div', 'tv-check look', el('i', ''), el('span', '', `Bookings: ${w.why}`), w.url ? el('small', '', el('a', { href: w.url, target: '_blank', rel: 'noopener' }, 'Its website')) : null);
  const days = Math.round((Date.parse(`${w.opens_on}T00:00:00Z`) - Date.now()) / 86400_000);
  return el('div', `tv-check ${days <= 0 ? 'ok' : 'look'}`, el('i', ''),
    el('span', '', days <= 0 ? `Bookings are open (from ${C.dayLong(w.opens_on)}${w.opens_at ? `, ${w.opens_at}` : ''}).` : `Bookings open ${C.dayLong(w.opens_on)}${w.opens_at ? ` at ${w.opens_at}` : ''}, in ${days} day${days === 1 ? '' : 's'}.`),
    el('small', '', '“', w.quote, '” · ', el('a', { href: w.url, target: '_blank', rel: 'noopener' }, 'the venue’s website'), ` · ${when(w.checked_at)}`),
    C.wrongButton ? C.wrongButton(s.id, 'window', { status: 'ok', text: w.quote, source: w.source, checked_at: w.checked_at }) : null);
}

/* ---------- Discover and Near me ---------- */

const KINDS = [['see', 'See'], ['do', 'Do'], ['eat', 'Eat'], ['drink', 'Drink']];
export function discover() {
  const S = C.S;
  const D = S.disc || (S.disc = { kind: 'see', data: new Map(), near: null, nearKind: 'eat', minutes: 15 });
  const key = `${S.member ? `${S.member.owner}|${S.member.trip}` : S.id}:${D.kind}`;
  if (!D.data.has(key)) {
    D.data.set(key, null);
    call('discover', { kind: D.kind }).then((r) => { D.data.set(key, r); C.paint(); }, (e) => { D.data.set(key, { error: String(e.message || e) }); C.paint(); });
  }
  const r = D.data.get(key);
  const city = String(S.data.trip.destination || S.data.trip.title).split(',')[0];
  return [
    el('section', { class: 'tv-disc-head glass-card tv-first', 'aria-label': 'Discover' },
      C.kicker('Discover', city),
      el('h2', '', `What people who know ${city} recommend`),
      el('div', { class: 'tv-segs', role: 'group', 'aria-label': 'Kind' }, ...KINDS.map(([k, label]) => el('button', { type: 'button', class: 'tv-seg', 'aria-pressed': String(D.kind === k), 'data-k': `disc:${k}`, onclick: () => { D.kind = k; C.paint(); } }, label)))),
    nearMe(),
    S.member ? el('p', 'tv-fine glass-card', 'What you add goes to the organiser as a suggestion; they decide.') : null,
    r === null || r === undefined ? el('p', 'tv-note glass-card', 'Looking…') : r.error ? el('p', 'tv-note warn glass-card', r.error) : [
      r.rated && r.rated.places.length ? el('section', { class: 'tv-disc glass-card', 'aria-label': 'Best rated' },
        el('div', 'tv-card-head', el('span', 'tv-kicker', 'Best rated on Google Maps'), el('span', 'tv-fine', `${r.rated.source} · ${when(r.rated.checked_at)}`)),
        el('ul', 'tv-disc-list', ...r.rated.places.map((p, i) => placeCard(p, i, {
          sub: [p.type, p.rating ? `★ ${p.rating.toFixed(1)} (${p.ratings.toLocaleString()})` : null, p.status === 'closed_temporarily' ? 'Closed for now' : null].filter(Boolean).join(' · '),
          about: p.about, link: p.url, kind: D.kind, google: p })))) : null,
      r.wikivoyage && r.wikivoyage.places.length ? el('section', { class: 'tv-disc glass-card', 'aria-label': 'Wikivoyage' },
        el('div', 'tv-card-head', el('span', 'tv-kicker', 'Wikivoyage travellers recommend'), el('a', { class: 'tv-fine', href: r.wikivoyage.page_url, target: '_blank', rel: 'noopener' }, `Wikivoyage · ${r.wikivoyage.licence.name}`)),
        el('ul', 'tv-disc-list', ...r.wikivoyage.places.slice(0, D.all === key ? undefined : 12).map((p, i) => placeCard(p, i, {
          sub: [p.page !== r.wikivoyage.page ? p.page.split('/').pop() : null, p.price_note].filter(Boolean).join(' · '),
          about: p.about, note: p.hours_note ? `Hours, as a traveller wrote them${p.edited ? ` (${p.edited})` : ''}: ${p.hours_note}. Eden checks them with Google once it’s in your day.` : p.edited ? `Listing edited ${p.edited}.` : null,
          link: p.url, kind: D.kind }))),
        r.wikivoyage.places.length > 12 && D.all !== key ? el('div', 'tv-acts', el('button', { type: 'button', class: 'tv-btn', 'data-k': 'disc:all', onclick: () => { D.all = key; C.paint(); } }, `Show all ${r.wikivoyage.places.length}`)) : null) : r.wikivoyage ? null : el('p', 'tv-note glass-card', `Wikivoyage has no guide for ${city} that Eden could read.`),
    ],
  ];
}

function placeCard(p, i, { sub, about, note, link, kind, google }) {
  return el('li', { class: 'tv-place', style: { '--i': Math.min(i, 9) } },
    google && google.photo ? el('img', { class: 'tv-place-art', src: apiUrl(`/api/chat/travel/photo?n=${encodeURIComponent(google.photo.name)}&w=240`), alt: '', loading: 'lazy', title: `Photo: ${google.photo.by || 'Google'} · Google Maps` }) : null,
    el('div', 'tv-place-main', el('b', '', p.name), sub ? el('span', 'tv-meta', sub) : null, about ? el('p', '', about) : null, note ? el('small', '', note) : null,
      el('div', 'tv-acts', addToDay(p, kind, google), link ? el('a', { class: 'tv-btn quiet', href: link, target: '_blank', rel: 'noopener' }, ico('ext', 12), 'Website') : null)));
}

/** Adds the place to a day: linked to its Google place (so its hours are checked), after the day's last stop. For someone
 *  the trip is shared with, the same stop goes to the organiser as a suggestion (shared-propose), never into the trip. */
function addToDay(p, kind, google, day = null) {
  const S = C.S;
  const trip = S.data.trip;
  const sel = day === null ? el('select', { class: 'tv-input small', 'aria-label': 'Which day' }, ...trip.days.map((d, i) => el('option', { value: String(i), ...(i === S.day ? { selected: '' } : {}) }, `Day ${i + 1}`))) : null;
  return el('span', 'tv-addday', sel, el('button', { type: 'button', class: 'tv-btn', onclick: async (e) => {
    const di = day === null ? Number(sel.value) : day;
    const btn = e.currentTarget; btn.disabled = true;
    try {
      let place = google ? { id: google.id, name: google.name, lat: google.lat, lng: google.lng } : null;
      // a member's lookups would be on their own account: the place goes as Wikivoyage has it, and is checked once applied
      if (!place && S.member) place = { name: p.name, lat: Number.isFinite(p.lat) ? p.lat : null, lng: Number.isFinite(p.lng) ? p.lng : null };
      if (!place) {
        const found = (await tripPost('places', { text: `${p.name} ${String(trip.destination || '').split(',')[0]}`, ...(Number.isFinite(p.lat) ? { near: { lat: p.lat, lng: p.lng } } : {}) })).places || [];
        const g = found[0];
        place = g ? { id: g.id, name: g.name, lat: g.lat, lng: g.lng } : { name: p.name, lat: p.lat, lng: p.lng };
        if (!g) toast('Google Maps didn’t find it, so its hours won’t be checked');
      }
      const stops = trip.days[di].stops;
      const last = stops[stops.length - 1];
      const after = last ? Math.min(23 * 60, Number(last.at.slice(0, 2)) * 60 + Number(last.at.slice(3)) + last.minutes + 30) : 10 * 60;
      const at = `${String(Math.floor(after / 60)).padStart(2, '0')}:${String(Math.ceil((after % 60) / 5) * 5 % 60).padStart(2, '0')}`;
      const ops = [{ op: 'add', day: di, stop: { kind: kind === 'eat' || kind === 'drink' ? 'meal' : kind === 'do' ? 'activity' : 'visit', place, at, minutes: kind === 'eat' ? 90 : 60, mode: 'transit', note: p.page ? `From Wikivoyage (${p.page})` : '' } }];
      if (S.member) {
        await tripPost('shared-propose', { owner: S.member.owner, trip: S.member.trip, title: `Add ${p.name} to Day ${di + 1}`, reason: p.page ? `Recommended on Wikivoyage (${p.page}).` : google ? 'Found on Google Maps.' : '', ops });
        toast(`Suggested ${p.name} for Day ${di + 1}. The organiser decides.`);
        btn.disabled = false;
        return;
      }
      await tripPost('edit', { id: S.id, ops });
      toast(`${p.name} added to Day ${di + 1} at ${at}`, { label: 'Undo', run: () => tripPost('undo', { id: S.id }).catch(err) });
    } catch (e2) { err(e2); }
    btn.disabled = false;
  } }, ico('plus', 12), S.member ? (day === null ? 'Suggest' : 'Suggest for today') : day === null ? 'Add' : 'Add to today'));
}

function nearMe() {
  const S = C.S, D = S.disc;
  const look = (where) => {
    D.near = { loading: true, where: where.label }; C.paint();
    call('nearby', { lat: where.lat, lng: where.lng, kind: D.nearKind, minutes: D.minutes }).then((r) => { D.near = { ...r, where: where.label, at: where }; C.paint(); }, (e) => { D.near = { error: String(e.message || e) }; C.paint(); });
  };
  const here = () => {
    if (!navigator.geolocation) return toast('This browser can’t share where you are');
    D.near = { loading: true, where: 'you' }; C.paint();
    navigator.geolocation.getCurrentPosition((pos) => look({ lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'you' }), () => { D.near = null; toast('Location wasn’t shared. Try near a stop instead.'); C.paint(); }, { timeout: 10_000, maximumAge: 60_000 });
  };
  const stops = S.data.trip.days[S.day].stops.filter((s) => Number.isFinite(s.place.lat));
  const n = D.near;
  return el('section', { class: 'tv-near glass-card', 'aria-label': 'Open near me now' },
    el('div', 'tv-card-head', el('span', 'tv-kicker', 'Open now, within a walk'),
      el('select', { class: 'tv-input small', 'aria-label': 'What', onchange: (e) => { D.nearKind = e.target.value; if (n && n.at) look(n.at); } }, ...KINDS.map(([k, l]) => el('option', { value: k, ...(D.nearKind === k ? { selected: '' } : {}) }, l))),
      el('select', { class: 'tv-input small', 'aria-label': 'Walk', onchange: (e) => { D.minutes = Number(e.target.value); if (n && n.at) look(n.at); } }, ...[10, 15, 20, 30].map((m) => el('option', { value: String(m), ...(D.minutes === m ? { selected: '' } : {}) }, `${m} min walk`)))),
    el('div', 'tv-acts', el('button', { type: 'button', class: 'tv-btn primary', 'data-k': 'near:me', onclick: here }, ico('pin', 13), 'Near me'),
      stops.length ? el('select', { class: 'tv-input small', 'aria-label': 'Near a stop', onchange: (e) => { const s = stops[Number(e.target.value)]; if (s) look({ lat: s.place.lat, lng: s.place.lng, label: s.place.name }); } }, el('option', { value: '' }, `Or near a Day ${S.day + 1} stop…`), ...stops.map((s, i) => el('option', { value: String(i) }, s.place.name))) : null),
    !n ? el('p', 'tv-note', 'Only places Google says are open right now, with the real walking time.') : n.loading ? el('p', 'tv-note', `Looking near ${n.where}…`) : n.error ? el('p', 'tv-note warn', n.error) : !n.places.length ? el('p', 'tv-note', `Nothing open within a ${n.minutes}-minute walk of ${n.where}, as Google has it.`) :
      el('ul', 'tv-disc-list', ...n.places.map((p, i) => el('li', { class: 'tv-place', style: { '--i': Math.min(i, 9) } },
        el('div', 'tv-place-main', el('b', '', p.name),
          el('span', 'tv-meta', [`${p.walk_minutes} min walk`, p.open_now ? `Open now${p.closes_at ? `, closes ${new Date(p.closes_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}` : n.standin ? 'Sample place' : null, p.rating ? `★ ${p.rating.toFixed(1)} (${p.ratings.toLocaleString()})` : null, p.type].filter(Boolean).join(' · ')),
          el('div', 'tv-acts', addToDay(p, n.kind, p, S.day), p.url ? el('a', { class: 'tv-btn quiet', href: p.url, target: '_blank', rel: 'noopener' }, ico('ext', 12), 'Directions') : null))))),
    n && n.checked_at ? el('p', 'tv-fine', `${n.source} · ${when(n.checked_at)}`) : null);
}

/* ---------- the Group view: money, chat, decisions ---------- */

export async function loadGroup() {
  const S = C.S;
  const G = S.group || (S.group = {});
  try {
    const [m, chat] = await Promise.all([call('money'), call('chat')]);
    G.money = m; G.chat = chat.messages || []; G.people = chat.people || m.people;
  } catch (e) { G.error = String(e.message || e); }
  C.paint();
}

export function group() {
  const S = C.S;
  const G = S.group || (S.group = {});
  if (!G.money && !G.error && !G.loading) { G.loading = true; loadGroup().finally(() => { G.loading = false; }); }
  if (G.error) return [el('p', 'tv-note warn glass-card tv-first', G.error)];
  if (!G.money) return [el('p', 'tv-note glass-card tv-first', 'Loading the group…')];
  return [moneyCard(G), chatCard(G)];
}

const nameOf = (G, id) => ((G.money.people || []).find((p) => p.id === id) || {}).name || 'Someone';

function moneyCard(G) {
  const S = C.S, m = G.money, cur = m.currency;
  const me = m.you;
  const f = G.form || (G.form = { what: '', amount: '', currency: cur, paid_by: '', split: null });
  const what = el('input', { class: 'tv-input', placeholder: 'What for (dinner, taxi…)', 'aria-label': 'What for', maxlength: '120', 'data-k': 'f:x-what', value: f.what, oninput: (e) => { f.what = e.target.value; } });
  const amount = el('input', { class: 'tv-input small', type: 'number', min: '0', step: '0.01', placeholder: 'Amount', 'aria-label': 'Amount', value: f.amount, oninput: (e) => { f.amount = e.target.value; } });
  const currency = el('input', { class: 'tv-input tiny', maxlength: '3', 'aria-label': 'Currency', value: f.currency, oninput: (e) => { f.currency = e.target.value.toUpperCase(); } });
  const paid = el('select', { class: 'tv-input small', 'aria-label': 'Paid by', onchange: (e) => { f.paid_by = e.target.value; } }, ...m.people.map((p) => el('option', { value: p.id, ...((f.paid_by || me) === p.id ? { selected: '' } : {}) }, `Paid by ${p.name}`)));
  const split = el('fieldset', 'tv-split', el('legend', 'tv-fine', 'Shared by'), ...m.people.map((p) => el('label', '', el('input', { type: 'checkbox', checked: !f.split || f.split.includes(p.id) ? '' : null, onchange: (e) => { const all = f.split || m.people.map((x) => x.id); f.split = e.target.checked ? [...new Set([...all, p.id])] : all.filter((x) => x !== p.id); } }), p.name)));
  const bal = new Map(m.balances.map((b) => [b.id, b.amount]));
  const over = m.budget && m.total > m.budget.amount;
  return el('section', { class: 'tv-money glass-card tv-first', 'aria-label': 'Money' },
    el('div', 'tv-card-head', el('span', 'tv-kicker', 'Money'), el('span', 'tv-fine', m.rates ? `Rates: ${m.rates.source}, ${m.rates.date}` : '')),
    el('div', 'tv-money-top',
      el('div', '', el('span', 'tv-kicker', 'Spent so far'), el('b', `tv-big${over ? ' warn' : ''}`, C.money(m.total, cur)), m.budget ? el('small', '', ` of ${C.money(m.budget.amount, m.budget.currency)} budget`) : null),
      el('ul', 'tv-people', ...m.people.map((p) => { const b = bal.get(p.id) || 0; return el('li', '', el('b', '', p.name), el('small', '', p.kind === 'guest' ? 'no Eden account' : p.kind), el('span', `tv-bal ${b > 0.004 ? 'pos' : b < -0.004 ? 'neg' : ''}`, Math.abs(b) < 0.005 ? 'settled' : b > 0 ? `is owed ${C.money2(b, cur)}` : `owes ${C.money2(-b, cur)}`)); }))),
    m.settle.length ? el('div', 'tv-settle', el('span', 'tv-kicker', `To settle up · ${m.settle.length} payment${m.settle.length === 1 ? '' : 's'}`),
      el('ul', '', ...m.settle.map((t) => el('li', '', `${nameOf(G, t.from)} pays ${nameOf(G, t.to)} `, el('b', '', C.money2(t.amount, cur)))))) : null,
    m.rates_missing ? el('p', 'tv-note warn', m.rates_missing) : null,
    el('form', { class: 'tv-xform', onsubmit: async (e) => {
      e.preventDefault();
      if (!f.what.trim() || !(Number(f.amount) > 0)) return toast('What it was for, and how much');
      try { await call('expense-add', { what: f.what.trim(), amount: Number(f.amount), currency: f.currency || cur, paid_by: f.paid_by || me, ...(f.split ? { split: f.split } : {}) }); G.form = null; toast('Added'); loadGroup(); } catch (e2) { err(e2); }
    } }, what, el('div', 'tv-row', amount, currency, paid), split, el('button', { type: 'submit', class: 'tv-btn primary' }, 'Add expense')),
    S.member ? null : guestsRow(G),
    el('ul', 'tv-xlist', ...[...m.expenses].reverse().map((x) => el('li', '',
      el('div', '', el('b', '', x.what), el('small', '', [x.booking ? 'Booked in Eden Travel' : `Paid by ${nameOf(G, x.paid_by)}`, x.split && x.split.length < m.people.length ? `shared by ${x.split.map((p) => nameOf(G, p)).join(', ')}` : 'shared by everyone', x.date].filter(Boolean).join(' · '))),
      el('span', 'tv-xamt', C.money2(x.amount, x.currency), x.currency !== cur && x.in_trip_currency !== null ? el('small', '', ` ≈ ${C.money2(x.in_trip_currency, cur)}`) : x.unconverted ? el('small', '', ' not counted yet') : null),
      !x.booking && (!S.member || x.by === me) ? el('button', { type: 'button', class: 'tv-x', 'aria-label': `Delete ${x.what}`, onclick: async () => { try { await call('expense-delete', { expense: x.id }); loadGroup(); } catch (e) { err(e); } } }, ico('trash', 12)) : null))));
}

function guestsRow(G) {
  const name = el('input', { class: 'tv-input small', placeholder: 'Someone without Eden', 'aria-label': 'Their name', maxlength: '40' });
  const you = el('input', { class: 'tv-input small', placeholder: 'Your name', 'aria-label': 'Your name', maxlength: '40', value: G.money.people[0].name === 'Organiser' ? '' : G.money.people[0].name });
  return el('details', 'tv-guests', el('summary', 'tv-fine', 'People on the trip'),
    el('div', 'tv-row', you, el('button', { type: 'button', class: 'tv-btn quiet', onclick: async () => { try { await tripPost('people', { id: C.S.id, owner_name: you.value }); loadGroup(); } catch (e) { err(e); } } }, 'Save my name')),
    el('div', 'tv-row', name, el('button', { type: 'button', class: 'tv-btn quiet', onclick: async () => { if (!name.value.trim()) return; try { await tripPost('people', { id: C.S.id, add_guest: name.value }); loadGroup(); } catch (e) { err(e); } } }, 'Add')),
    el('ul', 'tv-fine', ...G.money.people.filter((p) => p.kind === 'guest').map((p) => el('li', '', p.name, ' ', el('button', { type: 'button', class: 'tv-x', 'aria-label': `Remove ${p.name}`, onclick: async () => { try { await tripPost('people', { id: C.S.id, remove_guest: p.id }); loadGroup(); } catch (e) { err(e); } } }, ico('x', 11))))),
    el('p', 'tv-fine', 'People with Eden join with the Share button and add their own expenses.'));
}

function chatCard(G) {
  const S = C.S;
  const input = el('input', { class: 'tv-input', placeholder: 'Message everyone on the trip', 'aria-label': 'Message', maxlength: '1000', 'data-k': 'f:chat' });
  const list = el('ol', 'tv-chat', ...G.chat.map((m) => el('li', { id: `msg-${m.id}`, class: m.by === G.money.you ? 'mine' : '' }, el('b', '', m.name), el('span', '', m.text), el('small', '', when(new Date(m.at).toISOString())))));
  const D = G.decisions;
  const jump = (id) => { const n = document.getElementById(`msg-${id}`); if (n) { n.scrollIntoView({ block: 'center', behavior: 'smooth' }); n.classList.add('flash'); setTimeout(() => n.classList.remove('flash'), 1600); } };
  const line = (l) => el('li', '', el('span', '', l.text), el('button', { type: 'button', class: 'tv-quote', title: 'Show the message', onclick: () => jump(l.message) }, `“${l.quote}”`));
  return el('section', { class: 'tv-groupchat glass-card', 'aria-label': 'Trip chat' },
    el('div', 'tv-card-head', el('span', 'tv-kicker', 'Trip chat'), el('button', { type: 'button', class: 'tv-pill', 'data-k': 'decide', disabled: G.deciding || !G.chat.length ? '' : null, onclick: async () => {
      G.deciding = true; C.paint();
      try { G.decisions = await call('decisions'); } catch (e) { err(e); }
      G.deciding = false; C.paint();
    } }, ico('spark', 13), G.deciding ? 'Reading…' : 'Decisions so far')),
    D ? el('div', 'tv-decided',
      D.error ? el('p', 'tv-note warn', D.error) : null,
      D.decisions.length ? el('div', '', el('span', 'tv-kicker', 'Decided'), el('ul', '', ...D.decisions.map(line))) : null,
      D.open.length ? el('div', '', el('span', 'tv-kicker', 'Still open'), el('ul', '', ...D.open.map(line))) : null,
      !D.error && !D.decisions.length && !D.open.length ? el('p', 'tv-note', 'Nothing decided in the chat yet.') : null,
      el('p', 'tv-fine', `Each line quotes the message it comes from${D.dropped ? `; ${D.dropped} line${D.dropped === 1 ? '' : 's'} without a matching quote left out` : ''}. ${D.model ? `Read by ${D.model}` : ''} · ${when(D.checked_at)}`)) : null,
    G.chat.length ? list : el('p', 'tv-note', 'No messages yet. Everyone on the trip sees this chat.'),
    el('form', { class: 'tv-form', onsubmit: async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      try { await call('chat-post', { text }); G.decisions = null; await loadGroup(); const n = S.pane.querySelector('.tv-chat li:last-child'); if (n) n.scrollIntoView({ block: 'nearest' }); } catch (e2) { input.value = text; err(e2); }
    } }, input, el('button', { type: 'submit', class: 'tv-btn primary' }, ico('send', 13), 'Send')));
}
