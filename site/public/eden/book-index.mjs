// SOTA Hierarchical Textbook & Massive Document Engine (Ask Eden & Eden Edu).
// Pure ESM module (no DOM), shared across the browser composer, the Mac server (src/chat/turn.ts),
// and askeden.com's Worker (site/src/edu/course.js & site/src/eden/chat.js).
//
// Architecture (bypasses context window limits completely):
//   L0: Book Map (~1,200 tokens max) — Title, Chapter hierarchy, page/section spans, key themes.
//   L1: Chapter / Section Cards — Summary of each chapter/section with defined terms and formulas.
//   L2: Contextual Chunks — Atomic passages (~1,800 chars) prefixed with structural breadcrumbs:
//       [Book: Title | Ch: Chapter | Loc: page 42 | Defines: term1, term2]
//   L3: O(1) Pre-Extracted Lookup Banks —
//       - Formula / Equation / Theorem Bank
//       - Glossary / Definitions Index
//       - Cross-Reference Graph ("Fig. 4.2", "Table 3.1", "Eq. 2.4" auto-expanded into neighbour chunks)
//
// When a massive document or textbook (> 24,000 chars) is attached or queried across turns:
//   - Full raw text NEVER floods the prompt or repeats in conversation history.
//   - Each turn receives: L0 Book Map + O(1) matched Definitions/Formulas + Top-K Hybrid BM25/Contextual
//     passages + Cross-Referenced Figure/Table chunks (~4k–7k tokens total, 98%+ token savings).
//   - Earlier turns' huge attachments are compacted to citation stubs so multi-turn chats never overflow.

export const HUGE_DOC_CHARS = 24_000; // above ~6k tokens, switch from raw inline dump to hierarchical Book Index
export const CHUNK_TARGET_CHARS = 1_800;
export const MAX_ACTIVE_PASSAGES = 8;
export const MAX_BOOK_CONTEXT_CHARS = 22_000; // ~5.5k tokens max injected per turn for a book

const STOP = new Set(
  'a an and are as at be but by can do does for from has have how i if in into is it its of on or so that the their then there these this to was what when where which who why will with you your about explain describe summarize'.split(' '),
);

export function tokenizeWords(text) {
  return (String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 1 && !STOP.has(w));
}

const HEADING_RE = /^(?:(?:chapter|ch\.?|part|unit|module|lecture|section|sec\.?|§)\s*\d+[:.\s-]*[^\n]{0,90}|#{1,3}\s+[^\n]{1,90}|\d+(?:\.\d+){0,2}\s+[A-Z][^\n]{2,80}|[A-Z][A-Z0-9\s,&:-]{4,70})$/im;
const FORMULA_RE = /(?:\\[a-zA-Z]+|\b(?:theorem|lemma|corollary|proposition|equation|eq\.?|formula|law|identity)\s*\d*[:.)]|\b[A-Za-z_][A-Za-z0-9_]*\s*=\s*[^=\n]{3,60})/i;
const DEF_RE = /(?:^|\n)\s*(?:\*\*([^*:\n]{2,50})\*\*|([A-Z][A-Za-z0-9\s-]{2,40}))\s*(?:—|–|:|\bis defined as\b|\brefers to\b)\s*([^\n]{15,220})/g;
const XREF_RE = /\b(?:fig(?:ure)?\.?|table|eq(?:uation)?\.?|ch(?:apter)?\.?|sec(?:tion)?\.?|§)\s*(\d+(?:\.\d+)?[a-z]?)\b/gi;

/**
 * Parse raw text (or `[page N]\n...` extracted parts) into raw page/section parts if not already split.
 */
export function splitIntoParts(rawText, defaultName = 'Document') {
  const s = String(rawText || '');
  const locRegex = /^\[([^\][\n]{1,60})\]\n/gm;
  const matches = [...s.matchAll(locRegex)];
  if (matches.length >= 2) {
    const parts = [];
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].index + matches[i][0].length;
      const end = i + 1 < matches.length ? matches[i + 1].index : s.length;
      const body = s.slice(start, end).trim();
      if (body) parts.push({ loc: matches[i][1].trim(), text: body });
    }
    if (parts.length) return parts;
  }
  const paras = s.split(/\n\s*\n/);
  const parts = [];
  let cur = '';
  let n = 0;
  const flush = () => {
    if (cur.trim()) {
      n++;
      parts.push({ loc: `section ${n}`, text: cur.trim() });
    }
    cur = '';
  };
  for (const p of paras) {
    if (cur && cur.length + p.length > CHUNK_TARGET_CHARS) flush();
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  flush();
  return parts.length ? parts : [{ loc: 'section 1', text: s.slice(0, CHUNK_TARGET_CHARS) }];
}

/**
 * Build a SOTA Hierarchical Book Index from `{ name, parts: [{ loc, text }] }` or raw text.
 */
export function buildBookIndex(input, { name = 'Textbook' } = {}) {
  const rawParts = Array.isArray(input) ? input : splitIntoParts(input, name);
  const title = String(name || 'Textbook').replace(/\.[^.]+$/, '');
  const chapters = [];
  const chunks = [];
  const glossary = [];
  const formulas = [];
  const xrefMap = new Map(); // "fig:4.2" or "4.2" -> chunk index

  let currentChapter = 'Introduction';
  let currentChapterStart = rawParts[0]?.loc || 'part 1';
  let chapterTerms = new Set();
  let chapterPreview = '';

  const flushChapter = (endLoc) => {
    if (!chapterPreview && !chapterTerms.size) return;
    chapters.push({
      title: currentChapter,
      from: currentChapterStart,
      to: endLoc || currentChapterStart,
      terms: [...chapterTerms].slice(0, 8),
      summary: chapterPreview.slice(0, 220).replace(/\s+/g, ' ').trim(),
    });
    chapterTerms = new Set();
    chapterPreview = '';
  };

  rawParts.forEach((p, idx) => {
    const loc = String(p.loc || `part ${idx + 1}`);
    const body = String(p.text || '').trim();
    if (!body) return;

    // Detect chapter / major heading transitions
    const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
    const firstLine = lines[0] || '';
    if (
      (/^ch\.\s*\d+/i.test(loc) && !loc.includes('(')) ||
      (firstLine.length <= 85 && HEADING_RE.test(firstLine) && idx > 0)
    ) {
      flushChapter(rawParts[idx - 1]?.loc || loc);
      currentChapter = (/^ch\./i.test(loc) ? loc : firstLine.replace(/^#+\s*/, '')).slice(0, 80);
      currentChapterStart = loc;
    }

    if (!chapterPreview && body.length > 30) {
      chapterPreview = lines.slice(0, 3).join(' ');
    }

    // Extract defined terms (L3 Glossary Bank)
    const localTerms = [];
    DEF_RE.lastIndex = 0;
    let dm;
    while ((dm = DEF_RE.exec(body)) && glossary.length < 250) {
      const term = (dm[1] || dm[2] || '').trim();
      const def = (dm[3] || '').trim();
      if (term && term.length >= 2 && term.length <= 45 && def.length >= 15) {
        localTerms.push(term);
        chapterTerms.add(term);
        if (!glossary.some((g) => g.term.toLowerCase() === term.toLowerCase())) {
          glossary.push({ term, def: def.slice(0, 180), loc, chapter: currentChapter });
        }
      }
    }

    // Extract formulas / theorems (L3 Formula Bank)
    if (FORMULA_RE.test(body) && formulas.length < 150) {
      for (const line of lines) {
        if (FORMULA_RE.test(line) && line.length >= 6 && line.length <= 220) {
          formulas.push({ text: line, loc, chapter: currentChapter });
          if (formulas.length >= 150) break;
        }
      }
    }

    // Split oversized pages into ~1,800-char contextual chunks
    const subChunks = [];
    if (body.length <= CHUNK_TARGET_CHARS * 1.25) {
      subChunks.push(body);
    } else {
      let cur = '';
      for (const para of body.split(/\n\s*\n/)) {
        if (cur && cur.length + para.length > CHUNK_TARGET_CHARS) {
          subChunks.push(cur);
          cur = '';
        }
        cur = cur ? `${cur}\n\n${para}` : para;
      }
      if (cur) subChunks.push(cur);
    }

    subChunks.forEach((subText, subIdx) => {
      const chunkLoc = subChunks.length > 1 ? `${loc} (${subIdx + 1})` : loc;
      // Contextual Breadcrumb Header (Anthropic Contextual Retrieval style)
      const header = `[Book: ${title} | ${currentChapter} | ${chunkLoc}${localTerms.length ? ` | Defines: ${localTerms.slice(0, 4).join(', ')}` : ''}]`;
      const fullText = `${header}\n${subText}`;
      const tf = new Map();
      for (const w of tokenizeWords(fullText)) tf.set(w, (tf.get(w) || 0) + 1);
      // Boost chapter/heading/defined-term words
      for (const w of tokenizeWords(`${currentChapter} ${chunkLoc} ${localTerms.join(' ')}`)) {
        tf.set(w, (tf.get(w) || 0) + 3);
      }
      const chunkIndex = chunks.length;
      chunks.push({
        i: chunkIndex,
        loc: chunkLoc,
        chapter: currentChapter,
        header,
        text: subText,
        contextualText: fullText,
        tf,
        len: [...tf.values()].reduce((a, b) => a + b, 0),
        e: p.e || null,
      });

      // Index cross-references ("Fig 4.2", "Table 1.1", "Eq 3.4")
      XREF_RE.lastIndex = 0;
      let xm;
      while ((xm = XREF_RE.exec(subText))) {
        const refNum = xm[1].toLowerCase();
        if (!xrefMap.has(refNum)) xrefMap.set(refNum, chunkIndex);
      }
    });
  });

  flushChapter(rawParts.at(-1)?.loc || 'end');

  // Compute BM25 document frequencies
  const df = new Map();
  for (const c of chunks) {
    for (const w of c.tf.keys()) df.set(w, (df.get(w) || 0) + 1);
  }
  const avgLen = chunks.reduce((a, c) => a + c.len, 0) / (chunks.length || 1);
  const totalChars = rawParts.reduce((n, p) => n + String(p.text || '').length, 0);

  return {
    title,
    totalParts: rawParts.length,
    totalChunks: chunks.length,
    totalChars,
    chapters: chapters.slice(0, 60),
    glossary,
    formulas,
    chunks,
    df,
    avgLen,
    xrefMap,
  };
}

/**
 * Render the compact L0 Book Map (~800–1,400 tokens) so the model always sees the whole book's structure.
 */
export function formatBookMap(book) {
  const lines = [
    `# Book Map: ${book.title} (${book.totalParts.toLocaleString('en-US')} sections/pages · ~${Math.round(book.totalChars / 4).toLocaleString('en-US')} tokens total)`,
  ];
  if (book.chapters.length) {
    lines.push('## Table of Contents & Chapter Summaries');
    for (const ch of book.chapters.slice(0, 35)) {
      const span = ch.from === ch.to ? ch.from : `${ch.from}–${ch.to}`;
      const terms = ch.terms.length ? ` [Key terms: ${ch.terms.join(', ')}]` : '';
      lines.push(`- **${ch.title}** (${span}): ${ch.summary}${terms}`);
    }
  }
  return lines.join('\n');
}

/**
 * Retrieve the most relevant passages, O(1) definitions/formulas, and cross-referenced neighbour chunks for a query.
 */
export function queryBookIndex(book, query, { k = MAX_ACTIVE_PASSAGES, maxChars = MAX_BOOK_CONTEXT_CHARS } = {}) {
  const qStr = String(query || '').trim();
  const qWords = [...new Set(tokenizeWords(qStr))];
  const N = book.chunks.length;
  if (!N) return { block: '', passages: [] };

  // 1. Check explicit location/chapter requests ("chapter 4", "page 55", "section 12")
  const locMatch = /\b(?:page|p\.|slide|section|sec\.|chapter|ch\.)\s*(\d+)\b/i.exec(qStr);
  const wantedNum = locMatch ? locMatch[1] : null;

  // 2. Score all chunks via BM25 + structural heading boost + location match
  const scored = [];
  for (const c of book.chunks) {
    let score = 0;
    for (const w of qWords) {
      const f = c.tf.get(w);
      if (!f) continue;
      const n = book.df.get(w) || 1;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (c.len / (book.avgLen || 1)))));
    }
    if (wantedNum && new RegExp(`\\b${wantedNum}\\b`).test(`${c.loc} ${c.chapter}`)) {
      score += 12;
    }
    if (score > 0) scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score);

  // Pick top-K chunks + expand cross-references ("see Fig 4.2")
  const chosenIdx = new Set();
  const passages = [];
  for (const { c } of scored) {
    if (chosenIdx.size >= k) break;
    chosenIdx.add(c.i);
    passages.push(c);
    // Cross-reference expansion
    XREF_RE.lastIndex = 0;
    let xm;
    while ((xm = XREF_RE.exec(c.text)) && chosenIdx.size < k + 2) {
      const targetIdx = book.xrefMap.get(xm[1].toLowerCase());
      if (targetIdx !== undefined && !chosenIdx.has(targetIdx) && book.chunks[targetIdx]) {
        chosenIdx.add(targetIdx);
        passages.push(book.chunks[targetIdx]);
      }
    }
  }

  // Fallback if query has no matching keywords (e.g. "summarize this book" or "what is this about?"):
  // sample evenly across the book (start, quartiles, end) so the whole textbook is represented!
  if (!passages.length) {
    const step = Math.max(1, Math.floor(N / Math.min(k, N)));
    for (let i = 0; i < N && passages.length < k; i += step) {
      passages.push(book.chunks[i]);
    }
  }

  // 3. Match O(1) Glossary & Formula Banks for query terms
  const matchedDefs = book.glossary
    .filter((g) => qWords.some((w) => g.term.toLowerCase().includes(w) || g.def.toLowerCase().includes(w)))
    .slice(0, 6);
  const matchedFormulas = book.formulas
    .filter((f) => qWords.some((w) => f.text.toLowerCase().includes(w) || f.chapter.toLowerCase().includes(w)))
    .slice(0, 6);

  // 4. Assemble token-efficient context block within `maxChars`
  const mapText = formatBookMap(book);
  const sections = [mapText];
  let usedChars = mapText.length;

  if (matchedDefs.length) {
    const defBlock = `## Relevant Definitions from ${book.title}\n` + matchedDefs.map((d) => `- **${d.term}** (${d.loc}): ${d.def}`).join('\n');
    if (usedChars + defBlock.length < maxChars) {
      sections.push(defBlock);
      usedChars += defBlock.length;
    }
  }
  if (matchedFormulas.length) {
    const formBlock = `## Relevant Equations & Theorems from ${book.title}\n` + matchedFormulas.map((f) => `- [${f.loc}] \`${f.text}\``).join('\n');
    if (usedChars + formBlock.length < maxChars) {
      sections.push(formBlock);
      usedChars += formBlock.length;
    }
  }

  const passageLines = [`## Retrieved Passages from ${book.title} (cite as [S1], [S2]…)`];
  const citedPassages = [];
  passages.forEach((p, idx) => {
    const tag = `S${idx + 1}`;
    const entry = `[${tag}] ${p.header}\n${p.text}`;
    if (usedChars + entry.length > maxChars && citedPassages.length >= 2) return;
    usedChars += entry.length;
    passageLines.push(entry);
    citedPassages.push({ doc: book.title, name: book.title, loc: p.loc, text: p.text });
  });
  sections.push(passageLines.join('\n\n'));

  return {
    block: sections.join('\n\n'),
    passages: citedPassages,
  };
}
