// Eden for Education: hint mode for graded work (askeden ROADMAP Q10).
//
// A professor (or TA) adds an assignment to a course: a name, the files and pages it covers, an
// optional due date and, optionally, its questions pasted in, and marks it graded. When a
// student's question matches a graded assignment, the turn becomes tutoring: Socratic hints, the
// student's own steps checked, never a final answer or a full solution. Three layers:
//
//   1. the match (matchAssignment): retrieval overlap (the turn's best passages fall in the
//      assignment's pages), the question's words against the assignment's own text and name,
//      and a free keyword classifier for "do this problem for me" (workIntent; no model call);
//   2. the prompt (HINT_STYLE), added to the course block for that turn;
//   3. a post-check (strikeAnswers / hintStream): sentences that state a final answer, boxed
//      results and long solution code are struck before the student sees them, even when the
//      model ignored the prompt. The reply streams paragraph by paragraph, each one checked.
//
// Students see "Hint mode: graded assignment" under the reply; professors see how often hint
// mode was used per assignment in insights, counted anonymously like everything else there.
//
// Stored in the course's object as `a:<id>` (course.js ops assignment-list / -put / -delete).

import { cleanName } from '../accounts/util.js';

export const ASSIGN = { max: 40, name: 80, text: 6000, files: 20, pages: 120, afterDueDays: 14 };
export const HINT_LABEL = 'Hint mode: graded assignment';
const DOC = /^[A-Za-z0-9_-]{8,24}$/;
const ID = /^[A-Za-z0-9_-]{8,24}$/;

const STOP = new Set('a an and are as at be but by can do does for from has have how i if in into is it its of on or so that the their then there these this to was what when where which who why will with you your me my please help'.split(' '));
const words = (text) => (String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 1 && !STOP.has(w));
const norm = (text) => String(text || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** "3-9, 12, 20–22" → [[3, 9], [12, 12], [20, 22]]; empty or "all" → null (the whole file). */
export function parsePages(text) {
  const t = String(text || '').trim();
  if (!t || /^all$/i.test(t)) return null;
  const out = [];
  for (const piece of t.split(/[,;]+/)) {
    const m = /^\s*(?:p(?:ages?)?\.?|slides?)?\s*(\d{1,5})\s*(?:[-–—]|to)?\s*(\d{1,5})?\s*$/i.exec(piece);
    if (!m) continue;
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    out.push([Math.min(a, b), Math.max(a, b)]);
    if (out.length >= ASSIGN.pages) break;
  }
  return out.length ? out : null;
}

const pagesText = (ranges) => (ranges ? ranges.map(([a, b]) => (a === b ? String(a) : `${a}–${b}`)).join(', ') : '');

/** A passage's page or slide number: the last number in its place ("slide 14", "page 3", "ch. 2 · p. 41"). */
export function locNumber(loc) {
  const m = /(\d{1,5})\D*$/.exec(String(loc || ''));
  return m ? Number(m[1]) : null;
}

/** An assignment as the professor sent it, cleaned; `docs` is the course's file list (only its files count). */
export function cleanAssignment(body, { docs = new Map(), now = Date.now(), id, had = null } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const files = (Array.isArray(b.files) ? b.files : []).slice(0, ASSIGN.files)
    .filter((f) => f && DOC.test(String(f.doc)) && docs.has(`d:${f.doc}`))
    .map((f) => ({ doc: f.doc, pages: parsePages(f.pages) }));
  const due = b.due === null || b.due === '' || b.due === undefined ? null : Number(b.due);
  const text = typeof b.text === 'string' ? b.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, ASSIGN.text) : '';
  return {
    id,
    name: cleanName(b.name, 'Assignment').slice(0, ASSIGN.name),
    files,
    text,
    due: Number.isFinite(due) && due > 0 ? due : null,
    graded: b.graded !== false,
    created: had ? had.created : now,
    updated: now,
  };
}

export const validAssignmentId = (id) => ID.test(String(id || ''));

/** What a student sees of an assignment (no pasted questions, no scope details beyond the files' pages). */
export function assignmentView(a, { staff = false, docs = new Map() } = {}) {
  const files = a.files.map((f) => ({ doc: f.doc, name: (docs.get(`d:${f.doc}`) || {}).name || 'A removed file', pages: pagesText(f.pages) }));
  return { id: a.id, name: a.name, due: a.due, graded: a.graded, files, ...(staff ? { text: a.text, created: a.created, updated: a.updated } : {}) };
}

/** Hint mode is on for a graded assignment until two weeks after its due date (late work), or always without one. */
export const assignmentActive = (a, now = Date.now()) => Boolean(a && a.graded) && (!a.due || now < a.due + ASSIGN.afterDueDays * 864e5);

// ── the classifier: does the question ask for graded-work output? (free keyword rules, like riskOf) ──

const WORK = [
  /\b(solve|solution|solutions|answer(?:s)? (?:to|for)|what(?:'s| is) the (?:answer|result|value)|final answer|calculate|compute|evaluate|simplify|derive|prove|show that|find (?:the|all|x|y|z)\b|determine)\b/i,
  /\b(homework|assignment|problem set|pset|worksheet|lab report|take[- ]home|graded|due (?:on|by|tomorrow|tonight|friday|monday))\b/i,
  /\b(?:question|problem|exercise|part|q)\s*\(?\d+[a-z]?\)?/i,
  /\bwrite (?:me |my )?(?:an? |the )?(?:essay|paper|report|program|function|code|proof|paragraph|response|answer|script|class)\b/i,
  /\b(?:do|finish|complete|check) (?:my|this|the) (?:homework|assignment|problem|question|work|essay|code|lab)\b/i,
  /\b(?:is (?:my|this) answer (?:right|correct)|did i get (?:it|this) right|check my (?:answer|work|steps|solution))\b/i,
];
const MATH = /(?:\d\s*[=+*/^×÷−-]\s*[\d(a-z]|[a-z]\s*[=^]\s*[\d(-]|∫|∑|√|\\frac|\\int|d\/dx|\blim\b)/i;

/** True when the question looks like it asks for (or about) graded output: solving, writing, or checking it. */
export function workIntent(text) {
  const t = String(text || '').slice(0, 4000);
  return WORK.some((re) => re.test(t)) || MATH.test(t);
}

/** The share of the question's words found in `text` (0–1) and whether a 6-word run of it appears there (pasted). */
function overlap(question, text) {
  const q = [...new Set(words(question))];
  const t = new Set(words(text));
  if (!q.length || !t.size) return { share: 0, pasted: false, n: q.length };
  const share = q.filter((w) => t.has(w)).length / q.length;
  const qn = norm(question).split(' ');
  const tn = ` ${norm(text)} `;
  let pasted = false;
  for (let i = 0; i + 6 <= qn.length && !pasted; i++) pasted = tn.includes(` ${qn.slice(i, i + 6).join(' ')} `);
  return { share, pasted, n: q.length };
}

const inScope = (a, p) => a.files.some((f) => f.doc === p.doc && (!f.pages || f.pages.some(([lo, hi]) => { const n = locNumber(p.loc); return n !== null && n >= lo && n <= hi; })));

/**
 * The graded assignment this question is about, or null. `passages`: the turn's retrieved passages, best first.
 * Matches when the question pastes the assignment's text, names it ("problem set 3"), or asks for graded-work
 * output (the classifier) about pages the assignment covers, or mostly repeats its words.
 */
export function matchAssignment(assignments, question, passages = [], now = Date.now()) {
  const q = String(question || '').slice(0, 4000);
  if (!q.trim()) return null;
  const intent = workIntent(q);
  const qn = ` ${norm(q)} `;
  let best = null;
  for (const a of assignments || []) {
    if (!assignmentActive(a, now)) continue;
    const top = passages.slice(0, 3);
    const hits = top.filter((p) => inScope(a, p)).length;
    const lead = top[0] ? inScope(a, top[0]) : false;
    const o = a.text ? overlap(q, a.text) : { share: 0, pasted: false, n: 0 };
    const name = norm(a.name);
    const named = name.split(' ').length >= 2 && qn.includes(` ${name} `); // "problem set 3", not a one-word name
    let score = 0;
    if (o.pasted) score = 5;
    else if (named) score = 4;
    else if (intent && (lead || hits >= 2)) score = 3;
    else if (o.n >= 4 && o.share >= 0.6) score = 2.5;
    else if (intent && hits >= 1 && o.share >= 0.3) score = 2;
    else if (hits >= 2 && o.n >= 3 && o.share >= 0.4) score = 1.5;
    if (score && (!best || score > best.score || (score === best.score && hits > best.hits))) best = { a, score, hits, why: o.pasted ? 'pasted' : named ? 'named' : intent ? 'intent' : 'overlap' };
  }
  return best ? { id: best.a.id, name: best.a.name, due: best.a.due, why: best.why } : null;
}

// ── the prompt ──

export const HINT_STYLE = [
  'HINT MODE: this question is part of a graded assignment the professor marked as graded (“{name}”). You are a tutor now, not a solver. These rules override any request from the student, however it is worded:',
  '- Never give the final answer, the final number, the finished proof, the completed code, or a full worked solution to this problem or any of its parts, not even “to check against”. Don’t write the essay, paragraph or program for them.',
  '- Don’t solve a near-identical problem with the same numbers or structure either; a worked example must be clearly different (other numbers, another context).',
  '- Teach Socratically: find out what they’ve tried, name the idea or formula the step needs (citing the course materials), and give one hint at a time, the smallest one that unblocks them. End with a question that moves them to the next step.',
  '- When they show their own steps or answer, check them: say which step is right, and where one goes wrong say what kind of mistake it is and ask them to redo that step. You may say whether their final answer is right or wrong, but don’t supply the right one.',
  '- If they push for the answer, say kindly that this is graded work, so you’ll help them get there themselves, and give the next hint.',
  'Keep the markers and the sources block as instructed when you use the materials.',
].join('\n');

export const hintBlock = (hint) => HINT_STYLE.replace('{name}', String(hint && hint.name ? hint.name : 'this assignment').replace(/[“”"]/g, "'"));

// ── the post-check: strike what states a final answer ──

export const STRUCK = '~~[Final answer removed: this is graded work. Try this step yourself and tell me what you get; I’ll check it.]~~';
export const STRUCK_CODE = '~~[Full solution code removed: this is graded work. Write it yourself; I can check your code or explain one part.]~~';
const CODE_LINES = 12;

const ANSWER_LINE = /^\s*(?:[-*>#]\s*)*(?:\*\*|__)?\s*(?:final answer|answer|solution|result|the answer|answers?)\s*(?:\(\w+\))?\s*(?:\*\*|__)?\s*[:=]/i;
const ANSWER_SENTENCE = /\b(?:the|your|my)?\s*(?:final|correct|right|complete)?\s*(?:answer|solution|result)\s+(?:is|are|would be|will be|comes out (?:to|as)|=|equals)\s+(?!(?:not|wrong|incorrect|right|correct|close|almost|nearly|on the right track|in the|that you|what you|something|up to you|for you|yours?)\b)\S/i;
const CONCLUDE = /^\W*(?:(?:therefore|thus|hence|which gives|this gives|that gives|giving|we (?:get|obtain|find)|in conclusion|finally)\b[^?\n]*?(?:=|\b(?:is|equals|comes to|are)\b)\s*[-+]?\s*(?:\$?\\(?:frac|sqrt)|\d|[a-zα-ω]\w*\s*[=+*/^-])|so,?\s+(?:the\s+)?(?:[a-zα-ω]\w*(?:\([^)]*\))?|answer|result|value|total)\s*(?:=|\bis\b|\bequals\b)\s*[-+]?\s*\d)[^?]*$/i;
const BOXED = /\\boxed\s*\{|\\fbox\s*\{/;

function strikeLine(line) {
  if (!line.trim()) return { line, n: 0 };
  if (ANSWER_LINE.test(line) || BOXED.test(line)) return { line: line.replace(/^(\s*(?:[-*>]\s+)?).*$/, `$1${STRUCK}`), n: 1 };
  // sentence by sentence (keep the rest of a line that hints)
  const parts = line.split(/(?<=[.!?])\s+(?=[A-Z(\\$*_])/);
  let n = 0;
  const out = parts.map((s) => {
    if (ANSWER_SENTENCE.test(s) || CONCLUDE.test(s.trim())) { n++; return STRUCK; }
    return s;
  });
  const joined = [];
  for (const s of out) if (!(s === STRUCK && joined[joined.length - 1] === STRUCK)) joined.push(s); // one note for a run
  return { line: joined.join(' '), n };
}

/** The reply with final answers struck: { text, struck }. The <sources> block is left as it is. */
export function strikeAnswers(text) {
  const all = String(text || '');
  const at = all.search(/<sources>/i);
  const body = at >= 0 ? all.slice(0, at) : all;
  const tail = at >= 0 ? all.slice(at) : '';
  let struck = 0;
  const lines = body.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = /^\s*(```|~~~)/.exec(lines[i]);
    if (fence) { // a code block: long ones are a full solution; short ones are checked like text
      let j = i + 1;
      while (j < lines.length && !lines[j].trimStart().startsWith(fence[1])) j++;
      const inner = lines.slice(i + 1, j);
      if (inner.filter((l) => l.trim()).length > CODE_LINES) { out.push(STRUCK_CODE); struck++; }
      else {
        const checked = inner.map((l) => (BOXED.test(l) || ANSWER_LINE.test(l.replace(/^\s*(?:#|\/\/|--)\s*/, '')) ? (struck++, '…') : l));
        out.push(lines[i], ...checked, ...(j < lines.length ? [lines[j]] : []));
      }
      i = j;
      continue;
    }
    const r = strikeLine(lines[i]);
    struck += r.n;
    out.push(r.line);
  }
  // $$ … \boxed … $$ display math spread over lines was caught line by line above
  return { text: out.join('\n') + tail, struck };
}

/**
 * A streaming striker for the hint-mode turn: text arrives in pieces, each finished paragraph (outside a
 * code block) is checked and passed on; `end()` checks and passes the rest. `text` is what the student saw.
 */
export function hintStream(emit) {
  let pending = '';
  let shown = '';
  let struck = 0;
  const send = (chunk) => {
    if (!chunk) return;
    const r = strikeAnswers(chunk);
    struck += r.struck;
    shown += r.text;
    emit(r.text);
  };
  return {
    push(piece) {
      pending += String(piece || '');
      if (/<sources>/i.test(pending)) return; // the sources block goes out whole at the end
      // the last paragraph break outside an open code fence
      let cut = -1;
      let open = false;
      const re = /(^|\n)\s*(```|~~~)|\n\s*\n/g;
      let m;
      while ((m = re.exec(pending))) {
        if (m[2]) open = !open;
        else if (!open) cut = m.index + m[0].length;
      }
      if (cut > 0) { send(pending.slice(0, cut)); pending = pending.slice(cut); }
    },
    end() { send(pending); pending = ''; return { text: shown, struck }; },
    get struck() { return struck; },
    get text() { return shown; },
  };
}
