// The editor side of video and audio on slides (web only; deck.js calls initDeckMedia when !IN_APP). A file the
// person adds is checked (its real type from its first bytes, a size cap, that this browser can play it), stored in
// IndexedDB (deck-mediastore.js), and named on the slide by id; its poster is a picture like any other (c.deckImages).
// c.deckMedia keeps a small list of this chat's files ({ type, name, size, w, h, duration }) so pruning knows them.
// The slide frame asks for the files when it loads (deck-media-ready) and gets them as Blobs (deck-video.js plays them).

import { el, toast } from './util.js';
import { t as tx } from './i18n.js';
import { state } from './state.js';
import * as convstore from './convstore.js';
import { putMedia, getMedia, delMedia, listMedia } from './deck-mediastore.js';
import { setSlideMedia, mediaUsed } from './deck-model.js';
import { sniffMedia, mediaProblem, fitBox, PLACES, MEDIA_ACCEPT, PPTX_EMBED_MAX, mb } from './deck-video.js';

let api = null; // { frame, currentDeck, cur, commit, notice, storeImage, slideAt, save }

const CSS = `.dm-panel{display:flex;flex-direction:column;gap:8px}
.dm-head{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.dm-head strong{margin-right:auto;color:var(--text)}
.dm-item{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;padding:8px;border:1px solid var(--hairline);border-radius:12px;background:var(--content)}
.dm-item b{flex-basis:100%;color:var(--text);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dm-item label{display:flex;align-items:center;gap:5px;color:var(--text)}
.dm-item select,.dm-item input[type=number],.dm-stock input,.dm-stock select{font:inherit;min-height:36px;padding:4px 8px;border-radius:9px;border:1px solid var(--hairline);background:var(--content2);color:var(--text)}
.dm-item input[type=number]{width:76px}
.dm-stock{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.dm-stock input{flex:1;min-width:180px}
.dm-results{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:6px;max-height:180px;overflow:auto}
.dm-results button{display:flex;flex-direction:column;gap:4px;text-align:left;font:inherit;font-size:12px;padding:5px;border-radius:9px;border:1px solid var(--hairline);background:var(--content);color:var(--text);cursor:pointer}
.dm-results img{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:6px;background:#111}
.dm-panel :is(button,select,input):focus-visible{outline:3px solid var(--accent);outline-offset:2px}`;

/** Wires the editor up (once): the frame's request for its files. */
export function initDeckMedia(a) {
  if (api) { api = a; return; }
  api = a;
  if (typeof document !== 'undefined' && !document.getElementById('deck-media-css')) document.head.append(el('style', { id: 'deck-media-css' }, CSS));
  addEventListener('message', (e) => {
    const f = api.frame();
    if (!f || e.source !== f.contentWindow || !e.data || e.data.type !== 'deck-media-ready') return;
    sendMedia(f);
  });
}

/** Posts the open deck's files to its frame: each as a Blob, or { missing } when this browser doesn't have it. */
async function sendMedia(f) {
  const deck = api.currentDeck();
  if (!deck) return;
  const items = [];
  for (const id of mediaUsed(deck)) {
    const rec = await getMedia(id).catch(() => null);
    items.push(rec ? { id, blob: rec.blob } : { id, missing: true });
  }
  if (f.contentWindow) f.contentWindow.postMessage({ type: 'deck-media', items }, '*');
}

const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join('');

/** A file's playable details (and a poster frame for a video), read in Eden's page; rejects when it won't play. */
function probe(blob, kind) {
  return new Promise((resolve, reject) => {
    const m = document.createElement(kind === 'video' ? 'video' : 'audio');
    const url = URL.createObjectURL(blob);
    let done = false;
    const end = (fn, v) => { if (done) return; done = true; clearTimeout(timer); m.removeAttribute('src'); m.load(); URL.revokeObjectURL(url); fn(v); };
    const timer = setTimeout(() => end(reject, new Error('This browser couldn’t open that file.')), 12000);
    m.muted = true;
    m.preload = 'auto';
    m.onerror = () => end(reject, new Error('This browser can’t play that file (its format or codec).'));
    m.onloadedmetadata = () => {
      const info = { duration: Number.isFinite(m.duration) ? Math.round(m.duration * 10) / 10 : 0, w: m.videoWidth || 0, h: m.videoHeight || 0 };
      if (kind !== 'video') { end(resolve, info); return; }
      if (!info.w || !info.h) { end(reject, new Error('That video has no picture this browser can show.')); return; }
      m.onseeked = () => {
        try {
          const scale = Math.min(1, 960 / info.w);
          const cv = document.createElement('canvas');
          cv.width = Math.round(info.w * scale);
          cv.height = Math.round(info.h * scale);
          cv.getContext('2d').drawImage(m, 0, 0, cv.width, cv.height);
          info.poster = cv.toDataURL('image/jpeg', 0.84);
          info.pw = cv.width; info.ph = cv.height;
        } catch { /* no poster: the slide shows the first frame */ }
        end(resolve, info);
      };
      m.currentTime = Math.min(1, (info.duration || 0) / 10);
    };
    m.src = url;
  });
}

/** Checks, stores and puts a file on slide i (or adds captions to item `forItem`). */
export async function addMediaFile(file, i = api.slideAt(), { forItem = null } = {}) {
  const c = api.cur(), deck = api.currentDeck();
  if (!c || !deck || !deck.slides[i]) return false;
  const s = deck.slides[i];
  const sn = sniffMedia(new Uint8Array(await file.slice(0, 16).arrayBuffer()), file.name || '');
  const kind = sn ? sn.kind : '';
  const wantCaptions = forItem !== null;
  const problem = wantCaptions && kind !== 'captions' ? 'Captions must be a WebVTT (.vtt) file.' : !wantCaptions && kind === 'captions' ? 'Pick a video first, then add its captions.' : mediaProblem(kind, file.size);
  if (problem) { toast(tx(problem)); return false; }
  if (!wantCaptions && (s.media || []).length >= 4) { toast(tx('A slide holds up to 4 videos or sounds.')); return false; }
  const blob = new Blob([file], { type: sn.mime });
  let info = {};
  if (kind !== 'captions') {
    if (!document.createElement(kind).canPlayType(sn.mime)) { toast(tx('This browser can’t play that kind of file.')); return false; }
    toast(tx('Adding the file to the slide…'));
    try { info = await probe(blob, kind); } catch (e) { toast(tx(e.message)); return false; }
  }
  const id = `m${rid()}`;
  try { await putMedia({ id, blob, type: sn.mime, name: String(file.name || '').slice(0, 120), size: file.size, conv: c.id }); }
  catch (e) { toast(tx(e.message)); return false; }
  c.deckMedia = c.deckMedia || {};
  c.deckMedia[id] = { type: sn.mime, name: String(file.name || '').slice(0, 120), size: file.size, ...(info.w ? { w: info.w, h: info.h } : {}), ...(info.duration ? { duration: info.duration } : {}) };
  const media = (s.media || []).map((m) => ({ ...m }));
  if (wantCaptions) {
    const m = media.find((x) => x.id === forItem);
    if (!m) return false;
    m.captions = id;
    commitMedia(deck, i, media, tx('Captions added'));
    return true;
  }
  let poster;
  if (info.poster) { poster = `p${id.slice(1, 25)}`; api.storeImage(c, poster, info.poster, info.pw, info.ph); }
  const box = kind === 'video' ? fitBox(info.w, info.h) : PLACES.center({ kind });
  media.push({ id: `v${rid().slice(0, 6)}`, kind, src: id, ...(poster ? { poster } : {}), name: String(file.name || '').replace(/\.[a-z0-9]+$/i, '').slice(0, 120), ...box });
  commitMedia(deck, i, media, kind === 'video' ? tx(`Video added to slide ${i + 1}`) : tx(`Sound added to slide ${i + 1}`));
  return true;
}

/** Saves the slide's new media as a version, then shows the panel again over the redrawn slide. */
function commitMedia(deck, i, media, toastText, focusKey = '') {
  const old = document.getElementById('deckPanel');
  api.commit(setSlideMedia(deck, i, media), { toastText });
  let tries = 0;
  const again = () => { // the redraw replaces the panel; reopen it on the new one
    const p = document.getElementById('deckPanel');
    if (p && p !== old && api.currentDeck()) { openMediaPanel(i); if (focusKey) { const b = document.querySelector(`.dm-panel [data-key="${focusKey}"]`); if (b) b.focus({ preventScroll: true }); } return; }
    if (++tries < 60) setTimeout(again, 100);
  };
  setTimeout(again, 50);
}

/** The panel for slide i's video and audio: add a file or a stock clip, and how each one plays. */
export function openMediaPanel(i = api.slideAt()) {
  const deck = api.currentDeck(), c = api.cur();
  if (!deck || !c || !deck.slides[i]) return;
  sweep();
  const s = deck.slides[i];
  const list = s.media || [];
  const fileIn = el('input', { type: 'file', accept: MEDIA_ACCEPT, hidden: true, onchange: () => { const f = fileIn.files[0]; fileIn.value = ''; if (f) addMediaFile(f, i); } });
  const change = (m, patch, msg, key) => commitMedia(deck, i, list.map((x) => (x.id === m.id ? { ...x, ...patch } : x)), msg, key);
  const rows = list.map((m) => {
    const meta = (c.deckMedia && c.deckMedia[m.src]) || {};
    const k = (name) => `${m.id}:${name}`;
    const capIn = el('input', { type: 'file', accept: '.vtt,text/vtt', hidden: true, onchange: () => { const f = capIn.files[0]; capIn.value = ''; if (f) addMediaFile(f, i, { forItem: m.id }); } });
    const num = (name, label, value) => el('label', '', tx(label), el('input', { type: 'number', min: '0', step: '0.5', value: value || 0, 'data-key': k(name), 'aria-label': `${tx(label)} (${tx('seconds')})`,
      onchange: (e) => change(m, { [name]: Math.max(0, Number(e.target.value) || 0) }, tx('Updated'), k(name)) }), tx('s'));
    return el('div', { class: 'dm-item', role: 'group', 'aria-label': m.name || m.kind },
      el('b', '', `${m.kind === 'video' ? '▶' : '♪'} ${m.name || tx(m.kind === 'video' ? 'Video' : 'Audio')}${meta.size ? ` · ${mb(meta.size)}` : ''}${meta.duration ? ` · ${Math.floor(meta.duration / 60)}:${String(Math.round(meta.duration % 60)).padStart(2, '0')}` : ''}`),
      el('label', '', tx('When presenting'), el('select', { 'data-key': k('auto'), onchange: (e) => change(m, { autoplay: e.target.value === 'auto' }, tx('Updated'), k('auto')) },
        el('option', { value: 'click', selected: !m.autoplay ? true : null }, tx('Play on click')), el('option', { value: 'auto', selected: m.autoplay ? true : null }, tx('Play automatically')))),
      el('label', '', el('input', { type: 'checkbox', checked: m.loop ? true : null, 'data-key': k('loop'), onchange: (e) => change(m, { loop: e.target.checked }, tx('Updated'), k('loop')) }), tx('Loop')),
      m.kind === 'video' ? el('label', '', el('input', { type: 'checkbox', checked: m.muted ? true : null, 'data-key': k('muted'), onchange: (e) => change(m, { muted: e.target.checked }, tx('Updated'), k('muted')) }), tx('Muted')) : null,
      num('start', 'Start at', m.start), num('end', 'End at', m.end),
      el('label', '', tx('Place'), el('select', { 'data-key': k('place'), onchange: (e) => { if (PLACES[e.target.value]) change(m, PLACES[e.target.value]({ kind: m.kind, w: meta.w || m.w, h: meta.h || m.h }), tx('Moved'), k('place')); } },
        el('option', { value: '' }, tx('Move to…')), ...[['center', 'Centre'], ['right', 'Right side'], ['full', 'Whole slide'], ['corner', 'Corner']].map(([v, l]) => el('option', { value: v }, tx(l))))),
      m.kind === 'video' ? el('button', { type: 'button', class: 'cap', 'data-key': k('cap'), onclick: () => (m.captions ? change(m, { captions: '' }, tx('Captions removed'), k('cap')) : capIn.click()) }, m.captions ? tx('Remove captions') : tx('Captions (.vtt)…')) : null,
      el('button', { type: 'button', class: 'cap', 'data-key': k('del'), onclick: () => commitMedia(deck, i, list.filter((x) => x.id !== m.id), tx('Removed from the slide')) }, tx('Remove')),
      capIn);
  });
  const stock = el('div', { class: 'dm-stock', hidden: true });
  const panel = el('div', { class: 'dm-panel' },
    el('div', 'dm-head', el('strong', '', `${tx('Video & audio')} · ${tx('slide')} ${i + 1}`),
      el('button', { type: 'button', class: 'cap primary', 'data-key': 'dm-add', disabled: list.length >= 4 ? true : null, onclick: () => fileIn.click() }, tx('Add a file…')), fileIn),
    el('p', '', tx('MP4, WebM, MP3, M4A or WAV (videos up to 150 MB, sounds up to 40 MB). The files stay in this browser; PowerPoint export puts them inside the file.')),
    ...rows, stock);
  api.notice('', [panel]);
  stockSearch(stock, i);
  const first = panel.querySelector('[data-key="dm-add"]');
  if (first && !document.activeElement?.closest?.('.dm-panel')) first.focus({ preventScroll: true });
}

/** Stock clips, when the stock-media module offers them (deck-media.js searchMedia(kind, q)). */
async function stockSearch(box, i) {
  const mod = await import('./deck-media.js').catch(() => null);
  if (!mod || typeof mod.searchMedia !== 'function' || !box.isConnected) return;
  const kindSel = el('select', { 'aria-label': tx('Kind') }, el('option', { value: 'video' }, tx('Videos')), el('option', { value: 'audio' }, tx('Music & sounds')));
  const q = el('input', { type: 'search', placeholder: tx('Search free stock clips…'), 'aria-label': tx('Search stock clips') });
  const results = el('div', { class: 'dm-results', role: 'list' });
  const run = async () => {
    if (!q.value.trim()) return;
    results.replaceChildren(el('p', '', tx('Searching…')));
    let got = [];
    try { got = await mod.searchMedia(kindSel.value, q.value.trim()); } catch (e) { results.replaceChildren(el('p', '', tx(`Stock search failed: ${e.message}`))); return; }
    const items = (Array.isArray(got) ? got : (got && got.results) || []).slice(0, 24);
    if (!items.length) { results.replaceChildren(el('p', '', tx('Nothing found.'))); return; }
    results.replaceChildren(...items.map((r) => {
      const src = r.src || r.url || r.file || '';
      const thumb = r.thumb || r.poster || r.preview || r.image || '';
      const title = String(r.title || r.alt || r.name || q.value).slice(0, 80);
      return el('button', { type: 'button', role: 'listitem', onclick: async () => {
        try {
          toast(tx('Getting the clip…'));
          const blob = await (await fetch(src)).blob();
          const credit = r.credit || r.author || r.by || '';
          const before = api.currentDeck();
          const added = await addMediaFile(new File([blob], `${title}${credit ? ` — ${credit}` : ''}.${kindSel.value === 'video' ? 'mp4' : 'mp3'}`, { type: blob.type }), i);
          const d = added && typeof mod.creditInsert === 'function' ? api.currentDeck() : null; // its credit on the sources slide (deck-media.js)
          const c = api.cur();
          const credited = d && c && mod.creditInsert(before, d, r, c.deckCredits && typeof c.deckCredits === 'object' ? c.deckCredits : (c.deckCredits = {}));
          if (credited && credited !== d) api.commit(credited, { toastText: tx('Credit added to the sources slide') });
        } catch (e) { toast(tx(`Couldn’t get that clip: ${e.message}`)); }
      } }, thumb ? el('img', { src: thumb, alt: '' }) : null, title);
    }));
  };
  box.replaceChildren(kindSel, q, el('button', { type: 'button', class: 'cap', onclick: run }, tx('Search')), results);
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  box.hidden = false;
}

/** The chat's files no version uses any more are deleted from this browser (deck.js pruneImages calls this). */
export function pruneMedia(c, decks) {
  if (!c || !c.deckMedia) return;
  const used = new Set(decks.flatMap((d) => (d ? mediaUsed(d) : [])));
  for (const id of Object.keys(c.deckMedia)) if (!used.has(id)) { delete c.deckMedia[id]; delMedia(id).catch(() => {}); }
}

let swept = false;
/** Files of chats that were deleted (once a session; only files a day old, whose chat is gone from this browser). */
async function sweep() {
  if (swept) return;
  swept = true;
  const have = new Set(state.convs.map((c) => c.id));
  for (const r of await listMedia()) {
    if (!r.conv || have.has(r.conv) || Date.now() - (r.at || 0) < 86400000) continue;
    if (!(await convstore.get(r.conv))) await delMedia(r.id);
  }
}

const readData = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result || '')); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
function pngOf(dataUrl) {
  return new Promise((res) => {
    if (!dataUrl) { res(''); return; }
    const im = new Image();
    im.onload = () => { try { const cv = document.createElement('canvas'); cv.width = im.naturalWidth; cv.height = im.naturalHeight; cv.getContext('2d').drawImage(im, 0, 0); res(cv.toDataURL('image/png')); } catch { res(''); } };
    im.onerror = () => res('');
    im.src = dataUrl;
  });
}

/** For PowerPoint (deck-pptx.js buildPptx's `media`): each file inside the .pptx while it fits, else a note why not. */
export async function pptxMediaFiles(deck, c) {
  const out = {};
  let total = 0, webm = false;
  for (const s of deck.slides) for (const m of s.media || []) {
    if (out[m.src]) continue;
    const rec = await getMedia(m.src).catch(() => null);
    if (!rec) { out[m.src] = { note: 'the file isn’t in this browser' }; continue; }
    if (rec.size > PPTX_EMBED_MAX.each || total + rec.size > PPTX_EMBED_MAX.total) { out[m.src] = { note: `too big to put in this file (${mb(rec.size)}); play it from Eden` }; continue; }
    total += rec.size;
    const extn = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/webm': 'webm' }[rec.type] || 'mp4';
    if (extn === 'webm') webm = true;
    const cover = m.poster && c.deckImages && c.deckImages[m.poster] ? await pngOf(c.deckImages[m.poster].data) : '';
    out[m.src] = { data: (await readData(rec.blob)).replace(/^data:/, ''), extn, ...(cover ? { cover } : {}) };
  }
  if (webm) toast(tx('WebM clips may not play in PowerPoint for Mac; MP4 plays everywhere.'));
  return out;
}
