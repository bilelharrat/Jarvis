// Eden for Education for blind and low-vision students (askeden ROADMAP Q9): answering a quiz out
// loud, reading a page aloud (its figure descriptions too), and short screen-reader announcements.
// No imports and nothing done at load, so the tests load this file as it is served; the browser
// parts (speech, the mic) run only when called.
//
//   spokenChoice   what was said ("B", "the second one", "true", or the answer's own words) → a choice
//   pageSpeech     a source page as something to listen to: where it is, its text, its figures
//   readAloud      the browser's own voice, a sentence or two at a time (free; no account allowance)
//   listenOnce     one spoken answer: the browser's speech recognition, else the mic recorded and
//                  turned into words by POST /api/chat/transcribe (as the tutor does)
//   announce       a polite screen-reader announcement (one shared live region)

const FIGURE_MARK = '[Figure description]'; // figures.js FIGURE_MARK
const norm = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// the page's language (i18n.js sets <html lang="fr"> when French is on; no import, see above)
const pageFr = () => typeof document !== 'undefined' && document.documentElement.lang === 'fr';
const speechLang = () => { const b = (typeof navigator !== 'undefined' && navigator.language) || ''; const want = pageFr() ? 'fr' : 'en'; return b.toLowerCase().startsWith(want) ? b : want === 'fr' ? 'fr-FR' : 'en-US'; };
const STOP = new Set('a an and are as at be by for from in into is it its of on or that the this to was with'.split(' '));

// how recognizers write a spoken letter or position
const LETTER = { a: 0, ay: 0, eh: 0, b: 1, be: 1, bee: 1, c: 2, see: 2, sea: 2, si: 2, d: 3, dee: 3, e: 4, f: 5, ef: 5 };
// the same in French (accents already stripped by norm): "bé", "réponse B", "la deuxième", "la dernière"
const LETTER_FR = { a: 0, b: 1, be: 1, c: 2, ce: 2, d: 3, de: 3, e: 4, eu: 4, f: 5, ef: 5, effe: 5 };
const ORDINAL_FR = { premier: 0, premiere: 0, un: 0, une: 0, 1: 0, deuxieme: 1, second: 1, seconde: 1, deux: 1, 2: 1, troisieme: 2, trois: 2, 3: 2, quatrieme: 3, quatre: 3, 4: 3, cinquieme: 4, cinq: 4, 5: 4, sixieme: 5, six: 5, 6: 5, dernier: -1, derniere: -1 };
const CHOICE_FR = /^(?:(?:je pense que|je crois que|je dirais que|je pense|je crois|je dis|je dirais|je choisis|c est|ma reponse est|ma reponse|reponse|la reponse|l option|option|lettre|la lettre|choix|le choix|numero|le numero|le|la|l|celle|celui|est)\s+)*([a-f]|be|ce|de|eu|ef|effe|premier|premiere|deuxieme|second|seconde|troisieme|quatrieme|cinquieme|sixieme|dernier|derniere|un|une|deux|trois|quatre|cinq|six|[1-6])(?:\s+(?:reponse|option|choix|s il vous plait|s il te plait|stp))*$/;
const ORDINAL = { first: 0, one: 0, 1: 0, second: 1, two: 1, to: 1, too: 1, 2: 1, third: 2, three: 2, 3: 2, fourth: 3, four: 3, for: 3, 4: 3, fifth: 4, five: 4, 5: 4, sixth: 5, six: 5, 6: 5, last: -1 };

/** The choice a spoken answer means (its index in `choices`), or -1 when it's unclear. */
export function spokenChoice(heard, choices) {
  const h = norm(heard);
  if (!h || !choices || !choices.length) return -1;
  const lower = choices.map((c) => norm(c));
  // true or false
  const fr = pageFr();
  const tIdx = lower.indexOf('true') >= 0 || !fr ? lower.indexOf('true') : lower.indexOf('vrai');
  const fIdx = lower.indexOf('false') >= 0 || !fr ? lower.indexOf('false') : lower.indexOf('faux');
  if (tIdx >= 0 && fIdx >= 0 && choices.length === 2) {
    if (/\b(not true|false|no|wrong|incorrect|untrue)\b/.test(h)) return fIdx;
    if (/\b(true|yes|right|correct)\b/.test(h)) return tIdx;
    if (fr && /\b(pas vrai|faux|non|inexact|incorrect)\b/.test(h)) return fIdx;
    if (fr && /\b(vrai|oui|exact|juste|correct)\b/.test(h)) return tIdx;
    return -1;
  }
  // a letter or a position: "B", "option c", "the second one", "number 3", "the last one"
  const m = /^(?:(?:i think|i say|i ll say|i will say|it s|its|it is|my answer is|answer|option|letter|choice|number|the|is)\s+)*([a-f]|ay|eh|be|bee|see|sea|si|dee|ef|first|second|third|fourth|fifth|sixth|last|one|two|to|too|three|four|for|five|six|[1-6])(?:\s+(?:one|option|answer|please))*$/.exec(h);
  if (m) {
    const w = m[1];
    const i = w in LETTER ? LETTER[w] : ORDINAL[w];
    if (i === -1) return choices.length - 1;
    return i !== undefined && i < choices.length ? i : -1;
  }
  const mf = fr ? CHOICE_FR.exec(h) : null;
  if (mf) {
    const w = mf[1];
    const i = w in LETTER_FR ? LETTER_FR[w] : ORDINAL_FR[w];
    if (i === -1) return choices.length - 1;
    return i !== undefined && i < choices.length ? i : -1;
  }
  // the answer's own words: the choice sharing most of what was said (and clearly more than the others)
  const said = h.split(' ').filter((w) => !STOP.has(w));
  if (!said.length) return -1;
  const exact = lower.indexOf(h);
  if (exact >= 0) return exact;
  const scores = lower.map((c) => { const ws = new Set(c.split(' ')); return said.filter((w) => ws.has(w)).length / said.length; });
  const best = Math.max(...scores);
  const at = scores.indexOf(best);
  if (best < 0.5 || scores.filter((s) => s === best).length > 1) return -1;
  return at;
}

/** A page from the source viewer as one thing to listen to. */
export function pageSpeech({ name = '', loc = '', text = '' } = {}) {
  const t = String(text || '');
  const at = t.search(/(^|\n)\[Figure description\]\n/);
  const own = (at < 0 ? t : t.slice(0, at)).trim();
  const fig = at < 0 ? '' : t.slice(at).replace(FIGURE_MARK, '').trim();
  const tidy = (s) => { const t = s.replace(/\s*\n+\s*/g, '. ').replace(/\.{2,}/g, '.').replace(/([!?:;])\./g, '$1').replace(/\s{2,}/g, ' ').trim(); return /[.!?…]$/.test(t) ? t : `${t}.`; };
  return [`${name}${loc ? `, ${loc}` : ''}.`, own ? tidy(own) : pageFr() ? 'Cette page n’a pas de texte propre.' : 'This page has no text of its own.', fig ? `${pageFr() ? 'Description de la figure :' : 'Figure description:'} ${tidy(fig)}` : ''].filter(Boolean).join(' ').replace(/\.\./g, '.');
}

/** Text in pieces the browser's voice reads reliably (Chrome stops long utterances): sentences, ≤ max characters. */
export function speechPieces(text, max = 220) {
  const sentences = String(text || '').match(/[^.!?…]+(?:[.!?…]+["”’)]*|$)\s*/g) || [];
  const out = [];
  let cur = '';
  for (let s of sentences) {
    if (s.length > max && cur.trim()) { out.push(cur.trim()); cur = ''; }
    while (s.length > max) { const cut = s.lastIndexOf(' ', max); const at = cut > 40 ? cut : max; out.push(s.slice(0, at).trim()); s = s.slice(at); }
    if (cur && cur.length + s.length > max) { out.push(cur.trim()); cur = ''; }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

/** Reads text aloud with the browser's voice; returns stop(). `onend` runs once, when it finishes or stops. */
export function readAloud(text, { onend = () => {}, rate = 1 } = {}) {
  const synth = typeof window !== 'undefined' && window.speechSynthesis;
  let ended = false;
  const end = () => { if (!ended) { ended = true; onend(); } };
  if (!synth) { end(); return () => {}; }
  synth.cancel();
  const pieces = speechPieces(text);
  pieces.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p);
    u.rate = rate;
    u.lang = speechLang();
    if (i === pieces.length - 1) { u.onend = end; u.onerror = end; }
    synth.speak(u);
  });
  if (!pieces.length) end();
  return () => { synth.cancel(); end(); };
}

/** One spoken answer: { done: Promise<string>, stop() }. `transcribeUrl` for browsers without speech recognition. */
export function listenOnce({ transcribeUrl = '/api/chat/transcribe', maxMs = 8000 } = {}) {
  const R = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
  let stop = () => {};
  const done = new Promise((resolve, reject) => {
    if (R) {
      const rec = new R();
      rec.lang = speechLang();
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      let said = '';
      rec.onresult = (e) => { said = [...e.results].map((r) => r[0].transcript).join(' ').trim(); };
      rec.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') reject(new Error('The microphone isn’t allowed for this page.')); };
      rec.onend = () => resolve(said);
      const t = setTimeout(() => { try { rec.stop(); } catch { /* done */ } }, maxMs);
      stop = () => { clearTimeout(t); try { rec.stop(); } catch { /* done */ } };
      try { rec.start(); } catch (e) { reject(e); }
      return;
    }
    if (!navigator.mediaDevices || !window.MediaRecorder) { reject(new Error('This browser can’t listen. Type your answer instead.')); return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((x) => MediaRecorder.isTypeSupported(x));
      const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        try {
          const res = await fetch(transcribeUrl, { method: 'POST', headers: { 'content-type': blob.type.split(';')[0], 'X-Jarvis-Chat': '1' }, body: blob });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(j.error || 'Couldn’t hear that.');
          resolve(String(j.text || '').trim());
        } catch (e) { reject(e); }
      };
      const t = setTimeout(() => { if (rec.state === 'recording') rec.stop(); }, maxMs);
      stop = () => { clearTimeout(t); if (rec.state === 'recording') rec.stop(); };
      rec.start(250);
    }, () => reject(new Error('The microphone isn’t allowed for this page.')));
  });
  return { done, stop: () => stop() };
}

/** Says something to screen readers, politely (the same words twice are said twice). */
export function announce(text) {
  if (typeof document === 'undefined') return;
  let box = document.getElementById('eduLive');
  if (!box) {
    box = document.createElement('div');
    box.id = 'eduLive';
    box.className = 'sr-only';
    box.setAttribute('aria-live', 'polite');
    box.setAttribute('aria-atomic', 'true');
    document.body.append(box);
  }
  box.textContent = '';
  setTimeout(() => { box.textContent = String(text || ''); }, 60);
}
