// Settings › Skills (the backend is jarvis.features.skills): the owner's skills, each with its
// switch, a preview and why it can't be used on this Mac; installing from a folder or a git
// repository (a card first); and the Skill Workshop's drafts to read, then add or discard.
// Names, descriptions and texts are their authors' (or a draft's): shown as data, never markup.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;

  let state = { items: [], proposals: [], offer: true, folder: '', note: '', error: '' };
  const previews = new Map(); // skill name -> { text, files }, while shown
  const readOpen = new Set(); // draft ids shown open
  let drawn = '';

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

  function switchButton(label, on, onClick, disabled = false) {
    const sw = el('button', 'switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(!!on));
    sw.setAttribute('aria-label', label);
    sw.disabled = disabled;
    sw.addEventListener('click', onClick);
    return sw;
  }

  function group() {
    let section = F.$('skills-group');
    if (section) return section;
    const settings = F.$('settings');
    if (!settings) return null;
    section = el('section', 'group skills-group');
    section.id = 'skills-group';
    const list = el('ul', 'sk-list');
    list.id = 'skills-list';
    const status = el('p', 'small-status sk-status');
    status.id = 'skills-status';
    status.setAttribute('role', 'status');
    const install = el('div', 'sk-install');
    install.append(button('Install from a folder…', pickFolder));
    const gitForm = el('div', 'folder-form sk-git-form');
    const git = el('input', 'sk-git');
    git.id = 'skills-git';
    git.type = 'url';
    git.spellcheck = false;
    git.placeholder = 'https://github.com/owner/skills';
    git.setAttribute('aria-label', 'A git repository of skills');
    const gitGo = button('Install from git', () => {
      const url = git.value.trim();
      if (!url) { git.focus(); return; }
      send({ type: 'skills_install_git', url });
      git.value = '';
    });
    git.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); gitGo.click(); } });
    gitForm.append(git, gitGo);
    const drafts = el('div', 'sk-drafts');
    drafts.id = 'skills-drafts';
    const offerRow = el('div', 'row');
    offerRow.id = 'skills-offer-row';
    const offerWords = el('span');
    offerWords.append(el('strong', '', 'Offer to keep long tasks as skills'), el('small', '', 'After a request that took many steps, Jarvis may draft a skill from it for you to read here (a few a day). A draft is never switched on by itself.'));
    offerRow.append(offerWords);
    section.append(
      el('h3', '', 'Skills'),
      el('p', 'group-note', 'How-tos Jarvis follows for particular tasks, each a folder with a SKILL.md. A skill guides how Jarvis works but never lets it do more: every action still asks as usual. New skills stay off until you turn them on.'),
      list,
      install,
      gitForm,
      status,
      drafts,
      offerRow,
    );
    const last = settings.querySelector('#open-accounts');
    const before = last ? last.closest('section.group') : null;
    if (before) settings.insertBefore(section, before); else settings.append(section);
    return section;
  }

  async function pickFolder() {
    const app = window.jarvisApp;
    let path = null;
    try {
      if (app && app.feature) path = await app.feature.invoke('feature:platform:pick-folder', F.t('Choose a skill, or a folder of skills'));
    } catch (_) {
      path = app && app.pickFolder ? await app.pickFolder() : null;  // an app built before this feature
    }
    if (path === null && !app) path = window.prompt(F.t('The full path of the skill’s folder:'));
    if (path && String(path).trim()) send({ type: 'skills_install_folder', path: String(path).trim() });
  }

  function source(text) {
    if (!text) return null;
    const line = el('small', 'sk-source');
    if (text.startsWith('folder:')) line.append(document.createTextNode(F.t('From a folder:') + ' '), mine(el('span', '', text.slice(7))));
    else if (text.startsWith('git:')) line.append(document.createTextNode(F.t('From git:') + ' '), mine(el('span', '', text.slice(4))));
    else line.textContent = F.t('Drafted by Jarvis');
    return line;
  }

  function previewBox(name) {
    const shown = previews.get(name);
    if (!shown) return null;
    const box = el('div', 'sk-preview');
    box.append(mine(el('pre', 'sk-text', shown.text || '')));
    if (shown.files && shown.files.length) {
      box.append(el('small', '', 'Its files:'), mine(el('small', 'sk-files', shown.files.join(', '))));
    }
    return box;
  }

  function skillRow(skill) {
    const li = el('li', `sk-skill${skill.usable ? '' : ' sk-unusable'}`);
    const head = el('div', 'sk-head');
    const title = mine(el('strong', 'sk-name', skill.name));
    head.append(title, switchButton('Use this skill', skill.on, () => send({ type: 'skills_toggle', name: skill.name, on: !skill.on }), !skill.usable && !skill.on));
    li.append(head);
    if (skill.description) li.append(mine(el('p', 'sk-description', skill.description)));
    for (const problem of skill.problems || []) li.append(el('small', 'sk-problem', problem));
    const from = source(skill.source);
    if (from) li.append(from);
    if (skill.allowed_tools) {
      const tools = el('small', 'sk-tools');
      tools.append(document.createTextNode(F.t('It asks to pre-approve tools, which Jarvis never does:') + ' '), mine(el('span', '', skill.allowed_tools)));
      li.append(tools);
    }
    const actions = el('div', 'sk-actions');
    const open = previews.has(skill.name);
    actions.append(
      button(open ? 'Hide' : 'Preview', () => {
        if (open) { previews.delete(skill.name); render(true); } else send({ type: 'skills_preview', name: skill.name });
      }),
      button('Remove', () => {
        if (window.confirm(F.t(`Move ${skill.name} to the Trash? Jarvis stops using it.`))) send({ type: 'skills_remove', name: skill.name });
      }),
    );
    li.append(actions);
    const box = previewBox(skill.name);
    if (box) li.append(box);
    return li;
  }

  function draftRow(item) {
    const li = el('li', 'sk-draft');
    const head = el('div', 'sk-head');
    head.append(mine(el('strong', 'sk-name', item.name)));
    li.append(head, mine(el('p', 'sk-description', item.description)));
    if (item.request) {
      const from = el('small', 'sk-source');
      from.append(document.createTextNode(F.t('From what you asked:') + ' '), mine(el('span', '', `“${item.request}”`)));
      li.append(from);
    }
    const open = readOpen.has(item.id);
    const actions = el('div', 'sk-actions');
    actions.append(
      button(open ? 'Hide' : 'Read it', () => { if (open) readOpen.delete(item.id); else readOpen.add(item.id); render(true); }),
      button('Add to my skills', () => send({ type: 'skills_accept', id: item.id }), 'btn primary'),
      button('Discard', () => send({ type: 'skills_discard', id: item.id })),
    );
    li.append(actions);
    if (open) li.append(mine(el('pre', 'sk-text', item.text)));
    return li;
  }

  function render(force = false) {
    const section = group();
    if (!section) return;
    const sig = JSON.stringify([state, [...previews.keys()], [...readOpen]]);
    if (!force && sig === drawn) return;
    drawn = sig;
    const list = F.$('skills-list');
    list.replaceChildren(...(state.items.length ? state.items.map(skillRow) : [el('li', 'muted', 'No skills yet.')]));
    const status = F.$('skills-status');
    status.textContent = state.error || state.note || '';
    status.classList.toggle('bad', !!state.error);
    status.hidden = !(state.error || state.note);
    const drafts = F.$('skills-drafts');
    drafts.replaceChildren();
    drafts.hidden = !state.proposals.length;
    if (state.proposals.length) {
      const ul = el('ul', 'sk-list');
      ul.append(...state.proposals.map(draftRow));
      drafts.append(el('h4', 'sk-subhead', 'Drafted for you to review'), ul);
    }
    const row = F.$('skills-offer-row');
    const old = row.querySelector('.switch');
    if (old) old.remove();
    row.append(switchButton('Offer to keep long tasks as skills', state.offer, () => send({ type: 'skills_offer', on: !state.offer })));
  }

  F.on('hello', () => { render(true); send({ type: 'skills_state' }); }, { replay: true });
  F.on('skills', (ev) => {
    state = { items: ev.items || [], proposals: ev.proposals || [], offer: ev.offer !== false, folder: ev.folder || '', note: ev.note || '', error: ev.error || '' };
    const names = new Set(state.items.map((s) => s.name));
    for (const name of [...previews.keys()]) if (!names.has(name)) previews.delete(name);
    render();
  });
  F.on('skills_preview', (ev) => { previews.set(ev.name, { text: ev.text || '', files: ev.files || [] }); render(true); });
})();
