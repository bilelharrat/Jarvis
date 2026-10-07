// "Use my Mac" (ROADMAP G2) and "Ask about my screen" (H4), on Jarvis's read-only tools
// (docs/chat-api.md "Your Mac in a turn"):
// - a switch (the composer's + menu, the chip it puts above the composer) that lets a chat turn
//   search and read the owner's files: the server plans the reads with the model that answers
//   and sends `mac` events, drawn here as file cards saying which model sees them;
// - a pane that searches the Mac's files and previews one a page at a time (text from Jarvis:
//   shown as text only, never as HTML), with "Use in chat" and "Summarize";
// - "Ask about my screen": the front window (app, title, selected text, its text; a picture when
//   the owner allows one in Jarvis) attached to the next message as a chip they can remove.
// Everything from the Mac is the owner's data and other people's words: text only.

import { $, el, ico, toast, store, sizeText, debounce, shortModel } from './util.js';
import { state } from './state.js';
import { api } from './api.js';
import { currentOverride, modelInfo } from './router.js';
import { privacyOn, localStatus } from './privacy.js';
import { projectKnowledge, openKnowledge } from './knowledge.js';

const KEY = 'eden:useMac';
const KIND_ICON = { folder: 'folder', pdf: 'doc', document: 'doc', presentation: 'art', spreadsheet: 'chart', image: 'art', code: 'code' };
let H = {};

/* ---------- the switch ---------- */

export const macOn = () => store.get(KEY, false) === true;
export function setMac(on) {
  store.set(KEY, !!on);
  if (H.renderComposer) H.renderComposer();
  toast(on ? 'Use my Mac: Eden may search and read your files for this chat’s replies' : 'Use my Mac is off');
}

/** Who will read what the Mac gives: the private chat's local model, the pinned model, or the router's pick. */
export function macReader(c = state.current) {
  if (privacyOn(c)) {
    const want = state.settings.localModel;
    const models = localStatus().models || [];
    const m = models.find((x) => x.id === want) || models[0];
    return { place: 'mac', name: m ? m.id : 'a local model' };
  }
  const o = currentOverride();
  if (o) { const m = modelInfo(o.model); return { place: 'cloud', name: m ? m.name : o.model }; }
  const p = state.preview;
  return { place: 'cloud', name: p && p.pick ? p.pick.name : 'the routed model' };
}

/** What a chat turn adds to its body: { mac: { files, knowledge } } (api.send then goes to /api/chat/mac/send). */
export function macBody(c) {
  if (!c || c.kind === 'code') return {};
  const knowledge = projectKnowledge(c);
  const files = macOn();
  if (!files && !knowledge.length) return {};
  return { mac: { ...(files ? { files: true } : {}), ...(knowledge.length ? { knowledge } : {}) } };
}

/** The chips above the composer: Use my Mac (whose model the files go to) and a project's knowledge. */
export function macChips() {
  const c = state.current;
  const code = !!(c && c.kind === 'code');
  const r = code ? { place: 'cloud', name: 'Claude Code' } : macReader(c);
  const to = (what) => (!state.jarvis.available ? 'your Mac isn’t connected' : r.place === 'mac' ? `${what} stay on this Mac` : `${what} go to ${code ? r.name : shortModel(r.name)}`);
  const chips = [];
  const k = projectKnowledge(c);
  if (k.length) {
    chips.push(el('button', { type: 'button', class: 'jc-file-chip mac-chip kn', title: `Before each reply Eden searches ${k.length} folder${k.length === 1 ? '' : 's'} indexed on your Mac; the passages it finds go to ${r.name}. Change them in Knowledge.`, onclick: () => openKnowledge() },
      ico('bulb', 14), el('span', 'nm', 'Project knowledge'), el('small', '', to('passages'))));
  }
  if (macOn() && !code) {
    chips.push(el('span', { class: 'jc-file-chip mac-chip', title: r.place === 'mac' ? `Files Eden reads stay on this Mac: ${r.name} answers` : `Files Eden reads on your Mac go to ${r.name} with this message` },
      ico('folder', 14), el('span', 'nm', 'Use my Mac'), el('small', '', to('files')),
      el('button', { type: 'button', class: 'jc-chip-x', 'aria-label': 'Turn Use my Mac off', onclick: () => setMac(false) }, '×')));
  }
  return chips;
}

/** The composer's + menu items (composer.js icon names). */
export function macMenuItems() {
  const avail = state.jarvis.available;
  return [
    { icon: 'mac', label: 'Use my Mac', note: avail ? 'Search and read your files for replies' : (state.jarvis.reason || 'Your Mac isn’t connected'), switch: macOn(), run: () => setMac(!macOn()) },
    { icon: 'screen', label: 'Ask about my screen', note: avail ? 'Attach the front window; you approve it on your Mac' : (state.jarvis.reason || 'Your Mac isn’t connected'), run: askScreen },
  ];
}

/* ---------- the server's `mac` events, and their cards ---------- */

export function macEvent(c, node, d) {
  if (!d || typeof d.id !== 'string') return;
  const parts = node.parts || (node.parts = []);
  let part = parts.find((p) => p.type === 'mac' && p.id === d.id);
  if (!part) { part = { type: 'mac', id: d.id }; parts.push(part); }
  Object.assign(part, d);
}

const shown = new Set(); // cards whose whole list is open
function when(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}
function folderOf(f) {
  const p = String(f.display || f.path || '');
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : '';
}

/** One file as a row that opens the preview pane. */
export function fileRow(f, { label, snippet } = {}) {
  const meta = [f.kind === 'folder' ? 'folder' : f.kind, f.size ? sizeText(f.size) : '', when(f.modified)].filter(Boolean).join(' · ');
  return el('button', { type: 'button', class: 'mac-file', title: f.display || f.path, onclick: () => (f.kind === 'folder' ? openFiles(f.name) : openFile(f.path)) },
    label ? el('span', 'mac-k', label) : ico(KIND_ICON[f.kind] || 'doc', 15),
    el('span', 'mac-fbody',
      el('span', 'mac-fname', f.name || f.display || f.path),
      el('span', 'mac-fmeta', [folderOf(f), meta].filter(Boolean).join(' · ')),
      snippet || f.snippet ? el('span', 'mac-fsnip', snippet || f.snippet) : null));
}

function seenLine(part) {
  const s = part.sentTo;
  if (!s) return null;
  return el('div', { class: `mac-seen ${s.place}` }, ico(s.place === 'mac' ? 'lock' : 'globe', 12),
    s.place === 'mac' ? `Stays on this Mac · ${s.name} reads it` : `Seen by ${s.name} · ${s.label || 'cloud'}`);
}

export function macCard(c, node, part) {
  const st = part.state === 'running' ? 'run' : part.state === 'failed' ? 'fail' : 'done';
  const knowledge = part.tool === 'knowledge_search';
  const card = el('div', { class: `tool mac-card open${knowledge ? ' mac-sources' : ''}`, 'data-mac': part.id });
  let sum = '';
  if (st === 'run') sum = 'asking your Mac…';
  else if (st === 'fail') sum = 'didn’t work';
  else if (part.files) sum = `${part.files.length} file${part.files.length === 1 ? '' : 's'}`;
  else if (part.file) sum = `${(part.sent || 0).toLocaleString()} characters${part.cut ? ' (cut to fit)' : ''}`;
  else if (part.results) sum = `${part.results.length} passage${part.results.length === 1 ? '' : 's'}`;
  card.append(el('div', 'tool-head mac-head', ico(knowledge ? 'bulb' : part.tool === 'files_search' ? 'search' : 'doc', 15),
    el('span', 'tname', part.label || part.tool), el('span', 'tsum', sum),
    el('span', { class: `tstat ${st}`, 'aria-label': st === 'run' ? 'running' : st === 'done' ? 'done' : 'failed' })));
  const body = el('div', 'mac-body');
  if (st === 'fail') body.append(el('div', 'mac-err', part.error || 'Jarvis didn’t answer.'));
  const rows = [];
  if (part.files) for (const f of part.files) rows.push(fileRow(f));
  if (part.file) rows.push(fileRow(part.file, { snippet: part.file.pages > 1 ? `page ${part.file.page || 1} of ${part.file.pages}` : part.file.sampled ? 'a long file: its start, middle and end were read' : '' }));
  if (part.results) for (const r of part.results) rows.push(fileRow({ path: r.path, display: r.display, name: r.name, kind: 'document', modified: r.modified }, { label: `K${r.n}`, snippet: String(r.passage || r.excerpt || '').replace(/\s+/g, ' ').slice(0, 180) }));
  if (part.state === 'done' && part.files && !part.files.length) body.append(el('div', 'mac-empty', 'Nothing matched.'));
  const open = shown.has(`${node.id}:${part.id}`);
  body.append(...(open ? rows : rows.slice(0, 5)));
  if (rows.length > 5) body.append(el('button', { type: 'button', class: 'mac-more', onclick: () => { const k = `${node.id}:${part.id}`; if (shown.has(k)) shown.delete(k); else shown.add(k); card.replaceWith(macCard(c, node, part)); } }, open ? 'Show fewer' : `Show all ${rows.length}`));
  const seen = st === 'done' ? seenLine(part) : null;
  if (seen) body.append(seen);
  if (body.childNodes.length) card.append(body);
  return card;
}

/* ---------- the pane: search the Mac, preview a file ---------- */

let paneBack = null;
let returnFocus = null;

export function paneOpen() { return !!($('macPane') && $('macPane').classList.contains('open')); }

/** The side pane (files.js and knowledge.js share it): its body, emptied, under a title. */
export function openPane(title, icon, { back } = {}) {
  let pane = $('macPane');
  if (!pane) {
    pane = el('section', { id: 'macPane', class: 'mac-pane glass', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'macPaneTitle' },
      el('div', 'mac-pane-head',
        el('button', { type: 'button', class: 'iconbtn', id: 'macPaneBack', 'aria-label': 'Back', hidden: true, onclick: () => paneBack && paneBack() }, ico('chevl')),
        el('span', { id: 'macPaneIco' }), el('h2', { id: 'macPaneTitle' }),
        el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => closePane() }, ico('x'))),
      el('div', { class: 'mac-pane-body', id: 'macPaneBody' }));
    pane.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePane(); } });
    document.body.append(pane);
  }
  if (!pane.classList.contains('open')) returnFocus = document.activeElement;
  paneBack = back || null;
  $('macPaneBack').hidden = !back;
  $('macPaneIco').replaceChildren(ico(icon, 16));
  $('macPaneTitle').textContent = title;
  pane.classList.add('open');
  const body = $('macPaneBody');
  body.replaceChildren();
  return body;
}
export function closePane() {
  const pane = $('macPane');
  if (!pane || !pane.classList.contains('open')) return false;
  pane.classList.remove('open');
  const back = returnFocus;
  returnFocus = null;
  if (back && back !== document.body && document.contains(back)) back.focus();
  return true;
}
function focusIn(body) { requestAnimationFrame(() => { const f = body.querySelector('input, button') || $('macPane').querySelector('button'); if (f) f.focus(); }); }

function notConnected(body) {
  body.append(el('div', 'sp-warn', el('b', '', 'Your Mac isn’t connected'), state.jarvis.reason || 'The Jarvis app didn’t answer.'),
    el('p', 'sp-note', 'Files are read through the Jarvis app on your Mac. The first time, it asks you on screen whether Eden may search and read them.'));
}

async function jarvisJson(tool, args) {
  const r = await api.jarvis(tool, args);
  if (r.is_error) throw new Error(String(r.text || 'Jarvis said no.'));
  try { return JSON.parse(r.text); } catch { throw new Error('Jarvis sent something Eden can’t read. Is it up to date?'); }
}

/** Search the Mac's files (Jarvis's index, then Spotlight), in the folders the owner allows. */
let lastQuery = '';
export function openFiles(query = '') {
  query = query || lastQuery;
  if (H.clearPhoneOverlays) H.clearPhoneOverlays();
  const body = openPane('Files on your Mac', 'folder');
  if (!state.jarvis.available) { notConnected(body); focusIn(body); return; }
  const q = el('input', { class: 'sp-search', type: 'search', placeholder: 'Search by name or by what’s inside…', 'aria-label': 'Search your Mac’s files' });
  q.value = query;
  const res = el('div', { class: 'mac-results', 'aria-live': 'polite' });
  const run = async () => {
    const v = q.value.trim();
    lastQuery = v;
    if (!v) { res.replaceChildren(el('div', 'muted', 'Type to search. Files are read on your Mac; one goes to a model only if you use it in chat.')); return; }
    res.replaceChildren(el('div', 'muted', 'Asking your Mac…'));
    try {
      const found = await jarvisJson('files_search', { query: v, limit: 30 });
      if (q.value.trim() !== v) return;
      const files = found.files || [];
      res.replaceChildren(
        el('div', 'mac-where', `Looking in ${(found.folders || ['your home folder']).join(', ')} · choose folders in Jarvis › Settings › Jarvis in other apps`),
        ...(files.length ? files.map((f) => fileRow(f)) : [el('div', 'muted', 'Nothing matched.')]));
    } catch (e) { res.replaceChildren(el('div', 'sp-warn', el('b', '', 'That didn’t work'), e.message)); }
  };
  const deb = debounce(run, 450);
  q.addEventListener('input', deb);
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); deb.cancel(); run(); } });
  body.append(q, res);
  run();
  focusIn(body);
}

/** Preview one file, a page at a time. */
export async function openFile(path, page = 1, { from } = {}) {
  if (H.clearPhoneOverlays) H.clearPhoneOverlays();
  const back = from === 'search' || paneOpen() ? (() => openFiles()) : null;
  const body = openPane(String(path).split('/').pop() || 'File', 'doc', { back });
  if (!state.jarvis.available) { notConnected(body); focusIn(body); return; }
  body.append(el('div', 'muted', 'Reading on your Mac…'));
  let f;
  try { f = await jarvisJson('file_read', { path, page }); }
  catch (e) { body.replaceChildren(el('div', 'sp-warn', el('b', '', 'Eden can’t read that file'), e.message)); focusIn(body); return; }
  const pages = f.pages || 1;
  const title = `File: ${f.name}${pages > 1 ? ` (page ${f.page} of ${pages})` : ''}`;
  const pager = pages > 1 ? el('div', 'mac-pager',
    el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Previous page', disabled: f.page <= 1, onclick: () => openFile(path, f.page - 1, { from }) }, ico('chevl')),
    el('span', { 'aria-live': 'polite' }, `Page ${f.page} of ${pages}`),
    el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Next page', disabled: f.page >= pages, onclick: () => openFile(path, f.page + 1, { from }) }, ico('chevr'))) : null;
  body.replaceChildren(
    el('div', 'mac-meta', el('span', 'mono', f.display || f.path), el('span', '', [f.kind, sizeText(f.size || 0), when(f.modified), `${(f.chars || 0).toLocaleString()} characters`].filter(Boolean).join(' · '))),
    el('div', 'mac-acts',
      el('button', { type: 'button', class: 'cap primary', onclick: () => { H.addContext({ title, text: f.text, kind: 'file' }); closePane(); } }, ico('plus', 12), pages > 1 ? 'Use this page in chat' : 'Use in chat'),
      el('button', { type: 'button', class: 'cap', onclick: () => { if (!macOn()) setMac(true); H.setComposerText(`Summarize ${f.display || f.path}`); closePane(); H.focusComposer(); } }, ico('spark', 12), 'Summarize'),
      pager),
    el('pre', { class: 'mac-text', tabindex: '0', 'aria-label': `Text of ${f.name}` }, f.text || ''),
    el('p', 'sp-note', `Read on your Mac through Jarvis (secrets blanked out). It goes to a model only if you use it in chat: ${macReader().name} would read it.`));
  focusIn(body);
}

/* ---------- Ask about my screen (H4) ---------- */

export function screenText(s) {
  return [
    s.url ? `Address: ${s.url}` : '',
    s.selected ? `Selected text:\n${s.selected}` : '',
    s.text ? `Window text${s.truncated ? ' (cut short)' : ''}:\n${s.text}` : '',
  ].filter(Boolean).join('\n\n') || '(Nothing readable in the window.)';
}

let looking = false;
export async function askScreen() {
  if (!state.jarvis.available) { toast(state.jarvis.reason || 'Your Mac isn’t connected'); return; }
  if (looking) { toast('Waiting for you on your Mac…'); return; }
  looking = true;
  toast('Approve it on your Mac: Jarvis asks before Eden sees your screen');
  try {
    const s = await jarvisJson('screen_context', { picture: true });
    const where = s.app || 'your Mac';
    const title = `Screen: ${where}${s.title && s.title !== s.app ? ` — ${s.title}` : ''}`.slice(0, 120);
    H.addContext({ title, text: screenText(s), kind: 'screen' });
    if (s.image && typeof s.image.data === 'string' && s.image.data) {
      const bytes = Uint8Array.from(atob(s.image.data), (ch) => ch.charCodeAt(0));
      H.addFile(new File([bytes], `${where.replace(/[^\w -]/g, '').trim() || 'screen'}.jpg`, { type: /^image\/(png|jpeg|webp)$/.test(s.image.mime) ? s.image.mime : 'image/jpeg' }));
    }
    if (s.notes && s.notes.length) setTimeout(() => toast(s.notes[0]), 2700); // after "goes with your next message"
    H.focusComposer();
  } catch (e) {
    toast(`Eden couldn’t see your screen: ${e.message}`);
  } finally {
    looking = false;
  }
}

export function initFiles(handlers) {
  H = handlers;
}
