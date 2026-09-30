// Settings › Conversations for you: how long a conversation Jarvis holds for the owner waits
// in silence, after its last message, before one gentle follow-up (the backend is
// jarvis.features.scheduling and delegate.py). The follow-up asks first like any message.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;

  const CHOICES = [[0, 'Never'], [12, 'After 12 hours'], [24, 'After a day'], [48, 'After 2 days'], [72, 'After 3 days']];
  let select = null;
  let hours = 24;

  function row() {
    if (select) return select;
    const list = F.$('delegation-list');
    const group = list ? list.closest('section.group') : null;
    if (!group) return null;
    const label = el('label', 'row');
    label.htmlFor = 'delegate-nudge';
    const words = el('span');
    words.append(
      el('strong', '', 'Nudge when they go quiet'),
      el('small', '', 'One short, polite follow-up after Jarvis’s last message, shown to you before it goes like any other'),
    );
    select = el('select');
    select.id = 'delegate-nudge';
    for (const [value, text] of CHOICES) {
      const option = el('option', '', text);
      option.value = String(value);
      select.append(option);
    }
    select.addEventListener('change', () => {
      hours = Number(select.value);
      send({ type: 'feature_prefs', changes: { delegate_nudge_hours: hours } });
    });
    label.append(words, select);
    group.insertBefore(label, list);
    return select;
  }

  function show(features) {
    const value = features && Number.isFinite(features.delegate_nudge_hours) ? features.delegate_nudge_hours : 24;
    hours = CHOICES.some(([h]) => h === value) ? value : 24;
    const s = row();
    if (s) s.value = String(hours);
  }

  F.on('hello', (ev) => show((ev.prefs && ev.prefs.features) || {}), { replay: true });
  F.on('prefs', (ev) => show(ev.features || {}));
})();
