// The guided walk-through (Eden for Education): on a first visit, a few steps over the real page, each
// part lit up with a line about it; the first time a course opens, a short second one for the course's
// own tools. Once seen it stays away (localStorage edu:tour:<name>); the sidebar's "Take the tour"
// plays it again. Esc skips, ← → move, and steps whose part isn't on the page (a phone, a role) drop out.

import { el } from './util.js';

const TOURS = {
  home: [
    { title: 'Welcome to Eden for Education', text: 'A study assistant built from your class’s own slides, readings and textbooks. Every answer shows the page it came from. Here’s a quick look around.' },
    { at: '#sidebar', title: 'Your courses, chats and notebook', text: 'Everything you study lives here. Fold it away with the button at the top left, or ⌘B.' },
    { at: '.crs-door.student', title: 'Joining a class?', text: 'Type the code your professor gave you. That’s all a student needs to set up.' },
    { at: '.crs-door.teacher', title: 'Teaching?', text: 'Create a course and drop in your syllabus, slides, PDFs and EPUBs. Students join with one code.' },
    { at: '#nbSideItem', title: 'Your notebook', text: 'It opens on the right, beside what you’re studying. Write notes for each course, and clip any answer or source page into it with one tap. Only you can see it.' },
    { title: 'Inside a course', text: 'Ask anything and get answers with sources, talk it through out loud with Eden, or study with flashcards and games. We’ll point them out when you open one.' },
  ],
  course: [
    { at: '.crs-tabs', title: 'Everything about this course', text: 'Study is where you ask. Materials lists the files Eden answers from.' },
    { at: '.crs-askbar', title: 'Ask anything', text: 'Answers come from the course’s own materials. Tap a source under an answer to see the exact page or slide.' },
    { at: '.crs-tools', title: 'Ways to study', text: 'Practice quizzes, flashcards and games, a hard topic explained step by step, or a plan for the exam.' },
    { at: '#eduActs .tut-mini', box: (n) => n.closest('button'), title: 'Eden, your tutor', text: 'Talk it through out loud, like with a person. It asks you questions back. Shrink it to just the orb and it follows you around.' },
    { at: '#eduActs button[data-act="study"]', title: 'The study companion', text: 'Flashcards, learn mode, practice tests and a matching game, made from your materials, in a panel on the right.' },
  ],
};

const seen = (name) => { try { return localStorage.getItem(`edu:tour:${name}`) === 'done'; } catch { return true; } };
const markSeen = (name) => { try { localStorage.setItem(`edu:tour:${name}`, 'done'); } catch { /* this visit */ } };

/** Plays a tour if this browser hasn't seen it. */
export function maybeTour(name) { if (!seen(name) && !document.querySelector('.tour-x')) startTour(name); }

/** Plays a tour now (the sidebar's "Take the tour" starts home, and lets the course one play again). */
export function startTour(name) {
  if (name === 'home') { try { localStorage.removeItem('edu:tour:course'); } catch { /* fine */ } }
  const steps = TOURS[name].filter((s) => !s.at || target(s));
  if (!steps.length) return;
  let i = 0;
  const shade = el('div', { class: 'tour-x-shade' });
  const ring = el('div', { class: 'tour-x-ring' });
  const card = el('div', { class: 'tour-x glass', role: 'dialog', 'aria-modal': 'true', 'aria-live': 'polite' });
  document.body.append(shade, ring, card);
  const end = () => { markSeen(name); shade.remove(); ring.remove(); card.remove(); removeEventListener('keydown', key, true); removeEventListener('resize', draw); };
  const key = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); end(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); i--; draw(); }
  };
  const next = () => { if (i < steps.length - 1) { i++; draw(); } else end(); };
  function draw() {
    const s = steps[i];
    const n = s.at && target(s);
    const last = i === steps.length - 1;
    card.replaceChildren(
      el('div', 'tour-x-count', steps.length > 1 ? `${i + 1} of ${steps.length}` : ''),
      el('h3', '', s.title), el('p', '', s.text),
      el('div', 'tour-x-acts',
        el('button', { type: 'button', class: 'tour-x-skip', onclick: end }, last ? '' : 'Skip'),
        el('span', { style: { flex: '1' } }),
        i > 0 ? el('button', { type: 'button', class: 'btn', onclick: () => { i--; draw(); } }, 'Back') : null,
        el('button', { type: 'button', class: 'btn primary', onclick: next }, last ? (name === 'home' ? 'Start studying' : 'Got it') : i === 0 && !s.at ? 'Show me' : 'Next')));
    card.setAttribute('aria-label', s.title);
    if (n) {
      n.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      const r = n.getBoundingClientRect();
      const pad = 6;
      Object.assign(ring.style, { display: 'block', left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
      shade.classList.add('lit');
      // the card beside the part: below it if there's room, else above, else to its right
      const cw = Math.min(340, innerWidth - 24), ch = card.offsetHeight || 180;
      let left = Math.min(Math.max(12, r.left), innerWidth - cw - 12);
      let top = r.bottom + 14;
      if (top + ch > innerHeight - 12) top = r.top - ch - 14;
      if (top < 12) { top = Math.max(12, Math.min(r.top, innerHeight - ch - 12)); left = r.right + 14 + cw < innerWidth ? r.right + 14 : Math.max(12, r.left - cw - 14); }
      Object.assign(card.style, { left: `${left}px`, top: `${top}px`, transform: 'none' });
    } else {
      ring.style.display = 'none';
      shade.classList.remove('lit');
      Object.assign(card.style, { left: '50%', top: '50%', transform: 'translate(-50%,-50%)' });
    }
    card.querySelector('.btn.primary').focus();
  }
  addEventListener('keydown', key, true);
  addEventListener('resize', draw);
  draw();
}

function target(s) {
  const n = document.querySelector(s.at);
  if (!n) return null;
  const box = s.box ? s.box(n) : n;
  const r = box && box.getBoundingClientRect();
  return r && r.width > 0 && r.height > 0 ? box : null;
}
