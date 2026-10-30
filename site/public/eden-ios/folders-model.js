// Chat folders with no browser in them (folders.js draws them; the tests load this file alone).
// A folder is a name kept on each chat in it (`c.folder`), so it travels with chat sync. "Tidy up
// with Eden" asks a model for folder names from the chats' titles, then to sort every chat into
// them; the parsers here accept what a model really sends and never trust it.

export const MAX_NAME = 40;
export const MAX_FOLDERS = 14;
export const NUDGE_MIN = 40; // unfiled chats before Eden offers to tidy up
export const NUDGE_DAYS = 21; // how long a "Not now" or a finished tidy-up keeps the offer away

/** A folder name: one line, trimmed, at most MAX_NAME; '' when nothing is left. */
export const cleanName = (raw) => String(raw ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^["'“‘#*\-\s]+|["'”’*\s]+$/g, '').slice(0, MAX_NAME).trim();

const key = (n) => cleanName(n).toLowerCase();

/** The folders in use: [{ name, count }] (a name's first spelling wins), plus empty ones the user made. */
export function folderList(convs, extra = []) {
  const m = new Map();
  for (const c of convs || []) {
    if (!c || c.temp || !c.folder) continue;
    const k = key(c.folder);
    if (!k) continue;
    const e = m.get(k) || { name: cleanName(c.folder), count: 0 };
    e.count++;
    m.set(k, e);
  }
  for (const n of extra) { const k = key(n); if (k && !m.has(k)) m.set(k, { name: cleanName(n), count: 0 }); }
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Chats that belong in the day list: saved chats (not code sessions, not pinned) with no folder. */
export const unfiled = (convs) => (convs || []).filter((c) => c && !c.temp && c.kind !== 'code' && !c.pinned && !cleanName(c.folder));

/** Whether Eden should offer a tidy-up now. `last` is when it was last offered or done (ms, 0 never). */
export const shouldNudge = (convs, last, now = Date.now()) => unfiled(convs).length >= NUDGE_MIN && now - (last || 0) > NUDGE_DAYS * 864e5;

const line = (c, i) => `${i}. ${String(c.title || 'Untitled').replace(/\s+/g, ' ').slice(0, 70)}`;

/** Step 1: a sample of chat titles → the folder names to use. */
export function proposeRequest(chats, sample = 260) {
  const step = Math.max(1, Math.floor(chats.length / sample));
  const titles = chats.filter((_, i) => i % step === 0).slice(0, sample).map((c, i) => line(c, i + 1)).join('\n');
  return {
    system: 'You sort a person\'s chat history into folders. Reply with JSON only.',
    prompt: `Here are chat titles from one person's history:\n\n${titles}\n\nPropose between 5 and ${MAX_FOLDERS} folders that cover most of them: broad subjects (like School, Work, Health, Travel, Coding, Writing), each name 1-3 words, no overlap, and a last folder "Other" only if needed. Reply with JSON only: {"folders":["Name","Name"]}`,
  };
}
export function parseFolders(text) {
  const j = jsonIn(text);
  const list = Array.isArray(j) ? j : j && Array.isArray(j.folders) ? j.folders : [];
  const seen = new Set(), out = [];
  for (const f of list) { const n = cleanName(typeof f === 'string' ? f : f && f.name); if (n && !seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); out.push(n); } }
  return out.slice(0, MAX_FOLDERS);
}

/** Step 2: a batch of chats → which folder each belongs in. */
export function assignRequest(batch, folders) {
  return {
    system: 'You sort a person\'s chats into their folders. Reply with JSON only.',
    prompt: `Folders: ${folders.map((f) => `"${f}"`).join(', ')}\n\nChats:\n${batch.map((c, i) => line(c, i + 1)).join('\n')}\n\nFor each numbered chat give the best folder from the list, or null when none fits well. Reply with JSON only: {"1":"Folder","2":null,...}`,
  };
}
/** → an array of length n: a folder from `folders` (matched ignoring case) or null. */
export function parseAssign(text, n, folders) {
  const j = jsonIn(text) || {};
  const byKey = new Map(folders.map((f) => [key(f), f]));
  const out = new Array(n).fill(null);
  const rows = Array.isArray(j) ? j.map((v, i) => [i + 1, v]) : Object.entries(j);
  for (const [k, v] of rows) {
    const i = Number(k) - 1;
    if (Number.isInteger(i) && i >= 0 && i < n && typeof v === 'string') out[i] = byKey.get(key(v)) || null;
  }
  return out;
}

function jsonIn(text) {
  const s = String(text || '');
  for (const re of [/```(?:json)?\s*([\s\S]*?)```/i, /(\{[\s\S]*\})/, /(\[[\s\S]*\])/]) {
    const m = re.exec(s);
    if (!m) continue;
    try { return JSON.parse(m[1]); } catch { /* try the next shape */ }
  }
  try { return JSON.parse(s); } catch { return null; }
}

/** Put a chat in a folder ('' or null takes it out); stamps metaAt so the other devices take the newer choice. */
export function setFolder(c, name, now = Date.now()) {
  const n = cleanName(name);
  if (n) c.folder = n; else delete c.folder;
  c.metaAt = now;
  return c;
}
