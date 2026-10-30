// The owner's dashboard, Eden Travel's private beta (src/travel/beta.js; GET/POST /api/admin/travel-beta): invites (make,
// copy the link, revoke), the people in the beta, the waitlist (stored only: nothing was sent to anyone), "Something's
// wrong" reports (open/done, the picture, the trip only when the person ticked the box) and the feature counts.
// Its own block under #main (admin.js redraws #main on Refresh; this keeps its own state and its own refresh).
// Same rules as admin.js: no innerHTML, no style attributes (the CSP allows the CSSOM only), nothing from a third party.

const API = '/api/admin/travel-beta';
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return node;
};
const int = (n) => (Number(n) || 0).toLocaleString();
const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const day = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
const card = (title, ...body) => el('div', { class: 'card' }, title ? el('h3', { text: title }) : null, ...body);
const empty = (text = 'Nothing yet.') => el('div', { class: 'empty', text });
const note = (text) => el('p', { class: 'note', text });
function table(head, rows) {
  if (!rows.length) return empty();
  return el('div', { class: 'scroll' }, el('table', {},
    el('thead', {}, el('tr', {}, head.map((h) => el('th', { text: h })))),
    el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c) => (c instanceof Node ? el('td', {}, c) : el('td', { text: c }))))))));
}
function bars(items) {
  if (!items.length) return empty();
  const max = Math.max(...items.map((i) => Number(i.value) || 0), 1);
  return el('div', { class: 'rows' }, items.map((i) => el('div', { class: 'row' },
    el('span', { class: 'lab', title: i.label, text: i.label }),
    el('span', { class: 'num', text: `${int(i.value)}${i.sub ? ` · ${i.sub}` : ''}` }),
    el('div', { class: 'track' }, el('div', { class: 'fill', style: `width:${Math.max(1, ((Number(i.value) || 0) / max) * 100).toFixed(1)}%` })))));
}

const ST = { data: null, error: null, show: 'open', made: null };
let root = null;

async function api(body) {
  const r = await fetch(API, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
  return out;
}
async function load() {
  try { ST.data = await api(); ST.error = null; } catch (e) { ST.error = String(e.message || e); }
  draw();
}
async function act(body, button) {
  if (button) button.disabled = true;
  try { const out = await api(body); if (body.action === 'invite-create') ST.made = out; await load(); } catch (e) { alert(String(e.message || e)); if (button) button.disabled = false; }
}
const btn = (text, run) => { const b = el('button', { type: 'button', text }); b.addEventListener('click', () => run(b)); return b; };
const copy = (text) => btn('Copy link', async (b) => { try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch { prompt('Copy the link', text); } });
const STATE = { open: 'Open', used: 'Used', expired: 'Expired', revoked: 'Revoked' };

function inviteForm() {
  const email = el('input', { type: 'email', placeholder: 'Their email (empty: anyone with the code)', 'aria-label': 'Email', autocomplete: 'off' });
  const days = el('input', { type: 'number', min: '1', max: '90', value: '14', 'aria-label': 'Days it lasts', style: 'width:5em' });
  const uses = el('input', { type: 'number', min: '1', max: '50', value: '1', 'aria-label': 'How many people can use it', style: 'width:5em' });
  const label = el('input', { type: 'text', maxlength: '120', placeholder: 'Note for you (who it’s for)', 'aria-label': 'Note' });
  const go = btn('Make invite', (b) => act({ action: 'invite-create', email: email.value.trim() || null, days: Number(days.value), max_uses: email.value.trim() ? 1 : Number(uses.value), note: label.value.trim() }, b));
  const made = ST.made && ST.made.invite;
  return el('div', {},
    el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;align-items:center' }, email, el('label', {}, 'Days ', days), el('label', {}, 'Uses ', uses), label, go),
    made ? el('p', { class: 'note' }, `Made ${made.shown}${made.email ? ` for ${made.email}` : ''}: `, el('code', { text: ST.made.url }), ' ', copy(ST.made.url)) : null,
    note('An invite for one email is used once, by an account signed in with that email. Sending the link is up to you: Eden sends nothing.'));
}

function draw() {
  if (!root) return;
  const d = ST.data;
  const head = [el('h2', { text: 'Eden Travel private beta' })];
  if (ST.error) { root.replaceChildren(...head, card(null, empty(`Couldn’t load the beta: ${ST.error}`))); return; }
  if (!d) { root.replaceChildren(...head, note('Loading…')); return; }
  head.push(note(d.on ? 'On (TRAVEL_BETA=1): Eden Travel opens only for the people below and for you.' : 'Off: Eden Travel isn’t limited to invites. Set TRAVEL_BETA=1 to limit it.'));
  const base = d.link || '/travel/beta';
  const invites = table(['Code', 'For', 'Uses', 'Lasts until', 'State', 'Note', ''], (d.invites || []).map((i) => [
    el('code', { text: i.shown }), i.email || 'anyone', `${int(i.uses)} of ${int(i.max_uses)}`, when(i.expires), STATE[i.state] || i.state, i.note || '',
    i.state === 'open' ? el('span', {}, copy(`${base}?code=${i.code}`), ' ', btn('Revoke', (b) => { if (confirm(`Revoke ${i.shown}?`)) act({ action: 'invite-revoke', code: i.code }, b); })) : '',
  ]));
  const members = table(['Who', 'Joined', 'Invite', ''], (d.members || []).map((m) => [
    m.email || `account ${String(m.account).slice(0, 8)}`, when(m.at), m.code ? `${m.code.slice(0, 4)}-${m.code.slice(4)}` : '',
    btn('Remove', (b) => { if (confirm(`Remove ${m.email || 'this account'} from the beta? Eden Travel closes for them within 5 minutes.`)) act({ action: 'member-remove', account: m.account }, b); }),
  ]));
  const waitlist = table(['Email', 'Since', 'Came from', ''], (d.waitlist || []).map((w) => [
    w.email, when(w.at), w.from || '',
    el('span', {}, btn('Invite', (b) => act({ action: 'invite-create', email: w.email, days: 14, note: 'from the waitlist' }, b)), ' ', btn('Drop', (b) => { if (confirm(`Drop ${w.email} from the waitlist?`)) act({ action: 'wait-drop', email: w.email }, b); })),
  ]));
  const all = d.feedback || [];
  const shown = all.filter((f) => ST.show === 'all' || f.status === ST.show);
  const filter = el('div', { style: 'display:flex;gap:8px;margin-bottom:8px' }, ...[['open', 'Open'], ['done', 'Done'], ['all', 'All']].map(([k, t]) => {
    const b = btn(`${t} (${int(k === 'all' ? all.length : all.filter((f) => f.status === k).length)})`, () => { ST.show = k; draw(); });
    b.setAttribute('aria-pressed', String(ST.show === k));
    return b;
  }));
  const reports = shown.length ? el('div', {}, shown.map(report)) : empty(ST.show === 'open' ? 'No open reports.' : 'None.');
  const u = d.usage || {};
  const usage = u.ready === false ? empty(u.error ? `Couldn’t read the counts: ${u.error}` : 'The STATS database isn’t connected.')
    : el('div', { class: 'grid g2' },
      card('Features, last 30 days', bars((u.by_feature || []).map((f) => ({ label: f.name, value: f.n, sub: `${int(f.people)} ${f.people === 1 ? 'person' : 'people'}` })))),
      card('By day', bars((u.by_day || []).slice(-30).reverse().map((x) => ({ label: day(x.day), value: x.n, sub: `${int(x.people)} ${x.people === 1 ? 'person' : 'people'}` })))));
  root.replaceChildren(...head,
    card('Make an invite', inviteForm()),
    el('div', { class: 'grid g2' }, card(`Invites (${int((d.invites || []).length)})`, invites), card(`In the beta (${int((d.members || []).length)})`, members)),
    card(`Waitlist (${int((d.waitlist || []).length)})`, note('Stored only. Nothing was sent to these addresses.'), waitlist),
    card('Something’s wrong: reports', filter, reports),
    el('h3', { text: 'What testers use' }), note('How many times each feature was used, by day (UTC). No content, no places, no trip ids; people are counted by a scrambled tag.'), usage,
    el('div', { style: 'margin-top:8px' }, btn('Refresh the beta', () => load())));
}

function report(f) {
  const c = f.context || {};
  const facts = [
    c.view ? `view ${c.view}` : null, c.trip ? `trip ${c.trip}${c.shared ? ' (shared with them)' : ''}` : null, Number.isInteger(c.day) ? `day ${c.day + 1}` : null,
    c.version ? `version ${c.version}` : null, f.device ? `device ${f.device}` : null, c.host ? `${c.host}${c.path || ''}` : null, c.viewport ? `screen ${c.viewport}` : null,
    c.standalone ? 'home-screen app' : null, c.offline ? 'offline' : null,
  ].filter(Boolean).join(' · ');
  return el('div', { class: 'card', style: 'margin-bottom:10px' },
    el('div', { style: 'display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap' },
      el('b', { text: `${f.email || `account ${String(f.account).slice(0, 8)}`} · ${when(f.at)}` }),
      el('span', { class: `pill${f.status === 'open' ? ' red' : ''}`, text: f.status === 'open' ? 'Open' : `Done ${when(f.done_at)}` })),
    el('p', { class: 'err', style: 'white-space:pre-wrap', text: f.text }),
    facts ? note(facts) : null,
    c.errors && c.errors.length ? note(`Errors the page saw: ${c.errors.join(' · ')}`) : null,
    f.image ? el('p', {}, el('a', { href: `${API}/image?id=${encodeURIComponent(f.id)}`, target: '_blank', rel: 'noopener noreferrer', text: `Open the picture (${Math.round(f.image.bytes / 1024)} KB)` })) : null,
    f.consent && f.trip ? el('details', {}, el('summary', { text: 'Trip details (they agreed to include them)' }), el('pre', { style: 'white-space:pre-wrap;font-size:12px', text: JSON.stringify(f.trip, null, 2) })) : note(f.consent ? 'They agreed to include the trip, but none was open.' : 'Trip details not included.'),
    f.note ? note(`Your note: ${f.note}`) : null,
    el('div', { style: 'display:flex;gap:8px' }, f.status === 'open'
      ? btn('Mark done', (b) => act({ action: 'feedback-status', id: f.id, status: 'done', note: prompt('A note for yourself (optional)', '') ?? undefined }, b))
      : btn('Reopen', (b) => act({ action: 'feedback-status', id: f.id, status: 'open' }, b))));
}

function mount() {
  if (root) return;
  root = el('section', { id: 'travel-beta', 'aria-label': 'Eden Travel private beta', style: 'max-width:1280px;margin:24px auto;padding:0 16px' });
  const main = document.getElementById('main');
  if (main && main.parentNode) main.after(root); else document.body.append(root);
  draw();
  load();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
