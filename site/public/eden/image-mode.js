// Pictures and videos Eden makes (askeden.com & Mac: Google Imagen 4, Gemini Flash Image, Veo 3,
// FLUX.2 klein, GPT Image; site src/eden/image.js & src/chat/media.ts). The composer's Image and
// Video modes send `image: true` / `video: true`; plain "draw me…" or "make a video of…" in Chat
// is caught by the server too. Bytes go to this device's IndexedDB (`eden-images`), and the reply
// keeps only lightweight metadata (node.images / node.videos), so chats still sync (sync-model.js wire).
//
// A follow-up in the same chat ("now make it blue", or "now animate it") sends Eden's last picture
// along (`imageBase`), and the server edits or animates it in place.

import { el, uid, toast } from './util.js';
import { state } from './state.js';
import { addSendExtra } from './api.js';
import { IN_APP } from './native.js';

const urls = new Map(); // media id → object URL (this page's life)
const lastPic = new Map(); // chat id → { data (base64), mime } of its newest picture, for a follow-up edit or animation

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('eden-images', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('pics');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}
async function put(id, blob) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction('pics', 'readwrite'); t.objectStore('pics').put(blob, id); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
}
async function get(id) {
  try {
    const d = await db();
    return await new Promise((res) => { const r = d.transaction('pics').objectStore('pics').get(id); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); });
  } catch { return null; }
}

function b64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Whether this site makes pictures (never inside the iPhone app during App Review). */
export const imagesAvailable = () => !IN_APP && Boolean(state.meta && state.meta.images && state.meta.images.available);

/** Whether this site makes videos (Veo 3 on Gemini; never inside the iPhone app during App Review). */
export const videosAvailable = () => !IN_APP && Boolean(state.meta && state.meta.videos && state.meta.videos.available);

/** The server's `image` event: kept on the device, named on the reply. */
export function imageEvent(c, node, d) {
  if (!d || typeof d.data !== 'string' || !/^image\/(webp|png|jpeg)$/.test(d.mime || '')) return;
  const id = uid('pic');
  const blob = b64ToBlob(d.data, d.mime);
  urls.set(id, URL.createObjectURL(blob));
  lastPic.set(c.id, { data: d.data, mime: d.mime });
  put(id, blob).catch(() => toast('The picture couldn’t be saved on this device; download it to keep it.'));
  (node.images ||= []).push({
    id,
    mime: d.mime,
    size: String(d.size || ''),
    prompt: String(d.prompt || '').slice(0, 1000),
    edit: d.edit === true,
    modelName: String(d.modelName || ''),
  });
}

/** The server's `video` event: kept on the device, named on the reply. */
export function videoEvent(c, node, d) {
  if (!d || typeof d.data !== 'string' || !/^video\/(mp4|webm)$/.test(d.mime || '')) return;
  const id = uid('vid');
  const blob = b64ToBlob(d.data, d.mime);
  urls.set(id, URL.createObjectURL(blob));
  put(id, blob).catch(() => toast('The video couldn’t be saved on this device; download it to keep it.'));
  (node.videos ||= []).push({
    id,
    mime: d.mime,
    size: String(d.size || '1280x720'),
    seconds: Number(d.seconds) || 5,
    prompt: String(d.prompt || '').slice(0, 1000),
    fromImage: d.fromImage === true,
    modelName: String(d.modelName || ''),
  });
}

/** A reply with pictures, as the next turn reads it (chat.js historyFor): what was drawn, not the bytes. */
export const imagesText = (n) => (n && n.images && n.images.length ? n.images.map((p) => `[Eden ${p.edit ? 'changed the picture' : 'made a picture'}: “${p.prompt}”]`).join('\n') : '');

/** A reply with videos, as the next turn reads it: what was animated, not the bytes. */
export const videosText = (n) => (n && n.videos && n.videos.length ? n.videos.map((v) => `[Eden ${v.fromImage ? 'animated the picture' : 'made a video'}: “${v.prompt}”]`).join('\n') : '');

function download(id, prompt, ext = 'webp') {
  const go = (url) => {
    const a = el('a', { href: url, download: `eden-${(prompt || (ext === 'mp4' ? 'video' : 'picture')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'media'}.${ext}` });
    document.body.append(a);
    a.click();
    a.remove();
  };
  if (urls.has(id)) go(urls.get(id));
  else get(id).then((b) => (b ? go(URL.createObjectURL(b)) : toast(`That ${ext === 'mp4' ? 'video' : 'picture'} isn’t on this device.`)));
}

/** The pictures under a reply (render.js), or the "drawing" placeholder while it's made. */
export function imageFigures(node) {
  const pics = node.images || [];
  if (!pics.length) {
    if (node.streaming && node.route && node.route.image) return el('div', { class: 'eden-pic-wait', role: 'status' }, el('div', 'eden-pic-shimmer'), el('span', { text: 'Drawing your picture… this takes a few seconds.' }));
    return null;
  }
  const wrap = el('div', 'eden-pics');
  for (const p of pics) {
    const [w, h] = String(p.size || '1024x1024').split('x').map(Number);
    const img = el('img', { class: 'eden-pic', alt: p.prompt ? `Picture: ${p.prompt}` : 'A picture Eden made', width: w || 1024, height: h || 1024, loading: 'lazy', decoding: 'async' });
    const fig = el('figure', 'eden-pic-fig', img);
    const missing = () => fig.replaceChildren(el('div', { class: 'eden-pic-missing', text: 'This picture was made on another device; it’s kept there.' }));
    if (urls.has(p.id)) img.src = urls.get(p.id);
    else get(p.id).then((b) => { if (!b) return missing(); const u = URL.createObjectURL(b); urls.set(p.id, u); img.src = u; });
    img.addEventListener('click', () => { const u = urls.get(p.id); if (u) window.open(u, '_blank', 'noopener'); });
    const via = p.modelName || (node.route && node.route.modelName) || 'Imagen 4';
    fig.append(el('figcaption', 'eden-pic-bar',
      el('span', { class: 'eden-pic-note', text: `${p.edit ? 'Changed' : 'Made'} with ${via}` }),
      el('button', { type: 'button', class: 'eden-pic-btn', text: 'Download', onclick: () => download(p.id, p.prompt, 'webp') })));
    wrap.append(fig);
  }
  return wrap;
}

/** The videos under a reply (render.js), or the "making video" placeholder while Veo renders it. */
export function videoFigures(node) {
  const vids = node.videos || [];
  if (!vids.length) {
    if (node.streaming && node.route && node.route.video) return el('div', { class: 'eden-pic-wait eden-vid-wait', role: 'status' }, el('div', 'eden-pic-shimmer eden-vid-shimmer'), el('span', { text: 'Making your video… this takes about 30 seconds.' }));
    return null;
  }
  const wrap = el('div', 'eden-pics eden-vids');
  for (const v of vids) {
    const [w, h] = String(v.size || '1280x720').split('x').map(Number);
    const vid = el('video', { class: 'eden-pic eden-vid', width: w || 1280, height: h || 720, controls: true, playsinline: true, loop: true, preload: 'metadata' });
    const fig = el('figure', 'eden-pic-fig eden-vid-fig', vid);
    const missing = () => fig.replaceChildren(el('div', { class: 'eden-pic-missing', text: 'This video was made on another device; it’s kept there.' }));
    if (urls.has(v.id)) vid.src = urls.get(v.id);
    else get(v.id).then((b) => { if (!b) return missing(); const u = URL.createObjectURL(b); urls.set(v.id, u); vid.src = u; });
    const via = v.modelName || (node.route && node.route.modelName) || 'Veo 3';
    fig.append(el('figcaption', 'eden-pic-bar',
      el('span', { class: 'eden-pic-note', text: `${v.fromImage ? 'Animated' : 'Made'} with ${via} (${v.seconds || 5}s)` }),
      el('button', { type: 'button', class: 'eden-pic-btn', text: 'Download', onclick: () => download(v.id, v.prompt, 'mp4') })));
    wrap.append(fig);
  }
  return wrap;
}

// Image & Video modes: every message asks for a picture or video; a follow-up carries the chat's last picture to edit or animate.
addSendExtra((body) => {
  const c = state.convs.find((x) => x.id === body.chatId) || state.current;
  if (!c || c.kind === 'code' || body.privacy) return null;
  const last = lastPic.get(c.id);
  if (c.mode === 'video' && videosAvailable()) return { video: true, ...(last ? { imageBase: last.data, imageBaseMime: last.mime } : {}) };
  if (!imagesAvailable() && !videosAvailable()) return null;
  if (c.mode === 'image' && imagesAvailable()) return { image: true, ...(last ? { imageBase: last.data, imageBaseMime: last.mime } : {}) };
  return last ? { imageBase: last.data, imageBaseMime: last.mime } : null; // "now make it blue" or "now animate it" in Chat, right after a picture
});

// Only right after a picture: a reply without one ends the follow-up (no picture rides along with every message).
addEventListener('eden:turn-done', (e) => {
  const { c, node } = e.detail || {};
  if (c && node && node.role === 'assistant' && !(node.images && node.images.length)) lastPic.delete(c.id);
});
