// J.A.R.V.I.S., the tutor (Eden for Education): a live spoken conversation about a course, full
// screen over the app (edu-app.js opens it). You talk; when you pause, J.A.R.V.I.S. answers out loud
// in its own voice from the course's materials (courseTask 'tutor': short spoken turns, one question
// at a time, the same quote check), then listens again. Speak over it and it stops, like a person.
//
//   hearing   the browser's speech recognition (live captions); where there's none, the mic records
//             and POST /api/chat/transcribe turns each pause into words (the account's allowance)
//   speaking  POST /api/chat/voice, a sentence at a time while the answer streams (the account's daily
//             voice allowance); if the voice isn't available, the browser's own voice reads instead
//   barge-in  the mic's level (echo-cancelled) well above the room while J.A.R.V.I.S. speaks
//
// The conversation is kept as a study chat (marked tutor) so it's in the history afterwards.
// Collapsed, J.A.R.V.I.S. is just the orb: a sphere that floats over the app (drag it anywhere; it
// stays put as you move around), still listening and speaking; tap it to open the conversation again.

import { el, ico, toast } from './util.js';
import { api, apiUrl } from './api.js';
import { speechText, chunkText, recordingType } from './voice-text.js';
import { stripSources, groundingStrip } from './courses.js';

const Recognition = () => window.SpeechRecognition || window.webkitSpeechRecognition || null;
const PAUSE_MS = 1000; // quiet this long after you've said something (words still interim): your turn is over
const FINAL_PAUSE_MS = 550; // …or this long once the recognizer has called them final
const T = { root: null, course: null, chat: null, save: null, state: 'idle', muted: false };

/** Opens the tutor for a course; `chat` (a study chat) keeps the conversation, `save(chat)` stores it. */
export function openTutor(course, { chat, save } = {}) {
  closeTutor();
  Object.assign(T, { course, chat, save, state: 'idle', muted: false, history: [], heard: '', said: '', sources: null, mini: false, greeted: false });
  T.root = el('div', { class: 'tut', role: 'dialog', 'aria-modal': 'true', 'aria-label': `J.A.R.V.I.S., your tutor for ${course.name}` },
    el('div', 'tut-top',
      el('div', 'tut-name', el('b', '', 'J.A.R.V.I.S.'), el('span', '', `Your tutor · ${course.name}`)),
      el('div', 'tut-top-acts',
        el('button', { type: 'button', class: 'tut-x', 'aria-label': 'Shrink to the orb (keeps talking)', title: 'Shrink to the orb', onclick: () => setMini(true) }, ico('collapse')),
        el('button', { type: 'button', class: 'tut-x', 'aria-label': 'End the conversation', title: 'End', onclick: closeTutor }, ico('x')))),
    el('div', 'tut-stage',
      el('button', { type: 'button', class: 'tut-orb', id: 'tutOrb', 'aria-label': 'Start talking', onclick: orbTap }, el('span', 'tut-core'), el('span', 'tut-ring')),
      el('div', { class: 'tut-state', id: 'tutState', 'aria-live': 'polite' }, 'Tap the orb, then just talk.'),
      el('div', 'tut-captions',
        el('p', { class: 'tut-you', id: 'tutYou' }),
        el('p', { class: 'tut-says', id: 'tutSays' }, `Hi, I’m J.A.R.V.I.S. Ask me anything about ${course.name}, or tell me what you’re stuck on.`),
        el('div', { class: 'tut-src', id: 'tutSrc' }))),
    el('div', 'tut-bar',
      el('button', { type: 'button', class: 'tut-btn', id: 'tutMute', 'aria-pressed': 'false', onclick: toggleMute }, ico('speaker', 16), el('span', '', 'Mute mic')),
      el('form', { class: 'tut-type', onsubmit: (e) => { e.preventDefault(); const i = e.target.querySelector('input'); const t = i.value.trim(); i.value = ''; if (t) { stopListening(); turn(t); } } },
        el('input', { placeholder: 'Or type to J.A.R.V.I.S.…', 'aria-label': 'Type a message', autocomplete: 'off' })),
      el('button', { type: 'button', class: 'tut-btn end', onclick: closeTutor }, 'End')));
  document.body.append(T.root);
  addEventListener('keydown', onKey);
  requestAnimationFrame(() => T.root.classList.add('in'));
  dragOrb(document.getElementById('tutOrb'));
  document.getElementById('tutOrb').focus();
}

export function closeTutor() {
  if (!T.root) return;
  T.state = 'closed';
  stopListening(true);
  stopSpeaking();
  if (T.ctrl) T.ctrl.abort();
  if (T.stream) T.stream.getTracks().forEach((t) => t.stop());
  if (T.ac) T.ac.close().catch(() => {});
  if (T.raf) cancelAnimationFrame(T.raf);
  removeEventListener('keydown', onKey);
  T.root.remove();
  Object.assign(T, { root: null, stream: null, ac: null, analyser: null, raf: 0, ctrl: null });
}

function onKey(e) { if (e.key === 'Escape' && !T.mini) setMini(true); } // Esc shrinks to the orb; End ends

/* ---------- just the orb ---------- */

const POS_KEY = 'edu:orb';
function setMini(on) {
  if (!T.root) return;
  T.mini = on;
  T.root.classList.toggle('mini', on);
  T.root.setAttribute('aria-modal', on ? 'false' : 'true');
  const orb = $('tutOrb');
  if (on) {
    let pos = null;
    try { pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch { /* default */ }
    place(pos ? pos.x : innerWidth - 104, pos ? pos.y : innerHeight - 124);
    orb.setAttribute('aria-label', 'J.A.R.V.I.S. (tap to open the conversation, drag to move)');
    orb.title = 'J.A.R.V.I.S. · tap to open, drag to move';
  } else {
    T.root.style.removeProperty('left'); T.root.style.removeProperty('top');
    orb.title = '';
    setState(T.state, $('tutState').textContent);
  }
}
function place(x, y) {
  const s = 84, m = 8;
  x = Math.max(m, Math.min(innerWidth - s - m, x));
  y = Math.max(m, Math.min(innerHeight - s - m, y));
  T.root.style.left = `${x}px`;
  T.root.style.top = `${y}px`;
  return { x, y };
}
function dragOrb(orb) {
  orb.addEventListener('pointerdown', (e) => {
    if (!T.mini) return;
    const r = T.root.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top, sx = e.clientX, sy = e.clientY;
    T.dragged = false;
    orb.setPointerCapture(e.pointerId);
    const move = (ev) => {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 6) T.dragged = true;
      if (T.dragged) place(ev.clientX - dx, ev.clientY - dy);
    };
    const up = () => {
      orb.removeEventListener('pointermove', move);
      if (T.dragged) { const r2 = T.root.getBoundingClientRect(); try { localStorage.setItem(POS_KEY, JSON.stringify({ x: r2.left, y: r2.top })); } catch { /* this visit only */ } }
    };
    orb.addEventListener('pointermove', move);
    orb.addEventListener('pointerup', up, { once: true });
  });
  addEventListener('resize', () => { if (T.mini && T.root) { const r = T.root.getBoundingClientRect(); place(r.left, r.top); } });
}
const $ = (id) => document.getElementById(id);
function setState(s, words) {
  T.state = s;
  if (!T.root) return;
  T.root.dataset.state = s;
  $('tutState').textContent = words;
  if (!T.mini) $('tutOrb').setAttribute('aria-label', s === 'speaking' ? 'Interrupt' : s === 'listening' ? 'Listening' : 'Start talking');
}

/* ---------- the mic: level (for the orb and barge-in), then recognition or recording ---------- */

async function orbTap() {
  if (T.mini) { if (!T.dragged) setMini(false); T.dragged = false; return; }
  if (T.state === 'speaking') { stopSpeaking(); listen(); return; }
  if (T.state === 'idle' || T.state === 'paused') {
    try { await mic(); } catch { setState('idle', 'Eden needs the microphone to talk. You can also type below.'); return; }
    if (!T.greeted) { T.greeted = true; say($('tutSays').textContent); return; } // says hello, then listens
    listen();
  }
}

async function mic() {
  if (T.stream) return;
  T.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  T.ac = T.ac || new (window.AudioContext || window.webkitAudioContext)(); // the one the voice plays on, if it's already there
  const src = T.ac.createMediaStreamSource(T.stream);
  T.analyser = T.ac.createAnalyser();
  T.analyser.fftSize = 1024;
  src.connect(T.analyser);
  T.out = T.ac.createAnalyser(); // the voice's level, for the orb while speaking
  T.out.fftSize = 512;
  T.out.connect(T.ac.destination);
  T.floor = 0.01;
  const buf = new Float32Array(T.analyser.fftSize);
  const obuf = new Float32Array(T.out.fftSize);
  let loud = 0;
  const tick = () => {
    if (!T.root) return;
    T.analyser.getFloatTimeDomainData(buf);
    let m = 0; for (const v of buf) m += v * v; m = Math.sqrt(m / buf.length);
    T.out.getFloatTimeDomainData(obuf);
    let o = 0; for (const v of obuf) o += v * v; o = Math.sqrt(o / obuf.length);
    if (T.state !== 'speaking') T.floor = T.floor * 0.995 + Math.min(m, 0.05) * 0.005; // the room
    T.level = m;
    const show = T.state === 'speaking' ? o * 6 : T.state === 'listening' && !T.muted ? m * 8 : 0;
    T.root.style.setProperty('--lvl', Math.min(1, show).toFixed(3));
    // barge-in: your voice over J.A.R.V.I.S.'s, well above the room, for ~200 ms
    if (T.state === 'speaking' && !T.muted && m > Math.max(0.05, T.floor * 5)) { if (++loud > 12) { loud = 0; stopSpeaking(); listen(); } } else loud = 0;
    if (T.recording) vad(m);
    T.raf = requestAnimationFrame(tick);
  };
  T.raf = requestAnimationFrame(tick);
}

function listen() {
  if (!T.root || T.state === 'closed') return;
  T.heard = '';
  $('tutYou').textContent = '';
  if (T.muted) { setState('paused', 'Mic muted. Type below, or unmute to talk.'); return; }
  setState('listening', 'Listening…');
  const R = Recognition();
  if (R && !T.noRecognition) recognize(R); else record();
}

function recognize(R) {
  const rec = new R();
  rec.lang = navigator.language || 'en-US';
  rec.continuous = true;
  rec.interimResults = true;
  let finalText = '';
  let timer = 0;
  const commit = () => { const t = (finalText || T.heard).trim(); stopListening(); if (t) turn(t); else listen(); };
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
    }
    T.heard = `${finalText}${interim}`;
    $('tutYou').textContent = T.heard;
    clearTimeout(timer);
    // the recognizer already decided the words are final: a short pause ends the turn; still
    // mid-phrase (only interim words): wait a little longer before deciding you've stopped
    timer = setTimeout(commit, interim.trim() ? PAUSE_MS : FINAL_PAUSE_MS);
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { T.noRecognition = true; if (T.state === 'listening') record(); }
  };
  rec.onend = () => { if (T.rec === rec && T.state === 'listening') { try { rec.start(); } catch { /* restarting */ } } }; // it stops on its own after a while
  T.rec = rec;
  T.recTimer = () => clearTimeout(timer);
  try { rec.start(); } catch { /* already */ }
}

/* where there's no recognition: record, and let the server transcribe each pause */
function record() {
  if (!window.MediaRecorder || !T.stream) { setState('paused', 'This browser can’t listen. Type below instead.'); return; }
  const type = recordingType((t) => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(T.stream, type ? { mimeType: type } : undefined);
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  rec.onstop = async () => {
    T.recording = null;
    if (T.state !== 'transcribing') return;
    const blob = new Blob(parts, { type: rec.mimeType || 'audio/webm' });
    try {
      const res = await fetch(apiUrl('/api/chat/transcribe'), { method: 'POST', headers: { 'content-type': blob.type.split(';')[0], 'X-Jarvis-Chat': '1' }, body: blob });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'Couldn’t hear that.');
      const t = String(j.text || '').trim();
      if (t) { $('tutYou').textContent = t; turn(t); } else listen();
    } catch (e) { setState('paused', e.message); }
  };
  T.recording = { rec, spoke: false, quietSince: 0, started: performance.now() };
  rec.start(250);
}
function vad(m) {
  const r = T.recording;
  if (!r || T.state !== 'listening') return;
  const now = performance.now();
  if (m > Math.max(0.03, T.floor * 3)) { r.spoke = true; r.quietSince = 0; $('tutYou').textContent = 'Listening…'; }
  else if (r.spoke) {
    if (!r.quietSince) r.quietSince = now;
    if (now - r.quietSince > PAUSE_MS + 200) { setState('transcribing', 'One moment…'); r.rec.stop(); }
  }
  if (now - r.started > 110e3) { setState('transcribing', 'One moment…'); r.rec.stop(); } // the server's two-minute limit
}

function stopListening(drop = false) {
  if (T.rec) { const r = T.rec; T.rec = null; if (T.recTimer) T.recTimer(); try { r.abort(); } catch { /* done */ } }
  if (T.recording && drop) { const r = T.recording; T.recording = null; try { r.rec.stop(); } catch { /* done */ } }
}

function toggleMute() {
  T.muted = !T.muted;
  const b = $('tutMute');
  b.setAttribute('aria-pressed', String(T.muted));
  b.querySelector('span').textContent = T.muted ? 'Unmute' : 'Mute mic';
  if (T.muted) { stopListening(true); if (T.state === 'listening') setState('paused', 'Mic muted. Type below, or unmute to talk.'); }
  else if (T.state === 'paused' || T.state === 'idle') orbTap();
}

/* ---------- a turn: the question to the course, the answer spoken as it streams ---------- */

async function turn(text) {
  if (!T.root) return;
  if (!T.ac) T.ac = new (window.AudioContext || window.webkitAudioContext)();
  if (T.ac.state === 'suspended') T.ac.resume().catch(() => {});
  $('tutYou').textContent = text;
  $('tutSays').textContent = '';
  $('tutSrc').replaceChildren();
  setState('thinking', 'Thinking…');
  const history = T.history.slice(-12);
  T.ctrl = new AbortController();
  let answer = '', sentTo = 0, grounding = null, error = null;
  // The voice gets whole sentences, two or three at a time, cut only where a sentence has really
  // ended (its full stop followed by the next sentence's first letter), in the answer as written.
  // Every clip is voiced as a finished thought, so cutting anywhere else (mid-word, at "2." of
  // "2.5") makes it sound as if each piece ended with a full stop.
  const speakMore = (final) => {
    const raw = stripSources(answer);
    let end = raw.length;
    if (!final) {
      const want = sentTo === 0 ? 12 : 140; // the first sentence as soon as it's whole, then fuller phrases
      end = -1;
      const re = /[.!?…]["”’)\]]*\s+(?=["“‘(]?[A-Z0-9])/g;
      re.lastIndex = sentTo;
      for (let m; (m = re.exec(raw));) if (m.index + m[0].length - sentTo >= want) end = m.index + m[0].length;
      if (end < 0) return;
    }
    const piece = speechText(raw.slice(sentTo, end)).replace(/\s+/g, ' ').trim();
    sentTo = end;
    if (piece) for (const p of chunkText(piece, { max: 590, first: 590 })) say(p);
  };
  T.streaming = true;
  try {
    await api.send({ messages: [...history, { role: 'user', content: text }], course: T.course.id, courseTask: 'tutor', temporary: true, mode: 'chat' }, {
      signal: T.ctrl.signal,
      onEvent: (type, d) => {
        if (type === 'text') { answer += d.text || ''; $('tutSays').textContent = speechText(stripSources(answer)); speakMore(false); }
        else if (type === 'grounding') grounding = d;
        else if (type === 'error') error = d.message;
      },
    });
  } catch (e) { if (e.name !== 'AbortError') error = e.message; }
  T.streaming = false;
  if (!T.root || T.ctrl.signal.aborted) return;
  if (error && !answer) { setState('paused', error); $('tutSays').textContent = 'Sorry, I lost that. Say it again?'; say('Sorry, I lost that. Could you say it again?'); return; }
  speakMore(true);
  if (grounding && grounding.sources && grounding.sources.length) $('tutSrc').replaceChildren(groundingStrip(grounding, T.course.id));
  T.history.push({ role: 'user', content: text }, { role: 'assistant', content: stripSources(answer) });
  if (T.chat && T.save) {
    T.chat.messages.push({ role: 'user', text }, { role: 'assistant', text: answer, grounding, meta: 'Spoken with J.A.R.V.I.S.' });
    T.chat.updated = Date.now();
    T.save(T.chat);
  }
  if (!T.queue.length && !T.playing) { T.state = 'done'; afterSpeaking(); }
}

/* ---------- the voice: J.A.R.V.I.S.'s, a sentence at a time; the browser's if it isn't there ---------- */

T.queue = [];
// Each phrase is fetched as soon as it's ready (the next ones while one plays) as raw PCM (16-bit,
// 24 kHz, mono) and played *as it arrives*: the first sound comes with the voice's first bytes, not
// after the whole clip is made. Pieces are scheduled back to back on one clock, so there are no gaps.
const RATE = 24000;
function say(text) {
  if (!text.trim()) return;
  const job = { text, chunks: [], done: false, failed: false, wake: null };
  job.p = streamClip(job);
  T.queue.push(job);
  if (T.state !== 'speaking' && T.state !== 'closed') setState('speaking', 'Speaking · talk to interrupt');
  pump();
}
async function streamClip(job) {
  try {
    if (T.noVoice) throw new Error('no voice');
    const res = await fetch(apiUrl('/api/chat/voice'), { method: 'POST', headers: { 'content-type': 'application/json', 'X-Jarvis-Chat': '1' }, body: JSON.stringify({ text: job.text, format: 'pcm' }), signal: (T.voiceCtrl = T.voiceCtrl || new AbortController()).signal });
    if (!res.ok || !res.body) { if ([402, 429, 503].includes(res.status)) T.noVoice = true; throw new Error('voice'); }
    const reader = res.body.getReader();
    let carry = null; // an odd byte left over between network chunks
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let bytes = value;
      if (carry) { const b = new Uint8Array(carry.length + value.length); b.set(carry); b.set(value, carry.length); bytes = b; carry = null; }
      if (bytes.length % 2) { carry = bytes.slice(-1); bytes = bytes.slice(0, -1); }
      if (!bytes.length) continue;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
      const f = new Float32Array(bytes.length / 2);
      for (let i = 0; i < f.length; i++) f[i] = view.getInt16(i * 2, true) / 32768;
      job.chunks.push(f);
      if (job.wake) job.wake();
    }
  } catch (e) {
    if (e.name !== 'AbortError') job.failed = true;
  }
  job.done = true;
  if (job.wake) job.wake();
}
const nextChunk = (job) => new Promise((r) => { job.wake = () => { job.wake = null; r(); }; });

async function pump() {
  if (T.playing || !T.queue.length || !T.root) return;
  T.playing = true;
  const job = T.queue[0];
  const ac = T.ac || (T.ac = new (window.AudioContext || window.webkitAudioContext)());
  if (ac.state === 'suspended') ac.resume().catch(() => {});
  T.sources = T.sources || [];
  let at = Math.max(ac.currentTime + 0.03, T.playhead || 0);
  let i = 0;
  // the voice, piece by piece as it streams in
  for (;;) {
    if (T.queue[0] !== job) { T.playing = false; return; } // stopped meanwhile
    if (i < job.chunks.length) {
      const f = job.chunks[i++];
      const buf = ac.createBuffer(1, f.length, RATE);
      buf.copyToChannel(f, 0);
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.connect(T.out || ac.destination);
      if (at < ac.currentTime) at = ac.currentTime + 0.01; // fell behind: catch up rather than overlap
      src.start(at);
      at += buf.duration;
      T.sources.push(src);
      src.onended = () => { const k = T.sources.indexOf(src); if (k >= 0) T.sources.splice(k, 1); };
      continue;
    }
    if (job.done) break;
    await nextChunk(job);
  }
  T.playhead = at;
  const done = () => { if (T.queue[0] === job) T.queue.shift(); T.playing = false; if (T.queue.length) pump(); else afterSpeaking(); };
  if (job.failed && !job.chunks.length) { // no J.A.R.V.I.S. voice: the browser's own reads this phrase
    if (!window.speechSynthesis) { done(); return; }
    const u = new SpeechSynthesisUtterance(job.text);
    const v = speechSynthesis.getVoices().find((x) => /en-GB/i.test(x.lang) && /daniel|arthur|male|google uk/i.test(x.name)) || speechSynthesis.getVoices().find((x) => /en-GB/i.test(x.lang));
    if (v) u.voice = v;
    u.rate = 1.03;
    u.onend = done; u.onerror = done;
    speechSynthesis.speak(u);
    return;
  }
  // this phrase is all scheduled: the next one (already streaming, or still to come) goes on right
  // after its last sample; J.A.R.V.I.S. listens again only once nothing is left to say
  if (T.queue[0] === job) T.queue.shift();
  T.playing = false;
  if (T.queue.length) { pump(); return; }
  clearTimeout(T.endTimer);
  T.endTimer = setTimeout(() => { if (!T.queue.length && !T.playing) { T.playhead = 0; afterSpeaking(); } }, Math.max(0, at - ac.currentTime) * 1000 + 60);
}
function stopSpeaking() {
  T.queue = [];
  if (T.voiceCtrl) { T.voiceCtrl.abort(); T.voiceCtrl = null; }
  for (const src of T.sources || []) { try { src.onended = null; src.stop(); } catch { /* done */ } }
  T.sources = [];
  T.playhead = 0;
  clearTimeout(T.endTimer);
  if (window.speechSynthesis) speechSynthesis.cancel();
  T.playing = false;
}
function afterSpeaking() {
  if (!T.root || T.streaming) return; // more of the answer is on its way
  if (T.stream) listen(); else setState('idle', 'Tap the orb to talk, or type below.');
}
