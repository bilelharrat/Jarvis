// Eden Code's video proof (features/code_video.py): the recording, asked of the app
// (app/features/video-proof.js) through this window; each one in the transcript as a poster
// frame that plays it; "Record a video proof" in the More menu. Its per-project switch is in
// Settings › Projects (code-sessions.js).
//
// Everything shown from the backend is data: text only. Pure helpers are exported for
// node --test (tests/web/code-video.test.mjs).
(function (root) {
  'use strict';

  // Where a video is played from: the window's own server, by its id only.
  function videoSrc(id) {
    return typeof id === 'string' && /^[0-9a-f]{24}$/.test(id) ? `/f/code-video/${id}` : '';
  }

  function jpegSrc(data) {
    return typeof data === 'string' && data && /^[A-Za-z0-9+/]+={0,2}$/.test(data) ? `data:image/jpeg;base64,${data}` : '';
  }

  function secondsText(s) {
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? `${n < 10 ? n.toFixed(1).replace(/\.0$/, '') : Math.round(n)} s` : '';
  }

  const api = { videoSrc, jpegSrc, secondsText };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, t } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  F.on('vp_capture', async (ev) => {
    F.send({ type: 'vp_result', call: ev.call, result: { error: 'disabled' } });
  });

  function videoEntry() {
    return null;
  }
  F.registerEntry('video', videoEntry);
})(typeof window === 'object' ? window : globalThis);
