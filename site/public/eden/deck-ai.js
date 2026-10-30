// Eden's AI where people work in the slide editor (web only): a floating bar on selected text, text actions in the
// text right-click menu and in Inspector › Format, and slide actions in the slide/thumbnail right-click menu and in
// Inspector › Format › "Ask Eden about this slide". Every action shows a preview first (Accept, Try again, Discard);
// Accept is one version (undo = the version arrows, or Undo on the toast). Registered through the editor shell
// (deck-shell.js, research_notes/slides-redesign/inspector-api.md); deck.js imports this only when !IN_APP.
// The model call is a small job of the editor's own: the cheap routed model (level 1), straight to /api/chat/send
// with no send extras, so no chat picture or deck rides along and nothing is added to the chat. The words and the
// guards are in deck-ai-model.js (pure, tested); EVES fact-check is deck-factcheck.js.

import { el } from './util.js';
import { streamSSE } from './api.js';
import { routeSettings } from './router.js';
import { looseJson } from './deck-model.js';
import { registerInspector, registerContextMenu, registerShortcut, kit, icon, context, onSelection, selection } from './deck-shell.js';
import * as AI from './deck-ai-model.js';

const tx = (s) => context().tx(s);

// ── the model call ──

/** One small model job → { text, model, costUSD }. Throws on an error with no text. */
export async function aiCall(system, user, signal) {
  let text = '', error = '', model = '', costUSD = null;
  await streamSSE('/api/chat/send', {
    messages: [{ role: 'user', content: user }], system,
    settings: { ...routeSettings(), level: 1 }, mode: 'chat', deck: false, deckJob: true, temporary: true, image: false, video: false,
  }, {
    signal,
    onEvent: (type, d) => {
      if (type === 'text') text += (d && d.text) || '';
      else if (type === 'route' && d) { model = d.modelName || d.model || model; if (typeof d.costUSD === 'number') costUSD = d.costUSD; }
      else if (type === 'usage' && d && typeof d.costUSD === 'number') costUSD = d.costUSD;
      else if (type === 'error') error = (d && d.message) || 'The model call failed.';
    },
  });
  if (error && !text) throw new Error(error);
  return { text, model, costUSD };
}
let call = aiCall;
/** Tests and the QA script swap the model for a stand-in. */
export function setModelCall(fn) { call = typeof fn === 'function' ? fn : aiCall; }

const costLine = (r) => [r.model, typeof r.costUSD === 'number' ? (r.costUSD < 0.01 ? '<$0.01' : `$${r.costUSD.toFixed(2)}`) : ''].filter(Boolean).join(' · ');

// ── the text selection (deck-rich-frame.js posts deck-rich-sel with the range and where it is) ──

let textSel = null; // { index, path, start, end, rect }
let dropT = 0;
addEventListener('message', (e) => {
  const c = context();
  const f = c.frame();
  if (!f || e.source !== f.contentWindow) return;
  const m = e.data && typeof e.data === 'object' ? e.data : {};
  if (m.type !== 'deck-rich-sel' && m.type !== 'deck-sel') return;
  const ok = Number.isInteger(m.index) && typeof m.path === 'string' && m.path.length < 80 && Number.isInteger(m.start) && Number.isInteger(m.end) && m.end > m.start;
  if (!ok) { clearTimeout(dropT); dropT = setTimeout(() => { if (bar && (bar.matches(':hover') || bar.contains(document.activeElement))) return; textSel = null; drawBar(); }, 250); return; } // a click on the bar blurs the frame first: keep the bar for it
  clearTimeout(dropT);
  textSel = { index: m.index, path: m.path, start: m.start, end: m.end, rect: m.rect && typeof m.rect === 'object' ? m.rect : null };
  drawBar();
});
onSelection((s) => { if (textSel && (s.slide !== textSel.index || (s.kind === 'text' && s.textPath !== textSel.path) || s.kind === 'element')) { textSel = null; drawBar(); } });

/** What a text action works on: the selected words, else the whole focused box. */
function currentText() {
  const c = context(), deck = c.deck, s = selection();
  if (!deck) return null;
  if (textSel) { // the frame's word selection is the freshest word on what is selected
    const sel = AI.selectionOf(deck, textSel);
    if (sel) return sel;
  }
  return s.kind === 'text' && s.textPath ? AI.selectionOf(deck, { index: s.slide, path: s.textPath }) : null;
}

// ── the floating bar ──

let bar = null;
const richBarUp = () => !!document.querySelector('.rtb:not([hidden])'); // the format bar (deck-rich) has its own Ask Eden button
function drawBar() {
  if (bar) { bar.remove(); bar = null; }
  const c = context();
  const f = c.frame();
  if (!textSel || !textSel.rect || !f || busy) return;
  const fr = f.getBoundingClientRect();
  const r = textSel.rect;
  const sel = currentText();
  if (!sel || richBarUp()) return;
  const quick = [['rewrite', 'Rewrite'], ['shorter', 'Shorter'], ['grammar', 'Fix grammar']];
  bar = el('div', { class: 'dai-bar', role: 'toolbar', 'aria-label': tx('Ask Eden about the selected text') },
    el('span', { class: 'dai-bar-ic', 'aria-hidden': 'true' }, icon('sparkles', 15)),
    ...quick.map(([id, label]) => el('button', { type: 'button', class: 'dai-bar-b', 'data-ai': id, onmousedown: (e) => e.preventDefault(), onclick: () => runText(id, sel) }, tx(label))),
    el('button', { type: 'button', class: 'dai-bar-b', 'aria-haspopup': 'menu', 'data-ai': 'more', onmousedown: (e) => e.preventDefault(), onclick: (e) => kit.menu(e.currentTarget, textItems(sel), { label: tx('Ask Eden') }) }, tx('More'), icon('chevron', 12)));
  document.body.append(bar);
  setTimeout(() => { if (bar && richBarUp()) { bar.remove(); bar = null; } }, 200); // the format bar can come up just after
  const w = bar.offsetWidth, h = bar.offsetHeight;
  const x = Math.max(8, Math.min(innerWidth - w - 8, fr.left + (Number(r.x) || 0) + (Number(r.w) || 0) / 2 - w / 2));
  let y = fr.top + (Number(r.y) || 0) + (Number(r.h) || 0) + 10; // below the words (the format bar sits above them)
  if (y + h > Math.min(innerHeight, fr.bottom) - 4) y = fr.top + (Number(r.y) || 0) - h - 10; // no room below: above
  Object.assign(bar.style, { left: `${Math.round(x)}px`, top: `${Math.round(y)}px` });
}
addEventListener('resize', () => { if (bar) drawBar(); });
// the format bar's own "Ask Eden" button (deck-rich, when it has one) opens the same menu
addEventListener('eden:deck-ai-menu', (e) => { const a = e.detail && e.detail.anchor; if (a instanceof Element) kit.menu(a, textItems(), { label: tx('Ask Eden') }); });
addEventListener('scroll', () => { if (bar) drawBar(); }, true);

const textItems = (sel = currentText()) => [{ heading: tx('Ask Eden') }, ...AI.TEXT_ACTIONS.map((a) => ({ label: tx(a.label), icon: a.id === 'translate' ? 'globe' : a.id === 'ask' ? 'chat' : a.id === 'rewrite' ? 'sparkles' : null, run: () => runText(a.id, sel) }))];

// ── previews ──

let busy = false;
function waiting(title, ctl) {
  const stop = kit.button({ label: tx('Stop'), onClick: () => ctl.abort() });
  const s = kit.sheet({ title, content: el('p', { class: 'dai-wait', role: 'status' }, el('span', { class: 'dai-spin', 'aria-hidden': 'true' }), tx('Eden is working on it…')), actions: [stop], onClose: () => ctl.abort() });
  return s;
}
/**
 * The preview sheet: content, warnings, the model and cost, and Accept / Try again / Discard.
 * → a promise of 'accept' | 'again' | 'discard'.
 */
function preview(title, content, { warnings = [], meta = '', acceptLabel = 'Accept', wide = false } = {}) {
  return new Promise((done) => {
    let answer = 'discard';
    const accept = kit.button({ label: tx(acceptLabel), primary: true, key: 'dai-accept', onClick: () => { answer = 'accept'; s.close(); } });
    const again = kit.button({ label: tx('Try again'), key: 'dai-again', onClick: () => { answer = 'again'; s.close(); } });
    const discard = kit.button({ label: tx('Discard'), quiet: true, key: 'dai-discard', onClick: () => s.close() });
    const body = el('div', { class: 'dai-preview' }, content,
      warnings.length ? el('ul', { class: 'dai-warn', role: 'note' }, ...warnings.map((w) => el('li', '', icon('info', 14), tx(w)))) : null,
      meta ? el('p', { class: 'dai-meta' }, meta) : null);
    const s = kit.sheet({ title, content: body, actions: [discard, again, accept], wide, onClose: () => done(answer) });
    requestAnimationFrame(() => accept.focus());
  });
}
function failed(title, message, retry) {
  const s = kit.sheet({ title, content: el('p', { class: 'dai-err', role: 'alert' }, message), actions: [kit.button({ label: tx('Close'), quiet: true, onClick: () => s.close() }), ...(retry ? [kit.button({ label: tx('Try again'), primary: true, onClick: () => { s.close(); retry(); } })] : [])] });
}

/** Ask for what an action needs first (a language, an instruction, a slide). → the value, or null when cancelled. */
function ask(title, field, { okLabel = 'Continue' } = {}) {
  return new Promise((done) => {
    let v = null;
    const ok = kit.button({ label: tx(okLabel), primary: true, onClick: () => { v = field.value; s.close(); } });
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && field.tagName !== 'SELECT') { e.preventDefault(); ok.click(); } });
    const s = kit.sheet({ title, content: el('div', { class: 'dai-ask' }, field), actions: [kit.button({ label: tx('Cancel'), quiet: true, onClick: () => s.close() }), ok], onClose: () => done(v && String(v).trim() ? v : null) });
    requestAnimationFrame(() => field.focus());
  });
}

/**
 * One AI job with its preview: call the model, make the result (make(reply) → result | { error }), show it
 * (show(result) → Node), and loop on Try again. → the result when the person accepts, else null.
 */
export async function modelJob({ title, system, user, make, show, warn = (r) => r.warnings || [], wide = false }) {
  if (busy) return null;
  busy = true; drawBar();
  try {
    for (;;) {
      const ctl = new AbortController();
      const w = waiting(title, ctl);
      let r, out;
      try { out = await call(system, user, ctl.signal); r = make(out.text); } catch (e) { r = { error: e && e.name === 'AbortError' ? '' : (e && e.message) || 'Eden couldn’t do that.' }; }
      w.close();
      if (!r || r.error !== undefined) { if (!r || r.error) failed(title, tx((r && r.error) || 'Eden couldn’t do that.')); return null; }
      const answer = await preview(title, await show(r), { warnings: warn(r), meta: costLine(out), wide });
      if (answer === 'accept') return r;
      if (answer !== 'again') return null;
    }
  } finally { busy = false; drawBar(); }
}
export const busyAi = () => busy;

const diff = (was, nowTag, now) => el('div', { class: 'dai-diff' },
  was === null ? null : el('div', { class: 'dai-was' }, el('span', { class: 'dai-tag' }, tx('Now')), el('p', '', was)),
  el('div', { class: 'dai-now' }, el('span', { class: 'dai-tag' }, tx(nowTag)), el('p', { 'data-ai-result': '' }, now)));

// ── text actions ──

export async function runText(action, given = null) {
  const c = context();
  const sel = given || currentText();
  if (busy) return;
  if (!sel) { c.toast(tx('Select some text on the slide first')); return; }
  const label = (AI.TEXT_ACTIONS.find((a) => a.id === action) || {}).label || 'Ask Eden';
  const opts = { deckTitle: c.deck && c.deck.title, slideTitle: c.deck && c.deck.slides[sel.index] && c.deck.slides[sel.index].title };
  if (action === 'translate') {
    const here = (navigator.language || 'en').split('-')[0];
    const pick = el('select', { class: 'dai-field', 'aria-label': tx('Language') }, ...AI.LANGUAGES.map(([code, name, own]) => el('option', { value: code, selected: code === (here !== 'en' ? here : 'es') || null }, `${tx(name)}${own !== name ? ` · ${own}` : ''}`)));
    opts.lang = await ask(tx('Translate the selected text into'), pick, { okLabel: 'Translate' });
    if (!opts.lang) return;
  } else if (action === 'ask') {
    const box = el('textarea', { class: 'dai-field', rows: '3', maxlength: '500', placeholder: tx('For example: make it sound more confident'), 'aria-label': tx('What should Eden change?') });
    opts.instruction = await ask(tx('Ask Eden to change this'), box, { okLabel: 'Ask Eden' });
    if (!opts.instruction) return;
  }
  let prompt;
  try { prompt = AI.textPrompt(action, sel, opts); } catch (e) { c.toast(e.message); return; }
  const r = await modelJob({ title: tx(label), system: prompt.system, user: prompt.user, make: (reply) => AI.textResult(prompt, sel, reply), show: (x) => diff(sel.text, 'Eden’s version', x.text) });
  if (!r) return;
  const deck = context().deck;
  const still = deck && AI.selectionOf(deck, { index: sel.index, path: sel.path, start: sel.start, end: sel.end });
  if (!still || still.value !== sel.value) { failed(tx(label), tx('The text changed while Eden was working, so nothing was replaced. Try again.')); return; }
  const d = AI.applyText(deck, sel, r);
  if (d !== deck) context().commit(d, { toastText: tx('Text changed') });
  textSel = null; drawBar();
}

// ── slide actions ──

/** A sandboxed picture of the given slides (deck-render.js static mode, no script), scaled to fit. */
async function slidesPicture(deck, idx, conv) {
  const { deckDocument } = await import('./deck-render.js');
  const part = { ...deck, slides: idx.map((k) => deck.slides[k]).filter(Boolean) };
  const html = deckDocument(part, { mode: 'static', images: (conv && conv.deckImages) || {} });
  const n = part.slides.length;
  const f = el('iframe', { sandbox: '', srcdoc: html, title: tx('Preview'), tabindex: '-1', class: 'dai-shot-f', style: { height: `${720 * n}px` } });
  return el('div', { class: 'dai-shot', style: { '--n': String(n) }, 'aria-hidden': 'true' }, f);
}

export async function runSlide(action, i) {
  const c = context();
  const deck = c.deck;
  if (busy || !deck || !deck.slides[i]) return;
  if (action === 'image') { if (c.actions.openPhotoStudio) c.actions.openPhotoStudio(i); return; }
  const meta = AI.SLIDE_ACTIONS.find((a) => a.id === action);
  if (!meta) return;
  let like = -1;
  if (action === 'restyle') {
    const pick = el('select', { class: 'dai-field', 'aria-label': tx('Slide to copy') }, ...deck.slides.map((s, k) => (k === i ? null : el('option', { value: String(k) }, `${k + 1}. ${s.title || tx(s.layout)}`))));
    const v = await ask(tx(`Restyle slide ${i + 1} like`), pick, { okLabel: 'Restyle' });
    if (v === null) return;
    like = Number(v);
  }
  const label = action === 'restyle' ? `Restyle like slide ${like + 1}` : meta.label;
  let prompt;
  try { prompt = AI.slidePrompt(action, deck, i, { like }); } catch (e) { c.toast(e.message); return; }
  const before = JSON.stringify(deck.slides.slice(i, i + 2));
  const r = await modelJob({
    title: tx(label), system: prompt.system, user: prompt.user, wide: !['notes', 'takeaway'].includes(action),
    make: (reply) => AI.patchFor(prompt, deck, reply, looseJson),
    show: async (x) => (action === 'notes' ? diff(deck.slides[i].notes || null, 'Speaker notes', x.deck.slides[i].notes || '')
      : action === 'takeaway' ? diff(deck.slides[i].takeaway || null, 'Takeaway', x.deck.slides[i].takeaway || '')
        : el('div', { class: 'dai-compare' },
          el('figure', '', el('figcaption', '', tx('Now')), await slidesPicture(deck, action === 'merge' ? [i, i + 1] : [i], c.conv)),
          el('figure', '', el('figcaption', '', tx('Eden’s version')), await slidesPicture(x.deck, x.changed, c.conv)))),
  });
  if (!r) return;
  const now = context().deck;
  if (!now || JSON.stringify(now.slides.slice(i, i + 2)) !== before) { failed(tx(label), tx('The slide changed while Eden was working, so nothing was replaced. Try again.')); return; }
  context().commit(r.deck, { toastText: tx(`${label}: done`) });
}

const slideItems = (i) => {
  const deck = context().deck;
  if (!deck || !deck.slides[i]) return [];
  return [{ heading: tx('Ask Eden') }, ...AI.slideActionsFor(deck, i).map((a) => ({ label: tx(a.label), icon: a.id === 'chart' ? 'chart' : a.id === 'table' ? 'table' : a.id === 'image' ? 'photo' : a.id === 'notes' ? 'notes' : a.id === 'visual' ? 'wand' : a.id === 'restyle' ? 'theme' : a.id === 'split' || a.id === 'merge' ? 'layout' : 'sparkles', run: () => runSlide(a.id, i) }))];
};

// ── registration (web only: deck.js imports this module only when !IN_APP) ──

registerContextMenu({ id: 'ai-text', target: 'text', order: 60, items: () => { const s = currentText(); return s ? textItems() : []; } });
registerContextMenu({ id: 'ai-slide', target: 'slide', order: 60, items: (ctx) => slideItems(Number.isInteger(ctx.index) ? ctx.index : ctx.selection.slide) });
registerContextMenu({ id: 'ai-thumb', target: 'thumb', order: 60, items: (ctx) => slideItems(Number.isInteger(ctx.index) ? ctx.index : ctx.selection.slide) });

registerInspector({
  id: 'ai-text', tab: 'format', title: 'Ask Eden', order: 25, when: (s) => s.kind === 'text',
  render: () => {
    const s = currentText();
    if (!s) return null;
    return el('div', { class: 'dai-sec' },
      el('p', { class: 'dsh-hint' }, textSel && textSel.path === s.path && s.text !== s.value ? tx('Changes only the selected words.') : tx('Changes this text box. Select some words to change only those.')),
      el('div', { class: 'dai-grid' }, ...AI.TEXT_ACTIONS.map((a) => kit.button({ label: tx(a.label), small: true, key: `ai-t-${a.id}`, onClick: () => runText(a.id) }))));
  },
});
registerInspector({
  id: 'ai-slide-actions', tab: 'format', title: 'Ask Eden about this slide', order: 91, when: (s) => s.kind === 'slide',
  render: (ctx) => {
    const i = ctx.selection.slide;
    const deck = ctx.deck;
    if (!deck || !deck.slides[i]) return null;
    return el('div', { class: 'dai-grid' }, ...AI.slideActionsFor(deck, i).map((a) => kit.button({ label: tx(a.label), small: true, key: `ai-s-${a.id}`, onClick: () => runSlide(a.id, i) })));
  },
});
registerShortcut({ id: 'ai-rewrite', keys: 'Mod+Alt+R', label: 'Ask Eden to rewrite the selected text', when: (s) => s.kind === 'text', run: () => runText('rewrite') });

const CSS_ID = 'deckAiCss';
if (typeof document !== 'undefined' && !document.getElementById(CSS_ID)) document.head.append(el('link', { id: CSS_ID, rel: 'stylesheet', href: new URL('./deck-ai.css', import.meta.url).href }));
