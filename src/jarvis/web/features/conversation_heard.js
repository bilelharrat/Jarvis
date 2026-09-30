// Click to fix what Jarvis heard (the conversation feature): after a spoken request, the
// words under the orb can be clicked and put right. The fix goes to the hub's own heard_edit,
// so hearing learns it ("Okin", not "oaken") and says so; "Fix and ask again" sends the
// fixed words as a new request too. Only a spoken request can be fixed this way: a typed one
// was never heard. What was said is the owner's data: shown as text, with data-no-i18n.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, $, send } = F;
  const T = (text) => F.t(text);

  const SPOKEN_MS = 60000; // a transcript this recent is the request it became
  const LEARNED_MS = 3000; // hearing says what it learned this soon after a fix
  const S = { heard: null, original: '', corrections: [], pending: null };

  function key(c) { return `${c.heard}\u0000${c.meant}\u0000${c.count}`; }

  function heardLine() { return $('heard'); }

  function editor() {
    let form = $('heard-fix');
    if (form) return form;
    const heard = heardLine();
    if (!heard) return null;
    form = el('form', 'heard-fix');
    form.id = 'heard-fix';
    form.hidden = true;
    form.setAttribute('aria-label', 'Fix what I heard');
    const field = el('input', 'heard-fix-input');
    field.id = 'heard-fix-input';
    field.setAttribute('aria-label', 'What you said');
    field.setAttribute('data-no-i18n', '');
    field.autocomplete = 'off';
    const save = el('button', 'btn primary', 'Fix');
    save.type = 'submit';
    save.id = 'heard-fix-save';
    const again = el('button', 'btn', 'Fix and ask again');
    again.type = 'button';
    again.id = 'heard-fix-again';
    const cancel = el('button', 'btn', 'Cancel');
    cancel.type = 'button';
    cancel.id = 'heard-fix-cancel';
    form.append(field, save, again, cancel);
    form.addEventListener('submit', (e) => { e.preventDefault(); fix(false); });
    again.addEventListener('click', () => fix(true));
    cancel.addEventListener('click', () => close());
    form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
    heard.after(form);
    const note = el('p', 'heard-learned');
    note.id = 'heard-learned';
    note.hidden = true;
    note.setAttribute('data-no-i18n', ''); // it quotes the owner's word: translated here
    form.after(note);
    return form;
  }

  function fixable(on) {
    const heard = heardLine();
    if (!heard) return;
    heard.classList.toggle('heard-fixable', on);
    if (on) {
      heard.setAttribute('role', 'button');
      heard.tabIndex = 0;
      heard.title = T('Click to fix what I heard');
    } else {
      heard.removeAttribute('role');
      heard.removeAttribute('tabindex');
      heard.removeAttribute('title');
    }
  }

  function open() {
    const form = editor();
    if (!form || !S.original) return;
    const field = $('heard-fix-input');
    field.value = S.original;
    heardLine().hidden = true;
    form.hidden = false;
    $('heard-learned').hidden = true;
    field.focus();
    field.select();
  }

  function close() {
    const form = $('heard-fix');
    if (form) form.hidden = true;
    const heard = heardLine();
    if (heard) heard.hidden = false;
  }

  function fix(askAgain) {
    const edited = $('heard-fix-input').value.replace(/\s+/g, ' ').trim();
    const original = S.original;
    close();
    if (!edited || edited === original) return;
    S.pending = { edited, until: Date.now() + LEARNED_MS, known: new Set(S.corrections.map(key)) };
    send({ type: 'heard_edit', original, edited });
    heardLine().textContent = `“${edited}”`;
    S.original = edited;
    if (askAgain) send({ type: 'ask', text: edited });
  }

  function heardClicked() {
    if (heardLine().classList.contains('heard-fixable')) open();
  }

  const heard = heardLine();
  if (heard && !heard.dataset.fixWired) {
    heard.dataset.fixWired = '1';
    heard.addEventListener('click', heardClicked);
    heard.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && heard.classList.contains('heard-fixable')) { e.preventDefault(); open(); }
    });
  }

  F.on('heard', (ev) => { if (ev.text) S.heard = { text: String(ev.text), at: Date.now() }; });
  F.on('turn', (ev) => {
    const user = String(ev.user || '');
    const spoken = user && S.heard && Date.now() - S.heard.at < SPOKEN_MS && S.heard.text.includes(user);
    S.original = spoken ? user : '';
    close();
    fixable(!!spoken);
    const note = $('heard-learned');
    if (note && user) note.hidden = true;
  });
  F.on('hearing', (ev) => {
    const now = ev.corrections || [];
    const p = S.pending;
    S.corrections = now;
    if (!p || Date.now() > p.until) return;
    const fresh = now.find((c) => !p.known.has(key(c)) && p.edited.toLowerCase().includes(String(c.meant).toLowerCase()));
    if (!fresh) return;
    S.pending = null;
    const note = $('heard-learned') || (editor() && $('heard-learned'));
    if (!note) return;
    note.textContent = T(`Got it: I'll hear “${fresh.meant}” from now on.`);
    note.hidden = false;
  }, { replay: true });
})();
