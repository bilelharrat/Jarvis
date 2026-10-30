// Live presence in the slide editor (web only): who else has this deck open, on which slide, what they are editing,
// and their pointer. Tabs of this browser talk over a BroadcastChannel; other devices over a deck room (deck-room.js,
// behind a flag). No DOM here except `frameScript`, which runs inside the sandboxed slide frame (deck-render.js), so
// the tests can drive a Presence over a fake channel.
//
// A message: { v: 1, type: 'here', deck, id, name, color, index, k, path, x, y, at } (index: the deck slide; k: the
// drawn slide; path: the piece being edited; x, y: the pointer on the slide, 0–1280 × 0–720, or null) or
// { v: 1, type: 'bye', deck, id }. Anything else, or for another deck, is ignored.

export const COLORS = ['#e5484d', '#2f6df6', '#17a673', '#f5a524', '#8e4ec6', '#0d9488', '#d6409f', '#c2410c'];
export const BEAT_MS = 2000; // a tab says it's here this often
export const GONE_MS = 6500; // and is gone when it hasn't for this long
const hash = (s) => [...String(s)].reduce((h, ch) => (Math.imul(h, 31) + ch.codePointAt(0)) | 0, 7);
export const colorFor = (id) => COLORS[Math.abs(hash(id)) % COLORS.length];
const okId = (v) => typeof v === 'string' && /^[A-Za-z0-9_:-]{1,80}$/.test(v);
const int = (v, max) => (Number.isInteger(v) && v >= 0 && v < max ? v : -1);
const coord = (v, max) => (Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : null);
const name = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) : '');

/** A peer's message, checked, or null. */
export function cleanPeer(m, deck) {
  if (!m || typeof m !== 'object' || m.v !== 1 || m.deck !== deck || !okId(m.id)) return null;
  if (m.type === 'bye') return { type: 'bye', id: m.id };
  if (m.type !== 'here') return null;
  const path = typeof m.path === 'string' && m.path.length <= 40 && /^[A-Za-z][A-Za-z0-9.]*$/.test(m.path) ? m.path : '';
  const color = typeof m.color === 'string' && COLORS.includes(m.color) ? m.color : colorFor(m.id);
  return { type: 'here', id: m.id, name: name(m.name) || 'Someone', color, index: int(m.index, 1000), k: int(m.k, 2000), path, x: coord(m.x, 1280), y: coord(m.y, 720) };
}

/**
 * Presence for one deck over `channel` ({ postMessage, addEventListener('message') } like a BroadcastChannel, or a deck
 * room). `me` { id, name, color? }. `onChange(peers)` after anyone arrives, moves or leaves. `now` and the timers can be
 * replaced (tests).
 */
export class Presence {
  constructor({ channel, deck, me, onChange = () => {}, now = () => Date.now(), timers = globalThis }) {
    this.channel = channel; this.deck = deck; this.onChange = onChange; this.now = now; this.timers = timers;
    this.me = { id: me.id, name: name(me.name) || 'Someone', color: me.color || colorFor(me.id) };
    this.state = { index: -1, k: -1, path: '', x: null, y: null };
    this.peers = new Map(); // id → peer with `seen`
    this.listener = (e) => this.receive(e && 'data' in e ? e.data : e);
    channel.addEventListener('message', this.listener);
    this.beat = timers.setInterval(() => { this.send(); this.sweep(); }, BEAT_MS);
    this.send();
  }
  /** What this tab is doing now (any of index, k, path, x, y); sent at once. */
  set(next) { Object.assign(this.state, next); this.send(); }
  rename(n) { this.me.name = name(n) || this.me.name; this.send(); }
  send() { if (this.closed) return; try { this.channel.postMessage({ v: 1, type: 'here', deck: this.deck, ...this.me, ...this.state, at: this.now() }); } catch { /* channel closed */ } }
  receive(m) {
    if (this.closed) return;
    const p = cleanPeer(m, this.deck);
    if (!p || p.id === this.me.id) return;
    if (p.type === 'bye') { if (this.peers.delete(p.id)) this.onChange(this.list()); return; }
    const isNew = !this.peers.has(p.id);
    this.peers.set(p.id, { ...p, seen: this.now() });
    if (isNew) this.send(); // a newcomer learns about this tab at once, not at the next beat
    this.onChange(this.list());
  }
  sweep() {
    const t = this.now();
    let gone = false;
    for (const [id, p] of this.peers) if (t - p.seen > GONE_MS) { this.peers.delete(id); gone = true; }
    if (gone) this.onChange(this.list());
  }
  /** The others here, by name. */
  list() { return [...this.peers.values()].map(({ seen, type, ...p }) => p).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)); }
  close() {
    if (this.closed) return;
    try { this.channel.postMessage({ v: 1, type: 'bye', deck: this.deck, id: this.me.id }); } catch { /* closed */ }
    this.closed = true;
    this.timers.clearInterval(this.beat);
    this.channel.removeEventListener('message', this.listener);
  }
}

/** One line for a peer: "Sam is editing slide 3" / "Sam · slide 3". */
export function peerLine(p, { you = '' } = {}) {
  const who = you && p.name === you ? `${p.name} (another tab)` : p.name;
  if (p.index < 0) return `${who} is here`;
  return p.path ? `${who} is editing slide ${p.index + 1}` : `${who} · slide ${p.index + 1}`;
}

/* Inside the slide frame (stringified into deck-render.js's document for the web editor only). The page sends
   { type: 'deck-collab', counts, pins, peers, pick }; the frame sends 'deck-pointer', 'deck-focus' and 'deck-pick'.
   It only draws: badges on thumbnails, coloured outlines and names on what others edit, their pointers. */
export function frameScript() {
  'use strict';
  if (window.parent === window) return;
  const post = (m) => window.parent.postMessage(m, '*');
  let last = { counts: {}, pins: [], peers: [], pick: false };
  const css = document.createElement('style');
  css.textContent = `.cc-badge{position:absolute;right:4px;top:3px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#f5a524;color:#1a1a1a;font:700 11px -apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;z-index:2;pointer-events:none}
.cc-peers{position:absolute;left:4px;top:3px;display:flex;gap:2px;z-index:2;pointer-events:none}.cc-peers i{width:16px;height:16px;border-radius:50%;font:700 9px/16px -apple-system,system-ui,sans-serif;color:#fff;text-align:center;font-style:normal;box-shadow:0 0 0 1.5px #fff}
.cc-edit{outline:3px solid var(--cc)!important;outline-offset:3px}.cc-tag{position:absolute;z-index:30;pointer-events:none;font:600 13px -apple-system,system-ui,sans-serif;color:#fff;padding:2px 7px;border-radius:6px 6px 6px 0;white-space:nowrap}
.cc-cursor{position:absolute;z-index:31;pointer-events:none;transition:left .08s linear,top .08s linear}.cc-cursor svg{display:block;width:26px;height:26px}.cc-cursor span{position:absolute;left:20px;top:20px;font:600 14px -apple-system,system-ui,sans-serif;color:#fff;padding:2px 7px;border-radius:6px;white-space:nowrap}
.cc-pin{position:absolute;z-index:29;pointer-events:none;min-width:26px;height:26px;border-radius:13px 13px 13px 2px;background:#f5a524;color:#1a1a1a;font:700 14px/26px -apple-system,system-ui,sans-serif;text-align:center;padding:0 6px}
#frame .cc-tag,#frame .cc-cursor,#frame .cc-pin{transform-origin:0 0}#frame .cc-tag{transform:scale(calc(1 / var(--s,1))) translateY(-100%)}#frame .cc-cursor{transform:scale(calc(1 / var(--s,1)))}#frame .cc-pin{transform:scale(calc(1 / var(--s,1))) translate(-100%,0)}
body.cc-picking #frame [data-path],body.cc-picking #frame .slide.cur{cursor:crosshair}body.cc-picking #frame [data-path]:hover{box-shadow:0 0 0 3px #f5a524!important}`;
  document.head.append(css);
  const slides = () => [...document.querySelectorAll('#frame > .slide')];
  const cur = () => document.querySelector('#frame > .slide.cur');
  const initials = (n) => String(n || '?').split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase();
  const mk = (tag, cls, style = {}) => { const e = document.createElement(tag); e.className = cls; Object.assign(e.style, style); return e; };
  // where a piece sits in its slide, in slide units (the slide is scaled as a whole)
  const box = (sl, t) => { const s = sl.getBoundingClientRect(), r = t.getBoundingClientRect(), f = 1280 / (s.width || 1280); return { x: (r.left - s.left) * f, y: (r.top - s.top) * f, w: r.width * f, h: r.height * f }; };
  function draw() {
    document.querySelectorAll('.cc-badge,.cc-peers,.cc-tag,.cc-cursor,.cc-pin').forEach((e) => e.remove());
    document.querySelectorAll('.cc-edit').forEach((e) => { e.classList.remove('cc-edit'); e.style.removeProperty('--cc'); });
    if (!document.body.classList.contains('mode-edit')) return; // presenting: nothing of this on the slides
    const all = slides();
    document.querySelectorAll('#strip .thumb').forEach((t) => {
      const sl = all[Number(t.dataset.k)];
      if (!sl || sl.dataset.part !== '1') return;
      const i = Number(sl.dataset.index);
      const n = last.counts[i];
      if (n) { const b = mk('span', 'cc-badge'); b.textContent = String(n); b.title = `${n} open comment${n === 1 ? '' : 's'}`; t.append(b); t.setAttribute('aria-label', `${sl.getAttribute('aria-label')}, ${b.title}`); }
      const here = last.peers.filter((p) => p.index === i);
      if (here.length) { const w = mk('span', 'cc-peers'); for (const p of here.slice(0, 3)) { const d = mk('i', '', { background: p.color }); d.textContent = initials(p.name); w.append(d); } t.append(w); }
    });
    const sl = cur();
    if (!sl) return;
    const k = all.indexOf(sl);
    const idx = Number(sl.dataset.index);
    for (const pin of last.pins) {
      if (pin.index !== idx) continue;
      const t = [...sl.querySelectorAll('[data-path]')].find((e) => e.dataset.path === pin.path);
      if (!t) continue;
      const b = box(sl, t);
      const p = mk('span', 'cc-pin', { left: `${Math.min(1270, b.x + b.w)}px`, top: `${Math.max(0, b.y)}px` }); // (drawn at screen size: the CSS undoes the slide's scale)
      p.textContent = `💬${pin.n > 1 ? pin.n : ''}`;
      sl.append(p);
    }
    for (const p of last.peers) {
      if (p.index === idx && p.path) {
        const t = [...sl.querySelectorAll('[data-path]')].find((e) => e.dataset.path === p.path);
        if (t) {
          t.classList.add('cc-edit'); t.style.setProperty('--cc', p.color);
          const b = box(sl, t);
          const tag = mk('span', 'cc-tag', { background: p.color, left: `${b.x}px`, top: `${b.y}px` });
          tag.textContent = `${p.name} is editing`;
          sl.append(tag);
        }
      }
      if (p.k === k && p.x !== null && p.y !== null) {
        const c = mk('div', 'cc-cursor', { left: `${p.x}px`, top: `${p.y}px` });
        c.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 2l7 19 2.6-8.1L21 10z" fill="${p.color}" stroke="#fff" stroke-width="1.5"/></svg>`;
        const tag = mk('span', '', { background: p.color }); tag.textContent = p.name; c.append(tag);
        sl.append(c);
      }
    }
  }
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || !e.data || e.data.type !== 'deck-collab') return;
    const m = e.data;
    last = { counts: m.counts && typeof m.counts === 'object' ? m.counts : {}, pins: Array.isArray(m.pins) ? m.pins : [], peers: Array.isArray(m.peers) ? m.peers.filter((p) => p && /^#[0-9a-f]{6}$/i.test(p.color)) : [], pick: m.pick === true };
    document.body.classList.toggle('cc-picking', last.pick);
    draw();
  });
  const strip = document.getElementById('strip');
  if (strip) new MutationObserver(() => { if (!strip.querySelector('.cc-badge,.cc-peers') && (Object.keys(last.counts).length || last.peers.length)) draw(); }).observe(strip, { childList: true });
  // the pointer, a few times a second, in slide units
  let sentAt = 0, timer = 0;
  document.addEventListener('pointermove', (e) => {
    const sl = cur();
    if (!sl || !document.body.classList.contains('mode-edit')) return;
    const r = sl.getBoundingClientRect();
    const f = 1280 / (r.width || 1280);
    const x = (e.clientX - r.left) * f, y = (e.clientY - r.top) * f;
    const inside = x >= 0 && y >= 0 && x <= 1280 && y <= 720;
    const send = () => { sentAt = Date.now(); post({ type: 'deck-pointer', k: slides().indexOf(sl), index: Number(sl.dataset.index), x: inside ? Math.round(x) : null, y: inside ? Math.round(y) : null }); };
    clearTimeout(timer);
    if (Date.now() - sentAt > 90) send(); else timer = setTimeout(send, 90);
  }, { passive: true });
  document.addEventListener('pointerleave', () => post({ type: 'deck-pointer', x: null, y: null }));
  // what's being edited (deck-render.js makes a piece editable on click and leaves it on blur)
  document.addEventListener('focusin', (e) => { const t = e.target.closest && e.target.closest('[data-path]'); if (t) setTimeout(() => { if (t.isContentEditable) post({ type: 'deck-focus', index: Number(t.dataset.index || (t.closest('.slide') || cur()).dataset.index), path: t.dataset.path }); }, 0); });
  document.addEventListener('focusout', (e) => { if (e.target.closest && e.target.closest('[data-path]')) post({ type: 'deck-focus', path: '' }); });
  // choosing what a comment is about: the next click picks a piece (or the slide); Escape gives up
  window.addEventListener('click', (e) => {
    if (!last.pick) return;
    const sl = e.target.closest && e.target.closest('#frame > .slide');
    if (!sl) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const t = e.target.closest('[data-path]');
    last.pick = false; document.body.classList.remove('cc-picking');
    post({ type: 'deck-pick', index: Number(sl.dataset.index), path: t && t.dataset.path !== 'notes' ? t.dataset.path : '' });
  }, true);
  window.addEventListener('keydown', (e) => { if (last.pick && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); last.pick = false; document.body.classList.remove('cc-picking'); post({ type: 'deck-pick', cancel: true }); } }, true);
}
