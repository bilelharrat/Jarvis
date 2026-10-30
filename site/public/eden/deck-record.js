// Record yourself presenting (web only; deck.js shows "Record" when !IN_APP and the browser can). The slide frame is
// another origin, so its pixels can't be drawn onto a canvas: Eden records this tab instead (getDisplayMedia; Chrome
// offers this tab first), cut down to the slide stage where the browser can (Element Capture's restrictTo, else
// Region Capture's cropTo), with the microphone mixed in and an optional camera bubble on the slide. The browser asks
// for the tab, microphone and camera only when the person presses Start. Nothing is uploaded: the person downloads the
// video at the end (MP4 where the browser records it, else WebM). The recording bar sits in the top layer, outside
// the recorded stage, so it isn't in the video where Element Capture is available.

/** The recorder formats this browser has: { mp4?, webm? } → a MediaRecorder mimeType each. */
export function recordingTypes(isSupported) {
  const out = {};
  for (const [k, t] of [['mp4', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2'], ['mp4', 'video/mp4'], ['webm', 'video/webm;codecs=vp9,opus'], ['webm', 'video/webm;codecs=vp8,opus'], ['webm', 'video/webm']]) {
    try { if (!out[k] && isSupported(t)) out[k] = t; } catch { /* not this one */ }
  }
  return out;
}
export const canRecord = () => typeof navigator !== 'undefined' && !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && typeof MediaRecorder !== 'undefined'
  && Object.keys(recordingTypes((t) => MediaRecorder.isTypeSupported(t))).length > 0;
/** m:ss */
export const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
/** "Deck title – recording 2026-10-24 1530.webm", without characters file systems refuse. */
export function recordingName(title, ext, d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  const base = String(title || 'Slides').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Slides';
  return `${base} – recording ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}

const CSS = `.rec-bar{position:fixed;inset:auto auto 16px 50%;transform:translateX(-50%);margin:0;z-index:2147483000;display:flex;align-items:center;gap:8px;padding:8px 10px 8px 14px;border:1px solid rgba(255,255,255,.18);border-radius:999px;background:rgba(18,18,22,.92);color:#fff;font:600 14px -apple-system,system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.4)}
.rec-bar .rec-dot{width:12px;height:12px;border-radius:50%;background:#ff3b30;box-shadow:0 0 0 4px rgba(255,59,48,.25)}
.rec-bar.paused .rec-dot{background:#f5a524;box-shadow:none}.rec-bar.done .rec-dot{background:#17a673;box-shadow:none}
.rec-bar button{font:inherit;min-height:40px;padding:0 14px;border-radius:999px;border:1px solid rgba(255,255,255,.3);background:transparent;color:#fff;cursor:pointer}
.rec-bar button.rec-stop{background:#ff3b30;border-color:#ff3b30}.rec-bar button.rec-dl{background:#fff;color:#111;border-color:#fff}
.rec-bar button:focus-visible{outline:3px solid #fff;outline-offset:2px}
.rec-time{font-variant-numeric:tabular-nums;min-width:40px}
.rec-cam{position:absolute;left:24px;bottom:24px;width:min(22vmin,220px);aspect-ratio:1;border-radius:50%;object-fit:cover;transform:scaleX(-1);z-index:5;border:3px solid rgba(255,255,255,.85);box-shadow:0 8px 24px rgba(0,0,0,.35);background:#111;pointer-events:none}
.rec-form{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}.rec-form p{flex-basis:100%;margin:0}
.rec-form label{display:flex;align-items:center;gap:6px;color:var(--text)}
.rec-form select{font:inherit;min-height:36px;border-radius:9px;border:1px solid var(--hairline);background:var(--content2);color:var(--text);padding:4px 8px}
@media (prefers-reduced-motion:no-preference){.rec-bar:not(.paused):not(.done) .rec-dot{animation:rec-pulse 1.4s ease-in-out infinite}@keyframes rec-pulse{50%{opacity:.35}}}`;

let session = null; // the recording in progress (or finished, waiting to be downloaded)
let A = null; // { present, stage, notice, title, downloadBlob, toast, tx }

function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : String(v));
  }
  n.append(...kids.filter((x) => x !== null && x !== undefined));
  return n;
}

/** The "Record" panel: what to record, then Start (only then does the browser ask for anything). */
export function openRecorder(api) {
  A = api;
  if (!document.getElementById('deck-record-css')) document.head.append(h('style', { id: 'deck-record-css' }, CSS));
  if (session && session.bar && session.bar.isConnected) { const b = session.bar.querySelector('button'); if (b) b.focus(); return; }
  const tx = A.tx || ((s) => s);
  const types = recordingTypes((t) => MediaRecorder.isTypeSupported(t));
  const mic = h('input', { type: 'checkbox', checked: true });
  const cam = h('input', { type: 'checkbox' });
  const fmt = h('select', { 'aria-label': tx('File format') }, ...Object.keys(types).map((k) => h('option', { value: k }, k === 'mp4' ? 'MP4' : 'WebM')));
  const start = h('button', { type: 'button', class: 'cap primary', onclick: () => begin({ mic: mic.checked, cam: cam.checked, ext: fmt.value, type: types[fmt.value] }) }, tx('Start recording'));
  A.notice('', [h('div', { class: 'rec-form', role: 'group', 'aria-label': tx('Record yourself presenting') },
    h('strong', {}, tx('Record yourself presenting')),
    h('p', {}, globalThis.CropTarget || globalThis.RestrictionTarget // Chrome shares a tab; Safari and Firefox share a window or the screen
      ? tx('Eden records this tab while you present, with your voice. Your browser asks which tab to share: choose this one. Nothing is uploaded; you download the video when you stop.')
      : tx('Eden records while you present, with your voice. Your browser asks what to share: choose this browser window. Nothing is uploaded; you download the video when you stop.')),
    h('label', {}, mic, tx('Microphone')), h('label', {}, cam, tx('Camera bubble')), h('label', {}, tx('Format'), fmt), start)]);
  start.focus();
}

async function begin(opts) {
  const tx = A.tx || ((s) => s);
  if (session && !session.done) return;
  discard();
  let display = null, user = null;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30, displaySurface: 'browser' }, audio: { suppressLocalAudioPlayback: false },
      preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', systemAudio: 'exclude', monitorTypeSurfaces: 'exclude',
    });
  } catch (e) {
    A.toast(e && e.name === 'NotAllowedError' ? tx('Recording didn’t start: sharing the tab wasn’t allowed.') : tx(`Recording didn’t start: ${e && e.message}`));
    return;
  }
  if (opts.mic || opts.cam) {
    try { user = await navigator.mediaDevices.getUserMedia({ audio: opts.mic ? { echoCancellation: true, noiseSuppression: true } : false, video: opts.cam ? { width: { ideal: 480 }, height: { ideal: 480 }, facingMode: 'user' } : false }); }
    catch (e) { A.toast(tx(`Recording without ${opts.mic && opts.cam ? 'microphone and camera' : opts.mic ? 'the microphone' : 'the camera'}: ${e && e.name === 'NotAllowedError' ? 'not allowed' : 'not available'}.`)); }
  }
  const s = session = { display, user, chunks: [], t0: 0, paused: 0, pausedAt: 0, done: false, ext: opts.ext, type: opts.type, audio: null, cam: null, bar: null, tick: 0 };
  const video = display.getVideoTracks()[0];
  // sound: the tab's (a video on a slide) and the microphone, mixed into one track
  const sources = [...display.getAudioTracks(), ...(user ? user.getAudioTracks() : [])];
  let audio = sources[0] || null;
  if (sources.length > 1) {
    try {
      const ctx = s.audio = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      for (const tr of sources) ctx.createMediaStreamSource(new MediaStream([tr])).connect(dest);
      audio = dest.stream.getAudioTracks()[0];
    } catch { audio = sources.find((t) => user && user.getAudioTracks().includes(t)) || sources[0]; }
  }
  // the camera bubble: on the stage, so it's in the recording and the presenter sees themself
  const stage = A.stage();
  if (user && user.getVideoTracks().length && stage) {
    s.cam = h('video', { class: 'rec-cam', autoplay: true, playsinline: true, 'aria-hidden': 'true' });
    s.cam.muted = true;
    s.cam.srcObject = new MediaStream(user.getVideoTracks());
    stage.append(s.cam);
  }
  const stream = new MediaStream([video, ...(audio ? [audio] : [])]);
  let rec;
  try { rec = s.rec = new MediaRecorder(stream, { mimeType: s.type, videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 128_000 }); }
  catch (e) { A.toast(tx(`This browser can’t record that format: ${e.message}`)); cleanup(s); session = null; return; }
  rec.ondataavailable = (e) => { if (e.data && e.data.size) s.chunks.push(e.data); };
  rec.onstop = () => finish(s);
  video.addEventListener('ended', () => stop()); // the browser's own "Stop sharing"
  showBar(s);
  A.present();
  rec.start(1000);
  s.t0 = Date.now();
  addEventListener('beforeunload', warn);
  // only the slide stage, where the browser can: after present() has put the stage where it will stay
  setTimeout(async () => {
    const st = A.stage();
    if (!st || s.done) return;
    try {
      if (globalThis.RestrictionTarget && video.restrictTo) { st.style.isolation = 'isolate'; await video.restrictTo(await globalThis.RestrictionTarget.fromElement(st)); s.region = 'element'; }
      else if (globalThis.CropTarget && video.cropTo) { await video.cropTo(await globalThis.CropTarget.fromElement(st)); s.region = 'crop'; }
    } catch { s.region = 'tab'; } // another tab or window was shared: it's recorded whole
  }, 700);
}

const warn = (e) => { if (session && !session.done) { e.preventDefault(); e.returnValue = ''; } };

function showBar(s) {
  const tx = A.tx || ((x) => x);
  const time = h('span', { class: 'rec-time' }, '0:00');
  const pause = h('button', { type: 'button', onclick: () => togglePause() }, tx('Pause'));
  const bar = s.bar = h('div', { class: 'rec-bar', role: 'status', 'aria-live': 'polite', 'aria-label': tx('Recording') },
    h('span', { class: 'rec-dot', 'aria-hidden': 'true' }), h('span', { class: 'rec-label' }, tx('Recording')), time, pause,
    h('button', { type: 'button', class: 'rec-stop', onclick: () => stop() }, tx('Stop')));
  if ('popover' in HTMLElement.prototype) bar.setAttribute('popover', 'manual');
  document.body.append(bar);
  raise();
  s.tick = setInterval(() => { if (!s.pausedAt) time.textContent = clock(Date.now() - s.t0 - s.paused); }, 500);
  s.time = time; s.pauseBtn = pause;
}
/** The bar over everything, the full-screen slides included (the top layer keeps the newest on top). */
function raise() {
  const bar = session && session.bar;
  if (!bar || !bar.isConnected) return;
  if (bar.hasAttribute('popover')) { try { if (bar.matches(':popover-open')) bar.hidePopover(); bar.showPopover(); } catch { /* not open */ } }
  else { const st = A.stage(); if (document.fullscreenElement === st && bar.parentNode !== st) st.append(bar); else if (!document.fullscreenElement && bar.parentNode !== document.body) document.body.append(bar); }
}
if (typeof document !== 'undefined') document.addEventListener('fullscreenchange', () => setTimeout(raise, 50));

function togglePause() {
  const s = session, tx = A.tx || ((x) => x);
  if (!s || s.done || !s.rec) return;
  if (s.rec.state === 'recording') { s.rec.pause(); s.pausedAt = Date.now(); s.bar.classList.add('paused'); s.bar.querySelector('.rec-label').textContent = tx('Paused'); s.pauseBtn.textContent = tx('Resume'); }
  else if (s.rec.state === 'paused') { s.rec.resume(); s.paused += Date.now() - s.pausedAt; s.pausedAt = 0; s.bar.classList.remove('paused'); s.bar.querySelector('.rec-label').textContent = tx('Recording'); s.pauseBtn.textContent = tx('Pause'); }
}

/** Ends the recording (Stop, or the browser stopped sharing). */
export function stop() {
  const s = session;
  if (!s || s.done || !s.rec) return;
  if (s.pausedAt) { s.paused += Date.now() - s.pausedAt; s.pausedAt = 0; }
  s.length = Date.now() - s.t0 - s.paused;
  if (s.rec.state !== 'inactive') s.rec.stop(); else finish(s);
}

function cleanup(s) {
  clearInterval(s.tick);
  for (const st of [s.display, s.user]) if (st) for (const t of st.getTracks()) t.stop();
  if (s.audio) s.audio.close().catch(() => {});
  if (s.cam) { s.cam.srcObject = null; s.cam.remove(); }
  const st = A && A.stage();
  if (st) st.style.isolation = '';
  removeEventListener('beforeunload', warn);
}

function finish(s) {
  const tx = A.tx || ((x) => x);
  if (s.done) return;
  s.done = true;
  cleanup(s);
  s.blob = new Blob(s.chunks, { type: s.type.split(';')[0] });
  s.chunks = [];
  const size = s.blob.size >= 1048576 ? `${Math.round(s.blob.size / 104857.6) / 10} MB` : `${Math.max(1, Math.round(s.blob.size / 1024))} KB`;
  const name = recordingName(A.title(), s.ext);
  s.bar.classList.add('done');
  const dl = h('button', { type: 'button', class: 'rec-dl', onclick: () => { A.downloadBlob(s.blob, name); dl.textContent = tx('Downloaded'); } }, tx(`Download ${s.ext === 'mp4' ? 'MP4' : 'WebM'}`));
  s.bar.replaceChildren(h('span', { class: 'rec-dot', 'aria-hidden': 'true' }), h('span', {}, `${tx('Recording ready')} · ${clock(s.length || 0)} · ${size}`), dl,
    h('button', { type: 'button', onclick: () => discard() }, tx('Close')));
  raise();
  dl.focus();
}

/** Closes the bar and lets go of a finished recording (one still running is stopped first). */
export function discard() {
  const s = session;
  if (!s) return;
  if (!s.done && s.rec && s.rec.state !== 'inactive') { s.rec.onstop = null; s.rec.stop(); cleanup(s); }
  if (s.bar) { try { if (s.bar.matches(':popover-open')) s.bar.hidePopover(); } catch { /* not a popover */ } s.bar.remove(); }
  s.blob = null;
  session = null;
}
/** For checks: what's recording now. */
export const recordingState = () => (session ? { done: session.done, state: session.rec && session.rec.state, region: session.region || '', size: session.blob ? session.blob.size : 0, type: session.blob ? session.blob.type : '', cam: !!session.cam, audio: !!(session.rec && session.rec.stream.getAudioTracks().length) } : null);
