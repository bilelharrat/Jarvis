// Projects for the main chat, as the Claude, ChatGPT and Gemini apps have them
// (features/chat_projects.py does the work): a 📁 chip by the request box opens a panel of
// projects. Open one and the conversations started belong to it, with its instructions and
// files; edit its name, instructions and files; see its conversations and carry one on; add
// the conversation going on to it. helpers is exported for node --test
// (tests/web/chat-projects.test.mjs).
(function (root) {
  'use strict';

  const helpers = {
    // The chip's words: the open project's name, or just Projects.
    chipLabel(listing) {
      const items = (listing && listing.items) || [];
      const open = items.find((p) => p.id === (listing && listing.active));
      return open ? open.name : '';
    },
    // 'pdf', 'text', or '' for a file a project can't keep.
    kindOf(name, type) {
      if (type === 'application/pdf' || /\.pdf$/i.test(name || '')) return 'pdf';
      if (String(type || '').startsWith('image/')) return '';
      if (String(type || '').startsWith('text/') || type === 'application/json') return 'text';
      return /\.(md|markdown|txt|csv|tsv|json|jsonl|ya?ml|toml|ini|xml|html?|css|js|mjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|sh|sql|log)$/i.test(name || '') ? 'text' : '';
    },
    // The project the conversation going on belongs to, if any.
    projectOf(listing, sid) {
      if (!sid) return null;
      return ((listing && listing.items) || []).find((p) => (p.conversations || []).some((c) => c.session_id === sid)) || null;
    },
    size(chars) {
      const n = Number(chars) || 0;
      return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
    },
  };

  if (typeof module === 'object' && module.exports) { module.exports = helpers; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const t = (s) => F.t(s);
  /* global notice */
  let listing = { items: [], active: '', current: '' };
  let chip = null;
  let panel = null;
  let editing = null; // a project's id, 'new', or null for the list

  function button(label, cls, run) {
    const b = F.el('button', cls, t(label));
    b.type = 'button';
    b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
    return b;
  }

  function drawChip() {
    if (!chip) return;
    const name = helpers.chipLabel(listing);
    chip.classList.toggle('cp-on', Boolean(name));
    chip.textContent = `📁 ${name || t('Projects')}`;
    chip.title = name ? t('Conversations started now are in this project. Click to change.') : t('Keep conversations together, with instructions and files they share.');
  }

  function close() {
    if (panel) { panel.remove(); panel = null; }
    editing = null;
  }

  function open() {
    if (!panel) {
      panel = F.el('section', 'cp-panel');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', t('Projects'));
      panel.addEventListener('click', (e) => e.stopPropagation());
      panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
      document.body.append(panel);
    }
    draw();
    F.send({ type: 'chat_projects' });
  }

  function draw() {
    if (!panel) return;
    panel.replaceChildren();
    const project = editing && editing !== 'new' ? listing.items.find((p) => p.id === editing) : null;
    if (editing === 'new' || project) drawEditor(project);
    else drawList();
  }

  function drawList() {
    const head = F.el('header', 'cp-head');
    head.append(F.el('h3', '', t('Projects')), button('New project', 'cp-new', () => { editing = 'new'; draw(); }));
    panel.append(head);
    if (!listing.items.length) {
      panel.append(F.el('p', 'cp-empty', t('A project keeps conversations together, with instructions and files Jarvis uses in each of them.')));
      return;
    }
    const list = F.el('ul', 'cp-list');
    for (const p of listing.items) {
      const li = F.el('li', `cp-row${p.id === listing.active ? ' cp-active' : ''}`);
      const words = F.el('div', 'cp-words');
      words.append(F.el('div', 'cp-name', p.name));
      const counts = [];
      if ((p.conversations || []).length) counts.push(`${p.conversations.length} ${t(p.conversations.length === 1 ? 'conversation' : 'conversations')}`);
      if ((p.files || []).length) counts.push(`${p.files.length} ${t(p.files.length === 1 ? 'file' : 'files')}`);
      if (counts.length) words.append(F.el('div', 'cp-sub', counts.join(' · ')));
      words.addEventListener('click', () => { editing = p.id; draw(); });
      const use = p.id === listing.active
        ? button('Close', 'cp-btn', () => F.send({ type: 'chat_project_use', id: '' }))
        : button('Open', 'cp-btn primary', () => { F.send({ type: 'chat_project_use', id: p.id }); close(); });
      li.append(words, use);
      list.append(li);
    }
    panel.append(list);
  }

  function readFile(file, kind) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      if (kind === 'pdf') reader.readAsDataURL(file);
      else reader.readAsText(file);
    });
  }

  async function addFiles(id, files) {
    for (const file of files) {
      const kind = helpers.kindOf(file.name, file.type);
      if (!kind) { if (typeof notice === 'function') notice(t('Projects'), '', t('Projects keep PDFs and text files.'), 6000); continue; }
      try {
        const raw = await readFile(file, kind);
        F.send(kind === 'pdf'
          ? { type: 'chat_project_file', id, name: file.name, pdf: raw.split(',', 2)[1] || '' }
          : { type: 'chat_project_file', id, name: file.name, text: raw });
      } catch (_err) { /* unreadable: nothing is added */ }
    }
  }

  function drawEditor(project) {
    const head = F.el('header', 'cp-head');
    head.append(button('‹ Projects', 'cp-back', () => { editing = null; draw(); }));
    panel.append(head);

    const name = F.el('input', 'cp-input');
    name.type = 'text';
    name.maxLength = 60;
    name.placeholder = t('Project name');
    name.value = project ? project.name : '';
    const instructions = F.el('textarea', 'cp-text');
    instructions.rows = 5;
    instructions.maxLength = 8000;
    instructions.placeholder = t('Instructions for Jarvis in this project (how to answer, what to keep in mind)…');
    instructions.value = project ? project.instructions : '';
    const save = button(project ? 'Save' : 'Create and open', 'cp-btn primary', () => {
      const msg = { type: 'chat_project_save', name: name.value, instructions: instructions.value };
      if (project) msg.id = project.id;
      if (!name.value.trim()) { name.focus(); return; }
      F.send(msg);
      if (!project) close();
    });
    panel.append(F.el('label', 'cp-label', t('Name')), name, F.el('label', 'cp-label', t('Instructions')), instructions, save);
    if (!project) { setTimeout(() => name.focus()); return; }

    panel.append(F.el('h4', 'cp-section', t('Files')));
    const files = F.el('ul', 'cp-files');
    for (const f of project.files || []) {
      const li = F.el('li', 'cp-file');
      li.append(F.el('span', 'cp-file-name', f.name), F.el('span', 'cp-sub', `${helpers.size(f.chars)} ${t('characters')}`),
        button('✕', 'cp-x', () => F.send({ type: 'chat_project_unfile', id: project.id, name: f.name })));
      files.append(li);
    }
    const picker = F.el('input');
    picker.type = 'file';
    picker.multiple = true;
    picker.hidden = true;
    picker.accept = 'application/pdf,.pdf,text/*,.md,.csv,.json,.yml,.yaml,.toml,.xml,.html,.py,.js,.ts,.swift,.sql,.log,.txt';
    picker.addEventListener('change', () => { addFiles(project.id, [...picker.files]); picker.value = ''; });
    panel.append(files, picker, button('Add files…', 'cp-btn', () => picker.click()));

    panel.append(F.el('h4', 'cp-section', t('Conversations')));
    const convos = F.el('ul', 'cp-files');
    for (const c of project.conversations || []) {
      const li = F.el('li', 'cp-file cp-convo');
      const title = F.el('span', 'cp-file-name', c.title || t('Untitled conversation'));
      if (c.session_id === listing.current) title.append(F.el('span', 'cp-now', ` · ${t('now')}`));
      else {
        title.title = t('Carry on this conversation');
        title.addEventListener('click', () => { F.send({ type: 'conversation_resume', session_id: c.session_id }); close(); });
      }
      li.append(title, button('✕', 'cp-x', () => F.send({ type: 'chat_project_assign', session_id: c.session_id, id: '' })));
      convos.append(li);
    }
    panel.append(convos);
    const here = helpers.projectOf(listing, listing.current);
    if (listing.current && (!here || here.id !== project.id)) {
      panel.append(button('Add this conversation', 'cp-btn', () => F.send({ type: 'chat_project_assign', session_id: listing.current, id: project.id })));
    }
    panel.append(button('Delete project', 'cp-btn danger', () => {
      if (root.confirm(t('Delete this project and its files? Its conversations stay.'))) {
        F.send({ type: 'chat_project_delete', id: project.id });
        editing = null;
      }
    }));
  }

  function mount() {
    const chips = document.querySelector('.chips');
    if (!chips || document.getElementById('projects-chip')) return;
    chip = F.el('button', 'chip cp-chip');
    chip.id = 'projects-chip';
    chip.type = 'button';
    chip.addEventListener('click', (e) => { e.stopPropagation(); panel ? close() : open(); });
    chips.append(chip);
    drawChip();
  }

  F.on('chat_projects', (ev) => {
    listing = { items: Array.isArray(ev.items) ? ev.items : [], active: ev.active || '', current: ev.current || '' };
    if (editing && editing !== 'new' && !listing.items.some((p) => p.id === editing)) editing = null;
    drawChip();
    // A panel being typed in isn't drawn over.
    const typing = panel && panel.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (panel && !typing) draw();
  });
  F.on('hello', () => F.send({ type: 'chat_projects' }), { replay: true });
  F.on('turn_done', () => { if (panel) F.send({ type: 'chat_projects' }); });
  document.addEventListener('click', (e) => { if (panel && !panel.contains(e.target)) close(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})(typeof window !== 'undefined' ? window : globalThis);
