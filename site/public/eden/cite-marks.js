// Sources next to the words they back, like an essay (owner, 2026-11-06). The server says which words each source supports
// (src/chat/stream.ts CiteMark: Gemini's groundingSupports, Claude's cited text blocks); this puts "[n]" right after those
// words in the reply's text, and markdown.js turns each into a superscript that opens the source (app.js citePop).
// No DOM here: src/__tests__/cite-marks.test.ts loads this file as the page serves it.

/** A mark's sources as their numbers in the reply's source list (1-based), in order, each once. */
export function numbersFor(urls, citations) {
  const list = Array.isArray(citations) ? citations : [];
  const out = [];
  for (const u of Array.isArray(urls) ? urls : []) {
    const n = list.findIndex((c) => c && c.url === u) + 1;
    if (n > 0 && n <= 99 && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Whether `at` in `text` sits inside a fenced code block, inline code, or a link's address: no number goes there. */
function unsafe(text, at) {
  const before = text.slice(0, at);
  let fenced = false;
  for (const line of before.split('\n').slice(0, -1)) if (/^[ \t]*(`{3,}|~{3,})/.test(line)) fenced = !fenced;
  if (fenced) return true;
  const line = before.slice(before.lastIndexOf('\n') + 1);
  if ((line.match(/`/g) || []).length % 2 === 1) return true; // inside `inline code`
  if (/\]\([^)]*$/.test(line)) return true; // inside a link's (address)
  return false;
}

/** The whole line that `at` is on. */
function lineAround(text, at) {
  const a = text.lastIndexOf('\n', at - 1) + 1;
  const b = text.indexOf('\n', at);
  return text.slice(a, b < 0 ? text.length : b);
}

/**
 * Puts each mark's numbers right after its words in the reply's text parts (`{ type: 'text', text }`, changed in place).
 * The marks go in order, each searched from where the last one went, then from the start. Left out: a mark whose words
 * aren't there (the text changed), a number already right there, a place inside code or a link's address, the end of a link's
 * words (before "]("), right after a bare web address (it would join the address), and just before "(" (which would turn "[1]("
 * into a link). A table row's number goes inside its last cell. Returns how many marks were placed.
 */
export function placeMarks(parts, marks, citations) {
  const texts = (Array.isArray(parts) ? parts : []).filter((p) => p && p.type === 'text' && typeof p.text === 'string');
  if (!texts.length) return 0;
  let placed = 0;
  let pi = 0;
  let from = 0;
  const find = (after, startPart, startAt) => {
    for (let i = startPart; i < texts.length; i++) {
      const at = texts[i].text.indexOf(after, i === startPart ? startAt : 0);
      if (at >= 0) return { i, end: at + after.length };
    }
    return null;
  };
  for (const m of Array.isArray(marks) ? marks : []) {
    const ns = numbersFor(m && m.urls, citations);
    const after = m && typeof m.after === 'string' ? m.after.replace(/\s+$/, '') : '';
    if (!ns.length || !after.trim()) continue;
    const hit = find(after, pi, from) || find(after, 0, 0);
    if (!hit) continue;
    const part = texts[hit.i];
    let end = hit.end;
    const tail = /^(?:\[\d{1,2}\])+/.exec(part.text.slice(end));
    const have = new Set(tail ? [...tail[0].matchAll(/\[(\d{1,2})\]/g)].map((x) => Number(x[1])) : []);
    if (tail) end += tail[0].length;
    pi = hit.i;
    from = end;
    const add = ns.filter((n) => !have.has(n)).sort((a, b) => a - b); // in order, as an essay lists them
    // a table row's words end with its last "|": the number goes inside the last cell (after "|" it's a cell of its own)
    const rowEnd = /^[ \t]*\|.*\|[ \t]*$/.test(lineAround(part.text, end)) && /\|[ \t]*$/.test(part.text.slice(0, end));
    if (rowEnd) end = part.text.slice(0, end).replace(/[ \t]*\|[ \t]*$/, '').length;
    if (!add.length || part.text[end] === '(' || part.text.startsWith('](', end) || /https?:\/\/\S*$/.test(part.text.slice(0, end)) || unsafe(part.text, end)) continue;
    const ins = add.map((n) => `[${n}]`).join('');
    part.text = part.text.slice(0, end) + ins + part.text.slice(end);
    from = end + ins.length;
    placed++;
  }
  return placed;
}

/** Gemini's sources are Google redirect links; until the server has the real address, its title is the site's name. */
export const isGoogleRedirect = (u) => /^https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//.test(String(u || ''));
