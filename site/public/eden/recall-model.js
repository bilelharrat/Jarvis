// Recall across chats with no browser in it: what the user said in their other chats that bears on
// this message. Words only (no model call, no cost), so every model gets it the same way: a context
// block the server wraps as data. Chat.js asks `recallBlock`; the tests load this file alone.

const STOP = new Set('a an the and or but of to in on at for with from by about as is are was were be been am i me my mine you your we our it its this that these those he she they them his her their do does did have has had not no so if then than too very just also can could would should will what when where who how why please tell give make get want need like know think say said ask asked chat chats earlier before previous last other remember'.split(' '));
const ASKS_BACK = /\b(?:earlier|before|previous(?:ly)?|last (?:time|week|night|chat)|other chats?|another chat|old chats?|past chats?|we (?:talked|discussed|spoke)|i (?:asked|told|said|mentioned)|you (?:said|told|gave|wrote)|remember when|what did (?:i|we))\b/i;

const wordsOf = (t) => {
  const out = new Set();
  for (const w of String(t || '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) || []) {
    const s = w.replace(/'s$/, '').replace(/(?<=..)s$/, '');
    if (s.length > 2 && !STOP.has(s)) out.add(s);
  }
  return out;
};
const text = (n) => (n.role === 'user' ? n.content || '' : (n.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join(''));

/** True when the message points back at earlier conversations ("in the other chats", "what did I ask"). */
export const asksBack = (prompt) => ASKS_BACK.test(String(prompt || ''));

/**
 * The chats worth showing for `prompt`: [{ title, when, snippets: [string] }], best first.
 * `convs` are the saved chats; the current one, temporary ones, private ones and courses are skipped.
 */
export function findRecall(convs, prompt, { currentId = null, max = 4, isPrivate = () => false } = {}) {
  const q = wordsOf(prompt);
  const back = asksBack(prompt);
  const pool = (convs || []).filter((c) => c && c.id !== currentId && !c.temp && !c.course && !isPrivate(c) && c.nodes);
  if (!pool.length || (!q.size && !back)) return [];
  const docs = pool.map((c) => ({ c, msgs: Object.values(c.nodes).filter((n) => n.role === 'user' || n.role === 'assistant').map((n) => ({ n, w: wordsOf(text(n)), t: text(n) })).filter((m) => m.t.trim()) }));
  const df = new Map();
  for (const d of docs) { const seen = new Set(); for (const m of d.msgs) for (const w of m.w) if (!seen.has(w)) { seen.add(w); df.set(w, (df.get(w) || 0) + 1); } }
  const idf = (w) => Math.log(1 + docs.length / (df.get(w) || 1));
  const scored = [];
  for (const d of docs) {
    const title = wordsOf(d.c.title);
    const hits = [];
    let best = 0;
    for (const m of d.msgs) {
      let s = 0;
      for (const w of q) if (m.w.has(w)) s += idf(w);
      if (s > 0) hits.push({ s, m });
      best = Math.max(best, s);
    }
    let total = 0;
    for (const w of q) if (title.has(w)) total += idf(w) * 1.5;
    total += hits.reduce((a, h) => a + h.s, 0) / Math.sqrt(1 + hits.length) + best;
    const minimum = q.size >= 3 ? 2.2 : 1.2;
    if (total >= minimum || (back && total > 0)) {
      hits.sort((a, b) => b.s - a.s);
      scored.push({ total, c: d.c, snippets: hits.slice(0, 3).map((h) => `${h.m.n.role === 'user' ? 'User' : 'Eden'}: ${h.m.t.replace(/\s+/g, ' ').trim().slice(0, 360)}`) });
    }
  }
  scored.sort((a, b) => b.total - a.total);
  let out = scored.slice(0, max);
  if (back && !out.length) { // "what did I ask you about ...": nothing matched, so the newest chats' openings
    out = pool.slice().sort((a, b) => (b.updated || 0) - (a.updated || 0)).slice(0, max).map((c) => {
      const first = Object.values(c.nodes).find((n) => n.role === 'user' && (n.content || '').trim());
      return { total: 0, c, snippets: first ? [`User: ${first.content.replace(/\s+/g, ' ').trim().slice(0, 240)}`] : [] };
    }).filter((x) => x.snippets.length);
  }
  return out.map((x) => ({ title: x.c.title || 'Untitled chat', when: x.c.updated || x.c.created || 0, snippets: x.snippets }));
}

/** The context block for the turn, or null. */
export function recallBlock(convs, prompt, opts = {}) {
  const found = findRecall(convs, prompt, opts);
  if (!found.length) return null;
  const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : 'earlier');
  const body = found.map((f) => `Chat "${f.title}" (${day(f.when)}):\n${f.snippets.join('\n')}`).join('\n\n');
  return { title: 'From your other chats', source: 'recall', text: `Parts of the user's earlier chats in Eden that look relevant. Use them if they help answer; don't mention this block.\n\n${body}` };
}

const cosine = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return x && y ? d / Math.sqrt(x * y) : 0; };

/** The text of a chat that gets embedded: its title and what the user opened with. */
export function chatDigest(c) {
  const users = Object.values(c.nodes || {}).filter((n) => n.role === 'user' && (n.content || '').trim()).sort((a, b) => (a.created || 0) - (b.created || 0)).slice(0, 3);
  return `${c.title || ''}\n${users.map((n) => n.content.replace(/\s+/g, ' ').trim().slice(0, 300)).join('\n')}`.trim().slice(0, 1200);
}

/**
 * The tool's search: words in any message plus meaning (when `vecs` {id: vector} and `qvec` are given),
 * optionally only chats updated between `from` and `to` (ms). → [{ id, title, when, snippets }], best first.
 */
export function searchChats(convs, query, { from = 0, to = Infinity, limit = 5, currentId = null, vecs = null, qvec = null, isPrivate = () => false } = {}) {
  const q = wordsOf(query);
  const pool = (convs || []).filter((c) => c && c.id !== currentId && !c.temp && !c.course && !isPrivate(c) && c.nodes && (c.updated || c.created || 0) >= from && (c.updated || c.created || 0) <= to);
  const byWords = new Map(findRecall(pool, query, { max: 40 }).map((f, i) => [f.title + f.when, { f, rank: 40 - i }]));
  const out = [];
  for (const c of pool) {
    const w = byWords.get((c.title || 'Untitled chat') + (c.updated || c.created || 0));
    const sim = vecs && qvec && vecs[c.id] ? cosine(qvec, vecs[c.id]) : 0;
    const score = (w ? w.rank / 4 : 0) + Math.max(0, sim - 0.45) * 12;
    if (score <= 0.4 && !(w || sim > 0.55)) continue;
    let snippets = w ? w.f.snippets : [];
    if (!snippets.length) {
      const first = Object.values(c.nodes).find((n) => n.role === 'user' && (n.content || '').trim());
      snippets = first ? [`User: ${first.content.replace(/\s+/g, ' ').trim().slice(0, 300)}`] : [];
    }
    out.push({ score, id: c.id, title: c.title || 'Untitled chat', when: c.updated || c.created || 0, snippets });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(8, limit))).map(({ score, ...r }) => r); // eslint-disable-line no-unused-vars
}
