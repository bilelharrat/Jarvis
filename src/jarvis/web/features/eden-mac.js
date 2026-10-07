// Settings › Jarvis in other apps: what Eden (and the other apps reaching Jarvis) may do with
// this Mac's files and screen (the backend is jarvis.features.eden_mac): search and read files,
// in which folders, a picture of the window for "What's on my screen?", and the folders indexed
// as project knowledge (removing one deletes Jarvis's index, never the files). Paths and names
// are this Mac's own: shown as data.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;

  let state = null;
  let drawn = '';

  function mine(node) {
    node.setAttribute('data-no-i18n', '');
    return node;
  }

  function toggle(id, label, help) {
    const row = el('div', 'row');
    const words = el('span');
    words.append(el('strong', '', label), el('small', '', help));
    const sw = el('button', 'switch');
    sw.type = 'button';
    sw.id = id;
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', 'false');
    sw.setAttribute('aria-label', label);
    row.append(words, sw);
    return row;
  }

  function group() {
    let section = F.$('eden-mac-group');
    if (section) return section;
    const settings = F.$('settings');
    if (!settings) return null;
    section = el('section', 'group eden-mac-group');
    section.id = 'eden-mac-group';
    const files = toggle('sw-eden-files', 'Let apps search and read your files', 'Read only, after a card the first time each app asks. Never Library, hidden files, caches, keys or passwords. What they read goes to that app and the model behind it.');
    const picture = toggle('sw-eden-picture', 'Send a picture with "What\'s on my screen?"', 'Off: only the app, the window\'s title, its text and what you selected go. Every look asks you on a card first (unless screen awareness is on).');
    files.querySelector('.switch').addEventListener('click', () => send({ type: 'eden_mac_set', files: !(state && state.files) }));
    picture.querySelector('.switch').addEventListener('click', () => send({ type: 'eden_mac_set', picture: !(state && state.picture) }));
    const where = el('p', 'small-status');
    where.id = 'eden-mac-where';
    const list = el('ul', 'eden-mac-list');
    list.id = 'eden-mac-folders';
    const add = el('button', 'btn', 'Add a folder…');
    add.type = 'button';
    add.addEventListener('click', async () => {
      const path = await F.pickFolder('The full path of a folder apps may read:');
      if (path) send({ type: 'eden_mac_set', folders: [...((state && state.folders) || []).map((f) => f.path), path] });
    });
    const icloud = el('button', 'btn', 'Add iCloud Drive');
    icloud.type = 'button';
    icloud.addEventListener('click', () => send({ type: 'eden_mac_set', folders: [...((state && state.folders) || []).map((f) => f.path), '~/Library/Mobile Documents/com~apple~CloudDocs'] }));
    const acts = el('div', 'eden-mac-acts');
    acts.append(add, icloud);
    const kHead = el('strong', 'eden-mac-sub', 'Project knowledge (indexed on this Mac)');
    const knowledge = el('ul', 'eden-mac-list');
    knowledge.id = 'eden-mac-knowledge';
    section.append(el('h3', '', 'Eden on your Mac'), files, where, list, acts, picture, kHead, knowledge);
    const mcp = F.$('mcp-group');
    if (mcp && mcp.parentNode) mcp.parentNode.insertBefore(section, mcp.nextSibling); else settings.append(section);
    return section;
  }

  function removeButton(label, onClick) {
    const b = el('button', 'btn eden-mac-x', 'Remove');
    b.type = 'button';
    b.setAttribute('aria-label', `${F.t('Remove')} ${label}`);
    b.addEventListener('click', onClick);
    return b;
  }

  function render() {
    if (!group() || !state) return;
    const sig = JSON.stringify(state);
    if (sig === drawn) return;
    drawn = sig;
    F.$('sw-eden-files').setAttribute('aria-checked', String(!!state.files));
    F.$('sw-eden-picture').setAttribute('aria-checked', String(!!state.picture));
    F.$('eden-mac-where').textContent = state.home ? F.t('Folders: your whole home folder (add folders to allow only those).') : F.t('Only these folders:');
    const folders = state.folders || [];
    F.$('eden-mac-folders').replaceChildren(...folders.map((f) => {
      const li = el('li');
      li.append(mine(el('span', 'eden-mac-path', f.display)), removeButton(f.display, () => send({ type: 'eden_mac_set', folders: folders.filter((x) => x.path !== f.path).map((x) => x.path) })));
      return li;
    }));
    const items = state.knowledge || [];
    const kn = F.$('eden-mac-knowledge');
    if (!items.length) kn.replaceChildren(el('li', 'eden-mac-empty', 'None yet: add one from Eden (Projects › Knowledge).'));
    else kn.replaceChildren(...items.map((k) => {
      const li = el('li');
      const what = k.status === 'ready' ? `${k.files || 0} files` : k.status === 'error' ? (k.error || 'error') : 'indexing…';
      li.append(mine(el('span', 'eden-mac-path', k.display)), el('small', '', what), removeButton(k.display, () => send({ type: 'eden_knowledge_remove', id: k.id })));
      return li;
    }));
  }

  F.on('hello', () => { group(); send({ type: 'eden_mac_state' }); }, { replay: true });
  F.on('eden_mac', (ev) => { state = ev; render(); });
})();
