// Eden Slides presenting extras (web only): Rehearse (a clock per slide, a target, then a summary), slide timings,
// a self-running show, live poll and Q&A slides with an audience on their phones, and a follow-along QR code.
// The pure parts: deck-live-model.js (timings, poll slides), audience-core.js (the room's rules), qr.js. The rooms:
// the Mac's server (src/chat/audience.ts, with a Wi-Fi listener the presenter turns on) and askeden.com
// (JARVIS V1/site/src/eden/audience-room.js, not deployed). `liveFrame` (deck-live-frame.js) runs inside the slide frame (deck-render.js
// injects it in the web editor) and draws results on the slide and targets in the presenter view.
//
// deck.js gives this module its host (`presentHooks`), tells it each slide shown (`presentAt`) and when a
// presentation ends (`presentEnded`). Menus: `playItems()` / `liveItems()` (the shell's Play menu, deck-shell.js).

import { el, toast } from './util.js';
import { t as tx } from './i18n.js';
import { state } from './state.js';
import { postJSON } from './api.js';
import { layoutDeck } from './deck-model.js';
import { rehearsal, rehearsalReport, saveTimings, setTarget, clock, parseClock, showPlan, hasTimings, pollSlide, qaSlide, liveOf, maskRough, LIVE } from './deck-live-model.js';
import { qrSvg } from './qr.js';
import { sealBody, openBody, newKey, audienceLink } from './audience-crypto.js';
import { registerContextMenu } from './deck-shell.js';
import { IN_APP } from './native.js';
import './deck-share.js'; // share links with view / comment / edit, expiry, revoke (File menu; registers itself)

let hooks = null;
/** deck.js: { frame, stage, present(opts), exit(), deck, commit(deck, opts), conv, at, index, presenting, render } */
export function presentHooks(h) { hooks = h; }

const run = { mode: '', rec: null, hud: null, tick: 0, auto: null, room: null, lastAt: -1, lastIndex: -1 };
const now = () => Date.now();
const post = (m) => { const f = hooks && hooks.frame(); if (f && f.contentWindow) f.contentWindow.postMessage(m, '*'); };
const hosted = () => !!(state.meta && state.meta.hosted);

function cssOnce() {
  if (document.querySelector('link[data-deck-present]')) return;
  document.head.append(el('link', { rel: 'stylesheet', href: new URL('./deck-present.css', import.meta.url).href, 'data-deck-present': '' }));
}
/** A modal card (the shell's sheet look, without needing the shell). */
function sheet(title, content, actions = [], { onClose } = {}) {
  cssOnce();
  const ret = document.activeElement;
  const d = el('dialog', { class: 'dpr-sheet', 'aria-label': title });
  const close = () => { if (d.open) d.close(); };
  d.append(el('header', { class: 'dpr-sheet-head' }, el('h2', '', title), el('button', { type: 'button', class: 'dpr-x', 'aria-label': tx('Close'), onclick: close }, '✕')),
    el('div', { class: 'dpr-sheet-body' }, content), actions.length ? el('footer', { class: 'dpr-sheet-foot' }, ...actions) : null);
  d.addEventListener('close', () => { d.remove(); if (ret && ret.isConnected && ret.focus) ret.focus(); if (onClose) onClose(); });
  d.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.stopPropagation(); });
  (document.fullscreenElement || document.body).append(d);
  d.showModal();
  return { dialog: d, close };
}
const btn = (label, onclick, cls = 'dpr-btn', extra = {}) => el('button', { type: 'button', class: cls, onclick, ...extra }, label);

// ── what the frame tells us: the slide on screen ──

/** deck.js: the frame shows layout row k (deck slide `index`). */
export function presentAt(k, index) {
  run.lastAt = k; run.lastIndex = index;
  if (run.wantStart) { if (k === 0) run.wantStart = false; else { post({ type: 'deck-go', k: 0 }); return; } }
  if (run.rec) run.rec.at(index, now());
  if (run.mode === 'auto' && run.auto && k !== run.auto.k) scheduleAuto(k); // a new slide (the same one again is a mode switch)
  if (run.room) run.room.show(k, index);
}
/** deck.js: the frame (re)loaded: it needs the targets and what's live again. */
export function presentFrameReady() { if (run.wantStart) post({ type: 'deck-go', k: 0 }); sendTargets(); if (run.room && run.room.cur) drawLive(); }
/** deck.js: the presentation ended (Exit, Escape, leaving full screen). */
export function presentEnded() {
  stopAuto();
  if (run.mode === 'rehearse') finishRehearsal();
  run.mode = '';
  removeHud();
  if (run.room) run.room.ended();
}

function removeHud() { clearInterval(run.tick); run.tick = 0; if (run.hud) run.hud.remove(); run.hud = null; }
function stageHud(node) {
  cssOnce();
  removeHud();
  const stage = hooks.stage();
  if (!stage) return;
  run.hud = node;
  stage.append(node);
}

// ── Rehearse ──

export function startRehearsal() {
  const deck = hooks && hooks.deck();
  if (!deck || hooks.presenting()) return;
  run.rec = rehearsal(deck.slides.length, now());
  run.mode = 'rehearse';
  const total = el('span', { class: 'dpr-big', 'aria-label': tx('Total time') }, '0:00');
  const slide = el('span', { class: 'dpr-slide' });
  const bar = el('span', { class: 'dpr-meter-fill' });
  const pause = btn(tx('Pause'), () => {
    if (!run.rec) return;
    if (run.rec.paused) { run.rec.resume(now()); pause.textContent = tx('Pause'); } else { run.rec.pause(now()); pause.textContent = tx('Resume'); }
    hud.classList.toggle('paused', run.rec.paused);
  });
  const hud = el('div', { class: 'dpr-hud', role: 'timer', 'aria-label': tx('Rehearsal clock') },
    el('span', { class: 'dpr-kicker' }, tx('Rehearsing')), total, slide, el('span', { class: 'dpr-meter', 'aria-hidden': 'true' }, bar),
    pause, btn(tx('Finish'), () => hooks.exit(), 'dpr-btn primary'));
  stageHud(hud);
  const draw = () => {
    if (!run.rec) return;
    const d = hooks.deck();
    const r = run.rec.read(now());
    total.textContent = clock(r.total);
    const i = run.rec.index;
    const target = d && d.slides[i] ? d.slides[i].target || 0 : 0;
    slide.textContent = i >= 0 ? `${tx('Slide')} ${i + 1} · ${clock(r.slide)}${target ? ` / ${clock(target)}` : ''}` : '';
    bar.style.width = target ? `${Math.min(100, (r.slide / target) * 100)}%` : '0';
    hud.classList.toggle('over', target > 0 && r.slide > target);
  };
  run.tick = setInterval(draw, 250);
  draw();
  fromStart();
}
/** Go to slide 1, then present (a rehearsal and a show start at the beginning). */
function fromStart(then) {
  run.wantStart = true; // presentAt / presentFrameReady send the frame to slide 1 once it presents (after a reload's own deck-go)
  setTimeout(() => { run.wantStart = false; }, 4000);
  hooks.present({});
  if (then) then();
}

function finishRehearsal() {
  const rec = run.rec;
  run.rec = null;
  if (!rec) return;
  const took = rec.stop(now());
  const deck = hooks.deck();
  if (!deck || !took.some((t) => t > 0)) return;
  setTimeout(() => timingsSheet({ took }), 60); // after full screen has let go
}

/** The rehearsal summary (with `took`) or the targets alone: one row per slide, targets editable. */
export function timingsSheet({ took = null } = {}) {
  const deck = hooks && hooks.deck();
  if (!deck) return;
  const rep = took ? rehearsalReport(deck, took) : null;
  const targets = deck.slides.map((s) => s.target || 0);
  const rows = deck.slides.map((s, i) => {
    const r = rep ? rep.rows[i] : null;
    const input = el('input', { type: 'text', inputmode: 'numeric', class: 'dpr-time', value: targets[i] ? clock(targets[i]) : '', placeholder: '–:––', 'aria-label': `${tx('Target for slide')} ${i + 1}`, 'data-i': i });
    input.addEventListener('change', () => { const v = parseClock(input.value); targets[i] = v; input.value = v ? clock(v) : ''; input.classList.toggle('bad', !!input.value.trim() && !v); });
    return el('tr', { class: r && r.over ? 'over' : '' },
      el('th', { scope: 'row' }, `${i + 1}`), el('td', { class: 'dpr-t' }, (s.title || `${tx('Slide')} ${i + 1}`).slice(0, 80)),
      rep ? el('td', { class: 'dpr-n' }, r.took ? clock(r.took) : '—') : null,
      el('td', {}, input),
      rep ? el('td', { class: 'dpr-flag' }, r.over ? tx('over') : r.took === 0 ? tx('skipped') : '') : el('td', { class: 'dpr-n' }, s.took ? clock(s.took) : ''));
  });
  const head = el('tr', {}, el('th', { scope: 'col' }, '#'), el('th', { scope: 'col' }, tx('Slide')), rep ? el('th', { scope: 'col' }, tx('Took')) : null, el('th', { scope: 'col' }, tx('Target')), el('th', { scope: 'col' }, rep ? '' : tx('Last rehearsal')));
  const sumLine = rep ? `${tx('Total')} ${clock(rep.total)}${rep.targetTotal ? ` · ${tx('target')} ${clock(rep.targetTotal)}` : ''}${rep.over.length ? ` · ${rep.over.length} ${rep.over.length === 1 ? tx('slide over its target') : tx('slides over their target')}` : ''}` : tx('Set how long you mean to spend on each slide (1:30, 90s, 2m). Rehearse shows them as you go; the presenter view shows them too.');
  const said = rep ? [...rep.rows.filter((r) => r.over), ...rep.rows.filter((r) => !r.over && r.took > 0)] : []; // over their target first
  const summary = said.length ? el('ul', { class: 'dpr-lines' }, said.slice(0, 8).map((r) => el('li', { class: r.over ? 'over' : '' }, `${tx('Slide')} ${r.i + 1} ${tx('took')} ${clock(r.took)}${r.target ? `, ${tx('target')} ${clock(r.target)}` : ''}`))) : null;
  const content = el('div', { class: 'dpr-timings' }, el('p', { class: 'dpr-sum', role: 'status' }, sumLine), summary,
    el('div', { class: 'dpr-scroll' }, el('table', { class: 'dpr-table' }, el('thead', '', head), el('tbody', '', rows))));
  const apply = (base) => { let d = base; targets.forEach((t, i) => { if ((d.slides[i].target || 0) !== t) d = setTarget(d, i, t); }); return d; };
  const actions = rep
    ? [btn(tx('Discard'), () => s.close()), btn(tx('Use as targets'), () => { hooks.commit(saveTimings(apply(hooks.deck()), took, now(), { asTargets: true }), { toastText: tx('Timings saved as targets') }); s.close(); }),
      btn(tx('Save timings'), () => { hooks.commit(saveTimings(apply(hooks.deck()), took, now()), { toastText: tx('Rehearsal timings saved') }); s.close(); }, 'dpr-btn primary')]
    : [btn(tx('Cancel'), () => s.close()), btn(tx('Save targets'), () => { const d = apply(hooks.deck()); if (d !== hooks.deck()) hooks.commit(d, { toastText: tx('Slide targets saved') }); s.close(); }, 'dpr-btn primary')];
  const s = sheet(rep ? tx('Rehearsal') : tx('Slide timings'), content, actions);
  // the presenter view's targets follow the saved deck (sent when the frame loads, again here)
  sendTargets();
}

/** The presenter view's targets: { [deck slide index]: seconds }. */
export function sendTargets() {
  const d = hooks && hooks.deck();
  if (!d) return;
  const targets = {};
  d.slides.forEach((s, i) => { if (s.target) targets[i] = s.target; });
  post({ type: 'deck-targets', targets });
}

// ── a self-running show ──

export function playShow({ loop = false } = {}) {
  const deck = hooks && hooks.deck();
  if (!deck || hooks.presenting()) return;
  run.auto = { loop, plan: showPlan(deck, layoutDeck(deck)), t: 0, k: -1 };
  run.mode = 'auto';
  const left = el('span', { class: 'dpr-slide', 'aria-live': 'off' });
  const pauseB = btn(tx('Pause'), () => {
    const a = run.auto;
    if (!a) return;
    a.paused = !a.paused;
    pauseB.textContent = a.paused ? tx('Resume') : tx('Pause');
    if (a.paused) clearTimeout(a.t); else scheduleAuto(run.lastAt); // the slide's time again
  });
  stageHud(el('div', { class: 'dpr-hud quiet' }, el('span', { class: 'dpr-kicker' }, loop ? tx('Self-running · loops') : tx('Self-running')), left, pauseB));
  run.tick = setInterval(() => { const a = run.auto; if (a && a.until && !a.paused) left.textContent = `${tx('Next in')} ${Math.max(0, Math.ceil((a.until - now()) / 1000))} s`; }, 250);
  fromStart();
  if (!hasTimings(deck)) toast(tx('No timings yet: each slide shows for 8 seconds. Rehearse to set them.'));
  setTimeout(() => scheduleAuto(0), 600);
}
function scheduleAuto(k, { step = false } = {}) {
  const a = run.auto;
  if (!a || a.paused) return;
  clearTimeout(a.t);
  a.k = k;
  const secs = step ? 1.5 : a.plan[k] ?? 8; // after a build step the next piece comes sooner
  a.until = now() + secs * 1000;
  a.t = setTimeout(() => {
    if (run.mode !== 'auto') return;
    if (k >= a.plan.length - 1) { if (a.loop) post({ type: 'deck-go', k: 0 }); else { a.until = 0; hooks.exit(); } return; }
    post({ type: 'deck-go', k: k + 1 });
    setTimeout(() => { if (run.mode === 'auto' && run.lastAt === k) scheduleAuto(k, { step: true }); }, 300); // a build step: the frame stays on k
  }, secs * 1000);
}
function stopAuto() { if (run.auto) clearTimeout(run.auto.t); run.auto = null; }

// ── poll and Q&A slides ──

export function insertPollSheet() {
  const deck = hooks && hooks.deck();
  if (!deck) return;
  const q = el('input', { type: 'text', maxlength: String(LIVE.question), class: 'dpr-field', id: 'dprPollQ', required: true });
  const optsBox = el('div', { class: 'dpr-opts' });
  const addOpt = (v = '') => {
    if (optsBox.children.length >= LIVE.maxOptions) return;
    const n = optsBox.children.length + 1;
    const input = el('input', { type: 'text', maxlength: String(LIVE.option), class: 'dpr-field', value: v, 'aria-label': `${tx('Option')} ${n}` });
    optsBox.append(input);
    more.disabled = optsBox.children.length >= LIVE.maxOptions;
  };
  const more = btn(tx('Add an option'), () => { addOpt(); optsBox.lastChild.focus(); });
  ['', '', ''].forEach((v) => addOpt(v));
  const msg = el('p', { class: 'dpr-note', role: 'status' }, tx('2 to 6 options. While you present, phones vote and the results grow on the slide.'));
  const content = el('div', { class: 'dpr-form' }, el('label', { for: 'dprPollQ' }, tx('Question')), q, el('p', { class: 'dpr-label' }, tx('Options')), optsBox, more, msg);
  const s = sheet(tx('Poll slide'), content, [btn(tx('Cancel'), () => s.close()), btn(tx('Add poll'), () => {
    const slide = pollSlide(q.value, [...optsBox.querySelectorAll('input')].map((i) => i.value));
    if (!slide) { msg.textContent = tx('Write a question and at least 2 options.'); (q.value.trim() ? optsBox.querySelector('input') : q).focus(); return; }
    insertAfterCurrent(slide, tx('Poll slide added'));
    s.close();
  }, 'dpr-btn primary')]);
  q.focus();
}
export function insertQaSlide() { insertAfterCurrent(qaSlide(tx('Questions?')), tx('Q&A slide added')); }
function insertAfterCurrent(slide, toastText) {
  const d = hooks.deck();
  if (!d) return;
  const i = Math.max(0, Math.min(d.slides.length - 1, hooks.index() >= 0 ? hooks.index() : d.slides.length - 1));
  const next = JSON.parse(JSON.stringify(d));
  next.slides.splice(i + 1, 0, slide);
  hooks.commit(next, { toastText });
}

// ── the audience room (presenter side) ──

/** The presenter's side of a room: { id, owner, key, links, show(k, index), ended(), end() }. */
async function openRoom() {
  const made = await postJSON('/api/chat/audience', {});
  const key = hosted() && globalThis.crypto && globalThis.crypto.subtle ? newKey() : '';
  let origin = location.origin, local = false;
  if (!hosted()) {
    try { const lan = await postJSON('/api/chat/audience/lan', { on: true }); if (lan.urls && lan.urls[0]) origin = lan.urls[0]; else local = true; } catch (e) { local = true; toast(e.message || tx('Phones can’t join over Wi-Fi')); }
  }
  const base = `/a/${made.id}`;
  const room = {
    id: made.id, key, origin, local, view: null, deckV: 0, closed: false, safe: true, panel: null, badge: null, followOn: false,
    links: { join: audienceLink(origin, made.id, key), follow: audienceLink(origin, made.id, key, { follow: true }) },
    async control(m) {
      const r = await fetch(`${base}/control`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-room-owner': made.owner }, body: JSON.stringify(m), credentials: 'same-origin' });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || tx('The audience room didn’t answer'));
      return out;
    },
    async show(k, index) {
      if (room.closed) return;
      const d = hooks.deck();
      const lv = d && index >= 0 ? liveOf(d.slides[index]) : null;
      let live = null;
      if (lv && lv.kind === 'poll') live = { kind: 'poll', id: lv.id, n: lv.options.length, body: await sealBody({ q: lv.question, o: lv.options }, key, 'poll') };
      else if (lv) live = { kind: 'qa', id: lv.id, body: await sealBody({ q: lv.question }, key, 'qa') };
      const total = d ? layoutDeck(d).length : 0;
      room.cur = { k, lv };
      room.control({ t: 'show', k, total, live }).catch(() => {});
      drawLive();
    },
    ended() { room.openWhilePresenting = false; drawPanel(); },
    async end() {
      room.closed = true;
      room.abort.abort();
      try { await room.control({ t: 'close' }); } catch { /* gone already */ }
      if (run.room === room) run.room = null;
      if (room.panel) room.panel.remove();
      if (room.badge) room.badge.remove();
      post({ type: 'deck-live', k: -1 });
      if (!hosted()) postJSON('/api/chat/audience/lan', { on: false }).catch(() => {});
    },
    abort: new AbortController(),
    owner: made.owner,
  };
  // the room's view, as it changes
  (async () => {
    let wait = 1000;
    while (!room.closed) {
      try {
        const r = await fetch(`${base}/events`, { headers: { 'x-room-owner': made.owner }, signal: room.abort.signal, cache: 'no-store' });
        if (r.status === 404) { room.closed = true; break; }
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        wait = 1000;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
            if (data && /^event: view$/m.test(chunk)) { try { room.view = JSON.parse(data); drawLive(); drawPanel(); } catch { /* skip */ } }
          }
        }
      } catch { if (room.closed) break; }
      await new Promise((res) => setTimeout(res, wait));
      wait = Math.min(15000, wait * 2);
    }
  })();
  addEventListener('pagehide', () => { if (!room.closed) fetch(`${base}/control`, { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json', 'x-room-owner': made.owner }, body: '{"t":"close"}' }).catch(() => {}); });
  return room;
}

/** The follow-along slides: one small static document per layout row (no scripts), sealed when there is a key. */
async function uploadDeck(room) {
  const deck = hooks.deck();
  const c = hooks.conv();
  if (!deck || !c) return;
  const { deckDocument } = await hooks.render();
  const build = (images) => {
    const html = deckDocument(deck, { mode: 'static', images, label: '' });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const head = doc.head.innerHTML;
    const cls = doc.body.className;
    const extra = '<style>html,body{margin:0;padding:0;background:#000;overflow:hidden}body>.slide{margin:0!important;box-shadow:none!important;page-break-after:auto}</style>';
    return [...doc.body.querySelectorAll('.slide')].map((sec, k) => ({ k, label: (sec.getAttribute('aria-label') || '').slice(0, 200), doc: `<!doctype html><html><head>${head}${extra}</head><body class="${cls}">${sec.outerHTML}</body></html>` }));
  };
  let slides = build(c.deckImages || {});
  let body = await sealBody({ title: deck.title, slides }, room.key, 'deck');
  if (body.length > 2_900_000) { slides = build({}); body = await sealBody({ title: deck.title, slides, noPictures: true }, room.key, 'deck'); toast(tx('The follow-along copy leaves out pictures to fit')); }
  if (body.length > 2_900_000) { toast(tx('These slides are too big to follow along on phones')); return; }
  await room.control({ t: 'deck', body });
}

export async function startAudience({ follow = false } = {}) {
  if (!hooks) return;
  try {
    if (!run.room || run.room.closed) {
      run.room = await openRoom();
      uploadDeck(run.room).catch(() => toast(tx('Couldn’t send the slides for following along')));
      if (run.lastAt >= 0) run.room.show(run.lastAt, run.lastIndex);
    }
    run.room.followOn = run.room.followOn || follow;
    drawPanel({ open: true });
    if (run.room.local) toast(tx('Only this Mac can open the link: phones on Wi-Fi couldn’t be let in'));
  } catch (e) {
    toast(e.message || tx('Couldn’t open the audience room'));
  }
}
export const audienceOn = () => !!(run.room && !run.room.closed);
export async function endAudience() { if (run.room) await run.room.end(); toast(tx('The audience room is closed')); }

/** What the frame draws on the slide on screen: results, questions, the join code. */
async function drawLive() {
  const room = run.room;
  if (!room || !room.cur) return;
  const { k, lv } = room.cur;
  const v = room.view;
  const join = { svg: qrSvg(room.links.join, { label: tx('QR code to join on your phone') }), url: room.links.join.replace(/^https?:\/\//, '').replace(/#.*$/, '') };
  if (!lv) { post({ type: 'deck-live', k, kind: '', join: room.followOn ? { ...join, svg: qrSvg(room.links.follow, { label: tx('QR code to follow along') }), follow: true } : null }); return; }
  const live = v && v.live && v.live.id === lv.id ? v.live : null;
  if (lv.kind === 'poll') {
    post({ type: 'deck-live', k, kind: 'poll', counts: live ? live.counts : lv.options.map(() => 0), votes: live ? live.votes : 0, locked: !!(live && live.locked), join, people: v ? v.people : 0 });
    return;
  }
  const qs = [];
  for (const q of (live && live.questions) || []) {
    if (q.hidden) continue;
    const o = await openBody(q.body, room.key, 'question');
    if (o && typeof o.text === 'string') qs.push({ text: room.safe ? maskRough(o.text.slice(0, 280)) : o.text.slice(0, 280), name: q.name ? (room.safe ? maskRough(q.name) : q.name) : '', up: q.up, answered: !!q.answered });
  }
  post({ type: 'deck-live', k, kind: 'qa', questions: qs.slice(0, 5), count: qs.length, join, people: v ? v.people : 0 });
}

/** The presenter's audience panel (on the stage while presenting, else under the toolbar's notice line). */
async function drawPanel({ open = false } = {}) {
  const room = run.room;
  if (!room || room.closed) return;
  cssOnce();
  const v = room.view;
  const stage = hooks.stage();
  if (!stage) return;
  if (!room.panel || !room.panel.isConnected) {
    room.panel = el('details', { class: 'dpr-aud' });
    room.panel.addEventListener('toggle', () => { if (hooks.presenting() && room.panel.open) room.openWhilePresenting = true; });
    stage.append(room.panel);
  }
  const p = room.panel;
  // while presenting it stays a small pill over the slide until the presenter opens it
  const wasOpen = open || (p.open && (!hooks.presenting() || room.openWhilePresenting));
  const people = v ? v.people || 0 : 0;
  const live = v && v.live;
  const sum = el('summary', { class: 'dpr-aud-sum' }, `${tx('Audience')} · ${people} ${people === 1 ? tx('phone') : tx('phones')}${live && live.kind === 'poll' ? ` · ${live.votes} ${tx('votes')}` : live && live.kind === 'qa' ? ` · ${live.questions.length} ${tx('questions')}` : ''}`);
  const code = el('div', { class: 'dpr-qr' });
  code.innerHTML = qrSvg(room.followOn ? room.links.follow : room.links.join, { label: room.followOn ? tx('QR code to follow along') : tx('QR code to join on your phone') }); // our own SVG (qr.js), no outside text
  const link = room.followOn ? room.links.follow : room.links.join;
  const kids = [
    code,
    el('p', { class: 'dpr-link' }, link.replace(/#.*$/, '')),
    el('div', { class: 'dpr-row' },
      btn(tx('Copy link'), () => { navigator.clipboard.writeText(link).then(() => toast(tx('Link copied')), () => toast(link)); }),
      btn(room.followOn ? tx('Show the voting link') : tx('Show the follow-along link'), () => { room.followOn = !room.followOn; drawPanel({ open: true }); drawLive(); }),
      el('label', { class: 'dpr-check' }, el('input', { type: 'checkbox', checked: room.safe, onchange: (e) => { room.safe = e.target.checked; drawLive(); drawPanel({ open: true }); } }), tx('Hide rough words'))),
  ];
  if (room.local) kids.push(el('p', { class: 'dpr-note' }, tx('Only this Mac can open this link: turn on Wi-Fi sharing by restarting Eden, or check port 5175.')));
  else if (!hosted()) kids.push(el('p', { class: 'dpr-note' }, tx('Phones on the same Wi-Fi as this Mac can join. Nothing goes through askeden.com.')));
  if (live && live.kind === 'poll') {
    kids.push(el('div', { class: 'dpr-row' },
      btn(live.locked ? tx('Reopen voting') : tx('Close voting'), () => room.control({ t: 'lock', poll: live.id, locked: !live.locked }).catch((e) => toast(e.message))),
      btn(tx('Clear votes'), () => { if (confirm(tx('Clear every vote on this poll?'))) room.control({ t: 'reset', poll: live.id }).catch((e) => toast(e.message)); })));
  }
  if (live && live.kind === 'qa') {
    const list = el('ol', { class: 'dpr-qs' });
    for (const q of live.questions) {
      const o = await openBody(q.body, room.key, 'question');
      if (!o || typeof o.text !== 'string') continue;
      const text = room.safe ? maskRough(o.text.slice(0, 280)) : o.text.slice(0, 280);
      list.append(el('li', { class: `${q.hidden ? 'hidden' : ''}${q.answered ? ' answered' : ''}` },
        el('span', { class: 'dpr-q-up' }, `▲ ${q.up}`), el('span', { class: 'dpr-q-t' }, text, q.name ? el('small', '', ` · ${room.safe ? maskRough(q.name) : q.name}`) : null),
        btn(q.answered ? tx('Not answered') : tx('Answered'), () => room.control({ t: 'answered', q: q.id, on: !q.answered }).catch((e) => toast(e.message)), 'dpr-btn small'),
        btn(q.hidden ? tx('Show') : tx('Hide'), () => room.control({ t: 'hide', q: q.id, on: !q.hidden }).catch((e) => toast(e.message)), 'dpr-btn small', { 'aria-label': `${q.hidden ? tx('Show') : tx('Hide')}: ${text.slice(0, 60)}` })));
    }
    kids.push(list.children.length ? list : el('p', { class: 'dpr-note' }, tx('No questions yet.')));
  }
  kids.push(el('div', { class: 'dpr-row' }, btn(tx('End for everyone'), () => endAudience(), 'dpr-btn danger')));
  const focusKey = p.contains(document.activeElement) ? document.activeElement.textContent : '';
  p.replaceChildren(sum, el('div', { class: 'dpr-aud-body' }, ...kids));
  p.open = wasOpen;
  if (focusKey) { const b = [...p.querySelectorAll('button')].find((x) => x.textContent === focusKey); if (b) b.focus(); }
}

// ── menus (deck-shell.js Play menu) ──

export function playItems() {
  return [
    { label: tx('Rehearse'), icon: 'record', run: () => startRehearsal() },
    { label: tx('Play as a self-running show'), icon: 'play', run: () => playShow({ loop: false }) },
    { label: tx('Self-running show, looping'), icon: 'play', run: () => playShow({ loop: true }) },
    { label: tx('Slide timings…'), icon: 'notes', run: () => timingsSheet() },
  ];
}
export function liveItems() {
  return [
    { label: tx('Add a poll slide…'), icon: 'chart', run: () => insertPollSheet() },
    { label: tx('Add a Q&A slide'), icon: 'comment', run: () => insertQaSlide() },
    audienceOn() ? { label: tx('Audience room…'), icon: 'collaborate', run: () => drawPanel({ open: true }) } : { label: tx('Open to phones (polls, Q&A)'), icon: 'collaborate', run: () => startAudience() },
    { label: tx('Follow along on phones (QR)'), icon: 'globe', run: () => startAudience({ follow: true }) },
    audienceOn() ? { label: tx('End the audience room'), icon: 'close', danger: true, run: () => endAudience() } : null,
  ].filter(Boolean);
}

if (!IN_APP) {
  registerContextMenu({ id: 'rehearse', target: 'play', order: 10, items: () => playItems() });
  registerContextMenu({ id: 'audience', target: 'play', order: 20, items: () => liveItems() });
}
