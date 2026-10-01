// Study mode's switch, by the main request box (features/study_mode.py): JARVIS tutors step by
// step, checks understanding and offers a quiz, instead of only answering.
(function (root) {
  'use strict';
  const F = root.jarvisFeatures;
  if (!F) return;
  const t = (s) => F.t(s);
  let on = false;
  let chip = null;

  function draw() {
    if (!chip) return;
    chip.classList.toggle('sm-on', on);
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    chip.textContent = on ? `🎓 ${t('Study mode on')}` : `🎓 ${t('Study mode')}`;
  }

  function mount() {
    const chips = document.querySelector('.chips');
    if (!chips || document.getElementById('study-chip')) return;
    chip = F.el('button', 'chip sm-chip');
    chip.id = 'study-chip';
    chip.type = 'button';
    chip.title = t('Tutors you step by step and checks you understand, instead of just answering.');
    chip.addEventListener('click', () => F.send({ type: 'feature_prefs', changes: { study_mode: !on } }));
    chips.append(chip);
    draw();
  }

  F.on('prefs', (ev) => { on = Boolean(ev && ev.features && ev.features.study_mode); draw(); }, { replay: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})(typeof window !== 'undefined' ? window : globalThis);
