// Settings › Privacy: the folders the owner keeps private (local only). Nothing in them is ever
// read into a request to Claude (the backend is jarvis.features.private_mode and
// jarvis.private_folders). The list is the feature pref private_folders: whole paths, added by
// typing or pasting one, taken off with its Remove button. The same works by voice ("keep my
// Grades folder private").
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;

  let folders = [];

  function mine(node) {
    node.setAttribute('data-no-i18n', ''); // a folder's path, as it is
    return node;
  }

  function group() {
    let section = F.$('private-folders-group');
    if (section) return section;
    const settings = F.$('settings');
    if (!settings) return null;
    section = el('section', 'group private-folders-group');
    section.id = 'private-folders-group';
    const about = el('p', 'small-status', 'Files in these folders are never read, indexed, searched or attached for Claude. They stay on this computer.');
    const list = el('ul', 'private-folders-list');
    list.id = 'private-folders-list';
    list.setAttribute('aria-label', F.t('Private folders'));
    const row = el('label', 'row stack');
    row.htmlFor = 'private-folder-path';
    const words = el('span');
    words.append(el('strong', '', 'Add a private folder'), el('small', '', 'Its whole path, like C:\\Users\\you\\Documents\\Grades.'));
    const input = el('input');
    input.id = 'private-folder-path';
    input.type = 'text';
    input.spellcheck = false;
    const add = el('button', 'btn', 'Keep private');
    add.type = 'button';
    const submit = () => {
      const path = input.value.trim();
      if (!path || folders.includes(path)) return;
      send({ type: 'feature_prefs', changes: { private_folders: [...folders, path] } });
      input.value = '';
    };
    add.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    row.append(words, input);
    section.append(el('h3', '', 'Private folders'), about, list, row, add);
    settings.append(section);
    return section;
  }

  function render() {
    if (!group()) return;
    const list = F.$('private-folders-list');
    list.replaceChildren();
    if (!folders.length) {
      list.append(el('li', 'small-status', 'No private folders.'));
      return;
    }
    for (const path of folders) {
      const item = el('li', 'row');
      const remove = el('button', 'btn', 'Remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', `${F.t('Remove')} ${path}`);
      remove.addEventListener('click', () => {
        send({ type: 'feature_prefs', changes: { private_folders: folders.filter((f) => f !== path) } });
      });
      item.append(mine(el('span', '', path)), remove);
      list.append(item);
    }
  }

  const take = (features) => {
    folders = Array.isArray(features && features.private_folders) ? features.private_folders : [];
    render();
  };
  F.on('prefs', (ev) => take(ev.features), { replay: true });
  F.on('hello', (ev) => take(ev.prefs && ev.prefs.features), { replay: true });
})();
