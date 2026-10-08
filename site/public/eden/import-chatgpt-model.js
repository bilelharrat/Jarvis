// Import from ChatGPT, the pure part (no DOM, no network): reading the export .zip with a minimal
// ZIP central-directory reader (stored and deflate, via DecompressionStream), streaming the
// conversations.json array one conversation at a time, and converting a ChatGPT conversation
// (a tree of messages) into Eden's conversation model (a tree of user/assistant nodes). The UI is
// import-chatgpt.js. Nothing here sends anything anywhere: the archive is read in this browser.

/* ---------- ZIP ---------- */

const u16 = (v, o) => v.getUint16(o, true);
const u32 = (v, o) => v.getUint32(o, true);
const u64 = (v, o) => Number(v.getBigUint64(o, true));

async function bytesOf(blob, start, end) { return new Uint8Array(await blob.slice(start, end).arrayBuffer()); }

/** The entries of a .zip (a Blob or File): [{ name, method, csize, size, offset }]. Reads only the central directory. */
export async function readZip(blob) {
  const total = blob.size;
  const tailLen = Math.min(total, 65557 + 22);
  const tail = await bytesOf(blob, total - tailLen, total);
  const tv = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (u32(tv, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This isn’t a .zip file (or it’s damaged).');
  let count = u16(tv, eocd + 10);
  let cdSize = u32(tv, eocd + 12);
  let cdOffset = u32(tv, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) { // ZIP64
    const loc = eocd - 20;
    if (loc >= 0 && u32(tv, loc) === 0x07064b50) {
      const rec = u64(tv, loc + 8);
      const r = new DataView((await bytesOf(blob, rec, rec + 56)).buffer);
      if (u32(r, 0) === 0x06064b50) { count = u64(r, 32); cdSize = u64(r, 40); cdOffset = u64(r, 48); }
    }
  }
  const cd = await bytesOf(blob, cdOffset, cdOffset + cdSize);
  const v = new DataView(cd.buffer);
  const dec = new TextDecoder('utf-8');
  const entries = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (u32(v, p) !== 0x02014b50) break;
    const flags = u16(v, p + 8);
    const method = u16(v, p + 10);
    let csize = u32(v, p + 20);
    let size = u32(v, p + 24);
    const nlen = u16(v, p + 28), xlen = u16(v, p + 30), clen = u16(v, p + 32);
    let offset = u32(v, p + 42);
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nlen));
    if (size === 0xffffffff || csize === 0xffffffff || offset === 0xffffffff) { // ZIP64 extra field
      let q = p + 46 + nlen;
      const end = q + xlen;
      while (q + 4 <= end) {
        const id = u16(v, q), len = u16(v, q + 2);
        if (id === 1) {
          let r = q + 4;
          if (size === 0xffffffff) { size = u64(v, r); r += 8; }
          if (csize === 0xffffffff) { csize = u64(v, r); r += 8; }
          if (offset === 0xffffffff) { offset = u64(v, r); }
        }
        q += 4 + len;
      }
    }
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    entries.push({ name, method, csize, size, offset, encrypted: !!(flags & 1) });
  }
  return entries;
}

async function dataStart(blob, e) {
  const h = new DataView((await bytesOf(blob, e.offset, e.offset + 30)).buffer);
  if (u32(h, 0) !== 0x04034b50) throw new Error(`The zip is damaged near ${e.name}.`);
  return e.offset + 30 + u16(h, 26) + u16(h, 28);
}

/** A ReadableStream of an entry's bytes, inflated as it goes (so a huge conversations.json is never held whole). */
export async function entryStream(blob, e) {
  if (e.encrypted) throw new Error('This zip is password-protected.');
  const start = await dataStart(blob, e);
  const raw = blob.slice(start, start + e.csize).stream();
  if (e.method === 0) return raw;
  if (e.method !== 8) throw new Error(`Unsupported zip compression (${e.method}).`);
  return raw.pipeThrough(new DecompressionStream('deflate-raw'));
}

/** An entry's bytes, whole (images, small files). `max` refuses anything bigger (by the declared size) without reading it. */
export async function entryBytes(blob, e, max = Infinity) {
  if (e.size > max) return null;
  const s = await entryStream(blob, e);
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/* ---------- streaming a JSON array ---------- */

/**
 * Yields the elements of a top-level JSON array (as parsed values) from a ReadableStream of bytes,
 * without holding the whole text. `onBytes(n)` reports progress in decoded input bytes.
 */
export async function* jsonArrayItems(stream, { onBytes } = {}) {
  const reader = stream.getReader();
  const dec = new TextDecoder('utf-8');
  let started = false, depth = 0, inStr = false, esc = false, buf = '', from = -1;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      const text = done ? dec.decode() : dec.decode(value, { stream: true });
      if (value && onBytes) onBytes(value.length);
      let i0 = buf.length;
      buf += text;
      for (let i = i0; i < buf.length; i++) {
        const ch = buf.charCodeAt(i);
        if (inStr) {
          if (esc) esc = false;
          else if (ch === 92) esc = true;
          else if (ch === 34) inStr = false;
          continue;
        }
        if (ch === 34) { inStr = true; continue; }
        if (!started) { if (ch === 91) { started = true; } continue; }
        if (ch === 123 || ch === 91) { if (depth === 0) from = i; depth++; }
        else if (ch === 125 || ch === 93) {
          depth--;
          if (depth === 0 && from >= 0) {
            yield JSON.parse(buf.slice(from, i + 1));
            buf = buf.slice(i + 1);
            i = -1; from = -1;
          } else if (depth < 0) return;
        } else if (depth === 0 && from < 0 && ch === 93) return;
      }
      if (from < 0) buf = ''; else if (from > 0) { buf = buf.slice(from); from = 0; }
      if (done) return;
    }
  } finally { try { reader.releaseLock(); } catch { /* done */ } }
}

/* ---------- the export's layout ---------- */

const IMG = /\.(png|jpe?g|webp|gif)$/i;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
export const mimeOf = (name) => MIME[(/\.([a-z0-9]+)$/i.exec(name) || [])[1]?.toLowerCase()] || 'image/png';
const FILE_ID = /file[-_][A-Za-z0-9]+/;
const baseName = (n) => n.slice(n.lastIndexOf('/') + 1);

/** What's in the zip that matters: the conversation files, user.json, and an index of images by ChatGPT file id. */
export function indexExport(entries) {
  const conversations = entries.filter((e) => /(^|\/)conversations(-\d+)?\.json$/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name));
  const user = entries.find((e) => /(^|\/)user\.json$/i.test(e.name)) || null;
  const images = new Map();
  for (const e of entries) {
    if (!IMG.test(e.name)) continue;
    const m = FILE_ID.exec(baseName(e.name));
    if (m && !images.has(m[0])) images.set(m[0], e);
  }
  return { conversations, user, images };
}

/* ---------- one conversation ---------- */

export const SOURCE = 'chatgpt';
/** The id an imported conversation gets in Eden: derived from ChatGPT's, so re-importing finds the same chat. */
export const edenIdFor = (origId) => `cgpt-${String(origId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)}`;

const PUA_OPEN = String.fromCharCode(0xe200), PUA_CLOSE = String.fromCharCode(0xe201);
const CITE = new RegExp(` ?${PUA_OPEN}[^${PUA_CLOSE}]*${PUA_CLOSE}`, 'g'); // ChatGPT's citation markers
const PUA = new RegExp(`[${String.fromCharCode(0xe000)}-${String.fromCharCode(0xf8ff)}]`, 'g');
const cleanCites = (s) => s
  .replace(CITE, '')
  .replace(PUA, '')
  .replace(/ ?\u3010[^\u3011]*\u3011/g, '') // 1-source markers in brackets
  .replace(/\n{4,}/g, '\n\n\n');

const fence = (text, lang = '') => {
  let f = '```';
  while (text.includes(f)) f += '`';
  return `${f}${lang}\n${text.replace(/\n$/, '')}\n${f}`;
};

function pointerId(p) { const str = String(p || ''); const m = FILE_ID.exec(str.slice(str.indexOf('://') + 3)); return m ? m[0] : ''; }

/**
 * One message's visible content: { text, images: [{ id, width, height }] }. text is '' for hidden messages and
 * tool scaffolding (calls to browsing, search and image tools, system prompts, reasoning).
 */
export function messageContent(m) {
  const none = { text: '', images: [] };
  if (!m || !m.content) return none;
  const meta = m.metadata || {};
  if (meta.is_visually_hidden_from_conversation) return none;
  const role = m.author && m.author.role;
  if (role !== 'user' && role !== 'assistant' && role !== 'tool') return none;
  const c = m.content;
  const t = c.content_type;
  const toTool = m.recipient && m.recipient !== 'all' && role === 'assistant';
  const images = [];
  const strs = [];
  switch (t) {
    case 'text':
    case 'multimodal_text': {
      if (toTool) return none;
      for (const p of c.parts || []) {
        if (typeof p === 'string') { if (p.trim()) strs.push(p); } else if (p && typeof p === 'object') {
          if (p.content_type === 'image_asset_pointer' || p.asset_pointer) images.push({ id: pointerId(p.asset_pointer), width: p.width || 0, height: p.height || 0 });
          else if (typeof p.text === 'string' && p.text.trim()) strs.push(p.text); // audio_transcription
        }
      }
      break;
    }
    case 'code': {
      const lang = c.language && c.language !== 'unknown' ? c.language : '';
      if (toTool && !/python|code|interpreter/i.test(m.recipient)) return none;
      if (c.text && c.text.trim()) strs.push(fence(c.text, lang || (toTool ? 'python' : '')));
      break;
    }
    case 'execution_output': {
      if (c.text && c.text.trim()) strs.push(`Output:\n\n${fence(c.text.slice(0, 6000))}`);
      break;
    }
    case 'tether_quote': {
      if (c.text && c.text.trim()) {
        const q = c.text.trim().slice(0, 1500).split('\n').map((l) => `> ${l}`).join('\n');
        const src = c.title || c.domain || c.url ? `\n> — ${c.url ? `[${c.title || c.domain || c.url}](${c.url})` : c.title || c.domain}` : '';
        strs.push(q + src);
      }
      break;
    }
    case 'tether_browsing_display': {
      const r = (c.summary || c.result || '').toString().trim();
      if (r && !/^(?:L\d+:|\s*$)/.test(r.slice(0, 3))) strs.push(r.slice(0, 1500).split('\n').map((l) => `> ${l}`).join('\n'));
      break;
    }
    default: return none; // system_error, thoughts, reasoning_recap, user_editable_context, model_editable_context, …
  }
  let text = cleanCites(strs.join('\n\n')).trim();
  if (role === 'tool' && t !== 'execution_output' && t !== 'tether_quote' && t !== 'tether_browsing_display') text = '';
  return { text, images };
}

/** Custom instructions ChatGPT put in a conversation (a hidden user_editable_context message), or null. */
export function customInstructions(raw) {
  for (const n of Object.values(raw.mapping || {})) {
    const c = n && n.message && n.message.content;
    if (c && c.content_type === 'user_editable_context') {
      const about = (c.user_profile || '').trim();
      const how = (c.user_instructions || '').trim();
      if (about || how) return { about, how };
    }
  }
  return null;
}

const ms = (s) => (typeof s === 'number' && isFinite(s) ? Math.round(s * 1000) : 0);

/**
 * A ChatGPT conversation → { conv, images: [{ nodeId, id, name, width, height }], stats: { messages } } or null (nothing visible).
 * Regenerated answers and edited prompts become sibling versions (the tree's children, `sel` picks the one ChatGPT showed).
 * Consecutive assistant/tool messages (code, its output, the answer) join into one reply.
 */
export function convertConversation(raw, { importedAt = Date.now() } = {}) {
  const map = raw && raw.mapping;
  if (!map || typeof map !== 'object') return null;
  const origId = raw.conversation_id || raw.id || '';
  if (!origId) return null;
  let rootId = Object.keys(map).find((k) => !map[k].parent);
  if (!rootId) return null;
  if (!map[rootId]) return null;

  const onPath = new Set();
  for (let id = raw.current_node; id && map[id] && !onPath.has(id); id = map[id].parent) onPath.add(id);

  const nodes = {};
  const root = { children: [], sel: 0 };
  const images = [];
  let seq = 0, messages = 0, firstUser = '';
  const link = (parent, node, preferred) => {
    const p = parent ? nodes[parent] : root;
    p.children.push(node.id);
    if (preferred) p.sel = p.children.length - 1;
    else if (!p.pref) p.sel = p.children.length - 1; // no path hint: the newest version
    if (preferred) p.pref = true;
  };

  // an explicit stack: chats can be thousands of messages deep
  const stack = [{ id: rootId, parent: null, asst: null }];
  const times = [];
  while (stack.length) {
    const { id, parent, asst } = stack.pop();
    const cn = map[id];
    if (!cn) continue;
    const m = cn.message;
    let nextParent = parent, nextAsst = asst;
    if (m) {
      const role = m.author && m.author.role;
      const { text, images: imgs } = messageContent(m);
      const t = ms(m.create_time);
      if (role === 'user' && (text || imgs.length)) {
        const node = { id: `i${++seq}`, parent, children: [], sel: 0, created: t || ms(raw.create_time) || importedAt, role: 'user', content: text, imported: true };
        nodes[node.id] = node;
        if (imgs.length) node.attachments = [];
        imgs.forEach((im, k) => {
          const name = `image-${k + 1}`;
          images.push({ nodeId: node.id, id: im.id, name, width: im.width, height: im.height });
        });
        link(parent, node, onPath.has(id));
        messages++;
        if (!firstUser && text) firstUser = text;
        nextParent = node.id; nextAsst = null;
        if (t) times.push(t);
      } else if ((role === 'assistant' || role === 'tool') && (text || imgs.length)) {
        const note = imgs.length ? imgs.map(() => '*[Image from ChatGPT: not included]*').join('\n\n') : '';
        const body = [text, note].filter(Boolean).join('\n\n');
        const single = asst && asst.single;
        if (asst && single && nodes[asst.id]) {
          const part = nodes[asst.id].parts[0];
          part.text += `\n\n${body}`;
          nextAsst = { id: asst.id, single: false };
          if (onPath.has(id)) { const p = parent ? nodes[parent] : root; if (p) { p.sel = p.children.indexOf(asst.id); p.pref = true; } }
        } else {
          const node = { id: `i${++seq}`, parent, children: [], sel: 0, created: t || importedAt, role: 'assistant', parts: [{ type: 'text', text: body }], mode: 'chat', finish: 'stop', imported: true };
          if (m.metadata && m.metadata.model_slug) node.importedModel = String(m.metadata.model_slug).slice(0, 40);
          nodes[node.id] = node;
          link(parent, node, onPath.has(id));
          nextParent = node.id;
          nextAsst = { id: node.id, single: false };
          messages++;
        }
        if (t) times.push(t);
      }
    }
    // a chain with no branch merges into the reply above it
    const kids = cn.children || [];
    if (nextAsst && nextAsst.id) nextAsst = { id: nextAsst.id, single: kids.length === 1 };
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ id: kids[i], parent: nextParent, asst: nextAsst });
  }
  if (!messages) return null;
  for (const n of Object.values(nodes)) delete n.pref;
  delete root.pref;

  const created = ms(raw.create_time) || Math.min(...times, importedAt);
  const updated = ms(raw.update_time) || Math.max(...times, created);
  let title = String(raw.title || '').trim();
  if (!title || /^new chat$/i.test(title)) title = (firstUser || 'ChatGPT chat').replace(/\s+/g, ' ').slice(0, 60);
  const conv = {
    id: edenIdFor(origId), title, titleSet: true, created, updated, pinned: false, temp: false, kind: 'chat', project: null, sessionId: null, personaId: null,
    mode: 'chat', nodes, root, lastRoute: null, allowTools: [], todos: [], queue: [], status: 'idle',
    source: SOURCE,
    import: { source: SOURCE, id: String(origId), updated: raw.update_time || 0, at: importedAt, nodes: Object.keys(nodes).length },
  };
  return { conv, images, stats: { messages }, instructions: customInstructions(raw) };
}

/**
 * What to do with a converted conversation given the chat already in Eden for the same ChatGPT id:
 * 'new', 'unchanged' (same or older than what was imported), 'edited' (the chat has Eden messages
 * since: left alone) or 'update' (ChatGPT has newer messages and Eden's copy is untouched).
 */
export function dedupeAction(existing, incoming) {
  if (!existing) return 'new';
  const imp = existing.import;
  if (!imp || imp.source !== SOURCE) return 'unchanged';
  if (Object.keys(existing.nodes || {}).length !== imp.nodes) return 'edited';
  if ((incoming.import.updated || 0) <= (imp.updated || 0)) return 'unchanged';
  return 'update';
}

/** Takes the pieces of an imported conversation into an existing one (same Eden id), in place. */
export function replaceInto(existing, incoming) {
  const keep = { pinned: existing.pinned, personaId: existing.personaId, title: existing.title };
  Object.assign(existing, incoming, keep);
  return existing;
}

/* ---------- memories ---------- */

/** Pasted lines (bullets, numbering, dates) → clean memory lines. */
export function parseMemoryLines(text) {
  const seen = new Set();
  const out = [];
  for (let line of String(text || '').split(/\r?\n/)) {
    line = line.replace(/^\s*(?:[-*•·▪‣]|\d{1,3}[.)])\s+/, '').replace(/^\s*(?:\d{4}-\d\d-\d\d|\d{1,2}\/\d{1,2}\/\d{2,4})\s*[:\-–—]\s*/, '').trim();
    if (line.length < 4 || line.length > 400) continue;
    const k = line.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(line);
  }
  return out.slice(0, 200);
}

/** The model's answer → up to 15 short facts (a JSON array of strings, or lines). */
export function parseSuggestions(answer) {
  const s = String(answer || '');
  let list = null;
  const m = /\[[\s\S]*\]/.exec(s);
  if (m) { try { const v = JSON.parse(m[0]); if (Array.isArray(v)) list = v.filter((x) => typeof x === 'string'); } catch { /* fall through */ } }
  return parseMemoryLines((list || s.split(/\r?\n/)).join('\n')).filter((x) => x.length <= 200).slice(0, 15);
}

/** A sample of recent chats for the memory model: the user's own words only, newest first, under `budget` characters. */
export function sampleForMemories(convs, { chats = 14, budget = 7000 } = {}) {
  const recent = [...convs].filter((c) => !c.temp).sort((a, b) => b.updated - a.updated).slice(0, chats);
  let out = '';
  for (const c of recent) {
    const lines = [];
    let cur = c.root;
    while (cur.children.length) {
      const n = c.nodes[cur.children[Math.min(cur.sel, cur.children.length - 1)]];
      if (!n) break;
      if (n.role === 'user' && n.content) lines.push(`- ${n.content.replace(/\s+/g, ' ').slice(0, 300)}`);
      cur = n;
    }
    const block = `## ${c.title}\n${lines.slice(0, 8).join('\n')}\n\n`;
    if (out.length + block.length > budget) break;
    out += block;
  }
  return out;
}

export const MEMORY_SYSTEM = 'You read samples of a person’s past chats (only what they wrote) and list durable facts worth remembering about them: name, location, work, projects, tools they use, preferences, family or pets they mention, goals. Skip one-off questions, anything sensitive (health, finances, passwords, IDs), and anything you are unsure of. Answer with ONLY a JSON array of up to 12 short strings, each a standalone sentence like "Lives in Lisbon." or "Prefers concise answers.". Answer [] if there is nothing solid.';
