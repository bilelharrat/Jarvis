// Videos made with the owner's Google Gemini key and Veo (the backend is
// jarvis.features.video_gen): each on a card when it's ready (Open, Show in Finder), and
// Settings › Videos (the Veo model, its estimated price, the folder). The description and
// the file name are shown as data.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;

  let videos = null;

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

  // ── a video on a card ──

  function showVideo(ev) {
    const card = el('div', 'card plain vid-card');
    const saved = el('div', 'card-text vid-saved');
    saved.append(document.createTextNode(F.t('Saved in Documents › Jarvis › Videos as') + ' '), mine(el('span', '', ev.name || '')));
    const price = el('div', 'card-text vid-saved');  // the backend's words, in the owner's language
    price.append(document.createTextNode(F.t('Estimated, billed to your Gemini key:') + ' '), mine(el('span', '', ev.cost || '')));
    card.append(el('div', 'card-kicker', 'Video'), mine(el('div', 'card-title vid-prompt', ev.prompt || '')), saved, price);
    const actions = el('div', 'card-actions');
    actions.append(
      button('Play', () => send({ type: 'veo_open', id: ev.id }), 'btn primary'),
      button('Show in Finder', () => send({ type: 'veo_reveal', id: ev.id })),
      button('Dismiss', () => { card.remove(); tidy(); }),
    );
    card.append(actions);
    F.$('cards').append(card);
    tidy();
  }

  // ── Settings › Videos ──

  function group() {
    let section = F.$('videos-group');
    if (section) return section;
    const settings = F.$('settings');
    if (!settings) return null;
    section = el('section', 'group videos-group');
    section.id = 'videos-group';
    const status = el('p', 'small-status');
    status.id = 'videos-status';
    const row = el('label', 'row stack');
    row.htmlFor = 'video-model';
    const words = el('span');
    words.append(el('strong', '', 'Video model'), el('small', '', 'A Google Veo model. Google charges by the second of video; Jarvis shows the estimate and asks before each one.'));
    const input = el('input');
    input.id = 'video-model';
    input.type = 'text';
    input.spellcheck = false;
    input.addEventListener('change', () => send({ type: 'feature_prefs', changes: { video_model: input.value.trim() || (videos && videos.default_model) || '' } }));
    row.append(words, input);
    section.append(el('h3', '', 'Videos'), status, row, button('Show the Videos folder', () => send({ type: 'veo_folder' })));
    const pictures = F.$('pictures-group');
    const last = settings.querySelector('#open-accounts');
    const before = last ? last.closest('section.group') : null;
    if (pictures) pictures.after(section);
    else if (before) settings.insertBefore(section, before);
    else settings.append(section);
    return section;
  }

  function render() {
    if (!group() || !videos) return;
    const status = F.$('videos-status');
    if (videos.key) {
      status.replaceChildren(
        document.createTextNode(F.t('Ask for a short video and Jarvis makes it with Google Veo on your Gemini key, after you OK the estimated price:') + ' '),
        mine(el('span', '', videos.cost || '')),
      );
    } else {
      status.textContent = F.t('To make videos, add a Google Gemini key in Settings › Models.');
    }
    const input = F.$('video-model');
    if (document.activeElement !== input) input.value = videos.model || '';
    input.placeholder = videos.default_model || '';
  }

  F.on('hello', () => { group(); send({ type: 'veo_state' }); }, { replay: true });
  F.on('video_made', showVideo);
  F.on('videos', (ev) => { videos = ev; render(); });
  F.on('providers', () => send({ type: 'veo_state' }));  // a Gemini key added or removed
  F.on('prefs', (p) => {  // the model as kept (a name that isn't one is refused), its price
    const kept = p.features && p.features.video_model;
    if (videos && kept && kept !== videos.model) send({ type: 'veo_state' });
  });
})();
