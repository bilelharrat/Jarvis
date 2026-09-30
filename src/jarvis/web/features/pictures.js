// Pictures made with the owner's Google Gemini key (the backend is jarvis.features.pictures):
// each on a card (Open, Show in Finder), and Settings › Pictures (the image model, the folder).
// The prompt and the file name are shown as data; the picture only as a data: URL of a
// picture type the backend checked.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;

  let pictures = null;

  function mine(node) {
    node.setAttribute('data-no-i18n', '');
    return node;
  }

  function button(label, onClick, cls = 'btn') {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function tidy() {
    if (typeof syncDismissAll === 'function') syncDismissAll();
  }

  // ── a picture on a card ──

  function showPicture(ev) {
    const card = el('div', 'card plain pic-card');
    const img = document.createElement('img');
    img.className = 'pic-image';
    img.alt = String(ev.prompt || '');
    if (/^image\/(png|jpeg|webp)$/.test(String(ev.mime || '')) && /^[A-Za-z0-9+/=]+$/.test(String(ev.data || ''))) {
      img.src = `data:${ev.mime};base64,${ev.data}`;
    }
    const saved = el('div', 'card-text pic-saved');
    saved.append(document.createTextNode(F.t('Saved in Documents › Jarvis › Images as') + ' '), mine(el('span', '', ev.name || '')));
    const price = el('div', 'card-text pic-saved');  // the backend's words, in the owner's language
    price.append(document.createTextNode(F.t('Billed to your Gemini key:') + ' '), mine(el('span', '', ev.cost || '')));
    card.append(el('div', 'card-kicker', 'Picture'), mine(el('div', 'card-title pic-prompt', ev.prompt || '')), img, saved, price);
    const actions = el('div', 'card-actions');
    actions.append(
      button('Open', () => send({ type: 'image_open', id: ev.id }), 'btn primary'),
      button('Show in Finder', () => send({ type: 'image_reveal', id: ev.id })),
      button('Dismiss', () => { card.remove(); tidy(); }),
    );
    card.append(actions);
    F.$('cards').append(card);
    tidy();
  }

  // ── Settings › Pictures ──

  function group() {
    let section = F.$('pictures-group');
    if (section) return section;
    const settings = F.$('settings');
    if (!settings) return null;
    section = el('section', 'group pictures-group');
    section.id = 'pictures-group';
    const status = el('p', 'small-status');
    status.id = 'pictures-status';
    const row = el('label', 'row stack');
    row.htmlFor = 'image-model';
    const words = el('span');
    words.append(el('strong', '', 'Image model'), el('small', '', 'A Gemini image model. Google’s price is about 4 cents a picture for the default one.'));
    const input = el('input');
    input.id = 'image-model';
    input.type = 'text';
    input.spellcheck = false;
    input.addEventListener('change', () => send({ type: 'feature_prefs', changes: { image_model: input.value.trim() || (pictures && pictures.default_model) || '' } }));
    row.append(words, input);
    section.append(el('h3', '', 'Pictures'), status, row, button('Show the Images folder', () => send({ type: 'pictures_folder' })));
    const last = settings.querySelector('#open-accounts');
    const before = last ? last.closest('section.group') : null;
    if (before) settings.insertBefore(section, before); else settings.append(section);
    return section;
  }

  function render() {
    if (!group() || !pictures) return;
    F.$('pictures-status').textContent = pictures.key
      ? F.t('Ask for a picture and Jarvis makes it with your Google Gemini key, then saves it in Documents › Jarvis › Images.')
      : F.t('To make pictures, add a Google Gemini key in Settings › Models.');
    const input = F.$('image-model');
    if (document.activeElement !== input) input.value = pictures.model || '';
    input.placeholder = pictures.default_model || '';
  }

  F.on('hello', () => { group(); send({ type: 'pictures_state' }); }, { replay: true });
  F.on('image_made', showPicture);
  F.on('pictures', (ev) => { pictures = ev; render(); });
  F.on('providers', () => send({ type: 'pictures_state' }));  // a Gemini key added or removed
  F.on('prefs', (p) => {  // the model as kept (a name that isn't one is refused)
    const kept = p.features && p.features.image_model;
    if (pictures && kept) { pictures.model = kept; render(); }
  });
})();
