// Settings › Home & Shortcuts, for the Mac's switches and the home's answers
// (jarvis.features.mac_switches): which shortcuts answer a question ("Is the garage
// closed"), run without asking and read out, and how to name the shortcuts a Focus uses.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;
  const PREF = 'home_questions';

  // ── pure helpers (tests/web/mac-actions.test.mjs runs these) ──

  // The Mac's shortcuts not yet marked, for the Add menu, in the Mac's order.
  function addable(names, marked) {
    const taken = new Set(marked);
    return (Array.isArray(names) ? names : []).filter((n) => typeof n === 'string' && n && !taken.has(n));
  }

  function without(marked, name) {
    return marked.filter((n) => n !== name);
  }

  if (typeof window.__macActionsTest === 'function') window.__macActionsTest({ addable, without });

  // ── where it goes: under the shortcuts in Settings › Home & Shortcuts ──

  const shortcuts = document.getElementById('shortcut-list');
  const group = shortcuts && shortcuts.closest('section.group');
  if (!group) return;
  let names = [];
  let marked = [];

  const box = el('div', 'homeq');
  const title = el('div', 'homeq-title');
  title.append(el('strong', '', 'Home questions'), el('small', '', 'Shortcuts that only look, like “Is the garage closed”: ask “Jarvis, is the garage closed?” and I run it without asking and tell you what it says.'));
  const list = el('ul', 'itemlist homeq-list');
  const add = el('select', 'homeq-add');
  add.setAttribute('aria-label', 'Add a home question');
  add.addEventListener('change', () => {
    if (!add.value) return;
    marked = [...marked, add.value];
    save();
  });
  const focus = el('p', 'small-status homeq-focus', 'Focus and Do Not Disturb: make shortcuts with the Set Focus action named like “Work Focus On” and “Focus Off”, then say “Jarvis, turn on work focus.”');
  box.append(title, list, add, focus);
  shortcuts.after(box);

  function save() {
    send({ type: 'feature_prefs', changes: { [PREF]: marked } });
    render();
  }

  function render() {
    list.replaceChildren(...marked.map((name) => {
      const li = el('li');
      const fact = el('span', 'fact');
      const label = el('strong', '', name);
      label.setAttribute('data-no-i18n', '');
      fact.append(label);
      const rm = el('button', 'btn', 'Remove');
      rm.type = 'button';
      rm.setAttribute('aria-label', `Remove “${name}” from home questions`);
      rm.addEventListener('click', () => { marked = without(marked, name); save(); });
      li.append(fact, rm);
      return li;
    }));
    const options = addable(names, marked);
    const first = el('option', '', options.length ? 'Add a question shortcut…' : 'No other shortcuts to add');
    first.value = '';
    add.replaceChildren(first, ...options.map((name) => {
      const option = el('option', '', name);
      option.value = name;
      option.setAttribute('data-no-i18n', '');
      return option;
    }));
    add.value = '';
    add.disabled = !options.length;
  }

  function fromPrefs(p) {
    const features = (p && p.features) || {};
    if (Array.isArray(features[PREF])) { marked = features[PREF].filter((n) => typeof n === 'string'); render(); }
  }

  F.on('shortcuts', (ev) => { names = Array.isArray(ev.names) ? ev.names : []; render(); }, { replay: true });
  F.on('prefs', fromPrefs, { replay: true });
  F.on('hello', (ev) => fromPrefs(ev.prefs), { replay: true });
  render();
})();
