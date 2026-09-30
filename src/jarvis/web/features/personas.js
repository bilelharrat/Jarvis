// The owner's own personas (the personas feature, jarvis.features.personas): in Settings ›
// Personality, under the persona choice, a list of the ones they made (Edit, Delete) and an
// editor for a new one or a change: a name, what it's like, the same in Chinese (optional)
// and the humor it starts with. They're chosen in the persona buttons like the built-in
// three. What the owner wrote is their data: shown as text, with data-no-i18n.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, $, send } = F;
  const T = (text) => F.t(text);

  const S = { items: [], max: 8, editing: null, saving: false, confirm: '', confirmTimer: 0, voice: null, macAsked: false };
  const PV = window.jarvisPersonaVoices;  // (personas-voices.js)

  // The persona's own voice: the choices Settings › Speaking offers, drawn again as they're
  // listed; the one picked stays picked.
  function drawVoices(current) {
    const pick = $('persona-voice');
    if (!pick || !PV) return;
    const chosen = current !== undefined ? PV.valueOf(current) : pick.value;
    const groups = new Map();
    const nodes = [];
    for (const o of PV.options(S.voice, current !== undefined ? current : PV.fromValue(pick.value))) {
      const opt = el('option', '', o.label);
      opt.value = o.value;
      if (!o.group) { nodes.push(opt); continue; }
      mine(opt);
      if (!groups.has(o.group)) {
        const g = el('optgroup');
        g.label = o.group === 'mac' ? T('Mac voices') : T(PV.CLOUD_NAMES[o.group]);
        groups.set(o.group, g);
        nodes.push(g);
      }
      groups.get(o.group).append(opt);
    }
    pick.replaceChildren(...nodes);
    pick.value = chosen;
    if (pick.value !== chosen) pick.value = '';
  }

  function mine(node) {
    node.setAttribute('data-no-i18n', '');
    return node;
  }

  function button(label, cls, run) {
    const b = el('button', cls || 'btn', label);
    b.type = 'button';
    if (run) b.addEventListener('click', run);
    return b;
  }

  function field(id, label, input) {
    const row = el('label', 'row stack persona-field');
    row.htmlFor = id;
    const words = el('span');
    words.append(el('strong', '', label));
    input.id = id;
    row.append(words, input);
    return row;
  }

  function build() {
    if ($('persona-own')) return $('persona-own');
    const choice = $('persona-group');
    if (!choice) return null;
    const box = el('div', 'persona-own');
    box.id = 'persona-own';
    const list = el('ul', 'persona-list');
    list.id = 'persona-list';
    const add = button('New persona…', 'btn', () => edit(null));
    add.id = 'persona-new';
    const form = el('form', 'persona-form');
    form.id = 'persona-form';
    form.hidden = true;
    form.setAttribute('aria-label', 'A persona of your own');
    const name = mine(el('input'));
    name.maxLength = 24;
    name.placeholder = 'e.g. Alfred';
    const about = mine(el('textarea'));
    about.maxLength = 600;
    about.rows = 3;
    about.placeholder = 'How it talks and what it’s like';
    const zhName = mine(el('input'));
    zhName.maxLength = 24;
    const zhAbout = mine(el('textarea'));
    zhAbout.maxLength = 600;
    zhAbout.rows = 2;
    const humor = el('input');
    humor.type = 'range';
    humor.min = '0';
    humor.max = '100';
    humor.step = '5';
    const humorOut = el('output', 'persona-humor-out');
    humorOut.id = 'persona-humor-out';
    humor.addEventListener('input', () => { humorOut.textContent = `${humor.value}%`; });
    const humorRow = field('persona-humor', 'Humor it starts with', humor);
    const voice = el('select');
    const voiceRow = field('persona-voice', 'Voice', voice);
    voiceRow.append(el('small', 'persona-note', 'It speaks with this while it’s in use. More voices are in Settings › Speaking.'));
    humorRow.querySelector('span').append(' ', humorOut);
    const error = el('p', 'persona-error');
    error.id = 'persona-error';
    error.hidden = true;
    const actions = el('div', 'row-actions');
    const save = el('button', 'btn primary', 'Save persona');
    save.type = 'submit';
    save.id = 'persona-save';
    actions.append(save, button('Cancel', 'btn', () => close()));
    form.append(
      field('persona-name', 'Name', name),
      field('persona-about', 'What it’s like', about),
      field('persona-zh-name', 'Name in Chinese (optional)', zhName),
      field('persona-zh-about', 'What it’s like, in Chinese (optional)', zhAbout),
      humorRow, voiceRow, error, actions,
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const persona = {
        name: name.value.trim(),
        description: about.value.trim(),
        zh_name: zhName.value.trim(),
        zh_description: zhAbout.value.trim(),
        humor: Number(humor.value),
        extra: { voice: PV ? PV.fromValue(voice.value) : {} },
      };
      if (S.editing && S.editing.id) persona.id = S.editing.id;
      save.disabled = true;
      S.saving = true;
      send({ type: 'persona_save', persona });
    });
    box.append(el('div', 'persona-kicker', 'Your personas'), list, add, form);
    choice.after(box);
    return box;
  }

  function edit(persona) {
    if (!build()) return;
    S.editing = persona || { id: '' };
    const p = persona || { name: '', description: '', zh_name: '', zh_description: '', humor: 60 };
    $('persona-name').value = p.name;
    $('persona-about').value = p.description;
    $('persona-zh-name').value = p.zh_name || '';
    $('persona-zh-about').value = p.zh_description || '';
    $('persona-humor').value = String(p.humor);
    $('persona-humor-out').textContent = `${p.humor}%`;
    drawVoices((p.extra && p.extra.voice) || {});
    if (S.voice === null) send({ type: 'voice_status' });
    else if (S.voice.mac_voices === null && !S.macAsked) { S.macAsked = true; send({ type: 'voice_list', provider: 'say' }); }
    $('persona-error').hidden = true;
    $('persona-save').disabled = false;
    $('persona-form').hidden = false;
    $('persona-new').hidden = true;
    $('persona-name').focus({ preventScroll: true });
  }

  function close() {
    S.editing = null;
    if (!$('persona-form')) return;
    $('persona-form').hidden = true;
    render();
  }

  function remove(persona, b) {
    if (S.confirm !== persona.id) { // a second press within a few seconds deletes it
      S.confirm = persona.id;
      b.textContent = T('Delete it?');
      clearTimeout(S.confirmTimer);
      S.confirmTimer = setTimeout(() => { S.confirm = ''; render(); }, 4000);
      return;
    }
    S.confirm = '';
    clearTimeout(S.confirmTimer);
    send({ type: 'persona_delete', id: persona.id });
  }

  function render() {
    if (!build()) return;
    const list = $('persona-list');
    list.replaceChildren(...S.items.map((persona) => {
      const li = el('li', 'persona-item');
      li.dataset.persona = persona.id;
      const words = el('span', 'persona-words');
      words.append(mine(el('strong', '', persona.name)), mine(el('small', '', persona.description)));
      const edits = el('span', 'persona-buttons');
      edits.append(button('Edit', 'btn', () => edit(persona)));
      const del = button(S.confirm === persona.id ? 'Delete it?' : 'Delete', 'btn', () => remove(persona, del));
      edits.append(del);
      li.append(words, edits);
      return li;
    }));
    const add = $('persona-new');
    const full = S.items.length >= S.max;
    add.hidden = !!S.editing;
    add.disabled = full;
    add.title = full ? T(`There's room for ${S.max} personas of your own.`) : '';
  }

  F.on('personas_custom', (ev) => {
    S.items = ev.items || [];
    S.max = ev.max || 8;
    const form = $('persona-form');
    const saved = S.saving;
    S.saving = false;
    if (ev.error && form && !form.hidden) {
      $('persona-error').textContent = T(ev.error);
      $('persona-error').hidden = false;
      $('persona-save').disabled = false;
      render();
      return;
    }
    if (saved && form && !form.hidden) close(); // saved: the editor's work is done
    else render();
  });
  F.on('hello', () => send({ type: 'personas_list' }), { replay: true });
  F.on('voice', (ev) => {
    S.voice = ev;
    const form = $('persona-form');
    if (!form || form.hidden) return;
    if (ev.mac_voices === null && !S.macAsked) { S.macAsked = true; send({ type: 'voice_list', provider: 'say' }); }
    drawVoices();
  }, { replay: true });

  render();
})();
