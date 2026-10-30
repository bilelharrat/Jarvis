// Inside the Eden Slides frame (web editor only; deck-render.js stringifies `liveFrame` into the frame, so it imports
// nothing): poll results, questions and the join code drawn on the live slide on screen, and the slide's target beside
// the presenter view's timer. The page (deck-present.js) sends `deck-live` and `deck-targets`; text arrives as text.

/* eslint-disable */
export function liveFrame() {
  'use strict';
  const st = document.createElement('style');
  st.textContent = `.elive-bar{position:absolute;left:0;top:0;bottom:0;background:var(--accent,#0a84ff);opacity:.18;border-radius:12px;transition:width .5s cubic-bezier(.32,.72,0,1);pointer-events:none}
.elive-li{position:relative}.elive-n{margin-left:.6em;font-weight:700;font-variant-numeric:tabular-nums;opacity:.85}
.elive-foot{position:absolute;z-index:30;left:72px;bottom:64px;font-size:20px;opacity:.75}.elive-off{visibility:hidden}
.elive-join{position:absolute;z-index:40;right:40px;bottom:40px;width:168px;padding:10px;background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.25);text-align:center;color:#111;font:600 13px/1.3 -apple-system,system-ui,sans-serif}
.elive-join svg{display:block;width:148px;height:148px}.elive-join span{display:block;margin-top:6px;overflow-wrap:anywhere}
.elive-qa{position:absolute;z-index:30;left:72px;right:250px;top:250px;display:grid;gap:12px}
.elive-q{display:flex;gap:16px;align-items:baseline;font-size:26px;line-height:1.3;background:rgba(127,127,127,.12);border-radius:14px;padding:12px 18px}
.elive-q b{min-width:56px;font-variant-numeric:tabular-nums}.elive-q.answered{opacity:.5}.elive-q small{opacity:.7;font-size:18px;margin-left:8px}
.elive-tgt{font-size:15px;font-variant-numeric:tabular-nums}.elive-tgt.over{color:#ff453a;font-weight:700}
@media (prefers-reduced-motion:reduce){.elive-bar{transition:none}}`;
  document.head.append(st);
  const slideAt = (k) => document.querySelector(`#frame > .slide[data-k="${k}"]`);
  const clear = () => { document.querySelectorAll('.elive-off').forEach((n) => n.classList.remove('elive-off')); document.querySelectorAll('.elive').forEach((n) => { if (n.classList.contains('elive-li')) { n.classList.remove('elive', 'elive-li'); n.querySelectorAll('.elive-bar,.elive-n').forEach((x) => x.remove()); } else n.remove(); }); };
  const mk = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  function join(sl, j) {
    if (!j || typeof j.svg !== 'string' || !/^<svg [^<]*><rect [^<]*\/><path d="[Mhvz0-9 -]*" fill="[^"<]*"\/><\/svg>$/.test(j.svg)) return; // only qr.js's own drawing
    const box = mk('div', 'elive elive-join');
    box.innerHTML = j.svg;
    box.append(mk('span', '', String(j.url || '').slice(0, 80)));
    box.setAttribute('aria-hidden', 'true');
    sl.append(box);
  }
  function draw(m) {
    clear();
    const sl = slideAt(m.k);
    if (!sl) return;
    if (m.kind === 'poll') {
      const items = [...sl.querySelectorAll('.bl > li')];
      const counts = Array.isArray(m.counts) ? m.counts : [];
      const total = Number(m.votes) || 0;
      items.forEach((li, i) => {
        const n = Number(counts[i]) || 0, pct = total ? Math.round((n / total) * 100) : 0;
        li.classList.add('elive', 'elive-li');
        const bar = mk('span', 'elive-bar'); bar.style.width = `${pct}%`; bar.setAttribute('aria-hidden', 'true');
        li.prepend(bar);
        li.append(mk('span', 'elive-n', `${pct}%`));
      });
      sl.append(mk('div', 'elive elive-foot', `${total} vote${total === 1 ? '' : 's'}${m.locked ? ' · voting closed' : ''}`));
      join(sl, m.join);
    } else if (m.kind === 'qa') {
      const box = mk('div', 'elive elive-qa');
      for (const q of (m.questions || []).slice(0, 5)) {
        const row = mk('div', `elive-q${q.answered ? ' answered' : ''}`);
        row.append(mk('b', '', `▲ ${Number(q.up) || 0}`), mk('span', '', String(q.text || '').slice(0, 280)));
        if (q.name) row.lastChild.append(mk('small', '', String(q.name).slice(0, 40)));
        box.append(row);
      }
      if (box.children.length) { sl.querySelectorAll('.bl').forEach((l) => l.classList.add('elive-off')); sl.append(box); } // the questions take the list's place (it says how to ask)
      join(sl, m.join);
    } else if (m.join) join(sl, m.join);
  }
  // the presenter view: this slide's target beside the timer
  let targets = {}, curIdx = -1, since = Date.now();
  function pv() {
    const side = document.querySelector('#pv .side');
    if (!side) return;
    let row = document.getElementById('elive-tgt');
    if (!row) {
      const lab = mk('div', 'nl', 'Target');
      row = mk('div', 'elive-tgt'); row.id = 'elive-tgt';
      const timer = document.getElementById('pv-timer');
      if (timer && timer.nextSibling) { side.insertBefore(lab, timer.nextSibling); side.insertBefore(row, lab.nextSibling); } else side.append(lab, row);
    }
    const cur = document.querySelector('#frame > .slide.cur');
    const idx = cur ? Number(cur.dataset.index) : -1;
    if (idx !== curIdx) { curIdx = idx; since = Date.now(); }
    const t = targets[idx];
    const s = Math.floor((Date.now() - since) / 1000);
    const f = (x) => `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`;
    row.textContent = t ? `${f(s)} of ${f(t)} on this slide` : `${f(s)} on this slide`;
    row.classList.toggle('over', !!t && s > t);
  }
  setInterval(() => { if (document.body.classList.contains('presenter')) pv(); }, 500);
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const m = e.data || {};
    if (m.type === 'deck-live' && Number.isInteger(m.k)) draw(m);
    else if (m.type === 'deck-targets' && m.targets && typeof m.targets === 'object') { targets = {}; for (const [k, v] of Object.entries(m.targets)) if (Number.isFinite(v) && v > 0) targets[k] = Math.round(v); }
  });
}
/* eslint-enable */
