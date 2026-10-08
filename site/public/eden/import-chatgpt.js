// Import from ChatGPT (Settings › Memory, ⌘K): drop the export .zip (or its conversations.json) and
// Eden reads it in this browser, converts each chat into an Eden conversation (branches kept as
// versions, images as attachments) and saves it like any other chat. Nothing is uploaded. Then,
// optionally: memories Eden suggests from the chats, ChatGPT memories you paste, a persona from
// your custom instructions: each one reviewed and approved by you; nothing is saved on its own.
// The reading and converting is import-chatgpt-model.js.

import { el } from './util.js';
import { state, ui, attachmentData, addConversation, saveConversation, savePersonas } from './state.js';
import { api } from './api.js';
import {
  readZip, entryStream, entryBytes, jsonArrayItems, indexExport, convertConversation, dedupeAction, replaceInto, mimeOf,
  parseMemoryLines, parseSuggestions, sampleForMemories, MEMORY_SYSTEM, SOURCE,
} from './import-chatgpt-model.js';

let host = { openDialog: () => {}, closeDialog: () => {}, toast: () => {} };
const MAX_IMAGE_IN = 20 * 1024 * 1024; // bigger originals are skipped
const MAX_SIDE = 1280; // kept images are shrunk to this and stored as JPEG

export function initImportChatGPT(h) {
  host = { ...host, ...h };
  if (!document.querySelector('link[data-imp]')) {
    const l = el('link', { rel: 'stylesheet', href: new URL('./import-chatgpt.css', import.meta.url).href });
    l.dataset.imp = '1';
    document.head.append(l);
  }
  addEventListener('eden:conv-opened', (e) => hydrate(e.detail && e.detail.conv));
  setTimeout(() => hydrate(state.current), 1500); // a reload with an imported chat open
}

/* ---------- imported images: shrunk, kept in IndexedDB, loaded back when a chat opens ---------- */

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('eden-import', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('images');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}
async function idbPut(key, blob) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction('images', 'readwrite'); t.objectStore('images').put(blob, key); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
}
async function idbGet(key) {
  const d = await db();
  return new Promise((res) => { const r = d.transaction('images').objectStore('images').get(key); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); });
}
async function shrink(bytes, mime) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close && bmp.close();
  return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', 0.82));
}
const imgKey = (convId, nodeId, name) => `${convId}/${nodeId}/${name}`;

async function hydrate(c) {
  if (!c || c.source !== SOURCE) return;
  let any = false;
  for (const n of Object.values(c.nodes)) {
    if (n.role !== 'user' || !n.attachments || !n.attachments.length || attachmentData.has(n.id)) continue;
    const list = [];
    for (const a of n.attachments) {
      if (a.kind !== 'image') continue;
      const blob = await idbGet(imgKey(c.id, n.id, a.name)).catch(() => null);
      if (blob) list.push({ kind: 'image', name: a.name, mime: a.mime, size: a.size, url: URL.createObjectURL(blob) });
    }
    if (list.length) { attachmentData.set(n.id, list); any = true; }
  }
  if (any && state.current === c) ui.render();
}

/* ---------- the import ---------- */

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Reads `file` (the export .zip or a conversations.json) and imports its chats.
 * `on(progress)` gets { phase, done, total, chats }; `shouldStop()` cancels between chats.
 */
export async function runImport(file, { on = () => {}, shouldStop = () => false } = {}) {
  const sum = { chats: 0, updated: 0, unchanged: 0, edited: 0, skipped: 0, messages: 0, images: 0, imagesMissing: 0, full: false, cancelled: false, instructions: null, userJson: null };
  let entries = null, idx = null, streams;
  const isZip = !/\.json$/i.test(file.name);
  if (isZip) {
    entries = await readZip(file);
    idx = indexExport(entries);
    if (!idx.conversations.length) throw new Error('No conversations.json in this file. Use the zip from ChatGPT › Settings › Data controls › Export data.');
    streams = idx.conversations.map((e) => ({ size: e.size, open: () => entryStream(file, e) }));
    if (idx.user) {
      try { sum.userJson = JSON.parse(new TextDecoder().decode(await entryBytes(file, idx.user, 5e6))); } catch { /* optional */ }
    }
  } else {
    streams = [{ size: file.size, open: async () => file.stream() }];
  }
  const total = streams.reduce((a, s) => a + s.size, 0) || 1;
  let read = 0;
  const existing = new Map(state.convs.filter((c) => c.import && c.import.source === SOURCE).map((c) => [c.import.id, c]));
  let last = performance.now();

  outer: for (const s of streams) {
    const stream = await s.open();
    for await (const raw of jsonArrayItems(stream, { onBytes: (n) => { read += n; } })) {
      if (shouldStop()) { sum.cancelled = true; break outer; }
      let r = null;
      try { r = convertConversation(raw); } catch { r = null; }
      if (!r) sum.skipped++;
      else {
        if (!sum.instructions && r.instructions) sum.instructions = r.instructions;
        const prior = existing.get(r.conv.import.id);
        const act = dedupeAction(prior, r.conv);
        if (act === 'unchanged') sum.unchanged++;
        else if (act === 'edited') sum.edited++;
        else {
          const imgs = await attachImages(r, file, idx, sum);
          let c;
          if (act === 'update') { c = replaceInto(prior, r.conv); sum.updated++; } else { c = r.conv; existing.set(c.import.id, c); }
          sum.messages += r.stats.messages;
          if (act === 'new') { addConversation(c); sum.chats++; }
          else saveConversation(c, { now: true });
          let stored = null;
          try { stored = localStorage.getItem(`jchat:conv:${c.id}`); } catch { /* blocked */ }
          if (!stored) { // the browser's storage is full: keep what fit, newest first
            state.convs = state.convs.filter((x) => x !== c);
            sum.full = true; sum.chats -= act === 'new' ? 1 : 0; sum.messages -= r.stats.messages;
            break outer;
          }
          void imgs;
        }
      }
      if (performance.now() - last > 40) { // yield so the page stays alive
        last = performance.now();
        on({ phase: 'chats', done: Math.min(read, total), total, chats: sum.chats + sum.updated + sum.unchanged + sum.edited + sum.skipped });
        await tick();
      }
    }
  }
  on({ phase: 'done', done: total, total, chats: sum.chats });
  ui.renderSidebar();
  return sum;
}

async function attachImages(r, file, idx, sum) {
  if (!r.images.length) return 0;
  const c = r.conv;
  let n = 0;
  const perNode = new Map();
  for (const im of r.images) {
    const entry = idx && im.id ? idx.images.get(im.id) : null;
    if (!entry || entry.size > MAX_IMAGE_IN) { sum.imagesMissing++; continue; }
    try {
      const bytes = await entryBytes(file, entry, MAX_IMAGE_IN);
      if (!bytes) { sum.imagesMissing++; continue; }
      const blob = await shrink(bytes, mimeOf(entry.name));
      const k = (perNode.get(im.nodeId) || 0) + 1;
      perNode.set(im.nodeId, k);
      const name = `image-${k}.jpg`;
      await idbPut(imgKey(c.id, im.nodeId, name), blob);
      const node = c.nodes[im.nodeId];
      node.attachments.push({ kind: 'image', name, mime: 'image/jpeg', size: blob.size });
      const live = attachmentData.get(im.nodeId) || [];
      live.push({ kind: 'image', name, mime: 'image/jpeg', size: blob.size, url: URL.createObjectURL(blob) });
      attachmentData.set(im.nodeId, live);
      sum.images++; n++;
    } catch { sum.imagesMissing++; }
  }
  return n;
}

/* ---------- the dialog ---------- */

export function openImportChatGPT() {
  const body = el('div', 'imp');
  host.openDialog('Import from ChatGPT', body);
  paintStart(body);
}

/** A settings card: a line on what it does and a button that opens the dialog. */
export function importCard() {
  return el('div', 'set-sec', el('h3', '', 'Import from ChatGPT'),
    el('div', 'icard', el('div', 'prov', el('div', 'grow', el('div', 'p-n', 'Bring your ChatGPT chats into Eden'),
      el('div', 'p-c', 'Export your data from ChatGPT, drop the .zip here, and your chats appear in Eden. It’s read in this browser and never uploaded.')),
    el('button', { type: 'button', class: 'btn', onclick: openImportChatGPT }, 'Import…'))));
}

function paintStart(body) {
  const input = el('input', { type: 'file', accept: '.zip,.json,application/zip,application/json', hidden: true });
  const zone = el('div', { class: 'imp-zone', tabindex: 0, role: 'button', 'aria-label': 'Choose the ChatGPT export .zip' },
    el('b', '', 'Drop your ChatGPT export here'), el('span', '', 'or click to choose the .zip'));
  const pick = (f) => { if (f) start(body, f); };
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => pick(input.files[0]));
  for (const t of ['dragenter', 'dragover']) zone.addEventListener(t, (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.remove('over'); pick(e.dataTransfer.files[0]); });
  body.replaceChildren(
    el('ol', 'imp-how',
      el('li', '', 'In ChatGPT, open ', el('b', '', 'Settings › Data controls › Export data'), '.'),
      el('li', '', 'ChatGPT emails you a link. Download the .zip.'),
      el('li', '', 'Drop it below. (A bare conversations.json works too.)')),
    zone, input,
    el('p', 'sp-note', 'Everything is read in this browser; the file is never uploaded. Chats are stored like your other chats. Re-importing the same export updates chats instead of duplicating them. Large exports can fill the browser’s storage: the newest chats are kept first.'),
    memoryPasteBox());
}

function start(body, file) {
  let stop = false;
  const bar = el('div', 'imp-bar', el('i'));
  const label = el('div', 'imp-label', 'Opening the file…');
  body.replaceChildren(el('b', '', file.name), bar, label,
    el('div', 'dlg-acts', el('span', 'grow'), el('button', { type: 'button', class: 'btn', onclick: () => { stop = true; label.textContent = 'Stopping…'; } }, 'Cancel')));
  runImport(file, {
    shouldStop: () => stop,
    on: (p) => {
      bar.firstChild.style.width = `${Math.round((p.done / p.total) * 100)}%`;
      label.textContent = `${p.chats.toLocaleString()} chats read · ${Math.round((p.done / p.total) * 100)}%`;
    },
  }).then((sum) => paintSummary(body, sum), (e) => {
    body.replaceChildren(el('div', 'sp-warn', el('b', '', 'Couldn’t import that'), e.message || String(e)),
      el('div', 'dlg-acts', el('span', 'grow'), el('button', { type: 'button', class: 'btn', onclick: () => paintStart(body) }, 'Try another file')));
  });
}

function paintSummary(body, s) {
  const lines = [
    `${s.chats.toLocaleString()} new chat${s.chats === 1 ? '' : 's'}, ${s.messages.toLocaleString()} messages, ${s.images.toLocaleString()} image${s.images === 1 ? '' : 's'}`,
    s.updated ? `${s.updated.toLocaleString()} updated from a newer export` : '',
    s.unchanged ? `${s.unchanged.toLocaleString()} already imported, unchanged` : '',
    s.edited ? `${s.edited.toLocaleString()} left alone because you’ve continued them in Eden` : '',
    s.skipped ? `${s.skipped.toLocaleString()} empty or unreadable, skipped` : '',
    s.imagesMissing ? `${s.imagesMissing.toLocaleString()} image${s.imagesMissing === 1 ? '' : 's'} not in the export or too large, skipped` : '',
  ].filter(Boolean);
  const ci = customInstructionsOf(s);
  const out = [el('h3', 'imp-h', s.cancelled ? 'Stopped' : s.full ? 'Imported until storage filled up' : 'Done'),
    el('ul', 'imp-sum', ...lines.map((l) => el('li', '', l)))];
  if (s.full) out.push(el('div', 'sp-warn', el('b', '', 'This browser’s storage is full'), 'The newest chats were kept. Delete some chats and import again to add the rest.'));
  const review = el('div', 'imp-review');
  out.push(el('div', 'imp-next',
    el('button', { type: 'button', class: 'btn primary', onclick: () => suggestMemories(review) }, 'Suggest memories from your chats'),
    ci ? el('button', { type: 'button', class: 'btn', onclick: () => personaReview(review, ci) }, 'Create a persona from your ChatGPT custom instructions') : null), review);
  out.push(memoryPasteBox(), el('div', 'dlg-acts', el('span', 'grow'), el('button', { type: 'button', class: 'btn', onclick: host.closeDialog }, 'Close')));
  body.replaceChildren(...out);
}

/** Custom instructions from user.json when it has them, else the ones found inside the chats. */
export function customInstructionsOf(s) {
  const u = s.userJson || {};
  const about = u.about_user_message || u.about_you || (u.custom_instructions && u.custom_instructions.about_user_message) || '';
  const how = u.about_model_message || u.instructions || (u.custom_instructions && (u.custom_instructions.about_model_message || u.custom_instructions.instructions)) || '';
  if (String(about).trim() || String(how).trim()) return { about: String(about).trim(), how: String(how).trim() };
  return s.instructions || null;
}

/* ---------- reviewed additions: memories, persona ---------- */

function checklist(box, { title, items, saveLabel, onSave, empty }) {
  if (!items.length) { box.replaceChildren(el('p', 'muted', empty)); return; }
  const rows = items.map((t) => {
    const cb = el('input', { type: 'checkbox' });
    return { t, cb, row: el('label', 'imp-item', cb, el('span', '', t)) };
  });
  const save = el('button', { type: 'button', class: 'btn primary', disabled: true }, saveLabel);
  const refresh = () => { const n = rows.filter((r) => r.cb.checked).length; save.disabled = !n; save.textContent = n ? `${saveLabel} (${n})` : saveLabel; };
  rows.forEach((r) => r.cb.addEventListener('change', refresh));
  const all = el('button', { type: 'button', class: 'btn', onclick: () => { const on = rows.some((r) => !r.cb.checked); rows.forEach((r) => { r.cb.checked = on; }); refresh(); } }, 'Select all');
  save.addEventListener('click', async () => {
    save.disabled = true;
    const picked = rows.filter((r) => r.cb.checked).map((r) => r.t);
    let ok = 0;
    for (const t of picked) { try { await onSave(t); ok++; } catch (e) { host.toast(`Couldn’t save to memory: ${e.message}`); break; } }
    if (ok) host.toast(`${ok} saved to memory`);
    box.replaceChildren(el('p', 'muted', ok ? `${ok} saved. You can edit or delete them in Settings › Memory.` : 'Nothing saved.'));
  });
  box.replaceChildren(el('h3', 'imp-h', title), el('div', 'imp-list', ...rows.map((r) => r.row)), el('div', 'dlg-acts', all, el('span', 'grow'), save));
}

const memoryReady = () => {
  if (!(state.meta && state.meta.hosted)) return 'Saved memories are an askeden.com feature.';
  return '';
};

async function suggestMemories(box) {
  const why = memoryReady();
  if (why) { box.replaceChildren(el('p', 'muted', why)); return; }
  const sample = sampleForMemories(state.convs.filter((c) => c.source === SOURCE));
  if (!sample) { box.replaceChildren(el('p', 'muted', 'No imported chats to read.')); return; }
  box.replaceChildren(el('p', 'muted', 'Reading a sample of your recent chats…'));
  let out = '';
  try {
    const { routeSettings } = await import('./router.js');
    await api.send({ messages: [{ role: 'user', content: `Here are samples of my recent chats (my messages only):\n\n${sample}` }], system: MEMORY_SYSTEM, temporary: true, mode: 'chat', settings: { ...routeSettings(), level: 1, efficiency: 90, performance: 20 } }, {
      onEvent: (t, d) => { if (t === 'text') out += d.text || ''; if (t === 'error') throw new Error(d.message || 'Eden couldn’t answer.'); },
    });
  } catch (e) { box.replaceChildren(el('p', 'muted', `Couldn’t suggest memories: ${e.message}`)); return; }
  checklist(box, { title: 'Pick what Eden should remember', items: parseSuggestions(out), saveLabel: 'Save to memory', onSave: (text) => api.memoryDo({ action: 'add', text }), empty: 'Nothing solid enough to suggest.' });
}

function personaReview(box, ci) {
  const name = el('input', { type: 'text', maxlength: 60, value: 'My ChatGPT instructions' });
  const sys = el('textarea', { rows: 8 });
  sys.value = [ci.about && `About me:\n${ci.about}`, ci.how && `How to answer:\n${ci.how}`].filter(Boolean).join('\n\n');
  box.replaceChildren(el('h3', 'imp-h', 'Persona from your custom instructions'), el('label', 'field', 'Name', name), el('label', 'field', 'Instructions (edit as you like)', sys),
    el('div', 'dlg-acts', el('span', 'grow'), el('button', { type: 'button', class: 'btn primary', onclick: () => {
      const n = name.value.trim();
      if (!n || !sys.value.trim()) return;
      state.personas.push({ id: `p${Date.now().toString(36)}`, name: n, system: sys.value.trim() });
      savePersonas();
      ui.renderSidebar();
      host.toast(`Persona “${n}” added`);
      box.replaceChildren(el('p', 'muted', 'Persona added. Pick it from the composer or the sidebar.'));
    } }, 'Create persona')));
}

/** ChatGPT's export leaves out Saved Memories: paste them (Settings › Personalization › Manage memories), review, add. */
function memoryPasteBox() {
  const ta = el('textarea', { rows: 4, placeholder: 'One memory per line, e.g. “Lives in Lisbon.”', 'aria-label': 'Your ChatGPT memories' });
  const review = el('div', 'imp-review');
  return el('details', 'imp-paste', el('summary', '', 'Paste your ChatGPT memories'),
    el('p', 'sp-note', 'The export doesn’t include ChatGPT’s Saved Memories. In ChatGPT, open Settings › Personalization › Manage memories, copy them, and paste here. You choose which ones Eden keeps.'),
    ta, el('div', 'dlg-acts', el('span', 'grow'), el('button', { type: 'button', class: 'btn', onclick: () => {
      const why = memoryReady();
      if (why) { review.replaceChildren(el('p', 'muted', why)); return; }
      checklist(review, { title: 'Pick what Eden should remember', items: parseMemoryLines(ta.value), saveLabel: 'Add to memory', onSave: (text) => api.memoryDo({ action: 'add', text }), empty: 'No memories found in what you pasted.' });
    } }, 'Review')), review);
}
