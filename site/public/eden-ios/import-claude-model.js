// Import from Claude, the pure part (no DOM, no network). Claude.ai's export (Settings › Privacy ›
// Export data) is a .zip with conversations.json (an array of chats, each with `chat_messages`),
// projects.json (each project's name, instructions and documents), users.json and, on newer
// exports, memories.json. This turns one Claude chat into an Eden conversation (the same model
// import-chatgpt-model.js makes: a tree of user/assistant nodes), picks out memories, and names
// the folder a chat goes in from its project. The zip reader and the JSON streaming are shared
// with the ChatGPT import (import-chatgpt-model.js).

import { parseMemoryLines } from './import-chatgpt-model.js';

export const SOURCE = 'claude';
/** The id an imported conversation gets in Eden: derived from Claude's uuid, so re-importing finds the same chat. */
export const edenIdFor = (uuid) => `claude-${String(uuid).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)}`;

const MAX_ATTACHMENT = 100_000; // characters of a pasted or uploaded file's text kept with the message
const ROOT_PARENT = /^0{8}-0{4}-4000-8000-0{12}$/; // the placeholder parent of a chat's first message

/** What's in a Claude export zip that matters. */
export function indexClaudeExport(entries) {
  const pick = (re) => entries.find((e) => re.test(e.name)) || null;
  return {
    conversations: entries.filter((e) => /(^|\/)conversations\.json$/i.test(e.name)),
    projects: pick(/(^|\/)projects\.json$/i),
    memories: pick(/(^|\/)memories\.json$/i),
    users: pick(/(^|\/)users\.json$/i),
  };
}

/** A zip that looks like Claude's export (users.json / projects.json beside conversations.json, no ChatGPT user.json). */
export const looksLikeClaudeZip = (entries) => entries.some((e) => /(^|\/)conversations\.json$/i.test(e.name))
  && entries.some((e) => /(^|\/)(users|projects|memories)\.json$/i.test(e.name))
  && !entries.some((e) => /(^|\/)(user|message_feedback|shared_conversations)\.json$/i.test(e.name) || /(^|\/)chat\.html$/i.test(e.name));

/** One item of conversations.json is a Claude chat. */
export const isClaudeChat = (x) => Boolean(x && typeof x === 'object' && Array.isArray(x.chat_messages) && (x.uuid || x.id));

const time = (s) => { const t = typeof s === 'number' ? s : Date.parse(s || ''); return Number.isFinite(t) && t > 0 ? t : 0; };

const fence = (text, lang = '') => {
  let f = '```';
  while (text.includes(f)) f += '`';
  return `${f}${lang}\n${String(text).replace(/\n$/, '')}\n${f}`;
};

/** An artifact Claude made (a tool_use of `artifacts`) as Markdown: its title and its code, fenced. */
function artifactBlock(input) {
  if (!input || typeof input !== 'object') return '';
  const body = typeof input.content === 'string' ? input.content : '';
  if (!body.trim()) return '';
  const type = String(input.type || '');
  const lang = input.language || (/html/.test(type) ? 'html' : /svg/.test(type) ? 'svg' : /react|jsx/.test(type) ? 'jsx' : /mermaid/.test(type) ? 'mermaid' : /markdown/.test(type) ? 'markdown' : /code/.test(type) ? '' : '');
  const title = input.title ? `**${String(input.title).replace(/\s+/g, ' ').slice(0, 120)}**\n\n` : '';
  return title + fence(body, String(lang).replace(/[^\w+-]/g, ''));
}

/**
 * One Claude message's visible content: { role: 'user' | 'assistant' | null, text, attachments: [{ kind: 'text', name, text }], files: [names] }.
 * Thinking, tool calls (except artifacts, kept as code) and tool results are left out.
 */
export function claudeMessageContent(m) {
  const none = { role: null, text: '', attachments: [], files: [] };
  if (!m || typeof m !== 'object') return none;
  const role = m.sender === 'human' ? 'user' : m.sender === 'assistant' ? 'assistant' : null;
  if (!role) return none;
  const strs = [];
  if (Array.isArray(m.content) && m.content.length) {
    for (const b of m.content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) strs.push(b.text);
      else if (b.type === 'tool_use' && /^artifacts?$/.test(String(b.name || ''))) { const a = artifactBlock(b.input); if (a) strs.push(a); }
      // thinking, redacted_thinking, tool_result, other tool_use, token_budget, …: not part of the visible reply
    }
  }
  if (!strs.length && typeof m.text === 'string' && m.text.trim()) strs.push(m.text);
  const attachments = [];
  for (const a of Array.isArray(m.attachments) ? m.attachments : []) {
    const text = typeof a.extracted_content === 'string' ? a.extracted_content : '';
    if (!text.trim()) continue;
    attachments.push({ kind: 'text', name: String(a.file_name || 'pasted.txt').slice(0, 120), text: text.slice(0, MAX_ATTACHMENT) });
  }
  const files = (Array.isArray(m.files) ? m.files : []).map((f) => String((f && (f.file_name || f.file_uuid)) || 'file').slice(0, 120));
  return { role, text: strs.join('\n\n').replace(/\n{4,}/g, '\n\n\n').trim(), attachments, files };
}

/**
 * A Claude chat → { conv, images: [], stats: { messages } } or null (nothing visible). Messages with
 * parent links (`parent_message_uuid`) keep their branches as versions, the newest selected; older
 * exports are a plain list. `projects`: Map uuid → { name } for the chat's folder.
 */
export function convertClaudeConversation(raw, { importedAt = Date.now(), projects = null, model = '' } = {}) {
  if (!isClaudeChat(raw)) return null;
  const origId = String(raw.uuid || raw.id);
  const msgs = raw.chat_messages.filter((m) => m && typeof m === 'object')
    .map((m, i) => ({ m, i, at: time(m.created_at), id: String(m.uuid || `#${i}`) }))
    .sort((a, b) => (a.at - b.at) || (a.i - b.i));
  const known = new Set(msgs.map((x) => x.id));
  const branched = msgs.some((x) => x.m.parent_message_uuid && known.has(String(x.m.parent_message_uuid)));
  const convModel = String(raw.model || model || '').slice(0, 40);

  const nodes = {};
  const root = { children: [], sel: 0 };
  const byOrig = new Map(); // Claude message id → Eden node id (a merged message maps to the node it joined)
  let seq = 0, messages = 0, firstUser = '', lastNode = null;
  const times = [];
  for (const x of msgs) {
    const { role, text, attachments, files } = claudeMessageContent(x.m);
    if (!role) continue;
    const note = files.length ? `[${files.length === 1 ? 'File' : 'Files'} from Claude, not in the export: ${files.join(', ')}]` : '';
    if (!text && !attachments.length && !note) continue;
    let parentId;
    if (branched) {
      const p = x.m.parent_message_uuid ? String(x.m.parent_message_uuid) : '';
      parentId = p && !ROOT_PARENT.test(p) ? byOrig.get(p) ?? null : null;
    } else parentId = lastNode;
    const parent = parentId ? nodes[parentId] : null;
    // Two messages in a row from the same side (older exports, retries): one message.
    if (!branched && parent && parent.role === role) {
      if (role === 'user') {
        parent.content = [parent.content, text, note].filter(Boolean).join('\n\n');
        if (attachments.length) parent.attachments = [...(parent.attachments || []), ...attachments];
      } else parent.parts[0].text = [parent.parts[0].text, text, note].filter(Boolean).join('\n\n');
      byOrig.set(x.id, parent.id);
      continue;
    }
    const created = x.at || time(raw.created_at) || importedAt;
    const node = role === 'user'
      ? { id: `i${++seq}`, parent: parentId, children: [], sel: 0, created, role: 'user', content: [text, note].filter(Boolean).join('\n\n'), imported: true }
      : { id: `i${++seq}`, parent: parentId, children: [], sel: 0, created, role: 'assistant', parts: [{ type: 'text', text: [text, note].filter(Boolean).join('\n\n') }], mode: 'chat', finish: 'stop', imported: true };
    if (role === 'user' && attachments.length) node.attachments = attachments;
    if (role === 'assistant' && (x.m.model || convModel)) node.importedModel = String(x.m.model || convModel).slice(0, 40);
    nodes[node.id] = node;
    const holder = parent || root;
    holder.children.push(node.id);
    holder.sel = holder.children.length - 1; // the newest version (Claude shows the latest retry)
    byOrig.set(x.id, node.id);
    lastNode = node.id;
    messages++;
    if (role === 'user' && !firstUser && text) firstUser = text;
    if (x.at) times.push(x.at);
  }
  if (!messages) return null;

  const created = time(raw.created_at) || Math.min(...times, importedAt);
  const updated = time(raw.updated_at) || Math.max(...times, created);
  let title = String(raw.name || '').replace(/\s+/g, ' ').trim();
  if (!title) title = (firstUser || 'Claude chat').replace(/\s+/g, ' ').slice(0, 60);
  const projectId = raw.project_uuid || (raw.project && raw.project.uuid) || '';
  const project = projectId && projects ? projects.get(String(projectId)) : null;
  const conv = {
    id: edenIdFor(origId), title: title.slice(0, 200), titleSet: true, created, updated, pinned: false, temp: false, kind: 'chat', project: null, sessionId: null, personaId: null,
    mode: 'chat', nodes, root, lastRoute: null, allowTools: [], todos: [], queue: [], status: 'idle',
    source: SOURCE,
    import: { source: SOURCE, id: origId, updated, at: importedAt, nodes: Object.keys(nodes).length },
  };
  if (project && project.name) conv.folder = folderName(project.name);
  return { conv, images: [], stats: { messages } };
}

/** A Claude project's name as an Eden folder name (folders-model.js cleanName's rules, kept here so this file stays standalone). */
export const folderName = (raw) => String(raw ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40).trim();

/** projects.json → Map uuid → { name, instructions, docs } (docs: how many documents it had). */
export function readClaudeProjects(json) {
  const out = new Map();
  for (const p of Array.isArray(json) ? json : []) {
    if (!p || typeof p !== 'object' || !p.uuid) continue;
    out.set(String(p.uuid), {
      name: String(p.name || '').trim().slice(0, 120),
      instructions: typeof p.prompt_template === 'string' ? p.prompt_template.trim().slice(0, 8000) : '',
      docs: Array.isArray(p.docs) ? p.docs.length : 0,
      starter: Boolean(p.is_starter_project),
    });
  }
  return out;
}

/**
 * memories.json (Claude's memory summaries: `conversations_memory`, and `project_memories` by
 * project) → short memory lines for the owner to review. Headings and bold-only lines are left out.
 */
export function claudeMemoryLines(json) {
  const texts = [];
  const take = (v) => { if (typeof v === 'string') texts.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(take); };
  for (const item of Array.isArray(json) ? json : [json]) {
    if (!item || typeof item !== 'object') continue;
    take(item.conversations_memory);
    take(item.project_memories);
    if (typeof item.memory === 'string') texts.push(item.memory);
  }
  const lines = texts.join('\n').split(/\r?\n/)
    .filter((l) => !/^\s*#{1,6}\s/.test(l) && !/^\s*\*\*[^*]+\*\*:?\s*$/.test(l))
    .map((l) => l.replace(/\*\*/g, ''));
  // Paragraphs of several sentences become one line each sentence.
  const split = [];
  for (const l of lines) {
    if (l.length <= 200) { split.push(l); continue; }
    split.push(...l.split(/(?<=[.!?])\s+(?=[A-Z])/));
  }
  return parseMemoryLines(split.join('\n')).filter((x) => x.length <= 300);
}
