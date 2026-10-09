const query = new URLSearchParams(location.search);
const message = document.getElementById('message');
const note = document.getElementById('note');
const detail = document.getElementById('detail');

// Eden Code's window (flavor.js) waits in Ask Eden's look, under its own name.
if (query.get('app') === 'eden-code') {
  document.body.classList.add('eden-code');
  document.title = 'Eden Code';
  message.textContent = 'Opening Eden Code…';
}
// J.A.R.V.I.S. Daredevil's: large yellow type on black from the first moment, named for a screen reader.
if (query.get('app') === 'daredevil') {
  document.body.classList.add('daredevil');
  document.title = 'J.A.R.V.I.S. Daredevil';
  message.textContent = 'Opening J.A.R.V.I.S. Daredevil…';
  // Its opening sound, the owner's choice ("C'est, c'est, c'est énergétique !"): once, as the window first shows, never
  // when it starts hidden at sign-in (quiet) or when the page is a problem being reported.
  if (!query.get('quiet') && !query.get('error') && typeof Audio === 'function') {
    const sound = new Audio('daredevil-open.wav');
    sound.play().catch(() => {}); // (no sound device: nothing to say)
  }
}
const error = query.get('error');
if (error) {
  document.body.classList.add('error');
  message.textContent = error;
  message.setAttribute('role', 'alert');
  message.setAttribute('aria-live', 'assertive');
  const last = query.get('detail');
  if (last) {
    detail.textContent = last;
    detail.hidden = false;
  }
}

// A line under the message while the engine takes its time (main.js waitForBackend).
window.sayWhileWaiting = (text) => { note.textContent = String(text || ''); };
