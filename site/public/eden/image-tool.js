// Pictures in the chat (the page side of eden-tools.js make_image). A reply's make_image card has its picture
// made at once by POST /api/chat/image (askeden.com: site src/eden/image.js, Workers AI's FLUX.2 klein after a
// Llama Guard check; on the Mac: src/chat/image.ts) and drawn under the reply: open it full size, download it,
// copy it, or make another. "from": "last" starts from the last picture Eden made in this chat, "attached" from
// the picture the user attached (each sent at most 511 px, as the model wants).
//
// The picture is kept in the conversation (c.images, by id) on this device only: sync and shared links leave it
// out (sync-model.js wire), the way a deck's pictures stay (deck.js); another device shows the prompt with
// "Make it here".

import { el, ico, toast } from './util.js';
import { postJSON } from './api.js';
import { ui, path, saveConversation, attachmentData } from './state.js';
import * as T from './eden-tools.js';

const KEEP_BYTES = 450_000; // a bigger picture is saved again as JPEG (FLUX's own JPEGs are ~750 KB)
const REF_SIDE = 511; // the model wants each starting picture under 512×512
const ASPECT = { square: '1 / 1', wide: '1344 / 768', tall: '768 / 1344' };
const TIMEOUT = 90_000;
const RUNNING = new WeakSet(); // cards being made in this page (a reload mid-way leaves one "running": said, with Try again)

const newId = () => `im${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('The picture couldn’t be read.'));
    im.src = src;
  });
}
/** A picture drawn again as JPEG, at most `side` px on its longer edge: { url, w, h }. */
async function redraw(src, side, quality = 0.86) {
  const im = await loadImage(src);
  const k = Math.min(1, side / Math.max(im.naturalWidth, im.naturalHeight));
  const w = Math.max(1, Math.round(im.naturalWidth * k)), h = Math.max(1, Math.round(im.naturalHeight * k));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); // a transparent PNG gets white behind it, not black
  g.drawImage(im, 0, 0, w, h);
  return { url: cv.toDataURL('image/jpeg', quality), w, h };
}
const bytesOf = (dataUrl) => { const b = atob(String(dataUrl).split(',')[1] || ''); const out = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i); return out; };
const mimeOf = (dataUrl) => (/^data:([^;,]+)/.exec(dataUrl) || [])[1] || 'image/jpeg';

/** The last picture Eden made on this chat's path before (or in) `node`, if this device has it. */
function lastPicture(c, node) {
  const nodes = path(c);
  const end = nodes.findIndex((n) => n.id === node.id);
  for (const n of nodes.slice(0, end < 0 ? nodes.length : end + 1).reverse()) {
    for (const t of [...(n.tools || [])].reverse()) if (t.name === 'make_image' && t.image && c.images && c.images[t.image]) return c.images[t.image].data;
  }
  return null;
}
/** The newest picture the user attached on this path that this page still holds (attachments aren't kept after a reload). */
function attachedPicture(c, node) {
  const nodes = path(c);
  const end = nodes.findIndex((n) => n.id === node.id);
  for (const n of nodes.slice(0, end < 0 ? nodes.length : end).reverse()) {
    if (n.role !== 'user') continue;
    const live = (attachmentData.get(n.id) || []).filter((a) => a.kind === 'image' && (a.url || a.data));
    const a = live.at(-1);
    if (a) return a.url || `data:${a.mime || 'image/jpeg'};base64,${a.data}`;
  }
  return null;
}
/** The starting picture a call asks for, made small: { refs, note }. */
async function refsFor(c, node, from) {
  if (!from) return { refs: [], note: '' };
  const src = from === 'last' ? lastPicture(c, node) : attachedPicture(c, node);
  if (!src) {
    return { refs: [], note: from === 'last' ? 'The earlier picture isn’t on this device, so this one was made from the description.' : 'Your attached picture isn’t kept after a reload, so this was made from the description.' };
  }
  const small = await redraw(src, REF_SIDE, 0.9);
  return { refs: [{ data: small.url.split(',')[1] }], note: '' };
}

/** Pictures no card uses any more (a "Make another", a deleted branch) leave the conversation. */
function prune(c) {
  if (!c.images) return;
  const used = new Set();
  for (const n of Object.values(c.nodes || {})) for (const t of n.tools || []) if (t.image) used.add(t.image);
  for (const id of Object.keys(c.images)) if (!used.has(id)) delete c.images[id];
}

/** Makes (or makes again) a card's picture. */
export async function makeImage(c, node, t) {
  const v = T.validateCall(t.raw || {});
  if (!v.ok) { t.state = 'error'; t.error = v.error; saveConversation(c); ui.updateMessage(c, node); return; }
  const { prompt, size, from } = v.call.args;
  RUNNING.add(t);
  t.state = 'running';
  delete t.error;
  delete t.failed;
  delete t.note;
  ui.updateMessage(c, node);
  try {
    const { refs, note } = await refsFor(c, node, from);
    const r = await postJSON('/api/chat/image', { prompt, size, ...(refs.length ? { refs } : {}) }, { timeout: TIMEOUT, late: 'The picture is taking too long. Try again.' });
    if (!r || typeof r.image !== 'string' || !r.image) throw new Error('The picture came back empty. Try again.');
    let pic = { data: `data:${r.mime || 'image/jpeg'};base64,${r.image}`, w: r.width || 0, h: r.height || 0 };
    if (r.image.length * 0.75 > KEEP_BYTES) {
      try { const s = await redraw(pic.data, 4096); if (s.url.length < pic.data.length) pic = { data: s.url, w: s.w, h: s.h }; } catch { /* kept as it came */ }
    }
    c.images = c.images || {};
    const id = newId();
    c.images[id] = pic;
    t.image = id;
    t.state = 'done';
    if (note) t.note = note;
    if (typeof r.costUSD === 'number') t.usd = r.costUSD;
    prune(c); // the picture a "Make another" replaced
  } catch (e) {
    const why = String((e && e.message) || e).replace(/\s*—\s*is the Eden server running.*$/, '');
    // a "Make another" that failed keeps the picture it had, with why under it
    if (t.image && c.images && c.images[t.image]) { t.state = 'done'; t.failed = why; }
    else { t.state = 'error'; t.error = why; }
    if (e && e.status === 422) t.refused = true; else delete t.refused; // the safety check said no: trying again won't help
  } finally {
    RUNNING.delete(t);
  }
  saveConversation(c);
  ui.updateMessage(c, node);
}

function viewer(src, alt) {
  const prev = document.activeElement;
  const close = () => { box.remove(); removeEventListener('keydown', onKey, true); if (prev && prev.focus) prev.focus(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  const box = el('div', { class: 'imgview', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Picture', onclick: (e) => { if (e.target === box) close(); } },
    el('img', { src, alt }),
    el('button', { type: 'button', class: 'imgview-x', 'aria-label': 'Close', title: 'Close', onclick: close }, ico('x', 18)));
  document.body.append(box);
  addEventListener('keydown', onKey, true);
  box.querySelector('.imgview-x').focus();
}

const fileName = (prompt, mime) => `${String(prompt || 'picture').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'picture'}.${mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg'}`;
function save(pic, prompt) {
  const url = URL.createObjectURL(new Blob([bytesOf(pic.data)], { type: mimeOf(pic.data) }));
  const a = el('a', { href: url, download: fileName(prompt, mimeOf(pic.data)) });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
async function copy(pic) {
  try {
    // clipboards take PNG
    const png = loadImage(pic.data).then((im) => new Promise((resolve, reject) => {
      const cv = document.createElement('canvas');
      cv.width = im.naturalWidth; cv.height = im.naturalHeight;
      cv.getContext('2d').drawImage(im, 0, 0);
      cv.toBlob((b) => (b ? resolve(b) : reject(new Error('no PNG'))), 'image/png');
    }));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    toast('Picture copied');
  } catch { toast('This browser can’t copy pictures. Download it instead.'); }
}

/** The card under a reply for one make_image call. */
export function imageCard(c, node, t) {
  const v = T.validateCall(t.raw || {});
  if (!v.ok) return el('div', 'notice warn', `Eden couldn’t make the picture: ${v.error}`);
  const { prompt, size } = v.call.args;
  const pic = t.image && c.images ? c.images[t.image] : null;
  const state = t.state === 'running' && !RUNNING.has(t) ? 'stopped' : t.state;
  const root = el('figure', { class: `toolcard imgcard ${state}`, role: 'group', 'aria-label': 'Picture', 'data-tool': 'make_image' });
  const caption = el('figcaption', { class: 'imgcard-cap', 'data-no-i18n': '', title: prompt, dir: 'auto' }, prompt);
  const acts = el('div', 'tc-acts');
  const btn = (label, cls, fn, icon) => acts.append(el('button', { type: 'button', class: `cap ${cls}`, onclick: fn }, icon ? ico(icon, 14) : '', label));
  const again = () => makeImage(c, node, t);
  if (state === 'running') {
    root.append(el('div', { class: 'imgcard-frame busy', style: { aspectRatio: ASPECT[size] } }, el('span', 'imgcard-busy', ico('art', 18), 'Making the picture…')), caption);
  } else if (state === 'done' && pic) {
    root.append(
      el('button', { type: 'button', class: 'imgcard-pic', 'aria-label': 'Open the picture full size', onclick: () => viewer(pic.data, prompt) },
        el('img', { src: pic.data, alt: prompt, width: pic.w || undefined, height: pic.h || undefined, style: { aspectRatio: ASPECT[size] }, decoding: 'async' })),
      caption);
    if (t.note) root.append(el('div', 'tc-notice', t.note));
    if (t.failed) root.append(el('div', { class: 'errbox', role: 'alert' }, ico('x'), el('span', '', t.failed)));
    btn('Download', '', () => save(pic, prompt), 'down');
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard && navigator.clipboard.write) btn('Copy', '', () => copy(pic), 'copy');
    btn('Make another', '', again, 'retry');
    root.append(acts);
  } else if (state === 'done') {
    // made on another device (pictures stay where they were made), or in a shared chat
    root.append(el('div', 'tc-title', ico('art', 15), 'Picture'), caption, el('div', 'tc-notice', 'This picture stays on the device that made it.'));
    btn('Make it here', 'primary', again);
    root.append(acts);
  } else if (state === 'pending') {
    // offered by the page when the reply said it couldn't make pictures
    root.append(el('div', 'tc-title', ico('art', 15), 'Make this picture?'), caption);
    btn('Make it', 'primary', again);
    root.append(acts);
  } else {
    root.append(el('div', 'tc-title', ico('art', 15), 'Picture'), caption,
      el('div', { class: 'errbox', role: 'alert' }, ico('x'), el('span', '', state === 'stopped' ? 'Stopped before the picture came back.' : t.error || 'The picture couldn’t be made.')));
    if (!t.refused) btn('Try again', 'primary', again);
    root.append(acts);
  }
  return root;
}

/* ---------- styles (kept with the cards that use them) ---------- */
const CSS = `.toolcard.imgcard{max-width:min(460px,100%);margin:10px 0 0}
.imgcard .imgcard-pic{display:block;width:100%;padding:0;border:0;background:rgba(127,127,127,.12);cursor:zoom-in;border-radius:calc(var(--r-md,12px) - 4px);overflow:hidden}
.imgcard .imgcard-pic img{display:block;width:100%;height:auto;object-fit:cover}
.imgcard .imgcard-pic:focus-visible{outline:2px solid var(--accent,#0a84ff);outline-offset:2px}
.imgcard .imgcard-frame{width:100%;border-radius:calc(var(--r-md,12px) - 4px);display:flex;align-items:center;justify-content:center;background:linear-gradient(100deg,rgba(127,127,127,.10) 30%,rgba(127,127,127,.20) 50%,rgba(127,127,127,.10) 70%);background-size:300% 100%;animation:imgcard-shine 1.6s linear infinite}
.imgcard .imgcard-busy{display:flex;align-items:center;gap:7px;color:var(--text2,#666);font-size:12.5px}
.imgcard .errbox{margin:0 0 8px}
.imgcard .imgcard-cap{margin:8px 0 8px;color:var(--text2,#666);font-size:12.5px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
@keyframes imgcard-shine{from{background-position:100% 0}to{background-position:0 0}}
@media (prefers-reduced-motion:reduce){.imgcard .imgcard-frame{animation:none}}
.imgview{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.82);cursor:zoom-out}
.imgview img{max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;cursor:default;box-shadow:0 10px 40px rgba(0,0,0,.5)}
.imgview .imgview-x{position:absolute;top:max(12px,env(safe-area-inset-top));right:12px;width:36px;height:36px;border-radius:50%;border:0;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.16);color:#fff;cursor:pointer}
.imgview .imgview-x:focus-visible{outline:2px solid #fff;outline-offset:2px}`;
if (typeof document !== 'undefined' && !document.getElementById('imgcard-css')) document.head.append(Object.assign(document.createElement('style'), { id: 'imgcard-css', textContent: CSS }));
