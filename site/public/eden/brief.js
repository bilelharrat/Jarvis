// The morning brief and meeting prep (ROADMAP G5). The brief is a page: today's calendar (the
// Mac and Google), the unread mail that matters (Mail on the Mac and Gmail), notes and memory
// about today's people and the promises due — gathered by Eden's server (POST /api/chat/brief)
// and summarised by a cheap routed model (POST /api/chat/send at router level 1), whose lines
// cite the items ([E1], [M2]) as links. Ten minutes before a meeting with other people, an
// in-page timer offers a prep card (past threads with them, related notes, what Jarvis
// remembers, open promises), and, only if the owner turns it on, a heads-up through Jarvis
// (notify_me) that reaches their iPhone. Read-only: nothing here sends mail or changes events.

import { el, ico, store, fmtCost, shortModel } from './util.js';
import { api, postJSON } from './api.js';
import { state } from './state.js';
import { routeSettings } from './router.js';
import { renderMarkdown } from './markdown.js';
import { openCalendar } from './calendar.js';
import { openMemory } from './memory.js';
import { openSpace } from './panels.js';

const DATA_NOTE = /^\(From the owner's Jarvis:[^)]*\)\s*/;
const strip = (t) => String(t || '').replace(DATA_NOTE, '').trim();
const LEAD_MS = 10 * 60_000; // prep is offered this long before a meeting
const EVENTS_EVERY_MS = 5 * 60_000; // the prep timer re-reads today's calendar this often
const TICK_MS = 30_000;
const FRESH_MS = 20 * 60_000; // reopening the brief within this shows the same one
const REF = /\[([EMNFP]\d{1,2})\]/g;
const KEYS = { auto: 'eden:brief:auto', last: 'eden:brief:last', prep: 'eden:prep:on', push: 'eden:prep:push', offered: 'eden:prep:offered' };
const SOURCE_NAME = { mac: 'Your Mac', gmail: 'Gmail', gcal: 'Google Calendar' };

let H = { addContext: () => {} };
const S = {
  built: false, open: false, returnFocus: null,
  view: 'brief', // brief | prep
  brief: null, briefAt: 0, briefError: null, loading: false,
  prep: null, prepEvent: null, prepError: null, prepLoading: false,
  sum: { brief: null, prep: null }, // { text, model, cost, state: streaming|done|error|none, error, abort }
  expanded: new Map(), // `${kind}:${id}` → { state, text }
  settingsOpen: false,
};
const P = { events: [], day: '', fetchedAt: 0, timer: null, offerEl: null, offered: new Set(store.get(KEYS.offered, [])) };
let R = {};

const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmtTime = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''; };
const ago = (iso) => {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const m = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (m < 60) return m < 1 ? 'just now' : `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
};
const people = (list, n = 3) => (list || []).slice(0, n).map((p) => p.name || p.email).join(', ') + ((list || []).length > n ? ` +${list.length - n}` : '');

/* ---------------- loading ---------------- */

async function loadBrief(force = false) {
  if (S.loading) return;
  if (!force && S.brief && S.brief.day === localDay() && Date.now() - S.briefAt < FRESH_MS) { render(); return; }
  S.loading = true;
  S.briefError = null;
  stopSummary('brief');
  render();
  try {
    const b = await postJSON('/api/chat/brief', { kind: 'brief', day: localDay(), tzOffset: new Date().getTimezoneOffset() });
    S.brief = b;
    S.briefAt = Date.now();
    S.expanded.clear();
    rememberEvents(b.events, b.day);
  } catch (e) {
    S.briefError = e;
  }
  S.loading = false;
  render();
  if (S.brief && !S.briefError) summarise('brief', S.brief.summary);
}

async function loadPrep(event) {
  S.view = 'prep';
  S.prepEvent = event;
  S.prep = null;
  S.prepError = null;
  S.prepLoading = true;
  S.expanded.clear();
  stopSummary('prep');
  render();
  try {
    S.prep = await postJSON('/api/chat/brief', { kind: 'prep', event: { id: event.id, source: event.source, title: event.title, start: event.start, end: event.end, location: event.location, url: event.url, attendees: event.attendees }, tzOffset: new Date().getTimezoneOffset() });
  } catch (e) { S.prepError = e; }
  S.prepLoading = false;
  if (S.view !== 'prep' || S.prepEvent !== event) return;
  render();
  if (S.prep) summarise('prep', S.prep.summary);
}

/** The cheap routed model's summary (router level 1), streamed. */
function summarise(kind, summary) {
  stopSummary(kind);
  const settings = { ...routeSettings(), level: 1, efficiency: 80, performance: 30 };
  if (!summary || !summary.prompt) return;
  if (!settings.providers || !settings.providers.length) { S.sum[kind] = { state: 'none', text: '' }; renderSummary(); return; }
  const ctl = new AbortController();
  const s = { state: 'streaming', text: '', model: '', cost: null, notional: false, abort: () => ctl.abort() };
  S.sum[kind] = s;
  renderSummary();
  let raf = 0;
  const paint = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderSummary(); }); };
  // The items (mail snippets, events, notes) are untrusted: they go as a context block, which the server wraps (H8).
  api.send({ messages: [{ role: 'user', content: 'Write it from the items in the context.' }], context: [{ title: kind === 'prep' ? 'Brief: meeting prep items' : 'Brief: today’s items', text: summary.prompt, source: 'brief' }], system: summary.system, settings, mode: 'chat' }, {
    signal: ctl.signal,
    onEvent: (type, d) => {
      if (S.sum[kind] !== s) return;
      if (type === 'route') { s.model = d.modelName || d.model || ''; s.cost = d.costUSD; }
      else if (type === 'text') { s.text += d.text || ''; paint(); }
      else if (type === 'usage') { s.cost = d.costUSD; s.notional = !!d.notional; }
      else if (type === 'error') { s.state = 'error'; s.error = d.message || 'The summary failed.'; }
    },
  }).then(() => { if (S.sum[kind] === s && s.state === 'streaming') s.state = 'done'; }, (e) => { if (S.sum[kind] === s && e.name !== 'AbortError') { s.state = 'error'; s.error = e.message; } })
    .finally(() => { if (S.sum[kind] === s) renderSummary(); });
}
function stopSummary(kind) {
  const s = S.sum[kind];
  if (s && s.state === 'streaming' && s.abort) s.abort();
  S.sum[kind] = null;
}

/* ---------------- the surface ---------------- */

function build() {
  if (S.built) return;
  S.built = true;
  R.title = el('h2', { class: 'brf-title', id: 'brfTitle' }, 'Brief');
  R.sub = el('span', 'brf-sub');
  R.busy = el('span', { class: 'cal-busy', 'aria-hidden': 'true' });
  R.back = el('button', { type: 'button', class: 'iconbtn brf-back', 'aria-label': 'Back to the brief', title: 'Back to the brief', onclick: () => { S.view = 'brief'; S.expanded.clear(); stopSummary('prep'); render(); if (!S.brief) loadBrief(); } }, ico('chevl'));
  R.gear = el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Brief settings', title: 'Brief settings', 'aria-expanded': 'false', onclick: () => { S.settingsOpen = !S.settingsOpen; renderSettings(); } }, ico('gear', 15));
  R.settings = el('div', { class: 'brf-settings glass', role: 'dialog', 'aria-label': 'Brief settings', hidden: true });
  const head = el('header', 'brf-head',
    R.back,
    el('div', 'brf-titlewrap', ico('sun', 18, 'brf-ico'), el('div', 'brf-tt', R.title, R.sub), R.busy),
    el('span', 'brf-sp'),
    el('div', 'brf-acts',
      el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Refresh', title: 'Refresh', onclick: () => (S.view === 'prep' && S.prepEvent ? loadPrep(S.prepEvent) : loadBrief(true)) }, ico('retry', 15)),
      R.gear,
      el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Close brief', title: 'Close · esc', onclick: closeBrief }, ico('x'))));
  R.body = el('main', { class: 'brf-main', 'aria-live': 'polite' });
  R.card = el('section', { class: 'brf glass', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'brfTitle', tabindex: '-1' }, head, R.body, R.settings);
  R.root = el('div', { id: 'briefSurface', class: 'brf-scrim', hidden: true }, R.card);
  R.root.addEventListener('pointerdown', (e) => {
    if (e.target === R.root) { closeBrief(); return; }
    if (S.settingsOpen && !R.settings.contains(e.target) && !R.gear.contains(e.target)) { S.settingsOpen = false; renderSettings(); }
  });
  R.card.addEventListener('keydown', onKey);
  R.body.addEventListener('click', onRefClick);
  document.body.append(R.root);
}

export function openBrief(opts = {}) {
  build();
  if (!S.open) {
    S.returnFocus = document.activeElement;
    S.open = true;
    R.root.hidden = false;
    document.body.classList.add('brf-open');
  }
  store.set(KEYS.last, localDay());
  if (opts.prep) loadPrep(opts.prep);
  else { S.view = 'brief'; loadBrief(!!opts.force); }
  requestAnimationFrame(() => R.card.focus({ preventScroll: true }));
}
export function closeBrief() {
  if (!S.open) return false;
  S.open = false;
  S.settingsOpen = false;
  stopSummary('prep');
  R.root.hidden = true;
  document.body.classList.remove('brf-open');
  if (S.returnFocus && document.contains(S.returnFocus)) S.returnFocus.focus();
  return true;
}
export const briefOpen = () => S.open;
/** Meeting prep for one event (from the calendar, the prep card, or the brief). */
export function openPrep(event) { openBrief({ prep: event }); }

function onKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    if (S.settingsOpen) { S.settingsOpen = false; renderSettings(); R.gear.focus(); return; }
    if (S.view === 'prep' && S.brief) { R.back.click(); return; }
    closeBrief();
    return;
  }
  if (e.key === 'Tab') {
    const scope = S.settingsOpen ? R.settings : R.card;
    const f = [...scope.querySelectorAll('button:not([disabled]), input:not([disabled]), a[href], [tabindex="0"]')].filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
    else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
  }
}

/* ---------------- rendering ---------------- */

function render() {
  if (!S.built) return;
  const prep = S.view === 'prep';
  R.back.hidden = !prep;
  R.busy.classList.toggle('on', prep ? S.prepLoading : S.loading);
  if (prep) {
    const e = S.prepEvent;
    R.title.textContent = e ? `Prep: ${e.title}` : 'Prep';
    R.sub.textContent = e ? `${e.allDay ? 'All day' : `${fmtTime(e.start)}–${fmtTime(e.end)}`}${e.attendees && e.attendees.length ? ` · with ${people(e.attendees)}` : ''}` : '';
    R.body.replaceChildren(...prepView());
  } else {
    R.title.textContent = 'Brief';
    R.sub.textContent = new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
    R.body.replaceChildren(...briefView());
  }
  renderSummary();
}

function needsMac(err, retry) {
  const hosted = err && (err.status === 503 || err.status === 404 || err.status === 0);
  return el('div', 'mem-mac brf-mac',
    el('div', 'mem-mac-ico', ico('lock', 22)),
    el('h3', '', hosted ? 'This needs your Mac' : 'The brief didn’t load'),
    el('p', '', err ? err.message : 'Eden on your Mac isn’t reachable.'),
    el('p', 'mem-mac-why', 'The brief reads your calendar, mail and notes through Eden and the Jarvis app on your Mac. Open them there, then try again.'),
    el('div', 'mem-mac-acts', el('button', { type: 'button', class: 'btn primary', onclick: retry }, 'Try again')));
}

function sourcesLine(sources) {
  const chips = Object.entries(sources || {}).map(([k, s]) => el('span', { class: `brf-src ${s.state}`, title: s.reason || '' },
    el('span', 'dot'), SOURCE_NAME[k] || k, s.state === 'ok' ? null : el('span', 'why', s.state === 'off' ? 'not connected' : s.state === 'unset' ? 'not set up' : 'failed')));
  return el('div', 'brf-sources', ...chips);
}
function macBanner(sources) {
  const mac = sources && sources.mac;
  if (!mac || mac.state === 'ok') return null;
  return el('div', 'sp-warn brf-warn', el('b', '', mac.state === 'off' ? 'Your Mac isn’t connected' : 'Your Mac didn’t answer fully'),
    `${mac.reason || ''} Notes, memory, promises and the Mac’s calendar and mail come through the Jarvis app on your Mac.`);
}

function section(title, count, kids, empty) {
  return el('section', 'brf-sec',
    el('h3', 'brf-sec-h', title, count ? el('span', '', String(count)) : null),
    kids.length ? el('div', 'brf-rows', ...kids) : el('div', 'brf-empty', empty));
}

function summaryBox(kind) {
  R.sum = el('div', { class: 'brf-sum', 'data-kind': kind });
  return R.sum;
}
function renderSummary() {
  if (!R.sum || !document.contains(R.sum)) return;
  const kind = R.sum.dataset.kind;
  const s = S.sum[kind];
  const data = kind === 'prep' ? S.prep : S.brief;
  const head = el('div', 'brf-sum-h', ico('spark', 14), el('b', '', kind === 'prep' ? 'Before you go in' : 'Your day'),
    s && s.model ? el('span', { class: 'brf-model', title: 'Picked by the router at level 1 (max efficiency)' }, `${shortModel(s.model)}${s.cost != null ? ` · ${fmtCost(s.cost, { notional: s.notional })}` : ''}`) : null);
  let body;
  if (!data) body = el('div', 'brf-sum-skel', el('span'), el('span'), el('span'));
  else if (!s) body = el('div', 'muted', '…');
  else if (s.state === 'none') body = el('div', 'muted', 'No model is available for the summary (add an API key in Settings). Everything is listed below.');
  else if (s.state === 'error' && !s.text) body = el('div', 'muted', `The summary didn’t come: ${s.error} `, el('button', { type: 'button', class: 'cap', onclick: () => summarise(kind, data.summary) }, 'Try again'));
  else if (!s.text) body = el('div', 'brf-sum-skel', el('span'), el('span'), el('span'));
  else {
    body = el('div', 'brf-sum-md md');
    body.append(renderMarkdown(s.text));
    linkRefs(body, data);
    if (s.state === 'streaming') body.classList.add('streaming');
  }
  R.sum.replaceChildren(head, body);
}

/** [E1], [M2]… in the summary become links to their items. */
function linkRefs(root, data) {
  const label = refLabels(data);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) if (/\[[EMNFP]\d/.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const frag = document.createDocumentFragment();
    let last = 0;
    const s = n.nodeValue;
    for (const m of s.matchAll(REF)) {
      if (!label.has(m[1])) continue;
      if (m.index > last) frag.append(s.slice(last, m.index));
      frag.append(el('button', { type: 'button', class: 'brf-ref', 'data-ref': m[1], title: label.get(m[1]) }, label.get(m[1])));
      last = m.index + m[0].length;
    }
    if (last === 0) continue;
    if (last < s.length) frag.append(s.slice(last));
    n.replaceWith(frag);
  }
}
function refLabels(d) {
  const out = new Map();
  const short = (t) => (t.length > 26 ? `${t.slice(0, 25)}…` : t);
  if (!d) return out;
  for (const e of d.events || (d.event ? [d.event] : [])) out.set(e.ref, short(e.title));
  for (const m of d.mail || d.threads || []) out.set(m.ref, short(m.fromName || m.subject));
  for (const n of d.notes || []) out.set(n.ref, short(n.title));
  for (const f of d.facts || []) out.set(f.ref, short(f.about || f.text));
  for (const p of d.promises || []) out.set(p.ref, short(p.text));
  return out;
}
function onRefClick(e) {
  const b = e.target.closest('.brf-ref');
  if (!b) return;
  const target = R.body.querySelector(`[data-item="${b.dataset.ref}"]`);
  if (!target) return;
  target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  target.classList.remove('flash');
  void target.offsetWidth;
  target.classList.add('flash');
  (target.querySelector('button') || target).focus({ preventScroll: true });
}

function briefView() {
  if (S.briefError && !S.brief) return [needsMac(S.briefError, () => loadBrief(true))];
  const b = S.brief;
  if (!b) return [summaryBox('brief'), el('div', 'brf-skel'), el('div', 'brf-skel'), el('div', 'brf-skel short')];
  const events = b.events.map(eventRow);
  return [
    macBanner(b.sources),
    summaryBox('brief'),
    section('Today', events.length, events, 'Nothing on your calendar today.'),
    section('Mail to look at', b.mail.length, b.mail.map((m) => mailRow(m)), b.sources.gmail.state === 'ok' || b.sources.mac.state === 'ok' ? 'No unread mail that needs you.' : 'Connect Gmail (Mail panel) or your Mac to see mail here.'),
    b.promises.length ? section('Promises due', b.promises.length, b.promises.map(promiseRow), '') : null,
    b.notes.length ? section('Notes for today’s meetings', b.notes.length, b.notes.map((n) => noteRow(n, b)), '') : null,
    b.facts.length ? section('About today’s people', b.facts.length, b.facts.map(factRow), '') : null,
    el('footer', 'brf-foot', sourcesLine(b.sources), settingsLine()),
  ].filter(Boolean);
}

function prepView() {
  if (S.prepError && !S.prep) return [needsMac(S.prepError, () => loadPrep(S.prepEvent))];
  const p = S.prep;
  if (!p) return [summaryBox('prep'), el('div', 'brf-skel'), el('div', 'brf-skel short')];
  const e = p.event;
  return [
    macBanner(p.sources),
    el('div', 'brf-prep-ev', el('div', 'brf-time', e.allDay ? 'All day' : fmtTime(e.start)),
      el('div', 'brf-prep-what', el('b', '', e.title), el('span', '', [e.location, p.people.length ? `with ${people(p.people, 6)}` : ''].filter(Boolean).join(' · '))),
      e.url && /^https:\/\//.test(e.url) ? el('a', { class: 'cap', href: e.url, target: '_blank', rel: 'noopener noreferrer' }, ico('ext', 12), 'Join') : null),
    summaryBox('prep'),
    section('Recent threads with them', p.threads.length, p.threads.map((m) => mailRow(m)), 'No recent email with them.'),
    p.promises.length ? section('Open promises to them', p.promises.length, p.promises.map(promiseRow), '') : null,
    p.facts.length ? section('What Jarvis remembers', p.facts.length, p.facts.map(factRow), '') : null,
    section('Related notes', p.notes.length, p.notes.map((n) => noteRow(n, null)), 'Nothing related in your second brain.'),
    el('footer', 'brf-foot', sourcesLine(p.sources)),
  ].filter(Boolean);
}

function eventRow(e) {
  const now = Date.now();
  const past = !e.allDay && Date.parse(e.end) < now;
  const live = !e.allDay && Date.parse(e.start) <= now && !past;
  return el('div', { class: `brf-row brf-ev${past ? ' past' : ''}${live ? ' live' : ''}`, 'data-item': e.ref },
    el('button', { type: 'button', class: 'brf-row-main', title: 'Open in the calendar', onclick: () => { closeBrief(); openCalendar({ date: new Date(e.allDay ? `${e.start}T00:00` : e.start) }); } },
      el('span', 'brf-time', e.allDay ? 'All day' : fmtTime(e.start)),
      el('span', 'brf-what', el('b', '', e.title),
        el('span', 'brf-meta', [e.allDay ? '' : `until ${fmtTime(e.end)}`, e.location, e.attendees.length ? `with ${people(e.attendees)}` : '', e.source === 'google' ? 'Google' : e.calendar].filter(Boolean).join(' · ')))),
    e.prep ? el('button', { type: 'button', class: 'cap brf-prep-btn', onclick: () => loadPrep(e) }, ico('list', 12), 'Prep') : null);
}

function expander(key, paint) {
  const x = S.expanded.get(key);
  const box = el('div', 'brf-more');
  if (!x) { box.hidden = true; return box; }
  if (x.state === 'loading') box.append(el('div', 'muted', 'Opening…'));
  else if (x.state === 'error') box.append(el('div', 'muted', `Couldn’t open it: ${x.text}`));
  else box.append(...paint(x.text));
  return box;
}
async function toggleExpand(key, load) {
  if (S.expanded.has(key)) { S.expanded.delete(key); render(); return; }
  S.expanded.set(key, { state: 'loading', text: '' });
  render();
  try { const text = await load(); if (S.expanded.has(key)) S.expanded.set(key, { state: 'ready', text }); }
  catch (e) { if (S.expanded.has(key)) S.expanded.set(key, { state: 'error', text: e.message }); }
  render();
}

async function readMail(m) {
  if (m.source === 'gmail') {
    const r = await api.gmail('read', { id: m.id });
    return String((r && (r.body || r.snippet)) || '').trim() || m.snippet;
  }
  const r = await api.jarvis('mail_read', { id: m.id });
  if (r.is_error) throw new Error(strip(r.text) || 'Mail said no.');
  try { const j = JSON.parse(strip(r.text)); return String(j.body || j.snippet || '').trim() || m.snippet; } catch { return strip(r.text); }
}
function mailRow(m) {
  const key = `mail:${m.source}:${m.id}`;
  const open = S.expanded.has(key);
  return el('div', { class: `brf-row brf-mail${open ? ' open' : ''}`, 'data-item': m.ref },
    el('button', { type: 'button', class: 'brf-row-main', 'aria-expanded': String(open), onclick: () => toggleExpand(key, () => readMail(m)) },
      el('span', { class: `brf-av${m.unread ? ' unread' : ''}`, 'aria-hidden': 'true' }, (m.fromName || '?').trim().charAt(0).toUpperCase()),
      el('span', 'brf-what',
        el('span', 'brf-line', el('b', '', m.fromName), el('span', 'brf-when', ago(m.date)), el('span', 'brf-srcname', m.source === 'gmail' ? 'Gmail' : 'Mac')),
        el('span', 'brf-subj', m.subject),
        m.why && m.why.length ? el('span', 'brf-why', m.why.join(' · ')) : el('span', 'brf-snip', m.snippet))),
    expander(key, (text) => [
      el('div', { class: 'brf-body', tabindex: '0', 'aria-label': 'Email' }, text),
      el('div', 'brf-more-acts',
        el('button', { type: 'button', class: 'cap', onclick: () => H.addContext({ title: `Email: ${m.subject}`.slice(0, 80), text: `From: ${m.fromName}${m.fromEmail ? ` <${m.fromEmail}>` : ''}\nSubject: ${m.subject}\n\n${text}` }) }, ico('plus', 12), 'Use in chat'),
        el('button', { type: 'button', class: 'cap', onclick: () => { closeBrief(); openSpace('mail'); } }, ico('mail', 12), 'Open Mail')),
    ]));
}

function noteRow(n, b) {
  const key = `note:${n.id || n.title}`;
  const open = S.expanded.has(key);
  const forTitles = b && n.for ? n.for.map((r) => (b.events.find((e) => e.ref === r) || {}).title).filter(Boolean) : [];
  return el('div', { class: `brf-row brf-note${open ? ' open' : ''}`, 'data-item': n.ref },
    el('button', { type: 'button', class: 'brf-row-main', 'aria-expanded': String(open), disabled: !n.id, onclick: () => toggleExpand(key, async () => { const r = await api.jarvis('read_note', { id: n.id }); if (r.is_error) throw new Error(strip(r.text)); return strip(r.text); }) },
      el('span', 'brf-ico', ico('doc', 15)),
      el('span', 'brf-what', el('b', '', n.title), el('span', 'brf-meta', [n.meta, forTitles.length ? `for ${forTitles.join(', ')}` : ''].filter(Boolean).join(' · ')), n.excerpt ? el('span', 'brf-snip', n.excerpt) : null)),
    expander(key, (text) => [
      el('div', { class: 'brf-body', tabindex: '0', 'aria-label': 'Note' }, text),
      el('div', 'brf-more-acts', el('button', { type: 'button', class: 'cap', onclick: () => H.addContext({ title: `Note: ${n.title}`, text }) }, ico('plus', 12), 'Use in chat')),
    ]));
}

function factRow(f) {
  return el('div', { class: 'brf-row brf-fact', 'data-item': f.ref },
    el('button', { type: 'button', class: 'brf-row-main', title: 'Open in Memory', onclick: () => { closeBrief(); openMemory({ query: f.text.split(/\s+/).slice(0, 4).join(' ') }); } },
      el('span', 'brf-ico', ico('bulb', 15)),
      el('span', 'brf-what', el('span', 'brf-meta', f.about), el('span', 'brf-txt', f.text))));
}

function promiseRow(p) {
  const late = p.due && p.due < localDay();
  return el('div', { class: 'brf-row brf-promise', 'data-item': p.ref },
    el('div', 'brf-row-main static',
      el('span', 'brf-ico', ico('check', 15)),
      el('span', 'brf-what', el('span', 'brf-txt', p.text), el('span', `brf-meta${late ? ' late' : ''}`, [p.to ? `to ${p.to}` : '', p.due ? (late ? `was due ${p.due}` : p.due === localDay() ? 'due today' : `due ${p.due}`) : ''].filter(Boolean).join(' · ')))));
}

/* ---------------- settings ---------------- */

const prepOn = () => store.get(KEYS.prep, true) !== false;
function settingsLine() {
  return el('button', { type: 'button', class: 'brf-set-link', onclick: () => { S.settingsOpen = true; renderSettings(); } },
    store.get(KEYS.auto, false) ? 'Opens on your first visit each day' : 'Open this every morning?', ' · ', prepOn() ? 'Meeting prep on' : 'Meeting prep off');
}
function sw(key, def, label, hint, onChange, disabled) {
  const input = el('input', { type: 'checkbox', role: 'switch', checked: !!store.get(key, def), disabled: !!disabled });
  input.addEventListener('change', () => { store.set(key, input.checked); if (onChange) onChange(input.checked); renderSettings(); if (S.view === 'brief' && S.brief) render(); });
  return el('label', `brf-sw${disabled ? ' off' : ''}`, el('span', 'brf-sw-t', el('b', '', label), el('span', '', hint)), el('span', 'switch', input, el('span', 'tr')));
}
function renderSettings() {
  if (!R.settings) return;
  R.settings.hidden = !S.settingsOpen;
  R.gear.setAttribute('aria-expanded', String(S.settingsOpen));
  if (!S.settingsOpen) return;
  R.settings.replaceChildren(
    el('div', 'brf-set-h', 'Brief and meeting prep'),
    sw(KEYS.auto, false, 'Open the brief each morning', 'The first time you open Eden each day.'),
    sw(KEYS.prep, true, 'Offer meeting prep', 'Ten minutes before a meeting with other people, while Eden is open.', (on) => { if (on) startPrepTimer(); }),
    sw(KEYS.push, false, 'Also tell my iPhone', 'A heads-up through the Jarvis app on your Mac (it reaches your phone).', null, !prepOn()),
    el('p', 'brf-set-note', 'The brief only reads: it never sends email or changes your calendar.'));
  requestAnimationFrame(() => { const f = R.settings.querySelector('input'); if (f) f.focus(); });
}

/* ---------------- meeting prep, ten minutes before ---------------- */

function rememberEvents(events, day) {
  P.events = (events || []).filter((e) => e.prep);
  P.day = day;
  P.fetchedAt = Date.now();
}
async function refreshEvents() {
  if (P.day === localDay() && Date.now() - P.fetchedAt < EVENTS_EVERY_MS) return;
  P.fetchedAt = Date.now(); // a failure waits as long as a success
  const r = await postJSON('/api/chat/brief', { kind: 'events', day: localDay(), tzOffset: new Date().getTimezoneOffset() });
  rememberEvents(r.events, r.day);
}
const offerKey = (e) => `${e.source}|${e.id}|${e.start}`;
async function tickPrep() {
  if (!prepOn()) return;
  try { await refreshEvents(); } catch { return; }
  const now = Date.now();
  for (const e of P.events) {
    const lead = Date.parse(e.start) - now;
    if (!(lead > 0 && lead <= LEAD_MS) || P.offered.has(offerKey(e))) continue;
    P.offered.add(offerKey(e));
    store.set(KEYS.offered, [...P.offered].slice(-100));
    offer(e);
    if (store.get(KEYS.push, false) && state.jarvis.available) {
      const text = `${e.title} at ${fmtTime(e.start)}${e.attendees.length ? ` with ${people(e.attendees)}` : ''}. Your prep is ready in Eden.`;
      api.jarvis('notify_me', { title: 'Meeting prep', text: text.slice(0, 300) }).catch(() => {});
    }
    break; // one card at a time
  }
}
function offer(e) {
  if (P.offerEl) P.offerEl.remove();
  const mins = Math.max(1, Math.round((Date.parse(e.start) - Date.now()) / 60_000));
  const close = () => { card.classList.add('going'); setTimeout(() => card.remove(), 220); if (P.offerEl === card) P.offerEl = null; };
  const card = el('div', { class: 'prep-offer glass', role: 'status', 'aria-live': 'polite' },
    el('div', 'prep-offer-ico', ico('clock', 18)),
    el('div', 'prep-offer-t', el('span', 'k', `In ${mins} min`), el('b', '', e.title), e.attendees.length ? el('span', 'who', `with ${people(e.attendees)}`) : null),
    el('div', 'prep-offer-acts',
      el('button', { type: 'button', class: 'cap primary', onclick: () => { close(); openPrep(e); } }, 'Open prep'),
      el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Not now', title: 'Not now', onclick: close }, ico('x', 14))));
  document.body.append(card);
  P.offerEl = card;
  setTimeout(() => { if (P.offerEl === card) close(); }, LEAD_MS + 5 * 60_000);
}
function startPrepTimer() {
  clearInterval(P.timer);
  P.timer = setInterval(tickPrep, TICK_MS);
  setTimeout(tickPrep, 4000);
}

export function initBrief(handlers) {
  H = { ...H, ...handlers };
  if (prepOn()) startPrepTimer();
  if (store.get(KEYS.auto, false) && store.get(KEYS.last, '') !== localDay()) setTimeout(() => { if (!document.querySelector('.sheet.open, #palette.open')) openBrief(); }, 900);
}
