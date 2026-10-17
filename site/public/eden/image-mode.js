// Pictures Eden makes (askeden.com: GPT Image, site src/eden/image.js). The composer's Image mode
// sends `image: true`; a plain "draw me…" in Chat is caught by the server too. A reply's picture
// arrives as an `image` event: its bytes go to this device's IndexedDB (`eden-images`), and the
// reply keeps only { id, mime, size, prompt } (node.images), so a chat with pictures still syncs
// (sync-model.js wire). On another device the reply says where the picture is.
//
// A follow-up in the same chat ("now make it blue") sends Eden's last picture along
// (`imageBase`), and the server changes it instead of drawing a new one.

import { el, uid, toast } from './util.js';
import { state } from './state.js';
import { addSendExtra } from './api.js';

const urls = new Map(); // picture id → object URL (this page's life)
const lastPic = new Map(); // chat id → { data (base64), mime } of its newest picture, for a follow-up

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

const b64ToBlob = (b64, mime) => new Blob([Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))], { type: mime });

/** Whether this site makes pictures (askeden.com with it switched on; never Eden on the Mac). */
export const imagesAvailable = () => Boolean(state.meta && state.meta.images && state.meta.images.available);

/** The server's `image` event: kept on the device, named on the reply. */
export function imageEvent(c, node, d) {
  if (!d || typeof d.data !== 'string' || !/^image\/(webp|png|jpeg)$/.test(d.mime || '')) return;
  const id = uid('pic');
  const blob = b64ToBlob(d.data, d.mime);
  urls.set(id, URL.createObjectURL(blob));
  lastPic.set(c.id, { data: d.data, mime: d.mime });
  put(id, blob).catch(() => toast('The picture couldn’t be saved on this device; download it to keep it.'));
  (node.images ||= []).push({ id, mime: d.mime, size: String(d.size || ''), prompt: String(d.prompt || '').slice(0, 1000), edit: d.edit === true });
}

/** A reply with pictures, as the next turn reads it (chat.js historyFor): what was drawn, not the bytes. */
export const imagesText = (n) => (n && n.images && n.images.length ? n.images.map((p) => `[Eden ${p.edit ? 'changed the picture' : 'made a picture'}: “${p.prompt}”]`).join('\n') : '');

function download(id, prompt) {
  const go = (url) => {
    const a = el('a', { href: url, download: `eden-${(prompt || 'picture').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'picture'}.webp` });
    document.body.append(a);
    a.click();
    a.remove();
  };
  if (urls.has(id)) go(urls.get(id));
  else get(id).then((b) => (b ? go(URL.createObjectURL(b)) : toast('That picture isn’t on this device.')));
}

/** The pictures under a reply (render.js), or the "drawing" placeholder while it's made. */
export function imageFigures(node) {
  const pics = node.images || [];
  if (!pics.length) {
    if (node.streaming && node.route && node.route.image) return el('div', { class: 'eden-pic-wait', role: 'status' }, el('div', 'eden-pic-shimmer'), el('span', { text: 'Drawing your picture… this takes about 20 seconds.' }));
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
    fig.append(el('figcaption', 'eden-pic-bar',
      el('span', { class: 'eden-pic-note', text: `${p.edit ? 'Changed' : 'Made'} with GPT Image` }),
      el('button', { type: 'button', class: 'eden-pic-btn', text: 'Download', onclick: () => download(p.id, p.prompt) })));
    wrap.append(fig);
  }
  return wrap;
}

// Image mode: every message asks for a picture; a follow-up carries the chat's last one to change.
addSendExtra((body) => {
  const c = state.convs.find((x) => x.id === body.chatId) || state.current;
  if (!c || c.kind === 'code' || body.privacy || !imagesAvailable()) return null;
  const last = lastPic.get(c.id);
  if (c.mode === 'image') return { image: true, ...(last ? { imageBase: last.data, imageBaseMime: last.mime } : {}) };
  return last ? { imageBase: last.data, imageBaseMime: last.mime } : null; // "now make it blue" in Chat, right after a picture
});

// Only right after a picture: a reply without one ends the follow-up (no picture rides along with every message).
addEventListener('eden:turn-done', (e) => {
  const { c, node } = e.detail || {};
  if (c && node && node.role === 'assistant' && !(node.images && node.images.length)) lastPic.delete(c.id);
});
