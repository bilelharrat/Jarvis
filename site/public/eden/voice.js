// J.A.R.V.I.S.'s voice in Eden (ROADMAP G7; the owner asked for it on 2026-10-06, which
// supersedes "voice stays in Jarvis"):
//  - Dictate: the mic inside the input bar, next to send, as in Jarvis Code. The browser's own
//    speech recognition (SpeechRecognition / webkitSpeechRecognition) with live interim text;
//    the microphone is asked for only on a click. No recognition (Firefox): the mic records
//    instead (MediaRecorder, two minutes at most) and POST /api/chat/transcribe turns the
//    recording into words (G7.2): on the Mac J.A.R.V.I.S.'s own Whisper, on askeden.com Workers
//    AI's Whisper on the account's allowance. The same where recognition exists but can't work:
//    the Mac and Windows apps (Electron: it fails with "network"), from the first try (AJ2-1).
//  - Read aloud: a button on each reply, and Settings › Appearance › Read replies aloud, which
//    starts as the reply streams in. POST /api/chat/voice: on the Mac, src/chat/voice.ts (the
//    JARVIS voice on J.A.R.V.I.S.'s allowance for this Mac, else the Mac's own voice); on
//    askeden.com the Worker, on the account's daily voice allowance. One sentence-sized WAV
//    per request, the next ones fetched while one plays, played with Web Audio (no media
//    element: the page CSP stays as it is). Code blocks are never read (voice-text.js).
//  - Talk: a glass overlay that listens, sends when you pause (or on "Send now"), reads the
//    reply aloud from its first sentences, then listens again. Speaking over the voice stops
//    it (barge-in: speech recognition hears words that aren't his, barge-in.js, or the mic's
//    level well above his echo); Space or a tap on the orb does too. Esc or End closes it.
//    Without working recognition (Firefox, the desktop apps), each turn is recorded, ends at a
//    pause in the mic's level (voice-text.js vadStep) and is transcribed as Dictate's is (AJ2-1).

import { $, el, ico, toast, store } from './util.js';
import { state, ui, nodeText } from './state.js';
import { apiUrl, isMock, addSendExtra } from './api.js';
import { watchForInterrupt, isSpaceToInterrupt } from './barge-in.js';
import { speechChunks, chunkText, speechText, safeCut, recordingType, MAX_RECORDING_S, inDesktopApp, recognitionFallback, vadStep } from './voice-text.js';
import { speechLang } from './i18n.js';
import { deadline, talkStep, talkText, DEADLINE, TALK_PAUSE_MS, TALK_MAX_MS } from './resilience.js';
import { setAsideAttachments } from './composer.js';

const prefs = { autoRead: false, ...store.get('jchat:voice', {}) };
const savePrefs = () => store.set('jchat:voice', prefs);
const Recognition = () => window.SpeechRecognition || window.webkitSpeechRecognition || null;
// Recording for the server to transcribe, where there's no recognition (Firefox).
const Recorder = () => (window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? window.MediaRecorder : null);
const HOSTED = !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const DESKTOP = inDesktopApp(); // Ask Eden for Mac or Windows, Eden in J.A.R.V.I.S.: recognition there fails (AJ2-1)
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
// One piece of speech: 15 s at most, then it fails with a message (said in a toast by the speaker)
// instead of leaving Talk on "Speaking…" (A2).
// voice: the voice this reply began in ('jarvis' or 'mac', from X-Eden-Voice on the Mac): its next
// pieces keep to it (a slow piece waits for the Eden voice instead of switching to the Mac's halfway).
const PINNED_VOICE_MS = 30_000; // src/chat/voice.ts HOSTED_PINNED_TIMEOUT_MS, then the Mac's voice
async function fetchVoice(text, signal, voice = null, onVoice = null) {
  const path = '/api/chat/voice';
  const d = deadline(voice === 'jarvis' ? PINNED_VOICE_MS : DEADLINE.voice, signal);
  const init = { method: 'POST', headers: { 'content-type': 'application/json', 'X-Jarvis-Chat': '1' }, body: JSON.stringify(voice ? { text, voice } : { text }), signal: d.signal };
  const late = () => new Error('The voice didn’t answer in time.');
  try {
    let res;
    try {
      res = isMock ? await (await import('./mock.js')).mockFetch(path, init) : await fetch(apiUrl(path), init);
    } catch (e) {
      if (d.timedOut()) throw late();
      if (e.name === 'AbortError') throw e;
      throw new Error('Can’t reach the voice.');
    }
    if (!res.ok) {
      let msg = `The voice said ${res.status}.`;
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch { /* not JSON */ }
      throw new Error(msg);
    }
    if (onVoice) onVoice(res.headers.get('x-eden-voice'));
    const note = res.headers.get('x-eden-voice-note'); // on the Mac: why the Mac's voice reads instead
    if (note && !noteShown) { noteShown = true; try { toast(decodeURIComponent(note)); } catch { /* malformed */ } }
    try { return await res.arrayBuffer(); } catch (e) { if (d.timedOut()) throw late(); throw e; }
  } finally { d.done(); }
}

/**
 * One reading at a time: pieces of text in, audio out in order. onDone(reason): 'done' (all
 * read), 'stopped' (stop() or another reading) or 'error' (said in a toast).
 */
const speaker = {
  id: null, jobs: [], ended: false, source: null, waiting: false, ctrl: null, onDone: null, playing: false,
  voice: null, // the voice this reading began in ('jarvis', 'mac', or '' where the server doesn't say)
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
    // the first piece alone until its voice is known, then up to three ahead in that voice
    for (const job of this.jobs.slice(0, this.voice === null ? 1 : 3)) {
      if (job.p) continue;
      const first = this.voice === null;
      job.p = fetchVoice(job.text, ctrl.signal, this.voice || null, first ? (v) => {
        if (ctrl !== this.ctrl || this.voice !== null) return;
        this.voice = v === 'jarvis' || v === 'mac' ? v : '';
        Promise.resolve().then(() => { if (ctrl === this.ctrl) this.pump(); });
      } : null).then((b) => ac.decodeAudioData(b));
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
    Object.assign(this, { id: null, jobs: [], ended: false, source: null, waiting: false, ctrl: null, onDone: null, playing: false, voice: null });
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
  if (!node || node.role !== 'assistant') return;
  // The reply being read (or the one Talk waits for) is followed even after you switch chats (AJ6):
  // else it never ends and Talk stays on "Thinking…" with nothing listening.
  const ours = (reader && reader.id === node.id) || (talk.on && (talk.replyId === node.id || (talk.awaiting && talk.conv && c === talk.conv)));
  if (c !== state.current && !ours) return;
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
const dict = { rec: null, base: '', said: '', busy: false, starting: null }; // starting: a recording waiting for the mic (AJ3)
function writeDictation(words) {
  const ta = $('deck-input');
  const w = words.replace(/^\s+/, '');
  const sep = dict.base && w && !/\s$/.test(dict.base) ? ' ' : '';
  ta.value = dict.base + sep + w;
  ta.dispatchEvent(new Event('input', { bubbles: true })); // the composer grows and routes it
  ta.selectionStart = ta.selectionEnd = ta.value.length;
}
// Speech recognition this browser has but won't run (Chrome on iPhone: the microphone is allowed,
// yet recognition says "not allowed"), or can't (Electron: "network"): record and transcribe
// instead, from then on. In the desktop apps, from the start (AJ2-1).
let recognitionRefused = DESKTOP;
let recognitionWorked = false; // it heard something on this page: a later failure is a passing one
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
    recognitionWorked = true;
    let fin = '';
    let mid = '';
    for (const r of e.results) { if (r.isFinal) fin += r[0].transcript; else mid += r[0].transcript; }
    dict.said = fin;
    writeDictation(fin + mid);
  };
  rec.onerror = (e) => {
    if (dict.rec !== rec) return;
    if (recognitionFallback(e.error, { worked: recognitionWorked }) && Recorder() && !dict.said) {
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
  if (!rec && dict.starting) { dict.starting.cancel = true; dict.starting = null; paintMic(); return true; } // the mic isn't open yet: it won't record
  if (!rec) return false;
  if (keep) { dict.rec = null; try { rec.abort(); } catch { /* ended */ } }
  else { try { rec.stop(); } catch { /* ended */ } }
  paintMic();
  return true;
}
function paintMic() {
  const b = $('jc-dictate');
  if (!b) return;
  const on = !!(dict.rec || dict.starting); // the mic opening counts as on: a click then stops it (AJ3)
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
  // A second click while the mic opens (a permission prompt, a slow mic) is "stop", never a second recorder (AJ3).
  if (dict.starting) { stopDictation(); return; }
  const starting = { cancel: false };
  dict.starting = starting;
  paintMic();
  speaker.stop();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    if (dict.starting === starting) dict.starting = null;
    paintMic();
    if (!starting.cancel) toast(e && e.name === 'NotFoundError' ? 'No microphone found.' : MIC_BLOCKED);
    return;
  }
  if (dict.starting === starting) dict.starting = null;
  if (starting.cancel || talk.on || dict.rec) { stream.getTracks().forEach((t) => t.stop()); paintMic(); return; }
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

/** A recording's words: { text } or { error } (POST /api/chat/transcribe, 90 s at most). Dictate and Talk. */
async function transcribeBlob(blob, seconds) {
  const path = '/api/chat/transcribe';
  const init = { method: 'POST', headers: { 'content-type': blob.type.split(';')[0] || 'audio/webm', 'X-Jarvis-Chat': '1', 'X-Eden-Seconds': String(Math.max(1, Math.round(seconds))), 'X-Eden-Lang': speechLang() }, body: blob };
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(90_000);
  try {
    const res = isMock ? await (await import('./mock.js')).mockFetch(path, init) : await fetch(apiUrl(path), init);
    let j = null;
    try { j = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) return { error: (j && j.error) || `Dictation said ${res.status}.` };
    return { text: String((j && j.text) || '').trim() };
  } catch {
    return { error: 'Can’t reach Eden to transcribe that.' };
  }
}

async function transcribe(blob, seconds) {
  dict.busy = true;
  paintMic();
  try {
    const r = await transcribeBlob(blob, seconds);
    if (r.error) { toast(r.error); return; }
    if (!r.text) { toast('Nothing was heard. Try again a little closer to the microphone.'); return; }
    dict.base = $('deck-input').value; // what was typed meanwhile stays
    writeDictation(r.text);
  } finally {
    dict.busy = false;
    paintMic();
  }
}

/* ---------- Talk ---------- */
const PAUSE_MS = TALK_PAUSE_MS; // this long without new words after you speak: the turn is sent (also at 30 s or 2,000 characters: resilience.js talkStep)
const talk = {
  on: false, state: 'off', rec: null, heard: '', mid: '', pauseT: 0, awaiting: false, replyId: null, reply: '', error: '',
  stream: null, src: null, mic: null, raf: 0, floor: 0.01, echo: 0.02, loudFrames: 0, ends: 0, box: null, back: null,
  watch: null, seed: '', turn: null,
  mini: false, dragged: false,
  session: 0, conv: null, // session: each open (AJ4); conv: the chat Talk's turn went to (AJ6)
  // AJ2-1: byRec: this session records each turn (no working recognition); recorder: the turn being
  // recorded; vad/vadT: where its end is detected; spoke: it heard you; transcribing: the turn's words are on their way
  byRec: false, recorder: null, vad: null, vadT: 0, spoke: false, transcribing: false, fails: 0,
  stopped: false, // AJ2-7: it stopped listening after failures in a row: "Listen again"
};

// In Talk mode (the Eden voice) the server answers as J.A.R.V.I.S. (turn.ts JARVIS_PERSONA).
addSendExtra(() => (talk.on ? { persona: 'jarvis' } : null));

function talkBox() {
  if (talk.box) return talk.box;
  const box = el('div', { class: 'talk', id: 'talk', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Talk with Eden', hidden: true },
    el('div', 'talk-card glass',
      el('div', 'talk-top',
        el('span', 'talk-title', 'Talk'),
        el('span', 'talk-voice', HOSTED ? 'Eden voice · your account’s daily allowance' : 'Eden voice'),
        el('button', { type: 'button', class: 'iconbtn talk-x', title: 'Shrink to the orb (keeps talking)', 'aria-label': 'Shrink to the orb (keeps talking)', onclick: () => setTalkMini(true) }, ico('collapse')),
        el('button', { type: 'button', class: 'iconbtn talk-x', id: 'talkX', title: 'End', 'aria-label': 'End talking', onclick: () => closeTalk() }, ico('x'))),
      el('button', { type: 'button', class: 'talk-orb', id: 'talkOrb', 'aria-label': 'Interrupt', onclick: orbTap },
        el('span', 'talk-ring'), el('span', 'talk-core')),
      el('div', { class: 'talk-state', id: 'talkState', 'aria-live': 'polite' }),
      el('div', { class: 'talk-you', id: 'talkYou', 'data-no-i18n': '' }),
      el('div', { class: 'talk-reply', id: 'talkReply', 'data-no-i18n': '' }),
      el('div', 'talk-acts',
        el('button', { type: 'button', class: 'btn primary', id: 'talkSend', onclick: () => (talk.stopped ? resumeTalk() : sendTalk()) }, 'Send now'),
        el('button', { type: 'button', class: 'btn', id: 'talkEnd', onclick: () => closeTalk() }, 'End'))));
  document.body.append(box);
  talk.box = box;
  dragOrb($('talkOrb'));
  return box;
}

function orbTap() {
  if (talk.mini) { if (!talk.dragged) setTalkMini(false); talk.dragged = false; resumeTalk(); return; }
  if (talk.state === 'replying') bargeIn();
  else resumeTalk();
}

/* Collapsed, Talk is just the orb: a sphere floating over the app (drag it anywhere; it stays put
   as you move around), still listening and speaking; tap it to open the card again. */
const ORB_KEY = 'eden:talk-orb';
const ORB_SIZE = 84;
function setTalkMini(on) {
  if (!talk.box || !talk.on) return;
  talk.mini = on;
  talk.box.classList.toggle('mini', on);
  talk.box.setAttribute('aria-modal', on ? 'false' : 'true');
  document.documentElement.classList.toggle('talking', !on);
  const orb = $('talkOrb');
  if (on) {
    let pos = null;
    try { pos = JSON.parse(localStorage.getItem(ORB_KEY) || 'null'); } catch { /* default */ }
    placeOrb(pos ? pos.x : innerWidth - ORB_SIZE - 20, pos ? pos.y : innerHeight - ORB_SIZE - 110);
    orb.title = 'Talk · tap to open, drag to move';
    orb.focus();
  } else {
    talk.box.style.removeProperty('left'); talk.box.style.removeProperty('top');
    orb.title = '';
    $('talkX').focus();
  }
  paintTalk();
}
function placeOrb(x, y) {
  const m = 8;
  talk.box.style.left = `${Math.max(m, Math.min(innerWidth - ORB_SIZE - m, x))}px`;
  talk.box.style.top = `${Math.max(m, Math.min(innerHeight - ORB_SIZE - m, y))}px`;
}
function dragOrb(orb) {
  orb.addEventListener('pointerdown', (e) => {
    if (!talk.mini) return;
    const r = talk.box.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top, sx = e.clientX, sy = e.clientY;
    talk.dragged = false;
    orb.setPointerCapture(e.pointerId);
    const move = (ev) => {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 6) talk.dragged = true;
      if (talk.dragged) placeOrb(ev.clientX - dx, ev.clientY - dy);
    };
    const up = () => {
      orb.removeEventListener('pointermove', move);
      if (talk.dragged) { const r2 = talk.box.getBoundingClientRect(); try { localStorage.setItem(ORB_KEY, JSON.stringify({ x: r2.left, y: r2.top })); } catch { /* this visit only */ } }
    };
    orb.addEventListener('pointermove', move);
    orb.addEventListener('pointerup', up, { once: true });
  });
  addEventListener('resize', () => { if (talk.mini && talk.box) { const r = talk.box.getBoundingClientRect(); placeOrb(r.left, r.top); } });
}

function setTalk(s) { talk.state = s; paintTalk(); }
function paintTalk() {
  if (!talk.box || !talk.on) return;
  const s = talk.state;
  const speaking = s === 'replying' && speaker.playing;
  talk.box.dataset.state = speaking ? 'speaking' : s;
  const said = (talk.heard + talk.mid).trim();
  $('talkState').textContent = talk.error && s === 'listening' ? talk.error
    : s === 'listening' ? (talk.transcribing ? 'Transcribing…' : said || talk.spoke ? 'Listening… pause to send' : 'Listening…')
      : s === 'sending' ? 'Sending…' : speaking ? 'Speaking… talk over me, or press Space, to interrupt' : 'Thinking…';
  $('talkYou').textContent = s === 'listening' ? said : talk.you || '';
  $('talkYou').classList.toggle('mid', s === 'listening' && !!talk.mid);
  const r = s === 'listening' ? '' : talk.reply;
  $('talkReply').textContent = r.length > 420 ? `…${r.slice(-420)}` : r;
  $('talkSend').hidden = s !== 'listening';
  // stopped (failures in a row, AJ2-7): the button listens again; else it sends what was heard
  $('talkSend').textContent = talk.stopped ? 'Listen again' : 'Send now';
  $('talkSend').disabled = talk.stopped ? false : talk.transcribing || !(said || (talk.byRec && talk.spoke));
  // AJ3-15: what the orb does, with Talk's state (it was "Level" while listening)
  $('talkOrb').setAttribute('aria-label', talk.mini ? `Talk, ${$('talkState').textContent} (tap to open, drag to move)` : s === 'replying' ? 'Interrupt' : `Talk, ${$('talkState').textContent} (tap to listen again)`);
}

async function openTalk() {
  if (!Recognition() && !Recorder()) { toast('Talking needs a browser that can listen: Chrome, Edge, Safari or Firefox.'); return; }
  if (talk.on) return;
  stopDictation(true);
  speaker.stop();
  audio(); // unlocked by this click, so the reply can play later
  talkBox().hidden = false;
  const session = ++talk.session; // AJ4: open, End, open: the first open's mic is stopped, never kept
  Object.assign(talk, { on: true, error: '', you: '', reply: '', ends: 0, floor: 0.01, loudFrames: 0, back: document.activeElement,
    byRec: recognitionRefused || !Recognition(), recorder: null, vad: null, spoke: false, transcribing: false, fails: 0, stopped: false });
  document.documentElement.classList.add('talking');
  setTalk('listening');
  $('talkX').focus();
  listen();
  // the mic's level, for the meter and barge-in (recognition works without it)
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (!talk.on || talk.session !== session || talk.stream) { stream.getTracks().forEach((t) => t.stop()); return; }
    const ac = audio();
    talk.stream = stream;
    talk.src = ac.createMediaStreamSource(stream);
    talk.mic = ac.createAnalyser();
    talk.mic.fftSize = 1024;
    talk.src.connect(talk.mic);
  } catch (e) {
    if (talk.session !== session) return;
    if (e && e.name === 'NotAllowedError') { closeTalk(); toast(MIC_BLOCKED); return; }
    // recording needs the microphone itself (recognition works without it)
    if (talk.byRec) { closeTalk(); toast(e && e.name === 'NotFoundError' ? 'No microphone found.' : MIC_BLOCKED); return; }
  }
  if (talk.session !== session || !talk.on) return;
  if (talk.byRec && talk.state === 'listening') recordTurn(); // the first turn waited for the microphone
  meter();
}

function closeTalk() {
  if (!talk.on) return false;
  talk.on = false;
  clearTimeout(talk.pauseT);
  const rec = talk.rec;
  talk.rec = null;
  if (rec) { try { rec.abort(); } catch { /* ended */ } }
  endTurn(false);
  if (talk.replyId && speaker.id === talk.replyId) speaker.stop();
  cancelAnimationFrame(talk.raf);
  unwatch();
  if (talk.stream) talk.stream.getTracks().forEach((t) => t.stop());
  if (talk.src) talk.src.disconnect();
  Object.assign(talk, { state: 'off', stream: null, src: null, mic: null, awaiting: false, replyId: null, mini: false, conv: null, transcribing: false, stopped: false });
  talk.box.hidden = true;
  talk.box.classList.remove('mini');
  talk.box.setAttribute('aria-modal', 'true');
  talk.box.style.removeProperty('left'); talk.box.style.removeProperty('top');
  document.documentElement.classList.remove('talking');
  const back = talk.back && document.contains(talk.back) ? talk.back : $('deck-input');
  if (back) back.focus();
  return true;
}

function listen(seed = '') {
  if (!talk.on) return;
  unwatch();
  Object.assign(talk, { heard: seed, mid: '', replyId: null, seed: seed ? `${seed} ` : '', turn: null, stopped: false });
  setTalk('listening');
  if (talk.byRec) { recordTurn(); return; } // (before the microphone is open, openTalk starts it)
  const rec = new (Recognition())();
  const began = Date.now();
  let failed = false;
  rec.lang = speechLang();
  rec.continuous = true;
  rec.interimResults = true;
  talk.rec = rec;
  rec.onresult = (e) => {
    if (talk.rec !== rec) return;
    recognitionWorked = true;
    let fin = '';
    let mid = '';
    for (const r of e.results) { if (r.isFinal) fin += r[0].transcript; else mid += r[0].transcript; }
    talk.heard = talk.seed + fin; // what you'd already said over the reply comes first
    talk.mid = mid;
    talk.error = '';
    talk.ends = 0;
    paintTalk();
    // The pause counts from the last change in what was heard: a recognizer that repeats the same
    // results doesn't hold the turn open, and one that never stops is sent at 30 s / 2,000 characters (A2).
    const step = talkStep(talk.turn, talk.heard + mid, Date.now());
    talk.turn = step.turn;
    if (step.action === 'send') { sendTalk(); return; }
    if (step.action === 'keep' && talk.pauseT) return;
    clearTimeout(talk.pauseT);
    talk.pauseT = step.action === 'none' ? 0 : setTimeout(sendTalk, PAUSE_MS);
  };
  rec.onerror = (e) => {
    if (talk.rec !== rec) return;
    failed = true;
    if (recognitionFallback(e.error, { worked: recognitionWorked }) && Recorder() && !(talk.heard + talk.mid).trim()) {
      // AJ2-1: recognition this browser won't (or can't) run here: record each turn and transcribe it instead
      recognitionRefused = true;
      talk.byRec = true;
      talk.rec = null;
      try { rec.abort(); } catch { /* ended */ }
      talk.error = '';
      listen(talk.seed.trim()); // (the microphone still opening: openTalk starts the recording once it is)
    } else if (e.error === 'service-not-allowed') { closeTalk(); toast('Talk needs speech recognition, which this browser won’t run. Use the microphone button to dictate instead.'); }
    else if (e.error === 'not-allowed') { closeTalk(); toast(MIC_BLOCKED); }
    else if (e.error === 'audio-capture') talk.error = 'No microphone found.';
    else if (e.error === 'network') talk.error = 'Speech recognition needs the network in this browser.';
  };
  rec.onend = () => {
    if (talk.rec !== rec) return;
    talk.rec = null;
    if (!talk.on || talk.state !== 'listening') return;
    if ((talk.heard + talk.mid).trim()) { sendTalk(); return; }
    // AJ2-7: hidden, the browser ends it (Safari, the iPhone): it starts again when the page is shown
    if (document.hidden) return;
    // a quiet session the browser ended by itself: listen again. One that failed or ended at once
    // counts against it: five of those in a row and it stops ("Listen again").
    if (failed || Date.now() - began < 1000) {
      if (++talk.ends > 4) { talk.stopped = true; talk.error = talk.error || 'Stopped listening. Press Listen again, or End.'; paintTalk(); return; }
    } else talk.ends = 0;
    setTimeout(() => { if (talk.on && talk.state === 'listening' && !talk.rec && !document.hidden) listen(); }, 300);
  };
  try { rec.start(); } catch { talk.error = 'Listening couldn’t start.'; paintTalk(); }
}

/** AJ2-7: listening again where it had stopped (shown again, a tap on the orb, "Listen again"). */
function resumeTalk() {
  if (!talk.on || talk.state !== 'listening' || talk.rec || talk.recorder || talk.transcribing) return;
  if (!talk.byRec && (talk.heard + talk.mid).trim()) return;
  Object.assign(talk, { ends: 0, fails: 0, stopped: false, error: '' });
  listen();
}

/* Talk by recording (AJ2-1): each turn is a recording of the microphone that ends at a pause in
   its level (or Send now), then its words are sent as recognition's would be. */
function recordTurn() {
  if (!talk.on || !talk.stream || talk.recorder || talk.transcribing || talk.state !== 'listening') return;
  const R = Recorder();
  const type = recordingType((t) => R.isTypeSupported && R.isTypeSupported(t));
  let mr;
  try {
    mr = new R(talk.stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
  } catch {
    talk.error = 'Listening couldn’t start.';
    paintTalk();
    return;
  }
  const turn = { mr, chunks: [], keep: false, began: Date.now(), session: talk.session };
  mr.ondataavailable = (e) => { if (e.data && e.data.size) turn.chunks.push(e.data); };
  mr.onstop = () => {
    if (talk.recorder === turn) talk.recorder = null;
    if (!turn.keep || !talk.on || talk.session !== turn.session) return;
    if (!turn.chunks.length) { talk.transcribing = false; recordTurn(); return; }
    hearTurn(new Blob(turn.chunks, { type: mr.mimeType || type || 'audio/webm' }), (Date.now() - turn.began) / 1000, turn.session);
  };
  Object.assign(talk, { recorder: turn, vad: null, spoke: false });
  try { mr.start(1000); } catch { talk.recorder = null; talk.error = 'Listening couldn’t start.'; paintTalk(); return; }
  clearInterval(talk.vadT);
  talk.vadT = setInterval(vadTick, 50); // not requestAnimationFrame: it goes on while the window is behind others
  paintTalk();
}
/** Stops the turn's recording; keep: its words are transcribed and sent. */
function endTurn(keep) {
  clearInterval(talk.vadT);
  talk.vadT = 0;
  const turn = talk.recorder;
  if (!turn) return;
  turn.keep = keep;
  talk.recorder = null;
  try { if (turn.mr.state !== 'inactive') turn.mr.stop(); } catch { /* stopped */ }
}
function vadTick() {
  if (!talk.on || !talk.recorder || talk.state !== 'listening') return;
  const step = vadStep(talk.vad, talk.mic ? rms(talk.mic) : 0, Date.now(), { pauseMs: PAUSE_MS, maxMs: TALK_MAX_MS });
  talk.vad = step.s;
  if (step.spoke !== talk.spoke) { talk.spoke = step.spoke; if (step.spoke) talk.error = ''; paintTalk(); }
  if (step.action === 'send') { talk.transcribing = true; paintTalk(); endTurn(true); }
  else if (step.action === 'restart') { endTurn(false); recordTurn(); }
}
async function hearTurn(blob, seconds, session) {
  talk.transcribing = true;
  paintTalk();
  const r = await transcribeBlob(blob, seconds);
  if (!talk.on || talk.session !== session) return;
  talk.transcribing = false;
  if (talk.state !== 'listening') return;
  if (r.text) {
    Object.assign(talk, { fails: 0, error: '', heard: talk.seed + r.text, mid: '' });
    sendTalk();
    return;
  }
  if (r.error) {
    talk.error = r.error;
    if (++talk.fails > 2) { talk.stopped = true; paintTalk(); return; } // "Listen again"
  }
  recordTurn(); // nothing heard (a noise): listening goes on
}

function sendTalk() {
  clearTimeout(talk.pauseT);
  talk.pauseT = 0;
  // recording a turn: Send now ends it here (its words are sent once transcribed)
  if (talk.byRec && talk.recorder) { if (talk.spoke && talk.state === 'listening') { talk.transcribing = true; paintTalk(); endTurn(true); } return; }
  const text = talkText(`${talk.heard} ${talk.mid}`);
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
  // What you typed in the composer (Talk shrunk to the orb leaves the app to you) is kept: Talk's
  // words are sent in its place, then your draft comes back (AJ5). So are the files and context you
  // added there for your own message: they wait, then come back (AJ2-6).
  const draft = ta.value;
  const restore = talk.mini ? setAsideAttachments() : null;
  ta.value = text;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  try { $('deck-composer').requestSubmit(); } finally { if (restore) restore(); }
  const sent = ta.value !== text;
  if (sent) talk.conv = state.current;
  if (draft.trim() && ta.value !== draft) {
    ta.value = draft;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  // not sent (the composer kept the draft: no model available, a / command…): back to listening
  if (!sent && talk.state === 'sending') {
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

/** You talked over the reply (or tapped the orb, or pressed Space): stop it and listen; `heard` starts your turn. */
function bargeIn(heard = '') {
  if (!talk.on || talk.state !== 'replying') return;
  talk.replyId = null;
  speaker.stop();
  listen(heard);
  if (heard) { paintTalk(); clearTimeout(talk.pauseT); talk.turn = talkStep(null, heard, Date.now()).turn; talk.pauseT = setTimeout(sendTalk, PAUSE_MS); }
}
function unwatch() { if (talk.watch) { talk.watch(); talk.watch = null; } }

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
  // while he speaks, recognition listens for your words over his (barge-in.js)
  if (speaking && !talk.watch && !talk.byRec) talk.watch = watchForInterrupt({ spoken: () => talk.reply, onInterrupt: (heard) => { talk.watch = null; bargeIn(heard); }, lang: speechLang() });
  else if (!speaking && talk.watch && talk.state !== 'replying') unwatch();
  if (talk.mic) {
    if (talk.state !== 'replying') { talk.floor = Math.max(0.003, talk.floor * 0.97 + mic * 0.03); talk.echo = 0.02; }
    else if (speaking) talk.echo = talk.echo * 0.98 + mic * 0.02; // his voice leaking back through the echo cancelling
    // barge-in by level: your voice well above the room and his echo, for ~150ms
    if (speaking && mic > Math.max(0.03, talk.floor * 4, talk.echo * 2.5)) { if (++talk.loudFrames > 9) { talk.loudFrames = 0; bargeIn(); } }
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
    ? 'On askeden.com the Eden voice uses your account’s daily voice allowance (more with Plus).'
    : 'On this Mac: the Eden voice, on the daily voice allowance for this Mac; the Mac’s own voice when that’s used up or offline.';
  const transcribes = HOSTED ? 'askeden.com transcribes it (Whisper on Cloudflare, counted on your Eden account’s included AI)' : 'Eden on this Mac transcribes it (the audio stays on this Mac)';
  const rec = DESKTOP && Recorder()
    ? `In this app, Dictation and Talk record what you say (two minutes at most) and ${transcribes}.` // AJ2-1
    : Recognition()
      ? 'Dictation and Talk use this browser’s speech recognition (Chrome sends the audio to Google to transcribe it).'
      : Recorder()
        ? `This browser has no speech recognition: Dictation and Talk record what you say (two minutes at most) and ${transcribes}.`
        : 'This browser has no speech recognition, so Dictation and Talk are off (use Chrome, Edge or Safari).';
  return el('div', 'set-sec', el('h3', '', 'Voice'),
    el('div', 'icard', el('div', 'prov',
      el('div', 'grow', el('div', 'p-n', 'Read replies aloud'), el('div', 'p-c', 'In the Eden voice, as each reply streams in (code is skipped). Talk mode always reads aloud.')),
      el('label', 'switch', sw, el('span', 'tr')))),
    el('p', 'sp-note', where, ' ', rec)); // two text nodes: each is translated on its own
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
  if (!Recognition() && !Recorder()) { if (mic) mic.hidden = true; if (talkBtn) talkBtn.hidden = true; } // else Talk records each turn (AJ2-1)
  if (mic) mic.addEventListener('click', () => (dict.rec || dict.starting ? stopDictation() : startDictation()));
  if (talkBtn) talkBtn.addEventListener('click', openTalk);
  const ta = $('deck-input');
  // typing or sending while dictating keeps the words as they are
  ta.addEventListener('keydown', (e) => { if (dict.rec && !dict.rec.recording && !e.metaKey && !e.ctrlKey && (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter')) stopDictation(true); }); // a recording goes on while you type (sending drops it)
  $('deck-composer').addEventListener('submit', () => stopDictation(true), true);
  // the talk overlay owns Esc (before app.js's, which would stop the reply) and keeps focus;
  // shrunk to the orb, the app is yours again (Esc there goes to the app)
  document.addEventListener('keydown', (e) => {
    if (!talk.on || talk.mini) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); setTalkMini(true); return; }
    if (talk.state === 'replying' && isSpaceToInterrupt(e)) { e.preventDefault(); e.stopImmediatePropagation(); bargeIn(); return; }
    if (e.key === 'Tab') {
      const f = [...talk.box.querySelectorAll('button:not([hidden]):not(:disabled)')];
      const i = f.indexOf(document.activeElement);
      e.preventDefault();
      f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    }
  }, true);
  // AJ2-7: Talk listens again when the page is shown (hidden, the browser ended its listening)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resumeTalk(); });
  // reading aloud needs audio unlocked by a gesture: any click or key while it's on
  const unlock = () => { if (prefs.autoRead) audio(); };
  document.addEventListener('pointerdown', unlock, true);
  document.addEventListener('keydown', unlock, true);
  paintMic();
}
