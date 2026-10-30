// Answering out loud (Eden for Education, ROADMAP Q9): a button that listens once and picks the
// choice that was said ("B", "the second one", "true", or the answer's words; edu-a11y.js), for the
// study companion's Learn and Test (study.js) and the practice quiz (courses.js).

import { el, ico, toast } from './util.js';
import { apiUrl } from './api.js';
import { spokenChoice, listenOnce, announce } from './edu-a11y.js';

/** "Answer by voice": listens once (edu-a11y.js listenOnce: speech recognition, else the mic and
 * /api/chat/transcribe), then `onHeard(words)` picks the choice or fills the answer. */
export function voiceBtn(label, onHeard) {
  let session = null;
  const text = el('span', '', label);
  const b = el('button', { type: 'button', class: 'btn stu-voice', 'aria-pressed': 'false', title: 'Say your answer: a letter (A, B, C…), true or false, or the words', onclick: async () => {
    if (session) { session.stop(); return; }
    if (window.speechSynthesis) speechSynthesis.cancel(); // not while a page is read aloud
    session = listenOnce({ transcribeUrl: apiUrl('/api/chat/transcribe') });
    b.setAttribute('aria-pressed', 'true');
    text.textContent = 'Listening… press to stop';
    try {
      const heard = await session.done;
      if (!heard) announce('I didn’t hear an answer. Try again.');
      else onHeard(heard);
    } catch (e) { announce(e.message); toast(e.message); }
    finally { session = null; b.setAttribute('aria-pressed', 'false'); text.textContent = label; }
  } }, ico('speaker', 13), text);
  return b;
}
export const LETTERS = 'ABCDEF';
/** A choice the voice picked, or a nudge when it isn't clear. */
export const pickSpoken = (heard, choices, pick) => {
  const i = spokenChoice(heard, choices);
  if (i < 0) { announce(`I heard “${heard}”. Say a letter, ${choices.length === 2 && /true/i.test(choices[0]) ? 'true or false' : `A to ${LETTERS[choices.length - 1]}`}, or the answer’s words.`); return; }
  pick(i);
};
