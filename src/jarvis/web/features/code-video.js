// Jarvis Code's video proof (features/code_video.py): the recording, asked of the app
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
    const app = root.jarvisApp;
    if (!app || !app.feature) return;  // a window without the app: the app window answers
    let result;
    try {
      result = await app.feature.invoke('feature:video-proof:record', { url: ev.url, seconds: ev.seconds, width: ev.width, height: ev.height });
    } catch (err) {
      result = { error: String(err && err.message ? err.message : err) };
    }
    F.send({ type: 'vp_result', call: ev.call, result });
  });

  function videoEntry(e) {
    const li = el('li', `vp-card ${e.status || ''}`);
    const body = el('div', 'vp-body');
    const head = el('strong', '', 'Video proof');
    body.append(head);
    if (e.status !== 'ok') {
      body.append(el('small', 'cv-check-note', e.why || ''));
      li.append(body);
      return li;
    }
    const src = videoSrc(e.video);
    const poster = el('button', 'vp-poster');
    poster.type = 'button';
    poster.setAttribute('aria-label', t('Play the video proof'));
    const img = el('img');
    img.alt = t('The page, recorded');
    img.src = jpegSrc(e.poster);
    poster.append(img, el('span', 'vp-play', '▶'));
    poster.addEventListener('click', () => {
      if (!src) return;
      const video = el('video');
      video.controls = true;
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.src = src;
      video.addEventListener('error', () => {
        video.replaceWith(el('small', 'cv-check-note', 'That video isn’t kept anymore.'));
      });
      poster.replaceWith(video);
      li.classList.add('playing');
    });
    const where = [secondsText(e.seconds), e.url || ''].filter(Boolean).join(' · ');
    if (where) body.append(mine(el('small', 'vp-where', where)));
    body.append(el('small', 'cv-check-note', 'The page as it loaded and scrolled, recorded in a hidden preview.'));
    li.append(poster, body);
    return li;
  }
  F.registerEntry('video', videoEntry);

  F.registerMoreItem({
    label: 'Record a video proof',
    note: 'A few seconds of the dev server’s page, kept with the session',
    when: (task) => !!task,
    run: () => { const task = F.currentTask(); if (task) F.send({ type: 'vp_record', id: task.id }); },
  });
  F.on('vp_state', (ev) => {
    const task = F.currentTask();
    if (ev.recording && task && task.id === ev.id && typeof jcNote === 'function') jcNote(t('Recording a video proof…'));
  });
  F.on('vp_error', (ev) => { if (typeof jcNote === 'function') jcNote(ev.text); });
})(typeof window === 'object' ? window : globalThis);
