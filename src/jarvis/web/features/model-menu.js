// The model chip opens a menu of the models, as a macOS pop-up menu, instead of Settings.
// Its items are #model-select's own options (app.js keeps them in step with the hub), and a
// pick goes the same way as one in Settings: the select's value and its change event. The
// last item, Model Settings…, opens Settings on AI & Models. ↑↓ and Enter pick, Esc or a
// click elsewhere closes.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, $ } = F;
  const chip = $('model-chip');
  const select = $('model-select');
  if (!chip || !select || $('model-menu')) return;

  const menu = el('div', 'model-menu');
  menu.id = 'model-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Model');
  menu.hidden = true;
  document.body.append(menu);
  chip.setAttribute('aria-haspopup', 'menu');
  chip.setAttribute('aria-expanded', 'false');
  chip.setAttribute('aria-controls', 'model-menu');

  const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>';

  function item(label, run, { checked = null, cls = '' } = {}) {
    const b = el('button', `mm-item ${cls}`.trim());
    b.type = 'button';
    b.setAttribute('role', checked === null ? 'menuitem' : 'menuitemradio');
    if (checked !== null) b.setAttribute('aria-checked', String(checked));
    const tick = el('span', 'mm-check');
    if (checked) tick.innerHTML = CHECK;
    b.append(tick, el('span', 'mm-label', label));
    b.addEventListener('click', () => { close(); run(); });
    b.addEventListener('mousemove', () => { if (document.activeElement !== b) b.focus({ preventScroll: true }); });
    return b;
  }

  function fill() {
    const models = [...select.options].map((o) => item(o.textContent, () => {
      if (select.value === o.value) return;
      select.value = o.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      chip.textContent = o.textContent;  // at once; the hub's prefs confirm it
    }, { checked: o.value === select.value }));
    for (const m of models) m.querySelector('.mm-label').setAttribute('data-no-i18n', '');
    menu.replaceChildren(
      el('div', 'mm-head', 'Model'),
      ...models,
      el('div', 'mm-sep'),
      item('Model Settings…', () => {
        toggleSettings(true);
        if (window.jarvisSettingsNav) window.jarvisSettingsNav.choose('ai');
      }, { cls: 'mm-more' }),
    );
  }

  function place() {
    const r = chip.getBoundingClientRect();
    const w = menu.offsetWidth;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(r.bottom + 8)}px`;
  }

  function open() {
    fill();
    menu.hidden = false;
    place();
    chip.setAttribute('aria-expanded', 'true');
    const on = menu.querySelector('.mm-item[aria-checked="true"]') || menu.querySelector('.mm-item');
    if (on) on.focus({ preventScroll: true });
  }
  function close({ refocus = false } = {}) {
    if (menu.hidden) return;
    menu.hidden = true;
    chip.setAttribute('aria-expanded', 'false');
    if (refocus) chip.focus({ preventScroll: true });
  }

  // Before app.js's own handler (which opens Settings): the chip is the menu's now.
  chip.addEventListener('click', (e) => {
    e.stopImmediatePropagation();
    if (menu.hidden) open(); else close();
  }, true);
  chip.addEventListener('keydown', (e) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && menu.hidden) { e.preventDefault(); open(); }
  });

  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('.mm-item')];
    const at = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
      if (next) next.focus({ preventScroll: true });
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (at >= 0) items[at].click();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      items[e.key === 'Home' ? 0 : items.length - 1].focus({ preventScroll: true });
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();  // Esc closes the menu, not what's behind it
      close({ refocus: true });
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== chip && !chip.contains(e.target)) close();
  }, true);
  window.addEventListener('resize', () => close());
  window.addEventListener('blur', () => close());

  window.jarvisModelMenu = { open, close, isOpen: () => !menu.hidden };
})();
