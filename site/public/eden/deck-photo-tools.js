// AI photo tools for the selected slide's picture (web only; deck.js opens this lazily, never in the iPhone app):
// Remove background, Magic Eraser, Magic Expand and Grab Text. Each tool has an on-device version (canvas,
// deck-photo-model.js) and, where Eden has the key, an AI version through Eden's own image-edit route (the
// Model Router's Gemini Flash Image or GPT Image) or a vision model. Nothing leaves the device until the person
// presses Send on a card that names the service. The result becomes a new version of the slide's picture
// (undoable; alt text kept), stored like every other slide picture.

import { el, ico, toast } from './util.js';
import { t as tx } from './i18n.js';
import { state } from './state.js';
import { streamSSE } from './api.js';
import {
  RATIOS, AI_PROMPTS, removePlainBackground, despill, edgeColor, inpaint, dilate, expandPlan, expandFill, compositeMasked, markMask,
  hasTransparency, editService, pickVisionModel, parseOcrLines, linesFromDetections, slideFromText, pictureVersion,
} from './deck-photo-model.js';

const MAX_SIDE = 1600;
const TOOLS = [['background', 'Remove background'], ['erase', 'Magic Eraser'], ['expand', 'Magic Expand'], ['text', 'Grab Text']];

// ── pictures in and out of canvases ──

function canvasOf(w, h) { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; return cv; }

async function loadPicture(src, maxSide = MAX_SIDE) {
  const im = new Image();
  im.decoding = 'async';
  im.src = src;
  await im.decode();
  const k = Math.min(1, maxSide / Math.max(im.naturalWidth, im.naturalHeight));
  const w = Math.max(1, Math.round(im.naturalWidth * k)), h = Math.max(1, Math.round(im.naturalHeight * k));
  const cv = canvasOf(w, h);
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(im, 0, 0, w, h);
  return g.getImageData(0, 0, w, h);
}

function toCanvas(img) {
  const cv = canvasOf(img.width, img.height);
  cv.getContext('2d').putImageData(img instanceof ImageData ? img : new ImageData(img.data, img.width, img.height), 0, 0);
  return cv;
}
/** PNG when the picture has see-through parts, else JPEG (smaller; slide photos are kept on this device). */
const toDataUrl = (img) => (hasTransparency(img) ? toCanvas(img).toDataURL('image/png') : toCanvas(img).toDataURL('image/jpeg', 0.9));
const resized = (img, w, h) => { const cv = canvasOf(w, h); const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(toCanvas(img), 0, 0, w, h); return g.getImageData(0, 0, w, h); };

// ── the AI calls (only after the person confirms) ──

/** One picture edit through Eden's image route (src/chat/media.ts): the edited picture at the same size. */
async function aiEdit(img, prompt, signal) {
  const url = toCanvas(img).toDataURL('image/png');
  let pic = null, err = '';
  await streamSSE('/api/chat/send', {
    messages: [{ role: 'user', content: prompt, attachments: [{ kind: 'image', name: 'slide-picture.png', mime: 'image/png', data: url.slice(url.indexOf(',') + 1) }] }],
    image: true, video: false, deck: false,
  }, {
    signal,
    onEvent: (t, d) => {
      if (t === 'image' && d && typeof d.data === 'string' && !pic) pic = { mime: d.mime || 'image/png', data: d.data };
      if (t === 'error' && d) err = d.message || '';
    },
  });
  if (!pic) throw new Error(err || tx('The image service sent no picture back.'));
  const back = await loadPicture(`data:${pic.mime};base64,${pic.data}`, 4096);
  return resized(back, img.width, img.height);
}

/** The text in a picture, read by a vision model the person picked (override: the router doesn't choose another). */
async function aiRead(img, model, signal) {
  const url = toCanvas(img).toDataURL('image/jpeg', 0.92);
  let out = '', err = '';
  await streamSSE('/api/chat/send', {
    messages: [{ role: 'user', content: AI_PROMPTS.text, attachments: [{ kind: 'image', name: 'slide-picture.jpg', mime: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) }] }],
    override: { model: model.id }, image: false, video: false, deck: false,
  }, {
    signal,
    onEvent: (t, d) => { if (t === 'text') out += (d && d.text) || ''; if (t === 'error' && d) err = d.message || ''; },
  });
  if (!out && err) throw new Error(err);
  return parseOcrLines(out);
}

// ── the dialog ──

let styled = null;
/** The dialog's stylesheet (deck-photo-tools.css), loaded once before the dialog first shows. */
function addStyles() {
  styled ??= new Promise((resolve) => {
    const link = el('link', { rel: 'stylesheet', id: 'deckPhotoToolsCss', href: new URL('./deck-photo-tools.css', import.meta.url).href });
    link.addEventListener('load', resolve);
    link.addEventListener('error', resolve); // unstyled beats not opening
    document.head.append(link);
  });
  return styled;
}

/**
 * Open the tools for slide `slideIdx`'s picture. `ctx` comes from deck.js:
 * { c, slideIdx, image: { data, w, h }, alt, currentDeck(), storeImage(id, data, w, h), commit(deck, { toastText }), tool? }
 */
export async function openPhotoTools(ctx) {
  await addStyles();
  let original;
  try { original = await loadPicture(ctx.image.data); } catch { toast(tx('That picture couldn’t be read.')); return; }
  const back = document.activeElement;
  let tool = TOOLS.some(([id]) => id === ctx.tool) ? ctx.tool : 'background';
  let work = original; // the picture as the tools have changed it so far
  const steps = []; // earlier versions, for Undo step
  let busy = null; // the AbortController of a running AI call
  let mask = null; // the eraser's brushed pixels
  let ratio = RATIOS[0][1];
  const edit = editService(state.meta);
  const vision = pickVisionModel(state.meta);
  const detector = typeof globalThis.TextDetector === 'function' ? globalThis.TextDetector : null;

  const status = el('p', { class: 'dpt-status', role: 'status', 'aria-live': 'polite', tabindex: '-1' });
  const say = (s) => { status.textContent = s; };
  const view = el('canvas', { 'aria-label': tx('The picture with your changes so far') });
  const maskCv = el('canvas', { class: 'dpt-mask', hidden: true, 'aria-hidden': 'true' });
  const stage = el('div', 'dpt-stage', view, maskCv);
  const controls = el('div', { class: 'dpt-controls' });
  const consent = el('div', { class: 'dpt-consent', hidden: true, role: 'group', 'aria-label': tx('Send the picture?') });
  const textOut = el('textarea', { class: 'dpt-text', 'aria-label': tx('Text from the picture, one line each; the first line becomes the slide title') });
  const useBtn = el('button', { type: 'button', class: 'cap primary', disabled: true, onclick: () => apply() }, tx('Use on slide'));
  const undoBtn = el('button', { type: 'button', class: 'cap', disabled: true, onclick: () => { if (steps.length) { work = steps.pop(); draw(); } } }, tx('Undo step'));
  const tabs = el('div', { class: 'dpt-tabs', role: 'group', 'aria-label': tx('Photo tools') },
    ...TOOLS.map(([id, label]) => el('button', { type: 'button', class: 'cap', 'data-tool': id, 'aria-pressed': String(id === tool), onclick: () => { tool = id; show(); } }, tx(label))));
  const dlg = el('dialog', { class: 'dpt', 'aria-labelledby': 'dptTitle' },
    el('div', 'dpt-body',
      el('div', 'dpt-head', el('h3', { id: 'dptTitle' }, `${tx('Photo tools')} · ${tx('slide')} ${ctx.slideIdx + 1}`),
        el('button', { type: 'button', class: 'iconbtn', 'aria-label': tx('Close'), onclick: () => dlg.close() }, ico('x', 14))),
      tabs, stage, controls, consent, status,
      el('div', 'dpt-foot', undoBtn, el('button', { type: 'button', class: 'cap', onclick: () => dlg.close() }, tx('Cancel')), useBtn)));

  function draw() {
    view.width = work.width; view.height = work.height;
    view.getContext('2d').putImageData(work instanceof ImageData ? work : new ImageData(work.data, work.width, work.height), 0, 0);
    useBtn.disabled = work === original || !!busy;
    undoBtn.disabled = !steps.length || !!busy;
    if (tool === 'erase') resetMask();
  }
  const step = (img, said) => { steps.push(work); work = img; draw(); say(said); };

  function setBusy(ctrl) {
    busy = ctrl;
    dlg.querySelectorAll('.dpt-controls button, .dpt-tabs button').forEach((b) => { b.disabled = !!ctrl || b.dataset.off === '1'; });
    useBtn.disabled = !!ctrl || work === original;
    undoBtn.disabled = !!ctrl || !steps.length;
  }

  /** Hide the send card; focus stays in the dialog (on the status line) rather than falling to the page. */
  function hideConsent() {
    const had = consent.contains(document.activeElement);
    consent.hidden = true;
    if (had) status.focus();
  }

  /** The card that names the service before anything is sent; `run` gets an AbortSignal once the person presses Send. */
  function confirmSend(service, what, run) {
    consent.hidden = false;
    const send = el('button', { type: 'button', class: 'cap primary', onclick: async () => {
      hideConsent();
      const ctrl = new AbortController();
      setBusy(ctrl);
      say(`${tx('Sent to')} ${service.company} (${service.name})… ${tx('this can take up to a minute.')}`);
      try { await run(ctrl.signal); } catch (e) { if (!ctrl.signal.aborted) say(`${service.company}: ${e.message || e}`); }
      setBusy(null);
      if (dlg.open) (useBtn.disabled ? status : useBtn).focus();
    } }, `${tx('Send to')} ${service.company}`);
    consent.replaceChildren(
      el('p', '', `${what} ${tx('This sends the picture on slide')} ${ctx.slideIdx + 1} ${tx('through Eden’s server to')} ${service.company} (${service.name}). ${tx('Nothing has been sent yet.')}`),
      el('div', 'dpt-row', send, el('button', { type: 'button', class: 'cap', onclick: () => { hideConsent(); say(tx('Nothing was sent.')); } }, tx('Don’t send'))));
    send.focus();
  }

  const aiButton = (service, label, onAsk) => (service.available
    ? el('button', { type: 'button', class: 'cap', onclick: onAsk }, ico('spark', 14), `${tx(label)} (${service.company})…`)
    : el('span', { class: 'dpt-note', 'data-needs-key': '1' }, `${tx(label)}: ${tx(service.reason)}`));

  // the eraser's brush: drawn over the picture, in the picture's own pixels
  function resetMask() {
    mask = new Uint8Array(work.width * work.height);
    maskCv.width = work.width; maskCv.height = work.height;
    placeMask();
  }
  function placeMask() {
    const r = view.getBoundingClientRect(), s = stage.getBoundingClientRect();
    Object.assign(maskCv.style, { left: `${r.left - s.left}px`, top: `${r.top - s.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }
  let brush = 24, drawing = false;
  const paint = (e) => {
    const r = maskCv.getBoundingClientRect();
    const k = work.width / r.width;
    const cx = (e.clientX - r.left) * k, cy = (e.clientY - r.top) * k, rad = brush * Math.max(1, work.width / 800);
    const g = maskCv.getContext('2d');
    g.fillStyle = '#ff00ff';
    g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.fill();
    const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(work.width - 1, Math.ceil(cx + rad));
    const y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(work.height - 1, Math.ceil(cy + rad));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= rad * rad) mask[y * work.width + x] = 1;
  };
  maskCv.addEventListener('pointerdown', (e) => { if (busy) return; drawing = true; maskCv.setPointerCapture(e.pointerId); paint(e); });
  maskCv.addEventListener('pointermove', (e) => { if (drawing) paint(e); });
  maskCv.addEventListener('pointerup', () => { drawing = false; });
  maskCv.addEventListener('pointercancel', () => { drawing = false; });
  const brushed = () => mask && mask.some((v) => v);

  function show() {
    tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
    consent.hidden = true;
    maskCv.hidden = tool !== 'erase';
    say('');
    let kids = [];
    if (tool === 'background') {
      let tol = 30;
      kids = [
        el('p', 'dpt-note', tx('On this device: works when the background is one plain colour (a studio shot, a logo, a screenshot). For a busy background, use the AI version.')),
        el('div', 'dpt-row',
          el('label', '', tx('Tolerance'), el('input', { type: 'range', min: 5, max: 90, value: tol, oninput: (e) => { tol = Number(e.target.value); } })),
          el('button', { type: 'button', class: 'cap', onclick: () => {
            const r = removePlainBackground(work, { tolerance: tol });
            if (r.removed < 0.02) { say(tx('No plain background was found along the edges. Raise the tolerance, or use the AI version.')); return; }
            if (r.removed > 0.97) { say(tx('That would clear almost the whole picture. Lower the tolerance, or use the AI version.')); return; }
            step(r.img, `${tx('Background removed on this device')} (${Math.round(r.removed * 100)}%).`);
          } }, tx('Remove on this device')),
          aiButton(edit, 'Remove with AI', () => confirmSend(edit, tx('The AI puts the subject on a flat green backdrop; Eden then makes the backdrop see-through on this device.'), async (signal) => {
            const out = await aiEdit(work, AI_PROMPTS.background, signal);
            const key = edgeColor(out);
            const r = removePlainBackground(out, { tolerance: 60 });
            if (r.removed < 0.02 || r.removed > 0.98) throw new Error(tx('the backdrop it sent back couldn’t be cleared. Try again, or use the on-device version.'));
            step(despill(r.img, key), tx('Background removed. Check the edges, then Use on slide.'));
          }))),
      ];
    } else if (tool === 'erase') {
      kids = [
        el('p', 'dpt-note', tx('Brush over what to remove, then erase. On this device the area is filled from its surroundings (good for sky, walls, grass, plain tables). The brush needs a mouse, pen or finger.')),
        el('div', 'dpt-row',
          el('label', '', tx('Brush'), el('input', { type: 'range', min: 6, max: 80, value: brush, oninput: (e) => { brush = Number(e.target.value); } })),
          el('button', { type: 'button', class: 'cap', onclick: () => { resetMask(); say(tx('Brush cleared.')); } }, tx('Clear brush')),
          el('button', { type: 'button', class: 'cap', onclick: () => {
            if (!brushed()) { say(tx('Brush over something first.')); return; }
            step(inpaint(work, dilate(mask, work.width, work.height, 2)), tx('Erased on this device.'));
          } }, tx('Erase on this device')),
          aiButton(edit, 'Erase with AI', () => {
            if (!brushed()) { say(tx('Brush over something first.')); return; }
            const m = dilate(mask, work.width, work.height, 3);
            confirmSend(edit, tx('The AI sees the picture with the brushed area painted magenta; only that area changes.'), async (signal) => {
              const out = await aiEdit(markMask(work, m), AI_PROMPTS.erase, signal);
              step(compositeMasked(work, out, m, 4), tx('Erased with AI. Only the brushed area changed.'));
            });
          })),
      ];
      requestAnimationFrame(() => { resetMask(); });
    } else if (tool === 'expand') {
      const choices = el('div', { class: 'dpt-row', role: 'group', 'aria-label': tx('Target shape') },
        ...RATIOS.map(([label, v]) => el('button', { type: 'button', class: 'cap', 'aria-pressed': String(v === ratio), onclick: (e) => { ratio = v; choices.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); } }, label)));
      const plan = () => { const p = expandPlan(work.width, work.height, ratio, 2048); if (!p) say(tx('The picture already has that shape.')); return p; };
      const base = (p) => expandFill(resized(work, p.w, p.h), p);
      kids = [
        el('p', 'dpt-note', tx('Grows the picture to a new shape. On this device the new edges are a soft, blurred mirror of the picture; the AI version draws real surroundings.')),
        choices,
        el('div', 'dpt-row',
          el('button', { type: 'button', class: 'cap', onclick: () => { const p = plan(); if (p) step(base(p).img, `${tx('Expanded on this device to')} ${p.W}×${p.H}.`); } }, tx('Expand on this device')),
          aiButton(edit, 'Expand with AI', () => {
            const p = plan();
            if (!p) return;
            confirmSend(edit, tx('The AI sees the picture with blurred placeholder edges and redraws only the new edges.'), async (signal) => {
              const { img, mask: m } = base(p);
              const out = await aiEdit(img, AI_PROMPTS.expand, signal);
              step(compositeMasked(img, out, m, 6), `${tx('Expanded with AI to')} ${p.W}×${p.H}.`);
            });
          })),
      ];
    } else {
      const add = el('button', { type: 'button', class: 'cap primary', onclick: () => {
        const lines = parseOcrLines(textOut.value);
        if (!lines.length) { say(tx('There’s no text to add.')); return; }
        const d = ctx.currentDeck();
        const next = d && slideFromText(d, ctx.slideIdx, lines);
        if (!next || next === d) { say(tx('The deck is full, so no slide was added.')); return; }
        ctx.commit(next, { toastText: `${tx('Added the picture’s text as slide')} ${ctx.slideIdx + 2}` });
        dlg.close();
      } }, tx('Add as a new slide'));
      const got = (lines, how) => { textOut.value = lines.join('\n'); say(lines.length ? `${lines.length} ${tx('lines read')} ${how}. ${tx('Fix anything it misread, then add it.')}` : tx('No text was found in the picture.')); };
      kids = [
        el('p', 'dpt-note', tx('Reads the words in the picture into editable slide text: the first line becomes the title, the rest become points.')),
        el('div', 'dpt-row',
          detector ? el('button', { type: 'button', class: 'cap', onclick: async () => {
            try { got(linesFromDetections(await new detector().detect(toCanvas(work))), tx('on this device')); } catch (e) { say(`${tx('This browser couldn’t read it:')} ${e.message || e}`); }
          } }, tx('Read on this device')) : null,
          aiButton(vision, 'Read with AI', () => confirmSend(vision, tx('The model only reads the text; Eden asks it not to describe the picture.'), async (signal) => {
            got(await aiRead(work, vision, signal), `${tx('by')} ${vision.name}`);
          }))),
        textOut,
        el('div', 'dpt-row', add),
      ];
    }
    controls.replaceChildren(...kids);
    controls.querySelectorAll('[data-needs-key]').forEach((n) => { n.dataset.off = '1'; });
    if (busy) setBusy(busy);
  }

  function apply() {
    const d = ctx.currentDeck();
    if (!d || work === original) return;
    const url = toDataUrl(work);
    const v = pictureVersion(d, ctx.slideIdx, url, { alt: ctx.alt });
    if (!v) { say(tx('That picture couldn’t be saved. Try again.')); return; }
    ctx.storeImage(v.id, url, work.width, work.height);
    ctx.commit(v.deck, { toastText: `${tx('Updated the picture on slide')} ${ctx.slideIdx + 1}` });
    dlg.close();
  }

  document.body.append(dlg);
  // Escape closes this dialog only: the app's own Escape (closing the slides canvas) never sees it while the dialog is open
  const ownEscape = (e) => { if (e.key === 'Escape' && dlg.open) e.stopPropagation(); };
  addEventListener('keydown', ownEscape, true);
  dlg.addEventListener('close', () => {
    if (busy) busy.abort();
    dlg.remove();
    if (back && back.isConnected && typeof back.focus === 'function') back.focus();
  });
  const onResize = () => { if (tool === 'erase') placeMask(); };
  addEventListener('resize', onResize);
  dlg.addEventListener('close', () => { removeEventListener('resize', onResize); setTimeout(() => removeEventListener('keydown', ownEscape, true)); });
  dlg.showModal();
  draw();
  show();
  tabs.querySelector('[aria-pressed="true"]').focus();
}
