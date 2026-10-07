// Project knowledge (ROADMAP H11): folders indexed on the owner's Mac by Jarvis (its second
// brain's own index and search by meaning; nothing is uploaded), attached to Eden's projects.
// Chats started from a project and its Code sessions search the attached folders before each
// turn and cite the files ([K1], [K2]…, drawn as cards that open the file). Chats send the
// folder ids to the server (`mac.knowledge`, src/chat/mac.ts); Code turns search here and send
// the passages as untrusted context (src/chat/guard.ts wraps them).
// Which folders belong to which project is kept in this browser (localStorage).

import { el, ico, toast, store } from './util.js';
import { state, ui, newConversation, addConversation } from './state.js';
import { api } from './api.js';
import { openPane, paneOpen, closePane, macEvent } from './files.js';

const KEY = 'eden:knowledge'; // { "<project path>": ["<folder id>", …] }
let H = {};
let pollT = null;
let shownAt = 0; // which drawing of the pane a refresh belongs to

const attached = () => {
  const v = store.get(KEY, {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
};
function setAttached(projectPath, ids) {
  const all = attached();
  if (ids.length) all[projectPath] = [...new Set(ids)].slice(0, 20); else delete all[projectPath];
  store.set(KEY, all);
}

/** The folder ids attached to this conversation's project ([] for a chat without one). */
export function projectKnowledge(c) {
  const p = c && c.project && c.project.path;
  if (!p) return [];
  const ids = attached()[p];
  return Array.isArray(ids) ? ids.filter((x) => typeof x === 'string' && /^[\w-]{1,64}$/.test(x)).slice(0, 20) : [];
}

/** The Projects section's "Knowledge" row. */
export function knowledgeItem() {
  const n = Object.values(attached()).reduce((k, ids) => k + (Array.isArray(ids) ? ids.length : 0), 0);
  return el('button', { type: 'button', class: 'sitem', title: 'Project knowledge: folders indexed on your Mac', onclick: () => openKnowledge() },
    ico('bulb'), el('span', 'lbl', 'Knowledge', el('span', 'sub', n ? `${n} folder${n === 1 ? '' : 's'} attached` : 'index a folder on your Mac')));
}

async function call(tool, args) {
  const r = await api.jarvis(tool, args);
  if (r.is_error) throw new Error(String(r.text || 'Jarvis said no.'));
  try { return JSON.parse(r.text); } catch { throw new Error('Jarvis sent something Eden can’t read. Is it up to date?'); }
}

const statusText = (f) => (f.status === 'ready' ? `${f.files || 0} file${f.files === 1 ? '' : 's'} indexed${f.semantic ? ' · by meaning too' : ''}` : f.status === 'error' ? (f.error || 'Indexing failed') : `Indexing… ${f.progress || ''}`.trim());

/** The pane: the indexed folders, adding one, and which project each belongs to. */
export async function openKnowledge() {
  if (H.clearPhoneOverlays) H.clearPhoneOverlays();
  const body = openPane('Project knowledge', 'bulb');
  const mine = ++shownAt;
  clearTimeout(pollT);
  body.append(el('p', 'sp-note mac-intro', 'Jarvis indexes a folder on your Mac (nothing is uploaded). Attach it to a project: that project’s chats and Code sessions search it and cite the files.'));
  if (!state.jarvis.available) {
    body.append(el('div', 'sp-warn', el('b', '', 'Your Mac isn’t connected'), state.jarvis.reason || 'The Jarvis app didn’t answer.'));
    return;
  }
  const path = el('input', { class: 'sp-search', type: 'text', placeholder: '~/Documents/Thesis', 'aria-label': 'Folder on your Mac to index', autocomplete: 'off', spellcheck: 'false' });
  const add = el('button', { type: 'button', class: 'btn primary' }, 'Index folder');
  const run = async () => {
    const v = path.value.trim();
    if (!v) { path.focus(); return; }
    add.disabled = true;
    try {
      const r = await call('knowledge_add_folder', { path: v });
      toast(`Indexing ${r.folder.display} on your Mac`);
      path.value = '';
      openKnowledge();
    } catch (e) { toast(e.message); } finally { add.disabled = false; }
  };
  add.addEventListener('click', run);
  path.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  const list = el('div', { class: 'mac-kn', 'aria-live': 'polite' }, el('div', 'muted', 'Asking your Mac…'));
  body.append(el('div', 'sp-row', path, add), list);
  requestAnimationFrame(() => path.focus());
  let found;
  try { found = await call('knowledge_list', {}); } catch (e) { list.replaceChildren(el('div', 'sp-warn', el('b', '', 'That didn’t work'), e.message)); return; }
  if (mine !== shownAt || !paneOpen()) return;
  const folders = found.folders || [];
  const rows = folders.map((f) => el('div', 'mac-kfolder',
    ico('folder', 15),
    el('span', 'mac-fbody', el('span', 'mac-fname', f.name), el('span', 'mac-fmeta mono', f.display), el('span', `mac-kstat ${f.status}`, statusText(f))),
    f.status === 'indexing' ? null : el('button', { type: 'button', class: 'cap', title: 'Index it again', onclick: async () => { try { await call('knowledge_add_folder', { path: f.path }); openKnowledge(); } catch (e) { toast(e.message); } } }, ico('retry', 12), 'Update')));
  list.replaceChildren(...(rows.length ? rows : [el('div', 'muted', 'No folders yet: type one above (inside the folders Eden may read on your Mac).')]));
  // Projects: which folders each one searches.
  const projects = [...state.projects];
  for (const p of Object.keys(attached())) if (!projects.some((x) => x.path === p)) projects.push({ path: p, name: p.split('/').pop() || p });
  if (folders.length) {
    body.append(el('h3', 'mac-h', 'Projects'));
    if (!projects.length) body.append(el('div', 'muted', 'Add a project (Projects +) to attach knowledge to it.'));
    for (const p of projects) {
      const ids = new Set(attached()[p.path] || []);
      const boxes = folders.map((f) => {
        const box = el('input', { type: 'checkbox', checked: ids.has(f.id) || null });
        box.addEventListener('change', () => {
          const now = new Set(attached()[p.path] || []);
          if (box.checked) now.add(f.id); else now.delete(f.id);
          setAttached(p.path, [...now]);
          if (H.renderSidebar) H.renderSidebar();
          if (H.renderComposer) H.renderComposer();
        });
        return el('label', 'mac-attach', box, el('span', '', f.name));
      });
      body.append(el('div', 'mac-proj',
        el('div', 'mac-proj-head', ico('folder', 14), el('b', '', p.name),
          el('button', { type: 'button', class: 'cap', title: `A chat that searches ${p.name}’s knowledge`, onclick: () => newProjectChat(p) }, ico('chat', 12), 'New chat')),
        el('div', 'mac-attaches', ...boxes)));
    }
  }
  if (folders.some((f) => f.status === 'indexing')) pollT = setTimeout(() => { if (mine === shownAt && paneOpen()) openKnowledge(); }, 2500);
}

function newProjectChat(project) {
  if (!projectKnowledge({ project }).length) { toast(`Attach a folder to ${project.name} first`); return; }
  const c = newConversation({ project: { path: project.path, name: project.name, branch: project.branch || '' } });
  c.title = `${project.name} · knowledge`;
  addConversation(c);
  closePane();
  H.switchTo(c);
  toast(`This chat searches ${project.name}’s knowledge before each reply`);
}

/**
 * Before a Code turn in a project with knowledge: the best passages, as a card on the reply and
 * as untrusted context for Claude Code (null when there's none, or Jarvis failed: the card says so).
 */
export async function codeKnowledge(c, node, prompt) {
  const ids = projectKnowledge(c);
  const query = String(prompt || '').trim();
  if (!ids.length || !query) return null;
  const id = 'k1';
  macEvent(c, node, { id, tool: 'knowledge_search', label: 'Searching your project knowledge', state: 'running' });
  ui.updateMessage(c, node);
  try {
    const found = await call('knowledge_search', { query: query.slice(0, 400), folders: ids, k: 6 });
    const results = found.results || [];
    macEvent(c, node, { id, state: 'done', label: 'Searched your project knowledge', results, sentTo: { place: 'cloud', name: 'Claude Code', label: 'Anthropic cloud' } });
    ui.updateMessage(c, node);
    if (!results.length) return null;
    return {
      title: 'File: project knowledge from the owner’s Mac (cite the passages you use as [K1], [K2]… and name the files)',
      text: results.map((r) => `[K${r.n}] ${r.display || r.path}${r.title && r.title !== r.name ? ` — ${r.title}` : ''}\n${r.passage || r.excerpt || ''}`).join('\n\n'),
      source: 'file',
    };
  } catch (e) {
    macEvent(c, node, { id, state: 'failed', error: e.message });
    ui.updateMessage(c, node);
    return null;
  }
}

export function initKnowledge(handlers) {
  H = handlers;
}
