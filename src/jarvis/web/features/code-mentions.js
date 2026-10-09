// Eden Code's richer @-mentions (features/code_mentions.py, code_mentions.py): the
// composer's @ suggestions beyond files.
// - @terminal: the last lines of the project's terminal go with the message.
// - Folders: a project folder, as its path (Eden Code reads it itself).
// - Symbols: where a name is defined, as its file and line ("@src/app.py (retry, line 12)").
// - @session-3 after the message's first words: that session's latest reply goes with it.
//   (At the start, @session-3 sends the message to session 3: code-voice.js suggests those.)
// - A web address typed as @https://… is fetched when the message is sent, never before.
// Pure helpers are exported for node --test (tests/web/code-mentions.test.mjs).
(function (root) {
  'use strict';

  const FOLDERS_SHOWN = 4;
  const SYMBOLS_SHOWN = 6;
  const SESSIONS_SHOWN = 4;

  // The folders of a project's file list, each once: "src", "src/jarvis"…
  function foldersOf(files) {
    const out = new Set();
    for (const f of files || []) {
      let at = f.indexOf('/');
      while (at > 0) { out.add(f.slice(0, at)); at = f.indexOf('/', at + 1); }
    }
    return [...out];
  }

  // Folders matching what's typed after @: the ones whose name starts with it first.
  function matchFolders(folders, query, limit = FOLDERS_SHOWN) {
    const q = String(query || '').toLowerCase().replace(/\/$/, '');
    if (!q) return [];
    const scored = [];
    for (const d of folders) {
      const lower = d.toLowerCase();
      if (!lower.includes(q)) continue;
      const name = lower.slice(lower.lastIndexOf('/') + 1);
      scored.push([name.startsWith(q) ? 0 : lower.startsWith(q) ? 1 : 2, d.length, d]);
    }
    return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : 1)).slice(0, limit).map((s) => s[2]);
  }

  // What a symbol suggestion puts in the message: its file, and where in it.
  function symbolValue(s) { return `${s.path} (${s.name}, line ${s.line})`; }

  // Whether @ is after the message's first words (where @session-3 is a mention, not a route).
  function midMessage(before) { return /\S/.test(String(before || '').replace(/@[\w./-]*$/, '')); }

  const api = { foldersOf, matchFolders, symbolValue, midMessage };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F || !F.registerMentions) return;
  const { t } = F;  // (the @ list draws its notes as they are: they're put in Chinese here)

  function project() { return typeof deckProject !== 'undefined' ? deckProject : ''; }
  function where() { const t = F.currentTask(); return t ? { id: t.id, directory: project() } : { directory: project() }; }

  let folderCache = { files: null, folders: [] };
  function folders() {
    const files = typeof projectFiles !== 'undefined' ? projectFiles[project()] : null;
    if (files !== folderCache.files) folderCache = { files, folders: foldersOf(files) };
    return folderCache.folders;
  }

  // Symbols: asked of the backend as the owner types (a moment after the last key), kept
  // by what was typed; the suggestions show them when they come.
  const symbolAnswers = new Map();  // `${where}\n${query}` -> [{ name, path, line }] | 'asking'
  let symbolTimer = 0;
  function symbolsFor(query) {
    const key = `${JSON.stringify(where())}\n${query.toLowerCase()}`;
    const known = symbolAnswers.get(key);
    if (Array.isArray(known)) return known;
    if (known !== 'asking') {
      clearTimeout(symbolTimer);
      symbolTimer = setTimeout(() => {
        // (asking only once it went: one that couldn't go is asked as it's typed again)
        if (F.send({ type: 'cw_symbols', ...where(), query, ref: key })) symbolAnswers.set(key, 'asking');
      }, 150);
    }
    return [];
  }

  F.on('cw_symbols', (ev) => {
    if (!ev.ref) return;
    symbolAnswers.set(ev.ref, ev.items || []);
    while (symbolAnswers.size > 200) symbolAnswers.delete(symbolAnswers.keys().next().value);
    // (still typing there: the suggestions are drawn again, these with them. A list hidden
    // with rows in it was closed, by Escape, a pick or a send, and stays closed: Enter sends
    // then; a hidden empty one just had nothing to show till now.)
    const box = F.$('cc-slash');
    if (typeof renderSuggestions === 'function' && document.activeElement === F.$('deck-input') && box && (!box.hidden || !box.children.length)) renderSuggestions();
  });

  // Files and folders change: the answers made from them go.
  F.on('project_files', () => symbolAnswers.clear());

  F.registerMentions((query, before) => {
    const q = String(query || '');
    const items = [];
    if ('terminal'.startsWith(q.toLowerCase())) {
      items.push({ label: '@terminal', help: t('Its last lines go with the message'), value: 'terminal' });
    }
    if (midMessage(before)) {
      const current = F.currentTask();
      const tasks = typeof ccTasks !== 'undefined' ? ccTasks : [];
      const lower = q.toLowerCase();
      const digits = (lower.match(/(\d+)$/) || [])[1] || '';
      if (!q || 'session'.startsWith(lower) || /^session-?\d*$/.test(lower) || /^\d+$/.test(lower)) {
        for (const x of tasks.filter((y) => y && y.kind === 'code' && (!current || y.id !== current.id))
          .filter((y) => !digits || String(y.id).startsWith(digits)).slice(0, SESSIONS_SHOWN)) {
          items.push({ label: `@session-${x.id}`, help: `${String(x.title || x.prompt || '').slice(0, 50)} · ${t('its latest reply goes with the message')}`, value: `session-${x.id}` });
        }
      }
    }
    for (const d of matchFolders(folders(), q)) items.push({ label: `${d}/`, help: t('Folder'), value: `${d}/` });
    if (q.length >= 2 && /^[\w$]+$/.test(q)) {
      for (const s of symbolsFor(q).slice(0, SYMBOLS_SHOWN)) items.push({ label: s.name, help: `${s.path}:${s.line}`, value: symbolValue(s) });
    }
    return items;
  });

  // A word about the mentions: a page being read, one that couldn't be.
  F.on('cw_mentions', (ev) => { if (ev.text && typeof jcNote === 'function') jcNote(ev.text); });
})(typeof window === 'object' ? window : globalThis);
