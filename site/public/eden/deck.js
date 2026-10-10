// Slide decks in Eden (ROADMAP Q14): the page side. A chat in Slides mode asks the routed model for a
// deck as JSON (deck-model.js deckSystem, sent through api.js addSendExtra with `deck: true`, which
// gives the reply room for a whole deck on the server); the reply's deck becomes a version on the
// conversation (c.deckVersions, synced; pictures in c.deckImages stay on this device) and opens in
// the canvas, drawn by deck-render.js inside the artifact sandbox. The canvas's version arrows are
// undo/redo; every edit (typed on a slide, dragged, a theme, a picture, a slide Eden changed) is a
// version. Present fills the screen; presenter view shows notes and a timer. Exports: PowerPoint
// (deck-pptx.js), PDF (the browser’s print of a script-free copy), Google Slides (the PowerPoint
// converted in the person's Drive with sheet-google.js driveUpload, drive.file only), Markdown outline; Publish (G10) shares a live, view-only copy.

import { $, el, ico, toast, isMobile } from './util.js';
import { t as tx } from './i18n.js';
import { state, nodeText, saveConversation, path } from './state.js';
import { api, apiUrl, addSendExtra } from './api.js';
import { openDeckCanvas, deckCanvasVersion, pushDeckVersion, artifactSend, closeArtifact } from './artifact.js';
import { setComposerText } from './composer.js';
import { openPublish } from './publish.js';
import { labelView } from './verify-model.js';
import {
  THEMES, normalizeDeck, deckFromReply, deckSystem, deckContext, slidesAsked, addVersion, setText, moveSlide, deleteSlide,
  duplicateSlide, setTheme, setImage, missingAlt, imagesUsed, editablePath, slideRequest, deckOutline, deckFileName, looseJson,
} from './deck-model.js';
import { deckDocument, LABELS } from './deck-render.js';

const versionsOf = (c) => (c && Array.isArray(c.deckVersions) ? c.deckVersions : []);
const latest = (c) => { const v = versionsOf(c).at(-1); return v ? v.deck : null; };
const save = (c) => saveConversation(c);
const view = { frame: null, url: '', at: 0, presenting: false, pending: null, urls: new Map(), conv: null };
/** The chat whose deck the canvas shows (the one opened, else the current chat). */
const cur = () => (view.conv && state.convs.includes(view.conv) ? view.conv : state.current);

// ── the turn: Slides mode adds the deck instructions, the current deck and room for a long reply ──

const pendingImages = new Map(); // chat id → { att1: stored id }
const SOURCES_WANTED = /\b(sources?|cite|citations?|research|latest|current|recent|today|this year|news|statistics|stats|data on)\b/i;

addSendExtra((body) => {
  const c = state.convs.find((x) => x.id === body.chatId) || state.current;
  if (!c || c.kind === 'code' || c.mode !== 'slides' || body.privacy) return null;
  const last = (body.messages || []).at(-1) || {};
  const atts = (last.attachments || []).filter((a) => a.kind === 'image' && a.data);
  const images = [];
  const map = {};
  atts.slice(0, 8).forEach((a, k) => {
    const data = `data:${a.mime || 'image/png'};base64,${a.data}`;
    if (!/^data:image\/(png|jpeg|gif|webp);base64,/.test(data)) return;
    const id = `att${k + 1}`;
    const stored = `i${Date.now().toString(36)}${k}`;
    storeImage(c, stored, data);
    map[id] = stored;
    images.push({ id, name: a.name });
  });
  pendingImages.set(c.id, map);
  const deck = latest(c);
  const searchOk = !(state.meta && state.meta.search && state.meta.search.available === false);
  return {
    deck: true,
    ...(body.mode === 'chat' && searchOk && SOURCES_WANTED.test(String(last.content || '')) ? { mode: 'search' } : {}),
    system: [body.system, deckSystem({ images, hasDeck: !!deck, count: slidesAsked(last.content) || 0 })].filter(Boolean).join('\n\n'),
    ...(deck ? { context: [...(body.context || []), deckContext(deck)] } : {}),
  };
});

function storeImage(c, id, data, w = 0, h = 0) {
  c.deckImages = c.deckImages || {};
  c.deckImages[id] = { data, w, h };
  if (!w && typeof Image !== 'undefined') {
    const im = new Image();
    im.onload = () => { if (c.deckImages[id]) { c.deckImages[id].w = im.naturalWidth; c.deckImages[id].h = im.naturalHeight; save(c); } };
    im.src = data;
  }
}
/** Pictures no version uses any more are dropped (they live only on this device). */
function pruneImages(c) {
  if (!c.deckImages) return;
  const used = new Set(versionsOf(c).flatMap((v) => imagesUsed(v.deck)));
  for (const id of Object.keys(c.deckImages)) if (!used.has(id)) delete c.deckImages[id];
}

// a finished reply with a deck in it: a new version, opened in the canvas
addEventListener('eden:turn-done', (e) => {
  const { c, node } = e.detail || {};
  if (!c || !node || node.role !== 'assistant') return;
  const text = nodeText(node);
  if (!/```\s*(deck|slides)/.test(text) && !/~~~\s*(deck|slides)/.test(text)) return;
  const r = deckFromReply(text, latest(c));
  if (!r) return;
  if (r.error) { toast(r.error); dispatchEvent(new CustomEvent('eden:repaint', { detail: { c } })); return; }
  const map = pendingImages.get(c.id) || {};
  pendingImages.delete(c.id);
  const deck = { ...r.deck, slides: r.deck.slides.map((s) => (s.image && map[s.image] ? { ...s, image: map[s.image] } : s)) };
  c.deckVersions = addVersion(c.deckVersions, { at: Date.now(), nodeId: node.id, kind: 'model', deck });
  pruneImages(c);
  save(c);
  if (r.warning) toast(r.warning);
  if (c === state.current) openDeck(c, { nodeId: node.id });
});

addEventListener('eden:open-deck', (e) => { const { c, node } = e.detail || {}; const conv = c || state.current; if (conv) openDeck(conv, node ? { nodeId: node.id } : {}); });
addEventListener('eden:report-slides', () => {
  const c = cur();
  if (!c) return;
  c.mode = 'slides';
  save(c);
  artifactSend('Make a slide deck from the research report above: its key findings, one idea per slide, with charts or tables where it has numbers. Keep its citations as [n] and list its sources.');
});

// ── the canvas ──

const toArt = (v, k) => ({ title: v.deck.title, lang: 'deck', code: JSON.stringify(v.deck, null, 2), nodeId: v.nodeId, local: v.kind !== 'model', edLang: 'json', deckIdx: k });

/** Open the chat's deck (its newest version, or the one a reply made) in the canvas. */
export function openDeck(c, { nodeId } = {}) {
  view.conv = c;
  const vs = versionsOf(c);
  if (!vs.length) { openEmpty(c); return; }
  let i = nodeId ? vs.map((v) => v.nodeId).lastIndexOf(nodeId) : vs.length - 1;
  if (i < 0) i = vs.length - 1;
  openDeckCanvas({ versions: vs.map(toArt), i });
}

function openEmpty(c) {
  openDeckCanvas({ versions: [{ title: 'Slides', lang: 'deck', code: '', edLang: 'json', empty: true }], i: 0 });
  if (c.mode !== 'slides') { c.mode = 'slides'; save(c); }
}

/** A local edit: a new version (after the newest, even when an older one is shown), drawn at once. */
function commit(deck, { toastText = '' } = {}) {
  const c = cur();
  if (!c || !deck) return;
  const base = deckCanvasVersion();
  c.deckVersions = addVersion(c.deckVersions, { at: Date.now(), nodeId: base && base.nodeId, kind: 'edit', deck });
  pruneImages(c);
  save(c);
  const vs = versionsOf(c);
  pushDeckVersion(toArt(vs.at(-1), vs.length - 1));
  if (toastText) toast(toastText, { label: tx('Undo'), run: () => $('artPrev').click() });
}

function currentDeck(v = deckCanvasVersion()) {
  if (!v || v.empty) return null;
  const r = normalizeDeck(looseJson(v.code));
  return r.deck || null;
}

/** The label under the reply that made this version, for the sources slide ("Searched the web · cited"…). */
function labelFor(c, v) {
  const n = v && v.nodeId && c.nodes[v.nodeId];
  const l = n && n.verification ? labelView(n.verification) : null;
  if (l && l.text) return tx(l.text); // drawn inside the deck's own frame, which the page's translator doesn't reach
  if (n && n.research && n.research.report) return tx('From Eden’s checked research report');
  return '';
}

const labels = () => Object.fromEntries(Object.entries(LABELS).map(([k, s]) => [k, tx(s)]));
const darkUi = () => document.documentElement.dataset.theme === 'dark';

/** Draw the shown version in the canvas (artifact.js calls this for a deck). */
export async function renderDeckPreview(box, v) {
  const c = cur();
  view.frame = null;
  if (!c) return;
  if (v.empty) { box.replaceChildren(emptyState(c)); return; }
  const parsed = looseJson(v.code);
  const r = parsed === undefined ? { error: 'This isn’t valid JSON yet: fix it in the Code view.' } : normalizeDeck(parsed);
  if (r.error) { box.replaceChildren(el('div', 'art-loading', r.error)); return; }
  if (v.deckIdx === undefined) { // edited in the Code view: kept as a version
    c.deckVersions = addVersion(c.deckVersions, { at: Date.now(), nodeId: v.nodeId, kind: 'edit', deck: r.deck });
    v.deckIdx = versionsOf(c).length - 1;
    save(c);
  }
  const deck = r.deck;
  const html = deckDocument(deck, { mode: 'edit', images: c.deckImages || {}, start: view.at, label: labelFor(c, v), labels: labels(), darkUi: darkUi(), lang: document.documentElement.lang || 'en' });
  const wrap = el('div', { class: 'deck-stage', id: 'deckStage' });
  box.replaceChildren(toolbar(c, deck), el('div', { class: 'deck-panel', id: 'deckPanel', hidden: true }), wrap);
  let url = view.urls.get(html);
  if (!url) {
    wrap.append(el('div', 'art-loading', 'Drawing the slides…'));
    try { url = apiUrl((await api.artifact(html)).url); } catch (e) { wrap.replaceChildren(el('div', 'art-loading', `Couldn’t draw the slides: ${e.message}`)); return; }
    if (view.urls.size > 30) view.urls.delete(view.urls.keys().next().value);
    view.urls.set(html, url);
    if (deckCanvasVersion() !== v) return;
  }
  const frame = el('iframe', { sandbox: 'allow-scripts', src: url, title: `${tx('Slides')}: ${deck.title}`, referrerpolicy: 'no-referrer', class: 'deck-frame' });
  wrap.replaceChildren(frame, el('button', { type: 'button', class: 'deck-exit', hidden: true, onclick: exitPresent }, ico('x', 14), tx('Exit')));
  view.frame = frame;
  view.url = url;
  const miss = missingAlt(deck);
  if (miss.length) notice(`${miss.length} picture${miss.length === 1 ? ' needs' : 's need'} alt text (slide${miss.length === 1 ? '' : 's'} ${miss.map((i) => i + 1).join(', ')}): click “Picture…” on that slide to describe it.`);
}

function emptyState(c) {
  const file = el('input', { type: 'file', accept: '.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation', hidden: true, onchange: () => { if (file.files[0]) importFile(file.files[0]); } });
  const hasChat = path(c).some((n) => n.role === 'assistant' && nodeText(n).trim());
  return el('div', 'deck-empty',
    el('h3', '', 'Slides'),
    el('p', '', 'Describe a deck below (Slides mode is on), attach a PDF, Word or PowerPoint file to build it from, or bring in a PowerPoint to restyle or continue.'),
    el('div', 'deck-empty-acts',
      hasChat ? el('button', { type: 'button', class: 'cap primary', onclick: () => artifactSend('Make a slide deck from this conversation: the main points, one idea per slide, with speaker notes.') }, ico('art', 14), 'Make slides from this chat') : null,
      el('button', { type: 'button', class: 'cap', onclick: () => file.click() }, ico('doc', 14), 'Import a PowerPoint (.pptx)…'),
      file));
}

function notice(text, kids = []) {
  const p = $('deckPanel');
  if (!p) return;
  p.hidden = false;
  p.replaceChildren(el('div', 'grow', text, ...kids), el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Close', onclick: () => { p.hidden = true; } }, ico('x', 14)));
}

function toolbar(c, deck) {
  const cur = deck.theme.base;
  const themeSel = el('select', { 'aria-label': 'Theme', class: 'deck-theme', onchange: () => {
    if (themeSel.value === '__brand') { themeSel.value = cur; brandFile.click(); return; }
    if (themeSel.value === '__describe') { themeSel.value = cur; setComposerText('Restyle the deck for this brand: '); return; }
    commit(setTheme(deck, { base: themeSel.value }));
  } },
  ...Object.entries(THEMES).map(([id, th]) => el('option', { value: id, selected: id === cur && !deck.theme.colors ? true : null }, tx(th.name))),
  deck.theme.colors ? el('option', { value: cur, selected: true }, tx('Brand colors')) : null,
  el('option', { value: '__brand' }, tx('Brand from a PowerPoint…')),
  el('option', { value: '__describe' }, tx('Describe a brand…')));
  const brandFile = el('input', { type: 'file', accept: '.pptx', hidden: true, onchange: () => { if (brandFile.files[0]) importFile(brandFile.files[0], { themeOnly: true }); brandFile.value = ''; } });
  const pptxFile = el('input', { type: 'file', accept: '.pptx', hidden: true, onchange: () => { if (pptxFile.files[0]) importFile(pptxFile.files[0]); pptxFile.value = ''; } });
  const picFile = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true, onchange: () => { if (picFile.files[0]) pictureFor(picFile.files[0]); picFile.value = ''; } });
  const btn = (icon, label, run, cls = 'cap') => el('button', { type: 'button', class: cls, 'data-deck': label.toLowerCase().replace(/[^a-z]+/g, '-').replace(/-+$/, ''), onclick: run }, icon ? ico(icon, 14) : null, label); // data-deck names it (the label is translated)
  return el('div', { class: 'deck-bar', role: 'toolbar', 'aria-label': 'Slides' },
    btn('play', 'Present', () => present()),
    btn(null, 'Presenter view', () => present({ presenter: true })),
    themeSel,
    btn('plus', 'Picture…', () => picFile.click()),
    btn('down', 'PowerPoint', () => exportPptx()),
    btn(null, 'PDF', () => exportPdf()),
    btn(null, 'Google Slides', () => googleSlides()),
    btn(null, 'Outline', () => { const d = currentDeck(); if (d) downloadBlob(new Blob([deckOutline(d)], { type: 'text/markdown' }), deckFileName(d.title, 'md')); }),
    btn('doc', 'Import .pptx', () => pptxFile.click()),
    btn('globe', 'Share', () => share()),
    brandFile, pptxFile, picFile);
}

// ── messages from the deck frame ──

addEventListener('message', (e) => {
  const f = view.frame;
  if (!f || e.source !== f.contentWindow) return;
  const m = e.data && typeof e.data === 'object' ? e.data : {};
  const deck = currentDeck();
  if (!deck) return;
  const idx = Number.isInteger(m.index) && m.index >= 0 && m.index < deck.slides.length ? m.index : -1;
  switch (m.type) {
    case 'deck-ready': if (view.pending) { for (const msg of view.pending) f.contentWindow.postMessage(msg, '*'); view.pending = null; } break;
    case 'deck-at': if (Number.isInteger(m.k) && m.k >= 0) { view.at = m.k; view.index = idx; } break;
    case 'deck-text':
      if (idx < 0 || !editablePath(m.path) || typeof m.value !== 'string' || m.value.length > 5000) return;
      commit(setText(deck, idx, m.path, m.value));
      break;
    case 'deck-move': {
      const from = Number.isInteger(m.from) ? m.from : -1, to = Number.isInteger(m.to) ? m.to : -1;
      if (from < 0 || to < 0 || from >= deck.slides.length || to >= deck.slides.length) return;
      commit(moveSlide(deck, from, to));
      break;
    }
    case 'deck-delete': if (idx >= 0 && deck.slides.length > 1) commit(deleteSlide(deck, idx), { toastText: tx(`Slide ${idx + 1} deleted`) }); break;
    case 'deck-act': slideAction(String(m.act || ''), deck, idx); break;
    case 'deck-undo': (m.redo ? $('artNext') : $('artPrev')).click(); break;
    case 'deck-exit': exitPresent(); break;
    default: break;
  }
});

function slideAction(act, deck, i) {
  if (i < 0) return;
  if (act === 'up' && i > 0) commit(moveSlide(deck, i, i - 1));
  else if (act === 'down' && i < deck.slides.length - 1) commit(moveSlide(deck, i, i + 1));
  else if (act === 'dup') commit(duplicateSlide(deck, i));
  else if (act === 'delete' && deck.slides.length > 1) commit(deleteSlide(deck, i), { toastText: tx(`Slide ${i + 1} deleted`) });
  else if (act === 'add') { setComposerText(`${slideRequest('add', deck, i).replace(/ that follows from it\.$/, '').replace(/\.$/, '')} about `); toast('Say what the new slide is about, then send'); }
  else if (act === 'regen' || act === 'shorter') ask(slideRequest(act, deck, i));
}

function ask(text) {
  const c = cur();
  if (!c) return;
  if (state.streams.has(c.id)) { toast('Wait for the current reply to finish'); return; }
  if (c.mode !== 'slides') { c.mode = 'slides'; save(c); }
  artifactSend(text);
}

// ── present ──

function present({ presenter = false } = {}) {
  const f = view.frame;
  if (!f) { toast('The slides are still loading'); return; }
  const stage = $('deckStage');
  view.presenting = true;
  const mode = { type: 'deck-mode', mode: 'present', presenter };
  const full = !presenter && stage.requestFullscreen ? stage.requestFullscreen().catch(() => null) : Promise.resolve(null);
  full.then(() => {
    if (document.fullscreenElement === stage) { f.contentWindow.postMessage(mode, '*'); f.focus(); return; }
    // no Fullscreen API (iPhone) or presenter view: the slides fill the window. Moving the frame reloads it,
    // so it's told again where it was and how to show (on its deck-ready).
    view.home = stage.parentNode;
    view.pending = [{ type: 'deck-go', k: view.at }, mode];
    stage.classList.add('deck-full');
    stage.querySelector('.deck-exit').hidden = false;
    document.body.append(stage);
    document.body.classList.add('deck-presenting');
    setTimeout(() => f.focus(), 300);
  });
}
function exitPresent() {
  if (!view.presenting) return;
  view.presenting = false;
  const stage = $('deckStage');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (stage && stage.classList.contains('deck-full')) {
    stage.classList.remove('deck-full');
    stage.querySelector('.deck-exit').hidden = true;
    document.body.classList.remove('deck-presenting');
    view.pending = [{ type: 'deck-go', k: view.at }];
    if (view.home && view.home.isConnected) view.home.append(stage); else stage.remove();
    return;
  }
  if (view.frame) view.frame.contentWindow.postMessage({ type: 'deck-mode', mode: 'edit' }, '*');
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && view.presenting) exitPresent(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && view.presenting && !document.fullscreenElement) { e.stopPropagation(); exitPresent(); } }, true);

// ── pictures, import ──

async function shrinkPicture(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
  const png = file.type === 'image/png' && file.size < 600_000;
  return { data: cv.toDataURL(png ? 'image/png' : 'image/jpeg', 0.86), w, h };
}

function pictureFor(file) {
  const deck = currentDeck();
  const c = cur();
  const i = view.index >= 0 ? view.index : 0;
  if (!deck || !c) return;
  shrinkPicture(file).then((pic) => {
    const alt = el('input', { type: 'text', maxlength: 300, required: true, placeholder: tx('What does the picture show?'), 'aria-label': tx('Alt text: what the picture shows, for people who can’t see it') });
    const form = el('form', { class: 'deck-alt', onsubmit: (e) => {
      e.preventDefault();
      if (!alt.value.trim()) { alt.focus(); return; }
      const id = `i${Date.now().toString(36)}`;
      storeImage(c, id, pic.data, pic.w, pic.h);
      commit(setImage(deck, i, id, alt.value));
    } }, el('label', '', `${tx('Describe the picture for slide')} ${i + 1}`, alt), el('button', { type: 'submit', class: 'cap primary' }, 'Add picture'));
    notice('', [form]);
    alt.focus();
  }, () => toast('That picture couldn’t be read'));
}

async function importFile(file, { themeOnly = false } = {}) {
  const c = cur();
  if (!c) return;
  toast(themeOnly ? 'Reading the brand…' : 'Reading the PowerPoint…');
  let r;
  try { r = await (await import('./deck-import.js')).importPptx(file); } catch (e) { r = { error: e.message || 'That file couldn’t be read.' }; }
  if (r.error) { toast(r.error); return; }
  if (themeOnly) {
    const deck = currentDeck();
    if (!deck) return;
    commit(setTheme(deck, r.theme), { toastText: tx('Brand colors and fonts applied') });
    return;
  }
  for (const [id, im] of Object.entries(r.images)) storeImage(c, id + Date.now().toString(36), im.data, im.w, im.h);
  const rename = Object.fromEntries(Object.keys(r.images).map((id) => [id, Object.keys(c.deckImages).find((k) => k.startsWith(id) && c.deckImages[k].data === r.images[id].data)]));
  const deck = { ...r.deck, slides: r.deck.slides.map((s) => (s.image && rename[s.image] ? { ...s, image: rename[s.image] } : s)) };
  c.mode = 'slides';
  c.deckVersions = addVersion(c.deckVersions, { at: Date.now(), kind: 'import', deck });
  save(c);
  openDeck(c);
  toast(`${deck.slides.length} slide${deck.slides.length === 1 ? "" : "s"} imported: ask Eden to restyle or continue them`);
}

// ── exports ──

function downloadBlob(blob, name) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

async function exportPptx() {
  const c = cur(), deck = currentDeck();
  if (!c || !deck) return;
  if (missingAlt(deck).length) toast('Some pictures have no alt text: PowerPoint will have none for them');
  try {
    const { pptxBlob } = await import('./deck-pptx.js');
    const { blob, name } = await pptxBlob(deck, { images: c.deckImages || {}, label: labelFor(c, deckCanvasVersion()) });
    downloadBlob(blob, name);
    toast('Saved as a PowerPoint file');
  } catch (e) { toast(`PowerPoint export failed: ${e.message}`); }
}

function exportPdf() {
  const c = cur(), deck = currentDeck();
  if (!c || !deck) return;
  // a copy with no script at all, in a frame that can't run any: the browser's print, "Save as PDF"
  const html = deckDocument(deck, { mode: 'static', images: c.deckImages || {}, label: labelFor(c, deckCanvasVersion()), labels: labels() });
  const f = el('iframe', { sandbox: 'allow-same-origin allow-modals', title: 'Print', 'aria-hidden': 'true', style: { position: 'fixed', right: '0', bottom: '0', width: '1px', height: '1px', border: '0', opacity: '0' } });
  f.addEventListener('load', () => {
    try { f.contentWindow.focus(); f.contentWindow.print(); } catch { toast('Printing isn’t available here: download the PowerPoint instead'); }
    setTimeout(() => f.remove(), 60_000);
  }, { once: true });
  f.srcdoc = html;
  document.body.append(f);
  toast('Choose “Save as PDF” in the print dialog (one slide a page)');
}

function googleSlides() {
  // Through Google Drive (drive.file only: the files Eden creates; sheet-google.js driveUpload): the PowerPoint,
  // converted to Google Slides in the person's Drive. It writes to their Drive, so it waits for this button.
  const status = el('p', { class: 'deck-gs-status', role: 'status' });
  const upload = el('button', { type: 'button', class: 'cap primary', onclick: async () => {
    const c = cur(), deck = currentDeck();
    if (!c || !deck) return;
    upload.disabled = true;
    status.textContent = tx('Uploading to your Google Drive…');
    try {
      const [{ pptxBlob }, { driveUpload }] = await Promise.all([import('./deck-pptx.js'), import('./sheet-google.js')]);
      const { blob, name } = await pptxBlob(deck, { images: c.deckImages || {}, label: labelFor(c, deckCanvasVersion()) });
      const r = await driveUpload({ name, mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', bytes: new Uint8Array(await blob.arrayBuffer()) }, { convertTo: 'slides' });
      status.replaceChildren(tx('In your Google Drive as Google Slides: '), el('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer', 'data-no-i18n': '' }, r.name || deck.title));
    } catch (e) {
      status.textContent = e.code === 'scope' || e.code === 'not_connected' || e.status === 403 || e.status === 409
        ? tx('Eden isn’t connected to Google Drive yet (it asks only for the files it creates). Connect Google in Settings, or download the PowerPoint and import it in Google Slides.')
        : `${tx('Google Drive didn’t take it')}: ${e.message}`;
    } finally { upload.disabled = false; }
  } }, ico('globe', 14), 'Save to Google Slides');
  notice('', [el('div', 'deck-gs',
    el('b', '', 'Google Slides'),
    el('p', '', 'Save to Google Slides puts a copy in your Google Drive (Eden can see only the files it creates there). Or download the PowerPoint and, in Google Slides, choose File › Import slides.'),
    el('div', 'deck-gs-acts', upload,
      el('button', { type: 'button', class: 'cap', onclick: exportPptx }, ico('down', 14), 'Download PowerPoint'),
      el('a', { class: 'cap', href: 'https://docs.google.com/presentation/', target: '_blank', rel: 'noopener noreferrer' }, ico('ext', 14), 'Open Google Slides')),
    status)]);
}

function share() {
  const c = cur(), deck = currentDeck();
  if (!c || !deck) return;
  // a view-only copy: present mode, no editing, nothing sent back
  openPublish({ title: deck.title, html: deckDocument(deck, { mode: 'present', images: c.deckImages || {}, label: labelFor(c, deckCanvasVersion()), labels: labels(), embedded: false }) });
}

export { closeArtifact as closeDeck };

// "Make slides" on a research report in the canvas (index.html #btnArtSlides, shown by artifact.js)
const slidesBtn = typeof document !== 'undefined' && document.getElementById('btnArtSlides');
if (slidesBtn) slidesBtn.addEventListener('click', () => dispatchEvent(new CustomEvent('eden:report-slides')));
