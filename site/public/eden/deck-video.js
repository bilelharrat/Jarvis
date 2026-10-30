// Video and audio on slides (web only): what a slide's media (slide.media, deck-model.js normalizeMedia) looks like in
// the slide frame, in a PDF and in PowerPoint. Pure: no DOM at import (src/__tests__/deck-media-play.test.ts runs it
// in Node). The files live in this browser (deck-mediastore.js); the slide frame has no network and no storage, so the
// page posts each file to it as a Blob and the frame's own small player (mediaFrame below) makes a blob: URL it can
// play (the artifact CSP allows media from blob: and data: only). The editor side is deck-video-ui.js.

export const MEDIA_MAX = { video: 150 * 1024 * 1024, audio: 40 * 1024 * 1024, captions: 512 * 1024 };
/** PowerPoint files keep a video or sound inside them up to this size each (and this much in all); bigger ones get
 *  the poster and a note. */
export const PPTX_EMBED_MAX = { each: 60 * 1024 * 1024, total: 150 * 1024 * 1024 };
export const MEDIA_ACCEPT = 'video/mp4,video/webm,audio/mpeg,audio/mp4,audio/x-m4a,audio/wav,audio/x-wav,audio/webm,.mp4,.m4v,.webm,.mp3,.m4a,.wav';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const n = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : 0);
const ascii = (b, from, to) => String.fromCharCode(...b.slice(from, to));

/**
 * What a file really is, from its first bytes (a renamed file is not what its name says): { kind, mime, extn } with
 * kind video | audio | captions, or null. head: the first 16+ bytes; name: its file name.
 */
export function sniffMedia(head, name = '') {
  const b = head instanceof Uint8Array ? head : new Uint8Array(head || []);
  const ext = String(name).toLowerCase().split('.').pop();
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12);
    if (brand === 'qt  ') return null; // QuickTime .mov: Chrome can't play it
    return brand.startsWith('M4A') || brand.startsWith('M4B') || ext === 'm4a' ? { kind: 'audio', mime: 'audio/mp4', extn: 'm4a' } : { kind: 'video', mime: 'video/mp4', extn: 'mp4' };
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return ext === 'weba' ? { kind: 'audio', mime: 'audio/webm', extn: 'webm' } : { kind: 'video', mime: 'video/webm', extn: 'webm' };
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE') return { kind: 'audio', mime: 'audio/wav', extn: 'wav' };
  if ((b.length >= 3 && ascii(b, 0, 3) === 'ID3') || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { kind: 'audio', mime: 'audio/mpeg', extn: 'mp3' };
  const t = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0; // (a byte-order mark)
  if (b.length >= t + 6 && ascii(b, t, t + 6) === 'WEBVTT') return { kind: 'captions', mime: 'text/vtt', extn: 'vtt' };
  return null;
}

/** Why a file can't go on a slide, or '' when it can. */
export function mediaProblem(kind, size) {
  if (!kind) return 'That isn’t a video or sound file Eden can play (MP4, WebM, MP3, M4A or WAV; captions as .vtt).';
  if (!(size > 0)) return 'The file is empty.';
  const max = MEDIA_MAX[kind];
  return size > max ? `That file is ${mb(size)}; ${kind === 'captions' ? 'captions' : kind === 'video' ? 'videos' : 'sound files'} can be up to ${mb(max)}.` : '';
}
export const mb = (bytes) => (bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024 * 10) / 10} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** A box that fits a video of this shape on the slide, centred, at most 70% of its width and height. */
export function fitBox(vw, vh, W = 1280, H = 720) {
  const r = vw > 0 && vh > 0 ? vw / vh : 16 / 9;
  let w = Math.round(W * 0.7), h = Math.round(w / r);
  if (h > H * 0.7) { h = Math.round(H * 0.7); w = Math.round(h * r); }
  return { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h };
}
/** Where the panel's position choices put a box. */
export const PLACES = {
  center: (m) => (m.kind === 'audio' ? { x: 460, y: 600, w: 360, h: 64 } : fitBox(m.w, m.h)),
  right: (m) => (m.kind === 'audio' ? { x: 860, y: 610, w: 360, h: 64 } : { x: 660, y: 150, w: 560, h: Math.round(560 * m.h / m.w) || 315 }),
  full: (m) => (m.kind === 'audio' ? { x: 60, y: 620, w: 1160, h: 64 } : { x: 0, y: 0, w: 1280, h: 720 }),
  corner: (m) => (m.kind === 'audio' ? { x: 900, y: 40, w: 340, h: 60 } : { x: 900, y: 470, w: 340, h: Math.round(340 * m.h / m.w) || 191 }),
};

/**
 * The slide's media as markup. ctx: { live (the frame plays them: edit/present on the web), images, imageData, labels }.
 * Not live (PDF, a shared page, the iPhone app): the poster with a "Video" badge, and no player.
 */
export function mediaLayer(s, ctx) {
  const list = Array.isArray(s.media) ? s.media : [];
  if (!list.length) return '';
  const L = ctx.labels || {};
  return list.map((m) => {
    const pos = `left:${n(m.x)}px;top:${n(m.y)}px;width:${n(m.w)}px;height:${n(m.h)}px`;
    const what = m.kind === 'video' ? L.video || 'Video' : L.audio || 'Audio';
    const label = `${what}${m.name ? `: ${m.name}` : ''}`;
    const poster = m.poster && ctx.imageData ? ctx.imageData(ctx.images && ctx.images[m.poster]) : '';
    if (!ctx.live) {
      return `<figure class="mbox m${m.kind} mstatic" style="${pos}" role="img" aria-label="${esc(label)}">${poster ? `<img src="${poster}" alt="">` : ''}<span class="mbadge">${m.kind === 'video' ? '▶' : '♪'} ${esc(what)}${m.name ? ` · ${esc(m.name.slice(0, 60))}` : ''}</span></figure>`;
    }
    const attrs = `data-src="${esc(m.src)}" preload="metadata" playsinline controls${m.loop ? ' data-loop="1"' : ''}${m.muted ? ' muted' : ''}${m.autoplay ? ' data-auto="1"' : ''}${m.start ? ` data-start="${n(m.start)}"` : ''}${m.end ? ` data-end="${n(m.end)}"` : ''} aria-label="${esc(label)}"`;
    const player = m.kind === 'video'
      ? `<video ${attrs}${poster ? ` poster="${poster}"` : ''}>${m.captions ? `<track kind="captions" data-track="${esc(m.captions)}" label="${esc(L.captions || 'Captions')}" default>` : ''}</video>`
      : `<audio ${attrs}></audio>`;
    return `<figure class="mbox m${m.kind}" data-mid="${esc(m.id)}" style="${pos}">${player}<button type="button" class="mplay" aria-label="${esc(`${L.play || 'Play'} ${label}`)}"><span aria-hidden="true">${m.kind === 'video' ? '▶' : `♪ ${esc((m.name || what).slice(0, 40))}`}</span></button><span class="mmiss">${esc(L.mediaMissing || `${what} not on this device`)}</span></figure>`;
  }).join('');
}

export const MEDIA_CSS = `.mbox{position:absolute;margin:0;z-index:3;border-radius:14px;overflow:hidden;background:#000;box-shadow:0 12px 34px rgba(0,0,0,.28)}
.mbox video{width:100%;height:100%;object-fit:contain;display:block;background:#000}
.mbox.maudio{background:rgba(20,20,24,.82);border-radius:999px;display:flex;align-items:center;padding:0 10px;box-sizing:border-box}
.maudio audio{width:100%}
.mplay{display:none;position:absolute;inset:0;margin:auto;width:92px;height:92px;border-radius:50%;border:2px solid rgba(255,255,255,.7);background:rgba(0,0,0,.55);color:#fff;font:600 34px -apple-system,system-ui,sans-serif;cursor:pointer}
.mplay:focus-visible{outline:4px solid #fff;outline-offset:3px}
.mode-present .mbox:not(.playing) .mplay{display:block}
.maudio .mplay{width:100%;height:100%;border-radius:999px;font-size:20px;border:0;background:transparent}
.mode-present .maudio .mplay{display:block}.mode-present .maudio audio{visibility:hidden;position:absolute}
.mode-present .maudio.playing .mplay span::before{content:'❚❚ '}
.mmiss{display:none}
.mmissing .mmiss{display:flex;position:absolute;inset:0;align-items:center;justify-content:center;text-align:center;padding:8px;color:#fff;font:600 18px -apple-system,system-ui,sans-serif;background:rgba(0,0,0,.72)}
.mmissing .mplay{display:none!important}
.mstatic{background:#16161a}.mstatic img{width:100%;height:100%;object-fit:cover;display:block}
.mbadge{position:absolute;left:12px;bottom:12px;max-width:calc(100% - 24px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:rgba(0,0,0,.7);color:#fff;font:600 16px -apple-system,system-ui,sans-serif;padding:6px 12px;border-radius:999px}
.mstatic.maudio .mbadge{position:static}
.thumb .mbox,#pv .mbox{pointer-events:none}.thumb .mplay,#pv .mplay{display:none!important}`;

/* The player: runs inside the sandboxed slide document only (stringified into it by deck-render.js). The page posts
   { type: 'deck-media', items: [{ id, blob } | { id, missing: true }] }; only the parent page is listened to. */
export function mediaFrame() {
  'use strict';
  const urls = new Map(), missing = new Set();
  const body = document.body;
  const els = () => [...document.querySelectorAll('#frame > .slide [data-src]')];
  const present = () => body.classList.contains('mode-present');
  function apply() {
    for (const m of els()) {
      const u = urls.get(m.dataset.src);
      const box = m.closest('.mbox');
      if (u && !m.dataset.on) { m.dataset.on = '1'; m.src = u; }
      box.classList.toggle('mmissing', !u && missing.has(m.dataset.src));
      const tr = m.querySelector('track[data-track]');
      if (tr && !tr.src && urls.get(tr.dataset.track)) tr.src = urls.get(tr.dataset.track);
    }
    sync();
  }
  const start = (m) => Number(m.dataset.start) || 0;
  function play(m) {
    if (!m.src) return;
    if (m.ended || (m.dataset.end && m.currentTime >= Number(m.dataset.end)) || m.currentTime < start(m)) m.currentTime = start(m);
    const p = m.play();
    if (p && p.catch) p.catch(() => m.closest('.mbox').classList.remove('playing')); // the browser held autoplay: the play button stays
  }
  let was = '';
  function sync() { // on every slide or mode change: pause what's off screen; in present mode, start what autoplays
    const pres = present();
    for (const m of els()) {
      const on = m.closest('.slide').classList.contains('cur');
      m.controls = !pres;
      if (!on || !pres) {
        if (!m.paused && (!on || was === 'present')) m.pause();
        delete m.dataset.armed;
      } else if (m.dataset.auto && !m.dataset.armed && m.src) { m.dataset.armed = '1'; m.currentTime = start(m); play(m); }
    }
    was = pres ? 'present' : 'edit';
  }
  for (const m of els()) {
    const box = m.closest('.mbox');
    m.addEventListener('play', () => box.classList.add('playing'));
    m.addEventListener('pause', () => box.classList.remove('playing'));
    m.addEventListener('ended', () => box.classList.remove('playing'));
    m.addEventListener('loadedmetadata', () => { if (start(m) && m.currentTime < start(m)) m.currentTime = start(m); });
    m.addEventListener('timeupdate', () => {
      const end = Number(m.dataset.end) || 0;
      if (end && m.currentTime >= end) { if (m.dataset.loop) m.currentTime = start(m); else m.pause(); }
    });
    m.addEventListener('ended', () => { if (m.dataset.loop) play(m); });
    const toggle = (e) => { if (!present()) return; e.stopPropagation(); e.preventDefault(); if (m.paused) play(m); else m.pause(); };
    box.querySelector('.mplay').addEventListener('click', toggle);
    if (m.tagName === 'VIDEO') m.addEventListener('click', toggle);
    box.addEventListener('pointerup', (e) => { if (present()) e.stopPropagation(); }); // a tap on the video is not a swipe
  }
  const mo = new MutationObserver(sync);
  mo.observe(body, { attributes: true, attributeFilter: ['class'] });
  for (const sl of document.querySelectorAll('#frame > .slide')) mo.observe(sl, { attributes: true, attributeFilter: ['class'] });
  addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const m = e.data || {};
    if (m.type !== 'deck-media' || !Array.isArray(m.items)) return;
    for (const it of m.items.slice(0, 64)) {
      if (!it || typeof it.id !== 'string') continue;
      if (typeof Blob !== 'undefined' && it.blob instanceof Blob && !urls.has(it.id)) urls.set(it.id, URL.createObjectURL(it.blob));
      else if (it.missing) missing.add(it.id);
    }
    apply();
  });
  window.parent.postMessage({ type: 'deck-media-ready' }, '*');
}

/**
 * The slide's media in PowerPoint (buildPptx, deck-pptx.js). files: src → { data: 'video/mp4;base64,…', extn, cover }
 * for each file small enough to go inside, or { note } for one that isn't. Without a file: the poster and a note.
 */
export function addPptxMedia(slide, s, { files = null, images = {}, imageData, IN }) {
  for (const m of s.media || []) {
    const box = { x: IN(m.x), y: IN(m.y), w: IN(m.w), h: IN(m.h) };
    const f = files && files[m.src];
    if (f && f.data) {
      slide.addMedia({ type: m.kind, data: f.data, extn: f.extn, ...(f.cover ? { cover: f.cover } : {}), ...box });
      continue;
    }
    const poster = m.poster && imageData ? imageData(images[m.poster]) : '';
    if (poster && /^data:image\/(png|jpe?g|gif);base64,/i.test(poster)) slide.addImage({ data: poster.replace(/^data:/, ''), ...box, altText: m.name || '' });
    else slide.addShape('rect', { ...box, fill: { color: '16161A' }, line: { color: '16161A' } });
    const what = m.kind === 'video' ? 'Video' : 'Audio';
    const note = (f && f.note) || 'not in this file';
    slide.addText(`${m.kind === 'video' ? '▶' : '♪'} ${what}${m.name ? ` “${m.name}”` : ''}: ${note}`, { x: box.x, y: Math.max(box.y, box.y + box.h - 0.45), w: box.w, h: Math.min(0.45, box.h), fontSize: 11, color: 'FFFFFF', fill: { color: '000000', transparency: 30 }, margin: 4, fit: 'shrink' });
  }
}
