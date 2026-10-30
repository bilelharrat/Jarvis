// Formatting through Eden's rewrites (compose.js). Eden sees and writes a draft as light
// Markdown, which has no colours or sizes, so they were lost on every rewrite. Now the draft goes
// to the model with each styled run (a colour, a size, a font, underline…) between numbered
// markers, ⟦1⟧red words⟦/1⟧, the model is asked to keep each pair around the same words (or the
// words that replace them), and the answer is parsed back here: the page puts each run's own
// element (its colour, its size) around what comes back between its markers. Pure functions: the
// page builds the DOM from the tree (compose.js), and tests run them without one.

/** A marker as it appears in the text: ⟦3⟧ opens run 3, ⟦/3⟧ closes it. */
export const open = (n) => `⟦${n}⟧`;
export const close = (n) => `⟦/${n}⟧`;
const ANY = /⟦\/?\d{1,3}⟧/g;
/** Every marker taken out (a subject line, plain text, text with no styles to put back). */
export const stripMarks = (s) => String(s).replace(ANY, '');

/** What the model is told when the draft has styled runs (added to its instruction). */
export const MARKS_NOTE = 'Some words in my draft are between markers like ⟦1⟧…⟦/1⟧: they carry my formatting (a colour, a size, a font). Keep every pair of markers around the same words, or around the words that replace them, in the same order; drop a pair only if its words are cut; never add, renumber or mention markers.';

// Eden's light Markdown (as the page renders it), plus an opening marker.
const INLINE = /\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\s][^*\n]*)\*|(?<![\w])_([^_\n]+)_(?![\w])|\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)|⟦(\d{1,3})⟧/g;

/**
 * One line of the model's text as a tree: strings, and { b }, { i }, { a: href }, { mark: n },
 * each with `kids`. Whichever starts first wins, so bold around a coloured word and a colour
 * around bold words both nest. An opening marker without its close runs to the end of the text;
 * a close without its opening, or a run `known(n)` doesn't know, is dropped (its words stay).
 */
export function parseInline(text, known = () => true) {
  const out = [];
  const plain = (s) => { const t = stripMarks(s); if (t) out.push(t); };
  const re = new RegExp(INLINE.source, 'g');
  let i = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > i) plain(text.slice(i, m.index));
    if (m[7] !== undefined) {
      const n = Number(m[7]);
      const end = text.indexOf(close(n), re.lastIndex);
      const inner = text.slice(re.lastIndex, end < 0 ? text.length : end);
      re.lastIndex = end < 0 ? text.length : end + close(n).length;
      const kids = parseInline(inner, known);
      if (known(n)) out.push({ mark: n, kids });
      else out.push(...kids);
    } else if (m[1] || m[2]) out.push({ b: true, kids: parseInline(m[1] || m[2], known) });
    else if (m[3] || m[4]) out.push({ i: true, kids: parseInline(m[3] || m[4], known) });
    else out.push({ a: m[6], kids: parseInline(m[5], known) });
    i = re.lastIndex;
  }
  if (i < text.length) plain(text.slice(i));
  return out;
}

/**
 * Runs that go on past a line's end (a coloured paragraph, a size across a line break) are
 * closed at the end of the line and opened again at the start of the next, so each line parses
 * on its own. Lines in, lines out.
 */
export function carryMarks(lines) {
  let carried = [];
  return lines.map((line) => {
    const text = carried.map(open).join('') + line;
    const stack = [];
    for (const m of text.matchAll(/⟦(\/?)(\d{1,3})⟧/g)) {
      const n = Number(m[2]);
      if (!m[1]) stack.push(n);
      else { const at = stack.lastIndexOf(n); if (at >= 0) stack.splice(at); }
    }
    carried = stack;
    return text + [...stack].reverse().map(close).join('');
  });
}

/** A line's markers in front of a list bullet ("⟦1⟧- item") moved after it, so the bullet still reads as one. */
export function leadingMarks(line) {
  const m = /^((?:⟦\/?\d{1,3}⟧)*)(\s*(?:[-*•]|\d{1,3}[.)])\s+)([\s\S]*)$/.exec(line);
  return m && m[1] ? m[2] + m[1] + m[3] : line;
}
