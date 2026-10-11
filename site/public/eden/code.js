// Eden Code in the page: the project picker (GET/POST /api/chat/projects), the inspector's
// Changes tab (GET /api/chat/code/changes: files + diff hunks, each one markable as
// reviewed or sent back with "ask to revert") and Plan tab (TodoWrite), the activity drawer.

import { $, el, ico, toast, noKeys } from './util.js';
import { state, saveConversation } from './state.js';
import { api } from './api.js';
import { todoList, hunkStates } from './render.js';
import { activity } from './chat.js';

let H = {};

export async function loadProjects() {
  try { state.projects = await api.projects(); } catch (e) { state.projects = []; state.projectsError = e.message; }
  return state.projects;
}

export function projectPicker() {
  const body = $('dlgBody');
  const list = el('div', { role: 'list' });
  const err = el('div', { class: 'muted', 'aria-live': 'polite' });
  const path = el('input', { type: 'text', placeholder: '/Users/you/code/project', 'aria-label': 'Project folder path', spellcheck: 'false' });
  const name = el('input', { type: 'text', placeholder: 'my-app', 'aria-label': 'New project name', spellcheck: 'false', maxlength: '80' });
  const start = (p) => { H.closeDialog(); H.newCodeSession(p); };
  const draw = () => {
    if (!state.projects.length) list.replaceChildren(el('div', 'muted', state.projectsError ? `Couldn’t load projects: ${state.projectsError}` : 'No projects yet: make one or choose a folder above.'));
    else list.replaceChildren(...state.projects.map((p) => el('button', { type: 'button', class: 'proj-row', role: 'listitem', onclick: () => start(p) },
      ico('folder'), el('div', { class: 'grow', 'data-no-i18n': '' }, el('b', '', p.name), el('span', '', `${p.path}${p.branch ? ` · ${p.branch}` : ''}`)))));
  };
  // Made or chosen: straight into a session on it.
  const opened = (res) => {
    state.projects = res.projects || state.projects;
    const p = res.added && state.projects.find((x) => x.path === res.added);
    if (p) start(p); else { err.textContent = ''; draw(); }
  };
  const create = async () => {
    const v = name.value.trim();
    if (!v) { name.focus(); return; }
    err.textContent = 'Making the folder…';
    try { opened(await api.createProject(v)); toast(`Made ~/Eden Projects/${v}`); }
    catch (e) { err.textContent = e.message; }
  };
  const pick = async () => {
    err.textContent = 'Choose a folder in the window that opened…';
    try { opened(await api.pickProject()); }
    catch (e) { err.textContent = e.message; }
  };
  const add = async () => {
    const v = path.value.trim();
    if (!v) { path.focus(); return; }
    err.textContent = 'Adding…';
    try { state.projects = await api.addProject(v); err.textContent = ''; path.value = ''; draw(); toast('Project added'); }
    catch (e) { err.textContent = e.message; }
  };
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
  path.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  const code = state.meta && state.meta.code;
  const more = el('details', 'proj-path', el('summary', '', 'Or paste a folder’s path'),
    el('div', 'key-edit', path, el('button', { type: 'button', class: 'btn', onclick: add }, 'Add')));
  // (no null in the list: the page would print it, as the word "null")
  body.replaceChildren(...[
    code && code.available === false ? el('div', { class: 'sp-warn', style: { marginBottom: '10px' } }, el('b', '', 'Code mode is unavailable'), code.reason || 'Claude Code wasn’t found.') : null,
    el('div', 'proj-new',
      el('div', 'field', 'New project', el('div', 'key-edit', name, el('button', { type: 'button', class: 'btn primary', onclick: create }, 'Create'))),
      el('button', { type: 'button', class: 'btn proj-pick', onclick: pick }, ico('folder'), 'Choose a folder…')),
    el('p', 'sp-note', 'New projects go in ~/Eden Projects. Or open one you have:'),
    el('div', { style: { margin: '4px 0 10px' } }, list),
    more,
    err,
  ].filter(Boolean));
  H.openDialog('New code session', body);
  draw();
  loadProjects().then(draw);
  setTimeout(() => name.focus(), 50);
}

/* ---------- Plan tab ---------- */
export function renderPlan() {
  const c = state.current;
  const card = $('planCard');
  if (!c || c.kind !== 'code') { card.replaceChildren(el('div', 'muted', 'In a Code session, the agent’s to-do list (TodoWrite) shows here and checks off live.')); return; }
  if (!c.todos || !c.todos.length) { card.replaceChildren(el('div', 'muted', noKeys('No plan yet. Ask for something bigger, or use Plan mode (⇧Tab), and the to-dos show here.'))); return; }
  const done = c.todos.filter((t) => t.status === 'completed').length;
  card.replaceChildren(el('div', { class: 'muted', style: { marginBottom: '4px' } }, `${done} of ${c.todos.length} done`), todoList(c.todos));
}

/* ---------- Changes tab ---------- */
/** A path as git prints it in a diff: plain (a name with spaces ends in a tab on ---/+++ lines) or C-quoted ("caf\303\251.txt": octal escapes are UTF-8 bytes). */
export function gitPath(raw) {
  const s = String(raw).replace(/\t$/, '');
  if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s;
  const bytes = [];
  const named = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (const m of s.slice(1, -1).matchAll(/\\([0-7]{1,3})|\\([\s\S])|([^\\]+)/g)) {
    if (m[1]) bytes.push(parseInt(m[1], 8) & 0xff);
    else if (m[2]) bytes.push(named[m[2]] ?? m[2].charCodeAt(0));
    else bytes.push(...new TextEncoder().encode(m[3]));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
const unprefix = (p, pre) => (p.startsWith(pre) ? p.slice(pre.length) : p);

/** The new path on a `diff --git` line: quoted, the same name twice ("a/x y b/x y"), or a best guess (the ---/+++ lines then say for sure). */
function headerPath(rest) {
  if (rest.startsWith('"')) {
    const end = /^"(?:[^"\\]|\\.)*"/.exec(rest);
    const second = end ? rest.slice(end[0].length).trim() : '';
    return unprefix(gitPath(second || rest), 'b/');
  }
  const n = (rest.length - 5) / 2;
  if (Number.isInteger(n) && n > 0 && rest.startsWith('a/') && rest.slice(2, 2 + n) === rest.slice(5 + n) && rest.slice(2 + n, 5 + n) === ' b/') return rest.slice(2, 2 + n);
  const m = /^a\/(.+?) b\/(.+)$/.exec(rest);
  return m ? gitPath(m[2]) : rest;
}

export function parseDiff(diff) {
  const files = [];
  let f = null, h = null;
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('diff --git ')) { f = { path: headerPath(line.slice(11)), hunks: [] }; files.push(f); h = null; continue; }
    if (!f) continue;
    // before the first hunk, ---/+++ name the file exactly (+++ wins; --- for a deleted file)
    if (!h && (line.startsWith('--- ') || line.startsWith('+++ '))) {
      const p = gitPath(line.slice(4));
      if (p !== '/dev/null') f.path = unprefix(p, line[0] === '+' ? 'b/' : 'a/');
      continue;
    }
    if (line.startsWith('@@')) { h = { header: line, lines: [] }; f.hunks.push(h); continue; }
    if (h && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '\\ No newline at end of file')) h.lines.push(line);
  }
  return files;
}

let changes = null, loadingChanges = false, openFiles = new Set();
export async function loadChanges(quiet) {
  const c = state.current;
  const card = $('chgCard');
  if (!c || c.kind !== 'code' || !c.project) { changes = null; card.replaceChildren(el('div', 'muted', 'Open a Code session to see its project’s uncommitted changes.')); return; }
  if (loadingChanges) return;
  loadingChanges = true;
  if (!quiet || !changes) card.replaceChildren(el('div', 'muted', 'Reading git status…'));
  try {
    const r = await api.changes(c.project.path);
    if (state.current !== c) return;
    changes = { ...r, parsed: parseDiff(r.diff), conv: c };
    if (r.branch && c.project.branch !== r.branch) { c.project.branch = r.branch; saveConversation(c); H.renderTitle(); H.renderSidebar(); }
    drawChanges();
  } catch (e) {
    card.replaceChildren(el('div', 'muted', `Couldn’t read changes: ${e.message}`));
  } finally { loadingChanges = false; }
}

const hunkKey = (file, h) => `${file}|${h.header}`;
function drawChanges() {
  const card = $('chgCard');
  const c = changes && changes.conv;
  if (!c) return;
  c.hunks = c.hunks || {};
  const files = changes.files || [];
  if (!files.length) { card.replaceChildren(el('div', 'muted', `No uncommitted changes${changes.branch ? ` on ${changes.branch}` : ''}.`)); return; }
  const parsed = changes.parsed;
  const allHunks = parsed.flatMap((f) => f.hunks.map((h) => hunkKey(f.path, h)));
  const pending = allHunks.filter((k) => !c.hunks[k] || c.hunks[k] === 'pending').length;
  const add = files.reduce((n, f) => n + (f.added || 0), 0), del = files.reduce((n, f) => n + (f.removed || 0), 0);
  const kids = [el('div', 'chg-head', el('span', '', `${changes.branch ? `${changes.branch} · ` : ''}${files.length} file${files.length === 1 ? '' : 's'} · +${add} −${del}`),
    allHunks.length ? el('button', { type: 'button', class: 'cap ok', 'data-chg': 'all', disabled: !pending }, pending ? `Mark all reviewed (${pending})` : 'All reviewed') : null)];
  for (const f of files) {
    const pf = parsed.find((x) => x.path === f.path);
    const open = openFiles.has(f.path);
    kids.push(el('button', { type: 'button', class: 'chg-row', 'data-chg': 'file', 'data-path': f.path, 'aria-expanded': String(open) },
      el('span', 'chg-st', f.status || 'M'), el('div', { class: 'grow', 'data-no-i18n': '' }, el('b', '', f.path.split('/').pop()), el('span', '', f.path)),
      el('span', 'chg-n', el('span', 'a', `+${f.added || 0}`), ' ', el('span', 'd', `−${f.removed || 0}`))));
    if (open && pf) {
      if (!pf.hunks.length) kids.push(el('div', 'muted', 'No text diff (new, binary or untracked file).'));
      for (const h of pf.hunks) {
        const key = hunkKey(f.path, h);
        const st = c.hunks[key] || 'pending';
        const pre = el('pre');
        for (const l of h.lines.slice(0, 300)) pre.append(el('span', l[0] === '+' ? 'al' : l[0] === '-' ? 'dl' : 'cl', l), '\n');
        kids.push(el('div', { class: 'chg-hunk', 'data-state': st, 'data-key': key },
          el('div', 'hb', el('span', 'h', h.header), hunkStates(),
            el('span', 'hunk-actions',
              el('button', { type: 'button', class: 'cap ok', 'data-chg': 'hunk', 'data-state': 'reviewed' }, 'Reviewed'),
              el('button', { type: 'button', class: 'cap rev', 'data-chg': 'hunk', 'data-state': 'revert' }, 'Ask to revert'))),
          el('div', 'diff', pre)));
      }
    }
  }
  card.replaceChildren(...kids);
}

function hunkText(key) {
  const [file, header] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
  const f = changes.parsed.find((x) => x.path === file);
  const h = f && f.hunks.find((x) => x.header === header);
  return { file, text: h ? [h.header, ...h.lines].join('\n') : '' };
}

export function setHunk(c, key, st, { quiet } = {}) {
  c.hunks = c.hunks || {};
  c.hunks[key] = st;
  saveConversation(c);
  if (!quiet) toast(st === 'reviewed' ? 'Marked reviewed' : st === 'revert' ? 'Revert request is in the composer' : 'Back to pending');
}

export function initCode(handlers) {
  H = handlers;
  $('btnChgRefresh').addEventListener('click', () => loadChanges());
  $('chgCard').addEventListener('click', (e) => {
    const b = e.target.closest('[data-chg], [data-act="hunk"]');
    if (!b || !changes) return;
    const c = changes.conv;
    const kind = b.dataset.chg || 'hunk';
    if (kind === 'file') { const p = b.dataset.path; if (openFiles.has(p)) openFiles.delete(p); else openFiles.add(p); drawChanges(); return; }
    if (kind === 'all') {
      for (const f of changes.parsed) for (const h of f.hunks) { const k = hunkKey(f.path, h); if (!c.hunks[k] || c.hunks[k] === 'pending') c.hunks[k] = 'reviewed'; }
      saveConversation(c); drawChanges(); toast('All hunks marked reviewed'); return;
    }
    const wrap = b.closest('.chg-hunk');
    if (!wrap) return;
    const key = wrap.dataset.key;
    const st = b.dataset.state;
    setHunk(c, key, st);
    if (st === 'revert') { const { file, text } = hunkText(key); H.quote(`Revert this change in ${file}:\n\`\`\`diff\n${text}\n\`\`\`\n`); }
    drawChanges();
  });
}

/* ---------- the activity drawer (⌘J) ---------- */
export function renderActivity() {
  const c = state.current;
  const box = $('drBody');
  const lines = (c && activity.get(c.id)) || [];
  if (!lines.length) { box.replaceChildren(el('span', 'p', c && c.kind === 'code' ? 'No tool activity yet in this session.' : 'Tool activity shows here during Code sessions.')); return; }
  box.replaceChildren(...lines.flatMap((l) => [el('span', { class: l.k, 'data-no-i18n': '' }, l.t), '\n'])); // tool calls and their output: never translated
  box.scrollTop = box.scrollHeight;
}
export function toggleDrawer(force) {
  const d = $('drawer');
  const open = force !== undefined ? force : !d.classList.contains('open');
  d.classList.toggle('open', open);
  if (open) renderActivity();
  return open;
}
