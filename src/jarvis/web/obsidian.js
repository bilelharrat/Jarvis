// The Obsidian look's reactor (obsidian.css): a fine-ticked dial drawn on a canvas in the
// orb's place. Idle, a still bezel with brass at the quarters and a faint light going round;
// listening, the ticks follow your voice; thinking, a bright arc sweeps the inner ring;
// speaking, the ring lights and the ticks pulse. It draws only while the look is on, the
// window can be seen and the orb is on show; with reduced motion, one still frame a state.
// The dial's geometry is pure and exported for node --test (tests/web/obsidian.test.mjs).
(function (root) {
  'use strict';

  const DIAL = 420;          // the dial is drawn in a 420-unit square, scaled to the canvas
  const TICKS = 144;
  const TICK_R = 166;        // where the ticks start; they grow outward
  const RING_R = 136;
  // The colours come from obsidian.css's tokens (graphite at night, porcelain in the day).
  const NIGHT = { arc: '143, 216, 255', ring: '255, 255, 255', brass: '#e3b76a', core: '#f4fbff' };

  const isMajor = (i) => i % 12 === 0;
  const live = (state) => state === 'listening' || state === 'speaking' || state === 'thinking' || state === 'transcribing';

  // How long tick i is (dial units) in a state, t seconds in, at a voice level of 0..1.
  function tickLength(i, state, t, level) {
    const lv = Math.max(0, Math.min(1, Number(level) || 0));
    if (state === 'listening') {
      const w = Math.abs(Math.sin(i * 0.31 + t * 2.1) * Math.cos(i * 0.087 - t * 1.3 + 0.9));
      return 4 + (8 + 34 * lv) * Math.pow(w, 1.3);
    }
    if (state === 'speaking') {
      const env = 0.55 + 0.45 * Math.cos(i * 0.131 + t * 1.7);
      const energy = 0.7 + 0.3 * Math.sin(t * 9) * Math.sin(t * 3.3);
      return 4 + 18 * Math.abs(Math.sin(i * 0.5 + t * 7)) * env * energy;
    }
    if (state === 'thinking' || state === 'transcribing') {
      const d = (((i - sweepHead(t)) % TICKS) + TICKS) % TICKS;
      return d < 32 ? 5 + 11 * Math.sin((d / 32) * Math.PI) : 4;
    }
    return isMajor(i) ? 12 : 5;
  }

  // The tick the thinking bump has reached: once round in three seconds.
  function sweepHead(t) { return Math.floor((t * 48) % TICKS); }

  // Whether tick i is drawn bright: the twelve hour marks at rest (and the slow light going
  // round), the long ones while it's live.
  function tickBright(i, state, len, t) {
    if (state === 'thinking' || state === 'transcribing') return len > 7;
    if (live(state)) return len > 13;
    if (isMajor(i)) return true;
    const head = ((t / 24) * TICKS) % TICKS;
    const d = (((head - i) % TICKS) + TICKS) % TICKS;
    return d < 6;
  }

  // The inner ring's light: [opacity, start angle, sweep] in radians from twelve o'clock.
  function ringFor(state, t) {
    const full = Math.PI * 2;
    if (state === 'thinking' || state === 'transcribing') return [0.95, (t * 2.6) % full, full * 0.22];
    if (state === 'speaking') return [0.55, 0, full];
    if (state === 'listening') return [0.3, 0, full];
    return [0, 0, 0];
  }

  // One frame of the dial on a 2D context `size` pixels square, in the look's colours.
  function draw(ctx, size, state, t, level, colors = NIGHT) {
    const ARC = colors.arc, RING = colors.ring;
    const k = size / DIAL;
    const c = size / 2;
    const on = live(state);
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(c, c);
    ctx.scale(k, k);
    ctx.lineCap = 'round';

    const circle = (r, stroke, width, dash) => {
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.setLineDash(dash || []);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.stroke();
      ctx.setLineDash([]);
    };

    circle(204, `rgba(${RING}, 0.06)`, 1);

    // the ticks, dim and bright, each group in one path
    const dim = new Path2D();
    const bright = new Path2D();
    for (let i = 0; i < TICKS; i++) {
      const a = (i / TICKS) * Math.PI * 2 - Math.PI / 2;
      const len = tickLength(i, state, t, level);
      const x = Math.cos(a), y = Math.sin(a);
      const path = tickBright(i, state, len, t) ? bright : dim;
      path.moveTo(x * TICK_R, y * TICK_R);
      path.lineTo(x * (TICK_R + len), y * (TICK_R + len));
    }
    ctx.strokeStyle = `rgba(${ARC}, 0.34)`;
    ctx.lineWidth = 1.4;
    ctx.stroke(dim);
    ctx.shadowColor = `rgba(${ARC}, ${on ? 0.7 : 0.4})`;
    ctx.shadowBlur = (on ? 10 : 6) * k;
    ctx.strokeStyle = `rgba(${ARC}, 0.92)`;
    ctx.lineWidth = 1.7;
    ctx.stroke(bright);
    ctx.shadowBlur = 0;

    // brass at the quarters, as on a chronograph's bezel
    ctx.beginPath();
    for (let q = 0; q < 4; q++) {
      const a = (q * Math.PI) / 2 - Math.PI / 2;
      ctx.moveTo(Math.cos(a) * 197, Math.sin(a) * 197);
      ctx.lineTo(Math.cos(a) * 205, Math.sin(a) * 205);
    }
    ctx.strokeStyle = colors.brass;
    ctx.lineWidth = 2.2;
    ctx.stroke();

    circle(RING_R, `rgba(${RING}, 0.09)`, 1);
    const [alpha, start, sweep] = ringFor(state, t);
    if (alpha > 0) {
      ctx.beginPath();
      ctx.arc(0, 0, RING_R, start - Math.PI / 2, start - Math.PI / 2 + sweep);
      ctx.strokeStyle = `rgba(${ARC}, ${alpha})`;
      ctx.lineWidth = 1.6;
      ctx.shadowColor = `rgba(${ARC}, 0.6)`;
      ctx.shadowBlur = 8 * k;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    circle(104, `rgba(${RING}, 0.07)`, 1, [1.5, 7]);

    // the core: two soft discs, a fine ring and a bright point
    const lv = Math.max(0, Math.min(1, Number(level) || 0));
    for (const [r, a] of [[72, on ? 0.08 : 0.04], [50, (on ? 0.12 : 0.07) + lv * 0.08]]) {
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${ARC}, ${a})`;
      ctx.fill();
    }
    ctx.shadowColor = `rgba(${ARC}, 0.55)`;
    ctx.shadowBlur = 12 * k;
    circle(30 + lv * 4, `rgba(${ARC}, 1)`, 1.6);
    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, Math.PI * 2);
    ctx.fillStyle = colors.core;
    ctx.fill();
    ctx.restore();
  }

  const api = { DIAL, TICKS, NIGHT, tickLength, tickBright, ringFor, sweepHead, draw };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  root.jarvisReactor = api;

  // ── in the window ──
  const doc = root.document;
  const orb = doc && doc.getElementById('orb');
  if (!orb) return;
  const canvas = doc.createElement('canvas');
  canvas.className = 'ob-reactor';
  canvas.setAttribute('aria-hidden', 'true');
  orb.append(canvas);
  const ctx = canvas.getContext('2d');
  const reduced = root.matchMedia('(prefers-reduced-motion: reduce)');
  const body = doc.body;
  let px = 0;
  let level = 0;
  let frame = 0;
  let last = 0;
  let checked = 0;
  let shown = true;
  const t0 = performance.now();

  const on = () => body.dataset.skin === 'obsidian';
  let colors = NIGHT;
  function readColors() {
    const css = root.getComputedStyle(body);
    const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    colors = {
      arc: token('--ob-arc-rgb', NIGHT.arc), ring: token('--ob-ring-rgb', NIGHT.ring),
      brass: token('--ob-brass', NIGHT.brass), core: token('--ob-core', NIGHT.core),
    };
  }
  function fit() {
    const css = canvas.clientWidth;
    const next = Math.round(css * (root.devicePixelRatio || 1));
    if (next && next !== px) { px = next; canvas.width = next; canvas.height = next; }
    return px;
  }
  function paint(now) {
    if (!fit()) return;
    const target = Number(doc.documentElement.style.getPropertyValue('--level')) || 0;
    level += (target - level) * 0.25;
    const t = reduced.matches ? 0 : (now - t0) / 1000;
    draw(ctx, px, body.dataset.state || 'idle', t, reduced.matches ? 0 : level, colors);
  }
  function tick(now) {
    frame = 0;
    if (!on() || doc.hidden || reduced.matches) return;
    // Jarvis Code and the galaxy hide the orb: check now and then, not every frame
    if (now - checked > 500) { checked = now; shown = root.getComputedStyle(orb).visibility !== 'hidden'; }
    // at rest the light moves slowly, so twenty frames a second is plenty
    const idle = (body.dataset.state || 'idle') === 'idle';
    if (shown && (!idle || now - last > 50)) { last = now; paint(now); }
    frame = root.requestAnimationFrame(tick);
  }
  function wake() {
    if (on()) readColors();
    if (!on()) { if (frame) root.cancelAnimationFrame(frame); frame = 0; return; }
    if (reduced.matches) { paint(performance.now()); return; }
    checked = 0;
    if (!frame) frame = root.requestAnimationFrame(tick);
  }
  new MutationObserver(wake).observe(body, { attributes: true, attributeFilter: ['data-skin', 'data-state', 'data-tone'] });
  doc.addEventListener('visibilitychange', wake);
  reduced.addEventListener('change', wake);
  if (root.ResizeObserver) new ResizeObserver(() => { if (on()) paint(performance.now()); }).observe(canvas);
  wake();
})(typeof window === 'object' ? window : globalThis);
