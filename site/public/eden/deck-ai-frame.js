// The slide frame's half of EVES fact-check (deck-factcheck.js; web only): deck-render.js adds it to the progressive
// edit document only (never the iPhone app, a shared copy or the PDF). No imports: it is stringified into the frame.
//   page → frame: deck-marks { marks: [{ index, path, tone, word }] }: each checked box is underlined in its
//                 verdict's colour with the verdict's word beside it (words AND colour), edit mode only.
// (The selected words' range comes from deck-rich-frame.js deck-rich-sel { index, path, start, end, rect }.)


/** Runs in the sandboxed frame (stringified). */
export function aiFrame() {
  'use strict';
  const style = document.createElement('style');
  style.textContent = ".mode-edit [data-fc]{text-decoration:underline wavy;text-decoration-thickness:1.5px;text-underline-offset:.18em;text-decoration-skip-ink:none}\n.mode-edit [data-fc=\"ok\"]{text-decoration-color:#30d158;text-decoration-style:solid}\n.mode-edit [data-fc=\"bad\"]{text-decoration-color:#ff453a}\n.mode-edit [data-fc=\"warn\"]{text-decoration-color:#ff9f0a}\n.mode-edit [data-fc=\"quiet\"]{text-decoration-color:#8e8e93;text-decoration-style:dotted}\n.mode-edit [data-fc-word]::after{content:attr(data-fc-word);display:inline-block;margin-left:.4em;padding:.12em .45em;border-radius:6px;vertical-align:.15em;font:600 13px/1.2 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;letter-spacing:0;text-transform:none;text-decoration:none;color:#fff;background:#8e8e93}\n.mode-edit [data-fc=\"bad\"][data-fc-word]::after{background:#d70015}\n.mode-edit [data-fc=\"warn\"][data-fc-word]::after{background:#a05a00}\n.mode-edit [data-fc=\"ok\"][data-fc-word]::after{content:'✓';background:#1f8a4c}\n.thumb [data-fc-word]::after{display:none}";
  document.head.append(style);
  // EVES marks on the checked boxes
  let marks = [];
  const drawMarks = () => {
    document.querySelectorAll('[data-fc]').forEach((n) => { n.removeAttribute('data-fc'); n.removeAttribute('data-fc-word'); });
    const worst = { bad: 4, warn: 3, quiet: 2, ok: 1 };
    const at = new Map();
    for (const mk of marks) { const k = `${mk.index}|${mk.path}`; const had = at.get(k); if (!had || (worst[mk.tone] || 0) > (worst[had.tone] || 0)) at.set(k, mk); }
    // a box's own path, or the drawn box for data checked as one line (a stat, a diagram step, a table row)
    const boxFor = (s, p) => {
      const exact = s.querySelector(`[data-path="${CSS.escape(p)}"]`);
      if (exact) return exact;
      const m = /^(stats|diagram|table)\.(\d+)$/.exec(p);
      if (!m) return null;
      const pre = m[1] === 'stats' ? `stats.${m[2]}.` : m[1] === 'diagram' ? `diagram.items.${m[2]}.` : `table.rows.${m[2]}.`;
      return [...s.querySelectorAll('[data-path]')].find((n) => n.dataset.path.startsWith(pre)) || null;
    };
    for (const s of document.querySelectorAll('#frame > .slide')) {
      const i = Number(s.dataset.index);
      for (const [k, mk] of at) {
        if (!k.startsWith(`${i}|`)) continue;
        const n = boxFor(s, mk.path);
        if (!n) continue;
        n.setAttribute('data-fc', mk.tone);
        n.setAttribute('data-fc-word', mk.word);
      }
    }
  };
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const m = e.data || {};
    if (m.type === 'deck-marks' && Array.isArray(m.marks)) {
      marks = m.marks.filter((x) => x && Number.isInteger(x.index) && typeof x.path === 'string' && x.path.length < 80 && ['ok', 'bad', 'warn', 'quiet'].includes(x.tone)).slice(0, 120).map((x) => ({ index: x.index, path: x.path, tone: x.tone, word: String(x.word || '').slice(0, 24) }));
      drawMarks();
    }
  });
  const frame = document.getElementById('frame');
  let mt = 0;
  if (frame && window.MutationObserver) new MutationObserver(() => { if (marks.length) { clearTimeout(mt); mt = setTimeout(drawMarks, 60); } }).observe(frame, { childList: true }); // slides drawn later (progressive) get theirs too
  document.addEventListener('focusin', (e) => { const n = e.target.closest && e.target.closest('[data-fc-word]'); if (n && n.dataset.fc !== 'ok') n.removeAttribute('data-fc-word'); }); // no label inside text being typed
}
