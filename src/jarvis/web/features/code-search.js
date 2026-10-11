// Eden Code's project search (features/code_workspace.py, code_search.py): a Search view
// beside the file list in the Files pane (features/code-editor.js).
// - Text or a regular expression, match case, whole words, and which files ("*.py, src/,
//   !tests/"); it searches as you type (a newer search stops the one before) or on Enter.
// - The matches by file, the matched part marked; a match opens its file at its line.
// - A file's matches become an @-mention in the composer (one file, or all of them), for
//   Eden Code to read.
// Pure helpers are exported for node --test (tests/web/code-search.test.mjs).
(function (root) {
  'use strict';

  const WAIT_MS = 350;  // after the last key, a search
  const MIN_CHARS = 2;  // fewer, and only Enter searches
  const MENTION_ALL_MAX = 20;  // files "Mention all" puts in the composer

  // A line cut into [text, matched?] pieces by the spans the search found.
  function pieces(text, spans) {
    const out = [];
    let at = 0;
    for (const [s, e] of (spans || []).slice().sort((a, b) => a[0] - b[0])) {
      if (s < at || e <= s || s >= text.length) continue;
      if (s > at) out.push([text.slice(at, s), false]);
      out.push([text.slice(s, Math.min(e, text.length)), true]);
      at = Math.min(e, text.length);
    }
    if (at < text.length) out.push([text.slice(at), false]);
    return out;
  }

  // What a result says: "12 matches in 3 files", or why there are none, and when it's only
  // part of them: a limit, the time running out, an expression too slow on a file (r.slow:
  // the walk stopped there; git's matches are all there, some without their marks).
  function summary(r) {
    if (!r) return '';
    if (r.error) return r.error;
    if (!r.total) {
      if (r.slow) return `That expression is too slow to search with (on ${r.slow}).`;
      return r.stopped ? 'Stopped before anything matched.' : 'No matches.';
    }
    const files = r.files.length;
    const head = `${r.total} ${r.total === 1 ? 'match' : 'matches'} in ${files} ${files === 1 ? 'file' : 'files'}`;
    if (r.slow && r.engine === 'git') return `${head} (some unmarked: the expression was too slow on them)`;
    if (r.slow) return `${head} (the first ones only: the expression was too slow on ${r.slow})`;
    if (r.stopped) return `${head} (the first ones only: the search ran out of time)`;
    return r.truncated ? `${head} (the first ones only)` : head;
  }

  // A path as an @-mention: in quotes when it has a space (@"my dir/a b.py").
  function mentionWord(path) { return /\s/.test(path) ? `@"${path}"` : `@${path}`; }

  // Text for the composer that mentions files: "@a.py @b.py ", spaced from what's there.
  function mentionText(paths, before) {
    const words = paths.map(mentionWord).join(' ');
    return `${before && !/\s$/.test(before) ? ' ' : ''}${words} `;
  }

  // This page's own refs: answers go to every window, and each window's count starts at 1,
  // so a ref carries the page too ("k3x9q-s4"); the backend stops only this page's older
  // search for a newer one (features/code_workspace.py).
  function newRef(page, n) { return `${page}-s${n}`; }

  const api = { pieces, summary, mentionText, mentionWord, newRef };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F || !root.JarvisEditor) return;
  const { el } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  const state = { text: '', regex: false, case: false, word: false, include: '', result: null, ref: '', busy: false, where: '' };
  let refN = 0;
  const PAGE = Math.random().toString(36).slice(2, 10) || 'p';
  let timer = 0;
  let host = null;
  let ui = null;

  // Mention files in the composer, where the caret is.
  function mention(paths) {
    const input = F.$('deck-input');
    if (!input || !paths.length) return;
    const at = input.selectionStart ?? input.value.length;
    const text = mentionText(paths, input.value.slice(0, at));
    input.value = input.value.slice(0, at) + text + input.value.slice(at);
    input.selectionStart = input.selectionEnd = at + text.length;
    input.dispatchEvent(new Event('input'));
    input.focus();
  }

  function run(now) {
    clearTimeout(timer);
    const text = state.text;
    if (!text.trim() || (!now && text.trim().length < MIN_CHARS)) {
      // (cleared: the answer to a search still out isn't shown under the empty box)
      if (!text.trim()) { state.result = null; state.busy = false; state.ref = ''; state.where = ''; draw(); }
      return;
    }
    const go = () => {
      state.ref = newRef(PAGE, ++refN);
      state.busy = true;
      const where = root.JarvisEditor.where();
      state.where = JSON.stringify(where);
      F.send({ type: 'cw_search', ...where, text, regex: state.regex, case: state.case, word: state.word, include: state.include, ref: state.ref });
      drawStatus();
    };
    if (now) go(); else timer = setTimeout(go, WAIT_MS);
  }

  function toggle(label, title, prop) {
    const b = el('button', 'ce-opt', label);
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-pressed', String(state[prop]));
    b.addEventListener('click', () => { state[prop] = !state[prop]; b.setAttribute('aria-pressed', String(state[prop])); run(true); });
    return b;
  }

  function build() {
    const box = el('div', 'cs-root');
    const row = el('div', 'ce-find-row');
    const input = el('input', 'jc-field cs-input');
    input.type = 'search';
    input.placeholder = 'Search the project';
    input.setAttribute('aria-label', 'Search the project');
    input.value = state.text;
    input.addEventListener('input', () => { state.text = input.value; run(false); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); run(true); }
      if (e.key === 'Escape' && input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; state.text = ''; run(true); }
    });
    row.append(input, toggle('Aa', 'Match case', 'case'), toggle('ab', 'Whole words', 'word'), toggle('.*', 'Regular expression', 'regex'));
    const include = el('input', 'jc-field cs-include');
    include.placeholder = 'Files to search: *.py, src/, !tests/';
    include.setAttribute('aria-label', 'Files to search');
    include.value = state.include;
    include.addEventListener('input', () => { state.include = include.value; run(false); });
    include.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(true); } });
    const status = el('div', 'cs-status');
    status.setAttribute('aria-live', 'polite');
    const all = el('button', 'jc-mini cs-all', 'Mention all');
    all.type = 'button';
    all.title = 'Put these files in the message, as @-mentions';
    all.addEventListener('click', () => { if (state.result) mention(state.result.files.slice(0, MENTION_ALL_MAX).map((f) => f.path)); });
    const bar = el('div', 'cs-bar');
    bar.append(status, all);
    const list = el('div', 'cs-results');
    box.append(row, include, bar, list);
    return { box, input, include, status, all, list };
  }

  function drawStatus() {
    if (!ui) return;
    const r = state.result;
    ui.status.classList.toggle('bad', !!(r && r.error));
    ui.status.textContent = state.busy ? 'Searching…' : summary(r);
    ui.all.hidden = state.busy || !r || !r.files || r.files.length < 2;
  }

  function drawResults() {
    if (!ui || ui.drawn === state.result) return;  // (the pane draws often; the matches only change with an answer)
    ui.drawn = state.result;
    const r = state.result;
    const files = r && r.files ? r.files : [];
    ui.list.replaceChildren(...files.map((f) => {
      const group = el('details', 'cs-file');
      group.open = true;
      const head = el('summary', 'cs-file-head');
      const name = mine(el('span', 'cs-path'));
      const cut = f.path.lastIndexOf('/');
      name.append(el('strong', '', f.path.slice(cut + 1)));
      if (cut >= 0) name.append(el('span', 'cs-dir', ` ${f.path.slice(0, cut)}`));
      name.title = f.path;
      const count = el('span', 'cs-count', String(f.matches.length) + (f.more ? '+' : ''));
      const at = el('button', 'jc-mini cs-mention', '@');
      at.type = 'button';
      at.title = 'Mention this file in the message';
      at.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); mention([f.path]); });
      head.append(name, count, at);
      group.append(head);
      for (const m of f.matches) {
        const line = el('button', 'cs-match');
        line.type = 'button';
        line.title = `${f.path}:${m.line}`;
        const text = mine(el('span', 'cs-text'));
        // (bidi controls shown as what they are: code-markdown.js showBidi)
        const plain = (x) => (root.JarvisMarkdown && root.JarvisMarkdown.showBidi ? root.JarvisMarkdown.showBidi(x) : x);
        for (const [piece, hit] of pieces(m.text, m.spans)) text.append(hit ? el('mark', '', plain(piece)) : document.createTextNode(plain(piece)));
        line.append(el('span', 'cs-line', String(m.line)), text);
        line.addEventListener('click', () => root.JarvisEditor.open(f.path, m.line));
        group.append(line);
      }
      return group;
    }));
  }

  function draw() {
    drawStatus();
    drawResults();
  }

  root.JarvisEditor.registerView('search', {
    label: 'Search',
    render(into) {
      if (!ui) ui = build();
      if (host !== into || !into.contains(ui.box)) { host = into; into.replaceChildren(ui.box); }
      // Another session or project shown since: its own files are what to search (a search
      // still out for the one before too: its answer is for there).
      const where = JSON.stringify(root.JarvisEditor.where());
      if (state.where && state.where !== where) { state.result = null; state.where = ''; run(true); }
      draw();
    },
    focus() { if (ui) requestAnimationFrame(() => { ui.input.focus(); ui.input.select(); }); },
  });

  F.on('cw_search', (ev) => {
    if (ev.ref !== state.ref) return;  // an older search's answer
    state.busy = false;
    state.result = ev;
    draw();
  });

  // (CA2-12) Connected again while a search was out: its answer went to the old connection,
  // so it's asked again (a new ref), never left at "Searching…".
  F.on('hello', () => { if (state.busy && state.text.trim()) run(true); });
})(typeof window === 'object' ? window : globalThis);
