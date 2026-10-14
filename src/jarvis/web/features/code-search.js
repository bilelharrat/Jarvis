// Eden Code's project search (features/code_workspace.py, code_search.py): a Search view
// beside the file list in the Files pane (features/code-editor.js).
// - Text or a regular expression, match case, whole words, and which files ("*.py, src/,
//   !tests/"); it searches as you type (a newer search stops the one before) or on Enter.
// - The matches by file, the matched part marked; a match opens its file at its line.
// - A file's matches become an @-mention in the composer (one file, or all of them), for
//   Eden Code to read.
// - "By meaning" (features/code_index.py, code_index.py): the project's code index instead,
//   by meaning, words and symbol names together ("where do we retry uploads"): the best
//   places first, each with its function or class and why it's there (ci_search).
// Pure helpers are exported for node --test (tests/web/code-search.test.mjs).
(function (root) {
  'use strict';

  const WAIT_MS = 350;  // after the last key, a search
  const MIN_CHARS = 2;  // fewer, and only Enter searches
  const MENTION_ALL_MAX = 20;  // files "Mention all" puts in the composer
  const MEANING_WAIT_MS = 600;  // by meaning: a longer pause (each search embeds the query)

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

  // What a result says: "12 matches in 3 files", or why there are none.
  function summary(r) {
    if (!r) return '';
    if (r.error) return r.error;
    if (r.meaning) {
      const n = r.files.length;
      const head = n ? `${n} ${n === 1 ? 'place' : 'places'} by meaning, best first` : 'Nothing found by meaning';
      return r.note ? `${head}. ${r.note}` : (n ? head : `${head}.`);
    }
    if (!r.total) return r.stopped ? 'Stopped before anything matched.' : 'No matches.';
    const files = r.files.length;
    const head = `${r.total} ${r.total === 1 ? 'match' : 'matches'} in ${files} ${files === 1 ? 'file' : 'files'}`;
    return r.truncated || r.stopped ? `${head} (the first ones only)` : head;
  }

  // Text for the composer that mentions files: "@a.py @b.py ", spaced from what's there.
  function mentionText(paths, before) {
    const words = paths.map((p) => `@${p}`).join(' ');
    return `${before && !/\s$/.test(before) ? ' ' : ''}${words} `;
  }

  // The code index's answer (ci_search) as the pane draws a result: a group a place, in
  // rank order (a file can come twice), its line the symbol's own, with why it's there.
  function meaningResult(ev) {
    if (!ev || ev.error) return { error: (ev && ev.error) || 'No answer.', files: [], total: 0, meaning: true };
    const files = (ev.results || []).map((r) => {
      const first = String(r.snippet || '').split('\n');
      const at = Math.max(0, (r.line || 0) - (r.snippet_line || r.line || 0));
      return {
        path: r.path,
        symbol: r.symbol ? `${r.kind ? `${r.kind} ` : ''}${r.symbol}` : '',
        why: r.why || '',
        matches: [{ line: r.line, text: first[Math.min(at, first.length - 1)] || '', spans: [] }],
      };
    });
    return { files, total: files.length, meaning: true, note: ev.note || '' };
  }

  // Each file once, in the order they came: for "Mention all".
  function uniquePaths(files) {
    return [...new Set((files || []).map((f) => f.path))];
  }

  const api = { pieces, summary, mentionText, meaningResult, uniquePaths };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F || !root.JarvisEditor) return;
  const { el } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  const state = { text: '', regex: false, case: false, word: false, meaning: false, include: '', result: null, ref: '', busy: false, where: '' };
  let refN = 0;
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
      state.ref = `s${++refN}`;
      state.busy = true;
      const where = root.JarvisEditor.where();
      state.where = JSON.stringify(where);
      if (state.meaning) F.send({ type: 'ci_search', ...where, text, include: state.include, ref: state.ref });
      else F.send({ type: 'cw_search', ...where, text, regex: state.regex, case: state.case, word: state.word, include: state.include, ref: state.ref });
      drawStatus();
    };
    if (now) go(); else timer = setTimeout(go, state.meaning ? MEANING_WAIT_MS : WAIT_MS);
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
    const exact = [toggle('Aa', 'Match case', 'case'), toggle('ab', 'Whole words', 'word'), toggle('.*', 'Regular expression', 'regex')];
    const meaning = toggle('By meaning', 'By meaning: describe what the code does, or name it', 'meaning');
    meaning.classList.add('cs-meaning');
    const placeholder = () => {
      input.placeholder = state.meaning ? 'Describe the code, or name it' : 'Search the project';
      for (const b of exact) b.disabled = state.meaning;  // (they're for text matches only)
    };
    meaning.addEventListener('click', placeholder);
    placeholder();
    row.append(input, ...exact, meaning);
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
    all.addEventListener('click', () => { if (state.result) mention(uniquePaths(state.result.files).slice(0, MENTION_ALL_MAX)); });
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
      at.setAttribute('aria-label', `Mention ${f.path} in the message`);
      at.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); mention([f.path]); });
      if (f.symbol) head.append(name, mine(el('span', 'cs-symbol', f.symbol)), at);
      else head.append(name, count, at);
      group.append(head);
      if (f.why) group.append(mine(el('div', 'cs-why', f.why)));
      for (const m of f.matches) {
        const line = el('button', 'cs-match');
        line.type = 'button';
        line.title = `${f.path}:${m.line}`;
        const text = mine(el('span', 'cs-text'));
        for (const [piece, hit] of pieces(m.text, m.spans)) text.append(hit ? el('mark', '', piece) : document.createTextNode(piece));
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

  F.on('ci_search', (ev) => {
    if (ev.ref !== state.ref) return;
    state.busy = false;
    state.result = meaningResult(ev);
    draw();
  });
})(typeof window === 'object' ? window : globalThis);
