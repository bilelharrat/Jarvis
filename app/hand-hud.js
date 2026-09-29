// The indicator's only input: { status, hand, pinch, paused, blocked } from the main
// window, relayed by main.js (hud-preload.js). The dot grows as a pinch closes, so a
// click can be seen coming before it lands.
const hud = document.getElementById('hud');
const text = document.getElementById('text');
const dot = document.getElementById('dot');

window.handHud.onUpdate((u) => {
  if (!u || typeof u !== 'object') return;
  if (typeof u.status === 'string') text.textContent = u.status;
  const state = u.blocked ? 'blocked' : u.paused ? 'paused' : u.hand ? 'hand' : u.hand === false ? 'idle' : hud.dataset.state;
  hud.dataset.state = state;
  const pinch = Number.isFinite(u.pinch) ? Math.min(1, Math.max(0, u.pinch)) : 0;
  dot.style.setProperty('--pinch-scale', String(1 + 0.9 * pinch));
});
