// A search answer's pictures, ChatGPT-style (search-images.js has the how and why): a strip of up to five Wikipedia
// pictures at the top of the reply (render.js), and a viewer with the picture's source when one is tapped (app.js).
// The page asks for them with `images: true` on a send (chat.js); never in the iPhone or Android app for now
// (ROADMAP: shown there after App Store approval).

import { el } from './util.js';
import { IN_APP } from './native.js';
import { cleanEventImages } from './search-images.js';

/** Whether this page asks for pictures with search answers. */
export const webImagesOn = () => !IN_APP;

/** A `webimages` event (chat.js): checked, then kept on the reply (saved and synced with it). */
export function webImagesEvent(node, d) {
  const images = cleanEventImages(d && d.images);
  if (images.length) node.webImages = images;
}

/** The strip above the reply's text, or null. */
export function webImagesStrip(node) {
  const list = node.webImages || [];
  if (!list.length) return null;
  const shown = list.slice(0, 5);
  return el('div', { class: `webimgs n${shown.length}`, role: 'group', 'aria-label': 'Pictures from Wikipedia' },
    ...shown.map((p, i) => el('button', { type: 'button', class: 'webimg', 'data-act': 'webimg', 'data-i': String(i), title: p.title, 'aria-label': p.title || p.article || 'Picture', 'data-no-i18n': '' }, // file names stay as they are
      el('img', { src: p.src, alt: p.title || p.article || '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', ...(p.width && p.height ? { width: p.width, height: p.height } : {}), onerror: (e) => e.target.closest('.webimg')?.classList.add('broken') }))));
}

let viewer = null;

/** The viewer: the picture large, its name, where it's from, and the previous and next ones. */
export function openWebImage(node, start = 0) {
  const list = (node && node.webImages) || [];
  if (!list.length) return;
  closeWebImage();
  let i = Math.min(Math.max(0, start), list.length - 1);
  const back = document.activeElement;
  const img = el('img', { class: 'wiv-img', alt: '', referrerpolicy: 'no-referrer' });
  const title = el('div', { class: 'wiv-title', 'data-no-i18n': '' });
  const links = el('div', 'wiv-links');
  const count = el('span', 'wiv-count');
  const prev = el('button', { type: 'button', class: 'wiv-nav prev', 'aria-label': 'Previous picture', text: '‹', onclick: () => show(i - 1) });
  const next = el('button', { type: 'button', class: 'wiv-nav next', 'aria-label': 'Next picture', text: '›', onclick: () => show(i + 1) });
  const close = el('button', { type: 'button', class: 'wiv-close', 'aria-label': 'Close', text: '×', onclick: () => closeWebImage() });
  const box = el('div', { class: 'wiv', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Picture' },
    el('div', 'wiv-stage', prev, img, next),
    el('div', 'wiv-bar', el('div', 'wiv-text', title, links), count),
    close);
  const show = (n) => {
    i = (n + list.length) % list.length;
    const p = list[i];
    img.src = p.src;
    img.alt = p.title || p.article || '';
    title.textContent = p.title || p.article || '';
    const a = (href, ...kids) => (href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, ...kids) : null);
    links.replaceChildren(...[a(p.articleUrl, 'Wikipedia', p.article ? el('span', { 'data-no-i18n': '', text: `: ${p.article}` }) : null), a(p.page, 'Picture source and license')].filter(Boolean));
    count.textContent = list.length > 1 ? `${i + 1} / ${list.length}` : '';
    prev.hidden = next.hidden = list.length < 2;
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeWebImage(); }
    else if (e.key === 'ArrowLeft' && list.length > 1) show(i - 1);
    else if (e.key === 'ArrowRight' && list.length > 1) show(i + 1);
    else if (e.key === 'Tab') { // focus stays in the viewer
      const f = [...box.querySelectorAll('button:not([hidden]), a[href]')];
      if (!f.length) return;
      const k = f.indexOf(document.activeElement);
      if (e.shiftKey && k <= 0) { e.preventDefault(); f.at(-1).focus(); } else if (!e.shiftKey && k === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
  };
  box.addEventListener('click', (e) => { if (e.target === box || e.target.classList.contains('wiv-stage')) closeWebImage(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(box);
  viewer = { box, onKey, back };
  show(i);
  close.focus({ preventScroll: true });
}

export function closeWebImage() {
  if (!viewer) return;
  const { box, onKey, back } = viewer;
  viewer = null;
  document.removeEventListener('keydown', onKey, true);
  box.remove();
  if (back && back.isConnected) back.focus({ preventScroll: true });
}
