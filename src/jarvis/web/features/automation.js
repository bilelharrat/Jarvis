// The automation feature's window side: Settings › Routines, drawn with each routine's
// schedule in the language the window speaks and when it runs next.
//
// Everything a routine carries (its name, its prompt, when it runs) is the owner's or the
// backend's data: shown with textContent and marked data-no-i18n. The helpers at the top
// are pure (window.jarvisAutomation), so node --test can check them without a page.
(() => {
  const A = {
    // A time the window shows: "3:30 PM" today, "Tue 3:30 PM" within the week, else the date.
    when(iso, lang = 'en', now = new Date()) {
      const at = new Date(iso);
      if (!iso || Number.isNaN(at.getTime())) return '';
      const locale = lang === 'zh' ? 'zh-CN' : undefined;
      const days = Math.round((new Date(at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86400000);
      const style = days === 0 ? { hour: 'numeric', minute: '2-digit' }
        : days > 0 && days < 7 ? { weekday: 'short', hour: 'numeric', minute: '2-digit' }
          : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
      return new Intl.DateTimeFormat(locale, style).format(at);
    },
    // A routine's schedule in the window's language (the backend says it in both).
    schedule(r, lang = 'en') {
      return (lang === 'zh' && r.when_zh) || r.when || '';
    },
  };
  window.jarvisAutomation = A;

  const F = window.jarvisFeatures;
  if (!F || typeof document === 'undefined') return;
  const { el, send } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  let lang = 'en';
  let routines = [];

  function button(label, cls, onClick, aria) {
    const b = el('button', cls, label);
    b.type = 'button';
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', onClick);
    return b;
  }

  function routineRow(r) {
    const li = el('li', 'routine auto-routine');
    li.dataset.id = r.id;
    const text = el('span', 'fact');
    const about = el('small', 'auto-when');
    about.append(mine(el('bdi', '', A.schedule(r, lang))));
    if (!r.enabled) about.append(el('span', 'auto-sep', ' · '), el('span', '', 'paused'));
    else if (r.next_run) {
      const next = mine(el('bdi', 'auto-next', A.when(r.next_run, lang)));
      next.dataset.at = r.next_run;
      about.append(el('span', 'auto-sep', ' · '), el('span', '', 'Next run'), ' ', next);
    }
    text.append(mine(el('strong', '', r.name)), about);
    text.title = r.prompt || '';
    const sw = button('', 'switch', () => send({ type: 'routine_toggle', id: r.id, enabled: !r.enabled }), `${r.name} on`);
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(!!r.enabled));
    li.append(
      text,
      button('Run now', 'btn', () => send({ type: 'routine_run', id: r.id })),
      button('Delete', 'btn', () => send({ type: 'routine_delete', id: r.id }), `Delete ${r.name}`),
      sw,
    );
    return li;
  }

  // Drawn after app.js's own list on every change, in its place.
  function renderRoutines() {
    const list = F.$('routine-list');
    if (!list) return;
    if (!routines.length) {
      list.replaceChildren(el('li', 'muted', 'No routines yet.'));
      return;
    }
    list.replaceChildren(...routines.map(routineRow));
  }

  // The backend's state when this script loads (it may load after the hello: what app.js
  // drew since then is newer than a replayed hello), after every hello, and as it changes.
  F.on('hello', (ev) => {
    lang = (ev.prefs && ev.prefs.language) || lang;
    routines = ev.routines || [];
    renderRoutines();
    send({ type: 'automation_state' });
  });
  F.on('automation', (ev) => {
    if (ev.language) lang = ev.language;
    if (ev.routines) { routines = ev.routines; renderRoutines(); }
  });
  F.on('routines', (ev) => { routines = ev.items || []; renderRoutines(); });
  F.on('prefs', (ev) => {
    if (ev.language && ev.language !== lang) { lang = ev.language; renderRoutines(); }
  });
  send({ type: 'automation_state' });
  // "Tue 3:30 PM" becomes "3:30 PM" at midnight: the times are rewritten each minute (in
  // place, so nothing open or focused in the list moves).
  setInterval(() => {
    document.querySelectorAll('#routine-list .auto-next').forEach((node) => {
      node.textContent = A.when(node.dataset.at, lang);
    });
  }, 60000);
})();
