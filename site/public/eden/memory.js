// Memory: what the Jarvis app on the owner's Mac remembers about them, as a page of its own —
// search, grouped by topic, where each fact came from (how, when, the words or note it was
// learned from), inline edit, delete with undo, a switch per fact, and "Eden learned this
// from…" (the second brain searched for its source). Through POST /api/chat/jarvis:
// memory_list (free), memory_update / memory_delete / memory_toggle (each confirmed by the
// owner on a card on their Mac before anything changes). An older Jarvis without those tools
// gets the plain recall list, read-only. Everything shown is data, set as text only.

import { el, ico, toast, debounce, isMobile } from './util.js';
import { api } from './api.js';
import { state } from './state.js';
import { checkJarvis } from './panels.js';

const DATA_NOTE = /^\(From the owner's Jarvis:[^)]*\)\s*/;
const strip = (t) => String(t || '').replace(DATA_NOTE, '').trim();
const TOPICS = [
  ['people', 'People'], ['preferences', 'Preferences'], ['work', 'Work'], ['health', 'Health'], ['places', 'Places'], ['other', 'Other'],
];
const TOPIC = Object.fromEntries(TOPICS);
/** How a fact was learned, in the owner's words (memory.py SOURCES). */
const HOW = {
  said: 'You told Jarvis', settings: 'Added in Jarvis Settings', noticed: 'Noticed in a conversation', proposed: 'Suggested after a conversation, you approved',
  dream: 'From your daily notes, you approved', import: 'Imported', synced: 'From your iPhone', before: 'From before Jarvis tracked sources',
};
/** Sources whose origin is words of the owner's, a note or a file: worth looking up in the second brain. */
const LOOKUP = new Set(['said', 'noticed', 'proposed', 'dream', 'import']);
const UNDO_MS = 5000;

let H = { addContext: () => {} };
const S = {
  built: false, open: false, returnFocus: null,
  phase: 'idle', // idle | loading | ready | legacy | off | error
  reason: '', facts: [], legacy: [], query: '', topic: 'all', show: 'all',
  editing: null, pending: new Map(), // id → { kind: 'update' | 'delete' | 'toggle', args }
  hidden: new Set(), // deleted here, waiting out the undo or the Mac's card
  found: new Map(), // id → { state, notes }
  seq: 0,
};
let R = {};
/** One change at a time: each waits for the owner's card on the Mac. */
let chain = Promise.resolve();
const queue = (fn) => (chain = chain.then(fn, fn));

/* ---------------- data ---------------- */

async function jarvis(tool, args) {
  const r = await api.jarvis(tool, args);
  return r;
}
function parseResult(r) {
  try { return JSON.parse(strip(r.text)); } catch { return { done: false, status: r.is_error ? 'failed' : 'not_done', text: strip(r.text) }; }
}

async function load() {
  const seq = ++S.seq;
  S.phase = 'loading';
  render();
  const st = await checkJarvis().catch((e) => ({ available: false, reason: e.message }));
  if (seq !== S.seq) return;
  if (!st.available) { Object.assign(S, { phase: 'off', reason: st.reason || '' }); render(); return; }
  try {
    const r = await jarvis('memory_list', { limit: 200 });
    if (seq !== S.seq) return;
    if (r.is_error) throw new Error(strip(r.text) || 'Jarvis couldn’t list what it remembers.');
    const page = JSON.parse(strip(r.text));
    S.facts = Array.isArray(page.facts) ? page.facts : [];
    S.phase = 'ready';
  } catch (e) {
    if (seq !== S.seq) return;
    // An older Jarvis (before the memory tools): what recall gives, read-only.
    if (/no tool called|unknown tool|tool must be one of/i.test(e.message)) {
      try {
        const r = await jarvis('recall', { query: '' });
        const t = strip(r.text);
        S.legacy = !t || /^Nothing remembered/i.test(t) ? [] : t.split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
        S.phase = 'legacy';
      } catch (e2) { Object.assign(S, { phase: 'error', reason: e2.message }); }
    } else Object.assign(S, { phase: 'error', reason: e.message });
  }
  render();
}

/* ---------------- the surface ---------------- */

function build() {
  if (S.built) return;
  S.built = true;
  R.search = el('input', { class: 'mem-search', type: 'search', placeholder: 'Search what Jarvis remembers…', 'aria-label': 'Search memory', autocomplete: 'off' });
  R.search.addEventListener('input', debounce(() => { S.query = R.search.value.trim(); renderList(); }, 120));
  R.count = el('span', 'mem-count');
  R.busy = el('span', { class: 'cal-busy', 'aria-hidden': 'true' });
  const head = el('header', 'mem-head',
    el('div', 'mem-titlewrap', ico('bulb', 18, 'mem-ico'), el('h2', { class: 'mem-title', id: 'memTitle' }, 'Memory'), R.busy, R.count),
    el('div', 'mem-searchwrap', ico('search', 14), R.search),
    el('div', 'mem-acts',
      el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Refresh', title: 'Refresh', onclick: () => load() }, ico('retry', 15)),
      el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Close memory', title: 'Close · esc', onclick: closeMemory }, ico('x'))));
  R.topics = el('nav', { class: 'mem-topics', 'aria-label': 'Topics' });
  R.show = el('div', { class: 'seg mem-show', style: '--n:3', role: 'radiogroup', 'aria-label': 'Show' }, el('div', 'seg-thumb'),
    ...[['all', 'All'], ['on', 'In use'], ['off', 'Off']].map(([v, t]) => el('button', { type: 'button', role: 'radio', 'data-show': v }, t)));
  R.show.addEventListener('click', (e) => { const b = e.target.closest('[data-show]'); if (b) { S.show = b.dataset.show; renderList(); } });
  R.side = el('aside', 'mem-side', el('div', 'mem-side-h', 'Topics'), R.topics, el('div', 'mem-side-h', 'Show'), R.show,
    el('p', 'mem-side-note', 'Each change is confirmed on your Mac: Jarvis shows a card, and nothing changes until you say yes there.'));
  R.banner = el('div', { class: 'mem-banners', 'aria-live': 'polite' });
  R.list = el('div', { class: 'mem-list', role: 'list', 'aria-label': 'What Jarvis remembers' });
  R.main = el('main', 'mem-main', R.banner, R.list);
  R.card = el('section', { class: 'mem glass', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'memTitle' }, head, el('div', 'mem-body', R.side, R.main));
  R.root = el('div', { id: 'memSurface', class: 'mem-scrim', hidden: true }, R.card);
  R.root.addEventListener('pointerdown', (e) => { if (e.target === R.root) closeMemory(); });
  R.card.addEventListener('keydown', onKey);
  R.list.addEventListener('click', onListClick);
  R.list.addEventListener('change', onListChange);
  document.body.append(R.root);
}

export function openMemory(opts = {}) {
  build();
  if (!S.open) {
    S.returnFocus = document.activeElement;
    S.open = true;
    R.root.hidden = false;
    document.body.classList.add('mem-open');
  }
  if (typeof opts.query === 'string') { S.query = opts.query; R.search.value = opts.query; }
  load();
  requestAnimationFrame(() => (isMobile() ? R.card : R.search).focus({ preventScroll: true }));
}
export function closeMemory() {
  if (!S.open) return false;
  S.open = false;
  S.editing = null;
  R.root.hidden = true;
  document.body.classList.remove('mem-open');
  if (S.returnFocus && document.contains(S.returnFocus)) S.returnFocus.focus();
  return true;
}
export const memoryOpen = () => S.open;

function onKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    if (S.editing) { S.editing = null; renderList(); return; }
    if (S.query && document.activeElement === R.search) { S.query = ''; R.search.value = ''; renderList(); return; }
    closeMemory();
    return;
  }
  if (e.key === 'Tab') {
    const f = [...R.card.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea, select, [tabindex="0"]')].filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
    else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
    return;
  }
  if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) { e.preventDefault(); R.search.focus(); }
}

/* ---------------- rendering ---------------- */

function render() {
  if (!S.built) return;
  R.busy.classList.toggle('on', S.phase === 'loading');
  renderBanner();
  renderList();
}

function renderBanner() {
  const b = [];
  if (S.phase === 'off') {
    b.push(el('div', 'mem-mac',
      el('div', 'mem-mac-ico', ico('lock', 22)),
      el('h3', '', 'This needs your Mac'),
      el('p', '', S.reason || 'The Jarvis app on your Mac isn’t reachable.'),
      el('p', 'mem-mac-why', 'Memory lives in the Jarvis app on your Mac. Open it to connect; the first time, it asks on screen whether Eden may use it.'),
      el('div', 'mem-mac-acts', el('button', { type: 'button', class: 'btn primary', onclick: () => load() }, 'Try again'))));
  } else if (S.phase === 'error') {
    b.push(el('div', 'sp-warn', el('b', '', 'Couldn’t read your memory'), S.reason, ' ', el('button', { type: 'button', class: 'cap', onclick: () => load() }, 'Try again')));
  } else if (S.phase === 'legacy') {
    b.push(el('div', 'mem-banner', ico('bulb', 14), el('span', '', 'Your Jarvis app is from before Memory in Eden: restart it on your Mac to see where each fact came from, edit, delete and switch facts. Until then this list is read-only.')));
  }
  R.banner.replaceChildren(...b);
  R.main.classList.toggle('blocked', S.phase === 'off');
}

const norm = (s) => String(s || '').toLowerCase();
function matches(f) {
  const words = norm(S.query).split(/\s+/).filter(Boolean);
  const hay = norm(`${f.text} ${f.origin || ''} ${HOW[f.source] || ''} ${TOPIC[f.category] || ''}`);
  return words.every((w) => hay.includes(w));
}
function visible() {
  // A fact forgotten here stays hidden through the undo, then shows as waiting on the Mac's card.
  return S.facts.filter((f) => (!S.hidden.has(f.id) || (S.pending.get(f.id) || {}).kind === 'delete') && (S.topic === 'all' || f.category === S.topic) && (S.show === 'all' || (S.show === 'on') === (f.on !== false)) && matches(f));
}

function renderTopics() {
  const live = S.facts.filter((f) => !S.hidden.has(f.id));
  const count = (k) => (k === 'all' ? live.length : live.filter((f) => f.category === k).length);
  R.topics.replaceChildren(...[['all', 'Everything'], ...TOPICS].map(([k, t]) => {
    const n = count(k);
    return el('button', { type: 'button', class: `mem-topic${S.topic === k ? ' on' : ''}`, 'aria-pressed': String(S.topic === k), disabled: S.phase !== 'ready' || (k !== 'all' && !n && S.topic !== k), onclick: () => { S.topic = k; renderList(); } },
      el('span', 'nm', t), el('span', 'n', String(n)));
  }));
  const i = ['all', 'on', 'off'].indexOf(S.show);
  R.show.querySelector('.seg-thumb').style.setProperty('--i', i);
  R.show.querySelectorAll('button').forEach((x, j) => { x.classList.toggle('on', j === i); x.setAttribute('aria-checked', String(j === i)); x.disabled = S.phase !== 'ready'; });
  const off = live.filter((f) => f.on === false).length;
  R.count.textContent = S.phase === 'ready' ? `${live.length} fact${live.length === 1 ? '' : 's'}${off ? ` · ${off} off` : ''}` : S.phase === 'legacy' ? `${S.legacy.length} facts` : '';
}

function renderList() {
  if (!S.built) return;
  renderTopics();
  if (S.phase === 'loading' && !S.facts.length) { R.list.replaceChildren(...[0, 1, 2, 3].map(() => el('div', 'mem-skel'))); return; }
  if (S.phase === 'off' || S.phase === 'error') { R.list.replaceChildren(); return; }
  if (S.phase === 'legacy') {
    const rows = S.legacy.filter((t) => matches({ text: t }));
    R.list.replaceChildren(...(rows.length ? rows.map((t) => el('div', { class: 'mem-fact legacy', role: 'listitem' },
      el('div', 'mf-main', el('p', 'mf-text', t)),
      el('div', 'mf-acts', useBtn({ text: t }))))
      : [el('div', 'mem-empty', S.query ? 'Nothing remembered matches that.' : 'Jarvis doesn’t remember anything about you yet.')]));
    return;
  }
  const facts = visible();
  if (!facts.length) {
    R.list.replaceChildren(el('div', 'mem-empty', S.facts.length ? (S.query ? `Nothing remembered matches “${S.query}”.` : 'Nothing here.') : 'Jarvis doesn’t remember anything about you yet. Tell it something in a conversation (“remember that…”), or add facts in Jarvis Settings.'));
    return;
  }
  const out = [];
  for (const [k, t] of TOPICS) {
    const group = facts.filter((f) => f.category === k);
    if (!group.length) continue;
    out.push(el('h3', { class: 'mem-group', id: `mem-g-${k}` }, t, el('span', '', String(group.length))));
    for (const f of group) out.push(factRow(f));
  }
  const stray = facts.filter((f) => !TOPIC[f.category]);
  if (stray.length) { out.push(el('h3', 'mem-group', 'Other', el('span', '', String(stray.length)))); for (const f of stray) out.push(factRow(f)); }
  const focusId = document.activeElement && document.activeElement.closest && document.activeElement.closest('[data-id]') && document.activeElement.closest('[data-id]').dataset.id;
  const focusAct = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.act;
  R.list.replaceChildren(...out);
  if (focusId) { const back = R.list.querySelector(`[data-id="${CSS.escape(focusId)}"] ${focusAct ? `[data-act="${focusAct}"]` : '[data-act]'}`); if (back) back.focus({ preventScroll: true }); }
}

function day(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t), now = new Date();
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}
const longDay = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : ''; };

/** Where it was learned, for "Eden learned this from …": the conversation, note, import or device, and the owner's words. */
function fromLine(f) {
  const when = day(f.learned);
  const o = String(f.origin || '').trim();
  const quote = o ? `: “${o}”` : '';
  switch (f.source) {
    case 'said': case 'noticed': case 'proposed': return `a conversation${when ? ` on ${when}` : ''}${quote}`;
    case 'dream': return `your daily notes${quote}`;
    case 'import': return `an import${o ? ` from ${o}` : ''}${when ? `, ${when}` : ''}`;
    case 'settings': return `Jarvis Settings${when ? `, ${when}` : ''}`;
    case 'synced': return `your iPhone${when ? `, ${when}` : ''}`;
    default: return `before Jarvis kept track of sources${when ? ` (saved ${when})` : ''}`;
  }
}

function useBtn(f) {
  return el('button', { type: 'button', class: 'iconbtn', 'data-act': 'use', title: 'Use in your next message', 'aria-label': 'Use in your next message', onclick: () => { H.addContext({ title: `Memory: ${f.text.slice(0, 40)}${f.text.length > 40 ? '…' : ''}`, text: f.text }); closeMemory(); } }, ico('plus', 14));
}

function factRow(f) {
  const pending = S.pending.get(f.id);
  // While the Mac's card is up, the switch shows what was asked for.
  const on = pending && pending.kind === 'toggle' ? pending.args.on : f.on !== false;
  const row = el('div', { class: `mem-fact${on ? '' : ' off'}${pending ? ' pending' : ''}${pending && pending.kind === 'delete' ? ' going' : ''}`, role: 'listitem', 'data-id': f.id });
  if (S.editing === f.id) { row.append(editor(f)); return row; }
  const meta = el('div', 'mf-meta',
    el('span', 'mf-src', HOW[f.source] || 'Learned'),
    f.learned ? el('span', '', el('time', { datetime: f.learned, title: longDay(f.learned) }, day(f.learned))) : null,
    f.changed && f.learned && day(f.changed) !== day(f.learned) ? el('span', '', `edited ${day(f.changed)}`) : null,
    f.confidence && f.confidence !== 'high' ? el('span', 'mf-conf', f.confidence === 'medium' ? 'fairly sure' : 'not sure') : null,
    f.expires ? el('span', '', `until ${day(f.expires)}`) : null,
    on ? null : el('span', 'mf-offtag', 'Off: not used'));
  const lookup = LOOKUP.has(f.source) && String(f.origin || '').trim();
  const from = el('button', { type: 'button', class: 'mf-from', 'data-act': 'from', 'aria-expanded': String(S.found.has(f.id)), disabled: !lookup, title: lookup ? 'Look for it in your second brain' : '' },
    el('span', 'k', 'Eden learned this from'), el('span', 'v', fromLine(f)), lookup ? ico('chevr', 12) : null);
  const found = S.found.get(f.id);
  const sw = el('label', { class: 'switch mf-switch', title: on ? 'In use: Jarvis uses this fact' : 'Off: kept, but Jarvis doesn’t use it' },
    el('input', { type: 'checkbox', role: 'switch', 'data-act': 'toggle', checked: on, disabled: !!pending, 'aria-label': `Use this fact: ${f.text}` }), el('span', 'tr'));
  row.append(
    el('div', 'mf-main',
      el('p', 'mf-text', f.text),
      meta,
      from,
      found ? foundList(f, found) : null,
      pending ? el('div', 'mf-wait', el('span', 'ld'), pending.kind === 'delete' ? 'Approve forgetting it on your Mac…' : 'Approve this change on your Mac…') : null),
    el('div', 'mf-acts',
      sw,
      el('button', { type: 'button', class: 'iconbtn', 'data-act': 'edit', title: 'Edit', 'aria-label': 'Edit this fact', disabled: !!pending }, ico('edit', 14)),
      useBtn(f),
      el('button', { type: 'button', class: 'iconbtn mf-del', 'data-act': 'delete', title: 'Forget', 'aria-label': 'Forget this fact', disabled: !!pending }, ico('trash', 14))));
  return row;
}

function foundList(f, found) {
  if (found.state === 'loading') return el('div', 'mf-found muted', 'Looking in your second brain…');
  if (found.state === 'error') return el('div', 'mf-found muted', `Couldn’t look: ${found.error}`);
  if (!found.notes.length) return el('div', 'mf-found muted', 'Nothing in your second brain matches its source (conversations Jarvis didn’t keep aren’t there).');
  return el('div', 'mf-found', ...found.notes.map((n) => {
    const full = el('div', 'note-full');
    full.hidden = true;
    return el('div', 'mf-note',
      el('button', { type: 'button', class: 'mf-note-t', onclick: async (e) => {
        if (!n.id) return;
        if (!full.hidden) { full.hidden = true; return; }
        const b = e.currentTarget;
        b.setAttribute('aria-busy', 'true');
        try { const r = await jarvis('read_note', { id: n.id }); full.textContent = strip(r.text); full.hidden = false; } catch (err) { toast(err.message); }
        b.removeAttribute('aria-busy');
      } }, ico('doc', 13), el('b', '', n.title), n.meta ? el('span', 'm', n.meta) : null),
      n.excerpt ? el('p', '', n.excerpt) : null, full);
  }));
}

function editor(f) {
  const ta = el('textarea', { class: 'mf-edit-text', rows: 2, maxlength: 300, 'aria-label': 'The fact' });
  ta.value = f.text;
  const topic = el('select', { 'aria-label': 'Topic' }, ...TOPICS.map(([k, t]) => el('option', { value: k, selected: f.category === k }, t)));
  const sure = el('select', { 'aria-label': 'How sure' }, ...[['high', 'Sure'], ['medium', 'Fairly sure'], ['low', 'Not sure']].map(([k, t]) => el('option', { value: k, selected: (f.confidence || 'high') === k }, t)));
  const until = el('input', { type: 'date', 'aria-label': 'Until (optional)', value: f.expires || '' });
  const save = () => {
    const changes = {};
    const text = ta.value.replace(/\s+/g, ' ').trim();
    if (!text) { toast('A fact needs some words'); ta.focus(); return; }
    if (text !== f.text) changes.text = text;
    if (topic.value !== f.category) changes.category = topic.value;
    if (sure.value !== (f.confidence || 'high')) changes.confidence = sure.value;
    if ((until.value || '') !== (f.expires || '')) changes.expires = until.value || '';
    S.editing = null;
    if (!Object.keys(changes).length) { renderList(); return; }
    change(f, 'update', { ...changes });
  };
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } });
  requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
  return el('div', 'mf-editor',
    ta,
    el('div', 'mf-edit-row',
      el('label', '', el('span', '', 'Topic'), topic),
      el('label', '', el('span', '', 'How sure'), sure),
      el('label', '', el('span', '', 'Until'), until)),
    el('div', 'mf-edit-acts',
      el('span', 'mf-edit-note', 'Where it was learned stays on record. Your Mac asks you to confirm.'),
      el('button', { type: 'button', class: 'btn', onclick: () => { S.editing = null; renderList(); } }, 'Cancel'),
      el('button', { type: 'button', class: 'btn primary', onclick: save }, 'Save')));
}

/* ---------------- changes (each on the owner's yes on their Mac) ---------------- */

const SAID = {
  declined: 'You said no on your Mac: nothing changed.',
  timed_out: 'No answer on your Mac in time: nothing changed.',
};

function change(f, kind, args) {
  S.pending.set(f.id, { kind, args });
  renderList();
  const tool = { update: 'memory_update', delete: 'memory_delete', toggle: 'memory_toggle' }[kind];
  return queue(async () => {
    let out;
    try { out = parseResult(await jarvis(tool, { id: f.id, ...args, confirm: true })); }
    catch (e) { out = { done: false, status: 'failed', text: e.message }; }
    S.pending.delete(f.id);
    if (out.done) {
      if (kind === 'delete') { S.facts = S.facts.filter((x) => x.id !== f.id); S.hidden.delete(f.id); toast('Forgotten'); }
      else {
        const now = out.fact && out.fact.id === f.id ? out.fact : { ...f, ...(kind === 'toggle' ? { on: args.on } : args) };
        S.facts = S.facts.map((x) => (x.id === f.id ? now : x));
        toast(kind === 'toggle' ? (now.on === false ? 'Off: Jarvis keeps it but won’t use it' : 'On: Jarvis uses it again') : 'Changed');
      }
    } else {
      S.hidden.delete(f.id);
      toast(SAID[out.status] || `Didn’t change: ${out.text || 'Jarvis said no.'}`);
      if (/doesn't remember|any more/i.test(out.text || '')) load();
    }
    renderList();
  });
}

function forget(f) {
  S.hidden.add(f.id);
  renderList();
  let undone = false;
  const t = setTimeout(() => { if (!undone) change(f, 'delete', {}); }, UNDO_MS);
  toast(`Forgetting “${f.text.length > 48 ? `${f.text.slice(0, 47)}…` : f.text}”`, { label: 'Undo', run: () => { undone = true; clearTimeout(t); S.hidden.delete(f.id); renderList(); } });
}

async function lookUp(f) {
  if (S.found.has(f.id)) { S.found.delete(f.id); renderList(); return; }
  S.found.set(f.id, { state: 'loading', notes: [] });
  renderList();
  try {
    const r = await jarvis('search_notes', { query: String(f.origin || f.text).slice(0, 300) });
    const t = strip(r.text);
    const notes = r.is_error || /^Nothing in the second brain/i.test(t) || !t ? [] : t.split(/\n\s*\n/).map((block) => {
      const [first, ...rest] = block.split('\n');
      const m = /^\[([^\]]+)\]\s+(.*?)(?:\s+\(([^()]*)\))?\s*$/.exec(first.trim());
      return m ? { id: m[1], title: m[2], meta: m[3] || '', excerpt: rest.join(' ').trim() } : { id: null, title: first.trim().slice(0, 80), meta: '', excerpt: rest.join(' ').trim() };
    }).filter((n) => n.title).slice(0, 3);
    if (S.found.has(f.id)) S.found.set(f.id, { state: 'ready', notes });
  } catch (e) { if (S.found.has(f.id)) S.found.set(f.id, { state: 'error', notes: [], error: e.message }); }
  renderList();
}

function factOf(node) { const row = node.closest('[data-id]'); return row ? S.facts.find((x) => x.id === row.dataset.id) : null; }
function onListClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled || b.tagName === 'INPUT') return;
  const f = factOf(b);
  if (!f) return;
  if (b.dataset.act === 'edit') { S.editing = f.id; renderList(); }
  else if (b.dataset.act === 'delete') forget(f);
  else if (b.dataset.act === 'from') lookUp(f);
}
function onListChange(e) {
  const input = e.target.closest('[data-act="toggle"]');
  if (!input) return;
  const f = factOf(input);
  if (f) change(f, 'toggle', { on: input.checked });
}

export function initMemory(handlers) {
  H = { ...H, ...handlers };
}
