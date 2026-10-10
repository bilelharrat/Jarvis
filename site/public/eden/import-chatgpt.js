// Import chats (Settings › Memory, ⌘K; ROADMAP Q1): drop an export from ChatGPT, Claude or Gemini
// and Eden reads it in this browser, converts each chat into an Eden conversation (ChatGPT's
// branches kept as versions and its images as attachments; Claude's branches, artifacts and
// pasted files; Gemini's prompts grouped into chats) and saves it like any other chat, so search,
// meaning search (chat-vectors.js), memory suggestions and end-to-end encrypted sync (sync.js,
// H1: every saved chat is sealed in this browser before it leaves) all see it. Nothing is
// uploaded. Then, optionally: memories Eden suggests from the chats, memories you paste or that
// Claude's export carries, a persona from custom instructions or a Claude project: each one
// reviewed and approved by you; nothing is saved on its own.
// The reading and converting is import-chatgpt-model.js, import-claude-model.js and
// import-gemini-model.js; which export a file is, import-sources-model.js.

import { el } from './util.js';
import { locale } from './i18n.js';
import { state, ui, attachmentData, addConversation, saveConversation, savePersonas, flushed } from './state.js';
import { api } from './api.js';
import {
  readZip, entryStream, entryBytes, jsonArrayItems, indexExport, convertConversation, dedupeAction, replaceInto, mimeOf,
  parseMemoryLines, parseSuggestions, sampleForMemories, MEMORY_SYSTEM, SOURCE,
} from './import-chatgpt-model.js';
import { indexClaudeExport, convertClaudeConversation, readClaudeProjects, claudeMemoryLines } from './import-claude-model.js';
import { geminiActivityEntries, convertGeminiActivity, parseActivityHtml } from './import-gemini-model.js';
import { SOURCES, sourceOfZip, sourceOfItem, importSource } from './import-sources-model.js';

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

/** The first item of a JSON array stream (to tell ChatGPT's, Claude's and Gemini's apart), or null. */
async function firstItem(stream) {
  for await (const x of jsonArrayItems(stream)) return x;
  return null;
}

const readJson = async (file, entry, max = 20e6) => { try { const b = await entryBytes(file, entry, max); return b ? JSON.parse(new TextDecoder().decode(b)) : null; } catch { return null; } };

/**
 * Which export `file` is and how to read it: { source, entries, streams?, activity?, ... }.
 * `want` is the tab the person dropped it on; the file's own shape wins when it's clear.
 */
async function openExport(file, want = '') {
  const isZip = !/\.(json|html?)$/i.test(file.name);
  if (isZip) {
    const entries = await readZip(file);
    let source = sourceOfZip(entries);
    if (!source) throw new Error(`This zip isn’t an export Eden can read. Use ${SOURCES[want || 'chatgpt'].file}.`);
    if (source === 'chatgpt') { // conversations.json alone could be Claude's: look at the first chat
      const idx = indexExport(entries);
      const first = await firstItem(await entryStream(file, idx.conversations[0])).catch(() => null);
      if (sourceOfItem(first) === 'claude') source = 'claude';
    }
    return { source, isZip, entries };
  }
  if (/\.html?$/i.test(file.name)) return { source: 'gemini', isZip, html: true };
  const first = await firstItem(file.stream()).catch(() => null);
  const source = sourceOfItem(first);
  if (!source) throw new Error(want ? `This file isn’t an export Eden can read. Use ${SOURCES[want].file}.` : 'This file isn’t an export Eden can read.');
  return { source, isZip };
}

/**
 * Reads `file` (an export .zip, a conversations.json, or Gemini's MyActivity.json / .html) and imports its chats.
 * `on(progress)` gets { phase, done, total, chats }; `shouldStop()` cancels between chats. `source` is the
 * tab it was dropped on (a hint; the file decides).
 */
export async function runImport(file, { on = () => {}, shouldStop = () => false, source: want = '' } = {}) {
  const sum = { source: want || 'chatgpt', chats: 0, updated: 0, unchanged: 0, edited: 0, skipped: 0, messages: 0, images: 0, imagesMissing: 0, full: false, cancelled: false, instructions: null, userJson: null, memories: [], projects: [], prompts: 0 };
  const ex = await openExport(file, want);
  sum.source = ex.source;
  let idx = null;
  let total = 1, read = 0;
  const onBytes = (n) => { read += n; };
  let items; // an async iterable of converted chats ({ conv, images, stats, instructions? }) or null for an unreadable one

  if (ex.source === 'gemini') {
    let entries = [];
    if (ex.isZip) {
      for (const e of geminiActivityEntries(ex.entries)) {
        if (/\.json$/i.test(e.name)) { for await (const x of jsonArrayItems(await entryStream(file, e))) entries.push(x); }
        else entries.push(...parseActivityHtml(new TextDecoder().decode(await entryBytes(file, e, 200e6))));
      }
    } else if (ex.html) entries = parseActivityHtml(await file.text());
    else for await (const x of jsonArrayItems(file.stream())) entries.push(x);
    const { results, prompts } = convertGeminiActivity(entries);
    sum.prompts = prompts;
    if (!results.length) throw new Error('No Gemini prompts in this file. In Takeout, pick My Activity › Gemini Apps.');
    total = results.length;
    items = (async function* () { for (const r of results) { read++; yield r; } })();
  } else if (ex.source === 'claude') {
    const cidx = ex.isZip ? indexClaudeExport(ex.entries) : null;
    if (cidx && !cidx.conversations.length) throw new Error('No conversations.json in this file. Use the zip from Claude › Settings › Privacy › Export data.');
    let projects = new Map();
    if (cidx && cidx.projects) projects = readClaudeProjects(await readJson(file, cidx.projects));
    if (cidx && cidx.memories) sum.memories = claudeMemoryLines(await readJson(file, cidx.memories));
    sum.projects = [...projects.values()].filter((p) => p.instructions && !p.starter);
    const streams = cidx ? cidx.conversations.map((e) => ({ size: e.size, open: () => entryStream(file, e) })) : [{ size: file.size, open: async () => file.stream() }];
    total = streams.reduce((a, s) => a + s.size, 0) || 1;
    items = (async function* () {
      for (const s of streams) for await (const raw of jsonArrayItems(await s.open(), { onBytes })) { let r = null; try { r = convertClaudeConversation(raw, { projects }); } catch { r = null; } yield r; }
    })();
  } else {
    let streams;
    if (ex.isZip) {
      idx = indexExport(ex.entries);
      if (!idx.conversations.length) throw new Error('No conversations.json in this file. Use the zip from ChatGPT › Settings › Data controls › Export data.');
      streams = idx.conversations.map((e) => ({ size: e.size, open: () => entryStream(file, e) }));
      if (idx.user) sum.userJson = await readJson(file, idx.user, 5e6);
    } else {
      streams = [{ size: file.size, open: async () => file.stream() }];
    }
    total = streams.reduce((a, s) => a + s.size, 0) || 1;
    items = (async function* () {
      for (const s of streams) for await (const raw of jsonArrayItems(await s.open(), { onBytes })) { let r = null; try { r = convertConversation(raw); } catch { r = null; } yield r; }
    })();
  }

  const key = (imp) => `${imp.source}:${imp.id}`;
  const existing = new Map(state.convs.filter((c) => c.import && c.import.source === ex.source).map((c) => [key(c.import), c]));
  let last = performance.now();
  for await (const r of items) {
    if (shouldStop()) { sum.cancelled = true; break; }
    if (!r) sum.skipped++;
    else {
      if (!sum.instructions && r.instructions) sum.instructions = r.instructions;
      const prior = existing.get(key(r.conv.import));
      const act = dedupeAction(prior, r.conv);
      if (act === 'unchanged') sum.unchanged++;
      else if (act === 'edited') sum.edited++;
      else {
        await attachImages(r, file, idx, sum);
        let c;
        if (act === 'update') { c = replaceInto(prior, r.conv); sum.updated++; } else { c = r.conv; existing.set(key(c.import), c); }
        sum.messages += r.stats.messages;
        if (act === 'new') { addConversation(c); sum.chats++; } // saved, then sealed and synced like any chat (H1)
        else saveConversation(c, { now: true });
        if (!(await flushed())) { // the browser's storage is full: keep what fit, newest first
          state.convs = state.convs.filter((x) => x !== c);
          sum.full = true; sum.chats -= act === 'new' ? 1 : 0; sum.messages -= r.stats.messages;
          break;
        }
      }
    }
    if (performance.now() - last > 40) { // yield so the page stays alive
      last = performance.now();
      on({ phase: 'chats', done: Math.min(read, total), total, chats: sum.chats + sum.updated + sum.unchanged + sum.edited + sum.skipped });
      await tick();
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

let lastSource = 'chatgpt';
/** Opens "Import chats" on a source's tab ('chatgpt', 'claude' or 'gemini'). */
export function openImportChats(source = lastSource) {
  const body = el('div', 'imp');
  host.openDialog('Import chats', body);
  paintStart(body, SOURCES[source] ? source : 'chatgpt');
}
export const openImportChatGPT = () => openImportChats('chatgpt'); // older callers

/** A settings card: a line on what it does and a button that opens the dialog. */
export function importCard() {
  return el('div', 'set-sec', el('h3', '', 'Import chats'),
    el('div', 'icard', el('div', 'prov', el('div', 'grow', el('div', 'p-n', 'Bring your chats from ChatGPT, Claude or Gemini'),
      el('div', 'p-c', 'Export your data there, drop the file here, and your chats appear in Eden: searchable, and synced end-to-end encrypted like the rest. It’s read in this browser and never uploaded.')),
    el('button', { type: 'button', class: 'btn', onclick: () => openImportChats() }, 'Import…'))));
}

const stepLine = (parts) => el('li', '', ...parts.map((t, i) => (i % 2 ? el('b', '', t) : t)));

function paintStart(body, source) {
  lastSource = source;
  const src = SOURCES[source];
  const tabs = el('div', { class: 'imp-tabs', role: 'tablist', 'aria-label': 'Import from' }, ...Object.entries(SOURCES).map(([k, s]) =>
    el('button', { type: 'button', role: 'tab', 'aria-selected': String(k === source), class: `imp-tab${k === source ? ' on' : ''}`, onclick: () => { paintStart(body, k); body.querySelector('.imp-tab.on')?.focus(); } }, s.label)));
  const input = el('input', { type: 'file', accept: source === 'gemini' ? '.zip,.json,.html,application/zip,application/json,text/html' : '.zip,.json,application/zip,application/json', hidden: true });
  const zone = el('div', { class: 'imp-zone', tabindex: 0, role: 'button', 'aria-label': `Choose ${src.file}` },
    el('b', '', `Drop your ${src.label} export here`), el('span', '', `or click to choose ${src.file}`));
  const pick = (f) => { if (f) start(body, f, source); };
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => pick(input.files[0]));
  for (const t of ['dragenter', 'dragover']) zone.addEventListener(t, (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.remove('over'); pick(e.dataTransfer.files[0]); });
  body.replaceChildren(
    tabs,
    el('ol', 'imp-how', ...src.steps.map(stepLine)),
    zone, input,
    el('p', 'sp-note', 'Everything is read in this browser; the file is never uploaded. Chats are stored like your other chats, and if Sync is on they’re end-to-end encrypted before they leave. Re-importing the same export updates chats instead of duplicating them. Large exports can fill the browser’s storage: the newest chats are kept first.'),
    ...(source === 'gemini' ? [] : [memoryPasteBox(source === 'claude' ? 'Claude' : 'ChatGPT')]));
}

function start(body, file, source) {
  let stop = false;
  const bar = el('div', 'imp-bar', el('i'));
  const label = el('div', 'imp-label', 'Opening the file…');
  body.replaceChildren(el('b', { 'data-no-i18n': '' }, file.name), bar, label,
    el('div', 'dlg-acts', el('span', 'grow'), el('button', { type: 'button', class: 'btn', onclick: () => { stop = true; label.textContent = 'Stopping…'; } }, 'Cancel')));
  runImport(file, {
    source,
    shouldStop: () => stop,
    on: (p) => {
      bar.firstChild.style.width = `${Math.round((p.done / p.total) * 100)}%`;
      label.textContent = `${p.chats.toLocaleString(locale())} chats read · ${Math.round((p.done / p.total) * 100)}%`;
    },
  }).then((sum) => paintSummary(body, sum), (e) => {
    body.replaceChildren(el('div', 'sp-warn', el('b', '', 'Couldn’t import that'), e.message || String(e)),
      el('div', 'dlg-acts', el('span', 'grow'), el('button', { type: 'button', class: 'btn', onclick: () => paintStart(body, source) }, 'Try another file')));
  });
}

function paintSummary(body, s) {
  const from = SOURCES[s.source] ? SOURCES[s.source].label : 'ChatGPT';
  const lines = [
    `${s.chats.toLocaleString(locale())} new chat${s.chats === 1 ? '' : 's'} from ${from}, ${s.messages.toLocaleString(locale())} messages${s.source === 'chatgpt' ? `, ${s.images.toLocaleString(locale())} image${s.images === 1 ? '' : 's'}` : ''}`,
    s.source === 'gemini' && s.prompts ? `${s.prompts.toLocaleString(locale())} Gemini prompts, grouped into chats by time (Google’s export doesn’t say which prompts were one chat)` : '',
    s.updated ? `${s.updated.toLocaleString(locale())} updated from a newer export` : '',
    s.unchanged ? `${s.unchanged.toLocaleString(locale())} already imported, unchanged` : '',
    s.edited ? `${s.edited.toLocaleString(locale())} left alone because you’ve continued them in Eden` : '',
    s.skipped ? `${s.skipped.toLocaleString(locale())} empty or unreadable, skipped` : '',
    s.imagesMissing ? `${s.imagesMissing.toLocaleString(locale())} image${s.imagesMissing === 1 ? '' : 's'} not in the export or too large, skipped` : '',
  ].filter(Boolean);
  const ci = s.source === 'chatgpt' ? customInstructionsOf(s) : null;
  const out = [el('h3', 'imp-h', s.cancelled ? 'Stopped' : s.full ? 'Imported until storage filled up' : 'Done'),
    el('ul', 'imp-sum', ...lines.map((l) => el('li', '', l)))];
  if (s.full) out.push(el('div', 'sp-warn', el('b', '', 'This browser’s storage is full'), 'The newest chats were kept. Delete some chats and import again to add the rest.'));
  const review = el('div', 'imp-review');
  const reviewMemories = () => {
    const why = memoryReady();
    if (why) { review.replaceChildren(el('p', 'muted', why)); return; }
    checklist(review, { title: 'Pick what Eden should remember (from Claude’s memory)', items: s.memories, saveLabel: 'Add to memory', onSave: (text) => api.memoryDo({ action: 'add', text }), empty: 'Nothing in Claude’s memory to add.' });
  };
  out.push(el('div', 'imp-next',
    el('button', { type: 'button', class: 'btn primary', onclick: () => suggestMemories(review) }, 'Suggest memories from your chats'),
    s.memories && s.memories.length ? el('button', { type: 'button', class: 'btn', onclick: reviewMemories }, `Review Claude’s memories (${s.memories.length})`) : null,
    ci ? el('button', { type: 'button', class: 'btn', onclick: () => personaReview(review, { name: 'My ChatGPT instructions', text: [ci.about && `About me:\n${ci.about}`, ci.how && `How to answer:\n${ci.how}`].filter(Boolean).join('\n\n'), what: 'your custom instructions' }) }, 'Create a persona from your ChatGPT custom instructions') : null,
    ...(s.projects || []).slice(0, 6).map((p) => el('button', { type: 'button', class: 'btn', onclick: () => personaReview(review, { name: p.name || 'Claude project', text: p.instructions, what: `the Claude project “${p.name}”` }) }, `Persona from the “${p.name}” project`))), review);
  out.push(s.source === 'gemini' ? null : memoryPasteBox(from), el('div', 'dlg-acts', el('span', 'grow'), el('button', { type: 'button', class: 'btn', onclick: host.closeDialog }, 'Close')));
  body.replaceChildren(...out.filter(Boolean));
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
    return { t, cb, row: el('label', 'imp-item', cb, el('span', { 'data-no-i18n': '' }, t)) };
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
  const sample = sampleForMemories(state.convs.filter((c) => importSource(c)));
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

/** A persona from imported instructions ({ name, text, what }), edited and approved by the owner. */
function personaReview(box, { name: suggested, text, what }) {
  const name = el('input', { type: 'text', maxlength: 60, value: String(suggested || 'Imported instructions').slice(0, 60) });
  const sys = el('textarea', { rows: 8 });
  sys.value = text || '';
  box.replaceChildren(el('h3', 'imp-h', `Persona from ${what}`), el('label', 'field', 'Name', name), el('label', 'field', 'Instructions (edit as you like)', sys),
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

const PASTE_HOW = {
  ChatGPT: 'The export doesn’t include ChatGPT’s Saved Memories. In ChatGPT, open Settings › Personalization › Manage memories, copy them, and paste here. You choose which ones Eden keeps.',
  Claude: 'Older Claude exports don’t include Claude’s memory. In Claude, open Settings › Capabilities › Memory (“View and edit”), copy it, and paste here. You choose which lines Eden keeps.',
};
/** Memories the export leaves out, pasted by the owner, reviewed, added. */
function memoryPasteBox(from = 'ChatGPT') {
  const ta = el('textarea', { rows: 4, placeholder: 'One memory per line, e.g. “Lives in Lisbon.”', 'aria-label': `Your ${from} memories` });
  const review = el('div', 'imp-review');
  return el('details', 'imp-paste', el('summary', '', `Paste your ${from} memories`),
    el('p', 'sp-note', PASTE_HOW[from] || PASTE_HOW.ChatGPT),
    ta, el('div', 'dlg-acts', el('span', 'grow'), el('button', { type: 'button', class: 'btn', onclick: () => {
      const why = memoryReady();
      if (why) { review.replaceChildren(el('p', 'muted', why)); return; }
      checklist(review, { title: 'Pick what Eden should remember', items: parseMemoryLines(ta.value), saveLabel: 'Add to memory', onSave: (text) => api.memoryDo({ action: 'add', text }), empty: 'No memories found in what you pasted.' });
    } }, 'Review')), review);
}
