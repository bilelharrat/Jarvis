// Ask Eden Travel's page (public/travel-home/index.html): the hero's planner preview gets its day tabs. Without this script the
// tab row stays hidden and Day 2 shows alone. Arrow keys, Home and End move between the days (the ARIA tabs pattern).
(() => {
  'use strict';
  const list = document.querySelector('.plan [role="tablist"]');
  if (!list) return;
  const tabs = [...list.querySelectorAll('[role="tab"]')];

  function pick(tab, focus) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    }
    if (focus) tab.focus();
  }

  list.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) pick(tab, false);
  });
  list.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    pick(tabs[(to + tabs.length) % tabs.length], true);
  });
  list.hidden = false;
})();
