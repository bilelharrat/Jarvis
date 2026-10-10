// The front page's six films: each plays, muted, while it is on screen, and pauses when it leaves. Two buttons on each: pause and sound
// (only one film has sound at a time). Without this script the browser's own controls show, and nothing loads until someone presses play.
(() => {
  'use strict';
  const films = [...document.querySelectorAll('video.fv')];
  if (!films.length || !('IntersectionObserver' in window)) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;   // then nothing starts by itself

  function sync(v) {
    const box = v.closest('.fvid'), pp = box.querySelector('.fpp'), snd = box.querySelector('.fsnd');
    pp.dataset.state = v.paused ? 'paused' : 'playing';
    pp.setAttribute('aria-label', v.paused ? 'Play' : 'Pause');
    snd.setAttribute('aria-pressed', String(!v.muted));
    snd.setAttribute('aria-label', v.muted ? 'Turn sound on' : 'Turn sound off');
  }
  function hush(except) { for (const v of films) if (v !== except && !v.muted) v.muted = true; }

  for (const v of films) {
    const box = v.closest('.fvid'), ctl = box.querySelector('.fctl'), pp = box.querySelector('.fpp'), snd = box.querySelector('.fsnd');
    v.controls = false; ctl.hidden = false;
    pp.addEventListener('click', () => { if (v.paused) { v.dataset.hold = ''; v.play().catch(() => {}); } else { v.dataset.hold = '1'; v.pause(); } });
    v.addEventListener('click', () => pp.click());                       // a tap on the picture pauses or plays too
    snd.addEventListener('click', () => {
      v.muted = !v.muted;
      if (!v.muted) { hush(v); if (v.paused) { v.dataset.hold = ''; v.play().catch(() => {}); } }
    });
    for (const ev of ['play', 'pause', 'volumechange']) v.addEventListener(ev, () => sync(v));
    sync(v);
  }

  // load a film's first frames a little before it arrives; play it when most of it is in view; stop it (and its sound) when it leaves
  const near = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { e.target.preload = 'metadata'; near.unobserve(e.target); } }, { rootMargin: '900px 0px' });
  const seen = new IntersectionObserver((es) => {
    for (const e of es) {
      const v = e.target;
      if (e.isIntersecting) { if (!reduce && v.dataset.hold !== '1') v.play().catch(() => {}); }
      else { v.pause(); v.muted = true; }
    }
  }, { threshold: 0.6 });
  for (const v of films) { near.observe(v); seen.observe(v); }
  document.addEventListener('visibilitychange', () => { if (document.hidden) for (const v of films) v.pause(); });
})();
