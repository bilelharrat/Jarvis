// J.A.R.V.I.S.'s voice in Eden (ROADMAP G7; the owner asked for it on 2026-10-06, which
// supersedes "voice stays in Jarvis"):
//  - Dictate: the mic inside the input bar, next to send, as in Jarvis Code. The browser's own
//    speech recognition (SpeechRecognition / webkitSpeechRecognition) with live interim text;
//    the microphone is asked for only on a click. No recognition (Firefox): the mic records
//    instead (MediaRecorder, two minutes at most) and POST /api/chat/transcribe turns the
//    recording into words (G7.2): on the Mac J.A.R.V.I.S.'s own Whisper, on askeden.com Workers
//    AI's Whisper on the account's allowance. Talk mode still needs recognition.
//  - Read aloud: a button on each reply, and Settings › Appearance › Read replies aloud, which
//    starts as the reply streams in. POST /api/chat/voice: on the Mac, src/chat/voice.ts (the
//    JARVIS voice on J.A.R.V.I.S.'s allowance for this Mac, else the Mac's own voice); on
//    askeden.com the Worker, on the account's daily voice allowance. One sentence-sized WAV
//    per request, the next ones fetched while one plays, played with Web Audio (no media
//    element: the page CSP stays as it is). Code blocks are never read (voice-text.js).
//  - Talk: a glass overlay that listens, sends when you pause (or on "Send now"), reads the
//    reply aloud from its first sentences, then listens again. Speaking over the voice stops
//    it (barge-in, from the mic's level, echo-cancelled). Esc or End closes it.

import { $, el, ico, toast, store } from './util.js';
import { state, ui, nodeText } from './state.js';
import { apiUrl, isMock } from './api.js';
import { speechChunks, chunkText, speechText, safeCut, recordingType, MAX_RECORDING_S } from './voice-text.js';

const prefs = { autoRead: false, ...store.get('jchat:voice', {}) };
const savePrefs = () => store.set('jchat:voice', prefs);
const Recognition = () => window.SpeechRecognition || window.webkitSpeechRecognition || null;
// Recording for the server to transcribe, where there's no recognition (Firefox).
const Recorder = () => (window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? window.MediaRecorder : null);
const speechLang = () => navigator.language || 'en-US';
const HOSTED = !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const MIC_BLOCKED = 'Eden can’t use the microphone. Allow it for this site in the browser’s settings.';

/* ---------- audio out ---------- */
let actx = null;
let outLevel = null; // what's playing, for the talk meter
function audio() {
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    actx = new AC();
    outLevel = actx.createAnalyser();
    outLevel.fftSize = 512;
    outLevel.connect(actx.destination);
  }
  if (actx.state === 'suspended') actx.resume().catch(() => {});
  return actx;
}

let noteShown = false;
async function fetchVoice(text, signal) {
  const path = '/api/chat/voice';
  const init = { method: 'POST', headers: { 'content-type': 'application/json', 'X-Jarvis-Chat': '1' }, body: JSON.stringify({ text }), signal };
  let res;
  try {
    res = isMock ? await (await import('./mock.js')).mockFetch(path, init) : await fetch(apiUrl(path), init);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('Can’t reach the voice.');
  }
  if (!res.ok) {
    let msg = `The voice said ${res.status}.`;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  const note = res.headers.get('x-eden-voice-note'); // on the Mac: why the Mac's voice reads instead
  if (note && !noteShown) { noteShown = true; try { toast(decodeURIComponent(note)); } catch { /* malformed */ } }
  return res.arrayBuffer();
}

/**
 * One reading at a time: pieces of text in, audio out in order. onDone(reason): 'done' (all
 * read), 'stopped' (stop() or another reading) or 'error' (said in a toast).
 */
const speaker = {
  id: null, jobs: [], ended: false, source: null, waiting: false, ctrl: null, onDone: null, playing: false,
  start(id, onDone) {
    this.stop();
    this.id = id;
    this.ctrl = new AbortController();
    this.onDone = onDone || null;
    paintSpeak();
  },
  push(text) { if (this.id) { this.jobs.push({ text }); this.pump(); } },
  end() { if (this.id) { this.ended = true; this.pump(); } },
  pump() {
    const ac = audio();
    if (!ac) return this.close('error', new Error('This browser can’t play audio.'));
    const ctrl = this.ctrl;
    for (const job of this.jobs.slice(0, 3)) {
      if (job.p) continue;
      job.p = fetchVoice(job.text, ctrl.signal).then((b) => ac.decodeAudioData(b));
      job.p.catch(() => {});
    }
    if (this.source || this.waiting) return;
    const job = this.jobs[0];
    if (!job) { if (this.ended) this.close('done'); return; }
    this.waiting = true;
    job.p.then((buf) => {
      if (ctrl !== this.ctrl) return;
      this.waiting = false;
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.connect(outLevel);
      src.onended = () => {
        if (this.source !== src) return;
        this.source = null;
        this.jobs.shift();
        this.pump();
      };
      this.source = src;
      this.playing = true;
      src.start();
      paintSpeak();
    }, (e) => {
      if (ctrl !== this.ctrl || e.name === 'AbortError') return;
      this.close('error', e);
    });
  },
  stop() { if (this.id) this.close('stopped'); },
  close(reason, err) {
    const done = this.onDone;
    if (this.ctrl) this.ctrl.abort();
    const src = this.source;
    Object.assign(this, { id: null, jobs: [], ended: false, source: null, waiting: false, ctrl: null, onDone: null, playing: false });
    if (src) { try { src.stop(); } catch { /* not started */ } }
    reader = null;
    if (reason === 'error') toast((err && err.message) || 'The voice stopped.');
    paintSpeak();
    if (done) done(reason, err);
  },
};

/** Is this reply being read aloud (render.js: the button's state)? */
export function isSpeaking(id) { return speaker.id === id; }

function paintSpeak() {
  for (const b of document.querySelectorAll('[data-act="speak"]')) {
    const m = b.closest('.msg');
    const on = !!m && speaker.id === m.dataset.id;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    b.title = on ? 'Stop reading' : 'Read aloud';
  }
  paintTalk();
}

/* ---------- following a reply as it streams ---------- */
let reader = null; // { id, from, started }: how far into the reply's text has gone to the voice
function readAlong(id, onDone) {
  audio();
  speaker.start(id, onDone);
  reader = { id, from: 0, started: false };
}
function follow(node, final) {
  if (!reader || reader.id !== node.id) return;
  const text = nodeText(node);
  const cut = safeCut(text, reader.from, final);
  const spoken = speechText(text.slice(reader.from, cut));
  // the first sentence goes at once; after that, pieces of a few sentences (fewer requests)
  if (!final && spoken.length < (reader.started ? 80 : 12)) return;
  reader.from = cut;
  if (spoken) { reader.started = true; chunkText(spoken).forEach((t) => speaker.push(t)); }
  if (final) speaker.end();
}

const seen = new Set(); // replies already considered for reading
function onUpdate(c, node, opts = {}) {
  if (!node || node.role !== 'assistant' || c !== state.current) return;
  if (!seen.has(node.id)) {
    const fresh = node.streaming || (opts.final && node.doneAt && Date.now() - node.doneAt < 3000);
    if (fresh) {
      seen.add(node.id);
      if (talk.on && talk.awaiting) {
        talk.awaiting = false;
        talk.replyId = node.id;
        setTalk('replying');
        readAlong(node.id, afterReply);
      } else if (!talk.on && prefs.autoRead && c.kind !== 'code') readAlong(node.id);
    }
  }
  const final = !!opts.final || !node.streaming;
  follow(node, final);
  if (talk.on && talk.replyId === node.id) {
    talk.reply = speechText(nodeText(node)) || (node.error ? '' : '…');
    if (node.error) talk.reply = node.error;
    paintTalk();
  }
}

/* ---------- Read aloud on a reply ---------- */
function onSpeakClick(e) {
  const b = e.target.closest('[data-act="speak"]');
  if (!b) return;
  const m = b.closest('.msg');
  const c = state.current;
  const node = c && m && c.nodes[m.dataset.id];
  if (!node) return;
  if (speaker.id === node.id) { speaker.stop(); return; }
  const chunks = speechChunks(nodeText(node));
  if (!chunks.length) { toast('Nothing to read aloud here: it’s all code.'); return; }
  audio();
  speaker.start(node.id);
  chunks.forEach((t) => speaker.push(t));
  speaker.end();
}

/* ---------- Dictate ---------- */
const dict = { rec: null, base: '', said: '', busy: false };
function writeDictation(words) {
  const ta = $('deck-input');
  const w = words.replace(/^\s+/, '');
  const sep = dict.base && w && !/\s$/.test(dict.base) ? ' ' : '';
  ta.value = dict.base + sep + w;
  ta.dispatchEvent(new Event('input', { bubbles: true })); // the composer grows and routes it
  ta.selectionStart = ta.selectionEnd = ta.value.length;
}
// Speech recognition this browser has but won't run (Chrome on iPhone: the microphone is allowed,
// yet recognition says "not allowed"): record and transcribe instead, from then on.
let recognitionRefused = false;
function startDictation() {
  const R = recognitionRefused ? null : Recognition();
  if (!R) { startRecording(); return; }
  if (talk.on) return;
  speaker.stop();
  const ta = $('deck-input');
  const rec = new R();
  rec.lang = speechLang();
  rec.continuous = true;
  rec.interimResults = true;
  dict.rec = rec;
  dict.base = ta.value;
  dict.said = '';
  rec.onresult = (e) => {
    if (dict.rec !== rec) return;
    let fin = '';
    let mid = '';
    for (const r of e.results) { if (r.isFinal) fin += r[0].transcript; else mid += r[0].transcript; }
    dict.said = fin;
    writeDictation(fin + mid);
  };
  rec.onerror = (e) => {
    if (dict.rec !== rec) return;
    if ((e.error === 'not-allowed' || e.error === 'service-not-allowed') && Recorder() && !dict.said) {
      // Not necessarily the microphone: record instead (startRecording says so if the microphone is blocked).
      recognitionRefused = true;
      dict.rec = null;
      try { rec.abort(); } catch { /* ended */ }
      paintMic();
      startRecording();
    } else if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast(MIC_BLOCKED);
    else if (e.error === 'audio-capture') toast('No microphone found.');
    else if (e.error === 'network') toast('Dictation needs the network in this browser.');
  };
  rec.onend = () => {
    if (dict.rec !== rec) return;
    dict.rec = null;
    writeDictation(dict.said);
    paintMic();
  };
  try { rec.start(); } catch { dict.rec = null; toast('Dictation couldn’t start.'); }
  ta.focus();
  paintMic();
}
/** Stop dictating. keep: leave the text as it is now (typing, sending) instead of the final words. */
function stopDictation(keep = false) {
  const rec = dict.rec;
  if (!rec) return false;
  if (keep) { dict.rec = null; try { rec.abort(); } catch { /* ended */ } }
  else { try { rec.stop(); } catch { /* ended */ } }
  paintMic();
  return true;
}
function paintMic() {
  const b = $('jc-dictate');
  if (!b) return;
  const on = !!dict.rec;
  b.classList.toggle('live', on);
  b.classList.toggle('busy', dict.busy);
  b.disabled = dict.busy;
  b.setAttribute('aria-pressed', String(on));
  b.title = dict.busy ? 'Transcribing…' : on ? 'Stop dictating' : 'Dictate: say it, then read it and send';
}

/* Dictation by recording (no speech recognition here): record, then the server transcribes. */
async function startRecording() {
  const R = Recorder();
  if (!R) { toast('This browser can’t record from the microphone.'); return; }
  if (talk.on || dict.rec || dict.busy) return;
  speaker.stop();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    toast(e && e.name === 'NotFoundError' ? 'No microphone found.' : MIC_BLOCKED);
    return;
  }
  const type = recordingType((t) => R.isTypeSupported && R.isTypeSupported(t));
  let recorder;
  try {
    recorder = new R(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    toast('Dictation couldn’t start.');
    return;
  }
  const chunks = [];
  let keep = true;
  const began = Date.now();
  const cap = setTimeout(() => { toast('Two minutes is the most: transcribing what you said.'); stop(); }, MAX_RECORDING_S * 1000);
  const stop = () => { if (recorder.state !== 'inactive') recorder.stop(); };
  // stopDictation's handle: stop() transcribes, abort() (typing, sending) drops the recording.
  const rec = { recording: true, stop, abort: () => { keep = false; stop(); } };
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    clearTimeout(cap);
    stream.getTracks().forEach((t) => t.stop());
    if (dict.rec === rec) dict.rec = null;
    paintMic();
    if (keep && chunks.length) transcribe(new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' }), (Date.now() - began) / 1000);
  };
  recorder.onerror = () => { keep = false; toast('The recording stopped.'); stop(); };
  dict.rec = rec;
  recorder.start(1000);
  toast('Recording… press the mic again when you’re done.');
  $('deck-input').focus();
  paintMic();
}

async function transcribe(blob, seconds) {
  dict.busy = true;
  paintMic();
  const path = '/api/chat/transcribe';
  const init = { method: 'POST', headers: { 'content-type': blob.type.split(';')[0] || 'audio/webm', 'X-Jarvis-Chat': '1', 'X-Eden-Seconds': String(Math.round(seconds)), 'X-Eden-Lang': speechLang() }, body: blob };
  try {
    const res = isMock ? await (await import('./mock.js')).mockFetch(path, init) : await fetch(apiUrl(path), init);
    let j = null;
    try { j = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) { toast((j && j.error) || `Dictation said ${res.status}.`); return; }
    const words = String((j && j.text) || '').trim();
    if (!words) { toast('Nothing was heard. Try again a little closer to the microphone.'); return; }
    dict.base = $('deck-input').value; // what was typed meanwhile stays
    writeDictation(words);
  } catch {
    toast('Can’t reach Eden to transcribe that.');
  } finally {
    dict.busy = false;
    paintMic();
  }
}

/* ---------- Talk ---------- */
const PAUSE_MS = 1200; // this long without new words after you speak: the turn is sent
const talk = {
  on: false, state: 'off', rec: null, heard: '', mid: '', pauseT: 0, awaiting: false, replyId: null, reply: '', error: '',
  stream: null, src: null, mic: null, raf: 0, floor: 0.01, loudFrames: 0, ends: 0, box: null, back: null,
};

function talkBox() {
  if (talk.box) return talk.box;
  const box = el('div', { class: 'talk', id: 'talk', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Talk with Eden', hidden: true },
    el('div', 'talk-card glass',
      el('div', 'talk-top',
        el('span', 'talk-title', 'Talk'),
        el('span', 'talk-voice', HOSTED ? 'JARVIS voice · your account’s daily allowance' : 'JARVIS voice'),
        el('button', { type: 'button', class: 'iconbtn talk-x', id: 'talkX', title: 'End (Esc)', 'aria-label': 'End talking', onclick: () => closeTalk() }, ico('x'))),
      el('button', { type: 'button', class: 'talk-orb', id: 'talkOrb', 'aria-label': 'Interrupt', onclick: () => { if (talk.state === 'replying') bargeIn(); } },
        el('span', 'talk-ring'), el('span', 'talk-core')),
      el('div', { class: 'talk-state', id: 'talkState', 'aria-live': 'polite' }),
      el('div', { class: 'talk-you', id: 'talkYou' }),
      el('div', { class: 'talk-reply', id: 'talkReply' }),
      el('div', 'talk-acts',
        el('button', { type: 'button', class: 'btn primary', id: 'talkSend', onclick: () => sendTalk() }, 'Send now'),
        el('button', { type: 'button', class: 'btn', id: 'talkEnd', onclick: () => closeTalk() }, 'End'))));
  document.body.append(box);
  talk.box = box;
  return box;
}

function setTalk(s) { talk.state = s; paintTalk(); }
function paintTalk() {
  if (!talk.box || !talk.on) return;
  const s = talk.state;
  const speaking = s === 'replying' && speaker.playing;
  talk.box.dataset.state = speaking ? 'speaking' : s;
  $('talkState').textContent = talk.error && s === 'listening' ? talk.error
    : s === 'listening' ? ((talk.heard + talk.mid).trim() ? 'Listening… pause to send' : 'Listening…')
      : s === 'sending' ? 'Sending…' : speaking ? 'Speaking… talk to interrupt' : 'Thinking…';
  $('talkYou').textContent = s === 'listening' ? (talk.heard + talk.mid).trim() : talk.you || '';
  $('talkYou').classList.toggle('mid', s === 'listening' && !!talk.mid);
  const r = s === 'listening' ? '' : talk.reply;
  $('talkReply').textContent = r.length > 420 ? `…${r.slice(-420)}` : r;
  $('talkSend').hidden = s !== 'listening';
  $('talkSend').disabled = !(talk.heard + talk.mid).trim();
  $('talkOrb').setAttribute('aria-label', s === 'replying' ? 'Interrupt' : 'Level');
}

async function openTalk() {
  if (!Recognition()) { toast('Talking needs speech recognition: Chrome, Edge or Safari.'); return; }
  if (talk.on) return;
  stopDictation(true);
  speaker.stop();
  audio(); // unlocked by this click, so the reply can play later
  talkBox().hidden = false;
  Object.assign(talk, { on: true, error: '', you: '', reply: '', ends: 0, floor: 0.01, loudFrames: 0, back: document.activeElement });
  document.documentElement.classList.add('talking');
  setTalk('listening');
  $('talkX').focus();
  listen();
  // the mic's level, for the meter and barge-in (recognition works without it)
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (!talk.on) { stream.getTracks().forEach((t) => t.stop()); return; }
    const ac = audio();
    talk.stream = stream;
    talk.src = ac.createMediaStreamSource(stream);
    talk.mic = ac.createAnalyser();
    talk.mic.fftSize = 1024;
    talk.src.connect(talk.mic);
  } catch (e) {
    if (e && e.name === 'NotAllowedError') { closeTalk(); toast(MIC_BLOCKED); return; }
  }
  meter();
}

function closeTalk() {
  if (!talk.on) return false;
  talk.on = false;
  clearTimeout(talk.pauseT);
  const rec = talk.rec;
  talk.rec = null;
  if (rec) { try { rec.abort(); } catch { /* ended */ } }
  if (talk.replyId && speaker.id === talk.replyId) speaker.stop();
  cancelAnimationFrame(talk.raf);
  if (talk.stream) talk.stream.getTracks().forEach((t) => t.stop());
  if (talk.src) talk.src.disconnect();
  Object.assign(talk, { state: 'off', stream: null, src: null, mic: null, awaiting: false, replyId: null });
  talk.box.hidden = true;
  document.documentElement.classList.remove('talking');
  const back = talk.back && document.contains(talk.back) ? talk.back : $('deck-input');
  if (back) back.focus();
  return true;
}

function listen() {
  if (!talk.on) return;
  Object.assign(talk, { heard: '', mid: '', replyId: null });
  setTalk('listening');
  const rec = new (Recognition())();
  rec.lang = speechLang();
  rec.continuous = true;
  rec.interimResults = true;
  talk.rec = rec;
  rec.onresult = (e) => {
    if (talk.rec !== rec) return;
    let fin = '';
    let mid = '';
    for (const r of e.results) { if (r.isFinal) fin += r[0].transcript; else mid += r[0].transcript; }
    talk.heard = fin;
    talk.mid = mid;
    talk.error = '';
    talk.ends = 0;
    paintTalk();
    clearTimeout(talk.pauseT);
    if ((fin + mid).trim()) talk.pauseT = setTimeout(sendTalk, PAUSE_MS);
  };
  rec.onerror = (e) => {
    if (talk.rec !== rec) return;
    if (e.error === 'service-not-allowed') { closeTalk(); toast('Talk needs speech recognition, which this browser won’t run. Use the microphone button to dictate instead.'); }
    else if (e.error === 'not-allowed') { closeTalk(); toast(MIC_BLOCKED); }
    else if (e.error === 'audio-capture') talk.error = 'No microphone found.';
    else if (e.error === 'network') talk.error = 'Speech recognition needs the network in this browser.';
  };
  rec.onend = () => {
    if (talk.rec !== rec) return;
    talk.rec = null;
    if (!talk.on || talk.state !== 'listening') return;
    if ((talk.heard + talk.mid).trim()) { sendTalk(); return; }
    // the browser ends a quiet session by itself: listen again, unless it keeps failing
    if (++talk.ends > 4) { talk.error = talk.error || 'Stopped listening. Press Send now or End.'; paintTalk(); return; }
    setTimeout(() => { if (talk.on && talk.state === 'listening' && !talk.rec) listen(); }, 300);
  };
  try { rec.start(); } catch { talk.error = 'Listening couldn’t start.'; paintTalk(); }
}

function sendTalk() {
  clearTimeout(talk.pauseT);
  const text = `${talk.heard} ${talk.mid}`.replace(/\s+/g, ' ').trim();
  if (!talk.on || talk.state !== 'listening' || !text) return;
  const rec = talk.rec;
  talk.rec = null;
  if (rec) { try { rec.abort(); } catch { /* ended */ } }
  talk.you = text;
  talk.reply = '';
  talk.error = '';
  setTalk('sending');
  talk.awaiting = true;
  const ta = $('deck-input');
  ta.value = text;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  $('deck-composer').requestSubmit();
  // not sent (the composer kept the draft: no model available, a / command…): back to listening
  if (ta.value === text && talk.state === 'sending') {
    talk.awaiting = false;
    talk.error = 'That didn’t send. Try again, or type it.';
    listen();
  }
}

/** The reply was read (or failed): listen for the next turn. */
function afterReply(reason) {
  if (!talk.on || reason === 'stopped') return;
  listen();
}

function bargeIn() {
  if (!talk.on || talk.state !== 'replying') return;
  talk.replyId = null;
  speaker.stop();
  listen();
}

function rms(an) {
  const buf = new Float32Array(an.fftSize);
  an.getFloatTimeDomainData(buf);
  let s = 0;
  for (const v of buf) s += v * v;
  return Math.sqrt(s / buf.length);
}
function meter() {
  if (!talk.on) return;
  const speaking = talk.state === 'replying' && speaker.playing;
  const mic = talk.mic ? rms(talk.mic) : 0;
  const out = speaking && outLevel ? rms(outLevel) : 0;
  if (talk.mic) {
    if (talk.state !== 'replying') talk.floor = Math.max(0.003, talk.floor * 0.97 + mic * 0.03);
    // barge-in: your voice over the reply (well above the room, for ~200ms)
    if (speaking && mic > Math.max(0.045, talk.floor * 5)) { if (++talk.loudFrames > 12) { talk.loudFrames = 0; bargeIn(); } }
    else talk.loudFrames = 0;
  }
  const lvl = Math.min(1, (speaking ? out : mic) * 9);
  talk.box.style.setProperty('--lvl', lvl.toFixed(3));
  talk.raf = requestAnimationFrame(meter);
}

/* ---------- Settings › Appearance ---------- */
export function voiceSettings() {
  const sw = el('input', { type: 'checkbox', role: 'switch', 'aria-label': 'Read replies aloud' });
  sw.checked = !!prefs.autoRead;
  sw.addEventListener('change', () => {
    prefs.autoRead = sw.checked;
    savePrefs();
    if (sw.checked) audio();
    else if (reader) speaker.stop();
    toast(sw.checked ? 'Replies will be read aloud' : 'Replies won’t be read aloud');
  });
  const where = HOSTED
    ? 'On askeden.com the JARVIS voice uses your Jarvis account’s daily voice allowance (more with Jarvis Plus).'
    : 'On this Mac: the JARVIS voice, on J.A.R.V.I.S.’s daily allowance for this Mac; the Mac’s own voice when that’s used up or offline.';
  const rec = Recognition()
    ? 'Dictation and Talk use this browser’s speech recognition (Chrome sends the audio to Google to transcribe it).'
    : Recorder()
      ? `This browser has no speech recognition: Dictation records (two minutes at most) and ${HOSTED ? 'askeden.com transcribes it (Whisper on Cloudflare, counted on your Jarvis account’s included AI)' : 'J.A.R.V.I.S. on this Mac transcribes it (the audio stays on this Mac)'}. Talk needs speech recognition (Chrome, Edge or Safari).`
      : 'This browser has no speech recognition, so Dictation and Talk are off (use Chrome, Edge or Safari).';
  return el('div', 'set-sec', el('h3', '', 'Voice'),
    el('div', 'icard', el('div', 'prov',
      el('div', 'grow', el('div', 'p-n', 'Read replies aloud'), el('div', 'p-c', 'In the JARVIS voice, as each reply streams in (code is skipped). Talk mode always reads aloud.')),
      el('label', 'switch', sw, el('span', 'tr')))),
    el('p', 'sp-note', `${where} ${rec}`));
}

/* ---------- Esc, and wiring ---------- */
/** Esc in the composer: stop dictating, then stop reading aloud. */
export function voiceEscape() {
  if (stopDictation()) return true;
  if (speaker.id) { speaker.stop(); return true; }
  return false;
}

let inited = false;
export function initVoice() {
  if (inited) return;
  inited = true;
  const update = ui.updateMessage;
  ui.updateMessage = (c, node, opts) => { update(c, node, opts); onUpdate(c, node, opts); };
  $('transcript').addEventListener('click', onSpeakClick);
  const mic = $('jc-dictate');
  const talkBtn = $('jc-talk');
  if (!Recognition()) { if (mic && !Recorder()) mic.hidden = true; if (talkBtn) talkBtn.hidden = true; }
  if (mic) mic.addEventListener('click', () => (dict.rec ? stopDictation() : startDictation()));
  if (talkBtn) talkBtn.addEventListener('click', openTalk);
  const ta = $('deck-input');
  // typing or sending while dictating keeps the words as they are
  ta.addEventListener('keydown', (e) => { if (dict.rec && !dict.rec.recording && !e.metaKey && !e.ctrlKey && (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter')) stopDictation(true); }); // a recording goes on while you type (sending drops it)
  $('deck-composer').addEventListener('submit', () => stopDictation(true), true);
  // the talk overlay owns Esc (before app.js's, which would stop the reply) and keeps focus
  document.addEventListener('keydown', (e) => {
    if (!talk.on) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeTalk(); return; }
    if (e.key === 'Tab') {
      const f = [...talk.box.querySelectorAll('button:not([hidden]):not(:disabled)')];
      const i = f.indexOf(document.activeElement);
      e.preventDefault();
      f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    }
  }, true);
  // reading aloud needs audio unlocked by a gesture: any click or key while it's on
  const unlock = () => { if (prefs.autoRead) audio(); };
  document.addEventListener('pointerdown', unlock, true);
  document.addEventListener('keydown', unlock, true);
  paintMic();
}
